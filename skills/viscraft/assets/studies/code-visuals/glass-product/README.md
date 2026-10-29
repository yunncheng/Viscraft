# glass-product — a specific dark-studio glass material and lighting reference

For visual intent and adaptation, start with the [style reference](STYLE.md).
This page owns usage, parameters and the editable creation entry; the module
bytes live in this directory and are declared by the recipe.

A self-contained CodeScene **material / lighting / camera** reference: a
fictional lens-glass earbud pair in a pebble glass cradle case, shot in a dark
studio on a mirror floor. It is one particular study of glass/metal response and
studio coverage, not a general product-photography capability or a quality
benchmark. It draws a real `THREE.WebGLRenderer` scene — clear + frosted glass,
satin metal, a graphite deck, a light-guide that pulses from inside, and strip
lighting that sweeps across the glass — and stages five beats from the frame
clock alone: a material/lighting **reveal**, an **opening**, a **close detail
push**, an **exploded → snapped-together assembly**, and a glowing **hero**.

> **Honest scope.** This is a *stylized* product-photography Look. It is **not**
> a real product, **not** a brand, and **not** photoreal; the optics are not
> physically accurate. Deterministic rendering and a non-blank, moving image do
> not mean the picture meets the work's goal; inspect the actual output.

The Look is adapted from LemoLab's `lemo-opuscar` glass-product demo (MIT,
commit `e3cb16f63768c68693ff0e15171d6e755457cc32`); the mechanism is kept, the
story, name, brand and timings are **not**. See **Licence** below.

## The mechanism

1. **Product.** `buildBud()` / `buildCase()` lathe a lens-glass bud (dome →
   light-guide spirals → light ring → driver → titanium belt → magnet → pcb →
   battery → frosted shell → silicone tip) and a pebble case (frosted glass
   base, graphite deck with two plated cradles, a transparent lid on a hinge,
   and a charging light edge). Materials are `MeshPhysicalMaterial` glass
   (`transmission`, `ior`, `dispersion`, `attenuation`) and satin metal.
2. **Light guide.** A dark polished acrylic material whose emissive is driven by
   `onBeforeCompile` — eight uniform "comet" pulses flow along `uv.x`
   (narrow head, exponential tail, blue → violet with age, white-hot core). This
   is the "light inside the glass" idea made visible.
3. **Studio.** A strip-light scene is baked into the environment map
   (`PMREMGenerator.fromScene`) **every frame**, so the lights really move: two
   tall side strips, a horizon strip, a top soft-box, a moving **sweep** strip
   and a coloured accent card driven by the pulse. A dark radial **sweep
   background** and a **mirror floor** (`Reflector`, blurred 8-tap reflection +
   radial fade) seat the object in the dark.
4. **Beats.** `stage(t, duration)` is a pure function of time: it sets the
   camera, the lid angle, the case glow, the explode amount and the pulses. The
   exploded beat spreads the parts along a local axis with a deterministic tilt
   per part, hovers, then **snaps together** and lights the guide up in the same
   camera position.
5. **Post.** `EffectComposer` → a beauty pass → `UnrealBloomPass` → a vignette
   `ShaderPass` → `OutputPass` (Neutral tone mapping, exposure). Glowing glass
   edges bloom; a soft vignette closes the frame.

## Parameters

| Param | Meaning | Default |
| --- | --- | --- |
| `duration` | Total Look length in seconds (`create.mjs` sets `frames / fps`) | `4` |
| `product` | Metadata label only; not drawn in the rendered scene | `'LUMEN'` |
| `accentA` / `accentB` | Light-guide pulse colours (ice blue → violet) | `#62dcff` / `#a98bff` |
| `bloom` | `UnrealBloomPass` strength | `0.28` |
| `exposure` | Tone-mapping exposure | `1.1` |
| `orbit` | Camera-orbit multiplier | `1` |
| `explode` | Exploded-beat spread multiplier (`0` keeps it whole) | `1` |
| `pulse` | Light-guide pulse intensity (`0` = lights off) | `1` |
| `seed` | Source `seed` (threaded in; the beats are deterministic without it) | (source seed) |

Beats are **fractions** of `duration` (`BEATS`): `reveal 0–0.22`, `open
0.22–0.44`, `macro 0.44–0.64`, `explode 0.64–0.88`, `hero 0.88–1.0`. With a
very short piece may not sample every beat: for example, six frames do not
reach the final hero interval. Use enough frames to inspect the full sequence.

## Contract and time ownership

- The page exposes `window.viscraft = { ready, render }`. `ready()` builds the
  renderer/scene/composer once (and awaits the engine + addons). `render(ctx)`
  draws **one** frame for `ctx.frame` into a `WebGLRenderer` sized to
  `ctx.width × ctx.height`.
- `render` is a **pure function** of its arguments (plus the `ready`-built
  state): it derives everything from `ctx.frame / ctx.fps` and re-stages the
  scene from a fixed starting pose every call, so frame N is independent of the
  sampling order. There is **no** `requestAnimationFrame`, no wall clock, no
  `Date.now`, no unseeded randomness, no network.
- The environment map is re-baked from a fixed strip scene and the mirror is
  updated once per frame — both deterministic.

## The vendored three.js closure

The Look imports the bare specifier `three` plus a pinned addon set. This
reference's `three-files.mjs` owns the list: two build files, their `LICENSE`
and twelve addons, each with its destination and expected sha256. The bytes come
from the installed `three@0.186.1` (MIT), or from an explicit `options.three`
donor directory, and `authorProject` copies them **byte-for-byte**, verifies
every pin before writing, and registers each copy as a `code` Asset. Three's own sources are **not**
modified; the addons' `three` imports resolve through an inline import map on the
page, and their relative imports resolve inside `vendor/addons/`. Nothing here
is resolved through a Runtime catalogue or a style name.

```
vendor/three.module.js                                     (core build)
vendor/three.core.js                                       (core, imported by the above)
vendor/LICENSE                                             (three.js MIT)
vendor/addons/objects/Reflector.js                         (mirror floor)
vendor/addons/lights/RectAreaLightUniformsLib.js           (RectAreaLight LTC init)
vendor/addons/lights/RectAreaLightTexturesLib.js           (LTC data)
vendor/addons/postprocessing/EffectComposer.js             (+ ./ShaderPass.js, ./MaskPass.js, ../shaders/CopyShader.js)
vendor/addons/postprocessing/Pass.js
vendor/addons/postprocessing/ShaderPass.js
vendor/addons/postprocessing/MaskPass.js
vendor/addons/postprocessing/UnrealBloomPass.js            (+ ../shaders/CopyShader.js, ../shaders/LuminosityHighPassShader.js)
vendor/addons/postprocessing/OutputPass.js                 (+ ../shaders/OutputShader.js)
vendor/addons/shaders/CopyShader.js
vendor/addons/shaders/LuminosityHighPassShader.js
vendor/addons/shaders/OutputShader.js
```

The set is exactly the closure the scene imports (direct + transitive). The two
build files and their `LICENSE` are the pinned `three@0.186.1` bytes.

**Not adopted** (dropped from the upstream demo, all off the critical look):
per-frame depth-of-field and the custom caustics/sound-wave floor shader (a
second full-screen pipeline and a heavy 12-tap shader); `GTAOPass` (the upstream
demo ran with AO off); the 2-D subtitle/title/end-card overlay and the score /
voice / foley pipeline. The studio look reads without them.

## Licence

- **This module** is `MIT`, redistributable, `adapted from lemo-opuscar
  styles/glass-product/demo/{product,studio,story,main}.js@e3cb16f6… (LemoLab),
  MIT` — recorded on the module `code` Assets.
- **Vendored three.js** files carry three.js's own `MIT` rights (unmodified).
- **Viscraft original work** — the scene composition, staging, story beats and
  recipe are Apache-2.0, `Copyright (c) 2026 The Viscraft Authors`, recorded on the
  `code` Assets. The adapted Lemo MIT text and the LTC notice reach each Project
  through the Runtime's `THIRD_PARTY_NOTICES.md`.
- The full grants and texts ship as [`LICENSES.md`](LICENSES.md), copied into
  every authored Project as a `license` handoff beside the Runtime notice.

## Usage

Author a Project with the recipe, then build it with the separate command:

```bash
<viscraft> author <skill-dir>/assets/studies/code-visuals/glass-product/create.mjs ./my-glass-product \
  --options glass-options.json
<viscraft> build ./my-glass-product
```

`options.json` accepts `width`, `height`, `frames` (positive integers; width and
height even; default 1920×1080 and 96 frames) and an optional `three` directory.
By default the pinned `three@0.186.1` distribution is resolved from the **running
Runtime**; `three` is the explicit donor override and is checked against the same
pins. There is no fallback to files shipped with the Skill.

The recipe declares `glass-product.mjs` and `glass-product-scene.html` from this
directory, plus the reference's own three.js closure and its stable destinations
and Asset ids; `authorProject` copies the bytes, writes the scene copy and derives
their hashes. The recipe authors one `browser` **picture** Source (`lumen-studio`)
that declares the module and the closure in `resources` and its Look in `params`.

Preview: `preview.mp4` — 1920×1080, 24 fps, 4 s, silent.

Viscraft-owned contributions and previews use Apache-2.0. Upstream code and
third-party materials retain their notices. See [licences](LICENSES.md) for the
complete texts and scope; this does not set the licence of your whole new work.
