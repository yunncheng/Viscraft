# Style — indexed pixel art

## Intent

A small, legible pixel world where colour is data, not a gradient. The screen is
a 320x180 index buffer presented through a lookup table; every visible mark is
an index. Characters are stepped, hand-placed silhouettes with a clear ground
contact; light is an index ramp and a dither pattern, never a soft blend.

## Rules of the look

- **Index first.** Design in palette indices. A gradient is a Bayer dither
  between two or three indices; a fade is a different lookup table. Never use
  alpha, blur, glow filters or resampling to fake depth.
- **320x180 logical frame.** Compose inside it. Present at the largest integer
  scale that fits the real canvas; centre with a black letterbox. Never
  non-integer-scale pixel art.
- **Transparent index 255.** Sprites and prop cut-outs keep 255 as transparent.
- **Protected colour is story.** Only the scarf and the crystal escape the faded
  table. If everything is protected, nothing is. Do not apply the protection to
  UI, lamps or the ground.
- **The feet are the anchor.** The sprite's origin is `(24,44)`; place it at
  `(x - 24, groundY - 44)`. A pose may change height, but the ground contact must
  not. `GROUND` is the actor's standing line; the drawn ground plane and shrine
  platform are separate fixed bands, so move the actor's blocking without
  implying the whole ground moved.
- **Hand-placed heads, rigged bodies.** The head is ASCII pixels; the limbs are
  capsule rig pieces with three tones from an upper-left key, a per-part inner
  line and a one-pixel ink outline. Do not redraw a whole frame per pose.
- **Stepped performance.** Walk and scarf flutter step at 8 fps; poses blend by
  numeric interpolation between discrete authored keys. At 24 fps output this
  produces deliberate holds, not smooth 60 fps motion.
- **Event, then hold.** Prepare → act → response → held result. The result must
  live inside the authored frames; do not append an unrendered tail.
- **The response has a source.** The crystal's beam originates at the raised
  staff tip; the lamp light originates at the two lamps. A colour flood without a
  visible source is decoration, not an event.
- **Caption or no caption.** The bitmap font is a bounded local set of 80
  glyphs, each one ASCII; it is not the complete upstream font and not a claim
  of full ASCII coverage. Do not imply CJK support, do not fall back to a system
  font and do not use `?` to stand in for unsupported text.

## Palette

ENDESGA 32 as the master colour list (credited to ENDESGA, lospec), plus seven
protected duplicates:

- `#e43b44 #a22633 #f6757a` — scarf red / dark / highlight
- `#2ce8f5 #0099db #ffffff #124e89` — crystal cyan / blue / white / deep

The faded table maps every unprotected index by luminance into a seven-step
blue-grey ramp. The scene is readable through it; the protected objects keep
their colour as the thread through the shot.

## Sprite construction

- 48x48 canvas, feet at `(24,44)`, head placed as an ASCII grid.
- Materials are ramps: `[line, dark, mid, light]`; the far limb is biased one
  tone darker.
- Global one-pixel ink outline after all parts are stamped; a part that meets a
  different part draws the material's line tone.
- Wren: long scarf, dress hem, staff (behind the body, raised for the cast).
- Arlo: shoulder plate, sheathed sword at the hip, planted sword for the
  non-combat guardian stance.
- Scarf tails: two chains, three-frame stepping cycle, one pass behind and one
  in front of the body.

## Motion

- Walk: four keys at 8 fps; the body position eases to the mark and settles.
- Kneel/cast: numeric blends, then a hold. The staff is raised with the front
  hand; the beam starts at its tip.
- Guardian: stand, plant the sword (tip on the ground), head down, then head up
  as the lamps ignite. No attack, recoil or hit state.
- Response: `response` 0→1 over a declared window; radius and dither edge follow
  it. The readout is visible in the picture, not only in a label.

## Avoid

- Bilinear/bicubic upscaling, fractional positions that shimmer, or a fixed
  x6-only presenter.
- RPG UI frames, dialogue boxes, portraits, menus, save points or combat as the
  default reading of a 320x180 scene.
- Reusing upstream story names, music, voices, sampled sound, text boxes or the
  whole-film module graph.
- A caption that is unsupported by the actual glyph set.
- Treating "indexed" as a filter over a photograph.
