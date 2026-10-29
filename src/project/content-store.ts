/**
 * The Project content store `.viscraft/content/<sha256>`.
 *
 * A Build freezes each authored file by content: the bytes are copied ONCE into
 * the store (verified, then made read-only) and every snapshot path that needs
 * the same bytes is a hard link to that store entry. A snapshot is therefore
 * never linked to an editable original: editing the author file in place cannot
 * change frozen bytes. When the file system refuses a link (cross-device or
 * unsupported) the snapshot falls back to an independent read-only copy.
 *
 * The layout and naming are the same as the Portable export's
 * `.viscraft/content/<sha256>` blobs, so a restored Project and a local Build
 * share one content-addressing scheme.
 *
 * Reference truth comes from records, never from link counts: an entry is
 * referenced while any `<id>.inputs.json` / checkpoint lists its digest, any
 * snapshot path links to it, or a Portable manifest maps a snapshot Asset to it.
 * `nlink` is only used for physical byte accounting.
 */
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, link, lstat, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { hashFile } from '../shared/hash.js';
import { resolveProjectPath } from '../shared/fs.js';

export const CONTENT_DIR = '.viscraft/content';
const DIGEST = /^[a-f0-9]{64}$/;

export function contentPath(sha256: string): string {
  if (!DIGEST.test(sha256)) throw new Error(`Invalid content digest: ${sha256}`);
  return `${CONTENT_DIR}/${sha256}`;
}

/** Test seam: force the link step to fail so the copy fallback is exercised. */
let linkImpl: (existing: string, target: string) => Promise<void> = link;
export function setContentLinkForTest(impl?: (existing: string, target: string) => Promise<void>): void {
  linkImpl = impl ?? link;
}

async function isRegular(file: string): Promise<boolean> {
  try {
    const info = await lstat(file);
    return info.isFile() && !info.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Ensure the store holds `source`'s bytes and return their digest. `expected`
 * (when given) must equal the hash of `source` both before and after the copy,
 * so a file edited while freezing is refused rather than half-frozen.
 * `verified` memoizes store entries already checked during one Build.
 */
export async function storeContent(
  root: string,
  source: string,
  verified: Set<string> = new Set(),
): Promise<{ sha256: string; entry: string }> {
  const before = await hashFile(source);
  const relative = contentPath(before);
  const entry = await resolveProjectPath(root, relative);
  if (verified.has(before)) return { sha256: before, entry };
  await mkdir(path.dirname(entry), { recursive: true });
  if (await isRegular(entry)) {
    if ((await hashFile(entry)) !== before) {
      // A damaged store entry is quarantined (never silently reused) and rebuilt.
      await rename(entry, `${entry}.corrupt-${randomUUID()}`);
    } else {
      verified.add(before);
      return { sha256: before, entry };
    }
  }
  const temporary = `${entry}.${randomUUID()}.tmp`;
  try {
    await copyFile(source, temporary);
    if ((await hashFile(temporary)) !== before || (await hashFile(source)) !== before)
      throw new Error(`Source changed while freezing ${path.basename(source)}; retry after editing is complete`);
    await chmod(temporary, 0o444);
    await rename(temporary, entry);
  } finally {
    await rm(temporary, { force: true });
  }
  verified.add(before);
  return { sha256: before, entry };
}

/**
 * Freeze `<root>/<relative>` into `<snapshotDir>/<relative>` through the store:
 * a hard link to the store entry, or a read-only copy when linking fails.
 * Returns the frozen digest.
 */
export async function freezeFile(
  root: string,
  snapshotDir: string,
  relative: string,
  verified: Set<string> = new Set(),
): Promise<string> {
  const original = await resolveProjectPath(root, relative);
  const destination = await resolveProjectPath(snapshotDir, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  const { sha256, entry } = await storeContent(root, original, verified);
  await rm(destination, { force: true });
  try {
    await linkImpl(entry, destination);
  } catch {
    await copyFile(entry, destination);
    await chmod(destination, 0o444);
  }
  if ((await hashFile(destination)) !== sha256) throw new Error(`Frozen bytes do not match for ${relative}`);
  return sha256;
}
