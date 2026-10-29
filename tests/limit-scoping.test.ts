/**
 * Limit-scoping regression tests for the current model and recording contracts.
 *
 * Model-specific limits belong to the model profile, not the general Schema:
 *   - General video/image references impose no numeric model-specific count.
 *   - MiniMax-H3 Ref2VA reference counts are checked by its model profile;
 *     failures identify the selected model.
 *
 * Recording contracts preserve the authored frame/event selection. Execution
 * memory is budgeted separately without a creative duration or state-shape quota.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  PlayableRecordingSchema,
  GenerateImageRequestSchema,
  ProviderSourceSchema,
  type Reference,
  type ProviderSource,
} from '../src/core/schema.js';
import { validateMinimaxH3Request, minimaxH3Model } from '../src/backends/providers/models/minimax-h3.js';
import { recordPlayable } from '../src/backends/playable/playable.js';

const OUTPUT = {
  width: 32,
  height: 32,
  fps: { numerator: 30, denominator: 1 },
  sampleRate: 48000 as const,
  channels: 1 as const,
};

function ref(asset: string, category: 'image' | 'video' | 'audio', role: string): Reference {
  return { asset, category, role } as Reference;
}

function videoSource(model: string, references: Reference[]): ProviderSource {
  return {
    id: 's',
    kind: 'provider',
    output: 'picture',
    endpoint: 'bind',
    model,
    prompt: 'p',
    mode: 'reference',
    references,
    requestedFrames: 96,
    size: '1344:768',
    fps: 24,
    steps: 30,
    seed: 0,
    attempt: 'att-1',
  };
}

const THIRTEEN_MIXED: Reference[] = [
  ...Array.from({ length: 9 }, (_unused, i) => ref(`i${i}`, 'image', 'identity')),
  ...Array.from({ length: 3 }, (_unused, i) => ref(`v${i}`, 'video', 'motion')),
  ref('a0', 'audio', 'audio'),
];

// ---------------------------------------------------------------------------
// Model-specific reference limits
// ---------------------------------------------------------------------------

test('schema: a 13-reference request to a non-H3 model is NOT rejected by the general contract', () => {
  const thirteenImages = Array.from({ length: 13 }, (_unused, i) => ref(`img${i}`, 'image', 'identity'));
  const source = videoSource('Some-Other-Video-Model', thirteenImages);
  assert.equal(
    ProviderSourceSchema.safeParse(source).success,
    true,
    '13 image references must parse for a non-H3 model',
  );
  assert.equal(
    ProviderSourceSchema.safeParse(videoSource('Some-Other-Video-Model', THIRTEEN_MIXED)).success,
    true,
    '13 mixed references must parse for a non-H3 model',
  );

  // A 13-reference image request is likewise unrestricted.
  const image = {
    id: 'g',
    attempt: 1,
    asset: 'out_g',
    rights: { origin: 'limit-scoping fixture', license: 'CC0-1.0', redistributable: true },
    endpoint: 'bind',
    operation: 'generate',
    model: 'Some-Image-Model',
    prompt: 'p',
    references: thirteenImages,
  };
  assert.equal(GenerateImageRequestSchema.safeParse(image).success, true, '13 image references must parse');
});

test('H3 profile: the same 13 mixed references are refused with the model-specific reason', () => {
  // 13 mixed that stays within each per-category limit -> refused by the total.
  assert.throws(
    () => validateMinimaxH3Request(videoSource('MiniMax-H3', THIRTEEN_MIXED)),
    /MiniMax-H3 Ref2VA accepts at most 12 mixed references \(got 13\)/,
  );
  // Per-category limits are also model-specific and named.
  assert.throws(
    () =>
      validateMinimaxH3Request(
        videoSource(
          'MiniMax-H3',
          Array.from({ length: 10 }, (_unused, i) => ref(`i${i}`, 'image', 'identity')),
        ),
      ),
    /MiniMax-H3 Ref2VA accepts at most 9 image references \(got 10\)/,
  );
  assert.throws(
    () =>
      validateMinimaxH3Request(
        videoSource(
          'MiniMax-H3',
          Array.from({ length: 4 }, (_unused, i) => ref(`v${i}`, 'video', 'motion')),
        ),
      ),
    /MiniMax-H3 Ref2VA accepts at most 3 video references \(got 4\)/,
  );
  // 12 mixed (9 images + 3 videos) is still legal for H3.
  assert.doesNotThrow(() => validateMinimaxH3Request(videoSource('MiniMax-H3', THIRTEEN_MIXED.slice(0, 12))));
  // The unified GenerationModel path (what Plan/Produce run) routes H3 through
  // its own profile; the model-agnostic shared pipeline never bypasses it.
  assert.throws(() => minimaxH3Model.validate(videoSource('MiniMax-H3', THIRTEEN_MIXED), {}, {}), /MiniMax-H3 Ref2VA/);
});

// ---------------------------------------------------------------------------
// Recording resource policy is not a frame/event quota in the authoring schema
// ---------------------------------------------------------------------------

function recordingJson(frames: number, options: { states?: number; events?: number } = {}): unknown {
  const states = options.states ?? frames;
  const events = options.events ?? 0;
  return {
    schemaVersion: 1,
    id: 'rec',
    source: {
      id: 'game',
      key: 'a'.repeat(64),
      entry: 'game.html',
      resources: [],
      bindings: [],
      params: {},
      seed: 0,
      files: [],
    },
    output: OUTPUT,
    frames,
    events: Array.from({ length: events }, () => ({ frame: 0, type: 'down', key: 'ArrowRight' })),
    states: Array.from({ length: states }, (_unused, i) => ({ frame: i, state: { i } })),
    media: {
      path: 'recordings/rec/preview.mp4',
      sha256: 'b'.repeat(64),
      info: { frames, fps: OUTPUT.fps, width: 32, height: 32, duration: frames / 30, videoCodec: 'h264' },
    },
    simulated: false,
  };
}

test('recording schema preserves frame and event selections while rejecting inconsistent clocks', () => {
  for (const frames of [700, 3600, 3601, 7200])
    assert.equal(PlayableRecordingSchema.safeParse(recordingJson(frames)).success, true);
  assert.equal(
    PlayableRecordingSchema.safeParse(recordingJson(3601, { states: 3600 })).success,
    false,
    'every captured frame still requires its state',
  );
  assert.equal(
    PlayableRecordingSchema.safeParse(recordingJson(3601, { events: 12001 })).success,
    true,
    'events are not dropped at a fixed quota',
  );
});

function projectJson(frames: number): string {
  return JSON.stringify({
    schemaVersion: 1,
    id: 'p',
    revision: 1,
    title: 'limit-scoping',
    direction: { intent: 'i', looks: [{ id: 'look', description: 'l' }], transitions: [] },
    assets: [],
    bindings: {},
    sources: [
      {
        id: 'game',
        kind: 'browser',
        output: 'picture',
        entry: 'game.html',
        resources: [],
        bindings: [],
        params: {},
        seed: 0,
        frames,
      },
    ],
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: '' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: '', targetFrames: frames }],
      placements: [
        { id: 'edit', shot: 'shot', source: 'game', inFrame: 0, outFrame: frames, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio: [],
    },
  });
}

async function makeProject(frames: number): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-limit-'));
  await fs.writeFile(path.join(root, 'game.html'), '<!doctype html><html><body></body></html>');
  await fs.writeFile(path.join(root, 'project.json'), projectJson(frames));
  return root;
}

test('recordPlayable validates the actual event interval without a fixed session-duration gate', async () => {
  const inRange = await makeProject(601);
  const oversized = await makeProject(3601);
  try {
    // A frame-valid request must still reject an event outside its interval.
    await assert.rejects(
      recordPlayable(inRange, 'game', [{ frame: 601, type: 'down', key: 'ArrowRight' }]),
      /outside the recorded interval \[0, 601\)/,
    );
    // A longer source reaches the same genuine event-range check.
    await assert.rejects(
      recordPlayable(oversized, 'game', [{ frame: 3601, type: 'down', key: 'ArrowRight' }]),
      /outside the recorded interval \[0, 3601\)/,
    );
  } finally {
    await fs.rm(inRange, { recursive: true, force: true });
    await fs.rm(oversized, { recursive: true, force: true });
  }
});
