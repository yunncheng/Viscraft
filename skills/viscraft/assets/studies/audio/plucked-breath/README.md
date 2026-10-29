# Plucked strings and breath — density, resonance and silence

**When to use it** — a work needs a complete 32-second music passage with
density and silence as its subject: a sparse opening, harmonic answers, a low
ostinato, a deep drum crescendo, a hard cut that removes the reverb too, a true
silent gap, a few isolated harmonics and a restrained cadence. This is the
reference to read when the missing capability is **passage structure and a real
tail cut**, not another oscillator.

**What it is not** — not a sample library, not a recorded guqin or xiao, not a
DAW, not a second timeline, and not a picture study. It authors a sound-only
Project with no composition and no slate: one `browser` `sound` Source and one
`master` sound target. It also is not
a combat cue: the upstream reference is a swordsman scene, while this passage is
an independently arranged passage of plucked strings, breath, a deep drum and
silence. Its reference value is the music’s sparse/dense development and
resonance, not an absent picture. The
density arc and hard cut are the cue's own structure; this passage does not map
to a specific current visual action and makes no observed sync claim. Nothing
here claims that a synthesised flute is a recording.

## Files

| File | Role |
| --- | --- |
| `score.mjs` | The whole piece: `buildScore(params)` (sections, events, rests, cues) and `renderScore({sampleRate, channels, frames, params, seed})` (pure seeded synthesis). No DOM, no dependencies, no samples. |
| `sound.html` | Sound entry; imports `score.mjs`, exposes `window.viscraftSound` exactly once with `{ sampleRate, channels, samples, params, seed }` and keeps the measured report. `samples` is a per-channel span, not a picture frame count. |
| `create.mjs` | Editable recipe: authors one sound Source, no timeline clip and the README/licence handoff. No picture Source, slate or video. |
| `README.md` | This file. Also copied into a generated Project. |
| `LICENSES.md` | Exact adopted MIT ranges and the full MIT text. |

Everything lives in this directory and is the only copy. `create.mjs` resolves
the files against its own `import.meta.url`, declares them with `sourcePath`,
and `authorProject` copies them into the new Project, derives their hashes and
records the real rights. `create.mjs` is the study recipe itself: a generated
Project carries `score.mjs`, `sound.html`, this README and `LICENSES.md`, not
`create.mjs`.

## The score

`buildScore(params = {})` returns (events sorted by `time`, sections contiguous):

```
{
  seconds, fps, frames, bpm, variant, transpose, gain,
  sections: [{ id, label, start, end }],
  events:   [{ id, time, duration, voice, role, midi?, gain, pan, section, tag?, bend?, vib? }],
  rests:    [{ start, end, scope }],
  cues:     [{ id, time }],
  cut:      { time, gapEnd },
  plan:     { ... }
}
```

`params` has exactly three fields:

| Param | Default | Meaning |
| --- | --- | --- |
| `variant` | `"base"` | `base` or `alternate`; the two are materially different, not a seed change. |
| `transpose` | `0` | Integer semitones, −24…24, applied to guqin and xiao events. Drums are unpitched. |
| `gain` | `1` | Author gain, 0.05…2. A final safety trim keeps the peak at or below 0.94 if an extreme value would exceed it. |

The passage is fixed at **32 s on the score's internal 24 fps grid (768
frames)**. The Project stores that as a sample span, not as a composition: the
Source renders 1,536,000 samples at 48 kHz and the `master` target delivers
1,411,200 samples at 44.1 kHz, so both describe the same seconds. There is no
duration param and no internal duration clamp: `renderScore` fills exactly the
requested sample count, and no event is silently shortened to fit an arbitrary
constant.

All boundaries are whole 24 fps frames. The ostinato's eighth note is exactly
8 frames (90 BPM: 16 frames per beat, 8 per eighth), so every event has an exact
sample position at any sample rate that divides the frame clock evenly.

Every event also carries a `role` label: the specific `tag` where one exists
(`ink-drop`, `ostinato`, `step`, `roll`, `cut-hit`, `seal`, …), otherwise the
voice family (`string`, `harmonic`, `xiao`, `granCassa`, …). Density, the
punctuated harmonics and the cut are therefore identifiable from the descriptor
alone.

**Editable hard-cut literal.** The base cut is the one-line literal
`export const HARD_CUT_FRAME = 584;` near the top of `score.mjs` (24.333 s).
`ALTERNATE_HARD_CUT_FRAME = 604` is the alternate's cut. The descriptor's
`cut.time`, the `gap` section, the `hard-cut` cue and the renderer all derive
from that constant, so editing the literal and refreshing the code asset moves
the actual truncation, not just a label. Keep it below `GAP_END_FRAME` (640).

### Base plan

| Section | Frames | Seconds | Material |
| --- | --- | --- | --- |
| `sparse` | 0–160 | 0.000–6.667 | low F open string (ink drop), synthetic xiao breath, three harmonic flecks C5/F5/A5, a falling slide |
| `answers` | 160–304 | 6.667–12.667 | press-slide A, vibrato C, three strokes F/A/C, high F6 fleck, low D/G answers |
| `ostinato` | 304–490 | 12.667–20.417 | 22 low open-string notes on the eighth grid, eight step points with frame-drum ticks, a xiao line, a sinking low F |
| `crescendo` | 490–584 | 20.417–24.333 | gran cassa + timpani hits, four falling low strings, a 28-hit roll with a squared ramp, a final cut hit |
| `gap` | 584–640 | 24.333–26.667 | 20 ms authored fade, then **exact digital zero in both channels** |
| `harmonics` | 640–696 | 26.667–29.000 | three isolated harmonics G5/C6/D6 |
| `cadence` | 696–768 | 29.000–32.000 | F2, C3, F3 + A3, a high F5 seal and a small gong; 0.3 s settle |

The hard cut is applied to the **already-reverberated pre-cut mix**, so the room
tail is removed with the dry audio. Post-gap events have their own room. The quiet gap is gated after
the DC blocker, so it is exact zero rather than a small decaying offset.

### Alternate plan

`variant: "alternate"` changes all of the following, not just a seed:

- the harmonic answer is four notes in a higher register with a different rhythm
  (F5/A5/C6/D6, then A6 as the fleck) instead of three rising notes;
- the three strokes become A/C/D and the xiao line moves down;
- the crescendo starts later, uses a shorter/faster roll with frame-drum ticks
  and a single timpani accent; the cut is at **25.167 s** with a sharp
  frame-drum + gran cassa double cue;
- the isolated group is A5/C6/F6/A6 (four notes) instead of G5/C6/D6;
- the cadence starts at 29.667 s and is shorter, with a different internal
  rhythm.

The true gap remains 2.333 s in both plans.

## What the synthesiser does (adopted mechanisms)

The implementation is independent JavaScript for `window.viscraftSound`, not a
Python copy. The exact upstream ranges are cited in `LICENSES.md`.

- **Variable fractional delay waveguide** (`pluck.py` 39–60): a ring buffer read
  with third-order Lagrange interpolation, so the delay can change per sample.
  That is what makes the press-slides, falling bends and vibrato real pitch
  movement instead of a static note with an envelope.
- **Guqin preset** (`pluck.py` 91): `t60` 7 s, loop damping 0.45, pluck position
  0.13, a 2 % noise excitation, a 0.5 slide-noise component and the five body
  resonances 95/210/420/820/1500 Hz at mix 0.55.
- **Pitch curves** (`pluck.py` 121–132): piecewise linear bends, a glide curve,
  and a delayed vibrato ramp, evaluated per sample.
- **Body resonance** (`pluck.py` 75–83): a parallel biquad bank at 95/210/420/820/1500 Hz, applied to the string at 173–180.
- **Harmonics and body** (`pluck.py` 135–160, 173–180): a touched-node variant changes
  the pluck position to 0.5, raises damping, removes the allpass and noise,
  extends the decay, and applies a high-pass at 0.7·f0; the parallel biquad body
  bank is applied after the string.
- **Sparse opening and harmonic answers** (`score.py` 44–63): the low ink-drop
  F, a slow breath, harmonic flecks, a falling slide, press-slide and vibrato,
  three single strokes and a high fleck. The notes and the new passage are ours.
- **90 BPM ostinato and steps** (`score.py` 65–84): a low open-string eighth-note
  pattern with alternating pan and a fade, short step notes with a frame-drum
  tick, a xiao line and a sinking low note.
- **Drum crescendo** (`score.py` 86–98): big low hits, falling low strings and a
  power-ramped roll.
- **Separate pre-reverb and hard cut** (`score.py` 100–114): the first part is
  reverberated on its own, then a 20 ms fade and a zero from the cut; later
  material is rendered after that point with its own room.
- **Cadence and seal** (`score.py` 133): a low root plus a high harmonic answer,
  followed by a small gong.
- **Gate to exact zero** (`score.py` 154–159): the rest is written as exact zero,
  with a short fade before it; the final 0.3 s settle is authored, not an
  arbitrary truncation.
- **Xiao build** (`score.py` 27–34) informed the *idea* of a dark low flute with
  a breath layer; no flute sample is used. The module synthesises a low harmonic
  stack, a filtered breath band and a slow vibrato, and names it synthetic.
- **Body and room**: the string body is a parallel biquad bank; the room is four
  damped combs and two allpasses per channel, with a small right-channel offset.
  It is causal and deterministic.

The drums are procedural too: gran cassa (pitch-dropping sine, sub, band-limited
noise and soft saturation), timpani (four inharmonic modes), frame drum (three
short modes plus a noise attack) and a small gong (six inharmonic partials). No
sample, TTS, sword story or recorded instrument is used.

## Render contract

```js
renderScore({ sampleRate, channels, frames, params, seed })
// -> { channels: Float32Array[] }
```

- `frames` is the **per-channel sample count** (not a 24 fps picture-frame
  count). Each returned channel is exactly `frames` long.
- `channels` is 1 or 2. The `master` target uses 2.
- Samples are finite and `|v| <= 0.94` after the final safety trim.
- The function is pure and seeded: no clock, no network, no unseeded
  `Math.random`, no state carried between calls. Two calls with the same
  arguments return byte-identical `Float32Array`s.
- `renderScore` returns only `{ channels }`. The measured report is computed by
  `scoreReport(channels, sampleRate, score)` and attached by `sound.html` as
  `window.viscraftSound.report`; it is a fact sheet, not an acceptance.

`scoreReport` reports length, peak/dBFS, RMS, per-section RMS, the maximum
absolute value inside each rest, the cue list and the cadence RMS. The default
render has an exact-zero rest, a nonzero passage, a quiet harmonic group and a
lower-level cadence.

## Authoring and rendering

```bash
<viscraft> author <skill-dir>/assets/studies/audio/plucked-breath/create.mjs ./my-plucked-breath \
  --options ink-options.json

<viscraft> build ./my-plucked-breath --target master
```

`ink-options.json` accepts `{ variant, transpose, gain, seed }`. `variant`,
`transpose` and `gain` become the Source params; `seed` is the Source seed.

This Project is deliberately sound-only, so a picture Build has nothing to
render. The Source renders natively at 48 kHz over 1,536,000 samples; the
`master` target asks for 44.1 kHz and 1,411,200 samples, and the mixer resamples
once while preserving the authored 32 s. Build produces a real `medium: 'sound'`
result with its PCM16LE WAV; `export` (or `exportProject`) carries the editable
`project/` for handoff. No slate is fabricated to satisfy a picture Build.
`exportProject(root, destination, options)` carries the same author closure
(`score.mjs`, `sound.html`, `README.md`, `LICENSES.md` and `project.json`). The
standalone `renderSoundScene` SDK entry remains available, but it is not the
reference's standard route and registers no Take.

## Editing

**Which field owns the length.** The score plan uses 768 frames on a 24 fps
grid, but the Project stores no composition. `sources[].durationSamples` is
1,536,000 at the Source's 48 kHz, and `soundTargets[0].outputSamples` is
1,411,200 at the target's 44.1 kHz; both describe the same 32 s. `renderScore`
receives the Source span as `frames`, a per-channel sample count. If you
deliberately change the length, update all of `TOTAL_FRAMES` in `score.mjs`, the
absolute frame constants in `planFor` (section boundaries,
`HARD_CUT_FRAME`/`GAP_END_FRAME` and their alternate values), the Source
`durationSamples` and the target `outputSamples` together. Keep the 24 fps grid
for the score plan; all plan frames are absolute, so the arc does not silently
stretch.

- Change **variant, transpose or gain** in `create.mjs` options or in
  `sources[].params`.
- Change the **music** in `score.mjs`: `planFor` (section boundaries), the two
  variant blocks (motifs, register, roll, cut cue, cadence) and the mix/room
  constants. Every event stays on the 24 fps grid; the frame helper `sec()`
  keeps sample placement exact.
- Change the **timbre** in the synth functions: `GUQIN`, `synthString`,
  `synthXiao`, `synthDrum`, `bodyResonance`, `room`. Keep it procedural and keep
  the honest labels: a synthetic xiao is never a recording.
- If you edit a registered code file, run
  `<viscraft> refresh-code <project> <asset-id>` so the Build/author state records
  the new bytes. Do not hand-edit `sha256` or `revision`.

## Scope and limits

- The report is a fact sheet about the signal. Listening is a separate
  judgement: no signal measurement says whether the passage works musically.
- It is a 32-second authored passage, not a general-purpose score engine.
- The guqin and xiao are intended procedural approximations, not recordings;
  a listener may still hear the synthesis, especially on sustained high notes.
  The hard cut and exact-zero gap are mechanisms of this passage, not proof that
  the cue is a complete guqin/xiao style or that it matches a picture.
- The room is a small deterministic Schroeder room, not a convolution of a real
  hall.
- The Project has no picture, so a picture Build has nothing to render. Use
  `build --target master` for the WAV and `exportProject`/`export` to hand over
  the editable Project.

Preview: `preview.mp3` — the 32-second base arrangement at the recipe defaults; no picture is fabricated.

Viscraft-owned contributions and previews use Apache-2.0. Upstream code and
third-party materials retain their notices. See [licences](LICENSES.md) for the
complete texts and scope; this does not set the licence of your whole new work.
