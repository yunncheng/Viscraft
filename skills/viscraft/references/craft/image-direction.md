# Visual development and image direction

**Read this when** a shot needs an image designed, approved or changed for a
specific role, or when the user wants a still that stays editable. **It does not
own** the file-admission mechanics, the service contract or the timeline
execution. How to turn a Look into concrete, approved imagery before committing
expensive production. This page owns the *craft* of developing and directing
images, and the full still-image route (document → target → render → workbench);
the mechanics of admitting a file into the Project live in
[Media preparation](../runtime/media-preparation.md), the image-service contract
in [Generation inputs](../providers/generation-inputs.md), and the timed-picture
execution in [Timeline](../runtime/timeline.md).

## Goal

Produce the material the shots actually need — identity, material, environment,
composition and lighting references — and decide, per image, what it is approved
*for*. The failure this prevents is multiplying an unvalidated look across many
Takes: an image-conditioned model inherits all of the reference's pixels,
including the qualities you meant only as a layout proxy.

## Conditions

- A Look and its few carrying qualities are already chosen
  ([Creative method](creative-method.md)).
- You know which qualities each shot needs a reference for, and what must vary.
- The chosen material path is available: an authorized host image tool, an
  approved licensed image, a code or Blender render, or a configured image
  service. A missing path is a gap to report, not a reason to invent one.
- For an editable still, the shared Browser reports ready (`doctor`) and the
  Project can hold the document and its targets; the workbench needs a real
  local Runtime, not a `file://` copy.

## Implementation entry

| Path | Entry | Best when |
| --- | --- | --- |
| Host image tool | Author the image, retain review candidates in the workspace, then admit selected material with `importAsset` | The host exposes an image tool and there is no configured service; this is the ordinary creator path |
| Editable still | `imageDocuments`/`imageTargets` + `viscraft image`, optionally `viscraft workbench` | The still itself is the deliverable or must stay hand-adjustable |
| Image service | A `generate-image` operation through `providers.imageApi` (`generate` or `edit`) | A real image service is configured and you need a service-side model |
| Authored render | A `browser` (picture) or `blender` Source | The image is geometry, typography, a diagram or a controlled render |
| Licensed material | Import an approved asset with its real rights | Existing approved art supplies the surface or subject |

`importAsset` copies the file and records its real hash and caller rights; it does
not generate or grant rights. Whenever the chosen path is a service or a provider
that can bill or transmit, the spend/upload consent rule in `SKILL.md` applies
before any submission.

For host-cache outputs and user-visible candidate paths, follow
[Candidate retention](../runtime/media-preparation.md#retain-host-tool-candidates).

## Editable stills: the image route

Use this when the user wants a still as a deliverable or a reusable design — a
poster, cover, key visual, diagram, product shot, character sheet, texture — and
expects to adjust it by hand afterwards. The subject, style, aspect ratio and
`imageTargets` id are free: `poster` is one example id, never a required kind, and
nothing in the route branches on it. It is also the honest route for an image that
will later be imported as an Asset into a film: render the still, then place it.

When a poster later becomes a film, keep the **same** Project. Reuse the design
document and its resources at the highest editable level — a `browser` picture
Source reading the same document, or the same Assets — or reference the rendered
still as an explicit Asset for the shots that need it. Importing the PNG is a
legitimate reference/material path; it does not restore layers, text or layout, so
never present the raster as the original editable design.

**Project shape.** A still lives in the same Project as everything else. There is
no image product, no second manifest and no parallel image database;
`project.json` gains two lists:

- `imageDocuments[]` — `{ id, path, resources, revision }`. `path` is one
  fixed-canvas HTML file; `resources` lists every local CSS/font/image file it
  reads; `revision` is the structural revision, bumped by a save.
- `imageTargets[]` — `{ id, document, width, height, scale, format, background }`.
  `width`/`height` are the **logical canvas** the layout is authored for;
  `scale` only raises output pixels (a 2× target renders `2w × 2h`); `format` is
  `png` / `jpeg` / `webp`; `background` is `opaque` / `transparent`.

`composition` is optional. An image-only Project has **no timeline**: do not
invent a Scene, Shot, placement, audio clip, duration or fps to hold a picture,
and do not wrap the still in a Take. `direction` still exists — state the intent
and the Look honestly.

**Author the document, not a bitmap.** Keep text as text, layers as real elements
with stable ids/classes, and type/colour in CSS: that is what later edits and the
workbench act on. Declare every local file in `resources` and reference it by a
portable relative path (both `assets/a.png` and `./assets/a.png` work); the
Runtime rewrites and serves those paths itself. A remote webfont, an `@import`ed
stylesheet, or a script that `fetch`es relative media is outside what the freeze
and rewrite handle — add the font file as a resource and use a local `@font-face`
instead, and reference render-time media from markup/CSS rather than script.
Imported raster art still needs real, recorded rights; register it as an Asset
when a film also uses it. Fonts must be real files you can ship, not a remote
webfont: use a local font file you have the right to redistribute, add it and any
stylesheets/images as declared `resources`, and use a local `@font-face`. Carry
the font's actual licence text beside what you ship and keep the family/weight
facts accurate; subsetting changes coverage, so state the covered range instead
of assuming a rare glyph exists. There is no product-wide font library: fonts
carried with a work are not a font library to adopt.

### Design for the canvas

These judgements usually serve a delivered still, whether an authored design or
a flat raster. What the canvas is *about* —
the subject's own device, and which facts are real — comes from
[Creative method](creative-method.md#translate-intent-into-a-visual-and-temporal-language);
this section covers how it is composed.

- One primary read per canvas. Decide what the viewer sees first, second and
  third, and make that order explicit in size, weight, colour and position. A
  headline, a product and a decoration at a similar size and contrast compete;
  decide which one yields instead of balancing all three.
- A small, deliberate type scale and a measured line-height are one way to set
  hierarchy; align to a shared grid if the design uses one — the workbench snaps,
  but the authored source should already be aligned. Keep one level dominant:
  headings close to display size flatten the order the title established.
- When a long title becomes unreadable because it was shrunk to fit, change its
  measure, line breaks or surrounding composition. Adjust the type size when it
  serves the actual viewing conditions; fitting the box alone does not prove
  that the title or the reading order works.
- Set contrast for the viewing medium, leave margins that survive cropping, and
  let whitespace separate groups instead of more rules and boxes. A space that
  opened only because necessary content was removed is a hole, not calm: restore
  what carried the meaning, or close the space with the subject, the type or a
  deliberate step in ground tone.
- Match CJK and Latin metrics deliberately; check punctuation, line breaking and
  mixed-script baselines at the real output size, not zoomed out.
- Keep decoration subordinate to the message.
- At the intended delivery/viewing size, check necessary text and actual line
  breaks; use a modest thumbnail to inspect focus, information order and the
  type-to-image ratio, not to demand that every label stay readable at every
  scale. Separate a deliberately softened or atmospheric element from
  accidentally unreadable information. One composition need not suit every
  screen; judge the size and reading task you are delivering.

Canvas-design guidance is adapted from Taste Skill; see the
[source and licence notices](../../THIRD_PARTY_NOTICES.md).

### A flat final image: one real layer, no invented structure

When the final
picture is a generated or imported raster — the image itself is the deliverable, not
a design you authored as HTML — do not invent text or object layers for it. Register
the file as an Asset, then keep the upstream fixed-canvas contract and reference
that one Asset as a single image layer. The canvas declares
`data-canvas-width`/`data-canvas-height`; the image is the only `data-layer-id`
unit, keeps its `object-fit`, and the page has no other movable layer. A fixed
full-bleed backdrop or frame stays unmarked (give an overlay `pointer-events: none`
so the image stays selectable). The editor then offers only what a
single-layer document can honestly support: select, move, resize, and render. It
does not recover text, split objects, or add layers, and the document must not
embed a second copy of the picture (reference the registered path; the Asset keeps
the bytes, rights and provenance). The workbench's **View layers** overview is
honest about this: one content layer plus the overview/background presentation,
never fabricated text or object layers. An existing editable design is different:
it keeps its own independent text and image layers.

Minimal shape (adapt dimensions, paths and background; the element styles may live
in the document or a declared stylesheet):

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Diagram</title>
<style>
  html, body { margin: 0; width: 1600px; height: 900px; overflow: hidden; }
  .canvas { position: relative; width: 1600px; height: 900px; background: #0f1216; }
  .canvas img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
  .frame { position: absolute; inset: 0; border: 12px solid #0f1216; box-sizing: border-box; pointer-events: none; }
</style>
</head>
<body>
  <div class="canvas" data-canvas-width="1600" data-canvas-height="900">
    <img data-layer-id="art" src="assets/diagram.png" alt="The delivered diagram">
    <div class="frame"></div>
  </div>
</body>
</html>
```

Size the canvas to the picture's real aspect ratio so `contain` shows the whole
image without letterboxing (use `cover` only when cropping is intended), declare
`assets/diagram.png` in the document's `resources`, and give the target the same
`width`/`height`. The Asset's rights travel with the Project; do not re-license or
duplicate the source file. Third-party fonts, media and models keep their real
rights. This is authoring guidance, not another scaffold: no new SDK entry, CLI
command, image kind or conversion step is needed.

### Render, deliver and adjust it

**Render it.** `viscraft image <project-directory> [--target <id>]`
(`renderImage`) captures the real document and records a normal Build whose
`target` is the image target. The output is a real PNG/JPEG/WebP at
`width × scale` by `height × scale`, with the declared background; it is not a
screenshot of an editor page. Name `--target` whenever the Project declares more
than one (the command refuses to guess). The result is reused only when the
document bytes, every declared resource and the output settings are unchanged —
saving an edit does not re-render by itself, and a still Build never overwrites a
film result (nor the reverse). A still is a real deliverable:
`deliver <project-directory> --image <target>` writes `image/<target>.<ext>` and
needs no film result; delivery always includes the complete editable `project/`.
The target must have a current succeeded render — if it is unrendered or stale, run
`image --target` first; delivery never rasterises automatically and never drops a
selected image silently. A still Build is a **version** like a film's: `status.stills[].build` is a
valid id for `keep`, and `versions`/`revert` treat its snapshot the ordinary way
(target-scoped `current`/`stale`, `changesFromPrevious` against the previous
version of the same target). For the editable side, `export <project-directory>`
carries every image document with its declared resources **and each target's
current rendered still**, so another machine can reopen, re-render and see the
result; a delivered PNG remains the finished file.

**Deliver first, then keep that delivered file current.** A default `deliver` writes
the still into a recorded `output/` entry (default `handoff`). An explicit
destination outside `output/` is a copy the Runtime does not record, so it cannot be
bound or republished in place — deliver to a recorded entry for that. By default,
for every final image, run
`viscraft workbench <project-directory> --document <id> --target <id> --delivery <output-entry>`
and give the user the delivered file, the printed URL and the command that reopens
the delivered project later
([Delivery → Edit a delivered still](../runtime/delivery.md#edit-a-delivered-still)). **Render preview**
then saves the author source, renders the target through the same `renderImage`
path, and republishes the **same** `image/<target>.<ext>`, `index.html` and
`delivery-manifest.json` inside that recorded entry. Same target and format keep the
delivered path; an explicitly changed format updates the managed entry to the real
extension instead of leaving a stale name. Only the bound target's
picture is regenerated: the same bundle's other images, an included movie and
unrelated image targets keep their bytes and are never re-rendered. The previous
Build and Artifact remain readable as an immutable version. A failure keeps the
previous delivered files and surfaces the real error; autosave alone never
republishes anything, and saving an edit is not a render. An unbound workbench is
still a normal authoring tool — binding is what the host does when the work is a
finished delivery.

**Hand adjustment: the workbench.** `viscraft workbench <project-directory>
[--document <id>] [--target <id>] [--delivery <output-entry>] [--port <n>]`
(`serveWorkbench`) serves the local page on loopback with a per-session token in
the URL, and prints the URL to open; `Ctrl+C` stops it. It edits exactly one
registered document, resolved from `project.json` — never an arbitrary path or
command from the page. `--document` is required when several are declared; an
absent or `0` port picks an ephemeral one. `--delivery` names a **recorded**
Runtime output entry, never a file path: it shows the stable delivered file in the
page and lets **Render preview** republish it; an unknown or unrecorded entry is
refused at boot rather than guessed, and a recorded bundle that no longer verifies
opens blocked (with the real reason) and does not publish until it is delivered
again. The Runtime-printed URL carries the
session token; a URL without it is **refused at boot**, not opened read-only. The
Runtime owns the page and its save/render protocol; the behaviour you must
explain to the user is:

- **Saves are real, and only when there are edits.** Autosave writes the same
  local author source after a short idle; a 3 s cap starts on the first unsaved
  edit, so continuous dragging or typing keeps landing — without ending the text
  session or moving the caret (a slow save can extend the gap). The **Save**
  button, `Ctrl/Cmd+S` and **Render preview** all commit the live text — including
  the editor's refit — through the same serialized queue, so no separate
  `Ctrl/Cmd+S` is needed before Save or Render. The badge distinguishes no-edit /
  pending / saving / saved / failed / conflict; browser `localStorage` is recovery
  help, never proof of a save. A failed save keeps the edits in the page and offers
  retry.
- **The source can change under the page.** If an Agent (or another session)
  changed the document, the page keeps its own candidate and offers **Reload
  source** or **Overwrite source** — there is no automatic three-way merge. When
  the page is clean it simply reloads. The page is not a second authority: your
  edits to the author source remain the normal way to change structure.
- **Render from the saved source.** The render button commits and saves the live
  edit, then calls the same `renderImage` path; it never screenshots the live DOM.
  A failed save or an unresolved conflict blocks the render. Editing during a
  render is allowed, and a result whose source has changed since is marked
  **stale** — still real and downloadable, just older. With `--delivery`, a
  successful render also updates the bound delivered copy and the page shows that
  stable path.
- **Export the current picture.** The top-bar Export image action saves the live
  edit, uses the same render/publish path and downloads the result. It reuses a
  current Build and refuses to download an old image after a failed or superseded
  render. Render preview updates without downloading; Last rendered image in the
  footer explicitly retrieves the previously rendered file.
- **It is a micro-adjustment subset, not a design tool.** It reuses select, drag,
  8-handle resize, arrow-key nudge (1 px / Shift 10 px), snapping (Alt disables),
  plain-text edit, proportional font-size steps, project font/stack and system
  family switching, delete, undo, reset and zoom. Reset layout restores the
  geometry measured on opening; Reset all edits restores the complete saved
  design loaded at this editing session's opening, retaining adjustments saved
  before opening and undoing this session's changes even after Save or Export.
  It asks for confirmation and offers Undo reset until the next edit. Save and
  Export do not clear the current Undo stack or advance the opening baseline.
  Refresh, reopening or loading a changed saved source starts a new baseline and
  clears the previous session's Undo history. No permanent initial-version copy
  is created. Author code/assets remain intact. Undoing to saved content clears
  the pending-save indicator; undoing an already autosaved change must itself
  be saved. Adding layers, importing
  images, reordering the stack, rotation, recolour and semantic layer splitting
  remain your work on the author source. For a flat single-image document that
  means move and resize the picture only; there is no text to edit and no layer
  recovery.
- **The page and service have separate lifetimes.** Wait for Saved before
  leaving; autosave writes continuously, not when the page closes. Closing or
  refreshing the page ends its in-memory editing history but does not stop the
  service. The service runs until its process stops; a host may terminate child
  processes when an Agent session exits, so do not promise either outcome.
  To continue, reuse a live service URL or restart `viscraft workbench` for the
  same Project and return the newly printed URL. Saved work survives; old Undo
  history and expired URL tokens do not.
- **The shell is fixed; the design is yours.** `workbench.html`, `workbench.css`
  and `workbench.js` are product resources owned by the Runtime. Do not
  copy, fork or restyle the workbench per project; make the work in the author
  document — canvas, layers, type and resources. The fixed chrome is what keeps
  saving, conflicts, rendering, delivery and the layer view consistent.
- **View layers is an overview, not another output.** The shell's one **View
  layers** button (`Back to editing` returns) reuses the vendored upstream layer
  gallery: the overview, background/base and first-level content modules derived
  from the current editable canvas. It is not a separate `layers.html`, Replay or
  PPTX, and it does not itself write — no save, revision, Build or publication
  (an opening text commit follows the normal save queue). Save and Render still
  act on the author canvas. A one-content-layer document (a flat final image)
  shows that one honest layer, never recovered text/objects. Viewing is not
  publishing, so the button stays available even when a bound delivery is
  blocked; the usual session/token conditions apply.

**Honest limits.** The canvas is logical: `scale` raises output pixels only, and
changing `width`/`height` is a layout change, not a quality knob. Fonts and
images are awaited before capture, but a declared font that did not load may
still fall back: the capture records non-blocking diagnostics (`font-fallback`,
`canvas-upscaled`, `canvas-aspect-mismatch`) on the Build (`viscraft inspect`),
so read those and the actual PNG instead of assuming the DOM. Arbitrary PNG/JPEG
layer recovery is **not** promised: a flat image stays a flat image (or a
registered Asset), and semantic decomposition needs its own tool. A design outside
the editor subset still renders correctly but is not fully hand-editable; say
which parts are.

## Directing choices

- **Decide the image's role before you make it.** Name what it constrains
  (identity, material, environment, camera, composition, style, sound) and what
  may vary. A "good" image with the wrong framing or the wrong approved quality is
  not usable for that role ([Creative method](creative-method.md)).
- **Select the image path by quality, control and total effort.** Follow
  [method selection](creative-method.md#choose-the-medium-for-the-required-control);
  no tool exclusively owns character design or complex surfaces. An image can
  support code-authored motion without committing the passage to video generation.
- **Preserve the intended visual structure.** Direct character silhouette and
  anatomy, abstraction, environment density and material treatment separately.
  Review them against the user's brief before promoting a reference. Elaborate
  surfaces or costumes do not compensate for a different character concept;
  refinement can come from shape, proportion, palette and composition.
- **Direct the moment, not an adjective list.** A still describes a visible moment
  with enough staging to read: subject, expression, framing, light, and the state
  the shot starts from. For imagery that a later video shot must evolve, check the
  still has **not already performed** the change the video is meant to show.
- **Use a hero frame when it resolves a shared design question.** A suitable
  master can anchor needed variants; neither variants nor a polished image for
  every planned shot are compulsory. Keep planning imagery distinct from selected
  production inputs through their [actual roles and uses](creative-method.md#prepare-the-basis-before-making-several-related-segments).
  For a Look change, use the [direction-specific preparation and repair choices](../workflows/generation-recipes.md#carry-one-event-across-an-intentional-look-change)
  to decide whether existing imagery suffices or actual footage should guide a counterpart.
- **Show a key creative choice only when it is worth the cost.** The default is to
  decide and record ([when to ask](../../SKILL.md#when-to-ask-the-user)). Show the
  concrete main asset or representative Look before dependent production when the
  cost of being wrong outweighs preparing the evidence, or when the user asked for a
  checkpoint — not for every Look. A first-frame preview can settle appearance
  without a proxy video; it cannot settle motion. Follow
  [Creative review](creative-method.md#creative-review-and-production-commitment)
  and [Render or proxy selection](creative-method.md#decide-whether-an-authored-render-is-final-picture-or-a-proxy).
- **Use a storyboard or animatic to resolve sequence uncertainty.** Suitable image
  Assets placed directly on the timeline can become a sounded, timed animatic when
  timing/cut uncertainty warrants it
  ([Timeline](../runtime/timeline.md)). The animatic is a planning
  result; selecting a final motion Source is a separate authoring decision. Do not
  require an animatic or a motion proxy solely to approve one image.
- **Grade to unify, not to hide.** A named Look's numeric grade unifies tonal
  treatment across shots; it cannot repair identity or shape drift
  ([Timeline](../runtime/timeline.md)).

## Preparing a new camera-angle image

- **Preserve the facts the angle does not change.** A new viewpoint image for a
  shot must carry the stable identity/design, the props and held items, the
  scene/spatial relationship, and the action's initial state for that shot
  ([Establish the whole work and its changes](creative-method.md#establish-the-whole-work-and-its-changes)).
- **Know what one existing image cannot give you.** A shared still fixes appearance
  and one moment, not a new angle. It cannot determine a different viewpoint,
  hidden detail, depth or occlusion the frame never showed, or the state at a later
  moment; prepare a shot image for the new viewpoint.
- **The same job across every method.** This holds whether the surrounding shots are
  Code, Blender/World, recorded real footage or generated — the image's job is the
  same.
- **A missing identity basis is an ordinary gap.** When a persistent identity has no
  visual basis, prepare one with a suitable host image tool (above) and state the
  remaining risk; prepare a character sheet only when the work actually needs one.

## Failure repair

| Observed | Likely cause | First repair |
| --- | --- | --- |
| Final material shows a proxy's flat shapes/materials | The proxy was used as if it were final appearance | Re-author or re-render a suitable input for that role; keep the proxy labelled planning-only |
| Identity or palette drifts across shots | Accumulating drift from output-to-output chaining, or a still that no longer suits the new framing | Compare back to the approved anchor, not only the adjacent cut; re-prepare a reference for the affected shot |
| Crop "fixed" a subject but lost the relationship | Cropping removes other subjects/interaction | Re-compose or re-render the needed relationship rather than cropping |
| A pretty still produces the wrong shot | The still already performed the intended change, or framing/value conflicts | Re-stage the still for the shot's actual start state |
| The PNG differs from what the browser showed | Unsaved changes or an older output; resource/font loading differences; overflow of the logical canvas | Check the shown target and stale/save state, inspect resource warnings and the actual font, then save/render the intended target and inspect its file; repair declared inputs or overflow as needed |
| `deliver` refuses a still | The target has no succeeded render, or its render key is stale against the current document/resources | Run `viscraft image <project-directory> --target <id>` first; delivery never renders it for you |
| Render succeeded but the delivered file did not update | The bound `output/` entry was moved/hand-edited, or publication failed; the render itself is real | Keep the new render, fix or re-deliver the entry, then **Render preview** again — never hand-edit the bundle or point the binding at an arbitrary path |
| A flat final image cannot be text-edited | It is one raster layer; no text/object layers exist | Edit the original design or regenerate the picture; do not claim or fabricate recovered layers |
| **View layers** shows one tile and no text objects | The document really has one content layer (e.g. a flat final image) | Expected; edit the design source or regenerate the picture — the overview never invents layers |
| The workbench reports a conflict after an Agent edit | The author source changed under the page | Keep the Agent's bytes with **Reload source**, or choose **Overwrite source** deliberately; there is no automatic merge |

## Evidence scope

A still, a contact sheet or a hero frame establishes **composition, appearance and
the state it shows** — and nothing more. It does not establish motion, a different
viewpoint, hidden detail, identity continuity across shots, sound, or that the
final film reads well. When the host cannot view video, mark motion and pacing
judgements unverified and say so ([Media analysis](../runtime/media-analysis.md)).

For the still route specifically, a returned `path`/`width`/`height`/`sha256` and
a Build record establish **that a real file was captured at those pixels from the
frozen bytes** — not that the design is good, that a font rendered as intended, or
that the workbench save landed. Look at the actual image file before approving it,
and if you cannot open images, mark the visual judgement unverified instead of
inferring it from the success record.
