// Reference foreground-segmentation control plane.
//
// `analyzeReferenceForeground` segments moving foreground from a static
// background in a local, project-relative reference video and derives a
// timestamp-truthful, per-frame report a host Agent can consume. It uses
// temporal-median background subtraction plus 4-connected component analysis,
// running offline from decoded pixels without learned model weights.
//
// Spaces (deliberately distinct, shared with `reference.ts`/`reference-motion.ts`):
//  - `frames[].index` and `frames[].pts` are source *decoded frame* identity and
//    the original integer tick in the stream time base (ffprobe authority).
//  - `frames[].outputFrame` is the exact mapping onto the target composition
//    timeline (shared `ptsToFrames`, half-up); no clock arithmetic is duplicated.
//  - `centroid` is normalized to the *full source frame* (0..1); `bbox` is
//    integer full-source pixels. Neither is ever ROI-relative.
//
// What this IS: foreground-mask segmentation by background subtraction. What it
// is NOT (and never claims):
//  - It does not recognize, classify or identify what the foreground is. A blob
//    is a connected region of pixels that differ from the modelled background,
//    not a person, an object, a face or an identity.
//  - Pose estimation, identity/face recognition, depth estimation and 3D
//    reconstruction are outside this operation's capabilities.
//  - It does not edit, regenerate, continue or retime video. It measures pixels
//    and writes a derived report; the reference stays unregistered material.
//
// Boundaries enforced here: reads/validates the Project without mutating or
// registering anything; resolves the input safely; writes only inside a fresh
// `.viscraft/reference-foreground/<key>/` run directory; published reports are
// never overwritten. Decoded PTS is the authority and every output position is
// mapped through the shared rational conversion, never floating-point seconds.
//
// FFmpeg decoding invariants this module relies on:
//  - `ffmpeg -i <file> -map 0:v:0 -an -vf format=gray -fps_mode passthrough
//    -frames:v <n+1> -f rawvideo -pix_fmt gray <out>` decodes every frame to a
//    packed 8-bit grayscale buffer of exactly `width*height` bytes per frame.
//    Raw bytes cannot travel through `runCommand`'s string stdout, so the decode
//    is written to a temporary *file* first, and `-frames:v <n+1>` bounds growth.

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { z } from 'zod';

import { FpsSchema, MediaInfoSchema, RelativePath, requireComposition } from '../../core/schema.js';
import type { Fps } from '../../core/schema.js';
import { atomicJson, resolveProjectPath } from '../../shared/fs.js';
import { hashFile, stableHash } from '../../shared/hash.js';
import { runCommand } from '../../shared/process.js';
import { loadProject } from '../../project/project.js';
import { readBuilds } from '../../project/build-records.js';
import { probeMedia } from '../../backends/media/probe.js';
import { provenance, readSourceClock } from './reference.js';
import { ptsToFrames } from '../../core/time.js';

/** Hard bound on decoded frames: segmentation must never buffer a long movie. */
const MAX_FRAMES = 600;
/** Hard bound on one decoded frame, so the component label buffer stays small. */
const MAX_PIXELS_PER_FRAME = 640 * 360;
/** Hard bound on the whole grayscale decode buffer (background needs the clip). */
const MAX_GRAY_BYTES = 64 * 1024 * 1024;
/** Absolute-difference above which a pixel is foreground, in 8-bit gray levels. */
const DEFAULT_THRESHOLD = 24;
/** Minimum largest-blob area (pixels) for a frame to count as present. */
const DEFAULT_MIN_AREA = 12;
const FFMPEG_GLOBAL = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-threads', '2', '-filter_threads', '1'];
const PT = z.string().regex(/^-?\d{1,24}$/);

export interface AnalyzeReferenceForegroundOptions {
  /** Absolute per-pixel gray difference in 1..255 above which a pixel is foreground; default 24. */
  threshold?: number;
  /** Minimum largest connected foreground blob (in pixels) to count as present; default 12. */
  minArea?: number;
  /** Target frame rate to map source PTS onto; defaults to the Project composition fps. */
  fps?: Fps;
}

const ForegroundFrameSchema = z
  .object({
    index: z.number().int().nonnegative(),
    pts: PT,
    outputFrame: z.number().int().nonnegative(),
    /** Pixels whose gray level differs from the background by more than `threshold`. */
    foregroundPixels: z.number().int().nonnegative(),
    /** `foregroundPixels / (width*height)`, in [0, 1]. */
    foregroundFraction: z.number().finite().min(0).max(1),
    /** Number of 4-connected foreground components in the frame. */
    componentCount: z.number().int().nonnegative(),
    /** Area in pixels of the largest component; 0 when there is no foreground. */
    largestArea: z.number().int().nonnegative(),
    /** Spatial coherence of the foreground: `largestArea / foregroundPixels` (0 when none). */
    confidence: z.number().finite().min(0).max(1),
    /** True when `largestArea >= minArea`; the frame's foreground is usable. */
    present: z.boolean(),
    /** Full-source-normalized centroid of the largest component; null when there is none. */
    centroid: z
      .object({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1) })
      .strict()
      .nullable(),
    /** Integer full-source bounding box of the largest component; null when there is none. */
    bbox: z
      .object({
        x: z.number().int().nonnegative(),
        y: z.number().int().nonnegative(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict()
      .nullable(),
  })
  .strict();

const ForegroundSpanSchema = z
  .object({
    sourceFrameStart: z.number().int().nonnegative(),
    sourceFrameEnd: z.number().int().nonnegative(),
    outputFrameStart: z.number().int().nonnegative(),
    outputFrameEnd: z.number().int().nonnegative(),
    sourceFrames: z.number().int().positive(),
  })
  .strict();

export const ForegroundReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('reference-foreground'),
    source: z
      .object({
        path: RelativePath,
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        simulated: z.boolean(),
        origin: z.enum(['asset', 'artifact', 'material']),
      })
      .strict(),
    media: MediaInfoSchema,
    fps: FpsSchema,
    clock: z
      .object({
        timeBase: FpsSchema,
        originPts: PT,
        endPts: PT,
        durationMethod: z.enum(['source-duration', 'frame-rate-fallback']),
        variableFrameRate: z.boolean(),
      })
      .strict(),
    method: z.literal('temporal-median-background-subtraction'),
    params: z.object({ threshold: z.number().int().min(1).max(255), minArea: z.number().int().positive() }).strict(),
    frames: z.array(ForegroundFrameSchema).min(1).max(MAX_FRAMES),
    coverage: z
      .object({
        totalFrames: z.number().int().positive(),
        presentFrames: z.number().int().nonnegative(),
        missingFrames: z.number().int().nonnegative(),
        presentFraction: z.number().finite().min(0).max(1),
        gaps: z.array(ForegroundSpanSchema),
        longestGapFrames: z.number().int().nonnegative(),
        meanConfidence: z.number().finite().min(0).max(1),
        minConfidence: z.number().finite().min(0).max(1),
        fullyPresent: z.boolean(),
      })
      .strict(),
    reportPath: RelativePath,
    limitations: z.array(z.string()),
  })
  .strict()
  .superRefine((report, context) => {
    const area = report.media.width * report.media.height;
    if (
      report.frames.length !== report.media.frames ||
      report.frames[0]?.pts !== report.clock.originPts ||
      BigInt(report.clock.endPts) <= BigInt(report.clock.originPts)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Foreground frames and clock must fit the decoded source',
      });
      return;
    }
    let presentFrames = 0;
    let sumConfidence = 0;
    let minConfidence = Number.POSITIVE_INFINITY;
    for (let i = 0; i < report.frames.length; i++) {
      const frame = report.frames[i];
      const hasBlob = frame.largestArea > 0;
      const expectedConfidence = hasBlob ? frame.largestArea / frame.foregroundPixels : 0;
      if (
        frame.index !== i ||
        frame.foregroundPixels > area ||
        Math.abs(frame.foregroundFraction - frame.foregroundPixels / area) > 1e-12 ||
        frame.largestArea > frame.foregroundPixels ||
        Math.abs(frame.confidence - expectedConfidence) > 1e-12 ||
        frame.present !== frame.largestArea >= report.params.minArea ||
        (frame.centroid === null) === hasBlob ||
        (frame.bbox === null) === hasBlob ||
        (i > 0 && BigInt(frame.pts) <= BigInt(report.frames[i - 1].pts)) ||
        frame.outputFrame !== ptsToFrames(frame.pts, report.clock.originPts, report.clock.timeBase, report.fps)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Foreground frame facts must match the segmentation and exact PTS mapping',
        });
        return;
      }
      if (frame.present) {
        presentFrames++;
        sumConfidence += frame.confidence;
        if (frame.confidence < minConfidence) minConfidence = frame.confidence;
      }
    }
    const expectedMean = presentFrames > 0 ? sumConfidence / presentFrames : 0;
    const expectedMin = presentFrames > 0 ? minConfidence : 0;
    if (
      report.coverage.totalFrames !== report.frames.length ||
      report.coverage.presentFrames !== presentFrames ||
      report.coverage.missingFrames !== report.frames.length - presentFrames ||
      Math.abs(report.coverage.presentFraction - presentFrames / report.frames.length) > 1e-12 ||
      Math.abs(report.coverage.meanConfidence - expectedMean) > 1e-12 ||
      Math.abs(report.coverage.minConfidence - expectedMin) > 1e-12 ||
      report.coverage.fullyPresent !== (presentFrames === report.frames.length) ||
      report.coverage.longestGapFrames !==
        report.coverage.gaps.reduce((longest, gap) => Math.max(longest, gap.sourceFrames), 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Foreground coverage must summarize exactly the measured per-frame presence',
      });
    }
  });
export type ForegroundReport = z.infer<typeof ForegroundReportSchema>;

interface Blob {
  area: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  sumX: number;
  sumY: number;
}

/**
 * Per-pixel temporal median background. `rank` is the lower median (rank
 * `floor((frames-1)/2)`), computed with a 256-bin counting histogram so the cost
 * is O(pixels * (frames + 256)) without allocating a per-pixel sample array.
 */
function temporalMedianBackground(gray: Uint8Array, frames: number, pixels: number): Uint8Array {
  const background = new Uint8Array(pixels);
  const histogram = new Uint32Array(256);
  const rank = (frames - 1) >> 1;
  for (let p = 0; p < pixels; p++) {
    histogram.fill(0);
    for (let f = 0; f < frames; f++) histogram[gray[f * pixels + p]]++;
    let cumulative = 0;
    for (let value = 0; value < 256; value++) {
      cumulative += histogram[value];
      if (cumulative > rank) {
        background[p] = value;
        break;
      }
    }
  }
  return background;
}

/**
 * Segment one frame against the background and return the largest 4-connected
 * component. Pure pixel work: no learned model, no classification.
 */
function segment(
  frame: Uint8Array,
  base: number,
  background: Uint8Array,
  pixels: number,
  width: number,
  height: number,
  threshold: number,
  weak: Int32Array,
): { foregroundPixels: number; componentCount: number; largest: Blob | null } {
  let foregroundPixels = 0;
  for (let p = 0; p < pixels; p++) {
    const difference = frame[base + p] - background[p];
    if (difference > threshold || difference < -threshold) {
      weak[p] = 1;
      foregroundPixels++;
    } else weak[p] = 0;
  }

  let componentCount = 0;
  let largest: Blob | null = null;
  for (let seed = 0; seed < pixels; seed++) {
    if (weak[seed] !== 1) continue;
    componentCount++;
    weak[seed] = 0;
    let area = 0,
      minX = width,
      maxX = -1,
      minY = height,
      maxY = -1,
      sumX = 0,
      sumY = 0;
    const pending: number[] = [seed];
    while (pending.length > 0) {
      const p = pending.pop()!;
      const x = p % width,
        y = (p - x) / width;
      area++;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0) {
        const q = p - 1;
        if (weak[q] === 1) {
          weak[q] = 0;
          pending.push(q);
        }
      }
      if (x + 1 < width) {
        const q = p + 1;
        if (weak[q] === 1) {
          weak[q] = 0;
          pending.push(q);
        }
      }
      if (y > 0) {
        const q = p - width;
        if (weak[q] === 1) {
          weak[q] = 0;
          pending.push(q);
        }
      }
      if (y + 1 < height) {
        const q = p + width;
        if (weak[q] === 1) {
          weak[q] = 0;
          pending.push(q);
        }
      }
    }
    if (!largest || area > largest.area) largest = { area, minX, maxX, minY, maxY, sumX, sumY };
  }
  return { foregroundPixels, componentCount, largest };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Segment foreground from a local, project-relative reference video.
 *
 * Reads and validates the Project (never mutating or registering anything),
 * resolves the input safely, decodes the clip to grayscale at native
 * resolution, models a temporal-median background, segments each frame and
 * returns a validated `ForegroundReport` written atomically into a fresh
 * `.viscraft/reference-foreground/<key>/` run directory.
 */
export async function analyzeReferenceForeground(
  root: string,
  relativePath: string,
  options: AnalyzeReferenceForegroundOptions = {},
): Promise<ForegroundReport> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 255) {
    throw new Error(`Foreground threshold must be an integer in [1, 255], got ${String(options.threshold)}`);
  }
  const minArea = options.minArea ?? DEFAULT_MIN_AREA;
  if (!Number.isInteger(minArea) || minArea < 1) {
    throw new Error(`Foreground minArea must be a positive integer, got ${String(options.minArea)}`);
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

  const media = await probeMedia(absolute);
  if (media.frames > MAX_FRAMES) {
    throw new Error(
      `Reference has ${media.frames} frames; foreground segmentation is capped at ${MAX_FRAMES} frames so the whole clip can be held for a median background`,
    );
  }
  const pixels = media.width * media.height;
  if (pixels > MAX_PIXELS_PER_FRAME) {
    throw new Error(
      `Reference frame is ${media.width}x${media.height} = ${pixels} pixels; foreground segmentation is capped at ${MAX_PIXELS_PER_FRAME} pixels per frame so component labels stay small`,
    );
  }
  const grayBytes = pixels * media.frames;
  if (grayBytes > MAX_GRAY_BYTES) {
    throw new Error(
      `Grayscale decode would need ${grayBytes} bytes (${media.width}x${media.height} x ${media.frames} frames); capped at ${MAX_GRAY_BYTES} bytes to bound memory`,
    );
  }

  // Original integer PTS is the authority; mapping reuses the shared clock.
  const clock = await readSourceClock(absolute, media.frames);

  const outputDir = await resolveProjectPath(root, '.viscraft/reference-foreground');
  const workDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-reference-foreground-'));
  const paramsHash = stableHash({ sha256, fps, threshold, minArea });
  const runKey = `${paramsHash.slice(0, 24)}-${randomUUID().slice(0, 8)}`;
  const relativeDir = `.viscraft/reference-foreground/${runKey}`;
  const reportRelative = `${relativeDir}/report.json`;

  let staging: string | undefined;
  try {
    const rawPath = nodePath.join(workDir, `decode-${randomUUID()}.gray`);
    try {
      await runCommand('ffmpeg', [
        ...FFMPEG_GLOBAL,
        '-i',
        absolute,
        '-map',
        '0:v:0',
        '-an',
        '-vf',
        'format=gray',
        '-fps_mode',
        'passthrough',
        '-frames:v',
        String(media.frames + 1),
        '-f',
        'rawvideo',
        '-pix_fmt',
        'gray',
        rawPath,
      ]);
    } catch (error) {
      throw new Error(`Grayscale decode failed for ${relativePath}: ${messageOf(error)}`);
    }
    const raw = await fs.readFile(rawPath);
    if (raw.length !== grayBytes) {
      throw new Error(
        `Decoded grayscale is ${raw.length} bytes but ${media.frames} frames of ${pixels} bytes were expected (${grayBytes}); refusing a partial or mismatched decode`,
      );
    }

    const background = temporalMedianBackground(
      new Uint8Array(raw.buffer, raw.byteOffset, raw.length),
      media.frames,
      pixels,
    );
    const weak = new Int32Array(pixels);
    const frames: ForegroundReport['frames'] = new Array(media.frames);
    for (let index = 0; index < media.frames; index++) {
      const { foregroundPixels, componentCount, largest } = segment(
        raw,
        index * pixels,
        background,
        pixels,
        media.width,
        media.height,
        threshold,
        weak,
      );
      const present = largest !== null && largest.area >= minArea;
      const bbox = largest
        ? {
            x: largest.minX,
            y: largest.minY,
            width: largest.maxX - largest.minX + 1,
            height: largest.maxY - largest.minY + 1,
          }
        : null;
      // Component centroid in full-source normalized coordinates (pixel-centre included).
      const centroid = largest
        ? {
            x: (largest.sumX / largest.area + 0.5) / media.width,
            y: (largest.sumY / largest.area + 0.5) / media.height,
          }
        : null;
      frames[index] = {
        index,
        pts: clock.frames[index].pts,
        outputFrame: ptsToFrames(clock.frames[index].pts, clock.originPts, clock.timeBase, fps),
        foregroundPixels,
        foregroundFraction: foregroundPixels / pixels,
        componentCount,
        largestArea: largest?.area ?? 0,
        confidence: largest && foregroundPixels > 0 ? largest.area / foregroundPixels : 0,
        present,
        centroid,
        bbox,
      };
    }

    // Contiguous runs of frames with no usable foreground, in both frame spaces.
    const gaps: Array<{
      sourceFrameStart: number;
      sourceFrameEnd: number;
      outputFrameStart: number;
      outputFrameEnd: number;
      sourceFrames: number;
    }> = [];
    let runStart = -1;
    const closeRun = (end: number): void => {
      if (runStart < 0) return;
      gaps.push({
        sourceFrameStart: frames[runStart].index,
        sourceFrameEnd: frames[end].index,
        outputFrameStart: frames[runStart].outputFrame,
        outputFrameEnd: frames[end].outputFrame,
        sourceFrames: end - runStart + 1,
      });
      runStart = -1;
    };
    for (let i = 0; i < frames.length; i++) {
      if (!frames[i].present) {
        if (runStart < 0) runStart = i;
      } else closeRun(i - 1);
    }
    closeRun(frames.length - 1);
    const presentFrames = frames.filter(frame => frame.present).length;
    const presentConfidences = frames.filter(frame => frame.present).map(frame => frame.confidence);

    // Reject a reference that changed underneath the segmentation.
    if ((await hashFile(absolute)) !== sha256) {
      throw new Error(`Reference input ${relativePath} changed during analysis; discard this report and retry`);
    }

    const limitations = [
      'Foreground is a temporal-median background subtraction plus 4-connected components; a blob is changed pixels, not a recognized person, object, face or identity.',
      'No pose estimation, identity recognition, depth estimation or 3D reconstruction is performed by this operation.',
      'This measures pixels only. It does not edit, regenerate, continue or retime video; the reference stays unregistered material and the report is a derived artifact.',
      'Confidence is spatial coherence (largest blob / all foreground pixels), not a detection probability; shadows, compression noise, camera motion and background texture can create spurious foreground.',
      'A temporal-median background assumes a mostly static camera and scene; camera motion smears the background model and can mark the whole frame as foreground.',
      'Frames with no usable foreground report a null centroid with their raw foreground fraction; positions are never interpolated across gaps.',
    ];
    if (!options.fps) limitations.push('Output fps defaulted to the current Project composition fps.');
    if (clock.variableFrameRate)
      limitations.push(
        'The source has variable frame-rate timestamps (unequal PTS deltas); output frames are nearest-frame resamples.',
      );
    if (clock.durationMethod === 'frame-rate-fallback')
      limitations.push(
        'The final frame reported no duration; the source end time was derived from the average frame rate and is approximate.',
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

    const report = ForegroundReportSchema.parse({
      schemaVersion: 1,
      kind: 'reference-foreground',
      source: { path: relativePath, sha256, simulated: source.simulated, origin: source.origin },
      media,
      fps,
      clock: {
        timeBase: clock.timeBase,
        originPts: clock.originPts,
        endPts: clock.endPts,
        durationMethod: clock.durationMethod,
        variableFrameRate: clock.variableFrameRate,
      },
      method: 'temporal-median-background-subtraction',
      params: { threshold, minArea },
      frames,
      coverage: {
        totalFrames: frames.length,
        presentFrames,
        missingFrames: frames.length - presentFrames,
        presentFraction: presentFrames / frames.length,
        gaps,
        longestGapFrames: gaps.reduce((longest, gap) => Math.max(longest, gap.sourceFrames), 0),
        meanConfidence:
          presentFrames > 0 ? presentConfidences.reduce((sum, value) => sum + value, 0) / presentFrames : 0,
        minConfidence: presentFrames > 0 ? Math.min(...presentConfidences) : 0,
        fullyPresent: presentFrames === frames.length,
      },
      reportPath: reportRelative,
      limitations,
    });

    await fs.mkdir(outputDir, { recursive: true });
    const finalDir = await resolveProjectPath(root, relativeDir);
    try {
      await fs.access(finalDir);
      throw new Error(
        `Foreground run directory ${relativeDir} already exists; refusing to overwrite published reports`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    staging = await fs.mkdtemp(nodePath.join(outputDir, '.tmp-'));
    await atomicJson(nodePath.join(staging, 'report.json'), report);
    await fs.rename(staging, finalDir);
    staging = undefined;

    return report;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}
