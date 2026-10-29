/**
 * Programme audio stems — real FFmpeg end to end.
 *
 * Semantics under test: the programme `mix-audio` result is the FULL mix of
 * every member; `mix-stem` emits ADDITIONAL grouped exports (one per distinct
 * bus) that overlap the programme mix. A bus never subtracts audio from the
 * programme, so the delivered movie (which muxes the programme mix) can never
 * lose audio when a bus is introduced.
 *
 *  - a real project with two buses (one grouping two members, one an asset
 *    member) builds exactly one real PCM16 stem per distinct bus, each at the
 *    exact canonical ceil sample length / rate / channels;
 *  - each stem is byte-identical to an independent render of only its members;
 *  - the programme mix is byte-identical to an independent render of ALL
 *    members (it stays full);
 *  - when every member is routed to exactly one bus, the programme mix equals
 *    the float sum of the stems within a stated tolerance. This only holds
 *    under FULL routing — stems are grouped exports and do NOT partition the
 *    programme mix in general (an unrouted member appears in the programme
 *    with no stem);
 *  - adding or removing a bus label does not invalidate or re-encode the
 *    programme mix: `mix-audio` is reused and byte-identical, only stems change.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildProject } from '../src/build/build.js';
import { mixAudio } from '../src/backends/media/audio-mix.js';
import { loadProject, saveProject, validateProject } from '../src/project/project.js';
import { readBuilds } from '../src/project/build-records.js';
import type { Composition, Project } from '../src/core/schema.js';
import { framesToSamples } from '../src/core/time.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { writeSignalAsset } from './audio-fixtures.js';

const FPS30 = { numerator: 30, denominator: 1 };
const OUTPUT = { width: 64, height: 48, fps: FPS30, sampleRate: 48000, channels: 2 } as const;
const TOTAL_FRAMES = 60; // 2 s at 30 fps
const TOTAL_SAMPLES = framesToSamples(TOTAL_FRAMES, FPS30, 48000, 'ceil');
/** Per-sample tolerance for `programme - sum(stems)`; ~6.5 PCM16 LSB over 3 quantizations. */
const SUM_TOLERANCE = 2e-4;

/** Parse the runtime's canonical 44/16/le PCM WAV back to normalized floats. */
function decodePcm16Wav(buffer: Buffer): { sampleRate: number; channels: number; samples: Float32Array } {
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
  assert.equal(fmt.bits, 16, 'stems must be PCM16');
  const frames = Math.floor(dataLength / (fmt.channels * 2));
  const samples = new Float32Array(frames * fmt.channels);
  for (let i = 0; i < samples.length; i++) samples[i] = buffer.readInt16LE(dataOffset + i * 2) / 32767;
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, samples };
}

async function probeWav(path: string): Promise<{ codec: string; sampleRate: number; channels: number }> {
  const probe = JSON.parse(
    await runCommand('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=codec_name,sample_rate,channels',
      '-of',
      'json',
      path,
    ]),
  ) as { streams?: Array<{ codec_name?: string; sample_rate?: string; channels?: number }> };
  const stream = probe.streams?.[0];
  assert(stream, `expected an audio stream in ${path}`);
  return {
    codec: String(stream.codec_name),
    sampleRate: Number(stream.sample_rate),
    channels: Number(stream.channels),
  };
}

/** Drop the `bus` field so a clip renders identically to its routed form's programme contribution. */
function withoutBus(clip: Composition['audio'][number]): Composition['audio'][number] {
  const copy: Record<string, unknown> = { ...clip };
  delete copy.bus;
  return copy as Composition['audio'][number];
}

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

/** Write a real flat picture and signal assets plus a validated project.json. */
async function setup(root: string, buses: boolean): Promise<void> {
  await runCommand('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-filter_threads',
    '1',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=64x48:rate=30:duration=2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-threads',
    '2',
    join(root, 'flat.mp4'),
  ]);
  const musicAAsset = await writeSignalAsset(root, {
    id: 'musicAAsset',
    path: 'musicA.wav',
    sampleRate: 48000,
    channels: 2,
    samples: TOTAL_SAMPLES,
    frequency: 300,
  });
  const musicBAsset = await writeSignalAsset(root, {
    id: 'musicBAsset',
    path: 'musicB.wav',
    sampleRate: 48000,
    channels: 2,
    samples: TOTAL_SAMPLES,
    frequency: 600,
  });
  const sfxAsset = await writeSignalAsset(root, {
    id: 'sfxAsset',
    path: 'sfx.wav',
    sampleRate: 48000,
    channels: 2,
    samples: TOTAL_SAMPLES,
    frequency: 800,
    amplitude: 0.5,
  });
  const project: Project = {
    schemaVersion: 1,
    id: 'stems-e2e',
    revision: 1,
    title: 'Two-bus stems',
    soundTargets: [],
    direction: {
      intent: 'Two grouped stems over a real flat picture',
      looks: [{ id: 'look', description: 'identity' }],
      transitions: [],
    },
    assets: [
      {
        id: 'flat',
        revision: 1,
        path: 'flat.mp4',
        sha256: await hashFile(join(root, 'flat.mp4')),
        type: 'video',
        rights: { origin: 'Original FFmpeg fixture', license: 'CC0-1.0', redistributable: true },
        simulated: false,
      },
      musicAAsset,
      musicBAsset,
      sfxAsset,
    ],
    bindings: {},
    sources: [],
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
          asset: 'flat',
          inFrame: 0,
          outFrame: TOTAL_FRAMES,
          startFrame: 0,
          audio: 'mute',
        },
      ],
      transitions: [],
      audio: [
        signalClip('musicA', 'musicAAsset', 0.12, buses ? 'music' : undefined),
        signalClip('musicB', 'musicBAsset', 0.1, buses ? 'music' : undefined),
        signalClip('sfx', 'sfxAsset', 0.2, buses ? 'sfx' : undefined),
      ],
    },
    imageDocuments: [],
    imageTargets: [],
  };
  await writeFile(join(root, 'project.json'), JSON.stringify(validateProject(project)));
}

/** Renders a direct mixer reference over a chosen subset of a loaded project's clips. */
async function renderReference(
  root: string,
  project: Project,
  keep: (clip: Clip) => boolean,
  name: string,
): Promise<Buffer> {
  const reference: Project = {
    ...project,
    composition: { ...project.composition!, audio: project.composition!.audio.filter(keep).map(withoutBus) },
  };
  const destination = join(root, name);
  await mixAudio(root, reference, [], TOTAL_FRAMES, destination);
  return readFile(destination);
}

test('a fully-routed two-bus project builds stems that partition the full programme mix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-stems-e2e-'));
  try {
    await setup(root, true);
    const build = await buildProject(root);
    assert.equal(build.status, 'succeeded');

    const mixOp = build.operations.find(operation => operation.kind === 'mix-audio')!;
    const mixArtifact = build.artifacts.find(artifact => artifact.id === mixOp.artifact)!;
    const stemOps = build.operations.filter(operation => operation.kind === 'mix-stem');
    assert.equal(
      stemOps.length,
      2,
      'exactly one stem operation per distinct bus — a repeated label never emits a duplicate',
    );
    assert.equal(new Set(stemOps.map(operation => operation.artifact)).size, 2, 'the two stems are distinct artifacts');
    const stemArtifacts = stemOps.map(operation =>
      build.artifacts.find(artifact => artifact.id === operation.artifact)!,
    );
    assert.deepEqual(
      stemArtifacts.map(artifact => artifact.bus).sort(),
      ['music', 'sfx'],
      'each stem artifact carries its bus label for downstream consumers',
    );
    assert.equal(mixArtifact.bus, undefined, 'the programme artifact is not a stem and carries no bus');

    for (const artifact of [mixArtifact, ...stemArtifacts]) {
      assert.equal(artifact.kind, 'audio');
      const wav = decodePcm16Wav(await readFile(join(root, artifact.path)));
      assert.equal(wav.sampleRate, 48000);
      assert.equal(wav.channels, 2);
      assert.equal(
        wav.samples.length,
        TOTAL_SAMPLES * 2,
        'every audio artifact spans the exact canonical ceil sample length',
      );
    }
    for (const artifact of [mixArtifact, ...stemArtifacts]) {
      assert.deepEqual(
        await probeWav(join(root, artifact.path)),
        { codec: 'pcm_s16le', sampleRate: 48000, channels: 2 },
        'each artifact is a real PCM16 WAV',
      );
    }

    const loaded = await loadProject(root);
    // The programme mix is the FULL mix, byte-identical to an independent
    // render of every member.
    const programmeRef = await renderReference(root, loaded, () => true, 'ref-full.wav');
    assert.deepEqual(
      await readFile(join(root, mixArtifact.path)),
      programmeRef,
      'the programme mix must be the full mix of every member',
    );
    // Isolation: each stem is byte-identical to an independent render of only its members.
    const musicRef = await renderReference(root, loaded, clip => clip.bus === 'music', 'ref-music.wav');
    const sfxRef = await renderReference(root, loaded, clip => clip.bus === 'sfx', 'ref-sfx.wav');
    const stemBytes = await Promise.all(stemArtifacts.map(async artifact => readFile(join(root, artifact.path))));
    const asSet = stemBytes.map(bytes => (bytes.equals(musicRef) ? 'music' : bytes.equals(sfxRef) ? 'sfx' : 'unknown'));
    assert(
      asSet.includes('music') && asSet.includes('sfx'),
      `each stem must match exactly one bus reference (got ${asSet.join(',')})`,
    );

    // Under full routing the stems partition the programme mix at the mixer level.
    const programme = decodePcm16Wav(await readFile(join(root, mixArtifact.path))).samples;
    const stemSamples = stemBytes.map(bytes => decodePcm16Wav(bytes).samples);
    let maxDelta = 0;
    for (let i = 0; i < programme.length; i++) {
      let sum = 0;
      for (const samples of stemSamples) sum += samples[i];
      maxDelta = Math.max(maxDelta, Math.abs(sum - programme[i]));
    }
    assert(
      maxDelta <= SUM_TOLERANCE,
      `under full routing the stems must sum to the programme mix (max |delta| ${maxDelta})`,
    );
    console.log(
      `[stems] full-routing partition: max |delta| = ${maxDelta.toExponential(3)} over ${TOTAL_SAMPLES} samples (tolerance ${SUM_TOLERANCE})`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('adding or removing bus labels reuses the programme mix byte-for-byte and only changes stems', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-stems-label-'));
  try {
    await setup(root, false);
    const b0 = await buildProject(root);
    const mixOp0 = b0.operations.find(operation => operation.kind === 'mix-audio')!;
    assert(!b0.operations.some(operation => operation.kind === 'mix-stem'), 'an unrouted project emits no stems');
    const programmeBytes0 = await readFile(
      join(root, b0.artifacts.find(artifact => artifact.id === mixOp0.artifact)!.path),
    );

    // Add bus labels only (audio unchanged).
    const labelled = await loadProject(root);
    for (const clip of labelled.composition!.audio) {
      if (clip.id === 'musicA' || clip.id === 'musicB') clip.bus = 'music';
      if (clip.id === 'sfx') clip.bus = 'sfx';
    }
    await saveProject(root, labelled, labelled.revision);

    const b1 = await buildProject(root);
    const mixOp1 = b1.operations.find(operation => operation.kind === 'mix-audio')!;
    assert.equal(mixOp1.reused, true, 'adding a bus label must reuse the programme mix, not re-encode it');
    assert.equal(
      mixOp1.artifact,
      mixOp0.artifact,
      'the programme mix artifact identity is unchanged by a routing label',
    );
    assert.deepEqual(
      await readFile(join(root, b1.artifacts.find(artifact => artifact.id === mixOp1.artifact)!.path)),
      programmeBytes0,
      'the programme mix bytes are untouched by adding labels',
    );
    assert.equal(
      b1.operations.filter(operation => operation.kind === 'mix-stem').length,
      2,
      'two grouped stems are now emitted',
    );
    const labelledStems = b1.operations
      .filter(operation => operation.kind === 'mix-stem')
      .map(operation => b1.artifacts.find(artifact => artifact.id === operation.artifact)!);
    assert.deepEqual(
      labelledStems.map(artifact => artifact.bus).sort(),
      ['music', 'sfx'],
      'stem artifacts expose their bus labels after labelling',
    );
    assert.equal(
      b1.operations.find(operation => operation.kind === 'mux-final')!.reused,
      true,
      'the delivered movie is unchanged (the programme mix is unchanged)',
    );
    assert.equal(
      b1.result!.artifact,
      b0.result!.artifact,
      'the delivered movie identity is unchanged by adding routing labels',
    );

    // Remove the labels again: the programme mix is still reused and stems vanish.
    const removed = await loadProject(root);
    for (const clip of removed.composition!.audio) delete clip.bus;
    await saveProject(root, removed, removed.revision);
    const b2 = await buildProject(root);
    assert.equal(
      b2.operations.find(operation => operation.kind === 'mix-audio')!.reused,
      true,
      'removing a bus label must reuse the programme mix',
    );
    assert.equal(b2.operations.find(operation => operation.kind === 'mix-audio')!.artifact, mixOp0.artifact);
    assert(!b2.operations.some(operation => operation.kind === 'mix-stem'), 'removing all labels drops the stems');
    assert.equal(b2.result!.artifact, b0.result!.artifact);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a keep over a silent Take is refused for its real cause whether or not its bus has a member', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-stems-emptybus-'));
  try {
    await setup(root, false); // the fixture picture has NO audio stream
    // Produce a real, audio-less Take, then select it with a `take:` origin (not
    // the Asset directly) so the shared placement-Take preflight is the guard
    // under test: a silent `keep` is refused by its ROOT CAUSE before the stem
    // stage, one message per authored mistake.
    const seeded = await buildProject(root);
    const take = seeded.takes.find(entry => entry.asset === 'flat')!;

    const authored = await loadProject(root);
    const placement = authored.composition!.placements[0];
    delete (placement as { asset?: string }).asset;
    (placement as { take?: string }).take = take.id;
    placement.audio = 'keep'; // keeps nothing: the Take has no audio
    placement.bus = 'dialogue'; // an explicit grouping intent
    await saveProject(root, authored, authored.revision);

    await assert.rejects(
      buildProject(root),
      /Placement edit has audio "keep" but its source Take take-[0-9a-f]+ \(Asset flat\) declares no audio stream, so nothing was kept/,
      'a silent keep must fail for its real cause, not be silently omitted from the grouped export',
    );
    const failed = (await readBuilds(root)).find(build => build.status === 'failed');
    assert(failed, 'the silent-keep build is recorded as failed');
    assert(
      !failed.operations.some(operation => operation.kind === 'mix-stem'),
      'no stem is emitted for a bus whose only member keeps no audio',
    );

    // A real bus member does NOT change the verdict: the `keep` is still over an
    // audio-less Take, so the kept audio would be dropped with zero trims.
    const withMember = await loadProject(root);
    withMember.composition!.audio.push(signalClip('vo', 'musicAAsset', 0.2, 'dialogue'));
    await saveProject(root, withMember, withMember.revision);
    await assert.rejects(
      buildProject(root),
      /Placement edit has audio "keep" but its source Take take-[0-9a-f]+ \(Asset flat\) declares no audio stream, so nothing was kept/,
      'adding a bus member must not let a keep over an audio-less Take silently drop audio',
    );

    // Correct BOTH facts: stop asking to keep nonexistent audio (mute the silent
    // Take) and give the bus its real member. The build now succeeds and the stem
    // carries the label.
    const fixed = await loadProject(root);
    delete (fixed.composition!.placements[0] as { bus?: string }).bus;
    fixed.composition!.placements[0].audio = 'mute';
    await saveProject(root, fixed, fixed.revision);
    const ok = await buildProject(root);
    assert.equal(ok.status, 'succeeded');
    const stem = ok.operations.find(operation => operation.kind === 'mix-stem')!;
    assert.equal(
      ok.artifacts.find(artifact => artifact.id === stem.artifact)!.bus,
      'dialogue',
      'the fixed bus emits a labelled stem',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
