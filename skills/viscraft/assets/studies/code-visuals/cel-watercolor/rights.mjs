/*
 * Provenance of the cel-watercolor reference module, shared by its own recipe
 * and by the atlas-reveal fixture that composes it. One declaration, so the
 * module and every Project that copies it record the same rights.
 */
import { fileURLToPath } from 'node:url';

/** Absolute directory holding this reference's implementation files. */
export const CEL_WATERCOLOR_DIR = fileURLToPath(new URL('.', import.meta.url));

/** Implementation file copied beside the scene when this reference is adopted. */
export const CEL_WATERCOLOR_MODULE = 'cel-watercolor.mjs';

export const CEL_WATERCOLOR_RIGHTS = {
  origin:
    'adapted from lemo-opuscar styles/cel-anime-80s/demo/cel.js and styles/watercolor/demo/engine.js,plants.js,scene.js@e3cb16f63768c68693ff0e15171d6e755457cc32 (LemoLab), MIT; the shipped module is an independent reimplementation and the scenes, subjects and recipe are original Viscraft work',
  license: 'Apache-2.0 AND MIT',
  redistributable: true,
  author: 'LemoLab (studied mechanism); Viscraft independent reimplementation, scenes and recipe',
};
