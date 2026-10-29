# Reference map — find the page the current question needs

This is the **map of the whole reference library**, for when you do not already
know where a question is answered. It is an auxiliary lookup, **not a required
first stop**: the home page ([SKILL.md](../SKILL.md)) and
[Creative workflow](workflows/creative-workflow.md) link straight to the
specialist chapters, so go there directly when you already know what you need.

For complete works and reusable mechanisms, open [Creative references](creative-references.md) when choosing a starting point.

## SDK or CLI — one contract, two surfaces

The same operations are exposed twice, and they are the same contract, not two
languages:

- **SDK (`createProject`, `planBuild`, `buildProject`, ...)** — import from the Runtime library when you author or drive the work from your own code; this is the normal path while writing author scripts and configs.
- **Thin CLI (`viscraft <cmd> <dir>`)** — the shell entry for direct execution, diagnostics and scripting; use the verified launcher selected during startup. A Project-local installation is optional.

The CLI exposes the common authoring, production, inspection and delivery
operations. The SDK additionally exposes low-level renderers and provider helpers,
such as `renderSoundScene`; `exportPlayable` is available through both the SDK and
the `export-playable` command. The actual public surface is in
[Runtime and authoring](runtime/runtime-authoring.md); name a Project-relative
`.mjs` configuration for `plan`/`build` only when a Build needs Endpoint/provider
options.

## Find the page by the situation

Each row is a **trigger → the page and section that owns it → when you do NOT need
it**. Find the closest trigger and read only that section; the judgement itself is
made by you, not by the map. Whole capability chains are in
[Capability chains](workflows/capability-chains.md); finishing passes are in
[Finishing recipes](workflows/finishing-recipes.md).

| Trigger (the situation you are actually in) | Go to (exact page / section) | You do NOT need it when |
| --- | --- | --- |
| New task, no method chosen yet | [Creative method → choose the medium](craft/creative-method.md#choose-the-medium-for-the-required-control) | The method is fixed by the brief or by prior Project state |
| About to depend on a capability (a tool, service, backend, the host's own image tool) | [Startup checks → check the requirements](runtime/preflight.md#check-the-requirements-of-this-work) | The entry is settled and unchanged this session |
| You have chosen a generation model | [Model guidance](providers/model-guides.md) → the model page, plus its service contract ([vllm-omni-video](providers/services/vllm-omni.md) / [ark](providers/services/ark.md) / [runway](providers/services/runway.md) / [fal](providers/services/fal.md)) | The route needs no generation service |
| A provider key or Endpoint is missing, or you must not put a key in chat | [Provider setup](providers/setup.md) | A capability is configured, or the task uses no provider |
| Editing an existing MP4 with attached material (re-cut / portrait / shorter) | [Timeline → flat-media reframing](runtime/timeline.md#flat-media-reframing-and-alternate-format-shorts) + [Editing awareness](craft/editing-awareness.md) | You are editing a real authored timeline with real Sources |
| Adapting a supplied reference (subject / content / Look) | [Reference adaptation](craft/reference-adaptation.md) + [Media analysis](runtime/media-analysis.md) | There is no supplied reference |
| Only changing music or subtitles | [Timeline → subtitles](runtime/timeline.md#subtitle-sidecar-srt) and [→ sidechain ducking](runtime/audio.md#automatic-sidechain-ducking) plus reuse | The change is not audio/subtitle-only |
| Only making or changing sound | [Audio → code-authored sound](runtime/audio.md#code-authored-sound-browser-output-sound-source), [→ mastering](runtime/audio.md#optional-measured-audio-mastering), [Sound design](craft/sound-design.md) | The work has no soundtrack |
| A Take carries sound — keep / process / combine | [Sound design](craft/sound-design.md) + [Audio → coordinate sound by role](runtime/audio.md#coordinate-sound-by-role-not-by-a-single-authority) | The work has no soundtrack, or that Take's sound is settled |
| One shot reads well but the join does not | [Editing awareness → carry the event](craft/editing-awareness.md#carry-the-event-through-a-cut) + [Review and repair](craft/review-repair.md) | Each shot *and* the join already work |
| Making a multi-shot film that mixes methods | [Creative workflow](workflows/creative-workflow.md) + [Creative method](craft/creative-method.md) + [Capability chains](workflows/capability-chains.md) | Your task is a single medium (pure image / pure sound / a game) |
| Developing the Look and imagery | [Image direction](craft/image-direction.md) | Imagery is already approved for its role |
| Making motion and camera read | [Motion and cinematography](craft/motion-cinematography.md) | The shot is static by intent |
| Authoring visuals in code | [Code visuals](craft/code-visuals.md) + [Runtime and authoring](runtime/runtime-authoring.md) | You are not drawing this part in code |
| Developing a Look or adapting an existing visual mechanism | [Reuse the working author module](craft/code-visuals.md#reuse-the-working-author-module) + the [creative references](creative-references.md) | Existing material already fits the work |
| When the task needs a specific medium's own layers (ink, flat cartoon, indexed pixels) | [Code visuals → build the Look from mechanisms](craft/code-visuals.md#build-the-look-from-mechanisms) + the matching [study](creative-references.md) | A general painted or product Look already fits |
| Combining mechanisms from one or more references, or changing an adopted file | [Reuse the working author module](craft/code-visuals.md#reuse-the-working-author-module) + [publish a recipe / declare files](runtime/runtime-authoring.md#publish-a-recipe-through-the-one-authoring-boundary) + [edit at the highest authoring layer](runtime/runtime-authoring.md#92-edit-at-the-highest-available-authoring-layer) | One mechanism already fits and you are not changing an adopted file |
| Auditing / sampling how a work was made | [Review and repair](craft/review-repair.md) + [Media analysis → observe honestly](runtime/media-analysis.md#1-observe-honestly) | You are producing, not reviewing |
| Comparing candidate Takes before choosing | [Review and repair → compare candidates](craft/review-repair.md#compare-candidate-takes-before-choosing) | A single Take is already selected |
| Preparing proxy/appearance references, or diagnosing why generated motion/layout differs | [Reference adaptation → compatible references](craft/reference-adaptation.md#prepare-compatible-references-for-video-generation) + [Review and repair → proxy differences](craft/review-repair.md#diagnose-proxy-to-video-differences) | There is no reference-conditioned generation or the relevant behavior is already accepted |
| Comparing actual intervals from a proxy, candidate or revision | [Media analysis → interval comparison](runtime/media-analysis.md#compare-selected-video-intervals) | Build review already supplies the needed evidence |
| Cutting to a beat / from a soundtrack — measured onsets are editorial evidence; a declared grid is a clock, not a content classifier | [Media analysis → audio-reference](runtime/media-analysis.md#4-audio-reference-evidence-for-editing) + [Timeline → beat grid](runtime/timeline.md#beat-grid-and-explicit-programme-length) | There is no music grid to cut to |
| Making an interactive / shared-World work or a gameplay trailer | [World and Playable](runtime/world-playable.md) | The work is a linear film with no interaction |
| You have a game/playable recording and must decide how to use it | [Capability chains → two creation routes](workflows/capability-chains.md#playablegame-recording--output--two-creation-routes) | You have no playable recording, or its use is already decided |
| Producing a pure image or an image edit (non-film) | [Generation inputs → non-film exit](providers/generation-inputs.md#non-film-exit-a-still-image) + [Media preparation](runtime/media-preparation.md#2-import-approved-host-tool-material) + [Image direction → editable stills](craft/image-direction.md#editable-stills-the-image-route) | The image is only an intermediate of a film |
| Delivering a still — every delivered final image keeps a live editing entry | [Image direction → editable stills](craft/image-direction.md#editable-stills-the-image-route) + [Delivery](runtime/delivery.md) | The still is only an intermediate of a film |
| Producing a pure sound / music piece (non-film) | [Audio → code-authored sound](runtime/audio.md#code-authored-sound-browser-output-sound-source) — declare `soundTargets`, then `build --target <id>` and `deliver --sound <id>` | The sound is only a track of a film |
| Sound must carry structure (sections, accents, a rest) | [Sound design → structured sound](craft/sound-design.md#structured-sound) | One sustained bed or a supplied track already fits |
| Producing a playable work (non-film) | [World and Playable → standalone delivery](runtime/world-playable.md#3-standalone-live-playable-delivery-separate-from-the-movie-result) | The only deliverable is a film |
| Importing or preparing approved material | [Media preparation](runtime/media-preparation.md) + [Media acquisition](runtime/media-acquisition.md) | Material is already registered |
| Finding material on the web (choose, license, download, attribute) | [Media acquisition](runtime/media-acquisition.md) | You are using supplied or authored material |
| Using a generation provider; judging real vs simulated | [Model guidance](providers/model-guides.md) + [Service execution](providers/service-execution.md) | No provider is involved |
| Connecting a new image/video model | [Model integration](providers/model-integration.md) | The model is already packaged |
| Content or relationships must persist through a state/view/Look/producer change or a revision, inside one shot or across segments | [Whole-passage relationships](craft/creative-method.md#establish-the-whole-work-and-its-changes); [cross-media joins](craft/creative-method.md#design-both-sides-of-a-cross-media-join) when producers differ; [Editing awareness](craft/editing-awareness.md) for actual cuts | No relevant shared facts or changes are involved |
| Applying a known-good finishing pass (transition, fade, beat grid, subtitles, stems, held frames) | [Finishing recipes](workflows/finishing-recipes.md) — one index row per ask, each linking its exact section | You are not doing that finishing pass |
| Repairing a failed delivery or recovering space | [Review and repair](craft/review-repair.md) + [Project lifecycle](runtime/lifecycle.md) | Nothing failed and nothing needs reclaiming |
| Repairing stiff or stuttering motion / camera tracking | [Motion and cinematography](craft/motion-cinematography.md) + [Review and repair → diagnose stuttering](craft/review-repair.md#diagnose-stuttering-or-stiff-motion) | Motion already reads as intended |
| Picture and sound must land on one physical event (contact, impact, strike) | [Timeline → one authored event](runtime/timeline.md#tie-picture-sound-and-subtitle-to-one-authored-event) | The action and its sound are unrelated |
| Delivering (including privately) | [Delivery](runtime/delivery.md) | You are only keeping the editable Project |
| The user (or a later session) must continue the work | [Delivery](runtime/delivery.md) + [Runtime and authoring §9](runtime/runtime-authoring.md#9-resuming-and-handing-off-an-existing-project) | The work stays with you and needs no handoff |

## When to choose X vs Y (the cross-cutting ones)

- **Kept audio.** A kept Take's own track is shaped in place: `audioLeadSamples`
  (the **true J-cut**), `audioTailSamples` (the **true L-cut**) and
  `audioOffsetSamples` (a deliberate whole-clip shift that **breaks in-clip sync**,
  never a J-cut). All three require `audio: 'keep'`. Adding a bed needs no
  extraction; extract only when the sound must be handled independently. Contracts:
  [Audio ](runtime/audio.md#shaping-a-kept-takes-own-audio--the-true-j-cut-and-l-cut),
  [Media preparation §5](runtime/media-preparation.md#5-prepare-audio-from-an-existing-recording).
- **Cut shape.** A hard cut for independent shots; a `composition.transition` only
  over a genuine overlap. A wipe/slide is a bounded `xfade`, `whipleft`/`whipright`
  add a smear (not true motion blur), and `occlude` needs a real occluder Asset.
  A `matchCut` is an author's *assertion*, not a rendered effect.
- **Native vs mixed track.** Judge keep / process / replace by content and
  observation, not by origin: without a separation tool you cannot rebalance a mixed
  track's music *independently* of its dialogue, and a `bus` is a routing label, not
  source separation — [Sound design](craft/sound-design.md),
  [Audio ](runtime/audio.md#coordinate-sound-by-role-not-by-a-single-authority).
- **Music vs foreground.** `composition.ducking` (`{ target, control }`) is automatic,
  bus-keyed sidechain; a clip's `automation` is a hand-drawn envelope, not detection.
- **Timing and length.** `composition.beats` declares the grid cuts are audited
  against (a fact, never a verdict); `composition.outputFrames` states the exact
  programme length and pads black + silence, and must not be shorter than the content.

The runtime pages hold parameter minutiae and fact reports; read only what the task
needs. They grant no extra commands or promises.
