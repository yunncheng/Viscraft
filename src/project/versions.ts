/**
 * versions: `versions`, `keep`/`unkeep` and `revert` (with checkpoint,
 * `--resume` and `--abort`).
 *
 * A version is a succeeded, non-preview Build. Its frozen author state is the
 * Build snapshot (`.viscraft/snapshots/<id>.project.json` + `<id>.inputs.json`
 * + the frozen files, which the content store stores once in `.viscraft/content/`). `keep`
 * writes the minimal `retained` decision on the Build record; it never turns a
 * result into an Asset or edits `project.json`.
 *
 * `revert` puts the AUTHOR STATE back to a version's snapshot. Replacing files
 * one by one is not atomic for the whole Project, so it runs
 * validate → checkpoint → stage → record → apply (project.json last) and keeps a
 * progress record that `--resume`/`--abort` act on after an interruption. It
 * never touches execution records, artifacts or `result.json`, and it never
 * deletes an author file that the target does not list (`untouched`).
 */
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { BuildRecordSchema, type BuildRecord, type Project } from '../core/schema.js';
import { atomicJson, resolveProjectPath } from '../shared/fs.js';
import { hashFile } from '../shared/hash.js';
import { providerJobStatus } from '../backends/providers/status.js';
import { readBuilds } from './build-records.js';
import { imageRenderIdentity, type ImageRenderIdentity } from '../build/image.js';
import { compareImageEnvironment } from '../build/image-identity.js';
import { artifactAvailable, readCheckpointIds } from './closure.js';
import { contentPath, freezeFile } from './content-store.js';
import { diffProjects, type ProjectDiff } from './diff.js';
import { acquireLock, loadProject, validateProject } from './project.js';
import {
  authorState,
  contentHashOf,
  snapshotHashOf,
  soundTargetFacts,
  readFrozenSnapshot,
  type FrozenSnapshot,
} from './state.js';
import { type AuthoredGap } from './author-inputs.js';
import { REVERT_DIR, readRevertRecords, incompleteRevert, type RevertRecord } from './revert-journal.js';

export const CheckpointSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^checkpoint-[a-zA-Z0-9_-]+$/),
    at: z.string(),
    reason: z.literal('before-revert'),
    snapshotHash: z.string(),
    contentHash: z.string(),
  })
  .strict();
export type Checkpoint = z.infer<typeof CheckpointSchema>;

const CHECKPOINT_DIR = '.viscraft/checkpoints';

type ChangeCounts = ProjectDiff['counts'];

export interface VersionEntry {
  id: string;
  /**
   * What this Build produced: `picture` for the timeline film or a still, `sound`
   * for a sound target's programme. A sound version is a real version even though
   * it never writes the film's `result.json` pointer.
   */
  medium: 'picture' | 'sound';
  /** Image or sound target id; `null` for a film (timeline) version. */
  target: string | null;
  finishedAt: string | null;
  revision: number;
  result: {
    path: string;
    sha256: string;
    frames: number | null;
    simulated: boolean;
    available: boolean;
    /** Archive sha256 when the media bytes were released by `clean --release-archived`. */
    archived: string | null;
    /** A sound programme's real sample facts; `null` for picture results. */
    audio: { samples: number; sampleRate: number; channels: number } | null;
  } | null;
  /**
   * Recorded Build mark (film), a still target's CURRENT render key differing, or
   * a sound programme superseded by a newer succeeded programme of its target.
   */
  stale: boolean;
  /** The film active result, the newest image version whose key matches, or the newest sound programme per target. */
  current: boolean;
  retained: { at: string; note?: string } | null;
  /**
   * The frozen author state's own completeness. `complete` is false when the
   * snapshot RECORDED a gap at freeze time; `restorable` is false when a listed
   * frozen file's bytes are now missing/corrupt. They are independent: a partial
   * version is never reported as complete, and damage is never called a gap.
   */
  snapshot: { complete: boolean; restorable: boolean; gaps: AuthoredGap[] } | null;
  /** Change counts against the next-older version of the SAME target; null when there is none or its snapshot is unreadable. */
  changesFromPrevious: ChangeCounts | null;
}

export interface VersionList {
  versions: VersionEntry[];
  /** `--all`: failed and preview Build summaries and checkpoints. */
  other?: {
    failed: Array<{ id: string; startedAt: string; error: string | null }>;
    previews: Array<{ id: string; status: string; frames: [number, number]; scale: number }>;
    checkpoints: Checkpoint[];
  };
}

async function readActiveBuild(root: string): Promise<string | null> {
  try {
    const value = JSON.parse(await readFile(await resolveProjectPath(root, '.viscraft/result.json'), 'utf8')) as {
      build?: unknown;
    };
    return typeof value.build === 'string' ? value.build : null;
  } catch {
    return null;
  }
}

async function readCheckpoint(root: string, id: string): Promise<Checkpoint> {
  return CheckpointSchema.parse(
    JSON.parse(await readFile(await resolveProjectPath(root, `${CHECKPOINT_DIR}/${id}.json`), 'utf8')),
  );
}

const isVersion = (build: BuildRecord): boolean => build.status === 'succeeded' && !build.preview && !!build.result;

/** True when every LISTED frozen file is still present and hash-valid. */
async function snapshotRestorable(root: string, id: string, files: Record<string, string>): Promise<boolean> {
  for (const [relative, sha256] of Object.entries(files))
    try {
      await frozenBytes(root, id, relative, sha256);
    } catch {
      return false;
    }
  return true;
}

export async function listVersions(root: string, options: { all?: boolean } = {}): Promise<VersionList> {
  const builds = await readBuilds(root);
  // The CURRENT author state, so a sound programme can be compared against the
  // facts it would be rebuilt from. Unreadable project/author state leaves it
  // unproven (no version is claimed current), never guessed.
  let currentFacts: { project: Project; files: Record<string, string> } | null = null;
  try {
    const currentProject = await loadProject(root);
    currentFacts = {
      project: currentProject,
      files: Object.fromEntries((await authorState(root, currentProject)).files),
    };
  } catch {
    currentFacts = null;
  }
  const active = await readActiveBuild(root);
  const versions = builds.filter(isVersion);
  const frozen = new Map<string, FrozenSnapshot | null>();
  for (const build of versions)
    frozen.set(build.id, await readFrozenSnapshot(root, build.id, build.snapshotHash).catch(() => null));
  // A still target's "current" version is the one `renderImage` would REUSE: the
  // recorded operation key still equals the key the CURRENT author bytes produce
  // AND the recorded environment still matches the machine observed now (the same
  // `compareImageEnvironment` verdict the renderer uses). A matching key alone is
  // never enough: a changed browser/runtime means the bytes cannot be shown to be
  // current. It never relies on the film's `result.json`.
  const imageIdentities = new Map<string, Promise<ImageRenderIdentity | null>>();
  const currentImageIdentity = (target: string): Promise<ImageRenderIdentity | null> => {
    let identity = imageIdentities.get(target);
    if (!identity) {
      identity = imageRenderIdentity(root, target).catch(() => null);
      imageIdentities.set(target, identity);
    }
    return identity;
  };
  const claimedTargets = new Set<string>();
  const entries: VersionEntry[] = [];
  for (const [index, build] of versions.entries()) {
    const artifact = build.artifacts.find(candidate => candidate.id === build.result!.artifact);
    // Compare changes against the previous version of the SAME target: an image
    // version and a film version describe different outputs, so their
    // structural diff is not a change to either one.
    const older = versions.slice(index + 1).find(candidate => (candidate.target ?? null) === (build.target ?? null));
    const mine = frozen.get(build.id);
    const theirs = older ? frozen.get(older.id) : undefined;
    // A sound programme's real span/rate/channels come from the sound target AS
    // FROZEN with this Build (a WAV artifact records no picture media and the mix
    // has no Take), never from a picture frame count or from today's target edit.
    const frozenTarget =
      build.medium === 'sound' && build.target !== undefined
        ? mine?.project.soundTargets.find(candidate => candidate.id === build.target)
        : undefined;
    const audio = frozenTarget
      ? {
          samples: frozenTarget.outputSamples,
          sampleRate: frozenTarget.sampleRate,
          channels: frozenTarget.channels,
        }
      : null;
    let stale = build.stale ?? false;
    let current = build.id === active;
    if (build.medium === 'sound') {
      // A programme never owns the film's active-result pointer. It is current
      // only when it is the newest succeeded programme of its target AND the
      // authored facts it was built from (target + Sources + their bytes + audio
      // Assets) still equal the CURRENT author state; an edited Source/target
      // makes every older programme stale instead of silently current.
      if (build.target === undefined) throw new Error(`Build ${build.id} is a sound Build with no target`);
      const frozenFacts = mine ? soundTargetFacts(mine.project, build.target, mine.files) : null;
      const nowFacts = currentFacts ? soundTargetFacts(currentFacts.project, build.target, currentFacts.files) : null;
      const claim = `sound:${build.target}`;
      const isNewest = !claimedTargets.has(claim);
      if (isNewest) claimedTargets.add(claim);
      current = isNewest && frozenFacts !== null && nowFacts !== null && frozenFacts === nowFacts;
      stale = !current;
    } else if (build.target !== undefined) {
      const identity = await currentImageIdentity(build.target);
      const operation = build.operations.find(candidate => candidate.kind === 'render-image');
      const environmentMatch =
        identity !== null &&
        compareImageEnvironment(build.environment, {
          facts: identity.environment,
          verified: identity.environmentVerified,
        }) === 'match';
      stale = identity === null || operation?.key !== identity.key || !environmentMatch;
      const claim = `image:${build.target}`;
      current = !stale && !claimedTargets.has(claim);
      if (current) claimedTargets.add(claim);
    }
    entries.push({
      id: build.id,
      medium: build.medium,
      target: build.target ?? null,
      finishedAt: build.finishedAt ?? null,
      revision: build.revision,
      result: artifact
        ? {
            path: artifact.path,
            sha256: artifact.sha256,
            frames: artifact.media?.frames ?? null,
            simulated: artifact.simulated,
            available: await artifactAvailable(root, artifact),
            archived: artifact.archived?.archive ?? null,
            audio,
          }
        : null,
      stale,
      current,
      retained: build.retained ?? null,
      snapshot: mine
        ? {
            complete: mine.unavailable.length === 0,
            restorable: await snapshotRestorable(root, build.id, mine.files),
            gaps: mine.unavailable,
          }
        : null,
      changesFromPrevious:
        mine && theirs ? diffProjects(theirs.project, mine.project, theirs.files, mine.files).counts : null,
    });
  }
  if (!options.all) return { versions: entries };
  const checkpoints: Checkpoint[] = [];
  for (const id of await readCheckpointIds(root)) checkpoints.push(await readCheckpoint(root, id));
  return {
    versions: entries,
    other: {
      failed: builds
        .filter(build => build.status === 'failed' && !build.preview)
        .map(build => ({ id: build.id, startedAt: build.startedAt, error: build.error ?? null })),
      previews: builds
        .filter(build => build.preview)
        .map(build => ({
          id: build.id,
          status: build.status,
          frames: build.preview!.frames,
          scale: build.preview!.scale,
        })),
      checkpoints,
    },
  };
}

async function setRetained(root: string, buildId: string, retained: BuildRecord['retained'] | undefined) {
  if (!/^build-[a-zA-Z0-9_-]+$/.test(buildId)) throw new Error(`Not a Build id: ${buildId}`);
  const release = await acquireLock(root, 'build');
  try {
    const file = await resolveProjectPath(root, `.viscraft/builds/${buildId}.json`);
    let record: BuildRecord;
    try {
      record = BuildRecordSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`No Build record ${buildId}`);
      throw error;
    }
    if (!isVersion(record)) throw new Error(`Build ${buildId} is not a succeeded, non-preview version`);
    const { retained: _previous, ...rest } = record;
    const next: BuildRecord = retained ? { ...rest, retained } : rest;
    await atomicJson(file, BuildRecordSchema.parse(next));
    return next;
  } finally {
    await release();
  }
}

/** Mark a version as user-approved: it, all its Takes and their closure stay protected. */
export async function keepVersion(root: string, buildId: string, note?: string): Promise<BuildRecord> {
  return setRetained(root, buildId, { at: new Date().toISOString(), ...(note !== undefined ? { note } : {}) });
}

export async function unkeepVersion(root: string, buildId: string): Promise<BuildRecord> {
  return setRetained(root, buildId, undefined);
}

// ---------------------------------------------------------------------------
// revert
// ---------------------------------------------------------------------------

/**
 * Test seam: called before each file is applied. Throwing simulates a failure
 * mid-apply (rolled back); an error carrying `simulatedInterrupt: true`
 * simulates the process dying (the record stays `applying`).
 */
let applyHook: ((relative: string) => Promise<void> | void) | undefined;
export function setRevertApplyHookForTest(hook?: (relative: string) => Promise<void> | void): void {
  applyHook = hook;
}

/** Hash a file, or null when it does not exist. */
async function hashOrNull(file: string): Promise<string | null> {
  try {
    return await hashFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Where a frozen file's bytes are: the snapshot path, else its content-store entry. */
async function frozenBytes(root: string, snapshotId: string, relative: string, sha256: string): Promise<string> {
  for (const candidate of [`.viscraft/snapshots/${snapshotId}/${relative}`, contentPath(sha256)]) {
    const abs = await resolveProjectPath(root, candidate);
    if ((await hashOrNull(abs)) === sha256) return abs;
  }
  throw new Error(`Snapshot ${snapshotId} is missing the frozen bytes of ${relative}`);
}

/** Copy frozen (read-only) bytes to an ordinary writable file and verify them. */
async function stageCopy(source: string, destination: string, sha256: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, 0o644);
  if ((await hashFile(destination)) !== sha256) throw new Error(`Staged bytes do not match for ${destination}`);
}

/**
 * Refuse a write that must not interleave with other unfinished work: an
 * interrupted revert, an interrupted cleanup (unless the caller is resuming it)
 * or a provider job whose submission outcome is unresolved.
 */
export async function assertNoOpenWork(root: string, options: { allowCleanup?: boolean } = {}): Promise<void> {
  const open = await incompleteRevert(root);
  if (open)
    throw new Error(
      `Revert ${open.id} is incomplete; run \`viscraft revert <project> --resume\` or \`--abort\` before any other write`,
    );
  try {
    const names = await readdir(await resolveProjectPath(root, '.viscraft/cleanups'));
    for (const name of names.filter(n => n.endsWith('.json'))) {
      const record = JSON.parse(
        await readFile(await resolveProjectPath(root, `.viscraft/cleanups/${name}`), 'utf8'),
      ) as { status?: string };
      if (record.status === 'in-progress' && !options.allowCleanup)
        throw new Error('A cleanup is incomplete; run `viscraft clean <project> --resume` or `--abort` first');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const unresolved = (await providerJobStatus(root)).filter(job => {
    const state = (job as { state?: string } | null)?.state;
    return state === 'submitting' || state === 'submit-unknown';
  });
  if (unresolved.length > 0)
    throw new Error(`${unresolved.length} provider job(s) have an unresolved submission; resolve them first`);
}

export async function withWriteLocks<T>(root: string, work: () => Promise<T>): Promise<T> {
  const releaseBuild = await acquireLock(root, 'build');
  let releaseAuthor: (() => Promise<void>) | undefined;
  try {
    releaseAuthor = await acquireLock(root, 'author');
    return await work();
  } finally {
    try {
      if (releaseAuthor) await releaseAuthor();
    } finally {
      await releaseBuild();
    }
  }
}

/** Freeze the CURRENT author state as a checkpoint (or reuse an identical Build/checkpoint). */
async function checkpointCurrent(
  root: string,
  project: Project,
  files: Map<string, string>,
  unavailable: AuthoredGap[],
): Promise<string> {
  const snapshotHash = snapshotHashOf(project, Object.fromEntries(files), unavailable);
  const rawProject = await resolveProjectPath(root, 'project.json');
  const rawSha = await hashFile(rawProject);
  // Reuse only an EXACT match (revision included) whose raw project.json bytes
  // can be restored verbatim: a checkpoint written earlier for this same state.
  for (const id of await readCheckpointIds(root)) {
    const checkpoint = await readCheckpoint(root, id);
    if (checkpoint.snapshotHash !== snapshotHash) continue;
    const frozenProject = await resolveProjectPath(root, `.viscraft/snapshots/${id}.project.json`);
    if ((await hashOrNull(frozenProject)) === rawSha) return id;
  }
  const id = `checkpoint-${randomUUID()}`;
  const snapshot = await resolveProjectPath(root, `.viscraft/snapshots/${id}`);
  await mkdir(snapshot, { recursive: true });
  const verified = new Set<string>();
  for (const [relative, sha256] of files) {
    const digest = await freezeFile(root, snapshot, relative, verified);
    if (digest !== sha256) throw new Error(`Author file ${relative} changed while checkpointing; retry`);
  }
  // The raw project.json bytes, so `--abort` restores them verbatim.
  const frozenProject = await resolveProjectPath(root, `.viscraft/snapshots/${id}.project.json`);
  await copyFile(rawProject, frozenProject);
  if ((await hashFile(frozenProject)) !== rawSha) throw new Error('project.json changed while checkpointing; retry');
  await atomicJson(await resolveProjectPath(root, `.viscraft/snapshots/${id}.inputs.json`), {
    files: Object.fromEntries(files),
    unavailable,
  });
  const checkpoint: Checkpoint = {
    schemaVersion: 1,
    id,
    at: new Date().toISOString(),
    reason: 'before-revert',
    snapshotHash,
    contentHash: contentHashOf(project, Object.fromEntries(files), unavailable),
  };
  await atomicJson(await resolveProjectPath(root, `${CHECKPOINT_DIR}/${id}.json`), checkpoint);
  return id;
}

export interface RevertResult {
  revert: string;
  target: string;
  checkpoint: string;
  written: string[];
  untouched: string[];
  revision: number;
  changes: ProjectDiff;
  /** False when the target snapshot recorded freeze-time gaps (a partial version). */
  snapshotComplete: boolean;
  /** The target's recorded gaps, so a caller never presents it as whole. */
  gaps: AuthoredGap[];
}

async function applyRecord(root: string, record: RevertRecord): Promise<void> {
  const recordFile = await resolveProjectPath(root, `${REVERT_DIR}/${record.id}.json`);
  const staging = `${REVERT_DIR}/${record.id}`;
  for (const file of record.files) {
    if (file.applied) continue;
    const destination = await resolveProjectPath(root, file.path);
    const staged = await resolveProjectPath(root, `${staging}/files/${file.path}`);
    const stagedHash = await hashOrNull(staged);
    if (stagedHash === null && (await hashOrNull(destination)) === file.sha256) {
      // Renamed before an interruption, but not yet marked.
    } else {
      if (stagedHash !== file.sha256) throw new Error(`Staged bytes for ${file.path} are missing or damaged`);
      await applyHook?.(file.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await rename(staged, destination);
    }
    file.applied = true;
    await atomicJson(recordFile, record);
  }
  if (!record.project.applied) {
    const destination = await resolveProjectPath(root, 'project.json');
    const staged = await resolveProjectPath(root, `${staging}/project.json`);
    const stagedHash = await hashOrNull(staged);
    if (!(stagedHash === null && (await hashOrNull(destination)) === record.project.sha256)) {
      if (stagedHash !== record.project.sha256) throw new Error('Staged project.json is missing or damaged');
      await applyHook?.('project.json');
      await rename(staged, destination);
    }
    record.project.applied = true;
  }
  record.status = 'complete';
  await atomicJson(recordFile, record);
  await rm(await resolveProjectPath(root, staging), { recursive: true, force: true });
}

/** Put every file the record may have written back to its checkpoint bytes. */
async function restoreCheckpoint(root: string, record: RevertRecord, status: 'rolled-back' | 'aborted') {
  const recordFile = await resolveProjectPath(root, `${REVERT_DIR}/${record.id}.json`);
  const checkpointMeta = await readCheckpoint(root, record.checkpoint);
  const checkpoint = await readFrozenSnapshot(root, record.checkpoint, checkpointMeta.snapshotHash);
  for (const file of record.files) {
    const destination = await resolveProjectPath(root, file.path);
    const current = await hashOrNull(destination);
    if (!file.applied && current !== file.sha256) continue;
    const original = checkpoint.files[file.path];
    if (original === undefined || !file.existed) {
      if (current !== null) await unlink(destination);
    } else if (current !== original) {
      const temporary = `${destination}.${randomUUID()}.tmp`;
      await stageCopy(await frozenBytes(root, record.checkpoint, file.path, original), temporary, original);
      await rename(temporary, destination);
    }
    file.applied = false;
  }
  const projectFile = await resolveProjectPath(root, 'project.json');
  const frozenProject = await resolveProjectPath(root, `.viscraft/snapshots/${record.checkpoint}.project.json`);
  const originalSha = await hashFile(frozenProject);
  if ((await hashOrNull(projectFile)) !== originalSha) {
    const temporary = `${projectFile}.${randomUUID()}.tmp`;
    await stageCopy(frozenProject, temporary, originalSha);
    await rename(temporary, projectFile);
  }
  record.project.applied = false;
  record.status = status;
  await atomicJson(recordFile, record);
  await rm(await resolveProjectPath(root, `${REVERT_DIR}/${record.id}`), { recursive: true, force: true });
}

/** Revert the author state to a version (Build id) or a checkpoint id. */
export async function revertProject(root: string, target: string): Promise<RevertResult> {
  if (!/^(build|checkpoint)-[a-zA-Z0-9_-]+$/.test(target)) throw new Error(`Not a Build or checkpoint id: ${target}`);
  return withWriteLocks(root, async () => {
    await assertNoOpenWork(root);
    if (target.startsWith('build-')) {
      const build = (await readBuilds(root)).find(candidate => candidate.id === target);
      if (!build || !isVersion(build)) throw new Error(`Build ${target} is not a succeeded, non-preview version`);
    } else await readCheckpoint(root, target);

    // 1. Validate the WHOLE target before touching anything.
    const recorded = target.startsWith('build-')
      ? (await readBuilds(root)).find(candidate => candidate.id === target)!.snapshotHash
      : (await readCheckpoint(root, target)).snapshotHash;
    const frozen = await readFrozenSnapshot(root, target, recorded);
    const sources = new Map<string, string>();
    for (const [relative, sha256] of Object.entries(frozen.files))
      sources.set(relative, await frozenBytes(root, target, relative, sha256));

    // 2. Checkpoint the current author state — plus any existing file the
    // target would overwrite that is outside the current closure, so a
    // rollback/abort can restore it rather than delete it.
    const current = await loadProject(root);
    const state = await authorState(root, current);
    // An unreadable current file that the target would overwrite cannot be
    // protected by the checkpoint; refuse with ZERO author writes.
    for (const gap of state.unavailable)
      if (gap.reason === 'unreadable' && Object.prototype.hasOwnProperty.call(frozen.files, gap.path))
        throw new Error(
          `Revert to ${target} cannot protect the current unreadable authored file ${gap.path}; no author file was written`,
        );
    const preserved = new Map(state.files);
    for (const relative of Object.keys(frozen.files)) {
      if (preserved.has(relative)) continue;
      const existing = await hashOrNull(await resolveProjectPath(root, relative));
      if (existing !== null) preserved.set(relative, existing);
    }
    const checkpoint = await checkpointCurrent(root, current, preserved, state.unavailable);

    // 3. Stage every file that differs, and the new project.json.
    const id = `revert-${randomUUID()}`;
    const staging = `${REVERT_DIR}/${id}`;
    const files: RevertRecord['files'] = [];
    for (const [relative, sha256] of Object.entries(frozen.files)) {
      const destination = await resolveProjectPath(root, relative);
      const existing = await hashOrNull(destination);
      if (existing === sha256) continue;
      await stageCopy(sources.get(relative)!, await resolveProjectPath(root, `${staging}/files/${relative}`), sha256);
      files.push({ path: relative, sha256, existed: existing !== null, applied: false });
    }
    const next = validateProject({ ...frozen.project, revision: current.revision + 1 });
    const stagedProject = await resolveProjectPath(root, `${staging}/project.json`);
    await atomicJson(stagedProject, next);
    const record: RevertRecord = {
      schemaVersion: 1,
      id,
      target,
      checkpoint,
      files,
      project: { sha256: await hashFile(stagedProject), applied: false },
      status: 'applying',
    };
    // 4. Record, then 5. apply (project.json last); roll back on any failure.
    await atomicJson(await resolveProjectPath(root, `${REVERT_DIR}/${id}.json`), record);
    try {
      await applyRecord(root, record);
    } catch (error) {
      // Test seam: a simulated process death leaves the record `applying`.
      if ((error as { simulatedInterrupt?: boolean }).simulatedInterrupt) throw error;
      await restoreCheckpoint(root, record, 'rolled-back');
      throw new Error(
        `Revert to ${target} failed and was rolled back to ${checkpoint}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const untouched = [...state.files.keys()].filter(relative => !(relative in frozen.files)).sort();
    return {
      revert: id,
      target,
      checkpoint,
      written: files.map(file => file.path),
      untouched,
      revision: next.revision,
      changes: diffProjects(current, next, Object.fromEntries(state.files), frozen.files),
      snapshotComplete: frozen.unavailable.length === 0,
      gaps: frozen.unavailable,
    };
  });
}

async function openRecord(root: string): Promise<RevertRecord> {
  const open = (await readRevertRecords(root)).find(record => record.status === 'applying');
  if (!open) throw new Error('No incomplete revert to resume or abort');
  return open;
}

/** Continue an interrupted revert from its on-disk record (hashes re-checked). */
export async function resumeRevert(root: string): Promise<{ revert: string; target: string; status: string }> {
  return withWriteLocks(root, async () => {
    const record = await openRecord(root);
    await applyRecord(root, record);
    return { revert: record.id, target: record.target, status: record.status };
  });
}

/** Undo an interrupted revert: restore every applied file from its checkpoint. */
export async function abortRevert(root: string): Promise<{ revert: string; checkpoint: string; status: string }> {
  return withWriteLocks(root, async () => {
    const record = await openRecord(root);
    await restoreCheckpoint(root, record, 'aborted');
    return { revert: record.id, checkpoint: record.checkpoint, status: record.status };
  });
}
