/**
 * H3 portable scope contract: carried provider originals + the persisted `scope`.
 *
 * These tests use tiny hand-authored lineage fixtures (no browser, no provider,
 * no ffmpeg): a Build/Artifact/snapshot lineage whose generated Artifact records
 * an original hash, plus a real file under `.viscraft/provider-media/`. They prove
 * that a default export carries the required original with a hash-verified
 * `original` relation, that a missing/corrupt original fails loudly (and is never
 * substituted with the normalized copy) unless the restricted scope records the
 * gap, that a host-imported Asset never invents a missing original, that the
 * remaining rights gate follows the existing allowNonRedistributable opt-in, and
 * that the persisted `scope` object honestly distinguishes its five facts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { exportProject, verifyPortableExport } from '../src/operations/delivery/portable.js';
import { PortableManifestSchema } from '../src/operations/delivery/portable-contract.js';
import { archiveProject, restoreProject } from '../src/operations/delivery/archive.js';
import { validateProject } from '../src/project/project.js';
import { hashFile, stableHash } from '../src/shared/hash.js';
import type { Asset, Project } from '../src/core/schema.js';

const HEX = (c: string): string => c.repeat(64);
const BUILD_ID = `build-${'b'.repeat(36)}`;
const ARTIFACT_ID = `artifact-${'c'.repeat(40)}`;
const TAKE_ID = `take-${'d'.repeat(40)}`;
const ARTIFACT_REL = `.viscraft/artifacts/${ARTIFACT_ID}.mp4`;
const ORIGINAL_REL = '.viscraft/provider-media/fal-motion.one.mp4';
const REDISTRIBUTABLE = { origin: 'test', license: 'CC0-1.0', redistributable: true } as const;

async function tmp(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'viscraft-portable-scope-'));
}
async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
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

function baseProject(overrides: Partial<Project> = {}): Project {
  const source = {
    id: 'src',
    kind: 'browser' as const,
    output: 'picture' as const,
    entry: 'scene.html',
    resources: [],
    bindings: [],
    params: {},
    seed: 0,
    frames: 1,
  };
  return {
    schemaVersion: 1,
    id: 'portable-scope',
    revision: 1,
    title: 'Portable Scope',
    direction: { intent: '', looks: [{ id: 'look', description: '' }], transitions: [] },
    assets: [],
    bindings: {},
    sources: [source],
    composition: {
      output: { width: 32, height: 32, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene', description: '' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: '', targetFrames: 2 }],
      placements: [{ id: 'edit', shot: 'shot', take: TAKE_ID, inFrame: 0, outFrame: 2, startFrame: 0, audio: 'mute' }],
      transitions: [],
      audio: [],
    },
    ...overrides,
  } as Project;
}

/**
 * Self-consistent Build/Artifact/snapshot lineage whose generated Artifact records
 * a provider original. `original` writes (or omits) the real provider-media file;

 */
async function makeProviderLineage(
  root: string,
  options: { original?: Buffer } = {},
): Promise<{ originalSha: string | null }> {
  const source = {
    id: 'src_code',
    kind: 'browser' as const,
    output: 'picture' as const,
    entry: 'scene.html',
    resources: [],
    bindings: [],
    params: {},
    seed: 0,
    frames: 1,
  };
  const frozen = {
    ...baseProject(),
    sources: [source],
    composition: {
      output: { width: 32, height: 32, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene', description: '' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: '', targetFrames: 2 }],
      placements: [
        { id: 'edit', shot: 'shot', take: TAKE_ID, inFrame: 0, outFrame: 2, startFrame: 0, audio: 'mute' as const },
      ],
      transitions: [],
      audio: [],
    },
  } as Project;
  const frozenParsed = validateProject(frozen);

  const snapshotDir = path.join(root, '.viscraft', 'snapshots', BUILD_ID);
  await mkdir(snapshotDir, { recursive: true });
  const entryFile = path.join(snapshotDir, 'scene.html');
  await writeFile(entryFile, '<html>frozen</html>');
  const files: Record<string, string> = { 'scene.html': await hashFile(entryFile) };
  const computedHash = stableHash({ project: frozenParsed, files, unavailable: [] });
  await writeJson(path.join(root, '.viscraft', 'snapshots', `${BUILD_ID}.project.json`), frozen);
  await writeJson(path.join(root, '.viscraft', 'snapshots', `${BUILD_ID}.inputs.json`), {
    files,
    unavailable: [],
  });

  // A real provider original, deliberately DIFFERENT bytes from the normalized copy.
  let originalSha: string | null = null;
  if (options.original) {
    const originalFile = path.join(root, ...ORIGINAL_REL.split('/'));
    await mkdir(path.dirname(originalFile), { recursive: true });
    await writeFile(originalFile, options.original);
    originalSha = await hashFile(originalFile);
  }

  const artifactFile = path.join(root, ...ARTIFACT_REL.split('/'));
  await mkdir(path.dirname(artifactFile), { recursive: true });
  await writeFile(artifactFile, 'normalized-mp4-bytes');
  const actualSha = await hashFile(artifactFile);
  const artifact = {
    id: ARTIFACT_ID,
    path: ARTIFACT_REL,
    sha256: actualSha,
    kind: 'video',
    simulated: true,
    operation: 'provider',
    inputs: ['f'.repeat(64)],
    backend: 'fal/test-only',
    media: {
      frames: 2,
      fps: { numerator: 30, denominator: 1 },
      width: 32,
      height: 32,
      duration: 2 / 30,
      videoCodec: 'h264',
    },
    generation: {
      provider: 'fal' as const,
      model: 'alibaba/wan-3.0/image-to-video',
      taskId: 'task-one',
      requestHash: HEX('a'),
      // When no original was written the recorded hash deliberately matches nothing
      // on disk (a "missing" original, used by the reduced-scope test).
      originalSha256: originalSha ?? HEX('0'),
    },
  };
  const take = {
    medium: 'picture',
    id: TAKE_ID,
    artifact: ARTIFACT_ID,
    source: 'src_code',
    sourceKey: 'f'.repeat(64),
    frames: 2,
    fps: { numerator: 30, denominator: 1 },
    simulated: true,
  };
  const build = {
    schemaVersion: 1,
    id: BUILD_ID,
    run: { id: `run-${'a'.repeat(36)}`, goal: 'scope' },
    plan: { operations: ['op-' + 'e'.repeat(32)] },
    revision: 1,
    snapshotHash: computedHash,
    medium: 'picture',
    environment: { runtime: 'test' },
    status: 'succeeded',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    operations: [
      {
        id: 'op-' + 'e'.repeat(32),
        kind: 'provider',
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
  await writeFile(path.join(root, 'scene.html'), '<html>current</html>');
  await writeJson(path.join(root, 'project.json'), baseProject());
  return { originalSha };
}

/** A project whose only Asset is a registered generated image (imageGeneration). */
async function makeImageProject(root: string, rights: Asset['rights']): Promise<{ bytes: Buffer }> {
  const bytes = Buffer.from('provider-image-bytes');
  const assetFile = path.join(root, 'assets', 'gen.png');
  await mkdir(path.dirname(assetFile), { recursive: true });
  await writeFile(assetFile, bytes);
  const sha = await hashFile(assetFile);
  const asset: Asset = {
    id: 'gen',
    revision: 1,
    path: 'assets/gen.png',
    sha256: sha,
    type: 'image',
    rights,
    simulated: true,
    imageGeneration: {
      provider: 'vllm-omni-image',
      model: 'test-image',
      operation: 'generate',
      promptHash: HEX('b'),
      requestHash: HEX('c'),
      inputSha256: [],
      references: [],
      outputSha256: sha,
      simulated: true,
    },
  };
  await writeFile(path.join(root, 'scene.html'), '<html></html>');
  await writeJson(
    path.join(root, 'project.json'),
    baseProject({
      assets: [asset],
      composition: {
        output: { width: 32, height: 32, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 },
        scenes: [{ id: 'scene', description: '' }],
        shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: '', targetFrames: 1 }],
        placements: [
          { id: 'edit', shot: 'shot', source: 'src', inFrame: 0, outFrame: 1, startFrame: 0, audio: 'mute' },
        ],
        transitions: [],
        audio: [],
      },
    }),
  );
  // The provider original is the SAME bytes as the registered Asset (generate-image).
  const originalFile = path.join(root, '.viscraft', 'provider-media', 'image-api-gen.1.png');
  await mkdir(path.dirname(originalFile), { recursive: true });
  await writeFile(originalFile, bytes);
  return { bytes };
}

/**
 * A project with TWO generated Assets that record the SAME provider original hash
 * (both results came from the identical provider bytes). The one real original
 * file must be carried ONCE while both owner relations are recorded.
 */
async function makeSharedOriginalProject(root: string): Promise<{ bytes: Buffer; sha: string }> {
  const bytes = Buffer.from('one-original-two-results');
  await mkdir(path.join(root, 'assets'), { recursive: true });
  await writeFile(path.join(root, 'assets', 'a.png'), bytes);
  await writeFile(path.join(root, 'assets', 'b.png'), bytes);
  const sha = await hashFile(path.join(root, 'assets', 'a.png'));
  const makeAsset = (id: string, rel: string): Asset => ({
    id,
    revision: 1,
    path: rel,
    sha256: sha,
    type: 'image',
    rights: REDISTRIBUTABLE,
    simulated: true,
    imageGeneration: {
      provider: 'vllm-omni-image',
      model: 'test-image',
      operation: 'generate',
      promptHash: HEX('b'),
      requestHash: HEX('c'),
      inputSha256: [],
      references: [],
      outputSha256: sha,
      simulated: true,
    },
  });
  await writeFile(path.join(root, 'scene.html'), '<html></html>');
  await writeJson(
    path.join(root, 'project.json'),
    baseProject({
      assets: [makeAsset('A', 'assets/a.png'), makeAsset('B', 'assets/b.png')],
      composition: {
        output: { width: 32, height: 32, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 },
        scenes: [{ id: 'scene', description: '' }],
        shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: '', targetFrames: 1 }],
        placements: [
          { id: 'edit', shot: 'shot', source: 'src', inFrame: 0, outFrame: 1, startFrame: 0, audio: 'mute' },
        ],
        transitions: [],
        audio: [],
      },
    }),
  );
  const originalFile = path.join(root, '.viscraft', 'provider-media', 'image-api-shared.1.png');
  await mkdir(path.dirname(originalFile), { recursive: true });
  await writeFile(originalFile, bytes);
  return { bytes, sha };
}

const manifestOf = async (destination: string): Promise<Record<string, any>> =>
  JSON.parse(await readFile(path.join(destination, '.viscraft', 'portable-manifest.json'), 'utf8'));

const EXTRA_BUILD_ID = `build-${'g'.repeat(36)}`;
const EXTRA_ARTIFACT_ID = `artifact-${'h'.repeat(40)}`;
const EXTRA_TAKE_ID = `take-${'i'.repeat(40)}`;
const EXTRA_ARTIFACT_REL = `.viscraft/artifacts/${EXTRA_ARTIFACT_ID}.mp4`;

/**
 * A SECOND, independent succeeded Build outside the active closure: its own
 * frozen snapshot, one declared video Artifact (no provider original, so it adds
 * no required-original burden) and one Take. `retained` marks the keep flag so
 * a `'retained'` selection can find it; `status` lets a test make it non-succeeded.
 */
async function makeExtraBuild(
  root: string,
  options: {
    retained?: boolean;
    status?: 'succeeded' | 'failed';
    simulatedAsset?: boolean;
    /** Artifact ids this version's declared Artifact consumes (recursive edge). */
    artifactInputs?: string[];
    /** A frozen Asset whose `frame` derivation parent is another Build (recursive edge). */
    frameParent?: { build: string; artifact: string; sha256: string; frame: number };
  } = {},
): Promise<void> {
  const source = {
    id: 'src_extra',
    kind: 'browser' as const,
    output: 'picture' as const,
    entry: 'extra.html',
    resources: [],
    bindings: [],
    params: {},
    seed: 0,
    frames: 1,
  };
  const snapshotDir = path.join(root, '.viscraft', 'snapshots', EXTRA_BUILD_ID);
  await mkdir(snapshotDir, { recursive: true });
  const entryFile = path.join(snapshotDir, 'extra.html');
  await writeFile(entryFile, '<html>extra frozen</html>');
  const files: Record<string, string> = { 'extra.html': await hashFile(entryFile) };

  // Optionally, a SIMULATED image Asset that exists ONLY inside this carried
  // version's frozen snapshot: the current project never references it, so only
  // the carried-entry aggregate can see that the package is simulated.
  const assets: Asset[] = [];
  if (options.simulatedAsset) {
    const assetFile = path.join(snapshotDir, 'sim.png');
    await writeFile(assetFile, 'simulated-image-bytes');
    files['sim.png'] = await hashFile(assetFile);
    assets.push({
      id: 'asset-sim',
      revision: 1,
      path: 'sim.png',
      sha256: files['sim.png'],
      type: 'image',
      rights: { origin: 'simulated fixture', license: 'CC0-1.0', redistributable: true },
      simulated: true,
    } as Asset);
  }
  if (options.frameParent) {
    const frameFile = path.join(snapshotDir, 'frame.png');
    await writeFile(frameFile, 'promoted-frame-bytes');
    files['frame.png'] = await hashFile(frameFile);
    assets.push({
      id: 'asset-frame',
      revision: 1,
      path: 'frame.png',
      sha256: files['frame.png'],
      type: 'image',
      rights: REDISTRIBUTABLE,
      simulated: false,
      derivedFrom: {
        kind: 'frame',
        build: options.frameParent.build,
        artifact: options.frameParent.artifact,
        sha256: options.frameParent.sha256,
        frame: options.frameParent.frame,
      },
    } as Asset);
  }

  const frozen = {
    ...baseProject(),
    assets,
    sources: [source],
    composition: {
      output: { width: 32, height: 32, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene', description: '' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: '', targetFrames: 2 }],
      placements: [
        {
          id: 'edit',
          shot: 'shot',
          take: EXTRA_TAKE_ID,
          inFrame: 0,
          outFrame: 2,
          startFrame: 0,
          audio: 'mute' as const,
        },
      ],
      transitions: [],
      audio: [],
    },
  } as Project;
  const frozenParsed = validateProject(frozen);
  const computedHash = stableHash({ project: frozenParsed, files, unavailable: [] });
  await writeJson(path.join(root, '.viscraft', 'snapshots', `${EXTRA_BUILD_ID}.project.json`), frozen);
  await writeJson(path.join(root, '.viscraft', 'snapshots', `${EXTRA_BUILD_ID}.inputs.json`), {
    files,
    unavailable: [],
  });
  const artifactFile = path.join(root, ...EXTRA_ARTIFACT_REL.split('/'));
  await mkdir(path.dirname(artifactFile), { recursive: true });
  await writeFile(artifactFile, 'extra-version-artifact-bytes');
  const actualSha = await hashFile(artifactFile);
  const artifact = {
    id: EXTRA_ARTIFACT_ID,
    path: EXTRA_ARTIFACT_REL,
    sha256: actualSha,
    kind: 'video',
    simulated: false,
    operation: 'scene',
    inputs: options.artifactInputs ?? [],
    backend: 'scene/test-only',
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
    medium: 'picture',
    id: EXTRA_TAKE_ID,
    artifact: EXTRA_ARTIFACT_ID,
    source: 'src_extra',
    sourceKey: 'g'.repeat(64),
    frames: 2,
    fps: { numerator: 30, denominator: 1 },
    simulated: false,
  };
  const build = {
    schemaVersion: 1,
    id: EXTRA_BUILD_ID,
    run: { id: `run-${'g'.repeat(36)}`, goal: 'extra' },
    plan: { operations: ['op-' + 'g'.repeat(32)] },
    revision: 2,
    snapshotHash: computedHash,
    medium: 'picture',
    environment: { runtime: 'test' },
    status: options.status ?? 'succeeded',
    startedAt: '2026-01-02T00:00:00.000Z',
    finishedAt: '2026-01-02T00:00:01.000Z',
    operations: [
      {
        id: 'op-' + 'g'.repeat(32),
        kind: 'scene',
        key: 'g'.repeat(64),
        inputs: [],
        artifact: EXTRA_ARTIFACT_ID,
        reused: false,
      },
    ],
    artifacts: [artifact],
    takes: [take],
    result: { artifact: EXTRA_ARTIFACT_ID, simulated: false },
    ...(options.retained ? { retained: { at: '2026-01-02T00:00:02.000Z' } } : {}),
  };
  await writeJson(path.join(root, '.viscraft', 'builds', `${EXTRA_BUILD_ID}.json`), build);
}

const PARENT_BUILD_ID = `build-${'p'.repeat(36)}`;
const PARENT_ARTIFACT_ID = `artifact-${'q'.repeat(40)}`;
const PARENT_ARTIFACT_REL = `.viscraft/artifacts/${PARENT_ARTIFACT_ID}.mp4`;

/**
 * A succeeded Build outside the active closure with one declared video Artifact
 * (media frames = 2) and an empty frozen project — the target of a recursive
 * `frame`/Artifact-input edge from an explicitly carried version. `status` lets a
 * test make it non-succeeded so a dangling edge is proven to be refused.
 */
async function makeParentBuild(
  root: string,
  options: { status?: 'succeeded' | 'failed' } = {},
): Promise<{ artifactSha: string }> {
  const source = {
    id: 'src_parent',
    kind: 'browser' as const,
    output: 'picture' as const,
    entry: 'parent.html',
    resources: [],
    bindings: [],
    params: {},
    seed: 0,
    frames: 1,
  };
  const snapshotDir = path.join(root, '.viscraft', 'snapshots', PARENT_BUILD_ID);
  await mkdir(snapshotDir, { recursive: true });
  const entryFile = path.join(snapshotDir, 'parent.html');
  await writeFile(entryFile, '<html>parent frozen</html>');
  const files: Record<string, string> = { 'parent.html': await hashFile(entryFile) };
  const frozen = { ...baseProject(), sources: [source] } as Project;
  const frozenParsed = validateProject(frozen);
  const computedHash = stableHash({ project: frozenParsed, files, unavailable: [] });
  await writeJson(path.join(root, '.viscraft', 'snapshots', `${PARENT_BUILD_ID}.project.json`), frozen);
  await writeJson(path.join(root, '.viscraft', 'snapshots', `${PARENT_BUILD_ID}.inputs.json`), {
    files,
    unavailable: [],
  });
  const artifactFile = path.join(root, ...PARENT_ARTIFACT_REL.split('/'));
  await mkdir(path.dirname(artifactFile), { recursive: true });
  await writeFile(artifactFile, 'parent-video-bytes');
  const actualSha = await hashFile(artifactFile);
  const artifact = {
    id: PARENT_ARTIFACT_ID,
    path: PARENT_ARTIFACT_REL,
    sha256: actualSha,
    kind: 'video',
    simulated: false,
    operation: 'normalize-media',
    inputs: [],
    backend: 'ffmpeg',
    media: {
      frames: 2,
      fps: { numerator: 30, denominator: 1 },
      width: 32,
      height: 32,
      duration: 2 / 30,
      videoCodec: 'h264',
    },
  };
  const build = {
    schemaVersion: 1,
    id: PARENT_BUILD_ID,
    run: { id: `run-${'p'.repeat(36)}`, goal: 'parent' },
    plan: { operations: ['op-' + 'p'.repeat(32)] },
    revision: 1,
    snapshotHash: computedHash,
    medium: 'picture',
    environment: { runtime: 'test' },
    status: options.status ?? 'succeeded',
    startedAt: '2026-01-03T00:00:00.000Z',
    finishedAt: '2026-01-03T00:00:01.000Z',
    operations: [
      {
        id: 'op-' + 'p'.repeat(32),
        kind: 'normalize-media',
        key: 'p'.repeat(64),
        inputs: [],
        artifact: PARENT_ARTIFACT_ID,
        reused: false,
      },
    ],
    artifacts: [artifact],
    takes: [],
  };
  await writeJson(path.join(root, '.viscraft', 'builds', `${PARENT_BUILD_ID}.json`), build);
  return { artifactSha: actualSha };
}

test('default export carries the required provider original with a hashed original relation', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    const original = Buffer.from('raw-provider-pixels-1234');
    const { originalSha } = await makeProviderLineage(root, { original });
    const destination = path.join(parent, 'exported');
    const result = await exportProject(root, destination);
    assert.equal(result.originals, 1);
    assert.equal(result.scope.counts.originals, 1);
    assert.equal(result.scope.requested, 'default');
    assert.equal(result.scope.includeOriginals, true);
    assert.equal(result.scope.originalsComplete, true);
    assert.deepEqual(result.scope.missing, []);

    const files = await listFiles(destination);
    assert.ok(files.includes(ORIGINAL_REL), 'the provider original must be carried under .viscraft/provider-media/');
    assert.equal(await hashFile(path.join(destination, ...ORIGINAL_REL.split('/'))), originalSha);
    // The normalized production copy is a distinct physical file too.
    assert.ok(files.includes(ARTIFACT_REL));
    assert.notEqual(
      await hashFile(path.join(destination, ...ORIGINAL_REL.split('/'))),
      await hashFile(path.join(destination, ...ARTIFACT_REL.split('/'))),
    );
    // No job/remote state ever rides along.
    assert.ok(!files.some(file => file.startsWith('.viscraft/jobs/')));
    assert.ok(!files.some(file => file.startsWith('.viscraft/remote/')));

    const manifest = await manifestOf(destination);
    const entry = manifest.files.find((file: { path: string }) => file.path === ORIGINAL_REL);
    assert.ok(entry, 'the original must be listed in the manifest');
    assert.equal(entry.provenance.kind, 'original');
    assert.equal(entry.provenance.sha256, originalSha);
    assert.deepEqual(entry.provenance.owners, [{ kind: 'artifact', id: ARTIFACT_ID }]);
    assert.equal(entry.sha256, originalSha);
    assert.equal(manifest.scope.counts.files, manifest.files.length);
    assert.equal(manifest.scope.counts.originals, 1);
    // Re-export is stable: the same scope and the same carried original.
    const second = path.join(parent, 'second');
    const again = await exportProject(destination, second);
    assert.equal(again.originals, 1);
    assert.deepEqual((await manifestOf(second)).scope, manifest.scope);
    assert.ok((await listFiles(second)).includes(ORIGINAL_REL));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('a missing required original fails loudly by default and is never substituted with the normalized copy', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    const { originalSha } = await makeProviderLineage(root, { original: Buffer.from('present') });
    assert.ok(originalSha);
    // Remove the retained original, leaving only the normalized artifact.
    await rm(path.join(root, ...ORIGINAL_REL.split('/')));
    await assert.rejects(
      exportProject(root, path.join(parent, 'out')),
      error =>
        error instanceof Error &&
        error.message.includes(ARTIFACT_ID) &&
        error.message.includes(originalSha!) &&
        /not found under \.viscraft\/provider-media\//.test(error.message),
      'the default scope must name the artifact and the missing hash',
    );
    // Nothing was created by the refused export.
    await assert.rejects(readdir(path.join(parent, 'out')));

    // The explicit restricted scope records the gap instead of failing.
    const destination = path.join(parent, 'restricted');
    const result = await exportProject(root, destination, { allowMissingOriginals: true });
    assert.equal(result.originals, 0);
    assert.equal(result.scope.requested, 'allow-missing-originals');
    assert.equal(result.scope.originalsComplete, false);
    assert.equal(result.scope.missing.length, 1);
    assert.equal(result.scope.missing[0].id, ARTIFACT_ID);
    assert.equal(result.scope.missing[0].kind, 'artifact');
    assert.equal(result.scope.missing[0].sha256, originalSha);
    const files = await listFiles(destination);
    assert.ok(!files.some(file => file.startsWith('.viscraft/provider-media/')), 'no substituted original');
    assert.ok(files.includes(ARTIFACT_REL), 'the normalized copy is still carried');
    assert.equal((await manifestOf(destination)).scope.missing.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('a corrupt original (wrong bytes at the recorded hash) is treated as missing, not silently accepted', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await makeProviderLineage(root, { original: Buffer.from('the-real-original') });
    // Overwrite the retained file so its bytes no longer match the recorded hash.
    await writeFile(path.join(root, ...ORIGINAL_REL.split('/')), 'tampered-bytes');
    await assert.rejects(exportProject(root, path.join(parent, 'out')), /not found under \.viscraft\/provider-media\//);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('a host-imported Asset with no provider original does not invent a missing original', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await writeFile(path.join(root, 'scene.html'), '<html></html>');
    await mkdir(path.join(root, 'assets'), { recursive: true });
    await writeFile(path.join(root, 'assets', 'photo.png'), 'plain-imported-bytes');
    const asset: Asset = {
      id: 'photo',
      revision: 1,
      path: 'assets/photo.png',
      sha256: await hashFile(path.join(root, 'assets', 'photo.png')),
      type: 'image',
      rights: REDISTRIBUTABLE,
      simulated: false,
    };
    await writeJson(
      path.join(root, 'project.json'),
      baseProject({
        assets: [asset],
        composition: {
          output: { width: 32, height: 32, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 },
          scenes: [{ id: 'scene', description: '' }],
          shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: '', targetFrames: 1 }],
          placements: [
            { id: 'edit', shot: 'shot', source: 'src', inFrame: 0, outFrame: 1, startFrame: 0, audio: 'mute' },
          ],
          transitions: [],
          audio: [],
        },
      }),
    );
    const destination = path.join(parent, 'exported');
    const result = await exportProject(root, destination);
    assert.equal(result.originals, 0);
    assert.deepEqual(result.scope.missing, []);
    assert.equal(result.scope.originalsComplete, true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('includeOriginals:false carries no originals, never fails on a missing one, and records the reduced scope', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await makeProviderLineage(root, {}); // no original on disk at all
    const destination = path.join(parent, 'watch-scope');
    const result = await exportProject(root, destination, { includeOriginals: false });
    assert.equal(result.scope.includeOriginals, false);
    assert.equal(result.scope.originalsComplete, false);
    assert.deepEqual(result.scope.missing, []);
    assert.equal(result.originals, 0);
    assert.ok(!(await listFiles(destination)).some(file => file.startsWith('.viscraft/provider-media/')));
    assert.ok(result.scope.excluded.some(entry => entry.class === 'provider-originals'));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('a generated image whose Asset and original share bytes records the original relation and Asset rights', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    const { bytes } = await makeImageProject(root, REDISTRIBUTABLE);
    const destination = path.join(parent, 'exported');
    const result = await exportProject(root, destination);
    assert.equal(result.originals, 1);
    const manifest = await manifestOf(destination);
    const entry = manifest.files.find(
      (file: { path: string }) => file.path === '.viscraft/provider-media/image-api-gen.1.png',
    );
    assert.ok(entry, 'the generate-image original must be carried');
    assert.equal(entry.provenance.kind, 'original');
    assert.deepEqual(entry.provenance.owners, [{ kind: 'asset', id: 'gen' }]);
    assert.equal(entry.provenance.sha256, await hashFile(path.join(root, 'assets/gen.png')));
    assert.equal(entry.provenance.rights.redistributable, true);
    // The original bytes equal the registered Asset bytes but stay a distinct file.
    assert.deepEqual(await readFile(path.join(destination, ...entry.path.split('/'))), bytes);
    assert.ok((await listFiles(destination)).includes('assets/gen.png'));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('two generated results sharing one original carry the file once and record every owner relation', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    const { bytes, sha } = await makeSharedOriginalProject(root);
    const destination = path.join(parent, 'exported');
    const result = await exportProject(root, destination);
    // Count the shared original once per physical file, not once per owner.
    assert.equal(result.originals, 1);
    assert.equal(result.scope.counts.originals, 1);

    const files = await listFiles(destination);
    const carried = files.filter(file => file.startsWith('.viscraft/provider-media/'));
    assert.equal(carried.length, 1, 'the shared original is a single physical file');
    assert.equal(await hashFile(path.join(destination, ...carried[0]!.split('/'))), sha);
    assert.deepEqual(await readFile(path.join(destination, ...carried[0]!.split('/'))), bytes);

    const manifest = await manifestOf(destination);
    const originals = manifest.files.filter(
      (file: { provenance: { kind: string } }) => file.provenance.kind === 'original',
    );
    assert.equal(originals.length, 1, 'exactly one original carrier is listed');
    assert.equal(
      manifest.scope.counts.originals,
      originals.length,
      'the recorded count describes the real carrier count',
    );
    assert.deepEqual(
      [...originals[0].provenance.owners].sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)),
      [
        { kind: 'asset', id: 'A' },
        { kind: 'asset', id: 'B' },
      ],
      'every owner relation is recorded on the one carrier',
    );
    // The manifest validates against its OWN schema and passes member verification.
    assert.equal(PortableManifestSchema.safeParse(manifest).success, true, 'the manifest must self-validate');
    await verifyPortableExport(destination);

    // The package re-exports from itself without a count mismatch.
    const again = path.join(parent, 'again');
    await exportProject(destination, again);
    assert.equal((await manifestOf(again)).scope.counts.originals, 1);
    await verifyPortableExport(again);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('a non-redistributable generated Asset follows the existing strict refusal and the allowNonRedistributable opt-in', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await makeImageProject(root, { origin: 'stock', license: 'editorial-only', redistributable: false });
    await assert.rejects(exportProject(root, path.join(parent, 'strict')), /not redistributable/);
    const destination = path.join(parent, 'private');
    const result = await exportProject(root, destination, { allowNonRedistributable: true });
    assert.equal(result.originals, 1);
    const manifest = await manifestOf(destination);
    const entry = manifest.files.find((file: { path: string }) => file.path.endsWith('image-api-gen.1.png'));
    assert.equal(entry.provenance.rights.redistributable, false);
    assert.ok(
      manifest.scope.receiver.cannot.some((line: string) => /redistribute/.test(line)),
      'the receiver scope must state the private bytes cannot be redistributed',
    );
    assert.ok(manifest.scope.excluded.every((item: { class: string; reason: string }) => item.reason.length > 0));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('an archive validates against the RECORDED scope: a restricted package restores without being called corrupt', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await makeProviderLineage(root, { original: Buffer.from('gone-soon') });
    await rm(path.join(root, ...ORIGINAL_REL.split('/')));
    // The default archive scope refuses the missing required original...
    await assert.rejects(
      archiveProject(root, path.join(parent, 'strict.viscraft-archive')),
      /not found under \.viscraft\/provider-media\//,
    );
    // ...while the explicit restricted scope records the gap and restores against it.
    const archive = path.join(parent, 'restricted.viscraft-archive');
    const archived = await archiveProject(root, archive, { allowMissingOriginals: true });
    assert.equal(archived.simulated, true);
    const restored = path.join(parent, 'restored');
    await restoreProject(archive, restored);
    const manifest = await manifestOf(restored);
    assert.equal(manifest.scope.requested, 'allow-missing-originals');
    assert.equal(manifest.scope.originalsComplete, false);
    assert.equal(manifest.scope.missing.length, 1);
    assert.ok(!(await listFiles(restored)).some(file => file.startsWith('.viscraft/provider-media/')));
    assert.ok((await listFiles(restored)).includes(ARTIFACT_REL), 'the normalized artifact still round-trips');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('scope distinguishes its five facts and the manifest schema enforces the scope/ counts invariants', () => {
  const scope = {
    requested: 'default',
    includeOriginals: true,
    requestedVersions: [],
    counts: { files: 0, builds: 0, artifacts: 0, originals: 0 },
    excluded: [],
    missing: [],
    receiver: { can: [], cannot: [] },
    environment: 'x',
    closureComplete: true,
    rebuildable: true,
    originalsComplete: true,
    authoredScope: 'complete',
    authorComplete: true,
    selectedProductionComplete: true,
    wholeAuthorRestorable: true,
    authoredGaps: [],
    historyComplete: true,
    taskRecoverable: true,
  };
  const manifest = {
    format: 'viscraft-portable-project',
    version: 1,
    schemaVersion: 1,
    project: { id: 'p', revision: 1, title: 't' },
    exportedAt: 'x',
    simulated: false,
    builds: [],
    artifacts: [],
    files: [],
    snapshotAssets: [],
    scope,
    notes: [],
  };
  assert.equal(PortableManifestSchema.safeParse(manifest).success, true, 'a complete scope is accepted');
  // A manifest missing the scope is refused (single current format).
  const withoutScope: Record<string, unknown> = { ...manifest };
  delete withoutScope.scope;
  assert.equal(PortableManifestSchema.safeParse(withoutScope).success, false);
  // Counts must describe the actual manifest.
  assert.equal(
    PortableManifestSchema.safeParse({ ...manifest, scope: { ...scope, counts: { ...scope.counts, files: 3 } } })
      .success,
    false,
  );
  // A missing-required gap is only legal under the restricted scope.
  const missing = {
    ...scope,
    originalsComplete: false,
    missing: [{ kind: 'artifact', id: 'a', sha256: HEX('a'), reason: 'gone' }],
  };
  assert.equal(PortableManifestSchema.safeParse({ ...manifest, scope: missing }).success, false);
  assert.equal(
    PortableManifestSchema.safeParse({ ...manifest, scope: { ...missing, requested: 'allow-missing-originals' } })
      .success,
    true,
  );
  // originalsComplete must be consistent with includeOriginals + missing.
  assert.equal(
    PortableManifestSchema.safeParse({ ...manifest, scope: { ...scope, includeOriginals: false } }).success,
    false,
  );
  // A requested additional version must actually be carried as a Build.
  const requested = { ...scope, requestedVersions: [`build-${'g'.repeat(36)}`] };
  assert.equal(PortableManifestSchema.safeParse({ ...manifest, scope: requested }).success, false);
  assert.equal(
    PortableManifestSchema.safeParse({
      ...manifest,
      builds: [`build-${'g'.repeat(36)}`],
      scope: { ...requested, counts: { ...scope.counts, builds: 1 } },
    }).success,
    true,
  );
  // counts.originals must equal the carried original files:
  // two owners of one shared original must never be counted as two originals.
  const originalFile = {
    path: '.viscraft/provider-media/shared.bin',
    sha256: HEX('a'),
    bytes: 1,
    provenance: { kind: 'original', sha256: HEX('a'), owners: [{ kind: 'asset', id: 'a' }] },
  };
  const withOriginal = (originals: number): unknown => ({
    ...manifest,
    files: [originalFile],
    scope: { ...scope, counts: { files: 1, builds: 0, artifacts: 0, originals } },
  });
  assert.equal(PortableManifestSchema.safeParse(withOriginal(2)).success, false);
  assert.equal(PortableManifestSchema.safeParse(withOriginal(1)).success, true);
  // A carried Asset that is ITSELF simulated forces the package flag true, so a
  // version-only simulated Asset can never hide behind `simulated: false`.
  const simulatedEntry = {
    path: 'assets/sim.png',
    sha256: HEX('a'),
    bytes: 1,
    provenance: { kind: 'asset', assetId: 'a', simulated: true, rights: REDISTRIBUTABLE },
  };
  const withSimulated = (simulated: boolean): unknown => ({
    ...manifest,
    simulated,
    files: [simulatedEntry],
    scope: { ...scope, counts: { ...scope.counts, files: 1 } },
  });
  assert.equal(PortableManifestSchema.safeParse(withSimulated(false)).success, false);
  assert.equal(PortableManifestSchema.safeParse(withSimulated(true)).success, true);
});

test('an explicitly requested extra version is carried by stable id with its record, snapshot and hashed artifact bytes', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await makeProviderLineage(root, { original: Buffer.from('raw-provider-pixels') });
    await makeExtraBuild(root);
    const destination = path.join(parent, 'exported');
    const result = await exportProject(root, destination, { extraVersions: [EXTRA_BUILD_ID] });
    assert.deepEqual(result.scope.requestedVersions, [EXTRA_BUILD_ID]);
    assert.equal(result.scope.counts.builds, 2);

    const manifest = await manifestOf(destination);
    assert.ok(manifest.builds.includes(BUILD_ID));
    assert.ok(manifest.builds.includes(EXTRA_BUILD_ID));
    assert.ok(manifest.artifacts.includes(EXTRA_ARTIFACT_ID));
    assert.equal(manifest.scope.counts.builds, manifest.builds.length);
    assert.equal(manifest.scope.counts.artifacts, manifest.artifacts.length);
    assert.deepEqual(manifest.scope.requestedVersions, [EXTRA_BUILD_ID]);

    const files = await listFiles(destination);
    for (const relative of [
      `.viscraft/builds/${EXTRA_BUILD_ID}.json`,
      `.viscraft/snapshots/${EXTRA_BUILD_ID}.project.json`,
      `.viscraft/snapshots/${EXTRA_BUILD_ID}.inputs.json`,
      `.viscraft/snapshots/${EXTRA_BUILD_ID}/extra.html`,
      EXTRA_ARTIFACT_REL,
    ])
      assert.ok(files.includes(relative), `expected carried ${relative}`);

    // The carried artifact bytes are hash-verified against the recorded digest.
    const entry = manifest.files.find((file: { path: string }) => file.path === EXTRA_ARTIFACT_REL);
    assert.ok(entry, 'the extra version artifact must be listed in the manifest');
    assert.equal(entry.provenance.artifactId, EXTRA_ARTIFACT_ID);
    assert.equal(entry.sha256, await hashFile(path.join(root, ...EXTRA_ARTIFACT_REL.split('/'))));
    assert.equal(await hashFile(path.join(destination, ...EXTRA_ARTIFACT_REL.split('/'))), entry.sha256);

    // Member-level verification passes, and the extra version can be re-exported.
    await verifyPortableExport(destination);
    const again = path.join(parent, 'again');
    await exportProject(destination, again, { extraVersions: [EXTRA_BUILD_ID] });
    assert.deepEqual((await manifestOf(again)).scope.requestedVersions, [EXTRA_BUILD_ID]);
    await verifyPortableExport(again);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('a simulated Asset that exists only inside a carried extra version taints the whole package', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await makeProviderLineage(root, { original: Buffer.from('raw-provider-pixels') });
    await makeExtraBuild(root, { simulatedAsset: true });
    const destination = path.join(parent, 'exported');
    const result = await exportProject(root, destination, { extraVersions: [EXTRA_BUILD_ID] });
    assert.equal(result.simulated, true, 'the package-level flag must aggregate carried entries');

    const manifest = await manifestOf(destination);
    assert.equal(manifest.simulated, true, 'the manifest reports the package as simulated');
    const carried = manifest.snapshotAssets.find(
      (asset: { provenance: { assetId: string } }) => asset.provenance.assetId === 'asset-sim',
    );
    assert.ok(carried, 'the simulated frozen Asset is carried');
    assert.equal(carried.provenance.simulated, true, 'its own provenance stays simulated');
    assert.equal(manifest.project.simulated ?? false, false);

    await verifyPortableExport(destination);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('a default export carries no extra version and records an empty requestedVersions', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await makeProviderLineage(root, { original: Buffer.from('raw-provider-pixels') });
    await makeExtraBuild(root);
    const destination = path.join(parent, 'exported');
    const result = await exportProject(root, destination);
    assert.deepEqual(result.scope.requestedVersions, []);
    const manifest = await manifestOf(destination);
    assert.equal(manifest.scope.counts.builds, 1);
    assert.ok(!manifest.builds.includes(EXTRA_BUILD_ID));
    assert.ok(!(await listFiles(destination)).includes(EXTRA_ARTIFACT_REL));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test("'retained' carries every retained Build by stable id", async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await makeProviderLineage(root, { original: Buffer.from('raw-provider-pixels') });
    await makeExtraBuild(root, { retained: true });
    const destination = path.join(parent, 'exported');
    const result = await exportProject(root, destination, { extraVersions: ['retained'] });
    assert.deepEqual(result.scope.requestedVersions, [EXTRA_BUILD_ID]);
    const manifest = await manifestOf(destination);
    assert.ok(manifest.builds.includes(EXTRA_BUILD_ID));
    assert.ok((await listFiles(destination)).includes(EXTRA_ARTIFACT_REL));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('an unknown, checkpoint or non-succeeded extra version is refused loudly and writes nothing', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await makeProviderLineage(root, { original: Buffer.from('raw-provider-pixels') });
    const unknown = path.join(parent, 'unknown');
    await assert.rejects(
      exportProject(root, unknown, { extraVersions: [`build-${'z'.repeat(36)}`] }),
      /no Build record with that id exists/,
    );
    await assert.rejects(readdir(unknown), 'a refused unknown id must create nothing');

    // A checkpoint id is refused with a distinct, honest message (not "unknown").
    await mkdir(path.join(root, '.viscraft', 'checkpoints'), { recursive: true });
    await writeFile(path.join(root, '.viscraft', 'checkpoints', 'checkpoint-one.json'), '{}\n');
    const checkpoint = path.join(parent, 'checkpoint');
    await assert.rejects(
      exportProject(root, checkpoint, { extraVersions: ['checkpoint-one'] }),
      /checkpoints cannot be exported as accepted versions/,
    );
    await assert.rejects(readdir(checkpoint));

    // A non-succeeded Build cannot be carried as an accepted version.
    await makeExtraBuild(root, { status: 'failed' });
    const failed = path.join(parent, 'failed');
    await assert.rejects(exportProject(root, failed, { extraVersions: [EXTRA_BUILD_ID] }), /Build status is failed/);
    await assert.rejects(readdir(failed));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('an archive carries the requested extra version and restore keeps the recorded scope', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await makeProviderLineage(root, { original: Buffer.from('raw-provider-pixels') });
    await makeExtraBuild(root);
    const archive = path.join(parent, 'extra.viscraft-archive');
    // `archiveProject`'s internal semantic validation re-exports with the recorded
    // requestedVersions, so a self-inconsistent scope would fail here.
    await archiveProject(root, archive, { extraVersions: [EXTRA_BUILD_ID] });
    const restored = path.join(parent, 'restored');
    await restoreProject(archive, restored);
    const manifest = await manifestOf(restored);
    assert.deepEqual(manifest.scope.requestedVersions, [EXTRA_BUILD_ID]);
    assert.ok(manifest.builds.includes(EXTRA_BUILD_ID));
    const files = await listFiles(restored);
    assert.ok(files.includes(`.viscraft/builds/${EXTRA_BUILD_ID}.json`));
    assert.ok(files.includes(EXTRA_ARTIFACT_REL));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('a carried extra version pulls its frozen frame-derivation parent Build and Artifact', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await makeProviderLineage(root, { original: Buffer.from('raw-provider-pixels') });
    const parentBuild = await makeParentBuild(root);
    await makeExtraBuild(root, {
      frameParent: { build: PARENT_BUILD_ID, artifact: PARENT_ARTIFACT_ID, sha256: parentBuild.artifactSha, frame: 0 },
    });
    const destination = path.join(parent, 'exported');
    const result = await exportProject(root, destination, { extraVersions: [EXTRA_BUILD_ID] });
    assert.deepEqual(result.scope.requestedVersions, [EXTRA_BUILD_ID]);
    const manifest = await manifestOf(destination);
    assert.ok(manifest.builds.includes(EXTRA_BUILD_ID));
    assert.ok(manifest.builds.includes(PARENT_BUILD_ID), 'the frame-derivation parent Build must be carried');
    const files = await listFiles(destination);
    assert.ok(files.includes(PARENT_ARTIFACT_REL), 'the frame-derivation parent Artifact must be carried');
    assert.ok(files.includes(`.viscraft/snapshots/${PARENT_BUILD_ID}.project.json`));
    assert.equal(await hashFile(path.join(destination, ...PARENT_ARTIFACT_REL.split('/'))), parentBuild.artifactSha);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('a carried extra version pulls a Build referenced only through its Artifact inputs', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await makeProviderLineage(root, { original: Buffer.from('raw-provider-pixels') });
    await makeParentBuild(root);
    await makeExtraBuild(root, { artifactInputs: [PARENT_ARTIFACT_ID] });
    const destination = path.join(parent, 'exported');
    const result = await exportProject(root, destination, { extraVersions: [EXTRA_BUILD_ID] });
    assert.deepEqual(result.scope.requestedVersions, [EXTRA_BUILD_ID]);
    const manifest = await manifestOf(destination);
    assert.ok(manifest.builds.includes(PARENT_BUILD_ID), 'the Artifact-input producer Build must be carried');
    assert.ok(manifest.artifacts.includes(PARENT_ARTIFACT_ID), 'the consumed Artifact must be carried');
    assert.ok((await listFiles(destination)).includes(PARENT_ARTIFACT_REL));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('a duplicated selection is deduplicated and a parent reached by two edges is carried once', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await makeProviderLineage(root, { original: Buffer.from('raw-provider-pixels') });
    const parentBuild = await makeParentBuild(root);
    // Both a frame-derivation edge and an Artifact-input edge point at the SAME
    // parent Build/Artifact; the selection id is also repeated.
    await makeExtraBuild(root, {
      artifactInputs: [PARENT_ARTIFACT_ID],
      frameParent: { build: PARENT_BUILD_ID, artifact: PARENT_ARTIFACT_ID, sha256: parentBuild.artifactSha, frame: 0 },
    });
    const destination = path.join(parent, 'exported');
    const result = await exportProject(root, destination, { extraVersions: [EXTRA_BUILD_ID, EXTRA_BUILD_ID] });
    assert.deepEqual(result.scope.requestedVersions, [EXTRA_BUILD_ID], 'a repeated selection is recorded once');
    const manifest = await manifestOf(destination);
    assert.equal(
      manifest.builds.filter((id: string) => id === PARENT_BUILD_ID).length,
      1,
      'the shared parent is carried exactly once',
    );
    assert.equal(
      manifest.artifacts.filter((id: string) => id === PARENT_ARTIFACT_ID).length,
      1,
      'the shared parent Artifact is carried exactly once',
    );
    assert.equal(manifest.scope.counts.builds, manifest.builds.length);
    assert.equal(manifest.scope.counts.artifacts, manifest.artifacts.length);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('a carried version with a dangling or wrong frame-derivation parent is refused loudly', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await makeProviderLineage(root, { original: Buffer.from('raw-provider-pixels') });

    // The parent Build does not exist at all.
    await makeExtraBuild(root, {
      frameParent: {
        build: `build-${'x'.repeat(36)}`,
        artifact: `artifact-${'y'.repeat(40)}`,
        sha256: HEX('a'),
        frame: 0,
      },
    });
    const missing = path.join(parent, 'missing');
    await assert.rejects(
      exportProject(root, missing, { extraVersions: [EXTRA_BUILD_ID] }),
      /invalid parent Artifact provenance/,
    );
    await assert.rejects(readdir(missing), 'a refused export must create nothing');

    // The parent exists but is non-succeeded.
    await makeParentBuild(root, { status: 'failed' });
    await makeExtraBuild(root, {
      frameParent: { build: PARENT_BUILD_ID, artifact: PARENT_ARTIFACT_ID, sha256: HEX('a'), frame: 0 },
    });
    await assert.rejects(
      exportProject(root, path.join(parent, 'failed'), { extraVersions: [EXTRA_BUILD_ID] }),
      /invalid parent Artifact provenance/,
    );

    // The parent is succeeded but the frame index is past the real medium.
    const good = await makeParentBuild(root);
    await makeExtraBuild(root, {
      frameParent: { build: PARENT_BUILD_ID, artifact: PARENT_ARTIFACT_ID, sha256: good.artifactSha, frame: 99 },
    });
    await assert.rejects(
      exportProject(root, path.join(parent, 'frame'), { extraVersions: [EXTRA_BUILD_ID] }),
      /invalid parent frame provenance/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});
