/**
 * archive release: the one explicit way to free the bytes of paid or
 * irreplaceable media, and `restore-media` to write them back.
 *
 * `releaseArchived` frees media bytes only after a verified archive proves it
 * holds them:
 *  1. the archive lives outside the Project (it must be a second copy);
 *  2. a complete `restoreProject` of it into a private temporary directory
 *     succeeds (the same code path as a normal restore), the restored Project is
 *     this Project, and a receipt `.viscraft/archive-receipts/<sha>.json` is
 *     written;
 *  3. every requested Artifact's bytes appear (by sha256) in that archive;
 *  4. the user named each Artifact or Build — there is no "all".
 * Only the SELECTED Artifact's media bytes are deleted. Provider originals,
 * job records, Build records, frozen snapshots and the receipt always stay:
 * an original must not be freed here because `restore-media` writes back only
 * the Artifact, so deleting an original would leave a false recovery promise.
 * The Artifact gets `archived` so Plan, Build and Status say "restore this media
 * from the archive first" instead of re-downloading or re-submitting anything.
 */
import { copyFile, mkdtemp, readFile, readdir, realpath, rm, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BuildRecordSchema, type Artifact, type BuildRecord } from '../core/schema.js';
import { atomicJson, resolveProjectPath } from '../shared/fs.js';
import { hashFile } from '../shared/hash.js';
import { restoreProject } from '../operations/delivery/archive.js';
import { readBuilds } from './build-records.js';
import { loadProject } from './project.js';
import { assertNoOpenWork, withWriteLocks } from './versions.js';

export const RECEIPTS_DIR = '.viscraft/archive-receipts';
const PROVIDER_MEDIA_DIR = '.viscraft/provider-media';

export interface ReleaseResult {
  archive: string;
  receipt: string;
  released: Array<{ artifact: string; path: string; bytes: number }>;
  /**
   * Retained provider originals encountered for the selected Artifacts. This
   * release never deletes them (`released` is always false): `restore-media`
   * cannot write an original back, so freeing one would be an unrecoverable
   * loss behind a false recovery promise. Listed so the caller can see they are
   * intentionally protected.
   */
  originals: Array<{ path: string; released: boolean }>;
}

export interface RestoreMediaResult {
  archive: string;
  restored: Array<{ artifact: string; path: string }>;
}

interface VerifiedArchive {
  sha256: string;
  /** sha256 → archive-relative path inside the private restored copy. */
  bytes: Map<string, string>;
  restored: string;
}

async function isInside(child: string, parent: string): Promise<boolean> {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Restore the archive into a private temporary directory and index its bytes. */
async function verifyArchive(
  root: string,
  archive: string,
  projectId: string,
  maxContent: number | undefined,
): Promise<VerifiedArchive> {
  const rootReal = await realpath(root);
  const archiveReal = await realpath(path.resolve(archive));
  if (await isInside(archiveReal, rootReal))
    throw new Error('The archive must live outside the Project: releasing local bytes requires a copy elsewhere');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'viscraft-release-'));
  try {
    const restored = path.join(temporary, 'project');
    const result = await restoreProject(archiveReal, restored, { maxContent });
    const manifest = JSON.parse(await readFile(path.join(restored, '.viscraft', 'portable-manifest.json'), 'utf8')) as {
      project: { id: string };
      files: Array<{ path: string; sha256: string }>;
    };
    if (manifest.project.id !== projectId)
      throw new Error(`The archive holds Project ${manifest.project.id}, not ${projectId}`);
    const bytes = new Map<string, string>();
    for (const file of manifest.files) if (!bytes.has(file.sha256)) bytes.set(file.sha256, file.path);
    return { sha256: result.sha256, bytes, restored: temporary };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function updateArtifacts(
  root: string,
  builds: BuildRecord[],
  ids: Set<string>,
  change: (artifact: Artifact) => Artifact,
): Promise<void> {
  for (const build of builds) {
    if (!build.artifacts.some(artifact => ids.has(artifact.id))) continue;
    const next = BuildRecordSchema.parse({
      ...build,
      artifacts: build.artifacts.map(artifact => (ids.has(artifact.id) ? change(artifact) : artifact)),
    });
    await atomicJson(await resolveProjectPath(root, `.viscraft/builds/${build.id}.json`), next);
  }
}

async function providerOriginals(root: string, sha256: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(await resolveProjectPath(root, PROVIDER_MEDIA_DIR));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const out: string[] = [];
  for (const name of names) {
    const relative = `${PROVIDER_MEDIA_DIR}/${name}`;
    if ((await hashFile(await resolveProjectPath(root, relative)).catch(() => null)) === sha256) out.push(relative);
  }
  return out;
}

function originalSha(artifact: Artifact): string | undefined {
  return artifact.generation?.originalSha256 ?? artifact.imageGeneration?.outputSha256;
}

/**
 * Test seam: called with a step label so a regression test can simulate a crash
 * at an exact point (a throw stands in for the process dying there). Production
 * never sets it.
 */
let releaseStepHook: ((step: string) => Promise<void> | void) | undefined;
export function setReleaseStepHookForTest(hook?: (step: string) => Promise<void> | void): void {
  releaseStepHook = hook;
}

/** Free the named Artifacts' media bytes after verifying an outside archive holds them. */
export async function releaseArchived(
  root: string,
  archive: string,
  include: string[],
  options: { maxContent?: number } = {},
): Promise<ReleaseResult> {
  if (include.length === 0)
    throw new Error('clean --release-archived needs --include <artifact-id|build-id> for each item; there is no "all"');
  return withWriteLocks(root, async () => {
    await assertNoOpenWork(root);
    const project = await loadProject(root);
    const builds = await readBuilds(root);
    const artifacts = new Map<string, Artifact>();
    for (const build of builds)
      for (const artifact of build.artifacts) if (!artifacts.has(artifact.id)) artifacts.set(artifact.id, artifact);
    const targets = new Set<string>();
    for (const value of include) {
      if (value === '*' || value === 'all')
        throw new Error('clean --release-archived: name each item; there is no "all"');
      if (value.startsWith('build-')) {
        const build = builds.find(candidate => candidate.id === value);
        if (!build) throw new Error(`clean --release-archived: no Build ${value}`);
        for (const artifact of build.artifacts) targets.add(artifact.id);
      } else if (artifacts.has(value)) targets.add(value);
      else throw new Error(`clean --release-archived: no Artifact ${value}`);
    }

    const verified = await verifyArchive(root, archive, project.id, options.maxContent);
    try {
      const missing = [...targets].filter(id => !verified.bytes.has(artifacts.get(id)!.sha256));
      if (missing.length > 0)
        throw new Error(`The archive does not hold the bytes of ${missing.join(', ')}; nothing was released`);
      const receipt = `${RECEIPTS_DIR}/${verified.sha256}.json`;
      await atomicJson(await resolveProjectPath(root, receipt), {
        archive: verified.sha256,
        path: await realpath(path.resolve(archive)),
        projectId: project.id,
        verifiedAt: new Date().toISOString(),
        files: [...verified.bytes].map(([sha256, file]) => ({ path: file, sha256, verified: true })),
      });

      // Persist the verifiable recovery relation BEFORE the first unlink.
      // `restore-media` keys exclusively off `artifact.archived` (it never reads
      // the receipt), so the mark must already exist when the bytes disappear.
      // The archive was verified above to hold every selected Artifact's bytes, so
      // the mark is truthful even if a later step fails: if this build-record write
      // fails, NOTHING has been deleted yet, and if a crash follows it the media is
      // still restorable. Nothing is released until every mark is durable.
      const at = new Date().toISOString();
      await updateArtifacts(root, builds, targets, artifact => ({
        ...artifact,
        archived: { archive: verified.sha256, at },
      }));

      // Crash point for the regression test: at this label every selected
      // Artifact's `archived` mark is already durable and NO byte has been freed.
      await releaseStepHook?.('marks-persisted');

      // Only now delete the selected bytes. This pass is restartable: an Artifact
      // whose bytes are still present is unlinked, an already-freed one is skipped,
      // so re-running after a partial failure leaves a consistent, restorable state.
      const released: ReleaseResult['released'] = [];
      const originals: ReleaseResult['originals'] = [];
      for (const id of [...targets].sort()) {
        const artifact = artifacts.get(id)!;
        const file = await resolveProjectPath(root, artifact.path);
        const present = (await hashFile(file).catch(() => null)) === artifact.sha256;
        if (present) {
          const { size } = await stat(file);
          try {
            await unlink(file);
          } catch (error) {
            // A concurrent removal is not a failure of this release.
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          released.push({ artifact: id, path: artifact.path, bytes: size });
        }
        // Provider originals are PROTECTED by this release: it frees only the
        // explicitly selected Artifact bytes. `restore-media` writes back only the
        // Artifact, so deleting an original here would lose bytes the receipt
        // cannot bring back — each encountered original is REPORTED as not
        // released, never deleted.
        const original = originalSha(artifact);
        if (original)
          for (const relative of await providerOriginals(root, original))
            originals.push({ path: relative, released: false });
      }
      return { archive: verified.sha256, receipt, released, originals };
    } finally {
      await rm(verified.restored, { recursive: true, force: true });
    }
  });
}

/** Write archived media bytes back from a verified archive and clear their `archived` marks. */
export async function restoreMedia(
  root: string,
  archive: string,
  ids: string[] = [],
  options: { maxContent?: number } = {},
): Promise<RestoreMediaResult> {
  return withWriteLocks(root, async () => {
    await assertNoOpenWork(root);
    const project = await loadProject(root);
    const builds = await readBuilds(root);
    const archived = new Map<string, Artifact>();
    for (const build of builds)
      for (const artifact of build.artifacts)
        if (artifact.archived && !archived.has(artifact.id)) archived.set(artifact.id, artifact);
    for (const id of ids) if (!archived.has(id)) throw new Error(`restore-media: Artifact ${id} is not archived`);
    const wanted = ids.length > 0 ? ids : [...archived.keys()];
    if (wanted.length === 0) throw new Error('restore-media: no Artifact is archived');

    const verified = await verifyArchive(root, archive, project.id, options.maxContent);
    try {
      const restored: RestoreMediaResult['restored'] = [];
      for (const id of wanted.sort()) {
        const artifact = archived.get(id)!;
        const source = verified.bytes.get(artifact.sha256);
        if (!source) throw new Error(`restore-media: the archive does not hold the bytes of ${id}`);
        const target = await resolveProjectPath(root, artifact.path);
        await copyFile(path.join(verified.restored, 'project', ...source.split('/')), target);
        if ((await hashFile(target)) !== artifact.sha256)
          throw new Error(`restore-media: ${id} failed hash verification`);
        restored.push({ artifact: id, path: artifact.path });
      }
      await updateArtifacts(root, builds, new Set(wanted), ({ archived: _released, ...rest }) => rest);
      return { archive: verified.sha256, restored };
    } finally {
      await rm(verified.restored, { recursive: true, force: true });
    }
  });
}
