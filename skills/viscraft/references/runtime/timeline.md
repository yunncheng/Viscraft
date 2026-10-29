# Timeline, picture and synchronization

Use this page for picture intervals, transitions, layers, retiming, subtitles and shared event clocks. Sound follows the same Project timeline; read [Audio](audio.md) for sample-based sources, kept audio, mixing, mastering and stems.

The composition/edit fields here and the audio fields in the linked page share one Project timeline. Base Source and placement schemas are in [Runtime and authoring](runtime-authoring.md#6-project-structure-schema-and-editing); creative decisions are in the [craft pages](../craft/creative-method.md).

**Contents**

- [Choose an operation and judge its output](#what-to-reach-for--and-how-to-judge-it)
- [Still-image placements and animatics](#still-image-placements-and-animatics)
- [Transitions and match cuts](#between-shot-transitions-and-match-cuts)
- [Timed picture layers](#timed-picture-layers-and-picture-in-picture)
- [Named Look finishing](#named-look-color-finishing)
- [Retiming](#explicit-slow-motion-and-speed-changes)
- [Programme fades](#whole-programme-fade-in--out)
- [Subtitle sidecar](#subtitle-sidecar-srt)
- [Beat grid and programme length](#beat-grid-and-explicit-programme-length)
- [Shared picture, sound and subtitle events](#tie-picture-sound-and-subtitle-to-one-authored-event)
- [Flat-media reframing](#flat-media-reframing-and-alternate-format-shorts)
- [Candidate Takes](#multiple-candidate-takes-without-changing-the-final-edit)

## What to reach for — and how to judge it

The Runtime reports **facts** (measured loudness/peak, frame spans, on/off-beat
distances, truncation and beyond-take flags); it never renders an aesthetic verdict.
Read the facts, then judge the work yourself against the delivery promise. The
sections below own the full contract; this table is the decision map.

| You want to… | Reach for | Choose it when | Reach for something else when |
| --- | --- | --- | --- |
| Cut between shots | two adjacent placements (hard cut) | shots are independent and share no motion | you need a blend — use a `composition.transition` |
| Blend/dissolve two shots | `composition.transitions` (`dissolve`, wipes/slides, circles, `hblur`, `whip*`, `occlude`) over a **real** overlap | the placements genuinely overlap and you want a mixing transition | a wipe/slide is a bounded `xfade`; `whip*` is a smear and `occlude` needs a real occluder — none is true motion blur (see [Between-shot transitions and match cuts](#between-shot-transitions-and-match-cuts)) |
| Lead a shot's sound in before its picture | `audioLeadSamples` on the incoming `audio: 'keep'` placement — the **true J-cut** ([Shaping a kept Take's own audio — the true J-cut and L-cut](audio.md#shaping-a-kept-takes-own-audio--the-true-j-cut-and-l-cut)) | the incoming Take has real pre-roll and the body must stay sample-aligned | do **not** use `audioOffsetSamples` for this — it shifts the whole clip |
| Trail a shot's sound past its picture | `audioTailSamples` — the **true L-cut** ([Shaping a kept Take's own audio — the true J-cut and L-cut](audio.md#shaping-a-kept-takes-own-audio--the-true-j-cut-and-l-cut)) | sound should continue into the next shot after the picture cut | … |
| Shift a whole sound bed deliberately | `audioOffsetSamples` ([Shaping a kept Take's own audio — the true J-cut and L-cut](audio.md#shaping-a-kept-takes-own-audio--the-true-j-cut-and-l-cut)) | you truly want the entire kept clip earlier/later | it desynchronises in-clip dialogue/action — never a J/L-cut |
| Lower music under dialogue | `composition.ducking` with `{ target, control }` buses ([Automatic sidechain ducking](audio.md#automatic-sidechain-ducking)) | both buses have real members and you want automatic bus-keyed sidechain | a clip's `automation` is a **hand-drawn** envelope, not detection ([Sound arrangement and gain automation](audio.md#sound-arrangement-and-gain-automation)) |
| Fade the whole programme | `composition.fade` ([Whole-programme fade in / out](#whole-programme-fade-in--out)) | head/tail ramp to/from black, picture and audio together | a blend *between* shots is a `dissolve`, not a fade |
| Place a sound in stereo | `pan` / `panAutomation` ([Sound arrangement and gain automation](audio.md#sound-arrangement-and-gain-automation)) | you have a measured position (World azimuth, recorded `offset`) | no HRTF/room/Doppler; mono output rejects a pan |
| Cut to a musical grid | `composition.beats` ([Beat grid and explicit programme length](#beat-grid-and-explicit-programme-length)), then read the review distance facts | cuts must be audited against a declared grid | the grid is time authority, not content; an off-beat cut may be deliberate |
| Force an exact programme length | `composition.outputFrames` ([Beat grid and explicit programme length](#beat-grid-and-explicit-programme-length)) | broadcast/loop/fixed-length, or to protect a whole-song tail ([A specified song is a length authority](audio.md#a-specified-song-is-a-length-authority)) | the pad is opaque black + silence, not a fade |
| Hand off separated stems | `bus` labels on clips / kept placements ([Grouped audio stems (hand-off exports)](audio.md#grouped-audio-stems-hand-off-exports)) | a downstream mixer needs grouped exports | the movie always muxes the **full** programme mix |
| Compare takes before choosing | `buildProject({ candidates })`, then `review` strips | a shot has more than one plausible Take | strips are stills only — watch motion before accepting |
| Deliver privately | `deliver … --allow-non-redistributable` (default off) | you must package a private/rights-unverified Asset for a private hand-off | the bundle then declares itself **not cleared for redistribution** — never a public-release default |

### How to judge each craft area

- **Cut and rhythm** — read the seam stills and the per-boundary distance-to-beat
  facts from `review`. An off-beat cut can be intentional: the summary is a fact, not
  a pass/fail. Inspect the last usable frame before a transition and the first stable
  frame after it.
- **Picture** — inspect the placement-scoped contact rows and `video.repeatedFrameSpans`
  at delivery size. A repeated-frame span is a run of effectively unchanged
  consecutive frames, with the sampling method and thresholds stated in the report;
  the detector throws on a wrong decoded-frame count, so it never reports "no
  duplicates" over a failed decode. A held frame can be a deliberate pause; a black
  span can be a designed fade/tail. Neither is automatically a defect.
- **Sound** — read the measured loudness/peak, per-clip `audio.clips[]` facts
  (`truncatedByProgrammeEnd`) and per-placement `keptAudio[]` facts
  (`declaredLeadSamples`/`declaredTailSamples` vs measured `takeAudioSamples`,
  `beyondTakeAudio`). Detecting an audio stream is **not** accepting its sound; a
  loudness number is **not** a musical judgment. When you cannot listen, mark the
  semantic judgment unverified.
- **Honesty** — a source/output hash proves byte identity or reuse, never perceptual
  continuity or editing quality. Do not promote a technical pass into an aesthetic
  verdict.

## Still-image placements and animatics

Use approved original or authorized image Assets **directly on the timeline**: a
Placement (or a PictureLayer) references the Asset with `asset`, declares its stay
on the output grid with `durationFrames`, and may carry `framing: { fit:
'contain'|'cover', background: '#RRGGBB', position: { x, y } }`. An image has no
intrinsic frame rate, so the stay length is a timeline choice, not a Source
property, and such a Placement's `audio` must be `mute` (an image carries no audio
track). Default framing is `contain` on a black background. The Runtime decodes the
actual image with the shared Browser, renders a timed picture Take from it, and
passes it through Composition/audio/Build provenance. This supports real
storyboard/hero-frame stills without claiming image generation or turning them
into a finished motion film. SVG/PNG and other Browser-decodable images must have
real pixels and valid hashes/rights.

Only picture references actually placed on the timeline execute. Review framing,
proposed action, timing, camera motivation and sound before selecting actual
motion Sources. Retain the animatic as planning evidence; a slideshow does not
establish final motion or automatically reconstruct a World. Add sound with the
[audio arrangement rules](audio.md#sound-arrangement-and-gain-automation).

## Between-shot transitions and match cuts

`composition.transitions` is a list of `{ from, to, kind, startFrame, endFrame,
occluder? }` between two **adjacent** placements over an explicit overlap
`[startFrame, endFrame)`. The declared range must **exactly equal** the placements'
real overlap (the overlap is `max(startFrame + duration)` minus the later start),
and it must be shorter than both placements; a gap or an unauthorized overlap is
rejected. The kind selects the effect:

- `dissolve` — a purely tonal blend.
- directional wipes — `wipeleft`/`wiperight`/`wipeup`/`wipedown`.
- directional slides — `slideleft`/`slideright`/`slideup`/`slidedown`.
- circular reveals — `circleopen`/`circleclose`.
- `hblur` — an ffmpeg `hblur` `xfade`.
- `whipleft`/`whipright` — a fast directional slide whose overlap region is
  additionally smeared by a horizontal blur. This is a motion **smear**, **not** a
  true motion-blurred camera whip-pan (no camera displacement, no shutter model).
- `occlude` — the **only** kind that carries extra authored state: an `occluder`
  Asset id. The two shots hard-cut at the middle of the overlap while the occluder
  image sweeps across so the frame is **fully** covered at the cut, then clears.
  It is a deterministic 2-D sweep of one authored occluder (no motion tracking
  matched to the incoming shot); a transparent or perforated occluder will NOT
  hide the cut. A non-`occlude` kind must not declare an occluder, and an
  `occlude` without one is a loud error.

Every kind except `occlude` is a bounded `xfade` approximation — a directional
wipe/slide stands in for a whip-pan style transition and a circle reveal for an
occlusion-style one, but neither is true motion blur or a real foreground
occlusion. Put genuine motion-blur/occlusion in the CodeScene, or use an authored
`occlude` with a real covering element. The *craft* of choosing a cut shape is in
[Editing awareness](../craft/editing-awareness.md).

`composition.matchCuts` (optional) is a list of `{ from, to, subject, action,
fromFrame, toFrame }`. This is an author's **assertion** that two placements
correspond across a cut. It is time/metadata, not a rendered effect: it never
changes a pixel or a sample, and it carries **no similarity score** because the
Runtime cannot honestly compute subject-identity similarity. `review` reports the
declaration and the **real** boundary frames as facts only (never a pass/fail).
It is a sibling of `transitions`, not a transition kind, so a match cut may be a
zero-overlap hard cut.

Declaring none of these leaves the programme and its cache keys byte-identical.

## Timed picture layers and picture-in-picture

`composition.layers` is an optional array of `{ id, source? | take? | asset?,
inFrame, outFrame, startFrame, x, y, width, height, opacity }`; a picture `asset`
reference may also carry `framing`. Exactly one of `source`, `take` or `asset` is
selected. Each half-open source interval maps onto the same-duration output
interval at `startFrame`, scales to its pixel rectangle and overlays in array order
(last on top). The base placements remain authoritative for total duration; layers
must fit the timeline and viewport. A referenced video Asset is normalized to the
output grid, exactly as for a base Placement. These are flat rectangular
video/image panels with opacity, not recovered media layers, arbitrary blend/mask
effects or a full NLE.

Layer production uses the existing `browser`/`blender`/`provider`/`simulated` Source
paths; a `take` layer pins an accepted Take, and an `asset` layer references an imported
picture or video Asset directly. Accepted Take layers require no
re-generation/replay. Build first composes the base, then runs
`overlay-picture-layers`, then subtitles and final mux. Changing only a layer's
rectangle, opacity or interval reuses base Takes,
base composition and unchanged sound. Simulated layer inputs taint the layered
picture and final Result, but do not falsely taint the independent base or sound.
Layer-only selected Take lineage accompanies portable export.

`review` reports actual frozen layer intervals/rectangles and `layer-XX.png`
boundary strips with frames before/at the start and before/at the end. Inspect
those strips plus the completed cut; a nominal rectangle or valid media probe alone
does not prove the overlay appears on every intended frame. Do not silently extend
a layer past the underlying film or repeat its final frame beyond the authored
interval.

## Named Look color finishing

A Direction Look may optionally include a strict numeric `grade`:

```js
{ id: 'print-finish', description: 'Restrained monochrome contrast',
  grade: { brightness: 0.02, contrast: 1.1, saturation: 0, gamma: 1.04 } }
```

Bounds are brightness −1..1, contrast/saturation 0..3 and gamma 0.1..3; values
must be finite. Missing fields are neutral at execution and are not injected into
old authoring state. This is FFmpeg `eq` finishing, not a LUT loader, semantic Look
conversion, identity correction or a photorealism generator.

Each base Placement gets the grade of its Shot's named Look. Build applies
`grade-picture` to the actual selected normalized/retimed picture interval, before
composition, dissolves, picture layers and subtitles. Different Shots can use
different Looks without a global post-composition filter. Raw Takes stay unchanged;
kept audio is trimmed from the original pre-grade input (including explicit retime),
so a grade edit does not recapture sources or remix unchanged sound. Picture layers
and subtitles are not implicitly graded. Graded artifacts record parent input hashes
and their own actual frame count; normal review/export/reuse still applies.

`gradeMedia(input, output, inFrame, outFrame, grade, destination)` is available for
trusted direct use on media already normalized to the output raster/clock. It
returns video only. Use it on declared, permitted media and inspect representative
pixels and neighboring cuts. Grade can unify tonal treatment; it cannot repair
shape, identity or event-state drift.

## Explicit slow motion and speed changes

A base placement may specify `durationFrames`: the target timeline length, while
`[inFrame,outFrame)` remains the actual selected Source/Take interval. Without it
the target length is the source interval length. For example, selecting 30 frames
with `durationFrames: 60` produces a two-times-longer clip; selecting 60 with
`durationFrames: 30` speeds it up. Move downstream starts and any
sound/subtitle/layer/transition intervals deliberately; Runtime does not silently
shift the edit or repair invalid overlap geometry.

Build materializes a deterministic `retime-clip` Artifact before composition,
leaving the original Take and frozen authoring interval intact. Frames
duplicate/drop with an explicit monotonic selection mapping, not optical-flow
interpolation. If the source carries audio, it is time-stretched with pitch
preserved, bounded to the exact target sample span and remains available to
`audio: 'keep'`; missing source audio stays absent. Independent authored audio
tracks do not automatically speed up with picture. Extreme retiming can degrade
speech/music and needs actual listening rather than a technical pitch assertion.

Changing the speed or source selection of an accepted Take does not regenerate
that Take. Review reports source in/out and target duration separately and samples
the target timeline. Retimed Artifact lineage follows the usual export/reopen
rules. Public `composeVideo` expects retiming to be materialized;
`retimeClip(input,output,inFrame,outFrame,durationFrames,destination)` is
available for direct deterministic media use.

## Whole-programme fade in / out

`composition.fade` (optional, `.strict()`) is `{ inFrames, outFrames }` — both
nonnegative integers defaulting to 0. It is a **finishing pass on the output
timeline**, not a between-placement transition: the composed programme ramps from
black over frames `[0, inFrames)` and to black over
`[totalFrames - outFrames, totalFrames)`, and the mixed audio follows the same
linear envelope over the same output sample span.

```json
"composition": { "fade": { "inFrames": 15, "outFrames": 15 } }
```

- Leave it out (or set both to 0) and the output is **byte-identical** to before,
  including the `mux-final` cache key, so accepted deliveries are still reused.
- A fade longer than the programme (`inFrames + outFrames > totalFrames`) is
  rejected before any media is written.
- It changes only head/tail level; it is not a Look, a wipe, or a shape
  transformation, and it does not fade individual placements — use `dissolve`
  between placements for that.

## Subtitle sidecar (SRT)

Declaring `composition.subtitles` does two things: the captions are burned into the
picture, and `deliver` writes an editable `movie/final.srt` derived from the
**frozen build snapshot** (so it can never drift from the delivered movie). The
sidecar is hashed into the bundle manifest (`role: 'subtitle'`) and listed in
`index.html`; a project with no subtitles produces no sidecar and no manifest entry.

- Timecodes are computed exactly from the rational output fps with round-half-up and
  formatted `HH:MM:SS,mmm`; intervals are half-open `[startFrame, endFrame)`, so a
  cue's end is the start instant of the first non-visible frame.
- The file is CRLF-only. Caption text may contain internal line breaks (normalised to
  CRLF), but **must not contain a blank line** — a blank line is the SRT cue
  separator, so it would split one caption into two. The schema rejects leading,
  trailing and doubled newlines.
- This is a text sidecar: styling and `x`/`y` position are not round-tripped.

## Beat grid and explicit programme length

`composition.beats` (optional) is an authoritative clock, not content: a
strictly-increasing array of `{ id, sample }` markers whose samples must lie inside
the **programme** sample span (the padded length when `outputFrames` is set). Declare
the grid you are cutting to, then snap placement starts and transitions to it.
Adding or removing the grid changes **no** media bytes — only the operation keys that
depend on the time authority — and `review` reports, per boundary (every placement
start and both edges of every transition), the distance to the nearest beat plus an
on/off-beat summary. Those are facts: an off-beat cut is often deliberate, so never
treat the summary as a pass/fail. A beat `sample` is a sample position, not a second:
for a beat at output frame *f*, use `framesToSamples(f, fps, sampleRate)` (the
nearest integer to `f × sampleRate × denominator / numerator`) rather than a
hand-rolled product.

`composition.outputFrames` (optional) states the programme length explicitly. It must
be `>=` the content end; the difference is padded with black picture and silence, and
`fade` and the audio both extend to that explicit length. A value shorter than the
content is rejected with a message telling you to shorten placements instead — the
Runtime never silently truncates content. Omitting it derives programme length
from the content.

## Tie picture, sound and subtitle to one authored event

When an action beat — an impact, a reveal, a cut — must land together in the picture,
the soundtrack and a caption, keep ONE fact: the event frame `C` on the **composition
(story) clock**. Everything else is derived from it.

- The picture's own module usually owns **local** (source) time: a placement maps local
  frame `f` to `C = startFrame + (f - inFrame)`, so invert that to choose the shot's
  scope and the module's parameters.
- Derive the sound onset with the canonical `framesToSamples(C, fps, sampleRate)` on the
  rational `{numerator, denominator}` fps, and set the caption's `startFrame` to `C`.
  Never hand-roll `C * sampleRate / fps`.
- **Moving the event** moves all three: re-derive the picture parameter, the audio clip's
  `startSample` and the caption's `startFrame` from the new `C`. They shift by `Δ` frames
  and `framesToSamples(C + Δ) - framesToSamples(C)` samples — round each absolute event
  independently for fractional frame rates. A head trim (`inFrame`) changes the
  local-to-story mapping, not the module's local event.
- **Update the target timing, not the whole entry.** This is a local edit: find the clip
  and caption by their existing ids and change only their timing fields. Preserve every
  other field (gain, fades, bus, style, text) and leave every untargeted clip, subtitle
  and Source untouched. Do not assign a new `composition.audio`/`subtitles` array.

```js
import { loadProject, saveProject, framesToSamples } from 'viscraft-runtime';
const [root, rawFrame] = process.argv.slice(2);
const C = Number(rawFrame);            // the one authored event frame
if (!Number.isInteger(C) || C < 0) throw new Error('C must be a nonnegative integer story frame');
const p = await loadProject(root);
const { fps, sampleRate } = p.composition.output;
const limit = p.composition.outputFrames;
if (limit !== undefined && C >= limit) throw new Error('C is outside the programme');
const start = framesToSamples(C, fps, sampleRate);

const clip = (p.composition.audio ?? []).find(c => c.id === 'event-clip');
if (!clip) throw new Error('No audio clip with the intended id');
clip.startSample = start;              // the clip keeps its kind, gain, fades and length

const captions = (p.composition.subtitles ??= []);
const caption = captions.find(s => s.id === 'event-caption');
if (!caption) throw new Error('No subtitle with the intended id');
const captionFrames = caption.endFrame - caption.startFrame;
caption.startFrame = C;
caption.endFrame = C + captionFrames;  // move the caption, keep its duration and style

await saveProject(root, p, p.revision);
```

The ids are illustrative; use the actual ones. The picture half is deliberately not
scripted here: when the event lives in a module's `params` (a camera hold, a reveal),
change that parameter according to that module's own reference. Editing the sound and
caption does not by itself make the picture reach the event.

**Limit.** This is **technical** sync — a frame↔sample mapping, a declared picture event,
and evidence that the picture truly reaches its state at that frame. It does **not**
prove the mix sounds good or the event reads musically: that needs a user listening.
`C` is an integer frame; sub-frame or sample-accurate performance is not expressible
here.

## Flat-media reframing and alternate-format shorts

A real Project video Asset goes **directly on a Placement** (or a PictureLayer)
with `asset`, and an optional `framing` states how it maps to the output raster:

```js
{
  id: 'portrait_chase', shot: 'chase_shot', startFrame: 0, inFrame: 0, outFrame: 120,
  audio: 'mute',
  asset: 'approved_movie',
  framing: {
    fit: 'cover', background: '#09131d',
    position: { x: 0.5, y: 0.5 }
  }
}
```

`shot` and `audio` are **required** on every placement. Use `audio: 'mute'` for an
image Asset (it carries no track) and `audio: 'keep'` only when the referenced
video Asset or Take really has an audio stream; `keep` on a stream-less reference is
a loud Build error.

`framing` is optional. Runtime defaults are `contain`, black background and centered
position; a reference without `framing` leaves the field absent. `contain` keeps the
whole image inside the output raster with padding; explicit `cover` fills the
raster and crops excess image. Both preserve the input display aspect ratio,
including sample aspect ratio, rounded to an even pixel grid. `position.x/y` are
fractions in `[0,1]` of **available crop/padding travel** (0 = left/top, 1 =
right/bottom); they are constant per reference, not subject coordinates or tracking.
Background only affects padding. No arbitrary ROI crop or animated reframing is
provided. Direct media callers may still pass the same canonical options as
argument 4 of `normalizeMedia(input, output, destination, framing?)`.

Changing output aspect requires a newly normalized picture Take. An old accepted Take
is frozen at its original raster; do not claim it has new framing merely because
you changed output settings. Build normalizes a directly referenced video Asset to
the composition output (frame rate and geometry) before composing it: the
normalized picture Take preserves the Asset's duration and its source FPS/PTS
mapping onto the output grid, and mixed frame rates and variable-frame-rate sources
are covered. Reference identity includes its framing and the frozen input hash, so
two clips that need independent framing are two separate references. Placements
choose half-open intervals on the **normalized output FPS grid**, not arbitrary
original-source frame indices. Frame-rate normalization may drop/duplicate frames
but never changes playback speed to hit a frame count. Sound keeps its shared A/V
origin; `audio: 'keep'` trims and places the actual normalized audio, while `mute`
omits it.

Reference ordinary video Assets directly and select usable normalized-frame
intervals in Composition. Import with real hashes/rights, choose keep/mute
explicitly, and probe usable bounds. This authors an edit over flat media; it does
not recover layers or automatically identify subjects.

## Multiple candidate Takes without changing the final edit

Author alternative existing Sources with distinct parameters/seeds/attempts, then
request them for an existing Shot:

```js
const run = await buildProject(root, {
  candidates: [{ shot: 'wheel_shot', sources: ['candidate_a', 'candidate_b'] }]
});
```

The normal Build records the candidate plan and produces both Sources through the
same Artifact/Take execution. It does not change `project.json`, move placements,
choose the aesthetically best candidate or replace an accepted Take. Inspect the
returned Takes and actual media, then explicitly select a Take ID and its
available in/out range in Composition. Repeating an unchanged candidate Run reuses
existing results; a new provider attempt remains a potential new paid generation
and needs authorization. Candidate-only simulated results do not taint an
unrelated real final; only actual picture/audio dependencies do.

