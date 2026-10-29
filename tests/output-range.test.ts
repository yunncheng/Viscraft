import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { ProjectSchema } from '../src/core/schema.js';
import { compositionFrames } from '../src/core/composition.js';
import type { Project } from '../src/core/schema.js';

const OUTPUT = { width: 64, height: 48, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 };

/** A minimal schema-valid project whose content ends at frame 40. */
function project(outputFrames?: number): unknown {
  return {
    schemaVersion: 1,
    id: 'range_unit',
    revision: 1,
    title: 'Range unit',
    direction: { intent: 'range', looks: [{ id: 'look', description: 'look' }], transitions: [] },
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
      ...(outputFrames !== undefined ? { outputFrames } : {}),
    },
  };
}

test('without outputFrames the programme length is the maximum placement end', () => {
  const parsed = ProjectSchema.parse(project());
  assert.equal(parsed.composition!.outputFrames, undefined);
  assert.equal(compositionFrames(parsed as Project), 40);
});

test('outputFrames sets an exact programme length, padded when longer than content', () => {
  assert.equal(compositionFrames(ProjectSchema.parse(project(40)) as Project), 40, 'an equal length is accepted');
  assert.equal(
    compositionFrames(ProjectSchema.parse(project(55)) as Project),
    55,
    'a longer length pads the programme',
  );
});

test('outputFrames shorter than the content is rejected with a short-placements message', () => {
  assert.throws(() => ProjectSchema.parse(project(39)), /shorter than the content end \(40\); shorten placements/);
  assert.throws(() => ProjectSchema.parse(project(1)), /shorter than the content end/);
  const invalid = ProjectSchema.safeParse(project(30));
  assert.equal(invalid.success, false);
  if (!invalid.success)
    assert.ok(
      invalid.error.issues.some(issue => /shorten placements instead of truncating content/.test(issue.message)),
    );
});

test('outputFrames must be a positive integer', () => {
  assert.throws(() => ProjectSchema.parse(project(0)), 'zero must be rejected');
  assert.throws(() => ProjectSchema.parse(project(41.5)), 'a fractional length must be rejected');
  assert.throws(() => ProjectSchema.parse(project(-1)), 'a negative length must be rejected');
});
