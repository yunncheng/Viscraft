# Three.js parameter and rebuild fixture

[Fixture overview](../../README.md) · [Consuming test](../../../case-glass-study.e2e.ts)

## Coverage

Exercises the real browser/Three.js path with a parameterized product module:
verbatim dependency copying, visible changes from authored parameters, selective
Source rebuilding and reuse of unchanged audio operations.

`study_detail` and `study_hero` share an entry but have independent `params.study`.
The test changes the hero case radius and checks that the detail Take and its bytes
are reused while the hero changes. Numerical image thresholds belong to the test,
not a retained measurement report in this README.

## Files and dependencies

| File | Test role |
| --- | --- |
| [create.mjs](create.mjs) | Declares two Sources, their code, audio and dependencies |
| [glass-study.mjs](glass-study.mjs) | Product variant, module-time mapping and exposure ramp |
| [glass-study-scene.html](glass-study-scene.html) | Browser entry and Three.js import map |

The fixture copies the current
[glass-product module and pinned dependency closure](../../../../skills/viscraft/assets/studies/code-visuals/glass-product/three-files.mjs).
It does not maintain another module copy. Three.js resolves from the running
Runtime by default, or an explicit `three` donor checked against the same pins.

## Maintenance

- Apply `CASE`/`ACCENT` configuration before `createLook()`. The module reads its
  geometry/material configuration during construction; tests stage scene and base
  module together so they share one instance.
- The detail maps normalized module time 0.645–0.877 into the `explode` beat with
  `explode: 0`; the hero maps 0.880–0.999 into `hero`. The detail spans ignition.
  Preserve these relationships when updating the module's beat map.
- Module duration is four seconds; `study.duration` is the Source's own duration.
  Keep those clocks distinct. Base depth remains 15 to retain floor contact.
- The procedural two-tone bed exercises mixing and reuse; no listening or optical
  realism assessment is part of these assertions.

Options are `width`, `height`, `frames` and optional `three`. Defaults are 640×360,
24 fps and 24 frames per shot (48 total). Tests render smaller inputs; ignition
can saturate at low resolution, so compare actual tested thresholds rather than
copying measurements between resolutions.

## Sources and licences

The fixture scene records MIT rights. Keep the glass-product module's provenance,
Three.js notices and root [THIRD_PARTY_NOTICES.md](../../../../THIRD_PARTY_NOTICES.md)
in the declared handoff. Dependency hashes and file membership are owned by the
shared dependency declaration.
