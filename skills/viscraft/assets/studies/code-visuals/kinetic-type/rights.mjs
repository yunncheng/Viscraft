/*
 * Rights and source identity for the kinetic-type reference.
 *
 * One declaration so the scene, module and font registrations cannot drift.
 * The font is a complete variable font, not a demo subset; the WOFF2 container
 * is a lossless recompression recorded in README.md and LICENSES.md.
 */

export const KINETIC_CODE_RIGHTS = {
  origin:
    'Original canvas-2D kinetic-typography implementation. Mechanism study from lemo-opuscar styles/swiss-motion/demo/film.js,ease.js@e3cb16f63768c68693ff0e15171d6e755457cc32 (LemoLab), MIT; huashu-art-motion scripts/engine/clips/y5_kinetic_type.js@f178bd7754a71d6d399473af1501634548efa6cb (method study only, no source copied).',
  license: 'Apache-2.0',
  redistributable: true,
  author: 'Viscraft implementation; LemoLab (adapted mechanisms)',
  licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
  notice:
    'MIT (c) 2026 LemoLab for the studied swiss-motion files. The full MIT text and the modification note are in LICENSES.md; this reference is not the upstream film.',
};

export const KINETIC_FONT_FILE = 'fonts/NotoSansSC-VF.woff2';
export const KINETIC_FONT_LICENSE = 'fonts/OFL-NotoSansSC.txt';

export const KINETIC_FONT_RIGHTS = {
  origin:
    'Noto Sans SC variable font from google/fonts@47d54ca1ebb14fd864695f1d39dc734f39017c33 ofl/notosanssc/NotoSansSC[wght].ttf (GitHub blob fb0637bafbcd804fe32152370a1225990745b4bc; sha256 a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da); losslessly converted to WOFF2 with fontTools 4.65.0 (sha256 aef8c34277afad81ecd0227138a830263c0caea65b7aea66d1195395f097b55a).',
  license: 'OFL-1.1',
  redistributable: true,
  author: 'The Noto Project Authors; Copyright 2014-2021 Adobe',
  licenseUrl: 'https://scripts.sil.org/OFL',
  notice:
    "Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'. Licensed under the SIL Open Font License 1.1; the full text ships as fonts/OFL-NotoSansSC.txt.",
  attributionRequired: true,
  modifications:
    'Lossless WOFF2 recompression of the complete Noto Sans SC variable font (30,890 cmap entries / 31,036 glyphs). Full cmap, glyph order, hmtx metrics, gvar and outline digests are equal before/after, including wght 100/400/700/900; no subsetting and no outline or metric changes.',
};
