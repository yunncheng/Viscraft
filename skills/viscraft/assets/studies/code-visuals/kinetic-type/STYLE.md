# Kinetic type — reading rhythm

A Swiss-grid poster that is **read**, not merely animated. The grid establishes
measure; the title is the actor; the page holds still long enough for the
sentence to land before one word is weighted and the layout changes.

## Surface and hierarchy

- 12 columns × 8 rows, 40 px margins on a 960×540 design canvas.
- Paper `#EAE9E5`, ink `#111111`, muted `#77766F`, grid `#CFCEC9`, one signal
  red `#E30613`.
- Kicker 15 px tracked caps; title 74 px (poster) or 78 px (ledger) with a
  44 px readable floor; subtitle 25 px regular; number 148 px display; index
  label 13 px tracked.
- The grid is a measure, not a texture: it is faint, it builds, and it stays
  behind the type. The red registration cell is deterministic from the Source
  seed.

## Reading rules

- A title is wrapped with the delivered font. CJK characters and wide
  punctuation are break opportunities; Latin words stay together while they
  fit the column. A single Latin word wider than the column is broken by
  character, so word integrity is not absolute. Closing punctuation does not
  start a line.
- Long titles shrink in 4 px steps only down to `titleMinSize`, then fail loudly
  if they still exceed `titleMaxLines` or the vertical budget. They never shrink
  without a floor.
- The subtitle may use two lines at a 19 px floor; a one-character CJK head is
  moved up when the previous line can hold it, so a line does not start with an
  orphan before a Latin run.
- One emphasis word. It must stay inside one wrapped line; if the break splits
  it, the scene throws instead of silently emphasising nothing. Red is a
  semantic weight, not decoration.
- Numbers count to their target; non-numeric values are shown statically.

## Beats (normalised source time)

| Beat | Window | What changes |
|---|---|---|
| grid | 0–0.12 | columns and rows draw in from the margins |
| reveal | 0.12–0.44 | kicker, title lines and subtitle rise through clipped masks; the number counts to its target |
| hold | 0.44–0.56 | the complete page is still; no layout or emphasis motion |
| emphasis | 0.56–0.72 | one word turns red and gains an underline |
| transition | 0.72–0.90 | the old page clears to paper while a left-to-right wipe reveals the index |
| settle | 0.90–1.0 | the index is still; the final frame reads as a poster |

The transition uses a paper wash plus a full-height red edge. The wash prevents
a sliced old line from leaving a stray glyph fragment at the cut; the grid is
redrawn across both sides so the outgoing side is not a blank rectangle.

## Adapt

Keep the grid, the line-mask rhythm, the still hold and the one-word emphasis.
Change the title, subtitle, number, emphasis word, palette constants, type
scale and the two opening variants (`poster` left-aligned, `ledger` centred).
Do not import the upstream 44-second story, score, voices, poster wall, rotating
camera or 120 BPM timeline; this reference is a local reading segment.

The only font is the bundled complete Noto Sans SC WOFF2 under OFL. A code point
outside its cmap is not promised. The implementation is an independent canvas-2D
reimplementation of mechanisms studied in LemoLab's MIT `film.js`/`ease.js` and
a method study of huashu-art-motion's `y5_kinetic_type.js`; no upstream source
line or media asset is copied. See [README.md](README.md) and
[LICENSES.md](LICENSES.md).
