# Beyond the Frame — 框外的海

[Watch the complete film, with sound](movie/final.mp4) ·
[Editable Project](project/project.json) ·
[Review](review/README.md) · [Making of](project/production/README.md)

A pelican pedals through a painted harbour, tears its comic-panel border and
continues into the photographic incarnation of the same place. It slows at the
water's edge and watches a distant flock. The owner selected this 25-second work
as a complete reference. Borrow its ideas independently; its tools, duration,
style change and reference inputs are choices for this story.

## Read it like a handoff

| Location | Contents |
| --- | --- |
| `movie/final.mp4` | The accepted 600-frame, 1344×768, 24 fps film, copied without re-encoding; 48 kHz stereo sound |
| `project/` | Current editable authoring state, code, actual selected footage, images, prompts, provenance, continuation notes and licences |
| `review/` | Actual final-frame sequences, anchor comparison and original production observations |

The retained generated clips are natively 1344×768; they set a detail ceiling
for this edition. Higher-resolution output can redraw code/text, but improving
the photographic picture requires suitable higher-detail source material or an
authorized new generation, not merely enlarging the accepted movie.

Copy the **whole case** to your own working directory to keep the film and review
with the Project. Edit and build the copied `project/`, never the installed Skill.
Resolve the matching authorized Runtime using the normal
[startup checks](../../../references/runtime/preflight.md). Building the included
Project needs a browser and FFmpeg/FFprobe, but no model endpoint or API key:
the selected H3 footage is already present as video Assets. From the copied
`project/`, with `<viscraft>` set to that installed Runtime entry:

```sh
<viscraft> plan .
<viscraft> build .
<viscraft> review .
<viscraft> deliver . --movie --review
```

This curated handoff preserves the accepted movie and complete editable inputs.
Its original Build, Take and provider-job IDs are documented provenance, not
active production records installed into the copied Project. A build makes new
records and a new Result; the accepted movie remains unchanged in `movie/`.
Encoded reproduction bytes can differ across environments.

## What the example demonstrates

| Film frames / time | Picture and handoff |
| --- | --- |
| 0–181 / 0–7.583 s | Code draws and animates the pelican, bicycle and comic-panel action over a generated painted background |
| 182–215 / 7.583–9 s | Code tears the panel and exposes actual H3 ride frames 0–33, one per output frame |
| 216–390 / 9–16.292 s | The edit continues the **same** H3 footage at frame 34 through 208, without restarting its opening |
| 391–599 / 16.292–25 s | A second H3 clip brings the rider to a stop, shows the flock and pulls back |

Frame ranges in this table are inclusive; Project `outFrame` values are exclusive.
The first seam combines authored graphics with generated footage. The second is
a cut to a closer beachside view, informed by the preceding clip's actual exit
frame and the shared harbour anchor. It is a spatially related shot change,
not an exact same-camera continuation.

The important repair concerned the **whole place**: matching only the bird and
bicycle left the buildings, wall, boats and shoreline free to disappear. The
production instead edited an actual code-rendered frame into a photographic
anchor, retaining those landmarks, then supplied that anchor and a code motion
guide with distinct roles. See the [paired frames](review/world-comparison.png)
and the [actual image-edit request](project/production/image-edit.json).
The returned footage determined the final tear inputs and timing. Planned images
guided the work; actual rendering and generation still required review and repair.

The final uses one shared procedural score/Foley Source, with both H3 placement
audio tracks muted. The included H3 files retain their native generated sound.
This is a film-specific mix decision, not a rule to discard native audio or proof
that synthesis sounds more natural. Change the mix after assessing the available
sound and the work's needs.

## Continue at the available authoring level

Edit `project/author/comic.mjs` for acting, drawing and the tear;
`project/author/sound.mjs` for score/Foley; and `project/project.json` for shot
selection, timing, audio and finishing. `painted-town.png` is a generated image,
not a fully code-drawn environment. The H3 clips are flattened generated footage:
their prompts are preserved, but they contain no recoverable rig or editable 3D
scene. Generating replacements is a separate, explicitly authorized operation
using currently available model capabilities. Recheck neighbouring shots and
rebuild the bound entry frames if you replace the first clip.

The [making-of notes](project/production/README.md) explain the reference roles,
edit boundaries and retained inputs. [Rights](project/LICENSES.md) preserve the
original per-Asset statements; the source and footage remain traceable through
[provenance](project/production/provenance.json).

Viscraft-owned code and media in this case use Apache-2.0, including commercial
reuse under its terms. Third-party fonts retain their own licences. See
[licence and sources](project/LICENSES.md).
