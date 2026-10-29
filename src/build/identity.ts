import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, readdir, readFile } from 'node:fs/promises';
import { hashFile, stableHash } from '../shared/hash.js';
import {
  executorImplementationModules,
  type ResolvedSource,
  type ProviderOptions,
  type SoundSourceOutput,
  sourceExecutor,
  type SourceContext,
} from './executors/index.js';
import {
  type Source,
  type Project,
  type OutputSettings,
  type Asset,
  type MediaFraming,
  type FilmProject,
  type SoundTarget,
  requireComposition,
} from '../core/schema.js';
import { compositionFrames } from '../core/composition.js';
import { framesToSamples } from '../core/time.js';
import { assertSourceInputs } from './executors/shared.js';
import { runCommand } from '../shared/process.js';
import { findBrowser } from '../backends/browser/capture.js';
import { type BlenderOptions, resolveBlenderRuntime } from '../backends/blender/render.js';

export type { SoundSourceOutput } from './executors/index.js';

export type { ResolvedSource } from './executors/index.js';

/** The consuming programme's sound clock; a Source Take retains its native clock. */
export function soundContextForSource(
  project: Project,
  source: Source,
  target?: SoundTarget,
): SoundSourceOutput | undefined {
  if (target) return { sampleRate: target.sampleRate, channels: target.channels, samples: target.outputSamples };
  if (source.kind !== 'browser' || source.output !== 'sound') return undefined;
  const { output } = requireComposition(project);
  return {
    sampleRate: output.sampleRate,
    channels: output.channels,
    samples: framesToSamples(compositionFrames(project), output.fps, output.sampleRate, 'ceil'),
  };
}

export const RUNTIME_VERSION = 'viscraft-runtime-0.1.0-build-1';

export const RUNTIME_EXTENSION = path.extname(fileURLToPath(import.meta.url));

/**
 * The compiled runtime root (`dist/src`), found by ascending from this module
 * until the public entry `index.js`/`index.ts` is located. Used by the
 * implementation fingerprint and the operation-level renderer hashes so neither
 * depends on a flat `src/` layout.
 */
export async function runtimeRoot(): Promise<string> {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      await access(path.join(directory, `index${RUNTIME_EXTENSION}`));
      return directory;
    } catch {
      /* keep ascending */
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Cannot locate the runtime implementation root');
    directory = parent;
  }
}

/**
 * Global content manifest over every production module shipped in the runtime
 * tree (transitive dependencies included). Recorded in the Build environment for
 * provenance; it is deliberately NOT part of an operation's cache key — that is
 * `operationImplementation` below, which is scoped to the executing backend.
 */
export async function implementationManifest(root: string): Promise<string> {
  const extension = RUNTIME_EXTENSION;
  const entries: string[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) await walk(path.join(directory, item.name), relative);
      else if (item.name.endsWith(extension) && !item.name.endsWith('.d.ts')) entries.push(relative);
    }
  };
  await walk(root, '');
  entries.sort();
  const hashes = await Promise.all(entries.map(relative => hashFile(path.join(root, relative))));
  return stableHash(Object.fromEntries(entries.map((relative, index) => [relative, hashes[index]])));
}

/** Relative ESM specifiers (`./x.js`, `../y.js`) imported by a compiled module. */
function relativeImports(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) specifiers.push(match[1]);
  return specifiers;
}

/**
 * The relative module paths in the transitive import closure of `entries`, all
 * resolved inside `root`. Only relative in-runtime imports are followed, so the
 * set changes exactly when the modules that implement an operation — or any of
 * their transitive dependencies — change.
 */
async function moduleClosureMembers(root: string, entries: readonly string[]): Promise<string[]> {
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length > 0) {
    const relative = stack.pop()!;
    if (seen.has(relative) || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    let source: string;
    try {
      source = await readFile(path.join(root, relative), 'utf8');
    } catch {
      continue;
    }
    seen.add(relative);
    for (const specifier of relativeImports(source)) {
      stack.push(path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier)));
    }
  }
  return [...seen].sort();
}

/** Content hash of the transitive import closure of the given entry modules. */
async function moduleClosureHash(root: string, entries: readonly string[]): Promise<string> {
  const sorted = await moduleClosureMembers(root, entries);
  const hashes = await Promise.all(sorted.map(relative => hashFile(path.join(root, relative))));
  return stableHash(Object.fromEntries(sorted.map((relative, index) => [relative, hashes[index]])));
}

/** Leaf hash of a specific module set: its own bytes, imports NOT followed. */
async function leafHash(root: string, modules: readonly string[]): Promise<string> {
  const sorted = [...new Set(modules)].sort();
  const hashes = await Promise.all(sorted.map(relative => hashFile(path.join(root, relative))));
  return stableHash(Object.fromEntries(sorted.map((relative, index) => [relative, hashes[index]])));
}

/** Every compiled backend module, used as the conservative fallback closure. */
export async function backendEntries(root: string): Promise<string[]> {
  const entries: string[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) await walk(path.join(directory, item.name), relative);
      else if (item.name.endsWith(RUNTIME_EXTENSION) && !item.name.endsWith('.d.ts')) entries.push(relative);
    }
  };
  await walk(path.join(root, 'backends'), 'backends');
  return entries;
}

/**
 * Modules every `provider` Take reaches whose own imports are free of a
 * vendor adapter or vendor model/mapping: the job store, the validators, the
 * endpoint lane resolver and the protocol encoders. Kept import-clean and hashed
 * with their transitive imports, so the shared closure never leaks a vendor.
 *
 * Modules that DO eagerly import `effective.ts` (which itself imports EVERY
 * packaged vendor extension) are NOT listed here — they are leaf-hashed in
 * `VIDEO_ROUTING_LEAVES` instead, so an unrelated vendor's edit cannot leak in.
 */
const VIDEO_CORE_MODULES: readonly string[] = [
  `backends/media/picture${RUNTIME_EXTENSION}`,
  `backends/providers/local-media${RUNTIME_EXTENSION}`,
  `backends/providers/http-body${RUNTIME_EXTENSION}`,
  `backends/providers/job-store${RUNTIME_EXTENSION}`,
  `backends/providers/extension${RUNTIME_EXTENSION}`,
  `backends/providers/reference-facts${RUNTIME_EXTENSION}`,
  `backends/providers/lane${RUNTIME_EXTENSION}`,
  `backends/providers/services/video${RUNTIME_EXTENSION}`,
  `backends/providers/services/vllm-omni/video${RUNTIME_EXTENSION}`,
  `backends/providers/services/ark/video${RUNTIME_EXTENSION}`,
];

/**
 * Routing modules hashed as LEAVES (their own bytes, imports NOT followed):
 * they eagerly import `effective.ts`, and therefore every vendor. Including a
 * routing change in the key invalidates every video Take; not following their
 * imports keeps an unrelated vendor's edit out of this Take's closure.
 */
const VIDEO_ROUTING_LEAVES: readonly string[] = [
  `backends/providers/video-service${RUNTIME_EXTENSION}`,
  `backends/providers/prepare${RUNTIME_EXTENSION}`,
  `backends/providers/services/video-tasks${RUNTIME_EXTENSION}`,
  `backends/providers/effective${RUNTIME_EXTENSION}`,
];

/** The vendor adapter module(s) a specific video protocol executes. */
const VIDEO_PROTOCOL_ADAPTERS: Record<string, readonly string[]> = {
  'vllm-omni-video': [],
  'ark-video-v3': [],
  'minimax-video-v2': [`backends/providers/services/minimax/video${RUNTIME_EXTENSION}`],
  'runway-v1': [`backends/providers/services/runway/index${RUNTIME_EXTENSION}`],
  'fal-queue': [`backends/providers/services/fal/index${RUNTIME_EXTENSION}`],
};

/** The selected video implementation closure: protocol + its model/mapping files. */
export interface VideoOperationScope {
  /** The selected protocol, or undefined to fall back to the conservative closure. */
  protocol?: string;
  /** Absolute files of the effective model/mapping (from the extension). */
  implementationFiles?: readonly string[];
}

/**
 * The non-Source operation kinds (timeline/media work the scheduler runs) and the
 * backend modules each reaches. Source kinds are NOT listed here — the executor
 * registry owns them, so their module sets cannot drift from the executor that
 * runs them. A `browser` Source with a World binding additionally reaches the
 * world module (declared by its executor).
 */
const MEDIA_OPERATION_MODULES: Record<string, readonly string[]> = {
  'normalize-media': ['backends/media/picture' + RUNTIME_EXTENSION],
  'normalize-still': ['backends/media/picture' + RUNTIME_EXTENSION],
  'retime-clip': ['backends/media/retime' + RUNTIME_EXTENSION],
  'grade-picture': ['backends/media/picture' + RUNTIME_EXTENSION],
  'source-audio-trim': ['backends/media/audio-mix' + RUNTIME_EXTENSION],
  'compose-video': ['backends/media/picture' + RUNTIME_EXTENSION],
  'mix-audio': ['backends/media/audio-mix' + RUNTIME_EXTENSION],
  'mix-stem': ['backends/media/audio-mix' + RUNTIME_EXTENSION],
  'master-audio': ['backends/media/audio-master' + RUNTIME_EXTENSION],
  'preview-gap': ['backends/media/picture' + RUNTIME_EXTENSION],
  'preview-range': ['backends/media/picture' + RUNTIME_EXTENSION],
  'mux-final': ['backends/media/mux' + RUNTIME_EXTENSION],
  'overlay-picture-layers': ['backends/media/layers' + RUNTIME_EXTENSION],
  'overlay-subtitles': ['backends/media/subtitles' + RUNTIME_EXTENSION],
};

/** Relative, in-root module paths for a set of absolute implementation files. */
function relativeModules(root: string, files: readonly string[] | undefined): string[] {
  if (!files) return [];
  const out: string[] = [];
  for (const file of files) {
    const relative = path.relative(root, file);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) out.push(relative.split(path.sep).join('/'));
  }
  return out;
}

/**
 * Scoped implementation fingerprint for one operation kind: the content hash of
 * the backend modules the operation actually reaches — for a Source kind, the
 * modules its REGISTERED executor declares; for a timeline/media operation, its
 * declared module(s), together with their
 * transitive dependencies, and the scheduler module itself hashed as a leaf.
 * Editing the CLI, the public entry, or the analysis/delivery operations does not
 * change an operation's cache key; editing the scheduler, media, or a
 * participating backend does. Kinds without a precise mapping fall back to the
 * conservative backends-wide closure.
 */
export async function operationImplementation(
  root: string,
  kind: string,
  fallback: readonly string[],
  scope: VideoOperationScope = {},
): Promise<string> {
  const scheduler = await hashFile(path.join(root, `build/build${RUNTIME_EXTENSION}`));
  if (kind === 'provider') {
    if (scope.protocol === undefined) {
      // No selected protocol was supplied: fall back to the conservative
      // backends-wide closure rather than risk under-invalidating a Take.
      return stableHash({ scheduler, backend: await moduleClosureHash(root, fallback) });
    }
    const core = await moduleClosureHash(root, VIDEO_CORE_MODULES);
    // The selected vendor adapter and the routing modules eagerly import EVERY
    // vendor (through `effective.ts`), so they are hashed as LEAVES: their bytes
    // participate in the key (an adapter/routing change invalidates the Take) but
    // their imports are not followed, so an unrelated vendor's model/mapping edit
    // does not leak into this Take's closure. The SELECTED vendor's own
    // model/mapping files enter through `extension` below.
    const adapter = await leafHash(root, VIDEO_PROTOCOL_ADAPTERS[scope.protocol] ?? []);
    const routing = await leafHash(root, VIDEO_ROUTING_LEAVES);
    const extension = await moduleClosureHash(root, [...relativeModules(root, scope.implementationFiles)]);
    return stableHash({ scheduler, core, adapter, routing, extension });
  }
  const executorModules = executorImplementationModules(kind as Source['kind']);
  const modules = executorModules
    ? executorModules.map(module => `${module}${RUNTIME_EXTENSION}`)
    : (MEDIA_OPERATION_MODULES[kind] ?? fallback);
  const backend = await moduleClosureHash(root, [...modules]);
  return stableHash({ scheduler, backend });
}

/**
 * The relative modules a video operation scope actually hashes — split so a test
 * can prove cross-vendor isolation (a Runway closure must not list the fal
 * adapter or the Wan model, and vice versa). Diagnostics/test seam only; the
 * production fingerprint is `operationImplementation`.
 */
export async function videoOperationClosure(
  root: string,
  protocol: string,
  implementationFiles: readonly string[] = [],
): Promise<{ core: string[]; adapter: string[]; routing: string[]; extension: string[] }> {
  return {
    core: await moduleClosureMembers(root, VIDEO_CORE_MODULES),
    adapter: [...(VIDEO_PROTOCOL_ADAPTERS[protocol] ?? [])].sort(),
    routing: [...VIDEO_ROUTING_LEAVES].sort(),
    extension: await moduleClosureMembers(root, [...relativeModules(root, implementationFiles)]),
  };
}

/**
 * The always-present operation key environment: the runtime/node/platform facts
 * and the shared ffmpeg/ffprobe versions. Every operation's key includes exactly
 * this base; the optional tool facts ({@link KeyTools}) are added per operation
 * from the tools that operation actually executes, never as a single
 * Build-wide union. This is what keeps a Build that consumes a different
 * tool-kind set than its predecessor from re-keying unrelated operations:
 * only the operations whose OWN tools changed get a different key.
 */
export async function baseKeyEnvironment(): Promise<Record<string, string>> {
  return {
    runtime: RUNTIME_VERSION,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    ffmpeg: (await runCommand('ffmpeg', ['-version'])).split('\n')[0],
    ffprobe: (await runCommand('ffprobe', ['-version'])).split('\n')[0],
  };
}

/** The optional runtime tools whose versions enter an operation's cache key. */
export interface KeyTools {
  browser?: boolean;
  blender?: boolean;
}

/** The resolved browser's version fact (probed by running the resolved binary). */
export async function browserVersion(): Promise<string> {
  return (await runCommand(await findBrowser(), ['--version'])).trim();
}

/** The resolved Blender runtime's version fact (a binary or a Python with `bpy`). */
export async function blenderVersion(options?: BlenderOptions): Promise<string> {
  return (await resolveBlenderRuntime(options)).version;
}

/** A memoizing builder of an operation's key environment (one per Build/Plan). */
export interface OperationEnvironmentProbe {
  /** The always-present base facts, probed once. */
  base(): Promise<Record<string, string>>;
  /** The key environment for an operation executing exactly `needed` tools. */
  environment(needed: KeyTools): Promise<Record<string, string>>;
}

/**
 * Build operation key environments that probe each optional tool AT MOST ONCE.
 * `environment(tools)` returns the base plus only the tool facts `tools`
 * declares, so an operation that runs no browser/blender never carries — and
 * therefore never re-keys on — that tool's fact. An unused tool is never probed,
 * so it neither pressures nor blocks a run (its executor is simply never
 * consulted). Both the Build scheduler and the preflight construct their probes
 * this way over the SHARED `baseKeyEnvironment`/`browserVersion`/`blenderVersion`
 * facts, so a Source's operation key is identical in both.
 */
export function operationEnvironmentProbe(options: { blender?: BlenderOptions } = {}): OperationEnvironmentProbe {
  let basePromise: Promise<Record<string, string>> | undefined;
  const facts: { browser?: string; blender?: string } = {};
  const base = (): Promise<Record<string, string>> => (basePromise ??= baseKeyEnvironment());
  return {
    base,
    async environment(needed: KeyTools): Promise<Record<string, string>> {
      const environment = { ...(await base()) };
      if (needed.browser) environment.browser = facts.browser ??= await browserVersion();
      if (needed.blender) environment.blender = facts.blender ??= await blenderVersion(options.blender);
      return environment;
    },
  };
}

export interface SourceIdentity {
  kind: string;
  inputs: string[];
  parameters: unknown;
  simulated: boolean;
  /** The selected provider protocol, when the Source is a `provider` Take.
   * Used to scope the operation's implementation closure to the chosen vendor. */
  protocol?: string;
  /** Absolute model/mapping files of the effective extension, when any — part of
   * the selected vendor's implementation closure. */
  implementationFiles?: readonly string[];
  resolved: ResolvedSource;
}

/**
 * The exact `{ kind, inputs, parameters, simulated }` a Build feeds to
 * `execute()` for a Source Take, plus the resolved objects the work callback
 * needs. Both the scheduler and the preflight call this, so their key material is
 * identical by construction. The per-executor resolution and identity are owned
 * by the executor registry; the cross-executor `simulated` flag is assembled here
 * from the resolved references/bindings/World/media/recording plus the
 * executor's own test-only classification.
 */
export async function sourceOperationIdentity(
  project: Project,
  source: Source,
  options: { providers?: ProviderOptions },
  files: ReadonlyMap<string, string>,
  output: OutputSettings,
  loadRoot: string,
  sound?: SoundSourceOutput,
): Promise<SourceIdentity> {
  const executor = sourceExecutor(source);
  const context: SourceContext = { project, providers: options.providers, files, output, sound, loadRoot };
  await assertSourceInputs(source, files, loadRoot);
  const resolved = await executor.resolve(source, context);
  assertConsumedAssetsUsable(source, resolved, files);
  const parts = await executor.identify(source, resolved, context);
  const simulated =
    source.kind === 'simulated' ||
    executor.testOnly(source, options.providers) ||
    resolved.resolvedReferences.some(asset => asset.simulated) ||
    Boolean(resolved.mediaAsset?.simulated) ||
    Boolean(resolved.playableRecording?.simulated) ||
    resolved.bindingAssets.some(entry => entry.asset.simulated) ||
    resolved.worldAssets.some(asset => asset.simulated);
  return {
    kind: source.kind,
    inputs: parts.inputs,
    parameters: parts.parameters,
    simulated,
    ...(parts.protocol ? { protocol: parts.protocol } : {}),
    ...(parts.implementationFiles ? { implementationFiles: parts.implementationFiles } : {}),
    resolved,
  };
}

/**
 * A consumed Asset must be admitted by its DECLARED digest. The inventory keeps
 * the actual bytes of a damaged Asset as an author fact, but an operation may
 * never read those bytes under the old hash — that would key one payload as
 * another. Skipped for an unconsumed Asset, which is why a damaged unused file
 * does not block the Sources that never reference it.
 */
function assertConsumedAssetsUsable(
  source: Source,
  resolved: ResolvedSource,
  files: ReadonlyMap<string, string>,
): void {
  const candidates: Asset[] = [
    ...resolved.bindingAssets.map(entry => entry.asset),
    ...resolved.worldAssets,
    ...(resolved.mediaAsset ? [resolved.mediaAsset] : []),
    ...resolved.resolvedReferences,
  ];
  const seen = new Set<string>();
  for (const asset of candidates) {
    if (seen.has(asset.id)) continue;
    seen.add(asset.id);
    // For provider references, a missing file may be a legitimate resume of a
    // persisted submitted task. The executor's requestIssues/adapter boundary
    // decides whether the attempt is resumable or would need a fresh submit.
    // If bytes are present, however, they must still match the authored digest:
    // stale bytes cannot key a cached result or a request as the old Asset.
    if (source.kind === 'provider' && resolved.resolvedReferences.includes(asset)) {
      const digest = files.get(asset.path);
      if (digest !== undefined && digest !== asset.sha256)
        throw new Error(
          `Source ${source.id} consumes Asset ${asset.id} (\"${asset.path}\"), but its current bytes do not match the recorded Asset digest`,
        );
      continue;
    }
    assetInputDigest(asset, files, `Source ${source.id}`);
  }
}

/** Admit consumed Asset bytes under their declared identity, never under a stale hash. */
function assetInputDigest(asset: Asset, files: ReadonlyMap<string, string>, consumer: string): string {
  const digest = files.get(asset.path);
  if (digest === undefined)
    throw new Error(`${consumer} consumes Asset ${asset.id} ("${asset.path}"), whose authored bytes are not available`);
  if (digest !== asset.sha256)
    throw new Error(
      `${consumer} consumes Asset ${asset.id} ("${asset.path}"), but its current bytes do not match the recorded Asset digest`,
    );
  return digest;
}

/** Occluders are real composition inputs, subject to the same Asset admission as Sources. */
export function occluderInputAssets(project: FilmProject, files: ReadonlyMap<string, string>): Asset[] {
  return project.composition.transitions
    .filter(transition => transition.kind === 'occlude')
    .map(transition => {
      const consumer = `Occlusion transition ${transition.from}->${transition.to}`;
      const asset = project.assets.find(candidate => candidate.id === transition.occluder);
      if (!asset || asset.type !== 'image') throw new Error(`${consumer} requires image Asset ${transition.occluder}`);
      assetInputDigest(asset, files, consumer);
      return asset;
    });
}

/**
 * The operation identity for a picture interval whose picture comes from a
 * DIRECTLY referenced Asset. This is not a Source: the Asset is a machine
 * fact, so the executor registry (which owns Source kinds) does not apply.
 *
 * The identity includes:
 *  - the Asset BYTES (its `sha256`) as the ordered input;
 *  - the output settings, the framing and (for a still) the held frame count as
 *    the parameters, plus the Asset id itself;
 *  - the real `backends/media` implementation closure, added by
 *    `operationImplementation` for the operation kind.
 *
 * A VIDEO Asset is normalized to the output grid/fps through `normalizeMedia`
 * (duration and the source FPS/PTS→output mapping are preserved; playback speed
 * is never changed). An IMAGE Asset has no intrinsic clock, so it is encoded as
 * a still held for `outFrame` output-grid frames. Both are keyed on the Asset
 * hash, so a changed Asset, a changed framing, a changed output or a changed
 * media implementation re-keys the operation instead of reusing stale bytes.
 */
export interface AssetPictureIdentity {
  kind: 'normalize-media' | 'normalize-still';
  inputs: string[];
  parameters: unknown;
  simulated: boolean;
  /** Output-grid frames a still is encoded for (image Asset only). */
  stillFrames?: number;
}

export function assetPictureIdentity(
  asset: Asset,
  reference: { framing?: MediaFraming; outFrame: number },
  output: OutputSettings,
): AssetPictureIdentity {
  const still = asset.type === 'image';
  return {
    kind: still ? 'normalize-still' : 'normalize-media',
    inputs: [asset.sha256],
    parameters: {
      asset: asset.id,
      framing: reference.framing ?? null,
      output,
      ...(still ? { frames: reference.outFrame } : {}),
    },
    simulated: asset.simulated,
    ...(still ? { stillFrames: reference.outFrame } : {}),
  };
}
