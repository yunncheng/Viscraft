# cel-watercolor — a local cel + watercolour layered-material reference

For visual intent and adaptation, start with the [style reference](STYLE.md).
This page owns usage, parameters and the editable creation entry; the module
bytes live in this directory and are declared by the recipe.

A small, self-contained CodeScene **material / styling** reference. It
demonstrates a *cel + watercolour* material process — a flat cel base with a hard
terminator, an ink contour, and washes with wet edges, pigment pooling and paper
grain — rather than generic geometry with a filter on top. Read it as a local
study of layered contour, flat fill, wash and paper, not as a mature watercolour
style engine or a complete illustration system.

> **Honest scope.** This is a *stylized* cel / watercolour landscape Look. It is
> **not** photorealism, and it does **not** recover editable paint layers or a
> scanned-paper scan — the paper and every wash are generated procedurally from a
> seed each run. Deterministic rendering does not mean the picture meets the
> work's goal; inspect the actual output.

## The mechanism: an ordered paint stack

`PAINT_STAGES` is an **ordered draw stack**, applied in this order:

```
paper → sky → celHills → terminator → bleed → ground → plants → foliage → detail → contour
```

Two material families are combined, which is the craft point:

**CEL helpers** (`flatBase`, `hardTerminator`, `inkContour`, `misregistered`)

1. **flatBase** — a shape filled flat with one tone (no gradient).
2. **hardTerminator** — clip to the shape and fill the *crescent* left by shifting
   a copy of the shape along the light axis (`azimuth`). The lit/shadow split is a
   crisp cut, never a gradient — this is what reads as cel.
3. **inkContour** — the cleaned ink outline of a ridge / polyline.
4. **misregistered** — the whole ink pass is drawn at a constant sub-pixel offset
   (`misregistration`) for a hand-inked feel.

**WATERCOLOUR helpers** (`wash`, `wetEdge`, `pigmentPool`, `bleedWash`,
`paperGrain`, `brushStroke`, `foliage`, `tussock`)

- **wash** — a graded, semi-transparent fill clipped to a shape.
- **wetEdge** — the darker rim where a wash pools at its boundary, drawn as
  per-segment strokes with seeded wobble and varying alpha (never a clean line).
- **pigmentPool** — granulation: seeded soft blobs clipped to the wash.
- **bleedWash** — a soft halo along a wet boundary (a blurred stroke).
- **paperGrain** — procedural paper: the base tone multiplied by seeded value
  noise (tooth) plus dark fibres, generated once on a cached offscreen canvas.
- **brushStroke** — one tapered, width-profiled ribbon along a spine, with a
  seeded rough edge and a partial-length `p` so a stroke can be revealed.
- **foliage / tussock** — clumps of leaf blades and grass fans drawn from those
  strokes.

## The reveal is a pure function of the frame

Every stage has a reveal window (`WINDOWS`) mapped onto the shot length
(`revealFrames`). Progress is `revealAt(frame, start, duration)` — the frame index
alone drives the build-up, and within a stage each hill / leaf / blade is
staggered so paint is laid down piece by piece. Because geometry is rebuilt from
the seed every frame in a fixed order, `p` only changes **how much** is drawn,
never **where**: nothing re-rolls, so a completed frame is stable (no flicker).
`Math.random`, `Date.now`, `requestAnimationFrame` and the wall clock are not used.

## Parameters

| Param | Meaning | Default |
| --- | --- | --- |
| `subject` | `'grove'` (a lone tree) \| `'meadow'` (hills + shrubs + grass) | `'grove'` |
| `layout` | `'wide'` \| `'portrait'` \| `'square'` (framing hint) | `'wide'` |
| `revealFrames` | Frames over which the paint builds up and completes | `48` |
| `celEdge` | `0..1`; hard terminator strength | `0.85` |
| `azimuth` | Radians; light axis (the shadow is cast opposite) | `2.3` |
| `bleed` | `0..1`; soft bleed halo around a wash | `0.6` |
| `wetEdge` | `0..1`; broken darker rim on boundaries | `0.55` |
| `pooling` | `0..1`; pigment granulation inside a wash | `0.5` |
| `grain` | `0..1`; procedural paper grain strength | `0.35` |
| `inkWeight` | Ink weight (scaled to the smaller output dimension) | `2.4` |
| `misregistration` | `{ dx, dy }` sub-pixel ink offset | `{ dx: 0.8, dy: -0.6 }` |
| `density` | `0..4`; foliage / grass density multiplier | `1` |
| `palette` | `{ paper, sky, skyDeep, hillFar, hillMid, hillNear, ground, trunk, leaf, leafDeep, ink, accent }` | see `DEFAULT_PALETTE` |
| `seed` | Source `seed`; keys every stroke and the paper grain | (source seed) |

Unknown subjects / layouts, out-of-range numbers and non-`#rrggbb` colours fail
loudly.

## Resources and contract

- **Resources.** The entry imports `./cel-watercolor.mjs`; declare it in the
  Source's `resources` so it is frozen and hashed into the capture. A missing
  declared resource fails the capture loudly — it never renders a blank success.
- **Contract.** `cel-watercolor-scene.html` sets
  `window.viscraft = { render(ctx) }`; `render` is called once per frame with
  `{ frame, time, fps, width, height, seed, params, bindings }`. The canvas is
  resized to `ctx.width × ctx.height` every call, so one module frames any size.
- **No network / fonts / GSAP / wall clock.** 2-D canvas only; no three.js.

## Integration — executable command

Author a Project with the recipe, then build it with the separate command:

```bash
<viscraft> author <skill-dir>/assets/studies/code-visuals/cel-watercolor/create.mjs ./my-cel-watercolor \
  --options cel-watercolor-options.json
<viscraft> build ./my-cel-watercolor
```

`options.json` accepts `width`, `height` and `frames` (positive integers; width
and height even). Defaults are 1920×1080 and 24 frames per source. The two
landscape subjects, wash/pooling/grain parameters and palettes are editable code
in the recipe.

The recipe declares `cel-watercolor.mjs` and `cel-watercolor-scene.html` from this
directory with `sourcePath`, so the copied `code` Asset carries Apache-2.0 and retained upstream MIT rights;
`authorProject` copies them and derives the hashes. The recipe authors two `browser` picture Sources (`grove-wash`, `meadow-wash`) that declare
`cel-watercolor.mjs` in `resources` and their Look in `params`.

## Adapting upstream — what was and was not ported

Adapted from the MIT-licensed `lemo-opuscar` canvas-2D demos
(`styles/cel-anime-80s/demo/cel.js` and
`styles/watercolor/demo/{engine,plants,scene}.js`, LemoLab, commit `e3cb16f6`).
The Look is an **independent reimplementation**; no upstream file is copied.

- **Kept as mechanism:** the cel `path/cel/line/rng/hash/mix/rgba` ideas (here
  `flatBase` / `hardTerminator` / `brushStroke` / the seeded PRNG), and the
  watercolour `engine`/`plants` ideas (`mulberry`/`fbm`, `qcurve`/`polar`, the
  width-profiled stroke with a partial-length reveal, `clump` foliage, the
  layered-landscape reveal).
- **De-globalised:** the watercolour show was a plain `<script>` globals chain
  with `window.DUR`/`window.VO`, a `window.render(t)` plus `window.READY` RAF
  loop. That chain is folded into this ESM module exposing the pure per-frame
  `window.viscraft.render(ctx)` contract.
- **Reimplemented, not ported:** the paper texture. Upstream baked `paper.jpg`
  with NumPy/PIL (`paper.py` + a `sheet.py`). Python is **not** ported — the paper
  grain here is generated in canvas JS from seeded value noise plus fibres. There
  is **no** vendored paper image.
- **Excluded on purpose:** no upstream font, voice, TTS, music or third-party
  audio is included, and the Australian-landscape subjects, the cel figure
  subjects (`hands.js`, `rider.js`, `head80.js`) and the timeline / map / HUD
  code are not part of this module.

## Licence

The adapted `lemo-opuscar` canvas-2D files are MIT (LemoLab, commit
`e3cb16f6…`); their MIT text is carried into every Project through the Runtime's
`THIRD_PARTY_NOTICES.md` rather than a local file. The independent
reimplementation in `cel-watercolor.mjs`, its scene entry and the recipe are
original Viscraft work, Apache-2.0, `Copyright (c) 2026 The Viscraft Authors`, recorded
with retained upstream MIT in each mixed code Asset's rights. The full grants and texts ship as
[`LICENSES.md`](LICENSES.md), copied into every authored Project as a `license`
handoff beside the Runtime notice.

Preview: `preview.mp4` — 1920×1080, 24 fps, 8 s, silent.

Viscraft-owned contributions and previews use Apache-2.0. Upstream code and
third-party materials retain their notices. See [licences](LICENSES.md) for the
complete texts and scope; this does not set the licence of your whole new work.
