/**
 * Standalone live Playable export.
 *
 * `exportPlayable(root, sourceId, destination)` turns one `browser` `picture`
 * Source of an existing Project into a self-contained, statically served live
 * package: the single code entry, its declared resources, and exactly the assets
 * that Source actually uses. It is deliberately **not** an editable Project
 * export — there is no Composition, Build, Artifact, Take, recording replay or
 * provenance video in the result (see `exportProject` for that axis).
 *
 * The packaged layout is an allowlist copy:
 *
 *  - `playable-manifest.json` — the canonical hashed manifest (written at the
 *    package root, and intentionally NOT listed in its own `files`);
 *  - `project.json` — the minimal `PlayableLiveProject` configuration served by
 *    `servePlayable` (`composition: { output }`, one code Source, the flattened
 *    bindings, the resolved single-camera World and the selected Asset records);
 *  - the Source `entry` and every declared `resource`;
 *  - the required Asset closure: assets bound by the Source plus every asset
 *    referenced by the resolved World entities, and any declared resource that is
 *    also a registered Asset (preserving its actual hash and rights).
 *
 * Scoped authoring is flattened honestly: `bindingOverrides` are resolved to the
 * concrete asset ids, the emitted Source no longer carries overrides, and the
 * resolved World entities already point at the scoped asset — so the live config
 * is self-consistent and never ships an unrelated asset. Assets keep their
 * `derivedFrom` metadata (actual parent Build/Artifact identity) as a *reference*;
 * the parent video bytes are intentionally not packaged.
 *
 * Safety properties enforced here:
 *  - the Source Project is loaded through `validateProject` (schema + credential
 *    scan) and both `project.json` and every packaged file are hashed before and
 *    after staging, so concurrent authoring during the export is rejected;
 *  - every chosen path goes through the shared `assertAuthoredPath` policy (safe
 *    relative path, no symlink traversal, no `.viscraft/`, no credential file)
 *    and additionally rejects the reserved `project.json` / `playable-manifest.json`
 *    names so the authored Project cannot be repackaged as a resource or shadow
 *    the generated live configuration/manifest;
 *  - every required Asset (bound, world entity, or a registered entry/resource)
 *    is checked unconditionally: it must be redistributable and its on-disk bytes
 *    must match the declared `sha256`, so a corrupted or private asset is rejected
 *    rather than silently shipped; unrelated private assets are simply not part of
 *    the closure and are never copied (this is not a global Project export);
 *  - the destination is validated through the shared `resolveDestination` (parent
 *    must exist, destination outside the root, never an ancestor, never overwrite),
 *    staged in a sibling directory, hash-verified, and only then atomically renamed.
 */

import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  PlayableLiveProjectSchema,
  PlayablePackageManifestSchema,
  requireComposition,
  type Asset,
  type BrowserPictureSource,
  type PlayableLiveProject,
  type PlayablePackageManifest,
  type PlayableResult,
  type Project,
} from '../../core/schema.js';
import { resolveProjectPath } from '../../shared/fs.js';
import { hashFile, stableHash } from '../../shared/hash.js';
import { resolveSourceBindings, resolveWorldBinding, validateProject } from '../../project/project.js';
import { resolveDestination } from './portable.js';
import { markDeliveryPending, clearDeliveryPending, pendingDeliveryAcceptable } from '../../project/output.js';
import {
  assertReplaceableDefault,
  defaultDeliveryPath,
  outputRecordName,
  replaceStagedDirectory,
  walkRegularFiles,
  writeDeliveryRecord,
  type DeliveryRecord,
} from '../../project/output.js';
import { assertAuthoredPath } from '../../project/authored-path.js';
import {
  emittedJsPath,
  isDeclarationPath,
  isTypeScriptPath,
  transpileStagedTypeScript,
} from '../../backends/browser/transpile.js';

/** The manifest file name (read by `servePlayable`). Never packaged as content. */
export const PLAYABLE_MANIFEST_FILE = 'playable-manifest.json';
/** The minimal live-project configuration file name read by `servePlayable`. */
export const PLAYABLE_CONFIG_FILE = 'project.json';

/** The authored Project file read from the source root. */
const ORIGIN_PROJECT_FILE = 'project.json';
/** Paths that must never be chosen as entry/resource/asset content. */
const RESERVED_FILES = new Set([PLAYABLE_CONFIG_FILE, PLAYABLE_MANIFEST_FILE]);

type Role = 'entry' | 'resource' | 'asset';
type ManifestFile = PlayablePackageManifest['files'][number];

interface PlannedFile {
  absolute: string;
  role: Role;
  assetId?: string;
  rights?: Asset['rights'];
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Reject reserved content paths in addition to the shared authored-path policy. */
function assertChosenPath(relative: string, label: string): void {
  assertAuthoredPath(relative, label);
  if (RESERVED_FILES.has(relative.toLowerCase()))
    throw new Error(`${label} collides with a reserved package file: ${relative}`);
}

async function assertRegularFile(absolute: string, label: string): Promise<number> {
  let info;
  try {
    info = await stat(absolute);
  } catch {
    throw new Error(`exportPlayable: ${label} is missing or unreadable`);
  }
  if (!info.isFile()) throw new Error(`exportPlayable: ${label} is not a regular file`);
  return info.size;
}

/**
 * Verify an existing Playable package DIRECTORY against its own manifest, as the
 * complete member check delivery replace protection requires. Every listed file
 * must be present and a regular file (never a symlink) with the recorded hash,
 * and the actual file set must equal the manifest allowlist plus the manifest
 * itself. Throws an `altered:`-prefixed error on any mismatch.
 */
export async function verifyPlayablePackage(projectDir: string): Promise<{ files: number }> {
  const manifest = PlayablePackageManifestSchema.parse(
    JSON.parse(await readFile(path.join(projectDir, PLAYABLE_MANIFEST_FILE), 'utf8')),
  );
  const expected = new Set<string>([PLAYABLE_MANIFEST_FILE]);
  for (const file of manifest.files) {
    expected.add(file.path);
    const absolute = path.join(projectDir, ...file.path.split('/'));
    const info = await lstat(absolute).catch(() => null);
    if (!info) throw new Error(`altered: ${file.path} is missing`);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`altered: ${file.path} is not a regular file`);
    if ((await hashFile(absolute)) !== file.sha256) throw new Error(`altered: ${file.path} hash changed`);
  }
  const actual = new Set(await walkRegularFiles(projectDir));
  const extra = [...actual].filter(file => !expected.has(file));
  const missing = [...expected].filter(file => !actual.has(file));
  if (extra.length > 0 || missing.length > 0)
    throw new Error(
      `altered: member set changed${extra.length > 0 ? `; extra ${extra.join(', ')}` : ''}${missing.length > 0 ? `; missing ${missing.join(', ')}` : ''}`,
    );
  return { files: manifest.files.length };
}

/**
 * Export a browser `picture` Source as a standalone live package.
 *
 * `destination` must not exist yet, its parent must exist, and it must be
 * outside (and never an ancestor of) the project root.
 */
export async function exportPlayable(root: string, sourceId: string, destination?: string): Promise<PlayableResult> {
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    throw new Error(`exportPlayable: project root does not exist: ${root}`);
  }
  const defaultName = `playable-${sourceId}`;
  // Fixed default name inside output/. A repeat export replaces the previous
  // default only when it is a recorded Runtime delivery whose recorded manifest
  // is unchanged AND whose ACTUAL members still match that manifest; otherwise
  // it is refused.
  let replaceDefault = false;
  const currentManifestHash = (): Promise<string | null> =>
    hashFile(path.join(destination as string, PLAYABLE_MANIFEST_FILE)).catch(() => null);
  const proveMembersUnmodified = async (): Promise<void> => {
    await verifyPlayablePackage(destination as string);
  };
  // Full replace-protection check, re-run at the gate AND immediately before the
  // swap (a coherent replacement is caught only by the recorded manifest hash). A
  // published-but-unrecorded package from an interrupted earlier export (our own
  // recovery marker) is accepted as ours so re-exporting to the same default
  // succeeds after a crash.
  const assertReplaceable = async (): Promise<void> => {
    if (await pendingDeliveryAcceptable(rootReal, defaultName, 'playable', currentManifestHash)) {
      await proveMembersUnmodified();
      return;
    }
    await assertReplaceableDefault(rootReal, defaultName, 'playable', currentManifestHash, proveMembersUnmodified);
  };
  if (destination === undefined) {
    destination = await defaultDeliveryPath(rootReal, defaultName);
    replaceDefault = await pathExists(destination);
    if (replaceDefault) await assertReplaceable();
  }
  const { destReal, parentReal } = await resolveDestination(destination, rootReal, { allowExisting: replaceDefault });

  // Load and validate the authored Project from the exact bytes we hash, so the
  // same snapshot is used for both validation and concurrent-authoring detection.
  const projectAbsolute = await resolveProjectPath(root, ORIGIN_PROJECT_FILE);
  const projectBytesBefore = await readFile(projectAbsolute);
  const projectHashBefore = sha256(projectBytesBefore);
  const project: Project = validateProject(JSON.parse(projectBytesBefore.toString('utf8')));

  const source = project.sources.find(candidate => candidate.id === sourceId);
  if (!source) throw new Error(`exportPlayable: unknown source "${sourceId}"`);
  if (source.kind !== 'browser' || source.output !== 'picture') {
    throw new Error(`exportPlayable: source "${sourceId}" must be a browser picture Source (found "${source.kind}")`);
  }

  // Resolve scoped authoring to concrete asset ids and flatten it into a plain
  // browser picture Source: the override map is intentionally dropped (already applied).
  const resolvedBindings = resolveSourceBindings(project, source);
  const bindings: Record<string, string> = {};
  for (const { binding, asset } of resolvedBindings) bindings[binding] = asset.id;
  const bindingNames = [...new Set(resolvedBindings.map(({ binding }) => binding))];

  const resolvedWorld = resolveWorldBinding(project, source.world, source);

  const liveSource: BrowserPictureSource = {
    id: source.id,
    kind: 'browser',
    output: 'picture',
    entry: source.entry,
    resources: [...source.resources],
    bindings: bindingNames,
    params: source.params,
    seed: source.seed,
    frames: source.frames,
    // A live playable installs only the World DEFINITION; the player drives the
    // movement, so the flattened binding drops any `drive` start frame.
    ...(source.world ? { world: { id: source.world.id, camera: source.world.camera, mode: 'define' as const } } : {}),
  };

  // --- Required asset closure ------------------------------------------------
  const assetsById = new Map(project.assets.map(asset => [asset.id, asset] as const));
  const assetsByPath = new Map(project.assets.map(asset => [asset.path, asset] as const));
  const required = new Map<string, Asset>();
  const requireAsset = (id: string, label: string): Asset => {
    const asset = assetsById.get(id);
    if (!asset) throw new Error(`exportPlayable: ${label} references missing asset ${id}`);
    required.set(asset.id, asset);
    return asset;
  };
  for (const { asset } of resolvedBindings) requireAsset(asset.id, `Binding of source ${source.id}`);
  if (resolvedWorld)
    for (const entity of resolvedWorld.entities) requireAsset(entity.asset, `World entity ${entity.id}`);

  // --- Chosen files ----------------------------------------------------------
  const planned = new Map<string, PlannedFile>();
  const addFile = (
    relative: string,
    absolute: string,
    role: Role,
    assetId?: string,
    rights?: Asset['rights'],
  ): void => {
    const existing = planned.get(relative);
    // Precedence: the page entry wins over data files; a registered asset role
    // (which carries rights/provenance) wins over a plain resource role.
    if (existing && (existing.role === 'entry' || (existing.role === 'asset' && role === 'resource'))) return;
    planned.set(relative, { absolute, role, ...(assetId ? { assetId } : {}), ...(rights ? { rights } : {}) });
  };

  assertChosenPath(source.entry, `Source ${source.id} entry`);
  const entryAsset = assetsByPath.get(source.entry);
  if (entryAsset) required.set(entryAsset.id, entryAsset);
  addFile(source.entry, await resolveProjectPath(root, source.entry), 'entry', entryAsset?.id, entryAsset?.rights);

  for (const resource of source.resources) {
    assertChosenPath(resource, `Source ${source.id} resource`);
    const registered = assetsByPath.get(resource);
    if (registered) {
      if (!registered.rights.redistributable) {
        throw new Error(`exportPlayable: resource asset ${registered.id} is not redistributable`);
      }
      required.set(registered.id, registered);
      addFile(resource, await resolveProjectPath(root, resource), 'asset', registered.id, registered.rights);
    } else {
      addFile(resource, await resolveProjectPath(root, resource), 'resource');
    }
  }

  for (const asset of required.values()) {
    assertChosenPath(asset.path, `Asset ${asset.id}`);
    if (!asset.rights.redistributable) {
      throw new Error(
        `exportPlayable: asset ${asset.id} is not redistributable and cannot be packaged into a live playable`,
      );
    }
    if (!planned.has(asset.path))
      addFile(asset.path, await resolveProjectPath(root, asset.path), 'asset', asset.id, asset.rights);
  }

  for (const [relative, file] of planned)
    await assertRegularFile(file.absolute, `Source ${source.id} file ${relative}`);

  const selectedAssets = [...required.values()].sort((a, b) => a.id.localeCompare(b.id));
  const simulated = selectedAssets.some(asset => asset.simulated);
  const hasDerivedAsset = selectedAssets.some(asset => Boolean(asset.derivedFrom));

  // --- Executable TypeScript members -----------------------------------------
  // A browser cannot execute `.ts`/`.tsx` (they are served as an opaque
  // octet-stream), so every TypeScript entry/resource is transpiled in STAGING to
  // its `.js` sibling and the live Source points at the emitted name. The authored
  // `.ts` source is still carried verbatim, so nothing the author wrote is lost.
  // `.d.ts` declarations are type-only and are never emit units.
  const emittedName = new Map<string, string>();
  for (const relative of planned.keys())
    if (isTypeScriptPath(relative) && !isDeclarationPath(relative)) emittedName.set(relative, emittedJsPath(relative));
  if (emittedName.has(liveSource.entry)) liveSource.entry = emittedName.get(liveSource.entry)!;
  liveSource.resources = liveSource.resources.map(resource => emittedName.get(resource) ?? resource);

  // --- Live configuration ----------------------------------------------------
  const liveConfig: PlayableLiveProject = PlayableLiveProjectSchema.parse({
    schemaVersion: 1,
    id: project.id,
    revision: project.revision,
    title: project.title,
    sources: [liveSource],
    assets: selectedAssets,
    bindings,
    ...(resolvedWorld ? { worlds: [resolvedWorld] } : {}),
    composition: { output: requireComposition(project).output },
  });
  const configBytes = Buffer.from(`${JSON.stringify(liveConfig, null, 2)}\n`, 'utf8');
  const configHash = sha256(configBytes);

  const notes: string[] = [
    'Standalone live Playable package: the single code entry, its declared resources and exactly the assets it uses, packaged so this live content can be played without the Runtime. The packaged project.json is a narrow live configuration (one code Source, the resolved bindings/World and composition.output), not the editable Project — no Composition shots/placements, Build, Artifact, Take or recording replay is included.',
    'The running page is trusted author code executed by the browser on loopback; this is not a code sandbox. Offline audio capture (Web Audio) and any real generative provider are not included or implied.',
  ];
  if (emittedName.size > 0)
    notes.push(
      'TypeScript entry/resources are carried as their authored source together with a transpiled `.js` sibling; the live Source and this manifest point at the executable `.js`.',
    );
  if (hasDerivedAsset) {
    notes.push(
      'Assets that record derivedFrom keep their parent Build/Artifact identity as a reference only; the parent video bytes are intentionally not packaged, so this is not a fully editable project.',
    );
  }

  // --- Stage, verify, atomically publish ------------------------------------
  const staging = path.join(parentReal, `.${path.basename(destReal)}.${randomUUID()}.staging`);
  await mkdir(staging, { recursive: true });
  let deliveryRecord: DeliveryRecord | null = null;
  // Filled once the staged manifest is final (hashes from the staged bytes,
  // including the emitted `.js` members); returned to the caller below.
  let published: { id: string; files: number; sha256: string } | null = null;
  try {
    for (const [relative, file] of planned) {
      const target = path.join(staging, ...relative.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(file.absolute, target);
    }

    // Type-check and transpile the TypeScript members IN STAGING. A real
    // diagnostic aborts here, before any `.js` is emitted and before anything is
    // published, so a TypeScript type error can never produce a runnable-looking
    // package. The emitted `.js` siblings become first-class, hashed members.
    const emitted = await transpileStagedTypeScript({
      snapshotRoot: staging,
      files: [...planned.keys()],
      label: 'exportPlayable',
    });
    for (const relative of emitted)
      if (planned.has(relative))
        throw new Error(`exportPlayable: transpiled member ${relative} collides with a packaged authored file`);

    // --- Manifest (hashes come from the STAGED bytes) ------------------------
    const plannedSha = new Map<string, string>();
    const fileEntries: ManifestFile[] = [];
    for (const [relative, file] of [...planned.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const digest = await hashFile(path.join(staging, ...relative.split('/')));
      for (const asset of required.values())
        if (asset.path === relative && asset.sha256 !== digest)
          throw new Error(`Playable Asset hash mismatch: ${asset.id}`);
      plannedSha.set(relative, digest);
      fileEntries.push({
        path: relative,
        sha256: digest,
        role: file.role,
        ...(file.assetId ? { asset: file.assetId } : {}),
        ...(file.rights ? { rights: file.rights } : {}),
      });
    }
    for (const relative of emitted) {
      const digest = await hashFile(path.join(staging, ...relative.split('/')));
      plannedSha.set(relative, digest);
      fileEntries.push({ path: relative, sha256: digest, role: relative === liveSource.entry ? 'entry' : 'resource' });
    }
    fileEntries.push({ path: PLAYABLE_CONFIG_FILE, sha256: configHash, role: 'configuration' });
    fileEntries.sort((a, b) => a.path.localeCompare(b.path));

    const sourceHash = stableHash({
      source: liveSource,
      assets: selectedAssets,
      world: resolvedWorld ?? null,
      output: requireComposition(project).output,
      files: fileEntries.map(file => ({ path: file.path, sha256: file.sha256, role: file.role })),
    });

    const manifestBody = {
      format: 'viscraft-playable-package' as const,
      version: 1 as const,
      project: { id: project.id, revision: project.revision, title: project.title },
      source: { id: liveSource.id, entry: liveSource.entry, sourceHash },
      simulated,
      files: fileEntries,
      notes,
    };
    const id = `playable-${stableHash(manifestBody).slice(0, 16)}`;
    const manifest: PlayablePackageManifest = PlayablePackageManifestSchema.parse({
      format: 'viscraft-playable-package',
      version: 1,
      id,
      project: manifestBody.project,
      source: manifestBody.source,
      simulated,
      files: fileEntries,
      notes,
    });
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    published = { id, files: manifest.files.length, sha256: sha256(manifestBytes) };

    await writeFile(path.join(staging, PLAYABLE_CONFIG_FILE), configBytes, { mode: 0o600 });
    if ((await hashFile(path.join(staging, PLAYABLE_CONFIG_FILE))) !== configHash) {
      throw new Error(`exportPlayable: staged configuration failed hash verification: ${PLAYABLE_CONFIG_FILE}`);
    }
    await writeFile(path.join(staging, PLAYABLE_MANIFEST_FILE), manifestBytes, { mode: 0o600 });

    // Concurrent authoring: the Project and every packaged source/asset file must
    // be byte-identical to what we validated and hashed before staging.
    if (sha256(await readFile(projectAbsolute)) !== projectHashBefore) {
      throw new Error('exportPlayable: project.json changed during export; retry once authoring stops');
    }
    for (const [relative, file] of planned) {
      if ((await hashFile(file.absolute)) !== plannedSha.get(relative)) {
        throw new Error(`exportPlayable: ${relative} changed during export; retry once authoring stops`);
      }
    }

    // The delivery record for a destination that lands directly in output/; its
    // recovery marker is written immediately BEFORE the publish (after the replace
    // re-check) so a crash between publish and record leaves an entry the next
    // export accepts as its own.
    const recordName = outputRecordName(rootReal, destReal);
    if (recordName)
      deliveryRecord = {
        name: recordName,

        kind: 'playable',
        revision: project.revision,
        deliveredAt: new Date().toISOString(),
        manifestSha256: sha256(manifestBytes),
      };

    if (await pathExists(destReal)) {
      if (!replaceDefault) throw new Error(`Export destination appeared during export: ${destReal}`);
      // Re-check the observed state immediately before the swap (full check: a
      // coherent replacement is caught only by the recorded manifest hash).
      await assertReplaceable();
      if (deliveryRecord) await markDeliveryPending(rootReal, deliveryRecord);
      await replaceStagedDirectory(staging, destReal);
    } else {
      if (deliveryRecord) await markDeliveryPending(rootReal, deliveryRecord);
      await rename(staging, destReal);
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  // Record every delivery that lands directly in output/.
  if (deliveryRecord) {
    await writeDeliveryRecord(rootReal, deliveryRecord);
    await clearDeliveryPending(rootReal, deliveryRecord.name);
  }

  return {
    id: published!.id,
    path: destReal,
    entry: liveSource.entry,
    files: published!.files,
    sha256: published!.sha256,
    simulated,
  };
}
