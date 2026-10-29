/**
 * `viscraft usage` contract:
 *  - the per-category `physicalBytes` sum equals the Project's real on-disk
 *    usage — one `(dev, inode)` counted once, even across hardlinks;
 *  - `logicalBytes` counts every path, `uniqueContentBytes` counts distinct sha;
 *  - it is ZERO-WRITE.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createProject } from '../src/project/create.js';
import { projectUsage } from '../src/project/usage.js';
import { snapshotHashOf } from '../src/project/state.js';
import { hashFile } from '../src/shared/hash.js';
import type { BuildRecord, Project } from '../src/core/schema.js';

const ENTRY = 'code/main.js';

async function makeProject(root: string): Promise<Project> {
  const created = await createProject(root, { title: 'Usage fixture' });
  await mkdir(join(root, 'code'), { recursive: true });
  await writeFile(join(root, ENTRY), 'export const ready = () => true;\n');
  const project: Project = {
    ...created,
    sources: [
      {
        id: 'scene',
        kind: 'browser',
        output: 'picture',
        entry: ENTRY,
        resources: [],
        bindings: [],
        params: {},
        seed: 0,
        frames: 24,
      },
    ],
  };
  await writeFile(join(root, 'project.json'), JSON.stringify(project));
  return project;
}

/** Sum each distinct (dev, inode) once — the ground truth `physicalBytes` must equal. */
async function actualPhysicalBytes(root: string): Promise<number> {
  const seen = new Map<string, number>();
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else {
        const info = await lstat(abs, { bigint: true });
        seen.set(`${info.dev}:${info.ino}`, Number(info.size));
      }
    }
  }
  await walk(root);
  let total = 0;
  for (const size of seen.values()) total += size;
  return total;
}

async function treeHashes(root: string): Promise<string> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else out.push(`${abs.replace(root, '')}:${await hashFile(abs)}`);
    }
  }
  await walk(root);
  return out.sort().join('\n');
}

test('usage: physicalBytes sum equals the real root usage, hardlinks counted once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-usage-'));
  try {
    await makeProject(root);
    await mkdir(join(root, '.viscraft', 'scratch'), { recursive: true });
    await writeFile(join(root, '.viscraft', 'scratch', 'blob.bin'), Buffer.alloc(4096, 3));
    // A hardlink to the same inode must not double-count physical bytes.
    await link(join(root, '.viscraft', 'scratch', 'blob.bin'), join(root, '.viscraft', 'scratch', 'blob-link.bin'));

    const before = await treeHashes(root);
    const usage = await projectUsage(root);
    const after = await treeHashes(root);

    const expected = await actualPhysicalBytes(root);
    assert.equal(usage.totals.physicalBytes, expected, 'physicalBytes must sum to the real root usage');

    // The hardlinked pair is one physical file but two logical paths.
    const scratch = usage.categories.scratch;
    assert.ok(scratch.files >= 2, 'both scratch paths are reported');
    assert.equal(scratch.physicalBytes, 4096, 'a hardlinked inode is counted once');

    assert.ok(usage.categories.author.files >= 1, 'the code entry is authored');
    assert.ok(usage.reclaimablePhysicalBytes >= 4096, 'scratch leftovers are reclaimable');
    assert.equal(before, after, 'usage must not write anything');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('usage: a hardlinked inode is charged to the strongest-reason category, so reclaimable is not overstated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-usage-'));
  try {
    await makeProject(root);
    // A snapshot file hardlinked from scratch: deleting the scratch path frees 0.
    await mkdir(join(root, '.viscraft', 'snapshots', 'build-x'), { recursive: true });
    await mkdir(join(root, '.viscraft', 'scratch'), { recursive: true });
    await writeFile(join(root, '.viscraft', 'snapshots', 'build-x', 'frozen.bin'), Buffer.alloc(8192, 5));
    await link(
      join(root, '.viscraft', 'snapshots', 'build-x', 'frozen.bin'),
      join(root, '.viscraft', 'scratch', 'leftover.bin'),
    );

    const usage = await projectUsage(root);
    assert.equal(usage.categories.snapshots.physicalBytes, 8192, 'snapshots owns the shared inode');
    assert.equal(
      usage.categories.scratch.physicalBytes,
      0,
      'the scratch link shares the inode, so it holds no physical bytes',
    );
    assert.equal(usage.reclaimablePhysicalBytes, 0, 'deleting the scratch path frees nothing');
    assert.equal(await actualPhysicalBytes(root), usage.totals.physicalBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('usage: intermediate inputs of the current result are protected, not reclaimable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-usage-'));
  try {
    const project = await createProject(root, { title: 'Lineage fixture' });
    await mkdir(join(root, '.viscraft', 'artifacts'), { recursive: true });
    await mkdir(join(root, '.viscraft', 'builds'), { recursive: true });
    await mkdir(join(root, '.viscraft', 'snapshots'), { recursive: true });
    await writeFile(join(root, '.viscraft', 'artifacts', 'artifact-final.mp4'), Buffer.alloc(4096, 1));
    await writeFile(join(root, '.viscraft', 'artifacts', 'artifact-mid.wav'), Buffer.alloc(2048, 2));
    const finalSha = await hashFile(join(root, '.viscraft', 'artifacts', 'artifact-final.mp4'));
    const midSha = await hashFile(join(root, '.viscraft', 'artifacts', 'artifact-mid.wav'));
    const files = {};
    await writeFile(join(root, '.viscraft', 'snapshots', 'build-x.project.json'), JSON.stringify(project));
    await writeFile(
      join(root, '.viscraft', 'snapshots', 'build-x.inputs.json'),
      JSON.stringify({ files, unavailable: [] }),
    );
    const record: BuildRecord = {
      schemaVersion: 1,
      id: 'build-x',
      run: { id: 'run-x', goal: 'fixture' },
      plan: { operations: ['op1', 'op2'] },
      revision: project.revision,
      snapshotHash: snapshotHashOf(project, files, []),
      status: 'succeeded',
      medium: 'picture',
      startedAt: '2026-01-01T00:00:00.000Z',
      operations: [
        {
          id: 'op1',
          kind: 'mux-final',
          key: 'k1',
          inputs: ['artifact-mid'],
          artifact: 'artifact-final',
          reused: false,
        },
        { id: 'op2', kind: 'mix-audio', key: 'k2', inputs: [], artifact: 'artifact-mid', reused: false },
      ],
      artifacts: [
        {
          id: 'artifact-final',
          path: '.viscraft/artifacts/artifact-final.mp4',
          sha256: finalSha,
          kind: 'video',
          simulated: false,
          operation: 'mux-final',
          inputs: ['artifact-mid'],
          backend: 'ffmpeg',
        },
        {
          id: 'artifact-mid',
          path: '.viscraft/artifacts/artifact-mid.wav',
          sha256: midSha,
          kind: 'audio',
          simulated: false,
          operation: 'mix-audio',
          inputs: [],
          backend: 'ffmpeg',
        },
      ],
      takes: [],
      result: { artifact: 'artifact-final', simulated: false },
    };
    await writeFile(join(root, '.viscraft', 'builds', 'build-x.json'), JSON.stringify(record));
    await writeFile(
      join(root, '.viscraft', 'result.json'),
      JSON.stringify({
        build: 'build-x',
        artifact: 'artifact-final',
        path: '.viscraft/artifacts/artifact-final.mp4',
        sha256: finalSha,
        simulated: false,
      }),
    );

    const usage = await projectUsage(root);
    assert.equal(usage.artifacts['protected-current']?.files, 2, 'the final artifact AND its input are protected');
    assert.equal(usage.artifacts.rebuildable, undefined, 'nothing reachable from the current result is reclaimable');
    assert.equal(usage.reclaimablePhysicalBytes, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('usage: logical, unique-content and physical measures differ for duplicates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-usage-'));
  try {
    await makeProject(root);
    await mkdir(join(root, '.viscraft', 'scratch'), { recursive: true });
    const payload = Buffer.alloc(2048, 9);
    await writeFile(join(root, '.viscraft', 'scratch', 'a.bin'), payload);
    await writeFile(join(root, '.viscraft', 'scratch', 'b.bin'), payload); // same bytes, distinct inodes

    const usage = await projectUsage(root);
    const scratch = usage.categories.scratch;
    assert.equal(scratch.logicalBytes, 4096, 'two paths, two copies');
    assert.equal(scratch.uniqueContentBytes, 2048, 'one distinct sha');
    assert.equal(scratch.physicalBytes, 4096, 'two distinct inodes');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('usage: Project-wide unique content deduplicates copies and hardlinks across categories without changing physical accounting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-usage-'));
  try {
    await makeProject(root);
    await mkdir(join(root, '.viscraft', 'scratch'), { recursive: true });
    await mkdir(join(root, 'output'));
    const payload = await readFile(join(root, ENTRY));
    await writeFile(join(root, '.viscraft', 'scratch', 'copy.bin'), payload);
    await link(join(root, '.viscraft', 'scratch', 'copy.bin'), join(root, '.viscraft', 'scratch', 'linked.bin'));
    await writeFile(join(root, 'output', 'copy.bin'), payload);

    const before = await treeHashes(root);
    const usage = await projectUsage(root);
    const physical = await actualPhysicalBytes(root);
    assert.equal(usage.categories.scratch.uniqueContentBytes, payload.length);
    assert.equal(usage.categories.output.uniqueContentBytes, payload.length);
    assert.equal(usage.totals.physicalBytes, physical, 'three copies still occupy three independent inodes');
    assert.equal(usage.totals.uniqueContentBytes, physical - 2 * payload.length, 'one shared content counted once');
    assert.equal(usage.totals.logicalBytes, physical + payload.length, 'the hardlink still has its own logical path');
    assert.ok(
      Object.values(usage.categories).reduce((sum, category) => sum + category.uniqueContentBytes, 0) >
        usage.totals.uniqueContentBytes,
      'per-category distinct content is not additive across categories',
    );
    assert.equal(await treeHashes(root), before, 'usage remains zero-write');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
