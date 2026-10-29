/**
 * Programme audio stems — schema contract and mixer grouping (no video build).
 *
 * Semantics under test: the programme `mixAudio` result is the FULL mix of every
 * member (routed or not); a `bus` argument selects an ADDITIONAL grouped stem
 * containing only that bus's members. A stem never subtracts audio from the
 * programme — it is a grouped export that overlaps the programme mix.
 *
 *  - the programme mix is byte-identical to the same project with all `bus`
 *    labels removed (routing labels never change what the programme contains);
 *  - each stem is byte-identical to an independent render of only its own
 *    members, so members cannot leak between stems;
 *  - a `bus` with no matching member is a loud error and writes no stem;
 *  - the schema accepts `bus` only where it is meaningful (a placement may set
 *    it only when `audio` is `'keep'`).
 *
 * Grouping note: a repeated `bus` label is the point of a bus (it groups
 * several members into ONE stem), so it must NOT be rejected. The build-level
 * guarantee that one repeated label yields one stem (never a duplicate stem
 * operation) is asserted in tests/stems.e2e.ts; the "empty bus" case is the
 * only rejection here.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { mixAudio, type KeptAudio } from '../src/backends/media/audio-mix.js';
import { ArtifactSchema, type Composition, PlacementSchema, type Project } from '../src/core/schema.js';
import { framesToSamples } from '../src/core/time.js';
import { validateProject } from '../src/project/project.js';
import { runCommand } from '../src/shared/process.js';
import { writeSignalAsset } from './audio-fixtures.js';

const FPS30 = { numerator: 30, denominator: 1 };
const OUTPUT = { width: 64, height: 48, fps: FPS30, sampleRate: 48000, channels: 2 } as const;

type Clip = Composition['audio'][number];

function makeProject(audio: Clip[], assets: Project['assets'] = []): Project {
  return {
    schemaVersion: 1,
    id: 'stems-unit',
    revision: 1,
    title: 'Stems unit',
    soundTargets: [],
    direction: { intent: 'Bus grouping', looks: [{ id: 'look', description: 'identity' }], transitions: [] },
    assets,
    bindings: {},
    sources: [
      {
        id: 'scene',
        kind: 'browser',
        output: 'picture',
        entry: 'scene.html',
        resources: [],
        bindings: [],
        params: {},
        seed: 0,
        frames: 30,
      },
    ],
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: 'Stems' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: 'Stems', targetFrames: 30 }],
      placements: [
        { id: 'edit', shot: 'shot', source: 'scene', inFrame: 0, outFrame: 30, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio,
    },
    imageDocuments: [],
    imageTargets: [],
  };
}

function assetClip(id: string, asset: string, gain: number, bus: string | undefined, samples: number): Clip {
  return {
    id,
    kind: 'asset',
    asset,
    inSample: 0,
    startSample: 0,
    durationSamples: samples,
    gain,
    fadeInSamples: 0,
    fadeOutSamples: 0,
    ...(bus === undefined ? {} : { bus }),
  };
}

/** Write a distinct-frequency signal Asset at the real output rate/stereo. */
function signalAsset(root: string, id: string, frequency: number, samples: number): Promise<Project['assets'][number]> {
  return writeSignalAsset(root, { id, path: `${id}.wav`, sampleRate: 48000, channels: 2, samples, frequency });
}

/** Render one mix to a WAV through the runtime mixer and return the raw bytes. */
async function render(
  root: string,
  project: Project,
  kept: KeptAudio[],
  totalFrames: number,
  name: string,
  bus?: string,
): Promise<Buffer> {
  const destination = join(root, name);
  await mixAudio(root, project, kept, totalFrames, destination, undefined, bus);
  return readFile(destination);
}

/** Generate a plain stereo PCM16 fixture tone. */
async function toneWav(path: string, frequency: number, seconds: number, gain: number): Promise<void> {
  await runCommand('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${frequency}:sample_rate=48000`,
    '-af',
    `volume=${gain},aformat=channel_layouts=stereo`,
    '-t',
    String(seconds),
    '-c:a',
    'pcm_s16le',
    path,
  ]);
}

test('the programme mix stays full and each bus is an isolated grouped stem', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-stems-unit-'));
  try {
    const totalFrames = 30;
    const totalSamples = framesToSamples(totalFrames, FPS30, 48000, 'ceil');
    assert.equal(totalSamples, 48000, 'canonical ceil span is exact');

    const sfxPath = join(root, 'sfx.wav');
    await toneWav(sfxPath, 780, 1.5, 0.6);
    const progAsset = await signalAsset(root, 'progAsset', 120, totalSamples);
    const musicAsset = await signalAsset(root, 'musicAsset', 420, totalSamples);
    const musicBAsset = await signalAsset(root, 'musicBAsset', 320, totalSamples);
    const assets: Project['assets'] = [progAsset, musicAsset, musicBAsset];

    // An unrouted programme signal, a `music` bus that groups TWO members, and
    // an `sfx` bus carried by a kept placement.
    const withBuses = makeProject(
      [
        assetClip('prog', 'progAsset', 0.3, undefined, totalSamples),
        assetClip('musicA', 'musicAsset', 0.3, 'music', totalSamples),
        assetClip('musicB', 'musicBAsset', 0.2, 'music', totalSamples),
      ],
      assets,
    );
    const keptSfx: KeptAudio[] = [{ path: sfxPath, startFrame: 0, bus: 'sfx' }];

    const programme = await render(root, withBuses, keptSfx, totalFrames, 'programme.wav');
    const stemMusic = await render(root, withBuses, keptSfx, totalFrames, 'stem-music.wav', 'music');
    const stemSfx = await render(root, withBuses, keptSfx, totalFrames, 'stem-sfx.wav', 'sfx');

    // Independent controls. The programme is the FULL mix (all three members);
    // each stem is exactly its own members.
    const ctlFull = await render(
      root,
      makeProject(
        [
          assetClip('prog', 'progAsset', 0.3, undefined, totalSamples),
          assetClip('musicA', 'musicAsset', 0.3, undefined, totalSamples),
          assetClip('musicB', 'musicBAsset', 0.2, undefined, totalSamples),
        ],
        assets,
      ),
      [{ path: sfxPath, startFrame: 0 }],
      totalFrames,
      'ctl-full.wav',
    );
    const ctlMusic = await render(
      root,
      makeProject(
        [
          assetClip('musicA', 'musicAsset', 0.3, undefined, totalSamples),
          assetClip('musicB', 'musicBAsset', 0.2, undefined, totalSamples),
        ],
        assets,
      ),
      [],
      totalFrames,
      'ctl-music.wav',
    );
    const ctlSfx = await render(
      root,
      makeProject([], assets),
      [{ path: sfxPath, startFrame: 0 }],
      totalFrames,
      'ctl-sfx.wav',
    );

    assert.deepEqual(programme, ctlFull, 'the programme mix must contain every member (routed or not)');
    assert.deepEqual(stemMusic, ctlMusic, 'the music stem must contain exactly its two grouped members');
    assert.deepEqual(stemSfx, ctlSfx, 'the sfx stem must contain exactly its one kept member');
    assert.notDeepEqual(stemMusic, stemSfx, 'the two stems must be distinct');
    assert.notDeepEqual(programme, stemMusic, 'a grouped stem is a subset of the full programme mix, not equal to it');

    // The kept placement also appears in the full programme mix (a stem never
    // subtracts audio from it): programme carries the sfx kept audio too.
    const fullWithoutKept = await render(
      root,
      makeProject(
        [
          assetClip('prog', 'progAsset', 0.3, undefined, totalSamples),
          assetClip('musicA', 'musicAsset', 0.3, undefined, totalSamples),
          assetClip('musicB', 'musicBAsset', 0.2, undefined, totalSamples),
        ],
        assets,
      ),
      [],
      totalFrames,
      'ctl-no-kept.wav',
    );
    assert.notDeepEqual(programme, fullWithoutKept, 'the routed kept placement must remain in the full programme mix');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the programme mix is byte-identical to the same project with all bus labels removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-stems-programme-'));
  try {
    const totalFrames = 30;
    const totalSamples = framesToSamples(totalFrames, FPS30, 48000, 'ceil');
    const progAsset = await signalAsset(root, 'progAsset', 150, totalSamples);
    const musicAsset = await signalAsset(root, 'musicAsset', 300, totalSamples);
    const assets: Project['assets'] = [progAsset, musicAsset];
    const withBuses = makeProject(
      [
        assetClip('prog', 'progAsset', 0.25, undefined, totalSamples),
        assetClip('music', 'musicAsset', 0.2, 'music', totalSamples),
      ],
      assets,
    );
    // The same project with every `bus` label stripped from every clip.
    const stripped = makeProject(
      [
        assetClip('prog', 'progAsset', 0.25, undefined, totalSamples),
        assetClip('music', 'musicAsset', 0.2, undefined, totalSamples),
      ],
      assets,
    );

    assert.deepEqual(
      await render(root, withBuses, [], totalFrames, 'programme-a.wav'),
      await render(root, stripped, [], totalFrames, 'programme-b.wav'),
      'bus labels must not change what the programme mix contains',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a bus with no members is a loud error and writes no stem', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-stems-empty-'));
  try {
    const totalSamples = framesToSamples(30, FPS30, 48000, 'ceil');
    const progAsset = await signalAsset(root, 'progAsset', 120, totalSamples);
    const project = makeProject([assetClip('prog', 'progAsset', 0.3, undefined, totalSamples)], [progAsset]);
    const destination = join(root, 'ghost.wav');
    await assert.rejects(
      mixAudio(root, project, [], 30, destination, undefined, 'ghost'),
      /bus "ghost" has no members/,
    );
    await assert.rejects(readFile(destination), /ENOENT/, 'an empty bus must not produce a WAV');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('schema accepts a bus only where it is meaningful', () => {
  const base = { id: 'p', shot: 'shot', source: 'src', inFrame: 0, outFrame: 10, startFrame: 0 };
  assert.doesNotThrow(
    () => PlacementSchema.parse({ ...base, audio: 'keep', bus: 'dialogue' }),
    'a kept placement may route its native audio',
  );
  assert.doesNotThrow(() => PlacementSchema.parse({ ...base, audio: 'keep' }));
  assert.doesNotThrow(() => PlacementSchema.parse({ ...base, audio: 'mute' }));
  assert.throws(
    () => PlacementSchema.parse({ ...base, audio: 'mute', bus: 'dialogue' }),
    /bus is only meaningful/,
    'a muted placement cannot route native audio',
  );
  assert.throws(() => PlacementSchema.parse({ ...base, audio: 'keep', bus: 'bad bus!' }), 'bus must be a safe Id');

  // The project surface enforces the same rule and accepts bus on every clip kind.
  const totalSamples = framesToSamples(30, FPS30, 48000, 'ceil');
  const signal: Project['assets'][number] = {
    id: 'signal',
    revision: 1,
    path: 'signal.wav',
    sha256: 'a'.repeat(64),
    type: 'audio',
    rights: { origin: 'generated test signal', license: 'CC0-1.0', redistributable: true },
    simulated: false,
  };
  const clips: Clip[] = [assetClip('t', 'signal', 0.2, 'music', totalSamples)];
  assert.doesNotThrow(() => validateProject(makeProject(clips, [signal])));

  const muted = makeProject(clips, [signal]);
  muted.composition!.placements[0].bus = 'dialogue';
  assert.throws(
    () => validateProject(muted),
    /bus is only meaningful/,
    'ProjectSchema rejects a bus on a muted placement',
  );

  // A built stem artifact persists its bus label for downstream consumers; the
  // label is optional (programme artifacts carry none) and must still be a safe Id.
  const artifact = {
    id: 'a',
    path: 'stem.wav',
    sha256: 'a'.repeat(64),
    kind: 'audio' as const,
    simulated: false,
    operation: 'mix-stem',
    inputs: [],
    backend: 'ffmpeg',
  };
  assert.equal(ArtifactSchema.parse({ ...artifact, bus: 'music' }).bus, 'music');
  assert.equal(ArtifactSchema.parse(artifact).bus, undefined);
  assert.throws(
    () => ArtifactSchema.parse({ ...artifact, bus: 'bad bus!' }),
    'an artifact bus label must be a safe Id',
  );
});
