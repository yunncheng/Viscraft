// Four controls for the pure author-track motion diagnostic.
//
// Each control drives `analyzeAuthorMotion` with an inline `at(frame)`-style
// sampler and asserts the *declared facts* it derives. No media, no pixels, no
// module import: the diagnostic is a pure function of the author track. The
// four cases — a real failure, correct motion, a deliberate hold, and a normal
// hard cut — each assert facts, not verdicts, and none is scored.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeAuthorMotion } from '../src/operations/analysis/motion-diagnostic.js';
import type { AuthorMotionInput } from '../src/operations/analysis/motion-diagnostic.js';

// 1920x1080 viewport over a 1920x1080 world frame => fitScale 1, so a subject
// world point [x, y] projects to output pixels [x + 960, y + 540] for a
// focus-[0, 0], zoom-1 camera. Bounds default to the whole viewport.
const VIEW = { outWidth: 1920, outHeight: 1080, worldWidth: 1920, worldHeight: 1080 } as const;
const FRAMES = 40;

/** Smoothstep ease over [0, 1]; used to author a genuinely eased dolly. */
const smoothstep = (t: number): number => t * t * (3 - 2 * t);

test('real failure: a drifting subject leaves bounds and spikes speed', () => {
  // The subject walks steadily across and OFF the screen: after ~frame 10 the
  // projected x exceeds the 1920-wide viewport. A wrong constant step also
  // makes every per-frame delta large.
  const subjectX = (frame: number): number => frame * 120 - 200;

  const report = analyzeAuthorMotion({
    frames: FRAMES,
    view: VIEW,
    sample: frame => ({ subject: [subjectX(frame), 0], camera: { focus: [0, 0], zoom: 1 } }),
  });

  // The diagnostic catches the failure: non-empty out-of-bounds frames.
  assert.ok(report.outOfBoundsFrames.length > 0);
  assert.equal(report.outOfBoundsFrames[0], 10); // first frame whose projected x > 1920

  // A large, constant per-frame speed; every delta is the same 120 px/frame.
  assert.equal(report.maxSpeed, 120);
  assert.ok(report.velocities.every(v => Number.isFinite(v.speed)));
  assert.ok(Math.abs(report.velocities[0].speed - 120) < 1e-9);
});

test('correct motion: an eased dolly stays inside bounds with finite, smooth speeds', () => {
  // A 600-world-unit dolly, smoothstepped over the whole clip: the subject never
  // leaves a 300-unit margin around centre, and the speed rises to a single
  // interior peak then falls.
  const subjectX = (frame: number): number => -300 + 600 * smoothstep(frame / (FRAMES - 1));

  const input: AuthorMotionInput = {
    frames: FRAMES,
    view: VIEW,
    sample: frame => ({ subject: [subjectX(frame), 0], camera: { focus: [0, 0], zoom: 1 } }),
  };
  const report = analyzeAuthorMotion(input);

  assert.deepEqual(report.outOfBoundsFrames, []);
  assert.equal(report.velocities.length, FRAMES - 1);
  // Every fact is finite; nothing collapses to NaN.
  for (const velocity of report.velocities) {
    assert.ok(Number.isFinite(velocity.dx) && Number.isFinite(velocity.dy) && Number.isFinite(velocity.speed));
  }
  // No zero-speed frames: the subject is always moving.
  assert.ok(report.velocities.every(v => v.speed > 0));
  // Eased: the peak is interior (never at a forced endpoint), faster than the
  // slower ramp-up/ramp-down ends.
  assert.ok(report.maxSpeedFrames.length >= 1);
  assert.ok(report.maxSpeedFrames.every(frame => frame > 2 && frame < FRAMES - 3));
  assert.ok(report.minSpeed < report.maxSpeed);
  assert.ok(report.velocities.every(v => v.speed <= report.maxSpeed + 1e-9));
});

test('deliberate hold: an exactly-constant range reports a zero-speed hold span', () => {
  // Frames 0..4 step at 20 units; from frame 5 the subject and camera are
  // exactly constant. The zero-speed run is frames 6..11 (the first frame of the
  // whole track has no predecessor; frame 5 still carries the 20-unit step).
  const subjectX = (frame: number): number => (frame < 5 ? frame * 20 : 100);

  const report = analyzeAuthorMotion({
    frames: 12,
    view: VIEW,
    sample: frame => ({ subject: [subjectX(frame), 0], camera: { focus: [0, 0], zoom: 1 } }),
  });

  // The held frames report speed === 0 exactly.
  const held = report.velocities.filter(v => v.frame >= 6);
  assert.equal(held.length, 6);
  assert.ok(held.every(v => v.speed === 0));
  // ... and surface as a single maximal hold span, as a FACT (no defect field).
  assert.deepEqual(report.holds, [{ from: 6, to: 11 }]);
  assert.equal('defect' in report, false);
  // The hold does not swallow the preceding step at frame 5.
  assert.ok(Math.abs(report.velocities.find(v => v.frame === 5)!.speed - 20) < 1e-9);
});

test('normal hard cut: two segments report no cross-boundary delta, not a teleport', () => {
  // Two shot placements on one clip: frames 0..5 hold x = 0, frames 6..11 hold
  // x = 500. The positions jump at the cut, but because they are separate
  // segments there is no velocity across frame 5 -> 6.
  const report = analyzeAuthorMotion({
    frames: 12,
    view: VIEW,
    segments: [
      { from: 0, to: 5 },
      { from: 6, to: 11 },
    ],
    sample: frame => ({ subject: [frame <= 5 ? 0 : 500, 0], camera: { focus: [0, 0], zoom: 1 } }),
  });

  // The boundary is a placement boundary, not a sampled delta.
  assert.equal(
    report.velocities.some(v => v.frame === 6),
    false,
  );
  assert.equal(report.velocities.length, 10); // 5 per segment
  // Each segment is internally continuous (constant here): no absurd velocity.
  assert.equal(report.maxSpeed, 0);
  assert.ok(report.velocities.every(v => v.speed === 0));
  // The position jump still exists as a fact; it just is not a velocity.
  assert.equal(report.positions[5].x, 960);
  assert.equal(report.positions[6].x, 1460);
});
