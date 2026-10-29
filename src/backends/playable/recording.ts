import {
  type PlayableRecording,
  RelativePath,
  PlayableRecordingSchema,
  type OutputSettings,
  type World,
} from '../../core/schema.js';
import { resolveProjectPath } from '../../shared/fs.js';
import fs from 'node:fs/promises';
import { redact } from '../../shared/process.js';
import { hashFile, stableHash } from '../../shared/hash.js';

// Recording JSON is held in memory. Bound the actual observation bytes, not
// the author's duration, event count or state shape. The host can budget more
// memory for a larger session without changing its production inputs.
export function recordingByteBudget(): number {
  const bytes = Number(process.env.VISCRAFT_RECORDING_MAX_BYTES ?? 128 * 1024 * 1024);
  if (!Number.isSafeInteger(bytes) || bytes <= 0)
    throw new Error('VISCRAFT_RECORDING_MAX_BYTES must be a positive whole number of bytes');
  return bytes;
}

export function assertRecordingBudget(bytes: number, budget: number): void {
  if (bytes > budget)
    throw new Error(
      `Recording data needs ${bytes} bytes, exceeding the ${budget}-byte recording memory budget; raise VISCRAFT_RECORDING_MAX_BYTES for available memory rather than changing the duration or recorded state`,
    );
}

const CREDENTIAL_KEY =
  /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|proxy-authorization|authorization[_-]?header|x-api-key|cookie|set-cookie)$/i;

/**
 * Load and fully validate a canonical recording.
 *
 * The path is resolved through the shared project-path policy (safe relative,
 * no symlinks, inside `root`). The JSON must satisfy the canonical schema and
 * its structural invariants, and the recorded preview media must be present
 * with a matching hash — a tampered or missing preview is rejected rather than
 * replayed.
 */
export async function loadRecording(root: string, relative: string): Promise<PlayableRecording> {
  const file = await resolveProjectPath(root, RelativePath.parse(relative));
  const stat = await fs.stat(file).catch(() => undefined);
  if (!stat || !stat.isFile()) throw new Error(`loadRecording: recording "${relative}" does not exist`);
  assertRecordingBudget(stat.size, recordingByteBudget());
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`loadRecording: recording "${relative}" does not exist`);
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`loadRecording: recording "${relative}" is not valid JSON`);
  }
  let recording: PlayableRecording;
  try {
    recording = PlayableRecordingSchema.parse(value);
  } catch (error) {
    throw new Error(`loadRecording: invalid recording "${relative}": ${redact(messageOf(error))}`);
  }
  validateRecordingStructure(recording);

  const mediaAbsolute = await resolveProjectPath(root, recording.media.path);
  const mediaStat = await fs.stat(mediaAbsolute).catch(() => undefined);
  if (!mediaStat || !mediaStat.isFile())
    throw new Error(`loadRecording: preview media "${recording.media.path}" is missing or not a regular file`);
  if ((await hashFile(mediaAbsolute)) !== recording.media.sha256) {
    throw new Error(`loadRecording: preview media hash mismatch for "${recording.media.path}"`);
  }
  return recording;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export function sourceSignatureKey(
  source: {
    entry: string;
    resources: string[];
    bindings: string[];
    params: Record<string, unknown>;
    seed: number;
    bindingOverrides?: Record<string, string>;
  },
  frames: number,
  output: OutputSettings,
  world?: World,
): string {
  return stableHash({
    entry: source.entry,
    resources: source.resources,
    bindings: source.bindings,
    params: source.params,
    seed: source.seed,
    frames,
    output,
    ...(world ? { world } : {}),
    ...(source.bindingOverrides ? { bindingOverrides: source.bindingOverrides } : {}),
  });
}

export function validateRecordingStructure(recording: PlayableRecording, label = 'loadRecording'): void {
  if (recording.states.length !== recording.frames) {
    throw new Error(`${label}: recording has ${recording.states.length} states for ${recording.frames} frames`);
  }
  for (let index = 0; index < recording.states.length; index++) {
    const entry = recording.states[index];
    if (entry.frame !== index) throw new Error(`${label}: state ${index} is tagged with frame ${entry.frame}`);
    assertState(entry.state);
  }
  let previous = -1;
  for (const event of recording.events) {
    if (event.frame >= recording.frames)
      throw new Error(`${label}: event frame ${event.frame} is outside the recorded interval`);
    if (event.frame < previous) throw new Error(`${label}: recording events are not ordered by nondecreasing frame`);
    previous = event.frame;
  }
  // Frozen params are authored material: preserve them while rejecting credential/header fields.
  assertState(recording.source.params);
  if (recording.source.world) assertNoCredentialKeys(recording.source.world);
  // The signature must be derivable from the recording's own frozen fields/output.
  if (
    recording.source.key !==
    sourceSignatureKey(recording.source, recording.frames, recording.output, recording.source.world)
  ) {
    throw new Error(`${label}: recording source signature does not match its own frozen fields`);
  }
  // Compare the frame grid as exact rationals: a probe reports `50/2` as `25/1`,
  // which is the same rate, so raw value comparison would reject a valid record.
  const mediaFps = recording.media.info.fps;
  const outputFps = recording.output.fps;
  if (
    recording.media.info.frames !== recording.frames ||
    mediaFps.numerator * outputFps.denominator !== outputFps.numerator * mediaFps.denominator ||
    recording.media.info.width !== recording.output.width ||
    recording.media.info.height !== recording.output.height
  ) {
    throw new Error(`${label}: preview media does not match the recording frame clock and dimensions`);
  }
}

export function assertState(value: unknown): void {
  if (JSON.stringify(value) === undefined) throw new Error('window.viscraft.state() is not JSON-serializable');
  assertNoCredentialKeys(value);
}

function assertNoCredentialKeys(value: unknown): void {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      for (const child of current) pending.push(child);
    } else if (current && typeof current === 'object') {
      for (const [key, child] of Object.entries(current)) {
        if (CREDENTIAL_KEY.test(key))
          throw new Error(
            `window.viscraft.state() exposes a credential/header field "${key}"; state is recorded into authored material`,
          );
        pending.push(child);
      }
    }
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
