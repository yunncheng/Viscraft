/**
 * Provider execution boundary: the job-record store and the per-attempt lock
 * shared by every generation adapter.
 *
 * This module owns the parts of provider execution that are identical across
 * vendors — atomic job-record persistence, validated record loading, the
 * monotonically stamped state transition, and the exclusive per-attempt lock
 * that refuses to generate the same attempt twice (which could otherwise
 * double-submit / double-bill). Vendor specifics (job schema, error class,
 * wording, request mapping, provider directory) stay in each adapter; they are
 * bound here by the `label`/`conflict`/`schema`/`dirRel` arguments.
 */
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ZodType } from 'zod';
import { atomicJson, resolveProjectPath } from '../../shared/fs.js';

/** ISO timestamp used for `updatedAt` and lock-owner lines. */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * The Source-scoped locator stem shared by every generation adapter's job
 * record, per-attempt lock and retained provider media. An `attempt` alone is
 * NOT unique across a project: two different Sources may each legitimately use
 * `attempt: 33`, and keying the job/lock/media by the bare attempt made the
 * second one collide with the first (refused as "the same frozen request
 * changed"). Both `sourceId` and `attempt` are Viscraft `Id`s, which cannot
 * contain a dot, so the FIRST dot is an unambiguous separator.
 */
export function attemptStem(sourceId: string, attempt: string | number): string {
  return `${sourceId}.${String(attempt)}`;
}

/** Atomically persist a job record. */
export async function saveJobRecord<T>(jobFile: string, job: T): Promise<void> {
  await atomicJson(jobFile, job);
}

/**
 * Load a job record through its vendor schema, or `null` when absent. A record
 * that exists but cannot be parsed/validated is a hard error (`conflict` builds
 * the vendor-specific error), never silently ignored.
 */
export async function loadJobRecord<T>(
  jobFile: string,
  schema: ZodType<T>,
  label: string,
  conflict: (message: string) => Error,
): Promise<T | null> {
  if (!existsSync(jobFile)) return null;
  const raw = await readFile(jobFile, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw conflict(`${label}: job record is not valid JSON`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw conflict(`${label}: job record failed validation`);
  return result.data;
}

/** Merge a state transition onto a job record and stamp `updatedAt`. */
export function patchJobRecord<T extends { updatedAt: string }>(job: T, changes: Partial<T>, updatedAt: string): T {
  return { ...job, ...changes, updatedAt };
}

/**
 * Acquire an exclusive lock for one attempt. The lock file is keyed by the
 * Source-scoped `stem` (see `attemptStem`), so two different Sources that both
 * use `attempt: 33` get independent locks. It is a `wx`-created file and is
 * removed in a `finally`; a leftover lock (hard crash) intentionally blocks
 * rather than silently proceeding. Concurrent generation of the same attempt of
 * the same Source is refused with the vendor's error wording.
 */
export async function acquireAttemptLock(options: {
  rootAbs: string;
  stem: string;
  attempt: string;
  dirRel: string;
  label: string;
  conflict: (message: string) => Error;
}): Promise<() => Promise<void>> {
  const { rootAbs, stem, attempt, dirRel, label, conflict } = options;
  const lockAbs = await resolveProjectPath(rootAbs, `${dirRel}/${stem}.lock`);
  await mkdir(dirname(lockAbs), { recursive: true });
  let handle;
  try {
    handle = await open(lockAbs, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw conflict(
        `${label}: attempt '${attempt}' is already being generated (lock present); refusing to run concurrently. Remove ${dirRel}/${stem}.lock only if you are certain no run is active.`,
      );
    }
    throw error;
  }
  await handle.writeFile(`${process.pid} ${nowIso()}\n`).catch(() => {});
  return async () => {
    await handle.close().catch(() => {});
    await rm(lockAbs, { force: true }).catch(() => {});
  };
}
