/**
 * The packaged model DEFINITIONS selectable without the caller writing a
 * `GenerationExtension`, keyed by the canonical identity a request already
 * carries: `(model.id, mapping.protocol)`.
 *
 * Why this key — the two model identities must not be conflated (see the
 * endpoint `model` field in `video-api.ts`):
 *  - CANONICAL model identity is the author's `source.model`; extension
 *    validation requires `extension.model.id === source.model` AND
 *    `extension.mapping.model === source.model` (`extension.ts`).
 *  - The DEPLOYMENT model alias is the optional `endpoint.model`; it only sets
 *    the wire field the service receives and never selects a definition or
 *    changes its validation rules.
 * So selection is `packagedExtensionFor(source.model, endpoint.protocol)` — never
 * `endpoint.model`. A single registry match auto-selects; zero matches leaves the
 * lane with no definition (an explicit extension, or a parameters-free generic
 * request, can still proceed); an explicit `options.extension` always wins.
 *
 * The duplicate-key rule is a REGISTRY ERROR: one canonical `(model, protocol)`
 * naming two packaged definitions would make selection non-deterministic, so it
 * is rejected at registry construction (and pinned by a test) rather than
 * silently resolved by first/last-wins.
 */
import type { GenerationExtension } from '../extension.js';
import type { VideoServiceProtocol } from '../lane.js';
import { isVendorProtocol } from '../lane.js';
import { seedance25ArkExtension } from './seedance-25.js';
import { minimaxH3Ref2vaExtension, minimaxH3Fl2vaExtension, minimaxH3OfficialExtension } from './minimax-h3.js';
import { runwayGen45Extension, gen4TurboExtension } from './runway-gen45.js';
import { wan30FalExtension } from './wan-30.js';

/** A packaged `GenerationExtension` factory (each call yields an independent copy). */
export type PackagedExtensionFactory = () => GenerationExtension;

/** The registry key: the canonical `(model.id, mapping.protocol)` a request carries. */
export function packagedModelKey(model: string, protocol: string): string {
  return `${model}\u0000${protocol}`;
}

/**
 * Build the immutable packaged registry from extension factories. Throws if two
 * factories register the SAME `(model.id, mapping.protocol)` — a configuration
 * error, never a silent first/last-wins choice.
 */
export function buildPackagedRegistry(
  factories: readonly PackagedExtensionFactory[],
): ReadonlyMap<string, GenerationExtension> {
  const registry = new Map<string, GenerationExtension>();
  for (const factory of factories) {
    const extension = factory();
    const key = packagedModelKey(extension.model.id, extension.mapping.protocol);
    if (registry.has(key))
      throw new Error(
        `Duplicate packaged model definition for key (model '${extension.model.id}', protocol '${extension.mapping.protocol}')`,
      );
    registry.set(key, extension);
  }
  return registry;
}

/**
 * The packaged video extensions, in ONE place so the registry, the Plan
 * `needsConfiguration` listing and the `doctor` model list can never disagree.
 */
export const PACKAGED_VIDEO_EXTENSIONS: readonly PackagedExtensionFactory[] = [
  runwayGen45Extension,
  gen4TurboExtension,
  wan30FalExtension,
  seedance25ArkExtension,
  minimaxH3Ref2vaExtension,
  minimaxH3Fl2vaExtension,
  minimaxH3OfficialExtension,
];

const PACKAGED_REGISTRY = buildPackagedRegistry(PACKAGED_VIDEO_EXTENSIONS);

/**
 * The packaged definition a request selecting `(model, protocol)` executes, or
 * `undefined` when no packaged definition names that canonical model for that
 * protocol. This is the ONE selection lookup shared by Plan, the ordinary Build
 * and the direct SDK (through `resolveEffectiveExtension`).
 */
export function packagedExtensionFor(model: string, protocol: string): GenerationExtension | undefined {
  return PACKAGED_REGISTRY.get(packagedModelKey(model, protocol));
}

/** The canonical models a protocol has a packaged definition for, sorted. */
export function packagedModelsForProtocol(protocol: string): string[] {
  return [...PACKAGED_REGISTRY.values()]
    .filter(extension => extension.mapping.protocol === protocol)
    .map(extension => extension.model.id)
    .sort();
}

/**
 * Whether a request MUST have a model definition to be prepared at all:
 *  - a VENDOR protocol lane always needs a mapping (it has no generic encoder);
 *  - a generic protocol (`vllm-omni-video` / `ark-video-v3`) can serve a
 *    parameters-free request without any definition, but a request that declares
 *    `parameters` needs the definition that owns their semantics.
 * Used only to decide whether a missing definition is a Plan `needsConfiguration`
 * rather than a legal parameters-free generic request.
 */
export function requiresModelDefinition(
  source: { model: string; parameters?: Record<string, unknown> },
  protocol: VideoServiceProtocol,
): boolean {
  if (isVendorProtocol(protocol) || protocol === 'minimax-video-v2') return true;
  if (PACKAGED_VIDEO_EXTENSIONS.some(factory => factory().model.id === source.model)) return true;
  return Object.keys(source.parameters ?? {}).length > 0;
}
