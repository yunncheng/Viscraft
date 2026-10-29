# Generation service execution

Use this for authorization, credentials and evidence boundaries shared by the
implemented routes. Model authoring conventions live in [Model guidance](model-guides.md);
adding a route is covered by [Model integration](model-integration.md).

## Implemented service interfaces

Normal setup uses a service and model from [Provider setup](setup.md). Runtime
resolves these to the internal protocols below; they are not additional
user-facing service names. In particular, `vllm-omni` covers both of its interfaces.

| Internal protocol/tool | Contract reference | Scope |
| --- | --- | --- |
| Host image tool | [Generation inputs](generation-inputs.md) and [Media preparation](../runtime/media-preparation.md#2-import-approved-host-tool-material) | Retain and import actual output from the selected host tool. |
| `vllm-omni-image` | [Synchronous image requests](services/vllm-omni.md) | The `generate-image` operation: configured image generation/editing through the implemented JSON/multipart contract, registering the result as an Asset. |
| `vllm-omni-video` | [Multipart video tasks](services/vllm-omni.md) | Defined submission/status/content contract; selected model controls input modes and rules. |
| `minimax-video-v2` | [MiniMax official H3](services/minimax.md) | Native JSON content, task query and result URL; packaged H3 mapping, separate from vLLM-Omni. |
| `ark-video-v3` | [Ark video tasks](services/ark.md) | Native JSON task contract; the packaged model on this protocol is Seedance 2.5. |
| `runway-v1` | [Runway service](services/runway.md) | Real Runway adapter, reached through a `provider` Source whose Endpoint declares this protocol. Executes a model definition + service mapping: a packaged model whose canonical name the Source carries (`gen4.5` or `gen4_turbo`), or a matching caller `extension` (a mismatched one is rejected before any request). |
| `fal-queue` | [fal service](services/fal.md) | Real fal queue adapter, reached through a `provider` Source whose Endpoint declares this protocol. Executes a model definition + service mapping: a packaged model whose canonical name the Source carries (`alibaba/wan-3.0/image-to-video`), or a matching caller `extension` (a mismatched one is rejected before any request). |

Use the configured service/model and the actual account/deployment. SDK adapter
integrations must implement the corresponding protocol. A model ID, API key or
familiar URL shape alone does not enable an unsupported route.

## Reporting levels

The four levels of conclusion are defined once in
[SKILL.md → Report honestly](../../SKILL.md#report-honestly-real-vs-simulated);
they are not interchangeable, and a result only supports the level it actually
reached. Consequences for this page:

- A pure Code/Media work (including authored SVG/Canvas) is a **real
  creative product**: `artifact.simulated === false`, and it can be delivered
  directly.
- The `simulated` / `test-only` source (`doctor`'s `simulation` field) exists only
  to exercise the submit/task-status/failure-recovery/compose/mix control chain.
  It is **not** a real generative model and **must not** be used to claim photoreal
  quality or that a flagship film passed. Any Take/clip/Result with simulated
  input propagates the `simulated` marker along its dependencies.
- **Do not fabricate when no real video provider is configured**: do not advertise
  generation capability, duration tiers, cost or success rates that do not exist.
  To extend into photoreal shots, say honestly that the user must provide a real,
  authorized provider.

The `simulated` Source shape is `{ id, kind: 'simulated', prompt, frames, seed,
attempt, behavior: 'success' | 'fail' | 'submit-unknown' | 'download-fail-once' }`
and is intended for contract tests only. It is a separate, test-only kind — **not**
one of the three authoring executors (`browser`/`blender`/`provider`) — and it
carries **no** `output` field.

## Direct the request before adapting it to a provider

[Creative method](../craft/creative-method.md#direct-generated-images-and-passages)
owns shared image/video direction. [Model guidance](model-guides.md) routes to the
selected model/version's prompt conventions and supported modes. Use those with
the selected service contract; neither a prompt nor a model name alone
establishes support. Runtime transports the author's prompt without rewriting it.

## Credential handling across the provider adapters

Every adapter resolves keys the same way; every claim below is the implemented
contract. User-side setup (and the agent's rules) are in [Provider setup](setup.md).

- **User configuration**: private `endpoints.json` or `VISCRAFT_VIDEO_` /
  `VISCRAFT_IMAGE_` environment variables select a supported service and model.
  Runtime resolves them to a non-secret execution Endpoint and credential name.
  JSON may contain an `apiKey`; agents use sanitized status rather than reading it.
  The exact fields, environment precedence and file permissions are in
  [Provider setup](setup.md). Authorization is never read from configuration.
- **Named credentials at the adapter boundary**: SDK Endpoints reference a name;
  the value resolves from its environment variable, the matching private user
  configuration, or an owner-private stored credential. Runway/fal/native MiniMax
  have conventional SDK names. Public user configuration supplies its own stable
  connection-specific name; secret values do not enter provider options or Projects.
- **Endpoints are per user**: named connections are reused across works. An
  explicit trusted SDK Endpoint overrides a user connection for that run. Model
  definitions and mappings remain mandatory where the service requires them.
- **Never persisted**: not in Project authoring state, job records, results, or an
  exported/delivered bundle (those are assembled from the Portable manifest and the
  active artifact). Records keep a prompt hash and validated URL *paths*, never the
  key, prompt, data URI or URL.
- **Header-only**: the key travels only in `Authorization` (`Bearer …` Runway,
  `Key …` fal, optional `Bearer …` for video API) and is never forwarded to an
  unrelated media host; `vllm-omni-video` fetches same-origin content; Ark downloads validated signed result URLs
  without forwarding the API credential. Any URL carrying userinfo is
  rejected; fal also rejects a returned queue URL with a query/fragment (a signed
  query would be an auth secret).
- **Missing keys fail before network**: the vendor protocols (`runway-v1`,
  `fal-queue`) always require their credential; the generic transports require one
  only when `credential` is set. Plan reports a missing Endpoint or credential as
  `needsConfiguration` with the user-side remedy; submission authorization is
  independent.
- **Authorization ≠ authentication**: a key alone never submits anything —
  `authorization.submit === true` is required, and transmitting a reference Asset
  additionally requires that Asset id in `authorization.uploadAssets`. A
  redistributable license is NOT upload consent.
- **Test/mock paths never read the real key**: a loopback fixture uses either
  no credential or a fixed non-secret placeholder, and every record is `simulated`.
- **Consent comes from the user, not from a file**: writing `submit: true` and
  listing `uploadAssets` is not itself consent. Follow
  [SKILL.md → Spend and upload consent](../../SKILL.md#spend-and-upload-consent)
  before writing `submit: true` for a provider that can bill the user or move their
  media off the machine; never preauthorize it in a committed example or reusable
  script. Tell the user which media leaves the Project directory.

## Test mode and real execution

An Endpoint may carry `testOnly: { baseUrl }` (video: `providers.videoApi.<key>`;
image: `providers.imageApi.<key>`). It points that adapter at a loopback HTTP
fixture, bypasses the submit gate, never reads or forwards the real credential,
and marks every dependent record `simulated`. It exercises the real HTTP shape,
media processing, recovery and provenance — not a model, a paid account or
generation quality; never infer live capability from it. Each protocol page
documents the field on its own lane
([vllm-omni-image](services/vllm-omni.md#2-endpoint-submission-and-recovery),
[vllm-omni-video](services/vllm-omni.md#recovery-and-provenance),
[Runway](services/runway.md#test-mode-and-real-execution),
[fal](services/fal.md#test-mode-and-real-execution)); what a simulated result may
claim is in [SKILL.md → Report honestly](../../SKILL.md#report-honestly-real-vs-simulated).
