import {
  type DeliveryVerification,
  DELIVERY_MANIFEST,
  DeliveryManifestSchema,
  type DeliveryMismatch,
} from './delivery-contract.js';
import { realpath, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathExists, walkFiles } from './delivery-files.js';
import { hashFile } from '../../shared/hash.js';

/**
 * Verify a delivered bundle against its own `delivery-manifest.json`.
 *
 * This is the inverse of `deliverProject`: it re-reads the manifest, re-hashes
 * every listed file and walks the bundle for anything the manifest does not
 * account for. It makes no attempt to repair or mutate the bundle — a bundle
 * that fails verification is reported, never fixed in place.
 *
 * Ordering matters for honesty: the manifest's own shape is validated FIRST, so
 * a malformed, truncated or non-bundle directory throws rather than being read
 * as a bundle with an empty allowlist (which would otherwise look "ok").
 */
export async function verifyDelivery(bundleDirectory: string): Promise<DeliveryVerification> {
  let bundleReal: string;
  try {
    bundleReal = await realpath(bundleDirectory);
  } catch {
    throw new Error(`delivery: bundle directory does not exist: ${bundleDirectory}`);
  }

  const manifestPath = path.join(bundleReal, DELIVERY_MANIFEST);
  if (!(await pathExists(manifestPath)))
    throw new Error(`delivery: no ${DELIVERY_MANIFEST} in bundle directory: ${bundleDirectory}`);

  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`delivery: ${DELIVERY_MANIFEST} is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = DeliveryManifestSchema.safeParse(manifestRaw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new Error(`delivery: malformed ${DELIVERY_MANIFEST}: ${issues}`);
  }
  const manifest = parsed.data;

  const listed = new Set<string>();
  for (const file of manifest.files) {
    if (listed.has(file.path))
      throw new Error(`delivery: malformed ${DELIVERY_MANIFEST}: duplicate listed path ${file.path}`);
    listed.add(file.path);
  }

  const soundTargets = new Set<string>();
  for (const sound of manifest.sounds) {
    const file = manifest.files.find(candidate => candidate.path === sound.path);
    if (
      soundTargets.has(sound.target) ||
      sound.path !== `sound/${sound.target}.wav` ||
      !file ||
      file.role !== 'audio' ||
      file.sha256 !== sound.sha256 ||
      file.bytes !== sound.bytes
    )
      throw new Error(`delivery: malformed sound product ${JSON.stringify(sound.target)}`);
    soundTargets.add(sound.target);
  }
  const mismatched: DeliveryMismatch[] = [];
  const missing: string[] = [];
  let verified = 0;
  for (const file of manifest.files) {
    const absolute = path.join(bundleReal, ...file.path.split('/'));
    if (!(await pathExists(absolute))) {
      missing.push(file.path);
      continue;
    }
    const actual = await hashFile(absolute);
    if (actual === file.sha256) verified += 1;
    else mismatched.push({ path: file.path, expected: file.sha256, actual });
  }

  const present = await walkFiles(bundleReal);
  const unlisted = present.filter(file => file !== DELIVERY_MANIFEST && !listed.has(file));

  return {
    path: bundleReal,
    manifest: DELIVERY_MANIFEST,
    manifestSha256: await hashFile(manifestPath),
    format: manifest.format,
    version: manifest.version,
    exportedAt: manifest.exportedAt,
    listed: manifest.files.length,
    verified,
    mismatched,
    missing,
    unlisted,
    ok: mismatched.length === 0 && missing.length === 0 && unlisted.length === 0,
  };
}
