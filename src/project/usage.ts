/**
 * `viscraft usage`: the read-only answer to "which bytes are here, why do they
 * still exist, and which could be reclaimed?".
 *
 * It reports THREE non-interchangeable byte measures for every category:
 *  - `logicalBytes`       — summed file size per path (`du --apparent-size`);
 *  - `uniqueContentBytes` — summed size of distinct sha256 within the category;
 *                           the Project total deduplicates across all categories;
 *  - `physicalBytes`      — summed size of distinct `(dev, inode)`; one inode
 *                           shared by several paths is counted once, attributed
 *                           to the category with the strongest protection
 *                           reason, the rest recorded in `sharedWith`.
 *
 * The per-category `physicalBytes` sum equals the real on-disk usage of the
 * MEASURED files. Install and version-control trees (`node_modules/`, `.git/`)
 * are not Project content: they are not walked, are never reported as an unknown
 * layout, and are named in `scope.excluded` so the totals are never mistaken for
 * a complete disk usage. Reclaim estimates use ONLY `physicalBytes`: deleting a
 * path that another path still hardlinks frees nothing and is reported as 0.
 *
 * Zero writes: it never creates a lock, record, cache entry or directory.
 */
import { lstat, readdir, readlink } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { Project } from '../core/schema.js';
import { hashFile } from '../shared/hash.js';
import { authorState } from './state.js';
import { loadRecording } from '../backends/playable/recording.js';
import { readBuilds } from './build-records.js';
import { loadProject } from './project.js';
import { productionClosure } from './closure.js';
import { incompleteCleanup, planClean } from './clean.js';

export interface UsageCategory {
  files: number;
  logicalBytes: number;
  uniqueContentBytes: number;
  physicalBytes: number;
  reasons: string[];
}

export interface ProjectUsage {
  root: string;
  categories: Record<string, UsageCategory>;
  /** Artifact subcategories: which artifacts are protected vs reclaimable. */
  artifacts: Record<string, { files: number; logicalBytes: number; physicalBytes: number }>;
  /** Per `output/` delivery: files and unique content bytes. */
  output: Array<{ name: string; files: number; logicalBytes: number; physicalBytes: number }>;
  totals: { files: number; logicalBytes: number; uniqueContentBytes: number; physicalBytes: number };
  reclaimablePhysicalBytes: number;
  needsDecisionPhysicalBytes: number;
  attention: string[];
  /**
   * The real scope of the measurement: `excluded` names every install or
   * version-control tree that was deliberately NOT walked (its bytes are not in
   * `totals`), so the totals are never mistaken for a complete disk usage.
   */
  scope: { excluded: Array<{ path: string; reason: string }> };
}

/** Categories, ordered by protection strength (first = strongest attribution). */
const CATEGORY_ORDER = [
  'records',
  'providerEvidence',
  'artifacts',
  'snapshots',
  'content',
  'author',
  'assets',
  'recordings',
  'handoff',
  'analysis',
  'previews',
  'scratch',
  'output',
  'review',
  'other',
] as const;
type Category = (typeof CATEGORY_ORDER)[number];

const ANALYSIS_DIRS = new Set([
  '.viscraft/reviews',
  '.viscraft/references',
  '.viscraft/audio-references',
  '.viscraft/reference-tracks',
  '.viscraft/reference-foreground',
]);

function emptyCategory(): UsageCategory {
  return { files: 0, logicalBytes: 0, uniqueContentBytes: 0, physicalBytes: 0, reasons: [] };
}

function underPrefix(rel: string, prefix: string): boolean {
  return rel === prefix || rel.startsWith(`${prefix}/`);
}

/**
 * Directory names that are NEVER Project content: an installed dependency tree
 * or a version-control store. Walking them would hash thousands of foreign
 * files and report them as an unknown layout; they are excluded from the
 * measurement and named honestly in `scope.excluded`.
 */
const EXCLUDED_TREES = new Set(['node_modules', '.git']);

/** Recursively list every regular file / symlink under a directory, project-relative. */
async function walk(root: string, dir: string, out: string[], excluded?: Map<string, string>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_TREES.has(entry.name)) {
        excluded?.set(
          relative(root, abs).split(sep).join('/'),
          entry.name === '.git' ? 'version-control tree' : 'installed dependencies',
        );
        continue;
      }
      await walk(root, abs, out, excluded);
    } else out.push(relative(root, abs).split(sep).join('/'));
  }
}

export async function projectUsage(root: string): Promise<ProjectUsage> {
  const rootAbs = resolve(root);
  const project: Project = await loadProject(rootAbs);
  const builds = await readBuilds(rootAbs);

  // Authored file roles: assets, browser recording sessions, other authored code.
  const assetPaths = new Set(project.assets.map(asset => asset.path));
  const recordingPaths = new Set<string>();
  for (const source of project.sources) {
    if (source.kind !== 'browser' || source.output !== 'picture' || !source.recording) continue;
    try {
      const recording = await loadRecording(rootAbs, source.recording);
      recordingPaths.add(source.recording);
      recordingPaths.add(recording.media.path);
      for (const file of recording.source.files) recordingPaths.add(file.path);
    } catch {
      recordingPaths.add(source.recording);
    }
  }
  // The same whole-author facts a Build freezes; gaps are simply absent bytes
  // and do not hide the readable authored files from classification.
  const authored = new Set((await authorState(rootAbs, project)).files.keys());
  const handoff = new Set(project.handoff?.map(h => h.path) ?? []);

  // Artifact classification over the shared production closure.
  const currentArtifactId = await readActiveArtifact(rootAbs);
  const retainedArtifacts = new Set<string>();
  for (const build of builds)
    if (build.retained) {
      if (build.result) retainedArtifacts.add(build.result.artifact);
      for (const take of build.takes) retainedArtifacts.add(take.artifact);
    }
  const versionArtifacts = new Set<string>();
  for (const build of builds)
    if (build.status === 'succeeded') {
      if (build.result) versionArtifacts.add(build.result.artifact);
      for (const take of build.takes) versionArtifacts.add(take.artifact);
    }
  const derivedArtifacts = new Set<string>();
  for (const asset of project.assets) if (asset.derivedFrom) derivedArtifacts.add(asset.derivedFrom.artifact);
  const artifactById = new Map<string, { simulated: boolean; generated: boolean }>();
  for (const build of builds)
    for (const artifact of build.artifacts)
      if (!artifactById.has(artifact.id))
        artifactById.set(artifact.id, {
          simulated: artifact.simulated,
          generated: Boolean(artifact.generation ?? artifact.imageGeneration),
        });

  // Reachability: an Artifact reachable from the retention roots (current result
  // + its whole Building lineage, retained versions, derived parents, generated
  // media, authored Takes) is PROTECTED. Only artifacts outside every closure are
  // reclaimable. If the lineage cannot be read, stay conservative: nothing is
  // called reclaimable.
  let closureArtifacts: Map<string, string>;
  let closureAvailable = true;
  try {
    closureArtifacts = (
      await productionClosure(rootAbs, project, builds, [
        'author',
        'active-result',
        'derived',
        'retained',
        'checkpoint',
        'generated',
      ])
    ).artifacts;
  } catch {
    closureArtifacts = new Map<string, string>();
    closureAvailable = false;
  }

  const files: string[] = [];
  const excluded = new Map<string, string>();
  await walk(rootAbs, rootAbs, files, excluded);

  const classify = (rel: string): { category: Category; reason: string; artifactClass?: string } => {
    if (handoff.has(rel)) return { category: 'handoff', reason: 'handoff' };
    // The Runtime-owned `output/.gitignore` is metadata, not a delivery: it must
    // not be counted as (or reclaimable with) a delivered bundle.
    if (rel === 'output/.gitignore') return { category: 'records', reason: 'self-ignore' };
    if (underPrefix(rel, 'output') && !underPrefix(rel, '.viscraft')) return { category: 'output', reason: 'delivery' };
    if (underPrefix(rel, 'review')) return { category: 'review', reason: 'author-review' };
    if (rel === '.viscraft/build.lock' || rel === '.viscraft/author.lock')
      return { category: 'scratch', reason: 'lock' };
    if (underPrefix(rel, '.viscraft')) {
      if (rel.endsWith('.project.json') || rel.endsWith('.inputs.json'))
        return { category: 'records', reason: 'snapshot-metadata' };
      if (underPrefix(rel, '.viscraft/builds')) return { category: 'records', reason: 'build-record' };
      if (
        underPrefix(rel, '.viscraft/checkpoints') ||
        underPrefix(rel, '.viscraft/revert') ||
        underPrefix(rel, '.viscraft/cleanups') ||
        underPrefix(rel, '.viscraft/archive-receipts')
      )
        return { category: 'records', reason: 'record' };
      if (underPrefix(rel, '.viscraft/snapshots')) return { category: 'snapshots', reason: 'snapshot' };
      if (underPrefix(rel, '.viscraft/content')) return { category: 'content', reason: 'content' };
      if (underPrefix(rel, '.viscraft/artifacts')) {
        const id = `artifact-${rel
          .split('/')
          .pop()
          ?.replace(/\.[^.]+$/, '')
          .replace(/^artifact-/, '')}`;
        const known = artifactById.get(id);
        return { category: 'artifacts', reason: 'artifact', artifactClass: classifyArtifact(id, known) };
      }
      if (
        underPrefix(rel, '.viscraft/jobs') ||
        underPrefix(rel, '.viscraft/provider-media') ||
        underPrefix(rel, '.viscraft/remote') ||
        underPrefix(rel, '.viscraft/video-api') ||
        underPrefix(rel, '.viscraft/fal') ||
        underPrefix(rel, '.viscraft/runway') ||
        underPrefix(rel, '.viscraft/image-api')
      )
        return { category: 'providerEvidence', reason: 'provider-evidence' };
      if (underPrefix(rel, '.viscraft/scratch') || underPrefix(rel, '.viscraft/damaged'))
        return { category: 'scratch', reason: 'scratch' };
      if (underPrefix(rel, '.viscraft/previews')) return { category: 'previews', reason: 'preview' };
      for (const dir of ANALYSIS_DIRS) if (underPrefix(rel, dir)) return { category: 'analysis', reason: 'analysis' };
      return { category: 'records', reason: 'unknown-runtime' };
    }
    if (assetPaths.has(rel)) return { category: 'assets', reason: 'asset' };
    if (recordingPaths.has(rel)) return { category: 'recordings', reason: 'playable-recording' };
    if (authored.has(rel)) return { category: 'author', reason: 'authored' };
    if (rel === 'project.json') return { category: 'author', reason: 'project' };
    return { category: 'other', reason: 'unclassified' };
  };

  function classifyArtifact(id: string, known: { simulated: boolean; generated: boolean } | undefined): string {
    // Anything the shared production closure reaches is protected, bucketed by
    // why it is reached. Intermediate inputs/producers of the current result
    // count as protected-current: dropping them would make that version's
    // export/review/reuse incomplete.
    const reason = closureArtifacts.get(id);
    if (reason !== undefined) {
      if (reason === 'retained') return 'protected-retained';
      if (reason === 'derived' || reason === 'frozen-derived') return 'protected-derived';
      if (reason === 'checkpoint') return 'protected-checkpoint';
      if (reason === 'generated') return 'protected-generated';
      return 'protected-current';
    }
    if (!closureAvailable) return 'undetermined'; // lineage unreadable -> never reclaimable
    if (currentArtifactId && id === currentArtifactId) return 'protected-current';
    if (retainedArtifacts.has(id)) return 'protected-retained';
    if (derivedArtifacts.has(id)) return 'protected-derived';
    if (known?.generated && !known.simulated) return 'protected-generated';
    if (versionArtifacts.has(id)) return 'undetermined';
    return 'rebuildable';
  }

  // Per-file records with (dev, inode) identity.
  interface FileRecord {
    rel: string;
    size: number;
    sha256: string | null;
    /** 64-bit identity; kept as bigint because file systems can use inodes > 2^53. */
    dev: bigint;
    ino: bigint;
    category: Category;
    reason: string;
    artifactClass?: string;
  }
  const records: FileRecord[] = [];
  for (const rel of files) {
    const abs = join(rootAbs, rel);
    let info;
    try {
      // `bigint: true` is REQUIRED: on file systems with 64-bit inodes (e.g.
      // Lustre) a JS `number` inode loses low bits and distinct files collide,
      // which would under-count `physicalBytes`. Symlink targets are read as text.
      info = await lstat(abs, { bigint: true });
    } catch {
      continue;
    }
    const size = info.isSymbolicLink() ? (await readlink(abs)).length : Number(info.size);
    const sha256 = info.isSymbolicLink() ? null : await hashFile(abs).catch(() => null);
    const { category, reason, artifactClass } = classify(rel);
    records.push({ rel, size, sha256, dev: info.dev, ino: info.ino, category, reason, artifactClass });
  }

  const categories: Record<string, UsageCategory> = {};
  for (const name of CATEGORY_ORDER) categories[name] = emptyCategory();
  const artifactClasses: Record<string, { files: number; logicalBytes: number; physicalBytes: number }> = {};

  // Physical attribution: one inode → strongest-reason category.
  const byInode = new Map<string, FileRecord[]>();
  for (const record of records) {
    const key = `${record.dev}:${record.ino}`;
    const list = byInode.get(key) ?? [];
    list.push(record);
    byInode.set(key, list);
  }
  const priority = new Map<string, number>(CATEGORY_ORDER.map((name, index) => [name, index]));

  const sharedWith = new Map<string, string[]>();
  for (const group of byInode.values()) {
    group.sort((a, b) => priority.get(a.category)! - priority.get(b.category)! || a.rel.localeCompare(b.rel));
    const owner = group[0];
    for (const other of group.slice(1)) {
      const list = sharedWith.get(other.rel) ?? [];
      list.push(owner.rel);
      sharedWith.set(other.rel, list);
    }
  }
  for (const record of records) {
    const category = categories[record.category];
    category.files += 1;
    category.logicalBytes += record.size;
    if (!category.reasons.includes(record.reason)) category.reasons.push(record.reason);
    // A hardlinked inode is charged to its strongest-reason owner only (the
    // priority-sorted first path); every other path that shares it is recorded
    // in `sharedWith` and adds nothing, so deleting that other path frees 0.
    if (!sharedWith.has(record.rel)) category.physicalBytes += record.size;
    if (record.category === 'artifacts' && record.artifactClass) {
      const bucket = (artifactClasses[record.artifactClass] ??= { files: 0, logicalBytes: 0, physicalBytes: 0 });
      bucket.files += 1;
      bucket.logicalBytes += record.size;
      if (!sharedWith.has(record.rel)) bucket.physicalBytes += record.size;
    }
  }

  // uniqueContentBytes: distinct sha256 per category.
  for (const name of CATEGORY_ORDER) {
    const seen = new Set<string>();
    let bytes = 0;
    for (const record of records) {
      if (record.category !== name || !record.sha256 || seen.has(record.sha256)) continue;
      seen.add(record.sha256);
      bytes += record.size;
    }
    categories[name].uniqueContentBytes = bytes;
  }

  // Output deliveries breakdown.
  const outputDirs = new Map<string, { files: number; logicalBytes: number; physicalBytes: number }>();
  for (const record of records) {
    if (record.category !== 'output') continue;
    const name = record.rel.split('/')[1] ?? record.rel;
    const bucket = outputDirs.get(name) ?? { files: 0, logicalBytes: 0, physicalBytes: 0 };
    bucket.files += 1;
    bucket.logicalBytes += record.size;
    if (!sharedWith.has(record.rel)) bucket.physicalBytes += record.size;
    outputDirs.set(name, bucket);
  }

  const totals = { files: records.length, logicalBytes: 0, uniqueContentBytes: 0, physicalBytes: 0 };
  for (const name of CATEGORY_ORDER) {
    totals.logicalBytes += categories[name].logicalBytes;
    totals.physicalBytes += categories[name].physicalBytes;
  }
  const uniqueContent = new Set<string>();
  for (const record of records) {
    if (!record.sha256 || uniqueContent.has(record.sha256)) continue;
    uniqueContent.add(record.sha256);
    totals.uniqueContentBytes += record.size;
  }

  // The reclaim estimate is EXACTLY the one clean plan's physical-byte total:
  // same candidates and protections (generated artifacts, lock/damaged files,
  // failed/preview snapshots, orphan content, duplicate compaction), so
  // `usage.reclaimablePhysicalBytes` can never disagree with what `viscraft
  // clean` would actually free for this same project. Guessing from whole
  // category buckets would follow a WRONG policy (e.g. call a completed
  // generated Artifact reclaimable). If no plan can be computed the estimate is
  // 0 with an explicit note, never silently overstated.
  let reclaimable = 0;
  let planError: string | null = null;
  try {
    reclaimable = (await planClean(rootAbs)).freedPhysicalBytes;
  } catch (error) {
    planError = error instanceof Error ? error.message : String(error);
  }
  const needsDecision = (artifactClasses.undetermined?.physicalBytes ?? 0) + categories.output.physicalBytes;

  const attention: string[] = [];
  if (categories.other.files > 0)
    attention.push(
      `${categories.other.files} file(s) outside the known layout are not classified; inspect them manually`,
    );
  if (planError !== null)
    attention.push(
      `reclaimable-bytes-unavailable: the clean plan could not be computed (${planError}); the reclaimable estimate is reported as 0`,
    );
  const cleanup = await incompleteCleanup(rootAbs);
  if (cleanup)
    attention.push(
      `cleanup-incomplete: ${cleanup.id} has ${cleanup.remaining} item(s) left; run \`viscraft clean <project> --resume\` or \`--abort\``,
    );

  return {
    root: rootAbs,
    categories,
    artifacts: artifactClasses,
    output: [...outputDirs.entries()].map(([name, value]) => ({ name, ...value })),
    totals,
    reclaimablePhysicalBytes: reclaimable,
    needsDecisionPhysicalBytes: needsDecision,
    attention,
    scope: {
      excluded: [...excluded.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, reason]) => ({ path, reason })),
    },
  };
}

async function readActiveArtifact(root: string): Promise<string | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    const value = JSON.parse(await readFile(join(resolve(root), '.viscraft/result.json'), 'utf8')) as {
      artifact?: string;
    };
    return typeof value.artifact === 'string' ? value.artifact : null;
  } catch {
    return null;
  }
}
