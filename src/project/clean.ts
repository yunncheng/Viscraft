/**
 * `viscraft clean`: reference-safe reclamation with a dry-run plan, an
 * explicit `--apply <planHash>`, and `--resume` / `--abort` after an interruption.
 *
 * The default plan only touches bytes nothing still needs:
 *  - `.viscraft/scratch/**` leftovers and `.viscraft/previews/**` stills;
 *  - Artifact files no protection root reaches and no version selected
 *    (`rebuildable`), or that only preview Builds used (`preview`);
 *  - the snapshot directories of failed and preview Builds (their Build record
 *    and `<id>.project.json/.inputs.json` stay — they are evidence), except a
 *    failed Build whose frozen Project contains a generation Source;
 *  - content-store entries no surviving snapshot, record or portable manifest
 *    references (including those orphaned by the deletions above, so the same
 *    plan really frees their bytes);
 *  - duplicate snapshot bytes: a physical copy whose content is (or becomes) a
 *    store entry is replaced by a hard link to it (same path, same bytes).
 * `--include <output/name | build-id | artifact-id>` adds a delivery copy or the
 * undetermined Artifacts of an unprotected version. Protected bytes
 * (`productionClosure`), provider evidence, records, author files, Assets,
 * handoff files, recordings and `review/` are never planned.
 *
 * Every byte figure is physical (`(dev, inode)`): deleting one link of a file
 * that is still linked elsewhere frees 0 and is reported as 0.
 */
import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ProjectSchema, type BuildRecord, type Project } from '../core/schema.js';
import { atomicJson, resolveProjectPath } from '../shared/fs.js';
import { hashFile, stableHash } from '../shared/hash.js';
import { readBuilds } from './build-records.js';
import { productionClosure, readCheckpointIds, SNAPSHOTS_PREFIX } from './closure.js';
import { CONTENT_DIR, contentPath } from './content-store.js';
import { loadProject } from './project.js';
import { readDeliveryRecord } from './output.js';
import { assertNoOpenWork, withWriteLocks } from './versions.js';

export const CLEANUPS_DIR = '.viscraft/cleanups';
const SHA = z.string().regex(/^[a-f0-9]{64}$/);
const GENERATION_KINDS = new Set(['provider', 'simulated']);

const CleanReasonSchema = z.enum([
  'scratch',
  'preview',
  'rebuildable',
  'failed-snapshot',
  'preview-snapshot',
  'orphan-content',
  'duplicate-snapshot',
  'included-output',
  'included-artifact',
]);

const CleanItemSchema = z
  .object({
    /** `compact` replaces the path with a hard link to `.viscraft/content/<sha256>`; `adopt` makes it that entry. */
    action: z.enum(['delete', 'compact', 'adopt']),
    path: z.string(),
    sha256: SHA,
    physicalBytes: z.number().int().nonnegative(),
    reason: CleanReasonSchema,
  })
  .strict();
export type CleanItem = z.infer<typeof CleanItemSchema>;

const CleanupRecordSchema = z
  .object({
    id: z.string().regex(/^cleanup-[a-zA-Z0-9_-]+$/),
    status: z.enum(['in-progress', 'complete', 'aborted']),
    planHash: SHA,
    include: z.array(z.string()),
    startedAt: z.string(),
    finishedAt: z.string().optional(),
    items: z.array(
      CleanItemSchema.extend({
        done: z.boolean(),
        skipped: z.enum(['now-protected', 'changed']).optional(),
      }).strict(),
    ),
  })
  .strict();
type CleanupRecord = z.infer<typeof CleanupRecordSchema>;

export interface CleanPlan {
  root: string;
  planHash: string;
  include: string[];
  items: CleanItem[];
  freedPhysicalBytes: number;
  byReason: Record<string, { items: number; physicalBytes: number }>;
}

export interface CleanResult {
  cleanup: string;
  status: CleanupRecord['status'];
  done: number;
  skipped: Array<{ path: string; reason: string }>;
  freedPhysicalBytes: number;
}

interface FileFact {
  size: number;
  key: string;
  nlink: number;
}

async function fact(file: string): Promise<FileFact | null> {
  try {
    const info = await lstat(file, { bigint: true });
    if (!info.isFile()) return null;
    return { size: Number(info.size), key: `${info.dev}:${info.ino}`, nlink: Number(info.nlink) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function walkFiles(root: string, relative: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(await resolveProjectPath(root, relative), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const out: string[] = [];
  for (const entry of entries) {
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await walkFiles(root, child)));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

async function readJson(root: string, relative: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(await resolveProjectPath(root, relative), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** A split (sharded) archive part name, exactly as `archive.ts` writes it. */
const PART_NAME = /^[^/\\]+\.part-\d{3,}$/;
const PARTS_SUFFIX = '.parts.json';

/**
 * Resolve an `--include output/<name>` value to the WHOLE delivery group when it
 * names a recorded sharded archive. The delivery record's `name` is a
 * nonexistent `<stem>.tar.gz`; its real members are the parts list plus every
 * part the list names. Returning the PARSED part names (never a `<stem>.part-*`
 * glob) preserves same-prefix non-members, and naming the parts list alone
 * resolves to the same group instead of deleting the list and leaving orphaned
 * shards. Returns null when the value is not a recorded sharded archive, so the
 * caller falls back to plain path handling.
 */
async function deliveryGroupMembers(root: string, value: string): Promise<string[] | null> {
  const segment = value.split('/')[1];
  if (!segment) return null;
  const recordName = segment.endsWith(PARTS_SUFFIX) ? segment.slice(0, -PARTS_SUFFIX.length) : segment;
  const record = await readDeliveryRecord(root, recordName);
  if (!record || record.kind !== 'archive' || !record.name.endsWith('.tar.gz')) return null;
  const listRel = record.path ? `output/${record.path}` : `output/${record.name}${PARTS_SUFFIX}`;
  const raw = await readJson(root, listRel).catch(() => null);
  const parts = raw && typeof raw === 'object' ? (raw as { parts?: unknown }).parts : undefined;
  if (!Array.isArray(parts) || parts.length === 0) return null;
  // The list itself, then the recorded stem (a superseded single-file archive to
  // the same name, if any — `deleteFile` skips an absent path), then each part.
  const members = [listRel, `output/${record.name}`];
  for (const part of parts) {
    const name = (part as { name?: unknown } | null)?.name;
    if (typeof name !== 'string' || !PART_NAME.test(name)) return null;
    members.push(`output/${name}`);
  }
  return members;
}

/** Frozen file digests of one snapshot (`<id>.inputs.json` → `files`). */
async function frozenFiles(root: string, id: string): Promise<Record<string, string>> {
  const inputs = (await readJson(root, `${SNAPSHOTS_PREFIX}${id}.inputs.json`)) as { files?: unknown } | null;
  if (!inputs || typeof inputs.files !== 'object' || inputs.files === null) return {};
  return Object.fromEntries(
    Object.entries(inputs.files as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && SHA.safeParse(entry[1]).success,
    ),
  );
}

async function frozenHasGeneration(root: string, id: string): Promise<boolean> {
  const raw = await readJson(root, `${SNAPSHOTS_PREFIX}${id}.project.json`);
  if (!raw) return false;
  const parsed = ProjectSchema.safeParse(raw);
  // An unreadable frozen Project is treated as possibly provider-related: keep it.
  if (!parsed.success) return true;
  return parsed.data.sources.some(source => GENERATION_KINDS.has(source.kind));
}

/**
 * Compute the clean plan for the current state. Pure read: it never writes.
 * Throws when the production closure cannot be computed (inconsistent lineage
 * must be repaired, never guessed around by a deleting command).
 */
export async function planClean(
  root: string,
  /** `lenient` (resume): a now-protected include is skipped instead of refused. */
  options: { include?: string[]; lenient?: boolean } = {},
): Promise<CleanPlan> {
  const rootAbs = path.resolve(root);
  const include = [...new Set(options.include ?? [])].sort();
  const project: Project = await loadProject(rootAbs);
  const builds = await readBuilds(rootAbs);
  const closure = await productionClosure(rootAbs, project, builds, [
    'author',
    'active-result',
    'retained',
    'checkpoint',
    'derived',
    'generated',
  ]);
  const protectedFiles = new Set(closure.files.keys());
  for (const artifactId of closure.artifacts.keys())
    for (const build of builds)
      for (const artifact of build.artifacts) if (artifact.id === artifactId) protectedFiles.add(artifact.path);

  const candidates: Array<{ action: CleanItem['action']; path: string; sha256: string; reason: CleanItem['reason'] }> =
    [];
  const planned = new Set<string>();
  const plan = (action: CleanItem['action'], relative: string, sha256: string, reason: CleanItem['reason']) => {
    if (planned.has(relative) || (action === 'delete' && protectedFiles.has(relative))) return;
    planned.add(relative);
    candidates.push({ action, path: relative, sha256, reason });
  };
  const deleteFile = async (relative: string, reason: CleanItem['reason']) => {
    const file = await resolveProjectPath(rootAbs, relative);
    if (!(await fact(file))) return;
    plan('delete', relative, await hashFile(file), reason);
  };

  // --- scratch and preview stills -------------------------------------------
  for (const relative of await walkFiles(rootAbs, '.viscraft/scratch')) await deleteFile(relative, 'scratch');
  for (const relative of await walkFiles(rootAbs, '.viscraft/previews')) await deleteFile(relative, 'preview');

  // --- Artifacts -------------------------------------------------------------
  const isVersion = (build: BuildRecord) => build.status === 'succeeded' && !build.preview;
  // `version`: the Artifact is a result or Take of a version — the user decides
  // (`--include`). Other unprotected Artifacts are deterministic intermediates a
  // revert can rebuild at no cost (the same split `usage` reports).
  const artifactUse = new Map<string, { path: string; version: boolean }>();
  for (const build of builds)
    for (const artifact of build.artifacts) {
      const use = artifactUse.get(artifact.id) ?? { path: artifact.path, version: false };
      use.version ||=
        isVersion(build) &&
        (build.result?.artifact === artifact.id || build.takes.some(take => take.artifact === artifact.id));
      artifactUse.set(artifact.id, use);
    }
  const includedArtifacts = new Set<string>();
  for (const value of include) {
    if (value.startsWith('artifact-')) includedArtifacts.add(value);
    else if (value.startsWith('build-')) {
      const build = builds.find(candidate => candidate.id === value);
      if (!build) throw new Error(`clean --include: no Build ${value}`);
      // A Build reached only as a producer/input of shared bytes still has
      // reclaimable Artifacts; a version that is itself a root is protected.
      const reason = closure.builds.get(value);
      if (
        reason === 'active-result' ||
        reason === 'image-result' ||
        reason === 'retained' ||
        reason === 'author-take' ||
        reason === 'derived'
      ) {
        if (options.lenient) continue;
        throw new Error(`clean --include: Build ${value} is protected (${closure.builds.get(value)})`);
      }
      for (const artifact of build.artifacts)
        if (!closure.artifacts.has(artifact.id)) includedArtifacts.add(artifact.id);
    } else if (!/^output\/[^/]+/.test(value)) throw new Error(`clean --include: unsupported value ${value}`);
  }
  for (const id of includedArtifacts) {
    if (!artifactUse.has(id)) throw new Error(`clean --include: no Artifact ${id}`);
    if (closure.artifacts.has(id) && !options.lenient)
      throw new Error(`clean --include: Artifact ${id} is protected (${closure.artifacts.get(id)})`);
  }
  for (const [id, use] of artifactUse) {
    if (closure.artifacts.has(id)) continue;
    if (includedArtifacts.has(id)) await deleteFile(use.path, 'included-artifact');
    else if (!use.version) {
      const onlyPreview = builds.some(build => build.preview && build.artifacts.some(artifact => artifact.id === id));
      await deleteFile(use.path, onlyPreview ? 'preview' : 'rebuildable');
    }
  }
  // Artifact files with no record at all (no Build can be running: callers hold
  // the build lock). Only when every Build record parsed: an unreadable record
  // might be the one that names the file.
  const recordFiles = (await walkFiles(rootAbs, '.viscraft/builds')).filter(file =>
    /^\.viscraft\/builds\/build-[a-zA-Z0-9_-]+\.json$/.test(file),
  );
  if (recordFiles.length === builds.length) {
    // Only `artifact-<id>.<ext>` files whose id no record names; anything else is left alone.
    for (const relative of await walkFiles(rootAbs, '.viscraft/artifacts')) {
      const id = /^\.viscraft\/artifacts\/(artifact-[a-zA-Z0-9_-]+)\.[a-z0-9]+$/.exec(relative)?.[1];
      if (id && !artifactUse.has(id)) await deleteFile(relative, 'rebuildable');
    }
  }

  // --- Snapshot directories of failed and preview Builds ---------------------
  const droppedSnapshots = new Set<string>();
  for (const build of builds) {
    const preview = build.status === 'succeeded' && build.preview !== undefined;
    const failed = build.status === 'failed';
    if (!preview && !failed) continue;
    if (closure.builds.has(build.id)) continue;
    if (failed && (await frozenHasGeneration(rootAbs, build.id))) continue;
    droppedSnapshots.add(build.id);
    for (const relative of await walkFiles(rootAbs, `${SNAPSHOTS_PREFIX}${build.id}`))
      await deleteFile(relative, preview ? 'preview-snapshot' : 'failed-snapshot');
  }

  // --- Included deliveries ----------------------------------------------------
  for (const value of include.filter(item => item.startsWith('output/'))) {
    const group = await deliveryGroupMembers(rootAbs, value);
    if (group) {
      for (const relative of group) await deleteFile(relative, 'included-output');
      continue;
    }
    const name = value.split('/').slice(0, 2).join('/');
    const files = (await fact(await resolveProjectPath(rootAbs, name))) ? [name] : await walkFiles(rootAbs, name);
    if (files.length === 0) throw new Error(`clean --include: nothing under ${name}`);
    for (const relative of files) await deleteFile(relative, 'included-output');
  }

  // --- Content store: references, orphans and snapshot compaction -------------
  const snapshotIds = new Set<string>(await readCheckpointIds(rootAbs));
  for (const build of builds) snapshotIds.add(build.id);
  const referenced = new Set<string>();
  const surviving: Array<{ path: string; sha256: string }> = [];
  for (const id of snapshotIds) {
    if (droppedSnapshots.has(id)) continue;
    for (const [relative, sha256] of Object.entries(await frozenFiles(rootAbs, id))) {
      referenced.add(sha256);
      surviving.push({ path: `${SNAPSHOTS_PREFIX}${id}/${relative}`, sha256 });
    }
  }
  const manifest = (await readJson(rootAbs, '.viscraft/portable-manifest.json')) as {
    snapshotAssets?: Array<{ sha256?: unknown }>;
  } | null;
  for (const asset of manifest?.snapshotAssets ?? [])
    if (typeof asset.sha256 === 'string') referenced.add(asset.sha256);

  const entries = new Map<string, FileFact>();
  for (const relative of await walkFiles(rootAbs, CONTENT_DIR)) {
    const name = relative.slice(CONTENT_DIR.length + 1);
    if (!SHA.safeParse(name).success) continue;
    const info = await fact(await resolveProjectPath(rootAbs, relative));
    if (info) entries.set(name, info);
  }
  const survivingKeys = new Set<string>();
  const copies = new Map<string, Array<{ path: string; info: FileFact }>>();
  for (const file of surviving) {
    const info = await fact(await resolveProjectPath(rootAbs, file.path));
    if (!info) continue;
    survivingKeys.add(info.key);
    const entry = entries.get(file.sha256);
    if (entry?.key === info.key) continue;
    const list = copies.get(file.sha256) ?? [];
    list.push({ path: file.path, info });
    copies.set(file.sha256, list);
  }
  for (const [sha256, entry] of entries)
    if (!referenced.has(sha256) && !survivingKeys.has(entry.key))
      plan('delete', contentPath(sha256), sha256, 'orphan-content');
  for (const [sha256, list] of copies) {
    list.sort((a, b) => a.path.localeCompare(b.path));
    let start = 0;
    if (!entries.has(sha256)) {
      // Nothing to link to yet: adopt the first copy as the store entry (a
      // snapshot-only file, so it is never an editable original), then link the rest.
      if (list[0].info.nlink !== 1) continue;
      plan('adopt', list[0].path, sha256, 'duplicate-snapshot');
      start = 1;
    }
    for (const copy of list.slice(start)) plan('compact', copy.path, sha256, 'duplicate-snapshot');
  }

  // --- Physical bytes: an inode is freed when its last link is removed --------
  const removed = new Map<string, number>();
  const items: CleanItem[] = [];
  for (const candidate of candidates.sort((a, b) => a.path.localeCompare(b.path))) {
    const info = await fact(await resolveProjectPath(rootAbs, candidate.path));
    let physicalBytes = 0;
    if (info && candidate.action !== 'adopt') {
      const count = (removed.get(info.key) ?? 0) + 1;
      removed.set(info.key, count);
      if (count === info.nlink) physicalBytes = info.size;
    }
    items.push({ ...candidate, physicalBytes });
  }
  const byReason: CleanPlan['byReason'] = {};
  for (const item of items) {
    const bucket = (byReason[item.reason] ??= { items: 0, physicalBytes: 0 });
    bucket.items += 1;
    bucket.physicalBytes += item.physicalBytes;
  }
  return {
    root: rootAbs,
    planHash: stableHash({
      include,
      items: items.map(({ action, path, sha256, reason }) => ({ action, path, sha256, reason })),
    }),
    include,
    items,
    freedPhysicalBytes: items.reduce((sum, item) => sum + item.physicalBytes, 0),
    byReason,
  };
}

/** Test seam: called before each item; an error with `simulatedInterrupt` leaves the record in progress. */
let stepHook: ((item: CleanItem) => Promise<void> | void) | undefined;
export function setCleanStepHookForTest(hook?: (item: CleanItem) => Promise<void> | void): void {
  stepHook = hook;
}

async function readCleanups(root: string): Promise<CleanupRecord[]> {
  let names: string[];
  try {
    names = await readdir(await resolveProjectPath(root, CLEANUPS_DIR));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: CleanupRecord[] = [];
  for (const name of names.filter(n => /^cleanup-[a-zA-Z0-9_-]+\.json$/.test(n)))
    records.push(CleanupRecordSchema.parse(await readJson(root, `${CLEANUPS_DIR}/${name}`)));
  return records;
}

/** The unfinished cleanup, if any. */
export async function incompleteCleanup(root: string): Promise<{ id: string; remaining: number } | null> {
  const open = (await readCleanups(root)).find(record => record.status === 'in-progress');
  return open ? { id: open.id, remaining: open.items.filter(item => !item.done && !item.skipped).length } : null;
}

async function saveRecord(root: string, record: CleanupRecord): Promise<void> {
  await atomicJson(await resolveProjectPath(root, `${CLEANUPS_DIR}/${record.id}.json`), record);
}

async function removeEmptyParents(root: string, relative: string): Promise<void> {
  const stop = new Set(['.viscraft', '.viscraft/snapshots', '.viscraft/artifacts', CONTENT_DIR, 'output', '.']);
  let dir = path.posix.dirname(relative);
  while (!stop.has(dir)) {
    try {
      await rmdir(await resolveProjectPath(root, dir));
    } catch {
      return;
    }
    dir = path.posix.dirname(dir);
  }
}

async function performItem(root: string, item: CleanItem): Promise<'done' | 'changed'> {
  const file = await resolveProjectPath(root, item.path);
  const info = await fact(file);
  if (!info) return item.action === 'delete' ? 'done' : 'changed';
  if ((await hashFile(file)) !== item.sha256) return 'changed';
  const entry = await resolveProjectPath(root, contentPath(item.sha256));
  if (item.action === 'delete') {
    await unlink(file);
    await removeEmptyParents(root, item.path);
    return 'done';
  }
  if (item.action === 'adopt' && !(await fact(entry))) {
    await mkdir(path.dirname(entry), { recursive: true });
    await link(file, entry);
    await chmod(entry, 0o444);
    return 'done';
  }
  if ((await fact(entry))?.key === info.key) return 'done';
  if ((await hashFile(entry)) !== item.sha256) return 'changed';
  const temporary = `${file}.${randomUUID()}.link`;
  await link(entry, temporary);
  // Windows refuses replacing a read-only target. Only clear the attribute on
  // an independent duplicate: changing it on a shared inode would affect other
  // frozen paths. The replacement link retains the content store's permissions.
  if (process.platform === 'win32' && info.nlink === 1) {
    const mode = (await lstat(file)).mode;
    await chmod(file, mode | 0o200);
    try {
      await rename(temporary, file);
    } catch (error) {
      await chmod(file, mode);
      throw error;
    }
  } else await rename(temporary, file);
  return 'done';
}

async function run(root: string, record: CleanupRecord, eligible: Set<string> | null): Promise<CleanResult> {
  for (const item of record.items) {
    if (item.done || item.skipped) continue;
    if (eligible && !eligible.has(`${item.action}:${item.path}:${item.sha256}`)) {
      const exists = await fact(await resolveProjectPath(root, item.path));
      if (!exists && item.action === 'delete') item.done = true;
      else
        item.skipped =
          exists && (await hashFile(await resolveProjectPath(root, item.path))) !== item.sha256
            ? 'changed'
            : 'now-protected';
      await saveRecord(root, record);
      continue;
    }
    await stepHook?.(item);
    const outcome = await performItem(root, item);
    if (outcome === 'done') item.done = true;
    else item.skipped = 'changed';
    await saveRecord(root, record);
  }
  record.status = 'complete';
  record.finishedAt = new Date().toISOString();
  await saveRecord(root, record);
  return summary(record);
}

function summary(record: CleanupRecord): CleanResult {
  return {
    cleanup: record.id,
    status: record.status,
    done: record.items.filter(item => item.done).length,
    skipped: record.items.filter(item => item.skipped).map(item => ({ path: item.path, reason: item.skipped! })),
    freedPhysicalBytes: record.items.filter(item => item.done).reduce((sum, item) => sum + item.physicalBytes, 0),
  };
}

/** Apply exactly the plan the caller reviewed; a different current plan is refused. */
export async function applyClean(
  root: string,
  planHash: string,
  options: { include?: string[] } = {},
): Promise<CleanResult> {
  return withWriteLocks(root, async () => {
    await assertNoOpenWork(root);
    const plan = await planClean(root, options);
    if (plan.planHash !== planHash)
      throw new Error(
        `clean: the plan changed since it was reviewed (now ${plan.planHash}); run \`viscraft clean\` again and review the new plan`,
      );
    const record: CleanupRecord = {
      id: `cleanup-${randomUUID()}`,
      status: 'in-progress',
      planHash,
      include: plan.include,
      startedAt: new Date().toISOString(),
      items: plan.items.map(item => ({ ...item, done: false })),
    };
    await saveRecord(root, record);
    return run(root, record, null);
  });
}

/**
 * Finish an interrupted cleanup from its record. The plan hash is not compared
 * (completed deletions necessarily change it); instead every unfinished item is
 * re-judged against a fresh plan: no longer eligible → `now-protected`, bytes
 * changed → `changed`, already gone → done.
 */
export async function resumeClean(root: string): Promise<CleanResult> {
  return withWriteLocks(root, async () => {
    await assertNoOpenWork(root, { allowCleanup: true });
    const record = (await readCleanups(root)).find(candidate => candidate.status === 'in-progress');
    if (!record) throw new Error('clean: there is no incomplete cleanup to resume');
    const fresh = await planClean(root, { include: record.include, lenient: true });
    return run(root, record, new Set(fresh.items.map(item => `${item.action}:${item.path}:${item.sha256}`)));
  });
}

/** Mark an interrupted cleanup aborted. Deleted rebuildable bytes are not restored. */
export async function abortClean(root: string): Promise<CleanResult> {
  return withWriteLocks(root, async () => {
    const record = (await readCleanups(root)).find(candidate => candidate.status === 'in-progress');
    if (!record) throw new Error('clean: there is no incomplete cleanup to abort');
    record.status = 'aborted';
    record.finishedAt = new Date().toISOString();
    await saveRecord(root, record);
    return summary(record);
  });
}
