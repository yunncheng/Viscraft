/**
 * `generate-image`: the standalone Runtime operation that produces an image
 * Asset from a generation/editing request.
 *
 * This is deliberately NOT a Source: it never appears on the timeline, produces
 * no Take and needs neither a video Placement nor a Build. It submits the request
 * through the vllm-omni-image adapter (which owns the per-attempt lock, the frozen
 * request record persisted BEFORE the network call, and the retained provider
 * original under `.viscraft/provider-media/`) and registers the returned image as
 * an author-area Asset.
 *
 * E1 — request preflight and execution agree. `preflightGenerateImage` and
 * `generateImage` share ONE judgement: the frozen request identity (from
 * `prepareImageRequest`), the persisted attempt state, and the target Asset id
 * are classified by the single `classifyGenerateImage` below. A knowable target
 * conflict is therefore refused BEFORE any POST in both paths:
 *
 *  - the read-only `--check` resolves config, validates the model/reference rules,
 *    checks authorization/credential readiness, verifies reference existence +
 *    hash, and reports the action — writing nothing, locking nothing, and sending
 *    nothing;
 *  - execution re-runs the SAME classification against a freshly loaded Project
 *    immediately before submitting, and the adapter additionally re-checks the
 *    target id at the last moment before the network call (via the
 *    `assertSubmitAllowed` guard) — so execution never merely trusts an earlier
 *    preflight;
 *  - an occupied target id with NO matching success record is blocked before
 *    submission; bytes are never generated first in the hope that they happen to
 *    match. A matching success record with identical content verifies the target
 *    type, its actual bytes/hash and the recorded output and legally returns the
 *    existing Asset for identical content (a local reuse, never a new spend).
 *
 * State table (attempt state / target → action):
 *
 *  | persisted attempt state              | target                       | action            |
 *  |--------------------------------------|------------------------------|-------------------|
 *  | none, or legal `created` (never sent)| absent                       | `submit`          |
 *  | none, or legal `created` (never sent)| occupied                     | `blocked` target-occupied |
 *  | `succeeded` (matching request)       | occupied, identical content  | `return-existing` |
 *  | `succeeded` (matching request)       | occupied, different/corrupt  | `blocked` asset-conflict / target-bytes-mismatch |
 *  | `succeeded` (matching request)       | absent, original intact      | `resume-registration` |
 *  | `succeeded` (matching request)       | absent, original damaged     | `blocked` original-corrupt |
 *  | any record whose request hash differs| (either)                     | `blocked` request-changed |
 *  | `failed`                             | (either)                     | `blocked` attempt-failed |
 *  | `submit-unknown`                     | (either)                     | `blocked` submit-unknown |
 *  | `submitting` (interrupted)           | (either)                     | `blocked` attempt-interrupted |
 *
 * A request-hash mismatch is reported FIRST as `blocked` and is never masked by a
 * same-content branch. `failed`, `submit-unknown` and an interrupted `submitting`
 * are never described as submittable or resumable.
 *
 * Other guarantees:
 *  - the frozen request record + per-attempt idempotency key are persisted BEFORE
 *    submission; an ambiguous submit is never resubmitted; a succeeded attempt is
 *    re-materialized from the retained original without a second generation;
 *  - a succeeded request interrupted before registration is completed on a re-run
 *    (the SAME request) from the persisted success record + retained original, and
 *    a repeated execution of a succeeded request returns the SAME Asset. The
 *    request hash deliberately does NOT cover the registration target id or
 *    rights, so the same succeeded request may complete registration against a
 *    free target id (or re-register with different rights) without triggering a
 *    new inference; the applicable rights are validated by the schema and the
 *    `simulated` taint is propagated along the lineage;
 *  - registration takes the `author` lock + an optimistic revision check and is
 *    NEVER performed while inference runs; parallel edits are retried against the
 *    fresh revision and never overwritten; an existing target Asset id with
 *    DIFFERENT content is refused loudly (the user resolves it) and the succeeded
 *    original + record are retained for safe recovery.
 *
 * Registration reuses `importAsset` (the shared asset-registration path):
 * `assets/<assetId>-<sha256>.png` is a legal author path, the produced bytes are
 * validated as a real image, `simulated` is tainted along the lineage, and the
 * Project is written atomically.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  GenerateImageRequestSchema,
  type Asset,
  type GenerateImageRequest,
  type GenerateImageRequestInput,
  type ImageGeneration,
  type Project,
} from '../../core/schema.js';
import { detectImageMime } from '../../backends/providers/services/vllm-omni/image.js';
import {
  generateImageApi,
  preflightImageRequest,
  type ImageApiOptions,
  type ImageRequestPreflight,
  type ImageRequestRecordSummary,
} from '../../backends/providers/services/vllm-omni/image-api.js';
import { normalizeLoopbackOrigin, normalizeProductionBase } from '../../backends/providers/lane.js';
import { credentialSetupHint, credentialSource } from '../../config/credentials.js';
import { userEndpointsFile, withUserEndpoints } from '../../config/endpoints.js';
import { resolveProjectPath } from '../../shared/fs.js';
import { stableHash } from '../../shared/hash.js';
import { loadProject } from '../../project/project.js';
import { importAsset } from './import.js';

/** The provider configuration a `generate-image` call reads (never credentials). */
export interface GenerateImageOptions {
  providers?: { imageApi?: Record<string, ImageApiOptions> };
}

export interface GenerateImageIssue {
  level: 'blocked' | 'needs_configuration' | 'requires_approval';
  /** A stable, machine-readable reason code (never localized text). */
  code: string;
  message: string;
  subject?: string;
}

/** What a submission would do next. `blocked` covers every non-submittable state. */
export type GenerateImageAction = 'submit' | 'return-existing' | 'resume-registration' | 'blocked';

/** The read-only `generate-image --check` report. Nothing is submitted or written. */
export interface GenerateImagePreflight {
  kind: 'generate-image-preflight';
  ok: boolean;
  request: {
    id: string;
    attempt: number;
    asset: string;
    operation: 'generate' | 'edit';
    endpoint: string;
    model: string;
  };
  /** The frozen request hash a submission would persist, when computable. */
  requestHash?: string;
  /** The target Asset's current registration state. */
  target: { asset: string; exists: boolean; sameContent: boolean | null };
  /** Whether a persisted attempt record matches the current request hash. */
  requestUnchanged: boolean | null;
  /** The persisted attempt record for `(id, attempt)`, when one exists. */
  record: ImageRequestPreflight['record'];
  /** What a submission would do next. */
  action: GenerateImageAction;
  issues: GenerateImageIssue[];
}

/** A `generate-image` success: the registered Asset + the request/provenance record. */
export interface GenerateImageResult {
  asset: Asset;
  /** Portable provenance (provider/model, request hash, parent-asset hashes, simulated). */
  generation: ImageGeneration;
  /** The frozen request record: id, attempt, request hash, its state and paths. */
  request: {
    id: string;
    attempt: number;
    hash: string;
    simulated: boolean;
    /** The persisted request record (`.viscraft/jobs/image-api/<id>.<attempt>.json`). */
    record: string;
    /** The retained provider original the record points at. */
    originalPath: string;
    originalSha256: string;
  };
}

const JOB_RECORD_DIR = '.viscraft/jobs/image-api';

function endpointHint(endpoint: string): string {
  return `add it to the user's image endpoints in ${userEndpointsFile()} (\`viscraft auth status\` shows what is configured), or pass providers.imageApi["${endpoint}"].endpoint`;
}

/** Resolve the reference Assets the request names from the Project (existence + type). */
function referenceAssets(
  root: string,
  project: Project,
  request: GenerateImageRequest,
): Array<{ asset: Asset; root: string }> {
  return request.references.map(reference => {
    const asset = project.assets.find(candidate => candidate.id === reference.asset);
    if (!asset)
      throw new Error(
        `Image request ${request.id} references Asset ${reference.asset} (role ${reference.role}), which does not exist in this Project`,
      );
    if (asset.type !== 'image')
      throw new Error(
        `Image request ${request.id} references ${asset.type} Asset ${reference.asset}; the vllm-omni-image protocol transmits image references only`,
      );
    return { asset, root };
  });
}

/**
 * The shared judgement of the preflight and the execution. Resolves the frozen
 * request identity through the adapter's read-only `preflightImageRequest`,
 * classifies the persisted attempt state, checks the target Asset id, and decides
 * the next action. Pure/read-only: no POST, no job/lock write, no retained media.
 *
 * `priorIssues` carries reasons the caller already found (config/authorization);
 * they are used only to avoid reporting the same authorization failure twice.
 */
async function classifyGenerateImage(input: {
  root: string;
  request: GenerateImageRequest;
  config: ImageApiOptions;
  project: Project | undefined;
  references: Array<{ asset: Asset; root: string }>;
  /** True when the endpoint resolves far enough to prepare the request identity. */
  transportResolvable: boolean;
  /** An error already found while resolving references (if any). */
  referenceError?: string;
  priorIssues: GenerateImageIssue[];
}): Promise<{
  requestHash?: string;
  requestUnchanged: boolean | null;
  record: ImageRequestRecordSummary | null;
  target: GenerateImagePreflight['target'];
  action: GenerateImageAction;
  issues: GenerateImageIssue[];
}> {
  const { root, request, config, project, references, transportResolvable, referenceError, priorIssues } = input;
  const issues: GenerateImageIssue[] = [];
  let requestHash: string | undefined;
  let requestUnchanged: boolean | null = null;
  let record: ImageRequestRecordSummary | null = null;

  if (transportResolvable && !referenceError && project && references.length === request.references.length) {
    try {
      const prepared = await preflightImageRequest(root, request, { ...config, references });
      requestHash = prepared.requestHash;
      requestUnchanged = prepared.requestUnchanged;
      record = prepared.record;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const alreadyReportedAuthorization =
        priorIssues.some(issue => issue.code === 'image-submit-not-authorized') && /authorization/i.test(message);
      if (!alreadyReportedAuthorization)
        issues.push({
          level: 'blocked',
          code: 'request-invalid',
          message: `Image request ${request.id} is invalid for model ${request.model}: ${message}`,
        });
    }
  }

  // Target Asset classification. `sameContent` is only meaningful when a
  // matching success record proves what the request should produce.
  const target: GenerateImagePreflight['target'] = { asset: request.asset, exists: false, sameContent: null };
  let conflictCode: string | undefined;
  let conflictMessage: string | undefined;
  if (project) {
    const existing = project.assets.find(asset => asset.id === request.asset);
    if (existing) {
      target.exists = true;
      const success =
        record && record.state === 'succeeded' && record.outputSha256 !== undefined && requestUnchanged === true
          ? { attempt: record.attempt, outputSha256: record.outputSha256, requestHash: record.requestHash }
          : undefined;
      if (success) {
        const recordedSha = success.outputSha256;
        if (existing.type !== 'image') {
          target.sameContent = false;
          conflictCode = 'asset-conflict';
          conflictMessage = `Asset ${request.asset} already exists as a ${existing.type} Asset, not the image recorded by attempt ${success.attempt}; choose a new asset id.`;
        } else if (existing.sha256 !== recordedSha) {
          target.sameContent = false;
          conflictCode = 'asset-conflict';
          conflictMessage = `Asset ${request.asset} already exists with content ${existing.sha256.slice(0, 12)}… different from attempt ${success.attempt}'s recorded output ${recordedSha.slice(0, 12)}…; resolve the conflict (choose a new asset id) before re-running.`;
        } else if (!(await fileMatchesHash(root, existing.path, existing.sha256))) {
          target.sameContent = false;
          conflictCode = 'target-bytes-mismatch';
          conflictMessage = `Asset ${request.asset} exists but its bytes no longer match its recorded sha256; the target is corrupt — re-import it or choose a new asset id before re-running.`;
        } else if (existing.imageGeneration?.requestHash !== success.requestHash) {
          // Identical bytes are NOT by themselves the same production source: two
          // different requests can happen to produce the same image. The recorded
          // generation provenance must also match (exactly what the registration
          // step in `registerGeneratedImage` requires), otherwise this is a
          // different occurrence and must not be reported as reusable.
          target.sameContent = false;
          conflictCode = 'asset-conflict';
          conflictMessage = `Asset ${request.asset} exists with the recorded bytes but a different recorded image-generation provenance (its request hash does not match attempt ${success.attempt}); identical bytes from a different request are not the same production source. Register this request under a new asset id.`;
        } else {
          target.sameContent = true;
        }
      }
    }
  }

  const block = (code: string, message: string): void => {
    issues.push({ level: 'blocked', code, message, subject: request.asset });
  };

  let action: GenerateImageAction = 'blocked';
  if (requestUnchanged === false) {
    // A changed request never reuses an old attempt and is never masked by a
    // same-content-target branch.
    block(
      'request-changed',
      `Request ${request.id} attempt ${request.attempt} is already bound to a different frozen request (its persisted request hash differs from the current request). Create a new attempt id instead of reusing this one with changed parameters.`,
    );
  } else if (record && record.state === 'succeeded') {
    if (target.exists) {
      if (target.sameContent === true) {
        if (await retainedOriginalIntact(root, record)) action = 'return-existing';
        else
          block(
            'original-corrupt',
            `Attempt ${record.attempt} succeeded and its target Asset ${request.asset} matches, but the retained provider original is missing or damaged; it is not returned or resubmitted. Create a new attempt id if a fresh generation is required.`,
          );
      } else {
        block(
          conflictCode ?? 'asset-conflict',
          conflictMessage ??
            `Asset ${request.asset} already exists with content different from attempt ${record.attempt}'s recorded output; resolve the conflict (choose a new asset id) before re-running.`,
        );
      }
    } else if (await retainedOriginalIntact(root, record)) {
      action = 'resume-registration';
    } else {
      block(
        'original-corrupt',
        `Attempt ${record.attempt} succeeded but its retained provider original is missing or damaged; registration cannot be resumed from it and it will not be resubmitted. Create a new attempt id if a fresh generation is required.`,
      );
    }
  } else if (record && record.state === 'failed') {
    block(
      'attempt-failed',
      `Attempt ${record.attempt} previously reached a permanent provider failure; it is not submittable and is not resumable. Create a new attempt id to retry.`,
    );
  } else if (record && record.state === 'submit-unknown') {
    block(
      'submit-unknown',
      `Attempt ${record.attempt} has an unknown submit outcome; the adapter will not resubmit (there is no verified idempotency lookup) and it is not resumable. Create a new attempt id if the original produced nothing.`,
    );
  } else if (record && record.state === 'submitting') {
    block(
      'attempt-interrupted',
      `Attempt ${record.attempt} was interrupted during submit; its outcome is unknown and it is neither submittable nor resumable. Create a new attempt id.`,
    );
  } else if (target.exists) {
    // No record, or a legal `created` record never sent, but the target id is
    // already occupied: refuse before submitting rather than generating first.
    block(
      'target-occupied',
      `Asset ${request.asset} already exists and there is no matching success record for request ${request.id} attempt ${request.attempt}; refusing to submit. Choose a new asset id, or recover the existing attempt's record first.`,
    );
  } else if (requestHash !== undefined) {
    action = 'submit';
  }

  return {
    ...(requestHash !== undefined ? { requestHash } : {}),
    requestUnchanged,
    record,
    target,
    action,
    issues,
  };
}

/** True when the file at `relative` exists inside `root` and hashes to `expected`. */
async function fileMatchesHash(root: string, relative: string, expected: string): Promise<boolean> {
  try {
    const abs = await resolveProjectPath(root, relative);
    return (
      createHash('sha256')
        .update(await readFile(abs))
        .digest('hex') === expected
    );
  } catch {
    return false;
  }
}

/** True when a succeeded attempt's retained provider original is present and intact. */
async function retainedOriginalIntact(root: string, record: ImageRequestRecordSummary | null): Promise<boolean> {
  if (!record?.outputPath || !record.outputSha256) return false;
  return fileMatchesHash(root, record.outputPath, record.outputSha256);
}

/**
 * Collect the endpoint/authorization/credential issues a submission would face
 * and report whether the endpoint resolves far enough to prepare an identity.
 * Mirrors the adapter's own gates so the preflight and the execution agree.
 */
function assessEndpoint(config: ImageApiOptions, request: GenerateImageRequest, issues: GenerateImageIssue[]): boolean {
  if (config.testOnly) {
    try {
      normalizeLoopbackOrigin(config.testOnly.baseUrl, 'Image preflight', false);
      return true;
    } catch (error) {
      issues.push({
        level: 'blocked',
        code: 'image-endpoint-invalid',
        message: `Image request ${request.id}: ${error instanceof Error ? error.message : String(error)}`,
      });
      return false;
    }
  }
  if (!config.endpoint) {
    issues.push({
      level: 'needs_configuration',
      code: 'image-endpoint-not-configured',
      message: `Image request ${request.id} binds endpoint "${request.endpoint}", which is not configured; ${endpointHint(request.endpoint)}.`,
    });
    return false;
  }
  try {
    normalizeProductionBase(config.endpoint.baseUrl, 'Image preflight');
  } catch (error) {
    issues.push({
      level: 'blocked',
      code: 'image-endpoint-invalid',
      message: `Image request ${request.id}: ${error instanceof Error ? error.message : String(error)}`,
    });
    return false;
  }
  const credential = config.endpoint.credential;
  if (credential && credentialSource(credential) === 'missing')
    issues.push({
      level: 'needs_configuration',
      code: 'image-credential-missing',
      message: `Image request ${request.id} endpoint "${request.endpoint}" needs credential ${credential}, which is neither in the environment nor stored: ${credentialSetupHint(credential)}.`,
    });
  else if (config.authorization?.submit !== true)
    issues.push({
      level: 'requires_approval',
      code: 'image-submit-not-authorized',
      message: `Image request ${request.id} is not authorized for submission; set providers.imageApi["${request.endpoint}"].authorization.submit = true only after the user approves the spend.`,
    });
  else {
    const missing = [...new Set(request.references.map(reference => reference.asset))].filter(
      id => !config.authorization?.uploadAssets?.includes(id),
    );
    if (missing.length > 0)
      issues.push({
        level: 'requires_approval',
        code: 'image-upload-not-authorized',
        message: `Image request ${request.id} would transmit reference Asset(s) ${missing.join(', ')} to the selected service; add each to providers.imageApi["${request.endpoint}"].authorization.uploadAssets to grant per-Asset transmission consent.`,
      });
  }
  return true;
}

/** Reason codes that describe a spend/transmission and are irrelevant to a local reuse. */
const SPEND_CODES = new Set(['image-submit-not-authorized', 'image-upload-not-authorized', 'image-credential-missing']);

/**
 * Read-only preflight. Resolves config, validates the model/reference rules,
 * checks authorization/credential readiness, verifies reference existence, checks
 * the target Asset id and classifies the persisted attempt state. Performs NO
 * submission, NO job/lock write and NO network.
 */
export async function preflightGenerateImage(
  root: string,
  request: GenerateImageRequestInput,
  options: GenerateImageOptions = {},
): Promise<GenerateImagePreflight> {
  const merged = withUserEndpoints(options);
  const parsed = GenerateImageRequestSchema.safeParse(request);
  if (!parsed.success) {
    const raw = request as Partial<GenerateImageRequest>;
    return {
      kind: 'generate-image-preflight',
      ok: false,
      request: {
        id: String(raw.id ?? ''),
        attempt: Number(raw.attempt ?? 0),
        asset: String(raw.asset ?? ''),
        operation: raw.operation === 'edit' ? 'edit' : 'generate',
        endpoint: String(raw.endpoint ?? ''),
        model: String(raw.model ?? ''),
      },
      target: { asset: String(raw.asset ?? ''), exists: false, sameContent: null },
      requestUnchanged: null,
      record: null,
      action: 'blocked',
      issues: [
        {
          level: 'blocked',
          code: 'request-invalid',
          message: `The request does not satisfy GenerateImageRequestSchema: ${parsed.error.issues
            .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
            .join('; ')}`,
        },
      ],
    };
  }
  const req = parsed.data;
  const config = merged.providers?.imageApi?.[req.endpoint] ?? {};
  const priorIssues: GenerateImageIssue[] = [];

  let project: Project | undefined;
  try {
    project = await loadProject(root);
  } catch (error) {
    priorIssues.push({
      level: 'blocked',
      code: 'project-unreadable',
      message: `Cannot read the Project at ${root}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  let references: Array<{ asset: Asset; root: string }> = [];
  let referenceError: string | undefined;
  if (project) {
    try {
      references = referenceAssets(root, project, req);
    } catch (error) {
      referenceError = error instanceof Error ? error.message : String(error);
      priorIssues.push({ level: 'blocked', code: 'reference-invalid', message: referenceError });
    }
  }

  const transportResolvable = assessEndpoint(config, req, priorIssues);
  const plan = await classifyGenerateImage({
    root,
    request: req,
    config,
    project,
    references,
    transportResolvable,
    ...(referenceError !== undefined ? { referenceError } : {}),
    priorIssues,
  });

  // A legal local reuse (return-existing / resume-registration) performs no POST,
  // so spend/transmission reasons are not reported for it.
  const reuse = plan.action === 'return-existing' || plan.action === 'resume-registration';
  const issues = [...priorIssues.filter(issue => !(reuse && SPEND_CODES.has(issue.code))), ...plan.issues];
  const ok = issues.length === 0;
  return {
    kind: 'generate-image-preflight',
    ok,
    request: {
      id: req.id,
      attempt: req.attempt,
      asset: req.asset,
      operation: req.operation,
      endpoint: req.endpoint,
      model: req.model,
    },
    ...(plan.requestHash !== undefined ? { requestHash: plan.requestHash } : {}),
    target: plan.target,
    requestUnchanged: plan.requestUnchanged,
    record: plan.record,
    action: ok ? plan.action : 'blocked',
    issues,
  };
}

/**
 * Submit an image request and register the returned image as an author-area
 * Asset. The shared classification is re-run against a freshly loaded Project
 * immediately before submission; a knowable target conflict or a non-submittable
 * attempt state is refused with no POST. See the module header for the full
 * state table and the exact guarantees.
 */
export async function generateImage(
  root: string,
  request: GenerateImageRequestInput,
  options: GenerateImageOptions = {},
): Promise<GenerateImageResult> {
  const merged = withUserEndpoints(options);
  const parsed = GenerateImageRequestSchema.parse(request);
  const config = merged.providers?.imageApi?.[parsed.endpoint] ?? {};
  const project = await loadProject(root);
  const references = referenceAssets(root, project, parsed);

  // Execution re-checks the SAME classification (fresh Project + attempt state +
  // target) right before submitting; it does not merely trust an earlier preflight.
  const plan = await classifyGenerateImage({
    root,
    request: parsed,
    config,
    project,
    references,
    transportResolvable: true,
    priorIssues: [],
  });
  const decisive = plan.issues.find(issue => issue.level === 'blocked');
  if (decisive)
    throw new Error(
      `generate-image ${parsed.id} attempt ${parsed.attempt} blocked (${decisive.code}): ${decisive.message}`,
    );

  // The adapter re-checks the knowable target conflict at the last moment before
  // the network call, so an occupation that appeared between the classification
  // and the POST is still refused without spending.
  const assertSubmitAllowed =
    plan.action === 'submit'
      ? async (): Promise<void> => {
          const fresh = await loadProject(root);
          if (fresh.assets.some(asset => asset.id === parsed.asset))
            throw new Error(
              `generate-image ${parsed.id} attempt ${parsed.attempt} blocked (target-occupied): Asset ${parsed.asset} was registered after the pre-submit check; refusing to submit. Choose a new asset id, or recover the existing attempt's record first.`,
            );
        }
      : undefined;

  const destinationRel = `.viscraft/scratch/generate-image-${parsed.id}.${parsed.attempt}/image`;
  const result = await generateImageApi(root, parsed, destinationRel, {
    ...config,
    references,
    ...(assertSubmitAllowed ? { assertSubmitAllowed } : {}),
  });
  const bytes = await readFile(await resolveProjectPath(root, destinationRel));
  const mime = detectImageMime(bytes);
  if (!mime) throw new Error(`Image provider returned an unusable container (not PNG/JPEG) for request ${parsed.id}`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const extension = mime === 'image/png' ? '.png' : '.jpg';

  const record = {
    id: parsed.id,
    attempt: parsed.attempt,
    hash: result.generation.requestHash,
    simulated: result.generation.simulated,
    record: `${JOB_RECORD_DIR}/${parsed.id}.${parsed.attempt}.json`,
    originalPath: `.viscraft/provider-media/image-api-${parsed.id}.${parsed.attempt}.${mime === 'image/png' ? 'png' : 'jpg'}`,
    originalSha256: result.generation.outputSha256,
  };
  const inputs = frozenInputs(result.inputs);
  const asset = await registerGeneratedImage(root, parsed, bytes, extension, sha256, result.generation, inputs);
  return { asset, generation: result.generation, request: record };
}

/**
 * Collapse the adapter's ordered, frozen production inputs into the Asset's
 * parent SET: one relation per distinct parent Asset, in first-reference order.
 * A request may reference the same parent in several roles; the ordered roles
 * stay on `ImageGeneration.references` (so no real relation is lost), while the
 * parent set never duplicates a relation or double-counts it.
 */
function frozenInputs(
  references: Array<{
    asset: string;
    revision: number;
    sha256: string;
    role: GenerateImageRequest['references'][number]['role'];
  }>,
): NonNullable<Asset['inputs']> {
  const seen = new Set<string>();
  const inputs: NonNullable<Asset['inputs']> = [];
  for (const reference of references) {
    if (seen.has(reference.asset)) continue;
    seen.add(reference.asset);
    inputs.push({
      asset: reference.asset,
      revision: reference.revision,
      sha256: reference.sha256,
      role: reference.role,
    });
  }
  return inputs;
}

/**
 * Register the produced image bytes as the target author-area Asset. Reuses
 * `importAsset` (author lock, atomic Project write, real media validation, taint
 * propagation) and persists the hash-only `imageGeneration` provenance together
 * with the frozen parent relations. A registration that races a parallel edit is
 * retried against the fresh revision; an existing target id is returned only when
 * it holds the SAME bytes AND the SAME production provenance.
 *
 * `assertAssetImageGeneration` (run inside `importAsset`) verifies that the
 * recorded output hash IS the imported bytes, the simulated marker agrees, and
 * the ordered references agree with the parent relations, and it is re-applied by
 * `validateProject` on every load/export/archive/restore. The succeeded original
 * + record are already retained, so the SAME request can be re-run against a free
 * target id.
 */
async function registerGeneratedImage(
  root: string,
  request: GenerateImageRequest,
  bytes: Buffer,
  extension: string,
  sha256: string,
  generation: ImageGeneration,
  inputs: NonNullable<Asset['inputs']>,
): Promise<Asset> {
  const staging = await mkdtemp(path.join(os.tmpdir(), `viscraft-generate-image-${request.id}-`));
  try {
    const staged = path.join(staging, `image${extension}`);
    await writeFile(staged, bytes);
    for (let attempt = 0; attempt < 5; attempt++) {
      const fresh = await loadProject(root);
      const existing = fresh.assets.find(asset => asset.id === request.asset);
      if (existing) {
        if (existing.type === 'image' && existing.sha256 === sha256) {
          // Identical bytes are NOT by themselves the same production source: two
          // different requests can happen to produce the same image. Only an
          // identical recorded provenance is the same occurrence; otherwise the
          // existing Asset and its provenance are left untouched and the caller
          // registers this request under a new id.
          if (stableHash(existing.imageGeneration ?? null) === stableHash(generation)) return existing;
          throw new Error(
            `Asset ${request.asset} already exists with the produced bytes but a different recorded generation provenance; identical bytes from a different request are not the same production source. Register this request under a new asset id.`,
          );
        }
        throw new Error(
          `Asset ${request.asset} already exists with different content (recorded ${existing.sha256.slice(0, 12)}…, produced ${sha256.slice(0, 12)}…); registration refused. The succeeded original and record are retained — re-run the SAME request with a free target asset id to complete registration.`,
        );
      }
      try {
        return await importAsset(root, {
          assetId: request.asset,
          sourcePath: staged,
          type: 'image',
          rights: request.rights,
          expectedRevision: fresh.revision,
          simulated: generation.simulated,
          imageGeneration: generation,
          ...(inputs.length ? { inputs } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A parallel author/registration edit bumped the revision or registered
        // this id first; retry against the fresh state instead of failing.
        if (attempt < 4 && /revision conflict|already exists/i.test(message)) continue;
        throw error;
      }
    }
    throw new Error(`Registration of Asset ${request.asset} did not converge after repeated revision conflicts`);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}
