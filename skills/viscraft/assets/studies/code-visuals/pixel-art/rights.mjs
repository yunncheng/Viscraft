/*
 * Provenance for the pixel-art study, kept beside the implementation so the
 * recipe and any later test can cite the same facts.
 *
 * Adopted from lemo-opuscar at e3cb16f (LemoLab, MIT): px.js (indexed buffer,
 * palette LUT/fade, Bayer, integer presentation), sprites.js (48x48 rig,
 * hand-placed heads, ox=24/oy=44 anchor, scarf tails) and font.js (bitmap
 * glyphs). The shrine, choreography, Arlo's non-combat guardian stance and the
 * colour-response staging are original for Viscraft.
 */
export const PIXEL_LICENSE = 'LICENSE-LemoLab-MIT.txt';

export const PIXEL_RIGHTS = {
  origin:
    'adapted from lemo-opuscar styles/pixel-rpg/demo/px.js, demo/sprites.js and demo/font.js@' +
    'e3cb16f63768c68693ff0e15171d6e755457cc32 (LemoLab), MIT: palette-index framebuffer, ENDESGA-32 ' +
    'colour list with protected indices, faded lookup table, Bayer dither, capsule rig, hand-placed ' +
    'Wren/Arlo heads, 48x48 sprite anchor and scarf-tail flutter, bitmap font; the night shrine, ' +
    'timeline, colour-response staging and non-combat guardian poses are original for Viscraft',
  license: 'Apache-2.0 AND MIT',
  redistributable: true,
  author: 'LemoLab (lemo-opuscar); Viscraft original scene, poses, staging and variants',
  attributionRequired: true,
  modifications:
    'Removed the whole-film main/scenes/props/ui/portraits/mem modules, sword combat, portraits, ' +
    'voice, music and sampled sound; replaced the fixed 6x presentation with an integer scale derived ' +
    'from the real capture size and a black letterbox; added a local night-shrine scene, a shared ' +
    'timeline clock, the offer/guard variants and the palette-response flood. The bitmap font is ' +
    'a local 80-glyph ASCII subset (not the complete upstream font and not all ASCII; see ' +
    "font.mjs COVERAGE) and has no CJK or system-font fallback. The scene's GROUND constant is " +
    "the actor's standing line (feet, shadow and beam origin); the drawn ground plane and shrine " +
    'platform are fixed, so a GROUND edit is local actor blocking, not a whole-ground move.',
  notice:
    'MIT (c) 2026 LemoLab (lemo-opuscar, commit e3cb16f63768c68693ff0e15171d6e755457cc32). ' +
    'The ENDESGA-32 colour list is attributed in README.md to ENDESGA ' +
    '(lospec.com/palette-list/endesga-32); this study records the upstream attribution and makes no ' +
    'separate licence claim for the palette. See THIRD_PARTY_NOTICES.md and LICENSE-LemoLab-MIT.txt.',
};
