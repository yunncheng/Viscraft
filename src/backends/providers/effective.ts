/**
 * The ONE `resolveEffectiveExtension` every lane (and the Plan preflight) uses to
 * select the model DEFINITION + service mapping a `provider` request
 * executes. Kept in its own module so the adapters can resolve their effective
 * definition+mapping without importing the dispatcher (`video-service.ts`), which
 * would form an import cycle.
 *
 * Selection is by the CANONICAL identity the author already declared —
 * `(source.model, endpoint.protocol)` — never the deployment alias
 * `endpoint.model`. An explicit caller-supplied extension always wins and still
 * passes through the same `extension.ts` validation, so auto-selected and
 * explicitly-injected copies of a packaged extension share one request identity.
 */
import type { GenerationExtension } from './extension.js';
import type { VideoServiceProtocol } from './lane.js';
import { packagedExtensionFor } from './models/registry.js';

/**
 * The effective `GenerationExtension` a lane executes: the caller's explicit
 * one, else the packaged definition whose canonical `(model, protocol)` matches
 * the authored request, else undefined (generic protocols serve a parameters-free
 * request whose model names no packaged definition). Both Plan and Produce
 * resolve the SAME effective extension here, so the reference set, parameters and
 * implementation identity never diverge.
 */
export function resolveEffectiveExtension(
  sourceModel: string,
  protocol: VideoServiceProtocol,
  options: { extension?: GenerationExtension },
): GenerationExtension | undefined {
  return options.extension ?? packagedExtensionFor(sourceModel, protocol);
}

// The packaged registry owns the definition list used for request selection.
export { packagedExtensionFor, packagedModelsForProtocol } from './models/registry.js';
