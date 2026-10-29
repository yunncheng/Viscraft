import {
  type DeliveryRecord,
  readDeliveryRecord,
  OUTPUT_DIR,
  pendingDeliveryAcceptable,
  acquireDeliveryLock,
  markDeliveryPending,
  replaceStagedDirectory,
  writeDeliveryRecord,
  clearDeliveryPending,
} from '../../project/output.js';
import path from 'node:path';
import { lstat, realpath, readFile, stat, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import {
  type BundleObservation,
  DELIVERY_MANIFEST,
  DeliveryManifestSchema,
  DeliveryReviewPathsSchema,
  type DeliveryManifest,
  type DeliveryImage,
  type ImageDeliveryInspection,
  DeliverySoundSchema,
  type ImageDeliveryUpdateOptions,
  type ImageDeliveryUpdateResult,
  PROJECT_DIR,
  PORTABLE_MANIFEST,
  IMAGE_DIR,
  type DeliveryImageMaterial,
  type DeliveryNonRedistributableAsset,
  type Planned,
  type BundleRole,
  INDEX_FILE,
  type IndexContext,
  MOVIE_FILE,
  RUNTIME_DIR,
  type DeliveryAudio,
  type DeliverySubtitles,
  type DeliveryPlayable,
  type DeliveryReview,
  type ReviewReportShape,
  type DeliveryFile,
} from './delivery-contract.js';
import { pathExists, walkFiles, assertSameSet, dedupeFrozenBySha, scanBundleDiagnostics } from './delivery-files.js';
import { verifyDelivery } from './delivery-verification.js';
import { type Project, type ImageTarget, type BuildRecord, requireFilmProject } from '../../core/schema.js';
import { readBuild, readBuilds } from '../../project/build-records.js';
import {
  currentImageMatches,
  manifestImages,
  deliveryWorkbenchEntry,
  collectImageMaterialFacts,
  portablePrivateAssets,
} from './image-facts.js';
import { loadProject, acquireLock, validateProject } from '../../project/project.js';
import { hashFile } from '../../shared/hash.js';
import { z } from 'zod';
import { imageRenderKey } from '../../build/image.js';
import { resolveProjectPath } from '../../shared/fs.js';
import { randomUUID } from 'node:crypto';
import { PortableManifestSchema } from './portable-contract.js';
import { type PortableExport, exportProject } from './portable.js';
import { renderIndex } from './delivery-page.js';

/** A single output/ entry name: never a path, never a traversal segment. */
function assertOutputEntryName(entry: string): void {
  if (
    typeof entry !== 'string' ||
    entry.trim() === '' ||
    entry === '.' ||
    entry === '..' ||
    entry.includes('/') ||
    entry.includes('\\') ||
    entry.includes('\0')
  )
    throw new Error(
      `delivery: ${JSON.stringify(entry)} is not an output/ delivery entry name; pass the recorded entry (for example "handoff"), not a path`,
    );
}

/** Where a recorded bundle lives. Only `output/<entry>` is ever bound or updated. */
async function resolveDeliveryLocation(
  rootReal: string,
  entry: string,
): Promise<{ bundleReal: string; name: string; record: DeliveryRecord }> {
  assertOutputEntryName(entry);
  const record = await readDeliveryRecord(rootReal, entry);
  if (!record)
    throw new Error(
      `delivery: no recorded Runtime delivery ${JSON.stringify(entry)} exists in ${OUTPUT_DIR}/; list deliveries with \`viscraft status\` and pass the recorded entry name`,
    );
  if (record.kind !== 'deliver')
    throw new Error(
      `delivery: ${OUTPUT_DIR}/${entry} is a recorded ${record.kind} entry, not a delivery bundle; only a delivered bundle can be bound or updated in place`,
    );
  const bundle = path.join(rootReal, OUTPUT_DIR, entry);
  const info = await lstat(bundle).catch(() => null);
  if (!info || info.isSymbolicLink() || !info.isDirectory())
    throw new Error(`delivery: recorded delivery ${OUTPUT_DIR}/${entry} is missing or is not a real directory`);
  const bundleReal = await realpath(bundle);
  if (path.dirname(bundleReal) !== path.join(rootReal, OUTPUT_DIR))
    throw new Error(
      `delivery: recorded delivery ${OUTPUT_DIR}/${entry} does not resolve to a direct child of ${OUTPUT_DIR}/`,
    );
  return { bundleReal, name: entry, record };
}

/**
 * Read a bundle and decide whether it still is the delivery its record names.
 *
 * A malformed/absent manifest throws because there is no identity to report. A
 * parseable manifest whose members were changed (or whose recorded manifest
 * hash no longer matches, with no Runtime pending marker) does NOT throw: the
 * manifest's own facts are returned with `verified: false` and a reason, so an
 * inspection can present the real blocked binding. Writers use
 * `readVerifiedBundle`, which turns that state into a refusal.
 */
async function observeBundle(rootReal: string, bundleReal: string, record: DeliveryRecord): Promise<BundleObservation> {
  const manifestPath = path.join(bundleReal, DELIVERY_MANIFEST);
  if (!(await pathExists(manifestPath)))
    throw new Error(`delivery: ${bundleReal} has no ${DELIVERY_MANIFEST}, so it is not a delivery bundle`);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`delivery: ${DELIVERY_MANIFEST} is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = DeliveryManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new Error(`delivery: malformed ${DELIVERY_MANIFEST}: ${issues}`);
  }
  const manifest = parsed.data;
  const verification = await verifyDelivery(bundleReal);
  if (!verification.ok) {
    const altered = [
      ...verification.mismatched.map(item => item.path),
      ...verification.missing.map(item => `missing ${item}`),
      ...verification.unlisted.map(item => `unlisted ${item}`),
    ];
    return {
      manifest,
      manifestSha256: verification.manifestSha256,
      record,
      verified: false,
      blocked: `delivery: ${bundleReal} has been modified since it was delivered (${
        altered.join(', ') || 'member set changed'
      }); it is left untouched and cannot be bound or updated`,
    };
  }
  let effective = record;
  if (record.manifestSha256 === undefined || record.manifestSha256 !== verification.manifestSha256) {
    const recovered = await pendingDeliveryAcceptable(
      rootReal,
      record.name,
      'deliver',
      async () => verification.manifestSha256,
    );
    if (!recovered)
      return {
        manifest,
        manifestSha256: verification.manifestSha256,
        record,
        verified: false,
        blocked: `delivery: ${OUTPUT_DIR}/${record.name} has been modified since it was delivered (recorded manifest hash mismatch); it is left untouched and cannot be bound or updated`,
      };
    effective = { ...record, manifestSha256: verification.manifestSha256 };
  }
  return { manifest, manifestSha256: verification.manifestSha256, record: effective, verified: true, blocked: null };
}

/**
 * Read and REQUIRE a currently-verifying bundle. A recorded entry must also
 * match its recorded manifest hash (a hand-edited manifest has a different hash
 * even when its members are self-consistent). The only accepted mismatch is a
 * published-but-unrecorded swap recovered through the Runtime's own pending
 * marker, exactly like `deliverProject` accepts its interrupted publish.
 */
async function readVerifiedBundle(
  rootReal: string,
  bundleReal: string,
  record: DeliveryRecord,
): Promise<{ manifest: DeliveryManifest; manifestSha256: string; record: DeliveryRecord }> {
  const observed = await observeBundle(rootReal, bundleReal, record);
  if (!observed.verified) throw new Error(observed.blocked ?? 'delivery: this bundle no longer verifies');
  return observed;
}

/** Pick the delivered still this bind/update is about, refusing identity drift. */
function selectDeliveredImage(
  images: readonly DeliveryImage[],
  project: Project,
  targetId: string,
): { image: DeliveryImage; target: ImageTarget; document: Project['imageDocuments'][number] } {
  const image = images.find(candidate => candidate.target === targetId);
  if (!image)
    throw new Error(
      `delivery: this bundle does not carry image target ${JSON.stringify(targetId)}; it carries ${
        images.map(candidate => candidate.target).join(', ') || 'no still images'
      }. An in-place update only replaces an already-delivered target; deliver the new target explicitly`,
    );
  const target = project.imageTargets.find(candidate => candidate.id === image.target);
  if (!target)
    throw new Error(
      `delivery: delivered target ${JSON.stringify(image.target)} is not declared by the current Project; this bundle does not belong to this authoring Project`,
    );
  const document = project.imageDocuments.find(candidate => candidate.id === target.document);
  if (!document)
    throw new Error(
      `delivery: image target ${JSON.stringify(target.id)} references unknown image document ${JSON.stringify(target.document)}`,
    );
  return { image, target, document };
}

/** Whether the delivered still's Build still describes the CURRENT saved bytes. */
async function deliveredStillIsStale(rootReal: string, image: DeliveryImage): Promise<boolean> {
  try {
    const build = await readBuild(rootReal, image.build);
    return !(await currentImageMatches(rootReal, image.target, build));
  } catch {
    // Missing source/Build: this still certainly does not describe the current
    // saved bytes, so it is not presented as current.
    return true;
  }
}

/**
 * Inspect one delivered still. Binds ONLY a recorded Runtime `output/` entry
 * whose manifest names this authoring Project and whose recorded target is still
 * declared by the owning document. A missing record, a foreign Project, a
 * malformed manifest or a target the bundle does not carry throws.
 *
 * A bundle whose manifest parses but whose members/record no longer verify is
 * returned with `verified: false` and `blocked`, carrying the manifest's own
 * recorded facts. It is never presented as a healthy binding, and inspection
 * never invents a fallback identity.
 */
export async function inspectImageDelivery(
  root: string,
  options: { delivery: string; target: string },
): Promise<ImageDeliveryInspection> {
  if (
    options === null ||
    typeof options !== 'object' ||
    typeof options.delivery !== 'string' ||
    typeof options.target !== 'string'
  )
    throw new Error('delivery: inspectImageDelivery needs { delivery, target }');
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    throw new Error(`delivery: project root does not exist: ${root}`);
  }
  const project = await loadProject(rootReal);
  const location = await resolveDeliveryLocation(rootReal, options.delivery);
  const observed = await observeBundle(rootReal, location.bundleReal, location.record);
  const manifestProject = observed.manifest.project as { id?: unknown } | undefined;
  if (manifestProject?.id !== project.id)
    throw new Error(
      `delivery: this bundle was delivered from Project ${String(manifestProject?.id ?? 'unknown')}, not ${JSON.stringify(project.id)}; it cannot be bound here`,
    );
  const images = manifestImages(observed.manifest);
  const { image, document } = selectDeliveredImage(images, project, options.target);
  const absolute = path.join(location.bundleReal, ...image.path.split('/'));
  const info = await stat(absolute).catch(() => null);
  const actual = info === null ? null : await hashFile(absolute).catch(() => null);
  let verified = observed.verified;
  let blocked = observed.blocked;
  if (info === null) {
    verified = false;
    blocked = `delivery: delivered still ${image.path} is missing from ${OUTPUT_DIR}/${location.name}; it cannot be bound`;
  } else if (actual !== image.sha256) {
    verified = false;
    blocked = `delivery: delivered still ${image.path} does not match the manifest hash; it cannot be bound`;
  }
  return {
    entry: location.name,
    path: location.bundleReal,
    kind: location.record.kind,
    revision: location.record.revision,
    deliveredAt: location.record.deliveredAt,
    manifestSha256: observed.manifestSha256,
    movie: observed.manifest.movie != null,
    project: true,
    images,
    sounds: z.array(DeliverySoundSchema).parse(observed.manifest.sounds),
    target: image.target,
    document: document.id,
    documentPath: document.path,
    productPath: image.path,
    projectPath: `${OUTPUT_DIR}/${location.name}/${image.path}`,
    build: image.build,
    artifact: image.artifact,
    format: image.format,
    width: image.width,
    height: image.height,
    sha256: image.sha256,
    bytes: info?.size ?? image.bytes,
    simulated: image.simulated,
    stale: await deliveredStillIsStale(rootReal, image),
    workbench: image.workbench,
    verified,
    blocked: verified ? null : blocked,
  };
}

/**
 * The newest already-succeeded, non-preview render of `targetId` whose operation
 * key equals the CURRENT saved source, with its Artifact bytes still present.
 * This is exactly what `renderImage` would reuse; it never renders, writes or
 * submits a model task, and returns null when no current result exists.
 */
async function newestCurrentImageBuild(rootReal: string, targetId: string): Promise<BuildRecord | null> {
  let key: string | null = null;
  try {
    key = await imageRenderKey(rootReal, targetId);
  } catch {
    return null;
  }
  for (const previous of await readBuilds(rootReal)) {
    if (previous.status !== 'succeeded' || previous.preview !== undefined || previous.target !== targetId) continue;
    const operation = previous.operations.find(candidate => candidate.kind === 'render-image');
    if (!operation || operation.key !== key || operation.reused) continue;
    if (!(await currentImageMatches(rootReal, targetId, previous))) continue;
    if (previous.result?.artifact !== operation.artifact) continue;
    const artifact = previous.artifacts.find(candidate => candidate.id === operation.artifact);
    if (!artifact || artifact.kind !== 'image' || !artifact.image) continue;
    try {
      if ((await hashFile(await resolveProjectPath(rootReal, artifact.path))) !== artifact.sha256) continue;
    } catch {
      continue;
    }
    return previous;
  }
  return null;
}

/**
 * Replace ONE already-delivered still in the SAME bundle.
 *
 * This is a product update, not a delivery: the movie, every other still and
 * every auxiliary product keep their exact bytes, no `output/current/` copy is
 * created, and no immutable Build/Artifact is modified. It never renders and
 * never submits a model task. With no `build` it republishes the newest already
 * succeeded render whose key equals the current saved source (the same result
 * `renderImage` would reuse); with `build` it publishes exactly that Build.
 *
 * The write is safe:
 *  - the old bundle must verify AND match its recorded manifest hash;
 *  - the target must already be in that bundle's selected stills (an update
 *    never silently adds a product or another target);
 *  - the saved source is re-checked at publish time; a source that changed under
 *    the render refuses instead of mislabelling pixels as current;
 *  - staging is an independent byte copy beside the entry, published by the
 *    atomic directory swap under `.viscraft/delivery.lock`; the delivery record
 *    is updated only after the swap, and a failure leaves the old bundle intact.
 */
export async function updateImageDelivery(
  root: string,
  options: ImageDeliveryUpdateOptions,
): Promise<ImageDeliveryUpdateResult> {
  if (
    options === null ||
    typeof options !== 'object' ||
    typeof options.delivery !== 'string' ||
    options.delivery === '' ||
    typeof options.target !== 'string' ||
    options.target === ''
  )
    throw new Error('delivery: updateImageDelivery needs { delivery, target }');
  const entry = options.delivery;
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    throw new Error(`delivery: project root does not exist: ${root}`);
  }
  // Only a RECORDED output/ entry can be written: an explicit external delivery
  // has no DeliveryRecord, so no arbitrary directory is ever replaced.
  const location = await resolveDeliveryLocation(rootReal, entry);
  const observed = await readVerifiedBundle(rootReal, location.bundleReal, location.record);
  const oldManifest = observed.manifest;
  const oldRecord = observed.record;
  const observedManifestSha = observed.manifestSha256;
  if (!(await pathExists(path.join(location.bundleReal, PROJECT_DIR, 'project.json'))))
    throw new Error(
      `delivery: ${OUTPUT_DIR}/${entry} records the editable project but its project/ files are missing; it is left untouched`,
    );

  const initialProject = await loadProject(rootReal);
  // A direct SDK caller can bypass inspect; the update must still prove the
  // recorded bundle belongs to THIS authoring Project before selecting a target.
  const manifestProject = oldManifest.project as { id?: unknown } | undefined;
  if (manifestProject?.id !== initialProject.id)
    throw new Error(
      `delivery: this bundle was delivered from Project ${String(manifestProject?.id ?? 'unknown')}, not ${JSON.stringify(initialProject.id)}; it cannot be bound or updated here`,
    );
  const sounds = z.array(DeliverySoundSchema).parse(oldManifest.sounds);
  const initial = selectDeliveredImage(manifestImages(oldManifest), initialProject, options.target);

  // --- Resolve the exact still Build this update is about --------------------
  let buildId: string;
  if (options.build === undefined) {
    const current = await newestCurrentImageBuild(rootReal, initial.target.id);
    if (current === null)
      throw new Error(
        `delivery: image target ${JSON.stringify(
          initial.target.id,
        )} has no succeeded render that matches the current saved source; run \`viscraft image <project-directory> --target ${initial.target.id}\` first (an update never renders), and the delivered file is left unchanged`,
      );
    buildId = current.id;
  } else {
    buildId = options.build;
  }
  const build = await readBuild(rootReal, buildId);
  if (
    build.status !== 'succeeded' ||
    build.preview !== undefined ||
    build.target !== initial.target.id ||
    !build.result
  )
    throw new Error(
      `delivery: Build ${buildId} is not a succeeded, non-preview render of image target ${JSON.stringify(initial.target.id)}; the delivered file was left unchanged`,
    );
  const operation = build.operations.find(
    candidate => candidate.kind === 'render-image' && candidate.artifact === build.result!.artifact,
  );
  const artifact = build.artifacts.find(candidate => candidate.id === build.result!.artifact);
  if (!operation || !artifact || artifact.kind !== 'image' || !artifact.image)
    throw new Error(
      `delivery: Build ${buildId} does not record a usable render-image result Artifact; the delivered file was left unchanged`,
    );

  const parentReal = path.dirname(location.bundleReal);
  const exportDir = path.join(parentReal, `.${entry}.${randomUUID()}.project`);
  let bundleProject: Project;
  let portable: z.infer<typeof PortableManifestSchema>;
  let portableExport: PortableExport;
  let bytesRoot = rootReal;
  try {
    // Freeze the author bytes once, under build → author, exactly like a delivery.
    // For a bundle that carries the editable project, the still-delivered Builds
    // and the new Build are requested by STABLE ID; the export's own closure
    // traversal carries their dependencies without re-rendering anything.
    const releaseBuild = await acquireLock(rootReal, 'build');
    try {
      const releaseAuthor = await acquireLock(rootReal, 'author');
      try {
        {
          const filmBuildForExport = (oldManifest.build as { id?: unknown } | null | undefined)?.id;
          const versions = [
            ...new Set([
              ...(oldManifest.movie != null && typeof filmBuildForExport === 'string' ? [filmBuildForExport] : []),
              ...manifestImages(oldManifest).map(candidate => candidate.build),
              ...sounds.map(candidate => candidate.build),
              build.id,
            ]),
          ];
          portableExport = await exportProject(rootReal, exportDir, {
            // The old bundle already carries private bytes only under an explicit
            // author opt-in; keep that scope (the marker below states it again).
            allowNonRedistributable: oldManifest.containsNonRedistributableAssets === true,
            allowMissingOriginals: oldManifest.projectExport.scope.requested === 'allow-missing-originals',
            allowIncompleteAuthored: oldManifest.projectExport.scope.authoredScope === 'allow-incomplete',
            extraVersions: versions,
          });
          portable = PortableManifestSchema.parse(
            JSON.parse(await readFile(path.join(exportDir, ...PORTABLE_MANIFEST.split('/')), 'utf8')),
          );
          bundleProject = validateProject(JSON.parse(await readFile(path.join(exportDir, 'project.json'), 'utf8')));
          bytesRoot = exportDir;
        }
        // The published pixels must describe the author bytes the bundle will
        // carry. This is the same key `renderImage`/`deliverProject` use.
        const key = await imageRenderKey(bytesRoot, initial.target.id).catch(() => null);
        if (key === null || operation.key !== key || !(await currentImageMatches(bytesRoot, initial.target.id, build)))
          throw new Error(
            `delivery: the saved source changed after Build ${buildId} was rendered for image target ${JSON.stringify(
              initial.target.id,
            )}, so that Build is stale and not current; the delivered file was left unchanged (render the saved source again)`,
          );
      } finally {
        await releaseAuthor();
      }
    } finally {
      await releaseBuild();
    }

    const currentProject = bundleProject;
    const target = currentProject.imageTargets.find(candidate => candidate.id === initial.target.id);
    const document = target
      ? currentProject.imageDocuments.find(candidate => candidate.id === target.document)
      : undefined;
    if (!target || !document)
      throw new Error(
        `delivery: image target ${JSON.stringify(initial.target.id)} is no longer declared by the Project; the delivered file was left unchanged`,
      );

    const extension = artifact.image.format === 'jpeg' ? 'jpg' : artifact.image.format;
    const relative = `${IMAGE_DIR}/${target.id}.${extension}`;
    const source = await resolveProjectPath(bytesRoot, artifact.path);
    if (!(await pathExists(source)))
      throw new Error(
        `delivery: Build ${build.id} result bytes are missing at ${artifact.path}; the delivered file was left unchanged`,
      );
    const sha256 = await hashFile(source);
    if (sha256 !== artifact.sha256)
      throw new Error(
        `delivery: Build ${build.id} result bytes do not match the recorded Artifact hash; the delivered file was left unchanged`,
      );
    const bytes = (await stat(source)).size;

    const image: DeliveryImage = {
      target: target.id,
      build: build.id,
      artifact: artifact.id,
      path: relative,
      sha256,
      bytes,
      width: artifact.image.width,
      height: artifact.image.height,
      format: artifact.image.format,
      background: artifact.image.background,
      simulated: artifact.simulated,
      workbench: deliveryWorkbenchEntry(currentProject, target.id, {
        delivery: entry,
      }),
    };

    // Frozen material rights for the NEW Build. A newly introduced private Asset
    // is refused on a bundle that was not explicitly opted in; historical facts
    // of every other product are untouched.
    const facts = await collectImageMaterialFacts(bytesRoot, [image], currentProject);
    if (facts.privateAssets.length > 0 && oldManifest.containsNonRedistributableAssets !== true)
      throw new Error(
        `delivery: image target ${JSON.stringify(target.id)} uses non-redistributable Asset(s) ${facts.privateAssets
          .map(asset => asset.asset)
          .join(
            ', ',
          )}: this bundle was not delivered under the explicit allowNonRedistributable opt-in, so the delivered file was left unchanged`,
      );

    const oldImages = manifestImages(oldManifest);
    const images = oldImages.map(candidate => (candidate.target === target.id ? image : candidate));
    const oldMaterials = oldManifest.imageMaterials as DeliveryImageMaterial[];
    const imageMaterials = [
      ...oldMaterials.filter(material => material.target !== target.id),
      ...facts.imageMaterials,
    ].sort((a, b) => a.target.localeCompare(b.target));

    // Bundle-wide private list. When a movie is still delivered, the replaced
    // still's private Asset may also be the film's source, so no old private fact
    // is dropped: the bundle-wide list must not under-report a restriction just
    // because this still no longer names it. With no movie, only the replaced
    // still's own private ids that no remaining still records are dropped.
    const portablePrivate = portable === null ? [] : portablePrivateAssets(portable);
    const replacedPrivate = new Set<string>();
    if (oldManifest.movie == null) {
      for (const asset of oldMaterials.find(material => material.target === target.id)?.assets ?? [])
        if (!asset.rights.redistributable) replacedPrivate.add(asset.asset);
      const remainingPrivate = new Set(
        oldMaterials
          .filter(material => material.target !== target.id)
          .flatMap(material =>
            material.assets.filter(asset => !asset.rights.redistributable).map(asset => asset.asset),
          ),
      );
      for (const id of remainingPrivate) replacedPrivate.delete(id);
      for (const asset of facts.privateAssets) replacedPrivate.delete(asset.asset);
    }
    const privateById = new Map<string, DeliveryNonRedistributableAsset>();
    for (const asset of (oldManifest.nonRedistributableAssets ?? []) as DeliveryNonRedistributableAsset[])
      if (!replacedPrivate.has(asset.asset)) privateById.set(asset.asset, asset);
    for (const asset of [...portablePrivate, ...facts.privateAssets]) privateById.set(asset.asset, asset);
    const nonRedistributableAssets = [...privateById.values()].sort((a, b) => a.asset.localeCompare(b.asset));
    const simulated =
      oldManifest.simulated === true || image.simulated || facts.simulated || portable.simulated || false;

    // --- Stage the existing bundle as independent bytes ---------------------
    const staging = path.join(parentReal, `.${entry}.${randomUUID()}.staging`);
    if (path.dirname(staging) !== path.join(rootReal, OUTPUT_DIR))
      throw new Error(`delivery: staging must live directly inside ${OUTPUT_DIR}/ for an in-place update`);
    const releaseDelivery = await acquireDeliveryLock(rootReal);
    try {
      // CAS: the entry must still be the one observed at the start. Re-proving
      // the recorded hash immediately before the swap catches both an external
      // edit and a concurrent Runtime delivery/update.
      const fresh = await readVerifiedBundle(rootReal, location.bundleReal, location.record);
      if (fresh.manifestSha256 !== observedManifestSha)
        throw new Error(
          `delivery: ${OUTPUT_DIR}/${entry} changed while this still was being published; nothing was overwritten — retry`,
        );
      const recordedNow = await readDeliveryRecord(rootReal, oldRecord.name);
      if (recordedNow?.manifestSha256 !== observedManifestSha) {
        const recovered = await pendingDeliveryAcceptable(
          rootReal,
          oldRecord.name,
          'deliver',
          async () => fresh.manifestSha256,
        );
        if (!recovered)
          throw new Error(
            `delivery: ${OUTPUT_DIR}/${entry} was replaced by another delivery while this still was being published; nothing was overwritten — retry`,
          );
      }
      // A save during the staging above makes the Build describe older bytes:
      // refuse rather than mislabel them as the current design.
      const liveKey = await imageRenderKey(rootReal, target.id).catch(() => null);
      if (liveKey === null || liveKey !== operation.key || !(await currentImageMatches(rootReal, target.id, build)))
        throw new Error(
          `delivery: the saved source changed while the still was being published; the previous delivered file is unchanged (render the saved source again)`,
        );

      await mkdir(staging, { recursive: true });
      const planned = new Map<string, Planned>();
      const recordStaged = async (
        relativePath: string,
        absolute: string,
        role: BundleRole,
        provenance?: unknown,
        expected?: string,
      ): Promise<Planned> => {
        if (planned.has(relativePath)) throw new Error(`delivery: duplicate bundle path ${relativePath}`);
        const sha = await hashFile(absolute);
        if (expected !== undefined && sha !== expected)
          throw new Error(`delivery: staged file does not match its recorded hash: ${relativePath}`);
        const info = await stat(absolute);
        const plannedEntry: Planned = {
          absolute,
          sha256: sha,
          bytes: info.size,
          role,
          ...(provenance !== undefined ? { provenance } : {}),
        };
        planned.set(relativePath, plannedEntry);
        return plannedEntry;
      };

      // 1. Copy every retained product byte for byte, independently. The old
      //    still (which this publish replaces), the index and the manifest are
      //    the only paths not carried through; project/ is re-exported whole.
      const oldFiles = new Map(oldManifest.files.map(file => [file.path, file] as const));
      const carried: string[] = [];
      for (const previous of await walkFiles(location.bundleReal)) {
        if (previous === DELIVERY_MANIFEST || previous === INDEX_FILE) continue;
        if (previous === initial.image.path) continue;
        if (previous.startsWith(`${PROJECT_DIR}/`)) continue;
        const listed = oldFiles.get(previous);
        if (!listed) throw new Error(`delivery: unlisted bundle file ${previous}; the delivery is left untouched`);
        const targetPath = path.join(staging, ...previous.split('/'));
        await mkdir(path.dirname(targetPath), { recursive: true });
        await copyFile(path.join(location.bundleReal, ...previous.split('/')), targetPath);
        await recordStaged(previous, targetPath, listed.role, listed.provenance, listed.sha256);
        carried.push(previous);
      }
      const preserved = [...carried].filter(
        previous => !previous.startsWith(`${PROJECT_DIR}/`) && previous !== relative,
      );

      // 2. The refreshed editable project (when this bundle carries one).
      {
        const portableFiles = new Map(portable.files.map(file => [file.path, file] as const));
        const allowlist = new Set<string>([`${PROJECT_DIR}/${PORTABLE_MANIFEST}`]);
        for (const relativePath of await walkFiles(exportDir)) {
          const bundlePath = `${PROJECT_DIR}/${relativePath}`;
          const sourcePath = path.join(exportDir, ...relativePath.split('/'));
          const stagedPath = path.join(staging, ...bundlePath.split('/'));
          await mkdir(path.dirname(stagedPath), { recursive: true });
          await copyFile(sourcePath, stagedPath);
          if (relativePath === PORTABLE_MANIFEST) {
            await recordStaged(bundlePath, stagedPath, 'project');
          } else {
            const listed = portableFiles.get(relativePath);
            if (!listed) throw new Error(`delivery: unlisted project export file ${relativePath}`);
            await recordStaged(bundlePath, stagedPath, 'project', listed.provenance, listed.sha256);
          }
          allowlist.add(bundlePath);
        }
        assertSameSet(
          [...planned.keys()].filter(
            bundlePath =>
              bundlePath.startsWith(`${PROJECT_DIR}/`) || bundlePath === `${PROJECT_DIR}/${PORTABLE_MANIFEST}`,
          ),
          allowlist,
          'project export',
        );
      }

      // 3. The new delivered still, at its stable target path.
      const stagedImage = path.join(staging, ...relative.split('/'));
      await mkdir(path.dirname(stagedImage), { recursive: true });
      await copyFile(source, stagedImage);
      await recordStaged(
        relative,
        stagedImage,
        'image',
        {
          kind: 'image-target',
          target: target.id,
          build: build.id,
          artifact: artifact.id,
          document: target.document,
        },
        sha256,
      );

      // --- Rebuild the facts page from the retained products + new still ----
      const filmBuildId =
        oldManifest.movie != null
          ? ((oldManifest.build as { id?: unknown } | null | undefined)?.id as string | undefined)
          : undefined;
      let filmContext: IndexContext['film'] = null;
      let frozenProject: Project = currentProject;
      if (oldManifest.movie != null) {
        if (typeof filmBuildId !== 'string')
          throw new Error(
            `delivery: this bundle carries a movie but not the film Build that produced it; it is left untouched`,
          );
        const filmBuild = await readBuild(bytesRoot, filmBuildId);
        if (filmBuild.status !== 'succeeded' || !filmBuild.result)
          throw new Error(
            `delivery: the delivered film Build ${filmBuildId} is not a succeeded result; it is left untouched`,
          );
        const filmArtifact = filmBuild.artifacts.find(candidate => candidate.id === filmBuild.result!.artifact);
        if (!filmArtifact)
          throw new Error(
            `delivery: the delivered film Build ${filmBuildId} has no result Artifact; it is left untouched`,
          );
        const movieAbsolute = path.join(location.bundleReal, ...MOVIE_FILE.split('/'));
        const movieSha256 = await hashFile(movieAbsolute);
        if (movieSha256 !== filmArtifact.sha256)
          throw new Error(
            `delivery: the delivered movie does not match film Build ${filmBuildId}; it is left untouched`,
          );
        const frozen = validateProject(
          JSON.parse(
            await readFile(path.join(bytesRoot, RUNTIME_DIR, 'snapshots', `${filmBuild.id}.project.json`), 'utf8'),
          ),
        );
        frozenProject = requireFilmProject(frozen);
        filmContext = {
          build: filmBuild,
          result: {
            build: filmBuild.id,
            artifact: filmArtifact.id,
            simulated: filmArtifact.simulated,
            path: filmArtifact.path,
            sha256: filmArtifact.sha256,
          },
          artifact: filmArtifact,
          moviePath: MOVIE_FILE,
          movieSha256,
          movieBytes: (await stat(movieAbsolute)).size,
        };
      } else {
        frozenProject = currentProject;
      }

      const audio = oldManifest.audio as DeliveryAudio;
      const subtitles = oldManifest.subtitles as DeliverySubtitles | null;
      const playable = oldManifest.playable as DeliveryPlayable | null;
      const oldReview = oldManifest.review as DeliveryReview | null;
      let reviewed: IndexContext['review'] = null;
      if (oldReview !== null) {
        const report = JSON.parse(
          await readFile(path.join(location.bundleReal, ...oldReview.report.split('/')), 'utf8'),
        ) as ReviewReportShape;
        const mapping = DeliveryReviewPathsSchema.parse(
          JSON.parse(await readFile(path.join(location.bundleReal, ...oldReview.paths.split('/')), 'utf8')),
        );
        const contactSheet = mapping.paths.find(
          entry => entry.kind === 'contact-sheet' && entry.original === report.contactSheet,
        );
        if (
          mapping.build !== oldReview.build ||
          (report.contactSheet !== undefined && contactSheet?.bundle !== oldReview.contactSheet)
        )
          throw new Error('delivery: retained review report does not match the bundle review products');
        reviewed = {
          report,
          contactSheet: oldReview.contactSheet,
          seams: oldReview.seams,
          layers: oldReview.layers,
          candidates: [],
          retainedCandidates: oldReview.candidates,
          reviewReport: oldReview.report,
          reviewPaths: oldReview.paths,
        };
      }
      const programmeFrozenPath =
        audio.programmeSha256 === null
          ? null
          : ([...planned.entries()].find(
              ([bundlePath, entry]) =>
                bundlePath.startsWith(`${PROJECT_DIR}/`) && entry.sha256 === audio.programmeSha256,
            )?.[0] ?? null);

      const indexHtml = renderIndex({
        currentProject,
        frozenProject,
        film: filmContext,
        images,
        sounds,
        imageMaterials,
        subtitles,
        audio: {
          programme:
            audio.programme !== null && audio.programmeSha256 !== null && audio.programmeBytes !== null
              ? { path: audio.programme, sha256: audio.programmeSha256, bytes: audio.programmeBytes }
              : null,
          programmeFrozenPath,
          stems: audio.stems.map(stem => ({
            bus: stem.bus,
            path: stem.path,
            sha256: stem.sha256,
            bytes: stem.bytes,
          })),
        },
        portableSimulated: portable.simulated,
        simulated,
        review: reviewed,
        playable,
        nonRedistributableAssets,
      });
      const indexPath = path.join(staging, INDEX_FILE);
      await writeFile(indexPath, indexHtml, { mode: 0o600 });
      await recordStaged(INDEX_FILE, indexPath, 'index');

      const files: DeliveryFile[] = [...planned.entries()]
        .map(([relativePath, entry]) => ({
          path: relativePath,
          sha256: entry.sha256,
          bytes: entry.bytes,
          role: entry.role,
          ...(entry.provenance !== undefined ? { provenance: entry.provenance } : {}),
        }))
        .sort((a, b) => a.path.localeCompare(b.path));

      const logicalBytes = [...planned.values()].reduce((sum, entry) => sum + entry.bytes, 0);
      // Frozen duplicates may share one read-only inode, exactly like a full
      // delivery; this must run before the physical-size accounting.
      const editable = (relativePath: string, entry: Planned): boolean =>
        entry.role === 'project' && !relativePath.startsWith(`${PROJECT_DIR}/${RUNTIME_DIR}/`);
      await dedupeFrozenBySha(staging, planned, editable);

      // Payload physical bytes: each distinct (dev, inode) counts once, so a
      // legitimately deduplicated frozen copy is counted once; the manifest is
      // excluded from the payload.
      const physical = new Map<string, number>();
      for (const relativePath of planned.keys()) {
        const info = await stat(path.join(staging, ...relativePath.split('/')), { bigint: true });
        physical.set(`${info.dev}:${info.ino}`, Number(info.size));
      }
      const physicalBytes = [...physical.values()].reduce((sum, size) => sum + size, 0);
      const projectExport = {
        path: PROJECT_DIR,
        files: portable.files.length,
        simulated: portable.simulated,
        builds: portable.builds,
        artifacts: portable.artifacts,
        scope: portable.scope,
      };
      const projectInfo = {
        id: currentProject.id,
        revision: currentProject.revision,
        title: currentProject.title,
        schemaVersion: currentProject.schemaVersion,
      };
      const manifestBody: Record<string, unknown> = {
        ...oldManifest,
        exportedAt: new Date().toISOString(),
        project: projectInfo,
        simulated,
        selection: {
          movie: filmContext !== null,
          images: images.map(entry => entry.target),
          sounds: sounds.map(sound => sound.target),
        },
        movie: oldManifest.movie,
        images,
        sounds,
        imageMaterials,
        projectExport,
        // Payload bytes exclude the manifest itself, exactly like a delivery.
        bytes: physicalBytes,
        logicalBytes,
        files,
        diagnostics: [],
        notes: [
          ...(oldManifest.notes as string[]),
          `image/${target.id}.${extension} was replaced in place from Build ${build.id}; the previously delivered file is superseded, while its Build and immutable Artifact remain readable in the Project.`,
        ],
      };
      delete manifestBody.updates;
      if (nonRedistributableAssets.length > 0) {
        manifestBody.containsNonRedistributableAssets = true;
        manifestBody.nonRedistributableAssets = nonRedistributableAssets;
      } else {
        delete manifestBody.containsNonRedistributableAssets;
        delete manifestBody.nonRedistributableAssets;
      }
      // the handoff text is retained byte-identically; a fresh report keeps
      // the manifest honest without ever blocking the publish.
      manifestBody.diagnostics = await scanBundleDiagnostics(staging, planned, rootReal);

      const manifestPath = path.join(staging, DELIVERY_MANIFEST);
      await writeFile(manifestPath, `${JSON.stringify(manifestBody, null, 2)}\n`, { mode: 0o600 });
      const finalManifestSha256 = await hashFile(manifestPath);
      if (finalManifestSha256 === observedManifestSha)
        throw new Error('delivery: internal error — the update manifest did not change; nothing was published');

      assertSameSet(await walkFiles(staging), new Set([...planned.keys(), DELIVERY_MANIFEST]), 'delivery bundle');
      for (const [relativePath, entry] of planned) {
        const actual = await hashFile(path.join(staging, ...relativePath.split('/')));
        if (actual !== entry.sha256) throw new Error(`delivery: staged file failed verification: ${relativePath}`);
      }

      // A save during staging (which may copy a large movie) makes this Build
      // describe older bytes. Re-check the LIVE source immediately before the
      // pending marker / swap; a mismatch leaves the old delivery untouched and
      // never deletes the historical Artifact.
      const publishedKey = await imageRenderKey(rootReal, initial.target.id).catch(() => null);
      if (
        publishedKey === null ||
        publishedKey !== operation.key ||
        !(await currentImageMatches(rootReal, initial.target.id, build))
      )
        throw new Error(
          `delivery: the saved source changed while the still was being staged; the previous delivered file is unchanged (render the saved source again)`,
        );

      const newRecord: DeliveryRecord = {
        name: oldRecord.name,
        kind: 'deliver',
        ...(oldManifest.movie != null && typeof filmBuildId === 'string' ? { build: filmBuildId } : {}),
        revision: currentProject.revision,
        deliveredAt: new Date().toISOString(),
        manifestSha256: finalManifestSha256,
      };
      await markDeliveryPending(rootReal, newRecord);
      await replaceStagedDirectory(staging, location.bundleReal);
      await writeDeliveryRecord(rootReal, newRecord);
      await clearDeliveryPending(rootReal, newRecord.name);

      return {
        entry,
        path: location.bundleReal,
        productPath: relative,
        projectPath: `${OUTPUT_DIR}/${entry}/${relative}`,
        target: target.id,
        document: document.id,
        image,
        build: build.id,
        artifact: artifact.id,
        format: image.format,
        width: image.width,
        height: image.height,
        sha256,
        bytes: physicalBytes,
        simulated: image.simulated,
        previous: {
          path: initial.image.path,
          sha256: initial.image.sha256,
          bytes: initial.image.bytes,
          build: initial.image.build,
          artifact: initial.image.artifact,
        },
        images,
        sounds,
        imageMaterials,
        workbench: image.workbench,
        manifest: DELIVERY_MANIFEST,
        manifestSha256: finalManifestSha256,
        preserved,
        project: {
          path: PROJECT_DIR,
          files: portable.files.length,
          simulated: portable.simulated,
          builds: portable.builds,
          warnings: portableExport.warnings,
          originals: portableExport.originals,
          scope: portableExport.scope,
        },
        retained: {
          movie: filmContext !== null,
          images: images.filter(entry => entry.target !== target.id).map(entry => entry.target),
          files: preserved.length,
        },
        files: planned.size,
        logicalBytes,
      };
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    } finally {
      await releaseDelivery();
    }
  } finally {
    await rm(exportDir, { recursive: true, force: true });
  }
}
