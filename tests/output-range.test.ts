import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { ProjectSchema } from '../src/core/schema.js';
import { compositionFrames } from '../src/core/composition.js';
import type { Project } from '../src/core/schema.js';

const OUTPUT = { width: 64, height: 48, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 };

/** A minimal schema-valid project whose content ends at frame 40. */
function project(outputFrames?: number, endFrame = 40) {
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
      placements:
        endFrame === 0
          ? []
          : [{ id: 'p', shot: 'shot', source: 'flat', inFrame: 0, outFrame: endFrame, startFrame: 0, audio: 'mute' }],
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
});

test('outputFrames must be a positive integer', () => {
  assert.equal(ProjectSchema.parse(project(1, 0)).composition?.outputFrames, 1);
  for (const length of [0, 1.5, -1]) {
    const result = ProjectSchema.safeParse(project(length, 0));
    assert.equal(result.success, false, `${length} is invalid even with no content to truncate`);
    assert.equal(result.error.issues[0]?.path.join('.'), 'composition.outputFrames');
  }
});

test('a valid frame count whose sample position overflows yields a schema issue', () => {
  const result = ProjectSchema.safeParse(project(Number.MAX_SAFE_INTEGER, 0));
  assert.equal(result.success, false);
  assert.ok(result.error.issues.some(issue => issue.message === 'Sample position exceeds safe integer range'));
});
