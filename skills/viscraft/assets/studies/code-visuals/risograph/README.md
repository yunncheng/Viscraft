# RISOGRAPH RIDE — three plates on one packed canvas

A local animation reference for **spot-colour separation printing**. One
packed RGB canvas carries three ink separations; a WebGL2 printer applies
per-plate registration, halftone screens, ink grain, paper fibre and roller
gates. The subject is the Lemo "Sunday Ride" character and bicycle, but the two
ride segments here are authored for this reference and can be replaced.

Each four-second ride also carries two local audio Sources: one short bossa
music cue and one Foley cue. They sit on separate `music` and `foley` buses,
follow the same `action-facts.mjs` timings as the picture, and never turn the
picture placement's native audio on (`audio: 'mute'`).

Use it when a work needs the look of a two- or three-colour riso print that
moves: held-paper registration, visible screens, ink arriving plate by plate,
and a readable action rather than a shader test card. Do not use it as a
generic grain or colour-grade filter.

## What is actually printed

- **One plate, three channels.** `draw.mjs` owns a single RGB canvas:
  R = blue density, G = yellow density, B = pink density. It is not three
  canvases combined later. `S.mask` can preview one plate while drawing.
- **Knockout and overprint.** Ordinary 2D drawing is `source-over`, so a later
  shape removes ink from all three plates under it. `over()` switches to
  `lighter` for one region, adding ink only to the channels it paints (for
  example pink over blue becomes violet).
- **Paper halo.** `layer(fn, halo)` draws a character on a transparent layer,
  stamps a zero-ink ring around it, then composites. This ring is part of the
  separation, not a glow effect.
- **Gates and roller sweep.** Each plate can be absent, half-inked or fully on
  press. The shader's `uGate` switches a plate and `uSweep` reveals it with a
  darker roller edge. In this reference blue is already on at frame 0; yellow
  comes on at 0.75 s and pink at 1.5 s (24 fps).
- **Registration.** Each plate has a fixed offset and micro-rotation, plus
  short decaying kicks on authored beats. The offsets live in the plate's own
  coordinate system; the camera keeps moving every frame.
- **Halftone and ink.** Each plate has its own screen angle (15°, 0°, 75°) and
  period. Ink grain has a static sheet component and a 12 fps boiling component;
  solids keep paper pinholes, and streaks follow the paper-feed direction.
- **Paper and sheet rhythm.** Paper fibre is generated in the shader. The
  per-sheet tone/streak value is fixed for one variant and only changes between
  variants, so the screen does not crawl.

## Files

| File | Role |
| --- | --- |
| `create.mjs` | Recipe: picture Sources, music/Foley Sources, audio clips, options and timing. |
| `risograph-scene.html` | Picture entry: `window.viscraft.ready()` + `render(ctx)`. No fonts or network. |
| `scene.mjs` | The two authored compositions, ride actions, camera, plate gates and print parameters. |
| `action-facts.mjs` | Shared real facts: press gates/sheet/registration, bell, pigeons, bakery reach/catch/stow. |
| `score.mjs` | Local four-second bossa cue per ride (`buildMusic` / `renderMusic`). |
| `foley.mjs` | Local ride Foley (`buildFoley` / `renderFoley`); action onsets come from `action-facts.mjs`. |
| `synth.mjs` | Reference-owned bossa synthesizer; voices, filters, room and gate. |
| `risograph-music.html` | Sound entry for the music Source; only the music module is in its resource closure. |
| `risograph-foley.html` | Sound entry for the Foley Source; only the Foley module is in its resource closure. |
| `draw.mjs` | Packed RGB plate, knockout/overprint, paper halo, shape and IK helpers. |
| `rider.mjs` | Rider, bicycle, pigeon and baguette geometry; original Lemo character design. |
| `riso.mjs` | WebGL2 printer: registration, halftone, grain, paper, gates, water reflection. |
| `README.md` | This page. |
| `LICENSES.md` | Lemo attribution, local sound provenance and the MIT text. Read it before adopting the character, printer or synthesizer. |

## Two rides

Both variants share the same rider, bicycle, palette machinery and plate
schedule. They change place, route, object and event:

- **`riverside`** — a quay above a river, with a bridge, town silhouette, two
  trees and a large sun. The rider rings the bell; five pigeons flush from the
  wall and climb across the frame. The water reflects the sun with per-plate
  separation.
- **`bakery`** — a narrow street of facades with a lit bakery window, striped
  awning and a cat on the sill. The baker reaches out; the rider catches a
  baguette in passing and drops it into the basket. A pigeon on the pavement
  flaps away.

The compositions are 1920×1080 design space, fitted (not stretched) into the
output frame. The camera tracks the rider; background layers use different
parallax factors.

## Audio: one music Source and one Foley Source per ride

The default `both` Project has four sound Sources plus the two picture Sources:

| Ride | Picture | Music | Foley |
| --- | --- | --- | --- |
| riverside | `river-ride` | `river-music` | `river-foley` |
| bakery | `bakery-catch` | `bakery-music` | `bakery-foley` |

The four-second cue is two bars at 120 BPM. The plate gates are the musical
entries: bass and brush at the blue gate (0 s), nylon guitar at the yellow gate
(0.75 s), vibes at the pink gate (1.5 s). The cue leaves an action space, answers
after it and closes on Dmaj9 by 4.0 s. There is no continuous pad or uniform
tone bed. In the action window guitar, brush and vibes start no new attacks and
their sustained tail is ducked to 0.35 after the room; low bass may continue.
The window is 2.1–2.55 s for riverside and 2.1–2.75 s for bakery, derived from
the same ride facts as the picture and Foley. Each renderer masters the whole
buffer by one final peak normalization of the summed dry+wet mix to −3 dBFS;
it is not a limiter or compressor. The report exposes `rawPeak`,
`normalizationScale`, `normalizationTarget` (linear) and
`normalizationTargetDbfs` next to the post-normalization `peak`/`rms`.

| Time | Ride | Picture / Foley fact |
| --- | --- | --- |
| 0.00 s | both | blue plate; bass + brush |
| 0.75 s | both | yellow plate; guitar |
| 1.50 s | both | pink plate; vibes |
| 2.10–2.40 s | bakery | baker's reach; soft sleeve at 2.10 |
| 2.3333 s | riverside | first 12 Hz stepped frame that reaches the 2.3 s bell target; one bell strike |
| 2.35–2.55 s | riverside | five pigeon flush starts at 2.35 + i*0.05; one wing flap each |
| 2.45–2.70 s | bakery | catch travels (continuous ramp); first full 12 Hz step at 2.75 |
| 2.75 s | bakery | first 12 Hz step at the full caught position; bread/hand contact |
| 2.85–3.15 s | bakery | basket stow; pavement pigeon flap at 2.85 |
| 3.1667 s | bakery | first 12 Hz step where stowed > 0.82; basket contact |
| 3.00 s | both | music returns to the main phrase |
| 3.50–4.00 s | both | Dmaj9 close; authored fade to 4.00 (music 3.80, Foley 3.85) |

`action-facts.mjs` is the shared authority for the press and physical-action
times above: plate gates, the bell target/strike, the pigeon flush starts and the
bakery reach/catch/stow contacts. The 3.00 s return, the 3.50 s close and the
closing fades at 3.80/3.85 s are local score/Foley arrangement, not shared facts.
`press.kicks` are short **registration** impulses in the picture; they are
deliberately not used as Foley onsets. The riverside bell is 2.3333 s, not
2.25 s: 2.25 s has not yet reached the 2.3 s target. There is no bell in the
bakery ride.

### Sound contract

- Picture Source frames are **video frames**: default 96 per ride. Each sound
  Source carries `durationSamples` and `sampleRate` instead of frames — 192,000
  at 48 kHz for the four-second cue. The sound entry receives that span as
  `samples`, which the module passes to its renderer as a per-channel sample
  count; modules reject a mismatched span instead of stretching or truncating.
- Both sound Sources carry `{ role, variant, duration }` in `params`. `role` is
  `music` or `foley`; `duration` is the authored seconds (4 for the full ride).
- `risograph-music.html` imports only `score.mjs`; `risograph-foley.html`
  imports only `foley.mjs`. Their `resources` closures are separate, so editing
  a music cue cannot re-render the picture or the Foley, and vice versa.
- `action-facts.mjs` is a resource of the picture and both sound Sources. Editing
  it intentionally re-renders the picture and both cues; that is the shared
  truth, not a hidden audio-only change.
- The audio clips use `bus: 'music'` and `bus: 'foley'`; the picture placements
  remain `audio: 'mute'`. No picture-native audio is mixed.
- A shorter `frames` option trims both the picture and the cue (the same cut).
  A longer picture keeps the authored four-second cue and leaves the remaining
  picture without this cue; the cue is never stretched.

## Author and render

```bash
<viscraft> author <skill-dir>/assets/studies/code-visuals/risograph/create.mjs ./my-risograph --options <options.json>
<viscraft> build ./my-risograph
```

Options (all optional):

```json
{ "width": 1920, "height": 1080, "frames": 96, "variant": "both" }
```

- `width`, `height`: even integers. Default 1920×1080.
- `frames`: frames **per Source**, integer ≥ 24. Default 96 (4 s at 24 fps).
  The authored sound cue is 96 frames/4 s; `frames < 96` trims the cue with the
  picture, and `frames > 96` keeps the full cue over a longer picture. The
  default 96 frames is the full four-second arc.
- `variant`: `both` (default), `riverside`, or `bakery`. `both` produces two
  picture Sources, two music Sources and two Foley Sources in a two-shot
  composition; a single variant produces one picture, one music and one Foley
  Source.

The recipe declares its own files, rights and `LICENSES.md`. The separate Build
renders the picture Sources, renders the four sound Takes, mixes the `music` and
`foley` buses, masters and muxes the programme.

## What to edit

- **Composition / route**: `scene.mjs` `riversideBackground()` and
  `streetBackground()`. The camera is derived from the rider's world position;
  keep the rider around design x 760 if you want the tracking composition.
- **Action and object**: `riversideActors()` / `bakeryActors()`. The catch and
  bell use joint targets (`armN`), not separate sprite sequences.
- **Shared facts**: `action-facts.mjs` owns `PRESS` (gates, sheet, base,
  registration kicks) and the real bell/pigeon/bakery times. `scene.mjs` and
  both sound modules import it. Change a fact here only when the picture and the
  sound should move together; the picture and both cues will re-render.
  `actionAt(variant, seconds)` returns the same stepped state the drawing uses
  (`bell`, `reach`, `caught`, `stowed`, `inBasket`).
- **Music**: `score.mjs` `buildMusic()` owns the bass/brush/guitar/vibes events,
  the action space and the Dmaj9 close. `risograph-music.html` is its only entry.
  Editing it re-renders `*-music` only; changing `D_MAJ9_HIGH`, for example,
  changes the music PCM and leaves the Foley bytes unchanged.
- **Foley**: `foley.mjs` `buildFoley()` maps the real facts to the bell, five
  wing flaps, sleeve, catch and basket events. `risograph-foley.html` is its only
  entry. Editing it re-renders `*-foley` only.
- **Sources and clips**: `create.mjs` has the picture/music/foley Source ids,
  params, resources and the `music`/`foley` clip buses. Keep the picture
  placements `audio: 'mute'`; the added cues live on their own clips.
- **Colour**: every colour is a `[blue, yellow, pink]` density. A value of 1 is
  solid ink; 0 is none. To add a new plate colour, change `INK` in `riso.mjs`
  and the densities, not the shader.
- **Plate schedule**: `PRESS[variant].gates` (seconds) and `kicks`
  (registration beats) in `action-facts.mjs`. Gate frame positions are computed
  from the frame clock; there is no per-shot state. Registration kicks are not
  sound cues.
- **Screen and paper**: `riso.mjs` `uAng`, `uPeriod`, `uGrain`, `uBoil`, paper
  colour and `uSheet`; keep the registration offsets small (a few pixels at
  1080p), or the image stops reading as print.
- **Rider / bicycle**: `rider.mjs`. The character is deliberately lanky with
  round glasses, a striped sweater and a long scarf; replacing it with a
  geometric mannequin removes most of what this reference demonstrates.

## Timing and behaviour

At 24 fps, one Source is 96 frames by default:

| Time | Local frame | Picture event | Sound event |
| --- | --- | --- | --- |
| 0.00 s | 0 | Blue plate full; single-colour print | Bass + brush enter |
| 0.75 s | 18 | Yellow plate gate + roller sweep | Guitar enters |
| 1.50 s | 36 | Pink plate gate + roller sweep | Vibes enter |
| 2.10–2.30 s | 50–55 | Riverside bell reach | — |
| 2.10–2.40 s | 50–58 | Bakery reach | Bakery sleeve at 2.10 |
| 2.3333 s | 56 | First 12 Hz step at the bell target | Riverside bell strike (not 2.25) |
| 2.35–3.40 s | 56–82 | Riverside pigeon flush | Five wing flaps at 2.35 + i*0.05 |
| 2.45–2.70 s | 59–65 | Bakery catch travels; full at 2.75 | Bakery contact at 2.75 |
| 2.85–3.15 s | 68–76 | Bakery stow / pavement pigeon flap | Wing at 2.85; stow contact at 3.1667 |
| 3.00 s | 72 | — | Music returns to the main phrase |
| 3.50–4.00 s | 84–96 | End of ride | Dmaj9 close and authored fade |

Character animation is stepped on twos; the camera, wheels and halftone move
every frame. Ink boil uses `floor(frame / 2)`. The output is a pure function of
`frame`, `seed` and `params`; there is no reset or accumulated state.

`render(ctx)` reads `ctx.width/height`, sets the canvas backing buffer, reuses
one WebGL2 printer until the size changes, clears the packed plate and repaints.
The printer asks for `preserveDrawingBuffer: true` so the capture can screenshot
the WebGL result.

## Rights and dependencies

`riso.mjs`, `draw.mjs` and `rider.mjs` are adapted from
`lemo-opuscar/styles/risograph/demo/{riso,draw,rider}.js` at commit
`e3cb16f63768c68693ff0e15171d6e755457cc32` (LemoLab, MIT). The original rider,
bicycle, pigeon and baguette shapes are retained; comments were translated,
the fixed 1920×1080 globals became a per-frame packed plate, model-sheet poses
were removed, and the two scenes, actions and plate schedule are new.

`synth.mjs` is owned by this reference, adapted from lemo-opuscar
`styles/risograph/demo/music/{score,bell}.py` at the same commit (LemoLab, MIT).
`action-facts.mjs`, `score.mjs`,
`foley.mjs` and both sound entries are original to this reference and Apache-2.0.
The score and Foley are synthesized from code; no recordings, samples, fonts,
voice or upstream music/sound effects are included. `LICENSES.md` carries the
full MIT text and the actual adopted source ranges.

Each sound Source is a local `browser` `output: 'sound'` Source. The separate
Build renders each sound Take, mixes the `music`/`foley` buses and masters the
programme.

## Known limits

- This is a local reference segment, not a finished short film. It has no
  narration, titles or story; the two variants are studies in print behaviour,
  character action and a local four-second music/Foley cue.
- The audio is two four-second cues per ride, not a long score. The authored
  span is 4 s — 96 picture frames, and 192,000 samples per channel at 48 kHz on
  each sound Source; a shorter `frames` option trims both picture and cue, and a
  longer picture keeps the same 4 s cue. There is no
  duration-stretch parameter, so do not expect a 40 s score here. A preview
  shorter than the action start (2.1 s) leaves the Foley silent and may omit
  the music close; the action is never pulled earlier to fill it.
- These are signal facts and authored timings only; listening is a separate
  judgement.
- Choose a draft size for the question and available capture performance. The
  default and browsing preview are 1920×1080; inspect dot/edge behaviour at
  delivery pixels, since a small draft changes the halftone screen.
- The blue-only proof is a genuine single-plate proof, not a complete blue
  silhouette: character parts whose density is only yellow/pink stay paper
  until those plates arrive. That is the separation truth; do not "fix" it by
  adding a hidden fourth key plate.
- At 640×360 the halftone period is clamped to 4 px, so the screen is coarser
  than at 1080p. Judge dot/edge quality in the final encoded size.
- The scenes are flat graphic illustration. They do not claim perspective
  rendering, realistic lighting, or a full river/street simulation.
- The sun reflection is implemented through the printer's water uniforms; if
  you remove the water from a composition, remove those uniforms too rather
  than leaving a static orange patch.

Preview: `preview.mp4` — 1920×1080, 24 fps, 8 s, with its authored sound.

Viscraft-owned contributions and previews use Apache-2.0. Upstream code and
third-party materials retain their notices. See [licences](LICENSES.md) for the
complete texts and scope; this does not set the licence of your whole new work.
