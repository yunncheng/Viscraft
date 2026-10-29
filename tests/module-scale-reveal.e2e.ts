/**
 * End-to-end verification of the SCREEN-ANCHOR SCALE-REVEAL camera fixture
 * (`tests/fixtures/authoring/scale-reveal/`).
 *
 * The camera holds an arbitrary screen anchor, plans zoom in log space, and
 * derives state from time so ordered and shuffled sampling agree.
 *
 * Coverage:
 *  1. (unit) named easings are anchored/monotonic; the zoom is planned in log
 *     space and its held endpoints are exact; golden numbers from the module.
 *  2. (unit) ordered vs shuffled sampling yields byte-identical camera samples.
 *  3. (unit) start/stop holds are exact within the frame scope and out-of-scope
 *     sampling clamps; a bad spec (zoom.from <= 0, anchorScreen outside [0,1],
 *     unknown ease, bad holds/frames) fails loudly.
 *  4. (unit) `project(worldAnchor, at(frame, vp), vp)` equals `anchorScreen * vp`
 *     for 16:9 and 9:16 viewports; `bounds` clamps the resolved centre.
 *  5. (create) `create.mjs` vendors both files byte-for-byte, registers real
 *     sha256 `code` Assets and writes a validating project with no absolute path.
 *  6. (browser) the real scene renders and the on-canvas anchor stays within a
 *     small pixel tolerance of `anchorScreen`, through holds, on 16:9 and on a
 *     second aspect/layout (9:16 + a second subject) — a genuine reuse check.
 */

import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

import { openCodeScene } from '../src/backends/browser/capture.js';
import { buildProject } from '../src/build/build.js';
import { validateProject } from '../src/project/project.js';
import { hashFile } from '../src/shared/hash.js';
import { authorRecipe } from './authoring-helpers.js';

// ---------------------------------------------------------------------------
// The module under test (a plain ESM module; browser and Node).
// ---------------------------------------------------------------------------

// The module and its scene have one source in the scale-reveal fixture.
const MODULE_DIR = resolve('tests/fixtures/authoring/scale-reveal');
const RECIPE_DIR = MODULE_DIR;
const MODULE_PATH = join(MODULE_DIR, 'scale-reveal.mjs');
const ENTRY = 'scale-scene.html';
const RESOURCE = 'scale-reveal.mjs';

interface Viewport {
  width: number;
  height: number;
}
interface Point {
  x: number;
  y: number;
}
interface Sample {
  frame: number;
  globalFrame: number;
  t: number;
  zoom: number;
  scale: number;
  centerWorld: Point;
  clamped: boolean;
  viewport: Viewport;
}
interface Camera {
  frames: number;
  startFrame: number;
  worldAnchor: Point;
  anchorScreen: Point;
  zoom: { from: number; to: number };
  ease: string;
  aspect: number;
  at(frame: number, viewport?: Viewport): Sample;
  project(point: Point, sample: Sample, viewport?: Viewport): Point;
  worldToScreen(frame: number, point: Point, viewport?: Viewport): Point;
  visibleWorldBounds(
    frame: number,
    viewport?: Viewport,
  ): { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number };
}
interface ScaleRevealModule {
  EASING_NAMES: string[];
  ease(name: string, t: number): number;
  createScaleReveal(spec: Record<string, unknown>): Camera;
  project(point: Point, sample: Sample, viewport?: Viewport): Point;
}
const scaleReveal = (await import(pathToFileURL(MODULE_PATH).href)) as ScaleRevealModule;

const close = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;
const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

function baseSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    worldFrame: { width: 1600, height: 900 },
    fit: 'cover',
    viewport: { width: 640, height: 360 },
    worldAnchor: { x: 520, y: 360 },
    anchorScreen: { x: 0.62, y: 0.44 },
    zoom: { from: 1, to: 16 },
    ease: 'linear',
    holdIn: 4,
    holdOut: 6,
    startFrame: 0,
    frames: 96,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. easings, log-space zoom, golden numbers
// ---------------------------------------------------------------------------

test('scale-reveal: named easings are anchored at 0/1, monotonic, and clamp their input', () => {
  assert.ok(scaleReveal.EASING_NAMES.length >= 6, 'the module ships several usable curves');
  for (const name of scaleReveal.EASING_NAMES) {
    assert.equal(scaleReveal.ease(name, 0), 0, `${name} must start at 0`);
    assert.equal(scaleReveal.ease(name, 1), 1, `${name} must end at 1`);
    let previous = -Infinity;
    for (let i = 0; i <= 100; i++) {
      const value = scaleReveal.ease(name, i / 100);
      assert.ok(value >= previous - 1e-12, `${name} must be non-decreasing near t=${i / 100}`);
      assert.ok(value >= 0 && value <= 1 + 1e-12, `${name} must stay within [0,1]`);
      previous = value;
    }
    // range/clamp semantics: the input is clamped, never extrapolated.
    assert.equal(scaleReveal.ease(name, -5), 0, `${name} clamps below 0`);
    assert.equal(scaleReveal.ease(name, 5), 1, `${name} clamps above 1`);
  }
  assert.throws(() => scaleReveal.ease('definitely-not-a-curve', 0.5), /unknown easing/);
});

test('scale-reveal: zoom is planned in log space and its held endpoints are exact (golden numbers)', () => {
  const camera = scaleReveal.createScaleReveal(baseSpec());
  // frame 25, ease 'linear', activeFrames = 96-1-4-6 = 85, t = 21/85.
  const mid = camera.at(25);
  assert.ok(close(mid.zoom, 1.9837569728716709, 1e-9), `mid zoom ${mid.zoom}`);
  assert.ok(close(mid.centerWorld.x, 423.21395078850696, 1e-9), `mid center.x ${mid.centerWorld.x}`);
  assert.ok(close(mid.centerWorld.y, 387.2210763407324, 1e-9), `mid center.y ${mid.centerWorld.y}`);
  // The two holds are returned EXACTLY, without an exp/log round-trip.
  assert.equal(camera.at(0).zoom, 1);
  assert.deepEqual(camera.at(0).centerWorld, { x: 328, y: 414 });
  assert.equal(camera.at(95).zoom, 16);
  assert.deepEqual(camera.at(95).centerWorld, { x: 508, y: 363.375 });

  // For a linear ease with an even active span, t = 0.5 is exactly the
  // geometric mean sqrt(from * to) = sqrt(1 * 16) = 4.
  const even = scaleReveal.createScaleReveal(baseSpec({ frames: 97, holdIn: 0, holdOut: 0, ease: 'linear' }));
  assert.ok(close(even.at(48).zoom, 4, 1e-12), `geometric-mean zoom ${even.at(48).zoom}`);

  // The chosen ease genuinely changes the read (not all motion flattened).
  const cubic = scaleReveal.createScaleReveal(baseSpec({ ease: 'inOutCubic' }));
  assert.notEqual(cubic.at(25).zoom, mid.zoom, 'a different ease must produce a different curve');
  assert.ok(close(cubic.at(25).zoom, 1.1820408298782923, 1e-9), `inOutCubic mid zoom ${cubic.at(25).zoom}`);

  // Monotonic non-decreasing over every frame.
  let previous = -Infinity;
  for (let frame = 0; frame < camera.frames; frame++) {
    const z = camera.at(frame).zoom;
    assert.ok(z >= previous - 1e-12, `zoom must not decrease at frame ${frame}`);
    previous = z;
  }
});

// ---------------------------------------------------------------------------
// 2. purity: ordered vs shuffled sampling
// ---------------------------------------------------------------------------

test('scale-reveal: ordered and shuffled sampling yield identical camera samples', () => {
  const camera = scaleReveal.createScaleReveal(baseSpec({ ease: 'inOutQuint' }));
  const order = [0, 1, 2, 3, 4, 5, 25, 48, 70, 90, 91, 92, 93, 94, 95];
  const shuffled = [93, 2, 90, 0, 48, 5, 95, 25, 1, 94, 70, 4, 92, 3, 91];
  const ordered = new Map(order.map(frame => [frame, JSON.stringify(camera.at(frame))]));
  for (const frame of shuffled) {
    assert.equal(JSON.stringify(camera.at(frame)), ordered.get(frame), `frame ${frame} must be order-independent`);
  }
  // Re-sampling the same frame twice is bit-identical (no hidden state).
  assert.equal(JSON.stringify(camera.at(48)), JSON.stringify(camera.at(48)));
});

// ---------------------------------------------------------------------------
// 3. holds, scope, clamp, and loud failures
// ---------------------------------------------------------------------------

test('scale-reveal: start/stop holds are exact and the frame scope clamps', () => {
  const camera = scaleReveal.createScaleReveal(baseSpec({ startFrame: 10, frames: 30, holdIn: 5, holdOut: 7 }));
  const wide = camera.at(10);
  const tight = camera.at(39);
  for (let k = 0; k < 5; k++) {
    const held = camera.at(10 + k);
    assert.equal(held.frame, k);
    assert.equal(held.globalFrame, 10 + k);
    assert.equal(held.zoom, wide.zoom);
    assert.deepEqual(held.centerWorld, wide.centerWorld);
  }
  for (let k = 0; k < 7; k++) {
    const held = camera.at(39 - k);
    assert.equal(held.frame, 29 - k);
    assert.equal(held.globalFrame, 39 - k);
    assert.equal(held.zoom, tight.zoom);
    assert.deepEqual(held.centerWorld, tight.centerWorld);
  }
  // Out of scope clamps to the nearest held end.
  assert.equal(camera.at(-100).zoom, wide.zoom);
  assert.equal(camera.at(1000).zoom, tight.zoom);
  assert.equal(camera.at(10).globalFrame, 10);
});

test('scale-reveal: bounds clamp the resolved centre and report it', () => {
  const camera = scaleReveal.createScaleReveal(baseSpec({ bounds: { minX: 400, minY: 300, maxX: 600, maxY: 500 } }));
  const wide = camera.at(0);
  assert.equal(wide.clamped, true);
  assert.equal(wide.centerWorld.x, 400); // resolved 328 clamped up to 400
  assert.deepEqual(wide.centerWorld, { x: 400, y: 414 });
  // Without bounds the same frame is unclamped and on the exact anchor.
  const free = scaleReveal.createScaleReveal(baseSpec());
  assert.equal(free.at(0).clamped, false);
});

test('scale-reveal: bad specs fail loudly before any render', () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ zoom: { from: 0, to: 16 } }, /zoom\.from must be > 0/],
    [{ zoom: { from: 1, to: -2 } }, /zoom\.to must be > 0/],
    [{ anchorScreen: { x: 1.2, y: 0.5 } }, /anchorScreen must be within \[0, 1\]/],
    [{ anchorScreen: { x: -0.1, y: 0.5 } }, /anchorScreen must be within \[0, 1\]/],
    [{ ease: 'wobble' }, /unknown easing/],
    [{ frames: 0 }, /frames must be an integer >= 1/],
    [{ holdIn: -1 }, /holdIn must be an integer >= 0/],
    [{ holdIn: 90, holdOut: 90 }, /must leave at least one active frame/],
    [{ worldFrame: undefined }, /worldFrame must be/],
    [{ worldFrame: { width: 0, height: 900 } }, /worldFrame\.width must be > 0/],
    [{ viewport: undefined }, /viewport must be/],
    [{ fit: 'stretch' }, /fit must be "cover" or "contain"/],
    [{ bounds: { minX: 10, minY: 0, maxX: 0, maxY: 10 } }, /bounds\.minX must be <= bounds\.maxX/],
  ];
  for (const [override, matcher] of cases) {
    const spec = baseSpec(override);
    assert.throws(
      () => scaleReveal.createScaleReveal(spec),
      matcher,
      `expected loud failure for ${JSON.stringify(override)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. the screen-anchor invariant, in Node, across aspects
// ---------------------------------------------------------------------------

test('scale-reveal: the world anchor maps to anchorScreen on 16:9 and 9:16 viewports', () => {
  const camera = scaleReveal.createScaleReveal(baseSpec({ ease: 'inOutCubic' }));
  const viewports: Viewport[] = [
    { width: 640, height: 360 },
    { width: 360, height: 640 },
    { width: 1920, height: 1080 },
    { width: 1080, height: 1920 },
  ];
  for (const viewport of viewports) {
    for (let frame = 0; frame < camera.frames; frame += 7) {
      const sample = camera.at(frame, viewport);
      const px = scaleReveal.project(camera.worldAnchor, sample, viewport);
      const expected = { x: camera.anchorScreen.x * viewport.width, y: camera.anchorScreen.y * viewport.height };
      assert.ok(
        dist(px, expected) <= 1e-9,
        `anchor drift on ${viewport.width}x${viewport.height} at frame ${frame}: ${dist(px, expected)}`,
      );
    }
  }
  // A stand-in subject is placed through the same projection.
  const subject = camera.worldToScreen(30, { x: 640, y: 420 }, viewports[1]);
  assert.ok(Number.isFinite(subject.x) && Number.isFinite(subject.y));
  // Culling bounds contain the anchor offset applied to the centre.
  const visible = camera.visibleWorldBounds(30, viewports[1]);
  assert.ok(visible.minX < visible.maxX && visible.minY < visible.maxY);
});

// ---------------------------------------------------------------------------
// 5. create.mjs vendors the module and writes a validating project
// ---------------------------------------------------------------------------

test('scale-reveal: create.mjs vendors both files byte-for-byte and writes a valid, portable project', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-scale-reveal-'));
  const projectRoot = join(parent, 'project');
  try {
    await authorRecipe({ recipe: join(RECIPE_DIR, 'create.mjs'), root: projectRoot, cwd: parent });
    const built = await buildProject(projectRoot);
    assert.equal(built.status, 'succeeded', `the authored Project must build: ${built.error ?? ''}`);

    const entryBytes = await readFile(join(RECIPE_DIR, ENTRY));
    const resourceBytes = await readFile(join(MODULE_DIR, RESOURCE));
    assert.deepEqual(
      await readFile(join(projectRoot, ENTRY)),
      entryBytes,
      'the editable scene is vendored byte-for-byte',
    );
    assert.deepEqual(
      await readFile(join(projectRoot, RESOURCE)),
      resourceBytes,
      'the Runtime module is vendored byte-for-byte',
    );

    const project = validateProject(JSON.parse(await readFile(join(projectRoot, 'project.json'), 'utf8')));
    assert.deepEqual(project.composition!.audio, [], 'a purely visual reference authors no default audio bed');
    const sceneAsset = project.assets.find(asset => asset.path === ENTRY);
    const moduleAsset = project.assets.find(asset => asset.path === RESOURCE);
    assert.ok(sceneAsset && moduleAsset, 'both files must be registered as Assets');
    assert.equal(sceneAsset.type, 'code');
    assert.equal(moduleAsset.type, 'code');
    assert.equal(sceneAsset.sha256, await hashFile(join(projectRoot, ENTRY)));
    assert.equal(moduleAsset.sha256, await hashFile(join(projectRoot, RESOURCE)));

    const source = project.sources.find(candidate => candidate.kind === 'browser');
    assert.ok(source && source.kind === 'browser');
    if (source.output !== 'picture') assert.fail('the module scene must be a picture Source');
    assert.equal(source.entry, ENTRY);
    assert.deepEqual(source.resources, [RESOURCE]);
    assert.equal(source.params.frames, source.frames, 'the camera scope must match the Source length');
    assert.deepEqual(source.params.anchorScreen, { x: 0.62, y: 0.44 });

    // Portability: no absolute host path is written into the Project.
    const offenders: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'string') {
        if (value.startsWith('/')) offenders.push(value);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (value && typeof value === 'object') Object.values(value).forEach(walk);
    };
    walk(project);
    assert.deepEqual(offenders, [], 'the Project must not contain absolute paths');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. real browser capture: the anchor holds on-canvas, across aspects/layouts
// ---------------------------------------------------------------------------

interface RigState {
  frame: number;
  globalFrame: number;
  t: number;
  zoom: number;
  scale: number;
  layout: string;
  centerWorld: Point;
  anchorScreen: Point;
  viewport: Viewport;
  intendedPx: Point;
  projectedPx: Point;
  measuredPx: { x: number; y: number; pixels: number } | null;
}

async function probeFrames(
  output: { width: number; height: number; fps: { numerator: number; denominator: number } },
  frameCount: number,
  params: Record<string, unknown>,
  seed: number,
): Promise<RigState[]> {
  // The scene is Skill-owned and the module is Runtime-owned: stage both in one
  // directory so the browser resolves them by relative path.
  const staged = await mkdtemp(join(tmpdir(), 'viscraft-scale-stage-'));
  let scene: Awaited<ReturnType<typeof openCodeScene>> | undefined;
  const states: RigState[] = [];
  try {
    await copyFile(join(RECIPE_DIR, ENTRY), join(staged, ENTRY));
    await copyFile(join(MODULE_DIR, RESOURCE), join(staged, RESOURCE));
    scene = await openCodeScene(
      staged,
      { entry: ENTRY, resources: [RESOURCE] },
      { width: output.width, height: output.height },
      { label: 'scaleRevealE2E', globalName: 'viscraft' },
    );
    for (let frame = 0; frame < frameCount; frame++) {
      const time = (frame * output.fps.denominator) / output.fps.numerator;
      await scene.page.evaluate(
        async args => {
          const v = (globalThis as unknown as { viscraft?: unknown }).viscraft as { render: (a: unknown) => unknown };
          await v.render(args);
        },
        {
          frame,
          time,
          fps: output.fps.numerator / output.fps.denominator,
          width: output.width,
          height: output.height,
          seed,
          params,
          bindings: {},
        },
      );
      const state = await scene.page.evaluate(() => (globalThis as unknown as { rigState?: unknown }).rigState);
      states.push(state as RigState);
    }
    scene.assertHealthy();
  } finally {
    try {
      await scene?.close();
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
  }
  return states;
}

function assertAnchorHeld(states: RigState[], tolerance = 1.5): void {
  for (const state of states) {
    assert.ok(state.measuredPx, `frame ${state.frame}: the probe marker must be present on canvas`);
    assert.ok(
      dist(state.projectedPx, state.intendedPx) <= 1e-6,
      `frame ${state.frame}: module projection must equal the intended pixel (${dist(state.projectedPx, state.intendedPx)})`,
    );
    assert.ok(
      dist(state.measuredPx, state.intendedPx) <= tolerance,
      `frame ${state.frame}: on-canvas anchor must stay within ${tolerance}px of anchorScreen (drift ${dist(state.measuredPx, state.intendedPx)})`,
    );
  }
}

function assertHoldsAndReveal(states: RigState[], holdIn: number, holdOut: number, from: number, to: number): void {
  const last = states.length - 1;
  assert.ok(close(states[0].zoom, from), `first frame must hold the wide state (${states[0].zoom})`);
  assert.ok(close(states[last].zoom, to), `last frame must hold the tight state (${states[last].zoom})`);
  for (let k = 1; k < holdIn; k++) {
    assert.ok(close(states[k].zoom, from), `hold-in frame ${k} must stay at the wide state`);
    assert.deepEqual(states[k].centerWorld, states[0].centerWorld, `hold-in frame ${k} centre`);
  }
  for (let k = 1; k < holdOut; k++) {
    assert.ok(close(states[last - k].zoom, to), `hold-out frame ${last - k} must stay at the tight state`);
  }
  for (let frame = 1; frame < states.length; frame++) {
    assert.ok(states[frame].zoom >= states[frame - 1].zoom - 1e-12, `zoom must not decrease at frame ${frame}`);
  }
}

test('scale-reveal: the scene renders and the anchor holds on canvas at high zoom (16:9)', async () => {
  const frames = 14;
  const params = {
    layout: 'beacon',
    worldAnchor: { x: 520, y: 360 },
    anchorScreen: { x: 0.62, y: 0.44 },
    zoom: { from: 1, to: 16 },
    ease: 'inOutCubic',
    holdIn: 2,
    holdOut: 4,
    startFrame: 0,
    frames,
    bounds: null,
  };
  const states = await probeFrames(
    { width: 320, height: 180, fps: { numerator: 24, denominator: 1 } },
    frames,
    params,
    7,
  );
  assert.equal(states.length, frames);
  assertAnchorHeld(states);
  assertHoldsAndReveal(states, 2, 4, 1, 16);
  // The reveal actually magnifies the world.
  assert.ok(states[states.length - 1].scale > states[0].scale * 8, 'the push must genuinely magnify');
});

test('scale-reveal: a second subject/layout and a vertical 9:16 aspect keep the anchor', async () => {
  const frames = 12;
  const params = {
    layout: 'pipeline',
    worldAnchor: { x: 1080, y: 520 },
    anchorScreen: { x: 0.5, y: 0.5 },
    zoom: { from: 1.2, to: 20 },
    ease: 'outCubic',
    holdIn: 2,
    holdOut: 3,
    startFrame: 0,
    frames,
    bounds: null,
  };
  const states = await probeFrames(
    { width: 180, height: 320, fps: { numerator: 24, denominator: 1 } },
    frames,
    params,
    21,
  );
  assert.equal(states.length, frames);
  for (const state of states) assert.equal(state.layout, 'pipeline');
  assertAnchorHeld(states);
  assertHoldsAndReveal(states, 2, 3, 1.2, 20);
});
