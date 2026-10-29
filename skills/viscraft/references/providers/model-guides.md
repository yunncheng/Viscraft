# Model guidance — select the model, mode and actual service

Read this when preparing a generation/editing request. Use
[Creative method](../craft/creative-method.md#direct-generated-images-and-passages)
for the shot or image intent, then load only the selected model guide. The host
agent authors the final prompt; Runtime transmits it without a creative rewrite.

| Selected model | Read for authoring | Execution |
| --- | --- | --- |
| `MiniMax-H3` | [H3 modes, reference labels and prompt structure](models/minimax-h3.md) | [MiniMax official API](services/minimax.md). |
| `minimax-h3-base-ref2va` | [H3 reference direction](models/minimax-h3.md) | [vLLM-Omni](services/vllm-omni.md); reference generation only. |
| `minimax-h3-base-fl2va` | [H3 text and frame direction](models/minimax-h3.md) | [vLLM-Omni](services/vllm-omni.md); text or first/last frames. |
| `Seedance-2.5` | [Seedance 2.5 tasks, reference bindings and sound notation](models/seedance-25.md) | [Ark video v3](services/ark.md) on the `ark-video-v3` protocol. |
| `gen4.5` | [gen4.5 modes, ratios and prompt direction](models/gen45.md) | [Runway service](services/runway.md) on the `runway-v1` protocol. |
| `gen4_turbo` | [gen4_turbo image-to-video](models/gen4-turbo.md) | [Runway service](services/runway.md) on the `runway-v1` protocol; image-to-video only. |
| `alibaba/wan-3.0/image-to-video` | [Wan 3.0 first/last-frame direction](models/wan-30.md) | [fal service](services/fal.md) on the `fal-queue` protocol. |
| Another image/video model or a host image tool | Its exact model/version's official guide and the selected service/tool contract | [Generation inputs](generation-inputs.md) for host import/image operations; [Model integration](model-integration.md) for Runtime integration. An arbitrary name does not enable a route. |

The model guide describes authoring; the model definition validates machine rules;
the service mapping/protocol describes the wire contract. Endpoint configuration
selects the available deployment. Effective capability is their intersection.
Do not infer support from a prompt technique, an upstream demo or a credential.

## Image models follow the same method

Identify the actual host tool or configured image model/version before adopting
its guide. An opaque tool's successful output establishes that tool's observed
behavior; do not assign it a guessed model identity or unsupported parameters.

For text-to-image, specify a single visible state and the image's role: final
picture, identity design, Look exploration or a frame anchor. For editing, state
the intended change and retained features, then check the selected route's image
count, masking, alpha, output geometry and preservation controls. A textual
instruction to retain a feature is not a pixel-preservation guarantee. Review the
actual image before binding it into dependent shots. See
[Image direction](../craft/image-direction.md) and the implemented
[generate-image operation](services/vllm-omni.md#1-the-generate-image-operation).

## Review the returned picture and sound together

A returned Take carries both picture and (often) its own audio; inspect them as one
result. A model's declared fields, an example prompt's `N/A` (for example a
`non_diegetic_music: N/A` line), or a prompt that said "no dialogue/no music"
describe the **request**, not what came back — never infer the actual content from a
peak level, a `hasAudio` flag or that text, and never read a model as silent because
a guide's example chose `N/A`. Those are that example's authoring choices, not a
default requirement; real model control stays as the model page documents. When you
cannot listen, mark the sound **not reviewed**. Keeping, processing or replacing a
Take's own sound is a per-Take content decision, not a mode — see
[Sound design](../craft/sound-design.md) and
[Timeline](../runtime/timeline.md) §3h.

## When a model has no local guide

Consult its primary documentation for the exact version and service; record the
source and relevant facts in project working notes if this is a one-off use.
Do not guess tokens, import another model's template, install an upstream Skill
automatically or send private reference material to a search tool. Missing guidance
does not block a documented, representable request; uncertainty about a required
capability or deployment does need resolution before committing production.

Keep one-off model guidance with the Project and the author's final prompt and
references in the existing Source, not in a parallel prompt registry. For a
project-owned definition and mapping, use
[Model integration](model-integration.md#complete-a-model-integration).
