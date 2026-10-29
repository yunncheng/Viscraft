import path from 'node:path';

import { atomicJson } from '../shared/fs.js';
import { rm, readFile, lstat, mkdir, realpath, readdir, rename, writeFile, link, unlink } from 'node:fs/promises';
import { ensureSelfIgnore } from './self-ignore.js';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

/**
 * Recovery marker that records the delivery about to be published into
 * `output/<name>`, written immediately BEFORE the publish and cleared once the
 * final `.viscraft/deliveries/<name>.json` record exists. It closes the
 * crash window between "published into output/" and "recorded": a crash leaves
 * either no marker (nothing published yet) or a marker whose `manifestSha256`
 * exactly identifies the bundle now on disk, so the next delivery can recognise
 * that entry as ITS OWN published-but-unrecorded delivery and replace it. The
 * name deliberately does NOT end in `.json`, so record readers ignore it.
 */
function pendingDeliveryPath(rootReal: string, name: string): string {
  return path.join(rootReal, DELIVERIES_DIR, `${name}.pending`);
}

/** Persist the recovery marker for a delivery before publishing it. */
export async function markDeliveryPending(rootReal: string, record: DeliveryRecord): Promise<void> {
  await atomicJson(pendingDeliveryPath(rootReal, record.name), record);
}

/** Drop the recovery marker once the final delivery record is durable. */
export async function clearDeliveryPending(rootReal: string, name: string): Promise<void> {
  await rm(pendingDeliveryPath(rootReal, name), { force: true });
}

/**
 * True when the entry currently at the delivery destination is this Runtime's OWN
 * published-but-unrecorded delivery: a recovery marker exists for `name`/`kind`
 * and the destination's representative hash is exactly the one the marker
 * planned. A marker whose hash does not match (the publish never happened, or a
 * different bundle is now in place) does not authorize anything, so a hand-edited
 * or author-owned entry is never replaced on the strength of a stale marker.
 */
export async function pendingDeliveryAcceptable(
  rootReal: string,
  name: string,
  kind: DeliveryRecord['kind'],
  currentHash: () => Promise<string | null>,
): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(pendingDeliveryPath(rootReal, name), 'utf8')) as DeliveryRecord;
    if (marker.name !== name || marker.kind !== kind || marker.manifestSha256 === undefined) return false;
    return (await currentHash()) === marker.manifestSha256;
  } catch {
    // Missing or unreadable marker: fall back to the recorded-delivery check.
    return false;
  }
}

export const OUTPUT_DIR = 'output';

/** Runtime-owned delivery records: one JSON file per delivered `output/<name>`. */
export const DELIVERIES_DIR = '.viscraft/deliveries';

/**
 * Serializes PUBLICATION of `output/` deliveries, so two writers can never
 * stage from the same observed bundle and then both swap it into place (the
 * loser would silently discard the winner's bytes). It is a separate lock from
 * `build`/`author`: staging must not block authoring, and authoring must not
 * block publishing. Callers acquire it only after `build` → `author`, never
 * while holding it in the opposite order.
 */
export const DELIVERY_LOCK = '.viscraft/delivery.lock';

export function isOutputPath(relative: string): boolean {
  const normalized = relative.toLowerCase();
  return normalized === OUTPUT_DIR || normalized.startsWith(`${OUTPUT_DIR}/`);
}

/** Reject an authored project-relative path that lives under `output/`. */
export function assertNotOutputPath(relative: string, label: string): void {
  if (isOutputPath(relative))
    throw new Error(
      `${label} must not live under ${OUTPUT_DIR}/ (Runtime deliveries); import the file to an authored path instead: ${relative}`,
    );
}

/** Which delivery produced an `output/` entry (drives replace and status). */
export type DeliveryKind = 'deliver' | 'export' | 'archive' | 'playable';

/**
 * Pinned delivery-record shape. Written to `.viscraft/deliveries/<name>.json`
 * with `atomicJson`. Other modules (status) read it, so the field names and
 * semantics are a stable interface.
 */
export interface DeliveryRecord {
  /** Entry name under `output/` (for a split archive, the `<id>.tar.gz` stem). */
  name: string;
  /**
   * `output/`-relative path of the file actually produced, when it differs from
   * `name` (a split archive publishes `<name>.parts.json`). Absent means it is
   * `name` itself (a directory delivery, a single-file archive).
   */
  path?: string;

  kind: DeliveryKind;
  /** The active Build this delivery was made from, when one applied. */
  build?: string;
  /** Authored project revision at delivery time. */
  revision: number;
  /** ISO timestamp of the delivery. */
  deliveredAt: string;
  /**
   * Hash of the file that represents the delivery at its destination (the
   * bundle/project/playable manifest, or the archive). A later re-delivery to
   * the same name recomputes it to prove the existing delivery is untouched.
   */
  manifestSha256?: string;
}

function deliveriesDir(rootReal: string): string {
  return path.join(rootReal, DELIVERIES_DIR);
}

/**
 * Ensure `<rootReal>/output` exists as a real directory (never a symlink) and
 * return its absolute path. The directory self-ignores in git the first time it
 * is created (idempotent, never overwrites an existing `.gitignore`).
 */
export async function ensureOutputDir(rootReal: string): Promise<string> {
  const dir = path.join(rootReal, OUTPUT_DIR);
  try {
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error(`${OUTPUT_DIR}/ must be a real directory inside the Project, not a link or file`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(dir);
  }
  await ensureSelfIgnore(dir);
  return dir;
}

/** The fixed default destination `<root>/output/<name>`, creating `output/` on demand. */
export async function defaultDeliveryPath(rootReal: string, name: string): Promise<string> {
  const dir = await ensureOutputDir(rootReal);
  return path.join(dir, name);
}

/**
 * The delivery-record name for a destination that is a direct child of
 * `output/`, or null when the destination is elsewhere (an explicit
 * destination outside `output/` is never recorded — the record describes the
 * Runtime-managed `output/` entries).
 */
export function outputRecordName(rootReal: string, destReal: string): string | null {
  return path.dirname(destReal) === path.join(rootReal, OUTPUT_DIR) ? path.basename(destReal) : null;
}

export async function readDeliveryRecord(rootReal: string, name: string): Promise<DeliveryRecord | null> {
  const file = path.join(deliveriesDir(rootReal), `${name}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8')) as DeliveryRecord;
  } catch {
    // Missing or unreadable/malformed: treat as "no record". A record that
    // cannot be trusted must never authorize replacing an existing entry.
    return null;
  }
}

/**
 * Every delivery recorded in `.viscraft/deliveries/`, newest first. Read-only:
 * a missing directory or a single unreadable/malformed record is ignored rather
 * than failing the query (the caller is reporting facts, not enforcing them).
 */
export async function listDeliveryRecords(root: string): Promise<DeliveryRecord[]> {
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    return [];
  }
  let names: string[];
  try {
    names = await readdir(deliveriesDir(rootReal));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: DeliveryRecord[] = [];
  for (const name of names.filter(entry => entry.endsWith('.json'))) {
    try {
      records.push(JSON.parse(await readFile(path.join(deliveriesDir(rootReal), name), 'utf8')) as DeliveryRecord);
    } catch {
      // A malformed record is skipped; a read query never fails over one bad file.
    }
  }
  return records.sort((a, b) => (b.deliveredAt ?? '').localeCompare(a.deliveredAt ?? ''));
}

/** Record one delivery. `atomicJson` creates the deliveries directory on demand. */
export async function writeDeliveryRecord(rootReal: string, record: DeliveryRecord): Promise<void> {
  await atomicJson(path.join(deliveriesDir(rootReal), `${record.name}.json`), record);
}

/** Drop a delivery record (its `output/` entry was removed or replaced). */
export async function removeDeliveryRecord(rootReal: string, name: string): Promise<void> {
  await rm(path.join(deliveriesDir(rootReal), `${name}.json`), { force: true });
}

/**
 * Refuse to replace a default delivery and explain the way forward. The
 * Runtime only manages its OWN directory, so it never deletes an entry it does
 * not recognize; it offers `clean --include` (an explicit author decision) or a
 * different name.
 */
export function refuseDeliveryReplace(name: string, reason: string): never {
  throw new Error(
    `${OUTPUT_DIR}/${name} already exists and ${reason}; a default delivery only replaces a recorded, unmodified Runtime delivery, so this is never overwritten. Deliveries are listed by \`status\`; remove it with \`viscraft clean <project> --include ${OUTPUT_DIR}/${name}\`, or pass an explicit different destination.`,
  );
}

/**
 * Prove that the existing `output/<name>` may be replaced, or refuse loudly.
 * Callers invoke this only after observing that the entry actually exists and
 * knowing its kind.
 *
 * Two independent facts are required, because neither alone is sufficient:
 *
 *  - `currentHash` re-derives the delivery's recorded representative hash (the
 *    bundle/project/playable manifest, or the archive). A missing file or a
 *    mismatch — a hand-edited manifest — is a refusal. That alone still trusts
 *    the manifest LIST, so it cannot catch a modified member whose manifest was
 *    left untouched;
 *  - `verifyMembers` re-verifies the OLD package's actual members against that
 *    manifest's complete allowlist (hash, size, type; every listed file present
 *    and no extra file, and no symlink), so editing `projects.json`, a Source, a
 *    picture or swapping a member for a symlink is refused even though the
 *    manifest bytes are unchanged.
 *
 * Both are the caller's own package verification, not a second content
 * authority. The Runtime cannot provide transaction isolation against an
 * arbitrary external editor writing during delivery, so the check is repeated
 * immediately before the final replace (see the callers).
 */
export async function assertReplaceableDefault(
  rootReal: string,
  name: string,
  kind: DeliveryKind,
  currentHash: () => Promise<string | null>,
  verifyMembers: () => Promise<void>,
): Promise<void> {
  const record = await readDeliveryRecord(rootReal, name);
  if (!record || record.kind !== kind) refuseDeliveryReplace(name, 'is not a recorded Runtime delivery');
  const current = await currentHash();
  if (record.manifestSha256 === undefined || current === null || current !== record.manifestSha256)
    refuseDeliveryReplace(name, 'has been modified since it was delivered');
  try {
    await verifyMembers();
  } catch (error) {
    // A member that no longer matches its own recorded allowlist is a
    // modification the representative hash cannot see; the whole old entry is
    // preserved untouched.
    const detail =
      error instanceof Error && error.message.startsWith('altered:') ? ` (${error.message.slice(7).trim()})` : '';
    refuseDeliveryReplace(name, `has been modified since it was delivered${detail}`);
  }
}

/**
 * Walk a directory and return every regular file's `/`-separated relative path.
 * Symlinks and special files are rejected rather than followed, so a
 * verification walk can never escape the package. Used by the delivery
 * replace-protection checks to compare an existing package's ACTUAL members
 * against its own manifest allowlist.
 */
export async function walkRegularFiles(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`altered: ${relative} is a symbolic link`);
    if (entry.isDirectory()) out.push(...(await walkRegularFiles(absolute, relative)));
    else if (entry.isFile()) out.push(relative);
    else throw new Error(`altered: ${relative} is an unsupported file type`);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * Atomically replace `finalPath` with the freshly staged `staging` directory
 * (both must live on the same filesystem, normally siblings inside `output/`).
 * The old copy is moved aside first, the staged copy is renamed into place, and
 * only then is the old copy deleted — so a crash mid-swap leaves either the old
 * or the new delivery, never a half-written entry.
 */
export async function replaceStagedDirectory(staging: string, finalPath: string): Promise<void> {
  const aside = path.join(path.dirname(finalPath), `.${path.basename(finalPath)}.${randomUUID()}.old`);
  await rename(finalPath, aside);
  try {
    await rename(staging, finalPath);
  } catch (error) {
    await rename(aside, finalPath).catch(() => {});
    throw error;
  }
  await rm(aside, { recursive: true, force: true });
}

/**
 * Take the publication lock for this Project's `output/` deliveries and return
 * its release function. Same link-based, stale-process-recovering discipline as
 * the project `build`/`author` locks (a crashed writer never wedges delivery
 * forever), but a separate lock file so staging/publishing never serializes
 * authoring or building.
 *
 * Hold it from the moment a publisher OBSERVES the existing entry until the
 * atomic swap and the delivery record write are complete. Every publisher also
 * compares the recorded manifest hash it observed; self-consistency checks alone
 * cannot distinguish "the entry I staged from" from "a newer delivery".
 */
export async function acquireDeliveryLock(rootReal: string): Promise<() => Promise<void>> {
  await mkdir(path.join(rootReal, '.viscraft'), { recursive: true });
  const file = path.join(rootReal, DELIVERY_LOCK);
  const identity = { pid: process.pid, host: hostname(), token: randomUUID(), startedAt: new Date().toISOString() };
  const temporary = `${file}.${identity.token}.tmp`;
  await writeFile(temporary, JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
  try {
    try {
      await link(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let existing: { pid?: number; host?: string; token?: string };
      try {
        existing = JSON.parse(await readFile(file, 'utf8'));
      } catch {
        throw new Error('Delivery publication lock is unreadable; inspect it before recovery');
      }
      let dead = false;
      if (existing.host === hostname() && Number.isSafeInteger(existing.pid) && existing.pid! > 0) {
        try {
          process.kill(existing.pid!, 0);
        } catch (probeError) {
          dead = (probeError as NodeJS.ErrnoException).code === 'ESRCH';
        }
      }
      if (!dead)
        throw new Error(
          `Delivery publication is locked by PID ${existing.pid ?? 'unknown'} on ${existing.host ?? 'unknown host'}; wait for that delivery to finish instead of starting another writer`,
        );
      const recovery = `${file}.recovery`;
      try {
        await link(temporary, recovery);
      } catch {
        throw new Error('Another process is recovering the delivery lock; inspect recovery state before retrying');
      }
      try {
        const unchanged = JSON.parse(await readFile(file, 'utf8')) as { token?: string };
        if (unchanged.token !== existing.token) throw new Error('Delivery lock changed during recovery; retry');
        await unlink(file);
        await link(temporary, file);
      } finally {
        await unlink(recovery);
      }
    }
  } finally {
    await unlink(temporary);
  }
  return async () => {
    const current = JSON.parse(await readFile(file, 'utf8')) as { token: string };
    if (current.token !== identity.token)
      throw new Error('Refusing to release a delivery lock owned by another writer');
    await unlink(file);
  };
}

/** The active result's Build id, or undefined when there is no readable active result. */ async function currentResultBuild(
  rootReal: string,
): Promise<string | undefined> {
  try {
    const value = JSON.parse(await readFile(path.join(rootReal, '.viscraft', 'result.json'), 'utf8')) as {
      build?: unknown;
    };
    return typeof value.build === 'string' ? value.build : undefined;
  } catch {
    // A missing OR malformed result.json means "no current result" for this
    // read-only report; a corrupt record must not make inspectOutputs/status
    // throw (status surfaces it separately as `active-result-invalid`).
    return undefined;
  }
}

/**
 * Report what `output/` currently holds. Pinned interface:
 * another module (status) calls it and renders the result.
 *
 *  - `stale` — recorded deliveries made from a Build that is not the Project's
 *    current result (superseded by a newer build); only records that carry a
 *    Build can ever be stale.
 *  - `unrecorded` — top-level files/dirs under `output/` with no delivery
 *    record (a manual copy or another unregistered file). This is
 *    REPORT ONLY: the Runtime never deletes an entry it does not own.
 *
 * The Runtime's own `output/.gitignore` is not a delivery and is not reported.
 */
export async function inspectOutputs(root: string): Promise<{
  stale: Array<{ name: string; build?: string; kind?: DeliveryKind }>;
  unrecorded: string[];
}> {
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    return { stale: [], unrecorded: [] };
  }
  const current = await currentResultBuild(rootReal);

  const records: DeliveryRecord[] = [];
  try {
    for (const file of await readdir(deliveriesDir(rootReal))) {
      if (!file.endsWith('.json')) continue;
      try {
        records.push(JSON.parse(await readFile(path.join(deliveriesDir(rootReal), file), 'utf8')) as DeliveryRecord);
      } catch {
        // A malformed record is ignored here; `inspect`/reporting never fails a
        // read query over one bad file.
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const stale = records
    .filter(record => record.build !== undefined && record.build !== current)
    .map(record => ({ name: record.name, build: record.build, kind: record.kind }));

  const owned = new Set<string>();
  const partPrefixes: string[] = [];
  for (const record of records) {
    owned.add(record.name);
    if (record.kind === 'archive' && record.name.endsWith('.tar.gz')) {
      // A split archive publishes `<name>.parts.json` + `<name>.part-NNN`.
      owned.add(`${record.name}.parts.json`);
      partPrefixes.push(`${record.name}.part-`);
    }
  }

  let entries: string[] = [];
  try {
    entries = (await readdir(path.join(rootReal, OUTPUT_DIR), { withFileTypes: true })).map(entry => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const unrecorded = entries
    .filter(entry => entry !== '.gitignore')
    .filter(entry => !owned.has(entry) && !partPrefixes.some(prefix => entry.startsWith(prefix)))
    .sort();

  return { stale, unrecorded };
}
