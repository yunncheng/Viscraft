/*
 * Viscraft recipe: instantiate the reusable glass-product Look into a NEW Project.
 *
 *   viscraft author create.mjs <new-project-directory> [--options <options.json>]
 *
 * The executable mechanics (loading, hashing, copying, licence carriage, Project
 * writing) belong to the Runtime. This file is the editable
 * creative declaration: the product name, accents, bloom/exposure, the orbit /
 * explode / pulse beats and the duration-derived params.
 *
 * The reusable module (`glass-product.mjs`) and the editable template scene live
 * beside this recipe. The pinned `three@0.186.1` closure and its rights are
 * declared in `three-files.mjs`, resolved from the running Runtime's own install
 * (or an explicitly supplied donor directory via `options.three`) and verified
 * by `authorProject` against the recorded digests before anything is written.
 * The Project carries the Runtime's verbatim THIRD_PARTY_NOTICES.md. Hashes and
 * revisions are filled by the Runtime from the copied bytes.
 *
 * The Look renders `glass-product-scene.html` — a pure `window.viscraft.render(ctx)`
 * page. No absolute host paths are written into the project, and authoring
 * performs no provider work. Build with the separate command:
 *   viscraft build <project-directory>
 */
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { declareGlassDependencies, GLASS_PRODUCT_MODULE, GLASS_PRODUCT_RIGHTS } from './three-files.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = 'glass-product-scene.html';
const MODULE = GLASS_PRODUCT_MODULE;
const LICENSES = 'LICENSES.md';
const SCENE_RIGHTS = {
  origin:
    'adapted from lemo-opuscar styles/glass-product/demo/{product,studio,story,main}.js@' +
    'e3cb16f63768c68693ff0e15171d6e755457cc32 (LemoLab), MIT; the staged beats, composition, ' +
    'product naming and recipe are original Viscraft work',
  license: 'Apache-2.0 AND MIT',
  redistributable: true,
  author: 'LemoLab (lemo-opuscar); Viscraft staging, composition and recipe',
};

function slugToId(name) {
  const cleaned = String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'study';
  return ('glass-' + (/^[a-z0-9]/.test(cleaned) ? cleaned : 'p-' + cleaned)).slice(0, 96);
}

export default async function ({ root, options, runtime }) {
  const { width = 1920, height = 1080, frames = 96, three } = options ?? {};
  for (const [name, value] of Object.entries({ width, height, frames })) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`"${name}" must be a positive integer`);
  }
  if (width % 2 !== 0 || height % 2 !== 0) throw new Error('"width" and "height" must be even');

  const fps = 24;
  const sampleRate = 48000;
  const channels = 2;
  const duration = frames / fps;

  const SOURCE_ID = 'lumen-studio';
  const PARAMS = {
    duration,
    product: 'LUMEN',
    accentA: '#62dcff',
    accentB: '#a98bff',
    bloom: 0.28,
    exposure: 1.1,
    orbit: 1,
    explode: 1,
    pulse: 1,
  };
  const SEED = 60421;

  // ---- the module + pinned Three closure + the Runtime notice ---------------
  // `options.three` is an explicit donor directory for the pinned closure; both
  // paths are verified against the same digests. There is no fallback to the
  // Skill or to a machine-local research copy.
  const threeDirectory = typeof three === 'string' && three.length > 0 ? three : undefined;
  const dependencies = await declareGlassDependencies({ runtime, root, threeDirectory });
  const threeFiles = dependencies.files.filter((file) => file.path.startsWith('vendor/'));
  const resources = [MODULE, ...threeFiles.map((file) => file.path)];

  const source = {
    id: SOURCE_ID,
    kind: 'browser',
    output: 'picture',
    entry: ENTRY,
    resources,
    bindings: [],
    params: PARAMS,
    seed: SEED,
    frames,
  };

  const totalFrames = frames;

  const look = { id: 'glass_studio', description: 'Stylized dark-studio glass product Look: clear + frosted glass, strip-light environment, mirror floor, a light-guide that pulses from inside, and an exploded → snapped-together beat.' };

  const files = [
    { path: ENTRY, sourcePath: join(HERE, ENTRY) },
    { path: MODULE, sourcePath: join(HERE, MODULE) },
    { path: LICENSES, sourcePath: join(HERE, LICENSES) },
    ...dependencies.files,
  ];
  const assets = [
    { id: 'glass_scene', path: ENTRY, type: 'code', simulated: false, rights: SCENE_RIGHTS },
    { id: 'glass_module', path: MODULE, type: 'code', simulated: false, rights: GLASS_PRODUCT_RIGHTS },
    ...dependencies.assets,
  ];

  const project = {
    schemaVersion: 1,
    id: slugToId(basename(root)),
    revision: 1,
    title: 'GLASS PRODUCT — reusable dark-studio glass Look',
    direction: {
      intent:
        'A single reusable, deterministic dark-studio glass product Look: a fictional lens-glass earbud pair in a pebble cradle case, rendered by a real THREE.WebGLRenderer from a pure per-frame contract. A material/lighting reveal, a close detail push and an exploded → reassembled beat are driven only by the frame clock. Stylized product photography, not a real product, brand or photoreal claim.',
      looks: [look],
      transitions: [],
    },
    assets,
    bindings: {},
    handoff: [...dependencies.handoff, { path: LICENSES, role: 'license' }],
    sources: [source],
    composition: {
      output: { width, height, fps: { numerator: fps, denominator: 1 }, sampleRate, channels },
      scenes: [{ id: 'scene_glass', description: 'One dark-studio glass product Look over five beats.' }],
      shots: [
        { id: 'shot_studio', scene: 'scene_glass', look: look.id, intent: 'Reveal → open → macro detail → exploded → hero, driven by the frame clock.', targetFrames: totalFrames },
      ],
      placements: [
        { id: 'pl_studio', shot: 'shot_studio', source: SOURCE_ID, inFrame: 0, outFrame: totalFrames, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio: [],
    },
  };

  return { project, files };
}
