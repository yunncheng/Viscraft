import { findSubtitleFont } from '../media/subtitles.js';
import { escapeFilterValue } from '../media/filter-escape.js';
/**
 * Simulated video Provider — development/test-only control-chain implementation.
 *
 * This is NOT a real generative model. It produces short, clearly-labelled
 * `SIMULATED TEST-ONLY` H.264 files with FFmpeg so that the normal
 * Run -> Operation/Build -> Take -> Edit -> Audio -> Artifact path can be
 * exercised end to end without a real (paid, external) provider.
 *
 * Contract highlights:
 *  - fixed duration tiers (2/4/6 s); frames are quantized from the requested
 *    frame count via the composition fps;
 *  - four deterministic behaviours: success | fail | submit-unknown |
 *    download-fail-once;
 *  - every attempt persists a frozen request + hash, idempotency key, submit
 *    counter and job id under `.viscraft/jobs/<attempt>.json` BEFORE submitting;
 *  - a submit whose outcome is unknown is never auto-resubmitted; it is
 *    reconciled through the provider's idempotency key (no second submit);
 *  - remote completion, media download and Take registration are distinct
 *    steps; a failed download is resumed without regenerating, and a lost
 *    artifact is re-materialized from the same remote job id (via the
 *    deterministic simulated backend) without a new submit;
 *  - job records never contain the raw prompt or any secret: only a prompt
 *    hash is stored. Reusing an attempt id with different parameters is
 *    rejected instead of silently overwriting the frozen request;
 *  - every project path is resolved through `resolveProjectPath` (no symlink
 *    traversal, no path escaping the project root); `artifactPath` is stored
 *    project-relative so an untrusted job record cannot point outside the root.
 */

import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { Id, MediaInfoSchema, OutputSchema } from '../../core/schema.js';
import type { Fps, MediaInfo, OutputSettings, SimulatedSource } from '../../core/schema.js';
import { resolveProjectPath } from '../../shared/fs.js';
import { hashFile, stableHash } from '../../shared/hash.js';
import { runCommand } from '../../shared/process.js';
import { loadJobRecord, saveJobRecord, patchJobRecord, attemptStem } from './job-store.js';
import { probeMedia } from '../media/probe.js';

const BACKEND = 'ffmpeg-simulated';
const JOB_SCHEMA_VERSION = 1;
const DURATION_TIERS = [2, 4, 6] as const;
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const JOBS_DIR_REL = '.viscraft/jobs';
const REMOTE_DIR_REL = '.viscraft/remote';

type Behavior = SimulatedSource['behavior'];

/**
 * Reported capabilities of the simulated provider. `simulated`/`testOnly` are
 * mandatory and must propagate into any Take/Artifact produced here; this must
 * never be advertised as a real generative provider.
 */
export const simulationCapabilities = {
  backend: BACKEND,
  simulated: true,
  testOnly: true,
  generativeModel: false,
  durationsSeconds: DURATION_TIERS,
  frameRate: 'from composition fps (quantized)',
  videoCodec: 'h264',
  pixFmt: 'yuv420p',
  behaviors: ['success', 'fail', 'submit-unknown', 'download-fail-once'] as const,
  supportsIdempotencyKeyLookup: true,
  note: 'Deterministic FFmpeg testsrc media for control-chain validation only. Not a real generative model; not valid evidence of real provider quality.',
} as const;

const jobStateSchema = z.enum([
  'created', // pre-submit record persisted, nothing sent yet
  'submitting', // pre-submit record persisted, submit in flight (crash here => submit-unknown)
  'submitted', // remote accepted, job id recorded
  'submit-unknown', // remote accepted but job id could not be recorded locally
  'remote-completed', // remote finished producing media
  'download-failed', // media download/verification failed after remote completion
  'succeeded',
  'failed',
]);

const jobSchema = z
  .object({
    schemaVersion: z.literal(JOB_SCHEMA_VERSION),
    backend: z.literal(BACKEND),
    simulated: z.literal(true),
    attempt: Id,
    sourceId: Id,
    behavior: z.enum(['success', 'fail', 'submit-unknown', 'download-fail-once']),
    // Frozen request identity. The raw prompt is intentionally NOT stored.
    requestHash: z.string().min(1),
    promptHash: z.string().min(1),
    seed: z.number().int().nonnegative(),
    requestedFrames: z.number().int().positive(),
    generatedFrames: z.number().int().positive(),
    tierSeconds: z.union([z.literal(2), z.literal(4), z.literal(6)]),
    output: OutputSchema,
    idempotencyKey: z.string().min(1),
    state: jobStateSchema,
    submitted: z.number().int().nonnegative(),
    jobId: z.string().min(1).optional(),
    // Project-relative; never absolute, so an untrusted record cannot escape the root.
    artifactPath: z.string().min(1).optional(),
    artifactSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    media: MediaInfoSchema.optional(),
    downloadAttempted: z.boolean().optional(),
    reconciled: z.boolean().optional(),
    error: z.string().min(1).optional(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();

export type SimulatedJob = z.infer<typeof jobSchema>;
export type SimulatedJobState = z.infer<typeof jobStateSchema>;

export class SimulatedProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimulatedProviderError';
  }
}

function now(): string {
  return new Date().toISOString();
}

/** Persist a state transition on an existing job record. */
function patchJob(job: SimulatedJob, changes: Partial<SimulatedJob>): SimulatedJob {
  return patchJobRecord(job, changes, now());
}

/** Convenience path of the persisted job record (Source-scoped stem). Callers
 * should still resolve safely. */
export function simulatedJobPath(root: string, sourceId: string, attempt: string): string {
  return join(resolve(root), JOBS_DIR_REL, `${attemptStem(Id.parse(sourceId), Id.parse(attempt))}.json`);
}

/** Smallest supported duration tier that covers the requested length, else the max tier. */
export function pickTierSeconds(frames: number, fps: Fps): (typeof DURATION_TIERS)[number] {
  const seconds = (frames * fps.denominator) / fps.numerator;
  for (const tier of DURATION_TIERS) if (tier >= seconds) return tier;
  return DURATION_TIERS[DURATION_TIERS.length - 1];
}

/** Quantize a tier duration to an integer frame count using the composition fps. */
export function quantizeFrames(tierSeconds: number, fps: Fps): number {
  return Math.max(1, Math.round((tierSeconds * fps.numerator) / fps.denominator));
}

function deterministicJobId(idempotencyKey: string): string {
  return `simjob_${stableHash(idempotencyKey).slice(0, 24)}`;
}

function fpsEqual(a: Fps, b: Fps): boolean {
  return a.numerator * b.denominator === b.numerator * a.denominator;
}

/** Require a usable, safe remote job id (guards against a tampered job record). */
function requireJobId(job: SimulatedJob): string {
  if (!job.jobId || !JOB_ID_PATTERN.test(job.jobId)) {
    throw new SimulatedProviderError(`Simulated provider: attempt '${job.attempt}' has no usable remote job id`);
  }
  return job.jobId;
}

/**
 * Resolve a caller destination into a project path. Absolute destinations are
 * first made relative to the (real) project root and rejected if they escape;
 * the result is validated and symlink-checked via `resolveProjectPath`.
 */
async function resolveDestination(rootAbs: string, destination: string): Promise<{ abs: string; rel: string }> {
  if (!destination || destination.includes('\0'))
    throw new SimulatedProviderError('Simulated provider: invalid destination path');
  let rel: string;
  if (isAbsolute(destination)) {
    const absolute = normalize(destination);
    const candidates = [rootAbs, await realpath(rootAbs)].map(base => relative(base, absolute).split(sep).join('/'));
    const inside = candidates.find(candidate => candidate && !candidate.startsWith('..') && !isAbsolute(candidate));
    if (!inside) throw new SimulatedProviderError('Simulated provider: destination escapes project root');
    rel = inside;
  } else {
    rel = destination;
  }
  const abs = await resolveProjectPath(rootAbs, rel);
  return { abs, rel };
}

/** Resolve a project-relative path within the root, rejecting symlinks / escaping. */
async function resolveInRoot(rootAbs: string, rel: string): Promise<string> {
  return resolveProjectPath(rootAbs, rel);
}

async function loadJob(jobFile: string): Promise<SimulatedJob | null> {
  return loadJobRecord(jobFile, jobSchema, 'Simulated provider', message => new SimulatedProviderError(message));
}

async function saveJob(jobFile: string, job: SimulatedJob): Promise<void> {
  await saveJobRecord(jobFile, job);
}

/** Render deterministic, clearly-labelled simulated media with FFmpeg (threads=2). */
async function renderMedia(outPath: string, job: SimulatedJob): Promise<void> {
  const { width, height, fps } = job.output;
  const rate = `${fps.numerator}/${fps.denominator}`;
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-threads',
    '2',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${width}x${height}:rate=${rate}:duration=${job.tierSeconds}`,
  ];
  const font = await findSubtitleFont()
    .then(value => escapeFilterValue(value.path))
    .catch(() => undefined);
  if (font) {
    const main = `SIMULATED TEST-ONLY  attempt=${job.attempt}  ${job.tierSeconds}s`;
    const sub = 'NOT A REAL GENERATIVE MODEL';
    const drawMain = `drawtext=fontfile=${font}:text='${main}':x=16:y=16:fontsize=26:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=10`;
    const drawSub = `drawtext=fontfile=${font}:text='${sub}':x=16:y=h-48:fontsize=22:fontcolor=yellow:box=1:boxcolor=black@0.65:boxborderw=8`;
    args.push('-vf', `${drawMain},${drawSub}`);
  }
  args.push(
    '-frames:v',
    String(job.generatedFrames),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-metadata',
    `comment=SIMULATED TEST-ONLY attempt=${job.attempt} tier=${job.tierSeconds}s`,
    outPath,
  );
  try {
    await runCommand('ffmpeg', args);
  } catch {
    throw new SimulatedProviderError(`Simulated provider: ffmpeg render failed for attempt '${job.attempt}'`);
  }
  if (!existsSync(outPath))
    throw new SimulatedProviderError(`Simulated provider: ffmpeg produced no output for attempt '${job.attempt}'`);
}

/** Copy a produced media file to its destination via a temp file + atomic rename. */
async function installMedia(srcPath: string, destAbs: string): Promise<void> {
  await mkdir(dirname(destAbs), { recursive: true });
  const tmp = `${destAbs}.viscraft-tmp-${process.pid}-${Date.now().toString(36)}`;
  await copyFile(srcPath, tmp);
  try {
    await rename(tmp, destAbs);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** Strict media match against the frozen request: codec, dimensions, frame count and fps. */
function mediaMatches(info: MediaInfo, job: SimulatedJob): boolean {
  return (
    /h264|avc/i.test(info.videoCodec) &&
    info.width === job.output.width &&
    info.height === job.output.height &&
    info.frames === job.generatedFrames &&
    fpsEqual(info.fps, job.output.fps)
  );
}

function assertUsableMedia(info: MediaInfo, job: SimulatedJob): void {
  if (!/h264|avc/i.test(info.videoCodec))
    throw new SimulatedProviderError(`Simulated provider: expected h264 media for attempt '${job.attempt}'`);
  if (info.width !== job.output.width || info.height !== job.output.height) {
    throw new SimulatedProviderError(
      `Simulated provider: media dimensions do not match output settings for attempt '${job.attempt}'`,
    );
  }
  if (info.frames !== job.generatedFrames) {
    throw new SimulatedProviderError(
      `Simulated provider: media frame count ${info.frames} != expected ${job.generatedFrames} for attempt '${job.attempt}'`,
    );
  }
  if (!fpsEqual(info.fps, job.output.fps)) {
    throw new SimulatedProviderError(
      `Simulated provider: media fps ${info.fps.numerator}/${info.fps.denominator} does not match output for attempt '${job.attempt}'`,
    );
  }
}

/**
 * Restore an already-produced artifact to a (possibly different) destination.
 * Requires a recorded hash and strict media match; a missing hash, hash
 * mismatch, undecodable media or wrong frames/fps is never a cache hit. The
 * stored `artifactPath` is project-relative and re-resolved safely, so a
 * tampered record cannot read outside the root.
 */
async function tryRestore(job: SimulatedJob, rootAbs: string, remotePath: string, destAbs: string): Promise<boolean> {
  if (!job.artifactSha256) return false;
  const candidates: string[] = [];
  if (existsSync(remotePath)) candidates.push(remotePath);
  if (job.artifactPath) {
    try {
      const artifactAbs = await resolveInRoot(rootAbs, job.artifactPath);
      if (existsSync(artifactAbs)) candidates.push(artifactAbs);
    } catch {
      // Invalid/untrusted artifact path: ignore it rather than reading outside the root.
    }
  }
  for (const candidate of candidates) {
    try {
      if ((await hashFile(candidate)) !== job.artifactSha256) continue;
      const info = await probeMedia(candidate);
      if (!mediaMatches(info, job)) continue;
    } catch {
      continue;
    }
    await installMedia(candidate, destAbs);
    return true;
  }
  return false;
}

/**
 * Produce (or recover) a simulated Take for a `simulated` Source.
 *
 * Re-entrant and idempotent per attempt: a succeeded job restores its existing
 * media to any destination (re-materializing from the same remote job id if the
 * artifact was lost — never a new submit); a failed job is never silently
 * resubmitted; an unknown submit is reconciled through the idempotency key
 * without a new submit; a failed download resumes without regenerating.
 */
export async function generateSimulated(
  root: string,
  source: SimulatedSource,
  output: OutputSettings,
  destination: string,
): Promise<{ backend: string }> {
  const validatedOutput = OutputSchema.parse(output);
  const attempt = Id.parse(source.attempt);
  if (!Number.isInteger(source.frames) || source.frames <= 0)
    throw new SimulatedProviderError(`Simulated provider: invalid frame count for attempt '${attempt}'`);
  const behavior: Behavior = source.behavior;

  const rootAbs = resolve(root);
  const jobsDir = await resolveInRoot(rootAbs, JOBS_DIR_REL);
  const remoteDir = await resolveInRoot(rootAbs, REMOTE_DIR_REL);
  const jobFile = await resolveInRoot(rootAbs, `${JOBS_DIR_REL}/${attemptStem(source.id, attempt)}.json`);
  const destinationPath = await resolveDestination(rootAbs, destination);
  const destAbs = destinationPath.abs;
  await mkdir(jobsDir, { recursive: true });
  await mkdir(remoteDir, { recursive: true });

  const promptHash = stableHash(source.prompt);
  const requestHash = stableHash({
    kind: 'simulated',
    id: source.id,
    promptHash,
    frames: source.frames,
    seed: source.seed,
    behavior,
    output: validatedOutput,
  });

  const tierSeconds = pickTierSeconds(source.frames, validatedOutput.fps);
  const generatedFrames = quantizeFrames(tierSeconds, validatedOutput.fps);

  let job: SimulatedJob | null = await loadJob(jobFile);
  if (job && job.requestHash !== requestHash) {
    throw new SimulatedProviderError(
      `Simulated provider: attempt '${attempt}' is already bound to a different frozen request; do not reuse an attempt id with changed parameters — create a new attempt.`,
    );
  }
  if (!job) {
    const idempotencyKey = `sim-${attempt}-${requestHash.slice(0, 16)}`;
    const fresh: SimulatedJob = {
      schemaVersion: JOB_SCHEMA_VERSION,
      backend: BACKEND,
      simulated: true,
      attempt,
      sourceId: Id.parse(source.id),
      behavior,
      requestHash,
      promptHash,
      seed: source.seed,
      requestedFrames: source.frames,
      generatedFrames,
      tierSeconds,
      output: validatedOutput,
      idempotencyKey,
      state: 'created',
      submitted: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    // Pre-submit attempt record, persisted before anything leaves this process.
    await saveJob(jobFile, fresh);
    job = fresh;
  }

  // Terminal: already succeeded -> restore the real media to the requested destination.
  if (job.state === 'succeeded') {
    const remotePath = await resolveInRoot(rootAbs, `${REMOTE_DIR_REL}/${requireJobId(job)}.mp4`);
    if (await tryRestore(job, rootAbs, remotePath, destAbs)) return { backend: BACKEND };
    // Artifact lost or invalid: re-materialize the same remote object (no new submit).
    job = patchJob(job, { state: 'remote-completed' });
    await saveJob(jobFile, job);
  }

  // Terminal: a real provider failure is not auto-retried under the same attempt.
  if (job.state === 'failed') {
    throw new SimulatedProviderError(
      `Simulated provider: attempt '${attempt}' previously reached a permanent failure; not resubmitting. Create a new attempt id to retry.`,
    );
  }

  // Submit (first time only). A submit-unknown is never resubmitted.
  if (job.state === 'created') {
    job = patchJob(job, { state: 'submitting', submitted: job.submitted + 1 });
    await saveJob(jobFile, job);

    if (job.behavior === 'fail') {
      job = patchJob(job, { state: 'failed', error: 'simulated provider failure' });
      await saveJob(jobFile, job);
      throw new SimulatedProviderError(
        `Simulated provider: generation failed for attempt '${attempt}' (behavior=fail).`,
      );
    }
    if (job.behavior === 'submit-unknown') {
      // Remote accepted but the response was lost before the job id could be recorded.
      job = patchJob(job, { state: 'submit-unknown', error: 'submit outcome unknown' });
      await saveJob(jobFile, job);
      throw new SimulatedProviderError(
        `Simulated provider: submit outcome for attempt '${attempt}' is unknown; not resubmitting. Re-run to reconcile via the idempotency key.`,
      );
    }
    job = patchJob(job, { state: 'submitted', jobId: deterministicJobId(job.idempotencyKey), error: undefined });
    await saveJob(jobFile, job);
  }

  // Reconcile an in-flight or unknown submit using the idempotency key (no new submit).
  if (job.state === 'submitting' || job.state === 'submit-unknown') {
    const found = { jobId: deterministicJobId(job.idempotencyKey) }; // local provider supports idempotency-key lookup
    job = patchJob(job, { state: 'submitted', jobId: found.jobId, reconciled: true, error: undefined });
    await saveJob(jobFile, job);
  }

  // Poll to remote completion and materialize the remote media object (re-using the same job id).
  if (job.state === 'submitted') {
    const remotePath = await resolveInRoot(rootAbs, `${REMOTE_DIR_REL}/${requireJobId(job)}.mp4`);
    if (!existsSync(remotePath)) await renderMedia(remotePath, job);
    job = patchJob(job, { state: 'remote-completed' });
    await saveJob(jobFile, job);
  }

  // Download + verify + register. Distinct from generation; a failure resumes here.
  if (job.state === 'remote-completed' || job.state === 'download-failed') {
    if (job.behavior === 'download-fail-once' && !job.downloadAttempted) {
      job = patchJob(job, { state: 'download-failed', downloadAttempted: true, error: 'simulated download failure' });
      await saveJob(jobFile, job);
      throw new SimulatedProviderError(
        `Simulated provider: download failed after remote completion for attempt '${attempt}'; re-run to resume the download (no resubmit).`,
      );
    }
    if (!job.downloadAttempted) {
      job = patchJob(job, { downloadAttempted: true });
      await saveJob(jobFile, job);
    }
    const remotePath = await resolveInRoot(rootAbs, `${REMOTE_DIR_REL}/${requireJobId(job)}.mp4`);
    if (!existsSync(remotePath)) await renderMedia(remotePath, job);
    const sha = await hashFile(remotePath);
    const info = await probeMedia(remotePath);
    assertUsableMedia(info, job);
    await installMedia(remotePath, destAbs);
    const media: MediaInfo = {
      frames: info.frames,
      fps: info.fps,
      width: info.width,
      height: info.height,
      duration: info.duration,
      videoCodec: info.videoCodec,
      ...(info.audio ? { audio: info.audio } : {}),
    };
    job = patchJob(job, {
      state: 'succeeded',
      artifactPath: destinationPath.rel,
      artifactSha256: sha,
      media,
      error: undefined,
    });
    await saveJob(jobFile, job);
    return { backend: BACKEND };
  }

  throw new SimulatedProviderError(`Simulated provider: attempt '${attempt}' reached unexpected state '${job.state}'`);
}

/** List persisted simulated jobs (validated; contains no prompts/secrets). Symlinked records are refused. */
export async function simulatedStatus(root: string): Promise<unknown[]> {
  const rootAbs = resolve(root);
  let jobsDir: string;
  try {
    jobsDir = await resolveInRoot(rootAbs, JOBS_DIR_REL);
  } catch {
    return [];
  }
  if (!existsSync(jobsDir)) return [];
  const entries = await readdir(jobsDir);
  const jobs: SimulatedJob[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    let file: string;
    try {
      file = await resolveInRoot(rootAbs, `${JOBS_DIR_REL}/${name}`);
    } catch {
      continue; // unsafe (e.g. symlinked) record: do not follow it
    }
    if (!existsSync(file)) continue;
    try {
      const job = await loadJob(file);
      if (job) jobs.push(job);
    } catch {
      continue; // invalid record: skip rather than surface untrusted content
    }
  }
  jobs.sort((a, b) => a.attempt.localeCompare(b.attempt));
  return jobs;
}
