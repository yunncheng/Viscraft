// Viscraft retime runtime.
//
// Deterministic FFmpeg-backed retiming of a selected source interval onto an
// exact output timeline duration. This is a *hard* retime: the same picture
// frame is repeated or dropped (no optical-flow interpolation), and a source
// audio track is stretched with pitch preserved.
//
// Conventions (shared with media.ts / time.ts):
//  - Frame intervals are half-open [inFrame, outFrame); a Length-N interval has
//    frames inFrame .. outFrame-1.
//  - Output frame k samples source frame inFrame + floor(k * N / D), so the
//    mapping is stable, monotonic and never reads outside the selected take.
//    When D > N frames are duplicated; when D < N frames are dropped. The only
//    repetition at the tail is the last selected frame (bounded tpad clone),
//    which is still inside the take.
//  - Audio is trimmed on the output sample grid, retimed with chained atempo
//    (every factor inside [0.5, 2]) and padded/trimmed to the exact target span.
//  - A source without an audio stream yields an honest picture-only output; no
//    silent audio track is fabricated.

import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';

import { OutputSchema, type Fps, type MediaInfo, type OutputSettings } from '../../core/schema.js';
import { muxVideo } from './mux.js';
import { probeMedia } from './probe.js';
import { runCommand } from '../../shared/process.js';
import { framesToSamples } from '../../core/time.js';

// Match media.ts so every invocation is polite and reproducible.
const FFMPEG_GLOBAL_ARGS = ['-hide_banner', '-nostdin', '-y', '-filter_threads', '1', '-filter_complex_threads', '1'];
const FFMPEG_OUTPUT_THREADS = ['-threads', '2'];

async function ffmpeg(args: string[]): Promise<string> {
  try {
    return await runCommand('ffmpeg', [...FFMPEG_GLOBAL_ARGS, ...args]);
  } catch (err) {
    throw new Error(`ffmpeg failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

function fpsToString(fps: Fps): string {
  return `${fps.numerator}/${fps.denominator}`;
}

function fpsToNumber(fps: Fps): number {
  return fps.numerator / fps.denominator;
}

/**
 * Chained atempo factors that multiply to `factor`. `atempo` is only well
 * behaved inside [0.5, 2], so extreme ratios are split into several stages
 * (e.g. 4x -> 2,2 and 0.25x -> 0.5,0.5).
 */
function atempoChain(factor: number): number[] {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error(`retimeClip: invalid audio tempo factor ${factor}`);
  }
  // A factor of exactly 1 is a no-op: emitting `atempo=1` would spend work for
  // nothing, and (because atempo resamples through its own window) could perturb
  // a body that must stay a plain sample-exact trim. A non-retimed placement's
  // body takes exactly this path.
  if (factor === 1) return [];
  const stages: number[] = [];
  let remaining = factor;
  while (remaining > 2) {
    stages.push(2);
    remaining /= 2;
  }
  while (remaining < 0.5) {
    stages.push(0.5);
    remaining /= 0.5;
  }
  stages.push(remaining);
  return stages;
}

/**
 * Retime the half-open source interval [inFrame, outFrame) so that it renders
 * as exactly `durationFrames` frames at the output resolution / frame rate.
 *
 * Picture is encoded independently as H.264; source audio (when present) is
 * trimmed to the same interval, pitch-preserving time-stretched and padded or
 * bounded to the exact output sample span, then muxed with the runtime
 * `muxVideo` contract. A silent source produces a picture-only file.
 */
export async function retimeClip(
  input: string,
  output: OutputSettings,
  inFrame: number,
  outFrame: number,
  durationFrames: number,
  destination: string,
): Promise<void> {
  output = OutputSchema.parse(output);
  if (!Number.isSafeInteger(inFrame) || inFrame < 0) {
    throw new Error(`retimeClip: inFrame must be a nonnegative safe integer, got ${inFrame}`);
  }
  if (!Number.isSafeInteger(outFrame) || outFrame <= inFrame) {
    throw new Error(`retimeClip: outFrame must be a safe integer greater than inFrame, got ${outFrame}`);
  }
  if (!Number.isSafeInteger(durationFrames) || durationFrames <= 0) {
    throw new Error(`retimeClip: durationFrames must be a positive safe integer, got ${durationFrames}`);
  }

  const source = await probeMedia(input);
  if (outFrame > source.frames) {
    throw new Error(`retimeClip: trim [${inFrame}, ${outFrame}) exceeds source frame count ${source.frames}`);
  }

  const tmpDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-retime-'));
  try {
    const picture = nodePath.join(tmpDir, 'picture.mp4');
    await encodeRetimedPicture(input, source, output, inFrame, outFrame, durationFrames, picture);

    if (source.audio) {
      const audio = nodePath.join(tmpDir, 'audio.wav');
      await encodeRetimedAudioBody(input, source.fps, output, inFrame, outFrame, durationFrames, audio);
      await muxVideo(picture, audio, output, durationFrames, destination);
    } else {
      // Picture-only, copied without a fabricated silent track.
      await ffmpeg(['-i', picture, '-map', '0:v:0', '-c', 'copy', '-movflags', '+faststart', destination]);
      const probed = await probeMedia(destination);
      if (probed.frames !== durationFrames) {
        throw new Error(`retimeClip: expected ${durationFrames} picture-only frames, got ${probed.frames}`);
      }
      if (probed.audio) {
        throw new Error('retimeClip: picture-only retime must not contain an audio stream');
      }
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Encode exactly `durationFrames` CFR frames of the retimed interval.
 *
 * The trimmed interval is re-stamped by `scale = D*srcFps/(N*outFps)` so that
 * source frame i lands on output time i*D/(N*outFps); `fps=outFps:round=up`
 * then selects, for output slot k, the source frame floor(k*N/D), duplicating
 * when stretched and dropping when compressed. `tpad` clones the last selected
 * frame just far enough that the final slot is emitted; `-frames:v` caps the
 * count at exactly D. Nothing outside [inFrame, outFrame) is ever read.
 */
async function encodeRetimedPicture(
  input: string,
  source: MediaInfo,
  output: OutputSettings,
  inFrame: number,
  outFrame: number,
  durationFrames: number,
  destination: string,
): Promise<void> {
  const sourceFps = source.fps;
  const outputFps = output.fps;
  const interval = outFrame - inFrame;

  const scaleNumerator = durationFrames * sourceFps.numerator * outputFps.denominator;
  const scaleDenominator = interval * sourceFps.denominator * outputFps.numerator;
  if (!Number.isSafeInteger(scaleNumerator) || !Number.isSafeInteger(scaleDenominator) || scaleDenominator <= 0) {
    throw new Error('retimeClip: retime ratio exceeds safe integer range');
  }
  const divisor = gcd(scaleNumerator, scaleDenominator);
  const scale = `${scaleNumerator / divisor}/${scaleDenominator / divisor}`;

  // Extra tail needed so `fps` emits slot D-1: (D-N)/(N*outFps) plus one frame.
  const outputFpsNumber = fpsToNumber(outputFps);
  const padSeconds = Math.max(0, durationFrames - interval) / (interval * outputFpsNumber) + 1 / outputFpsNumber;
  const fps = fpsToString(outputFps);

  const filters = [
    `trim=start_frame=${inFrame}:end_frame=${outFrame}`,
    `setpts=(PTS-STARTPTS)*${scale}`,
    `tpad=stop_mode=clone:stop_duration=${padSeconds.toFixed(6)}`,
    `fps=${fps}:round=up`,
    `scale=${output.width}:${output.height}:flags=lanczos`,
    'setsar=1',
    'format=yuv420p',
  ].join(',');

  await ffmpeg([
    '-i',
    input,
    '-vf',
    filters,
    '-frames:v',
    String(durationFrames),
    '-r',
    fps,
    '-fps_mode',
    'cfr',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-an',
    ...FFMPEG_OUTPUT_THREADS,
    destination,
  ]);

  const probed = await probeMedia(destination);
  if (probed.frames !== durationFrames) {
    throw new Error(`retimeClip: expected ${durationFrames} retimed frames, got ${probed.frames}`);
  }
}

/**
 * Encode the pitch-preserving time-stretched body of a source-audio interval as
 * an exact target-sample WAV.
 *
 * THE single audio-retime implementation, shared by `retimeClip` (a whole
 * picture + audio retime) and the Build's kept-audio trim
 * (`source-audio-trim`), so the two can never drift. Both read the SAME interval
 * of the SAME Take on ONE clock and stretch it identically:
 *
 *  - Clock: the half-open source frame interval `[inFrame, outFrame)` is measured
 *    on the SOURCE's own frame clock `sourceFps` — the clock of the Take file
 *    being read — and quantized on the output sample grid (ceil). `inFrame`/
 *    `outFrame` are frames of the Take, so a Take whose fps differs from the
 *    composition must be measured with its OWN fps, never the composition's.
 *  - Stretch: the interval is resampled to the output rate and pitch-preserving
 *    time-stretched by `sourceSamples / targetSamples` with chained `atempo`
 *    (every stage inside [0.5, 2]), then explicitly padded or bounded to
 *    `targetSamples`, where `targetSamples` is `durationFrames` on the OUTPUT
 *    frame clock. The stretch factor `f = sourceSamples / targetSamples` maps the
 *    source clock onto the output timeline: an input sample span of N becomes
 *    N/f output samples.
 *  - Identity: when the source span already equals the target span the tempo is
 *    exactly 1 and NO time stretch is applied, so a non-retimed placement's body
 *    is a plain sample-exact trim of the same interval.
 *
 * A declared-but-undecodable audio stream propagates as an error.
 */
export async function encodeRetimedAudioBody(
  input: string,
  sourceFps: Fps,
  output: OutputSettings,
  inFrame: number,
  outFrame: number,
  durationFrames: number,
  destination: string,
): Promise<void> {
  const sampleRate = output.sampleRate;
  const startSample = framesToSamples(inFrame, sourceFps, sampleRate, 'ceil');
  const endSample = framesToSamples(outFrame, sourceFps, sampleRate, 'ceil');
  const sourceSamples = endSample - startSample;
  if (sourceSamples <= 0) {
    throw new Error(`retime audio: selected interval [${startSample}, ${endSample}) is empty`);
  }
  const targetSamples = framesToSamples(durationFrames, output.fps, sampleRate, 'ceil');
  if (targetSamples <= 0) {
    throw new Error('retime audio: target audio span must be positive');
  }

  const tempo = sourceSamples / targetSamples;
  const filters = [
    `aresample=${sampleRate}`,
    `atrim=start_sample=${startSample}:end_sample=${endSample}`,
    'asetpts=N/SR/TB',
    ...atempoChain(tempo).map(stage => `atempo=${stage}`),
    'apad',
    `atrim=end_sample=${targetSamples}`,
    'asetpts=N/SR/TB',
  ].join(',');

  await ffmpeg([
    '-i',
    input,
    '-map',
    '0:a:0',
    '-vn',
    '-af',
    filters,
    '-c:a',
    'pcm_s16le',
    '-ar',
    String(sampleRate),
    '-ac',
    String(output.channels),
    ...FFMPEG_OUTPUT_THREADS,
    destination,
  ]);
}
