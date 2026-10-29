/**
 * E2E: the ink-wash reference — a xieyi figure, loaded brush and a wet/dry/colour
 * rice-paper compositor.
 *
 * Proves, with the REAL author/Browser/Build and direct Browser paths, that:
 *  - the exported clocks are real: `figureClock` runs the figure on twos (12 fps)
 *    while the camera/swell/rings stay continuous, `riverAt` walks the figure
 *    through ready → takeoff/touch → long-leap → land → skid → settle with water
 *    rings at the touches/landing, and `pineAt` walks, plants, bows and rises;
 *  - the RETURNED story pose is itself on twos during a real transition, and the
 *    returned bow pose preserves the fist flag that the hero draw branches on
 *    (not just the POSE table);
 *  - the WebGL2 compositor is created once with its FINAL attributes (opaque, no
 *    MSAA/depth/stencil, preserved buffer) and no earlier default probe;
 *  - the rendered page really contains the three ink layers: smooth mid-tone
 *    wash (wet bleed), high local contrast (dry tooth/loaded stroke) and the
 *    vermilion colour layer (sash, then the end chop). The compositor exposes no
 *    debug hook, so this is read from local picture statistics, not an isolated
 *    per-layer unit proof;
 *  - rendering is a pure frame function (repeat and shuffled order agree), and a
 *    resize rebuilds the layers at the new backing size and reproduces the
 *    pre-resize frame after resizing back;
 *  - the authored Project BUILDs, exports, accepts a REAL edit of an exported
 *    page/module and rebuilds with changed decoded pixels while the original
 *    Project/module/Artifact bytes stay untouched.
 *
 * SAMPLE SCOPE: the direct Browser samples 960x540 frames from the authored
 * 168-frame river and pine scenes; the Build test uses a shortened authored
 * length at 320x180. This proves the mechanism, not the finished presentation;
 * the full 7 s action and the look remain for the owner/lead review.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { openCodeScene } from '../src/backends/browser/capture.js';
import { buildProject } from '../src/build/build.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { refreshCodeAsset } from '../src/project/code-assets.js';
import { loadProject } from '../src/project/project.js';
import { authorRecipe, sha256 } from './authoring-helpers.js';

const STUDY_DIR = resolve('skills/viscraft/assets/studies/code-visuals/ink-wash');
const RECIPE = join(STUDY_DIR, 'create.mjs');
const MODULE = join(STUDY_DIR, 'ink-wash.mjs');
const ENTRY = 'ink-wash-scene.html';
const RESOURCES = ['ink-wash.mjs'];

const WIDTH = 960;
const HEIGHT = 540;
const FRAMES = 168;
/** Shortened authored length for the Build/export tests; the phase fractions keep the beats. */
const BUILD_FRAMES = 72;
const FPS = 24;
const FRAME_BYTES = WIDTH * HEIGHT * 3;

interface InkModule {
  DEFAULT_FRAMES: number;
  DEFAULT_WIDTH: number;
  DEFAULT_HEIGHT: number;
  TONE: Record<string, number>;
  POSE: Record<string, { v: string; fist?: number; aL?: number[][]; aR?: number[][] }>;
  mixPose(a: unknown, b: unknown, t: number): unknown;
  figureClock(time: number): number;
  riverAt(
    time: number,
    o?: { frames?: number; fps?: number },
  ): {
    variant: string;
    u: number;
    t12: number;
    phase: string;
    pose: { v?: string; fist?: number; aL?: number[][]; aR?: number[][] };
    x: number;
    y: number;
    camera: { x: number; z: number };
    rings: unknown[];
    swell: unknown;
    seal: number;
  };
  pineAt(
    time: number,
    o?: { frames?: number; fps?: number },
  ): {
    variant: string;
    shot: string;
    u: number;
    phase: string;
    pose: { v?: string; fist?: number; aL?: number[][]; aR?: number[][] };
    x: number;
    y: number;
    camera: { x: number; z: number };
    seal: number;
  };
}

const ink = (await import(pathToFileURL(MODULE).href)) as unknown as InkModule;

function decodeFrames(file: string, count: number): Buffer {
  const result = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostdin', '-i', file, '-frames:v', String(count), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 1 << 28 },
  );
  assert.equal(result.status, 0, `ffmpeg decode failed for ${file}: ${result.stderr?.toString() ?? ''}`);
  return result.stdout;
}

function pngPixels(png: Buffer): Buffer {
  const result = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostdin', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { input: png, maxBuffer: 1 << 26 },
  );
  assert.equal(result.status, 0, `ffmpeg PNG decode failed: ${result.stderr?.toString() ?? ''}`);
  return result.stdout;
}

interface InkStats {
  content: number;
  wet: number;
  dryEdge: number;
  dark: number;
  vermilion: number;
}

/**
 * Classify the real rice-paper composite by what it shows:
 *  - wet: smooth mid-tone neutral wash between the paper and the loaded ink;
 *  - dryEdge: adjacent-pixel luminance jumps (dry tooth / loaded stroke edge);
 *  - dark: loaded dark strokes;
 *  - vermilion: the colour layer (sash, end chop).
 */
function inkStats(pixels: Buffer, width = WIDTH, height = HEIGHT): InkStats {
  const stats: InkStats = { content: 0, wet: 0, dryEdge: 0, dark: 0, vermilion: 0 };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      const r = pixels[offset];
      const g = pixels[offset + 1];
      const b = pixels[offset + 2];
      const l = r * 0.299 + g * 0.587 + b * 0.114;
      if (Math.abs(r - 243) + Math.abs(g - 238) + Math.abs(b - 225) > 60) stats.content++;
      if (l > 70 && l < 205 && Math.abs(r - b) < 45) stats.wet++;
      if (l < 70) stats.dark++;
      if (r > 140 && r > g * 1.7 && r > b * 1.7) stats.vermilion++;
      if (x + 1 < width) {
        const next = offset + 3;
        const ln = pixels[next] * 0.299 + pixels[next + 1] * 0.587 + pixels[next + 2] * 0.114;
        if (Math.abs(l - ln) > 40) stats.dryEdge++;
      }
    }
  }
  return stats;
}

async function renderOnly(
  scene: Awaited<ReturnType<typeof openCodeScene>>,
  frame: number,
  params: Record<string, unknown>,
  size: { width: number; height: number },
  seed = 7711,
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
      width: size.width,
      height: size.height,
      seed,
      params,
      bindings: scene.bindings,
    },
  );
}

async function renderAt(
  scene: Awaited<ReturnType<typeof openCodeScene>>,
  frame: number,
  params: Record<string, unknown>,
  destination: string,
  size: { width: number; height: number } = { width: WIDTH, height: HEIGHT },
  seed = 7711,
): Promise<{ png: Buffer; pixels: Buffer }> {
  await renderOnly(scene, frame, params, size, seed);
  const file = join(destination, `ink-${frame}-${size.width}x${size.height}.png`);
  await scene.page.screenshot({ path: file, type: 'png', captureBeyondViewport: false });
  const png = Buffer.from(await readFile(file));
  return { png, pixels: pngPixels(png) };
}

function browserSource(project: Awaited<ReturnType<typeof loadProject>>, index = 0) {
  const source = project.sources[index];
  if (!source || source.kind !== 'browser' || source.output !== 'picture')
    throw new Error(`source ${index} must be a browser picture source`);
  return source;
}

/** Remove a temp tree only on success; keep the site and print it on failure. */
async function cleanup(paths: string[], ok: boolean): Promise<void> {
  if (ok) {
    for (const path of paths) await rm(path, { recursive: true, force: true });
  } else {
    console.error(`KEPT FOR DIAGNOSIS: ${paths.join(' ')}`);
  }
}

// ---------------------------------------------------------------------------
// The exported clocks: figure on twos, continuous camera, the two actions.
// ---------------------------------------------------------------------------
test('ink-wash: the figure clock, the continuous camera and both scenes are real', () => {
  assert.equal(ink.DEFAULT_FRAMES, FRAMES);
  assert.equal(ink.DEFAULT_WIDTH, 1920);
  assert.equal(ink.DEFAULT_HEIGHT, 1080);

  const a = ink.figureClock(100 / FPS);
  const b = ink.figureClock(101 / FPS);
  const c = ink.figureClock(102 / FPS);
  assert.equal(a, b, 'two 24 fps frames share one 12 fps figure drawing');
  assert.notEqual(b, c, 'the next 12 fps drawing advances');
  for (let frame = 0; frame < 24; frame += 2) {
    assert.equal(ink.figureClock(frame / FPS), ink.figureClock((frame + 1) / FPS));
  }

  // The camera is evaluated continuously, not on the figure clock.
  const riverA = ink.riverAt(100 / FPS, { frames: FRAMES, fps: FPS });
  const riverB = ink.riverAt(101 / FPS, { frames: FRAMES, fps: FPS });
  const riverC = ink.riverAt(102 / FPS, { frames: FRAMES, fps: FPS });
  assert.equal(riverA.t12, riverB.t12);
  assert.notEqual(riverA.camera.z, riverB.camera.z);
  assert.notEqual(riverB.camera.z, riverC.camera.z);
  assert.notDeepEqual([riverA.camera.x, riverA.camera.z], [riverB.camera.x, riverB.camera.z]);

  // River: the three touches and the landing are inside a 168-frame source.
  const at = (frame: number) => ink.riverAt(frame / FPS, { frames: FRAMES, fps: FPS });
  assert.equal(at(0).phase, 'ready');
  assert.equal(at(60).phase, 'long-leap');
  assert.equal(at(100).phase, 'land');
  assert.equal(at(140).phase, 'settle');
  assert.ok(at(40).rings.length > 0, 'the water ring exists after the first touch');
  assert.ok(at(56).rings.length > at(36).rings.length, 'the second touch adds its own ring');
  assert.ok(at(100).swell !== null, 'the landing swell exists');
  assert.ok(at(140).seal === 0 && at(166).seal > 0.5, 'the end chop appears only in the last beat');
  assert.ok(at(100).x > at(40).x, 'the figure really crosses the river');

  // Pine: walk, plant, hard cut to the bow, then rise.
  const pine = (frame: number) => ink.pineAt(frame / FPS, { frames: FRAMES, fps: FPS });
  assert.equal(pine(60).shot, 'walk');
  assert.equal(pine(60).phase, 'walk');
  assert.equal(pine(90).phase, 'plant');
  assert.equal(pine(94).shot, 'walk');
  assert.equal(pine(95).shot, 'bow');
  assert.notEqual(pine(94).camera.x, pine(95).camera.x, 'the hard cut really changes the camera');
  assert.equal(pine(120).shot, 'bow');
  assert.equal(pine(120).phase, 'bow');
  assert.equal(pine(160).phase, 'rise');
  assert.ok(pine(160).seal > 0, 'the pine scene also closes with the chop');
  assert.notEqual(pine(120).camera.x, at(120).camera.x, 'the two scenes are different spaces');

  // The salute is actual posed geometry, not just the phase label: a frontal
  // fist-and-palm whose hands meet at chest height, and the hero draw consumes
  // the fist flag (ink-wash.mjs hero() branches on P.fist).
  const bowPose = pine(120).pose;
  assert.equal(bowPose.v, 'front', 'the salute is a frontal view');
  assert.equal(
    bowPose.fist,
    1,
    'the RETURNED salute pose still carries the fist flag that hero() branches on (not just POSE.bow)',
  );
  const handL = bowPose.aL![2];
  const handR = bowPose.aR![2];
  assert.ok(
    Math.hypot(handL[0] - handR[0], handL[1] - handR[1]) < 6,
    `the fist and palm meet at the chest (${handL} / ${handR})`,
  );
  assert.ok(handL[1] < -55 && handL[1] > -75, 'the salute is held at chest height');
  assert.equal(ink.POSE.bow.fist, 1, 'the bow pose carries the fist flag the draw uses');
  assert.equal(ink.POSE.bow.v, 'front');
  assert.deepEqual(ink.mixPose(ink.POSE.front, ink.POSE.bow, 1), ink.POSE.bow);

  // The RETURNED story pose itself is on twos (12 fps), not just figureClock:
  // during a real mix, two 24 fps frames share the pose and the next pair moves.
  // Camera/rings/swell stay continuous and are not required to pair.
  const riverPose = (frame: number) => ink.riverAt(frame / FPS, { frames: FRAMES, fps: FPS }).pose;
  assert.deepEqual(riverPose(84), riverPose(85), 'the river transition pose is held for two 24 fps frames');
  assert.notDeepEqual(riverPose(85), riverPose(86), 'the next 12 fps drawing advances the river pose');
  const pinePose = (frame: number) => ink.pineAt(frame / FPS, { frames: FRAMES, fps: FPS }).pose;
  assert.deepEqual(pinePose(114), pinePose(115), 'the pine bow pose is held for two 24 fps frames');
  assert.notDeepEqual(pinePose(115), pinePose(116), 'the next 12 fps drawing advances the pine pose');
  assert.equal(pinePose(120).fist, 1, 'the returned bow pose keeps the fist flag through the transition');
  assert.deepEqual(
    [ink.TONE.jiao, ink.TONE.nong, ink.TONE.zhong, ink.TONE.dan, ink.TONE.qing],
    [0.96, 0.82, 0.6, 0.34, 0.16],
  );
});

// ---------------------------------------------------------------------------
// Author: real picture Source(s), closure, rights, silence.
// ---------------------------------------------------------------------------
test('ink-wash: create.mjs authors real browser picture sources with the licence closure', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-ink-author-'));
  const root = join(parent, 'ink');
  let ok = false;
  try {
    await authorRecipe({
      recipe: RECIPE,
      root,
      cwd: parent,
      options: { width: WIDTH, height: HEIGHT, frames: FRAMES },
    });

    const project = await loadProject(root);
    assert.equal(project.sources.length, 2);
    assert.deepEqual(
      project.sources.map(source => {
        if (source.kind !== 'browser') throw new Error('ink-wash sources must be browser picture sources');
        return [source.id, source.seed, source.params];
      }),
      [
        ['river_crossing', 7711, { variant: 'river', frames: FRAMES }],
        ['pine_salute', 7712, { variant: 'pine', frames: FRAMES }],
      ],
      'the two scenes are the meaningful content variants',
    );
    for (const source of project.sources) {
      if (source.kind !== 'browser') throw new Error('ink-wash sources must be browser picture sources');
      assert.equal(source.output, 'picture');
      assert.equal(source.entry, ENTRY);
      assert.deepEqual(source.resources, RESOURCES, 'the single authored module is the closure');
      assert.equal(source.frames, FRAMES);
    }
    for (const asset of project.assets) {
      assert.equal(asset.sha256, sha256(await readFile(join(root, asset.path))), `${asset.path} hash is real`);
      assert.ok(asset.rights.license.length > 0, `${asset.path} carries a licence`);
    }
    assert.deepEqual(
      project.assets.map(asset => [asset.id, asset.path, asset.type, asset.rights.license]).sort(),
      [
        ['ink_wash_module', 'ink-wash.mjs', 'code', 'Apache-2.0 AND MIT'],
        ['ink_wash_scene', ENTRY, 'code', 'Apache-2.0 AND MIT'],
      ],
      'the entry and the one module are registered',
    );
    assert.ok(
      project.assets.some(asset => /LemoLab/i.test(String(asset.rights.origin))),
      'the adapted upstream origin is recorded',
    );
    assert.deepEqual((project.handoff ?? []).map(file => [file.path, file.role]).sort(), [
      ['LICENSE-Lemo-Opuscar-MIT.txt', 'license'],
      ['LICENSES.md', 'license'],
      ['THIRD_PARTY_NOTICES.md', 'license'],
    ]);
    assert.match(await readFile(join(root, 'LICENSE-Lemo-Opuscar-MIT.txt'), 'utf8'), /MIT License[\s\S]*LemoLab/);
    assert.deepEqual(project.composition?.audio, [], 'the reference is silent; no placeholder bed');
    assert.doesNotMatch(JSON.stringify(project), /\/lustre-data\/|\/root\/|\/tmp\//);
    ok = true;
  } finally {
    await cleanup([parent], ok);
  }
});

// ---------------------------------------------------------------------------
// Real Build: decodable media and a real action.
// ---------------------------------------------------------------------------
test('ink-wash: the authored Project builds and the action decodes', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-ink-build-'));
  const root = join(parent, 'ink');
  let ok = false;
  try {
    await authorRecipe({
      recipe: RECIPE,
      root,
      cwd: parent,
      options: { width: 320, height: 180, frames: BUILD_FRAMES },
    });
    const project = await loadProject(root);
    const built = await buildProject(root);
    assert.equal(built.status, 'succeeded', `the real build must succeed: ${built.error ?? ''}`);
    assert.equal(built.result?.simulated, false);
    const total = project.sources.reduce(
      (sum, source) => sum + (source.kind === 'browser' && source.output === 'picture' ? source.frames : 0),
      0,
    );
    const final = built.artifacts.find(artifact => artifact.id === built.result!.artifact)!;
    assert.equal(final.media?.frames, total, 'the programme holds every authored source');
    assert.equal(
      built.operations.filter(operation => operation.kind === 'browser').length,
      project.sources.length,
      'each picture source is really captured',
    );

    const frameBytes = 320 * 180 * 3;
    const decoded = decodeFrames(join(root, final.path), total);
    assert.equal(decoded.length, frameBytes * total, 'every authored frame decodes');
    const frame = (index: number) => decoded.subarray(index * frameBytes, (index + 1) * frameBytes);
    const srcFrames = browserSource(project).frames;
    const first = frame(0);
    const middle = frame(Math.round(srcFrames / 2));
    const late = frame(srcFrames - 2);
    let inked = 0;
    for (const pixels of [first, middle, late]) {
      for (let i = 0; i < pixels.length; i += 3) {
        if (pixels[i] < 90 && pixels[i + 1] < 90 && pixels[i + 2] < 90) inked++;
      }
    }
    assert.ok(inked > 0, 'the decoded action really carries dark ink');
    assert.notEqual(sha256(first), sha256(middle), 'the action changes the picture by mid-scene');
    assert.notEqual(sha256(middle), sha256(late), 'the landing/settle changes the picture');
    assert.notEqual(sha256(first), sha256(late), 'the whole action is visible in the encoded media');
    ok = true;
  } finally {
    await cleanup([parent], ok);
  }
});

// ---------------------------------------------------------------------------
// Direct Browser: context attributes, wet/dry/colour, determinism, resize.
// ---------------------------------------------------------------------------
test('ink-wash: the compositor, the three ink layers, determinism and resize are real', async () => {
  const destination = await mkdtemp(join(tmpdir(), 'viscraft-ink-frames-'));
  let ok = false;
  try {
    const scene = await openCodeScene(
      STUDY_DIR,
      { entry: ENTRY, resources: RESOURCES },
      { width: WIDTH, height: HEIGHT },
      { label: 'captureCode', globalName: 'viscraft' },
    );
    try {
      const river = { variant: 'river', frames: FRAMES };
      const opening = await renderAt(scene, 0, river, destination);
      const touch = await renderAt(scene, 40, river, destination);
      const leap = await renderAt(scene, 60, river, destination);
      const land = await renderAt(scene, 100, river, destination);
      const hold = await renderAt(scene, 150, river, destination);
      const chop = await renderAt(scene, 166, river, destination);

      // The compositor context already exists (created by the first render,
      // which used GL_ATTRS). Probe the ACTUAL main canvas only; never create a
      // default context before the compositor does.
      const attributes = await scene.page.evaluate(() => {
        const canvas = document.getElementById('ink') as HTMLCanvasElement | null;
        const gl = canvas?.getContext('webgl2');
        const a = gl?.getContextAttributes();
        return a
          ? {
              alpha: a.alpha,
              antialias: a.antialias,
              depth: a.depth,
              stencil: a.stencil,
              premultipliedAlpha: a.premultipliedAlpha,
              preserveDrawingBuffer: a.preserveDrawingBuffer,
            }
          : null;
      });
      assert.deepEqual(attributes, {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
      });

      assert.equal(land.pixels.length, FRAME_BYTES, 'the captured frame is a complete 960x540 picture');
      // The opening ink-bloom reveal is mostly bare paper; the action is drawn.
      assert.ok(inkStats(opening.pixels).content < inkStats(touch.pixels).content, 'the ink bloom reveal grows');
      const atLand = inkStats(land.pixels);
      assert.ok(atLand.content > 0, 'the landed scene draws real content');
      assert.ok(atLand.wet > 0, 'the wet wash leaves mid-tone bleed pixels');
      assert.ok(atLand.dryEdge > 0, 'the dry/loaded strokes leave hard local edges');
      assert.ok(atLand.dark > 0, 'loaded dark ink is present');
      assert.ok(atLand.vermilion > 0, 'the vermilion colour layer is present');
      assert.ok(
        inkStats(chop.pixels).vermilion > atLand.vermilion,
        'the end chop stamps more of the colour layer than the action frame',
      );

      assert.notEqual(sha256(touch.pixels), sha256(leap.pixels), 'the touch→leap changes the picture');
      assert.notEqual(sha256(leap.pixels), sha256(land.pixels), 'the long leap changes the picture');

      // The settle is a held pose in the authored clock (no arbitrary % gate).
      const settleAt = (frame: number) => ink.riverAt(frame / FPS, { frames: FRAMES, fps: FPS });
      assert.equal(settleAt(140).x, settleAt(150).x, 'the figure stops moving at the settle');
      assert.equal(settleAt(140).phase, settleAt(150).phase);
      assert.equal(settleAt(150).seal, 0, 'the chop has not begun at the settle');
      assert.ok(settleAt(166).seal > 0.5, 'the chop stamps after the settle');

      // The pine scene is a different space/action at the same clock.
      const pineBow = await renderAt(
        scene,
        120,
        { variant: 'pine', frames: FRAMES },
        destination,
        { width: WIDTH, height: HEIGHT },
        7712,
      );
      const pineRise = await renderAt(
        scene,
        160,
        { variant: 'pine', frames: FRAMES },
        destination,
        { width: WIDTH, height: HEIGHT },
        7712,
      );
      assert.ok(inkStats(pineBow.pixels).content > 0, 'the pine path draws a real scene');
      assert.notEqual(sha256(pineBow.pixels), sha256(pineRise.pixels), 'the salute rises in the pine scene');
      assert.notEqual(sha256(land.pixels), sha256(pineBow.pixels), 'river and pine are different pictures');

      // Pure per-frame renderer: repeat and shuffled order agree.
      const repeat = await renderAt(scene, 150, river, destination);
      assert.ok(repeat.png.equals(hold.png), 'the same frame is byte-identical on repeat');
      for (const other of [40, 100]) await renderAt(scene, other, river, destination);
      const again = await renderAt(scene, 150, river, destination);
      assert.ok(again.png.equals(hold.png), 'the frame is independent of sampling order');

      // Resize: rebuilt layers at the real backing size, then back to 960x540.
      await scene.page.setViewport({ width: 320, height: 180, deviceScaleFactor: 1 });
      const small = await renderAt(scene, 150, river, destination, { width: 320, height: 180 });
      assert.equal(small.pixels.length, 320 * 180 * 3, 'the resized frame has its own backing size');
      assert.ok(inkStats(small.pixels, 320, 180).content > 0, 'the resized frame repaints real content');
      await scene.page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
      const back = await renderAt(scene, 150, river, destination);
      assert.ok(back.png.equals(hold.png), 'resizing back rebuilds the layers at the original size');
      ok = true;
    } finally {
      await scene.close();
    }
  } finally {
    await cleanup([destination], ok);
  }
});

// ---------------------------------------------------------------------------
// Build → Portable export → real edit → rebuild; original stays untouched.
// ---------------------------------------------------------------------------
test('ink-wash: the exported Project accepts a real edit and rebuilds without touching the original', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-ink-export-'));
  const root = join(parent, 'ink');
  let ok = false;
  try {
    await authorRecipe({
      recipe: RECIPE,
      root,
      cwd: parent,
      options: { width: 320, height: 180, frames: BUILD_FRAMES },
    });
    const originalProject = await readFile(join(root, 'project.json'), 'utf8');
    const originalModule = await readFile(join(root, 'ink-wash.mjs'));

    const before = await buildProject(root);
    assert.equal(before.status, 'succeeded', `the authored Project must build: ${before.error ?? ''}`);
    const beforeArtifact = before.artifacts.find(artifact => artifact.id === before.result!.artifact)!;
    const beforeHash = sha256(await readFile(join(root, beforeArtifact.path)));

    const exportedPath = join(parent, 'exported');
    await exportProject(root, exportedPath);
    assert.equal(await readFile(join(root, 'project.json'), 'utf8'), originalProject);
    assert.equal(sha256(await readFile(join(root, 'ink-wash.mjs'))), sha256(originalModule));

    const exported = await loadProject(exportedPath);
    for (const asset of exported.assets) {
      assert.equal(sha256(await readFile(join(exportedPath, asset.path))), asset.sha256, `${asset.path} closure`);
    }
    for (const file of exported.handoff ?? []) {
      assert.equal(sha256(await readFile(join(exportedPath, file.path))).length, 64, `${file.path} travels`);
    }

    // Lossless same-frame compare from the exported Project's OWN scene.
    const exportedSource = browserSource(exported);
    const frame = Math.round(exportedSource.frames / 2);
    const capture = async (): Promise<Buffer> => {
      const handle = await openCodeScene(
        exportedPath,
        { entry: exportedSource.entry, resources: exportedSource.resources },
        { width: 320, height: 180 },
        { label: 'captureCode', globalName: 'viscraft' },
      );
      try {
        await renderOnly(handle, frame, exportedSource.params, { width: 320, height: 180 });
        return Buffer.from((await handle.page.screenshot({ type: 'png' })) as Uint8Array);
      } finally {
        await handle.close();
      }
    };
    const beforeFrame = pngPixels(await capture());

    const asideRoot = join(parent, 'ink-aside');
    await rename(root, asideRoot);

    // A REAL authoring edit of the exported module: the loaded jiao tone becomes
    // much lighter, which must reach the lossless picture.
    const exportedModulePath = join(exportedPath, 'ink-wash.mjs');
    const moduleText = await readFile(exportedModulePath, 'utf8');
    const edited = moduleText.replace('export const TONE = { jiao: 0.96,', 'export const TONE = { jiao: 0.66,');
    assert.notEqual(edited, moduleText, 'the edit targets the authored jiao tone');
    await writeFile(exportedModulePath, edited);
    const refreshed = await refreshCodeAsset(exportedPath, {
      assetId: exported.assets.find(asset => asset.path === 'ink-wash.mjs')!.id,
      expectedRevision: exported.revision,
    });
    assert.equal(refreshed.sha256, sha256(Buffer.from(edited)));

    const rebuilt = await buildProject(exportedPath);
    assert.equal(rebuilt.status, 'succeeded', `the exported Project must rebuild: ${rebuilt.error ?? ''}`);
    const afterArtifact = rebuilt.artifacts.find(artifact => artifact.id === rebuilt.result!.artifact)!;
    assert.notEqual(
      sha256(await readFile(join(exportedPath, afterArtifact.path))),
      beforeHash,
      'the rebuild produced a new Artifact, not a cached copy',
    );
    const afterFrame = pngPixels(await capture());
    assert.notEqual(sha256(beforeFrame), sha256(afterFrame), 'the tone edit changed the lossless frame');

    assert.equal(
      await readFile(join(asideRoot, 'project.json'), 'utf8'),
      originalProject,
      'the original Project is untouched',
    );
    assert.deepEqual(
      await readFile(join(asideRoot, 'ink-wash.mjs')),
      originalModule,
      'the original module bytes are untouched',
    );
    assert.equal(
      sha256(await readFile(join(asideRoot, beforeArtifact.path))),
      beforeHash,
      'the earlier Artifact is untouched',
    );
    ok = true;
  } finally {
    await cleanup([parent], ok);
  }
});
