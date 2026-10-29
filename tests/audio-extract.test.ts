/**
 * `extractAudio`: register a real audio stream interval of an existing Take /
 * video Artifact as an audio Asset, and prove the recorded provenance against
 * measured bytes.
 *
 * Real FFmpeg/FFprobe only (no browser, no provider). Every assertion is about
 * observable facts: the produced WAV is re-probed, an independent FFmpeg decode
 * is compared byte-for-byte, unsupported inputs are refused with the source and
 * Project untouched, and the derivation round-trips through archive/restore.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { extractAudio, ExtractAudioOptionsSchema } from '../src/operations/assets/audio-extract.js';
import { assertAuthoredPath } from '../src/project/authored-path.js';
import { buildProject } from '../src/build/build.js';
import { ProjectSchema, type Artifact, type BuildRecord, type Project, type Take } from '../src/core/schema.js';
import { atomicJson } from '../src/shared/fs.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { loadProject, saveProject, validateProject } from '../src/project/project.js';
import { probeAudio, probeAudioStreams, probeMedia } from '../src/backends/media/probe.js';
import { archiveProject, restoreProject } from '../src/operations/delivery/archive.js';
import { exportProject } from '../src/operations/delivery/portable.js';

const FPS = { numerator: 25, denominator: 1 };
const FRAMES = 50; // 2 s at 25 fps
const SAMPLE_RATE = 48000;

const RIGHTS = {
  origin: 'recorded take audio, private review 2026-10-13',
  license: 'private approval only',
  redistributable: false,
};
const PUBLIC_RIGHTS = {
  origin: 'recorded take audio, cleared for redistribution',
  license: 'CC0-1.0',
  redistributable: true,
};

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-extract-audio-'));
}

async function ffmpeg(args: string[]): Promise<void> {
  await runCommand('ffmpeg', [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-loglevel',
    'error',
    '-threads',
    '2',
    '-filter_threads',
    '1',
    ...args,
  ]);
}

/** A minimal valid Project with no assets, one scene/shot and the given output. */
function baseProject(id: string): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id,
    revision: 1,
    title: 'Audio extraction fixture',
    direction: { intent: 'test', looks: [{ id: 'look_main', description: 'main' }], transitions: [] },
    assets: [],
    bindings: {},
    sources: [],
    composition: {
      output: { width: 64, height: 48, fps: FPS, sampleRate: SAMPLE_RATE, channels: 2 },
      scenes: [{ id: 'scene_1', description: 'scene' }],
      shots: [{ id: 'shot_1', scene: 'scene_1', look: 'look_main', intent: 'shot', targetFrames: FRAMES }],
      placements: [],
      transitions: [],
      audio: [],
    },
  });
}

/** A real video asset carrying a real audio track, normalized by a real Build. */
async function audioMediaProject(root: string): Promise<Project> {
  const clipPath = nodePath.join(root, 'assets', 'clip.mp4');
  await fs.mkdir(nodePath.dirname(clipPath), { recursive: true });
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=64x48:rate=25:duration=${FRAMES / 25}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=${SAMPLE_RATE}:duration=${FRAMES / 25}`,
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-frames:v',
    String(FRAMES),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-shortest',
    clipPath,
  ]);
  const sha256 = await hashFile(clipPath);
  const project = baseProject('extract_audio_media');
  project.assets = [
    {
      id: 'clip',
      revision: 1,
      path: 'assets/clip.mp4',
      sha256,
      type: 'video',
      rights: PUBLIC_RIGHTS,
      simulated: false,
    },
  ];
  project.composition!.placements = [
    { id: 'place_1', shot: 'shot_1', asset: 'clip', inFrame: 0, outFrame: FRAMES, startFrame: 0, audio: 'keep' },
  ];
  return validateProject(project);
}

interface BuiltAudioMedia {
  root: string;
  build: BuildRecord;
  take: Take;
  artifact: Artifact;
  artifactPath: string;
}

async function builtAudioMedia(): Promise<BuiltAudioMedia> {
  const root = await tempRoot();
  await atomicJson(nodePath.join(root, 'project.json'), await audioMediaProject(root));
  const build = await buildProject(root);
  const take = build.takes.find(item => item.asset === 'clip')!;
  assert.ok(take, 'the audio media build must register a Take');
  const artifact = build.artifacts.find(item => item.id === take.artifact)!;
  if (take.medium !== 'picture') assert.fail('the normalized video clip Take must be a picture Take');
  assert.equal(take.frames, FRAMES, `the take must span ${FRAMES} frames`);
  assert.ok(artifact.media?.audio, 'the normalized clip artifact must carry an audio stream');
  return { root, build, take, artifact, artifactPath: nodePath.join(root, artifact.path) };
}

/**
 * Author one real multi-stream (or video-only) file and register it as the
 * artifact of a real succeeded Build record, so `extractAudio` can locate it as
 * a Build medium without a normalization step collapsing extra audio streams.
 */
async function manualBuild(
  root: string,
  artifactId: string,
  filePath: string,
  options: { simulated?: boolean } = {},
): Promise<{ buildId: string; artifact: Artifact }> {
  const artifactsDir = nodePath.join(root, '.viscraft', 'artifacts');
  await fs.mkdir(artifactsDir, { recursive: true });
  const relative = `.viscraft/artifacts/${artifactId}.mp4`;
  const destination = nodePath.join(root, relative);
  await fs.copyFile(filePath, destination);
  const sha256 = await hashFile(destination);
  const media = await probeMedia(destination);
  const artifact: Artifact = {
    id: artifactId,
    path: relative,
    sha256,
    kind: 'video',
    simulated: options.simulated === true,
    operation: 'normalize-media',
    inputs: [],
    backend: 'ffmpeg',
    media,
  };
  const buildId = `build-manual-${artifactId}`;
  const record: BuildRecord = {
    schemaVersion: 1,
    id: buildId,
    run: { id: 'run-manual', goal: 'manual audio fixture' },
    plan: { operations: [] },
    revision: 1,
    snapshotHash: 'manual',
    status: 'succeeded',
    medium: 'picture',
    startedAt: '2030-01-01T00:00:00.000Z',
    operations: [],
    artifacts: [artifact],
    takes: [],
  };
  await atomicJson(nodePath.join(root, '.viscraft', 'builds', `${buildId}.json`), record);
  return { buildId, artifact };
}

/** Two audio streams of different channel counts so the default selection differs from index 1. */
async function makeMultiStreamFile(destination: string): Promise<void> {
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=64x48:rate=25:duration=2',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=300:sample_rate=${SAMPLE_RATE}:duration=2`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=3000:sample_rate=${SAMPLE_RATE}:duration=2`,
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-map',
    '2:a',
    '-frames:v',
    String(FRAMES),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-ac:a:0',
    '2',
    '-ac:a:1',
    '1',
    '-shortest',
    destination,
  ]);
}

/** A file whose video starts at 0 but whose audio track starts later (a delayed audio track). */
async function makeDelayedAudioFile(destination: string, audioOffsetSeconds: number): Promise<void> {
  const video = `${destination}.video.mp4`;
  const audio = `${destination}.audio.m4a`;
  try {
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      `testsrc=size=64x48:rate=25:duration=2`,
      '-frames:v',
      String(FRAMES),
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-an',
      video,
    ]);
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:sample_rate=${SAMPLE_RATE}:duration=2`,
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      audio,
    ]);
    await ffmpeg([
      '-i',
      video,
      '-itsoffset',
      String(audioOffsetSeconds),
      '-i',
      audio,
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-c:v',
      'copy',
      '-c:a',
      'copy',
      '-shortest',
      destination,
    ]);
  } finally {
    await fs.rm(video, { force: true });
    await fs.rm(audio, { force: true });
  }
}

/** Independently decode the selected stream whole (zero-based), as the operation does. */
async function independentExtract(
  source: string,
  destination: string,
  streamIndex: number,
  sampleRate: number,
  seekSeconds: number,
  durationSeconds: number,
): Promise<void> {
  const args: string[] = [];
  if (seekSeconds > 0) args.push('-ss', `${seekSeconds}`);
  args.push('-i', source);
  if (durationSeconds > 0) args.push('-t', `${durationSeconds}`);
  args.push(
    '-map',
    `0:a:${streamIndex}`,
    '-vn',
    '-sn',
    '-dn',
    '-ar',
    String(sampleRate),
    '-c:a',
    'pcm_s16le',
    destination,
  );
  await ffmpeg(args);
}

test('extractAudio registers a real whole-stream audio Asset with honest derivedFrom facts', async () => {
  const built = await builtAudioMedia();
  const { root, build, take, artifact, artifactPath } = built;
  try {
    const parentBefore = await hashFile(artifactPath);
    const buildsBefore = (await fs.readdir(nodePath.join(root, '.viscraft', 'builds'))).length;

    const asset = await extractAudio(root, {
      take: take.id,
      assetId: 'take_audio',
      rights: RIGHTS,
      expectedRevision: 1,
      streamIndex: 0,
    });

    assert.equal(asset.type, 'audio');
    assert.equal(asset.revision, 1);
    assert.equal(asset.simulated, false, 'a purely real media parent must not taint its audio');
    assert.deepEqual(asset.rights, RIGHTS, 'caller rights are kept verbatim');
    assert.equal(asset.path, `assets/take_audio-${asset.sha256.slice(0, 16)}.wav`);
    assert.equal(await hashFile(nodePath.join(root, asset.path)), asset.sha256);

    const derivation = asset.derivedFrom;
    assert.ok(derivation && derivation.kind === 'audio');
    assert.equal(derivation.build, build.id);
    assert.equal(derivation.artifact, artifact.id);
    assert.equal(derivation.sha256, artifact.sha256);
    assert.equal(derivation.take, take.id);
    assert.equal(derivation.outputSha256, asset.sha256, 'outputSha256 IS the Asset bytes');

    // The recorded stream/time facts must match the parent's REAL stream.
    const streams = await probeAudioStreams(artifactPath);
    assert.equal(streams.length, 1);
    const stream = streams[0];
    assert.equal(derivation.streamIndex, 0);
    assert.deepEqual(derivation.timebase, stream.timebase);
    assert.equal(derivation.startPts, stream.startPts);
    assert.equal(derivation.inPts, stream.startPts, 'a whole-stream extraction starts at the stream start');
    assert.equal(derivation.outPts, (stream.startPts ?? 0) + (stream.durationTicks ?? 0));
    assert.equal(derivation.startSample, 0, 'output sample 0 corresponds to the stream start');

    // The produced-file facts are the PROBED bytes, not optimistic arithmetic.
    const produced = await probeAudio(nodePath.join(root, asset.path));
    assert.equal(derivation.sampleRate, produced.sampleRate);
    assert.equal(derivation.sampleRate, SAMPLE_RATE);
    assert.equal(derivation.sampleCount, produced.samples);
    assert.ok(derivation.sampleCount > 0);

    // The bytes are exactly an independent decode of the SAME interval/stream
    // (same flags and same `-t` bound the operation uses).
    const reference = nodePath.join(root, 'reference.wav');
    await independentExtract(artifactPath, reference, 0, SAMPLE_RATE, 0, 0);
    assert.equal(await hashFile(reference), asset.sha256, 'the Asset must be the real decoded stream bytes');
    await fs.rm(reference, { force: true });

    // Project and source are untouched except for the one atomic revision bump.
    const projectAfter = await loadProject(root);
    assert.equal(projectAfter.revision, 2);
    assert.deepEqual(
      projectAfter.assets.map(item => item.id),
      ['clip', 'take_audio'],
    );
    assert.equal(await hashFile(artifactPath), parentBefore, 'the parent Artifact bytes must never change');
    assert.equal(
      (await fs.readdir(nodePath.join(root, '.viscraft', 'builds'))).length,
      buildsBefore,
      'extraction must not fabricate a Build record',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an edited audio derivation record is refused at load (formula) and at build (real stream/output facts)', async () => {
  const built = await builtAudioMedia();
  const { root, take } = built;
  try {
    await extractAudio(root, {
      take: take.id,
      assetId: 'vo',
      rights: PUBLIC_RIGHTS,
      expectedRevision: 1,
      streamIndex: 0,
    });
    const projectPath = nodePath.join(root, 'project.json');
    const original = JSON.parse(await fs.readFile(projectPath, 'utf8'));
    type AudioDerivation = {
      kind: 'audio';
      streamIndex: number;
      timebase: { numerator: number; denominator: number };
      startPts: number;
      inPts: number;
      outPts: number;
      sampleRate: number;
      startSample: number;
      sampleCount: number;
    };
    const forged = (mutate: (derivation: AudioDerivation) => void): Record<string, unknown> => {
      const copy = JSON.parse(JSON.stringify(original));
      const asset = copy.assets.find((item: { id: string }) => item.id === 'vo');
      mutate(asset.derivedFrom);
      return copy;
    };
    const write = async (project: unknown): Promise<void> =>
      fs.writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`);
    const implied = (d: AudioDerivation, rate: number): number =>
      Math.round((((d.inPts - d.startPts) * d.timebase.numerator) / d.timebase.denominator) * rate);

    // Record-internal forgeries are refused by the hash-only contract, at LOAD.
    await write(forged(d => (d.startSample = d.startSample + 12345)));
    await assert.rejects(() => loadProject(root), /startSample does not match/i);
    await write(forged(d => (d.inPts = d.startPts - 1)));
    await assert.rejects(() => loadProject(root), /inPts must not precede/i);
    // A negative audio-relative index is not a valid index at all (the schema's
    // non-negative integer rejects it before any semantic check).
    await write(forged(d => (d.streamIndex = -1)));
    await assert.rejects(() => loadProject(root));

    // Forgeries that stay internally consistent cannot be seen by the schema, so
    // they are caught BOTH at BUILD and at the DELIVERY boundary (export/archive),
    // which re-derives the record against the parent medium and the produced file.
    await write(forged(d => (d.streamIndex = 99)));
    await assert.rejects(() => buildProject(root), /streamIndex 99 does not exist/i);
    await assert.rejects(() => exportProject(root), /streamIndex 99 does not exist/i);
    await assert.rejects(() => archiveProject(root), /streamIndex 99 does not exist/i);

    await write(
      forged(d => {
        d.timebase = { numerator: 1, denominator: 100000 };
        d.startSample = implied(d, d.sampleRate);
      }),
    );
    await assert.rejects(() => buildProject(root), /timebase disagrees with the parent stream/i);
    await assert.rejects(() => exportProject(root), /timebase disagrees with the parent stream/i);

    await write(
      forged(d => {
        d.sampleRate = 1;
        d.sampleCount = 1;
        d.startSample = implied(d, 1);
      }),
    );
    await assert.rejects(() => buildProject(root), /output facts disagree/i);
    await assert.rejects(() => exportProject(root), /output facts disagree/i);

    // A record whose interval runs past the real stream end is refused too.
    await write(
      forged(d => {
        d.outPts = d.startPts + 100000000;
      }),
    );
    await assert.rejects(() => exportProject(root), /interval exceeds the parent audio stream end/i);

    // The unedited record still loads, builds and exports: only forgeries fail.
    await write(original);
    assert.equal((await loadProject(root)).assets.find(asset => asset.id === 'vo')?.type, 'audio');
    assert.equal((await buildProject(root)).status, 'succeeded');
    assert.equal((await exportProject(root)).simulated, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('extractAudio honours an explicit half-open interval and records the source start mapping', async () => {
  const built = await builtAudioMedia();
  const { root, take, artifactPath } = built;
  try {
    const stream = (await probeAudioStreams(artifactPath))[0];
    const startPts = stream.startPts ?? 0;
    const inPts = startPts + 8000;
    const outPts = startPts + 32000;

    const asset = await extractAudio(root, {
      take: take.id,
      assetId: 'take_audio_interval',
      rights: RIGHTS,
      expectedRevision: 1,
      streamIndex: 0,
      inPts,
      outPts,
      processing: 'trimmed take audio',
    });
    const derivation = asset.derivedFrom;
    assert.ok(derivation && derivation.kind === 'audio');
    assert.equal(derivation.inPts, inPts);
    assert.equal(derivation.outPts, outPts);
    assert.equal(derivation.processing, 'trimmed take audio');
    // startSample = the stream position output sample 0 maps to, rounded to the
    // output sample grid. The fixture timebase is 1/48000, so it is the tick span.
    const expectedStartSample = Math.round(
      (((inPts - startPts) * derivation.timebase.numerator) / derivation.timebase.denominator) * SAMPLE_RATE,
    );
    assert.equal(derivation.startSample, expectedStartSample);

    const produced = await probeAudio(nodePath.join(root, asset.path));
    assert.equal(derivation.sampleCount, produced.samples);
    const expectedSamples = Math.round(
      (((outPts - inPts) * derivation.timebase.numerator) / derivation.timebase.denominator) * produced.sampleRate,
    );
    assert.ok(
      Math.abs(derivation.sampleCount - expectedSamples) <= 2048,
      `sampleCount ${derivation.sampleCount} should be near ${expectedSamples}`,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('extractAudio extracts the SELECTED audio stream, not the channel-count default', async () => {
  const root = await tempRoot();
  try {
    await atomicJson(nodePath.join(root, 'project.json'), baseProject('extract_audio_multi'));
    const multi = nodePath.join(root, 'multi-source.mp4');
    await makeMultiStreamFile(multi);
    const { artifact } = await manualBuild(root, 'artifact-multi-0001', multi);
    assert.equal(artifact.media?.audio?.channels, 2, 'the probe reports the FIRST audio stream by default');

    const streams = await probeAudioStreams(nodePath.join(root, artifact.path));
    assert.equal(streams.length, 2);
    assert.equal(streams[0].channels, 2, 'audio index 0 is the stereo stream');
    assert.equal(streams[1].channels, 1, 'audio index 1 is the mono stream');
    assert.deepEqual(
      streams.map(stream => stream.index),
      [0, 1],
      'entries are audio-relative indices',
    );

    const asset = await extractAudio(root, {
      artifact: artifact.id,
      assetId: 'mono_second',
      rights: RIGHTS,
      expectedRevision: 1,
      streamIndex: 1,
    });
    const produced = await probeAudio(nodePath.join(root, asset.path));
    assert.equal(produced.channels, 1, 'index 1 (mono) must be selected, not the default stereo stream');

    const derivation = asset.derivedFrom;
    assert.ok(derivation && derivation.kind === 'audio');
    assert.equal(derivation.streamIndex, 1);

    // Byte-for-byte equal to an independent `-map 0:a:1` whole-stream decode; different from index 0.
    const reference = nodePath.join(root, 'reference.wav');
    await independentExtract(nodePath.join(root, artifact.path), reference, 1, SAMPLE_RATE, 0, 0);
    assert.equal(await hashFile(reference), asset.sha256);
    await fs.rm(reference, { force: true });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('extractAudio records a non-zero source start PTS and honours a requested output sample rate', async () => {
  const root = await tempRoot();
  try {
    await atomicJson(nodePath.join(root, 'project.json'), baseProject('extract_audio_offset'));
    const plain = nodePath.join(root, 'plain.mp4');
    await makeMultiStreamFile(plain);
    // Remux with a positive output timestamp offset so every stream starts at a
    // non-zero PTS — the case a fabricated mapping would get wrong.
    const offset = nodePath.join(root, 'offset.mp4');
    await ffmpeg(['-i', plain, '-c', 'copy', '-output_ts_offset', '0.478', offset]);
    const { artifact } = await manualBuild(root, 'artifact-offset-0001', offset);

    const streams = await probeAudioStreams(nodePath.join(root, artifact.path));
    assert.ok(streams[0].startPts !== undefined && streams[0].startPts > 0, 'the fixture starts at a positive PTS');

    const asset = await extractAudio(root, {
      artifact: artifact.id,
      assetId: 'offset_audio',
      rights: PUBLIC_RIGHTS,
      expectedRevision: 1,
      streamIndex: 0,
      outputSampleRate: 44100,
    });
    const derivation = asset.derivedFrom;
    assert.ok(derivation && derivation.kind === 'audio');
    assert.equal(
      derivation.startPts,
      streams[0].startPts,
      'the recorded start PTS is the probed one, not an assumed 0',
    );
    assert.deepEqual(derivation.timebase, streams[0].timebase);
    assert.equal(derivation.inPts, streams[0].startPts, 'a whole-stream extraction begins at the stream start');
    assert.equal(derivation.startSample, 0, 'output sample 0 maps to the stream start');
    assert.equal(derivation.sampleRate, 44100, 'the requested output sample rate is recorded');
    assert.equal(
      (await probeAudio(nodePath.join(root, asset.path))).sampleRate,
      44100,
      'the produced WAV really is 44.1 kHz',
    );
    // The whole stream is decoded from its START, not from its absolute PTS: an
    // absolute-seek bug would strip `startPts` worth of real audio off the front.
    const produced = await probeAudio(nodePath.join(root, asset.path));
    const fullSeconds =
      ((streams[0].durationTicks ?? 0) * streams[0].timebase.numerator) / streams[0].timebase.denominator;
    const expectedSamples = Math.round(fullSeconds * 44100);
    assert.ok(
      Math.abs(produced.samples - expectedSamples) <= 2048,
      `whole-stream samples ${produced.samples} should be near the full stream ${expectedSamples} (not trimmed by the start PTS)`,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('extractAudio decodes an interval RELATIVE to a non-zero stream start, not by its absolute PTS', async () => {
  const root = await tempRoot();
  try {
    await atomicJson(nodePath.join(root, 'project.json'), baseProject('extract_audio_relative'));
    const plain = nodePath.join(root, 'plain.mp4');
    await makeMultiStreamFile(plain);
    // Remux with a positive output timestamp offset so the audio stream starts at
    // a non-zero PTS — the case an absolute-seek mapping silently trims.
    const offset = nodePath.join(root, 'offset.mp4');
    await ffmpeg(['-i', plain, '-c', 'copy', '-output_ts_offset', '0.478', offset]);
    const { artifact } = await manualBuild(root, 'artifact-reloffset-0001', offset);
    const source = nodePath.join(root, artifact.path);

    const stream = (await probeAudioStreams(source))[0];
    assert.ok(stream.startPts !== undefined && stream.startPts > 0, 'the fixture starts at a positive PTS');
    const { numerator, denominator } = stream.timebase;
    const inPts = stream.startPts! + 8000;
    const outPts = stream.startPts! + 32000;
    const spanSeconds = ((outPts - inPts) * numerator) / denominator;
    const expectedSamples = Math.round(spanSeconds * SAMPLE_RATE);

    const asset = await extractAudio(root, {
      artifact: artifact.id,
      assetId: 'rel_audio',
      rights: PUBLIC_RIGHTS,
      expectedRevision: 1,
      streamIndex: 0,
      inPts,
      outPts,
    });
    const derivation = asset.derivedFrom;
    assert.ok(derivation && derivation.kind === 'audio');
    assert.equal(derivation.inPts, inPts);
    assert.equal(derivation.outPts, outPts);
    const produced = await probeAudio(nodePath.join(root, asset.path));
    assert.equal(derivation.sampleCount, produced.samples);
    assert.equal(
      produced.samples,
      expectedSamples,
      `the interval [${inPts}, ${outPts}) decodes from the stream start, not its absolute PTS`,
    );

    // The exact reference is a two-pass relative trim: decode the whole stream,
    // then seek by the interval offset from that zero-based file.
    const whole = nodePath.join(root, 'whole.wav');
    await ffmpeg(['-i', source, '-map', '0:a:0', '-vn', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le', whole]);
    const reference = nodePath.join(root, 'reference-relative.wav');
    await ffmpeg([
      '-ss',
      `${((inPts - stream.startPts!) * numerator) / denominator}`,
      '-t',
      `${spanSeconds}`,
      '-i',
      whole,
      '-map',
      '0:a:0',
      '-vn',
      '-ar',
      String(SAMPLE_RATE),
      '-c:a',
      'pcm_s16le',
      reference,
    ]);
    assert.equal(await hashFile(reference), asset.sha256, 'the extracted interval equals the exact relative trim');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('extractAudio is byte-exact for a delayed audio track in a mixed container', async () => {
  const root = await tempRoot();
  try {
    await atomicJson(nodePath.join(root, 'project.json'), baseProject('extract_audio_mixed'));
    const mixed = nodePath.join(root, 'mixed.mp4');
    await makeDelayedAudioFile(mixed, 0.5);
    const { artifact } = await manualBuild(root, 'artifact-mixed-0001', mixed);
    const source = nodePath.join(root, artifact.path);

    const stream = (await probeAudioStreams(source))[0];
    assert.ok(
      stream.startPts !== undefined && stream.startPts > 0,
      'the fixture audio track is delayed relative to the zero-based video',
    );
    const { numerator, denominator } = stream.timebase;
    const inPts = stream.startPts! + 8000;
    const outPts = stream.startPts! + 32000;
    const spanSeconds = ((outPts - inPts) * numerator) / denominator;
    const expectedSamples = Math.round(spanSeconds * SAMPLE_RATE);

    const asset = await extractAudio(root, {
      artifact: artifact.id,
      assetId: 'mixed_audio',
      rights: PUBLIC_RIGHTS,
      expectedRevision: 1,
      streamIndex: 0,
      inPts,
      outPts,
    });
    const produced = await probeAudio(nodePath.join(root, asset.path));
    assert.equal(
      produced.samples,
      expectedSamples,
      'the delayed track interval is decoded from ITS start, not the container start',
    );

    // Exact two-pass reference: decode the whole (zero-based) audio, then trim.
    const whole = nodePath.join(root, 'whole.wav');
    await ffmpeg(['-i', source, '-map', '0:a:0', '-vn', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le', whole]);
    const reference = nodePath.join(root, 'reference-mixed.wav');
    await ffmpeg([
      '-ss',
      `${((inPts - stream.startPts!) * numerator) / denominator}`,
      '-t',
      `${spanSeconds}`,
      '-i',
      whole,
      '-map',
      '0:a:0',
      '-vn',
      '-ar',
      String(SAMPLE_RATE),
      '-c:a',
      'pcm_s16le',
      reference,
    ]);
    assert.equal(
      await hashFile(reference),
      asset.sha256,
      'the delayed-track interval equals the exact zero-based two-pass trim',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('extractAudio trims an interval of a NON-first audio stream', async () => {
  const root = await tempRoot();
  try {
    await atomicJson(nodePath.join(root, 'project.json'), baseProject('extract_audio_second_interval'));
    const multi = nodePath.join(root, 'multi.mp4');
    await makeMultiStreamFile(multi);
    const { artifact } = await manualBuild(root, 'artifact-second-interval-0001', multi);
    const source = nodePath.join(root, artifact.path);
    const streams = await probeAudioStreams(source);
    assert.equal(streams.length, 2);
    const second = streams[1];
    assert.equal(second.channels, 1, 'audio index 1 is the mono stream');

    const { numerator, denominator } = second.timebase;
    const inPts = (second.startPts ?? 0) + 8000;
    const outPts = (second.startPts ?? 0) + 32000;
    const spanSeconds = ((outPts - inPts) * numerator) / denominator;
    const expectedSamples = Math.round(spanSeconds * SAMPLE_RATE);

    // The trim pass runs on a single-stream WAV, so it must map `0:a:0` rather than
    // reusing the source's audio-relative index 1 (which would fail: "matches no streams").
    const asset = await extractAudio(root, {
      artifact: artifact.id,
      assetId: 'second_interval',
      rights: PUBLIC_RIGHTS,
      expectedRevision: 1,
      streamIndex: 1,
      inPts,
      outPts,
    });
    const produced = await probeAudio(nodePath.join(root, asset.path));
    assert.equal(produced.channels, 1, 'the selected mono second stream is carried');
    assert.equal(produced.samples, expectedSamples, 'the second-stream interval is trimmed exactly');

    // Byte-for-byte equal to decoding the second stream whole, then trimming it.
    const whole = nodePath.join(root, 'whole-second.wav');
    await ffmpeg(['-i', source, '-map', '0:a:1', '-vn', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le', whole]);
    const reference = nodePath.join(root, 'reference-second.wav');
    await ffmpeg([
      '-ss',
      `${((inPts - (second.startPts ?? 0)) * numerator) / denominator}`,
      '-t',
      `${spanSeconds}`,
      '-i',
      whole,
      '-map',
      '0:a:0',
      '-vn',
      '-ar',
      String(SAMPLE_RATE),
      '-c:a',
      'pcm_s16le',
      reference,
    ]);
    assert.equal(await hashFile(reference), asset.sha256, 'the second-stream interval equals the exact trim');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('extractAudio refuses a runtime/output/credential Asset path instead of writing it', async () => {
  const root = await tempRoot();
  try {
    await atomicJson(nodePath.join(root, 'project.json'), baseProject('extract_audio_path'));
    const multi = nodePath.join(root, 'multi.mp4');
    await makeMultiStreamFile(multi);
    const { artifact } = await manualBuild(root, 'artifact-path-0001', multi);
    const before = await fs.readFile(nodePath.join(root, 'project.json'));

    for (const bad of ['.viscraft/leak.wav', 'output/leak.wav', '.env', '.viscraft/pages/note.wav']) {
      await assert.rejects(
        () =>
          extractAudio(root, {
            artifact: artifact.id,
            assetId: 'leak',
            rights: RIGHTS,
            expectedRevision: 1,
            streamIndex: 0,
            path: bad,
          }),
        /must not|collides with a package page/,
        `the runtime/output/credential/rendered-page path ${bad} must be refused`,
      );
    }

    // Nothing was written and the Project is untouched.
    assert.deepEqual(await fs.readFile(nodePath.join(root, 'project.json')), before);
    await assert.rejects(fs.stat(nodePath.join(root, '.viscraft', 'leak.wav')));
    assert.equal((await loadProject(root)).assets.length, 0, 'no Asset may be registered by a refused path');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the authored-path policy refuses runtime-private and credential paths, but allows a nested page name', () => {
  for (const bad of ['.viscraft/note.wav', '.viscraft/pages/VISCRAFT.md', '.env'])
    assert.throws(() => assertAuthoredPath(bad, 'Asset a'), /must not/, bad);
  // A nested page name is a different path and stays allowed.
  for (const ok of ['assets/VISCRAFT.md', 'a/VISCRAFT.md', 'VISCRAFT.md.bak', 'assets/ATTRIBUTION.md'])
    assert.doesNotThrow(() => assertAuthoredPath(ok, 'Asset a'), ok);
});

test('extractAudio fails loudly for a missing audio stream and an out-of-range streamIndex', async () => {
  const root = await tempRoot();
  try {
    await atomicJson(nodePath.join(root, 'project.json'), baseProject('extract_audio_missing'));
    const silent = nodePath.join(root, 'silent.mp4');
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=64x48:rate=25:duration=2',
      '-frames:v',
      String(FRAMES),
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-an',
      silent,
    ]);
    const { artifact } = await manualBuild(root, 'artifact-silent-0001', silent);
    const before = await fs.readFile(nodePath.join(root, 'project.json'));

    await assert.rejects(
      () =>
        extractAudio(root, {
          artifact: artifact.id,
          assetId: 'a',
          rights: RIGHTS,
          expectedRevision: 1,
          streamIndex: 0,
        }),
      /no audio stream/,
    );

    // A multi-stream file with a non-existent index is refused too.
    const multi = nodePath.join(root, 'multi.mp4');
    await makeMultiStreamFile(multi);
    const { artifact: multiArtifact } = await manualBuild(root, 'artifact-multi-0002', multi);
    await assert.rejects(
      () =>
        extractAudio(root, {
          artifact: multiArtifact.id,
          assetId: 'a',
          rights: RIGHTS,
          expectedRevision: 1,
          streamIndex: 5,
        }),
      /does not exist/,
    );

    assert.deepEqual(await fs.readFile(nodePath.join(root, 'project.json')), before, 'the Project must be untouched');
    assert.equal((await loadProject(root)).assets.length, 0, 'no Asset may be registered by a refused extraction');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('extractAudio refuses an interval outside the stream instead of fabricating a mapping', async () => {
  const built = await builtAudioMedia();
  const { root, take, artifactPath } = built;
  try {
    const stream = (await probeAudioStreams(artifactPath))[0];
    const startPts = stream.startPts ?? 0;
    const endPts = startPts + (stream.durationTicks ?? 0);

    await assert.rejects(
      () =>
        extractAudio(root, {
          take: take.id,
          assetId: 'below_start',
          rights: RIGHTS,
          expectedRevision: 1,
          streamIndex: 0,
          inPts: startPts - 1,
        }),
      /before the audio stream start/,
    );
    await assert.rejects(
      () =>
        extractAudio(root, {
          take: take.id,
          assetId: 'past_end',
          rights: RIGHTS,
          expectedRevision: 1,
          streamIndex: 0,
          outPts: endPts + 100000,
        }),
      /exceeds the audio stream end/,
    );
    await assert.rejects(
      () =>
        extractAudio(root, {
          take: take.id,
          assetId: 'empty',
          rights: RIGHTS,
          expectedRevision: 1,
          streamIndex: 0,
          inPts: startPts + 1000,
          outPts: startPts + 1000,
        }),
      /nonempty half-open/,
    );

    assert.equal((await loadProject(root)).revision, 1, 'a refused call must not bump the revision');
    assert.equal((await loadProject(root)).assets.length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('extractAudio reuses identical bytes, refuses different bytes, and refuses an existing Asset id', async () => {
  const root = await tempRoot();
  try {
    await atomicJson(nodePath.join(root, 'project.json'), baseProject('extract_audio_idem'));
    const multi = nodePath.join(root, 'multi.mp4');
    await makeMultiStreamFile(multi);
    const { artifact } = await manualBuild(root, 'artifact-multi-0003', multi);
    const shared = 'assets/shared-audio.wav';

    const first = await extractAudio(root, {
      artifact: artifact.id,
      assetId: 'a',
      rights: RIGHTS,
      expectedRevision: 1,
      streamIndex: 1,
      path: shared,
    });
    // A second, differently-named Asset at the SAME content path reuses the bytes.
    const second = await extractAudio(root, {
      artifact: artifact.id,
      assetId: 'b',
      rights: RIGHTS,
      expectedRevision: 2,
      streamIndex: 1,
      path: shared,
    });
    assert.equal(second.sha256, first.sha256, 'identical bytes are reused, not rewritten');
    assert.equal(await hashFile(nodePath.join(root, shared)), first.sha256);

    // A tampered content path with differing bytes is refused.
    await fs.writeFile(nodePath.join(root, shared), Buffer.from('not the extracted audio'));
    await assert.rejects(
      () =>
        extractAudio(root, {
          artifact: artifact.id,
          assetId: 'c',
          rights: RIGHTS,
          expectedRevision: 3,
          streamIndex: 1,
          path: shared,
        }),
      /Refusing to overwrite existing file/,
    );

    // An existing Asset id is refused before any extraction.
    await assert.rejects(
      () =>
        extractAudio(root, {
          artifact: artifact.id,
          assetId: 'a',
          rights: RIGHTS,
          expectedRevision: 3,
          streamIndex: 1,
        }),
      /already exists/,
    );

    const project = await loadProject(root);
    assert.equal(project.revision, 3);
    assert.deepEqual(
      project.assets.map(item => item.id),
      ['a', 'b'],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('extractAudio propagates simulated parent lineage and takes caller rights verbatim', async () => {
  const root = await tempRoot();
  try {
    await atomicJson(nodePath.join(root, 'project.json'), baseProject('extract_audio_sim'));
    const multi = nodePath.join(root, 'multi.mp4');
    await makeMultiStreamFile(multi);
    const { artifact } = await manualBuild(root, 'artifact-sim-0001', multi, { simulated: true });

    const asset = await extractAudio(root, {
      artifact: artifact.id,
      assetId: 'sim_audio',
      rights: RIGHTS,
      expectedRevision: 1,
      streamIndex: 0,
    });
    assert.equal(asset.simulated, true, 'a simulated parent taints the derived audio');
    assert.deepEqual(asset.rights, RIGHTS, 'rights are the caller’s, never inferred from the parent');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an extracted audio Asset is placed as an audio clip and mixes into a rebuilt programme', async () => {
  const built = await builtAudioMedia();
  const { root } = built;
  try {
    const asset = await extractAudio(root, {
      take: built.take.id,
      assetId: 'mixed_audio',
      rights: PUBLIC_RIGHTS,
      expectedRevision: 1,
      streamIndex: 0,
    });
    const sampleRate = built.artifact.media!.audio!.sampleRate;
    const project = await loadProject(root);
    project.composition!.audio = [
      {
        id: 'clip_audio',
        kind: 'asset',
        asset: asset.id,
        inSample: 0,
        startSample: 0,
        durationSamples: sampleRate,
        gain: 1,
        fadeInSamples: 0,
        fadeOutSamples: 0,
      },
    ];
    await saveProject(root, project, project.revision);
    const rebuilt = await buildProject(root);
    assert.equal(rebuilt.status, 'succeeded', 'a programme mixing the extracted Asset must build');
    const final = rebuilt.artifacts.find(item => item.id === rebuilt.result!.artifact)!;
    assert.ok(final.media?.audio, 'the rebuilt programme carries the mixed audio');
    assert.equal((await loadProject(root)).composition!.audio[0]!.kind, 'asset');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('validateProject rejects a forged audio derivation', async () => {
  const built = await builtAudioMedia();
  try {
    const asset = await extractAudio(built.root, {
      take: built.take.id,
      assetId: 'checked_audio',
      rights: RIGHTS,
      expectedRevision: 1,
      streamIndex: 0,
    });
    const project = await loadProject(built.root);
    const forged = {
      ...project,
      assets: project.assets.map(item =>
        item.id === asset.id ? { ...item, derivedFrom: { ...asset.derivedFrom!, outputSha256: 'f'.repeat(64) } } : item,
      ),
    };
    assert.throws(() => validateProject(forged), /outputSha256 does not match/);
  } finally {
    await fs.rm(built.root, { recursive: true, force: true });
  }
});

test('an audio-derived Asset and its protected parent survive export and archive/restore', async () => {
  const built = await builtAudioMedia();
  const { root, take, artifact, artifactPath } = built;
  const outside = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-audio-delivery-'));
  try {
    const asset = await extractAudio(root, {
      take: take.id,
      assetId: 'delivered_audio',
      rights: PUBLIC_RIGHTS,
      expectedRevision: 1,
      streamIndex: 0,
    });

    // Portable export carries the derivation AND the parent artifact bytes.
    const exported = nodePath.join(outside, 'portable');
    await exportProject(root, exported);
    const exportedProject = validateProject(
      JSON.parse(await fs.readFile(nodePath.join(exported, 'project.json'), 'utf8')),
    );
    const exportedAsset = exportedProject.assets.find(item => item.id === 'delivered_audio')!;
    assert.deepEqual(exportedAsset.derivedFrom, asset.derivedFrom, 'portable export keeps the audio derivation');
    assert.equal(
      await hashFile(nodePath.join(exported, artifact.path)),
      artifact.sha256,
      'the parent Artifact is protected by the closure and shipped',
    );
    assert.equal(await hashFile(nodePath.join(exported, exportedAsset.path)), asset.sha256);

    // Archive round-trip: the derivation is preserved and the parent is present.
    const archive = nodePath.join(outside, 'project.tar.gz');
    await archiveProject(root, archive);
    const restored = nodePath.join(outside, 'restored');
    await restoreProject(archive, restored);
    const restoredProject = await loadProject(restored);
    const restoredAsset = restoredProject.assets.find(item => item.id === 'delivered_audio')!;
    assert.deepEqual(restoredAsset.derivedFrom, asset.derivedFrom, 'archive/restore keeps the audio derivation');
    assert.equal(await hashFile(nodePath.join(restored, restoredAsset.path)), asset.sha256);
    assert.equal(
      await hashFile(nodePath.join(restored, artifact.path)),
      artifact.sha256,
      'the parent Artifact bytes survive restore',
    );
    assert.equal(await hashFile(artifactPath), artifact.sha256, 'the original parent bytes are untouched');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('ExtractAudioOptionsSchema requires exactly one parent and an explicit streamIndex', () => {
  assert.equal(
    ExtractAudioOptionsSchema.safeParse({
      assetId: 'a',
      rights: RIGHTS,
      expectedRevision: 1,
      streamIndex: 0,
    }).success,
    false,
    'a parent (take or artifact) is required',
  );
  assert.equal(
    ExtractAudioOptionsSchema.safeParse({
      take: 't',
      artifact: 'art',
      assetId: 'a',
      rights: RIGHTS,
      expectedRevision: 1,
      streamIndex: 0,
    }).success,
    false,
    'two parents are refused',
  );
  assert.equal(
    ExtractAudioOptionsSchema.safeParse({
      take: 't',
      assetId: 'a',
      rights: RIGHTS,
      expectedRevision: 1,
    }).success,
    false,
    'streamIndex is required (no implicit default)',
  );
  assert.equal(
    ExtractAudioOptionsSchema.safeParse({
      take: 't',
      assetId: 'a',
      rights: RIGHTS,
      expectedRevision: 1,
      streamIndex: 0,
    }).success,
    true,
  );
});
