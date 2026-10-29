# Continue Beyond the Frame

The Project manifest owns Direction, bindings, placements, layer positions and
mix. Code owns the drawn acting and paper reveal. The two imported video Assets
are the actual selected H3 footage, with native sound still in the files.

The harbour's parapet, coloured village/tower, sails, ridge and ground/waterline
are continuity anchors, together with the rider, bicycle, motion and lighting.
Compare `assets/comic-world-anchor.png` and `assets/photo-world-anchor.png` before
changing the transformation. The photographic anchor came from editing the
actual drawn scene, not independently inventing another beach.

Global frame 182 starts the tear. Through frame 215 the code displays ride
frames 0–33 behind the paper; the following placement continues at ride frame 34.
Do not restart that clip at frame 0. `comic.mjs` currently fixes the entry mapping
to this 24 fps / 34-frame passage. Changes to timing or replacement footage need
matching code, bindings, selected frame Assets, edit ranges and sound events.

The second generated clip starts at global frame 391. It uses a closer shot
rather than a pixel-identical continuation. Its first-frame input was the actual
ride exit plus the original photographic anchor; prompts and original reviews
are retained as evidence, not guarantees that every requested motion occurred.

Music/Foley are one procedural source on a 48 kHz sample clock. The final mutes
both generated clips and fades the programme at its ends. Assess native audio
before choosing a different mix; a measured signal does not prove natural timbre.

Read `production/README.md` for reference roles, `production/video-requests.json`
for the original requests, and `production/provenance.json` for source identities.
The companion case's `review/` directory holds actual sampled frames and observations.
Builds of this curated Project produce new execution state without submitting
provider tasks. Keep the accepted companion movie as a reference when editing.
