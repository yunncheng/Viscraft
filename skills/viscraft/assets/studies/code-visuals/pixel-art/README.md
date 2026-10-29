# Pixel art — indexed-colour character and action study

A low-level pixel-art reference: a 320x180 **indexed** framebuffer, a hand-placed
pixel character rig, a bitmap font and a palette response used as the
environment's answer to an action. Everything visible is drawn in code; there is
no sprite sheet, font file, image, sampled sound or network resource.

This is not an RPG and does not claim game capability. There is no World, no
real-time input, no collision, no menu, no save state, no dialogue system and no
audio. It is a short, deterministic, authored animation study that an author can
edit as ordinary code.

## Create

```bash
<viscraft> author <skill-dir>/assets/studies/code-visuals/pixel-art/create.mjs ./my-pixel-art [--options options.json]
<viscraft> build ./my-pixel-art
```

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `width` | `1920` | output canvas width, even, at least 320 |
| `height` | `1080` | output canvas height, even, at least 180 |
| `frames` | `144` | authored frames **per source** at 24 fps (6 s) |

The default 1920x1080 is exactly 320x180 x6. Other sizes are allowed: the
largest integer scale that fits is used and the remainder is a black letterbox
(e.g. 1366x768 shows 1280x720 at x4, 640x360 shows x2, 800x600 shows 640x360 at
x2). A canvas smaller than 320x180 is rejected with a clear error; non-integer
scaling is never performed.

`frames` is consumed by the scene through `params.frames` (the recipe writes it
to both `source.frames` and `source.params.frames`). Shorter sources are legal;
the beat fractions are resolved against the actual length.

## Project shape

- **Entry**: `pixel-art-scene.html`
- **Resources**: `pixel-art-scene.mjs`, `px.mjs`, `sprites.mjs`, `font.mjs`
- **Two browser picture Sources**, one entry and one resource closure:
  - `wren_offer` — `params.variant = "offer"`, caption `STILL SHRINE: RESTORED`
  - `arlo_guard` — `params.variant = "guard"`, caption `THE KEEPING: HELD`
- **Subject is derived from the variant** (`offer → wren`, `guard → arlo`); no
  redundant subject field is stored.
- **Composition**: silent (`audio: []`), 24 fps, both shots placed back to back.

`params` fields actually consumed: `variant`, `frames`, `caption`. Unknown
variants throw. The caption is validated against the font's real coverage;
unsupported characters throw instead of silently becoming `?`. Each Source also
carries a `seed` for provenance, but this fixed stage does not use it: the sky,
motes and action are deterministic and do not vary by seed.

## What the two shots do

**offer (Wren)** — walks in from the left, settles, kneels, then raises the staff
in a cast. From the cast, the shrine crystal answers: a dithered beam, ripple
rings, a growing halo and a colour flood that restores the full palette around
the crystal. The scarf and the crystal use **protected indices** and keep their
colour even while the surrounding world is shown through the faded table.

**guard (Arlo, non-combat)** — stands, plants his sword point on the ground with
both hands, lowers his head, then lifts it. The two shrine lamps ignite, warm
motes rise and a colour flood spreads from the lamps. There is no attack, swing,
hit or combat state.

Both shots end on a held result inside the authored frames. The response is
event-driven, not a whole-frame filter: it is a radius + ordered-dither edge
that reaches the decoded picture.

## Adopted from the reference

Upstream: `lemo-opuscar` at `e3cb16f63768c68693ff0e15171d6e755457cc32`
(LemoLab), `styles/pixel-rpg/demo/`.

- **`px.js`** — palette-index `Uint8Array` framebuffer with transparent value
  255, ENDESGA-32 + seven protected duplicates, index→ABGR lookup table, faded
  luminance ramp, 4x4 Bayer dither, the `FB` drawing primitives and
  `sprFromRows`.
- **`sprites.js`** — the 48x48 capsule rig, upper-left three-tone shading,
  per-part inner line, global ink outline, the hand-placed Wren/Arlo side/down
  heads, the `ox=24/oy=44` feet anchor, the scarf-tail 3-frame stepping flutter
  and the walk/kneel/cast poses.
- **`font.js`** — the variable-width bitmap glyph shapes (cap 7, x-height 5,
  descender 2, line height 10).

The adopted code was rewritten to ES modules, reduced to the used range and
changed where this study needs it. The exact modifications are recorded in the
Project's Asset `rights.modifications`.

### Kept from the reference mechanics

- Indexed colour, not RGB compositing. Gradients and response edges are ordered
  dither.
- The sprite anchor is the feet centre at `(24,44)`; the scene blits at
  `(x - 24, groundY - 44)`, so the ground contact is independent of the pose.
- `GROUND = 152` is the actor's **standing line** (feet, shadow and staff/beam
  origin), not the drawn ground plane (starts at y=126) or the fixed shrine
  platform (y=142). A `GROUND` edit is local actor blocking, not a whole-ground
  move.
- The scarf is drawn in **two passes**: a longer tail behind the sprite and a
  shorter tail in front of it. The neck wrap is part of the sprite.
- Walk steps at 8 fps; the scarf flutter steps at 8 fps; the rest of the action
  is evaluated per output frame with eased pose blends.
- Palette changes are lookup-table swaps. Fades are not alpha blends.

### Not adopted

- `main.js`, `scenes.js`, `props.js`, `ui.js`, `portraits.js`, `memscenes.js`,
  `memsprites.js`, `sheet.js`, `pixel.js`, `music/`, `voices/`, `mix.py` and the
  whole-film story, scene list, save-point UI, portraits, combat poses, voice,
  music and sampled sound.
- The upstream save crystal (procedural 3D, palette-quantised) and shrine props;
  the night shrine in this study is original and drawn with the local `FB`
  primitives.
- The other colour-depth tables (`nes`, `gb4`, `c16`, `c8`, `c4`, `c2`), mosaic
  transitions, the fixed x6-only presenter and the `?sheet` / `?frame` debug
  modes.

## Palette and credits

The master 32 colours are **ENDESGA 32 by ENDESGA**
(`lospec.com/palette-list/endesga-32`), used as a colour list, exactly as the
upstream `CREDITS` describes it. This study repeats that attribution and makes
**no separate licence claim** for the palette; the upstream `CREDITS` is the
source of that statement, not an independently cleared asset licence.

Seven duplicate indices are protected from every lookup table:

| Index | Role |
| --- | --- |
| 32 / 33 / 34 | scarf red / dark / highlight |
| 35 / 36 / 37 / 38 | crystal cyan / blue / white / deep |

## Font

The bitmap font is original to the upstream demo and is carried as glyph
programs, not as a font file. The local set is **80 glyphs, each one ASCII** —
letters, digits, space and the punctuation below. This is not the complete
upstream font (the upstream also carries symbols such as ▶/▼) and it is not a
claim of full ASCII coverage.

```
ABCDEFGHIJKLMNOPQRSTUVWXYZ
abcdefghijklmnopqrstuvwxyz
0123456789
.,!?'-:/()=+%" ;_&
```

and space. There is no CJK glyph, no system-font fallback and no external font
download. The scene rejects a caption containing an uncovered character with a
message listing the real coverage. Use English/ASCII captions or no caption at
all.

## Scope and limits

- Locked camera and a single stage; no camera move, parallax or transition.
- Two authored variants with one action each; the pose vocabulary is a subset
  (idle/breathe, walk x4, kneel, cast, plant, guard, guard-look).
- The beam/response is an authored timing curve, not a physical light or a
  particle simulation.
- The two "front/back" scarf tails are layered passes, not independently
  simulated cloth.
- No audio. The reference's voice/music/SFX are deliberately absent.
- No RPG, World, playable/recording, input, menu, dialogue, save or sheet export.
- The font's `?` glyph still exists as a font-level fallback, but the scene never
  uses it for an unsupported caption: it throws instead.

## Licence

- `LICENSE-LemoLab-MIT.txt` — the upstream MIT text, carried verbatim
  (`Copyright (c) 2026 LemoLab`) and into every created Project.
- The scene, shrine, choreography, guardian poses and response staging are
  original Viscraft work, Apache-2.0, `Copyright (c) 2026 The Viscraft Authors`; see
  `rights.mjs` for the exact adopted range.
- The full grants and texts ship as [`LICENSES.md`](LICENSES.md), copied into
  every authored Project as a `license` handoff beside the Runtime notice.

Preview: `preview.mp4` — 1920×1080, 24 fps, 12 s, silent.

Viscraft-owned contributions and previews use Apache-2.0. Upstream code and
third-party materials retain their notices. See [licences](LICENSES.md) for the
complete texts and scope; this does not set the licence of your whole new work.
