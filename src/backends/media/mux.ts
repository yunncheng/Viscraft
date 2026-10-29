import { type OutputSettings, type Fade, FadeSchema } from '../../core/schema.js';
import { fpsToString, probeMedia } from './probe.js';
import { framesToSamples, frameSeconds } from '../../core/time.js';
import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import { ffmpeg, FFMPEG_OUTPUT_THREADS } from './ffmpeg.js';

// ---------------------------------------------------------------------------
// muxVideo
// ---------------------------------------------------------------------------

/**
 * Mux a video and an audio track into an H.264/AAC delivery file with an exact
 * frame count. Audio is sample-bounded; AAC and exact-frame H.264 are encoded
 * independently. Both completed streams are muxed by copy without a frame limit
 * or shortest-stream stop, which would otherwise discard trailing AAC packets.
 * MP4 movie/edit-list ticks use the sample rate to preserve sample-span duration.
 *
 * An optional whole-programme `fade` ramps the composed picture toward black and
 * the mixed audio by the same linear envelope over the same output span: frames
 * `[0, inFrames)` ramp 0->1 and `[totalFrames-outFrames, totalFrames)` ramp 1->0.
 * Absent or all-zero leaves both streams unfiltered so output bytes are unchanged.
 */
export async function muxVideo(
  video: string,
  audio: string,
  output: OutputSettings,
  frames: number,
  destination: string,
  fade?: Fade,
): Promise<void> {
  if (!Number.isInteger(frames) || frames <= 0) {
    throw new Error(`muxVideo: frames must be a positive integer, got ${frames}`);
  }
  const resolvedFade = fade === undefined ? { inFrames: 0, outFrames: 0 } : FadeSchema.parse(fade);
  if (resolvedFade.inFrames + resolvedFade.outFrames > frames) {
    throw new Error(
      `muxVideo: fade inFrames (${resolvedFade.inFrames}) + outFrames (${resolvedFade.outFrames}) exceeds the ${frames}-frame programme`,
    );
  }
  const fps = fpsToString(output.fps);
  const totalSamples = framesToSamples(frames, output.fps, output.sampleRate, 'ceil');
  // One linear envelope, expressed once, drives both streams. The picture uses
  // FFmpeg's `fade` toward black; the audio uses `afade` (default linear curve)
  // over the same second span, applied after the mix is padded/bounded so the
  // ramp lands on the exact authored sample range.
  const videoFade: string[] = [];
  const audioFade: string[] = [];
  if (resolvedFade.inFrames > 0) {
    const seconds = frameSeconds(resolvedFade.inFrames, output.fps);
    videoFade.push(`fade=t=in:st=0:d=${seconds}`);
    audioFade.push(`afade=t=in:st=0:d=${seconds}`);
  }
  if (resolvedFade.outFrames > 0) {
    const start = frameSeconds(frames - resolvedFade.outFrames, output.fps);
    const seconds = frameSeconds(resolvedFade.outFrames, output.fps);
    videoFade.push(`fade=t=out:st=${start}:d=${seconds}`);
    audioFade.push(`afade=t=out:st=${start}:d=${seconds}`);
  }
  const tmpDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-mux-'));
  try {
    const encodedAudio = nodePath.join(tmpDir, 'audio.m4a');
    const audioFilters = `aresample=${output.sampleRate},apad=whole_len=${totalSamples},atrim=end_sample=${totalSamples},asetpts=N/SR/TB${audioFade.length > 0 ? `,${audioFade.join(',')}` : ''}`;
    await ffmpeg([
      '-i',
      audio,
      '-map',
      '0:a:0',
      '-vn',
      '-af',
      audioFilters,
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      String(output.sampleRate),
      '-ac',
      String(output.channels),
      '-movie_timescale',
      String(output.sampleRate),
      ...FFMPEG_OUTPUT_THREADS,
      encodedAudio,
    ]);
    const encodedVideo = nodePath.join(tmpDir, 'video.mp4');
    const videoArgs = [
      '-i',
      video,
      '-map',
      '0:v:0',
      '-an',
      ...(videoFade.length > 0 ? ['-vf', videoFade.join(',')] : []),
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-r',
      fps,
      '-frames:v',
      String(frames),
      '-fps_mode',
      'cfr',
      ...FFMPEG_OUTPUT_THREADS,
      encodedVideo,
    ];
    await ffmpeg(videoArgs);
    // A video frame limit can also stop copied audio packets. Only apply it to
    // the video-only encode; the final mux must drain both completed streams.
    await ffmpeg([
      '-i',
      encodedVideo,
      '-i',
      encodedAudio,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c',
      'copy',
      '-movie_timescale',
      String(output.sampleRate),
      '-movflags',
      '+faststart',
      destination,
    ]);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  const probed = await probeMedia(destination);
  if (probed.frames !== frames) {
    throw new Error(`muxVideo: expected ${frames} output frames, got ${probed.frames}`);
  }
  if (!probed.audio) {
    throw new Error('muxVideo: output has no audio stream');
  }
  if (
    probed.audio.sampleRate !== output.sampleRate ||
    probed.audio.channels !== output.channels ||
    Math.abs(probed.audio.duration - totalSamples / output.sampleRate) > 1 / output.sampleRate
  ) {
    throw new Error(
      `muxVideo: audio does not cover the expected ${totalSamples}-sample span at ${output.sampleRate} Hz`,
    );
  }
}
