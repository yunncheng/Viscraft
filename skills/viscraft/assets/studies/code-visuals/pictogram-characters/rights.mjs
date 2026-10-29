/*
 * Provenance for the pictogram-characters study, kept beside the implementation
 * so the recipe and any later test can cite the same facts.
 *
 * The upstream files are read for technique only; the bodies, silhouettes,
 * choreography and palette are original. See README.md for the exact ranges.
 */
import { fileURLToPath } from 'node:url';

/** Absolute directory holding this study's implementation files. */
export const PICTOGRAM_DIR = fileURLToPath(new URL('.', import.meta.url));

/** Entry page and implementation file copied beside the recipe. */
export const PICTOGRAM_ENTRY = 'pictogram-scene.html';
export const PICTOGRAM_MODULE = 'pictogram-characters.mjs';

/** Upstream licence text carried with the study and into every Project. */
export const PICTOGRAM_LICENSE = 'LICENSE-Lemo-Opuscar-MIT.txt';

export const PICTOGRAM_RIGHTS = {
  origin:
    'adapted from lemo-opuscar styles/pictogram-motion/demo/engine.js and demo/poses/base.js@' +
    'e3cb16f63768c68693ff0e15171d6e755457cc32 (LemoLab), MIT: angle poses, keyframe interpolation, ' +
    'far/near draw order and simple geometric props; the star/cloud/gear bodies, silhouette anchors, ' +
    'two-bone IK, hand-off choreography and palette are original for Viscraft',
  license: 'Apache-2.0 AND MIT',
  redistributable: true,
  author: 'LemoLab (lemo-opuscar); Viscraft original characters and choreography',
  attributionRequired: true,
  modifications:
    'Replaced the athlete rig with icon-body actors whose limbs attach to silhouette anchors; added a ' +
    'two-bone IK arm and a new hand-off key table; removed the official five-colour palette, motif/pattern ' +
    'system, event names and marks, fonts, music and reference images.',
  notice:
    'MIT (c) 2026 LemoLab (lemo-opuscar, commit e3cb16f63768c68693ff0e15171d6e755457cc32). The upstream ' +
    'pictogram-motion CREDITS excludes the event name/marks, official palette and core-graphic language ' +
    'from its licence; none of those are used here. See THIRD_PARTY_NOTICES.md and ' +
    'LICENSE-Lemo-Opuscar-MIT.txt.',
};
