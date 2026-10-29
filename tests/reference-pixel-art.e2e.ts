/**
 * E2E: the pixel-art reference — a 320x180 INDEXED framebuffer, integer
 * nearest presentation and a real character action.
 *
 * Proves, with the REAL author/Browser/Build/export path, that:
 *  - `create.mjs` authors TWO browser picture Sources (wren_offer / arlo_guard)
 *    over one entry and the same four modules, with the real seeds/params, MIT
 *    rights, the upstream MIT text + Runtime notice, and no audio bed;
 *  - the picture is a real palette-index framebuffer: `T=255` is a sentinel that
 *    is never written, the protected indices 32..38 stay byte-identical through
 *    `LUT.faded` while ordinary indices fade, and the response frame uses more
 *    palette colours than the opening frame;
 *  - the sprite rig returns its real anchor ox=24/oy=44 and the cast staff tip
 *    (null for Arlo), and the bitmap font is exactly 80 ASCII glyphs (ASCII-only,
 *    but NOT the full upstream font — that one also carries ▶/▼ — and NOT a claim
 *    of full ASCII coverage): the font primitive falls back to `?`, while the
 *    SCENE rejects an uncovered caption with a coverage error (no system/CJK
 *    fallback);
 *  - presentation is integer nearest-neighbour: at 2x every 2x2 block is one
 *    logical pixel; at 700x400 the content is 2x with a black letterbox; and a
 *    canvas below 320x180 is rejected;
 *  - the authored clock (timelineAt) resolves walk/kneel/cast and
 *    stand/plant/guard/look at the real phase frames, with a monotonic response;
 *  - rendering is a pure per-frame function (repeat and shuffled order agree);
 *  - the authored Project BUILDs, exports, accepts a REAL edit of the exported
 *    scene module (the actor ground anchor/local blocking), rebuilds with
 *    changed lossless frame bytes while the original Project/module/Artifact
 *    bytes stay untouched.
 *
 * SCOPE: the Project is authored at 320x180 / 48 frames for speed. The clock is
 * fraction-based and the owner confirmed the beats resolve at 16 frames, so this
 * is a compressed full-phase sample, not a prefix. The final look and the
 * authored 144-frame pacing remain for the lead/author visual review. This is a
 * low-level pixel-art study, not an RPG/World/input/menu/save system.
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

const STUDY_DIR = resolve('skills/viscraft/assets/studies/code-visuals/pixel-art');
const RECIPE = join(STUDY_DIR, 'create.mjs');
const ENTRY = 'pixel-art-scene.html';
const RESOURCES = ['pixel-art-scene.mjs', 'px.mjs', 'sprites.mjs', 'font.mjs'];
const LOGICAL_WIDTH = 320;
const LOGICAL_HEIGHT = 180;
const WIDTH = LOGICAL_WIDTH * 2;
const HEIGHT = LOGICAL_HEIGHT * 2;
const FRAMES = 48;
const FPS = 24;

interface PixelModule {
  W: number;
  H: number;
  T: number;
  NPAL: number;
  PROTECT: Set<number>;
  RGB: Array<[number, number, number]>;
  LUT: Record<string, Uint32Array>;
  FB: new (
    w?: number,
    h?: number,
  ) => {
    w: number;
    h: number;
    d: Uint8Array;
    clear(c?: number): void;
    px(x: number, y: number, c: number): void;
    get(x: number, y: number): number;
    rect(x: number, y: number, w: number, h: number, c: number): void;
  };
}

interface SpriteModule {
  drawChar(
    ch: string,
    pose: string,
    opts?: Record<string, unknown>,
  ): {
    w: number;
    h: number;
    d: Uint8Array;
    ox: number;
    oy: number;
    staffTip: { x: number; y: number } | null;
  };
}

interface FontModule {
  COVERAGE: string;
  hasGlyph(ch: string): boolean;
  glyphW(ch: string): number;
  text(
    fb: { rect(x: number, y: number, w: number, h: number, c: number): void },
    s: string,
    x: number,
    y: number,
    col: number,
  ): number;
}

interface SceneModule {
  VARIANTS: string[];
  SUBJECT: Record<string, string>;
  GROUND: number;
  timelineAt(
    frame: number,
    options?: { frames?: number; variant?: string; caption?: string },
  ): {
    frame: number;
    frames: number;
    variant: string;
    subject: string;
    phase: string;
    pose: string;
    fromPose: string;
    toPose: string;
    mix: number;
    x: number;
    facing: number;
    wind: number;
    response: number;
    flood: number;
    crystal: number;
    lamps: number;
    caption: string;
    u: number;
  };
}

const px = (await import(pathToFileURL(join(STUDY_DIR, 'px.mjs')).href)) as unknown as PixelModule;
const sprites = (await import(pathToFileURL(join(STUDY_DIR, 'sprites.mjs')).href)) as unknown as SpriteModule;
const font = (await import(pathToFileURL(join(STUDY_DIR, 'font.mjs')).href)) as unknown as FontModule;
const scene = (await import(pathToFileURL(join(STUDY_DIR, 'pixel-art-scene.mjs')).href)) as unknown as SceneModule;

function decodeFrames(file: string, count: number): Buffer {
  const result = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostdin', '-i', file, '-frames:v', String(count), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 1 << 27 },
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

/** Pixels off the darkest/lightest extremes: the scene is really drawn. */
function drawnPixels(pixels: Buffer): number {
  let count = 0;
  for (let i = 0; i < pixels.length; i += 3) {
    const luminance = (pixels[i] * 299 + pixels[i + 1] * 587 + pixels[i + 2] * 114) / 1000;
    if (luminance > 24 && luminance < 248) count++;
  }
  return count;
}

/** Distinct RGB colours; an indexed framebuffer through a palette LUT is bounded. */
function uniqueColours(pixels: Buffer): number {
  const seen = new Set<number>();
  for (let i = 0; i < pixels.length; i += 3) seen.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]);
  return seen.size;
}

/** Fraction of 2x2 blocks whose four pixels are not identical. */
function nonBlockFraction(pixels: Buffer, width: number, x0: number, y0: number, w: number, h: number): number {
  let bad = 0;
  let total = 0;
  for (let y = y0; y < y0 + h; y += 2) {
    for (let x = x0; x < x0 + w; x += 2) {
      const a = (y * width + x) * 3;
      const b = (y * width + x + 1) * 3;
      const c = ((y + 1) * width + x) * 3;
      const d = ((y + 1) * width + x + 1) * 3;
      const same =
        pixels[a] === pixels[b] &&
        pixels[a + 1] === pixels[b + 1] &&
        pixels[a + 2] === pixels[b + 2] &&
        pixels[a] === pixels[c] &&
        pixels[a + 1] === pixels[c + 1] &&
        pixels[a + 2] === pixels[c + 2] &&
        pixels[a] === pixels[d] &&
        pixels[a + 1] === pixels[d + 1] &&
        pixels[a + 2] === pixels[d + 2];
      if (!same) bad++;
      total++;
    }
  }
  return bad / total;
}

/** First frame at which the authored clock reports the phase. */
function phaseFrame(variant: string, phase: string, frames = FRAMES): number {
  for (let frame = 0; frame < frames; frame++) {
    if (scene.timelineAt(frame, { frames, variant }).phase === phase) return frame;
  }
  throw new Error(`phase ${phase} does not occur in ${variant} at ${frames} frames`);
}

/**
 * First frame of the phase whose blend has settled (mix === 1). `phaseFrame`
 * returns the transition START (e.g. kneel at 20 still renders `breathe` with
 * mix 0, and cast at 28 still renders `kneel` with mix 0).
 */
function settledFrame(variant: string, phase: string, frames = FRAMES): number {
  for (let frame = 0; frame < frames; frame++) {
    const at = scene.timelineAt(frame, { frames, variant });
    if (at.phase === phase && at.mix === 1) return frame;
  }
  throw new Error(`phase ${phase} never settles in ${variant} at ${frames} frames`);
}

async function renderOnly(
  handle: Awaited<ReturnType<typeof openCodeScene>>,
  frame: number,
  params: Record<string, unknown>,
  seed: number,
  size: { width: number; height: number },
): Promise<void> {
  await handle.page.evaluate(
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
  const file = join(destination, `pixel-${frame}-${size.width}x${size.height}.png`);
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

// ---------------------------------------------------------------------------
// Index buffer, protected palette, anchor, font coverage and caption rejection.
// ---------------------------------------------------------------------------
test('pixel-art: the index buffer, protected colours, anchor and font are real', () => {
  assert.equal(px.W, LOGICAL_WIDTH);
  assert.equal(px.H, LOGICAL_HEIGHT);
  assert.equal(px.T, 255, 'the transparent index is 255');
  assert.equal(px.NPAL, 39, 'ENDESGA-32 plus seven protected indices');
  assert.deepEqual(
    [...px.PROTECT].sort((a, b) => a - b),
    [32, 33, 34, 35, 36, 37, 38],
  );

  const fb = new px.FB(8, 8);
  assert.ok(fb.d instanceof Uint8Array, 'the framebuffer is a real byte index buffer');
  fb.clear(0);
  fb.px(1, 1, px.T);
  assert.equal(fb.get(1, 1), 0, 'index 255 is never written');
  fb.px(2, 2, 5);
  assert.equal(fb.get(2, 2), 5);
  assert.equal(fb.get(-1, 0), px.T, 'out-of-bounds reads report transparency');

  const pack = ([r, g, b]: [number, number, number]) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
  for (const index of px.PROTECT) {
    assert.equal(px.LUT.faded[index] >>> 0, pack(px.RGB[index]), `protected index ${index} survives the faded LUT`);
  }
  for (const index of [8, 9, 12, 17, 26]) {
    assert.notEqual(px.LUT.faded[index] >>> 0, pack(px.RGB[index]), `ordinary index ${index} really fades`);
  }

  for (const [character, pose] of [
    ['wren', 'walk0'],
    ['arlo', 'guard'],
  ] as const) {
    const sprite = sprites.drawChar(character, pose);
    assert.equal(sprite.w, 48);
    assert.equal(sprite.h, 48);
    assert.equal(sprite.ox, 24, `${character} anchor ox`);
    assert.equal(sprite.oy, 44, `${character} anchor oy`);
    assert.equal(sprite.d.length, sprite.w * sprite.h);
    assert.ok(sprite.d.includes(px.T), 'the sprite keeps transparent padding');
  }

  // The scene starts the cast beam at the staff tip for the CURRENT blend, so
  // the rig must report a real tip for Wren and none for Arlo.
  for (const pose of ['walk0', 'kneel', 'cast'] as const) {
    const tip = sprites.drawChar('wren', pose).staffTip;
    assert.ok(tip !== null, `Wren's ${pose} pose reports a staff tip`);
    assert.ok(Number.isFinite(tip!.x) && Number.isFinite(tip!.y), `Wren's ${pose} staff tip is a point`);
  }
  assert.equal(sprites.drawChar('arlo', 'guard').staffTip, null, 'Arlo carries no staff');
  assert.equal(sprites.drawChar('arlo', 'guardlook').staffTip, null, 'Arlo carries no staff');

  assert.equal(font.COVERAGE.length, 80, 'the bitmap font carries exactly 80 glyphs');
  assert.ok(font.COVERAGE.includes('A') && font.COVERAGE.includes('z') && font.COVERAGE.includes('7'));
  for (const ch of font.COVERAGE) {
    assert.ok(ch.codePointAt(0)! < 128, `the bitmap font covers ASCII only (found ${JSON.stringify(ch)})`);
  }
  for (const ch of ".,!?'-:/()=+%") assert.ok(font.hasGlyph(ch), `punctuation ${JSON.stringify(ch)} has a glyph`);
  assert.equal(font.hasGlyph('中'), false, 'CJK is not covered');
  assert.equal(font.glyphW('中'), font.glyphW('?'), 'the uncovered glyph uses the ? width');
  const a = new px.FB(32, 12);
  const b = new px.FB(32, 12);
  font.text(a, '中', 0, 0, 19);
  font.text(b, '?', 0, 0, 19);
  assert.deepEqual(Array.from(a.d), Array.from(b.d), 'the font primitive really falls back to ?');

  // The SCENE does not silently fall back: an uncovered caption is rejected
  // with the coverage list, so a CJK caption can never be presented as glyphs.
  assert.throws(
    () => scene.timelineAt(0, { frames: FRAMES, variant: 'offer', caption: 'HELLO 世界' }),
    /does not cover|supported characters/,
    'the scene rejects a caption the bitmap font cannot draw',
  );
});

// ---------------------------------------------------------------------------
// The authored clock: real phase frames and a monotonic response.
// ---------------------------------------------------------------------------
test('pixel-art: the authored clock moves both characters through every phase', () => {
  const offer = scene.timelineAt(FRAMES - 1, { frames: FRAMES, variant: 'offer' });
  assert.equal(offer.phase, 'cast');
  assert.equal(offer.pose, 'cast');
  assert.equal(offer.subject, 'wren');
  assert.equal(offer.response, 1);
  assert.equal(offer.crystal, 1);
  assert.ok(offer.x > scene.timelineAt(0, { frames: FRAMES, variant: 'offer' }).x, 'Wren walks into position');

  const guard = scene.timelineAt(FRAMES - 1, { frames: FRAMES, variant: 'guard' });
  assert.equal(guard.phase, 'look');
  assert.equal(guard.pose, 'guardlook');
  assert.equal(guard.subject, 'arlo');
  assert.equal(guard.lamps, 1);

  // Every phase resolves inside this compressed 48-frame sample.
  for (const [variant, phases] of [
    ['offer', ['walk', 'settle', 'kneel', 'cast']],
    ['guard', ['stand', 'plant', 'guard', 'look']],
  ] as const) {
    for (const phase of phases) assert.ok(phaseFrame(variant, phase) >= 0, `${variant} reaches ${phase}`);
  }

  // The response is monotonic and spans 0 → 1 exactly once.
  let previous = 0;
  let seenStart = false;
  for (let frame = 0; frame < FRAMES; frame++) {
    const response = scene.timelineAt(frame, { frames: FRAMES, variant: 'offer' }).response;
    assert.ok(response >= previous, 'the crystal response never goes backwards');
    if (previous === 0 && response > 0) seenStart = true;
    previous = response;
  }
  assert.equal(seenStart, true);
  assert.equal(previous, 1);

  // The final cast is a held pose: position and response stop changing.
  const last = scene.timelineAt(FRAMES - 1, { frames: FRAMES, variant: 'offer' });
  const earlier = scene.timelineAt(FRAMES - 4, { frames: FRAMES, variant: 'offer' });
  assert.equal(last.x, earlier.x, 'the cast holds its position');
  assert.equal(last.pose, earlier.pose);
  assert.equal(last.response, earlier.response);
});

// ---------------------------------------------------------------------------
// Author: two Sources, the real closure and rights.
// ---------------------------------------------------------------------------
test('pixel-art: create.mjs authors both variants with the real closure', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-pixel-author-'));
  const root = join(parent, 'pixel');
  let ok = false;
  try {
    await authorRecipe({
      recipe: RECIPE,
      root,
      cwd: parent,
      options: { width: LOGICAL_WIDTH, height: LOGICAL_HEIGHT, frames: FRAMES },
    });

    const project = await loadProject(root);
    assert.equal(project.sources.length, 2);
    assert.deepEqual(
      project.sources.map(source => {
        if (source.kind !== 'browser') throw new Error('pixel-art sources must be browser sources');
        return [source.id, source.seed, source.params];
      }),
      [
        ['wren_offer', 4201, { variant: 'offer', frames: FRAMES, caption: 'STILL SHRINE: RESTORED' }],
        ['arlo_guard', 4202, { variant: 'guard', frames: FRAMES, caption: 'THE KEEPING: HELD' }],
      ],
      'the two character/stance variants are the meaningful content change',
    );
    for (const source of project.sources) {
      if (source.kind !== 'browser') throw new Error('pixel-art sources must be browser sources');
      assert.equal(source.output, 'picture');
      assert.equal(source.entry, ENTRY);
      assert.deepEqual(source.resources, RESOURCES);
      assert.equal(source.frames, FRAMES);
    }
    assert.deepEqual(project.composition?.audio, []);
    assert.deepEqual(project.assets.map(asset => [asset.id, asset.path, asset.type, asset.rights.license]).sort(), [
      ['pixel_art_engine', 'px.mjs', 'code', 'Apache-2.0 AND MIT'],
      ['pixel_art_font', 'font.mjs', 'code', 'Apache-2.0 AND MIT'],
      ['pixel_art_scene', ENTRY, 'code', 'Apache-2.0 AND MIT'],
      ['pixel_art_sprites', 'sprites.mjs', 'code', 'Apache-2.0 AND MIT'],
      ['pixel_art_stage', 'pixel-art-scene.mjs', 'code', 'Apache-2.0 AND MIT'],
    ]);
    for (const asset of project.assets) {
      assert.equal(asset.sha256, sha256(await readFile(join(root, asset.path))), `${asset.path} hash is real`);
    }
    assert.match(String(project.assets.find(asset => asset.id === 'pixel_art_stage')!.rights.origin), /LemoLab/i);
    assert.deepEqual((project.handoff ?? []).map(file => [file.path, file.role]).sort(), [
      ['LICENSE-LemoLab-MIT.txt', 'license'],
      ['LICENSES.md', 'license'],
      ['THIRD_PARTY_NOTICES.md', 'license'],
    ]);
    assert.match(await readFile(join(root, 'LICENSE-LemoLab-MIT.txt'), 'utf8'), /MIT License[\s\S]*LemoLab/);
    assert.doesNotMatch(JSON.stringify(project), /\/lustre-data\/|\/root\/|\/tmp\//);
    ok = true;
  } finally {
    await cleanup([parent], ok);
  }
});

// ---------------------------------------------------------------------------
// Real Build: every frame decodes, both takes are complete, the variants differ.
// ---------------------------------------------------------------------------
test('pixel-art: the authored Project builds both takes and every frame decodes', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-pixel-build-'));
  const root = join(parent, 'pixel');
  let ok = false;
  try {
    await authorRecipe({
      recipe: RECIPE,
      root,
      cwd: parent,
      options: { width: LOGICAL_WIDTH, height: LOGICAL_HEIGHT, frames: FRAMES },
    });
    const built = await buildProject(root);
    assert.equal(built.status, 'succeeded', `the real build must succeed: ${built.error ?? ''}`);
    assert.equal(built.result?.simulated, false);
    const final = built.artifacts.find(artifact => artifact.id === built.result!.artifact)!;
    assert.equal(final.media?.frames, FRAMES * 2, 'the programme holds both takes');
    assert.equal(built.operations.filter(operation => operation.kind === 'browser').length, 2);

    const frameBytes = LOGICAL_WIDTH * LOGICAL_HEIGHT * 3;
    const decoded = decodeFrames(join(root, final.path), FRAMES * 2);
    assert.equal(decoded.length, frameBytes * FRAMES * 2, 'every authored frame decodes at 320x180');
    const frame = (index: number) => decoded.subarray(index * frameBytes, (index + 1) * frameBytes);
    const digest = (index: number) => sha256(frame(index));

    const walk = phaseFrame('offer', 'walk');
    const kneel = settledFrame('offer', 'kneel');
    const cast = settledFrame('offer', 'cast');
    const answer = FRAMES - 1;
    assert.ok(drawnPixels(frame(walk)) > 0, 'the walk frame is drawn');
    assert.notEqual(digest(walk), digest(kneel), 'walk → kneel changes the decoded picture');
    assert.notEqual(digest(kneel), digest(cast), 'kneel → cast changes the decoded picture');
    assert.notEqual(digest(cast), digest(answer), 'the crystal response changes the decoded picture');

    // The second take is a different subject/pose/event.
    const guard = phaseFrame('guard', 'guard');
    assert.notEqual(digest(cast), digest(FRAMES + guard), 'offer and guard are different pictures');
    assert.equal(scene.timelineAt(cast, { frames: FRAMES, variant: 'offer' }).subject, 'wren');
    assert.equal(scene.timelineAt(guard, { frames: FRAMES, variant: 'guard' }).subject, 'arlo');
    ok = true;
  } finally {
    await cleanup([parent], ok);
  }
});

// ---------------------------------------------------------------------------
// Direct Browser: integer nearest, letterbox, palette response, determinism.
// ---------------------------------------------------------------------------
test('pixel-art: presentation is integer nearest-neighbour and the palette responds', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-pixel-scene-'));
  const root = join(parent, 'pixel');
  const destination = await mkdtemp(join(tmpdir(), 'viscraft-pixel-frames-'));
  let ok = false;
  try {
    await authorRecipe({
      recipe: RECIPE,
      root,
      cwd: parent,
      options: { width: LOGICAL_WIDTH, height: LOGICAL_HEIGHT, frames: FRAMES },
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
      const early = await renderAt(handle, 2, source.params, source.seed, destination);
      const late = await renderAt(handle, FRAMES - 1, source.params, source.seed, destination);
      assert.equal(late.pixels.length, WIDTH * HEIGHT * 3);
      assert.ok(drawnPixels(late.pixels) > 0, 'the 2x picture is drawn');
      assert.equal(
        nonBlockFraction(late.pixels, WIDTH, 0, 0, WIDTH, HEIGHT),
        0,
        'at 2x every 2x2 block is one logical pixel: nearest-neighbour, no interpolation',
      );
      const earlyColours = uniqueColours(early.pixels);
      const lateColours = uniqueColours(late.pixels);
      assert.ok(earlyColours >= px.NPAL / 4, 'the faded opening is a real palette picture');
      assert.ok(lateColours <= px.NPAL + 7, `the framebuffer stays palette-indexed (${lateColours} colours)`);
      assert.ok(lateColours > earlyColours, 'the response really returns more palette colours');

      // A composition that is NOT an integer multiple of 320x180: integer
      // scale (2x) plus a black letterbox, never a fractional stretch.
      await handle.page.setViewport({ width: 700, height: 400, deviceScaleFactor: 1 });
      const odd = await renderAt(handle, FRAMES - 1, source.params, source.seed, destination, {
        width: 700,
        height: 400,
      });
      const scale = Math.min(Math.floor(700 / LOGICAL_WIDTH), Math.floor(400 / LOGICAL_HEIGHT));
      assert.equal(scale, 2);
      const contentWidth = LOGICAL_WIDTH * scale;
      const contentHeight = LOGICAL_HEIGHT * scale;
      const offsetX = Math.floor((700 - contentWidth) / 2);
      const offsetY = Math.floor((400 - contentHeight) / 2);
      const isBlack = (x: number, y: number) => {
        const offset = (y * 700 + x) * 3;
        return odd.pixels[offset] === 0 && odd.pixels[offset + 1] === 0 && odd.pixels[offset + 2] === 0;
      };
      for (let y = 0; y < 400; y++) {
        for (let x = 0; x < offsetX; x++) assert.ok(isBlack(x, y), `the left letterbox is black at (${x},${y})`);
        for (let x = offsetX + contentWidth; x < 700; x++) {
          assert.ok(isBlack(x, y), `the right letterbox is black at (${x},${y})`);
        }
      }
      for (let y = 0; y < offsetY; y++) {
        for (let x = 0; x < 700; x++) assert.ok(isBlack(x, y), `the top letterbox is black at (${x},${y})`);
      }
      for (let y = offsetY + contentHeight; y < 400; y++) {
        for (let x = 0; x < 700; x++) assert.ok(isBlack(x, y), `the bottom letterbox is black at (${x},${y})`);
      }
      assert.equal(
        nonBlockFraction(odd.pixels, 700, offsetX, offsetY, contentWidth, contentHeight),
        0,
        'the odd-size content is a 2x nearest-neighbour block picture',
      );

      // A canvas below the logical size is rejected, not stretched.
      await handle.page.setViewport({ width: 300, height: 160, deviceScaleFactor: 1 });
      await assert.rejects(
        renderOnly(handle, 0, source.params, source.seed, { width: 300, height: 160 }),
        /at least 320x180/,
      );

      await handle.page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
      const repeat = await renderAt(handle, FRAMES - 1, source.params, source.seed, destination);
      assert.ok(repeat.png.equals(late.png), 'the same frame is byte-identical on repeat');
      for (const other of [0, settledFrame('offer', 'kneel')]) {
        await renderAt(handle, other, source.params, source.seed, destination);
      }
      const again = await renderAt(handle, FRAMES - 1, source.params, source.seed, destination);
      assert.ok(again.png.equals(late.png), 'the frame is independent of sampling order (pure renderer)');
      ok = true;
    } finally {
      await handle.close();
    }
  } finally {
    await cleanup([destination, parent], ok);
  }
});

// ---------------------------------------------------------------------------
// Build → Portable export → real scene edit → lossless same-frame compare.
// ---------------------------------------------------------------------------
test('pixel-art: the exported scene accepts a real ground-anchor edit and rebuilds', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-pixel-export-'));
  const root = join(parent, 'pixel');
  let ok = false;
  try {
    await authorRecipe({
      recipe: RECIPE,
      root,
      cwd: parent,
      options: { width: LOGICAL_WIDTH, height: LOGICAL_HEIGHT, frames: FRAMES },
    });
    const originalProject = await readFile(join(root, 'project.json'), 'utf8');
    const originalModule = await readFile(join(root, 'pixel-art-scene.mjs'));

    const before = await buildProject(root);
    assert.equal(before.status, 'succeeded', `the authored Project must build: ${before.error ?? ''}`);
    const beforeArtifact = before.artifacts.find(artifact => artifact.id === before.result!.artifact)!;
    const beforeHash = sha256(await readFile(join(root, beforeArtifact.path)));

    const exportedPath = join(parent, 'exported');
    await exportProject(root, exportedPath);
    assert.equal(await readFile(join(root, 'project.json'), 'utf8'), originalProject);
    assert.equal(sha256(await readFile(join(root, 'pixel-art-scene.mjs'))), sha256(originalModule));

    const exported = await loadProject(exportedPath);
    for (const asset of exported.assets) {
      assert.equal(sha256(await readFile(join(exportedPath, asset.path))), asset.sha256, `${asset.path} closure`);
    }
    for (const file of exported.handoff ?? []) {
      assert.equal(sha256(await readFile(join(exportedPath, file.path))).length, 64, `${file.path} travels`);
    }

    const exportedSource = browserSource(exported);
    const frame = settledFrame('offer', 'cast');
    const capture = async (): Promise<Buffer> => {
      const handle = await openCodeScene(
        exportedPath,
        { entry: exportedSource.entry, resources: exportedSource.resources },
        { width: LOGICAL_WIDTH, height: LOGICAL_HEIGHT },
        { label: 'captureCode', globalName: 'viscraft' },
      );
      try {
        await renderOnly(handle, frame, exportedSource.params, exportedSource.seed, {
          width: LOGICAL_WIDTH,
          height: LOGICAL_HEIGHT,
        });
        return Buffer.from((await handle.page.screenshot({ type: 'png' })) as Uint8Array);
      } finally {
        await handle.close();
      }
    };
    const beforeFrame = pngPixels(await capture());

    const asideRoot = join(parent, 'pixel-aside');
    await rename(root, asideRoot);

    const exportedModulePath = join(exportedPath, 'pixel-art-scene.mjs');
    const moduleText = await readFile(exportedModulePath, 'utf8');
    const edited = moduleText.replace('export const GROUND = 152;', 'export const GROUND = 136;');
    assert.notEqual(edited, moduleText, 'the edit targets the actor ground anchor');
    await writeFile(exportedModulePath, edited);
    const refreshed = await refreshCodeAsset(exportedPath, {
      assetId: 'pixel_art_stage',
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
    assert.notEqual(sha256(beforeFrame), sha256(afterFrame), 'the ground-anchor edit changed the lossless frame');

    assert.equal(await readFile(join(asideRoot, 'project.json'), 'utf8'), originalProject);
    assert.deepEqual(await readFile(join(asideRoot, 'pixel-art-scene.mjs')), originalModule);
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
