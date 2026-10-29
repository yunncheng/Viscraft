/**
 * E2E: programme mix and grouped audio stems in the delivery bundle.
 *
 * The Build emits a `mix-audio` programme mix plus one `mix-stem` WAV per
 * declared bus. This test proves `deliverProject` surfaces them as a
 * self-contained `audio/` directory: the programme mix at `audio/programme.wav`
 * and each grouped stem at `audio/stems/<bus>.wav`, each hashed like every other
 * member, listed in `delivery-manifest.json` with `audio-stem` / `audio-programme`
 * provenance, and described in the static index — and that a project with no
 * audio at all adds none of it.
 *
 * The picture uses a `simulated` Source, so no Provider, browser or asset is
 * involved. FFmpeg is required (see `viscraft doctor`).
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildProject } from '../src/build/build.js';
import { deliverProject } from '../src/operations/delivery/delivery.js';
import { framesToSamples } from '../src/core/time.js';
import { hashFile } from '../src/shared/hash.js';
import { validateProject } from '../src/project/project.js';
import type { Composition, Project } from '../src/core/schema.js';
import { writeSignalAsset } from './audio-fixtures.js';

const FPS30 = { numerator: 30, denominator: 1 };
const OUTPUT = { width: 64, height: 48, fps: FPS30, sampleRate: 48000, channels: 2 } as const;
const TOTAL_FRAMES = 60; // 2 s at 30 fps
const TOTAL_SAMPLES = framesToSamples(TOTAL_FRAMES, FPS30, 48000, 'ceil');

type Clip = Composition['audio'][number];

function signalClip(id: string, asset: string, gain: number, bus?: string): Clip {
  return {
    id,
    kind: 'asset',
    asset,
    inSample: 0,
    startSample: 0,
    durationSamples: TOTAL_SAMPLES,
    gain,
    fadeInSamples: 0,
    fadeOutSamples: 0,
    ...(bus === undefined ? {} : { bus }),
  };
}

function makeSignal(root: string, id: string, frequency: number): Promise<Project['assets'][number]> {
  return writeSignalAsset(root, {
    id,
    path: `${id}.wav`,
    sampleRate: OUTPUT.sampleRate,
    channels: 2,
    samples: TOTAL_SAMPLES,
    frequency,
  });
}

/** One simulated shot with a two-bus score (plus an unrouted programme member) — or no audio at all. */
function makeProject(audio: Clip[], mastering = false, assets: Project['assets'] = []): Project {
  return validateProject({
    schemaVersion: 1,
    id: 'audio-delivery-e2e',
    revision: 1,
    title: 'Two-bus audio delivery',
    direction: {
      intent: 'Two grouped stems over a simulated flat picture',
      looks: [{ id: 'look', description: 'test pattern' }],
      transitions: [],
    },
    assets,
    bindings: {},
    sources: [
      {
        id: 'shotSource',
        kind: 'simulated',
        prompt: 'SIMULATED flat picture',
        frames: TOTAL_FRAMES,
        seed: 1,
        attempt: 'attempt-shot',
        behavior: 'success',
      },
    ],
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: 'Stems' }],
      shots: [
        { id: 'shot', scene: 'scene', look: 'look', intent: 'Flat picture, two-bus score', targetFrames: TOTAL_FRAMES },
      ],
      placements: [
        {
          id: 'edit',
          shot: 'shot',
          source: 'shotSource',
          inFrame: 0,
          outFrame: TOTAL_FRAMES,
          startFrame: 0,
          audio: 'mute',
        },
      ],
      transitions: [],
      ...(mastering ? { mastering: { targetLufs: -16, truePeakDbfs: -1 } } : {}),
      audio,
    },
  });
}

/** The runtime's canonical 44/16/le PCM WAV. */
function decodePcm16Wav(buffer: Buffer): { sampleRate: number; channels: number; samples: number } {
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buffer.toString('ascii', 8, 12), 'WAVE');
  let offset = 12;
  let fmt: { sampleRate: number; channels: number; bits: number } | undefined;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ')
      fmt = {
        sampleRate: buffer.readUInt32LE(body + 4),
        channels: buffer.readUInt16LE(body + 2),
        bits: buffer.readUInt16LE(body + 14),
      };
    else if (id === 'data') {
      dataOffset = body;
      dataLength = Math.min(size, buffer.length - body);
    }
    offset = body + size + (size % 2);
  }
  assert(fmt && dataOffset >= 0, 'canonical PCM WAV must expose fmt and data chunks');
  assert.equal(fmt.bits, 16, 'audio products must be PCM16');
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, samples: Math.floor(dataLength / (fmt.channels * 2)) };
}

test('deliverProject bundles the programme mix and one grouped stem per declared bus', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-audio-delivery-'));
  const root = join(parent, 'authoring');
  const destination = join(parent, 'bundle');
  try {
    await mkdir(root, { recursive: true });
    // Two buses ('music' groups two members, 'sfx' one) plus one unrouted member.
    const prog = await makeSignal(root, 'progAsset', 120);
    const musicA = await makeSignal(root, 'musicAAsset', 300);
    const musicB = await makeSignal(root, 'musicBAsset', 600);
    const sfx = await makeSignal(root, 'sfxAsset', 800);
    await writeFile(
      join(root, 'project.json'),
      JSON.stringify(
        makeProject(
          [
            signalClip('prog', 'progAsset', 0.15),
            signalClip('musicA', 'musicAAsset', 0.12, 'music'),
            signalClip('musicB', 'musicBAsset', 0.1, 'music'),
            signalClip('sfx', 'sfxAsset', 0.1, 'sfx'),
          ],
          false,
          [prog, musicA, musicB, sfx],
        ),
        null,
        2,
      ),
    );

    const build = await buildProject(root);
    assert.equal(build.status, 'succeeded');
    assert.equal(
      build.operations.filter(operation => operation.kind === 'mix-stem').length,
      2,
      'one stem per distinct bus',
    );
    // The Build persists the authored bus label on each stem artifact (and none on the programme).
    const stemArtifacts = build.operations
      .filter(operation => operation.kind === 'mix-stem')
      .map(operation => build.artifacts.find(artifact => artifact.id === operation.artifact)!);
    assert.deepEqual(
      stemArtifacts.map(artifact => artifact.bus).sort(),
      ['music', 'sfx'],
      'each stem artifact carries its authored bus label',
    );
    const mixAudioArtifact = build.artifacts.find(
      artifact => artifact.id === build.operations.find(operation => operation.kind === 'mix-audio')!.artifact,
    )!;
    assert.equal(mixAudioArtifact.bus, undefined, 'the programme mix carries no bus label');
    // The delivered movie's muxed audio is mux-final's audio input (the raw mix without mastering).
    const muxedAudioArtifact = build.artifacts.find(
      artifact =>
        artifact.kind === 'audio' &&
        build.operations.find(operation => operation.kind === 'mux-final')!.inputs.includes(artifact.id),
    )!;
    assert.equal(muxedAudioArtifact.id, mixAudioArtifact.id, 'without mastering the movie muxes the raw programme mix');

    const delivery = await deliverProject(root, destination, { review: true, stems: true });

    // The programme mix and both stems are declared in the typed result.
    assert.equal(delivery.audio.programme, 'audio/programme.wav');
    assert.deepEqual(
      delivery.audio.stems.map(stem => stem.bus),
      ['music', 'sfx'],
      'stems are listed in ascending bus order',
    );
    assert.deepEqual(
      delivery.audio.stems.map(stem => stem.path),
      ['audio/stems/music.wav', 'audio/stems/sfx.wav'],
    );

    const manifest = JSON.parse(await readFile(join(destination, 'delivery-manifest.json'), 'utf8')) as {
      files: Array<{
        path: string;
        sha256: string;
        bytes: number;
        role: string;
        provenance?: { kind?: string; build?: string; bus?: string };
      }>;
      audio: {
        programme: string;
        programmeSha256: string;
        stems: Array<{ bus: string; path: string; sha256: string }>;
      };
      notes: string[];
      bytes: number;
      logicalBytes: number;
    };

    // Every manifest sha256 equals an independently computed hash of the staged file.
    for (const file of manifest.files) {
      assert.equal(
        await hashFile(join(destination, ...file.path.split('/'))),
        file.sha256,
        `manifest hash must match the staged file ${file.path}`,
      );
    }

    const programmeEntry = manifest.files.find(file => file.provenance?.kind === 'audio-programme');
    assert.ok(programmeEntry, 'the programme mix has an audio-programme manifest entry');
    assert.equal(programmeEntry!.path, 'audio/programme.wav');
    assert.equal(programmeEntry!.role, 'audio');
    assert.deepEqual(programmeEntry!.provenance, { kind: 'audio-programme', build: build.id });
    assert.equal(manifest.audio.programmeSha256, programmeEntry!.sha256);

    // Mastering OFF: the copied bytes equal the RAW mix artifact's recorded
    // sha256 (which is also the movie's muxed audio), and the same bytes are also
    // carried inside the bundled project export.
    const programmeSha = await hashFile(join(destination, 'audio', 'programme.wav'));
    assert.equal(
      programmeSha,
      mixAudioArtifact.sha256,
      'without mastering audio/programme.wav must equal the raw mix artifact sha256',
    );
    assert.equal(
      programmeSha,
      muxedAudioArtifact.sha256,
      'audio/programme.wav must equal the audio the movie contains',
    );
    assert.ok(
      manifest.files.some(file => file.path.startsWith('project/') && file.sha256 === mixAudioArtifact.sha256),
      'the programme bytes are also carried in the bundled project export',
    );

    // In-bundle dedup: both paths share one inode, and the note says so.
    const programmeNote = manifest.notes.find(entry => entry.includes('audio/programme.wav'))!;
    assert.ok(programmeNote.includes('shares that copy'), 'the note must state that the two paths share one copy');
    const frozenEntry = manifest.files.find(
      file => file.path.startsWith('project/') && file.sha256 === mixAudioArtifact.sha256,
    )!;
    const [programmeStat, frozenStat] = await Promise.all([
      stat(join(destination, 'audio', 'programme.wav'), { bigint: true }),
      stat(join(destination, ...frozenEntry.path.split('/')), { bigint: true }),
    ]);
    assert.equal(programmeStat.ino, frozenStat.ino, 'identical bundle bytes are stored once');
    assert.ok(manifest.bytes < manifest.logicalBytes, 'unique bytes exclude the shared copy');

    const stemEntries = manifest.files.filter(file => file.provenance?.kind === 'audio-stem');
    assert.deepEqual(
      stemEntries.map(file => file.path),
      ['audio/stems/music.wav', 'audio/stems/sfx.wav'],
    );
    assert.deepEqual(
      stemEntries.map(file => file.provenance),
      [
        { kind: 'audio-stem', build: build.id, bus: 'music' },
        { kind: 'audio-stem', build: build.id, bus: 'sfx' },
      ],
    );
    // The bundled bus labels come straight from the stem artifacts (never inferred), ascending.
    assert.deepEqual(
      stemEntries.map(file => file.provenance!.bus),
      stemArtifacts.map(artifact => artifact.bus).sort((a, b) => (a! < b! ? -1 : a! > b! ? 1 : 0)),
    );
    for (const file of stemEntries) {
      assert.equal(file.role, 'audio');
      assert.ok(file.bytes > 0);
    }

    // Exact expected sample rate, channels and canonical ceil length for every product.
    for (const relative of ['audio/programme.wav', 'audio/stems/music.wav', 'audio/stems/sfx.wav']) {
      const wav = decodePcm16Wav(await readFile(join(destination, ...relative.split('/'))));
      assert.equal(wav.sampleRate, OUTPUT.sampleRate, `${relative} sample rate`);
      assert.equal(wav.channels, OUTPUT.channels, `${relative} channels`);
      assert.equal(wav.samples, TOTAL_SAMPLES, `${relative} sample length`);
    }

    // The stems are distinct from the programme and from each other (they are grouped exports, not copies).
    const programmeBytes = await readFile(join(destination, 'audio', 'programme.wav'));
    const musicBytes = await readFile(join(destination, 'audio', 'stems', 'music.wav'));
    const sfxBytes = await readFile(join(destination, 'audio', 'stems', 'sfx.wav'));
    assert.equal(programmeBytes.equals(musicBytes), false, 'the programme mix is not one of its stems');
    assert.equal(musicBytes.equals(sfxBytes), false, 'the two stems are distinct');

    // The index lists the products and states that stems are not a partition.
    const indexHtml = await readFile(join(destination, 'index.html'), 'utf8');
    assert.ok(indexHtml.includes('id="audio-products"'), 'the audio-products section must be rendered');
    const section = /<section id="audio-products">([\s\S]*?)<\/section>/.exec(indexHtml);
    assert.ok(section, 'the audio-products section must be closed');
    assert.ok(section![1].includes('audio/programme.wav'));
    assert.ok(section![1].includes('audio/stems/music.wav') && section![1].includes('audio/stems/sfx.wav'));
    assert.ok(section![1].includes('not a partition'), 'the index must state that stems are not a partition');
    assert.ok(
      section![1].includes('the audio the delivered movie actually contains'),
      'the index primary sentence must be true with or without mastering',
    );
    assert.ok(section![1].includes('share one copy'), 'the index must state that the programme WAV is stored once');
    assert.ok(
      section![1].includes('byte-identical'),
      'the index must state that audio/programme.wav duplicates the frozen mix already in the project export',
    );

    // --- A project with no audio at all bundles none of it ------------------
    const silentRoot = join(parent, 'silent-authoring');
    const silentDestination = join(parent, 'silent-bundle');
    await mkdir(silentRoot, { recursive: true });
    await writeFile(join(silentRoot, 'project.json'), JSON.stringify(makeProject([]), null, 2));
    const silentBuild = await buildProject(silentRoot);
    assert.equal(silentBuild.status, 'succeeded');
    assert.equal(
      silentBuild.operations.some(operation => operation.kind === 'mix-stem'),
      false,
      'no bus => no stem operation',
    );

    const silentDelivery = await deliverProject(silentRoot, silentDestination, { review: true, stems: true });
    assert.equal(silentDelivery.audio.programme, null);
    assert.deepEqual(silentDelivery.audio.stems, []);

    const silentManifest = JSON.parse(await readFile(join(silentDestination, 'delivery-manifest.json'), 'utf8')) as {
      files: Array<{ path: string; provenance?: { kind?: string } }>;
    };
    assert.equal(
      silentManifest.files.some(
        file => file.provenance?.kind === 'audio-programme' || file.provenance?.kind === 'audio-stem',
      ),
      false,
      'no audio manifest entries without audio',
    );
    assert.equal(
      silentManifest.files.some(file => file.path.startsWith('audio/')),
      false,
      'no audio/ file without audio',
    );

    const silentIndex = await readFile(join(silentDestination, 'index.html'), 'utf8');
    assert.equal(silentIndex.includes('id="audio-products"'), false, 'no empty audio section without audio');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('audio/programme.wav is the MASTERED mix when composition mastering is enabled', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-audio-mastered-'));
  const root = join(parent, 'authoring');
  const destination = join(parent, 'bundle');
  try {
    await mkdir(root, { recursive: true });
    const music = await makeSignal(root, 'musicAsset', 300);
    const sfx = await makeSignal(root, 'sfxAsset', 800);
    await writeFile(
      join(root, 'project.json'),
      JSON.stringify(
        makeProject(
          [signalClip('music', 'musicAsset', 0.5, 'music'), signalClip('sfx', 'sfxAsset', 0.5, 'sfx')],
          true,
          [music, sfx],
        ),
        null,
        2,
      ),
    );

    const build = await buildProject(root);
    assert.equal(build.status, 'succeeded');
    const mixAudioArtifact = build.artifacts.find(
      artifact => artifact.id === build.operations.find(operation => operation.kind === 'mix-audio')!.artifact,
    )!;
    const masterArtifact = build.artifacts.find(
      artifact => artifact.id === build.operations.find(operation => operation.kind === 'master-audio')!.artifact,
    )!;
    assert.notEqual(masterArtifact.sha256, mixAudioArtifact.sha256, 'mastering must change the programme bytes');
    const muxedAudioArtifact = build.artifacts.find(
      artifact =>
        artifact.kind === 'audio' &&
        build.operations.find(operation => operation.kind === 'mux-final')!.inputs.includes(artifact.id),
    )!;
    assert.equal(muxedAudioArtifact.id, masterArtifact.id, 'with mastering the movie muxes the mastered audio');

    const delivery = await deliverProject(root, destination, { review: true, stems: true });
    assert.equal(delivery.audio.programme, 'audio/programme.wav');

    const programmeSha = await hashFile(join(destination, 'audio', 'programme.wav'));
    assert.equal(
      programmeSha,
      masterArtifact.sha256,
      'audio/programme.wav must be the MASTERED artifact when mastering is enabled',
    );
    assert.notEqual(
      programmeSha,
      mixAudioArtifact.sha256,
      'audio/programme.wav must NOT be the raw mix when mastering is enabled',
    );

    // The disclosure and the byte-identity claim hold for the mastered case too.
    const manifest = JSON.parse(await readFile(join(destination, 'delivery-manifest.json'), 'utf8')) as {
      files: Array<{ path: string; sha256: string }>;
      notes: string[];
    };
    const note = manifest.notes.find(entry => entry.includes('audio/programme.wav'))!;
    assert.ok(
      note.includes('mastered when composition mastering is enabled'),
      'the note must state that programme.wav is the mastered mix when mastering is enabled',
    );
    assert.ok(note.includes('byte-identical'), 'the note must state the byte-identity disclosure');
    // And the index carries the same unconditionally-true primary sentence.
    const indexHtml = await readFile(join(destination, 'index.html'), 'utf8');
    const section = /<section id="audio-products">([\s\S]*?)<\/section>/.exec(indexHtml)!;
    assert.ok(
      section[1].includes('the audio the delivered movie actually contains'),
      'the index primary sentence must be true under mastering too',
    );
    assert.ok(section[1].includes('mastered when composition mastering is enabled'));
    assert.ok(
      manifest.files.some(file => file.path.startsWith('project/') && file.sha256 === masterArtifact.sha256),
      'the mastered bytes are carried in the project export',
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('deliverProject fails loudly when a recorded stem artifact is missing from disk', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-audio-missing-'));
  const root = join(parent, 'authoring');
  const destination = join(parent, 'bundle');
  try {
    await mkdir(root, { recursive: true });
    const music = await makeSignal(root, 'musicAsset', 300);
    const sfx = await makeSignal(root, 'sfxAsset', 800);
    await writeFile(
      join(root, 'project.json'),
      JSON.stringify(
        makeProject(
          [signalClip('music', 'musicAsset', 0.12, 'music'), signalClip('sfx', 'sfxAsset', 0.1, 'sfx')],
          false,
          [music, sfx],
        ),
        null,
        2,
      ),
    );
    const build = await buildProject(root);
    assert.equal(build.status, 'succeeded');

    // The Portable export deliberately omits stems, so a restored/reopened
    // project has no stem bytes on disk. Remove one from the artifact store and
    // delivery must refuse rather than silently ship a stem-less audio/ folder.
    const stem = build.artifacts.find(artifact => artifact.operation === 'mix-stem')!;
    await rm(join(root, ...stem.path.split('/')));
    await assert.rejects(
      deliverProject(root, destination, { review: true, stems: true }),
      /run a Build to regenerate the stems/i,
    );
    assert.equal(
      await stat(destination).then(
        () => true,
        () => false,
      ),
      false,
      'a failed delivery leaves no destination',
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
