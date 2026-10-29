# Earbuds launch — production notes

Production methods and measured results for the retained poster and film.
See [the case README](../../README.md) for setup and current commands;
`project.json` owns the current edit.

## Creative decisions

The launch poster is 2400 × 3000, with editable Chinese and English text in
`author/poster.html`. Product silhouettes use SVG clips over the supplied sheet,
retained as `assets/product-reference.png`, with a light shading layer.
Position, angle, copy, colour and layout remain editable.

The film is 720 frames at 24 fps, exactly 30 seconds, 1920 × 1080, with 48 kHz
stereo sound. Generated footage was 1344 × 768 before normalization.

- 0–2 s: near-black silence and a barely visible silver trace.
- 2–8 s: macro light reveal; its later ghost dissolve was trimmed away.
- 8–16 s: floating pair and charging case. A revised generation corrected
  incorrect dark stem ends in the first candidate.
- 16–24 s: generated sound-space plate with reference-derived product
  silhouettes composited over its centre to repair vent-shape drift.
- 24–30 s: quiet floating pair and campaign lockup, using original reference
  pixels under authored flat transforms.

Four real H3 209-frame Takes were generated, covering three content designs and
one suspension revision. Reference conditioning retained the overall design but
did not lock every product detail. Original product pixels carry the poster,
central sound-space product and closing signature; these are authored cutouts,
not reconstructed 3D geometry.

## Methods and reproducibility

The film combines browser-authored visuals and sound, FFmpeg media processing,
and real H3 Ref2VA footage generated through a local service. Selected footage
is included as video Assets; rebuilding needs no model service.
Original Take identities and requests are recorded in `provenance.json` and
`video-prompts.json`. They document production, not active provider Sources or
authorization for new submissions.

The sound-space plate derives from Take
`take-490fed1355b530ba37a29ad28feb8060a2087088`.
Its decoded frames, `assets/space-jpeg/0000.jpg` through `0191.jpg`, were made
with FFmpeg in one pass as high-quality 4:4:4 JPEG. The browser compositor reads
frame N for output frame N, avoiding browser video-seek caching. The frames
and original plate are declared resources; their upstream product reference
is recorded on `sound_space_plate`.

The unified soundtrack in `author/score.html` is original sparse electronic
synthesis: initial silence, low D/A resonance, small harmonic pulses, a rising
filtered breath into the spatial passage, then a rest and short final cadence.
Generated Take audio is muted. Mastering targets are -18 LUFS and -2 dBTP;
measured results below describe the retained output.

## Review and measured result

The poster review covered Chinese text, spacing, silhouettes and silicone edges.
Generated passages were inspected as sampled frame grids. The sound-space
composite and transition into the signature were checked in actual output frames.
The companion `review/` directory retains contact-sheet, cut-seam and audio
measurement findings. The record does not include a full real-time viewing or
subjective listening assessment.

Build `build-e13eae34-f3f9-435d-9f81-e35f54509dc3` produced 720 frames / 30 seconds.
The final decoded AAC measured -18.4 LUFS integrated, -1.9 dBTP and 11.6 LU range.
Opening silence measured 2.00058 seconds; the final tail falls silent before
the end. The contact sheet, all four cut-seam strips and the final sound-space
composite at 20 seconds were inspected.
