// Tests for the pure reference-adaptation planner.
//
// These exercise `planReferenceAdaptation` directly with schema-validated
// inputs: the kept-rhythm tiling, the per-frame path resampling, the loud
// failures on a gap and on an fps mismatch, and the explicit kept/replaced
// target recording. No media is decoded here — this is the deterministic bridge
// from measured analysis to new authoring, so it can be a plain unit test.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ReferenceReportSchema, ReferenceTrackSchema } from '../src/core/schema.js';
import { planReferenceAdaptation } from '../src/operations/analysis/adaptation-plan.js';

const FPS = { numerator: 15, denominator: 1 };
const TIME_BASE = { numerator: 1, denominator: 15 };
const FRAMES = 30;

function media(frames: number) {
  return { frames, fps: FPS, width: 300, height: 200, duration: frames / 15, videoCodec: 'h264' };
}

/** A report whose two cut candidates tile three equal ten-frame segments. */
function report() {
  const frames = Array.from({ length: FRAMES }, (_v, index) => ({ index, pts: String(index), outputFrame: index }));
  return ReferenceReportSchema.parse({
    schemaVersion: 1,
    kind: 'reference-analysis',
    source: { path: 'materials/ref.mp4', sha256: 'a'.repeat(64), simulated: false, origin: 'material' },
    fps: FPS,
    media: media(FRAMES),
    clock: {
      timeBase: TIME_BASE,
      originPts: '0',
      endPts: String(FRAMES),
      durationMethod: 'source-duration',
      variableFrameRate: false,
    },
    frames,
    cuts: [
      { sourceFrame: 10, pts: '10', outputFrame: 10, score: 0.9 },
      { sourceFrame: 20, pts: '20', outputFrame: 20, score: 0.8 },
    ],
    segments: [
      { startFrame: 0, endFrame: 10 },
      { startFrame: 10, endFrame: 20 },
      { startFrame: 20, endFrame: 30 },
    ],
    reviewFrames: [],
    threshold: 0.3,
    reportPath: '.viscraft/references/key/report.json',
    limitations: [],
  });
}

/** A track whose marker sits on every frame at a straight diagonal. */
function track(presentAll = true) {
  const frames = Array.from({ length: FRAMES }, (_v, index) => {
    const present = presentAll || index !== 7;
    return {
      index,
      pts: String(index),
      outputFrame: index,
      present,
      x: present ? 0.1 + index * 0.02 : null,
      y: present ? 0.2 + index * 0.02 : null,
      matchedPixels: present ? 100 : 0,
      confidence: present ? 100 / (300 * 200) : 0,
    };
  });
  return ReferenceTrackSchema.parse({
    schemaVersion: 1,
    kind: 'reference-track',
    source: { path: 'materials/ref.mp4', sha256: 'a'.repeat(64), simulated: false, origin: 'material' },
    media: media(FRAMES),
    fps: FPS,
    clock: {
      timeBase: TIME_BASE,
      originPts: '0',
      endPts: String(FRAMES),
      durationMethod: 'source-duration',
      variableFrameRate: false,
    },
    marker: { color: [0, 255, 255], tolerance: 70, minPixels: 4 },
    roi: { x: 0, y: 0, width: 300, height: 200 },
    frames,
    paramsHash: 'b'.repeat(64),
    reportPath: '.viscraft/reference-tracks/key/report.json',
    limitations: [],
  });
}

test('keeps the measured rhythm as tiled segments and names both kept targets', () => {
  const plan = planReferenceAdaptation(report(), track());
  assert.equal(plan.totalFrames, 30);
  assert.deepEqual(plan.keptRhythmBoundaries, [10, 20]);
  assert.deepEqual(plan.keptTargets, ['rhythm', 'action/path']);
  assert.deepEqual(
    plan.segments.map(s => [s.startFrame, s.endFrame, s.frames, s.startsAtCut]),
    [
      [0, 10, 10, false],
      [10, 20, 10, true],
      [20, 30, 10, true],
    ],
  );
  // Segments tile [0, totalFrames) with no gap and no overlap.
  const end = plan.segments.reduce((cursor, segment) => {
    assert.equal(segment.startFrame, cursor);
    return segment.endFrame;
  }, 0);
  assert.equal(end, plan.totalFrames);
});

test('resamples one path sample per output frame, addressed by outputFrame', () => {
  const plan = planReferenceAdaptation(report(), track());
  for (const segment of plan.segments) assert.equal(segment.path.length, segment.frames);
  // Frame 12 is the third sample of segment 1: x = 0.1 + 12*0.02 = 0.34.
  const sample = plan.segments[1].path[12 - 10];
  assert.ok(Math.abs(sample.x - 0.34) < 1e-9);
  assert.ok(Math.abs(sample.y - 0.44) < 1e-9);
});

test('fails loudly when the track leaves a gap in the timeline', () => {
  assert.throws(() => planReferenceAdaptation(report(), track(false)), /no marker position on output frame 7/);
});

test('explicit gap tolerance holds within a segment and starts at the centre when a cut begins with a gap', () => {
  const measured = track(false);
  for (const index of [0, 10]) {
    measured.frames[index] = {
      ...measured.frames[index],
      present: false,
      x: null,
      y: null,
      matchedPixels: 0,
      confidence: 0,
    };
  }
  const plan = planReferenceAdaptation(report(), ReferenceTrackSchema.parse(measured), { requireFullCoverage: false });
  const gap = plan.segments[0].path[7];
  const previous = plan.segments[0].path[6];
  assert.deepEqual(gap, previous);
  assert.deepEqual(plan.segments[0].path[0], { x: 0.5, y: 0.5 });
  assert.deepEqual(plan.segments[1].path[0], { x: 0.5, y: 0.5 });
  assert.deepEqual(plan.segments[1].path[1], { x: measured.frames[11].x, y: measured.frames[11].y });
  assert.equal(plan.coverage.fullyPresent, false);
});

test('the plan surfaces the measured coverage so a gap is visible, not hidden', () => {
  const full = planReferenceAdaptation(report(), track());
  assert.equal(full.coverage.fullyPresent, true);
  assert.deepEqual(full.coverage.gaps, []);

  const gapped = planReferenceAdaptation(report(), track(false), { requireFullCoverage: false });
  assert.equal(gapped.coverage.fullyPresent, false);
  assert.deepEqual(gapped.coverage.gaps, [
    { sourceFrameStart: 7, sourceFrameEnd: 7, outputFrameStart: 7, outputFrameEnd: 7, sourceFrames: 1 },
  ]);
});

test('rejects a report and a track on different output timelines', () => {
  // A valid 30 fps track: its own time base (1/30) keeps outputFrame === index.
  const other = ReferenceTrackSchema.parse({
    schemaVersion: 1,
    kind: 'reference-track',
    source: { path: 'materials/ref.mp4', sha256: 'a'.repeat(64), simulated: false, origin: 'material' },
    media: media(FRAMES),
    fps: { numerator: 30, denominator: 1 },
    clock: {
      timeBase: { numerator: 1, denominator: 30 },
      originPts: '0',
      endPts: String(FRAMES),
      durationMethod: 'source-duration',
      variableFrameRate: false,
    },
    marker: { color: [0, 255, 255], tolerance: 70, minPixels: 4 },
    roi: { x: 0, y: 0, width: 300, height: 200 },
    frames: Array.from({ length: FRAMES }, (_v, index) => ({
      index,
      pts: String(index),
      outputFrame: index,
      present: true,
      x: 0.5,
      y: 0.5,
      matchedPixels: 100,
      confidence: 100 / (300 * 200),
    })),
    paramsHash: 'c'.repeat(64),
    reportPath: '.viscraft/reference-tracks/key/report.json',
    limitations: [],
  });
  assert.throws(
    () => planReferenceAdaptation(report(), other),
    /differ; rhythm and path must share one output timeline/,
  );
});
