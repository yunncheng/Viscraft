# Creative method — decide what the audience should perceive

This page is the detail behind **stages ③ (creative plan) and ④ (show a direction)**
of the [seven stages](../../SKILL.md#the-seven-stages-dependencies-not-steps). The
[whole-work account](#establish-the-whole-work-and-its-changes) carries the relevant
facts and intended changes from planning through production and review. The
[method decision](#choose-the-medium-for-the-required-control) weighs achievable
quality, control and production effort against that account. Showing a
direction is **optional and cost-driven** — present the cheapest form that
answers the open question, or skip it entirely when one method is already enough.
Nothing here is a mandatory step, and no step grants permission to spend money,
upload references or redistribute an asset.

Creative direction for the host agent, not another Runtime pipeline. Use the actual
available Code, imported media, host tools and providers.

This page owns the *decisions*: what effect to make, which medium and which
references serve it, and when to validate before expanding. The detailed craft
lives in the sibling pages — [Image direction](image-direction.md),
[Motion and cinematography](motion-cinematography.md),
[Editing awareness](editing-awareness.md), [Sound design](sound-design.md),
[Code visuals](code-visuals.md), [Reference adaptation](reference-adaptation.md)
and [Review and repair](review-repair.md). Execution contracts live under
`../runtime/`, provider modes under `../providers/`, and end-to-end recipes under
`../workflows/`.

## Translate intent into a visual and temporal language

Establish the audience effect and the few qualities that carry it. Derive choices
from the brief, supplied material and intended delivery, rather than treating
"cinematic", "premium" or a medium name as a complete design. Use the dimensions
that matter to this work:

| Dimension | Decision to make | Evidence to inspect |
| --- | --- | --- |
| Meaning and content | What should the audience understand, read, hear or feel, and what supplied facts/content must stay true? | Readable meaning, accurate wording/data and the intended emphasis |
| Subjects and relationships | Who or what matters, and how do they relate, act on or support one another? | Identity/design, proportions, count, prop ownership, contact and performance |
| Scene and spatial structure | What arrangement makes the event or composition possible? | Layout, salient landmarks, surfaces, scale, depth and relative positions |
| Form and material | Which shapes, surface processes and degree of abstraction express the intended Look? | Actual surfaces and edges at the delivery scale, not shader/model names |
| Composition and viewpoint | What is revealed, withheld or compared, from which position and at what size? | Framing, perspective, visibility/occlusion, separation and legibility |
| Light and colour | How do values, contrast and palette direct attention and establish mood? | Readable regions, subject/background relationships and motivated changes |
| Time and motion | What changes, why, and how does the audience follow the change? | States, trajectory, anticipation, emphasis, holds and handoffs |
| Sound and rhythm | What does sound add to the action, emotion or comprehension? | Actual timing, foreground/background balance and the beginning and ending |

These are decision dimensions, not mandatory fields or a fixed film pipeline.
Record the useful decisions in existing Direction/Look/Shot authoring surfaces
(the Project schema is documented in [Runtime and authoring](../runtime/runtime-authoring.md));
keep temporary exploration in ordinary working notes. An intentional flat or
abstract treatment can be excellent. Realism is a requirement only when the
brief calls for it. Match review depth to the commission and uncertainty.

**Separate style, detail and finish quality.** Pixel art, cartoon, low-poly and
photorealism describe visual languages, not levels of quality. Visible detail is
one design choice; finish also depends on deliberate form, composition, coherent
materials and lighting, readable motion and consistency across the whole work.
For a finished delivery, aim for a polished, aesthetically resolved result unless
the user asks for a sketch or prototype. When the brief leaves the finish implicit,
use mature released work in a comparable style and delivery context to calibrate
craft, including commercial-game art for a playable world; this does not require
matching its production scale or photorealism. Check the subject and environment
together. If scope or available resources prevent that finish, favour a smaller
coherent result where the brief allows, and explain the remaining limitation;
do not silently substitute a technical demo or call roughness a style.

**Derive the device from the subject.** A composition earns its place by turning
one specific thing about this subject — its shape or cross-section, a material
and how it behaves, the way it is used, what it actually produces, or the place
and routine around it — into what carries the meaning: the element seen first,
the change the passage performs, the sound that explains the sequence. Decide
what the device helps the viewer understand. Not every work needs an invented
metaphor; an explanatory image is usually better served by direct structure than
by a conceit, and a familiar composition is right when it carries the content
clearly.

Keep the subject's evidence distinct from atmosphere. Its real space, product
structure, wording, labels or output cannot be swapped for attractive but
unrelated stock, and features, figures, testimonials or results the supplied
material does not contain are not invented to fill a layout. Describe the device
as a visible relationship — what appears first, what carries the information,
what changes, and what that change tells the viewer. If substituting another
brand or place leaves the whole thing intact, ask whether it is a category
template rather than this subject's device; treat that as a diagnostic, not a
standing demand for novelty.

Subject-derived design guidance is adapted from Taste Skill; see the
[source and licence notices](../../THIRD_PARTY_NOTICES.md).

Keep the user's explicit design choices distinct from your additions. Decide the
degree of abstraction, character structure, scene complexity and motion language
separately from the production tool. Added anatomy, costume, surface detail or
environment must support the brief. "Cinematic" and "premium" do not prescribe
photorealism, elaborate sets or video generation; simplicity and playfulness can
be carried by deliberate shapes, colour, staging, motion and sound. Record only
the choices that matter in the existing authoring state or handoff notes.

## Plan the visible event before choosing coverage

For work whose meaning depends on an action or change, identify what the audience
must understand before and after the passage, and which visible or audible event
connects those states. Then choose coverage that can actually convey it. A Shot
intent saying "the attempt fails" is insufficient when the selected material
shows neither the attempt nor its consequence. A shared World clock establishes
execution time, not the audience's understanding of an off-screen event.

Use existing Shot intent and ordinary planning notes to relate the intended
information to the necessary subject, setting, action and cut context. Check that
authoring and generation requests express those requirements. An identity-only
reference need not preserve its background; retaining a display setting can
prevent a shot from communicating an event in the intended location.

Choose a representative passage that tests the hardest relationship in the work —
an action and its consequence, a camera change, a key cut point, a sound
carry-over or a cross-Look state — not a few easy, isolated pretty frames. Include
the adjacent context the relationship depends on, and execute the preview over
real frames with `viscraft preview <project-directory> --frames <start>:<end>` (it renders the range
without touching the active timeline or result). Check it without explaining the
hidden plan: can the viewer recognize the relevant subjects, follow intent →
visible change → result, and see why that change matters to the brief? Revise the
plan or material if it cannot carry the event. Do not expand production to meet a
duration, shot count or technology quota while this uncertainty remains unresolved.

This is not a mandatory plot structure. An abstract film, music montage or product
piece may connect images through form, sensation or association. Make that
relationship serve the intended experience; a method change alone does not
motivate a cut. Resolve a consequential change of creative direction through
the scoped review below rather than silently substituting a different commission.

## Establish the whole work and its changes

Describe the relevant **whole work or passage** before assigning its parts to
producers. Use the dimensions above to identify what is established, what must
persist, what may vary and what intentionally changes. For temporal work, relate
the initial state, meaningful change and resulting state, including how the
audience can perceive that relationship. This applies inside a continuous shot,
across an edit, between production methods and during a revision. A single shot
can change viewpoint, location, material and sound; its length is not an exemption.
For a still, describe the coexisting content/layout and scope of an edit; for
pure sound, describe the audible relationships and development. Do not invent
spatial geometry or a film timeline for a task that has neither.

Use this **same account** to choose methods, assign input/reference roles, author
the actual request or code, select material and review the result. Keep the useful
facts in existing Direction/Look/Shot/Composition authoring and handoff notes.
Simple settled work needs little prose; related passages can share one statement.
This is not a new schema, mandatory worksheet or record of every detail. Explicit
user constraints and approved scope take priority; do not turn an incidental
detail into a permanent constraint or assume an unobserved fact is established.

For temporal work, choose the relationship before choosing its implementation:

| Relationship | What must be decided | Useful basis | What the actual passage should establish |
| --- | --- | --- | --- |
| The same event continues | Persistent participants, space, action/contact state, direction and sound relationship | Shared author state/geometry; selected Take intervals; suitable shot images or supported motion references | The event advances coherently through its approach, change and consequence |
| The same scene, a new viewpoint | Retained scene/design/local state versus changes caused by framing, perspective and visibility | Shared scene basis or prepared viewpoint material | The view agrees with the established space; occluded or off-screen content need not remain visible |
| A Look or medium changes | Which scene/event facts persist, which appearance/material changes, and whether place also changes | Each side's material derived from the agreed scene/event basis | The intended transformation reads while retained facts hold |
| An ellipsis, relocation or new scene | The state the story still tracks, what is omitted, and how the new situation becomes understandable | Persistent design plus the new scene/state basis | The change reads as intended rather than an accidental reset |
| Montage or association | The idea, sensation, content or rhythm linking the material | Each part's own material plus the compositional intent | The connection is legible without imposing a continuous fictional space |

Separate stable design from local state: identity/construction may persist while
posture, wetness, a held item or a cue develops. A reference's approval applies
only to its stated role. One still cannot determine hidden space, a new viewpoint
and a later action state; a fixed seed or shared filename does not establish
continuity. Reference relationships, generation dependencies and final shot order
are distinct. Choose which inputs carry which facts rather than always drawing
independently or always chaining the previous output's last frame.

### Make changes of place and state readable

Compare what the relevant interval establishes before and after the change.
An unchanged character, product, palette or room label does not establish an
unchanged situation. Distinguish a change in the scene from a change in how it is
seen or heard: camera movement can hide a landmark, a rest can remove music while
ambience continues, and a deliberate ellipsis can omit movement. Judge against
the intended relationship, not constant visual/audio similarity. Use framing,
action, sound and surrounding context to make a consequential change legible;
no extra shot or effect is compulsory. A dissolve or continuous music alone
does not explain an otherwise unexplained relocation or state reset. Do not add
a new setting merely to fill time if it makes the intended event confusing.

### Design both sides of a cross-media join

Apply the same state/change account when producers differ. Design both sides
together, identify who controls each important fact and choose the actual
outgoing/incoming states before finishing either side. Retained facts include
the relevant whole scene and sound, not only the protagonist: subject/prop
relations, spatial layout, viewpoint/visibility, material/light, event timing and
audible perspective matter according to the brief. In the same space, a material
change does not silently erase its landmarks; in a planned new space, the
crossing and resulting situation need to read. Compare spatial relationships
under the actual camera rather than requiring identical screen coordinates.

Build counterparts from an appropriate shared basis: author geometry, a useful
recording/accepted interval, or prepared images for the intended views and states.
A code frame may guide a target-Look edit where the tool supports preserving its
composition; an accepted generated interval may instead guide the authored side.
One optional preparation method is described in the
[Look-change recipe](../workflows/generation-recipes.md#carry-one-event-across-an-intentional-look-change).
Assign separate appearance, layout and motion responsibilities where supported,
as in [method selection](#resolve-the-appearancecontrol-gap-before-choosing-direct-generation).
Neither a reference input nor an approved still guarantees its generated
descendant. Paired frames test composition/material; temporal behavior and sound
need the actual adjoining passage with relevant context.

Choose an intermediate bridge only when it carries necessary information,
crosses a planned change or directs attention. It has its own picture/sound and
quality needs. Occlusion or another effect must genuinely do the declared work;
it cannot substitute for an unfinished event or an unexplained scene change.
Judge outgoing, bridge (if any) and incoming material together against the same
retained facts and intended changes.

### Prepare the basis before making several related segments

Before making dependent material, including an internal transformation or a
revision, identify what already carries the needed facts and what is missing.
Shared author design/geometry, World state when actually present, accepted
footage, prepared images and supported continuation are possible bases. Take
only what the relationship needs. Record purpose and limits in existing
Direction, Assets/inputs, requests and notes; do not build another continuity
registry or force a World/character-sheet library. Keep an accepted anchor and
compare outputs back to it as well as their neighbors to catch accumulating drift.

Planning images should already agree on the retained scene, design and event
relationships. They are not a second set of final production inputs: distinguish
an exploratory storyboard/Look image from a selected identity, layout or frame
input by its actual use. Reuse a planning image when it fits that use; otherwise
refine or replace it against the same design decisions as actual material becomes
available. Approval of a palette does not freeze every incidental background
detail, and a rendered code frame does not override an approved scene design.
Test a difficult representation or moving handoff before polishing every planned
image. Apply the [Look-change recipe](../workflows/generation-recipes.md#carry-one-event-across-an-intentional-look-change)
for specific code-to-generated and generated-to-code preparation and repairs.

## Choose the medium for the required control

Choose against the [retained facts and intended changes](#establish-the-whole-work-and-its-changes)
of the whole passage. Before committing to video generation, assess code,
suitable existing material and compositing against those quality/control needs.
For graphic or shape-driven animation, authored characters, coordinated actions,
camera paths, exact text, interaction and sound-synchronized timing, **start from
code or approved art with code-directed motion when it can credibly meet the
quality bar**. Code can author a whole animated scene
([Code visuals](code-visuals.md)). If choosing generation instead, identify the
specific appearance/performance need or practical quality/effort tradeoff that
makes it a better route. A configured endpoint, "cinematic", "animation", "one
continuous take" or fewer tools is not a sufficient reason by itself.

Respect an explicitly requested production method. Compare achievable quality,
authoring effort, iteration/review cost and local editability, as well as
generation fees and reference/control uncertainty. This preference does not
require building and rejecting code before using generation: a known material
or performance limitation can settle the choice. Do not lower the quality bar to
justify code, build a predictably unsuitable prototype, or require a provider
pass for an authored scene that already meets the brief.

Separate **how the work is controlled** from **where its assets come from**.
Code-directed motion, interaction and cameras can use authored geometry, imported
models, recorded sound or generated imagery. Code-first does not mean making every
visible object from primitives or synthesizing every sound. For an appearance that
is costly to author well, consider suitable existing assets alongside procedural
creation and generation; compare adaptation effort, editability and dependencies
as well as the initial result. Search by the material's role in the work and verify
its use rights ([Media acquisition](../runtime/media-acquisition.md)).

Choose boundaries by the control each part needs. Approved imagery can supply
character art, surfaces or environments while code controls staging and motion;
generated performance can be composited with precise authored elements. Preserve
asset provenance and the limits of flat material. Use persistent World state only
when several views or interaction need shared spatial truth
([World and Playable](../runtime/world-playable.md)). Neither mixing methods nor
using one model throughout is a quality goal. A Look change or continuous camera
does not require the whole passage to use the same producer. Choose the graphic
part, material change and photographic part at the scope each actually needs;
design their handoff together.

### Record the consequential choice and the credible alternative

Before committing substantial production, leave a brief decision summary in the
existing plan/handoff notes for each materially different passage or control
problem. Group shots that share the same reasoning. State:

- The intended result, retained facts and intended changes from the shared
  description, and which of them need explicit control.
- The chosen route and why it can meet those needs at the requested quality.
- The strongest relevant alternative passed over and the concrete reason. When
  bypassing direct code for graphic/action-driven work, explain that choice;
  when bypassing motion control for precise action/camera, explain that choice.
- The evidence or assumption behind the decision, its meaningful uncertainty,
  and the smallest useful check or fallback if it remains unresolved.

Use a few sentences, not an exhaustive tool matrix, a new manifest, a log of every
thought or a requirement to test all alternatives. Simple settled operations need
no comparison essay. An untested prediction is an assumption; "the model can do
it" or "code would look toy" without a specific constraint is not evidence.
Keep this summary aligned with the actual Sources and input roles. Revisit it
when the brief, capability or observed result changes, rather than retrofitting a
justification after production.

### Resolve the appearance/control gap before choosing direct generation

If code or an existing recording can establish the needed motion, interaction or
camera but cannot supply the final Look, evaluate it as a **proxy/control input**
before discarding it. A 2-D animation, a simple 3-D scene or a useful recording may
carry that control; choose the smallest sufficient representation. Proxy creation
does not inherently require a World, Blender, a white model or a new modelled scene.
If the existing recording already serves the purpose, use it.

For a generated realization, name what each proposed input carries (for example,
proxy video for motion/composition, target-style images for appearance). Check the
actual deployed model/mode/Adapter for those combined inputs and the strength of
control it exposes. Reference video support alone does not guarantee motion or
camera adherence. If omitting a proxy where precise behavior matters, explain
which supported control, suitable footage or observed direct-generation result
provides that behavior, or state that the requirement is unresolved. Lack of
proxy support is a capability limit, not evidence that uncontrolled generation
will meet the same requirement. Choose another available route or resolve a
material change to the brief; do not silently discard the needed control.

Where uncertainty remains, test the hardest relationship with the smallest useful
frame or passage and its relevant context; a still cannot validate motion or an
action across a cut. Do not produce comparison versions of every route. A working
code render still needs the
[final-picture/proxy decision](#decide-whether-an-authored-render-is-final-picture-or-a-proxy).
Generation likewise needs its actual model/control capabilities checked
([Generation inputs](../providers/generation-inputs.md),
[Service execution](../providers/service-execution.md)). If the result misses the
brief, revisit the design or method before adding detail or repeating generations;
explain a necessary change to the brief rather than silently reducing its ambition.

## Show capability through a work, not a method tour

A capability showcase, an explanatory diagram and a real work each have their
scope. A diagram or interface label documents what a method *is*; it is not
evidence of the effect that method produces. The number of methods exercised, or
the total runtime, does not measure expressiveness, and a tour of one shot per
technique rarely reads as a work.

Organize a capability showcase by what the audience should perceive: let them
follow intent → visible change → result, and let each technique earn its place by
what it contributes to that chain rather than by being demonstrated once. Building
the demonstration around **one** work is one way to make that chain legible, not a
required narrative or a technique quota; judge the result as a piece, not as a
checklist of exercised features.

## Decide whether an authored render is final picture or a proxy

A successful Code/Three.js/Blender render establishes an executable result, not a
finished work: a native render used as final picture must still meet its shot's
Look, material, motion and environment quality. Decide separately whether its
actual appearance and motion meet the shot's intended Look at delivery scale and
through the proposed cut. Inspect geometry, surfaces, lighting, environment,
performance and camera behavior where the shot exposes them. A planning render
stays planning material when those qualities fall short; do not select it into the
final cut to satisfy a method quota or fill missing generated footage.

| Required result | Useful route | What to check before expanding |
| --- | --- | --- |
| Authored picture already meets the Look and needed control | Use the native rendered Take | Its actual frames, continuous motion and neighboring cut |
| Appearance/composition matter; motion may be interpreted | Prepare a production-suitable image, then use supported image/reference conditioning | The image's approved qualities and a representative generated passage |
| A particular action, camera path or interaction must carry | Prepare a motion proxy/control video, with suitable appearance references if supported | The provider can consume that control, and the result actually retains the needed behavior |
| The model can realize the brief without rendered control | Use supported text/reference generation or suitable existing footage | A representative result; do not build a World or proxy merely to complete a pipeline |

An image shown to the user is not automatically a model's first-frame input. An
identity reference, a composition proxy and a constrained first frame are distinct
roles; the deployed model/mode must support the selected one. Likewise, a supplied
reference video does not imply exact motion transfer. Provider decisions live in
[Generation inputs](../providers/generation-inputs.md).

When the material is a **playable/game recording**, apply this table through the
two creation routes and their real commands in
[Capability chains → two creation routes](../workflows/capability-chains.md#playablegame-recording--output--two-creation-routes):
adopt the recorded picture directly into editing/sound/delivery, or re-create the
final picture from a motion/composition proxy (the recording, extracted frames or
a newly-made proxy). A recording is not inherently a proxy, and re-creating one is
not automatic recovery of a 3-D scene/skeleton/true state from an arbitrary MP4.

Use the smallest representation that answers the creative or control question.
A still may suffice for appearance approval; motion, camera timing and interactions
need a passage. A detailed motion proxy is justified when temporal control matters,
not whenever an image needs animating. If a rough proxy's surfaces would be inherited
by the model, improve its appearance or prepare a suitable image with available
tools; writing "make cinematic" is not evidence that the model can discard them.
After generation, review the actual output anew. Approval of an input does not
approve its generated descendants.

## Creative review and production commitment

Showing a direction (stage ④) is **optional**: do it where the cost of being wrong
outweighs the cost of preparing the evidence, and skip it when the work is cheap,
certain, or the user said "just do it". Use the host conversation to involve the user
in consequential creative choices.
For interactive production, present the main subject/hero asset, representative
Look or scene, and materially new visual directions before multiplying them across
expensive dependent shots. Batch related candidates or views into one review when
that makes the choice clearer. Prepare a concrete preview first, inspect it, explain
your recommendation and any visible limitation, and ask what the user should
actually decide; do not ask them to approve a promise of work you have not made.

Choose review evidence by the question. A hero frame may settle palette or framing;
a turntable/multiple views may be needed for an asset used from different angles;
a short passage is needed for action, camera movement or a critical cut. For the
question presented, identify the candidate/file and version, what is approved,
what remains open, and what production would depend on it. When the user approves
a result, retain it as the baseline before a materially new attempt and record the
approval scope with it ([keep a version](../runtime/lifecycle.md#4-versions-versions-keep-revert));
keep the decision and its scope with ordinary project notes and real file/hash
references.

Follow the user's existing choices and delegated creative authority. Permission to
use credits authorizes that spending scope; it does not itself establish that the
user likes a design, and visual approval grants no new spending/upload authority.
Continue through settled choices and routine technical repairs. Whether to ask or
decide follows [When to ask the user](../../SKILL.md#when-to-ask-the-user); a new
Look inside the delegated authority is a decision, not a question, and per-file
approval ceremonies for derivative material within the approved scope are not
wanted. If the user explicitly delegates these judgements, make and record them
within that scope rather than imposing new mandatory stops.

When a user decision is required, wait for the answer before dependent production;
work on independent tasks can continue. Silence or elapsed time is not approval,
and the agent's own review must not be recorded as the user's acceptance.

## Assign each reference a purpose

For a useful reference, identify the following in prose or a compact working
table. This is authoring knowledge, not a new Asset schema (Assets, Sources and
Bindings are documented in [Runtime and authoring](../runtime/runtime-authoring.md)):

- What it constrains: identity/design, Look/material, composition/viewpoint,
  spatial arrangement, action/rhythm, sound, or an actual retained performance.
- What must carry into the work, what may vary, and what should be replaced.
- Whether it is an approved final appearance, a layout/motion proxy, an
  exploratory candidate or accepted media; **state which quality was approved**.
- How the available tool can actually consume it, and which intended constraints
  remain uncertain after that conversion.

Rights approval, visual suitability and technical decoding are distinct. A proxy
may prove layout while its shapes or surfaces are unsuitable for the final Look.
An image-conditioned model can inherit all of its pixels, including those proxy
qualities. When the backend cannot separate the reference's roles, prepare and
inspect a suitable input with available, authorized tools before production
([Image direction](image-direction.md)); text instructing it to ignore unwanted
visual evidence is an uncertain remedy.

**Approval is scoped.** A reference accepted for identity or layout is not
thereby accepted as final material, lighting or photographic appearance. Cropping
can clarify a subject, but it does not upgrade its geometry or surfaces. If the
brief needs qualities the input lacks, prepare a suitable image through an
actually available host image tool/service, a better authored render or licensed
material, then inspect it for that role. Choose the method by the needed control;
image generation is not mandatory for every work. Do not attach a blanket
instruction to preserve appearance when appearance is what must change. If
suitable material cannot yet be made, report the gap and keep the proxy labeled as
planning material.

Across shots, share the stable design and Look that must persist while the
composition, action phase and local state change
([establish the whole work and its changes](#establish-the-whole-work-and-its-changes)).
One common still is a useful option when
its framing and state suit the shots. Shot-specific reference frames can instead
be derived from approved material, checked against the shared design, and used
where supported. A sequence built from previous outputs can accumulate drift;
compare new material back to the approved anchor as well as the adjacent cut.

Disambiguate which subject or relationship matters. Selecting a detail crop,
describing distinguishing features or preparing supported references may help,
but removing other subjects can destroy an intended interaction. Choose the
representation for the required relationship; do not require a single-subject
image for every work. Never treat colour averages, a fixed seed or a shared file
as proof of identity.

## Connect material by the facts it carries

Material relationships are not the Shot order. One approved image can guide
several Takes; a new view may need identity from one image and a location or
interaction from another. Choose inputs by the facts the next output must carry,
not by always using the most recently produced picture. Preserve spatial and
interaction relationships when they matter: matching each subject separately
does not establish that they face, reach or respond to one another correctly.
Use only reference combinations that the actual tool supports.

Keep the relevant request, reference roles and accepted design decisions with the
work. A preparation image establishes only what was observed in that image;
motion, a different viewpoint and hidden detail remain production questions.
When appearance or composition is uncertain, improve an appropriate
representative image or authored frame before multiplying that uncertainty across
Takes. A production-suitable master can anchor variations; it need not be a
separate required image when existing material or the first Code Build suffices.

For a local change, derive a scoped material variant and update its actual
consumers ([Runtime and authoring](../runtime/runtime-authoring.md) covers scoped
variants). A global identity change can require many new views or Takes. Input
relationships explain how material was produced; they do not regenerate
children or prove that an existing child depicts a newly changed parent. The
agent decides whether to preserve an accepted result, create a new variant or
explicitly remake it, then records the new selection.

## Validate a representative result before expanding production

Choose a representative frame, interaction or short passage that tests the
largest uncertainty. A frame can settle composition and appearance; a passage
can test motion, performance, sound and an edit. Inspect it at the delivery size
before repeating an expensive or uncertain method across the work. A successful
compile is not evidence of a successful frame, and a good frame does not establish
good motion. For a simple work this can be the first real Build. More elaborate
style boards or alternatives are useful only when an unresolved choice needs them.

For uncertain scene or asset quality, use the actual subject together with its
environment, materials and lighting, viewed through a camera the work will use.
Check the demanding visible details and relevant movement before multiplying
objects, locations or shots. A standalone asset preview does not establish that
it fits the scene; more map area or working interactions do not establish a refined
appearance. Keep the intended abstraction while checking the whole scene against
the intended finish; a simple or low-poly style still needs resolved forms,
spatial relationships and treatment.
This check can be part of ordinary making and review; it adds no mandatory user
approval stage.

For a costly or uncertain generated route, test a representative passage at a
supported duration before expanding. Compare its actual appearance, behavior and
cut with the intended qualities. A known task resumes under its existing attempt;
a creative revision is a new request and needs the appropriate authorization.
Bound exploration by the authorized scope and expected benefit, and when further
generation is unlikely to fix the diagnosed cause, change the input/method or
retain an explicit unresolved result instead of an unbounded retry loop.

## Direct generated images and passages

Decide the intended experience, the material's role and the control the shot needs
before requesting anything from a model; a prompt cannot supply a decision the work
has not made. How to express that direction in an image or video request, and how
to adapt it to the selected model's supported inputs, is in
[Generation recipes → Direct a generated image or passage](../workflows/generation-recipes.md#direct-a-generated-image-or-passage).

## Continuity across generated shots

Having decided which facts must carry
([establish the whole work and its changes](#establish-the-whole-work-and-its-changes)),
choose references with suitable framing and states and judge the real Takes that
follow. See
[reference roles](#assign-each-reference-a-purpose). Sharing a still is optional when its framing/state suits the shots;
shot-specific references may fit better. Author a separate Source and attempt for
each actual request. Each generation needs authorization within the selected
service's actual contract; do not invent a batch/continuation endpoint or fixed
shot-count limit. Planning images remain planning evidence.

Keep reference descriptions true to their provenance and role. A frame from an
earlier Take can remain an appearance anchor for several requests, but call it
that; it is not each request's "actual preceding shot". When a request needs the
selected cut's state, inspect that interval and record the supplying Take and
frame/time with the reference in existing Asset/author notes. Use the control the
service actually supports; an identity reference does not become a first frame
through its description. Separate jobs do not inherit one another's performance
or scene state, and "one continuous shot" applies to that request only.

When adapting a prompt template, retain shared design facts and rewrite the local
scene/action facts. Remove contradictory inherited instructions, such as retaining
the established room while also requesting a different room. Naming a change in
the prompt does not make the resulting cut understandable to a viewer.

**Judge the real Takes, not the prompt.** A shared still is a *condition*, not a
guarantee: identity, colour and layout can still drift across shots, and a
generated shot has its own camera motion, so single-frame pixel correlation
against the still is **not** a valid identity measure. Inspect actual frames
(contact sheet / side-by-side stills) and describe what carries over (subject,
palette, environment) versus what changed. This is an observed carry, never a
promise of exact identity preservation.

When the selected subject is ambiguous, identify distinguishing features and
consider a different supported reference representation. A crop can help one
subject while losing scale, environment or interaction with others; inspect that
tradeoff before using it. Keep multiple subjects when their relationship is the
point of the shot. Reference reuse does not detect identity or guarantee continuity.

Then select each shot's interval from its accepted Take (`placements[].take` with
`inFrame`/`outFrame` inside the Take's length, which leaves real head/tail handles)
and decide its native audio explicitly — `audio: 'keep'` preserves the generated
soundtrack (trimmed to the selected interval), `audio: 'mute'` drops it. Decide that
choice from the material's actual content, the work's goal and your observation, not
from one per-work default: an acceptable native dialogue or performance can be used
as-is, the whole track can be processed and mixed, only what is missing can be added,
or unsuitable material can be replaced — coordinate by sound role and never stack
several provider beds unintentionally; see [Timeline](../runtime/timeline.md) §3h.

