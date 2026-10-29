import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { BeatSchema, ProjectSchema } from '../src/core/schema.js';
import { compositionFrames } from '../src/core/composition.js';
import type { Project } from '../src/core/schema.js';

// 40 content frames at 30 fps / 48 kHz -> 40 * 1600 = 64000 samples.
const OUTPUT = { width: 64, height: 48, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 };

/** A minimal schema-valid project whose only variable is the beat grid. */
function project(beats?: unknown, outputFrames?: number): unknown {
  return {
    schemaVersion: 1,
    id: 'beats_unit',
    revision: 1,
    title: 'Beats unit',
    direction: { intent: 'beats', looks: [{ id: 'look', description: 'look' }], transitions: [] },
    assets: [],
    bindings: {},
    sources: [],
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: 'scene' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: 'shot', targetFrames: 40 }],
      placements: [{ id: 'p', shot: 'shot', source: 'flat', inFrame: 0, outFrame: 40, startFrame: 0, audio: 'mute' }],
      transitions: [],
      audio: [],
      ...(beats !== undefined ? { beats } : {}),
      ...(outputFrames !== undefined ? { outputFrames } : {}),
    },
  };
}

test('BeatSchema requires a nonnegative integer sample and a real Id', () => {
  assert.deepEqual(BeatSchema.parse({ id: 'beat_0', sample: 0 }), { id: 'beat_0', sample: 0 });
  assert.throws(() => BeatSchema.parse({ id: 'beat_0', sample: -1 }), 'a negative sample must be rejected');
  assert.throws(() => BeatSchema.parse({ id: 'beat_0', sample: 1.5 }), 'a fractional sample must be rejected');
  assert.throws(() => BeatSchema.parse({ id: '', sample: 0 }), 'an empty beat Id must be rejected');
  assert.throws(() => BeatSchema.parse({ id: 'beat_0', sample: 0, frame: 1 }), 'unknown beat keys must be rejected');
});

test('a valid beat grid is accepted and omitting beats changes nothing', () => {
  const withBeats = ProjectSchema.parse(
    project([
      { id: 'b1', sample: 16000 },
      { id: 'b2', sample: 32000 },
    ]),
  );
  assert.deepEqual(withBeats.composition!.beats, [
    { id: 'b1', sample: 16000 },
    { id: 'b2', sample: 32000 },
  ]);
  assert.equal(compositionFrames(withBeats as Project), 40, 'a beat grid must not change the programme length');

  const without = ProjectSchema.parse(project());
  assert.equal(without.composition!.beats, undefined, 'an absent grid stays absent');
  assert.equal(compositionFrames(without as Project), 40, 'an absent grid leaves the max-placement-end length');
  assert.equal(without.composition!.outputFrames, undefined);
});

test('a beat at sample zero is inside the half-open span; the end boundary is not', () => {
  // The programme sample span is the half-open [0, totalSamples); sample 0 is
  // the first sample and is a legitimate downbeat, while totalSamples is outside.
  assert.deepEqual(ProjectSchema.parse(project([{ id: 'downbeat', sample: 0 }])).composition!.beats, [
    { id: 'downbeat', sample: 0 },
  ]);
  assert.throws(
    () => ProjectSchema.parse(project([{ id: 'end', sample: 64000 }])),
    /outside the programme sample span \[0, 64000\)/,
  );
  assert.throws(
    () => ProjectSchema.parse(project([{ id: 'past', sample: 999999 }])),
    /outside the programme sample span/,
  );
});

test('the beat grid rejects duplicates, unsorted and non-increasing samples', () => {
  assert.throws(
    () =>
      ProjectSchema.parse(
        project([
          { id: 'b1', sample: 32000 },
          { id: 'b2', sample: 16000 },
        ]),
      ),
    /strictly increase/,
  );
  assert.throws(
    () =>
      ProjectSchema.parse(
        project([
          { id: 'b1', sample: 16000 },
          { id: 'b1', sample: 32000 },
        ]),
      ),
    /Duplicate beat identity b1/,
  );
  assert.throws(
    () =>
      ProjectSchema.parse(
        project([
          { id: 'b1', sample: 16000 },
          { id: 'b2', sample: 16000 },
        ]),
      ),
    /strictly increase/,
  );
});

test('a beat grid is validated against the PROGRAMME sample span (the padded length), not the content span', () => {
  // Content is 40 frames -> 64000 samples; outputFrames 50 -> 80000 samples.
  const longer = ProjectSchema.parse(project([{ id: 'b', sample: 70000 }], 50));
  assert.equal(compositionFrames(longer as Project), 50, 'outputFrames is the explicit programme length');
  // 70000 lies BEYOND the content span but INSIDE the padded programme span.
  assert.deepEqual(longer.composition!.beats, [{ id: 'b', sample: 70000 }], 'a beat inside the padded tail is legal');
  // The same beat is out of range without the explicit padded length.
  assert.throws(
    () => ProjectSchema.parse(project([{ id: 'b', sample: 70000 }])),
    /outside the programme sample span \[0, 64000\)/,
  );
  // The programme's own half-open END is rejected with the padded length.
  assert.throws(
    () => ProjectSchema.parse(project([{ id: 'b', sample: 80000 }], 50)),
    /outside the programme sample span \[0, 80000\)/,
  );
});

test('a beat grid id/identity conflict is clear and localised', () => {
  const invalid = ProjectSchema.safeParse(
    project([
      { id: 'b1', sample: 16000 },
      { id: 'b1', sample: 32000 },
    ]),
  );
  assert.equal(invalid.success, false);
  if (!invalid.success) assert.ok(invalid.error.issues.some(issue => /Duplicate beat identity b1/.test(issue.message)));
});
