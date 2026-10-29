// Tests for the pure reference-track coverage summariser.
//
// These call `summarizeReferenceTrack` with schema-validated synthetic tracks so
// the *observable* facts — contiguous gap spans, partial-visibility spans and
// confidence statistics — are asserted directly. No media is decoded here.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ReferenceTrackSchema } from '../src/core/schema.js';
import { summarizeReferenceTrack } from '../src/operations/analysis/track-coverage.js';

const FPS = { numerator: 10, denominator: 1 };
const TIME_BASE = { numerator: 1, denominator: 10 };
const WIDTH = 100;
const HEIGHT = 80;
const AREA = WIDTH * HEIGHT;

/**
 * Build a track over `matched` pixels per frame. `spec` maps a frame index to
 * the matched-pixel count; frames absent from `spec` carry the full marker
 * (`FULL`). A count below `MIN_PIXELS` is an unobserved (gap) frame.
 */
const FULL = 200;
const MIN_PIXELS = 4;
function makeTrack(spec: Record<number, number>): ReturnType<typeof ReferenceTrackSchema.parse> {
  const frames = Array.from({ length: 12 }, (_value, index) => {
    const matchedPixels = spec[index] ?? FULL;
    const present = matchedPixels >= MIN_PIXELS;
    return {
      index,
      pts: String(index),
      outputFrame: index,
      present,
      x: present ? 0.5 : null,
      y: present ? 0.5 : null,
      matchedPixels,
      confidence: matchedPixels / AREA,
    };
  });
  return ReferenceTrackSchema.parse({
    schemaVersion: 1,
    kind: 'reference-track',
    source: { path: 'refs/marker.mkv', sha256: 'a'.repeat(64), simulated: false, origin: 'material' },
    media: { frames: 12, fps: FPS, width: WIDTH, height: HEIGHT, duration: 1.2, videoCodec: 'h264' },
    fps: FPS,
    clock: {
      timeBase: TIME_BASE,
      originPts: '0',
      endPts: '12',
      durationMethod: 'source-duration',
      variableFrameRate: false,
    },
    marker: { color: [255, 0, 0], tolerance: 40, minPixels: MIN_PIXELS },
    roi: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
    frames,
    paramsHash: 'b'.repeat(64),
    reportPath: '.viscraft/reference-tracks/key/report.json',
    limitations: [],
  });
}

test('summarizes a single occlusion run into one gap span with confidence statistics', () => {
  // Frame 4 is only partially visible (40 matched); frames 5..7 are a gap.
  const coverage = summarizeReferenceTrack(makeTrack({ 4: 40, 5: 0, 6: 0, 7: 0 }));

  assert.equal(coverage.totalFrames, 12);
  assert.equal(coverage.presentFrames, 9);
  assert.equal(coverage.missingFrames, 3);
  assert.equal(coverage.presentFraction, 9 / 12);
  assert.equal(coverage.fullyPresent, false);

  assert.deepEqual(coverage.gaps, [
    { sourceFrameStart: 5, sourceFrameEnd: 7, outputFrameStart: 5, outputFrameEnd: 7, sourceFrames: 3 },
  ]);
  assert.equal(coverage.longestGapFrames, 3);

  assert.ok(Math.abs(coverage.maxConfidence - FULL / AREA) < 1e-12);
  assert.ok(Math.abs(coverage.minConfidence - 40 / AREA) < 1e-12);
  assert.ok(Math.abs(coverage.meanConfidence - (8 * (FULL / AREA) + 40 / AREA) / 9) < 1e-12);

  // The partially visible frame is a partial-visibility candidate, kept
  // separate from the true gap.
  assert.equal(coverage.partialVisibilityRatio, 0.5);
  assert.equal(coverage.lowConfidenceFrames, 1);
  assert.deepEqual(coverage.partialVisibilitySpans, [
    { sourceFrameStart: 4, sourceFrameEnd: 4, outputFrameStart: 4, outputFrameEnd: 4, sourceFrames: 1 },
  ]);
});

test('reports scattered drop-outs as separate spans, never one merged run', () => {
  // Present on 0,1,4,5,8,9,10,11 -> two gaps: [2,3] and [6,7].
  const coverage = summarizeReferenceTrack(makeTrack({ 2: 0, 3: 0, 6: 0, 7: 0 }));

  assert.deepEqual(
    coverage.gaps.map(gap => [gap.sourceFrameStart, gap.sourceFrameEnd, gap.sourceFrames]),
    [
      [2, 3, 2],
      [6, 7, 2],
    ],
  );
  assert.equal(coverage.longestGapFrames, 2);
  assert.equal(coverage.gaps.length, 2);
  assert.equal(coverage.presentFrames, 8);
});

test('an all-present track reports no gaps and zero missing frames', () => {
  const coverage = summarizeReferenceTrack(makeTrack({}));
  assert.equal(coverage.fullyPresent, true);
  assert.equal(coverage.missingFrames, 0);
  assert.deepEqual(coverage.gaps, []);
  assert.deepEqual(coverage.partialVisibilitySpans, []);
  assert.equal(coverage.lowConfidenceFrames, 0);
  assert.ok(Math.abs(coverage.meanConfidence - FULL / AREA) < 1e-12);
});

test('an all-missing track collapses to one full-length gap and zero confidence', () => {
  const coverage = summarizeReferenceTrack(
    makeTrack(Object.fromEntries(Array.from({ length: 12 }, (_v, i) => [i, 0]))),
  );
  assert.equal(coverage.presentFrames, 0);
  assert.equal(coverage.missingFrames, 12);
  assert.equal(coverage.meanConfidence, 0);
  assert.equal(coverage.minConfidence, 0);
  assert.equal(coverage.maxConfidence, 0);
  assert.deepEqual(coverage.gaps, [
    { sourceFrameStart: 0, sourceFrameEnd: 11, outputFrameStart: 0, outputFrameEnd: 11, sourceFrames: 12 },
  ]);
  assert.equal(coverage.lowConfidenceFrames, 0);
});

test('honours a caller-supplied partial-visibility ratio and rejects an invalid one', () => {
  // Only frame 4 at 40 matched is below a strict 0.9 * 200 = 180 floor.
  const strict = summarizeReferenceTrack(makeTrack({ 4: 40 }), { partialVisibilityRatio: 0.9 });
  assert.equal(strict.lowConfidenceFrames, 1);
  assert.equal(strict.partialVisibilitySpans.length, 1);

  // A lenient ratio counts no frame as partial.
  const lenient = summarizeReferenceTrack(makeTrack({ 4: 40 }), { partialVisibilityRatio: 0.1 });
  assert.equal(lenient.lowConfidenceFrames, 0);

  assert.throws(
    () => summarizeReferenceTrack(makeTrack({}), { partialVisibilityRatio: 0 }),
    /partialVisibilityRatio must be a finite number in \(0, 1\]/,
  );
  assert.throws(() => summarizeReferenceTrack(makeTrack({}), { partialVisibilityRatio: 2 }), /partialVisibilityRatio/);
});
