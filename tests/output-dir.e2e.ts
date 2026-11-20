import { createSymlinkFixture } from './fs-fixtures.js';
/**
 * the Runtime-owned `output/` delivery directory.
 *
 * Omitted destinations land in `output/` under FIXED per-purpose names; a
 * repeat default delivery replaces the recorded, unmodified previous one; only
 * a NEW direct child of `output/` is accepted inside the root; nothing under
 * `output/` can be authored content, so an earlier delivery never rides along in
 * a later export. `output/` also self-ignores in git.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildProject } from '../src/build/build.js';
import { planBuild } from '../src/build/plan.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { archiveProject, restoreProject } from '../src/operations/delivery/archive.js';
import { deliverProject } from '../src/operations/delivery/delivery.js';
import { verifyDelivery } from '../src/operations/delivery/delivery-verification.js';
import { ProjectSchema, type Project } from '../src/core/schema.js';

export function simulatedProject(id = 'output_test'): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id,
    revision: 1,
    title: 'Output Test',
    direction: { intent: 'Output organization fixture', looks: [{ id: 'look', description: 'look' }], transitions: [] },
    assets: [],
    bindings: {},
    sources: [{ id: 'src', kind: 'simulated', prompt: 'a', frames: 12, seed: 1, attempt: 'a1', behavior: 'success' }],
    composition: {
      output: { width: 64, height: 48, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene', description: 'scene' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: 'a', targetFrames: 12 }],
      placements: [{ id: 'pl', shot: 'shot', source: 'src', inFrame: 0, outFrame: 12, startFrame: 0, audio: 'mute' }],
      transitions: [],
      audio: [],
    },
  });
}

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

async function builtProject(): Promise<{ parent: string; root: string }> {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'viscraft-output-'));
  const root = path.join(parent, 'work');
  await mkdir(root);
  await writeFile(path.join(root, 'project.json'), JSON.stringify(simulatedProject()));
  const build = await buildProject(root);
  assert.equal(build.status, 'succeeded');
  return { parent, root };
}

test('omitted destinations land in output/ and are verifiable/restorable', async () => {
  const { parent, root } = await builtProject();
  try {
    const exported = await exportProject(root);
    assert.equal(path.dirname(exported.path), path.join(root, 'output'));
    assert.equal(path.basename(exported.path), 'project');

    const archive = await archiveProject(root);
    assert.equal(archive.path, path.join(root, 'output', 'output_test.tar.gz'));
    const restored = await restoreProject(archive.path, path.join(parent, 'restored'));
    assert.ok(restored.files > 0);

    const delivery = await deliverProject(root, undefined);
    assert.equal(path.basename(delivery.path), 'handoff');
    assert.equal(path.dirname(delivery.path), path.join(root, 'output'));
    assert.equal((await verifyDelivery(delivery.path)).ok, true);

    // A second default export replaces the recorded, unmodified previous one.
    const again = await exportProject(root);
    assert.equal(again.path, exported.path, 'the fixed default name is reused');
    const projectEntries = (await readdir(path.join(root, 'output'))).filter(name => name === 'project');
    assert.deepEqual(projectEntries, ['project'], 'exactly one default export remains');

    // No staging leftovers in output/ (the Runtime-owned `.gitignore` is expected).
    const names = (await readdir(path.join(root, 'output'))).filter(name => name !== '.gitignore');
    assert.ok(!names.some(name => name.startsWith('.')), `staging leaked: ${names.join(', ')}`);

    // An export made while output/ holds earlier deliveries never carries them.
    const custom = await exportProject(root, path.join(root, 'output', 'again'));
    const files = await listFiles(custom.path);
    assert.ok(!files.some(file => file.startsWith('output/')), files.join('\n'));
    const manifest = JSON.parse(await readFile(path.join(custom.path, '.viscraft', 'portable-manifest.json'), 'utf8'));
    assert.ok(!manifest.files.some((file: { path: string }) => file.path.startsWith('output/')));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('inside the root only a new direct child of a real output/ directory is accepted', async t => {
  const { parent, root } = await builtProject();
  try {
    await assert.rejects(exportProject(root, path.join(root, 'elsewhere')), /outside the project root/);
    await assert.rejects(exportProject(root, path.join(root, '.viscraft', 'x')), /outside the project root/);
    await mkdir(path.join(root, 'output', 'a'), { recursive: true });
    await assert.rejects(exportProject(root, path.join(root, 'output', 'a', 'b')), /outside the project root/);
    await assert.rejects(exportProject(root, path.join(root, 'output', 'a')), /already exists/);
    await assert.rejects(exportProject(root, parent), /outside the project root/);
    // A symlinked output/ is never trusted as the Runtime directory.
    await rm(path.join(root, 'output'), { recursive: true });
    const elsewhere = path.join(parent, 'linked');
    await mkdir(elsewhere);
    await createSymlinkFixture(t, elsewhere, path.join(root, 'output'));
    await assert.rejects(exportProject(root), /real directory/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('output/ self-ignores in git and Runtime .gitignore files are never exported', async () => {
  const { parent, root } = await builtProject();
  try {
    await exportProject(root, path.join(root, 'output', 'probe'));

    // The Runtime writes a `*`-only ignore file into output/ on first use.
    assert.equal(await readFile(path.join(root, 'output', '.gitignore'), 'utf8'), '*\n');

    // A Portable export of that project carries no Runtime .gitignore, so a
    // restored project re-creates its own instead of inheriting this machine's.
    const probeFiles = await listFiles(path.join(root, 'output', 'probe'));
    assert.ok(!probeFiles.includes('.gitignore'), probeFiles.join('\n'));
    assert.ok(!probeFiles.includes('.viscraft/.gitignore'), probeFiles.join('\n'));

    const archive = await archiveProject(root, path.join(parent, 'a.tar.gz'));
    const restored = await restoreProject(archive.path, path.join(parent, 'restored'));
    const restoredFiles = await listFiles(restored.path);
    assert.ok(!restoredFiles.includes('.viscraft/.gitignore'), restoredFiles.join('\n'));
    assert.ok(!restoredFiles.includes('output/.gitignore'), restoredFiles.join('\n'));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('an Asset or Source file under output/ is refused by Plan, Build and Export alike', async () => {
  const { parent, root } = await builtProject();
  try {
    await mkdir(path.join(root, 'output'), { recursive: true });
    await writeFile(path.join(root, 'output', 'scene.html'), '<html></html>');
    const project = simulatedProject();
    project.sources.push({
      id: 'code',
      kind: 'browser',
      output: 'picture',
      entry: 'OUTPUT/scene.html',
      resources: [],
      bindings: [],
      params: {},
      seed: 0,
      frames: 1,
    } as Project['sources'][number]);
    await writeFile(path.join(root, 'project.json'), JSON.stringify(project));
    await assert.rejects(planBuild(root), /must not live under output\//);
    await assert.rejects(buildProject(root), /must not live under output\//);
    await assert.rejects(exportProject(root, path.join(parent, 'x')), /must not live under output\//);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
