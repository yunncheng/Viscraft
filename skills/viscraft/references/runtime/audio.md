# Audio sources, arrangement and mixing

Use this page for native sound targets and audio within a film: source samples, gain/pan, kept Take sound, stems, mastering and musical structure. Picture intervals and shared clock relationships are in [Timeline](timeline.md).

The audio fields here share one Project timeline with the linked picture/edit fields. Base Source and placement schemas are in [Runtime and authoring](runtime-authoring.md#6-project-structure-schema-and-editing); creative decisions are in the [craft pages](../craft/creative-method.md).

**Contents**

- [Sounded animatics, gain and pan](#sound-arrangement-and-gain-automation)
- [Measured mastering](#optional-measured-audio-mastering)
- [Code-authored sound](#code-authored-sound-browser-output-sound-source)
- [Kept Take audio and J/L cuts](#shaping-a-kept-takes-own-audio--the-true-j-cut-and-l-cut)
- [Grouped stems](#grouped-audio-stems-hand-off-exports)
- [Sidechain ducking](#automatic-sidechain-ducking)
- [Coordinate sound roles](#coordinate-sound-by-role-not-by-a-single-authority)
- [Song duration](#a-specified-song-is-a-length-authority)
- [Reference evidence](#sound-reference-evidence-for-editing)
- [Recorded gameplay soundtrack](#original-soundtrack-from-real-recorded-gameplay)

## Sound arrangement and gain automation

For a sounded animatic, combine [still-image placements](timeline.md#still-image-placements-and-animatics)
with real sound clips. The timeline reference owns image framing and duration;
the rules here apply to the accompanying sound and to final programme mixes.

The `source` and `asset` audio clips accept optional `automation: [{ sample,
gain }]`. Samples are local to the clip, strictly increasing in `[0,durationSamples)`.
Gains are multiplicative with clip gain and fades, linear between points and held
at endpoints; absent automation is unity. For an authored duck, reduce a
continuous music/ambience clip's envelope around the actual dialogue/accent
interval, then restore it. This is a **hand-drawn** duck, distinct from the
**automatic** sidechain ducking declared once as `composition.ducking` ([Automatic sidechain ducking](#automatic-sidechain-ducking)), which is
never authored per clip. Sound-only edits reuse picture Takes and composition.
This is sample-accurate authored automation, not automatic dialogue detection, a
music beat extractor or an audio-generation service.

### Stereo spatial placement

These clip kinds also accept optional `pan` (finite −1..1; −1 hard left, 0 centre,
+1 hard right) and `panAutomation: [{ sample, pan }]`, with the same local-sample
rules as `automation`. Author a moving sound by ramping `panAutomation` across the
clip so it travels between channels over time. The Runtime applies **constant-power**
gains per sample — `gL = cos φ`, `gR = sin φ` with `φ = (pan + 1)·π/4`, so
`gL² + gR² = 1` and neither channel exceeds unity. A centred spatial clip is
therefore −3.01 dB per channel by design; raise clip gain if you want the same
loudness as an un-panned clip. Absent `pan`/`panAutomation` a clip stays in the
default centred position.

This is **amplitude panning only**. It provides no HRTF/binaural cues, no room or
early-reflection reverb, no occlusion, no 1/r or air-absorption distance model and
no Doppler, and it is not a physical acoustic simulation. On a genuinely stereo
source, `pan` acts as a balance law (left gain to the left channel, right gain to
the right). Mono output (`channels: 1`) has no left/right field: authoring a pan
there fails loudly instead of silently doing nothing. Derive the pan curve from a
real, already-measured quantity (e.g. a playable recording's per-frame `offset`,
or a World camera-to-entity azimuth) rather than inventing screen-space position.
Panning changes only channel gain, never pitch or timing, so it stays inside the
exact-span and overload contract. Because the whole audio array is part of the
`mix-audio` operation, adding or editing a pan re-mixes only: picture Takes,
grade/compose/subtitles/layers and the recording all stay reused.

## Optional measured audio mastering

Author an explicit `composition.mastering: { targetLufs: -16, truePeakDbfs: -2 }`
when the delivery needs loudness finishing. Both values are required and finite:
LUFS −70..−5, peak −9..0 dBTP. There is no universal target or injected default;
choose for the delivery and leave AAC headroom. Omit the block to keep the original
mix path. This is post-mix mastering, not new music, automatic mix approval or a
substitute for adjusting overloaded clip gains: an overloaded mix still fails first.

Build executes `mix-audio → master-audio → mux-final`. Two-pass FFmpeg `loudnorm`
uses actual input measurements, requests linear normalization, and records the
actual `linear` or `dynamic` result. Peak constraints can require time-varying gain;
it is not guaranteed to preserve dynamics. The fixed LRA target is the broad 50 LU
filter bound, not a user-authored dynamics goal. Mono uses `dual_mono=false`.
The mastered PCM16 Artifact records settings, input loudness/peak/range/threshold,
normalization type and independently measured output. Loudnorm's internal higher
sample rate is resampled back; the canonical ceil frame-to-sample span, channels
and rate are checked exactly, without padding missing output. Verification checks
PCM loudness within 1 LU and peak within 0.2 dB of the requested settings (rounded
FFmpeg summaries), not an exact mathematical ceiling.

Silent or too-short programmes with undefined integrated loudness fail explicitly;
omit mastering or provide measurable audio, rather than treating a pass-through as
successful target normalization. Failures preserve the prior active Result. Changing
only mastering settings reuses Sources/Takes, composed picture and the original mix
within a fixed Runtime/environment; only the master and mux rebuild. The master
inherits simulation provenance from its sound inputs, not unrelated picture; a
simulated picture still makes the final movie simulated. Reports and master/mix
lineage survive verified export/reopen.

`masterAudio(input, output, frames, settings, destination)` requires an already valid,
exact-span PCM16 input at the output rate/channels and a different destination. A
sound target masters by its exact authored span (`outputSamples`) rather than a
frame count, so mastering can never change the delivered length.
The mastering report describes the actual PCM Artifact. AAC is lossy: final true
peak can differ, so inspect `review`'s separately measured delivered-file loudness
and peak. Neither normalization nor technical review proves good subjective sound;
listen to the full programme, transitions and tail before artistic acceptance.

## Code-authored sound (`browser` `output: 'sound'` Source)

Sound can be authored as code, exactly parallel to a picture CodeScene. Add a
`browser` Source with `output: 'sound'` and reference it from a `source` audio clip:

```js
sources: [{ id: 'src_score', kind: 'browser', output: 'sound', entry: 'sound-scene.html',
            resources: [], params: { bpm: 96 }, seed: 0,
            durationSamples: 96000, sampleRate: 48000 }]
composition.audio: [{ id: 'score', kind: 'source', source: 'src_score',
                      startSample: 0, gain: 0.8,
                      fadeInSamples: 2400, fadeOutSamples: 4800 }]
```

The entry page must expose `window.viscraftSound = { render, ready?, dispose? }`.
`render({ sampleRate, channels, samples, params, seed })` returns (or resolves to)
either one interleaved `Float32Array` of length `channels * samples`, or
`{ channels: Float32Array[] }` with one array per channel. `samples` is the exact
per-channel count (`source.durationSamples`) at the Source's native `sampleRate`;
a sound Source has no `frames`, so no fps conversion is involved and the renderer
never pads, truncates or resamples. A typical entry
builds an `OfflineAudioContext(channels, samples, sampleRate)`, schedules its graph,
`await`s the render and returns the channel data — `ctx.startRendering()` resolves
to an `AudioBuffer`, which the renderer does **not** accept directly, so convert
it first:

```js
window.viscraftSound = {
  render: async ({ sampleRate, channels, samples }) => {
    const ctx = new OfflineAudioContext(channels, samples, sampleRate);
    /* …schedule sources/graph on ctx… */
    const buf = await ctx.startRendering();
    return { channels: Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c)) };
  },
};
```

Build renders each referenced `browser` `output: 'sound'` Source into its own WAV
Take (an `audio` Artifact) before `mix-audio`; the clip then behaves like any
other audio input: `startSample` places it on the sample clock, `gain`/fades and
`automation` shape it, and `pan`/`panAutomation` place it in stereo. A `source`
clip has no `inSample`/`durationSamples` — the Source owns the extent, so the fade
envelope spans the Take's own length. Editing the sound entry re-renders only that
sound; editing a clip's gain/pan re-mixes without re-rendering the sound; editing
picture leaves the sound Take alone.

**Purity is the author's responsibility and the Runtime checks only what it
can.** `render` must be a pure function of `{ sampleRate, channels, samples,
params, seed }` — no `Math.random`, `Date`, `performance.now`, wall clock or
network. The Runtime validates the exact sample count, rejects non-finite
samples, and rejects any |sample| > 1 (there is no limiter; lower internal
gains). It does **not** promise byte-identical re-renders: Chrome's
`OfflineAudioContext` renders small graphs bit-identically but diverges at the
LSB for graphs with many voices. The pipeline therefore keys a
`sound` Take by its input identity (frozen entry bytes + params + seed + clock),
so a rebuild reuses the recorded Take instead of re-rendering it; two independent
roots produce signal-equivalent, exactly-spanned Takes, not necessarily
byte-equal WAVs. This is real synthesis — additive/subtractive voices, filters,
envelopes — not a sample library, convolution reverb, HRTF or a
physical-acoustic simulation. A code-authored score is **not automatically
original**: the entry may adapt upstream code, quote a melody or play a sample, and
each of those keeps its own rights. Record the entry's actual sources and licences
before describing a score as free of third-party material.

**Standalone use (non-film sound).** The same renderer is a public SDK entry:
`renderSoundScene(root, source, output, destination, hooks?, bindings?)`, where
`source` is `{ id, entry, resources, params, seed, durationSamples, sampleRate }`
and `output` is `{ channels }`. It evaluates the page contract at the Source's
native rate, writes a **PCM16LE WAV** to `destination`, and returns
`{ browserVersion, samples, channels, sampleRate }`, where `samples` is the
authored `durationSamples`. There is no CLI for it and
**no picture**: a sound render is a WAV, never a black video — do not fabricate a
frame just to fit a film-shaped output. Check the result by decoding the WAV
(`ffprobe`) and, where the host can, listening; the Runtime already rejected
non-finite samples and `|sample| > 1`.

**A low-level render is not a Build, Take or retained version.** Writing the WAV
yourself registers no Artifact, selects no Take and retains nothing, so it is not
reused or delivered as part of any Project. A sound-only work declares a
`soundTargets` entry (`{ id, sampleRate, channels, outputSamples, audio[],
ducking?, mastering?, beats? }`) in the same Project: `build --target <id>`
produces a real `medium: 'sound'` result with its WAV, `keep`/`revert`/`versions`/
`clean` treat it like any other result, and `deliver --sound <id>` hands over that
WAV plus the editable Project. No composition, fps or black video is involved, and
a sound target never overwrites a film's active result. A target's rate and channel
count belong to the target: the Source renders at its native rate and the mixer
resamples once, so real duration in seconds is preserved (48 kHz → 44.1 kHz does not
change the piece's length). When the same Source must also sit inside a picture
composition, the identical `browser` `output: 'sound'` Source is built there as a
sound Take, keyed by the frozen entry + params + seed + clock; a sound target and a
film can coexist in one Project.

## Shaping a kept Take's own audio — the true J-cut and L-cut

`audio: 'keep'` asserts the Take really carries audio: a kept placement over a Take
whose artifact declares no audio stream is a loud Build error (the kept-audio
guard in Build), so intended silence is an explicit `mute`, never an accident.
A placement that keeps its Take's own audio may also set these independent fields:

- `audioGain` — `0..2`, default 1.
- `audioFadeInSamples` / `audioFadeOutSamples` — sample-exact edge fades over the kept
  clip's own (possibly extended) extent; they are not programme fades.
- `audioLeadSamples` — non-negative integer, default 0. **The real J-cut.** It extends
  the kept audio EARLIER than the clip start by reading the Take's OWN pre-roll from
  before `inFrame` (`takeInSample - audioLeadSamples .. takeInSample`). `startFrame`
  itself is NOT moved, so the body stays sample-aligned to the picture and lip-/action-
  sync inside the clip is preserved while the incoming shot's sound leads across the cut.
- `audioTailSamples` — signed, default 0. **The real L-cut.** Positive extends the kept
  audio past the picture cut by reading the Take's own audio after `outFrame`
  (`takeInSample + clipFrames ..`); negative shortens the extent. Sound can thus
  continue into the next shot after the picture has already cut.
- `audioOffsetSamples` — signed, default 0. A deliberate **GLOBAL time-shift of the
  whole kept clip, body included** (`startSample = framesToSamples(startFrame) +
  audioOffsetSamples`; negative moves it earlier, positive later).

**`audioOffsetSamples` is NOT a J-cut.** Because it moves the entire kept clip in time,
it desynchronises dialogue and action inside that clip from the picture — a pulse that
should sound at 2.2 s sounds at 1.7 s under a −0.5 s offset. Use it only to shift a whole
sound bed deliberately. For cut-level overlap, use `audioLeadSamples` (the incoming
shot's audio leads) or `audioTailSamples` (the outgoing shot's audio trails); both read
the Take's own audio and leave the body aligned, so a true J-cut/L-cut needs no
extraction into a separate Asset.

**Asking for more lead/tail than the Take actually has is a reported fact, not an error,
and it never invents sound.** A lead longer than the Take's available pre-roll (or a tail
past its end) still builds; `review` then reports `keptAudio` facts naming the entry,
`requestedStartSample`, `leadUnderrunSamples`/`tailOverrunSamples` and `beyondTakeAudio:
true`, and the unavailable region simply contains no audio — it is omitted, never filled
with synthesised silence. Read those facts and shorten the lead/tail if the overlap was
not intended. The one case that *is* a loud error is a lead that would start the audio
**before programme sample 0** (`mixAudio: kept entry starts before the programme…`),
because that is a timeline mistake rather than a material limit. This is worth checking
after every J/L-cut: an over-long lead still builds, so treat `beyondTakeAudio` as a
fact to read, not as a failure to expect.

All six are meaningless without kept audio and are **rejected on `audio: 'mute'`**.
Omitting them applies no additional gain automation, and fades stay sample-exact over the
full (possibly extended) extent.

Over-running is never silently padded. Extending a lead or tail past the Take's real
available audio contributes no samples there — the mixer synthesises no silence — and
`review` reports the shortfall per placement as a fact (`keptAudio[]`):
`declaredLeadSamples`/`declaredTailSamples` versus the measured `takeAudioSamples`, with
`leadUnderrunSamples`/`tailOverrunSamples` and a `beyondTakeAudio` flag. Separately, an
explicit offset/tail/lead that would start before sample 0, run past the **programme**
end, or leave a non-positive extent is a loud Build error; with no explicit offset or
tail a tail that runs past the programme end is truncated.

This remains per-placement level shaping. For automatic music-under-dialogue ducking
declare `composition.ducking` ([Automatic sidechain ducking](#automatic-sidechain-ducking)) — a clip's `automation` is only a hand-drawn
envelope, not automatic detection ([Sound arrangement and gain automation](#sound-arrangement-and-gain-automation)).

## Grouped audio stems (hand-off exports)

An optional `bus` label turns audio into grouped exports. Label any audio clip, and
any placement whose `audio: 'keep'`, with `bus: '<label>'`. The Build then emits one
extra `mix-stem` WAV per distinct label (a repeated label groups its members into a
single stem) and stamps the label on that stem artifact so the delivery can read it
directly.

Two invariants matter:

- **The programme mix is still the FULL mix.** The delivered movie muxes it, so
  introducing a `bus` can never drop audio from the movie. Stems are ADDITIONAL
  grouped exports that overlap the programme — they do **not** partition it, and
  they sum to the programme only when every member happens to be routed to exactly
  one bus.
- **Labels do not invalidate the picture or the mix — with one exception.** Adding or
  removing a `bus` label reuses the programme `mix-audio` artifact byte-identically;
  only the stems appear or disappear. **Once `composition.ducking` is declared** the
  routing (which member carries which label) becomes part of the mix key, so changing a
  member's `bus` then re-mixes ([Automatic sidechain ducking](#automatic-sidechain-ducking)).

`deliver` copies the programme audio and every stem into an `audio/` directory with
per-file hashes and lists them in `index.html` — but **only when `--stems` is passed**; a default handoff ships no
`audio/` (the delivered movie already carries the mixed programme).
`audio/programme.wav` is the audio
the delivered movie actually muxes — the **mastered** mix when `composition.mastering`
is enabled, otherwise the raw programme mix — and it is byte-identical to the frozen
audio artifact already carried in the project export (the raw pre-mastering mix stays
available there for further work). The index states the measured size of that copy,
since a full-length WAV is duplicated in the project export.

A `bus` on a non-`keep` placement is rejected, and a declared bus that resolves to
**zero members** (for example `audio: 'keep'` together with a `bus` on a source with no
audio stream) is a loud Build error rather than a silent no-op. `mix-stem` artifacts are
deliberately not part of the portable export, so re-delivering a restored project
without a Build fails loudly rather than bundling a stem-less `audio/`.

## Automatic sidechain ducking

`composition.ducking` (optional) is a list of rules that lower one audio bus while
another is loud — music under dialogue, score under engine, and so on. Each rule names
a `target` bus and a `control` bus plus optional shaping:

```json
"ducking": [{ "target": "music", "control": "dialogue" }]
```

Both labels must be declared by a real member (an `audio` clip or a kept placement
carrying that `bus`); a label that resolves to no member is a loud error, never a
silently inert rule. `target` and `control` must differ.

The control bus's own mix drives a per-sample gain curve applied to the target bus:
a 10 ms one-pole detector on the squared signal, a dB threshold (`thresholdDb`,
default **-30**) and ratio (`ratio`, default **4**), a gain floor (`maxAttenuationDb`,
default **-18 dB** — ducking only ever attenuates, never boosts), and dB-domain attack
and release smoothing (`attackSamples` default **5 ms**, `releaseSamples` default
**200 ms**). Members that are not on the target bus are untouched.

Recomputing scope: adding, changing or removing a rule re-runs `mix-audio` (and
`mux-final`) while the picture Sources and `compose-video` are reused, so the picture
artifact is identical. Because the curve is applied **per member by its label**, a change to
*which* member carries the target or control label also invalidates the mix — the
routing is part of the mix key whenever any rule is declared. A stem (`mix-stem`) is
ducked only by rules that target it; an unrelated stem's key is unaffected by both the
rules and the routing. Omitting `ducking` entirely applies no sidechain reduction and
keys exactly.

Honest scope: this is an envelope-following, bus-keyed ducking rule. It is **not**
dialogue detection, not a full compressor, not a lookahead limiter and not a
broadcast-standard sidechain. You declare the buses; the Runtime does not decide that
something is speech.

## Coordinate sound by role, not by a single authority

Generated and media Takes increasingly arrive **with their own audio track**, and that
track can compete with the music/SFX/voice we mix. The failure is not level: it is two
soundtracks expressing the same thing — two pieces of music at once, native dialogue
under a re-recorded voice, the same action sounded twice. Loudness normalization cannot
fix repetition, so name what each sound is *for* early; the keep / process / replace for
a given Take is decided after you review what it actually contains.

**Coordinate each sound by role, not by one per-work choice.** Take the roles the work
actually needs — music, dialogue, ambience, foley/SFX, and anything else you name — and
for each decide, per element, whether to keep the Take's own audio, process it, or add
material on an independent clip. The Runtime fixes no correct answer and injects no
default: what is right depends on the content of the material, the work's goal and what
you can observe (craft: [Sound design](../craft/sound-design.md)). A kept placement and
authored `composition.audio` clips coexist on the shared clock, so keep and add are not
mutually exclusive. There is no schema `role` field — the roles live on the free-form
`bus` label ([Automatic sidechain ducking](#automatic-sidechain-ducking)), a routing label you declare.

**Priorities outrank provenance.** Where they apply — score continuity across a cut,
dialogue intelligibility, sound-effect **uniqueness**, sync — they take precedence over
the *category* a sound came from. The test is never "native or added?" but "does this
sound do its job once, clearly, in sync, without duplicating another role?" Two sources
that express the same thing are the defect, whatever their origin.

**Review picture and sound together when a Take arrives.** `review` reports, per Take, a
plain `hasAudio` fact in its `takes` list: whether the Take's artifact really declares
an audio stream (probed from the file; an audio-only `output: 'sound'` Take reports `hasAudio: true,
audioOnly: true`). That is a **fact**;
"the sound is acceptable" is a **judgment** — detecting a stream is not accepting it.
Judge the content and the sync (dialogue intelligibility, whether the sound matches the
action, whether it is the take's real performance). When you cannot actually listen, mark
the semantic judgement **unverified**; do not assert quality you did not observe.

**Choose keep / process / replace by sound role, not by origin.** Coordinate speech,
music and SFX by what they *are* — ducking is keyed only on the `bus` labels you declare,
never on who produced the audio. So: if acceptable native dialogue exists, do not layer a
re-recorded voice over it; if the action is already sounded, add only what is missing; if
the whole work uses one score, do not let every shot carry its own music. Express it with
our primitives: label clips and kept placements with a role `bus`
(`dialogue`, `music`, `ambience`, `sfx`, or any label the work uses), then add
`composition.ducking` rules
(`{ target, control }`, [Automatic sidechain ducking](#automatic-sidechain-ducking)) so music yields to dialogue and score yields to engine. The
roles are what you declare; the Runtime never decides that a track is speech.

**A mixed track: what the Runtime can and cannot do.** If dialogue, music and SFX are
already baked into one track, the Runtime has **no source separation**, so it cannot
*independently* rebalance the music without also moving the dialogue beneath it. That is
not the same as having no recourse: the whole track is still a normal audio input — it
can be cut, level-matched, faded, routed to a `bus`, mixed and layered with other tracks
on the shared clock, and processed with your own tools then re-imported as a new Asset.
What the Runtime cannot do is recognise or split its internal content. A `bus` label is
a **routing label, not content recognition or a separation tool** — labelling a mixed
track `dialogue` does not make it dialogue or split it, and ducking that `bus` ducks
everything inside it, **including the dialogue**. Only *independent* control of the baked
layers needs different *material* (a separated-stem or dialogue-only take), not the
schema.

**Extraction is not separation.** Taking a stream out of its container — the
`extractAudio` path in
[Media preparation §5](media-preparation.md#5-prepare-audio-from-an-existing-recording)
— copies or decodes the bytes that are already there and changes nothing about what the
sound contains. Whole-track trim, crossfade, EQ, level and denoise can be done with the
host's real tools and imported back as a new Asset; the Runtime does not run them.
Separating vocals from accompaniment, or splitting several speakers, is a **different
capability** that needs a source-separation model the Runtime does not provide. Use such
a tool only conditionally, after checking the tool, the model, its licence, the quality
on the actual material, and the authorization to install, download or upload it — never
as a required step, and never by silently installing, downloading or uploading
anything. Do not advertise universal dialogue splitting, and do not describe a
separation output as "restoring the original recording": it is a new derived file with
model artifacts, not the original stems. Keeping the mix whole and treating it as one
element, or replacing unsuitable material, remain valid choices.

**Let sound follow the picture edit by role.** Performance-synced sound (dialogue,
footsteps) travels with its Take and is trimmed with it — `audio: 'keep'` plus
`audioLeadSamples`/`audioTailSamples` for true J/L-cuts ([Shaping a kept Take's own audio — the true J-cut and L-cut](#shaping-a-kept-takes-own-audio--the-true-j-cut-and-l-cut)); `audioOffsetSamples` shifts
the whole clip instead and is **not** a J-cut. Cross-shot music and
narration live on an **independent timeline** (authored `audio` clips), not glued to one
shot. Replacing one visual candidate must never silently replace the sound already
accepted for the whole work: a new candidate Take changes sound only if you explicitly
point a `keep` placement at its audio.

`audio: 'keep'` is an **enforced assertion**: a kept placement over a Take whose artifact
declares no audio stream is a loud Build error (the kept-audio guard in Build), so
asking to keep audio that does not exist fails instead of passing as silence —
silence is always an explicit `mute`, never an accident. (A placement that also declares
a `bus` defers to the memberless-bus error instead, [Grouped audio stems (hand-off exports)](#grouped-audio-stems-hand-off-exports), so one mistake yields one
message.)

## A specified song is a length authority

When the user specifies a complete song as the soundtrack, decide and state up front
whether the **whole song** is the work's length authority or an authorised excerpt is
used. The programme length is derived from the picture (unless `composition.outputFrames`
overrides it), so a declared music Asset
longer than the programme is cut at the programme end with no signal, and a revision that
**shortens** the picture can silently amputate a song's tail.

Protect against this: when the whole song is the authority, set `composition.outputFrames`
to at least the song's frame span (or extend the picture to it) rather than letting a
short picture truncate it. After any edit that changes the programme length, check
`review`'s per-clip facts (`report.json` → `audio.clips[]`): `assetSamples` (the asset's
real audio length in output samples), `usedSamples`, and `truncatedByProgrammeEnd` (true
when the clip's used span reaches past the programme end). `truncatedByProgrammeEnd` is a
fact, never a verdict — an intentional stinger or deliberate cut is valid — but for a
complete song it is the signal that a picture-length change amputated the tail.

## Sound-reference evidence for editing

Audio-onset analysis (`audio-reference` / `analyzeAudioReference`) and the
"produce visuals from an approved measured soundtrack" recipe are documented with
the other media-analysis operations in
[Media analysis §4](media-analysis.md#4-audio-reference-evidence-for-editing).
Use measured candidates as editorial evidence — inspect the surrounding action,
choose a motivated cut, and change placements or audio events at the highest
authoring level. Technical analysis is not subjective listening or automatic
soundtrack approval.

## Original soundtrack from real recorded gameplay

Use actual verified Playable state and selected Take intervals as evidence for
sound events. Match recording/output clocks, account for explicit retiming and
inspect each important event against the real picture. Never invent telemetry for
a shot or gap without recorded state. Author sound independently on the shared
timeline; technical timing is not a musical-quality verdict.
