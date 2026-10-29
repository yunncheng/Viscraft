/**
 * E2E: the kinetic-type reference — real Chinese text, a complete OFL font,
 * and a readable reading-rhythm sequence.
 *
 * Proves, with the REAL author/Browser/Build path, that:
 *  - `create.mjs` authors one `browser` picture Source with a real Chinese +
 *    Latin title, a weighted emphasis and a counted number, registers the scene,
 *    module and a COMPLETE OFL font (not a subset), and carries the OFL text and
 *    the Runtime notice as licence handoffs;
 *  - the delivered font is the exact byte-identical WOFF2 whose real cmap was
 *    checked with fontTools at development time (30,890 cmap entries / 31,036
 *    glyphs, wght 100–900, every default + long-title character covered): the
 *    test pins those bytes by sha256, and the Browser proves the face is loaded
 *    and the CJK/Latin sample is actually available (not just fonts.ready);
 *  - the reading sequence runs grid → reveal → still hold → weighted emphasis →
 *    mask wipe → compact index at the real u fractions, and the rendered title
 *    is real ink (the title is drawn, the hold is calmer than the reveal, the
 *    emphasis word turns red, and the index draws);
 *  - the long Chinese title wraps at the authored minimum readable size, and the
 *    ledger variant is a different layout/picture, not a recolour;
 *  - rendering is a pure per-frame function: repeat and shuffled samples agree;
 *  - the authored Project BUILDs, exports, accepts a REAL edit of the exported
 *    module (paper/ink palette), refreshes the code Asset and rebuilds with
 *    changed decoded pixels while the original Project/module/Artifact bytes
 *    stay untouched.
 *
 * Stage samples are 640x360 and this reference's authored 192 frames. They prove the
 * layout/font/phase mechanism, not presentation approval of the full 192-frame
 * piece.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { openCodeScene } from '../src/backends/browser/capture.js';
import { buildProject } from '../src/build/build.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { refreshCodeAsset } from '../src/project/code-assets.js';
import { loadProject } from '../src/project/project.js';
import { authorRecipe, sha256 } from './authoring-helpers.js';

const STUDY_DIR = resolve('skills/viscraft/assets/studies/code-visuals/kinetic-type');
const RECIPE = join(STUDY_DIR, 'create.mjs');
const ENTRY = 'kinetic-type-scene.html';
const MODULE = 'kinetic-type.mjs';
const FONT_FILE = 'fonts/NotoSansSC-VF.woff2';
const FONT_LICENSE = 'fonts/OFL-NotoSansSC.txt';
const RESOURCES = [MODULE, FONT_FILE];

/**
 * Real cmap facts, established with the existing fontTools 4.65.0 tooling on
 * this exact WOFF2 (no Python is added to the test/runtime):
 *
 *   sha256  aef8c34277afad81ecd0227138a830263c0caea65b7aea66d1195395f097b55a
 *   size    7782072 bytes
 *   cmap    30890 entries, 31036 glyphs, wght 100..900
 *   covered 数据之后城市醒来，。阅读节奏列车夜深人静第一班穿过清晨的街口 Aa 09
 *
 * The test pins the bytes by sha256; the Browser separately proves the loaded
 * face and real CJK raster. That chain is what makes the recorded cmap apply to
 * the delivered file instead of to a look-alike.
 */
const FONT_SHA256 = 'aef8c34277afad81ecd0227138a830263c0caea65b7aea66d1195395f097b55a';
const FONT_SIZE = 7782072;

const DEFAULT_TITLE = '数据之后，城市醒来';
const DEFAULT_SUBTITLE = '阅读节奏 / A study in reading rhythm';
const LONG_TITLE = '数据之后，城市在清晨第一班列车里醒来，而海面仍在缓慢呼吸';

const WIDTH = 640;
const HEIGHT = 360;
const FRAMES = 192;
const FPS = 24;
const FRAME_BYTES = WIDTH * HEIGHT * 3;

/** This reference's authored hard frames at 192 frames / 24 fps. */
const KEY_FRAMES = {
  grid: 0,
  reveal: 23,
  hold: 85,
  emphasis: 107,
  transition: 150,
  settle: 172,
};

function decodeFrames(file: string, count: number): Buffer {
  const result = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostdin', '-i', file, '-frames:v', String(count), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 1 << 27 },
  );
  assert.equal(result.status, 0, `ffmpeg decode failed for ${file}: ${result.stderr?.toString() ?? ''}`);
  return result.stdout;
}

function changedFraction(a: Buffer, b: Buffer): number {
  assert.equal(a.length, b.length, 'compared frames must have the same size');
  let changed = 0;
  for (let i = 0; i < a.length; i += 3) {
    const distance = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (distance > 60) changed++;
  }
  return changed / (a.length / 3);
}

function frameOf(decoded: Buffer, index: number): Buffer {
  return decoded.subarray(index * FRAME_BYTES, (index + 1) * FRAME_BYTES);
}

/** Dark paper ink: the title/number/rules, not the light grid. */
function inkPixels(pixels: Buffer): number {
  let ink = 0;
  for (let i = 0; i < pixels.length; i += 3) {
    if (pixels[i] < 100 && pixels[i + 1] < 100 && pixels[i + 2] < 100) ink++;
  }
  return ink;
}

/** The authored emphasis red. */
function redPixels(pixels: Buffer): number {
  let red = 0;
  for (let i = 0; i < pixels.length; i += 3) {
    if (pixels[i] > 150 && pixels[i + 1] < 90 && pixels[i + 2] < 90) red++;
  }
  return red;
}

/**
 * Count horizontal bands of dark title ink in the left title column. The
 * single-line subtitle (muted grey) and the right-hand number are outside the
 * strip, so the count is the authored line count of the title itself.
 */
function titleBands(pixels: Buffer): number {
  let bands = 0;
  let inBand = false;
  for (let y = 140; y < 310; y++) {
    let ink = 0;
    for (let x = 20; x < 420; x++) {
      const offset = (y * WIDTH + x) * 3;
      if (pixels[offset] < 100 && pixels[offset + 1] < 100 && pixels[offset + 2] < 100) ink++;
    }
    const hasInk = ink > 5;
    if (hasInk && !inBand) bands++;
    inBand = hasInk;
  }
  return bands;
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

async function renderTo(
  scene: Awaited<ReturnType<typeof openCodeScene>>,
  frame: number,
  destination: string,
  params: Record<string, unknown>,
  seed = 4177,
): Promise<{ png: Buffer; pixels: Buffer }> {
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
      params,
      bindings: scene.bindings,
    },
  );
  const file = join(destination, `kinetic-${frame}-${seed}.png`);
  await scene.page.screenshot({ path: file, type: 'png', captureBeyondViewport: false });
  return { png: Buffer.from(await readFile(file)), pixels: pngPixels(file) };
}

function posterParams(): Record<string, unknown> {
  return {
    title: DEFAULT_TITLE,
    subtitle: DEFAULT_SUBTITLE,
    number: '24',
    emphasis: '城市',
    variant: 'poster',
    frames: FRAMES,
    titleMinSize: 44,
    titleMaxLines: 4,
  };
}

function ledgerParams(): Record<string, unknown> {
  return {
    title: LONG_TITLE,
    subtitle: '一个关于阅读节奏、城市速度与潮汐的排版练习 / Reading rhythm, urban speed and tide',
    number: '07',
    emphasis: '列车',
    variant: 'ledger',
    frames: FRAMES,
    titleMinSize: 44,
    titleMaxLines: 4,
  };
}

function englishParams(): Record<string, unknown> {
  return {
    title: 'AFTER THE SIGNAL',
    subtitle: '城市在聆听 / when the city listens',
    number: '108',
    emphasis: 'SIGNAL',
    variant: 'poster',
    frames: FRAMES,
    titleMinSize: 44,
    titleMaxLines: 4,
  };
}

// ---------------------------------------------------------------------------
// Author + Build: the real title, font closure and encoded reading sequence.
// ---------------------------------------------------------------------------
test('kinetic-type: author/build carries the real font and the reading phases', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-kinetic-build-'));
  const root = join(parent, 'kinetic');
  try {
    const { summary } = await authorRecipe({
      recipe: RECIPE,
      root,
      cwd: parent,
      options: { width: WIDTH, height: HEIGHT, frames: FRAMES },
    });

    const project = await loadProject(root);
    const source = project.sources[0];
    if (!source || source.kind !== 'browser') throw new Error('kinetic type must author one browser picture source');
    assert.equal(source.id, 'kinetic_reading');
    assert.equal(source.output, 'picture');
    assert.equal(source.entry, ENTRY);
    assert.deepEqual(source.resources, RESOURCES, 'the module and the complete font are the source closure');
    assert.equal(source.frames, FRAMES);
    assert.equal(source.seed, 4177);
    assert.equal(source.params.title, DEFAULT_TITLE);
    assert.equal(source.params.emphasis, '城市');
    assert.equal(source.params.variant, 'poster');
    assert.deepEqual(project.composition?.audio, [], 'the reference is silent');

    const byId = new Map(project.assets.map(asset => [asset.id, asset]));
    assert.deepEqual([...byId.keys()].sort(), ['kt_font', 'kt_module', 'kt_scene']);
    const font = byId.get('kt_font')!;
    assert.equal(font.path, FONT_FILE);
    assert.equal(font.type, 'font');
    assert.equal(font.rights.license, 'OFL-1.1');
    assert.match(String(font.rights.origin), /Noto Sans SC/);
    const fontBytes = await readFile(join(root, FONT_FILE));
    assert.equal(fontBytes.length, FONT_SIZE, 'the complete font is carried, not a demo subset');
    assert.equal(font.sha256, FONT_SHA256, 'the delivered font is the exact bytes whose cmap was recorded');
    assert.equal(sha256(fontBytes), FONT_SHA256);
    assert.equal(sha256(await readFile(join(root, MODULE))), sha256(await readFile(join(STUDY_DIR, MODULE))));

    assert.deepEqual((project.handoff ?? []).map(file => [file.path, file.role]).sort(), [
      ['LICENSES.md', 'license'],
      ['THIRD_PARTY_NOTICES.md', 'license'],
      [FONT_LICENSE, 'license'],
    ]);
    assert.match(await readFile(join(root, FONT_LICENSE), 'utf8'), /SIL OPEN FONT LICENSE|OFL/i);
    assert.doesNotMatch(JSON.stringify(project), /\/lustre-data\/|\/root\/|\/tmp\//);

    const built = await buildProject(root);
    assert.equal(built.status, 'succeeded', `the real build must succeed: ${built.error ?? ''}`);
    const final = built.artifacts.find(artifact => artifact.id === built.result!.artifact)!;
    assert.equal(final.media?.frames, FRAMES);
    assert.equal(built.operations.filter(operation => operation.kind === 'browser').length, 1);

    const decoded = decodeFrames(join(root, final.path), FRAMES);
    assert.equal(decoded.length, FRAME_BYTES * FRAMES, 'every authored frame decodes');
    const grid = frameOf(decoded, KEY_FRAMES.grid);
    const hold = frameOf(decoded, KEY_FRAMES.hold);
    const emphasis = frameOf(decoded, KEY_FRAMES.emphasis);
    const settle = frameOf(decoded, KEY_FRAMES.settle);

    assert.ok(inkPixels(grid) < 600, `the opening grid frame is mostly paper (${inkPixels(grid)} ink px)`);
    assert.ok(inkPixels(hold) > 3000, `the reading hold really draws the title (${inkPixels(hold)} ink px)`);
    assert.ok(
      changedFraction(grid, hold) > 0.03,
      `the title reveal changes the picture (${changedFraction(grid, hold).toFixed(4)})`,
    );
    assert.ok(redPixels(hold) < 40, 'the emphasis word is still black during the reading hold');
    assert.ok(
      redPixels(emphasis) > 20,
      `the emphasis word is weighted in red at the reading beat (${redPixels(emphasis)} red px)`,
    );
    assert.ok(changedFraction(hold, settle) > 0.05, 'the mask wipe into the index changes the remaining picture');
    assert.ok(changedFraction(settle, frameOf(decoded, FRAMES - 1)) < 0.02, 'the final index holds still');

    assert.deepEqual(
      summary.sources.map(item => item.id),
      ['kinetic_reading'],
      'authoring performs no second source or provider request',
    );

    // The long CJK/Latin replacement and the English replacement are accepted
    // by the real recipe, not only by a direct render.
    for (const [name, options] of [
      ['long', ledgerParams()],
      ['english', englishParams()],
    ] as const) {
      const altRoot = join(parent, name);
      await authorRecipe({
        recipe: RECIPE,
        root: altRoot,
        cwd: parent,
        options: { width: WIDTH, height: HEIGHT, frames: FRAMES, ...options },
      });
      const altProject = await loadProject(altRoot);
      const altSource = altProject.sources[0];
      if (!altSource || altSource.kind !== 'browser') throw new Error(`${name} must author a browser source`);
      assert.equal(altSource.params.title, options.title);
      assert.equal(altSource.params.emphasis, options.emphasis);
      assert.equal(altSource.params.variant, options.variant);
      assert.equal(altSource.resources.includes(FONT_FILE), true, `${name} keeps the complete font resource`);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Real Browser: face load, phases, long-CJK layout, determinism, missing font.
// ---------------------------------------------------------------------------
test('kinetic-type: the real face, the phase clock and the long CJK layout are observable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-kinetic-scene-'));
  const destination = await mkdtemp(join(tmpdir(), 'viscraft-kinetic-frames-'));
  try {
    await cp(STUDY_DIR, root, { recursive: true });
    const scene = await openCodeScene(
      root,
      { entry: ENTRY, resources: RESOURCES },
      { width: WIDTH, height: HEIGHT },
      { label: 'captureCode', globalName: 'viscraft' },
    );
    try {
      const face = await scene.page.evaluate(() => ({
        family: 'Noto Sans SC Kinetic',
        cjk: document.fonts.check('700 64px "Noto Sans SC Kinetic"', '数据 Aa 09，。'),
        latin: document.fonts.check('400 25px "Noto Sans SC Kinetic"', 'Reading rhythm 24'),
      }));
      assert.equal(face.cjk, true, 'the loaded face is available for the real CJK/Latin sample');
      assert.equal(face.latin, true, 'the loaded face is available for the Latin subtitle');

      const pictures: Record<string, Buffer> = {};
      const decoded: Record<string, Buffer> = {};
      for (const [phase, frame] of Object.entries(KEY_FRAMES)) {
        const result = await renderTo(scene, frame, destination, posterParams());
        pictures[phase] = result.png;
        decoded[phase] = result.pixels;
        assert.equal(result.pixels.length, FRAME_BYTES, `${phase}: a complete 640x360 picture`);
        if (phase === 'grid') assert.ok(inkPixels(decoded.grid) < 600, 'the grid phase is still mostly paper');
        if (phase === 'hold') {
          assert.ok(inkPixels(decoded.hold) > 3000, 'the hold phase draws a real CJK title');
          assert.equal(titleBands(decoded.hold), 2, 'the default Chinese title is authored on two lines');
        }
        if (phase === 'emphasis') assert.ok(redPixels(decoded.emphasis) > 50, 'the emphasis word really turns red');
        if (phase === 'transition') {
          assert.ok(
            changedFraction(decoded.emphasis, decoded.transition) > 0.05,
            'the mask wipe into the index is a real picture change',
          );
        }
        if (phase === 'settle') {
          assert.ok(
            changedFraction(decoded.hold, decoded.settle) > 0.05,
            'the mask wipe into the compact index changes the page',
          );
          assert.ok(redPixels(decoded.settle) > 20, 'the index keeps the authored red rule');
        }
      }

      // The long ledger variant wraps at the readable minimum and is a different
      // page, not a recolour of the poster.
      const ledger = await renderTo(scene, KEY_FRAMES.hold, destination, ledgerParams());
      assert.ok(inkPixels(ledger.pixels) > 3000, 'the long Chinese title is real ink, not empty layout');
      assert.ok(titleBands(ledger.pixels) >= 3, 'the long Chinese title wraps to at least three lines');
      assert.ok(
        titleBands(ledger.pixels) > titleBands(decoded.hold),
        'the long CJK title genuinely changes the line count',
      );
      assert.ok(
        changedFraction(ledger.pixels, decoded.hold) > 0.05,
        'the ledger layout is a different picture from the poster at the same beat',
      );

      // A real content replacement, not a seed change: English title and
      // emphasis with the same poster structure.
      const english = await renderTo(scene, KEY_FRAMES.hold, destination, englishParams());
      assert.ok(inkPixels(english.pixels) > 3000, 'the English replacement draws real text');
      assert.equal(titleBands(english.pixels), 2, 'the English title keeps the two-line poster layout');
      assert.ok(
        changedFraction(english.pixels, decoded.hold) > 0.05,
        'the English replacement is a different picture from the default Chinese title',
      );

      // Pure per-frame rendering: a repeat and a shuffled rerun agree with the
      // ascending sequence already sampled above.
      const phaseOfFrame = new Map<number, string>(
        Object.entries(KEY_FRAMES).map(([phase, frame]) => [frame, phase] as [number, string]),
      );
      const repeat = await renderTo(scene, KEY_FRAMES.emphasis, destination, posterParams());
      assert.ok(repeat.png.equals(pictures.emphasis), 'the same frame is byte-identical on repeat');
      for (const frame of [KEY_FRAMES.settle, KEY_FRAMES.grid, KEY_FRAMES.emphasis]) {
        const shuffled = await renderTo(scene, frame, destination, posterParams());
        const phase = phaseOfFrame.get(frame)!;
        assert.ok(shuffled.png.equals(pictures[phase]), `frame ${frame} is independent of sampling order`);
      }
    } finally {
      await scene.close();
    }

    // The font is part of the executable closure: without it, ready() fails
    // loudly instead of silently falling back to another face.
    const missing = join(root, 'missing-font');
    await cp(STUDY_DIR, missing, { recursive: true });
    await rm(join(missing, FONT_FILE), { force: true });
    await assert.rejects(
      openCodeScene(
        missing,
        { entry: ENTRY, resources: RESOURCES },
        { width: WIDTH, height: HEIGHT },
        { label: 'captureCode', globalName: 'viscraft' },
      ),
      (error: unknown) =>
        /Noto Sans SC|font failed to load|ERR_FILE_NOT_FOUND|ENOENT/i.test(String((error as Error)?.message ?? error)),
    );
  } finally {
    await rm(destination, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Build → Portable export → real module edit → rebuild.
// ---------------------------------------------------------------------------
test('kinetic-type: the exported Project accepts a real module edit and rebuilds without touching the original', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-kinetic-export-'));
  const root = join(parent, 'kinetic');
  try {
    await authorRecipe({
      recipe: RECIPE,
      root,
      cwd: parent,
      options: { width: WIDTH, height: HEIGHT, frames: FRAMES },
    });
    const originalProject = await readFile(join(root, 'project.json'), 'utf8');
    const originalModule = await readFile(join(root, MODULE));

    const before = await buildProject(root);
    assert.equal(before.status, 'succeeded', `the authored Project must build: ${before.error ?? ''}`);
    const beforeArtifact = before.artifacts.find(artifact => artifact.id === before.result!.artifact)!;
    const beforePath = join(root, beforeArtifact.path);
    const beforeHash = sha256(await readFile(beforePath));
    const beforeDecoded = decodeFrames(beforePath, FRAMES);

    const exportedPath = join(parent, 'exported');
    await exportProject(root, exportedPath);
    assert.equal(
      await readFile(join(root, 'project.json'), 'utf8'),
      originalProject,
      'export does not edit the original',
    );
    assert.equal(
      sha256(await readFile(join(root, MODULE))),
      sha256(originalModule),
      'export does not edit the original bytes',
    );

    const exported = await loadProject(exportedPath);
    for (const asset of exported.assets) {
      assert.equal(sha256(await readFile(join(exportedPath, asset.path))), asset.sha256, `${asset.path} closure`);
    }
    assert.equal((await readFile(join(exportedPath, FONT_FILE))).length, FONT_SIZE, 'the complete font travels');

    const asideRoot = join(parent, 'kinetic-aside');
    await rename(root, asideRoot);

    // A real authoring edit of the exported module: the paper/ink palette is
    // inverted, which must reach the decoded picture, not only the hash.
    const exportedModulePath = join(exportedPath, MODULE);
    const moduleText = await readFile(exportedModulePath, 'utf8');
    const edited = moduleText
      .replace("const PAPER = '#EAE9E5';", "const PAPER = '#0E1622';")
      .replace("const INK = '#111111';", "const INK = '#F5F1E8';");
    assert.notEqual(edited, moduleText, 'the real code edit targets the authored palette');
    await writeFile(exportedModulePath, edited);
    const refreshed = await refreshCodeAsset(exportedPath, {
      assetId: 'kt_module',
      expectedRevision: exported.revision,
    });
    assert.equal(refreshed.sha256, sha256(Buffer.from(edited)));

    const rebuilt = await buildProject(exportedPath);
    assert.equal(rebuilt.status, 'succeeded', `the exported Project must rebuild: ${rebuilt.error ?? ''}`);
    const afterPath = join(
      exportedPath,
      rebuilt.artifacts.find(artifact => artifact.id === rebuilt.result!.artifact)!.path,
    );
    const afterDecoded = decodeFrames(afterPath, FRAMES);
    assert.ok(
      changedFraction(frameOf(beforeDecoded, KEY_FRAMES.hold), frameOf(afterDecoded, KEY_FRAMES.hold)) > 0.4,
      'the exported palette edit changed the decoded picture',
    );

    assert.equal(
      await readFile(join(asideRoot, 'project.json'), 'utf8'),
      originalProject,
      'the original Project is untouched',
    );
    assert.equal(
      sha256(await readFile(join(asideRoot, MODULE))),
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
