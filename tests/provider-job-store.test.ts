/**
 * Contract for the shared provider execution boundary (`job-store.ts`): the
 * atomic job-record store, validated loading, the stamped state transition, and
 * the exclusive per-attempt lock that refuses concurrent generation of the same
 * attempt. Vendor wording/error classes are bound by the caller, so this test
 * also pins that the vendor label is preserved verbatim.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import {
  acquireAttemptLock,
  loadJobRecord,
  patchJobRecord,
  saveJobRecord,
} from '../src/backends/providers/job-store.js';
import { resolveProjectPath } from '../src/shared/fs.js';

class TestProviderError extends Error {}
const conflict = (message: string) => new TestProviderError(message);

const schema = z
  .object({ attempt: z.string(), state: z.enum(['pending', 'succeeded']), updatedAt: z.string() })
  .strict();
type Record_ = z.infer<typeof schema>;

test('job records round-trip atomically, load through the schema, and reject corruption', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-job-store-'));
  try {
    const jobFile = await resolveProjectPath(root, '.viscraft/jobs/runway/attempt-1.json');
    await saveJobRecord(jobFile, { attempt: 'attempt-1', state: 'pending', updatedAt: '2026-01-01T00:00:00.000Z' });
    const loaded = await loadJobRecord(jobFile, schema, 'Runway adapter', conflict);
    assert.deepEqual(loaded, { attempt: 'attempt-1', state: 'pending', updatedAt: '2026-01-01T00:00:00.000Z' });

    // Absent record is null, not an error.
    assert.equal(
      await loadJobRecord(join(root, '.viscraft/jobs/runway/missing.json'), schema, 'Runway adapter', conflict),
      null,
    );

    // Corrupt JSON is a hard, vendor-labelled error.
    await writeFile(jobFile, '{not json');
    await assert.rejects(
      () => loadJobRecord(jobFile, schema, 'Runway adapter', conflict),
      (error: Error) =>
        error instanceof TestProviderError && /Runway adapter: job record is not valid JSON/.test(error.message),
    );

    // Schema-invalid record is a hard error too.
    await writeFile(jobFile, JSON.stringify({ attempt: 'attempt-1', state: 'bogus', updatedAt: 'x' }));
    await assert.rejects(
      () => loadJobRecord(jobFile, schema, 'Runway adapter', conflict),
      (error: Error) =>
        error instanceof TestProviderError && /Runway adapter: job record failed validation/.test(error.message),
    );

    // The state transition merges changes and re-stamps updatedAt.
    const next = patchJobRecord<Record_>(
      { attempt: 'attempt-1', state: 'pending', updatedAt: 'old' },
      { state: 'succeeded' },
      'new',
    );
    assert.deepEqual(next, { attempt: 'attempt-1', state: 'succeeded', updatedAt: 'new' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the per-attempt lock refuses concurrent generation and is released in a finally', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-lock-'));
  try {
    const opts = {
      rootAbs: root,
      stem: 'attempt-9',
      attempt: 'attempt-9',
      dirRel: '.viscraft/jobs/fal',
      label: 'fal adapter',
      conflict,
    };
    const release = await acquireAttemptLock(opts);
    const lockAbs = await resolveProjectPath(root, '.viscraft/jobs/fal/attempt-9.lock');
    assert.match(await readFile(lockAbs, 'utf8'), new RegExp(`^${process.pid} `));

    // A second acquisition for the same attempt is refused with vendor wording.
    await assert.rejects(
      () => acquireAttemptLock(opts),
      (error: Error) =>
        error instanceof TestProviderError &&
        error.message ===
          "fal adapter: attempt 'attempt-9' is already being generated (lock present); refusing to run concurrently. Remove .viscraft/jobs/fal/attempt-9.lock only if you are certain no run is active.",
    );

    await release();
    await assert.rejects(() => readFile(lockAbs, 'utf8'), /ENOENT/);
    const again = await acquireAttemptLock(opts);
    await again();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
