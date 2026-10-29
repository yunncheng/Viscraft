# Ink wash — xieyi figure, loaded strokes and rice paper

Two short scenes painted with the same brush engine: a figure crosses a river by
touching the water and leaping to the far bank; a second figure walks a pine
path with a staff, plants it and offers a fist-and-palm salute. The study is
about the **material** — a loaded stroke whose dark edge is the contour, a wet
wash that bleeds and deposits an edge, dry bristles that leave flying white, and
warm rice paper that stays mostly empty — and about two clocks: the figure is
drawn on twos at 12 fps while the camera, ink bloom, rings and swell move at
24 fps.

## What is visible

- **Xieyi figure.** A 100-unit rig (hip, chest, head, arms, legs, hem, flare,
  ribbon): one pale robe mass, two loaded strokes with the dark side at back and
  front, burnt-ink belt, legs and feet, a wet hat cone with a burnt brim line,
  a face in three to five strokes. The hat and robe hem carry the silhouette;
  the face stays under the hat.
- **Loaded strokes, not outlines.** Each robe/rock/wave stroke has a lighter
  body and a dark side (`darkDir`/`side`), with wet bristles inside the stroke.
  Dry strokes break into bristle tracks on long-scale noise (`dry` 0.5–0.8).
- **Three layers.** Wet ink is blurred and its edge darkens in the compositor;
  dry ink only gets fibre jitter and paper tooth; the colour layer holds exactly
  one vermilion accent. The paper is procedural in the shader (cloud mottling,
  three fibre directions, grain, pulp flecks, vignette) and is anchored to the
  world, so a camera move slides the painting over the paper.
- **Blank-paper water.** The river is mostly paper: a few faint dry lines, open
  ink rings at each touch, spray blots, and a low wave swell when the figure
  lands. The bank feet dissolve into the water instead of ending on a hard edge.
- **Two real scenes.** `river` starts on a low bank, touches the surface twice,
  makes a long leap to the far bank, skids and settles. `pine` walks a path with
  a staff, stops and plants it, then a hard cut to a closer frontal frame for
  the salute. The place, action, framing and prop change; neither scene is a
  recolour or a seed swap.
- **Ink bloom opening.** Each scene is revealed from an expanding noisy ink
  bloom (the shader's `rev` mask), not a generic fade.
- **A finish.** A small abstract chop (irregular red square, knocked-out border,
  paste speckles) fades in at the end. It carries no glyph or character.

No text, font, image or audio is used. The page is Canvas2D + WebGL2 only.

## Defaults

| Fact | Value |
| --- | --- |
| Entry | `ink-wash-scene.html` |
| Module / resource | `ink-wash.mjs` |
| Recipe | `create.mjs` |
| Source length | 168 frames at 24 fps = **7.0 s** per Source |
| Project | 2 Sources = 336 frames = **14.0 s** |
| Source ids | `river_crossing` (variant `river`), `pine_salute` (variant `pine`) |
| Seeds | 7711 / 7712 carried by the Sources; this scene uses fixed internal stroke/material seeds and does not consume the Source seed |
| Output | 1920×1080 by default; any even size accepted |
| Audio | none (`composition.audio: []`) |
| Licence | `LICENSE-Lemo-Opuscar-MIT.txt` |

`options` accepts `width`, `height` and `frames` (positive integers; width and
height must be even). The recipe writes `frames` to **both** `source.frames` and
`source.params.frames`; the module derives the action from `params.frames`, so
keep them equal when editing by hand. A shorter test source shortens every beat
in proportion; it does not read the source length from `ctx`.

## The two clocks

- **Figure:** `figureClock(time) = floor(time × 12) / 12`. Every figure drawing is
  held for two 24 fps frames. Stroke seeds depend on the stroke index, not on
  time; the only frame-to-frame variation is a five-drawing width `boil`, so the
  flying-white texture does not crawl.
- **Camera, bloom, rings, swell, shake, chop:** evaluated at `ctx.time` (24 fps
  continuously). The camera tracks with lead room and a slow push; the opening
  bloom radius uses an eased continuous clock.

## Pure story functions

`ink-wash.mjs` exports:

```js
import { figureClock, riverAt, pineAt, mixPose, POSE } from './ink-wash.mjs';

figureClock(1 / 24); // 0 — still the first drawing
const a = riverAt(2.0, { frames: 168, fps: 24 });
// { u, t12, phase, pose, x, y, camera, rings, spray, swell, shake, reveal, seal }
const b = pineAt(5.0, { frames: 168, fps: 24 });
// { shot: 'walk'|'bow', phase, pose, x, y, staff, camera, dust, reveal, seal }
```

Frames are numbered from 0. The two functions are pure and may be sampled in any
order; the renderer has no per-frame accumulated state, only a size-keyed
compositor and cached static scenery. `mixPose(a, b, t)` interpolates the joint
dict recursively (arrays, numbers, objects; non-numeric fields take `b` after
`t ≥ 0.5`).

## Editing map

| Want to change | Where | Note |
| --- | --- | --- |
| Scene length | recipe `frames` (writes both source fields) | Beats are fractions of the source, so they scale. |
| River timing / path | `riverAt` phases and x/y constants | Touch and landing times also drive the ring events. |
| Pine walk / salute timing | `pineAt` (`cut`, walk range, `b`, `up`) | The cut is at 0.56 by default. |
| Figure shape / pose | `POSE`, `sideStrokes`, `frontStrokes` | Keep the 100-unit rig: feet at y=0, height 100. |
| Staff | `sideStrokes` staff block; `staff.plant` | A walking staff, not a weapon. |
| Vermilion accent | `sash()` and `drawChop()` | One accent per figure plus the end chop. |
| Palette / paper | `paperCol`, `vig`, `warm`, `VERM` at the top / compositor call | The paper is in the shader, not a texture. |
| Bleed / edge | `renderInk` `bleed`, `rim` | `bleed` is in output pixels; it scales with canvas height. |
| Brush behaviour | `PROF`, `mk`, `draw` | `dry` → flying white; `brWet` puts bristles in the wet layer. |
| Scenery | `buildRiverStatics`, `buildPineWalkStatics`, `buildPineBowStatics` | Rebuilt once per canvas size. |
| Variants | recipe `specs` and `params.variant` | Add a variant means a new time function and a new source. |

## What is adapted and what is new

Upstream: `lemo-opuscar` at
`e3cb16f63768c68693ff0e15171d6e755457cc32`, MIT, copyright © 2026 LemoLab.
Files and hashes (sha256):

| File | sha256 |
| --- | --- |
| `styles/ink-wash/demo/ink.js` | `dbe6474ab0a0798193a7b49be9a8166511bc67ced90594e4390bdb2b70eef399` |
| `styles/ink-wash/demo/comp.js` | `063b2d9fa079772de016acc99f19aabddd6dbeaa2445119d01ccac5053a281af` |
| `styles/ink-wash/demo/hero.js` | `bea1cb4f77efc89f68cbdd52cccc7c63b340ad9aa905d58453f857b3b553a798` |
| `styles/ink-wash/demo/land.js` | `687c1cc1a848e30cc7e8b2e73984f49925506f20a8500b64aac88059a02b50bb` |
| `styles/ink-wash/demo/wave.js` | `408faca9dfc67c8fd077b1c25a447d7b49d56319976151457ec1c10e91716397` |
| `core/lib.js` | `770c8fde7c43e6a8aa9f69235869eb2a6ef5dc43453d0e56d4ff0da576c83907` |

Adopted (technique, re-expressed in this module):

- `ink.js` lines ~6–208: five tones, `PROF` pressure envelopes, Catmull-Rom
  densify + arc-length resample, the stroke model with bristle load and break
  noise, the wet/dry body split, `darkDir`/`side`/`brWet` loaded-stroke logic,
  `blot` and `mass`.
- `comp.js` lines ~1–160: the rice-paper shader (cloud/fibre/grain/pulp,
  vignette, warm), the 12-tap noisy bleed, small-minus-large edge pigment, dry
  fibre jitter and paper tooth, the ink-bloom mask; the three-layer idea.
- `hero.js` lines ~1–321: the side/front 100-unit rig, `POSE` and `mixPose`,
  hat/robe/sleeve construction, collar/belt/folds, ribbon. The sword, sheath and
  tassel paths are removed.
- `land.js` lines ~1–149: ridge function, per-pixel mountain layer, `cun`,
  `cliff`, `pine`, `reed`, open ink `ripple`.
- `wave.js` lines ~1–68: gesture-built wave body; here scaled to a low river
  swell at the landing.
- `core/lib.js`: `clamp`, `lerp`, `ss`, `eio`, `eo`, `mulberry`, `hash`,
  `vnoise` (localised; no `/core/lib.js` import remains).

Original for this study: the river-crossing and pine-path scenes and their
beats, the bank/rock/path compositions, the camera moves and reveal placement,
the staff, the vermilion sash, the abstract chop, and the three-layer
(wet/dry/colour) compositing with single-pass WebGL2 wiring and size-keyed
rebuilds.

Not copied: the written 水 and `glyph.js`, the face close-up, the sword actions,
the 48 s story, shot runner, world/handscroll, inscriptions/subtitles, the
Cormorant/Ma Shan Zheng fonts, music, voice and sound effects. No font is loaded
and no text is drawn.

## Licence

The upstream files listed above are MIT (LemoLab, copyright © 2026 LemoLab); the
verbatim text ships as `LICENSE-Lemo-Opuscar-MIT.txt`. Everything original to
this study — the two scenes and their beats, the bank/rock/path compositions,
camera moves, staff, sash, chop and the three-layer WebGL2 compositing — is Apache-2.0,
`Copyright (c) 2026 The Viscraft Authors`, and retains upstream MIT alongside Apache-2.0 in each
Project's Asset rights. The full grants and texts ship as
[`LICENSES.md`](LICENSES.md), copied into every authored Project as a `license`
handoff.

## Build

```sh
<viscraft> author <skill-dir>/assets/studies/code-visuals/ink-wash/create.mjs ./my-ink-wash [--options options.json]
<viscraft> build ./my-ink-wash
```

`authorProject` copies the entry, module and local MIT text. The Project is
self-contained: it does not import this study or any `references/upstream/`
path.

## Scope and limits

The material and staging choices are visible in every frame:

- the banks are low slopes whose feet are masked into the river, with small
  rocks rather than tall cliffs;
- the landing is a broad low swell with few dark strokes, and its opacity fades
  before the final hold;
- a nearer range sits behind the far band, which is widened so its edge never
  enters the frame;
- the pine path carries a path wash, a dry edge and stones, the main pine is
  enlarged, and the walk mountain stays a pale far range; the `cun` material is
  used on the river banks and the nearer range in the salute shot;
- frame 0 is a mark on paper: a small wet drop at the reveal centre starts the
  bloom and the scene is painted into existence from it;
- the salute is one small dark fist at the centre of the sleeve V with a burnt
  outline, and the head is lowered a little; the returned pose carries the fist
  flag, so the centre of the V is a solid shape;
- the chop is a solid mark with a thin knocked-out border.

- The figure is deliberately a few strokes. At delivery scale the face is
  minimal and stays under the hat; this is a xieyi convention, not a finished
  character design.
- The two scenes are 7-second mechanism studies, not a film. The edit, sound,
  story and a full-performance judgement remain the author's work.
- The seal is an abstract mark, not a character and not a font.
- Water is blank paper by design; there is no simulated fluid, no reflection and
  no photo texture.
- Rendering is WebGL2; the compositor is deterministic per frame, but GPU or
  software pixel output is not promised to be byte-identical across machines.
- No audio is authored, so the study carries no sound judgement.

Preview: `preview.mp4` — 1920×1080, 24 fps, 14 s, silent.

Viscraft-owned contributions and previews use Apache-2.0. Upstream code and
third-party materials retain their notices. See [licences](LICENSES.md) for the
complete texts and scope; this does not set the licence of your whole new work.
