import { constants, createReadStream, createWriteStream } from 'node:fs';
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { Id } from '../../core/schema.js';
import { stableHash } from '../../shared/hash.js';
import { acquireLock, loadProject, validateProject } from '../../project/project.js';
import { exportProject, resolveDestination } from './portable.js';
import { PortableManifestSchema, type PortableManifest } from './portable-contract.js';
import { markDeliveryPending, clearDeliveryPending, pendingDeliveryAcceptable } from '../../project/output.js';
import {
  assertReplaceableDefault,
  defaultDeliveryPath,
  outputRecordName,
  writeDeliveryRecord,
  type DeliveryRecord,
} from '../../project/output.js';
import {
  ARCHIVE_LIMITS,
  ARCHIVE_MANIFEST,
  DEFAULT_MAX_CONTENT_BYTES,
  archiveEntryLimit,
  assertArchivePaths,
  assertMaxContent,
  decodedBytesFor,
  hashArchiveFile,
  readArchiveTransport,
  writeArchiveTransport,
  type ArchiveDeclaration,
  type ArchiveEntry,
} from './archive-transport.js';

/**
 * Transport identity; files excludes the portable manifest, contentBytes includes
 * it. For a split archive `path` is the parts list and `parts` names each part;
 * `sha256`/`compressedBytes` always describe the whole (concatenated) archive.
 */
export interface ArchiveResult {
  path: string;
  sha256: string;
  compressedBytes: number;
  contentBytes: number;
  files: number;
  simulated: boolean;
  parts?: ArchivePart[];
}

export interface ArchiveOptions {
  /** Split the archive into parts of at most this many bytes plus a `<name>.parts.json` list. */
  partSize?: number;
  /** Absolute cap on total content bytes (default 4 GiB). */
  maxContent?: number;
  /**
   * Package Assets whose rights are not verified as redistributable. Like the
   * `deliver`/`export` opt-in, this is default-off: without it a private asset is
   * refused, and with it the archive is a private copy not cleared for
   * redistribution.
   */
  allowNonRedistributable?: boolean;
  /**
   * Carry the required local provider originals (default true). The restricted
   * `allowMissingOriginals` records a required-but-missing original as a gap
   * instead of failing; the archive then validates against that recorded scope.
   */
  includeOriginals?: boolean;
  allowMissingOriginals?: boolean;
  /**
   * Explicit, default-off restricted AUTHOR scope: carry a Project with
   * UNCONSUMED authored gaps, recording them in the portable scope. The archive
   * replays this scope on validation; a consumed gap is still refused.
   */
  allowIncompleteAuthored?: boolean;
  /**
   * Carry additional accepted versions by STABLE Build id (or the literal
   * `'retained'`), seeded into the active closure traversal by `exportProject`.
   * The recorded `scope.requestedVersions` is replayed on restore/re-export.
   */
  extraVersions?: string[];
}

export interface RestoreOptions {
  /** Absolute cap on total content bytes (default 4 GiB); must cover the manifest declaration. */
  maxContent?: number;
}

export const PARTS_SUFFIX = '.parts.json';
const PART_NAME = /^[^/\\]+\.part-\d{3,}$/;
const HEX = /^[a-f0-9]{64}$/;

const ArchivePartSchema = z
  .object({
    name: z.string().regex(PART_NAME),
    sha256: z.string().regex(HEX),
    bytes: z.number().int().positive(),
  })
  .strict();
export type ArchivePart = z.infer<typeof ArchivePartSchema>;

const PartsListSchema = z
  .object({
    format: z.literal('viscraft-archive-parts'),
    version: z.literal(1),
    projectId: Id,
    revision: z.number().int().positive(),
    archive: z.object({ sha256: z.string().regex(HEX), bytes: z.number().int().positive() }).strict(),
    parts: z.array(ArchivePartSchema).min(1),
  })
  .strict();
type PartsList = z.infer<typeof PartsListSchema>;

type Manifest = PortableManifest;
const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

/**
 * Test seam: called with a step label after the previous split-archive members
 * have been moved aside, so a regression test can simulate an in-process failure
 * at that exact point (a throw stands in for the failure), and again with
 * `'restore-member'` after the first member of a restore is published, so a test
 * can mutate the destination between copy-loop iterations. Production never sets
 * it.
 */
let archiveStepHook: ((step: string) => Promise<void> | void) | undefined;
export function setArchiveStepHookForTest(hook?: (step: string) => Promise<void> | void): void {
  archiveStepHook = hook;
}

/** What a parsed manifest declares about the archive members that follow it. */
function declarationOf(manifest: Manifest, manifestBytes: number, maxContent: number): ArchiveDeclaration {
  const members = new Map<string, number>();
  let contentBytes = manifestBytes;
  for (const file of manifest.files) {
    const limit = archiveEntryLimit(file.path, maxContent);
    if (file.bytes > limit)
      throw new Error(`Archive manifest declares an over-limit member (${limit} bytes): ${file.path}`);
    members.set(file.path, file.bytes);
    contentBytes += file.bytes;
  }
  if (contentBytes > maxContent)
    throw new Error(
      `Archive declares ${contentBytes} content bytes, above the ${maxContent}-byte cap; raise it explicitly with --max-content`,
    );
  return { contentBytes, decodedBytes: decodedBytesFor([manifestBytes, ...members.values()]), members };
}

function parseManifest(bytes: Buffer, allowNonRedistributable = false): Manifest {
  if (bytes.length > ARCHIVE_LIMITS.manifestBytes) throw new Error('Archive portable manifest exceeds its byte limit');
  const manifest = PortableManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  if (manifest.files.length + 1 > ARCHIVE_LIMITS.entries || manifest.snapshotAssets.length > ARCHIVE_LIMITS.entries)
    throw new Error('Archive manifest exceeds its entry limit');
  for (const [label, ids] of [
    ['Build', manifest.builds],
    ['Artifact', manifest.artifacts],
  ] as const) {
    if (ids.length > ARCHIVE_LIMITS.entries || new Set(ids).size !== ids.length)
      throw new Error(`Archive manifest has excessive or duplicate ${label} identities`);
  }
  if (manifest.files.some(file => file.path === ARCHIVE_MANIFEST))
    throw new Error('Archive manifest cannot list itself');
  assertArchivePaths([
    ARCHIVE_MANIFEST,
    ...manifest.files.map(file => file.path),
    ...manifest.snapshotAssets.map(asset => asset.path),
  ]);
  const files = new Map(manifest.files.map(file => [file.path, file]));
  if (files.get('project.json')?.provenance.kind !== 'project')
    throw new Error('Archive manifest must identify project.json as authored Project state');
  const content = new Set<string>();
  for (const asset of manifest.snapshotAssets) {
    const file = files.get(asset.content);
    if (!file || file.sha256 !== asset.sha256 || file.provenance.kind !== 'snapshot-content')
      throw new Error(`Archive frozen Asset content mapping is invalid: ${asset.path}`);
    if (!allowNonRedistributable && !asset.provenance.rights.redistributable)
      throw new Error(`Archive frozen Asset ${asset.provenance.assetId} is not redistributable`);
    content.add(asset.content);
  }
  for (const file of manifest.files) {
    if (file.provenance.kind === 'asset' && !allowNonRedistributable && !file.provenance.rights.redistributable)
      throw new Error(`Archive Asset ${file.provenance.assetId} is not redistributable`);
    if (
      file.provenance.kind === 'original' &&
      file.provenance.rights !== undefined &&
      !allowNonRedistributable &&
      !file.provenance.rights.redistributable
    )
      throw new Error(`Archive provider original (sha256 ${file.provenance.sha256}) is not redistributable`);
    if (file.provenance.kind === 'snapshot-content' && !content.has(file.path))
      throw new Error(`Archive contains an unreferenced frozen Asset blob: ${file.path}`);
  }
  return manifest;
}

function semanticManifest(manifest: Manifest): unknown {
  return {
    format: manifest.format,
    version: manifest.version,
    schemaVersion: manifest.schemaVersion,
    project: manifest.project,
    simulated: manifest.simulated,
    builds: [...manifest.builds].sort(byteOrder),
    artifacts: [...manifest.artifacts].sort(byteOrder),
    files: [...manifest.files].sort((a, b) => byteOrder(a.path, b.path)),
    snapshotAssets: [...manifest.snapshotAssets].sort((a, b) => byteOrder(a.path, b.path)),
    // The recorded scope is part of the contract: a restricted package
    // (e.g. `allow-missing-originals`) must validate against ITS OWN scope, not
    // the default, so it is never falsely reported as corrupt on restore.
    scope: manifest.scope,
  };
}

async function regularFiles(root: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await regularFiles(root, relative)));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Archive project contains a link or special file: ${relative}`);
    if (files.length > ARCHIVE_LIMITS.entries) throw new Error('Archive project exceeds its entry limit');
  }
  return files;
}

async function manifestEntries(root: string, manifest: Manifest, maxContent: number): Promise<ArchiveEntry[]> {
  const expected = [ARCHIVE_MANIFEST, ...manifest.files.map(file => file.path)];
  const actual = await regularFiles(root);
  if (stableHash(actual.sort(byteOrder)) !== stableHash([...expected].sort(byteOrder)))
    throw new Error('Archive physical files do not exactly match the portable manifest');
  const listed = new Map(manifest.files.map(file => [file.path, file]));
  let contentBytes = 0;
  const entries: ArchiveEntry[] = [];
  for (const relative of expected) {
    const absolute = path.join(root, relative);
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Archive member is not a regular file: ${relative}`);
    if (info.size > archiveEntryLimit(relative, maxContent))
      throw new Error(`Archive member exceeds its byte limit: ${relative}`);
    contentBytes += info.size;
    if (contentBytes > maxContent)
      throw new Error(
        `Archive project content exceeds the ${maxContent}-byte cap; raise it explicitly with --max-content`,
      );
    const file = listed.get(relative);
    if (file && file.bytes !== info.size)
      throw new Error(`Archive member size does not match the portable manifest: ${relative}`);
    const sha256 = await hashArchiveFile(absolute);
    if (file && file.sha256 !== sha256)
      throw new Error(`Archive member hash does not match the portable manifest: ${relative}`);
    entries.push({ path: relative, bytes: info.size, sha256 });
  }
  return entries;
}

async function readManifest(root: string, allowNonRedistributable: boolean): Promise<Manifest> {
  const file = path.join(root, ARCHIVE_MANIFEST);
  const info = await lstat(file);
  if (!info.isFile() || info.size > ARCHIVE_LIMITS.manifestBytes)
    throw new Error('Archive portable manifest is not a bounded regular file');
  return parseManifest(await readFile(file), allowNonRedistributable);
}

async function validateSemantics(
  root: string,
  validation: string,
  manifest: Manifest,
  allowNonRedistributable: boolean,
): Promise<void> {
  // Export validates actual current/frozen sources, rights, recordings and producer
  // lineage. Success alone is insufficient: extra manifest entries may be pruned.
  const project = await loadProject(root);
  const projects = [project];
  for (const file of manifest.files.filter(file => /^\.viscraft\/snapshots\/[^/]+\.project\.json$/.test(file.path))) {
    projects.push(validateProject(JSON.parse(await readFile(path.join(root, file.path), 'utf8'))));
  }
  for (const authored of projects)
    for (const source of authored.sources) {
      if (source.kind !== 'browser' || source.output !== 'picture' || !source.recording) continue;
      const paths =
        authored === project
          ? [source.recording]
          : manifest.files.filter(file => file.path.endsWith(`/${source.recording}`)).map(file => file.path);
      for (const relative of paths)
        if ((await lstat(path.join(root, relative))).size > ARCHIVE_LIMITS.recordingBytes)
          throw new Error(`Archive recording exceeds its metadata limit: ${relative}`);
    }
  await exportProject(root, validation, {
    allowNonRedistributable,
    // Re-export with the RECORDED scope so a restricted package validates against
    // what it actually carries rather than the default full scope.
    includeOriginals: manifest.scope.includeOriginals,
    allowMissingOriginals: manifest.scope.requested === 'allow-missing-originals',
    allowIncompleteAuthored: manifest.scope.authoredScope === 'allow-incomplete',
    // Replay the exact requested additional versions so the re-export carries the
    // same Build ids and the manifest matches. `requestedVersions` holds resolved
    // stable Build ids, so a plain list reproduces the recorded union.
    extraVersions: manifest.scope.requestedVersions,
  });
  const canonical = await readManifest(validation, allowNonRedistributable);
  if (stableHash(semanticManifest(canonical)) !== stableHash(semanticManifest(manifest)))
    throw new Error('Archive portable manifest does not match the actual authored and production dependency closure');
}

/** Make a restricted gzip/USTAR transport of a newly verified portable v1 export. */
export async function archiveProject(
  root: string,
  destination?: string,
  options: ArchiveOptions = {},
): Promise<ArchiveResult> {
  const maxContent = options.maxContent ?? DEFAULT_MAX_CONTENT_BYTES;
  const allowNonRedistributable = options.allowNonRedistributable === true;
  assertMaxContent(maxContent);
  if (options.partSize !== undefined && (!Number.isSafeInteger(options.partSize) || options.partSize <= 0))
    throw new Error('Archive part size must be a positive whole number of bytes');
  const rootReal = await realpath(root);
  const project = validateProject(JSON.parse(await readFile(path.join(rootReal, 'project.json'), 'utf8')));
  const split = options.partSize !== undefined;
  const defaultName = `${project.id}.tar.gz`;
  // Fixed default name inside output/. A repeat archive replaces the previous
  // default only when it is a recorded Runtime delivery whose recorded archive
  // hash is unchanged (for a split archive, the concatenated hash of the actual
  // part files, so a changed or missing member is seen); otherwise it is refused.
  let replaceDefault = false;
  const currentArchiveHash = (): Promise<string | null> =>
    split ? existingArchiveHash(`${destination as string}${PARTS_SUFFIX}`) : currentFileHash(destination as string);
  const proveUnmodified = async (): Promise<void> => {
    // The concatenated hash already read every part's actual bytes; a null
    // result means a part is missing, which the caller turns into a refusal.
    if ((await currentArchiveHash()) === null) throw new Error('altered: archive part is missing');
  };
  // The complete replace-protection check. Run at the gate and AGAIN right before
  // the swap: an archive swapped for a different-but-valid one during production
  // is only caught by re-comparing against the RECORDED hash — reading the bytes
  // (for a non-null result) alone cannot see a coherent replacement. A
  // published-but-unrecorded archive from an interrupted earlier archive (our own
  // recovery marker) is accepted as ours so re-archiving to the same default
  // succeeds after a crash.
  const assertReplaceable = async (): Promise<void> => {
    if (await pendingDeliveryAcceptable(rootReal, defaultName, 'archive', currentArchiveHash)) {
      await proveUnmodified();
      return;
    }
    await assertReplaceableDefault(rootReal, defaultName, 'archive', currentArchiveHash, proveUnmodified);
  };
  if (destination === undefined) {
    destination = await defaultDeliveryPath(rootReal, defaultName);
    const target = split ? `${destination}${PARTS_SUFFIX}` : destination;
    replaceDefault = await exists(target);
    if (replaceDefault) await assertReplaceable();
  }
  const { destReal, parentReal } = await resolveDestination(destination, rootReal, {
    allowExisting: replaceDefault && !split,
  });
  const work = await mkdtemp(path.join(parentReal, '.viscraft-archive-'));
  try {
    const exported = path.join(work, 'project');
    const releaseBuild = await acquireLock(rootReal, 'build');
    try {
      const releaseAuthor = await acquireLock(rootReal, 'author');
      try {
        await exportProject(rootReal, exported, {
          allowNonRedistributable,
          ...(options.includeOriginals !== undefined ? { includeOriginals: options.includeOriginals } : {}),
          ...(options.allowMissingOriginals !== undefined
            ? { allowMissingOriginals: options.allowMissingOriginals }
            : {}),
          ...(options.allowIncompleteAuthored !== undefined
            ? { allowIncompleteAuthored: options.allowIncompleteAuthored }
            : {}),
          ...(options.extraVersions !== undefined ? { extraVersions: options.extraVersions } : {}),
        });
      } finally {
        await releaseAuthor();
      }
    } finally {
      await releaseBuild();
    }
    const manifest = await readManifest(exported, allowNonRedistributable);
    const entries = await manifestEntries(exported, manifest, maxContent);
    await validateSemantics(exported, path.join(work, 'validation'), manifest, allowNonRedistributable);
    const temporary = path.join(work, 'project.tar.gz');
    const sizes = await writeArchiveTransport(exported, temporary, entries, maxContent);
    const sha256 = await hashArchiveFile(temporary);
    const result = {
      sha256,
      compressedBytes: sizes.compressedBytes,
      contentBytes: sizes.contentBytes,
      files: manifest.files.length,
      simulated: manifest.simulated,
    };
    if (!split) {
      // Recovery marker immediately before the publish (after the replace
      // re-check): a crash between the publish and the durable record then leaves
      // an entry the next archive recognizes as its own.
      const record = archiveRecord(rootReal, destReal, destReal, project.revision, sha256);
      if (replaceDefault) {
        // Full re-check immediately before the swap (recorded hash + members):
        // a coherent replacement is caught only by the recorded hash.
        await assertReplaceable();
        if (record) await markDeliveryPending(rootReal, record);
        // `rename` over an existing file is an atomic replace on the same
        // filesystem; the previous default archive is superseded, not merged.
        await rename(temporary, destReal);
      } else {
        if (record) await markDeliveryPending(rootReal, record);
        // link is the atomic EEXIST/no-replace gate. These immutable published
        // bytes are never modified, and the private name is removed immediately.
        await link(temporary, destReal);
        await unlink(temporary);
      }
      if (record) {
        await writeDeliveryRecord(rootReal, record);
        await clearDeliveryPending(rootReal, record.name);
      }
      return { path: destReal, ...result };
    }
    const parts = await splitArchive(temporary, work, path.basename(destReal), options.partSize!);
    const list: PartsList = {
      format: 'viscraft-archive-parts',
      version: 1,
      projectId: manifest.project.id,
      revision: manifest.project.revision,
      archive: { sha256, bytes: sizes.compressedBytes },
      parts,
    };
    const listPath = `${destReal}${PARTS_SUFFIX}`;
    await writeFile(path.join(work, 'parts.json'), `${JSON.stringify(list, null, 2)}\n`, { mode: 0o644 });
    const record = archiveRecord(rootReal, destReal, listPath, project.revision, sha256);
    // Replace order (mirrors the single-file branch): the durable pending marker
    // is written BEFORE any destructive move, so a write failure during the
    // replacement leaves either no marker (nothing moved) or a marker the next
    // archive can resolve — never the previous parts renamed aside with no record.
    if (replaceDefault) {
      // Full re-check immediately before moving the old parts aside (recorded
      // hash + members): a coherent replacement is caught only by the hash.
      await assertReplaceable();
    }
    if (record) await markDeliveryPending(rootReal, record);
    // Move the previous members aside so their names are free. A failure PART-WAY
    // through the move restores everything already moved (in reverse order) and
    // clears the pending marker before rethrowing, so the previous archive is
    // left fully intact and replaceable.
    const aside: Array<{ from: string; to: string }> = [];
    if (replaceDefault) {
      const previous = await readPartsList(listPath);
      try {
        for (const file of [listPath, ...previous.files]) {
          const moved = `${file}.${randomUUID()}.old`;
          await rename(file, moved);
          aside.push({ from: file, to: moved });
        }
        await archiveStepHook?.('aside-moved');
      } catch (error) {
        for (let index = aside.length - 1; index >= 0; index--) {
          const { from, to } = aside[index];
          await rename(to, from).catch(() => {});
        }
        if (record) await clearDeliveryPending(rootReal, record.name).catch(() => {});
        throw error;
      }
    }
    // Publish every part first and the list last; on any clash remove what we published.
    const published: string[] = [];
    try {
      for (const part of parts) {
        const file = path.join(parentReal, part.name);
        await link(path.join(work, part.name), file);
        published.push(file);
      }
      await link(path.join(work, 'parts.json'), listPath);
    } catch (error) {
      for (const file of published) await unlink(file).catch(() => {});
      for (let index = aside.length - 1; index >= 0; index--) {
        const { from, to } = aside[index];
        await rename(to, from).catch(() => {});
      }
      throw error;
    }
    for (const { to } of aside) await rm(to, { force: true });
    if (record) {
      await writeDeliveryRecord(rootReal, record);
      await clearDeliveryPending(rootReal, record.name);
    }
    return { path: listPath, ...result, parts };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Hash of a previous single-file archive, or null when it is missing. */
async function currentFileHash(file: string): Promise<string | null> {
  try {
    return await hashArchiveFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Concatenated hash of a previous split archive (via its verified parts list), or null. */
async function existingArchiveHash(listPath: string): Promise<string | null> {
  try {
    const { files } = await readPartsList(listPath);
    return await hashConcatenated(files);
  } catch {
    return null;
  }
}

/**
 * Build the delivery record for an archive delivered directly into output/
 * (`name` is the `.tar.gz` stem; `produced` is the file actually published, i.e.
 * the parts list for a split archive). The record makes a completed archive
 * live-queryable via `status.outputs` and lets a consumer resolve the WHOLE
 * split group: `name` is the recorded stem and `path` is the `output/`-relative
 * parts list, whose parsed `parts` name every shard — so `clean` selects the
 * group by the real list and never leaves orphaned shards or touches a
 * same-prefix non-member. Returns null when the destination is not a direct
 * child of `output/` (an explicit destination is never recorded).
 */
function archiveRecord(
  rootReal: string,
  destReal: string,
  produced: string,
  revision: number,
  manifestSha256: string,
): DeliveryRecord | null {
  const name = outputRecordName(rootReal, destReal);
  if (!name) return null;
  const relative = path.relative(path.join(rootReal, 'output'), produced).split(path.sep).join('/');
  return {
    name,
    ...(relative !== name ? { path: relative } : {}),

    kind: 'archive',
    revision,
    deliveredAt: new Date().toISOString(),
    manifestSha256,
  };
}

/** Cut `archive` into `<name>.part-001…` files of at most `partSize` bytes inside `work`. */
async function splitArchive(archive: string, work: string, name: string, partSize: number): Promise<ArchivePart[]> {
  const total = (await lstat(archive)).size;
  const count = Math.max(1, Math.ceil(total / partSize));
  const width = Math.max(3, String(count).length);
  const parts: ArchivePart[] = [];
  for (let index = 0; index < count; index++) {
    const partName = `${name}.part-${String(index + 1).padStart(width, '0')}`;
    const start = index * partSize;
    const end = Math.min(total, start + partSize) - 1;
    const hash = createHash('sha256');
    const source = createReadStream(archive, { start, end });
    const out = createWriteStream(path.join(work, partName), { flags: 'wx', mode: 0o644 });
    await new Promise<void>((resolve, reject) => {
      source.on('data', chunk => hash.update(chunk as Buffer));
      source.once('error', reject);
      out.once('error', reject);
      out.once('close', resolve);
      source.pipe(out);
    });
    parts.push({ name: partName, sha256: hash.digest('hex'), bytes: end - start + 1 });
  }
  return parts;
}

/** Hash several files as one concatenated stream. */
async function hashConcatenated(files: readonly string[]): Promise<string> {
  const hash = createHash('sha256');
  for (const file of files) for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Verify a parts list before any decoding: every part present as a regular file
 * beside the list, in order, with its recorded size and hash, and the whole
 * concatenation equal to the recorded archive. Missing, corrupt, reordered or
 * foreign parts are refused by name.
 */
async function readPartsList(listPath: string): Promise<{ list: PartsList; files: string[] }> {
  const info = await lstat(listPath);
  if (!info.isFile() || info.size > ARCHIVE_LIMITS.metadataBytes)
    throw new Error('Archive parts list must be a bounded regular file');
  const list = PartsListSchema.parse(JSON.parse(await readFile(listPath, 'utf8')));
  const base = path.basename(listPath).slice(0, -PARTS_SUFFIX.length);
  const width = Math.max(3, String(list.parts.length).length);
  const directory = path.dirname(listPath);
  const files: string[] = [];
  let total = 0;
  for (const [index, part] of list.parts.entries()) {
    const expected = `${base}.part-${String(index + 1).padStart(width, '0')}`;
    if (part.name !== expected)
      throw new Error(`Archive parts list is out of order: expected ${expected}, found ${part.name}`);
    const file = path.join(directory, part.name);
    let partInfo;
    try {
      partInfo = await lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Archive part is missing: ${part.name}`);
      throw error;
    }
    if (!partInfo.isFile() || partInfo.isSymbolicLink())
      throw new Error(`Archive part is not a regular file: ${part.name}`);
    if (partInfo.size !== part.bytes)
      throw new Error(`Archive part ${part.name} is ${partInfo.size} bytes; the parts list records ${part.bytes}`);
    if ((await hashArchiveFile(file)) !== part.sha256)
      throw new Error(`Archive part ${part.name} does not match its recorded hash (corrupt or from another archive)`);
    files.push(file);
    total += part.bytes;
  }
  if (total !== list.archive.bytes)
    throw new Error(`Archive parts total ${total} bytes; the parts list records ${list.archive.bytes}`);
  if ((await hashConcatenated(files)) !== list.archive.sha256)
    throw new Error('Archive parts do not concatenate to the recorded archive hash');
  return { list, files };
}

/**
 * Restore only this Runtime's verified portable v1 USTAR subset. No code executes.
 * The destination parent must be trusted. An exclusive mkdir prevents cooperative
 * no-clobber races; publication is not whole-directory atomic. project.json is
 * written last. A process kill may leave an incomplete newly owned directory.
 */
export async function restoreProject(
  archive: string,
  destination: string,
  options: RestoreOptions = {},
): Promise<ArchiveResult> {
  const maxContent = options.maxContent ?? DEFAULT_MAX_CONTENT_BYTES;
  assertMaxContent(maxContent);
  const inputAbsolute = path.resolve(archive);
  // The caller-selected parent may use a system alias. Canonicalize it while
  // still rejecting a symbolic-link archive file and linked declared parts.
  const input = path.join(await realpath(path.dirname(inputAbsolute)), path.basename(inputAbsolute));
  const inputInfo = await lstat(input);
  if (!inputInfo.isFile() || inputInfo.isSymbolicLink())
    throw new Error('Project archive input must be a regular file without symbolic links');
  const split = input.endsWith(PARTS_SUFFIX) ? await readPartsList(input) : null;
  const files = split ? split.files : [input];
  const { destReal, parentReal } = await resolveDestination(destination, input);
  const work = await mkdtemp(path.join(parentReal, '.viscraft-restore-'));
  // 64-bit identity, kept as bigint: on file systems with >2^53 inodes (e.g.
  // Lustre) a JS number loses low bits and two DIFFERENT directories can compare
  // equal, which would let a failed ownership check recursively delete a
  // directory this restore does not own.
  let owned: { dev: bigint; ino: bigint } | undefined;
  const stillOwned = async (): Promise<boolean> => {
    if (!owned) return false;
    try {
      const info = await lstat(destReal, { bigint: true });
      return info.isDirectory() && !info.isSymbolicLink() && info.dev === owned.dev && info.ino === owned.ino;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };
  try {
    const extracted = path.join(work, 'project');
    await mkdir(extracted, { mode: 0o700 });
    const beforeHash = split ? split.list.archive.sha256 : await hashArchiveFile(input);
    let manifest: Manifest | undefined;
    let approved = new Map<string, Manifest['files'][number]>();
    const transport = await readArchiveTransport(
      files,
      extracted,
      async (entry, data) => {
        if (!manifest) {
          if (entry.path !== ARCHIVE_MANIFEST || !data)
            throw new Error('Project archive must begin with its portable manifest');
          manifest = parseManifest(data, true);
          if (
            split &&
            (manifest.project.id !== split.list.projectId || manifest.project.revision !== split.list.revision)
          )
            throw new Error('Archive parts list names a different project or revision than the archive manifest');
          approved = new Map(manifest.files.map(file => [file.path, file]));
          return declarationOf(manifest, data.length, maxContent);
        }
        const file = approved.get(entry.path);
        if (!file || file.sha256 !== entry.sha256)
          throw new Error(`Archive member is unlisted or has a mismatched hash: ${entry.path}`);
        approved.delete(entry.path);
      },
      { maxContentBytes: maxContent, compressedBytes: split?.list.archive.bytes },
    );
    if (!manifest || approved.size !== 0) throw new Error('Project archive is missing portable manifest members');
    const afterHash = split ? await hashConcatenated(files) : await hashArchiveFile(input);
    if (afterHash !== beforeHash) throw new Error('Project archive changed while restoring');
    await manifestEntries(extracted, manifest, maxContent);
    // The rights gate belongs to packaging, not to verifying an archive that
    // already exists: restore re-checks internal consistency, so it never
    // re-gates a non-redistributable Asset the archive legitimately carries.
    await validateSemantics(extracted, path.join(work, 'validation'), manifest, true);
    await mkdir(destReal, { mode: 0o700 });
    const claimed = await lstat(destReal, { bigint: true });
    owned = { dev: claimed.dev, ino: claimed.ino };
    const order = [
      ...manifest.files
        .map(file => file.path)
        .filter(file => file !== 'project.json')
        .sort(byteOrder),
      ARCHIVE_MANIFEST,
      'project.json',
    ];
    let publishedMembers = 0;
    for (const relative of order) {
      if (!(await stillOwned())) throw new Error('Restore destination was replaced during publication');
      const target = path.join(destReal, relative);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(path.join(extracted, relative), target, constants.COPYFILE_EXCL);
      if ((await hashArchiveFile(target)) !== (await hashArchiveFile(path.join(extracted, relative))))
        throw new Error(`Restored member failed hash verification: ${relative}`);
      // Deterministic seam between two loop iterations, before the next
      // stillOwned() check: lets a regression test mutate the destination at an
      // exact point. A no-op in production.
      if (++publishedMembers === 1) await archiveStepHook?.('restore-member');
    }
    await manifestEntries(destReal, manifest, maxContent);
    if (!(await stillOwned())) throw new Error('Restore destination was replaced during publication');
    return {
      path: destReal,
      sha256: beforeHash,
      compressedBytes: transport.compressedBytes,
      contentBytes: transport.contentBytes,
      files: manifest.files.length,
      simulated: manifest.simulated,
    };
  } catch (error) {
    if (await stillOwned()) await rm(destReal, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
