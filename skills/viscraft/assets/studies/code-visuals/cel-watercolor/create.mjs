/*
 * Viscraft recipe: instantiate the reusable cel + watercolour Look into a NEW Project.
 *
 *   viscraft author create.mjs <new-project-directory> [--options <options.json>]
 *
 * The executable mechanics (loading, hashing, copying, licence carriage, Project
 * writing) belong to the Runtime. This file is the editable
 * creative declaration: the two landscape subjects, the wash/pooling/grain
 * parameters, their palettes and the reveal length. The module implementation
 * (`cel-watercolor.mjs`) and the editable template scene live beside this recipe
 * and are copied from here by `authorProject`.
 *
 * Two `browser` picture Sources share the SAME entry
 * (cel-watercolor-scene.html) and module (cel-watercolor.mjs):
 *
 *   - grove-wash   subject "grove"  — a lone tree over layered cel hills
 *   - meadow-wash  subject "meadow" — rolling cel hills with shrubs and grass
 *
 * `revealFrames` is set to the source's frame count so the painting completes at
 * the end of the shot. `rights.mjs` records the shared module provenance, and
 * the Project carries the Runtime's verbatim THIRD_PARTY_NOTICES.md located from
 * the running Runtime. Hashes and revisions are filled by the Runtime from the
 * copied bytes.
 *
 * The Look is an independent reimplementation, not a source copy: only the
 * canvas-2D mechanisms were adapted from the MIT files named in the origin.
 * Authoring performs no provider work. Build with the separate command:
 *   viscraft build <project-directory>
 */
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CEL_WATERCOLOR_MODULE, CEL_WATERCOLOR_RIGHTS } from './rights.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = 'cel-watercolor-scene.html';
const MODULE = CEL_WATERCOLOR_MODULE;
const NOTICE = 'THIRD_PARTY_NOTICES.md';
const LICENSES = 'LICENSES.md';
const SCENE_RIGHTS = {
  origin:
    'adapted from lemo-opuscar styles/cel-anime-80s/demo/cel.js and styles/watercolor/demo/engine.js,plants.js,scene.js@e3cb16f63768c68693ff0e15171d6e755457cc32 (LemoLab), MIT',
  license: 'Apache-2.0 AND MIT',
  redistributable: true,
};

function slugToId(name) {
  const cleaned = String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'study';
  return ('cw-' + (/^[a-z0-9]/.test(cleaned) ? cleaned : 'p-' + cleaned)).slice(0, 96);
}

export default async function ({ root, options, runtime }) {
  const { width = 1920, height = 1080, frames: perSourceFrames = 24 } = options ?? {};
  for (const [name, value] of Object.entries({ width, height, frames: perSourceFrames })) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`"${name}" must be a positive integer`);
  }
  if (width % 2 !== 0 || height % 2 !== 0) throw new Error('"width" and "height" must be even');

  const fps = 24;
  const sampleRate = 48000;
  const channels = 2;
  // The painting completes on the last authored frame of each shot.
  const revealFrames = Math.max(1, perSourceFrames - 1);

  // ---- two parameterized subjects, one Look module -------------------------
  const GROVE_PARAMS = {
    subject: 'grove',
    layout: 'wide',
    revealFrames,
    celEdge: 0.85,
    azimuth: 2.25,
    bleed: 0.6,
    wetEdge: 0.6,
    pooling: 0.5,
    grain: 0.35,
    inkWeight: 2.6,
    misregistration: { dx: 0.8, dy: -0.6 },
    density: 1,
    palette: {
      paper: '#f2ead9',
      sky: '#cdd7d8',
      skyDeep: '#aabcc2',
      hillFar: '#a9b79b',
      hillMid: '#829677',
      hillNear: '#6f8468',
      ground: '#cdbf94',
      trunk: '#7a6a57',
      leaf: '#5f8a52',
      leafDeep: '#3f6a3e',
      ink: '#2b2520',
      accent: '#c06a45',
    },
  };
  const MEADOW_PARAMS = {
    subject: 'meadow',
    layout: 'wide',
    revealFrames,
    celEdge: 0.75,
    azimuth: 2.55,
    bleed: 0.5,
    wetEdge: 0.5,
    pooling: 0.45,
    grain: 0.4,
    inkWeight: 2.2,
    misregistration: { dx: -0.7, dy: 0.5 },
    density: 1.25,
    palette: {
      paper: '#eee8dc',
      sky: '#c6d2d6',
      skyDeep: '#9db3bd',
      hillFar: '#9fb294',
      hillMid: '#7b9070',
      hillNear: '#65805f',
      ground: '#c8bb92',
      trunk: '#75685a',
      leaf: '#5a8a54',
      leafDeep: '#3b6a40',
      ink: '#282320',
      accent: '#b96448',
    },
  };

  const specs = [
    { id: 'grove-wash', seed: 6101, params: GROVE_PARAMS },
    { id: 'meadow-wash', seed: 6102, params: MEADOW_PARAMS },
  ];
  const sources = specs.map((spec) => ({
    id: spec.id,
    kind: 'browser',
    output: 'picture',
    entry: ENTRY,
    resources: [MODULE],
    bindings: [],
    params: spec.params,
    seed: spec.seed,
    frames: perSourceFrames,
  }));

  const look = { id: 'cel-watercolor', description: 'Cel base + hard terminator + misregistered ink, painted with washes, wet edges, pigment pooling and procedural paper grain; the paint builds up over the shot.' };
  const sceneId = 'scene_main';
  let cursor = 0;
  const shots = [];
  const placements = [];
  for (const source of sources) {
    shots.push({ id: `shot_${source.id}`, scene: sceneId, look: look.id, intent: `Cel + watercolour ${source.params.subject} authored from params + seed; paint reveals over ${revealFrames} frames.`, targetFrames: source.frames });
    placements.push({ id: `pl_${source.id}`, shot: `shot_${source.id}`, source: source.id, inFrame: 0, outFrame: source.frames, startFrame: cursor, audio: 'mute' });
    cursor += source.frames;
  }

  // ---- the module + template scene beside this recipe + the Runtime notice --
  const files = [
    { path: ENTRY, sourcePath: join(HERE, ENTRY) },
    { path: MODULE, sourcePath: join(HERE, MODULE) },
    { path: LICENSES, sourcePath: join(HERE, LICENSES) },
    { path: NOTICE, sourcePath: join((await runtime.runtimeLocation(root)).path, NOTICE) },
  ];
  const assets = [
    { id: 'cw_scene', path: ENTRY, type: 'code', simulated: false, rights: SCENE_RIGHTS },
    { id: 'cw_module', path: MODULE, type: 'code', simulated: false, rights: CEL_WATERCOLOR_RIGHTS },
  ];

  const project = {
    schemaVersion: 1,
    id: slugToId(basename(root)),
    revision: 1,
    title: 'CEL WATERCOLOUR — reusable cel + wash Look',
    direction: {
      intent:
        'One reusable cel + watercolour module: a flat cel base, a hard terminator, pigment pooling, a broken wet edge, procedural paper grain and a misregistered ink contour, with the paint building up over the shot. Two landscape subjects (a grove and a meadow) share one entry. A stylized Look, not photorealism or recovered paint layers.',
      looks: [look],
      transitions: [],
    },
    assets,
    bindings: {},
    handoff: [
      { path: NOTICE, role: 'license' },
      { path: LICENSES, role: 'license' },
    ],
    sources,
    composition: {
      output: { width, height, fps: { numerator: fps, denominator: 1 }, sampleRate, channels },
      scenes: [{ id: sceneId, description: 'Two cel + watercolour landscapes sharing one Look module.' }],
      shots,
      placements,
      transitions: [],
      audio: [],
    },
  };

  return { project, files };
}
