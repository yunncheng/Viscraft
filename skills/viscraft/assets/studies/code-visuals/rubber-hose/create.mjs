/*
 * Viscraft recipe: author the rubber-hose acting reference into a NEW Project.
 *
 *   viscraft author create.mjs <new-project-directory> [--options <options.json>]
 *
 * The Runtime owns loading, hashing, copying, licence carriage and the Project
 * write. This file is the editable creative declaration: the two content
 * variants, their beat grid and the look parameters. The scene, actor kit and
 * ink engine live beside this recipe and are copied from here by authorProject.
 *
 * Options (all optional):
 *   width 1920, height 1080, frames 192, seed 8123,
 *   bpm 120, boilAmp 1.2, inkWeight 6, pushIn 0.035, damage 1
 *
 * Two `browser` picture Sources share one entry and one module:
 *
 *   spoon-stir   8 s at 24 fps. The mug and the sugar cube hand a spoon across
 *                the counter; the mug stirs, tastes, and the steam becomes a
 *                heart while both settle and hold.
 *   stair-clock  8 s at 24 fps. The sugar cube climbs a staircase of plates,
 *                one plate per two beats; the alarm clock wakes and rings.
 *
 * Both variants are real staging, props and contact, not a seed or palette
 * change. Authoring performs no Build, image render, provider submission or
 * network access. Build with the separate command:
 *   viscraft build <project-directory>
 */
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOSE_ACTORS,
  HOSE_ENTRY,
  HOSE_LICENSE,
  HOSE_LICENSES,
  HOSE_MODULE,
  HOSE_MODULE_RIGHTS,
  HOSE_SCENE_RIGHTS,
  HOSE_TOON,
} from './rights.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NOTICE = 'THIRD_PARTY_NOTICES.md';

function slugToId(name) {
  const cleaned =
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'study';
  return ('hose-' + (/^[a-z0-9]/.test(cleaned) ? cleaned : 'p-' + cleaned)).slice(0, 96);
}

export default async function ({ root, options, runtime }) {
  const {
    width = 1920,
    height = 1080,
    frames = 192,
    seed = 8123,
    bpm = 120,
    boilAmp = 1.2,
    inkWeight = 6,
    pushIn = 0.035,
    damage = 1,
  } = options ?? {};

  for (const [name, value] of Object.entries({ width, height, frames })) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`"${name}" must be a positive integer`);
  }
  if (width % 2 !== 0 || height % 2 !== 0) throw new Error('"width" and "height" must be even');
  if (!Number.isInteger(seed)) throw new Error('"seed" must be an integer');
  for (const [name, value, min, max] of [
    ['bpm', bpm, 60, 240],
    ['boilAmp', boilAmp, 0, 4],
    ['inkWeight', inkWeight, 3, 12],
    ['pushIn', pushIn, 0, 0.12],
    ['damage', damage, 0, 2],
  ]) {
    if (!Number.isFinite(value) || value < min || value > max)
      throw new Error(`"${name}" must be a number in [${min}, ${max}]`);
  }

  const fps = 24;
  const sampleRate = 48000;
  const channels = 2;
  const duration = frames / fps;

  const look = {
    id: 'rubber_hose',
    description:
      'A hand-inked rubber-hose beat: screen-space constant ink, pie eyes, noodle limbs and gloves, a 12 fps three-drawing boil over a 24 fps camera, one hard shadow band, props breathing on the beat, and a 4:3 film gate with weave and damage.',
  };

  const specs = [
    {
      id: 'spoon-stir',
      intent:
        'The mug and the sugar cube pass a spoon across the counter; the mug stirs its coffee, tastes it, and the steam turns into a heart while both hold the result.',
      seed,
    },
    {
      id: 'stair-clock',
      intent:
        'The sugar cube climbs a staircase of plates, pressing each plate as it lands, reaches the shelf and is answered by a ringing alarm clock.',
      seed: seed + 17,
    },
  ];

  const resources = [HOSE_MODULE, HOSE_TOON, HOSE_ACTORS];
  const sources = specs.map((spec) => ({
    id: spec.id,
    kind: 'browser',
    output: 'picture',
    entry: HOSE_ENTRY,
    resources,
    bindings: [],
    params: {
      variant: spec.id,
      bpm,
      boilAmp,
      inkWeight,
      pushIn,
      damage,
      duration,
    },
    seed: spec.seed,
    frames,
  }));

  const files = [
    { path: HOSE_ENTRY, sourcePath: join(HERE, HOSE_ENTRY) },
    { path: HOSE_MODULE, sourcePath: join(HERE, HOSE_MODULE) },
    { path: HOSE_TOON, sourcePath: join(HERE, HOSE_TOON) },
    { path: HOSE_ACTORS, sourcePath: join(HERE, HOSE_ACTORS) },
    { path: HOSE_LICENSES, sourcePath: join(HERE, HOSE_LICENSES) },
    { path: HOSE_LICENSE, sourcePath: join(HERE, HOSE_LICENSE) },
    { path: NOTICE, sourcePath: join((await runtime.runtimeLocation(root)).path, NOTICE) },
  ];
  const assets = [
    { id: 'hose_scene', path: HOSE_ENTRY, type: 'code', simulated: false, rights: HOSE_SCENE_RIGHTS },
    { id: 'hose_module', path: HOSE_MODULE, type: 'code', simulated: false, rights: HOSE_MODULE_RIGHTS },
    { id: 'hose_toon', path: HOSE_TOON, type: 'code', simulated: false, rights: HOSE_MODULE_RIGHTS },
    { id: 'hose_actors', path: HOSE_ACTORS, type: 'code', simulated: false, rights: HOSE_MODULE_RIGHTS },
  ];

  const sceneId = 'scene_stage';
  const shots = [];
  const placements = [];
  let cursor = 0;
  for (const source of sources) {
    shots.push({
      id: `shot_${source.id}`,
      scene: sceneId,
      look: look.id,
      intent: specs.find((s) => s.id === source.id).intent,
      targetFrames: source.frames,
    });
    placements.push({
      id: `pl_${source.id}`,
      shot: `shot_${source.id}`,
      source: source.id,
      inFrame: 0,
      outFrame: source.frames,
      startFrame: cursor,
      audio: 'mute',
    });
    cursor += source.frames;
  }

  const project = {
    schemaVersion: 1,
    id: slugToId(basename(root)),
    revision: 1,
    title: 'RUBBER HOSE — object actors, a real hand-off and a film gate',
    direction: {
      intent:
        'Two complete rubber-hose acting beats, not a look filter. A diner mug and a sugar cube really pass a spoon hand to hand; the mug stirs, tastes and reacts, and the steam turns into a heart. The second beat puts the cube on a staircase of plates until the alarm clock answers. Limbs are constant-width tubes, faces are pie eyes and glove hands, ink is constant in screen space and boils through three drawings at 12 fps while the camera and the film gate run at 24 fps. No font, voice, music or sample is included.',
      looks: [look],
      transitions: [],
    },
    assets,
    bindings: {},
    handoff: [
      { path: NOTICE, role: 'license' },
      { path: HOSE_LICENSES, role: 'license' },
      { path: HOSE_LICENSE, role: 'license' },
    ],
    sources,
    composition: {
      output: { width, height, fps: { numerator: fps, denominator: 1 }, sampleRate, channels },
      scenes: [{ id: sceneId, description: 'One stage set with two complete acting beats.' }],
      shots,
      placements,
      transitions: [],
      audio: [],
    },
  };

  return { project, files };
}
