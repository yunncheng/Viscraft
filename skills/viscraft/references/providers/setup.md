# Configure image and video services

Save your image and video service settings once, using **a private JSON file** or
**environment variables**. You can configure these before installing the Runtime
or starting a work.
The host's suitable, authorized image tool is checked first; configure a separate
image service only when useful. Code, imported media and Blender work need no
model key.

## Rules for the agent

- Never ask for API keys in chat, inspect the user's configuration file, dump the
  environment, or print key values. A JSON file can contain secrets. Use
  `viscraft auth status` or `doctor` for the sanitized configuration and supported
  service/model choices. Explain the missing fields and point to the user steps.
- Resolve the actual Runtime entry using [Startup checks](../runtime/preflight.md#locate-the-runtime-for-this-work)
  before running diagnostics; the user does not need to locate it or run these
  commands. Use the reported `sourceModel` as the exact model identity in authored
  requests. An installed Skill alone does not supply a callable Runtime.
- The user enters keys in their own editor or terminal. If a key is pasted into
  chat, do not copy it into commands or files; explain that it is exposed and
  should be replaced.
- Service/model selection is deterministic. Do not guess a protocol from a port,
  URL, key or family name; do not scan model folders or deployments. Unsupported
  combinations require an explicit integration, not a guessed name.
- Configuration is not spend or upload consent. Follow
  [Spend and upload consent](../../SKILL.md#spend-and-upload-consent). Do not submit
  generation or upload media to discover whether setup works.
- If the user declines setup, explain the capability difference once and continue
  with the suitable available tools. Do not silently change a first-frame request
  into reference generation, or change account/service to make a request work.

## Get help from your agent

The user can start with their creative idea. If a necessary service is missing,
explain what it would enable and direct them to the private JSON or environment
steps below. The agent can explain supported choices, URLs and deployment model
ids using non-secret documentation; it does not need to handle the key or edit a
potentially secret-bearing user file. Viscraft connects to running services and
does not deploy models.

## Setup steps for the user

Choose your service below, then save its settings using either method. The agent
can check them when you start creating.

**1. Choose a supported service and model.** These are configuration values,
not arbitrary display names. Leading/trailing spaces and letter case are
normalized; other spellings are rejected with the supported choices.

| Service | Model to enter | What this route provides |
| --- | --- | --- |
| `vllm-omni` | `minimax-h3-base-ref2va` | Private H3 Base Ref2VA: reference generation |
| `vllm-omni` | `minimax-h3-base-fl2va` | Private H3 Base FL2VA: text or first/last frames |
| `minimax` | `MiniMax-H3` | Official H3 service: text, first/last frames or references |
| `ark` | `Seedance-2.5` | Seedance through Ark; copy your deployment model id into `deploymentModel` |
| `runway` | `gen4.5` or `gen4_turbo` | Runway; the selected model owns its input limits |
| `fal` | `alibaba/wan-3.0/image-to-video` | Wan through the fal queue |
| `vllm-omni` | `Qwen/Qwen-Image` | Original Qwen text-to-image model |

Copy the model identifier from the table, including any slashes or version suffix.
`Qwen/Qwen-Image` identifies the original text-to-image model; other releases and
editing models need their own supported entry. For the service examples, see
[fal's API](https://fal.ai/models/alibaba/wan-3.0/image-to-video/api) and
[vLLM-Omni's Qwen guide](https://docs.vllm.ai/projects/recipes/en/stable/Qwen/Qwen-Image.html).

Use `vllm-omni` for both supported image and video deployments. Each connection
uses its own service address, which may differ between models.

**2. Choose JSON or environment variables.** Both are parsed into the same
connections. Each entry declares a user-chosen `endpoint` name. The template
uses `endpoint: "default"` for one video connection. `video` and `image` are lists,
so multiple services or deployments each have their own entry.

### Private JSON file

Save the [JSON template](templates/endpoints.json) at the location for your system,
creating its parent folder if needed:

| System | Configuration file |
| --- | --- |
| Linux / macOS | `~/.config/viscraft/endpoints.json` |
| Windows | `%APPDATA%\viscraft\endpoints.json` |

If you set `XDG_CONFIG_HOME` on Linux/macOS, use its `viscraft/endpoints.json`
instead. `VISCRAFT_CONFIG_HOME`, when set, selects the configuration folder on
either system. Keep this file outside your work folders and preserve existing
connections when adding another.

```json
{
  "video": [
    {
      "endpoint": "default",
      "service": "vllm-omni",
      "model": "minimax-h3-base-ref2va",
      "url": "http://127.0.0.1:8000",
      "apiKey": ""
    }
  ],
  "image": []
}
```

**How to read this template:**

| Entry | Meaning |
| --- | --- |
| `endpoint` | Your connection name, for example `default` or `h3_reference`. It must be unique within its list: lowercase letters, digits and underscores, starting with a letter, up to 32 characters. |
| `service` | A supported service identifier from the table above. |
| `model` | A supported model identifier from the table above. |
| `url` | The actual service address. |
| `apiKey` | Your private account/service key, when required. |
| `deploymentModel` | For Ark, the model/deployment ID from your account. Also used when a private service publishes your selected model under a different name. |

A video request with `endpoint: "default"` selects the entry in `video` with that
same `endpoint` value. Add another object to the list to configure a different
connection; the agent references its `endpoint` in the same way. The image list
uses the same fields and may independently contain an endpoint named `default`.
Renaming an endpoint requires updating its request references and named
environment variables. The order of entries does not select a default model.

The short `VISCRAFT_VIDEO_*` and `VISCRAFT_IMAGE_*` environment variables each
configure their own `endpoint: "default"`. Other names use the named
prefixes described below. JSON files do not support comments; keep the template
as valid JSON and use this guide for its field explanations.

Edit `service` and `model` using the table. Official services have default URLs,
so `url` may be empty or omitted. A **Private deployment** needs its actual URL;
`127.0.0.1` is the machine running the agent, and remote services require HTTPS.
For a private deployment, select the supported `vllm-omni` service and the model
that is actually running there.

`apiKey` is **optional only when your private service does not enable API-key
authentication**. Leave it empty or omit it in that case. Official services
require their account key. Enter keys in your own editor, never chat.
Before putting a key into the JSON, restrict the file to your user on Linux/macOS
(`chmod 600 <configuration-file>`); Runtime refuses a key-bearing file readable
by other users. On Windows restrict access using the file's security settings;
Viscraft does not implement a Windows ACL validator. Keys are stored in plaintext,
not an encrypted vault; an agent running as your OS user is not technically isolated.

For Ark, additionally set `"deploymentModel": "<id from your Ark account>"`.
For other services, leave it out unless your selected model is served under a
different name.
For an image service, add an entry with the same fields to `image`; use
`"model": "Qwen/Qwen-Image"` for the supported original Qwen text-to-image route.
A separate service URL may be needed for images. Remove unused connections
rather than leaving placeholders.

### Environment variables

In your own Bash terminal, a private video deployment uses:

```bash
export VISCRAFT_VIDEO_SERVICE=vllm-omni
export VISCRAFT_VIDEO_MODEL=minimax-h3-base-ref2va
export VISCRAFT_VIDEO_URL=http://127.0.0.1:8000
```

For official MiniMax, use `minimax` and `minimax-h3`, and omit the URL. For Ark,
use `ark` and `seedance-2.5`, plus
`export VISCRAFT_VIDEO_DEPLOYMENT_MODEL='<id from your Ark account>'`.
If authentication is enabled, enter the key without writing it in shell history:

```bash
read -rsp 'API Key: ' VISCRAFT_VIDEO_API_KEY
export VISCRAFT_VIDEO_API_KEY
```

PowerShell uses the same variable names:

```powershell
$env:VISCRAFT_VIDEO_SERVICE = 'vllm-omni'
$env:VISCRAFT_VIDEO_MODEL = 'minimax-h3-base-ref2va'
$env:VISCRAFT_VIDEO_URL = 'http://127.0.0.1:8000'
$env:VISCRAFT_VIDEO_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'API Key' -AsSecureString)).Password
```

Skip key entry for a private service without authentication. Use `VISCRAFT_IMAGE_`
for the default image connection. Other named connections use
`VISCRAFT_VIDEO_<NAME>_` or `VISCRAFT_IMAGE_<NAME>_` with the same suffixes; for
example `VISCRAFT_VIDEO_KEYFRAMES_MODEL` configures the video entry named `keyframes`.
Names use lowercase letters, digits and underscores in JSON, uppercase in environment variables.
Use distinct connection names: if a variable could address two connections (for
example `story`'s `DEPLOYMENT_MODEL` and `story_deployment`'s `MODEL`), configuration
reports the ambiguity. Rename one connection instead of guessing the destination.

Nonempty route variables (`SERVICE`, `MODEL`, `URL`, `DEPLOYMENT_MODEL`) replace
that **whole named JSON connection**: supply SERVICE and MODEL together, and URL
when private. They do not inherit the old route's file key. A key-only environment
override keeps the JSON route. Empty variables do not override it. Launch your
agent from this terminal so it inherits the variables; changing a separate
terminal does not change an already-running agent. Environment values are not
isolated from a same-user agent either.

**3. Ask your agent to check configuration.** For example:

```text
Check my Viscraft model configuration and explain any missing settings without showing API keys.
```

The agent locates or prepares the matching Runtime and checks its sanitized
status. This checks the saved settings without contacting a service or starting
generation. It does not establish that the service is reachable or that an
account has access to the selected model. Any further availability check or real
generation remains subject to your permissions.

## Model selection and the deployment alias

`model` selects a supported model from the table. `deploymentModel` supplies the
account or deployment name for that same model when needed. For example, an Ark
connection selects `Seedance-2.5` and supplies the ID from the account in
`deploymentModel`. Keep the supplied spelling and case of that deployment ID.
Changing it does not add support for a different model or a new operation.

## What this protects, and what it does not

User configuration and keys stay outside Projects and deliveries. The normal
status and doctor paths return sanitized facts. This is not a key-isolation
boundary against programs running as the same OS user. Never include the user
configuration file in a work, Git repository or shared archive. Configuration does
not authorize spending or material uploads, and Runtime does not impose a hard
monetary cap. A suitably implemented gateway can hold the upstream key and enforce
budgets; it must expose a supported protocol or accept an appropriate restricted
credential. Merely calling a URL OpenAI-compatible does not establish support.
