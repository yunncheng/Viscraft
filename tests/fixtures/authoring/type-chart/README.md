# Text/chart rendering fixture

[Fixture overview](../../README.md) · [Module tests](../../../module-type-chart.e2e.ts)

Also used by the [atlas composition fixture](../atlas-reveal/README.md).

## Coverage

Exercises text measurement and line breaking, chart geometry, staged reveals,
callout bounds, deterministic rendering, resource failure and portable licence
handoffs. The module computes geometry and draws Canvas output; its chart values
are fixed illustrative data.

## Files

| File | Test role |
| --- | --- |
| [type-chart.mjs](type-chart.mjs) | Text/chart helpers, parameter validation and renderer |
| [type-scene.html](type-scene.html) | Browser entry |
| [create.mjs](create.mjs) | Single `ledger` Source and declared dependencies |
| [rights.mjs](rights.mjs) | Provenance shared with atlas-reveal |

## Maintenance

- Text is tokenized per CJK glyph and per Latin word. Line breaking keeps closing
  punctuation off the start of a line; fitting must satisfy both width and count.
  Pure layout tests inject a measurement function, independently of installed fonts.
- Browser glyph coverage depends on the selected host font. This fixture bundles
  no font and fetches none. Do not treat passing layout math as CJK glyph validation.
- Chart values are preserved; progress changes geometry visibility. Keep scale
  inversion, tick placement and callout bounds assertions tied to authored values.
- Driver-mode glyph/line reveal must finish on the final authored frame, including
  short scopes. Repeated or out-of-order samples must render identical pixels.
- Keep `type-chart.mjs` in Source `resources`, and keep the root
  [THIRD_PARTY_NOTICES.md](../../../../THIRD_PARTY_NOTICES.md) in the licence handoff.

Recipe options are `width`, `height` and `frames`, defaulting to 640×360 and
24 frames; width/height are positive even integers. Module `normalizeParams`
defines the accepted text, font, chart, reveal and palette parameters; consult it
and the assertions together rather than maintaining another default-value table.

## Provenance and rights

Adapted from huashu-art-motion `scripts/engine/lib/{typo.js,chart.js,util.js}`
at `f178bd7754a71d6d399473af1501634548efa6cb` (alchaincyf, MIT).
Globals `TY`/`CH`/`U` and the `U.onStage` loop were converted to ESM with an
explicit stage. The copied code records MIT rights and required
Manim/ManimCommunity notices; preserve the full texts and `rights.mjs`.

The adopted file set excludes `diagram.js` (CC BY-NC-SA). Spring-based
`TY.slam`, `TY.keyword` and the spring/pulse callout were omitted; callout and
reveal geometry use local easing. Per-style drawing wrappers, `U.loadCmaps`,
`U.assertGlyphs` and `U.poly` were also omitted. The module performs no font I/O;
paths are drawn directly by the scene. These adaptation boundaries apply when
changing the module or updating its third-party notices.
