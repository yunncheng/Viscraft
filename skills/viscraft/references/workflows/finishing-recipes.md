# Finishing & edit recipes — where each ask is answered

Finishing and edit asks — transitions, fades, beats, exact length, subtitles,
kept audio, stems, candidates, stills, held frames, one authored event — each has
one authority page that states the real fields, the mechanism and its limits. This
page is the index: find the ask, go to that section. It imposes **no artistic
quota** (no required number of transitions, stills, stems or passes), and no
entry below approves a result by itself: check the actual effect in the work
before you accept it.

Field definitions live in [Timeline](../runtime/timeline.md) and
[Runtime authoring](../runtime/runtime-authoring.md).

| Ask | Authority | What stays your judgement |
| --- | --- | --- |
| Blend two adjacent shots (dissolve, wipe, slide, circle) | [Between-shot transitions and match cuts](../runtime/timeline.md#between-shot-transitions-and-match-cuts) | Every kind but `occlude` is a bounded `xfade` approximation; a wipe over shots with no shared motion reads as a graphics glitch. Put genuine motion blur or occlusion in the scene, or author an `occlude` with a real covering element ([Editing awareness](../craft/editing-awareness.md#implementation-entry)) |
| Fade the whole programme in / out | [Whole-programme fade in / out](../runtime/timeline.md#whole-programme-fade-in--out) | It changes head/tail level only; a fade ending inside a black `outputFrames` tail steps to hard black — structural, not a defect |
| Declare a beat grid and read the on/off-beat facts | [Beat grid and explicit programme length](../runtime/timeline.md#beat-grid-and-explicit-programme-length) | The distances are facts, not a verdict; an intentional off-beat cut is valid |
| State an exact programme length with a black tail | [Beat grid and explicit programme length](../runtime/timeline.md#beat-grid-and-explicit-programme-length) | The pad is opaque black plus silence, not a fade; shorten placements if you want less content |
| Burn in **and** export subtitles | [Subtitle sidecar (SRT)](../runtime/timeline.md#subtitle-sidecar-srt) | The sidecar is text only; styling and position do not round-trip, and a blank line splits a cue |
| Keep a Take's own audio with a J-cut or L-cut | [Shaping a kept Take's own audio](../runtime/audio.md#shaping-a-kept-takes-own-audio--the-true-j-cut-and-l-cut) | The fields shape a real audio stream; whether to keep that track at all is a content decision made after reviewing it ([Sound design](../craft/sound-design.md)) |
| Hand off grouped audio stems | [Grouped audio stems](../runtime/audio.md#grouped-audio-stems-hand-off-exports) | The programme mix is always the FULL mix; stems are additional exports that overlap it rather than partition it |
| Mix, route by role, or duck one bus under another | [Coordinate sound by role](../runtime/audio.md#coordinate-sound-by-role-not-by-a-single-authority), [Automatic sidechain ducking](../runtime/audio.md#automatic-sidechain-ducking) | A `bus` is a routing label, not content recognition; ducking a mixed bus also moves the dialogue inside it |
| Take audio out of an existing recording, or keep it | [§5. Prepare audio from an existing recording](../runtime/media-preparation.md#5-prepare-audio-from-an-existing-recording) | A kept Take usually needs no extraction; re-mixing processed audio is an explicit choice, not an automatic step |
| Compare candidate Takes before choosing | [Compare candidate Takes before choosing](../craft/review-repair.md#compare-candidate-takes-before-choosing) | Candidate strips are stills; watch and listen to the interval before selecting |
| Promote storyboard frames from a Take | [§1. Approve a real Take frame as a reusable image Asset](../runtime/media-preparation.md#1-approve-a-real-take-frame-as-a-reusable-image-asset) | Promotion copies pixels; it creates no new art and recovers no original layers |
| Check for held or duplicate frames | [How to judge each craft area](../runtime/timeline.md#how-to-judge-each-craft-area) | A held frame can be a deliberate pause |
| Tie picture, sound and subtitle to one authored event | [Tie picture, sound and subtitle to one authored event](../runtime/timeline.md#tie-picture-sound-and-subtitle-to-one-authored-event) | Technical sync does not prove the mix sounds good or the event reads musically |
| Master loudness and true peak for delivery | [Optional measured audio mastering](../runtime/audio.md#optional-measured-audio-mastering) | There is no universal target; the delivered AAC true peak can differ from the pre-mux PCM gate |
| Check a parameterised recipe beyond its showcase | [Check the recipe beyond its showcase](../craft/review-repair.md#check-the-recipe-beyond-its-showcase) | Whether the variations matter depends on how the recipe will be reused |
