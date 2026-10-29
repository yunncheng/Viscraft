import { validateGenerationReferenceSet } from '../../extension.js';
import { readCapped } from '../../http-body.js';
import { materializeFromLocal, normalizeAtomic, pickMedia } from '../../local-media.js';
/**
 * Runway text-/image-to-video Provider adapter (gen4.5) — production HTTP
 * control plane with a loopback-only test transport.
 *
 * This module is the real adapter for a documented external generative provider.
 * It is deliberately narrow: `gen4.5` text-to-video and single-first-frame
 * image-to-video, duration 2..10 s, `1280:720 | 720:1280`, optional uint32 seed.
 * It talks to the Runway HTTP API directly (no SDK runtime dependency). The
 * request/protocol contract was read from the Apache-2.0 `@runwayml/sdk`
 * reference checkout
 * (commit `a76ba472cd163f0d4d5e60f9a1d82229628cc4a0`, version 4.21.0) but the
 * implementation below is written independently — no SDK source was copied.
 *
 * Provenance of the wire contract (see the reference checkout):
 *  - `POST /v1/text_to_video` body `{ model: 'gen4.5', duration, ratio,
 *    promptText, seed? }` → `{ id, estimatedCost: { credits } }`;
 *  - `POST /v1/image_to_video` body `{ model: 'gen4.5', duration, ratio,
 *    promptImage, promptText, seed? }`, where `promptImage` is a first-frame
 *    base64 data URI (encoded PNG/JPEG, under 5MB) → same create response;
 *  - `GET /v1/tasks/:id` → a status union with `PENDING | THROTTLED | RUNNING |
 *    SUCCEEDED | FAILED | CANCELLED`; `SUCCEEDED` carries short-lived `output`
 *    URLs, terminal states carry `cost.credits`;
 *  - headers `Authorization: Bearer <key>` and `X-Runway-Version: 2024-11-06`,
 *    JSON bodies; base URL `https://api.dev.runwayml.com`.
 *
 * Safety invariants:
 *  - production submission requires **explicit** `authorization.submit === true`
 *    AND an API key; a key alone is never treated as consent, and the gate runs
 *    before a job record is written and before any network call;
 *  - the source is re-validated against the canonical `SourceSchema` so an
 *    unvalidated SDK caller cannot smuggle an out-of-range request;
 *  - an image-conditioned request only ever uses a caller-provided
 *    `options.references` Asset whose id matches the Source's `first-frame`
 *    reference: the Asset is
 *    re-validated with `AssetSchema`, its bytes are read from the frozen asset
 *    root, must match the recorded `sha256`, must be PNG or JPEG **by
 *    signature** (SVG and other formats are refused, never converted), and are
 *    re-hashed after encoding so the bytes sent are exactly the bytes validated.
 *    All of this runs before any lock, job record or network call;
 *  - a production image upload requires *additional* explicit per-Asset consent
 *    (`authorization.uploadAssets` includes the Asset id) on top of `submit` and
 *    a key; a redistributable license is never treated as upload consent;
 *  - a per-attempt exclusive lock refuses concurrent generation of the same
 *    attempt (which could otherwise double-submit / double-bill);
 *  - the API key comes from the caller or `RUNWAYML_API_SECRET` and is **never**
 *    persisted; job records store a prompt hash, not the prompt;
 *  - the frozen request hash binds mode / base identity / source / output /
 *    protocol version, so reusing an attempt id with changed parameters is
 *    rejected instead of silently overwriting;
 *  - the pre-submit record is persisted BEFORE the network call; an ambiguous
 *    submit (timeout, transport error, malformed response, 3xx/408/429/5xx)
 *    becomes `submit-unknown` and is never auto-resubmitted;
 *  - a known task is queried at most once per generate invocation (no in-process
 *    busy loop / sleep); before every real status query the next allowed query
 *    time is persisted (>=5 s), so a transient query failure is also rate-bound;
 *    test mode bypasses wall-clock gating so the control chain can be exercised;
 *  - the original provider media is retained (with probe + hash) and the
 *    normalized artifact is produced with the shared `normalizeMedia`; a failed
 *    download resumes without regenerating (no resubmit), and the refreshed
 *    output URL is re-fetched on each resume;
 *  - downloads are capped and scheme/host-guarded (production: HTTPS only, no
 *    userinfo, no loopback/private host, manual redirect guard; test: only
 *    same-origin loopback); no credentials are forwarded to the media host and
 *    no remote URL is persisted.
 *
 * The host/private-address check is a best-effort preflight, NOT a pinned-IP
 * network sandbox: DNS can change between the check and the fetch. It reduces
 * accidental SSRF surface but must not be relied on as a hard security boundary.
 *
 * Only when a *real* account, key and explicit authorization are supplied does
 * this adapter perform a real (billable) generation. Tests point it at a local
 * Node HTTP fixture and every record they produce is marked `simulated`.
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
import type { Asset, OutputSettings, ProviderSource } from '../../../../core/schema.js';
import { AssetSchema, Id, MediaInfoSchema, OutputSchema, SourceSchema } from '../../../../core/schema.js';
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
import { resolveVideoLane, stripBrackets, transmittedReferences } from '../../lane.js';
import { packagedExtensionFor } from '../../models/registry.js';
import { prepareVideoRequest, type PrepareVideoOptions } from '../../prepare.js';
import { assertOptionalReferenceBytesMatch, referenceFacts } from '../../reference-facts.js';
import { RUNWAY_DATA_URI_BYTES, RUNWAY_IMAGE_RAW_BYTES } from '../../transfer-bounds.js';
import type { VideoApiOptions } from '../video-tasks.js';

const BACKEND = 'runway-gen4.5';
const PROVIDER = 'runway';
const PROTOCOL_VERSION = 1;
/** The one transport this adapter speaks (Plan's inspection uses the same id). */
const RUNWAY_PROTOCOL = 'runway-v1' as const;
const JOB_SCHEMA_VERSION = 1;

/** Reference SDK the wire contract was read from (Apache-2.0). No code copied. */
const SDK_REFERENCE_COMMIT = 'a76ba472cd163f0d4d5e60f9a1d82229628cc4a0';
const SDK_REFERENCE_VERSION = '4.21.0';

const PRODUCTION_BASE = 'https://api.dev.runwayml.com';
const API_VERSION = '2024-11-06';
const TEXT_TO_VIDEO_PATH = '/v1/text_to_video';
const IMAGE_TO_VIDEO_PATH = '/v1/image_to_video';
const TASKS_PATH = '/v1/tasks/';
const DEFAULT_CREDENTIAL = 'RUNWAYML_API_SECRET';
// Fixed, non-secret credential sent to the loopback fixture. Test mode never
// reads the environment key or forwards the caller's real key to localhost.
const TEST_FIXTURE_CREDENTIAL = 'fixture-test-only';

const JOBS_DIR_REL = '.viscraft/jobs/runway';
const MEDIA_DIR_REL = '.viscraft/provider-media';

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
// A raw reference image is capped so its base64 data URI stays under the
// documented 5MB `promptImage` limit (base64 inflates by ~4/3, plus the prefix).
// The caps come from the ONE `transfer-bounds.ts` so the preflight check in
// `prepare.ts` and this final byte-exact guard cannot drift.
const MAX_IMAGE_RAW_BYTES = RUNWAY_IMAGE_RAW_BYTES;
const MAX_DATA_URI_BYTES = RUNWAY_DATA_URI_BYTES;
const JSON_TIMEOUT_MS = 30_000;
const MEDIA_TIMEOUT_MS = 300_000;
const MIN_QUERY_INTERVAL_MS = 5_000;
const MAX_REDIRECTS = 3;

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Portable provider provenance attached to a successful artifact. Contains no
 * signed URLs, no credentials and no invented costs: the credit fields appear
 * only when the provider actually reported them.
 */
export interface RunwayGeneration {
  provider: 'runway';
  model: string;
  taskId: string;
  requestHash: string;
  originalSha256: string;
  /** Content hash of the model definition + service mapping that produced the request. */
  extensionHash: string;
  estimatedCredits?: number;
  finalCredits?: number;
  /** Present only when the generation was conditioned on a first-frame image. */
  references: { asset: string; sha256: string; category: 'image'; role: 'first-frame' }[];
}

export interface RunwayResult {
  backend: string;
  generation?: RunwayGeneration;
}

/**
 * Documented capabilities of this adapter's *implementation*, not of any
 * account. This is not entitlement, pricing, quota or availability information
 * and never implies a successful generation.
 *
 * CAPABILITY SCOPE (`capabilityScope: 'protocol'`): these are TRANSPORT-level
 * facts of the implemented `runway-v1` lane — the task paths, the task
 * lifecycle/status query, the credential handling and the reference encoding.
 * They describe the WIRE PROTOCOL only and are model-agnostic: a Project may
 * select any Runway model (or its own `GenerationExtension`).
 *
 * LIMIT PROVENANCE: this transport is model-agnostic. Each model's own
 * parameters, ratios, duration range, output formats and moderation options are
 * owned by that model definition's zod schema (see `models/*`), never restated
 * here. The reference SHAPE is structural: the Runway lane carries at most one
 * first-frame image, reported by `supportsTailFrame` / `supportsVideoReference`
 * below, not by a per-model count.
 */
export const runwayCapabilities = {
  capabilityScope: 'protocol',
  backend: BACKEND,
  provider: PROVIDER,
  apiVersion: API_VERSION,
  productionBaseUrl: PRODUCTION_BASE,
  modality: 'text-to-video | image-to-video',
  textOnly: false,
  promptImage: {
    supported: true,
    position: 'first',
    encoding: 'base64-data-uri',
    formats: ['image/png', 'image/jpeg'],
  },
  // Deliberately neither implemented nor claimed: tail-frame conditioning,
  // video references, generative video editing and any hosted upload service.
  supportsTailFrame: false,
  supportsVideoReference: false,
  supportsVideoEditing: false,
  supportsHostedUpload: false,
  supportsTaskStatusLookup: true,
  // No idempotency-key or task-list lookup is verified against the real API, so
  // recovery from an unknown submit is deliberately blocked rather than assumed.
  supportsIdempotencyKeyLookup: false,
  clientSdkReference: {
    package: '@runwayml/sdk',
    version: SDK_REFERENCE_VERSION,
    commit: SDK_REFERENCE_COMMIT,
    license: 'Apache-2.0',
  },
  accountAvailability: 'unknown',
  note:
    'Documents the implemented HTTP transport for the Runway API lane: text-to-video and a ' +
    'single first-frame image-to-video provided as a base64 PNG/JPEG data URI, with task status ' +
    'lookup and credential handling. It is transport-only and model-agnostic: each selected model ' +
    'owns its own parameters and limits. It is NOT account entitlement, pricing, rate-limit or ' +
    'availability information and never implies a successful generation. Production submission ' +
    'requires explicit authorization plus a key, and each uploaded reference image needs additional ' +
    'explicit per-Asset upload consent; test-only runs target a loopback fixture and their output is simulated.',
} as const;

export class RunwayProviderError extends Error {
  /** True when the caller can safely retry the *same* attempt later (no resubmit). */
  recoverable = false;
  constructor(message: string) {
    super(message);
    this.name = 'RunwayProviderError';
  }
}

/** A recoverable, non-fatal state: re-run to continue, never to resubmit. */
export class RunwayPendingError extends RunwayProviderError {
  readonly nextQueryAt?: string;
  constructor(message: string, nextQueryAt?: string) {
    super(message);
    this.name = 'RunwayPendingError';
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
  'remote-completed',
  'download-failed',
  'succeeded',
  'failed',
  'cancelled',
]);

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
    // The routing identity this attempt was frozen against (protocol + base URL +
    // wire model + settings).
    endpointHash: z.string().regex(/^[a-f0-9]{64}$/),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    modality: z.enum(['text-to-video', 'image-to-video']).optional(),
    // Reference image provenance only: id/hash/type, never bytes or a data URI.
    image: z
      .object({ id: Id, sha256: z.string().regex(/^[a-f0-9]{64}$/), type: z.literal('image') })
      .strict()
      .optional(),
    // The model-agnostic validated parameters; model-specific meaning lives in
    // the selected definition, never in a per-model job column.
    parameters: z.record(z.unknown()),
    output: OutputSchema,
    state: jobStateSchema,
    submitted: z.number().int().nonnegative(),
    taskId: z.string().min(1).optional(),
    estimatedCostCredits: z.number().finite().nonnegative().optional(),
    finalCostCredits: z.number().finite().nonnegative().optional(),
    progress: z.number().finite().optional(),
    nextQueryAt: z.string().min(1).optional(),
    // Original provider media (retained) + normalized artifact, both project-relative.
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

export type RunwayJob = z.infer<typeof jobSchema>;
export type RunwayJobState = z.infer<typeof jobStateSchema>;

function now(): string {
  return new Date().toISOString();
}

function patchJob(job: RunwayJob, changes: Partial<RunwayJob>): RunwayJob {
  return patchJobRecord(job, changes, now());
}

/** Build the portable provenance for a successfully completed job. */
function successResult(job: RunwayJob): RunwayResult {
  if (!job.taskId || !job.originalMediaSha256) {
    throw new RunwayProviderError(
      'Runway adapter: a succeeded job is missing provider provenance (task id / original media hash)',
    );
  }
  return {
    backend: BACKEND,
    generation: {
      provider: PROVIDER,
      model: job.model,
      taskId: job.taskId,
      requestHash: job.requestHash,
      originalSha256: job.originalMediaSha256,
      extensionHash: job.extensionHash,
      ...(job.estimatedCostCredits !== undefined ? { estimatedCredits: job.estimatedCostCredits } : {}),
      ...(job.finalCostCredits !== undefined ? { finalCredits: job.finalCostCredits } : {}),
      references: job.image
        ? [{ asset: job.image.id, sha256: job.image.sha256, category: 'image' as const, role: 'first-frame' as const }]
        : [],
    },
  };
}

async function loadJob(jobFile: string): Promise<RunwayJob | null> {
  return loadJobRecord(jobFile, jobSchema, 'Runway adapter', message => new RunwayProviderError(message));
}

async function saveJob(jobFile: string, job: RunwayJob): Promise<void> {
  await saveJobRecord(jobFile, job);
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

async function resolveDestination(rootAbs: string, destination: string): Promise<{ abs: string; rel: string }> {
  if (!destination || destination.includes('\0'))
    throw new RunwayProviderError('Runway adapter: invalid destination path');
  let rel: string;
  if (isAbsolute(destination)) {
    const base = await realpath(rootAbs);
    rel = relative(base, normalize(destination)).split(sep).join('/');
    if (!rel || rel.startsWith('..') || isAbsolute(rel))
      throw new RunwayProviderError('Runway adapter: destination escapes project root');
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
 * Resolve the credential to send. In test mode this NEVER consults the caller
 * key or the environment: the loopback fixture receives a fixed, non-secret
 * placeholder so a developer's real key can never leak to a local process.
 * Production resolves the Endpoint's named `credential` (default `RUNWAYML_API_SECRET`)
 * from the environment, else the user's stored credential.
 */
function resolveApiKey(options: VideoApiOptions, testOnly: boolean): string | undefined {
  if (testOnly) return undefined;
  return resolveCredential(credentialName(options));
}

function credentialName(options: VideoApiOptions): string {
  return options.endpoint?.credential ?? DEFAULT_CREDENTIAL;
}

/**
 * Production submission requires BOTH explicit authorization and a key. Every
 * transmitted reference image additionally requires *per-Asset* upload consent
 * (`authorization.uploadAssets`); a redistributable license is explicitly NOT
 * consent to upload a private Asset to a third party. The gate checks EVERY
 * transmitted Asset id (not just the first), so its scope exactly matches what
 * the request puts on the wire. This runs before any job record is written and
 * before any network call; a key by itself is never treated as consent. A
 * GET-only recovery never reaches this gate.
 */
function assertAuthorizedForSubmit(
  testOnly: boolean,
  apiKey: string | undefined,
  options: VideoApiOptions,
  uploadAssetIds: readonly string[],
): void {
  if (testOnly) return; // loopback fixture; nothing real is generated
  if (options.authorization?.submit !== true) {
    throw new RunwayProviderError(
      'Runway adapter: production submission requires explicit authorization (`{ authorization: { submit: true } }`); no request was sent and no job was created.',
    );
  }
  if (!apiKey) {
    throw new RunwayProviderError(
      `Runway adapter: no API key available (${credentialSetupHint(credentialName(options))}); no request was sent and no job was created.`,
    );
  }
  for (const uploadAssetId of uploadAssetIds) {
    if (!options.authorization.uploadAssets?.includes(uploadAssetId)) {
      throw new RunwayProviderError(
        `Runway adapter: uploading reference image Asset '${uploadAssetId}' to the provider requires explicit per-Asset upload authorization ` +
          `(\`{ authorization: { submit: true, uploadAssets: ['${uploadAssetId}'] } }\`); a redistributable license is NOT upload consent. ` +
          'No request was sent and no job was created.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Reference image resolution
// ---------------------------------------------------------------------------

/**
 * A validated, in-memory reference image for a single image-conditioned request.
 * The raw bytes are handed to the service mapping, which encodes the base64 data
 * URI it actually sends; the job record keeps just id / sha256 / type.
 */
interface ResolvedReferenceImage {
  assetId: string;
  sha256: string;
  mime: 'image/png' | 'image/jpeg';
  simulated: boolean;
  bytes: Buffer;
}

interface ReferenceImageIdentity {
  assetId: string;
  sha256: string;
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
 * Resolve one declared reference image. In the converged contract a frame is a
 * `provider` Source reference (the Runway lane supports a single
 * `first-frame` image, enforced by the shared preparation), resolved to a
 * caller-provided `options.references` entry — nothing is fetched, generated or
 * substituted.
 *
 * The Asset is re-validated with the canonical `AssetSchema`; its bytes are read
 * from the frozen asset root, must match the recorded `sha256`, must be PNG or
 * JPEG **by signature** (SVG and everything else is refused, never converted),
 * and are re-hashed after base64 encoding so the bytes sent are exactly the
 * bytes validated. This all runs before the per-attempt lock, any job record and
 * any network call.
 */
async function resolveReferenceImage(
  reference: { asset: string; category: string; role: string },
  options: VideoApiOptions,
): Promise<ResolvedReferenceImage> {
  const requested = reference.asset;
  if (reference.category !== 'image') {
    throw new RunwayProviderError(
      `Runway adapter: the lane carries image references only, not '${reference.category}'; no request was sent and no job was created.`,
    );
  }
  const provided = (options.references ?? []).find(entry => entry.asset?.id === requested);
  if (!provided || typeof provided.root !== 'string' || provided.root.length === 0) {
    throw new RunwayProviderError(
      `Runway adapter: Source references image Asset '${requested}' (role '${reference.role}') but no matching options.references entry (asset + frozen root) was provided; no request was sent and no job was created.`,
    );
  }
  const parsed = AssetSchema.safeParse(provided.asset);
  if (!parsed.success)
    throw new RunwayProviderError('Runway adapter: the provided reference image is not a valid Asset');
  const asset = parsed.data;
  if (asset.type !== 'image')
    throw new RunwayProviderError(`Runway adapter: reference Asset '${asset.id}' is not an image`);
  if (asset.id !== requested) {
    throw new RunwayProviderError(
      `Runway adapter: the provided reference image Asset '${asset.id}' does not match the declared reference '${requested}'; refusing before any request.`,
    );
  }
  let abs: string;
  try {
    abs = await resolveProjectPath(provided.root, asset.path);
  } catch {
    throw new RunwayProviderError(
      `Runway adapter: reference image Asset '${asset.id}' does not resolve to a safe path inside its frozen root`,
    );
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(abs);
  } catch {
    throw new RunwayProviderError(
      `Runway adapter: reference image Asset '${asset.id}' could not be read from the frozen asset root`,
    );
  }
  // Hash BEFORE: the on-disk bytes must be the approved Asset's bytes.
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
    throw new RunwayProviderError(
      `Runway adapter: reference image Asset '${asset.id}' bytes do not match its recorded sha256; refusing to send`,
    );
  }
  if (bytes.length > MAX_IMAGE_RAW_BYTES) {
    throw new RunwayProviderError(
      `Runway adapter: reference image Asset '${asset.id}' is ${bytes.length} bytes, over the ${MAX_IMAGE_RAW_BYTES}-byte raw limit that keeps the encoded data URI under 5MB`,
    );
  }
  const mime = detectImageMime(bytes);
  if (!mime) {
    throw new RunwayProviderError(
      `Runway adapter: reference image Asset '${asset.id}' is not a PNG or JPEG (by signature); SVG and other formats are refused rather than converted`,
    );
  }
  const dataUri = `data:${mime};base64,${bytes.toString('base64')}`;
  if (Buffer.byteLength(dataUri, 'utf8') > MAX_DATA_URI_BYTES) {
    throw new RunwayProviderError(
      `Runway adapter: reference image Asset '${asset.id}' encodes to a data URI over 5MB; refusing to send`,
    );
  }
  // Hash AFTER: decoding the exact encoded payload must reproduce the Asset hash.
  const decodedHash = createHash('sha256')
    .update(Buffer.from(dataUri.slice(dataUri.indexOf(',') + 1), 'base64'))
    .digest('hex');
  if (decodedHash !== asset.sha256) {
    throw new RunwayProviderError(
      `Runway adapter: reference image Asset '${asset.id}' failed the post-encoding byte integrity check; refusing to send`,
    );
  }
  return Object.freeze({ assetId: asset.id, sha256: asset.sha256, mime, simulated: asset.simulated, bytes });
}

/** Current declared identity for a previously submitted Runway image request. */
async function resumeReferenceImageIdentity(
  reference: { asset: string; category: string; role: string },
  options: VideoApiOptions,
  job: RunwayJob,
): Promise<ReferenceImageIdentity> {
  if (
    reference.category !== 'image' ||
    reference.role !== 'first-frame' ||
    !job.image ||
    job.modality !== 'image-to-video'
  )
    throw new RunwayProviderError(
      `Runway adapter: attempt '${job.attempt}' reference identity differs from the submitted image route`,
    );
  const provided = options.references?.filter(entry => entry.asset?.id === reference.asset) ?? [];
  if (provided.length !== 1)
    throw new RunwayProviderError(
      `Runway adapter: attempt '${job.attempt}' needs exactly its original reference Asset descriptor`,
    );
  const parsed = AssetSchema.safeParse(provided[0].asset);
  if (
    !parsed.success ||
    parsed.data.id !== job.image.id ||
    parsed.data.id !== reference.asset ||
    parsed.data.type !== 'image' ||
    parsed.data.sha256 !== job.image.sha256
  )
    throw new RunwayProviderError(
      `Runway adapter: attempt '${job.attempt}' reference Asset identity or sha256 changed`,
    );
  try {
    await assertOptionalReferenceBytesMatch(provided[0].root, parsed.data, 'Runway adapter');
  } catch (error) {
    throw new RunwayProviderError((error as Error).message);
  }
  return { assetId: parsed.data.id, sha256: parsed.data.sha256, simulated: parsed.data.simulated };
}

// ---------------------------------------------------------------------------
// Per-attempt lock (explicit concurrent-refusal)
// ---------------------------------------------------------------------------

/**
 * Acquire an exclusive lock for one attempt. Two processes generating the same
 * attempt would otherwise risk a double submit / double charge; the lock is a
 * `wx`-created file and is removed in a `finally`. A leftover lock (hard crash)
 * intentionally blocks rather than silently proceeding.
 */
async function acquireAttemptLock(rootAbs: string, stem: string, attempt: string): Promise<() => Promise<void>> {
  return acquireSharedAttemptLock({
    rootAbs,
    stem,
    attempt,
    dirRel: JOBS_DIR_REL,
    label: 'Runway adapter',
    conflict: message => new RunwayProviderError(message),
  });
}

// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------

function authHeaders(credential: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Runway-Version': API_VERSION,
  };
  if (credential) headers.Authorization = `Bearer ${credential}`;
  return headers;
}

/** One JSON request. Transport/timeout errors propagate (callers treat them as ambiguous). */
async function jsonRequest(req: {
  url: string;
  method: 'GET' | 'POST';
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
    () => new RunwayProviderError('Runway adapter: response exceeded the configured size cap'),
  );
  return { status: response.status, text: buf.toString('utf8') };
}

const costSchema = z.object({ credits: z.number().finite().nonnegative() });

const createResponseSchema = z.object({
  id: z.string().min(1),
  estimatedCost: costSchema.optional(),
});

const taskResponseSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  createdAt: z.string().optional(),
  estimatedCost: costSchema.optional(),
  cost: costSchema.optional(),
  progress: z.number().finite().optional(),
  failure: z.string().optional(),
  failureCode: z.string().optional(),
  output: z.array(z.string()).optional(),
});

type SubmitOutcome =
  | { kind: 'accepted'; taskId: string; estimatedCostCredits?: number }
  | { kind: 'unknown'; detail: string }
  | { kind: 'rejected'; detail: string };

function snippetStatus(status: number): string {
  return `HTTP ${status}`;
}

/** Submit exactly once. Every ambiguous outcome is reported as `unknown`. */
async function submitTask(
  baseUrl: string,
  credential: string | undefined,
  path: string,
  body: unknown,
): Promise<SubmitOutcome> {
  let response: { status: number; text: string };
  try {
    response = await jsonRequest({ url: `${baseUrl}${path}`, method: 'POST', headers: authHeaders(credential), body });
  } catch (error) {
    return {
      kind: 'unknown',
      detail: `submit transport error: ${redact(error instanceof Error ? error.message : String(error))}`,
    };
  }
  const { status } = response;
  if (status >= 200 && status < 300) {
    let parsed: z.infer<typeof createResponseSchema>;
    try {
      parsed = createResponseSchema.parse(JSON.parse(response.text));
    } catch {
      return { kind: 'unknown', detail: 'submit returned an unexpected or malformed response body' };
    }
    if (!TASK_ID_PATTERN.test(parsed.id))
      return { kind: 'unknown', detail: 'submit response carried an unusable task id' };
    return {
      kind: 'accepted',
      taskId: parsed.id,
      ...(parsed.estimatedCost ? { estimatedCostCredits: parsed.estimatedCost.credits } : {}),
    };
  }
  // Any redirect, request timeout, throttling or server error is ambiguous: the
  // task may or may not have been created, so it is never auto-resubmitted.
  // Only the numeric status is recorded — never the raw response body.
  if (status === 408 || status === 429 || (status >= 300 && status < 400) || status >= 500) {
    return { kind: 'unknown', detail: `submit returned ${snippetStatus(status)}` };
  }
  return { kind: 'rejected', detail: `submit rejected with ${snippetStatus(status)}` };
}

type TaskQuery =
  | { kind: 'in-flight'; status: 'PENDING' | 'THROTTLED' | 'RUNNING'; estimatedCostCredits?: number; progress?: number }
  | { kind: 'succeeded'; outputUrls: string[]; estimatedCostCredits?: number; finalCostCredits?: number }
  | { kind: 'failed'; detail: string; failureCode?: string; finalCostCredits?: number }
  | { kind: 'cancelled'; finalCostCredits?: number };

/**
 * Query a known task exactly once. Transient failures surface as a recoverable
 * pending error so the caller re-runs later instead of resubmitting.
 */
async function queryTask(baseUrl: string, taskId: string, credential: string | undefined): Promise<TaskQuery> {
  if (!TASK_ID_PATTERN.test(taskId))
    throw new RunwayProviderError('Runway adapter: refusing to query an invalid task id');
  let response: { status: number; text: string };
  try {
    response = await jsonRequest({
      url: `${baseUrl}${TASKS_PATH}${taskId}`,
      method: 'GET',
      headers: authHeaders(credential),
    });
  } catch (error) {
    throw new RunwayPendingError(
      `Runway adapter: task status query failed (transport); not resubmitting. ${redact(error instanceof Error ? error.message : String(error))}`,
    );
  }
  const { status, text } = response;
  if (status === 404)
    throw new RunwayProviderError(
      'Runway adapter: remote task no longer exists (deleted or expired); not resubmitting.',
    );
  if (status === 408 || status === 429 || (status >= 300 && status < 400) || status >= 500) {
    throw new RunwayPendingError(
      `Runway adapter: task status query temporarily unavailable (${snippetStatus(status)}); not resubmitting.`,
    );
  }
  if (status < 200 || status >= 300) {
    throw new RunwayProviderError(`Runway adapter: task status query failed with ${snippetStatus(status)}`);
  }
  let parsed: z.infer<typeof taskResponseSchema>;
  try {
    parsed = taskResponseSchema.parse(JSON.parse(text));
  } catch {
    throw new RunwayPendingError('Runway adapter: task status response was malformed; not resubmitting.');
  }
  if (parsed.id !== taskId)
    throw new RunwayProviderError(
      'Runway adapter: task status id does not match the persisted task id; refusing to act on it.',
    );

  const estimatedCostCredits = parsed.estimatedCost?.credits;
  const finalCostCredits = parsed.cost?.credits;
  const rawStatus = parsed.status.toUpperCase();
  const normalized = rawStatus === 'CANCELED' ? 'CANCELLED' : rawStatus;

  if (normalized === 'SUCCEEDED') {
    const outputUrls = (parsed.output ?? []).filter((u): u is string => typeof u === 'string' && u.length > 0);
    if (outputUrls.length === 0)
      throw new RunwayPendingError(
        'Runway adapter: task reported SUCCEEDED without usable output URLs; not resubmitting.',
      );
    return {
      kind: 'succeeded',
      outputUrls,
      ...(estimatedCostCredits !== undefined ? { estimatedCostCredits } : {}),
      ...(finalCostCredits !== undefined ? { finalCostCredits } : {}),
    };
  }
  if (normalized === 'FAILED') {
    return {
      kind: 'failed',
      // Only the machine-readable failure code is recorded; never the raw body.
      detail: parsed.failureCode ? `provider failure (${parsed.failureCode})` : 'provider failure',
      ...(parsed.failureCode ? { failureCode: parsed.failureCode } : {}),
      ...(finalCostCredits !== undefined ? { finalCostCredits } : {}),
    };
  }
  if (normalized === 'CANCELLED') {
    return { kind: 'cancelled', ...(finalCostCredits !== undefined ? { finalCostCredits } : {}) };
  }
  if (normalized === 'PENDING' || normalized === 'THROTTLED' || normalized === 'RUNNING') {
    return {
      kind: 'in-flight',
      status: normalized,
      ...(estimatedCostCredits !== undefined ? { estimatedCostCredits } : {}),
      ...(parsed.progress !== undefined ? { progress: parsed.progress } : {}),
    };
  }
  // Unknown status: treat as still in flight rather than guessing a terminal state.
  throw new RunwayPendingError(
    `Runway adapter: task reported an unrecognised status '${redact(parsed.status)}'; not resubmitting.`,
  );
}

// ---------------------------------------------------------------------------
// Download guards + streaming
// ---------------------------------------------------------------------------

/**
 * Validate a download URL for the active mode; rejects credentials, scheme and
 * private/loopback hosts. The DNS lookup is a best-effort preflight, not a
 * pinned-connection guarantee (see the module header).
 */
async function assertSafeDownloadUrl(raw: string, baseUrl: string, testOnly: boolean): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RunwayProviderError('Runway adapter: refusing to download from an invalid URL');
  }
  if (url.username || url.password)
    throw new RunwayProviderError('Runway adapter: refusing to download from a URL that carries credentials');

  if (testOnly) {
    const base = new URL(baseUrl);
    if (url.origin !== base.origin)
      throw new RunwayProviderError('Runway adapter: test-only downloads must be same-origin loopback');
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new RunwayProviderError('Runway adapter: unsupported test-only download scheme');
    return url.toString();
  }

  if (url.protocol !== 'https:') throw new RunwayProviderError('Runway adapter: production downloads must use HTTPS');
  const host = stripBrackets(url.hostname).toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost'))
    throw new RunwayProviderError('Runway adapter: refusing to download from a loopback host');
  if (isIP(host)) {
    if (isPrivateAddress(host))
      throw new RunwayProviderError('Runway adapter: refusing to download from a private address');
  } else {
    let addresses: { address: string }[];
    try {
      addresses = await lookup(host, { all: true });
    } catch {
      throw new RunwayProviderError('Runway adapter: could not resolve the media host; refusing to download');
    }
    if (addresses.some(entry => isPrivateAddress(entry.address))) {
      throw new RunwayProviderError('Runway adapter: media host resolves to a private address; refusing to download');
    }
  }
  return url.toString();
}

/**
 * Stream a downloaded body to a temp file (byte-capped) and rename into place.
 * Uses `pipeline` so backpressure and stream errors (including a mid-write disk
 * failure) are propagated and the partial file is cleaned up.
 */
async function streamDownload(initialUrl: string, destAbs: string, baseUrl: string, testOnly: boolean): Promise<void> {
  await mkdir(dirname(destAbs), { recursive: true });
  const tmp = `${destAbs}.viscraft-dl-${process.pid}-${Date.now().toString(36)}`;
  let current = initialUrl;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const safe = await assertSafeDownloadUrl(current, baseUrl, testOnly);
      const response = await fetch(safe, {
        method: 'GET',
        redirect: 'manual',
        headers: { Accept: 'video/mp4,video/*;q=0.9,*/*;q=0.5' },
        signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS),
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new RunwayProviderError('Runway adapter: media download redirect without a location');
        current = new URL(location, safe).toString();
        continue;
      }
      if (!response.ok)
        throw new RunwayProviderError(`Runway adapter: media download failed with HTTP ${response.status}`);
      const body = response.body;
      if (!body) throw new RunwayProviderError('Runway adapter: media download returned an empty body');

      let total = 0;
      const cap = new Transform({
        transform(
          chunk: Buffer,
          _encoding: BufferEncoding,
          callback: (error?: Error | null, data?: unknown) => void,
        ): void {
          total += chunk.length;
          if (total > MAX_MEDIA_BYTES)
            callback(new RunwayProviderError('Runway adapter: media download exceeded the configured size cap'));
          else callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(body as unknown as import('node:stream/web').ReadableStream),
        cap,
        createWriteStream(tmp, { mode: 0o600 }),
      );
      if (total === 0) throw new RunwayProviderError('Runway adapter: media download produced no bytes');
      await rename(tmp, destAbs);
      return;
    }
    throw new RunwayProviderError('Runway adapter: media download exceeded the redirect limit');
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// generateRunway
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
  image?: ResolvedReferenceImage | ReferenceImageIdentity;
  /** Every reference Asset this request actually transmits (upload-consent scope). */
  uploadAssetIds: string[];
}

/**
 * Produce a normalized Take for a `provider` Source routed to the Runway
 * gen4.5 protocol.
 *
 * Re-entrant and idempotent per attempt: a succeeded job restores its artifact
 * locally (re-normalizing from retained provider media if needed) without a
 * resubmit; an ambiguous submit is never resubmitted; a failed download resumes
 * without regenerating. See the module header for the full invariant list.
 */
export async function generateRunway(
  root: string,
  source: ProviderSource,
  output: OutputSettings,
  destination: string,
  options: VideoApiOptions = {},
): Promise<RunwayResult> {
  // Canonical, public-boundary validation: an unvalidated caller cannot smuggle
  // an out-of-range provider request past the TypeScript types.
  const parsed = SourceSchema.safeParse(source);
  if (!parsed.success || parsed.data.kind !== 'provider') {
    throw new RunwayProviderError('Runway adapter: expected a valid provider Source');
  }
  const src = parsed.data;
  // This adapter IS one lane. A caller that names another protocol is asking for
  // a different service, which this function cannot serve; refusing is the only
  // truthful answer (silently overwriting the protocol would route the request to
  // the wrong endpoint).
  if (options.endpoint?.protocol !== undefined && options.endpoint.protocol !== RUNWAY_PROTOCOL)
    throw new RunwayProviderError(
      `Runway adapter: endpoint protocol '${options.endpoint.protocol}' cannot be served here; this adapter speaks '${RUNWAY_PROTOCOL}'`,
    );
  // A SUCCEEDED attempt is local data: restore it before any Endpoint resolution,
  // credential lookup, reference read or body encoding.
  const rootAbs = resolve(root);
  const attempt = Id.parse(src.attempt);
  const stem = attemptStem(src.id, attempt);
  const jobFile = await resolveProjectPath(rootAbs, `${JOBS_DIR_REL}/${stem}.json`);
  const destinationPath = await resolveDestination(rootAbs, destination);
  const validatedOutput = OutputSchema.parse(output);
  const restored = await restoreCompletedAttempt<RunwayJob, RunwayResult>({
    jobFileAbs: jobFile,
    attempt,
    rootAbs,
    destAbs: destinationPath.abs,
    destRel: destinationPath.rel,
    output: validatedOutput,
    label: 'Runway adapter',
    conflict: message => new RunwayProviderError(message),
    load: loadJob,
    save: saveJob,
    patch: (job, changes) => patchJob(job, changes),
    materialize: materializeFromLocal,
    result: successResult,
    // The effective definition/mapping identity for the current code. An
    // unreadable implementation file cannot be verified, and a local restore is
    // not a paid action, so it degrades to the authored-fields comparison.
    extensionHash: await generationExtensionIdentity({
      extension: resolveEffectiveExtension(src.model, RUNWAY_PROTOCOL, options),
      modelSettings: options.endpoint?.modelSettings,
    }).catch(() => undefined),
    endpointHash: runwayEndpointIdentity(src, options),
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
            await assertOptionalReferenceBytesMatch(input.root, input.asset, 'Runway adapter');
          } catch (error) {
            throw new RunwayProviderError((error as Error).message);
          }
        }
      }
    },
  });
  if (restored !== undefined) return restored;
  const knownJob = await loadJob(jobFile);
  const identityOnly = Boolean(knownJob && knownJob.state !== 'created');
  // This adapter IS the `runway-v1` lane, so its own protocol is injected here: a
  // direct call need not restate `endpoint.protocol`, and the vendor production
  // default/credential env still apply. A caller-supplied endpoint keeps its own
  // fields (baseUrl/credential/model/modelSettings) but cannot select another lane.
  const laneOptions: PrepareVideoOptions = { ...options, endpoint: { ...options.endpoint, protocol: RUNWAY_PROTOCOL } };
  // Validate the request through the ONE read-only preparation pipeline (no media,
  // no network) before reading the frozen bytes. A mismatched extension is
  // rejected here without partially executing any handler.
  prepareVideoRequest(src, laneOptions, undefined, 'Runway adapter', true);

  // Resolve and validate EVERY declared reference BEFORE the lock, job record or
  // network. The shared preparation already refused any form this lane cannot
  // carry, so the declared set is exactly what Plan also saw; a declared image
  // without its matching approved Asset is rejected here rather than partially
  // executed.
  const declared = src.references ?? [];
  const resolvedImages: Array<ResolvedReferenceImage | ReferenceImageIdentity> = [];
  for (const reference of declared)
    resolvedImages.push(
      identityOnly
        ? await resumeReferenceImageIdentity(reference, options, knownJob!)
        : await resolveReferenceImage(reference, options),
    );
  const references: Array<MappingReference | MappingReferenceIdentity> = declared.map((reference, index) => {
    const resolved = resolvedImages[index];
    return identityOnly
      ? {
          asset: resolved.assetId,
          sha256: resolved.sha256,
          category: 'image',
          role: reference.role,
        }
      : {
          asset: resolved.assetId,
          sha256: resolved.sha256,
          category: 'image',
          role: reference.role,
          mime: (resolved as ResolvedReferenceImage).mime,
          bytes: (resolved as ResolvedReferenceImage).bytes,
        };
  });
  const prepared = prepareVideoRequest(src, laneOptions, references, 'Runway adapter', identityOnly);
  const extension = prepared.extension!;
  const parameters = prepared.parameters as Record<string, unknown>;
  const extensionHash = await generationExtensionIdentity({
    extension,
    modelSettings: options.endpoint?.modelSettings,
  });
  // The effective model's reference-set validation runs through the SAME
  // `validateReferenceSet` hook the generic transport uses, so a set the model
  // refuses is refused before submission on every entry point.
  if (!identityOnly && (extension.model.validateReferenceSet || extension.mapping.validateReferenceSet)) {
    const facts = await Promise.all(
      declared.map(async reference => {
        const provided = (options.references ?? []).find(entry => entry.asset?.id === reference.asset)!;
        return referenceFacts(provided.root, provided.asset, reference);
      }),
    );
    try {
      validateGenerationReferenceSet(extension, src, facts);
    } catch (error) {
      throw new RunwayProviderError(`Runway adapter: ${(error as Error).message}`);
    }
  }
  // The Runway lane carries at most one first-frame image; `image` drives the wire
  // PATH below (text vs image), a protocol fact owned by the lane. The mapping
  // already emitted the frozen wire body.
  const image = resolvedImages[0];
  const body = prepared.mappingBody ? Object.freeze(prepared.mappingBody) : undefined;

  const { baseUrl, testOnly } = prepared;
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
    id: src.id,
    promptHash,
    parameters,
    // The lane's ROUTE (text vs image) plus the mapping's canonical request
    // identity: the actual encoded body with reference payloads reduced to their
    // type/role/sha256, never the raw base64 data URI or a temp filename.
    route: image ? IMAGE_TO_VIDEO_PATH : TEXT_TO_VIDEO_PATH,
    mappedRequest: prepared.requestIdentity,
    seed: src.seed ?? null,
    // NOTE: the local OutputSettings are the NORMALIZATION target, not a remote
    // generation input, so they are NOT part of the frozen remote request
    // identity: a changed local output re-materializes the retained original with
    // no POST instead of reading as a different generation request.
    // Only present for image-conditioned requests, so the text-to-video request
    // hash is unchanged.
    ...(image ? { image: { asset: image.assetId, sha256: image.sha256 } } : {}),
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
      ...(image ? { image } : {}),
      uploadAssetIds: resolvedImages.map(resolved => resolved.assetId),
    });
  } finally {
    await release();
  }
}

async function runGeneration(ctx: GenerationContext): Promise<RunwayResult> {
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
    baseIdentity,
    parameters,
    body,
    image,
    uploadAssetIds,
  } = ctx;
  const credential = testOnly ? TEST_FIXTURE_CREDENTIAL : apiKey;

  const loaded = await loadJob(jobFile);
  if (loaded && loaded.requestHash !== requestHash) {
    throw new RunwayProviderError(
      `Runway adapter: attempt '${attempt}' is already bound to a different frozen request; create a new attempt id instead of reusing this one with changed parameters.`,
    );
  }
  if (loaded && loaded.simulated !== (testOnly || Boolean(image?.simulated)))
    throw new RunwayProviderError(
      `Runway adapter: attempt '${attempt}' simulated provenance differs from the current request`,
    );
  let job: RunwayJob;
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
    // Gate before any job record exists and before any network call. A new job
    // always submits, so an image upload needs its per-Asset consent here.
    assertAuthorizedForSubmit(testOnly, apiKey, options, uploadAssetIds);
    if (!body)
      throw new RunwayProviderError(
        `Runway adapter: attempt '${attempt}' has no byte-backed request body and cannot be submitted`,
      );
    await mkdir(jobsDir, { recursive: true });
    await mkdir(mediaDir, { recursive: true });
    job = {
      schemaVersion: JOB_SCHEMA_VERSION,
      backend: BACKEND,
      provider: PROVIDER,
      model: source.model,
      simulated: testOnly || Boolean(image?.simulated),
      mode,
      attempt,
      sourceId: Id.parse(source.id),
      promptHash: ctx.promptHash,
      requestHash,
      extensionHash,
      endpointHash: stableHash(baseIdentity),
      protocolVersion: PROTOCOL_VERSION,
      modality: image ? 'image-to-video' : 'text-to-video',
      ...(image ? { image: { id: image.assetId, sha256: image.sha256, type: 'image' as const } } : {}),
      parameters,
      output,
      state: 'created',
      submitted: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    await saveJob(jobFile, job);
  }

  const originalRel = `${MEDIA_DIR_REL}/${stem}.mp4`;

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

  // --- Terminal failures: never auto-retried under this attempt. ---
  if (job.state === 'failed') {
    throw new RunwayProviderError(
      `Runway adapter: attempt '${attempt}' previously reached a permanent provider failure; not resubmitting. Create a new attempt id to retry.`,
    );
  }
  if (job.state === 'cancelled') {
    throw new RunwayProviderError(
      `Runway adapter: attempt '${attempt}' was cancelled remotely; not resubmitting. Create a new attempt id to retry.`,
    );
  }
  if (job.state === 'submit-unknown') {
    throw new RunwayProviderError(
      `Runway adapter: attempt '${attempt}' has an unknown submit outcome; the adapter will not resubmit (no idempotency-key lookup is verified). Create a new attempt id if the original produced nothing.`,
    );
  }
  if (job.state === 'submitting') {
    // Interrupted mid-submit: the outcome is ambiguous, so block resubmission.
    job = patchJob(job, { state: 'submit-unknown', error: 'process interrupted during submit' });
    await saveJob(jobFile, job);
    throw new RunwayProviderError(
      `Runway adapter: attempt '${attempt}' was interrupted during submit; the outcome is unknown and it will not be resubmitted.`,
    );
  }

  // Output URLs fetched within this invocation (never persisted). At most one
  // task GET happens per invocation.
  let freshUrls: string[] | undefined;

  // Stamp the next allowed query time BEFORE the query in real mode, so a
  // transient query failure is also rate-bound (test mode bypasses wall-clock).
  const gateQuery = async (): Promise<void> => {
    if (testOnly) return;
    if (job.nextQueryAt && Date.now() < Date.parse(job.nextQueryAt)) {
      throw new RunwayPendingError(
        `Runway adapter: task ${job.taskId ?? ''} was queried recently; wait until ${job.nextQueryAt} before re-running.`,
        job.nextQueryAt,
      );
    }
    job = patchJob(job, { nextQueryAt: new Date(Date.now() + MIN_QUERY_INTERVAL_MS).toISOString() });
    await saveJob(jobFile, job);
  };

  if (job.state === 'created') {
    // A fresh POST is about to happen: re-assert the submit gate (including
    // per-Asset image upload consent). GET-only recovery paths never reach here.
    assertAuthorizedForSubmit(testOnly, apiKey, options, uploadAssetIds);
    const submitting = patchJob(job, { state: 'submitting', submitted: job.submitted + 1 });
    await saveJob(jobFile, submitting);
    job = submitting;

    // The mapping already produced the frozen, immutable request body. The wire
    // PATH is a protocol fact owned by the lane: image-conditioned requests go to
    // `/v1/image_to_video`, text requests to `/v1/text_to_video`.
    const path = image ? IMAGE_TO_VIDEO_PATH : TEXT_TO_VIDEO_PATH;
    const outcome = await submitTask(baseUrl, credential, path, body);

    if (outcome.kind === 'unknown') {
      job = patchJob(job, { state: 'submit-unknown', error: outcome.detail });
      await saveJob(jobFile, job);
      throw new RunwayProviderError(
        `Runway adapter: submit outcome for attempt '${attempt}' is unknown; not resubmitting.`,
      );
    }
    if (outcome.kind === 'rejected') {
      job = patchJob(job, { state: 'failed', error: outcome.detail });
      await saveJob(jobFile, job);
      throw new RunwayProviderError(
        `Runway adapter: the provider rejected the request for attempt '${attempt}': ${outcome.detail}`,
      );
    }
    job = patchJob(job, {
      state: 'submitted',
      taskId: outcome.taskId,
      ...(outcome.estimatedCostCredits !== undefined ? { estimatedCostCredits: outcome.estimatedCostCredits } : {}),
      error: undefined,
      nextQueryAt: undefined,
    });
    await saveJob(jobFile, job);
  }

  if (job.state === 'submitted') {
    if (!job.taskId)
      throw new RunwayProviderError(`Runway adapter: attempt '${attempt}' is submitted without a task id`);
    await gateQuery();
    const query = await queryTask(baseUrl, job.taskId, credential);
    if (query.kind === 'in-flight') {
      job = patchJob(job, {
        state: 'submitted',
        ...(query.estimatedCostCredits !== undefined ? { estimatedCostCredits: query.estimatedCostCredits } : {}),
        ...(query.progress !== undefined ? { progress: query.progress } : {}),
      });
      await saveJob(jobFile, job);
      throw new RunwayPendingError(
        `Runway adapter: task ${job.taskId} is ${query.status}; not resubmitting.`,
        job.nextQueryAt,
      );
    }
    if (query.kind === 'failed') {
      job = patchJob(job, {
        state: 'failed',
        error: query.detail,
        ...(query.finalCostCredits !== undefined ? { finalCostCredits: query.finalCostCredits } : {}),
        nextQueryAt: undefined,
      });
      await saveJob(jobFile, job);
      throw new RunwayProviderError(`Runway adapter: generation failed for attempt '${attempt}': ${query.detail}`);
    }
    if (query.kind === 'cancelled') {
      job = patchJob(job, {
        state: 'cancelled',
        ...(query.finalCostCredits !== undefined ? { finalCostCredits: query.finalCostCredits } : {}),
        nextQueryAt: undefined,
      });
      await saveJob(jobFile, job);
      throw new RunwayProviderError(`Runway adapter: task ${job.taskId} was cancelled; not resubmitting.`);
    }
    job = patchJob(job, {
      state: 'remote-completed',
      error: undefined,
      nextQueryAt: undefined,
      ...(query.finalCostCredits !== undefined ? { finalCostCredits: query.finalCostCredits } : {}),
    });
    await saveJob(jobFile, job);
    freshUrls = query.outputUrls;
  }

  if (job.state === 'remote-completed' || job.state === 'download-failed') {
    if (!job.taskId) throw new RunwayProviderError(`Runway adapter: attempt '${attempt}' completed without a task id`);

    // Nothing local is reusable -> fetch a fresh output URL (one GET per invocation).
    if (!freshUrls) {
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
      await gateQuery();
      const query = await queryTask(baseUrl, job.taskId, credential);
      if (query.kind === 'in-flight') {
        job = patchJob(job, {
          state: 'submitted',
          ...(query.estimatedCostCredits !== undefined ? { estimatedCostCredits: query.estimatedCostCredits } : {}),
        });
        await saveJob(jobFile, job);
        throw new RunwayPendingError(
          `Runway adapter: task ${job.taskId} is ${query.status}; not resubmitting.`,
          job.nextQueryAt,
        );
      }
      if (query.kind === 'failed') {
        job = patchJob(job, {
          state: 'failed',
          error: query.detail,
          nextQueryAt: undefined,
          ...(query.finalCostCredits !== undefined ? { finalCostCredits: query.finalCostCredits } : {}),
        });
        await saveJob(jobFile, job);
        throw new RunwayProviderError(`Runway adapter: generation failed for attempt '${attempt}': ${query.detail}`);
      }
      if (query.kind === 'cancelled') {
        job = patchJob(job, {
          state: 'cancelled',
          nextQueryAt: undefined,
          ...(query.finalCostCredits !== undefined ? { finalCostCredits: query.finalCostCredits } : {}),
        });
        await saveJob(jobFile, job);
        throw new RunwayProviderError(`Runway adapter: task ${job.taskId} was cancelled; not resubmitting.`);
      }
      freshUrls = query.outputUrls;
      if (query.finalCostCredits !== undefined)
        job = patchJob(job, { finalCostCredits: query.finalCostCredits, nextQueryAt: undefined });
      await saveJob(jobFile, job);
    }

    // Download the original provider media (no submit anywhere on this path).
    const originalAbs = await resolveProjectPath(rootAbs, originalRel);
    try {
      await streamDownload(freshUrls[0], originalAbs, baseUrl, testOnly);
      const info = await probeMedia(originalAbs);
      if (info.frames <= 0) throw new RunwayProviderError('downloaded media has no frames');
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
      throw new RunwayProviderError(
        `Runway adapter: media download failed for attempt '${attempt}'; re-run to resume the download (no resubmit). ${redact(error instanceof Error ? error.message : String(error))}`,
      );
    }

    // Normalize with the shared media plane.
    await normalizeAtomic(originalAbs, output, destAbs);
    const normInfo = await probeMedia(destAbs);
    if (normInfo.frames <= 0)
      throw new RunwayProviderError(`Runway adapter: normalized media for attempt '${attempt}' has no frames`);
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

  throw new RunwayProviderError(`Runway adapter: attempt '${attempt}' reached unexpected state '${job.state}'`);
}

/**
 * List persisted Runway job records (validated; contains no prompts or secrets
 * and no remote URLs). Unsafe or invalid records are skipped rather than
 * surfaced. Records live under `.viscraft/jobs/runway/` so they never collide
 * with the simulated provider's `.viscraft/jobs/*.json` records.
 */
export async function runwayStatus(root: string): Promise<unknown[]> {
  const rootAbs = resolve(root);
  let jobsDir: string;
  try {
    jobsDir = await resolveProjectPath(rootAbs, JOBS_DIR_REL);
  } catch {
    return [];
  }
  if (!existsSync(jobsDir)) return [];
  const entries = await readdir(jobsDir);
  const jobs: RunwayJob[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    let file: string;
    try {
      file = await resolveProjectPath(rootAbs, `${JOBS_DIR_REL}/${name}`);
    } catch {
      continue; // unsafe (e.g. symlinked) record
    }
    if (!existsSync(file)) continue;
    try {
      const job = await loadJob(file);
      if (job) jobs.push(job);
    } catch {
      continue; // invalid record
    }
  }
  jobs.sort((a, b) => a.attempt.localeCompare(b.attempt));
  return jobs;
}

/**
 * The plan-side identity facts this adapter persisted for an attempt, reproduced
 * from the CURRENT Source without reading media, contacting a service or needing
 * the Endpoint address: the model, the prompt, the transmitted first-frame image
 * and the definition-normalized parameters.
 */
function planRequestFacts(
  source: ProviderSource,
  sha256Of: (assetId: string) => string | null,
  options: VideoApiOptions,
): Record<string, unknown> | null {
  const extension = options.extension ?? packagedExtensionFor(source.model, RUNWAY_PROTOCOL);
  let parameters: Record<string, unknown>;
  try {
    parameters = extension
      ? validateGenerationExtension(source, RUNWAY_PROTOCOL, {
          extension,
          ...(options.endpoint?.modelSettings !== undefined ? { modelSettings: options.endpoint.modelSettings } : {}),
        })
      : {};
  } catch {
    // The current Source no longer validates against the recorded model: the
    // attempt cannot be the same request, and saying so must not masquerade as a
    // model error.
    return null;
  }
  const first = transmittedReferences(RUNWAY_PROTOCOL, source.references ?? [])[0];
  const image = first ? { id: first.asset, sha256: sha256Of(first.asset), type: 'image' } : null;
  return { model: source.model, promptHash: stableHash(source.prompt), image, parameters };
}

/** The same facts as they were frozen into a persisted record. */
function recordedRequestFacts(job: RunwayJob): Record<string, unknown> {
  return {
    model: job.model,
    promptHash: job.promptHash,
    image: job.image ?? null,
    parameters: job.parameters,
  };
}

/**
 * Read-only attempt inspection for Plan: load this adapter's own record for the
 * Source's attempt and classify it. No network, no upload, no lock, no write and
 * no media read. The identity and provenance checks are the same facts the
 * execution path enforces before a POST.
 */
export async function inspectRunwayAttempt(
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
    label: 'Runway adapter',
    conflict: message => new RunwayProviderError(message),
  });
  const local = {
    artifactReady: await localBytesPresent(rootAbs, job?.artifactPath, job?.artifactSha256),
    originalReady: await localBytesPresent(rootAbs, job?.originalMediaPath, job?.originalMediaSha256),
  };
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  const changed: string[] = [];
  if (job !== null) {
    const extensionHash = await generationExtensionIdentity({
      extension: resolveEffectiveExtension(source.model, RUNWAY_PROTOCOL, options),
      modelSettings: options.endpoint?.modelSettings,
    }).catch(() => undefined);
    const facts = planRequestFacts(source, id => byId.get(id)?.sha256 ?? null, options);
    changed.push(
      ...attemptIdentityChanges({
        job,
        ...(extensionHash !== undefined ? { extensionHash } : {}),
        ...(options.endpoint !== undefined ? { endpointHash: runwayEndpointIdentity(source, options) } : {}),
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
    record: job === null ? null : attemptRecordFacts(job),
    local,
    wouldUpload: transmittedReferences(RUNWAY_PROTOCOL, source.references ?? []).map(reference => reference.asset),
    changed,
  });
}

/**
 * The CURRENT routing identity of this Source's Endpoint, or `undefined` when the
 * binding cannot be resolved (no base URL). Mirrors the `baseIdentity` the record
 * froze, so a local restore can tell "same service" from "same request".
 */
function runwayEndpointIdentity(source: ProviderSource, options: VideoApiOptions): string | undefined {
  try {
    const lane = resolveVideoLane(
      { endpoint: { ...options.endpoint, protocol: RUNWAY_PROTOCOL }, testOnly: options.testOnly },
      source,
      'Runway adapter',
    );
    const baseIdentity = lane.testOnly ? `test:${lane.baseUrl}` : `production:${lane.baseUrl}`;
    return stableHash(baseIdentity);
  } catch {
    return undefined;
  }
}
