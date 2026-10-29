---
name: viscraft
description: Use a host coding agent to create, edit and transform audiovisual works with the Viscraft Runtime — short films, still images, sound, interactive/playable works and existing Viscraft Projects. Real authoring through code, imported or generated media and optional shared Worlds; generation services are optional. Use when the user wants to make a new work, change or re-cut an existing one, adapt reference media, or inspect/build a Viscraft Project.
---

# Viscraft Skill — crafting editable audiovisual works with a host coding agent

> Creative and contract knowledge for the **host coding agent** (Codex,
> CodeBuddy, Claude Code, ...). You own the
> intent, direction and creative code; the Runtime owns the deterministic timeline,
> media processing, execution and artifact records. Use your host's tools for
> creative reasoning and review, and the per-work image workbench for supported
> design edits. Viscraft supplies execution tools rather than a conversational agent.

## What Viscraft is

Viscraft is not a fixed pipeline or a "video model". It is **many reliable
sub-capabilities that you, the host coding agent, combine freely**. Inputs range
from a sentence to an existing Project; the deliverable is whatever the user needs —
a finished film, an editable Project, a playable work, or the reports to decide.
Outputs become inputs, so capabilities **chain**. Choose each part's method by its
quality and control needs; consider code, existing material and compositing before
video generation, without requiring a code trial
([method selection](references/craft/creative-method.md#choose-the-medium-for-the-required-control)).
Code-directed work can use imported models, textures and media
([finding and licensing material](references/runtime/media-acquisition.md)).
Skill and Runtime install **separately**: creative guidance and deterministic execution.

## Hard rules

Follow these four rules and the documented execution and data-safety contracts.
Choose the creative structure, production order, author files, tools, style and
pace to fit the work.

1. **Inventory the capabilities this task needs before starting.** Judge which
   capabilities it requires (generation services, the host's own image tools,
   Blender, ...) and check they are actually available. When a gap would change the
   plan, settle it with the user before production — configure it or switch
   approach; never discover a missing dependency after doing the work. A genuinely
   new gap later is a normal exchange, not a broken rule. Practical form:
   [Startup checks](references/runtime/preflight.md).
2. **Get scoped authorization before spending money or sending material off the
   machine.** Existing authorization stays valid inside its scope — not re-confirmed
   per call; ask again only when cost, transfer scope or a resource need exceeds it.
   "Just do it" is not unlimited spend or upload. Detail:
   [Spend and upload consent](#spend-and-upload-consent).
3. **Inspect the actual output before delivering it, and state honestly what you
   did not observe.** Watch motion and listen when you can;
   [operate a game](references/runtime/world-playable.md#review-the-playable-work-through-real-input); inspect
   an image's or audio file's actual content. When you cannot literally watch or
   hear it, use frame extraction and audio measurement as evidence and name the part
   you did not observe — never claim a full review, and never fake a pass (or force a
   stop) because no player is available. Levels:
   [Report honestly](#report-honestly-real-vs-simulated).
4. **Honour the real execution contract and technical correctness** — frame/sample
   boundaries, time sync, reference integrity, generation submit/recovery. Choose
   techniques by intent — a genuine J-cut uses a kept Take's own pre-roll
   ([Kept Take audio and J/L cuts](references/runtime/audio.md#shaping-a-kept-takes-own-audio--the-true-j-cut-and-l-cut),
   [media §5](references/runtime/media-preparation.md#5-prepare-audio-from-an-existing-recording))
   — and do not turn one finishing order into a universal creative step.

Recording the plan, the capability check, the authorization and the output check are
**continuous responsibilities**, not one-off gates. A settled question is not
re-opened.

## The seven stages (dependencies, not steps)

These are responsibilities, not an approval chain: independent parts run in any
order, a stage with no trigger does not run (no soundtrack → no audio work; one
scene → no transitions), and a check/preview/export does only that operation. The
recording, capability check, authorization and output check stay live throughout.
Per-stage guidance — entry/return, default action, state to leave, and when to
leave something open — is
[Creative workflow](references/workflows/creative-workflow.md).

Plan the relevant whole work: what is established, what must persist, what may
vary and what intentionally changes. Use that same account to select methods,
author inputs, combine material and inspect the result, including changes inside
a single shot. It lives in the existing Project/notes, not a new worksheet.

| Stage | What it resolves | Chapter to read, by condition |
| --- | --- | --- |
| ① Understand the task | Inputs, target effect, audience/length, deliverable and retention; new vs continue vs local edit vs single operation | [Creative method](references/craft/creative-method.md#translate-intent-into-a-visual-and-temporal-language) when the brief is visual |
| ② Check relevant capabilities | Which tools/material/observation the route needs; config gap vs unverified vs unsupported vs unauthorized | [Startup checks](references/runtime/preflight.md) |
| ③ Develop the creative plan | Retained facts and intended changes; needed control, chosen route, credible alternative, evidence and smallest check | [Whole-passage relationships](references/craft/creative-method.md#establish-the-whole-work-and-its-changes), including changes within one shot; [method selection](references/craft/creative-method.md#choose-the-medium-for-the-required-control) |
| ④ Preview the direction when useful | Whether showing is worth its cost, and the cheapest evidence that answers the open question | [Creative review](references/craft/creative-method.md#creative-review-and-production-commitment) |
| ⑤ Produce and combine | Real Takes and a real composition, in dependency order, with correct provenance; candidates kept | [Runtime and authoring](references/runtime/runtime-authoring.md); [Sound design](references/craft/sound-design.md) when a Take's sound needs keep / process / combine |
| ⑥ Inspect and repair | Whether the actual output meets the goal, its cause, and the smallest effective fix | [Review and repair](references/craft/review-repair.md) |
| ⑦ Deliver and continue | Handing over what the recipient needs and leaving a real continuation entry | [Delivery](references/runtime/delivery.md) |

## When to ask the user

**Default: you decide. Ask only these three classes**, and only when the answer
would materially change the task:

- **Resources and authorization** — cost, transfer, a service that is required but
  not configured (hard rule 2).
- **Facts only the user knows**, that cannot be reasonably inferred.
- **A direction fork with no basis to judge** — where the result would differ
  completely and there is no evidence to choose, including a change that alters
  the agreed brief or falls outside what was already approved.

Choose capabilities, combinations, styles, shots, pace and music yourself and record
the reason. Do **not** re-ask what is answered or authorized; gather initial gaps in
one go. A checkpoint or review the user asked for is part of the task, and a new
command is not itself a new authorization request, as long as cost, transfer and
resources stay in the agreed scope. A new material gap, user feedback or an
out-of-scope request mid-task are normal exchanges — "ask once" does not forbid
them. Proceed with the authorized parts and do not lower the user's requirements.

## Where the plan lives

The existing `project.json` already says what is made and how
([Runtime and authoring](references/runtime/runtime-authoring.md) §6). The why,
capability status, user decisions and next step go into the handoff `notes`,
rewritten in place, format free — enough to continue; never invent shots,
timelines or Looks for a pure game, image or audio task.

## Route from `status`

Enter by task type first: a named single operation (status, check, preview, export,
deliver) is exactly that operation; a new piece inside an existing Project starts at
①; a specific edit jumps to the layer it touches; a brand-new work follows ①–⑦
([Creative workflow](references/workflows/creative-workflow.md)).

In an existing Project run `viscraft status <project-directory>` **first**, then
route on its `current`/`stills`/`authoring`/`attention`/`next` (contract:
[Project lifecycle](references/runtime/lifecycle.md)) — no Project → `create`;
a `stills[]` entry that is `stale` (or a requested still change) → edit the
document and `image <project-directory> --target <id>`, **not** `plan`/`build`;
a film whose `authoring` is `changed` → `plan` the change, then `build`; preview a
risk range first only when one specific uncertainty is worth its cost
([Creative workflow ④](references/workflows/creative-workflow.md)); the user approves
a result → `keep <project-directory>
<build-id> --note <scope>` (a still's `build` id is a version too);
go back to an accepted version → `versions <project-directory>` + `revert
<project-directory> <build-id>`; hand over → `deliver <project-directory>` with the set needed (`--movie` / `--image <target>` / `--sound <id>`;
no selector = all declared); pure sound: its WAV plus the editable Project, no
movie; playable: add recording/download controls by default, then `export-playable`;
someone else's Project → read its `.viscraft/pages/VISCRAFT.md` and `notes` first;
disk space → `usage`, then a reviewed `clean` plan.

`authoring: changed` does not mean every Take regenerates — read `plan`'s per-Source
reuse first ([reuse and the build cache](references/runtime/lifecycle.md#3-reuse-and-the-build-cache)).

`review` analyses a built **film** (contact sheet, seams, audio report), not a
still or a pure-sound Take: open the image file itself; decode and listen to the WAV.

Two boundaries are technical, not style: never hand-`rm` outputs, artifacts or
snapshots (reclaim with `clean`, or `--release-archived` for paid media); and never
edit the real timeline just to preview (use the dedicated `preview`).

## Still images and sound targets

Keep all requested outputs in the same Project. For editable stills, declare
`imageDocuments`/`imageTargets`, render the selected target, and deliver with
`--image <target>`. A flat image remains one image layer; do not invent recovered
text or layers. Read [Editable stills](references/craft/image-direction.md#editable-stills-the-image-route)
for authoring, the live workbench entry required for a delivered image, and receiver setup.

A sound-only work declares `soundTargets`, builds the selected sample-based
target and delivers its WAV plus editable Project with `--sound <id>`. It needs
no film composition, FPS or black video. Read [Audio](references/runtime/audio.md)
for sound Sources, arrangement, mixing and structured sound, and
[Sound design](references/craft/sound-design.md) for the creative choices.

## Workspace

The Runtime owns `.viscraft/` and `output/`; the rest is yours. One-off scripts can
live in `.viscraft/scratch/` or `drafts/` (outside a delivery), with a handoff note
rewritten in place. In a git work tree, `git status` is a quick check of what
changed, not a required final step.

## Reference map (three layers)

Three layers: this page's **overview** (positioning, four hard rules, seven
stages), the **stage guidance** in
[Creative workflow](references/workflows/creative-workflow.md), and the
**specialist rules** in `references/`: craft (why a choice works), runtime (how it
executes now), providers (real modes and constraints), workflows (chains and
lookup). Each rule has one home; read only what the question needs. The
[Reference map](references/reference-map.md) lists every page with its section and
the trigger for reading it.

`assets/` ships creative references: complete works in `projects/` and focused
mechanisms in `studies/`. Each keeps its author source, any recipe, observation
scope and licences together. Use them when helpful; borrow, adapt or replace
them, or edit an existing Project in place
([details](references/creative-references.md)).

## Prepare execution for the selected work

Follow [Startup checks](references/runtime/preflight.md) to reuse the matching
Runtime or prepare the receipt-verified package once. Skill and Runtime install
separately; ordinary creation does not require building or testing Viscraft.
Use the selected installation's actual executable. **Never use `npx viscraft`**
to guess a package. Prepare an SDK dependency only when an author script needs it.

Use `create` for a new work, or `author` for a trusted local recipe. Neither
builds or submits generation. Before production use the read-only `plan` to see
work, reuse and authorization gaps. Contracts and commands live in
[Runtime and authoring](references/runtime/runtime-authoring.md).

## Provider setup and credentials

Check `viscraft auth status` for supported models and sanitized setup.
**Never request keys in chat or inspect/expose private configuration.** Users
configure JSON or environment variables themselves; see
[Provider setup](references/providers/setup.md).

## Spend and upload consent

The engine submits nothing without `authorization.submit === true`, and transmitting a
reference Asset additionally requires its id in `authorization.uploadAssets`. A key is
not consent and a redistributable license is not upload consent.

**Requirement — for any provider that can bill the user or send their media off the
machine, whatever service or protocol it uses: before writing
`authorization.submit: true`, tell the user, in plain language, (a) which provider and
model will be called, (b) exactly which Assets will be uploaded, by Asset id, (c) the
requested frames/seconds and resolution, and (d) the expected cost — or state plainly
that the provider bills per call and the exact amount is unknown. Then wait for
explicit confirmation; existing authorization stays valid within its scope.**

- Never hardcode `authorization.submit: true` as preauthorization in a committed example
  or reusable script; an explicit `--authorize` gate may construct it after consent, but
  that flag is not consent.
- If the user has not confirmed, do not authorize: author the project plus the
  animatic and candidate Sources; an ordinary `build` performs no provider work.
- For a user-owned local service, use its real cost/transfer scope; uploading the
  user's own footage/stills/audio to any third party needs their awareness even when
  free ([Service execution](references/providers/service-execution.md)).

## Report honestly: real vs simulated

Keep four levels apart: **① simulated flow passed / ② real Code/Media output
passed / ③ real provider generation passed / ④ observed artistic quality.**

- A Code/Media work is a real creative product (`artifact.simulated === false`); the
  `simulated`/`test-only` path only exercises submit/status/recovery/compose/mix and
  never makes a film pass. Use that path only for a technical test the user asked
  for, never as a substitute for generated footage.
- The `provider` Source calls an already-running service through its explicit
  Endpoint protocol; [service execution](references/providers/service-execution.md) lists the implemented routes.
  `generate-image` calls an image service through `vllm-omni-image` (`providers.imageApi`).
  A registered route does not guarantee identity or motion correspondence — inspect
  the actual Take before claiming them.
- A registered `/v1/images/*` route does not prove the loaded model can generate
  images: confirm the capability from a real returned image.
- Describe only supported capabilities, endpoints and duration tiers, with the
  actual cost and observation limits. A credential alone does not establish an
  available route or a model capability.
