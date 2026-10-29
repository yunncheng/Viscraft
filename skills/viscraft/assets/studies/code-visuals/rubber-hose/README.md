# rubber-hose — object actors, a real hand-off and a film gate

For the visual grammar and how to adapt it, read [STYLE.md](STYLE.md). This
page owns the executable contract, the two beats, the parameters and the
limits. The implementation sits beside this page and is declared by
`create.mjs`.

Two complete 8-second rubber-hose acting beats, drawn in code with a native 1920×1080 default:

| Source | Beat |
| --- | --- |
| `spoon-stir` | A diner mug and a sugar cube pass a spoon across the counter, hand to glove. The mug dips the spoon into its own coffee, stirs two circles, lifts it and tastes; the eyes go wide, the body stretches, and the steam becomes a heart while both settle and hold. |
| `stair-clock` | The same sugar cube climbs a staircase of plates, one plate every two beats, squashing on the launch and pressing each plate as it lands. On the top plate it looks up; the alarm clock wakes, rings, and the cube covers its head, then grins. |

The Look is the mechanism, not a filter on top of generic shapes:

- **Rubber-hose anatomy.** Limbs are equal-width tubes with one smooth bend and
  round caps; gloves are palm + three fat fingers + thumb with a flared cuff;
  shoes are big black ovals; a box-shaped actor is a real projected 3-D box with
  the pie-eye face mapped onto its front face.
- **Screen-space ink.** Every path is transformed to the output first and
  stroked afterwards, so the outline weight does not change with zoom; the
  film-gate camera push is compensated by the inverse zoom before drawing.
  Three boil drawings cycle at 12 Hz; the line wobbles by ±`boilAmp` output
  pixels.
- **Twos over ones.** Characters and the three-drawing boil are sampled at
  12 Hz from the real capture clock (two 24 fps frames per drawing at the
  authored rate); the camera push and the film gate update on every frame. This
  is a real separation of clocks, not a whole-frame stutter, and it survives a
  different output fps.
- **Flat fill, one hard shadow band, outline last.** No gradients on the
  characters, no rendered shading.
- **A 4:3 film gate.** The 1440x1080 gate sits inside a 1920x1080 stage with
  rounded corners, gate weave, flicker, drifting scratches, dust, a rare hair,
  vignette and a blurred/contrasted composite. The black pillarbox remains.
- **Everything breathes on the beat.** Body squash/stretch is sampled on twos;
  the hanging ladle swings; the clock and plates take the same phase.

## Parameters

The recipe accepts these options. `bpm`, `boilAmp`, `inkWeight`, `pushIn` and
`damage` are real `params` fields on each Source and are consumed by the
renderer; `width`/`height` set the composition output, `frames` sets the Source
frame count and `seed` is the Source seed (background grain and film-damage
phase).

| Param | Meaning | Default |
| --- | --- | --- |
| `width`, `height` | Output size in pixels (even); the 4:3 gate is preserved and the stage is letterboxed | `1920`, `1080` |
| `frames` | Frames per Source at 24 fps | `192` (8 s) |
| `seed` | Seed for the background paper grain and the film-damage phase | `8123` |
| `bpm` | Beat grid for the breathing, prop reactions and step timing | `120` |
| `boilAmp` | Line-boil amplitude in **output** pixels | `1.2` |
| `inkWeight` | Ink weight in design pixels (6 → 3 px at 960x540) | `6` |
| `pushIn` | Camera push-in over the shot, 0..0.12 | `0.035` |
| `damage` | Film-damage strength, 0..2; `0` keeps only gate, blur, contrast and vignette | `1` |

Invalid values fail loudly (`normalizeParams`). The `variant` field is set per
Source by the recipe and must be `spoon-stir` or `stair-clock`. The Source also
carries `duration` (derived as `frames / 24`), which is not a creative option
but the real length the renderer maps onto the 192-design-frame action.

The two timelines are explicit, in design frames (24 per second, 192 total),
in `rubber-hose.mjs` (`SPOON_KEYS`, and the `f >= …` branches of
`sceneSpoonStir` / `sceneStairClock`). `duration` in the Source params maps the
real capture clock onto that design timeline; the pose clock is the 12 Hz
sample of real seconds, so other fps values keep the true twos. The spoon grip
is a keyframed point; the stir runs two exact circles at 86..112 and eases back
onto the key at both ends, and both the cube and the mug aim their glove *palm*
at their grip (the wrist is pulled back through the live body transform). The
cube grips 22 px further along the handle so the two gloves read as two hands.
While the spoon is in the cup its handle is drawn behind the mug front wall and
only the bowl's intersection with the real coffee ellipse (carried through the
mug's squash/stretch/lean) is re-exposed in front of the coffee; the rim and
wall mask the rest. During the hand-off and the taste the whole spoon is in
front. Changing a key moves the hand, the arm hose and the spoon together.

## Contract and resources

- **Entry.** `rubber-hose-scene.html` sets `window.viscraft = { render(ctx) }`.
  There is no `ready()`; the scene is 2-D canvas only. `render` is called once
  per frame with `{ frame, time, fps, width, height, seed, params, bindings }`.
  The Source `params` carry `duration` (the authored seconds); the renderer maps
  real time onto the fixed 192-design-frame action, so a shorter or longer
  capture still reaches the taste and the final hold.
- **Pure frame function.** The scene is rebuilt from the frame index, the params
  and the seed on every call. There is no `Math.random`, `Date.now`,
  `requestAnimationFrame` or wall clock. Rendering frame N twice produces the
  same picture.
- **Resources.** The entry imports `./rubber-hose.mjs`, which imports
  `./rubber-hose-toon.mjs` and `./rubber-hose-actors.mjs`. All three are declared in each Source's
  `resources`, so they are frozen and hashed into the capture. A missing
  resource fails the capture loudly.
- **No network, no fonts, no audio.** No CDN, no text, no voice, no music and no
  sample. The film is silent as delivered; `composition.audio` is empty.

## Author and build

```bash
<viscraft> author <skill-dir>/assets/studies/code-visuals/rubber-hose/create.mjs \
  ./my-rubber-hose --options rubber-hose-options.json
<viscraft> build ./my-rubber-hose
```

`options.json` is optional; any subset of the table above is accepted. The
Project contains two Sources placed back to back: `spoon-stir` at 0..191 and
`stair-clock` at 192..383. Authoring copies the four code files and the two
licence files.

## Scope and limits

Demonstrated: real hand-to-spoon contact along an interpolated path (no
teleport), two distinct content variants with different props, spaces and
actions, constant screen-space ink at the captured size, a 12 fps three-drawing
boil under a 24 fps camera and gate, breathing props, plate-press landings and a
clock reaction.

Not demonstrated: a finished film, sound, titles, dialogue, or aesthetic
approval. The reference is a compact acting-mechanism study, not a
franchise-style episode.

## Adapting upstream — what was and was not ported

The engine and actor kit are adapted from the MIT-licensed `lemo-opuscar`
rubber-hose demo (`toon.js`, `chars.js`, `film.js`, `cast.js`, `bg.js` and four
`core/lib.js` helpers, commit `e3cb16f6`, LemoLab). The two beats, the spoon
rig, the plate-stair climb, the clock reaction and the camera push are original
to Viscraft. `LICENSES.md` records the exact files; `LICENSE-LemoLab-MIT.txt`
carries the verbatim MIT text into every Project.

Not ported: `main.js`, `scenes.js`, `story.js`, `ui.js`, `sheet.js`,
`events.js`, the chasing-cast plot, the title/subtitle cards, the fonts
(Shrikhand, Limelight, IM Fell, Baloo), the TTS voice, the big-band score, the
foley sampler and the `core/` package. The upstream `window.render(t)` global
stage is replaced by a resize-aware `window.viscraft.render(ctx)` and local
modules.

Preview: `preview.mp4` — 1920×1080, 24 fps, 16 s, silent.

Viscraft-owned contributions and previews use Apache-2.0. Upstream code and
third-party materials retain their notices. See [licences](LICENSES.md) for the
complete texts and scope; this does not set the licence of your whole new work.
