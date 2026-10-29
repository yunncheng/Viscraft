/**
 * E2E: the reusable dark-studio glass-product author module.
 *
 * Proves, with the REAL browser capture path, that:
 *  - the module's pure helpers behave (param validation, beat mapping, seeded
 *    hash, deterministic explode tilts) — fast, no browser;
 *  - `create.mjs` vendors the module AND the pinned `three@0.186.1` closure
 *    byte-for-byte (real sha256), registers them as `code` Assets with MIT
 *    rights, authors a `browser` picture Source that declares the closure in
 *    `resources`, and BUILDS with the real Runtime;
 *  - a cold start renders real, non-blank frames that advance across the beats,
 *    at a real page size;
 *  - rendering is deterministic and order-independent: the same frame twice is
 *    byte-identical, and shuffled-order sampling matches ordered sampling.
 *
 * The module is plain ESM with only dynamic engine imports, so the pure tests
 * import it directly in Node; the frame tests only render small frames to stay
 * fast.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { openCodeScene } from '../src/backends/browser/capture.js';
import { buildProject } from '../src/build/build.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { authorRecipe } from './authoring-helpers.js';

// The implementation bytes live in the reference study; the test reads the SAME
// pin table the recipe declares (no second copy of the digests).
const MODULE_DIR = resolve('skills/viscraft/assets/studies/code-visuals/glass-product');
const RECIPE_DIR = MODULE_DIR;
const GP_MJS = join(MODULE_DIR, 'glass-product.mjs');
const GP_HTML = join(RECIPE_DIR, 'glass-product-scene.html');
const ENTRY = 'glass-product-scene.html';
// Observable pins for the adopted three@0.186.1 core files, read from the SAME
// declaration the recipe uses (never a second digest table).
const THREE_MODULE_URL = pathToFileURL(
  resolve('skills/viscraft/assets/studies/code-visuals/glass-product/three-files.mjs'),
).href;
const { THREE_GLASS_PRODUCT } = (await import(THREE_MODULE_URL)) as {
  THREE_GLASS_PRODUCT: Array<{ source: string; dest: string; sha256: string }>;
};
const THREE_PINS: Record<string, string> = Object.fromEntries(
  THREE_GLASS_PRODUCT.filter(
    pin =>
      pin.dest === 'vendor/three.module.js' || pin.dest === 'vendor/three.core.js' || pin.dest === 'vendor/LICENSE',
  ).map(pin => [pin.dest, pin.sha256]),
);

interface GlassModule {
  PRODUCT: string;
  ACCENT: { a: string; b: string };
  BEATS: Array<{ name: string; from: number; to: number }>;
  DEFAULT_PARAMS: Record<string, unknown>;
  BUD_PARTS: unknown[];
  BUD_CRADLES: unknown[];
  normalizeParams(raw?: Record<string, unknown>): {
    duration: number;
    product: string;
    accentA: string;
    accentB: string;
    bloom: number;
    exposure: number;
    orbit: number;
    explode: number;
    pulse: number;
  };
  beatAt(x: number): { name: string; u: number; from: number; to: number };
  hash01(n: number): number;
  explodeTilt(index: number): { x: number; z: number };
  clamp(x: number, a?: number, b?: number): number;
  lerp(a: number, b: number, t: number): number;
  seg(t: number, a: number, b: number): number;
}

const gp = (await import(pathToFileURL(GP_MJS).href)) as GlassModule;

const FPS = 24;
const DURATION = 4;

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

/** Count pixels clearly distinct from the black studio backdrop. */
function countNonBackground(pixels: Buffer): number {
  let count = 0;
  for (let i = 0; i < pixels.length; i += 3) {
    if (pixels[i] > 12 || pixels[i + 1] > 12 || pixels[i + 2] > 12) count++;
  }
  return count;
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

async function renderTo(
  scene: Awaited<ReturnType<typeof openCodeScene>>,
  args: Record<string, unknown>,
  destination: string,
): Promise<Buffer> {
  await scene.page.evaluate(async payload => {
    const v = (globalThis as unknown as Record<string, { render: (a: unknown) => Promise<void> | void }>)['viscraft'];
    await v.render(payload);
  }, args);
  return Buffer.from(
    (await scene.page.screenshot({ path: destination, type: 'png', captureBeyondViewport: false })) as Uint8Array,
  );
}

// ---------------------------------------------------------------------------
// Pure helpers: validation, beats and deterministic offsets.
// ---------------------------------------------------------------------------
test('glass-product module: params, beats and exploded offsets are correct and pure', () => {
  assert.equal(gp.PRODUCT, 'LUMEN');
  assert.deepEqual(
    gp.BEATS.map(b => b.name),
    ['reveal', 'open', 'macro', 'explode', 'hero'],
  );
  assert.equal(gp.BUD_PARTS.length, 10);
  assert.equal(gp.BUD_CRADLES.length, 2);

  const defaults = gp.normalizeParams({});
  assert.equal(defaults.duration, 4);
  assert.equal(defaults.product, 'LUMEN');
  assert.equal(defaults.pulse, 1);
  assert.throws(() => gp.normalizeParams({ duration: 0 }), /duration/);
  assert.throws(() => gp.normalizeParams({ bloom: -1 }), /bloom/);
  assert.throws(() => gp.normalizeParams({ accentA: 'red' }), /accentA/);
  assert.throws(() => gp.normalizeParams([] as unknown as Record<string, unknown>), /params must be an object/);

  // Beats cover the whole [0,1] line and step in order.
  assert.equal(gp.beatAt(0).name, 'reveal');
  assert.equal(gp.beatAt(0.3).name, 'open');
  assert.equal(gp.beatAt(0.5).name, 'macro');
  assert.equal(gp.beatAt(0.7).name, 'explode');
  assert.equal(gp.beatAt(0.99).name, 'hero');
  assert.equal(gp.beatAt(1).name, 'hero');
  for (const b of gp.BEATS) assert.ok(gp.beatAt(b.from + 1e-6).name === b.name);

  // Deterministic, unseeded-free helpers.
  for (let i = 0; i < 5; i++) assert.equal(gp.hash01(i), gp.hash01(i));
  assert.notEqual(gp.hash01(1), gp.hash01(2));
  assert.deepEqual(gp.explodeTilt(4), gp.explodeTilt(4));
  assert.notDeepEqual(gp.explodeTilt(4), gp.explodeTilt(5));

  assert.equal(gp.clamp(2, 0, 1), 1);
  assert.equal(gp.lerp(0, 10, 0.5), 5);
  assert.equal(gp.seg(5, 0, 10), 0.5);
});

// ---------------------------------------------------------------------------
// create.mjs: byte-for-byte vendoring of the module AND the three closure,
// real Asset registration, and a real Build.
// ---------------------------------------------------------------------------
test('create.mjs vendors the module and the pinned three closure verbatim, registers code Assets and builds', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-glass-create-'));
  const root = join(parent, 'study');
  try {
    await authorRecipe({
      recipe: join(RECIPE_DIR, 'create.mjs'),
      root,
      cwd: parent,
      options: { width: 128, height: 72, frames: 4 },
    });
    const built = await buildProject(root);
    assert.equal(built.status, 'succeeded', `the generated Project must build: ${built.error ?? ''}`);

    // The module files are vendored byte-for-byte from the Runtime.
    assert.equal(
      sha256(await readFile(join(root, 'glass-product.mjs'))),
      sha256(await readFile(GP_MJS)),
      'glass-product.mjs is vendored byte-for-byte',
    );
    assert.equal(
      sha256(await readFile(join(root, ENTRY))),
      sha256(await readFile(GP_HTML)),
      `${ENTRY} is vendored byte-for-byte`,
    );

    const project = JSON.parse(await readFile(join(root, 'project.json'), 'utf8')) as {
      assets: Array<{
        id: string;
        path: string;
        type: string;
        sha256: string;
        rights: { origin: string; license: string; redistributable: boolean };
      }>;
      sources: Array<{ kind: string; output: string; entry: string; resources: string[] }>;
      handoff: Array<{ path: string; role: string }>;
      composition?: { audio?: unknown[] };
    };
    assert.deepEqual(project.composition?.audio, [], 'a purely visual reference authors no default audio bed');

    // Every pinned three core file is vendored byte-for-byte and registered.
    assert.ok(
      project.assets.filter(asset => asset.path.startsWith('vendor/')).length >= 15,
      'the vendored three closure carries the core build, LICENSE and the addon set',
    );
    for (const [relative, pinned] of Object.entries(THREE_PINS)) {
      assert.equal(sha256(await readFile(join(root, relative))), pinned, `${relative} matches its pinned sha256`);
      const asset = project.assets.find(candidate => candidate.path === relative);
      assert.ok(asset, `${relative} is a registered Asset`);
      assert.equal(asset.sha256, pinned);
    }

    const moduleAsset = project.assets.find(a => a.id === 'glass_module');
    assert.ok(moduleAsset && moduleAsset.type === 'code', 'the Look module is a code Asset');
    assert.equal(moduleAsset.path, 'glass-product.mjs', 'the Asset is the file the Source reads, not a second copy');
    assert.equal(
      moduleAsset.sha256,
      sha256(await readFile(join(root, 'glass-product.mjs'))),
      'the Asset hash is the real sha256',
    );
    assert.equal(
      moduleAsset.rights.license,
      'Apache-2.0 AND MIT',
      'Apache contributions retain the upstream MIT terms',
    );
    assert.equal(moduleAsset.rights.redistributable, true);
    assert.match(moduleAsset.rights.origin, /lemo-opuscar/, 'the module records its upstream origin');

    const threeAssets = project.assets.filter(a => a.path.startsWith('vendor/'));
    assert.ok(threeAssets.length >= 15, 'the vendored engine files are registered as Assets');
    for (const asset of threeAssets) {
      assert.equal(asset.type, 'code');
      assert.equal(asset.rights.license, 'MIT', 'vendored three carries three.js MIT rights');
      assert.equal(asset.rights.redistributable, true);
    }

    assert.equal(project.sources.length, 1);
    const source = project.sources[0]!;
    assert.equal(source.kind, 'browser');
    assert.equal(source.output, 'picture');
    assert.equal(source.entry, ENTRY);
    assert.ok(source.resources.includes('glass-product.mjs'), 'the module is a declared resource');
    for (const asset of threeAssets) {
      assert.ok(source.resources.includes(asset.path), `${asset.path} is a declared resource`);
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
      [
        { path: 'THIRD_PARTY_NOTICES.md', role: 'license' },
        { path: 'LICENSES.md', role: 'license' },
      ],
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
// A reference copy installed apart from the Runtime resolves `three` from the
// RUNNING Runtime's install, never from its own location, and the authored
// Project keeps building after the reference copy is moved away.
// ---------------------------------------------------------------------------
test('create.mjs resolves three from the running Runtime when no node_modules sits beside the reference', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-glass-detached-'));
  const detached = join(parent, 'skill-copy', 'glass-product');
  const root = join(parent, 'study');
  try {
    await cp(RECIPE_DIR, detached, { recursive: true });
    // The copied Skill must sit apart from any installed dependency.
    assert.equal(existsSync(join(detached, 'node_modules')), false, 'the Skill copy carries no node_modules');
    assert.equal(existsSync(join(parent, 'node_modules')), false, 'no node_modules beside the Skill copy');

    await authorRecipe({
      recipe: join(detached, 'create.mjs'),
      root,
      cwd: parent,
      options: { frames: 3 },
    });
    const project = JSON.parse(await readFile(join(root, 'project.json'), 'utf8')) as {
      assets: Array<{ path: string; sha256: string }>;
      handoff: Array<{ path: string; role: string }>;
    };
    const vendored = project.assets.filter(asset => asset.path.startsWith('vendor/'));
    assert.ok(vendored.length >= 15, 'the whole pinned three closure is vendored');
    for (const [relative, pinned] of Object.entries(THREE_PINS)) {
      assert.equal(sha256(await readFile(join(root, relative))), pinned, `${relative} matches its pinned sha256`);
    }

    // The Project owns its closure: move the whole reference copy aside, then
    // build and export from the authored Project alone.
    await rename(detached, `${detached}-aside`);
    assert.equal(existsSync(detached), false, 'the reference copy is unavailable');
    const built = await buildProject(root);
    assert.equal(built.status, 'succeeded', `the detached-created Project must build: ${built.error ?? ''}`);
    const exportedPath = join(parent, 'exported');
    const exported = await exportProject(root, exportedPath);
    assert.ok(exported.files >= 15, 'the export carries the authored closure');
    for (const [relative, pinned] of Object.entries(THREE_PINS)) {
      assert.equal(sha256(await readFile(join(exportedPath, relative))), pinned, `${relative} travels with the export`);
    }
    assert.equal(existsSync(join(exportedPath, 'THIRD_PARTY_NOTICES.md')), true, 'the licence notice travels');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The declared pins are enforced BEFORE writing: a missing addon or a tampered
// file refuses the whole authoring run and leaves no Project directory.
// ---------------------------------------------------------------------------
async function threePackageRoot(): Promise<string> {
  const require = createRequire(import.meta.url);
  const entry = require.resolve('three');
  for (let dir = dirname(entry); ; dir = dirname(dir)) {
    try {
      if ((JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { name?: string }).name === 'three')
        return dir;
    } catch {
      // keep walking
    }
    if (dirname(dir) === dir) throw new Error('could not locate the installed three package');
  }
}

async function pinnedDonor(target: string): Promise<void> {
  const source = await threePackageRoot();
  for (const pin of THREE_GLASS_PRODUCT) {
    const from = join(source, ...pin.source.split('/'));
    const to = join(target, ...pin.source.split('/'));
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
  }
}

test('a missing or tampered pinned three file refuses authoring before any Project is written', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-glass-pins-'));
  const donor = join(parent, 'three-donor');
  try {
    await pinnedDonor(donor);

    // 1. A missing addon is a loud error, not a fallback/download.
    const missing = join(donor, 'examples', 'jsm', 'shaders', 'OutputShader.js');
    const missingBytes = await readFile(missing);
    await unlink(missing);
    const absentRoot = join(parent, 'missing-project');
    await assert.rejects(
      () =>
        authorRecipe({
          recipe: join(RECIPE_DIR, 'create.mjs'),
          root: absentRoot,
          cwd: parent,
          options: { frames: 2, three: donor },
        }),
      /not a regular file|ENOENT|no such file/i,
      'a missing pinned file must refuse the run',
    );
    assert.equal(existsSync(absentRoot), false, 'no partial Project directory is created');
    await writeFile(missing, missingBytes);

    // 2. A tampered addon fails its recorded sha256 before writing.
    const tampered = join(donor, 'examples', 'jsm', 'objects', 'Reflector.js');
    await writeFile(tampered, `${await readFile(tampered, 'utf8')}\n// tampered\n`);
    const tamperedRoot = join(parent, 'tampered-project');
    await assert.rejects(
      () =>
        authorRecipe({
          recipe: join(RECIPE_DIR, 'create.mjs'),
          root: tamperedRoot,
          cwd: parent,
          options: { frames: 2, three: donor },
        }),
      /expectedSha256|does not match/i,
      'a drifted pinned file must refuse the run',
    );
    assert.equal(existsSync(tamperedRoot), false, 'no partial Project directory is created');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Cold start: real, advancing, non-blank frames; deterministic and order-free.
// ---------------------------------------------------------------------------
test('a cold start renders real advancing frames, deterministically and order-independently', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-glass-frames-'));
  const root = join(parent, 'study');
  const out = join(parent, 'frames');
  try {
    await authorRecipe({
      recipe: join(RECIPE_DIR, 'create.mjs'),
      root,
      cwd: parent,
      options: { width: 320, height: 180, frames: 96 },
    });
    await mkdir(out, { recursive: true });
    const project = JSON.parse(await readFile(join(root, 'project.json'), 'utf8')) as {
      sources: Array<{ entry: string; resources: string[]; params: Record<string, unknown>; seed: number }>;
    };
    const source = project.sources[0];
    const size = { width: 320, height: 180 };
    const params = { ...source.params, duration: DURATION };

    const scene = await openCodeScene(root, { entry: source.entry, resources: source.resources }, size, {
      label: 'captureCode',
      globalName: 'viscraft',
    });
    try {
      const args = (frame: number) => frameArgs(frame, size.width, size.height, source.seed, params, scene.bindings);

      // One frame per beat across the piece: reveal / open / macro / explode / hero.
      const sampled = [0, 12, 24, 36, 48, 60, 72, 84, 95];
      const hashes = new Set<string>();
      let litFrames = 0;
      for (const frame of sampled) {
        const file = join(out, `f${String(frame).padStart(3, '0')}.png`);
        await renderTo(scene, args(frame), file);
        const pixels = rgbPixels(file);
        assert.equal(pixels.length, size.width * size.height * 3, `frame ${frame} decoded`);
        let brightest = 0;
        for (const value of pixels) if (value > brightest) brightest = value;
        assert.ok(brightest > 24, `frame ${frame} is not a blank black frame`);
        if (countNonBackground(pixels) > size.width * size.height * 0.01) litFrames += 1;
        hashes.add(sha256(await readFile(file)));
      }
      assert.ok(litFrames >= 4, `the beats draw real product geometry (${litFrames} of ${sampled.length} lit)`);
      assert.ok(hashes.size >= 5, `frames advance across the piece (${hashes.size} distinct of ${sampled.length})`);

      // Determinism: the same frame rendered twice is byte-identical.
      const a = await renderTo(scene, args(48), join(out, 'a.png'));
      const b = await renderTo(scene, args(48), join(out, 'b.png'));
      assert.ok(a.equals(b), 'the same frame is byte-identical on repeat');

      // Order independence: shuffled sampling matches ordered sampling per frame.
      const ordered = [24, 48, 72];
      const first: Buffer[] = [];
      for (const frame of ordered) first.push(await renderTo(scene, args(frame), join(out, `o${frame}.png`)));
      const shuffled = [72, 24, 48];
      for (const frame of shuffled) {
        const buffer = await renderTo(scene, args(frame), join(out, `s${frame}.png`));
        assert.ok(buffer.equals(first[ordered.indexOf(frame)]), `frame ${frame} is independent of sampling order`);
      }
    } finally {
      await scene.close();
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
