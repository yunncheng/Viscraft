/*
 * Viscraft recipe: vendor the distributable SCREEN-ANCHOR SCALE-REVEAL camera
 * into a fresh Project directory.
 *
 *   viscraft author create.mjs <new-project-directory> [--options <options.json>]
 *
 * The executable mechanics (loading, hashing, copying, licence carriage, Project
 * writing) belong to the Runtime. This file is the editable
 * creative declaration: the camera parameters and the optional title/look
 * overrides. The module implementation (`scale-reveal.mjs`) and the editable
 * template scene live beside this recipe and are copied from here by
 * `authorProject`.
 *
 * The Project carries the Runtime's verbatim THIRD_PARTY_NOTICES.md located from
 * the running Runtime. Hashes and revisions are filled by the Runtime from the
 * copied bytes.
 *
 * Nothing here reaches the network and nothing depends on host state, so the
 * Project can be moved or renamed and still build; no absolute host path is
 * written into the Project.
 *
 * options.json (all optional; defaults are a fixed, deterministic smoke config):
 *   { "title", "width", "height", "fps", "sampleRate", "channels", "frames",
 *     "seed", "look": {"id","description"}, "params": { ... } }
 *
 * Build with the separate command:
 *   viscraft build <project-directory>
 */
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = 'scale-scene.html';
const MODULE = 'scale-reveal.mjs';
const NOTICE = 'THIRD_PARTY_NOTICES.md';
const SOURCE_ID = 'src_scale_reveal';
const SCENE_ID = 'scene_main';
const SHOT_ID = 'shot_scale_reveal';
const PLACEMENT_ID = 'pl_scale_reveal';
const SCENE_RIGHTS = {
  origin: 'original: authored for Viscraft as tests/fixtures/authoring/scale-reveal',
  license: 'CC0-1.0',
  redistributable: true,
};
const MODULE_RIGHTS = { origin: 'original: authored for Viscraft as the scale-reveal reference module', license: 'CC0-1.0', redistributable: true };

function slugToId(name) {
  const cleaned = String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'study';
  return ('scale-' + (/^[a-z0-9]/.test(cleaned) ? cleaned : 'p-' + cleaned)).slice(0, 96);
}

export default async function ({ root, options, runtime }) {
  const settings = options ?? {};
  const width = settings.width ?? 640;
  const height = settings.height ?? 360;
  const fps = settings.fps ?? 24;
  const sampleRate = settings.sampleRate ?? 48000;
  const channels = settings.channels ?? 2;
  const frames = settings.frames ?? 96;
  const seed = Number.isInteger(settings.seed) ? settings.seed : 7;
  if (!Number.isInteger(width) || width <= 0 || width % 2 !== 0) throw new Error('"width" must be a positive even integer');
  if (!Number.isInteger(height) || height <= 0 || height % 2 !== 0) throw new Error('"height" must be a positive even integer');
  if (!Number.isInteger(fps) || fps <= 0) throw new Error('"fps" must be a positive integer');
  if (!Number.isInteger(frames) || frames < 8) throw new Error('"frames" must be an integer >= 8');
  const look = settings.look ?? { id: 'survey', description: 'A cold survey world: grid, marks and a legible scale subject.' };

  // Camera parameters shipped in `params`; the scene merges them over its defaults.
  const cameraParams = {
    layout: 'beacon',
    worldAnchor: { x: 520, y: 360 },
    anchorScreen: { x: 0.62, y: 0.44 },
    zoom: { from: 1, to: 16 },
    ease: 'inOutCubic',
    holdIn: 4,
    holdOut: 8,
    startFrame: 0,
    frames,
    bounds: null,
    ...(settings.params ?? {}),
  };
  // `frames` is the camera scope and MUST match the Source's authored length.
  cameraParams.frames = frames;

  const source = {
    id: SOURCE_ID,
    kind: 'browser',
    output: 'picture',
    entry: ENTRY,
    resources: [MODULE],
    bindings: [],
    params: cameraParams,
    seed,
    frames,
  };

  // ---- the module + template scene beside this recipe + the Runtime notice --
  const files = [
    { path: ENTRY, sourcePath: join(HERE, ENTRY) },
    { path: MODULE, sourcePath: join(HERE, MODULE) },
    { path: NOTICE, sourcePath: join((await runtime.runtimeLocation(root)).path, NOTICE) },
  ];
  const assets = [
    { id: 'scale_reveal_scene', path: ENTRY, type: 'code', simulated: false, rights: SCENE_RIGHTS },
    { id: 'scale_reveal_module', path: MODULE, type: 'code', simulated: false, rights: MODULE_RIGHTS },
  ];

  const project = {
    schemaVersion: 1,
    id: slugToId(basename(root)),
    revision: 1,
    title: settings.title ?? 'SCALE REVEAL — screen-anchor study',
    direction: {
      intent:
        'A code-only scale reveal authored with the shared screen-anchor camera module. The scene imports scale-reveal.mjs by relative path, holds a chosen world point ' +
        'on a chosen screen fraction while the zoom is planned in log space, and exposes start/stop holds, an optional centre clamp and a scope. The camera is a pure ' +
        'function of the frame, so ordered and shuffled sampling agree exactly and the move never depends on render cost.',
      looks: [{ id: look.id, description: look.description }],
      transitions: [],
    },
    assets,
    bindings: {},
    handoff: [{ path: NOTICE, role: 'license' }],
    sources: [source],
    composition: {
      output: { width, height, fps: { numerator: fps, denominator: 1 }, sampleRate, channels },
      scenes: [{ id: SCENE_ID, description: settings.title ?? 'Scale reveal' }],
      shots: [{ id: SHOT_ID, scene: SCENE_ID, look: look.id, intent: 'Reveal: a wide survey pushes in to hold one detail, then settles.', targetFrames: frames }],
      placements: [{ id: PLACEMENT_ID, shot: SHOT_ID, source: SOURCE_ID, inFrame: 0, outFrame: frames, startFrame: 0, audio: 'mute' }],
      transitions: [],
      audio: [],
    },
  };

  return { project, files };
}
