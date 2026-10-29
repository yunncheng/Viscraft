/**
 * in-place asset registration. A regular file already inside the Project is
 * registered at its own project-relative path with no copy; identical bytes
 * reuse an existing Asset's physical copy; a host file outside the root is still
 * copied; `output/` (and `.viscraft/`) are refused; and editing an in-place file
 * is surfaced by the existing hash checks as `plan.changes`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProjectSchema, type Project } from '../src/core/schema.js';
import { planBuild } from '../src/build/plan.js';
import { importAsset } from '../src/operations/assets/import.js';
import { loadProject } from '../src/project/project.js';
import { snapshotHashOf } from '../src/project/state.js';
import { atomicJson } from '../src/shared/fs.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';

const RIGHTS = { origin: 'original local in-place registration test', license: 'CC0-1.0', redistributable: true };

function project(): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'import_in_place',
    revision: 1,
    title: 'In-place registration',
    direction: { intent: 'test', looks: [{ id: 'look', description: 'test' }], transitions: [] },
    assets: [],
    bindings: {},
    sources: [{ id: 'source', kind: 'browser', output: 'picture', entry: 'scene.html', frames: 24 }],
    composition: {
      output: { width: 32, height: 24, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene', description: 'test' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: 'test', targetFrames: 24 }],
      placements: [
        { id: 'placement', shot: 'shot', source: 'source', inFrame: 0, outFrame: 24, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio: [],
    },
  });
}

async function makePng(destination: string, color: string): Promise<void> {
  await runCommand('ffmpeg', [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-v',
    'error',
    '-threads',
    '2',
    '-filter_threads',
    '1',
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=32x24`,
    '-frames:v',
    '1',
    destination,
  ]);
}

async function setup(): Promise<{ base: string; root: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'viscraft-import-inplace-'));
  const root = path.join(base, 'project');
  await mkdir(root);
  await atomicJson(path.join(root, 'project.json'), project());
  await writeFile(path.join(root, 'scene.html'), '<!doctype html><html></html>\n');
  return { base, root };
}

test('a file already inside the Project registers at its own path without copying', async () => {
  const { base, root } = await setup();
  try {
    const media = path.join(root, 'media');
    await mkdir(media);
    const source = path.join(media, 'hero.png');
    await makePng(source, '0x224466');
    const assetsBefore = await readdir(path.join(root, 'assets')).catch(() => []);

    const asset = await importAsset(root, {
      assetId: 'hero',
      sourcePath: source,
      type: 'image',
      rights: RIGHTS,
      expectedRevision: 1,
    });

    assert.equal(asset.path, 'media/hero.png');
    assert.equal(asset.sha256, await hashFile(source));
    assert.deepEqual(
      await readdir(path.join(root, 'assets')).catch(() => []),
      assetsBefore,
      'no duplicate landed under assets/',
    );
    assert.equal((await loadProject(root)).assets[0].path, 'media/hero.png');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('identical bytes reuse an existing Asset path instead of producing a new copy', async () => {
  const { base, root } = await setup();
  try {
    const media = path.join(root, 'media');
    await mkdir(media);
    const source = path.join(media, 'hero.png');
    await makePng(source, '0x224466');

    const first = await importAsset(root, {
      assetId: 'hero',
      sourcePath: source,
      type: 'image',
      rights: RIGHTS,
      expectedRevision: 1,
    });
    const alias = await importAsset(root, {
      assetId: 'hero_alias',
      sourcePath: source,
      type: 'image',
      rights: { ...RIGHTS, license: 'different rights record' },
      expectedRevision: 2,
    });

    assert.equal(alias.id, 'hero_alias', 'the new Asset keeps its own identity');
    assert.equal(alias.path, first.path, 'identical bytes reuse the registered physical copy');
    assert.deepEqual(alias.rights, { ...RIGHTS, license: 'different rights record' }, 'rights are not inherited');
    assert.deepEqual(await readdir(media), ['hero.png'], 'no second physical copy was written next to the source');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a file outside the Project root is still copied to a content-addressed assets path', async () => {
  const { base, root } = await setup();
  try {
    const outside = path.join(base, 'host-download.png');
    await makePng(outside, '0x66aa22');

    const asset = await importAsset(root, {
      assetId: 'external',
      sourcePath: outside,
      type: 'image',
      rights: RIGHTS,
      expectedRevision: 1,
    });

    assert.equal(asset.path, `assets/external-${asset.sha256.slice(0, 16)}.png`);
    assert.equal(await hashFile(path.join(root, asset.path)), asset.sha256);
    assert.deepEqual(await readFile(path.join(root, asset.path)), await readFile(outside));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('files under output/, .viscraft/ or a credential filename are refused, leaving the Project unchanged', async () => {
  const { base, root } = await setup();
  try {
    const before = await readFile(path.join(root, 'project.json'));
    const output = path.join(root, 'output');
    await mkdir(output);
    const delivered = path.join(output, 'delivery.png');
    await makePng(delivered, '0x884422');
    await assert.rejects(
      importAsset(root, {
        assetId: 'delivered',
        sourcePath: delivered,
        type: 'image',
        rights: RIGHTS,
        expectedRevision: 1,
      }),
      /must not live under output\//,
    );

    const internal = path.join(root, '.viscraft', 'generated.png');
    await mkdir(path.dirname(internal), { recursive: true });
    await makePng(internal, '0x884422');
    await assert.rejects(
      importAsset(root, {
        assetId: 'internal',
        sourcePath: internal,
        type: 'image',
        rights: RIGHTS,
        expectedRevision: 1,
      }),
      /must not be stored under \.viscraft\//,
    );

    // A credential-looking authored filename is refused at registration, not left
    // for a later export to reject (one authored-path policy end to end).
    const credential = path.join(root, 'media', '.env.png');
    await mkdir(path.dirname(credential), { recursive: true });
    await makePng(credential, '0x884422');
    await assert.rejects(
      importAsset(root, {
        assetId: 'credential',
        sourcePath: credential,
        type: 'image',
        rights: RIGHTS,
        expectedRevision: 1,
      }),
      /must not package a credential file/,
    );

    assert.deepEqual(await readFile(path.join(root, 'project.json')), before, 'rejection preserves Project bytes');
    assert.deepEqual(await readdir(path.join(root, '.viscraft', 'scratch')).catch(() => []), [], 'staging is removed');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('editing an in-place Asset file is surfaced by plan.changes', async () => {
  const { base, root } = await setup();
  try {
    const media = path.join(root, 'media');
    await mkdir(media);
    const source = path.join(media, 'hero.png');
    await makePng(source, '0x224466');
    const asset = await importAsset(root, {
      assetId: 'hero',
      sourcePath: source,
      type: 'image',
      rights: RIGHTS,
      expectedRevision: 1,
    });
    const frozen = await loadProject(root);

    // Freeze a result over the current author state (the same closure a Build
    // hashes), then edit the in-place file the way the author would.
    const files = {
      'scene.html': await hashFile(path.join(root, 'scene.html')),
      [asset.path]: await hashFile(path.join(root, asset.path)),
    };
    await atomicJson(path.join(root, '.viscraft', 'snapshots', 'build-x.project.json'), frozen);
    await atomicJson(path.join(root, '.viscraft', 'snapshots', 'build-x.inputs.json'), {
      files,
      unavailable: [],
    });
    await atomicJson(path.join(root, '.viscraft', 'builds', 'build-x.json'), {
      schemaVersion: 1,
      id: 'build-x',
      run: { id: 'run-x', goal: 'fixture' },
      plan: { operations: [] },
      revision: frozen.revision,
      snapshotHash: snapshotHashOf(frozen, files, []),
      status: 'succeeded',
      medium: 'picture',
      startedAt: '2026-01-01T00:00:00.000Z',
      operations: [],
      artifacts: [],
      takes: [],
      result: { artifact: 'artifact-x', simulated: false },
    });
    await atomicJson(path.join(root, '.viscraft', 'result.json'), {
      build: 'build-x',
      artifact: 'artifact-x',
      path: '.viscraft/artifacts/artifact-x.mp4',
      sha256: 'a'.repeat(64),
      simulated: false,
    });

    assert.equal((await planBuild(root)).changes, null, 'unchanged authoring reports no changes');

    await makePng(source, '0x993311');
    const plan = await planBuild(root);
    assert.notEqual(plan.changes, null);
    assert.ok(
      plan.changes!.files.some(file => file.path === asset.path && file.change === 'modified'),
      `expected ${asset.path} reported modified, got ${JSON.stringify(plan.changes!.files)}`,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
