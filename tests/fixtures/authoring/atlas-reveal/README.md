# Atlas reveal fixture

[Fixture overview](../../README.md) · [Consuming test](../../../example-atlas-reveal.e2e.ts)

## Coverage

Exercises composition of two author modules in a browser frame, selective
rebuilding and portable export. `atlas_open` and `atlas_close` share a scene that
draws both a cel-watercolor plate and a type-chart panel on each frame.
The test checks non-blank advancing frames, reuse of the unchanged Source after
a parameter edit, and exported licence text.

## Files and dependencies

| File | Test role |
| --- | --- |
| [create.mjs](create.mjs) | Declares source files, Assets, two Sources and handoffs |
| [atlas-scene.mjs](atlas-scene.mjs) | Composes both modules in the same render |
| [atlas-scene.html](atlas-scene.html) | Browser entry exposing `window.viscraft.render` |

The recipe copies the current
[cel-watercolor module](../../../../skills/viscraft/assets/studies/code-visuals/cel-watercolor/cel-watercolor.mjs)
and [type-chart module](../type-chart/type-chart.mjs) through `authorProject`.
Keep both in the declared resource closure; placing them in separate shots would
stop exercising same-frame composition.

## Maintenance

Options are `width`, `height` and `frames`; width/height are positive even
integers. Defaults are 640×360, 24 fps and 24 frames per Source. The test chooses
its own small capture settings. Keep the two Source IDs and independently editable
parameters aligned with reuse assertions. The chart uses illustrative data and
Latin labels; its capture does not verify CJK glyph coverage.

## Sources and licences

Cel-watercolor derives from LemoLab (MIT); type-chart derives from
huashu-art-motion (MIT), with Manim/ManimCommunity notices. The scene records MIT
rights for its combined implementation. The recipe carries the root
[THIRD_PARTY_NOTICES.md](../../../../THIRD_PARTY_NOTICES.md) as a licence handoff.
Keep the original module notices and [type-chart rights](../type-chart/rights.mjs)
with the copied files.
