# Media analysis reference

Measuring opaque reference material — video cut timing, explicit 2-D marker
motion, foreground motion and audio onsets — and observing finished media honestly.
Analysis never
registers private reference material as a redistributable Asset and never claims
to recover its original authoring source. The *craft* of adapting a reference is
in [Reference adaptation](../craft/reference-adaptation.md); material intake is in
[Media preparation](media-preparation.md).

**Scope.** These are bounded geometric and energetic measures of pixels and samples.
Viscraft provides **no semantic CV** — no pose, depth, segmentation, person-identity
or general tracking analysis. Explicit-colour 2-D marker matching (§3) is **not**
person tracking. Decomposing a reference into performance, staging or camera work
therefore stays an authoring decision made from observed frames
([Reference adaptation](../craft/reference-adaptation.md)), not an analysis output.

**Contents**

1. [Observe honestly](#1-observe-honestly)
2. [Reference-guided video timing analysis](#2-reference-guided-video-timing-analysis)
3. [Explicit 2D marker motion from real reference video](#3-explicit-2d-marker-motion-from-real-reference-video)
4. [Audio-reference evidence for editing](#4-audio-reference-evidence-for-editing)
5. [Foreground measurement and adaptation planning](#5-foreground-measurement-and-adaptation-planning)

## 1. Observe honestly

When you cannot literally watch the video or hear the audio, use frame extraction and
analysis tools, and state the method and the parts you did not review:

```bash
ffprobe -v error -show_streams <final.mp4>          # resolution/fps/channels/sample rate
ffmpeg -v error -ss 3.2 -i <final.mp4> -frames:v 1 out.png   # extract a frame for the user to look at
ffmpeg -hide_banner -i <final.mp4> -af volumedetect -f null /dev/null  # loudness/peak
```

Never claim "I watched/listened to the whole thing". Artistic quality needs a user or
a tool with real audiovisual perception. Technical measurements (loudness, true peak,
artifact hashes, frame counts) are evidence, not aesthetic approval. See also
[Review and repair](../craft/review-repair.md).

### Compare selected video intervals

For proxy versus generated footage, revisions or any two local video intervals,
use the Skill's standalone helper. This complements Build `review` (selected
placements, seams and candidate Takes); it does not create a Project, register
Assets, change selection or call a provider. Requires Node, `ffprobe`, and FFmpeg
with `ass`/libass, `libx264` and an available DejaVu Sans or substitute font.

Write a small JSON request; media paths resolve relative to this file:

```json
{
  "left": { "path": "motion.mp4", "label": "Motion", "in": 0, "out": 4 },
  "right": { "path": "candidate.mp4", "label": "Candidate", "in": 0.5, "out": 5 },
  "alignment": { "mode": "elapsed" },
  "fps": 12,
  "width": 480,
  "samples": 5
}
```

```bash
node <skill-root>/scripts/compare-video.mjs comparison.json <new-output-directory>
```

Use a fresh author-owned analysis directory, outside Runtime-managed `.viscraft/`
and `output/`. Outputs are `comparison.mp4` (silent, labelled side by side),
`contact-sheet.png` (sampled rows), and `report.json` (input hashes, selections,
decoded frame indices/PTS, time mapping and sampled rows). Existing directories
are refused; a failed render leaves `FAILED.txt` and partial evidence, not a
successful report. This request is disposable analysis input, not a second edit
list or project authority. Keep production choices in the existing Project/notes.

- **`elapsed`** — each selection starts at comparison time zero; no speed change.
  Unequal lengths remain visible as `OUTSIDE SELECTED INTERVAL`, never a silently
  held frame or truncated shared duration.
- **`event`** — supply `leftEvent` and `rightEvent` inside `alignment`, in each
  source's time (for example `1.2` and `1.7`). Manually identify the event from
  actual footage. Comparison time zero aligns those events using offsets only;
  the union of both selected intervals is shown. It does not prove the events
  occurred at the same original time or align every other event.
- **`normalized`** — both selections run across the longer selected duration.
  This is explicitly labelled **RETIMED** and is only a progress overview; it
  cannot establish temporal adherence.

`in`/`out` are half-open seconds from the first decoded video frame, not container
start or frame index divided by nominal FPS. Labels/report show raw decoded
`sourcePTS` and `editTime = sourcePTS - firstPTS - in`; a frame spanning a
non-frame-aligned `in` can therefore have a slightly negative edit time. The helper
uses the last source frame at or before each requested time, so it may repeat/drop
frames at preview FPS; no interpolation or motion judgment is performed. Use a
higher preview FPS or inspect source playback for brief events. Last-frame end
uses decoded duration, with a labelled average-FPS fallback if absent. The report
retains actual clocks for mixed FPS and irregular PTS.

`width` is each 16:9 panel's even width (320–960); original picture proportions
are letterboxed using display aspect, coded orientation is retained (rotation
metadata is not applied). `fps` is an integer 1–30; `samples` is 2–12. Defaults
are those in the example. Labels use 1–28 ASCII letters/digits/spaces/`_.-`.
The assembled preview has a 512 MiB scratch-picture bound; shorten intervals or
reduce FPS/width when exceeded. Inputs must have strictly increasing decoded PTS.
This helper has no automatic aesthetic/identity/fidelity acceptance and does not
establish generation provenance. See [reference preparation](../craft/reference-adaptation.md#prepare-compatible-references-for-video-generation)
and [causal repair](../craft/review-repair.md#diagnose-proxy-to-video-differences).

## 2. Reference-guided video timing analysis

First determine which qualities of the reference should inform the new work.
Use the role and preserve/change distinction in
[Creative method](../craft/creative-method.md#assign-each-reference-a-purpose). Cut timing,
composition, identity, surface appearance and action are different constraints;
measuring one does not recover the others. Inspect the relevant actual material
before deriving authoring decisions, and keep uncertainty where the observation
or available analysis cannot establish the requested relationship.

Use a local project-relative reference video as opaque material. Analysis does not
register a private reference as a redistributable Asset and never claims to recover
its original authoring source.

```bash
./node_modules/.bin/viscraft reference <project-dir> <relative-video-path> [threshold]
```

The returned `reference-analysis` report contains decoded source-frame indices and
integer PTS ticks, their rational mapping to the requested output FPS, heuristic cut
candidates, positive half-open output-frame segments, and paths to actual extracted
review PNGs. The API `analyzeReference(root, relativePath, { fps, threshold })`
permits an explicit output FPS; the CLI defaults to the Project's FPS. Open the
stills around every proposed cut before using its timing.

One report decodes at most 10,000 source frames — a memory bound, not a creative
limit. For a longer source, analyse legal bounded segments (separate files or
explicitly trimmed copies) and treat each report's frame indices as local to that
segment; keep the per-segment offsets yourself instead of presenting concatenated
reports as one continuous decode, and never claim coverage you did not decode.

The default scene-score threshold is 0.30, not a universal creative rule. Dark
graphical hard cuts may need a lower threshold; flashes or fast motion can create
false candidates. If a chosen threshold misses known cuts, inspect actual frames and
rerun with an appropriate threshold rather than claiming the first detector pass
recovered the edit. Source PTS are mapped nearest with half-up ties; source decoded
indices are not interchangeable with output timeline frames, particularly for mixed
FPS or VFR. A missing final-frame duration uses an explicitly labelled frame-rate
fallback.

Reports live under `.viscraft/references/` as fresh derived outputs. Known simulated
provenance propagates from source content hashes; an unregistered material with
`simulated: false` means its origin is unknown, not that a real model was verified.
This operation does not analyze pose, depth, identity, tracking, music beats or
perceived sound. Respect reference rights separately from technical analysis; do not
package a private source unless its redistribution is authorized.

Use reviewed output-frame intervals to author a new work on that output clock.
Do not remap source decoded indices a second time. Analysis does not recover the
reference's editable sources; retain/replace decisions belong to the brief.

## 3. Explicit 2D marker motion from real reference video

```bash
./node_modules/.bin/viscraft track-reference <project-dir> <relative-video-path> '#ff0000' [tolerance]
```

The SDK is `trackReferenceMarker(root, relativePath, { color: [r,g,b], tolerance?,
minPixels?, roi?, fps? })`. It decodes the actual video ROI to native RGB pixels,
finds the centroid of pixels within a per-channel color tolerance and reports
original integer PTS plus exact `outputFrame` mapping. The ROI is an integer
source-pixel rectangle; returned `x/y` are normalized full-source pixel-centre
coordinates. Default tolerance is 40 and minimum matched area is four pixels.
Analysis is limited to 600 decoded frames and a 64 MiB expected RGB buffer; use a
smaller ROI for large clips. The reference remains private, unregistered material
and Project authoring state is not changed.

`present: false` has `x/y: null`; missing observations are not interpolated.
`confidence` is only matched-pixel fraction of the ROI, not identity certainty or
model confidence. Compression, blur, occlusion and similarly colored regions can
produce misses or misleading centroids. This is bounded explicit-color **2D marker
matching**, not person tracking, pose/depth, rotation, object identity, camera
estimation or 3D recovery. Reports live in fresh `.viscraft/reference-tracks/`
directories and retain input hash/origin/simulated provenance.

Use measured coordinates as an explicit hash-checked dependency of a new
CodeScene. Decide whether to hold, interpolate or hide missing observations for
the brief; do not join a trail across a gap by accident. This is independent
authoring from bounded observations, not the original scene or performance.

## 4. Audio-reference evidence for editing

```bash
./node_modules/.bin/viscraft audio-reference <project-dir> <relative-audio-or-video-path> [threshold]
```

`analyzeAudioReference(root, relativePath, { fps?, sampleRate?, threshold?, windowSeconds? })`
decodes an actual audio stream to mono PCM, reports 10 ms RMS energy and
energy-rise onset candidates, and maps sample positions to output frames with the
shared nearest/half-up rational clock. A missing stream or decoding failure fails;
actual silence yields no onsets. The default relative peak-energy threshold is
0.20. Continuous tones, fades, phase cancellation in mono and dense music can
produce missed or misleading candidates; these are not verified musical beats, BPM
or perfect sound/visual alignment.

The SDK defaults `fps` and `sampleRate` to the Project composition output. For a
Project without a composition, supply both options explicitly; a missing clock
cannot be inferred. The CLI uses composition defaults.

Reports are fresh derived JSON under `.viscraft/audio-references/`. Analysis is
bounded by an explicit window — `windowSeconds`, default **60 s**, ceiling **3600 s**
(1 h) — and the report states the exact analysed span (`windowSeconds`,
`analysedSpan.startSample`/`endSample`, `truncatedToWindow`) instead of implying the
whole source was analysed; the CLI exposes only the optional `threshold`. It explicitly
marks truncation and mono/heuristic limitations, never changes Project state or
registers private material, and traces known provenance by content hash. An unknown
material with `simulated: false` does not prove a real generation provider. Sample zero
is the decoded audio-stream origin, not necessarily video/container time zero for
arbitrary imported A/V media.

Use measured candidates as editorial evidence: inspect the surrounding action,
choose a motivated cut, and change placements or audio events at the highest
authoring level. `outputFrame` is already on the requested timeline FPS; do not
convert it a second time. Selecting a new camera Take interval should reuse
accepted Takes and unchanged sound, not generate all scenes again. The actual
sample is the sound event; its quantized output frame may be up to half a frame
away. Technical analysis is not subjective listening or automatic soundtrack
approval.

Use a canonical audio report and the exact approved audio it measured. Choose
actual onset samples and cuts; the report does not infer BPM, select a soundtrack
or call a Provider. Keep report/audio hashes and rights; align report/output FPS
and sample rates, and ensure selected events lie inside the chosen sample span.
Gain-only edits should retain suitable picture while remixing sound. Technical
alignment is not a subjective listening verdict.

## 5. Foreground measurement and adaptation planning

`analyzeReferenceForeground(root, relativePath, { threshold?, minArea?, fps? })`
segments moving foreground from a static background (a temporal-median background
subtraction plus 4-connected component analysis) and returns per-frame facts —
foreground pixel fraction, component count, largest-blob `bbox` (integer
full-source pixels) and `centroid` (full-source normalized x/y) — with coverage
and gap spans. It is a **2-D image-plane measure**: it recognizes nothing and
performs no pose, identity, depth or 3-D reconstruction. It is bounded to 600
decoded frames, a 640×360 per-frame pixel cap and a 64 MiB gray buffer, and
refuses a larger clip rather than approximating.

`planReferenceAdaptation(report, track, { requireFullCoverage? })` turns a measured
`analyzeReference` report plus a `trackReferenceMarker` track into a deterministic
`AdaptationPlan` that keeps the measured **rhythm** (the report's output-timeline
segments) and **action/path** (the marker resampled to one normalized position per
output frame) and explicitly *replaces* subject, environment and identity — it
carries no pixels and does no pose/segmentation/3-D. Full marker coverage is
required by default: a missing frame is a loud error, not an invented sample;
`requireFullCoverage: false` holds the previous position within each segment and
uses the centre if a segment begins with a gap. These fallback positions are not
measured and do not prove action continuity across a cut.
`summarizeReferenceTrack(track, { partialVisibilityRatio? })` derives that track's
gap and partial-visibility spans and confidence statistics. All three are derived
artifacts — they register no Asset and mutate no Project — so keep the report/track
hashes and inspect each segment before accepting it.
