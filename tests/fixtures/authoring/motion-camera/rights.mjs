/*
 * Provenance of the motion-camera reference module, shared by its own recipe
 * and by the contact study that imports the same module. One declaration, so
 * both Projects record identical rights.
 */
import { fileURLToPath } from 'node:url';

/** Absolute directory holding this reference's implementation files. */
export const MOTION_CAMERA_DIR = fileURLToPath(new URL('.', import.meta.url));

/** Implementation file copied beside the scene when this reference is adopted. */
export const MOTION_CAMERA_MODULE = 'motion-camera.mjs';

export const MOTION_CAMERA_RIGHTS = {
  origin:
    'adapted from huashu-art-motion scripts/engine/lib/motion.js, scripts/engine/lib/camera.js, scripts/engine/lib/util.js' +
    '@f178bd7754a71d6d399473af1501634548efa6cb (alchaincyf), MIT',
  license: 'MIT',
  redistributable: true,
  author: 'alchaincyf (huashu-art-motion)',
  attributionRequired: true,
  modifications:
    'Removed the window globals MO/CAM/U and the U.onStage stage loop; converted the IIFEs to plain ESM, removed the fixed 1920x1080 stage, and composed timing + camera into one pure createCamera per-frame sampler with a parameterised stage size.',
  notice:
    'MIT (c) alchaincyf (huashu-art-motion, commit f178bd7754a71d6d399473af1501634548efa6cb). The Manim-derived easing helpers (smooth, smoothCE, thereAndBack, rushInto, rushFrom, doubleSmooth, wiggle, lagged) derive, via huashu motion.js, from Manim / ManimCommunity (3Blue1Brown, MIT); retain both Manim permission notices. See THIRD_PARTY_NOTICES.md.',
};
