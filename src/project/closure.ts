/**
 * The ONE implementation of "which bytes does a protection root reach?".
 *
 * Portable export ("what the current author state + active result need") and the
 * retention/cleanup diagnostics ("what every protection root needs") are the
 * SAME traversal of the Build/Artifact/Take lineage starting from a different
 * set of roots. Keeping one implementation is what stops Status, Revert and
 * Clean from disagreeing about whether a byte is still referenced.
 *
 * Roots (the protection-root set):
 *  - `author`         — the current authored closure + selected Takes
 *  - `active-result`  — `.viscraft/result.json` and, per still-image target, the
 *                       target's newest succeeded result (`image-result`)
 *  - `retained`       — Build records carrying `retained`
 *  - `checkpoint`     — `.viscraft/checkpoints/*.json`
 *  - `derived`        — Asset `derivedFrom` parents (recursive)
 *  - `provider-job`   — persisted generation job records (any status)
 *  - `generated`      — every non-simulated `generation`/`imageGeneration` artifact
 *  - `in-progress-cleanup` — unfinished `.viscraft/cleanups/*.json` entries
 *
 * A caller may additionally seed explicit Build ids (`options.extraBuilds`): the
 * delivery boundary's "carry this accepted version too" selection enters the SAME
 * traversal as a starting point, so those Builds — and, transitively, every
 * Artifact input, real producer and frozen frame/audio derivation parent they
 * need — are expanded by the one implementation, never by a second union after
 * the fact.
 *
 * It throws on inconsistent lineage (a selected Take with no Build, a dangling
 * parent Artifact, a frozen snapshot that does not match its recorded hash): a
 * caller that is about to PACKAGE or DELETE those bytes must refuse, not guess.
 * A purely read-only diagnostic may call it with a root set it knows is
 * consistent, or catch and surface the inconsistency as `attention`.
 */
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { Artifact, Asset, BuildRecord, Project } from '../core/schema.js';
import { ProjectSchema } from '../core/schema.js';
import { resolveProjectPath } from '../shared/fs.js';
import { hashFile } from '../shared/hash.js';
import { authorState } from './state.js';
import { SnapshotInputsSchema, type AuthoredGap } from './author-inputs.js';
import { imageRenderIdentity } from '../build/image.js';
import { compareImageEnvironment } from '../build/image-identity.js';
import { contentPath } from './content-store.js';
import { assertAudioDerivationMatchesMedia } from './derivation.js';

export type ProtectionRoot =
  | 'author'
  | 'active-result'
  | 'retained'
  | 'checkpoint'
  | 'derived'
  | 'provider-job'
  | 'generated'
  | 'in-progress-cleanup';

export const SNAPSHOTS_PREFIX = '.viscraft/snapshots/';
export const BUILD_RECORDS_PREFIX = '.viscraft/builds/';
export const CHECKPOINTS_PREFIX = '.viscraft/checkpoints/';

/** Ids of every checkpoint record (`.viscraft/checkpoints/<id>.json`). */
export async function readCheckpointIds(root: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(await resolveProjectPath(root, '.viscraft/checkpoints'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names
    .filter(name => /^checkpoint-[a-zA-Z0-9_-]+\.json$/.test(name))
    .map(name => name.slice(0, -'.json'.length))
    .sort();
}

export interface ClosureFile {
  /** Project-relative path. */
  path: string;
  /** Why each path is protected, e.g. `author:source`, `artifact:artifact-ab…`. */
  reasons: string[];
}

export interface ProductionClosure {
  roots: ProtectionRoot[];
  /** Protected project-relative files with reasons. */
  files: Map<string, ClosureFile>;
  /** Build id → reason it is included. */
  builds: Map<string, string>;
  /** Artifact id → reason it is required. */
  artifacts: Map<string, string>;
  /** Take id → reason it is protected. */
  takes: Map<string, string>;
  /** Current author facts that are declared but not readable (author root only). */
  authorGaps: AuthoredGap[];
}

interface ActiveResult {
  build: string;
  artifact: string;
  path: string;
  sha256: string;
  simulated: boolean;
}

async function readActiveResult(root: string): Promise<ActiveResult | null> {
  let raw: string;
  try {
    raw = await readFile(await resolveProjectPath(root, '.viscraft/result.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const value = JSON.parse(raw) as Partial<ActiveResult>;
  if (
    typeof value.build !== 'string' ||
    typeof value.artifact !== 'string' ||
    typeof value.path !== 'string' ||
    typeof value.sha256 !== 'string' ||
    typeof value.simulated !== 'boolean'
  )
    throw new Error('Active result (.viscraft/result.json) is malformed');
  return value as ActiveResult;
}

/**
 * Where a FROZEN Asset's produced bytes are: its snapshot path, else its
 * content-store entry, else `undefined` (released/absent — the media cross-check
 * is then simply unavailable). Mirrors `versions.ts`'s frozen-bytes resolution.
 */
async function frozenAssetBytes(
  root: string,
  snapshotId: string,
  relative: string,
  sha256: string,
): Promise<string | undefined> {
  for (const candidate of [`${SNAPSHOTS_PREFIX}${snapshotId}/${relative}`, contentPath(sha256)]) {
    const absolute = await resolveProjectPath(root, candidate);
    if (existsSync(absolute)) return absolute;
  }
  return undefined;
}

/** True when a Build's frozen snapshot metadata (`.project.json`) is present. */
async function snapshotMetadataExists(root: string, id: string): Promise<boolean> {
  return existsSync(await resolveProjectPath(root, `${SNAPSHOTS_PREFIX}${id}.project.json`));
}

/**
 * Expand one protection-root selection over the Build/Artifact/Take lineage.
 * Returns the included Build ids and required Artifact ids (with reasons).
 */
export async function productionClosure(
  root: string,
  project: Project,
  builds: BuildRecord[],
  roots: readonly ProtectionRoot[],
  options: { verifyDerivationMedia?: boolean; extraBuilds?: readonly string[] } = {},
): Promise<ProductionClosure> {
  const rootSet = new Set(roots);
  const buildsById = new Map(builds.map(build => [build.id, build] as const));
  const artifactsById = new Map<string, Artifact>();
  for (const build of builds)
    for (const artifact of build.artifacts)
      if (!artifactsById.has(artifact.id)) artifactsById.set(artifact.id, artifact);

  // Which Build actually PRODUCED an Artifact (prefer the non-reused producer),
  // so lineage follows the bytes rather than the last record that named them.
  const artifactProducer = new Map<string, BuildRecord>();
  for (const build of [...builds].reverse()) {
    if (build.status !== 'succeeded') continue;
    for (const operation of build.operations) {
      const artifact = build.artifacts.find(candidate => candidate.id === operation.artifact);
      if (!artifact || operation.kind !== artifact.operation) continue;
      const previous = artifactProducer.get(artifact.id);
      if (
        !previous ||
        (previous.operations.find(
          candidate => candidate.artifact === artifact.id && candidate.kind === artifact.operation,
        )?.reused &&
          !operation.reused)
      )
        artifactProducer.set(artifact.id, build);
    }
  }
  const takeOwner = new Map<string, BuildRecord>();
  for (const build of builds)
    for (const take of build.takes)
      if (!takeOwner.has(take.id)) {
        const producer = artifactProducer.get(take.artifact);
        takeOwner.set(take.id, producer?.takes.some(candidate => candidate.id === take.id) ? producer : build);
      }

  const includedBuilds = new Set<string>();
  const requiredArtifacts = new Set<string>();
  const buildReasons = new Map<string, string>();
  const artifactReasons = new Map<string, string>();
  const takeReasons = new Map<string, string>();
  let authorGaps: AuthoredGap[] = [];
  const fileReasons = new Map<string, Set<string>>();
  const addFile = (relative: string, reason: string) => {
    let set = fileReasons.get(relative);
    if (!set) fileReasons.set(relative, (set = new Set()));
    set.add(reason);
  };
  const addBuild = (id: string, reason: string) => {
    includedBuilds.add(id);
    if (!buildReasons.has(id)) buildReasons.set(id, reason);
  };
  const addArtifact = (id: string, reason: string) => {
    requiredArtifacts.add(id);
    if (!artifactReasons.has(id)) artifactReasons.set(id, reason);
  };

  const includeDerivation = async (asset: Asset, reason: string, frozenBuildId: string): Promise<boolean> => {
    const parent = asset.derivedFrom;
    if (!parent) return false;
    const build = buildsById.get(parent.build);
    const artifact = build?.artifacts.find(candidate => candidate.id === parent.artifact);
    if (
      !build ||
      build.status !== 'succeeded' ||
      !artifact ||
      artifact.sha256 !== parent.sha256 ||
      artifact.kind !== 'video' ||
      !artifact.media
    )
      throw new Error(`Asset ${asset.id} has invalid parent Artifact provenance`);
    const take = parent.take ? build.takes.find(candidate => candidate.id === parent.take) : undefined;
    if (parent.take && (!take || take.artifact !== artifact.id))
      throw new Error(`Asset ${asset.id} has invalid parent Take provenance`);
    // A frame derivation reads a PICTURE clock; a sound Take has samples, not
    // frames, so it can never be the parent of a frame selection.
    const pictureTake = take?.medium === 'picture' ? take : undefined;
    if (parent.kind === 'frame' && parent.take && !pictureTake)
      throw new Error(`Asset ${asset.id} selects a frame from a non-picture Take`);
    // The two derivation kinds share the parent Artifact/Take/sha relation; only
    // `frame` selects a picture frame, and only `audio` carries a stream interval.
    // An audio record never borrows `frame`, and a frame record never carries a
    // stream/timebase — each kind is validated on its own facts.
    if (parent.kind === 'frame') {
      if (parent.frame >= artifact.media.frames || (pictureTake && parent.frame >= pictureTake.frames))
        throw new Error(`Asset ${asset.id} has invalid parent frame provenance`);
    } else {
      if (
        parent.inPts < parent.startPts ||
        parent.outPts <= parent.inPts ||
        parent.timebase.numerator <= 0 ||
        parent.timebase.denominator <= 0
      )
        throw new Error(`Asset ${asset.id} has invalid parent audio provenance`);
      // An audio derivation can only come from a medium that really carries an
      // audio stream; a parent with no audio at all proves the record is edited.
      if (!artifact.media.audio)
        throw new Error(`Asset ${asset.id} records an audio derivation from a parent medium with no audio stream`);
      // The DELIVERY boundary re-derives the record against the real parent stream
      // and the produced file, exactly as the Build does — otherwise a hand-edited
      // (but internally consistent) record is carried by an export/archive that
      // never rebuilds, misleading the next agent. Read-only diagnostics
      // (status/usage/clean) do not set this: they never probe media.
      if (options.verifyDerivationMedia) {
        const producedFile = frozenBuildId
          ? await frozenAssetBytes(root, frozenBuildId, asset.path, asset.sha256)
          : await resolveProjectPath(root, asset.path);
        await assertAudioDerivationMatchesMedia(
          await resolveProjectPath(root, artifact.path),
          producedFile,
          artifact,
          parent,
          asset.id,
        );
      }
    }
    if (!asset.simulated && (artifact.simulated || take?.simulated))
      throw new Error(`Asset ${asset.id} cannot discard simulated parent provenance`);
    const added = !includedBuilds.has(build.id) || !requiredArtifacts.has(artifact.id);
    addBuild(build.id, reason);
    addArtifact(artifact.id, reason);
    if (parent.take) takeReasons.set(parent.take, reason);
    void frozenBuildId;
    return added;
  };

  // --- root: active result -------------------------------------------------
  if (rootSet.has('active-result')) {
    // Each still-registered image target keeps its OWN newest successful result.
    // A still never writes `.viscraft/result.json` (that is the film's active
    // result), so without this the target's current artifact/snapshot would be
    // reclaimable and a default Portable export would carry the design source
    // but not the still the receiver was just handed. Only the NEWEST succeeded
    // Build per target is a root: older image versions stay explicit `--include`
    // history, exactly like an older film version.
    for (const target of project.imageTargets) {
      const candidates = builds
        .filter(
          build =>
            build.status === 'succeeded' && !build.preview && build.target === target.id && build.result !== undefined,
        )
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
      if (candidates.length === 0) continue;
      // The CURRENT result is the one `renderImage` would reuse: the newest
      // recorded operation whose key still equals the key the current author
      // bytes produce (a revert can make an OLDER Build current again). When no
      // key matches — the document/resources were edited, or cannot be read —
      // the newest still is the last good result and stays protected until a
      // successful re-render replaces it.
      // The current result is the one `renderImage` would REUSE: same author key
      // AND the recorded environment still matches the machine observed now (the
      // renderer's own `compareImageEnvironment` verdict). A matching key alone
      // cannot make a result current.
      const identity = await imageRenderIdentity(root, target.id).catch(() => null);
      const reuses = (build: (typeof candidates)[number]): boolean =>
        identity !== null &&
        build.operations.some(operation => operation.kind === 'render-image' && operation.key === identity.key) &&
        compareImageEnvironment(build.environment, {
          facts: identity.environment,
          verified: identity.environmentVerified,
        }) === 'match';
      const latest = candidates.find(reuses) ?? candidates[0];
      if (!latest.result) continue;
      const artifact = latest.artifacts.find(
        candidate => candidate.id === latest.result!.artifact && candidate.kind === 'image',
      );
      if (!artifact) continue;
      addBuild(latest.id, 'image-result');
      addArtifact(artifact.id, 'image-result');
    }
    // Each registered SOUND target keeps its OWN newest succeeded programme. A
    // sound Build never writes the film's `result.json` (that pointer belongs to
    // the composed movie), so without this root the newest programme, its Takes
    // and their Sources would look unreferenced to clean/export/versions.
    for (const target of project.soundTargets) {
      const latest = builds
        .filter(
          build =>
            build.status === 'succeeded' &&
            !build.preview &&
            build.medium === 'sound' &&
            build.target === target.id &&
            build.result !== undefined,
        )
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
      if (!latest?.result) continue;
      const artifact = latest.artifacts.find(
        candidate => candidate.id === latest.result!.artifact && candidate.kind === 'audio',
      );
      if (!artifact) continue;
      addBuild(latest.id, 'sound-result');
      addArtifact(artifact.id, 'sound-result');
      for (const take of latest.takes) addArtifact(take.artifact, 'sound-take');
    }
    const active = await readActiveResult(root);
    if (active) {
      const build = buildsById.get(active.build);
      if (!build) throw new Error(`Active result references unknown Build ${active.build}`);
      if (build.status !== 'succeeded')
        throw new Error(`Active result Build ${build.id} did not succeed (status: ${build.status})`);
      if (!build.result || build.result.artifact !== active.artifact)
        throw new Error('Active result does not match the recorded Build result');
      const artifact = build.artifacts.find(candidate => candidate.id === active.artifact);
      if (!artifact) throw new Error(`Active result Artifact ${active.artifact} is not declared by Build ${build.id}`);
      if (artifact.path !== active.path || artifact.sha256 !== active.sha256)
        throw new Error('Active result does not match the recorded Artifact');
      if (artifact.simulated !== active.simulated || build.result.simulated !== active.simulated)
        throw new Error('Active result provenance does not match the recorded Artifact/Build');
      addBuild(build.id, 'active-result');
      addArtifact(artifact.id, 'active-result');
    }
  }

  // --- root: retained / checkpoint / generated ------------------------------
  if (rootSet.has('retained')) {
    for (const build of builds) {
      if (!build.retained) continue;
      addBuild(build.id, 'retained');
      if (build.result) addArtifact(build.result.artifact, 'retained');
      for (const take of build.takes) addArtifact(take.artifact, 'retained');
    }
  }
  if (rootSet.has('checkpoint')) {
    // A checkpoint is a frozen author state (no Build): its record, frozen
    // metadata and every frozen file stay protected; frozen Asset derivations
    // keep their parent Artifacts.
    for (const checkpoint of await readCheckpointIds(root)) {
      addFile(`${CHECKPOINTS_PREFIX}${checkpoint}.json`, `checkpoint:${checkpoint}`);
      addFile(`${SNAPSHOTS_PREFIX}${checkpoint}.project.json`, `checkpoint:${checkpoint}`);
      addFile(`${SNAPSHOTS_PREFIX}${checkpoint}.inputs.json`, `checkpoint:${checkpoint}`);
      const inputs = SnapshotInputsSchema.parse(
        JSON.parse(
          await readFile(await resolveProjectPath(root, `${SNAPSHOTS_PREFIX}${checkpoint}.inputs.json`), 'utf8'),
        ),
      );
      for (const relative of Object.keys(inputs.files))
        addFile(`${SNAPSHOTS_PREFIX}${checkpoint}/${relative}`, `checkpoint:${checkpoint}`);
      const frozen = ProjectSchema.parse(
        JSON.parse(
          await readFile(await resolveProjectPath(root, `${SNAPSHOTS_PREFIX}${checkpoint}.project.json`), 'utf8'),
        ),
      );
      for (const asset of frozen.assets) await includeDerivation(asset, 'checkpoint', checkpoint);
    }
  }
  if (rootSet.has('generated')) {
    // Protect every non-simulated generated Artifact by its OWN provenance, not
    // by the Build's overall status: a Build that failed at a later step still
    // holds a real, paid-for generated result that a plain cache cleanup must
    // never free. The Build is added only when it is a succeeded version or its
    // frozen snapshot metadata is actually present; a failed Build with no
    // snapshot is intentionally NOT added, so the snapshot pass below can never
    // be asked to read a file that does not exist.
    for (const build of builds) {
      for (const artifact of build.artifacts) {
        const generated = artifact.generation ?? artifact.imageGeneration;
        if (!generated || artifact.simulated) continue;
        addArtifact(artifact.id, 'generated');
        if (build.status === 'succeeded' || (await snapshotMetadataExists(root, build.id)))
          addBuild(build.id, 'generated');
      }
    }
  }

  // --- root: author (selected Takes of the current project) ------------------
  if (rootSet.has('author')) {
    const facts = await authorState(root, project);
    for (const relative of facts.files.keys()) addFile(relative, 'author');
    authorGaps = facts.unavailable;
    for (const placement of [...(project.composition?.placements ?? []), ...(project.composition?.layers ?? [])]) {
      if (!placement.take) continue;
      const owner = takeOwner.get(placement.take);
      if (!owner)
        throw new Error(
          `Selected Take ${placement.take} has no Build record to protect; the selection cannot be retained`,
        );
      const take = owner.takes.find(candidate => candidate.id === placement.take)!;
      addBuild(owner.id, 'author-take');
      addArtifact(take.artifact, 'author-take');
      takeReasons.set(placement.take, 'author-take');
    }
    // The active Build's explicit candidates stay selectable.
    const active = await readActiveResult(root);
    if (active) {
      const build = buildsById.get(active.build);
      if (build) for (const take of build.takes) addArtifact(take.artifact, 'candidate');
    }
  }

  // --- root: derived (parent artifacts of authored Assets, recursive) --------
  if (rootSet.has('author') || rootSet.has('derived')) {
    for (const asset of project.assets) await includeDerivation(asset, 'derived', '');
  }

  // --- seed: explicitly requested additional accepted versions (H3) ----------
  // The delivery boundary resolves the caller's explicit Build selection first
  // (unknown/non-succeeded/checkpoint ids are refused there) and hands the ids
  // here so they enter the SAME traversal as a starting point. Each selected
  // Build, every Artifact it declares (result, Takes, declared artifacts), and —
  // through the loop below — every Artifact input, its real producer and every
  // frozen Asset's frame/audio derivation parent are then expanded by the one
  // implementation. No second closure and no post-traversal set union.
  if (options.extraBuilds !== undefined) {
    for (const buildId of options.extraBuilds) {
      const build = buildsById.get(buildId);
      if (!build) throw new Error(`Extra version ${buildId} has no Build record to protect`);
      if (build.status !== 'succeeded')
        throw new Error(`Extra version ${buildId} is not a succeeded Build and cannot be carried`);
      addBuild(build.id, 'extra-version');
      if (build.result) addArtifact(build.result.artifact, 'extra-version');
      for (const take of build.takes) {
        addArtifact(take.artifact, 'extra-version');
        if (!takeReasons.has(take.id)) takeReasons.set(take.id, 'extra-version');
      }
      for (const artifact of build.artifacts) addArtifact(artifact.id, 'extra-version');
    }
  }

  // --- expand the lineage to every input, snapshot and frozen derivation -----
  const inspectedBuilds = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const artifactId of [...requiredArtifacts]) {
      const artifact = artifactsById.get(artifactId);
      if (!artifact) throw new Error(`Build lineage references missing Artifact ${artifactId}`);
      addFile(artifact.path, `artifact:${artifact.id}`);
      const producer = artifactProducer.get(artifactId);
      if (producer && !includedBuilds.has(producer.id)) {
        addBuild(producer.id, 'producer');
        changed = true;
      }
      const operation = producer?.operations.find(
        candidate => candidate.artifact === artifactId && candidate.kind === artifact.operation,
      );
      for (const input of [...artifact.inputs, ...(operation?.inputs ?? [])]) {
        if (!input.startsWith('artifact-') || requiredArtifacts.has(input)) continue;
        if (!artifactsById.has(input)) throw new Error(`Build lineage references missing Artifact ${input}`);
        addArtifact(input, 'input');
        const owner =
          artifactProducer.get(input) ?? builds.find(candidate => candidate.artifacts.some(a => a.id === input));
        if (owner) addBuild(owner.id, 'input');
        changed = true;
      }
    }
    for (const buildId of [...includedBuilds]) {
      if (inspectedBuilds.has(buildId)) continue;
      inspectedBuilds.add(buildId);
      const build = buildsById.get(buildId)!;
      addFile(`${BUILD_RECORDS_PREFIX}${build.id}.json`, `build-record:${build.id}`);
      const snapshot = `${SNAPSHOTS_PREFIX}${build.id}.project.json`;
      // A Build can be protected even when it has no frozen snapshot (e.g. a
      // failed Build that produced a real generated Artifact protected by the
      // `generated` root). Its Build record stays protected, but there is no
      // snapshot to freeze-expand — reading a missing file would crash the whole
      // closure, so the snapshot pass is skipped exactly when the file is absent.
      if (!existsSync(await resolveProjectPath(root, snapshot))) continue;
      addFile(snapshot, `snapshot:${build.id}`);
      addFile(`${SNAPSHOTS_PREFIX}${build.id}.inputs.json`, `snapshot:${build.id}`);
      const frozenProject = ProjectSchema.parse(
        JSON.parse(await readFile(await resolveProjectPath(root, snapshot), 'utf8')),
      );
      for (const asset of frozenProject.assets)
        if (await includeDerivation(asset, 'frozen-derived', build.id)) changed = true;
    }
  }

  const files = new Map<string, ClosureFile>();
  for (const [path, reasons] of fileReasons) files.set(path, { path, reasons: [...reasons].sort() });
  return {
    roots: [...rootSet],
    files,
    builds: buildReasons,
    artifacts: artifactReasons,
    takes: takeReasons,
    authorGaps,
  };
}

/** True when the Artifact's file exists and hashes to its recorded sha256. */
export async function artifactAvailable(root: string, artifact: Artifact): Promise<boolean> {
  try {
    return (await hashFile(await resolveProjectPath(root, artifact.path))) === artifact.sha256;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
