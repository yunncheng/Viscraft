# vLLM-Omni service — video and image interfaces

User configuration uses the single service identifier `vllm-omni` for both image
and video models. Runtime selects the implemented interface from the configured
category and model. The sections below describe its two wire protocols; a working
image deployment does not establish video support. See [Provider setup](../setup.md).


## vllm-omni-video — multipart video task protocol

Read [Service execution](../service-execution.md) for shared authorization and
[Model guidance](../model-guides.md) for the selected model's rules. Input modes
and model parameters depend on that model and the selected deployment.

`vllm-omni-video` is a **Viscraft client contract choice** — the multipart task
contract this client implements and expects a configured service to provide.
Viscraft does not host that service; use a self-hosted or remote deployment that
implements the contract. The protocol identifier names a transport, not a model
or a cross-vendor standard.

The `provider` Source stores a model request and a non-secret Endpoint
binding key. A runtime `providers.videoApi` mapping supplies the already-running
service. Local and remote deployments that implement the **same supported
contract** use the same task engine; model installation and service deployment
belong to the user. A URL alone does not establish protocol compatibility.

```js
{
  id: 'motion', kind: 'provider', output: 'picture', endpoint: 'default',
  model: selectedModelId, prompt: authoredShotPrompt,
  mode: 'reference',
  references: [
    { asset: 'approved_hero', category: 'image', role: 'identity' }
    // Additional supported references belong here in meaningful order.
  ],
  requestedFrames: 192, size: '1280:720', fps: 24,
  attempt: 'motion-a'
  // Model-specific parameters must match the selected definition and service.
}
```

For a declared model on this service, establish its capabilities before submission; accepting
its name does not prove the loaded model can fulfill the request. Generic request
fields are not evidence of arbitrary video editing, last-frame control, multiple
references or precise motion transfer.

#### Supported contract and model constraints

`vllm-omni-video` is a precise implemented subset:

- multipart `POST /v1/videos`: `model`, `prompt`, `width`, `height`, `fps`,
  `num_frames`, optional `num_inference_steps`, `seed`, `flow_shift`, an
  `extra_params` JSON string, plus optional repeated `input_references` file
  parts. `extra_params` is `'{}'` when the selected model needs no extras; a
  configured model/mapping carries its own request semantics there (for example
  the H3 mapping's task and frame fields, documented on its
  [model page](../models/minimax-h3.md));
- `GET /v1/videos/{id}`: `queued`, `in_progress`, `completed` or `failed`;
- same-origin `GET /v1/videos/{id}/content`: the completed media.

The author's prompt content is transmitted without a creative rewrite. Standard
multipart text serialization uses CRLF line endings for multi-line fields.

Do not infer compatibility from the words "OpenAI-compatible". Use an existing
service that fulfills this contract; another service may need deployment-side
API wrapping or a separately implemented thin protocol adapter.

The `provider` Source requires an explicit mode and an ordered
`references` list. `text` uses no references; `first-last-frame` uses an image
with role `first-frame` and/or `last-frame`; `reference` uses supported image,
video and audio conditioning with declared purposes. A reference image with role
`identity` is not silently treated as a first frame. Describe the intended roles
and input numbering in the prompt: recorded roles do not guarantee exact model
control over identity, materials or motion.

With no configured model mapping, the multipart request sends the files in
authored order and `extra_params: '{}'`, without separate wire fields for their
roles. A model/service must then interpret that ordering and prompt as intended,
and a role accepted by the Source schema does not establish that a particular
deployment supports it. A selected model/mapping may instead translate roles into
real wire fields — see the next section.

Accepted reference images are PNG/JPEG by signature, at most 30 MiB. Video
references must be MP4 and at most 50 MiB; audio references must contain a real
audio stream and are capped at 50 MiB. These byte caps bound Viscraft execution.
Input hashes must
match the frozen approved Assets; unsupported media is refused rather than
silently converted. This is a bounded reference-input contract, not pose, mask,
face, exact camera control or local video-person replacement.

#### Select a model definition for a generic protocol

`vllm-omni-video` is a transport, not a model: it cannot name a model, so it does not
apply a model's limits, defaults or wire semantics on its own. When a Source's
canonical model has a packaged definition + mapping, that definition is selected
**automatically** from `(source.model, protocol)` — the Source names the model and
you import or inject nothing:

```js
{ id: 'motion', kind: 'provider', output: 'picture', endpoint: 'default',
  model: selectedPackagedModel, /* its packaged definition + vllm-omni-video mapping is auto-selected */
  prompt: authoredShotPrompt, mode: 'reference', references: [/* … */],
  requestedFrames: 192, size: '1280:720', fps: 24, attempt: 'motion-a' }
```

The selected definition is what turns the Source into the model's own task and
frame fields inside `extra_params`, and what validates that request against the
model's modes. The model page documents those fields and any deployment setting
the model needs — see
[H3 → Runtime request and deployment](../models/minimax-h3.md#runtime-request-and-deployment)
for a worked example.

A Source naming a model with **no** packaged definition and no injected extension,
whose request needs a definition (any `parameters`, or a vendor protocol), is
reported by `plan` as `needsConfiguration` (`video-model-not-configured`); a
parameters-free generic request is sent as an ordinary generic request. The
packaged canonical models and their protocols are listed in
[Provider setup](../setup.md#model-selection-and-the-deployment-alias). A
definition with no packaged mapping may be
**explicitly injected** instead, by passing a `GenerationExtension` value in the
run's provider options (`providers.videoApi[<endpoint>].extension`) — built per
[Model integration](../model-integration.md); an injected extension always takes
precedence. Do **not** import a model's extension from a package subpath: the
published Runtime exposes only its root entry, and the model's own extension
constructor is not exported at the root. Model-specific wire task syntax and limits
live on the model page; this page owns address, credential and definition
configuration.

#### Bind an Endpoint at execution time

```js
const options = {
  endpoint: {
    protocol: 'vllm-omni-video',
    baseUrl: userConfiguredServiceUrl, // explicit loopback HTTP or remote HTTPS
    // model: 'deployment-model-alias', // optional wire alias, not creative identity
    // credential: 'MY_VIDEO_API_KEY'  // optional named credential (environment or stored)
  },
  // extension: injectedExtension, // optional: ONLY to inject a model with no packaged definition
  authorization: { submit: userAuthorizedSubmission,
    uploadAssets: userAuthorizedAssetIds }
};
await buildProject(root, {
  candidates: [{ shot: 'shot', sources: ['motion'] }],
  providers: { videoApi: { default: options } }
});
```

No service address is inferred or scanned; no endpoint or credential is saved in
Source authoring. Local plain HTTP accepts explicit loopback IPs only. Remote
services must use user-configured HTTPS. `credential` is a credential **name**
(environment variable, else the user's stored value; see [Provider setup](../setup.md)),
resolved only at the API boundary; the key never enters Project,
metadata, diagnostic errors or exported media provenance. An optional
`endpoint.model` is the deployment alias described under
[model selection](../setup.md#model-selection-and-the-deployment-alias).

Before submitting, follow [SKILL.md spend and upload consent](../../../SKILL.md#spend-and-upload-consent):
`authorization.submit === true` is required, every transmitted Asset must be listed
in `authorization.uploadAssets`, and the user must have agreed to this run. A
configured key or a redistributable license is not submit/transmission consent. An
ordinary unconfigured Build must not invent a service, accept a billable attempt or
upload references.

Build resolves the Source's reference Assets and supplies their frozen bytes.
Direct `generateVideoService` callers must provide matching
`references: [{ asset, root }, …]` as well as the Endpoint options themselves.
Prefer the Build path to register
candidate Takes normally; selecting a Take remains a creative decision.

#### Recovery and provenance

A per-attempt exclusive lock and persisted pre-submit record prevent concurrent
or accidental duplicate submissions. An ambiguous submit becomes
`submit-unknown` and is never auto-resubmitted. Known tasks resume by querying
status or fetching retained/completed media; changing an attempt is not a polling
strategy. Real status queries are bounded to at least five seconds, and each
invocation performs at most one query. `VideoApiPendingError` carries the next
query time; `providerJobStatus(root)` and CLI `status` inspect persisted task records.

The frozen request identity binds protocol, Endpoint identity, deployment alias,
source parameters, input hashes and output settings. Reusing an attempt after
changing those inputs is rejected; switching a configured URL must not query the
old task against the new service. Endpoint addresses are represented by hashed
identity rather than persisted URLs. Prompts and input bytes are not copied into
job logs. Do not retain keys, auth headers, URL secrets or server response bodies
in shareable metadata.

Completed originals are hash-checked and probed before normalization into the
Composition clock. `requestedFrames` is sent verbatim. **Actual decoded frame
count is authoritative**, not the request or prediction. Failed downloads resume without a new POST; same-origin
bounded content downloads do not follow an unrelated media URL supplied by a
response. Already accepted results remain reusable without generation.

Explicit `providers.videoApi.default.testOnly: { baseUrl:
'<actual-loopback-fixture-origin>' }` points this Source's transport at a loopback
fixture and marks every dependent result `simulated`; the configuration mechanism
and its limits are in
[Service execution](../service-execution.md#test-mode-and-real-execution), and
what such a result may claim is in
[SKILL.md → Report honestly](../../../SKILL.md#report-honestly-real-vs-simulated).
Before claiming a live generation, inspect the specific request and the retained
real result.


## vllm-omni-image — synchronous image generation and editing

Use this for the implemented JSON/multipart image service contract. Host-tool
selection belongs to [Generation inputs](../generation-inputs.md); local material
admission belongs to [Media preparation](../../runtime/media-preparation.md#2-import-approved-host-tool-material).
For shared credentials, authorization and evidence, read
[Service execution](../service-execution.md). This protocol does not establish a
particular model's input limits or live capabilities; consult its
[Model guidance](../model-guides.md) and selected definition/mapping.

`vllm-omni-image` is a **Viscraft client contract choice** — the synchronous JSON/
multipart image contract this client implements and expects a configured service
to provide. Viscraft does not host such a service; a self-hosted or remote service
may implement it. It is not a cross-vendor standard.

### 1. The `generate-image` operation

For model-specific parameters and a project-owned definition/mapping, see
[Model integration](../model-integration.md). Image and video extensions use the same
contract; `vllm-omni-image` execution remains synchronous.

`viscraft generate-image <project> <request.json>` runs one Runtime-managed image
generation or editing attempt through a configured image service and registers the
returned image as an **Asset**. It is an independent operation: it needs no video
Placement and no Build, and its result is a reusable image Asset rather than a Take.
The same command has a read-only preflight mode that checks a request without
submitting, writing or touching the network.

The request is a strict object (unknown fields are rejected):

```json
{
  "id": "hero_image_v1",            // stable request id
  "attempt": 1,                     // positive integer
  "asset": "hero_image",            // target Asset id registered on success
  "rights": { "origin": "…", "license": "…", "redistributable": true },
  "operation": "generate",          // 'generate' | 'edit'
  "endpoint": "images",             // non-secret binding key into providers.imageApi
  "model": "a-real-image-model",    // 1..200 chars; creative model identity
  "prompt": "An original …",        // 1..20000 chars
  "references": [],                 // ordered image Asset references; see below
  "size": "1024x1024",              // optional; a zero dimension is rejected
  "seed": 7,                        // optional integer
  "parameters": {}                  // optional, model-owned
}
```

Each reference is `{ asset: 'approved_hero', category: 'image', role: 'identity' }`.
Use the role that describes its purpose, such as `material`, `environment`, `style`
or `composition`; a mask uses `role: 'mask'`. All references must be image Assets.
`edit` requires at least one non-mask reference and permits one optional mask;
`generate` accepts zero or more non-mask references and forbids a mask. The
operation imposes no numeric reference-count limit: a model/service
owns its actual limits. Do not silently discard extra references.

The `vllm-omni-image` adapter sends a request without references to
`POST /v1/images/generations` as JSON, and a request with references to
`POST /v1/images/edits` as multipart, including a reference-conditioned `generate`.
Non-mask inputs become ordered repeated `image` parts; the mask becomes
`mask_image`. The configured service must implement this wire contract; accepting
the authored request does not prove that a particular model supports those inputs.
Roles are recorded with the request and guide the prompt; they do not guarantee
that the model isolates one visual property. Recipes guide creative choices,
without imposing additional Runtime restrictions.

`references[].asset` is a Project Asset id (its existence is checked against the
Project), never a remote URL or raw base64. The request names only the non-secret
`endpoint` binding key; no service address, deployment alias or credential is stored
in authoring state. The operation resolves the binding through the runtime provider
map `providers.imageApi`:

```js
// runtime config: providers.imageApi[endpoint] — the key is the request's `endpoint`
{
  providers: {
    imageApi: {
      images: {                   // request.endpoint === 'images'
        endpoint: { protocol: 'vllm-omni-image', baseUrl, model?, credential? },
        authorization: { submit: true, uploadAssets: ['approved_hero'] }
      }
    }
  }
}
```

The adapter is exported from the public index — `generateImageApi`,
`providerJobStatus`, `ImageApiError`, `ImageApiEndpointSchema`, and the
`ImageApiEndpoint`/`ImageApiOptions`/`ImageApiResult` types — and the operation reaches
it through `providers.imageApi` (`ImageApiOptions`).

### 2. Endpoint, submission and recovery

Image and video generation share one **layered contract**; only the protocol name
and route family differ. The authored input (an image request, or a video Source)
stores a non-secret `endpoint` binding key, and the runtime map supplies the
already-running service. The service may be a
local loopback HTTP service or a user-configured remote HTTPS deployment — a URL
alone does not establish protocol compatibility, and that local-vs-remote choice is
a configuration/authorization matter, **not** a property of the authored request
or Source.

```js
const options = {
  endpoint: {
    protocol: 'vllm-omni-image',
    baseUrl: userConfiguredServiceUrl, // explicit loopback HTTP or remote HTTPS
    // model: 'deployment-model-alias', // optional wire alias, not creative identity
    // credential: 'MY_IMAGE_API_KEY'  // optional named credential (environment or stored)
  },
  authorization: { submit: userAuthorizedSubmission,
    uploadAssets: userAuthorizedAssetIds }
};
// The request names endpoint: 'images'; these options reach the operation as
// providers.imageApi.images, while the read-only preflight uses them without submitting.
```

- **Endpoint binding**: no service address is inferred or scanned, and no endpoint
  or credential is saved in authoring (an image request or a video Source).
  `endpoint.model` is the deployment alias described under
  [model selection](../setup.md#model-selection-and-the-deployment-alias). An
  explicit loopback IP over plain HTTP is accepted, and a user-configured remote
  service must use HTTPS.
- **Credentials stay out of the work**: `credential` is a credential **name**
  (environment variable, else the user's stored value; see [Provider setup](../setup.md)),
  resolved only at the API boundary. The key never enters Project authoring state,
  job records, results, diagnostic errors, an exported/delivered bundle or media
  provenance; records keep a prompt hash and validated URL *paths* only.
- **Submission needs consent, not just a key**: before the request is made, follow
  [SKILL.md spend and upload consent](../../../SKILL.md#spend-and-upload-consent).
  The engine enforces both gates — `authorization.submit === true` **and** every
  transmitted reference/mask Asset id in `authorization.uploadAssets` — before any
  job record or request; a key or a redistributable license is never transmission
  consent.
- **Attempt lifecycle**: a per-attempt exclusive lock refuses concurrent runs, and
  the pre-submit job record is written **before** the request. An ambiguous submit
  (transport error, timeout, 3xx/408/429/5xx, malformed body) becomes
  `submit-unknown` and is **never auto-resubmitted** (there is no verified
  idempotency lookup). Job records store **hashes only** (`promptHash`,
  `requestHash`, `inputSha256`, `outputSha256`), never the prompt text, mask bytes
  or a URL. The produced provider image is retained hash-checked under
  `.viscraft/provider-media/`; a succeeded attempt is re-materialized from those
  bytes without any network.
- **Test mode** (`providers.imageApi.<key>.testOnly: { baseUrl }`) points this
  operation at a loopback fixture and marks every record `simulated`
  ([mechanism](../service-execution.md#test-mode-and-real-execution)).

On success the returned image is registered as an **author-area Asset** under the
requested `asset` id and `rights`, with provenance (provider/model, request hash,
parent-asset hashes and any `simulated` flag). Registration uses the author lock and
a revision conflict check, and the lock is **not** held during inference, so a
parallel edit is never overwritten; a target Asset id that already exists with
different content fails loudly instead of being overwritten. A succeeded request
re-run returns the **same** Asset without calling the service again, and changed
request content must not reuse an old `attempt`. If generation succeeded but
registration did not finish (for example an interrupted process), re-running the
same request completes registration from the retained provider original
**without regenerating**.

### 3. Establish real image capability

`doctor` reports a `realImageProvider` block describing the adapter, transport,
submission authorization and verification status (credential/authorization
readiness lives under `providers.capabilities['image-generation']`, not inside this
block). A registered `/v1/images/*`
route does not prove that the loaded model produces images. Inspect the selected
service's actual model and supported operations, then use an authorized real
request and decode its returned image to establish that capability. A loopback
fixture establishes simulated execution only. If no real image result has been
verified for the selected service/model, report that gap and use another available,
authorized material path when appropriate.

