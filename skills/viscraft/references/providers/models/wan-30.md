# Wan 3.0 — first/last-frame image-to-video

Use this after choosing `model: 'alibaba/wan-3.0/image-to-video'`. This page is
the model's own guidance and limits. The fal Endpoint, the `fal-queue` transport,
credentials, submission and recovery live in the [fal service](../services/fal.md).
Shared direction remains in
[Creative method](../../craft/creative-method.md#direct-generated-images-and-passages).

Wan 3.0 is the packaged model on the fal queue service; the Source's canonical
name selects it, and `wan30FalExtension()` injects the same definition explicitly.

## Input mode

Wan 3.0 is **image-to-video only**: `mode: 'first-last-frame'` with a required
first-frame image and an optional last-frame image. There is no text-only or
multi-reference mode. The adapter maps `first-frame` to `start_image_url` and
`last-frame` to `end_image_url`; the first frame defines the opening state and the
optional last frame the ending state. Neither is pose, camera or exact-motion
control — describe the intended motion in the prompt.

## Parameters and limits

`parameters` is strict; unknown fields are rejected rather than dropped. The
vendor's published request schema is the source for these fields:
[fal OpenAPI for this endpoint](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=alibaba/wan-3.0/image-to-video).

| Field | Accepted values |
| --- | --- |
| `durationSeconds` | integer `2..30` |
| `resolution` | `480p`, `720p`, `1080p` |
| `ratio` | `16:9`, `4:3`, `1:1`, `3:4`, `9:16` (the API's `adaptive` is not offered) |
| `audio` | required boolean |

The Source's `size` is the author's real raster canvas (`WIDTH:HEIGHT`); `ratio`
is the model's **symbolic** aspect selector, so only the canvas **aspect** must
match `ratio` — the vendor derives the exact pixels from `resolution` + `ratio`.
Keep one consistent aspect (a `16:9` canvas for `ratio: '16:9'`) and never write a
symbolic ratio such as `16:9` into `size`. `durationSeconds` is the
generation-request length while `requestedFrames / fps` is the expected take
length; a request **shorter** than the expected take is refused before any
submission, and a longer request is the ordinary margin a cut later trims. The
prompt is 1–20000 characters; `seed` is an
optional int32 (`0..2147483647`). `steps` and `flowShift` are rejected. Every
request is sent with moderation on and prompt expansion/thinking off
(`enable_safety_checker: true`, `enable_prompt_expansion: false`,
`enable_thinking: false`); these flags are pinned by the adapter and are not
user-tunable.

```js
{
  id: 'fal_a', kind: 'provider', output: 'picture', endpoint: 'fal',
  model: 'alibaba/wan-3.0/image-to-video',
  prompt: 'A slow push-in on the subject; keep its colour and lighting', // 1–20000 characters
  mode: 'first-last-frame',
  references: [
    { asset: 'approved_hero', category: 'image', role: 'first-frame' }, // required = FIRST frame
    { asset: 'approved_tail', category: 'image', role: 'last-frame' },  // optional  = LAST frame
  ],
  requestedFrames: 120, size: '1920:1080', fps: 24, seed: 7, attempt: 'fal-attempt-a',
  parameters: { durationSeconds: 5, resolution: '1080p', ratio: '16:9', audio: true }
}
```

## Authoring the prompt

State what each supplied frame establishes, then describe how the passage moves
between them: subject action, camera movement and the sound the `audio` flag
requests. Keep subject motion distinct from camera motion, and describe a single
continuous action across the frame pair rather than a cut the model does not
perform.

## Evidence

This packaged definition and mapping fix the queue dispatch, the request body, the
authentication shape, recovery and the `{ video: { url } }` result; the table
above is what they enforce. None of that establishes what the model renders, and
the vendor's documentation for the exact Wan 3.0 version is the source for
anything beyond these limits. Only with a real account, key and explicit user
authorization does this run a billable generation; never claim a real generated
clip passed without a returned Take you inspected.

`requestedFrames`/`size` express production needs; the model receives its native
`durationSeconds`/`resolution`/`ratio`, and the decoded Take's actual frames and
audio are authoritative. The Shot target length, the requested generation length
and the final Composition output are distinct — Build probes the real media and
normalizes it to the Composition settings before editing.
