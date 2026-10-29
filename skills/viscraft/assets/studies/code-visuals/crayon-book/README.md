# crayon-book — a drawn picture-book page

A small, complete page action in wax crayon on toothy paper. A girl draws a star
beside her, colours it in with visible pressure, reaches as it lifts off the
page, and one ultramarine wash reveals a white-wax constellation that was on the
paper from the first frame. The page is rebuilt every frame: paper tooth, wax
adhesion, hatching, and watercolour resist are separate material passes, not a
filter over flat vector art.

This is a local visual reference, not a style engine or a finished film. The
girl and star are original; the mark/compositor mechanisms and the small wax
colour logic are adapted from LemoLab's MIT crayon-book demo. It carries no fonts, voices, music or upstream media. Local material sound
follows the visible mark growth; its authoring files stay with this page.

## Page action and beats

At the default 240 frames / 10 s / 24 fps:

| Fraction | Beat | What is on screen |
|---|---|---|
| 0.00–0.07 | Crayon raised | The girl stands on the paper with the crayon low, then lifts it |
| 0.06–0.30 | Draw the outline | One indigo stroke traces the star; the crayon tip follows the line |
| 0.32–0.58 | Colour it in | Yellow/orange zig-zag hatching fills the star; a second cross pass and two shade strokes |
| 0.60–0.68 | Reach | The crayon is put down; the arm extends and the mitten hand touches the star's lower edge |
| 0.68–0.80 | Lift | The star rises to the upper right, turns slightly and grows; a few spark strokes remain |
| 0.76–0.93 | Wash | A single ultramarine wash sweeps up the page with a soft, wavy front; wax resists it |
| 0.90–1.00 | Hold | The constellation is paper-white in the night sky; the girl still reaches |

`motif: "comet"` keeps the same page action and gives the drawn object a tail
that appears as it launches instead of the plain star. It is the meaningful
content variant: the subject and its final silhouette change, not just a colour
or seed.

## The look: how it is made

- **Pressure layers.** Every mark is drawn into a Canvas2D layer whose RGB is the
  crayon colour and whose alpha is pressure. The compositor deposits wax only
  where the paper tooth is higher than `1 − 1.22 × pressure`; light pressure is
  speckled, heavy pressure nearly solid and slightly darker.
- **Anchored tooth.** Three octaves of value noise plus a horizontal fibre term
  live in page coordinates, so the grain pans and zooms with the camera. A final
  emboss makes the tooth readable; wax fills it in a little.
- **Directional hatching.** `fill()` lays back-and-forth rows at a chosen angle,
  overshoots the outline, varies pressure per pass and adds an optional
  cross-hatch. The star and the girl's clothes use this; the girl's skin is
  denser so the post-wash blue does not show through.
- **Occlusion.** `part()` erases what is behind a part inside its outline before
  drawing, so the pinafore covers the legs and the hair covers the head edge.
- **Wax resist.** The white-wax constellation and the star are laid down before
  the wash (the constellation in the background group, the star after the wash
  so it stays saturated). The wash shader multiplies density by
  `1 − 0.93 × smoothstep(0.12, 0.55, wax)`, leaving paper-white points.
- **One wash.** Ultramarine `[0.12, 0.16, 0.44]`. The front is a wavy,
  soft-edged density ramp; pigment pools at the lip and granulates in the tooth.
  The girl, star and their fills are composited after the wash.

## Clocks

The page deliberately uses two rates:

- **12 fps boil.** `BOIL step = floor(time × 12)`; stroke jitter, wobble, hatch
  rows and character pose marks change on twos. The boil calms toward the end.
- **Continuous 24 fps camera and wash.** The camera is a smooth push-in over the
  whole page, then a pull-back for the wash; the wash front and the star lift are
  evaluated from the real `time`, so they do not step.

Do not quantise the whole clock to the boil. If a shot needs a different camera,
edit `cameraAt()`; if it needs a different acting cadence, change the 12 in
`boilStep`. `crayonClocks(time, duration)` exports `{ time, camera, boilStep }`
without touching the canvas; two calls one output frame apart show a changed
camera and, within a two-frame pair, the same boil step.

## Entry contract and files

`crayon-book-scene.html` exposes:

```js
window.viscraft = {
  ready() { /* waits for the WebGL2 compositor */ },
  render(ctx) { /* pure function of frame/time/fps/width/height/seed/params */ },
};
```

`render` rebuilds the page from scratch each call, resizes its layers to
`ctx.width × ctx.height`, and reads `ctx.params.duration`, `motif` and the seed.
There is no `reset()`: the result is a pure function of the inputs, not a
stateful simulation.

| File | Role |
|---|---|
| `crayon-book.mjs` | page, girl, star, constellation, action sampling and entry render |
| `action-facts.mjs` | shared action fractions and smooth mark-growth progress |
| `foley.mjs`, `crayon-foley.html` | material texture and the separate sound entry |
| `crayon-engine.mjs` | mark engine: ribbons, hatching, hand shapes, rig parts, local math |
| `crayon-gl.mjs` | WebGL2 paper/wax/watercolour/emboss compositor |
| `crayon-book-scene.html` | `window.viscraft` entry |
| `create.mjs` | recipe: Project, Source, params, options, rights/handoff |
| `rights.mjs` | one provenance declaration shared by recipe and study |
| `LICENSES.md`, `LICENSE-LemoLab-MIT.txt` | licences carried into every Project |

## Options

| Option | Default | Meaning |
|---|---|---|
| `width` | 1920 | output width, even |
| `height` | 1080 | output height, even |
| `frames` | 240 | authored length (10 s at 24 fps) |
| `seed` | 7321 | deterministic mark jitter and page variation |
| `motif` | `star` | `star` or `comet` |

The recipe authors a `browser` picture Source (`crayon_page`) with
`{ duration, motif, seed }` and a separate `browser` sound Source
(`page_material_sound`) with `{ duration }` in `params` plus `durationSamples`
(480,000 at 48 kHz for the default 10 s) and `sampleRate` on the Source. A
source audio clip places the material sound at sample zero on the `foley` bus.
The seven code Assets cover
the picture entry, drawing engine, compositor, page module, action facts,
Foley module and sound entry, each with actual MIT provenance.
Licences: `LICENSES.md` and `LICENSE-LemoLab-MIT.txt`.

## Author and build

```bash
<viscraft> author <skill-dir>/assets/studies/code-visuals/crayon-book/create.mjs ./my-crayon-book \
  --options crayon-options.json
<viscraft> build ./my-crayon-book
```

## What to change

- **Subject:** replace the star point set in `starShape()`; the draw/fill/reach
  guides derive from it. Keep it within arm's reach of the shoulder at the start.
- **Girl:** `GIRL`, `girlTorso()`, the hair/face block and the palette. Keep the
  two-bone arm chain lengths consistent with `ik2()`.
- **Page:** `GROUND_Y`, `CONSTELLATION` and `cameraAt()`. The constellation is
  white wax, so it only appears after the wash.
- **Material:** `crayon-gl.mjs` tooth scale/contrast, `uGain`, `uSoft` and the
  wash `resist/edge/gran`; `crayon-engine.mjs` line taper/streak and fill gap.
- **Length:** keep the beat fractions or retime them in `action-facts.mjs`.
  `duration` is derived from `frames / 24` in the recipe, and the sound Source's
  `durationSamples` is `round(duration * 48000)`; change both together with the
  picture frames.

## Dependencies and limits

- WebGL2 is required. `ready()` throws a clear error when the browser/headless
  session has no WebGL2 context; there is no Canvas2D fallback that would fake
  the material.
- No fonts, images, recordings or network. The page has no text, so there is no
  font-coverage claim.
- The upstream `text()`, film timeline, voices, music, world and page-turn/desk
  closure are not adopted. This is one page action, not a 52 s film.
- Offline capture does not need real-time playback; each frame is a pure
  evaluation and is captured in ascending order.
- The camera is a single authored move. It is not a general camera rig, and the
  girl is not a full rig: only the right arm, gaze and reach are articulated.
- The page shows the draw → fill → reach → wash sequence and the constellation;
  it does not author a page turn, and approval of the final artwork is the
  author's call.

## Material sound belongs to this page

`action-facts.mjs` owns the fractions for outline, colour, reach, lift, wash
and settle. The picture reads `pageActionAt`; `foley.mjs` uses the same action
windows and growth envelope for dry wax friction and wet-pigment texture.
`crayon-foley.html` exposes the ordinary sound contract. The recipe copies all
three files, registers their rights and places the sound Source on a `foley`
bus at sample zero. The picture placement remains `mute`: browser picture
capture has no embedded audio, and the authored sound is mixed separately.

Only outline, colour and wash produce material texture. The reach, lift and
final hold do not acquire invented footsteps, paper flaps, a room story or
background music. The synthesis is an illustrative material choice, not a
recording or a reconstruction of every visible hatch/contact. Judge its
naturalness by listening; change or replace it against the work.

Edit the page fractions in `action-facts.mjs` to change both media together.
Edit `foley.mjs` alone to change timbre: its separate resource closure lets the
picture Take be reused. Removing the sound Source and its audio clip is a
legitimate silent version, not a different required workflow.

Preview: `preview.mp4` — 1920×1080, 24 fps, 10 s, with its authored sound.

Viscraft-owned contributions and previews use Apache-2.0. Upstream code and
third-party materials retain their notices. See [licences](LICENSES.md) for the
complete texts and scope; this does not set the licence of your whole new work.
