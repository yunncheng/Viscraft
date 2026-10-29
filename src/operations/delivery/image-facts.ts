import { type BuildRecord, type Project, type Asset } from '../../core/schema.js';
import { imageRenderIdentity } from '../../build/image.js';
import { compareImageEnvironment } from '../../build/image-identity.js';
import {
  type DeliveryWorkbenchEntry,
  type DeliveryImage,
  type DeliveryImageMaterial,
  type DeliveryNonRedistributableAsset,
  RUNTIME_DIR,
  type DeliveryImageMaterialAsset,
  type DeliveryManifest,
  DeliveryImageSchema,
} from './delivery-contract.js';
import path from 'node:path';
import { validateProject } from '../../project/project.js';
import { readFile } from 'node:fs/promises';
import { assertAttributionComplete } from './delivery-files.js';
import { attributionFields } from './delivery-page.js';
import { z } from 'zod';
import { PortableManifestSchema } from './portable-contract.js';

export async function currentImageMatches(root: string, target: string, build: BuildRecord): Promise<boolean> {
  const identity = await imageRenderIdentity(root, target);
  return (
    build.operations.some(operation => operation.kind === 'render-image' && operation.key === identity.key) &&
    compareImageEnvironment(build.environment, {
      facts: identity.environment,
      verified: identity.environmentVerified,
    }) === 'match'
  );
}

/**
 * Reopen metadata for one delivered still. Only a final delivered target gets
 * one; it names the target/document and a portable command, never a live URL or
 * token. `delivery` is the Runtime-recorded `output/` entry, or null when the
 * bundle was written to an explicit destination the Runtime does not manage.
 */
export function deliveryWorkbenchEntry(
  project: Project,
  targetId: string,
  options: { delivery: string | null },
): DeliveryWorkbenchEntry {
  const target = project.imageTargets.find(candidate => candidate.id === targetId);
  if (!target) throw new Error(`delivery: unknown image target ${JSON.stringify(targetId)}`);
  const document = project.imageDocuments.find(candidate => candidate.id === target.document);
  if (!document)
    throw new Error(
      `delivery: image target ${JSON.stringify(targetId)} references unknown image document ${JSON.stringify(target.document)}`,
    );
  const command = `viscraft workbench <project-directory> --document ${document.id} --target ${targetId}${
    options.delivery !== null ? ` --delivery ${options.delivery}` : ''
  }`;
  const note = `This bundle carries the editable project at project/. The command above binds the sender's recorded delivery. On another machine, copy project/ into your own working directory, install the matching Runtime, and start with \`viscraft workbench . --document ${document.id} --target ${targetId}\` without --delivery. To publish edits to a stable file, create your own local delivery with \`viscraft deliver\` before binding its entry. Sender delivery records and live editor sessions do not travel. The static bundle stores no live URL or token and does not sync remotely.`;
  return {
    target: targetId,
    document: document.id,
    documentPath: document.path,
    command,
    editableProject: true,
    note,
  };
}

/**
 * Resolve the frozen material facts for every selected still. `snapshotRoot` is
 * the tree whose `.viscraft/snapshots/<build>.project.json` is authoritative:
 * delivery that also carries the project. The current authored declarations are
 * consulted only for a newly declared restriction and for the attribution
 * completeness check; historical license/notice facts always win.
 */
export async function collectImageMaterialFacts(
  snapshotRoot: string,
  images: readonly DeliveryImage[],
  currentProject: Project,
): Promise<{
  imageMaterials: DeliveryImageMaterial[];
  privateAssets: DeliveryNonRedistributableAsset[];
  simulated: boolean;
}> {
  const imageMaterials: DeliveryImageMaterial[] = [];
  const historicalUsedAssets: Asset[] = [];
  const currentUsedAssets: Asset[] = [];
  for (const image of images) {
    const target = currentProject.imageTargets.find(candidate => candidate.id === image.target);
    if (!target) throw new Error(`delivery: unknown image target ${JSON.stringify(image.target)}`);
    const document = currentProject.imageDocuments.find(candidate => candidate.id === target.document);
    if (!document)
      throw new Error(
        `delivery: image target ${JSON.stringify(image.target)} references unknown image document ${JSON.stringify(target.document)}`,
      );
    const currentUsedPaths = new Set<string>([document.path, ...document.resources]);
    for (const asset of currentProject.assets) if (currentUsedPaths.has(asset.path)) currentUsedAssets.push(asset);

    const frozenPath = path.join(snapshotRoot, RUNTIME_DIR, 'snapshots', `${image.build}.project.json`);
    let frozen: Project;
    try {
      frozen = validateProject(JSON.parse(await readFile(frozenPath, 'utf8')));
    } catch (error) {
      throw new Error(
        `delivery: the frozen snapshot for still Build ${image.build} is missing or unreadable, so the still's rights record cannot be verified: ${(error as Error).message}`,
      );
    }
    const frozenTarget = frozen.imageTargets.find(candidate => candidate.id === image.target);
    const frozenDocument = frozenTarget
      ? frozen.imageDocuments.find(candidate => candidate.id === frozenTarget.document)
      : undefined;
    if (!frozenTarget || !frozenDocument)
      throw new Error(
        `delivery: still Build ${image.build} does not record target ${JSON.stringify(image.target)} and its document`,
      );
    const frozenUsedPaths = new Set<string>([frozenDocument.path, ...frozenDocument.resources]);
    const used = frozen.assets.filter(asset => frozenUsedPaths.has(asset.path));
    historicalUsedAssets.push(...used);

    // Keyed by (target, build): never collapse the same Asset id used by two
    // stills, because each Build may have frozen a different declaration.
    const seen = new Set<string>();
    const assets: DeliveryImageMaterialAsset[] = [];
    for (const asset of used) {
      if (seen.has(asset.id)) continue;
      seen.add(asset.id);
      assets.push({
        asset: asset.id,
        type: asset.type,
        path: asset.path,
        simulated: asset.simulated,
        rights: asset.rights,
      });
    }
    imageMaterials.push({
      target: image.target,
      build: image.build,
      document: frozenDocument.path,
      assets,
    });
  }
  assertAttributionComplete([...historicalUsedAssets, ...currentUsedAssets]);

  // Historical rights win when both declarations exist; a current private
  // declaration is still added when history was redistributable.
  const privateById = new Map<string, DeliveryNonRedistributableAsset>();
  for (const asset of historicalUsedAssets)
    if (!asset.rights.redistributable)
      privateById.set(asset.id, {
        asset: asset.id,
        path: asset.path,
        origin: asset.rights.origin,
        license: asset.rights.license,
        ...attributionFields(asset.rights),
      });
  for (const asset of currentUsedAssets)
    if (!asset.rights.redistributable && !privateById.has(asset.id))
      privateById.set(asset.id, {
        asset: asset.id,
        path: asset.path,
        origin: asset.rights.origin,
        license: asset.rights.license,
        ...attributionFields(asset.rights),
      });
  return {
    imageMaterials,
    privateAssets: [...privateById.values()].sort((a, b) => a.asset.localeCompare(b.asset)),
    simulated: [...historicalUsedAssets, ...currentUsedAssets].some(asset => asset.simulated),
  };
}

/**
 * Every non-redistributable Asset whose bytes a Portable export actually carries,
 * from the manifest's own Asset/original/snapshot provenance. Rights are copied
 * verbatim; the authored path is preferred over a frozen snapshot path. Used by
 * both a full delivery and an in-place still update so the bundle-wide private
 * marker has ONE derivation.
 */
export function portablePrivateAssets(
  portable: z.infer<typeof PortableManifestSchema>,
): DeliveryNonRedistributableAsset[] {
  const privateById = new Map<string, DeliveryNonRedistributableAsset>();
  const note = (assetId: string, assetPath: string, rights: Asset['rights']): void => {
    if (rights.redistributable) return;
    const existing = privateById.get(assetId);
    if (existing) {
      if (existing.path.startsWith(`${RUNTIME_DIR}/`) && !assetPath.startsWith(`${RUNTIME_DIR}/`))
        privateById.set(assetId, {
          asset: assetId,
          path: assetPath,
          origin: rights.origin,
          license: rights.license,
          ...attributionFields(rights),
        });
      return;
    }
    privateById.set(assetId, {
      asset: assetId,
      path: assetPath,
      origin: rights.origin,
      license: rights.license,
      ...attributionFields(rights),
    });
  };
  for (const file of portable.files) {
    if (file.provenance.kind === 'asset') note(file.provenance.assetId, file.path, file.provenance.rights);
    else if (file.provenance.kind === 'original' && file.provenance.rights && file.provenance.rightsAssetId)
      note(file.provenance.rightsAssetId, file.path, file.provenance.rights);
  }
  for (const asset of portable.snapshotAssets) note(asset.provenance.assetId, asset.path, asset.provenance.rights);
  return [...privateById.values()].sort((a, b) => a.asset.localeCompare(b.asset));
}

/** The manifest's delivered stills, validated as the CURRENT contract. */
export function manifestImages(manifest: DeliveryManifest): DeliveryImage[] {
  const parsed = z.array(DeliveryImageSchema).safeParse(manifest.images);
  if (!parsed.success) {
    const detail = parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new Error(`delivery: this bundle's manifest does not record valid delivered still images: ${detail}`);
  }
  return parsed.data;
}
