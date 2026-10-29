/**
 * Cache-granularity contract for the Build implementation fingerprint.
 *
 * An operation's cache key must depend on the backend modules that operation
 * ACTUALLY reaches — its capture/provider module(s), the media functions it
 * executes, and their transitive dependencies —
 * plus the scheduler module itself, and NEVER on unrelated modules such as the
 * CLI, the public entry, or the analysis/delivery operations.
 *
 * This test operates on independent copies of the real compiled runtime so it
 * pins the actual shipped closure map, not a synthetic fixture. It deliberately
 * checks both directions: a shared encoder change must invalidate its consumers,
 * while an audio-mixer change must leave independent picture Takes reusable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { operationImplementation } from '../src/build/build.js';

const RUNTIME = fileURLToPath(new URL('../src', import.meta.url));

async function appendComment(path: string): Promise<void> {
  await writeFile(path, (await readFile(path, 'utf8')) + '\n// granularity probe\n');
}

test('operation fingerprints cover the real execution closure, not just the capture module', async () => {
  const base = await mkdtemp(join(tmpdir(), 'viscraft-fingerprint-'));
  const cliCopy = join(base, 'cli');
  const mediaCopy = join(base, 'media');
  const mixCopy = join(base, 'mix');
  const captureCopy = join(base, 'capture');
  const schedulerCopy = join(base, 'scheduler');
  try {
    for (const dir of [cliCopy, mediaCopy, mixCopy, captureCopy, schedulerCopy])
      await cp(RUNTIME, dir, { recursive: true });

    // Editing only the CLI must not change ANY operation's implementation identity.
    await appendComment(join(cliCopy, 'cli.js'));
    assert.equal(
      await operationImplementation(cliCopy, 'compose-video', []),
      await operationImplementation(RUNTIME, 'compose-video', []),
      'a CLI-only change must not move the compose-video fingerprint',
    );
    assert.equal(
      await operationImplementation(cliCopy, 'browser', []),
      await operationImplementation(RUNTIME, 'browser', []),
      'a CLI-only change must not move the browser fingerprint',
    );

    // A media/encoder change must move EVERY operation that encodes through it,
    // including the Source `browser` operation (capture + encodeFrames).
    await appendComment(join(mediaCopy, 'backends', 'media', 'ffmpeg.js'));
    for (const kind of ['browser', 'compose-video', 'mix-audio', 'retime-clip', 'overlay-subtitles']) {
      assert.notEqual(
        await operationImplementation(mediaCopy, kind, []),
        await operationImplementation(RUNTIME, kind, []),
        `changing the media backend must move the ${kind} fingerprint`,
      );
    }

    // An arrangement-only implementation change invalidates mixes and stems,
    // while picture capture, composition, provider Takes and mastering stay reusable.
    await appendComment(join(mixCopy, 'backends', 'media', 'audio-mix.js'));
    for (const kind of ['mix-audio', 'mix-stem']) {
      assert.notEqual(
        await operationImplementation(mixCopy, kind, []),
        await operationImplementation(RUNTIME, kind, []),
        `an audio-mixer change must move the ${kind} fingerprint`,
      );
    }
    for (const kind of ['browser', 'compose-video', 'provider', 'master-audio']) {
      const scope = kind === 'provider' ? { protocol: 'runway-v1' } : undefined;
      assert.equal(
        await operationImplementation(mixCopy, kind, [], scope),
        await operationImplementation(RUNTIME, kind, [], scope),
        `an audio-mixer change must not invalidate the independent ${kind} operation`,
      );
    }

    // A capture change moves the browser executor's own fingerprint (its closure
    // imports the capture module) but NOT a pure media operation.
    await appendComment(join(captureCopy, 'backends', 'browser', 'capture.js'));
    assert.notEqual(
      await operationImplementation(captureCopy, 'browser', []),
      await operationImplementation(RUNTIME, 'browser', []),
      'a capture change must move the browser fingerprint',
    );
    assert.equal(
      await operationImplementation(captureCopy, 'compose-video', []),
      await operationImplementation(RUNTIME, 'compose-video', []),
      'capture is not a media dependency, so compose-video must be unchanged',
    );

    // The scheduler's own work callbacks shape every operation, so its bytes are
    // part of every key (handled without collapsing the closure to the runtime).
    await appendComment(join(schedulerCopy, 'build', 'build.js'));
    for (const kind of ['browser', 'compose-video', 'mix-audio']) {
      assert.notEqual(
        await operationImplementation(schedulerCopy, kind, []),
        await operationImplementation(RUNTIME, kind, []),
        `a scheduler change must move the ${kind} fingerprint`,
      );
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
