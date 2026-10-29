# Seedance 2.5 — tasks, references and audiovisual direction

Use this for `model: 'Seedance-2.5'`. Endpoint configuration, executable Source
example and transfer/recovery rules live in
[Ark video v3](../services/ark.md#configure-the-selected-mapping).
This guide does not transfer H3 syntax or Seedance 2.0 recipes into 2.5.

## Primary sources

Official sources: the
[2.5 model guide](https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh),
[2.5 prompt guide](https://docs.volcengine.com/docs/ark/seedance-2-5-prompt-guide?lang=zh),
[create-task API](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh)
and [get-task API](https://docs.volcengine.com/docs/ark/get-video-generation-task-api?lang=zh).
Those `?lang=zh` links are the vendor's Chinese-language originals and are cited as
the source of the translated guidance below. Links track upstream documentation; they
are not a frozen guarantee about an account. The prompts below are original
illustrative authoring examples.

## Choose a task before writing its prompt

| Intent | Source and parameters | Prompt responsibility |
| --- | --- | --- |
| Text generation | `mode: 'text'`, no references | Establish the complete initial scene, action and sound. |
| First frame / first and last | `mode: 'first-last-frame'`, first image required, last optional; `ratio: 'adaptive'` | Develop from the opening state and, when supplied, connect to the ending state. |
| Multimodal reference | `mode: 'reference'`, `task: 'reference'` | Explain which inputs provide identity, scene, motion/camera or sound. |
| Edit a supplied video | Reference mode, `task: 'edit'`, video required, adaptive ratio, `durationSeconds: -1` | Identify the video to edit, the actual change and what should remain. |
| Extend a supplied video | Reference mode, `task: 'extend'`, video required, adaptive ratio | Identify the video, extension direction, boundary state and new action. |

The official service uses prompt intent as well as content roles to interpret a
task. Explicitly say to edit/change/remove/replace for an edit, or extend/continue
for an extension; the official Chinese examples require corresponding task
keywords. The mapping sets `omni_reference_task_type` but does not rewrite the
prompt or enforce keywords with a language-dependent regex. Avoid an edit prompt
in a `task: 'reference'` request. Resolve unsupported operations before submitting.

Current native duration is an integer 4–30 seconds or `-1` for model-chosen length;
the actual returned Take is authoritative. Current 2.5 resolution options are
`480p`, `720p`, `1080p`; **`4k` belongs to another model's options in the API table**.
Reference counts are at most 30 images, 10 videos and 10 audio inputs, 50 total;
audio-only references are allowed. These limits do not mean more inputs improve
the shot. See [Runtime request](#runtime-request) for the client's narrower media formats
and the hosted video locator requirement.

The official guide also describes Draft-to-final task reuse, web search and
managed portrait inputs. They are **not exposed by this extension**. A normal
`480p` request is not that Draft workflow. Do not invent parameters for them;
inspect actual service access and implement/test the needed route first.

## Write direction, then bind the inputs

The official writing approach covers subject, event, environment, visual style,
camera/cuts and sound as needed. Make a short overview, assign each reference a
specific responsibility, then describe action in shot order or on a timeline.
The framework is a useful writing aid, not six mandatory sections or a fixed
number of shots. Keep the scene achievable within the requested duration.

Use `@图片1`, `@视频1`, `@音频1` (or the official examples' `@image1`, `@video1`)
consistently with the selected language. These `@图片N` / `@视频N` / `@音频N` markers
are the model's own mandated input syntax, quoted here in their original form rather
than translated into English; keep the marker itself verbatim. Number inputs within
each media category in their transmitted order, not by arbitrary Asset name or
mixed-array position. State what a reference supplies and which unwanted qualities
should not carry. The mapping preserves Source reference order and roles; prompt
mentions do not create or upload references. Check that every named input is actually
attached.

The example prompt below is deliberately written in Chinese: it exercises the
mandated markers together with the official punctuation conventions (`()` music,
`<>` effects, `{}` dialogue, `〖〗` visible text) that are part of the request syntax,
so it is a genuine original-language sample and not English prose left untranslated.
Write each real prompt in the language you actually direct in, but always using the
model's own markers and conventions. An original four-second reference prompt, with
`hero` as the first image and `motion` as the first video, could be:

```text
@图片1提供鹈鹕和深色自行车的外形；@视频1仅提供侧面移动到后侧的运镜，不采用其原片主体、背景或配色。写实海岸公路的落日镜头：鹈鹕持续向前踩踏，双轮始终接触干燥路面。0–4秒，摄影机从平行侧跟拍平滑绕到后侧斜视角，主体运动方向保持一致，地平线稳定。<连续链条声、轮胎滚过柏油路的声音和轻微海风>。无对白，无字幕，不要背景音乐。
```

A synthetic test-pattern video is not suitable production motion guidance; use an
approved, task-relevant reference for a real work.
For a single first-frame request, describe the visible starting state and its
development directly; do not mention an unattached motion video. For an edit,
say what is changed in `@视频1`; for an extension, specify whether the new material
precedes or follows it and how motion/sound cross the boundary. Those instructions
are intent, not guarantees of preservation or physically exact motion transfer.

## Sound and visible text

The official 2.5 convention uses `()` for music, `<>` for effects, `{}` for dialogue
and `〖〗` for visible text/subtitles. Preserve intended words and specify the spoken
language when needed. Distinguish a spoken line from text that should appear on
screen; repeating a line as a visual description can induce unwanted subtitles.
The mapping sends this author-written text verbatim in `content[].text`.

`generateAudio` controls the native audio request. Review the returned speech,
effects and music before deciding whether to retain them; do not add an external
bed automatically on top of an existing soundtrack. Sample-accurate J/L cuts,
sound replacement and final mixing use the normal
[timeline](../../runtime/timeline.md), with selected Take intervals.

## Review and refine

Use [Review and repair](../../craft/review-repair.md) to compare an actual passage
with its shot intent. Diagnose wrong identity/reference role, contradictory
action state, excessive event density or unsuitable input quality before another
paid attempt. A nice first frame does not establish smooth camera movement,
natural contact or a coherent cut. Keep accepted Takes and known task identities;
download recovery must not become regeneration.

Promote a successful method into a reusable recipe only with its actual request,
input roles, selected intervals, observed strengths and limitations. Official
authoring guidance is not evidence that a generation succeeded: report what the
returned Take actually shows
([Report honestly](../../../SKILL.md#report-honestly-real-vs-simulated)).

## Runtime request

Author a normal Source, validate with `SourceSchema`, and save it into the Project:

```js
const source = {
  id: 'sunset-take', kind: 'provider', output: 'picture', endpoint: 'default',
  model: 'Seedance-2.5', mode: 'first-last-frame',
  references: [{ asset: 'approved-opening', category: 'image', role: 'first-frame' }],
  prompt: 'Describe the approved shot, continuity and sound here.',
  requestedFrames: 192, fps: 24, size: '1280:720', attempt: 'sunset-a',
  parameters: {
    durationSeconds: 8, resolution: '720p', ratio: 'adaptive',
    generateAudio: true, task: 'reference', outputFormat: 'mp4'
  }
};
```

For the concrete Endpoint and authorization configuration, use
[Ark video v3](../services/ark.md#configure-the-selected-mapping).

Important limits of this route:

- Model requests support text, first/last frames and reference tasks; references
  may include images, videos and audio. First/last frames use `ratio: 'adaptive'`.
  Seedance's counts and duration rules belong to its definition, not H3 or the
  public Source. `steps` and `flowShift` are rejected for this model.
- `task: 'edit' | 'extend'` needs a reference video and adaptive ratio. Editing
  uses `durationSeconds: -1`. These are implemented request mappings, not evidence
  of real editing fidelity. Verify that the selected account/model supports them.
- This client currently accepts PNG/JPEG images, MP4 reference video and WAV/MP3
  reference audio. Its bounded transfer/output handling can be narrower than the
  model's published formats and maximum sizes. No implicit format conversion or
  silent substitution occurs.
- Image/audio references can use data URIs. A video reference needs an already
  authorized hosted URL or `asset://` locator. Supply
  `referenceLocators: { motion: { url, sha256: approvedMotion.sha256 } }` in the
  Endpoint binding options. Runtime validates the SHA association and locator
  form; the caller is responsible for the remote bytes matching that Asset.
  Runtime does not automatically publish or upload local video, and preflight
  does not fetch the remote locator.
- `requestedFrames` and `size` express production needs. `size` is a real raster
  canvas; `ratio: 'adaptive'` lets the model derive the aspect, while any fixed
  `ratio` requires the canvas aspect to match it. `durationSeconds` is the
  generation-request length and `requestedFrames / fps` the expected take length:
  a request shorter than the expected take is refused before submission. Seedance
  receives its
  native duration/resolution/ratio; a returned Take's decoded frames and audio
  are authoritative. Build validates selected intervals and normalizes output;
  it does not invent missing frames or assume generated duration is guaranteed.
- Task results use signed media URLs. Private job records retain the task and
  recovery data; public status/provenance redact endpoint and media URLs. A failed
  download can refresh the existing task URL, without a new generation. An
  ambiguous submission never authorizes an automatic second POST.

### Reference video limits

This packaged definition accepts a reference video within these limits; a file
outside them is refused before submission rather than converted or trimmed.

| Property | Accepted |
| --- | --- |
| Duration | 2–30 s per file; the reference videos together at most 30 s |
| Frame rate | 24–60 fps |
| Short side | ≥ 300 px |
| Long side | ≤ 6000 px |
| Aspect ratio | 0.4–2.5 |
| Pixel count | 407,696–8,295,044 |
| Video codec | H.264 / H.265 |
| Audio | optional, AAC / MP3 |
| File size | at most 200 MiB |

A reference image uses the same short/long side and aspect bounds, under 30 MiB;
a reference audio is WAV/MP3, 2–30 s, at most 15 MiB, and the reference audios
together at most 30 s. A video supplied for `task: 'edit'` is at least 4 s. These
are this client's route limits — check the selected account and model version for
anything beyond them.

