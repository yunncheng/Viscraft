# Reference adaptation

How to turn a supplied reference into a new, revisable work. This page owns the
*craft* of adaptation — the retain/replace decision and route choice; the actual
measurement lives in [Media analysis](../runtime/media-analysis.md), material
intake in [Media preparation](../runtime/media-preparation.md), and generation
modes in [Service execution](../providers/service-execution.md).

## Goal

Describe the commission in retain/replace terms before selecting tools, then
choose a route that can actually meet the retained constraints. The failure this
prevents is promising "unchanged regions" or "the same performance" from a route
that only offers a loose reference condition — reference-driven generation may
reinterpret motion, camera and background.

## Conditions

- The reference is available as opaque media (or an existing Project).
- You know which qualities must be retained exactly and which may change.
- You have resolved the redistribution rights of any material you will carry.

## Implementation entry

- **Existing editable Project** — modify its actual Source, Binding or Composition
  and keep accepted Takes where the change permits
  ([Runtime and authoring](../runtime/runtime-authoring.md)).
- **Opaque media, ordinary edits** — trim/reframe/sound edits preserve source
  pixels within their scope ([Timeline](../runtime/timeline.md)).
- **Analyze timing first** — cut/PTS analysis supplies timing candidates, never a
  full explanation or a recovered source ([Media analysis](../runtime/media-analysis.md)).
- **Prepare and import material** — a host image tool or licensed art, admitted
  through `importAsset` ([Image direction](image-direction.md),
  [Media preparation](../runtime/media-preparation.md)).
- **Reference-driven generation** — a supported video provider with suitable
  image/video conditions, producing candidate Takes
  ([Service execution](../providers/service-execution.md), [Generation inputs](../providers/generation-inputs.md)).
- **Bounded graphic adaptation** — `planReferenceAdaptation` connects measured
  reference timing (a `reference-analysis` report) and marker motion (a
  `reference-track`) to a concrete adaptation path: it keeps the measured rhythm
  and action/path and replaces subject/environment/identity, requiring full marker
  coverage by default. Use it to drive real image-bound CodeScene candidates
  ([Media analysis](../runtime/media-analysis.md#5-foreground-measurement-and-adaptation-planning)).

## Directing choices

Describe the commission in retain/replace terms first:

| Dimension | Useful distinction |
| --- | --- |
| Subject and content | Change identity, clothing, object or wording; retain the required relationships and meaning |
| Appearance and framing | Preserve composition or change Look/viewpoint; determine whether unchanged regions must remain exact |
| Temporal behavior | Preserve actual performance, only its rhythm, or a newly directed counterpart; identify meaningful source intervals |
| Sound | Keep original audio, revise selected sounds, or produce new sound; check permitted use and synchronization |

Then:

- **Map source PTS to the output grid once.** Source decoded indices are not
  interchangeable with output timeline frames; do not remap twice
  ([Media analysis](../runtime/media-analysis.md)).
- **Give references clear roles** and distinguish approved appearance from technical
  validity. Merely saving a file does not make it a dependency; connect it through
  declared resources/Bindings or supported generation inputs.
- **Judge candidates against the retained dimensions**, not standalone beauty. A
  pleasing new subject can still lose an important gesture, relationship, cut or
  sound cue. Compare the actual interval with its incoming/outgoing context.
- **Re-author controllable graphics in Code** when that suits the expression; it is
  a new editable work guided by observed behavior, not a recovery of the
  reference's Source. A plan or animatic remains a preparation result when the
  final medium is unavailable.
- **Preserve original audio when permitted** and when the new timing supports it;
  generated footage does not automatically remain synchronized to an old
  performance.

## Prepare compatible references for video generation

Use this when a proxy or recording supplies motion while the final appearance
must change. The model receives pictures, not the editable scene's guarantees.
A route map, camera matrix or timed instruction can guide your authoring, but
only an implemented conditioning input can constrain a provider. Role labels
describe intent; they do not isolate what each reference influences.

**Inspect the references together.** A style image also depicts a subject scale,
viewpoint, layout and action state; a motion proxy also depicts geometry,
materials and lighting. Compare those incidental facts against what must carry.
When a whole-scene appearance image conflicts with the shot, prepare a compatible
view/state or use a more relevant reference within the model's supported inputs.
A shared Look need not mean reusing the same whole-scene image for every shot.
Removing the appearance image is one possible intervention, not a general cure:
it can also remove necessary material or identity information. Separate requests
share no persistent scene merely because they share an image or palette.

**Make the needed action visible in the proxy.** Check subject size, silhouette,
occlusion, depth cues, camera behavior and the approach/change/consequence of the
important event at the resolution the model will receive. If a turn is legible
only on a top-down route diagram, improve its screen presentation. Distinguish
subject motion from camera motion and reduce competing changes when they hide
the primary action. A clearer passage or different coverage may help; splitting
every action into separate requests can itself lose continuity.

**Choose how far the appearance must travel.** A deliberately simple proxy is
useful when it preserves readable staging. If its crude shape or shading keeps
surviving into candidates, improve the relevant silhouette/depth/basic lighting,
or derive a target-Look frame that retains the needed composition and state.
Inspect the derived image against both the staging and the desired material;
image editing can change geometry too. Do not require photoreal proxies, image
generation, or a fixed number of keyframes for all work. Existing suitable media
may already be enough. Concrete cross-media preparation lives in
[Generation recipes](../workflows/generation-recipes.md#keep-a-subject-scene-or-action-consistent-across-several-generated-shots).

**Check a candidate against the retained facts.** Select actual source intervals
and compare equal elapsed time first when timing matters. An optional manual
event alignment reveals action shape around that event while exposing its offset;
a normalized-progress overview retimes the comparison and cannot prove timing
adherence. The [local comparison helper](../runtime/media-analysis.md#compare-selected-video-intervals)
produces labelled evidence. Camera/route checks on an authored World establish
the proxy's behavior only; they cannot certify opaque generated pixels. Keep the
accepted intent as the baseline and record shortfalls without rewriting it to
match a pleasing but different candidate.

## Recipe: measured reference analysis → Shot/Placement authoring

Use this when you want a reference's **timing** and a measured **marker path** to
shape a new, editable work while replacing subject/environment/identity. The
measurement lives in [Media analysis](../runtime/media-analysis.md); this is how to
turn it into authoring. Nothing here converts a reference into a Composition for
you — the agent authors the resulting Shots and Placements itself.

1. **Measure timing** with `analyzeReference(root, relativePath, { fps?, threshold? })`
   (CLI `reference`). Its `ReferenceReport` carries heuristic cut candidates and
   `segments` — half-open output-frame intervals that tile the output timeline.
   Open the extracted review stills around every proposed cut first: scores are
   FFmpeg scene-score heuristics, **not** semantic shots.
2. **Measure the marker** with `trackReferenceMarker(root, relativePath, { color,
   tolerance?, minPixels?, roi?, fps? })` (CLI `track-reference`) — a flat-colour
   **2-D** marker trajectory with one normalized `x/y` per decoded frame, mapped to
   `outputFrame` on the same clock. Inspect `summarizeReferenceTrack(track)` for gap
   and partial-visibility spans and confidence statistics before trusting it.
3. **Plan the retained targets** with `planReferenceAdaptation(report, track,
   { requireFullCoverage? })` → `AdaptationPlan`. It keeps exactly **rhythm** (the
   report's output-timeline `segments`) and **action/path** (the marker resampled to
   one sample per output frame) and explicitly replaces subject, environment and
   identity. Full marker coverage is required by default; a missing frame is a loud
   error, not an invented sample (`requireFullCoverage: false` opts into a
   segment-local hold, with a centre fallback at a segment-start gap). Those
   positions are not measured. The plan is a derived artifact — it registers no Asset
   and mutates no Project.
4. **Author the Shots/Placements yourself** from the plan:
   - **Shot lengths / cut points** — for each plan `segment` make a retain/replace
     decision against the brief, then set real `composition.shots[].targetFrames`
     and placement boundaries (`inFrame`/`startFrame`). Each non-first
     `segment.startFrame` (also listed in `keptRhythmBoundaries`) is a measured cut
     candidate; the `segments` already tile the output timeline, so they map directly
     onto placement intervals. Do not remap PTS a second time.
   - **Motion/anchor constraint** — feed the per-frame `segment.path` (`x/y` in
     [0, 1] over the source frame) into a new `browser` Source's `params` so a *new*
     subject follows the same measured path. Positions are normalized to the full
     source frame, so scale them to your own output canvas.
   - **Scope the rebuild** — a reference-derived change touches only the Sources it
     constrains; let the rest reuse their Takes, and preview with `planBuild`/`plan`
     ([Reference adaptation → Existing editable Project](#implementation-entry)).

**Bound it honestly.** `AdaptationPlan` carries no pixels. A flat-colour marker
path is a **2-D image-plane path** — it is **not** pose, depth, segmentation,
identity or human-motion transfer, and no automatic "reference → Composition"
converter exists. Reference-derived timing is not original authoring source, and a
plan/animatic remains a preparation result when the final medium is unavailable.

## Failure repair

| Observed | Investigate | First repair |
| --- | --- | --- |
| The new work loses the reference's point | The retained relationship was not actually preserved | Re-check the retain/replace table; re-author the missing relationship |
| A "match" is only approximate | The route offers a reference *condition*, not exact control | State the gap, or change method/input; do not call it identity transfer |
| A changed image was meant to be a video edit | A changed image alone is not video editing | Use a supported video-editing tool/service or explicitly new production |
| Motion looks plausible but wrong | Reference-driven generation reinterpreted motion | Add an actual control input if the backend supports it, or re-author the motion |

## Match study depth to the borrowing goal

Research depth should match what you are borrowing, not the reference's whole
duration:

- **Composition and material** — representative frames are enough to read framing,
  palette and surface.
- **Camera movement, performance, edit rhythm and sound** — watch the actual clips
  and listen; stills cannot carry motion, timing or audio.
- **Identity or an exact relationship** — inspect the specific intervals the new
  work must retain, not a single pretty keyframe.

State which of these the host could actually perceive. Without motion or audio
perception, keep those judgments explicitly unverified rather than implying the
reference was watched or heard.

## Worked example: observation → decision → author implementation

Not every task needs a reference hunt, and a reference is never copied wholesale: you
observe how it works, decide what to borrow, and author something new. The observation
is not "it looks like some advert" — it is a short list of concrete, checkable facts,
and each is stated as an **observed fact** (you perceived it), a **creative inference**
(you chose to try it) or **unverified** (you could not perceive it). This connects to
[Assign each reference a purpose](creative-method.md#assign-each-reference-a-purpose);
the measurement itself lives in [Media analysis](../runtime/media-analysis.md) and
[Media preparation](../runtime/media-preparation.md), not here.

For a short product teaser, watching the actual clip turns into new design choices:

| Observation of the reference | Kind | New design choice and author parameter |
| --- | --- | --- |
| The product is the only high-contrast element; the background stays low-contrast early | observed fact | Use hierarchy: widest value separation on the product, flat environment until the reveal; set the CodeScene's light and palette to match |
| Surfaces read as brushed metal and matte glass | observed fact | Choose that described material family for your own geometry; the reference's exact surface detail stays unverified |
| A single accent colour appears only at the reveal | observed fact | Reserve one accent colour for the emphasis event and hold it out of earlier frames |
| A slow camera push, then one decisive cut at the reveal | observed fact (motion) — the claim that this pace "feels premium" is **creative inference** | Author a slow push with one landing cut; the frame count is your own timing choice, not the reference's |
| One low note lands with the reveal, then silence | observed fact if you could listen, otherwise **unverified** | Place one low sound or sample on the reveal event and a deliberate silence after it; if you could not listen, mark the relationship unverified |

Then author for real and check the actual output, not the reference: render the passage,
inspect the real frames and sound, and say what carried over (hierarchy, accent colour,
one landing beat) against what changed (materials, timing, subject). A still frame proves
nothing about the camera move, the pace or the sound, so those stay unverified until you
watch a passage. This is a new, editable work guided by observed behavior — it does not
recover the reference's original layers, its character motion or any video project, and
it is not a promise to match one.

## Evidence scope

A representative still cannot establish an interaction or a complete performance;
inspect enough of an entrance, action and exit. Reference-derived timing is not
original authoring source. No adapter here supplies general segmentation, pose
transfer or exact person replacement; if a route cannot meet a strict retained
constraint, explain the specific gap before presenting an altered scope as
completed. A hash proves byte identity or reuse, never perceptual continuity
([Review and repair](review-repair.md)).
