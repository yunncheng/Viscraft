import { spawn } from 'node:child_process';
import { FFMPEG_GLOBAL_ARGS, FFMPEG_OUTPUT_THREADS } from './ffmpeg.js';
import { terminateChild, commandKillGraceMs, redact, runCommand } from '../../shared/process.js';
import {
  type OutputSettings,
  type AudioMastering,
  type AudioMasteringReport,
  OutputSchema,
  AudioMasteringSchema,
  AudioMasteringReportSchema,
} from '../../core/schema.js';
import { framesToSamples } from '../../core/time.js';
import * as nodePath from 'node:path';

// ---------------------------------------------------------------------------
// Optional measured mastering (the original valid mix remains immutable)
// ---------------------------------------------------------------------------

async function ffmpegAnalysis(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [...FFMPEG_GLOBAL_ARGS, ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '',
      timedOut = false,
      settled = false,
      cancelTermination: (() => void) | undefined;
    const timeoutMs = Number(process.env.VISCRAFT_COMMAND_TIMEOUT_MS ?? 600_000);
    let timer: NodeJS.Timeout;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cancelTermination?.();
      callback();
    };
    // Escalate a timeout past SIGTERM to SIGKILL after a finite grace: an
    // ffmpeg that ignores SIGTERM must not leave mastering hanging.
    const terminate = (): void => {
      if (cancelTermination) return;
      cancelTermination = terminateChild(child, commandKillGraceMs(), () =>
        settle(() =>
          reject(new Error(redact(`masterAudio: ffmpeg did not exit after SIGKILL: ${stderr.slice(-4000)}`))),
        ),
      );
    };
    timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    child.stderr.on('data', data => {
      stderr = (stderr + String(data)).slice(-64_000);
    });
    child.on('error', error => settle(() => reject(error)));
    child.on('close', code => {
      settle(() => {
        if (code === 0 && !timedOut) resolve(stderr);
        else
          reject(
            new Error(
              redact(`masterAudio: ffmpeg ${timedOut ? 'timed out' : `exited ${code}`}: ${stderr.slice(-4000)}`),
            ),
          );
      });
    });
  });
}

function loudnormMeasurement(log: string): Record<string, unknown> {
  const blocks = log.match(/\{[^{}]*"input_i"[^{}]*\}/g);
  if (!blocks?.length) throw new Error('masterAudio: FFmpeg produced no loudnorm measurement');
  return JSON.parse(blocks.at(-1)!) as Record<string, unknown>;
}

function measuredNumber(measurement: Record<string, unknown>, key: string): number {
  const value = measurement[key];
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) {
    throw new Error(
      `masterAudio: undefined or non-finite ${key}; silent or too-short audio cannot be loudness-mastered; omit mastering or provide measurable sound`,
    );
  }
  return Number(value);
}

async function assertMasterClock(input: string, output: OutputSettings, samples: number): Promise<void> {
  const probe = JSON.parse(
    await runCommand('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=codec_name,sample_rate,channels,duration_ts,time_base',
      '-of',
      'json',
      input,
    ]),
  ) as { streams?: Array<Record<string, unknown>> };
  const stream = probe.streams?.[0];
  const ticks = stream?.duration_ts;
  const base = typeof stream?.time_base === 'string' ? /^(\d+)\/(\d+)$/.exec(stream.time_base) : null;
  if (
    !stream ||
    stream.codec_name !== 'pcm_s16le' ||
    Number(stream.sample_rate) !== output.sampleRate ||
    stream.channels !== output.channels ||
    !base ||
    BigInt(base[2]) === 0n ||
    !Number.isSafeInteger(ticks) ||
    Number(ticks) < 0 ||
    BigInt(Number(ticks)) * BigInt(base[1]) * BigInt(output.sampleRate) !== BigInt(samples) * BigInt(base[2])
  ) {
    throw new Error(
      `masterAudio: expected exact ${samples}-sample PCM16 span at ${output.sampleRate} Hz / ${output.channels} channels`,
    );
  }
}

/** Two-pass loudnorm finishing of an already-valid PCM16 mix; never repairs overload. */
export async function masterAudio(
  input: string,
  output: OutputSettings,
  frames: number,
  settings: AudioMastering,
  destination: string,
): Promise<AudioMasteringReport> {
  output = OutputSchema.parse(output);
  if (!Number.isSafeInteger(frames) || frames <= 0)
    throw new Error('masterAudio: frames must be a positive safe integer');
  return masterAudioSamples(
    input,
    output,
    framesToSamples(frames, output.fps, output.sampleRate, 'ceil'),
    settings,
    destination,
  );
}

/**
 * Master an EXACT sample span. The film caller converts its frames above; a
 * sound target passes its authored `outputSamples` so mastering can never
 * silently change the delivered length.
 */
export async function masterAudioSamples(
  input: string,
  output: OutputSettings,
  samples: number,
  settings: AudioMastering,
  destination: string,
): Promise<AudioMasteringReport> {
  output = OutputSchema.parse(output);
  settings = AudioMasteringSchema.parse(settings);
  if (!Number.isSafeInteger(samples) || samples <= 0)
    throw new Error('masterAudioSamples: samples must be a positive safe integer');
  if (nodePath.resolve(input) === nodePath.resolve(destination))
    throw new Error('masterAudio: output must not overwrite the input mix');
  await assertMasterClock(input, output, samples);
  // Do not impose a narrow programme LRA; peak safety may still require dynamic gain.
  const filter = `loudnorm=I=${settings.targetLufs}:TP=${settings.truePeakDbfs}:LRA=50:dual_mono=false`;
  const first = loudnormMeasurement(
    await ffmpegAnalysis([
      '-i',
      input,
      '-map',
      '0:a:0',
      '-vn',
      '-af',
      `${filter}:print_format=json`,
      '-f',
      'null',
      '-',
    ]),
  );
  const measured = {
    integratedLufs: measuredNumber(first, 'input_i'),
    truePeakDbfs: measuredNumber(first, 'input_tp'),
    loudnessRange: measuredNumber(first, 'input_lra'),
    thresholdLufs: measuredNumber(first, 'input_thresh'),
    targetOffset: measuredNumber(first, 'target_offset'),
  };
  const second = loudnormMeasurement(
    await ffmpegAnalysis([
      '-i',
      input,
      '-map',
      '0:a:0',
      '-vn',
      '-af',
      `${filter}:measured_I=${measured.integratedLufs}:measured_TP=${measured.truePeakDbfs}:measured_LRA=${measured.loudnessRange}:measured_thresh=${measured.thresholdLufs}:offset=${measured.targetOffset}:linear=true:print_format=json,aresample=${output.sampleRate}:async=0,atrim=end_sample=${samples},asetpts=N/SR/TB`,
      '-ar',
      String(output.sampleRate),
      '-ac',
      String(output.channels),
      '-c:a',
      'pcm_s16le',
      ...FFMPEG_OUTPUT_THREADS,
      destination,
    ]),
  );
  await assertMasterClock(destination, output, samples);
  // Measure the actual encoded PCM, not loudnorm's pre-resample prediction.
  const verification = await ffmpegAnalysis([
    '-i',
    destination,
    '-map',
    '0:a:0',
    '-vn',
    '-af',
    'ebur128=peak=true:framelog=quiet',
    '-f',
    'null',
    '-',
  ]);
  const integrated = /^\s*I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/m.exec(verification);
  const peak = /Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/.exec(verification);
  if (!integrated || !peak) throw new Error('masterAudio: actual PCM loudness verification unavailable');
  const integratedLufs = Number(integrated[1]),
    truePeakDbfs = Number(peak[1]);
  if (Math.abs(integratedLufs - settings.targetLufs) > 1 || truePeakDbfs > settings.truePeakDbfs + 0.2) {
    throw new Error(
      `masterAudio: actual PCM failed loudness/peak verification (${integratedLufs} LUFS / ${truePeakDbfs} dBTP)`,
    );
  }
  return AudioMasteringReportSchema.parse({
    method: 'two-pass-loudnorm',
    settings,
    normalizationType: second.normalization_type,
    dualMono: false,
    loudnessRangeTarget: 50,
    input: measured,
    output: { integratedLufs, truePeakDbfs, sampleRate: output.sampleRate, channels: output.channels, samples },
  });
}
