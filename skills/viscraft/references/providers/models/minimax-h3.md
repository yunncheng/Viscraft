# MiniMax-H3 — authoring by input mode

Use this after choosing H3 for a shot. Transport, credentials, submission/recovery
and Source fields depend on the selected service:
[vLLM-Omni](../services/vllm-omni.md) or
[MiniMax official API](../services/minimax.md).
General direction and continuity remain in
[Creative method](../../craft/creative-method.md#direct-generated-images-and-passages).

## Sources and support boundary

Official sources: the
[H3 prompt-writing Skill](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/SKILL.md),
[base-mode guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md)
and [full-reference guide](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md).
These are live upstream links, not a pinned/reproduced manual. The explanations
and examples below are Viscraft authoring guidance. Consult the originals for
additional syntax when the shot needs it.

On vLLM-Omni, the packaged H3 mapping sends the task and the frame positions in
`extra_params.task` and `extra_params.frame_indices`; those field names come from
the official
[vLLM-Omni MiniMax-H3 recipe](https://github.com/vllm-project/vllm-omni/blob/main/recipes/MiniMaxAI/MiniMax-H3.md).
Any H3 deployment used through this mapping must accept the same fields. The
deployment details live in the [vllm-omni-video protocol reference](../services/vllm-omni.md).

| Intent | Viscraft request | Actual condition |
| --- | --- | --- |
| Text only (T2VA) | `mode: 'text'`, no references | Official API supports this directly; vLLM-Omni needs the `minimax-h3-base-fl2va` model. |
| First frame (I2VA) | `mode: 'first-last-frame'`, one image with `role: 'first-frame'` | Official API, or `minimax-h3-base-fl2va`. Start from the supplied image's state. |
| First and last frames (FL2VA) | Same mode, one `first-frame` and one `last-frame` image | Official API, or `minimax-h3-base-fl2va`. Describe how action and camera connect the states. |
| Last frame (L2VA) | Same mode, one image with `role: 'last-frame'` | Official API, or `minimax-h3-base-fl2va` honoring the mapped `frame_indices: [-1]`. |
| Content/motion/sound reference | `mode: 'reference'`, ordered references with actual roles | Official API, or `minimax-h3-base-ref2va`. |

There is **no universal one-image rule**. Ref2VA accepts at most nine images,
three videos, three audios and twelve mixed references. The vLLM-Omni Ref2VA
service additionally requires at least one image or video; do not apply that
deployment restriction to the official API's documented reference combinations.
Each reference video and
each reference audio lasts 2–15 seconds, and the reference videos together, like
the reference audios together, may not exceed 15 seconds. FL2VA accepts at most
two frame images. These are distinct model modes;
neither a user-approved still nor an appearance reference automatically becomes
the first frame. Current service media validation may further restrict inputs.
Being able to describe editing, continuation or exact motion in an upstream prompt
guide does not prove that a selected deployment provides that control faithfully.

**Frame placement is encoded, not implied.** For vLLM-Omni `first-last-frame` requests,
the service mapping translates the authored reference ROLES into the wire's
frame positions: `first-frame` becomes index `0`, `last-frame` becomes index `-1`
(counted from the end). One first frame sends `[0]`, one last frame sends `[-1]`,
and a first+last pair sends `[0, -1]` in the order you authored them. The service
transmits ordered reference files without a separate role field, so still describe
who each reference is in the prompt. Accurate role-derived indices do not by
themselves prove the selected deployment renders exact frame control; review the
actual Take.

The official API instead sends explicit `first_frame` / `last_frame` or
`reference_image` / `reference_video` / `reference_audio` roles in `content[]`.
Input intent stays the same; the service mapping owns its wire representation.

## Runtime request and deployment

A current **vLLM-Omni** request can use:

```js
{
  id: 'motion', kind: 'provider', output: 'picture', endpoint: 'default',
  model: 'minimax-h3-base-ref2va', mode: 'reference',
  references: [{ asset: 'approved_hero', category: 'image', role: 'identity' }],
  prompt: authoredH3Prompt,
  requestedFrames: 97, size: '1344:768', fps: 24,
  steps: 30, seed: 7, attempt: 'motion-a'
}
```

`authoredH3Prompt` is the actual text prepared below. Canvas, FPS, frame count
and steps here are production choices. The vLLM-Omni mapping supplies steps 30 and flow shift 12
when omitted; they are not official API parameters or universal video defaults. For H3, `17n+5` describes an
expected latent frame boundary; decoded output wins.

**Model vs. service.** This page is the model's own creative/limits guide. The
deployment — address, credential, supported checkpoint and how H3 is selected on a
`vllm-omni-video` service — belongs to the [vllm-omni-video protocol reference](../services/vllm-omni.md).
Select the explicit Base identity: `minimax-h3-base-ref2va` or
`minimax-h3-base-fl2va`. The official service uses `MiniMax-H3`. These identities
have different allowed tasks; there is no user `taskType` or `both` setting.
The H3 mapping supplies the wire task and default service name `MiniMax-H3`;
a configured deployment alias can override the wire name only. Official requests
use their [native duration/resolution/ratio parameters](../services/minimax.md#configure-and-author),
without Base inference `steps`, `seed` or `flowShift`. Shared prompt principles do
not make different weight variants interchangeable. The normal user setup is
[JSON or environment variables](../setup.md); direct SDK examples describe the
resolved adapter contract, not user configuration.

## Base modes: three ordered text sections

Write the final `Source.prompt` using `integrated_multimodal_description`, then
`overall_soundscape`, then `non_diegetic_music`. These are labels inside one text
string, **not additional HTTP or Source fields**. For image modes, precede the
sections with the guide's frame-alignment statement for time zero and/or the end.
Use the exact alignment wording from the official base guide when needed.

Keep descriptions in English while retaining actual dialogue, lyrics and visible
text in their intended language. State the initial state, physical action and
camera path; a camera moving around the subject differs from the subject turning.
For a single continuous shot, connect the motion rather than inventing cuts. For
multiple shots, use `[Shot 1]` and later numbered shots with increasing timestamps
inside the requested duration. The official guide uses notation such as
`[Shot 2] At 00:03.500` for a later cut.

An original **text-only illustrative request**, not a validated cinematic recipe:

```text
integrated_multimodal_description: [Shot 1] A white pelican pedals a dark bicycle along a dry coastal road at sunset. A low side-tracking camera keeps the rider and both wheels visible. Over four seconds the camera moves smoothly into a rear three-quarter view as the rider continues toward the horizon; the road remains dry and the bicycle keeps its forward motion.
overall_soundscape: A quiet coastal wind underlies rhythmic chain clicks and tires rolling on asphalt. There is no speech.
non_diegetic_music: N/A
```

This can describe a four-second T2VA request; it does not instruct a Ref2VA
deployment to ignore its required references. Four seconds is this example's
choice, not a Viscraft duration policy. Generated frames and native audio still
need review.

## Ref2VA: six ordered text sections

Use this order in `Source.prompt`:

1. `subject_definitions`: define the reusable content and reference roles.
2. `summary`: identify the task and the relationships to those references.
3. `retention_analysis`: specify what carries, changes or supplies guidance.
4. `detailed_description`: describe the actual audiovisual passage in order.
5. `overall_soundscape`: ambience and physical/nonverbal sound.
6. `non_diegetic_music`: audience-only background score, or `N/A` when absent.

Resolve `<Picture N>`, `<Video N>` and `<Audio N>` against the request's ordered
references in their own media categories, recording the Asset correspondence.
`<Subject N>` identifies content, not an upload slot: several references can
define one subject, and one reference can define several subjects. A standalone
picture entry is useful for a frame/storyboard anchor; an identity image can be
cited within its subject definition. A video supplies temporal structure when
that is its role. Its audio track does not become an audio reference merely
because it is present; the request must actually enable the intended sound input.

For example, with one approved identity image as `<Picture 1>`, an original
**illustrative** four-second request is:

```text
subject_definitions: <Subject 1> is the pelican and dark bicycle in <Picture 1>; use their silhouette, proportions and feather appearance as identity guidance, without retaining the image's background.
summary: [reference generation] <Subject 1> cycles along a dry coastal road at sunset in a continuous side-to-rear tracking shot.
retention_analysis: <Subject 1> (appears in [Shot 1]): partially_preserved - retain the defined rider and bicycle features; change the setting and viewpoint for the new shot.
detailed_description: [Shot 1] In warm low sunlight, <Subject 1> pedals forward on dry asphalt. The camera starts beside the bicycle with both wheels visible, then travels smoothly into a rear three-quarter view over four seconds. The rider continues toward the horizon without stopping or entering water.
overall_soundscape: Coastal wind, regular chain clicks and tire noise remain continuous. No dialogue.
non_diegetic_music: N/A
```

Retention terms describe the requested relationship, not a measured success.
For voice/dialogue, use the official speaker IDs and `<d>[language]…</d>` notation;
keep the user's actual words. Consult the official guide for cross-cut speech and
audio reuse rather than treating a prompt label as sample-accurate mixing. Final
sound decisions belong to the Project timeline.

## Evidence and failure diagnosis

This page documents structured prompt shapes and their Runtime transport. The
authoring examples are **illustrative guidance**: they describe what to ask for,
not what any deployment will deliver. The official model contract remains the
authority for mode capabilities, and the actual service/run remains the authority
for what is available; a structured prompt does not by itself establish fresh
generation or exact control across every H3 mode.

Plan checks an H3 request and its reference files against this page's rules before
any submission, so a violation is reported as `blocked` instead of failing later.
H3 owns its own partition rules, so read the reported code carefully:

- a reference video outside the media window above is `reference-media-invalid`
  (the file is probed locally; nothing is uploaded);
- a mode the selected H3 Base identity does not serve, an over-count
  reference set, an out-of-window reference audio or an over-long reference total
  is `model-request-invalid`, naming the partition or limit as the reason rather
  than reporting a misleading reference-count error.

If rough proxy surfaces survive into a supposed photographic Take, check the
actual reference pixels and their roles before adding quality adjectives. If a
shot restarts an action at a cut, inspect input state and source intervals through
[event continuity](../../craft/editing-awareness.md#carry-the-event-through-a-cut).
If motion drifts, inspect a passage rather than judging identity/control from one
correlated still. Keep the original accepted Take while testing a changed request
under a new authorized attempt.
