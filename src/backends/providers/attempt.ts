/**
 * Read-only ATTEMPT inspection shared by Plan and every generation adapter.
 *
 * A generation adapter persists one job record per `(sourceId, attempt)` and
 * already owns the state machine that decides whether a later run may submit,
 * may only resume, or must refuse. Plan needs exactly the same answer BEFORE it
 * asks the host for spend/upload authorization — otherwise a resumed attempt is
 * reported as "not authorized" (asking the user to pay twice for a job that is
 * already running or already paid for), and a terminal failure is offered as an
 * authorizable retry.
 *
 * This module therefore owns the DECISION only:
 *  - it reads the adapter's own record (its schema, its states) through the
 *    caller;
 *  - it classifies the state into a verdict with the same meaning the adapter
 *    enforces at execution;
 *  - it performs no network call, no upload, no lock or write. To classify local
 *    recovery accurately, callers hash-check any recorded local result bytes.
 *
 * It is deliberately NOT a second job store, a second state table or an approval
 * ledger: the record stays the adapter's, and the verdict is derived from it.
 */
import type { ZodType } from 'zod';
import { resolveProjectPath } from '../../shared/fs.js';
import { hashFile } from '../../shared/hash.js';
import { loadJobRecord } from './job-store.js';

/** The persisted generation states shared by every adapter. */
export type AttemptState =
  | 'created'
  | 'submitting'
  | 'submit-unknown'
  | 'submitted'
  | 'remote-completed'
  | 'download-failed'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/** The fields the shared decision reads from any adapter's job record. */
export interface AttemptRecordFacts {
  state: AttemptState;
  simulated: boolean;
  submitted: number;
  taskId?: string | undefined;
  error?: string | undefined;
  artifactPath?: string | undefined;
  artifactSha256?: string | undefined;
  originalMediaPath?: string | undefined;
  originalMediaSha256?: string | undefined;
}

/**
 * What a Build would do next for this attempt:
 * - `new`            no submit has happened: a new submission (spend + upload
 *                    consent) is required; an existing `created` record is the
 *                    pre-submit marker and does not change that.
 * - `resume`         already sent (or already downloaded): continue the known
 *                    task. No new spend or upload consent; the service may still
 *                    need a credential.
 * - `complete`       succeeded and the project already holds the bytes: restore
 *                    locally. No service configuration, credential or consent.
 * - `mismatch`       the record is bound to a different frozen request: refuse;
 *                    the same attempt may never be reused for changed inputs.
 * - `indeterminate`  a submit may or may not have reached the service
 *                    (`submitting` / `submit-unknown`): never resubmit.
 * - `terminal`       failed/cancelled, or a success with no recoverable bytes:
 *                    never retried under the same attempt.
 */
export type AttemptVerdict = 'new' | 'resume' | 'complete' | 'mismatch' | 'indeterminate' | 'terminal';

export interface AttemptInspection {
  readonly attempt: string;
  /** Project-relative job record path (a fact for the message, never a write target). */
  readonly jobFile: string;
  readonly record: AttemptRecordFacts | null;
  readonly verdict: AttemptVerdict;
  /** True when a Build would send a NEW submit and therefore needs spend consent. */
  readonly wouldSubmit: boolean;
  /** The reference Assets a new submit would transmit (per-Asset upload scope). */
  readonly wouldUpload: readonly string[];
  /** True when the next step makes an authenticated request to the service. */
  readonly needsService: boolean;
  /** True when the project already holds the bytes the next step needs. */
  readonly localOnly: boolean;
  readonly reason: string;
}

/** Which hash-verified local bytes the project holds for a record. */
export interface AttemptLocalBytes {
  artifactReady: boolean;
  originalReady: boolean;
}

/** Whether a project-relative media path still contains the record's bytes. */
export async function localBytesPresent(
  rootAbs: string,
  rel: string | undefined,
  expectedSha256: string | undefined,
): Promise<boolean> {
  if (!rel || !expectedSha256) return false;
  try {
    const abs = await resolveProjectPath(rootAbs, rel);
    return (await hashFile(abs)) === expectedSha256;
  } catch {
    return false;
  }
}

/** Narrow an adapter's job record to the fields the shared decision reads. */
export function attemptRecordFacts(job: {
  state: string;
  simulated: boolean;
  submitted: number;
  taskId?: string | undefined;
  error?: string | undefined;
  artifactPath?: string | undefined;
  artifactSha256?: string | undefined;
  originalMediaPath?: string | undefined;
  originalMediaSha256?: string | undefined;
}): AttemptRecordFacts {
  return {
    state: job.state as AttemptState,
    simulated: job.simulated,
    submitted: job.submitted,
    ...(job.taskId !== undefined ? { taskId: job.taskId } : {}),
    ...(job.error !== undefined ? { error: job.error } : {}),
    ...(job.artifactPath !== undefined ? { artifactPath: job.artifactPath } : {}),
    ...(job.artifactSha256 !== undefined ? { artifactSha256: job.artifactSha256 } : {}),
    ...(job.originalMediaPath !== undefined ? { originalMediaPath: job.originalMediaPath } : {}),
    ...(job.originalMediaSha256 !== undefined ? { originalMediaSha256: job.originalMediaSha256 } : {}),
  };
}

/**
 * The ONE state → verdict rule. Every adapter's plan-side inspection calls this,
 * and each adapter's execution path already enforces the same outcomes; adding a
 * state here without the adapter agreeing would be a defect, so the mapping stays
 * exhaustive over {@link AttemptState}.
 */
export function classifyAttemptState(
  record: AttemptRecordFacts | null,
  local: AttemptLocalBytes,
): {
  verdict: AttemptVerdict;
  wouldSubmit: boolean;
  needsService: boolean;
  localOnly: boolean;
  reason: string;
} {
  if (record === null) {
    return {
      verdict: 'new',
      wouldSubmit: true,
      needsService: true,
      localOnly: false,
      reason: 'no record for this attempt: a Build would submit a new request',
    };
  }
  switch (record.state) {
    case 'created':
      return {
        verdict: 'new',
        wouldSubmit: true,
        needsService: true,
        localOnly: false,
        reason: 'the attempt has a frozen request but nothing was submitted yet',
      };
    case 'submitting':
      return {
        verdict: 'indeterminate',
        wouldSubmit: false,
        needsService: false,
        localOnly: false,
        reason:
          'a previous run was interrupted while submitting, so the service may already have accepted this request; it will not be resubmitted',
      };
    case 'submit-unknown':
      return {
        verdict: 'indeterminate',
        wouldSubmit: false,
        needsService: false,
        localOnly: false,
        reason:
          record.error === undefined
            ? 'the submit outcome is unknown; it will not be resubmitted'
            : `the submit outcome is unknown (${record.error}); it will not be resubmitted`,
      };
    case 'failed':
      return {
        verdict: 'terminal',
        wouldSubmit: false,
        needsService: false,
        localOnly: false,
        reason:
          record.error === undefined
            ? 'the provider rejected this request permanently'
            : `the provider rejected this request permanently: ${record.error}`,
      };
    case 'cancelled':
      return {
        verdict: 'terminal',
        wouldSubmit: false,
        needsService: false,
        localOnly: false,
        reason: 'this attempt was cancelled at the provider',
      };
    case 'submitted':
      return {
        verdict: 'resume',
        wouldSubmit: false,
        needsService: true,
        localOnly: false,
        reason:
          record.taskId === undefined
            ? 'a task was submitted and its result is still pending'
            : `task ${record.taskId} was submitted and its result is still pending`,
      };
    case 'remote-completed':
      return {
        verdict: 'resume',
        wouldSubmit: false,
        needsService: true,
        localOnly: false,
        reason: 'the provider finished the task; only the result download remains',
      };
    case 'download-failed':
      return local.originalReady
        ? {
            verdict: 'complete',
            wouldSubmit: false,
            needsService: false,
            localOnly: true,
            reason:
              'the provider media was retained locally before the download step failed; it is re-normalized without a new request',
          }
        : {
            verdict: 'resume',
            wouldSubmit: false,
            needsService: true,
            localOnly: false,
            reason: 'the result download failed; it is resumed from the known task without a new request',
          };
    case 'succeeded': {
      if (local.artifactReady)
        return {
          verdict: 'complete',
          wouldSubmit: false,
          needsService: false,
          localOnly: true,
          reason: 'this attempt already produced the Take and the project holds its bytes',
        };
      if (local.originalReady)
        return {
          verdict: 'complete',
          wouldSubmit: false,
          needsService: false,
          localOnly: true,
          reason: 'the retained provider original is present and is re-normalized into the Take without a new request',
        };
      if (record.taskId === undefined)
        return {
          verdict: 'terminal',
          wouldSubmit: false,
          needsService: false,
          localOnly: false,
          reason:
            'this attempt succeeded, but neither its Take nor its retained original exists and no task id is recorded to re-fetch it',
        };
      return {
        verdict: 'resume',
        wouldSubmit: false,
        needsService: true,
        localOnly: false,
        reason: `the result is complete at task ${record.taskId} but its bytes are missing locally; they are re-fetched without a new request`,
      };
    }
  }
}

/**
 * Build the inspection result from a loaded record. `wouldUpload` is the
 * declared transmitted-reference scope, which only matters for a NEW submit —
 * a resume never uploads again.
 *
 * The optional identity inputs are the same facts the record froze and that a
 * Source reproduces without reading media, a credential or a model definition:
 * the authored request projection, the implementation hash, the routing hash and
 * the provenance labels. Any divergence is a `mismatch`: the attempt belongs to
 * a DIFFERENT request and must never be treated as this Source's own recovery.
 * Execution re-verifies the full frozen request hash before any POST, so a fact
 * this read-only pass cannot see is still refused there.
 */
export function attemptInspection(input: {
  attempt: string;
  jobFile: string;
  record: AttemptRecordFacts | null;
  local: AttemptLocalBytes;
  wouldUpload: readonly string[];
  changed?: readonly string[] | undefined;
}): AttemptInspection {
  const base = classifyAttemptState(input.record, input.local);
  const changed = [...new Set(input.changed ?? [])].sort();
  const verdict = changed.length > 0 ? 'mismatch' : base.verdict;
  const reason =
    changed.length > 0
      ? `this attempt is bound to a different frozen request (${changed.join(', ')}); create a new attempt id instead of changing this one`
      : base.reason;
  return {
    attempt: input.attempt,
    jobFile: input.jobFile,
    record: input.record,
    verdict,
    wouldSubmit: verdict === 'new' ? base.wouldSubmit : false,
    wouldUpload: verdict === 'new' ? input.wouldUpload : [],
    needsService: verdict === 'mismatch' ? false : base.needsService,
    localOnly: verdict === 'complete' && base.localOnly,
    reason,
  };
}

/**
 * Compare the CURRENT Source facts with the ones the record froze, for the fields
 * a record stores and a Source reproduces without reading media, config or a
 * model definition. Returns the changed field names (empty = same request).
 *
 * This is the plan-side guard that refuses a changed request under a reused
 * attempt. Execution re-verifies the full frozen request hash before any POST, so
 * a field this comparison cannot see (an endpoint address, a mapping version) is
 * still refused there — it can never cause a duplicate submission.
 */
export function changedFields(
  current: Readonly<Record<string, unknown>>,
  stored: Readonly<Record<string, unknown>>,
  ignore: readonly string[] = [],
): string[] {
  const ignored = new Set(ignore);
  const keys = new Set([...Object.keys(current), ...Object.keys(stored)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (ignored.has(key)) continue;
    if (JSON.stringify(current[key] ?? null) !== JSON.stringify(stored[key] ?? null)) changed.push(key);
  }
  return changed.sort();
}

/** The extension identity a record froze, when the schema carries one. */
function jobExtensionHash(job: object): string | undefined {
  const value = (job as { extensionHash?: unknown }).extensionHash;
  return typeof value === 'string' ? value : undefined;
}

/** The routing identity a record froze (`endpointHash`, or fal's `queueHash`). */
function jobEndpointHash(job: object): string | undefined {
  const record = job as { endpointHash?: unknown; queueHash?: unknown };
  if (typeof record.endpointHash === 'string') return record.endpointHash;
  return typeof record.queueHash === 'string' ? record.queueHash : undefined;
}

/**
 * The identity facts a record froze that are NOT part of the authored request
 * projection: the implementation it ran, the service it ran against, and the
 * provenance labels it asserts. A Source reproduces them from the current code
 * and configuration, so a divergence means the record is not this request at
 * all — even when every authored field is unchanged.
 *
 * A `simulated` flag that disagrees with the current binding is the dangerous
 * case: a simulated Take must never be presented as a real result, and a real
 * record must never be relabelled as simulated.
 */
export function attemptIdentityChanges(input: {
  job: object;
  /** The current implementation hash, or `undefined` when it cannot be resolved. */
  extensionHash?: string | undefined;
  /** The current routing hash, or `undefined` when the binding cannot be resolved. */
  endpointHash?: string | undefined;
  provenance?: { simulated: boolean; backend?: string } | undefined;
}): string[] {
  const changed: string[] = [];
  if (input.extensionHash !== undefined && input.extensionHash !== jobExtensionHash(input.job))
    changed.push('extension');
  if (input.endpointHash !== undefined && input.endpointHash !== jobEndpointHash(input.job)) changed.push('endpoint');
  if (input.provenance !== undefined) {
    const record = input.job as { simulated?: unknown; backend?: unknown };
    if (record.simulated !== input.provenance.simulated) changed.push('simulated');
    // Only a binding that names its service can say which backend THIS request
    // would use. A local re-materialisation with no Endpoint configured keeps the
    // recorded backend (the artifact is already local), and the guessed default
    // must not be compared against it.
    if (input.provenance.backend !== undefined && record.backend !== input.provenance.backend) changed.push('backend');
  }
  return changed;
}

/** The minimum a job record needs to be restorable without any service call. */
export interface RestorableJob extends AttemptRecordFacts {
  output: unknown;
}

/**
 * Restore a SUCCEEDED attempt from bytes already in the project, before any
 * Endpoint resolution, credential lookup, reference read or network call.
 *
 * A completed Take is local data: re-materializing it must not require the
 * service that produced it (a machine without the Endpoint still holds the
 * result). The caller passes its own record loader/saver, so the record stays the
 * adapter's.
 *
 * Returns `undefined` when the attempt is not a locally restorable success; the
 * caller then continues with the normal resume/restore path.
 */
export async function restoreCompletedAttempt<Job extends RestorableJob, Result>(input: {
  jobFileAbs: string;
  attempt: string;
  rootAbs: string;
  destAbs: string;
  destRel: string;
  output: Job['output'];
  label: string;
  conflict: (message: string) => Error;
  load: (jobFile: string) => Promise<Job | null>;
  save: (jobFile: string, job: Job) => Promise<void>;
  patch: (job: Job, changes: Record<string, unknown>) => Job;
  materialize: (job: Job, rootAbs: string, destAbs: string) => Promise<{ sha256: string; media: unknown } | null>;
  result: (job: Job) => Result;
  /** The changed request fields, or [] when the record still matches the Source. */
  changedFieldsOf: (job: Job) => string[];
  /** Verify any still-present authored inputs before a local success restore. */
  validateCurrent?: (job: Job) => Promise<void>;
  /**
   * The effective definition/mapping identity for the CURRENT code, when it can
   * be resolved. A changed implementation is a different request even when every
   * authored field is unchanged, so a recorded hash that no longer matches must
   * refuse the restore rather than re-materialize as if nothing moved.
   */
  extensionHash?: string | undefined;
  /** The routing identity of the CURRENT Endpoint (protocol + base URL + wire model + settings). */
  endpointHash?: string | undefined;
  /**
   * The provenance the record must still assert: a record whose `simulated` flag
   * was tampered with is not this attempt's result, however unchanged the authored
   * fields look. `backend` is compared only when the CURRENT binding names the
   * service (see {@link attemptIdentityChanges}).
   */
  provenance?: { simulated: boolean; backend?: string } | undefined;
}): Promise<Result | undefined> {
  const job = await input.load(input.jobFileAbs);
  if (job === null || job.state !== 'succeeded') return undefined;
  const changed = [
    ...input.changedFieldsOf(job),
    ...attemptIdentityChanges({
      job,
      ...(input.extensionHash !== undefined ? { extensionHash: input.extensionHash } : {}),
      ...(input.endpointHash !== undefined ? { endpointHash: input.endpointHash } : {}),
      ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
    }),
  ];
  if (changed.length > 0)
    throw input.conflict(
      `${input.label}: attempt '${input.attempt}' is bound to a different frozen request (${changed.join(', ')}); create a new attempt id instead of changing this one`,
    );
  await input.validateCurrent?.(job);
  // A changed LOCAL output is not a changed remote request: adopt it first so the
  // materialization re-normalizes the retained original at the new settings
  // (reusing an artifact produced at the old settings would be wrong).
  const current =
    JSON.stringify(job.output) === JSON.stringify(input.output) ? job : input.patch(job, { output: input.output });
  const restored = await input.materialize(current, input.rootAbs, input.destAbs);
  if (restored === null) return undefined;
  const next = input.patch(current, {
    artifactPath: input.destRel,
    artifactSha256: restored.sha256,
    artifact: restored.media,
    artifactOutput: input.output,
  });
  await input.save(input.jobFileAbs, next);
  return input.result(next);
}

/**
 * Read one attempt record for the plan preflight through the SAME loader the
 * adapter uses at execution: the path is resolved with the project containment
 * rule, and a record that exists but does not validate is a hard error (never
 * "no record", which would look like a fresh, authorizable request).
 *
 * Read-only: no lock, no write, no network, no media read. A missing record
 * returns `null`.
 */
export async function readAttemptRecord<T>(input: {
  rootAbs: string;
  rel: string;
  schema: ZodType<T>;
  label: string;
  conflict: (message: string) => Error;
}): Promise<T | null> {
  const abs = await resolveProjectPath(input.rootAbs, input.rel);
  return loadJobRecord(abs, input.schema, input.label, input.conflict);
}
