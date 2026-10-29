/*
 * Viscraft recipe: instantiate the reusable procedural-paint Look into a NEW Project.
 *
 *   viscraft author create.mjs <new-project-directory> [--options <options.json>]
 *
 * The executable mechanics (loading, hashing, copying, licence carriage, Project
 * writing) belong to the Runtime. This file is the editable
 * creative declaration: the three mechanism modes, their stroke/layer/grain
 * parameters and their palettes. The module implementation
 * (`paint-material.mjs`) and the editable template scene live beside this recipe
 * and are copied from here by `authorProject`.
 *
 * Three `browser` picture Sources share the SAME entry (paint-scene.html) and
 * module (paint-material.mjs):
 *
 *   - wash-panel     mode "wash"    — layered watercolor washes over paper
 *   - brush-panel    mode "brush"   — ink-brush + impasto strokes with flying white
 *   - collage-panel  mode "collage" — torn-edge cut-paper cut-outs, tape, pins, marker
 *
 * `rights.mjs` records the shared module provenance (also imported by the
 * contact study), and the Project carries the Runtime's verbatim
 * THIRD_PARTY_NOTICES.md located from the running Runtime. Hashes and revisions
 * are filled by the Runtime from the copied bytes.
 *
 * The module is an MIT adaptation of huashu-art-motion's lib/paint.js,
 * lib/brush.js and lib/collage.js (shared helpers from lib/util.js). Authoring
 * performs no provider work. Build with the separate command:
 *   viscraft build <project-directory>
 */
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAINT_MATERIAL_MODULE, PAINT_MATERIAL_RIGHTS } from './rights.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = 'paint-scene.html';
const MODULE = PAINT_MATERIAL_MODULE;
const NOTICE = 'THIRD_PARTY_NOTICES.md';
const LICENSES = 'LICENSES.md';
const SCENE_RIGHTS = {
  origin:
    'adapted from huashu-art-motion scripts/engine/lib/paint.js, scripts/engine/lib/brush.js, ' +
    'scripts/engine/lib/collage.js and scripts/engine/lib/util.js@f178bd7754a71d6d399473af1501634548efa6cb (alchaincyf), MIT',
  license: 'Apache-2.0 AND MIT',
  redistributable: true,
};

function slugToId(name) {
  const cleaned = String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'study';
  return ('paint-' + (/^[a-z0-9]/.test(cleaned) ? cleaned : 'p-' + cleaned)).slice(0, 96);
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

  // ---- three modes, one Look module -----------------------------------------
  const WASH_PARAMS = {
    mode: 'wash',
    subject: 'landscape',
    revealSeconds: 1.2,
    washLayers: 6,
    washAlpha: 0.18,
    washAmp: 13,
    washEdge: 0.1,
    grainDensity: 0.05,
    grainAlpha: 0.15,
    palette: { paper: '#efe6d2', sky: '#a7c6d8', ground: '#cfa964', sun: '#e7a94a', hillBack: '#8aa892', hillFront: '#5f8268', subject: '#b9583f', ink: '#241c1a', accent: '#c94f3c' },
  };
  const BRUSH_PARAMS = {
    mode: 'brush',
    subject: 'still',
    revealSeconds: 1.2,
    inkWidth: 20,
    inkDry: 0.5,
    inkBristles: 10,
    inkTone: 0.9,
    inkStrokes: 9,
    boilFps: 0,
    grainDensity: 0.04,
    grainAlpha: 0.14,
    palette: { paper: '#efe6d2', sky: '#9db6c4', ground: '#c6a06a', sun: '#d99a3c', hillBack: '#7e9a86', hillFront: '#587a62', subject: '#a8493a', ink: '#20191a', accent: '#b8453a' },
  };
  const COLLAGE_PARAMS = {
    mode: 'collage',
    subject: 'landscape',
    revealSeconds: 1.2,
    collagePieces: 8,
    collageBorder: 10,
    collageRotate: 0.07,
    collageTape: true,
    collagePin: true,
    collageMarker: true,
    collageShadow: true,
    grainDensity: 0.06,
    grainAlpha: 0.16,
    palette: { paper: '#efe6d2', sky: '#a7c6d8', ground: '#cfa964', sun: '#e7a94a', hillBack: '#8aa892', hillFront: '#5f8268', subject: '#b9583f', ink: '#241c1a', accent: '#c94f3c' },
  };

  const specs = [
    { id: 'wash-panel', seed: 7301, params: WASH_PARAMS },
    { id: 'brush-panel', seed: 7302, params: BRUSH_PARAMS },
    { id: 'collage-panel', seed: 7303, params: COLLAGE_PARAMS },
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

  const look = { id: 'paint', description: 'Procedural paint Look: watercolor wash, ink/impasto brush and cut-paper collage modes over a shared mechanism module.' };
  const sceneId = 'scene_main';
  let cursor = 0;
  const shots = [];
  const placements = [];
  for (const source of sources) {
    shots.push({ id: `shot_${source.id}`, scene: sceneId, look: look.id, intent: `Procedural-paint "${source.params.mode}" authored from params + seed.`, targetFrames: source.frames });
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
    { id: 'paint_scene', path: ENTRY, type: 'code', simulated: false, rights: SCENE_RIGHTS },
    { id: 'paint_module', path: MODULE, type: 'code', simulated: false, rights: PAINT_MATERIAL_RIGHTS },
  ];

  const project = {
    schemaVersion: 1,
    id: slugToId(basename(root)),
    revision: 1,
    title: 'PAINT MATERIAL — reusable procedural paint/collage Look',
    direction: {
      intent: 'One reusable procedural-paint module exposing three mechanism families (watercolor wash, ink/impasto brush, cut-paper collage) drawn on one synthesized composition from one entry. Deterministic per (frame, seed, params); no wall clock and no unseeded randomness. A stylized painted/collaged Look, not photorealism and not a raster-paint engine.',
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
      scenes: [{ id: sceneId, description: 'Three procedural-paint modes sharing one mechanism module.' }],
      shots,
      placements,
      transitions: [],
      audio: [],
    },
  };

  return { project, files };
}
