/**
 * Lock robustness for interrupted creator sessions.
 *
 * `acquireLock` (src/project/project.ts) records the holder's pid, host, start
 * time and a random token. When a creator session is killed mid-build, the lock
 * file survives with a pid that no longer exists; the next build must reclaim
 * that stale lock so the Project stays reopenable and continuable,
 * WITHOUT weakening mutual exclusion between two live writers.
 *
 * Every "dead" pid here is a genuinely spawned-then-exited process, never a
 * guessed number, so removing the dead-pid reclamation makes these tests fail
 * rather than pass vacuously.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';

import { buildProject } from '../src/build/build.js';
import { readBuilds } from '../src/project/build-records.js';
import { acquireLock } from '../src/project/project.js';
import { ProjectSchema, type Project } from '../src/core/schema.js';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'viscraft-lock-recovery-'));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fileExists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

/** A tiny simulated-source Project that builds a real, openable movie without a browser. */
function makeProject(behavior: 'success' | 'fail' = 'success'): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'lock_recovery',
    revision: 1,
    title: 'Lock recovery',
    direction: { intent: 'lock robustness', looks: [{ id: 'look', description: 'look' }], transitions: [] },
    assets: [],
    bindings: {},
    sources: [
      { id: 'src_a', kind: 'simulated', prompt: 'a', frames: 4, seed: 1, attempt: 'attempt_a', behavior },
      { id: 'src_b', kind: 'simulated', prompt: 'b', frames: 4, seed: 2, attempt: 'attempt_b', behavior: 'success' },
    ],
    composition: {
      output: { width: 64, height: 48, fps: { numerator: 25, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene', description: 'scene' }],
      shots: [
        { id: 'shot_a', scene: 'scene', look: 'look', intent: 'a', targetFrames: 4 },
        { id: 'shot_b', scene: 'scene', look: 'look', intent: 'b', targetFrames: 4 },
      ],
      placements: [
        { id: 'pl_a', shot: 'shot_a', source: 'src_a', inFrame: 0, outFrame: 4, startFrame: 0, audio: 'mute' },
        { id: 'pl_b', shot: 'shot_b', source: 'src_b', inFrame: 0, outFrame: 4, startFrame: 4, audio: 'mute' },
      ],
      transitions: [],
      audio: [],
    },
  });
}

async function writeProject(root: string, behavior: 'success' | 'fail' = 'success'): Promise<void> {
  await writeFile(join(root, 'project.json'), `${JSON.stringify(makeProject(behavior), null, 2)}\n`, 'utf8');
}

/** Spawn a real process, wait for it to exit, and confirm the kernel reports its pid gone. */
async function genuinelyDeadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid!;
  await new Promise<void>((resolve, reject) => {
    child.once('exit', () => resolve());
    child.once('error', reject);
  });
  for (let i = 0; i < 200; i++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
    await sleep(10);
  }
  throw new Error(`pid ${pid} did not become dead`);
}

/** Spawn a live holder process that acquires the lock and then blocks forever. */
async function spawnLockHolder(root: string): Promise<ChildProcess> {
  const moduleHref = new URL('../src/project/project.js', import.meta.url).href;
  const holderScript = join(root, 'lock-holder.mjs');
  await writeFile(
    holderScript,
    [
      'const { acquireLock } = await import(process.argv[2]);',
      "await acquireLock(process.argv[3], 'build');",
      "process.stdout.write('LOCKED\\n');",
      'setInterval(() => {}, 1_000);',
      '',
    ].join('\n'),
  );
  const child = spawn(process.execPath, [holderScript, moduleHref, root], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let buffer = '';
    const fail = (error: Error): void => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    child.stdout!.on('data', chunk => {
      buffer += String(chunk);
      if (!settled && buffer.includes('LOCKED')) {
        settled = true;
        resolve();
      }
    });
    child.once('error', fail);
    child.once('exit', code => fail(new Error(`lock holder exited before acquiring (code ${code})`)));
  });
  return child;
}

async function killAndReap(child: ChildProcess): Promise<number> {
  const pid = child.pid!;
  if (child.exitCode === null) {
    const ended = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGKILL');
    await ended;
  }
  for (let i = 0; i < 200; i++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
    await sleep(10);
  }
  throw new Error(`holder pid ${pid} did not become dead`);
}

test('a build reclaims a same-host lock left by a genuinely dead process and proceeds', async () => {
  const root = await tempDir();
  try {
    await writeProject(root, 'success');
    const deadPid = await genuinelyDeadPid();
    await mkdir(join(root, '.viscraft'), { recursive: true });
    await writeFile(
      join(root, '.viscraft', 'build.lock'),
      JSON.stringify({
        pid: deadPid,
        host: hostname(),
        token: 'stale-token',
        startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      }),
      { mode: 0o600 },
    );

    const record = await buildProject(root);

    assert.equal(record.status, 'succeeded', 'the build must proceed past a provably dead holder, not refuse');
    assert.ok(record.result, 'a succeeded build records a result');
    const result = JSON.parse(await readFile(join(root, '.viscraft', 'result.json'), 'utf8')) as { build: string };
    assert.equal(result.build, record.id, 'the accepted Result names the new build');
    assert.equal(
      await fileExists(join(root, '.viscraft', 'build.lock')),
      false,
      'the reclaimed lock is released after the build',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a live holder blocks a second builder, and its crash is then recoverable', async () => {
  const root = await tempDir();
  let holder: ChildProcess | undefined;
  try {
    await writeProject(root, 'success');
    holder = await spawnLockHolder(root);

    await assert.rejects(acquireLock(root, 'build'), /locked by PID/, 'a live holder blocks a direct acquire');
    await assert.rejects(buildProject(root), /locked by PID/, 'a live holder blocks a build');

    // Crash the holder without releasing: the lock now names a dead pid.
    const deadPid = await killAndReap(holder);
    holder = undefined;
    const stale = JSON.parse(await readFile(join(root, '.viscraft', 'build.lock'), 'utf8')) as { pid: number };
    assert.equal(stale.pid, deadPid, 'the crashed holder left its own identity in the lock');

    const release = await acquireLock(root, 'build');
    await release();
    assert.equal(
      await fileExists(join(root, '.viscraft', 'build.lock')),
      false,
      'a crashed live holder is reclaimed on the next acquire',
    );
  } finally {
    if (holder) await killAndReap(holder).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed build preserves the previously accepted Result', async () => {
  const root = await tempDir();
  try {
    await writeProject(root, 'success');
    const accepted = await buildProject(root);
    assert.equal(accepted.status, 'succeeded');
    const resultPath = join(root, '.viscraft', 'result.json');
    const before = await readFile(resultPath, 'utf8');
    assert.equal((JSON.parse(before) as { build: string }).build, accepted.id);

    // The same Project now has a Source that fails deterministically.
    await writeProject(root, 'fail');
    await assert.rejects(buildProject(root), /Build build-.* failed/);

    const after = await readFile(resultPath, 'utf8');
    assert.equal(after, before, 'the accepted Result bytes are unchanged after a failed build');
    assert.equal(
      (JSON.parse(after) as { build: string }).build,
      accepted.id,
      'the accepted Result still names the last successful build',
    );
    const failed = (await readBuilds(root)).find(build => build.status === 'failed');
    assert.ok(failed, 'the failed build is still recorded');
    assert.equal(failed!.result, undefined, 'a failed build records no result artifact');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a lock naming a pid reused by an unrelated live process is not stolen', async () => {
  const root = await tempDir();
  let unrelated: ChildProcess | undefined;
  try {
    await mkdir(join(root, '.viscraft'), { recursive: true });
    // A live process with no relation to Viscraft, reusing a pid an old lock may name.
    unrelated = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    await writeFile(
      join(root, '.viscraft', 'build.lock'),
      JSON.stringify({
        pid: unrelated.pid,
        host: hostname(),
        token: 'stale-token',
        startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      }),
      { mode: 0o600 },
    );

    // kill(pid, 0) succeeds, so the holder cannot be proven dead: refuse to steal.
    await assert.rejects(acquireLock(root, 'build'), /locked by PID/, 'an unprovably-dead holder must not be stolen');
  } finally {
    if (unrelated) await killAndReap(unrelated).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('a lock recorded on a different host is not reclaimed by a local pid probe', async () => {
  const root = await tempDir();
  try {
    await mkdir(join(root, '.viscraft'), { recursive: true });
    const deadPid = await genuinelyDeadPid();
    await writeFile(
      join(root, '.viscraft', 'build.lock'),
      JSON.stringify({
        pid: deadPid,
        host: 'some-other-host',
        token: 'remote-token',
        startedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );

    await assert.rejects(acquireLock(root, 'build'), /locked by PID/, 'a remote host cannot be proven dead locally');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unreadable lock is refused instead of guessed', async () => {
  const root = await tempDir();
  try {
    await mkdir(join(root, '.viscraft'), { recursive: true });
    await writeFile(join(root, '.viscraft', 'build.lock'), '{ this is not json', { mode: 0o600 });

    await assert.rejects(
      acquireLock(root, 'build'),
      /unreadable/,
      'an unreadable lock must be inspected, not overwritten',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
