# Code visuals

How to author visuals directly in code — and how to composite approved raster art
with code-directed layout and motion. This page owns the _craft_ of code-drawn
and composited visuals; the CodeScene execution contract (entry, resources,
bindings, determinism) is in [Runtime and authoring](../runtime/runtime-authoring.md),
and the cutout/keying mechanics are in
[Media preparation](../runtime/media-preparation.md).

## Goal

Author whole animated scenes, character actions, camera movement, typography and
procedural visuals with code when it can meet the intended quality and control.
Approved raster art can supply selected surfaces, backgrounds or character parts;
its rigid transforms do not recover depth, layers or rigging. Choose the route by
[quality, control and effort](creative-method.md#choose-the-medium-for-the-required-control),
then judge whether the actual render is final picture or a useful proxy. An
adequate final code scene needs no model pass just to make the workflow look hybrid.

## Conditions

- The visual is reproducible from `(time, seed, params)`, either by direct time
  evaluation or a fixed-step stateful implementation initialized by `ready()`
  (and `reset()` when needed). Test the sampling order that the implementation
  actually supports; persistent drawing resources alone do not imply accumulated
  timeline state.
- Any environment beyond the entry (fonts, textures, libraries) can be declared
  as in-project `resources`/`bindings` — no CDN or network
  ([Runtime and authoring](../runtime/runtime-authoring.md)).
- For composited art, the raster is approved and its rights are recorded.

## Implementation entry

- **Pure code** — a `browser` Source with `output: 'picture'` whose entry (an
  `.html`/`.htm` page, or a `.ts`/`.tsx` module the Runtime transpiles) exposes
  `window.viscraft.render(...)`; it captures one deterministic frame per
  index.
- **Composited raster** — there is no separate "raster Source": use an ordinary
  `browser` `output: 'picture'` Source that binds image Assets and composites them
  in the CodeScene *before* capture (so a missing image fails the capture rather
  than becoming blank footage). Binding rights/simulated origin are caller data.
- **Cutout / keyed foreground** — an explicit mask or colour-key step (a host
  preparation tool, or local image/FFmpeg processing) produces the foreground; import
  the result as an image Asset and composite it in the `browser` Source. There is no
  `cutout`/`foreground` Source kind; the mechanics and limits are in
  [Media preparation](../runtime/media-preparation.md).
- **Timed picture layers** — `composition.layers` overlays flat rectangular
  video/image panels with opacity in array order
  ([Timeline](../runtime/timeline.md)).
- **Look finishing** — a Direction Look's numeric `grade` applies FFmpeg `eq`
  finishing to each shot's picture ([Timeline](../runtime/timeline.md)).

## Directing choices

- **Use authored control for the relationships that matter.** Coordinate character
  poses, objects, camera and sound on the scene's time function where the brief
  needs that control. Inspect silhouettes, anticipation, contacts, spacing and
  timing at delivery scale; deterministic motion and primitive geometry alone do
  not establish a finished animation.
- **Match the body plan to the character.** A body whose limbs attach to its own
  icon silhouette is not an icon head on a human rig; contacts, weight and prop
  ownership differ. Choose the plan deliberately and check them at delivery size.
- **Composite before capture.** For approved raster art, direct its layout and
  motion with code and composite the layers in the CodeScene _before_ capture, so
  a failed image fails the normal capture rather than becoming blank successful
  footage ([Media preparation](../runtime/media-preparation.md)).
- **Treat transparent art honestly.** Input alpha exposes the background before the
  PNG capture and H.264 encode; the final movie is opaque. A code compositor is
  not video-layer alpha, semantic segmentation, character rigging or recovery of
  image layers.
- **Keep raw material reusable.** Author ordinary Sources and bindings so accepted
  Takes stay editable and a scoped variant changes only the intended Source.
- **Give subject and background a shared treatment.** Regional palettes,
  intentional contrast and a compatible process keep a foreground from looking
  pasted on. Add noise only after the composition works.
- **Layers are panels, not a compositor.** Flat rectangles with opacity, ordered
  by array; not arbitrary blend/mask effects or an NLE. Inspect the reported layer
  boundary strips rather than trusting a nominal rectangle.

## Size the canvas to the capture

The capture renders at the composition's output size, with a device scale factor
of 1 and the canvas box at the top-left of a viewport of exactly that size. A
canvas whose backing buffer is smaller than the pixels it covers is upscaled, so
give the buffer the output size and the same CSS box. Keep a logical design space
when useful, but draw its paths/text into the actual output buffer, rather than
stretching a screenshot of that space. For example:

```html
<style>
  html,
  body {
    margin: 0;
    overflow: hidden;
  }
  canvas {
    display: block;
    width: 100vw;
    height: 100vh;
  }
</style>
<canvas id="c"></canvas>
<script>
  const canvas = document.querySelector('#c');
  const context = canvas.getContext('2d');
  window.viscraft = {
    ready() {
      canvas.width = innerWidth;
      canvas.height = innerHeight;
    },
    render({ width, height, time }) {
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, width, height);
      const scale = Math.min(width / 1920, height / 1080);
      context.setTransform(scale, 0, 0, scale,
        (width - 1920 * scale) / 2, (height - 1080 * scale) / 2);
      // Draw this work's vector scene at time, in its chosen design coordinates.
    },
  };
</script>
```

- **Backing buffer = display pixels.** Set `canvas.width/height` (and, for WebGL,
  keep `gl.drawingBufferWidth/Height` equal to them) to the output size; do not
  scale up by `devicePixelRatio` — the capture already runs at a scale factor of
  1, so a lower-resolution buffer is enlarged into the frame. For a stateful
  `resize`/`ResizeObserver`, set the buffer from the render context's `width` and
  `height`, not from the window alone.
- **Sync the camera aspect on resize.** A camera fixed to one aspect (for
  example `1280/720`) drawn into a differently-shaped canvas stretches the
  picture. Recompute the projection aspect from the canvas box whenever it
  changes.
- **Keep web fonts available.** A family declared with `@font-face` (or
  `FontFace`) that does not load makes text silently fall back; bundle the font
  as a declared `resource` so it is frozen into the scene.

The Runtime reports three **non-blocking** capture diagnostics for exactly these
risks — `canvas-upscaled`, `canvas-aspect-mismatch` and `font-fallback`. They are
recorded on the Build, surfaced in the `review` report and summarized in
`status.attention`; they never fail the Build. A diagnostic is a technical fact,
not a verdict: an intentional low-resolution Look is the author's call, but an
unintended one is cheaper to fix before the pixels are committed.

Choose output size from the actual use and native inputs. The visual studies use
1920×1080 defaults and browsing previews so their edges and type can be examined;
these are editable reference choices, not a Runtime minimum or a quality verdict.
Smaller drafts can resolve timing cheaply, but inspect a representative passage at
delivery pixels before committing the whole render. Preserve deliberate logical
pixel grids with suitable nearest-neighbour/integer scaling. A larger container
cannot add detail to an imported photo, texture or generated clip: retain native
dimensions in the source account, and choose re-authoring, new media or an honest
limited-resolution delivery by the task. Avoid unnecessary lossy preview passes
when a stream copy of the actual Build serves the purpose.

## Make the text the audience must read

When text, UI or a data figure is information the viewer must actually take in —
not a texture — design three phases against the container's motion: how the text
**enters**, how it **stays readable**, and how it **exits**. An entrance that
helps a headline arrive can also stretch, skew or slide it under an overlapping
panel; never warp or occlude text the viewer has to read. Where the text and its
container compete, move them on separate clocks.

Size the reading beat by the **delivery size, the content complexity and the
character count** together. Do not prescribe a universal seconds-per-character
rule, and do not count the animated entrance as reading time — the readable hold
begins once the text has finished arriving and an eye can start. When a
full-screen UI, a dense table or a small widget would be illegible at the
delivery scale, choose a **real local close-up** or a **real interface extract**
rather than shrinking the whole screen and hoping; the viewer reads one honest
region, not a squashed overview. Keep a meaningful reading or action beat at the
end so the last information is readable rather than cut off by the exit. Never
fabricate a product interaction or a data value to make a shot look informative.

Measure mixed CJK/Latin with the actual loaded font. Break CJK at appropriate
glyph boundaries and preserve Latin words, numbers and `%` together where
possible; fit the lines to the real box before animating them. Text measurement
and line breaking do not prove font coverage: inspect representative glyphs at
delivery size, including Chinese text when used, and declare the required font
files as Project resources. A fallback box can have a measurable width too.

## Build the Look from mechanisms

For a stylized scene, describe what produces its appearance: shape language and
silhouette, line weight, material layering, light/shadow, colour relationships,
and how those marks move. Implement the important mechanisms before adding a
finishing filter. For example, translucent irregular washes and stable brush
marks carry a painted Look; a paper texture over generic flat shapes rarely does.
Subject and background may use intentionally different media, but their scale,
lighting and treatment must support the same authored Look. When the print process
itself is the point, plate or ink assignment, misregistration, knockout and paper
tooth change the composition itself; a grain or noise pass over flat shapes is
finishing, not the mechanism. A flat, minimal printed style that needs none of
those mechanisms is equally valid.

Inspect a representative frame at delivery size, then a short passage containing
the hardest action. Paint cached static layers once; derive moving marks from
stable seeds and time rather than rerandomizing their placement every frame.
Raster art with code motion is a valid choice when procedural drawing cannot meet
the intended shape/material quality. See [Motion and cinematography](motion-cinematography.md)
for performance and separate subject/camera timing.

Medium-specific mechanisms stay distinct. Ink works because the paper and ink
layers, loaded-brush pressure and bleed/pooling edges carry the mark; a grain pass
over generic flat shapes does not become ink. A flat cartoon's constant-width
screen-space outline and its stepped boil are separate authored choices from the
character's silhouette: keeping the outline fixed in screen space preserves its
weight as the subject scales, while boil belongs to the character clock. For an
indexed or deliberately low-resolution Look, fix the logical pixel grid, palette
and upscale rule before drawing; integer nearest-neighbour scaling preserves the
invented pixels, whereas non-integer scaling or an open palette changes their
apparent edges and colours.

## Build three-dimensional subjects and environments

For a 3-D scene, allocate craft effort by what the delivery actually exposes:
silhouette in a wide shot, joins and surfaces in a close-up, and the reachable
views in a playable work. Choose a coherent degree of abstraction and aim for a
polished world at that style's level of craft. Style, detail density and finish
quality are separate: a cartoon or low-poly brief does not lower the quality bar,
and adding polygons does not establish it. Inspect these relationships in the
rendered scene:

| Area | What makes the intended design read |
| --- | --- |
| Subject form | Recognizable silhouette and proportions; parts meet with intentional thickness, spacing and edge treatment. Primitives can be a valid final style when their relationships carry the design. |
| Scene structure | Consistent scale, navigable space where needed, focal hierarchy and useful foreground/midground/background relationships. Repetition can establish rhythm; vary or group it where otherwise unrelated objects read as one generic block. |
| Whole-world coherence | Subject, architecture, terrain, vegetation and props share a deliberate level of finish and visual language where present. Inspect important locations and the routes between them; a refined hero asset does not compensate for unfinished surroundings. |
| Surfaces | Material regions suit the forms and Look; texture scale, UV seams, roughness, transparency and normals behave coherently under the actual light. An imported PBR label alone proves none of this. |
| Light and contact | Light direction, shadow, reflections, exposure and object-to-ground contact make the intended forms legible. Detail remains readable in the views that matter. |
| Movement and viewing | Articulation, contact and camera proximity hold up during the intended action, rather than only in one selected still. |

Keep detail purposeful. A scene needs the objects and spatial cues that support its
use and composition, not arbitrary clutter; a minimal environment can be complete.
Bloom, fog, particles and grading can serve the Look, but do not repair malformed
geometry, disconnected parts or an unresolved layout.

**Imported assets and authored control combine normally.** A model can provide the
visible form while code controls its placement, articulation, camera and interaction.
When reuse is promising, follow [Media acquisition](../runtime/media-acquisition.md),
then fit scale, axes, pivots, material response and any rig/animation to this work.
Check dependent textures and supported loaders before relying on the file. Shared
palette, surface treatment and lighting help assets from different sources belong
to one scene; importing a detailed object alone does not finish its surroundings.

For real-time work, choose mesh/texture detail, instancing, shadows and draw cost
against actual viewing distance and performance. Simple collision geometry may
control a refined visible mesh; neither needs to dictate the other's complexity.
Judge appearance at the settings users will actually get, and check motion after
changes. A proxy can deliberately omit visible detail when it only carries control;
selecting it as final picture requires the final Look to work. Use
[representative review](creative-method.md#validate-a-representative-result-before-expanding-production)
and [causal repair](review-repair.md#diagnose-three-dimensional-appearance) before
expanding an uncertain scene.

## Align the authored layer to retained material

When a Code/Three.js/Blender layer shares a shot with an already-accepted
generated or real clip, calibrate the authored layer to the retained material —
inspect actual frames of the retained clip and align the code side's composition,
action phase, camera and timing to its real motion, rather than assuming the
render defines how the shot moves. Either medium may lead: a produced segment can
define the timing the code side is calibrated to. Keep the final/proxy
distinction explicit — a successful render is a technical result until its
appearance and motion meet the shot, and a planning render used only as a proxy
or control input is labelled as such and never selected into the final cut as if
final. After combining, inspect the actual adjacent passage and the final
composite. See [Creative method → choose continuity by the shot
relationship](creative-method.md#establish-the-whole-work-and-its-changes).

## Reuse the working author module

Extract a useful camera, material, layout or transition into an ordinary local
module with explicit parameters and resources. Keep subject content and timing
separate where reuse benefits from it; use existing CodeScene `params`,
`resources` and Asset bindings. Check the module inside the receiving scene, with
its real fonts, dimensions, background, timing and assets. A showcase page may
provide initialization or CSS that the extracted module lacks.

Read a code-visual study when you want the intended appearance connected to a
concrete implementation and editable recipe. They are indexed by the problem they
answer, with what each one demonstrates, in the
[reference map](../creative-references.md).
Each study directory holds its own `README.md` with the scene page, the recipe and
the module beside it; a `STYLE.md` states the visual grammar where that study has
one to state, and not every study does. Read the mechanism's own source when
adapting it; combine mechanisms freely.

Tying a picture event, its sound and a caption to one authored fact is a workflow,
not a visual study: use
[Timeline ](../runtime/timeline.md#tie-picture-sound-and-subtitle-to-one-authored-event).

The implementation is reference-owned: a study's recipe declares its own module,
scene and any licence text, and `authorProject` copies them into the new Project.
There is no central style catalogue or Runtime authoring library: the study owns
its implementation, and the recipe declares it. A study may keep its
rights/origin declarations in a local `rights.mjs` beside the recipe; there is no
central rights table.
[Verify a specific asset's licence](../runtime/media-acquisition.md#2-verify-a-specific-assets-license)
owns how rights are recorded, and
[record attribution on the Asset's rights record](../runtime/media-acquisition.md#6-record-attribution-on-the-assets-rights-record)
owns how a required notice, author and change note are stored and printed with the
work. Reusing registered, attributed author
code needs no per-image re-audit; third-party fonts, media and models keep their
real rights, and a font carried with a work is not a font library you may reuse
elsewhere.

A complete work shipped with the Skill lives under `assets/projects/<work>/` and is
indexed in the
[reference map](../creative-references.md).
For one complete code-drawn narrative with procedural sound, see
[Five More Minutes](../../assets/projects/five-more-minutes/README.md), including
its final encoded review and a local hold/release repair. It is optional;
its style, implementation and sound strategy do not prescribe other works.
Adopted files remain ordinary Project-owned `code`/`font`/`audio` Assets with
explicit `params`, `resources` and bindings; no style registry or new Source kind
is involved.

If you edit an adopted, registered module **inside an existing
Project**, record the current bytes before building or rendering:
`viscraft refresh-code <project-directory> <asset-id>` (SDK
`refreshCodeAsset(root, { assetId, expectedRevision })`). It is the only supported
re-registration of a directly edited `code` file: same bytes is a no-op, rights and
child frozen inputs stay unchanged, and it never writes the file, builds or calls a
provider. Never hand-edit the recorded hash to dodge the check; media Assets are
not refreshable this way and must be re-imported. `build`/`image` will otherwise
refuse an `Asset hash mismatch`.
[Details](../runtime/runtime-authoring.md#92-edit-at-the-highest-available-authoring-layer).

Before offering it as a reusable component, try a materially different subject
or layout. Test the installed/copied module rather than its gallery wrapper,
including known failure inputs. A component's declared purpose must be visible in
its actual output. A technically successful test render is still a test render
until creative quality has been observed and accepted.

## Failure repair

| Observed                                             | Likely cause                                                                  | First repair                                                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Frame `i` differs between runs                       | Wall-clock, `Math.random` or rAF time used in `render`                        | Make the frame a pure function of `(time, seed, params)`; the Runtime does not detect this for you |
| A resource is missing at capture                     | A file read without declaring it in `resources`                               | Declare it so it is frozen into the snapshot                                                       |
| Transparent edges look wrong over the backdrop       | Colour key removed subject colours, or translucent paint retained its backing | Use a deliberate mask; inspect soft edges over the actual backdrop                                 |
| A cutout looks like a recovered 3-D scene but is not | Confusing rigid image motion with rigging/segmentation                        | Re-state the work as a rigid transform of approved art                                             |

## Evidence scope

A code Build records inputs and execution results. Reproducible frames still
require author code to derive each frame from its requested time, seed and
parameters; a successful Build does not prove that property or aesthetic quality.
Still-image review does not establish musical or narrative excellence,
and rigid image motion does not establish deformation or recovered layers. When
the host cannot watch motion, mark motion judgements unverified
([Review and repair](review-repair.md)).
