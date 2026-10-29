import { randomUUID } from 'node:crypto';
import { chmod, copyFile, link, mkdir, rename, rm, stat } from 'node:fs/promises';
import { artifactAvailable } from '../project/closure.js';
import { assertAudioDerivationMatchesMedia } from '../project/derivation.js';
import { contentPath, freezeFile } from '../project/content-store.js';
import { assertNoIncompleteRevert } from '../project/revert-journal.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BuildRecordSchema,
  CandidatePlanSchema,
  type Artifact,
  type BuildDiagnostic,
  type BuildRecord,
  type FilmProject,
  type MediaFraming,
  type OutputSettings,
  type Placement,
  type Project,
  type SoundTarget,
  type Source,
  type Take,
} from '../core/schema.js';
import { atomicJson, resolveProjectPath } from '../shared/fs.js';
import { hashFile, stableHash } from '../shared/hash.js';
import { snapshotHashOf } from '../project/state.js';
import { redact } from '../shared/process.js';
import { acquireLock, loadProject } from '../project/project.js';
import { readBuilds } from '../project/build-records.js';
import {
  analyzeTimeline,
  audioAssetClipIssues,
  buildabilityGaps,
  candidatePlanIssues,
  compositionStateIssues,
  consumedSourceIds,
  earlyPlacementIssues,
  pictureLayerIssues,
  placementAssetIssues,
  placementTakeIssues,
  reusableHistory,
  subtitleFontPreflight,
} from './plan.js';
import {
  assetPictureIdentity,
  backendEntries,
  implementationManifest,
  operationEnvironmentProbe,
  operationImplementation,
  occluderInputAssets,
  runtimeRoot,
  sourceOperationIdentity,
  soundContextForSource,
  type KeyTools,
  type VideoOperationScope,
} from './identity.js';
import { authoredFileFacts } from '../project/author-inputs.js';
export { operationImplementation };
import type { CaptureDiagnostic } from '../backends/browser/capture.js';
import type { BlenderOptions } from '../backends/blender/render.js';
import {
  composeVideo,
  extractStill,
  gradeMedia,
  normalizeMedia,
  renderGap,
  renderStill,
  trimPreview,
  type ComposeClip,
} from '../backends/media/picture.js';
import { masterAudio, masterAudioSamples } from '../backends/media/audio-master.js';
import { mixAudio, mixAudioSamples } from '../backends/media/audio-mix.js';
import { muxVideo } from '../backends/media/mux.js';
import { probeMedia } from '../backends/media/probe.js';
import { proxyOutput, resolvePreview, type PreviewRequest } from './preview.js';
import { withUserEndpoints } from '../config/endpoints.js';
import type { VideoApiOptions } from '../backends/providers/services/video-tasks.js';
import type { ImageApiOptions } from '../backends/providers/services/vllm-omni/image-api.js';
import { renderSubtitles } from '../backends/media/subtitles.js';
import { overlayPictureLayers, type PictureLayerClip } from '../backends/media/layers.js';
import { encodeRetimedAudioBody, retimeClip } from '../backends/media/retime.js';
import { compositionFrames } from '../core/composition.js';
import { framesToSamples } from '../core/time.js';
import {
  sourceExecutor,
  type ExecutorIssue,
  type ExecutorPreflightOut,
  type SourceContext,
} from './executors/index.js';

export interface BuildOptions {
  goal?: string;
  /** An `imageTargets`/`soundTargets` id. A sound target produces a WAV programme;
   * absent means the timeline composition. Image targets are produced by their
   * own still path and are refused here. */
  target?: string;
  providers?: { videoApi?: Record<string, VideoApiOptions>; imageApi?: Record<string, ImageApiOptions> };
  /** Explicit Blender configuration for `blender` Sources (executable, timeout). */
  blender?: BlenderOptions;
  candidates?: Array<{ shot: string; sources: string[] }>;
  /** Internal: run as a preview Build (use `previewProject`). */
  preview?: PreviewRequest;
}
export interface PreviewOptions extends Omit<BuildOptions, 'preview' | 'candidates'> {
  /** Output-frame range `[start, end)`. */
  frames?: [number, number];
  /** Proxy scale 0.25–1 (default 1). */
  scale?: number;
  /** Single frame N: the range N:N+1 plus a PNG under `.viscraft/previews/<build-id>/`. */
  still?: number;
}

/** What this Build produces, resolved from the Project and `--target`. */
export type BuildSelection = { medium: 'picture' } | { medium: 'sound'; target: SoundTarget };

/**
 * Resolve the Build's target. An explicit id must be a SOUND target: an image
 * target is produced by the still path, and naming one here is an author mistake
 * rather than something to guess about. Without an id the film composition is the
 * only thing a timeline Build can produce.
 */
export function resolveBuildSelection(project: Project, requested?: string): BuildSelection {
  if (requested !== undefined) {
    const target = project.soundTargets.find(candidate => candidate.id === requested);
    if (target) return { medium: 'sound', target };
    if (project.imageTargets.some(candidate => candidate.id === requested))
      throw new Error(
        `build: "${requested}" is an image target; produce it with the still-image path, not a timeline Build`,
      );
    throw new Error(`build: unknown target "${requested}"`);
  }
  if (project.composition) return { medium: 'picture' };
  throw new Error('build: this Project declares no timeline composition; name a sound target with --target');
}

/**
 * The picture facts a picture Source needs. A sound target has no picture output,
 * so it carries a small internal raster/rate only to satisfy the browser page
 * host; no author-visible sound key, Store record or Take reads it.
 */
function soundInternalOutput(project: Project, selection: BuildSelection): OutputSettings {
  if (selection.medium === 'sound')
    return {
      width: 960,
      height: 540,
      fps: { numerator: 24, denominator: 1 },
      sampleRate: selection.target.sampleRate,
      channels: selection.target.channels,
    };
  return project.composition!.output;
}

/**
 * A picture Take, refused explicitly when a sound Take reaches a picture path.
 * Narrowing here keeps `frames`/`fps` from being read off a sample-clock Take.
 */
function pictureTake(take: Take): Extract<Take, { medium: 'picture' }> {
  if (take.medium !== 'picture') throw new Error(`Take ${take.id} is a sound Take where a picture Take is required`);
  return take;
}

/** The Sources a sound target's clips actually execute. */
function soundTargetSourceIds(target: SoundTarget): Set<string> {
  return new Set(target.audio.flatMap(clip => (clip.kind === 'source' ? [clip.source] : [])));
}

/**
 * Preview a range of the programme without touching authored state or the
 * active result. The record is a normal Build record with `preview` set; it
 * never writes `result.json`. Paid generation follows the same Plan/approval
 * rules as a Build.
 */
export async function previewProject(root: string, options: PreviewOptions): Promise<BuildRecord> {
  const { frames, scale, still, ...build } = options;
  if (still !== undefined && frames !== undefined)
    throw new Error('Give either a frame range or a still frame, not both');
  const range: [number, number] | undefined = still !== undefined ? [still, still + 1] : frames;
  if (!range) throw new Error('A preview needs a frame range or a still frame');
  return buildProject(root, { ...build, preview: { frames: range, scale, still: still !== undefined } });
}

export async function buildProject(root: string, options: BuildOptions = {}): Promise<BuildRecord> {
  options = withUserEndpoints(options);
  const release = await acquireLock(root, 'build');
  try {
    await assertNoIncompleteRevert(root);
  } catch (error) {
    await release();
    throw error;
  }
  const id = `build-${randomUUID()}`;
  const record: BuildRecord = {
    schemaVersion: 1,
    id,
    run: { id: `run-${randomUUID()}`, goal: redact(options.goal ?? 'Build composition') },
    plan: { operations: [] },
    revision: 1,
    snapshotHash: '',
    status: 'running',
    startedAt: new Date().toISOString(),
    operations: [],
    artifacts: [],
    takes: [],
    medium: 'picture',
  };
  let recordPath: string | undefined;
  let scratch: string | undefined;
  const persist = async () => {
    if (recordPath) await atomicJson(recordPath, BuildRecordSchema.parse(record));
  };
  try {
    recordPath = await resolveProjectPath(root, `.viscraft/builds/${id}.json`);
    const scratchPath = await resolveProjectPath(root, `.viscraft/scratch/${id}`);
    scratch = scratchPath;
    const snapshot = await resolveProjectPath(root, `.viscraft/snapshots/${id}`);
    const project = await loadProject(root);
    const selection = resolveBuildSelection(project, options.target);
    record.medium = selection.medium;
    if (selection.medium === 'sound') record.target = selection.target.id;
    if (selection.medium === 'sound' && options.preview)
      throw new Error('A preview renders a film interval; a sound target has no picture interval to preview');
    record.revision = project.revision;
    record.run.goal = redact(
      options.goal ??
        (selection.medium === 'sound' ? `Build sound target ${selection.target.id}` : 'Build composition'),
    );
    const pictureOutput = soundInternalOutput(project, selection);
    // Only the picture branch reads `composition`; `requireFilmProject` has already
    // been satisfied by `resolveBuildSelection` (no composition => no picture Build).
    const film = project as FilmProject;
    let preview: ReturnType<typeof resolvePreview> | undefined;
    let subtitleFont: Awaited<ReturnType<typeof subtitleFontPreflight>>;
    const history = await readBuilds(root);
    if (selection.medium === 'picture') {
      preview = options.preview ? resolvePreview(film, options.preview) : undefined;
      if (preview) {
        if (options.candidates !== undefined) throw new Error('A preview does not take a candidate plan');
        record.run.goal = redact(options.goal ?? `Preview frames ${preview.frames[0]}:${preview.frames[1]}`);
        record.preview = { frames: preview.frames, scale: preview.scale, substituted: [...preview.substituted] };
      }
      // Fail fast on everything already knowable from the film alone, BEFORE any
      // capture, render or provider work: an unedited draft has no target picture,
      // the edit timeline must satisfy the same structural rules `composeVideo`
      // enforces, and a deterministic Source placement must not read past the frames
      // it will yield or keep audio it cannot carry. This is the same set of checks
      // the production preflight reports; the Build refuses here rather than after
      // expensive/side-effecting work.
      const buildability = buildabilityGaps(film);
      if (buildability.length > 0) throw new Error(`Build cannot produce a target: ${buildability.join('; ')}`);
      const timelineIssues = analyzeTimeline(film.composition.placements, film.composition.transitions).blockers;
      if (timelineIssues.length > 0) {
        const [first, ...rest] = timelineIssues;
        throw new Error(
          `Build cannot compose the edit: ${first.message}${rest.length > 0 ? ` (+${rest.length} more structural issues; run the production preflight for the full list)` : ''}`,
        );
      }
      const stateIssues = compositionStateIssues(film, {
        substituted: preview?.substituted,
        preview: preview !== undefined,
      });
      if (stateIssues.length > 0) throw new Error(stateIssues[0].message);
      const earlyPlacement = earlyPlacementIssues(film, preview?.substituted);
      if (earlyPlacement.length > 0) throw new Error(earlyPlacement[0].message);
      // A placement that reads a VIDEO Asset directly has a real length only a
      // metadata probe reveals — the SAME shared check the production preflight
      // runs (`placementAssetIssues`). A real overrun is refused here, before any
      // capture/compose/provider POST; a FAILED probe is an UNKNOWN length
      // (`pending`) and must NOT block — the reusable normalized artifact below may
      // still satisfy the placement, and the late `outFrame > take.frames` guard
      // stays as defence in depth. `keepAudioDiagnostic` is ON here too: a `keep`
      // over a silent video Asset is a KNOWABLE mistake that must be refused before
      // any capture/POST, with the SAME message the Plan gives (one authored
      // mistake, one message), rather than only after the picture has been
      // produced. For a `keep` placement there is nothing to reuse from the silent
      // Asset, so this early refusal never pre-empts a legal reuse.
      const placementAsset = await placementAssetIssues(film, {
        substituted: preview?.substituted,
        root,
        keepAudioDiagnostic: true,
      });
      const placementBlockers = placementAsset.filter(issue => issue.level === 'blocked');
      if (placementBlockers.length > 0) throw new Error(placementBlockers[0].message);
      // An `asset` audio clip's interval against its Asset's real length — the SAME
      // shared check the Plan runs (`audioAssetClipIssues`), consumed here BEFORE
      // any capture/compose, so a clip that reads past its Asset is refused rather
      // than only inside `mixAudio` after the picture has already been produced.
      const audioClipBlockers = (await audioAssetClipIssues(film, { root })).filter(issue => issue.level === 'blocked');
      if (audioClipBlockers.length > 0) throw new Error(audioClipBlockers[0].message);
      if (options.candidates !== undefined) {
        // The same shared validation the preflight runs, so plan and Build agree
        // on which candidate plans are legal (no Plan-pass/Build-reject gap).
        const candidateIssues = candidatePlanIssues(film, options.candidates);
        if (candidateIssues.length > 0) throw new Error(candidateIssues[0].message);
        record.plan.candidates = CandidatePlanSchema.parse(options.candidates);
      }
      // Picture-layer dependencies knowable BEFORE any capture or provider
      // submission, through the SAME shared check the production preflight runs,
      // over exactly the layers this Build consumes (a preview's dropped layers are
      // skipped): a layer the Build would reject must not first spend a browser
      // capture or a provider POST. The `take` reference resolves against the same
      // reusable Build history the layer resolution below uses — including the
      // selected Take's Artifact bytes/archive state — and a video Asset's real
      // normalized length is read here by METADATA PROBE (never a decode). Facts
      // only knowable after a run (a provider's real decoded length) keep their
      // final guard there.
      const layerTakes = new Map<string, Take>();
      const knownArtifacts = new Map<string, Artifact>();
      for (const build of reusableHistory(history)) {
        for (const take of build.takes) if (!layerTakes.has(take.id)) layerTakes.set(take.id, take);
        for (const artifact of build.artifacts)
          if (!knownArtifacts.has(artifact.id)) knownArtifacts.set(artifact.id, artifact);
      }
      // Ordinary `take:` PLACEMENT dependencies, through the SAME shared check the
      // production preflight runs: a missing Take, an out-of-range interval, an
      // unusable/archived Artifact, a non-picture Take, or a `keep` over a silent
      // Take is refused HERE, before the first capture/POST — so an ordinary later
      // Take cannot let an EARLIER Provider Source be submitted first. The `take`
      // reference resolves against the same reusable history the placement
      // resolution below uses; a `keep` Take's file is read by METADATA PROBE.
      const takeBlockers = (
        await placementTakeIssues(film, {
          takes: layerTakes,
          artifacts: knownArtifacts,
          substituted: preview?.substituted,
          root,
        })
      ).filter(issue => issue.level === 'blocked');
      if (takeBlockers.length > 0) throw new Error(takeBlockers[0].message);
      const layerIssues = await pictureLayerIssues(film, {
        takes: layerTakes,
        artifacts: knownArtifacts,
        droppedLayers: preview?.droppedLayers,
        root,
      });
      // Only a `blocked` layer issue stops the Build; a FAILED video-Asset probe is
      // an UNKNOWN length (`pending`) — the reusable normalized artifact may still
      // satisfy the layer, and the late `layer.outFrame > take.frames` guard below
      // remains as defence in depth.
      const layerBlockers = layerIssues.filter(issue => issue.level === 'blocked');
      if (layerBlockers.length > 0) throw new Error(layerBlockers[0].message);
      // A composition that authors subtitles depends on a locally-available font.
      // Resolve it HERE — before freezing, capture, compose or any provider work —
      // through the SAME shared check the preflight runs, and reuse the resolved
      // font below, so a host without the font fails fast instead of only after the
      // most expensive picture render. No subtitles means no font requirement.
      subtitleFont = await subtitleFontPreflight(film);
      if (subtitleFont.issues.length > 0) throw new Error(subtitleFont.issues[0].message);
      // Exactly the Sources this run consumes/executes (shared with the
      // preflight), so an unused Source is neither produced nor probed for a tool.
    }
    const consumedIds =
      selection.medium === 'sound'
        ? soundTargetSourceIds(selection.target)
        : consumedSourceIds(film, {
            substituted: preview?.substituted,
            droppedLayers: preview?.droppedLayers,
            candidates: record.plan.candidates,
          });
    for (const asset of project.assets) {
      const parent = asset.derivedFrom;
      if (!parent) continue;
      const build = history.find(build => build.id === parent.build && build.status === 'succeeded');
      const artifact = build?.artifacts.find(artifact => artifact.id === parent.artifact);
      const take = parent.take ? build?.takes.find(take => take.id === parent.take) : undefined;
      if (
        !artifact ||
        artifact.sha256 !== parent.sha256 ||
        artifact.kind !== 'video' ||
        !artifact.media ||
        (parent.take && (!take || take.artifact !== artifact.id))
      )
        throw new Error(`Asset ${asset.id} has invalid parent provenance`);
      // The two derivation kinds share the parent Artifact/Take/sha relation; only
      // `frame` bounds a picture frame, and only `audio` carries a stream interval.
      if (parent.kind === 'frame') {
        if (
          parent.frame >= artifact.media.frames ||
          (parent.take && take !== undefined && take.medium === 'picture' && parent.frame >= take.frames)
        )
          throw new Error(`Asset ${asset.id} has invalid parent frame provenance`);
      } else {
        if (
          parent.inPts < parent.startPts ||
          parent.outPts <= parent.inPts ||
          parent.timebase.numerator <= 0 ||
          parent.timebase.denominator <= 0
        )
          throw new Error(`Asset ${asset.id} has invalid parent audio provenance`);
        // The record must actually describe the parent's REAL audio stream. This
        // is the execution stage, where both the parent medium and the produced
        // file are available, so the recorded facts are re-derived instead of
        // trusted: an edited streamIndex/timebase/interval/output fact fails.
        await assertAudioDerivationMatchesMedia(
          await resolveProjectPath(root, artifact.path),
          await resolveProjectPath(root, asset.path),
          artifact,
          parent,
          asset.id,
        );
      }
      if (!asset.simulated && (artifact.simulated || take?.simulated))
        throw new Error(`Asset ${asset.id} cannot discard simulated parent provenance`);
    }
    await mkdir(snapshot, { recursive: true });
    await mkdir(scratchPath, { recursive: true });
    // The authoring inventory is the ONE enumeration of what this Project owns:
    // every Asset, Source file, image document/resource and handoff, with the
    // digest of the bytes that are actually readable and an explicit gap for every
    // declared fact that is not. A missing/unreadable/damaged UNCONSUMED file is
    // preserved as a gap and does not block the Sources that never read it; a
    // CONSUMED one is refused by the shared identity step below.
    const facts = await authoredFileFacts(project, root, {
      recover: async (_relative, declaredSha256) => {
        const entry = await resolveProjectPath(root, contentPath(declaredSha256));
        try {
          return (await hashFile(entry)) === declaredSha256 ? declaredSha256 : null;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        }
      },
    });
    const files = new Map<string, string>();
    const verifiedContent = new Set<string>();
    // Content-addressed freeze: bytes enter `.viscraft/content/<sha256>` once
    // and each snapshot path is a hard link to that read-only entry (or a
    // read-only copy when linking fails) — never a link to the editable original.
    const freezeStoredAsset = async (relative: string, sha256: string): Promise<string> => {
      const entry = await resolveProjectPath(root, contentPath(sha256));
      if ((await hashFile(entry)) !== sha256)
        throw new Error(`Asset ${relative} is missing and its bytes are not in the content store`);
      const destination = await resolveProjectPath(snapshot, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await rm(destination, { force: true });
      try {
        await link(entry, destination);
      } catch {
        await copyFile(entry, destination);
        await chmod(destination, 0o444);
      }
      if ((await hashFile(destination)) !== sha256) throw new Error(`Frozen bytes do not match for ${relative}`);
      return sha256;
    };
    for (const relative of Object.keys(facts.files).sort()) {
      let onDisk = true;
      try {
        await stat(await resolveProjectPath(root, relative));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        onDisk = false;
      }
      const digest = onDisk
        ? await freezeFile(root, snapshot, relative, verifiedContent)
        : await freezeStoredAsset(relative, facts.files[relative]);
      // The inventory and the freeze must agree: a file that changed between them
      // is a real concurrent edit, not a snapshot to silently record.
      if (digest !== facts.files[relative])
        throw new Error(`Authored file "${relative}" changed while the snapshot was being frozen`);
      files.set(relative, digest);
    }
    record.snapshotHash = snapshotHashOf(project, Object.fromEntries(files), facts.unavailable);
    const consumedOccluders = selection.medium === 'picture' ? occluderInputAssets(film, files) : [];
    // Only the Sources this run actually EXECUTES are consulted for a tool, so
    // an unused Blender/browser Source never probes (or requires) its tool. The
    // RECORDED environment is the union of the tools those consumed Sources need
    // (provenance); each OPERATION's key carries only the tools that operation
    // itself executes, so a Build that consumes a different tool-kind set than
    // its predecessor re-keys only the operations whose own tools changed.
    const probe = operationEnvironmentProbe(options);
    const consumedTools: KeyTools = { browser: false, blender: false };
    for (const source of project.sources)
      if (consumedIds.has(source.id)) {
        const tools = sourceExecutor(source).tools;
        if (tools.browser) consumedTools.browser = true;
        if (tools.blender) consumedTools.blender = true;
      }
    const keyEnvironment = await probe.environment(consumedTools);
    const implementationRoot = await runtimeRoot();
    const environment: Record<string, string> = {
      ...keyEnvironment,
      implementation: await implementationManifest(implementationRoot),
    };
    record.environment = environment;
    // The cache key includes the tool/runtime environment but NOT the
    // whole-runtime implementation hash: implementation identity is scoped per
    // operation (see `operationImplementation`), which binds the operation's
    // real backend closure and the scheduler bytes, so
    // unrelated modules (CLI, entry, analysis, delivery) do not participate
    // in production operation keys.
    const backendFallback = await backendEntries(implementationRoot);
    const implementationCache = new Map<string, string>();
    const implementationFor = async (operationKind: string, scope?: VideoOperationScope): Promise<string> => {
      const cacheKey = `${operationKind}\u0000${scope?.protocol ?? ''}\u0000${(scope?.implementationFiles ?? []).join('\u0001')}`;
      const cachedFingerprint = implementationCache.get(cacheKey);
      if (cachedFingerprint) return cachedFingerprint;
      const fingerprint = await operationImplementation(implementationRoot, operationKind, backendFallback, scope);
      implementationCache.set(cacheKey, fingerprint);
      return fingerprint;
    };
    await atomicJson(await resolveProjectPath(root, `.viscraft/snapshots/${id}.project.json`), project);
    await atomicJson(await resolveProjectPath(root, `.viscraft/snapshots/${id}.inputs.json`), {
      files: Object.fromEntries(files),
      unavailable: facts.unavailable,
    });
    await persist();
    const cached = new Map<string, Artifact>();
    // The SAME history predicate the preflight uses: a failed Build's completed,
    // hash-verified operations are reusable, so a retry after a later failure
    // does not re-submit or re-encode them.
    const reusable = reusableHistory(history);
    const historicalArtifacts = new Map(reusable.flatMap(b => b.artifacts.map(a => [a.id, a] as const)));
    for (const build of reusable)
      for (const operation of build.operations) {
        const artifact = historicalArtifacts.get(operation.artifact);
        if (artifact && !cached.has(operation.key)) cached.set(operation.key, artifact);
      }
    // Capture diagnostics are operation-scoped: when an operation is reused, its
    // earlier Build recorded them, so carry them forward into this Build's record
    // by joining each historical diagnostic to its operation key. This keeps a
    // reused capture reporting the same technical facts as the run that produced
    // it (nothing is re-captured, so nothing is re-observed).
    const historicalDiagnostics = new Map<string, BuildDiagnostic[]>();
    for (const build of reusable) {
      const keyById = new Map(build.operations.map(operation => [operation.id, operation.key] as const));
      for (const diagnostic of build.diagnostics ?? []) {
        const key = keyById.get(diagnostic.operation);
        if (!key) continue;
        const list = historicalDiagnostics.get(key) ?? [];
        list.push(diagnostic);
        historicalDiagnostics.set(key, list);
      }
    }
    // Diagnostics recorded by this Build, in operation order. Recorded only when
    // non-empty, so a clean Build's record stays free of an empty array.
    const buildDiagnostics: BuildDiagnostic[] = [];
    // Artifacts produced (not reused) by this Build. Their recorded media info
    // was probed from the exact bytes just written, so it is trustworthy without
    // a re-probe; a reused/historical artifact is re-probed before its audio fact
    // is trusted (see `takeHasAudio`).
    const producedThisBuild = new Set<string>();
    const execute = async (
      kind: string,
      inputs: string[],
      parameters: unknown,
      simulated: boolean,
      extension: 'mp4' | 'wav',
      work: (destination: string) => Promise<
        | void
        | (Pick<Artifact, 'generation' | 'imageGeneration' | 'mastering' | 'bus'> & {
            diagnostics?: CaptureDiagnostic[];
          })
      >,
      backend?: string,
      scope?: VideoOperationScope,
      tools: KeyTools = {},
    ): Promise<Artifact> => {
      // The operation's key carries ONLY the tools it actually executes, over the
      // always-present base. A composition/audio operation declares no tool, so
      // its key is independent of whether any browser/blender Source exists —
      // an unrelated tool edit (or a Build that stops executing one) cannot
      // silently re-key it and defeat cross-build reuse.
      const key = stableHash({
        kind,
        inputs,
        parameters,
        simulated,
        environment: await probe.environment(tools),
        implementation: await implementationFor(kind, scope),
      });
      const operationId = `op-${key.slice(0, 32)}`;
      record.plan.operations.push(operationId);
      let artifact = cached.get(key),
        reused = false;
      if (artifact) {
        try {
          reused = (await hashFile(await resolveProjectPath(root, artifact.path))) === artifact.sha256;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      let producedDiagnostics: CaptureDiagnostic[] = [];
      if (!reused) {
        const temporary = path.join(scratchPath, `${operationId}.${extension}`);
        const produced = await work(temporary);
        producedDiagnostics = produced?.diagnostics ?? [];
        const sha256 = await hashFile(temporary);
        const artifactId = `artifact-${stableHash({ key, sha256 }).slice(0, 40)}`;
        const relative = `.viscraft/artifacts/${artifactId}.${extension}`;
        const destination = await resolveProjectPath(root, relative);
        const media = extension === 'mp4' ? await probeMedia(temporary) : undefined;
        await mkdir(path.dirname(destination), { recursive: true });
        try {
          const existingHash = await hashFile(destination);
          if (existingHash !== sha256) {
            // Restore damaged cached bytes without destroying the evidence of corruption.
            if (!historicalArtifacts.has(artifactId)) throw new Error(`Immutable artifact collision: ${artifactId}`);
            const damaged = await resolveProjectPath(
              root,
              `.viscraft/damaged/${artifactId}-${randomUUID()}.${extension}`,
            );
            await mkdir(path.dirname(damaged), { recursive: true });
            await rename(destination, damaged);
            await rename(temporary, destination);
          } else await rm(temporary);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await rename(temporary, destination);
        }
        artifact = {
          id: artifactId,
          path: relative,
          sha256,
          kind: extension === 'wav' ? 'audio' : 'video',
          simulated,
          operation: kind,
          inputs,
          backend:
            backend ??
            (kind === 'browser'
              ? environment.browser
              : kind === 'blender'
                ? (environment.blender ?? 'blender')
                : kind === 'simulated'
                  ? 'ffmpeg-simulated/test-only'
                  : environment.ffmpeg),
          ...(media ? { media } : {}),
          ...(produced?.generation ? { generation: produced.generation } : {}),
          ...(produced?.imageGeneration ? { imageGeneration: produced.imageGeneration } : {}),
          ...(produced?.mastering ? { mastering: produced.mastering } : {}),
          ...(produced?.bus ? { bus: produced.bus } : {}),
        };
        producedThisBuild.add(artifactId);
      }
      const completed = artifact!;
      if (!record.artifacts.some(a => a.id === completed.id)) record.artifacts.push(completed);
      record.operations.push({ id: operationId, kind, key, inputs, artifact: completed.id, reused });
      // A reused operation reports the diagnostics its original run recorded; a
      // freshly produced one reports what its capture just observed.
      const operationDiagnostics = reused ? (historicalDiagnostics.get(key) ?? []) : producedDiagnostics;
      if (operationDiagnostics.length > 0) {
        for (const diagnostic of operationDiagnostics) buildDiagnostics.push({ ...diagnostic, operation: operationId });
        record.diagnostics = buildDiagnostics;
      }
      await persist();
      return completed;
    };
    const sourceTakes = new Map<string, { artifact: Artifact; take: Take }>();
    const sourceTake = async (source: Source): Promise<{ artifact: Artifact; take: Take }> => {
      const previous = sourceTakes.get(source.id);
      if (previous) return previous;
      const executor = sourceExecutor(source);
      // A `scale < 1` preview renders proxy-raster Sources at their proxy output
      // (its own Operation key); everything else is produced at full output.
      const output =
        preview && executor.proxyRasterFor(source) ? proxyOutput(pictureOutput, preview.scale) : pictureOutput;
      const sound = soundContextForSource(project, source, selection.medium === 'sound' ? selection.target : undefined);
      // The operation's identity (inputs/parameters/simulated) and the resolved
      // bindings/world/media are computed by the SHARED module the preflight also
      // uses, so a Build's cache key and the preflight's reuse prediction cannot
      // drift apart. WHICH executor produces the Take is the Source's own registry
      // entry — this scheduler never selects it.
      const { inputs, parameters, simulated, resolved, protocol, implementationFiles } = await sourceOperationIdentity(
        project,
        source,
        options,
        files,
        output,
        snapshot,
        sound,
      );
      const operationScope: VideoOperationScope | undefined = protocol ? { protocol, implementationFiles } : undefined;
      const soundOutput = executor.outputOf(source) === 'sound';
      const artifact = await execute(
        source.kind,
        inputs,
        parameters,
        simulated,
        soundOutput ? 'wav' : 'mp4',
        destination =>
          executor.produce(source, resolved, {
            root,
            frozenRoot: snapshot,
            scratch: scratchPath,
            destination,
            output,
            sound,
            providers: options.providers,
            blender: options.blender,
          }),
        executor.backendLabel?.(source, options.providers),
        operationScope,
        executor.tools,
      );
      const sourceKey = record.operations.at(-1)!.key;
      // A Take records the clock it ACTUALLY runs on: a sound Take carries its
      // native sample span/rate/channel count, never a picture frame grid.
      const takeId = `take-${stableHash({ sourceKey, artifact: artifact.id }).slice(0, 40)}`;
      const take: Take =
        executor.outputOf(source) === 'sound'
          ? {
              id: takeId,
              artifact: artifact.id,
              source: source.id,
              sourceKey,
              medium: 'sound',
              samples: (source as Extract<Source, { kind: 'browser'; output: 'sound' }>).durationSamples,
              sampleRate: (source as Extract<Source, { kind: 'browser'; output: 'sound' }>).sampleRate,
              channels: sound!.channels,
              simulated: artifact.simulated,
            }
          : {
              id: takeId,
              artifact: artifact.id,
              source: source.id,
              sourceKey,
              medium: 'picture',
              frames: artifact.media!.frames,
              fps: artifact.media!.fps,
              simulated: artifact.simulated,
            };
      record.takes.push(take);
      await persist();
      const result = { artifact, take };
      sourceTakes.set(source.id, result);
      return result;
    };
    const selectedTake = async (id: string): Promise<{ artifact: Artifact; take: Take }> => {
      // The same valid-history predicate as `cached`/the preflight: a Take
      // recorded by a reusable (succeeded or failed) Build is selectable; only a
      // live `running` record is excluded.
      const take = [...record.takes, ...reusable.flatMap(build => build.takes)].find(take => take.id === id);
      if (!take) throw new Error(`Unknown selected Take ${id}`);
      const artifact =
        record.artifacts.find(artifact => artifact.id === take.artifact) ?? historicalArtifacts.get(take.artifact);
      if (artifact?.archived && !(await artifactAvailable(root, artifact)))
        throw new Error(
          `Selected Take ${id} was released to archive ${artifact.archived.archive}; run \`viscraft restore-media <project> <archive>\` first`,
        );
      if (!artifact || (await hashFile(await resolveProjectPath(root, artifact.path))) !== artifact.sha256)
        throw new Error(`Missing or damaged selected Take ${id}`);
      if (!record.takes.some(item => item.id === id)) record.takes.push(take);
      if (!record.artifacts.some(item => item.id === artifact.id)) record.artifacts.push(artifact);
      return { artifact, take };
    };
    // A picture interval whose picture comes from a DIRECTLY referenced Asset.
    // A VIDEO Asset is normalized to the output grid/fps through
    // `normalizeMedia` (duration and the source PTS→output mapping are preserved;
    // playback speed is never changed); an IMAGE Asset is encoded as a still held
    // for `outFrame` output-grid frames. The normalization is an Operation keyed
    // on the Asset hash, the framing, the output settings and the real
    // `backends/media` implementation (see `assetPictureIdentity`), so equal
    // references reuse one Take and any change re-keys it. Assets always
    // normalize at the FULL composition output, never the preview proxy raster.
    const assetTakes = new Map<string, { artifact: Artifact; take: Take }>();
    const assetTake = async (reference: {
      asset: string;
      framing?: MediaFraming;
      outFrame: number;
      owner: string;
    }): Promise<{ artifact: Artifact; take: Take }> => {
      const asset = project.assets.find(candidate => candidate.id === reference.asset);
      if (!asset || (asset.type !== 'video' && asset.type !== 'image'))
        throw new Error(`${reference.owner} references Asset ${reference.asset}, which is not a video or image Asset`);
      const identity = assetPictureIdentity(
        asset,
        { framing: reference.framing, outFrame: reference.outFrame },
        film.composition.output,
      );
      const memoKey = stableHash({ kind: identity.kind, inputs: identity.inputs, parameters: identity.parameters });
      const memoized = assetTakes.get(memoKey);
      if (memoized) return memoized;
      const frozen = await resolveProjectPath(snapshot, asset.path);
      const artifact = await execute(
        identity.kind,
        identity.inputs,
        identity.parameters,
        identity.simulated,
        'mp4',
        destination =>
          identity.kind === 'normalize-still'
            ? renderStill(frozen, film.composition.output, identity.stillFrames!, destination, reference.framing)
            : normalizeMedia(frozen, film.composition.output, destination, reference.framing),
      );
      const sourceKey = record.operations.at(-1)!.key;
      const take: Take = {
        id: `take-${stableHash({ sourceKey, artifact: artifact.id }).slice(0, 40)}`,
        artifact: artifact.id,
        asset: asset.id,
        sourceKey,
        medium: 'picture',
        frames: identity.kind === 'normalize-still' ? identity.stillFrames! : artifact.media!.frames,
        fps: artifact.media!.fps,
        simulated: artifact.simulated,
      };
      if (!record.takes.some(item => item.id === take.id)) record.takes.push(take);
      await persist();
      const result = { artifact, take };
      assetTakes.set(memoKey, result);
      return result;
    };
    // The READ-ONLY input and provider-request preflight for EVERY Source this Build will
    // actually EXECUTE, consumed HERE — before the first capture/POST — through
    // the SAME `classify`/`requestIssues` hooks the production preflight runs. A
    // request error that is already knowable (a model/deployment mismatch, an
    // invalid/oversized reference, missing configuration, an unauthorized
    // submission) must not be discovered only after an EARLIER Source has already
    // been generated and paid for. A Source whose exact operation key already
    // matches a reusable, hash-verified artifact is SKIPPED: it is not re-run, so
    // it must not be asked to re-authorize spend or re-transmit references. The
    // per-operation key environment is the SAME one `execute` uses below.
    for (const source of project.sources) {
      const executor = sourceExecutor(source);
      if (!consumedIds.has(source.id)) continue;
      const output =
        preview && executor.proxyRasterFor(source) ? proxyOutput(pictureOutput, preview.scale) : pictureOutput;
      const sound = soundContextForSource(project, source, selection.medium === 'sound' ? selection.target : undefined);
      const identity = await sourceOperationIdentity(project, source, options, files, output, snapshot, sound);
      const scope: VideoOperationScope | undefined = identity.protocol
        ? { protocol: identity.protocol, implementationFiles: identity.implementationFiles }
        : undefined;
      const key = stableHash({
        kind: identity.kind,
        inputs: identity.inputs,
        parameters: identity.parameters,
        simulated: identity.simulated,
        environment: await probe.environment(executor.tools),
        implementation: await implementationFor(source.kind, scope),
      });
      const reusableArtifact = cached.get(key);
      if (reusableArtifact) {
        let verified = false;
        try {
          verified =
            (await hashFile(await resolveProjectPath(root, reusableArtifact.path))) === reusableArtifact.sha256;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (verified) continue;
      }
      const context: SourceContext = { project, providers: options.providers, files, output, loadRoot: snapshot };
      const out: ExecutorPreflightOut = {
        blockers: [],
        needsConfiguration: [],
        requiresApproval: [],
        unsupported: [],
        pending: [],
      };
      await executor.classify?.(source, context, out);
      const issues: ExecutorIssue[] = [
        ...out.blockers,
        ...out.needsConfiguration,
        ...out.requiresApproval,
        ...out.unsupported,
        ...((await executor.requestIssues?.(source, context)) ?? []),
      ];
      const fatal = issues.find(issue => issue.level !== 'pending');
      if (fatal) throw new Error(fatal.message);
    }
    if (selection.medium === 'picture')
      for (const candidate of record.plan.candidates ?? [])
        for (const id of candidate.sources) await sourceTake(project.sources.find(source => source.id === id)!);
    if (selection.medium === 'sound') {
      const target = selection.target;
      // Every code-authored sound Source the target places is rendered ONCE, at
      // its own native rate and sample span; the mixer decodes and resamples it.
      const soundTakes = new Map<string, string>();
      const soundArtifacts: Artifact[] = [];
      for (const clip of target.audio) {
        if (clip.kind !== 'source' || soundTakes.has(clip.source)) continue;
        const source = project.sources.find(candidate => candidate.id === clip.source);
        if (!source || source.kind !== 'browser' || source.output !== 'sound')
          throw new Error(`Audio clip ${clip.id} references missing sound Source ${clip.source}`);
        const { artifact } = await sourceTake(source);
        soundTakes.set(source.id, await resolveProjectPath(root, artifact.path));
        soundArtifacts.push(artifact);
      }
      const audioAssets = target.audio.flatMap(clip => {
        if (clip.kind !== 'asset') return [];
        const asset = project.assets.find(candidate => candidate.id === clip.asset);
        if (!asset) throw new Error(`Audio clip ${clip.id} references missing Asset ${clip.asset}`);
        // A consumed Asset is admitted by its DECLARED digest. The snapshot keeps
        // the actual bytes of a damaged file as an author fact, but an operation
        // must never read them under the old hash.
        const digest = files.get(asset.path);
        if (digest === undefined)
          throw new Error(
            `Audio clip ${clip.id} consumes Asset ${asset.id} ("${asset.path}"), whose authored bytes are not available`,
          );
        if (digest !== asset.sha256)
          throw new Error(
            `Audio clip ${clip.id} consumes Asset ${asset.id} ("${asset.path}"), but its current bytes do not match the recorded Asset digest`,
          );
        return [asset];
      });
      const audioSimulated = audioAssets.some(asset => asset.simulated) || soundArtifacts.some(a => a.simulated);
      const ducking = target.ducking ?? [];
      if (ducking.length > 0) {
        const memberBuses = new Set(target.audio.flatMap(clip => (clip.bus !== undefined ? [clip.bus] : [])));
        for (const entry of ducking) {
          if (!memberBuses.has(entry.target))
            throw new Error(`Sound target ${target.id} ducking target bus "${entry.target}" has no members`);
          if (!memberBuses.has(entry.control))
            throw new Error(`Sound target ${target.id} ducking control bus "${entry.control}" has no members`);
        }
      }
      // Only the sample clock reaches the key: a film's raster/FPS edit can never
      // re-key a sound programme.
      const mixOutput: OutputSettings = {
        ...pictureOutput,
        sampleRate: target.sampleRate,
        channels: target.channels,
      };
      const timingAuthority = target.beats && target.beats.length > 0 ? { beats: target.beats } : {};
      const audio = await execute(
        'mix-audio',
        [...audioAssets.map(asset => asset.sha256), ...soundArtifacts.map(a => a.sha256)],
        {
          output: { sampleRate: target.sampleRate, channels: target.channels },
          audio: target.audio,
          totalSamples: target.outputSamples,
          ...timingAuthority,
          ...(ducking.length > 0 ? { ducking } : {}),
        },
        audioSimulated,
        'wav',
        destination =>
          mixAudioSamples(
            snapshot,
            project,
            [],
            { output: mixOutput, totalSamples: target.outputSamples, clips: target.audio },
            destination,
            soundTakes,
            undefined,
            ducking.length > 0 ? ducking : undefined,
          ),
      );
      let final = audio;
      if (target.mastering) {
        const mastering = target.mastering;
        final = await execute(
          'master-audio',
          [audio.sha256],
          { sampleRate: target.sampleRate, channels: target.channels, samples: target.outputSamples, mastering },
          audioSimulated,
          'wav',
          async destination => ({
            mastering: await masterAudioSamples(
              await resolveProjectPath(root, audio.path),
              mixOutput,
              target.outputSamples,
              mastering,
              destination,
            ),
          }),
        );
      }
      record.result = { artifact: final.id, simulated: final.simulated };
    } else {
      // Whether a Take's FILE actually carries an audio stream. The recorded
      // `artifact.media` fact is provenance, not proof: a build record can be stale
      // or forged so its recorded audio disagrees with the file (in either
      // direction). The guard therefore probes the real file. An artifact produced
      // in THIS build was probed from the bytes it just wrote (`execute`), so its
      // recorded fact is used directly; a reused/historical artifact is probed once,
      // memoized per artifact, so a Take placed repeatedly costs a single ffprobe.
      // This runs only for `keep` placements (a handful) and is far cheaper than the
      // encode/mux work a Build already performs, so it is not a real regression.
      const takeAudioCache = new Map<string, Promise<boolean>>();
      const takeHasAudio = async (artifact: Artifact): Promise<boolean> => {
        if (producedThisBuild.has(artifact.id)) return Boolean(artifact.media?.audio);
        const cached = takeAudioCache.get(artifact.id);
        if (cached) return cached;
        const probe = (async () => Boolean((await probeMedia(await resolveProjectPath(root, artifact.path))).audio))();
        takeAudioCache.set(artifact.id, probe);
        return probe;
      };
      // The single, actionable message for a `keep` placement over an audio-less
      // Take. It is emitted wherever that condition is the true, first error, so a
      // single authored mistake never yields two different messages.
      const keptAudioMessage = (placement: Placement, take: Take): string =>
        `Placement ${placement.id} has audio "keep" but its source Take ${take.id}${take.source ? (placement.source ? ` (Source ${placement.source})` : '') : ` (Asset ${take.asset})`} declares no audio stream, so nothing was kept; use audio "mute" if the silence is intended, or select or produce a Take that carries audio`;
      const clips: ComposeClip[] = [];
      const clipArtifacts: Artifact[] = [];
      const kept: Array<{
        path: string;
        startFrame: number;
        gain: number;
        fadeInSamples: number;
        fadeOutSamples: number;
        offsetSamples: number;
        tailSamples: number;
        leadSamples: number;
        takePath: string;
        takeInSample: number;
        takeBodySamples: number;
        bus: string | undefined;
      }> = [];
      const keptIds: string[] = [];
      // `keep` placements whose Take has no audio and whose bus might still have
      // another member. A memberless bus is the documented stem-stage error and is
      // left to it; a bus with another member is a real silent drop and is raised
      // after the loop (see below), once `kept` tells us which buses have members.
      const silentKeeps: Array<{ placement: Placement; take: Take }> = [];
      for (const placement of film.composition.placements) {
        if (preview?.substituted.has(placement.id)) {
          // Wholly outside the preview range: a black, silent stand-in of the same
          // timeline length; the Placement's Source is not produced.
          const length = placement.durationFrames ?? placement.outFrame - placement.inFrame;
          const output = film.composition.output;
          const gap = await execute('preview-gap', [], { frames: length, output }, false, 'mp4', destination =>
            renderGap(output, length, destination),
          );
          const { durationFrames: _duration, ...edit } = placement;
          clips.push({
            placement: { ...edit, inFrame: 0, outFrame: length, audio: 'mute' },
            path: await resolveProjectPath(root, gap.path),
            media: gap.media!,
          });
          clipArtifacts.push(gap);
          continue;
        }
        let artifact: Artifact, take: Take;
        if (placement.source)
          ({ artifact, take } = await sourceTake(film.sources.find(s => s.id === placement.source)!));
        else if (placement.take) ({ artifact, take } = await selectedTake(placement.take));
        else
          ({ artifact, take } = await assetTake({
            asset: placement.asset!,
            framing: placement.framing,
            outFrame: placement.outFrame,
            owner: `Placement ${placement.id}`,
          }));
        if (placement.outFrame > pictureTake(take).frames)
          throw new Error(
            `Placement ${placement.id} reads beyond Take ${take.id} (${pictureTake(take).frames} frames); handles unavailable`,
          );
        // A `keep` placement over a Take whose FILE has no audio stream would drop
        // the audio the author asked to keep in silence. That is a loud error, raised
        // here before this placement's retime/grade/trim/compose work, using the
        // probed file fact (never the possibly-stale recorded media). An existing
        // `take:` placement performs no production before this point; a `source`
        // placement must be rendered before its audio can be known, so its Take (and
        // media operation) already exists in the failed record — but never a result
        // artifact. The memberless-bus exception is resolved after the loop.
        const keepsAudio = placement.audio === 'keep' ? await takeHasAudio(artifact) : false;
        if (placement.audio === 'keep' && !keepsAudio) {
          if (placement.bus === undefined) throw new Error(keptAudioMessage(placement, take));
          silentKeeps.push({ placement, take });
        }
        // The ORIGINAL Take the placement selects, captured BEFORE any retime. Its
        // file and the placement's own `inFrame` are the clock the kept-audio
        // J-cut/L-cut handles are read from (see `kept.push` below), matching
        // `review.ts`, which computes handles from the original Take + `inFrame`.
        // After a speed change the materialized `artifact` is the RETIMED,
        // body-only clip, so reading pre-roll/tail from it would silently miss.
        const originalTake = artifact;
        let clipPlacement = placement;
        if (
          placement.durationFrames !== undefined &&
          placement.durationFrames !== placement.outFrame - placement.inFrame
        ) {
          const sourceArtifact = artifact;
          const sourcePath = await resolveProjectPath(root, sourceArtifact.path);
          artifact = await execute(
            'retime-clip',
            [sourceArtifact.id],
            {
              inFrame: placement.inFrame,
              outFrame: placement.outFrame,
              durationFrames: placement.durationFrames,
              output: film.composition.output,
            },
            sourceArtifact.simulated,
            'mp4',
            destination =>
              retimeClip(
                sourcePath,
                film.composition.output,
                placement.inFrame,
                placement.outFrame,
                placement.durationFrames!,
                destination,
              ),
          );
          clipPlacement = { ...placement, inFrame: 0, outFrame: placement.durationFrames };
        }
        // The kept audio's SOURCE, INTERVAL and SAMPLE CLOCK are the ORIGINAL
        // Take over [placement.inFrame, placement.outFrame] — never the retimed,
        // body-only picture artifact. A speed change retimes the PICTURE only; the
        // kept body and its J/L-cut handles stay on the original clock, so the mix
        // and `review.ts` (which reads the same original artifact/range) agree.
        const audioInput = originalTake;
        const audioPath = await resolveProjectPath(root, originalTake.path);
        const filename = await resolveProjectPath(root, artifact.path);
        const shot = film.composition.shots.find(shot => shot.id === placement.shot)!;
        const look = film.direction.looks.find(look => look.id === shot.look)!;
        if (look.grade) {
          const inputArtifact = artifact;
          artifact = await execute(
            'grade-picture',
            [inputArtifact.id],
            {
              grade: look.grade,
              inFrame: clipPlacement.inFrame,
              outFrame: clipPlacement.outFrame,
              output: film.composition.output,
            },
            inputArtifact.simulated,
            'mp4',
            destination =>
              gradeMedia(
                filename,
                film.composition.output,
                clipPlacement.inFrame,
                clipPlacement.outFrame,
                look.grade!,
                destination,
              ),
          );
          const { durationFrames: _duration, ...edit } = clipPlacement;
          clips.push({
            placement: { ...edit, inFrame: 0, outFrame: artifact.media!.frames },
            path: await resolveProjectPath(root, artifact.path),
            media: artifact.media!,
          });
        } else clips.push({ placement: clipPlacement, path: filename, media: artifact.media! });
        clipArtifacts.push(artifact);
        // Gate on the probed file fact (`keepsAudio`), not the recorded media info,
        // so a Keep whose Take really carries audio is never silently skipped and a
        // Take that only CLAIMS audio is never handed to ffmpeg as if it had some.
        if (placement.audio === 'keep' && keepsAudio) {
          // ONE CLOCK for kept audio. The kept body, its J/L-cut handles
          // (`takeInSample`, below) and `review.ts`'s handle facts all read the
          // ORIGINAL Take over `[placement.inFrame, placement.outFrame)` on the
          // Take's OWN frame clock (`take.fps`), never the retimed, body-only
          // picture artifact and never the composition fps. The body is then
          // pitch-preserving time-stretched to the placement's OUTPUT length
          // (`durationFrames ?? outFrame - inFrame`) by the SAME helper `retimeClip`
          // uses, so the picture and its kept audio stretch together and stay
          // sample-aligned. The stretch factor `f = sourceSamples / targetSamples`
          // maps the source clock onto the output timeline: a source-clock span of
          // N lands on N/f output samples, i.e. a source-clock handle is f-scaled
          // on the output timeline. When the placement is not retimed `f` is exactly
          // 1 and the body is a plain sample-exact trim (behaviour unchanged).
          const targetFrames = placement.durationFrames ?? placement.outFrame - placement.inFrame;
          const audio = await execute(
            'source-audio-trim',
            [audioInput.id],
            {
              inFrame: placement.inFrame,
              outFrame: placement.outFrame,
              durationFrames: targetFrames,
              output: film.composition.output,
            },
            audioInput.simulated,
            'wav',
            destination =>
              encodeRetimedAudioBody(
                audioPath,
                pictureTake(take).fps,
                film.composition.output,
                placement.inFrame,
                placement.outFrame,
                targetFrames,
                destination,
              ),
          );
          kept.push({
            path: await resolveProjectPath(root, audio.path),
            startFrame: placement.startFrame,
            gain: placement.audioGain ?? 1,
            fadeInSamples: placement.audioFadeInSamples ?? 0,
            fadeOutSamples: placement.audioFadeOutSamples ?? 0,
            offsetSamples: placement.audioOffsetSamples ?? 0,
            tailSamples: placement.audioTailSamples ?? 0,
            leadSamples: placement.audioLeadSamples ?? 0,
            // The J/L-cut handles are read from the ORIGINAL Take at the
            // placement's OWN `inFrame` on the Take's frame clock — never the
            // materialized body. Under a speed change `clipPlacement.inFrame` is 0
            // on the retimed clip, so reading pre-roll/tail there would silently
            // drop both (a silent J/L-cut). `review.ts` computes its handles from
            // the same original Take + `inFrame` + Take fps, so the report and the
            // mix share one clock.
            takePath: await resolveProjectPath(root, originalTake.path),
            takeInSample: framesToSamples(
              placement.inFrame,
              pictureTake(take).fps,
              film.composition.output.sampleRate,
              'nearest',
            ),
            // The BODY's SOURCE length on the SAME Take frame clock as
            // `takeInSample`: the original source interval `outFrame - inFrame`.
            // The L-cut tail is read from the Take at `takeInSample +
            // takeBodySamples` (the source interval's end) — NOT at the retimed
            // output-clock body length, which under a speed change would read past
            // the intended source position.
            takeBodySamples: framesToSamples(
              placement.outFrame - placement.inFrame,
              pictureTake(take).fps,
              film.composition.output.sampleRate,
              'nearest',
            ),
            bus: placement.bus,
          });
          keptIds.push(audio.id);
        }
      }
      // Resolve the deferred `keep` placements. A `keep` over an audio-less Take is
      // a real silent drop even when its declared bus has ANOTHER member (e.g. an
      // audio clip routed to the same bus), which the memberless-bus stem check
      // would not catch. It is raised here, before any audio staging. A bus that
      // resolves to NO member at all is a different, also-true error with its own
      // message, so that case is left to the stem stage below — the same authored
      // mistake is never reported with two different messages.
      if (silentKeeps.length > 0) {
        const memberBuses = new Set<string>([
          ...film.composition.audio.filter(clip => clip.bus !== undefined).map(clip => clip.bus!),
          ...kept.filter(entry => entry.bus !== undefined).map(entry => entry.bus!),
        ]);
        for (const silent of silentKeeps)
          if (memberBuses.has(silent.placement.bus!)) throw new Error(keptAudioMessage(silent.placement, silent.take));
      }
      const composition = film.composition;
      const totalFrames = compositionFrames(film);
      // A declared beat/onset grid is *time authority*, not content: carrying it
      // in the timeline operations' parameters means an edit to the grid
      // invalidates exactly the operations whose timing depends on it. It never
      // reaches the media backends, so the rendered picture/audio bytes are
      // unchanged. An absent or empty grid leaves the parameters — and therefore
      // the cache keys — unchanged.
      const beats = composition.beats ?? [];
      const timingAuthority = beats.length > 0 ? { beats } : {};
      // An explicit programme length changes the composed picture length, so it
      // must participate in the compose-video key. Only an authored explicit
      // length contributes this parameter; otherwise the content determines length.
      const explicitLength = composition.outputFrames !== undefined ? { outputFrames: composition.outputFrames } : {};
      const visualSimulated = clipArtifacts.some(a => a.simulated) || consumedOccluders.some(asset => asset.simulated);
      // Picture operations must be keyed only on what changes the pixels. Strip
      // every audio-only placement key explicitly (audio, gain, fades, offset,
      // tail, bus) with a rest-destructure so a future audio field cannot silently
      // leak in and let an audio-only edit mint a byte-identical picture artifact.
      const picturePlacement = ({
        audio: _audio,
        audioGain: _audioGain,
        audioFadeInSamples: _audioFadeIn,
        audioFadeOutSamples: _audioFadeOut,
        audioOffsetSamples: _audioOffset,
        audioTailSamples: _audioTail,
        audioLeadSamples: _audioLead,
        bus: _bus,
        ...picture
      }: (typeof composition.placements)[number]) => picture;
      // An `occlude` transition reads an occluder Asset's bytes, so both that
      // Asset's identity (its frozen `sha256`, from the in-memory frozen film)
      // and its BYTES must key/feed the compose-video operation. Only declared
      // occlusion transitions contribute these dependencies. The occluder is an
      // authored Asset frozen at `.viscraft/snapshots/<buildId>/<asset.path>`; the
      // frozen snapshot root — NOT the live film root — is threaded through so
      // composeVideo reads exactly the bytes whose digest is in the key. An author
      // edit to the occluder mid-build cannot change what this cut decodes.
      const occluderAssets = consumedOccluders.map(asset => ({ occluder: asset.id, sha256: asset.sha256 }));
      const occluderParameters = occluderAssets.length > 0 ? { occluderAssets } : {};
      const video = await execute(
        'compose-video',
        clipArtifacts.map(a => a.id),
        {
          output: composition.output,
          placements: composition.placements.map(picturePlacement),
          transitions: composition.transitions,
          ...explicitLength,
          ...timingAuthority,
          ...occluderParameters,
        },
        visualSimulated,
        'mp4',
        destination => composeVideo(film, clips, destination, snapshot),
      );
      let picture = video;
      const layers = (composition.layers ?? []).filter(layer => !preview?.droppedLayers.has(layer.id));
      const layerClips: PictureLayerClip[] = [];
      const layerArtifacts: Artifact[] = [];
      for (const layer of layers) {
        const { artifact, take } = layer.source
          ? await sourceTake(film.sources.find(source => source.id === layer.source)!)
          : layer.take
            ? await selectedTake(layer.take)
            : await assetTake({
                asset: layer.asset!,
                framing: layer.framing,
                outFrame: layer.outFrame,
                owner: `Picture layer ${layer.id}`,
              });
        if (layer.outFrame > pictureTake(take).frames)
          throw new Error(`Picture layer ${layer.id} reads beyond Take ${take.id}`);
        layerClips.push({ layer, path: await resolveProjectPath(root, artifact.path), media: artifact.media! });
        layerArtifacts.push(artifact);
      }
      const pictureSimulated = visualSimulated || layerArtifacts.some(artifact => artifact.simulated);
      if (layers.length > 0) {
        const extension = path.extname(fileURLToPath(import.meta.url));
        const rendererHash = await hashFile(path.join(implementationRoot, `backends/media/layers${extension}`));
        picture = await execute(
          'overlay-picture-layers',
          [video.id, ...layerArtifacts.map(artifact => artifact.id)],
          { layers, output: composition.output, totalFrames, rendererHash },
          pictureSimulated,
          'mp4',
          async destination =>
            overlayPictureLayers(
              await resolveProjectPath(root, video.path),
              layerClips,
              composition.output,
              totalFrames,
              destination,
            ),
        );
      }
      const subtitles = composition.subtitles ?? [];
      if (subtitles.length > 0) {
        // Resolved ONCE by the shared preflight above (guaranteed non-empty for a
        // composition that authors subtitles), never re-resolved here.
        const font = subtitleFont!.font!;
        const extension = path.extname(fileURLToPath(import.meta.url));
        const rendererHash = await hashFile(path.join(implementationRoot, `backends/media/subtitles${extension}`));
        const subtitleInput = picture;
        picture = await execute(
          'overlay-subtitles',
          [subtitleInput.id, font.sha256],
          { subtitles, output: composition.output, rendererHash },
          pictureSimulated,
          'mp4',
          async destination =>
            renderSubtitles(
              await resolveProjectPath(root, subtitleInput.path),
              subtitles,
              composition.output,
              destination,
              font,
            ),
        );
      }
      // Render every code-authored sound Source referenced by a clip into its own
      // WAV Take, so the mixer can decode it like any other audio input. Each render
      // is a distinct cached Operation keyed on the entry/resources/params/seed.
      const soundTakes = new Map<string, string>();
      const soundArtifacts: Artifact[] = [];
      for (const clip of composition.audio) {
        if (clip.kind !== 'source' || soundTakes.has(clip.source)) continue;
        const source = film.sources.find(candidate => candidate.id === clip.source);
        if (!source || source.kind !== 'browser' || source.output !== 'sound')
          throw new Error(`Audio clip ${clip.id} references missing sound Source ${clip.source}`);
        const { artifact } = await sourceTake(source);
        soundTakes.set(source.id, await resolveProjectPath(root, artifact.path));
        soundArtifacts.push(artifact);
      }
      const audioAssets = composition.audio
        .filter(a => a.kind === 'asset')
        .map(a => film.assets.find(asset => asset.id === a.asset)!);
      const audioSimulated =
        audioAssets.some(a => a.simulated) ||
        soundArtifacts.some(a => a.simulated) ||
        keptIds.some(id => record.artifacts.find(a => a.id === id)?.simulated);
      const keptParameters = (entries: typeof kept) =>
        entries.map(
          ({
            startFrame,
            gain,
            fadeInSamples,
            fadeOutSamples,
            offsetSamples,
            tailSamples,
            leadSamples,
            takeInSample,
            takeBodySamples,
          }) => ({
            startFrame,
            gain,
            fadeInSamples,
            fadeOutSamples,
            offsetSamples,
            tailSamples,
            leadSamples,
            takeInSample,
            takeBodySamples,
          }),
        );
      // Automatic sidechain ducking is declared per bus label. A `target` or
      // `control` label that resolves to no member (audio clip or kept placement)
      // is a loud error here, before any media work, never a silently inert rule.
      // The entries participate in the mix-audio/mix-stem cache keys only when
      // non-empty; an absent rule adds no audio-processing dependency.
      const memberBuses = new Set<string>([
        ...composition.audio.filter(clip => clip.bus !== undefined).map(clip => clip.bus!),
        ...kept.filter(entry => entry.bus !== undefined).map(entry => entry.bus!),
      ]);
      // A preview whose substituted Placements were a ducking bus's only members
      // drops that rule (it cannot affect the range); a full Build never does.
      const ducking = (composition.ducking ?? []).filter(
        entry => !preview || (memberBuses.has(entry.target) && memberBuses.has(entry.control)),
      );
      if (ducking.length > 0) {
        for (const entry of ducking) {
          if (!memberBuses.has(entry.target))
            throw new Error(
              `Composition ducking target bus "${entry.target}" has no members; add an audio clip or kept placement on that bus`,
            );
          if (!memberBuses.has(entry.control))
            throw new Error(
              `Composition ducking control bus "${entry.control}" has no members; add an audio clip or kept placement on that bus`,
            );
        }
      }
      const duckingParameters = ducking.length > 0 ? { ducking } : {};
      // A clip's cache key must not depend on its routing label: adding/removing a
      // `bus` only changes the stems, never the programme mix, so the label is
      // stripped from the parameters (kept entries already omit their path).
      const withoutBus = (clip: (typeof composition.audio)[number]): (typeof composition.audio)[number] => {
        const copy = { ...clip } as Record<string, unknown>;
        delete copy.bus;
        return copy as (typeof composition.audio)[number];
      };
      // ...EXCEPT once ducking is declared. The ducking curve is applied per member
      // by its label, and the control signal is the control bus's own mix, so which
      // member carries which label becomes real behaviour of the programme mix and
      // of every stem that ducks. Capturing the routing in the parameters is what
      // stops a label swap from silently reusing a mix that no longer describes the
      // film. Without ducking the label stays irrelevant and the keys are unchanged.
      const routingParameters =
        ducking.length > 0
          ? {
              busRouting: {
                audio: composition.audio.map(clip => clip.bus ?? null),
                kept: kept.map(entry => entry.bus ?? null),
              },
            }
          : {};
      // The programme mix is the FULL mix of every clip and kept placement; a stem
      // is an additional grouped export, never a re-routing that removes audio.
      // Parameters are path-free, so the cache key stays stable.
      const audio = await execute(
        'mix-audio',
        [...audioAssets.map(a => a.sha256), ...soundArtifacts.map(a => a.sha256), ...keptIds],
        {
          output: composition.output,
          audio: composition.audio.map(withoutBus),
          kept: keptParameters(kept),
          totalFrames,
          ...timingAuthority,
          ...duckingParameters,
          ...routingParameters,
        },
        audioSimulated,
        'wav',
        destination =>
          mixAudio(
            snapshot,
            film,
            kept,
            totalFrames,
            destination,
            soundTakes,
            undefined,
            ducking.length > 0 ? ducking : undefined,
          ),
      );
      // One stem per DISTINCT DECLARED bus, sorted for a stable plan. A bus is
      // declared by an audio clip or by a kept placement; a repeated label is
      // deduplicated so it can never emit two stem operations. A declared bus
      // that resolves to no member (e.g. a `keep` placement whose source has no
      // audio stream) is a loud error, never a silently missing stem.
      const declaredBuses = [
        ...new Set([
          ...composition.audio.filter(clip => clip.bus !== undefined).map(clip => clip.bus!),
          ...composition.placements.filter(placement => placement.bus !== undefined).map(placement => placement.bus!),
        ]),
      ].sort();
      const emittedBuses = new Set<string>();
      // Stems are delivery exports, not part of the programme: a preview skips them.
      for (const bus of preview ? [] : declaredBuses) {
        if (emittedBuses.has(bus)) throw new Error(`Build would emit a duplicate stem for bus ${bus}`);
        emittedBuses.add(bus);
        const busClips = composition.audio.filter(clip => clip.bus === bus);
        const busKept = kept.filter(entry => entry.bus === bus);
        if (busClips.length + busKept.length === 0)
          throw new Error(`Build cannot emit stem ${bus}: the bus has no members`);
        // A stem is ducked only by entries that target it, so an unrelated stem's
        // cache key is unaffected by a rule on another bus — including its routing,
        // which only matters to a stem that actually ducks.
        const busDucking = ducking.filter(entry => entry.target === bus);
        await execute(
          'mix-stem',
          [...audioAssets.map(a => a.sha256), ...soundArtifacts.map(a => a.sha256), ...keptIds],
          {
            output: composition.output,
            audio: busClips,
            kept: keptParameters(busKept),
            totalFrames,
            bus,
            ...timingAuthority,
            ...(busDucking.length > 0 ? { ducking: busDucking, ...routingParameters } : {}),
          },
          audioSimulated,
          'wav',
          async destination => {
            await mixAudio(
              snapshot,
              film,
              kept,
              totalFrames,
              destination,
              soundTakes,
              bus,
              busDucking.length > 0 ? busDucking : undefined,
            );
            return { bus };
          },
        );
      }
      let master = audio;
      if (composition.mastering) {
        master = await execute(
          'master-audio',
          [audio.id],
          { output: composition.output, totalFrames, mastering: composition.mastering },
          audioSimulated,
          'wav',
          async destination => ({
            mastering: await masterAudio(
              await resolveProjectPath(root, audio.path),
              composition.output,
              totalFrames,
              composition.mastering!,
              destination,
            ),
          }),
        );
      }
      const final = await execute(
        'mux-final',
        [picture.id, master.id],
        { output: composition.output, totalFrames, fade: composition.fade },
        pictureSimulated || audioSimulated,
        'mp4',
        async destination => {
          await muxVideo(
            await resolveProjectPath(root, picture.path),
            await resolveProjectPath(root, master.path),
            composition.output,
            totalFrames,
            destination,
            composition.fade,
          );
          const info = await probeMedia(destination);
          const frameDuration = composition.output.fps.denominator / composition.output.fps.numerator;
          if (
            info.frames !== totalFrames ||
            info.audio?.sampleRate !== composition.output.sampleRate ||
            info.audio.channels !== composition.output.channels ||
            Math.abs(info.audio.duration - totalFrames * frameDuration) > frameDuration
          )
            throw new Error('Final output failed frame/audio synchronization validation');
        },
      );
      if (preview) {
        const [start, end] = preview.frames;
        const size = proxyOutput(composition.output, preview.scale);
        const range = await execute(
          'preview-range',
          [final.id],
          { frames: preview.frames, width: size.width, height: size.height },
          final.simulated,
          'mp4',
          async destination =>
            trimPreview(await resolveProjectPath(root, final.path), composition.output, start, end, size, destination),
        );
        record.preview!.artifact = range.id;
        if (preview.still) {
          const relative = `.viscraft/previews/${id}/frame-${start}.png`;
          const still = await resolveProjectPath(root, relative);
          await mkdir(path.dirname(still), { recursive: true });
          await extractStill(await resolveProjectPath(root, range.path), still);
          record.preview!.still = { frame: start, path: relative, sha256: await hashFile(still) };
        }
      } else record.result = { artifact: final.id, simulated: final.simulated };
    }
    record.status = 'succeeded';
    record.finishedAt = new Date().toISOString();
    try {
      record.stale = stableHash(await loadProject(root)) !== stableHash(project);
      for (const [relative, frozenHash] of files)
        if ((await hashFile(await resolveProjectPath(root, relative))) !== frozenHash) record.stale = true;
    } catch {
      record.stale = true;
    }
    await persist();
    // A stale build is inspectable but must not replace the active result of
    // newer authoring; a preview never replaces it.
    // A sound target never owns the movie pointer: its result lives in the Build
    // record, so producing a soundtrack cannot overwrite the active film result.
    if (selection.medium === 'picture' && !record.stale && !preview) {
      const active = record.artifacts.find(artifact => artifact.id === record.result!.artifact)!;
      await atomicJson(await resolveProjectPath(root, '.viscraft/result.json'), {
        build: record.id,
        ...record.result,
        path: active.path,
        sha256: active.sha256,
      });
    }
    return record;
  } catch (error) {
    record.status = 'failed';
    record.finishedAt = new Date().toISOString();
    record.error = redact(error instanceof Error ? error.message : String(error));
    await persist();
    throw new Error(`Build ${id} failed: ${record.error}`);
  } finally {
    try {
      if (scratch) await rm(scratch, { recursive: true, force: true });
    } finally {
      await release();
    }
  }
}
