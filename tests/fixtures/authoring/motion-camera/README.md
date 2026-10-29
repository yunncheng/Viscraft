# Motion/camera sampling fixture

[Fixture overview](../../README.md) · [Primary test](../../../module-motion-camera.e2e.ts)

Also consumed by the [contact fixture](../contact-study/README.md) and its
[picture/sound tests](../../../case-contact-study.e2e.ts).

## Coverage

Exercises pure easing/spring functions, camera transforms, exact screen aim,
frame-order independence, aspect-ratio changes, declared resources and browser
capture. The module returns camera samples; `motion-scene.html` draws them.

## Files

| File | Test role |
| --- | --- |
| [motion-camera.mjs](motion-camera.mjs) | Pure motion and camera helpers, `createCamera` sampler |
| [motion-scene.html](motion-scene.html) | Canvas entry and layout rendering |
| [create.mjs](create.mjs) | Single-Source Project and resource declaration |
| [rights.mjs](rights.mjs) | Shared provenance for this recipe and contact-study |

## Maintenance

- Camera samples use world-space `{ x, y, z, r }`; `z` is zoom. Keep
  `toScreen`/`toWorld` inverse transforms and log-space zoom interpolation.
- `aim.world` maps to `aim.screen` across output aspects. Bounds may clamp the
  centre and break that exact aim; report `clamped` in the sample.
- `at(frame, size)` has no accumulated state. Fixed frame/seed inputs must give
  the same values regardless of capture order. Seeded drift is separate from aim.
- Keep the Source frame count aligned with its `params.frames`, and declare
  `motion-camera.mjs` in `resources` so changed or missing bytes affect capture.
- Module keyframes use frame indices; scene `params.keys[].f` uses fractions
  converted to the Source's frame scope. Do not mix the two units.

Recipe options are `width`, `height` and `frames`, defaulting to 640×360 and
24 frames; width/height are positive even integers. The recipe owns layout,
track, aim and reveal parameters. Tests cover the math, actual capture,
determinism and missing-resource failure separately.

## Provenance and rights

Adapted from **huashu-art-motion** `scripts/engine/lib/{motion,camera,util}.js`
at commit `f178bd7754a71d6d399473af1501634548efa6cb` (author **alchaincyf**),
**MIT**. Changes: the `window.MO`/`window.CAM`/`window.U` globals and the
`U.onStage` stage loop were removed and converted to plain ESM; the fixed
1920×1080 stage was parameterised; timing and camera were composed into one pure
`createCamera` per-frame sampler.

The Manim-derived easing helpers (`smooth`, `smoothCE`, `thereAndBack`,
`rushInto`, `rushFrom`, `doubleSmooth`, `wiggle`, `lagged`) derive, via huashu
`motion.js`, from **Manim / ManimCommunity** (3Blue1Brown, **MIT**); both Manim
permission notices must be retained. See `THIRD_PARTY_NOTICES.md`.

Not carried over: any fonts, images, audio, upstream runtime or installer. The
camera's canvas-compositing motion blur (`CAM.motionBlur`) is **not** included —
the module exposes the pure `cameraVelocity` + `blurOffsets` and leaves the
drawing to the scene, keeping the module content-free.

The recipe carries the root [THIRD_PARTY_NOTICES.md](../../../../THIRD_PARTY_NOTICES.md)
as a licence handoff. Preserve it and the shared rights declaration.
