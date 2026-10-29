/*
 * Viscraft recipe: author a crayon picture-book page into a NEW Project.
 *
 *   viscraft author create.mjs <new-project-directory> [--options <options.json>]
 *
 * The Runtime owns loading, hashing, copying, licence carriage and the Project
 * write. This file is the editable creative declaration: one page action in wax
 * crayon, the motif variant, the Project ids and material sound attached to visible mark growth. The page
 * implementation and its licence texts live beside this recipe and are copied
 * from here; the Runtime's verbatim THIRD_PARTY_NOTICES.md is added separately.
 *
 * Options (all optional):
 *   width 1920, height 1080, frames 240, seed 7321,
 *   motif "star" | "comet"
 *
 * `motif` is the meaningful content variant: "star" draws and lifts a five-
 * point star into the revealed constellation; "comet" gives the same drawn
 * object a tail and a launched reveal. The page action uses the same beats.
 *
 * The upstream mechanisms (crayon.js, gl.js, rig.js and four core/lib helpers)
 * are MIT, LemoLab 2026. The page, girl, star and constellation are original.
 * Authoring performs no provider work and no Build. Build with:
 *   viscraft build <project-directory>
 */
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CRAYON_ENGINE,
  CRAYON_GL,
  CRAYON_LICENSE,
  CRAYON_LICENSES,
  CRAYON_MODULE,
  CRAYON_RIGHTS,
  CRAYON_SCENE_RIGHTS,
} from './rights.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = 'crayon-book-scene.html';
const NOTICE = 'THIRD_PARTY_NOTICES.md';

function slugToId(name) {
  const cleaned = String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'study';
  return ('crayon-' + (/^[a-z0-9]/.test(cleaned) ? cleaned : 'p-' + cleaned)).slice(0, 96);
}

export default async function ({ root, options, runtime }) {
  const { width = 1920, height = 1080, frames = 240, seed = 7321, motif = 'star' } = options ?? {};
  for (const [name, value] of Object.entries({ width, height, frames })) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`"${name}" must be a positive integer`);
  }
  if (width % 2 !== 0 || height % 2 !== 0) throw new Error('"width" and "height" must be even');
  if (!Number.isInteger(seed)) throw new Error('"seed" must be an integer');
  if (motif !== 'star' && motif !== 'comet') throw new Error('"motif" must be "star" or "comet"');

  const fps = 24;
  const sampleRate = 48000;
  const channels = 2;
  const duration = frames / fps;
  const soundSamples = Math.round(duration * sampleRate);

  const look = {
    id: 'crayon_page',
    description:
      'A picture-book page drawn in wax crayon on toothy paper: pressure decides wax adhesion, one ultramarine wash reveals white-wax resist, and the camera moves continuously while drawings boil on twos.',
  };

  const source = {
    id: 'crayon_page',
    kind: 'browser',
    output: 'picture',
    entry: ENTRY,
    resources: [CRAYON_MODULE, CRAYON_ENGINE, CRAYON_GL, 'action-facts.mjs'],
    bindings: [],
    params: { duration, motif, seed },
    seed,
    frames,
  };

  const files = [
    { path: ENTRY, sourcePath: join(HERE, ENTRY) },
    { path: CRAYON_MODULE, sourcePath: join(HERE, CRAYON_MODULE) },
    { path: CRAYON_ENGINE, sourcePath: join(HERE, CRAYON_ENGINE) },
    { path: CRAYON_GL, sourcePath: join(HERE, CRAYON_GL) },
    { path: CRAYON_LICENSES, sourcePath: join(HERE, CRAYON_LICENSES) },
    { path: CRAYON_LICENSE, sourcePath: join(HERE, CRAYON_LICENSE) },
    { path: NOTICE, sourcePath: join((await runtime.runtimeLocation(root)).path, NOTICE) },
  ];
  const foleyRights = {
    origin: 'adapted from lemo-opuscar styles/urban-sketch/demo/audio/foley.py (pen/wet) and core/audio/sfx.py@e3cb16f63768c68693ff0e15171d6e755457cc32 (LemoLab), MIT; new mapping to this page action',
    license: 'Apache-2.0 AND MIT', redistributable: true,
    author: 'LemoLab',
    attributionRequired: true,
    notice: 'MIT (c) 2026 LemoLab, lemo-opuscar e3cb16f63768c68693ff0e15171d6e755457cc32; original page-action mapping and growth envelope (c) 2026 The Viscraft Authors. See LICENSES.md and LICENSE-LemoLab-MIT.txt.',
    modifications: 'Original page-action mapping and growth envelope by The Viscraft Authors; procedural texture, not a recording.',
  };
  for (const name of ['action-facts.mjs', 'foley.mjs', 'crayon-foley.html'])
    files.push({ path: name, sourcePath: join(HERE, name) });
  const assets = [
    { id: 'crayon_actions', path: 'action-facts.mjs', type: 'code', simulated: false, rights: CRAYON_SCENE_RIGHTS },
    { id: 'crayon_foley', path: 'foley.mjs', type: 'code', simulated: false, rights: foleyRights },
    { id: 'crayon_sound_entry', path: 'crayon-foley.html', type: 'code', simulated: false, rights: CRAYON_SCENE_RIGHTS },
    { id: 'crayon_scene', path: ENTRY, type: 'code', simulated: false, rights: CRAYON_SCENE_RIGHTS },
    { id: 'crayon_module', path: CRAYON_MODULE, type: 'code', simulated: false, rights: CRAYON_RIGHTS },
    { id: 'crayon_engine', path: CRAYON_ENGINE, type: 'code', simulated: false, rights: CRAYON_RIGHTS },
    { id: 'crayon_gl', path: CRAYON_GL, type: 'code', simulated: false, rights: CRAYON_RIGHTS },
  ];

  const project = {
    schemaVersion: 1,
    id: slugToId(basename(root)),
    revision: 1,
    title: 'CRAYON BOOK — drawn page, wax resist and one wash',
    direction: {
      intent:
        'One complete page action, not a style filter: a girl draws a star beside her in wax crayon, colours it in with visible pressure, reaches as it lifts, and a single ultramarine wash reveals a white-wax constellation that was on the paper from the start. The look comes from paper tooth, wax-pressure adhesion, directional hatching and watercolour resist. The story, character and star are original; material friction follows the same outline/colour/wash facts as the picture; no fonts, voices or music are included.',
      looks: [look],
      transitions: [],
    },
    assets,
    bindings: {},
    handoff: [
      { path: NOTICE, role: 'license' },
      { path: CRAYON_LICENSES, role: 'license' },
      { path: CRAYON_LICENSE, role: 'license' },
    ],
    sources: [source, {
      id: 'page_material_sound', kind: 'browser', output: 'sound',
      entry: 'crayon-foley.html', resources: ['foley.mjs', 'action-facts.mjs'],
      bindings: [], params: { duration }, seed,
      durationSamples: soundSamples, sampleRate,
    }],
    composition: {
      output: { width, height, fps: { numerator: fps, denominator: 1 }, sampleRate, channels },
      scenes: [{ id: 'scene_page', description: 'One drawn page: draw, colour, reach, wash.' }],
      shots: [
        {
          id: 'shot_page',
          scene: 'scene_page',
          look: look.id,
          intent:
            'A continuous page action: the star is drawn, coloured, plucked at the reach and answered by the wash-revealed constellation.',
          targetFrames: frames,
        },
      ],
      placements: [
        { id: 'pl_page', shot: 'shot_page', source: source.id, inFrame: 0, outFrame: frames, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio: [{ id: 'page_foley', kind: 'source', source: 'page_material_sound',
        startSample: 0, gain: 1, fadeInSamples: 0, fadeOutSamples: 0, bus: 'foley' }],
    },
  };

  return { project, files };
}
