/**
 * Scoped production inputs vs the complete author inventory.
 *
 * Validity and reuse are scoped to the files a run actually CONSUMES, but the
 * frozen snapshot must still tell the truth about every declared author fact:
 *
 *  - one missing/unreadable/damaged file never erases the readable facts;
 *  - a missing Asset whose bytes are verified in the content store is recovered,
 *    not reported as a gap;
 *  - a readable file whose bytes disagree with its declared digest keeps its
 *    ACTUAL bytes as an author fact AND is recorded as a `mismatch` gap;
 *  - the gap list is part of the snapshot integrity hash, so a snapshot that
 *    froze with a gap can never hash like one that did not declare the file.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { authoredFileFacts } from '../src/project/author-inputs.js';
import { snapshotHashOf } from '../src/project/state.js';
import { validateProject } from '../src/project/project.js';
import { contentPath } from '../src/project/content-store.js';

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const RIGHTS = { origin: 'test fixture', license: 'CC0-1.0', redistributable: true };

function projectWith(assets: unknown[], extra: Record<string, unknown> = {}) {
  return validateProject({
    schemaVersion: 1,
    id: 'scoped-inputs',
    revision: 1,
    title: 'Scoped inputs',
    direction: { intent: 'scope', looks: [{ id: 'only', description: 'plain' }] },
    sources: [],
    assets,
    ...extra,
  });
}

const asset = (id: string, path: string, sha256: string, type: 'audio' | 'image' = 'audio') => ({
  id,
  revision: 1,
  path,
  sha256,
  type,
  rights: RIGHTS,
  simulated: false,
});

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'viscraft-scoped-'));
}

test('inventory keeps readable facts and records only the unusable declarations', async () => {
  const dir = await root();
  try {
    const used = Buffer.from('used bytes');
    await writeFile(join(dir, 'used.bin'), used);
    const project = projectWith([
      asset('used', 'used.bin', sha256(used)),
      asset('absent', 'absent.bin', 'a'.repeat(64), 'image'),
    ]);

    const facts = await authoredFileFacts(project, dir);
    assert.equal(facts.files['used.bin'], sha256(used));
    assert.deepEqual(
      facts.unavailable.map(gap => [gap.path, gap.reason]),
      [['absent.bin', 'path-missing']],
    );
    assert.deepEqual(facts.unavailable[0].owners, ['asset:absent']);
    assert.equal(facts.unavailable[0].expectedSha256, 'a'.repeat(64));
    assert.equal(facts.unavailable[0].actualSha256, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a readable file that disagrees with its declared digest keeps the ACTUAL bytes and a mismatch gap', async () => {
  const dir = await root();
  try {
    const actual = Buffer.from('edited after admission');
    await writeFile(join(dir, 'take.wav'), actual);
    const project = projectWith([asset('take', 'take.wav', 'b'.repeat(64))]);

    const facts = await authoredFileFacts(project, dir);
    assert.equal(facts.files['take.wav'], sha256(actual), 'author bytes are preserved, not dropped');
    const [gap] = facts.unavailable;
    assert.equal(gap.reason, 'hash-mismatch');
    assert.equal(gap.path, 'take.wav');
    assert.equal(gap.expectedSha256, 'b'.repeat(64));
    assert.equal(gap.actualSha256, sha256(actual));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing Asset is recovered from the verified content store instead of becoming a gap', async () => {
  const dir = await root();
  try {
    const bytes = Buffer.from('store held bytes');
    // The authored path is gone; only a verified content-store entry remains.
    await mkdir(join(dir, '.viscraft/content'), { recursive: true });
    await writeFile(join(dir, contentPath(sha256(bytes))), bytes);

    const project = projectWith([asset('held', 'held.wav', sha256(bytes))]);
    const unrecovered = await authoredFileFacts(project, dir);
    assert.equal(unrecovered.unavailable[0].reason, 'path-missing');

    const facts = await authoredFileFacts(project, dir, {
      recover: async (_path, declared) => (declared === sha256(bytes) ? declared : null),
    });
    assert.equal(facts.files['held.wav'], sha256(bytes));
    assert.deepEqual(facts.unavailable, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the gap list is part of the snapshot integrity hash', async () => {
  const project = projectWith([asset('absent', 'absent.bin', 'c'.repeat(64))]);
  const files = { 'absent.bin': 'd'.repeat(64) };
  const gap = {
    path: 'absent.bin',
    reason: 'path-missing' as const,
    expectedSha256: 'c'.repeat(64),
    actualSha256: null,
    owners: ['asset:absent'],
  };
  assert.notEqual(snapshotHashOf(project, files, []), snapshotHashOf(project, files, [gap]));
  assert.notEqual(snapshotHashOf(project, files, [gap]), snapshotHashOf(project, files, [{ ...gap, path: 'x.bin' }]));
});
