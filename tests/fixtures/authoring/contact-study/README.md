# Picture/sound event fixture

[Fixture overview](../../README.md) · [Consuming test](../../../case-contact-study.e2e.ts)

## Coverage

Exercises a shared authored event clock through browser capture, sample-based
sound rendering, mixing, mastering and muxing. The tests decode frames and PCM,
compare the browser sound Take with a Node render, move the event, then verify
that a picture-only edit reuses unchanged sound operations.

The scene is a striker contacting a bar. At the default 24 fps / 48 kHz,
`contactFrame: 12` maps to sample 24000. The sampler's transient pre-roll means
measured onset is slightly later; the test owns the allowed tolerance.
The consuming test defines onset tolerances and the expected operation reuse.

## Files and dependencies

| File | Test role |
| --- | --- |
| [contact-timeline.mjs](contact-timeline.mjs) | Shared contact frame, approach/rebound lengths and event mapping |
| [contact-scene.mjs](contact-scene.mjs) | Picture and camera driven by that event |
| [contact-sound.mjs](contact-sound.mjs) | Sampled attack driven by that event |
| [contact-packs.mjs](contact-packs.mjs) | Recording pack mapping |
| [contact-scene.html](contact-scene.html), [contact-sound.html](contact-sound.html) | Picture/sound browser entries |
| [create.mjs](create.mjs) | Declares files, sampled audio Assets, two Sources and handoffs |

The recipe imports the shared paint-material module, the
[motion-camera fixture](../motion-camera/README.md) and the
[sound kit](../../audio/sound-arrange/README.md). It copies two cello pizzicato
recordings and marimba C6. The marimba uses its recorded root (`rootMidi: 84`);
the cello voice is transposed. Keep their identities and sample hashes intact.

## Maintenance

- Both Sources declare `contact-timeline.mjs` in `resources`. Read the event from
  that file rather than duplicating its frame in picture and sound code.
- Moving the event must invalidate picture and sound together; the test uses
  `refresh-code` to register changed code Asset bytes before rebuilding.
- A camera/palette-only parameter edit should invalidate only picture and reuse
  the sound Take, mix and master.
- `timelineFor` rejects invalid timing. Keep
  `approachFrames + 1 <= contactFrame` and
  `contactFrame + liftFrames <= frames - 1`.
- Preserve the pre-contact rest and attack/decay so onset measurements retain a
  meaningful reference. Keep frame/sample conversion explicit.

Options are `width`, `height`, `frames` and `seed`; defaults are 640×360 and
24 frames at 24 fps, 48 kHz stereo. Width/height must be positive even integers.
Tests select their capture size and event edits explicitly.

## Sources and licences

Paint-material and motion-camera derive from huashu-art-motion (MIT), with
Manim notices for easing helpers. Sound-arrange derives from LemoLab and
huashu-art-motion (MIT); recordings are CC0 1.0. Preserve the respective
`rights.mjs`/`provenance.mjs` declarations and full licence handoffs:
[SOUND-KIT-LICENSE source](../../audio/sound-arrange/samples/LICENSE.md),
[sound kit licences](../../audio/sound-arrange/LICENSES.md) and
[THIRD_PARTY_NOTICES.md](../../../../THIRD_PARTY_NOTICES.md).
