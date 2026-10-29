import { minimaxVideoProtocol, MINIMAX_BODY_BYTES } from './services/minimax/video.js';
/**
 * The ONE read-only request-preparation pipeline for a `provider`
 * Source. Plan (`build/plan.ts`), the ordinary Build / direct SDK
 * (`video-service.ts`) and every adapter (`runway.ts`, `fal.ts`, `video-api.ts`)
 * call it, so they cannot drift into their own validation orders.
 *
 * Order (never re-ordered per caller):
 *   resolve the lane → resolve the effective model definition + service
 *   mapping → normalize parameters + service-subset validation + model
 *   validation → build the service mapping body → protocol encode → request
 *   identity.
 *
 * It performs NO network call, NO upload and NO job/lock write, and it reads no
 * media: when the caller has already resolved the ordered reference payloads
 * (an adapter, which must read the frozen bytes to transmit them) it uses them
 * verbatim; otherwise it builds reference STUBS that carry the real content
 * sha256 (from the caller's `options.references` Assets) and role/order but no
 * bytes, so a Plan preflight can exercise the mapping and the protocol encoder
 * without touching any file.
 *
 * The request identity is the protocol's / mapping's canonical semantic identity
 * (routing + fields + reference type/order/role/content hash) — never a hash of
 * the raw wire body, which contains base64 reference payloads and a random
 * multipart boundary.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { SourceSchema } from '../../core/schema.js';
import type { ProviderSource } from '../../core/schema.js';
import { stableHash } from '../../shared/hash.js';
import {
  isVendorProtocol,
  protocolReferenceLimit,
  protocolTransmitsReference,
  resolveVideoLane,
  transmittedReferences,
  type VideoLaneResolution,
  type VideoServiceProtocol,
} from './lane.js';
import {
  ARK_BODY_BYTES,
  FAL_DATA_URI_BYTES,
  FAL_IMAGE_RAW_BYTES,
  RUNWAY_DATA_URI_BYTES,
  RUNWAY_IMAGE_RAW_BYTES,
  VIDEO_API_AUDIO_BYTES,
  VIDEO_API_IMAGE_BYTES,
  VIDEO_API_VIDEO_BYTES,
  dataUriEncodedBytes,
} from './transfer-bounds.js';
import { requiresModelDefinition } from './models/registry.js';
import { resolveEffectiveExtension } from './effective.js';
import {
  validateGenerationExtension,
  type GenerationExtension,
  type MappingReference,
  type MappingReferenceIdentity,
} from './extension.js';
import { vllmOmniVideoProtocol } from './services/vllm-omni/video.js';
import { arkVideoProtocol } from './services/ark/video.js';
import type { VideoProtocol } from './services/video.js';
import type { VideoReferenceInput } from './reference-facts.js';

/**
 * The minimal caller configuration the preparation pipeline reads. A full
 * `VideoApiOptions` satisfies it structurally; a vendor adapter may inject its
 * own protocol while leaving `baseUrl` to the lane default.
 */
export interface PrepareVideoOptions {
  endpoint?:
    | {
        protocol?: string;
        sourceModel?: string;
        baseUrl?: string;
        model?: string;
        credential?: string;
        modelSettings?: Record<string, unknown>;
      }
    | undefined;
  testOnly?: { baseUrl: string } | undefined;
  extension?: GenerationExtension | undefined;
  references?: VideoReferenceInput[] | undefined;
  referenceLocators?: Record<string, { url: string; sha256: string }> | undefined;
}

/** The frozen, read-only result of preparing one `provider` request. */
export interface PreparedVideoRequest {
  /** The canonical, `SourceSchema`-parsed Source this request was prepared from. */
  readonly source: ProviderSource;
  readonly protocol: VideoServiceProtocol;
  readonly baseUrl: string;
  readonly testOnly: boolean;
  readonly wireModel: string;
  /** The model's own parameter schema-normalized parameters. */
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly extension: GenerationExtension | undefined;
  /** The service mapping body, built from the supplied references (or stubs). */
  readonly mappingBody: Record<string, unknown> | undefined;
  /** The protocol-encoded body (multipart `FormData` / Ark JSON string); generic protocols only. */
  readonly encodedBody: FormData | string | undefined;
  readonly requestIdentity: unknown;
  readonly uploadAssetIds: readonly string[];
  readonly credentialName?: string;
  readonly credentialPresent: boolean;
  /** Endpoint/routing identity (`stableHash` over protocol + base + wire model + settings). */
  readonly endpointIdentity: string;
  /** The fal queue route facet, present only for `fal-queue` and always non-empty. */
  readonly endpointId?: string;
}

const FAL_PROTOCOL = 'fal-queue';

/**
 * The routing identity of a resolved lane: protocol, base URL, wire model,
 * deployment settings and (in production) the credential NAME — never a
 * credential value. Shared so a saved record and a later read-only check agree
 * on what "the same service" means without re-reading media.
 */
export function endpointIdentityOf(
  lane: VideoLaneResolution,
  modelSettings: Record<string, unknown> | undefined,
  credential: string | undefined,
): string {
  return lane.testOnly
    ? stableHash({
        protocol: lane.protocol,
        baseUrl: lane.baseUrl,
        wireModel: lane.wireModel,
        modelSettings: modelSettings ?? null,
        fixture: true,
      })
    : stableHash({
        protocol: lane.protocol,
        baseUrl: lane.baseUrl,
        wireModel: lane.wireModel,
        modelSettings: modelSettings ?? null,
        credential: credential ?? null,
      });
}

function genericVideoProtocol(protocol: VideoServiceProtocol): VideoProtocol {
  if (protocol === 'ark-video-v3') return arkVideoProtocol;
  if (protocol === 'minimax-video-v2') return minimaxVideoProtocol;
  if (protocol === 'vllm-omni-video') return vllmOmniVideoProtocol;
  throw new Error(`Video preparation: protocol '${protocol}' is not handled by the shared video task transport`);
}

/**
 * Reference STUBS for a caller that has not read the frozen bytes: the declared
 * type/role/order for the references this protocol's transport actually carries,
 * the real content sha256 (and locator) from the caller's Assets, but no bytes and
 * no detected mime. Sufficient for every mapping's request identity (which carries
 * references by type/role/sha256) and for the protocol encoders' structural
 * checks, and identical in count/role/order to the payloads an adapter later
 * resolves, so a Plan preflight and execution cannot disagree.
 */
function referenceStubs(
  source: ProviderSource,
  options: PrepareVideoOptions,
  protocol: VideoServiceProtocol,
): MappingReference[] {
  const byId = new Map((options.references ?? []).map(input => [input.asset?.id, input]));
  return transmittedReferences(protocol, source.references ?? []).map(reference => {
    const input = byId.get(reference.asset);
    const locator = options.referenceLocators?.[reference.asset]?.url;
    // The real byte size is metadata (a `stat`, no media read): carrying it on the
    // stub lets the transport-size checks run at PREFLIGHT (see
    // `assertTransferBounds`) instead of only when the bytes are finally read.
    const byteLength = input ? statSize(join(input.root, input.asset.path)) : undefined;
    return {
      asset: reference.asset,
      sha256: input?.asset.sha256 ?? '',
      category: reference.category,
      role: reference.role,
      mime: '',
      bytes: new Uint8Array(0),
      ...(byteLength !== undefined ? { byteLength } : {}),
      ...(locator ? { locator } : {}),
    };
  });
}

/** The size of a reference file, or undefined when it is not a readable regular file. */
function statSize(abs: string): number | undefined {
  try {
    const info = statSync(abs);
    return info.isFile() ? info.size : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Enforce the client-side TRANSFER caps of the selected protocol on the reference
 * set at PREFLIGHT, using the real reference byte sizes (a stub carries them as
 * `byteLength`) — so an oversized reference is a Plan blocker with no POST. Each
 * adapter keeps its own byte-exact guard as the final check on the real bytes.
 */
function assertTransferBounds(
  protocol: VideoServiceProtocol,
  references: readonly MappingReference[],
  encodedBody: FormData | string | undefined,
  label: string,
): void {
  const sizeOf = (reference: MappingReference): number => reference.byteLength ?? reference.bytes.length;
  if (protocol === 'fal-queue' || protocol === 'runway-v1') {
    const raw = protocol === 'fal-queue' ? FAL_IMAGE_RAW_BYTES : RUNWAY_IMAGE_RAW_BYTES;
    const dataUri = protocol === 'fal-queue' ? FAL_DATA_URI_BYTES : RUNWAY_DATA_URI_BYTES;
    for (const reference of references) {
      if (reference.category !== 'image') continue;
      const size = sizeOf(reference);
      if (size > raw)
        throw new Error(
          `${label}: reference image '${reference.asset}' is ${size} bytes, over the ${raw}-byte raw transfer limit`,
        );
      if (dataUriEncodedBytes(reference.mime, size) > dataUri)
        throw new Error(
          `${label}: reference image '${reference.asset}' encodes to a data URI over the ${dataUri}-byte transfer cap`,
        );
    }
    return;
  }
  if (protocol === 'minimax-video-v2') {
    for (const ref of references) {
      const cap =
        ref.category === 'audio' ? 15 * 1024 * 1024 : ref.category === 'image' ? 30 * 1024 * 1024 : 50 * 1024 * 1024;
      if (sizeOf(ref) > cap) throw new Error(`${label}: MiniMax reference ${ref.category} exceeds ${cap} bytes`);
    }
  }
  if (protocol === 'vllm-omni-video') {
    for (const reference of references) {
      const cap =
        reference.category === 'image'
          ? VIDEO_API_IMAGE_BYTES
          : reference.category === 'video'
            ? VIDEO_API_VIDEO_BYTES
            : VIDEO_API_AUDIO_BYTES;
      const size = sizeOf(reference);
      if (size > cap)
        throw new Error(
          `${label}: reference ${reference.category} '${reference.asset}' is ${size} bytes, over the ${cap}-byte transfer limit`,
        );
    }
    return;
  }
  if (protocol === 'ark-video-v3' || protocol === 'minimax-video-v2') {
    // These bodies are JSON; inline data URIs (a reference WITHOUT a hosted
    // locator) dominate it. The encoder that produced `encodedBody` already
    // inlined the base64 of every payload it was handed, so add ONLY the base64
    // the body does NOT yet contain. A Plan preflight STUB carries the real
    // `byteLength` but empty `bytes` (the body holds just the `data:;base64,`
    // header), so `declared` expands to the full base64 — behaviour unchanged. An
    // adapter payload carries the real `bytes` (`encoded === declared`), so the
    // delta is 0 and the same bytes are never counted twice.
    const bodyBytes = typeof encodedBody === 'string' ? Buffer.byteLength(encodedBody) : 0;
    let inline = 0;
    for (const reference of references) {
      if (reference.locator) continue;
      const declared = sizeOf(reference);
      const encoded = reference.bytes.length;
      const extra = 4 * Math.ceil(declared / 3) - 4 * Math.ceil(encoded / 3);
      if (extra > 0) inline += extra;
    }
    const bodyLimit = protocol === 'minimax-video-v2' ? MINIMAX_BODY_BYTES : ARK_BODY_BYTES;
    const serviceName = protocol === 'minimax-video-v2' ? 'MiniMax' : 'Ark';
    if (bodyBytes + inline > bodyLimit)
      throw new Error(
        `${label}: the ${serviceName} request body is ~${bodyBytes + inline} bytes, over the ${bodyLimit}-byte limit; use authorized hosted media locators`,
      );
  }
}

/** The fal queue route pattern: one or more id path segments, e.g. `alibaba/wan-3.0/image-to-video`. */
const FAL_ENDPOINT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/**
 * Validate a fal queue `endpointId` as a ROUTE, not merely a non-empty string.
 * The value is the endpoint PATH the queue submits/recovers on, so it must be one
 * or more non-empty id path segments: no whitespace, no leading/trailing or
 * doubled slash, no `.`/`..` traversal segment and no query or fragment. The value
 * is validated as-is and never rewritten into a different route.
 */
function validateFalEndpointId(candidate: unknown, label: string): string {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new Error(`${label}: the fal queue mapping must declare a non-empty endpointId for queue routing`);
  }
  if (!FAL_ENDPOINT_ID_PATTERN.test(candidate)) {
    throw new Error(
      `${label}: the fal queue endpointId '${candidate}' is not a valid queue route; it must be one or more id path segments ` +
        'with no whitespace, path traversal, query or fragment',
    );
  }
  return candidate;
}

/**
 * Prepare one `provider` request read-only. Throws a normal `Error` on a
 * malformed lane, an invalid request or a mapping/encoding failure; callers map
 * that to their own error type or Plan blocker code.
 *
 * `references` are the caller's already-resolved ordered reference payloads
 * (adapter path). Omitted for the Plan/SDK preflight, which uses stubs.
 * `identityOnly` is reserved for recovery of an already-recorded attempt: it
 * accepts metadata-only reference identities, invokes no upload body or encoder,
 * and returns no `encodedBody`. Callers must compare the resulting full hash to
 * the frozen job request before any remote query or local task state change.
 */
export function prepareVideoRequest(
  source: ProviderSource,
  options: PrepareVideoOptions = {},
  references?: readonly (MappingReference | MappingReferenceIdentity)[],
  label = 'Video preflight',
  identityOnly = false,
): PreparedVideoRequest {
  const parsed = SourceSchema.safeParse(source);
  if (!parsed.success || parsed.data.kind !== 'provider') {
    throw new Error(`${label}: expected a valid provider Source`);
  }
  const src = parsed.data;
  if (options.endpoint?.sourceModel && options.endpoint.sourceModel !== src.model)
    throw new Error(
      `${label}: configured model '${options.endpoint.sourceModel}' does not match Source.model '${src.model}'`,
    );
  const lane = resolveVideoLane(options, src, label);
  // A declared reference this protocol's transport cannot carry is refused HERE —
  // the one read-only preparation every entry point runs — so it is a Plan
  // blocker, a Build rejection and a direct-SDK rejection alike, never silently
  // dropped or only discovered once an adapter starts encoding.
  for (const reference of src.references ?? []) {
    if (!protocolTransmitsReference(lane.protocol, reference)) {
      throw new Error(
        `${label}: protocol '${lane.protocol}' cannot transmit reference Asset '${reference.asset}' ` +
          `(category '${reference.category}', role '${reference.role}'); the request was refused before any upload or submission`,
      );
    }
  }
  // A protocol may also cap the COUNT of references it carries (not just their
  // kinds); enforcing it here keeps the transmitted set — and thus the
  // upload-consent scope — identical on Plan, Build and the direct SDK.
  const referenceLimit = protocolReferenceLimit(lane.protocol);
  const transmittedCount = transmittedReferences(lane.protocol, src.references ?? []).length;
  if (referenceLimit !== undefined && transmittedCount > referenceLimit) {
    throw new Error(
      `${label}: protocol '${lane.protocol}' can transmit at most ${referenceLimit} reference(s) at once, but ${transmittedCount} were declared; ` +
        'the request was refused before any upload or submission',
    );
  }
  const extension = resolveEffectiveExtension(src.model, lane.protocol, options);
  if (!extension && requiresModelDefinition(src, lane.protocol))
    throw new Error(`${label}: no model definition and service mapping for '${src.model}' on '${lane.protocol}'`);
  const modelSettings = options.endpoint?.modelSettings;
  const extensionOptions = { ...options, modelSettings, extension };

  // Normalize parameters through the model's OWN schema; establish the service's
  // operation subset, then validate shared model rules (the exact order
  // `validateGenerationExtension` already pins).
  let parameters: Record<string, unknown>;
  try {
    parameters = validateGenerationExtension(src, lane.protocol, extensionOptions);
  } catch (error) {
    throw new Error(
      `${label}: invalid ${src.model} parameters for Source '${src.id}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const wireModel = options.endpoint?.model ?? extension?.mapping.wireModel ?? lane.wireModel;
  const refs = references ?? referenceStubs(src, options, lane.protocol);

  let mappingBody: Record<string, unknown> | undefined;
  let encodedBody: FormData | string | undefined;
  let requestIdentity: unknown;
  let endpointId: string | undefined;

  if (isVendorProtocol(lane.protocol)) {
    if (lane.protocol === FAL_PROTOCOL) {
      // The queue route facet lives on the fal-specific mapping; its requiredness
      // and shape are enforced HERE so a missing or illegal endpointId is a Plan
      // blocker and never only fails at submission.
      endpointId = validateFalEndpointId(
        (extension?.mapping as { endpointId?: unknown } | undefined)?.endpointId,
        label,
      );
    }
    const mapping = extension?.mapping;
    const videoBody = mapping?.videoBody;
    if (!mapping || (!identityOnly && !videoBody))
      throw new Error(`${label}: the ${lane.protocol} lane needs a configured model definition and service mapping`);
    if (identityOnly) {
      if (!mapping.requestIdentity)
        throw new Error(`${label}: this mapping cannot reproduce an existing request identity without reference bytes`);
      requestIdentity = mapping.requestIdentity(src, parameters, wireModel, refs as MappingReferenceIdentity[]);
    } else {
      // A vendor lane has no separate multipart encode: the mapping body IS the wire body.
      mappingBody = videoBody!(src, parameters, wireModel, refs as MappingReference[]);
      requestIdentity =
        mapping.requestIdentity?.(src, parameters, wireModel, refs as MappingReferenceIdentity[]) ??
        stableHash(mappingBody);
    }
  } else {
    const protocol = genericVideoProtocol(lane.protocol);
    if (identityOnly) {
      const mapping = extension?.mapping;
      const referenceIdentities = refs as MappingReferenceIdentity[];
      if (mapping?.requestIdentity) {
        // An explicit requestIdentity contract is already the mapping's
        // canonical, metadata-only identity callback. It can recover even when
        // the wire body normally embeds byte-derived data URIs.
        mappingBody = mapping.identityBody?.(src, parameters, wireModel, referenceIdentities);
        requestIdentity = mapping.requestIdentity(src, parameters, wireModel, referenceIdentities);
      } else if (mapping?.videoBody && !mapping.identityBody) {
        if (referenceIdentities.length > 0)
          throw new Error(
            `${label}: this mapping cannot reproduce an existing request identity without reference bytes`,
          );
        // With no references, the body is a pure function of the current Source
        // and parameters. This does not create or substitute any media payload.
        mappingBody = mapping.videoBody(src, parameters, wireModel, []);
        requestIdentity = protocol.requestIdentity(src, wireModel, referenceIdentities, mappingBody);
      } else {
        mappingBody = mapping?.identityBody?.(src, parameters, wireModel, referenceIdentities);
        requestIdentity = protocol.requestIdentity(src, wireModel, referenceIdentities, mappingBody);
      }
    } else {
      mappingBody = extension?.mapping.videoBody?.(src, parameters, wireModel, refs as MappingReference[]);
      encodedBody = protocol.encode(src, wireModel, refs as MappingReference[], mappingBody);
      requestIdentity = extension?.mapping.requestIdentity
        ? extension.mapping.requestIdentity(src, parameters, wireModel, refs as MappingReferenceIdentity[])
        : protocol.requestIdentity(src, wireModel, refs as MappingReferenceIdentity[], mappingBody);
    }
  }

  // The reference set's TRANSFER size is checked here on the REAL byte sizes, so
  // an oversized reference is a Plan blocker with no POST; the adapters keep their
  // byte-exact guard on the real bytes as the final check.
  if (!identityOnly) assertTransferBounds(lane.protocol, refs as MappingReference[], encodedBody, label);

  const endpointIdentity = endpointIdentityOf(lane, modelSettings, options.endpoint?.credential);

  return Object.freeze({
    source: src,
    protocol: lane.protocol,
    baseUrl: lane.baseUrl,
    testOnly: lane.testOnly,
    wireModel,
    parameters,
    extension,
    mappingBody,
    encodedBody,
    requestIdentity,
    uploadAssetIds: lane.uploadAssetIds,
    credentialName: lane.credentialName,
    credentialPresent: lane.credentialPresent,
    endpointIdentity,
    ...(endpointId !== undefined ? { endpointId } : {}),
  });
}
