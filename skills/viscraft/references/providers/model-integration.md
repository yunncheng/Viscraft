# Model integration — definitions, mappings and authoring guidance

Use this reference when connecting an additional image/video model or service.
For consent and production decisions, read [Service execution](service-execution.md). For host
image tools and approved material, read [Generation inputs](generation-inputs.md).
For prompt conventions and official model guidance, read
[Model guidance](model-guides.md).

## Responsibilities

A `provider` Source stores the author's model identity, operation, ordered
Asset references, prompt and optional `parameters`; the separate `generate-image`
operation stores the same fields (model identity, `operation`, ordered `references`,
prompt and optional `parameters`) in its request.
A `GenerationExtension` contains a model definition, one service mapping and
`implementationFiles`:

`GenerationExtension` is the TypeScript interface name for this explicitly supplied
definition/mapping bundle; it does not imply a plugin platform or extra workflow.

- The model validates parameters and cross-field/media rules. Use a strict Zod
  schema; unknown parameters should fail rather than disappear on the wire.
- The mapping validates the selected service's subset and translates fields.
  Image mappings return scalar `imageFields`; video mappings return `videoBody`.
  An optional mapping `validateReferenceSet(source, facts)` checks service-specific
  input limits using the same measured facts as the model's reference validator.
- The Endpoint supplies the implemented protocol, base URL, wire model alias,
  credential name (resolved from environment, private user JSON or stored credentials) and optional model-owned SDK settings. This is an adapter contract, not the user JSON format. Public setup uses service/model/url/apiKey and an optional deploymentModel; see [setup](setup.md).
- Runtime owns authorization, frozen input hashes, task persistence, recovery,
  output validation and Build/Take provenance.

Both media use the same extension interface. Execution follows the actual
protocol: `vllm-omni-image` is synchronous; `vllm-omni-video`, `minimax-video-v2`
and `ark-video-v3` are asynchronous. A new wire contract needs an adapter even when
the model is already supported through another service. Native H3 is documented in
[MiniMax official video](services/minimax.md).
Runway and fal are asynchronous protocol adapters selected by a
`provider` Endpoint's protocol (`runway-v1` / `fal-queue`). They also
execute the definition and mapping contract. A binding may supply `extension`
(which wins); without one, the packaged definition whose canonical
`(model, protocol)` matches the Source is selected automatically. Which models are
packaged, and how an Endpoint's deployment alias relates to that choice, is in
[Provider setup](setup.md#model-selection-and-the-deployment-alias).
Model and mapping must match the authored Source (or image request) and selected protocol. Services
retain their real authentication, route, task and download rules; a definition
does not add an unsupported wire capability or prove live model quality.
An unfamiliar URL/model name does not establish a supported protocol or capability.
Adding a model on a supported protocol needs a definition and mapping. A different
HTTP/task protocol requires Runtime adapter support; it cannot be enabled by a
project mapping. Use an available supported route or host tool, or treat the new
adapter as separate Runtime development.

`planBuild` and execution use the same model/service validators. Validators must
be deterministic and read-only. Do not perform network calls, uploads or billing
inside an extension. Put deployment choices in Endpoint settings rather than
hidden mutable environment state or closures. Declare absolute implementation
files covering the extension and its local dependencies; Runtime hashes their
actual bytes and loaded handlers. A version string is not implementation evidence.

For a video mapping that must resume a submitted task after reference files are
unavailable, define a deterministic `requestIdentity` from the request fields
and reference identities (including roles and hashes), without media bytes,
credentials or temporary paths. Where the protocol derives identity from a
mapping body instead, `identityBody` can supply the same non-media fields as
`videoBody`. Runtime resumes only when it can reproduce and match the recorded
request identity; otherwise it stops safely rather than submitting again.

## Select an implemented route

Read [Model guidance](model-guides.md) for the selected model/version. A packaged
model is selected by the Source's canonical name; injecting an `extension` is for
overriding that choice or for a model with no packaged definition (for example
`seedance25ArkExtension()` for `Seedance-2.5`). A Source, native parameters and
limits are documented in the [Seedance model guide](models/seedance-25.md#runtime-request),
with [Ark configuration](services/ark.md#configure-the-selected-mapping).
Use the actual installed Runtime in your dependency context. CLI
`plan/build <project-directory> --config <project-relative.mjs>` explicitly loads
trusted Build options; the SDK accepts the same options. Neither entry performs
automatic service discovery or expands submission/upload authorization.

## A project-owned image model on `vllm-omni-image`

Install/use Zod in the authoring module's actual dependency context. This is a
minimal executable mapping pattern; replace the illustrative model/service rules
with documented and verified ones. No model quality is implied by this example.

```js
// image-model.mjs
import { z } from 'zod';
import { fileURLToPath } from 'node:url';

export const imageExtension = {
  implementationFiles: [fileURLToPath(import.meta.url)],
  model: {
    id: 'My-Image-Model', medium: 'image',
    parameters: z.object({ quality: z.enum(['fine', 'draft']) }).strict(),
    validate(request) {
      if (request.operation !== 'generate')
        throw new Error('This route supports generation only');
    }
  },
  mapping: {
    model: 'My-Image-Model', protocol: 'vllm-omni-image',
    validate(_request, parameters) {
      if (parameters.quality !== 'fine')
        throw new Error('This service supports fine quality only');
    },
    imageFields(_request, parameters) {
      return { quality: parameters.quality === 'fine' ? 'high' : 'low' };
    }
  }
};
```

Bind `extension: imageExtension` under `providers.imageApi.images`, with the
confirmed `endpoint: { protocol: 'vllm-omni-image', baseUrl, model, credential }` and
authorization. Write a `generate-image` request naming `endpoint: 'images'`,
`model: 'My-Image-Model'`, `parameters: { quality: 'fine' }` with the other normal
[generate-image request fields](services/vllm-omni.md#1-the-generate-image-operation).
Mappings cannot overwrite the common model, prompt, input media or response-format
fields. For video, use the same interface with `medium: 'video'` and `videoBody`.

Changing a used definition/mapping file invalidates its operation identity.
Changing a frozen request under the same attempt is refused; it does not silently
charge again. Create a new authorized attempt only when intentionally requesting
new generation. An unused Endpoint extension does not invalidate an accepted Take.

## Complete a model integration

Keep a project-owned integration and its authoring notes beside the Project's
trusted module. Do not edit the installed Skill or Runtime to complete a creative
task. Check these points for an image model, video model or exposed editing route:

1. Identify the exact model/version and primary model, prompt and service docs.
   Link the official guide and record the date you checked it, then separate the
   upstream capability, the route this client implements and what you have actually
   verified.
2. Implement strict parameters, operations and material rules in the definition;
   implement the service subset and actual wire mapping. Confirm that the
   installed Runtime implements the required protocol before proceeding.
3. Record the model's authoring guidance with the project-owned integration.
   Explain when to choose its modes, reference labels, prompt/sound conventions,
   useful settings and limitations. Keep that model's own tokens, counts and
   settings on its model page: a craft or workflow page explains the shared
   mechanism and links here rather than restating them.
4. Verify ordinary Plan/Produce with genuine small media and simulated API when
   live access is unavailable: no POST for invalid requests, prompt/media order
   preserved, decoded results and recovery without duplicate submission. State
   what was simulated. Do not enforce prose templates as rigid schema rules.
5. Validate real behavior only when authorized and available. Publish an observed
   recipe or reviewed example only with actual input/request/result provenance,
   reproduction conditions and review/rights scope. Official guidance is useful
   before this step; it must not masquerade as a successful local experiment.

The host agent chooses and adapts the prompt. Do not hide a prompt prefix, an
extra chat-model call, automatic Skill installation or provider substitution in
the mapping. Keep reusable creative helpers as ordinary Project files; a mapping
translates the protocol rather than making hidden creative decisions.
