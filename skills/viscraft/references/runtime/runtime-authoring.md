# Runtime and authoring reference

Contract details for the Runtime entry points, the Project schema and CodeScene
authoring. Read only the parts a task needs. Export/archive/restore and the
delivery bundle are in [Delivery](delivery.md); the current-state, version and
space commands are in [Project lifecycle](lifecycle.md); the edit/audio contract is
in [Timeline](timeline.md) and [Audio](audio.md); media intake and analysis are in
[Media preparation](media-preparation.md) and [Media analysis](media-analysis.md).

**Contents**

1. [Runtime entry points and environment](#1-runtime-entry-points-and-environment)
2. [Author a first work](#2-author-a-first-work)
3. [Runtime API](#3-runtime-api)
4. [Thin CLI](#4-thin-cli)
5. [Authoring a CodeScene](#5-authoring-a-codescene)
6. [Project structure, schema and editing](#6-project-structure-schema-and-editing)
7. [Source-scoped asset variants](#7-source-scoped-asset-variants)
8. [Safety and portability](#8-safety-and-portability)
9. [Resuming and handing off an existing Project](#9-resuming-and-handing-off-an-existing-project)

## 1. Runtime entry points and environment

The Runtime is an executable library. Core creative semantics live in the Project
files, and a Project lives in any directory the user chooses — it is not bound to
the Skill install directory and does not depend on the process cwd. The library
entry point is `dist/src/index.js` (package `viscraft-runtime`; the package is not
published, so this name is not an install channel).

Choose and communicate that work location through
[Startup checks](preflight.md#establish-and-keep-the-projects-location); keep the
Project root explicit even when the executable or subprocess cwd lives elsewhere.

[Startup checks](preflight.md) owns discovery and decisions about missing
prerequisites. The Skill and the Runtime are installed **separately**; this section
supplies the actual installation and execution commands for each entry:

- **Installed package** — reuse the matching user-level Runtime across works.
  Use its verified `viscraft` launcher on PATH, or its actual installed entry;
  `--version` and `doctor` need no build step. The Skill carries creative guides
  and references; the separate Runtime package carries executable code and fixed
  resources.
- **Skill without an available Runtime** — follow [Startup checks](preflight.md)
  to locate a matching installation or obtain the package identified by the Skill.
  Reuse a working matching installation; starting a new work alone does not require
  downloading it again.
- **Existing source installation** — use its supplied, already-built entry.
  Ordinary creative work does not require building or testing Viscraft itself.

- `--version` reports `contentSha256` for comparison with the Skill receipt; a
  match identifies the installed Runtime without downloading it again.
- `doctor` prints `browserCodeIsSandboxed: false`, a `providerVerificationScope`
  note, a `realVideoProvider` block that exposes `protocols`,
  `protocolCapabilities` (for example `runway-v1`, `fal-queue`), `packagedModels`
  and `modelCapabilities` (each model's `services[protocol].parameters`),
  `realImageProvider`, the explicitly `simulated: true,
  testOnly: true` simulation block and FFmpeg/FFprobe/Chrome versions. It also
  reports Blender availability. Credential/authorization readiness lives under
  `providers.capabilities` (`provider`, `image-generation`), not inside
  `realVideoProvider`. Verification flags mean **not checked by this invocation**,
  not that the capability is unavailable; a credential is not authorization.
- The browser is resolved by `findBrowser()`: first the `VISCRAFT_BROWSER`
  environment variable, then Linux Chrome builds in the Puppeteer cache and Linux
  system paths. On Windows/macOS, or for another installation, set
  `VISCRAFT_BROWSER` to the browser executable's absolute path.
- `doctor` actually probes `captureReady` by launching the browser and rendering
  one frame through the same backend. Host policy may deny browser launch or IPC
  even when version probes succeed; request an authorized environment instead of
  escalating permissions.
- If any `doctor` check fails it exits non-zero. Fix dependencies or execution
  permissions before dependent execution; unrelated planning can continue.

Use only the identified Runtime package or executable. Do not invoke an
unverified registry package by guessing its name. A bare `viscraft` command is
usable only when it resolves to the selected installation; otherwise use that
installation's actual entry. Check Chrome/FFmpeg only when the task needs them.

### Manual Runtime installation

Normally your agent prepares the matching Runtime. For manual installation, follow
[Runtime installation](preflight.md#prepare-a-missing-installation-once), which owns
package discovery, checksum verification, npm prefix selection and required-tool
setup. Reuse the selected installation across works. Use `--version` to inspect
it without launching tools, and `doctor` when the work needs execution checks.

For a work that imports the Runtime SDK, follow
[SDK setup](preflight.md#start-works-and-use-the-sdk-when-needed). A local npm link
can reuse the shared package; a deliberate project-local installation is also
supported. Preserve the work's existing package manifest, lockfile and dependencies.
Generation services are configured separately through
[image/video configuration](../providers/setup.md#setup-steps-for-the-user).

## 2. Author a first work

Write real trusted picture/sound entries and a schema-valid Project for the brief,
then build and inspect the actual output. Code-only works require neither a video
Provider nor a World. A simple code-authored `browser` picture Source uses explicit
`params`, `seed` and `frames`; Composition selects real intervals and places sound
on the same clock.
The lifecycle commands are in §4 and the Project/editing surface in §6.

Start a new work with `createProject(root, { title, intent?, output? })` (CLI
`viscraft create <project-directory> <title> [--medium draft|film|image|sound]
[--intent <text>] [--size WxH] [--fps N/D] [--sample-rate 48000|44100]
[--channels 1|2]`) instead of hand-writing JSON. It writes ONE valid current-format
`project.json` with a stable id, title, one default named Look and empty author
collections, and **refuses to overwrite an existing `project.json`**.
The default is an unedited draft with **no composition or fabricated target**.
`--medium film` (or SDK `output: {}`) adds an empty film composition; explicit
film output options also do so. `--medium image|sound` leaves the matching target
for the author to declare later and cannot be combined with film output options.
A film draft with zero placements has a finite zero length, but Build refuses to
fabricate a placeholder movie. For images declare an image document and target;
for sounds declare a sample-clock `soundTargets` entry, then use `build --target`.

```bash
node <runtime>/dist/src/cli.js create <project-directory> <title>
node <runtime>/dist/src/cli.js build <project-directory>
node <runtime>/dist/src/cli.js status <project-directory>
node <runtime>/dist/src/cli.js review <project-directory>
```

### Publish a recipe through the one authoring boundary

When the work starts from an editable recipe (a Skill `create.mjs`, a template you
adapted, or your own local script), declare its content once and let the Runtime
publish it:

```bash
node <runtime>/dist/src/cli.js author <recipe-file> <new-project-directory> [--options <json-file>]
```

A recipe default-exports a function called once with
`{ root, options, runtime }` and returns `{ project, files }`:

- `project` is ordinary current Project content. An Asset draft may omit `sha256`
  and `revision`; the Runtime derives them from the copied bytes. Supplied values
  and frozen parent identities in `Asset.inputs` are **assertions**, checked and
  never silently rewritten.
- `files` gives each authored file's exact Project-relative `path` plus exactly one
  of `sourcePath` (absolute local file) or `bytes` (generated content), and an
  optional `expectedSha256`. Paths keep their declared layout, including module
  imports; they are not renamed into content-addressed names.
- The destination must be a **new** directory. The Runtime validates declarations,
  duplicates/prefix collisions, forbidden paths and pins before writing, copies
  independently, verifies every hash, validates the complete Project, and commits
  `project.json` atomically last. A failed run leaves no falsely reported Project;
  it also does not recursively delete an uncertain directory. On failure, inspect
  and remove only content you authored when it is safe to do so.
- Recipe and `--options` paths resolve against the invocation cwd; path-valued
  options use the same rule. This imports explicitly selected trusted local
  JavaScript, like `--config`; it is not a sandbox.
- Authoring performs no Build, image render, provider submission or network access.
  Run `build` or `image <dir> --target <id>` separately. Files not declared as
  Assets stay ordinary editable author files.

The SDK equivalent is `authorProject(root, { project, files })` from the public
entry. Do not wrap it in a second installer, a recipe registry or a recipe DSL.

For concrete authored SVG/sound mechanisms, use the
[code-visual studies](../craft/code-visuals.md#reuse-the-working-author-module)
and the sound references.

## 3. Runtime API

```js
// Built from source: import the compiled entry by its actual filesystem path.
// Local dependency installation: use the specifier 'viscraft-runtime'.
import { createProject, authorProject, refreshCodeAsset, planBuild,
         loadProject, saveProject, validateProject,
         buildProject, inspectProject, readBuilds } from '<repo>/dist/src/index.js';

const draft = await createProject(root, { title: 'Night ride', intent: 'a short code film' }); // start a new work (never overwrites)
const project = await loadProject(root);                 // read and validate project.json
const plan = await planBuild(root);                      // read-only production preflight (no submission/upload/write)
const next = await saveProject(root, changed, project.revision); // revision-checked atomic write, revision+1
const build = await buildProject(root, { goal: 'tighten the rhythm of the second shot' }); // run one build
const { project: p, builds } = await inspectProject(root);
```

- `createProject(root, { title, id?, intent?, looks?, output? })`: write one valid
  current-format draft `project.json` (stable id, title, one default Look and empty
  collections); only an explicit `output` adds an empty film composition. Return
  the validated Project. It **refuses to overwrite an
  existing `project.json`** — edit that with `saveProject` instead.
- `authorProject(root, { project, files })`: publish a recipe's Project draft into
  a **new** directory (one author lock; validation before writing; independent
  copies; `project.json` committed last). Asset drafts may omit `sha256`/`revision`;
  supplied values and frozen parent identities are assertions. See
  [Publish a recipe](#publish-a-recipe-through-the-one-authoring-boundary).
- **Reference files.** A recipe or study resolves the files it owns from its own
  directory (for example with `import.meta.url`) and declares each `AuthorFile` as `path` plus
  `sourcePath` (or `bytes`); this includes a module, a scene, a font or a
  recording kept beside that reference. Put the real licence/provenance text in
  the same declaration as an unregistered `license` handoff when it must travel,
  and use `expectedSha256` where a byte pin is part of the reference. The Runtime
  derives hashes and the initial revision from the copied bytes; it does not map
  a style name to a hidden asset directory.
  Authored destinations use project-relative `/` paths, without drive prefixes.
  Runtime namespaces (`.viscraft/`, `output/`), `project.json` and credential
  basenames are reserved regardless of casing, so moving the work between
  case-sensitive and case-insensitive hosts cannot change that boundary.
- `planBuild(root, { goal?, target?, providers?, candidates? })`: the read-only **production
  preflight** — what a `Build` would do and what is already knowably wrong (timeline
  arithmetic, expected Take frames/audio, provider credential/authorization gaps),
  performing **no provider submission, upload or media write**. See
  [Startup checks → Production preflight](preflight.md#production-preflight-what-a-build-would-do).
- `buildProject(root, { goal?, target?, candidates?, providers? })`: freeze a snapshot of
  the current sources → render a Take per source → compose per placement → mix
  audio → mux the final. `target` names a sound target and produces a WAV result
  with no picture composition; absent, a timeline Build needs a `composition`.
  Returns a `BuildRecord` (status, medium, artifacts, reuse information). `providers` routes provider-backed sources
  ([Service execution](../providers/service-execution.md)). It fails fast on the same authoring
  errors the preflight reports, before any capture/render/provider work.
- `loadProject` / `saveProject`: `saveProject` uses a project lock plus a revision
  check; a conflict reports a Source revision conflict.
- `refreshCodeAsset(root, { assetId, expectedRevision })`: re-record the current
  bytes of a registered `code` Asset after a direct file edit. Same bytes is a
  no-op; it never writes the authored file or changes type/rights/provenance,
  child frozen `inputs` or history. Use `viscraft refresh-code <dir> <asset-id>`
  from the CLI ([editing guidance](#92-edit-at-the-highest-available-authoring-layer)).
- `validateProject`: beyond the schema it also checks unique IDs, reference
  integrity, that bindings point to real assets, and that audio fades do not
  exceed the clip duration.

**It is normal and allowed for the agent to read and write project files
directly** (`project.json` is just JSON). The API/CLI exist for stable execution,
status queries and concurrency safety — do not invent a setter for every property.

The full library surface includes `createProject`, `planBuild`, `buildProject`,
`previewProject`, `inspectProject`, `readBuilds`, `validateProject`,
`exportProject`/`archiveProject`/`restoreProject`/`deliverProject`
([Delivery](delivery.md)), `reviewBuild`, `promoteFrame`/`promoteRange`/`extractAudio`
(approve a Take frame, or extract+register a Take/Artifact's audio as an `audio`
Asset), `generateImage`/`preflightGenerateImage` (the image generation/editing Asset
operation, [Generation inputs](../providers/generation-inputs.md)),
`importAsset`/`inspectAssetInputs` ([Media preparation](media-preparation.md)),
`renderImage` (capture one declared image target, [Image direction](../craft/image-direction.md#editable-stills-the-image-route)) and
`serveWorkbench` (the on-demand local edit service for one image document),
`exportPlayable`/`servePlayable` ([World and Playable](world-playable.md)),
`analyzeReference`/`trackReferenceMarker`/`analyzeAudioReference`
([Media analysis](media-analysis.md)), `renderSoundScene` (the standalone
code-authored-sound renderer, [Audio](audio.md#code-authored-sound-browser-output-sound-source)), the
lifecycle entries `projectStatus`/`projectUsage`/`listVersions`/`keepVersion`/
`revertProject`/`planClean`/`applyClean` ([Project lifecycle](lifecycle.md)), the
provider entry points ([Service execution](../providers/service-execution.md)) and
the media/time helpers. Everything is exported from the Runtime's single root entry
(`viscraft-runtime`); model extensions are auto-selected from `(source.model,
protocol)`, so you do not import them from package subpaths.

## 4. Thin CLI

This is the complete command surface of the installed Runtime. The examples use
`viscraft` for the verified launcher selected during [startup](preflight.md#locate-the-runtime-for-this-work).
Use its actual entry when it is not on PATH. Other pages show only the command a
task needs; `viscraft --help` prints the same usage strings.

`plan` and `build` accept an explicit Project-relative `.mjs` configuration whose
default export is `BuildOptions`. It is trusted executable code, loaded only when
selected. It configures Endpoints and model extensions, not a second Project
manifest. No configuration is auto-discovered and no credential value belongs in
`project.json`. See [Model integration](../providers/model-integration.md).

```bash
# environment and credentials
viscraft --version
viscraft doctor                    # environment self-check
viscraft auth status               # generation readiness by capability (no network, no secrets)
viscraft auth set <CREDENTIAL_NAME> [--from <private-file>]
viscraft auth remove <CREDENTIAL_NAME>

# create and author
viscraft create <project-directory> <title> [--medium draft|film|image|sound] [--intent <text>] [--size WxH] [--fps N/D] [--sample-rate 48000|44100] [--channels 1|2] # empty draft by default; film output only when explicit (never overwrites)
viscraft author <recipe-file> <new-project-directory> [--options <json-file>] # publish one local recipe; authoring only
viscraft refresh-code <project-directory> <asset-id> # re-record the current bytes of a registered code Asset; same bytes is a no-op

# inspect what a build would do
viscraft plan <project-directory> [--target <id>] [--frames <start>:<end> [--scale <0.25-1>]] [--config <project-relative.mjs>] # read-only production preflight (no submission/upload/write)
viscraft inspect <project-directory> [build-id] # Project summary + build records, or one Build record
viscraft status <project-directory> # current result, stills, authoring changed?, attention codes and next steps

# produce
viscraft build <project-directory> [--target <id>] [--config <project-relative.mjs>] # build; --target names a sound target (image targets use `image`); no target = the film composition
viscraft preview <project-directory> (--frames <start>:<end> | --still <frame>) [--scale <0.25-1>] [--config <project-relative.mjs>] # range/proxy/still preview; never writes the active timeline
viscraft image <project-directory> [--target <id>] # render one still image target (no timeline needed)
viscraft workbench <project-directory> [--document <id>] [--target <id>] [--delivery <output-entry>] [--port <n>] # loopback URL for hand-adjusting one image document; optional recorded-delivery binding (Ctrl+C stops it)
viscraft generate-image <project-directory> <relative-request.json> [--check] [--config <project-relative.mjs>] # image generation/editing → registered Asset (--check = read-only preflight; submits nothing)
viscraft record <project-directory> <source-id> <relative-inputs.json> # one keyboard schedule → a recorded playthrough

# review and versions
viscraft review <project-directory> [build-id] # film programme: contact sheet, cut seams and technical audio report
viscraft versions <project-directory> [--all]  # succeeded, non-preview versions; --all adds failures/previews/checkpoints
viscraft keep <project-directory> <build-id> [--note <text>]  # retain a user-approved version
viscraft unkeep <project-directory> <build-id>
viscraft revert <project-directory> (<build-id|checkpoint-id> | --resume | --abort) # put the author state back

# space
viscraft usage <project-directory>     # the three byte measures plus reclaim candidates
viscraft clean <project-directory> [--include <output/name|build-id|artifact-id>]... [--apply <plan-hash> | --resume | --abort | --release-archived <archive|name.parts.json>] [--max-content <GiB>]
viscraft restore-media <project-directory> <archive|name.parts.json> [artifact-id]... [--max-content <GiB>]

# assets, references and analysis
viscraft promote-frame|promote-range|extract-audio <project-directory> <relative-options.json>
viscraft track-reference <project-directory> <relative-video-path> <#RRGGBB> [tolerance]
viscraft reference <project-directory> <relative-media-path> [threshold]
viscraft audio-reference <project-directory> <relative-media-path> [threshold]

# move and deliver
viscraft export <project-directory> [new-destination] [--allow-non-redistributable] [--allow-missing-originals] [--allow-incomplete-authored] [--extra-version <build-id|retained>]... # verified portable directory; default output/project
viscraft deliver <project-directory> [new-destination] [--movie] [--image <target>]... [--sound <target>]... [--review] [--stems] [--playable <source-id>] [--allow-non-redistributable] [--allow-missing-originals] [--allow-incomplete-authored] # bundle; default output/handoff
viscraft verify <bundle-directory> # re-hash every file the bundle manifest lists
viscraft archive <project-directory> [new-archive-file] [--part-size <MiB>] [--max-content <GiB>] [--allow-non-redistributable] [--allow-missing-originals] [--allow-incomplete-authored] [--extra-version <build-id|retained>]... # single-file archive; default output/<project-id>.tar.gz
viscraft restore <archive-file | name.parts.json> <new-project-directory> [--max-content <GiB>]
viscraft export-playable <project-directory> <source-id> [new-destination]
viscraft serve-playable <package-directory> [port]
```

`status`, `preview`, `versions`/`keep`/`unkeep`/`revert`, `usage` and `clean` are
the lifecycle surface; the three byte measures, the protection rules and when the
user must decide are in [Project lifecycle](lifecycle.md). Delivery commands and
their products are in [Delivery](delivery.md).

The same verified launcher serves different Projects; a local installation is
optional. A supplied source build can use its actual compiled entry:
`node <repo>/dist/src/cli.js <cmd> <dir>`.

## 5. Authoring a CodeScene

A CodeScene's `entry` may be an **HTML page** (`.html`/`.htm`) **or a TypeScript
module** (`.ts`/`.tsx`) the Runtime transpiles; either way it exposes
`window.viscraft`:

```js
// ready and dispose are optional: provide them only if you need them.
window.viscraft = {
  ready: async () => {},                        // optional: wait for fonts/resources before capture
  render: ({ frame, time, fps, width, height, seed, params, bindings }) => {},
  dispose: () => {},                            // optional: cleanup
};
```

What the Runtime **enforces** (no static code analysis, but violating it fails the
build):

- **entry and frame range**: the entry must be an `.html`/`.htm` page or a
  `.ts`/`.tsx` module exposing the contract above; it calls `render` once per
  `i = 0..frames-1` and captures one PNG each. Frame timeouts, page errors and
  404s all **fail the build**.
- **no external network**: only `data:`/`blob:`/`about:` and in-project resources
  are allowed. Do not pull CDN fonts or libraries — use system fonts, or put files
  in `resources`.

**Author responsibility** (the Runtime only evaluates at the fixed `time` and does
**not** statically detect clock or randomness use; reproducibility and cacheability
are on you):

- **determinism**: frame `i` must be determined by `(time = i·denom/numer, seed,
  params)` so it reproduces offline and can hit the build cache. Do **not** use
  `Date.now()`, `Math.random()` or rAF wall-clock time to decide offline output;
  for pseudo-randomness use a PRNG seeded by `seed`.

Things that must be declared explicitly, are frozen into the snapshot, and
participate in the cache key:

- **bindings**: `source.bindings` lists the binding names to bind (each must
  exist in `project.bindings`); the Runtime freezes those assets and passes them
  into `render` as `bindings`, each `{ id, url, sha256 }`.
- **resources**: in-project files the entry needs besides the entry itself must be
  listed in `source.resources`. **Resource path dependencies must be declared** —
  the entry and resources are frozen into the snapshot and hashed into the cache
  key, so anything you read without declaring it will be missing from the snapshot.
- Frozen files are read-only links into `.viscraft/content/<sha256>`, stored once
  per byte sequence. Author code (JS or Python) must never rewrite its own inputs
  at render time; write temporary data to new files or to the output it is given.

You can open the browser Source's own entry HTML directly in a browser to preview it; the first external
`render()` call stops the preview. **Offline capture only uses the `time` passed
in, independent of the preview wall clock.** `params` must be JSON-serializable.

A Blender-authored visual can instead be a `blender` Source: a **Python author
script** (`.py`) plus its dependency closure and ordered `args`. The Runtime
freezes the script, runs it through Blender to a PNG sequence, and
treats the frames as an ordinary Take. Blender may be a **standalone binary**
discovered via `VISCRAFT_BLENDER` (absolute path), `VISCRAFT_BLENDER_ROOT`
(versioned install root) or `PATH`, **or** a **Python interpreter providing the
`bpy` module** via `VISCRAFT_BPY_PYTHON`; `doctor.blender` reports which form it
found. A `.blend`-only entry is not implemented —
the Python script owns the author state. A `browser` Source with `output: 'sound'`
is the audio analogue of a picture CodeScene: its entry exposes
`window.viscraftSound` ([Audio](audio.md#code-authored-sound-browser-output-sound-source)).

## 6. Project structure, schema and editing

The single authority for `project.json` is the Project schema (compiled into the
published Runtime). Key points:

- `direction`: one unified authority that may contain **multiple named looks**
  (each with an optional numeric `grade`) and deliberate look transitions. Each
  shot names a `look`. `direction.transitions` uses Look IDs for `from/to` and
  describes the intended Look relationship; it does not mix pixels or address
  Shots. `composition.transitions` instead uses Placement IDs and an actual
  supported overlap range ([Timeline](timeline.md)).
- `composition.output`: `width`/`height` must be even; `fps` is rational
  `{numerator, denominator}`; `sampleRate` ∈ {48000, 44100}; `channels` ∈ {1, 2}.
- `imageDocuments` / `imageTargets`: an editable fixed-canvas HTML document plus
  the targets rendered from it (`width`/`height` are the logical canvas, `scale`
  only raises output pixels, plus `format`/`background`). `composition` itself is
  optional: a Project may carry a timeline, image targets, sound targets, or
  (as a draft) none yet; each producer refuses a target it cannot produce, and an
  image-only Project must **not** fabricate a Scene, Shot, audio clip, fps or
  duration. Route: [Image direction](../craft/image-direction.md#editable-stills-the-image-route).
- `soundTargets`: sound-only deliverables — `{ id, sampleRate, channels,
  outputSamples, audio[], ducking?, mastering?, beats? }`. `imageTargets` and
  `soundTargets` share one target id namespace, so `build --target <id>` resolves
  without guessing a medium; a sound target's Build result is a WAV with no
  composition or video. Its audio clips reuse the ordinary `AudioClip` shape.
- `sources`: a Source's `kind` is `browser`, `blender` or `provider` and answers
  only **who executes**; every authoring Source also writes `output` explicitly.
  `browser` (HTML/JS) is `output: 'picture'` or `'sound'` and, when picture, may carry
  the optional `world` and/or `recording` bindings; a sound `browser` Source carries
  `durationSamples`/`sampleRate` and no `frames`; `blender` (Python) is
  `output: 'picture'` only and may carry `world`; `provider` is the generation-service
  request and is **picture-only** — it REQUIRES `output: 'picture'` and rejects a
  missing or different `output` (`endpoint`, `model`, `prompt`, `mode`, `references`,
  `requestedFrames`, `size`, `fps`, `steps`, `seed`, `flowShift`, `attempt`,
  `parameters`). `simulated` is a separate, test-only Source kind that is **not** one
  of the three authoring executors and carries **no** `output` field; what its result
  may and may not be used as evidence for is
  [fixed in the reporting levels](../../SKILL.md#report-honestly-real-vs-simulated). Image generation/editing is **not** a Source kind: the separate
  operation `viscraft generate-image <project> <request.json>` registers its result
  as an image Asset.
  Provider shapes are in [Service execution](../providers/service-execution.md); image
  generation/editing in [Generation inputs](../providers/generation-inputs.md);
  sound/world/playable shapes in [Audio](audio.md) and
  [World and Playable](world-playable.md).
- `composition.shots`: `scene`/`look`/`intent`/`targetFrames` (a Shot is intent,
  not a file).
- `composition.placements`: **exactly one** of `source`, `take` or `asset`;
  `outFrame > inFrame`; `[inFrame, outFrame)` half-open; `startFrame` is the
  timeline position; `audio` is `mute` or `keep`. A picture `asset` reference may
  also carry `framing` and is normalized to the output grid; an image Asset
  declares its stay with `durationFrames` and must be `mute`. Reading past the
  Take's frame count
  reports handles unavailable rather than silently using frames that do not exist.
  Placement fields, transitions (including `whipleft`/`whipright`/`hblur`/
  `occlude`), `matchCuts`, layers, retime, subtitles, `bus`, `ducking`, `beats`,
  `mastering`, `fade` and `outputFrames` are all documented in
  [Timeline](timeline.md) and [Audio](audio.md).
- `worlds`: optional shared spatial facts ([World and Playable](world-playable.md)).

**Edit at the highest available authoring level**:

- change text/colour/rhythm/duration → change `source.params` or add a source;
- change a shot's trim/position → change the placement's `inFrame`/`startFrame`;
- change subtitle text/timing → change `composition.subtitles`; reuse Takes, the
  subtitle-free composition and mixed audio, then rebuild only the overlay and
  final mux;
- swap an asset → change `bindings`;
- a flat imported MP4 only → do real media processing or an explicit re-authoring;
  **never claim the original project was recovered**.

**Selective rebuild**: editing one source's `params` re-renders that source while the
others are reused; what an operation key covers and what a change re-touches is
[Project lifecycle §3](lifecycle.md#3-reuse-and-the-build-cache). **A failed build
does not destroy the previous successful result**, and a new success does not
overwrite an old Artifact's identity.

## 7. Source-scoped asset variants

A `browser` or `blender` Source can specify `bindingOverrides:
{ bindingName: assetId }`. Override keys must be declared in that Source's
`bindings`; values select existing Project Assets with real hashes/rights. Global
`project.bindings` and persistent World entities remain unchanged. Ambiguous
overrides for two names that globally reference the same Asset are rejected rather
than guessed.

Use this for an explicitly scoped shot change, such as one camera shot's vehicle
pattern. Build freezes the resolved Asset and World inputs; changing only that
Source's override produces a new candidate for that Source, while unrelated
Sources can reuse their Takes. A global Binding change has broader actual
dependents and must not be reported as a single-shot edit.

Accepted Take IDs remain fixed media selections: modifying the originating
Source/override does not mutate or automatically replace a Take already chosen by
a placement. To use the changed design, select the modified Source for new
production or explicitly choose its new Take. Recorded gameplay freezes overrides,
selected Asset files and resolved World in its signature; changed inputs require a
fresh recording. Portable export preserves the selected variant's rights and
dependencies, not just the original global Asset
([Delivery](delivery.md)). This is authored identity/variant scoping, not automatic
model character consistency or editing layers inside opaque MP4s.

## 8. Safety and portability

- Browser capture uses a real Chrome with `--no-sandbox` (required in containers that
  run as root). **This is not a security sandbox**; a CodeScene is
  executable code, so only run trusted sources. The same applies to Playable game
  code and any vendored library.
- Blender execution runs an author Python script with the host's normal
  permissions; only run trusted scripts.
- A Project moves as a whole: authoring state lives in `project.json`; `.viscraft/`
  holds both reproducible run caches (a `build` re-creates them after a move) **and**
  records, retained versions, provider evidence and paid/unknown media that are **not**
  reproducible. Treat only the reproducible caches as disposable; free the rest through
  `clean`/`--release-archived`, never by hand ([Project lifecycle](lifecycle.md)).
  Never put tokens/secrets in the project.
- Do not store provider secrets in Project authoring state. Provider credentials
  and authorization live in call options/environment and are never bundled by
  export or delivery.

## 9. Resuming and handing off an existing Project

A new agent session that must continue an **existing** Project reconstructs
everything it needs from the Project itself — never from a previous chat
transcript. Do not assume the former session's memory, scratch reasoning or file
handles survive. The Project (plus, only if genuinely useful, a small notes record
— §9.4) is the whole hand-off.

### 9.1 Read the existing Project and its history first

Read the current state before changing anything:

- API — `const { project, builds } = await inspectProject(root)` returns the
  validated Project plus every `BuildRecord`; use `loadProject(root)` for just the
  Project and `readBuilds(root)` for records only ([Runtime API](#3-runtime-api)).
- CLI — start with `viscraft status <project-dir>`: the current result, the newest
  still per image target (`stills[]`), whether the author changed it, the
  `attention` codes and the literal `next` steps
  ([Project lifecycle](lifecycle.md)). `viscraft inspect <project-dir>` lists compact
  Project, Build and delivery summaries; read `project.json` or use `loadProject`
  for the authoring state. `viscraft inspect <project-dir> <build-id>` returns one
  full Build record. Use `viscraft review <project-dir> [build-id]` for a **film**
  result. A still is inspected by opening its returned image file, not
  through `review`; a still Build is a version for `versions`/`keep`/`revert` by its
  recorded `build` id.

From that state learn, at minimum:

- `direction` — the named Looks and any intended look transitions;
- `assets` / `bindings` — what Assets exist and what each Source binds;
- `sources` — the authored inputs (`browser`/`blender`/`provider`/`simulated`/…),
  each with its `output`;
- `composition` — `shots` (intent), `placements` (real timeline intervals and
  their audio), transitions, subtitles, beats, fade, outputFrames;
- prior Builds — each record's `status` (`succeeded`/`failed`/`running`), `stale`,
  `error`, the produced `takes`, `artifacts` and `result`.

`project.json` holds the authoring state. Most of `.viscraft/` is derived run cache
that a rebuild re-creates after a move (§8), but **not all of it** — records, retained
versions, provider evidence and paid/unknown media are not reproducible and are
protected, so never treat the whole directory as disposable
([Project lifecycle](lifecycle.md)). A new session should
re-run the [startup checks](preflight.md) for what **CHANGED** or what a newly
needed operation depends on, reusing facts that are still settled rather than
re-probing the whole environment.

### 9.2 Edit at the highest available authoring layer

Find the highest layer that can express the requested change and edit there — the
same map as §6. **Opaque media stays opaque unless explicitly reconstructed**; never
claim a flat MP4 was made editable.

| Requested change | Highest real entry |
| --- | --- |
| text/colour/rhythm/duration | the `browser`/`blender` Source `params`/`frames`/`seed` |
| a shot's trim/position | the placement's `inFrame`/`outFrame`/`startFrame` |
| cut point / shot length | placement boundaries (+ `audioLeadSamples`/`audioTailSamples` for a real J/L-cut) |
| subtitle text/timing | `composition.subtitles` (rebuild only the overlay + final mux) |
| swap an asset | `bindings`, or a Source's `bindingOverrides` (§7) |
| a look/style inside one scope | the named `direction` Look and the affected Assets — not a global change |
| camera move, if a World owns it | the World; otherwise the CodeScene / generation control |
| a garment colour in a generated Take | the generation context → **re-generate**; never claim you edited a pixel layer |
| only an imported flat MP4 | real media processing (trim/crop/retime/mix) or an explicit re-authoring |

When you edit a **registered** `code` Asset in place (an adopted module, scene or
document), record the current bytes explicitly before building or rendering:
`viscraft refresh-code <project-directory> <asset-id>` (SDK
`refreshCodeAsset(root, { assetId, expectedRevision })`). It advances every current
`code` Asset at that authored path to the current file's SHA-256 and revision, once;
same bytes is a no-op. It never writes the authored file, never changes
type/rights/provenance, and never rebinds a child's frozen `inputs` or old Build
snapshots. Only `code` Assets can be refreshed — image/audio/video/font/model
Assets are refused and must be re-imported. It prints the asset id, path, SHA-256
and revision. Do not hand-edit a recorded hash in `project.json`, and do not turn
the file into an unregistered file to dodge the check. Then `build` (or `image`) as
usual; no provider or automatic regeneration is triggered. The workbench applies
the same path-based rule when it saves a code file, so a workbench save needs no
separate command.

### 9.3 Change only what is affected

Reuse, the operation key and what a change re-touches are owned by
[Project lifecycle §3](lifecycle.md#3-reuse-and-the-build-cache); retaining or
returning to an accepted result is
[§4](lifecycle.md#4-versions-versions-keep-revert). What matters when you edit an
existing Project:

- **Pin an accepted result** with a `take:` placement: a placement is exactly one
  of `source`, `take` or `asset`, and a `take:` placement selects a specific Take
  artifact so the accepted media is not replaced when its originating Source changes.
- **A changed author snapshot is not a claim that unrelated Takes are stale.**
  `authoring: changed` answers "does the current film result's snapshot match the
  author tree?", not "which Takes changed?". Use `plan`'s `changes` and per-Source
  reuse to decide; an unaffected film Take stays cached, and an image-document edit
  does not by itself invalidate the film.
- **Preview before spending:** `plan` is read-only and reports EXACT `reuse` versus
  `work` per Source — with **no submission, upload or media write**
  ([Production preflight](preflight.md#production-preflight-what-a-build-would-do)).
- **A failed Build keeps the previous active result** and never overwrites an old
  Artifact's identity. Report what was actually rebuilt versus reused, rather than
  implying the whole programme was regenerated.
- **After an edit, read `plan` `changes` against the current result.** It diffs the
  current author state against the active result Build's frozen snapshot (by id, plus
  authored-file hashes) and reports only the objects you touched. It also emits an
  `identity` hint when a Source id was replaced by a same-kind Source (same authored
  file or same Shot), or when every Placement id changed while the intervals did
  not: in that case the old Take is no longer selected/reused. **If you only changed
  parameters, keep the original Source id** — a rename silently discards the cache
  and the accepted Take.

### 9.4 Notes that survive a session (auxiliary only)

Prefer to keep the durable facts in the Project state itself, where they already
belong and stay authoritative:

- **Approved Looks** → the named `direction` Looks;
- **An approved/accepted Take** → the `take:` placement that selects it;
- **A chosen generation input** → the Source's generation-context records
  (references/prompt/params);
- **A pending spend/upload approval** → leave the source unauthorized
  (`authorization.submit` unset) until the user approves; the preflight then
  reports it as `requiresApproval`, so it is not lost and cannot be spent by
  accident ([Resolve gaps](preflight.md#resolve-gaps-with-the-user-when-they-affect-the-outcome)).

When a free-form note is genuinely useful (open blockers, the next action, a
decision rationale that the schema cannot hold), keep it as a small
project-relative Markdown note — conventionally `NOTES.md` — that the **next
session reads first** alongside `inspectProject`. Such a note is **auxiliary**: it
never overrides `project.json` or the authoring state, and any discrepancy is
resolved in favour of the Project. No fixed set of note files is required.
