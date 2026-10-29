import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { credentialSetupHint, resolveCredential } from '../../../config/credentials.js';
import {
  type Artifact,
  type Asset,
  AssetSchema,
  Id,
  type MediaInfo,
  MediaInfoSchema,
  OutputSchema,
  type OutputSettings,
  type ProviderSource,
  type ReferenceCategory,
  type ReferenceRole,
  ReferenceRoleSchema,
  SourceSchema,
} from '../../../core/schema.js';
import { resolveProjectPath } from '../../../shared/fs.js';
import { hashFile, stableHash } from '../../../shared/hash.js';
import { runCommand } from '../../../shared/process.js';
import { probeMedia } from '../../media/probe.js';
import { isPrivateAddress } from '../address.js';
import {
  type AttemptInspection,
  attemptIdentityChanges,
  attemptInspection,
  attemptRecordFacts,
  changedFields,
  localBytesPresent,
  readAttemptRecord,
  restoreCompletedAttempt,
} from '../attempt.js';
import { resolveEffectiveExtension } from '../effective.js';
import {
  type GenerationExtensionOptions,
  type MappingReference,
  generationExtensionIdentity,
  validateGenerationReferenceSet,
} from '../extension.js';
import { readCapped } from '../http-body.js';
import {
  acquireAttemptLock as acquireSharedAttemptLock,
  attemptStem,
  loadJobRecord,
  patchJobRecord,
  saveJobRecord,
} from '../job-store.js';
import {
  VIDEO_SERVICE_PROTOCOLS,
  type VideoServiceProtocol,
  resolveVideoLane,
  stripBrackets,
  transmittedReferences,
} from '../lane.js';
import { materializeFromLocal, normalizeAtomic, pickMedia } from '../local-media.js';
import { endpointIdentityOf, prepareVideoRequest } from '../prepare.js';
import {
  assertOptionalReferenceBytesMatch,
  type VideoReferenceInput,
  referenceFacts,
  validateReferenceLocator,
} from '../reference-facts.js';
import { VIDEO_API_AUDIO_BYTES, VIDEO_API_IMAGE_BYTES, VIDEO_API_VIDEO_BYTES } from '../transfer-bounds.js';
import { arkVideoProtocol } from './ark/video.js';
import { minimaxVideoProtocol } from './minimax/video.js';
import { type VideoProtocol } from './video.js';
import { vllmOmniVideoProtocol } from './vllm-omni/video.js';

const PROVIDER = 'video-api';

const PROTOCOL_VERSION = 1;

const JOB_SCHEMA_VERSION = 1;

function selectedProtocol(options: VideoApiOptions): VideoProtocol {
  const protocol = options.endpoint?.protocol ?? 'vllm-omni-video';
  if (protocol === 'ark-video-v3') return arkVideoProtocol;
  if (protocol === 'minimax-video-v2') return minimaxVideoProtocol;
  if (protocol === 'vllm-omni-video') return vllmOmniVideoProtocol;
  // `runway-v1` / `fal-queue` are routed to their own adapters by
  // `video-service.ts`; the generic transport must never silently fall back.
  throw new VideoApiError(
    `Video API adapter: protocol '${protocol}' is not handled by the shared video task transport`,
  );
}

const JOBS_DIR_REL = '.viscraft/jobs/video-api';

const MEDIA_DIR_REL = '.viscraft/provider-media';

const MAX_JSON_BYTES = 2 * 1024 * 1024;

const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

// Client transfer bounds, independent of the selected model's own limits (shared
// with the preflight's transfer-size check in `prepare.ts`).
const MAX_IMAGE_BYTES = VIDEO_API_IMAGE_BYTES;

const JSON_TIMEOUT_MS = 30_000;

const MEDIA_TIMEOUT_MS = 300_000;

const MIN_QUERY_INTERVAL_MS = 5_000;

const MAX_REDIRECTS = 3;

// Server-generated ids look like `video_gen_<hex>`; accept the documented shape
// plus safe separators, never a path separator.
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

type Size = ProviderSource['size'];

export const VideoApiEndpointSchema = z
  .object({
    // `runway-v1` / `fal-queue` select the vendor protocol adapters (routed by
    // `video-service.ts`); `vllm-omni-video` / `ark-video-v3` use the generic transport.
    protocol: z.enum(VIDEO_SERVICE_PROTOCOLS),
    baseUrl: z.string().min(1),
    sourceModel: z.string().min(1).optional(),
    // A deployment may expose a different wire model id from the authored model.
    model: z.string().trim().min(1).max(1000).optional(),
    credential: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
    // Optional settings owned and validated by a trusted SDK model integration.
    // User connections select explicit model identities instead.
    modelSettings: z.record(z.unknown()).optional(),
  })
  .strict();

export type VideoApiEndpoint = z.infer<typeof VideoApiEndpointSchema>;

export interface VideoApiOptions extends Pick<GenerationExtensionOptions, 'extension'> {
  endpoint?: VideoApiEndpoint;
  authorization?: { submit: boolean; uploadAssets?: string[] };
  testOnly?: { baseUrl: string };
  // One entry per declared reference, resolved by Asset id. Source reference
  // order controls the wire request; every supplied Asset is hash-checked.
  references?: VideoReferenceInput[];
  referenceLocators?: Record<string, { url: string; sha256: string }>;
}

/**
 * Portable provider provenance attached to a successful artifact. Contains no
 * credentials, no remote URLs and no invented costs.
 */
export interface VideoApiResult {
  backend: string;
  generation: NonNullable<Artifact['generation']>;
}

export class VideoApiError extends Error {
  /** True when the caller can safely retry the *same* attempt later (no resubmit). */
  recoverable = false;
  constructor(message: string) {
    super(message);
    this.name = 'VideoApiError';
  }
}

/** A recoverable, non-fatal state: re-run to continue, never to resubmit. */
export class VideoApiPendingError extends VideoApiError {
  readonly nextQueryAt?: string;
  constructor(message: string, nextQueryAt?: string) {
    super(message);
    this.name = 'VideoApiPendingError';
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
]);

const jobSchema = z
  .object({
    schemaVersion: z.literal(JOB_SCHEMA_VERSION),
    backend: z.string().min(1),
    provider: z.literal(PROVIDER),
    model: z.string().min(1),
    simulated: z.boolean(),
    mode: z.enum(['production', 'test']),
    attempt: Id,
    sourceId: Id,
    promptHash: z.string().regex(/^[a-f0-9]{64}$/),
    parametersHash: z.string().regex(/^[a-f0-9]{64}$/),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    protocol: z.enum(['vllm-omni-video', 'minimax-video-v2', 'ark-video-v3']),
    extensionHash: z.string().regex(/^[a-f0-9]{64}$/),
    // The routing identity this attempt was frozen against (protocol + base URL
    // + wire model + settings).
    endpointHash: z.string().regex(/^[a-f0-9]{64}$/),
    locatorHash: z.string().regex(/^[a-f0-9]{64}$/),
    // NOTE: no result URL is persisted. Services return short-lived SIGNED URLs
    // (secret query parameters); it is used in-memory for a download and re-fetched
    // from the task on a later run, never written to the record.
    // Ordered reference provenance only: id/hash/category/role, never bytes.
    references: z.array(
      z
        .object({
          asset: Id,
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          category: z.enum(['image', 'video', 'audio']),
          role: ReferenceRoleSchema,
          mime: z.string().min(1).optional(),
          media: MediaInfoSchema.optional(),
          simulated: z.boolean(),
        })
        .strict(),
    ),
    size: z.string().regex(/^[1-9]\d{0,4}:[1-9]\d{0,4}$/),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    requestedFrames: z.number().int().positive(),
    fps: z.number().finite().positive(),
    flowShift: z.number().finite().positive().optional(),
    endpoint: Id,
    steps: z.number().int().positive().optional(),
    seed: z.number().int().optional(),
    output: OutputSchema,
    state: jobStateSchema,
    submitted: z.number().int().nonnegative(),
    taskId: z.string().min(1).optional(),
    inferenceSeconds: z.number().finite().nonnegative().optional(),
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

export type VideoApiJob = z.infer<typeof jobSchema>;

export type VideoApiJobState = z.infer<typeof jobStateSchema>;

function now(): string {
  return new Date().toISOString();
}

function patchJob(job: VideoApiJob, changes: Partial<VideoApiJob>): VideoApiJob {
  return patchJobRecord(job, changes, now());
}

/** Build the portable provenance for a successfully completed job. */
function successResult(job: VideoApiJob): VideoApiResult {
  if (!job.taskId || !job.originalMediaSha256) {
    throw new VideoApiError(
      'Video API adapter: a succeeded job is missing provider provenance (task id / original media hash)',
    );
  }
  return {
    backend: job.backend,
    generation: {
      provider: PROVIDER,
      protocol: job.protocol,
      extensionHash: job.extensionHash,
      model: job.model,
      taskId: job.taskId,
      requestHash: job.requestHash,
      originalSha256: job.originalMediaSha256,
      requestedFrames: job.requestedFrames,
      ...(job.inferenceSeconds !== undefined ? { inferenceSeconds: job.inferenceSeconds } : {}),
      ...(job.originalMedia ? { originalMedia: job.originalMedia } : {}),
      references: job.references.map(reference => ({
        asset: reference.asset,
        sha256: reference.sha256,
        category: reference.category,
        role: reference.role,
        ...(reference.media ? { media: reference.media } : {}),
      })),
    },
  };
}

async function loadJob(jobFile: string): Promise<VideoApiJob | null> {
  return loadJobRecord(jobFile, jobSchema, 'Video API adapter', message => new VideoApiError(message));
}

async function saveJob(jobFile: string, job: VideoApiJob): Promise<void> {
  await saveJobRecord(jobFile, job);
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

async function resolveDestination(rootAbs: string, destination: string): Promise<{ abs: string; rel: string }> {
  if (!destination || destination.includes('\0'))
    throw new VideoApiError('Video API adapter: invalid destination path');
  let rel: string;
  if (isAbsolute(destination)) {
    const base = await realpath(rootAbs);
    rel = relative(base, normalize(destination)).split(sep).join('/');
    if (!rel || rel.startsWith('..') || isAbsolute(rel))
      throw new VideoApiError('Video API adapter: destination escapes project root');
  } else {
    rel = destination;
  }
  const abs = await resolveProjectPath(rootAbs, rel);
  return { abs, rel };
}

// ---------------------------------------------------------------------------
// Options / authorization / base resolution
// ---------------------------------------------------------------------------

function credentialHeaders(credentialName?: string): Record<string, string> {
  if (!credentialName) return {};
  const key = resolveCredential(credentialName);
  if (!key)
    throw new VideoApiError(
      `Video API adapter: credential ${credentialName} is not configured (${credentialSetupHint(credentialName)})`,
    );
  return { Authorization: `Bearer ${key}` };
}

/**
 * Real submission requires explicit authorization AND per-Asset transmission
 * consent for reference media. Credentials are resolved from the selected
 * endpoint only when network work is needed. Test mode is exempt and simulated.
 * This runs before
 * any job record is written and before any network call.
 */
function assertAuthorizedForSubmit(
  testOnly: boolean,
  options: VideoApiOptions,
  uploadedAssetIds: readonly string[] = [],
): void {
  if (testOnly) return; // loopback fixture; nothing real is generated
  if (options.authorization?.submit !== true) {
    throw new VideoApiError(
      'Video API adapter: real generation requires explicit authorization (`{ authorization: { submit: true } }`); no request was sent and no job was created.',
    );
  }
  for (const uploadAssetId of uploadedAssetIds) {
    if (!options.authorization.uploadAssets?.includes(uploadAssetId)) {
      throw new VideoApiError(
        `Video API adapter: transmitting reference Asset '${uploadAssetId}' to the selected generation service requires explicit per-Asset consent ` +
          `(\`{ authorization: { submit: true, uploadAssets: ['${uploadAssetId}'] } }\`); a redistributable license is NOT transmission consent. ` +
          'No request was sent and no job was created.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Ordered reference resolution
// ---------------------------------------------------------------------------

// Viscraft's OWN reference-upload transport budget for the generic lane — a
// client-side choice, NOT a model or service input limit. A selected model's own
// input caps (counts, durations, geometry, bytes) belong to its `GenerationModel`
// and are enforced by `validateReferenceSet`/the deployed service; a fact that
// exceeds a model limit is refused there rather than here.
const MAX_VIDEO_BYTES = VIDEO_API_VIDEO_BYTES;

const MAX_AUDIO_BYTES = VIDEO_API_AUDIO_BYTES;

interface ResolvedReference {
  assetId: string;
  sha256: string;
  category: ReferenceCategory;
  role: ReferenceRole;
  mime: string;
  filename: string;
  simulated: boolean;
  media?: MediaInfo;
  bytes: Buffer;
}

interface VideoIdentityReference {
  assetId: string;
  sha256: string;
  category: ReferenceCategory;
  role: ReferenceRole;
  mime: string;
  locator?: string;
  simulated: boolean;
  media?: MediaInfo;
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

/** Identify a common audio container by magic bytes; unknown containers keep `application/octet-stream`. */
function detectAudioMime(bytes: Buffer): { mime: string; extension: string } {
  if (
    bytes.length >= 4 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WAVE'
  )
    return { mime: 'audio/wav', extension: 'wav' };
  if (
    bytes.length >= 3 &&
    (bytes.subarray(0, 3).toString('ascii') === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))
  )
    return { mime: 'audio/mpeg', extension: 'mp3' };
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp')
    return { mime: 'audio/mp4', extension: 'm4a' };
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xf1) return { mime: 'audio/aac', extension: 'aac' };
  return { mime: 'application/octet-stream', extension: 'bin' };
}

/**
 * Resolve ONE ordered reference against its caller-provided media.
 *
 * The ONLY accepted source is a caller-provided `options.references[i]` whose
 * Asset id equals `reference.asset` — nothing is fetched, generated or
 * substituted. The Asset is re-validated with the canonical `AssetSchema`, its
 * bytes are read from the frozen asset root, must match the recorded `sha256`
 * and are size-capped. Image references must be PNG/JPEG **by signature** (SVG
 * and everything else is refused, never converted); video references must be an
 * MP4 whose media satisfies the selected model's reference profile; audio
 * references must carry a real audio stream. This all runs before the
 * per-attempt lock, any job record and any network call.
 */
async function resolveReference(
  reference: { asset: string; category: ReferenceCategory; role: ReferenceRole },
  source: ProviderSource,
  provided: VideoReferenceInput | undefined,
  options: VideoApiOptions,
): Promise<ResolvedReference> {
  const expectedType = reference.category === 'image' ? 'image' : reference.category === 'video' ? 'video' : 'audio';
  if (!provided || typeof provided.root !== 'string' || provided.root.length === 0) {
    throw new VideoApiError(
      `Video API adapter: Source '${source.id}' declares a ${reference.category} reference Asset '${reference.asset}' (role ${reference.role}) but no matching options.references entry (asset + frozen root) was provided; no request was sent and no job was created.`,
    );
  }
  const parsed = AssetSchema.safeParse(provided.asset);
  if (!parsed.success) throw new VideoApiError('Video API adapter: a provided reference is not a valid Asset');
  const asset = parsed.data;
  if (asset.id !== reference.asset) {
    throw new VideoApiError(
      `Video API adapter: the provided reference Asset '${asset.id}' does not match the declared reference '${reference.asset}'; refusing before any request.`,
    );
  }
  if (asset.type !== expectedType)
    throw new VideoApiError(`Video API adapter: reference Asset '${asset.id}' is not a ${reference.category}`);
  let abs: string;
  try {
    abs = await resolveProjectPath(provided.root, asset.path);
  } catch {
    throw new VideoApiError(
      `Video API adapter: reference Asset '${asset.id}' does not resolve to a safe path inside its frozen root`,
    );
  }
  const cap =
    reference.category === 'image'
      ? MAX_IMAGE_BYTES
      : reference.category === 'video'
        ? MAX_VIDEO_BYTES
        : MAX_AUDIO_BYTES;
  let bytes: Buffer;
  try {
    const info = await stat(abs);
    if (!info.isFile() || info.size > cap) throw new Error('invalid reference file or transfer size');
    bytes = await readFile(abs);
  } catch {
    throw new VideoApiError(
      `Video API adapter: reference Asset '${asset.id}' could not be read from the frozen asset root`,
    );
  }
  if (bytes.length > cap)
    throw new VideoApiError(
      `Video API adapter: reference Asset '${asset.id}' is ${bytes.length} bytes, over the ${cap}-byte limit`,
    );
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
    throw new VideoApiError(
      `Video API adapter: reference Asset '${asset.id}' bytes do not match its recorded sha256; refusing to send`,
    );
  }

  if (reference.category === 'image') {
    const mime = detectImageMime(bytes);
    if (!mime) {
      throw new VideoApiError(
        `Video API adapter: reference image Asset '${asset.id}' is not a PNG or JPEG (by signature); SVG and other formats are refused rather than converted`,
      );
    }
    return Object.freeze({
      assetId: asset.id,
      sha256: asset.sha256,
      category: reference.category,
      role: reference.role,
      mime,
      filename: mime === 'image/png' ? 'reference.png' : 'reference.jpg',
      simulated: asset.simulated,
      bytes,
    });
  }

  if (reference.category === 'video') {
    if (bytes.length < 12 || bytes.subarray(4, 8).toString('ascii') !== 'ftyp')
      throw new VideoApiError('Video API adapter: reference video must be an MP4 container; no silent conversion');
    const media = await probeMedia(abs);
    const metadata = JSON.parse(
      await runCommand('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'format=format_name:stream=codec_type,codec_name',
        '-of',
        'json',
        abs,
      ]),
    ) as { format?: { format_name?: string }; streams?: Array<{ codec_type?: string; codec_name?: string }> };
    if (!metadata.format?.format_name?.split(',').includes('mp4'))
      throw new VideoApiError('Video API adapter: reference requires MP4');
    try {
      options.extension?.model.validateReference?.(
        reference,
        media,
        (metadata.streams ?? []).filter(stream => stream.codec_type === 'audio').map(stream => stream.codec_name ?? ''),
      );
    } catch (error) {
      throw new VideoApiError((error as Error).message);
    }
    if ((await hashFile(abs)) !== asset.sha256)
      throw new VideoApiError('Video API adapter: reference video changed during validation');
    return Object.freeze({
      assetId: asset.id,
      sha256: asset.sha256,
      category: reference.category,
      role: reference.role,
      mime: 'video/mp4',
      filename: 'reference.mp4',
      simulated: asset.simulated,
      media,
      bytes,
    });
  }

  // Audio reference: the container format is detected by signature; the model
  // profile does not yet pin an audio codec, so only a real audio stream is
  // required (the selected service reports any narrower constraint).
  const metadata = JSON.parse(
    await runCommand('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', abs]),
  ) as { streams?: Array<{ codec_type?: string }> };
  if (!(metadata.streams ?? []).some(stream => stream.codec_type === 'audio'))
    throw new VideoApiError(
      `Video API adapter: reference Asset '${asset.id}' declares an audio reference but carries no audio stream`,
    );
  const detected = detectAudioMime(bytes);
  if ((await hashFile(abs)) !== asset.sha256)
    throw new VideoApiError('Video API adapter: reference audio changed during validation');
  return Object.freeze({
    assetId: asset.id,
    sha256: asset.sha256,
    category: reference.category,
    role: reference.role,
    mime: detected.mime,
    filename: `reference.${detected.extension}`,
    simulated: asset.simulated,
    bytes,
  });
}

/**
 * Resolve the Source's ordered references into a matching ordered list. The
 * provided list must cover exactly the declared references and each Asset id
 * must match; order is the Source's own order (the correspondence to the wire
 * `<Picture N>` / `<Video N>` / `<Audio N>` positions).
 *
 * LIMIT PROVENANCE: this adapter imposes NO reference-count limit of its own.
 * A model's counts are enforced in its model profile, before this point
 * (`validateGenerationExtension` -> `validateMinimaxH3Request` for MiniMax-H3;
 * see `models/minimax-h3.ts`). For every other model no per-model count has been
 * verified, so none is enforced rather than inventing one.
 */
async function resolveReferences(source: ProviderSource, options: VideoApiOptions): Promise<ResolvedReference[]> {
  const declared = source.references ?? [];
  const provided = options.references ?? [];
  if (declared.length !== provided.length) {
    throw new VideoApiError(
      `Video API adapter: Source '${source.id}' declares ${declared.length} reference(s) but ${provided.length} were provided; refusing before any request.`,
    );
  }
  const byId = new Map(provided.map(input => [input.asset.id, input]));
  // A declared Asset id may legitimately appear more than once (e.g. the same
  // still used as both `identity` and `style`). The provided list then carries
  // one entry per declared reference; if two entries claim the same id with
  // DIFFERENT bytes, resolving by id would silently pick one and drop the other.
  // Refuse the ambiguity instead (mirrors the fal adapter's duplicate guard).
  for (const id of byId.keys()) {
    const duplicates = provided.filter(input => input.asset?.id === id);
    if (new Set(duplicates.map(duplicate => `${duplicate.asset.sha256}:${duplicate.asset.path}`)).size > 1) {
      throw new VideoApiError(
        `Video API adapter: reference Asset '${id}' has conflicting duplicate options.references entries (same id, different sha256/path); refusing before any request.`,
      );
    }
  }
  const resolved: ResolvedReference[] = [];
  for (const reference of declared)
    resolved.push(await resolveReference(reference, source, byId.get(reference.asset), options));
  return resolved;
}

/** Rebuild only the frozen reference identity for an already-submitted job.
 * The reference bytes are not part of the wire identity; they were admitted and
 * hashed before the original POST. This path is never used for a `created` job.
 */
async function resumeReferenceMetadata(
  source: ProviderSource,
  options: VideoApiOptions,
  job: VideoApiJob,
): Promise<VideoIdentityReference[][]> {
  const declared = source.references ?? [];
  const provided = options.references ?? [];
  if (declared.length !== provided.length)
    throw new VideoApiError(
      `Video API adapter: attempt '${job.attempt}' cannot be resumed because its current reference descriptors are incomplete`,
    );
  const byId = new Map<string, Asset>();
  for (const input of provided) {
    const parsed = AssetSchema.safeParse(input.asset);
    if (!parsed.success) throw new VideoApiError('Video API adapter: a provided reference is not a valid Asset');
    const previous = byId.get(parsed.data.id);
    if (previous && stableHash(previous) !== stableHash(parsed.data))
      throw new VideoApiError(
        `Video API adapter: attempt '${job.attempt}' has conflicting current descriptors for reference Asset '${parsed.data.id}'`,
      );
    byId.set(parsed.data.id, parsed.data);
  }
  const stored = job.references;
  let candidates: VideoIdentityReference[][] = [[]];
  for (const [index, reference] of declared.entries()) {
    const asset = byId.get(reference.asset);
    const frozen = stored[index];
    const expectedType = reference.category === 'image' ? 'image' : reference.category === 'video' ? 'video' : 'audio';
    if (
      !asset ||
      !frozen ||
      asset.id !== reference.asset ||
      asset.type !== expectedType ||
      frozen.asset !== reference.asset ||
      frozen.sha256 !== asset.sha256 ||
      frozen.category !== reference.category ||
      frozen.role !== reference.role ||
      frozen.simulated !== asset.simulated
    ) {
      throw new VideoApiError(
        `Video API adapter: attempt '${job.attempt}' cannot be resumed because reference '${reference.asset}' identity, hash, role, category, or provenance differs from the submitted request`,
      );
    }
    const input = provided.find(candidate => candidate.asset.id === asset.id)!;
    try {
      await assertOptionalReferenceBytesMatch(input.root, asset, 'Video API adapter');
    } catch (error) {
      throw new VideoApiError((error as Error).message);
    }
    // Old valid jobs did not persist a MIME field. For image references the
    // original transport admitted exactly PNG or JPEG by signature, so try both
    // semantic identities and accept only the candidate whose complete current
    // request hash equals the recorded hash. No candidate bytes are fabricated
    // or sent; a candidate only supplies the already-validated media-type fact.
    const mimeOptions = frozen.mime ? [frozen.mime] : reference.category === 'image' ? ['image/png', 'image/jpeg'] : [];
    if (mimeOptions.length === 0)
      throw new VideoApiError(
        `Video API adapter: attempt '${job.attempt}' lacks enough recorded reference identity to resume without its original bytes`,
      );
    candidates = candidates.flatMap(prefix =>
      mimeOptions.map(mime => [
        ...prefix,
        {
          assetId: asset.id,
          sha256: asset.sha256,
          category: reference.category,
          role: reference.role,
          mime,
          filename: 'reference.bin',
          simulated: asset.simulated,
          ...(frozen.media ? { media: frozen.media } : {}),
        },
      ]),
    );
    if (candidates.length > 256)
      throw new VideoApiError(
        `Video API adapter: attempt '${job.attempt}' reference identity is ambiguous without its original bytes`,
      );
  }
  if (stored.length !== declared.length)
    throw new VideoApiError(
      `Video API adapter: attempt '${job.attempt}' reference provenance is incomplete; refusing recovery`,
    );
  return candidates;
}

// ---------------------------------------------------------------------------
// Per-attempt lock (explicit concurrent-refusal)
// ---------------------------------------------------------------------------

async function acquireAttemptLock(rootAbs: string, stem: string, attempt: string): Promise<() => Promise<void>> {
  return acquireSharedAttemptLock({
    rootAbs,
    stem,
    attempt,
    dirRel: JOBS_DIR_REL,
    label: 'Video API adapter',
    conflict: message => new VideoApiError(message),
  });
}

/** One JSON/form request. Transport/timeout errors propagate (callers treat them as ambiguous). */
async function jsonRequest(req: {
  url: string;
  method: 'GET' | 'POST';
  body?: FormData | string;
  headers?: Record<string, string>;
}): Promise<{ status: number; text: string }> {
  const init: RequestInit = {
    method: req.method,
    headers: {
      Accept: 'application/json',
      ...(typeof req.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
      ...req.headers,
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
  };
  if (req.body !== undefined) init.body = req.body; // FormData sets its own boundary
  const response = await fetch(req.url, init);
  const buf = await readCapped(
    response,
    MAX_JSON_BYTES,
    () => new VideoApiError('Video API adapter: response exceeded the configured size cap'),
  );
  return { status: response.status, text: buf.toString('utf8') };
}

type SubmitOutcome =
  { kind: 'accepted'; taskId: string } | { kind: 'unknown'; detail: string } | { kind: 'rejected'; detail: string };

async function submitTask(
  baseUrl: string,
  body: FormData | string,
  headers: Record<string, string>,
  protocol: VideoProtocol,
): Promise<SubmitOutcome> {
  let response: { status: number; text: string };
  try {
    response = await jsonRequest({ url: `${baseUrl}${protocol.tasksPath}`, method: 'POST', body, headers });
  } catch {
    return { kind: 'unknown', detail: 'submit transport error' };
  }
  const { status } = response;
  if (status >= 200 && status < 300) {
    try {
      const taskId = protocol.parseCreate(JSON.parse(response.text));
      if (!JOB_ID_PATTERN.test(taskId)) throw new Error('invalid task id');
      return { kind: 'accepted', taskId };
    } catch {
      return { kind: 'unknown', detail: 'submit returned an unexpected or malformed response body' };
    }
  }
  if (status === 408 || status === 429 || (status >= 300 && status < 400) || status >= 500)
    return { kind: 'unknown', detail: `submit returned HTTP ${status}` };
  return { kind: 'rejected', detail: `submit rejected with HTTP ${status}` };
}

type TaskQuery =
  | { kind: 'in-flight'; status: string }
  | { kind: 'completed'; inferenceSeconds?: number; contentUrl?: string }
  | { kind: 'failed'; detail: string };

async function queryTask(
  baseUrl: string,
  taskId: string,
  headers: Record<string, string>,
  protocol: VideoProtocol,
): Promise<TaskQuery> {
  if (!JOB_ID_PATTERN.test(taskId)) throw new VideoApiError('Video API adapter: refusing to query an invalid task id');
  let response: { status: number; text: string };
  try {
    response = await jsonRequest({ url: `${baseUrl}${protocol.statusPath(taskId)}`, method: 'GET', headers });
  } catch {
    throw new VideoApiPendingError('Video API adapter: job status query failed (transport); not resubmitting.');
  }
  try {
    const result = protocol.parseStatus(JSON.parse(response.text), taskId);
    if (result.state === 'failed') return { kind: 'failed', detail: `provider generation ${result.status}` };
    if (response.status >= 200 && response.status < 300)
      return result.state === 'ready'
        ? { kind: 'completed', inferenceSeconds: result.inferenceSeconds, contentUrl: result.contentUrl }
        : { kind: 'in-flight', status: result.status };
  } catch (error) {
    if (error instanceof Error && error.message.includes('task id does not match'))
      throw new VideoApiError(
        'Video API adapter: job status id does not match the persisted task id; refusing to act on it.',
      );
  }
  const status = response.status;
  if (status === 404)
    throw new VideoApiError('Video API adapter: remote job no longer exists (deleted or expired); not resubmitting.');
  if (status === 408 || status === 429 || (status >= 300 && status < 400) || status >= 500)
    throw new VideoApiPendingError(
      `Video API adapter: job status query temporarily unavailable (HTTP ${status}); not resubmitting.`,
    );
  if (status < 200 || status >= 300)
    throw new VideoApiError(`Video API adapter: job status query failed with HTTP ${status}`);
  throw new VideoApiPendingError('Video API adapter: job status response was malformed; not resubmitting.');
}

// ---------------------------------------------------------------------------
// Download (same-origin content or validated service result URL)
// ---------------------------------------------------------------------------

/** Every download hop must retain the selected service origin and scheme. */
function assertSameServiceOrigin(raw: string, base: URL): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new VideoApiError('Video API adapter: refusing to download from an invalid URL');
  }
  if (url.username || url.password)
    throw new VideoApiError('Video API adapter: refusing to download from a URL that carries credentials');
  if (url.protocol !== base.protocol)
    throw new VideoApiError('Video API adapter: media download cannot change transport scheme');
  if (url.origin !== base.origin)
    throw new VideoApiError('Video API adapter: downloads must stay on the same selected service origin');
  return url.toString();
}

async function assertMediaLocation(raw: string, base: URL, testOnly: boolean): Promise<string> {
  const url = new URL(raw);
  if (url.username || url.password || url.hash) throw new VideoApiError('Invalid result media URL');
  if (testOnly) return assertSameServiceOrigin(raw, base);
  if (url.protocol !== 'https:') throw new VideoApiError('Result media requires HTTPS');
  const host = stripBrackets(url.hostname).toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost'))
    throw new VideoApiError('Private result media host is refused');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address)))
    throw new VideoApiError('Private result media address is refused');
  return url.toString();
}

/**
 * Stream the generated file from the deterministic content endpoint to a temp
 * file (byte-capped) and rename into place. Uses `pipeline` so backpressure and
 * stream errors (including a mid-write disk failure) propagate and the partial
 * file is cleaned up.
 */
async function downloadContent(
  baseUrl: string,
  taskId: string,
  destAbs: string,
  headers: Record<string, string>,
  protocol: VideoProtocol,
  contentUrl: string | undefined,
  testOnly: boolean,
): Promise<void> {
  if (!JOB_ID_PATTERN.test(taskId))
    throw new VideoApiError('Video API adapter: refusing to download an invalid task id');
  const base = new URL(baseUrl);
  await mkdir(dirname(destAbs), { recursive: true });
  const tmp = `${destAbs}.viscraft-dl-${process.pid}-${Date.now().toString(36)}`;
  let current = contentUrl ?? `${baseUrl}${protocol.contentPath?.(taskId) ?? ''}`;
  if (!contentUrl && !protocol.contentPath) throw new VideoApiError('Video protocol has no result location');
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const safe =
        protocol.id === 'vllm-omni-video'
          ? assertSameServiceOrigin(current, base)
          : await assertMediaLocation(current, base, testOnly);
      const response = await fetch(safe, {
        method: 'GET',
        redirect: 'manual',
        headers: { Accept: 'video/mp4,video/*;q=0.9,*/*;q=0.5', ...(protocol.id === 'vllm-omni-video' ? headers : {}) },
        signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS),
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) throw new VideoApiError('Video API adapter: media download redirect without a location');
        current = new URL(location, safe).toString();
        continue;
      }
      if (!response.ok)
        throw new VideoApiError(`Video API adapter: media download failed with HTTP ${response.status}`);
      const body = response.body;
      if (!body) throw new VideoApiError('Video API adapter: media download returned an empty body');

      let total = 0;
      const cap = new Transform({
        transform(
          chunk: Buffer,
          _encoding: BufferEncoding,
          callback: (error?: Error | null, data?: unknown) => void,
        ): void {
          total += chunk.length;
          if (total > MAX_MEDIA_BYTES)
            callback(new VideoApiError('Video API adapter: media download exceeded the configured size cap'));
          else callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(body as unknown as import('node:stream/web').ReadableStream),
        cap,
        createWriteStream(tmp, { mode: 0o600 }),
      );
      if (total === 0) throw new VideoApiError('Video API adapter: media download produced no bytes');
      await rename(tmp, destAbs);
      return;
    }
    throw new VideoApiError('Video API adapter: media download exceeded the redirect limit');
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// generateVideoApi
// ---------------------------------------------------------------------------

function parseSize(size: Size): { width: number; height: number } {
  const [width, height] = size.split(':').map(Number);
  return { width, height };
}

function videoRequestHash(
  source: ProviderSource,
  prepared: ReturnType<typeof prepareVideoRequest>,
  extensionHash: string,
  references: readonly (ResolvedReference | VideoIdentityReference)[],
): string {
  const { width, height } = parseSize(source.size);
  return stableHash({
    protocolVersion: PROTOCOL_VERSION,
    protocol: prepared.protocol,
    extensionHash,
    request: prepared.requestIdentity,
    kind: PROVIDER,
    model: source.model,
    mode: prepared.testOnly ? 'test' : 'production',
    baseIdentity: prepared.endpointIdentity,
    endpoint: source.endpoint,
    fps: source.fps,
    flowShift: source.flowShift ?? null,
    id: source.id,
    promptHash: stableHash(source.prompt),
    generationMode: source.mode,
    size: source.size,
    width,
    height,
    requestedFrames: source.requestedFrames,
    steps: source.steps,
    seed: source.seed,
    // Local normalization is not a remote generation input.
    references: references.map(reference => ({
      asset: reference.assetId,
      sha256: reference.sha256,
      category: reference.category,
      role: reference.role,
    })),
  });
}

function mappedReferences(references: readonly ResolvedReference[], options: VideoApiOptions): MappingReference[] {
  return references.map(ref => {
    const locator = options.referenceLocators?.[ref.assetId];
    if (locator) {
      validateReferenceLocator(ref.assetId, ref.sha256, locator, options.testOnly?.baseUrl);
    }
    return {
      asset: ref.assetId,
      sha256: ref.sha256,
      category: ref.category,
      role: ref.role,
      mime: ref.mime,
      bytes: ref.bytes,
      locator: locator?.url,
    };
  });
}

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
  /** The frozen routing identity of the Endpoint (see `endpointIdentityOf`). */
  endpointIdentity: string;
  baseUrl: string;
  testOnly: boolean;
  options: VideoApiOptions;
  mode: 'production' | 'test';
  requestHash: string;
  wireModel: string;
  credentialName?: string;
  references: Array<ResolvedReference | VideoIdentityReference>;
  /** Existing job reference MIME facts, preserving records created before they were stored. */
  persistReferenceMime?: readonly boolean[];
  protocol: VideoProtocol;
  extensionHash: string;
  body?: FormData | string;
}

/**
 * Produce a normalized Take for a `provider` Source.
 *
 * Re-entrant and idempotent per attempt: a succeeded job restores its artifact
 * locally (re-normalizing from retained provider media if needed) without a
 * resubmit; an ambiguous submit is never resubmitted; a failed download resumes
 * without regenerating. See the module header for the full invariant list.
 */
export async function generateVideoApi(
  root: string,
  source: ProviderSource,
  output: OutputSettings,
  destination: string,
  options: VideoApiOptions = {},
): Promise<VideoApiResult> {
  // Canonical, public-boundary validation: an unvalidated caller cannot smuggle
  // an out-of-range request past the TypeScript types.
  const parsed = SourceSchema.safeParse(source);
  if (!parsed.success || parsed.data.kind !== 'provider')
    throw new VideoApiError('Video API adapter: expected a valid provider Source');
  const declared = parsed.data;
  // A SUCCEEDED attempt is local data: restore it before any Endpoint resolution,
  // credential lookup, reference read or body encoding, so a completed Take never
  // depends on the service that produced it.
  const rootAbs = resolve(root);
  const attempt = Id.parse(declared.attempt);
  const stem = attemptStem(declared.id, attempt);
  const jobFile = await resolveProjectPath(rootAbs, `${JOBS_DIR_REL}/${stem}.json`);
  const destinationPath = await resolveDestination(rootAbs, destination);
  const validatedOutput = OutputSchema.parse(output);
  const knownJob = await loadJob(jobFile);
  const restored = await restoreCompletedAttempt<VideoApiJob, VideoApiResult>({
    jobFileAbs: jobFile,
    attempt,
    rootAbs,
    destAbs: destinationPath.abs,
    destRel: destinationPath.rel,
    output: validatedOutput,
    label: 'Video API adapter',
    conflict: message => new VideoApiError(message),
    load: loadJob,
    save: saveJob,
    patch: (job, changes) => patchJob(job, changes),
    materialize: materializeFromLocal,
    result: successResult,
    // The implementation and routing identity are comparable only when the
    // binding names the service: with no Endpoint this adapter cannot know which
    // of its protocols produced a local artifact, and a guessed default must
    // not turn a completed Take into a "changed request". A paid action is never
    // taken here, so the authored projection plus the simulated label still guard
    // the restore. With a configured Endpoint every fact is compared.
    ...(options.endpoint !== undefined || options.testOnly !== undefined
      ? {
          extensionHash: await generationExtensionIdentity({
            extension: resolveEffectiveExtension(
              declared.model,
              (options.endpoint?.protocol ?? 'vllm-omni-video') as VideoServiceProtocol,
              options,
            ),
            modelSettings: options.endpoint?.modelSettings,
          }).catch(() => undefined),
          endpointHash: endpointIdentityForConfig(parsed.data, options),
        }
      : {}),
    provenance: {
      simulated: Boolean(options.testOnly) || (options.references ?? []).some(entry => entry.asset?.simulated === true),
      ...(options.endpoint !== undefined || options.testOnly !== undefined
        ? { backend: `${selectedProtocol(options).id}/${declared.model}` }
        : {}),
    },
    changedFieldsOf: job => [
      ...changedFields(
        planRequestFacts(
          declared,
          id => (options.references ?? []).find(entry => entry.asset?.id === id)?.asset.sha256 ?? null,
        ),
        recordedRequestFacts(job),
      ),
      ...((options.referenceLocators !== undefined ||
        options.endpoint !== undefined ||
        options.testOnly !== undefined) &&
      job.locatorHash !== referenceLocatorIdentity(declared, options, job.protocol)
        ? ['reference locators']
        : []),
    ],
    validateCurrent: async () => {
      for (const reference of declared.references ?? []) {
        const input = options.references?.find(candidate => candidate.asset?.id === reference.asset);
        if (input) {
          try {
            await assertOptionalReferenceBytesMatch(input.root, input.asset, 'Video API adapter');
          } catch (error) {
            throw new VideoApiError((error as Error).message);
          }
        }
      }
    },
  });
  if (restored !== undefined) return restored;
  // This transport serves explicit protocols whose
  // request bodies differ, so a configured Endpoint that names neither cannot be
  // routed: guessing would send the wrong body to a real service.
  if (options.endpoint !== undefined && (options.endpoint as { protocol?: string }).protocol === undefined)
    throw new VideoApiError(
      'Video API adapter: endpoint declares no protocol; name it explicitly (vllm-omni-video, minimax-video-v2 or ark-video-v3)',
    );
  const protocol = selectedProtocol(options);
  // Validate the request through the ONE read-only preparation pipeline (no media
  // read, no network) BEFORE any reference is touched; the SAME pipeline is then
  // re-run with the resolved reference payloads so the transmitted body and the
  // frozen identity come from that same function. Its EFFECTIVE extension (the
  // caller's, else the packaged definition for `(model, protocol)`) is used for
  // every later step — reference validation and the extension identity — so an
  // auto-selected and an explicitly supplied copy of a packaged definition share
  // one effective model definition, exactly as `fal.ts` / `runway.ts` already do.
  const effectiveExtension = prepareVideoRequest(parsed.data, options, undefined, 'Video API adapter').extension;
  const modelSettings = options.endpoint?.modelSettings;
  const preparedOptions: VideoApiOptions = { ...options, extension: effectiveExtension };
  const binding = { ...preparedOptions, modelSettings };
  const extensionHash = await generationExtensionIdentity(binding);
  // Resolve and validate every ordered reference BEFORE the lock, job record or
  // network. A source whose reference is not the matching approved Asset, or
  // whose provided list does not cover it exactly, is rejected here.
  // A job that was already submitted may only need a status GET, a result
  // download, or a local re-materialization. Reconstruct its request identity
  // from the current Source and the persisted, hash-bound Asset descriptors;
  // never reopen or re-upload the original bytes on that path. A merely-created
  // job still needs full byte admission before it can POST.
  const referenceCandidates =
    knownJob && knownJob.state !== 'created'
      ? await resumeReferenceMetadata(parsed.data, preparedOptions, knownJob)
      : [await resolveReferences(parsed.data, preparedOptions)];
  if (
    (!knownJob || knownJob.state === 'created') &&
    effectiveExtension &&
    (effectiveExtension.model.validateReferenceSet || effectiveExtension.mapping.validateReferenceSet)
  ) {
    // A zero-reference request (e.g. text-mode H3) may omit `options.references`
    // entirely; `resolveReferences` already guaranteed every DECLARED reference
    // has a matching entry, so an empty fallback only covers the zero-reference case.
    const byId = new Map((options.references ?? []).map(input => [input.asset.id, input]));
    const facts = await Promise.all(
      parsed.data.references.map(ref => {
        const input = byId.get(ref.asset)!;
        return referenceFacts(input.root, input.asset, ref);
      }),
    );
    validateGenerationReferenceSet(effectiveExtension, parsed.data, facts);
  }
  let references: Array<ResolvedReference | VideoIdentityReference> | undefined;
  let prepared: ReturnType<typeof prepareVideoRequest> | undefined;
  let requestHash: string | undefined;
  for (const candidate of referenceCandidates) {
    const identityOnly = Boolean(knownJob && knownJob.state !== 'created');
    const mappingReferences = identityOnly
      ? (candidate as VideoIdentityReference[]).map(reference => ({
          asset: reference.assetId,
          category: reference.category,
          role: reference.role,
          sha256: reference.sha256,
          mime: reference.mime,
          ...(reference.locator ? { locator: reference.locator } : {}),
        }))
      : mappedReferences(candidate as ResolvedReference[], preparedOptions);
    try {
      const candidatePrepared = prepareVideoRequest(
        parsed.data,
        preparedOptions,
        mappingReferences,
        'Video API adapter',
        identityOnly,
      );
      const candidateHash = videoRequestHash(parsed.data, candidatePrepared, extensionHash, candidate);
      if (!knownJob || knownJob.state === 'created' || candidateHash === knownJob.requestHash) {
        references = candidate;
        prepared = candidatePrepared;
        requestHash = candidateHash;
        break;
      }
    } catch (error) {
      const cannotRebuildWithoutBytes =
        identityOnly &&
        candidate.length > 0 &&
        error instanceof Error &&
        /cannot reproduce an existing request identity without reference bytes/i.test(error.message);
      if (!cannotRebuildWithoutBytes) throw error;
      // Some current mappings put inline file data directly into their mapped
      // JSON body and do not expose a metadata-only identity function. If the
      // exact reference bytes still exist, read and hash those real bytes to
      // reconstruct the original hash in memory; this path never POSTs because
      // the job is already submitted. If bytes are missing or changed,
      // resolveReferences fails closed and the task evidence is preserved.
      const byteBacked = await resolveReferences(parsed.data, preparedOptions);
      const bytePrepared = prepareVideoRequest(
        parsed.data,
        preparedOptions,
        mappedReferences(byteBacked, preparedOptions),
        'Video API adapter',
      );
      const byteHash = videoRequestHash(parsed.data, bytePrepared, extensionHash, byteBacked);
      if (byteHash === knownJob!.requestHash) {
        references = byteBacked;
        prepared = bytePrepared;
        requestHash = byteHash;
        break;
      }
    }
  }
  if (!references || !prepared || !requestHash)
    throw new VideoApiError(
      `Video API adapter: attempt '${knownJob?.attempt ?? attempt}' cannot be resumed because its complete current request identity does not match the recorded request`,
    );
  const src = prepared.source;
  const { baseUrl, testOnly, wireModel, endpointIdentity, credentialName } = prepared;
  const body = prepared.encodedBody;

  const mode: 'production' | 'test' = testOnly ? 'test' : 'production';

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
      endpointIdentity,
      baseUrl,
      wireModel,
      credentialName,
      testOnly,
      options,
      mode,
      requestHash,
      references,
      ...(knownJob && knownJob.state !== 'created'
        ? { persistReferenceMime: knownJob.references.map(reference => reference.mime !== undefined) }
        : {}),
      protocol,
      extensionHash,
      body,
    });
  } finally {
    await release();
  }
}

async function runGeneration(ctx: GenerationContext): Promise<VideoApiResult> {
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
    options,
    mode,
    requestHash,
    endpointIdentity,
    references,
    persistReferenceMime,
    credentialName,
    protocol,
    extensionHash,
    body,
  } = ctx;
  const { width, height } = parseSize(source.size);
  const uploadedAssetIds = references.map(reference => reference.assetId);

  const frozen = {
    schemaVersion: JOB_SCHEMA_VERSION as typeof JOB_SCHEMA_VERSION,
    backend: `${protocol.id}/${source.model}`,
    provider: PROVIDER as typeof PROVIDER,
    model: source.model,
    simulated: testOnly || references.some(reference => reference.simulated),
    mode,
    attempt,
    sourceId: Id.parse(source.id),
    promptHash: stableHash(source.prompt),
    parametersHash: stableHash(source.parameters ?? {}),
    requestHash,
    protocolVersion: PROTOCOL_VERSION as typeof PROTOCOL_VERSION,
    protocol: protocol.id as 'vllm-omni-video' | 'minimax-video-v2' | 'ark-video-v3',
    extensionHash,
    // The routing identity, so a later local restore can tell "same service" from
    // "same authored request, different deployment" without reading media.
    endpointHash: endpointIdentity,
    locatorHash: referenceLocatorIdentity(source, options, protocol.id as VideoServiceProtocol),
    references: references.map((reference, index) => ({
      asset: reference.assetId,
      sha256: reference.sha256,
      category: reference.category,
      role: reference.role,
      ...(persistReferenceMime?.[index] === false ? {} : { mime: reference.mime }),
      ...(reference.media ? { media: reference.media } : {}),
      simulated: reference.simulated,
    })),
    size: source.size,
    width,
    height,
    requestedFrames: source.requestedFrames,
    fps: source.fps,
    endpoint: source.endpoint,
    ...(source.flowShift !== undefined ? { flowShift: source.flowShift } : {}),
    steps: source.steps,
    seed: source.seed,
    output,
  };
  const loaded = await loadJob(jobFile);
  // `output` is the LOCAL normalization target, not a remote generation input, so
  // it is excluded from the frozen-request comparison: a job whose only difference
  // is the local output settings is NOT a different remote request. It is adopted
  // below and re-materialized from the retained original without any POST.
  // `endpointHash` is not compared here because the full `requestHash` above
  // already binds the same routing identity; it exists as a self-describing
  // durable field for the local-restore path, which runs before the body is built.
  const { output: _localOutput, endpointHash: _endpointHash, ...remoteFrozen } = frozen;
  const storedFrozen = loaded
    ? Object.fromEntries(
        [...new Set([...Object.keys(remoteFrozen), 'flowShift'])].map(key => [key, loaded[key as keyof VideoApiJob]]),
      )
    : null;
  if (loaded && (loaded.requestHash !== requestHash || stableHash(storedFrozen) !== stableHash(remoteFrozen))) {
    throw new VideoApiError(
      `Video API adapter: attempt '${attempt}' is already bound to a different frozen request; create a new attempt id instead of reusing this one with changed parameters.`,
    );
  }
  let job: VideoApiJob;
  if (loaded) {
    await mkdir(jobsDir, { recursive: true });
    await mkdir(mediaDir, { recursive: true });
    job = loaded;
    if (stableHash(loaded.output) !== stableHash(output)) {
      // Same remote request, changed LOCAL output: adopt the new normalization
      // settings. Reuse of the previously normalized artifact is refused below
      // because it is gated on the persisted `artifactOutput` matching the
      // current `job.output`; the retained original is re-normalized at the new
      // settings with no POST (never returning old-spec media).
      job = patchJob(job, { output });
      await saveJob(jobFile, job);
    }
  } else {
    // Gate before a job record or network call; every transmitted reference
    // needs independent per-Asset consent. A text-only request has none.
    assertAuthorizedForSubmit(testOnly, options, uploadedAssetIds);
    credentialHeaders(credentialName);
    await mkdir(jobsDir, { recursive: true });
    await mkdir(mediaDir, { recursive: true });
    job = {
      ...frozen,
      state: 'created',
      submitted: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    await saveJob(jobFile, job);
  }

  const originalRel = `${MEDIA_DIR_REL}/video-api-${stem}.mp4`;

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
    throw new VideoApiError(
      `Video API adapter: attempt '${attempt}' previously reached a permanent provider failure; not resubmitting. Create a new attempt id to retry.`,
    );
  }
  if (job.state === 'submit-unknown') {
    throw new VideoApiError(
      `Video API adapter: attempt '${attempt}' has an unknown submit outcome; the adapter will not resubmit (there is no verified idempotency lookup). Create a new attempt id if the original produced nothing.`,
    );
  }
  if (job.state === 'submitting') {
    // Interrupted mid-submit: the outcome is ambiguous, so block resubmission.
    job = patchJob(job, { state: 'submit-unknown', error: 'process interrupted during submit' });
    await saveJob(jobFile, job);
    throw new VideoApiError(
      `Video API adapter: attempt '${attempt}' was interrupted during submit; the outcome is unknown and it will not be resubmitted.`,
    );
  }

  // Stamp the next allowed query time BEFORE the query in real mode, so a
  // transient query failure is also rate-bound (test mode bypasses wall-clock).
  const gateQuery = async (): Promise<void> => {
    if (testOnly) return;
    if (job.nextQueryAt && Date.now() < Date.parse(job.nextQueryAt)) {
      throw new VideoApiPendingError(
        `Video API adapter: job ${job.taskId ?? ''} was queried recently; wait until ${job.nextQueryAt} before re-running.`,
        job.nextQueryAt,
      );
    }
    job = patchJob(job, { nextQueryAt: new Date(Date.now() + MIN_QUERY_INTERVAL_MS).toISOString() });
    await saveJob(jobFile, job);
  };

  if (job.state === 'created') {
    // A fresh POST is about to happen: re-assert the submit gate (including
    // per-Asset transmission consent). GET/download-only paths never reach here.
    assertAuthorizedForSubmit(testOnly, options, uploadedAssetIds);
    if (body === undefined)
      throw new VideoApiError(
        `Video API adapter: attempt '${attempt}' has no byte-backed request body and cannot be submitted`,
      );
    const headers = credentialHeaders(credentialName);
    const submitting = patchJob(job, { state: 'submitting', submitted: job.submitted + 1 });
    await saveJob(jobFile, submitting);
    job = submitting;

    const outcome = await submitTask(baseUrl, body, headers, protocol);

    if (outcome.kind === 'unknown') {
      job = patchJob(job, { state: 'submit-unknown', error: outcome.detail });
      await saveJob(jobFile, job);
      throw new VideoApiError(
        `Video API adapter: submit outcome for attempt '${attempt}' is unknown; not resubmitting.`,
      );
    }
    if (outcome.kind === 'rejected') {
      job = patchJob(job, { state: 'failed', error: outcome.detail });
      await saveJob(jobFile, job);
      throw new VideoApiError(
        `Video API adapter: the service rejected the request for attempt '${attempt}': ${outcome.detail}`,
      );
    }
    job = patchJob(job, { state: 'submitted', taskId: outcome.taskId, error: undefined, nextQueryAt: undefined });
    await saveJob(jobFile, job);
  }

  // The result URL a completed task reported IN THIS RUN. It is deliberately kept
  // in memory only (never persisted): Ark returns a short-lived signed URL whose
  // query parameters are a secret, so a later run re-fetches a fresh one from the
  // task instead of trusting a stored address.
  let contentUrl: string | undefined;

  if (job.state === 'submitted') {
    if (!job.taskId) throw new VideoApiError(`Video API adapter: attempt '${attempt}' is submitted without a task id`);
    await gateQuery();
    const query = await queryTask(baseUrl, job.taskId, credentialHeaders(credentialName), protocol);
    if (query.kind === 'in-flight') {
      job = patchJob(job, { state: 'submitted' });
      await saveJob(jobFile, job);
      throw new VideoApiPendingError(
        `Video API adapter: job ${job.taskId} is ${query.status}; not resubmitting.`,
        job.nextQueryAt,
      );
    }
    if (query.kind === 'failed') {
      job = patchJob(job, { state: 'failed', error: query.detail, nextQueryAt: undefined });
      await saveJob(jobFile, job);
      throw new VideoApiError(`Video API adapter: generation failed for attempt '${attempt}': ${query.detail}`);
    }
    contentUrl = query.contentUrl;
    job = patchJob(job, {
      state: 'remote-completed',
      error: undefined,
      nextQueryAt: undefined,
      ...(query.inferenceSeconds !== undefined ? { inferenceSeconds: query.inferenceSeconds } : {}),
    });
    await saveJob(jobFile, job);
  }

  if (job.state === 'remote-completed' || job.state === 'download-failed') {
    if (!job.taskId) throw new VideoApiError(`Video API adapter: attempt '${attempt}' completed without a task id`);

    // Nothing local is reusable -> restore the retained original if present,
    // otherwise re-fetch the deterministic content path (no status GET, no
    // submit anywhere on this path).
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

    const originalAbs = await resolveProjectPath(rootAbs, originalRel);
    // Result URLs are short-lived and never persisted, so when this run
    // does not already hold one (a resumed run), obtain it through the SAME
    // throttled query path as any other status check. An still-pending refresh is
    // a bounded wait (recoverable pending), NEVER a download failure.
    if (!protocol.contentPath && !contentUrl) {
      await gateQuery();
      const refreshed = await queryTask(baseUrl, job.taskId, credentialHeaders(credentialName), protocol);
      if (refreshed.kind === 'in-flight') {
        throw new VideoApiPendingError(
          `Video API adapter: ${protocol.id} result for job ${job.taskId} is not available yet (${refreshed.status}); not resubmitting.`,
          job.nextQueryAt,
        );
      }
      if (refreshed.kind === 'failed') {
        job = patchJob(job, { state: 'failed', error: refreshed.detail, nextQueryAt: undefined });
        await saveJob(jobFile, job);
        throw new VideoApiError(`Video API adapter: generation failed for attempt '${attempt}': ${refreshed.detail}`);
      }
      contentUrl = refreshed.contentUrl;
    }
    try {
      await downloadContent(
        baseUrl,
        job.taskId!,
        originalAbs,
        credentialHeaders(credentialName),
        protocol,
        contentUrl,
        testOnly,
      );
      const info = await probeMedia(originalAbs);
      if (info.frames <= 0) throw new VideoApiError('downloaded media has no frames');
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
    } catch {
      job = patchJob(job, { state: 'download-failed', downloadAttempted: true, error: 'media download failed' });
      await saveJob(jobFile, job);
      throw new VideoApiError(
        `Video API adapter: media download failed for attempt '${attempt}'; re-run to resume the download (no resubmit).`,
      );
    }

    // Normalize with the shared media plane. The actual frame count is
    // authoritative and is never padded/truncated to the requested value.
    await normalizeAtomic(originalAbs, output, destAbs);
    const normInfo = await probeMedia(destAbs);
    if (normInfo.frames <= 0)
      throw new VideoApiError(`Video API adapter: normalized media for attempt '${attempt}' has no frames`);
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

  throw new VideoApiError(`Video API adapter: attempt '${attempt}' reached unexpected state '${job.state}'`);
}

/**
 * List persisted video API job records (validated; contains no prompts, image
 * bytes or remote URLs). Unsafe or invalid records are skipped rather than
 * surfaced.
 */
export async function videoApiStatus(root: string): Promise<unknown[]> {
  const rootAbs = resolve(root);
  let jobsDir: string;
  try {
    jobsDir = await resolveProjectPath(rootAbs, JOBS_DIR_REL);
  } catch {
    return [];
  }
  if (!existsSync(jobsDir)) return [];
  const entries = await readdir(jobsDir);
  const jobs: VideoApiJob[] = [];
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
 * from the CURRENT Source. Deliberately excludes anything that needs the
 * Endpoint (base identity, effective extension hash) or a media read: this is
 * the comparison that must work when only the record and the Project remain.
 */
function planRequestFacts(
  source: ProviderSource,
  sha256Of: (assetId: string) => string | null,
): Record<string, unknown> {
  const { width, height } = parseSize(source.size);
  return {
    model: source.model,
    promptHash: stableHash(source.prompt),
    parametersHash: stableHash(source.parameters ?? {}),
    references: (source.references ?? []).map(reference => ({
      asset: reference.asset,
      category: reference.category,
      role: reference.role,
      sha256: sha256Of(reference.asset),
    })),
    size: source.size,
    width,
    height,
    requestedFrames: source.requestedFrames,
    fps: source.fps,
    endpoint: source.endpoint,
    flowShift: source.flowShift ?? null,
    steps: source.steps ?? null,
    seed: source.seed ?? null,
  };
}

/** The same facts as they were frozen into a persisted record. */
function recordedRequestFacts(job: VideoApiJob): Record<string, unknown> {
  return {
    model: job.model,
    promptHash: job.promptHash,
    parametersHash: job.parametersHash,
    references: job.references.map(reference => ({
      asset: reference.asset,
      category: reference.category,
      role: reference.role,
      sha256: reference.sha256,
    })),
    size: job.size,
    width: job.width,
    height: job.height,
    requestedFrames: job.requestedFrames,
    fps: job.fps,
    endpoint: job.endpoint,
    flowShift: job.flowShift ?? null,
    steps: job.steps ?? null,
    seed: job.seed ?? null,
  };
}

/**
 * Read-only attempt inspection for Plan: load this adapter's own job record for
 * the Source's attempt, reproduce the request facts from the Source + Assets, and
 * classify. No network, no upload, no lock, no write and no media read — a
 * resumable attempt is recognized even when a reference file or the Endpoint is
 * no longer readable.
 *
 * The authored projection and the identity/provenance checks are the same ones
 * the execution path enforces before a POST. They are compared HERE so a changed
 * attempt is refused before it is ever described as authorizable; execution still
 * re-derives the full frozen `requestHash` (which needs the encoded body) before
 * sending anything.
 */
export async function inspectVideoApiAttempt(
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
    label: 'Video API adapter',
    conflict: message => new VideoApiError(message),
  });
  const local = {
    artifactReady: await localBytesPresent(rootAbs, job?.artifactPath, job?.artifactSha256),
    originalReady: await localBytesPresent(rootAbs, job?.originalMediaPath, job?.originalMediaSha256),
  };
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  const changed: string[] = [];
  if (job !== null) {
    // The protocol the record ran, unless the current binding names another one:
    // a protocol change is itself part of the request identity.
    const protocol = (options.endpoint?.protocol ?? job.protocol) as VideoServiceProtocol;
    if (
      (options.referenceLocators !== undefined || options.endpoint !== undefined || options.testOnly !== undefined) &&
      job.locatorHash !== referenceLocatorIdentity(source, options, protocol)
    )
      changed.push('reference locators');
    const extensionHash = await generationExtensionIdentity({
      extension: resolveEffectiveExtension(source.model, protocol, options),
      modelSettings: options.endpoint?.modelSettings,
    }).catch(() => undefined);
    changed.push(
      ...attemptIdentityChanges({
        job,
        ...(extensionHash !== undefined ? { extensionHash } : {}),
        ...(options.endpoint !== undefined ? { endpointHash: endpointIdentityForConfig(source, options) } : {}),
        ...(options.endpoint !== undefined || options.testOnly !== undefined
          ? {
              provenance: {
                simulated:
                  Boolean(options.testOnly) ||
                  source.references.some(reference => byId.get(reference.asset)?.simulated === true),
                backend: `${selectedProtocol(options).id}/${source.model}`,
              },
            }
          : {}),
      }),
      ...changedFields(
        planRequestFacts(source, id => byId.get(id)?.sha256 ?? null),
        recordedRequestFacts(job),
      ),
    );
  }
  return attemptInspection({
    attempt,
    jobFile: jobFileRel,
    record: job === null ? null : attemptRecordFacts(job),
    local,
    wouldUpload: transmittedReferences('vllm-omni-video', source.references ?? []).map(reference => reference.asset),
    changed,
  });
}

/**
 * The CURRENT routing identity of this Source's Endpoint, or `undefined` when the
 * binding cannot be resolved (no base URL). The local-restore path then falls back
 * to the recorded authored fields instead of inventing a service identity.
 */
function referenceLocatorIdentity(
  source: ProviderSource,
  options: VideoApiOptions,
  protocol: VideoServiceProtocol,
): string {
  // Persist only a digest: signed/private locator URLs must not enter job records.
  return stableHash(
    transmittedReferences(protocol, source.references).map(reference => [
      reference.asset,
      options.referenceLocators?.[reference.asset] ?? null,
    ]),
  );
}

function endpointIdentityForConfig(source: ProviderSource, options: VideoApiOptions): string | undefined {
  try {
    const lane = resolveVideoLane(
      { endpoint: options.endpoint, testOnly: options.testOnly },
      source,
      'Video API adapter',
    );
    return endpointIdentityOf(lane, options.endpoint?.modelSettings, options.endpoint?.credential);
  } catch {
    return undefined;
  }
}
