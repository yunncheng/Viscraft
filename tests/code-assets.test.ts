/**
 * The explicit current-bytes refresh for a registered `code` Asset.
 *
 * `refreshCodeAsset` / `viscraft refresh-code` is the ONE way an author records
 * edits made directly to an adopted code file. These tests pin the contract:
 *
 *  - a real change advances EVERY current `code` Asset at that authored path
 *    (same-path twins included) by exactly one revision, while rights,
 *    `simulated`, type, project identity, the authored bytes themselves and a
 *    child's frozen `inputs` stay exactly as they were;
 *  - identical bytes are a no-op (no Asset revision, no `project.json` bytes);
 *  - a wrong Asset type, a missing Asset or a stale Project revision is refused
 *    without touching the authored file or `project.json`;
 *  - a real Build's snapshots, Build record and active result keep their bytes;
 *  - the CLI prints the actual current hash/revision and performs no Build,
 *    render or provider work.
 *
 * The real-Build history assertion is deliberately end-to-end at the unit
 * level: it reads records written by `buildProject`, not a hand-authored
 * stand-in for a frozen snapshot.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildProject } from '../src/build/build.js';
import type { Asset } from '../src/core/schema.js';
import { authorProject, type AuthorProject } from '../src/project/author.js';
import { refreshCodeAsset } from '../src/project/code-assets.js';
import { loadProject, validateProject } from '../src/project/project.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

const CODE_RIGHTS = { origin: 'refresh test: first registration', license: 'CC-BY-4.0', redistributable: true };
const TWIN_RIGHTS = { origin: 'refresh test: same-path twin', license: 'CC0-1.0', redistributable: true };
const STILL_RIGHTS = { origin: 'refresh test: still image', license: 'CC0-1.0', redistributable: true } as const;

interface Fixture {
  root: string;
  stillBytes: Buffer;
  sceneSha: string;
  childSha: string;
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function baseProject(assets: AuthorProject['assets'] = []): AuthorProject {
  return {
    schemaVersion: 1,
    id: 'code-refresh',
    revision: 1,
    title: 'Code refresh',
    soundTargets: [],
    direction: { intent: 'unit fixture', looks: [{ id: 'look', description: 'One look' }], transitions: [] },
    assets,
    bindings: {},
    sources: [],
    imageDocuments: [],
    imageTargets: [],
    composition: {
      output: { width: 32, height: 32, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [],
      shots: [],
      placements: [],
      transitions: [],
      audio: [],
    },
  };
}

function codeAsset(id: string, path: string, extra: Record<string, unknown> = {}): AuthorProject['assets'][number] {
  return { id, path, type: 'code', rights: CODE_RIGHTS, simulated: false, ...extra } as AuthorProject['assets'][number];
}

function imageAsset(id: string, path: string): AuthorProject['assets'][number] {
  return {
    id,
    path,
    type: 'image',
    rights: STILL_RIGHTS,
    simulated: false,
  } as AuthorProject['assets'][number];
}

/**
 * A Project with two CURRENT `code` registrations of the SAME authored file, a
 * derived child that froze the first registration, and an unrelated `image`
 * Asset. Bytes and identities are derived by the real authoring boundary.
 */
async function authorFixture(parent: string): Promise<Fixture> {
  const root = join(parent, 'project');
  const sceneBytes = 'export const TITLE = "first cut";\n';
  const childBytes = '// derived from the first cut\n';
  const stillBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
  const project = baseProject([
    codeAsset('scene_source', 'src/scene.mjs', { rights: CODE_RIGHTS, simulated: true }),
    codeAsset('scene_twin', 'src/scene.mjs', { rights: TWIN_RIGHTS }),
    codeAsset('derived', 'src/derived.mjs', {
      simulated: true,
      inputs: [{ asset: 'scene_source', revision: 1, sha256: sha256(sceneBytes), role: 'source' }],
    }),
    imageAsset('still', 'assets/still.png'),
  ]);
  await authorProject(root, {
    project,
    files: [
      { path: 'src/scene.mjs', bytes: sceneBytes },
      { path: 'src/derived.mjs', bytes: childBytes },
      { path: 'assets/still.png', bytes: stillBytes },
    ],
  });
  return {
    root,
    stillBytes,
    sceneSha: sha256(sceneBytes),
    childSha: sha256(childBytes),
  };
}

async function tempParent(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `viscraft-${name}-`));
}

// ---------------------------------------------------------------------------
// A real edit advances every current registration; everything else is frozen
// ---------------------------------------------------------------------------

test('refreshCodeAsset advances same-path code twins and preserves rights, child pins and authored bytes', async () => {
  const parent = await tempParent('code-refresh-advance');
  try {
    const fixture = await authorFixture(parent);
    const edited = 'export const TITLE = "second cut";\n';
    await writeFile(join(fixture.root, 'src/scene.mjs'), edited);

    const refreshed = await refreshCodeAsset(fixture.root, { assetId: 'scene_source', expectedRevision: 1 });
    assert.equal(refreshed.id, 'scene_source');
    assert.equal(refreshed.sha256, sha256(edited), 'the returned Asset names the bytes that are really on disk');
    assert.equal(refreshed.revision, 2);

    const project = await loadProject(fixture.root);
    assert.deepEqual(validateProject(project), project);
    assert.equal(project.revision, 2, 'the Project commit advanced exactly once');
    const byId = (id: string): Asset => project.assets.find(asset => asset.id === id)!;

    const source = byId('scene_source');
    assert.equal(source.sha256, sha256(edited));
    assert.equal(source.revision, 2);
    assert.deepEqual(source.rights, CODE_RIGHTS, 'rights are not rewritten');
    assert.equal(source.simulated, true, 'the existing simulated marker is preserved');
    assert.deepEqual(source, refreshed, 'the returned Asset is the committed Asset');

    const twin = byId('scene_twin');
    assert.equal(twin.sha256, sha256(edited), 'the twin at the same authored path is advanced too');
    assert.equal(twin.revision, 2);
    assert.deepEqual(twin.rights, TWIN_RIGHTS, 'each registration keeps its own rights');
    assert.equal(twin.simulated, false);

    const derived = byId('derived');
    assert.equal(derived.sha256, fixture.childSha);
    assert.equal(derived.revision, 1, 'the child is not re-registered');
    assert.deepEqual(
      derived.inputs,
      [{ asset: 'scene_source', revision: 1, sha256: fixture.sceneSha, role: 'source' }],
      'a frozen parent identity is never silently rebound',
    );

    const still = byId('still');
    assert.equal(still.sha256, sha256(fixture.stillBytes));
    assert.equal(still.revision, 1, 'a non-code Asset is untouched');

    assert.equal(
      await readFile(join(fixture.root, 'src/scene.mjs'), 'utf8'),
      edited,
      'refresh records bytes; it never writes the authored file',
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Identical bytes are a no-op
// ---------------------------------------------------------------------------

test('refreshCodeAsset leaves the Project and Asset revisions untouched when the bytes are unchanged', async () => {
  const parent = await tempParent('code-refresh-noop');
  try {
    const fixture = await authorFixture(parent);
    const projectJson = join(fixture.root, 'project.json');
    const beforeJson = await readFile(projectJson, 'utf8');

    const refreshed = await refreshCodeAsset(fixture.root, { assetId: 'scene_source', expectedRevision: 1 });
    assert.equal(refreshed.sha256, fixture.sceneSha);
    assert.equal(refreshed.revision, 1, 'same bytes do not advance the Asset');

    assert.equal(await readFile(projectJson, 'utf8'), beforeJson, 'no-op writes no project.json bytes');
    const project = await loadProject(fixture.root);
    assert.equal(project.revision, 1, 'same bytes do not advance the Project');
    assert.equal(project.assets.find(asset => asset.id === 'scene_twin')!.revision, 1);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Refusals leave the authored file and the Project exactly as they were
// ---------------------------------------------------------------------------

test('refreshCodeAsset rejects wrong type, a missing Asset and a stale revision without writing anything', async () => {
  const parent = await tempParent('code-refresh-refuse');
  try {
    const fixture = await authorFixture(parent);
    const edited = 'export const TITLE = "edited but not yet registered";\n';
    await writeFile(join(fixture.root, 'src/scene.mjs'), edited);
    const projectJson = join(fixture.root, 'project.json');
    const beforeJson = await readFile(projectJson, 'utf8');

    await assert.rejects(
      () => refreshCodeAsset(fixture.root, { assetId: 'still', expectedRevision: 1 }),
      /only a code Asset can be refreshed/,
      'an image Asset is not a code registration',
    );
    await assert.rejects(
      () => refreshCodeAsset(fixture.root, { assetId: 'absent', expectedRevision: 1 }),
      /does not exist/,
    );
    await assert.rejects(
      () => refreshCodeAsset(fixture.root, { assetId: 'scene_source', expectedRevision: 2 }),
      /Source revision conflict: expected 2, found 1/,
      'a caller that read an older revision must re-read instead of overwriting',
    );

    assert.equal(
      await readFile(join(fixture.root, 'src/scene.mjs'), 'utf8'),
      edited,
      'no refusal rewrites the author file',
    );
    assert.equal(await readFile(projectJson, 'utf8'), beforeJson, 'no refusal commits a Project');
    assert.equal((await loadProject(fixture.root)).revision, 1);
    assert.deepEqual(
      (await readdir(fixture.root)).filter(name => name.endsWith('.tmp')),
      [],
      'no temporary project.json is left behind',
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// A real Build's frozen history keeps its bytes
// ---------------------------------------------------------------------------

test('refreshCodeAsset leaves an actual Build snapshot, record and active result byte-for-byte intact', async () => {
  const parent = await tempParent('code-refresh-history');
  const root = join(parent, 'project');
  try {
    const sceneBytes = 'export const MARK = "before build";\n';
    const project = baseProject([codeAsset('scene_source', 'src/scene.mjs')]);
    project.sources = [
      {
        id: 'sim',
        kind: 'simulated',
        prompt: 'refresh history control chain',
        frames: 2,
        seed: 0,
        attempt: 'attempt_refresh_history',
        behavior: 'success',
      },
    ];
    const composition = project.composition!;
    composition.scenes = [{ id: 'scene', description: 'one scene' }];
    composition.shots = [{ id: 'shot', scene: 'scene', look: 'look', intent: 'one shot', targetFrames: 2 }];
    composition.placements = [
      { id: 'place', shot: 'shot', source: 'sim', inFrame: 0, outFrame: 2, startFrame: 0, audio: 'mute' },
    ];
    await authorProject(root, { project, files: [{ path: 'src/scene.mjs', bytes: sceneBytes }] });

    const build = await buildProject(root);
    assert.equal(build.status, 'succeeded', `the control-chain Build must succeed: ${build.error ?? ''}`);

    const snapshot = join(root, '.viscraft', 'snapshots', `${build.id}.project.json`);
    const inputs = join(root, '.viscraft', 'snapshots', `${build.id}.inputs.json`);
    const record = join(root, '.viscraft', 'builds', `${build.id}.json`);
    const result = join(root, '.viscraft', 'result.json');
    for (const file of [snapshot, inputs, record, result])
      assert.equal(existsSync(file), true, `${file} must exist after a real Build`);

    const frozenProject = validateProject(JSON.parse(await readFile(snapshot, 'utf8')));
    const frozenAsset = frozenProject.assets.find(asset => asset.id === 'scene_source')!;
    assert.equal(frozenAsset.sha256, sha256(sceneBytes), 'the snapshot really froze the pre-edit identity');
    assert.equal(frozenAsset.revision, 1);

    const history = new Map<string, Buffer>();
    for (const file of [snapshot, inputs, record, result]) history.set(file, await readFile(file));

    const edited = 'export const MARK = "after build";\n';
    await writeFile(join(root, 'src/scene.mjs'), edited);
    const refreshed = await refreshCodeAsset(root, { assetId: 'scene_source', expectedRevision: 1 });
    assert.equal(refreshed.revision, 2);
    assert.equal(refreshed.sha256, sha256(edited));

    for (const [file, bytes] of history)
      assert.deepEqual(await readFile(file), bytes, `history file ${file} must keep its exact bytes`);

    const current = await loadProject(root);
    assert.equal(current.revision, 2);
    assert.equal(current.assets.find(asset => asset.id === 'scene_source')!.sha256, sha256(edited));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The CLI is a thin, factual operation with no Build/render/provider work
// ---------------------------------------------------------------------------

test('viscraft refresh-code prints the actual new hash/revision and runs no Build, render or provider', async () => {
  const parent = await tempParent('code-refresh-cli');
  try {
    const fixture = await authorFixture(parent);
    const edited = 'export const TITLE = "recorded by the CLI";\n';
    await writeFile(join(fixture.root, 'src/scene.mjs'), edited);

    const run = spawnSync(process.execPath, [CLI, 'refresh-code', fixture.root, 'scene_source'], {
      encoding: 'utf8',
      cwd: parent,
      timeout: 120_000,
    });
    assert.equal(run.status, 0, `refresh-code must succeed:\n${run.stderr}${run.stdout}`);

    const printed = JSON.parse(run.stdout) as { asset: string; path: string; sha256: string; revision: number };
    assert.deepEqual(printed, {
      asset: 'scene_source',
      path: 'src/scene.mjs',
      sha256: sha256(edited),
      revision: 2,
    });

    const project = await loadProject(fixture.root);
    assert.equal(project.revision, 2);
    assert.equal(project.assets.find(asset => asset.id === 'scene_source')!.sha256, sha256(edited));
    assert.equal(project.assets.find(asset => asset.id === 'scene_twin')!.revision, 2);

    // A refresh is not production: it creates no Build record, snapshot,
    // active result, provider job or delivery output.
    for (const relative of ['.viscraft/builds', '.viscraft/snapshots', '.viscraft/jobs', '.viscraft/remote', 'output'])
      assert.equal(existsSync(join(fixture.root, relative)), false, `${relative} must not be created by refresh-code`);
    assert.equal(existsSync(join(fixture.root, '.viscraft', 'result.json')), false, 'no active result is written');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
