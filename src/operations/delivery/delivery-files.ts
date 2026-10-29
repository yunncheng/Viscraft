import { lstat, readdir, link, rename, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import { type Project, type Asset } from '../../core/schema.js';
import { type DeliveryOutputs, type ResolvedSelection, type Planned } from './delivery-contract.js';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { scanHandoffFile } from './handoff.js';
import { randomUUID } from 'node:crypto';

export async function pathExists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** True when `child` is strictly inside `parent` (not equal, not an ancestor). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Resolve the delivered PRODUCT set. Omitting `outputs` is the convenient
 * default (every declared output); an explicit object selects exactly the
 * entries it names, so `{ images: ['poster'] }` never ships a movie. A
 * selection that names nothing, an unknown target, or a non-array is refused
 * here rather than silently widened.
 */
export function resolveOutputSelection(project: Project, outputs: DeliveryOutputs | undefined): ResolvedSelection {
  const selected: ResolvedSelection = {
    movie: outputs === undefined ? project.composition !== undefined : outputs.movie === true,
    images: [
      ...new Set(outputs === undefined ? project.imageTargets.map(target => target.id) : (outputs.images ?? [])),
    ].sort(),
    sounds: [
      ...new Set(outputs === undefined ? project.soundTargets.map(target => target.id) : (outputs.sounds ?? [])),
    ].sort(),
  };
  for (const id of selected.images)
    if (!project.imageTargets.some(target => target.id === id))
      throw new Error(`delivery: unknown image target ${JSON.stringify(id)}`);
  for (const id of selected.sounds)
    if (!project.soundTargets.some(target => target.id === id))
      throw new Error(`delivery: unknown sound target ${JSON.stringify(id)}`);
  if (!selected.movie && selected.images.length === 0 && selected.sounds.length === 0)
    throw new Error(
      'delivery: outputs select nothing; the Project must declare a composition or selected image/sound targets',
    );
  return selected;
}

/**
 * Walk a directory tree and return every regular-file path relative to `root`,
 * using `/` separators. Symlinks and special files are rejected rather than
 * followed, so a bundle can never escape the staging directory.
 */
export async function walkFiles(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(root, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`delivery: symbolic links are not allowed in a delivery bundle: ${relative}`);
    if (entry.isDirectory()) out.push(...(await walkFiles(absolute, relative)));
    else if (entry.isFile()) out.push(relative);
    else throw new Error(`delivery: unsupported file type in delivery bundle: ${relative}`);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

export function assertSameSet(actual: string[], expected: Set<string>, label: string): void {
  const seen = new Set(actual);
  const extra = actual.filter(file => !expected.has(file));
  const missing = [...expected].filter(file => !seen.has(file));
  if (extra.length === 0 && missing.length === 0) return;
  throw new Error(
    `delivery: ${label} file set mismatch${extra.length ? `; unexpected: ${extra.join(', ')}` : ''}${missing.length ? `; missing: ${missing.join(', ')}` : ''}`,
  );
}

/**
 * Local absolute paths a receiver cannot use: this Project root, the user's
 * home directory, and the Runtime install location. Mirrors the list
 * `checkHandoff` already uses so both checks agree on what "local" means.
 */
function localMachinePaths(rootReal: string): string[] {
  try {
    return [rootReal, os.homedir(), fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '')].filter(
      value => value.length > 1,
    );
  } catch {
    return [rootReal];
  }
}

/**
 * Report-only scan of the handoff text files that enter the bundle (their
 * portable-manifest provenance is `handoff`). Reads the STAGED bytes, decodes
 * UTF-8 only, and returns human-readable diagnostics — never a throw, so the
 * delivery still completes.
 */
export async function scanBundleDiagnostics(
  staging: string,
  planned: Map<string, Planned>,
  rootReal: string,
): Promise<string[]> {
  const findings: string[] = [];
  for (const [relative, entry] of planned) {
    if ((entry.provenance as { kind?: string } | undefined)?.kind !== 'handoff') continue;
    const scanned = await scanHandoffFile(path.join(staging, ...relative.split('/')), localMachinePaths(rootReal));
    if (scanned.sha256 !== entry.sha256) throw new Error(`delivery: handoff changed during validation: ${relative}`);
    if (scanned.credential) throw new Error(`delivery: handoff ${relative} contains a credential-looking value`);
    for (const local of scanned.localPaths)
      findings.push(`${relative} mentions the local absolute path ${local}; the receiver will not have it`);
  }
  return findings;
}

/**
 * Explicit declared-flag completeness check, NOT a rights judgement: an Asset that
 * asserts `attributionRequired` must actually carry the notice its author says is
 * required. Runs before publishing, so a run that never asserts the flag is
 * unaffected.
 */
export function assertAttributionComplete(assets: readonly Asset[]): void {
  const missing = [
    ...new Set(
      assets
        .filter(asset => asset.rights.attributionRequired === true && !(asset.rights.notice ?? '').trim())
        .map(asset => asset.id),
    ),
  ].sort();
  if (missing.length === 0) return;
  throw new Error(
    `delivery: Asset(s) ${missing.join(', ')} declare rights.attributionRequired but carry no rights.notice; record the required attribution notice on each Asset (this is an author-declared completeness check, not a license judgement)`,
  );
}

/**
 * In-bundle dedup for FROZEN products only: identical bytes are hard-linked to
 * one staged copy inside the bundle (never to an author file), and the shared
 * copy is made read-only. Editable author bytes are never linked.
 */
export async function dedupeFrozenBySha(
  staging: string,
  planned: Map<string, Planned>,
  editable: (relative: string, entry: Planned) => boolean,
): Promise<void> {
  const frozenBySha = new Map<string, string[]>();
  for (const [relative, entry] of planned) {
    if (editable(relative, entry)) continue;
    frozenBySha.set(entry.sha256, [...(frozenBySha.get(entry.sha256) ?? []), relative]);
  }
  for (const paths of frozenBySha.values()) {
    if (paths.length < 2) continue;
    const keeper = path.join(staging, ...paths[0].split('/'));
    let linked = false;
    for (const relative of paths.slice(1)) {
      const target = path.join(staging, ...relative.split('/'));
      const temporary = `${target}.${randomUUID()}.link`;
      try {
        await link(keeper, temporary);
        await rename(temporary, target);
        linked = true;
      } catch {
        await rm(temporary, { force: true });
      }
    }
    if (linked) await chmod(keeper, 0o444);
  }
}
