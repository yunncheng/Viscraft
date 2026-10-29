# Screen-anchor zoom fixture

[Fixture overview](../../README.md) · [Camera tests](../../../module-scale-reveal.e2e.ts)
· [Event-sync tests](../../../event-sync.e2e.ts)

## Coverage

Exercises exact screen anchoring during zoom, held endpoints, frame-scoped
sampling, bounds and multiple aspect ratios. Event-sync tests reuse the sampler
with authored event timing. This is a 2D camera transform, without accumulated
simulation state.

## Files

| File | Test role |
| --- | --- |
| [scale-reveal.mjs](scale-reveal.mjs) | `createScaleReveal`, projection and bounds helpers |
| [scale-scene.html](scale-scene.html) | Canvas entry with grid and anchor subjects |
| [create.mjs](create.mjs) | Single-Source Project and declared resources |

## Maintenance

The tested projection is:

```text
scale = fitScale(worldFrame, viewport, fit) * zoom
centerWorld = worldAnchor - (anchorScreen - 0.5) * viewport / scale
```

Zoom interpolates in log space. Held endpoints must return the exact authored
`from`/`to` values. Across landscape and portrait viewports, projecting
`worldAnchor` must equal `anchorScreen * viewport`, except when bounds clamp the
resolved centre; then the sample reports `clamped`.

- `at(frame, viewport)` is independent of sampling order and wall time.
- Keep the camera scope `params.frames` equal to the Source's authored length.
- Validate positive zoom/dimensions, screen fractions and hold lengths before
  capture. `holdIn + holdOut` cannot exceed `frames - 1`.
- Keep `scale-reveal.mjs` in Source `resources` and the root
  [THIRD_PARTY_NOTICES.md](../../../../THIRD_PARTY_NOTICES.md) in the licence handoff.
- Motion diagnostics on an authored sample describe declared positions; a pinned
  anchor alone cannot test whether a different moving subject leaves the frame.

Recipe options include `width`, `height`, `fps`, `sampleRate`, `channels`,
`frames`, `seed`, `title`, `look` and `params`; `normalizeOptions` owns validation.
Module parameters and helper signatures are documented beside their implementation.
Update consuming assertions when intentionally changing units or projection rules.
