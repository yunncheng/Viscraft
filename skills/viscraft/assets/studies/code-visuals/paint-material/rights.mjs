/*
 * Provenance of the paint-material reference module, shared by its own recipe
 * and by the contact study that imports the same module. One declaration, so
 * both Projects record identical rights.
 */
import { fileURLToPath } from 'node:url';

/** Absolute directory holding this reference's implementation files. */
export const PAINT_MATERIAL_DIR = fileURLToPath(new URL('.', import.meta.url));

/** Implementation file copied beside the scene when this reference is adopted. */
export const PAINT_MATERIAL_MODULE = 'paint-material.mjs';

export const PAINT_MATERIAL_RIGHTS = {
  origin:
    'adapted from huashu-art-motion scripts/engine/lib/paint.js, scripts/engine/lib/brush.js, ' +
    'scripts/engine/lib/collage.js and scripts/engine/lib/util.js@f178bd7754a71d6d399473af1501634548efa6cb (alchaincyf), MIT; ' +
    'the shipped module is a de-globalised pure-frame re-expression, and the modes, stage and recipe are Viscraft work',
  license: 'Apache-2.0 AND MIT',
  redistributable: true,
  author: 'alchaincyf (huashu-art-motion); Viscraft re-expression, modes and stage',
};
