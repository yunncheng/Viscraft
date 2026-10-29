# Editing awareness

**Read this when** you are planning a cut, or a join fails though each shot reads.
**It does not own** the exact fields, overlap arithmetic or fact reports.

How to plan cuts upstream so shots assemble, and how to choose a cut shape on
purpose. This page owns the *craft* of editing decisions; the exact fields,
overlap arithmetic and fact reports live in
[Timeline](../runtime/timeline.md).

## Goal

Design each cut before capturing expensive Takes: write the outgoing and incoming
composition, direction of motion and action phase, then choose hard cut, mixing
transition, match cut or audio cut deliberately. The failure this prevents is
assembling competent shots that fail together — no entry/exit handoff, an action
reset, or a transition used as a retroactive fix for a cut that was never
motivated.

## Conditions

- Shots and their intended durations are known.
- You know the real Take lengths and handles available (a placement cannot read
  past a Take's frame count).
- For an audio cut, the Take actually carries audio
  ([Sound design](sound-design.md)).

## Implementation entry

- **Hard cut** — two adjacent placements; the default when shots are independent.
- **Mixing transition** — `composition.transitions` over a genuine overlap:
  `dissolve`; the directional wipes/slides
  (`wipeleft`/`wiperight`/`wipeup`/`wipedown`, `slideleft`/…); the circular
  reveals (`circleopen`/`circleclose`); `hblur`; and the two special kinds below.
  The declared range must **exactly equal** the placements' overlap.
- **`whipleft` / `whipright`** — a fast directional slide whose overlap is
  additionally smeared by a horizontal blur. This is a motion *smear*, **not** a
  true motion-blurred camera whip-pan (no camera displacement, no shutter model).
- **`occlude`** — an occlusion transition: the two shots hard-cut at the middle of
  the overlap while an `occluder` Asset sweeps across and fully covers the frame
  at the cut, then clears. It needs an `occluder` Asset id (and only it does); a
  transparent or perforated occluder will not fully hide the cut.
- **Match cut** — `composition.matchCuts` declares an author's *assertion* that
  two placements correspond. It is metadata: it records subject/action and the two
  source frames and never changes a pixel or sample. `review` reports the
  declaration and the real boundary frames as facts only.
- **Audio cut** — a true J-cut (`audioLeadSamples`) or L-cut (`audioTailSamples`)
  on an `audio: 'keep'` placement ([Sound design](sound-design.md)).

## Directing choices

- **Plan the outgoing and incoming composition.** A match cut may need aligned
  scale/rotation; a mixing transition needs genuine overlapping placement ranges.
  A wipe over two shots with no shared motion reads as a graphics glitch, not a
  whip-pan.
- **Choose the cut shape on purpose.** A hard cut for independent shots; a
  declared mixing transition only where two placements genuinely overlap; an
  occlusion transition only when you actually have a covering element; audio cuts
  only when the Take keeps its own sound. Any other visual effect belongs inside a
  CodeScene or is a hard cut — not a nonexistent CLI effect.
- **Use real handles and Take lengths.** Do not read beyond an existing clip; a
  request past a Take's frames is reported, not silently filled.
- **Motivate camera/style changes by the next image**, not by an arbitrary filter
  applied after assembly.
- **State the length authority.** If a complete song is the soundtrack, decide up
  front whether the whole song or an authorized excerpt sets the length; a picture
  edit that shortens the programme can otherwise amputate a song's tail
  ([Sound design](sound-design.md)).
- **Keep the ending intentional.** Visual resolution, a legible final hold if
  needed, and complete audio tails. Faster pacing comes from shorter shots or
  fewer beats; do not silently accelerate media or alter pitch.

## Carry the event through a cut

When a cut changes medium, viewpoint or technique while continuing an action, the
outgoing state, incoming state and what should happen next are designed together
([Design both sides of a cross-media join](creative-method.md#design-both-sides-of-a-cross-media-join)).
Check the cut itself here: the Source/Take intervals you select are the real ones
on both sides, `inFrame`/`outFrame` are frames of the placement's referenced media
on the normalized grid rather than Composition time positions
([Project structure and editing](../runtime/runtime-authoring.md#6-project-structure-schema-and-editing)),
and a declared transition's range exactly equals the placements' real overlap
([Between-shot transitions and match cuts](../runtime/timeline.md#between-shot-transitions-and-match-cuts)).
A shared reference or two similar boundary pictures does not establish event
continuity. Inspect the real boundary neighborhood — the passage around the
outgoing `outFrame - 1` and the incoming `inFrame` — not a hero frame; a Take's own
last or zeroth frame is not the selected frame. Judge the continuity itself in
[Review and repair](review-repair.md).

For contact-dependent actions, inspect the approach, first contact, response and
aftermath. Subject/prop positions, surface boundaries, action phase, screen
direction, velocity and camera framing must support the intended relationship.
Cutting from a completed response back to pre-contact can repeat or undo the event.
Deliberate replay, ellipsis or a discontinuity can be valid when the brief calls
for it; a Look change alone does not authorize an accidental action reset.

Use usable generated material to locate the actual event before calibrating an
authored counterpart. Trim a Take to the appropriate phase; do not automatically
start every incoming Take at frame zero or play its full generated length. If no
usable interval carries the required state, repair the source or revise the shot
within the brief rather than forcing a cosmetic transition over it.

An in-scene effect needs readable setup and causality. A surface can already
exist and enter view through travel/framing; simply fading a patch into the image
can read as an overlay. A response should arise from the relevant contact, with
compatible scale, perspective and timing. Stylized effects need not simulate
physics, but their geometry and motion still need to communicate the intended
event. Purposeful magical appearance is a separate authored effect.

For a claimed occlusion cut, inspect whether the element actually covers the
visible discontinuity at the chosen moment and clears into the proper next state.
Small particles or a circular crossfade do not by themselves establish occlusion.
If the intended cut is a dissolve, direct and review it as a dissolve.

Review the whole approach-to-aftermath passage as well as consecutive boundary
frames. A static incoming frame overlaid before the cut may make the last two
frames match while stopping motion, doubling silhouettes or resetting the event.
Reselect the interval or re-author the responsible side instead of treating that
boundary match as approval.

## Failure repair

| Observed | Investigate | First repair |
| --- | --- | --- |
| Individually good shots fail together | Entry/exit composition, action phase, duration, sound, transition motivation | Recut or adjust the composition using real handles before regenerating |
| Unintended action reset or gap at a cut | A repeated Take restart, or a World/placement frame mismatch | Correct it in the edit; Reselect the interval or retime rather than recapturing unnecessarily |
| Transition reads as a glitch | No shared motion, or a bounded `xfade` standing in for real occlusion/motion blur | Use a hard cut, a motivated in-scene effect, or an authored `occlude` with a real occluder |
| A match cut looks mismatched | The declaration is only metadata; the frames do not actually correspond | Compare the real boundary frames; re-author one side of the cut |

## Evidence scope

Cut-seam stills, per-boundary distance-to-beat and real boundary frames are
**facts, not verdicts** — an off-beat cut and a held frame can both be deliberate.
A declared match cut is an assertion, not a measured similarity. Judging rhythm,
motivation and continuity is yours, against the delivery promise
([Review and repair](review-repair.md)).
