/**
 * E2E: the reusable procedural-paint author module.
 *
 * Proves, with the REAL browser capture path, that:
 *  - the module's pure contract behaves (mode/subject sets, seeded PRNG,
 *    geometry determinism, loud param validation) — fast, no browser;
 *  - `create.mjs` vendors its files byte-for-byte, registers them as `code`
 *    Assets with real sha256, authors three `browser` picture Sources (one per
 *    mode) and BUILDS with the real Runtime;
 *  - a cold start renders real, non-blank frames for ALL THREE modes, and the
 *    reveal advances the picture across frames;
 *  - rendering is deterministic: the same frame twice is byte-identical and a
 *    shuffled-order sample matches the ordered sample;
 *  - there is no per-frame flicker: a still Look (fixed reveal, boiling off) is
 *    byte-identical across adjacent frames, while a boiling line (driven by the
 *    capture's virtual time) does change;
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

// The module and its scene live in the paint-material study (one copy).
const MODULE_DIR = resolve('skills/viscraft/assets/studies/code-visuals/paint-material');
const RECIPE_DIR = MODULE_DIR;
const PAINT_MJS = join(MODULE_DIR, 'paint-material.mjs');
const PAINT_HTML = join(RECIPE_DIR, 'paint-scene.html');
const ENTRY = 'paint-scene.html';
const RESOURCES = ['paint-material.mjs'];
const MODES = ['wash', 'brush', 'collage'];

interface PaintParams {
  [key: string]: unknown;
}

interface PaintModule {
  PAINT_MODES: string[];
  PAINT_SUBJECTS: string[];
  DEFAULT_PALETTE: Record<string, string>;
  DEFAULT_PARAMS: Record<string, unknown>;
  mulberry32(seed: number): () => number;
  hash01(seed: number, index: number): number;
  noise2(x: number, y: number): number;
  deform(pts: Array<[number, number]>, depth: number, amp: number, rng: () => number): Array<[number, number]>;
  cutPolygon(pts: Array<[number, number]>, rng: () => number, step?: number, amp?: number): Array<[number, number]>;
  normalizeParams(raw?: Record<string, unknown>): PaintParams & { mode: string; subject: string; washLayers: number };
  resolveReveal(params: PaintParams, time: number): number;
  baseComposition(
    subject: string,
    width: number,
    height: number,
    palette: Record<string, string>,
  ): {
    subject: string;
    horizon: number;
    shapes: Array<{ id: string; role: string; color: string; points: Array<[number, number]> }>;
  };
  inkStrokes(
    scene: unknown,
    params: PaintParams,
    rng: () => number,
  ): Array<{ kind: string; pts: Array<[number, number]> }>;
  collagePieces(
    scene: unknown,
    params: PaintParams,
    rng: () => number,
  ): Array<{ id: string; pts: Array<[number, number]> }>;
}

const paint = (await import(pathToFileURL(PAINT_MJS).href)) as PaintModule;

const FPS = 24;
const PAPER: [number, number, number] = [239, 230, 210];

const MODE_PARAMS: Record<string, PaintParams> = {
  wash: {
    mode: 'wash',
    subject: 'landscape',
    revealSeconds: 0,
    reveal: 1,
    washLayers: 6,
    washAlpha: 0.18,
    washAmp: 13,
    grainDensity: 0.05,
    grainAlpha: 0.15,
  },
  brush: {
    mode: 'brush',
    subject: 'still',
    revealSeconds: 0,
    reveal: 1,
    inkWidth: 18,
    inkDry: 0.5,
    inkBristles: 9,
    inkStrokes: 8,
    boilFps: 0,
    grainDensity: 0.04,
  },
  collage: {
    mode: 'collage',
    subject: 'landscape',
    revealSeconds: 0,
    reveal: 1,
    collagePieces: 8,
    collageBorder: 10,
    collageRotate: 0.07,
    collageTape: true,
    collagePin: true,
    collageMarker: true,
  },
};

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
  const root = await mkdtemp(join(tmpdir(), 'viscraft-paint-'));
  await copyFile(PAINT_HTML, join(root, ENTRY));
  await copyFile(PAINT_MJS, join(root, 'paint-material.mjs'));
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
  params: PaintParams,
  bindings: Record<string, { id: string; url: string; sha256: string }>,
): Record<string, unknown> {
  return { frame, time: frame / FPS, fps: FPS, width, height, seed, params, bindings };
}

// ---------------------------------------------------------------------------
// Pure helpers: the mechanism contract, deterministic by construction.
// ---------------------------------------------------------------------------
test('paint module: modes, seeded PRNG, geometry determinism and loud validation', () => {
  assert.deepEqual(paint.PAINT_MODES, ['wash', 'brush', 'collage']);
  assert.deepEqual(paint.PAINT_SUBJECTS, ['landscape', 'still']);

  const defaults = paint.normalizeParams({});
  assert.equal(defaults.mode, 'wash');
  assert.equal(defaults.subject, 'landscape');
  assert.equal(defaults.washLayers, 6);
  assert.throws(() => paint.normalizeParams({ mode: 'oil' }), /unknown mode/);
  assert.throws(() => paint.normalizeParams({ subject: 'portrait' }), /unknown subject/);
  assert.throws(() => paint.normalizeParams({ reveal: 2 }), /reveal/);
  assert.throws(() => paint.normalizeParams({ palette: { ink: 'black' } }), /palette\.ink/);
  assert.throws(() => paint.normalizeParams({ washLayers: 0 }), /washLayers/);
  assert.throws(() => paint.normalizeParams({ collageTape: 'yes' }), /collageTape/);

  // The seeded PRNG is deterministic and seed-sensitive.
  const a = paint.mulberry32(123);
  const b = paint.mulberry32(123);
  const c = paint.mulberry32(124);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  const seqC = [c(), c(), c()];
  assert.deepEqual(seqA, seqB, 'the same seed yields the same sequence');
  assert.notDeepEqual(seqA, seqC, 'a different seed yields a different sequence');
  for (const v of seqA) assert.ok(v >= 0 && v < 1, 'PRNG output stays in [0,1)');

  // Perlin noise is finite, bounded and deterministic.
  const n1 = paint.noise2(3.2, 7.9);
  assert.ok(Number.isFinite(n1) && Math.abs(n1) <= 1.5);
  assert.equal(paint.noise2(3.2, 7.9), n1);

  // Geometry is pure: the same rng seed gives byte-identical point lists.
  const square: Array<[number, number]> = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  assert.deepEqual(paint.deform(square, 2, 5, paint.mulberry32(9)), paint.deform(square, 2, 5, paint.mulberry32(9)));
  const cutA = paint.cutPolygon(square, paint.mulberry32(4), 6, 2);
  const cutB = paint.cutPolygon(square, paint.mulberry32(4), 6, 2);
  assert.deepEqual(cutA, cutB);
  assert.ok(cutA.length >= square.length, 'a cut polygon is resampled, not dropped');

  // reveal: a fixed `reveal` when not animating; a time ramp when it is.
  assert.equal(paint.resolveReveal({ reveal: 0.4, revealSeconds: 0 }, 99), 0.4);
  assert.equal(paint.resolveReveal({ reveal: 1, revealSeconds: 2 }, 0), 0);
  assert.equal(paint.resolveReveal({ reveal: 1, revealSeconds: 2 }, 2), 1);
  assert.ok(paint.resolveReveal({ reveal: 1, revealSeconds: 2 }, 1) > 0.4);

  // The composition is a real scene with roles, and is stable.
  const scene = paint.baseComposition('landscape', 320, 180, paint.DEFAULT_PALETTE);
  assert.ok(scene.shapes.length >= 4);
  const roles = new Set(scene.shapes.map(s => s.role));
  assert.ok(roles.has('backdrop') && roles.has('subject'));
  for (const s of scene.shapes) for (const p of s.points) assert.ok(Number.isFinite(p[0]) && Number.isFinite(p[1]));

  // Stroke / piece specs are pure, deterministic and non-empty.
  const params = paint.normalizeParams({ mode: 'brush', inkStrokes: 8 });
  const strokesA = paint.inkStrokes(scene, params, paint.mulberry32(50));
  const strokesB = paint.inkStrokes(scene, params, paint.mulberry32(50));
  assert.ok(strokesA.length > 0);
  assert.deepEqual(strokesA, strokesB, 'stroke layout is a pure function of the seed');
  const piecesA = paint.collagePieces(
    scene,
    paint.normalizeParams({ mode: 'collage', collagePieces: 8 }),
    paint.mulberry32(60),
  );
  assert.ok(piecesA.length > 0);
  assert.deepEqual(
    piecesA,
    paint.collagePieces(scene, paint.normalizeParams({ mode: 'collage', collagePieces: 8 }), paint.mulberry32(60)),
  );
});

// ---------------------------------------------------------------------------
// create.mjs: byte-for-byte vendoring, real Asset registration, real Build.
// ---------------------------------------------------------------------------
test('create.mjs vendors the module verbatim, registers code Assets and builds with the real Runtime', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-paint-create-'));
  const root = join(parent, 'study');
  try {
    // Run a copy of the study outside the repository. The study owns its module
    // and scene; the running Runtime still supplies validation and the notice.
    const detached = join(parent, 'skill-copy', 'paint-material');
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
      sources: Array<{ entry: string; resources: string[]; params: { mode: string } }>;
      assets: Array<{
        id: string;
        path: string;
        type: string;
        sha256: string;
        rights: { license: string; redistributable: boolean };
      }>;
      handoff: Array<{ path: string; role: string }>;
      composition?: { audio?: unknown[] };
    };
    assert.deepEqual(project.composition?.audio, [], 'a purely visual reference authors no default audio bed');
    assert.equal(project.sources.length, 3);
    assert.deepEqual(project.sources.map(s => s.params.mode).sort(), [...MODES].sort());
    for (const source of project.sources) assert.deepEqual(source.resources, RESOURCES);

    // The vendored working copies must be byte-identical to the Runtime module,
    // and the registered Asset hash must be the real sha256 of those bytes.
    const moduleBytes = await readFile(join(root, 'paint-material.mjs'));
    const entryBytes = await readFile(join(root, ENTRY));
    assert.equal(
      sha256(moduleBytes),
      sha256(await readFile(PAINT_MJS)),
      'paint-material.mjs is vendored byte-for-byte',
    );
    assert.equal(sha256(entryBytes), sha256(await readFile(PAINT_HTML)), 'paint-scene.html is vendored byte-for-byte');

    const moduleAsset = project.assets.find(a => a.id === 'paint_module');
    assert.ok(
      moduleAsset && moduleAsset.type === 'code' && moduleAsset.sha256 === sha256(moduleBytes),
      'the module is a code Asset with its real hash',
    );
    assert.equal(moduleAsset.path, 'paint-material.mjs', 'the Asset is the file the Source reads, not a second copy');
    assert.equal(
      moduleAsset.rights.license,
      'Apache-2.0 AND MIT',
      'the adapted module retains its MIT origin alongside Apache-2.0',
    );
    assert.equal(moduleAsset.rights.redistributable, true);
    assert.match(moduleAsset.rights.license, /MIT/);
    for (const source of project.sources) {
      assert.equal(source.entry, ENTRY);
      assert.deepEqual(source.resources, RESOURCES);
      assert.ok(MODES.includes(source.params.mode));
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
// Cold start: real, non-blank frames for ALL THREE modes; the reveal advances.
// ---------------------------------------------------------------------------
test('a cold start renders real frames for every mode and the reveal advances across frames', async () => {
  const root = await authorFixture();
  const size = { width: 160, height: 90 };
  try {
    const destination = await mkdtemp(join(tmpdir(), 'viscraft-paint-start-'));
    try {
      const scene = await openCodeScene(root, { entry: ENTRY, resources: RESOURCES }, size, {
        label: 'captureCode',
        globalName: 'viscraft',
      });
      try {
        for (const mode of MODES) {
          // A short reveal window so the handful of sampled frames differ
          // meaningfully (the reveal is a pure ramp over virtual time).
          const animated: PaintParams = { ...MODE_PARAMS[mode], reveal: 1, revealSeconds: 0.2 };
          const hashes = new Set<string>();
          for (let frame = 0; frame < 4; frame++) {
            const file = join(destination, `${mode}-${frame}.png`);
            await renderTo(scene, frameArgs(frame, size.width, size.height, 900, animated, scene.bindings), file);
            const pixels = rgbPixels(file);
            assert.equal(pixels.length, size.width * size.height * 3, `${mode} frame ${frame} decoded`);
            assert.ok(
              countNonBackground(pixels, PAPER) > size.width * size.height * 0.2,
              `${mode} frame ${frame} paints a real picture`,
            );
            hashes.add(sha256(await readFile(file)));
          }
          assert.ok(hashes.size > 1, `${mode} advances across frames as it reveals`);
        }
      } finally {
        await scene.close();
      }
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Determinism, no flicker, and the optional boiling-line clock.
// ---------------------------------------------------------------------------
test('rendering is deterministic, flicker-free on a still Look, and boiling lines track virtual time', async () => {
  const root = await authorFixture();
  const size = { width: 160, height: 90 };
  try {
    const scene = await openCodeScene(root, { entry: ENTRY, resources: RESOURCES }, size, {
      label: 'captureCode',
      globalName: 'viscraft',
    });
    try {
      const args = (frame: number, params: PaintParams) =>
        frameArgs(frame, size.width, size.height, 5, params, scene.bindings);

      // (1) The same frame rendered twice is byte-identical.
      const first = await renderToBuffer(scene, args(3, MODE_PARAMS.wash));
      const again = await renderToBuffer(scene, args(3, MODE_PARAMS.wash));
      assert.ok(first.equals(again), 'the same frame is byte-identical on repeat');

      // (2) Shuffled-order sampling matches ordered sampling per frame.
      for (const mode of MODES) {
        const ordered: Buffer[] = [];
        for (const frame of [0, 1, 2]) ordered.push(await renderToBuffer(scene, args(frame, MODE_PARAMS[mode])));
        const order = [2, 0, 1];
        for (const frame of order) {
          const buffer = await renderToBuffer(scene, args(frame, MODE_PARAMS[mode]));
          assert.ok(buffer.equals(ordered[frame]), `${mode} frame ${frame} is independent of sampling order`);
        }
      }

      // (3) No flicker: a still Look (fixed reveal, boiling off) is byte-identical
      // across adjacent frames.
      for (const mode of MODES) {
        const stillA = await renderToBuffer(scene, args(0, MODE_PARAMS[mode]));
        const stillB = await renderToBuffer(scene, args(1, MODE_PARAMS[mode]));
        assert.ok(stillA.equals(stillB), `${mode} does not flicker when the Look is still`);
      }

      // (4) The optional boiling line is a pure function of the capture's
      // virtual time: off by default, and it changes the picture when enabled.
      const boiling: PaintParams = { ...MODE_PARAMS.brush, inkStrokes: 12, boilFps: 12 };
      const b0 = await renderToBuffer(scene, args(0, boiling)); // t = 0    -> step 0
      const b6 = await renderToBuffer(scene, args(6, boiling)); // t = 0.25 -> step 3
      assert.ok(!b0.equals(b6), 'a boiling line re-seeds on the virtual-time clock');
      const b0Again = await renderToBuffer(scene, args(0, boiling));
      assert.ok(b0.equals(b0Again), 'the boiling line is reproducible for the same frame');
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
    const resources = [...RESOURCES, 'paint-brushes.mjs'];
    await assert.rejects(
      openCodeScene(
        root,
        { entry: ENTRY, resources },
        { width: 64, height: 64 },
        { label: 'captureCode', globalName: 'viscraft' },
      ),
      (error: unknown) => /paint-brushes\.mjs|ENOENT|no such file/i.test(String((error as Error)?.message ?? error)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
