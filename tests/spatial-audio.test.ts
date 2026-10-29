/**
 * Fast, direct verification of the constant-power stereo pan law in `mixAudio`.
 *
 * These tests call the real `mixAudio` implementation with a hand-built Project
 * and decode the PCM16 WAV it writes by reading the RIFF bytes themselves — no
 * browser is invoked (an authored signal Asset is decoded by FFmpeg).
 *
 * What is asserted, from measured samples rather than symbol existence:
 *  - hard-left writes energy only into channel 0, hard-right only into channel 1;
 *  - a centred spatial clip and a no-pan clip both split equally, but the
 *    spatial centre is exactly -3.01 dB per channel (1/sqrt2) below the no-pan
 *    full-amplitude centre, and gL^2 + gR^2 == 1 for every authored position;
 *  - a panAutomation sweep -1 -> +1 is left-dominant early and right-dominant late
 *    and holds at both endpoints;
 *  - a mono output rejects any pan / panAutomation before writing a file, while a
 *    mono clip with no pan still mixes;
 *  - an out-of-range or non-increasing panAutomation is rejected by both
 *    validateProject and mixAudio, and an empty automation is rejected by schema;
 *  - panning does not mask the existing overload guard (|v| > 1 still throws);
 *  - a short original `code` + asset project validates through the real Project
 *    schema and produces a mix whose two channels genuinely differ.
 *
 * Sign convention measured here: pan = -1 is hard left, +1 is hard right, so a
 * negative pan puts more energy in channel 0. No subjective listening claim is
 * made; every number is recovered from the encoded PCM.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { mixAudio } from '../src/backends/media/audio-mix.js';
import { ProjectSchema } from '../src/core/schema.js';
import type { Composition, OutputSettings, Project } from '../src/core/schema.js';
import { validateProject } from '../src/project/project.js';
import { framesToSamples } from '../src/core/time.js';
import { writeSignalAsset } from './audio-fixtures.js';

const FPS30 = { numerator: 30, denominator: 1 } as const;
const STEREO: OutputSettings = { width: 64, height: 48, fps: FPS30, sampleRate: 48000, channels: 2 };
const MONO: OutputSettings = { ...STEREO, channels: 1 };
const FRAMES = 30;
const SAMPLES = framesToSamples(FRAMES, FPS30, 48000, 'ceil'); // 48000 exactly

type AssetClip = Extract<Composition['audio'][number], { kind: 'asset' }>;

/** Write a full-scale 440 Hz signal at the real output rate and channel count. */
function writeSpatialAsset(root: string, channels: 1 | 2): Promise<Project['assets'][number]> {
  return writeSignalAsset(root, {
    id: 'signal',
    path: 'signal.wav',
    sampleRate: 48000,
    channels,
    samples: SAMPLES,
  });
}

/** A 0.5-gain asset clip covering the whole 1 s mix. */
function signalClip(asset: string, overrides: Partial<AssetClip> = {}): AssetClip {
  return {
    id: 'signal',
    kind: 'asset',
    asset,
    inSample: 0,
    startSample: 0,
    durationSamples: SAMPLES,
    gain: 0.5,
    fadeInSamples: 0,
    fadeOutSamples: 0,
    ...overrides,
  };
}

/** A minimal but fully schema-valid Project whose audio is the only thing under test. */
function spatialProject(
  output: OutputSettings,
  audio: Composition['audio'],
  frames = FRAMES,
  assets: Project['assets'] = [],
): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'spatial-audio-unit',
    revision: 1,
    title: 'Spatial audio unit work',
    direction: {
      intent: 'constant-power stereo pan law',
      looks: [{ id: 'look', description: 'identity' }],
      transitions: [],
    },
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
        frames,
      },
    ],
    composition: {
      output,
      scenes: [{ id: 'scene', description: 'spatial' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: 'spatial sound', targetFrames: frames }],
      placements: [
        { id: 'edit', shot: 'shot', source: 'scene', inFrame: 0, outFrame: frames, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio,
    },
  });
}

async function tempDir(): Promise<string> {
  return fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-spatial-unit-'));
}

/** Run the real mix and read back the raw RIFF bytes (never shelling out). */
async function mixAndRead(root: string, project: Project, frames: number, name: string) {
  const destination = nodePath.join(root, name);
  await mixAudio(root, project, [], frames, destination);
  return readWav16(await fs.readFile(destination));
}

function readWav16(bytes: Buffer): { sampleRate: number; channels: number; samples: Int16Array } {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  assert.equal(bytes.readUInt16LE(20), 1, 'mix output must be linear PCM');
  const channels = bytes.readUInt16LE(22);
  const sampleRate = bytes.readUInt32LE(24);
  const dataBytes = bytes.readUInt32LE(40);
  const count = Math.floor(dataBytes / 2);
  assert.equal(bytes.length, 44 + count * 2, 'WAV must carry exactly its declared PCM payload');
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i++) samples[i] = bytes.readInt16LE(44 + i * 2);
  return { sampleRate, channels, samples };
}

/** RMS of one channel over the half-open sample window [from, to). */
function channelRms(samples: Int16Array, channels: number, channel: number, from: number, to: number): number {
  let sum = 0;
  for (let s = from; s < to; s++) {
    const v = samples[s * channels + channel] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / (to - from));
}

const RMS_EPS = 1e-4;
const HALF_AMP_RMS = 0.5 / Math.SQRT2; // a no-pan 0.5-gain sine, one channel
const CENTRE_POWER_RMS = HALF_AMP_RMS / Math.SQRT2; // constant-power centre = -3.01 dB per channel

// ---------------------------------------------------------------------------
// 1. Constant-power pan law: hard left / hard right / centre / no-pan
// ---------------------------------------------------------------------------

test('mixAudio constant-power law: hard L/R, spatial centre (-3.01 dB) and no-pan', async () => {
  const root = await tempDir();
  try {
    const asset = await writeSpatialAsset(root, 2);
    const from = 2000;
    const to = SAMPLES - 2000;
    const cases: Array<{ name: string; pan?: number }> = [
      { name: 'hardLeft', pan: -1 },
      { name: 'hardRight', pan: 1 },
      { name: 'centre', pan: 0 },
      { name: 'noPan' },
    ];
    const measured = new Map<string, { l: number; r: number }>();
    for (const item of cases) {
      const clip = signalClip(asset.id, { id: item.name, ...(item.pan !== undefined ? { pan: item.pan } : {}) });
      const wav = await mixAndRead(root, spatialProject(STEREO, [clip], FRAMES, [asset]), FRAMES, `${item.name}.wav`);
      assert.equal(wav.channels, 2);
      measured.set(item.name, {
        l: channelRms(wav.samples, 2, 0, from, to),
        r: channelRms(wav.samples, 2, 1, from, to),
      });
    }
    const hardLeft = measured.get('hardLeft')!;
    const hardRight = measured.get('hardRight')!;
    const centre = measured.get('centre')!;
    const noPan = measured.get('noPan')!;

    // Hard left / hard right concentrate all energy in a single channel.
    assert.ok(hardLeft.l > 0.3, `hard-left left channel must carry the signal (got ${hardLeft.l})`);
    assert.ok(hardLeft.r < RMS_EPS, `hard-left right channel must be silent (got ${hardLeft.r})`);
    assert.ok(hardRight.r > 0.3, `hard-right right channel must carry the signal (got ${hardRight.r})`);
    assert.ok(hardRight.l < RMS_EPS, `hard-right left channel must be silent (got ${hardRight.l})`);

    // Spatial centre and no-pan both split equally...
    assert.ok(Math.abs(centre.l - centre.r) < 0.005, `spatial centre must be equal (${centre.l} vs ${centre.r})`);
    assert.ok(Math.abs(noPan.l - noPan.r) < 0.005, `no-pan output must be equal (${noPan.l} vs ${noPan.r})`);
    // ...but the spatial centre is -3.01 dB (1/sqrt2) per channel, while the
    // no-pan clip keeps the full-amplitude level with no 3 dB loss.
    assert.ok(
      Math.abs(noPan.l - HALF_AMP_RMS) < 0.005,
      `no-pan per-channel RMS must stay ${HALF_AMP_RMS} (got ${noPan.l})`,
    );
    assert.ok(
      Math.abs(centre.l - CENTRE_POWER_RMS) < 0.005,
      `spatial centre per-channel RMS must be ${CENTRE_POWER_RMS} (got ${centre.l})`,
    );
    assert.ok(centre.l < noPan.l * 0.8, `spatial centre must be ~3 dB below no-pan (${centre.l} vs ${noPan.l})`);

    // Constant power: gL^2 + gR^2 == 1 for every authored position.
    for (const [name, m] of measured) {
      if (name === 'noPan') continue;
      assert.ok(
        Math.abs(m.l * m.l + m.r * m.r - 0.125) < 0.006,
        `${name}: gL^2+gR^2 must stay constant (${m.l ** 2 + m.r ** 2})`,
      );
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. panAutomation sweep with endpoint holds
// ---------------------------------------------------------------------------

test('mixAudio panAutomation sweeps left to right and holds at both endpoints', async () => {
  const root = await tempDir();
  try {
    const asset = await writeSpatialAsset(root, 2);
    const clip = signalClip(asset.id, {
      panAutomation: [
        { sample: 2000, pan: -1 },
        { sample: 46000, pan: 1 },
      ],
    });
    const wav = await mixAndRead(root, spatialProject(STEREO, [clip], FRAMES, [asset]), FRAMES, 'sweep.wav');
    const rms = (c: number, from: number, to: number) => channelRms(wav.samples, 2, c, from, to);

    // Held at -1 before the first point: channel 1 is silent, channel 0 full.
    assert.ok(rms(1, 0, 2000) < RMS_EPS, `pre-sweep hold must stay hard left (right ${rms(1, 0, 2000)})`);
    assert.ok(Math.abs(rms(0, 0, 2000) - HALF_AMP_RMS) < 0.006, 'pre-sweep hold must keep full left level');
    // Held at +1 after the last point: channel 0 silent, channel 1 full.
    assert.ok(
      rms(0, 46000, SAMPLES) < RMS_EPS,
      `post-sweep hold must stay hard right (left ${rms(0, 46000, SAMPLES)})`,
    );
    assert.ok(Math.abs(rms(1, 46000, SAMPLES) - HALF_AMP_RMS) < 0.006, 'post-sweep hold must keep full right level');

    // First window is left-dominant and last window is right-dominant.
    assert.ok(
      rms(0, 0, 4800) > 2 * rms(1, 0, 4800),
      `first window must be left-dominant (${rms(0, 0, 4800)} vs ${rms(1, 0, 4800)})`,
    );
    assert.ok(
      rms(1, 43200, SAMPLES) > 2 * rms(0, 43200, SAMPLES),
      `last window must be right-dominant (${rms(1, 43200, SAMPLES)} vs ${rms(0, 43200, SAMPLES)})`,
    );
    // The middle of the sweep crosses centre.
    assert.ok(Math.abs(rms(0, 22800, 25200) - rms(1, 22800, 25200)) < 0.03, 'the sweep midpoint must be near centred');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Mono output rejects pan; a mono clip with no pan still mixes
// ---------------------------------------------------------------------------

test('mixAudio rejects any pan on a mono output and still mixes a mono no-pan clip', async () => {
  const root = await tempDir();
  try {
    const asset = await writeSpatialAsset(root, 1);
    const panned = nodePath.join(root, 'panned-mono.wav');
    await assert.rejects(
      mixAudio(root, spatialProject(MONO, [signalClip(asset.id, { pan: 0 })], FRAMES, [asset]), [], FRAMES, panned),
      /2-channel|stereo pan/,
    );
    await assert.rejects(fs.readFile(panned), /ENOENT/, 'a rejected pan must not write a destination');

    const automated = nodePath.join(root, 'automated-mono.wav');
    await assert.rejects(
      mixAudio(
        root,
        spatialProject(
          MONO,
          [
            signalClip(asset.id, {
              panAutomation: [
                { sample: 0, pan: -0.5 },
                { sample: 23999, pan: 0.5 },
              ],
            }),
          ],
          FRAMES,
          [asset],
        ),
        [],
        FRAMES,
        automated,
      ),
      /2-channel|stereo pan/,
    );
    await assert.rejects(fs.readFile(automated), /ENOENT/, 'a rejected panAutomation must not write a destination');

    const clean = await mixAndRead(
      root,
      spatialProject(MONO, [signalClip(asset.id)], FRAMES, [asset]),
      FRAMES,
      'mono.wav',
    );
    assert.equal(clean.channels, 1);
    assert.ok(
      channelRms(clean.samples, 1, 0, 2000, SAMPLES - 2000) > 0.3,
      'a mono clip without pan must still mix normally',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. panAutomation validation (out of range / non-increasing) and schema length
// ---------------------------------------------------------------------------

test('panAutomation sample bounds and ordering are rejected by validateProject and mixAudio', async () => {
  const root = await tempDir();
  try {
    const asset = await writeSpatialAsset(root, 2);
    const outOfRange = spatialProject(
      STEREO,
      [signalClip(asset.id, { panAutomation: [{ sample: SAMPLES, pan: 0 }] })],
      FRAMES,
      [asset],
    );
    assert.throws(() => validateProject(outOfRange), /Pan automation/i);
    await assert.rejects(
      mixAudio(root, outOfRange, [], FRAMES, nodePath.join(root, 'range.wav')),
      /invalid local pan automation/,
    );

    const nonIncreasing = spatialProject(
      STEREO,
      [
        signalClip(asset.id, {
          panAutomation: [
            { sample: 10, pan: -1 },
            { sample: 10, pan: 1 },
          ],
        }),
      ],
      FRAMES,
      [asset],
    );
    assert.throws(() => validateProject(nonIncreasing), /Pan automation/i);
    await assert.rejects(
      mixAudio(root, nonIncreasing, [], FRAMES, nodePath.join(root, 'order.wav')),
      /invalid local pan automation/,
    );
    await assert.rejects(fs.readFile(nodePath.join(root, 'range.wav')), /ENOENT/);
    await assert.rejects(fs.readFile(nodePath.join(root, 'order.wav')), /ENOENT/);

    // The schema itself bounds the array length (min 1) and the pan range.
    assert.throws(
      () => spatialProject(STEREO, [signalClip(asset.id, { panAutomation: [] })], FRAMES, [asset]),
      'an empty panAutomation is rejected',
    );
    assert.throws(
      () => spatialProject(STEREO, [signalClip(asset.id, { pan: 1.5 })], FRAMES, [asset]),
      'pan outside [-1, 1] is rejected',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. Panning does not mask the existing overload guard
// ---------------------------------------------------------------------------

test('panning does not mask the full-scale overload guard', async () => {
  const root = await tempDir();
  try {
    const asset = await writeSpatialAsset(root, 2);
    const hot = (id: string): AssetClip => signalClip(asset.id, { id, gain: 1, pan: -1 });
    // Two identical hard-left full-gain clips sum to amplitude 2 in channel 0.
    const overloaded = nodePath.join(root, 'over.wav');
    await assert.rejects(
      mixAudio(root, spatialProject(STEREO, [hot('a'), hot('b')], FRAMES, [asset]), [], FRAMES, overloaded),
      /overload|lower clip gains/,
    );
    await assert.rejects(fs.readFile(overloaded), /ENOENT/, 'an overloaded mix must not write a destination');

    // A single full-gain hard-left clip stays exactly within full scale.
    const single = await mixAndRead(root, spatialProject(STEREO, [hot('a')], FRAMES, [asset]), FRAMES, 'single.wav');
    assert.ok(
      Math.abs(channelRms(single.samples, 2, 0, 2000, SAMPLES - 2000) - 1 / Math.SQRT2) < 0.01,
      'one hard-left full-gain clip peaks at 1.0, not above',
    );
    assert.ok(channelRms(single.samples, 2, 1, 2000, SAMPLES - 2000) < RMS_EPS, 'the opposite channel stays silent');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. A short original code + asset project validates and builds a split mix
// ---------------------------------------------------------------------------

test('a short code + asset project with pan validates through the real schema and splits its channels', async () => {
  const root = await tempDir();
  try {
    const asset = await writeSpatialAsset(root, 2);
    const project = spatialProject(STEREO, [signalClip(asset.id, { pan: -0.5 })], FRAMES, [asset]);
    assert.doesNotThrow(() => validateProject(project), 'a panned clip must pass the real Project schema');
    const wav = await mixAndRead(root, project, FRAMES, 'split.wav');
    const left = channelRms(wav.samples, 2, 0, 2000, SAMPLES - 2000);
    const right = channelRms(wav.samples, 2, 1, 2000, SAMPLES - 2000);
    assert.ok(left > 2 * right, `pan -0.5 must favour the left channel (${left} vs ${right})`);
    assert.ok(right > 0.02, 'the quieter channel must still carry real energy');
    assert.ok(
      Math.abs(left * left + right * right - 0.125) < 0.01,
      'constant power must be preserved through the real schema',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
