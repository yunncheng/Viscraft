# Test fixtures

Fixed inputs and small authoring programs for Runtime and integration tests.
Test files under `tests/` own the assertions; these files supply the scenes,
recipes, recordings and fonts those assertions exercise. They are included in
source checkouts, not in the independent Skill or Runtime package.

## Coverage map

The tests below are primary consumers; some fixtures also share helpers or assets.

| Fixture | Primary tests (relative to `tests/`) | Purpose |
| --- | --- | --- |
| [Author recipes](authoring/recipes/) | [author-cli](../author-cli.test.ts), [author-lineage](../author-lineage.test.ts), [author-runtime-only](../author-runtime-only.e2e.ts) | Authoring output, validation failures, lineage and SDK injection |
| [Cel figure](authoring/cel-figure/README.md) | [module-cel-figure](../module-cel-figure.e2e.ts) | Ordered draw layers, pose/light clocks, resource closure and deterministic capture |
| [Motion camera](authoring/motion-camera/README.md) | [module-motion-camera](../module-motion-camera.e2e.ts) | Pure camera sampling, anchor transforms, aspect ratios and capture |
| [Scale reveal](authoring/scale-reveal/README.md) | [module-scale-reveal](../module-scale-reveal.e2e.ts), [event-sync](../event-sync.e2e.ts) | Screen anchoring through zoom and event synchronization |
| [Type chart](authoring/type-chart/README.md) | [module-type-chart](../module-type-chart.e2e.ts) | Text/chart input, resource closure, rendering and portable export |
| [Atlas reveal](authoring/atlas-reveal/README.md) | [example-atlas-reveal](../example-atlas-reveal.e2e.ts) | Two modules in one frame, selective rebuilding and portable export |
| [Glass study](authoring/glass-study/README.md) | [case-glass-study](../case-glass-study.e2e.ts) | Parameterized Three.js input, dependency closure and selective rebuilding |
| [Contact study](authoring/contact-study/README.md) | [case-contact-study](../case-contact-study.e2e.ts) | Shared picture/sound event clock, measured onset and independent reuse |
| [Poster and film](authoring/poster-and-film/README.md) | [example-poster-and-film](../example-poster-and-film.e2e.ts), [workbench](../workbench.e2e.ts), [workbench-resources](../workbench-resources.e2e.ts) | Shared image/font Assets, independent targets, design edits and delivery |
| [Sound kit](audio/sound-arrange/README.md) | [sound-kit-digests](../sound-kit-digests.test.ts), [case-contact-study](../case-contact-study.e2e.ts) | Recording provenance, actual sound capture, measured onset and independent reuse |
| [World mesh](authoring/mesh/) and [shared helpers](authoring/lib/) | [browser-mesh](../browser-mesh.test.ts), [case-glass-study](../case-glass-study.e2e.ts) | Model loading, camera bindings and shared authoring inputs |
| [Shared-identity recipe](authoring/create-shared-identity.mjs) | [shared-identity](../shared-identity.test.ts) | Declares identity bindings and unresolved provider work without submitting; its optional producer helper requires explicit authorization |
| [Recorded-race score](authoring/score-race-recording.mjs) | [race-score](../race-score.e2e.ts) | Authors sound against an existing recording's event clock |
| Top-level `authoring/create-*.mjs` and companion pages | [runtime](../runtime.e2e.ts), [reference-motion](../reference-motion.e2e.ts), [reference-adaptation](../reference-adaptation.e2e.ts), [orbital](../orbital.e2e.ts), [cutout](../cutout.e2e.ts), [foreground-sprite](../foreground-sprite.e2e.ts), [audio-visual](../audio-visual.e2e.ts), [world-playable](../world-playable.e2e.ts), [race-renderer](../race-renderer.e2e.ts) | Build/edit/delivery paths, media analysis, compositing and playable recording |

## Running and changing fixtures

From the repository root, build and use the test runner, which isolates private
provider configuration:

```sh
npm run build
node scripts/run-tests.mjs unit
node scripts/run-tests.mjs e2e
```

A fixture's `create.mjs` can be run through the built CLI for diagnosis:
`node dist/src/cli.js author <fixture/create.mjs> <new-project-directory>`.
Authoring writes a new Project; rendering/building is a separate operation.
Keep diagnostic Projects outside the fixture tree.

- Keep inputs small enough for the invariant being tested. Add a fixture when an
  existing input cannot exercise that invariant; identify its consuming test.
- Assert Runtime behavior and the validity of required inputs. Do not turn a
  fixture's private camera math, score structure or layout constants into a
  separately maintained product contract.
- Preserve deterministic frame/sample clocks and seeds. Inspect the consuming
  assertions before changing timings, dimensions, IDs or shared modules.
- Reuse existing author modules through declared files; keep resources and licence
  handoffs complete so portability tests still exercise real dependencies.
- Preserve recording/font bytes, pinned digests, source notices and complete
  licences. A replacement needs matching provenance and relevant assertions.
- Generate outputs in test temporary directories. Keep credentials, provider jobs,
  Build caches and rendered test results out of this tree.

The fixture READMEs describe test design and maintenance. Passing numerical or
rendering assertions does not establish artistic quality or subjective listening.
