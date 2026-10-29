/*
 * Provenance for the ink-wash study, kept beside the implementation so the
 * recipe and any later test can cite the same facts.
 *
 * Upstream is read and adapted for technique under MIT; the two scenes, their
 * poses, beats, staging, staff, sash and end chop are original. See README.md
 * for the exact adopted ranges and exclusions.
 */
import { fileURLToPath } from 'node:url';

/** Absolute directory holding this study's implementation files. */
export const INK_DIR = fileURLToPath(new URL('.', import.meta.url));

/** Entry page and implementation file copied beside the recipe. */
export const INK_ENTRY = 'ink-wash-scene.html';
export const INK_MODULE = 'ink-wash.mjs';

/** Upstream licence text carried with the study and into every Project. */
export const INK_LICENSE = 'LICENSE-Lemo-Opuscar-MIT.txt';

export const INK_RIGHTS = {
  origin:
    'adapted from lemo-opuscar styles/ink-wash/demo/ink.js, comp.js, hero.js, land.js, wave.js and ' +
    'core/lib.js@e3cb16f63768c68693ff0e15171d6e755457cc32 (LemoLab), MIT: the stroke/bristle model, ' +
    'loaded-stroke dark side, wet/dry/colour layers and rice-paper compositor, the 100-unit xieyi figure, ' +
    'pose interpolation, hat/robe/sleeve construction, ridge/mountain/cun/cliff/pine/reed/ripple and the ' +
    'gesture-built wave; the river-crossing and pine-path scenes, their beats, cameras, staff, sash and ' +
    'end chop are original for Viscraft',
  license: 'Apache-2.0 AND MIT',
  redistributable: true,
  author: 'LemoLab (lemo-opuscar); Viscraft original staging, poses-in-motion and props',
  attributionRequired: true,
  modifications:
    'Replaced the 48 s swordsman film with two 7 s standalone scenes; removed the sword, sheath, tassel, ' +
    'writing and cut, the written 水 glyph, inscriptions, subtitles, face close-up, whole-film story/shot ' +
    'runner, external fonts, music, voice and sound effects; reduced the pose set, added a walking staff, ' +
    'a vermilion sash and an abstract end chop; rebuilt the compositor for a single layer set at the ' +
    'actual ctx size with final WebGL2 attributes, and split the 12 fps figure clock from the continuous ' +
    'camera/swell/reveal clock.',
  notice:
    'MIT (c) 2026 LemoLab (lemo-opuscar, commit e3cb16f63768c68693ff0e15171d6e755457cc32). The upstream ' +
    'demo credits Ma Shan Zheng (OFL) as a skeleton reference for the written character 水; that glyph, ' +
    'its traced strokes and all fonts are excluded here. See THIRD_PARTY_NOTICES.md and ' +
    'LICENSE-Lemo-Opuscar-MIT.txt.',
};

/** Upstream file hashes cited by README.md. */
export const INK_UPSTREAM = {
  commit: 'e3cb16f63768c68693ff0e15171d6e755457cc32',
  files: {
    'styles/ink-wash/demo/ink.js': 'dbe6474ab0a0798193a7b49be9a8166511bc67ced90594e4390bdb2b70eef399',
    'styles/ink-wash/demo/comp.js': '063b2d9fa079772de016acc99f19aabddd6dbeaa2445119d01ccac5053a281af',
    'styles/ink-wash/demo/hero.js': 'bea1cb4f77efc89f68cbdd52cccc7c63b340ad9aa905d58453f857b3b553a798',
    'styles/ink-wash/demo/land.js': '687c1cc1a848e30cc7e8b2e73984f49925506f20a8500b64aac88059a02b50bb',
    'styles/ink-wash/demo/wave.js': '408faca9dfc67c8fd077b1c25a447d7b49d56319976151457ec1c10e91716397',
    'core/lib.js': '770c8fde7c43e6a8aa9f69235869eb2a6ef5dc43453d0e56d4ff0da576c83907',
  },
};
