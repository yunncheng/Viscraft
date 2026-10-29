/**
 * E2E: the reusable cel + watercolour author module.
 *
 * Proves, with the REAL browser capture path, that:
 *  - the module's pure helpers behave (ordered paint stack, loud param
 *    validation, seeded PRNG, reveal timing, deterministic scene geometry) —
 *    fast, no browser;
 *  - `create.mjs` vendors its files byte-for-byte, registers them as `code`
 *    Assets with real sha256, authors two `browser` Sources and BUILDS with the
 *    real Runtime;
 *  - a cold start renders real frames for BOTH subjects at TWO sizes (16:9 and
 *    9:16), and the paint build-up advances across frames;
 *  - rendering is deterministic: the same frame twice is byte-identical, and
 *    shuffled-order sampling matches ordered sampling;
 *  - the reveal is a pure function of the frame: frames differ while painting and
 *    become byte-identical once the paint has completed (no flicker);
 *  - a missing declared resource fails loudly rather than rendering blank.
 *
 * The Look module is plain ESM, so the pure tests import it directly; the frame
 * tests only render tiny sizes and a handful of frames to stay fast.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { openCodeScene } from '../src/backends/browser/capture.js';
import { buildProject } from '../src/build/build.js';
import { authorRecipe } from './authoring-helpers.js';

// The module and its scene live in the cel-watercolor study (one copy).
const MODULE_DIR = resolve('skills/viscraft/assets/studies/code-visuals/cel-watercolor');
const RECIPE_DIR = MODULE_DIR;
const CW_MJS = join(MODULE_DIR, 'cel-watercolor.mjs');
const CW_HTML = join(RECIPE_DIR, 'cel-watercolor-scene.html');
const ENTRY = 'cel-watercolor-scene.html';
const MODULE = 'cel-watercolor.mjs';
const RESOURCES = [MODULE];

interface CwParams {
  [key: string]: unknown;
}

interface SceneBand {
  ridge: Array<[number, number]>;
  base: string;
}

interface ScenePlan {
  width: number;
  height: number;
  u: number;
  hills: SceneBand[];
  ground: SceneBand;
  plants: Array<{ kind: string; strokes: unknown[]; groups: unknown[] }>;
  tussocks: unknown[];
  accents: unknown[];
}

interface CwModule {
  PAINT_STAGES: string[];
  SUBJECTS: string[];
  DEFAULT_PALETTE: Record<string, unknown>;
  DEFAULT_PARAMS: { subject: string; revealFrames: number };
  normalizeParams(raw?: Record<string, unknown>): CwParams & { subject: string; revealFrames: number; density: number };
  mulberry32(seed: number): () => number;
  hash01(seed: number, index: number): number;
  mixHex(a: string, b: string, t: number): string;
  revealAt(frame: number, start: number, duration: number): number;
  qcurve(x0: number, y0: number, x1: number, y1: number, bend?: number, n?: number): Array<[number, number]>;
  polar(x: number, y: number, ang: number, len: number, bend?: number, n?: number): Array<[number, number]>;
  buildScene(subject: string, params: unknown, width: number, height: number, seed: number): ScenePlan;
}

const cw = (await import(pathToFileURL(CW_MJS).href)) as CwModule;

const FPS = 24;
const GROVE_PALETTE = {
  paper: '#f2ead9',
  sky: '#cdd7d8',
  skyDeep: '#aabcc2',
  hillFar: '#a9b79b',
  hillMid: '#829677',
  hillNear: '#6f8468',
  ground: '#cdbf94',
  trunk: '#7a6a57',
  leaf: '#5f8a52',
  leafDeep: '#3f6a3e',
  ink: '#2b2520',
  accent: '#c06a45',
};
const MEADOW_PALETTE = {
  paper: '#eee8dc',
  sky: '#c6d2d6',
  skyDeep: '#9db3bd',
  hillFar: '#9fb294',
  hillMid: '#7b9070',
  hillNear: '#65805f',
  ground: '#c8bb92',
  trunk: '#75685a',
  leaf: '#5a8a54',
  leafDeep: '#3b6a40',
  ink: '#282320',
  accent: '#b96448',
};
const GROVE_PARAMS = {
  subject: 'grove',
  layout: 'wide',
  revealFrames: 6,
  celEdge: 0.85,
  azimuth: 2.25,
  bleed: 0.6,
  wetEdge: 0.6,
  pooling: 0.5,
  grain: 0.35,
  inkWeight: 2.6,
  misregistration: { dx: 0.8, dy: -0.6 },
  density: 1,
  palette: GROVE_PALETTE,
};
const MEADOW_PARAMS = {
  subject: 'meadow',
  layout: 'wide',
  revealFrames: 6,
  celEdge: 0.75,
  azimuth: 2.55,
  bleed: 0.5,
  wetEdge: 0.5,
  pooling: 0.45,
  grain: 0.4,
  inkWeight: 2.2,
  misregistration: { dx: -0.7, dy: 0.5 },
  density: 1.25,
  palette: MEADOW_PALETTE,
};
const PARAMS: Record<string, CwParams> = { grove: GROVE_PARAMS, meadow: MEADOW_PARAMS };
const PAPER: Record<string, [number, number, number]> = { grove: [242, 234, 217], meadow: [238, 232, 220] };

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Decode a PNG to raw RGB via ffmpeg (no PNG decoder dependency in Node). */
function rgbPixels(file: string): Buffer {
  const result = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostdin', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    {
      maxBuffer: 1 << 24,
    },
  );
  assert.equal(result.status, 0, `ffmpeg decode failed for ${file}: ${result.stderr?.toString() ?? ''}`);
  return result.stdout;
}

function countOffPaper(pixels: Buffer, paper: [number, number, number]): number {
  let count = 0;
  for (let i = 0; i < pixels.length; i += 3) {
    const distance =
      Math.abs(pixels[i] - paper[0]) + Math.abs(pixels[i + 1] - paper[1]) + Math.abs(pixels[i + 2] - paper[2]);
    if (distance > 60) count++;
  }
  return count;
}

/** A private project root carrying the module files byte-for-byte. */
async function authorFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-cw-'));
  await copyFile(CW_HTML, join(root, ENTRY));
  await copyFile(CW_MJS, join(root, MODULE));
  return root;
}

async function renderTo(
  scene: Awaited<ReturnType<typeof openCodeScene>>,
  args: Record<string, unknown>,
  destination: string,
): Promise<void> {
  await scene.page.evaluate(async payload => {
    const v = (globalThis as unknown as Record<string, { render: (a: unknown) => Promise<void> | void }>)['viscraft'];
    await v.render(payload);
  }, args);
  await scene.page.screenshot({ path: destination, type: 'png', captureBeyondViewport: false });
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

function frameArgs(
  frame: number,
  width: number,
  height: number,
  seed: number,
  params: CwParams,
  bindings: Record<string, { id: string; url: string; sha256: string }>,
): Record<string, unknown> {
  return { frame, time: frame / FPS, fps: FPS, width, height, seed, params, bindings };
}

// ---------------------------------------------------------------------------
// Pure helpers: the paint stack, validation, PRNG and reveal contract.
// ---------------------------------------------------------------------------
test('cel-watercolor module: the ordered paint stack, params, PRNG and reveal are correct', () => {
  assert.deepEqual(cw.PAINT_STAGES, [
    'paper',
    'sky',
    'celHills',
    'terminator',
    'bleed',
    'ground',
    'plants',
    'foliage',
    'detail',
    'contour',
  ]);
  assert.deepEqual(cw.SUBJECTS, ['grove', 'meadow']);

  const defaults = cw.normalizeParams({});
  assert.equal(defaults.subject, 'grove');
  assert.equal(defaults.revealFrames, 48);
  assert.throws(() => cw.normalizeParams({ subject: 'sunset' }), /unknown subject/);
  assert.throws(() => cw.normalizeParams({ layout: 'tall' }), /unknown layout/);
  assert.throws(() => cw.normalizeParams({ revealFrames: 0 }), /revealFrames/);
  assert.throws(() => cw.normalizeParams({ palette: { paper: 'ivory' } }), /palette\.paper/);
  assert.throws(() => cw.normalizeParams({ misregistration: 4 }), /misregistration/);

  // Reveal timing: 0 before the window, 1 after, linear inside.
  assert.equal(cw.revealAt(0, 0, 4), 0);
  assert.equal(cw.revealAt(2, 0, 4), 0.5);
  assert.equal(cw.revealAt(4, 0, 4), 1);
  assert.equal(cw.revealAt(1, 5, 4), 0);
  assert.throws(() => cw.revealAt(Number.NaN, 0, 4), /frame/);

  // Seeded PRNG: deterministic, in [0,1), seed-dependent.
  const a = cw.mulberry32(7);
  const b = cw.mulberry32(7);
  const c = cw.mulberry32(8);
  const aDraws = [a(), a(), a(), a()];
  const bDraws = [b(), b(), b(), b()];
  assert.deepEqual(aDraws, bDraws, 'the same seed replays the same stream');
  for (const v of aDraws) assert.ok(v >= 0 && v < 1);
  assert.notDeepEqual([c(), c(), c()], aDraws.slice(0, 3));
  for (let i = 0; i < 5; i++) assert.equal(cw.hash01(3, i), cw.hash01(3, i));

  assert.equal(cw.mixHex('#000000', '#ffffff', 0.5), '#808080');

  const pts = cw.qcurve(0, 0, 10, 0, 4, 6);
  assert.equal(pts.length, 7);
  for (const p of pts) assert.ok(Number.isFinite(p[0]) && Number.isFinite(p[1]));
  assert.equal(cw.polar(0, 0, 0, 10, 0, 4).length, 5);
});

test('cel-watercolour scene geometry is deterministic and subject-dependent', () => {
  const grove = cw.buildScene('grove', cw.normalizeParams(GROVE_PARAMS), 160, 90, 42);
  const groveAgain = cw.buildScene('grove', cw.normalizeParams(GROVE_PARAMS), 160, 90, 42);
  assert.deepEqual(grove, groveAgain, 'the same seed builds the same geometry');

  const meadow = cw.buildScene('meadow', cw.normalizeParams(MEADOW_PARAMS), 160, 90, 42);
  assert.notDeepEqual(grove, meadow, 'the two subjects build different scenes');
  assert.equal(grove.plants[0].kind, 'tree');
  assert.equal(meadow.plants[0].kind, 'shrub');
  assert.ok(meadow.tussocks.length > grove.tussocks.length, 'the meadow is denser in grass');
  assert.ok(grove.plants[0].groups.length > 0, 'the grove tree carries foliage groups');

  for (const plan of [grove, meadow]) {
    assert.equal(plan.hills.length, 2);
    for (const band of [...plan.hills, plan.ground]) {
      for (const [x, y] of band.ridge) assert.ok(Number.isFinite(x) && Number.isFinite(y));
    }
  }
  assert.throws(() => cw.buildScene('dragon', cw.normalizeParams({}), 160, 90, 1), /unknown subject/);
  assert.throws(() => cw.buildScene('grove', cw.normalizeParams({}), 0, 90, 1), /width and height/);
  assert.throws(() => cw.buildScene('grove', cw.normalizeParams({}), 160, 90, Number.NaN), /seed/);
});

// ---------------------------------------------------------------------------
// create.mjs: byte-for-byte vendoring, real Asset registration, real Build.
// ---------------------------------------------------------------------------
test('create.mjs vendors the module verbatim, registers code Assets and builds with the real Runtime', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-cw-create-'));
  const root = join(parent, 'study');
  try {
    // Run a copy of the study outside the repository. The study owns its module
    // and scene; the running Runtime still supplies validation and the notice.
    const detached = join(parent, 'skill-copy', 'cel-watercolor');
    await cp(RECIPE_DIR, detached, { recursive: true });
    await authorRecipe({
      recipe: join(detached, 'create.mjs'),
      root,
      cwd: parent,
      options: { width: 160, height: 90, frames: 4 },
    });
    const built = await buildProject(root);
    assert.equal(built.status, 'succeeded', `the generated Project must build: ${built.error ?? ''}`);

    const project = JSON.parse(await readFile(join(root, 'project.json'), 'utf8')) as {
      sources: Array<{ entry: string; resources: string[]; params: { subject: string } }>;
      assets: Array<{
        id: string;
        path: string;
        type: string;
        sha256: string;
        rights: { license: string; redistributable: boolean; origin: string };
      }>;
      handoff: Array<{ path: string; role: string }>;
      composition?: { audio?: unknown[] };
    };
    assert.deepEqual(project.composition?.audio, [], 'a purely visual reference authors no default audio bed');
    assert.equal(project.sources.length, 2);
    assert.deepEqual(project.sources.map(s => s.params.subject).sort(), ['grove', 'meadow']);
    for (const source of project.sources) assert.deepEqual(source.resources, RESOURCES);

    // The vendored working copies must be byte-identical to the Runtime module,
    // and the registered Asset hash must be the real sha256 of those bytes.
    const moduleBytes = await readFile(join(root, MODULE));
    const entryBytes = await readFile(join(root, ENTRY));
    assert.equal(sha256(moduleBytes), sha256(await readFile(CW_MJS)), 'cel-watercolor.mjs is vendored byte-for-byte');
    assert.equal(
      sha256(entryBytes),
      sha256(await readFile(CW_HTML)),
      'cel-watercolor-scene.html is vendored byte-for-byte',
    );

    const moduleAsset = project.assets.find(a => a.id === 'cw_module');
    assert.ok(
      moduleAsset && moduleAsset.type === 'code' && moduleAsset.sha256 === sha256(moduleBytes),
      'the module is a code Asset with its real hash',
    );
    assert.equal(moduleAsset.path, MODULE, 'the Asset is the file the Source reads, not a second copy');
    assert.equal(moduleAsset.rights.license, 'Apache-2.0 AND MIT');
    assert.equal(moduleAsset.rights.redistributable, true);
    assert.match(moduleAsset.rights.origin, /lemo-opuscar/);
    for (const source of project.sources) {
      assert.equal(source.entry, ENTRY);
      assert.deepEqual(source.resources, RESOURCES);
      assert.ok(['grove', 'meadow'].includes(source.params.subject));
    }

    // GAP B: the licence TEXT is carried, not only the attribution table.
    const noticesBytes = await readFile(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    assert.match(
      noticesBytes,
      /Permission is hereby granted/,
      'the vendored THIRD_PARTY_NOTICES.md carries the MIT permission notice',
    );
    assert.deepEqual(
      (project.handoff ?? []).map(file => [file.path, file.role]).sort(),
      [
        ['LICENSES.md', 'license'],
        ['THIRD_PARTY_NOTICES.md', 'license'],
      ],
      'the Viscraft Apache-2.0 grant and the Runtime notice are declared as license handoffs (carried by a Portable export)',
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
// Cold start: real frames for BOTH subjects at TWO sizes.
// ---------------------------------------------------------------------------
test('a cold start renders real frames for both subjects at 16:9 and 9:16', async () => {
  const root = await authorFixture();
  try {
    for (const size of [
      { width: 160, height: 90 },
      { width: 90, height: 160 },
    ]) {
      const destination = await mkdtemp(join(tmpdir(), 'viscraft-cw-start-'));
      try {
        const scene = await openCodeScene(root, { entry: ENTRY, resources: RESOURCES }, size, {
          label: 'captureCode',
          globalName: 'viscraft',
        });
        try {
          for (const subject of ['grove', 'meadow']) {
            const hashes = new Set<string>();
            const frames = [0, 1, 2, 3, 5, 6]; // revealFrames = 6 → completes at frame 6
            for (const frame of frames) {
              const file = join(destination, `${subject}-${size.width}x${size.height}-${frame}.png`);
              await renderTo(
                scene,
                frameArgs(
                  frame,
                  size.width,
                  size.height,
                  subject === 'grove' ? 11 : 22,
                  PARAMS[subject],
                  scene.bindings,
                ),
                file,
              );
              const pixels = rgbPixels(file);
              assert.equal(pixels.length, size.width * size.height * 3, `${subject} frame ${frame} decoded`);
              if (frame === frames[frames.length - 1]) {
                assert.ok(
                  countOffPaper(pixels, PAPER[subject]) > size.width * size.height * 0.15,
                  `${subject} @ ${size.width}x${size.height} draws a real painted scene`,
                );
              }
              hashes.add(sha256(await readFile(file)));
            }
            assert.ok(hashes.size >= 5, `${subject} @ ${size.width}x${size.height} advances as the paint builds up`);
          }
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
// Determinism and the reveal-as-a-pure-function-of-frame contract.
// ---------------------------------------------------------------------------
test('rendering is deterministic and the reveal is a pure function of the frame', async () => {
  const root = await authorFixture();
  const size = { width: 160, height: 90 };
  const params = { ...GROVE_PARAMS, revealFrames: 4 };
  try {
    const scene = await openCodeScene(root, { entry: ENTRY, resources: RESOURCES }, size, {
      label: 'captureCode',
      globalName: 'viscraft',
    });
    try {
      const args = (frame: number) => frameArgs(frame, size.width, size.height, 5, params, scene.bindings);

      // (1) The same frame rendered twice is byte-identical.
      const first = await renderToBuffer(scene, args(2));
      const again = await renderToBuffer(scene, args(2));
      assert.ok(first.equals(again), 'the same frame is byte-identical on repeat');

      // (2) Shuffled-order sampling matches ordered sampling per frame.
      const ordered: Buffer[] = [];
      for (const frame of [0, 1, 2]) ordered.push(await renderToBuffer(scene, args(frame)));
      const shuffled = [2, 0, 1];
      const shuffledBuffers: Buffer[] = [];
      for (const frame of shuffled) shuffledBuffers.push(await renderToBuffer(scene, args(frame)));
      for (let i = 0; i < shuffled.length; i++) {
        assert.ok(
          shuffledBuffers[i].equals(ordered[shuffled[i]]),
          `frame ${shuffled[i]} is independent of sampling order`,
        );
      }

      // (3) While painting, adjacent frames differ.
      assert.ok(!ordered[1].equals(ordered[2]), 'the paint build-up advances between adjacent frames');

      // (4) The reveal is a pure function of the frame index: once complete every
      // later frame is byte-identical (no flicker, no wall clock).
      const doneA = await renderToBuffer(scene, args(5));
      const doneB = await renderToBuffer(scene, args(6));
      assert.ok(doneA.equals(doneB), 'a completed painting is byte-identical across frames');
      assert.ok(!doneA.equals(ordered[0]), 'the completed painting differs from the initial paper');
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
    const resources = [...RESOURCES, 'cw-model.mjs'];
    await assert.rejects(
      openCodeScene(
        root,
        { entry: ENTRY, resources },
        { width: 64, height: 64 },
        { label: 'captureCode', globalName: 'viscraft' },
      ),
      (error: unknown) => /cw-model\.mjs|ENOENT|no such file/i.test(String((error as Error)?.message ?? error)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
