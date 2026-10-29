import {
  type PlayableInput,
  type OutputSettings,
  type World,
  type PlayableRecording,
  PlayableInputSchema,
  requireComposition,
  PlayableRecordingSchema,
  type BrowserPictureSource,
  OutputSchema,
} from '../../core/schema.js';
import { type CodeSceneSource, type CaptureBinding, type CaptureLifecycle, captureCode } from '../browser/capture.js';
import {
  recordingByteBudget,
  assertRecordingBudget,
  sourceSignatureKey,
  validateRecordingStructure,
  loadRecording,
  assertState,
  messageOf,
} from './recording.js';
import { installWorldDefinition } from '../world/world.js';
import { type KeyInput, type Page } from 'puppeteer-core';
import { stableHash, hashFile } from '../../shared/hash.js';
import { loadProject, resolveWorldBinding, resolveSourceBindings, acquireLock } from '../../project/project.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolveProjectPath, atomicJson } from '../../shared/fs.js';
import { encodeFrames } from '../media/encoding.js';
import { probeMedia } from '../media/probe.js';

export type { PlayableRecording } from '../../core/schema.js';

/** One recorded per-frame observation of `window.viscraft.state()`. */
export interface PlayableFrameState {
  frame: number;
  state: unknown;
}

/** Result of a scripted real-browser capture driven by a keyboard schedule. */
export interface PlayableCapture {
  browserVersion: string;
  /** Normalized DOM key events the page actually emitted, in order. */
  events: PlayableInput[];
  /** Per-frame observations; empty when supplied replay states are verified without retaining a second copy. */
  states: PlayableFrameState[];
}

/**
 * Capture a trusted source to a PNG frame sequence while injecting a scripted,
 * real keyboard schedule through Puppeteer and observing the page.
 *
 * This is the single browser-driving primitive behind both recording and
 * replay — it wraps `captureCode` and adds no second renderer. It returns the
 * normalized DOM key events the page actually emitted (asserted to equal the
 * supplied schedule) and each frame's `window.viscraft.state()`.
 */
export async function capturePlayable(
  root: string,
  source: CodeSceneSource,
  output: OutputSettings,
  destination: string,
  events: PlayableInput[],
  bindings: Record<string, CaptureBinding> = {},
  world?: World,
  /** Verify these observations as frames arrive instead of collecting a second state array. */
  replayStates?: Readonly<PlayableRecording['states']>,
): Promise<PlayableCapture> {
  if (Boolean(source.world) !== Boolean(world))
    throw new Error('capturePlayable: a World binding requires the resolved World definition');
  const schedule = events.map(event => PlayableInputSchema.parse(event));
  const budget = recordingByteBudget();
  assertRecordingBudget(Buffer.byteLength(JSON.stringify(schedule)), budget);
  let observationBytes = Buffer.byteLength(JSON.stringify({ events: [], states: [] }));
  assertRecordingBudget(observationBytes, budget);
  if (replayStates && replayStates.length !== source.frames)
    throw new Error('capturePlayable: replay must contain one state per frame');
  const byFrame = new Map<number, PlayableInput[]>();
  for (const event of schedule) {
    const list = byFrame.get(event.frame);
    if (list) list.push(event);
    else byFrame.set(event.frame, [event]);
  }

  let observed: PlayableInput[] = [];
  const states: PlayableFrameState[] = [];
  const lifecycle: CaptureLifecycle = {
    prepare: async page => {
      await installInputListener(page);
      if (world) await installWorldDefinition(page, world);
    },
    beforeFrame: async (page, frame) => {
      for (const event of byFrame.get(frame) ?? []) {
        // Tag exactly this event with `frame`, then clear so a stale value can
        // never mis-tag a later key (the author page reads this global at
        // dispatch time to record the frame each input affects).
        await setInputFrame(page, frame);
        if (event.type === 'down') await page.keyboard.down(event.key as KeyInput);
        else await page.keyboard.up(event.key as KeyInput);
        await clearInputFrame(page);
      }
    },
    afterFrame: async (page, frame) => {
      for (const event of await readInputEvents(page, budget - observationBytes)) {
        observationBytes += Buffer.byteLength(JSON.stringify(event)) + (observed.length > 0 ? 1 : 0);
        assertRecordingBudget(observationBytes, budget);
        observed.push(event);
      }
      const { state, bytes } = await readState(page, budget - observationBytes);
      observationBytes += bytes + Buffer.byteLength(JSON.stringify({ frame, state: null })) - 4 + (frame > 0 ? 1 : 0);
      assertRecordingBudget(observationBytes, budget);
      if (replayStates) {
        const expected = replayStates[frame];
        if (expected.frame !== frame || stableHash(state) !== stableHash(expected.state))
          throw new Error(`captureReplay: replay diverged from the recording at frame ${frame}`);
      } else states.push({ frame, state });
    },
  };

  const { browserVersion } = await captureCode(root, source, output, destination, bindings, lifecycle);

  if (stableHash(observed) !== stableHash(schedule)) {
    throw new Error(
      'capturePlayable: recorded DOM key events do not match the scheduled input sequence\n' +
        `scheduled: ${JSON.stringify(schedule)}\n` +
        `recorded:  ${JSON.stringify(observed)}`,
    );
  }
  return { browserVersion, events: observed, states };
}

/**
 * Record a real play session into authored material.
 *
 * `sourceId` must name a current `browser` `picture` source; a previous
 * `recording` path on that source is ignored (this always records fresh).
 * The declared source files and every bound asset are hashed before and after
 * capture — a change during capture aborts. The result is written to
 * `recordings/<session>/session.json` with a `preview.mp4` encoded from the
 * actual captured PNG frames, under `root`.
 */
export async function recordPlayable(
  root: string,
  sourceId: string,
  inputs: PlayableInput[],
): Promise<PlayableRecording> {
  const project = await loadProject(root);
  const source = project.sources.find(candidate => candidate.id === sourceId);
  if (!source) throw new Error(`recordPlayable: unknown source "${sourceId}"`);
  if (source.kind !== 'browser' || source.output !== 'picture') {
    throw new Error(`recordPlayable: source "${sourceId}" must be a browser picture Source (found "${source.kind}")`);
  }
  if (source.world?.mode === 'drive') {
    // A playable recording freezes the page's own observation of `state()`; it
    // installs only the World DEFINITION and never steps `window.__viscraftWorld`
    // per frame. Accepting a `drive` binding would silently capture a page that
    // reads an undefined world snapshot, so refuse it before any capture.
    throw new Error(
      `recordPlayable: source "${sourceId}" binds World "${source.world.id}" in mode 'drive'; playable recording supports only no-World or mode 'define' sources`,
    );
  }
  const output = requireComposition(project).output;
  const world = resolveWorldBinding(project, source.world, source);
  const schedule = validateInputSchedule(inputs, source.frames);
  // What this recording claims to be: the exact source signature and output it
  // was captured from. The final publish re-checks both, under a SHORT author
  // lock, so a concurrent parameter/output edit cannot be published as current.
  const sourceKey = sourceSignatureKey(source, source.frames, output, world);
  const outputKey = stableHash(output);

  const bindings: Record<string, CaptureBinding> = {};
  let simulated = Boolean(
    world?.entities.some(entity => project.assets.find(asset => asset.id === entity.asset)?.simulated),
  );
  for (const { binding: name, asset } of resolveSourceBindings(project, source)) {
    bindings[name] = { id: asset.id, path: asset.path, sha256: asset.sha256 };
    if (asset.simulated) simulated = true;
  }

  const declaredPaths = dedupePaths([
    source.entry,
    ...source.resources,
    ...Object.values(bindings).map(binding => binding.path),
  ]);
  const before = await hashInputFiles(root, declaredPaths);
  const beforeByPath = new Map(before.map(file => [file.path, file.sha256]));
  for (const [name, binding] of Object.entries(bindings)) {
    if (beforeByPath.get(binding.path) !== binding.sha256) {
      throw new Error(`recordPlayable: binding "${name}" asset "${binding.path}" does not match its declared sha256`);
    }
  }

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-record-'));
  const framesDirectory = path.join(scratch, 'frames');
  const id = `rec-${randomUUID()}`;
  const relativeDirectory = `recordings/${id}`;
  let recordingDirectory: string | undefined;
  try {
    const page: CodeSceneSource = {
      id: source.id,
      entry: source.entry,
      resources: source.resources,
      params: source.params,
      seed: source.seed,
      frames: source.frames,
      ...(source.world ? { world: source.world } : {}),
    };
    const capture = await capturePlayable(root, page, output, framesDirectory, schedule, bindings, world);

    recordingDirectory = await resolveProjectPath(root, relativeDirectory);
    await fs.mkdir(recordingDirectory, { recursive: true });
    const mediaRelative = `${relativeDirectory}/preview.mp4`;
    const mediaAbsolute = await resolveProjectPath(root, mediaRelative);
    await encodeFrames(framesDirectory, output, source.frames, mediaAbsolute);
    const info = await probeMedia(mediaAbsolute);
    const sha256 = await hashFile(mediaAbsolute);

    // Capture can be long; the author lock is only held for the final identity
    // check and the publish. A concurrent parameter/output edit therefore either
    // lands before this check (and is rejected) or waits for the short write.
    const release = await acquireLock(root, 'author');
    try {
      const after = await hashInputFiles(root, declaredPaths);
      if (stableHash(before) !== stableHash(after))
        throw new Error('recordPlayable: a declared source file or binding asset changed during capture; aborting');

      const currentProject = await loadProject(root);
      const currentSource = currentProject.sources.find(candidate => candidate.id === source.id);
      if (!currentSource || currentSource.kind !== 'browser' || currentSource.output !== 'picture')
        throw new Error('recordPlayable: the source was removed or changed medium during capture; record again');

      const currentOutput = requireComposition(currentProject).output;
      if (stableHash(currentOutput) !== outputKey)
        throw new Error('recordPlayable: the composition output changed during capture; record again');

      const currentWorld = resolveWorldBinding(currentProject, currentSource.world, currentSource);
      if (stableHash(currentWorld ?? null) !== stableHash(world ?? null))
        throw new Error('recordPlayable: shared World changed during capture; record again');

      if (
        stableHash(resolveSourceBindings(currentProject, currentSource)) !==
        stableHash(resolveSourceBindings(project, source))
      )
        throw new Error('recordPlayable: scoped source bindings changed during capture');

      if (sourceSignatureKey(currentSource, currentSource.frames, currentOutput, currentWorld) !== sourceKey)
        throw new Error(
          'recordPlayable: source params, seed, frames or resources changed during capture; record again',
        );

      const recording = PlayableRecordingSchema.parse({
        schemaVersion: 1,
        id,
        source: {
          id: source.id,
          key: sourceKey,
          entry: source.entry,
          resources: source.resources,
          bindings: source.bindings,
          params: source.params,
          seed: source.seed,
          ...(world ? { world } : {}),
          ...(source.bindingOverrides ? { bindingOverrides: source.bindingOverrides } : {}),
          files: after,
        },
        output,
        frames: source.frames,
        events: capture.events,
        states: capture.states,
        media: { path: mediaRelative, sha256, info },
        simulated,
      });
      // Write-time guard shares the read-side structural/param checks so a session
      // that would fail `loadRecording` can never be persisted in the first place.
      validateRecordingStructure(recording, 'recordPlayable');
      assertRecordingBudget(Buffer.byteLength(JSON.stringify(recording, null, 2)) + 1, recordingByteBudget());
      await atomicJson(await resolveProjectPath(root, `${relativeDirectory}/session.json`), recording);
      return recording;
    } finally {
      await release();
    }
  } catch (error) {
    if (recordingDirectory) await fs.rm(recordingDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Deterministically replay a recording against the current source.
 *
 * The recording's frozen source signature (entry/resources/bindings/params/
 * seed/frames/output) must match the requested playable source; every recorded
 * input file and frozen binding asset must hash-match inside `root`; then the
 * same real browser source is driven with the recorded events and each frame's
 * emitted DOM events and `window.viscraft.state()` must equal what was recorded.
 */
export async function captureReplay(
  root: string,
  source: BrowserPictureSource,
  output: OutputSettings,
  destinationDirectory: string,
  bindings: Record<string, CaptureBinding> = {},
  world?: World,
): Promise<{ browserVersion: string }> {
  const settings = OutputSchema.parse(output);
  const recording = await loadRecording(root, source.recording!);

  if (stableHash(recording.source.world ?? null) !== stableHash(world ?? null))
    throw new Error('captureReplay: shared World changed since recording');
  if (recording.source.key !== sourceSignatureKey(source, source.frames, settings, world)) {
    throw new Error('captureReplay: recording source signature does not match the requested playable source');
  }
  if (stableHash(recording.output) !== stableHash(settings)) {
    throw new Error('captureReplay: recording output settings do not match the requested build output');
  }
  if (recording.frames !== source.frames) {
    throw new Error(
      `captureReplay: recording holds ${recording.frames} frames but the playable source declares ${source.frames}`,
    );
  }

  verifyRecordingFileSet(recording, source, bindings);
  await verifyRecordedFiles(root, recording);
  verifyReplayBindings(recording, source, bindings);

  const page: CodeSceneSource = {
    id: source.id,
    entry: source.entry,
    resources: source.resources,
    params: source.params,
    seed: source.seed,
    frames: source.frames,
    ...(source.world ? { world: source.world } : {}),
  };
  const capture = await capturePlayable(
    root,
    page,
    settings,
    destinationDirectory,
    recording.events,
    bindings,
    world,
    recording.states,
  );
  return { browserVersion: capture.browserVersion };
}

// ---------------------------------------------------------------------------
// Input recording / replay
// ---------------------------------------------------------------------------

/**
 * Install an input listener that survives navigation and records the real DOM
 * keydown/keyup events into `window.__viscraftInput`, tagged with the frame
 * currently being captured. Only the canonical playable keys are recorded —
 * never mouse, device or audio events.
 */
async function installInputListener(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    const state = window as unknown as {
      __viscraftInput?: Array<{ frame: number; key: string; type: 'down' | 'up' }>;
      __viscraftInputFrame?: number;
    };
    state.__viscraftInput = [];
    const normalize = (key: string): string | null => {
      if (key === ' ') return 'Space';
      if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown') return key;
      if (key.length === 1 && key.toLowerCase() === 'r') return 'r';
      return null;
    };
    const record =
      (type: 'down' | 'up') =>
      (event: Event): void => {
        const key = normalize((event as KeyboardEvent).key);
        if (key && state.__viscraftInput)
          state.__viscraftInput.push({ frame: state.__viscraftInputFrame ?? 0, key, type });
      };
    window.addEventListener('keydown', record('down'), true);
    window.addEventListener('keyup', record('up'), true);
  });
}

async function setInputFrame(page: Page, frame: number): Promise<void> {
  await page.evaluate((value: number) => {
    (window as unknown as { __viscraftInputFrame?: number }).__viscraftInputFrame = value;
  }, frame);
}

async function clearInputFrame(page: Page): Promise<void> {
  await page.evaluate(() => {
    delete (window as unknown as { __viscraftInputFrame?: number }).__viscraftInputFrame;
  });
}

async function readInputEvents(page: Page, remainingBytes: number): Promise<PlayableInput[]> {
  const json = await page.evaluate((limit: number) => {
    const value = (window as unknown as { __viscraftInput?: unknown }).__viscraftInput;
    const text = JSON.stringify(Array.isArray(value) ? value.splice(0) : []);
    if (new TextEncoder().encode(text).length > limit)
      throw new Error(
        'Playable input events exceed the remaining recording memory budget; raise VISCRAFT_RECORDING_MAX_BYTES for available memory',
      );
    return text;
  }, remainingBytes);
  return normalizeEvents(PlayableInputSchema.array().parse(JSON.parse(json)));
}

/**
 * Collapse a browser auto-repeat (a repeated `down` for a key already held at
 * the same frame) so an ordered comparison against the schedule is exact.
 */
function normalizeEvents(events: PlayableInput[]): PlayableInput[] {
  const normalized: PlayableInput[] = [];
  for (const event of events) {
    const previous = normalized.at(-1);
    if (
      previous &&
      previous.type === 'down' &&
      event.type === 'down' &&
      previous.key === event.key &&
      previous.frame === event.frame
    )
      continue;
    normalized.push(event);
  }
  return normalized;
}

/** Reject a state only for serialization, secrets or the remaining observation memory budget. */
async function readState(page: Page, remainingBytes: number): Promise<{ state: unknown; bytes: number }> {
  const json = await page.evaluate((limit: number) => {
    const viscraft = (window as unknown as { viscraft?: { state?: () => unknown } }).viscraft;
    if (!viscraft || typeof viscraft.state !== 'function') throw new Error('window.viscraft.state is not a function');
    const value = viscraft.state();
    if (value === undefined) throw new Error('window.viscraft.state() returned undefined');
    const text = JSON.stringify(value);
    if (typeof text !== 'string') throw new Error('window.viscraft.state() is not JSON-serializable');
    if (new TextEncoder().encode(text).length > limit)
      throw new Error(
        'Playable observation exceeds the remaining recording memory budget; raise VISCRAFT_RECORDING_MAX_BYTES for available memory without changing the recorded state',
      );
    return text;
  }, remainingBytes);
  const state: unknown = JSON.parse(json);
  assertState(state);
  return { state, bytes: Buffer.byteLength(json) };
}

function validateInputSchedule(inputs: PlayableInput[], frames: number): PlayableInput[] {
  if (!Array.isArray(inputs)) throw new Error('recordPlayable: inputs must be an array of key events');
  const schedule: PlayableInput[] = [];
  let previous = -1;
  for (const raw of inputs) {
    const event = PlayableInputSchema.parse(raw);
    if (event.frame >= frames)
      throw new Error(`recordPlayable: event frame ${event.frame} is outside the recorded interval [0, ${frames})`);
    if (event.frame < previous) throw new Error('recordPlayable: input events must be ordered by nondecreasing frame');
    previous = event.frame;
    schedule.push(event);
  }
  return schedule;
}

async function verifyRecordedFiles(root: string, recording: PlayableRecording): Promise<void> {
  for (const file of recording.source.files) {
    let actual: string;
    try {
      actual = await hashFile(await resolveProjectPath(root, file.path));
    } catch (error) {
      throw new Error(
        `captureReplay: recorded source file "${file.path}" is missing or unreadable: ${messageOf(error)}`,
      );
    }
    if (actual !== file.sha256) {
      throw new Error(
        `captureReplay: recorded source file "${file.path}" changed since recording (expected ${file.sha256}, found ${actual})`,
      );
    }
  }
}

/** The recording must freeze exactly the entry, resources and binding asset paths — no extras, none missing. */
function verifyRecordingFileSet(
  recording: PlayableRecording,
  source: BrowserPictureSource,
  bindings: Record<string, CaptureBinding>,
): void {
  const expected = dedupePaths([
    source.entry,
    ...source.resources,
    ...Object.values(bindings).map(binding => binding.path),
  ]);
  const actual = dedupePaths(recording.source.files.map(file => file.path));
  if (expected.length !== actual.length || expected.some((path, index) => path !== actual[index])) {
    throw new Error(
      'captureReplay: recording source files do not exactly match the playable source entry/resources/bindings',
    );
  }
}

function verifyReplayBindings(
  recording: PlayableRecording,
  source: BrowserPictureSource,
  bindings: Record<string, CaptureBinding>,
): void {
  const names = Object.keys(bindings).sort();
  const expected = [...source.bindings].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new Error('captureReplay: supplied bindings do not match the playable source bindings');
  }
  for (const [name, binding] of Object.entries(bindings)) {
    const recorded = recording.source.files.find(file => file.path === binding.path);
    if (!recorded)
      throw new Error(`captureReplay: binding "${name}" file "${binding.path}" is not part of the recording signature`);
    if (recorded.sha256 !== binding.sha256)
      throw new Error(`captureReplay: binding "${name}" asset hash does not match the recording`);
  }
}

function dedupePaths(paths: string[]): string[] {
  return [...new Set(paths)].sort((a, b) => a.localeCompare(b));
}

async function hashInputFiles(root: string, paths: string[]): Promise<Array<{ path: string; sha256: string }>> {
  const files: Array<{ path: string; sha256: string }> = [];
  for (const relative of paths) {
    const absolute = await resolveProjectPath(root, relative);
    const stat = await fs.lstat(absolute).catch(() => undefined);
    if (!stat || !stat.isFile())
      throw new Error(`recordPlayable: declared file "${relative}" is missing or not a regular file`);
    files.push({ path: relative, sha256: await hashFile(absolute) });
  }
  return files;
}
