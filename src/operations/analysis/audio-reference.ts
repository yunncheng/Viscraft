// Audio reference analysis control plane.
//
// `analyzeAudioReference` inspects a piece of private reference material (a
// local, project-relative audio or A/V file) and derives a sample-truthful,
// heuristic report a host Agent can use to re-author a *new* project: where
// energy rises on the source audio clock and how those sample positions map
// onto the target composition frame rate.
//
// Spaces (deliberately distinct):
//  - `energy[].sample` and `onsets[].sample` are decoded *PCM sample indices*
//    at the requested output sample rate (44100 or 48000), on an exact 10 ms
//    grid. They are not seconds and not source-container timestamps.
//  - `onsets[].outputFrame` is the exact mapping onto the target composition
//    timeline (via shared `ptsToFrames` treating one sample as one tick of a
//    1/sampleRate time base, half-up). The shared clock does the arithmetic;
//    no floating-point seconds are used.
//
// Boundaries enforced here:
//  - The reference stays *unregistered material*. Analysis never registers an
//    Asset, mutates the Project, or writes outside a fresh
//    `.viscraft/audio-references/` run directory (published reports are never
//    overwritten).
//  - The report is a *derived artifact*, not a reconstruction of the original
//    edit/project or its audio mix.
//  - Onsets are a fixed energy-rise heuristic, not subjective listening. No
//    musical beat/BPM, tempo, key, or pose claim is made.
//  - A missing audio stream is an error, never silently treated as silence.
//
// Verified ffprobe/ffmpeg behaviour this module relies on (ffmpeg 6.1.x):
//  - `ffprobe -select_streams a:0 -show_entries stream=codec_type,codec_name,
//    sample_rate,channels` reports an empty `streams` list (exit 0) when no
//    audio stream exists; that is the only trustworthy "no audio" signal.
//  - `ffmpeg -i <file> -vn -t <s> -f f32le -acodec pcm_f32le -ar <rate> -ac 1`
//    decodes the audio stream to interleaved mono 32-bit little-endian float
//    PCM at the requested rate; `-t` bounds the decoded duration.

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { AudioReferenceSchema, FpsSchema, requireComposition } from '../../core/schema.js';
import type { AudioReference, Fps, Project } from '../../core/schema.js';
import { atomicJson, resolveProjectPath } from '../../shared/fs.js';
import { hashFile, stableHash } from '../../shared/hash.js';
import { runCommand } from '../../shared/process.js';
import { loadProject } from '../../project/project.js';
import { readBuilds } from '../../project/build-records.js';
import { ptsToFrames } from '../../core/time.js';

/** Default hard bound on analyzed audio: analysis must never buffer an unbounded file. */
const DEFAULT_WINDOW_SECONDS = 60;
/** Absolute ceiling for a caller-configured window, so analysis always stays bounded. */
const MAX_WINDOW_SECONDS = 3600;
/** Non-overlapping RMS window: 10 ms (441 samples at 44.1 kHz, 480 at 48 kHz). */
const WINDOW_SECONDS = 0.01;
/** Refractory gap between accepted onsets. */
const REFRACTORY_SECONDS = 0.08;
/** Relative-energy threshold; an onset must exceed this fraction of the peak RMS. */
const DEFAULT_THRESHOLD = 0.2;
/** Hard ceiling on reported energy rows (supports a one-hour window at 10 ms). */
const MAX_ENERGY_ROWS = 360_000;
/** Hard bound on reported onsets. */
const MAX_ONSETS = 2000;
const FFMPEG_GLOBAL = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-threads', '2', '-filter_threads', '1'];

export interface AnalyzeAudioReferenceOptions {
  /** Target frame rate for onset positions; required without a composition, otherwise defaults to its fps. */
  fps?: Fps;
  /** PCM sample rate; required without a composition, otherwise defaults to its output sample rate. */
  sampleRate?: 44100 | 48000;
  /** Relative-energy onset threshold in [0, 1] against the peak RMS; defaults to 0.20. */
  threshold?: number;
  /**
   * Analysis window in seconds. Audio after this point is not analysed; the
   * report states the exact span and whether it was truncated to the window.
   * Defaults to 60 s. Must be a finite number
   * in (0, 3600]; analysis is never run over unbounded audio.
   */
  windowSeconds?: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function ffprobe(entries: string, file: string, extra: string[] = []): Promise<any> {
  try {
    return JSON.parse(
      await runCommand('ffprobe', ['-v', 'error', ...extra, '-show_entries', entries, '-of', 'json', file]),
    );
  } catch (error) {
    throw new Error(`ffprobe failed for reference ${file}: ${messageOf(error)}`);
  }
}

/**
 * Require a real, inspectable audio stream. A missing stream is a hard error:
 * an unreadable/absent stream must never be reported as silence.
 */
async function requireAudioStream(file: string): Promise<void> {
  const probe = await ffprobe('stream=codec_type,codec_name,sample_rate,channels', file, ['-select_streams', 'a:0']);
  const stream = Array.isArray(probe.streams) ? probe.streams[0] : undefined;
  if (!stream || stream.codec_type !== 'audio') {
    throw new Error(
      `Audio reference ${file} has no decodable audio stream; refusing to treat a missing stream as silence`,
    );
  }
  const sampleRate = Number(stream.sample_rate);
  const channels = Number(stream.channels);
  if (!Number.isInteger(sampleRate) || sampleRate <= 0 || !Number.isInteger(channels) || channels <= 0) {
    throw new Error(`Audio reference ${file} has an audio stream with no verifiable sample rate or channel count`);
  }
}

/**
 * Decode the audio stream to private mono float32 PCM at `sampleRate`, reading
 * at most `boundSeconds` of audio. Raw PCM cannot travel through
 * `runCommand`'s string stdout, so it is written to a temporary file first.
 */
async function decodeMono(
  input: string,
  sampleRate: number,
  boundSeconds: number,
  tmpDir: string,
): Promise<Float32Array> {
  const rawPath = nodePath.join(tmpDir, `decode-${randomUUID()}.f32le`);
  try {
    await runCommand('ffmpeg', [
      ...FFMPEG_GLOBAL,
      '-i',
      input,
      '-map',
      '0:a:0',
      '-vn',
      '-t',
      boundSeconds.toFixed(6),
      '-f',
      'f32le',
      '-acodec',
      'pcm_f32le',
      '-ar',
      String(sampleRate),
      '-ac',
      '1',
      rawPath,
    ]);
  } catch (error) {
    throw new Error(`Audio decode failed for ${input}: ${messageOf(error)}`);
  }
  const buf = await fs.readFile(rawPath);
  const total = Math.floor(buf.length / 4);
  const samples = new Float32Array(total);
  for (let i = 0; i < total; i++) samples[i] = buf.readFloatLE(i * 4);
  return samples;
}

/**
 * Resolve provenance strictly by content hash. Path-only matches are never
 * trusted: a registered record whose path equals the reference but whose
 * recorded hash differs is a mismatch, and taint is the union over *all*
 * hash-matching records.
 */
function provenance(
  project: Project,
  builds: Awaited<ReturnType<typeof readBuilds>>,
  relativePath: string,
  sha256: string,
): { origin: AudioReference['source']['origin']; simulated: boolean; hashMismatch: boolean } {
  const records = [
    ...project.assets.map(asset => ({
      kind: 'asset' as const,
      path: asset.path,
      sha256: asset.sha256,
      simulated: asset.simulated,
    })),
    ...builds
      .flatMap(build => build.artifacts)
      .map(artifact => ({
        kind: 'artifact' as const,
        path: artifact.path,
        sha256: artifact.sha256,
        simulated: artifact.simulated,
      })),
  ];
  const matching = records.filter(record => record.sha256 === sha256);
  const origin: AudioReference['source']['origin'] = matching.some(record => record.kind === 'asset')
    ? 'asset'
    : matching.some(record => record.kind === 'artifact')
      ? 'artifact'
      : 'material';
  const simulated = matching.some(record => record.simulated);
  const hashMismatch = records.some(record => record.path === relativePath && record.sha256 !== sha256);
  return { origin, simulated, hashMismatch };
}

/** Validate the sample-rate option against the two supported output rates. */
function resolveSampleRate(value: number): 44100 | 48000 {
  if (value !== 44100 && value !== 48000)
    throw new Error(`Audio reference sampleRate must be 44100 or 48000, got ${String(value)}`);
  return value;
}

/**
 * Analyze a local, project-relative reference audio (or A/V) file.
 *
 * Reads and validates the Project (never mutating or registering anything),
 * resolves the input safely, decodes real audio, and returns a validated
 * `AudioReference` written atomically into a fresh
 * `.viscraft/audio-references/<key>/` run directory.
 */
export async function analyzeAudioReference(
  root: string,
  relativePath: string,
  options: AnalyzeAudioReferenceOptions = {},
): Promise<AudioReference> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(`Audio reference threshold must be a finite number in [0, 1], got ${String(options.threshold)}`);
  }
  const windowSeconds = options.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0 || windowSeconds > MAX_WINDOW_SECONDS) {
    throw new Error(
      `Audio reference windowSeconds must be a finite number in (0, ${MAX_WINDOW_SECONDS}], got ${String(options.windowSeconds)}`,
    );
  }

  const project = await loadProject(root);
  const fps = options.fps ? FpsSchema.parse(options.fps) : requireComposition(project).output.fps;
  const sampleRate = resolveSampleRate(options.sampleRate ?? requireComposition(project).output.sampleRate);
  const windowSamples = Math.round(sampleRate * WINDOW_SECONDS);
  const refractorySamples = Math.round(sampleRate * REFRACTORY_SECONDS);
  const maxSamples = Math.round(windowSeconds * sampleRate);

  // Safe, symlink-rejecting resolution; the report never touches authoring files.
  const absolute = await resolveProjectPath(root, relativePath);
  let sha256: string;
  try {
    sha256 = await hashFile(absolute);
  } catch (error) {
    throw new Error(`Reference material is not readable: ${relativePath} (${messageOf(error)})`);
  }

  // Require a real, inspectable audio stream before decoding any PCM.
  await requireAudioStream(absolute);

  const referencesDir = await resolveProjectPath(root, '.viscraft/audio-references');
  const workDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-audio-reference-'));
  // Unique, option-sensitive run key so distinct analyses never collide or
  // overwrite a previously published report.
  const runKey = `${stableHash({ sha256, fps, sampleRate, threshold, windowSeconds }).slice(0, 24)}-${randomUUID().slice(0, 8)}`;
  const relativeDir = `.viscraft/audio-references/${runKey}`;
  const reportRelative = `${relativeDir}/report.json`;

  let staging: string | undefined;
  try {
    // Decode at most the window + one sample so an over-long source is
    // *detected*, never silently truncated without an explicit limitation.
    const boundSeconds = Math.ceil(((maxSamples + 1) / sampleRate) * 1e6) / 1e6;
    const pcm = await decodeMono(absolute, sampleRate, boundSeconds, workDir);
    if (pcm.length === 0)
      throw new Error(`Audio reference ${relativePath} decoded no samples; there is no audio to analyze`);
    const excess = pcm.length > maxSamples;
    const samples = excess ? maxSamples : pcm.length;

    // Non-overlapping 10 ms RMS window grid over the analyzed span.
    const energy: Array<{ sample: number; rms: number }> = [];
    let peak = 0;
    const rows = Math.min(MAX_ENERGY_ROWS, Math.ceil(samples / windowSamples));
    for (let row = 0; row < rows; row++) {
      const start = row * windowSamples;
      const end = Math.min(start + windowSamples, samples);
      let sum = 0;
      for (let i = start; i < end; i++) sum += pcm[i] * pcm[i];
      const rms = end > start ? Math.sqrt(sum / (end - start)) : 0;
      if (rms > peak) peak = rms;
      energy.push({ sample: start, rms });
    }

    // Silence-to-active energy-rise onsets: a window that rises above the
    // relative threshold from an inactive predecessor, with a positive RMS
    // difference and a refractory gap. Heuristic only.
    const thresholdEnergy = peak * threshold;
    const onsets: Array<{ sample: number; outputFrame: number; strength: number }> = [];
    let lastAccepted = -1;
    for (let i = 0; i < energy.length; i++) {
      const rms = energy[i].rms;
      const previous = i > 0 ? energy[i - 1].rms : 0;
      if (rms < thresholdEnergy || rms <= previous) continue;
      if (i > 0 && previous >= thresholdEnergy) continue;
      const sample = energy[i].sample;
      if (lastAccepted >= 0 && sample - lastAccepted < refractorySamples) continue;
      lastAccepted = sample;
      onsets.push({
        sample,
        outputFrame: ptsToFrames(String(sample), '0', { numerator: 1, denominator: sampleRate }, fps),
        strength: rms,
      });
    }
    const truncated = onsets.length > MAX_ONSETS;
    const limitedOnsets = truncated ? onsets.slice(0, MAX_ONSETS) : onsets;

    // Reject a reference that changed underneath the analysis.
    if ((await hashFile(absolute)) !== sha256) {
      throw new Error(`Reference input ${relativePath} changed during analysis; discard this report and retry`);
    }

    const limitations = [
      'Onsets come from a fixed 10 ms RMS energy-rise heuristic over decoded audio; they mark energy/transient rises and make no claim about subjective listening, musical beats/BPM, tempo, key, or pose.',
      'The reference stays unregistered material: this report is a derived artifact, not a reconstruction of the original project, edit, or audio mix.',
      'Energy rows and onsets sit on an exact sample grid at the requested output sample rate; each onset output frame is the nearest composition frame via the shared rational clock.',
      'Audio was downmixed to mono for analysis; stereo image, phase, and per-channel content are not represented.',
      'Sample zero is the decoded first audio stream origin; arbitrary input audio/video start offsets are not mapped onto the video clock.',
      `The analysed span is exactly samples [0, ${samples}) (${windowSeconds}-second analysis window); audio outside that span is not represented in this report.`,
    ];
    if (excess)
      limitations.push(
        `Audio was capped at ${windowSeconds} seconds (${maxSamples} samples); any later audio was not analyzed.`,
      );
    if (!options.fps) limitations.push('Output fps defaulted to the current Project composition fps.');
    if (options.sampleRate === undefined)
      limitations.push('Sample rate defaulted to the current Project composition output sample rate.');
    const source = provenance(project, await readBuilds(root), relativePath, sha256);
    if (source.origin === 'material')
      limitations.push(
        'Origin "material" with simulated=false means provenance is unknown; it is not evidence that the audio came from a real generation provider.',
      );
    if (source.hashMismatch)
      limitations.push(
        "A registered record shares this material's path but its recorded sha256 differs; identity was not assumed and the source is treated as unregistered material.",
      );
    if (truncated)
      limitations.push(
        `Onsets were capped at ${MAX_ONSETS} of ${onsets.length}; the full onset stream is not claimed.`,
      );
    if (limitedOnsets.length === 0)
      limitations.push(
        'No energy-rise onsets exceeded the relative threshold; silence or continuous energy yields no onsets.',
      );

    const report = AudioReferenceSchema.parse({
      schemaVersion: 1,
      kind: 'audio-reference',
      source: { path: relativePath, sha256, origin: source.origin, simulated: source.simulated },
      fps,
      sampleRate,
      samples,
      windowSamples,
      windowSeconds,
      analysedSpan: { startSample: 0, endSample: samples, truncatedToWindow: excess },
      energy,
      onsets: limitedOnsets,
      reportPath: reportRelative,
      limitations,
    });

    // Commit the report inside staging, then publish the whole run directory
    // atomically. Published reports are never deleted.
    await fs.mkdir(referencesDir, { recursive: true });
    const finalDir = await resolveProjectPath(root, relativeDir);
    try {
      await fs.access(finalDir);
      throw new Error(
        `Audio reference run directory ${relativeDir} already exists; refusing to overwrite published reports`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    staging = await fs.mkdtemp(nodePath.join(referencesDir, '.tmp-'));
    await atomicJson(nodePath.join(staging, 'report.json'), report);
    await fs.rename(staging, finalDir);
    staging = undefined;

    return report;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}
