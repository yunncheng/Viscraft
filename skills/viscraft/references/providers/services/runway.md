# Runway service — endpoint, transport and task execution

Use this for the Runway account: how a `provider` Source reaches it, the
`runway-v1` transport, credentials, submission authorization and recovery. Model
choices, parameters and creative guidance live on the model pages:
[gen4.5](../models/gen45.md) and [gen4_turbo](../models/gen4-turbo.md). Shared
authorization and evidence rules are in
[Service execution](../service-execution.md).

## Protocol and adapter

`runway-v1` is a **Viscraft client contract choice**: the name of the transport
and task lifecycle Viscraft's Runway adapter speaks. It is not a self-hosted
service and not a cross-vendor standard — a host agent should not expect another
tool to accept the same identifier. Runway is authored through the media-typed
[`provider` Source](../model-integration.md#responsibilities); there is
no per-vendor Source kind.

The adapter executes a **model definition + service mapping** contract (the same
`GenerationExtension` interface every provider uses). Without an `extension` it
selects the packaged definition matching the Source's canonical `model` —
`gen4.5` or `gen4_turbo` — never the optional deployment alias `endpoint.model`. A
caller-supplied `extension` whose protocol/model matches is accepted and wins; one
that does not match is rejected
before any request. Plan and Produce run the same definition + mapping
validation, and a mapping's implementation files participate in the operation
identity, so editing a mapping invalidates a previously accepted Take.

Endpoint declaration:

```js
{
  id: 'candidate_a', kind: 'provider', output: 'picture', endpoint: 'runway', model: 'gen4.5',
  prompt: 'An original vehicle on a mountain road', mode: 'text', references: [],
  requestedFrames: 96, size: '1280:720', fps: 24, attempt: 'original-attempt-a',
  parameters: { durationSeconds: 4, ratio: '1280:720' }, seed: 7
}
```

```js
await buildProject(root, {
  providers: { videoApi: { runway: {
    endpoint: { protocol: 'runway-v1', baseUrl: 'https://api.dev.runwayml.com' },
    authorization: { submit: true }
  } } }
});
```

## Service subset

The Runway adapter implements **text-to-video** and an **optional single
first-frame image** (a Source reference with role `first-frame`). It maps to
`POST /v1/text_to_video` or `POST /v1/image_to_video`, then polls
`GET /v1/tasks/:id`. It does **not** implement tail frames, video references, a
hosted upload service, continuation or generative editing. Never pretend it does.
A Source that declares any other reference form — a last frame, an identity or
other image role, a video or audio reference — is refused by the shared request
preparation on Plan, Build and the direct SDK **before any upload**, never
silently dropped.

Model-side parameters, ratios and prompt limits belong to the selected model —
see [gen4.5](../models/gen45.md) and [gen4_turbo](../models/gen4-turbo.md). This page
owns the address, credential, route and task lifecycle.

## Credentials

Secrets stay outside Project authoring state and exports. The Endpoint's named
`credential` (default `RUNWAYML_API_SECRET`) resolves from the environment, else
from the user's stored value; see [Provider setup](../setup.md). The key travels only in an `Authorization: Bearer …`
header, is never persisted (not in Project authoring state, job records, results
or an exported/delivered bundle), and is never forwarded to an unrelated media
host. A configured blank/missing reference is an error. `status` lists redacted
Runway jobs without reading or printing credentials.

## Submission authorization

A key alone never authorizes generation; before submitting, follow
[SKILL.md spend and upload consent](../../../SKILL.md#spend-and-upload-consent).
The engine requires `authorization.submit === true`, and transmitting a reference
Asset additionally requires its id in `authorization.uploadAssets`; the adapter
refuses before any POST otherwise. Do not set `submit: true` proactively or infer
approval from a key.

The ordinary CLI `build` does not authorize new paid submissions. Use the SDK or
`build <dir> --config <project-relative.mjs>` to pass provider options after user
authorization.

## First-frame image conditioning

Declare a Source reference with role `first-frame` naming an existing Project
`image` Asset ID — not a remote URL or raw base64 string. Build freezes the actual
Asset and includes its hash in the Source identity. The adapter currently accepts
only PNG/JPEG signatures, with a raw-byte cap of 3.5 MiB and a complete data-URI
cap of 5 MB; it does not silently convert SVG/WebP or claim every image is
decodable from its signature alone. Sending those pixels in a data URI is still an
upload, so it needs the upload authorization above. Job and Artifact provenance
record the reference image ID/hash, never its base64 bytes; the data URI stays in
memory only. Changing the reference or its content needs a fresh explicit attempt,
not reuse of the old frozen request.

## Task lifecycle and recovery

The adapter sends one POST, persists the returned task ID, and performs at most
one status GET per invocation. Pending/temporary query states are resumable:
consult `status`, wait until `nextQueryAt`, then rerun the same attempt; real GETs
are rate-bound to at least five seconds. A Build can record a recoverable pending
failure while keeping the previous Result intact; that is not permission to
create a new attempt. An ambiguous submission becomes `submit-unknown` and
**never automatically resubmits** — no idempotency-key lookup is verified for
Runway, so replacing it requires the host's explicit decision about duplicate
billing risk. A failed download/normalization resumes the known task or retained
original bytes, not a new generation. Remote cancelled/failed tasks remain
terminal; reported final credits may be nonzero and unreported costs remain
unknown.

The original downloaded MP4/probe/hash and local state stay under
`.viscraft/provider-media/` and `.viscraft/jobs/runway/`. Artifact `generation`
retains portable provider/model/task ID/request hash/original hash and reported
credits, never signed download URLs or credentials. Downloads do not forward API
authentication. URL checks are best-effort preflight, not a network sandbox. A
stale attempt lock requires inspection; do not remove an active lock to bypass
duplicate-submit protection.

## Test mode and real execution

An Endpoint with `protocol: 'runway-v1'` plus
`testOnly: { baseUrl: '<actual-loopback-fixture-origin>' }` points the adapter at a
local HTTP fixture and labels every dependent Take/Artifact/Result `simulated`
([mechanism and limits](../service-execution.md#test-mode-and-real-execution)).
Do not invent a production endpoint based on a test server; a real generation
needs a real account, key and explicit user authorization, and only the returned
Take supports a claim about generation.
