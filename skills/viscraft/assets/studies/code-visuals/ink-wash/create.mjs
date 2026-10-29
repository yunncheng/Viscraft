/*
 * Viscraft recipe: instantiate the ink-wash hand-off into a NEW Project.
 *
 *   viscraft author create.mjs <new-project-directory> [--options <options.json>]
 *
 * The executable mechanics (loading, hashing, copying, licence carriage, Project
 * writing) belong to the Runtime. This file is the editable creative
 * declaration: the two scenes, their seeds and the Project shape. The module
 * implementation (`ink-wash.mjs`), the editable entry page and the local MIT
 * text live beside this recipe and are copied from here by `authorProject`.
 *
 * Two `browser` picture Sources share the SAME entry and module:
 *
 *   - river_crossing  variant "river" — bank → two touches on the water → leap
 *                     to the far bank → skid → settle
 *   - pine_salute     variant "pine"  — walk a mountain path with a staff →
 *                     plant it → a closer frontal fist-and-palm salute
 *
 * Both Sources are silent. No font, text or image is used: the marks are
 * strokes, washes and one vermilion chop drawn by code.
 *
 * The Project carries the Runtime's verbatim THIRD_PARTY_NOTICES.md and the
 * upstream MIT text as licence handoff files. Hashes and revisions are filled by
 * the Runtime from the copied bytes.
 *
 * Authoring performs no provider work. Build with the separate command:
 *   viscraft build <project-directory>
 */
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INK_LICENSE, INK_RIGHTS } from './rights.mjs';
import { DEFAULT_FRAMES, DEFAULT_HEIGHT, DEFAULT_WIDTH } from './ink-wash.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = 'ink-wash-scene.html';
const MODULE = 'ink-wash.mjs';
const LICENSE = INK_LICENSE;
const LICENSES = 'LICENSES.md';
const NOTICE = 'THIRD_PARTY_NOTICES.md';

function slugToId(name) {
  const cleaned = String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'study';
  return ('ink-wash-' + (/^[a-z0-9]/.test(cleaned) ? cleaned : 'p-' + cleaned)).slice(0, 96);
}

export default async function ({ root, options, runtime }) {
  const { width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT, frames: perSourceFrames = DEFAULT_FRAMES } = options ?? {};
  for (const [name, value] of Object.entries({ width, height, frames: perSourceFrames })) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`"${name}" must be a positive integer`);
  }
  if (width % 2 !== 0 || height % 2 !== 0) throw new Error('"width" and "height" must be even');

  const fps = 24;
  const sampleRate = 48000;
  const channels = 2;

  // ---- two scenes, one entry and one module --------------------------------
  const RIVER = { variant: 'river', frames: perSourceFrames };
  const PINE = { variant: 'pine', frames: perSourceFrames };

  const specs = [
    { id: 'river_crossing', seed: 7711, params: RIVER },
    { id: 'pine_salute', seed: 7712, params: PINE },
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

  const look = {
    id: 'xieyi-ink',
    description:
      'Xieyi ink on rice paper: loaded strokes carry their own contour, wet washes bleed and deposit an ' +
      'edge, dry bristles leave flying white, the paper stays empty, and one vermilion chop ends the scroll.',
  };
  const sceneId = 'scene_ink_wash';
  let cursor = 0;
  const shots = [];
  const placements = [];
  for (const spec of specs) {
    shots.push({
      id: `shot_${spec.id}`,
      scene: sceneId,
      look: look.id,
      intent:
        spec.params.variant === 'river'
          ? 'A xieyi figure touches the river twice, leaps to the far bank and settles; water rings and a low swell answer the landings.'
          : 'A xieyi figure walks a pine path with a staff, plants it and offers a fist-and-palm salute in a closer frontal frame.',
      targetFrames: perSourceFrames,
    });
    placements.push({
      id: `pl_${spec.id}`,
      shot: `shot_${spec.id}`,
      source: spec.id,
      inFrame: 0,
      outFrame: perSourceFrames,
      startFrame: cursor,
      audio: 'mute',
    });
    cursor += perSourceFrames;
  }

  // ---- local files + the Runtime's notice ----------------------------------
  const files = [
    { path: ENTRY, sourcePath: join(HERE, ENTRY) },
    { path: MODULE, sourcePath: join(HERE, MODULE) },
    { path: LICENSE, sourcePath: join(HERE, LICENSE) },
    { path: LICENSES, sourcePath: join(HERE, LICENSES) },
    { path: NOTICE, sourcePath: join((await runtime.runtimeLocation(root)).path, NOTICE) },
  ];
  const assets = [
    { id: 'ink_wash_scene', path: ENTRY, type: 'code', simulated: false, rights: INK_RIGHTS },
    { id: 'ink_wash_module', path: MODULE, type: 'code', simulated: false, rights: INK_RIGHTS },
  ];

  const project = {
    schemaVersion: 1,
    id: slugToId(basename(root)),
    revision: 1,
    title: 'INK WASH — spirit figure on paper',
    direction: {
      intent:
        'Two independent xieyi scenes on warm rice paper. The figure is a 100-unit rig drawn as one pale ' +
        'robe mass and loaded brushstrokes whose dark side is the contour; the hat is a wet mass with a ' +
        'burnt brim line. Water stays blank paper moved by faint dry streaks and open ink rings; the ' +
        'landscape is a pale far range, one nearer range and a low bank that dissolves into mist. Every ' +
        'stroke is deterministic: its seed comes from its index and its flying-white gaps follow a fixed ' +
        'reference length, with only a five-drawing width boil. The figure steps on twos at 12 fps while ' +
        'the camera, ink bloom, rings and swell advance on the 24 fps clock. Variant B changes the place ' +
        '(a pine path), the action (walk, plant the staff, salute), the framing (a closer frontal cut) ' +
        'and the props (a walking staff instead of water), not only a seed or a colour.',
      looks: [look],
      transitions: [],
    },
    assets,
    bindings: {},
    handoff: [
      { path: NOTICE, role: 'license' },
      { path: LICENSE, role: 'license' },
      { path: LICENSES, role: 'license' },
    ],
    sources,
    composition: {
      output: { width, height, fps: { numerator: fps, denominator: 1 }, sampleRate, channels },
      scenes: [{ id: sceneId, description: 'One paper stage, staged twice: river crossing and pine path.' }],
      shots,
      placements,
      transitions: [],
      audio: [],
    },
  };

  return { project, files };
}
