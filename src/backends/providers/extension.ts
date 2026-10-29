/** Trusted model and service extensions shared by image and video execution.
 * A generation extension selects exactly one definition and mapping; there is no
 * global registry, automatic fallback, or execution outside the normal provider
 * lane.
 */
import { z } from 'zod';
import { resolve, isAbsolute } from 'node:path';
import type { GenerateImageRequest, ProviderSource, MediaInfo, Reference } from '../../core/schema.js';
import { hashFile, stableHash } from '../../shared/hash.js';

/** A generation request: a video Source (`kind: 'provider'`) or an image request. */
export type GenerationSource = ProviderSource | GenerateImageRequest;
export interface GenerationModel {
  id: string;
  medium: 'image' | 'video';
  parameters: z.ZodType<Record<string, unknown>>;
  validate(source: GenerationSource, parameters: Record<string, unknown>, settings: Record<string, unknown>): void;
  validateReference?(reference: Reference, media: MediaInfo, audioCodecs: readonly string[]): void;
  validateReferenceSet?(source: GenerationSource, facts: readonly ReferenceFacts[]): void;
}
export interface ReferenceFacts {
  reference: Reference;
  bytes: number;
  width?: number;
  height?: number;
  duration?: number;
  format?: string;
}
export interface MappingReference extends Reference {
  sha256: string;
  mime: string;
  bytes: Uint8Array;
  /**
   * The reference's real byte size when its payload is NOT carried (a preflight
   * stub has `bytes` empty but `byteLength` set from the Asset's file size), so
   * the transport-size checks can run at preflight. When `bytes` is real this is
   * redundant (`byteLength ?? bytes.length`).
   */
  byteLength?: number;
  locator?: string;
}
/** Reference identity for recovery; deliberately carries no bytes or payload.
 * Identity callbacks receive this type so they cannot accidentally encode a
 * missing reference payload as though it were a real file. */
export interface MappingReferenceIdentity extends Reference {
  sha256: string;
  mime?: string;
  locator?: string;
}
export interface ServiceMapping {
  model: string;
  protocol: string;
  /** Default name sent to this service; endpoint.model may supply a deployment alias. */
  wireModel?: string;
  validate(source: GenerationSource, parameters: Record<string, unknown>, settings: Record<string, unknown>): void;
  validateReferenceSet?(source: GenerationSource, facts: readonly ReferenceFacts[]): void;
  videoBody?(
    source: ProviderSource,
    parameters: Record<string, unknown>,
    wireModel: string,
    references: readonly MappingReference[],
  ): Record<string, unknown>;
  imageFields?(
    source: GenerateImageRequest,
    parameters: Record<string, unknown>,
  ): Record<string, string | number | boolean>;
  /**
   * Canonical identity of the request this mapping shapes: the routing it selects
   * and every non-secret wire field, with reference payloads represented by their
   * type, role and content hash — NEVER raw bytes, base64 data URIs, credentials
   * or temp filenames. Used for the frozen per-attempt request hash so a change to
   * the mapping's encoding (or to a reference) invalidates a previous paid task
   * instead of silently reusing it.
   */
  requestIdentity?(
    source: GenerationSource,
    parameters: Record<string, unknown>,
    wireModel: string,
    references: readonly MappingReferenceIdentity[],
  ): unknown;
  /** Scalar/body identity for request recovery without reading transmitted media.
   * It must match the non-media fields returned by `videoBody` for this request. */
  identityBody?(
    source: ProviderSource,
    parameters: Record<string, unknown>,
    wireModel: string,
    references: readonly MappingReferenceIdentity[],
  ): Record<string, unknown>;
}
export interface GenerationExtension {
  model: GenerationModel;
  mapping: ServiceMapping;
  /** Absolute files covering this trusted extension and its implementation
   * dependencies. Re-read hashes at preflight/execution, never trust a supplied
   * version string as proof of the code that produced a paid request.
   */
  implementationFiles: readonly string[];
}
export interface GenerationExtensionOptions {
  extension?: GenerationExtension;
  modelSettings?: Record<string, unknown>;
}

export function validateGenerationExtension(
  source: GenerationSource,
  protocol: string,
  options: GenerationExtensionOptions,
): Record<string, unknown> {
  const extension = options.extension;
  if (!extension) {
    if (Object.keys(source.parameters ?? {}).length)
      throw new Error(`Model ${source.model}: parameters require a configured model definition and service mapping`);
    return {};
  }
  if (extension.model.id !== source.model || extension.mapping.model !== source.model)
    throw new Error('Generation extension model does not match the authored request');
  // A `provider` Source is video; a `GenerateImageRequest` (which carries no
  // Source `kind`) is image.
  if (extension.model.medium !== ('kind' in source ? 'video' : 'image'))
    throw new Error('Generation extension has the wrong output medium');
  if (extension.mapping.protocol !== protocol)
    throw new Error('Generation extension mapping does not match the selected protocol');
  if (!extension.implementationFiles.length || extension.implementationFiles.some(file => !isAbsolute(file)))
    throw new Error('Generation extension needs absolute implementationFiles covering its code and dependencies');
  const parameters = extension.model.parameters.parse(source.parameters ?? {});
  const settings = options.modelSettings ?? {};
  // Establish that this service serves the operation before checking detailed
  // model rules for it (e.g. a fixed FL2VA deployment has no Ref2VA operation).
  extension.mapping.validate(source, parameters, settings);
  extension.model.validate(source, parameters, settings);
  if ('kind' in source && !extension.mapping.videoBody) throw new Error('Video extension needs a request mapping');
  if (!('kind' in source) && !extension.mapping.imageFields) throw new Error('Image extension needs a request mapping');
  return parameters;
}

export async function generationExtensionIdentity(options: GenerationExtensionOptions): Promise<string> {
  const extension = options.extension;
  if (!extension) return stableHash({ modelSettings: options.modelSettings ?? {} });
  const files = [...new Set(extension.implementationFiles.map(file => resolve(file)))].sort();
  const hashes = await Promise.all(files.map(file => hashFile(file)));
  return stableHash({
    model: extension.model.id,
    medium: extension.model.medium,
    protocol: extension.mapping.protocol,
    wireModel: extension.mapping.wireModel ?? null,
    implementation: hashes,
    modelSettings: options.modelSettings ?? {},
    // Include the actual loaded functions too: replacing an in-memory handler
    // while claiming the same files must not reuse a previous paid request.
    handlers: [
      extension.model.validate,
      extension.model.validateReference,
      extension.model.validateReferenceSet,
      extension.mapping.validate,
      extension.mapping.validateReferenceSet,
      extension.mapping.videoBody,
      extension.mapping.imageFields,
      extension.mapping.requestIdentity,
    ].map(fn => fn?.toString() ?? null),
  });
}

/** Model rules and the selected service's reference subset use the same facts. */
export function validateGenerationReferenceSet(
  extension: GenerationExtension,
  source: GenerationSource,
  facts: readonly ReferenceFacts[],
): void {
  extension.model.validateReferenceSet?.(source, facts);
  extension.mapping.validateReferenceSet?.(source, facts);
}
