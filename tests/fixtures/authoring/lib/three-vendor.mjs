#!/usr/bin/env node
/*
 * Viscraft examples: the single source of truth for vendoring the three.js
 * build into a generated Project.
 *
 * The examples that render a real THREE.WebGLRenderer adopt an exact, pinned
 * three.js build (npm `three@0.186.1`, MIT) by copying ONLY `build/three.module.js`,
 * `build/three.core.js` and the top-level `LICENSE` verbatim into the Project's
 * `vendor/` directory, after verifying each file against the exact sha256 below.
 *
 * Resolution is now self-contained: `three` is a declared dependency of this
 * package, so by default the build is read from the installed `node_modules/three`
 * with NO extra argument. A caller may still pass an explicit directory of an
 * already-acquired distribution as an override; those bytes are verified the same
 * way. A mismatch aborts BEFORE anything is written, so an unverified or drifted
 * engine can never be vendored silently.
 */
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// --- vendored engine: exact expected content (three.js r186 / three@0.186.1) --
export const THREE_VERSION = '0.186.1';
export const THREE_FILES = {
  module: {
    source: 'build/three.module.js',
    dest: 'vendor/three.module.js',
    sha256: '9052042d676cb0fdc1ddfefe193053f34b7ac0513a616fdac4535d49987812ea',
  },
  core: {
    source: 'build/three.core.js',
    dest: 'vendor/three.core.js',
    sha256: '9edde002b066a9a05676a6127f67735b62baf399bdea529f2f7e31657da769e6',
  },
  license: {
    source: 'LICENSE',
    dest: 'vendor/LICENSE',
    sha256: '8b378ebe60e2fe500158cb0ac71cb5e8b7d92953c2abcc63a0eb90499653b5bc',
  },
};
export const THREE_FILE_KEYS = ['module', 'core', 'license'];

/**
 * The GLTFLoader addon and its transitive addon imports, pinned at the same
 * three.js revision.
 *
 * `GLTFLoader.js` imports the BARE specifier `three` plus the relative
 * `../utils/BufferGeometryUtils.js` and `../utils/SkeletonUtils.js`; those utils
 * also import the bare `three`. Vendoring them under `vendor/addons/loaders/` and
 * `vendor/addons/utils/` preserves the relative specifiers exactly, and an
 * inline import map in the page maps `three` to `./vendor/three.module.js`. The
 * three build bytes above are untouched: these are ADDITIONAL pinned files.
 */
export const THREE_ADDON_FILES = {
  gltfLoader: {
    source: 'examples/jsm/loaders/GLTFLoader.js',
    dest: 'vendor/addons/loaders/GLTFLoader.js',
    sha256: '131c0f78c01d19368ae495caa65b3adaa10487810a36a05bb5901b769a35ac16',
  },
  bufferGeometryUtils: {
    source: 'examples/jsm/utils/BufferGeometryUtils.js',
    dest: 'vendor/addons/utils/BufferGeometryUtils.js',
    sha256: '9fb63427ce6641fa14fd0baff9cc4d1b5f9c3d85fd084bf2e90e803c44ec1797',
  },
  skeletonUtils: {
    source: 'examples/jsm/utils/SkeletonUtils.js',
    dest: 'vendor/addons/utils/SkeletonUtils.js',
    sha256: 'b1632a703206c3d830de9fcbe515696770d04b71a15ee6b50afa6d2c3298c86f',
  },
};
export const THREE_ADDON_KEYS = ['gltfLoader', 'bufferGeometryUtils', 'skeletonUtils'];

function messageOf(error) {
  return error && error.message ? error.message : String(error);
}
async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Resolve the directory holding `build/three.module.js`, `build/three.core.js`
 * and `LICENSE`.
 *
 * - With an explicit directory, that directory is used as-is (override).
 * - With no argument, the installed `three` package is resolved from this
 *   module's own location, so a clean install works with zero extra arguments.
 *
 * Throws with a clear, actionable message if the default cannot be located.
 */
export function resolveThreeDirectory(explicit) {
  if (explicit !== undefined && explicit !== null && String(explicit).length > 0) {
    return resolve(String(explicit));
  }
  let entry;
  try {
    entry = import.meta.resolve('three');
  } catch (error) {
    throw new Error(
      "cannot locate the 'three' package: " +
        messageOf(error) +
        '. Install dependencies (`npm install`) so node_modules/three exists, or pass an explicit three.js directory.',
    );
  }
  const root = dirname(dirname(fileURLToPath(entry)));
  const expected = join(root, 'build', 'three.module.js');
  if (!exists(expected)) {
    throw new Error(
      "resolved the 'three' package to " +
        root +
        ' but ' +
        expected +
        ' is missing; pass an explicit three.js directory instead.',
    );
  }
  return root;
}

/**
 * Verify a pinned file set from the three.js distribution at `threeDir` and
 * return the copied-file report. Reads each required file, hashes it, and throws
 * on any mismatch BEFORE the caller writes anything.
 */
export async function verifyFileSet(threeDir, keys, files) {
  const verified = [];
  for (const key of keys) {
    const file = files[key];
    const sourcePath = join(threeDir, ...file.source.split('/'));
    if (!(await exists(sourcePath))) {
      throw new Error(`three distribution is missing ${file.source} (looked in ${sourcePath})`);
    }
    const bytes = await readFile(sourcePath);
    const actual = sha256(bytes);
    if (actual !== file.sha256) {
      throw new Error(
        `refusing to adopt unverified three.js bytes: ${file.source} has sha256 ${actual}, expected ${file.sha256}`,
      );
    }
    verified.push({ ...file, sourcePath, actual, bytes });
  }
  return verified;
}

/**
 * Verify the three.js distribution at `threeDir` and return the copied-file
 * report for the core build (module, core, LICENSE).
 */
export async function verifyThree(threeDir) {
  return verifyFileSet(threeDir, THREE_FILE_KEYS, THREE_FILES);
}

/**
 * Verify the GLTFLoader addon closure (GLTFLoader + its two utils) from the
 * same distribution. Kept separate from {@link verifyThree} so existing callers
 * keep byte-identical behaviour; addon bytes are only adopted when asked for.
 */
export async function verifyThreeAddons(threeDir) {
  return verifyFileSet(threeDir, THREE_ADDON_KEYS, THREE_ADDON_FILES);
}

/**
 * Convenience: resolve (default = installed `three`, optional explicit override)
 * then verify, returning the verified files ready to write.
 */
export async function loadVerifiedThree(explicit) {
  return verifyThree(resolveThreeDirectory(explicit));
}

/** Convenience: resolve then verify the GLTFLoader addon closure. */
export async function loadVerifiedThreeAddons(explicit) {
  return verifyThreeAddons(resolveThreeDirectory(explicit));
}
