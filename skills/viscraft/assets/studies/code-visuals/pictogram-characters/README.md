# Pictogram characters — icon-body hand-off

Two icon bodies — a star and a cloud, then a cloud and a gear — hand one prop to
each other. The body is the silhouette: arms and legs are attached directly to
points or lobes of the icon, with no human torso, no neck and no round head.
The study exists to show a readable, purposeful exchange: prepare, contact,
change of ownership, and a held result.

## What is visible

- **Icon bodies, not icon heads.** Star points, cloud lobes and gear teeth are
  the limbs' attachment points. Rotating or squashing the body moves the limbs
  with it.
- **One prop, two owners.** A disc (variant A) or a baton (variant B) is carried
  by the sender, meets the receiver's hand, changes its carrier ring and colour
  at the transfer beat, then stays with the receiver.
- **Depth that explains the pass.** Far legs and the far arm are drawn behind
  the body; the prop is in front of both bodies but behind both near hands. The
  near hand therefore visibly closes over the prop.
- **A real second reading.** Variant B swaps the sender/receiver sides, changes
  the receiver from cloud to gear, changes the prop from disc to baton and
  re-colours the pair. It is not the same picture with a different hue.
- **A result hold inside the authored frames.** The receiver lifts the prop and
  holds it through the last frame. Nothing depends on frames that do not exist.

No text, font, image or audio is used. The stage is Canvas2D only.

## Defaults

| Fact | Value |
| --- | --- |
| Entry | `pictogram-scene.html` |
| Module | `pictogram-characters.mjs` |
| Source length | 48 frames at 24 fps = **2.0 s** per Source |
| Project | 2 Sources = 96 frames = **4.0 s** |
| Source ids | `star_disc`, `cloud_baton` |
| Variants | `star-disc` (star → cloud, disc) and `cloud-baton` (cloud → gear, baton) |
| Seeds | 9151 / 9152 (deterministic grain only; not the action) |
| Audio | none (`composition.audio: []`) |
| Output | 1920×1080 by default; even sizes accepted |

The 48-frame length is a readable-event choice, not a BPM or beat quota. At
120 BPM four beats are 2.0 s, which is 48 frames at 24 fps — this study does not
claim or require that tempo. When you change a Source's `frames` by hand, update
its `params.frames` to the same value; the module derives the hand-off clock from
that number and does not read the Source length from `ctx`.

## Hand-off clock (pure function)

`pictogram-characters.mjs` exports:

```js
import { handoffAt, DEFAULT_FRAMES } from './pictogram-characters.mjs';
handoffAt(15, { frames: 48 });
// { frame: 15, contactFrame: 15, transferFrame: 21, phase: 'contact',
//   owner: 'sender', contact: true, transfer: false, contactPulse, transferPulse, ... }
```

- `contactFrame = round(0.32 × (frames − 1))` unless overridden.
- `transferFrame = contactFrame + max(2, round(0.13 × (frames − 1)))`, clamped
  inside the source.
- Ownership is `owner: 'sender'` before `transferFrame` and `'receiver'` from
  `transferFrame` onward.
- `phase` is `settle → prepare → approach → contact → transfer → result → hold`.
- The whole render is a pure function of `frame`, `params` and `seed`: no wall
  clock, no accumulated state, no unseeded randomness. Sampling frames in any
  order gives the same picture.

For a shorter source pass `contactFrame`/`transferFrame` explicitly through
`params` if you need a different beat; both are optional.

## Editing map

| Want to change | Where | Note |
| --- | --- | --- |
| Which body sends/receives | `create.mjs` `variant` | `star-disc` or `cloud-baton`; shapes and sides follow. |
| Colours | `create.mjs` `palette` | Field, ground, line, ink, sender, receiver, token. |
| Prop | `pictogram-characters.mjs` `VARIANTS[].prop` | `disc` or `baton`; both are drawn by `drawProp`. |
| Beat timing | `handoffAt` fractions, or `params.contactFrame` / `params.transferFrame` | Keep the contact before the transfer and both inside the source. |
| Arm reach | `SENDER_KEYS` / `RECEIVER_KEYS` `innerDX`/`innerDY` | Targets are actor-relative; the facing sign is applied automatically. |
| Leg stance / body lean | the same key tables (`lean`, `innerLeg*`, `outerLeg*`) | Angles are degrees from straight down. |
| Grain / stage tone | `palette.field`, `seed`, `drawStage` | Grain is deterministic and cosmetic. |

## What is adapted and what is new

Upstream: `lemo-opuscar` at
`e3cb16f63768c68693ff0e15171d6e755457cc32`, files
`styles/pictogram-motion/demo/engine.js` (sha256
`4bba5151769a6e68aaef6dc7615b9d8dcebec4d4c5deacec11ee073675116f0a`) and
`styles/pictogram-motion/demo/poses/base.js` (sha256
`b7cb25ab517682306d5387715c3ab2f129e9bbb7d0daa0222a81ec89963a7ae9`), MIT,
copyright © 2026 LemoLab.

Adopted as **ideas and a small amount of generic math/coordinate technique**:

- joint chains expressed as angle poses and `keyPose`-style interpolation with
  per-segment easing (`engine.js` lines ~7–34 and ~196–256);
- far/near draw order so a prop can pass behind a body and in front of a hand
  (`drawFigure`, lines ~226–233);
- simple geometric props made from discs/capsules (`poses/base.js` lines ~20–48).

Not copied:

- `PAL`, `CYCLE`, `motif`, `pattern`, `drawPattern` (official five-colour
  identity, motif/pattern language, row-offset core graphic);
- the athlete poses, `ath.js`/sport pose files, event names, dates, slogan,
  emblem/ref images and `ref/`; fonts, music and voice.

Original for this study: the star/cloud/gear bodies, silhouette anchors,
two-bone IK, hand-off key tables, contact/transfer cues, deterministic grain and
palette.

## Licence

The upstream `engine.js` and `poses/base.js` are MIT (LemoLab, `Copyright (c)
2026 LemoLab`); the verbatim text ships as `LICENSE-Lemo-Opuscar-MIT.txt`.
Everything original to this study — the star/cloud/gear bodies, silhouette
anchors, two-bone IK, hand-off key tables, contact/transfer cues, deterministic
grain and palette — is Apache-2.0, `Copyright (c) 2026 The Viscraft Authors`, and is
recorded with retained upstream MIT in each mixed code Asset's rights. The full grants and texts ship
as [`LICENSES.md`](LICENSES.md), copied into every authored Project as a
`license` handoff.

## Build

```sh
<viscraft> author <skill-dir>/assets/studies/code-visuals/pictogram-characters/create.mjs ./my-pictogram-characters [--options options.json]
<viscraft> build ./my-pictogram-characters
```

`authorProject` copies the scene, module and local MIT text. The Project is
self-contained: it does not import this study or any `references/upstream/`
path.

## Scope and limits

The stage is composed so the hand-off reads even at a 640×360 draft:

- the prop is sized so its carrier ring is legible at delivery scale;
- legs sit under the body rather than on the outer star points, so the
  silhouette reads as a body with two legs and two arms rather than five limbs;
- the receiver's pull/lift targets sit outside its own silhouette, so the hand
  and prop stay visible against the body;
- the contact cue is two expanding rings, which avoids a reticle/crosshair
  reading;
- the cloud arm anchor sits inside the side lobe, with a longer inner-arm reach
  so the contact target and the transfer stay put.

- Longer or other aspect ratios are supported by a uniform stage scale with
  letterboxing; extreme aspect ratios are not specially composed.
- The actors have no faces, clothing, fingers or text; the appeal comes from
  silhouette, timing and the prop.
- The arms are a two-bone IK chain with a downward elbow preference. Very high
  or very lateral targets clamp at maximum reach instead of stretching.
- No audio is authored, so the study carries no sound judgement.
- Rendering is Canvas2D; no WebGL2, no font loading and no image assets.
- A 2-second performance judgement is human work: this reference demonstrates
  the mechanism, not a finished film, and whether the exchange feels convincing
  is the author's call.

Preview: `preview.mp4` — 1920×1080, 24 fps, 4 s, silent.

Viscraft-owned contributions and previews use Apache-2.0. Upstream code and
third-party materials retain their notices. See [licences](LICENSES.md) for the
complete texts and scope; this does not set the licence of your whole new work.
