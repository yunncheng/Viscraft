# fal service — queue endpoint, credentials and task execution

Use this for a fal account: how a `provider` Source reaches it, the
`fal-queue` transport, credentials, submission authorization and recovery. Model
choices, parameters and creative guidance live on the model page
[Wan 3.0](../models/wan-30.md). Shared authorization and
evidence rules are in [Service execution](../service-execution.md).

## Protocol and adapter

`fal-queue` is a **Viscraft client contract choice**: the name of the queue
transport and task lifecycle Viscraft's fal adapter speaks. It is not a
self-hosted service and not a cross-vendor standard — a host agent should not
expect another tool to accept the same identifier.

The fal **queue** adapter executes the binding's model definition and mapping, with
`wan30FalExtension()` packaging the Wan 3.0 model, and no SDK runtime dependency.
It is authored through the media-typed
[`provider` Source](../model-integration.md#responsibilities); the
Endpoint's `protocol: 'fal-queue'` selects the adapter. Without an `extension`,
when the Source's canonical `model` is `alibaba/wan-3.0/image-to-video`, it
selects the packaged Wan 3.0 definition + mapping (never the optional deployment
alias `endpoint.model`); a caller-supplied `extension`
whose protocol/model matches is accepted and wins, and one that does not match is rejected
before any request.

The queue submit/status/result/cancel paths are derived from the mapping's
endpoint id (its route facet), not a hardcoded literal — the persisted job records
that endpoint id so recovery and cancel use the same route. A fal mapping must
declare its `endpointId` route facet in addition to the shared `ServiceMapping`
fields. Plan and Produce run the same definition + mapping validation, and a
mapping's implementation files participate in the operation identity.

Minimal authorized call through `buildProject` (Build freezes the Project,
resolves every declared image reference and injects the matching
`references: [{ asset, root }]` entries itself, so the caller only supplies
authorization):

```js
await buildProject(root, {
  providers: { videoApi: { fal: {
    endpoint: { protocol: 'fal-queue', baseUrl: 'https://queue.fal.run' },
    authorization: { submit: true, uploadAssets: ['approved_hero', 'approved_tail'] }
  } } }
});
```

Direct `generateVideoService(root, source, output, destination, options)` callers
on the `fal-queue` protocol must supply `references: [{ asset, root }]` for every
referenced image.

## Service subset

The `fal-queue` **transport** carries IMAGE references (any role) as base64 data
URIs and expects a `{ video: { url } }` result; the selected mapping decides which
inputs that means. The packaged Wan 3.0 mapping requires a first frame and accepts
an optional last frame, so that model is image-to-video only; a caller-supplied
text-to-video mapping with no required image reference runs through the **same**
adapter. The transport does **not** implement video reference, video editing,
hosted upload or idempotency-key lookup (`viscraft doctor` reports these as false);
a declared video/audio reference, or any reference form the queue mapping cannot
encode, is refused before any upload. Model-side parameters belong to
[Wan 3.0](../models/wan-30.md).

The submit/status/result/cancel routes are derived from the selected mapping's
`endpointId` route facet, not from a literal in the adapter. Explicitly bound
`extension` can provide another model definition and request mapping on this same
protocol. Check the selected service's actual model availability before relying
on its output for a work.

## Credentials

- **Auth header**: `Authorization: Key <FAL_KEY>` (verified against the MIT
  `@fal-ai/client` reference, commit `9657065ca274910827667140e1923f5c2be2b281`,
  `1.11.0-alpha.0`). The adapter prepends `Key `, so `FAL_KEY` must be the **bare
  key with no `Key ` prefix**. The Endpoint's named `credential` (default `FAL_KEY`)
  resolves from the environment, else from the user's stored value (see
  [Provider setup](../setup.md)); the key is never persisted. Default request headers are
  `Accept: application/json`.

## Submission authorization

Before submitting, follow
[SKILL.md spend and upload consent](../../../SKILL.md#spend-and-upload-consent).
The engine requires `authorization.submit === true` **and** a key; additionally
**each transmitted image reference** must be listed in
`authorization.uploadAssets`. The gate runs before any job record or network call.
These are only capabilities of the implementation — they are not account
entitlement, pricing, quota or availability, and `doctor` reports
`accountAvailability` as `unknown`.

## Reference images

The only accepted images are caller-provided Assets re-validated with
`AssetSchema`, read from their frozen root, matched to the recorded `sha256`, and
PNG/JPEG **by signature** (SVG and other formats are refused, never converted).
Raw bytes are capped at 3.5 MiB, the base64 data URI at 6 MB, and the encoded
payload is re-hashed after base64 encoding. Images are sent as
`data:image/png;base64,…` / `data:image/jpeg;base64,…` file inputs (fal documents
base64 data-URI file inputs). Nothing is fetched, generated or substituted.

## Queue protocol

`POST /<mapping endpointId>` → `{ status: IN_QUEUE|IN_PROGRESS|COMPLETED,
request_id, status_url, response_url, … }`; `GET …/requests/{id}/status` for status
and `GET …/requests/{id}` for the raw result `{ video: { url }, seed, duration }`.
For the packaged model the route facet is `alibaba/wan-3.0/image-to-video`. When
present, the returned `status_url`/`response_url` are preferred after validating
each for origin pin, a path bound to the request id and its **role** (the status
URL must end `/status`, the result URL must not), rejecting any query/fragment;
both the full `<endpointId>/requests/{id}[/status]` paths and the shorter form the
vendor SDK returns are accepted, with the full official paths as fallback. The
default base is `https://queue.fal.run`; an Endpoint `baseUrl` overrides it, and
the queue paths are relative to that whole base.

## Job lifecycle and records

- The pre-submit record is written **before** the network call; an ambiguous
  submit (transport error, malformed body, 3xx/408/429/5xx, unusable queue URL)
  becomes `submit-unknown` and is **never auto-resubmitted** — no idempotency-key
  lookup is verified for this endpoint. A known request gets at most **one status
  GET per invocation** (≥5 s apart, persisted; bypassed in test mode) and one
  result GET. A per-attempt lock refuses concurrent runs, and the frozen request
  hash binds mode / base / source / output / images so a changed request under the
  same attempt is rejected. A failed download resumes the deterministic content
  path without regenerating.
- **Result and records**: the adapter reads the raw model output
  `{ video: { url }, seed, duration }` (no SDK `{ data, requestId }` wrapper) and
  downloads `video.url`. Provenance is
  `generation = { provider: 'fal', model, taskId, requestHash, originalSha256,
  originalMedia?, references? }` with **no cost fields** — fal reports none, so
  none is invented. The key is never persisted; records store a prompt hash and
  validated URL *paths* (never the prompt, data URI or URL). Original media is
  retained (probe + hash) and normalized via `normalizeMedia`; downloads are capped
  (100 MiB) and guarded (production HTTPS, no userinfo, no loopback/private host,
  manual redirects; test same-origin loopback), with no credentials forwarded to
  the media host. That host check is best-effort, not a sandbox. `providerJobStatus(root)`
  (surfaced by CLI `status`) lists persisted, validated records, including those
  under `.viscraft/jobs/fal/`; unsafe/invalid records are skipped.
- **Cancel**: `cancelFal(root, attempt, options?)` cancels a job that is still
  `submitted` with exactly **one** `PUT …/requests/{id}/cancel` (202
  `CANCELLATION_REQUESTED` → the record becomes terminally `cancelled`;
  `ALREADY_COMPLETED`/`NOT_FOUND` and transport/auth failures are loud errors,
  never a fake success). It never resubmits and does **not** un-bill an already
  in-progress generation.

## Test mode and real execution

An Endpoint with `protocol: 'fal-queue'` plus `testOnly: { baseUrl }` points the
adapter at a loopback HTTP fixture, sends a fixed non-secret `Key fixture` and marks
every record `simulated`
([mechanism and limits](../service-execution.md#test-mode-and-real-execution)).
Only with a real account, key and explicit authorization does this run a real
(billable) generation. Do not claim a real generated clip passed.
