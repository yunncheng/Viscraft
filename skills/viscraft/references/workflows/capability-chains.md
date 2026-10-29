# Capability chains — what connects, and where a step is manual

Viscraft is a set of independent sub-capabilities that **chain**: one step's
output can become the next step's input. This page lists whole chains and, for
each one, the **choice rationale**, the **steps and commands that actually connect
them**, and the point where the work becomes a manual decision rather than an
automatic conversion.

Two rules of reading:

- A type, field or command existing is not evidence that a chain runs end to end.
  Check the actual request and its actual result before you rely on a chain.
- Generation here means **any configured Endpoint, bound by protocol, including a
  self-hosted service**. A simulated or `test-only` run proves the control chain
  and is always `simulated`; it is never art-quality evidence, and real paid
  generation is a separate, user-authorized step ([SKILL.md](../../SKILL.md)).

A third distinction runs through the page: a **missing automatic mechanism** (no
wired channel that does X for you) is not the same as an **impossible outcome**.
You, the agent, can often compose an equivalent by authoring code by hand from what
you observe or measure; what is absent is the automatic conversion, not your
ability to make the work. Each chain below states the wired mechanism and, where it
exists, the missing *channel* — never a blanket "cannot be done".

Per-step details live in the neighbours: [Reference map](../reference-map.md),
[Creative workflow](creative-workflow.md), [Generation recipes](generation-recipes.md),
[Finishing recipes](finishing-recipes.md).

## Keyframe → reference video → cut with code

**Choice rationale.** For a mixed short, code is exact for graphic/data/interface
shots and cheap to iterate; a photoreal or complex-motion shot may need a
generated Take. Anchoring generation to an approved keyframe gives the model a
concrete identity/composition to hold, and selecting the resulting Take back onto
the same timeline gives one continuous programme instead of two disconnected
files.

**How it connects.**

- Register the approved keyframe as an image Asset — `importAsset` (SDK only, no
  same-named CLI) byte-checks the file, hashes it and registers it
  ([Media preparation](../runtime/media-preparation.md)).
- Author a `provider` picture Source in `reference` mode naming that Asset as an
  `image` reference with role `identity`. A `first-last-frame` Source is a
  different contract: one or two `first-frame`/`last-frame` image references
  instead ([Generation inputs](../providers/generation-inputs.md)).
- Produce the candidate Take without placing it (`buildProject(root, { candidates })`
  or `viscraft build`), then select it by pointing `composition.placements[i].take`
  at it. The transmitted reference bytes are the imported keyframe Asset's bytes,
  and selecting a Take submits nothing again.
- Mix: put a browser Source/Take and the generated Take in adjacent placements on
  one `composition`; the `compose-video` operation composes both regardless of
  how each Take was produced.

**Where it stays manual.** Whether the generated shot matches the browser shot's
motion is a direction decision, not a Runtime guarantee, and there is **no
requirement** that it do so. The provider must be configured and its references
authorized per Asset (`authorization.submit` and `authorization.uploadAssets`). A
reference condition is not a fidelity promise: inspect the returned Take.

## Playable/game recording → output — two creation routes

**Choice rationale.** A recording of real play carries authentic action, motion
and camera feel. Depending on the goal you either adopt that picture as it is, or
use the recording (or a proxy of it) as the basis for a re-created final picture.
Neither route adds a Runtime auto-conversion channel, and the optional operations
inside them (blockout/white-boxing, keyframe extraction, image retouching, joint
video/image reference) are task-chosen, not a universal pipeline.

### Route 1 — proxy video → final video

Make or choose a motion/composition **proxy** for the task, then generate the
final picture per the required control and the **real model capability**.

- Register the proxy or recording as a video Asset with `importAsset`; it probes
  and decode-checks the file. When you only need part of the source, cut that
  interval out with media editing first, keeping the parent provenance, then
  import it.
- Reference it on a `mode: 'reference'` generation Source with
  `category: 'video'`, role `motion`. To use a proxy frame as a first/last frame,
  extract it (`promote-frame`) and register it as an image Asset first — a video
  reference in a `first-last-frame` Source is refused.
- Make the proxy with whatever the task needs — Browser/code or Blender. Do **not**
  mandate blockout, a World or Blender, and do **not** promise that a reference
  generation is a frame-faithful render of the proxy.
- Make the target image with an authorized, applicable host image tool or a
  configured image service; the Asset records the actual parent version/hash, not
  chat memory. When the motion layout must be kept, prefer reference editing and
  check pose, perspective, subject scale and contact. Do not pass an arbitrary
  pretty still off as the corresponding frame.
- Choose states per shot need — not a fixed first/mid/last three; do not retouch
  frames independently and stitch them into video. Say whether each material
  supplies motion/composition vs identity/material/lighting, and what may change.
- **Joint input.** For "the action/camera must continue but the look must be
  substantially redone", evaluate a JOINT input of *motion-reference video +
  compatible target-Look image* rather than expecting a single frame to reproduce
  a whole motion. Inspect [reference agreement and action readability](../craft/reference-adaptation.md#prepare-compatible-references-for-video-generation)
  before combining them; a role label does not isolate visual influence. If the original video is already good as a motion basis, keep it; if its
  low-quality texture/UI/old style interferes, prefer outputting a simplified
  proxy from an editable creation source. A proxy keeps the needed silhouette,
  occlusion, contact, trajectory, rhythm and camera; use distinguishing colours if
  needed, and do not equate a proxy with "desaturated" or "always pure white". If
  only a flat video exists, state the simplification method and check temporal
  consistency; never claim 3-D state was recovered. This is not automatic recovery
  of a 3-D scene, skeleton or true state from an arbitrary MP4.

### Route 2 — playable world → record → output as needed

Record real play, then output as the user needs: a directly adopted recording goes
straight into editing, sound and delivery, and only a re-creation hands the
recording to Route 1 as a `proxy_video`. A recording is **not** inherently a proxy
and need not be white-boxed or blockout first. New playable worlds/games include
user-operated recording and video download by default, authored in the work.
The downloaded file can itself be the user's final video; import it only when
continuing with editing or proxy-based re-creation. Review the game's controls,
contacts and capture cycle, including in the exported playable, as described in
[World and playable §1](../runtime/world-playable.md#1-playable-keyboard-recording-and-deterministic-replay).
For a controlled frame-clock playthrough instead, the mechanics — the `record`
command, the session and picture files it writes, the `recording` binding, replay
verification, and how to make a safe variant after a change — are in
[World and playable §1](../runtime/world-playable.md#1-playable-keyboard-recording-and-deterministic-replay).
Its execution contract and the standalone package are in the same page
([§3](../runtime/world-playable.md#3-standalone-live-playable-delivery-separate-from-the-movie-result)).

### Where it stays manual

- **The selected model sets what you can hand over.** Duration, frame rate,
  dimensions, aspect, format, reference count and whether a mode accepts a joint
  video reference are per-model contracts — read the card of the model you are
  about to call
  ([MiniMax-H3 card](../providers/models/minimax-h3.md),
  [Seedance 2.5 → reference video limits](../providers/models/seedance-25.md#reference-video-limits))
  and check the
  actual input against it. Crop, convert or trim only when the real input exceeds
  those limits, and keep the parent provenance of anything you derive. Per-adapter
  transmission also differs: a model may need an already-authorized, Asset-hash-bound
  hosted URL or `asset://` locator where another accepts an ordered upload, and the
  Runtime does not auto-publish local files.
- **There is no Runtime path from a recording or Take to a video Asset in one
  step.** A Take's bytes live under `.viscraft/artifacts/`, which `importAsset`
  refuses to register in place; the recording `preview.mp4` **is** authored material
  and can be imported. To reference an existing Take's bytes, first produce a real
  video file outside `.viscraft/` (a media edit) and import that.
- **Accepting a reference video is not evidence the model faithfully converts it**
  to a realistic look or motion, and a joint-reference mode does not equal
  deterministic adherence. Check that the chosen deployment and current Adapter can
  pass these materials together, and verify a short segment first, within
  authorization.

## Video → analysis → a new work

**Choice rationale.** A reference's measured rhythm and a tracked subject path
can be kept while the subject, environment and identity are deliberately
replaced — the honest way to "re-author" a reference without pretending to
recover its original project.

**How it connects.**

- `viscraft reference <project> <relative-media-path> [threshold]`
  (`analyzeReference`) → a `ReferenceReport` (cuts, segments, decoded frames,
  review stills) under the operation's returned `.viscraft/references/<key>/`
  directory.
- `viscraft track-reference <project> <relative-video-path> <#RRGGBB> [tolerance]`
  (`trackReferenceMarker`) → a `ReferenceTrack` of normalized positions for that
  colour marker.
- `planReferenceAdaptation(report, track)` (SDK) → a plan that keeps only
  **measured rhythm** and **measured path**, and explicitly names what it
  **replaces** (`subject`, `environment`, `identity`).
- Author new `browser` Sources and write the measured numbers (segment frame
  counts, path samples) into the Source `params`/`frames`
  ([Reference adaptation](../craft/reference-adaptation.md)).

**Where it stays manual — and what is missing.**

- Analysis results are **derived artifacts, not Assets**, and are **not exposed to
  author code at capture time**. A `browser` page only receives `ctx.params`,
  `ctx.bindings` (frozen Asset URLs) and, when a World is involved,
  `window.__viscraftWorldDefinition`/`__viscraftWorld`. So the report can be read
  by **you**, the agent, and transcribed into params — there is **no runtime
  channel** "analysis → playable author code".
- Explicit-colour marker matching is a 2-D image-plane path, **not** pose,
  segmentation or human motion.
- **No automatic video → playable-game conversion.** Nothing recovers a scene
  graph, skeleton or control rig from arbitrary video, and no runtime channel
  feeds an analysis report into author code — the report is a derived artifact you
  read and transcribe into `params`. That is the missing *mechanism*. It is **not**
  a statement that a game cannot be made: you can independently **author a new
  game** from what you observe or measure — write a real `browser`/World page with
  its own controls, then record/serve it through the normal flow — exactly as you
  could from any other brief. What is absent is the automatic recovery and
  one-click conversion, not the ability to compose the work.

## Video → promote frame → restyle → generation

**Choice rationale.** Existing footage often has one frame worth keeping as a
style/identity anchor. Promoting that exact decoded frame to an image Asset makes
it reusable and traceable; restyling it (host tool or image edit) and feeding the
result to a video request is a cheap way to change Look without regenerating from
text.

**How it connects.**

- `viscraft promote-frame <project> <options.json>` (`promoteFrame`) or
  `viscraft promote-range <project> <options.json>` (`promoteRange`, an explicit
  interval and stride) → real decoded source frames become `image` Assets with
  `derivedFrom` provenance and taint propagation.
- Restyle with either a **host tool**, whose output you register with `importAsset`,
  or a **`generate-image` operation** (`generate` or `edit`) whose request fields,
  reference roles and authorization are defined in
  [The `generate-image` operation](../providers/services/vllm-omni.md#1-the-generate-image-operation).
- Feed the resulting image to video generation as a `first-frame`/`last-frame`/
  `identity` reference.

**Where it stays manual.** The `generate-image` operation registers the returned
image as a **reusable Asset** (author-area, with the requested id/rights and
provider/model, request-hash and parent-asset-hash provenance) — it is no longer
captured as a one-frame Take, so a succeeded request re-runs to the same Asset
without paying again, and a registration failure is completed from the retained
original without regenerating. Real edit quality and a real cloud image model are a
separate question: a passing control chain is not art quality, so inspect what the
model actually returned.

## Music → picture

**Choice rationale.** A music bed can give a piece its cut grid. Measuring real
onsets from the actual track, then authoring picture and cuts to those times, is
more honest than guessing a tempo.

**How it connects.**

- `viscraft audio-reference <project> <relative-media-path> [threshold]`
  (`analyzeAudioReference`) → an `AudioReference` with `energy` rows and
  `onsets[] = { sample, outputFrame, strength }` on an exact sample grid (mapped
  onto the current output fps).
- Declare the grid as **time authority**:
  `composition.beats = [{ id, sample }]` (strictly increasing, inside the
  programme sample span).
- `viscraft review <project> [build-id]` reports, per placement/transition
  boundary, the nearest declared beat and the on-beat distance as facts.

**Where it stays manual — and what is missing.** The grid does **not drive** the
picture automatically. `composition.beats` never reaches
`captureCode`/`captureWorld`/Blender — no author page ever sees it — and no
command derives `composition.beats` from an `audio-reference` report. The working
method is: you read the onset list, author the code/params/cuts to those times,
and declare the grid so `review` can check alignment. An automatic "beats drive
the capture context" would need the beat markers passed into the capture
lifecycle; what exists is author-decided timing plus declared-grid validation.

## Sentence → game → trailer (+ a playable package)

**Choice rationale.** A game is a high-value way to turn one sentence into
interactive footage: playing produces actual game motion, captured footage can
be recut as a trailer, and the author code can ship as a standalone playable.
Only the frame-clock recording contract also verifies replayed state.

**How it connects.**

- Author the game as a `browser` + `output: 'picture'` Source, optionally with a
  `world` binding in `mode: 'define'`. Expose `window.viscraft.state()` when using
  Runtime frame-clock recording/replay. Include user-operated recording controls
  and video download by default ([live capture](../runtime/world-playable.md#choose-live-capture-or-deterministic-replay-for-the-purpose)).
- For a frame-clock playthrough, record it and set that Source's `recording`
  binding to replay to a Take. For user-driven live capture, author the recorder
  in the game and import its output as ordinary video instead.
- Trailer edit: put the replay Take (or a selected interval via `placement.take`)
  on the timeline with audio/subtitles, then `viscraft build` and `viscraft deliver`.
- Standalone playable: `viscraft export-playable <project> <source-id> [dest]`
  (`exportPlayable`) or `viscraft deliver --playable <source-id>`.

The commands' options, recording contract and what a standalone package contains
are in [World and playable](../runtime/world-playable.md).

**Where it stays manual.** The quality and complexity of the game is yours to
build. A trailer's music comes from code-authored sound (a `browser`
`output: 'sound'` Source) or an imported audio Asset — Viscraft provides **no
music-generation service**. Use the dedicated `preview` for checking ranges; never
edit the real timeline just to preview.

## Recording the result as a reusable recipe

When a chain works with a specific model/service version, keep the actual final
request in the Source (references, parameters, attempt), record the selected Take
intervals and dependencies, and state the observed scope and the parts you did
not observe. A single success supports a scoped observation, not a general
promise — especially for any real generated output.
