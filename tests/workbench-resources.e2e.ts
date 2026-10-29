import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import puppeteer from 'puppeteer-core';
import { findBrowser } from '../src/backends/browser/capture.js';
import { renderImage } from '../src/build/image.js';
import { validateProject } from '../src/project/project.js';
import { serveWorkbench } from '../src/workbench/server.js';

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:ProductFont;src:url('../assets/font.woff2')}
html,body{margin:0;background:white;font-family:ProductFont}
.canvas{position:relative;width:360px;height:240px;overflow:hidden}
.title{position:absolute;left:10px;top:4px;font-size:20px}
.product{position:absolute;left:10px;top:60px;width:240px;height:40px}
.tile{position:absolute;left:10px;top:120px;width:70px;height:40px;background:url('../assets/product%20tile.svg?revision=1') center/cover}
</style></head><body><div class="canvas" data-canvas-width="360" data-canvas-height="240">
<div class="title" data-layer-id="title">Product</div>
<div class="product" data-layer-id="product"><svg width="240" height="40" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
<image id="modern" href="../assets/product%20tile.svg" x="0" y="0" width="70" height="40"/>
<image id="legacy" xlink:href="../assets/product%20tile.svg" x="80" y="0" width="70" height="40"/>
<use id="symbol" href="../assets/symbols.svg#shape" x="160" y="0"/>
</svg></div><div class="tile" data-layer-id="tile"></div>
<a id="navigation" href="../guide.html">guide</a>
</div></body></html>`;
const RED =
  '<svg xmlns="http://www.w3.org/2000/svg" width="70" height="40"><rect width="70" height="40" fill="#d82030"/></svg>';
const SYMBOL =
  '<svg xmlns="http://www.w3.org/2000/svg"><defs><g id="shape"><rect width="70" height="40" fill="#d82030"/></g></defs></svg>';

function pixel(png: Buffer, x: number, y: number): number[] {
  return [
    ...execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-i',
        'pipe:0',
        '-vf',
        `format=rgb24,crop=1:1:${x}:${y}:exact=1`,
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-',
      ],
      { input: png },
    ),
  ];
}

test('nested-document resources paint identically in the workbench and image render, without widening access', async () => {
  const executablePath = await findBrowser();
  const root = await mkdtemp(join(tmpdir(), 'viscraft-wb-resources-'));
  await mkdir(join(root, 'author'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'author/poster.html'), HTML);
  await writeFile(join(root, 'assets/product tile.svg'), RED);
  await writeFile(join(root, 'assets/symbols.svg'), SYMBOL);
  await writeFile(join(root, 'private.txt'), 'not a declared design input');
  await copyFile(
    resolve('tests/fixtures/authoring/poster-and-film/fonts/NotoSansSC-400-subset.woff2'),
    join(root, 'assets/font.woff2'),
  );
  const project = validateProject({
    schemaVersion: 1,
    id: 'wb-resource-parity',
    revision: 1,
    title: 'Resource parity',
    direction: { intent: 'preview the actual product and typography', looks: [{ id: 'plain', description: 'plain' }] },
    sources: [],
    assets: [],
    imageDocuments: [
      {
        id: 'poster',
        path: 'author/poster.html',
        revision: 1,
        resources: ['assets/product tile.svg', 'assets/symbols.svg', 'assets/font.woff2'],
      },
    ],
    imageTargets: [
      { id: 'poster', document: 'poster', width: 360, height: 240, scale: 1, format: 'png', background: 'opaque' },
    ],
  });
  await writeFile(join(root, 'project.json'), JSON.stringify(project));
  const live = await serveWorkbench(root, { document: 'poster', target: 'poster' });
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    pipe: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--force-color-profile=srgb',
    ],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 900 });
    await page.goto(live.url, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.getElementById('wb-app')?.getAttribute('data-phase') === 'mounted');
    const frame = page.frames().find(f => f !== page.mainFrame())!;
    const info = await frame.evaluate(async () => {
      await document.fonts.ready;
      const fonts: Array<{ family: string; status: string }> = [];
      document.fonts.forEach(font => fonts.push({ family: font.family, status: font.status }));
      return {
        fonts,
        inheritedFamily: getComputedStyle(document.querySelector('.title')!).fontFamily,
        modern: document.getElementById('modern')!.getAttribute('href'),
        legacy: document.getElementById('legacy')!.getAttribute('xlink:href'),
        symbol: document.getElementById('symbol')!.getAttribute('href'),
        navigation: document.getElementById('navigation')!.getAttribute('href'),
      };
    });
    assert.match(
      info.modern!,
      /^\/resource\/poster\/assets\/product%20tile\.svg\?token=/,
      'SVG2 image href loads the real declared image, rather than leaving a painted silhouette',
    );
    assert.match(info.legacy!, /^\/resource\/poster\/assets\//);
    assert.match(info.symbol!, /#shape$/, 'external SVG use keeps its fragment');
    assert(
      info.fonts.some(font => font.family === 'ProductFont' && font.status === 'loaded'),
      'a parent-relative declared font is loaded, not silently replaced',
    );
    assert.match(info.inheritedFamily, /ProductFont/, 'editor chrome does not override the artwork font');
    assert.equal(info.navigation, '../guide.html', 'ordinary links remain navigation');
    assert.doesNotMatch(await page.$eval('#wb-banners', e => e.textContent ?? ''), /unresolved/);

    // Sample the real preview raster for every reference form, rather than
    // asserting that a rewritten URL alone implies it was rendered.
    for (const id of ['modern', 'legacy', 'symbol']) {
      const image = await frame.$(`#${id}`);
      const png = Buffer.from(await image!.screenshot());
      const rgb = pixel(png, Math.floor(png.readUInt32BE(16) / 2), Math.floor(png.readUInt32BE(20) / 2));
      assert.deepEqual(rgb, [216, 32, 48], `${id} paints the supplied product pixels`);
    }

    // An actual edit/save/reopen must retain author-relative references and
    // never write a session token into the portable document.
    const [saveResponse] = await Promise.all([
      page.waitForResponse(
        response => new URL(response.url()).pathname === '/api/document' && response.request().method() === 'PUT',
      ),
      (async () => {
        await frame.evaluate(() => {
          const layer = document.querySelector('[data-layer-id="product"]') as HTMLElement;
          layer.style.left = '14px';
        });
        await page.click('#wb-save');
      })(),
    ]);
    assert.equal(saveResponse.status(), 200, await saveResponse.text());
    const saved = await readFile(join(root, 'author/poster.html'), 'utf8');
    const editRecord = /<script\b[^>]*\bdata-viscraft-layout\b[^>]*>([\s\S]*?)<\/script>/i.exec(saved);
    assert.ok(editRecord, 'the actual source contains the saved layout edits');
    const layout = JSON.parse(editRecord[1]) as { layers: Array<{ id: string; dx?: number }> };
    assert.equal(layout.layers.find(layer => layer.id === 'product')?.dx, 4, 'the requested move reached the file');
    assert(saved.startsWith(HTML.slice(0, 40)));
    assert.match(saved, /href="\.\.\/assets\/product%20tile\.svg"/);
    assert.doesNotMatch(saved, /\/resource\/|token=/);
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.getElementById('wb-app')?.getAttribute('data-phase') === 'mounted');

    const rendered = await renderImage(root, { target: 'poster' });
    const png = await readFile(join(root, rendered.path));
    for (const [x, y] of [
      [49, 80],
      [129, 80],
      [209, 80],
      [45, 140],
    ]) {
      assert.deepEqual(pixel(png, x, y), [216, 32, 48], 'formal capture paints the same product resources');
    }
    const denied = await fetch(new URL('/resource/poster/private.txt', live.url), {
      headers: { 'x-viscraft-token': live.token },
    });
    assert.equal(denied.status, 403, 'parent-relative resolution never grants undeclared file access');
    await denied.arrayBuffer();
  } finally {
    await browser.close();
    await live.close();
    await rm(root, { recursive: true, force: true });
  }
});
