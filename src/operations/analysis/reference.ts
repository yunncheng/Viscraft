import { escapeFilterValue } from '../../backends/media/filter-escape.js';
// Reference analysis control plane.
//
// `analyzeReference` inspects a piece of private reference material (a local,
// project-relative video) and derives a timestamp-truthful, heuristic report a
// host Agent can use to re-author a *new* project: where the source clock sits,
// how source PTS map onto the target composition frame rate, and where FFmpeg
// scene-score heuristics suggest cut candidates.
//
// Frame spaces (deliberately distinct):
//  - `frames[].index`, `cuts[].sourceFrame` and `reviewFrames[].sourceFrame` are
//    source *decoded frame indices*, used to address the original material.
//  - `frames[].outputFrame` and `cuts[].outputFrame` are exact mappings onto the
//    target composition timeline (via shared `ptsToFrames`, half-up).
//  - `segments[].startFrame/endFrame` tile the *output* timeline [0, mappedEnd);
//    the timeline generator consumes them directly at `report.fps`.
//
// Boundaries enforced here:
//  - The reference stays *unregistered material*. Analysis never registers an
//    Asset, mutates the Project, or writes outside a fresh `.viscraft/references/`
//    run directory (published reports are never overwritten).
//  - The report is a *derived artifact*, not a reconstruction of the original
//    edit/project. Output-frame mapping resamples source timing; a flat video is
//    never claimed to be editable source.
//  - Cut scores are FFmpeg scene-score heuristics, not semantic or editorial
//    truth; no motion / pose / depth / identity / audio perception is claimed.
//  - Decoded PTS is the authority. Frames are mapped through the shared
//    `ptsToFrames` rational conversion, never through floating-point seconds.
//
// Verified ffprobe/ffmpeg behaviour this module relies on (ffmpeg 6.1.x):
//  - `ffprobe -show_frames ... frame=best_effort_timestamp,pkt_duration,duration`
//    reports integer ticks in the video stream's `time_base`; on variable
//    frame-rate sources `pkt_duration`/`duration` are reported as N/A, leaving
//    only `best_effort_timestamp`. Per-frame durations then come from PTS deltas
//    and the source end uses the documented average-frame-rate fallback.
//  - `metadata=mode=print:key=lavfi.scene_score:file=<path>` prints one
//    `frame:<n> pts:<t>` line plus one `lavfi.scene_score=<v>` line per frame.
//    The filter graph rebases input timestamps, so absolute filter PTS may
//    differ from ffprobe's; alignment is verified by frame index and exact PTS
//    deltas rather than by absolute values.

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { FpsSchema, ReferenceReportSchema, requireComposition } from '../../core/schema.js';
import type { Fps, MediaInfo, Project, ReferenceReport } from '../../core/schema.js';
import { atomicJson, resolveProjectPath } from '../../shared/fs.js';
import { hashFile, stableHash } from '../../shared/hash.js';
import { runCommand } from '../../shared/process.js';
import { loadProject } from '../../project/project.js';
import { readBuilds } from '../../project/build-records.js';
import { probeMedia } from '../../backends/media/probe.js';
import { ptsToFrames } from '../../core/time.js';

/** Hard bound on decoded frames: analysis must never buffer a whole long movie. */
const MAX_FRAMES = 10_000;
/** Hard bound on extracted contact frames (deduplicated source frame indices). */
const MAX_REVIEW_FRAMES = 180;
const DEFAULT_THRESHOLD = 0.3;
const FFMPEG_GLOBAL = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-threads', '2', '-filter_threads', '1'];

export interface AnalyzeReferenceOptions {
  /** Target frame rate to map source PTS onto; defaults to the Project composition fps. */
  fps?: Fps;
  /** Scene-score cut threshold in [0, 1]; defaults to 0.30. */
  threshold?: number;
}

interface SourceFrame {
  /** 0-based index in decoded presentation order. */
  index: number;
  /** Integer PTS tick string in the stream time_base. */
  pts: string;
  /** Nearest output (composition-fps) frame, mapped half-up via `ptsToFrames`. */
  outputFrame: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/** Parse an ffprobe rational ("1/10240" or "25") into a reduced exact Fps. */
function parseRational(value: unknown): Fps | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const parts = value.split('/');
  const numerator = Number(parts[0]);
  const denominator = parts.length > 1 ? Number(parts[1]) : 1;
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) return undefined;
  if (numerator <= 0 || denominator <= 0) return undefined;
  const g = gcd(numerator, denominator);
  return { numerator: numerator / g, denominator: denominator / g };
}

/**
 * Read an integer tick field. Numeric values beyond `Number.MAX_SAFE_INTEGER`
 * cannot be trusted (they are already lossy) and are rejected; decimal strings
 * are converted exactly through BigInt.
 */
function ticksFromField(value: unknown): bigint | undefined {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error('Reference timing exceeds the safe integer range; refusing lossy numeric timestamps');
    }
    return BigInt(value);
  }
  if (typeof value === 'string') {
    if (!/^-?\d{1,24}$/.test(value)) return undefined;
    return BigInt(value);
  }
  return undefined;
}

/** Round a nonnegative BigInt fraction to nearest, halves up. */
function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('Internal rounding error: non-positive denominator');
  return numerator / denominator + (2n * (numerator % denominator) >= denominator ? 1n : 0n);
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
 * Read every decoded source frame's PTS (and the stream time base) and assert a
 * verifiable strictly-increasing clock. Returns the exact tick strings.
 */
export async function readSourceClock(
  file: string,
  expectedFrames: number,
): Promise<{
  timeBase: Fps;
  frames: SourceFrame[];
  originPts: string;
  endPts: string;
  durationMethod: ReferenceReport['clock']['durationMethod'];
  variableFrameRate: boolean;
}> {
  const streamProbe = await ffprobe('stream=time_base,avg_frame_rate', file, ['-select_streams', 'v:0']);
  const timeBase = parseRational(streamProbe.streams?.[0]?.time_base);
  if (!timeBase) throw new Error(`Could not determine a rational time base for reference ${file}`);

  const frameProbe = await ffprobe('frame=best_effort_timestamp,pkt_duration,duration', file, [
    '-select_streams',
    'v:0',
    '-show_frames',
  ]);
  const raw: Array<Record<string, unknown>> = Array.isArray(frameProbe.frames) ? frameProbe.frames : [];
  if (raw.length === 0) throw new Error(`Reference ${file} decoded no frames`);
  if (raw.length !== expectedFrames) {
    throw new Error(
      `Reference frame count mismatch: ffprobe counted ${expectedFrames} but decoded ${raw.length}; timestamps are not verifiable`,
    );
  }

  const rawFrames: Array<{ pts: bigint; ptsText: string; durationTicks?: bigint }> = [];
  let previous: bigint | undefined;
  for (const entry of raw) {
    const pts = ticksFromField(entry.best_effort_timestamp);
    if (pts === undefined)
      throw new Error('Reference frames are missing best_effort_timestamp; strictly increasing PTS cannot be verified');
    if (previous !== undefined && pts <= previous) {
      throw new Error(
        `Reference PTS is not strictly increasing at tick ${pts.toString()}; the source clock is not verifiable`,
      );
    }
    previous = pts;
    let durationTicks: bigint | undefined;
    for (const key of ['pkt_duration', 'duration'] as const) {
      const candidate = ticksFromField(entry[key]);
      if (candidate !== undefined && candidate > 0n) {
        durationTicks = candidate;
        break;
      }
    }
    rawFrames.push({ pts, ptsText: pts.toString(), durationTicks });
  }

  const originPts = rawFrames[0].ptsText;
  const lastFrame = rawFrames[rawFrames.length - 1];

  let endTicks: bigint;
  let durationMethod: ReferenceReport['clock']['durationMethod'];
  if (lastFrame.durationTicks !== undefined) {
    endTicks = lastFrame.pts + lastFrame.durationTicks;
    durationMethod = 'source-duration';
  } else {
    // Documented fallback: derive the final frame span from the reciprocal of
    // the stream's average frame rate, quantized to integer ticks.
    const avgFps = parseRational(streamProbe.streams?.[0]?.avg_frame_rate);
    if (!avgFps)
      throw new Error(
        'Reference final frame duration is unknown and no average frame rate is available for the fallback',
      );
    const numerator = BigInt(timeBase.denominator) * BigInt(avgFps.denominator);
    const denominator = BigInt(timeBase.numerator) * BigInt(avgFps.numerator);
    const ticks = roundHalfUp(numerator, denominator);
    endTicks = lastFrame.pts + (ticks > 0n ? ticks : 1n);
    durationMethod = 'frame-rate-fallback';
  }

  // Exact variable-frame-rate evidence: successive PTS deltas that are not all equal.
  let variableFrameRate = false;
  for (let i = 1; i < rawFrames.length; i++) {
    if (rawFrames[i].pts - rawFrames[i - 1].pts !== rawFrames[1].pts - rawFrames[0].pts) {
      variableFrameRate = true;
      break;
    }
  }

  return {
    timeBase,
    frames: rawFrames.map((frame, index) => ({ index, pts: frame.ptsText, outputFrame: 0 })),
    originPts,
    endPts: endTicks.toString(),
    durationMethod,
    variableFrameRate,
  };
}

/**
 * Parse the FFmpeg scene-score metadata stream and validate that its frame
 * indices and PTS deltas align exactly with the ffprobe frame list. Never
 * invents scores.
 */
async function readSceneScores(file: string, frames: SourceFrame[], workDir: string): Promise<number[]> {
  const metadataFile = nodePath.join(workDir, `scene-${randomUUID()}.txt`);
  const filter = `select=gte(scene\\,0),metadata=mode=print:key=lavfi.scene_score:file=${escapeFilterValue(metadataFile)}`;
  try {
    await runCommand('ffmpeg', [...FFMPEG_GLOBAL, '-i', file, '-vf', filter, '-an', '-f', 'null', '-']);
  } catch (error) {
    throw new Error(`Scene-score extraction failed for ${file}: ${messageOf(error)}`);
  }

  let text: string;
  try {
    text = await fs.readFile(metadataFile, 'utf8');
  } catch (error) {
    throw new Error(`Scene-score metadata was not produced for ${file}: ${messageOf(error)}`);
  } finally {
    await fs.rm(metadataFile, { force: true });
  }

  const scores: Array<number | undefined> = new Array(frames.length).fill(undefined);
  const metaPts = new Map<number, bigint>();
  let current = -1;
  for (const line of text.split('\n')) {
    const header = /^frame:(\d+)\s+pts:(-?\d{1,24})/.exec(line);
    if (header) {
      current = Number(header[1]);
      if (current >= 0 && current < frames.length) metaPts.set(current, BigInt(header[2]));
      continue;
    }
    const scoreLine = /^lavfi\.scene_score=([0-9.eE+-]+)/.exec(line);
    if (scoreLine && current >= 0 && current < frames.length) {
      const value = Number(scoreLine[1]);
      if (Number.isFinite(value)) scores[current] = value;
    }
  }

  // FFmpeg's filter graph rebases input timestamps, so absolute filter PTS may
  // differ from ffprobe's. Alignment is verified by frame index plus exact PTS
  // deltas, which must match the decoded PTS deltas one-for-one.
  for (let i = 0; i < frames.length; i++) {
    if (scores[i] === undefined || !metaPts.has(i)) {
      throw new Error(`Scene-score metadata is missing frame ${i}; scores cannot be trusted`);
    }
    if (i > 0) {
      const metaDelta = metaPts.get(i)! - metaPts.get(i - 1)!;
      const sourceDelta = BigInt(frames[i].pts) - BigInt(frames[i - 1].pts);
      if (metaDelta !== sourceDelta) {
        throw new Error(
          `Scene-score frame ${i} spacing does not align with ffprobe timestamps; scores cannot be trusted`,
        );
      }
    }
  }
  return scores as number[];
}

/** Extract a small PNG contact frame for one source frame index. */
async function extractFrame(source: string, index: number, destination: string): Promise<void> {
  await runCommand('ffmpeg', [
    ...FFMPEG_GLOBAL,
    '-i',
    source,
    '-vf',
    `select=eq(n\\,${index}),scale=320:-2`,
    '-fps_mode',
    'passthrough',
    '-frames:v',
    '1',
    destination,
  ]);
}

/**
 * Map an output-timeline frame back to the nearest source frame index using the
 * decoded `frames[].outputFrame` mapping (lower bound on ties). Never assumes
 * outputFrame === source index, which breaks under resampling/VFR.
 */
function nearestSourceIndex(frames: SourceFrame[], targetOutputFrame: number): number {
  let low = 0;
  let high = frames.length - 1;
  let best = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (frames[mid].outputFrame <= targetOutputFrame) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (best === -1) return 0;
  if (best + 1 < frames.length) {
    const below = targetOutputFrame - frames[best].outputFrame;
    const above = frames[best + 1].outputFrame - targetOutputFrame;
    if (above < below) return best + 1;
  }
  return best;
}

/**
 * Resolve provenance strictly by content hash. Path-only matches are never
 * trusted to establish identity: a registered record whose path equals the
 * reference but whose recorded hash differs is treated as a mismatch, and taint
 * is the union over *all* hash-matching records.
 */
export function provenance(
  project: Project,
  builds: Awaited<ReturnType<typeof readBuilds>>,
  relativePath: string,
  sha256: string,
): { origin: ReferenceReport['source']['origin']; simulated: boolean; hashMismatch: boolean } {
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
  const origin: ReferenceReport['source']['origin'] = matching.some(record => record.kind === 'asset')
    ? 'asset'
    : matching.some(record => record.kind === 'artifact')
      ? 'artifact'
      : 'material';
  const simulated = matching.some(record => record.simulated);
  const hashMismatch = records.some(record => record.path === relativePath && record.sha256 !== sha256);
  return { origin, simulated, hashMismatch };
}

/** Tile a positive half-open output interval [0, total) from sorted boundaries. */
function buildSegments(boundaries: number[], total: number): Array<{ startFrame: number; endFrame: number }> {
  const unique = [...new Set(boundaries)].sort((a, b) => a - b);
  const segments: Array<{ startFrame: number; endFrame: number }> = [];
  let start = 0;
  for (const boundary of unique) {
    if (boundary > start && boundary < total) {
      segments.push({ startFrame: start, endFrame: boundary });
      start = boundary;
    }
  }
  segments.push({ startFrame: start, endFrame: total });
  return segments;
}

/**
 * Analyze a local, project-relative reference video.
 *
 * Reads and validates the Project (never mutating or registering anything),
 * resolves the input safely, and returns a validated `ReferenceReport` written
 * atomically into a fresh `.viscraft/references/<key>/` run directory.
 */
export async function analyzeReference(
  root: string,
  relativePath: string,
  options: AnalyzeReferenceOptions = {},
): Promise<ReferenceReport> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(`Reference threshold must be a finite number in [0, 1], got ${String(options.threshold)}`);
  }

  const project = await loadProject(root);
  const fps = options.fps ? FpsSchema.parse(options.fps) : requireComposition(project).output.fps;

  // Safe, symlink-rejecting resolution; the report never touches authoring files.
  const absolute = await resolveProjectPath(root, relativePath);
  let sha256: string;
  try {
    sha256 = await hashFile(absolute);
  } catch (error) {
    throw new Error(`Reference material is not readable: ${relativePath} (${messageOf(error)})`);
  }

  const media: MediaInfo = await probeMedia(absolute);
  if (media.frames > MAX_FRAMES) {
    throw new Error(`Reference has ${media.frames} frames; analysis is capped at ${MAX_FRAMES} frames to bound memory`);
  }

  const clock = await readSourceClock(absolute, media.frames);
  const frames: SourceFrame[] = clock.frames.map(frame => ({
    index: frame.index,
    pts: frame.pts,
    outputFrame: ptsToFrames(frame.pts, clock.originPts, clock.timeBase, fps),
  }));
  const mappedEnd = ptsToFrames(clock.endPts, clock.originPts, clock.timeBase, fps);
  if (mappedEnd <= 0) {
    throw new Error(`Reference duration maps to zero output frames at ${fps.numerator}/${fps.denominator} fps`);
  }

  const workDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-reference-'));
  const referencesDir = await resolveProjectPath(root, '.viscraft/references');
  // Unique, option-sensitive run key so distinct analyses never collide or
  // overwrite a previously published report.
  const runKey = `${stableHash({ sha256, fps, threshold }).slice(0, 24)}-${randomUUID().slice(0, 8)}`;
  const relativeDir = `.viscraft/references/${runKey}`;
  const reportRelative = `${relativeDir}/report.json`;

  let staging: string | undefined;
  try {
    const scores = await readSceneScores(absolute, frames, workDir);

    // Cut candidates: score >= threshold, output boundaries mapped half-up.
    const rawCuts = [] as Array<{ sourceFrame: number; pts: string; outputFrame: number; score: number }>;
    for (let i = 1; i < frames.length; i++) {
      if (scores[i] >= threshold) {
        rawCuts.push({ sourceFrame: i, pts: frames[i].pts, outputFrame: frames[i].outputFrame, score: scores[i] });
      }
    }
    // Collapse cuts that land on the same output boundary and drop 0/end.
    const seenOutput = new Set<number>();
    const cuts = rawCuts.filter(cut => {
      if (cut.outputFrame <= 0 || cut.outputFrame >= mappedEnd) return false;
      if (seenOutput.has(cut.outputFrame)) return false;
      seenOutput.add(cut.outputFrame);
      return true;
    });

    // Segments tile the OUTPUT timeline the generator will author at report.fps.
    const segments = buildSegments(
      cuts.map(cut => cut.outputFrame),
      mappedEnd,
    );

    // Contact frames: map each output boundary back to a source index, plus both
    // sides of each detected cut.
    const wanted = new Set<number>();
    for (const segment of segments) {
      wanted.add(nearestSourceIndex(frames, segment.startFrame));
      wanted.add(
        nearestSourceIndex(frames, segment.startFrame + Math.floor((segment.endFrame - 1 - segment.startFrame) / 2)),
      );
      wanted.add(nearestSourceIndex(frames, segment.endFrame - 1));
    }
    for (const cut of cuts) {
      if (cut.sourceFrame - 1 >= 0) wanted.add(cut.sourceFrame - 1);
      wanted.add(cut.sourceFrame);
    }
    const candidates = [...wanted].filter(index => index >= 0 && index < frames.length).sort((a, b) => a - b);
    const limited = candidates.slice(0, MAX_REVIEW_FRAMES);

    await fs.mkdir(referencesDir, { recursive: true });
    const finalDir = await resolveProjectPath(root, relativeDir);
    try {
      await fs.access(finalDir);
      throw new Error(`Reference run directory ${relativeDir} already exists; refusing to overwrite published reports`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    staging = await fs.mkdtemp(nodePath.join(referencesDir, '.tmp-'));
    const reviewFrames: Array<{ sourceFrame: number; path: string }> = [];
    for (const index of limited) {
      const name = `frame-${String(index).padStart(6, '0')}.png`;
      await extractFrame(absolute, index, nodePath.join(staging, name));
      reviewFrames.push({ sourceFrame: index, path: `${relativeDir}/${name}` });
    }

    // Reject a reference that changed underneath the analysis.
    if ((await hashFile(absolute)) !== sha256) {
      throw new Error(`Reference input ${relativePath} changed during analysis; discard this report and retry`);
    }

    const limitations = [
      'Cut candidates come from FFmpeg scene-score heuristics over decoded video; they are suggestions, not semantic or editorial truth.',
      'This analysis performs no motion, pose, depth, identity, or audio perception and makes no claim about them.',
      'The reference stays unregistered material: this report is a derived artifact, not a reconstruction of the original project or edit.',
      'Output-frame segments and mappings resample the source timing at the requested composition fps; they do not recover the original edit or source project.',
    ];
    if (clock.variableFrameRate)
      limitations.push(
        'The source has variable frame-rate timestamps (unequal PTS deltas); output frames are nearest-frame resamples and summary segments follow the output timeline.',
      );
    if (clock.durationMethod === 'frame-rate-fallback')
      limitations.push(
        'The final frame reported no duration; the source end time was derived from the average frame rate and is approximate.',
      );
    if (!options.fps) limitations.push('Output fps defaulted to the current Project composition fps.');
    if (limited.length < candidates.length)
      limitations.push(
        `Review contact frames were capped at ${MAX_REVIEW_FRAMES} of ${candidates.length} candidate frames.`,
      );
    const source = provenance(project, await readBuilds(root), relativePath, sha256);
    if (source.origin === 'material')
      limitations.push(
        'Origin "material" with simulated=false means provenance is unknown; it is not evidence that the media came from a real generation provider.',
      );
    if (source.hashMismatch)
      limitations.push(
        "A registered record shares this material's path but its recorded sha256 differs; identity was not assumed and the source is treated as unregistered material.",
      );

    const report = ReferenceReportSchema.parse({
      schemaVersion: 1,
      kind: 'reference-analysis',
      source: { path: relativePath, sha256, simulated: source.simulated, origin: source.origin },
      fps,
      media,
      clock: {
        timeBase: clock.timeBase,
        originPts: clock.originPts,
        endPts: clock.endPts,
        durationMethod: clock.durationMethod,
        variableFrameRate: clock.variableFrameRate,
      },
      frames,
      cuts,
      segments,
      reviewFrames,
      threshold,
      reportPath: reportRelative,
      limitations,
    });

    // Commit the report and contact frames inside staging, then publish the whole
    // run directory atomically. Published reports are never deleted.
    await atomicJson(nodePath.join(staging, 'report.json'), report);
    await fs.rename(staging, finalDir);
    staging = undefined;

    return report;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}
