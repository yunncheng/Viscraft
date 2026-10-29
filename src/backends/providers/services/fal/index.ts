import { validateGenerationReferenceSet } from '../../extension.js';
import { readCapped } from '../../http-body.js';
import { materializeFromLocal, normalizeAtomic, pickMedia } from '../../local-media.js';
/**
 * fal.ai queue Provider adapter (model-agnostic).
 *
 * Real HTTP adapter for the fal *queue* protocol (no SDK runtime dependency),
 * shared by every fal mapping: the deployment model and the queue route come
 * from the effective binding and the mapping's own `endpointId`, never a
 * constant here. The transport carries whatever ordered IMAGE references the
 * effective Source declares (any role) as base64 data URIs; whether any is
 * required and what the roles mean is owned by the selected mapping/model, never
 * assumed here. The PACKAGED DEFAULT is the `alibaba/wan-3.0/image-to-video`
 * mapping — a required first frame and an optional last frame (`start_image_url`
 * / `end_image_url`), duration 2..30 s, resolution `480p|720p|1080p`, aspect
 * ratio `16:9|4:3|1:1|3:4|9:16`, optional audio, optional int32 seed; a
 * text-to-video mapping with no references runs through this same adapter.
 *
 * Wire contract for the packaged default (no source copied):
 *  - Official OpenAPI 3.0.4 (verified 2026-10-08), server `https://queue.fal.run`:
 *    `POST /alibaba/wan-3.0/image-to-video` → `{ status, request_id, status_url,
 *    response_url, ... }`; `GET .../requests/{id}/status` → `IN_QUEUE |
 *    IN_PROGRESS | COMPLETED`; `GET .../requests/{id}` → raw output `{ video:
 *    { url }, seed, duration }`. Inputs: `start_image_url` (required),
 *    `end_image_url?`, `prompt?`, `duration?` (2..30), `resolution?`,
 *    `aspect_ratio?`, `audio?`, `seed?` (0..2147483647).
 *    `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=alibaba/wan-3.0/image-to-video`
 *  - MIT `@fal-ai/client` (commit `9657065ca274910827667140e1923f5c2be2b281`,
 *    `1.11.0-alpha.0`) for queue paths + `Authorization: Key <FAL_KEY>`. It strips
 *    the endpoint subpath (`/alibaba/wan-3.0/requests/{id}`) while the OpenAPI keeps
 *    it; this adapter uses the returned `status_url`/`response_url` (origin-pinned,
 *    path bound to the request id, both forms accepted) and falls back to the
 *    official path.
 *  - Data-URI file inputs are documented by fal ("You can pass a Base64 data URI
 *    as a file input. The API will handle the file decoding.").
 *
 * Safety invariants:
 *  - production submit needs explicit `authorization.submit === true` + a key, and
 *    each transmitted image additionally needs per-Asset `uploadAssets` consent; a
 *    key or a redistributable license alone is never consent; the gate precedes
 *    the job record and any network call;
 *  - the source is re-validated locally; every condition image is a caller Asset
 *    re-checked with `AssetSchema`, read from its frozen root, matched to its
 *    sha256, PNG/JPEG by signature (never converted), byte-capped and re-hashed
 *    after base64 encoding; safety checker always on, expansion/thinking off;
 *  - a per-attempt lock refuses concurrency; the frozen request hash binds mode /
 *    base / source / output / images so a changed request under the same attempt is
 *    rejected;
 *  - the pre-submit record is written BEFORE the network call; an ambiguous submit
 *    (transport error, malformed body, 3xx/408/429/5xx, unusable queue URL) is
 *    `submit-unknown` and never auto-resubmitted;
 *  - a known request gets at most one status GET per invocation (>=5 s apart,
 *    persisted; bypassed in test mode) and one result GET; raw output only, no SDK
 *    wrapper, no invented cost (fal reports none);
 *  - original media is retained (probe + hash) and normalized via `normalizeMedia`;
 *    a failed download resumes without regenerating;
 *  - the key comes from the caller or `FAL_KEY` and is never persisted; records
 *    store a prompt hash and validated URL *paths* (never prompt, data URI or URL);
 *  - downloads are capped and guarded (production HTTPS, no userinfo, no
 *    loopback/private host, manual redirects; test same-origin loopback); no
 *    credentials reach the media host. The host check is best-effort, not a sandbox.
 *  - `cancelFal` cancels an already-submitted request with at most one PUT to the
 *    request-scoped cancel path; it never submits, never needs `submit` consent,
 *    marks the job `cancelled` only on a documented `CANCELLATION_REQUESTED`, and
 *    surfaces `ALREADY_COMPLETED` / `NOT_FOUND` as errors. It does not un-bill an
 *    in-progress generation.
 *
 * Only with a real account, key and explicit authorization does this run a real
 * (billable) generation. Tests use a loopback fixture and mark records `simulated`.
 */

import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { credentialSetupHint, resolveCredential } from '../../../../config/credentials.js';
import type { Asset, MediaInfo, OutputSettings, ProviderSource, ReferenceRole } from '../../../../core/schema.js';
import {
  AssetSchema,
  Id,
  MediaInfoSchema,
  OutputSchema,
  ReferenceRoleSchema,
  SourceSchema,
} from '../../../../core/schema.js';
import { resolveProjectPath } from '../../../../shared/fs.js';
import { hashFile, stableHash } from '../../../../shared/hash.js';
import { redact } from '../../../../shared/process.js';
import { probeMedia } from '../../../media/probe.js';
import { isPrivateAddress } from '../../address.js';
import {
  attemptIdentityChanges,
  attemptInspection,
  attemptRecordFacts,
  changedFields,
  localBytesPresent,
  readAttemptRecord,
  restoreCompletedAttempt,
  type AttemptInspection,
} from '../../attempt.js';
import { resolveEffectiveExtension } from '../../effective.js';
import {
  generationExtensionIdentity,
  validateGenerationExtension,
  type MappingReference,
  type MappingReferenceIdentity,
} from '../../extension.js';
import {
  acquireAttemptLock as acquireSharedAttemptLock,
  attemptStem,
  loadJobRecord,
  patchJobRecord,
  saveJobRecord,
} from '../../job-store.js';
import { resolveVideoLane, stripBrackets, transmittedReferences, type VideoLaneSource } from '../../lane.js';
import { packagedExtensionFor } from '../../models/registry.js';
import { prepareVideoRequest, type PrepareVideoOptions } from '../../prepare.js';
import { assertOptionalReferenceBytesMatch, referenceFacts } from '../../reference-facts.js';
import { FAL_DATA_URI_BYTES, FAL_IMAGE_RAW_BYTES } from '../../transfer-bounds.js';
import type { VideoApiOptions } from '../video-tasks.js';

const BACKEND = 'fal-wan-3.0';
const PROVIDER = 'fal';
const PROTOCOL_VERSION = 1;
/** The one transport this adapter speaks (Plan's inspection uses the same id). */
const FAL_PROTOCOL = 'fal-queue' as const;
const JOB_SCHEMA_VERSION = 1;

/** Reference SDK the queue paths/auth header were read from (MIT). No code copied. */
const SDK_REFERENCE_COMMIT = '9657065ca274910827667140e1923f5c2be2b281';
const SDK_REFERENCE_VERSION = '1.11.0-alpha.0';

const PRODUCTION_BASE = 'https://queue.fal.run';

/**
 * fal-specific route facet: the queue submit/status/result/cancel paths derive
 * from the mapping's `endpointId` rather than a hardcoded literal. `endpointId`
 * is a fal-local property of the selected `ServiceMapping`, checked by
 * `prepareVideoRequest` before any request is built.
 */
interface QueueRoutes {
  endpointId: string;
  submitPath: string;
  statusPath(requestId: string): string;
  resultPath(requestId: string): string;
  cancelPath(requestId: string): string;
  matches(pathname: string, requestId: string, role: 'status' | 'result' | 'cancel'): boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Derive queue paths and the request-/role-bound path pattern from an endpoint
 * id. The returned `status_url`/`response_url` may use the official
 * endpoint-scoped form (`/<endpointId>/requests/<id>`) or the SDK's stripped
 * parent form (`/<parent>/requests/<id>`); both are accepted, with the role
 * enforced (`/status` vs. `/cancel` vs. bare result).
 */
function queueRoutes(endpointId: string): QueueRoutes {
  const parent = endpointId.replace(/\/[^/]+$/, '');
  const leaf = endpointId.slice(parent.length + 1);
  const base = `^/${escapeRegExp(parent)}/(?:${escapeRegExp(leaf)}/)?requests/`;
  return {
    endpointId,
    submitPath: `/${endpointId}`,
    statusPath: requestId => `/${endpointId}/requests/${requestId}/status`,
    resultPath: requestId => `/${endpointId}/requests/${requestId}`,
    cancelPath: requestId => `/${endpointId}/requests/${requestId}/cancel`,
    matches: (pathname, requestId, role) =>
      new RegExp(
        `${base}${escapeRegExp(requestId)}${role === 'status' ? '/status$' : role === 'cancel' ? '/cancel$' : '$'}`,
      ).test(pathname),
  };
}

const DEFAULT_CREDENTIAL = 'FAL_KEY';
// Fixed, non-secret credential sent to the loopback fixture. Test mode never reads
// the environment key or forwards the caller's real key to localhost.
const TEST_FIXTURE_CREDENTIAL = 'fixture';

const JOBS_DIR_REL = '.viscraft/jobs/fal';
const MEDIA_DIR_REL = '.viscraft/provider-media';

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
// A raw reference image is capped so its base64 data URI stays modest. The caps
// come from the ONE `transfer-bounds.ts` so the preflight check in `prepare.ts`
// and this final byte-exact guard cannot drift.
const MAX_IMAGE_RAW_BYTES = FAL_IMAGE_RAW_BYTES;
const MAX_DATA_URI_BYTES = FAL_DATA_URI_BYTES;
const JSON_TIMEOUT_MS = 30_000;
const MEDIA_TIMEOUT_MS = 300_000;
const MIN_QUERY_INTERVAL_MS = 5_000;
const MAX_REDIRECTS = 3;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Portable provider provenance attached to a successful artifact. No signed URLs,
 * no credentials, no invented cost (fal reports none).
 */
export interface FalGeneration {
  provider: 'fal';
  model: string;
  taskId: string;
  requestHash: string;
  originalSha256: string;
  /** Content hash of the model definition + service mapping that produced the request. */
  extensionHash: string;
  originalMedia?: MediaInfo;
  /** The image references actually transmitted, in declared order, by content hash and role. */
  references: { asset: string; sha256: string; category: 'image'; role: ReferenceRole }[];
}

export interface FalResult {
  backend: string;
  generation?: FalGeneration;
}

/**
 * Documented capabilities of this adapter's *implementation*, not of any account.
 * Not entitlement, pricing, quota or availability information.
 *
 * CAPABILITY SCOPE (`capabilityScope: 'protocol'`): these are TRANSPORT-level
 * facts of the implemented `fal-queue` lane — the queue submit/status/result
 * paths (derived from the selected mapping's `endpointId`), the task lifecycle,
 * the credential handling, the reference encoding and the cancel behaviour. They
 * describe the WIRE PROTOCOL only and are model-agnostic: a Project may select
 * any fal queue model (or its own `GenerationExtension`).
 *
 * LIMIT PROVENANCE: this transport is model-agnostic. Each model's own
 * parameters, resolutions, ratios, duration range, audio requirement, seed range
 * and prompt length are owned by that model definition's zod schema (see
 * `models/*`), never restated here. The reference SHAPE is structural: the
 * selected queue mapping names its image references (any role) and the transport
 * carries them as data URIs; whether any is required is model-owned.
 */
export const falCapabilities = {
  capabilityScope: 'protocol',
  backend: BACKEND,
  provider: PROVIDER,
  productionBaseUrl: PRODUCTION_BASE,
  modality: 'text-to-video | image-to-video (image references by role)',
  textOnly: false,
  promptImage: {
    supported: true,
    // Whether a prompt image is REQUIRED, and what its role means, belongs to the
    // selected model definition + mapping, never to the transport.
    required: false,
    encoding: 'base64-data-uri',
    formats: ['image/png', 'image/jpeg'],
  },
  endImage: { supported: true, encoding: 'base64-data-uri', formats: ['image/png', 'image/jpeg'] },
  // Always forced on; the adapter never disables moderation.
  safetyChecker: true,
  promptExpansion: false,
  thinking: false,
  supportsTailFrame: true,
  // Deliberately neither implemented nor claimed.
  supportsVideoReference: false,
  supportsVideoEditing: false,
  supportsHostedUpload: false,
  supportsTaskStatusLookup: true,
  supportsIdempotencyKeyLookup: false,
  cancel: {
    supported: true,
    note:
      'For a job already in the `submitted` state, sends at most one PUT to the request-scoped cancel path. A 2xx ' +
      'CANCELLATION_REQUESTED marks the job terminal `cancelled`; ALREADY_COMPLETED and NOT_FOUND are surfaced as ' +
      'loud errors and never treated as cancellation. Cancelling does not un-bill an in-progress generation.',
  },
  clientSdkReference: {
    package: '@fal-ai/client',
    version: SDK_REFERENCE_VERSION,
    commit: SDK_REFERENCE_COMMIT,
    license: 'MIT',
  },
  accountAvailability: 'unknown',
  note:
    "Documents the implemented HTTP transport for the fal queue lane: the selected mapping's image " +
    'references sent as base64 PNG/JPEG data URIs, with the queue submit/status/result/cancel paths derived ' +
    "from the selected mapping's `endpointId`. It is transport-only and model-agnostic: each selected model " +
    'owns its own parameters, limits and whether an image reference is required. It is NOT account entitlement, ' +
    'pricing, rate-limit or availability information and never implies a successful generation. Production ' +
    'submission requires explicit authorization plus a key, and each transmitted image needs additional explicit ' +
    'per-Asset upload consent; test-only runs target a loopback fixture and are simulated.',
} as const;

export class FalProviderError extends Error {
  /** True when the caller can safely re-run the *same* attempt later (no resubmit). */
  recoverable = false;
  constructor(message: string) {
    super(message);
    this.name = 'FalProviderError';
  }
}

/** A recoverable, non-fatal state: re-run to continue, never to resubmit. */
export class FalPendingError extends FalProviderError {
  readonly nextQueryAt?: string;
  constructor(message: string, nextQueryAt?: string) {
    super(message);
    this.name = 'FalPendingError';
    this.recoverable = true;
    this.nextQueryAt = nextQueryAt;
  }
}

// ---------------------------------------------------------------------------
// Persisted job record
// ---------------------------------------------------------------------------

const jobStateSchema = z.enum([
  'created',
  'submitting',
  'submit-unknown',
  'submitted',
  'cancelled',
  'remote-completed',
  'download-failed',
  'succeeded',
  'failed',
]);

const imageRefSchema = z
  .object({ id: Id, sha256: z.string().regex(/^[a-f0-9]{64}$/), type: z.literal('image'), role: ReferenceRoleSchema })
  .strict();

const jobSchema = z
  .object({
    schemaVersion: z.literal(JOB_SCHEMA_VERSION),
    backend: z.literal(BACKEND),
    provider: z.literal(PROVIDER),
    model: z.string().min(1),
    simulated: z.boolean(),
    mode: z.enum(['production', 'test']),
    attempt: Id,
    sourceId: Id,
    promptHash: z.string().regex(/^[a-f0-9]{64}$/),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    extensionHash: z.string().regex(/^[a-f0-9]{64}$/),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    // The mapping's route facet: the queue paths this attempt was submitted to,
    // so recovery/cancel never re-derive them from a hardcoded literal.
    endpointId: z.string().min(1),
    // A NON-REVERSIBLE hash of the full queue base URL (scheme + host + any path
    // prefix) this attempt was submitted to. Binding it to the record means a
    // cancel can never be redirected to a different service than the submit,
    // while no remote URL is ever persisted (the record keeps only this hash).
    queueHash: z.string().regex(/^[a-f0-9]{64}$/),
    // The model-agnostic validated parameters; model-specific meaning lives in
    // the selected definition, never in a per-model job column.
    parameters: z.record(z.unknown()),
    // The image references actually transmitted, in declared order: id/hash/role
    // only, never bytes or a data URI. Empty for a text-to-video mapping.
    references: z.array(imageRefSchema),
    output: OutputSchema,
    state: jobStateSchema,
    submitted: z.number().int().nonnegative(),
    requestId: z.string().min(1).optional(),
    // Validated queue URL *paths* only — never a full/signed URL or a query token.
    statusPath: z.string().min(1).optional(),
    responsePath: z.string().min(1).optional(),
    providerSeed: z.number().int().optional(),
    providerDurationSeconds: z.number().finite().optional(),
    nextQueryAt: z.string().min(1).optional(),
    originalMediaPath: z.string().min(1).optional(),
    originalMediaSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    originalMedia: MediaInfoSchema.optional(),
    artifactPath: z.string().min(1).optional(),
    artifactSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    artifact: MediaInfoSchema.optional(),
    // The output spec the recorded artifact was ACTUALLY produced under. A
    // DURABLE fact: reuse is gated on it matching the request's current `output`,
    // so a changed local output never silently returns old-spec media across a
    // failed materialization or a restart. Absent => unknown provenance => never
    // reused (the retained original is re-normalized instead).
    artifactOutput: OutputSchema.optional(),
    downloadAttempted: z.boolean().optional(),
    error: z.string().min(1).optional(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();

export type FalJob = z.infer<typeof jobSchema>;
export type FalJobState = z.infer<typeof jobStateSchema>;

function now(): string {
  return new Date().toISOString();
}

function patchJob(job: FalJob, changes: Partial<FalJob>): FalJob {
  return patchJobRecord(job, changes, now());
}

function successResult(job: FalJob): FalResult {
  if (!job.requestId || !job.originalMediaSha256) {
    throw new FalProviderError(
      'fal adapter: a succeeded job is missing provider provenance (request id / original media hash)',
    );
  }
  return {
    backend: BACKEND,
    generation: {
      provider: PROVIDER,
      model: job.model,
      taskId: job.requestId,
      requestHash: job.requestHash,
      originalSha256: job.originalMediaSha256,
      extensionHash: job.extensionHash,
      ...(job.originalMedia ? { originalMedia: job.originalMedia } : {}),
      references: job.references.map(reference => ({
        asset: reference.id,
        sha256: reference.sha256,
        category: 'image' as const,
        role: reference.role,
      })),
    },
  };
}

async function loadJob(jobFile: string): Promise<FalJob | null> {
  return loadJobRecord(jobFile, jobSchema, 'fal adapter', message => new FalProviderError(message));
}

/**
 * Locate the unique persisted job whose recorded `attempt` matches. Job records
 * are keyed by the Source-scoped stem, and filenames identify both the Source and attempt;
 * when two Sources share an attempt id the lookup is ambiguous and refuses
 * rather than cancelling the wrong request.
 */
async function findJobByAttempt(rootAbs: string, attempt: string): Promise<{ file: string; job: FalJob } | null> {
  let jobsDir: string;
  try {
    jobsDir = await resolveProjectPath(rootAbs, JOBS_DIR_REL);
  } catch {
    return null;
  }
  if (!existsSync(jobsDir)) return null;
  const matches: { file: string; job: FalJob }[] = [];
  for (const name of await readdir(jobsDir)) {
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
      if (job && job.attempt === attempt) matches.push({ file, job });
    } catch {
      continue;
    }
  }
  if (matches.length > 1)
    throw new FalProviderError(
      `fal adapter: attempt '${attempt}' matches ${matches.length} job records across Sources; cancel is ambiguous. Use a unique attempt id per Source.`,
    );
  return matches[0] ?? null;
}

async function saveJob(jobFile: string, job: FalJob): Promise<void> {
  await saveJobRecord(jobFile, job);
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

async function resolveDestination(rootAbs: string, destination: string): Promise<{ abs: string; rel: string }> {
  if (!destination || destination.includes('\0')) throw new FalProviderError('fal adapter: invalid destination path');
  let rel: string;
  if (isAbsolute(destination)) {
    const base = await realpath(rootAbs);
    rel = relative(base, normalize(destination)).split(sep).join('/');
    if (!rel || rel.startsWith('..') || isAbsolute(rel))
      throw new FalProviderError('fal adapter: destination escapes project root');
  } else {
    rel = destination;
  }
  const abs = await resolveProjectPath(rootAbs, rel);
  return { abs, rel };
}

// ---------------------------------------------------------------------------
// Options / authorization / base resolution
// ---------------------------------------------------------------------------

/**
 * The effective queue TARGET (base URL + mode) for a NON-request operation
 * (cancel), resolved by the SHARED `lane.ts` resolver so Plan and Produce agree.
 * Request preparation resolves the same lane through `prepareVideoRequest`; the
 * fal queue paths are relative to the whole BASE (scheme + host + any deployment
 * path prefix), so the full normalized base is returned — never just its origin.
 */
function resolveQueueTarget(options: VideoApiOptions, source: VideoLaneSource): { baseUrl: string; testOnly: boolean } {
  // This adapter IS the `fal-queue` lane, so its own protocol is injected here: a
  // direct call need not restate `endpoint.protocol`, and the vendor production
  // default/credential env still apply. A caller-supplied endpoint cannot select
  // another lane.
  const lane = resolveVideoLane(
    { ...options, endpoint: { ...options.endpoint, protocol: FAL_PROTOCOL } },
    source,
    'fal adapter',
  );
  return { baseUrl: lane.baseUrl, testOnly: lane.testOnly };
}

/**
 * Test mode NEVER consults the caller key or the environment: the loopback fixture
 * receives a fixed, non-secret placeholder. Production resolves the Endpoint's
 * named `credential` (default `FAL_KEY`) from the environment or the user store.
 */
function resolveApiKey(options: VideoApiOptions, testOnly: boolean): string | undefined {
  if (testOnly) return undefined;
  return resolveCredential(credentialName(options));
}

function credentialName(options: VideoApiOptions): string {
  return options.endpoint?.credential ?? DEFAULT_CREDENTIAL;
}

/**
 * Production submission requires BOTH explicit authorization and a key, and every
 * transmitted image additionally requires per-Asset upload consent. Runs before
 * any job record or network call.
 */
function assertAuthorizedForSubmit(
  testOnly: boolean,
  apiKey: string | undefined,
  options: VideoApiOptions,
  uploadAssetIds: string[],
): void {
  if (testOnly) return;
  if (options.authorization?.submit !== true) {
    throw new FalProviderError(
      'fal adapter: production submission requires explicit authorization (`{ authorization: { submit: true } }`); no request was sent and no job was created.',
    );
  }
  if (!apiKey) {
    throw new FalProviderError(
      `fal adapter: no API key available (${credentialSetupHint(credentialName(options))}); no request was sent and no job was created.`,
    );
  }
  for (const assetId of uploadAssetIds) {
    if (!options.authorization.uploadAssets?.includes(assetId)) {
      throw new FalProviderError(
        `fal adapter: transmitting reference image Asset '${assetId}' requires explicit per-Asset upload authorization ` +
          `(\`{ authorization: { submit: true, uploadAssets: ['${assetId}'] } }\`); a redistributable license is NOT upload consent. ` +
          'No request was sent and no job was created.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Reference image resolution (every transmitted image reference, by declared role)
// ---------------------------------------------------------------------------

interface ResolvedImage {
  assetId: string;
  sha256: string;
  /** The declared reference role this image is transmitted under. */
  role: ReferenceRole;
  mime: 'image/png' | 'image/jpeg';
  simulated: boolean;
  bytes: Buffer;
}

interface ImageIdentity {
  assetId: string;
  sha256: string;
  role: ReferenceRole;
  simulated: boolean;
}

/** Identify the image container by magic bytes. SVG/other formats are not matched. */
function detectImageMime(bytes: Buffer): 'image/png' | 'image/jpeg' | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}

/**
 * Resolve one approved declared reference into a validated data-URI payload. The
 * ONLY accepted source is a caller-provided `options.references` entry whose
 * Asset id matches the Source reference: nothing is fetched, generated or
 * substituted. Bytes must match the recorded sha256, be PNG/JPEG by signature,
 * and the encoded payload is re-hashed. Runs before the per-attempt lock, any job
 * record and any network call.
 */
async function resolveImage(
  reference: { asset: string; category: string; role: ReferenceRole },
  provided: { asset: Asset; root: string }[],
): Promise<ResolvedImage> {
  const requested = reference.asset;
  if (reference.category !== 'image') {
    throw new FalProviderError(
      `fal adapter: the queue transport carries image references only, not '${reference.category}'; no request was sent and no job was created.`,
    );
  }
  const match = provided.find(entry => entry.asset?.id === requested);
  if (!match || typeof match.root !== 'string' || match.root.length === 0) {
    throw new FalProviderError(
      `fal adapter: Source references image Asset '${requested}' (role '${reference.role}') but no matching options.references entry (asset + frozen root) was provided; no request was sent and no job was created.`,
    );
  }
  const duplicates = provided.filter(entry => entry.asset?.id === requested);
  if (new Set(duplicates.map(entry => `${entry.asset.sha256}:${entry.asset.path}`)).size > 1) {
    throw new FalProviderError(
      `fal adapter: reference image Asset '${requested}' has conflicting duplicate options.references entries (same id, different sha256/path); refusing before any request.`,
    );
  }
  const parsed = AssetSchema.safeParse(match.asset);
  if (!parsed.success) throw new FalProviderError('fal adapter: the provided reference image is not a valid Asset');
  const asset = parsed.data;
  if (asset.type !== 'image') throw new FalProviderError(`fal adapter: reference Asset '${asset.id}' is not an image`);
  if (asset.id !== requested)
    throw new FalProviderError(
      `fal adapter: the provided reference Asset '${asset.id}' does not match '${requested}'; refusing before any request.`,
    );
  let abs: string;
  try {
    abs = await resolveProjectPath(match.root, asset.path);
  } catch {
    throw new FalProviderError(
      `fal adapter: reference image Asset '${asset.id}' does not resolve to a safe path inside its frozen root`,
    );
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(abs);
  } catch {
    throw new FalProviderError(
      `fal adapter: reference image Asset '${asset.id}' could not be read from the frozen asset root`,
    );
  }
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
    throw new FalProviderError(
      `fal adapter: reference image Asset '${asset.id}' bytes do not match its recorded sha256; refusing to send`,
    );
  }
  if (bytes.length > MAX_IMAGE_RAW_BYTES) {
    throw new FalProviderError(
      `fal adapter: reference image Asset '${asset.id}' is ${bytes.length} bytes, over the ${MAX_IMAGE_RAW_BYTES}-byte raw limit`,
    );
  }
  const mime = detectImageMime(bytes);
  if (!mime)
    throw new FalProviderError(
      `fal adapter: reference image Asset '${asset.id}' is not a PNG or JPEG (by signature); SVG and other formats are refused rather than converted`,
    );
  const dataUri = `data:${mime};base64,${bytes.toString('base64')}`;
  if (Buffer.byteLength(dataUri, 'utf8') > MAX_DATA_URI_BYTES)
    throw new FalProviderError(
      `fal adapter: reference image Asset '${asset.id}' encodes to a data URI over the cap; refusing to send`,
    );
  const decodedHash = createHash('sha256')
    .update(Buffer.from(dataUri.slice(dataUri.indexOf(',') + 1), 'base64'))
    .digest('hex');
  if (decodedHash !== asset.sha256)
    throw new FalProviderError(
      `fal adapter: reference image Asset '${asset.id}' failed the post-encoding byte integrity check; refusing to send`,
    );
  return Object.freeze({
    assetId: asset.id,
    sha256: asset.sha256,
    role: reference.role,
    mime,
    simulated: asset.simulated,
    bytes,
  });
}

/** Current ordered reference identity for a previously submitted fal task. */
async function resumeImageIdentity(
  reference: { asset: string; category: string; role: ReferenceRole },
  provided: { asset: Asset; root: string }[],
  job: FalJob,
  index: number,
): Promise<ImageIdentity> {
  if (reference.category !== 'image')
    throw new FalProviderError(`fal adapter: attempt '${job.attempt}' reference category changed`);
  const matches = provided.filter(entry => entry.asset?.id === reference.asset);
  if (matches.length !== 1)
    throw new FalProviderError(
      `fal adapter: attempt '${job.attempt}' needs exactly its original reference Asset descriptor`,
    );
  const parsed = AssetSchema.safeParse(matches[0].asset);
  const frozen = job.references[index];
  if (
    !parsed.success ||
    !frozen ||
    parsed.data.id !== reference.asset ||
    parsed.data.type !== 'image' ||
    frozen.id !== reference.asset ||
    frozen.sha256 !== parsed.data.sha256 ||
    frozen.role !== reference.role
  )
    throw new FalProviderError(
      `fal adapter: attempt '${job.attempt}' reference Asset identity, sha256, or role changed`,
    );
  try {
    await assertOptionalReferenceBytesMatch(matches[0].root, parsed.data, 'fal adapter');
  } catch (error) {
    throw new FalProviderError((error as Error).message);
  }
  return {
    assetId: parsed.data.id,
    sha256: parsed.data.sha256,
    role: reference.role,
    simulated: parsed.data.simulated,
  };
}

// ---------------------------------------------------------------------------
// Per-attempt lock
// ---------------------------------------------------------------------------

async function acquireAttemptLock(rootAbs: string, stem: string, attempt: string): Promise<() => Promise<void>> {
  return acquireSharedAttemptLock({
    rootAbs,
    stem,
    attempt,
    dirRel: JOBS_DIR_REL,
    label: 'fal adapter',
    conflict: message => new FalProviderError(message),
  });
}

// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------

function authHeaders(credential: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (credential) headers.Authorization = `Key ${credential}`;
  return headers;
}

async function jsonRequest(req: {
  url: string;
  method: 'GET' | 'POST' | 'PUT';
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}): Promise<{ status: number; text: string }> {
  const init: RequestInit = {
    method: req.method,
    headers: req.body === undefined ? req.headers : { ...req.headers, 'Content-Type': 'application/json' },
    redirect: 'manual',
    signal: AbortSignal.timeout(req.timeoutMs ?? JSON_TIMEOUT_MS),
  };
  if (req.body !== undefined) init.body = JSON.stringify(req.body);
  const response = await fetch(req.url, init);
  const buf = await readCapped(
    response,
    MAX_JSON_BYTES,
    () => new FalProviderError('fal adapter: response exceeded the configured size cap'),
  );
  return { status: response.status, text: buf.toString('utf8') };
}

/** The deployment path prefix of a normalized base URL ('' when it is an origin). */
function basePathPrefix(baseUrl: string): string {
  return new URL(baseUrl).pathname.replace(/\/+$/, '');
}

/** A queue pathname made relative to the base's own path prefix (idempotent when there is none). */
function relativeQueuePath(baseUrl: string, pathname: string): string {
  const prefix = basePathPrefix(baseUrl);
  if (prefix && (pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    const rest = pathname.slice(prefix.length);
    return rest === '' ? '/' : rest;
  }
  return pathname;
}

/**
 * Validate a queue URL returned by the provider: pinned origin, no credentials, no
 * query/fragment (a signed query would be an auth secret we must neither use nor
 * persist), and a path bound to the request id AND the role. Both the official
 * endpoint-scoped form (`/<endpointId>/requests/{id}`) and the SDK's stripped
 * parent form (`/<parent>/requests/{id}`) are accepted; a `status` URL must end
 * in `/status` and a `result` URL must not. A deployment path prefix (part of the
 * resolved base) is stripped before the route match so a prefixed base is not
 * silently ignored. Returns the path relative to the base, never the full URL.
 */
function validateReturnedPath(
  raw: string,
  requestId: string,
  baseUrl: string,
  testOnly: boolean,
  role: 'status' | 'result',
  routes: QueueRoutes,
): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FalProviderError('fal adapter: provider returned an invalid queue URL');
  }
  if (url.username || url.password || url.search || url.hash)
    throw new FalProviderError(
      'fal adapter: refusing a queue URL that carries credentials, query parameters or a fragment',
    );
  if (url.origin !== new URL(baseUrl).origin)
    throw new FalProviderError('fal adapter: refusing a queue URL outside the configured queue origin');
  if (!testOnly && url.protocol !== 'https:')
    throw new FalProviderError('fal adapter: production queue URLs must use HTTPS');
  const path = relativeQueuePath(baseUrl, url.pathname);
  if (!routes.matches(path, requestId, role)) {
    throw new FalProviderError(`fal adapter: queue URL does not match the expected ${role} path; refusing to use it`);
  }
  return path;
}

/** Rebuild a queue URL from a persisted (base-relative) path, re-checking the request- and role-bound form. */
function queueUrl(
  baseUrl: string,
  path: string,
  requestId: string,
  role: 'status' | 'result' | 'cancel',
  routes: QueueRoutes,
): string {
  if (!routes.matches(path, requestId, role)) throw new FalProviderError('fal adapter: refusing an unsafe queue path');
  return `${baseUrl}${path}`;
}

const queueStatusSchema = z.object({
  status: z.enum(['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED']),
  request_id: z.string().min(1),
  status_url: z.string().min(1).optional(),
  response_url: z.string().min(1).optional(),
});

const resultSchema = z.object({
  video: z.object({ url: z.string().min(1) }).passthrough(),
  seed: z.number().int().optional(),
  duration: z.number().finite().optional(),
});

// Documented cancel bodies: 202 `CANCELLATION_REQUESTED` (accepted), 400
// `ALREADY_COMPLETED`, 404 `NOT_FOUND`. Any other body is treated as unrecognised
// (never a fake success).
const cancelResponseSchema = z.object({ status: z.string().min(1) }).passthrough();

type SubmitOutcome =
  | { kind: 'accepted'; requestId: string; statusPath: string; responsePath: string }
  | { kind: 'unknown'; detail: string }
  | { kind: 'rejected'; detail: string };

function snippetStatus(status: number): string {
  return `HTTP ${status}`;
}

/** Submit exactly once. Every ambiguous outcome is reported as `unknown`. */
async function submitRequest(
  baseUrl: string,
  credential: string | undefined,
  body: unknown,
  testOnly: boolean,
  routes: QueueRoutes,
): Promise<SubmitOutcome> {
  let response: { status: number; text: string };
  try {
    response = await jsonRequest({
      url: `${baseUrl}${routes.submitPath}`,
      method: 'POST',
      headers: authHeaders(credential),
      body,
    });
  } catch (error) {
    return {
      kind: 'unknown',
      detail: `submit transport error: ${redact(error instanceof Error ? error.message : String(error))}`,
    };
  }
  const { status } = response;
  if (status >= 200 && status < 300) {
    let parsed: z.infer<typeof queueStatusSchema>;
    try {
      parsed = queueStatusSchema.parse(JSON.parse(response.text));
    } catch {
      return { kind: 'unknown', detail: 'submit returned an unexpected or malformed response body' };
    }
    if (!REQUEST_ID_PATTERN.test(parsed.request_id))
      return { kind: 'unknown', detail: 'submit response carried an unusable request id' };
    let statusPath: string;
    let responsePath: string;
    try {
      statusPath = parsed.status_url
        ? validateReturnedPath(parsed.status_url, parsed.request_id, baseUrl, testOnly, 'status', routes)
        : routes.statusPath(parsed.request_id);
      responsePath = parsed.response_url
        ? validateReturnedPath(parsed.response_url, parsed.request_id, baseUrl, testOnly, 'result', routes)
        : routes.resultPath(parsed.request_id);
    } catch {
      return { kind: 'unknown', detail: 'submit response carried an unusable queue URL' };
    }
    return { kind: 'accepted', requestId: parsed.request_id, statusPath, responsePath };
  }
  if (status === 408 || status === 429 || (status >= 300 && status < 400) || status >= 500) {
    return { kind: 'unknown', detail: `submit returned ${snippetStatus(status)}` };
  }
  return { kind: 'rejected', detail: `submit rejected with ${snippetStatus(status)}` };
}

type StatusQuery = { kind: 'pending' } | { kind: 'completed' } | { kind: 'failed'; detail: string };

/** Query a known request's status exactly once. */
async function queryStatus(
  baseUrl: string,
  path: string,
  requestId: string,
  credential: string | undefined,
  routes: QueueRoutes,
): Promise<StatusQuery> {
  let response: { status: number; text: string };
  try {
    response = await jsonRequest({
      url: queueUrl(baseUrl, path, requestId, 'status', routes),
      method: 'GET',
      headers: authHeaders(credential),
    });
  } catch (error) {
    throw new FalPendingError(
      `fal adapter: status query failed (transport); not resubmitting. ${redact(error instanceof Error ? error.message : String(error))}`,
    );
  }
  const { status, text } = response;
  if (status === 404)
    throw new FalProviderError('fal adapter: remote request no longer exists (deleted or expired); not resubmitting.');
  if (status === 408 || status === 429 || (status >= 300 && status < 400) || status >= 500) {
    throw new FalPendingError(
      `fal adapter: status query temporarily unavailable (${snippetStatus(status)}); not resubmitting.`,
    );
  }
  if (status === 401 || status === 403)
    throw new FalProviderError(
      `fal adapter: status query needs valid account credentials (${snippetStatus(status)}); the known job is preserved, not resubmitted.`,
    );
  if (status < 200 || status >= 300)
    return { kind: 'failed', detail: `status query failed with ${snippetStatus(status)}` };
  let parsed: z.infer<typeof queueStatusSchema>;
  try {
    parsed = queueStatusSchema.parse(JSON.parse(text));
  } catch {
    throw new FalPendingError('fal adapter: status response was malformed; not resubmitting.');
  }
  if (parsed.request_id !== requestId)
    throw new FalProviderError(
      'fal adapter: status request id does not match the persisted request id; refusing to act on it.',
    );
  return parsed.status === 'COMPLETED' ? { kind: 'completed' } : { kind: 'pending' };
}

type ResultQuery =
  { kind: 'ready'; url: string; seed?: number; duration?: number } | { kind: 'failed'; detail: string };

/** Fetch the raw model output once. Transient failures stay recoverable. */
async function queryResult(
  baseUrl: string,
  path: string,
  requestId: string,
  credential: string | undefined,
  routes: QueueRoutes,
): Promise<ResultQuery> {
  let response: { status: number; text: string };
  try {
    response = await jsonRequest({
      url: queueUrl(baseUrl, path, requestId, 'result', routes),
      method: 'GET',
      headers: authHeaders(credential),
    });
  } catch (error) {
    throw new FalPendingError(
      `fal adapter: result fetch failed (transport); not resubmitting. ${redact(error instanceof Error ? error.message : String(error))}`,
    );
  }
  const { status, text } = response;
  if (status === 404)
    throw new FalProviderError('fal adapter: remote result no longer exists (deleted or expired); not resubmitting.');
  if (status === 408 || status === 429 || (status >= 300 && status < 400) || status >= 500) {
    throw new FalPendingError(
      `fal adapter: result fetch temporarily unavailable (${snippetStatus(status)}); not resubmitting.`,
    );
  }
  if (status === 401 || status === 403)
    throw new FalProviderError(
      `fal adapter: result fetch needs valid account credentials (${snippetStatus(status)}); the known job is preserved, not resubmitted.`,
    );
  if (status < 200 || status >= 300)
    return { kind: 'failed', detail: `result fetch failed with ${snippetStatus(status)}` };
  let parsed: z.infer<typeof resultSchema>;
  try {
    parsed = resultSchema.parse(JSON.parse(text));
  } catch {
    throw new FalPendingError('fal adapter: result response was malformed; not resubmitting.');
  }
  return {
    kind: 'ready',
    url: parsed.video.url,
    ...(parsed.seed !== undefined ? { seed: parsed.seed } : {}),
    ...(parsed.duration !== undefined ? { duration: parsed.duration } : {}),
  };
}

// ---------------------------------------------------------------------------
// Download guards + streaming
// ---------------------------------------------------------------------------

/** Validate a media download URL for the active mode (best-effort preflight). */
async function assertSafeDownloadUrl(raw: string, origin: string, testOnly: boolean): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FalProviderError('fal adapter: refusing to download from an invalid URL');
  }
  if (url.username || url.password)
    throw new FalProviderError('fal adapter: refusing to download from a URL that carries credentials');
  if (testOnly) {
    if (url.origin !== origin)
      throw new FalProviderError('fal adapter: test-only downloads must be same-origin loopback');
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new FalProviderError('fal adapter: unsupported test-only download scheme');
    return url.toString();
  }
  if (url.protocol !== 'https:') throw new FalProviderError('fal adapter: production downloads must use HTTPS');
  const host = stripBrackets(url.hostname).toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost'))
    throw new FalProviderError('fal adapter: refusing to download from a loopback host');
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new FalProviderError('fal adapter: refusing to download from a private address');
  } else {
    let addresses: { address: string }[];
    try {
      addresses = await lookup(host, { all: true });
    } catch {
      throw new FalProviderError('fal adapter: could not resolve the media host; refusing to download');
    }
    if (addresses.some(entry => isPrivateAddress(entry.address)))
      throw new FalProviderError('fal adapter: media host resolves to a private address; refusing to download');
  }
  return url.toString();
}

async function streamDownload(initialUrl: string, destAbs: string, origin: string, testOnly: boolean): Promise<void> {
  await mkdir(dirname(destAbs), { recursive: true });
  const tmp = `${destAbs}.viscraft-dl-${process.pid}-${Date.now().toString(36)}`;
  let current = initialUrl;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const safe = await assertSafeDownloadUrl(current, origin, testOnly);
      const response = await fetch(safe, {
        method: 'GET',
        redirect: 'manual',
        headers: { Accept: 'video/mp4,video/*;q=0.9,*/*;q=0.5' },
        signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS),
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new FalProviderError('fal adapter: media download redirect without a location');
        current = new URL(location, safe).toString();
        continue;
      }
      if (!response.ok) throw new FalProviderError(`fal adapter: media download failed with HTTP ${response.status}`);
      const body = response.body;
      if (!body) throw new FalProviderError('fal adapter: media download returned an empty body');
      let total = 0;
      const cap = new Transform({
        transform(
          chunk: Buffer,
          _encoding: BufferEncoding,
          callback: (error?: Error | null, data?: unknown) => void,
        ): void {
          total += chunk.length;
          if (total > MAX_MEDIA_BYTES)
            callback(new FalProviderError('fal adapter: media download exceeded the configured size cap'));
          else callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(body as unknown as import('node:stream/web').ReadableStream),
        cap,
        createWriteStream(tmp, { mode: 0o600 }),
      );
      if (total === 0) throw new FalProviderError('fal adapter: media download produced no bytes');
      await rename(tmp, destAbs);
      return;
    }
    throw new FalProviderError('fal adapter: media download exceeded the redirect limit');
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// generateFal
// ---------------------------------------------------------------------------

interface GenerationContext {
  rootAbs: string;
  source: ProviderSource;
  output: OutputSettings;
  destAbs: string;
  destRel: string;
  jobsDir: string;
  mediaDir: string;
  jobFile: string;
  attempt: string;
  /** Source-scoped locator stem shared by the job record, lock and media. */
  stem: string;
  /** The full queue base URL (scheme + host + any deployment path prefix). */
  baseUrl: string;
  testOnly: boolean;
  apiKey: string | undefined;
  options: VideoApiOptions;
  mode: 'production' | 'test';
  baseIdentity: string;
  promptHash: string;
  requestHash: string;
  extensionHash: string;
  parameters: Record<string, unknown>;
  body?: Record<string, unknown>;
  routes: QueueRoutes;
  /** Every transmitted image reference, in declared order (empty for text-to-video). */
  references: Array<ResolvedImage | ImageIdentity>;
}

/**
 * Produce a normalized Take for a `provider` Source routed to the fal
 * queue protocol.
 *
 * Re-entrant and idempotent per attempt: a succeeded job restores its artifact
 * locally, an ambiguous submit is never resubmitted, and a failed download resumes
 * without regenerating. See the module header for the full invariant list.
 */
export async function generateFal(
  root: string,
  source: ProviderSource,
  output: OutputSettings,
  destination: string,
  options: VideoApiOptions = {},
): Promise<FalResult> {
  const parsed = SourceSchema.safeParse(source);
  if (!parsed.success || parsed.data.kind !== 'provider')
    throw new FalProviderError('fal adapter: expected a valid provider Source with in-range fields');
  const src = parsed.data;
  // This adapter IS one lane. A caller that names another protocol is asking for
  // a different service, which this function cannot serve; refusing is the only
  // truthful answer (silently overwriting the protocol would route the request to
  // the wrong endpoint).
  if (options.endpoint?.protocol !== undefined && options.endpoint.protocol !== FAL_PROTOCOL)
    throw new FalProviderError(
      `fal adapter: endpoint protocol '${options.endpoint.protocol}' cannot be served here; this adapter speaks '${FAL_PROTOCOL}'`,
    );
  // A SUCCEEDED attempt is local data: restore it before any Endpoint resolution,
  // credential lookup, reference read or body encoding.
  const rootAbs = resolve(root);
  const attempt = Id.parse(src.attempt);
  const stem = attemptStem(src.id, attempt);
  const jobFile = await resolveProjectPath(rootAbs, `${JOBS_DIR_REL}/${stem}.json`);
  const destinationPath = await resolveDestination(rootAbs, destination);
  const validatedOutput = OutputSchema.parse(output);
  const restored = await restoreCompletedAttempt<FalJob, FalResult>({
    jobFileAbs: jobFile,
    attempt,
    rootAbs,
    destAbs: destinationPath.abs,
    destRel: destinationPath.rel,
    output: validatedOutput,
    label: 'fal adapter',
    conflict: message => new FalProviderError(message),
    load: loadJob,
    save: saveJob,
    patch: (job, changes) => patchJob(job, changes),
    materialize: materializeFromLocal,
    result: successResult,
    // The effective definition/mapping identity for the current code. An
    // unreadable implementation file cannot be verified, and a local restore is
    // not a paid action, so it degrades to the authored-fields comparison.
    extensionHash: await generationExtensionIdentity({
      extension: resolveEffectiveExtension(src.model, FAL_PROTOCOL, options),
      modelSettings: options.endpoint?.modelSettings,
    }).catch(() => undefined),
    endpointHash: falEndpointIdentity(src, options),
    provenance: {
      simulated: Boolean(options.testOnly) || (options.references ?? []).some(entry => entry.asset?.simulated === true),
      backend: BACKEND,
    },
    changedFieldsOf: job => {
      const facts = planRequestFacts(
        src,
        id => (options.references ?? []).find(entry => entry.asset?.id === id)?.asset.sha256 ?? null,
        options,
      );
      return facts === null ? ['request'] : changedFields(facts, recordedRequestFacts(job));
    },
    validateCurrent: async () => {
      for (const reference of src.references ?? []) {
        const input = options.references?.find(entry => entry.asset?.id === reference.asset);
        if (input) {
          try {
            await assertOptionalReferenceBytesMatch(input.root, input.asset, 'fal adapter');
          } catch (error) {
            throw new FalProviderError((error as Error).message);
          }
        }
      }
    },
  });
  if (restored !== undefined) return restored;
  const knownJob = await loadJob(jobFile);
  const identityOnly = Boolean(knownJob && knownJob.state !== 'created');
  // This adapter IS the `fal-queue` lane, so its own protocol is injected here: a
  // direct call need not restate `endpoint.protocol`, and the vendor production
  // default/credential env still apply. A caller-supplied endpoint cannot select
  // another lane.
  const laneOptions: PrepareVideoOptions = { ...options, endpoint: { ...options.endpoint, protocol: FAL_PROTOCOL } };
  // Validate the request through the ONE read-only preparation pipeline (no media,
  // no network) before reading the frozen bytes. This also enforces the queue
  // route facet (a missing/illegal `endpointId` is refused here, never only at
  // submission), rejects a mismatched extension without executing handlers, and
  // refuses any declared reference this queue transport cannot carry.
  prepareVideoRequest(src, laneOptions, undefined, 'fal adapter', true);

  // Resolve and validate EVERY transmitted image reference (any role) BEFORE the
  // lock, job record or network. A Source naming an image without its approved
  // Asset fails here; whether any reference is required is the mapping's concern,
  // so a text-to-video Source with none simply resolves an empty list.
  const provided = options.references ?? [];
  const declared = src.references ?? [];
  if (identityOnly && knownJob!.references.length !== declared.length)
    throw new FalProviderError(`fal adapter: attempt '${knownJob!.attempt}' reference list changed`);
  const resolved: Array<ResolvedImage | ImageIdentity> = [];
  for (const [index, reference] of declared.entries()) {
    resolved.push(
      identityOnly
        ? await resumeImageIdentity(reference, provided, knownJob!, index)
        : await resolveImage(reference, provided),
    );
  }
  const mappingReferences: Array<MappingReference | MappingReferenceIdentity> = resolved.map(image =>
    identityOnly
      ? { asset: image.assetId, sha256: image.sha256, category: 'image', role: image.role }
      : {
          asset: image.assetId,
          sha256: image.sha256,
          category: 'image',
          role: image.role,
          mime: (image as ResolvedImage).mime,
          bytes: (image as ResolvedImage).bytes,
        },
  );
  const prepared = prepareVideoRequest(src, laneOptions, mappingReferences, 'fal adapter', identityOnly);
  const extension = prepared.extension!;
  const parameters = prepared.parameters as Record<string, unknown>;
  const routes = queueRoutes(prepared.endpointId!);
  // The FULL queue base (scheme + host + any deployment path prefix) — never just
  // the origin — so a prefixed deployment is both used on the wire and frozen in
  // the request identity / persisted queue binding.
  const baseUrl = prepared.baseUrl;
  const { testOnly } = prepared;
  const extensionHash = await generationExtensionIdentity({
    extension,
    modelSettings: options.endpoint?.modelSettings,
  });
  // The effective model's reference-set validation runs through the SAME hook the
  // generic transport uses, so a set the model refuses is refused before
  // submission on every entry point.
  if (!identityOnly && (extension.model.validateReferenceSet || extension.mapping.validateReferenceSet)) {
    const byId = new Map(provided.map(input => [input.asset.id, input]));
    try {
      const facts = await Promise.all(
        (src.references ?? []).map(reference =>
          referenceFacts(byId.get(reference.asset)!.root, byId.get(reference.asset)!.asset, reference),
        ),
      );
      validateGenerationReferenceSet(extension, src, facts);
    } catch (error) {
      throw new FalProviderError(`fal adapter: ${(error as Error).message}`);
    }
  }
  const body = prepared.mappingBody ? Object.freeze(prepared.mappingBody) : undefined;
  const apiKey = resolveApiKey(options, testOnly);

  const mode: 'production' | 'test' = testOnly ? 'test' : 'production';
  const baseIdentity = testOnly ? `test:${baseUrl}` : `production:${baseUrl}`;
  const promptHash = stableHash(src.prompt);
  const requestHash = stableHash({
    protocolVersion: PROTOCOL_VERSION,
    kind: PROVIDER,
    model: extension.model.id,
    extensionHash,
    mode,
    baseIdentity,
    // The selected mapping's ROUTE facet is part of the remote request: a changed
    // `endpointId` must invalidate a previous paid task, not silently reuse it.
    endpointId: routes.endpointId,
    id: src.id,
    promptHash,
    parameters,
    // The mapping's canonical request identity (route + wire fields, references by
    // type/role/sha256) — never the raw base64 data URIs or a temp filename.
    mappedRequest: prepared.requestIdentity,
    seed: src.seed ?? null,
    // NOTE: the local OutputSettings are the NORMALIZATION target, not a remote
    // generation input, so they are NOT part of the frozen remote request
    // identity: a changed local output re-materializes the retained original with
    // no POST instead of reading as a different generation request.
    references: resolved.map(image => ({ asset: image.assetId, sha256: image.sha256, role: image.role })),
  });

  const jobsDir = await resolveProjectPath(rootAbs, JOBS_DIR_REL);
  const mediaDir = await resolveProjectPath(rootAbs, MEDIA_DIR_REL);

  const release = await acquireAttemptLock(rootAbs, stem, attempt);
  try {
    return await runGeneration({
      rootAbs,
      source: src,
      output: validatedOutput,
      destAbs: destinationPath.abs,
      destRel: destinationPath.rel,
      jobsDir,
      mediaDir,
      jobFile,
      attempt,
      stem,
      baseUrl,
      testOnly,
      apiKey,
      options,
      mode,
      baseIdentity,
      promptHash,
      requestHash,
      extensionHash,
      parameters,
      body,
      routes,
      references: resolved,
    });
  } finally {
    await release();
  }
}

async function runGeneration(ctx: GenerationContext): Promise<FalResult> {
  const {
    rootAbs,
    source,
    output,
    destAbs,
    destRel,
    jobsDir,
    mediaDir,
    jobFile,
    attempt,
    stem,
    baseUrl,
    testOnly,
    apiKey,
    options,
    mode,
    requestHash,
    extensionHash,
    parameters,
    body,
    routes,
    references,
  } = ctx;
  const credential = testOnly ? TEST_FIXTURE_CREDENTIAL : apiKey;
  // Authorization scope is exactly the assets this invocation transmits.
  const uploadAssetIds = references.map(image => image.assetId);

  const loaded = await loadJob(jobFile);
  if (loaded && loaded.requestHash !== requestHash) {
    throw new FalProviderError(
      `fal adapter: attempt '${attempt}' is already bound to a different frozen request; create a new attempt id instead of reusing this one with changed parameters.`,
    );
  }
  if (loaded && loaded.simulated !== (testOnly || references.some(image => image.simulated)))
    throw new FalProviderError(
      `fal adapter: attempt '${attempt}' simulated provenance differs from the current request`,
    );
  let job: FalJob;
  if (loaded) {
    await mkdir(jobsDir, { recursive: true });
    await mkdir(mediaDir, { recursive: true });
    job = loaded;
    if (stableHash(loaded.output) !== stableHash(output)) {
      // Same remote request, changed LOCAL output: adopt the new normalization
      // settings. Reuse of the previously normalized artifact is refused below
      // because it is gated on the persisted `artifactOutput` matching the
      // current `job.output`; the retained original is re-normalized at the new
      // settings with no submit (never returning old-spec media).
      job = patchJob(job, { output });
      await saveJob(jobFile, job);
    }
  } else {
    if (!body)
      throw new FalProviderError(
        `fal adapter: attempt '${attempt}' has no byte-backed request body and cannot be submitted`,
      );
    assertAuthorizedForSubmit(testOnly, apiKey, options, uploadAssetIds);
    await mkdir(jobsDir, { recursive: true });
    await mkdir(mediaDir, { recursive: true });
    job = {
      schemaVersion: JOB_SCHEMA_VERSION,
      backend: BACKEND,
      provider: PROVIDER,
      model: source.model,
      simulated: testOnly || references.some(image => image.simulated),
      mode,
      attempt,
      sourceId: Id.parse(source.id),
      promptHash: ctx.promptHash,
      requestHash,
      extensionHash,
      protocolVersion: PROTOCOL_VERSION,
      endpointId: routes.endpointId,
      queueHash: stableHash(baseUrl),
      parameters,
      references: references.map(image => ({
        id: image.assetId,
        sha256: image.sha256,
        type: 'image' as const,
        role: image.role,
      })),
      output,
      state: 'created',
      submitted: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    await saveJob(jobFile, job);
  }

  const originalRel = `${MEDIA_DIR_REL}/fal-${stem}.mp4`;

  // --- Terminal success: restore locally, else resume the download. ---
  if (job.state === 'succeeded') {
    const restored = await materializeFromLocal(job, rootAbs, destAbs);
    if (restored) {
      job = patchJob(job, {
        artifactPath: destRel,
        artifactSha256: restored.sha256,
        artifact: restored.media,
        artifactOutput: output,
      });
      await saveJob(jobFile, job);
      return successResult(job);
    }
    job = patchJob(job, { state: 'remote-completed' });
    await saveJob(jobFile, job);
  }

  // --- Terminal states: never auto-retried under this attempt. ---
  if (job.state === 'cancelled') {
    throw new FalProviderError(
      `fal adapter: attempt '${attempt}' was cancelled; not resubmitting. Create a new attempt id to generate again.`,
    );
  }
  if (job.state === 'failed') {
    throw new FalProviderError(
      `fal adapter: attempt '${attempt}' previously reached a permanent provider failure; not resubmitting. Create a new attempt id to retry.`,
    );
  }
  if (job.state === 'submit-unknown') {
    throw new FalProviderError(
      `fal adapter: attempt '${attempt}' has an unknown submit outcome; the adapter will not resubmit (no idempotency-key lookup is verified). Create a new attempt id if the original produced nothing.`,
    );
  }
  if (job.state === 'submitting') {
    job = patchJob(job, { state: 'submit-unknown', error: 'process interrupted during submit' });
    await saveJob(jobFile, job);
    throw new FalProviderError(
      `fal adapter: attempt '${attempt}' was interrupted during submit; the outcome is unknown and it will not be resubmitted.`,
    );
  }

  // Stamp the next allowed query time BEFORE the query in real mode, so a
  // transient query failure is also rate-bound (test mode bypasses wall-clock).
  const gateQuery = async (): Promise<void> => {
    if (testOnly) return;
    if (job.nextQueryAt && Date.now() < Date.parse(job.nextQueryAt)) {
      throw new FalPendingError(
        `fal adapter: request ${job.requestId ?? ''} was queried recently; wait until ${job.nextQueryAt} before re-running.`,
        job.nextQueryAt,
      );
    }
    job = patchJob(job, { nextQueryAt: new Date(Date.now() + MIN_QUERY_INTERVAL_MS).toISOString() });
    await saveJob(jobFile, job);
  };

  let completedThisRun = false;

  if (job.state === 'created') {
    if (!body)
      throw new FalProviderError(
        `fal adapter: attempt '${attempt}' has no byte-backed request body and cannot be submitted`,
      );
    assertAuthorizedForSubmit(testOnly, apiKey, options, uploadAssetIds);
    job = patchJob(job, { state: 'submitting', submitted: job.submitted + 1 });
    await saveJob(jobFile, job);

    // The mapping already produced the frozen, immutable request body.
    const outcome = await submitRequest(baseUrl, credential, body, testOnly, routes);
    if (outcome.kind === 'unknown') {
      job = patchJob(job, { state: 'submit-unknown', error: outcome.detail });
      await saveJob(jobFile, job);
      throw new FalProviderError(`fal adapter: submit outcome for attempt '${attempt}' is unknown; not resubmitting.`);
    }
    if (outcome.kind === 'rejected') {
      job = patchJob(job, { state: 'failed', error: outcome.detail });
      await saveJob(jobFile, job);
      throw new FalProviderError(
        `fal adapter: the provider rejected the request for attempt '${attempt}': ${outcome.detail}`,
      );
    }
    job = patchJob(job, {
      state: 'submitted',
      requestId: outcome.requestId,
      statusPath: outcome.statusPath,
      responsePath: outcome.responsePath,
      error: undefined,
      nextQueryAt: undefined,
    });
    await saveJob(jobFile, job);
  }

  if (job.state === 'submitted') {
    if (!job.requestId || !job.statusPath)
      throw new FalProviderError(`fal adapter: attempt '${attempt}' is submitted without a request id / status path`);
    await gateQuery();
    const status = await queryStatus(baseUrl, job.statusPath, job.requestId, credential, routes);
    if (status.kind === 'pending') {
      job = patchJob(job, { state: 'submitted' });
      await saveJob(jobFile, job);
      throw new FalPendingError(
        `fal adapter: request ${job.requestId} is not complete; not resubmitting.`,
        job.nextQueryAt,
      );
    }
    if (status.kind === 'failed') {
      job = patchJob(job, { state: 'failed', error: status.detail, nextQueryAt: undefined });
      await saveJob(jobFile, job);
      throw new FalProviderError(`fal adapter: generation failed for attempt '${attempt}': ${status.detail}`);
    }
    job = patchJob(job, { state: 'remote-completed', error: undefined, nextQueryAt: undefined });
    await saveJob(jobFile, job);
    completedThisRun = true;
  }

  if (job.state === 'remote-completed' || job.state === 'download-failed') {
    if (!job.requestId || !job.responsePath)
      throw new FalProviderError(`fal adapter: attempt '${attempt}' completed without a request id / result path`);

    // Nothing local is reusable -> fetch a fresh result URL (one GET per invocation).
    const local = await materializeFromLocal(job, rootAbs, destAbs);
    if (local) {
      job = patchJob(job, {
        state: 'succeeded',
        artifactPath: destRel,
        artifactSha256: local.sha256,
        artifact: local.media,
        artifactOutput: output,
        error: undefined,
      });
      await saveJob(jobFile, job);
      return successResult(job);
    }
    if (!completedThisRun) await gateQuery();
    const result = await queryResult(baseUrl, job.responsePath, job.requestId, credential, routes);
    if (result.kind === 'failed') {
      job = patchJob(job, { state: 'failed', error: result.detail, nextQueryAt: undefined });
      await saveJob(jobFile, job);
      throw new FalProviderError(`fal adapter: generation failed for attempt '${attempt}': ${result.detail}`);
    }
    job = patchJob(job, {
      state: 'remote-completed',
      error: undefined,
      nextQueryAt: undefined,
      ...(result.seed !== undefined ? { providerSeed: result.seed } : {}),
      ...(result.duration !== undefined ? { providerDurationSeconds: result.duration } : {}),
    });
    await saveJob(jobFile, job);

    // Download the original provider media (no submit anywhere on this path).
    const originalAbs = await resolveProjectPath(rootAbs, originalRel);
    try {
      await streamDownload(result.url, originalAbs, new URL(baseUrl).origin, testOnly);
      const info = await probeMedia(originalAbs);
      if (info.frames <= 0) throw new FalProviderError('downloaded media has no frames');
      const sha = await hashFile(originalAbs);
      job = patchJob(job, {
        state: 'remote-completed',
        originalMediaPath: originalRel,
        originalMediaSha256: sha,
        originalMedia: pickMedia(info),
        downloadAttempted: true,
        error: undefined,
      });
      await saveJob(jobFile, job);
    } catch (error) {
      job = patchJob(job, { state: 'download-failed', downloadAttempted: true, error: 'media download failed' });
      await saveJob(jobFile, job);
      throw new FalProviderError(
        `fal adapter: media download failed for attempt '${attempt}'; re-run to resume the download (no resubmit). ${redact(error instanceof Error ? error.message : String(error))}`,
      );
    }

    await normalizeAtomic(originalAbs, output, destAbs);
    const normInfo = await probeMedia(destAbs);
    if (normInfo.frames <= 0)
      throw new FalProviderError(`fal adapter: normalized media for attempt '${attempt}' has no frames`);
    const normSha = await hashFile(destAbs);
    job = patchJob(job, {
      state: 'succeeded',
      artifactPath: destRel,
      artifactSha256: normSha,
      artifact: pickMedia(normInfo),
      artifactOutput: output,
      error: undefined,
    });
    await saveJob(jobFile, job);
    return successResult(job);
  }

  throw new FalProviderError(`fal adapter: attempt '${attempt}' reached unexpected state '${job.state}'`);
}

/**
 * Cancel the remote request bound to a persisted fal attempt.
 *
 * This is not a new paid submission: it never POSTs and never needs
 * `authorization.submit`. It resolves the queue base URL/credential the same way
 * a status query does, but the PERSISTED job binds the execution MODE and queue
 * BASE URL: the cancel refuses unless the resolved mode equals the recorded mode
 * and the resolved base hashes to the recorded `queueHash` (test-only runs use
 * the fixed loopback fixture credential and never read the environment key;
 * production requires a resolvable key). It loads the persisted job and refuses
 * unless the record has a usable request id and is exactly in the `submitted`
 * state.
 *
 * At most one `PUT .../requests/<id>/cancel` is sent. A 2xx
 * `CANCELLATION_REQUESTED` moves the job to the terminal `cancelled` state;
 * `ALREADY_COMPLETED` and `NOT_FOUND` are reported as loud errors and the job is
 * left untouched (a cancel is never faked and nothing is ever resubmitted).
 * Cancelling stops a queued/in-progress request when the provider honours it but
 * does not un-bill an in-progress generation.
 */
export async function cancelFal(
  root: string,
  attempt: string,
  options: VideoApiOptions = {},
): Promise<{ attempt: string; requestId: string; state: 'cancelled' }> {
  const validatedAttempt = Id.parse(attempt);
  const rootAbs = resolve(root);
  // Job records are keyed by the Source-scoped stem, so a bare attempt is not a
  // filename. Locate the unique persisted job whose recorded `attempt` matches;
  // refuse ambiguity rather than guess when two Sources share the attempt id.
  const located = await findJobByAttempt(rootAbs, validatedAttempt);
  if (!located)
    throw new FalProviderError(`fal adapter: no job record for attempt '${validatedAttempt}'; nothing to cancel.`);
  const { file: jobFile, job: loaded } = located;
  if (loaded.state !== 'submitted') {
    throw new FalProviderError(
      `fal adapter: attempt '${validatedAttempt}' is in state '${loaded.state}', not 'submitted'; nothing to cancel.`,
    );
  }
  if (!loaded.requestId || !REQUEST_ID_PATTERN.test(loaded.requestId)) {
    throw new FalProviderError(
      `fal adapter: attempt '${validatedAttempt}' has no usable request id; nothing to cancel.`,
    );
  }
  const requestId = loaded.requestId;
  // The queue base URL and mode are bound to the PERSISTED job: the cancel must
  // target exactly the service the submit used. The caller still supplies the
  // (non-secret) configuration to resolve against, but the resolved mode must
  // equal the recorded mode and the resolved base URL must hash to the recorded
  // `queueHash`, so omitting `testOnly` (or pointing at another deployment) can
  // never redirect a cancel to a different host, from a test fixture into
  // production, or to another path prefix.
  const { baseUrl, testOnly } = resolveQueueTarget(options, {
    model: loaded.model,
    endpoint: loaded.endpointId,
    references: [],
  });
  if (testOnly !== (loaded.mode === 'test')) {
    throw new FalProviderError(
      `fal adapter: attempt '${validatedAttempt}' was submitted in ${loaded.mode} mode, but this cancel resolves ` +
        `${testOnly ? 'a loopback test fixture' : 'the production queue'}; refusing to send a cancel to a different service. ` +
        `Pass the ${loaded.mode === 'test' ? 'testOnly fixture' : 'production endpoint'} the attempt was submitted with.`,
    );
  }
  if (stableHash(baseUrl) !== loaded.queueHash) {
    throw new FalProviderError(
      `fal adapter: attempt '${validatedAttempt}' was submitted to a different queue base URL, but this cancel resolves ` +
        `${baseUrl}; refusing to send a cancel to a different queue origin or path prefix.`,
    );
  }
  const credential = testOnly ? TEST_FIXTURE_CREDENTIAL : resolveApiKey(options, testOnly);
  if (!testOnly && !credential) {
    throw new FalProviderError(
      `fal adapter: cancelling requires a resolvable credential (${credentialSetupHint(credentialName(options))}); no request was sent.`,
    );
  }
  // The queue route facet is persisted with the job, so recovery/cancel never
  // re-derive it from a hardcoded literal.
  const routes = queueRoutes(loaded.endpointId);

  // Derive the cancel path from the persisted status path (both the official and
  // SDK-stripped forms are accepted), else fall back to the mapping's route; the
  // 'cancel' role binding is then re-checked before any request.
  const cancelPath =
    loaded.statusPath && /\/status$/.test(loaded.statusPath)
      ? loaded.statusPath.replace(/\/status$/, '/cancel')
      : routes.cancelPath(requestId);
  let cancelUrl: string;
  try {
    cancelUrl = queueUrl(baseUrl, cancelPath, requestId, 'cancel', routes);
  } catch {
    throw new FalProviderError(
      `fal adapter: attempt '${validatedAttempt}' has an unsafe persisted queue path; refusing to send a cancel.`,
    );
  }

  let response: { status: number; text: string };
  try {
    response = await jsonRequest({ url: cancelUrl, method: 'PUT', headers: authHeaders(credential) });
  } catch (error) {
    throw new FalProviderError(
      `fal adapter: cancel request for attempt '${validatedAttempt}' failed (transport); not resubmitting. ${redact(error instanceof Error ? error.message : String(error))}`,
    );
  }

  const { status, text } = response;
  let remoteStatus: string | undefined;
  try {
    remoteStatus = cancelResponseSchema.parse(JSON.parse(text)).status;
  } catch {
    remoteStatus = undefined;
  }

  if (remoteStatus === 'ALREADY_COMPLETED') {
    throw new FalProviderError(
      `fal adapter: cancel for attempt '${validatedAttempt}' was refused: the request already completed (ALREADY_COMPLETED); it is NOT marked cancelled and will not be resubmitted.`,
    );
  }
  if (remoteStatus === 'NOT_FOUND' || status === 404) {
    throw new FalProviderError(
      `fal adapter: cancel for attempt '${validatedAttempt}' failed: the remote request was not found (NOT_FOUND); not resubmitting.`,
    );
  }
  if (status === 401 || status === 403) {
    throw new FalProviderError(
      `fal adapter: cancel needs valid account credentials (${snippetStatus(status)}); the known job is preserved, not resubmitted.`,
    );
  }
  if (remoteStatus === 'CANCELLATION_REQUESTED' && status >= 200 && status < 300) {
    const cancelled = patchJob(loaded, { state: 'cancelled', nextQueryAt: undefined });
    await saveJob(jobFile, cancelled);
    return { attempt: validatedAttempt, requestId, state: 'cancelled' };
  }
  if (status >= 200 && status < 300) {
    throw new FalProviderError(
      `fal adapter: cancel response for attempt '${validatedAttempt}' was not the documented CANCELLATION_REQUESTED body; refusing to treat it as cancelled.`,
    );
  }
  throw new FalProviderError(
    `fal adapter: cancel for attempt '${validatedAttempt}' failed with ${snippetStatus(status)}; not resubmitting.`,
  );
}

/**
 * List persisted fal job records (validated; no prompts, secrets or remote URLs).
 * Unsafe or invalid records are skipped. Records live under `.viscraft/jobs/fal/`
 * so they never collide with other providers.
 */
export async function falStatus(root: string): Promise<unknown[]> {
  const rootAbs = resolve(root);
  let jobsDir: string;
  try {
    jobsDir = await resolveProjectPath(rootAbs, JOBS_DIR_REL);
  } catch {
    return [];
  }
  if (!existsSync(jobsDir)) return [];
  const entries = await readdir(jobsDir);
  const jobs: FalJob[] = [];
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
  jobs.sort((a, b) => a.attempt.localeCompare(b.attempt));
  return jobs;
}

/**
 * The plan-side identity facts this adapter persisted for an attempt, reproduced
 * from the CURRENT Source without reading media, contacting the queue or needing
 * the Endpoint address.
 */
function planRequestFacts(
  source: ProviderSource,
  sha256Of: (assetId: string) => string | null,
  options: VideoApiOptions,
): Record<string, unknown> | null {
  const extension = options.extension ?? packagedExtensionFor(source.model, FAL_PROTOCOL);
  let parameters: Record<string, unknown>;
  try {
    parameters = extension
      ? validateGenerationExtension(source, FAL_PROTOCOL, {
          extension,
          ...(options.endpoint?.modelSettings !== undefined ? { modelSettings: options.endpoint.modelSettings } : {}),
        })
      : {};
  } catch {
    // A Source that no longer validates against the recorded model is a DIFFERENT
    // request, not a model error to report against a resumable attempt.
    return null;
  }
  return {
    model: source.model,
    promptHash: stableHash(source.prompt),
    references: (source.references ?? []).map(reference => ({
      id: reference.asset,
      sha256: sha256Of(reference.asset),
      type: 'image',
      role: reference.role,
    })),
    parameters,
  };
}

/** The same facts as they were frozen into a persisted record. */
function recordedRequestFacts(job: FalJob): Record<string, unknown> {
  return {
    model: job.model,
    promptHash: job.promptHash,
    references: job.references.map(reference => ({
      id: reference.id,
      sha256: reference.sha256,
      type: reference.type,
      role: reference.role,
    })),
    parameters: job.parameters,
  };
}

/**
 * Read-only attempt inspection for Plan: load this adapter's own record for the
 * Source's attempt and classify it. No network, no upload, no lock, no write and
 * no media read. The identity and provenance checks are the same facts the
 * execution path enforces before a POST.
 */
export async function inspectFalAttempt(
  rootAbs: string,
  source: ProviderSource,
  assets: readonly Asset[],
  options: VideoApiOptions = {},
): Promise<AttemptInspection> {
  const attempt = Id.parse(source.attempt);
  const stem = attemptStem(source.id, attempt);
  const jobFileRel = `${JOBS_DIR_REL}/${stem}.json`;
  const job = await readAttemptRecord({
    rootAbs,
    rel: jobFileRel,
    schema: jobSchema,
    label: 'fal adapter',
    conflict: message => new FalProviderError(message),
  });
  const local = {
    artifactReady: await localBytesPresent(rootAbs, job?.artifactPath, job?.artifactSha256),
    originalReady: await localBytesPresent(rootAbs, job?.originalMediaPath, job?.originalMediaSha256),
  };
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  const changed: string[] = [];
  if (job !== null) {
    const extensionHash = await generationExtensionIdentity({
      extension: resolveEffectiveExtension(source.model, FAL_PROTOCOL, options),
      modelSettings: options.endpoint?.modelSettings,
    }).catch(() => undefined);
    const facts = planRequestFacts(source, id => byId.get(id)?.sha256 ?? null, options);
    changed.push(
      ...attemptIdentityChanges({
        job,
        ...(extensionHash !== undefined ? { extensionHash } : {}),
        ...(options.endpoint !== undefined ? { endpointHash: falEndpointIdentity(source, options) } : {}),
        ...(options.endpoint !== undefined || options.testOnly !== undefined
          ? {
              provenance: {
                simulated:
                  Boolean(options.testOnly) ||
                  source.references.some(reference => byId.get(reference.asset)?.simulated === true),
                backend: BACKEND,
              },
            }
          : {}),
      }),
      ...(facts === null ? ['request'] : changedFields(facts, recordedRequestFacts(job))),
    );
  }
  return attemptInspection({
    attempt,
    jobFile: jobFileRel,
    record:
      job === null
        ? null
        : attemptRecordFacts({ ...job, ...(job.requestId !== undefined ? { taskId: job.requestId } : {}) }),
    local,
    wouldUpload: transmittedReferences(FAL_PROTOCOL, source.references ?? []).map(reference => reference.asset),
    changed,
  });
}

/**
 * The CURRENT queue identity of this Source's binding, or `undefined` when it
 * cannot be resolved. Mirrors the `queueHash` the record froze (a hash of the whole
 * queue base), so a local restore can tell "same queue" from "same request".
 */
function falEndpointIdentity(source: ProviderSource, options: VideoApiOptions): string | undefined {
  try {
    const lane = resolveVideoLane(
      { ...options, endpoint: { ...options.endpoint, protocol: FAL_PROTOCOL } },
      source,
      'fal adapter',
    );
    return stableHash(lane.baseUrl);
  } catch {
    return undefined;
  }
}
