# Xieyi ink wash on rice paper

A starting point, not a fixed style. Paint with ink, not with a brush-textured
vector: forms are made by loaded strokes whose dark side is the contour, by wet
washes that bleed into the paper, and by dry, fast strokes where the paper shows
through the bristles. Most of the frame is empty paper — it is the water, the
sky and the silence.

## Material rules that matter

- **Five tones.** Burnt (.96) for calligraphy-like accents, belt, brim and moss;
  thick (.82) for contours and the dark side of loaded strokes; heavy (.60) for
  folds and secondary lines; light (.34) for washes; clear (.16) for distant
  forms and faces. Do not add hue to the ink: low density is cool grey, high
  density is warm black.
- **One vermilion.** The sash end and the end chop. Not a red wash and not red
  type; the colour layer should otherwise be empty.
- **Wet vs dry.** Wet strokes are blurred and their edge darkens in the
  compositor; dry strokes only get paper tooth and bristle breaks. Loaded
  strokes put their bristles in the wet layer (`brWet`) so the dark side stays
  soft; fast accents use a dry stroke with `dry` 0.5–0.8 for flying white.
- **Masses, not fills.** A hat, bank or wave body is a jittered polygon or a
  huge loaded stroke with an alpha gradient. A closed flat fill kills the
  material.
- **Paper is a shader, not an image.** Keep it anchored to the world: on a
  camera move the paper must slide under the painting, not stick to the screen.
  Its grain should fade when zoomed out or it shimmers.

## Figure

The 100-unit rig is a set of joint positions in a side or front view. Build the
robe as one pale mass plus two loaded strokes, the hat as a wet cone plus a
burnt brim line, and the legs/belt as burnt-ink lines. The face is optional: a
few strokes under the hat is enough. For a leap, pitch the body forward, tuck
one knee, trail the other leg, and let the robe flare into a large pale mass
with a dark back edge. For a salute, bring both hands to the chest and make one
small dark fist the centre of the sleeve V; lower the head, do not bend the
spine into a bow.

## Motion and camera

- Draw the figure on twos (12 fps) but move the camera, bloom, rings and swell
  on the frame clock. Never quantise the whole picture.
- Keep strokes stable: seed each stroke by its index and compute bristle breaks
  along normalised arc length × a fixed reference length. Boil only the width,
  on a five-drawing cycle.
- Paint things into existence (the opening bloom) and let consequences start
  after the action: the rings and swell belong to the touch/landing, not to the
  frame before it.
- Camera grammar is a vocabulary: lateral tracking with lead room, a slow push,
  a hard cut to a closer frontal frame. Water stays blank; a low swell and open
  rings are enough to make a landing read.

## This study's choices

The river scene uses a tracking camera, a high wide figure (about 29 % of frame
height), two touches and one long leap. The pine scene uses a walk, a planted
staff and a closer frontal salute after a hard cut. Both use the same 7 s
length; the action is normalised to the source so a shorter test shortens the
beats. No text, glyph, inscription, sword or audio is present.

## Not this

Not watercolour: no coloured washes. Not vector art with a brush texture: no
flat fills or closed outlines. Not a calligraphy title sequence: the excluded 水
glyph is not needed, and no font is downloaded. If the frame gets busy, remove
ink rather than add tone.
