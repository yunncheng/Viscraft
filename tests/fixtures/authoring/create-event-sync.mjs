/*
 * Viscraft authoring fixture: ONE authored event drives picture, sound and subtitle.
 *
 *   viscraft author create-event-sync.mjs <new-project-directory> --options <json>
 *
 * The whole programme is derived from a SINGLE integer, `eventFrame` (an
 * option), the frame on the composition clock at which the authored event lands:
 *
 *   1. picture — a `browser` picture Source vendors the scale-reveal fixture scene
 *      (`scale-scene.html` + `scale-reveal.mjs`) byte-for-byte (registered as
 *      `code` Assets) and carries camera params chosen so the scale-reveal push
 *      reaches its TIGHT hold EXACTLY at the event frame. The module's own clock
 *      is local (source-frame) time; the event fact is the bridge to story time.
 *      If the push completes at local frame L and the placement trims T head
 *      frames (an in/out placement), the event lands at composition frame
 *      C = L - T on the story clock.
 *   2. sound — a real PCM signal file placed by an `asset` clip whose onset
 *      sample is `framesToSamples(C, fps, sampleRate)`, the canonical
 *      frame->sample map (never a hand-rolled `C * sampleRate / fps`). This
 *      fixture deliberately uses a plain signal: it is a mix/sync proof, not a
 *      claim that the reference has a default score.
 *   3. subtitle — a caption whose `startFrame` is C.
 *
 * Every derivation is invertible: moving `eventFrame` moves the picture's
 * declared event, the signal onset and the subtitle start together; changing the
 * head trim (`inFrame`) moves the composition event while the picture's local
 * event is unchanged.
 *
 * The Runtime does the loading, hashing, exclusive writes, validation and
 * Project commit. This file only declares the Project draft and the exact local
 * source files; nothing reaches the network, nothing is simulated, no provider
 * or credential is claimed, and no absolute host path is written into the
 * Project. The command helper passes the running Runtime for `framesToSamples`;
 * `authorProject` owns every write and the Project commit.
 *
 * options (the recipe contract):
 *   eventFrame       (required) the authored event frame on the composition clock
 *   inFrame          (optional, default 0) head trim of the code placement
 *   holdOut          (optional, default 4) tight-hold length after the push
 *   width/height     (optional, default 160/90; both positive even integers)
 *   fps              (optional, default 24; positive integer)
 *   sampleRate       (optional, default 48000)
 *   toneFrequency    (optional, default 220; signal frequency in Hz)
 *   title            (optional)
 */
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSignalAsset } from './lib/audio-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUDY_DIR = resolve(HERE, 'scale-reveal');
const ENTRY = 'scale-scene.html';
const MODULE = 'scale-reveal.mjs';
const SOURCE_ID = 'src_event_scale_reveal';
const SCENE_ID = 'scene_main';
const SHOT_ID = 'shot_event';
const PLACEMENT_ID = 'pl_event';

const RIGHTS = {
  origin: 'original: authored for this fixture by tests/fixtures/authoring/create-event-sync.mjs',
  license: 'CC0-1.0',
  redistributable: true,
};

function slugToId(name) {
  const cleaned =
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'study';
  return ('event-' + (/^[a-z0-9]/.test(cleaned) ? cleaned : 'p-' + cleaned)).slice(0, 96);
}

function integer(value, name, fallback) {
  if (value === undefined || value === '') {
    if (fallback === undefined) throw new Error(`${name} is required`);
    return fallback;
  }
  const number = typeof value === 'string' ? Number(value) : value;
  if (!Number.isInteger(number)) throw new Error(`${name} must be an integer, got "${value}"`);
  return number;
}

export default async function create({ root, options = {}, runtime }) {
  if (typeof runtime?.framesToSamples !== 'function')
    throw new Error('this fixture needs the installed Runtime (framesToSamples)');
  const width = integer(options.width, 'width', 160);
  const height = integer(options.height, 'height', 90);
  const fps = integer(options.fps, 'fps', 24);
  const sampleRate = integer(options.sampleRate, 'sampleRate', 48000);
  const channels = 2;
  const holdOut = integer(options.holdOut, 'holdOut', 4);
  const eventFrame = integer(options.eventFrame, 'eventFrame');
  const inFrame = integer(options.inFrame, 'inFrame', 0);
  const toneFrequency = options.toneFrequency === undefined ? 220 : Number(options.toneFrequency);
  const title =
    options.title ?? 'EVENT SYNC — one authored event drives picture, sound and subtitle';

  if (!Number.isInteger(width) || width <= 0 || width % 2 !== 0)
    throw new Error('width must be a positive even integer');
  if (!Number.isInteger(height) || height <= 0 || height % 2 !== 0)
    throw new Error('height must be a positive even integer');
  if (!Number.isInteger(fps) || fps <= 0) throw new Error('fps must be a positive integer');
  if (!Number.isFinite(toneFrequency) || toneFrequency < 20 || toneFrequency > 20000)
    throw new Error('toneFrequency must be within [20, 20000]');
  if (eventFrame < 0) throw new Error('eventFrame must be a nonnegative integer');
  if (inFrame < 0) throw new Error('inFrame must be a nonnegative integer');
  if (holdOut < 0) throw new Error('holdOut must be a nonnegative integer');

  // --- the single event fact -> local (source) time -> composition time ----
  //
  // scale-reveal reaches its tight hold at LOCAL frame `frames - 1 - holdOut`
  // (holdIn = 0), and the scope starts at `startFrame = 0`, so the local event
  // is `sourceLocalEvent = frames - 1 - holdOut`. A head trim of `inFrame`
  // frames maps source frame `f` to composition frame
  // `startFrame + (f - inFrame)`; therefore the composition event
  // `C = sourceLocalEvent - inFrame` and, inverting,
  // `frames = C + inFrame + 1 + holdOut`.
  const fpsSpec = { numerator: fps, denominator: 1 };
  const sourceLocalEvent = eventFrame + inFrame;
  const frames = sourceLocalEvent + 1 + holdOut;
  if (frames < 8) throw new Error(`derived source length ${frames} is too short; raise eventFrame/holdOut`);
  const compositionFrames = frames - inFrame;

  const cameraParams = {
    layout: 'beacon',
    worldAnchor: { x: 520, y: 360 },
    anchorScreen: { x: 0.62, y: 0.44 },
    zoom: { from: 1, to: 16 },
    ease: 'inOutCubic',
    holdIn: 0,
    holdOut,
    startFrame: 0,
    frames,
    bounds: null,
    // The authored event fact, declared on the picture so picture/sound/subtitle
    // share one number. `eventLocalFrame` records the module-local equivalent.
    eventFrame,
    eventLocalFrame: sourceLocalEvent,
  };

  // The canonical frame->sample map belongs to the Runtime; using it here is the
  // same map the Build and the tests use (never a hand-rolled ratio).
  const onsetSample = runtime.framesToSamples(eventFrame, fpsSpec, sampleRate);
  const toneDuration = runtime.framesToSamples(compositionFrames - eventFrame, fpsSpec, sampleRate, 'ceil');

  // A real PCM signal at the authored onset; the clip keeps the same gain and
  // exact start sample, so the event timing assertion is unchanged.
  const toneSignal = makeSignalAsset({
    id: 'event_signal',
    path: 'event-tone.wav',
    sampleRate,
    channels,
    samples: toneDuration,
    frequency: toneFrequency,
    waveform: 'sine',
  });
  const toneClip = {
    id: 'event_tone',
    kind: 'asset',
    asset: 'event_signal',
    inSample: 0,
    startSample: onsetSample,
    durationSamples: toneDuration,
    gain: 0.2,
    fadeInSamples: 0,
    fadeOutSamples: 0,
  };

  const project = {
    schemaVersion: 1,
    id: slugToId(basename(resolve(root))),
    revision: 1,
    title,
    direction: {
      intent:
        'One authored event frame drives all three tracks. A scale-reveal camera (imported from ./scale-reveal.mjs) reaches its tight hold at the event; a PCM signal clip ' +
        'starts at the canonical sample of that frame; a subtitle starts on it. Moving the event moves all three; trimming the head moves the composition event while ' +
        'the module-local event is unchanged.',
      looks: [
        { id: 'survey', description: 'A cold survey world: grid, marks and a legible scale subject.' },
      ],
      transitions: [],
    },
    assets: [
      { id: 'event_scene', path: ENTRY, type: 'code', simulated: false, rights: RIGHTS },
      { id: 'event_camera_module', path: MODULE, type: 'code', simulated: false, rights: RIGHTS },
      toneSignal.asset,
    ],
    bindings: {},
    sources: [
      {
        id: SOURCE_ID,
        kind: 'browser',
        output: 'picture',
        entry: ENTRY,
        resources: [MODULE],
        bindings: [],
        params: cameraParams,
        seed: 11,
        frames,
      },
    ],
    composition: {
      output: { width, height, fps: fpsSpec, sampleRate, channels },
      scenes: [{ id: SCENE_ID, description: 'Event-synced scale reveal' }],
      shots: [
        {
          id: SHOT_ID,
          scene: SCENE_ID,
          look: 'survey',
          intent: 'Push in to the event, then hold.',
          targetFrames: compositionFrames,
        },
      ],
      placements: [
        {
          id: PLACEMENT_ID,
          shot: SHOT_ID,
          source: SOURCE_ID,
          inFrame,
          outFrame: frames,
          startFrame: 0,
          audio: 'mute',
        },
      ],
      transitions: [],
      audio: [toneClip],
      subtitles: [
        {
          id: 'event_caption',
          text: 'the event',
          startFrame: eventFrame,
          endFrame: compositionFrames,
          fontSize: 14,
          color: '#dfe9ff',
        },
      ],
    },
  };

  return {
    project,
    files: [
      { path: ENTRY, sourcePath: join(STUDY_DIR, ENTRY) },
      { path: MODULE, sourcePath: join(STUDY_DIR, MODULE) },
      { path: toneSignal.asset.path, bytes: toneSignal.bytes },
    ],
  };
}
