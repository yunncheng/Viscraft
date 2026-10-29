# Sound and picture roles

**Read this when** you are deciding what each sound is for (keep / process /
replace per role). **It does not own** the audio execution contract.

How to decide what each sound is *for*, so picture and sound agree instead of
duplicating each other. This page owns the *craft* of sound roles; the audio
execution contract (clips, buses, ducking, J/L cuts, mastering) lives in
[Timeline](../runtime/timeline.md).

## Goal

Coordinate sound by role — music, dialogue, ambience, foley/SFX, and anything else
you name — and decide, per element, what its material should be. Planning the roles
early tells you what each sound is *for* and what, if anything, must stay
continuous, but the actual keep / process / replace decision for a Take's own audio
is made by looking at the material that arrived — its content, the work's goal and
what you can observe — not fixed before you see it. The failure this prevents is
not a level problem: it is two soundtracks expressing the same thing (two pieces of
music at once, native dialogue under a re-recorded voice, the same action sounded
twice). Loudness normalization cannot fix repetition.

## Conditions

- You know which Takes arrive with their own audio track (a `hasAudio` fact, not a
  content judgement).
- The work's sound roles are named, and you know what, if anything, must stay
  continuous (a unified score across the cut, dialogue intelligibility, effect
  uniqueness). A deliberate section change or diegetic music is equally legal.
- You can listen, or you will mark the semantic judgement unverified.

## Implementation entry

- **Kept Take audio** — `audio: 'keep'` on a placement; this is an **enforced
  assertion** that the Take really carries an audio stream. A kept placement over
  a silent Take is a loud Build error; intended silence is an explicit `mute`. A
  code-picture Source that captures no audio stream has nothing to keep and stays a
  `mute` — that is correct, not a defect to force a `keep` onto.
- **Added material** — authored `source`/`asset` clips on the shared sample clock,
  independent of any shot.
- **Roles as routing** — there is no schema `role` field. Roles live on the
  free-form `bus` label you declare, and `composition.ducking` rules
  (`{ target, control }`) make one bus yield to another.
- **J/L cuts** — deciding that a kept Take's own sound should lead or trail its
  picture is a craft choice; the fields and their semantics are in
  [Shaping a kept Take's own audio](../runtime/audio.md#shaping-a-kept-takes-own-audio--the-true-j-cut-and-l-cut).
  `audioOffsetSamples` is **not** a J-cut: it shifts the whole kept clip and breaks
  in-clip sync.

## Reusing music and sound

When the desired music or sound already exists as an independent Asset or sound
Source/Take, reuse that input or promote its required interval rather than
extracting it from an entire finished movie. Extracting the programme can include
unwanted dialogue/effects, introduce another lossy encode, and make the new
Project's portable closure depend on the old movie and its production inputs.
Use the actual parent: never label extracted programme audio as an independent
original just to shrink the export. If only a finished movie exists, extraction
is valid and its true parent provenance must remain
([§5. Prepare audio from an existing recording](../runtime/media-preparation.md#5-prepare-audio-from-an-existing-recording)).
Existing referenced parents are not disposable caches; delivery purpose and
authoring choices control scope, not deleting evidence after the fact.

## Structured sound

Reach for this when the work needs sound that carries **structure** — sections, a
build, accents, a peak, an accepted rest — rather than one static cue. The
decision this page owns is whether that is the actual problem: if a single
sustained bed, a supplied track or the kept Take already carries the scene,
another arrangement layer would duplicate a role.

State the musical language and density concretely before choosing a source:
meter and theme, instrumentation or timbre family, how many voices enter, where
the texture thins or rests, and which event each entry answers. "Cinematic",
"emotional" or "structured" alone is not a plan. Recorded material, a supplied
track, procedural synthesis and a hybrid are equally available choices; none is
the default, and synthesis is not automatically less natural or less valid.

A score can stand on its own. A visual study does not need music, and a sound-only
cue does not need a picture to justify its musical idea. When sound and picture
are authored together, cite the actual observed event and measured attack; a
shared label, a declared offset or a green signal test does not prove that the
two media land together, and a cue with no picture proves only its declared
internal timing. Human listening remains the acceptance step for timbre,
naturalness and musical effect; when you cannot listen, mark those unverified
instead of inferring them from a report ([Evidence scope](#evidence-scope)).

## Arrange identity, entry, exit and rest

When a cue must carry a section rather than a single hit, decide these before
choosing timbre:

- **Keep one identity through change.** Name the motif, rhythm or interval that
  makes the cue recognizable. Transposition, augmentation/diminution,
  re-orchestration and tempo changes should still leave that identity audible;
  if every dimension changes at once, it is a different cue, not a variation.
- **An entry is an event.** A new voice should add a role, not double one already
  playing. Decide what triggers the entry and what the listener should notice
  about it.
- **A withdrawal is also an event.** Choose whether voices leave one at a time,
  stop together, or hand over to foley or ambience. Ending a layer is part of the
  arrangement, not a fade applied afterward.
- **A rest is authored, not missing audio.** Decide whether the rest silences
  music only (foley/ambience continue) or everything. Gate room and reverb tails
  before the rest if it is meant to be truly silent; a residual tail is a
  different choice.
- **End the cue deliberately.** Use a written cadence, a tail that rings past the
  picture, or a hard cut. Protect the intended tail from programme-length
  truncation, and do not let a cut chop a sustained resonance unless that is the
  effect.
- **Let material motion shape micro-timing and space.** For foley, derive repeat
  rate, level and pan from the same movement and contact facts as the picture,
  rather than from a generic LFO or a fixed stereo position.

Independent musical references under `assets/studies/audio/` show different
answers to these choices; the [reference map](../creative-references.md)
lists them with what each one demonstrates, and each study's own form and editing
sections carry its section map and parameters. Do not copy a study's tempo, key or
instrument list into an unrelated work as a required recipe. A reference whose
primary value is the picture/sound relationship stays whole under
`assets/studies/code-visuals/` (for example, the risograph ride and the crayon
page): use their shared authored facts when adapting that relationship, because
splitting the sound out of such a reference can lose what makes it useful.

## Directing choices

- **Priorities outrank provenance.** Where they apply — score continuity across a
  cut, dialogue intelligibility, sound-effect **uniqueness**, sync — they take
  precedence over the *category* a sound came from. The test is never "native or
  added?" but "does this sound do its job once, clearly, in sync, without
  duplicating another role?" Two sources expressing the same thing are the defect,
  whatever their origin
  ([Coordinate sound by role](../runtime/audio.md#coordinate-sound-by-role-not-by-a-single-authority)).
- **There is no default recipe — decide by content, goal and observation.** Read
  the material that actually arrived, then choose per element. Legitimate outcomes,
  all equal until the material shows otherwise:
  - the native track is good enough → **use it directly**;
  - useful native multi-voice audio (a performance, dialogue, an ambience) **plus
    your own BGM** on an independent clip;
  - **process the whole native track** — cut it, level-match it, fade it, route it,
    or process it with your own tools and re-import a new Asset — and mix it with
    added material;
  - **replace unsuitable material** (wrong content, a duplicate role, unusable
    sound).
  Nothing here mandates a mixture, and there is no reverse rule that the original
  must be kept.
- **Let sound follow the picture edit by role.** Performance-synced sound
  (dialogue, footsteps) travels with its Take and is trimmed with it; cross-shot
  music and narration live on an **independent timeline**, not glued to one shot.
  Replacing one visual candidate must never silently replace the sound already
  accepted for the whole work. The J/L-cut fields for a kept Take are in
  [Kept Take audio and J/L cuts](../runtime/audio.md#shaping-a-kept-takes-own-audio--the-true-j-cut-and-l-cut).
- **A mixed track is still workable — no separation is not no recourse.** Being
  unable to *separate* internal voices is not the same as being unable to process
  the whole track or add tracks: it can be cut, level-matched, faded, routed and
  layered as a whole, and only *independent* control of the baked layers needs
  different *material* (a separated stem or a dialogue-only take), not the schema.
  What a `bus` label does and does not let you control is in
  [Coordinate sound by role](../runtime/audio.md#coordinate-sound-by-role-not-by-a-single-authority).
- **A specified song is a length authority.** Decide whether the whole song or an
  authorized excerpt sets the length, and protect it: a picture edit that shortens
  the programme can silently cut a song's tail
  ([Specified song length](../runtime/audio.md#a-specified-song-is-a-length-authority)).
- **A visual candidate is not a sound candidate.** A new candidate Take changes
  sound only if you explicitly point a `keep` placement at its audio.

## Choose material and rhythm by role

Reach for this when the work needs sound that carries the action, mood or
comprehension rather than a track that merely exists. Give each element an expressive
role first — a footstep that lands the contact, an ambience that holds a place, a score
that lifts a section, a silence that lets a beat land — then choose its timbre. The
failure this prevents is an expressively empty soundtrack: the trigger fired on time,
but the material does not sound like the thing, the rhythm fights the reading, or one
flat sound is asked to carry a whole moment.

Choose timbre against five things at once:

- **Material** — what the real thing is made of, so the timbre reads as that thing and
  not a generic beep.
- **Action** — what the sound is attached to, so its envelope and transient match the
  event's shape.
- **Intensity** — how hard, loud or close the event is, so no two events carry the same
  weight by default.
- **Space** — where it happens and how it is heard (near, far, dry, reverberant), so a
  tail does not contradict the picture's distance.
- **Section** — where it sits in the work's arc (build, peak, rest), so the arrangement
  has dynamics instead of a constant density.

**Share the real events and align to the actual transients.** When picture and sound are
authored together, both read the same objective event times. Align a sound's attack to
the transient measured from the real media — not from the file header or the nominal
prompt — so a footstep lands on the contact frame and a hit lands on the impact; a
trigger that fires at the right frame but plays the wrong envelope is still wrong.
**Use beats and rhythm only when they earn emphasis**: a declared grid
([Timeline](../runtime/timeline.md), §3f) helps cut to a musical accent,
but never compress the time a viewer needs to read text or follow a performance, and
never pass one on-time cue off as real material. A stylised electronic timbre and an
intentional silence remain legitimate expressive choices, not gaps to be filled.

## Failure repair

| Observed | Investigate | First repair |
| --- | --- | --- |
| Two musics / a doubled action sound | Roles overlap; two sources express the same thing | Keep one role per thing: mute or drop the duplicate, or move the material to one bus |
| Dialogue hard to hear under music | No ducking, or the music yields by content assumption | Declare `bus` roles and a `ducking` rule so music yields to dialogue |
| A kept placement fails to build | The Take declares no audio stream | Use explicit `mute`, or point at a Take that carries audio |
| A gesture's sound arrives after the picture | A whole-clip shift used where a J/L cut was meant | Use `audioLeadSamples`/`audioTailSamples`, not `audioOffsetSamples` |
| A song's ending is missing | A picture-length change truncated the clip at the programme end | Set `outputFrames` to protect the tail, then re-check the truncation fact |
| A sound's material does not match the event | The trigger was accepted as if it were the sound | Choose material that reads as the event (timbre by material/action/intensity/space); an accurate trigger is not a good sound |
| A hit or footstep drifts off the picture | Aligned to the file header or a nominal offset, not the real transient | Measure the actual attack in the media and align to it, not to metadata |
| Masking, a dead tail or the wrong space across events | One flat block instead of per-event windows | Work per real event window — check what overlaps, whether a tail should ring into the next event and whether the space matches — and compare the actual before and after; a whole-clip `loudnorm` cannot fix content, repetition or a missing transient |

## Evidence scope

`review` reports per-Take `hasAudio` (probed from the file, never the possibly
stale record) and per-clip/kept-placement facts including `truncatedByProgrammeEnd`
and declared-versus-measured lead/tail. These are **facts**: detecting a stream is
not accepting its sound, and a loudness number is not a musical judgement. Never
infer what a track actually *contains* from its peak level, its `hasAudio` flag, or
a prompt that said "no dialogue/no music" — none of those is listening; the returned
content is a separate question you must answer by playback. When you cannot listen,
mark dialogue intelligibility, effect uniqueness and sync **unverified**
([Media analysis](../runtime/media-analysis.md),
[Review and repair](review-repair.md)).
