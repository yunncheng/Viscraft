/**
 * Current-code Asset refresh (project layer).
 *
 * A `code` Asset records the bytes of an authored file (a scene, module or
 * document) so Builds and exports can freeze them. When the author edits that
 * file directly, the registration can legitimately become stale; this module is
 * the ONE explicit way to record the CURRENT bytes again. It never writes the
 * authored file, never changes an Asset's type/rights/provenance, and never
 * rebinds a child's frozen `inputs`.
 *
 * The shared `updateCodeAssetsForPath` leaf is also used by the workbench save
 * path, so both writers apply one truthful rule: EVERY current `code` Asset at
 * the same authored path is advanced to the same bytes; an Asset already at
 * those bytes is left untouched (no revision bump).
 */
import type { Asset, Project } from '../core/schema.js';
import { resolveProjectPath } from '../shared/fs.js';
import { hashFile } from '../shared/hash.js';
import { withAuthorLock } from './project.js';

export interface RefreshCodeAssetOptions {
  /** The existing code Asset whose authored file is the current registration. */
  assetId: string;
  /** The Project revision the caller read; a concurrent edit is a conflict. */
  expectedRevision: number;
}

/**
 * Record `sha256` for every CURRENT `code` Asset whose `path` is `path`, in
 * place. Returns how many Asset identities changed. No other type, no rights,
 * inputs, derivedFrom, simulated or image-generation provenance is touched.
 */
export function updateCodeAssetsForPath(project: Project, path: string, sha256: string): number {
  let changed = 0;
  for (const asset of project.assets) {
    if (asset.type !== 'code' || asset.path !== path || asset.sha256 === sha256) continue;
    asset.revision += 1;
    asset.sha256 = sha256;
    changed += 1;
  }
  return changed;
}

/**
 * Explicitly re-record the current authored bytes of one `code` Asset.
 *
 * Runs under the existing author lock: the Project revision must still be the
 * one the caller read, the Asset must still exist and be a `code` Asset, and
 * the authored file's bytes must be stable before `project.json` is committed.
 * Same bytes is a no-op (no Project or Asset revision). Old Build snapshots are
 * untouched; a child that froze the previous parent identity keeps that frozen
 * identity rather than being silently rebound.
 */
export async function refreshCodeAsset(root: string, options: RefreshCodeAssetOptions): Promise<Asset> {
  if (!options || typeof options !== 'object')
    throw new Error('refreshCodeAsset requires { assetId, expectedRevision }');
  const { assetId, expectedRevision } = options;
  if (typeof assetId !== 'string' || assetId.length === 0)
    throw new Error('refreshCodeAsset requires a non-empty assetId');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0)
    throw new Error('refreshCodeAsset requires a positive integer expectedRevision');
  return withAuthorLock(root, async (current, commit) => {
    if (current.revision !== expectedRevision)
      throw new Error(`Source revision conflict: expected ${expectedRevision}, found ${current.revision}`);
    const asset = current.assets.find(candidate => candidate.id === assetId);
    if (!asset) throw new Error(`Asset ${assetId} does not exist`);
    if (asset.type !== 'code')
      throw new Error(
        `Asset ${assetId} is a ${asset.type} Asset; only a code Asset can be refreshed from an authored file`,
      );
    const absolute = await resolveProjectPath(root, asset.path);
    const sha256 = await hashFile(absolute);
    const next = structuredClone(current);
    if (updateCodeAssetsForPath(next, asset.path, sha256) === 0) return asset;
    // The authored file is not ours to write; if it changed while we were
    // preparing the commit, refuse rather than record bytes that no longer exist.
    if ((await hashFile(absolute)) !== sha256)
      throw new Error(`Authored file ${asset.path} changed while refreshing Asset ${assetId}; retry`);
    const saved = await commit(next);
    return saved.assets.find(candidate => candidate.id === assetId)!;
  });
}
