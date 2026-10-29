/*
 * Viscraft recipe: instantiate the icon-body pictogram hand-off into a NEW
 * Project.
 *
 *   viscraft author create.mjs <new-project-directory> [--options <options.json>]
 *
 * The executable mechanics (loading, hashing, copying, licence carriage, Project
 * writing) belong to the Runtime. This file is the editable creative
 * declaration: the two variants, their palettes, the per-source length and the
 * Project shape. The module implementation (`pictogram-characters.mjs`), the
 * editable template scene and the local MIT text live beside this recipe and are
 * copied from here by `authorProject`.
 *
 * Two `browser` picture Sources share the SAME entry and module:
 *
 *   - star_disc   variant "star-disc"   — a star body hands a disc to a cloud
 *   - cloud_baton variant "cloud-baton" — a cloud body hands a baton to a gear
 *
 * The bodies are the icons; limbs attach to their silhouette anchors. There is
 * no human torso and no icon-as-head. The prop changes owner at the transfer
 * beat; the result hold stays inside the authored frames. Both Sources are
 * silent; no font is used.
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
import { PICTOGRAM_LICENSE, PICTOGRAM_RIGHTS } from './rights.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = 'pictogram-scene.html';
const MODULE = 'pictogram-characters.mjs';
const LICENSE = PICTOGRAM_LICENSE;
const LICENSES = 'LICENSES.md';
const NOTICE = 'THIRD_PARTY_NOTICES.md';


function slugToId(name) {
  const cleaned = String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'study';
  return ('pictogram-' + (/^[a-z0-9]/.test(cleaned) ? cleaned : 'p-' + cleaned)).slice(0, 96);
}

export default async function ({ root, options, runtime }) {
  const { width = 1920, height = 1080, frames: perSourceFrames = 48 } = options ?? {};
  for (const [name, value] of Object.entries({ width, height, frames: perSourceFrames })) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`"${name}" must be a positive integer`);
  }
  if (width % 2 !== 0 || height % 2 !== 0) throw new Error('"width" and "height" must be even');

  const fps = 24;
  const sampleRate = 48000;
  const channels = 2;

  // ---- two icon-body variants, one entry and one module ---------------------
  const STAR_DISC = {
    variant: 'star-disc',
    frames: perSourceFrames,
    palette: {
      field: '#f3eee2',
      ground: '#ddd2bd',
      line: '#b6a98f',
      ink: '#17212b',
      sender: '#d9543b',
      receiver: '#2f6f8f',
      token: '#e0a33a',
    },
  };
  const CLOUD_BATON = {
    variant: 'cloud-baton',
    frames: perSourceFrames,
    palette: {
      field: '#f1ece1',
      ground: '#d9cdb8',
      line: '#b3a58b',
      ink: '#161f2b',
      sender: '#6c5ba8',
      receiver: '#c9792e',
      token: '#2b8c86',
    },
  };

  const specs = [
    { id: 'star_disc', seed: 9151, params: STAR_DISC },
    { id: 'cloud_baton', seed: 9152, params: CLOUD_BATON },
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
    id: 'icon-handoff',
    description: 'Icon-body actors pass one prop; silhouette limbs, two-bone IK, contact/transfer beats and a held result.',
  };
  const sceneId = 'scene_handoff';
  let cursor = 0;
  const shots = [];
  const placements = [];
  for (const spec of specs) {
    shots.push({
      id: `shot_${spec.id}`,
      scene: sceneId,
      look: look.id,
      intent: `An icon-body hand-off: ${spec.params.variant} prepares, contacts, transfers the prop and holds the result.`,
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
    { id: 'pictogram_scene', path: ENTRY, type: 'code', simulated: false, rights: PICTOGRAM_RIGHTS },
    { id: 'pictogram_characters', path: MODULE, type: 'code', simulated: false, rights: PICTOGRAM_RIGHTS },
  ];

  const project = {
    schemaVersion: 1,
    id: slugToId(basename(root)),
    revision: 1,
    title: 'PICTOGRAM CHARACTERS — icon-body hand-off',
    direction: {
      intent:
        'Two icon-body actors hand one prop to each other. The body is the silhouette (star, cloud or gear); ' +
        'limbs attach to its outline, never to a human torso or an icon-as-head. The inner arms meet through a ' +
        'two-bone IK target, the prop passes behind the near hands, ownership changes at the transfer beat and the ' +
        'receiver holds the result to the last frame. The second variant swaps the sender/receiver roles, the ' +
        'receiver outline, the prop and the palette.',
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
      scenes: [{ id: sceneId, description: 'One hand-off stage, staged twice with different icon bodies and props.' }],
      shots,
      placements,
      transitions: [],
      audio: [],
    },
  };

  return { project, files };
}
