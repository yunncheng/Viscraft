// Reference-track coverage facts (pure, no I/O).
//
// A `ReferenceTrack` already records, per decoded frame, whether the colour
// marker was observed (`present`), where it sat (`x`/`y`, source-normalized),
// how many pixels matched (`matchedPixels`) and the coverage `confidence`. What
// that per-frame list does NOT make easy for a consumer to see is the *shape of
// the missing data*: which frames are absent, whether the absences are one long
// occlusion or scattered drop-outs, and which present frames are only partially
// visible. `summarizeReferenceTrack` derives exactly those facts — contiguous
// gap spans, partial-visibility spans and confidence statistics — so a consumer
// can act on missing/occluded data instead of treating a null centroid as a
// silently usable centre.
//
// Honesty boundaries (mirrors `reference-motion.ts`):
//  - "Present"/"missing" describe whether the flat-colour marker matched; a
//    missing frame is evidence of *observability*, never of what occluded it.
//  - A low-confidence present frame is a *partial-visibility candidate*, not a
//    recognized occlusion: the same colour can shrink for motion blur, scale or
//    compression as well as for occlusion.
//  - This function performs no pose, segmentation, depth or identity reasoning;
//    it only summarizes the measured per-frame coverage the track already
//    carries.

import type { ReferenceTrack } from '../../core/schema.js';

/**
 * A contiguous run of frames, reported in BOTH source (decoded) and output
 * (composition) frame spaces so a consumer can address either timeline.
 */
export interface TrackFrameSpan {
  /** Inclusive first source decoded-frame index of the span. */
  sourceFrameStart: number;
  /** Inclusive last source decoded-frame index of the span. */
  sourceFrameEnd: number;
  /** Inclusive first output (composition) frame of the span. */
  outputFrameStart: number;
  /** Inclusive last output (composition) frame of the span. */
  outputFrameEnd: number;
  /** Number of source frames in the span (`sourceFrameEnd - sourceFrameStart + 1`). */
  sourceFrames: number;
}

export interface ReferenceTrackCoverage {
  /** Total decoded frames the track covers. */
  totalFrames: number;
  /** Frames where the marker was observed (`present === true`). */
  presentFrames: number;
  /** Frames where the marker was not observed (`present === false`). */
  missingFrames: number;
  /** `presentFrames / totalFrames`, in [0, 1]. */
  presentFraction: number;
  /** Contiguous runs of unobserved frames (a null centroid run). */
  gaps: TrackFrameSpan[];
  /** Frame count of the longest gap; 0 when every frame is present. */
  longestGapFrames: number;
  /** Mean coverage confidence over present frames; 0 when nothing is present. */
  meanConfidence: number;
  /** Minimum coverage confidence over present frames; 0 when nothing is present. */
  minConfidence: number;
  /** Maximum coverage confidence over present frames; 0 when nothing is present. */
  maxConfidence: number;
  /** Ratio of `maxConfidence` below which a present frame is only partially visible. */
  partialVisibilityRatio: number;
  /** Present frames whose confidence is below `partialVisibilityRatio * maxConfidence`. */
  lowConfidenceFrames: number;
  /** Contiguous runs of present-but-low-confidence frames (partial-visibility candidates). */
  partialVisibilitySpans: TrackFrameSpan[];
  /** True when every frame is present (no gaps). */
  fullyPresent: boolean;
}

export interface SummarizeReferenceTrackOptions {
  /**
   * Fraction of the track's maximum present confidence below which a present
   * frame counts as a partial-visibility candidate. Defaults to 0.5. Values
   * outside (0, 1] are rejected rather than silently clamped.
   */
  partialVisibilityRatio?: number;
}

/**
 * Derive coverage/occlusion facts from a validated `ReferenceTrack`.
 *
 * Adjacency is measured in *decoded source-frame order* (the array order the
 * track guarantees), because that is the physical sampling of the reference;
 * each span still reports its output-frame extent for output-timeline callers.
 */
export function summarizeReferenceTrack(
  track: ReferenceTrack,
  options: SummarizeReferenceTrackOptions = {},
): ReferenceTrackCoverage {
  const partialVisibilityRatio = options.partialVisibilityRatio ?? 0.5;
  if (!Number.isFinite(partialVisibilityRatio) || partialVisibilityRatio <= 0 || partialVisibilityRatio > 1) {
    throw new Error(
      `partialVisibilityRatio must be a finite number in (0, 1], got ${String(options.partialVisibilityRatio)}`,
    );
  }

  const frames = track.frames;
  const totalFrames = frames.length;

  let presentFrames = 0;
  let sumConfidence = 0;
  let minConfidence = Number.POSITIVE_INFINITY;
  let maxConfidence = 0;
  for (const frame of frames) {
    if (!frame.present) continue;
    presentFrames++;
    sumConfidence += frame.confidence;
    if (frame.confidence < minConfidence) minConfidence = frame.confidence;
    if (frame.confidence > maxConfidence) maxConfidence = frame.confidence;
  }
  if (presentFrames === 0) minConfidence = 0;
  const meanConfidence = presentFrames > 0 ? sumConfidence / presentFrames : 0;

  // Contiguous runs, grouped by adjacent decoded source frames.
  const gaps: TrackFrameSpan[] = [];
  const partialVisibilitySpans: TrackFrameSpan[] = [];
  const lowConfidenceFloor = partialVisibilityRatio * maxConfidence;
  let lowConfidenceFrames = 0;

  let run: { kind: 'gap' | 'partial'; start: number; end: number } | undefined;
  const closeRun = (): void => {
    if (!run) return;
    const start = frames[run.start];
    const end = frames[run.end];
    const span: TrackFrameSpan = {
      sourceFrameStart: start.index,
      sourceFrameEnd: end.index,
      outputFrameStart: start.outputFrame,
      outputFrameEnd: end.outputFrame,
      sourceFrames: run.end - run.start + 1,
    };
    (run.kind === 'gap' ? gaps : partialVisibilitySpans).push(span);
    run = undefined;
  };

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const kind = !frame.present
      ? 'gap'
      : maxConfidence > 0 && frame.confidence < lowConfidenceFloor
        ? 'partial'
        : undefined;
    if (kind === 'partial') lowConfidenceFrames++;
    if (!kind) {
      closeRun();
      continue;
    }
    // A change of kind, or a break in source adjacency, closes the current run.
    if (run && (run.kind !== kind || frames[run.end].index + 1 !== frame.index)) closeRun();
    if (!run) run = { kind, start: i, end: i };
    else run.end = i;
  }
  closeRun();

  const longestGapFrames = gaps.reduce((longest, gap) => Math.max(longest, gap.sourceFrames), 0);

  return {
    totalFrames,
    presentFrames,
    missingFrames: totalFrames - presentFrames,
    presentFraction: totalFrames > 0 ? presentFrames / totalFrames : 0,
    gaps,
    longestGapFrames,
    meanConfidence,
    minConfidence,
    maxConfidence,
    partialVisibilityRatio,
    lowConfidenceFrames,
    partialVisibilitySpans,
    fullyPresent: presentFrames === totalFrames,
  };
}
