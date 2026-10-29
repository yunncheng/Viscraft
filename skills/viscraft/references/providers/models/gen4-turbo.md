# gen4_turbo — Runway image-to-video

Use this after choosing `model: 'gen4_turbo'` for a shot. This page is the
model's own guidance and limits; the Runway Endpoint, the `runway-v1` transport,
credentials, submission and recovery live in the
[Runway service](../services/runway.md). Shared direction remains in
[Creative method](../../craft/creative-method.md#direct-generated-images-and-passages).

`gen4_turbo` is a second packaged model on the same Runway service as
[gen4.5](gen45.md); it is selected with `gen4TurboExtension()`.

## Input mode

`gen4_turbo` is **image-to-video only**: `mode: 'first-last-frame'` with exactly
one image reference whose role is `first-frame`. Text-only, `reference` and
last-frame requests are refused by the definition, so there is no text-to-video
or multi-reference path on this model. The image sets the opening state; it is
not pose, camera or exact-motion control.

## Parameters and limits

`parameters` is strict; unknown fields are rejected rather than dropped. The
packaged definition accepts:

| Field | Accepted values |
| --- | --- |
| `durationSeconds` | optional number with **no stated range** — supply it to send `duration`, omit it and the field is not sent. Do not assume gen4.5's `2..10` bound. |
| `ratio` | `1280:720`, `720:1280`, `1104:832`, `832:1104`, `960:960`, `1584:672` |
| `contentModeration` | `{ publicFigureThreshold: 'auto' \| 'low' }` |

Runway's `ratio` strings ARE its generation resolutions, so the Source's raster
`size` must **equal** `parameters.ratio`. `durationSeconds` is the
generation-request length and `requestedFrames / fps` the expected take length; a
request shorter than the expected take is refused before submission. The prompt is
1–1000 UTF-16 units; `seed` is an optional uint32 (`0..4294967295`). `steps` and
`flowShift` are rejected. Unlike gen4.5, this definition does **not** accept the
`outputFormat`/`proresProfile` parameters.

```js
// The `runway` Endpoint comes from the user's setup (../setup.md). A Source with
// canonical model 'gen4_turbo' auto-selects this definition, so the run's options
// module only needs the authorization; injecting the extension is optional.
import { gen4TurboExtension } from '<installed-runtime>';
export default { providers: { videoApi: { runway: {
  // Optional: auto-selected for a Source with canonical model 'gen4_turbo'.
  extension: gen4TurboExtension(),
  authorization: { submit: false, uploadAssets: [] }
} } } };
```

The Source is the same `kind: 'provider', output: 'picture', endpoint: 'runway',
model: 'gen4_turbo'` with one `first-frame` image reference.

## Evidence

These constraints are what this packaged definition enforces — mapped `promptImage`,
parameters, request identity and recovery. They do not establish what the model
renders: a real Runway generation remains conditional on service access and
explicit user authorization, and the vendor's documentation for the exact
`gen4_turbo` version is the source for anything beyond these limits.

`requestedFrames` is a production need; the model receives its native
`durationSeconds`/`ratio`, and the decoded Take's actual frames are authoritative.
The Shot target length, the requested generation length and the final Composition
output are distinct — Build probes the real media and normalizes it to the
Composition settings before editing.
