# Crayon picture-book page — visual intent

> One page of a picture book being drawn while you watch: wax crayon on warm
> paper, colour that spills past the outline, lines that breathe on twos, and a
> single wash that changes what the paper was hiding.

## Essence

The page is a physical object, not a canvas with a texture. The paper has a
direction and a tooth; the wax sticks only to the peaks that the hand presses
into; the watercolour is a guest that the wax pushes away. The plot is the act
of drawing and colouring: a girl draws a star, gives it colour, reaches for it,
and the night arrives as one wash that reveals a constellation already drawn in
white wax.

It is not "vector art with a crayon filter": there is no global noise overlay,
no uniform outline width, no flat fill behind the grain. It is not a whiteboard
or marker drawing, and it is not a watercolour painting with a crayon border:
the crayon is the host, the wash is one guest.

## Palette

A warm off-white page (`#f4efe3`) and a small box of wax: indigo `#2b2f5a` for
all contours (never black), yellow `#f3c33f`, orange `#e58a3a`, red `#cf4b3f`,
pink `#ec91a8`, peach `#f2c6a2`, brown `#6f4630`, ochre `#e2b05c`, green
`#4f8c62`, sky `#6f9fca`, violet `#6c5aa2`, and one paper-white `#fbf7ea`
reserved for wax resist. One watercolour: ultramarine `[0.12, 0.16, 0.44]`.
Value comes from pressure and overlap, not from extra hues.

The palette here is a choice for this page, not a rule for the reference: a
different story can use a different box, as long as it stays small and one
outline colour dominates.

## Marks

- **Line.** A ribbon with low-frequency hand wobble, width ±15 %, tapered ends,
  a denser core and 1–2 thin streaks. Characters get the heaviest contour; the
  star is slightly lighter; the background is lighter still.
- **Colour.** Back-and-forth zig-zag rows at a chosen angle, overshooting the
  outline by a few pixels, each pass at a different pressure. Large areas get a
  lighter cross-hatch. The skin and pinafore are deliberately dense: light
  pressure turns muddy where the wash crosses.
- **Shapes.** Rounded head, two low buns with orange ties, side-swept fringe,
  dot eyes with a white catchlight, mitten hands, tube limbs. The star is
  irregular and child-drawn, not a perfect icon.
- **Occlusion.** A part erases the parts behind it inside its own outline. The
  pinafore covers the leg tops; the fringe covers the top of the face; the hand
  sits over the crayon.

## Composition

A 1600×900 page, landscape — the design coordinate space, with the output
scaled proportionally. The girl stands on a low green ground line at about
one fifth of the page width; the star is drawn at her right, within arm's reach,
then lifts to the upper right. The middle and upper left stay as bare paper for
most of the action, so the wash has somewhere to become night. The
constellation is an arc above the star, not a decorative screen fill: it answers
the drawn star.

## Motion

- **Acting at 12 fps.** The crayon intro, the stroke boil, the hatching rows and
  the character marks change on twos. A held pose still moves; the movement is
  the redraw, not a tween.
- **Camera at 24 fps.** One continuous move: a slow push toward the girl and
  star while the outline and colour are made, then a pull back to the full page
  for the wash. The camera is a function of time, never of the boil step.
- **The wash is the material motion.** The front has a soft, wavy edge and a
  darker lip; it crosses the page once. The girl and star are composited after
  it, so their colour survives.
- **Reach.** The arm is a two-bone chain; the hand follows the crayon tip during
  drawing, then extends to the star's lower edge as it lifts. The shoulder
  leans a little; the head turns toward the tip.

## Native moves used

- **Drawn live:** the star outline appears under the crayon tip; the fill rows
  appear under the hand.
- **Colouring is an action:** the star only becomes an object once it is
  coloured; the reach follows the colour, not a separate cut.
- **Wax resist:** the constellation is white wax from the first frame and is
  invisible until the wash.
- **Boil:** the page breathes on twos and calms as the night settles.

## Variation space

Change the subject (a comet, a kite, a small boat), the child's clothes and hair,
the ground line, the constellation path or the camera route. Keep the material
rules and the page-action causality: a mark is made by a hand, colour changes
what the mark is, and the wash reveals something that was already drawn. Do not
replace the girl with a geometric mannequin or the star with a generic icon and
then add noise.

## Known limits

- One page, one continuous camera, one wash. No page turn, desk, cover, spread
  or typography; no text or subtitle system.
- No character rig beyond the right arm and gaze. The feet and left arm are
  fixed in this page.
- The wash is one colour and one sweep; it is not a general wet-media engine.
- The upstream story, moon, sheep, house, ladder and 250-star reveal are not
  used. The girl and star here are original.
- A 640×360 still review cannot prove the encoded motion; the 240-frame clip
  must be watched for pacing, boil and wash timing.
