import { type Asset, type Reference } from '../../core/schema.js';
import { type ReferenceFacts } from './extension.js';
import { resolveProjectPath } from '../../shared/fs.js';
import { runCommand } from '../../shared/process.js';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

/** One ordered reference Asset and the frozen root its bytes are read from. */
export interface VideoReferenceInput {
  asset: Asset;
  root: string;
}

/**
 * Check current bytes when they still exist, while allowing an already-submitted
 * task to resume from its durable record after the authored reference was removed.
 * Existing unreadable or changed bytes are never treated as the frozen Asset.
 */
export async function assertOptionalReferenceBytesMatch(root: string, asset: Asset, label: string): Promise<void> {
  const path = await resolveProjectPath(root, asset.path);
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error(`${label}: current reference Asset '${asset.id}' could not be read safely`, { cause: error });
  }
  const bytesHash = createHash('sha256').update(bytes).digest('hex');
  if (bytesHash !== asset.sha256)
    throw new Error(`${label}: current reference Asset '${asset.id}' bytes do not match its recorded sha256`);
}

/** Read-only local metadata for model/service preflight. Transport separately
 * freezes and hashes the bytes; this helper never uploads or converts input.
 */
export async function referenceFacts(root: string, asset: Asset, reference: Reference): Promise<ReferenceFacts> {
  const path = await resolveProjectPath(root, asset.path);
  const metadata = JSON.parse(
    await runCommand('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'stream=width,height:format=duration,format_name',
      '-of',
      'json',
      path,
    ]),
  ) as { streams?: Array<{ width?: number; height?: number }>; format?: { duration?: string; format_name?: string } };
  const stream = metadata.streams?.find(item => item.width && item.height);
  const duration = Number(metadata.format?.duration);
  return {
    reference,
    bytes: (await stat(path)).size,
    ...(stream ? { width: stream.width, height: stream.height } : {}),
    ...(Number.isFinite(duration) ? { duration } : {}),
    format: metadata.format?.format_name,
  };
}

/** Locator ownership is asserted by the caller; never upload or fetch during
 * validation. The SHA binds that assertion to the frozen local Asset.
 */
export function validateReferenceLocator(
  asset: string,
  sha256: string,
  locator: { url: string; sha256: string },
  fixtureOrigin?: string,
): void {
  if (locator.sha256 !== sha256) throw new Error(`Reference locator ${asset} does not match the frozen Asset sha256`);
  if (/^asset:\/\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(locator.url)) return;
  const url = new URL(locator.url);
  if (url.username || url.password || url.hash)
    throw new Error('Reference locator must not contain credentials or fragments');
  if (fixtureOrigin ? url.origin !== new URL(fixtureOrigin).origin : url.protocol !== 'https:')
    throw new Error('Reference locator needs HTTPS (or the selected loopback fixture in test mode)');
}
