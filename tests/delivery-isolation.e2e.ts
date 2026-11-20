/**
 * H1 — an H-delivered bundle must keep every EDITABLE author byte independent
 * of every frozen/derived product (and of every other editable file), so the
 * receiver can edit the bundled project in place without making a file
 * read-only or silently mutating frozen history. Frozen products may still
 * dedup among themselves. `bytes` is the summed size of distinct `(dev, inode)`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { buildProject } from '../src/build/build.js';
import { deliverProject } from '../src/operations/delivery/delivery.js';
import { hashFile } from '../src/shared/hash.js';
import { ProjectSchema, type Project } from '../src/core/schema.js';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-isolation-'));
}

/** A project with two IDENTICAL author Asset files (distinct paths, same bytes). */
async function twinAssetProject(root: string): Promise<Project> {
  await fs.mkdir(nodePath.join(root, 'assets'), { recursive: true });
  const shared = 'shared asset bytes\n';
  await fs.writeFile(nodePath.join(root, 'assets', 'twin-a.txt'), shared);
  await fs.writeFile(nodePath.join(root, 'assets', 'twin-b.txt'), shared);
  const sha = await hashFile(nodePath.join(root, 'assets', 'twin-a.txt'));
  const rights = { origin: 'studio', license: 'CC0-1.0', redistributable: true };
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'isolation_fixture',
    revision: 1,
    title: 'Isolation fixture',
    direction: { intent: 'H1', looks: [{ id: 'look', description: 'look' }], transitions: [] },
    assets: [
      { id: 'twinA', revision: 1, path: 'assets/twin-a.txt', sha256: sha, type: 'code', rights },
      { id: 'twinB', revision: 1, path: 'assets/twin-b.txt', sha256: sha, type: 'code', rights },
    ],
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

test('H1: two identical editable author files stay separate inodes and writable', async () => {
  const parent = await tempDir();
  const root = nodePath.join(parent, 'work');
  try {
    const project = await twinAssetProject(root);
    await fs.writeFile(nodePath.join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
    assert.equal((await buildProject(root)).status, 'succeeded');

    const delivery = await deliverProject(root, undefined, {});
    // `continue` lands in output/handoff (H2 naming).
    assert.equal(delivery.path, nodePath.join(root, 'output', 'handoff'));

    const a = await fs.stat(nodePath.join(delivery.path, 'project', 'assets', 'twin-a.txt'), { bigint: true });
    const b = await fs.stat(nodePath.join(delivery.path, 'project', 'assets', 'twin-b.txt'), { bigint: true });
    assert.notEqual(a.ino, b.ino, 'two identical author files must not share an inode');
    assert.notEqual(a.mode & 0o222n, 0n, 'twin-a must stay writable');
    assert.notEqual(b.mode & 0o222n, 0n, 'twin-b must stay writable');

    // Both edits succeed and change only their own file.
    await fs.writeFile(nodePath.join(delivery.path, 'project', 'assets', 'twin-a.txt'), 'edited a\n');
    assert.equal(
      await fs.readFile(nodePath.join(delivery.path, 'project', 'assets', 'twin-b.txt'), 'utf8'),
      'shared asset bytes\n',
    );
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('H1: editing a bundled current file in place does not touch the frozen snapshot or movie', async () => {
  const parent = await tempDir();
  const root = nodePath.join(parent, 'work');
  try {
    const project = await twinAssetProject(root);
    await fs.writeFile(nodePath.join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
    const build = await buildProject(root);
    const delivery = await deliverProject(root, undefined, {});

    const frozenRel = nodePath.join('project', '.viscraft', 'snapshots', `${build.id}.project.json`);
    const frozenAbs = nodePath.join(delivery.path, frozenRel);
    const currentAbs = nodePath.join(delivery.path, 'project', 'project.json');
    const movieAbs = nodePath.join(delivery.path, 'movie', 'final.mp4');
    const frozenInfo = await fs.stat(frozenAbs, { bigint: true });
    const currentInfo = await fs.stat(currentAbs, { bigint: true });
    assert.notEqual(currentInfo.ino, frozenInfo.ino, 'the current project must not share the frozen snapshot inode');
    assert.notEqual(currentInfo.mode & 0o222n, 0n, 'the current project.json stays writable');

    const frozenBefore = await hashFile(frozenAbs);
    const movieBefore = await hashFile(movieAbs);
    // In-place edit of the bundled current project must succeed and isolate.
    await fs.writeFile(currentAbs, `${await fs.readFile(currentAbs, 'utf8')} `);
    assert.equal(await hashFile(frozenAbs), frozenBefore, 'frozen snapshot bytes are unchanged');
    assert.equal(await hashFile(movieAbs), movieBefore, 'the delivered movie is unchanged');
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
