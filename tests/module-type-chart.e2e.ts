/**
 * E2E: the reusable type + chart author module.
 *
 * Proves, with the REAL browser capture path, that:
 *  - the module's pure helpers behave (CJK-aware breaking/fitting with an
 *    injected measure, "nice" ticks + invertible linear scale, staged bar/line
 *    geometry, lagged reveal, loud param validation) — fast, no browser;
 *  - `create.mjs` vendors its files byte-for-byte, registers them as `code`
 *    Assets with the real sha256 AND the honest MIT rights (never CC0), authors
 *    one `browser` Source and BUILDS with the real Runtime;
 *  - a cold start renders real frames at TWO sizes (16:9 and 9:16);
 *  - rendering is deterministic: the same frame twice is byte-identical and
 *    sampling order does not matter (the reveal is a pure function of frame);
 *  - the staged reveal actually advances: later frames have more drawn pixels
 *    than the (near-empty) first frame, and every frame hash is distinct;
 *  - a missing declared resource fails loudly rather than rendering blank.
 *
 * The module is plain ESM, so the pure tests import it directly; the frame tests
 * only render tiny sizes and a handful of frames to stay fast.
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

// The module and its scene have one source in the type-chart fixture.
const MODULE_DIR = resolve('tests/fixtures/authoring/type-chart');
const RECIPE_DIR = MODULE_DIR;
const TYPE_MJS = join(MODULE_DIR, 'type-chart.mjs');
const TYPE_HTML = join(RECIPE_DIR, 'type-scene.html');
const ENTRY = 'type-scene.html';
const RESOURCES = ['type-chart.mjs'];

type Params = Record<string, unknown>;
type Measure = (text: string, size: number, letterSpacing?: number) => number;

interface TypeChartModule {
  EASING_NAMES: string[];
  DEFAULT_PARAMS: { text: string; chart: { values: number[] } };
  normalizeParams(raw?: Params): Params & { text: string; chart: { values: number[]; labels: string[] } };
  fontString(spec: { size: number; family?: string; weight?: number }): string;
  tokenize(text: string): string[];
  breakLines(text: string, maxW: number, measure: (s: string) => number): string[];
  fitText(text: string, opts: Params): { size: number; lines: string[]; ok: boolean };
  alignX(align: string, x: number, w: number): number;
  tabularCells(str: string, digitW: number, measure: (s: string) => number): { widths: number[]; total: number };
  formatNumber(v: number, dec?: number, sep?: boolean): string;
  revealCount(str: string, p: number): string;
  charRevealSpec(str: string, opts: Params): { chars: string[]; widths: number[]; total: number };
  charRevealFrame(
    spec: unknown,
    t: number,
    opts: Params,
  ): { glyphs: Array<{ alpha: number; visible: boolean }>; totalWidth: number };
  lineRevealFrame(lines: string[], t: number, opts: Params): Array<{ alpha: number; dy: number }>;
  markerRect(x: number, y: number, w: number, h: number, p: number, opts?: Params): Array<[number, number]>;
  underlineSegment(
    x: number,
    y: number,
    w: number,
    p: number,
    opts?: Params,
  ): { x0: number; y0: number; x1: number; y1: number };
  linearScale(d0: number, d1: number, r0: number, r1: number): ((v: number) => number) & { inv(y: number): number };
  niceTicks(min: number, max: number, n?: number): number[];
  parseHex(hex: string): [number, number, number];
  mixHex(a: string, b: string, t: number): string;
  lagged(index: number, count: number, p: number, lag: number): number;
  barGeometry(
    data: Array<{ x: number; v: number }>,
    yS: (v: number) => number,
    p: number,
    opts?: Params,
  ): Array<{ x: number; y: number; base: number; value: number; q: number }>;
  lineGeometry(
    pts: Array<[number, number]>,
    p: number,
  ): { vis: Array<[number, number]>; head: [number, number]; xEnd: number };
  yAtX(pts: Array<[number, number]>, x: number): number;
  candleGeometry(
    rows: Array<{ o: number; h: number; l: number; c: number }>,
    xs: number[],
    yS: (v: number) => number,
    p: number,
    opts?: Params,
  ): Array<{ isUp: boolean; colour: string }>;
  gridFrame(
    ys: number[],
    yS: (v: number) => number,
    p: number,
    opts?: Params,
  ): Array<{ value: number; y: number; alpha: number }>;
  xLabelFrame(
    items: Array<{ x: number; label: string }>,
    p: number,
    opts?: Params,
  ): Array<{ alpha: number; dy: number }>;
  calloutFrame(t: number, t0: number, opts?: Params): { dotR: number; lineP: number; textP: number } | null;
  revealProgress(frame: number, opts?: Params): number;
}

const mod = (await import(pathToFileURL(TYPE_MJS).href)) as unknown as TypeChartModule;

const FPS = 24;

/** Deterministic synthetic metrics: CJK 1.0em, letters/digits 0.5em, space 0.3em. */
const fakeMeasure: Measure = (text, size) =>
  [...String(text)].reduce((a, ch) => {
    const w = /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 1.0 : /\s/.test(ch) ? 0.3 : 0.5;
    return a + w * size;
  }, 0);
const measureAt = (size: number) => (s: string) => fakeMeasure(s, size);

const CHART_PARAMS: Params = {
  text: '数据叙事 Data Story',
  subtitle: 'Index, 2020 = 100',
  revealFrames: 12,
  chart: {
    values: [38, 52, 44, 61, 55, 72, 80],
    labels: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7'],
    highlight: 6,
  },
};

const BG: [number, number, number] = [247, 246, 242];

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
  const root = await mkdtemp(join(tmpdir(), 'viscraft-type-'));
  await copyFile(TYPE_HTML, join(root, ENTRY));
  await copyFile(TYPE_MJS, join(root, 'type-chart.mjs'));
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

function frameArgs(
  frame: number,
  width: number,
  height: number,
  seed: number,
  params: Params,
  bindings: Record<string, { id: string; url: string; sha256: string }>,
): Record<string, unknown> {
  return { frame, time: frame / FPS, fps: FPS, width, height, seed, params, bindings };
}

// ---------------------------------------------------------------------------
// Pure helpers: the text mechanism, the chart math and the staged reveal.
// ---------------------------------------------------------------------------
test('type-chart module: CJK-aware text, chart math and staged reveal are correct', () => {
  const defaults = mod.normalizeParams({});
  assert.equal(typeof defaults.text, 'string');
  assert.ok(defaults.text.length > 0);
  assert.equal(defaults.chart.values.length, 7);

  // Loud validation.
  assert.throws(() => mod.normalizeParams({ chart: { values: [1, 2], labels: ['only-one'] } }), /labels/);
  assert.throws(() => mod.normalizeParams({ chart: { values: [], labels: [] } }), /values/);
  assert.throws(
    () => mod.normalizeParams({ chart: { values: [1, 2], labels: ['a', 'b'], highlight: 9 } }),
    /highlight/,
  );
  // `highlight` is validated before `yMin`/`yMax`; pass a valid one so the ONLY
  // violation here is `yMax <= yMin` (the default highlight is out of range for a
  // one-value chart).
  assert.throws(
    () => mod.normalizeParams({ chart: { values: [1], labels: ['a'], highlight: -1, yMin: 5, yMax: 1 } }),
    /yMax/,
  );
  assert.throws(() => mod.normalizeParams({ palette: { ink: 'red' } }), /palette\.ink/);
  assert.throws(() => mod.normalizeParams({ layout: 'dashboard' }), /layout/);

  // Font strings: the module never bundles a font — a generic family by default.
  assert.equal(mod.fontString({ size: 24 }), 'normal 400 24px sans-serif');
  assert.equal(mod.fontString({ size: 24, family: 'Noto Sans SC', weight: 700 }), 'normal 700 24px "Noto Sans SC"');
  assert.throws(() => mod.fontString({ size: 0 }), /size/);

  // CJK breaks per glyph, Latin per word; a closing punctuation never starts a line.
  assert.deepEqual(mod.tokenize('ab cd'), ['ab ', 'cd']);
  const lines = mod.breakLines('数据叙事 Data Story', 100, measureAt(20));
  assert.ok(lines.length >= 2, 'a narrow width forces a break');
  assert.ok(
    lines.every(l => measureAt(20)(l) <= 100 + 1e-6),
    'no line exceeds maxW',
  );
  assert.ok(
    lines.some(l => l.includes('数据')),
    'CJK stays in the run',
  );

  // fitText truly fits both line count and measured width.
  const fit = mod.fitText('数据叙事 Data Story', {
    maxW: 90,
    size: 40,
    maxLines: 2,
    measure: (s: string, sz: number) => fakeMeasure(s, sz),
  });
  assert.ok(fit.size > 0 && fit.size <= 40);
  assert.ok(fit.lines.length <= 2);
  assert.ok(fit.lines.every(l => fakeMeasure(l, fit.size) <= 90 + 0.5));

  assert.equal(mod.alignX('left', 10, 4), 10);
  assert.equal(mod.alignX('center', 10, 4), 8);
  assert.equal(mod.alignX('right', 10, 4), 6);

  // Tabular digits share one cell width so a rolling number never jitters.
  const cells = mod.tabularCells('1,234', 10, () => 4);
  assert.deepEqual(cells.widths, [10, 4, 10, 10, 10]);
  assert.equal(cells.total, 44);
  assert.equal(mod.formatNumber(-12345.6, 1), '−12,345.6');
  assert.equal(mod.revealCount('数据AB', 0.5), '数据');

  // Per-glyph reveal is staggered: glyph 0 is further along than glyph 3 at t=0.1.
  const spec = mod.charRevealSpec('数据AB', { measure: (s: string) => fakeMeasure(s, 20), size: 20, spacing: 0 });
  const glyphs = mod.charRevealFrame(spec, 0.1, {}).glyphs;
  assert.ok(glyphs[0].alpha >= glyphs[3].alpha, 'earlier glyphs lead the stagger');
  assert.ok(glyphs[0].visible && !glyphs[3].visible, 'the tail glyph has not started at t=0.1');
  const linesFrame = mod.lineRevealFrame(['a', 'b', 'c'], 0.1, {});
  assert.ok(linesFrame[0].alpha >= linesFrame[2].alpha, 'earlier lines lead the stagger');
  // Driver mode: the whole cascade completes when the driver reaches 1.
  assert.ok(
    mod.charRevealFrame(spec, 0, { driver: 1 }).glyphs.every(g => g.visible),
    'driver=1 completes every glyph',
  );
  assert.ok(
    mod.lineRevealFrame(['a', 'b'], 0, { driver: 1 }).every(l => l.alpha === 1),
    'driver=1 completes every line',
  );

  // Emphasis geometry: a full-progress highlighter and ruler are exact
  // (skew 0.5 keeps every coordinate on an exactly-representable value).
  assert.deepEqual(mod.markerRect(0, 0, 100, 20, 1, { skew: 0.5 }), [
    [10, 0],
    [110, 0],
    [100, 20],
    [0, 20],
  ]);
  assert.deepEqual(mod.markerRect(0, 0, 100, 20, 0, { skew: 0.5 }), [
    [10, 0],
    [10, 0],
    [0, 20],
    [0, 20],
  ]);
  assert.deepEqual(mod.underlineSegment(10, 50, 80, 1), { x0: 10, y0: 50, x1: 90, y1: 50 });

  // Charts: invertible linear scale, nice ticks, geometry at full progress.
  const yS = mod.linearScale(0, 90, 100, 0);
  assert.equal(yS(45), 50);
  assert.equal(yS.inv(50), 45);
  assert.deepEqual(mod.niceTicks(0, 90, 5), [0, 20, 40, 60, 80]);
  assert.equal(mod.mixHex('#1f5c99', '#b9c3cc', 0.5), 'rgb(108,143,178)');
  assert.deepEqual(mod.parseHex('#ffffff'), [255, 255, 255]);

  const bars = mod.barGeometry(
    [
      { x: 10, v: 50 },
      { x: 30, v: 80 },
    ],
    v => 100 - v,
    1,
    {},
  );
  assert.equal(bars[0].base, 100);
  assert.equal(bars[0].value, 50);
  assert.equal(bars[0].y, 50);
  assert.equal(bars[1].y, 20);
  // Before their lag, later bars have not started.
  const early = mod.barGeometry(
    [
      { x: 10, v: 50 },
      { x: 30, v: 80 },
    ],
    v => 100 - v,
    0.02,
    { lag: 0.5 },
  );
  assert.ok(early[1].q < early[0].q, 'bar 1 lags bar 0');

  const lg = mod.lineGeometry(
    [
      [0, 100],
      [50, 50],
      [100, 20],
    ],
    0.5,
  );
  assert.deepEqual(lg.head, [50, 50]);
  assert.equal(
    mod.yAtX(
      [
        [0, 100],
        [100, 0],
      ],
      25,
    ),
    75,
  );

  const candle = mod.candleGeometry(
    [
      { o: 10, h: 14, l: 8, c: 12 },
      { o: 12, h: 13, l: 9, c: 9 },
    ],
    [0, 1],
    v => 100 - v,
    1,
    {},
  );
  assert.equal(candle[0].isUp, true);
  assert.equal(candle[1].isUp, false);

  // Staged reveal is a pure, monotone function of frame.
  assert.equal(mod.revealProgress(0, { frames: 12 }), 0);
  assert.equal(mod.revealProgress(11, { frames: 12 }), 1);
  const rp = [0, 1, 2, 3].map(f => mod.revealProgress(f, { frames: 12 }));
  for (let i = 1; i < rp.length; i++) assert.ok(rp[i] >= rp[i - 1], 'reveal is monotone');
  assert.equal(
    mod.revealProgress(3, { frames: 12 }),
    mod.revealProgress(3, { frames: 12 }),
    'same frame, same progress',
  );
  assert.throws(() => mod.revealProgress(Number.NaN, { frames: 12 }), /frame/);

  assert.equal(mod.calloutFrame(0, 0.35), null, 'annotation waits for its start');
  const co = mod.calloutFrame(1, 0.35);
  assert.ok(co && co.dotR > 0 && co.textP > 0);
  assert.ok(mod.EASING_NAMES.includes('quintOut'));
});

// ---------------------------------------------------------------------------
// create.mjs: byte-for-byte vendoring, real Asset registration, real Build.
// ---------------------------------------------------------------------------
test('create.mjs vendors the module verbatim, registers MIT code Assets and builds with the real Runtime', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-type-create-'));
  const root = join(parent, 'study');
  try {
    // Run a copy of the study outside the repository. The study owns its module
    // and scene; the running Runtime still supplies validation and the notice.
    const detached = join(parent, 'fixture-copy', 'type-chart');
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
      sources: Array<{ entry: string; resources: string[]; params: { text: string } }>;
      assets: Array<{
        id: string;
        path: string;
        type: string;
        sha256: string;
        rights?: { license: string; redistributable: boolean; origin: string };
      }>;
      handoff: Array<{ path: string; role: string }>;
      composition?: { audio?: unknown[] };
    };
    assert.deepEqual(project.composition?.audio, [], 'a purely visual reference authors no default audio bed');
    assert.equal(project.sources.length, 1);
    assert.deepEqual(project.sources[0]!.resources, RESOURCES);
    assert.equal(typeof project.sources[0]!.params.text, 'string');
    // Honest rights: adapted MIT source, never claimed as CC0.
    const sourceRights = project.assets.find(asset => asset.id === 'type_chart_module')!.rights!;
    assert.equal(sourceRights.license, 'MIT');
    assert.equal(sourceRights.redistributable, true);
    assert.match(sourceRights.origin, /huashu-art-motion/);
    assert.match(sourceRights.origin, /f178bd7754a71d6d399473af1501634548efa6cb/);
    assert.doesNotMatch(sourceRights.license, /CC0/);

    // The vendored working copies must be byte-identical to the Runtime module.
    const moduleBytes = await readFile(join(root, 'type-chart.mjs'));
    const entryBytes = await readFile(join(root, ENTRY));
    assert.equal(sha256(moduleBytes), sha256(await readFile(TYPE_MJS)), 'type-chart.mjs is vendored byte-for-byte');
    assert.equal(sha256(entryBytes), sha256(await readFile(TYPE_HTML)), 'type-scene.html is vendored byte-for-byte');

    const moduleAsset = project.assets.find(a => a.id === 'type_chart_module');
    assert.ok(
      moduleAsset && moduleAsset.type === 'code' && moduleAsset.sha256 === sha256(moduleBytes),
      'the module is a code Asset with its real hash',
    );
    assert.equal(moduleAsset.path, 'type-chart.mjs', 'the Asset is the file the Source reads, not a second copy');
    assert.equal(moduleAsset.rights?.license, 'MIT', 'the code Asset carries the MIT rights');
    for (const source of project.sources) {
      assert.equal(source.entry, ENTRY);
      assert.deepEqual(source.resources, RESOURCES);
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
// Cold start: real frames at TWO sizes, and the reveal advances.
// ---------------------------------------------------------------------------
test('a cold start renders real frames at 16:9 and 9:16 and the staged reveal advances', async () => {
  const root = await authorFixture();
  try {
    for (const size of [
      { width: 160, height: 90 },
      { width: 90, height: 160 },
    ]) {
      const destination = await mkdtemp(join(tmpdir(), 'viscraft-type-start-'));
      try {
        const scene = await openCodeScene(root, { entry: ENTRY, resources: RESOURCES }, size, {
          label: 'captureCode',
          globalName: 'viscraft',
        });
        try {
          const pixels: Buffer[] = [];
          const hashes = new Set<string>();
          for (let frame = 0; frame < 6; frame++) {
            const file = join(destination, `f-${size.width}x${size.height}-${frame}.png`);
            await scene.page.evaluate(
              async payload => {
                const v = (globalThis as unknown as Record<string, { render: (a: unknown) => Promise<void> | void }>)[
                  'viscraft'
                ];
                await v.render(payload);
              },
              frameArgs(frame, size.width, size.height, 9, CHART_PARAMS, scene.bindings),
            );
            await scene.page.screenshot({ path: file, type: 'png', captureBeyondViewport: false });
            pixels.push(rgbPixels(file));
            hashes.add(sha256(await readFile(file)));
            assert.equal(pixels[frame].length, size.width * size.height * 3, `frame ${frame} decoded`);
          }
          assert.equal(hashes.size, 6, 'every frame is distinct — the reveal advances');
          const last = countNonBackground(pixels[5], BG);
          const first = countNonBackground(pixels[0], BG);
          assert.ok(last > size.width * size.height * 0.05, `the finished chart draws at ${size.width}x${size.height}`);
          assert.ok(first < last, 'the first frame is emptier than the finished chart (staged reveal)');
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
// Determinism: same frame twice is identical, and order does not matter.
// ---------------------------------------------------------------------------
test('rendering is deterministic: the same frame is byte-identical and sampling order is irrelevant', async () => {
  const root = await authorFixture();
  const size = { width: 160, height: 90 };
  try {
    const scene = await openCodeScene(root, { entry: ENTRY, resources: RESOURCES }, size, {
      label: 'captureCode',
      globalName: 'viscraft',
    });
    try {
      const args = (frame: number) => frameArgs(frame, size.width, size.height, 5, CHART_PARAMS, scene.bindings);

      const first = await renderToBuffer(scene, args(3));
      const again = await renderToBuffer(scene, args(3));
      assert.ok(first.equals(again), 'the same frame is byte-identical on repeat');

      const frames = [0, 2, 5];
      const ordered: Buffer[] = [];
      for (const frame of frames) ordered.push(await renderToBuffer(scene, args(frame)));
      for (const i of [2, 0, 1]) {
        const buffer = await renderToBuffer(scene, args(frames[i]));
        assert.ok(buffer.equals(ordered[i]), `frame ${frames[i]} is independent of sampling order`);
      }
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
    const resources = [...RESOURCES, 'chart-data.mjs'];
    await assert.rejects(
      openCodeScene(
        root,
        { entry: ENTRY, resources },
        { width: 64, height: 64 },
        { label: 'captureCode', globalName: 'viscraft' },
      ),
      (error: unknown) => /chart-data\.mjs|ENOENT|no such file/i.test(String((error as Error)?.message ?? error)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
