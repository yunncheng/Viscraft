// Reference-adaptation planning control plane (pure, no I/O).
//
// `planReferenceAdaptation` turns two already-derived, timestamp-truthful
// analysis products — a `ReferenceReport` (measured cut/segment rhythm) and a
// `ReferenceTrack` (measured marker trajectory) — into a deterministic plan for
// re-authoring a *new* work that KEEPS specific targets and REPLACES the rest.
//
// This planner keeps exactly two targets, and says so explicitly:
//  - RHYTHM: the report's measured output-timeline segments, in order, become
//    the new work's segments (their boundaries are the measured cut candidates).
//  - ACTION/PATH: the track's measured normalized marker position is resampled
//    onto each output frame, one sample per frame, so a new subject can follow
//    the same path.
//
// What it deliberately does NOT do (and never claims):
//  - It does not transfer identity, appearance or subject: the plan carries only
//    normalized positions and frame boundaries, never pixels, never a subject.
//  - It performs no pose/segmentation/3D reconstruction. A flat-colour marker
//    trajectory is a 2-D path, not human motion.
//  - It does not treat scene-score cut candidates as semantic shots; a segment
//    is a measured timing interval the host Agent still has to inspect.
//
// The plan is a *derived artifact*: it does not register an Asset, mutate a
// Project, or reconstruct the original edit. Every field it emits is copied or
// resampled from the two inputs, so the same inputs always yield the same plan.

import type { Fps, ReferenceReport, ReferenceTrack } from '../../core/schema.js';
import { summarizeReferenceTrack, type ReferenceTrackCoverage } from './track-coverage.js';

/** One normalized position sample on the new work's output timeline. */
export interface AdaptationPathSample {
  /** Source-normalized x in [0, 1] over the source frame width. */
  x: number;
  /** Source-normalized y in [0, 1] over the source frame height. */
  y: number;
}

/** One measured-and-kept rhythm segment with its per-frame path slice. */
export interface AdaptationSegment {
  /** 0-based segment index in original order. */
  index: number;
  /** Inclusive first output frame of the segment. */
  startFrame: number;
  /** Exclusive end output frame of the segment. */
  endFrame: number;
  /** `endFrame - startFrame`, always positive. */
  frames: number;
  /** True when this segment begins at a measured cut candidate (always true except the first). */
  startsAtCut: boolean;
  /** One path sample per output frame in `[startFrame, endFrame)`, in order. */
  path: AdaptationPathSample[];
}

/** The derived, target-explicit plan for a reference adaptation. */
export interface AdaptationPlan {
  schemaVersion: 1;
  kind: 'reference-adaptation-plan';
  fps: Fps;
  /** Total output frames the plan tiles (`sum(segments[].frames)`). */
  totalFrames: number;
  /** Measured cut candidate output frames kept as rhythm boundaries, ascending. */
  keptRhythmBoundaries: number[];
  /** The kept rhythm, tiled from frame zero in original order. */
  segments: AdaptationSegment[];
  /** Targets this plan keeps, named exactly. */
  keptTargets: readonly ['rhythm', 'action/path'];
  /** Targets this plan deliberately replaces (recorded so callers cannot over-claim). */
  replacedTargets: readonly ['subject', 'environment', 'identity'];
  /**
   * Measured coverage/occlusion facts of the source track (gap spans,
   * partial-visibility spans, confidence statistics). When
   * `requireFullCoverage` is false these spans are exactly where the path was
   * NOT measured: it holds the previous segment-local position, or uses the
   * centre when a segment starts with a gap.
   */
  coverage: ReferenceTrackCoverage;
  limitations: string[];
}

export interface PlanReferenceAdaptationOptions {
  /**
   * Require the track to position the marker on EVERY output frame of the
   * report timeline. Defaults to true: a path with holes cannot be "kept", so a
   * gap is a loud error rather than a silently interpolated sample.
   */
  requireFullCoverage?: boolean;
}

function sameFps(a: Fps, b: Fps): boolean {
  return a.numerator * b.denominator === b.numerator * a.denominator;
}

/**
 * Build an adaptation plan from a measured reference analysis and track.
 *
 * @throws when the two inputs disagree, when a segment does not tile the
 * timeline, or (by default) when the track does not position the marker on every
 * output frame of the report timeline.
 */
export function planReferenceAdaptation(
  report: ReferenceReport,
  track: ReferenceTrack,
  options: PlanReferenceAdaptationOptions = {},
): AdaptationPlan {
  const requireFullCoverage = options.requireFullCoverage ?? true;
  if (!sameFps(report.fps, track.fps)) {
    throw new Error(
      `Reference report fps ${report.fps.numerator}/${report.fps.denominator} and track fps ${track.fps.numerator}/${track.fps.denominator} differ; rhythm and path must share one output timeline`,
    );
  }

  // The rhythm is exactly the report's measured segments (already validated to
  // tile [0, mappedEnd) contiguously by ReferenceReportSchema).
  const totalFrames = report.segments[report.segments.length - 1].endFrame;

  // Resample the tracked marker onto one sample per output frame. Positions are
  // addressed by their own `outputFrame`, never by array index, so a VFR source
  // resampled onto the output clock stays correct.
  const byFrame = new Map<number, AdaptationPathSample>();
  for (const frame of track.frames) {
    if (!frame.present || frame.x === null || frame.y === null) continue;
    if (frame.outputFrame < 0 || frame.outputFrame >= totalFrames) continue;
    byFrame.set(frame.outputFrame, { x: frame.x, y: frame.y });
  }

  const segments: AdaptationSegment[] = [];
  const keptRhythmBoundaries: number[] = [];
  for (const [index, segment] of report.segments.entries()) {
    if (segment.endFrame <= segment.startFrame) {
      throw new Error(
        `Reference segment ${index} is empty ([${segment.startFrame}, ${segment.endFrame})); a kept rhythm must have positive duration`,
      );
    }
    const path: AdaptationPathSample[] = [];
    for (let frame = segment.startFrame; frame < segment.endFrame; frame++) {
      const sample = byFrame.get(frame);
      if (!sample) {
        if (requireFullCoverage) {
          throw new Error(
            `Track has no marker position on output frame ${frame} (segment ${index} [${segment.startFrame}, ${segment.endFrame})); the path cannot be kept across a gap`,
          );
        }
        // Documented fallback: a caller that explicitly allows gaps gets the
        // previous segment-local position, or the centre at a segment start.
        // Both are explicit fallbacks, not measured marker positions.
        const previous = path[path.length - 1] ?? { x: 0.5, y: 0.5 };
        path.push({ x: previous.x, y: previous.y });
        continue;
      }
      path.push(sample);
    }
    if (index > 0) keptRhythmBoundaries.push(segment.startFrame);
    segments.push({
      index,
      startFrame: segment.startFrame,
      endFrame: segment.endFrame,
      frames: segment.endFrame - segment.startFrame,
      startsAtCut: index > 0,
      path,
    });
  }

  const coverage = summarizeReferenceTrack(track);
  const limitations = [
    'The plan keeps only measured RHYTHM (segment boundaries) and measured ACTION/PATH (normalized marker positions); it transfers no pixels, appearance, subject or identity.',
    'Flat-colour marker tracking measures a 2-D image-plane path. It does not recover pose, segmentation, depth or human motion.',
    'Report cut candidates are FFmpeg scene-score heuristics, not semantic shots; the host Agent must still inspect each segment before accepting it.',
    'The plan is a derived artifact: it does not register an Asset, mutate a Project, or reconstruct the original edit.',
    ...(requireFullCoverage
      ? []
      : [
          'With requireFullCoverage=false, gap frames hold the previous position within each segment; a gap at a segment start uses the centre. These fallback positions are not measured.',
        ]),
    ...(coverage.fullyPresent
      ? []
      : [
          `The source track is missing the marker on ${coverage.missingFrames} of ${coverage.totalFrames} frames in ${coverage.gaps.length} contiguous gap(s) (longest ${coverage.longestGapFrames} frames); see coverage.gaps for the exact source and output spans.`,
        ]),
  ];

  return {
    schemaVersion: 1,
    kind: 'reference-adaptation-plan',
    fps: report.fps,
    totalFrames,
    keptRhythmBoundaries,
    segments,
    keptTargets: ['rhythm', 'action/path'],
    replacedTargets: ['subject', 'environment', 'identity'],
    coverage,
    limitations,
  };
}
