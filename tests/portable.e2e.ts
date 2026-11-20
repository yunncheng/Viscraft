import { createSymlinkFixture } from './fs-fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { exportProject } from '../src/operations/delivery/portable.js';
import { PortableManifestSchema } from '../src/operations/delivery/portable-contract.js';
import { loadProject, saveProject, validateProject } from '../src/project/project.js';
import { loadRecording } from '../src/backends/playable/recording.js';
import { buildProject } from '../src/build/build.js';
import { reviewBuild } from '../src/operations/analysis/review.js';
import { findBrowser } from '../src/backends/browser/capture.js';
import { simulatedStatus } from '../src/backends/providers/simulated.js';
import { hashFile, stableHash } from '../src/shared/hash.js';
import { snapshotHashOf } from '../src/project/state.js';
import { runCommand } from '../src/shared/process.js';
import type { Asset, Project } from '../src/core/schema.js';
import { writeSignalAsset } from './audio-fixtures.js';

const HEX_ZERO = '0'.repeat(64);
const BUILD_ID = `build-${'b'.repeat(36)}`;
const ARTIFACT_ID = `artifact-${'c'.repeat(40)}`;
const TAKE_ID = `take-${'d'.repeat(40)}`;
const ARTIFACT_REL = `.viscraft/artifacts/${ARTIFACT_ID}.mp4`;
const MISSING_TAKE = `take-${'e'.repeat(40)}`;

async function tmp(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'viscraft-portable-'));
}
async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
async function mutateJson(file: string, change: (value: any) => void): Promise<void> {
  const value = JSON.parse(await readFile(file, 'utf8'));
  change(value);
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}
function codeSource(entry: string, resources: string[] = [], id = 'src'): Project['sources'][number] {
  return { id, kind: 'browser', output: 'picture', entry, resources, bindings: [], params: {}, seed: 0, frames: 1 };
}
function baseProject(overrides: Partial<Project> = {}): Project {
  return {
    schemaVersion: 1,
    id: 'portable-test',
    revision: 1,
    title: 'Portable Test',
    direction: { intent: '', looks: [{ id: 'look', description: '' }], transitions: [] },
    assets: [],
    bindings: {},
    sources: [codeSource('scene.html')],
    composition: {
      output: { width: 32, height: 32, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene', description: '' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: '', targetFrames: 1 }],
      placements: [{ id: 'edit', shot: 'shot', source: 'src', inFrame: 0, outFrame: 1, startFrame: 0, audio: 'mute' }],
      transitions: [],
      audio: [],
    },
    ...overrides,
  } as Project;
}
function lineageProject(take: string, assets: Asset[] = [], handoff: string[] = []): Project {
  return baseProject({
    id: 'portable-lineage',
    title: 'Lineage',
    assets,
    ...(handoff.length > 0 ? { handoff: handoff.map(path => ({ path, role: 'license' as const })) } : {}),
    sources: [],
    composition: {
      output: { width: 32, height: 32, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene', description: '' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: '', targetFrames: 2 }],
      placements: [{ id: 'edit', shot: 'shot', take, inFrame: 0, outFrame: 2, startFrame: 0, audio: 'mute' }],
      transitions: [],
      audio: [],
    },
  });
}

const REDISTRIBUTABLE = { origin: 'test', license: 'CC0-1.0', redistributable: true } as const;

/** Write asset bytes and build an Asset whose recorded hash matches the file. */
async function writeAsset(
  root: string,
  relative: string,
  contents: Buffer | string,
  id: string,
  rights: Asset['rights'] = REDISTRIBUTABLE,
  type: Asset['type'] = 'image',
  simulated = false,
): Promise<Asset> {
  const absolute = path.join(root, ...relative.split('/'));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
  return { id, revision: 1, path: relative, sha256: await hashFile(absolute), type, rights, simulated };
}

/** Bundle-relative content-addressed blobs staged by a v1 export. */
async function contentBlobs(destination: string): Promise<string[]> {
  return (await listFiles(destination)).filter(file => file.startsWith('.viscraft/content/'));
}

/** Deterministic ~N-byte payload so a shared Asset is large enough to matter. */
function payload(size: number, seed = 1): Buffer {
  const buffer = Buffer.alloc(size);
  let state = seed >>> 0;
  for (let index = 0; index < size; index++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    buffer[index] = state >>> 24;
  }
  return buffer;
}

const PLAYABLE_OUTPUT = {
  width: 32,
  height: 32,
  fps: { numerator: 5, denominator: 1 },
  sampleRate: 48000 as const,
  channels: 1 as const,
};

/** A playable-source project pointing at `recording`, optionally binding assets. */
function playableProject(args: {
  recording: string;
  entry?: string;
  resources?: string[];
  bindings?: string[];
  params?: Record<string, unknown>;
  seed?: number;
  frames?: number;
  assets?: Asset[];
  projectBindings?: Record<string, string>;
}): Project {
  const {
    recording,
    entry = 'game.html',
    resources = [],
    bindings = [],
    params = {},
    seed = 0,
    frames = 1,
    assets = [],
    projectBindings = {},
  } = args;
  return baseProject({
    id: 'portable-playable',
    title: 'Portable Playable',
    assets,
    bindings: projectBindings,
    sources: [
      { id: 'game', kind: 'browser', output: 'picture', entry, resources, bindings, params, seed, frames, recording },
    ],
    composition: {
      output: PLAYABLE_OUTPUT,
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

interface RecordingFixture {
  entry: string;
  resources: string[];
  bindings: string[];
  params: Record<string, unknown>;
  seed: number;
  frames: number;
  /** The exact `source.files` list written into the recording (may be tampered). */
  files: Array<{ path: string; sha256: string }>;
  /** Override the frozen signature key (defaults to the internally consistent one). */
  key?: string;
  simulated?: boolean;
  id?: string;
}

/**
 * Write a schema-valid playable recording (plus its preview media) without a
 * browser. `loadRecording` accepts it; `files`/`key` let a test tamper with the
 * recorded dependency list or signature, which an export must cross-check
 * against the actual source.
 */
async function writeRecording(root: string, fixture: RecordingFixture): Promise<{ rel: string; recording: unknown }> {
  const { entry, resources, bindings, params, seed, frames, files } = fixture;
  const id = fixture.id ?? 'rec-fixture';
  const rel = `recordings/${id}/session.json`;
  const mediaRel = `recordings/${id}/preview.mp4`;
  await mkdir(path.dirname(path.join(root, mediaRel)), { recursive: true });
  await writeFile(path.join(root, mediaRel), Buffer.from(`preview-${id}`));
  const mediaSha = await hashFile(path.join(root, mediaRel));
  const key = fixture.key ?? stableHash({ entry, resources, bindings, params, seed, frames, output: PLAYABLE_OUTPUT });
  const recording = {
    schemaVersion: 1,
    id,
    source: { id: 'game', key, entry, resources, bindings, params, seed, files },
    output: PLAYABLE_OUTPUT,
    frames,
    events: [],
    states: Array.from({ length: frames }, (_, frame) => ({ frame, state: {} })),
    media: {
      path: mediaRel,
      sha256: mediaSha,
      info: {
        frames,
        fps: PLAYABLE_OUTPUT.fps,
        width: PLAYABLE_OUTPUT.width,
        height: PLAYABLE_OUTPUT.height,
        duration: frames / 5,
        videoCodec: 'h264',
      },
    },
    simulated: fixture.simulated ?? false,
  };
  await writeJson(path.join(root, rel), recording);
  return { rel, recording };
}

/**
 * A self-consistent lineage whose frozen snapshot holds a *playable* source: the
 * current project selects the frozen Take while the frozen project also freezes
 * its own recording + preview. Exercises the frozen playable dependency path.
 */
async function makePlayableLineage(
  root: string,
  options: { frozenRecordingFiles?: Array<{ path: string; sha256: string }> } = {},
): Promise<void> {
  const entryRel = 'game.html';
  const recordingRel = 'recordings/rec-fixture/session.json';
  const mediaRel = 'recordings/rec-fixture/preview.mp4';
  const composition = () => ({
    output: PLAYABLE_OUTPUT,
    scenes: [{ id: 'scene', description: '' }],
    shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: '', targetFrames: 2 }],
    placements: [
      { id: 'edit', shot: 'shot', take: TAKE_ID, inFrame: 0, outFrame: 2, startFrame: 0, audio: 'mute' as const },
    ],
    transitions: [],
    audio: [],
  });

  // Current authored project: a playable source plus a placement selecting the Take.
  await writeFile(path.join(root, entryRel), '<html>current playable</html>');
  const currentEntrySha = await hashFile(path.join(root, entryRel));
  const current = await writeRecording(root, {
    entry: entryRel,
    resources: [],
    bindings: [],
    params: {},
    seed: 0,
    frames: 1,
    files: [{ path: entryRel, sha256: currentEntrySha }],
  });
  await writeJson(
    path.join(root, 'project.json'),
    baseProject({
      id: 'portable-playable-lineage',
      sources: [
        {
          id: 'game',
          kind: 'browser',
          output: 'picture',
          entry: entryRel,
          resources: [],
          bindings: [],
          params: {},
          seed: 0,
          frames: 1,
          recording: current.rel,
        },
      ],
      composition: composition(),
    }),
  );

  // Frozen snapshot: the same playable source, frozen with its recording + preview.
  const frozen = baseProject({
    id: 'portable-playable-lineage',
    sources: [
      {
        id: 'game',
        kind: 'browser',
        output: 'picture',
        entry: entryRel,
        resources: [],
        bindings: [],
        params: {},
        seed: 0,
        frames: 1,
        recording: recordingRel,
      },
    ],
    composition: composition(),
  });
  const frozenParsed = validateProject(frozen);

  const snapshotDir = path.join(root, '.viscraft', 'snapshots', BUILD_ID);
  await mkdir(snapshotDir, { recursive: true });
  const frozenEntry = path.join(snapshotDir, entryRel);
  await writeFile(frozenEntry, '<html>frozen playable</html>');
  const frozenEntrySha = await hashFile(frozenEntry);
  const frozenMedia = path.join(snapshotDir, ...mediaRel.split('/'));
  await mkdir(path.dirname(frozenMedia), { recursive: true });
  await writeFile(frozenMedia, 'frozen-preview');
  const frozenMediaSha = await hashFile(frozenMedia);
  const frozenKey = stableHash({
    entry: entryRel,
    resources: [],
    bindings: [],
    params: {},
    seed: 0,
    frames: 1,
    output: PLAYABLE_OUTPUT,
  });
  const frozenRecording = {
    schemaVersion: 1,
    id: 'rec-fixture',
    source: {
      id: 'game',
      key: frozenKey,
      entry: entryRel,
      resources: [],
      bindings: [],
      params: {},
      seed: 0,
      files: options.frozenRecordingFiles ?? [{ path: entryRel, sha256: frozenEntrySha }],
    },
    output: PLAYABLE_OUTPUT,
    frames: 1,
    events: [],
    states: [{ frame: 0, state: {} }],
    media: {
      path: mediaRel,
      sha256: frozenMediaSha,
      info: { frames: 1, fps: PLAYABLE_OUTPUT.fps, width: 32, height: 32, duration: 0.2, videoCodec: 'h264' },
    },
    simulated: false,
  };
  const frozenSession = path.join(snapshotDir, ...recordingRel.split('/'));
  await mkdir(path.dirname(frozenSession), { recursive: true });
  await writeFile(frozenSession, `${JSON.stringify(frozenRecording, null, 2)}\n`);
  const frozenSessionSha = await hashFile(frozenSession);

  const files: Record<string, string> = {
    [entryRel]: frozenEntrySha,
    [recordingRel]: frozenSessionSha,
    [mediaRel]: frozenMediaSha,
  };
  const computedHash = snapshotHashOf(frozenParsed, files, []);
  await writeJson(path.join(root, '.viscraft', 'snapshots', `${BUILD_ID}.project.json`), frozen);
  await writeJson(path.join(root, '.viscraft', 'snapshots', `${BUILD_ID}.inputs.json`), {
    files,
    unavailable: [],
  });

  const artifactFile = path.join(root, ...ARTIFACT_REL.split('/'));
  await mkdir(path.dirname(artifactFile), { recursive: true });
  await writeFile(artifactFile, 'fake-simulated-mp4-bytes');
  const actualSha = await hashFile(artifactFile);
  const artifact = {
    id: ARTIFACT_ID,
    path: ARTIFACT_REL,
    sha256: actualSha,
    kind: 'video',
    simulated: true,
    operation: 'simulated',
    inputs: ['f'.repeat(64)],
    backend: 'ffmpeg-simulated/test-only',
    media: {
      frames: 2,
      fps: { numerator: 5, denominator: 1 },
      width: 32,
      height: 32,
      duration: 2 / 5,
      videoCodec: 'h264',
    },
  };
  const take = {
    id: TAKE_ID,
    artifact: ARTIFACT_ID,
    source: 'game',
    sourceKey: 'f'.repeat(64),
    medium: 'picture',
    frames: 2,
    fps: { numerator: 5, denominator: 1 },
    simulated: true,
  };
  const build = {
    schemaVersion: 1,
    id: BUILD_ID,
    medium: 'picture',
    run: { id: `run-${'a'.repeat(36)}`, goal: 'playable lineage' },
    plan: { operations: ['op-' + 'e'.repeat(32)] },
    revision: 1,
    snapshotHash: computedHash,
    status: 'succeeded',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    operations: [
      {
        id: 'op-' + 'e'.repeat(32),
        kind: 'simulated',
        key: 'f'.repeat(64),
        inputs: ['f'.repeat(64)],
        artifact: ARTIFACT_ID,
        reused: false,
      },
    ],
    artifacts: [artifact],
    takes: [take],
    result: { artifact: ARTIFACT_ID, simulated: true },
  };
  await writeJson(path.join(root, '.viscraft', 'builds', `${BUILD_ID}.json`), build);
  await writeJson(path.join(root, '.viscraft', 'result.json'), {
    build: BUILD_ID,
    artifact: ARTIFACT_ID,
    simulated: true,
    path: ARTIFACT_REL,
    sha256: actualSha,
  });
}

interface LineageOptions {
  withResult?: boolean;
  declaredArtifactSha?: string;
  snapshotHash?: string;
  frozenAsset?: Asset;
  decoyInSnapshot?: boolean;
  /** Override the frozen code source entry (e.g. to a runtime `.viscraft/` path). */
  frozenSourceEntry?: string;
  /** Extra frozen code source resources (e.g. a credential file name). */
  frozenResources?: string[];
  /**
   * Write an extra file into the frozen snapshot *and record it in the inputs
   * manifest* so the recomputed snapshotHash stays internally consistent. A
   * faithful export must still refuse it because the frozen project does not use
   * it (and runtime-tree paths are rejected outright).
   */
  unauthorizedSnapshotFile?: { path: string; contents: string };
  /** A receiver-facing handoff file declared by BOTH the current and frozen project. */
  handoff?: string;
}

/** Build a minimal, self-consistent Build/Artifact/snapshot lineage on disk. */
async function makeLineage(root: string, options: LineageOptions = {}): Promise<void> {
  const {
    withResult = true,
    declaredArtifactSha,
    snapshotHash,
    frozenAsset,
    decoyInSnapshot = false,
    frozenSourceEntry = 'scene.html',
    frozenResources = [],
    unauthorizedSnapshotFile,
    handoff,
  } = options;
  const frozen = baseProject({
    ...(handoff ? { handoff: [{ path: handoff, role: 'license' as const }] } : {}),
    sources: [codeSource(frozenSourceEntry, frozenResources, 'src_code')],
    composition: {
      output: { width: 32, height: 32, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene', description: '' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: '', targetFrames: 2 }],
      placements: [{ id: 'edit', shot: 'shot', take: TAKE_ID, inFrame: 0, outFrame: 2, startFrame: 0, audio: 'mute' }],
      transitions: [],
      audio: [],
    },
    assets: frozenAsset ? [frozenAsset] : [],
  });
  const frozenParsed = validateProject(frozen);

  const snapshotDir = path.join(root, '.viscraft', 'snapshots', BUILD_ID);
  await mkdir(snapshotDir, { recursive: true });
  const entryFile = path.join(snapshotDir, ...frozenSourceEntry.split('/'));
  await mkdir(path.dirname(entryFile), { recursive: true });
  await writeFile(entryFile, '<html>frozen</html>');
  const files: Record<string, string> = { [frozenSourceEntry]: await hashFile(entryFile) };
  for (const resource of frozenResources) {
    const resourceFile = path.join(snapshotDir, ...resource.split('/'));
    await mkdir(path.dirname(resourceFile), { recursive: true });
    await writeFile(resourceFile, 'frozen-resource');
    files[resource] = await hashFile(resourceFile);
  }
  if (frozenAsset) {
    const assetFile = path.join(snapshotDir, ...frozenAsset.path.split('/'));
    await mkdir(path.dirname(assetFile), { recursive: true });
    await writeFile(assetFile, 'frozen-asset-bytes');
    files[frozenAsset.path] = await hashFile(assetFile);
  }
  if (handoff) {
    const handoffFile = path.join(snapshotDir, ...handoff.split('/'));
    await mkdir(path.dirname(handoffFile), { recursive: true });
    await writeFile(handoffFile, 'frozen notice bytes');
    files[handoff] = await hashFile(handoffFile);
  }
  if (decoyInSnapshot) await writeFile(path.join(snapshotDir, 'secret.txt'), 'do not package me');
  if (unauthorizedSnapshotFile) {
    const extra = path.join(snapshotDir, ...unauthorizedSnapshotFile.path.split('/'));
    await mkdir(path.dirname(extra), { recursive: true });
    await writeFile(extra, unauthorizedSnapshotFile.contents);
    files[unauthorizedSnapshotFile.path] = await hashFile(extra);
  }

  const inputs = { files, unavailable: [] };
  const computedHash = snapshotHash ?? snapshotHashOf(frozenParsed, files, []);
  await writeJson(path.join(root, '.viscraft', 'snapshots', `${BUILD_ID}.project.json`), frozen);
  await writeJson(path.join(root, '.viscraft', 'snapshots', `${BUILD_ID}.inputs.json`), inputs);

  const artifactFile = path.join(root, ...ARTIFACT_REL.split('/'));
  await mkdir(path.dirname(artifactFile), { recursive: true });
  await writeFile(artifactFile, 'fake-simulated-mp4-bytes');
  const actualSha = await hashFile(artifactFile);
  const artifact = {
    id: ARTIFACT_ID,
    path: ARTIFACT_REL,
    sha256: declaredArtifactSha ?? actualSha,
    kind: 'video',
    simulated: true,
    operation: 'simulated',
    inputs: ['f'.repeat(64)],
    backend: 'ffmpeg-simulated/test-only',
    media: {
      frames: 2,
      fps: { numerator: 30, denominator: 1 },
      width: 32,
      height: 32,
      duration: 2 / 30,
      videoCodec: 'h264',
    },
  };
  const take = {
    id: TAKE_ID,
    artifact: ARTIFACT_ID,
    source: 'src_code',
    sourceKey: 'f'.repeat(64),
    medium: 'picture',
    frames: 2,
    fps: { numerator: 30, denominator: 1 },
    simulated: true,
  };
  const build = {
    schemaVersion: 1,
    id: BUILD_ID,
    medium: 'picture',
    run: { id: `run-${'a'.repeat(36)}`, goal: 'test build' },
    plan: { operations: ['op-' + 'e'.repeat(32)] },
    revision: 1,
    snapshotHash: computedHash,
    status: 'succeeded',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    operations: [
      {
        id: 'op-' + 'e'.repeat(32),
        kind: 'simulated',
        key: 'f'.repeat(64),
        inputs: ['f'.repeat(64)],
        artifact: ARTIFACT_ID,
        reused: false,
      },
    ],
    artifacts: [artifact],
    takes: [take],
    result: { artifact: ARTIFACT_ID, simulated: true },
  };
  await writeJson(path.join(root, '.viscraft', 'builds', `${BUILD_ID}.json`), build);
  if (withResult) {
    await writeJson(path.join(root, '.viscraft', 'result.json'), {
      build: BUILD_ID,
      artifact: ARTIFACT_ID,
      simulated: true,
      path: ARTIFACT_REL,
      sha256: declaredArtifactSha ?? actualSha,
    });
  }
}

test('export creates a reopenable project directory with a hashed manifest', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await writeJson(
      path.join(root, 'project.json'),
      baseProject({ sources: [codeSource('scene.html', ['lib/util.js'])] }),
    );
    await writeFile(path.join(root, 'scene.html'), '<html></html>');
    await mkdir(path.join(root, 'lib'), { recursive: true });
    await writeFile(path.join(root, 'lib', 'util.js'), 'export const x = 1;');
    const destination = path.join(parent, 'exported');
    const result = await exportProject(root, destination);
    assert.equal(result.path, destination);
    assert.equal(result.files, 4); // + the rendered VISCRAFT.md fact page
    assert.equal(result.simulated, false);
    const reopened = await loadProject(destination);
    assert.equal(reopened.id, 'portable-test');
    assert.equal(reopened.revision, 1);
    const files = await listFiles(destination);
    assert.ok(files.includes('project.json') && files.includes('scene.html') && files.includes('lib/util.js'));
    assert.ok(files.includes('.viscraft/portable-manifest.json'));
    const manifest = JSON.parse(await readFile(path.join(destination, '.viscraft', 'portable-manifest.json'), 'utf8'));
    assert.equal(manifest.simulated, false);
    assert.equal(manifest.project.id, 'portable-test');
    assert.equal(manifest.scope.requested, 'default');
    assert.equal(manifest.scope.counts.files, manifest.files.length);
    assert.equal(manifest.scope.originalsComplete, true);
    assert.deepEqual(manifest.scope.missing, []);
    assert.ok(
      manifest.files.some(
        (f: { path: string; sha256: string }) => f.path === 'scene.html' && /^[a-f0-9]{64}$/.test(f.sha256),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('export rejects a missing authored source file', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await writeJson(path.join(root, 'project.json'), baseProject());
    await assert.rejects(
      exportProject(root, path.join(parent, 'out')),
      (error: Error) => {
        assert.match(error.message, /cannot export the whole author state/i);
        assert.match(error.message, /scene\.html/);
        assert.match(error.message, /path-missing|no such file|ENOENT/i);
        return true;
      },
      'a missing authored file is a recorded gap the default strict export refuses',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('export rejects an asset whose bytes do not match its recorded hash', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    const asset: Asset = {
      id: 'asset-a',
      revision: 1,
      path: 'media/a.bin',
      sha256: HEX_ZERO,
      type: 'image',
      rights: { origin: 'test', license: 'test', redistributable: true },
      simulated: false,
    };
    await writeJson(path.join(root, 'project.json'), baseProject({ assets: [asset] }));
    await writeFile(path.join(root, 'scene.html'), '<html></html>');
    await mkdir(path.join(root, 'media'), { recursive: true });
    await writeFile(path.join(root, 'media', 'a.bin'), 'real-bytes');
    // The readable bytes that disagree with the declared digest are kept as a
    // `hash-mismatch` gap: the export refuses to package them under the declared
    // identity, and the message states the expected digest.
    await assert.rejects(exportProject(root, path.join(parent, 'out')), (error: Error) => {
      assert.match(error.message, /media\/a\.bin/);
      assert.match(error.message, /hash-mismatch/i);
      assert.ok(error.message.includes(HEX_ZERO), 'the expected digest is stated');
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('export refuses symlinked project paths', async t => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await writeJson(path.join(root, 'project.json'), baseProject({ sources: [codeSource('link/scene.html')] }));
    await mkdir(path.join(root, 'real'), { recursive: true });
    await writeFile(path.join(root, 'real', 'scene.html'), '<html></html>');
    await createSymlinkFixture(t, path.join(root, 'real'), path.join(root, 'link'));
    await assert.rejects(exportProject(root, path.join(parent, 'out')), /Symbolic/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('export refuses to package a non-redistributable asset', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    const asset: Asset = {
      id: 'asset-private',
      revision: 1,
      path: 'media/private.png',
      sha256: HEX_ZERO,
      type: 'image',
      rights: { origin: 'stock', license: 'editorial-only', redistributable: false },
      simulated: false,
    };
    await writeJson(path.join(root, 'project.json'), baseProject({ assets: [asset] }));
    await writeFile(path.join(root, 'scene.html'), '<html></html>');
    await assert.rejects(exportProject(root, path.join(parent, 'out')), /not redistributable/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('export excludes scratch, jobs, remote, secrets, unknown files and node_modules', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await writeJson(path.join(root, 'project.json'), baseProject());
    await writeFile(path.join(root, 'scene.html'), '<html></html>');
    await writeJson(path.join(root, '.viscraft', 'jobs', 'attempt.json'), { prompt: 'no' });
    await mkdir(path.join(root, '.viscraft', 'scratch'), { recursive: true });
    await writeFile(path.join(root, '.viscraft', 'scratch', 'junk.bin'), 'junk');
    await mkdir(path.join(root, '.viscraft', 'remote'), { recursive: true });
    await writeFile(path.join(root, '.viscraft', 'remote', 'r.mp4'), 'junk');
    await writeFile(path.join(root, 'secrets.txt'), 'api_key=leak');
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'junk');
    const destination = path.join(parent, 'exported');
    await exportProject(root, destination);
    const files = await listFiles(destination);
    for (const forbidden of [
      'secrets.txt',
      'node_modules/pkg/index.js',
      '.viscraft/jobs/attempt.json',
      '.viscraft/scratch/junk.bin',
      '.viscraft/remote/r.mp4',
    ]) {
      assert.ok(!files.includes(forbidden), `should not package ${forbidden}`);
    }
    assert.ok(!files.some(f => f.startsWith('node_modules/')));
    assert.ok(files.includes('project.json') && files.includes('scene.html'));
    assert.deepEqual(
      files.filter(f => f.startsWith('.viscraft/') && !f.startsWith('.viscraft/pages/')),
      ['.viscraft/portable-manifest.json'],
      'no runtime state is carried; generated pages live under the runtime page dir',
    );
    assert.ok(files.includes('.viscraft/pages/VISCRAFT.md'));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('export rejects destinations that are inside, equal to, an ancestor of, or already at the target', async () => {
  const parent = await tmp();
  try {
    const root = path.join(parent, 'proj');
    await writeJson(path.join(root, 'project.json'), baseProject());
    await writeFile(path.join(root, 'scene.html'), '<html></html>');
    await assert.rejects(exportProject(root, path.join(root, 'inside')), /outside the project root/);
    await assert.rejects(exportProject(root, root), /outside the project root/);
    const ancestorBase = path.join(parent, 'outer');
    const nested = path.join(ancestorBase, 'proj');
    await writeJson(path.join(nested, 'project.json'), baseProject());
    await writeFile(path.join(nested, 'scene.html'), '<html></html>');
    await assert.rejects(exportProject(nested, ancestorBase), /outside the project root/);
    const used = path.join(parent, 'used');
    await mkdir(used, { recursive: true });
    await assert.rejects(exportProject(root, used), /already exists/);
    assert.deepEqual(await listFiles(used), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('export packages the selected Take lineage, frozen snapshot and simulated flags', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await writeJson(path.join(root, 'project.json'), lineageProject(TAKE_ID));
    await makeLineage(root, { decoyInSnapshot: true });
    const destination = path.join(parent, 'exported');
    const result = await exportProject(root, destination);
    assert.equal(result.simulated, true);
    const files = await listFiles(destination);
    for (const expected of [
      `.viscraft/builds/${BUILD_ID}.json`,
      ARTIFACT_REL,
      `.viscraft/snapshots/${BUILD_ID}.project.json`,
      `.viscraft/snapshots/${BUILD_ID}.inputs.json`,
      `.viscraft/snapshots/${BUILD_ID}/scene.html`,
      '.viscraft/result.json',
    ]) {
      assert.ok(files.includes(expected), `expected ${expected}`);
    }
    assert.ok(!files.includes(`.viscraft/snapshots/${BUILD_ID}/secret.txt`));
    assert.equal(await loadProject(destination).then(p => p.id), 'portable-lineage');
    const manifest = JSON.parse(await readFile(path.join(destination, '.viscraft', 'portable-manifest.json'), 'utf8'));
    assert.equal(manifest.simulated, true);
    assert.ok(manifest.builds.includes(BUILD_ID));
    assert.ok(manifest.artifacts.includes(ARTIFACT_ID));
    assert.equal(manifest.scope.counts.builds, 1);
    assert.equal(manifest.scope.counts.artifacts, 1);
    assert.equal(manifest.scope.counts.files, manifest.files.length);
    const artifactEntry = manifest.files.find((f: { path: string }) => f.path === ARTIFACT_REL);
    assert.equal(artifactEntry.provenance.kind, 'artifact');
    assert.equal(artifactEntry.provenance.simulated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('a Project that declares handoff files exports its frozen lineage and carries them', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    const handoff = 'licenses/NOTICE.md';
    await writeJson(path.join(root, 'project.json'), lineageProject(TAKE_ID, [], [handoff]));
    await mkdir(path.join(root, 'licenses'), { recursive: true });
    await writeFile(path.join(root, handoff), 'third-party notice');
    await makeLineage(root, { handoff });
    const destination = path.join(parent, 'exported');
    await exportProject(root, destination);
    const files = await listFiles(destination);
    // The current receiver-facing file and the frozen copy are both declared
    // authored facts; the frozen lineage must record exactly those paths.
    assert.ok(files.includes(handoff), 'the handoff file travels at its author path');
    assert.ok(
      files.includes(`.viscraft/snapshots/${BUILD_ID}/${handoff}`),
      'the frozen snapshot carries the same authored bytes',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('export refuses a selected Take with no Build record', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await writeJson(path.join(root, 'project.json'), lineageProject(MISSING_TAKE));
    await assert.rejects(exportProject(root, path.join(parent, 'out')), /has no Build record/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('export refuses a frozen snapshot carrying a non-redistributable asset', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await writeJson(path.join(root, 'project.json'), lineageProject(TAKE_ID));
    const frozenAsset: Asset = {
      id: 'asset-frozen',
      revision: 1,
      path: 'media/a.bin',
      sha256: HEX_ZERO,
      type: 'image',
      rights: { origin: 'stock', license: 'editorial-only', redistributable: false },
      simulated: false,
    };
    await makeLineage(root, { frozenAsset });
    await assert.rejects(exportProject(root, path.join(parent, 'out')), /non-redistributable Asset/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('export refuses a tampered frozen snapshot hash', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await writeJson(path.join(root, 'project.json'), lineageProject(TAKE_ID));
    await makeLineage(root, { snapshotHash: HEX_ZERO });
    await assert.rejects(exportProject(root, path.join(parent, 'out')), /Frozen snapshot hash mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('export refuses an artifact whose bytes do not match the recorded hash', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await writeJson(path.join(root, 'project.json'), lineageProject(TAKE_ID));
    await makeLineage(root, { withResult: false, declaredArtifactSha: HEX_ZERO });
    await assert.rejects(exportProject(root, path.join(parent, 'out')), /hash mismatch/i);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('export refuses a frozen snapshot manifest that records an unauthorized file', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await writeJson(path.join(root, 'project.json'), lineageProject(TAKE_ID));
    // The extra key is recorded *and* included in the recomputed snapshot hash,
    // so the hash check passes — the strict allowlist must still reject it.
    await makeLineage(root, { unauthorizedSnapshotFile: { path: '.env', contents: 'API_KEY=leak' } });
    await assert.rejects(exportProject(root, path.join(parent, 'out')), /does not record exactly/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('export refuses a frozen project whose authored path lives under .viscraft/', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await writeJson(path.join(root, 'project.json'), lineageProject(TAKE_ID));
    await makeLineage(root, { frozenSourceEntry: '.viscraft/leak.js' });
    await assert.rejects(exportProject(root, path.join(parent, 'out')), /must not be stored under \.viscraft\//);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('export refuses credential files even when a source lists them as explicit resources', async () => {
  const cases: Array<{ resource: string; contents?: string }> = [
    { resource: '.env' },
    { resource: '.ENV' },
    { resource: 'config/.env.production', contents: 'API_KEY=leak' },
    { resource: 'config/.EnV.production', contents: 'API_KEY=leak' },
  ];
  for (const [index, item] of cases.entries()) {
    const root = await tmp();
    const parent = await tmp();
    try {
      await writeJson(
        path.join(root, 'project.json'),
        baseProject({ sources: [codeSource('scene.html', [item.resource])] }),
      );
      await writeFile(path.join(root, 'scene.html'), '<html></html>');
      const resourceFile = path.join(root, ...item.resource.split('/'));
      await mkdir(path.dirname(resourceFile), { recursive: true });
      await writeFile(resourceFile, item.contents ?? 'SECRET=1');
      await assert.rejects(exportProject(root, path.join(parent, `out-${index}`)), /credential file/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(parent, { recursive: true, force: true });
    }
  }
});

test('export allows ordinary art names that merely contain the word secret', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await writeJson(
      path.join(root, 'project.json'),
      baseProject({
        sources: [codeSource('scene.html', ['assets/secret-garden.png', '.secret-art.html', '.environment.js'])],
      }),
    );
    await writeFile(path.join(root, 'scene.html'), '<html></html>');
    await mkdir(path.join(root, 'assets'), { recursive: true });
    await writeFile(path.join(root, 'assets', 'secret-garden.png'), 'art');
    await writeFile(path.join(root, '.secret-art.html'), '<html></html>');
    await writeFile(path.join(root, '.environment.js'), 'export const x = 1;');
    const destination = path.join(parent, 'exported');
    const result = await exportProject(root, destination);
    assert.equal(result.files, 6); // + the rendered VISCRAFT.md fact page
    assert.ok((await listFiles(destination)).includes('assets/secret-garden.png'));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('export refuses a credential file frozen into a snapshot source resource', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await writeJson(path.join(root, 'project.json'), lineageProject(TAKE_ID));
    await makeLineage(root, { frozenResources: ['.netrc'] });
    await assert.rejects(exportProject(root, path.join(parent, 'out')), /credential file/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('export refuses an active result that does not match a succeeded Build result', async () => {
  const cases: Array<{ name: string; pattern: RegExp; change: (root: string) => Promise<void> }> = [
    {
      name: 'a non-succeeded build',
      pattern: /did not succeed/,
      change: root =>
        mutateJson(path.join(root, '.viscraft', 'builds', `${BUILD_ID}.json`), build => {
          build.status = 'failed';
        }),
    },
    {
      name: 'a simulated-flag mismatch',
      pattern: /provenance does not match/,
      change: root =>
        mutateJson(path.join(root, '.viscraft', 'result.json'), result => {
          result.simulated = false;
        }),
    },
    {
      name: 'a build.result artifact mismatch',
      pattern: /recorded Build result/,
      change: root =>
        mutateJson(path.join(root, '.viscraft', 'builds', `${BUILD_ID}.json`), build => {
          build.result = { artifact: `artifact-${'9'.repeat(40)}`, simulated: true };
        }),
    },
  ];
  for (const [index, item] of cases.entries()) {
    const root = await tmp();
    const parent = await tmp();
    try {
      await writeJson(path.join(root, 'project.json'), lineageProject(TAKE_ID));
      await makeLineage(root);
      await item.change(root);
      await assert.rejects(exportProject(root, path.join(parent, `out-${index}`)), item.pattern, item.name);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(parent, { recursive: true, force: true });
    }
  }
});

test('export records a frozen asset identity, simulated flag and rights in snapshotAssets beside a shared blob', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await writeJson(path.join(root, 'project.json'), lineageProject(TAKE_ID));
    const frozenAsset: Asset = {
      id: 'asset-frozen',
      revision: 1,
      path: 'media/a.bin',
      sha256: HEX_ZERO,
      type: 'image',
      rights: { origin: 'stock', license: 'CC0-1.0', redistributable: true },
      simulated: true,
    };
    await makeLineage(root, { frozenAsset });
    const destination = path.join(parent, 'exported');
    await exportProject(root, destination);
    const manifest = JSON.parse(await readFile(path.join(destination, '.viscraft/portable-manifest.json'), 'utf8'));
    assert.equal(manifest.version, 1);
    const logical = `.viscraft/snapshots/${BUILD_ID}/media/a.bin`;
    const entry = manifest.snapshotAssets.find((candidate: { path: string }) => candidate.path === logical);
    assert.ok(entry, 'the frozen asset must be recorded as a logical snapshot asset');
    assert.equal(entry.provenance.kind, 'asset');
    assert.equal(entry.provenance.assetId, 'asset-frozen');
    assert.equal(entry.provenance.simulated, true);
    assert.equal(entry.provenance.rights.redistributable, true);
    assert.equal(entry.provenance.rights.license, 'CC0-1.0');
    // The bytes are staged once, content-addressed — not at the snapshot path.
    assert.ok(/^[a-f0-9]{64}$/.test(entry.sha256));
    assert.equal(entry.content, `.viscraft/content/${entry.sha256}`);
    const files = await listFiles(destination);
    assert.ok(files.includes(entry.content), 'the content blob must be a physical file');
    assert.ok(!files.includes(logical), 'the deduplicated frozen asset must not stay a physical snapshot file');
    // `files` still matches the staged tree exactly, plus the omitted manifest.
    assert.deepEqual(
      files.filter(file => file !== '.viscraft/portable-manifest.json').sort(),
      manifest.files.map((file: { path: string }) => file.path).sort(),
    );
    const physical = manifest.files.find((candidate: { path: string }) => candidate.path === entry.content);
    assert.equal(physical.provenance.kind, 'snapshot-content');
    assert.equal(physical.sha256, entry.sha256);
    // The frozen source entry and metadata remain physical copies.
    for (const stillPhysical of [
      `.viscraft/snapshots/${BUILD_ID}/scene.html`,
      `.viscraft/snapshots/${BUILD_ID}.project.json`,
      `.viscraft/snapshots/${BUILD_ID}.inputs.json`,
    ]) {
      assert.ok(files.includes(stillPhysical), `expected physical ${stillPhysical}`);
      assert.ok(!manifest.snapshotAssets.some((candidate: { path: string }) => candidate.path === stillPhysical));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('PortableManifestSchema accepts the current format and rejects an unsupported version, a non-canonical content path or a duplicate logical path', () => {
  const scope = {
    requested: 'default' as const,
    includeOriginals: true,
    authoredScope: 'complete' as const,
    authorComplete: true,
    selectedProductionComplete: true,
    wholeAuthorRestorable: true,
    authoredGaps: [],
    counts: { files: 0, builds: 0, artifacts: 0, originals: 0 },
    excluded: [],
    missing: [],
    receiver: { can: [], cannot: [] },
    environment: 'x',
    closureComplete: true,
    rebuildable: true,
    originalsComplete: true,
    historyComplete: true,
    taskRecoverable: true,
  };
  const base = {
    format: 'viscraft-portable-project',
    schemaVersion: 1,
    project: { id: 'p', revision: 1, title: 't' },
    exportedAt: 'x',
    simulated: false,
    builds: [],
    artifacts: [],
    files: [],
    scope,
    notes: [],
  };
  // The current v1 contract requires the complete content-addressed mapping.
  // Other identifiers and incomplete structures are refused without conversion.
  assert.equal(PortableManifestSchema.safeParse({ ...base, version: 1, snapshotAssets: [] }).success, true);
  assert.equal(
    PortableManifestSchema.safeParse({
      ...base,
      version: 1,
      snapshotAssets: [],
      scope: { ...scope, authoredScope: 'allow-incomplete' },
    }).success,
    false,
    'an incomplete authored scope without a recorded gap must be refused',
  );
  assert.equal(
    PortableManifestSchema.safeParse({
      ...base,
      version: 1,
      snapshotAssets: [],
      scope: { ...scope, authorComplete: false },
    }).success,
    false,
    'authorComplete must agree with the recorded gaps',
  );
  assert.equal(
    PortableManifestSchema.safeParse({
      ...base,
      version: 1,
      snapshotAssets: [],
      scope: { ...scope, selectedProductionComplete: false },
    }).success,
    false,
    'a packaged export cannot claim an incomplete selected production closure',
  );
  assert.equal(
    PortableManifestSchema.safeParse({ ...base, version: 1 }).success,
    false,
    'a manifest missing snapshotAssets must be refused',
  );
  assert.equal(PortableManifestSchema.safeParse({ ...base, version: 99, snapshotAssets: [] }).success, false);
  assert.equal(
    PortableManifestSchema.safeParse({ ...base, version: 1, schemaVersion: 99, snapshotAssets: [] }).success,
    false,
  );
  const sha = 'a'.repeat(64);
  const entry = {
    path: '.viscraft/snapshots/build-abc123/media/x.bin',
    sha256: sha,
    content: `.viscraft/content/${sha}`,
    provenance: {
      kind: 'asset',
      assetId: 'a',
      simulated: false,
      rights: { origin: 'o', license: 'l', redistributable: true },
    },
  };
  assert.equal(PortableManifestSchema.safeParse({ ...base, version: 1, snapshotAssets: [entry] }).success, true);
  const wrongContent = { ...entry, content: `.viscraft/content/${'b'.repeat(64)}` };
  assert.equal(
    PortableManifestSchema.safeParse({ ...base, version: 1, snapshotAssets: [wrongContent] }).success,
    false,
  );
  assert.equal(
    PortableManifestSchema.safeParse({ ...base, version: 1, snapshotAssets: [entry, { ...entry }] }).success,
    false,
  );
  // The logical path must be namespaced to a real Build id and never a runtime or credential path.
  for (const bad of [
    'p/x',
    'media/x.bin',
    '.viscraft/snapshots/media/x.bin',
    '.viscraft/snapshots/build-abc/.viscraft/x.bin',
    '.viscraft/snapshots/build-abc/.VISCRAFT/x.bin',
    '.viscraft/snapshots/build-abc/.env',
    '.viscraft/snapshots/build-abc/.ENV',
    '.viscraft/snapshots/build-abc/OUTPUT/movie.mp4',
  ]) {
    assert.equal(
      PortableManifestSchema.safeParse({ ...base, version: 1, snapshotAssets: [{ ...entry, path: bad }] }).success,
      false,
      `expected ${bad} to be rejected`,
    );
  }
});

test('re-exporting a portable project resolves the frozen asset blob through the existing manifest', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await writeJson(path.join(root, 'project.json'), lineageProject(TAKE_ID));
    const frozenAsset: Asset = {
      id: 'asset-frozen',
      revision: 1,
      path: 'media/a.bin',
      sha256: HEX_ZERO,
      type: 'image',
      rights: REDISTRIBUTABLE,
      simulated: false,
    };
    await makeLineage(root, { frozenAsset });
    const first = path.join(parent, 'first');
    await exportProject(root, first);
    const firstManifest = JSON.parse(await readFile(path.join(first, '.viscraft/portable-manifest.json'), 'utf8'));
    assert.equal(firstManifest.snapshotAssets.length, 1);
    const [blob] = await contentBlobs(first);
    assert.equal(blob, firstManifest.snapshotAssets[0].content);
    const second = path.join(parent, 'second');
    await exportProject(first, second);
    const secondManifest = JSON.parse(await readFile(path.join(second, '.viscraft/portable-manifest.json'), 'utf8'));
    assert.equal(secondManifest.version, 1);
    assert.deepEqual(secondManifest.snapshotAssets, firstManifest.snapshotAssets);
    assert.deepEqual(await contentBlobs(second), [blob]);
    assert.ok(!(await listFiles(second)).includes(`.viscraft/snapshots/${BUILD_ID}/media/a.bin`));
    assert.equal((await loadProject(second)).id, 'portable-lineage');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('re-export rejects a tampered or missing frozen-asset mapping instead of resolving other bytes', async () => {
  const cases: Array<{ name: string; pattern: RegExp; tamper: (manifest: any) => void }> = [
    {
      name: 'a renamed logical path',
      pattern: /missing authored file/,
      tamper: manifest => {
        manifest.snapshotAssets[0].path = `.viscraft/snapshots/${BUILD_ID}/media/wrong.bin`;
      },
    },
    {
      name: 'a wrong mapping hash',
      pattern: /mapping hash does not match/,
      tamper: manifest => {
        const sha = '1'.repeat(64);
        manifest.snapshotAssets[0].sha256 = sha;
        manifest.snapshotAssets[0].content = `.viscraft/content/${sha}`;
      },
    },
    {
      name: 'a wrong mapping provenance',
      pattern: /mapping provenance does not match/,
      tamper: manifest => {
        manifest.snapshotAssets[0].provenance.rights.license = 'other';
      },
    },
  ];
  for (const [index, item] of cases.entries()) {
    const root = await tmp();
    const parent = await tmp();
    try {
      await writeJson(path.join(root, 'project.json'), lineageProject(TAKE_ID));
      const frozenAsset: Asset = {
        id: 'asset-frozen',
        revision: 1,
        path: 'media/a.bin',
        sha256: HEX_ZERO,
        type: 'image',
        rights: REDISTRIBUTABLE,
        simulated: false,
      };
      await makeLineage(root, { frozenAsset });
      const first = path.join(parent, 'first');
      await exportProject(root, first);
      await mutateJson(path.join(first, '.viscraft/portable-manifest.json'), item.tamper);
      await assert.rejects(exportProject(first, path.join(parent, `second-${index}`)), item.pattern, item.name);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(parent, { recursive: true, force: true });
    }
  }
});

test('an extra undeclared snapshot-asset mapping cannot smuggle a file into a re-export', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await writeJson(path.join(root, 'project.json'), lineageProject(TAKE_ID));
    const frozenAsset: Asset = {
      id: 'asset-frozen',
      revision: 1,
      path: 'media/a.bin',
      sha256: HEX_ZERO,
      type: 'image',
      rights: REDISTRIBUTABLE,
      simulated: false,
    };
    await makeLineage(root, { frozenAsset });
    const first = path.join(parent, 'first');
    await exportProject(root, first);
    await mutateJson(path.join(first, '.viscraft/portable-manifest.json'), manifest => {
      const sha = manifest.snapshotAssets[0].sha256;
      manifest.snapshotAssets.push({
        path: `.viscraft/snapshots/${BUILD_ID}/secret.txt`,
        sha256: sha,
        content: `.viscraft/content/${sha}`,
        provenance: manifest.snapshotAssets[0].provenance,
      });
    });
    const second = path.join(parent, 'second');
    await exportProject(first, second);
    const files = await listFiles(second);
    assert.ok(!files.some(file => file.endsWith('secret.txt')), 'the undeclared mapping must not be staged');
    assert.equal((await contentBlobs(second)).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('a frozen asset used by a source as a resource stays a physical snapshot file', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await writeJson(path.join(root, 'project.json'), lineageProject(TAKE_ID));
    const frozenAsset: Asset = {
      id: 'asset-shared',
      revision: 1,
      path: 'media/a.bin',
      sha256: HEX_ZERO,
      type: 'image',
      rights: REDISTRIBUTABLE,
      simulated: false,
    };
    await makeLineage(root, { frozenAsset, frozenResources: ['media/a.bin'] });
    const destination = path.join(parent, 'exported');
    await exportProject(root, destination);
    const manifest = JSON.parse(await readFile(path.join(destination, '.viscraft/portable-manifest.json'), 'utf8'));
    const logical = `.viscraft/snapshots/${BUILD_ID}/media/a.bin`;
    assert.ok((await listFiles(destination)).includes(logical), 'a source-referenced frozen asset stays physical');
    assert.ok(!manifest.snapshotAssets.some((asset: { path: string }) => asset.path === logical));
    const physical = manifest.files.find((file: { path: string }) => file.path === logical);
    assert.equal(physical.provenance.kind, 'asset');
    assert.deepEqual(await contentBlobs(destination), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('a mutable current asset stays an independent physical file and never alters the immutable frozen blob', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    const currentAsset = await writeAsset(root, 'media/a.bin', 'frozen-asset-bytes', 'asset-current', REDISTRIBUTABLE);
    await writeJson(path.join(root, 'project.json'), lineageProject(TAKE_ID, [currentAsset]));
    const frozenAsset: Asset = {
      id: 'asset-frozen',
      revision: 1,
      path: 'media/a.bin',
      sha256: currentAsset.sha256,
      type: 'image',
      rights: REDISTRIBUTABLE,
      simulated: false,
    };
    await makeLineage(root, { frozenAsset });
    const destination = path.join(parent, 'exported');
    await exportProject(root, destination);
    const manifest = JSON.parse(await readFile(path.join(destination, '.viscraft/portable-manifest.json'), 'utf8'));
    const blob = manifest.snapshotAssets[0].content;
    const currentPath = path.join(destination, ...'media/a.bin'.split('/'));
    const blobPath = path.join(destination, ...blob.split('/'));
    assert.notEqual(
      (await stat(currentPath)).ino,
      (await stat(blobPath)).ino,
      'the current copy must not share the blob inode',
    );
    const blobBefore = await readFile(blobPath);
    await writeFile(currentPath, 'mutated-current-bytes');
    assert.deepEqual(
      await readFile(blobPath),
      blobBefore,
      'mutating the current asset must not alter the immutable blob',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

// --- Playable recording dependency integrity ---------------------------------

test('export denies a playable recording that freezes an extra credentials file', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await writeFile(path.join(root, 'game.html'), '<html></html>');
    await mkdir(path.join(root, 'secret'), { recursive: true });
    await writeFile(
      path.join(root, 'secret', 'credentials.json'),
      JSON.stringify({ api_key: 'SUPER-SECRET-KEY-1234567890' }),
    );
    const entrySha = await hashFile(path.join(root, 'game.html'));
    const credSha = await hashFile(path.join(root, 'secret', 'credentials.json'));
    const { rel } = await writeRecording(root, {
      entry: 'game.html',
      resources: [],
      bindings: [],
      params: {},
      seed: 0,
      frames: 1,
      files: [
        { path: 'game.html', sha256: entrySha },
        { path: 'secret/credentials.json', sha256: credSha },
      ],
    });
    await writeJson(path.join(root, 'project.json'), playableProject({ recording: rel }));
    const destination = path.join(parent, 'out');
    await assert.rejects(exportProject(root, destination), /does not freeze exactly/);
    // The rejected export must not have created the destination, so the secret never lands.
    await assert.rejects(readFile(path.join(destination, 'secret', 'credentials.json')), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('export denies a playable recording that omits a resource the source declares', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await writeFile(path.join(root, 'game.html'), '<html></html>');
    await mkdir(path.join(root, 'lib'), { recursive: true });
    await writeFile(path.join(root, 'lib', 'util.js'), 'export const x = 1;');
    const entrySha = await hashFile(path.join(root, 'game.html'));
    const { rel } = await writeRecording(root, {
      entry: 'game.html',
      resources: ['lib/util.js'],
      bindings: [],
      params: {},
      seed: 0,
      frames: 1,
      // The recording declares the resource but its frozen file list omits it.
      files: [{ path: 'game.html', sha256: entrySha }],
    });
    await writeJson(path.join(root, 'project.json'), playableProject({ recording: rel, resources: ['lib/util.js'] }));
    await assert.rejects(exportProject(root, path.join(parent, 'out')), /does not freeze exactly/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('export denies a playable recording whose bound asset is not redistributable', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await writeFile(path.join(root, 'game.html'), '<html></html>');
    await mkdir(path.join(root, 'assets'), { recursive: true });
    await writeFile(path.join(root, 'assets', 'bind.png'), 'image-bytes');
    const entrySha = await hashFile(path.join(root, 'game.html'));
    const assetSha = await hashFile(path.join(root, 'assets', 'bind.png'));
    const { rel } = await writeRecording(root, {
      entry: 'game.html',
      resources: [],
      bindings: ['hero'],
      params: {},
      seed: 0,
      frames: 1,
      files: [
        { path: 'game.html', sha256: entrySha },
        { path: 'assets/bind.png', sha256: assetSha },
      ],
    });
    const asset: Asset = {
      id: 'hero_asset',
      revision: 1,
      path: 'assets/bind.png',
      sha256: assetSha,
      type: 'image',
      rights: { origin: 'stock', license: 'editorial-only', redistributable: false },
      simulated: false,
    };
    await writeJson(
      path.join(root, 'project.json'),
      playableProject({ recording: rel, bindings: ['hero'], assets: [asset], projectBindings: { hero: 'hero_asset' } }),
    );
    await assert.rejects(exportProject(root, path.join(parent, 'out')), /not redistributable/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('export denies a playable source whose binding does not resolve to an asset', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await writeFile(path.join(root, 'game.html'), '<html></html>');
    const entrySha = await hashFile(path.join(root, 'game.html'));
    const { rel } = await writeRecording(root, {
      entry: 'game.html',
      resources: [],
      bindings: ['hero'],
      params: {},
      seed: 0,
      frames: 1,
      files: [{ path: 'game.html', sha256: entrySha }],
    });
    // The source declares binding "hero" but the project has no such binding.
    await writeJson(path.join(root, 'project.json'), playableProject({ recording: rel, bindings: ['hero'] }));
    await assert.rejects(exportProject(root, path.join(parent, 'out')), /Missing binding/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('export denies a playable recording whose frozen signature is stale', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await writeFile(path.join(root, 'game.html'), '<html></html>');
    const entrySha = await hashFile(path.join(root, 'game.html'));
    // The recording was made for params {} but the source now declares params { level: 2 }.
    const { rel } = await writeRecording(root, {
      entry: 'game.html',
      resources: [],
      bindings: [],
      params: {},
      seed: 0,
      frames: 1,
      files: [{ path: 'game.html', sha256: entrySha }],
      key: stableHash({
        entry: 'game.html',
        resources: [],
        bindings: [],
        params: {},
        seed: 0,
        frames: 1,
        output: PLAYABLE_OUTPUT,
      }),
    });
    await writeJson(path.join(root, 'project.json'), playableProject({ recording: rel, params: { level: 2 } }));
    await assert.rejects(exportProject(root, path.join(parent, 'out')), /params do not match/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('export packages a genuine playable recording and reopens it losslessly', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await writeFile(path.join(root, 'game.html'), '<html>game</html>');
    await mkdir(path.join(root, 'lib'), { recursive: true });
    await writeFile(path.join(root, 'lib', 'util.js'), 'export const y = 2;');
    const entrySha = await hashFile(path.join(root, 'game.html'));
    const resourceSha = await hashFile(path.join(root, 'lib', 'util.js'));
    const { rel, recording } = await writeRecording(root, {
      entry: 'game.html',
      resources: ['lib/util.js'],
      bindings: [],
      params: { level: 3 },
      seed: 5,
      frames: 2,
      files: [
        { path: 'game.html', sha256: entrySha },
        { path: 'lib/util.js', sha256: resourceSha },
      ],
    });
    await writeJson(
      path.join(root, 'project.json'),
      playableProject({ recording: rel, resources: ['lib/util.js'], params: { level: 3 }, seed: 5, frames: 2 }),
    );

    const destination = path.join(parent, 'exported');
    const result = await exportProject(root, destination);
    assert.equal(result.simulated, false);
    const files = await listFiles(destination);
    for (const expected of ['project.json', 'game.html', 'lib/util.js', rel, 'recordings/rec-fixture/preview.mp4']) {
      assert.ok(files.includes(expected), `expected ${expected}`);
    }
    const reopened = await loadProject(destination);
    assert.equal(reopened.id, 'portable-playable');
    assert.deepEqual(await loadRecording(destination, rel), recording);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('export packages a playable recording frozen into a snapshot lineage', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await makePlayableLineage(root);
    const destination = path.join(parent, 'exported');
    const result = await exportProject(root, destination);
    assert.equal(result.simulated, true);
    const files = await listFiles(destination);
    for (const expected of [
      'recordings/rec-fixture/session.json',
      'recordings/rec-fixture/preview.mp4',
      `.viscraft/snapshots/${BUILD_ID}/game.html`,
      `.viscraft/snapshots/${BUILD_ID}/recordings/rec-fixture/session.json`,
      `.viscraft/snapshots/${BUILD_ID}/recordings/rec-fixture/preview.mp4`,
    ]) {
      assert.ok(files.includes(expected), `expected ${expected}`);
    }
    const manifest = JSON.parse(await readFile(path.join(destination, '.viscraft', 'portable-manifest.json'), 'utf8'));
    assert.ok(manifest.files.some((f: { path: string }) => f.path === 'recordings/rec-fixture/preview.mp4'));
    // The frozen playable recording, its preview media and the flat snapshot
    // metadata are consumed by other readers (review/score), so they stay
    // physical copies at their frozen paths — never deduplicated.
    for (const physical of [
      `.viscraft/snapshots/${BUILD_ID}/recordings/rec-fixture/session.json`,
      `.viscraft/snapshots/${BUILD_ID}/recordings/rec-fixture/preview.mp4`,
      `.viscraft/snapshots/${BUILD_ID}/game.html`,
      `.viscraft/snapshots/${BUILD_ID}.project.json`,
      `.viscraft/snapshots/${BUILD_ID}.inputs.json`,
    ]) {
      assert.ok(
        manifest.files.some((f: { path: string }) => f.path === physical),
        `expected a physical file entry for ${physical}`,
      );
      assert.ok(
        !manifest.snapshotAssets.some((a: { path: string }) => a.path === physical),
        `must not deduplicate ${physical}`,
      );
    }
    assert.deepEqual(await contentBlobs(destination), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('export denies a frozen playable recording that freezes an extra file', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await makePlayableLineage(root, {
      frozenRecordingFiles: [
        { path: 'game.html', sha256: HEX_ZERO },
        { path: 'secret.txt', sha256: HEX_ZERO },
      ],
    });
    await assert.rejects(exportProject(root, path.join(parent, 'out')), /does not freeze exactly/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('portable media closure excludes historical sibling finals while preserving verbatim producer records', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await writeFile(path.join(root, 'motion.html'), CODE_SCENE);
    await writeJson(path.join(root, 'project.json'), await codeProject(root));
    const original = await buildProject(root);
    const oldFinal = original.artifacts.find(artifact => artifact.id === original.result!.artifact)!;
    const current = await loadProject(root);
    current.composition!.placements = current.composition!.placements.map((placement, index) => {
      const { source: _source, ...edit } = placement;
      return { ...edit, take: original.takes[index].id };
    });
    current.composition!.subtitles = [
      { id: 'new-title', text: 'A new edit', startFrame: 0, endFrame: 4, fontSize: 12, color: '#ffffff' },
    ];
    await saveProject(root, current, current.revision);
    const edited = await buildProject(root);
    const recordPath = `.viscraft/builds/${original.id}.json`;
    const producerBytes = await readFile(path.join(root, recordPath));
    const destination = path.join(parent, 'exported');
    await exportProject(root, destination);
    const manifest = JSON.parse(await readFile(path.join(destination, '.viscraft/portable-manifest.json'), 'utf8'));
    assert.ok(!manifest.artifacts.includes(oldFinal.id), 'unused producer movie is metadata only');
    assert.ok(manifest.artifacts.includes(edited.result!.artifact));
    for (const take of original.takes) assert.ok(manifest.artifacts.includes(take.artifact));
    assert.deepEqual(
      await readFile(path.join(destination, recordPath)),
      producerBytes,
      'producer history must not be rewritten',
    );
    assert.ok((await buildProject(destination)).operations.every(operation => operation.reused));
    await reviewBuild(destination, edited.id);
    await exportProject(destination, path.join(parent, 'second-export'));
    await rm(path.join(destination, edited.artifacts.find(artifact => artifact.id === edited.takes[0].artifact)!.path));
    await assert.rejects(reviewBuild(destination, edited.id), /failed verification/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

// --- Real export → rebuild end-to-end (Browser + FFmpeg) --------------------

/**
 * A minimal, self-contained CodeScene: `window.viscraft.render` paints a solid
 * hue and a moving block, fully determined by params/frame. Two sources differ
 * only by `params.shift`, so editing one params object must re-render exactly
 * that source.
 */
const CODE_SCENE = `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;overflow:hidden;background:#111}canvas{display:block}</style></head>
<body><canvas id="scene"></canvas><script>
window.viscraft = {
  render(ctx) {
    const canvas = document.getElementById('scene');
    canvas.width = ctx.width; canvas.height = ctx.height;
    const g = canvas.getContext('2d');
    const hue = (Number(ctx.params.hue || 0) * 360 + ctx.frame * 12 + Number(ctx.params.shift || 0)) % 360;
    g.fillStyle = 'hsl(' + hue + ',65%,45%)';
    g.fillRect(0, 0, ctx.width, ctx.height);
    g.fillStyle = '#fff';
    g.fillRect(2 + ctx.frame * 8 + Number(ctx.params.shift || 0), 2, 6, 6);
  }
};
</script></body></html>
`;

/** Two code sources sharing one entry, differing only by params. */
async function codeProject(root: string): Promise<Project> {
  const signal = await writeSignalAsset(root, {
    id: 'bed',
    path: 'signal.wav',
    sampleRate: 48000,
    channels: 2,
    samples: 3200,
    frequency: 440,
  });
  return {
    schemaVersion: 1,
    id: 'portable-e2e-code',
    revision: 1,
    title: 'portable e2e code',
    direction: { intent: '', looks: [{ id: 'look', description: '' }], transitions: [] },
    assets: [signal],
    bindings: {},
    sources: [
      {
        id: 'src_a',
        kind: 'browser',
        output: 'picture',
        entry: 'motion.html',
        resources: [],
        bindings: [],
        params: { shift: 0 },
        seed: 1,
        frames: 2,
      },
      {
        id: 'src_b',
        kind: 'browser',
        output: 'picture',
        entry: 'motion.html',
        resources: [],
        bindings: [],
        params: { shift: 60 },
        seed: 2,
        frames: 2,
      },
    ],
    composition: {
      output: { width: 64, height: 64, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene', description: '' }],
      shots: [
        { id: 'shot_a', scene: 'scene', look: 'look', intent: '', targetFrames: 2 },
        { id: 'shot_b', scene: 'scene', look: 'look', intent: '', targetFrames: 2 },
      ],
      placements: [
        { id: 'pl_a', shot: 'shot_a', source: 'src_a', inFrame: 0, outFrame: 2, startFrame: 0, audio: 'mute' },
        { id: 'pl_b', shot: 'shot_b', source: 'src_b', inFrame: 0, outFrame: 2, startFrame: 2, audio: 'mute' },
      ],
      transitions: [],
      audio: [
        {
          id: 'bed',
          kind: 'asset',
          asset: 'bed',
          inSample: 0,
          startSample: 0,
          durationSamples: 3200,
          gain: 0.2,
          fadeInSamples: 200,
          fadeOutSamples: 2600,
        },
      ],
    },
    imageDocuments: [],
    imageTargets: [],
    soundTargets: [],
  } as Project;
}

/** A single simulated source whose accepted take must survive export. */
async function simulatedProject(root: string, attempt: string): Promise<Project> {
  const signal = await writeSignalAsset(root, {
    id: 'bed',
    path: 'signal.wav',
    sampleRate: 48000,
    channels: 2,
    samples: 4800,
    frequency: 330,
  });
  return {
    schemaVersion: 1,
    id: 'portable-e2e-sim',
    revision: 1,
    title: 'portable e2e sim',
    direction: { intent: '', looks: [{ id: 'look', description: '' }], transitions: [] },
    assets: [signal],
    bindings: {},
    sources: [
      {
        id: 'src_sim',
        kind: 'simulated',
        prompt: 'portable e2e deterministic pattern',
        frames: 3,
        seed: 7,
        attempt,
        behavior: 'success',
      },
    ],
    composition: {
      output: { width: 64, height: 64, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene', description: '' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: '', targetFrames: 3 }],
      placements: [
        { id: 'pl', shot: 'shot', source: 'src_sim', inFrame: 0, outFrame: 3, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio: [
        {
          id: 'bed',
          kind: 'asset',
          asset: 'bed',
          inSample: 0,
          startSample: 0,
          durationSamples: 4800,
          gain: 0.2,
          fadeInSamples: 200,
          fadeOutSamples: 4000,
        },
      ],
    },
    imageDocuments: [],
    imageTargets: [],
    soundTargets: [],
  } as Project;
}

const browserAvailable = await findBrowser().then(
  () => true,
  () => false,
);
const ffmpegAvailable = await runCommand('ffmpeg', ['-version']).then(
  () => true,
  () => false,
);
const codeE2eSkip =
  browserAvailable && ffmpegAvailable
    ? false
    : `needs a Chrome/Chromium browser and FFmpeg (browser=${browserAvailable}, ffmpeg=${ffmpegAvailable})`;
const simE2eSkip = ffmpegAvailable ? false : 'needs FFmpeg';

test(
  'exported code project rebuilds with reuse and re-renders only the edited source',
  { skip: codeE2eSkip },
  async () => {
    const root = await tmp();
    const parent = await tmp();
    try {
      const project = path.join(root, 'motion');
      await mkdir(project, { recursive: true });
      await writeJson(path.join(project, 'project.json'), await codeProject(project));
      await writeFile(path.join(project, 'motion.html'), CODE_SCENE);

      const build1 = await buildProject(project);
      assert.equal(build1.status, 'succeeded');
      assert.ok(build1.result, 'the source build must record a result');

      const destination = path.join(parent, 'exported');
      await exportProject(project, destination);
      assert.equal((await loadProject(destination)).id, 'portable-e2e-code');

      // Rebuilding the portable copy reuses every packaged operation/artifact.
      const build2 = await buildProject(destination);
      assert.equal(build2.status, 'succeeded');
      const codeOps2 = build2.operations.filter(operation => operation.kind === 'browser');
      assert.equal(codeOps2.length, 2);
      assert.ok(
        codeOps2.every(operation => operation.reused),
        'the exported copy must reuse both code operations',
      );
      assert.ok(
        build2.operations.every(operation => operation.reused),
        'an unchanged rebuild must reuse every operation',
      );

      // Editing one source re-renders exactly that source, from the portable copy.
      const current = await loadProject(destination);
      const edited = structuredClone(current);
      const source = edited.sources.find(candidate => candidate.id === 'src_b');
      if (!source || source.kind !== 'browser' || source.output !== 'picture')
        throw new Error('expected code source src_b');
      source.params = { ...source.params, shift: 90 };
      await saveProject(destination, edited, current.revision);

      const build3 = await buildProject(destination);
      const codeOps3 = build3.operations.filter(operation => operation.kind === 'browser');
      assert.equal(codeOps3.length, 2);
      assert.equal(codeOps3.filter(operation => !operation.reused).length, 1, 'exactly one source re-renders');
      assert.equal(codeOps3.filter(operation => operation.reused).length, 1, 'the untouched source is reused');
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(parent, { recursive: true, force: true });
    }
  },
);

test('exported simulated build reuses the packaged take without a new job', { skip: simE2eSkip }, async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    const project = path.join(root, 'sim');
    await mkdir(project, { recursive: true });
    await writeJson(path.join(project, 'project.json'), await simulatedProject(project, 'portable_att'));

    const build1 = await buildProject(project);
    assert.equal(build1.status, 'succeeded');
    assert.equal(build1.result!.simulated, true);
    assert.equal((await simulatedStatus(project)).length, 1, 'the first build submits one simulated job');

    const destination = path.join(parent, 'exported');
    await exportProject(project, destination);

    // Simulated provider job state carries request identity and is not packaged.
    assert.equal((await simulatedStatus(destination)).length, 0, 'job state must not be packaged');

    const build2 = await buildProject(destination);
    assert.equal(build2.status, 'succeeded');
    assert.ok(
      build2.operations.every(operation => operation.reused),
      'the exported build reuses every operation',
    );
    assert.equal((await simulatedStatus(destination)).length, 0, 'a reused simulated take must not submit a new job');
    const finalArtifact = build2.artifacts.find(artifact => artifact.id === build2.result!.artifact)!;
    assert.equal(finalArtifact.simulated, true, 'reused simulated provenance is preserved');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

/** A simulated source plus a large approved Asset, so every Build freezes the same big bytes. */
async function simAssetProject(root: string, attempt: string, asset: Asset): Promise<Project> {
  const signal = await writeSignalAsset(root, {
    id: 'sim_signal',
    path: 'signal.wav',
    sampleRate: 48000,
    channels: 2,
    samples: 4800,
    frequency: 330,
  });
  return {
    schemaVersion: 1,
    id: 'portable-e2e-sim-asset',
    revision: 1,
    title: 'portable e2e sim asset',
    direction: { intent: '', looks: [{ id: 'look', description: '' }], transitions: [] },
    assets: [asset, signal],
    bindings: {},
    sources: [
      {
        id: 'src_sim',
        kind: 'simulated',
        prompt: 'portable e2e deterministic pattern',
        frames: 3,
        seed: 7,
        attempt,
        behavior: 'success',
      },
    ],
    composition: {
      output: { width: 64, height: 64, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene', description: '' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: '', targetFrames: 3 }],
      placements: [
        { id: 'pl', shot: 'shot', source: 'src_sim', inFrame: 0, outFrame: 3, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio: [
        {
          id: 'bed',
          kind: 'asset',
          asset: 'sim_signal',
          inSample: 0,
          startSample: 0,
          durationSamples: 4800,
          gain: 0.2,
          fadeInSamples: 200,
          fadeOutSamples: 4000,
        },
      ],
    },
    imageDocuments: [],
    imageTargets: [],
    soundTargets: [],
  } as Project;
}

test(
  'the portable format deduplicates a large frozen asset across real Builds and survives re-export, reuse and review',
  { skip: simE2eSkip },
  async () => {
    const root = await tmp();
    const parent = await tmp();
    try {
      const project = path.join(root, 'sim');
      await mkdir(project, { recursive: true });
      const bytes = payload(512 * 1024, 7);
      const asset = await writeAsset(project, 'media/large.bin', bytes, 'asset-large', REDISTRIBUTABLE, 'image');
      await writeJson(path.join(project, 'project.json'), await simAssetProject(project, 'att_one', asset));

      const build1 = await buildProject(project);
      assert.equal(build1.status, 'succeeded');
      const p2 = structuredClone(await loadProject(project));
      const source2 = p2.sources.find(source => source.id === 'src_sim');
      if (!source2 || source2.kind !== 'simulated') throw new Error('expected the simulated source');
      source2.attempt = 'att_two';
      await saveProject(project, p2, p2.revision);
      const build2 = await buildProject(project);
      assert.equal(build2.status, 'succeeded');
      assert.notEqual(build1.takes[0].id, build2.takes[0].id);

      // A third Build selects BOTH Produced Takes so all three Builds are packaged.
      const p3 = structuredClone(await loadProject(project));
      p3.composition!.shots = [
        { id: 'shot_a', scene: 'scene', look: 'look', intent: '', targetFrames: 3 },
        { id: 'shot_b', scene: 'scene', look: 'look', intent: '', targetFrames: 3 },
      ];
      p3.composition!.placements = [
        { id: 'pl_a', shot: 'shot_a', take: build1.takes[0].id, inFrame: 0, outFrame: 3, startFrame: 0, audio: 'mute' },
        { id: 'pl_b', shot: 'shot_b', take: build2.takes[0].id, inFrame: 0, outFrame: 3, startFrame: 3, audio: 'mute' },
      ];
      await saveProject(project, p3, p3.revision);
      const build3 = await buildProject(project);
      assert.equal(build3.status, 'succeeded');

      const snapshotHistory = async (): Promise<Array<[string, Buffer, Buffer]>> =>
        Promise.all(
          [build1, build2, build3].map(
            async build =>
              [
                build.id,
                await readFile(path.join(project, '.viscraft', 'builds', `${build.id}.json`)),
                await readFile(path.join(project, '.viscraft', 'snapshots', `${build.id}.inputs.json`)),
              ] as [string, Buffer, Buffer],
          ),
        );
      const historyBefore = await snapshotHistory();

      const destination = path.join(parent, 'exported');
      await exportProject(project, destination);

      const manifest = JSON.parse(await readFile(path.join(destination, '.viscraft/portable-manifest.json'), 'utf8'));
      assert.equal(manifest.version, 1);
      const currentProject = await loadProject(project);
      const signalAsset = currentProject.assets.find(candidate => candidate.id === 'sim_signal')!;
      const signalSize = (await stat(path.join(project, signalAsset.path))).size;
      const frozenEntries = manifest.snapshotAssets as Array<{
        sha256: string;
        content: string;
        provenance: { assetId: string };
      }>;
      const largeEntries = frozenEntries.filter(entry => entry.provenance.assetId === 'asset-large');
      const signalEntries = frozenEntries.filter(entry => entry.provenance.assetId === 'sim_signal');
      assert.equal(largeEntries.length, 3, 'each Build keeps its own logical reference to the large Asset');
      assert.equal(signalEntries.length, 3, 'each Build keeps its own logical reference to the signal Asset');
      assert.equal(
        new Set(largeEntries.map(entry => entry.sha256)).size,
        1,
        'all three Builds share the large Asset digest',
      );
      assert.equal(
        new Set(largeEntries.map(entry => entry.content)).size,
        1,
        'the large Asset keeps one physical identity across the three Builds',
      );
      assert.equal(
        new Set(signalEntries.map(entry => entry.sha256)).size,
        1,
        'all three Builds share the signal Asset digest',
      );
      assert.equal(
        new Set(frozenEntries.map(entry => entry.sha256)).size,
        2,
        'the large Asset and the authored signal are two distinct real digests',
      );
      const blobs = await contentBlobs(destination);
      assert.equal(blobs.length, 2, 'one physical blob per distinct frozen digest');
      const blobSizes = await Promise.all(
        blobs.map(async blob => (await stat(path.join(destination, ...blob.split('/')))).size),
      );
      assert.equal(
        blobSizes.filter(size => size === bytes.length).length,
        1,
        'the large Asset blob keeps its original byte size',
      );
      assert.equal(
        blobSizes.filter(size => size === signalSize).length,
        1,
        'the signal Asset blob is its own real WAV bytes',
      );
      const files = await listFiles(destination);
      for (const build of [build1, build2, build3]) {
        assert.ok(
          !files.includes(`.viscraft/snapshots/${build.id}/media/large.bin`),
          'the shared blob replaces each physical frozen copy',
        );
        assert.ok(
          !files.includes(`.viscraft/snapshots/${build.id}/signal.wav`),
          'the signal Asset is also served from its content blob, not a physical snapshot copy',
        );
      }
      assert.deepEqual(
        await snapshotHistory(),
        historyBefore,
        'export must not rewrite Build history or frozen inputs',
      );
      // The current asset copies and the blobs are independent physical files.
      assert.ok(files.includes('media/large.bin'));
      assert.ok(files.includes('signal.wav'));

      // Re-exporting the v1 export resolves the shared blob through its own mapping.
      const second = path.join(parent, 'second');
      await exportProject(destination, second);
      const secondManifest = JSON.parse(await readFile(path.join(second, '.viscraft/portable-manifest.json'), 'utf8'));
      const secondEntries = secondManifest.snapshotAssets as Array<{ sha256: string; provenance: { assetId: string } }>;
      assert.equal(
        secondEntries.filter(entry => entry.provenance.assetId === 'asset-large').length,
        3,
        'the re-export keeps one large-Asset reference per Build',
      );
      assert.equal(
        secondEntries.filter(entry => entry.provenance.assetId === 'sim_signal').length,
        3,
        'the re-export keeps one signal-Asset reference per Build',
      );
      assert.equal(new Set(secondEntries.map(entry => entry.sha256)).size, 2, 'the re-export keeps both real digests');
      assert.equal((await contentBlobs(second)).length, 2, 'the re-export keeps one blob per digest');

      const rebuilt = await buildProject(destination);
      assert.equal(rebuilt.status, 'succeeded');
      assert.ok(
        rebuilt.operations.every(operation => operation.reused),
        'the exported project must reuse every packaged operation',
      );
      await reviewBuild(destination, build3.id);

      const largeBlob = blobs[blobSizes.findIndex(size => size === bytes.length)];
      assert.ok(largeBlob, 'the large Asset has its own physical blob');
      const blobPath = path.join(destination, ...largeBlob.split('/'));
      const blobBefore = await readFile(blobPath);
      await writeFile(path.join(destination, ...asset.path.split('/')), 'edited-current-asset');
      assert.deepEqual(
        await readFile(blobPath),
        blobBefore,
        'editing the current asset must never reach the immutable frozen blob',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(parent, { recursive: true, force: true });
    }
  },
);
