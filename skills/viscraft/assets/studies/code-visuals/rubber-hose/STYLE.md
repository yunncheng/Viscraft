# Rubber-hose style — object actors that perform

Hand-inked black-and-white animation from the early sound era, rebuilt as a
code Look: rubber-hose limbs, pie eyes, white gloves, big shoes, flat fills, one
hard shadow band, a screen-constant ink line, three boil drawings at 12 fps, and
a 4:3 film gate. The object is the body — a mug is a mug, a cube is a cube; no
human torso, no straw, no shorts.

This is a mechanism reference, not a licence to copy a character, a film, a
title or a score. The two beats here are original staging.

## What makes it read

1. **Limbs are tubes, not arms.** An equal-width noodle from shoulder to glove,
   one smooth bend, no elbow or knee. A long reach is the style's native gag;
   the arm's length is free, its width is not.
2. **The face is the performance.** White pie eyes with a large black pupil and
   a wedge cut toward the upper right; brows are short thick arcs; mouths are a
   small vocabulary — smile with cheek ticks, open grin, "O", wavy, pucker,
   tongue-out. A blink is an eyelid fill plus a lid line, not a scaled eye.
3. **Gloves and shoes carry weight.** Four-finger gloves with a flared cuff and
   three stitch lines; big black shoes with one toe glint. Outline the union of
   the parts once, never each finger.
4. **One hard shadow band.** Clip to the body, fill a single light-grey band on
   the side away from the upper-left light, then outline. A gradient kills it.
5. **Ink is constant on screen.** Transform the points to the output, then
   stroke; never stroke the local shape and scale the stroke. At 960x540 the
   reference line is 3 px (`inkWeight` 6 in the 1920x1080 design space).
6. **Boil on twos, camera on ones.** Three drawings cycle at 12 Hz sampled from
   real seconds (two frames at 24 fps); the pose is held for that drawing. The
   camera push, gate weave, flicker, scratches and dust update every output
   frame. If the whole frame is quantised to twos, the print looks like a
   stutter instead of a drawing.
7. **Props breathe.** Squash and stretch on `cos(2π·beats)`, all props in the
   same phase. An impact gets a squash with an exponential spring-back; a
   landing should press the plate and wobble it.
8. **The film is an object.** A 4:3 rounded gate inside the 16:9 stage, black
   pillarbox, gate weave, ±4 % flicker, 0–3 drifting vertical scratches, dust,
   an occasional hair, a strong vignette. Damage is seasoning; the performance
   must read without it (`damage: 0`).

## The two beats

**spoon-stir** — the hand-off is the point. The sugar cube lifts the spoon from
the counter, presents it, and the mug reaches until both gloves are on the
handle. The cube holds 22 px further along the handle so the exchange reads as
two hands, not one. The mug then stirs inside its own coffee (two circles), lifts
the spoon, tastes at the mouth, and the reaction travels: shut eyes → wide eyes
→ happy arcs, body stretch, blush, and the steam becomes a heart. The final hold
keeps both actors alive with breathing and two blinks; no freeze.

**stair-clock** — the climb is the point. Six plates form a staircase; each hop
has anticipation, a stretch, an arc, a landing squash and a plate press. The
cube does not glide: the feet track the parabola and the plate under the landing
moves. On the top plate the cube looks up; the clock wakes with a jolt, rings,
and the cube covers its head, then grins. The clock's response is a pose change
plus a shake, not a label.

## Framing and camera

The camera is a theatre camera: locked stage, a slow push on ones, a small pan
up for the climb, and the destination prop already in frame. Medium framing —
characters are roughly a quarter to a third of the frame height so the faces
read. Arcs and leaps stay inside the gate. No far-wide gag, no dissolve.

## Variation space

Change the props, the space and the action, not just the seed or the palette.
Useful structures: a hand-off between two object actors; a small character
crossing a rhythmically sounding set; a task with a tool (stirring, winding,
tying, serving); a reaction chain where one prop answers another. Keep one
hero, one want, one turn, and let the object's secondary feature (steam, a
spring, a flame, a pendulum) carry the mood.

This study's approach is a 12 Hz character pose clock (twos at 24 fps), the
camera and gate on the capture clock, and a beat grid whose beat is an even
number of 24 fps frames (10 or 12 here). The mechanism itself needs only a
screen-space outline and an independent character clock. Re-time the keyframes
in the design-frame numbers the code already uses rather than adding a second
timeline.

## Deliberately not included

No 1950s flat cartoon, no colour, no renderer shading, no limited-animation
held poses as a budget excuse, no "retro filter" over modern animation. No
existing character silhouette, no title cards, no announcer voice, no big-band
score, no foley samples, no fonts. The reference is silent, textless and
greyscale on purpose.
