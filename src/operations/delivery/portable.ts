import { RUNTIME_DIR, isCredentialFile, assertAuthoredPath } from '../../project/authored-path.js';
import { z } from 'zod';
import {
  Id,
  RelativePath,
  type WorldRef,
  type OutputSettings,
  type World,
  type Project,
  type Asset,
  type PlayableRecording,
  PlayableRecordingSchema,
  requireComposition,
  type Artifact,
  BuildRecordSchema,
} from '../../core/schema.js';
import {
  HEX,
  type PortableScope,
  type PortableProvenance,
  PortableManifestSchema,
  PROVIDER_MEDIA_PREFIX,
  type PortableSnapshotAsset,
  SNAPSHOTS_PREFIX,
  contentPath,
  CONTENT_PREFIX,
  type PortableManifest,
} from './portable-contract.js';
import { lstat, realpath, readFile, readdir, mkdir, copyFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { stableHash, hashFile } from '../../shared/hash.js';
import { resolveSourceBindings, resolveWorldBinding, validateProject } from '../../project/project.js';
import {
  OUTPUT_DIR,
  ensureOutputDir,
  walkRegularFiles,
  pendingDeliveryAcceptable,
  assertReplaceableDefault,
  defaultDeliveryPath,
  type DeliveryRecord,
  outputRecordName,
  markDeliveryPending,
  replaceStagedDirectory,
  writeDeliveryRecord,
  clearDeliveryPending,
} from '../../project/output.js';
import { createHash, randomUUID } from 'node:crypto';
import { resolvedCredentialValues } from '../../config/credentials.js';
import { redactCredentials, redact } from '../../shared/process.js';
import { resolveProjectPath } from '../../shared/fs.js';
import { authorState, snapshotHashOf } from '../../project/state.js';
import { loadRecording } from '../../backends/playable/recording.js';
import { checkHandoff, renderAttribution, renderFactPage } from './handoff.js';
import { readBuilds } from '../../project/build-records.js';
import { readCheckpointIds, productionClosure } from '../../project/closure.js';
import { SnapshotInputsSchema } from '../../project/author-inputs.js';

const ARTIFACTS_PREFIX = `${RUNTIME_DIR}/artifacts/`;

const PORTABLE_MANIFEST = `${RUNTIME_DIR}/portable-manifest.json`;

/** Fixed default destination name under `output/` for an editable project export. */
const EXPORT_NAME = 'project';

const ActiveResultSchema = z
  .object({ build: Id, artifact: Id, simulated: z.boolean(), path: RelativePath, sha256: z.string().regex(HEX) })
  .strict();

export interface PortableExport {
  /** Absolute path of the newly created project directory. */
  path: string;
  /** Number of verified content files packaged (excludes the manifest itself). */
  files: number;
  /** True when any packaged source/asset/artifact/result carries simulated provenance. */
  simulated: boolean;
  /** Non-blocking handoff warnings (e.g. a local absolute path in a note). */
  warnings: string[];
  /** The persisted scope contract (the same object written into the manifest). */
  scope: PortableScope;
  /** Number of carried provider originals (== `scope.counts.originals`). */
  originals: number;
}

type Provenance = PortableProvenance;

interface Entry {
  /** The file to copy, or (for a rendered page) the exact bytes to write. */
  source: string | Buffer;
  sha256: string;
  bytes: number;
  provenance: Provenance;
}

/**
 * True when a provenance carries redistribution rights facts. `asset` always
 * does; a provider `original` does only when a matching rights-bearing Asset owns
 * its exact bytes (it then records both `rightsAssetId` and `rights`). Every other
 * role (source/handoff/build/...) records no rights.
 */
function provenanceRights(provenance: Provenance): boolean {
  return provenance.kind === 'asset' || (provenance.kind === 'original' && provenance.rights !== undefined);
}

/**
 * Combine the provenance of two packaged files with identical bytes. Rights are
 * never lost: when the existing record carries rights facts and the incoming role
 * does not (an Asset that is also a handoff helper / Source resource), the
 * rights-bearing provenance is kept. Otherwise the incoming record wins, matching
 * the previous last-write-wins behaviour for rights-less roles.
 */
function mergeProvenance(existing: Provenance, incoming: Provenance): Provenance {
  return provenanceRights(existing) && !provenanceRights(incoming) ? existing : incoming;
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

/** True when `child` is strictly inside `parent` (not equal, not an ancestor). */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Narrow, basename-based credential denylist. Listing a file as an explicit
 * resource (or freezing it into a snapshot) never authorizes exporting a known
 * secret. Deliberately matches only exact credential names — not the generic
 * word "secret" — so ordinary art names are unaffected.
 */
/** Sort + dedupe project-relative paths so file-set comparison is order-independent. */
function dedupeSorted(paths: string[]): string[] {
  return [...new Set(paths)].sort((a, b) => a.localeCompare(b));
}

/** The frozen signature fields of a recorded-replay source (the source `id` is excluded). */
interface PlayableSourceSignature {
  entry: string;
  resources: string[];
  bindings: string[];
  params: Record<string, unknown>;
  seed: number;
  world?: WorldRef;
  bindingOverrides?: Record<string, string>;
}

/**
 * Derive the playable source signature exactly as `playable.ts` does (the source
 * `id` is deliberately excluded) so the frozen recording key can be re-checked
 * here without importing the browser-driving `captureReplay` path.
 */
function recordingSourceKey(
  source: PlayableSourceSignature,
  frames: number,
  output: OutputSettings,
  world?: World,
): string {
  return stableHash({
    entry: source.entry,
    resources: source.resources,
    bindings: source.bindings,
    params: source.params,
    seed: source.seed,
    frames,
    output,
    ...(world ? { world } : {}),
    ...(source.bindingOverrides ? { bindingOverrides: source.bindingOverrides } : {}),
  });
}

/**
 * Resolve a playable source's declared binding names to the Assets they bind,
 * through the project's own `bindings` map (name → Asset id) and `assets` list.
 * A binding name that does not resolve to a declared Asset is a dangling
 * identity: the recording could otherwise claim a binding whose bytes are in
 * fact an arbitrary unrelated file.
 */
function resolveBoundAssets(project: Project, source: PlayableSourceSignature): Asset[] {
  return resolveSourceBindings(project, source).map(({ asset }) => asset);
}

/** The exact authored file set a playable recording must freeze: entry + resources + bound Asset paths. */
function recordingFileSet(source: { entry: string; resources: string[] }, boundAssets: Asset[]): string[] {
  return dedupeSorted([source.entry, ...source.resources, ...boundAssets.map(asset => asset.path)]);
}

/**
 * Prove a playable recording faithfully describes the given source before any
 * of its recorded dependencies are packaged.
 *
 * The recording is authored material and its `source.files` list is untrusted:
 * a tampered recording could list arbitrary extra paths (a credentials file,
 * another project's secret, …) and have them copied into the portable package
 * under a generic source provenance. So the expected file set is derived from
 * the *current* source state — entry, resources, and the paths of the source's
 * declared bindings resolved through the project's own `bindings`/`assets` —
 * and the recording must freeze exactly that set: no missing entry, no extra
 * file and no duplicate. The frozen signature fields (entry/resources/
 * bindings/params/seed/frames/output) must also equal the source. Returns the
 * bound Assets, the exact recorded paths and their recorded hashes.
 */
function verifyPlayableRecording(
  project: Project,
  source: PlayableSourceSignature & { frames: number },
  output: OutputSettings,
  recording: PlayableRecording,
  label: string,
): { boundAssets: Asset[]; recordedPaths: string[]; recordedSha: Map<string, string> } {
  const boundAssets = resolveBoundAssets(project, source);
  const world = resolveWorldBinding(project, source.world, source);
  if (stableHash(recording.source.world ?? null) !== stableHash(world ?? null))
    throw new Error(`${label}: recording World does not match the Project World binding`);
  if (recording.frames !== source.frames)
    throw new Error(
      `${label}: recording holds ${recording.frames} frames but the playable source declares ${source.frames}`,
    );
  if (recording.source.entry !== source.entry)
    throw new Error(`${label}: recording entry does not match the playable source`);
  if (stableHash(recording.source.resources) !== stableHash(source.resources))
    throw new Error(`${label}: recording resources do not match the playable source`);
  if (stableHash(recording.source.bindings) !== stableHash(source.bindings))
    throw new Error(`${label}: recording bindings do not match the playable source`);
  if (stableHash(recording.source.bindingOverrides ?? null) !== stableHash(source.bindingOverrides ?? null))
    throw new Error(`${label}: recording binding overrides do not match the playable source`);
  if (stableHash(recording.source.params) !== stableHash(source.params))
    throw new Error(`${label}: recording params do not match the playable source`);
  if (recording.source.seed !== source.seed)
    throw new Error(`${label}: recording seed does not match the playable source`);
  if (stableHash(recording.output) !== stableHash(output))
    throw new Error(`${label}: recording output settings do not match the playable source`);
  if (recording.source.key !== recordingSourceKey(source, source.frames, output, world))
    throw new Error(`${label}: recording source signature does not match the playable source`);

  const recordedPaths = recording.source.files.map(file => file.path);
  const uniqueRecorded = dedupeSorted(recordedPaths);
  if (uniqueRecorded.length !== recordedPaths.length)
    throw new Error(`${label}: recording lists a duplicate source file`);
  const expectedPaths = recordingFileSet(source, boundAssets);
  if (
    expectedPaths.length !== uniqueRecorded.length ||
    expectedPaths.some((relative, index) => relative !== uniqueRecorded[index])
  ) {
    throw new Error(`${label}: recording does not freeze exactly the playable source entry/resources/bindings`);
  }
  const recordedSha = new Map(recording.source.files.map(file => [file.path, file.sha256] as const));
  return { boundAssets, recordedPaths: uniqueRecorded, recordedSha };
}

/**
 * Validate the export destination: it must not exist yet and its parent must
 * exist and be a directory. It is either outside the project root (and never an
 * ancestor of it), or a NEW direct child of the Runtime-owned `<root>/output/`
 * directory (created on demand, never a link). Staging + rename stays on the
 * destination's filesystem; nothing under `output/` is authored content, so a
 * destination there can never enter its own export.
 */
export async function resolveDestination(
  destination: string,
  rootReal: string,
  options: { allowExisting?: boolean } = {},
): Promise<{ destReal: string; parentReal: string }> {
  if (typeof destination !== 'string' || destination.trim() === '' || destination.includes('\0')) {
    throw new Error('Export destination must be a non-empty filesystem path');
  }
  const destAbs = path.resolve(destination);
  const name = path.basename(destAbs);
  if (!name || name === '.' || name === '..') throw new Error('Export destination has an invalid final path segment');
  const parent = path.dirname(destAbs);
  const outputDir = path.join(rootReal, OUTPUT_DIR);
  if (path.basename(parent) === OUTPUT_DIR) {
    let grandReal: string | undefined;
    try {
      grandReal = await realpath(path.dirname(parent));
    } catch {
      grandReal = undefined;
    }
    if (grandReal === rootReal) await ensureOutputDir(rootReal);
  }
  let parentReal: string;
  try {
    parentReal = await realpath(parent);
  } catch {
    throw new Error(`Export destination parent does not exist: ${parent}`);
  }
  if (!(await lstat(parentReal)).isDirectory()) throw new Error('Export destination parent is not a directory');
  const destReal = path.join(parentReal, name);
  // A user destination is a direct child of output/; Runtime staging (export
  // inside a delivery/archive) lives under a dot-named child of output/.
  const underOutput = isInside(outputDir, destReal);
  const firstSegment = underOutput ? path.relative(outputDir, destReal).split(path.sep)[0]! : '';
  const inOutput =
    underOutput &&
    (parentReal === outputDir || firstSegment.startsWith('.')) &&
    !(await lstat(outputDir)).isSymbolicLink();
  if (!inOutput && (destReal === rootReal || isInside(rootReal, destReal) || isInside(destReal, rootReal))) {
    throw new Error(
      `Export destination must be outside the project root (and not an ancestor of it) or a new direct child of ${OUTPUT_DIR}/`,
    );
  }
  if (!options.allowExisting && (await pathExists(destReal)))
    throw new Error(`Export destination already exists: ${destReal}`);
  return { destReal, parentReal };
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** One report-only finding from the delivery-copy scan. */
export interface DeliveryCopyFinding {
  /** Bundle-relative path of the scanned text file. */
  path: string;
  kind: 'absolute-path' | 'secret';
  /** Human-readable detail; a secret is never echoed (the text is redacted). */
  detail: string;
}

/**
 * Report-only scan of the handoff text that enters a delivery bundle.
 *
 * Uses credential-only redaction plus resolved credential values. Process-output
 * redaction also masks all remote URLs; a public source or license URL alone is
 * not evidence of a credential. Findings are
 * informational — the caller records them in the manifest and command output
 * and the delivery still completes.
 */
export function scanDeliveryCopy(
  files: ReadonlyArray<{ path: string; text: string }>,
  localPaths: readonly string[],
): DeliveryCopyFinding[] {
  const secrets = [...resolvedCredentialValues()].filter(value => value.length >= 8);
  const findings: DeliveryCopyFinding[] = [];
  for (const file of files) {
    for (const local of localPaths)
      if (file.text.includes(local))
        findings.push({
          path: file.path,
          kind: 'absolute-path',
          detail: `mentions the local absolute path ${local}; the receiver will not have it`,
        });
    const resolved = secrets.find(secret => file.text.includes(secret));
    if (resolved) findings.push({ path: file.path, kind: 'secret', detail: 'contains a resolved credential value' });
    else if (redactCredentials(file.text) !== file.text)
      findings.push({ path: file.path, kind: 'secret', detail: 'contains a credential-looking assignment' });
  }
  return findings;
}

/**
 * Read a file once, validate *those exact bytes*, and return the parsed value
 * together with the hash of the validated bytes. `null` means the file does not
 * exist. Callers pass the returned hash as the expected content hash so the
 * packaged/staged bytes are provably the ones that passed validation — there is
 * no window in which a re-read could swap in different content.
 */
async function readValidatedOptional<T>(
  file: string,
  parse: (value: unknown) => T,
  label: string,
): Promise<{ value: T; sha256: string } | null> {
  let raw: Buffer;
  try {
    raw = await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let value: T;
  try {
    value = parse(JSON.parse(raw.toString('utf8')));
  } catch (error) {
    throw new Error(`${label} is invalid: ${redact(error instanceof Error ? error.message : String(error))}`);
  }
  return { value, sha256: sha256(raw) };
}

async function readValidated<T>(
  file: string,
  parse: (value: unknown) => T,
  label: string,
): Promise<{ value: T; sha256: string }> {
  const result = await readValidatedOptional(file, parse, label);
  if (!result) throw new Error(`${label} is missing`);
  return result;
}

/**
 * Verify an existing portable export DIRECTORY against its own manifest, as the
 * complete member check delivery replace protection requires. It proves every
 * listed file is present and a regular file (never a symlink) with the recorded
 * size and hash, that each `snapshotAssets` logical reference resolves to a
 * content blob of the recorded hash, and that the actual file set equals the
 * manifest allowlist plus the manifest itself. This is the same allowlist the
 * export staged, not a second content authority. Throws an `altered:`-prefixed
 * error on any mismatch so the replace refusal can carry the reason.
 */
export async function verifyPortableExport(projectDir: string): Promise<{ files: number }> {
  const manifestAbs = path.join(projectDir, ...PORTABLE_MANIFEST.split('/'));
  const manifest = PortableManifestSchema.parse(JSON.parse(await readFile(manifestAbs, 'utf8')));
  const expected = new Set<string>([PORTABLE_MANIFEST]);
  for (const file of manifest.files) {
    expected.add(file.path);
    const absolute = path.join(projectDir, ...file.path.split('/'));
    const info = await lstat(absolute).catch(() => null);
    if (!info) throw new Error(`altered: ${file.path} is missing`);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`altered: ${file.path} is not a regular file`);
    if (info.size !== file.bytes) throw new Error(`altered: ${file.path} size changed`);
    if ((await hashFile(absolute)) !== file.sha256) throw new Error(`altered: ${file.path} hash changed`);
  }
  for (const asset of manifest.snapshotAssets) {
    const blob = path.join(projectDir, ...asset.content.split('/'));
    if ((await hashFile(blob).catch(() => null)) !== asset.sha256)
      throw new Error(`altered: frozen Asset blob ${asset.content} hash changed`);
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

/** The recorded provider-original hash of a generated Artifact/Asset, if any. */
function originalSha256(owner: {
  generation?: { originalSha256: string };
  imageGeneration?: { outputSha256: string };
}): string | undefined {
  return owner.generation?.originalSha256 ?? owner.imageGeneration?.outputSha256;
}

/**
 * Index every regular file under the protected provider-media area by its SHA-256.
 *
 * The provider adapters name retained originals deterministically per request,
 * but the portable format deliberately does NOT depend on that naming: the ONLY
 * authority is the hash recorded on the produced Artifact/Asset. A symlinked
 * entry, a credential-looking name or a non-regular file is skipped rather than
 * packaged; a hash is mapped once (sorted order, so the result is deterministic).
 */
async function providerOriginalIndex(root: string): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  const dirRel = PROVIDER_MEDIA_PREFIX.slice(0, -1);
  let names: string[];
  try {
    names = await readdir(await resolveProjectPath(root, dirRel));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return index;
    throw error;
  }
  for (const name of [...names].sort()) {
    if (name === '.' || name === '..' || name.includes('/') || name.includes('\\') || isCredentialFile(name)) continue;
    const relative = `${PROVIDER_MEDIA_PREFIX}${name}`;
    const absolute = await resolveProjectPath(root, relative);
    const info = await lstat(absolute).catch(() => null);
    if (!info || !info.isFile() || info.isSymbolicLink()) continue;
    const sha256 = await hashFile(absolute);
    if (!index.has(sha256)) index.set(sha256, relative);
  }
  return index;
}

/**
 * The declared owners the SELECTED production actually consumes: the Builds
 * reached by the production closure (each Build's target and the Sources/Assets
 * its Takes name), the Sources/Assets/clips the current composition places or
 * mixes, and the handoff files the package itself must carry. An unrelated
 * declared Source or image Target is not marked consumed merely because it is
 * declared, so its freeze-time gap never blocks an otherwise complete delivery.
 */
function consumedAuthorOwners(
  project: Project,
  selectedBuilds: readonly {
    medium?: string;
    target?: string;
    takes: readonly { source?: string; asset?: string }[];
  }[],
): Set<string> {
  const used = new Set<string>();
  const composition = project.composition;
  for (const placement of [...(composition?.placements ?? []), ...(composition?.layers ?? [])]) {
    if (placement.source) used.add(`source:${placement.source}`);
    if (placement.asset) used.add(`asset:${placement.asset}`);
  }
  for (const clip of composition?.audio ?? []) {
    if (clip.kind === 'source') used.add(`source:${clip.source}`);
    else used.add(`asset:${clip.asset}`);
  }
  const selectedTargets = new Set<string>();
  for (const build of selectedBuilds) {
    // Only a PICTURE Build names an image target; a sound programme never makes
    // an image document consumed, even if an id were reused.
    if (build.medium !== 'sound' && build.target !== undefined) selectedTargets.add(build.target);
    for (const take of build.takes) {
      if (take.source) used.add(`source:${take.source}`);
      if (take.asset) used.add(`asset:${take.asset}`);
    }
  }
  for (const target of project.imageTargets)
    if (selectedTargets.has(target.id)) used.add(`image-document:${target.document}`);
  // Handoff files are declarative receiver-facing bytes: the package must carry
  // them, so their absence is never an acceptable "unconsumed" gap.
  for (const file of project.handoff ?? []) used.add(`handoff:${file.role}`);
  return used;
}

export async function exportProject(
  root: string,
  destination?: string,
  options: {
    allowNonRedistributable?: boolean;
    /**
     * Carry the required local provider ORIGINALS for the current edit closure's
     * generated media. Default ON. An explicit `false` scope means a
     * missing original never blocks shipping the movie alone.
     */
    includeOriginals?: boolean;
    /**
     * Explicit, default-off restricted scope: record a required-but-missing
     * original as a gap in `scope.missing` instead of failing. It is a RECORDED
     * gap, never a silent substitution with the normalized copy, and it does not
     * create a second package name.
     */
    allowMissingOriginals?: boolean;
    /**
     * Explicit, default-off restricted AUTHOR scope: carry a Project whose
     * declared authored facts include UNCONSUMED gaps, recording each one instead
     * of failing. A gap that the selected production closure needs is always
     * refused; the option never turns an incomplete Result into a complete one.
     */
    allowIncompleteAuthored?: boolean;
    /**
     * Explicitly carry additional accepted versions by STABLE ID (never by
     * scanning time or filenames). Each entry is either a succeeded Build id or
     * the literal `'retained'` (every Build carrying `retained`). The resolved
     * ids seed the SAME production-closure traversal, so each entry's transitive
     * dependencies (Artifact inputs, real producers, frozen frame/audio
     * derivation parents) are carried and hash-verified exactly as the active
     * result's lineage is. An unknown id or a non-succeeded Build is a loud
     * failure. Only named succeeded Builds can be exported; checkpoint ids are refused. The resolved Build ids are recorded in
     * `scope.requestedVersions`.
     */
    extraVersions?: string[];
  } = {},
): Promise<PortableExport> {
  // Redistribution checks are strict by default. Only an explicit
  // opt-in relaxes it, and only for a private package the caller owns; the
  // rights of every included Asset are still recorded verbatim in the manifest.
  const allowNonRedistributable = options.allowNonRedistributable === true;
  const includeOriginals = options.includeOriginals !== false;
  const allowMissingOriginals = options.allowMissingOriginals === true;
  const allowIncompleteAuthored = options.allowIncompleteAuthored === true;
  const rootReal = await realpath(root);
  // Fixed default name inside output/. A repeat export replaces the previous
  // default only when it is a recorded Runtime delivery whose recorded manifest
  // is unchanged AND whose ACTUAL members still match that manifest; otherwise
  // it is refused (an author's own or hand-edited file is never lost).
  let replaceDefault = false;
  const currentManifestHash = (): Promise<string | null> =>
    hashFile(path.join(destination as string, RUNTIME_DIR, 'portable-manifest.json')).catch(() => null);
  const proveMembersUnmodified = async (): Promise<void> => {
    await verifyPortableExport(destination as string);
  };
  // Full replace-protection check: re-comparing the recorded manifest hash is
  // what catches a coherent replacement swapped in during production, so it runs
  // at the gate AND immediately before the swap. A published-but-unrecorded entry
  // from an interrupted earlier export (identified by our own recovery marker) is
  // accepted as ours so re-exporting to the same default succeeds after a crash.
  const assertReplaceable = async (): Promise<void> => {
    if (await pendingDeliveryAcceptable(rootReal, EXPORT_NAME, 'export', currentManifestHash)) {
      await proveMembersUnmodified();
      return;
    }
    await assertReplaceableDefault(rootReal, EXPORT_NAME, 'export', currentManifestHash, proveMembersUnmodified);
  };
  if (destination === undefined) {
    destination = await defaultDeliveryPath(rootReal, EXPORT_NAME);
    replaceDefault = await pathExists(destination);
    if (replaceDefault) await assertReplaceable();
  }
  const { destReal, parentReal } = await resolveDestination(destination, rootReal, { allowExisting: replaceDefault });

  // Current authored project: read the raw bytes once, validate *those bytes*,
  // and pin the packaged project.json to the exact bytes that passed validation.
  const projectAbs = await resolveProjectPath(root, 'project.json');
  const projectFile = await readValidated(projectAbs, value => validateProject(value), 'Project project.json');
  const project: Project = projectFile.value;

  // The whole declared author inventory, with explicit gaps. This is what makes
  // an unrelated missing file a disclosed fact instead of a silent smaller
  // Project, and what keeps a consumed gap from ever being exported.
  const authorFacts = await authorState(rootReal, project);
  const authoredGaps = authorFacts.unavailable;
  const gapByPath = new Map(authoredGaps.map(gap => [gap.path, gap] as const));

  const entries = new Map<string, Entry>();
  const addEntry = async (
    destRel: string,
    source: string,
    provenance: Provenance,
    expected?: string,
  ): Promise<void> => {
    RelativePath.parse(destRel);
    const sha256 = await hashFile(source);
    if (expected !== undefined && expected !== sha256) {
      throw new Error(`Content hash mismatch for ${destRel}: expected ${expected}, found ${sha256}`);
    }
    const existing = entries.get(destRel);
    if (existing && existing.sha256 !== sha256) throw new Error(`Conflicting packaged files at ${destRel}`);
    // A single physical path can carry SEVERAL roles (an Asset that is also a
    // handoff helper, a Source resource, ...). Never let a later, rights-less role
    // overwrite a rights-bearing one: the rights of every included Asset stay
    // recorded verbatim, so a non-redistributable Asset that is also a helper does
    // not silently become redistributable in the manifest.
    const merged = existing ? mergeProvenance(existing.provenance, provenance) : provenance;
    entries.set(destRel, { source, sha256, bytes: (await lstat(source)).size, provenance: merged });
  };
  /** An authored entry that may be a DISCLOSED gap (never fabricated, never carried). */
  const addAuthored = async (
    destRel: string,
    source: string,
    provenance: Provenance,
    expected?: string,
  ): Promise<void> => {
    if (gapByPath.has(destRel)) return;
    await addEntry(destRel, source, provenance, expected);
  };

  await addEntry('project.json', projectAbs, { kind: 'project' }, projectFile.sha256);

  // --- Frozen Asset byte deduplication -------------------------------------
  // Logical frozen Asset identities recorded in the emitted manifest while
  // their immutable bytes are staged once per digest under .viscraft/content/.
  const snapshotAssets = new Map<string, PortableSnapshotAsset>();

  // Every Asset the closure references (current + frozen), indexed by SHA-256:
  // the rights authority when a carried provider original's exact bytes are also
  // a registered Asset (e.g. a `generate-image` result, where the Asset and the
  // provider original are the same bytes).
  const assetsBySha = new Map<string, Asset>();
  for (const asset of project.assets) if (!assetsBySha.has(asset.sha256)) assetsBySha.set(asset.sha256, asset);

  // Re-exporting an already-deduped project: the frozen Asset blobs exist but the
  // logical identities only live in the existing manifest, so it is read when
  // present. Nothing in it authorizes any file unless the frozen project, the
  // recorded input hash, the Asset provenance and the content digest all agree.
  const existingManifestFile = await readValidatedOptional(
    await resolveProjectPath(root, PORTABLE_MANIFEST),
    value => PortableManifestSchema.parse(value),
    'Existing portable manifest (.viscraft/portable-manifest.json)',
  );
  const mappedSnapshotAssets = new Map<string, PortableSnapshotAsset>();
  if (existingManifestFile) {
    for (const asset of existingManifestFile.value.snapshotAssets) {
      if (mappedSnapshotAssets.has(asset.path))
        throw new Error(`Existing portable manifest repeats a snapshot asset path: ${asset.path}`);
      mappedSnapshotAssets.set(asset.path, asset);
    }
  }

  /**
   * Resolve an eligible frozen Asset whose bytes a verified portable export
   * deduplicated. Only an exact logical-path/hash/provenance match may authorize
   * the referenced `.viscraft/content/<sha256>` blob, and that blob must be a
   * real, non-symlinked regular file hashing to the recorded digest; a missing
   * or tampered mapping, or a corrupt blob, fails instead of resolving some
   * other duplicate or undeclared file.
   */
  const resolveDedupedFrozenAsset = async (
    logicalPath: string,
    expectedSha: string,
    asset: Asset,
    buildId: string,
  ): Promise<string> => {
    const mapped = mappedSnapshotAssets.get(logicalPath);
    if (!mapped) throw new Error(`Frozen snapshot for Build ${buildId} is missing authored file ${logicalPath}`);
    if (mapped.sha256 !== expectedSha)
      throw new Error(
        `Frozen snapshot for Build ${buildId} asset ${asset.id} mapping hash does not match the recorded inputs`,
      );
    if (
      mapped.provenance.assetId !== asset.id ||
      mapped.provenance.simulated !== asset.simulated ||
      stableHash(mapped.provenance.rights) !== stableHash(asset.rights)
    ) {
      throw new Error(
        `Frozen snapshot for Build ${buildId} asset ${asset.id} mapping provenance does not match the frozen Asset`,
      );
    }
    const contentAbs = await resolveProjectPath(root, mapped.content);
    let info;
    try {
      info = await lstat(contentAbs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error(`Portable manifest content for ${logicalPath} is missing: ${mapped.content}`);
      throw error;
    }
    if (!info.isFile())
      throw new Error(`Portable manifest content for ${logicalPath} is not a regular file: ${mapped.content}`);
    if ((await realpath(contentAbs)) !== contentAbs)
      throw new Error(`Portable manifest content for ${logicalPath} resolves through a symbolic link`);
    if ((await hashFile(contentAbs)) !== expectedSha)
      throw new Error(`Portable manifest content for ${logicalPath} does not match its recorded hash`);
    return contentAbs;
  };

  // Editable still-image documents: the author source + every declared resource.
  // They are part of the authored closure, so a Portable export carries the real
  // design source a receiver can reopen and re-render.
  for (const document of project.imageDocuments) {
    assertAuthoredPath(document.path, `Image document ${document.id} entry`);
    await addAuthored(document.path, await resolveProjectPath(root, document.path), {
      kind: 'image-document',
      documentId: document.id,
      role: 'entry',
    });
    for (const resource of document.resources) {
      assertAuthoredPath(resource, `Image document ${document.id} resource`);
      await addAuthored(resource, await resolveProjectPath(root, resource), {
        kind: 'image-document',
        documentId: document.id,
        role: 'resource',
      });
    }
  }

  // Authored code Sources: entry + resources. Assets: only redistributable ones.
  const simulatedRecordings: boolean[] = [];
  for (const source of project.sources) {
    if (source.kind !== 'browser' && source.kind !== 'blender') continue;
    assertAuthoredPath(source.entry, `Source ${source.id} entry`);
    await addAuthored(source.entry, await resolveProjectPath(root, source.entry), {
      kind: 'source',
      sourceId: source.id,
      role: 'entry',
    });
    for (const resource of source.resources) {
      assertAuthoredPath(resource, `Source ${source.id} resource`);
      await addAuthored(resource, await resolveProjectPath(root, resource), {
        kind: 'source',
        sourceId: source.id,
        role: 'resource',
      });
    }
    if (
      source.kind === 'browser' &&
      source.output === 'picture' &&
      source.recording &&
      !gapByPath.has(source.recording)
    ) {
      assertAuthoredPath(source.recording, `Source ${source.id} recording`);
      const recordingPath = await resolveProjectPath(root, source.recording);
      const recordingFile = await readValidated(
        recordingPath,
        value => PlayableRecordingSchema.parse(value),
        'Playable recording',
      );
      const recording = recordingFile.value;
      if (stableHash(await loadRecording(root, source.recording)) !== stableHash(recording))
        throw new Error('Playable recording changed during export');
      await addAuthored(
        source.recording,
        recordingPath,
        { kind: 'source', sourceId: source.id, role: 'resource' },
        recordingFile.sha256,
      );
      const label = `Playable source ${source.id}`;
      const { boundAssets, recordedPaths, recordedSha } = verifyPlayableRecording(
        project,
        source,
        requireComposition(project).output,
        recording,
        label,
      );
      for (const asset of boundAssets) {
        // Rights are checked before any recorded bytes are copied.
        if (!asset.rights.redistributable && !allowNonRedistributable)
          throw new Error(`Playable recording asset ${asset.id} is not redistributable`);
      }
      const assetsByPath = new Map(project.assets.map(asset => [asset.path, asset] as const));
      for (const relative of recordedPaths) {
        assertAuthoredPath(relative, `Playable recording ${source.id} dependency`);
        const asset = assetsByPath.get(relative);
        if (asset && !asset.rights.redistributable && !allowNonRedistributable)
          throw new Error(`Playable recording asset ${asset.id} is not redistributable`);
        await addAuthored(
          relative,
          await resolveProjectPath(root, relative),
          asset
            ? { kind: 'asset', assetId: asset.id, simulated: asset.simulated, rights: asset.rights }
            : { kind: 'source', sourceId: source.id, role: 'resource' },
          recordedSha.get(relative),
        );
      }
      // The preview media is recording material, not an authored dependency; it
      // is hash-verified separately against the recording's recorded media hash.
      assertAuthoredPath(recording.media.path, `Playable recording ${source.id} media`);
      await addAuthored(
        recording.media.path,
        await resolveProjectPath(root, recording.media.path),
        { kind: 'source', sourceId: source.id, role: 'resource' },
        recording.media.sha256,
      );
      simulatedRecordings.push(recording.simulated);
    }
  }
  for (const asset of project.assets) {
    assertAuthoredPath(asset.path, `Asset ${asset.id}`);
    if (!asset.rights.redistributable && !allowNonRedistributable) {
      throw new Error(
        `Asset ${asset.id} is not redistributable and cannot be packaged into a portable project: this is a private/rights-unverified Asset, so packaging it is only allowed with the explicit allowNonRedistributable opt-in, and the resulting package is not cleared for redistribution`,
      );
    }
    await addAuthored(
      asset.path,
      await resolveProjectPath(root, asset.path),
      { kind: 'asset', assetId: asset.id, simulated: asset.simulated, rights: asset.rights },
      asset.sha256,
    );
  }

  // --- Handoff files: declared receiver-facing files, checked here ----
  const handoff = await checkHandoff(root, project);
  for (const file of handoff.files)
    await addEntry(
      file.path,
      await resolveProjectPath(root, file.path),
      { kind: 'handoff', role: file.role },
      file.sha256,
    );

  // --- Build / Artifact / snapshot lineage ---------------------------------
  const builds = await readBuilds(root);
  const buildsById = new Map(builds.map(build => [build.id, build] as const));
  const artifactsById = new Map<string, Artifact>();
  for (const build of builds)
    for (const artifact of build.artifacts)
      if (!artifactsById.has(artifact.id)) artifactsById.set(artifact.id, artifact);

  // --- Explicit additional accepted versions ---------------------------
  // Versions are named by STABLE ID only (or the literal `'retained'`), never by
  // scanning time or filenames. The resolved ids are fed to the SAME
  // `productionClosure` traversal below as an explicit seed — no second closure
  // and no second exporter. An unknown id or a non-succeeded Build is a loud
  // failure. Checkpoint ids are refused, so the request is never silently ignored and the
  // destination stays untouched.
  const extraBuildIds = new Set<string>();
  if (options.extraVersions !== undefined && options.extraVersions.length > 0) {
    let checkpointIds: Set<string> | undefined;
    for (const requested of options.extraVersions) {
      if (typeof requested !== 'string' || requested.trim() === '')
        throw new Error('extraVersions entries must be non-empty Build ids or the literal "retained"');
      if (requested === 'retained') {
        for (const build of builds) if (build.retained) extraBuildIds.add(build.id);
        continue;
      }
      const build = buildsById.get(requested);
      if (!build) {
        if (checkpointIds === undefined) checkpointIds = new Set(await readCheckpointIds(root));
        throw new Error(
          checkpointIds.has(requested) || requested.startsWith('checkpoint-')
            ? `Cannot carry extra version ${requested}: checkpoints cannot be exported as accepted versions; name a succeeded Build id or the literal "retained"`
            : `Cannot carry extra version ${requested}: no Build record with that id exists; name a succeeded Build id or the literal "retained"`,
        );
      }
      if (build.status !== 'succeeded')
        throw new Error(
          `Cannot carry extra version ${requested}: Build status is ${build.status}; only succeeded Builds may be carried`,
        );
      extraBuildIds.add(build.id);
    }
  }
  // The active result is packaged verbatim as well as driving the closure roots.
  const resultRel = `${RUNTIME_DIR}/result.json`;
  const resultAbs = await resolveProjectPath(root, resultRel);
  const activeFile = await readValidatedOptional(
    resultAbs,
    value => ActiveResultSchema.parse(value),
    'Active result (.viscraft/result.json)',
  );
  const active = activeFile?.value ?? null;

  // The reachable Build/Artifact lineage is the ONE shared production-closure
  // implementation; Portable is the "current author state + active result" root
  // set, so export can never disagree with Status/Revert/Clean about what a byte
  // is still referenced for.
  const closure = await productionClosure(root, project, builds, ['author', 'active-result', 'derived'], {
    // This IS the delivery boundary: re-derive every carried audio derivation
    // against the real parent stream and produced bytes, so a hand-edited record
    // is refused here and not only on the receiver's next Build.
    verifyDerivationMedia: true,
    // The explicitly requested additional accepted versions enter the SAME
    // traversal as a starting point, so their transitive dependencies (Artifact
    // inputs, real producers, frozen frame/audio derivation parents) are carried
    // too — never a post-closure set union that would silently drop them.
    extraBuilds: [...extraBuildIds],
  });
  const includedBuilds = new Set(closure.builds.keys());
  const requiredArtifacts = new Set(closure.artifacts.keys());

  // The gap policy needs the SELECTED production, so it is decided here, against
  // the closure that will actually be packaged — never against a blanket "all
  // declared Targets are consumed". A gap inside the selected closure is always
  // refused; only an unconsumed one may be carried by the explicit restricted
  // scope, and even then it is recorded, never fabricated.
  const consumedOwners = consumedAuthorOwners(
    project,
    [...includedBuilds].map(id => buildsById.get(id)!),
  );
  const consumedGaps = authoredGaps.filter(gap => gap.owners.some(owner => consumedOwners.has(owner)));
  if (authoredGaps.length > 0 && (!allowIncompleteAuthored || consumedGaps.length > 0))
    throw new Error(
      `delivery: cannot export the whole author state: ${authoredGaps.length} declared authored file(s) are unavailable (${authoredGaps
        .map(
          gap =>
            `${gap.path} (${gap.reason}${gap.expectedSha256 ? `, expected ${gap.expectedSha256}` : ''}; ${gap.owners.join(', ') || 'no owner'})`,
        )
        .join('; ')}). ` +
        (consumedGaps.length > 0
          ? `The selected production needs ${consumedGaps.map(gap => gap.path).join(', ')}, so it cannot be packaged incomplete. `
          : '') +
        'Restore them, or pass the explicit allowIncompleteAuthored scope for an UNCONSUMED gap.',
    );

  // Package each included Build with its frozen snapshot metadata + source files.
  for (const buildId of includedBuilds) {
    const build = buildsById.get(buildId)!;
    const buildRel = `${RUNTIME_DIR}/builds/${build.id}.json`;
    const buildAbs = await resolveProjectPath(root, buildRel);
    const buildFile = await readValidated(buildAbs, value => BuildRecordSchema.parse(value), `Build ${build.id}`);
    // The bytes we validated here must be the lineage we analyzed above.
    if (stableHash(buildFile.value) !== stableHash(build))
      throw new Error(`Build ${build.id} changed while exporting; refusing to package inconsistent lineage`);
    await addEntry(buildRel, buildAbs, { kind: 'build', buildId: build.id }, buildFile.sha256);

    const projectRel = `${SNAPSHOTS_PREFIX}${build.id}.project.json`;
    const inputsRel = `${SNAPSHOTS_PREFIX}${build.id}.inputs.json`;
    const frozenProjectAbs = await resolveProjectPath(root, projectRel);
    const frozenInputsAbs = await resolveProjectPath(root, inputsRel);
    if (!(await pathExists(frozenProjectAbs)) || !(await pathExists(frozenInputsAbs))) {
      throw new Error(
        `Build ${build.id} is missing its frozen snapshot metadata; cannot package the lineage faithfully`,
      );
    }
    const frozenFile = await readValidated(
      frozenProjectAbs,
      value => validateProject(value),
      `Frozen project for Build ${build.id}`,
    );
    const inputsFile = await readValidated(
      frozenInputsAbs,
      value => SnapshotInputsSchema.parse(value),
      `Frozen inputs for Build ${build.id}`,
    );
    const frozen = frozenFile.value;
    const inputs = inputsFile.value;
    if (snapshotHashOf(frozen, inputs.files, inputs.unavailable) !== build.snapshotHash) {
      throw new Error(`Frozen snapshot hash mismatch for Build ${build.id}`);
    }
    // Freeze-time gaps are recorded facts, not carried bytes. They are allowed
    // only for a path the frozen project actually declares; a later-missing
    // LISTED file is damage and still fails below.
    const frozenGaps = new Set(inputs.unavailable.map(gap => gap.path));
    // The frozen manifest must record *exactly* the authored files the frozen
    // project uses. An extra key could smuggle unauthored bytes (secrets,
    // runtime scratch, `.env`, …) into the portable package, and every frozen
    // authored path must live outside the runtime `.viscraft/` tree.
    const frozenAssets = new Map(frozen.assets.map(asset => [asset.path, asset] as const));
    const expected = new Set<string>();
    const declared = new Set<string>();
    const expectAuthored = (relative: string): void => {
      declared.add(relative);
      if (!frozenGaps.has(relative)) expected.add(relative);
    };
    // Frozen bytes other readers consult at the snapshot path (source code,
    // playable recordings, recorded inputs, preview media) must stay physical.
    // Only an Asset path that no such reader needs may be content-addressed.
    const protectedPaths = new Set<string>();
    for (const source of frozen.sources) {
      if (source.kind !== 'browser' && source.kind !== 'blender') continue;
      for (const relative of [source.entry, ...source.resources]) {
        assertAuthoredPath(relative, `Frozen snapshot for Build ${build.id} source`);
        expectAuthored(relative);
        protectedPaths.add(relative);
      }
      if (
        source.kind === 'browser' &&
        source.output === 'picture' &&
        source.recording &&
        !frozenGaps.has(source.recording)
      ) {
        assertAuthoredPath(source.recording, 'Frozen playable recording');
        expectAuthored(source.recording);
        protectedPaths.add(source.recording);
        const snapshotRoot = await resolveProjectPath(root, `${SNAPSHOTS_PREFIX}${build.id}`);
        const recordingPath = await resolveProjectPath(root, `${SNAPSHOTS_PREFIX}${build.id}/${source.recording}`);
        const recordingFile = await readValidated(
          recordingPath,
          value => PlayableRecordingSchema.parse(value),
          'Frozen playable recording',
        );
        const recording = recordingFile.value;
        if (stableHash(await loadRecording(snapshotRoot, source.recording)) !== stableHash(recording))
          throw new Error('Frozen playable recording changed during export');
        const label = `Frozen playable source ${source.id} for Build ${build.id}`;
        const { boundAssets, recordedPaths, recordedSha } = verifyPlayableRecording(
          frozen,
          source,
          requireComposition(frozen).output,
          recording,
          label,
        );
        for (const asset of boundAssets) {
          if (!asset.rights.redistributable && !allowNonRedistributable)
            throw new Error(`Frozen snapshot for Build ${build.id} contains non-redistributable Asset ${asset.id}`);
        }
        for (const relative of recordedPaths) {
          assertAuthoredPath(relative, 'Frozen playable dependency');
          expectAuthored(relative);
          protectedPaths.add(relative);
          if (!frozenGaps.has(relative) && inputs.files[relative] !== recordedSha.get(relative))
            throw new Error('Frozen playable dependency hash does not match recorded inputs');
        }
        assertAuthoredPath(recording.media.path, 'Frozen playable media');
        expectAuthored(recording.media.path);
        protectedPaths.add(recording.media.path);
        if (!frozenGaps.has(recording.media.path) && inputs.files[recording.media.path] !== recording.media.sha256)
          throw new Error('Frozen playable media hash does not match recorded inputs');
        if (inputs.files[source.recording] !== recordingFile.sha256)
          throw new Error('Frozen playable recording hash does not match recorded inputs');
      }
    }
    // Editable still-image documents are part of the frozen authored closure.
    for (const document of frozen.imageDocuments) {
      assertAuthoredPath(document.path, `Frozen snapshot for Build ${build.id} image document ${document.id}`);
      expectAuthored(document.path);
      if (!frozenGaps.has(document.path) && inputs.files[document.path] === undefined)
        throw new Error(`Frozen snapshot for Build ${build.id} is missing image document ${document.path}`);
      for (const resource of document.resources) {
        assertAuthoredPath(resource, `Frozen snapshot for Build ${build.id} image document ${document.id} resource`);
        expectAuthored(resource);
        if (!frozenGaps.has(resource) && inputs.files[resource] === undefined)
          throw new Error(`Frozen snapshot for Build ${build.id} is missing image resource ${resource}`);
      }
    }
    for (const asset of frozen.assets) {
      assertAuthoredPath(asset.path, `Frozen snapshot for Build ${build.id} Asset ${asset.id}`);
      if (!asset.rights.redistributable && !allowNonRedistributable) {
        throw new Error(
          `Frozen snapshot for Build ${build.id} contains non-redistributable Asset ${asset.id}: this is a private/rights-unverified Asset, so packaging it is only allowed with the explicit allowNonRedistributable opt-in, and the resulting package is not cleared for redistribution`,
        );
      }
      if (!assetsBySha.has(asset.sha256)) assetsBySha.set(asset.sha256, asset);
      expectAuthored(asset.path);
    }
    // Receiver-facing handoff files (licences, notices, notes) are authored
    // facts too: the frozen inventory records them, so the frozen snapshot is
    // expected to carry those exact bytes. They are never an Asset derivation,
    // so they stay physical at the snapshot path.
    for (const file of frozen.handoff ?? []) {
      assertAuthoredPath(file.path, `Frozen snapshot for Build ${build.id} handoff ${file.role}`);
      expectAuthored(file.path);
      protectedPaths.add(file.path);
      if (!frozenGaps.has(file.path) && inputs.files[file.path] === undefined)
        throw new Error(`Frozen snapshot for Build ${build.id} is missing handoff file ${file.path}`);
    }
    const recorded = new Set([...Object.keys(inputs.files), ...frozenGaps]);
    if (recorded.size !== declared.size || [...declared].some(relative => !recorded.has(relative))) {
      throw new Error(
        `Frozen snapshot for Build ${build.id} does not record exactly the frozen project's authored files and declared gaps; refusing to package extra content`,
      );
    }
    for (const relative of expected) {
      const asset = frozenAssets.get(relative);
      const logicalPath = `${SNAPSHOTS_PREFIX}${build.id}/${relative}`;
      const expectedSha = inputs.files[relative];
      const frozenAbs = await resolveProjectPath(root, logicalPath);
      const physical = await pathExists(frozenAbs);
      if (asset && !protectedPaths.has(relative)) {
        // Eligible immutable frozen Asset bytes: stage once per digest and keep
        // this reference's identity in `snapshotAssets`.
        let sha256: string;
        let sourceAbs: string;
        if (physical) {
          // The physical snapshot wins: a mismatch must fail even if a blob with
          // the expected digest is also present.
          sha256 = await hashFile(frozenAbs);
          if (sha256 !== expectedSha)
            throw new Error(`Content hash mismatch for ${logicalPath}: expected ${expectedSha}, found ${sha256}`);
          sourceAbs = frozenAbs;
        } else {
          sha256 = expectedSha;
          sourceAbs = await resolveDedupedFrozenAsset(logicalPath, expectedSha, asset, build.id);
        }
        await addEntry(contentPath(sha256), sourceAbs, { kind: 'snapshot-content' }, sha256);
        const logical: PortableSnapshotAsset = {
          path: logicalPath,
          sha256,
          content: contentPath(sha256),
          provenance: { kind: 'asset', assetId: asset.id, simulated: asset.simulated, rights: asset.rights },
        };
        const previous = snapshotAssets.get(logicalPath);
        if (previous && stableHash(previous) !== stableHash(logical))
          throw new Error(`Conflicting frozen snapshot asset at ${logicalPath}`);
        snapshotAssets.set(logicalPath, logical);
      } else {
        // Protected or non-Asset frozen bytes stay physical at the snapshot path;
        // a missing one is a broken lineage, never a silent omission.
        if (!physical) throw new Error(`Frozen snapshot for Build ${build.id} is missing authored file ${relative}`);
        // A frozen Asset keeps its identity, simulated flag and rights in the
        // manifest so historic redistribution terms are explicit, not flattened.
        const provenance: Provenance = asset
          ? { kind: 'asset', assetId: asset.id, simulated: asset.simulated, rights: asset.rights }
          : { kind: 'snapshot-source', buildId: build.id };
        await addEntry(logicalPath, frozenAbs, provenance, expectedSha);
      }
    }
    await addEntry(
      projectRel,
      frozenProjectAbs,
      { kind: 'snapshot-metadata', buildId: build.id, file: 'project' },
      frozenFile.sha256,
    );
    await addEntry(
      inputsRel,
      frozenInputsAbs,
      { kind: 'snapshot-metadata', buildId: build.id, file: 'inputs' },
      inputsFile.sha256,
    );
  }

  // Package every required Artifact, verifying its bytes against the recorded hash.
  const packagedArtifacts: Artifact[] = [];
  for (const artifactId of requiredArtifacts) {
    const artifact = artifactsById.get(artifactId);
    if (!artifact) throw new Error(`Artifact ${artifactId} has no Build record declaring it`);
    if (!artifact.path.startsWith(ARTIFACTS_PREFIX))
      throw new Error(`Artifact ${artifactId} path is outside ${ARTIFACTS_PREFIX}: ${artifact.path}`);
    await addEntry(
      artifact.path,
      await resolveProjectPath(root, artifact.path),
      { kind: 'artifact', artifactId: artifact.id, operation: artifact.operation, simulated: artifact.simulated },
      artifact.sha256,
    );
    packagedArtifacts.push(artifact);
  }

  // --- Carried local provider originals ------------------------------------
  // The current edit closure's generated media has a REQUIRED local provider
  // original: the raw bytes the provider returned, which are NOT the normalized
  // production copy. It is carried at `.viscraft/provider-media/<safe-name>`
  // (so a delivered bundle has it at `project/.viscraft/provider-media/…`). The
  // recorded hash on the produced Artifact/Asset is the ONLY locator; a missing
  // or corrupt original is a loud failure (never substituted with the normalized
  // copy) unless the caller explicitly asked for the restricted scope, in which
  // case the gap is RECORDED in `scope.missing`. Job bodies, remote ids, URLs and
  // signed URLs are never carried.
  // Group the required owners by their recorded ORIGINAL hash. One physical
  // provider original can be the recorded original of SEVERAL logical owners (the
  // SAME bytes serve more than one generated Artifact/Asset); it is carried ONCE
  // and every owner relation is recorded on that single entry, so the physical
  // carrier count always equals `scope.counts.originals`.
  const ownersBySha = new Map<string, Array<{ kind: 'artifact' | 'asset'; id: string }>>();
  {
    const claim = (kind: 'artifact' | 'asset', id: string, sha256: string): void => {
      const owners = ownersBySha.get(sha256) ?? [];
      if (!owners.some(owner => owner.kind === kind && owner.id === id)) owners.push({ kind, id });
      ownersBySha.set(sha256, owners);
    };
    for (const artifactId of requiredArtifacts) {
      const artifact = artifactsById.get(artifactId)!;
      const sha256 = originalSha256(artifact);
      if (sha256) claim('artifact', artifact.id, sha256);
    }
    for (const asset of project.assets) {
      const sha256 = originalSha256(asset);
      if (sha256) claim('asset', asset.id, sha256);
    }
  }
  const missingOriginals: PortableScope['missing'] = [];
  let carriedOriginals = 0;
  if (includeOriginals) {
    const index = await providerOriginalIndex(root);
    for (const [sha256, owners] of [...ownersBySha.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const who = owners.map(owner => `${owner.kind} ${owner.id}`).join(', ');
      const local = index.get(sha256);
      if (!local) {
        const reason = `the required local provider original (sha256 ${sha256}) for ${who} was not found under ${PROVIDER_MEDIA_PREFIX}`;
        if (!allowMissingOriginals)
          throw new Error(
            `${reason}; refusing to substitute the normalized artifact/Asset bytes. ` +
              'Re-run the export with the restricted allowMissingOriginals scope to record the gap instead.',
          );
        for (const owner of owners) missingOriginals.push({ kind: owner.kind, id: owner.id, sha256, reason });
        continue;
      }
      // Rights authority: an Asset that owns these exact bytes carries the only
      // recorded redistribution terms. A project-generated original with no such
      // record inherits no extra gate — the normalized artifact is already
      // carried unconditionally — so no rights are fabricated either way.
      const match = assetsBySha.get(sha256);
      if (match && !match.rights.redistributable && !allowNonRedistributable) {
        throw new Error(
          `Original for ${who} (sha256 ${sha256}) is the non-redistributable Asset ${match.id}; ` +
            'packaging its private bytes is only allowed with the explicit allowNonRedistributable opt-in, and the resulting package is not cleared for redistribution',
        );
      }
      const provenance: Provenance = {
        kind: 'original',
        sha256,
        owners,
        ...(match ? { rightsAssetId: match.id, rights: match.rights } : {}),
      };
      // `addEntry` keys by destination path, so the one physical carrier of this
      // hash is added exactly once regardless of how many owners name it.
      await addEntry(local, await resolveProjectPath(root, local), provenance, sha256);
      carriedOriginals += 1;
    }
  }

  if (active && activeFile) {
    await addEntry(resultRel, resultAbs, { kind: 'result', buildId: active.build }, activeFile.sha256);
  }

  // Rendered receiver pages: never an authority, never overwriting an author file.
  const addRendered = (destRel: string, text: string, page: 'facts' | 'attribution') => {
    // An authored file AT the page path, or UNDER it (which would make the page a
    // directory at the package root), would collide with the rendered file.
    const colliding = [...entries.keys()].find(relative => relative === destRel || relative.startsWith(`${destRel}/`));
    if (colliding)
      throw new Error(`${destRel} is generated by the export; rename the authored file at that path (${colliding})`);
    const bytes = Buffer.from(text, 'utf8');
    entries.set(destRel, {
      source: bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      provenance: { kind: 'generated', page },
    });
  };
  const attribution = renderAttribution(project);
  if (attribution) addRendered(`${RUNTIME_DIR}/pages/ATTRIBUTION.md`, attribution, 'attribution');
  addRendered(
    `${RUNTIME_DIR}/pages/VISCRAFT.md`,
    await renderFactPage({
      project,
      builds: [...includedBuilds].map(id => buildsById.get(id)!),
      activeBuild: active?.build ?? null,
      handoff: handoff.files,
      attribution: attribution !== null,
    }),
    'facts',
  );

  const simulated =
    simulatedRecordings.some(Boolean) ||
    active?.simulated === true ||
    project.sources.some(source => source.kind === 'simulated') ||
    project.assets.some(asset => asset.simulated) ||
    packagedArtifacts.some(artifact => artifact.simulated) ||
    [...includedBuilds].some(buildId => buildsById.get(buildId)!.takes.some(take => take.simulated)) ||
    // Carried files and frozen Assets keep their OWN simulated flag: a simulated
    // Asset that lives only inside an explicitly carried version still taints the
    // package, which the current-project checks above would miss.
    [...entries.values()].some(entry => {
      const provenance = entry.provenance;
      return (provenance.kind === 'asset' || provenance.kind === 'artifact') && provenance.simulated;
    }) ||
    [...snapshotAssets.values()].some(asset => asset.provenance.simulated);

  const notes: string[] = [
    'Packaged authored project state plus only the frozen provenance required to reopen this project or reuse the selected Result/Take lineage. Runtime scratch, provider jobs/remote state, locks, damaged bytes, review outputs, node_modules/model weights and unknown files were excluded.',
  ];
  if (includedBuilds.size > 0) notes.push(`Included Build records: ${[...includedBuilds].sort().join(', ')}.`);
  if (extraBuildIds.size > 0)
    notes.push(
      `Carried ${extraBuildIds.size} explicitly requested additional version(s) by stable Build id: ${[...extraBuildIds].sort().join(', ')}.`,
    );
  if (snapshotAssets.size > 0) {
    const blobs = new Set([...snapshotAssets.values()].map(asset => asset.sha256)).size;
    notes.push(
      `Deduplicated ${snapshotAssets.size} frozen Asset reference(s) into ${blobs} content-addressed blob(s) under ${CONTENT_PREFIX}; every other frozen snapshot file remains a physical copy.`,
    );
  }
  if (simulated) {
    notes.push(
      'This package carries simulated/test-only provenance. Simulated provider request/job state was intentionally not packaged: the included accepted Artifacts can be reused through the recorded Take selections without a new submit, but producing a new simulated attempt requires fresh job state and must not be represented as a real generative model.',
    );
  }
  if (carriedOriginals > 0)
    notes.push(
      `Carried ${carriedOriginals} local provider original(s) under ${PROVIDER_MEDIA_PREFIX}; each is a real hashed file (not the normalized production copy) listed with an 'original' provenance. Job/remote request state is never carried.`,
    );
  if (missingOriginals.length > 0)
    notes.push(
      `This package is a RESTRICTED scope: ${missingOriginals.length} required provider original(s) were not present locally and are recorded as gaps in scope.missing. The normalized production copy was NOT substituted for them.`,
    );
  if (authoredGaps.length > 0)
    notes.push(
      `This package is a RESTRICTED AUTHOR scope: ${authoredGaps.length} declared authored file(s) were unavailable and are recorded in scope.authoredGaps (${authoredGaps
        .map(gap => gap.path)
        .join(
          ', ',
        )}). They are NOT carried as bytes and are not consumed by the selected production result, so the selected Result/Takes remain complete while the whole author state is not.`,
    );

  const carriesPrivateBytes =
    [...entries.values()].some(entry => {
      const provenance = entry.provenance;
      return (
        (provenance.kind === 'asset' && !provenance.rights.redistributable) ||
        (provenance.kind === 'original' && provenance.rights !== undefined && !provenance.rights.redistributable)
      );
    }) || [...snapshotAssets.values()].some(asset => !asset.provenance.rights.redistributable);

  const succeededBuilds = builds.filter(candidate => candidate.status === 'succeeded');
  const historyComplete = succeededBuilds.every(
    build => includedBuilds.has(build.id) && build.artifacts.every(artifact => requiredArtifacts.has(artifact.id)),
  );
  const providerTasks = new Set<string>();
  for (const buildId of includedBuilds)
    for (const artifact of buildsById.get(buildId)!.artifacts)
      if (artifact.generation ?? artifact.imageGeneration) providerTasks.add(artifact.id);
  for (const asset of project.assets) if (asset.imageGeneration) providerTasks.add(asset.id);

  const excluded: PortableScope['excluded'] = [
    {
      class: 'provider-job-remote-state',
      reason:
        'Provider job/remote request state carries request identity and is regenerateable; it is never transported.',
    },
    {
      class: 'scratch-damaged-locks-reviews',
      reason: 'Runtime scratch, damaged bytes, locks and review outputs are derived, not authored content.',
    },
    { class: 'credentials-secrets', reason: 'Known credential files and resolved secrets are never packaged.' },
    {
      class: 'node-modules-model-weights',
      reason: 'Installed dependencies and model weights are not project-authored bytes.',
    },
    {
      class: 'unselected-history-media',
      reason: 'Outputs outside the selected Result/Take lineage remain records, not carried media.',
    },
  ];
  if (!includeOriginals)
    excluded.push({
      class: 'provider-originals',
      reason:
        'Originals were not requested for this scope (explicit includeOriginals:false); only normalized production media is carried.',
    });
  else if (missingOriginals.length > 0)
    excluded.push({
      class: 'missing-provider-originals',
      reason:
        'Required originals were not present locally; each gap is listed in scope.missing and was NOT substituted with the normalized copy.',
    });
  if (authoredGaps.length > 0)
    excluded.push({
      class: 'unconsumed-authored-gaps',
      reason:
        'Declared authored bytes were unavailable and are not consumed by the selected Result/Takes; each gap is listed in scope.authoredGaps and was NOT fabricated.',
    });

  const scope: PortableScope = {
    requested: allowMissingOriginals ? 'allow-missing-originals' : 'default',
    includeOriginals,
    authoredScope: authoredGaps.length > 0 ? 'allow-incomplete' : 'complete',
    authorComplete: authoredGaps.length === 0,
    selectedProductionComplete: true,
    wholeAuthorRestorable: authoredGaps.length === 0,
    authoredGaps,
    requestedVersions: [...extraBuildIds].sort(),
    counts: {
      files: entries.size,
      builds: includedBuilds.size,
      artifacts: packagedArtifacts.length,
      originals: carriedOriginals,
    },
    excluded,
    missing: missingOriginals.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)),
    receiver: {
      can: [
        'reopen and rebuild this project with the matched Runtime, reusing the packaged Builds/Artifacts/Takes',
        'edit authored Sources/Assets/composition/audio and re-build, review, deliver or archive',
        ...(includeOriginals && missingOriginals.length === 0
          ? ['locate and verify the carried provider originals under .viscraft/provider-media/']
          : []),
      ],
      cannot: [
        'recover the same provider submission from the package alone: job/remote request state is never carried, so a new attempt needs fresh job state and a fresh authorization',
        ...(carriesPrivateBytes
          ? ['redistribute the packaged non-redistributable bytes: this is a private, rights-unverified package']
          : []),
        ...(missingOriginals.length > 0
          ? ['reuse an original whose bytes were not carried; each is listed in scope.missing']
          : []),
      ],
    },
    environment:
      'Reopening needs the matched Runtime version; the receiver supplies any credentials, endpoints and authorizations it uses. No credential, signed URL, provider endpoint or endpoint authorization travels in the package.',
    closureComplete: authoredGaps.length === 0,
    rebuildable: authoredGaps.length === 0,
    originalsComplete: includeOriginals && missingOriginals.length === 0,
    historyComplete,
    taskRecoverable: providerTasks.size === 0,
  };

  const manifest: PortableManifest = {
    format: 'viscraft-portable-project',
    version: 1,
    schemaVersion: project.schemaVersion,
    project: { id: project.id, revision: project.revision, title: project.title },
    exportedAt: new Date().toISOString(),
    simulated,
    builds: [...includedBuilds].sort(),
    artifacts: packagedArtifacts.map(artifact => artifact.id).sort(),
    files: [...entries.entries()]
      .map(([relative, entry]) => ({
        path: relative,
        sha256: entry.sha256,
        bytes: entry.bytes,
        provenance: entry.provenance,
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    snapshotAssets: [...snapshotAssets.values()].sort((a, b) => a.path.localeCompare(b.path)),
    scope,
    notes,
  };
  // Self-check: the freshly generated manifest must satisfy its OWN schema (the
  // strict shape plus the aggregate invariants — `counts` vs the real carried
  // files/builds/artifacts/originals, requestedVersions vs carried Builds, and
  // the scope booleans). Refusing here means the export can never "succeed" while
  // shipping a manifest that a receiver's `verifyPortableExport`/restore would
  // reject as corrupt.
  PortableManifestSchema.parse(manifest);

  const staging = path.join(parentReal, `.${path.basename(destReal)}.${randomUUID()}.staging`);
  await mkdir(staging, { recursive: true });
  // The delivery record (for a destination that lands directly in `output/`),
  // written before the publish as a recovery marker and after it as the durable
  // record. A crash between the two leaves a resolvable entry that the next
  // export recognises as its own (see markDeliveryPending).
  let deliveryRecord: DeliveryRecord | null = null;
  try {
    for (const [relative, entry] of entries) {
      const target = path.join(staging, ...relative.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      if (typeof entry.source === 'string') await copyFile(entry.source, target);
      else await writeFile(target, entry.source, { flag: 'wx', mode: 0o644 });
    }
    for (const [relative, entry] of entries) {
      const target = path.join(staging, ...relative.split('/'));
      if ((await hashFile(target)) !== entry.sha256)
        throw new Error(`Staged file failed hash verification: ${relative}`);
    }
    const manifestPath = path.join(staging, RUNTIME_DIR, 'portable-manifest.json');
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const manifestSha256 = await hashFile(manifestPath);
    const recordName = outputRecordName(rootReal, destReal);
    if (recordName)
      deliveryRecord = {
        name: recordName,

        kind: 'export',
        ...(active?.build ? { build: active.build } : {}),
        revision: project.revision,
        deliveredAt: new Date().toISOString(),
        manifestSha256,
      };
    // Persist the marker immediately before the publish (after the replace
    // re-check) so a crash in the window between the publish and the durable
    // record is recoverable, not a refusal.
    if (await pathExists(destReal)) {
      if (!replaceDefault) throw new Error(`Export destination appeared during export: ${destReal}`);
      // Re-check the observed state immediately before the swap: an external
      // editor may have changed or replaced the old export while this one was
      // staged. Full check — a coherent replacement is caught only by re-reading
      // the recorded manifest hash.
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

  // Record every delivery that lands directly in output/, so a later default
  // export can prove the previous one is unmodified before replacing it.
  if (deliveryRecord) {
    await writeDeliveryRecord(rootReal, deliveryRecord);
    await clearDeliveryPending(rootReal, deliveryRecord.name);
  }

  return {
    path: destReal,
    files: entries.size,
    simulated,
    warnings: handoff.warnings,
    scope,
    originals: carriedOriginals,
  };
}
