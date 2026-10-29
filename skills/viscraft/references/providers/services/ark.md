# Ark video v3 — JSON generation tasks

Read [Service execution](../service-execution.md) for authorization and evidence
rules, and [Model integration](../model-integration.md)
for the packaged Endpoint configuration. Authoring syntax and model choices live
in the selected [model guide](../model-guides.md), not in this transport.

`ark-video-v3` is a **Viscraft client contract choice** — the JSON task contract
this client implements for an Ark-compatible video service. It is not a
self-hosted service and not a cross-vendor standard; a configured service must
implement this wire contract.

## Implemented wire contract

An explicit Endpoint selects `protocol: 'ark-video-v3'` and a configured `/api/v3`
base URL. A supplied model/service mapping produces the native JSON body; Runtime
does not infer it from the URL or a model name. For the current Seedance mapping,
`content` carries the author's text plus ordered `image_url`, `video_url` and
`audio_url` entries with native reference/frame roles.

- `POST /contents/generations/tasks` creates a task and returns its `id`.
- `GET /contents/generations/tasks/{id}` reports `queued`, `running`, `succeeded`,
  `failed`, `cancelled` or `expired`.
- A successful `content.video_url` provides the media download. It can be a
  signed HTTPS URL outside the API origin; API credentials are not forwarded.

The packaged mapping's exact native model alias, duration, resolution, ratio and
task parameters belong to that mapping/model, not to all Ark video models.
Additional native fields are not exposed merely because the API documents them.

## Inputs, recovery and records

The current mapping supplies image/audio bytes as data URIs. Reference video
needs an authorized hosted URL or `asset://` locator associated with the frozen
Asset SHA. Runtime checks the association and locator form; the caller must
ensure remote bytes match. Preflight neither publishes media nor downloads a
locator to assert that match.

The shared video executor freezes request/implementation identity and persists
the known task. Pending work resumes with that task; failed/cancelled/expired work
remains terminal. An ambiguous POST is not automatically repeated. Missing result
URLs and failed downloads do not create a fresh generation. A download failure
can refresh the known task's result URL, then download it again. Signed URLs and
recovery details remain private job data, with public status/provenance redacted.

Hash/probe actual returned media before selecting or normalizing a Take; native
request duration is not a guarantee of decoded output frames or accepted sound.
Confirm account access and generation behavior using the selected deployment's
actual result. Primary protocol references:
[create task](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh)
and [get task](https://docs.volcengine.com/docs/ark/get-video-generation-task-api?lang=zh).

## Configure the selected mapping

Use the user's confirmed base URL; the Endpoint itself is per-user setup
([Provider setup](../setup.md)), so every Project can name it. Write the
*canonical* packaged model name (`Seedance-2.5`) on the Source; its definition +
Ark mapping is selected from `(source.model, protocol)`
([model selection](../setup.md#model-selection-and-the-deployment-alias)), so
**no run-options module is required for the model**:

```json
{
  "video": [
    {
      "endpoint": "default",
      "service": "ark",
      "model": "seedance-2.5",
      "deploymentModel": "<your Ark deployment model id>",
      "apiKey": ""
    }
  ]
}
```

The user configuration's `deploymentModel` becomes the SDK Endpoint's wire `model` alias described under
[model selection](../setup.md#model-selection-and-the-deployment-alias): the Source
must name a packaged canonical model (or inject one explicitly). Confirm the
deployment model's availability for this account. Unconfigured `submit`/upload
authorization still goes in a trusted Project-relative module that default-exports
Build options; injecting the packaged extension explicitly is likewise available
and takes precedence, but is optional:

```js
import { seedance25ArkExtension } from 'viscraft-runtime';

export default {
  providers: { videoApi: { default: {
    // Optional: auto-selected when the Source's canonical model is 'Seedance-2.5';
    // an explicit extension always wins.
    extension: seedance25ArkExtension(),
    authorization: { submit: false, uploadAssets: [] }
  } } }
};
```

Import from the actual installed Runtime location if it is not resolvable as a
package in the work directory. Before submitting, follow
[SKILL.md spend and upload consent](../../../SKILL.md#spend-and-upload-consent):
after the user authorizes the run, set `submit: true` and list the approved Asset
IDs in `uploadAssets`. The module never holds a key.

```bash
viscraft plan <project-directory> --config run-options.mjs
viscraft build <project-directory> --config run-options.mjs
```

The CLI loads only the explicitly selected, Project-relative module. It is
trusted executable code, not another Project manifest or an auto-discovered
configuration. The SDK accepts the same options in `planBuild` / `buildProject`.
Build supplies frozen reference Assets; direct `generateVideoService` calls must
supply `references: [{ asset, root }, ...]` covering all declared references.

