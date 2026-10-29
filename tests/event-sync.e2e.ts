/**
 * End-to-end verification of "one authored event drives picture, sound and
 * subtitle".
 *
 * The authoring fixture (`tests/fixtures/authoring/create-event-sync.mjs`) writes
 * a Project entirely derived from a single `eventFrame` option:
 *   - a `browser` picture Source vendoring the `scale-reveal` module/scene, with camera
 *     params chosen so the push reaches its TIGHT hold exactly at the event;
 *   - an authored audio Asset placed by an `asset` clip at `framesToSamples(eventFrame)`;
 *   - a subtitle starting on that frame.
 *
 * Coverage:
 *   (A) shared event — the picture's declared event, `sound.startSample` and
 *       `subtitle.startFrame` all equal the one authored event (with the picture
 *       state change verified against the real module sample, not arithmetic);
 *   (B) moving the event moves all three together by the exact arithmetic;
 *   (C) a head trim (an in/out placement) keeps sample alignment: the module-local
 *       event moves, the composition event is re-derived, and the sound stays on
 *       `framesToSamples` of the composition event;
 *   (D) a real Build followed by a sound-only change leaves the picture `code`
 *       Source classified reusable by the read-only preflight — no picture Take is
 *       regenerated.
 *
 * Local (source) time vs story (composition) time: the camera owns LOCAL time; a
 * placement maps local frame f to composition frame `startFrame + (f - inFrame)`.
 * The recipe's single fact is the COMPOSITION event frame; this test inverts the
 * mapping each time to check both clocks agree.
 *
 * Honest limit: this proves *technical* sync — the frame<->sample mapping — not
 * that the mix sounds good. There is no listening step here.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

import { buildProject, framesToSamples, loadProject, planBuild, saveProject, type Project } from '../src/index.js';
import { authorRecipe } from './authoring-helpers.js';

// ---------------------------------------------------------------------------
// Fixture constants (mirroring create-event-sync.mjs)
// ---------------------------------------------------------------------------

const AUTHOR = resolve('tests/fixtures/authoring/create-event-sync.mjs');
const MODULE_PATH = resolve('tests/fixtures/authoring/scale-reveal/scale-reveal.mjs');

const FPS = { numerator: 24, denominator: 1 } as const;
const SAMPLE_RATE = 48000 as const;
const HOLD_OUT = 4;
const EVENT = 12;
const DELTA = 5;
const TRIM = 6;
const CODE_SOURCE = 'src_event_scale_reveal';
const EVENT_CLIP_ID = 'event_tone';

interface CameraParams {
  startFrame: number;
  frames: number;
  holdIn: number;
  holdOut: number;
  zoom: { from: number; to: number };
  ease: string;
  worldAnchor: { x: number; y: number };
  anchorScreen: { x: number; y: number };
  eventFrame: number;
  eventLocalFrame?: number;
}
interface ScaleRevealSample {
  t: number;
  zoom: number;
  globalFrame: number;
}
interface ScaleRevealCamera {
  at(frame: number, viewport?: { width: number; height: number }): ScaleRevealSample;
}
interface ScaleRevealModule {
  createScaleReveal(spec: Record<string, unknown>): ScaleRevealCamera;
}
const scaleReveal = (await import(pathToFileURL(MODULE_PATH).href)) as unknown as ScaleRevealModule;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Author through the one public `viscraft author <recipe> <dir>` boundary. */
async function runAuthor(target: string, options: Record<string, unknown> = {}): Promise<void> {
  await authorRecipe({
    recipe: AUTHOR,
    root: target,
    cwd: dirname(target),
    options: { holdOut: HOLD_OUT, ...options },
  });
}

function codeSource(project: Project) {
  const source = project.sources.find(candidate => candidate.id === CODE_SOURCE);
  if (!source || source.kind !== 'browser' || source.output !== 'picture')
    throw new Error(`expected a code Source ${CODE_SOURCE}`);
  return source;
}
function paramsOf(source: ReturnType<typeof codeSource>): CameraParams {
  return source.params as unknown as CameraParams;
}
function soundClip(project: Project) {
  const clip = project.composition!.audio.find(candidate => candidate.id === EVENT_CLIP_ID);
  if (!clip || clip.kind !== 'asset') throw new Error(`expected the authored audio Asset clip ${EVENT_CLIP_ID}`);
  return clip;
}
function caption(project: Project) {
  const subtitle = project.composition!.subtitles?.[0];
  if (!subtitle) throw new Error('expected exactly one subtitle');
  return subtitle;
}
/** The frame on the CAMERA's own (source-local) clock at which the push is tight. */
function localEventFrame(source: ReturnType<typeof codeSource>): number {
  const params = paramsOf(source);
  return params.startFrame + params.frames - 1 - params.holdOut;
}
/** The composition frame the local event lands on, through the placement. */
function compositionEventFrame(project: Project, source: ReturnType<typeof codeSource>): number {
  const placement = project.composition!.placements[0];
  assert.ok(placement, 'the fixture writes exactly one placement');
  return placement.startFrame + (localEventFrame(source) - placement.inFrame);
}
function cameraOf(source: ReturnType<typeof codeSource>): ScaleRevealCamera {
  const params = paramsOf(source);
  return scaleReveal.createScaleReveal({
    worldFrame: { width: 1600, height: 900 },
    fit: 'cover',
    viewport: { width: 160, height: 90 },
    worldAnchor: params.worldAnchor,
    anchorScreen: params.anchorScreen,
    zoom: params.zoom,
    ease: params.ease,
    holdIn: params.holdIn,
    holdOut: params.holdOut,
    startFrame: params.startFrame,
    frames: params.frames,
    bounds: null,
  });
}

// ---------------------------------------------------------------------------
// (A) + (B) one event, moving it moves picture + sound + subtitle together
// ---------------------------------------------------------------------------

test('one authored event keys picture, sound and subtitle; moving it moves all three', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-event-sync-'));
  try {
    const baseDir = join(root, 'base');
    const movedDir = join(root, 'moved');
    await runAuthor(baseDir, { eventFrame: EVENT });
    const base = await loadProject(baseDir);

    // (A) shared event.
    const baseSource = codeSource(base);
    const baseTone = soundClip(base);
    const baseCaption = caption(base);
    assert.equal(paramsOf(baseSource).eventFrame, EVENT, 'the picture must declare the authored event');
    assert.equal(baseCaption.startFrame, EVENT, 'subtitle.startFrame must be the event');
    assert.ok(baseCaption.endFrame > baseCaption.startFrame, 'the subtitle interval must be nonempty');
    assert.equal(
      baseTone.startSample,
      framesToSamples(EVENT, FPS, SAMPLE_RATE),
      'sound onset must be framesToSamples(event)',
    );
    assert.equal(
      baseTone.startSample,
      EVENT * framesToSamples(1, FPS, SAMPLE_RATE),
      'and equal the canonical per-frame sample step',
    );

    // The picture really changes state at the event: the module's push is tight
    // exactly at the local event frame and not yet tight one frame earlier.
    const localEvent = localEventFrame(baseSource);
    const baseCamera = cameraOf(baseSource);
    assert.equal(baseCamera.at(localEvent).t, 1, 'the push must be tight at the event');
    assert.equal(
      baseCamera.at(localEvent).zoom,
      paramsOf(baseSource).zoom.to,
      'the push must reach the tight zoom at the event',
    );
    assert.ok(baseCamera.at(localEvent - 1).t < 1, 'the push must not be tight one frame before the event');
    // The module-local event maps onto the composition event via the placement.
    assert.equal(compositionEventFrame(base, baseSource), EVENT, 'the local event must land on the composition event');
    assert.equal(baseCaption.startFrame, compositionEventFrame(base, baseSource));

    // (B) move the event by DELTA and re-derive everything.
    await runAuthor(movedDir, { eventFrame: EVENT + DELTA });
    const moved = await loadProject(movedDir);
    const movedSource = codeSource(moved);
    const movedTone = soundClip(moved);
    const movedCaption = caption(moved);

    assert.equal(movedCaption.startFrame, EVENT + DELTA);
    assert.equal(movedTone.startSample, framesToSamples(EVENT + DELTA, FPS, SAMPLE_RATE));
    // The exact arithmetic — assert the real deltas, not a linearity assumption.
    assert.equal(movedCaption.startFrame - baseCaption.startFrame, DELTA, 'subtitle moves by exactly DELTA');
    assert.equal(
      movedTone.startSample - baseTone.startSample,
      framesToSamples(DELTA, FPS, SAMPLE_RATE),
      'sound onset moves by exactly framesToSamples(DELTA)',
    );
    assert.equal(
      paramsOf(movedSource).eventFrame - paramsOf(baseSource).eventFrame,
      DELTA,
      'the picture event moved by DELTA',
    );
    assert.equal(localEventFrame(movedSource) - localEvent, DELTA, 'the picture local event moved by DELTA');

    // And the moved picture is still tight exactly at its own event.
    const movedCamera = cameraOf(movedSource);
    assert.equal(movedCamera.at(localEventFrame(movedSource)).t, 1);
    assert.ok(movedCamera.at(localEventFrame(movedSource) - 1).t < 1);

    console.log(
      `[event-sync] (A/B) E=${EVENT}: subtitle=${baseCaption.startFrame} sound=${baseTone.startSample} localEvent=${localEvent} | E=${EVENT + DELTA}: subtitle=${movedCaption.startFrame} sound=${movedTone.startSample} localEvent=${localEventFrame(movedSource)} | Δsubtitle=${movedCaption.startFrame - baseCaption.startFrame} Δsound=${movedTone.startSample - baseTone.startSample} (framesToSamples(${DELTA})=${framesToSamples(DELTA, FPS, SAMPLE_RATE)})`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (C) a head trim (in/out placement) keeps sample alignment
// ---------------------------------------------------------------------------

test('a head trim keeps the sound on framesToSamples of the retimed composition event', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-event-sync-trim-'));
  try {
    const baseDir = join(root, 'base');
    const trimDir = join(root, 'trim');
    await runAuthor(baseDir, { eventFrame: EVENT });
    await runAuthor(trimDir, { eventFrame: EVENT, inFrame: TRIM });
    const base = await loadProject(baseDir);
    const trimmed = await loadProject(trimDir);

    const baseSource = codeSource(base);
    const trimSource = codeSource(trimmed);
    const placement = trimmed.composition!.placements[0];
    assert.equal(placement.inFrame, TRIM, 'the trimmed project must carry a real head trim');

    // The trim pushes the module-local event TRIM frames later...
    assert.equal(localEventFrame(trimSource) - localEventFrame(baseSource), TRIM, 'a head trim moves the local event');
    // ...while the composition event is re-derived and stays put.
    const localEvent = localEventFrame(trimSource);
    const compEvent = compositionEventFrame(trimmed, trimSource);
    assert.equal(compEvent, EVENT, 'the composition event after the trim');

    // The trimmed picture is still tight exactly at its own (moved) local event.
    const trimCamera = cameraOf(trimSource);
    assert.equal(trimCamera.at(localEvent).t, 1, 'the push must be tight at the trimmed local event');
    assert.ok(trimCamera.at(localEvent - 1).t < 1);

    // The sound and subtitle follow the RETIMED composition frame exactly.
    assert.equal(caption(trimmed).startFrame, compEvent, 'subtitle follows the retimed event');
    assert.equal(
      soundClip(trimmed).startSample,
      framesToSamples(compEvent, FPS, SAMPLE_RATE),
      'sound onset equals framesToSamples of the retimed frame',
    );
    // The head trim alone must not move the composition event, so the sound is
    // byte-position identical to the untrimmed project.
    assert.equal(
      soundClip(trimmed).startSample,
      soundClip(base).startSample,
      'the head trim must not desync the sound',
    );
    assert.equal(caption(trimmed).startFrame, caption(base).startFrame);

    console.log(
      `[event-sync] (C) base localEvent=${localEventFrame(baseSource)} trim localEvent=${localEvent} inFrame=${placement.inFrame} compEvent=${compEvent} sound=${soundClip(trimmed).startSample} subtitle=${caption(trimmed).startFrame}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (C2) an id-targeted sync of ONE event on an EXISTING Project
// ---------------------------------------------------------------------------
// The documented editing pattern is: locate the authored event by its explicit
// id and change only that fact; never splice a whole track and never create a
// second Project identity. This is ordinary `saveProject` authoring — there is
// no Runtime "event API".
test('syncing one event by id on an existing Project keeps its identity and the other tracks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-event-sync-edit-'));
  try {
    const projectRoot = join(root, 'existing');
    await runAuthor(projectRoot, { eventFrame: EVENT });

    // Seed the existing Project with a second authored clip and a second caption
    // so the assertion can show that an id-targeted edit leaves them untouched.
    const authored = await loadProject(projectRoot);
    assert.ok(
      authored.composition!.audio.some(clip => clip.id === EVENT_CLIP_ID && clip.kind === 'asset'),
      `the authored fixture must contain the audio Asset clip ${EVENT_CLIP_ID}`,
    );
    const eventClipId = EVENT_CLIP_ID;
    const seeded = structuredClone(authored);
    const audioAsset = seeded.assets.find(asset => asset.type === 'audio');
    if (!audioAsset) throw new Error('the authored fixture must register its audio Asset');
    const seedSamples = framesToSamples(8, FPS, SAMPLE_RATE);
    (seeded.composition!.audio as Array<Record<string, unknown>>).push({
      id: 'bed_untouched',
      kind: 'asset',
      asset: audioAsset.id,
      inSample: 0,
      startSample: 0,
      durationSamples: seedSamples,
      gain: 0.05,
      fadeInSamples: 0,
      fadeOutSamples: 0,
    });
    seeded.composition!.subtitles!.push({
      id: 'caption_untouched',
      text: 'untouched',
      startFrame: 1,
      endFrame: 5,
      fontSize: 12,
      color: '#ffffff',
    });
    const written = await saveProject(projectRoot, seeded, authored.revision);
    const identity = written.id;
    const otherTone = structuredClone(written.composition!.audio.find(clip => clip.id === 'bed_untouched'));
    const otherCaption = structuredClone(written.composition!.subtitles!.find(item => item.id === 'caption_untouched'));
    const targetToneBefore = structuredClone(written.composition!.audio.find(clip => clip.id === eventClipId));
    const targetCaptionBefore = structuredClone(
      written.composition!.subtitles!.find(item => item.id === 'event_caption'),
    );
    const sourceBefore = codeSource(written);
    const cameraBefore = structuredClone(paramsOf(sourceBefore));
    assert.ok(otherTone && otherCaption && targetToneBefore && targetCaptionBefore, 'the seeded tracks exist');

    // The one edit: the event moves, addressed by id. The caption keeps its
    // authored end on the piece's last frame; only its start follows the event.
    const eventFrame = EVENT + 2;
    const compositionFrames = written.composition!.shots[0].targetFrames;
    const edited = structuredClone(written);
    const targetCaption = edited.composition!.subtitles!.find(item => item.id === 'event_caption')!;
    targetCaption.startFrame = eventFrame;
    assert.equal(targetCaption.endFrame, compositionFrames, 'the caption end is unchanged');
    const targetTone = edited.composition!.audio.find(clip => clip.id === eventClipId)!;
    assert.equal(targetTone.kind, 'asset');
    (targetTone as { startSample: number; durationSamples: number }).startSample = framesToSamples(
      eventFrame,
      FPS,
      SAMPLE_RATE,
    );
    (targetTone as { durationSamples: number }).durationSamples = framesToSamples(
      compositionFrames - eventFrame,
      FPS,
      SAMPLE_RATE,
      'ceil',
    );
    const targetSource = edited.sources.find(source => source.id === CODE_SOURCE)!;
    if (targetSource.kind !== 'browser') throw new Error('expected the code Source');
    const params = targetSource.params as unknown as CameraParams;
    const inFrame = edited.composition!.placements[0].inFrame;
    const localEvent = eventFrame + inFrame;
    // The picture must really reach its tight hold at the NEW local event:
    // the module's local event is `frames - 1 - holdOut`, so a living sync
    // updates holdOut instead of only relabelling the declared event.
    params.holdOut = params.frames - 1 - localEvent;
    params.eventFrame = eventFrame;
    params.eventLocalFrame = localEvent;
    const synced = await saveProject(projectRoot, edited, written.revision);

    assert.equal(synced.id, identity, 'the existing Project keeps its identity');
    assert.equal(targetCaption.startFrame, eventFrame);
    assert.equal(
      (targetTone as { startSample: number }).startSample,
      framesToSamples(eventFrame, FPS, SAMPLE_RATE),
      'the sound follows the same event fact',
    );
    assert.notEqual(
      (targetTone as { startSample: number }).startSample,
      (targetToneBefore as { startSample: number }).startSample,
      'the target sound timing actually moved',
    );

    // An id-targeted patch changes ONLY timing; the target's own mix/style facts
    // and every unrelated clip/subtitle keep their values.
    const syncedTone = synced.composition!.audio.find(clip => clip.id === eventClipId) as unknown as Record<
      string,
      unknown
    >;
    for (const key of ['asset', 'inSample', 'gain', 'fadeInSamples', 'fadeOutSamples', 'bus'])
      assert.equal(syncedTone[key], (targetToneBefore as Record<string, unknown>)[key], `target clip ${key} preserved`);
    const syncedCaption = synced.composition!.subtitles!.find(item => item.id === 'event_caption')!;
    for (const key of ['text', 'fontSize', 'color', 'endFrame'] as const)
      assert.equal(syncedCaption[key], targetCaptionBefore[key], `target caption ${key} preserved`);

    const syncedSource = codeSource(synced);
    const cameraAfter = paramsOf(syncedSource);
    assert.equal(cameraAfter.eventFrame, eventFrame, 'the picture declares the same single event');
    assert.equal(cameraAfter.eventLocalFrame, localEvent);
    assert.equal(localEventFrame(syncedSource), localEvent, 'the module-local event moved with holdOut');
    // The picture state change is real: the push is tight exactly at the NEW
    // local event and not yet tight one frame earlier.
    const syncedCamera = cameraOf(syncedSource);
    assert.equal(syncedCamera.at(localEvent).t, 1, 'the push is tight at the synced local event');
    assert.equal(syncedCamera.at(localEvent).zoom, cameraAfter.zoom.to, 'the tight zoom is reached');
    assert.ok(syncedCamera.at(localEvent - 1).t < 1, 'the push is not tight one frame before');
    assert.equal(compositionEventFrame(synced, syncedSource), eventFrame, 'the local event maps onto story C');
    const {
      eventFrame: _beforeEvent,
      eventLocalFrame: _beforeLocal,
      holdOut: _beforeHold,
      ...cameraRestBefore
    } = cameraBefore;
    const {
      eventFrame: _afterEvent,
      eventLocalFrame: _afterLocal,
      holdOut: _afterHold,
      ...cameraRestAfter
    } = cameraAfter;
    assert.deepEqual(cameraRestAfter, cameraRestBefore, 'the camera parameters other than the event are unchanged');

    assert.deepEqual(
      synced.composition!.audio.find(clip => clip.id === 'bed_untouched'),
      otherTone,
      'an unrelated clip is byte-for-byte untouched',
    );
    assert.deepEqual(
      synced.composition!.subtitles!.find(item => item.id === 'caption_untouched'),
      otherCaption,
      'an unrelated caption is untouched',
    );
    assert.equal(synced.sources.length, written.sources.length, 'no second Source or Project is created by the sync');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (D) replacing the sound does not regenerate the picture
// ---------------------------------------------------------------------------

test('after a real build, a sound-only change leaves the picture Source reusable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-event-sync-reuse-'));
  try {
    const projectRoot = join(root, 'project');
    await runAuthor(projectRoot, { eventFrame: EVENT });

    // A real Build — a real browser capture, a real mix and a real mux.
    const build = await buildProject(projectRoot);
    assert.equal(build.status, 'succeeded', `the real Build must succeed; got ${build.status}`);
    assert.ok(build.result, 'a succeeded Build carries a result');
    assert.equal(build.result!.simulated, false, 'a local code + authored-audio programme is not simulated');
    const codeOperations = build.operations.filter(operation => operation.kind === 'browser');
    assert.equal(codeOperations.length, 1, 'the picture is exactly one code operation');
    assert.equal(codeOperations[0].reused, false, 'the first build must actually capture the picture');
    const final = build.artifacts.find(artifact => artifact.id === build.result!.artifact);
    assert.ok(final && final.media, 'the delivered movie must carry media facts');
    assert.equal(final!.media!.frames, EVENT + 1 + HOLD_OUT, 'the programme holds exactly the derived frame count');
    assert.ok(final!.media!.audio, 'the delivered movie must carry the mixed authored audio');

    // Change ONLY the sound, through the normal writer.
    const before = await loadProject(projectRoot);
    const edited = structuredClone(before);
    const clip = edited.composition!.audio.find(candidate => candidate.kind === 'asset')!;
    clip.gain = 0.35;
    const saved = await saveProject(projectRoot, edited, before.revision);
    const savedClip = saved.composition!.audio.find(candidate => candidate.kind === 'asset')!;
    assert.equal(savedClip.gain, 0.35, 'only the authored clip gain changed');

    // The read-only preflight predicts the picture is unchanged.
    const plan = await planBuild(projectRoot);
    assert.equal(plan.blockers.length, 0, `the plan must have no blockers: ${JSON.stringify(plan.blockers)}`);
    const reused = plan.reuse.filter(entry => entry.subject === CODE_SOURCE);
    assert.equal(
      reused.length,
      1,
      `the picture code Source must be classified reusable; reuse=${JSON.stringify(plan.reuse)}`,
    );
    assert.ok(
      !plan.work.some(entry => entry.subject === CODE_SOURCE),
      'the picture must not appear as work after a sound-only change',
    );

    console.log(
      `[event-sync] (D) build=${build.id} status=${build.status} pictureOps=${codeOperations.length} reused=${reused.length} work=${plan.work.length}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
