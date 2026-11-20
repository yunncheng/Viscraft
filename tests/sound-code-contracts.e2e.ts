/**
 * Fast, direct verification of code-authored sound Sources and `sound` audio clips.
 *
 * These tests exercise the REAL schema / validateProject / mixAudio code paths with
 * a hand-built Project. The parts that only need the schema and the mixer's
 * pre-decode validation never shell out; the parts that actually decode a `sound`
 * Take necessarily invoke FFmpeg (the mixer decodes every Take through
 * `decodePcm`), so those are gated on FFmpeg being present.
 *
 * What is asserted, from measured values rather than symbol existence:
 *  - a `sound` Source and a `sound` clip validate through the real ProjectSchema
 *    and validateProject, with the documented defaults applied;
 *  - a `sound` clip whose `source` is missing or refers to a non-sound Source is
 *    rejected, and the clip accepts no `inSample`/`durationSamples`;
 *  - fades and gain/pan automation are bounded by the Source's native sample
 *    span (`durationSamples`), not a clip length or a picture frame clock;
 *  - mixAudio refuses a `sound` clip with no rendered Take, and with a map to a
 *    real PCM16 WAV it places, gains and hard-pans the sound from the PCM bytes;
 *  - a sound-only overload still trips the full-scale guard;
 *  - asset-only projects validate and mix with no sound Source, and an unsupported
 *    `tone` clip is rejected by the strict schema.
 *
 * No subjective listening claim is made: every number is recovered from the
 * encoded PCM16 bytes the mixer writes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { mixAudio } from '../src/backends/media/audio-mix.js';
import { ProjectSchema, type Composition, type OutputSettings, type Project } from '../src/core/schema.js';
import { validateProject } from '../src/project/project.js';
import { framesToSamples } from '../src/core/time.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';

const FPS30 = { numerator: 30, denominator: 1 } as const;
const STEREO: OutputSettings = { width: 64, height: 48, fps: FPS30, sampleRate: 48000, channels: 2 };
const FRAMES = 30;
const SAMPLES = framesToSamples(FRAMES, FPS30, 48000, 'ceil'); // 48000 exactly

type SoundSource = Extract<Project['sources'][number], { kind: 'browser'; output: 'sound' }>;
type SoundClip = Extract<Composition['audio'][number], { kind: 'source' }>;

/** A minimal schema-valid picture Source so placements resolve (mixAudio ignores it). */
const CODE = {
  id: 'scene',
  kind: 'browser',
  output: 'picture',
  entry: 'scene.html',
  resources: [],
  bindings: [],
  params: {},
  seed: 0,
  frames: FRAMES,
};

function soundSource(overrides: Partial<SoundSource> = {}): SoundSource {
  return {
    id: 'snd',
    kind: 'browser',
    output: 'sound',
    entry: 'sound.html',
    resources: [],
    bindings: [],
    params: {},
    seed: 0,
    durationSamples: SAMPLES,
    sampleRate: 48000,
    ...overrides,
  };
}

function soundClip(overrides: Partial<SoundClip> = {}): SoundClip {
  return {
    id: 'clip',
    kind: 'source',
    source: 'snd',
    startSample: 0,
    gain: 1,
    fadeInSamples: 0,
    fadeOutSamples: 0,
    ...overrides,
  };
}

interface RawWork {
  output?: OutputSettings;
  sources: unknown[];
  audio: unknown[];
  assets?: unknown[];
  frames?: number;
}

/** A schema-shaped Project object (parsed with ProjectSchema to apply defaults). */
function rawWork(options: RawWork): unknown {
  const frames = options.frames ?? FRAMES;
  const output = options.output ?? STEREO;
  return {
    schemaVersion: 1,
    id: 'sound-code-unit',
    revision: 1,
    title: 'Code-authored sound unit',
    direction: { intent: 'code-authored sound', looks: [{ id: 'look', description: 'identity' }], transitions: [] },
    assets: options.assets ?? [],
    bindings: {},
    sources: options.sources,
    composition: {
      output,
      scenes: [{ id: 'scene', description: 'sound' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: 'code-authored sound', targetFrames: frames }],
      placements: [
        { id: 'edit', shot: 'shot', source: 'scene', inFrame: 0, outFrame: frames, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio: options.audio,
    },
  };
}

function work(audio: unknown[], sources: unknown[] = [CODE, soundSource()], assets: unknown[] = []): Project {
  return ProjectSchema.parse(rawWork({ sources, audio, assets }));
}

async function tempDir(): Promise<string> {
  return fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-sound-unit-'));
}

/** Raw stereo PCM16 WAV with a constant left/right value; no FFmpeg is used to write it. */
function stereoPcm16Wav(left: number, right: number, frames: number, sampleRate = 48000): Buffer {
  const dataBytes = frames * 2 * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  const l = Math.round(left * 32767),
    r = Math.round(right * 32767);
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(l, 44 + i * 4);
    buf.writeInt16LE(r, 44 + i * 4 + 2);
  }
  return buf;
}

interface Wav16 {
  sampleRate: number;
  channels: number;
  samples: Int16Array;
}

function readWav16(bytes: Buffer): Wav16 {
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

async function mixAndRead(
  root: string,
  project: Project,
  name: string,
  soundTakes?: ReadonlyMap<string, string>,
): Promise<Wav16> {
  const destination = nodePath.join(root, name);
  await mixAudio(root, project, [], FRAMES, destination, soundTakes);
  return readWav16(await fs.readFile(destination));
}

function channelValue(wav: Wav16, channel: number, sample: number): number {
  return wav.samples[sample * wav.channels + channel] / 32768;
}

function assertClose(actual: number, expected: number, tolerance = 2e-3, label = 'value'): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ±${tolerance}, got ${actual}`);
}

const ffmpegAvailable = await runCommand('ffmpeg', ['-version']).then(
  () => true,
  () => false,
);
const decodeSkip = ffmpegAvailable ? false : 'needs FFmpeg to decode a rendered sound Take';

// ---------------------------------------------------------------------------
// 1. Schema + validateProject contract for sound Sources and clips
// ---------------------------------------------------------------------------

test('a sound Source and clip validate through the real schema; missing/non-sound sources are rejected', () => {
  const parsed = ProjectSchema.parse(rawWork({ sources: [CODE, soundSource()], audio: [soundClip()] }));
  const source = parsed.sources.find(candidate => candidate.id === 'snd');
  if (!source || source.kind !== 'browser' || source.output !== 'sound')
    throw new Error('expected the parsed sound Source');
  assert.deepEqual(source.resources, [], 'resources must default to []');
  assert.deepEqual(source.params, {}, 'params must default to {}');
  assert.equal(source.seed, 0, 'seed must default to 0');
  assert.equal(source.entry, 'sound.html');
  assert.doesNotThrow(() => validateProject(parsed), 'a sound Source + sound clip must validate');

  const missing = ProjectSchema.parse(
    rawWork({ sources: [CODE, soundSource()], audio: [soundClip({ source: 'nope' })] }),
  );
  assert.throws(() => validateProject(missing), /missing sound Source/, 'a missing sound Source must be rejected');

  const wrongKind = ProjectSchema.parse(
    rawWork({ sources: [CODE, soundSource()], audio: [soundClip({ source: 'scene' })] }),
  );
  assert.throws(() => validateProject(wrongKind), /missing sound Source/, 'a non-sound Source must be rejected');

  // Only current audio clip kinds are accepted.
  assert.throws(
    () =>
      ProjectSchema.parse(
        rawWork({
          sources: [CODE],
          audio: [
            {
              id: 'unsupported_tone',
              kind: 'tone',
              frequency: 440,
              startSample: 0,
              durationSamples: SAMPLES,
              gain: 0.5,
            },
          ],
        }),
      ),
    /invalid discriminator/i,
    'a tone clip must be rejected by the current schema',
  );

  // The clip owns no inSample/durationSamples; strict schemas reject those extra fields.
  assert.throws(
    () =>
      ProjectSchema.parse(
        rawWork({ sources: [CODE, soundSource()], audio: [{ ...soundClip(), durationSamples: 10 }] }),
      ),
    'a sound clip must not accept durationSamples',
  );
  assert.throws(
    () => ProjectSchema.parse(rawWork({ sources: [CODE, soundSource()], audio: [{ ...soundClip(), inSample: 0 }] })),
    'a sound clip must not accept inSample',
  );
  // gain is required and bounded by the schema.
  assert.throws(
    () =>
      ProjectSchema.parse(
        rawWork({
          sources: [CODE, soundSource()],
          audio: [{ id: 'clip', kind: 'source', source: 'snd', startSample: 0 }],
        }),
      ),
    'gain is required',
  );
  assert.throws(
    () => ProjectSchema.parse(rawWork({ sources: [CODE, soundSource()], audio: [soundClip({ gain: 3 })] })),
    'gain above 2 is rejected',
  );
});

// ---------------------------------------------------------------------------
// 2. Fades and automation are bounded by the Source-derived rendered length
// ---------------------------------------------------------------------------

test('sound clip fades and automation are bounded by the Source-derived rendered length', async () => {
  const root = await tempDir();
  try {
    const rendered = framesToSamples(FRAMES, FPS30, 48000, 'ceil');
    assert.equal(rendered, SAMPLES, 'the rendered length must be the canonical ceil sample span');

    const tooManyFades = ProjectSchema.parse(
      rawWork({ sources: [CODE, soundSource()], audio: [soundClip({ fadeInSamples: rendered, fadeOutSamples: 1 })] }),
    );
    assert.throws(
      () => validateProject(tooManyFades),
      /Fades exceed/,
      'fades longer than the rendered Take must be rejected',
    );

    const okFades = ProjectSchema.parse(
      rawWork({
        sources: [CODE, soundSource()],
        audio: [soundClip({ fadeInSamples: rendered - 1, fadeOutSamples: 0 })],
      }),
    );
    assert.doesNotThrow(() => validateProject(okFades), 'fades exactly inside the rendered Take are accepted');

    // A source that renders longer allows a longer fade; the bound follows the Source.
    const longer = ProjectSchema.parse(
      rawWork({
        sources: [CODE, soundSource({ durationSamples: SAMPLES * 2 })],
        audio: [soundClip({ fadeInSamples: rendered, fadeOutSamples: 0 })],
      }),
    );
    assert.doesNotThrow(() => validateProject(longer), 'the fade bound must follow the Source sample span');

    const gainAuto = ProjectSchema.parse(
      rawWork({ sources: [CODE, soundSource()], audio: [soundClip({ automation: [{ sample: rendered, gain: 1 }] })] }),
    );
    assert.throws(
      () => validateProject(gainAuto),
      /Gain automation for/,
      'gain automation at the bound must be rejected',
    );
    const gainAutoOk = ProjectSchema.parse(
      rawWork({
        sources: [CODE, soundSource()],
        audio: [soundClip({ automation: [{ sample: rendered - 1, gain: 0.5 }] })],
      }),
    );
    assert.doesNotThrow(() => validateProject(gainAutoOk), 'gain automation inside the bound is accepted');

    const panAuto = ProjectSchema.parse(
      rawWork({
        sources: [CODE, soundSource()],
        audio: [soundClip({ panAutomation: [{ sample: rendered, pan: 1 }] })],
      }),
    );
    assert.throws(() => validateProject(panAuto), /Pan automation for/, 'pan automation at the bound must be rejected');

    // mixAudio independently rejects the same out-of-bounds automation BEFORE
    // it needs a rendered Take (no FFmpeg needed for this failure).
    await assert.rejects(
      mixAudio(
        root,
        ProjectSchema.parse(
          rawWork({
            sources: [CODE, soundSource()],
            audio: [soundClip({ automation: [{ sample: rendered, gain: 1 }] })],
          }),
        ),
        [],
        FRAMES,
        nodePath.join(root, 'auto.wav'),
      ),
      /invalid local gain automation/,
    );
    await assert.rejects(
      fs.readFile(nodePath.join(root, 'auto.wav')),
      /ENOENT/,
      'a rejected automation must not write a destination',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. mixAudio refuses a sound clip with no rendered Take
// ---------------------------------------------------------------------------

test('mixAudio refuses a sound clip whose Source has not been built into a Take', async () => {
  const root = await tempDir();
  try {
    const destination = nodePath.join(root, 'no-take.wav');
    await assert.rejects(
      mixAudio(root, work([soundClip()]), [], FRAMES, destination),
      /no rendered Take|build the sound Source/,
      'a sound clip without a rendered Take must be refused',
    );
    await assert.rejects(fs.readFile(destination), /ENOENT/, 'a refused mix must not write a destination');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. With a rendered Take, placement / gain / hard-pan are exact
// ---------------------------------------------------------------------------

test('mixAudio places, gains and hard-pans a rendered sound Take from real PCM16', { skip: decodeSkip }, async () => {
  const root = await tempDir();
  try {
    const takePath = nodePath.join(root, 'snd.wav');
    await fs.writeFile(takePath, stereoPcm16Wav(0.5, 0.25, SAMPLES));
    const takes = new Map([['snd', takePath]]);

    const flat = await mixAndRead(root, work([soundClip({ startSample: 0, gain: 1 })]), 'flat.wav', takes);
    assert.equal(flat.channels, 2);
    assert.equal(flat.sampleRate, 48000);
    assert.equal(flat.samples.length / 2, SAMPLES, 'the mix must span the full ceil sample count');
    assertClose(channelValue(flat, 0, 1000), 0.5, 2e-3, 'unity-gain left');
    assertClose(channelValue(flat, 1, 1000), 0.25, 2e-3, 'unity-gain right');

    const half = await mixAndRead(root, work([soundClip({ startSample: 0, gain: 0.5 })]), 'half.wav', takes);
    assertClose(channelValue(half, 0, 1000), 0.25, 2e-3, 'half-gain left');
    assertClose(channelValue(half, 1, 1000), 0.125, 2e-3, 'half-gain right');

    const placed = await mixAndRead(root, work([soundClip({ startSample: 16000, gain: 1 })]), 'placed.wav', takes);
    assert.equal(channelValue(placed, 0, 100), 0, 'samples before startSample must stay silent');
    assert.equal(channelValue(placed, 1, 15999), 0, 'the last sample before startSample must stay silent');
    assertClose(channelValue(placed, 0, 16000), 0.5, 2e-3, 'the clip must begin exactly at startSample');
    assertClose(channelValue(placed, 1, 47000), 0.25, 2e-3, 'the clip must continue to the mix end');

    // Hard pan uses constant-power gains: pan -1 sends channel 0 of the take to L only.
    const hardLeft = await mixAndRead(root, work([soundClip({ gain: 1, pan: -1 })]), 'left.wav', takes);
    assertClose(channelValue(hardLeft, 0, 1000), 0.5, 2e-3, 'hard-left must carry the take in L');
    assert.ok(
      Math.abs(channelValue(hardLeft, 1, 1000)) <= 2e-3,
      `hard-left R must be silent, got ${channelValue(hardLeft, 1, 1000)}`,
    );

    const hardRight = await mixAndRead(root, work([soundClip({ gain: 1, pan: 1 })]), 'right.wav', takes);
    assert.ok(
      Math.abs(channelValue(hardRight, 0, 1000)) <= 2e-3,
      `hard-right L must be silent, got ${channelValue(hardRight, 0, 1000)}`,
    );
    assertClose(channelValue(hardRight, 1, 1000), 0.25, 2e-3, 'hard-right must carry the take in R');

    // A mix that clips is rejected loudly and writes nothing.
    const overload = nodePath.join(root, 'over.wav');
    await assert.rejects(
      mixAudio(
        root,
        work([soundClip({ id: 'a', gain: 2 }), soundClip({ id: 'b', gain: 2 })]),
        [],
        FRAMES,
        overload,
        takes,
      ),
      /overload|lower clip gains/,
    );
    await assert.rejects(fs.readFile(overload), /ENOENT/, 'an overloaded mix must not write a destination');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. Asset clips still validate and mix with no sound Source
// ---------------------------------------------------------------------------

test('an asset audio clip validates and mixes without any sound Source', { skip: decodeSkip }, async () => {
  const root = await tempDir();
  try {
    const assetPath = nodePath.join(root, 'bed.wav');
    await fs.writeFile(assetPath, stereoPcm16Wav(0.5, 0.25, SAMPLES));
    const asset = {
      id: 'bed',
      revision: 1,
      path: 'bed.wav',
      sha256: await hashFile(assetPath),
      type: 'audio',
      rights: { origin: 'test', license: 'test-only', redistributable: false },
    };
    const assetWork = ProjectSchema.parse(
      rawWork({
        sources: [CODE],
        assets: [asset],
        audio: [
          {
            id: 'bedClip',
            kind: 'asset',
            asset: 'bed',
            inSample: 0,
            startSample: 0,
            durationSamples: SAMPLES,
            gain: 1,
            fadeInSamples: 0,
            fadeOutSamples: 0,
          },
        ],
      }),
    );
    assert.doesNotThrow(() => validateProject(assetWork));
    const wav = await mixAndRead(root, assetWork, 'asset.wav');
    assertClose(channelValue(wav, 0, 1000), 0.5, 2e-3, 'asset left');
    assertClose(channelValue(wav, 1, 1000), 0.25, 2e-3, 'asset right');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
