/*
 * Viscraft recipe: instantiate the indexed-colour pixel-art study into a NEW
 * Project.
 *
 *   viscraft author create.mjs <new-project-directory> [--options <options.json>]
 *
 * The executable mechanics (loading, hashing, copying, licence carriage, Project
 * writing) belong to the Runtime. This file is the editable creative
 * declaration: the two variants, their captions and the Project shape. The
 * executable modules, entry page and local MIT text live beside this recipe and
 * are copied from here by `authorProject`.
 *
 * Two `browser` picture Sources share the SAME entry and modules:
 *
 *   - wren_offer variant "offer" — Wren walks in, kneels, casts; the crystal answers
 *   - arlo_guard variant "guard" — Arlo plants his sword in a non-combat guardian
 *     stance; the two shrine lamps light
 *
 * The subject is derived from the variant inside the scene, so no redundant
 * subject field is stored. Both Sources are silent; no font file is shipped.
 *
 * Authoring performs no provider work and no Build. Build with:
 *   viscraft build <project-directory>
 */
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PIXEL_LICENSE, PIXEL_RIGHTS } from './rights.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = 'pixel-art-scene.html';
const MODULES = ['pixel-art-scene.mjs', 'px.mjs', 'sprites.mjs', 'font.mjs'];
const LICENSE = PIXEL_LICENSE;
const LICENSES = 'LICENSES.md';
const NOTICE = 'THIRD_PARTY_NOTICES.md';

function slugToId(name) {
  const cleaned = String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'study';
  return ('pixel-art-' + (/^[a-z0-9]/.test(cleaned) ? cleaned : 'p-' + cleaned)).slice(0, 96);
}

export default async function ({ root, options, runtime }) {
  const { width = 1920, height = 1080, frames = 144 } = options ?? {};
  for (const [name, value] of Object.entries({ width, height, frames })) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`"${name}" must be a positive integer`);
  }
  if (width % 2 !== 0 || height % 2 !== 0) throw new Error('"width" and "height" must be even');
  if (frames < 2) throw new Error('"frames" must be at least 2');
  if (width < 320 || height < 180)
    throw new Error('"width" and "height" must be at least 320x180 so the 320x180 logical frame can be shown at an integer scale');

  const fps = 24;
  const sampleRate = 48000;
  const channels = 2;

  // Two content variants; the subject and every prop/pose are derived from the
  // variant inside the scene, not duplicated here.
  const specs = [
    {
      id: 'wren_offer',
      seed: 4201,
      params: { variant: 'offer', frames, caption: 'STILL SHRINE: RESTORED' },
    },
    {
      id: 'arlo_guard',
      seed: 4202,
      params: { variant: 'guard', frames, caption: 'THE KEEPING: HELD' },
    },
  ];

  const sources = specs.map(spec => ({
    id: spec.id,
    kind: 'browser',
    output: 'picture',
    entry: ENTRY,
    resources: [...MODULES],
    bindings: [],
    params: spec.params,
    seed: spec.seed,
    frames,
  }));

  const look = {
    id: 'indexed-shrine',
    description:
      'A 320x180 indexed-colour night shrine: a stepped pixel character rig, a hand-placed head, ' +
      'a protected-colour scarf and crystal, ordered-dither light and a palette flood as the environment answers.',
  };
  const sceneId = 'scene_shrine';
  let cursor = 0;
  const shots = [];
  const placements = [];
  for (const spec of specs) {
    shots.push({
      id: `shot_${spec.id}`,
      scene: sceneId,
      look: look.id,
      intent:
        spec.params.variant === 'offer'
          ? 'Wren walks in, kneels, raises the staff and the shrine crystal restores colour around it.'
          : 'Arlo plants his sword in a non-combat guardian stance, lowers his head, then lifts it as the two shrine lamps light.',
      targetFrames: frames,
    });
    placements.push({
      id: `pl_${spec.id}`,
      shot: `shot_${spec.id}`,
      source: spec.id,
      inFrame: 0,
      outFrame: frames,
      startFrame: cursor,
      audio: 'mute',
    });
    cursor += frames;
  }

  const files = [
    { path: ENTRY, sourcePath: join(HERE, ENTRY) },
    ...MODULES.map(module => ({ path: module, sourcePath: join(HERE, module) })),
    { path: LICENSE, sourcePath: join(HERE, LICENSE) },
    { path: LICENSES, sourcePath: join(HERE, LICENSES) },
    { path: NOTICE, sourcePath: join((await runtime.runtimeLocation(root)).path, NOTICE) },
  ];
  const assets = [
    { id: 'pixel_art_scene', path: ENTRY, type: 'code', simulated: false, rights: PIXEL_RIGHTS },
    ...MODULES.map((module, index) => ({
      id: ['pixel_art_stage', 'pixel_art_engine', 'pixel_art_sprites', 'pixel_art_font'][index],
      path: module,
      type: 'code',
      simulated: false,
      rights: PIXEL_RIGHTS,
    })),
  ];

  const project = {
    schemaVersion: 1,
    id: slugToId(basename(root)),
    revision: 1,
    title: 'PIXEL ART — the night shrine',
    direction: {
      intent:
        'Two silent pixel-art shots of one night shrine. Wren walks in, settles, kneels and raises her staff; ' +
        'the crystal answers and full colour returns through an ordered-dither wave while her scarf and the ' +
        'crystal keep their protected colours. The alternate shot is Arlo in a non-combat guardian stance: he ' +
        'plants his sword, bows his head and looks up as the two shrine lamps ignite and warm light spreads. ' +
        'This is a low-level character/animation study, not an RPG or an interactive system.',
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
      scenes: [{ id: sceneId, description: 'One locked night-shrine stage, staged twice with different subjects and responses.' }],
      shots,
      placements,
      transitions: [],
      audio: [],
    },
  };

  return { project, files };
}
