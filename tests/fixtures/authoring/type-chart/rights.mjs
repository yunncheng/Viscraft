/*
 * Provenance of the type-chart reference module, shared by its own recipe and
 * by the atlas-reveal fixture that composes it. One declaration, so the module
 * and every Project that copies it record the same rights.
 */
import { fileURLToPath } from 'node:url';

/** Absolute directory holding this reference's implementation files. */
export const TYPE_CHART_DIR = fileURLToPath(new URL('.', import.meta.url));

/** Implementation file copied beside the scene when this reference is adopted. */
export const TYPE_CHART_MODULE = 'type-chart.mjs';

export const TYPE_CHART_RIGHTS = {
  origin:
    'adapted from huashu-art-motion scripts/engine/lib/typo.js, scripts/engine/lib/chart.js, scripts/engine/lib/util.js @ f178bd7754a71d6d399473af1501634548efa6cb (alchaincyf), MIT',
  license: 'MIT',
  redistributable: true,
  author: 'alchaincyf (huashu-art-motion)',
  attributionRequired: true,
  modifications: 'Removed the window globals TY/CH/U and the U.onStage stage loop; converted the IIFEs to plain ESM and made the stage explicit.',
  notice:
    'MIT (c) alchaincyf (huashu-art-motion, commit f178bd7754a71d6d399473af1501634548efa6cb). The Manim-derived easing helpers derive, via huashu motion.js, from Manim / ManimCommunity (3Blue1Brown, MIT); retain both Manim permission notices. See THIRD_PARTY_NOTICES.md.',
};
