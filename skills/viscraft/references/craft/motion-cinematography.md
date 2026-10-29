# Motion and cinematography

**Read this when** movement or camera behavior must read a certain way, or a
stutter/stiffness needs a cause. **It does not own** the frame/sample clock or the
diagnosis workflow.

How to design movement and camera behavior that read as intended — and how to
tell a real discontinuity from an intentional hold or step. This page owns the
*craft* of motion and camera; the Runtime's frame/sample clock and the motion
diagnosis workflow live in [Timeline](../runtime/timeline.md) and
[Review and repair](review-repair.md).

## Goal

Give each shot a readable primary action with supporting secondary motion, and
direct the camera as a separate authored choice. The failure this prevents is
uniform "easing everywhere": smoothing applied to every channel and key in place
of a diagnosed cause, which turns a deliberate hold or snap into mush and hides a
real path discontinuity.

## Conditions

- The shot's intent and the action's start/end states are known.
- You know whether the motion is authored (`browser`/`blender`) or opaque
  (generated/imported). Opaque motion can be selected or regenerated, not
  re-rigged.
- You can observe a passage, or you will state honestly that you sampled stills.

## Implementation entry

- **Authored motion** — position, heading, camera target and time mapping are
  authored in the Source's code/params (a `browser` or `blender` picture Source;
  a World-bound one sets `world`). The
  source's own time carries the action; the edit frame grid is separate
  ([Runtime and authoring](../runtime/runtime-authoring.md)).
- **Authored camera** — a World camera's trajectory/target/follow is authored as
  spatial facts ([World and Playable](../runtime/world-playable.md)).
- **Edit-level motion** — placement `durationFrames` performs an explicit,
  deterministic retime with a monotonic frame selection, not optical-flow
  interpolation ([Timeline](../runtime/timeline.md)).
- **Transition motion** — a directional wipe/slide is a bounded `xfade`; `whipleft`
  / `whipright` add a horizontal smear over a fast slide (a motion *smear*, not a
  true motion-blurred camera pan); `occlude` is an authored occluder sweep, not a
  motion-tracked occluder ([Editing awareness](editing-awareness.md),
  [Timeline](../runtime/timeline.md)).

## Directing choices

- **Separate path, progress and orientation.** A smooth spatial path can still
  produce uneven motion through its time mapping or heading calculation. When
  direction comes from a path, use its continuous tangent or a verified
  approximation; a tiny finite difference on a coarse polyline can hold heading
  constant and then jump at each vertex. Increasing sample count alone does not
  establish continuity. Handle rotation wrapping according to the intended turn.
- **Direct the camera separately from the subject.** Choose framing, target and
  response for the shot. Rigid attachment suits some onboard views; another shot
  may need anticipation or damped tracking. Neither smoothing every camera nor
  adding the same easing to every channel is a general remedy. Check speed and
  acceleration changes at authored keys against the intended effect; constant
  linear motion can be exactly right. For a screen-space camera, define the
  target, screen anchor, zoom and bounds explicitly; interpolate zoom in log
  space when a large scale change calls for a proportional rate. Where a product
  shot must cut camera, lighting and an exploded-assembly beat on one clock, the
  shipped [glass-product](../../assets/studies/code-visuals/glass-product/README.md) study
  stages its five beats from the frame time alone.
- **Use the actual clock.** Evaluate authored motion from the Source/World time
  that carries the action, distinguishing it from edit placement time. For offline
  frame capture, use time-based evaluation or a deterministic precomputed
  trajectory rather than render duration or an unrecorded previous-frame state. A
  single frame must agree with sequential rendering of that frame.
- **Design motion, not a stack of stills.** State the primary action and the
  secondary motions that support it, with duration, amplitude, easing, direction
  and an observable event frame. A calm shot may deliberately hold; a busy
  decorative background is not a substitute for a readable action.
- **Keep a subject's continuous story time distinct from a clip's local time.**
  Resetting the same action at every cut can read as repeated behavior rather than
  continuity. The Runtime owns the edit frame grid; you own a clear mapping from
  simulation/creative time to that grid.
- **Give materials a process, not an effect name.** Paper overlaps and folds, ink
  spreads, a printed colour layer can misregister against its linework, light
  sweeps a reflective surface. Apply a compatible treatment to subject and
  background so the subject does not look pasted on.

## Animate a state change, an operation or a relationship

Reach for this when a shot must communicate **that something changed** — a
product configured, a value updated, a part assembled, a relationship between
objects revealed — and the change itself is the point, not the decoration.
Before you animate, state four things: the **prior state**, the **change or
trigger** that causes the move, the **resulting state**, and **which object the
audience should follow** through it. A move whose follow object you cannot name
gives the eye nowhere to land and reads as noise, however smooth it is.

Choose the transition by what the information needs, not by habit:

- **Continuous morph** — one object's geometry or appearance changes in place (a
  radius, a fill, a folded panel). Fits when the identity stays the same object.
- **Local reveal** — one region opens or is uncovered while the rest holds. Fits
  when the surrounding context must stay fixed and only a part changes.
- **Camera change** — the framing moves to show the new state (a push, a reframe,
  a new angle). Fits when the change is spatial or too large for the frame.
- **Direct cut** — the two states abut with no interpolation. Fits a hard
  information beat, a jump in state or time, or a move that would otherwise have
  to invent detail you do not have.

Implement with the real author surfaces: container width/height/radius/fill, an
anchor that keeps the followed object on a named screen point, a clear
**primary** action with supporting **secondary** motion, and content timing that
sequences the parts. Derive camera and subject transforms from their own
authored timing, keeping a followed point anchored when the shot requires it.
Check the receiving scene at its actual aspect ratio and across the move. "Make it
advanced" or "make it flashy" is not a mechanism: if the only description of the
move is a style word, you have not yet decided what changes.

This is a per-task choice, not a house style. It is not a rule that every shot
must morph one object, that a move must be one unbroken take, that motion needs
springs, that an overshoot must be held, or that every beat must change.
Abstraction and deliberate stillness can carry a beat exactly as a morph can.

## Performance and camera clocks

An intentional stepped character drawing can coexist with a smooth camera. For
example, evaluate a cel pose at `floor(time * poseRate) / poseRate` while the
camera, illumination and projection use the actual Source time. Choose the pose
rate for the Look; quantizing the whole scene can turn animation cadence into
camera judder. The same separation applies to a flat cartoon's stepped boil and
to an ink actor's deliberate pose stepping: quantize the character's drawing
cycle at its own rate while camera, paper and material response stay continuous.
Rolling motion should follow travelled distance and radius, and
contact effects should start at the actual contact event rather than at the start
of a clip. Use anticipation and recovery where the action calls for them, rather
than sliding one static pose across the frame.

For the current World trajectory, `path: 'catmull-rom'` uses authored keyframe
intervals to keep interior position velocity continuous even with uneven timing.
`heading: 'tangent'` follows the path's horizontal derivative. A linear path
retains its corners, including heading changes. Spline continuity does not imply
constant speed, continuous acceleration, or stable orientation at a stationary
tangent; inspect those against the shot. Details and loop closure are in
[World and Playable](../runtime/world-playable.md#2-shared-world-camera-coverage-and-rough-cut-editing).

## Carry meaning across a change

Choose what the audience follows through a transition: a subject, shape, gaze,
direction of travel, contact event or sound. It can move, change scale or change
Look while carrying the same story event — the
[continuity account](creative-method.md#establish-the-whole-work-and-its-changes)
owns how that relationship is carried. What this page adds is the motion check:
compare the outgoing and incoming action phases, velocity and screen geometry at
the selected cut, because a transition effect cannot repair a repeated or skipped
event. A deliberate hard cut or discontinuity can serve the story, so neither an
unbroken camera nor a numeric continuity score is a universal quality gate. See
[Editing awareness](editing-awareness.md#carry-the-event-through-a-cut) for
selection, handles and sound bridges.

When a shot combines an authored layer with retained actual footage or
generation, carry the subject, shape, gaze, direction of travel and contact
across that boundary, and reconcile the authored motion's phase and timing with
the retained clip's real motion; a proxy control does not transfer exact motion.
See [Creative method → choose continuity by the shot
relationship](creative-method.md#establish-the-whole-work-and-its-changes).

## Failure repair

Locate the affected interval and distinguish a transport/timing fault from
authored motion before choosing a repair ([Review and repair](review-repair.md)
owns the full diagnosis). Quick separation:

- If the Take already stutters before editing → the authoring/generation is
  responsible.
- If it appears only after editing → inspect trimming, retiming and frame-rate
  conversion.
- If the file checks are sound but only playback stutters → investigate the
  player/decoder before changing the work.

For authored motion, a heading that stays fixed then jumps suggests coarse path
tangents; a camera attached to that heading amplifies it. Sudden speed changes can
come from key interpolation, angle wrapping or an incorrect time mapping. More
FPS, motion blur or frame interpolation cannot by themselves repair a
discontinuous authored path. Preserve intentional holds, stepped timing, camera
shake and cuts.

## Evidence scope

Sampled states can establish discontinuities (a repeated frame, a heading jump)
but cannot prove pleasing motion. Constant frame spacing does not prove continuous
motion, and unique frames can still contain a subject or camera that jumps. A
heading/position/acceleration check over the actual time step is evidence; a
"looks smooth" impression from stills is not. When you cannot watch motion,
qualify the judgement and leave subjective smoothness unverified.

## Author-track motion diagnostic

`analyzeAuthorMotion` derives those per-frame facts from a *declared author
track*. Run it over the SAME `at(frame)` sampler your authored Source already
uses — do not re-implement the camera a second time. It reports, per frame, the
subject's projected output-pixel position, its px/frame velocity, any frame that
leaves the screen `bounds`, maximal exactly-zero-speed `hold` spans, and the
frame distance from each declared `events` frame. Give the shot's placements as
`segments` so a genuine hard cut is reported as a boundary, not a teleport.

```ts
import { analyzeAuthorMotion } from 'viscraft-runtime';
const report = analyzeAuthorMotion({
  frames, view: { outWidth, outHeight, worldWidth, worldHeight, fit: 'cover' },
  segments: [{ from: 0, to: 47 }, { from: 48, to: 95 }],
  events: [72],
  sample: (frame) => ({ subject: subjectAt(frame), camera: cameraAt(frame) }),
});
report.outOfBoundsFrames; // [] => nothing left the screen; non-empty => investigate
report.maxSpeed;          // px/frame; you decide whether that spike is intended
report.holds;             // [] or [{ from, to }] — a fact, not a defect
```

This is *declared* author evidence, on the authoring timeline. It does not prove
real visibility: occlusion, cropping, an unwritten subject and the actual pixels
still require observation. It is not a film score — there is no threshold, no
"static ratio", and no pass/fail verdict; you read the numbers and judge intent.

Two scope limits to read the facts correctly: `outOfBoundsFrames` tests the
tracked subject **point**, so a large body whose centre stays inside is not
flagged; and `events` outside `[0, frames-1]` are clamped to the nearest frame
rather than rejected. A hold that begins on a segment's first frame is reported
from the next frame (that first frame has no predecessor velocity).
