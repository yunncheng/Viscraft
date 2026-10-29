import { type Project, type BuildRecord, ProjectSchema } from '../core/schema.js';
import { type AuthoredGap, authoredFileFacts, SnapshotInputsSchema } from './author-inputs.js';
import { stableHash, hashFile } from '../shared/hash.js';
import { resolveProjectPath } from '../shared/fs.js';
import { contentPath } from './content-store.js';
import { readFile } from 'node:fs/promises';

/** The production-input projection of a Project: everything except the two
 * author-facing, non-production fields. `handoff` is optional and may be absent. */
export function projectContent(project: Project): Record<string, unknown> {
  const record = project as unknown as Record<string, unknown>;
  const { revision: _revision, handoff: _handoff, ...content } = record;
  return content;
}

/**
 * The frozen-snapshot integrity hash. `unavailable` is part of the identity: a
 * snapshot that froze with a gap must never hash the same as one that did not
 * declare the file at all.
 */
export function snapshotHashOf(
  project: Project,
  files: Record<string, string>,
  unavailable: readonly AuthoredGap[],
): string {
  return stableHash({ project, files, unavailable });
}

/**
 * Declared handoff paths that NO other declaration owns. A receiver-facing
 * notice/licence is not a production input, so its bytes never change whether a
 * result is "stale"; the snapshot still freezes them (whole-author inventory) and
 * Portable still carries them. A path a Source/Asset/document also declares is a
 * real input and stays in the hash.
 */
function handoffOnlyPaths(project: Project): Set<string> {
  const production = new Set<string>();
  const add = (relative: string): void => {
    production.add(relative);
  };
  for (const asset of project.assets) add(asset.path);
  for (const document of project.imageDocuments) {
    add(document.path);
    for (const resource of document.resources) add(resource);
  }
  for (const source of project.sources) {
    if (source.kind !== 'browser' && source.kind !== 'blender') continue;
    add(source.entry);
    for (const resource of source.resources) add(resource);
    if (source.kind === 'browser' && source.output === 'picture' && source.recording) add(source.recording);
  }
  const handoff = new Set<string>();
  for (const file of project.handoff ?? []) if (!production.has(file.path)) handoff.add(file.path);
  return handoff;
}

/**
 * The "author changed the work" hash: `revision`-insensitive and
 * handoff-insensitive — both the handoff DECLARATION and the bytes of a
 * handoff-only path are excluded, because neither is a production input. The
 * snapshot hash still covers them, so integrity, revert and export stay whole.
 */
export function contentHashOf(
  project: Project,
  files: Record<string, string>,
  unavailable: readonly AuthoredGap[],
): string {
  const ignored = handoffOnlyPaths(project);
  const produced: Record<string, string> = {};
  for (const [relative, sha256] of Object.entries(files)) if (!ignored.has(relative)) produced[relative] = sha256;
  const gaps = unavailable.filter(gap => !ignored.has(gap.path));
  return stableHash({ project: projectContent(project), files: produced, unavailable: gaps });
}

/**
 * The authored facts a sound programme depends on: the target's own definition,
 * the sound Sources it executes (their parameters AND their declared bytes), and
 * the audio Assets it mixes (definition + digest). Two snapshots with equal facts
 * would produce the same programme, so a sound version whose facts differ from
 * the CURRENT author state must never be reported as current — a newer WAV does
 * not make an older, now-edited programme current.
 *
 * `null` means the target is not declared (history), never "current".
 */
export function soundTargetFacts(project: Project, targetId: string, files: Record<string, string>): string | null {
  const target = project.soundTargets.find(candidate => candidate.id === targetId);
  if (!target) return null;
  const sourceIds = [...new Set(target.audio.flatMap(clip => (clip.kind === 'source' ? [clip.source] : [])))];
  const assetIds = [...new Set(target.audio.flatMap(clip => (clip.kind === 'asset' ? [clip.asset] : [])))];
  const sourceFacts = sourceIds.map(id => {
    const source = project.sources.find(candidate => candidate.id === id);
    if (!source) return { id, missing: true as const };
    const paths =
      source.kind === 'browser' || source.kind === 'blender'
        ? [source.entry, ...source.resources].map(relative => [relative, files[relative] ?? null] as const)
        : [];
    return { id, source, paths };
  });
  const assetFacts = assetIds.map(id => {
    const asset = project.assets.find(candidate => candidate.id === id);
    if (!asset) return { id, missing: true as const };
    return { id, asset, digest: files[asset.path] ?? null };
  });
  return stableHash({ target, sourceFacts, assetFacts });
}

export interface AuthorState {
  /** Authored project-relative path → sha256 of the current bytes. */
  files: Map<string, string>;
  /** Declared authored facts whose bytes are not readable now. */
  unavailable: AuthoredGap[];
  contentHash: string;
}

/**
 * The current whole-author facts. Enumeration and per-file isolation live in ONE
 * place — `authoredFileFacts` in project/author-inputs — so a Build freeze, Status,
 * Versions and Portable can never enumerate different inputs. A missing Asset may
 * be recovered from the verified content store; a missing NON-Asset is an explicit
 * gap, and readable bytes that disagree with a declared digest stay in `files` as
 * the actual bytes while being reported.
 */
export async function authorState(root: string, project: Project): Promise<AuthorState> {
  const facts = await authoredFileFacts(project, root, {
    recover: async (_path, declaredSha256) => {
      try {
        const stored = await resolveProjectPath(root, contentPath(declaredSha256));
        return (await hashFile(stored)) === declaredSha256 ? declaredSha256 : null;
      } catch {
        return null;
      }
    },
  });
  const files = new Map(Object.entries(facts.files));
  const unavailable = [...facts.unavailable].sort((left, right) => left.path.localeCompare(right.path));
  return { files, unavailable, contentHash: contentHashOf(project, facts.files, unavailable) };
}

export type AuthoringStatus = 'unchanged' | 'changed' | 'unknown';

export interface AuthoringComparison {
  status: AuthoringStatus;
  /** The Build's frozen project + authored-file hashes, when readable. */
  frozenProject?: Project;
  frozenFiles?: Record<string, string>;
  frozenUnavailable?: AuthoredGap[];
  /** The current authored-file hashes, when they could all be read. */
  currentFiles?: Record<string, string>;
  currentUnavailable?: AuthoredGap[];
}

export interface FrozenSnapshot {
  project: Project;
  files: Record<string, string>;
  unavailable: AuthoredGap[];
}

/** Read a current snapshot only when its identity and authored-file gaps verify. */
export async function readFrozenSnapshot(root: string, id: string, expectedHash: string): Promise<FrozenSnapshot> {
  const project = ProjectSchema.parse(
    JSON.parse(await readFile(await resolveProjectPath(root, `.viscraft/snapshots/${id}.project.json`), 'utf8')),
  );
  const inputs = SnapshotInputsSchema.parse(
    JSON.parse(await readFile(await resolveProjectPath(root, `.viscraft/snapshots/${id}.inputs.json`), 'utf8')),
  );
  // Only a hash-mismatch gap may also name readable bytes, and its actual hash
  // must match them. Missing/unreadable/expansion gaps cannot claim a readable file.
  if (
    snapshotHashOf(project, inputs.files, inputs.unavailable) !== expectedHash ||
    !inputs.unavailable.every(gap =>
      gap.reason === 'hash-mismatch'
        ? inputs.files[gap.path] !== undefined && inputs.files[gap.path] === gap.actualSha256
        : inputs.files[gap.path] === undefined,
    )
  )
    throw new Error(`Snapshot ${id} does not match its recorded hash or authored-file gaps`);
  return { project, files: inputs.files, unavailable: inputs.unavailable };
}

/**
 * Compare the current author state to a Build's frozen snapshot by `contentHash`.
 * `unknown` only when the frozen metadata is absent/malformed; the current state's
 * unreadable declared files are gaps, not a false verdict of "changed" or
 * "unchanged". The frozen/current facts are returned so Status/Plan can diff them
 * without re-hashing.
 */
export async function compareAuthoring(
  root: string,
  project: Project,
  build: BuildRecord,
): Promise<AuthoringComparison> {
  let frozen: FrozenSnapshot;
  try {
    frozen = await readFrozenSnapshot(root, build.id, build.snapshotHash);
  } catch {
    return { status: 'unknown' };
  }
  const { project: frozenProject, files, unavailable } = frozen;
  let current: AuthorState;
  try {
    current = await authorState(root, project);
  } catch {
    return {
      status: 'unknown',
      frozenProject,
      frozenFiles: files,
      frozenUnavailable: unavailable,
    };
  }
  const currentFiles = Object.fromEntries(current.files);
  const status =
    contentHashOf(frozenProject, files, unavailable) === contentHashOf(project, currentFiles, current.unavailable)
      ? 'unchanged'
      : 'changed';
  return {
    status,
    frozenProject,
    frozenFiles: files,
    frozenUnavailable: unavailable,
    currentFiles,
    currentUnavailable: current.unavailable,
  };
}

/**
 * Compare the current author state to a Build's frozen snapshot by `contentHash`.
 * `unknown` when the frozen metadata is absent or an authored file cannot be
 * read — status must not claim a verdict it could not verify.
 */
export async function authoringStatus(root: string, project: Project, build: BuildRecord): Promise<AuthoringStatus> {
  return (await compareAuthoring(root, project, build)).status;
}
