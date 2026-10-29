import {
  type DeliveryOutputs,
  type DeliveryResult,
  DeliveryOptionsSchema,
  DeliveryReviewPathsSchema,
  DELIVERY_MANIFEST,
  RUNTIME_DIR,
  type Planned,
  type BundleRole,
  type DeliveryImage,
  IMAGE_DIR,
  PROJECT_DIR,
  type ResolvedSelection,
  type DeliveryImageMaterial,
  ActiveResultSchema,
  type DeliveryNonRedistributableAsset,
  PORTABLE_MANIFEST,
  MOVIE_FILE,
  type DeliverySound,
  DeliverySoundSchema,
  type DeliveryReview,
  type ReviewReportShape,
  REVIEW_DIR,
  REVIEW_LAYERS_DIR,
  REVIEW_PATHS_FILE,
  type DeliveryPlayable,
  PLAYABLE_DIR,
  PLAYABLE_MANIFEST,
  type DeliverySubtitles,
  SUBTITLE_FILE,
  type DeliveryAudio,
  AUDIO_PROGRAMME,
  type DeliveryAudioStem,
  BUS_LABEL,
  AUDIO_DIR,
  INDEX_FILE,
  type DeliveryFile,
  FORMAT,
  VERSION,
} from './delivery-contract.js';
import { realpath, mkdir, stat, copyFile, readFile, writeFile, rm, rename } from 'node:fs/promises';
import {
  type Project,
  type BuildRecord,
  type Artifact,
  PlayablePackageManifestSchema,
  requireFilmProject,
  requireComposition,
} from '../../core/schema.js';
import { loadProject, acquireLock, validateProject } from '../../project/project.js';
import {
  resolveOutputSelection,
  pathExists,
  isInside,
  assertSameSet,
  walkFiles,
  assertAttributionComplete,
  dedupeFrozenBySha,
  scanBundleDiagnostics,
} from './delivery-files.js';
import { hashFile, stableHash } from '../../shared/hash.js';
import path from 'node:path';
import { verifyDelivery } from './delivery-verification.js';
import {
  pendingDeliveryAcceptable,
  assertReplaceableDefault,
  defaultDeliveryPath,
  readDeliveryRecord,
  outputRecordName,
  OUTPUT_DIR,
  type DeliveryRecord,
  acquireDeliveryLock,
  markDeliveryPending,
  replaceStagedDirectory,
  writeDeliveryRecord,
  clearDeliveryPending,
} from '../../project/output.js';
import { resolveDestination, exportProject } from './portable.js';
import { PortableManifestSchema } from './portable-contract.js';
import { randomUUID } from 'node:crypto';
import { imageRenderKey } from '../../build/image.js';
import {
  currentImageMatches,
  deliveryWorkbenchEntry,
  portablePrivateAssets,
  collectImageMaterialFacts,
} from './image-facts.js';
import { resolveProjectPath } from '../../shared/fs.js';
import { z } from 'zod';
import { readBuilds, readBuild } from '../../project/build-records.js';
import { listVersions } from '../../project/versions.js';
import { type CandidateComparisonEntry, reviewBuild } from '../analysis/review.js';
import { exportPlayable } from './playable-export.js';
import { renderSubtitleSidecar } from './subtitle-sidecar.js';
import { renderIndex } from './delivery-page.js';

export async function deliverProject(
  root: string,
  destination: string | undefined,
  options: {
    playableSource?: string;
    allowNonRedistributable?: boolean;
    allowMissingOriginals?: boolean;
    allowIncompleteAuthored?: boolean;
    /** Attach technical review products for the selected movie. */
    review?: boolean;
    /** Attach `audio/` (programme + grouped stems). */
    stems?: boolean;
    /** Which products to deliver. Omitted = every declared output. */
    outputs?: DeliveryOutputs;
  } = {},
): Promise<DeliveryResult> {
  options = DeliveryOptionsSchema.parse(options);
  const reviewRequested = options.review === true;
  const stemsRequested = options.stems === true;
  // Default off. When false/omitted this function is byte-for-byte and
  // message-for-message identical to the strict delivery: any non-redistributable
  // Asset still aborts and no destination is produced. When true, the private
  // bytes ARE included, but the delivered manifest and index unmistakably declare
  // that the bundle is a private copy not cleared for redistribution.
  const allowNonRedistributable = options.allowNonRedistributable === true;
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    throw new Error(`delivery: project root does not exist: ${root}`);
  }
  // The product selection is the caller's decision, not an inference from what
  // the Project happens to contain. Read the current author state once for the
  // fail-early checks and the default selection; it is re-resolved under the
  // writer locks before any product is copied.
  let earlyProject: Project;
  try {
    earlyProject = await loadProject(rootReal);
  } catch (error) {
    throw new Error(`delivery: cannot read the Project at ${root}: ${(error as Error).message}`);
  }
  const earlySelection = resolveOutputSelection(earlyProject, options.outputs);
  // One fixed destination inside output/. A repeat delivery replaces the previous
  // default only when it is a recorded Runtime delivery whose recorded manifest
  // is unchanged AND whose actual members still match that manifest; otherwise
  // it is refused.
  let replaceDefault = false;
  /**
   * The recorded manifest hash this delivery observed at its gate. It is the
   * compare-and-swap base for publishing: a concurrent in-place still update
   * publishes a new manifest + record, and this delivery must then refuse rather
   * than overwrite it with bytes staged from the older bundle.
   */
  let observedRecordManifestSha: string | null = null;
  const dirName = 'handoff';
  // The OLD bundle's recorded-manifest hash. Re-derived here so the same check
  // runs both before staging and immediately before the final replace.
  const currentManifestHash = async (): Promise<string | null> => {
    try {
      return await hashFile(path.join(destination as string, DELIVERY_MANIFEST));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  // Re-verify the OLD bundle's ACTUAL members against its own manifest allowlist.
  const proveMembersUnmodified = async (): Promise<void> => {
    const verification = await verifyDelivery(destination as string);
    if (!verification.ok)
      throw new Error(
        `altered: ${[...verification.mismatched.map(item => item.path), ...verification.missing, ...verification.unlisted].join(', ') || 'member set changed'}`,
      );
  };
  // The complete replace-protection check. It is run at the gate and AGAIN right
  // before the swap: a package swapped for a different-but-self-consistent one
  // during production is only caught by re-comparing against the recorded hash,
  // which self-consistency verification alone cannot see. A published-but-
  // unrecorded bundle from an interrupted earlier delivery (identified by our own
  // recovery marker) is accepted as ours so re-delivering to the same default
  // succeeds after a crash.
  const assertReplaceable = async (): Promise<void> => {
    if (await pendingDeliveryAcceptable(rootReal, dirName, 'deliver', currentManifestHash)) {
      await proveMembersUnmodified();
      return;
    }
    await assertReplaceableDefault(rootReal, dirName, 'deliver', currentManifestHash, proveMembersUnmodified);
  };
  if (reviewRequested && !earlySelection.movie)
    throw new Error('delivery: --review / review requires a selected movie');
  if (stemsRequested && !earlySelection.movie)
    throw new Error(
      'delivery: --stems / stems applies to a film delivery only; select the movie (or omit --stems) because this delivery selects still images only',
    );
  if (destination === undefined) {
    // Fail before creating output/ when the selected movie has nothing to
    // deliver. An image-only selection does not need `.viscraft/result.json`;
    // its own missing/stale check runs when the still is resolved.
    if (earlySelection.movie && !(await pathExists(path.join(rootReal, RUNTIME_DIR, 'result.json'))))
      throw new Error('delivery: the project has no active .viscraft/result.json; build a result before delivering');
    destination = await defaultDeliveryPath(rootReal, dirName);
    replaceDefault = await pathExists(destination);
    if (replaceDefault) {
      await assertReplaceable();
      observedRecordManifestSha = (await readDeliveryRecord(rootReal, dirName))?.manifestSha256 ?? null;
    }
  }
  const { destReal, parentReal } = await resolveDestination(destination, rootReal, { allowExisting: replaceDefault });
  // A bundle that lands directly in output/ is a Runtime-managed delivery a
  // workbench can later bind and update in place; anything else is a plain copy.
  const recordName = outputRecordName(rootReal, destReal);

  const staging = path.join(parentReal, `.${path.basename(destReal)}.${randomUUID()}.staging`);
  const stagingInOutput = parentReal === path.join(rootReal, OUTPUT_DIR);
  if (!stagingInOutput && (staging === rootReal || isInside(rootReal, staging) || isInside(staging, rootReal))) {
    throw new Error(`delivery: private staging directory must be outside the project root or inside ${OUTPUT_DIR}/`);
  }
  await mkdir(staging, { recursive: true });

  try {
    const planned = new Map<string, Planned>();
    const record = async (
      relative: string,
      absolute: string,
      role: BundleRole,
      provenance?: unknown,
    ): Promise<Planned> => {
      const info = await stat(absolute);
      if (!info.isFile()) throw new Error(`delivery: expected a regular file at ${relative}`);
      if (planned.has(relative)) throw new Error(`delivery: duplicate bundle path ${relative}`);
      const entry: Planned = {
        absolute,
        sha256: await hashFile(absolute),
        bytes: info.size,
        role,
        ...(provenance !== undefined ? { provenance } : {}),
      };
      planned.set(relative, entry);
      return entry;
    };
    const copyIn = async (
      sourceAbsolute: string,
      relative: string,
      role: BundleRole,
      expected: string | undefined,
      provenance?: unknown,
    ): Promise<Planned> => {
      const sourceInfo = await stat(sourceAbsolute);
      if (!sourceInfo.isFile()) throw new Error(`delivery: source is not a regular file for ${relative}`);
      if (expected !== undefined && (await hashFile(sourceAbsolute)) !== expected)
        throw new Error(`delivery: source hash mismatch for ${relative}`);
      const target = path.join(staging, ...relative.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(sourceAbsolute, target);
      const entry = await record(relative, target, role, provenance);
      if (expected !== undefined && entry.sha256 !== expected)
        throw new Error(`delivery: staged hash mismatch for ${relative}`);
      return entry;
    };
    /**
     * Resolve and copy one selected still. The Build must be a succeeded,
     * non-preview image Build of this target whose `render-image` operation key
     * equals the key the CURRENT document/resources/output settings produce
     * (`imageRenderKey`), so a reverted source legitimately matches an older
     * Build. The result Artifact relationship and its real bytes are verified.
     * Delivery NEVER renders and never submits a model task.
     */
    const copyImages = async (
      project: Project,
      builds: readonly BuildRecord[],
      bytesRoot: string,
      targets: readonly string[],
      workbench: { delivery: string | null },
    ): Promise<DeliveryImage[]> => {
      const delivered: DeliveryImage[] = [];
      for (const targetId of targets) {
        const target = project.imageTargets.find(candidate => candidate.id === targetId);
        if (!target) throw new Error(`delivery: unknown image target ${JSON.stringify(targetId)}`);
        let key: string | null = null;
        try {
          // Compute the key from the SAME exported tree as the Build records,
          // so a concurrent author edit cannot pair a still
          // Build with project bytes it was not rendered from.
          key = await imageRenderKey(bytesRoot, targetId);
        } catch {
          key = null;
        }
        const candidates = builds.filter(
          build =>
            build.status === 'succeeded' && !build.preview && build.target === targetId && build.result !== undefined,
        );
        const chosen =
          key === null
            ? undefined
            : candidates
                .map(build => ({
                  build,
                  operation: build.operations.find(
                    operation => operation.kind === 'render-image' && operation.key === key,
                  ),
                }))
                .find(
                  entry => entry.operation !== undefined && entry.build.result?.artifact === entry.operation.artifact,
                );
        if (!chosen?.operation) {
          const newest = candidates[0];
          throw new Error(
            newest
              ? `delivery: image target ${JSON.stringify(targetId)} is stale: its newest still (Build ${newest.id}) does not match the current document/resources/output settings; run \`viscraft image <project-directory> --target ${targetId}\` before delivering (delivery never renders automatically)`
              : `delivery: image target ${JSON.stringify(targetId)} has no succeeded render; run \`viscraft image <project-directory> --target ${targetId}\` before delivering (delivery never renders automatically)`,
          );
        }
        if (!(await currentImageMatches(bytesRoot, targetId, chosen.build)))
          throw new Error(
            `delivery: image target ${JSON.stringify(targetId)} environment changed or is unverified; render on the current machine before delivering`,
          );
        const artifact = chosen.build.artifacts.find(candidate => candidate.id === chosen.operation!.artifact);
        if (!artifact || artifact.kind !== 'image' || !artifact.image)
          throw new Error(
            `delivery: image target ${JSON.stringify(targetId)} Build ${chosen.build.id} has no image result Artifact ${chosen.operation.artifact}`,
          );
        const extension = artifact.image.format === 'jpeg' ? 'jpg' : artifact.image.format;
        const relative = `${IMAGE_DIR}/${targetId}.${extension}`;
        const source = await resolveProjectPath(bytesRoot, artifact.path);
        if (!(await pathExists(source)))
          throw new Error(
            `delivery: image target ${JSON.stringify(targetId)} result bytes are missing at ${artifact.path}; run \`viscraft image <project-directory> --target ${targetId}\` again before delivering`,
          );
        const entry = await copyIn(source, relative, 'image', artifact.sha256, {
          kind: 'image-target',
          target: targetId,
          build: chosen.build.id,
          artifact: artifact.id,
          document: target.document,
        });
        delivered.push({
          target: targetId,
          build: chosen.build.id,
          artifact: artifact.id,
          path: relative,
          sha256: entry.sha256,
          bytes: entry.bytes,
          width: artifact.image.width,
          height: artifact.image.height,
          format: artifact.image.format,
          background: artifact.image.background,
          simulated: artifact.simulated,
          workbench: deliveryWorkbenchEntry(project, targetId, workbench),
        });
      }
      return delivered;
    };

    const projectDir = path.join(staging, PROJECT_DIR);
    let portable: z.infer<typeof PortableManifestSchema>;
    let exportWarnings: string[] = [];
    let currentProject: Project = earlyProject;
    let selection: ResolvedSelection = earlySelection;
    let images: DeliveryImage[] = [];
    let imageMaterials: DeliveryImageMaterial[] = [];
    let filmFacts: {
      build: BuildRecord;
      result: z.infer<typeof ActiveResultSchema>;
      artifact: Artifact;
      movie: Planned;
    } | null = null;
    let nonRedistributableAssets: DeliveryNonRedistributableAsset[] = [];
    /** True when an Asset the selected stills use is simulated (scoped provenance). */
    let imageUsageSimulated = false;

    // --- 1. Freeze the delivered products under both writer locks -----------
    {
      // `exportProject` reads the authored project + lineage and stages a
      // sibling directory; it takes no locks itself, so hold the project
      // build/author locks for exactly this call (authoring/building must not
      // race the snapshot).
      const exportDir = path.join(staging, PROJECT_DIR);
      const releaseBuild = await acquireLock(root, 'build');
      try {
        const releaseAuthor = await acquireLock(root, 'author');
        try {
          exportWarnings = (
            await exportProject(root, exportDir, {
              allowNonRedistributable,
              allowMissingOriginals: options.allowMissingOriginals,
              allowIncompleteAuthored: options.allowIncompleteAuthored,
            })
          ).warnings;
        } finally {
          await releaseAuthor();
        }
      } finally {
        await releaseBuild();
      }

      // Selection is resolved from the frozen exported project, never from the
      // live tree that may have moved on since the export.
      currentProject = validateProject(JSON.parse(await readFile(path.join(exportDir, 'project.json'), 'utf8')));
      selection = resolveOutputSelection(currentProject, options.outputs);
      // Re-judge both explicit attachments against the FROZEN selection, not
      // only the early live read: an authoring save between the early load and
      // this export can remove the composition, and a requested review/stems
      // must then be refused instead of silently dropped.
      if (reviewRequested && !selection.movie) throw new Error('delivery: --review / review requires a selected movie');
      if (stemsRequested && !selection.movie)
        throw new Error(
          'delivery: --stems / stems applies to a film delivery only; this delivery selects still images only',
        );
    }

    // --- 2. Editable project files come from the Portable manifest ONLY -----
    {
      const exportDir = projectDir;
      const portablePath = path.join(exportDir, ...PORTABLE_MANIFEST.split('/'));
      const portableManifest = PortableManifestSchema.parse(JSON.parse(await readFile(portablePath, 'utf8')));
      portable = portableManifest;
      const projectAllowlist = new Set<string>([`${PROJECT_DIR}/${PORTABLE_MANIFEST}`]);
      for (const file of portableManifest.files) {
        const entry = await record(
          `${PROJECT_DIR}/${file.path}`,
          path.join(exportDir, ...file.path.split('/')),
          'project',
          file.provenance,
        );
        if (entry.sha256 !== file.sha256) throw new Error(`delivery: portable manifest hash mismatch for ${file.path}`);
        projectAllowlist.add(`${PROJECT_DIR}/${file.path}`);
      }
      // Collect every non-redistributable Asset actually included in the portable
      // export. Its bytes are present only because the caller opted in; dedupe by
      // Asset id (preferring the authored path over a frozen one) so the bundle
      // marker names each private Asset once and the rights are never hidden.
      const logicalPaths = new Set<string>();
      const usedContent = new Set<string>();
      for (const asset of portableManifest.snapshotAssets) {
        if (logicalPaths.has(asset.path) || projectAllowlist.has(`${PROJECT_DIR}/${asset.path}`))
          throw new Error(`delivery: invalid deduplicated snapshot Asset path ${asset.path}`);
        logicalPaths.add(asset.path);
        const content = planned.get(`${PROJECT_DIR}/${asset.content}`);
        if (
          !content ||
          content.sha256 !== asset.sha256 ||
          (content.provenance as { kind?: string } | undefined)?.kind !== 'snapshot-content'
        )
          throw new Error(`delivery: snapshot Asset content failed verification: ${asset.path}`);
        if (!asset.provenance.rights.redistributable && !allowNonRedistributable)
          throw new Error(
            `delivery: snapshot Asset ${asset.provenance.assetId} is not redistributable: this is a private/rights-unverified Asset, so packaging it is only allowed with the explicit allowNonRedistributable opt-in, and the resulting bundle is not cleared for redistribution`,
          );
        usedContent.add(asset.content);
      }
      for (const file of portableManifest.files)
        if (file.provenance.kind === 'snapshot-content' && !usedContent.has(file.path))
          throw new Error(`delivery: unreferenced snapshot content ${file.path}`);
      nonRedistributableAssets = portablePrivateAssets(portableManifest);
      await record(`${PROJECT_DIR}/${PORTABLE_MANIFEST}`, portablePath, 'project');
      assertSameSet(
        (await walkFiles(exportDir)).map(file => `${PROJECT_DIR}/${file}`),
        projectAllowlist,
        'project export',
      );
    }

    // --- 3. The ACTIVE result defines the delivered movie -------------------
    // Only a selected movie reads `.viscraft/result.json`. An image-only
    // delivery is never forced to produce or include a film result.
    if (selection.movie) {
      const resultPath = path.join(projectDir, RUNTIME_DIR, 'result.json');
      if (!(await pathExists(resultPath)))
        throw new Error('delivery: the project has no active .viscraft/result.json; build a result before delivering');
      const result = ActiveResultSchema.parse(JSON.parse(await readFile(resultPath, 'utf8')));
      const builds = await readBuilds(projectDir);
      const build = builds.find(candidate => candidate.id === result.build);
      if (!build) throw new Error(`delivery: active result references unknown Build ${result.build}`);
      if (build.status !== 'succeeded' || !build.result)
        throw new Error(`delivery: active Build ${build.id} is ${build.status} and has no result to deliver`);
      if (build.result.artifact !== result.artifact || build.result.simulated !== result.simulated)
        throw new Error('delivery: active result does not match the recorded Build result');
      const artifact = build.artifacts.find(candidate => candidate.id === result.artifact);
      if (
        !artifact ||
        artifact.path !== result.path ||
        artifact.sha256 !== result.sha256 ||
        artifact.simulated !== result.simulated
      )
        throw new Error('delivery: active result does not match the recorded Artifact');
      const movie = await copyIn(
        await resolveProjectPath(projectDir, result.path),
        MOVIE_FILE,
        'movie',
        result.sha256,
        {
          build: build.id,
          artifact: artifact.id,
          artifactPath: artifact.path,
          operation: artifact.operation,
          simulated: artifact.simulated,
        },
      );
      filmFacts = { build, result, artifact, movie };
    }

    // Stills are resolved after the selected film's own readiness check, so a
    // default set whose film has not been built reports that fact instead of a
    // Material facts use the SAME frozen-snapshot boundary for stills whether or
    // not a movie is also selected: the film's own frozen Asset table must not be
    // the only place a still's materials are stated.
    if (selection.images.length > 0) {
      images = await copyImages(currentProject, await readBuilds(projectDir), projectDir, selection.images, {
        delivery: recordName,
      });
      const facts = await collectImageMaterialFacts(projectDir, images, currentProject);
      if (facts.privateAssets.length > 0 && !allowNonRedistributable)
        throw new Error(
          `delivery: image target(s) ${selection.images.join(', ')} use non-redistributable Asset(s) ${facts.privateAssets
            .map(asset => asset.asset)
            .join(
              ', ',
            )}: this is private/rights-unverified material, so packaging it is only allowed with the explicit allowNonRedistributable opt-in, and the resulting bundle is not cleared for redistribution`,
        );
      const merged = new Map(nonRedistributableAssets.map(asset => [asset.asset, asset] as const));
      for (const asset of facts.privateAssets) if (!merged.has(asset.asset)) merged.set(asset.asset, asset);
      nonRedistributableAssets = [...merged.values()].sort((a, b) =>
        a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0,
      );
      imageMaterials = facts.imageMaterials;
      imageUsageSimulated = imageUsageSimulated || facts.simulated;
    }

    const sounds: DeliverySound[] = [];
    if (selection.sounds.length > 0) {
      const versions = await listVersions(projectDir);
      for (const targetId of selection.sounds) {
        const version = versions.versions.find(
          candidate => candidate.medium === 'sound' && candidate.target === targetId && candidate.current,
        );
        if (!version?.result?.available || !version.result.audio)
          throw new Error(
            `delivery: sound target ${JSON.stringify(targetId)} has no available current programme; build --target ${targetId} before delivering`,
          );
        const build = await readBuild(projectDir, version.id);
        const artifact = build.artifacts.find(candidate => candidate.id === build.result?.artifact);
        if (!artifact || artifact.kind !== 'audio')
          throw new Error(`delivery: sound Build ${build.id} has no audio result`);
        const relative = `sound/${targetId}.wav`;
        const entry = await copyIn(
          await resolveProjectPath(projectDir, artifact.path),
          relative,
          'audio',
          artifact.sha256,
          { kind: 'sound-target', target: targetId, build: build.id, artifact: artifact.id },
        );
        sounds.push(
          DeliverySoundSchema.parse({
            target: targetId,
            build: build.id,
            artifact: artifact.id,
            path: relative,
            sha256: entry.sha256,
            bytes: entry.bytes,
            ...version.result.audio,
            simulated: artifact.simulated,
          }),
        );
      }
    }

    // --- 4. Optional technical review attachment ---------------------------
    // Review attachments require a selected film.
    let reviewed: {
      result: DeliveryReview;
      report: ReviewReportShape;
      candidates: Array<{ shot: string; strip: string | null; entries: CandidateComparisonEntry[] }>;
    } | null = null;
    if (reviewRequested && filmFacts !== null) {
      const build = filmFacts.build;
      // `reviewBuild` returns the contact sheet, seam strips and report. The report
      // additionally names per-picture-layer strips, which are review products too;
      // copy every explicitly reported product (never a recursive directory copy).
      const review = await reviewBuild(projectDir, build.id);
      const reviewPrefix = `${RUNTIME_DIR}/reviews/${build.id}/`;
      const bundleName = (relative: string): string => {
        if (!relative.startsWith(reviewPrefix))
          throw new Error(`delivery: review product escaped its directory: ${relative}`);
        const name = path.posix.basename(relative);
        if (name === '' || name === '.' || name === '..' || name.includes('/'))
          throw new Error(`delivery: invalid review product name: ${relative}`);
        return name;
      };
      const reportAbsolute = await resolveProjectPath(projectDir, review.report);
      const report = JSON.parse(await readFile(reportAbsolute, 'utf8')) as ReviewReportShape;
      // The report is the source of truth for layer strips; cross-check the products
      // it names against the API result so a mismatched report cannot smuggle a path.
      if (report.contactSheet !== undefined && report.contactSheet !== review.contactSheet)
        throw new Error('delivery: review report contact sheet does not match the review result');
      if (report.seams !== undefined && stableHash(report.seams) !== stableHash(review.seams))
        throw new Error('delivery: review report seams do not match the review result');

      const contactSheet = `${REVIEW_DIR}/${bundleName(review.contactSheet)}`;
      const contactEntry = await copyIn(
        await resolveProjectPath(projectDir, review.contactSheet),
        contactSheet,
        'review',
        undefined,
        { kind: 'contact-sheet', build: build.id },
      );
      const seams: string[] = [];
      const seamsSha256: string[] = [];
      for (const seam of review.seams) {
        const relative = `${REVIEW_DIR}/${bundleName(seam)}`;
        const entry = await copyIn(await resolveProjectPath(projectDir, seam), relative, 'review', undefined, {
          kind: 'seam',
          build: build.id,
        });
        seams.push(relative);
        seamsSha256.push(entry.sha256);
      }
      const layerStrips = (report.timeline?.layers ?? []).filter(
        (layer): layer is { id?: string; strip: string } => typeof layer.strip === 'string',
      );
      const layers: string[] = [];
      const layersSha256: string[] = [];
      for (const layer of layerStrips) {
        const relative = `${REVIEW_DIR}/${REVIEW_LAYERS_DIR}/${bundleName(layer.strip)}`;
        const entry = await copyIn(await resolveProjectPath(projectDir, layer.strip), relative, 'review', undefined, {
          kind: 'layer',
          build: build.id,
          ...(layer.id ? { layer: layer.id } : {}),
        });
        layers.push(relative);
        layersSha256.push(entry.sha256);
      }
      // Candidate-Take comparison strips are review products too (one per shot the
      // Build declared candidates for). Copy each reported strip from the same
      // private review directory and hash it like every other member; a Build with
      // no candidates reports none, so no file or manifest entry is added.
      const candidates: string[] = [];
      const candidatesSha256: string[] = [];
      const candidateMapping: Array<{ original: string; bundle: string; kind: string }> = [];
      for (const comparison of review.candidateComparisons) {
        if (!comparison.strip) continue;
        const relative = `${REVIEW_DIR}/${bundleName(comparison.strip)}`;
        const entry = await copyIn(
          await resolveProjectPath(projectDir, comparison.strip),
          relative,
          'review',
          undefined,
          { kind: 'candidate-comparison', build: build.id, shot: comparison.shot },
        );
        candidates.push(relative);
        candidatesSha256.push(entry.sha256);
        candidateMapping.push({ original: comparison.strip, bundle: relative, kind: 'candidate-comparison' });
      }
      const reportRelative = `${REVIEW_DIR}/${bundleName(review.report)}`;
      const reportEntry = await copyIn(reportAbsolute, reportRelative, 'review', undefined, {
        kind: 'report',
        build: build.id,
      });

      // The verbatim report keeps the exported project's `.viscraft/reviews/<build>/…`
      // paths, but that generated directory is removed from `project/`. Ship a small
      // companion map from each original path to its bundled location so the report
      // is never silently dangling, without rewriting the report bytes.
      const reviewMapping: Array<{ original: string; bundle: string; kind: string }> = [
        { original: review.contactSheet, bundle: contactSheet, kind: 'contact-sheet' },
        ...review.seams.map((seam, index) => ({ original: seam, bundle: seams[index], kind: 'seam' })),
        ...layerStrips.map((layer, index) => ({ original: layer.strip, bundle: layers[index], kind: 'layer' })),
        ...candidateMapping,
        { original: review.report, bundle: reportRelative, kind: 'report' },
      ].sort((a, b) => a.original.localeCompare(b.original));
      const reviewPathsPath = path.join(staging, ...`${REVIEW_DIR}/${REVIEW_PATHS_FILE}`.split('/'));
      await writeFile(
        reviewPathsPath,
        `${JSON.stringify(
          DeliveryReviewPathsSchema.parse({
            format: 'viscraft-delivery-review-paths',
            version: 1,
            build: build.id,
            reviewRoot: REVIEW_DIR,
            note: 'The editable project export intentionally omits its generated .viscraft/reviews directory, so the original path of each review product is absent from project/. review/report.json is copied verbatim and keeps those original project-relative paths; this map resolves each to its bundled location under review/.',
            paths: reviewMapping,
          }),
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      const reviewPaths = `${REVIEW_DIR}/${REVIEW_PATHS_FILE}`;
      const reviewPathsEntry = await record(reviewPaths, reviewPathsPath, 'review', {
        kind: 'path-map',
        build: build.id,
      });

      // The generated review directory is derived output, not authored project
      // state: remove it so the bundled `project/` stays exactly the Portable export.
      await rm(path.join(projectDir, RUNTIME_DIR, 'reviews'), { recursive: true, force: true });
      reviewed = {
        report,
        candidates: review.candidateComparisons.map(comparison => ({
          shot: comparison.shot,
          strip: comparison.strip ? `${REVIEW_DIR}/${bundleName(comparison.strip)}` : null,
          entries: comparison.entries,
        })),
        result: {
          build: review.build,
          contactSheet,
          seams,
          layers,
          candidates,
          report: reportRelative,
          paths: reviewPaths,
          contactSheetSha256: contactEntry.sha256,
          seamsSha256,
          layersSha256,
          candidatesSha256,
          reportSha256: reportEntry.sha256,
          pathsSha256: reviewPathsEntry.sha256,
        },
      };
    }

    // --- 5. Optional standalone live Playable package -----------------------
    let playable: DeliveryPlayable | null = null;
    if (options.playableSource !== undefined) {
      if (typeof options.playableSource !== 'string' || options.playableSource.trim() === '')
        throw new Error('delivery: playableSource must be a non-empty Source id');
      const playableDir = path.join(staging, PLAYABLE_DIR);
      const exportedPlayable = await exportPlayable(projectDir, options.playableSource, playableDir);
      const playableManifestPath = path.join(playableDir, PLAYABLE_MANIFEST);
      const playableManifest = PlayablePackageManifestSchema.parse(
        JSON.parse(await readFile(playableManifestPath, 'utf8')),
      );
      const playableAllowlist = new Set<string>([`${PLAYABLE_DIR}/${PLAYABLE_MANIFEST}`]);
      for (const file of playableManifest.files) {
        const provenance = {
          role: file.role,
          ...(file.asset ? { asset: file.asset } : {}),
          ...(file.rights ? { rights: file.rights } : {}),
        };
        const entry = await record(
          `${PLAYABLE_DIR}/${file.path}`,
          path.join(playableDir, ...file.path.split('/')),
          'playable',
          provenance,
        );
        if (entry.sha256 !== file.sha256) throw new Error(`delivery: playable manifest hash mismatch for ${file.path}`);
        playableAllowlist.add(`${PLAYABLE_DIR}/${file.path}`);
      }
      const playableManifestEntry = await record(
        `${PLAYABLE_DIR}/${PLAYABLE_MANIFEST}`,
        playableManifestPath,
        'playable',
      );
      if (playableManifestEntry.sha256 !== exportedPlayable.sha256)
        throw new Error('delivery: playable manifest hash does not match the export result');
      assertSameSet(
        (await walkFiles(playableDir)).map(file => `${PLAYABLE_DIR}/${file}`),
        playableAllowlist,
        'playable package',
      );
      playable = {
        id: playableManifest.id,
        path: PLAYABLE_DIR,
        entry: playableManifest.source.entry,
        files: playableManifest.files.length,
        sha256: playableManifestEntry.sha256,
        simulated: playableManifest.simulated,
      };
    }

    // --- 6. Static, escaped index.html --------------------------------------
    // A selected movie is described by its frozen snapshot; an image-only
    // delivery describes the current author project it was rendered from.
    const frozenProject =
      filmFacts !== null
        ? requireFilmProject(
            validateProject(
              JSON.parse(
                await readFile(
                  path.join(projectDir, RUNTIME_DIR, 'snapshots', `${filmFacts.build.id}.project.json`),
                  'utf8',
                ),
              ),
            ),
          )
        : currentProject;
    const filmComposition = filmFacts !== null ? requireComposition(frozenProject) : null;

    // Completeness gate (loud and honest): an Asset whose author asserted
    // `attributionRequired` must carry the notice that attribution condition
    // needs. This checks a declared flag, not the license itself; projects that
    // never set the flag are unaffected. Runs before anything is published.
    // For a film, check BOTH the frozen snapshot AND the editable project the
    // check already ran when the stills were frozen; an image-only project/
    // export checks the whole shipped project because all of it is bundled.
    if (filmFacts !== null) assertAttributionComplete([...frozenProject.assets, ...currentProject.assets]);
    else assertAttributionComplete(currentProject.assets);

    // --- 6b. Editable subtitle sidecar (deterministic SRT) ------------------
    // Subtitles are otherwise only burned into the picture. Emit the same frozen
    // captions as a CRLF SRT at the composition's rational output rate so the
    // bundle carries an editable, text-searchable caption source. Derived from
    // the frozen snapshot (never the current authored revision) so it cannot
    // drift from the delivered movie. No subtitles => no file and no entry.
    const frozenSubtitles = filmComposition?.subtitles ?? [];
    let subtitles: DeliverySubtitles | null = null;
    if (filmFacts !== null && frozenSubtitles.length > 0 && filmComposition !== null) {
      const srt = renderSubtitleSidecar(frozenSubtitles, filmComposition.output.fps);
      const srtPath = path.join(staging, ...SUBTITLE_FILE.split('/'));
      await writeFile(srtPath, srt, { mode: 0o600 });
      const entry = await record(SUBTITLE_FILE, srtPath, 'subtitle', {
        kind: 'subtitle-sidecar',
        build: filmFacts.build.id,
        captions: frozenSubtitles.length,
      });
      subtitles = { path: SUBTITLE_FILE, sha256: entry.sha256, bytes: entry.bytes, captions: frozenSubtitles.length };
    }

    // --- 6c. Self-contained audio products (programme audio + grouped stems) -
    // `audio/programme.wav` is the programme audio the delivered movie actually
    // muxes: `mux-final`'s audio input, i.e. the mastered mix when composition
    // mastering is enabled and the raw programme mix otherwise. Per grouped stem,
    // copy `audio/stems/<bus>.wav` (namespaced so a bus named `programme` cannot
    // collide with the programme mix). The Build records the authored bus label on
    // every `mix-stem` artifact (`artifact.bus`), so no label is inferred or paired
    // by position.
    // Audio products are film products: an image-only delivery never makes
    // programme audio or stems. `--stems` without a selected movie is already
    // refused above.
    let audio: DeliveryAudio = { programme: null, programmeSha256: null, programmeBytes: null, stems: [] };
    let programmeFrozenPath: string | null = null;
    if (filmFacts !== null) {
      const build = filmFacts.build;
      const composition = requireComposition(frozenProject);
      const includeAudio = stemsRequested;
      const finalOperation = build.operations.find(operation => operation.kind === 'mux-final');
      const programmeArtifact = finalOperation
        ? build.artifacts.find(candidate => candidate.kind === 'audio' && finalOperation.inputs.includes(candidate.id))
        : undefined;
      const stemOperations = build.operations.filter(operation => operation.kind === 'mix-stem');
      const hasAudio =
        composition.audio.length > 0 || composition.placements.some(placement => placement.audio === 'keep');
      // A grouped stem is a dead-end output the Portable export deliberately does
      // NOT carry (carrying every stem would multiply the bundle audio), so a
      // restored project has no stem bytes on disk. The programme audio is frozen
      // lineage and normally rides along in the export. Read each artifact from the
      // export when present, else from the project's content-addressed store, and
      // always verify it against the frozen Build record's recorded sha256. A stem
      // whose bytes are gone is a loud failure: the user must run a Build first.
      const resolveArtifact = async (artifact: Artifact, missingMessage: string): Promise<string> => {
        const exported = await resolveProjectPath(projectDir, artifact.path);
        if (await pathExists(exported)) return exported;
        const live = await resolveProjectPath(rootReal, artifact.path);
        if (await pathExists(live)) return live;
        throw new Error(missingMessage);
      };
      if (hasAudio && includeAudio) {
        if (!programmeArtifact || programmeArtifact.kind !== 'audio')
          throw new Error(
            `delivery: Build ${build.id} declares audio but has no muxed programme audio artifact to bundle`,
          );
        const programmeEntry = await copyIn(
          await resolveArtifact(
            programmeArtifact,
            `delivery: the programme mix artifact ${programmeArtifact.id} for Build ${build.id} is missing from both the exported project and the artifact store; run a Build before delivering`,
          ),
          AUDIO_PROGRAMME,
          'audio',
          programmeArtifact.sha256,
          { kind: 'audio-programme', build: build.id },
        );
        programmeFrozenPath =
          [...planned.entries()].find(
            ([relative, entry]) => relative.startsWith(`${PROJECT_DIR}/`) && entry.sha256 === programmeArtifact.sha256,
          )?.[0] ?? null;
        const stems: DeliveryAudioStem[] = [];
        for (const operation of stemOperations) {
          const stemArtifact = build.artifacts.find(candidate => candidate.id === operation.artifact);
          if (!stemArtifact || stemArtifact.kind !== 'audio')
            throw new Error(`delivery: grouped stem artifact ${operation.artifact} is not an audio artifact`);
          const bus = stemArtifact.bus;
          if (bus === undefined) throw new Error(`delivery: grouped stem artifact ${stemArtifact.id} has no bus label`);
          if (!BUS_LABEL.test(bus) || bus.includes('/') || bus === '.' || bus === '..')
            throw new Error(`delivery: refusing to bundle an unsafe bus label: ${JSON.stringify(bus)}`);
          // Namespace grouped stems under `audio/stems/` so a bus labelled
          // `programme` cannot collide with the programme mix at
          // `audio/programme.wav` (which `record` rejects as a duplicate bundle
          // path). The bus identity is still recorded verbatim on the artifact.
          const stemRelative = `${AUDIO_DIR}/stems/${bus}.wav`;
          const stemEntry = await copyIn(
            await resolveArtifact(
              stemArtifact,
              `delivery: Build ${build.id} recorded the grouped stem artifact ${stemArtifact.id} (bus ${bus}) but its bytes are missing from the project; run a Build to regenerate the stems, then deliver again`,
            ),
            stemRelative,
            'audio',
            stemArtifact.sha256,
            { kind: 'audio-stem', build: build.id, bus },
          );
          stems.push({
            bus,
            path: stemRelative,
            sha256: stemEntry.sha256,
            bytes: stemEntry.bytes,
            simulated: stemArtifact.simulated,
          });
        }
        stems.sort((a, b) => (a.bus < b.bus ? -1 : a.bus > b.bus ? 1 : 0));
        audio = {
          programme: AUDIO_PROGRAMME,
          programmeSha256: programmeEntry.sha256,
          programmeBytes: programmeEntry.bytes,
          stems,
        };
      }
    }

    const filmSimulated =
      filmFacts !== null &&
      (filmFacts.result.simulated ||
        filmFacts.build.takes.some(take => take.simulated) ||
        filmFacts.build.artifacts.some(item => item.simulated) ||
        frozenProject.sources.some(source => source.kind === 'simulated') ||
        frozenProject.assets.some(asset => asset.simulated));
    const simulated =
      portable.simulated ||
      filmSimulated ||
      images.some(image => image.simulated) ||
      sounds.some(sound => sound.simulated) ||
      imageUsageSimulated ||
      (playable?.simulated ?? false);
    const indexHtml = renderIndex({
      currentProject,
      frozenProject,
      film:
        filmFacts !== null
          ? {
              build: filmFacts.build,
              result: filmFacts.result,
              artifact: filmFacts.artifact,
              moviePath: MOVIE_FILE,
              movieSha256: filmFacts.movie.sha256,
              movieBytes: filmFacts.movie.bytes,
            }
          : null,
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
        stems: audio.stems.map(stem => ({ bus: stem.bus, path: stem.path, sha256: stem.sha256, bytes: stem.bytes })),
      },
      portableSimulated: portable.simulated,
      simulated,

      review: reviewed
        ? {
            report: reviewed.report,
            contactSheet: reviewed.result.contactSheet,
            seams: reviewed.result.seams,
            layers: reviewed.result.layers,
            candidates: reviewed.candidates,
            reviewReport: reviewed.result.report,
            reviewPaths: reviewed.result.paths,
          }
        : null,
      playable,
      nonRedistributableAssets,
    });
    const indexPath = path.join(staging, INDEX_FILE);
    await writeFile(indexPath, indexHtml, { mode: 0o600 });
    await record(INDEX_FILE, indexPath, 'index');

    // --- 7. Verify the staged tree is exactly the allowlist -----------------
    assertSameSet(await walkFiles(staging), new Set(planned.keys()), 'delivery bundle');
    let logicalBytes = 0;
    // Editable author bytes (the current project.json, current Sources/Assets,
    // declared handoff files and generated pages) must NEVER share an inode with
    // each other or with a frozen/derived product: a receiver edits them in
    // place, and a hardlink to a frozen copy would both make them read-only and
    // let an in-place edit silently mutate frozen history. Frozen/derived
    // products (movie, audio, review, playable, subtitle, index, and the frozen
    // lineage under project/.viscraft/) may still dedup among themselves.
    const editable = (relative: string, entry: Planned): boolean =>
      entry.role === 'project' && !relative.startsWith(`${PROJECT_DIR}/${RUNTIME_DIR}/`);
    for (const [relative, entry] of planned) {
      const target = path.join(staging, ...relative.split('/'));
      const actual = await hashFile(target);
      if (actual !== entry.sha256) throw new Error(`delivery: staged file failed verification: ${relative}`);
      logicalBytes += entry.bytes;
    }
    // In-bundle dedup, restricted to NON-editable products: identical frozen
    // bytes are hard-linked to ONE staged copy (never to an editable Project
    // file); the shared copy is read-only so editing one frozen path in place
    // cannot silently change another. A refused link keeps the copy.
    await dedupeFrozenBySha(staging, planned, editable);
    // Physical accounting for the reported `bytes`: the summed size of each
    // distinct `(dev, inode)`. A legitimately deduplicated frozen copy counts
    // once, but two independent author copies are each counted even when their
    // bytes are identical. `logicalBytes` counts every listed path. Both EXCLUDE
    // the manifest itself. This is a reported fact, not a limit: a real project
    // may legitimately be larger than any fixed bundle ceiling.
    const inodes = new Map<string, number>();
    for (const relative of planned.keys()) {
      const info = await stat(path.join(staging, ...relative.split('/')), { bigint: true });
      inodes.set(`${info.dev}:${info.ino}`, Number(info.size));
    }
    const totalBytes = [...inodes.values()].reduce((sum, size) => sum + size, 0);

    // --- 8. Manifest + atomic publish ---------------------------------------
    const files: DeliveryFile[] = [...planned.entries()]
      .map(([relative, entry]) => ({
        path: relative,
        sha256: entry.sha256,
        bytes: entry.bytes,
        role: entry.role,
        ...(entry.provenance !== undefined ? { provenance: entry.provenance } : {}),
      }))
      .sort((a, b) => a.path.localeCompare(b.path));

    const deliveredProducts = [
      filmFacts !== null ? 'the delivered movie (movie/final.mp4)' : '',
      images.length > 0 ? `${images.length} still image(s) (image/)` : '',
    ].filter(part => part !== '');
    const notes: string[] = [
      `Handoff: a static index.html facts page${deliveredProducts.length > 0 ? ` and ${deliveredProducts.join(' plus ')}` : ''}${audio.programme !== null ? ', the programme audio and grouped stems (audio/)' : ''}, the editable project export (project/, start with project/.viscraft/pages/VISCRAFT.md)${reviewed !== null ? ', a regenerated hash-verified review (review/)' : ''}${options.playableSource !== undefined ? ' and a standalone live package (playable/)' : ''}.`,
      'Editable author bytes (project/project.json, current Sources/Assets, handoff files and generated pages) are always independent copies; frozen/derived products (movie, image, audio, review, playable, subtitle, index and the frozen lineage under project/.viscraft/) may hard-link identical bytes to one read-only copy inside the bundle. `bytes` is the sum of distinct files (per dev:ino), `logicalBytes` counts every listed path; both exclude the manifest.',
    ];
    if (filmFacts !== null)
      notes.push(
        'movie/final.mp4 is a byte copy of the ACTIVE .viscraft/result.json artifact — not the newest or a failed Build — and its hash is checked against the recorded result sha256.',
      );
    if (images.length > 0)
      notes.push(
        'image/<target>.<ext> is a byte copy of the result Artifact of a succeeded, non-preview render-image Build whose operation key equals the current imageRenderKey of that target (document bytes + declared resources + output settings). No image was re-rendered and no model task was submitted; a stale, missing or unrendered target is refused rather than silently skipped.',
        'imageMaterials records, per delivered target and producing Build, the Assets frozen in that Build snapshot whose path matches the still document or one of its declared resources, with their simulated flag and full historical rights facts (license, notice, attribution condition). A later current declaration never overwrites those historical facts; a newly declared restriction appears in nonRedistributableAssets.',
      );
    notes.push(
      'project/ is the allowlisted Portable project export (authored project + frozen lineage for the active result and selected Takes, declared handoff files, VISCRAFT.md and ATTRIBUTION.md). Runtime scratch, provider job/remote state, locks, damaged bytes, review outputs, node_modules/model weights and unknown files are excluded.',
    );
    if (reviewed !== null)
      notes.push(
        'review/ was regenerated from the exported frozen snapshot with reviewBuild and copied from only the returned contact sheet, seam strips and report plus the layer strips the report names; no review directory was copied recursively.',
        "review/paths.json maps each original project-relative review path to its bundled location: the verbatim report keeps the exported project's .viscraft/reviews paths, which are intentionally removed from project/.",
      );
    if (simulated)
      notes.push(
        'This bundle carries simulated/test-only provenance. Simulated provider request/job state is intentionally absent: included accepted Artifacts can be reused through the recorded Take selections, but a new simulated attempt requires fresh job state and must not be represented as a real generative model.',
      );
    if (nonRedistributableAssets.length > 0)
      notes.push(
        `This bundle contains ${nonRedistributableAssets.length} non-redistributable Asset(s) (${nonRedistributableAssets.map(asset => asset.asset).join(', ')}) whose bytes were packaged under the author's explicit allowNonRedistributable opt-in. It is a private copy for the author's own use and is NOT cleared for redistribution; redistribution rights for these Assets could not be established. The top-level containsNonRedistributableAssets marker and nonRedistributableAssets list identify them, and index.html states the same.`,
      );
    if (playable)
      notes.push(
        'playable/ is a standalone live configuration (one code Source, resolved bindings/World, used assets) served by the runtime; it is not a second editable project.',
      );
    if (subtitles)
      notes.push(
        "movie/final.srt is the editable caption sidecar for the frozen snapshot's Composition subtitles: sequential 1-based cues, CRLF line endings, SRT timecodes from the same half-open [startFrame, endFrame) intervals at the composition output rate. Caption text is verbatim.",
      );
    if ((reviewed?.result.candidates.length ?? 0) > 0)
      notes.push(
        "review/candidate-<shot>.png are per-shot candidate-Take comparison strips regenerated by reviewBuild from the frozen Build's declared candidates (one row of first/middle/last frame per candidate Take); each is copied verbatim and hash-verified, and the index marks which candidate the frozen composition selected.",
      );
    if (audio.programme !== null)
      notes.push(
        `audio/programme.wav is the audio the delivered movie actually contains (the full mix of every audio member, mastered when composition mastering is enabled, otherwise the raw programme mix).${programmeFrozenPath ? ` It is byte-identical to the frozen audio artifact in the bundled project export at ${programmeFrozenPath} and shares that copy inside the bundle.` : ''}${audio.stems.length === 0 ? ' The frozen snapshot declares no bus, so no grouped stem is bundled.' : ` audio/stems/<bus>.wav are ADDITIONAL grouped stems for the declared buses (${audio.stems.map(stem => stem.bus).join(', ')}); a stem is a grouped export that overlaps the programme mix, not a partition, so the stems sum to the programme only when every member is routed to exactly one bus.`}`,
      );

    // Report-only scan of the handoff text that enters the bundle. It never
    // blocks the delivery; the findings travel in the manifest and the
    // command output so the author can fix the receiver-facing copy.
    const diagnostics = await scanBundleDiagnostics(staging, planned, rootReal);

    const manifestBody = {
      format: FORMAT,
      version: VERSION,
      exportedAt: new Date().toISOString(),
      project: {
        id: currentProject.id,
        revision: currentProject.revision,
        title: currentProject.title,
        schemaVersion: currentProject.schemaVersion,
      },
      build:
        filmFacts !== null
          ? {
              id: filmFacts.build.id,
              revision: filmFacts.build.revision,
              status: filmFacts.build.status,
              simulated: Boolean(filmFacts.build.result?.simulated),
              stale: filmFacts.build.stale ?? false,
              snapshotHash: filmFacts.build.snapshotHash,
              startedAt: filmFacts.build.startedAt,
              finishedAt: filmFacts.build.finishedAt ?? null,
            }
          : null,
      simulated,

      /** The products this bundle actually carries. */
      selection: {
        movie: filmFacts !== null,
        images: images.map(image => image.target),
        sounds: sounds.map(sound => sound.target),
      },
      // Additive marker: present ONLY when the bundle actually carries private
      // Asset bytes, so an all-redistributable delivery (even under the opt-in)
      // is byte-identical to the strict path and the flag never pollutes it.
      ...(nonRedistributableAssets.length > 0
        ? { containsNonRedistributableAssets: true, nonRedistributableAssets }
        : {}),
      movie:
        filmFacts !== null
          ? {
              path: MOVIE_FILE,
              sha256: filmFacts.movie.sha256,
              bytes: filmFacts.movie.bytes,
              artifact: filmFacts.artifact.id,
              operation: filmFacts.artifact.operation,
              simulated: filmFacts.artifact.simulated,
            }
          : null,
      images,
      sounds,
      ...(images.length > 0 ? { imageMaterials } : {}),
      subtitles,
      audio,
      review: reviewed?.result ?? null,
      playable,
      index: INDEX_FILE,
      projectExport: {
        path: PROJECT_DIR,
        files: portable.files.length,
        simulated: portable.simulated,
        builds: portable.builds,
        artifacts: portable.artifacts,
        scope: portable.scope,
      },
      bytes: totalBytes,
      logicalBytes,
      files,
      diagnostics,
      notes,
      limitations: [
        'index.html is a static, JavaScript-free facts page derived from the frozen Build snapshot and hash-verified files; it makes no subjective, aesthetic, audio-listening or full-movie-review claim.',
        ...(reviewed !== null
          ? [
              'Review products are extracted stills plus a numerical technical report; sampling three frames per placement and four per cut does not measure continuity, motion, acting or aesthetic quality.',
            ]
          : []),
        ...(images.length > 0
          ? [
              'Delivered still images are the rasterized output of the author document at the declared target; the index reports their real pixels, format and hash but judges neither their design nor their aesthetics.',
            ]
          : []),
        'Bundle facts describe the frozen Build snapshot (film) or the current authored project (still images); the current authored project revision may differ and is reported separately.',
      ],
    };

    const manifestPath = path.join(staging, DELIVERY_MANIFEST);
    await writeFile(manifestPath, `${JSON.stringify(manifestBody, null, 2)}\n`, { mode: 0o600 });
    const manifestSha256 = await hashFile(manifestPath);

    // The delivery record for a destination that lands directly in output/. Its
    // recovery marker is written immediately BEFORE the publish (after the
    // replace-protection re-check) so a crash between the publish and the durable
    // record leaves a resolvable entry the next delivery accepts as its own.
    const deliveryRecord: DeliveryRecord | null = recordName
      ? {
          name: recordName,

          kind: 'deliver',
          ...(filmFacts !== null ? { build: filmFacts.build.id } : {}),
          revision: currentProject.revision,
          deliveredAt: new Date().toISOString(),
          manifestSha256,
        }
      : null;

    // Publish under the Project's delivery lock: an in-place still update may be
    // staging from this same entry, and only one of the two may win. The recorded
    // hash is the compare-and-swap value — self-consistency checks cannot tell
    // the bundle we staged from apart from a newer one.
    const releaseDelivery = await acquireDeliveryLock(rootReal);
    try {
      if (replaceDefault) {
        const observed = (await readDeliveryRecord(rootReal, dirName))?.manifestSha256 ?? null;
        if (observed !== observedRecordManifestSha)
          throw new Error(
            `delivery: ${OUTPUT_DIR}/${dirName} was replaced by another delivery while this one was being staged; nothing was overwritten — retry when it is finished`,
          );
      }
      if (await pathExists(destReal)) {
        if (!replaceDefault) throw new Error(`delivery: destination appeared during delivery: ${destReal}`);
        // Re-check the observed state immediately before the swap: an external
        // editor may have changed or replaced the old bundle while this delivery
        // was staged. The FULL check (recorded-hash comparison + member
        // verification) — a self-consistent replacement is caught only by the
        // recorded hash, so self-consistency verification alone is not enough.
        await assertReplaceable();
        if (deliveryRecord) await markDeliveryPending(rootReal, deliveryRecord);
        await replaceStagedDirectory(staging, destReal);
      } else {
        if (deliveryRecord) await markDeliveryPending(rootReal, deliveryRecord);
        await rename(staging, destReal);
      }
      // The durable record is part of the SAME publication boundary as the swap:
      // releasing the lock in between would let an update recover this pending
      // marker and publish, only to have this writer's record overwrite its
      // manifest identity. Keep the record write + clear inside the lock.
      if (deliveryRecord) {
        await writeDeliveryRecord(rootReal, deliveryRecord);
        await clearDeliveryPending(rootReal, deliveryRecord.name);
      }
    } finally {
      await releaseDelivery();
    }

    return {
      path: destReal,
      manifest: DELIVERY_MANIFEST,
      manifestSha256,

      project: {
        path: PROJECT_DIR,
        files: portable.files.length,
        simulated: portable.simulated,
        warnings: exportWarnings,
        scope: portable.scope,
      },
      build: filmFacts?.build.id ?? null,
      revision: currentProject.revision,
      simulated,
      movie:
        filmFacts !== null
          ? {
              path: MOVIE_FILE,
              sha256: filmFacts.movie.sha256,
              artifact: filmFacts.artifact.id,
              bytes: filmFacts.movie.bytes,
            }
          : null,
      images,
      sounds,
      imageMaterials,
      subtitles,
      audio,
      review: reviewed?.result ?? null,
      playable,
      index: INDEX_FILE,
      diagnostics,
      containsNonRedistributableAssets: nonRedistributableAssets.length > 0,
      nonRedistributableAssets,
      files: planned.size,
      bytes: totalBytes,
      logicalBytes,
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  } finally {
  }
}
