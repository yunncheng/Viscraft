/**
 * E2E: the reusable cel-layering author module.
 *
 * Proves, with the REAL browser capture path, that:
 *  - the module's pure helpers behave (ordered layer stack, pose quantization,
 *    cached seeded marks, loud param validation) — fast, no browser;
 *  - `create.mjs` vendors its files byte-for-byte, registers them as `code`
 *    Assets with real sha256, authors two `browser` picture Sources and BUILDS with the
 *    real Runtime;
 *  - a cold start renders real frames for BOTH subjects at TWO sizes (16:9 and
 *    9:16);
 *  - rendering is deterministic: the same frame twice is byte-identical, and
 *    shuffled-order sampling matches ordered sampling;
 *  - there is no per-frame flicker: a stationary subject under fixed light is
 *    byte-identical across adjacent frames, while the light (driven by the
 *    actual frame time) and the pose cadence (quantized) each move on their own
 *    schedule;
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

// The module and its scene have one source in the cel-figure fixture.
const MODULE_DIR = resolve('tests/fixtures/authoring/cel-figure');
const RECIPE_DIR = MODULE_DIR;
const CEL_MJS = join(MODULE_DIR, 'cel.mjs');
const CEL_HTML = join(RECIPE_DIR, 'cel-scene.html');
const ENTRY = 'cel-scene.html';
const RESOURCES = ['cel.mjs'];

interface CelParams {
  [key: string]: unknown;
}

interface CelModule {
  CEL_LAYERS: string[];
  SUBJECTS: string[];
  DEFAULT_PALETTE: Record<string, unknown>;
  normalizeParams(raw?: Record<string, unknown>): CelParams & { subject: string; poseRate: number };
  quantizePose(time: number, poseRate: number): number;
  hash01(seed: number, index: number): number;
  staticMarks(seed: number, count: number): Array<{ u: number; v: number }>;
  subjectPose(
    subject: string,
    poseTime: number,
    params: unknown,
    width: number,
    height: number,
  ): { kind: string; probe: Array<{ x: number; y: number }> };
}

const cel = (await import(pathToFileURL(CEL_MJS).href)) as CelModule;

const FPS = 24;
const FIGURE_PARAMS = {
  subject: 'figure',
  poseRate: 24,
  lineWidth: 3.2,
  shadowAzimuth: 2.35,
  shadowLength: 0.95,
  registration: { dx: 0.9, dy: -0.7 },
  lightDrift: 0.25,
  motion: 1,
  speed: 1.15,
  hatchCount: 22,
  palette: {
    bg: '#2b2440',
    base: '#efd9b8',
    shadow: '#8a5a7a',
    shadowOpacity: 0.45,
    highlight: '#fff3d2',
    highlightOpacity: 0.5,
    line: '#221a28',
    ink: '#3a2f45',
  },
};
const VEHICLE_PARAMS = {
  subject: 'vehicle',
  poseRate: 24,
  lineWidth: 3.6,
  shadowAzimuth: 2.15,
  shadowLength: 1.05,
  registration: { dx: 1.1, dy: -0.6 },
  lightDrift: 0.18,
  motion: 1,
  speed: 1.3,
  hatchCount: 26,
  palette: {
    bg: '#12232e',
    base: '#e7c65a',
    shadow: '#7a4a2a',
    shadowOpacity: 0.5,
    highlight: '#fff0b0',
    highlightOpacity: 0.45,
    line: '#0d1a20',
    ink: '#40311a',
  },
};
const PARAMS: Record<string, CelParams> = { figure: FIGURE_PARAMS, vehicle: VEHICLE_PARAMS };

const BG: Record<string, [number, number, number]> = { figure: [43, 36, 64], vehicle: [18, 35, 46] };

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
  const root = await mkdtemp(join(tmpdir(), 'viscraft-cel-'));
  await copyFile(CEL_HTML, join(root, ENTRY));
  await copyFile(CEL_MJS, join(root, 'cel.mjs'));
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
  params: CelParams,
  bindings: Record<string, { id: string; url: string; sha256: string }>,
): Record<string, unknown> {
  return { frame, time: frame / FPS, fps: FPS, width, height, seed, params, bindings };
}

// ---------------------------------------------------------------------------
// Pure helpers: the Look's mechanism, ordered stack and determinism contract.
// ---------------------------------------------------------------------------
test('cel module: the ordered layer stack, pose cadence and cached marks are correct', () => {
  assert.deepEqual(cel.CEL_LAYERS, ['base', 'shadow', 'highlight', 'line']);
  assert.deepEqual(cel.SUBJECTS, ['figure', 'vehicle']);

  const defaults = cel.normalizeParams({});
  assert.equal(defaults.subject, 'figure');
  assert.equal(defaults.poseRate, 8);
  assert.throws(() => cel.normalizeParams({ subject: 'dragon' }), /unknown subject/);
  assert.throws(() => cel.normalizeParams({ poseRate: 0 }), /poseRate/);
  assert.throws(() => cel.normalizeParams({ palette: { base: 'red' } }), /palette\.base/);
  assert.throws(() => cel.normalizeParams({ registration: 4 }), /registration/);

  // Cel cadence holds the pose inside a window and steps across windows.
  assert.equal(cel.quantizePose(0, 4), 0);
  assert.equal(cel.quantizePose(0.24, 4), 0);
  assert.equal(cel.quantizePose(0.25, 4), 0.25);
  assert.equal(cel.quantizePose(0.99, 4), 0.75);
  assert.throws(() => cel.quantizePose(1, 0), /poseRate/);

  // Static marks are keyed by (seed, index) and cached — computed once.
  const first = cel.staticMarks(7, 12);
  const second = cel.staticMarks(7, 12);
  assert.equal(first, second, 'mark placement is cached, never re-rolled');
  assert.equal(first.length, 12);
  assert.notDeepEqual(cel.staticMarks(8, 12), first, 'a different seed lays out different marks');
  for (let i = 0; i < 5; i++) assert.equal(cel.hash01(3, i), cel.hash01(3, i));

  // Two genuinely different subjects from the same module.
  const fig = cel.subjectPose('figure', 0.3, cel.normalizeParams({ subject: 'figure' }), 160, 90);
  const veh = cel.subjectPose('vehicle', 0.3, cel.normalizeParams({ subject: 'vehicle' }), 160, 90);
  assert.equal(fig.kind, 'figure');
  assert.equal(veh.kind, 'vehicle');
  for (const pose of [fig, veh]) for (const p of pose.probe) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  assert.throws(() => cel.subjectPose('figure', Number.NaN, cel.normalizeParams({}), 160, 90), /poseTime/);
});

// ---------------------------------------------------------------------------
// create.mjs: byte-for-byte vendoring, real Asset registration, real Build.
// ---------------------------------------------------------------------------
test('create.mjs vendors the module verbatim, registers code Assets and builds with the real Runtime', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-cel-create-'));
  const root = join(parent, 'study');
  try {
    // Run a copy of the study outside the repository. The study owns its module
    // and scene; the running Runtime still supplies validation and the notice.
    const detached = join(parent, 'fixture-copy', 'cel-figure');
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
      assets: Array<{ id: string; path: string; type: string; sha256: string; rights: { license: string } }>;
      handoff: Array<{ path: string; role: string }>;
      composition?: { audio?: unknown[] };
    };
    assert.deepEqual(project.composition?.audio, [], 'a purely visual reference authors no default audio bed');
    assert.equal(project.sources.length, 2);
    assert.deepEqual(project.sources.map(s => s.params.subject).sort(), ['figure', 'vehicle']);
    for (const source of project.sources) assert.deepEqual(source.resources, RESOURCES);

    // The vendored working copies must be byte-identical to the Runtime module,
    // and the registered Asset hash must be the real sha256 of those bytes.
    const moduleBytes = await readFile(join(root, 'cel.mjs'));
    const entryBytes = await readFile(join(root, ENTRY));
    assert.equal(sha256(moduleBytes), sha256(await readFile(CEL_MJS)), 'cel.mjs is vendored byte-for-byte');
    assert.equal(sha256(entryBytes), sha256(await readFile(CEL_HTML)), 'cel-scene.html is vendored byte-for-byte');

    const moduleAsset = project.assets.find(a => a.id === 'cel_module');
    assert.ok(
      moduleAsset && moduleAsset.type === 'code' && moduleAsset.sha256 === sha256(moduleBytes),
      'the module is a code Asset with its real hash',
    );
    assert.equal(moduleAsset.path, 'cel.mjs', 'the Asset is the file the Source reads, not a second copy');
    assert.equal(moduleAsset.rights.license, 'CC0-1.0', 'the original module keeps its CC0 rights');
    for (const source of project.sources) {
      assert.equal(source.entry, ENTRY);
      assert.deepEqual(source.resources, RESOURCES);
      assert.ok(['figure', 'vehicle'].includes(source.params.subject));
    }
    // The licence text is a handoff file, not a fabricated Asset.
    assert.deepEqual(project.handoff, [{ path: 'THIRD_PARTY_NOTICES.md', role: 'license' }]);
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
      const destination = await mkdtemp(join(tmpdir(), 'viscraft-cel-start-'));
      try {
        const scene = await openCodeScene(root, { entry: ENTRY, resources: RESOURCES }, size, {
          label: 'captureCode',
          globalName: 'viscraft',
        });
        try {
          for (const subject of ['figure', 'vehicle']) {
            const hashes = new Set<string>();
            for (let frame = 0; frame < 3; frame++) {
              const file = join(destination, `${subject}-${size.width}x${size.height}-${frame}.png`);
              await renderTo(
                scene,
                frameArgs(
                  frame,
                  size.width,
                  size.height,
                  subject === 'figure' ? 11 : 22,
                  PARAMS[subject],
                  scene.bindings,
                ),
                file,
              );
              const pixels = rgbPixels(file);
              assert.equal(pixels.length, size.width * size.height * 3, `${subject} frame ${frame} decoded`);
              assert.ok(
                countNonBackground(pixels, BG[subject]) > size.width * size.height * 0.05,
                `${subject} @ ${size.width}x${size.height} draws a real subject`,
              );
              hashes.add(sha256(await readFile(file)));
            }
            assert.equal(hashes.size, 3, `${subject} @ ${size.width}x${size.height} advances across frames`);
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
// Determinism, no flicker, and the separate pose / light clocks.
// ---------------------------------------------------------------------------
test('rendering is deterministic, flicker-free on a static pose, and pose/light use separate clocks', async () => {
  const root = await authorFixture();
  const size = { width: 160, height: 90 };
  try {
    const scene = await openCodeScene(root, { entry: ENTRY, resources: RESOURCES }, size, {
      label: 'captureCode',
      globalName: 'viscraft',
    });
    try {
      const args = (frame: number, params: CelParams) =>
        frameArgs(frame, size.width, size.height, 5, params, scene.bindings);

      // (1) The same frame rendered twice is byte-identical.
      const first = await renderToBuffer(scene, args(3, FIGURE_PARAMS));
      const again = await renderToBuffer(scene, args(3, FIGURE_PARAMS));
      assert.ok(first.equals(again), 'the same frame is byte-identical on repeat');

      // (2) Shuffled-order sampling matches ordered sampling per frame.
      const ordered: Buffer[] = [];
      for (const frame of [0, 1, 2]) ordered.push(await renderToBuffer(scene, args(frame, FIGURE_PARAMS)));
      const shuffled = [2, 0, 1];
      const shuffledBuffers: Buffer[] = [];
      for (const frame of shuffled) shuffledBuffers.push(await renderToBuffer(scene, args(frame, FIGURE_PARAMS)));
      for (let i = 0; i < shuffled.length; i++) {
        assert.ok(
          shuffledBuffers[i].equals(ordered[shuffled[i]]),
          `frame ${shuffled[i]} is independent of sampling order`,
        );
      }

      // (3) No flicker: a stationary subject under fixed light is byte-identical
      // across adjacent frames (the static hatch marks do not re-roll).
      const still = { ...FIGURE_PARAMS, motion: 0, lightDrift: 0 };
      const stillA = await renderToBuffer(scene, args(0, still));
      const stillB = await renderToBuffer(scene, args(1, still));
      assert.ok(stillA.equals(stillB), 'a stationary subject under fixed light does not flicker');

      // (4) The light uses the ACTUAL frame time and is not quantized with the pose.
      const drifting = { ...FIGURE_PARAMS, motion: 0, lightDrift: 0.6 };
      const driftA = await renderToBuffer(scene, args(0, drifting));
      const driftB = await renderToBuffer(scene, args(1, drifting));
      assert.ok(!driftA.equals(driftB), 'light driven by actual time changes between adjacent frames');

      // (5) The pose IS quantized: within one pose window the subject holds even
      // while time advances, and it steps on the next window.
      const quantized = { ...FIGURE_PARAMS, poseRate: 1, lightDrift: 0 };
      const q0 = await renderToBuffer(scene, args(0, quantized)); // t = 0     -> window 0
      const q1 = await renderToBuffer(scene, args(1, quantized)); // t = 1/24  -> window 0
      const q24 = await renderToBuffer(scene, args(24, quantized)); // t = 1    -> window 1
      assert.ok(q0.equals(q1), 'the pose is held inside a cel window');
      assert.ok(!q0.equals(q24), 'the pose steps on the next cel window');
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
    const resources = [...RESOURCES, 'cel-model.mjs'];
    await assert.rejects(
      openCodeScene(
        root,
        { entry: ENTRY, resources },
        { width: 64, height: 64 },
        { label: 'captureCode', globalName: 'viscraft' },
      ),
      (error: unknown) => /cel-model\.mjs|ENOENT|no such file/i.test(String((error as Error)?.message ?? error)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
