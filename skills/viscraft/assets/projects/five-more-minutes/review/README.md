# Review evidence — meaning, contact and the first drop

[Current film](../movie/final.mp4) · [Contact sheet](contact-sheet.png) ·
[Technical report](report.json) · [Provenance](provenance.json)

## Current delivery evidence

The contact sheet samples the first, middle and last delivered frame per
placement from the included native-1080p movie. The ten strips in `seams/` show
adjacent frames at its cut boundaries. `report.json` measures this same movie;
its Build, movie and review hashes are pinned in provenance.json.

The report's `.viscraft/...` paths locate the producing Build's files; those
execution caches are not installed into this editable reference. Use the local
contact sheet and seams to read the evidence, or run `review` after building a
copy to obtain its own report. The movie, source and review have one current
state; earlier production footage is not a second bundled viewing edition.

The source redraws paths, type and procedural paper at output pixels, retaining
the logical staging, acting and clocks. Sampled pictures, source hashes and
decoded timing were checked; full-motion and subjective listening judgments
are not claimed by those checks.

## One causal repair

The 36–40 s shot promises that the cloud holds and releases the raindrop. The
first production version placed the drop below the cloud without visible hand
contact. A release was implied by pose and caption but the grasp was missing.

- [Before](refinement/before.png) and [after](refinement/after.png) are the original
  production's paired 720p stills at shot-local frame 34 (1.417 s into `cloud_08`,
  movie frame 898). Their equal scale isolates the hand/drop contact change.
- [Before sequence](refinement/before-action-strip.jpg) is the pre-repair passage.
- [Repaired sequence](refinement/final-action-strip.jpg) samples the original
  repaired production at frames 869, 898, 919, 955, 962, 986, 1000 and 1013. It
  follows inhale/hold, release, fall, cup contact and response across two shots.
  This retained comparison explains the repair; the contact sheet and seams
  above describe the current movie.

`courage.js` loads after `film.js` only for `cloud_08`; its hands meet the actual
drop before opening. The production plans [before](refinement/plan-before-rebuild.json)
and [after](refinement/plan-after-rebuild.json) record the local repair's reuse:
only `cloud_08` needed new work, while ten other picture Sources and the sound
Source remained reusable. They are causal evidence, not active Takes to inject
into a new copy. The authored `storyboard.jpg` also comes from rendered source
frames, not a pre-approved image-generation stage.

## Sound and technical observations

- The source spans 2,880,000 samples/channel at 48 kHz. The current movie has
  60 seconds of stereo sound, with no soundtrack truncation by the programme.
- [Source window measurements](audio-windows.json) describe the retained score:
  the quiet interval is 39.3–41.6 s; the first water/chime event starts at
  41.62 s. The current encoded movie's threshold-based silence interval is
  39.1842–41.6183 s. Source silence and encoded threshold detection differ.
- Current measured loudness is -16.9 LUFS and -1.8 dBTP; authored targets are
  -17 LUFS and -2 dBTP. Targets are not measured compliance.
- No black-frame interval was detected. Repeated-frame measurements are coarse
  facts: holds, fixed paper, small movements and the deliberate 12 Hz redraw
  clock can explain them; counts alone establish neither fluidity nor a defect.
- Sound was measured numerically, not subjectively auditioned. Music/Foley are
  one authored Source; independent recorded stems are not supplied.

## Provenance and scope

provenance.json pins the current film, its render inputs and review. It separately
identifies original production inputs and the causal repair evidence, preserving
source and licence traceability without bundling an obsolete movie. The complete
original production remains with its owner. The font is unchanged; the current
source uses the sample-count sound argument and native-resolution drawing.

Build the copied author Project to create fresh execution records. This evidence
folder is not a second timeline, asset authority or automatic aesthetic gate.
