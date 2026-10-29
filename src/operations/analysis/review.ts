// Viscraft review: reproducible, traceable review products for a completed Build.
//
// `reviewBuild` is a *read-only* derived operation over an already-succeeded
// Build. It never rewrites the project, the build record, its artifacts or the
// active `.viscraft/result.json`. It reconstructs the edit timeline from the
// Build's **frozen project snapshot**
// (`.viscraft/snapshots/<buildId>/project.json`) — NOT from the current,
// possibly edited `project.json` — so the extracted frames describe what that
// Build actually delivered rather than a later authoring state.
//
// It produces, inside `.viscraft/reviews/<buildId>/`:
//   - a contact sheet (PNG grid): first / middle / last delivered frame per
//     *placement* (a shot may be placed more than once, so a shot is not a
//     single continuous interval);
//   - one seam strip (PNG) per edit: frames cut-2, cut-1, cut, cut+1;
//   - a JSON technical report: verified artifact hashes, final probe, EBU R128
//     loudness / true peak, plus black-frame, silence and repeated-frame *facts*.
//
// The stills exist for human/agent visual inspection. Frame sampling does NOT
// measure continuity, motion or aesthetic quality; this module never claims a
// pixel metric proves cinematic quality. Audio is analysed numerically and this
// module never claims that anyone listened to it.

import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { atomicJson, replaceFile, resolveProjectPath } from '../../shared/fs.js';
import { hashFile } from '../../shared/hash.js';
import { SnapshotInputsSchema } from '../../project/author-inputs.js';
import { snapshotHashOf } from '../../project/state.js';
import { commandKillGraceMs, redact, runCommand, terminateChild } from '../../shared/process.js';
import { probeAudio, probeMedia } from '../../backends/media/probe.js';
import { readBuilds } from '../../project/build-records.js';
import { validateProject } from '../../project/project.js';
import { compositionFrames } from '../../core/composition.js';
import { framesToSamples, ptsToFrames } from '../../core/time.js';
import {
  requireFilmProject,
  type Artifact,
  type BuildRecord,
  type Fps,
  type Placement,
  type Take,
} from '../../core/schema.js';

/** Width, in pixels, of a single contact-sheet / seam cell. */
const CELL_WIDTH = 320;
const GLOBAL_ARGS = ['-hide_banner', '-nostdin', '-y', '-filter_threads', '1'];
// Media work stays reproducible (see backends/media/picture.ts): cap encoder
// threads on every local invocation.
const OUTPUT_THREADS = ['-threads', '2'];
const OBSERVATION = 'extracted stills + technical audio analysis; subjective audio review not performed';

export interface ReviewResult {
  /** The Build that was reviewed. */
  build: string;
  /** Whether the reviewed result carries any simulated/test-only provenance. */
  simulated: boolean;
  /** Project-relative path of the contact-sheet PNG. */
  contactSheet: string;
  /** Project-relative paths of the per-cut seam strips, in timeline order. */
  seams: string[];
  /** Project-relative path of the JSON technical report. */
  report: string;
  /**
   * Per-shot candidate-Take comparisons declared by the reviewed Build's
   * `plan.candidates`. Always present, empty when the Build declared no
   * candidates (no comparison strip is written in that case).
   */
  candidateComparisons: CandidateComparison[];
}

/** One candidate Take's facts inside a per-shot comparison. */
export interface CandidateComparisonEntry {
  /** The candidate Source id this Take was rendered from. */
  source: string;
  /** The Take id recorded by the Build. */
  take: string;
  /** The Artifact id holding the Take's media. */
  artifact: string;
  /** The Take's own frame count (not the composed shot's duration). */
  frames: number;
  /** The Take's own frame rate. */
  fps: Fps;
  /** Whether the Take carries simulated/test-only provenance. */
  simulated: boolean;
  /** The verified content hash recorded for the Take's artifact. */
  sha256: string;
  /**
   * True when the composed result actually uses this Take for the shot,
   * derived from the frozen composition's placements (never guessed).
   */
  selected: boolean;
  /**
   * True when this candidate Take's artifact is audio-only (e.g. a code-authored
   * `sound` Source). It has no picture, so it contributes no row to the picture
   * comparison strip and its real audio facts are reported here instead of
   * fabricated frames.
   */
  audioOnly?: boolean;
  /** Real audio-stream facts, present only when `audioOnly` is true. */
  audio?: { sampleRate: number; channels: number; duration: number; samples: number };
}

/** A per-shot comparison of every candidate Take the Build rendered. */
export interface CandidateComparison {
  /** The shot the candidates were authored for. */
  shot: string;
  /**
   * Project-relative path of the comparison strip PNG (one row per candidate
   * Take, first / middle / last frame). Absent when no candidate Take exists.
   */
  strip?: string;
  /** One entry per candidate Take, in authored `sources` order. */
  entries: CandidateComparisonEntry[];
}

interface LoudnessResult {
  available: boolean;
  integratedLufs?: number;
  truePeakDbfs?: number;
  reason?: string;
}

interface SilenceInterval {
  start?: number;
  end?: number;
  duration?: number;
}

interface SilenceResult {
  available: boolean;
  intervals: SilenceInterval[];
  reason?: string;
}

/**
 * Fixed sampling geometry and tolerances for repeated-frame detection. The
 * picture of every decoded frame is reduced to a `REPEAT_SAMPLE x REPEAT_SAMPLE`
 * RGB24 buffer; two consecutive frames count as the same held picture when BOTH
 * the per-channel absolute difference never exceeds `REPEAT_MAX_ABS_DIFF` AND
 * the mean per-channel absolute difference stays within `REPEAT_MEAN_ABS_DIFF`.
 * These values
 * were chosen from measured H.264 (crf 18, `yuv420p`) behaviour: a genuinely
 * frozen source decodes to a mean delta of ~0.02 / max ~5, while a one-second
 * fade or a slow pan stays above a mean delta of 6 / max 200 — so the
 * threshold cleanly separates a real hold from coded noise without flagging
 * gradual brightness ramps. The bounds are fixed constants, so the same input
 * always yields the same report bytes.
 */
const REPEAT_SAMPLE = 64;
const REPEAT_MAX_ABS_DIFF = 16;
const REPEAT_MEAN_ABS_DIFF = 0.75;
const REPEAT_METHOD = `decode at ${REPEAT_SAMPLE}x${REPEAT_SAMPLE} rgb24 (lanczos) and compare consecutive frames; unchanged when max per-channel delta <= ${REPEAT_MAX_ABS_DIFF} AND mean per-channel delta <= ${REPEAT_MEAN_ABS_DIFF}`;

/** One maximal run of consecutive frames whose decoded picture is unchanged. */
export interface RepeatedFrameSpan {
  /** 0-based index of the run's first frame. */
  startFrame: number;
  /** 0-based index of the run's last frame (inclusive). */
  endFrame: number;
  /** Frames in the run (`endFrame - startFrame + 1`), always >= 2. */
  lengthFrames: number;
}

/**
 * Deterministic repeated-frame / frozen-span fact for the reviewed movie.
 * Always present; `spans` is empty and the counts are zero when the picture
 * changes on every frame. A held picture is a *fact*, not a defect: designed
 * pauses, holds and stills are legitimate creative choices.
 */
export interface RepeatedFramesResult {
  /** How the picture was sampled and what counted as "unchanged". */
  method: string;
  sampleWidth: number;
  sampleHeight: number;
  toleranceMaxAbsDiff: number;
  toleranceMeanAbsDiff: number;
  /** Frames actually decoded and compared (equals the final's frame count). */
  analysedFrames: number;
  /** Number of repeated-frame spans found. */
  spanCount: number;
  /** Total redundant frames across all spans (`sum(lengthFrames - 1)`). */
  repeatedFrames: number;
  /** The spans, in timeline order. */
  spans: RepeatedFrameSpan[];
}

// ---------------------------------------------------------------------------
// Local FFmpeg helpers (stderr captured for machine-readable analysis output)
// ---------------------------------------------------------------------------

/** Run FFmpeg and resolve with stderr, which carries blackdetect/silencedetect/ebur128 output. */
async function runFfmpeg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    let timedOut = false,
      settled = false,
      cancelTermination: (() => void) | undefined;
    let timer: NodeJS.Timeout;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cancelTermination?.();
      callback();
    };
    // A timeout terminates the child we started: SIGTERM, then SIGKILL after a
    // finite grace, and always a failure — a process that ignores SIGTERM and
    // later exits 0 must never be reported as a successful analysis.
    const terminate = (): void => {
      if (cancelTermination) return;
      cancelTermination = terminateChild(child, commandKillGraceMs(), () =>
        settle(() => reject(new Error(redact(`ffmpeg did not exit after SIGKILL: ${stderr.slice(-600)}`)))),
      );
    };
    timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, 120_000);
    child.stderr.on('data', data => {
      stderr = (stderr + String(data)).slice(-8_000_000);
    });
    child.on('error', error => settle(() => reject(error)));
    child.on('close', code => {
      settle(() => {
        if (timedOut) reject(new Error(redact(`ffmpeg timed out after 120000ms: ${stderr.slice(-600)}`)));
        else if (code === 0) resolve(stderr);
        else reject(new Error(redact(`ffmpeg exited ${code}: ${stderr.slice(-600)}`)));
      });
    });
  });
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Real audio-stream duration in seconds, read from the audio stream only (never
 * the video/container clock). Returns `undefined` when the file carries no audio
 * stream; ffprobe failures propagate rather than being reported as "no audio".
 * Used to state, as a fact, how long an audio Asset or a kept Take's own audio
 * really is (see the per-clip and kept-audio review facts).
 */
async function audioDurationSeconds(file: string): Promise<number | undefined> {
  const probe = JSON.parse(
    await runCommand('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=sample_rate,duration,duration_ts,time_base',
      '-of',
      'json',
      file,
    ]),
  ) as { streams?: Array<{ duration?: string; duration_ts?: string; time_base?: string }> };
  const stream = (probe.streams ?? [])[0];
  if (!stream) return undefined;
  const duration = Number(stream.duration);
  if (Number.isFinite(duration) && duration > 0) return duration;
  const ticks = Number.parseInt(stream.duration_ts ?? '', 10);
  const base = /^(\d+)\/(\d+)$/.exec(stream.time_base ?? '');
  if (Number.isSafeInteger(ticks) && ticks > 0 && base && Number(base[2]) > 0)
    return (ticks * Number(base[1])) / Number(base[2]);
  return undefined;
}

/**
 * Extract the requested frame numbers (0-based, source order) as scaled PNGs.
 * A single `select` pass keeps the operation decoding the master once; the
 * returned map keys are frame indices so callers can regroup frames freely.
 */
async function extractFrames(input: string, frames: number[], dir: string): Promise<Map<number, string>> {
  const ordered = [...new Set(frames)].filter(n => Number.isInteger(n) && n >= 0).sort((a, b) => a - b);
  if (ordered.length === 0) throw new Error('review: no frames were requested for extraction');
  const select = ordered.map(n => `eq(n\\,${n})`).join('+');
  const pattern = path.join(dir, 'frame-%05d.png');
  await runFfmpeg([
    ...GLOBAL_ARGS,
    '-i',
    input,
    '-vf',
    `select=${select},scale=${CELL_WIDTH}:-2:flags=lanczos`,
    '-fps_mode',
    'vfr',
    '-frames:v',
    String(ordered.length),
    ...OUTPUT_THREADS,
    '-f',
    'image2',
    pattern,
  ]);
  const map = new Map<number, string>();
  for (let i = 0; i < ordered.length; i++) {
    const file = path.join(dir, `frame-${String(i + 1).padStart(5, '0')}.png`);
    if (!(await fileExists(file))) throw new Error(`review: frame ${ordered[i]} was not extracted from ${input}`);
    map.set(ordered[i], file);
  }
  return map;
}

/**
 * Tile equal-sized PNGs into a single grid PNG. `tile` pads incomplete rows with
 * black cells, so the page stays viewable when the layout is not an exact
 * multiple. A single image is copied directly (no grid needed).
 */
async function tileFrames(files: string[], columns: number, dest: string): Promise<void> {
  if (files.length === 0) throw new Error('review: no frames to compose into an image');
  if (files.length === 1) {
    await copyFile(files[0], dest);
    return;
  }
  const rows = Math.ceil(files.length / columns);
  const sequence = path.join(path.dirname(dest), `.seq-${path.basename(dest, '.png')}`);
  await mkdir(sequence, { recursive: true });
  try {
    for (let i = 0; i < files.length; i++) {
      await copyFile(files[i], path.join(sequence, `cell-${String(i + 1).padStart(4, '0')}.png`));
    }
    await runFfmpeg([
      ...GLOBAL_ARGS,
      '-framerate',
      '1',
      '-i',
      path.join(sequence, 'cell-%04d.png'),
      '-vf',
      `tile=${columns}x${rows}`,
      '-frames:v',
      '1',
      '-update',
      '1',
      ...OUTPUT_THREADS,
      dest,
    ]);
  } finally {
    await rm(sequence, { recursive: true, force: true });
  }
}

/**
 * Move a fully-rendered product from the private staging directory into its
 * published location with an atomic rename. Staging and destination share the
 * review directory (same filesystem), so a concurrent reader only ever observes
 * a complete file, and a repeat review cleanly replaces a prior product.
 */
async function publishFile(staged: string, dest: string): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  await replaceFile(staged, dest);
}

/**
 * Render one comparison strip per candidate shot, reusing the same frame
 * extraction and tiling helpers as the contact sheet. Each candidate Take
 * becomes one row of [first, middle, last] of its *own* artifact; the strip is
 * published atomically as `candidate-<shot>.png` beside the other review
 * products. Every entry records the Take's real frame count and the verified
 * artifact hash, and `selected` marks the Take the frozen composition uses.
 */
async function renderCandidateComparisons(
  root: string,
  reviewDirRel: string,
  workDir: string,
  candidates: Array<{ shot: string; sources: string[] }>,
  takesBySource: Map<string, Take>,
  selectedTakeIdsByShot: Map<string, Set<string>>,
  artifactsById: Map<string, Artifact>,
): Promise<CandidateComparison[]> {
  const comparisons: CandidateComparison[] = [];
  for (const candidate of candidates) {
    // One entry per candidate Source, in the authored order; a Source the Build
    // never rendered a Take for is simply absent rather than fabricated.
    const takes = candidate.sources
      .map(source => takesBySource.get(source))
      .filter((take): take is Take => Boolean(take));
    if (takes.length === 0) {
      comparisons.push({ shot: candidate.shot, entries: [] });
      continue;
    }

    const selectedIds = selectedTakeIdsByShot.get(candidate.shot) ?? new Set<string>();
    const rowFiles: string[] = [];
    const entries: CandidateComparisonEntry[] = [];
    for (const take of takes) {
      const artifact = artifactsById.get(take.artifact);
      if (!artifact)
        throw new Error(`review: candidate Take ${take.id} references unregistered artifact ${take.artifact}`);
      // An audio-only candidate Take has no picture to compare: it contributes
      // no strip row, and its real audio facts are reported instead of frames
      // that do not exist.
      if (artifact.kind === 'audio') {
        const probed = await probeAudio(await resolveProjectPath(root, artifact.path));
        entries.push({
          source: take.source!,
          take: take.id,
          artifact: take.artifact,
          frames: 0,
          fps: { numerator: 0, denominator: 1 },
          simulated: take.simulated,
          sha256: artifact.sha256,
          selected: selectedIds.has(take.id),
          audioOnly: true,
          audio: {
            sampleRate: probed.sampleRate,
            channels: probed.channels,
            duration: probed.duration,
            samples: probed.samples,
          },
        });
        continue;
      }
      // A non-audio artifact with a sound Take is inconsistent; refuse rather
      // than reading a picture clock that does not exist.
      if (take.medium !== 'picture')
        throw new Error(`review: candidate Take ${take.id} is a sound Take but its artifact is ${artifact.kind}`);
      const artifactPath = await resolveProjectPath(root, artifact.path);
      // Exactly three cells per row (first / middle / last). Short Takes repeat
      // frames rather than dropping cells, so every candidate stays one row.
      const lastFrame = take.frames - 1;
      const positions = [0, Math.floor(lastFrame / 2), lastFrame];
      const frameDir = path.join(workDir, `candidate-${candidate.shot}-${take.source}`);
      await mkdir(frameDir, { recursive: true });
      const frameMap = await extractFrames(artifactPath, positions, frameDir);
      for (const frame of positions) {
        const file = frameMap.get(frame);
        if (!file) throw new Error(`review: frame ${frame} was not extracted from candidate Take ${take.id}`);
        rowFiles.push(file);
      }
      entries.push({
        source: take.source!,
        take: take.id,
        artifact: take.artifact,
        frames: take.frames,
        fps: take.fps,
        simulated: take.simulated,
        sha256: artifact.sha256,
        selected: selectedIds.has(take.id),
      });
    }

    // No picture rows at all (every candidate was audio-only): report the
    // entries without fabricating a comparison strip.
    if (rowFiles.length === 0) {
      comparisons.push({ shot: candidate.shot, entries });
      continue;
    }

    const name = `candidate-${candidate.shot}.png`;
    const rel = `${reviewDirRel}/${name}`;
    const staged = path.join(workDir, name);
    await tileFrames(rowFiles, 3, staged);
    await publishFile(staged, await resolveProjectPath(root, rel));
    comparisons.push({ shot: candidate.shot, strip: rel, entries });
  }
  return comparisons;
}

// ---------------------------------------------------------------------------
// FFmpeg log parsers (real computed values only; never fabricated)
// ---------------------------------------------------------------------------

function parseLoudness(stderr: string): LoudnessResult {
  const integrated = /^\s*I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/m.exec(stderr);
  const peak = /Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/.exec(stderr);
  if (!integrated && !peak) return { available: false, reason: 'FFmpeg ebur128 produced no readable summary' };
  return {
    available: true,
    ...(integrated ? { integratedLufs: Number(integrated[1]) } : {}),
    ...(peak ? { truePeakDbfs: Number(peak[1]) } : {}),
  };
}

function parseSilence(stderr: string): SilenceResult {
  const intervals: SilenceInterval[] = [];
  let start: number | undefined;
  for (const line of stderr.split('\n')) {
    const s = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (s) start = Number(s[1]);
    const e = /silence_end:\s*(-?\d+(?:\.\d+)?)\s*\|\s*silence_duration:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (e) {
      intervals.push({ start, end: Number(e[1]), duration: Number(e[2]) });
      start = undefined;
    }
  }
  // A trailing silence that runs to EOF has a start but no end line.
  if (start !== undefined) intervals.push({ start });
  return { available: true, intervals };
}

function parseBlack(stderr: string): Array<{ start: number; end: number; duration: number }> {
  const events: Array<{ start: number; end: number; duration: number }> = [];
  const re = /black_start:(-?\d+(?:\.\d+)?)\s+black_end:(-?\d+(?:\.\d+)?)\s+black_duration:(-?\d+(?:\.\d+)?)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stderr)) !== null) {
    events.push({ start: Number(match[1]), end: Number(match[2]), duration: Number(match[3]) });
  }
  return events;
}

function sameFps(a: Fps, b: Fps): boolean {
  return a.numerator * b.denominator === b.numerator * a.denominator;
}

/** True when two equally-sized RGB24 frames are the same "effectively unchanged" picture. */
function samePicture(a: Uint8Array, b: Uint8Array): boolean {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] > b[i] ? a[i] - b[i] : b[i] - a[i];
    if (d > REPEAT_MAX_ABS_DIFF) return false;
    sum += d;
  }
  return sum / a.length <= REPEAT_MEAN_ABS_DIFF;
}

/**
 * Detect runs of consecutive frames whose picture is effectively unchanged.
 *
 * Strategy and cost: the movie is decoded exactly once, forced to a fixed
 * `REPEAT_SAMPLE x REPEAT_SAMPLE` RGB24 raster, and streamed frame-by-frame as
 * raw pixels (`-fps_mode passthrough`, so no frames are duplicated or dropped
 * and the decoded count can be checked against the probed count). Each frame is
 * compared to its predecessor with a bounded mean/max per-channel tolerance
 * (`samePicture`) — no per-frame images are written to disk and memory stays
 * O(one frame). The comparison is a pure function of the decoded bytes, so the
 * same input yields byte-identical output. A decode that does not yield exactly
 * `expectedFrames` frames throws rather than silently reporting "no repeats",
 * so this fact can never mask a decode failure.
 */
export async function detectRepeatedFrames(input: string, expectedFrames: number): Promise<RepeatedFramesResult> {
  const sampleWidth = REPEAT_SAMPLE;
  const sampleHeight = REPEAT_SAMPLE;
  const frameBytes = sampleWidth * sampleHeight * 3;
  const spans: RepeatedFrameSpan[] = [];
  let previous: Uint8Array | undefined;
  let spanStart: number | undefined;
  let spanEnd: number | undefined;
  let analysedFrames = 0;

  const flush = (): void => {
    if (spanStart !== undefined && spanEnd !== undefined)
      spans.push({ startFrame: spanStart, endFrame: spanEnd, lengthFrames: spanEnd - spanStart + 1 });
    spanStart = undefined;
    spanEnd = undefined;
  };

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      [
        ...GLOBAL_ARGS,
        '-i',
        input,
        '-vf',
        `scale=${sampleWidth}:${sampleHeight}:flags=lanczos,format=rgb24`,
        '-fps_mode',
        'passthrough',
        '-f',
        'rawvideo',
        ...OUTPUT_THREADS,
        '-',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let pending: Uint8Array = Buffer.alloc(0);
    let stderr = '';
    let timedOut = false,
      settled = false,
      cancelTermination: (() => void) | undefined;
    let timer: NodeJS.Timeout;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cancelTermination?.();
      callback();
    };
    const fail = (message: string): void => settle(() => reject(new Error(redact(message))));
    // Same finite termination rule as `runFfmpeg`: SIGTERM, then SIGKILL after a
    // finite grace, settling as a failure even if the decode later exits 0.
    const terminate = (): void => {
      if (cancelTermination) return;
      cancelTermination = terminateChild(child, commandKillGraceMs(), () =>
        fail('review: repeated-frame analysis did not exit after SIGKILL'),
      );
    };
    timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, 120_000);
    child.stdout.on('data', (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let offset = 0;
      while (pending.length - offset >= frameBytes) {
        const frame = pending.subarray(offset, offset + frameBytes);
        offset += frameBytes;
        if (previous && samePicture(previous, frame)) {
          if (spanStart === undefined) {
            spanStart = analysedFrames - 1;
            spanEnd = analysedFrames;
          } else spanEnd = analysedFrames;
        } else {
          flush();
        }
        previous = Buffer.from(frame);
        analysedFrames++;
      }
      if (offset > 0) pending = pending.subarray(offset);
    });
    child.stderr.on('data', data => {
      stderr = (stderr + String(data)).slice(-1_000_000);
    });
    child.on('error', error => settle(() => reject(error)));
    child.on('close', code => {
      settle(() => {
        if (timedOut) {
          reject(new Error(redact(`review: repeated-frame analysis timed out after 120000ms: ${stderr.slice(-400)}`)));
          return;
        }
        if (code !== 0) {
          reject(
            new Error(redact(`review: repeated-frame analysis failed (ffmpeg exited ${code}): ${stderr.slice(-400)}`)),
          );
          return;
        }
        flush();
        if (analysedFrames !== expectedFrames) {
          reject(
            new Error(
              `review: repeated-frame analysis decoded ${analysedFrames} frames but the final has ${expectedFrames}`,
            ),
          );
          return;
        }
        resolve();
      });
    });
  });

  const repeatedFrames = spans.reduce((sum, span) => sum + (span.lengthFrames - 1), 0);
  return {
    method: REPEAT_METHOD,
    sampleWidth,
    sampleHeight,
    toleranceMaxAbsDiff: REPEAT_MAX_ABS_DIFF,
    toleranceMeanAbsDiff: REPEAT_MEAN_ABS_DIFF,
    analysedFrames,
    spanCount: spans.length,
    repeatedFrames,
    spans,
  };
}

// ---------------------------------------------------------------------------
// reviewBuild
// ---------------------------------------------------------------------------

/**
 * Produce a traceable review of a succeeded Build: contact sheet, per-cut seam
 * strips and a JSON technical report. Defaults to the newest succeeded build
 * that has a result. All output is written under `.viscraft/reviews/<buildId>/`;
 * the project, its artifacts and the active result are never modified.
 */
export async function reviewBuild(root: string, buildId?: string): Promise<ReviewResult> {
  const builds = await readBuilds(root);
  let build: BuildRecord | undefined;
  if (buildId) {
    build = builds.find(candidate => candidate.id === buildId);
    if (!build) throw new Error(`review: no build record ${buildId} in this project`);
  } else {
    // `review` analyses a FILM timeline. A still-image Build has no timeline to
    // sample and must not be presented as a video review, so the default skips
    // image-target Builds and names the absence honestly.
    build = builds.find(
      candidate => candidate.status === 'succeeded' && candidate.result && candidate.target === undefined,
    );
    if (!build)
      throw new Error(
        'review: no successful build with a film result to review (image targets are stills; render one with `viscraft image`)',
      );
  }
  if (build.target !== undefined) {
    throw new Error(
      `review: build ${build.id} is a still-image Build for target ${build.target}; review analyses a film timeline and does not describe a still`,
    );
  }
  if (build.status !== 'succeeded' || !build.result) {
    throw new Error(
      `review: build ${build.id} is ${build.status}${build.error ? ` (${build.error})` : ''} and has no result to review`,
    );
  }
  const result = build.result;

  // The timeline comes from the frozen snapshot, never from the live project.
  // `buildProject` records the frozen Project metadata as
  // `.viscraft/snapshots/<id>.project.json` (side-by-side with `<id>.inputs.json`),
  // deliberately OUTSIDE the per-build snapshot file tree so a user resource
  // named `project.json` cannot collide with it. We therefore read the flat
  // metadata path only — never `<id>/project.json`, which may be a frozen code
  // resource rather than the Project.
  const snapshotFile = await resolveProjectPath(root, `.viscraft/snapshots/${build.id}.project.json`);
  if (!(await fileExists(snapshotFile))) {
    throw new Error(
      `review: build ${build.id} has no frozen project metadata at .viscraft/snapshots/${build.id}.project.json`,
    );
  }
  const snapshotProject = requireFilmProject(validateProject(JSON.parse(await readFile(snapshotFile, 'utf8'))));

  // Verify the snapshot's own integrity when the build recorded the input hash map.
  let snapshotHashVerified: boolean | undefined;
  const inputsFile = await resolveProjectPath(root, `.viscraft/snapshots/${build.id}.inputs.json`);
  if (await fileExists(inputsFile)) {
    const inputs = SnapshotInputsSchema.parse(JSON.parse(await readFile(inputsFile, 'utf8')));
    snapshotHashVerified = snapshotHashOf(snapshotProject, inputs.files, inputs.unavailable) === build.snapshotHash;
    if (!snapshotHashVerified) throw new Error(`review: frozen snapshot hash mismatch for build ${build.id}`);
  }

  // A Build record may retain unrelated outputs omitted by a portable
  // export. The result, Takes and all of their dependencies must still exist.
  const artifactsById = new Map(
    builds.flatMap(record => record.artifacts.map(artifact => [artifact.id, artifact] as const)),
  );
  const requiredArtifacts = new Set([result.artifact, ...build.takes.map(take => take.artifact)]);
  const pending = [...requiredArtifacts];
  while (pending.length) {
    const id = pending.pop()!;
    const artifact = artifactsById.get(id);
    if (!artifact) throw new Error(`review: required artifact ${id} is not registered`);
    for (const input of artifact.inputs)
      if (input.startsWith('artifact-') && !requiredArtifacts.has(input)) {
        requiredArtifacts.add(input);
        pending.push(input);
      }
  }
  const artifactChecks: Array<Record<string, unknown>> = [];
  const checkedArtifacts = new Map(build.artifacts.map(artifact => [artifact.id, artifact]));
  for (const id of requiredArtifacts) checkedArtifacts.set(id, artifactsById.get(id)!);
  for (const artifact of checkedArtifacts.values()) {
    const absolute = await resolveProjectPath(root, artifact.path);
    let exists = true;
    let actual: string | undefined;
    try {
      actual = await hashFile(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false;
      else throw error;
    }
    const hashMatches = exists && actual === artifact.sha256;
    artifactChecks.push({
      id: artifact.id,
      path: artifact.path,
      kind: artifact.kind,
      simulated: artifact.simulated,
      sha256: artifact.sha256,
      exists,
      hashMatches,
    });
    if (!hashMatches && (exists || requiredArtifacts.has(artifact.id)))
      throw new Error(
        `review: artifact ${artifact.id} failed verification (${exists ? 'content hash mismatch' : 'file missing'})`,
      );
  }

  // Per-Take audio fact: does each Take's file actually carry an audio stream?
  // A Take must be reviewable for picture AND sound together, so this is reported
  // as a plain fact — never a pass/fail verdict. It is probed from the file, not
  // read from the recorded `artifact.media` info: that record can be stale or
  // forged so it disagrees with the bytes, and a wrong `hasAudio` would mislead
  // the author. `recorded` still states whether the artifact carries recorded
  // media info at all, independently of the probed fact.
  //
  // An artifact is probed according to what it really is. A video artifact is
  // probed as picture (and its audio stream reported when present). An
  // **audio-only** artifact — for example a code-authored `sound` Source
  // rendered to a WAV Take — has no video stream at all, so it is probed as
  // audio and its real sample rate / channels / duration / sample count are
  // reported. Picture-only facts do not exist for such a Take and are never
  // fabricated for it.
  const takeAudio: Array<Record<string, unknown>> = [];
  let audioOnlyTakes = 0;
  for (const take of build.takes) {
    const artifact = checkedArtifacts.get(take.artifact) ?? artifactsById.get(take.artifact);
    if (!artifact) throw new Error(`review: Take ${take.id} references unregistered artifact ${take.artifact}`);
    const artifactPath = await resolveProjectPath(root, artifact.path);
    if (take.medium === 'sound') {
      // A sound Take runs on the SAMPLE clock and is delivered as audio only.
      // Its declared samples/sampleRate/channels and the probed facts are the
      // real facts; no picture frame count or FPS is invented for it.
      if (artifact.kind !== 'audio')
        throw new Error(`review: sound Take ${take.id} references ${artifact.kind} artifact ${artifact.id}`);
      const probed = await probeAudio(artifactPath);
      audioOnlyTakes++;
      takeAudio.push({
        id: take.id,
        medium: 'sound',
        source: take.source,
        asset: take.asset,
        artifact: take.artifact,
        samples: take.samples,
        sampleRate: take.sampleRate,
        channels: take.channels,
        simulated: take.simulated,
        recorded: artifact.media !== undefined,
        hasAudio: true,
        audioOnly: true,
        audio: {
          sampleRate: probed.sampleRate,
          channels: probed.channels,
          duration: probed.duration,
          samples: probed.samples,
        },
        pictureFacts:
          'omitted: this Take is audio-only (no video stream), so it contributes no picture, contact-sheet cell, cut seam, black-frame or repeated-frame fact',
      });
    } else {
      if (artifact.kind === 'audio')
        throw new Error(`review: picture Take ${take.id} references audio artifact ${artifact.id}`);
      const hasAudio = Boolean((await probeMedia(artifactPath)).audio);
      takeAudio.push({
        id: take.id,
        medium: 'picture',
        source: take.source,
        asset: take.asset,
        artifact: take.artifact,
        frames: take.frames,
        fps: take.fps,
        simulated: take.simulated,
        recorded: artifact.media !== undefined,
        hasAudio,
      });
    }
  }

  const finalArtifact = build.artifacts.find(artifact => artifact.id === result.artifact);
  if (!finalArtifact)
    throw new Error(`review: result artifact ${result.artifact} is not registered in build ${build.id}`);
  const finalPath = await resolveProjectPath(root, finalArtifact.path);

  const output = snapshotProject.composition.output;
  const expectedFrames = compositionFrames(snapshotProject);
  const actual = await probeMedia(finalPath);
  const framesMatch = actual.frames === expectedFrames;
  if (!framesMatch) {
    throw new Error(`review: final has ${actual.frames} frames but the frozen composition expects ${expectedFrames}`);
  }
  const fpsMatch = sameFps(actual.fps, output.fps);
  if (!fpsMatch)
    throw new Error(
      `review: final fps ${actual.fps.numerator}/${actual.fps.denominator} does not match the frozen output fps`,
    );

  // --- Timeline model from the frozen snapshot ---------------------------
  const placements = [...snapshotProject.composition.placements].sort(
    (a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id),
  );
  const endOf = (p: Placement): number => p.startFrame + (p.durationFrames ?? p.outFrame - p.inFrame);

  // A shot is an authoring grouping, NOT a continuous timeline interval: the
  // same shot may be placed more than once with other shots in between. Report
  // each unique shot with the ids of the placements that reference it, so no
  // single start/end span falsely implies one uninterrupted interval.
  const shotOrder: string[] = [];
  const shotPlacements = new Map<string, string[]>();
  for (const placement of placements) {
    const ids = shotPlacements.get(placement.shot);
    if (ids) ids.push(placement.id);
    else {
      shotPlacements.set(placement.shot, [placement.id]);
      shotOrder.push(placement.shot);
    }
  }

  // Candidate-Take comparison. `plan.candidates` makes the Build render every
  // candidate Source's Take without composing them all; we compare those Takes
  // and derive which one the frozen composition actually uses for the shot.
  const candidatePlan = build.plan.candidates ?? [];
  const takesBySource = new Map<string, Take>();
  const takesByAsset = new Map<string, Take>();
  for (const take of build.takes) {
    if (take.source !== undefined && !takesBySource.has(take.source)) takesBySource.set(take.source, take);
    if (take.asset !== undefined && !takesByAsset.has(take.asset)) takesByAsset.set(take.asset, take);
  }
  const selectedTakeIdsByShot = new Map<string, Set<string>>();
  for (const placement of placements) {
    const ids = selectedTakeIdsByShot.get(placement.shot) ?? new Set<string>();
    if (placement.take) ids.add(placement.take);
    else if (placement.source) {
      const take = takesBySource.get(placement.source);
      if (take) ids.add(take.id);
    } else if (placement.asset) {
      const take = takesByAsset.get(placement.asset);
      if (take) ids.add(take.id);
    }
    selectedTakeIdsByShot.set(placement.shot, ids);
  }

  const lastFrame = expectedFrames - 1;
  const clampFrame = (frame: number): number => Math.max(0, Math.min(frame, lastFrame));

  // One contact row per placement, sampled strictly inside that placement's own
  // half-open [startFrame, endFrame). Aggregating by shot would sample a frame
  // that belongs to a different placement whenever a shot recurs.
  const contactCells: Array<{ placement: string; shot: string; position: 'first' | 'middle' | 'last'; frame: number }> =
    [];
  for (const placement of placements) {
    const first = clampFrame(placement.startFrame);
    const last = clampFrame(endOf(placement) - 1);
    const middle = clampFrame(placement.startFrame + Math.floor((last - first) / 2));
    contactCells.push({ placement: placement.id, shot: placement.shot, position: 'first', frame: first });
    contactCells.push({ placement: placement.id, shot: placement.shot, position: 'middle', frame: middle });
    contactCells.push({ placement: placement.id, shot: placement.shot, position: 'last', frame: last });
  }

  const cuts: Array<{ index: number; from: string; to: string; cutFrame: number; overlap: number; frames: number[] }> =
    [];
  for (let i = 1; i < placements.length; i++) {
    const cutFrame = placements[i].startFrame;
    const overlap = endOf(placements[i - 1]) - cutFrame;
    const frames = [cutFrame - 2, cutFrame - 1, cutFrame, cutFrame + 1].filter(f => f >= 0 && f < expectedFrames);
    if (frames.length === 0) continue;
    cuts.push({ index: cuts.length, from: placements[i - 1].id, to: placements[i].id, cutFrame, overlap, frames });
  }

  // Authored subtitles are timeline intervals too. Report their true ranges and
  // text so stills can be proofed against them; never invent a score or verdict.
  // A current snapshot may omit optional subtitles when none were authored.
  const subtitles = (snapshotProject.composition.subtitles ?? [])
    .slice()
    .sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id))
    .map(subtitle => ({
      id: subtitle.id,
      startFrame: subtitle.startFrame,
      endFrame: subtitle.endFrame,
      text: subtitle.text,
    }));

  // Beat/onset alignment FACTS (never a pass/fail). For every declared
  // transition boundary and every placement start we report the distance to the
  // nearest declared beat. A cut deliberately off the grid is a valid creative
  // choice, so an off-beat boundary is information, not a
  // defect. `toleranceFrames` is 1: a beat counts as landing on a boundary when
  // it falls inside that boundary frame's own one-frame sample window.
  const beats = (snapshotProject.composition.beats ?? []).slice().sort((a, b) => a.sample - b.sample);
  const samplesPerFrame = framesToSamples(1, output.fps, output.sampleRate, 'ceil');
  const nearestBeatAt = (sample: number): { id: string; sample: number } | null => {
    let best: { id: string; sample: number } | null = null;
    for (const beat of beats)
      if (best === null || Math.abs(beat.sample - sample) < Math.abs(best.sample - sample)) best = beat;
    return best;
  };
  const beatBoundaries: Array<Record<string, unknown>> = [];
  const recordBoundary = (kind: string, frame: number, ref: Record<string, string>): void => {
    const sample = framesToSamples(frame, output.fps, output.sampleRate, 'nearest');
    const nearest = nearestBeatAt(sample);
    const distanceSamples = nearest ? Math.abs(nearest.sample - sample) : null;
    beatBoundaries.push({
      kind,
      frame,
      sample,
      ...ref,
      nearestBeat: nearest,
      distanceSamples,
      distanceFrames: distanceSamples === null ? null : distanceSamples / samplesPerFrame,
      onBeat: distanceSamples !== null && distanceSamples < samplesPerFrame,
    });
  };
  for (const placement of placements)
    recordBoundary('placement-start', placement.startFrame, { placement: placement.id });
  for (const transition of snapshotProject.composition.transitions) {
    recordBoundary('transition-start', transition.startFrame, { from: transition.from, to: transition.to });
    recordBoundary('transition-end', transition.endFrame, { from: transition.from, to: transition.to });
  }
  const onBeatCount = beatBoundaries.filter(boundary => boundary.onBeat).length;
  const beatFact = {
    declared: beats.map(beat => ({
      id: beat.id,
      sample: beat.sample,
      frame: ptsToFrames(String(beat.sample), '0', { numerator: 1, denominator: output.sampleRate }, output.fps),
    })),
    toleranceFrames: 1,
    toleranceSamples: samplesPerFrame,
    boundaries: beatBoundaries,
    summary: {
      boundaries: beatBoundaries.length,
      onBeat: onBeatCount,
      offBeat: beatBoundaries.length - onBeatCount,
      note:
        beats.length === 0
          ? 'No beat grid is declared; every boundary is reported with a null nearest beat.'
          : 'Off-beat boundaries are reported as facts, not defects; an intentional cut off the beat grid is a valid creative choice.',
    },
  };

  // ---- Match-cut assertions as FACTS (never a verdict) -------------------
  // A `matchCut` is an author's declared correspondence between two placements.
  // This runtime cannot measure subject-identity similarity, so nothing here
  // scores, passes or fails a match. We report the declaration, the REAL cut
  // boundary in the frozen timeline, and the declared anchor frames mapped onto
  // the output timeline — as plain facts. A hard-cut Match Cut has
  // `overlapFrames === 0` (this is the canonical case and is why `matchCuts` is
  // a sibling of `transitions` rather than a transition kind).
  const placementById = new Map<string, Placement>(placements.map(placement => [placement.id, placement]));
  const matchCutFacts: Array<Record<string, unknown>> = [];
  for (const matchCut of snapshotProject.composition.matchCuts ?? []) {
    const fromPlacement = placementById.get(matchCut.from);
    const toPlacement = placementById.get(matchCut.to);
    if (!fromPlacement || !toPlacement) {
      matchCutFacts.push({
        from: matchCut.from,
        to: matchCut.to,
        subject: matchCut.subject,
        action: matchCut.action,
        declaredFromFrame: matchCut.fromFrame,
        declaredToFrame: matchCut.toFrame,
        resolved: false,
        note: 'declared placement is not present in the frozen timeline; boundary frames cannot be located',
      });
      continue;
    }
    const fromEnd = endOf(fromPlacement);
    const cutFrame = toPlacement.startFrame;
    const overlapFrames = fromEnd - cutFrame;
    // A declared anchor maps to an output frame through its own placement's
    // interval; report the raw position and whether the anchor is really inside
    // the placement it names (a structural fact, not a quality judgement).
    const fromAnchorOutputFrame = fromPlacement.startFrame + (matchCut.fromFrame - fromPlacement.inFrame);
    const toAnchorOutputFrame = toPlacement.startFrame + (matchCut.toFrame - toPlacement.inFrame);
    matchCutFacts.push({
      from: matchCut.from,
      to: matchCut.to,
      subject: matchCut.subject,
      action: matchCut.action,
      declaredFromFrame: matchCut.fromFrame,
      declaredToFrame: matchCut.toFrame,
      resolved: true,
      fromAnchorOutputFrame,
      toAnchorOutputFrame,
      fromAnchorInsidePlacement:
        matchCut.fromFrame >= fromPlacement.inFrame && matchCut.fromFrame < fromPlacement.outFrame,
      toAnchorInsidePlacement: matchCut.toFrame >= toPlacement.inFrame && matchCut.toFrame < toPlacement.outFrame,
      cutFrame,
      boundary: {
        fromEndFrame: fromEnd,
        toStartFrame: toPlacement.startFrame,
        overlapFrames,
        hardCut: overlapFrames === 0,
      },
      observation:
        'declared match assertion reported as a fact; no subject-similarity score is computed and no aesthetic pass/fail is given',
    });
  }

  const needed = new Set<number>();
  for (const cell of contactCells) needed.add(cell.frame);
  for (const cut of cuts) for (const f of cut.frames) needed.add(f);

  const layers = snapshotProject.composition.layers ?? [];
  for (const layer of layers) {
    const end = layer.startFrame + layer.outFrame - layer.inFrame;
    for (const frame of [layer.startFrame - 1, layer.startFrame, end - 1, end])
      if (frame >= 0 && frame < expectedFrames) needed.add(frame);
  }

  // --- Render review products in a private per-run staging directory --------
  // Two reviews of the same build may run concurrently: they must not share
  // frame paths or expose partial output. Stage everything under a unique work
  // directory inside the review folder (a real directory; never a symlink),
  // then publish each finished product with an atomic rename so a reader only
  // ever sees complete files. Published products may be refreshed for the same
  // build, but inputs (project, result, artifacts) are never written.
  const reviewDirRel = `.viscraft/reviews/${build.id}`;
  const reviewDir = await resolveProjectPath(root, reviewDirRel);
  await mkdir(reviewDir, { recursive: true });
  const workDir = await mkdtemp(path.toNamespacedPath(path.join(reviewDir, '.frames-')));

  const contactSheetRel = `${reviewDirRel}/contact-sheet.png`;
  const seams: string[] = [];
  try {
    const frameMap = await extractFrames(finalPath, [...needed], workDir);
    const fileFor = (frame: number): string => {
      const file = frameMap.get(frame);
      if (!file) throw new Error(`review: frame ${frame} was not available for tiling`);
      return file;
    };

    const contactStaged = path.join(workDir, 'contact-sheet.png');
    await tileFrames(
      contactCells.map(cell => fileFor(cell.frame)),
      3,
      contactStaged,
    );
    await publishFile(contactStaged, await resolveProjectPath(root, contactSheetRel));

    const seamRecords: Array<Record<string, unknown>> = [];
    for (const cut of cuts) {
      const name = `seam-${String(cut.index).padStart(2, '0')}.png`;
      const rel = `${reviewDirRel}/${name}`;
      const files = cut.frames.map(frame => fileFor(frame));
      const staged = path.join(workDir, name);
      await tileFrames(files, files.length, staged);
      await publishFile(staged, await resolveProjectPath(root, rel));
      seams.push(rel);
      seamRecords.push({
        index: cut.index,
        from: cut.from,
        to: cut.to,
        cutFrame: cut.cutFrame,
        overlapFrames: cut.overlap,
        sampledFrames: cut.frames,
        columns: files.length,
        strip: rel,
      });
    }

    const layerRecords: Array<Record<string, unknown>> = [];
    for (const [index, layer] of layers.entries()) {
      const end = layer.startFrame + layer.outFrame - layer.inFrame;
      const sampledFrames = [
        ...new Set(
          [layer.startFrame - 1, layer.startFrame, end - 1, end].filter(frame => frame >= 0 && frame < expectedFrames),
        ),
      ];
      const relative = `${reviewDirRel}/layer-${String(index).padStart(2, '0')}.png`;
      const staged = path.join(workDir, `layer-${index}.png`);
      await tileFrames(sampledFrames.map(fileFor), sampledFrames.length, staged);
      await publishFile(staged, await resolveProjectPath(root, relative));
      layerRecords.push({ ...layer, endFrame: end, sampledFrames, strip: relative });
    }

    // Per-shot candidate-Take comparison strips (only when the Build declared
    // candidates). Reuses the same private staging + atomic publish path.
    const candidateComparisons = await renderCandidateComparisons(
      root,
      reviewDirRel,
      workDir,
      candidatePlan,
      takesBySource,
      selectedTakeIdsByShot,
      checkedArtifacts,
    );

    // --- Technical audio / video analysis (facts, not aesthetic verdicts) ---
    let loudness: LoudnessResult;
    let silence: SilenceResult;
    if (actual.audio) {
      const stderr = await runFfmpeg([
        ...GLOBAL_ARGS,
        '-i',
        finalPath,
        '-vn',
        '-af',
        'silencedetect=noise=-50dB:d=0.1,ebur128=peak=true:framelog=quiet',
        '-f',
        'null',
        ...OUTPUT_THREADS,
        '-',
      ]);
      loudness = parseLoudness(stderr);
      silence = parseSilence(stderr);
    } else {
      const reason = 'final artifact has no audio stream';
      loudness = { available: false, reason };
      silence = { available: false, intervals: [], reason };
    }

    const blackStderr = await runFfmpeg([
      ...GLOBAL_ARGS,
      '-i',
      finalPath,
      '-vf',
      'blackdetect=d=0.1:pix_th=0.10',
      '-an',
      '-f',
      'null',
      ...OUTPUT_THREADS,
      '-',
    ]);
    const blackFrames = parseBlack(blackStderr);

    // Repeated-frame / frozen-span fact. A separate single decode pass at a
    // fixed small raster (cheap and deterministic); it reports a held picture
    // as a fact, never as a defect, and throws on a decode mismatch so a
    // failure can never masquerade as "no repeats".
    const repeatedFrameSpans = await detectRepeatedFrames(finalPath, actual.frames);

    // --- Audio clip truncation facts --------------------------------------
    // `compositionFrames` derives the programme length from picture, so a music
    // Asset declared longer than the programme is cut at the end with no signal,
    // and a revision that SHORTENS the picture can silently cut a song's tail.
    // Report, per audio clip, the asset's real audio duration in output samples,
    // the samples the clip actually uses and whether the programme end truncates
    // it. This is a fact, never a verdict (an intentional cut or stinger is a
    // valid choice). `compositionFrames` semantics are deliberately unchanged.
    const totalSamples = framesToSamples(expectedFrames, output.fps, output.sampleRate, 'ceil');
    const audioClipFacts: Array<Record<string, unknown>> = [];
    for (const clip of snapshotProject.composition.audio) {
      const soundSource =
        clip.kind === 'source' ? snapshotProject.sources.find(source => source.id === clip.source) : undefined;
      const usedSamples =
        clip.kind === 'source'
          ? soundSource && soundSource.kind === 'browser' && soundSource.output === 'sound'
            ? // The page renders its own SAMPLE length at its own native rate; the
              // clip consumes that same span measured on the output sample clock.
              Math.ceil((soundSource.durationSamples * output.sampleRate) / soundSource.sampleRate)
            : 0
          : clip.durationSamples;
      let assetSamples: number | null = null;
      let asset: string | null = null;
      if (clip.kind === 'asset') {
        const found = snapshotProject.assets.find(candidate => candidate.id === clip.asset);
        if (!found) throw new Error(`review: audio clip ${clip.id} references unknown asset ${clip.asset}`);
        asset = found.id;
        const seconds = await audioDurationSeconds(await resolveProjectPath(root, found.path));
        assetSamples = seconds === undefined ? null : Math.round(seconds * output.sampleRate);
      }
      const endSample = clip.startSample + usedSamples;
      audioClipFacts.push({
        id: clip.id,
        kind: clip.kind,
        ...(clip.bus !== undefined ? { bus: clip.bus } : {}),
        asset,
        assetSamples,
        usedSamples,
        startSample: clip.startSample,
        endSample,
        programmeSamples: totalSamples,
        truncatedByProgrammeEnd: endSample > totalSamples,
      });
    }

    // --- Kept-audio extension facts ----------------------------------------
    // The kept audio body is trimmed from the ORIGINAL Take artifact
    // (`take.artifact`) over the placement's ORIGINAL source range
    // `[inFrame, outFrame]`, with `inFrame` mapping to `takeInSample`; the
    // sample clock is the original artifact's, regardless of any retiming/speed
    // change (a retime retimes the PICTURE; it never invents audio samples that
    // the original Take did not have). A J-cut (`audioLeadSamples`) reads the
    // Take's own pre-roll BEFORE `inFrame`; an L-cut (`audioTailSamples`) reads
    // past the body end `inFrame + (outFrame - inFrame)` = `outFrame`. When a
    // declared extension reaches past the Take's own available audio the mixer
    // adds NO synthesized silence (it simply has no samples there). That
    // shortfall is reported here as a fact naming the placement, the requested
    // extension and the Take's real available samples, rather than being padded
    // silently.
    const keptAudioFacts: Array<Record<string, unknown>> = [];
    for (const placement of placements) {
      if (placement.audio !== 'keep') continue;
      const lead = placement.audioLeadSamples ?? 0;
      const tail = placement.audioTailSamples ?? 0;
      if (lead === 0 && tail === 0) continue;
      const take = placement.take
        ? build.takes.find(candidate => candidate.id === placement.take)
        : placement.source
          ? takesBySource.get(placement.source)
          : placement.asset
            ? takesByAsset.get(placement.asset)
            : undefined;
      if (!take) continue;
      // The kept body is a PICTURE placement range read on the Take's own frame
      // clock. A sound Take has no frame clock at all, so it cannot be the body
      // of a placed picture interval.
      if (take.medium !== 'picture')
        throw new Error(`review: placement ${placement.id} keeps audio from sound Take ${take.id}`);
      const artifact = checkedArtifacts.get(take.artifact) ?? artifactsById.get(take.artifact);
      if (!artifact) continue;
      const takeSeconds = await audioDurationSeconds(await resolveProjectPath(root, artifact.path));
      const takeAudioSamples = takeSeconds === undefined ? 0 : Math.round(takeSeconds * output.sampleRate);
      const takeInSample = framesToSamples(placement.inFrame, take.fps, output.sampleRate, 'nearest');
      // The body length is the ORIGINAL source range, not `durationFrames`
      // (which is the retimed PICTURE length). Using a retimed length would
      // compute the tail's real overrun against a body the mixer never reads.
      // The body span is measured on the SAME Take frame clock as `takeInSample`
      // (the kept body, the J/L-cut handles and this report share one clock), so
      // a Take whose fps differs from the composition is measured correctly.
      const bodyFrames = placement.outFrame - placement.inFrame;
      const bodyEndSample = takeInSample + framesToSamples(bodyFrames, take.fps, output.sampleRate, 'nearest');
      const requestedStartSample = takeInSample - lead;
      const requestedEndSample = bodyEndSample + tail;
      const leadUnderrunSamples = Math.max(0, -requestedStartSample);
      const tailOverrunSamples = Math.max(0, requestedEndSample - takeAudioSamples);
      keptAudioFacts.push({
        placement: placement.id,
        take: take.id,
        artifact: take.artifact,
        declaredLeadSamples: lead,
        declaredTailSamples: tail,
        takeInSample,
        takeAudioSamples,
        requestedStartSample,
        requestedEndSample,
        leadUnderrunSamples,
        tailOverrunSamples,
        beyondTakeAudio: leadUnderrunSamples > 0 || tailOverrunSamples > 0,
      });
    }

    const simulated = Boolean(result.simulated);
    const reportRel = `${reviewDirRel}/report.json`;
    const report = {
      schema: 'viscraft-review/1',
      build: build.id,
      revision: build.revision,
      snapshotHash: build.snapshotHash,
      snapshotHashVerified: snapshotHashVerified ?? null,
      status: build.status,
      startedAt: build.startedAt,
      finishedAt: build.finishedAt ?? null,
      simulated,
      simulatedArtifacts: build.artifacts.filter(artifact => artifact.simulated).map(artifact => artifact.id),
      project: { id: snapshotProject.id, title: snapshotProject.title },
      output: {
        width: output.width,
        height: output.height,
        fps: output.fps,
        sampleRate: output.sampleRate,
        channels: output.channels,
      },
      timeline: {
        expectedFrames,
        // A shot is not a continuous interval (it may be placed repeatedly), so
        // report each unique shot with the placements that reference it instead
        // of a single start/end span. Concrete geometry lives in `placements`.
        shots: shotOrder.map(shot => ({ shot, placementIds: shotPlacements.get(shot)! })),
        placements: placements.map(placement => ({
          id: placement.id,
          shot: placement.shot,
          inFrame: placement.inFrame,
          outFrame: placement.outFrame,
          startFrame: placement.startFrame,
          audio: placement.audio,
          ...(placement.durationFrames !== undefined ? { durationFrames: placement.durationFrames } : {}),
        })),
        subtitles,
        layers: layerRecords,
        cuts: seamRecords,
        contactSheetCells: contactCells,
      },
      final: {
        artifact: finalArtifact.id,
        path: finalArtifact.path,
        sha256: finalArtifact.sha256,
        probe: actual,
        conformance: {
          framesMatch,
          fpsMatch,
          widthMatch: actual.width === output.width,
          heightMatch: actual.height === output.height,
          audioMatch:
            Boolean(actual.audio) &&
            actual.audio!.sampleRate === output.sampleRate &&
            actual.audio!.channels === output.channels,
        },
      },
      artifacts: artifactChecks,
      // Non-blocking browser capture diagnostics recorded by this Build, per
      // operation. Plain technical facts (an upscaled canvas buffer, a canvas
      // aspect that disagrees with its display, a declared-but-unavailable font)
      // — never a pass/fail verdict and never an aesthetic score. Empty when the
      // Build recorded none.
      diagnostics: (build.diagnostics ?? []).map(diagnostic => ({
        operation: diagnostic.operation,
        code: diagnostic.code,
        message: diagnostic.message,
        detail: diagnostic.detail,
      })),
      // Every Take with a plain fact about whether its artifact declares audio,
      // so a Take is reviewed for picture and sound together (never a verdict).
      takes: takeAudio,
      // Per kept `audio: 'keep'` placement that declares a J-cut lead or L-cut
      // tail: the Take's real available audio vs the requested extension. A
      // shortfall means the mixer added no synthesized silence there.
      keptAudio: keptAudioFacts,
      audio: {
        expected: { sampleRate: output.sampleRate, channels: output.channels },
        actual: actual.audio ?? null,
        // Per audio clip: the asset's real duration in samples, the samples the
        // clip uses and whether the programme end truncates it (a fact).
        clips: audioClipFacts,
        loudness,
        silence,
      },
      video: { blackFrames, repeatedFrameSpans },
      beats: beatFact,
      // Authored Match-Cut assertions reported as facts: the declaration, the
      // real cut boundary and the declared anchor frames mapped to the output
      // timeline. Never a similarity score and never a pass/fail verdict.
      matchCuts: matchCutFacts,
      contactSheet: contactSheetRel,
      seams,
      candidateComparisons,
      observation: OBSERVATION,
      limitations: [
        'Contact sheet and seam strips are extracted stills for visual inspection; sampling three frames per placement and four frames per cut does not measure continuity, motion, acting or aesthetic quality.',
        actual.audio
          ? 'Audio was measured numerically (EBU R128 integrated loudness / true peak and silence intervals); no subjective listening review was performed.'
          : 'No audio stream was available to measure; no listening review was performed.',
        'Loudness, silence and black-frame results are technical facts, not an aesthetic pass/fail verdict. Intended pauses or black frames are not automatically defects.',
        'Repeated-frame spans are a technical fact, not a defect: designed holds, stills and held frames are legitimate creative choices. Detection uses a fixed-size sampled picture and a bounded tolerance, so a nearly-static slow ramp may or may not register and must not be read as a quality verdict.',
        'Beat/onset alignment reports the distance from each declared boundary to the nearest declared beat. A boundary that does not land on a beat is a fact, not a failure: cutting off the beat grid can be deliberate.',
        ...(matchCutFacts.length > 0
          ? [
              'A `matchCut` declaration is an author assertion reported as a fact (see `matchCuts`): the runtime cannot compute subject-identity similarity, so no match score and no pass/fail verdict is produced — only the declared anchors, the real boundary frames and whether each anchor lies inside the placement it names.',
            ]
          : []),
        "Per-clip audio durations and truncation are measured facts (see `audio.clips`): a clip whose used samples reach past the programme end is cut there, which may be intended or may silently clip a longer song's tail.",
        ...(keptAudioFacts.some(fact => fact.beyondTakeAudio === true)
          ? [
              "A declared J-cut lead / L-cut tail reaches past the Take's own audio for at least one placement (see `keptAudio`); the mixer adds NO synthesized silence there and the shortfall is reported rather than padded.",
            ]
          : []),
        ...(audioOnlyTakes > 0
          ? [
              `${audioOnlyTakes} Take(s) are audio-only (no video stream; see the \`takes\` entries marked \`audioOnly\`) and are reported with their real audio facts only; no picture fact (contact-sheet cell, cut seam, black-frame or repeated-frame span) is fabricated for them.`,
            ]
          : []),
        ...(build.diagnostics && build.diagnostics.length > 0
          ? [
              `Browser capture diagnostics (see \`diagnostics\`) are non-blocking technical facts: ${[...new Set(build.diagnostics.map(diagnostic => diagnostic.code))].join(', ')}. They flag risks such as an upscaled canvas backing buffer, a canvas aspect not synced to its display, or a declared web font that is not available; whether the result is acceptable is a creative decision, not a verdict this report makes.`,
            ]
          : []),
      ],
    };
    const reportStaged = path.join(workDir, 'report.json');
    await atomicJson(reportStaged, report);
    await publishFile(reportStaged, await resolveProjectPath(root, reportRel));

    return {
      build: build.id,
      simulated,
      contactSheet: contactSheetRel,
      seams,
      report: reportRel,
      candidateComparisons,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
