# Third-party notices

Viscraft is licensed under the Apache License 2.0 (see the root `LICENSE`).
Viscraft-owned code, documentation, original case media and creative-reference
contributions use Apache-2.0. Third-party code, fonts and recordings retain their
upstream licences below. Mixed code Assets state `Apache-2.0 AND MIT` where
Viscraft contributions and upstream MIT portions coexist; their complete grants
and applicable notices travel with authored Projects.

## three.js — declared dependency

- Version: three.js r186, npm `three@0.186.1` (pinned exactly in `package.json` `dependencies`).
- Copyright © 2010-2026 three.js authors.
- License: MIT, reproduced below and preserved verbatim as `vendor/LICENSE` in generated projects.
- Scope: `three@0.186.1` is a declared dependency used by the Runtime's browser capture and by the authoring/technical fixtures (which live under `tests/fixtures/authoring/`, included in the source distribution, excluded from the Runtime package). Three.js files are not supplied automatically by the Runtime: a work or reference that needs Three.js declares the exact files it imports, their destinations and their pinned sha256 in its own recipe, and `authorProject` verifies each against the copied bytes before writing. The `glass-product` reference declares its own 15-file closure — `vendor/three.module.js`, `vendor/three.core.js`, `vendor/LICENSE`, and the addons under `vendor/addons/` (`objects/Reflector.js`, `lights/RectAreaLightUniformsLib.js`, `lights/RectAreaLightTexturesLib.js`, and the `postprocessing/*` files `EffectComposer.js`, `Pass.js`, `ShaderPass.js`, `MaskPass.js`, `UnrealBloomPass.js`, `OutputPass.js` plus the `shaders/*` files `CopyShader.js`, `LuminosityHighPassShader.js`, `OutputShader.js`) — copied byte-for-byte and checked against that reference's pins, still under three's MIT.
- The original example renderer, project schema, and World semantics are Viscraft code, not translations of a third-party implementation. This optional dependency does not make Three.js mandatory for other production routes.
- The bytes are identical to the npm-published `three@0.186.1` package declared as a dependency and installed under `node_modules/three`. A work verifies the exact bytes below before writing them.
- Registered Project Assets retain their actual hashes and MIT rights. Source resource declarations and portable export retain both modules and the license.

| Distribution file | SHA-256 |
| --- | --- |
| `build/three.module.js` | `9052042d676cb0fdc1ddfefe193053f34b7ac0513a616fdac4535d49987812ea` |
| `build/three.core.js` | `9edde002b066a9a05676a6127f67735b62baf399bdea529f2f7e31657da769e6` |
| `LICENSE` | `8b378ebe60e2fe500158cb0ac71cb5e8b7d92953c2abcc63a0eb90499653b5bc` |

### MIT license (verbatim)

The MIT License

Copyright © 2010-2026 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

### Linearly Transformed Cosines (LTC) data — retained licence

`examples/jsm/lights/RectAreaLightUniformsLib.js` and `examples/jsm/lights/RectAreaLightTexturesLib.js` (declared by the `glass-product` reference, see the Scope above) embed the LTC lighting data published in **"Real-Time Polygonal-Light Shading with Linearly Transformed Cosines"** (Eric Heitz, Jonathan Dupuy, Stephen Hill and David Neubelt, ACM Transactions on Graphics / Proceedings of ACM SIGGRAPH 2016, 35(4)), from `selfshadow/ltc_code` (commit `31e5e96b54f98f33098f8503003119ba2231a1c6`); the upstream licence text is reproduced below. The two files ship **unmodified** within three's own `three@0.186.1` distribution, so three's MIT above covers the distribution; the upstream licence additionally requires the paper citation, which is the reference just given. Its text is retained verbatim below.

Copyright (c) 2017, Eric Heitz, Jonathan Dupuy, Stephen Hill and David Neubelt.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* If you use (or adapt) the source code in your own work, please include a
  reference to the paper:

  Real-Time Polygonal-Light Shading with Linearly Transformed Cosines.
  Eric Heitz, Jonathan Dupuy, Stephen Hill and David Neubelt.
  ACM Transactions on Graphics (Proceedings of ACM SIGGRAPH 2016) 35(4), 2016.
  Project page: https://eheitzresearch.wordpress.com/415-2/

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## huashu-art-motion — adapted author-module code

- Source: `huashu-art-motion` (author alchaincyf), commit `f178bd7754a71d6d399473af1501634548efa6cb`.
- Copyright © alchaincyf.
- License: MIT, reproduced below (retained because the adapted files are derivatives of the MIT source).
- Adapted files: `scripts/engine/lib/util.js`, `paint.js`, `brush.js`, `collage.js`, `motion.js`, `camera.js`, `typo.js`, `chart.js`.
- Scope: the `paint-material` reference under `skills/viscraft/assets/studies/code-visuals/`, and the `motion-camera` and `type-chart` engineering fixtures under `tests/fixtures/authoring/` (the fixtures are not distributed with the Skill). Their recipes declare the adopted files into a Project. The code is adapted, not copied byte-for-byte: the upstream `window`-hanging globals (`PAINT`/`CL`/`MO`/`CAM`/`TY`/`CH`/`U`) and the `U.onStage` stage loop are removed and re-scoped to plain ESM, the fixed stage is parameterised, and randomness is a caller-supplied seeded PRNG. Every adopted `code` Asset records this MIT origin and its real sha256 in its rights. Upstream `diagram.js` (CC BY-NC-SA) is **not** used.
- Additional adapted file for the sound-arrange test kit: `scripts/audio/synth_艺术史速通.py` — the event/`era` score layout (events on a musical grid, one instrument family per section, a motif re-orchestrated per section, explicit level staging), reimplemented on the composition frame grid with no Python, no per-section LUFS routine, and no upstream sounds, fonts or images.
- Scope (sound): the test-only `sound-arrange` kit under `tests/fixtures/audio/sound-arrange/` (not a Skill creative reference and not distributed as one). No Manim-derived code is present.

### Manim-derived easings — retained notices

Portions of the `motion-camera` module — the easing helpers `smooth`, `smoothCE`, `thereAndBack`, `rushInto`, `rushFrom`, `doubleSmooth`, `wiggle` and `lagged` — and the `lagged` helper retained in `type-chart` derive, via huashu-art-motion's `motion.js`, from **Manim / ManimCommunity**. Both of the following MIT notices are retained:

- Copyright © 3Blue1Brown (Manim), MIT.
- Copyright © ManimCommunity, MIT.

Both are released under the standard MIT text reproduced below, whose copyright block lists all three holders.

### MIT license (verbatim)

The MIT License

Copyright © alchaincyf (huashu-art-motion)
Copyright © 3Blue1Brown (Manim)
Copyright © ManimCommunity

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

## lemo-opuscar — adapted author-module code

- Source: `lemo-opuscar` (author LemoLab), commit `e3cb16f63768c68693ff0e15171d6e755457cc32`.
- Copyright © LemoLab.
- License: MIT, reproduced below.
- Adapted files: `styles/cel-anime-80s/demo/cel.js`, `styles/watercolor/demo/engine.js`, `plants.js`, `scene.js`, and for the `glass-product` module `styles/glass-product/demo/product.js`, `studio.js`, `story.js`, `main.js`, `core/three/post.js`, `core/lib.js`.
- Scope: the `cel-watercolor` and `glass-product` author-module references under `skills/viscraft/assets/studies/code-visuals/`. The `cel-watercolor` Look is an independent reimplementation of those canvas-2D demos (de-globalised into plain ESM), not a byte-for-byte copy; upstream fonts, voice/TTS, music and the map/landscape assets are **NOT** included, and the paper texture is reimplemented in canvas JS from seeded noise rather than ported from the upstream Python/PIL (`paper.py`/`sheet.py`) — no vendored paper image exists. The `glass-product` Look keeps the upstream demo's 3D mechanism (a real WebGL glass/metal scene, studio environment, mirror floor and camera beats) but is adapted, not copied byte-for-byte, and replaces its story, brand, name and timings; the upstream fonts, voice/TTS, music, subtitle/end-card overlay, per-frame depth-of-field, caustics/sound-wave floor shader, GTAO pass and score pipeline are **NOT** included.
- Additional adapted files for the sound-arrange test kit: `core/audio/sampler.py` (round-robin/velocity selection, one-shot truncation, pitched playback, level normalisation), `core/audio/sfx.py` (equal-power pan and filter practice), `core/audio/pluck.py` (Karplus-Strong waveguide + body resonance), `styles/living-screencast/demo/sound.py` (event list on the picture clock, section dynamics, a deliberate rest), `styles/pictogram-motion/demo/music/music.py` (separate layers and a small synthetic room).
- Scope (sound): the test-only `sound-arrange` kit under `tests/fixtures/audio/sound-arrange/` is an independent JavaScript reimplementation for `window.viscraftSound` — no Python/NumPy/SciPy/soxr/numba, no upstream instruments, index files, TTS, mux or second timeline; a new score and gain structure; a seeded PRNG; Blackman-windowed sinc resampling. No Manim-derived code is present in these files, so no Manim notice applies.
- Additional adapted files for `storybook-score`: `styles/crayon-book/demo/music/score.py` (four-bar theme 68–78; toy/reed change 94–119; breath/wind-down and silent rest 145, 183–194, 119 + 225–228; coda-rate idea 196–211; `toy()` 30–44) and `core/audio/pluck.py` (`_modal` music-box branch 191–210; `harp` preset line 99 and string-model concepts). The 40 s form, answer phrases, alternate orchestration, flute/reed synthesis and timings are original.
- Additional adapted files for risograph sound (`code-visuals/risograph/synth.mjs`): `styles/risograph/demo/music/score.py` (waveguide/string 58–120; vibes 123–133; whistle 136–159; procedural percussion/filter/pan mechanisms) and `styles/risograph/demo/music/bell.py` (single-strike model 10–51). The local ride score and Foley event map are original; no upstream complete score or rendered audio is carried.
- Additional adapted files for `cartoon-jazz`: selected theme, stride/oompah, harmonic-plan, slide-whistle/spring, stop-time and synthetic-room sections of `styles/rubber-hose/demo/music/score.py`; the Karplus-Strong waveguide and plucked-string body of `core/audio/pluck.py`; and the equal-power pan, one-pole filtering, band-limited noise and headroom practice of `core/audio/sfx.py`.
- Additional adapted files for `plucked-breath`: `styles/ink-wash/demo/music/score.py` (helpers 20–24; xiao idea 27–34; sparse opening 44–63; ostinato 65–84; crescendo 86–98; pre-reverb/hard cut 100–114; cadence 133; exact-zero gate 154–159) and `core/audio/pluck.py` (variable-delay waveguide 39–60; guqin preset 91; body bank 75–83; pitch curves 121–132; harmonic variant and body application 135–160, 173–180).
- Additional adapted files for crayon page material sound (`code-visuals/crayon-book/foley.mjs`): `styles/urban-sketch/demo/audio/foley.py` (pen 20–47 and wet 49–63) and selected noise, one-pole low/high pass and band-pass practice from `core/audio/sfx.py`. Only wax-friction and wet-pigment methods are adapted. Local action windows and growth envelopes are original; no upstream cues.json, movement track, wind/paper/body/ambience story, recording or sampled material is carried.
- Scope (three independent sound references): `storybook-score`, `cartoon-jazz` and `plucked-breath` under `skills/viscraft/assets/studies/audio/`. Their actual adopted themes, harmony, arrangement and synthesis mechanisms are identified above and in each local licence file. Rendered audio is synthesized locally; no upstream rendered audio, stems, sample pack, TTS voice, fonts, images or film is copied. The procedural instrument models are not recordings.
- Additional adapted files for the new code-visual references: `styles/pictogram-motion/demo/engine.js` (only the joint/pose-interpolation and far/near draw-order sections; the official palette, motif/pattern language, event marks and `ref/` images are **NOT** used) and `styles/pictogram-motion/demo/poses/base.js` (geometric prop helpers only; no pose tables); `styles/crayon-book/demo/{crayon,gl,rig,pal}.js` and the `clamp`, `lerp`, `hash` and `vnoise` helpers from `core/lib.js`; `styles/risograph/demo/{riso,draw,rider}.js`.
- Scope (new code-visual references): the `pictogram-characters`, `crayon-book`, `kinetic-type` and `risograph` references under `skills/viscraft/assets/studies/code-visuals/`. Pictogram and crayon are adapted, not copied byte-for-byte: their icon/character bodies, page art, choreography and palettes are original. Crayon `chars.js`, `end.js`, all upstream fonts, voice/TTS, music, film/world/page-turn closures and sampled media are **NOT** included. Risograph retains the upstream rider, bicycle, pigeon and baguette shapes under MIT, with original scene compositions and ride actions; its local bossa cue and Foley design are original, and no upstream audio is carried. Its local `synth.mjs` is adapted from the risograph music/score.py and bell.py mechanisms identified above and owned only by this audiovisual reference. Upstream fonts, voice, music, sound effects and official marks are **NOT** included. `kinetic-type` is an original canvas-2D implementation: its grid, mask, reading-hold and emphasis mechanisms were studied from `styles/swiss-motion/demo/{film,ease}.js` and huashu's `scripts/engine/clips/y5_kinetic_type.js`, but no source bytes from either are included (its bundled font is licensed separately below). The crayon page additionally carries local material sound, with selected upstream pen/wet/filter methods credited above and one shared page-action file.
- Additional adapted files for the `ink-wash` reference: `styles/ink-wash/demo/{ink,comp,hero,land,wave}.js`, and the `clamp`, `lerp`, `ss`/`eio`/`eo` easing, `mulberry`, `hash` and `vnoise` helpers from `core/lib.js`.
- Scope (`ink-wash`): the `ink-wash` reference under `skills/viscraft/assets/studies/code-visuals/`, adapted rather than copied byte-for-byte. It keeps the stroke/bristle model with its pressure profile and loaded dark side, the wet/dry/colour layers and blot/mass, the WebGL2 rice-paper compositor (procedural paper, wet bleed, edge pigment, dry paper tooth, ink-bloom reveal), the 100-unit xieyi figure with `POSE`/`mixPose`, hat/robe/sleeve construction and ribbon, the ridge/mountain/`cun`/cliff/pine/reed/ink-ring landscape and the gesture-built wave body used as a low river swell. The river-crossing and pine-path scenes, their beats, cameras, staff, vermilion sash and abstract end chop are original. The written 水 from `glyph.js` and its traced strokes, inscriptions, subtitles, face close-up, whole-film story/shot runner, sword and sheath/tassel actions, external fonts, music, voice and sound effects are **NOT** included; no text is drawn and no font is loaded.
- Additional adapted files for the `rubber-hose` reference: `styles/rubber-hose/demo/{toon,chars,cast,bg,film}.js`, and the `clamp`, `lerp`, `hash`, `vnoise`, `mulberry`, easing and spline helpers from `core/lib.js`.
- Scope (`rubber-hose`): the `rubber-hose` reference under `skills/viscraft/assets/studies/code-visuals/`, adapted rather than copied byte-for-byte. It keeps the screen-space affine stack, constant-width ink and three-drawing line boil, flat-fill/hard-shadow/outline order, the pie eyes, brows, mouths, gloves, shoes, noodle limbs, steam, the mug rig and the projected sugar-cube rig, the alarm-clock and plate props, the watercolour-flat background and the 4:3 rounded film gate with weave, flicker, scratches, dust, a hair and vignette. The spoon-stir and plate-stair/clock actions, camera push and two timelines are original. The upstream `main/scenes/story/ui/sheet/events` film closure, the chasing story, Baloo/Shrikhand/Limelight/IM Fell fonts, voice/TTS, music, samples and title/end-card text are **NOT** included; there is no network request. The upstream `styles/rubber-hose/demo/toon.js` header records that it was copied from `styles/scifi-toon/demo/toon.js` with ink/line-width and affine changes; this notice attributes the bytes adopted here to the pinned rubber-hose version and preserves that derivative relation; the `scifi-toon` directory is not adopted.
- Additional adapted files for the `pixel-art` reference: `styles/pixel-rpg/demo/{px,sprites,font}.js`.
- Scope (`pixel-art`): the `pixel-art` reference under `skills/viscraft/assets/studies/code-visuals/`, adapted rather than copied byte-for-byte. It keeps the indexed 320x180 framebuffer with transparent value 255, the ENDESGA-32 colour list plus seven protected duplicate indices, the index-to-ABGR lookup/faded ramp, 4x4 Bayer dither, the 48x48 capsule rig with hand-placed Wren/Arlo heads, the `ox=24/oy=44` feet anchor, the scarf-tail stepping and the variable-width bitmap font. The night shrine, timeline, offer/guard actions and palette-response staging are original. Its `main/scenes/props/ui/portraits/memscenes/memsprites/sheet/pixel` modules, the upstream save crystal, original voice, music and sampled sound are **NOT** included. The bitmap font is the local 80-glyph ASCII set (letters, digits, space and `.,!?'-:/()=+%" ;_&`), not the complete upstream font; there is no CJK coverage and no system-font fallback. The reference claims no RPG, World, real-time input, menu, dialogue or save capability.

### MIT license (verbatim)

The MIT License

Copyright © LemoLab

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

### ENDESGA 32 palette — attribution as stated upstream

The `pixel-art` reference uses the ENDESGA 32 colour list. The upstream `CREDITS` states: "Master palette = ENDESGA 32 by ENDESGA (public palette, lospec.com/palette-list/endesga-32), used freely as a color list." That sentence is reproduced as the upstream statement it is; it is not a licence grant, this notice makes no separate licence review for the palette, and no palette image or other asset is redistributed.

## CC0 recordings — sound-arrange test kit

The `sound-arrange` **test kit** uses eight recordings dedicated to the public
domain under CC0 1.0 Universal. The bytes are kept with the test-only fixture in
`tests/fixtures/audio/sound-arrange/samples/`, where `samples/LICENSE.md` records
the exact repository, commit, path, git blob, size and SHA-256 of each file and
reproduces the CC0 text; the kit's `LICENSES.md` carries the MIT and CC0 texts.
The fixture is not a Skill creative reference and is not distributed as one. The `contact-study` fixture copies the three recordings it actually strikes and records their rights. The eight files are
retained for real decoding, round-robin and pitched-playback tests, not
regenerated or replaced with fake audio.

| File | Repository | Commit | Path |
| --- | --- | --- | --- |
| `clap-rr1.wav` | `sgossner/VCSL` | `c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e` | `Idiophones/Struck Idiophones/Claps/Clap_rr1.wav` |
| `clap-rr2.wav` | `sgossner/VCSL` | `c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e` | `Idiophones/Struck Idiophones/Claps/Clap_rr2.wav` |
| `clap-rr3.wav` | `sgossner/VCSL` | `c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e` | `Idiophones/Struck Idiophones/Claps/Clap_rr3.wav` |
| `woodblock-2-mp.wav` | `sgossner/VCSL` | `c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e` | `Idiophones/Struck Idiophones/Woodblock/wood_click2_mp.wav` |
| `shaker-double-down-rr1.wav` | `sgossner/VCSL` | `c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e` | `Idiophones/Struck Idiophones/Shaker, Small/Mid_ShakerDouble_Down_rr1.wav` |
| `cello-pizz-b3-rr1.wav` | `sgossner/VSCO-2-CE` | `440300901dfe9275fd84e0b7763af1f8443ae62e` | `Strings/Cello Section/pizzT/pizzT_B3_v1_RR1.wav` |
| `cello-pizz-b3-rr2.wav` | `sgossner/VSCO-2-CE` | `440300901dfe9275fd84e0b7763af1f8443ae62e` | `Strings/Cello Section/pizzT/pizzT_B3_v1_RR2.wav` |
| `marimba-c6-loud-01.wav` | `sgossner/VSCO-2-CE` | `440300901dfe9275fd84e0b7763af1f8443ae62e` | `Percussion/Marimba/Marimba_hit_Outrigger_C6_loud_01.wav` |

No sample authorship is reassigned and no library as a whole is used.

## Five More Minutes — complete work

`skills/viscraft/assets/projects/five-more-minutes/` contains Viscraft-owned
author code, film, review imagery, music and Foley under Apache-2.0. The complete
grant is in `project/LICENSE-Apache-2.0.txt` and its scope in `project/LICENSES.md`.
The bundled Noto Sans SC font retains OFL-1.1. No stock image or sampled recording
is included; the soundtrack is procedural.

## Beyond the Frame — complete work

`skills/viscraft/assets/projects/beyond-the-frame/` contains Viscraft-owned code,
selected MiniMax-H3 footage, generated artwork, film and review imagery under
Apache-2.0. See `project/LICENSES.md` and `project/LICENSE-Apache-2.0.txt`.
Original production origins and hashes remain in `project/production/provenance.json`;
its `distributionLicense` records the current grant. No third-party font, stock
recording or external code library is bundled with this work.

## Fonts — source-test fixture subsets (excluded from Runtime and Skill)

- Files: `NotoSansSC-400-subset.woff2`, `NotoSansSC-700-subset.woff2`,
  `SpaceGrotesk-400-subset.woff2`, `SpaceGrotesk-700-subset.woff2`, with the
  verbatim texts `OFL-NotoSansSC.txt` and `OFL-SpaceGrotesk.txt`, under
  `tests/fixtures/authoring/poster-and-film/fonts/`.
- Upstream: `@fontsource/noto-sans-sc@5.2.8` (SIL Open Font License 1.1) and
  `@fontsource/space-grotesk@5.2.8` (SIL Open Font License 1.1). Neither declares
  a Reserved Font Name; the Noto subsets were cut with `pyftsubset` (GB2312 level
  1 plus Latin/punctuation ranges), so they are not the full CJK block.
- Scope: these bytes exist only for the poster/film regression fixture. They are
  not a product font library and are not in the npm package; the complete OFL
  text travels beside them, unmodified. The fixture's recipe declares them as
  local files with their real rights.

## A New Dimension of Sound — complete campaign

`skills/viscraft/assets/projects/quiet-new-dimension/` contains the Viscraft-owned
poster, film, author code, product artwork, selected generated footage, score and
review imagery under Apache-2.0. Its complete Noto Sans SC font retains OFL-1.1.
See `project/LICENSES.md`, `project/LICENSE-APACHE-2.0.txt`,
`project/assets/fonts/OFL-NotoSansSC.txt` and `project/production/provenance.json`.

## Fonts — complete Noto Sans SC in kinetic-type and Five More Minutes

- Files: `skills/viscraft/assets/studies/code-visuals/kinetic-type/fonts/NotoSansSC-VF.woff2`
  and the byte-identical `skills/viscraft/assets/projects/five-more-minutes/project/assets/fonts/NotoSansSC-VF.woff2`.
- Upstream: `google/fonts` at commit `47d54ca1ebb14fd864695f1d39dc734f39017c33`,
  `ofl/notosanssc/NotoSansSC[wght].ttf` (GitHub blob
  `fb0637bafbcd804fe32152370a1225990745b4bc`, 17,772,300 bytes, SHA-256
  `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`).
- Licence: SIL Open Font License 1.1, Copyright 2014-2021 Adobe, Reserved Font
  Name "Source"; the verbatim text is `fonts/OFL-NotoSansSC.txt`
  (SHA-256 `1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9`).
- Delivered form: a lossless WOFF2 recompression of the complete variable font
  (fontTools 4.65.0), SHA-256
  `aef8c34277afad81ecd0227138a830263c0caea65b7aea66d1195395f097b55a`.
  The cmap (30,890 code points), glyph order (31,036 glyphs), metrics and
  outlines are unchanged; no subsetting or outline modification was applied.
  The font is declared as that reference's Project font Asset, not as a global
  font library. Five More Minutes keeps its own complete OFL text under
  `assets/fonts/OFL-NotoSansSC.txt`; its reproduction recipe registers the same
  font rights. The full work's authoring and rendered-media scope is described
  in that reference's `LICENSES.md`; the font licence does not license the film.

### SIL Open Font License 1.1 (verbatim)

Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
https://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.

## Editable-Design — vendored image-editor (layer editor)

- Source: `yejy53/Editable-Design`, commit `c87b16f6d7c198e2b6967f13f1b1baa939d6f31f`.
- Licence: Apache License 2.0, reproduced in full below.
- Vendored files: `src/workbench/ui/vendor/layer-editor.js` and `layer-editor.css`.
  `layer-editor.css` scopes the editor font stack to chrome rather than the author
  body, preserving inherited artwork typography, and adopts Viscraft's warm ivory/terracotta
  chrome, selection and handle palette. `layer-editor.js` carries the
  upstream copyright/attribution header and a documented list of modifications.
- Modifications (see `layer-editor.upstream.patch` for the exact diff): removed the
  browser-localStorage draft subsystem so a save has ONE authority (the local
  workbench service); English user-visible strings for the shipped Runtime; removed
  the download/exploded/copy-CSS toolbar actions, whose jobs now belong to the
  workbench host; Ctrl/Cmd+S asks the host to save; the host saves the served author
  document plus the editor's explicit edit state (text, font/style, geometry,
  removals) instead of re-serializing the live DOM, and keeps the author's body
  classes. Font choices include project font faces/used stacks and generic system
  families; text/font undo restores its previous geometry, and layout reset is
  undoable. Grouped layout/full-edit resets use the browser session's opening
  design and geometry; the host provides a reversible source remount without
  advancing that baseline on Save or Export;
  editor shortcuts are collapsed on demand and its duplicate title is hidden.
  The upstream explode view is reused only as the workbench's optional layer-structure
  toggle ("View layers" / "Back to editing"); its unrelated gallery and Replay
  surfaces stay out of scope.
- Scope: only the layer editor's drag/resize/text/snap/undo/layer-list and
  optional layer-structure-view behaviour is reused, inside the on-demand workbench.
  No upstream poster templates, Replay
  viewer, PPTX conversion, fonts, gallery or model integration are included.

### Apache License 2.0 (verbatim)

Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.

## Taste Skill and Impeccable — adapted authoring guidance

Two design Skill projects informed the craft pages named below through guidance
rewritten for film, still and sound authoring. No upstream authoring source files
or media are included; the adapted guidance, scope and licence terms are
recorded here.

- Taste Skill — `Leonxlnx/taste-skill`, commit
  `6010f91a9935f1c167dfc500fb1a475681892e6b`, MIT, Copyright (c) 2026 Leonxlnx.
  https://github.com/Leonxlnx/taste-skill
- Impeccable — `pbakaus/impeccable`, commit
  `dad8dbb3aac21ad1fa236c110315ef4abece23e8`, Apache License 2.0, Copyright 2025
  Paul Bakaus. https://github.com/pbakaus/impeccable

Scope, by destination page:

- `skills/viscraft/references/craft/creative-method.md` — "Derive the device
  from the subject": read the brief for real material, derive a visual device
  from the subject's own form, behaviour or output, and test a generic composition
  by substituting another subject. Adapted from Taste's `SKILL.md` (read the
  brief, find the idea, competing-brand substitution).
- `skills/viscraft/references/craft/image-direction.md` — "Design for the
  canvas": one primary read, a deliberate type scale, a long title that has
  become unreadable resolved through measure, line breaks or surrounding
  composition with type size adjusted to the actual viewing conditions,
  whitespace as grouping, CJK/Latin metrics, and checks at delivery size with a
  modest thumbnail for focus and hierarchy. Adapted from Taste's `type.md`,
  `layout.md`, `colour.md` and `critique.md`.
- `skills/viscraft/references/craft/review-repair.md` — "Turn a reaction into a
  scoped change" and the added text-review questions: name the observable cause
  behind bolder/quieter/simpler/more-polished feedback, change the layer that owns
  it, protect what must stay, then re-check the affected passages and their
  neighbours. Adapted from Impeccable's `bolder.md`, `quieter.md`,
  `distill.md`, `polish.md` and `critique.md`, and Taste's `critique.md`.

Changes: the guidance is rewritten as working instructions for this product, with
the cinematic and sound extensions written here; no upstream sentence or passage
is reproduced. No upstream source code, scripts, scene assets, fonts, media,
Rust/WASM, detection engine or model integration is included, and no fixed review
pass count, weighted score, style quota or gate is adopted.

Licence terms: Taste's MIT licence is reproduced verbatim below. Apache License
2.0 terms are reproduced in full, reflowed with the standard appendix, under
"Editable-Design — vendored image-editor (layer editor)" above. Copyright 2025
Paul Bakaus applies to the adapted Impeccable guidance. The Skill carries the
attribution, scope and both verbatim upstream licence texts, including that
copyright, in [its own notice](skills/viscraft/THIRD_PARTY_NOTICES.md), so a
Skill-only installation remains self-contained. The two notices must agree on
the adopted scope and applicable terms.
Impeccable's `NOTICE.md` attributes its iOS/Android platform references to
ehmo's `platform-design-skills` (MIT); those reference files are outside this
scope and none of their content is used.

### MIT license (verbatim)

MIT License

Copyright (c) 2026 Leonxlnx

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Locally rendered study previews

The `preview.mp4` and `preview.mp3` browsing files beside the Skill studies
are rendered locally from the corresponding reference source. No upstream
sample movie, rendered soundtrack or new third-party recording is included.
The implementation, character and font provenance remains in the entries
above and each study's adjacent licence files; the audio is procedural.
These previews show the source at the stated parameters, not an assertion of
artistic acceptance or a separately approved user work.
