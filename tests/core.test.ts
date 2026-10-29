import { createSymlinkFixture } from './fs-fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { framesToSamples, ptsToFrames } from '../src/core/time.js';
import { resolveProjectPath } from '../src/shared/fs.js';
import { stableHash } from '../src/shared/hash.js';
import { redact } from '../src/shared/process.js';
import { RelativePath, type Project } from '../src/core/schema.js';
import { acquireLock, validateProject } from '../src/project/project.js';
import { hostname } from 'node:os';

test('shared rational clock quantizes half upward and preserves long boundaries', () => {
  assert.equal(framesToSamples(1, { numerator: 2, denominator: 1 }, 1), 1);
  assert.equal(framesToSamples(1, { numerator: 2, denominator: 1 }, 1, 'floor'), 0);
  assert.equal(framesToSamples(30000, { numerator: 30000, denominator: 1001 }, 48000), 48_048_000);
  assert.equal(framesToSamples(1, { numerator: 30000, denominator: 1001 }, 48000, 'ceil'), 1602);
  assert.throws(() => framesToSamples(Number.MAX_SAFE_INTEGER, { numerator: 1, denominator: 1 }, 48000));
});
test('source PTS mapping subtracts a shared origin and rounds rational boundaries half up', () => {
  assert.equal(ptsToFrames('105', '100', { numerator: 1, denominator: 300 }, { numerator: 30, denominator: 1 }), 1);
  assert.equal(
    ptsToFrames('90090000', '0', { numerator: 1, denominator: 90000 }, { numerator: 30000, denominator: 1001 }),
    30000,
  );
  assert.equal(ptsToFrames('-95', '-100', { numerator: 1, denominator: 300 }, { numerator: 30, denominator: 1 }), 1);
  assert.throws(
    () => ptsToFrames('9', '10', { numerator: 1, denominator: 30 }, { numerator: 30, denominator: 1 }),
    /precedes/,
  );
  assert.throws(
    () => ptsToFrames('0.5', '0', { numerator: 1, denominator: 30 }, { numerator: 30, denominator: 1 }),
    /integer/,
  );
});
test('project paths reject traversal and symlinks even within root', async t => {
  for (const value of [
    '/etc/passwd',
    '../file',
    'a/../file',
    'a\\file',
    'a//b',
    'a/./b',
    'a\0b',
    'C:/private',
    'D:private',
  ])
    assert.equal(RelativePath.safeParse(value).success, false);
  const root = await mkdtemp(path.join(os.tmpdir(), 'viscraft-path-'));
  try {
    await mkdir(path.join(root, 'safe'));
    await writeFile(path.join(root, 'safe', 'file'), 'ok');
    await createSymlinkFixture(t, path.join(root, 'safe'), path.join(root, 'link'));
    await assert.rejects(resolveProjectPath(root, 'link/file'), /Symbolic/);
    assert.equal(await resolveProjectPath(root, 'safe/file'), path.join(root, 'safe/file'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('project locks reject live writers and recover a confirmed dead local writer', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'viscraft-lock-'));
  try {
    const release = await acquireLock(root, 'build');
    await assert.rejects(acquireLock(root, 'build'), /locked by PID/);
    await release();
    await writeFile(
      path.join(root, '.viscraft', 'build.lock'),
      JSON.stringify({ pid: 2147483647, host: hostname(), token: 'old' }),
    );
    const recovered = await acquireLock(root, 'build');
    await recovered();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('stable content hash and diagnostic redaction', () => {
  assert.equal(stableHash({ b: 2, a: 1 }), stableHash({ a: 1, b: 2 }));
  const output = redact('Bearer top-secret api_key=another-secret https://example.invalid/?token=private');
  assert.ok(!output.includes('top-secret') && !output.includes('another-secret') && !output.includes('private'));
});
test('credential rejection leaves ordinary creative prose and parameters usable', () => {
  const project: Project = {
    schemaVersion: 1,
    id: 'credential-test',
    revision: 1,
    title: 'Bearer of Light',
    soundTargets: [],
    direction: {
      intent: 'the bearer of bad news',
      looks: [{ id: 'look', description: 'a secret garden' }],
      transitions: [],
    },
    assets: [],
    bindings: {},
    sources: [
      {
        id: 'code',
        kind: 'browser',
        output: 'picture',
        entry: 'scene.html',
        resources: [],
        bindings: [],
        params: { secret: 'a plot twist', password: 'story theme' },
        seed: 0,
        frames: 1,
      },
    ],
    composition: {
      output: { width: 32, height: 32, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene', description: '' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: '', targetFrames: 1 }],
      placements: [{ id: 'edit', shot: 'shot', source: 'code', inFrame: 0, outFrame: 1, startFrame: 0, audio: 'mute' }],
      transitions: [],
      audio: [],
    },
    imageDocuments: [],
    imageTargets: [],
  };
  assert.equal(validateProject(project).title, 'Bearer of Light');
  const bad = structuredClone(project);
  bad.direction.intent = 'Bearer abcdefghijklmnopqrstuvwxyz123456';
  assert.throws(() => validateProject(bad), /Credential/);
});
