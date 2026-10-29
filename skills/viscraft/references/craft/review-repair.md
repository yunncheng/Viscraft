# Review and repair the delivered work

This page is **stage ⑥ (self-check and repair)** of the
[seven stages](../../SKILL.md#the-seven-stages-dependencies-not-steps): after doing the
work, inspect it and fix what is wrong *before* you deliver — not one
generation and done. Showing an unfinished passage to choose a direction is a
different act from delivering it. How to judge the actual cut and repair at the
level that caused the shortfall.

This page owns the *craft* of review and causal repair; the deterministic facts
you read live in [Timeline](../runtime/timeline.md) and
[Media analysis](../runtime/media-analysis.md), and the field semantics live in
[Runtime and authoring](../runtime/runtime-authoring.md).

**Contents**

1. [State the delivery promise](#state-the-delivery-promise)
2. [Review the final cut, not the implementation story](#review-the-final-cut-not-the-implementation-story)
3. [How to judge each craft area](#how-to-judge-each-craft-area)
4. [Diagnose the cause before spending another iteration](#diagnose-the-cause-before-spending-another-iteration)
5. [Compare a revision with the retained baseline](#compare-a-revision-with-the-retained-baseline)
6. [Repair at the highest available level](#repair-at-the-highest-available-level)
7. [Reference evidence before re-authoring](#reference-evidence-before-re-authoring)
8. [Compare candidate Takes before choosing](#compare-candidate-takes-before-choosing)
9. [Check the recipe beyond its showcase](#check-the-recipe-beyond-its-showcase)

## State the delivery promise

Use the same [whole-work/passage account](creative-method.md#establish-the-whole-work-and-its-changes)
that guided the plan: intended experience/content, retained facts, deliberate
changes and the constraints that matter at the delivery scale. Keep the useful
requirements in the existing Project/notes; do not write a different checklist
after seeing the output. Identify what evidence could establish each uncertain
requirement and which judgments remain unavailable. Technical conformance is
one part of that promise, not evidence that its meaning or quality was delivered.

## Review the final cut, not the implementation story

Separate what the evidence establishes: successful decoding and exact timing,
recognizable intended appearance, readable temporal behavior, and an effective
composition with sound. A pass in one dimension does not establish the others.
Review against the work's brief and chosen medium. Deliberate abstraction,
stillness, silence or a Look change can be valid; realism, maximum motion and
constant visual similarity are not universal quality targets.

Use `review <project-dir> [build-id]` to verify the selected Build and obtain
placement-scoped contact rows, cut seams and technical audio facts. Inspect actual
images with the host's image tool. If the host supports direct video/audio
perception, use it; otherwise describe the exact sampled stills and measurements,
and leave motion/listening judgments unverified. A file path, an operation exit
code or a high scene-score is not an observation.

When the host provides a reviewer — a sub-agent or a separate reviewing pass — give
it the delivered cut/stills, the delivery promise and the observation limitations.
This is a reviewer the host runs around delivery; it is not a chat model invoked
from inside Viscraft ([SKILL.md](../../SKILL.md)). Do not pre-explain every
implementation choice or why the author thinks it is correct. Ask it to identify
missing or unreadable action, inconsistent subject/material, accidental resets,
poor cut motivation, clipping/letter collisions and an incomplete ending. Treat
its artistic findings as review evidence, not an automatic numerical gate or
permission to change the user's intent.

Compare the actual whole composition and its temporal context with that same
account, not only an attractive crop or hero frame: the selected intervals with
their approach and consequence, against the accepted anchor as well as adjacent
material, so cumulative drift shows. The
[continuity account](creative-method.md#establish-the-whole-work-and-its-changes)
owns which relationships to compare and how they carry across a
[cross-media join](creative-method.md#design-both-sides-of-a-cross-media-join);
here the question is whether the delivered cut preserves them.

A passage holds together when its main action, its key visual change and its
sound serve the same expression; if they pull apart, or a neighbour needs an
explanation you never show, repair the passage or the join rather than captioning
it elsewhere. For a still, make the same deliberate-versus-accidental call on the
delivered file at output pixels and as a thumbnail; the composition checks belong
to [Design for the canvas](image-direction.md#design-for-the-canvas).

For each important requirement, distinguish an observed match, an observed
shortfall and something the available evidence cannot establish. A shared
reference, generated prompt or declared match cut records intent; it is not an
observation of the result. A static image may establish layout but not a contact
sequence, camera move or musical effect. If a retained fact changed without the
planned cause/context, repair the responsible material, selection or plan; do not
approve it because the protagonist still matches or conceal it with an effect.
Intended abstraction, ellipsis, silence and transformation remain valid when
their actual result serves the brief.

If the user finds the delivered meaning unreadable or the appearance below the
requested standard, record the relevant quality requirement as failed and repair
its cause. Calling the result "stylised" or listing duration, methods and working
tools does not waive that requirement. Preserve separate technical successes;
inability to perceive motion or sound limits the reviewer's claims and does not
overrule an actual viewer's negative review.

Report findings with a location (placement and frame/sample range), the observed
problem, its impact and a specific repair. Separate deterministic failures from
creative choices. Deliberate black fields, still holds, contrasts and axis changes
can be valid; do not conceal a decoder failure behind those exceptions.

## How to judge each craft area

Every item below is a **fact**; the Runtime does not judge quality — you do,
against the delivery promise. The fact fields are documented in
[Timeline](../runtime/timeline.md). `review` may also report
measurable facts such as static or repeated-frame intervals and cut-to-beat
distances: these carry no limit and no good/bad verdict — a long held shot or a
static passage can be exactly the intended effect, so read the numbers and decide
the intent yourself.

| Area | Read these facts | Do not conclude |
| --- | --- | --- |
| Cut and rhythm | cut-seam stills; per-boundary distance-to-beat; repeated-frame spans | that an off-beat cut or a held frame is a defect |
| Picture | placement-scoped contact rows; repeated-frame spans; black-frame spans | that a technically valid decode is a good composition |
| Sound | measured loudness/peak; per-clip `truncatedByProgrammeEnd`; per-keep-placement declared vs measured lead/tail | that a detected audio stream or an in-range LUFS is an approved soundtrack |
| Identity / continuity | the actual selected intervals across cuts at useful scales | that a palette average, a shared file or a fixed seed proves identity |
| Delivery | the bundle manifest and the `containsNonRedistributableAssets` marker | that a packaged private Asset is cleared for redistribution |

Inspect picture at its intended display size as well as useful close-ups. Trace
softness to the native source, canvas/backing buffer, intermediate resizing or
encoding before changing it. A 1080p container may contain enlarged 768p footage;
a small browsing preview is not the master. Re-render editable code at the needed
size, or obtain better source material when warranted; sharpening/upscaling alone
does not recover original detail. Intentional pixel art or a soft Look remains a
creative choice. See [canvas sizing](code-visuals.md#size-the-canvas-to-the-capture).

For a playable delivery, operate the actual page: navigation, object/surface
contacts and camera behaviour where relevant, then the default recording and
video download (unless explicitly omitted). Check a start/play/stop/download cycle
in the exported playable and decode the resulting file for moving picture,
intended sound, duration and dimensions. A movie review cannot establish these
interactions. The scoped examples
and live-capture/replay distinction are in
[World and playable](../runtime/world-playable.md#review-the-playable-work-through-real-input).

## Diagnose the cause before spending another iteration

Use an observed discrepancy to choose a causal repair, then check the affected
passage in its surrounding composition. A reaction names a felt shortfall; find
its observable cause before choosing the layer to change.

### Turn a reaction into a scoped change

"Bolder", "quieter", "simpler" or "more polished" is not a technique, and the
same word can come from different causes. Read it against the work's account,
name what is actually wrong, and change the layer that owns it. State the change,
the improvement it should produce and what must stay, so the comparison has
something specific to judge. The word alone does not prescribe more effects,
generation or a different concept; resource use stays within the existing
authorization. For a concrete finding,
[repair at the highest available level](#repair-at-the-highest-available-level)
names the field that owns it.

| The reaction | Look for this cause | Change | Protect |
| --- | --- | --- | --- |
| More impact | no focal point, a flat hierarchy, the key action or fact arrives without emphasis | primary/secondary proportion, composition tension, the timing of the decisive action or pause, one local sound accent | the real product and its facts, the agreed Look; stay within the existing authorization, and judge improvement rather than counting extra cuts, particles or model calls |
| More restraint | several colours, type sizes, movements, effects or sounds competing at once | remove or recede the competing layers, soften secondary contrast and pace, give the main information its hold | necessary information and deliberate drama, including an intended climax; do not automatically desaturate, mute tracks or switch to a minimal style |
| More simplicity | repeated information, passages with no job, an unclear structure | remove the redundant, regroup, merge duplicate statements | narrative cause and effect, functional facts, complete action; shorter is not automatically better |
| More polish or professionalism | one defect in type, proportion, material, contact, camera or asset quality, or in the sound | fix the responsible source, asset, edit or mix; compare at delivery size and in context | the goal, the character or cast structure, the approved degree of abstraction; do not silently switch to realism or blanket grain and glow |

The reaction can legitimately cover a scene or the whole work: when the user asks
for a full redo or a different direction, plan that version against the new goal
instead of shrinking it into a local tweak, and still keep the original material,
accepted results and unrelated approved work intact. Ask only when a
consequential ambiguity cannot reasonably be resolved from the brief or existing
decisions, or the resource/authorization scope changes. Routine choices need no
further confirmation, and a technically successful rebuild does not answer a
rejection of what the work is.

Feedback and review guidance is adapted from Impeccable and Taste Skill; see
the [source and licence notices](../../THIRD_PARTY_NOTICES.md).

### Match the discrepancy to its repair

The following are diagnostic categories, not subject-specific rules or automatic
scores:

| Observed discrepancy | Investigate | Useful first repair |
| --- | --- | --- |
| An attractive result changes the requested character structure, abstraction or complexity | The brief versus added design assumptions and the resulting method choice | Correct the design at its authored level and reassess the method; validate the affected appearance or action before expanding |
| Appearance misses the intended medium or material | Input quality, reference role, authored surfaces and realization method | Improve or replace the relevant asset/renderer/input; validate a representative frame |
| Important content is unclear | Hierarchy, scale, contrast, viewpoint, density and competing layers | Recompose or simplify at the authored level; inspect at delivery size |
| Action is missing, contradictory or unreadable | Initial/ending states, authored timing, requested behavior and backend control | Correct the state/motion plan or use a method with the required control; inspect a passage |
| Identity or state changes unexpectedly | Shared design, reference ambiguity, accumulating drift and cut context | Repair the relevant reference/binding/generation context or select a compatible accepted Take |
| Individually good shots fail together | Entry/exit composition, action phase, duration, sound and motivated transitions | Recut or adjust the composition using real handles before regenerating |
| Motion stutters or camera tracking feels stiff | Decoded timing/repetition, path and orientation, time mapping and camera response | Isolate the affected interval and distinguish a transport/timing fault from authored motion before choosing the repair below |
| Sound or pacing weakens the intended effect | Actual source sound, mix balance, envelopes, event positions and edit rhythm | Repair audio/timing on the common clock while preserving suitable picture |
| The work reads as unrelated clips | The intended direction and the Look each shot is meant to belong to — not whether one style was used throughout | Re-anchor on the intended direction and each shot's place in it, then recut with real handles. Intentionally different Looks are a legal choice; do not repair a real join problem by forcing one unified Look across the work |
| Two sounds express the same role, or dialogue is buried | Overlapping roles; no ducking | Keep one source per role, then declare `bus` roles and a ducking rule ([Sound design](sound-design.md#failure-repair)) |
| A costly generated shot is wrong | Reference quality, input state, backend control | Fix the input or method within the existing authorization; ask the user only when the scope changes; do not retry blindly |
| A song's ending is missing | A picture-length change truncated the clip at the programme end | Set `outputFrames` to protect the tail, then re-check the truncation fact |
| A revision changed unrelated shots | A global binding or Asset change | Make a scoped variant and reselect the unaffected accepted Take ids |

Distinguish an observation from a suspected cause. If the cause is uncertain,
make the smallest useful comparison before changing unrelated parts. State what
the repair is expected to improve, observe its outcome, and retain successful
material. Limit exploration to the authorized resources and useful alternatives;
when a route remains unsuitable, report the unresolved quality and propose a
different method. Repetition and a fresh attempt id are not a diagnosis.

For audio completeness, inspect the actual stream clock and decode the authored
beginning and ending, not just the MP4 container duration. Short clips and high
frame rates expose AAC flushing/priming errors that can fit within a one-video-frame
smoke tolerance. Viscraft bounds the final mix to `ceil(frames * sampleRate / fps)`,
encodes audio and video independently, and copies both completed streams into the
final MP4. The audio stream must start at zero and retain its sample span; decoded
trailing codec padding is not extra authored sound. Technical clock/PCM checks
still do not constitute listening or a musical-quality judgment. For the delivered
AAC peak versus the mastering gate, see
[mastering and AAC](../runtime/audio.md#optional-measured-audio-mastering).

### Diagnose three-dimensional appearance

Review the actual subject in its environment and intended lighting at delivery
size; for a playable work, include ordinary movement and reachable camera views.
A working interaction, a detailed model preview or a successful render does not
establish the integrated scene's appearance. Compare both the intended Look and
its finish quality: deliberate simplicity still calls for accomplished form,
composition and consistent treatment. Review the environment and connecting views
as well as the hero subject; use comparable finished work to calibrate craft when
the requested quality is implicit. Locate the shortfall before adding detail:

| Observed shortfall | Inspect and repair at the owning layer |
| --- | --- |
| The subject feels crude or assembled from disconnected pieces | Silhouette, proportions, joins, thickness and edge treatment in the visible geometry; change or replace the relevant model, rather than hiding it with effects. |
| The space feels generic, empty or arbitrarily crowded | Scale, arrangement, focal hierarchy, repeated modules and landmarks at the actual camera; improve the layout or purposeful set dressing rather than merely increasing object count or map size. |
| One polished asset sits in an unfinished world | Compare the craft of the subject with architecture, ground, vegetation and props where present, including ordinary routes; resolve the weaker surroundings or reduce scope rather than treating the hero asset as evidence of overall quality. |
| Surfaces look flat, plastic or inconsistent | Texture resolution/scale, UVs, normals and material regions under the scene's light; distinguish a bad material from an unsuitable lighting setup before replacing the asset. |
| Objects float, merge or lose their shape | Transforms, ground/contact geometry, light direction, shadow, reflection and exposure; fix the responsible geometry or lighting relationship. |
| A hero view works but normal play or another shot fails | Visible backs/sides, near surfaces, camera clipping and quality settings; compare the affected views and performance, then scope the repair to the actual delivery. |

Recheck the affected views and motion after the repair. A refined imported subject
can still sit in an unresolved environment, and more polygons or higher-resolution
maps alone need not improve the result. Implementation choices belong to
[3-D craft](code-visuals.md#build-three-dimensional-subjects-and-environments);
this diagnosis adds no automatic score or required realism.

### Diagnose proxy-to-video differences

First verify the actual submitted materials and the selected generated interval;
do not diagnose a missing upload from visual drift alone. Then use these as
hypotheses, not reliable predictions of a stochastic model:

| Observed | Inspect | Possible intervention |
| --- | --- | --- |
| The Look works but viewpoint, scale or layout drifts | Incidental composition in appearance references versus the proxy | Prepare a compatible shot view/state or reduce conflicting inputs while retaining needed identity/material evidence |
| Motion has the right gist but an important turn/contact is missing | Whether the event is visible at input resolution; occlusion and simultaneous subject/camera changes | Clarify the proxy's event and its approach/consequence, or choose more readable coverage within the approved intent |
| Motion follows but crude proxy geometry/shading survives | The visual conversion being asked of the supplied proxy | Improve relevant geometry/depth/light cues or prepare a staging-preserving target-Look frame; inspect both retained facts and finish |
| Each shot looks good but depicts a different space/state | Missing persistent landmarks or state; a common palette/image is the only connection | Prepare related views/states with the required landmarks, or select footage that preserves the relationship |
| Takes work individually but the cut resets or skips the action | Actual in/out points, action phase, handles and any retime | Reselect compatible intervals and inspect their surrounding motion before generating again |

Use [compatible reference preparation](reference-adaptation.md#prepare-compatible-references-for-video-generation)
and the [interval comparison helper](../runtime/media-analysis.md#compare-selected-video-intervals)
where useful. Separate an observed difference from its suspected cause and from
the outcome of a repair. Prioritize the few changes relevant to that diagnosis;
a controlled comparison can isolate uncertainty, but a one-variable experiment
is not mandatory for every creative revision. When references, prompt and seed
change together, record that bundle in existing author notes and do not attribute
the outcome to one change. No automatic fidelity score or attractive still can
accept missing action, and event-aligned/retimed views do not establish original
timing. If the route remains unable to preserve a required fact, change the
production method or report the remaining gap within the existing authorization.

### Diagnose stuttering or stiff motion

Locate the affected interval and compare the selected Take with the assembled
movie. If it already stutters in the Take, investigate its authoring or generation;
if it appears only after editing, inspect trimming, retiming and frame-rate
conversion. Check decoded timestamps and repeated-frame evidence separately from
the movement itself. Constant frame spacing does not prove continuous motion;
unique frames can still contain a subject or camera that jumps. Render wall time
does not determine the pacing of a correctly captured frame sequence. If the file
checks are sound but only playback stutters, investigate the actual player/decoder
before changing the work.

For available authored motion, inspect position, heading and camera target on
consecutive frames around the problem. A heading that stays fixed and then jumps
can come from coarse path tangents; a camera attached to that heading can amplify
the jump. Sudden speed changes can instead come from key interpolation, angle
wrapping or an incorrect time mapping. Treat these as hypotheses to check, not
assumed causes of every stutter. See
[Motion and cinematography](motion-cinematography.md).

Repair the responsible trajectory, orientation, camera or time mapping and
compare the same passage before/after, including its neighbors. Use displacement,
angular change or acceleration over the actual time step where informative;
choose tolerances for the shot and viewing scale, not a fixed global limit. Check
seeking/frame-order consistency for procedural repairs. For opaque Takes, select
better material, use a supported edit/regeneration or explicitly re-author the
motion; do not claim access to a hidden rig. More FPS, motion blur or frame
interpolation cannot by themselves repair a discontinuous authored path. Preserve
intentional holds, stepped timing, camera shake and cuts, and leave subjective
smoothness unverified when the host cannot observe motion.

### Judge whether the text is actually readable

Inspect every caption, label, number and UI panel at the **delivery viewing
scale**, not zoomed in on the authoring canvas — text that is crisp at 100 % can
be unreadable at the size the viewer actually sees. For each readable element,
find its **readable interval**: the span from when it has fully arrived until it
starts to leave. The animated entrance is not reading time, so measure the hold,
not the fade-in. Weigh that interval against the **delivery size, the content
complexity and the character count** — a short label can hold for a few frames,
a sentence or a table needs a real beat — and decide whether a viewer could
finish it; do not apply a universal per-character seconds rule.

Check **occlusion** explicitly: does any panel, wipe or moving subject cover the
text while it must be read? Trace the followed object and the text rectangle over
the same frames. When a full-screen UI is unreadably small, the repair is a real
local close-up or a real interface extract, not a larger font squeezed into the
same shot; when a caption is cut off, the fix is its composition range, not a
speed-up. Check the whole interval, not only the text rectangle: a secondary
label, ticker or panel that keeps changing during the hold competes for the same
attention, and background or container motion that carries the text can remove
the reference that made it legible. Never invent an interaction or a data value
to fill the beat. The author layout/motion method and the measure/wrap tool are
in [Code visuals → make the text the audience must read](code-visuals.md#make-the-text-the-audience-must-read).

## Compare a revision with the retained baseline

Keep the user-preferred or accepted result and its producing author state before
trying a materially new effect, Look or camera treatment — especially when the
change is hard to judge in isolation — so a rejected revision can return to it.
Recording that accepted Build as the baseline (with the approval scope in its
note) keeps it selectable after the live files move on; the commands, the byte
scopes they protect and how to list or return to a kept baseline are in
[Project lifecycle](../runtime/lifecycle.md#4-versions-versions-keep-revert). This
section owns only the decision to keep one. Do not attach current code to an older
movie and call it that movie's editable example.

Test the uncertain change in a short passage with surrounding action. Render the
candidate range with `viscraft preview <project-directory> --frames <start>:<end>` (or `--still N`, and
`--scale` for a cheaper size) — it renders real frames without writing the active
timeline or result, though an in-range `provider` Source with no Take yet may still
perform its first *authorized* generation — and compare it with the kept baseline at the same viewing
scale: did the requested effect improve, and did subject readability, performance,
lighting, continuity, pacing or the ending regress? Use the user's acceptance
scope, not a numerical feature count. Adding reflections, particles or model calls
is not evidence of an improved work. A shortened film also needs a new
pacing/sound review.

Fix what one observation pass found together, then re-check the affected passages
with their neighbours; re-reviewing every frame after each small change adds no
evidence. Watch what the change removed: if stripping decoration leaves the frame
emptier, if the shorter cut breaks an action, or if muting a layer weakens a
relation the work depended on, restore the element or choose another method — do
not accept a weaker result because the label said simpler or quieter.

Keep an experiment a candidate until this comparison supports selecting it;
retain the baseline as an available result. Follow existing delegated authority
for routine choices and the creative-review scope for consequential changes.
When the user rejects a revision, mark the relevant artistic requirements failed
even if Build, decoding and Provider generation succeeded. Repair the cause and
preserve suitable material; do not immediately replace the baseline with another
unchecked iteration. Event-state review is defined in
[Editing awareness](editing-awareness.md#carry-the-event-through-a-cut).

Useful checkpoints are the real hero frame, the rough cut/first Build, the reviewed
delivery and the repaired revision. They are creative artifacts of the host's chosen
workflow, not a fixed orchestrator or a mandatory human approval at every step.
Human decisions remain necessary where the user's taste or authorization is
required; an authorized agent can make routine creative approvals and record them.

## Repair at the highest available level

| Finding | First actual repair surface | Expected reuse |
| --- | --- | --- |
| Caption appears too early or is unreadable | `composition.subtitles` text/range/size/position | Takes, subtitle-free composition and mixed audio |
| Cut uses an awkward moment | Placement `inFrame`/`outFrame`/`startFrame` within real bounds | Accepted Takes; picture may be recomposed |
| One procedural shot has wrong colour or motion | That browser Source's parameters/code/resources | Unrelated Sources; affected picture downstream |
| Sound accent misses the action | Audio `startSample`, clip duration/gain/fades | Picture Takes and composition |
| Shared character/prop differs | Asset/Binding or real generation context | Only actual dependents; a global change can legitimately affect many shots |
| Recorded gameplay is a different simulation | Explicit new recording after changing executable input | Old accepted Takes stay inspectable; do not falsify replay equivalence |
| Host denies loopback/browser execution | Environment capability/permission diagnosis | Preserve source and last accepted Result; no sandbox bypass |

A generated Take is opaque: changing individual objects, their interaction or
performance requires a supported media edit, regeneration or explicit
re-authoring. Placement crops, time changes and gain do not recover separate
objects. Compare distinguishing structure, material and state at useful scales
across the actual selected intervals; an average palette is not identity. A
tighter selection can remove an awkward moment but cannot invent an unseen action
or resolution. Qualify temporal judgments when only sampled stills were observed,
and retain an unresolved quality limitation rather than declaring the intended
behavior proven.

Check the resulting Build's operation records and artifact identities after each
repair. New media must not silently replace an accepted Take in unrelated
placements. A failed repair must preserve the prior successful Result.

## Reference evidence before re-authoring

For an opaque video reference, identify the dimensions to retain and replace: cut
timing, palette, composition, camera language or action
([Reference adaptation](reference-adaptation.md)). Run actual PTS/cut analysis
([Media analysis](../runtime/media-analysis.md)); inspect the last usable frame
before the transition and the first stable frame after it, not merely a pretty
keyframe. Resolve uncertain candidate boundaries with real stills. The implemented
analyzer does not compute pose/depth, music BPM or motion heatmaps, so do not
claim those analyses were performed.

Write a new programmable spec: output-frame ranges, subject placement, motion
direction/amplitude, known constraints and uncertainties. Reference-derived timing
is not original authoring source. Keep private reference media out of portable
delivery unless its redistribution is explicitly authorized.

## Compare candidate Takes before choosing

When a shot has more than one candidate Source, build it with `candidates` so the
Build renders a Take for each rather than guessing. `review` then writes one
comparison strip per candidate shot — first, middle and last frame of **each
candidate Take's own artifact**, one row per candidate — and reports, per
candidate, its source, take id, real frame count, sha256 and whether it is the one
the edit currently uses (`selected`, derived from the frozen placements, never
guessed). Candidates do not change `project.json` or auto-select a winner.
`deliver` copies those strips into `review/`, hashes them into the manifest and lists
them in `index.html`.

Choosing is still an observational judgement on real frames: the strip is stills
only, so it does not show motion, pacing or how the candidate cuts against its
neighbours. Use `viscraft preview <project-directory> --frames <start>:<end>` to
watch **and listen to** the candidate interval with its neighbours in a real
render before you select it into the placement. A candidate that is not selected
is still a real, retained Take and can be chosen later by editing the placement;
nothing is discarded.

Candidate selection reuses the same lifecycle: once you accept a build that carries
the chosen Takes, keep that build as the baseline so the alternatives stay
listable and reversible
([Project lifecycle](../runtime/lifecycle.md#4-versions-versions-keep-revert)).
Isolate the choice from unrelated edits so the versions stay readable.

For reference adaptation, judge each candidate against the retained and replaced
dimensions, not only its standalone beauty. A pleasing new subject can still
lose an important gesture, relationship, cut or sound cue. Compare the actual
interval intended for the edit with its incoming and outgoing context. Keep an
accepted Take selected until an alternative meets the relevant requirements;
production success alone does not select it. No fixed candidate count is needed.

A scoped revision may use a new Asset and Source override while other placements
keep their accepted Takes. Material lineage does not rewrite those Takes or
regenerate children. State which inputs and selections changed, check the
resulting Build records, and observe the affected passage. Delivery should contain
the active version and reproducible permitted material, while the Project retains
useful candidates and authoring decisions. A source/output hash proves byte
identity or reuse; it does not prove perceptual continuity or editing quality.

## Check the recipe beyond its showcase

A chosen showcase does not prove that a parametric recipe holds. When the work
depends on one, it is worth trying it with a longer title, a short interval, a
different aspect ratio, a repeated placement and a colour with lower contrast, then
confirming frames still read clearly and captions stay in bounds. Never weaken a
check to keep a result looking green.
