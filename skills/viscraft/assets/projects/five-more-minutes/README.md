# Five More Minutes — 再等五分钟

[Watch the complete film, with sound](movie/final.mp4) ·
[Final contact sheet](review/contact-sheet.png) ·
[Review and local repair](review/README.md)

A complete work: a procrastinating cloud finally chooses to let its first
raindrop fall. This is one possible approach to a storybook short, not a
required style, shot count, tool choice or production template. Borrow the story
structure, drawing, acting or sound ideas independently, adapt them, or do
something else. Partial mechanism studies remain under `assets/studies/`.

## Brief and outcome

The author's retained brief asks for a 60-second playful hand-drawn comic
animation: a cloud that keeps putting things off finally decides to rain; warm,
healing fairy-tale feeling, watercolour texture, pencil lines, exaggerated acting,
cinematic shots, playful music and detailed sound effects. This is a summary
preserved in the original notes, not a recovered verbatim chat prompt.

The included film is 60 seconds / 1,440 frames, 1920×1080, 24 fps, H.264 with
48 kHz stereo AAC. `movie/final.mp4` is the single current movie, rendered natively
from the included Project. Paths, type and procedural paper are redrawn at output
pixels while the logical staging, acting and clocks remain intact. Picture is
authored in Canvas 2D; the soundtrack uses Web Audio's OfflineAudioContext.
There is no generated video, stock recording, model submission, upload, World
or Blender dependency.

## How the work develops

| Time | Story and staging | Sound / attention |
| --- | --- | --- |
| 0–5 s | Sleeping cloud, countryside and title establish the character | Introduce the six-note theme |
| 5–11 s | The cloud changes today's rain task to tomorrow | Alarm and paper detail; a hesitant toy-band phrase |
| 11–15 s | Counting sheep becomes another excuse | Little taps and a rising answer |
| 15–19 s | Carefully tying a bow on the rainbow avoids the actual task | Light chimes keep the diversion playful |
| 19–25 s | Holding a raindrop reveals the fear behind the delay | Detached, quieter questions leave space |
| 25–31 s | A drooping flower holds out an empty cup | Fewer voices; the theme becomes a tender answer |
| 31–36 s | The cloud chooses to try one drop, releasing its list as a plane | Rising broken chords carry the decision |
| 36–40 s | Inhale, hold the actual drop, then open the hands | Withdraw the music before the release |
| 40–44 s | A closer view follows the drop into the cup | The first water event is at 41.62 s |
| 44–53 s | Rain, lifted flowers and a leaf-umbrella snail resolve the action | The theme becomes a 3/4 rain waltz with a rain bed |
| 53–60 s | The landscape and the cloud return; “today” replaces “tomorrow” | Reprise, cadence and a completed tail |

The sequence gives each delay a visible action and then reveals why it happened.
The flower/cup changes the cloud's decision; the first drop produces an observable
result before the wider rain celebration. The coral scarf, asymmetrical cloud,
palette, pencil contour and paper treatment tie the shots together. This film's
cuts are straight cuts; it is not a demonstration of match cuts, J/L cuts, every
camera technique or every Viscraft capability.

The material comes from layered paper grain, pigment patterns, washes and
double graphite contours, rather than a promise of physically simulated
watercolour. Selected drawing details use a 12 Hz clock while camera movement
and some event motion use continuous shot time; do not describe all animation
as literal hand-drawn frames or uniformly stepped 12 fps.

## What to edit

| File | Responsibility |
| --- | --- |
| [project.json](project/project.json) | Current Direction, 11 shot intentions, durations, Sources, placements, mix and mastering |
| [author/film.js](project/author/film.js) + [film.html](project/author/film.html) | Drawing language, characters, staging, captions, shot-local motion and camera |
| [author/courage.js](project/author/courage.js) + [courage.html](project/author/courage.html) | Final `cloud_08` performance: hands contact the drop before release |
| [author/score.js](project/author/score.js) + [sound.html](project/author/sound.html) | Music and procedural Foley on the same programme clock |
| [author/NOTES.md](project/author/NOTES.md) | Self-contained continuation notes |
| [LICENSES.md](project/LICENSES.md) | Code and media Apache-2.0, font OFL, and the exact sources |

`courage.js` specializes one shot while retaining the common drawing language;
it is this work's local implementation, not a new Runtime hook or prescribed way
to organize scenes. Music and Foley have separate gains inside `score.js` but
are rendered together as one sound Source and one timeline bus. Independent
recorded music/Foley stems are not supplied.

## Continue from the handoff

| Location | Contents |
| --- | --- |
| `movie/final.mp4` | The complete current film at native 1920×1080 |
| `project/` | Editable Project, author code, full font, licences and continuation notes |
| `review/` | Current-film contact sheet, cut seams and technical report; causal repair evidence and provenance |

Copy the whole case into your own working directory and work in the copied
`project/`. The Project opens directly; there is no separate reconstruction
recipe. Do not edit or build inside the installed Skill. Use the matching
Runtime, Node 22+, FFmpeg/FFprobe and a browser capture environment. No provider
configuration or API key is needed. Normal
[startup checks](../../../references/runtime/preflight.md) still apply.

From the copied `project/`, with `<viscraft>` resolved to its installed Runtime:

```sh
<viscraft> plan .
<viscraft> build .
<viscraft> review .
<viscraft> deliver . --movie --review
```

Change `author/courage.js` for the hold/release performance. Re-plan, preview the
changed passage when needed, inspect its neighbours and update the handoff.
Source input hashes track direct edits to these unregistered author files. Use
`refresh-code` if you register code as an Asset. Duration changes must coordinate
the edit, local animation, captions and sound events.

## Evidence and boundaries

[Review notes](review/README.md) explain the repaired interaction, sampled final
frames and numerical sound measurements. [Provenance](review/provenance.json)
pins the current movie/render inputs and separately identifies the original
production. This curated handoff carries one current film and complete editable
inputs; original execution caches and active Result state are not installed into
the Project. Rebuilding makes new records
and may produce different encoded bytes.

The current Project declares the full font's OFL rights and the score's native
2,880,000-sample span at 48 kHz. The score's render argument is `samples`; the
synthesis and event timing are unchanged. Provenance preserves the original
input hashes separately from that adaptation. English continuation notes and
reference packaging accompany the work.

Code-generated sound is appropriate to study here, not a default replacement for
native audio, recordings or music in another work. Sampled pictures and signal
measurements do not establish subjective sound quality or continuous acting
quality. See [licences](project/LICENSES.md) for the code, media and font terms.

Viscraft-owned code and media in this case use Apache-2.0, including commercial
reuse under its terms. Third-party fonts retain their own licences. See
[licence and sources](project/LICENSES.md).
