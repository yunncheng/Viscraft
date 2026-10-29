/**
 * E2E: the reusable motion + camera author module.
 *
 * Proves, with the REAL browser capture path, that:
 *  - the module's pure helpers behave (named easings, log zoom, stepped cadence,
 *    an eased scope with holds, a staggered start, springs, and loud validation)
 *    — fast, no browser;
 *  - `at(frame, size)` is a PURE function of the frame: ordered and shuffled
 *    sampling agree exactly, and an `aim` holds its world point on the requested
 *    screen fraction at every zoom (exactly, when drift is off);
 *  - `create.mjs` vendors its files byte-for-byte, registers them as `code`
 *    Assets with real sha256 and the MIT origin, authors one `browser` Source
 *    and BUILDS with the real Runtime;
 *  - a cold start renders real frames at TWO sizes (16:9 and 9:16) that advance
 *    across frames (the camera moves) and keep the aimed subject framed;
 *  - a missing declared resource fails loudly rather than rendering blank.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { openCodeScene } from '../src/backends/browser/capture.js';
import { buildProject } from '../src/build/build.js';
import { authorRecipe } from './authoring-helpers.js';

// The module and its scene have one source in the motion-camera fixture.
const MODULE_DIR = resolve('tests/fixtures/authoring/motion-camera');
const RECIPE_DIR = MODULE_DIR;
const MOTION_MJS = join(MODULE_DIR, 'motion-camera.mjs');
const MOTION_HTML = join(RECIPE_DIR, 'motion-scene.html');
const ENTRY = 'motion-scene.html';
const RESOURCES = ['motion-camera.mjs'];

interface CameraSample {
  frame: number;
  x: number;
  y: number;
  z: number;
  r: number;
  t: number;
  aimed: boolean;
  clamped: boolean;
}
interface Camera {
  frames: number;
  at(frame: number, size?: { width: number; height: number }): CameraSample;
  toScreen(
    world: { x: number; y: number },
    sample: CameraSample,
    size?: { width: number; height: number },
  ): { x: number; y: number };
  visibleWorldBounds(
    sample: CameraSample,
    size?: { width: number; height: number },
  ): { minX: number; minY: number; maxX: number; maxY: number };
  parallax(sample: CameraSample, depth: number): { x: number; y: number; z: number };
  velocity(frame: number, size?: { width: number; height: number }): { vx: number; vy: number };
}
interface MotionModule {
  TAU: number;
  EASING_NAMES: string[];
  EASINGS: Record<string, (t: number) => number>;
  ease(name: string | ((t: number) => number), t: number): number;
  clamp(x: number, a?: number, b?: number): number;
  seg(t: number, a: number, b: number): number;
  window01(t: number, t0: number, dur: number): number;
  stepTime(t: number, fps?: number): number;
  scopeProgress(frame: number, frames: number, options?: { holdIn?: number; holdOut?: number; ease?: string }): number;
  lagged(i: number, n: number, p: number, ratio?: number): number;
  spring(t: number, options?: { duration?: number; bounce?: number; v0?: number }): number;
  springHz(t: number, freq?: number, decay?: number): number;
  float(t: number, amp?: number, period?: number, phase?: number): number;
  zlerp(z0: number, z1: number, e: number): number;
  fitScale(stage: { width: number; height: number }, size: { width: number; height: number }, fit?: string): number;
  keyframeAt(keys: Array<Record<string, number | string>>, frame: number): { z: number; v: number };
  mulberry32(seed: number): () => number;
  hash01(i: number, j?: number): number;
  createCamera(spec: Record<string, unknown>): Camera;
}

const M = (await import(pathToFileURL(MOTION_MJS).href)) as MotionModule;

const FPS = 24;
const STAGE = { width: 1600, height: 900 };
const FRAMES = 8;

const PARAMS: Record<string, Record<string, unknown>> = {
  survey: {
    layout: 'survey',
    stage: STAGE,
    fit: 'cover',
    fps: FPS,
    frames: FRAMES,
    revealEase: 'backOut',
    drift: { amp: 0, seed: 0 },
    callouts: 4,
  },
  assembly: {
    layout: 'assembly',
    stage: STAGE,
    fit: 'cover',
    fps: FPS,
    frames: FRAMES,
    callouts: 3,
  },
};

const BG: [number, number, number] = [8, 17, 27];

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Decode a PNG to raw RGB via ffmpeg (no PNG decoder dependency in Node). */
function rgbPixels(file: string): Buffer {
  const result = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostdin', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 1 << 24 },
  );
  assert.equal(result.status, 0, `ffmpeg decode failed for ${file}: ${result.stderr?.toString() ?? ''}`);
  return result.stdout;
}

function countNonBackground(pixels: Buffer, background: [number, number, number]): number {
  let count = 0;
  for (let i = 0; i < pixels.length; i += 3) {
    const distance =
      Math.abs(pixels[i] - background[0]) +
      Math.abs(pixels[i + 1] - background[1]) +
      Math.abs(pixels[i + 2] - background[2]);
    if (distance > 40) count++;
  }
  return count;
}

/** A private project root carrying the module files byte-for-byte. */
async function authorFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-mc-'));
  await copyFile(MOTION_HTML, join(root, ENTRY));
  await copyFile(MOTION_MJS, join(root, 'motion-camera.mjs'));
  return root;
}

async function renderToBuffer(
  scene: Awaited<ReturnType<typeof openCodeScene>>,
  args: Record<string, unknown>,
): Promise<Buffer> {
  await scene.page.evaluate(async payload => {
    const v = (globalThis as unknown as Record<string, { render: (a: unknown) => Promise<void> | void }>)['viscraft'];
    await v.render(payload);
  }, args);
  return Buffer.from((await scene.page.screenshot({ type: 'png', captureBeyondViewport: false })) as Uint8Array);
}

async function readRigState(
  scene: Awaited<ReturnType<typeof openCodeScene>>,
  args: Record<string, unknown>,
): Promise<{
  layout: string;
  camera: { x: number; y: number; z: number; aimed: boolean; clamped: boolean };
  progress: number;
  revealed: number;
  subjectScreen: { x: number; y: number };
}> {
  await scene.page.evaluate(async payload => {
    const v = (globalThis as unknown as Record<string, { render: (a: unknown) => Promise<void> | void }>)['viscraft'];
    await v.render(payload);
  }, args);
  const state = await scene.page.evaluate(() => (globalThis as unknown as Record<string, unknown>)['rigState']);
  return state as {
    layout: string;
    camera: { x: number; y: number; z: number; aimed: boolean; clamped: boolean };
    progress: number;
    revealed: number;
    subjectScreen: { x: number; y: number };
  };
}

function frameArgs(
  frame: number,
  width: number,
  height: number,
  seed: number,
  params: Record<string, unknown>,
  bindings: Record<string, { id: string; url: string; sha256: string }>,
): Record<string, unknown> {
  return { frame, time: frame / FPS, fps: FPS, width, height, seed, params, bindings };
}

// ---------------------------------------------------------------------------
// Pure helpers: the timing/camera mechanism and the loud-validation contract.
// ---------------------------------------------------------------------------
test('motion-camera module: easings, timing, springs and the camera model are correct', () => {
  assert.ok(M.EASING_NAMES.includes('smooth'));
  assert.ok(M.EASING_NAMES.includes('k75'));
  assert.ok(M.EASING_NAMES.length >= 20);
  // Every named curve is defined at 0 (exactly 0) and finite at 1. `thereAndBack`
  // deliberately ends at 0 (an out-and-back "indicate" curve); every other curve
  // ends exactly at 1.
  for (const name of M.EASING_NAMES) {
    assert.equal(M.ease(name, 0), 0, `${name} starts at 0`);
    if (name === 'thereAndBack') assert.equal(M.ease(name, 1), 0, 'thereAndBack returns to 0');
    else assert.equal(M.ease(name, 1), 1, `${name} ends at 1`);
  }
  assert.equal(M.ease('smooth', 0), 0);
  assert.equal(M.ease('smooth', 1), 1);
  assert.equal(M.ease('smooth', 0.5), 0.5);
  assert.ok(M.ease('k75', 0.5) > 0.49 && M.ease('k75', 0.5) < 0.51, 'k75 is near-linear at the midpoint');
  assert.throws(() => M.ease('nope', 0.5), /unknown easing/);

  // Stepped cadence holds inside a step and advances across one.
  assert.equal(M.stepTime(0.51, 12), 0.5);
  assert.notEqual(M.stepTime(0.51, 12), M.stepTime(0.6, 12));

  // An eased scope with holds is 0 through the head hold and 1 through the tail.
  assert.equal(M.scopeProgress(0, 10, { holdIn: 2, holdOut: 2 }), 0);
  assert.equal(M.scopeProgress(2, 10, { holdIn: 2, holdOut: 2 }), 0);
  assert.equal(M.scopeProgress(9, 10, { holdIn: 2, holdOut: 2 }), 1);
  assert.throws(() => M.scopeProgress(0, 4, { holdIn: 2, holdOut: 2 }), /at least one active frame/);

  // Staggered start: later items start later and finish within one unit.
  assert.ok(M.lagged(3, 4, 0.4, 0.1) < M.lagged(1, 4, 0.4, 0.1));
  assert.equal(M.lagged(0, 4, 0, 0.1), 0);

  // Log zoom: the midpoint is the geometric mean, monotonic across e.
  assert.equal(M.zlerp(1, 16, 0.5), 4);
  assert.ok(M.zlerp(1, 16, 0.25) < M.zlerp(1, 16, 0.75));

  // Springs and float are finite and deterministic.
  for (const t of [0, 0.1, 0.5, 1.5]) {
    assert.ok(Number.isFinite(M.spring(t)) && Number.isFinite(M.springHz(t)) && Number.isFinite(M.float(t)));
  }

  // The seeded PRNG is reproducible and stateless hashes agree.
  const a = M.mulberry32(42);
  const b = M.mulberry32(42);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
  assert.equal(M.hash01(7, 3), M.hash01(7, 3));
  assert.notEqual(M.hash01(7, 3), M.hash01(7, 4));
});

test('the camera sampler is a pure function of the frame and the aim holds exactly', () => {
  const keys = [
    { frame: 0, x: 800, y: 450, z: 1, ease: 'sineInOut' },
    { frame: 5, x: 1000, y: 472, z: 1.9, ease: 'sineInOut' },
    { frame: 11, x: 1180, y: 470, z: 3.4, ease: 'smooth' },
  ];
  const aimWorld = { x: 1180, y: 470 };
  const camera = M.createCamera({
    stage: STAGE,
    frames: 12,
    fps: FPS,
    keys,
    aim: { world: aimWorld, screen: { x: 0.5, y: 0.5 } },
  });
  const size = { width: 640, height: 360 };

  // Same frame twice -> identical; ordered and shuffled agree per frame.
  const ordered = [0, 3, 6, 9, 11].map(f => camera.at(f, size));
  for (let i = 0; i < ordered.length; i++) {
    const again = camera.at([0, 3, 6, 9, 11][i], size);
    assert.deepEqual(again, ordered[i], 'a frame sampled twice is identical');
  }
  const shuffled = [11, 0, 9, 3, 6];
  const shuffledSamples = shuffled.map(f => camera.at(f, size));
  for (let i = 0; i < shuffled.length; i++) {
    const j = [0, 3, 6, 9, 11].indexOf(shuffled[i]);
    assert.deepEqual(shuffledSamples[i], ordered[j], `frame ${shuffled[i]} is independent of sampling order`);
  }

  // The aim holds the world point on the requested screen fraction at EVERY zoom.
  for (const f of [0, 4, 8, 11]) {
    const sample = camera.at(f, size);
    const px = camera.toScreen(aimWorld, sample, size);
    assert.ok(Math.abs(px.x - size.width / 2) < 1e-6, `aim x at frame ${f}`);
    assert.ok(Math.abs(px.y - size.height / 2) < 1e-6, `aim y at frame ${f}`);
    assert.equal(sample.aimed, true);
  }

  // The zoom increases monotonically across the push (log-space, no overshoot).
  assert.ok(camera.at(11, size).z > camera.at(5, size).z && camera.at(5, size).z > camera.at(0, size).z);
  assert.equal(camera.at(0, size).z, 1);
  assert.equal(camera.at(11, size).z, 3.4);

  // A parallax plane moves and scales by depth; bounds clamp the resolved centre.
  const far = camera.parallax(camera.at(11, size), 0.5);
  assert.ok(far.z < camera.at(11, size).z, 'a far plane scales less than the subject plane');
  const bounded = M.createCamera({
    stage: STAGE,
    frames: 10,
    keys: [
      { frame: 0, x: 0, y: 0, z: 1 },
      { frame: 9, x: 999999, y: 999999, z: 2 },
    ],
    bounds: { minX: 100, minY: 100, maxX: 500, maxY: 400 },
  });
  const clamped = bounded.at(9, size);
  assert.equal(clamped.clamped, true);
  assert.equal(clamped.x, 500);
  assert.equal(clamped.y, 400);

  // Loud validation: malformed specs throw at authoring time, never silently.
  assert.throws(() => M.createCamera({ stage: { width: 0, height: 9 } }), /stage\.width/);
  assert.throws(() => M.createCamera({ stage: STAGE, frames: 0 }), /frames/);
  assert.throws(() => M.createCamera({ stage: STAGE, keys: [{ frame: 5 }, { frame: 2 }] }), /sorted/);
  assert.throws(
    () => M.createCamera({ stage: STAGE, aim: { world: { x: 1, y: 1 }, screen: { x: 2, y: 0 } } }),
    /aim\.screen/,
  );
  assert.throws(() => M.createCamera({ stage: STAGE, bounds: { minX: 5, minY: 0, maxX: 1, maxY: 1 } }), /bounds\.minX/);
});

// ---------------------------------------------------------------------------
// create.mjs: byte-for-byte vendoring, real Asset registration, real Build.
// ---------------------------------------------------------------------------
test('create.mjs vendors the module verbatim, registers code Assets and builds with the real Runtime', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-mc-create-'));
  const root = join(parent, 'study');
  try {
    // Run a copy of the study outside the repository. The study owns its module
    // and scene; the running Runtime still supplies validation and the notice.
    const detached = join(parent, 'fixture-copy', 'motion-camera');
    await cp(RECIPE_DIR, detached, { recursive: true });
    await authorRecipe({
      recipe: join(detached, 'create.mjs'),
      root,
      cwd: parent,
      options: { width: 160, height: 90, frames: 8 },
    });
    const built = await buildProject(root);
    assert.equal(built.status, 'succeeded', `the generated Project must build: ${built.error ?? ''}`);

    const project = JSON.parse(await readFile(join(root, 'project.json'), 'utf8')) as {
      sources: Array<{ entry: string; resources: string[]; params: { frames: number; stage: unknown } }>;
      assets: Array<{
        id: string;
        path: string;
        type: string;
        sha256: string;
        rights: { license: string; origin: string };
      }>;
      handoff: Array<{ path: string; role: string }>;
      composition?: { audio?: unknown[] };
    };
    assert.deepEqual(project.composition?.audio, [], 'a purely visual reference authors no default audio bed');
    assert.equal(project.sources.length, 1);
    assert.deepEqual(project.sources[0]!.resources, RESOURCES);
    for (const asset of project.assets) {
      assert.equal(asset.rights.license, 'MIT', 'the adapted module records the real MIT licence, never CC0');
    }

    // The vendored working copies must be byte-identical to the Runtime module,
    // and the registered Asset hash must be the real sha256 of those bytes.
    const moduleBytes = await readFile(join(root, 'motion-camera.mjs'));
    const entryBytes = await readFile(join(root, ENTRY));
    assert.equal(
      sha256(moduleBytes),
      sha256(await readFile(MOTION_MJS)),
      'motion-camera.mjs is vendored byte-for-byte',
    );
    assert.equal(
      sha256(entryBytes),
      sha256(await readFile(MOTION_HTML)),
      'motion-scene.html is vendored byte-for-byte',
    );

    const moduleAsset = project.assets.find(a => a.id === 'mc_module');
    assert.ok(
      moduleAsset && moduleAsset.type === 'code' && moduleAsset.sha256 === sha256(moduleBytes),
      'the module is a code Asset with its real hash',
    );
    assert.equal(moduleAsset.path, 'motion-camera.mjs', 'the Asset is the file the Source reads, not a second copy');
    assert.match(moduleAsset.rights.origin, /huashu-art-motion/);
    assert.match(moduleAsset.rights.origin, /f178bd7754a71d6d399473af1501634548efa6cb/);
    for (const source of project.sources) {
      assert.equal(source.entry, ENTRY);
      assert.deepEqual(source.resources, RESOURCES);
      assert.equal(source.params.frames, 8, 'the camera scope matches the authored length');
    }

    // GAP B: the licence TEXT is carried, not only the attribution table.
    const noticesBytes = await readFile(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    assert.match(
      noticesBytes,
      /Permission is hereby granted/,
      'the vendored THIRD_PARTY_NOTICES.md carries the MIT permission notice',
    );
    assert.deepEqual(
      project.handoff,
      [{ path: 'THIRD_PARTY_NOTICES.md', role: 'license' }],
      'the licence text is declared as a license handoff file (carried by a Portable export)',
    );

    assert.doesNotMatch(
      JSON.stringify(project),
      /\/lustre-data\/|\/root\/|\/tmp\//,
      'no absolute host paths may leak into the project',
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Cold start: real frames at TWO sizes, advancing across frames.
// ---------------------------------------------------------------------------
test('a cold start renders real, advancing frames at 16:9 and 9:16', async () => {
  const root = await authorFixture();
  try {
    for (const size of [
      { width: 160, height: 90 },
      { width: 90, height: 160 },
    ]) {
      const destination = await mkdtemp(join(tmpdir(), 'viscraft-mc-start-'));
      try {
        const scene = await openCodeScene(root, { entry: ENTRY, resources: RESOURCES }, size, {
          label: 'captureCode',
          globalName: 'viscraft',
        });
        try {
          const hashes = new Set<string>();
          for (let frame = 0; frame < 4; frame++) {
            const buffer = await renderToBuffer(
              scene,
              frameArgs(frame, size.width, size.height, 11, PARAMS.survey, scene.bindings),
            );
            const file = join(destination, `f-${size.width}x${size.height}-${frame}.png`);
            await writeFile(file, buffer);
            const pixels = rgbPixels(file);
            assert.equal(
              pixels.length,
              size.width * size.height * 3,
              `frame ${frame} decoded at ${size.width}x${size.height}`,
            );
            assert.ok(
              countNonBackground(pixels, BG) > size.width * size.height * 0.03,
              `@ ${size.width}x${size.height} frame ${frame} draws a real scene`,
            );
            hashes.add(sha256(buffer));
          }
          assert.equal(hashes.size, 4, `@ ${size.width}x${size.height} the frames advance`);
        } finally {
          await scene.close();
        }
      } finally {
        await rm(destination, { recursive: true, force: true });
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Determinism, the aim hold, and the reuse `layout` switch.
// ---------------------------------------------------------------------------
test('rendering is deterministic, holds the aim, and the layout param changes the reading', async () => {
  const root = await authorFixture();
  const size = { width: 160, height: 90 };
  try {
    const scene = await openCodeScene(root, { entry: ENTRY, resources: RESOURCES }, size, {
      label: 'captureCode',
      globalName: 'viscraft',
    });
    try {
      const args = (frame: number, params: Record<string, unknown>) =>
        frameArgs(frame, size.width, size.height, 5, params, scene.bindings);

      // (1) The same frame rendered twice is byte-identical.
      const first = await renderToBuffer(scene, args(3, PARAMS.survey));
      const again = await renderToBuffer(scene, args(3, PARAMS.survey));
      assert.ok(first.equals(again), 'the same frame is byte-identical on repeat');

      // (2) Shuffled-order sampling matches ordered sampling per frame.
      const ordered: Buffer[] = [];
      for (const frame of [0, 1, 2]) ordered.push(await renderToBuffer(scene, args(frame, PARAMS.survey)));
      for (const frame of [2, 0, 1]) {
        const shuffled = await renderToBuffer(scene, args(frame, PARAMS.survey));
        assert.ok(shuffled.equals(ordered[frame]), `frame ${frame} is independent of sampling order`);
      }

      // (3) The aim holds the world subject on the screen centre at every frame,
      // and the camera is genuinely moving (zoom increases across the push).
      const zs: number[] = [];
      for (const frame of [0, 2, 4, 7]) {
        const rig = await readRigState(scene, args(frame, PARAMS.survey));
        assert.ok(Math.abs(rig.subjectScreen.x - size.width / 2) < 1, `subject held at centre x (frame ${frame})`);
        assert.ok(Math.abs(rig.subjectScreen.y - size.height / 2) < 1, `subject held at centre y (frame ${frame})`);
        assert.equal(rig.camera.aimed, true);
        zs.push(rig.camera.z);
      }
      assert.ok(zs[3] > zs[0], 'the camera pushes in across the scope');

      // (4) The reveal is a staggered cadence: more callouts are revealed later.
      const early = await readRigState(scene, args(0, PARAMS.survey));
      const late = await readRigState(scene, args(7, PARAMS.survey));
      assert.ok(late.revealed >= early.revealed, 'the staggered reveal advances');
      assert.ok(late.progress > early.progress, 'scope progress advances with the frame');

      // (5) The `layout` param selects a different creative reading of the world.
      const assembly = await readRigState(scene, args(4, PARAMS.assembly));
      assert.equal(assembly.layout, 'assembly');
      const survey = await readRigState(scene, args(4, PARAMS.survey));
      assert.notEqual(assembly.camera.x, survey.camera.x, 'layouts frame differently from one module');
    } finally {
      await scene.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// A missing declared resource fails loudly — never a blank successful frame.
// ---------------------------------------------------------------------------
test('a missing declared resource fails the capture loudly', async () => {
  const root = await authorFixture();
  try {
    const resources = [...RESOURCES, 'motion-camera-extra.mjs'];
    await assert.rejects(
      openCodeScene(
        root,
        { entry: ENTRY, resources },
        { width: 64, height: 64 },
        { label: 'captureCode', globalName: 'viscraft' },
      ),
      (error: unknown) =>
        /motion-camera-extra\.mjs|ENOENT|no such file/i.test(String((error as Error)?.message ?? error)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
