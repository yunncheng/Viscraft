/**
 * The executor registry: the ONE place that maps a Source
 * `kind` to the module owning that executor's responsibilities. The generic
 * Plan/Build/identity layers resolve an executor here and call the shared
 * {@link SourceExecutor} interface, so "which executor runs this Source and what
 * does it need" is resolved in one place.
 *
 * Timeline assembly, task locks, Artifact/Take registration, clean protection and
 * packing safety deliberately stay in the generic layer and are NOT reachable
 * from here (no second record store, no cycle).
 */
import type { Source } from '../../core/schema.js';
import { blenderExecutor } from './blender.js';
import { browserExecutor } from './browser.js';
import { providerExecutor } from './generation.js';
import { simulatedExecutor } from './simulated.js';
import type { SourceExecutor } from './types.js';

export type {
  ExecutorIssue,
  ExecutorPlanLevel,
  ExecutorPreflightOut,
  ProduceContext,
  ProduceOutcome,
  ProviderOptions,
  ResolvedSource,
  SourceContext,
  SourceExecutor,
  SoundSourceOutput,
  SourceIdentityParts,
} from './types.js';

const sourceExecutors: ReadonlyMap<Source['kind'], SourceExecutor> = new Map<Source['kind'], SourceExecutor>([
  [browserExecutor.kind, browserExecutor],
  [blenderExecutor.kind, blenderExecutor],
  [providerExecutor.kind, providerExecutor],
  [simulatedExecutor.kind, simulatedExecutor],
]);

/** The executor for a Source. Every schema `kind` has exactly one entry. */
export function sourceExecutor(source: Source): SourceExecutor {
  const executor = sourceExecutors.get(source.kind);
  if (!executor) throw new Error(`No executor is registered for Source kind "${source.kind}"`);
  return executor;
}

/** The executor for a Source kind, or `undefined` for a non-Source operation kind. */
export function executorFor(kind: Source['kind']): SourceExecutor | undefined {
  return sourceExecutors.get(kind);
}

/**
 * The extension-less runtime module paths an executor's Take reaches. The caller
 * (`build/identity.ts`) appends the active runtime extension, so this module
 * stays free of the `RUNTIME_EXTENSION` constant and the identity module owns
 * that. `undefined` for a non-Source operation kind.
 */
export function executorImplementationModules(kind: Source['kind']): readonly string[] | undefined {
  return sourceExecutors.get(kind)?.implementationModules;
}
