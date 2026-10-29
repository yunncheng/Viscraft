# Creative workflow — using the knowledge to advance this task

Use this page to identify the current responsibility, resolve its open questions
and leave enough Project state to continue. Each stage links to the specialist
guidance needed for that work. Start with the relevant stage and revisit earlier
decisions when the inputs or requirements change.

**Enter from the work's real state, not from the top of this page.** Run
`viscraft status <dir>` first when a Project exists, then follow the state route in
[SKILL.md → Route from status](../../SKILL.md#route-from-status): a named single
operation is exactly that operation, a new piece inside an existing Project starts
at ①, a specific edit jumps to the layer it touches, and a brand-new work follows
①–⑦. That routing is decided once; a later question re-enters at the stage that
owns it, not at ①. A continuation resumes from the usable outputs already in the
Project — losing the conversation is not a reason to re-submit the same paid work.

The seven stages below are **dependencies, not steps 1–7**:

- Independent parts may run in any order, and two stages can be live at once.
- A stage with no trigger simply does not run — no soundtrack means no audio work; a
  single continuous shot means no transition/assembly stage (do not invent a
  storyboard or timeline for a pure image, pure sound or game task).
  Internal state, viewpoint, Look or sound changes still need planning and review
  even when no edit joins separate shots.
- A check, preview or export does **only** that operation.

Nothing here is an approval gate or a form to complete. The four hard rules in
[SKILL.md](../../SKILL.md#hard-rules) stay live throughout, and a question already
settled is not re-opened merely because you moved on.

**One document, one job.** Each reference page owns one responsibility and is
rewritten in place when the truth changes; these pages are not a log of what you
did. When two pages could answer a question, go to the one that owns it rather than
reading everything; [Reference map](../reference-map.md) resolves an unplaced one.

## Non-film task exits

Not every task is a film. A pure image, a pure sound piece and a playable work are
complete deliverables on their own — do **not** invent a timeline, storyboard or
shot list to make them look like one. Each still runs produce → inspect → hand
over → modify, at its own scale, and each has one detailed home:

| Task | Produce | Inspect | Deliver | Modify |
| --- | --- | --- | --- | --- |
| Still image / image edit | host tool + `importAsset`, the `generate-image` operation ([Generation inputs → non-film exit](../providers/generation-inputs.md#non-film-exit-a-still-image)), or an authored `imageDocuments`/`imageTargets` still target (`image --target`) | open the real bytes; `--check` is a read-only preflight; `review` is for a built film, not a still | `deliver --image <target>` writes `image/<target>.<ext>` and the handoff always includes the complete editable `project/`; every delivered still keeps a live workbench entry (`viscraft workbench --document <id> --target <id> --delivery <entry>`) handed over with the file, printed URL and static reopen command ([details](../../SKILL.md#still-images-and-sound-targets)); `export` makes a separate portable copy | edit the design document and re-run `image --target`, hand-adjust in the workbench, or make a new generation attempt / new Asset id |
| Pure sound / music | a `browser` `output: 'sound'` Source plus a declared `soundTargets` entry (`durationSamples`/`sampleRate`, no frames), or the standalone `renderSoundScene` SDK ([Audio](../runtime/audio.md#code-authored-sound-browser-output-sound-source)) | decode the WAV; listen where possible | `build --target <id>` produces the WAV result; `deliver --sound <id>` hands over that WAV plus the editable `project/`; a direct SDK render is just a file | edit the entry (re-render), the clip (re-mix) or the target's sample span; `keep`/`revert`/`clean` treat it as a normal version |
| Playable work | a `browser` picture page ([World and Playable → standalone](../runtime/world-playable.md#3-standalone-live-playable-delivery-separate-from-the-movie-result)) | actually play it; exercise real input | `export-playable` / `deliver --playable` | edit the page and re-export |

The low-level SDK outputs (`renderSoundScene`, `exportPlayable`) do **not**
automatically become a Build, a Take or a retained version; use real registration
and the Project lifecycle when you need reuse or a handoff.

## The seven stages

Each stage states the same six things: **when to enter / return → what it solves →
your default action → what to leave in the existing state → which specialist chapters
to read, by condition → the basis for continuing, returning or leaving something
unresolved.**

A **multi-shot film that mixes methods** (code, approved imagery, an optional
provider) has no separate recipe: these stages are the recipe. When how to combine
the methods is the question, still execute only the parts the work needs — no fixed shot
count, duration or method list follows from it. A pure image, a pure sound piece, a
playable work, a single-code film or a plain re-cut of one supplied video does not
need it; use the non-film exits above or the relevant specialist page.

A typical order for such a film — skip or reorder steps the work does not need:

1. Direct the audience effect, the medium per shot and each reference's purpose
   ([Creative method](../craft/creative-method.md)).
2. Name the sound roles and decide whether a whole song or an excerpt sets the length
   **before** generating; decide keep / process / replace per Take after reviewing it
   ([Sound design](../craft/sound-design.md)).
3. Settle the Look and prepare the images each shot needs
   ([Image direction](../craft/image-direction.md)).
4. Time approved images on the real composition as a sounded animatic (stage ④).
5. Validate the riskiest passage at delivery size before expanding
   ([Validate a representative result](../craft/creative-method.md#validate-a-representative-result-before-expanding-production)).
6. Produce each shot by its method; decide whether an authored render is final
   picture or a proxy
   ([Render or proxy](../craft/creative-method.md#decide-whether-an-authored-render-is-final-picture-or-a-proxy)).
7. Edit with real handles and deliberate transitions and J/L-cuts
   ([Editing awareness](../craft/editing-awareness.md)).
8. Build candidates where a shot has several, then select
   ([Compare candidate Takes](../craft/review-repair.md#compare-candidate-takes-before-choosing)).
9. Finish the sound on the shared clock: roles, ducking, mastering
   ([Audio](../runtime/audio.md#coordinate-sound-by-role-not-by-a-single-authority)).
10. Review the real cut (stage ⑥), then deliver and revise at the highest available
    layer (stage ⑦).

### ① Understand the task

- **Enter / return when** the work starts, or a later answer changes what "the task"
  is. Skip this stage when the current state already states it (a single named
  operation, or a clearly scoped local edit).
- **Solves** the difference between a *new* commission, a *continuation*, a *local
  modification* and a *single operation*: what the user supplied, the target effect,
  the audience and runtime (when they matter), the deliverable, and any retention
  constraint (material that must be reused, kept, or handed on).
- **Default action:** you decide the interpretation. State the goal in one or two
  plain sentences and record it; do not turn a clear brief into an interview. Ask only
  for facts only the user knows, resources/authorization, or a fork with no basis to
  judge ([when to ask](../../SKILL.md#when-to-ask-the-user)).
- **Leave in the state:** the goal, the deliverable, and the reuse/retention
  constraints — in the existing `project.json` intent and the handoff notes
  ([where the plan lives](../../SKILL.md#where-the-plan-lives)), not in a new set of
  stage documents.
- **Read by condition:** a supplied reference or a flat video to rework →
  [Reference adaptation](../craft/reference-adaptation.md) and
  [Editing awareness](../craft/editing-awareness.md); a mostly-visual brief →
  [Creative method](../craft/creative-method.md#translate-intent-into-a-visual-and-temporal-language).
  You do **not** need these when the task is a continuation with an already-authored
  direction, or a pure technical operation.
- **Continue / return / leave open:** continue once the deliverable and its constraints
  are clear. Return here only if a later Result genuinely changes them. If a user-only
  fact or an authorization is missing, leave that one item unresolved and proceed with
  the independent, already-authorized parts.

### ② Check relevant capabilities

- **Enter / return when** the intended route depends on a tool, service, medium or
  observation this session may not have — and again for a *newly* needed operation in a
  continuation. Skip it when the entry is already settled and unchanged.
- **Solves** whether the intended route can actually run here, and separates
  *not configured* from *unverified* from *unsupported* from *lacks authorization* —
  four different situations with different responses.
- **Default action:** check the real state (`doctor`, `auth status`, a bounded probe)
  and choose a route that fits what exists. An unverified service is **not**
  automatically unusable; a reasonable check or a purposeful representative test
  inside an existing authorization is allowed. Do not stall the work on a service the
  task does not need. For a multi-method film the entry conditions are a Runtime whose
  `doctor` passes, a brief that states the target effect, length and material/service
  constraints, and consent settled before any billable or off-machine submission
  ([hard rule 2](../../SKILL.md#spend-and-upload-consent)).
- **Leave in the state:** the chosen entries, the meaningful limits, the unresolved
  requirement and the next action — in the handoff notes. Never record a credential
  there.
- **Read by condition:** the whole page when a route is still being chosen
  ([Startup checks](../runtime/preflight.md)); just
  [the requirements table](../runtime/preflight.md#check-the-requirements-of-this-work)
  when confirming one dependency; the selected model's own guide when a generation
  service is involved
  ([model guidance](../providers/model-guides.md)). Skip it entirely when the route
  needs no external capability.
- **Continue / return / leave open:** a configured entry ends this stage. If a needed
  dependency is genuinely absent and changes the plan, raise it once before the
  dependent production; a *new* gap that appears later is a normal exchange, not a
  broken rule. Leave unrelated planning to continue meanwhile.

### ③ Develop the creative plan

- **Enter / return when** a route must be chosen or a chosen method has failed and
  needs replacing. A single-method task that is already clear needs only a recorded
  reason, not a plan document.
- **Solves** which capability or combination gives the control the work needs, by
  material, cost and likely result — and the reason, the risk and the one smallest
  check that would de-risk it.
- **Default action:** describe the [whole passage's retained facts and intended changes](../craft/creative-method.md#establish-the-whole-work-and-its-changes),
  then apply [method selection](../craft/creative-method.md#choose-the-medium-for-the-required-control), choose and record; do **not** add methods to look thorough.
  One method is enough when it is enough. Keep an explicit unresolved risk rather than
  padding the plan. In a multi-method film, decide per shot: the medium by the control
  that shot needs, not a house style; cuts planned upstream
  ([Editing awareness](../craft/editing-awareness.md#carry-the-event-through-a-cut));
  both sides of a cross-media join designed together
  ([Creative method](../craft/creative-method.md#design-both-sides-of-a-cross-media-join));
  a shared score coordinated across the cut
  ([Sound design](../craft/sound-design.md#directing-choices)); references chosen for
  their actual pixels, since a shared still is a condition, not an identity guarantee
  ([Service execution](../providers/service-execution.md)).
- **Leave in the state:** the goal, actual methods/input roles in `project.json`,
  and a brief [decision summary](../craft/creative-method.md#record-the-consequential-choice-and-the-credible-alternative)
  in the existing handoff notes: needed control, chosen route, the credible
  alternative passed over and why, evidence/uncertainty and the smallest useful
  check. Group shared reasoning; explain consequential bypasses of direct code
  or motion proxies rather than listing every unused tool. Do not create a
  second authoritative shot/prompt/asset manifest. The CLI `plan` checks technical
  feasibility and reuse; it does not choose a creative method or supply this reason.
- **Read by condition:** [Creative method](../craft/creative-method.md) for the
  decision itself; [establish the whole work and its changes](../craft/creative-method.md#establish-the-whole-work-and-its-changes)
  when content/relationships must persist through a change of state, view, Look,
  producer or revision, including inside one shot; the medium-specific page the choice touches
  ([Code visuals](../craft/code-visuals.md), [Image direction](../craft/image-direction.md),
  [Motion and cinematography](../craft/motion-cinematography.md),
  [Sound design](../craft/sound-design.md)); [Capability chains](capability-chains.md)
  when the plan is a multi-step chain and you need to know what really connects.
  Skip the chain page for a single-capability task.
- **Continue / return / leave open:** continue when the method can express the needed
  control. Return here (not to blind retries) if production shows the method cannot.
  Leave a capability gap unresolved and visible when it cannot be closed now.

### ④ Preview the direction when useful

- **Enter / return when** being wrong is expensive relative to the cost of checking —
  an unresolved identity/Look, an action whose handoff matters, a costly generated
  route. Skip it when the work is cheap, certain, or the user said "just do it".
- **Solves** the specific open question with the cheapest faithful evidence: a key
  frame for appearance, a short passage for motion/camera/cut, a prototype for
  interaction.
- **Default action:** decide whether to show, and show only what answers the question;
  **showing is not automatically waiting for approval.** Do not stage a preview as a
  ceremony when a decision is already recorded or delegated. When timing and the cut
  are the open question, or narrative and sound problems are cheaper to find before
  spending on motion, an animatic or rough cut — approved images timed on the real
  composition — is the cheapest faithful evidence.
- **Leave in the state:** the previewed evidence and the decision it settled, kept as
  review material plus a note — using `viscraft preview` (which never writes the
  active timeline or result), never by editing the real timeline to shorten it.
- **Read by condition:** [Creative method → creative review](../craft/creative-method.md#creative-review-and-production-commitment)
  for when a review is worth its cost; [Review and repair](../craft/review-repair.md)
  to inspect what the preview actually shows; the relevant craft page for the specific
  quality being judged. Skip when no decision is genuinely open.
- **Continue / return / leave open:** after the evidence, either continue or revise the
  plan. Respect a user-specified checkpoint and a genuinely un-inferable major
  divergence; do not invent per-asset approval steps inside an already-approved scope.
  While waiting on a real user decision, proceed with independent authorized work.

### ⑤ Produce and combine

- **Enter / return when** the plan is chosen and the needed capabilities are settled.
  Enter here directly for a local edit, at the layer the change touches.
- **Solves** turning the plan into real Takes and a real composition, in dependency
  order, parallelising independent parts, reusing what is already produced, and keeping
  correct provenance for every input.
- **Default action:** produce, combine, and keep candidates; parallelise what is
  independent. Carry the planned retained facts/changes into the actual code,
  requests, reference roles and selected edit intervals; a valid API request does
  not prove it expresses the plan. When a method is wrong, return to ③ — **never blind-retry** an expensive
  step ([generate-images/passages guidance](../craft/creative-method.md#validate-a-representative-result-before-expanding-production)).
- **Leave in the state:** real Sources/Takes/placements and their provenance in
  `project.json`; accepted results pinned with a `take:` placement and retained with
  `keep`; candidates kept as produced. A new generation is a new attempt under its own
  authorization — never a silent substitution.
- **Read by condition:** [Runtime and authoring](../runtime/runtime-authoring.md) for
  the schema/execution contract; [Timeline](../runtime/timeline.md) when
  placing, trimming, mixing or making transitions; the provider pages when a real
  service runs; [World and Playable](../runtime/world-playable.md) for interactive work.
  Skip a page whose fields your route does not use.
- **Continue / return / leave open:** continue while the route holds. Return to ③ when
  it cannot express the intent. Leave an unresolved generation visible (an unauthorized
  source stays unauthorized) rather than papering over it with a proxy.

### ⑥ Inspect and repair

- **Enter / return when** there is an actual output to judge, and again after every
  repair. This is not a one-off check at the end.
- **Solves** whether the real result meets the goal, where the cause is, and the
  smallest effective fix — keeping *observed fact*, *guessed cause* and *artistic
  judgement* distinct.
- **Default action:** look at the actual picture/sound and compare it with the
  same planned facts/changes and delivery promise across the whole relevant
  composition and temporal context. Fix the cause and re-check that the fix did not regress
  another part. State honestly what you could not observe (motion, sound, a hidden
  area) rather than claiming a full review.
- **Leave in the state:** the observed evidence, the diagnosis and the repair, kept
  with the work; a rejected result is reported as such, not silently replaced or
  deleted.
- **Read by condition:** [Review and repair](../craft/review-repair.md) for the general
  method; [Editing awareness](../craft/editing-awareness.md#carry-the-event-through-a-cut)
  when a join fails though each shot reads; [Motion and cinematography](../craft/motion-cinematography.md)
  for stutter/stiffness; [Media analysis](../runtime/media-analysis.md) when you must
  measure because you cannot watch or listen. Read specialist diagnostics only
  when relevant; they do not replace the actual output review.
- **Continue / return / leave open:** a fixed defect returns to ⑤ as a scoped rebuild.
  A cause that needs a different method returns to ③. If the result misses the
  brief artistically, repair the creative cause even when the engine is correct;
  use the existing user-decision scope only for a consequential unresolved fork.

### ⑦ Deliver and continue

- **Enter / return when** a result is ready for the recipient, or a handoff is
  requested. Skip it when the user only wanted the editable Project.
- **Solves** handing over the thing the recipient actually needs, and leaving a
  continuation entry that lets someone else (or a later session) resume from real
  state and provenance.
- **Default action:** create one complete handoff (or a standalone playable), selecting the products this request actually hands over —
  selected stills, the film, or both — not every output the Project happens to
  contain; record the entry point for the next step. A delivered still also keeps the
  live workbench entry described in the still row above. New feedback then re-enters at
  the **affected part** and reuses everything unrelated — not the whole film again.
- **Leave in the state:** the delivery/export, the handoff notes (goal, reason,
  capability status, user decisions, open items, next step) and the real source
  relations. Register notes into `project.handoff` when they must travel.
- **Read by condition:** [Delivery](../runtime/delivery.md) for the bundle and its
  redistribution rules; [Runtime and authoring §9](../runtime/runtime-authoring.md#9-resuming-and-handing-off-an-existing-project)
  when someone else continues or you resume a foreign Project.
- **Continue / return / leave open:** a delivery ends the loop until new feedback,
  which enters at the affected stage. Leave an explicit open item in the handoff rather
  than an implied one.

## Where a mid-work question is answered

The seven stages above own the **responsibilities**: what each stage resolves,
what to leave in the existing state, and when a stage does not run. For a
question whose page is not obvious from the stage you are in, use the single
situation index: [Reference map](../reference-map.md). It maps a trigger to the
one page or section that resolves it and says when you do not need it. Do not
load the whole map or every craft page; the stage you are in usually links
straight to what you need.
