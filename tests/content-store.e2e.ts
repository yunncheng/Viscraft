/**
 * snapshot dedup through the content store `.viscraft/content/<sha256>`:
 *  - three Builds of an unchanged Project store each authored byte sequence
 *    once (snapshot unique physical bytes ≈ author bytes, not 3×);
 *  - a snapshot is never linked to the editable original, so an in-place
 *    author edit leaves frozen bytes untouched;
 *  - frozen paths are read-only;
 *  - a refused link falls back to an independent read-only copy;
 *  - a corrupt store entry is quarantined, never reused.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { buildProject } from '../src/build/build.js';
import { ProjectSchema, type Project } from '../src/core/schema.js';
import { atomicJson } from '../src/shared/fs.js';
import { hashFile } from '../src/shared/hash.js';
import { contentPath, freezeFile, setContentLinkForTest, storeContent } from '../src/project/content-store.js';
import { projectUsage } from '../src/project/usage.js';

const FPS = { numerator: 25, denominator: 1 };
const FRAMES = 25;
const RIGHTS = { origin: 'test fixture', license: 'private', redistributable: false };

async function fixture(): Promise<{ root: string; sha256: string; bytes: number }> {
  const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-content-store-'));
  await fs.mkdir(nodePath.join(root, 'assets'), { recursive: true });
  const payload = Buffer.alloc(256 * 1024, 7);
  await fs.writeFile(nodePath.join(root, 'assets', 'ref.bin'), payload);
  const sha256 = await hashFile(nodePath.join(root, 'assets', 'ref.bin'));
  const project: Project = ProjectSchema.parse({
    schemaVersion: 1,
    id: 'content_store',
    revision: 1,
    title: 'Content store',
    direction: { intent: 'test', looks: [{ id: 'look_main', description: 'main' }], transitions: [] },
    assets: [
      { id: 'ref', revision: 1, path: 'assets/ref.bin', sha256, type: 'code', rights: RIGHTS, simulated: false },
    ],
    bindings: {},
    sources: [
      {
        id: 'src_sim',
        kind: 'simulated',
        prompt: 'control chain',
        frames: FRAMES,
        seed: 0,
        attempt: 'attempt_store',
        behavior: 'success',
      },
    ],
    composition: {
      output: { width: 64, height: 48, fps: FPS, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene_1', description: 'scene' }],
      shots: [{ id: 'shot_1', scene: 'scene_1', look: 'look_main', intent: 'shot', targetFrames: FRAMES }],
      placements: [
        {
          id: 'place_1',
          shot: 'shot_1',
          source: 'src_sim',
          inFrame: 0,
          outFrame: FRAMES,
          startFrame: 0,
          audio: 'mute',
        },
      ],
      transitions: [],
      audio: [],
    },
  });
  await atomicJson(nodePath.join(root, 'project.json'), project);
  return { root, sha256, bytes: payload.length };
}

test('three Builds store each authored byte sequence once; author edits never reach frozen bytes', async () => {
  const { root, sha256, bytes } = await fixture();
  try {
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const record = await buildProject(root);
      assert.equal(record.status, 'succeeded', JSON.stringify(record.error));
      ids.push(record.id);
    }
    const original = nodePath.join(root, 'assets', 'ref.bin');
    const entry = nodePath.join(root, contentPath(sha256));
    const entryInfo = await fs.stat(entry, { bigint: true });
    assert.equal(entryInfo.mode & 0o777n, 0o444n, 'store entry is read-only');
    const originalInfo = await fs.stat(original, { bigint: true });
    assert.notEqual(originalInfo.ino, entryInfo.ino, 'the store never links the editable original');
    for (const id of ids) {
      const frozen = nodePath.join(root, '.viscraft', 'snapshots', id, 'assets', 'ref.bin');
      const info = await fs.stat(frozen, { bigint: true });
      assert.equal(info.ino, entryInfo.ino, `snapshot ${id} links the store entry`);
      assert.equal(info.mode & 0o777n, 0o444n);
    }

    const usage = await projectUsage(root);
    const snapshots = usage.categories.snapshots;
    const content = usage.categories.content;
    assert.ok(snapshots && content, 'snapshot and content categories reported');
    assert.ok(snapshots.logicalBytes >= 3 * bytes, 'three logical frozen paths');
    // Three snapshot paths + one store entry share one inode: one physical copy.
    const physical = snapshots.physicalBytes + content.physicalBytes;
    assert.ok(physical >= bytes && physical < 2 * bytes, `frozen physical bytes ${physical}`);

    // In-place author edit (same inode): frozen bytes are untouched.
    await fs.writeFile(original, Buffer.alloc(bytes, 9));
    for (const id of ids)
      assert.equal(await hashFile(nodePath.join(root, '.viscraft', 'snapshots', id, 'assets', 'ref.bin')), sha256);
    assert.equal(await hashFile(entry), sha256);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a refused link falls back to an independent read-only copy', async () => {
  const { root, sha256 } = await fixture();
  const snapshot = nodePath.join(root, '.viscraft', 'snapshots', 'manual');
  await fs.mkdir(snapshot, { recursive: true });
  setContentLinkForTest(async () => {
    throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
  });
  try {
    assert.equal(await freezeFile(root, snapshot, 'assets/ref.bin'), sha256);
    const frozen = await fs.stat(nodePath.join(snapshot, 'assets', 'ref.bin'), { bigint: true });
    const entry = await fs.stat(nodePath.join(root, contentPath(sha256)), { bigint: true });
    assert.notEqual(frozen.ino, entry.ino);
    assert.equal(frozen.mode & 0o777n, 0o444n);
  } finally {
    setContentLinkForTest();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a corrupt store entry is quarantined and rebuilt, never reused', async () => {
  const { root, sha256 } = await fixture();
  try {
    const entry = nodePath.join(root, contentPath(sha256));
    await fs.mkdir(nodePath.dirname(entry), { recursive: true });
    await fs.writeFile(entry, 'tampered');
    const stored = await storeContent(root, nodePath.join(root, 'assets', 'ref.bin'));
    assert.equal(stored.sha256, sha256);
    assert.equal(await hashFile(entry), sha256);
    const siblings = await fs.readdir(nodePath.dirname(entry));
    assert.ok(
      siblings.some(name => name.startsWith(`${sha256}.corrupt-`)),
      'corrupt entry kept as evidence',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
