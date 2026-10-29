# Generation inputs — host tools and configured services

Use this to distinguish image/video operations and choose between an actual host
tool and a configured Runtime service. Protocol-specific requests, credentials
and recovery live in [Service execution](service-execution.md) and its selected
`services/` reference for the selected connection. Model
conventions live in [Model guidance](model-guides.md).

Choosing a service/input combination follows the
[method decision](../craft/creative-method.md#choose-the-medium-for-the-required-control),
including the appearance/control gap and a relevant code/proxy alternative.
Endpoint readiness and a valid request do not settle that creative choice.

## 1. Startup-check entry

[Startup checks](../runtime/preflight.md) owns task-relevant Runtime/tool/Provider
discovery, readiness evidence and user decisions when prerequisites are missing
or uncertain. Read it at task entry; do not repeat its scan for each Asset.
This page supplies the operation distinctions and input-path choices once the
relevant tools and services are known.

For either image or video, read the selected model's authoring guidance through
[Model guidance](model-guides.md). Image generation/editing needs the same split
between shared craft, official model conventions, service constraints and observed
recipes. The installed host tool's contract is authoritative for an opaque image
model; do not guess its identity or carry another model's syntax into it (for
example H3's or Seedance's prompt structure). Runtime extension requirements live
in [Complete a model integration](model-integration.md#complete-a-model-integration).

## 2. Four operations that must not be conflated

| Operation | Inputs / results to verify | Where it enters the chain |
| --- | --- | --- |
| Image generation | text, and any reference it actually supports; output format/size; identity and composition intent | characters/scenes, visual anchors, storyboards, textures |
| Image editing | input image, change instruction, whether masks/multiple references are truly supported, what must be preserved | a derived or replacement image Asset; affects shots through Binding/Source |
| Video generation | text/image/first-last-frame/reference-control support; duration, FPS, audio | source video and candidate Takes, then Edit/Composition |
| Generative video editing | source video, edit scope, required control inputs, temporal consistency, preserved regions | a new candidate with an explicit change scope; original and unaffected output retained |

A reference image is **not** automatically a first frame; a reference video is
**not** automatically pose, camera or exact motion control. Instruction-based image
editing does **not** automatically include pixel-accurate masked repair;
reference-video generation does **not** automatically include subject replacement
or local video editing. Verify each capability against the concrete tool, model or
service. Backends that need pose/face/mask/tracking must wire the real
preprocessing into the same chain before the capability may be claimed; the raw
video is not a stand-in for a control input. Mask meaning, time mapping, size and
frame rate follow each backend's contract — they are not uniform across models.
Per-frame image editing must not be advertised as solving temporal continuity
without video verification.

Each reference is an ordered entry carrying a `category` and a `role`. State the
role as the job that material is asked to do — identity, material, environment,
composition, camera, style or sound — and what may vary; `first-frame`,
`last-frame` and `mask` additionally change how the request is encoded. A video
Source declares an explicit `mode` and its ordered `references`: `text` uses none,
`first-last-frame` uses one or two frame images, `reference` conditions on images,
video and audio in the authored order. The role is guidance recorded with the
request and carried in the prompt; it never adds a control the route lacks, and a
description alone does not turn one role into another. Keep each description true
to where the material came from: a frame taken from an earlier Take is an
appearance anchor, not that request's actual preceding shot, and separate requests
do not inherit one another's scene, performance or motion.

When the input is a **recording or a motion/composition proxy** (Route 1 in
[Capability chains → two creation routes](../workflows/capability-chains.md#playablegame-recording--output--two-creation-routes)),
state each material's responsibility — motion/composition vs identity/material/
lighting — and what may change. A **joint** input of motion-reference video plus a
compatible target-Look image is one option for asking for continued action with
a re-done look; a single still does not describe a whole motion. Inspect their
[incidental composition and state together](../craft/reference-adaptation.md#prepare-compatible-references-for-video-generation):
labelling an image `style` does not prevent its viewpoint/layout from influencing
the result, and labelling a video `motion` does not suppress its appearance.
Model support for
joint reference does **not** equal deterministic adherence: check that the selected
deployment and the current Adapter can pass these materials together and expose the
needed control before committing, and verify a short segment first. Do not assume
two Adapters share one upload method or that a new generic upload service exists.

## 3. Two entry paths, one work semantic

Both paths produce the same kind of thing — material that enters an ordinary
Project through Assets, Sources, Bindings and Takes.

**(a) A host image tool, then import.** Produce real material with an authorized
host tool, save the real file, and record the obtainable generation context, the
input provenance and the rights. Admit it through `importAsset`; then use it via a
Binding/Source in ordinary shots. To change one asset, change it and rebuild only
what depends on it (`inspectAssetInputs` diagnoses the affected inputs; nothing is
regenerated automatically). Record the host and the **real tool actually used**,
with observed evidence — do not generalise one host's success to every agent.

**(b) A user-configured service through an adapter.** Speak the service's real
protocol, whether local HTTP or remote HTTP, without copying a deployment brand's
directory layout. A synchronous image call keeps its real synchronous semantics;
an asynchronous service persists its task id, query and result collection. Do not
build a second remote queue platform inside Viscraft when the service exposes no
async task interface. Image generation/editing is an independent operation: its
`generate-image` request names only a non-secret `endpoint` binding key, and the
runtime provider map `providers.imageApi` supplies the already-running service
([vllm-omni-image](services/vllm-omni.md)). Video generation keeps the same layered
pattern with an authored `provider` Source naming the `endpoint` and
`providers.videoApi` supplying the service ([Service execution](service-execution.md)).
Both bind `{ protocol, baseUrl, model?, credential? }` and treat loopback HTTP vs
remote HTTPS as a configuration/authorization choice, not a property of the
authored request or Source.

Service configuration belongs to the run environment; creative intent and the
regenerable inputs belong to the Project. Freeze the model/protocol, service
binding identity, request parameters and input hashes for each attempt.

## Retain and configure the selected input path

For host-produced material, use [Media preparation](../runtime/media-preparation.md#2-import-approved-host-tool-material)
to retain real files in the work directory and admit suitable images with
`importAsset`. That reference owns hash, rights, immutable identity and frozen
production-input semantics; importing does not approve an image's appearance.

For a configured API, read only the selected contract through
[Service execution](service-execution.md#implemented-service-interfaces).
The `services/` directory includes image and video contracts; a route for one
medium does not enable the other. Use the user's existing authorization scope,
and do not silently change the selected tool/model/account, transmit references
or retry an ambiguous submission. Shared consent, credentials and verification
rules belong to Service execution and [Startup checks](../runtime/preflight.md).

## Non-film exit: a still image

A pure image task — one illustration, one hero still, one edit of a supplied
image — is a complete deliverable on its own. Do not invent a film, timeline or
storyboard to "carry" it. The route is the same four stages the rest of the Skill
uses, at the image's scale:

- **Produce.** Either a configured image service through the independent
  `generate-image` operation, or an authorized host tool whose real file you
  import. Both end with an **image Asset** in the Project. The operation is
  independent of the film: it reads no `composition` and no movie output
  settings, so an image-only Project needs no fabricated timeline for it.
  - Service: `viscraft generate-image <project-directory> <relative-request.json>
    [--check] [--config <project-relative.mjs>]`; SDK
    `generateImage(root, request, options)` with
    `request = { id, attempt, asset, rights, operation: 'generate' | 'edit',
    endpoint, model, prompt, references?, size?, seed?, parameters? }`. It speaks
    `vllm-omni-image` and needs `providers.imageApi[endpoint].authorization.submit`
    (plus `uploadAssets` for any transmitted reference). `edit` needs a non-mask
    reference; a `mask` reference marks a region. See
    [vllm-omni-image](services/vllm-omni.md).
  - Host tool: produce the real file, then
    `importAsset(root, { assetId, sourcePath, type: 'image', rights,
    expectedRevision })`
    ([Media preparation](../runtime/media-preparation.md#2-import-approved-host-tool-material)).
- **Inspect.** Open the registered bytes with the host's image tool before using
  them. For a service request, `--check` (SDK `preflightGenerateImage`) is a
  read-only report of what the call would do — zero network, zero write, zero lock —
  as `submit` / `return-existing` / `resume-registration` / `blocked`; it generates
  nothing. Execution re-checks the same classification before any POST.
- **Deliver.** A generated or imported still is an **Asset**, not an
  `imageTargets` entry, so `deliver --image <target>` does not name it: that
  selector covers authored still targets rendered by `viscraft image`. With no
  target, hand over the registered Asset file itself, or run `export
  <project-directory>` (the Portable export carries the image Asset's rights and
  provenance plus the editable Project, with no Build required) so a receiver may
  keep working with it. A single image is not a "film" and produces no
  `movie/final.mp4`.
- **When the picture must become a delivered still target.** Turn it into an
  authored single-image document and declare an `imageTargets` id — that route,
  its binding and its delivery are owned by
  [Image direction → a flat final image](../craft/image-direction.md#a-flat-final-image-one-real-layer-no-invented-structure).
  Until then it stays a plain Asset and the exits above apply.
- **Modify.** A changed service request is a **new attempt** with its own
  authorization; an edit of the source image becomes a **new Asset id** (existing
  ids are refused, never overwritten). Either way, only the Sources/Bindings that
  actually consume that Asset change.

**Provenance that travels.** A generated/edited image Asset persists **hash-only**
`imageGeneration` provenance (model/provider, operation, request/prompt hash, the
ordered reference roles/hashes, output hash, seed/size and the simulated flag) plus
its `inputs` parents, and the Portable export carries that on the Asset. The
provider's **job/request state** (`.viscraft/jobs/`, remote ids, URLs) does **not**
travel, so the Asset record — not the job directory — is the portable source of
truth; keeping the authoring prompt/params for a later remake is an author-notes
responsibility. The handoff export also carries those raw output bytes under
`.viscraft/provider-media/` (the raw provider output, never the request state); a
hash-only record still cannot reconstruct the prompt. The hash proves *which*
request and inputs produced the bytes.
