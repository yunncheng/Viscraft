# paint-material — a local wash / brush / collage material reference

For visual intent and adaptation, start with the [style reference](STYLE.md).
This page owns usage, parameters and the editable creation entry; the module
bytes live in this directory and are declared by the recipe.

A small, self-contained CodeScene **material** module. It paints a *hand-made*
Look from three families of mechanisms, each exposed as a mode:

```
PAINT_MODES = ['wash', 'brush', 'collage']
```

- **wash** — watercolor. Region silhouettes are edge-deformed into several
  low-alpha `multiply` layers; each layer deposits a faint same-colour edge (the
  water edge). Over a paper ground with seeded grain.
- **brush** — ink brush + impasto. A Chinese brush stroke is a width-profiled
  ribbon core plus per-bristle broken lines ("flying white") that get drier
  toward the tail; a soft pigment bloom sits under the subject, and a few thick
  bristle (impasto) strokes add light.
- **collage** — cut paper. Torn-edge cut-outs with a white sticker edge and a
  drop shadow, laid down in a stepped slide-in, then taped, pinned and
  marker-highlighted.

The three expressions stay in this one directory as three separate entry
Sources, not three packages or a component library:

| Expression | Source id | What it demonstrates |
| --- | --- | --- |
| wash | `wash-panel` | translucent layered fills, deposited water edges and paper grain |
| brush | `brush-panel` | a width-profiled ink ribbon, broken bristles/"flying white" and a pigment bloom |
| collage | `collage-panel` | torn cut-paper edges, a white sticker edge, shadow and pinned/tape assembly |

Read the mode's own branch in `paint-material.mjs` and run that Source; combine
the mechanisms only when the composition needs more than one.

> **Honest scope.** This is a **stylized** procedural paint/collage Look. It is
> **not** photorealism, **not** a general raster-paint engine, and it does **not**
> repaint an arbitrary supplied bitmap — there is no external image in the
> pure-frame contract, so the module synthesizes its own simple composition
> (horizon / sun / hills / vase) and paints *that*. Deterministic rendering does
> not mean the picture meets the work's goal; inspect the actual output.

## The mechanism

Every mechanism is a **deterministic function of `(frame, seed, params)`**. The
upstream library this is adapted from registers onto `window.PAINT` / `window.CL`
and hooks a `U.onStage` render loop; here that is unwound:

- no `window`, no globals — every mechanism is a plain ESM export;
- randomness is an **explicit seeded PRNG** (`mulberry32`) threaded in by the
  caller, never `Math.random`;
- no `requestAnimationFrame` and no wall clock — `ctx.time` is the capture's
  virtual time;
- the canvas size and the composition are parameterized instead of the upstream
  fixed `1920x1080`, and paper grain is seeded and cached (so it never re-rolls
  across frames).

The optional `boilFps` re-seeds the hand-drawn line at that rate — the stylized
"boiling line" of hand-drawn animation. It is a pure function of `ctx.time`
(`floor(time * boilFps)`), so it stays reproducible per frame and is off (`0`) by
default.

Every mode draws a flat, low-key **underpainting** of the whole composition
first, and the reveal only gates the *mechanism* on top (wash layers, brush
strokes, cut-paper pieces). An animated reveal therefore builds from a clean
underpainting to a finished picture — it never opens on an empty/blank frame.

## Two subjects

`subject: 'landscape'` places the horizon high; `subject: 'still'` places it
lower and grounds the central vase on a table line. Both feed the same three
modes — only `params` (and `seed`) change.

## Parameters

| Param | Meaning | Default |
| --- | --- | --- |
| `mode` | `'wash'` \| `'brush'` \| `'collage'` | `'wash'` |
| `subject` | `'landscape'` \| `'still'` | `'landscape'` |
| `reveal` | Painted fraction `0..1` (used when `revealSeconds` is 0) | `1` |
| `revealSeconds` | `>0`: animate the reveal over this many seconds of `ctx.time` | `0` |
| `seed` | Keys the composition and every mechanism (falls back to the Source `seed`) | `0` |
| `boilFps` | `>0`: re-seed the hand-drawn line at this rate (boiling line) | `0` |
| `grainDensity` | Paper-grain speckle density `0..1` | `0.05` |
| `grainAlpha` | Paper-grain opacity `0..1` | `0.16` |
| `washLayers` | Watercolor layers per region | `6` |
| `washAlpha` | Per-layer wash opacity | `0.16` |
| `washAmp` | Wash edge-deformation amplitude (px) | `12` |
| `washEdge` | Water-edge deposit opacity `0..1` | `0.1` |
| `inkWidth` | Brush stroke width (px) | `18` |
| `inkDry` | Flying-white dryness `0..1` (drier toward the tail) | `0.5` |
| `inkBristles` | Bristles per brush stroke | `9` |
| `inkTone` | Ink opacity scaling `0..1` | `0.88` |
| `inkStrokes` | Total strokes in brush mode | `8` |
| `collagePieces` | Cut-paper pieces (`>=` the scene shapes) | `8` |
| `collageBorder` | White sticker edge width (px) | `10` |
| `collageRotate` | Max cut-out rotation (radians) | `0.06` |
| `collageTape` / `collagePin` / `collageMarker` / `collageShadow` | On/off decorations | `true` |
| `palette` | `{ paper, sky, ground, sun, hillBack, hillFront, subject, ink, accent }` | see `DEFAULT_PALETTE` |

Invalid or unknown values (bad mode/subject, non-finite numbers, non-`#rrggbb`
colours) fail loudly at authoring time — never silently mid-render.

## Resources and time ownership

- **Resources.** The scene imports `./paint-material.mjs`; declare it in the
  Source's `resources` so it is frozen and hashed into the capture. A missing
  declared resource fails the capture loudly — it never renders a blank success.
- **Time ownership.** `ctx.time` is the capture's virtual time. `revealSeconds`
  maps it to a painted fraction; `boilFps` maps it to a boiling-line step. Both
  are pure functions of time — no `Date.now`, no `requestAnimationFrame`.
- **No flicker.** Paper grain and the cut-out/scene geometry are derived from a
  fixed seed and cached, so a still Look (fixed reveal, `boilFps: 0`) is
  byte-identical across adjacent frames. Nothing re-rolls per frame.
- `renderPaint` sets the canvas to the requested output size on **every** call,
  so the same module frames any width/height.

## Integration — executable command

Author a Project with the recipe, then build it with the separate command:

```bash
<viscraft> author <skill-dir>/assets/studies/code-visuals/paint-material/create.mjs ./my-paint-material \
  --options paint-options.json
<viscraft> build ./my-paint-material
```

`options.json` accepts `width`, `height` and `frames` (positive integers; width
and height even). Defaults are 1920×1080 and 24 frames per source. The three
mechanism modes, stroke/layer/grain parameters and palettes are editable code in
the recipe.

The recipe declares `paint-material.mjs` and `paint-scene.html` from this
directory with `sourcePath`, so the copied `code` Asset carries Apache-2.0 and retained upstream MIT rights;
`authorProject` copies them and derives the hashes. The recipe authors three `browser` picture Sources (`wash-panel`, `brush-panel`,
`collage-panel`) that declare `paint-material.mjs` in `resources` and their mode
in `params`.

## Provenance and licence

Adapted from **huashu-art-motion** (`scripts/engine/lib/{paint,brush,collage}.js`,
with the shared helpers from `scripts/engine/lib/util.js`) at commit
`f178bd7754a71d6d399473af1501634548efa6cb`, author **alchaincyf**, under the
**MIT** licence. The files here are a de-globalized, pure-frame re-expression of
that source, not a byte-for-byte copy; the MIT origin is recorded in every
authored Project's Asset rights. Do **not** re-label it CC0 — the module contains
MIT-licensed adapted code. The re-expression itself is Viscraft work, Apache-2.0,
`Copyright (c) 2026 The Viscraft Authors`; the adapted huashu MIT text reaches
each Project through the Runtime's `THIRD_PARTY_NOTICES.md`, and the full grants
ship as [`LICENSES.md`](LICENSES.md), copied into every authored Project as a
`license` handoff. No local upstream licence file is shipped.

Preview: `preview.mp4` — 1920×1080, 24 fps, 12 s, silent.

Viscraft-owned contributions and previews use Apache-2.0. Upstream code and
third-party materials retain their notices. See [licences](LICENSES.md) for the
complete texts and scope; this does not set the licence of your whole new work.
