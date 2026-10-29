/**
 * Shared helpers for the executor registry. These are small, executor-agnostic
 * pieces — the empty resolution shape, the browser binding record, and the
 * binding/World resolution + input-hash assembly the browser and Blender
 * executors share (they consume the same `bindings` / `world` schema).
 */
import { loadRecording } from '../../backends/playable/recording.js';
import { resolveSourceBindings, resolveWorldBinding } from '../../project/project.js';
import { stableHash } from '../../shared/hash.js';
import { sourceFilePaths } from '../../project/source-files.js';
import type { Asset, Project, Source, WorldRef } from '../../core/schema.js';
import type { ResolvedSource } from './types.js';

/** The bound code-family Source union (browser picture/sound, blender). */
export type BoundSource = Extract<Source, { kind: 'browser' | 'blender' }>;

/** The World binding a bound Source carries, if any (picture/Blender only). */
export function worldRefOf(source: BoundSource): WorldRef | undefined {
  if (source.kind === 'blender') return source.world;
  return source.output === 'picture' ? source.world : undefined;
}

/** An all-empty resolution, for the executors that resolve nothing beyond themselves. */
export function emptyResolved(): ResolvedSource {
  return {
    bindingAssets: [],
    resolvedWorld: undefined,
    worldAssets: [],
    mediaAsset: undefined,
    playableRecording: undefined,
    resolvedReferences: [],
    generationReferences: [],
  };
}

/**
 * The frozen digest of one authored input a Source reads. A missing path is a
 * hard error naming the Source, never an `undefined` that silently becomes part
 * of an operation key.
 */
export class SourceInputError extends Error {
  constructor(
    readonly sourceId: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SourceInputError';
  }
}

export function inputDigest(files: ReadonlyMap<string, string>, path: string, sourceId: string): string {
  const digest = files.get(path);
  if (digest === undefined)
    throw new SourceInputError(
      sourceId,
      `Source ${sourceId}: authored input "${path}" is not available in the frozen closure`,
    );
  return digest;
}

/** Admit the canonical authored closure only for a Source this run consumes. */
export async function assertSourceInputs(
  source: Source,
  files: ReadonlyMap<string, string>,
  root: string,
): Promise<void> {
  try {
    for (const file of await sourceFilePaths(source, root)) inputDigest(files, file, source.id);
  } catch (error) {
    if (error instanceof SourceInputError) throw error;
    throw new SourceInputError(
      source.id,
      `Source ${source.id}: authored input closure is unavailable (${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    );
  }
}

/** The `{ binding -> { id, path, sha256 } }` record the browser captures consume. */
export function browserBindings(
  bindingAssets: Array<{ binding: string; asset: Asset }>,
): Record<string, { id: string; path: string; sha256: string }> {
  return Object.fromEntries(
    bindingAssets.map(entry => [
      entry.binding,
      { id: entry.asset.id, path: entry.asset.path, sha256: entry.asset.sha256 },
    ]),
  );
}

/**
 * Resolve a bound Source's Project bindings, optional shared World and (for a
 * recorded-session-replay browser Source) its recording. Browser and Blender
 * executors share this resolution and the resulting input identities.
 */
export async function resolveBoundSource(
  project: Project,
  source: BoundSource,
  loadRoot: string,
): Promise<ResolvedSource> {
  const bindingAssets = resolveSourceBindings(project, source);
  const resolvedWorld = resolveWorldBinding(project, worldRefOf(source), source);
  const worldAssets = resolvedWorld
    ? [...new Set(resolvedWorld.entities.map(entity => entity.asset))].map(id =>
        project.assets.find(asset => asset.id === id)!,
      )
    : [];
  const playableRecording =
    source.kind === 'browser' && source.output === 'picture' && source.recording
      ? await loadRecording(loadRoot, source.recording)
      : undefined;
  return { ...emptyResolved(), bindingAssets, resolvedWorld, worldAssets, playableRecording };
}

/**
 * The operation input hashes for a bound Source: its entry + resources (frozen
 * digests), the resolved binding asset hashes, a recorded-session replay's own
 * digest, and the shared World snapshot hash + its Asset hashes — in the exact
 * order the previous identity function used, so reordering anything changes the
 * cache key.
 */
export function boundInputs(
  source: BoundSource,
  resolved: ResolvedSource,
  files: ReadonlyMap<string, string>,
): string[] {
  const inputs = [source.entry, ...source.resources].map(file => inputDigest(files, file, source.id));
  inputs.push(...resolved.bindingAssets.map(entry => entry.asset.sha256));
  if (source.kind === 'browser' && source.output === 'picture' && source.recording)
    inputs.push(inputDigest(files, source.recording, source.id));
  if (resolved.resolvedWorld)
    inputs.push(stableHash(resolved.resolvedWorld), ...resolved.worldAssets.map(asset => asset.sha256));
  return inputs;
}
