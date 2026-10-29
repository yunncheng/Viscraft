# World, Playable and live delivery reference

Optional shared spatial state, interactive gameplay recording and standalone live
packages. Ordinary code/media Projects do not require any of this.

**Contents**

1. [Playable keyboard recording and deterministic replay](#1-playable-keyboard-recording-and-deterministic-replay)
2. [Shared World, camera coverage and rough-cut editing](#2-shared-world-camera-coverage-and-rough-cut-editing)
3. [Standalone live Playable delivery](#3-standalone-live-playable-delivery-separate-from-the-movie-result)

## 1. Playable keyboard recording and deterministic replay

Author an actual controllable CodeScene for the brief. A game can use ordinary
code or bind a shared World when persistent spatial facts are needed. Verify
controls and appearance before recording; a technical demo is not a visual-quality
template.

**Default playable deliverable:** when creating a playable world or game, author
visible start/stop recording controls, recording status and a video download in
the work itself. The user need not request recording separately. Omit this only
when the user explicitly opts out or an actual platform/capture limitation prevents
it; explain such a limitation and an available alternative instead of silently
shipping without capture. The Agent implements and checks this in ordinary author
code, including the exported playable; Runtime does not inject a universal recorder.

### Review the playable work through real input

Exercise the interactions the work promises, including their failure boundaries;
a completed objective or an attractive trailer does not establish playable quality.
For a solid 3-D environment, try approaching visible obstacles from different
directions, sliding along a corner, landing on raised surfaces, and moving quickly
across a thin barrier. Check the character's occupied volume, not just its centre
or the island boundary. Ground height alone cannot describe a platform's top.
Inspect follow-camera views near walls and large props for clipping or an obscured
player. After a repair, verify that goals and routes remain reachable. Use the
relevant cases for this work; intentional pass-through, flat games and abstract
worlds need no imposed physics simulation.

Review appearance through the normal playable camera as well: move close to
important surfaces, turn around subjects and inspect near/far views along the
routes users can reach. Check subject proportions and joins, scene scale and
hierarchy, surface treatment, light/contact and repeated scenery at the actual
real-time settings. Inspect the coherence and finish of the world across important
locations and the routes between them, not only a hero asset or trailer angle.
Calibrate against finished game art in a comparable style and platform context;
pixel, cartoon or low-poly art still needs polished shapes, composition and
consistent treatment. Refined visible meshes can use simpler collision shapes. See
[3-D craft](../craft/code-visuals.md#build-three-dimensional-subjects-and-environments)
and [appearance diagnosis](../craft/review-repair.md#diagnose-three-dimensional-appearance)
for allocating detail and repairing the responsible layer. Recheck responsiveness
and motion when a visual change affects performance.

Keep movement, collision/surface queries, camera behaviour and any recording UI in
the work's author code. Choose simple colliders, a library or another suitable
implementation by actual need. Runtime executes the declared source and preserves
its inputs; it does not design the game's rules or certify them from a manifest.
Record what was actually exercised and what remains unobserved in ordinary notes.

### Choose live capture or deterministic replay for the purpose

For the default user-facing recorder, author start/stop controls, clear recording
state and a usable preview/download, with
keyboard/touch focus that does not interrupt play. Capture the user's actual
actions and timing, rather than substituting a pre-directed trailer or a scripted
playthrough. Recording starts through the user's control, not automatically on
page load. Keep recorder controls out of the captured picture where practical;
choose whether the game's HUD belongs in the intended footage. Preserve the
useful render resolution and intended game sound instead of silently exporting a
reduced-quality or muted copy.

For a canvas game, [canvas capture](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream)
can supply picture; DOM overlays need a separate capture/compositing choice.
For sound, route the intended game mix to an
[audio stream destination](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/createMediaStreamDestination)
as well as its normal output; initialize/resume live audio from user interaction
when the browser requires it. Canvas capture does not supply game audio; do not
request a microphone to stand in for it. Select a supported recording MIME type,
handle errors/empty output and
[wait for the final data and stop events](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/stop)
before assembling the file; release capture tracks and temporary URLs when done.
Keep the actual container/extension; transcode when MP4 is needed instead of
renaming a different format.
Test a start/play/stop/download cycle and decode the actual file, checking moving
picture, intended sound, elapsed time and usable dimensions. Report dropped or
stalled capture honestly; nominal frame rate does not prove smooth motion.

The downloaded recording is usable on its own; the user can keep it as their final
video without a Project import, model call or further rendering. For later work,
import it as an ordinary video Asset: edit/mix/deliver the existing picture, or
use it as a motion/composition proxy for reference generation according to the
selected model's actual capabilities. White-boxing, target-Look frame preparation
and joint video/image references are optional methods when they help; see
[the two creation routes](../workflows/capability-chains.md#playablegame-recording--output--two-creation-routes).
Do not upload or generate merely because recording is available; normal
authorization applies to any later model use.
Keep useful author-side event/state evidence if the work needs it, but do not label
it a Runtime recording session or claim deterministic replay without the contract
below. The Runtime's scheduled-input recorder does not replace the default
user-operated live recorder.

### Runtime frame-clock keyboard recording

Record an explicit keyboard schedule by driving real browser events, not by
generating fake input screenshots:

```bash
./node_modules/.bin/viscraft record <project-dir> <source-id> <relative-inputs.json>
```

The input file is an ordered array of `{ frame, type: 'down' | 'up', key }`, with
keys `ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown`, `Space` or `r`. Recording
observes the emitted DOM events and `window.viscraft.state()` after every captured
frame, then writes `recordings/<session-id>/session.json` and a picture-only
`preview.mp4`. There is no fixed session-frame/event quota or per-state size,
array-length or nesting quota. Recording JSON is held in memory: the default
128 MiB observation/file budget can be adjusted by the host through
`VISCRAFT_RECORDING_MAX_BYTES` (a positive whole number of bytes) for the memory
actually available. Capture checks cumulative observation bytes before retaining
more state; load checks the file before parsing, and replay compares states as
each frame arrives instead of retaining a second full observation array. A
budget failure reports the execution requirement without dropping frames,
reducing state or publishing an incomplete session. Adjust the execution budget
or choose the appropriate live-capture route, not the work's intended duration
or gameplay detail merely to satisfy a default. JSON serialization, source/media
hashes and credential-field protection still apply. This is controlled
frame-clock input recording, not an arbitrary realtime screen/audio recorder.

To select a recorded playthrough, set the Source's `recording` to the actual
session JSON path — it is a `browser` Source with `output: 'picture'` (a code or
game page) — retaining its entry/resources/bindings/params/seed/frames and output
settings. Build replays the
real recorded events, checks observed state equivalence, and produces a normal Take.
Composition can then trim/repeat that Take, mix authored sound and add subtitles for
a trailer; changing only the edit does not record or replay a new session. Changed
gameplay code, parameters or output settings require an explicit new recording
rather than a false equivalence claim.

**Two output routes** ([Capability chains → two creation routes](../workflows/capability-chains.md#playablegame-recording--output--two-creation-routes)).
When the user adopts the recorded picture directly, use that replay Take straight
in editing, sound and delivery — this branch calls no generation service — and the
recording `preview.mp4` can also be imported as ordinary video material. Only when
re-creation is needed does the recording become a `proxy_video` for Route 1. To
make a proxy **variant**, keep the original author source, session and picture,
create a **new** author source and explicitly **re-record**: `captureReplay`
verifies the recording's signature and hashes against the requested source (World,
entry/resources/bindings incl. an override/params/seed/frames/output, and each
frame's state), and the original recorded input events may be reused only as a
basis — identical input does not guarantee identical behaviour after edits. Never
pass an old session off as an equivalent replay, never bypass the signature check
and never alter historical hashes.

Only trusted executable game code is supported. The page contract adds `state()` and
an optional `reset()` to the usual CodeScene lifecycle; `reset()` establishes the
initial state before frame-zero input. Recorded files and preview media are
hash-checked and can accompany portable delivery. Browser capture does not record
Web Audio; use explicit Composition audio. Deterministic replay depends on the same
environment and is not guaranteed across arbitrary browser versions or machines.

## 2. Shared World, camera coverage and rough-cut editing

A Project may optionally have `worlds`; ordinary code/media Projects do not require
one. Use World when several shots must share the same persistent spatial facts, not
merely because one shot uses 3D. Entities reference the existing Project Asset IDs;
World is not another asset registry or renderer.

The current World contract has identity/revision, `units: 'meters'`,
`coordinates: 'right-handed-y-up'`, rational `fps`, `frames`, entities with
position/Euler-XYZ-radian rotation/scale/state, keyframed trajectories and
perspective camera definitions. A camera's optional `follow` makes its
position/target local offsets from the sampled entity, rotated by that entity but
not scaled. Keyframe endpoints hold; rotation interpolates component-wise, not
shortest-path quaternion interpolation. This is a deterministic authored spatial
clock, not a physics/game engine.

Trajectory `path` is `linear` (default) or `catmull-rom`. The spline interpolates
the authored positions with shared interior velocities measured in World-frame
time; uneven key intervals do not introduce a segment-speed jump at a key.
`heading: 'tangent'` derives yaw (forward +Z) from the horizontal path tangent;
otherwise the authored Euler channels interpolate. A linear path still has
corners. `closed: true` on a spline requires at least three keys with the first
position repeated at the final key; wrapped neighbours use the loop's actual
duration. The final key is the loop endpoint, not an extra pause. Sampling beyond
the key range holds position; choose repeated action intervals explicitly.

This is C1 position interpolation at interior keys, not arc-length constant-speed
motion, a continuous-acceleration rig or a damped camera. A zero horizontal
tangent has no meaningful direction; avoid degenerate/reversing paths when stable
heading matters, or author the rotation channel deliberately. Camera `follow`
still uses rigid local offsets, so authored camera anticipation/damping requires
appropriate CodeScene camera logic rather than a promise made by `follow`.

A `browser` picture Source may carry a unified `world` binding:
`world: { id, camera, mode: 'drive' | 'define', startFrame? }`; a `blender` Source
carries the same binding but is **`drive`-only** (a `define` binding is refused —
Blender samples the shared World per frame rather than defining one). With
`mode: 'drive'` the Runtime steps the World per frame and hands each frame's state
to the shot; `startFrame` (the global World frame the Source's local frame 0 maps
to) is REQUIRED, so several cameras can film one continuous action. Driving requires
the Source's output FPS to match the World FPS and `[startFrame,startFrame+frames)`
to fit its clock. With `mode: 'define'` (a `browser` Source only) only the set
definition is handed over and `startFrame` is FORBIDDEN (the shot decides its own
motion, for a player-driven game).
For each local frame, the shared Browser capture installs `window.__viscraftWorld` with `{ id, revision,
frame, fps, units, coordinates, entities, camera }` before calling the normal
`viscraft.render(ctx)`. `ctx.frame/time` remain local clip time; the World snapshot's
frame is shared action time. Author a Canvas/WebGL renderer of those facts; never
simulate a second conflicting World inside it. `sampleWorld(world,cameraId,frame)` is
also available to inspect actual states or build a live authored preview.

Select each Source interval against the shared World clock. Its action frame is
`source.world.startFrame + placement.inFrame + offset`, not the placement's programme
frame. Choose actual Take intervals after review so an unintended action restart
does not pass as multi-camera coverage.

Build freezes the resolved World and files, renders ordinary Takes and composes them
with the existing audio/subtitle system. Changing a Source's camera affects that
Source; changing shared entity/trajectory facts affects the Sources that sample that
World. Selecting or trimming accepted Take IDs does not re-sample the World. Take
selection remains explicit: a newly changed World does not rewrite the old accepted
video. World author state, renderer resources and authorized Assets participate in
the usual portable export. World state is not a physics engine or arbitrary clock-remapping contract;
backend availability and final visual quality need separate verification.

### Authoring and realization

Use the normal Browser lifecycle to render a World through Canvas/Three.js, or a
World-bound Blender Source when the task calls for that backend. Check the actual
host/backend before promising its result. Three.js is an installed Runtime
dependency; declare any used browser modules as real Project resources and retain
their licenses. Do not depend on an undeclared CDN or another work's renderer.

Use one authoritative World clock for shared motion and camera facts. Code/play
state can express transient controls; it must not silently overwrite persistent
author state or pretend a recorded input schedule is the shared film trajectory.
Verify actual controls/state, rendering and recording before building a trailer.
Select retained film Takes explicitly when an interactive addition should not
recapture accepted film pictures. A valid World or functioning game establishes
neither asset quality nor cinematic coverage.

## 3. Standalone live Playable delivery (separate from the movie Result)

```bash
./node_modules/.bin/viscraft export-playable <project-directory> <source-id> [new-package-directory]
./node_modules/.bin/viscraft serve-playable <package-directory> [port]
```

The SDK is `exportPlayable(root, sourceId, destination)` and
`servePlayable(packageRoot, port=0)`. Export returns a distinct `{ id, path, entry,
files, sha256, simulated }` Playable target, not a fabricated video Artifact. It does
not render/replay, require a movie Build or alter the existing movie Result. The
source must be a `browser` + `output: 'picture'` Source; for live play, the package
resolves current authoring files and drops the `recording` binding rather than
shipping/replaying an old session.

**Non-film exit.** A playable work can be the whole deliverable. Produce it as a
`browser` picture Source; **inspect** it by actually playing the page (or replaying
a recording) and exercising real input, not by reading the manifest; **deliver** it
with `export-playable <project-directory> <source-id>` (the primary exit — it needs
no Build). Check the start/play/stop/download cycle in that exported package too,
including the video and intended audio; a recorder that only works in the author
directory is not a finished delivery. `deliver --playable <source-id>` adds the live package to a delivery
that also selects a movie or a rendered image target; it is not the standalone
playable-only exit. **Modify** it by editing
the page and re-exporting (a changed game is a new package, not an edit of an old
one). A low-level `exportPlayable` package is a **live configuration**, not a
Build, Take or retained version: it produces no movie Result, is not a version the
lifecycle `keep`/`revert` knows, and does not itself make the gameplay art-quality
approved — the `deliver ` trailer edit (which *is* a Build) remains the
way to make a finished linear piece from the same recording.

The package contains the selected entry/resources, required resolved binding/World
Assets and a hashed `playable-manifest.json`. A local package has no fixed byte
quota; required resources stay byte-identical. Deal with an actual destination or
transport limit separately rather than reducing textures, models or sound to fit
a Runtime packaging budget. Its `project.json` is a deliberately
narrow **live configuration** (one `browser` picture Source, actual scoped bindings,
relevant World/camera, Assets and `composition.output`), not the full editable
Project.
Unrelated film shots, private references, recordings, jobs and provider keys are
excluded. Required registered resources, including vendor libraries/license files,
must match their approved hashes and redistribution rights; scope overrides are
flattened consistently into binding/entity IDs. A derived image can keep parent
reference metadata, but this live package does not include the parent's media/Build
closure. Use `exportProject` separately for a fully editable delivery (see
[Delivery](delivery.md)) or `deliverProject` for a combined bundle.

`serve-playable` verifies configuration/resource/Asset hashes and serves only
declared files on `127.0.0.1`; it reports the actual entry URL and stays in the
foreground until stopped with Ctrl+C. The SDK returns `{ url, close }` for managed
local verification. An unlisted file returns 404 and changed bytes return an
integrity failure, not silently updated content. This is trusted browser code, not
a universal security sandbox or a network-upload permission. A manifest cannot prove
gameplay is ready: actually open the page and exercise real input/state. The authored
page must implement its own live execution mode; an arbitrary capture-only CodeScene
is not automatically converted into a game.
