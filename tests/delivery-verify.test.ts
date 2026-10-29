/**
 * Coverage for `verifyDelivery` — the inverse of `deliverProject`.
 *
 * These tests deliver a real bundle through the normal build + deliver path, so
 * they exercise the exact manifest `deliverProject` writes rather than a
 * hand-authored fixture. The point is honesty: a bundle must verify `ok` only
 * when every listed file still matches and nothing unlisted is present, and a
 * malformed manifest must be refused loudly instead of read as "no files".
 */

import { test, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { buildProject } from '../src/build/build.js';
import { deliverProject } from '../src/operations/delivery/delivery.js';
// Import through the public entry so this test proves the capability is actually
// exported from `src/index.ts`, not merely reachable as an internal module.
import { verifyDelivery } from '../src/index.js';
import { ProjectSchema } from '../src/core/schema.js';
import type { Project } from '../src/core/schema.js';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-delivery-verify-'));
}

/** A minimal two-shot simulated project that produces a real, openable movie. */
function makeProject(): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'delivery_verify_test',
    revision: 1,
    title: 'Delivery Verify Test',
    direction: {
      intent: 'Two-shot simulated build for delivery verification coverage.',
      looks: [{ id: 'look_main', description: 'main look' }],
      transitions: [],
    },
    assets: [],
    bindings: {},
    sources: [
      {
        id: 'src_a',
        kind: 'simulated',
        prompt: 'shot a',
        frames: 12,
        seed: 1,
        attempt: 'attempt_a',
        behavior: 'success',
      },
      {
        id: 'src_b',
        kind: 'simulated',
        prompt: 'shot b',
        frames: 12,
        seed: 2,
        attempt: 'attempt_b',
        behavior: 'success',
      },
    ],
    composition: {
      output: { width: 160, height: 120, fps: { numerator: 25, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene_1', description: 'scene' }],
      shots: [
        { id: 'shot_a', scene: 'scene_1', look: 'look_main', intent: 'a', targetFrames: 12 },
        { id: 'shot_b', scene: 'scene_1', look: 'look_main', intent: 'b', targetFrames: 12 },
      ],
      placements: [
        { id: 'pl_a', shot: 'shot_a', source: 'src_a', inFrame: 0, outFrame: 12, startFrame: 0, audio: 'mute' },
        { id: 'pl_b', shot: 'shot_b', source: 'src_b', inFrame: 0, outFrame: 12, startFrame: 12, audio: 'mute' },
      ],
      transitions: [],
      audio: [],
    },
  });
}

/** Build the project and deliver it once; return the bundle directory. */
async function deliverFresh(t: TestContext): Promise<string> {
  const parent = await tempDir();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = nodePath.join(parent, 'project');
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(nodePath.join(root, 'project.json'), `${JSON.stringify(makeProject(), null, 2)}\n`);
  const record = await buildProject(root);
  assert.equal(record.status, 'succeeded');
  assert.ok(record.result, 'a succeeded build has a result');
  const destination = nodePath.join(parent, 'bundle');
  await deliverProject(root, destination, { review: true, stems: true });
  return destination;
}

test('a freshly delivered bundle verifies ok with zero mismatched/missing/unlisted', async t => {
  const bundle = await deliverFresh(t);
  const result = await verifyDelivery(bundle);

  assert.equal(result.ok, true);
  assert.equal(result.mismatched.length, 0);
  assert.equal(result.missing.length, 0);
  assert.equal(result.unlisted.length, 0);
  assert.ok(result.listed > 0, 'the manifest lists real bundled files');
  assert.equal(result.verified, result.listed);
  assert.equal(result.manifest, 'delivery-manifest.json');
  assert.equal(result.format, 'viscraft-delivery-bundle');
  assert.equal(result.version, 1);
  assert.match(result.manifestSha256, /^[a-f0-9]{64}$/);
});

test('mutating one listed file reports exactly that path as mismatched', async t => {
  const bundle = await deliverFresh(t);
  const target = 'index.html';
  await fs.appendFile(nodePath.join(bundle, ...target.split('/')), '<!-- tampered -->\n');

  const result = await verifyDelivery(bundle);

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.mismatched.map(entry => entry.path),
    [target],
  );
  assert.notEqual(result.mismatched[0]!.expected, result.mismatched[0]!.actual);
  assert.match(result.mismatched[0]!.expected, /^[a-f0-9]{64}$/);
  assert.match(result.mismatched[0]!.actual, /^[a-f0-9]{64}$/);
  assert.equal(result.missing.length, 0);
  assert.equal(result.unlisted.length, 0);
  assert.equal(result.verified, result.listed - 1);
});

test('adding an unlisted file reports exactly that path as unlisted', async t => {
  const bundle = await deliverFresh(t);
  const added = '.viscraft/builds/build-extra-unlisted.json';
  await fs.mkdir(nodePath.join(bundle, '.viscraft', 'builds'), { recursive: true });
  await fs.writeFile(nodePath.join(bundle, ...added.split('/')), '{"stray":true}\n');

  const result = await verifyDelivery(bundle);

  assert.equal(result.ok, false);
  assert.deepEqual(result.unlisted, [added]);
  assert.equal(result.mismatched.length, 0);
  assert.equal(result.missing.length, 0);
  assert.equal(result.verified, result.listed);
});

test('a malformed manifest is refused loudly', async t => {
  const bundle = await deliverFresh(t);
  // Valid JSON with the wrong identity: not a viscraft delivery bundle.
  await fs.writeFile(
    nodePath.join(bundle, 'delivery-manifest.json'),
    `${JSON.stringify({ format: 'not-a-viscraft-bundle', version: 1, files: [] }, null, 2)}\n`,
  );

  await assert.rejects(() => verifyDelivery(bundle), /malformed delivery-manifest\.json/i);
});

test('a manifest missing its hashed file list is refused loudly', async t => {
  const bundle = await deliverFresh(t);
  await fs.writeFile(
    nodePath.join(bundle, 'delivery-manifest.json'),
    `${JSON.stringify({ format: 'viscraft-delivery-bundle', version: 1, exportedAt: '2026-10-09T00:00:00.000Z' }, null, 2)}\n`,
  );

  await assert.rejects(() => verifyDelivery(bundle), /malformed delivery-manifest\.json/i);
});

test('a missing manifest is refused loudly', async t => {
  const bundle = await deliverFresh(t);
  await fs.rm(nodePath.join(bundle, 'delivery-manifest.json'));

  await assert.rejects(() => verifyDelivery(bundle), /no delivery-manifest\.json/i);
});
