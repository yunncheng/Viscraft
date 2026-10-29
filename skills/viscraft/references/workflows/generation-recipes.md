# Generation recipes — reusable production choices

These recipes coordinate authoring, generation and editing. Model syntax belongs
in [Model guidance](../providers/model-guides.md); shared visual decisions belong
in [Creative method](../craft/creative-method.md). Choose the number of shots,
references and generation attempts according to the work's needs and authorized
scope. Each entry states when it applies, its
mechanism, the variable choices, the failure repair and its evidence/limits. Vary
the subject, Look, shot length and production method according to the work.

## Direct a generated image or passage

**Use when** an image or passage is to be generated and the direction has to become
an actual request.

Express the subject and environment, initial state, meaningful change, ending state
and camera behavior that serve the shot's intent. Include appearance, lighting and
framing decisions where they affect the result; use selected concrete qualities
instead of accumulating quality adjectives or a fixed prefix.

An image prompt describes a visible moment with enough information to stage it. A
video prompt explains how the passage evolves from its actual input state. Check
that the starting image has not already performed the change the video is supposed
to show. A static action pose is valid; conflicting temporal instructions or a
sequence of incompatible moments in one still are not a useful plan. For a costly
or uncertain route, test a representative passage first
([Validate a representative result](../craft/creative-method.md#validate-a-representative-result-before-expanding-production)).

Read the selected [model guide](../providers/model-guides.md), then translate that
direction into the selected adapter's actual supported inputs. First/last images,
multiple references, video conditioning and intermediate frame injection are
different capabilities, and available adapters do not all share them
([Generation inputs](../providers/generation-inputs.md)).

**Failure repair:** if a required relationship cannot be represented, choose an
available authoring or editing method, prepare suitable material, or identify the
unresolved capability; do not invent a parameter or quietly weaken the brief.

## Appearance anchor to a directed passage

**Use when** the model can supply the desired performance but an important
identity, composition or Look needs a concrete visual anchor.

Choose the image's role first. Generate or author suitable imagery, inspect its
actual proportions, materials, light and state, and obtain any needed creative
approval. Bind an identity image as an appearance reference; bind a first-frame
image only when the shot should begin in that pictured state. Describe the
movement from that state with the selected model's supported prompt/input mode.
Build a representative passage, inspect its motion and sound **together**, and select
a usable Take interval with real handles before expanding related shots. If you
cannot listen, mark the sound **not reviewed** — never infer its content from a peak
level, a `hasAudio` flag, or a prompt that said no dialogue/no music.

**Choices:** an identity reference can leave composition open; a frame anchor
constrains the opening; a separate Look image may help only when the model/service
supports the added role. If exact temporal control matters, a supported motion
proxy may be appropriate. It need not be built for an ordinary image-guided shot.
Image editing may improve the anchor before another video request. Do not
silently convert unsupported references into a weaker mode.

**Failure repair:** toy geometry surviving into a photographic request points to
the image/control representation, not just insufficient prompt adjectives. An
image showing the completed event can make a requested event restart. Inspect
the actual anchor and input roles, then change the cause.

**Limits:** no universal identity, exact motion or all-model quality guarantee
follows from an Asset/reference/Take binding. A real image-model route or host tool
must be available for generated anchors.

## Carry one event across an intentional Look change

**Use when** a transition between illustrated and photographic (or other) Looks
should read as a continuing event rather than unrelated clips.

This is the generation-side application of
[Design both sides of a cross-media join](../craft/creative-method.md#design-both-sides-of-a-cross-media-join);
read that for who controls each side and whether an intermediate piece is needed,
not just how to prepare the generation request.

**Prepare a shared design, then test its difficult part.** Before producing
independent shot images, use the [same retained facts and intended changes](../craft/creative-method.md#establish-the-whole-work-and-its-changes)
to settle the scene relationships, action phases and intended Looks. A storyboard
can explore those choices without supplying every final generation frame. Identify
the required landmarks/props, subject proportions, contact state and movement
direction; a change of viewpoint may legitimately change their screen positions
or hide them. Test the hardest required pose, camera movement or material at
delivery scale with a useful frame or short passage before polishing all shots.
A still cannot settle a moving handoff. Do not assume either code or a model can
reproduce every detail of a polished illustration at the available effort.

**Choose an available anchor and the intended handoff.** When one side exists,
select its usable interval and plan the corresponding state/action for the side
still to be made. When neither exists, start with the smallest useful test of the
harder side; do not require two finished shots before preparing either input.
After producing the counterpart, select compatible intervals with their approach,
consequence and real edit handles, rather than automatically using the last
encoded frame of one file and the first of the next. Compare full frames for
retained objects and spatial relationships, subject scale, viewpoint, pose/contact,
action phase and motion direction. Check the planned lighting and sound
relationship too. Two poses that match in a still may reverse velocity or repeat
an action in motion.

Use the preparation direction that matches what actually controls the shot:

| Production direction | Concrete preparation | Check before expanding |
| --- | --- | --- |
| Code/illustration to generated photographic footage | Render the relevant authored state or short passage. If the existing target-Look image already fits the join, reuse it. Otherwise edit/restyle a selected actual frame into the target Look, using the earlier Look image for material/light direction where the tool supports it. Explicitly retain the required scene objects, relationships, viewpoint and action/contact state. | Compare the actual source and derived frame together: required buildings/props must not vanish, scale and contact must agree with the intended change, and photographic surfaces/detail must meet the target Look rather than inherit crude proxy geometry. Then bind the image in the model's actual supported role. |
| Photographic footage to code/illustration | Select an actual usable interval from the photographic Take and use its relevant frame/state to design the illustrated counterpart. Author the matching staging and continuing motion; an image tool may supply backgrounds, character layers or sprites while code handles timing/compositing/camera. Use declared project resources, not an invented reconstruction of the MP4's layers or 3-D scene. | Render the authored entry and its following action beside the outgoing passage. Check the pose, scene relationships and direction of travel through the change; displaying a matching still does not establish continued motion. |

These directions do not dictate render order or require image editing. Shared
geometry, authored counterparts or existing material may already provide the
join. Prepare the side with the tighter practical constraints early; iterate the
other side against it without treating the weaker render as a new quality target.
If the plan deliberately changes location, preserve only the facts that should
carry and make that relocation readable.

**Keep one current production choice.** In existing project authoring notes,
identify which image/interval now supplies each input role and which earlier
images remain only storyboard or Look references. Keep the actual source-frame
identity/time and derived Asset provenance. A new input refines the plan; it does
not require completing a second, independently generated set of shot images.
Respect the existing approval scope: routine refinements are author decisions,
while a necessary change outside that scope follows the normal user-decision rules.

**Choices:** a hard cut, moving occluder, close detail match or sound-led reveal
can work when motivated by the action. A dissolve is useful for a tonal change
but does not correct incompatible contact or action phase. A continuous generated
camera move may remain one Take even when the plan contains several shot labels.
Keep a natural accepted performance instead of regenerating each label separately.

**Repair the diagnosed cause, not every side at once.**

| Observed difference | First repair |
| --- | --- |
| The code omitted a required building, changed proportions or staged the wrong action phase | Correct the authoring or use suitable image assets/layers. Do not erase the building from the photographic side simply to match the mistake. |
| The actual authored shot meets the brief, but differs from an exploratory storyboard in acceptable detail | Reuse it as the basis for the dependent counterpart; refine the relevant input and record its role. Do not rebuild both shots solely to match incidental sketch pixels. |
| The chosen implementation cannot achieve the required quality or motion at reasonable effort | Test a richer asset-based/composited approach, change the framing or choose another suitable production route. Revise affected design choices explicitly; do not lower the whole film to a toy render. |
| The input images already disagree on retained scene content or event state | Repair the relevant counterpart before generating motion. If one subject has entered the water and the other has not, select compatible action phases or author the missing action; a dissolve or splash overlay cannot repair that reset. |
| Inputs agree, but the generated Take drifts or resets the action | Inspect the actual supported input roles and usable Take intervals. If the model cannot carry the required temporal control, use supported motion conditioning or change the method/cut; do not repeat the same request with more adjectives. |

After a repair, inspect the outgoing → bridge (if any) → incoming passage in
motion with its sound, within the existing authorization. Recheck the accepted
design as well as the immediate seam to catch cumulative drift. Mark motion or
listening unreviewed when the host cannot perceive it; a frame pair and numeric
audio facts do not establish the whole transition's quality.

**Limits:** an image edit does not recover geometry/layers or guarantee retained
objects. A reference image is not automatically a constrained first frame; a
matched frame does not transfer velocity, camera trajectory or performance. Read
the selected model/mode before choosing image, video or combined references; do
not submit unsupported combinations or silently discard necessary control. Judge
the actual moving result before accepting the route for that work.

## Keep a subject, scene or action consistent across several generated shots

**Use when** several generated shots share a persistent subject, setting or action.

Decide by the shot relationship, using the decision table in
[Establish the whole work and its changes](../craft/creative-method.md#establish-the-whole-work-and-its-changes).
Then choose among: one joint shot image prepared for the new viewpoint; a supported
relay/continuation only where the selected model actually supports it; or a single
request that already contains several shot labels (which still needs its internal
seams and editability checked). Prepare the basis **before** producing the shots.
Independent requests may run in parallel, but a request that depends on another's
real output must wait for that output to exist and be inspected. Ordinary reference
images are not exact first frames, and a reference video is not exact motion transfer.

**Choices:** a shared design image versus a per-viewpoint shot image versus a
cut-point frame — keep only what the relationship needs. Do not mandate one still
per shot or a last-frame chain for every join.

**Failure repair:** for identity or state drift along a chain, compare back to the
accepted anchor **and** the adjacent selected interval, not only the immediate join;
repair the reference/context or reselect a compatible accepted Take rather than
re-prompting blindly.

**Limits:** there is no batch or continuation endpoint to rely on. A shared still is
a condition, not a guarantee — it constrains the request but does not by itself
produce consistent or editable results. Model-specific tokens and support limits
belong in [Model guidance](../providers/model-guides.md).

## Recording a newly successful method

Keep its actual final request in the Source, with references and parameters;
record selected Take intervals, dependencies and useful observations alongside
the work. A reusable recipe should state its goal, applicable conditions, choices,
failure diagnosis and evidence. A model-specific discovery should link the exact
model/service version. Examples need actual authoring files, permitted inputs and
reproduction conditions. A single successful result supports a scoped observation;
label broader suggestions as hypotheses until tested. Keep private material and
unverified redistribution rights out of a shared or published copy.
