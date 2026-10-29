# gen4.5 — Runway text-to-video and first-frame direction

Use this after choosing `model: 'gen4.5'` for a shot. This page is the model's own
creative guidance and limits. The Runway Endpoint, the `runway-v1` transport,
credentials, submission and recovery live in the
[Runway service](../services/runway.md). Shared direction remains in
[Creative method](../../craft/creative-method.md#direct-generated-images-and-passages).

`gen4.5` is one of the two packaged models of the [Runway service](../services/runway.md);
`gen4TurboExtension()` selects the separate [`gen4_turbo`](gen4-turbo.md) model.

## Input modes

| Intent | Viscraft request | Actual condition |
| --- | --- | --- |
| Text only | `mode: 'text'`, no references; `ratio` is `1280:720` or `720:1280` | Prompt establishes the complete starting scene, action and camera. |
| First-frame image | `mode: 'first-last-frame'`, exactly one image reference with role `first-frame`; any of the six ratios | The image sets the shot's opening state — it is not pose, camera or exact-motion control. |

There is no multi-reference, tail-frame, video-reference or generative-editing
mode on this model: a `mode: 'reference'` request is refused. Do not carry H3 or
Seedance reference syntax into a gen4.5 prompt.

## Parameters and limits

`parameters` is strict; unknown fields are rejected rather than dropped. The
packaged definition accepts:

| Field | Accepted values |
| --- | --- |
| `durationSeconds` | integer `2..10` (required) |
| `ratio` | `1280:720`, `720:1280` for text-to-video; image-to-video additionally accepts `1104:832`, `960:960`, `832:1104`, `1584:672` |
| `outputFormat` | `mp4` (default) or `prores` |
| `proresProfile` | valid only when `outputFormat` is `prores`: `422`, `4444`, `422 Proxy`, `422 LT`, `422 HQ`, `4444 XQ` |
| `contentModeration` | `{ publicFigureThreshold: 'auto' \| 'low' }` |

Runway's `ratio` strings ARE its generation resolutions (`1280:720` means the
1280x720 output), so the Source's raster `size` must **equal** `parameters.ratio`
— a differing canvas would be silently discarded by the vendor. `durationSeconds`
is the generation-request length and `requestedFrames / fps` the expected take
length; a request shorter than the expected take is refused before submission.
The prompt is 1–1000 UTF-16 units; `seed` is an
optional uint32 (`0..4294967295`). `steps` and `flowShift` are rejected — they
are not gen4.5 fields. Sequence/EXR *master* formats (for example `png_sequence`,
`hdr_exr_*`) are deliberately not accepted: the Take is normalized to the
Composition codec, so they would add cost without reaching the edit.

These are the implemented request constraints, not account entitlement or price
guarantees. The generated Take's decoded length is separate from the Shot target
and is probed and normalized to the Composition settings before editing.

## Authoring the prompt

Write one 1–1000-unit `Source.prompt` in the order the shot develops. State the
initial state, the physical action and the camera path, and keep subject motion
distinct from camera motion — a camera moving around a subject differs from the
subject turning. For a first-frame request, describe how the supplied image's
state develops; do not describe an unconnected scene.

```js
{
  id: 'candidate_a', kind: 'provider', output: 'picture', endpoint: 'runway', model: 'gen4.5',
  prompt: 'An original vehicle crests a mountain road at first light; the camera tracks forward and settles behind it.',
  mode: 'text', references: [],
  requestedFrames: 96, size: '1280:720', fps: 24, attempt: 'original-attempt-a',
  parameters: { durationSeconds: 4, ratio: '1280:720' }, seed: 7
}
```

The host agent authors the final prompt; Runtime transmits it without a creative
rewrite. Keep the original accepted Take while testing a changed request under a
new authorized attempt.

## Evidence

These constraints are what this packaged definition enforces and validates before
any request; the vendor's own documentation for the exact `gen4.5` version remains
the source for anything beyond them. Review the actual Take with
[Review and repair](../../craft/review-repair.md): a pleasant first frame does not
establish smooth motion or a coherent cut, and only a returned Take supports a
claim about generation.
