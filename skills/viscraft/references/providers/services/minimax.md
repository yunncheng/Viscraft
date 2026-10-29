# MiniMax official H3 video API

Use `protocol: 'minimax-video-v2'` for MiniMax's native hosted H3 API. This is
different from [vLLM-Omni serving](vllm-omni.md); changing only the URL on a
vLLM Endpoint cannot connect the official API. The official route uses `model: 'MiniMax-H3'`; Base routes use their explicit checkpoint identities
on the ordinary `provider` Source. Address, deployment and authentication are
Endpoint configuration, not properties of the creative model.

## Configure and author

The user's `endpoints.json` entry can be:

```json
{
  "video": [
    {
      "endpoint": "default",
      "service": "minimax",
      "model": "minimax-h3",
      "apiKey": ""
    }
  ],
  "image": []
}
```

The user supplies the key privately using [JSON or environment setup](../setup.md).
The default URL is the official MiniMax address. Runtime resolves this to
`protocol: 'minimax-video-v2'` and the authoring identity `MiniMax-H3`.

Keep existing connections when adding this entry. Never enter a key in chat. Normal [submission/upload authorization](../service-execution.md)
still applies. Configuration does not establish account access or generation quality.

```js
{
  id: 'motion', kind: 'provider', output: 'picture', endpoint: 'default',
  model: 'MiniMax-H3', prompt: authoredPrompt,
  mode: 'text', references: [],
  requestedFrames: 192, fps: 24, size: '1344:768', attempt: 'motion-a',
  parameters: { durationSeconds: 8, resolution: '768P', ratio: '16:9' }
}
```

The packaged definition/mapping is selected automatically. Supported parameters:
`durationSeconds` (integer 4–15), `resolution` (`768P` or `2K`) and `ratio`
(`adaptive`, `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16`). When omitted,
Viscraft chooses `768P` and a supported concrete ratio matching `size`, with
duration rounded up to cover `requestedFrames / fps` and at least four seconds.
An explicit duration cannot be shorter than the expected Take. The native result
uses 24 fps; final Composition settings remain separate. `size` is the intended
raster, not a symbolic ratio or an exact promise of native generated dimensions.

`first-last-frame` requires one or two distinct frame images and uses adaptive
ratio; check their actual aspect against the intended canvas. Reference mode
preserves authored order and maps categories to native reference roles. Do not mix
first/last roles with reference roles. Use the [H3 guide](../models/minimax-h3.md)
for prompt and reference direction. This service does not require FL2VA/Ref2VA
`taskType` configuration. `steps`, `flowShift`, `seed` and deployment settings are
rejected rather than silently ignored because this implemented official surface
does not expose them.

## Wire contract and reference boundaries

Independently implemented from the official
[create](https://platform.minimax.io/docs/api-reference/video-generation-v2-create),
[query](https://platform.minimax.io/docs/api-reference/video-generation-v2-query)
and [model guide](https://platform.minimax.io/docs/guides/video-generation), checked
2026-10-23:

- JSON `POST /v2/video_generation` sends `model`, `content[]`, `duration`,
  `resolution` and `ratio`; successful submission returns `task_id`.
- `content[]` starts with the author's text, then ordered `image_url`, `video_url`
  or `audio_url` objects with native roles. Local approved bytes become data URIs;
  an explicitly supplied HTTPS locator must be bound to the frozen Asset hash.
  No automatic upload/hosting is performed; Ark `asset://` locators are rejected.
- This client currently accepts PNG/JPEG images, MP4 video and supported audio
  through the existing reference loader, a subset of the official formats.
  Official input caps apply: images 30 MiB, video 50 MiB, audio 15 MiB per file;
  the encoded JSON request is limited to 64 MiB, including Base64 expansion.
  Use authorized hosted URLs when inline input would exceed it.
- `GET /v2/query/video_generation/{task_id}` parses `task.status`: `queued`,
  `running`, `succeeded`, `failed`, `cancelled`. Success supplies `task.content.url`.
  Missing/mismatched task data is not a successful result.
- Download validated result URLs without forwarding the API credential. Temporary
  URLs are not persisted; a resumed download refreshes the URL through task query.

## Recovery and actual support

The existing video executor owns per-attempt locking, frozen request identity,
submit-unknown protection, polling, retained media and local reuse. Retry the same
known task after a query/download failure; do not create a new paid task to retry
a download. Changing the request needs a new attempt. A completed retained result
can be restored locally without reconnecting to the service.

Check account access and the returned media for the selected operation; configured
API support alone does not establish output quality. This route supports H3 generation; H3 Max, Context-IR,
regeneration, listing, callbacks and cancellation APIs are not implemented here.
