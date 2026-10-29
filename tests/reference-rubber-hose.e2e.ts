/**
 * E2E: the rubber-hose reference — object-body acting, a 12/24 fps clock split
 * and a 4:3 film gate.
 *
 * Proves, with the REAL author/Browser/Build/export path, that:
 *  - `create.mjs` authors TWO browser picture Sources (spoon-stir / stair-clock)
 *    over one entry and the same three modules, with the real seeds/params, MIT
 *    rights, three licence handoffs and no audio bed;
 *  - the exported clocks are real: `boilDrawing` cycles three drawings at 12 fps,
 *    `spoonPose` puts the bowl inside the mug mouth during the stir, leaves it on
 *    the counter before the reach, and enters/exits the stir at the authored key
 *    with two full cycles (no branch cut), and `climbPose` climbs the six plate
 *    steps;
 *  - the production toon drawing path keeps its ink stroke in SCREEN pixels when
 *    the same isolated shape is drawn at object scale 1 and 2 on one canvas
 *    (6 px both times; a 12 px control doubles) — this is the actual public
 *    `createToon`/`shape` path, not a debug hook and not a whole-frame statistic;
 *  - the PRODUCTION render inverse-scales its outline stroke calls on the
 *    1920x1080 design canvas by 1/1.12 at pushIn 0.12 (recorded lineWidth
 *    6→6/1.12 and 12→12/1.12): drawing-command evidence, not a pixel-isolated
 *    composite claim;
 *  - the exported `boilDrawing` clock pairs 24 fps frames on one 12 fps drawing;
 *    the PRODUCTION render function holds its returned spoon/climb pose for the
 *    same pair while the beat advances on every 24 fps frame, and the film gate
 *    still differs on adjacent frames (the photography is not quantised);
 *  - author duration and output fps normalise the same action: a 4 s cut ends
 *    where the 8 s cut ends, and the 12 Hz drawing/boil follow raw seconds at
 *    30 fps rather than output-frame parity;
 *  - `inkWeight` really increases the near-black ink mass at the same frame;
 *  - the 4:3 gate leaves black pillarbox bands at 960x540, and the pale spoon
 *    bowl covers the dark coffee at the stir (local pixels + geometry);
 *  - rendering is a pure frame function (repeat and shuffled order agree);
 *  - the authored Project BUILDs, exports, accepts a REAL edit of the exported
 *    module (the mug position), rebuilds to a new Artifact and changes the
 *    lossless same-frame picture while the original Project/module/Artifact
 *    bytes stay untouched.
 *
 * SCOPE: the Build test uses the authored 192-frame (8 s) beats at 320x180; the
 * direct captures are selected 960x540 frames, plus a 320x180 probe of the
 * render function's returned pose. The final look remains for the owner/lead
 * visual review. No font, voice, music or sample is claimed.
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
import { refreshCodeAsset } from '../src/project/code-assets.js';
import { loadProject } from '../src/project/project.js';
import { authorRecipe, sha256 } from './authoring-helpers.js';

const STUDY_DIR = resolve('skills/viscraft/assets/studies/code-visuals/rubber-hose');
const RECIPE = join(STUDY_DIR, 'create.mjs');
const MODULE = join(STUDY_DIR, 'rubber-hose.mjs');

const ENTRY = 'rubber-hose-scene.html';
const RESOURCES = ['rubber-hose.mjs', 'rubber-hose-toon.mjs', 'rubber-hose-actors.mjs'];
const FRAMES = 192;
const FPS = 24;
const WIDTH = 960;
const HEIGHT = 540;
const BUILD_WIDTH = 320;
const BUILD_HEIGHT = 180;

interface HoseModule {
  boilDrawing(time: number): number;
  beatAt(time: number, bpm?: number): number;
  spoonPose(frame: number): { x: number; y: number; a: number };
  climbPose(frame: number): { i: number; x: number; feet: number; air: number; squash: number };
  PLATE_STEPS: Array<{ x: number; y: number }>;
}

const hose = (await import(pathToFileURL(MODULE).href)) as unknown as HoseModule;

/** Mug rim in design space (actors.mjs: MUG.R=104, rim at y1=-250 above y=880). */
const MUG_RIM = { x: 720, y: 630, radius: 104 };

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
    { input: png, maxBuffer: 1 << 25 },
  );
  assert.equal(result.status, 0, `ffmpeg PNG decode failed: ${result.stderr?.toString() ?? ''}`);
  return result.stdout;
}

/** Dark ink pixels: the near-black outline/loaded shapes. */
function inkPixels(pixels: Buffer): number {
  let count = 0;
  for (let i = 0; i < pixels.length; i += 3) {
    if (pixels[i] < 60 && pixels[i + 1] < 60 && pixels[i + 2] < 60) count++;
  }
  return count;
}

function luminance(pixels: Buffer, width: number, x: number, y: number): number {
  const offset = (y * width + x) * 3;
  return (pixels[offset] * 299 + pixels[offset + 1] * 587 + pixels[offset + 2] * 114) / 1000;
}

/** Longest contiguous dark run in a horizontal window around `center`. */
function darkRunAt(pixels: Buffer, width: number, height: number, y: number, center: number, radius = 22): number {
  assert.ok(y >= 0 && y < height, 'probe row is inside the canvas');
  let best = 0;
  let run = 0;
  for (let x = Math.max(0, center - radius); x < Math.min(width, center + radius); x++) {
    const offset = (y * width + x) * 3;
    const dark = pixels[offset] < 60 && pixels[offset + 1] < 60 && pixels[offset + 2] < 60;
    run = dark ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

function regionDigest(pixels: Buffer, width: number, x: number, y: number, w: number, h: number): string {
  const rows: Buffer[] = [];
  for (let j = y; j < y + h; j++) rows.push(pixels.subarray((j * width + x) * 3, (j * width + x + w) * 3));
  return sha256(Buffer.concat(rows));
}

async function renderOnly(
  handle: Awaited<ReturnType<typeof openCodeScene>>,
  frame: number,
  params: Record<string, unknown>,
  seed: number,
  size: { width: number; height: number },
  fps = FPS,
): Promise<void> {
  await handle.page.evaluate(
    async payload => {
      const v = (globalThis as unknown as Record<string, { render: (a: unknown) => void }>)['viscraft'];
      v.render(payload);
    },
    {
      frame,
      time: frame / fps,
      fps,
      width: size.width,
      height: size.height,
      seed,
      params,
      bindings: handle.bindings,
    },
  );
}

async function renderAt(
  handle: Awaited<ReturnType<typeof openCodeScene>>,
  frame: number,
  params: Record<string, unknown>,
  seed: number,
  destination: string,
  size: { width: number; height: number } = { width: WIDTH, height: HEIGHT },
): Promise<{ png: Buffer; pixels: Buffer }> {
  await renderOnly(handle, frame, params, seed, size);
  const file = join(
    destination,
    `hose-${frame}-${size.width}x${size.height}-${sha256(JSON.stringify(params)).slice(0, 8)}.png`,
  );
  await handle.page.screenshot({ path: file, type: 'png', captureBeyondViewport: false });
  const png = Buffer.from(await readFile(file));
  return { png, pixels: pngPixels(png) };
}

function browserSource(project: Awaited<ReturnType<typeof loadProject>>, index = 0) {
  const source = project.sources[index];
  if (!source || source.kind !== 'browser') throw new Error(`source ${index} must be a browser picture source`);
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

/**
 * Real production toon fixture: the same isolated rectangle is drawn at object
 * scale 1 and 2 on ONE 400x200 canvas via createToon/shape, plus a 12 px
 * control. The stroked edge width is then measured in output pixels.
 */
async function toonStrokeWidths(): Promise<{ scaled: number; doubled: number; heavy: number }> {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-hose-toon-'));
  const destination = await mkdtemp(join(tmpdir(), 'viscraft-hose-toon-png-'));
  let ok = false;
  try {
    await cp(join(STUDY_DIR, 'rubber-hose-toon.mjs'), join(root, 'toon.mjs'));
    const page = `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000}canvas{display:block}</style></head>
<body><canvas id="probe" width="400" height="200"></canvas>
<script type="module">
import { createToon, rect } from './toon.mjs';
const canvas = document.getElementById('probe');
const g = canvas.getContext('2d');
window.viscraft = { render() {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#F1EEE6'; g.fillRect(0, 0, 400, 200);
  const T = createToon(g);
  T.setLwScale(1);
  T.frame(0, { amp: 0 });
  T.push(); T.translate(60, 100); T.scale(1); T.shape(rect(-25, -40, 50, 80), { fill: '#E2DFD6', lw: 6 }); T.pop();
  T.push(); T.translate(300, 100); T.scale(2); T.shape(rect(-25, -40, 50, 80), { fill: '#E2DFD6', lw: 6 }); T.pop();
  T.push(); T.translate(150, 100); T.scale(1); T.shape(rect(-8, -20, 16, 40), { fill: '#E2DFD6', lw: 12 }); T.pop();
} };
</script></body></html>`;
    await writeFile(join(root, 'probe.html'), page);
    const handle = await openCodeScene(
      root,
      { entry: 'probe.html', resources: ['toon.mjs'] },
      { width: 400, height: 200 },
      { label: 'captureCode', globalName: 'viscraft' },
    );
    try {
      await handle.page.evaluate(async () => {
        (globalThis as unknown as { viscraft: { render: () => void } }).viscraft.render();
      });
      const file = join(destination, 'toon.png');
      await handle.page.screenshot({ path: file, type: 'png', captureBeyondViewport: false });
      const pixels = pngPixels(Buffer.from(await readFile(file)));
      assert.equal(pixels.length, 400 * 200 * 3);
      // Left stroked edges: 35 (scale 1), 250 (scale 2), 136 (12 px control).
      const scaled = darkRunAt(pixels, 400, 200, 100, 35);
      const doubled = darkRunAt(pixels, 400, 200, 100, 250);
      const heavy = darkRunAt(pixels, 400, 200, 100, 136);
      ok = true;
      return { scaled, doubled, heavy };
    } finally {
      await handle.close();
    }
  } finally {
    await cleanup([destination, root], ok);
  }
}

// ---------------------------------------------------------------------------
// Exported clocks, spoon contact geometry, plate climb.
// ---------------------------------------------------------------------------
test('rubber-hose: the 12 fps boil, the spoon contact and the plate climb are real', () => {
  assert.equal(hose.boilDrawing(100 / FPS), hose.boilDrawing(101 / FPS));
  assert.equal(hose.boilDrawing(102 / FPS), hose.boilDrawing(103 / FPS));
  assert.notEqual(hose.boilDrawing(101 / FPS), hose.boilDrawing(102 / FPS));
  const cycle = Array.from({ length: 12 }, (_, frame) => hose.boilDrawing(frame / FPS));
  assert.deepEqual(
    cycle.filter((_, index) => index % 2 === 0),
    [0, 1, 2, 0, 1, 2],
    'three drawings cycle on twos',
  );

  // The spoon bowl is origin − 100*(cos a, sin a); the stir is inside the rim.
  const bowl = (frame: number) => {
    const pose = hose.spoonPose(frame);
    return { x: pose.x - Math.cos(pose.a) * 100, y: pose.y - Math.sin(pose.a) * 100 };
  };
  const distance = (a: { x: number; y: number }) => Math.hypot(a.x - MUG_RIM.x, a.y - MUG_RIM.y);
  assert.ok(distance(bowl(0)) > MUG_RIM.radius * 2, 'the spoon starts on the counter, away from the mug');
  assert.ok(distance(bowl(100)) < MUG_RIM.radius, 'the bowl is inside the mug mouth during the stir');
  const stirA = bowl(90);
  const stirB = bowl(105);
  assert.notDeepEqual(stirA, stirB, 'the spoon really stirs');
  assert.ok(distance(bowl(118)) > MUG_RIM.radius, 'the spoon leaves the mug after the stir');

  // The stir is two full cycles that enter and exit at the authored key, so
  // there is no branch cut at either end (the old source jumped at 86/114).
  assert.deepEqual(hose.spoonPose(86), { x: 841, y: 712, a: 1.16 }, 'the stir entry meets the authored key');
  assert.deepEqual(hose.spoonPose(112), { x: 841, y: 712, a: 1.16 }, 'two stir cycles exit at the same key');
  // Endpoints alone are not enough: the one-sided limits within 1e-5 of the
  // authored boundary must still be numerically continuous (no hidden jump).
  const limitDelta = (frame: number) => {
    const a = hose.spoonPose(frame);
    const b = hose.spoonPose(frame + 1e-5);
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.a - b.a));
  };
  for (const boundary of [86, 112]) {
    assert.ok(limitDelta(boundary - 1e-5) < 1e-3, `the left limit at stir frame ${boundary} is continuous`);
    assert.ok(limitDelta(boundary) < 1e-3, `the right limit at stir frame ${boundary} is continuous`);
  }

  // The result hold is a held pose in the authored clock.
  assert.deepEqual(hose.spoonPose(146), hose.spoonPose(190));

  assert.equal(hose.PLATE_STEPS.length, 6);
  for (let i = 1; i < hose.PLATE_STEPS.length; i++) {
    assert.ok(hose.PLATE_STEPS[i].x > hose.PLATE_STEPS[i - 1].x);
    assert.ok(hose.PLATE_STEPS[i].y < hose.PLATE_STEPS[i - 1].y);
  }
  assert.equal(hose.climbPose(0).i, 0);
  assert.equal(hose.climbPose(150).i, 5);
  assert.ok(hose.climbPose(30).air > 0, 'the cube is airborne between plates');
  assert.ok(hose.climbPose(30).feet < hose.PLATE_STEPS[0].y - 10, 'the hop leaves the first step');
  assert.equal(hose.beatAt(1, 120), 2, 'the beat clock is bpm-based');
});

// ---------------------------------------------------------------------------
// The production toon outline stays in screen pixels under object scaling.
// ---------------------------------------------------------------------------
test('rubber-hose: the toon outline is screen-space constant under object scale', async () => {
  const widths = await toonStrokeWidths();
  assert.equal(widths.scaled, 6, `the scale-1 stroke is 6 px (got ${widths.scaled})`);
  assert.equal(widths.doubled, 6, `the scale-2 stroke is still 6 px (got ${widths.doubled})`);
  assert.equal(widths.heavy, 12, `the 12 px control is 12 px (got ${widths.heavy})`);
});

// ---------------------------------------------------------------------------
// The real render function samples the actor on twos, the beat continuously.
// ---------------------------------------------------------------------------
interface RenderedHose {
  spoon: { x: number; y: number; angle: number };
  climb: { plate: number; x: number; feet: number };
  boil: number;
  beat: number;
  frame: number;
  time: number;
}

/**
 * Fixture page that calls the PRODUCTION `renderRubberHose` and returns its
 * result. It is a test page, not a product debug hook: the real modules are
 * copied byte-for-byte and the public render function does all the work.
 */
async function renderedPoseAt(
  handle: Awaited<ReturnType<typeof openCodeScene>>,
  frame: number,
  params: Record<string, unknown>,
  seed: number,
  fps = FPS,
): Promise<RenderedHose> {
  await renderOnly(handle, frame, params, seed, { width: BUILD_WIDTH, height: BUILD_HEIGHT }, fps);
  return handle.page.evaluate(() => (globalThis as unknown as { __hose: RenderedHose }).__hose);
}

test('rubber-hose: the render samples the actor on twos and the beat on 24 fps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-hose-render-'));
  try {
    for (const file of RESOURCES) await cp(join(STUDY_DIR, file), join(root, file));
    const page = `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0}canvas{display:block}</style></head>
<body><canvas id="probe" width="${BUILD_WIDTH}" height="${BUILD_HEIGHT}"></canvas>
<script type="module">
import { renderRubberHose } from './rubber-hose.mjs';
const canvas = document.getElementById('probe');
window.__widths = [];
const origStroke = CanvasRenderingContext2D.prototype.stroke;
CanvasRenderingContext2D.prototype.stroke = function (...args) {
  if (this.canvas && this.canvas.width === 1920 && this.canvas.height === 1080) window.__widths.push(this.lineWidth);
  return origStroke.apply(this, args);
};
window.__restoreStroke = () => { CanvasRenderingContext2D.prototype.stroke = origStroke; };
window.viscraft = { render(ctx) { window.__widths = []; window.__hose = renderRubberHose(canvas, ctx); } };
</script></body></html>`;
    await writeFile(join(root, 'probe.html'), page);
    const handle = await openCodeScene(
      root,
      { entry: 'probe.html', resources: RESOURCES },
      { width: BUILD_WIDTH, height: BUILD_HEIGHT },
      { label: 'captureCode', globalName: 'viscraft' },
    );
    try {
      const params = {
        variant: 'spoon-stir',
        bpm: 120,
        boilAmp: 1.2,
        inkWeight: 6,
        pushIn: 0.035,
        damage: 1,
        duration: FRAMES / FPS,
      };
      const a = await renderedPoseAt(handle, 100, params, 8123);
      const b = await renderedPoseAt(handle, 101, params, 8123);
      const c = await renderedPoseAt(handle, 102, params, 8123);
      assert.deepEqual(a.spoon, b.spoon, 'the spoon pose is held across two 24 fps frames');
      assert.deepEqual(a.climb, b.climb, 'the climb pose is held across two 24 fps frames');
      assert.notDeepEqual(b.spoon, c.spoon, 'the next 12 fps drawing advances the spoon');
      assert.equal(a.boil, b.boil, 'one boil drawing covers both frames');
      assert.notEqual(b.boil, c.boil, 'the next boil drawing starts on the next pair');
      assert.notEqual(a.beat, b.beat, 'the beat clock still advances on the 24 fps frame');
      assert.equal(a.frame, 100);
      assert.equal(a.time, 100 / FPS);

      // The authored duration and the output fps describe the SAME action in
      // time, not in output frames. A 4 s cut must reach the 8 s endpoint, and
      // the 12 Hz drawing/boil must follow raw seconds at 30 fps too.
      const params4 = { ...params, duration: 4 };
      const end8 = await renderedPoseAt(handle, 192, params, 8123);
      const end4 = await renderedPoseAt(handle, 96, params4, 8123);
      assert.deepEqual(end4.spoon, end8.spoon, 'duration 4 ends at the same spoon endpoint as duration 8');
      assert.deepEqual(end4.climb, end8.climb, 'duration 4 ends at the same climb endpoint as duration 8');

      const at24 = await renderedPoseAt(handle, 48, params, 8123);
      const at30a = await renderedPoseAt(handle, 60, params, 8123, 30);
      const at30b = await renderedPoseAt(handle, 61, params, 8123, 30);
      const at30c = await renderedPoseAt(handle, 63, params, 8123, 30);
      assert.deepEqual(at30a.spoon, at24.spoon, 'the same raw time gives the same pose at 30 fps');
      assert.deepEqual(at30a.spoon, at30b.spoon, '30 fps still holds the 12 Hz drawing');
      assert.notDeepEqual(at30b.spoon, at30c.spoon, 'the 12 Hz drawing advances on raw time at 30 fps');
      assert.equal(at30a.boil, at24.boil, 'the boil clock is raw-time based, not frame parity');
      assert.equal(at30a.beat, at24.beat, 'the beat clock is raw-time based');

      // The production DRAWING CALL itself: at u=1 the composite camera zoom is
      // 1+pushIn, so the outline lineWidth issued on the 1920x1080 design canvas
      // must be inverse-scaled. The earlier frames warmed the background cache;
      // the hook filters the 1920x1080 design canvas only. This records actual
      // Canvas stroke calls, not a pixel-level claim about the final gate.
      const widthsAt = async (pushIn: number) => {
        await renderedPoseAt(handle, 192, { ...params, pushIn }, 8123);
        return handle.page.evaluate(() => (globalThis as unknown as { __widths: number[] }).__widths);
      };
      const zoom = 1.12;
      const plain = await widthsAt(0);
      const pushed = await widthsAt(0.12);
      for (const authored of [6, 12]) {
        assert.ok(plain.includes(authored), `the ${authored} px outline is issued at zoom 1`);
        const inverse = authored / zoom;
        const matched = pushed.find(width => Math.abs(width - inverse) < 1e-6);
        assert.ok(
          matched !== undefined,
          `the ${authored} px outline call is inverse-scaled to ${inverse} at zoom ${zoom}`,
        );
        assert.ok(
          Math.abs(matched! * zoom - authored) < 1e-6,
          `the pushed ${matched} px width times ${zoom} equals the ${authored} px unscaled width`,
        );
        assert.ok(
          !pushed.includes(authored),
          `the ${authored} px outline is not left unscaled under the pushed camera`,
        );
      }
    } finally {
      await handle.page.evaluate(() => (globalThis as unknown as { __restoreStroke?: () => void }).__restoreStroke?.());
      await handle.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Author: two Sources, the real closure and rights.
// ---------------------------------------------------------------------------
test('rubber-hose: create.mjs authors the two acting beats with the licence closure', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-hose-author-'));
  const root = join(parent, 'hose');
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
        if (source.kind !== 'browser') throw new Error('rubber-hose sources must be browser sources');
        return [source.id, source.seed, source.params.variant];
      }),
      [
        ['spoon-stir', 8123, 'spoon-stir'],
        ['stair-clock', 8140, 'stair-clock'],
      ],
    );
    for (const source of project.sources) {
      if (source.kind !== 'browser') throw new Error('rubber-hose sources must be browser sources');
      assert.equal(source.output, 'picture');
      assert.equal(source.entry, ENTRY);
      assert.deepEqual(source.resources, RESOURCES);
      assert.equal(source.frames, FRAMES);
      assert.deepEqual(source.params, {
        variant: source.id,
        bpm: 120,
        boilAmp: 1.2,
        inkWeight: 6,
        pushIn: 0.035,
        damage: 1,
        duration: FRAMES / FPS,
      });
    }
    assert.deepEqual(project.composition?.audio, []);
    assert.deepEqual(project.assets.map(asset => [asset.id, asset.path, asset.type, asset.rights.license]).sort(), [
      ['hose_actors', 'rubber-hose-actors.mjs', 'code', 'Apache-2.0 AND MIT'],
      ['hose_module', 'rubber-hose.mjs', 'code', 'Apache-2.0 AND MIT'],
      ['hose_scene', ENTRY, 'code', 'Apache-2.0'],
      ['hose_toon', 'rubber-hose-toon.mjs', 'code', 'Apache-2.0 AND MIT'],
    ]);
    for (const asset of project.assets) {
      assert.equal(asset.sha256, sha256(await readFile(join(root, asset.path))), `${asset.path} hash is real`);
    }
    assert.match(String(project.assets.find(asset => asset.id === 'hose_module')!.rights.origin), /LemoLab/i);
    assert.deepEqual((project.handoff ?? []).map(file => [file.path, file.role]).sort(), [
      ['LICENSE-LemoLab-MIT.txt', 'license'],
      ['LICENSES.md', 'license'],
      ['THIRD_PARTY_NOTICES.md', 'license'],
    ]);
    assert.match(await readFile(join(root, 'LICENSES.md'), 'utf8'), /MIT License[\s\S]*LemoLab/);
    assert.doesNotMatch(JSON.stringify(project), /\/lustre-data\/|\/root\/|\/tmp\//);
    ok = true;
  } finally {
    await cleanup([parent], ok);
  }
});

// ---------------------------------------------------------------------------
// Real Build: both 8 s takes decode; the two variants are different pictures.
// ---------------------------------------------------------------------------
test('rubber-hose: the authored Project builds and both acting beats decode', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-hose-build-'));
  const root = join(parent, 'hose');
  let ok = false;
  try {
    await authorRecipe({
      recipe: RECIPE,
      root,
      cwd: parent,
      options: { width: BUILD_WIDTH, height: BUILD_HEIGHT, frames: FRAMES },
    });
    const built = await buildProject(root);
    assert.equal(built.status, 'succeeded', `the real build must succeed: ${built.error ?? ''}`);
    assert.equal(built.result?.simulated, false);
    const final = built.artifacts.find(artifact => artifact.id === built.result!.artifact)!;
    assert.equal(final.media?.frames, FRAMES * 2, 'the programme holds both 8 s beats');
    assert.equal(built.operations.filter(operation => operation.kind === 'browser').length, 2);

    const frameBytes = BUILD_WIDTH * BUILD_HEIGHT * 3;
    const decoded = decodeFrames(join(root, final.path), FRAMES * 2);
    assert.equal(decoded.length, frameBytes * FRAMES * 2, 'every authored frame decodes');
    const frame = (index: number) => decoded.subarray(index * frameBytes, (index + 1) * frameBytes);
    const digest = (index: number) => sha256(frame(index));

    assert.ok(inkPixels(frame(0)) > 0, 'the opening frame is drawn');
    assert.notEqual(digest(0), digest(56), 'the mug reaches for the spoon');
    assert.notEqual(digest(56), digest(100), 'the spoon reaches the stir');
    assert.notEqual(digest(100), digest(124), 'the taste reaction changes the picture');
    assert.notEqual(digest(190), digest(191), 'the gate/camera is still running at the end');

    // The second take is a different space/prop/action picture.
    assert.notEqual(digest(100), digest(FRAMES + 100), 'spoon-stir and stair-clock are different pictures');
    ok = true;
  } finally {
    await cleanup([parent], ok);
  }
});

// ---------------------------------------------------------------------------
// Direct Browser: the 12/24 fps split, ink weight, gate and local contact.
// ---------------------------------------------------------------------------
test('rubber-hose: the character clock, the ink and the gate behave as authored', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-hose-scene-'));
  const root = join(parent, 'hose');
  const destination = await mkdtemp(join(tmpdir(), 'viscraft-hose-frames-'));
  let ok = false;
  try {
    await authorRecipe({
      recipe: RECIPE,
      root,
      cwd: parent,
      options: { width: WIDTH, height: HEIGHT, frames: FRAMES },
    });
    const project = await loadProject(root);
    const source = browserSource(project);
    const handle = await openCodeScene(
      root,
      { entry: source.entry, resources: source.resources },
      { width: WIDTH, height: HEIGHT },
      { label: 'captureCode', globalName: 'viscraft' },
    );
    try {
      // The 24 fps gate/camera runs even when the characters are on twos.
      const gateA = await renderAt(handle, 100, source.params, source.seed, destination);
      const gateB = await renderAt(handle, 101, source.params, source.seed, destination);
      assert.ok(!gateA.png.equals(gateB.png), 'the gate runs on the 24 fps clock');

      // inkWeight changes the actual near-black ink mass at one frame.
      const light = await renderAt(handle, 100, { ...source.params, inkWeight: 3 }, source.seed, destination);
      const heavy = await renderAt(handle, 100, { ...source.params, inkWeight: 12 }, source.seed, destination);
      assert.ok(inkPixels(heavy.pixels) > inkPixels(light.pixels), 'inkWeight thickens the ink');

      // 4:3 gate at 960x540: the design gate 240..1680 maps to 120..840.
      const s = WIDTH / 1920;
      const gateX = Math.round(240 * s);
      for (let y = 10; y < HEIGHT; y += 37) {
        for (let x = 4; x < gateX - 4; x += 13) {
          const offset = (y * WIDTH + x) * 3;
          assert.deepEqual(
            [gateA.pixels[offset], gateA.pixels[offset + 1], gateA.pixels[offset + 2]],
            [0, 0, 0],
            `the pillarbox is black at (${x},${y})`,
          );
        }
      }

      // Local contact: the pale bowl covers the dark coffee at the stir.
      const bowl = (frame: number) => {
        const pose = hose.spoonPose(frame);
        return {
          x: Math.round((pose.x - Math.cos(pose.a) * 100) * s),
          y: Math.round((pose.y - Math.sin(pose.a) * 100) * s),
        };
      };
      const stirBowl = bowl(100);
      const coffee = { x: Math.round(700 * s), y: Math.round(640 * s) };
      const stirFrame = await renderAt(handle, 100, source.params, source.seed, destination);
      const preFrame = await renderAt(handle, 40, source.params, source.seed, destination);
      assert.ok(
        luminance(stirFrame.pixels, WIDTH, stirBowl.x, stirBowl.y) > 150,
        'the pale bowl is visible at the coffee mouth at the stir',
      );
      assert.ok(luminance(stirFrame.pixels, WIDTH, coffee.x, coffee.y) < 80, 'the exposed coffee stays dark');
      assert.notEqual(
        regionDigest(stirFrame.pixels, WIDTH, stirBowl.x - 6, stirBowl.y - 6, 13, 13),
        regionDigest(preFrame.pixels, WIDTH, stirBowl.x - 6, stirBowl.y - 6, 13, 13),
        'the mug-mouth region changes when the spoon arrives',
      );

      // Pure per-frame renderer: repeat and shuffled order agree.
      const repeat = await renderAt(handle, 100, source.params, source.seed, destination);
      assert.ok(repeat.png.equals(gateA.png), 'the same frame is byte-identical on repeat');
      for (const other of [0, 150, 60]) await renderAt(handle, other, source.params, source.seed, destination);
      const again = await renderAt(handle, 100, source.params, source.seed, destination);
      assert.ok(again.png.equals(gateA.png), 'the frame is independent of sampling order');
      ok = true;
    } finally {
      await handle.close();
    }
  } finally {
    await cleanup([destination, parent], ok);
  }
});

// ---------------------------------------------------------------------------
// Build → Portable export → real module edit → lossless same-frame compare.
// ---------------------------------------------------------------------------
test('rubber-hose: the exported module accepts a real mug-position edit and rebuilds', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-hose-export-'));
  const root = join(parent, 'hose');
  let ok = false;
  try {
    await authorRecipe({
      recipe: RECIPE,
      root,
      cwd: parent,
      options: { width: BUILD_WIDTH, height: BUILD_HEIGHT, frames: FRAMES },
    });
    const originalProject = await readFile(join(root, 'project.json'), 'utf8');
    const originalModule = await readFile(join(root, 'rubber-hose.mjs'));

    const before = await buildProject(root);
    assert.equal(before.status, 'succeeded', `the authored Project must build: ${before.error ?? ''}`);
    const beforeArtifact = before.artifacts.find(artifact => artifact.id === before.result!.artifact)!;
    const beforeHash = sha256(await readFile(join(root, beforeArtifact.path)));

    const exportedPath = join(parent, 'exported');
    await exportProject(root, exportedPath);
    assert.equal(await readFile(join(root, 'project.json'), 'utf8'), originalProject);
    assert.equal(sha256(await readFile(join(root, 'rubber-hose.mjs'))), sha256(originalModule));

    const exported = await loadProject(exportedPath);
    for (const asset of exported.assets) {
      assert.equal(sha256(await readFile(join(exportedPath, asset.path))), asset.sha256, `${asset.path} closure`);
    }
    for (const file of exported.handoff ?? []) {
      assert.equal(sha256(await readFile(join(exportedPath, file.path))).length, 64, `${file.path} travels`);
    }

    const exportedSource = browserSource(exported);
    const capture = async (): Promise<Buffer> => {
      const handle = await openCodeScene(
        exportedPath,
        { entry: exportedSource.entry, resources: exportedSource.resources },
        { width: BUILD_WIDTH, height: BUILD_HEIGHT },
        { label: 'captureCode', globalName: 'viscraft' },
      );
      try {
        await renderOnly(handle, 100, exportedSource.params, exportedSource.seed, {
          width: BUILD_WIDTH,
          height: BUILD_HEIGHT,
        });
        return Buffer.from((await handle.page.screenshot({ type: 'png' })) as Uint8Array);
      } finally {
        await handle.close();
      }
    };
    const beforeFrame = pngPixels(await capture());

    const asideRoot = join(parent, 'hose-aside');
    await rename(root, asideRoot);

    const exportedModulePath = join(exportedPath, 'rubber-hose.mjs');
    const moduleText = await readFile(exportedModulePath, 'utf8');
    const edited = moduleText.replace('const MUG_X = 720;', 'const MUG_X = 600;');
    assert.notEqual(edited, moduleText, 'the edit targets the authored mug position');
    await writeFile(exportedModulePath, edited);
    const refreshed = await refreshCodeAsset(exportedPath, {
      assetId: 'hose_module',
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
    assert.notEqual(sha256(beforeFrame), sha256(afterFrame), 'the mug-position edit changed the lossless frame');

    assert.equal(await readFile(join(asideRoot, 'project.json'), 'utf8'), originalProject);
    assert.deepEqual(await readFile(join(asideRoot, 'rubber-hose.mjs')), originalModule);
    assert.equal(sha256(await readFile(join(asideRoot, beforeArtifact.path))), beforeHash);
    ok = true;
  } finally {
    await cleanup([parent], ok);
  }
});
