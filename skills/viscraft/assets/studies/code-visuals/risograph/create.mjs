/*
 * Viscraft recipe: instantiate the risograph (spot-colour separation) reference
 * into a NEW Project.
 *
 *   viscraft author create.mjs <new-project-directory> [--options <options.json>]
 *
 * Options: { "width": 1920, "height": 1080, "frames": 96,
 *            "variant": "both" | "riverside" | "bakery" }
 *
 * The Runtime owns loading, hashing, copying, licence carriage and publication.
 * This file is the editable creative declaration: the two ride variants, their
 * plate-gate timing, seeds, picture/sound Sources and the music/Foley clips. The
 * implementation lives in `scene.mjs` + `draw.mjs` + `rider.mjs` + `riso.mjs`,
 * `score.mjs` + `foley.mjs` + the local `synth.mjs` copy, and the shared
 * `action-facts.mjs`.
 *
 * One packed RGB canvas carries all three ink separations; the WebGL2 printer
 * applies independent registration, halftone, grain, paper and roller gates.
 * The two Sources share the same entry and modules but change place, route,
 * object and event. The audio is two local four-second cues per ride: one bossa
 * music Source and one Foley Source, each with its own entry and resources.
 * No fonts, samples, voice, provider or upstream film is used.
 *
 * Adapted from lemo-opuscar styles/risograph/demo/{riso,draw,rider}.js
 * @e3cb16f63768c68693ff0e15171d6e755457cc32 (LemoLab, MIT). The Rider character
 * shapes and bicycle are retained from that design; the scenes, timing, actions,
 * score and Foley here are authored for this reference. `synth.mjs` is local to this audiovisual reference and adapts lemo-opuscar
 * styles/risograph/demo/music/{score,bell}.py at the same commit. `LICENSES.md`
 * carries the attribution and the MIT text; the Runtime's verbatim
 * `THIRD_PARTY_NOTICES.md` is located from the running Runtime. Build with the
 * separate command:
 *   viscraft build <project-directory>
 */
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FPS as RIDE_FPS, RIDE_FRAMES } from './action-facts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = 'risograph-scene.html';
const SCENE = 'scene.mjs';
const DRAW = 'draw.mjs';
const RIDER = 'rider.mjs';
const RISO = 'riso.mjs';
const FACTS = 'action-facts.mjs';
const SCORE = 'score.mjs';
const FOLEY = 'foley.mjs';
const SYNTH = 'synth.mjs';
const MUSIC_ENTRY = 'risograph-music.html';
const FOLEY_ENTRY = 'risograph-foley.html';
const README = 'README.md';
const LICENSES = 'LICENSES.md';
const NOTICE = 'THIRD_PARTY_NOTICES.md';

const MODULE_RIGHTS = {
  origin:
    'adapted from lemo-opuscar styles/risograph/demo/riso.js, draw.js and rider.js ' +
    '@e3cb16f63768c68693ff0e15171d6e755457cc32 (LemoLab), MIT',
  license: 'Apache-2.0 AND MIT',
  redistributable: true,
  author: 'LemoLab',
  attributionRequired: true,
  notice: 'MIT (c) 2026 LemoLab, lemo-opuscar e3cb16f63768c68693ff0e15171d6e755457cc32. Viscraft adaptations and original material are documented in LICENSES.md.',
  modifications:
    'Rewritten as dependency-free ES modules for the Viscraft Browser contract; one packed RGB plate ' +
    'instead of fixed 1920x1080 globals, English comments, model-sheet poses removed, scene composition ' +
    'and ride actions authored locally, no fonts, voice, samples or upstream film; the local score/Foley ' +
    'are separate original code.',
};

const SCENE_RIGHTS = {
  origin:
    'original: riverside and bakery ride compositions, plate-gate/registration timing and actions authored ' +
    'for the Viscraft risograph reference; they compose the MIT riso/draw/rider modules and consume the ' +
    'shared action-facts.mjs',
  license: 'Apache-2.0',
  redistributable: true,
};

const FACTS_RIGHTS = {
  origin:
    'original shared action facts for the risograph reference: per-variant press gates/sheet/registration, ' +
    'the riverside bell and pigeon flush, and the bakery reach/catch/stow and pigeon flap',
  license: 'Apache-2.0',
  redistributable: true,
};

const MUSIC_RIGHTS = {
  origin: 'original four-second bossa cue authored for the risograph reference; all voices are procedural',
  license: 'Apache-2.0',
  redistributable: true,
};

const FOLEY_RIGHTS = {
  origin: 'original ride Foley map and synthesis authored for the risograph reference; no recorded samples',
  license: 'Apache-2.0',
  redistributable: true,
};

const SYNTH_RIGHTS = {
  origin:
    'adapted locally ' +
    'from lemo-opuscar styles/risograph/demo/music/score.py and bell.py ' +
    '@e3cb16f63768c68693ff0e15171d6e755457cc32 (LemoLab), MIT',
  license: 'Apache-2.0 AND MIT',
  redistributable: true,
  author: 'LemoLab',
  attributionRequired: true,
  notice: 'MIT (c) 2026 LemoLab, lemo-opuscar e3cb16f63768c68693ff0e15171d6e755457cc32. Viscraft adaptations and original material are documented in LICENSES.md.',
  modifications:
    'Local dependency-free synthesis. The score, Foley event map and their local renderers are ' +
    'separate original code in this reference; no samples, fonts or voice are used.',
};

const ENTRY_RIGHTS = {
  origin: 'original Browser contract pages authored for the risograph picture/music/Foley entries',
  license: 'Apache-2.0',
  redistributable: true,
};

function slugToId(name) {
  const cleaned = String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'study';
  return ('riso-' + (/^[a-z0-9]/.test(cleaned) ? cleaned : 'p-' + cleaned)).slice(0, 96);
}

export default async function ({ root, options, runtime }) {
  const { width = 1920, height = 1080, frames = 96, variant = 'both' } = options ?? {};
  for (const [name, value] of Object.entries({ width, height, frames })) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`"${name}" must be a positive integer`);
  }
  if (width % 2 !== 0 || height % 2 !== 0) throw new Error('"width" and "height" must be even');
  if (frames < 24) throw new Error('"frames" must be at least 24 (one second at 24 fps)');
  if (!['both', 'riverside', 'bakery'].includes(variant))
    throw new Error('"variant" must be "both", "riverside" or "bakery"');

  const specs = [];
  if (variant !== 'bakery') specs.push({ id: 'river-ride', variant: 'riverside', seed: 9241, prefix: 'river' });
  if (variant !== 'riverside') specs.push({ id: 'bakery-catch', variant: 'bakery', seed: 9242, prefix: 'bakery' });

  // The picture keeps its existing per-Source length. The sound cue is the
  // authored four-second span; a shorter picture trims the cue (the same cut as
  // the ride), while a longer picture keeps the full cue and leaves the rest of
  // the ride without this cue. Do not silently stretch the cue.
  const soundFrames = Math.min(frames, RIDE_FRAMES);
  const soundDuration = soundFrames / RIDE_FPS;
  const soundSamples = Math.round(soundDuration * 48000);
  const samplesPerFrame = 48000 / RIDE_FPS;

  const pictureSources = specs.map(spec => ({
    id: spec.id,
    kind: 'browser',
    output: 'picture',
    entry: ENTRY,
    resources: [SCENE, DRAW, RIDER, RISO, FACTS],
    bindings: [],
    params: { variant: spec.variant, frames },
    seed: spec.seed,
    frames,
  }));
  const musicSources = specs.map(spec => ({
    id: `${spec.prefix}-music`,
    kind: 'browser',
    output: 'sound',
    entry: MUSIC_ENTRY,
    resources: [FACTS, SCORE, SYNTH],
    bindings: [],
    params: { role: 'music', variant: spec.variant, duration: soundDuration },
    seed: spec.seed,
    durationSamples: soundSamples,
    sampleRate: 48000,
  }));
  const foleySources = specs.map(spec => ({
    id: `${spec.prefix}-foley`,
    kind: 'browser',
    output: 'sound',
    entry: FOLEY_ENTRY,
    resources: [FACTS, FOLEY, SYNTH],
    bindings: [],
    params: { role: 'foley', variant: spec.variant, duration: soundDuration },
    seed: spec.seed,
    durationSamples: soundSamples,
    sampleRate: 48000,
  }));

  const look = {
    id: 'riso',
    description:
      'Three-plate risograph print: packed blue/yellow/pink separations, halftone screens, per-plate ' +
      'registration and paper grain; plates come on press one at a time.',
  };
  const sceneId = 'scene_ride';
  let cursor = 0;
  const shots = [];
  const placements = [];
  const rideStartFrames = {};
  for (const source of pictureSources) {
    rideStartFrames[source.id] = cursor;
    shots.push({
      id: `shot_${source.id}`,
      scene: sceneId,
      look: look.id,
      intent:
        source.params.variant === 'riverside'
          ? 'Riverside ride: bell, pigeon flush and parallax while the three plates come on press.'
          : 'Bakery street: the rider catches a baguette in passing while the three plates come on press.',
      targetFrames: frames,
    });
    placements.push({
      id: `pl_${source.id}`,
      shot: `shot_${source.id}`,
      source: source.id,
      inFrame: 0,
      outFrame: frames,
      startFrame: cursor,
      audio: 'mute',
    });
    cursor += frames;
  }

  const audio = [];
  for (const spec of specs) {
    const startSample = Math.round(rideStartFrames[spec.id] * samplesPerFrame);
    audio.push({
      id: `clip-${spec.prefix}-music`,
      kind: 'source',
      source: `${spec.prefix}-music`,
      startSample,
      gain: 0.9,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      bus: 'music',
    });
    audio.push({
      id: `clip-${spec.prefix}-foley`,
      kind: 'source',
      source: `${spec.prefix}-foley`,
      startSample,
      gain: 0.55,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      bus: 'foley',
    });
  }

  const files = [
    { path: ENTRY, sourcePath: join(HERE, ENTRY) },
    { path: SCENE, sourcePath: join(HERE, SCENE) },
    { path: DRAW, sourcePath: join(HERE, DRAW) },
    { path: RIDER, sourcePath: join(HERE, RIDER) },
    { path: RISO, sourcePath: join(HERE, RISO) },
    { path: FACTS, sourcePath: join(HERE, FACTS) },
    { path: SCORE, sourcePath: join(HERE, SCORE) },
    { path: FOLEY, sourcePath: join(HERE, FOLEY) },
    { path: SYNTH, sourcePath: join(HERE, SYNTH) },
    { path: MUSIC_ENTRY, sourcePath: join(HERE, MUSIC_ENTRY) },
    { path: FOLEY_ENTRY, sourcePath: join(HERE, FOLEY_ENTRY) },
    { path: README, sourcePath: join(HERE, README) },
    { path: LICENSES, sourcePath: join(HERE, LICENSES) },
    { path: NOTICE, sourcePath: join((await runtime.runtimeLocation(root)).path, NOTICE) },
  ];
  const assets = [
    { id: 'riso_entry', path: ENTRY, type: 'code', simulated: false, rights: ENTRY_RIGHTS },
    { id: 'riso_scene', path: SCENE, type: 'code', simulated: false, rights: SCENE_RIGHTS },
    { id: 'riso_draw', path: DRAW, type: 'code', simulated: false, rights: MODULE_RIGHTS },
    { id: 'riso_rider', path: RIDER, type: 'code', simulated: false, rights: MODULE_RIGHTS },
    { id: 'riso_printer', path: RISO, type: 'code', simulated: false, rights: MODULE_RIGHTS },
    { id: 'riso_facts', path: FACTS, type: 'code', simulated: false, rights: FACTS_RIGHTS },
    { id: 'riso_score', path: SCORE, type: 'code', simulated: false, rights: MUSIC_RIGHTS },
    { id: 'riso_foley', path: FOLEY, type: 'code', simulated: false, rights: FOLEY_RIGHTS },
    { id: 'riso_synth', path: SYNTH, type: 'code', simulated: false, rights: SYNTH_RIGHTS },
    { id: 'riso_music_entry', path: MUSIC_ENTRY, type: 'code', simulated: false, rights: ENTRY_RIGHTS },
    { id: 'riso_foley_entry', path: FOLEY_ENTRY, type: 'code', simulated: false, rights: ENTRY_RIGHTS },
  ];

  return {
    files,
    project: {
      schemaVersion: 1,
      id: slugToId(basename(root)),
      revision: 1,
      title: 'RISOGRAPH RIDE — three plates, one ride, local sound',
      direction: {
        intent:
          'A local risograph animation reference. One packed RGB plate carries three spot-ink separations; ' +
          'the printer applies independent registration, halftone screens, ink grain, paper and roller gates. ' +
          'The rider is adapted from LemoLab’s lanky Sunday Ride character on a vintage bicycle. ' +
          'Two authored four-second ride segments (riverside bell and pigeon flush; bakery baguette catch) show ' +
          'a readable action while the blue, yellow and pink plates come on press one at a time. Each ride has ' +
          'one local bossa music Source and one local Foley Source on separate music/foley buses; the picture ' +
          'placements stay mute.',
        looks: [look],
        transitions: [],
      },
      assets,
      bindings: {},
      handoff: [
        { path: NOTICE, role: 'license' },
        { path: LICENSES, role: 'license' },
        { path: README, role: 'readme' },
      ],
      sources: [...pictureSources, ...musicSources, ...foleySources],
      composition: {
        output: { width, height, fps: { numerator: RIDE_FPS, denominator: 1 }, sampleRate: 48000, channels: 2 },
        scenes: [{ id: sceneId, description: 'Two ride segments printed from one packed three-ink plate.' }],
        shots,
        placements,
        transitions: [],
        audio,
        mastering: { targetLufs: -16, truePeakDbfs: -1.5 },
      },
    },
  };
}
