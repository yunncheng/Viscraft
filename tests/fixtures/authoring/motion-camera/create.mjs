/*
 * Viscraft recipe: instantiate the reusable MOTION + CAMERA planner into a NEW Project.
 *
 *   viscraft author create.mjs <new-project-directory> [--options <options.json>]
 *
 * The executable mechanics (loading, hashing, copying, licence carriage, Project
 * writing) belong to the Runtime. This file is the editable
 * creative declaration: the camera track, the aim, the hold/ease choices and
 * the callout cadence. The module implementation (`motion-camera.mjs`) and the
 * editable template scene live beside this recipe and are copied from here by
 * `authorProject`.
 *
 * `rights.mjs` records the shared module provenance (also imported by the
 * contact study), and the Project carries the Runtime's verbatim
 * THIRD_PARTY_NOTICES.md located from the running Runtime. Hashes and revisions
 * are filled by the Runtime from the copied bytes.
 *
 * The Source imports ./motion-camera.mjs, which is adapted from
 * huashu-art-motion (alchaincyf, MIT); the Assets carry that origin, the
 * Manim-derivation notice and `redistributable: true`. Authoring performs no
 * provider work. Build with the separate command:
 *   viscraft build <project-directory>
 */
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOTION_CAMERA_MODULE, MOTION_CAMERA_RIGHTS } from './rights.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = 'motion-scene.html';
const MODULE = MOTION_CAMERA_MODULE;
const NOTICE = 'THIRD_PARTY_NOTICES.md';
// The scene HTML is part of the same adapted Look, so it records the SAME
// rights table as the module (as the original registration did): origin,
// author, attributionRequired, modifications and the Manim-derivation notice.
const SCENE_RIGHTS = MOTION_CAMERA_RIGHTS;

function slugToId(name) {
  const cleaned = String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'study';
  return ('mc-' + (/^[a-z0-9]/.test(cleaned) ? cleaned : 'p-' + cleaned)).slice(0, 96);
}

export default async function ({ root, options, runtime }) {
  const { width = 640, height = 360, frames = 24 } = options ?? {};
  for (const [name, value] of Object.entries({ width, height, frames })) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`"${name}" must be a positive integer`);
  }
  if (width % 2 !== 0 || height % 2 !== 0) throw new Error('"width" and "height" must be even');

  const fps = 24;
  const sampleRate = 48000;
  const channels = 2;
  const seed = 7317;

  // ---- one Source; the scene's `layout` selects the creative reading --------
  // Keys carry a FRACTION f (0..1) of the scope so the same move plays at any
  // capture length (see motion-scene.html). The aim world point is the subject.
  const CAMERA_PARAMS = {
    layout: 'survey',
    stage: { width: 1600, height: 900 },
    fit: 'cover',
    startFrame: 0,
    fps,
    frames, // MUST equal the Source's authored length
    holdIn: 0,
    holdOut: 0,
    ease: 'cubicInOut',
    revealEase: 'backOut',
    drift: { amp: 0, seed: 0 },
    bounds: null,
    callouts: 6,
    keys: [
      { f: 0, x: 800, y: 450, z: 1, ease: 'sineInOut' },
      { f: 0.62, x: 1000, y: 472, z: 1.9, ease: 'sineInOut' },
      { f: 1, x: 1180, y: 470, z: 3.4, ease: 'smooth' },
    ],
    aim: { world: { x: 1180, y: 470 }, screen: { x: 0.5, y: 0.5 } },
  };

  const sources = [
    {
      id: 'mc_main',
      kind: 'browser',
      output: 'picture',
      entry: ENTRY,
      resources: [MODULE],
      bindings: [],
      params: CAMERA_PARAMS,
      seed,
      frames,
    },
  ];

  const look = { id: 'travel', description: 'Keyframe camera travel with an aim hold and a staggered screen reveal.' };
  const sceneId = 'scene_main';
  const shots = [{ id: 'shot_main', scene: sceneId, look: look.id, intent: 'A keyframed camera pushes onto an aimed subject while callouts reveal on a staggered cadence.', targetFrames: frames }];
  const placements = [{ id: 'pl_main', shot: 'shot_main', source: 'mc_main', inFrame: 0, outFrame: frames, startFrame: 0, audio: 'mute' }];

  // ---- the module + template scene beside this recipe + the Runtime notice --
  const files = [
    { path: ENTRY, sourcePath: join(HERE, ENTRY) },
    { path: MODULE, sourcePath: join(HERE, MODULE) },
    { path: NOTICE, sourcePath: join((await runtime.runtimeLocation(root)).path, NOTICE) },
  ];
  const assets = [
    { id: 'mc_scene', path: ENTRY, type: 'code', simulated: false, rights: SCENE_RIGHTS },
    { id: 'mc_module', path: MODULE, type: 'code', simulated: false, rights: MOTION_CAMERA_RIGHTS },
  ];

  const project = {
    schemaVersion: 1,
    id: slugToId(basename(root)),
    revision: 1,
    title: 'MOTION CAMERA — keyframe track + aim',
    direction: {
      intent:
        'A code-only study of the shared motion + camera module: one continuous world drawn every frame through a keyframe camera track whose aim holds a chosen subject on the screen centre while the zoom is planned in log space. Screen callouts arrive on a segmented, staggered cadence. The camera is a pure function of the frame, so ordered and shuffled sampling agree exactly and the move never depends on render cost.',
      looks: [look],
      transitions: [],
    },
    assets,
    bindings: {},
    handoff: [{ path: NOTICE, role: 'license' }],
    sources,
    composition: {
      output: { width, height, fps: { numerator: fps, denominator: 1 }, sampleRate, channels },
      scenes: [{ id: sceneId, description: 'One keyframe camera travel over a shared world.' }],
      shots,
      placements,
      transitions: [],
      audio: [],
    },
  };

  return { project, files };
}
