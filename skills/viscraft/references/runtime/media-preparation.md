# Media preparation reference

Bringing approved material into a Project and preparing it for use: approving a real
Take frame as an image Asset, importing host-tool or licensed material,
compositing or keying a foreground, and preparing a real recording's audio. The
*craft* of directing and developing imagery is in
[Image direction](../craft/image-direction.md) and [Code visuals](../craft/code-visuals.md);
the audio *craft* (roles, ducking, mastering) is in
[Timeline](timeline.md); analysis of existing media is in
[Media analysis](media-analysis.md).

**Contents**

1. [Approve a real Take frame as a reusable image Asset](#1-approve-a-real-take-frame-as-a-reusable-image-asset)
2. [Import approved host-tool material](#2-import-approved-host-tool-material)
3. [Approved-image cutout animation](#3-approved-image-cutout-animation)
4. [Prepare a foreground from an explicit mask or key](#4-prepare-a-foreground-from-an-explicit-mask-or-key)
5. [Prepare audio from an existing recording](#5-prepare-audio-from-an-existing-recording)

## 1. Approve a real Take frame as a reusable image Asset

```js
const hero = await promoteFrame(root, {
  take: actualTakeId, frame: 120, assetId: 'approved_hero',
  expectedRevision: project.revision,
  rights: { origin: 'actual artwork/source and approval context',
            license: 'actual applicable rights', redistributable: true }
});
```

Exactly one `take` or `artifact` is required. The frame is a **decoded source-frame
index**, not a Composition frame or a guessed timestamp. The parent must be a recorded
video from a successful Build, with verified bytes, media metadata and an in-bounds
frame. Inspect the still before using it as the approved hero frame.

This explicit approval creates a content-addressed image under `assets/`, registers a
stable Asset identity and revision-checks Project authoring state. Existing Asset IDs
are refused, not overwritten. The caller supplies real rights; Runtime cannot grant
ownership of external imagery. Private, non-redistributable approvals are legal, but
export will refuse to redistribute them or required unlicensed parents. The
Build-derived `derivedFrom` relation is one typed union: the `frame` kind retains
parent Build/Artifact/hash/frame and optional Take, and the `audio` kind
(`extractAudio`) retains the parent Build/Artifact/hash, selected stream, timebase
and interval instead. Parent bytes and Take selections are never changed. Simulated origin propagates by actual parent/content
lineage and cannot be cleared by promotion.

Use the new image Asset directly on the timeline (an `asset` reference on a
Placement or PictureLayer), in a scoped binding, or as an entry in a generation
Source's `references` (with its actual `category`/`role`). A frame from a browser- or World-authored Take is not a new 3D reconstruction; a
model-video frame remains flat. Build freezes the actual approved image and validates
its recorded parent identity. Portable export carries and verifies the derived
Asset's parent Build/Artifact closure, including frozen dependencies and rights,
rather than discarding its lineage. The operation does not upload pixels or authorize
any paid generation.

For thin CLI usage, put the same options in an explicitly authored Project-relative
JSON file and run `viscraft promote-frame <project-directory>
<relative-options.json>`. SDK callers can pass options directly. Bounds/revision/hash
failures preserve the current Project and previous Result. For a range of frames,
`promoteRange` (CLI `promote-range`) selects a Take interval with an optional `every` frame step
and writes image Assets with caller rights and `derivedFrom` provenance; promotion
copies pixels and does not create new art or recover original layers. It preserves
every requested sample without a fixed image-count quota or an automatic larger
stride; the complete selection is staged before one author revision is committed.

## 2. Import approved host-tool material

Use the library API when a host image/audio tool, local preparation or the caller
has produced actual material to retain. It copies an absolute local source file
into the Project; it does not invoke a generator, upload media or create a Take.
Selecting material from the web, verifying its license and carrying its attribution
is covered in [Media acquisition](media-acquisition.md).

### Retain host-tool candidates

Resolve the work's location through [Startup checks](preflight.md#establish-and-keep-the-projects-location).
When a host tool returns media in a cache, download location or temporary folder,
copy the candidates intended for user review/continued work into that workspace
with distinguishable names (for example `candidates/hero-a-v1.png`). Use a supported
output-location parameter when the actual tool has one; do not invent one.
Preserve the original cache file, verify the retained bytes and inspect the real
file. Keep obtainable prompt/tool/reference context in ordinary project notes.

Present the workspace paths alongside previews so the user can find the material
outside the conversation. A local candidate remains a candidate: saving or
importing it does not establish creative approval, reusable status or usage rights.
Admit suitable selected material with the API below and record its real provenance
and scoped selection. Where a Project already records a candidate for review,
keep its pending role clear. Do not rely on host-cache paths as the only retained
copies of material needed to resume or deliver this work.

```js
const project = await loadProject(root);
const material = await importAsset(root, {
  assetId: 'subject_variant',
  sourcePath: approvedOutputAbsolutePath,
  type: 'image',
  rights: actualCallerRights,
  expectedRevision: project.revision,
  // Optional: verify the bytes reported by the producing tool.
  expectedSha256: approvedOutputSha256,
  // Optional: only name actual registered parents used to make this material.
  inputs: [{ asset: existingDesignAssetId, role: 'identity and clothing reference' }]
});
```

Import `loadProject` and `importAsset` from the installed `viscraft-runtime`. Omit
optional fields when they do not apply.
Rights are caller-supplied `{ origin, license, redistributable }`; the import
does not grant rights or aesthetic approval. Supported types are `image`,
`video`, `audio`, `font`, `code` and `model`. Images currently accept PNG/JPEG/WebP and
image/video/audio bytes undergo a probe plus an actual bounded decoding check
(one picture frame or a short audio sample). This does not establish full-clip
decoding, performance or aesthetic suitability. Font/code import does not execute
or establish usability of their contents. A `model` Asset is a glTF author file
that Blender and Three bindings can consume: a self-contained `.glb` needs no
inputs, while an external-texture `.gltf` records its texture images as ordinary
`image` Asset inputs (and its buffers must be embedded, not external files).

The returned Asset has its real path/hash and revision. Existing Asset IDs are
refused: import a variant under a new ID rather than overwrite accepted bytes.
Each `inputs` entry records its parent's current Asset revision/hash and the
caller-described role after verifying the actual parent bytes. This is frozen
provenance, not a request graph: parent edits do not remake the child. It is also
distinct from the Build-derived `derivedFrom` relations — `promoteFrame`'s `frame`
kind and `extractAudio`'s `audio` kind — which name a Build Take/Artifact parent,
not a registered Asset; do not invent either record to make an unknown source look
verified.

`inspectAssetInputs(project)` compares the frozen input versions/hashes with the
current registered Assets and reports `current`, `changed` or `missing`. Use that
as a reason to inspect or remake relevant material, not automatic rejection of
accepted footage. It compares registry identity, not perceptual correctness or
the producing tool's reproducibility; normal execution/export verifies actual
required bytes separately.

Declare `simulated: true` for test-only material. Known simulated parents or
matching simulated content propagate that status and cannot be cleared by
passing false. A false flag alone never proves real Provider generation.
Portable export retains the registered input closure and checks its rights, so
private parents can prevent redistribution of the derivative package.

After import, use the returned Asset identity/path in a Source resource,
Binding or supported provider input. Inspect the actual composited frame or
generated passage before accepting the work. For a one-shot change, use a
scoped binding/Source variant; changing a global binding can affect every actual
consumer. Keep request/approval notes needed for future remaking, since imported
bytes and an input role are not the full producing tool's editable source.

Host-created images enter an ordinary Project through the actual `importAsset`
contract after the relevant review. Importing bytes does not call a Provider or
establish model quality. An image produced by the `generate-image` operation
([Generation inputs](../providers/generation-inputs.md)) is a separate operation: it
registers its result as an image Asset directly, with provider/model provenance,
rather than through `importAsset`.

## 3. Approved-image cutout animation

Use permitted approved raster art when it should supply the surface and code
should direct composition/motion. Import the real images, bind or declare them as
Source resources, await actual image decoding before capture, and author placement,
pivot, transforms and timing in an ordinary CodeScene. Inspect representative
frames and motion at output size. Rigid image transforms are not articulation,
segmentation or recovered layers. Do not call a posed sprite a convincing riding
performance when the brief needs interacting limbs, props and contact.

## 4. Prepare a foreground from an explicit mask or key

Use an actual available host preparation tool, or author local image/FFmpeg
processing from a caller-supplied mask or colour key. Confirm the tool's operation
and inspect its real result; the Runtime has no semantic background-removal model.
A luminance mask must align with the source pixels; when it replaces alpha,
preserve source RGB and do not apply the source alpha twice. A colour key needs a
specified colour/tolerance and can remove legitimate subject colours.

Inspect decoded straight-alpha output over light/dark backgrounds for halos,
holes and accidentally retained background. Keep actual hashes, rights and the
source/mask preparation relationship. Alpha is material preparation, not proof
that independent subjects or 3D layers were recovered. Admit suitable material
through `importAsset` and use it in the ordinary capture/build/review path.

## 5. Prepare audio from an existing recording

**Read this when** you have a real A/V file — a recorded Take, an imported video, a
supplied clip — and you need to keep, cut, process, reuse or mix its audio, and you
want to know exactly what the Runtime does versus what your own host tools must do.
The audio *craft* (sound roles, ducking, mastering) is in
[Timeline](timeline.md); measuring a reference is in
[Media analysis](media-analysis.md). For audio that belongs to a succeeded Build's
**Take or video Artifact**, the Runtime has an explicit extraction+registration
operation, `extractAudio` (CLI `extract-audio`), described below; it records the
real stream/timebase/sample facts. For material that is **not** Build output — a
host-tool file, an imported clip — pulling a track out of the container is a host
FFmpeg job and the result enters the Project through the ordinary `importAsset`
call in §2 like any other piece of material.

### Keep it, or extract it?

A native track can often stay where it is. Keeping the audio plus adding a music bed
needs **no** extraction: set the placement `audio: 'keep'` and shape it in place with
`audioGain`, `audioFadeInSamples`/`audioFadeOutSamples`, `audioLeadSamples` (the true
J-cut), `audioTailSamples` (the true L-cut) or `audioOffsetSamples` (a deliberate
whole-clip shift), then add the music as a separate `asset`/`source` audio
clip — the full contract is in
[Audio ](audio.md#shaping-a-kept-takes-own-audio--the-true-j-cut-and-l-cut).

Extract only when you need to treat the audio **independently** of the picture:
cutting/reusing one recording's sound under a different shot, EQ/level/denoise work,
handing it off as its own Asset, or feeding it to a model. When you extract, process
and then mix that processed copy back, you normally set the corresponding placement
to `audio: 'mute'` so the original track is not also played — otherwise you get the
same sound twice. Intentional layering (keeping the original and adding the processed
copy on purpose) is allowed; it is an authored choice, not an error. There is **no
audio de-duplicator**: the Runtime does not detect or strip a duplicate, so you make
the keep/mute decision yourself.

### Confirm the real streams before you choose

Do not assume the container's audio is a particular codec, and do not assume the
first audio stream is "the first speaker". Inspect the file and list **every** audio
stream with its own facts:

```bash
ffprobe -v error -select_streams a \
  -show_entries stream=index,codec_name,sample_rate,channels,duration,start_time \
  -of json <input.mp4>
```

An empty `streams` list means there is no audio stream at all — a real failure to
report, never silence to assume (the same signal the Runtime relies on). A non-zero
`start_time` is stream metadata about where the stream begins, **not** proof that the
audio starts at video frame 0.

### Extract and register a Take/video-Artifact's audio with `extractAudio`

When the sound you want to reuse sits in a **succeeded Build's Take or video
Artifact**, use the Runtime operation instead of a raw host command: it reads the
parent's real bytes, verifies them against the recorded hash and media, decodes
the chosen stream, and registers the result as an audio Asset with provenance.

```js
const audio = await extractAudio(root, {
  take: actualTakeId,                 // exactly one of take | artifact
  assetId: 'shot12_dialogue',
  rights: actualCallerRights,         // caller's real rights; never inferred
  expectedRevision: project.revision,
  streamIndex: 0,                     // REQUIRED, explicit: the audio-relative index
  // Optional interval in the stream's own PTS ticks; omit both for the whole stream:
  // inPts: 48000, outPts: 144000,
  // outputSampleRate: 48000,         // default: the parent Build's output sample rate
  // processing: 'trimmed take audio',
  // path: 'assets/shot12_dialogue.wav',
});
```

`streamIndex` is the **audio-relative** index `probeAudioStreams` reports and
FFmpeg's `-map 0:a:<n>` selects — it is required and never defaulted, because the
implicit default picks the stream with the *most channels*, not the first. The
operation decodes only the selected stream (`-map 0:a:<streamIndex>`) to PCM WAV
at `outputSampleRate` and writes a content-addressed file under `assets/`.

It records real facts on the new Asset's `derivedFrom` (kind `audio`): the parent
Build/Artifact/hash, the optional Take, the selected `streamIndex`, the stream's
rational `timebase`, its `startPts` and the extracted half-open `[inPts, outPts)`
interval in that timebase, and — probed from the produced file, never computed
optimistically — the output `sampleRate`, `startSample` and `sampleCount` plus
`outputSha256` (which IS the Asset's own `sha256`). `startSample` is the source
position output sample 0 maps to, so you can line the audio up against the picture
without inventing an offset.

**It refuses rather than fabricating a mapping.** A missing audio stream, a
`streamIndex` that does not exist, a negative stream start PTS, `inPts` before the
stream start, a nonempty-violating or out-of-range `[inPts, outPts)`, or a stream
with no usable timebase/duration/start PTS all fail loudly and leave the Project
and the source untouched. It is **SOURCE registration, not a second timeline**: it
never edits a Placement or creates an audio clip — place the returned Asset with an
`asset` audio clip exactly as below. `simulated` propagates from the parent lineage;
`rights` are the caller's verbatim.

This is the audio counterpart of `promoteFrame`/`promoteRange`; the Build-derived
`derivedFrom` relation is one typed union with a `frame` kind and an `audio` kind.

### Extract a new audio file with host FFmpeg

For material that is **not** Build output (a host-tool cache file, an imported clip),
select the stream explicitly with `-map`. When the container/codec allows it and the
bytes must stay unchanged, **stream-copy** to preserve the compressed audio without
re-encoding; when you must convert rate/channels or edit, **decode to WAV** (PCM).

```bash
# Stream-copy the chosen stream: no re-encode, compressed bytes preserved.
ffmpeg -hide_banner -i <input.mp4> -map 0:a:1 -c:a copy <author-area>/dialog.m4a

# Decode to WAV for editing/mixing: stereo PCM at the composition output rate (48 kHz here).
ffmpeg -hide_banner -i <input.mp4> -map 0:a:0 -vn -ac 2 -ar 48000 -c:a pcm_s16le <author-area>/bed.wav
```

Read the real container/codec before choosing the command: an MP4 may carry AAC, but
it may also carry AC-3, Opus or PCM, and a MOV/WebM/MKV differs again. Do not state
that "every MP4 is AAC", and never label a stream as a speaker. Do not overwrite the
original, and do not write into a Runtime-protected directory (`output/` or
`.viscraft/`); choose the path yourself in the author area — for example the
candidate location `candidates/audio/…` described in §2.

### Register it and place it as an audio clip

The extracted file is a host artifact until you admit it. Use the ordinary
`importAsset` contract from §2 (`type: 'audio'`, absolute `sourcePath`, real `rights`,
`expectedRevision`, optional `expectedSha256`). A file already inside the Project is
registered at its own project-relative path; a file in an external tool cache is
copied to a content-addressed `assets/` path. Supported audio extensions are `.wav`,
`.mp3`, `.aac`, `.m4a`, `.flac` and `.ogg`; import probes the file and runs a bounded
decode, which does not establish that the whole clip decodes or that it sounds right.
Declare `simulated: true` only for test-only material; known simulated parents or
matching simulated content propagate that status and cannot be cleared by passing
false.

Then place the Asset on the sample clock with an `asset` audio clip:

```js
composition.audio: [{
  id: 'dialog_under_v2', kind: 'asset', asset: 'dialog_under',
  inSample: 0, startSample: 24000, durationSamples: 96000,
  gain: 1, fadeInSamples: 240, fadeOutSamples: 480,
  bus: 'dialogue'
}]
```

`inSample`/`durationSamples` select a half-open sample interval of the Asset; `gain`,
fades, `automation`, `pan`/`panAutomation` and `bus` shape it, and Build mixes it
(`mix-audio`).

**Recording a parent.** When the file you extracted from is a registered `video`
Asset, you may record it as an `inputs` entry on the new audio Asset, which freezes
the parent's real id, revision, hash and caller-described role:

```js
await importAsset(root, {
  assetId: 'dialog_under', sourcePath: '/abs/candidates/audio/dialog.m4a',
  type: 'audio', rights: actualCallerRights, expectedRevision: project.revision,
  inputs: [{ asset: 'approved_movie', role: 'dialogue source track' }]
});
```

A **Take or Artifact parent cannot be forced into `Asset.inputs`** — `inputs` only
names registered Project Assets. A Take/Artifact parent is a different relation,
recorded by its own mechanism: `promoteFrame`/`promoteRange` record a `frame`
`derivedFrom`, and `extractAudio` records an `audio` `derivedFrom` (the extraction
path above). Do not invent either record to make an unnamed source look verified.

### Measurement and mixing, stated honestly

Level and onset are **measurements**: `analyzeAudioReference` reports 10 ms RMS energy
and energy-rise onsets (a fixed heuristic), and `review` reports measured
loudness/peak and per-clip facts. Neither listens, recognises voices, detects musical
beats/BPM, or is an aesthetic verdict — see
[Media analysis §4](media-analysis.md#4-audio-reference-evidence-for-editing).

Mixing offers three deliberate controls: a clip's `gain` (a fixed level), its
`automation` (a **hand-drawn** gain envelope) and `composition.ducking` (an automatic
bus-keyed sidechain). Which to reach for, and what ducking can and cannot know about
the material, is
[Audio ](audio.md#coordinate-sound-by-role-not-by-a-single-authority).
Choose by content: fixed gain when the level is predictable, `automation` when you
know the interval, `ducking` when a genuine control bus exists. Never require
per-track treatment as a default — per-track control exists only if the material
provides it.

### Keep sync honest and keep the original intact

After extraction, **sample 0 of the new file is not necessarily video frame 0**:
FFmpeg starts its output stream at 0 unless told otherwise, and the source stream can
carry a non-zero start. Keep dialogue and action lined up from the real measured
offset, not a guess. A deliberate time shift is **not** a J-cut — a true J-cut is
`audioLeadSamples` on a kept placement reading the Take's own pre-roll
([Kept Take audio and J/L cuts](audio.md#shaping-a-kept-takes-own-audio--the-true-j-cut-and-l-cut));
a clip's `startSample` places the extracted Asset on the sample clock and will break
sync if used to imitate one.

Record the facts against the existing author files and source records: the FFmpeg/
FFprobe version (`ffmpeg -version`), the input and output `sha256`, the stream you
chose (`-map`), the source time base/start/interval and every processing decision.
The Asset's own `sha256`/`rights`/`inputs` carry part of this; the rest belongs in
ordinary project notes and the candidate record. **Do not modify the original.** The
extracted or processed file is a **new** Asset — a new version with its own hash —
never a rewrite of the original recording, even when a stream-copy preserved the
compressed bytes exactly.

### Separation is a different capability

Extraction is a **container** operation: it moves a stream's bytes (copy) or decodes
them (WAV) and does not change what the sound contains. Whole-track trim, crossfade,
EQ, level and denoise can be done with your host's real tools and then imported as a
new Asset. Splitting vocals from accompaniment, or separating several speakers, needs a
source-separation model and is not a Runtime operation; when the material genuinely
needs it, the scope, the authorization to use a host tool, and what the derived file
may be called are in
[Audio ](audio.md#coordinate-sound-by-role-not-by-a-single-authority).

### What `probeMedia`/`MediaInfo` actually reports

`probeMedia`/`MediaInfo` reports only the **first** audio stream's sample rate,
channels and duration. It carries **no** per-stream PTS or start and does not
enumerate further audio streams. To enumerate **every** audio stream with its own
facts, use `probeAudioStreams(file)`: it returns, per audio stream, the
audio-relative `index` (the `<n>` of `-map 0:a:<n>`), `codec`, `sampleRate`,
`channels`, rational `timebase` and `startPts` (plus `durationTicks`). That is the
same real FFprobe enumeration (`ffprobe -select_streams a …`) shown above, exposed
by the Runtime; `extractAudio` uses it to select and record the stream. An empty
list is the only "no audio stream" signal — never assumed silence. The audio
duration `probeMedia` reports is the audio stream's own duration, never the
video/container clock, and no time mapping may be extrapolated from its fields.
