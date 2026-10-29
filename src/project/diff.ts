/**
 * Structural diff of two Projects by stable id, plus the authored-file hash
 * changes. The ONE comparator Status, Plan `changes` and
 * Versions/Revert share, so "what changed" can never be reported
 * differently by two commands.
 *
 * It compares by id, never by array position: a re-ordered Placement is not a
 * change, and a Source whose id was replaced is a remove + an add. Field-level
 * differences are reported by field NAME (not value) so the output stays small
 * and never leaks media bytes.
 */
import type { Project } from '../core/schema.js';
import { stableHash } from '../shared/hash.js';

export type DiffChange = 'added' | 'removed' | 'modified';

export interface DiffEntry {
  id: string;
  change: DiffChange;
  /** Changed top-level field names (empty for added/removed). */
  fields: string[];
}

export interface FileDiffEntry {
  path: string;
  change: DiffChange;
}

export interface ProjectDiff {
  sources: DiffEntry[];
  assets: DiffEntry[];
  shots: DiffEntry[];
  scenes: DiffEntry[];
  placements: DiffEntry[];
  /** Picture layers of the composition, keyed by layer id. */
  layers: DiffEntry[];
  audio: DiffEntry[];
  subtitles: DiffEntry[];
  transitions: DiffEntry[];
  /** Named Worlds declared by the Project, keyed by world id. */
  worlds: DiffEntry[];
  /** Project `bindings` (name → Asset id), keyed by binding name. */
  bindings: DiffEntry[];
  looks: DiffEntry[];
  /** Direction-level transitions (`direction.transitions`), keyed by `from->to`. */
  directionTransitions: DiffEntry[];
  /** Editable still-image documents, keyed by document id. */
  imageDocuments: DiffEntry[];
  /** Still-image targets, keyed by target id. */
  imageTargets: DiffEntry[];
  /** Standalone sound targets, keyed by target id. */
  soundTargets: DiffEntry[];
  /** Changed scalar/object top-level composition fields not covered by a list. */
  composition: string[];
  /** Changed scalar top-level Project fields (e.g. `title`). */
  project: string[];
  /** Changed scalar top-level Direction fields (e.g. `intent`); its lists are diffed above. */
  direction: string[];
  /** Authored-file path → hash change. */
  files: FileDiffEntry[];
  /** Totals across every collection (files included). */
  counts: { added: number; removed: number; modified: number };
}

/** A stable key for an array element: its `id`, a transition's `from->to`, else its index. */
function keyOf(value: unknown, index: number): string {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.id === 'string') return record.id;
    if (typeof record.from === 'string' && typeof record.to === 'string') return `${record.from}->${record.to}`;
  }
  return `#${index}`;
}

function changedFields(before: unknown, after: unknown): string[] {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return [];
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed: string[] = [];
  for (const key of [...keys].sort()) if (stableHash(a[key] ?? null) !== stableHash(b[key] ?? null)) changed.push(key);
  return changed;
}

function diffList(before: readonly unknown[], after: readonly unknown[]): DiffEntry[] {
  const beforeKeys = new Map(before.map((value, index) => [keyOf(value, index), value]));
  const afterKeys = new Map(after.map((value, index) => [keyOf(value, index), value]));
  const out: DiffEntry[] = [];
  for (const [key, value] of beforeKeys) {
    const next = afterKeys.get(key);
    if (next === undefined) out.push({ id: key, change: 'removed', fields: [] });
    else {
      const fields = changedFields(value, next);
      if (fields.length > 0) out.push({ id: key, change: 'modified', fields });
    }
  }
  for (const key of afterKeys.keys()) if (!beforeKeys.has(key)) out.push({ id: key, change: 'added', fields: [] });
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function diffFiles(before: Record<string, string>, after: Record<string, string>): FileDiffEntry[] {
  const out: FileDiffEntry[] = [];
  for (const [path, hash] of Object.entries(before)) {
    if (!(path in after)) out.push({ path, change: 'removed' });
    else if (after[path] !== hash) out.push({ path, change: 'modified' });
  }
  for (const path of Object.keys(after)) if (!(path in before)) out.push({ path, change: 'added' });
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Diff a `name → id` record (Project `bindings`) by binding name. */
function diffRecord(before: Record<string, string>, after: Record<string, string>): DiffEntry[] {
  const out: DiffEntry[] = [];
  for (const name of Object.keys(before)) {
    if (!(name in after)) out.push({ id: name, change: 'removed', fields: [] });
    else if (before[name] !== after[name]) out.push({ id: name, change: 'modified', fields: ['asset'] });
  }
  for (const name of Object.keys(after)) if (!(name in before)) out.push({ id: name, change: 'added', fields: [] });
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Collection-typed top-level composition fields already diffed element-wise. */
const COMPOSITION_LISTS = ['scenes', 'shots', 'placements', 'layers', 'transitions', 'audio', 'subtitles'] as const;

export function diffProjects(
  before: Project,
  after: Project,
  beforeFiles: Record<string, string>,
  afterFiles: Record<string, string>,
): ProjectDiff {
  const bc = before.composition;
  const ac = after.composition;
  const composition: string[] = [];
  const keys = new Set([...(bc ? Object.keys(bc) : []), ...(ac ? Object.keys(ac) : [])]);
  for (const key of [...keys].sort()) {
    if ((COMPOSITION_LISTS as readonly string[]).includes(key)) continue;
    const bv = (bc as unknown as Record<string, unknown> | undefined)?.[key] ?? null;
    const av = (ac as unknown as Record<string, unknown> | undefined)?.[key] ?? null;
    if (stableHash(bv) !== stableHash(av)) composition.push(key);
  }

  // Scalar Project/Direction facts the collection diffs do not cover: a changed
  // `title` or `direction.intent` must never be reported as an empty diff.
  const project = stableHash(before.title) === stableHash(after.title) ? [] : ['title'];
  const direction = stableHash(before.direction.intent) === stableHash(after.direction.intent) ? [] : ['intent'];

  const diff: ProjectDiff = {
    sources: diffList(before.sources, after.sources),
    assets: diffList(before.assets, after.assets),
    shots: diffList(bc?.shots ?? [], ac?.shots ?? []),
    scenes: diffList(bc?.scenes ?? [], ac?.scenes ?? []),
    placements: diffList(bc?.placements ?? [], ac?.placements ?? []),
    layers: diffList(bc?.layers ?? [], ac?.layers ?? []),
    audio: diffList(bc?.audio ?? [], ac?.audio ?? []),
    subtitles: diffList(bc?.subtitles ?? [], ac?.subtitles ?? []),
    transitions: diffList(bc?.transitions ?? [], ac?.transitions ?? []),
    imageDocuments: diffList(before.imageDocuments, after.imageDocuments),
    imageTargets: diffList(before.imageTargets, after.imageTargets),
    soundTargets: diffList(before.soundTargets, after.soundTargets),
    worlds: diffList(before.worlds ?? [], after.worlds ?? []),
    bindings: diffRecord(
      (before.bindings ?? {}) as Record<string, string>,
      (after.bindings ?? {}) as Record<string, string>,
    ),
    looks: diffList(before.direction.looks, after.direction.looks),
    directionTransitions: diffList(before.direction.transitions, after.direction.transitions),
    composition,
    project,
    direction,
    files: diffFiles(beforeFiles, afterFiles),
    counts: { added: 0, removed: 0, modified: 0 },
  };

  let added = 0;
  let removed = 0;
  let modified = 0;
  for (const entry of [
    ...diff.sources,
    ...diff.assets,
    ...diff.shots,
    ...diff.scenes,
    ...diff.placements,
    ...diff.layers,
    ...diff.audio,
    ...diff.subtitles,
    ...diff.transitions,
    ...diff.imageDocuments,
    ...diff.imageTargets,
    ...diff.soundTargets,
    ...diff.worlds,
    ...diff.bindings,
    ...diff.looks,
    ...diff.directionTransitions,
  ]) {
    if (entry.change === 'added') added += 1;
    else if (entry.change === 'removed') removed += 1;
    else modified += 1;
  }
  for (const file of diff.files) {
    if (file.change === 'added') added += 1;
    else if (file.change === 'removed') removed += 1;
    else modified += 1;
  }
  modified += composition.length + project.length + direction.length;
  diff.counts = { added, removed, modified };
  return diff;
}

/** True when the diff has no structural or file change. */
export function diffIsEmpty(diff: ProjectDiff): boolean {
  return diff.counts.added === 0 && diff.counts.removed === 0 && diff.counts.modified === 0;
}

/** The authored files a Source reads (entry + resources; a browser recording too). */
export function authoredFilesOfSource(source: Project['sources'][number]): string[] {
  switch (source.kind) {
    case 'browser':
      return source.output === 'picture' && source.recording
        ? [source.entry, ...source.resources, source.recording]
        : [source.entry, ...source.resources];
    case 'blender':
      return [source.entry, ...source.resources];
    default:
      return [];
  }
}

function shotsOf(project: Project, sourceId: string): Set<string> {
  const shots = new Set<string>();
  for (const placement of project.composition?.placements ?? [])
    if (placement.source === sourceId) shots.add(placement.shot);
  return shots;
}

/**
 * Identity-change hints: a non-blocking warning that a stable identity was
 * replaced, so previously produced Takes will no longer be selected/reused.
 * Reported when a Source is removed and a same-kind Source is added that reads
 * the same authored file or serves the same Shot, and when every Placement id is
 * replaced while the intervals stay identical.
 */
export function identityHints(before: Project, after: Project): string[] {
  const hints: string[] = [];
  const removedSources = before.sources.filter(source => !after.sources.some(candidate => candidate.id === source.id));
  const addedSources = after.sources.filter(source => !before.sources.some(candidate => candidate.id === source.id));
  for (const old of removedSources) {
    const oldFiles = new Set(authoredFilesOfSource(old));
    const oldShots = shotsOf(before, old.id);
    for (const fresh of addedSources) {
      if (old.kind !== fresh.kind) continue;
      const sharedFile = authoredFilesOfSource(fresh).some(file => oldFiles.has(file));
      const sharedShot = [...shotsOf(after, fresh.id)].some(shot => oldShots.has(shot));
      if (sharedFile || sharedShot) {
        const why = [sharedFile ? 'the same authored file' : null, sharedShot ? 'the same Shot' : null]
          .filter(Boolean)
          .join(' and ');
        hints.push(
          `Source '${old.id}' looks replaced by '${fresh.id}' (same kind, ${why}); '${old.id}''s Takes will no ` +
            `longer be selected or reused — if you only changed parameters, keep the original Source id`,
        );
      }
    }
  }

  const beforePlacements = before.composition?.placements ?? [];
  const afterPlacements = after.composition?.placements ?? [];
  if (beforePlacements.length > 0 && beforePlacements.length === afterPlacements.length) {
    const signature = (p: (typeof beforePlacements)[number]): string =>
      `${p.shot}:${p.inFrame}:${p.outFrame}:${p.startFrame}`;
    const intervalsUnchanged =
      [...beforePlacements].map(signature).sort().join('|') === [...afterPlacements].map(signature).sort().join('|');
    const allIdsReplaced = beforePlacements.every(p => !afterPlacements.some(q => q.id === p.id));
    if (intervalsUnchanged && allIdsReplaced)
      hints.push(
        'every Placement id was replaced while the intervals are unchanged; the selected Takes are still reused, ' +
          'but stable authoring should keep Placement ids unless the edit is intentional',
      );
  }
  return hints;
}
