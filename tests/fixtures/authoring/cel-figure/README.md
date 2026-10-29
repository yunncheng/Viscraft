# Cel-layering fixture

[Fixture overview](../../README.md) · [Consuming test](../../../module-cel-figure.e2e.ts)

## Coverage

Exercises ordered rendering layers, deterministic browser capture, independent
pose/light clocks, aspect-ratio changes and missing-resource failures.
The two picture Sources, `figure-walk` and `vehicle-roll`, share one module and
use different subject parameters.

## Files

| File | Test role |
| --- | --- |
| [cel.mjs](cel.mjs) | Pure pose/mark helpers and Canvas renderer |
| [cel-scene.html](cel-scene.html) | Browser entry importing the module |
| [create.mjs](create.mjs) | Declares both Sources, resources and licence handoff |
| [Layering notes](STYLE.md) | Draw order and time invariants used by assertions |

## Maintenance

- Keep `CEL_LAYERS` ordered as `base`, `shadow`, `highlight`, `line`.
- Pose time is `floor(time * poseRate) / poseRate`; light motion uses actual
  frame time. Quantizing the entire frame would invalidate the separate-clock test.
- Static hatch marks depend on seed and mark index, not sampling order or wall time.
- Both Sources declare `cel.mjs` in `resources`; missing bytes must fail capture.
- The renderer resizes to the requested dimensions each call. Tests exercise both
  subjects in landscape and portrait and compare repeated/out-of-order samples.

Recipe options are `width`, `height` and `frames`, defaulting to 640×360 and
24 frames per Source; width/height must be positive even integers. Subject,
palette, pose cadence and lighting parameters live in the recipe and module.
Consult `normalizeParams` and the consuming assertions when changing them.

The recipe copies the local module/page and carries the root
[THIRD_PARTY_NOTICES.md](../../../../THIRD_PARTY_NOTICES.md) as a licence handoff.
