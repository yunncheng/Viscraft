/**
 * E2E: the crayon-book reference — a drawn page, wax pressure, and one wash.
 *
 * Proves, with the REAL author/Browser/Build path, that:
 *  - `create.mjs` authors ONE `browser` picture Source with the real motif /
 *    duration / seed params, the three local modules, MIT rights, three licence
 *    handoffs and material sound from shared page actions;
 *  - the page action is actually drawn at the authored key stages (outline,
 *    fill, reach/lift, wash, hold), and the `comet` motif is a different picture
 *    from `star`, not a recolour;
 *  - the exported pure `crayonClocks` separates the continuous camera (a new
 *    value every 24 fps frame) from the 12 fps mark boil (two frames share
 *    `floor(time*12)`, the next pair advances it);
 *  - `ready()` + a full ascending rerun reproduces the same frames (the WebGL2
 *    compositor and layers are persistent, so this is tested by ascending
 *    replay, not by shuffled sampling);
 *  - the authored Project BUILDs, exports, accepts a REAL edit of the exported
 *    module (paper colour), refreshes the code Asset and rebuilds with changed
 *    decoded pixels while the original Project/module/Artifact bytes stay
 *    untouched.
 *
 * Stage samples are 640x360 at 120 frames and map to the actual authored phases.
 * They are engineering proof of the mechanism, not presentation approval of the
 * full 240-frame page.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { openCodeScene } from '../src/backends/browser/capture.js';
import { buildProject } from '../src/build/build.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { deliverProject } from '../src/operations/delivery/delivery.js';
import { verifyDelivery } from '../src/operations/delivery/delivery-verification.js';
import { refreshCodeAsset } from '../src/project/code-assets.js';
import { loadProject } from '../src/project/project.js';
import { authorRecipe, sha256 } from './authoring-helpers.js';

const STUDY_DIR = resolve('skills/viscraft/assets/studies/code-visuals/crayon-book');
const RECIPE = join(STUDY_DIR, 'create.mjs');
const ENTRY = 'crayon-book-scene.html';
const RESOURCES = ['crayon-book.mjs', 'crayon-engine.mjs', 'crayon-gl.mjs', 'action-facts.mjs'];
const WIDTH = 640;
const HEIGHT = 360;
const FPS = 24;

const STAGE_FRAMES = 120; // 5 s: maps every authored phase onto real frame times.
const STAGE_BYTES = WIDTH * HEIGHT * 3;

interface CrayonModule {
  crayonClocks(
    time: number,
    duration?: number,
  ): { time: number; camera: { x: number; y: number; z: number }; boilStep: number };
}

const crayon = (await import(pathToFileURL(join(STUDY_DIR, 'crayon-book.mjs')).href)) as unknown as CrayonModule;

/** Actual authored phase frames at 24 fps (t = frame / frames). */
const KEY = {
  outline: 20, // t = .167, inside outline 0.06–0.30
  outlineEnd: 36, // t = .300
  fill: 60, // t = .500, inside fill 0.32–0.58
  reach: 76, // t = .633, inside reach 0.60–0.68
  lift: 90, // t = .750, inside lift 0.68–0.80
  wash: 102, // t = .850, inside wash 0.76–0.93
  washEnd: 112, // t = .933
  hold: 119, // last frame, settle
};

const BUILD_WIDTH = 320;
const BUILD_HEIGHT = 180;
const BUILD_FRAMES = 96;

function decodeFrames(file: string, count: number): Buffer {
  const result = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostdin', '-i', file, '-frames:v', String(count), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 1 << 27 },
  );
  assert.equal(result.status, 0, `ffmpeg decode failed for ${file}: ${result.stderr?.toString() ?? ''}`);
  return result.stdout;
}

function pngPixels(file: string): Buffer {
  const result = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostdin', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 1 << 25 },
  );
  assert.equal(result.status, 0, `ffmpeg PNG decode failed for ${file}: ${result.stderr?.toString() ?? ''}`);
  return result.stdout;
}

/** Fraction of changed pixels. */
function changedFraction(a: Buffer, b: Buffer): number {
  assert.equal(a.length, b.length, 'compared frames must have the same size');
  let changed = 0;
  for (let i = 0; i < a.length; i += 3) {
    const distance = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (distance > 60) changed++;
  }
  return changed / (a.length / 3);
}

/** Warm crayon fill (yellow/orange), used for the star's position and growth. */
function warmPixels(pixels: Buffer): { count: number; x: number; y: number } {
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const offset = (y * WIDTH + x) * 3;
      if (pixels[offset] > 170 && pixels[offset + 1] > 100 && pixels[offset + 2] < 130) {
        count++;
        sumX += x;
        sumY += y;
      }
    }
  }
  return { count, x: count ? sumX / count : Number.NaN, y: count ? sumY / count : Number.NaN };
}

/** Ultramarine wash coverage: blue-dominant, darker than the paper. */
function washPixels(pixels: Buffer): number {
  let count = 0;
  for (let i = 0; i < pixels.length; i += 3) {
    if (pixels[i + 2] > pixels[i] + 12 && pixels[i + 2] > 70 && pixels[i] < 190) count++;
  }
  return count;
}

/** Visible drawn content (anything clearly off the warm paper). */
function contentPixels(pixels: Buffer): number {
  let count = 0;
  for (let i = 0; i < pixels.length; i += 3) {
    const distance = Math.abs(pixels[i] - 244) + Math.abs(pixels[i + 1] - 239) + Math.abs(pixels[i + 2] - 227);
    if (distance > 70) count++;
  }
  return count;
}

async function renderFrame(
  scene: Awaited<ReturnType<typeof openCodeScene>>,
  frame: number,
  destination: string,
  motif: 'star' | 'comet',
  duration: number,
  seed = 7321,
): Promise<{ png: Buffer; pixels: Buffer }> {
  await renderOnly(scene, frame, motif, duration, seed);
  const file = join(destination, `crayon-${motif}-${frame}.png`);
  await scene.page.screenshot({ path: file, type: 'png', captureBeyondViewport: false });
  return { png: Buffer.from(await readFile(file)), pixels: pngPixels(file) };
}

/** Advance the stateful compositor through one frame without capturing it. */
async function renderOnly(
  scene: Awaited<ReturnType<typeof openCodeScene>>,
  frame: number,
  motif: 'star' | 'comet',
  duration: number,
  seed = 7321,
): Promise<void> {
  await scene.page.evaluate(
    async payload => {
      const v = (globalThis as unknown as Record<string, { render: (a: unknown) => void }>)['viscraft'];
      v.render(payload);
    },
    {
      frame,
      time: frame / FPS,
      fps: FPS,
      width: WIDTH,
      height: HEIGHT,
      seed,
      params: { duration, motif, seed },
      bindings: scene.bindings,
    },
  );
}

// ---------------------------------------------------------------------------
// Author: one page, the motif variant, the real closure and rights.
// ---------------------------------------------------------------------------
test('crayon-book: create.mjs authors one page with the motif variant and licence closure', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-crayon-author-'));
  const starRoot = join(parent, 'star');
  const cometRoot = join(parent, 'comet');
  try {
    await authorRecipe({
      recipe: RECIPE,
      root: starRoot,
      cwd: parent,
      options: { width: 320, height: 180, frames: BUILD_FRAMES, motif: 'star' },
    });
    await authorRecipe({
      recipe: RECIPE,
      root: cometRoot,
      cwd: parent,
      options: { width: 320, height: 180, frames: BUILD_FRAMES, motif: 'comet' },
    });

    const star = await loadProject(starRoot);
    const source = star.sources[0];
    if (!source || source.kind !== 'browser') throw new Error('crayon book must author one browser picture source');
    assert.equal(source.id, 'crayon_page');
    assert.equal(source.output, 'picture');
    assert.equal(source.entry, ENTRY);
    assert.deepEqual(source.resources, RESOURCES);
    assert.equal(source.seed, 7321);
    assert.equal(source.frames, BUILD_FRAMES);
    assert.deepEqual(source.params, { duration: BUILD_FRAMES / FPS, motif: 'star', seed: 7321 });
    assert.equal(star.composition?.audio.length, 1, 'the page has material Foley on its own source');
    const sound = star.sources[1];
    assert.ok(sound.kind === 'browser' && sound.output === 'sound');
    assert.deepEqual(star.assets.map(asset => [asset.id, asset.path, asset.type, asset.rights.license]).sort(), [
      ['crayon_actions', 'action-facts.mjs', 'code', 'Apache-2.0'],
      ['crayon_engine', 'crayon-engine.mjs', 'code', 'Apache-2.0 AND MIT'],
      ['crayon_foley', 'foley.mjs', 'code', 'Apache-2.0 AND MIT'],
      ['crayon_gl', 'crayon-gl.mjs', 'code', 'Apache-2.0 AND MIT'],
      ['crayon_module', 'crayon-book.mjs', 'code', 'Apache-2.0 AND MIT'],
      ['crayon_scene', ENTRY, 'code', 'Apache-2.0'],
      ['crayon_sound_entry', 'crayon-foley.html', 'code', 'Apache-2.0'],
    ]);
    for (const asset of star.assets) {
      assert.equal(asset.sha256, sha256(await readFile(join(starRoot, asset.path))), `${asset.path} hash is real`);
    }
    assert.match(
      String(star.assets.find(asset => asset.id === 'crayon_module')!.rights.origin),
      /LemoLab/i,
      'the adapted mechanism origin is recorded',
    );
    const foleyRights = star.assets.find(asset => asset.id === 'crayon_foley')!.rights;
    assert.equal(foleyRights.author, 'LemoLab');
    assert.match(foleyRights.modifications!, /Original page-action mapping.*The Viscraft Authors/);
    assert.equal(star.assets.find(asset => asset.id === 'crayon_sound_entry')!.rights.author, 'The Viscraft Authors');
    assert.deepEqual((star.handoff ?? []).map(file => [file.path, file.role]).sort(), [
      ['LICENSE-LemoLab-MIT.txt', 'license'],
      ['LICENSES.md', 'license'],
      ['THIRD_PARTY_NOTICES.md', 'license'],
    ]);
    assert.doesNotMatch(JSON.stringify(star), /\/lustre-data\/|\/root\/|\/tmp\//);

    const comet = await loadProject(cometRoot);
    const cometSource = comet.sources[0];
    if (!cometSource || cometSource.kind !== 'browser')
      throw new Error('comet source must be a browser picture source');
    assert.deepEqual(cometSource.params, { duration: BUILD_FRAMES / FPS, motif: 'comet', seed: 7321 });
    assert.equal(cometSource.seed, source.seed, 'the motif is a creative variant, not a seed change');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The exported pure clock: continuous camera, 12 fps mark boil.
// ---------------------------------------------------------------------------
test('crayon-book: crayonClocks separates the continuous camera from the 12 fps mark boil', () => {
  const a = crayon.crayonClocks(100 / 24);
  const b = crayon.crayonClocks(101 / 24);
  const c = crayon.crayonClocks(102 / 24);
  assert.equal(a.boilStep, 50);
  assert.equal(b.boilStep, 50, 'two consecutive 24 fps frames share one 12 fps mark step');
  assert.equal(c.boilStep, 51, 'the next 12 fps step advances the boil');
  assert.notDeepEqual(a.camera, b.camera, 'the camera is evaluated on every frame');
  assert.notDeepEqual(b.camera, c.camera);
  assert.ok(Math.abs(a.camera.x - 822.4364) < 0.01, `camera x at 100/24 is ${a.camera.x}`);
  assert.ok(Math.abs(a.camera.y - 484.4025) < 0.01, `camera y at 100/24 is ${a.camera.y}`);
  assert.ok(Math.abs(a.camera.z - 1.12714) < 0.001, `camera z at 100/24 is ${a.camera.z}`);
  assert.ok(Math.abs(b.camera.x - 822.7016) < 0.01, `camera x at 101/24 is ${b.camera.x}`);
  assert.ok(Math.abs(b.camera.z - 1.12864) < 0.001, `camera z at 101/24 is ${b.camera.z}`);
  for (let frame = 0; frame < 24; frame += 2) {
    assert.equal(
      crayon.crayonClocks(frame / 24).boilStep,
      crayon.crayonClocks((frame + 1) / 24).boilStep,
      `frames ${frame}/${frame + 1} share one 12 fps mark step`,
    );
  }
  // Duration changes the camera phase; the mark boil is a wall-clock cadence.
  const short = crayon.crayonClocks(100 / 24, 5);
  assert.equal(short.boilStep, a.boilStep);
  assert.notDeepEqual(short.camera, a.camera);
});

// ---------------------------------------------------------------------------
// Real pictures: the authored stages and the motif variant.
// ---------------------------------------------------------------------------
test('crayon-book: the page stages and motif are visible, and an ascending rerun reproduces them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-crayon-scene-'));
  const destination = await mkdtemp(join(tmpdir(), 'viscraft-crayon-frames-'));
  try {
    await cp(STUDY_DIR, root, { recursive: true });
    const duration = STAGE_FRAMES / FPS;
    const scene = await openCodeScene(
      root,
      { entry: ENTRY, resources: RESOURCES },
      { width: WIDTH, height: HEIGHT },
      { label: 'captureCode', globalName: 'viscraft' },
    );
    try {
      // ready() must create the ONE WebGL2 context with the compositor's real
      // attributes. A default-attribute probe before the compositor would make
      // preserveDrawingBuffer/premultipliedAlpha/antialias/alpha silently wrong.
      const contextAttributes = await scene.page.evaluate(() => {
        const canvas = document.getElementById('crayon-book') as HTMLCanvasElement | null;
        const gl = canvas?.getContext('webgl2');
        const attributes = gl?.getContextAttributes();
        return attributes
          ? {
              preserveDrawingBuffer: attributes.preserveDrawingBuffer,
              premultipliedAlpha: attributes.premultipliedAlpha,
              antialias: attributes.antialias,
              alpha: attributes.alpha,
            }
          : null;
      });
      assert.deepEqual(contextAttributes, {
        preserveDrawingBuffer: true,
        premultipliedAlpha: false,
        antialias: false,
        alpha: false,
      });

      const frames: Record<number, { png: Buffer; pixels: Buffer }> = {};
      for (const frame of Object.values(KEY)) {
        frames[frame] = await renderFrame(scene, frame, destination, 'star', duration);
        assert.equal(frames[frame].pixels.length, STAGE_BYTES, `frame ${frame} is a complete 640x360 picture`);
      }

      // The action is really drawn: outline, fill, lift, wash.
      assert.ok(contentPixels(frames[KEY.outline].pixels) > 8000, 'the page is not blank at the outline stage');
      assert.ok(
        warmPixels(frames[KEY.fill].pixels).count > warmPixels(frames[KEY.outline].pixels).count + 500,
        'the wax fill adds warm crayon coverage after the outline',
      );
      const lift = warmPixels(frames[KEY.lift].pixels);
      const reach = warmPixels(frames[KEY.reach].pixels);
      assert.ok(reach.count > 1000 && lift.count > 1000, 'the star is really drawn at the reach and lift stages');
      assert.ok(
        lift.x - reach.x > 15 && reach.y - lift.y > 10,
        `the star is lifted toward the revealed constellation (${reach.x.toFixed(1)},${reach.y.toFixed(1)} → ${lift.x.toFixed(1)},${lift.y.toFixed(1)})`,
      );
      assert.ok(
        washPixels(frames[KEY.washEnd].pixels) > washPixels(frames[KEY.wash].pixels) * 1.2,
        'the single wash keeps spreading across the page',
      );
      assert.ok(changedFraction(frames[KEY.washEnd].pixels, frames[KEY.hold].pixels) > 0.01, 'the last stage settles');
      assert.ok(contentPixels(frames[KEY.hold].pixels) > 20000, 'the held page is not empty');

      // The meaningful motif variant changes the drawn object (comet tail).
      const comet = await renderFrame(scene, KEY.lift, destination, 'comet', duration);
      assert.ok(
        changedFraction(comet.pixels, frames[KEY.lift].pixels) > 0.001,
        'the comet motif changes the drawn object beyond a seed/colour variation',
      );

      // Stateful compositor: call ready() again, then replay the WHOLE ascending
      // 0..STAGE_FRAMES-1 sequence, capturing only the key frames. No KEY-only
      // jump sampling and no test hook.
      await scene.page.evaluate(async () => {
        const v = (globalThis as unknown as Record<string, { ready?: () => Promise<void> }>)['viscraft'];
        await v.ready?.();
      });
      const keyFrames = new Set(Object.values(KEY));
      const rerun: Record<number, Buffer> = {};
      for (let frame = 0; frame < STAGE_FRAMES; frame++) {
        if (keyFrames.has(frame)) {
          rerun[frame] = (await renderFrame(scene, frame, destination, 'star', duration)).pixels;
        } else {
          await renderOnly(scene, frame, 'star', duration);
        }
      }
      for (const frame of keyFrames) {
        assert.ok(
          changedFraction(rerun[frame], frames[frame].pixels) < 0.0005,
          `the full ascending rerun reproduces frame ${frame}`,
        );
      }
    } finally {
      await scene.close();
    }
  } finally {
    await rm(destination, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Build → Portable export → real paper edit → rebuild.
// ---------------------------------------------------------------------------
test('crayon-book: the exported Project accepts a real module edit and rebuilds without touching the original', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-crayon-export-'));
  const root = join(parent, 'crayon');
  try {
    await authorRecipe({
      recipe: RECIPE,
      root,
      cwd: parent,
      options: { width: BUILD_WIDTH, height: BUILD_HEIGHT, frames: BUILD_FRAMES },
    });
    const originalProject = await readFile(join(root, 'project.json'), 'utf8');
    const originalModule = await readFile(join(root, 'crayon-book.mjs'));

    const before = await buildProject(root);
    assert.equal(before.status, 'succeeded', `the authored Project must build: ${before.error ?? ''}`);
    const beforeArtifact = before.artifacts.find(artifact => artifact.id === before.result!.artifact)!;
    const beforePath = join(root, beforeArtifact.path);
    const beforeHash = sha256(await readFile(beforePath));
    const decodeSound = (file: string) => {
      const decoded = spawnSync(
        'ffmpeg',
        ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'],
        { maxBuffer: 8 * 1024 * 1024 },
      );
      assert.equal(decoded.status, 0, decoded.stderr.toString());
      return decoded.stdout;
    };
    const sourceSound = before.takes.find(take => take.source === 'page_material_sound');
    assert.ok(sourceSound, 'the material sound is a real rendered Take');
    const soundPath = join(root, before.artifacts.find(artifact => artifact.id === sourceSound.artifact)!.path);
    const soundPcm = decodeSound(soundPath);
    const energy = (pcm: Buffer, from: number, to: number) => {
      let sum = 0;
      for (let i = Math.ceil(from * 48000); i < Math.floor(to * 48000); i++) sum += pcm.readFloatLE(i * 4) ** 2;
      return sum;
    };
    assert.ok(energy(soundPcm, 0.12 * 4, 0.25 * 4) > 0, 'visible outline growth has wax texture');
    assert.equal(energy(soundPcm, 0.61 * 4, 0.74 * 4), 0, 'reach/lift has no invented footsteps or paper sound');
    assert.ok(energy(decodeSound(beforePath), 0.12 * 4, 0.25 * 4) > 0, 'material sound reaches the actual movie');

    const beforeDecoded = decodeFrames(beforePath, BUILD_FRAMES);
    assert.equal(beforeDecoded.length, BUILD_WIDTH * BUILD_HEIGHT * 3 * BUILD_FRAMES);

    const delivered = await deliverProject(root, join(parent, 'delivered'));
    assert.equal((await verifyDelivery(delivered.path)).ok, true);
    const attribution = await readFile(join(delivered.path, 'project', '.viscraft', 'pages', 'ATTRIBUTION.md'), 'utf8');
    assert.match(attribution, /LemoLab/);
    assert.match(attribution, /The Viscraft Authors/);
    assert.match(attribution, /page-action mapping/);
    assert.equal(sha256(await readFile(join(delivered.path, 'movie', 'final.mp4'))), beforeHash);

    const exportedPath = join(parent, 'exported');
    await exportProject(root, exportedPath);
    assert.equal(
      await readFile(join(root, 'project.json'), 'utf8'),
      originalProject,
      'export does not edit the original',
    );
    assert.equal(
      sha256(await readFile(join(root, 'crayon-book.mjs'))),
      sha256(originalModule),
      'export does not edit the original bytes',
    );

    const exported = await loadProject(exportedPath);
    for (const asset of exported.assets) {
      assert.equal(sha256(await readFile(join(exportedPath, asset.path))), asset.sha256, `${asset.path} closure`);
    }
    for (const file of exported.handoff ?? []) {
      assert.equal(sha256(await readFile(join(exportedPath, file.path))).length, 64, `${file.path} travels`);
    }

    const asideRoot = join(parent, 'crayon-aside');
    await rename(root, asideRoot);

    // A real authoring edit of the exported page: the paper becomes a dark
    // sheet, which must reach the decoded picture, not only the hash.
    const exportedModulePath = join(exportedPath, 'crayon-book.mjs');
    const moduleText = await readFile(exportedModulePath, 'utf8');
    const edited = moduleText.replace('paper: [0.957, 0.937, 0.89],', 'paper: [0.08, 0.09, 0.12],');
    assert.notEqual(edited, moduleText, 'the edit targets the authored paper colour');
    await writeFile(exportedModulePath, edited);
    const refreshed = await refreshCodeAsset(exportedPath, {
      assetId: 'crayon_module',
      expectedRevision: exported.revision,
    });
    assert.equal(refreshed.sha256, sha256(Buffer.from(edited)));

    const rebuilt = await buildProject(exportedPath);
    assert.equal(rebuilt.status, 'succeeded', `the exported Project must rebuild: ${rebuilt.error ?? ''}`);
    const afterPath = join(
      exportedPath,
      rebuilt.artifacts.find(artifact => artifact.id === rebuilt.result!.artifact)!.path,
    );
    const soundReuse = rebuilt.operations.filter(
      operation =>
        operation.kind === 'browser' &&
        operation.artifact === rebuilt.takes.find(take => take.source === 'page_material_sound')?.artifact,
    );
    assert.ok(soundReuse.length === 1 && soundReuse[0].reused, 'changing only paper reuses the material sound Take');
    const afterDecoded = decodeFrames(afterPath, BUILD_FRAMES);
    assert.ok(
      changedFraction(
        beforeDecoded.subarray(0, BUILD_WIDTH * BUILD_HEIGHT * 3),
        afterDecoded.subarray(0, BUILD_WIDTH * BUILD_HEIGHT * 3),
      ) > 0.4,
      'the exported paper edit changed the decoded picture',
    );

    // A receiving author changes one action fact: picture and sound must both
    // advance, while the original Project and its earlier media stay intact.
    const factsFile = join(exportedPath, 'action-facts.mjs');
    const facts = await readFile(factsFile, 'utf8');
    const delayedFacts = facts.replace('[0.06, 0.30]', '[0.16, 0.40]');
    assert.notEqual(delayedFacts, facts);
    await writeFile(factsFile, delayedFacts);
    await refreshCodeAsset(exportedPath, {
      assetId: 'crayon_actions',
      expectedRevision: (await loadProject(exportedPath)).revision,
    });
    const delayed = await buildProject(exportedPath);
    assert.equal(delayed.status, 'succeeded', delayed.error);
    const authoredOperations = delayed.operations.filter(operation => operation.kind === 'browser');
    assert.equal(authoredOperations.length, 2);
    assert.ok(
      authoredOperations.every(operation => !operation.reused),
      'editing shared action facts rebuilds both media',
    );
    const delayedTake = delayed.takes.find(take => take.source === 'page_material_sound')!;
    const delayedPcm = decodeSound(
      join(exportedPath, delayed.artifacts.find(a => a.id === delayedTake.artifact)!.path),
    );
    assert.equal(energy(delayedPcm, 0.08 * 4, 0.14 * 4), 0, 'the old drawing window is now silent in the actual Take');
    assert.ok(energy(delayedPcm, 0.2 * 4, 0.25 * 4) > 0, 'sound follows the new shared drawing window');

    assert.equal(
      await readFile(join(asideRoot, 'project.json'), 'utf8'),
      originalProject,
      'the original Project is untouched',
    );
    assert.equal(
      sha256(await readFile(join(asideRoot, 'crayon-book.mjs'))),
      sha256(originalModule),
      'the original module bytes are untouched',
    );
    assert.equal(
      sha256(await readFile(join(asideRoot, beforeArtifact.path))),
      beforeHash,
      'the earlier Artifact is untouched',
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
