/*
 * The exact pinned three.js closure the glass-product Look imports — three base
 * files plus twelve addons — declared once for the glass-product recipe and for
 * any authoring fixture that adopts the same Look.
 *
 * This is reference content, not a Runtime service: the Runtime supplies the
 * generic author execution and the running package location, while the file
 * list, destinations, digests and rights live here. `authorProject` verifies
 * every `expectedSha256` against the bytes it actually copies, so this module
 * never hashes or writes anything itself.
 *
 * The dependency root is either an explicit donor directory or the `three`
 * package resolved from the RUNNING Runtime's own install (its package.json
 * anchors `createRequire`). Never this Skill's neighbour `node_modules`, never a
 * research copy on the machine, and never a download: a missing or drifted
 * dependency fails before the Project is written.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute directory holding the glass-product reference files. */
export const GLASS_PRODUCT_DIR = fileURLToPath(new URL('.', import.meta.url));

/** Implementation file copied beside the scene when this reference is adopted. */
export const GLASS_PRODUCT_MODULE = 'glass-product.mjs';

export const GLASS_PRODUCT_RIGHTS = {
  origin:
    'adapted from lemo-opuscar styles/glass-product/demo/{product,studio,story,main}.js@' +
    'e3cb16f63768c68693ff0e15171d6e755457cc32 (LemoLab), MIT; the staged beats, composition, ' +
    'product naming and recipe are original Viscraft work',
  license: 'Apache-2.0 AND MIT',
  redistributable: true,
  author: 'LemoLab (lemo-opuscar); Viscraft staging, composition and recipe',
};

export const THREE_RIGHTS = {
  origin:
    'three.js r186 (npm three@0.186.1) vendored build output and examples/jsm addon closure; adopted verbatim with provenance',
  license: 'MIT',
  redistributable: true,
};

const THREE_CORE_FILES = [
  {
    source: 'build/three.module.js',
    dest: 'vendor/three.module.js',
    sha256: '9052042d676cb0fdc1ddfefe193053f34b7ac0513a616fdac4535d49987812ea',
  },
  {
    source: 'build/three.core.js',
    dest: 'vendor/three.core.js',
    sha256: '9edde002b066a9a05676a6127f67735b62baf399bdea529f2f7e31657da769e6',
  },
  {
    source: 'LICENSE',
    dest: 'vendor/LICENSE',
    sha256: '8b378ebe60e2fe500158cb0ac71cb5e8b7d92953c2abcc63a0eb90499653b5bc',
  },
];

const THREE_ADDON_FILES = [
  ['lights/RectAreaLightTexturesLib.js', '6dd4043bb052594357a5eeff13dc0519f0a80b100b97ec80c12808f887897bc1'],
  ['lights/RectAreaLightUniformsLib.js', '494fef2d731ff1689050cc6040ad78d927c22b9125a12f532beb0374c2811c6e'],
  ['objects/Reflector.js', '57836df976f02a474b2dcfbb6609bca8bde0ccc6e77159ad8e418fa11c065d3b'],
  ['postprocessing/EffectComposer.js', '4e079a5886152d7e529a59aef644e968ab4d32c6a33ce016b36bf29b2eac26f7'],
  ['postprocessing/MaskPass.js', '7cd08eee9d5d6f5578beaddbdcbe9c384f6873810af27f22ab7db3ceeb127aa3'],
  ['postprocessing/OutputPass.js', '02e4a261af34de71338185e9e87f0cbe5cba9115608d984363e1269dec1d2272'],
  ['postprocessing/Pass.js', '444b409c235ead986893c472e720da1b779a56985c7d10b279c7944b52bd61c5'],
  ['postprocessing/ShaderPass.js', 'e2500a5913b26bbf5148ceaae644c6edcff06a18b01494ee37bf856353d2ab9d'],
  ['postprocessing/UnrealBloomPass.js', 'ba8f2fcadfa6588384c9473498f974d81d120f02f0e63a0e59c265202a006b5a'],
  ['shaders/CopyShader.js', 'a33057d5ac91c43304c186ac0e8816e62bb2ed471d3a00ff3018dfd5c0389718'],
  ['shaders/LuminosityHighPassShader.js', '5044f780b6e6cf863947f64c36fe1587132f7fbe395ada863cd1e5f0388dcf1e'],
  ['shaders/OutputShader.js', '353479f77a8d7e2629d49ccac9fc2f5dbfdda5442e0adf867b00377a2fcb0cb2'],
].map(([rel, sha256]) => ({
  source: `examples/jsm/${rel}`,
  dest: `vendor/addons/${rel}`,
  sha256,
}));

/** The exact, pinned Three.js closure the glass-product Look imports. */
export const THREE_GLASS_PRODUCT = Object.freeze([...THREE_CORE_FILES, ...THREE_ADDON_FILES]);

const NOTICE = 'THIRD_PARTY_NOTICES.md';

async function isThreePackage(dir) {
  try {
    return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).name === 'three';
  } catch {
    return false;
  }
}

/** Walk up from the resolved `three` entry to its package root. */
async function threePackageRoot(require) {
  const entry = require.resolve('three');
  for (let dir = dirname(entry); ; dir = dirname(dir)) {
    if (await isThreePackage(dir)) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

async function resolveThreeRoot(runtimePath, threeDirectory) {
  if (typeof threeDirectory === 'string' && threeDirectory.length > 0) return resolve(threeDirectory);
  const require = createRequire(join(runtimePath, 'package.json'));
  const fromRuntime = await threePackageRoot(require);
  if (fromRuntime !== undefined) return fromRuntime;
  throw new Error(
    "Cannot locate the 'three' package from the running Runtime. Install the Runtime's dependencies, " +
      'or pass options.three with the exact pinned three@0.186.1 distribution.',
  );
}

function threeAssetId(destination) {
  return `asset_${destination.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`;
}

/**
 * Declare the pinned closure as author files, `code` Asset drafts and the
 * licence handoff for a Project adopting the glass-product Look. Digests are
 * assertions checked by `authorProject`; absence is an error, never a fallback.
 */
export async function declareGlassDependencies({ runtime, root, threeDirectory }) {
  const location = await runtime.runtimeLocation(root);
  const threeRoot = await resolveThreeRoot(location.path, threeDirectory);
  const files = THREE_GLASS_PRODUCT.map((pin) => ({
    path: pin.dest,
    sourcePath: join(threeRoot, ...pin.source.split('/')),
    expectedSha256: pin.sha256,
  }));
  const assets = THREE_GLASS_PRODUCT.map((pin) => ({
    id: threeAssetId(pin.dest),
    path: pin.dest,
    type: 'code',
    simulated: false,
    rights: THREE_RIGHTS,
  }));
  files.push({ path: NOTICE, sourcePath: join(location.path, NOTICE) });
  return { files, assets, handoff: [{ path: NOTICE, role: 'license' }] };
}
