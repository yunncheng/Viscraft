/*
 * Viscraft recipe: instantiate the reusable cel-layering Look into a NEW Project.
 *
 *   viscraft author create.mjs <new-project-directory> [--options <options.json>]
 *
 * The executable mechanics (loading, hashing, copying, licence carriage, Project
 * writing) belong to the Runtime. This file is the editable
 * creative declaration: the two subjects, their palettes, pose cadence, lighting,
 * hatch marks and Project ids. The module implementation (`cel.mjs`) and the
 * editable template scene live beside this recipe and are copied from here by
 * `authorProject`; this file declares their paths, rights and handoff.
 *
 * Two `browser` picture Sources share the SAME entry (cel-scene.html) and module
 * (cel.mjs):
 *
 *   - figure-walk   subject "figure"  — a two-legged walking figure (wide layout)
 *   - vehicle-roll  subject "vehicle" — a wheeled vehicle whose wheels roll by
 *                                      travelled distance / radius
 *
 * The Project carries the Runtime's verbatim THIRD_PARTY_NOTICES.md, located
 * from the running Runtime. Hashes and revisions are filled by the Runtime from
 * the copied bytes.
 *
 * Authoring performs no provider work. Build with the separate command:
 *   viscraft build <project-directory>
 */
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = 'cel-scene.html';
const MODULE = 'cel.mjs';
const SCENE_RIGHTS = { origin: 'original: authored for Viscraft as tests/fixtures/authoring/cel-figure', license: 'CC0-1.0', redistributable: true };
const MODULE_RIGHTS = { origin: 'original: authored for Viscraft as the cel-figure reference module', license: 'CC0-1.0', redistributable: true };
const NOTICE = 'THIRD_PARTY_NOTICES.md';

function slugToId(name) {
  const cleaned = String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'study';
  return ('cel-' + (/^[a-z0-9]/.test(cleaned) ? cleaned : 'p-' + cleaned)).slice(0, 96);
}

export default async function ({ root, options, runtime }) {
  const { width = 640, height = 360, frames: perSourceFrames = 24 } = options ?? {};
  for (const [name, value] of Object.entries({ width, height, frames: perSourceFrames })) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`"${name}" must be a positive integer`);
  }
  if (width % 2 !== 0 || height % 2 !== 0) throw new Error('"width" and "height" must be even');

  const fps = 24;
  const sampleRate = 48000;
  const channels = 2;

  // ---- two parameterized subjects/layouts, one Look module ------------------
  const FIGURE_PARAMS = {
    subject: 'figure',
    layout: 'wide',
    poseRate: 8,
    lineWidth: 3.2,
    shadowAzimuth: 2.35,
    shadowLength: 0.95,
    registration: { dx: 0.9, dy: -0.7 },
    lightDrift: 0.25,
    motion: 1,
    speed: 1.15,
    hatchCount: 26,
    palette: { bg: '#2b2440', base: '#efd9b8', shadow: '#8a5a7a', shadowOpacity: 0.45, highlight: '#fff3d2', highlightOpacity: 0.5, line: '#221a28', ink: '#3a2f45' },
  };
  const VEHICLE_PARAMS = {
    subject: 'vehicle',
    layout: 'wide',
    poseRate: 6,
    lineWidth: 3.6,
    shadowAzimuth: 2.15,
    shadowLength: 1.05,
    registration: { dx: 1.1, dy: -0.6 },
    lightDrift: 0.18,
    motion: 1,
    speed: 1.3,
    hatchCount: 30,
    palette: { bg: '#12232e', base: '#e7c65a', shadow: '#7a4a2a', shadowOpacity: 0.5, highlight: '#fff0b0', highlightOpacity: 0.45, line: '#0d1a20', ink: '#40311a' },
  };

  const specs = [
    { id: 'figure-walk', seed: 4021, params: FIGURE_PARAMS },
    { id: 'vehicle-roll', seed: 4022, params: VEHICLE_PARAMS },
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

  const look = { id: 'cel', description: 'Ordered cel-layer Look: flat base, hard offset shadow, highlight, inked misregistered line.' };
  const sceneId = 'scene_main';
  let cursor = 0;
  const shots = [];
  const placements = [];
  for (const source of sources) {
    shots.push({ id: `shot_${source.id}`, scene: sceneId, look: look.id, intent: `Cel-layered ${source.params.subject} authored from params + seed.`, targetFrames: source.frames });
    placements.push({ id: `pl_${source.id}`, shot: `shot_${source.id}`, source: source.id, inFrame: 0, outFrame: source.frames, startFrame: cursor, audio: 'mute' });
    cursor += source.frames;
  }

  // ---- the module + template scene beside this recipe + the Runtime notice --
  const files = [
    { path: ENTRY, sourcePath: join(HERE, ENTRY) },
    { path: MODULE, sourcePath: join(HERE, MODULE) },
    { path: NOTICE, sourcePath: join((await runtime.runtimeLocation(root)).path, NOTICE) },
  ];
  const assets = [
    { id: 'cel_scene', path: ENTRY, type: 'code', simulated: false, rights: SCENE_RIGHTS },
    { id: 'cel_module', path: MODULE, type: 'code', simulated: false, rights: MODULE_RIGHTS },
  ];

  const project = {
    schemaVersion: 1,
    id: slugToId(basename(root)),
    revision: 1,
    title: 'CEL FIGURE — reusable cel-layering Look',
    direction: {
      intent: 'A single reusable cel-layering module (ordered base → shadow → highlight → line stack) drawn on two subjects from one entry. Subject pose is quantized to a held cel cadence; lighting and the inked registration use the actual frame time. Stylized cel figure/vehicle, not photorealism.',
      looks: [look],
      transitions: [],
    },
    assets,
    bindings: {},
    handoff: [{ path: NOTICE, role: 'license' }],
    sources,
    composition: {
      output: { width, height, fps: { numerator: fps, denominator: 1 }, sampleRate, channels },
      scenes: [{ id: sceneId, description: 'Two cel-layered subjects sharing one Look module.' }],
      shots,
      placements,
      transitions: [],
      audio: [],
    },
  };

  return { project, files };
}
