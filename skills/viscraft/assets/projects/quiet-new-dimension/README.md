# A New Dimension of Sound — 静，启新境。

[Poster](image/launch-poster.png) · [Watch the 30-second film](movie/final.mp4) ·
[Editable Project](project/project.json) · [Review and repairs](review/README.md)

One product campaign, one Project: an editable launch poster and a restrained
earbud film share the supplied product sheet, typography, palette and closing
composition. This complete example retains the editable sources and accepted outputs.
Borrow its decisions independently; neither its black studio look nor its
code/generation mixture is a required pipeline.

| Location | Contents |
| --- | --- |
| `image/launch-poster.png` | The selected 2400×3000 poster, unchanged |
| `movie/final.mp4` | The selected 30 s / 720-frame, 1920×1080, 24 fps film, with 48 kHz stereo sound, unchanged |
| `project/` | Current editable authoring state, original product sheet, full font/licence, selected footage, compositing frames, prompts and continuation notes |
| `review/` | Actual final contact sheet, four cut strips, candidate/repair grids and original measurement report |

## What happens and how it is made

| Film time | Method and purpose |
| --- | --- |
| 0–2 s | Code-authored near-black opening and silence |
| 2–8 s | Six seconds selected from a real H3 macro-light reveal; its later ghost dissolve is excluded |
| 8–16 s | Eight seconds from the revised H3 floating-pair/case take; the first candidate's incorrect stem ends prompted a revision |
| 16–24 s | A real H3 sound-space plate, decoded frame by frame, with exact reference-image product silhouettes composited into its centre to repair shape drift |
| 24–30 s | Code-authored floating product and typography; the product pixels come from the same sheet used by the poster |

The original generated footage was 1344×768 before normalization to the delivery
raster. This is not native 1080p photography or a recovered 3D earbud model.
The poster, central sound-space repair and end card reuse actual reference pixels
inside authored SVG/Canvas contours. Their text, positioning and transforms are
editable; changing the hidden viewpoint of those flat product cutouts is not.
Generated macro/floating views can still differ in small product details.

The score is locally authored electronic synthesis on the same 30-second clock:
initial silence, a sparse D/A-based motif, filtered breath into the portal, a
rest and a short closing cadence. Generated footage keeps its native audio in
the included files, while the final mix mutes those tracks. That is this work's
mix choice, not a recommendation to replace native sound or proof of listening.

## Continue from the handoff

Copy the **whole case** to a working directory, then edit the copied `project/`.
Do not edit or build inside the installed Skill. Resolve the matching Runtime
through the normal [startup checks](../../../references/runtime/preflight.md).
Node 22+, a browser, FFmpeg and FFprobe are needed. No model endpoint or API key
is needed to rebuild: the selected generated passages are ordinary video Assets,
and the included Project has no active provider Source.

From `project/`, with `<viscraft>` resolved to that Runtime:

```sh
<viscraft> image . --target launch-poster
<viscraft> plan .
<viscraft> build .
<viscraft> review .
<viscraft> deliver . --movie --image launch-poster --review
<viscraft> workbench . --document launch-design --target launch-poster --delivery handoff
```

Use `author/poster.html` for the poster; `author/endcard.html` for the closing
composition; `author/sound-space-composite.html` for the local product repair;
`author/score.html` for music/sound; and `project.json` for timing and mixing.
`assets/space-jpeg/0000.jpg`–`0191.jpg` are consumed one per compositor frame.
Replacing that plate requires rebuilding its frame inputs and reviewing the
neighbouring cuts, not merely swapping an unrelated MP4.

The packaged poster source is taken from the Build that actually produced the
selected poster, so its authoring state corresponds to the accepted output.
A new Build creates
its own production records; encoded reproduction can differ by environment.
Original Build/Take IDs are provenance, not active execution state in the copy.

[Making-of](project/production/README.md), [provenance](project/production/provenance.json)
and [rights](project/LICENSES.md) explain the retained material and adaptations.

Viscraft-owned code and media in this case use Apache-2.0, including commercial
reuse under its terms. Third-party fonts retain their own licences. See
[licence and sources](project/LICENSES.md).
