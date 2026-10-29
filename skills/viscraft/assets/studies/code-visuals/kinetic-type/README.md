# Kinetic type — reading rhythm

A short, self-contained kinetic-typography reference for a browser `picture`
Source. It is a typographic mechanism, not the upstream 44-second film: there is
no story, score, voice, poster wall, rotating camera or fixed BPM rule. Read it
when a work needs a title to be **read**, then emphasised, then moved into a
compact index without losing its hierarchy.

## What the segment does

| Phase | What is visible | What it is for |
|---|---|---|
| grid | a 12-column / 8-row grid draws in from the margins | establish measure and alignment before any word |
| reveal | kicker, mixed Chinese/Latin title lines and subtitle rise through clipped masks; the number counts to its target | give the eye one line at a time |
| hold | the page is still | actual reading dwell, not constant motion |
| emphasis | one word turns red and gains an underline | show what the sentence is about |
| transition | a mask wipe reveals the same content in a compact index layout | change visual weight without a story cut |
| settle | the index holds | a final frame that can be understood as a still |

The composition has one placement spanning the whole Source; there is no audio.

## Usage

From the Skill/Project tooling:

```sh
<viscraft> author <skill-dir>/assets/studies/code-visuals/kinetic-type/create.mjs ./my-kinetic-type --options <options.json>
```

The recipe reads this directory through `import.meta.url`; it never searches the
Skill tree or a host media folder. `authorProject` performs validation, copying,
hashing and the final `project.json` commit. Build and image output are separate
Runtime commands.

Options (all optional; unknown keys are rejected):

| Option | Default | Meaning |
|---|---|---|
| `width`, `height` | `1920`, `1080` | even output pixels, minimum `480×270`; the design coordinate system is 960×540 and scales as one unit, so the default 44 px title floor is 22 output pixels at the minimum size |
| `frames` | `192` | authored length at 24 fps (8 s); minimum 96. Shorter values compress every phase and reduce reading dwell |
| `title` | `\u6570\u636e\u4e4b\u540e\uff0c\u57ce\u5e02\u9192\u6765` | Chinese/Latin title; the default means "after the data, the city wakes" |
| `subtitle` | `\u9605\u8bfb\u8282\u594f / A study in reading rhythm` | mixed Chinese/Latin supporting line |
| `number` | `24` | digits count up; a non-numeric value is shown statically |
| `emphasis` | `\u57ce\u5e02` | must occur in `title`; this substring turns red and is underlined (empty disables) |
| `variant` | `poster` | `poster` = left-aligned opening; `ledger` = centred opening; both settle into the same index |
| `titleMinSize` | `44` | readable floor in design pixels; the title is rewrapped before shrinking below this |
| `titleMaxLines` | `4` | line budget at the floor; an extreme title is refused instead of shrunk forever |
| `seed` | `4177` | selects the deterministic registration-mark cell; no randomness |

`emphasis` is validated against the chosen `title`; replacing the title means
replacing or clearing the emphasis. If a new title does not contain the old
emphasis, authoring fails with a named error rather than silently dropping it.

`480×270` and 96 frames are this **reference recipe's** readability and length
choices, not Runtime or product limits. The module scales a 960×540 design;
editing the recipe/module can change the design, but the stated 44 px floor and
line budget are what this reference actually guarantees.

## Contract and resources

- `kinetic-type-scene.html` sets `window.viscraft = { ready, render(ctx) }`.
  `render` is called once per frame with
  `{ frame, time, fps, width, height, seed, params, bindings }`; the canvas is
  resized to `ctx.width × ctx.height`, and the 960×540 design is uniformly
  scaled and letterboxed in paper.
- `kinetic-type.mjs` and `fonts/NotoSansSC-VF.woff2` are declared in the
  Source's `resources`, so they are copied and hashed with the Project. A
  missing declared resource fails the capture; Build/image additionally verify
  the frozen Asset hashes against the authored files.
- `ready()` loads the font with `FontFace`, adds it to `document.fonts`, and
  fails before the first frame if the face cannot be loaded.
- The module is silent 2-D canvas: no network, provider request, three.js,
  wall clock, `requestAnimationFrame` or `Math.random`.
- Every frame is computed from `ctx.frame` and `params.frames`; the seed only
  selects the registration cell. There is no accumulated render state.

## Long titles and mixed text

The title is measured with the delivered font and wrapped at a fixed column
width. CJK characters and wide punctuation are break opportunities; Latin words
stay together while they fit the column. A single Latin word wider than the
whole column is broken by character so the layout can proceed; the readable
floor still applies, so this is not an absolute "a word is never split"
promise. Closing punctuation is kept off a line start. When the title would
exceed `titleMaxLines`, the size is reduced in steps only down to
`titleMinSize`. If it still does not fit, the scene throws a loud error naming
the line count and floor — it never hides the problem by shrinking the type
arbitrarily.

Replace the default title with a longer Chinese/Latin line and a matching
emphasis to see the reflow. At 960×540 a four-line title at the 44 px floor is
the honest maximum; at 1920×1080 the same design units double.

A long-content variant at 960×540:

```json
{
  "title": "数据之后，城市在清晨第一班列车里醒来，而海面仍在缓慢呼吸",
  "subtitle": "一个关于阅读节奏、城市速度与潮汐的排版练习 / Reading rhythm, urban speed and tide",
  "number": "07",
  "emphasis": "列车",
  "variant": "ledger"
}
```

At 960×540 this wraps to three title lines at 66 px and two subtitle lines at
25 px; the subtitle break falls after 练习, not before an orphaned character.
The English replacement `"AFTER THE SIGNAL"` with subtitle
`"城市在聆听 / when the city listens"`, number `108` and emphasis `SIGNAL` wraps
to two title lines at 74 px.

## Font and glyph coverage

- `fonts/NotoSansSC-VF.woff2` is the **complete** Noto Sans SC variable font
  (`wght` 100–900), not a subset for the sample sentence. `ready()` loads it
  with `FontFace` and adds it to `document.fonts`; a load failure stops the
  capture.
- The authored font stack names only `Noto Sans SC Kinetic` (the runtime
  alias). It does not claim to suppress a browser's last-resort fallback for a
  code point absent from the bundled cmap; such text is outside the guarantee.
- Conversion preserves the complete font data. The cmap dictionaries (30,890
  code points), glyph order (31,036 glyphs), `hmtx` metrics, `gvar` variation
  bytes and every outline are identical before and after conversion; outlines
  also match at `wght` 100/400/700/900. Only `head.checkSumAdjustment`
  and the `head.flags` lossless-compressed marker differ, as expected for a
  re-encoded container.
- Actual coverage is the font's cmap, not an arbitrary promise about every CJK
  code point. The default title, subtitle and number have no missing code
  points. `U+1F600`, `U+20000` and `U+10FFFF` are absent from this font and are
  not promised; `U+9FA6` is present. The conversion record and coverage results
  are in [LICENSES.md](LICENSES.md).

## Files and provenance

| File | Role |
|---|---|
| `kinetic-type-scene.html` | current `window.viscraft.ready/render(ctx)` entry |
| `kinetic-type.mjs` | deterministic layout and canvas renderer |
| `create.mjs` | thin recipe: options, Source, Assets, handoff |
| `rights.mjs` | code and font rights used by the recipe |
| `STYLE.md` | visual hierarchy, reading rules and beat sheet |
| `fonts/NotoSansSC-VF.woff2` | complete variable font, font Asset and Source resource |
| `fonts/OFL-NotoSansSC.txt` | verbatim OFL 1.1 text |
| `LICENSES.md` | Apache-2.0, retained MIT and OFL grants, source commit and conversion record |
| `README.md` | this page |

Code provenance: original implementation; mechanisms studied from Lemo-Opuscar
`styles/swiss-motion/demo/film.js` (`69da97cb…d4be`) and `ease.js`
(`c6b8aefb…e9c8`) at `e3cb16f63768c68693ff0e15171d6e755457cc32` (MIT), and
huashu-art-motion `y5_kinetic_type.js` at
`f178bd7754a71d6d399473af1501634548efa6cb` (method only, no source copied).
The upstream story lines, music, voice, fonts and fixed 120 BPM timeline are not
included.

## Adapting upstream — what was and was not used

- **Studied as mechanism (Lemo, MIT):** the 12-column grid build
  (`gridState` / `drawPosterGrid`), the clipped baseline rise (`revealText`),
  staged line entry (`drawLine`), compact/re-aligned poster text
  (`drawPosterText`) and the numeral mask (`drawNumeral`) in
  `styles/swiss-motion/demo/film.js`, plus the generic `clamp` / `lerp` / `seg`
  ideas in `ease.js`.
- **Independently implemented:** all canvas code, the DP line wrapper, CJK/Latin
  tokenization, the subtitle orphan rule, the still reading hold, the red
  one-word emphasis and underline, the number counter, the index layout and the
  paper-wash wipe. The easing here is a cubic ease-out/ease-in-out, not Lemo's
  `cubicBezier(.7, 0, .2, 1)` or its BPM/snap timeline.
- **Method study only (huashu y5):** page hierarchy, one cue per page and the
  idea of a page-level wipe. No source line, story, score, voice, media or
  font from that clip is included.
- **Not adopted:** the upstream 44-second story, music, voices, poster wall,
  rotating camera, fixed 120 BPM rule, Archivo / Fraktur / DM Serif fonts and
  all sample media. The only font here is the bundled Noto Sans SC WOFF2.

## Known limits

- This is one short reading segment, not a full film or a general layout engine.
  Its six phases and two opening variants are a deliberate local choice.
- The default title is an example, not a creative brief. Replace it and review
  the new line breaks at the actual output size; the design does not claim
  aesthetic approval.
- `emphasis` must stay inside one wrapped line. If a line break splits the
  chosen substring, the scene throws a named error instead of silently
  emphasising nothing.
- The font's cmap is the real coverage boundary. A code point absent from Noto
  Sans SC is not promised; the default authored text is checked against the
  cmap before delivery.
- The module is a pure frame function and has no stateful seek/reset path;
  frames are rendered once each in ascending order.
- The line counts above cover the default text, a long Chinese/Latin title and
  an English replacement at 960×540 and 192 frames. Full-motion pacing and the
  work's effect remain the author's judgement.

Preview: `preview.mp4` — 1920×1080, 24 fps, 8 s, silent.

Viscraft-owned contributions and previews use Apache-2.0. Upstream code and
third-party materials retain their notices. See [licences](LICENSES.md) for the
complete texts and scope; this does not set the licence of your whole new work.
