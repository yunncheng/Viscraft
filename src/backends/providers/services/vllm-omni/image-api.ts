import { readCapped } from '../../http-body.js';
import { validateGenerationReferenceSet } from '../../extension.js';
/**
 * vllm-omni-image API client and durable image generation/editing execution.
 *
 * Wire encoding/parsing is owned by the adjacent pure `image.ts` module
 * (scalar field map, reserved/scalar/URL boundary checks, JSON body, multipart
 * form, request identity, response decode). This executor owns authorization,
 * per-Asset consent, the per-attempt lock + job record, the synchronous submit,
 * the persisted request identity, result decode, retention and recovery; Plan
 * and Produce share `validateImageServiceRequest` + `preflightImageEncoding`.
 *
 * This adapter is deliberately distinct from the video adapters: image
 * generation and image editing are separate operations with their own request
 * contract, not a disguised video path. It speaks the OpenAI-compatible
 * synchronous image protocol exposed by vLLM-Omni (and compatible services):
 *  - `POST {baseUrl}/v1/images/generations` (JSON): required `prompt`; optional
 *    `model`, `size`, `seed`, `response_format` (default `b64_json`);
 *  - `POST {baseUrl}/v1/images/edits` (multipart/form-data): required `prompt`
 *    plus a reference image part (`image`); optional `mask_image`, `model`,
 *    `size`, `seed`, `response_format` (must be `b64_json`).
 * Both are SYNCHRONOUS and return inline base64
 * (`ImageGenerationResponse { created, data: [{ b64_json }] }`) — there is no
 * job id and no async lifecycle, so this adapter NEVER polls, never stores a
 * remote task id, and never resumes a download.
 *
 * LOCAL OR REMOTE IS THE PROJECT'S NON-CONCERN. A `GenerateImageRequest` carries
 * only a non-secret `endpoint` binding key; whether that endpoint is a local
 * process or a remote API is a per-deployment decision made in
 * `providers.imageApi`, never baked into the capability's identity. The adapter
 * connects to an existing user-selected service; it never deploys a model.
 *
 * A registered route does not establish model capability. A service may expose
 * `/v1/images/*` while a selected model has a different output modality.
 * Actual image-model availability belongs to the selected deployment; this
 * client neither deploys a model nor guarantees that one is loaded.
 *
 * Wire-contract source: vLLM-Omni image generation / image editing docs,
 * independent implementation only — no source was copied.
 *
 * Safety invariants:
 *  - **per-deployment authorization.**
 *    `testOnly` wins and is loopback-only. Otherwise `options.endpoint` is
 *    REQUIRED (a missing binding is a loud error naming `source.endpoint`);
 *    the endpoint is parsed with `ImageApiEndpointSchema`, its `baseUrl` must be
 *    an absolute URL and must not carry userinfo, query or fragment. Transport
 *    is HTTPS for any non-loopback host; plain HTTP is limited to explicit
 *    loopback IPs (`127.0.0.1` / `[::1]`). A loopback HTTP endpoint is always
 *    permitted; a NON-loopback endpoint additionally requires the explicit
 *    `authorization.submit === true` gate before it is even accepted. Endpoint location determines transport and authorization, never
 *    the adapter's creative identity;
 *  - **credentials are resolved at call time** from the env var named by
 *    `endpoint.credential` (`process.env[endpoint.credential]`), never stored,
 *    never echoed, and validated to be printable ASCII; a missing/invalid
 *    credential is a loud error. Error messages never carry the credential or
 *    the full URL;
 *  - real submission requires **explicit** `authorization.submit === true` AND,
 *    when a reference/mask Asset is transmitted, per-Asset local-transmission
 *    consent (`authorization.uploadAssets` includes its id). A redistributable
 *    license is never transmission consent. The gate runs before a job record
 *    is written and before any request. Test mode (a loopback fixture) bypasses
 *    it and marks every record `simulated`;
 *  - the request is re-validated against the canonical `GenerateImageRequestSchema`
 *    so an unvalidated caller cannot smuggle an out-of-contract request;
 *  - each ordered reference in `request.references` is resolved from the
 *    matching `options.references[i]` (matched by Asset id): it is re-validated
 *    with `AssetSchema`, its bytes come from the frozen asset root, must match
 *    the recorded `sha256`, must be PNG or JPEG **by signature** (SVG and other
 *    formats are refused, never converted), and are size-capped. A reference
 *    with role `mask` becomes the mask part; the rest are ordered image parts.
 *    A request that carries references is routed to the multipart edits
 *    endpoint (the generations endpoint is JSON and cannot carry image bytes).
 *    All of this runs before any lock, job record or network call;
 *  - a per-request-attempt exclusive lock refuses concurrent generation of the
 *    same request's attempt (two different request ids may each legitimately use
 *    the same numeric attempt id: the job, lock and retained media are all keyed
 *    by the request-scoped stem `<requestId>.<attempt>`);
 *  - the job record stores a prompt hash, not the prompt, and never the image
 *    bytes or a raw response body;
 *  - the frozen request hash binds the protocol version, the effective
 *    model/mapping identity, the endpoint base identity, the encoded wire
 *    request and every ordered reference hash, so reusing an attempt id with
 *    changed content is rejected instead of silently overwriting;
 *  - the pre-submit record is persisted BEFORE the network call; an ambiguous
 *    submit (timeout, transport error, malformed body, empty payload, 3xx/408/
 *    429/5xx) becomes `submit-unknown` and is never auto-resubmitted. A
 *    definitive provider rejection (4xx) or an unusable 2xx payload (not a
 *    PNG/JPEG, over the byte cap) becomes `failed`; both block resubmission
 *    under the same attempt;
 *  - the decoded image is written to the caller's destination and the original
 *    provider image is retained (with hash) under
 *    `.viscraft/provider-media/image-api-<requestId>.<attempt>.<ext>`; a succeeded
 *    attempt is re-materialized from the retained bytes without any network.
 *
 * Tests point it at a local Node HTTP fixture and every record they produce is
 * marked `simulated`.
 */

import { credentialSetupHint, resolveCredential } from '../../../../config/credentials.js';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { AssetSchema, GenerateImageRequestSchema, Id, ReferenceRoleSchema } from '../../../../core/schema.js';
import type {
  Asset,
  GenerateImageRequest,
  GenerateImageRequestInput,
  ImageGeneration,
  ReferenceRole,
} from '../../../../core/schema.js';
import { resolveProjectPath } from '../../../../shared/fs.js';
import { stableHash } from '../../../../shared/hash.js';
import { redact } from '../../../../shared/process.js';
import {
  loadJobRecord,
  saveJobRecord,
  patchJobRecord,
  acquireAttemptLock as acquireSharedAttemptLock,
  attemptStem,
} from '../../job-store.js';
import { assertOptionalReferenceBytesMatch, referenceFacts } from '../../reference-facts.js';
import { stripBrackets } from '../../lane.js';
import { IMAGE_API_REFERENCE_BYTES } from '../../transfer-bounds.js';
import {
  validateGenerationExtension,
  generationExtensionIdentity,
  type GenerationExtensionOptions,
} from '../../extension.js';
import {
  decodeVllmOmniImageResponse,
  detectImageMime,
  vllmOmniImageForm,
  vllmOmniImageJsonBody,
  vllmOmniImageRequestIdentity,
  VLLM_OMNI_IMAGE_EDITS_PATH,
  VLLM_OMNI_IMAGE_GENERATIONS_PATH,
} from './image.js';

const PROVIDER = 'vllm-omni-image';
const PROTOCOL_VERSION = 1;
const JOB_SCHEMA_VERSION = 1;

const JOBS_DIR_REL = '.viscraft/jobs/image-api';
const MEDIA_DIR_REL = '.viscraft/provider-media';

// A synchronous image response carries the image inline as base64 (~4/3 of the
// raw bytes), so the response cap is larger than the media cap.
const MAX_RESPONSE_BYTES = 48 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
// Shared with the ONE `transfer-bounds.ts` so the reference-size caps cannot drift.
const MAX_REFERENCE_BYTES = IMAGE_API_REFERENCE_BYTES;
const REQUEST_TIMEOUT_MS = 300_000;

const sizeSchema = z.string().regex(/^[1-9]\d{0,4}x[1-9]\d{0,4}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const positiveInteger = z.number().int().positive();

/**
 * A non-secret binding for one `vllm-omni-image` endpoint. `model` overrides the
 * authored model on the wire (a deployment may expose a different id);
 * `credential` names the environment variable holding the credential and is
 * resolved at call time — the credential itself is never part of project state.
 */
export const ImageApiEndpointSchema = z
  .object({
    protocol: z.literal('vllm-omni-image'),
    baseUrl: z.string().min(1),
    sourceModel: z.string().min(1).optional(),
    model: z.string().trim().min(1).max(1000).optional(),
    credential: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
    modelSettings: z.record(z.unknown()).optional(),
  })
  .strict();
export type ImageApiEndpoint = z.infer<typeof ImageApiEndpointSchema>;

/**
 * Options for an image generate/edit call.
 *  - `endpoint` is the non-secret binding selected by `source.endpoint`
 *    (required in production; `testOnly` supersedes it).
 *  - `authorization.submit` must be explicitly `true` before a real submission;
 *    a non-loopback endpoint additionally requires it just to be accepted.
 *  - `authorization.uploadAssets` must additionally list every transmitted
 *    reference/mask Asset id before its bytes reach the service. A
 *    redistributable license is never transmission consent.
 *  - `testOnly.baseUrl` redirects the adapter at a loopback HTTP fixture and
 *    marks every record `simulated`, bypassing the submit gate.
 *  - `references` is an ORDERED list parallel to `source.references`: the i-th
 *    entry supplies the already-approved image Asset for the i-th declared
 *    reference. A reference with role `mask` is transmitted as the mask part;
 *    the rest are transmitted as ordered image parts.
 */
export interface ImageApiOptions extends Pick<GenerationExtensionOptions, 'extension'> {
  endpoint?: ImageApiEndpoint;
  authorization?: { submit: boolean; uploadAssets?: string[] };
  testOnly?: { baseUrl: string };
  references?: { asset: Asset; root: string }[];
  /**
   * A read-only guard invoked at the LAST moment before the network POST, on
   * every attempt that would otherwise submit (a fresh attempt and a legal
   * `created` record never sent). It must not itself submit; throwing blocks the
   * request with no POST. The image operation uses it to re-check the knowable
   * target-Asset conflict so an occupation that appeared after the operation's
   * own pre-submit check is still refused without spending. It is never invoked
   * on the re-materialization path (a succeeded attempt sends nothing).
   */
  assertSubmitAllowed?: () => Promise<void>;
}

/**
 * Portable provenance attached to a successful artifact. Contains no
 * credentials, no remote URLs, no prompt text and no image bytes.
 *
 * `inputs` is the FROZEN production-input identity actually read and transmitted
 * at generation time, in request order and including each parent's version. It is
 * the registration channel's parent identity: a concurrent edit or a recovery
 * must verify these exact versions + bytes against the current Project and never
 * rebind the child to a new parent. It is deliberately NOT folded into
 * `generation` — `generation.references` stays hash-only (no revision), as the
 * request order/category/role/hash contract; `inputs` is the version relation.
 */
export interface ImageApiResult {
  backend: string;
  generation: ImageGeneration;
  inputs: Array<{ asset: string; revision: number; sha256: string; role: ReferenceRole }>;
}

export class ImageApiError extends Error {
  /** True only when a caller may safely re-run the *same* attempt (never to resubmit). */
  recoverable = false;
  constructor(message: string) {
    super(message);
    this.name = 'ImageApiError';
  }
}

// ---------------------------------------------------------------------------
// Persisted job record (hashes only — never the prompt, mask bytes or a URL)
// ---------------------------------------------------------------------------

const jobStateSchema = z.enum(['created', 'submitting', 'submit-unknown', 'succeeded', 'failed']);

const jobSchema = z
  .object({
    schemaVersion: z.literal(JOB_SCHEMA_VERSION),
    backend: z.string().min(1),
    provider: z.literal(PROVIDER),
    model: z.string().min(1),
    simulated: z.boolean(),
    mode: z.enum(['production', 'test']),
    attempt: positiveInteger,
    sourceId: Id,
    endpoint: Id,
    operation: z.enum(['generate', 'edit']),
    promptHash: sha256Schema,
    requestHash: sha256Schema,
    protocolVersion: z.literal(PROTOCOL_VERSION),
    extensionHash: sha256Schema,
    // Ordered transmitted condition images: the frozen parent identity (its
    // version + bytes as actually read) and the creative role. LIMIT PROVENANCE:
    // the vllm-omni-image protocol has NO verified fixed reference count, so no numeric
    // cap is imposed here (a legal request for any image model must stay
    // recordable); a specific image model's count belongs in its own profile.
    inputSha256: z.array(sha256Schema),
    references: z.array(
      z.object({ asset: Id, revision: positiveInteger, sha256: sha256Schema, role: ReferenceRoleSchema }).strict(),
    ),
    size: sizeSchema.optional(),
    seed: z.number().int().nonnegative().optional(),
    state: jobStateSchema,
    submitted: z.number().int().nonnegative(),
    // Retained original provider image, project-relative, with its content hash.
    outputPath: z.string().min(1).optional(),
    outputSha256: sha256Schema.optional(),
    error: z.string().min(1).optional(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();

export type ImageApiJob = z.infer<typeof jobSchema>;
export type ImageApiJobState = z.infer<typeof jobStateSchema>;

function now(): string {
  return new Date().toISOString();
}

function patchJob(job: ImageApiJob, changes: Partial<ImageApiJob>): ImageApiJob {
  return patchJobRecord(job, changes, now());
}

/** Build the portable provenance for a successfully completed job. */
function successResult(job: ImageApiJob): ImageApiResult {
  if (!job.outputSha256) {
    throw new ImageApiError('Image API adapter: a succeeded job is missing its output hash');
  }
  return {
    backend: job.backend,
    generation: {
      provider: PROVIDER,
      extensionHash: job.extensionHash,
      model: job.model,
      operation: job.operation,
      promptHash: job.promptHash,
      requestHash: job.requestHash,
      inputSha256: job.inputSha256,
      references: job.references.map(reference => ({
        asset: reference.asset,
        sha256: reference.sha256,
        category: 'image' as const,
        role: reference.role as ReferenceRole,
      })),
      outputSha256: job.outputSha256,
      ...(job.size !== undefined ? { size: job.size } : {}),
      ...(job.seed !== undefined ? { seed: job.seed } : {}),
      simulated: job.simulated,
    },
    inputs: job.references.map(reference => ({
      asset: reference.asset,
      revision: reference.revision,
      sha256: reference.sha256,
      role: reference.role as ReferenceRole,
    })),
  };
}

async function loadJob(jobFile: string): Promise<ImageApiJob | null> {
  return loadJobRecord(jobFile, jobSchema, 'Image API adapter', message => new ImageApiError(message));
}

async function saveJob(jobFile: string, job: ImageApiJob): Promise<void> {
  await saveJobRecord(jobFile, job);
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

async function resolveDestination(rootAbs: string, destination: string): Promise<{ abs: string; rel: string }> {
  if (!destination || destination.includes('\0'))
    throw new ImageApiError('Image API adapter: invalid destination path');
  let rel: string;
  if (isAbsolute(destination)) {
    const base = await realpath(rootAbs);
    rel = relative(base, normalize(destination)).split(sep).join('/');
    if (!rel || rel.startsWith('..') || isAbsolute(rel))
      throw new ImageApiError('Image API adapter: destination escapes project root');
  } else {
    rel = destination;
  }
  const abs = await resolveProjectPath(rootAbs, rel);
  return { abs, rel };
}

/** Write `bytes` to `destAbs` atomically with an owner-only mode. */
async function writeAtomic(destAbs: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(destAbs), { recursive: true });
  const tmp = `${destAbs}.viscraft-tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    await writeFile(tmp, bytes, { mode: 0o600 });
    await rename(tmp, destAbs);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Options / authorization / base resolution
// ---------------------------------------------------------------------------

/**
 * Accept only an explicit loopback IP over plain HTTP with no userinfo, path,
 * query or fragment. Hostnames (including `localhost`) and every non-local or
 * non-http override are refused before any work. Used for the loopback-only
 * `testOnly` fixture transport.
 */
function parseLoopbackBase(raw: string, label: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ImageApiError(`Image API adapter: ${label} must be a valid absolute URL`);
  }
  if (url.protocol !== 'http:')
    throw new ImageApiError(`Image API adapter: ${label} must use plain http on a loopback IP`);
  if (url.username || url.password) throw new ImageApiError(`Image API adapter: ${label} must not contain credentials`);
  if (url.pathname !== '/' || url.search || url.hash)
    throw new ImageApiError(`Image API adapter: ${label} must not contain a path, query or fragment`);
  const host = stripBrackets(url.hostname).toLowerCase();
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new ImageApiError(
      `Image API adapter: ${label} must be an explicit loopback IP (127.0.0.1 or [::1]); hostnames and non-local overrides are refused`,
    );
  }
  return url.origin;
}

interface ResolvedBase {
  baseUrl: string;
  testOnly: boolean;
  wireModel: string;
  endpointIdentity: string;
  credentialName?: string;
}

/**
 * Resolve the selected endpoint. `testOnly` (a loopback fixture) wins. Otherwise
 * the `source.endpoint` binding is REQUIRED and must resolve to a parsed
 * `ImageApiEndpoint`. The base URL is an absolute URL with no userinfo, query or
 * fragment; HTTPS is required off loopback and plain HTTP is limited to explicit
 * loopback IPs.
 *
 * A loopback HTTP endpoint is always permitted, while a non-loopback endpoint
 * additionally requires the explicit `authorization.submit === true` gate before
 * it is accepted. The submit gate also runs later, before any request, for every
 * real submission.
 */
function resolveBase(options: ImageApiOptions, source: GenerateImageRequest): ResolvedBase {
  if (options.testOnly) {
    const baseUrl = parseLoopbackBase(options.testOnly.baseUrl, 'testOnly.baseUrl');
    const endpoint = options.endpoint ? ImageApiEndpointSchema.parse(options.endpoint) : undefined;
    const wireModel = endpoint?.model ?? source.model;
    return {
      baseUrl,
      testOnly: true,
      wireModel,
      endpointIdentity: stableHash({ protocol: PROVIDER, baseUrl, wireModel, fixture: true }),
    };
  }
  if (!options.endpoint)
    throw new ImageApiError(`Image API adapter: missing endpoint configuration for binding '${source.endpoint}'`);
  const endpoint = ImageApiEndpointSchema.parse(options.endpoint);
  let url: URL;
  try {
    url = new URL(endpoint.baseUrl);
  } catch {
    throw new ImageApiError('Image API adapter: endpoint baseUrl must be an absolute URL');
  }
  if (url.username || url.password || url.search || url.hash)
    throw new ImageApiError('Image API adapter: endpoint must not contain credentials, query or fragment');
  const loopback =
    stripBrackets(url.hostname).toLowerCase() === '127.0.0.1' || stripBrackets(url.hostname).toLowerCase() === '::1';
  if (url.protocol === 'http:') {
    if (!loopback)
      throw new ImageApiError(
        'Image API adapter: plain HTTP is limited to explicit loopback IPs; remote endpoints require HTTPS',
      );
  } else if (url.protocol !== 'https:') {
    throw new ImageApiError('Image API adapter: endpoint requires HTTPS or loopback HTTP');
  }
  if (!loopback && options.authorization?.submit !== true) {
    throw new ImageApiError(
      `Image API adapter: the non-loopback endpoint for binding '${source.endpoint}' requires explicit authorization ` +
        '(`{ authorization: { submit: true } }`) before it is used; no request was sent and no attempt was recorded as submitted.',
    );
  }
  const baseUrl = url.toString().replace(/\/+$/, '');
  const wireModel = endpoint.model ?? source.model;
  return {
    baseUrl,
    testOnly: false,
    wireModel,
    credentialName: endpoint.credential,
    endpointIdentity: stableHash({
      protocol: endpoint.protocol,
      baseUrl,
      wireModel,
      credential: endpoint.credential ?? null,
    }),
  };
}

/**
 * Resolve the configured credential AT CALL TIME. The env var NAME lives in the
 * endpoint binding; the value is never stored on project state, never echoed and
 * never included in an error message. A missing or non-printable credential is a
 * loud error. No credential is required for the loopback `testOnly` fixture.
 */
function credentialHeaders(credentialName?: string): Record<string, string> {
  if (!credentialName) return {};
  const key = resolveCredential(credentialName);
  if (!key)
    throw new ImageApiError(
      `Image API adapter: credential ${credentialName} is not configured (${credentialSetupHint(credentialName)})`,
    );
  return { Authorization: `Bearer ${key}` };
}

/**
 * Real submission requires explicit authorization AND per-Asset transmission
 * consent for every transmitted reference/mask image. Test mode (a loopback
 * fixture) is exempt and marked `simulated`. This runs before any job record is
 * written and before any network call.
 */
function assertAuthorizedForSubmit(testOnly: boolean, options: ImageApiOptions, uploadedAssetIds: string[]): void {
  if (testOnly) return; // loopback fixture; nothing real is generated
  if (options.authorization?.submit !== true) {
    throw new ImageApiError(
      'Image API adapter: real generation requires explicit authorization (`{ authorization: { submit: true } }`); ' +
        'no request was sent and no attempt was recorded as submitted.',
    );
  }
  for (const assetId of uploadedAssetIds) {
    if (!options.authorization.uploadAssets?.includes(assetId)) {
      throw new ImageApiError(
        `Image API adapter: transmitting Asset '${assetId}' to the selected image service requires explicit per-Asset consent ` +
          `(\`{ authorization: { submit: true, uploadAssets: ['${assetId}'] } }\`); a redistributable license is NOT transmission consent. ` +
          'No request was sent and no attempt was recorded as submitted.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Reference / mask image resolution
// ---------------------------------------------------------------------------

interface ResolvedImage {
  assetId: string;
  /** The parent Asset's version at the moment it is read — part of the frozen identity. */
  revision: number;
  sha256: string;
  role: ReferenceRole;
  mime: 'image/png' | 'image/jpeg';
  simulated: boolean;
  bytes: Buffer;
}

/**
 * Resolve ONE approved condition image (reference or mask role).
 *
 * The ONLY accepted source is a caller-provided `options.references[i]` whose
 * Asset id equals the declared reference — nothing is fetched, generated or
 * substituted. The Asset is re-validated with `AssetSchema`; its bytes are read
 * from the frozen asset root, must match the recorded `sha256`, must be PNG or
 * JPEG **by signature** (SVG and everything else is refused, never converted),
 * and are size-capped. This all runs before the per-attempt lock, any job
 * record and any network call.
 */
async function resolveImage(
  reference: { asset: string; role: ReferenceRole },
  provided: { asset: Asset; root: string } | undefined,
): Promise<ResolvedImage> {
  if (!provided || typeof provided.root !== 'string' || provided.root.length === 0) {
    throw new ImageApiError(
      `Image API adapter: Source references image Asset '${reference.asset}' (role ${reference.role}) but no matching options.references entry (asset + frozen root) was provided; ` +
        'no request was sent and no attempt was recorded as submitted.',
    );
  }
  const parsed = AssetSchema.safeParse(provided.asset);
  if (!parsed.success) throw new ImageApiError('Image API adapter: a provided reference image is not a valid Asset');
  const asset = parsed.data;
  if (asset.type !== 'image')
    throw new ImageApiError(`Image API adapter: reference Asset '${asset.id}' is not an image`);
  if (asset.id !== reference.asset) {
    throw new ImageApiError(
      `Image API adapter: the provided reference Asset '${asset.id}' does not match the declared reference '${reference.asset}'; refusing before any request.`,
    );
  }
  let abs: string;
  try {
    abs = await resolveProjectPath(provided.root, asset.path);
  } catch {
    throw new ImageApiError(
      `Image API adapter: reference Asset '${asset.id}' does not resolve to a safe path inside its frozen root`,
    );
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(abs);
  } catch {
    throw new ImageApiError(
      `Image API adapter: reference Asset '${asset.id}' could not be read from the frozen asset root`,
    );
  }
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
    throw new ImageApiError(
      `Image API adapter: reference Asset '${asset.id}' bytes do not match its recorded sha256; refusing to send`,
    );
  }
  if (bytes.length > MAX_REFERENCE_BYTES) {
    throw new ImageApiError(
      `Image API adapter: reference Asset '${asset.id}' is ${bytes.length} bytes, over the ${MAX_REFERENCE_BYTES}-byte limit`,
    );
  }
  const mime = detectImageMime(bytes);
  if (!mime) {
    throw new ImageApiError(
      `Image API adapter: reference Asset '${asset.id}' is not a PNG or JPEG (by signature); SVG and other formats are refused rather than converted`,
    );
  }
  return Object.freeze({
    assetId: asset.id,
    revision: asset.revision,
    sha256: asset.sha256,
    role: reference.role,
    mime,
    simulated: asset.simulated,
    bytes,
  });
}

/**
 * Resolve the Source's ordered references into a matching ordered list. The
 * provided list must cover exactly the declared references and each Asset id
 * must match; order is the Source's own order.
 */
async function resolveImages(source: GenerateImageRequest, options: ImageApiOptions): Promise<ResolvedImage[]> {
  const declared = source.references ?? [];
  const provided = options.references ?? [];
  if (declared.length !== provided.length) {
    throw new ImageApiError(
      `Image API adapter: Source '${source.id}' declares ${declared.length} reference(s) but ${provided.length} were provided; refusing before any request.`,
    );
  }
  const byId = new Map(provided.map(input => [input.asset.id, input]));
  // A declared Asset id may legitimately appear more than once (e.g. the same
  // still in two conditioning roles). If two provided entries claim the same id
  // with DIFFERENT bytes, resolving by id would silently pick one and drop the
  // other; refuse the ambiguity instead.
  for (const id of byId.keys()) {
    const duplicates = provided.filter(input => input.asset?.id === id);
    if (new Set(duplicates.map(duplicate => `${duplicate.asset.sha256}:${duplicate.asset.path}`)).size > 1) {
      throw new ImageApiError(
        `Image API adapter: reference Asset '${id}' has conflicting duplicate options.references entries (same id, different sha256/path); refusing before any request.`,
      );
    }
  }
  const resolved: ResolvedImage[] = [];
  for (const reference of declared) resolved.push(await resolveImage(reference, byId.get(reference.asset)));
  return resolved;
}

// ---------------------------------------------------------------------------
// Per-attempt lock
// ---------------------------------------------------------------------------

async function acquireAttemptLock(rootAbs: string, sourceId: string, attempt: string): Promise<() => Promise<void>> {
  return acquireSharedAttemptLock({
    rootAbs,
    stem: attemptStem(sourceId, attempt),
    attempt,
    dirRel: JOBS_DIR_REL,
    label: 'Image API adapter',
    conflict: message => new ImageApiError(message),
  });
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const buf = await readCapped(
    response,
    MAX_RESPONSE_BYTES,
    () => new ImageApiError('Image API adapter: response exceeded the configured size cap'),
  );
  return { status: response.status, text: buf.toString('utf8') };
}

async function postForm(
  url: string,
  form: FormData,
  headers: Record<string, string>,
): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', ...headers },
    body: form, // FormData sets its own multipart boundary
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const buf = await readCapped(
    response,
    MAX_RESPONSE_BYTES,
    () => new ImageApiError('Image API adapter: response exceeded the configured size cap'),
  );
  return { status: response.status, text: buf.toString('utf8') };
}

type SubmitOutcome =
  | { kind: 'accepted'; bytes: Buffer; mime: 'image/png' | 'image/jpeg' }
  | { kind: 'unknown'; detail: string }
  | { kind: 'rejected'; detail: string }
  | { kind: 'unusable'; detail: string };

/**
 * Submit exactly once. The endpoint is synchronous: a 2xx body carries the
 * image inline. Any request that carries reference images is routed to the
 * multipart edits endpoint (the generations endpoint is JSON and cannot carry
 * image bytes). Every ambiguous outcome (transport, 3xx/408/429/5xx, malformed
 * or empty body) is `unknown`; a definitive 4xx is `rejected`; a 2xx whose
 * payload is not a usable PNG/JPEG is `unusable`. The wire body/form, the
 * response decode and the image boundary all come from the pure `vllm-omni-image`
 * protocol module; this executor only classifies the outcome.
 */
async function submitImage(
  baseUrl: string,
  source: GenerateImageRequest,
  wireModel: string,
  headers: Record<string, string>,
  references: readonly ResolvedImage[],
  mappedFields: Record<string, string | number | boolean>,
): Promise<SubmitOutcome> {
  let response: { status: number; text: string };
  try {
    response =
      references.length === 0
        ? await postJson(
            `${baseUrl}${VLLM_OMNI_IMAGE_GENERATIONS_PATH}`,
            vllmOmniImageJsonBody(source, wireModel, mappedFields),
            headers,
          )
        : await postForm(
            `${baseUrl}${VLLM_OMNI_IMAGE_EDITS_PATH}`,
            vllmOmniImageForm(source, wireModel, references, mappedFields),
            headers,
          );
  } catch (error) {
    return {
      kind: 'unknown',
      detail: `submit transport error: ${redact(error instanceof Error ? error.message : String(error))}`,
    };
  }
  const { status, text } = response;
  // Any redirect, request timeout, throttling or server error is ambiguous: the
  // service may or may not have generated an image, so it is never resubmitted.
  if (status === 408 || status === 429 || (status >= 300 && status < 400) || status >= 500) {
    return { kind: 'unknown', detail: `submit returned HTTP ${status}` };
  }
  if (status < 200 || status >= 300) return { kind: 'rejected', detail: `submit rejected with HTTP ${status}` };

  const decoded = decodeVllmOmniImageResponse(text, MAX_IMAGE_BYTES);
  if (decoded.kind === 'malformed')
    return { kind: 'unknown', detail: 'submit returned an unexpected or malformed response body' };
  if (decoded.kind === 'empty') return { kind: 'unknown', detail: 'submit returned an empty image payload' };
  if (decoded.kind === 'oversize')
    return {
      kind: 'unusable',
      detail: `provider image is ${decoded.bytes} bytes, over the ${MAX_IMAGE_BYTES}-byte limit`,
    };
  if (decoded.kind === 'not-image')
    return { kind: 'unusable', detail: 'provider payload is not a PNG or JPEG (by magic bytes)' };
  return { kind: 'accepted', bytes: decoded.bytes, mime: decoded.mime };
}

// ---------------------------------------------------------------------------
// generateImageApi
// ---------------------------------------------------------------------------

interface GenerationContext {
  rootAbs: string;
  source: GenerateImageRequest;
  destAbs: string;
  jobsDir: string;
  mediaDir: string;
  jobFile: string;
  attempt: number;
  /** Request-scoped locator stem `<requestId>.<attempt>` shared by the job/lock/media. */
  stem: string;
  baseUrl: string;
  testOnly: boolean;
  wireModel: string;
  credentialName?: string;
  options: ImageApiOptions;
  mode: 'production' | 'test';
  requestHash: string;
  references: ResolvedImage[];
  mappedFields: Record<string, string | number | boolean>;
  extensionHash: string;
}

/**
 * The ONE vllm-omni-image request validator shared by the read-only preflight and the
 * submission: the canonical request boundary plus the effective model definition
 * + service mapping (`validateGenerationExtension`). Returns the parsed
 * parameters; THROWS on failure. Read-only: no upload, no POST, no job/lock.
 */
export function validateImageServiceRequest(
  request: GenerateImageRequestInput,
  options: ImageApiOptions,
): { parameters: Record<string, unknown>; request: GenerateImageRequest } {
  const parsed = GenerateImageRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw new ImageApiError('Image API adapter: expected a valid image request with in-range fields');
  }
  const src = parsed.data;
  if (options.endpoint?.sourceModel && options.endpoint.sourceModel !== src.model)
    throw new Error(
      `Configured image model '${options.endpoint.sourceModel}' does not match request model '${src.model}'`,
    );
  const parameters = validateGenerationExtension(src, 'vllm-omni-image', {
    extension: options.extension,
    modelSettings: options.endpoint?.modelSettings,
  });
  return { parameters, request: src };
}

/**
 * The pure vllm-omni-image encoding preflight shared by the read-only preflight and
 * the submission. Runs the effective model + mapping validation and then the
 * scalar encoding rules (reserved-key collision, scalar-only `imageFields`,
 * refusing URL/inline-data media the scalar protocol cannot express) using the
 * mapping WITHOUT reading any reference bytes or base64-expanding any file.
 * THROWS on failure. Read-only: no upload, no POST, no job/lock.
 */
export function preflightImageEncoding(request: GenerateImageRequestInput, options: ImageApiOptions): void {
  const { request: src, parameters } = validateImageServiceRequest(request, options);
  const mapped = options.extension?.mapping.imageFields?.(src, parameters) ?? {};
  // Field construction is a pure function of the request + the mapping's scalar
  // output; it also applies the reserved/scalar/URL boundary checks.
  vllmOmniImageRequestIdentity(src, options.endpoint?.model ?? src.model, [], mapped);
}

/** Every read-only fact a submission needs, resolved once (no writes, no network). */
export interface PreparedImageRequest {
  request: GenerateImageRequest;
  parameters: Record<string, unknown>;
  extensionHash: string;
  mappedFields: Record<string, string | number | boolean>;
  baseUrl: string;
  testOnly: boolean;
  wireModel: string;
  endpointIdentity: string;
  credentialName?: string;
  references: ResolvedImage[];
  attempt: number;
  mode: 'production' | 'test';
  requestHash: string;
}

/**
 * Resolve every read-only fact a submission needs: the canonical request
 * boundary, the effective model + mapping validation, the endpoint/transport
 * resolution, the ordered reference bytes and hashes, and the frozen request
 * hash. THROWS on any invalid request. It reads local reference bytes and the
 * configured endpoint, but performs NO upload, NO POST, NO job/lock write and NO
 * retained-media write — so it is the ONE read-only preparation the `--check`
 * preflight and the real submission both use, and they cannot drift.
 */
export async function prepareImageRequest(
  request: GenerateImageRequestInput,
  options: ImageApiOptions = {},
): Promise<PreparedImageRequest> {
  // Canonical, public-boundary validation: an unvalidated caller cannot smuggle
  // an out-of-contract request past the TypeScript types.
  const parsed = GenerateImageRequestSchema.safeParse(request);
  if (!parsed.success)
    throw new ImageApiError('Image API adapter: expected a valid image request with in-range fields');
  const src = parsed.data;
  if (options.endpoint?.sourceModel && options.endpoint.sourceModel !== src.model)
    throw new Error(
      `Configured image model '${options.endpoint.sourceModel}' does not match request model '${src.model}'`,
    );
  const { parameters } = validateImageServiceRequest(src, options);
  preflightImageEncoding(src, options);
  const extensionHash = await generationExtensionIdentity({
    extension: options.extension,
    modelSettings: options.endpoint?.modelSettings,
  });
  const mappedFields = options.extension?.mapping.imageFields?.(src, parameters) ?? {};
  const attempt = positiveInteger.parse(src.attempt);
  const { baseUrl, testOnly, wireModel, endpointIdentity, credentialName } = resolveBase(options, src);

  // Resolve and validate every ordered condition image BEFORE the lock, job
  // record or network. A request naming an image without its approved Asset fails
  // here. A mask is a reference with role `mask`.
  const references = await resolveImages(src, options);
  if (
    options.extension &&
    (options.extension.model.validateReferenceSet || options.extension.mapping.validateReferenceSet)
  ) {
    // A zero-reference request may omit `options.references` entirely;
    // `resolveImages` already guaranteed every DECLARED reference has a matching
    // entry, so an empty fallback only covers the zero-reference case.
    const byId = new Map((options.references ?? []).map(input => [input.asset.id, input]));
    const facts = await Promise.all(
      src.references.map(ref => {
        const input = byId.get(ref.asset)!;
        return referenceFacts(input.root, input.asset, ref);
      }),
    );
    validateGenerationReferenceSet(options.extension, src, facts);
  }

  const mode: 'production' | 'test' = testOnly ? 'test' : 'production';
  const promptHash = stableHash(src.prompt);
  const inputSha256 = references.map(reference => reference.sha256);
  // The frozen request identity covers the ACTUAL encoded request the protocol
  // builds: its routing, the canonical scalar field map (including the mapping's
  // `imageFields`) and each reference's category/role/hash in authored order. It
  // never covers base64 bytes, credentials or temp filenames, so a change to the
  // protocol's own field construction invalidates a reused attempt while a new
  // multipart boundary does not.
  const encodedRequest = vllmOmniImageRequestIdentity(
    src,
    wireModel,
    references.map(reference => ({ role: reference.role, sha256: reference.sha256 })),
    mappedFields,
  );
  const requestHash = stableHash({
    protocolVersion: PROTOCOL_VERSION,
    extensionHash,
    parameters,
    request: encodedRequest,
    kind: PROVIDER,
    model: src.model,
    mode,
    baseIdentity: endpointIdentity,
    endpoint: src.endpoint,
    id: src.id,
    operation: src.operation,
    promptHash,
    size: src.size ?? null,
    seed: src.seed ?? null,
    inputSha256,
  });
  return {
    request: src,
    parameters,
    extensionHash,
    mappedFields,
    baseUrl,
    testOnly,
    wireModel,
    endpointIdentity,
    ...(credentialName !== undefined ? { credentialName } : {}),
    references,
    attempt,
    mode,
    requestHash,
  };
}

/** A compact, secret-free summary of a persisted image-api request record. */
export interface ImageRequestRecordSummary {
  state: ImageApiJobState;
  attempt: number;
  requestHash: string;
  simulated: boolean;
  outputSha256?: string;
  outputPath?: string;
}

/** The read-only result of the `generate-image` preflight. Nothing is written. */
export interface ImageRequestPreflight {
  mode: 'production' | 'test';
  /** The frozen request hash a submission would persist for this request. */
  requestHash: string;
  references: Array<{ asset: string; role: ReferenceRole; sha256: string; simulated: boolean }>;
  /** Whether the current request hash differs from a persisted attempt record. */
  requestUnchanged: boolean;
  /** The persisted attempt record for `(id, attempt)`, when one exists. */
  record: ImageRequestRecordSummary | null;
}

/**
 * The read-only vllm-omni-image request preflight. Resolves the endpoint/config,
 * validates the model and reference rules, encodes and hashes the request, reads
 * the referenced Asset bytes and compares the result against any persisted
 * attempt record — WITHOUT submitting, writing a job record or retaining media.
 * THROWS on an invalid request; a persisted record whose hash differs from the
 * current request hash is reported (`requestUnchanged: false`) so a changed
 * request can never silently reuse an old attempt.
 */
export async function preflightImageRequest(
  root: string,
  request: GenerateImageRequestInput,
  options: ImageApiOptions = {},
): Promise<ImageRequestPreflight> {
  const parsed = GenerateImageRequestSchema.safeParse(request);
  if (!parsed.success)
    throw new ImageApiError('Image API adapter: expected a valid image request with in-range fields');
  const rootAbs = resolve(root);
  const stem = attemptStem(parsed.data.id, positiveInteger.parse(parsed.data.attempt));
  const jobFile = await resolveProjectPath(rootAbs, `${JOBS_DIR_REL}/${stem}.json`);
  const existing = await loadJob(jobFile);
  if (existing?.state === 'succeeded') {
    let result: ImageApiResult | null = null;
    try {
      result = await restoreSucceededImageWithoutReferenceBytes(rootAbs, jobFile, undefined, parsed.data, options);
    } catch {
      // A changed authored request falls through to byte-backed preparation. If
      // its inputs are gone, that path refuses because the old hash cannot be
      // proven; with present inputs it reports the changed request identity.
    }
    if (result) {
      const { testOnly } = resolveBase(options, parsed.data);
      const references = result.generation.references.map(reference => ({
        asset: reference.asset,
        role: reference.role,
        sha256: reference.sha256,
        simulated: options.references?.find(input => input.asset.id === reference.asset)?.asset.simulated ?? false,
      }));
      return {
        mode: testOnly ? 'test' : 'production',
        requestHash: result.generation.requestHash,
        references,
        requestUnchanged: true,
        record: {
          state: existing.state,
          attempt: existing.attempt,
          requestHash: existing.requestHash,
          simulated: existing.simulated,
          ...(existing.outputSha256 !== undefined ? { outputSha256: existing.outputSha256 } : {}),
          ...(existing.outputPath !== undefined ? { outputPath: existing.outputPath } : {}),
        },
      };
    }
  }
  const prepared = await prepareImageRequest(request, options);
  const preparedStem = attemptStem(prepared.request.id, prepared.attempt);
  let record: ImageRequestRecordSummary | null = null;
  let requestUnchanged = true;
  try {
    const jobFile = await resolveProjectPath(rootAbs, `${JOBS_DIR_REL}/${preparedStem}.json`);
    const job = await loadJob(jobFile);
    if (job) {
      record = {
        state: job.state,
        attempt: job.attempt,
        requestHash: job.requestHash,
        simulated: job.simulated,
        ...(job.outputSha256 !== undefined ? { outputSha256: job.outputSha256 } : {}),
        ...(job.outputPath !== undefined ? { outputPath: job.outputPath } : {}),
      };
      requestUnchanged = imageJobMatchesPreparedRequest(job, prepared);
    }
  } catch (error) {
    throw error instanceof ImageApiError ? error : new ImageApiError(String(error));
  }
  return {
    mode: prepared.mode,
    requestHash: prepared.requestHash,
    references: prepared.references.map(reference => ({
      asset: reference.assetId,
      role: reference.role,
      sha256: reference.sha256,
      simulated: reference.simulated,
    })),
    requestUnchanged: record === null || requestUnchanged,
    record,
  };
}

function imageJobMatchesPreparedRequest(job: ImageApiJob, prepared: PreparedImageRequest): boolean {
  return (
    job.requestHash === prepared.requestHash &&
    job.sourceId === prepared.request.id &&
    job.endpoint === prepared.request.endpoint &&
    job.model === prepared.request.model &&
    job.operation === prepared.request.operation &&
    job.mode === prepared.mode &&
    job.extensionHash === prepared.extensionHash &&
    job.promptHash === stableHash(prepared.request.prompt) &&
    stableHash(job.size ?? null) === stableHash(prepared.request.size ?? null) &&
    stableHash(job.seed ?? null) === stableHash(prepared.request.seed ?? null) &&
    stableHash(job.inputSha256) === stableHash(prepared.references.map(reference => reference.sha256)) &&
    job.references.length === prepared.references.length &&
    job.references.every((reference, index) => {
      const current = prepared.references[index];
      return (
        current !== undefined &&
        reference.asset === current.assetId &&
        reference.revision === current.revision &&
        reference.sha256 === current.sha256 &&
        reference.role === current.role
      );
    }) &&
    job.simulated === (prepared.testOnly || prepared.references.some(reference => reference.simulated))
  );
}

/**
 * Produce a generated/edited image for an image request.
 *
 * The result is written to `destination`; the original provider image is
 * retained under `.viscraft/provider-media/`. Re-entrant and idempotent per
 * attempt: a succeeded job is re-materialized from the retained bytes without
 * any network, an ambiguous submit is never resubmitted. See the module header
 * for the full invariant list.
 */
export async function generateImageApi(
  root: string,
  request: GenerateImageRequestInput,
  destination: string,
  options: ImageApiOptions = {},
): Promise<ImageApiResult> {
  const parsed = GenerateImageRequestSchema.safeParse(request);
  if (!parsed.success)
    throw new ImageApiError('Image API adapter: expected a valid image request with in-range fields');
  const src = parsed.data;
  const rootAbs = resolve(root);
  const attempt = positiveInteger.parse(src.attempt);
  const stem = attemptStem(src.id, attempt);
  const jobsDir = await resolveProjectPath(rootAbs, JOBS_DIR_REL);
  const mediaDir = await resolveProjectPath(rootAbs, MEDIA_DIR_REL);
  const jobFile = await resolveProjectPath(rootAbs, `${JOBS_DIR_REL}/${stem}.json`);
  const destinationPath = await resolveDestination(rootAbs, destination);

  const existing = await loadJob(jobFile);
  if (existing?.state !== 'succeeded') {
    // Validate endpoint, mapping and real input bytes before acquiring a lock
    // (which creates the job directory). A malformed request must leave no
    // attempt filesystem state behind.
    const prepared = await prepareImageRequest(src, options);
    const release = await acquireAttemptLock(rootAbs, src.id, String(attempt));
    try {
      return await runGeneration({
        rootAbs,
        source: src,
        destAbs: destinationPath.abs,
        jobsDir,
        mediaDir,
        jobFile,
        attempt: prepared.attempt,
        stem,
        baseUrl: prepared.baseUrl,
        testOnly: prepared.testOnly,
        wireModel: prepared.wireModel,
        ...(prepared.credentialName !== undefined ? { credentialName: prepared.credentialName } : {}),
        options,
        mode: prepared.mode,
        requestHash: prepared.requestHash,
        references: prepared.references,
        mappedFields: prepared.mappedFields,
        extensionHash: prepared.extensionHash,
      });
    } finally {
      await release();
    }
  }

  // A succeeded attempt can be proven from current declarations and mapping
  // metadata. Check that before acquiring the lock so changed requests also
  // leave no new filesystem state; repeat under the lock before materializing.
  await restoreSucceededImageWithoutReferenceBytes(rootAbs, jobFile, undefined, src, options);
  const release = await acquireAttemptLock(rootAbs, src.id, String(attempt));
  try {
    const restored = await restoreSucceededImageWithoutReferenceBytes(
      rootAbs,
      jobFile,
      destinationPath.abs,
      src,
      options,
    );
    if (restored) return restored;
    throw new ImageApiError(`Image API adapter: succeeded attempt '${attempt}' could not be identity-verified`);
  } finally {
    await release();
  }
}

/**
 * Re-materialize a completed synchronous image result when its authored input
 * bytes are no longer present. This path reconstructs the complete current
 * request identity from the Source, Asset declarations and current mapping,
 * checks the persisted request hash and ordered provenance, then verifies the
 * retained output bytes. It never manufactures a reference payload or submits.
 */
async function restoreSucceededImageWithoutReferenceBytes(
  rootAbs: string,
  jobFile: string,
  destination: string | undefined,
  request: GenerateImageRequest,
  options: ImageApiOptions,
): Promise<ImageApiResult | null> {
  const job = await loadJob(jobFile);
  if (!job || job.state !== 'succeeded') return null;
  const { parameters } = validateImageServiceRequest(request, options);
  preflightImageEncoding(request, options);
  const extensionHash = await generationExtensionIdentity({
    extension: options.extension,
    modelSettings: options.endpoint?.modelSettings,
  });
  const mappedFields = options.extension?.mapping.imageFields?.(request, parameters) ?? {};
  const { testOnly, wireModel, endpointIdentity } = resolveBase(options, request);
  const declared = request.references ?? [];
  const provided = options.references ?? [];
  if (
    declared.length !== provided.length ||
    declared.length !== job.references.length ||
    job.inputSha256.length !== job.references.length
  )
    throw new ImageApiError(
      `Image API adapter: attempt '${job.attempt}' reference identity is incomplete or changed; refusing retained restore`,
    );
  const identities: Array<{
    assetId: string;
    revision: number;
    sha256: string;
    role: ReferenceRole;
    simulated: boolean;
  }> = [];
  for (const [index, ref] of declared.entries()) {
    const input = provided[index];
    if (!input || input.asset?.id !== ref.asset)
      throw new ImageApiError(
        `Image API adapter: attempt '${job.attempt}' current ordered reference descriptors changed`,
      );
    const parsedAsset = AssetSchema.safeParse(input.asset);
    const frozen = job.references[index];
    if (
      !parsedAsset.success ||
      parsedAsset.data.type !== 'image' ||
      !frozen ||
      frozen.asset !== ref.asset ||
      frozen.role !== ref.role ||
      frozen.revision !== parsedAsset.data.revision ||
      frozen.sha256 !== parsedAsset.data.sha256 ||
      job.inputSha256[index] !== parsedAsset.data.sha256
    )
      throw new ImageApiError(
        `Image API adapter: attempt '${job.attempt}' is bound to a different frozen request (reference ID, revision, role, or declared sha256 changed)`,
      );
    try {
      await assertOptionalReferenceBytesMatch(input.root, parsedAsset.data, 'Image API adapter');
    } catch (error) {
      throw new ImageApiError((error as Error).message);
    }
    identities.push({
      assetId: parsedAsset.data.id,
      revision: parsedAsset.data.revision,
      sha256: parsedAsset.data.sha256,
      role: ref.role,
      simulated: parsedAsset.data.simulated,
    });
  }
  if (job.simulated !== (testOnly || identities.some(reference => reference.simulated)))
    throw new ImageApiError(
      `Image API adapter: attempt '${job.attempt}' simulated provenance differs from the current request`,
    );
  const mode: 'production' | 'test' = testOnly ? 'test' : 'production';
  const promptHash = stableHash(request.prompt);
  const inputSha256 = identities.map(reference => reference.sha256);
  const encodedRequest = vllmOmniImageRequestIdentity(
    request,
    wireModel,
    identities.map(reference => ({ role: reference.role, sha256: reference.sha256 })),
    mappedFields,
  );
  const requestHash = stableHash({
    protocolVersion: PROTOCOL_VERSION,
    extensionHash,
    parameters,
    request: encodedRequest,
    kind: PROVIDER,
    model: request.model,
    mode,
    baseIdentity: endpointIdentity,
    endpoint: request.endpoint,
    id: request.id,
    operation: request.operation,
    promptHash,
    size: request.size ?? null,
    seed: request.seed ?? null,
    inputSha256,
  });
  if (
    job.requestHash !== requestHash ||
    job.endpoint !== request.endpoint ||
    job.sourceId !== request.id ||
    job.model !== request.model ||
    job.operation !== request.operation ||
    job.mode !== mode ||
    job.extensionHash !== extensionHash ||
    job.promptHash !== promptHash ||
    stableHash(job.size ?? null) !== stableHash(request.size ?? null) ||
    stableHash(job.seed ?? null) !== stableHash(request.seed ?? null)
  )
    throw new ImageApiError(
      `Image API adapter: attempt '${job.attempt}' is bound to a different current request; refusing retained restore`,
    );
  if (!job.outputPath || !job.outputSha256)
    throw new ImageApiError(`Image API adapter: attempt '${job.attempt}' is succeeded without retained provenance`);
  if (destination === undefined) return successResult(job);
  let retainedPath: string;
  try {
    retainedPath = await resolveProjectPath(rootAbs, job.outputPath);
  } catch {
    throw new ImageApiError(
      `Image API adapter: attempt '${job.attempt}' retained image path is unsafe; not resubmitting`,
    );
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(retainedPath);
  } catch {
    throw new ImageApiError(
      `Image API adapter: attempt '${job.attempt}' retained provider image is missing; not resubmitting`,
    );
  }
  if (createHash('sha256').update(bytes).digest('hex') !== job.outputSha256)
    throw new ImageApiError(
      `Image API adapter: attempt '${job.attempt}' retained provider image is damaged; not resubmitting`,
    );
  if (destination !== undefined) await writeAtomic(destination, bytes);
  return successResult(job);
}

async function runGeneration(ctx: GenerationContext): Promise<ImageApiResult> {
  const {
    rootAbs,
    source,
    destAbs,
    jobsDir,
    mediaDir,
    jobFile,
    attempt,
    stem,
    baseUrl,
    testOnly,
    wireModel,
    credentialName,
    options,
    mode,
    requestHash,
    references,
    mappedFields,
    extensionHash,
  } = ctx;
  const uploadedAssetIds = references.map(reference => reference.assetId);
  const inputSha256 = references.map(reference => reference.sha256);

  const loaded = await loadJob(jobFile);
  if (loaded && loaded.requestHash !== requestHash) {
    throw new ImageApiError(
      `Image API adapter: attempt '${attempt}' is already bound to a different frozen request; create a new attempt id instead of reusing this one with changed parameters.`,
    );
  }
  if (
    loaded &&
    !imageJobMatchesPreparedRequest(loaded, {
      request: source,
      parameters: {},
      extensionHash,
      mappedFields,
      baseUrl,
      testOnly,
      wireModel,
      endpointIdentity: resolveBase(options, source).endpointIdentity,
      ...(credentialName !== undefined ? { credentialName } : {}),
      references,
      attempt,
      mode,
      requestHash,
    })
  ) {
    throw new ImageApiError(
      `Image API adapter: attempt '${attempt}' current reference provenance or Source identity differs from the submitted record; refusing to reuse it.`,
    );
  }
  let job: ImageApiJob;
  if (loaded) {
    await mkdir(jobsDir, { recursive: true });
    await mkdir(mediaDir, { recursive: true });
    job = loaded;
  } else {
    // Gate before any job record exists and before any network call. The
    // credential (if the endpoint declares one) is resolved here too, so a
    // missing/invalid secret fails loudly before a record is written.
    assertAuthorizedForSubmit(testOnly, options, uploadedAssetIds);
    credentialHeaders(credentialName);
    await mkdir(jobsDir, { recursive: true });
    await mkdir(mediaDir, { recursive: true });
    job = {
      schemaVersion: JOB_SCHEMA_VERSION,
      backend: `vllm-omni-image/${source.model}`,
      provider: PROVIDER,
      model: source.model,
      simulated: testOnly || references.some(reference => reference.simulated),
      mode,
      attempt,
      sourceId: Id.parse(source.id),
      endpoint: source.endpoint,
      operation: source.operation,
      promptHash: stableHash(source.prompt),
      requestHash,
      protocolVersion: PROTOCOL_VERSION,
      extensionHash,
      inputSha256,
      references: references.map(reference => ({
        asset: reference.assetId,
        revision: reference.revision,
        sha256: reference.sha256,
        role: reference.role,
      })),
      ...(source.size !== undefined ? { size: source.size } : {}),
      ...(source.seed !== undefined ? { seed: source.seed } : {}),
      state: 'created',
      submitted: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    await saveJob(jobFile, job);
  }

  // --- Terminal success: re-materialize from the retained original. ---
  if (job.state === 'succeeded') {
    if (!job.outputPath || !job.outputSha256)
      throw new ImageApiError(`Image API adapter: attempt '${attempt}' is succeeded without retained provenance`);
    let abs: string;
    try {
      abs = await resolveProjectPath(rootAbs, job.outputPath);
    } catch {
      throw new ImageApiError(
        `Image API adapter: attempt '${attempt}' retained image path is unsafe; not resubmitting.`,
      );
    }
    if (
      !existsSync(abs) ||
      createHash('sha256')
        .update(await readFile(abs))
        .digest('hex') !== job.outputSha256
    ) {
      throw new ImageApiError(
        `Image API adapter: attempt '${attempt}' retained provider image is missing or damaged; not resubmitting. Create a new attempt id if a fresh generation is required.`,
      );
    }
    await writeAtomic(destAbs, await readFile(abs));
    return successResult(job);
  }

  // --- Terminal failures: never auto-retried under this attempt. ---
  if (job.state === 'failed') {
    throw new ImageApiError(
      `Image API adapter: attempt '${attempt}' previously reached a permanent provider failure; not resubmitting. Create a new attempt id to retry.`,
    );
  }
  if (job.state === 'submit-unknown') {
    throw new ImageApiError(
      `Image API adapter: attempt '${attempt}' has an unknown submit outcome; the adapter will not resubmit (there is no verified idempotency lookup). Create a new attempt id if the original produced nothing.`,
    );
  }
  if (job.state === 'submitting') {
    job = patchJob(job, { state: 'submit-unknown', error: 'process interrupted during submit' });
    await saveJob(jobFile, job);
    throw new ImageApiError(
      `Image API adapter: attempt '${attempt}' was interrupted during submit; the outcome is unknown and it will not be resubmitted.`,
    );
  }

  if (job.state === 'created') {
    // A fresh POST is about to happen. First run the caller's read-only guard at
    // the last moment before the network call (it still runs on a `created`
    // record loaded from disk, i.e. a legal attempt never sent). A guard failure
    // leaves the record `created` (not `submitting`), which stays legally
    // submittable — and no request was sent.
    if (options.assertSubmitAllowed) await options.assertSubmitAllowed();
    // Re-assert the submit gate (including per-Asset transmission consent), and
    // resolve the credential at call time. This is the ONLY path to the network.
    assertAuthorizedForSubmit(testOnly, options, uploadedAssetIds);
    const headers = credentialHeaders(credentialName);
    const submitting = patchJob(job, { state: 'submitting', submitted: job.submitted + 1 });
    await saveJob(jobFile, submitting);
    job = submitting;

    const outcome = await submitImage(baseUrl, source, wireModel, headers, references, mappedFields);

    if (outcome.kind === 'unknown') {
      job = patchJob(job, { state: 'submit-unknown', error: outcome.detail });
      await saveJob(jobFile, job);
      throw new ImageApiError(
        `Image API adapter: submit outcome for attempt '${attempt}' is unknown; not resubmitting.`,
      );
    }
    if (outcome.kind === 'rejected' || outcome.kind === 'unusable') {
      job = patchJob(job, { state: 'failed', error: outcome.detail });
      await saveJob(jobFile, job);
      throw new ImageApiError(
        `Image API adapter: the provider did not produce a usable image for attempt '${attempt}': ${outcome.detail}`,
      );
    }

    const sha256 = createHash('sha256').update(outcome.bytes).digest('hex');
    const ext = outcome.mime === 'image/png' ? 'png' : 'jpg';
    const retainedRel = `${MEDIA_DIR_REL}/image-api-${stem}.${ext}`;
    const retainedAbs = await resolveProjectPath(rootAbs, retainedRel);
    // Retain the provider original FIRST, then persist the definite-success
    // evidence (state + retained path/hash) BEFORE writing the caller's target.
    // A target-write failure therefore leaves a `succeeded` record whose retained
    // original is intact: the next run re-materializes the target from it with ZERO
    // POST (instead of leaving `submitting` and flipping to `submit-unknown`).
    await writeAtomic(retainedAbs, outcome.bytes);
    job = patchJob(job, { state: 'succeeded', outputPath: retainedRel, outputSha256: sha256, error: undefined });
    await saveJob(jobFile, job);
    await writeAtomic(destAbs, outcome.bytes);
    return successResult(job);
  }

  throw new ImageApiError(`Image API adapter: attempt '${attempt}' reached unexpected state '${job.state}'`);
}

/**
 * List persisted image-api job records (validated; contains no prompts, image
 * bytes or remote URLs). Unsafe or invalid records are skipped rather than
 * surfaced.
 */
export async function imageApiStatus(root: string): Promise<unknown[]> {
  const rootAbs = resolve(root);
  let jobsDir: string;
  try {
    jobsDir = await resolveProjectPath(rootAbs, JOBS_DIR_REL);
  } catch {
    return [];
  }
  if (!existsSync(jobsDir)) return [];
  const entries = await readdir(jobsDir);
  const jobs: ImageApiJob[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    let file: string;
    try {
      file = await resolveProjectPath(rootAbs, `${JOBS_DIR_REL}/${name}`);
    } catch {
      continue;
    }
    if (!existsSync(file)) continue;
    try {
      const job = await loadJob(file);
      if (job) jobs.push(job);
    } catch {
      continue;
    }
  }
  jobs.sort((a, b) => a.attempt - b.attempt);
  return jobs;
}
