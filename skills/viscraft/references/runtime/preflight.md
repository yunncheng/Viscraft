# Startup checks — establish what this task can actually use

This page is the practical form of **stage ② (inventory capabilities)** on the
[home page](../../SKILL.md#the-seven-stages-dependencies-not-steps): judge what this
task needs, check what is available, and resolve outcome-changing gaps with
the user before production. Gather related gaps in one exchange. On continuation,
reuse settled facts and check only changed requirements or newly needed operations.
The same page documents the read-only [production preflight](#production-preflight-what-a-build-would-do)
(`planBuild` / `viscraft plan`) that reports what a Build would do before any spending.

Inventory at least these, and only the ones this task can actually reach:

- the **available Runtime installation** for this work (below) and its version/diagnostic entry;
- the **execution tools** the selected route needs — Node, FFmpeg/ffprobe, a usable
  browser for capture, or Blender/Python for that backend;
- **configured generation Endpoints** and `viscraft auth status` (per capability);
- whether the **host agent has its own image tools** (and authorization to use them),
  so image work does not depend on a provider the task does not need;
- the **working material** and the **observation** this host can actually do.

When a gap would change the plan, gather the initial gaps and explain the concrete
options to the user **before production** — configure the missing piece, or take the
alternative route — and start the parts that do not depend on the answer in parallel.
Revisit the decision when a new requirement or capability gap changes the plan.

## Locate the Runtime for this work

Reuse one matching user-level Runtime installation across works. Keep it outside
both the Skill directory and author Projects. A new work does not require another
Runtime download or npm installation. Respect an existing deliberately selected
project-local installation instead of replacing it.

### Find an existing installation

Check the host's command lookup for `viscraft`, an explicitly known installation,
and npm's installation records (`npm prefix --global`, `npm root --global`, or
`npm ls --global viscraft-runtime --depth=0`). A known project-local install is
also usable. Do not scan unrelated works or model deployments to find one.

Use the selected executable's `--version` to read its package path, CLI `entry`,
`sdkEntry` and whether this work resolves its SDK (`inProject`). This is a
read-only query that does not launch a browser or contact services. Being outside
this Project is normal. Run `doctor` and operation-specific checks only as needed
for the task's tools; a browser failure does not mean the Runtime needs reinstalling.

Compare the executable's `contentSha256` with the installed Skill's
`runtime.json` receipt. This fingerprint covers the distributed Runtime files and
is independent of the install path. A match confirms reuse without obtaining a
tarball again. A version string alone is insufficient. A mismatch requires the
matching package before executing production; do not bridge it with old commands
or alter a receipt to make it pass. The receipt's separate `sha256` verifies the
compressed tgz before first installation. If no receipt is supplied, use the
explicitly provided matching installation source rather than inventing one.

### Prepare a missing installation once

The Runtime requires Node.js 22+ and npm. Prepare FFmpeg/FFprobe for media
processing, a browser for browser capture, and Blender only for Blender work.
Reuse tools that are already available.

Only when no usable matching installation is available, obtain the package named
by the Skill receipt. Reuse a supplied matching tgz first; otherwise download its
exact declared URL within installation/network authorization. Verify SHA-256
before installation. If the download fails or its checksum differs, report the
retrieval or verification failure and request a matching package when none is
available. Do not substitute a guessed registry package, repository, release or
another same-version file.

Use npm's existing user-writable global prefix when suitable. If the prefix is a
system directory requiring elevated access, choose a user-writable prefix instead;
do not use sudo or rewrite the user's npm configuration. For example, on
Linux/macOS a prefix of `~/.local` supplies `~/.local/bin/viscraft`:

```bash
npm install --global --prefix "$HOME/.local" --ignore-scripts "<verified-runtime-package>"
export PATH="$HOME/.local/bin:$PATH"
viscraft --version
```

The explicit prefix above is an example, not a required directory. With an
existing suitable npm prefix, omit `--prefix` and use its executable directory.
On Windows, npm places its global launcher in the prefix itself; use the actual
prefix reported for that host, commonly under the user's AppData. Make the
selected executable available to the host process; preserve existing shell
settings and explain any PATH entry needed in new terminals. Installing a package
in one terminal does not update another running process's environment.

Dependency installation can need network access. Use `--offline` only with a warm
npm cache; an offline cache miss does not authorize a network retry. Do not
reinstall FFmpeg, browsers or models with each Project. Prepare only missing tools
needed by the selected work. An installed Skill supplies guidance and references,
not Runtime dependencies, model accounts or credits. Ordinary creators do not
need a contributor checkout or a source build.

### Start works and use the SDK when needed

With the verified executable on PATH, the same installation serves each work:

```bash
viscraft create <project-directory> "<title>"
viscraft status <project-directory>
```

No npm manifest or `node_modules` is needed merely to create a work or use the CLI.
Keep the chosen Project root explicit even when the executable lives elsewhere.
Record the selected installation and receipt identity in local working notes for
continuation; do not embed machine-specific installation paths in author code or
make a receiver depend on the sender's executable location.

An author recipe invoked by `viscraft author` receives the running SDK in its
`runtime` argument; it needs no separate Runtime import or local installation.
A global CLI does not make `import 'viscraft-runtime'` resolve inside an independent
author script. Only when a work actually uses that import, prepare its module dependency.
To reuse the existing shared package, verify that the chosen npm global root
contains that matching Runtime, then use npm's ordinary local link from the work:

```bash
cd <project-directory>
npm link --offline --ignore-scripts --no-save --no-package-lock --no-audit --no-fund viscraft-runtime
```

Use the same npm prefix as the shared installation. If that prefix differs from
npm's configured default, set `npm_config_prefix` to it for this invocation only.
Ensure the work has its own minimal private `package.json` first when it has none;
otherwise npm may select a parent package. Preserve existing manifests, lockfiles
and dependencies. Verify `import 'viscraft-runtime'` from the actual author script
location after linking. The link is environment setup, excluded from delivery;
the receiving host prepares its own matching installation and SDK link. A work
that deliberately needs a self-contained local dependency can instead install
the verified tgz locally. A link failure is not permission to fetch an unknown
registry package. Other author-selected libraries remain the work's dependencies.

Changing an installation never overwrites an existing Project, provider job
records, accepted Takes or delivered output. A source archive uses this same
receipt-verified installation process; it is not another creator workflow.

## Check the requirements of this work

Understand the requested result before selecting tools. Identify the operations
that need execution or generation, and what must survive across them. Check only
those dependencies; a code-only film does not require a video API, and a generated
shot does not require Blender or a World merely because they are available.

| Area | Establish | Detailed reference |
| --- | --- | --- |
| Runtime | An actual callable installation or built source entry, its version and execution diagnostics — reuse the [selected matching installation](#locate-the-runtime-for-this-work) | [Runtime entry points](runtime-authoring.md#1-runtime-entry-points-and-environment) |
| Execution tools | The tools required by the selected route: Node, FFmpeg, a usable browser for browser capture, or Blender/Python for the relevant backend | [Runtime entry points](runtime-authoring.md#1-runtime-entry-points-and-environment) |
| Model/tool operations | The actual session tools or configured services needed for image generation/editing, video generation/editing, or audio; their relevant inputs and limits | [Model and tool contracts](../providers/generation-inputs.md), [Video adapters](../providers/service-execution.md) |
| Working material | The explicit Project root, access to supplied files/output location, and permitted use of material about to enter production | [Project location below](#establish-and-keep-the-projects-location), [Media preparation](media-preparation.md) |
| Authorization and observation | Existing spend/transmission scope, and whether this host can inspect images, motion and sound or needs bounded evidence/user review | [Consent](../../SKILL.md#spend-and-upload-consent), [Review and repair](../craft/review-repair.md#review-the-final-cut-not-the-implementation-story) |

An installed Skill is not evidence that the Runtime is installed. Resolve the
selected shared or deliberate project-local entry (above). A Runtime in another workspace does not automatically make an
import or CLI available here.
If an existing entry works, use it: do not search for an installation archive,
reinstall or rebuild merely to begin another work. If it is missing, use a known
installation source within the user's authorization and host permissions. If no
source is known, ask for the package/repository location; do not guess a public
package name. Dependency or permission failures block the affected execution,
not unrelated planning or material review.

Use the Runtime's version/diagnostic entry and applicable execution probes. A
successful version query alone does not establish browser capture. Interpret
`doctor` facts by their documented scope: a provider's unverified flag is not
proof that the service is absent, and a registered API route is not proof that
the loaded model performs the requested operation.

## Establish and keep the Project's location

An explicit user-selected work location takes precedence. For a new work without
one, use the host's effective task workspace; check its actual absolute path,
rather than assuming the terminal's former directory is still active. For a
dedicated empty workspace, make it the Project root. A workspace containing
several works may need a named subdirectory; a continuation uses the existing
Project. Tell the user the resolved root before producing material. Ask only when
the target is genuinely ambiguous or the requested location cannot be used.

Keep that root explicit for author scripts, Runtime calls and subprocess working
directories. Changing a shell directory to inspect an installation does not move
the Project. A Runtime/Skill installation, host media cache or scratch directory
must not become the work's home merely because a tool executes there. If the user
requests another location, align Project paths and the host workspace/permissions;
copying files alone does not change a running agent's effective workspace.

Keep this work's authored files, retained candidates, review evidence and delivery
under the selected workspace unless the user has chosen another destination or
explicitly linked shared material. Directory names are conventions, not Runtime
semantics. Existing external inputs and shared dependencies may stay where agreed;
their availability and portable delivery remain explicit.

Keep a readable default layout (create directories on demand; an existing Project
keeps its real paths): `author/` for editable implementations, split by real
responsibility (scene, material, sound) rather than a per-round snapshot copy;
`assets/` for actual media; `review/` for the author's own review evidence (not old
deliveries); `output/` for Runtime deliveries; `.viscraft/` for Runtime records.
Keep versions with `keep`/`revert`, not by duplicating the author tree each round.
These are conventions that make a handoff legible, not Runtime requirements.
Build results stay in the Runtime result store by default and are reused through
Take/Build reference; use import/promote when one must become an Asset, and export
only when it must travel. The lifecycle commands (status, versions/keep/revert,
usage, clean) are in [Project lifecycle](lifecycle.md).

A host tool may initially save generated media to its own cache or return a
temporary download. That tool behavior does not select the Project root. Retain
review candidates in the workspace before handing them over, using real bytes and
the obtainable provenance as described in [Media preparation](media-preparation.md#retain-host-tool-candidates).
Show the user the local candidate paths along with any inline preview. Explain a
temporary external-only result when it cannot yet be retained; do not quietly
adopt a scratch directory as the permanent project.

## Check only the necessary Provider paths

Inspect this session's exposed tools and real parameters; discover more only
when the host supports discovery. An explicit user-named service wins. Otherwise
use an appropriate authorized host tool or an already configured suitable
service. Image, video and audio capabilities are separate; one working entry
does not establish the others. Do not generalize another host's tools to this one.

For generation, `viscraft auth status` lists the user's configured Endpoints by
capability and whether each credential is present, without network access or
secret values. For a selected service, use the sanitized status and supported model list; do not
read the private user JSON or environment values. Verify model/protocol and the inputs needed by this task, and use a documented
lightweight health/model query when useful. Do not invent a capabilities endpoint,
scan unrelated accounts or model directories, or submit a costly generation just
to discover an entry. Check the actual deployed mode: an identity image is not
automatically first-frame control, and reference video is not exact camera control.

The check ends when the entry and its applicable limits are settled. Do not demand
an API key when an available authorized host tool already meets the need. Real
generation quality and whether conditioning works require a separately reviewed,
authorized representative result; readiness does not promise artistic success.

Run this pass **when the work starts**, not when the first generated shot is due:
the same `status` / `doctor` / `auth status` look settles both what is installed
here and which of the operations the brief needs can actually generate. If a needed
service is missing, unconfigured or unverified, gather the initial gaps and raise
them **before production** — a service discovered after the film is built means
redoing work the user already spent attention on.

## Resolve gaps with the user when they affect the outcome

Report the specific observed state and its impact, rather than collapsing every
gap into "no Provider":

| Observed state | Response |
| --- | --- |
| No selected service/configuration found | Say it has not been configured or discovered; ask for an existing service's address/model, and have the user supply the key in their own terminal per [Provider setup](../providers/setup.md) — never in chat — or present suitable alternatives |
| Capability unverified | State what is known and which requirement remains unverified; perform a useful documented check or propose a bounded authorized trial |
| Configured service unreachable or rejecting authentication | Report the connection/authentication failure; help repair the selected setup rather than declaring the model nonexistent |
| Required operation unsupported | Explain the unsupported input/control and its effect; propose a compatible route that preserves the brief, or ask whether to change the requirement |
| Spend/transmission outside existing authorization | Explain the proposed service, material and cost/transfer scope before the dependent call; retain valid existing authorization |

Routine parameters and implementation choices remain the agent's responsibility.
Whether a question is needed at all is the policy in
[When to ask the user](../../SKILL.md#when-to-ask-the-user). Within that boundary, a
gap that changes provider/account, spending, transmission, or the promised creative
result is one to put to the user. Offer concrete feasible options, such as configuring
the user's existing service, using a suitable alternative, or explicitly revising the
brief. Do not silently replace requested realism with crude code picture, switch paid
accounts or present simulation as real production. Wait for a required answer on
dependent work; continue independent work within the settled scope. Silence is not a
selection.

Record only the chosen entries, meaningful limits, unresolved requirements and
next action in ordinary task notes. Keep any user update short and relevant; a
successful startup check is not a reason to send a long diagnostic checklist.

## Production preflight: what a Build would do

The startup checks above decide what **this session** can use. Once a Project
exists, `planBuild(root, options?)` (CLI `viscraft plan <project-directory>`) is
the separate **production feasibility preflight**: a pure read-only dry-run of
what a `Build` of the current Project would do. It performs **no provider
submission, no asset upload and no media write**, and acquires no lock; a local
`ffprobe` read of an existing media Asset is the only external read. Its
`BuildPlan` reports:

- `buildable` (`true` only when there is no blocker, no missing provider setup,
  no outstanding approval and no unsupported request; `pending` facts do not gate
  it, since they are only known after the run), plus machine-readable `blockers` /
  `needsConfiguration` / `requiresApproval` / `unsupported` / `pending` issues,
  each with a stable reason `code`. `needsConfiguration` is setup the user must
  supply (an Endpoint or credential, see [Provider setup](../providers/setup.md));
  `requiresApproval` is spend/upload consent;
- the exact edit-timeline arithmetic `composeVideo` enforces — the final frame
  count and any gap, unauthorized overlap, transition range mismatch, unconsumed
  transition or too-short occluder overlap — reported **before** any Take exists;
- placement intervals checked against the frames a Source is expected to yield:
  deterministic for `browser`/`blender`/`simulated` Sources and directly referenced
  Assets, and `pending` for real generation whose returned frame count is not
  pre-guaranteed;
- `audio: "keep"` placements whose deterministic Source cannot carry audio;
- per-source `simulated`/`external`/`expectedFrames`/`carriesAudio`, and EXACT
  `reuse` versus `work`: the preflight recomputes each Source's operation key the
  same way the Build does, so an edited authored file, binding, World or provider
  configuration produces a different key and becomes work — never a false "reuse";
  a selected `take:` placement is reported reusable only when its artifact hash
  still verifies. [Project lifecycle](lifecycle.md#3-reuse-and-the-build-cache) owns
  what a key covers and what a change reuses;
- each generation Source classified as reusable / would-run / blocked /
  needs-configuration / requires-approval / unsupported / pending from the
  provider options, the user's Endpoints and whether each named credential is
  present — without returning key values or contacting a service;
- `changes`: a by-id diff (Sources/Assets/Shots/Placements/audio/subtitles/
  transitions/Looks/composition + authored-file hashes) against the **active
  result Build's** frozen snapshot, using the same contentHash + diff
  `viscraft status` uses — `null` when there is no active result or the author
  has not changed anything. `identity` lists non-blocking hints that a stable
  Source/Placement id was replaced, so an accepted Take will no longer be reused;
- with `target` naming a **sound target**, the same report covers that target's
  sample span, its audio clips and their Source reuse instead of composition frame
  arithmetic, and there is no compose/mux step;
- any authored snapshot gap: an unavailable declared file is reported with its
  reason and expected/actual digest, and blocks only when the selected production
  consumes it; unrelated gaps leave the current target buildable.

A draft with no placements and no named target plans as `buildable: false` with a
`not-buildable` blocker (name a sound target, or declare a composition) — the same
refusal a Build gives — not as an error. The plan mirrors the
rules `Build` enforces, so a Build fails fast on the same authoring errors
before any capture/render/provider work; the real Build remains the authority that
re-verifies every fact it acts on, so a clean plan is necessary, not a guarantee
of artistic success. Pass `{ providers, candidates, goal, target }` to plan the exact
provider configuration, candidate shots and (for a sound target) the target a Build
would use.

### Model-request validation (reuses the selected definition's validators)

For a `provider` Source the preflight **also** runs the selected model definition's
own request validation, read-only, before any submission. It resolves the effective
model definition and service mapping for the Source's Endpoint — a packaged
definition chosen by the Source's canonical `model` plus the Endpoint protocol, or
the caller's explicit `extension` — and runs the ONE shared
`validateGenerationExtension` path (the definition's `validate` / `validateReference`
plus the service mapping's `validate`) rather than a second copy of the limits, so a
request the Build would reject is reported as a **`blocked`** item here instead of
failing later during the expensive Build. The packaged definitions are listed in
[Provider setup](../providers/setup.md#setup-steps-for-the-user). A request that
needs a definition and has none is reported as `needsConfiguration` — a vendor
protocol always needs one, a generic protocol only when the Source declares
model-specific `parameters` — so a plain generic `vllm-omni-video` request can need none.

- **`model-request-invalid`** — the request violates the selected definition's own
  request semantics: a mode it does not implement, a reference count or combination
  it rejects, or a parameter outside its accepted range.
- **`reference-media-invalid`** — a reference file violates the definition's media
  constraints (dimensions, aspect, frame rate, duration, codec, and the accepted
  audio formats when the stream is optional). The file is probed locally with
  `ffprobe`.

Each definition owns its own numbers and its own error attribution: the model card
states the exact limits and which code it reports (for example
[MiniMax-H3](../providers/models/minimax-h3.md)).

This check reuses the definition validators (no duplicated limit table) and performs
**no network call and no upload** — reference media is read from disk only.
