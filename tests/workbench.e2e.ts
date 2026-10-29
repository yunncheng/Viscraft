/**
 * E2E: the on-demand image workbench.
 *
 * Proves, against a real loopback server, a real Browser render and the real
 * page:
 *  - the page, its script, stylesheet and vendored editor are served by the
 *    Runtime's fixed workbench UI, and the page resolves them when opened
 *    WITHOUT a trailing slash (`/workbench?...`, not `/workbench/?...`);
 *  - every API read/write needs the per-session token, and a mutating call from
 *    another origin is refused;
 *  - a save writes the REAL document file and bumps the document revision;
 *  - a save whose base hash/revision is stale returns 409 and leaves the bytes
 *    untouched (no silent overwrite), and the new bytes are what is re-read;
 *  - a render goes through the same `renderImage` path (a real PNG at the
 *    declared output pixels), a second identical request reuses it, and
 *    `/api/output` serves those exact bytes with an attachment disposition;
 *  - only resources DECLARED by the document are readable;
 *  - the real page mounts (shell + editor), starts clean, and one programmatic
 *    layer move is saved through the page's own queue into the author source.
 */
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { findBrowser } from '../src/backends/browser/capture.js';
import { renderImage } from '../src/build/image.js';
import { validateProject } from '../src/project/project.js';
import { serveWorkbench, type WorkbenchServer } from '../src/workbench/server.js';

const DOC = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="ink.css">
<script>document.documentElement.dataset.authored = 'inline-ok';</script></head>
<body><div class="poster" data-canvas-width="240" data-canvas-height="150">
<div class="title" data-layer-id="title">FIRST CUT</div>
<div class="sub" data-layer-id="sub">editable in the workbench</div>
</div></body></html>`;
const CSS = `html,body{margin:0;width:240px;height:150px;overflow:hidden;background:#f2ead9}
.poster{position:relative;width:240px;height:150px;overflow:hidden;font-family:sans-serif;color:#2b2520}
.title{position:absolute;left:20px;top:20px;width:200px;height:40px;font-size:26px;letter-spacing:1px}
.sub{position:absolute;left:20px;top:70px;width:200px;height:24px;font-size:13px;color:#6f6558}`;

// An author document whose own load script re-lays-out the page. The workbench
// saves a layout record over it; the formal still must consume the SAME record,
// and an external source edit must make the record inert.
const LAYOUT_DOC = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="ink.css">
<script>const reset = () => {
  const layer = document.querySelector('[data-layer-id="title"]');
  if (layer) layer.style.left = '20px';
};
addEventListener('load', reset);
addEventListener('resize', reset);</script></head>
<body><div class="poster" data-canvas-width="240" data-canvas-height="150">
<div class="title" data-layer-id="title"></div>
</div></body></html>`;
const LAYOUT_CSS = `html,body{margin:0;width:240px;height:150px;overflow:hidden;background:#f2ead9}
.poster{position:relative;width:240px;height:150px;overflow:hidden}
.title{position:absolute;left:20px;top:20px;width:40px;height:40px;background:#111}`;

// An author document whose own load script builds part of the page. Saving the
// executed DOM would write those generated nodes next to the script that
// creates them, so every save/reopen cycle would multiply them. The save must
// keep this HTML byte for byte and record only what the user changed.
const DYNAMIC_DOC = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="ink.css">
<!-- author comment: part of the source, never a workbench artifact -->
<script>
addEventListener('load', () => {
  const canvas = document.querySelector('.poster');
  const note = document.createElement('div');
  note.className = 'note';
  note.dataset.layerId = 'generated';
  note.innerHTML = '<span>generated copy</span>';
  canvas.append(note);
  document.documentElement.dataset.generatedCount = String(canvas.querySelectorAll('[data-layer-id]').length);
});
</script></head>
<body><div class="poster" data-canvas-width="240" data-canvas-height="150">
<div class="frame"><div class="title" data-layer-id="title">STATIC <b>SLOT</b></div></div>
<div class="sub" data-layer-id="sub">second line</div>
</div></body></html>`;
const DYNAMIC_CSS = `html,body{margin:0;width:240px;height:150px;overflow:hidden;background:#f2ead9}
.poster{position:relative;width:240px;height:150px;overflow:hidden;font-family:sans-serif;color:#2b2520}
.frame{position:absolute;left:20px;top:20px;width:200px}
.title{width:200px;height:30px;font-size:20px}
.sub{position:absolute;left:20px;top:100px;width:200px;height:20px;font-size:12px}
.note{position:absolute;left:20px;top:60px;width:200px;height:24px;font-size:12px}`;

// A multilayer poster: a background, one declared group with real text, and
// one standalone surface layer. The structure view must show the complete
// composition, the background and the module — not a re-rendered gallery.
const MULTI_DOC = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="ink.css">
<script>document.documentElement.dataset.authored = 'inline-ok';</script></head>
<body><div class="poster" data-canvas-width="240" data-canvas-height="150">
<div class="bg"></div>
<div class="hero" data-explode-group="hero" data-explode-label="Hero module">
<div class="title" data-layer-id="title" data-explode-role="copy">STRUCTURE</div>
<div class="sub" data-layer-id="sub" data-explode-role="copy">layer view</div>
</div>
<div class="badge" data-layer-id="badge" data-explode-role="surface"></div>
</div></body></html>`;
const MULTI_CSS = `html,body{margin:0;width:240px;height:150px;overflow:hidden;background:#f2ead9}
.poster{position:relative;width:240px;height:150px;overflow:hidden;font-family:sans-serif;color:#2b2520}
.bg{position:absolute;left:0;top:0;width:240px;height:150px;background:#f2ead9}
.hero{position:absolute;left:20px;top:20px;width:200px;height:80px}
.title{position:absolute;left:0;top:0;width:200px;height:40px;font-size:26px;letter-spacing:1px}
.sub{position:absolute;left:0;top:48px;width:200px;height:20px;font-size:13px;color:#6f6558}
.badge{position:absolute;left:20px;top:112px;width:48px;height:18px;background:#2b2520}`;

// One flat layer whose only content is a real decoded image. The structure
// view must not fabricate units for it; overview/background are labels, not
// restored layers.
const FLAT_DOC = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="ink.css"></head>
<body><div class="poster" data-canvas-width="240" data-canvas-height="150">
<div class="photo" data-layer-id="photo"><img src="photo.png" alt=""></div>
</div></body></html>`;
const FLAT_CSS = `html,body{margin:0;width:240px;height:150px;overflow:hidden;background:#f2ead9}
.poster{position:relative;width:240px;height:150px;overflow:hidden;background:#f2ead9}
.photo{position:absolute;left:40px;top:30px;width:80px;height:80px}
.photo img{display:block;width:100%;height:100%}`;
const PHOTO_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--enable-unsafe-swiftshader',
  '--hide-scrollbars',
  '--mute-audio',
  '--no-first-run',
  '--no-default-browser-check',
  '--force-color-profile=srgb',
  '--font-render-hinting=none',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];

async function launchBrowser(): Promise<Browser> {
  return puppeteer.launch({ executablePath: await findBrowser(), headless: true, pipe: true, args: LAUNCH_ARGS });
}

async function openWorkbench(live: WorkbenchServer, browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  await page.goto(live.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => document.getElementById('wb-app')?.getAttribute('data-phase') === 'mounted', {
    timeout: 30000,
  });
  return page;
}

async function waitForRevision(root: string, minimum: number, timeout = 20000): Promise<number> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const project = JSON.parse(await readFile(join(root, 'project.json'), 'utf8')) as {
      imageDocuments: Array<{ revision: number }>;
    };
    const revision = project.imageDocuments[0]?.revision ?? 0;
    if (revision >= minimum) return revision;
    if (Date.now() > deadline) throw new Error(`document revision did not reach ${minimum} (last ${revision})`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

/** Leftmost dark column of the rendered block, in output pixels. */
async function inkLeft(browser: Browser, png: Buffer, top: number, bottom: number): Promise<number> {
  const page = await browser.newPage();
  try {
    return await page.evaluate(
      async ({ base64, top, bottom }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        const data = context.getImageData(0, top, image.width, bottom - top).data;
        for (let x = 0; x < image.width; x++) {
          for (let y = 0; y < bottom - top; y++) {
            const index = (y * image.width + x) * 4;
            if (data[index] < 100 && data[index + 1] < 100 && data[index + 2] < 100) return x;
          }
        }
        return -1;
      },
      { base64: png.toString('base64'), top, bottom },
    );
  } finally {
    await page.close();
  }
}

function project(revision = 1, resources: string[] = ['ink.css']) {
  return {
    schemaVersion: 1,
    id: 'workbench-e2e',
    revision: 1,
    title: 'Workbench e2e',
    direction: {
      intent: 'one still, edited in place',
      looks: [{ id: 'plain', description: 'plain' }],
      transitions: [],
    },
    assets: [],
    bindings: {},
    sources: [],
    imageDocuments: [{ id: 'poster', path: 'poster.html', resources, revision }],
    imageTargets: [
      {
        id: 'wide',
        document: 'poster',
        width: 240,
        height: 150,
        scale: 2,
        format: 'png' as const,
        background: 'opaque' as const,
      },
    ],
  };
}

async function fixture(
  doc = DOC,
  css = CSS,
  resources: string[] = ['ink.css'],
  files: Record<string, string | Buffer> = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-workbench-'));
  await writeFile(join(root, 'poster.html'), doc);
  await writeFile(join(root, 'ink.css'), css);
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(root, name), bytes);
  await writeFile(join(root, 'project.json'), JSON.stringify(validateProject(project(1, resources)), null, 2) + '\n');
  return root;
}

function call(live: WorkbenchServer, path: string, init: RequestInit = {}, token = live.token): Promise<Response> {
  return fetch(`http://127.0.0.1:${live.port}${path}`, {
    ...init,
    headers: { 'x-viscraft-token': token, ...(init.headers ?? {}) },
  });
}

function pngSize(bytes: Buffer): { width: number; height: number } {
  assert.equal(bytes.toString('ascii', 1, 4), 'PNG', 'the bytes are a PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test('the workbench serves its page, saves a real edit, refuses a stale save, and renders the saved document', async () => {
  const root = await fixture();
  const live = await serveWorkbench(root, { document: 'poster', target: 'wide' });
  try {
    // 1. The page and every asset it needs are served by the Runtime UI. The page
    // URL has no trailing slash, so relative assets must still resolve.
    const origin = `http://127.0.0.1:${live.port}`;
    const page = await fetch(`${origin}/workbench?document=poster&target=wide&token=${live.token}`);
    assert.equal(page.status, 200);
    const pageHtml = await page.text();
    assert.match(pageHtml, /id="wb-app"/);
    assert.match(pageHtml, /<base href="\/workbench\/">/, 'the asset mount is explicit');
    const script = await fetch(`${origin}/workbench/workbench.js`);
    assert.equal(script.status, 200, 'the page script is served');
    assert.match(script.headers.get('content-type') ?? '', /javascript/);
    const layoutScript = await fetch(`${origin}/workbench/layout-record.js`);
    assert.equal(layoutScript.status, 200, 'the shared layout-record script is served');
    assert.match(layoutScript.headers.get('content-type') ?? '', /javascript/);
    const stylesheet = await fetch(`${origin}/workbench/workbench.css`);
    assert.equal(stylesheet.status, 200, 'the page stylesheet is served');
    assert.match(stylesheet.headers.get('content-type') ?? '', /css/);
    const editor = await fetch(`${origin}/workbench/vendor/layer-editor.js`);
    assert.equal(editor.status, 200, 'the vendored editor is served');
    assert.match(editor.headers.get('content-type') ?? '', /javascript/);
    const editorCss = await fetch(`${origin}/workbench/vendor/layer-editor.css`);
    assert.equal(editorCss.status, 200, 'the vendored editor stylesheet is served');

    // 2. Reads require a token; a wrong token is the same refusal.
    assert.equal((await fetch(`${origin}/api/document`)).status, 401, 'no token');
    assert.equal((await call(live, '/api/document', {}, 'not-the-token')).status, 401, 'wrong token');

    // 3. The bound document describes the real bytes, resources and target.
    const opened = (await (await call(live, '/api/document')).json()) as {
      document: { id: string; path: string; revision: number; contentHash: string };
      html: string;
      resources: Array<{ path: string; url: string }>;
      target: {
        id: string;
        logicalWidth: number;
        logicalHeight: number;
        width: number;
        height: number;
        scale: number;
      };
      result: unknown;
    };
    assert.equal(opened.document.id, 'poster');
    assert.equal(opened.document.path, 'poster.html');
    assert.equal(opened.document.revision, 1);
    assert.equal(opened.html, DOC);
    assert.deepEqual(
      opened.resources.map(item => item.path),
      ['ink.css'],
    );
    assert.equal(opened.resources[0].url, '/resource/poster/ink.css');
    assert.equal(opened.target.id, 'wide');
    assert.deepEqual(
      {
        logicalWidth: opened.target.logicalWidth,
        logicalHeight: opened.target.logicalHeight,
        width: opened.target.width,
        height: opened.target.height,
        scale: opened.target.scale,
      },
      { logicalWidth: 240, logicalHeight: 150, width: 480, height: 300, scale: 2 },
    );
    assert.equal(opened.result, null, 'nothing has been rendered yet');

    // 4. A save writes the file, records a new document revision and a new hash.
    const edited = DOC.replace('FIRST CUT', 'SECOND CUT');
    const saved = await call(live, '/api/document', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({
        document: 'poster',
        baseRevision: opened.document.revision,
        baseContentHash: opened.document.contentHash,
        html: edited,
      }),
    });
    assert.equal(saved.status, 200);
    const savedBody = (await saved.json()) as {
      revision: number;
      contentHash: string;
      savedAt: string;
    };
    assert.equal(savedBody.revision, 2, 'the document revision advances once');
    assert.notEqual(savedBody.contentHash, opened.document.contentHash);
    assert.match(savedBody.savedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(await readFile(join(root, 'poster.html'), 'utf8'), edited, 'the author source really changed');
    const stored = JSON.parse(await readFile(join(root, 'project.json'), 'utf8')) as {
      revision: number;
      imageDocuments: Array<{ revision: number }>;
    };
    assert.equal(stored.imageDocuments[0].revision, 2, 'the Project records the document revision');
    assert.equal(stored.revision, 2, 'the Project revision advanced once');

    const reread = (await (await call(live, '/api/document')).json()) as {
      html: string;
      document: { revision: number; contentHash: string };
    };
    assert.equal(reread.html, edited, 're-reading returns the saved bytes');
    assert.equal(reread.document.revision, savedBody.revision);
    assert.equal(reread.document.contentHash, savedBody.contentHash);

    // 5. The SAME base is now stale: refuse, do not overwrite.
    const stale = await call(live, '/api/document', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({
        document: 'poster',
        baseRevision: opened.document.revision,
        baseContentHash: opened.document.contentHash,
        html: DOC,
      }),
    });
    assert.equal(stale.status, 409);
    const conflict = (await stale.json()) as {
      error: string;
      current: { revision: number; contentHash: string };
    };
    assert.equal(conflict.error, 'conflict');
    assert.equal(conflict.current.revision, savedBody.revision, 'the conflict reports the current revision');
    assert.equal(conflict.current.contentHash, savedBody.contentHash, 'and the current hash');
    assert.equal(await readFile(join(root, 'poster.html'), 'utf8'), edited, 'the newer bytes survived');

    // 6. A cross-origin mutation is refused even with a valid token.
    const crossOrigin = await call(live, '/api/document', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: 'http://example.invalid' },
      body: JSON.stringify({
        document: 'poster',
        baseRevision: savedBody.revision,
        baseContentHash: savedBody.contentHash,
        html: 'cross origin',
      }),
    });
    assert.equal(crossOrigin.status, 403);
    const crossOriginRender = await call(live, '/api/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://example.invalid' },
      body: JSON.stringify({ target: 'wide' }),
    });
    assert.equal(crossOriginRender.status, 403);

    // 7. Only resources DECLARED by the document are readable.
    const resource = await call(live, '/resource/poster/ink.css');
    assert.equal(resource.status, 200);
    assert.equal(await resource.text(), CSS);
    assert.equal((await call(live, '/resource/poster/project.json')).status, 403, 'undeclared resource');
    assert.equal((await call(live, '/resource/poster/../project.json')).status, 403, 'traversal stays refused');

    // 8. A render produces the real still for the SAVED document and is reused.
    const rendered = await call(live, '/api/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ target: 'wide' }),
    });
    assert.equal(rendered.status, 200);
    const result = (await rendered.json()) as {
      build: string;
      artifact: string;
      path: string;
      width: number;
      height: number;
      simulated: boolean;
      reused: boolean;
      url: string;
    };
    assert.deepEqual({ width: result.width, height: result.height }, { width: 480, height: 300 });
    assert.equal(result.simulated, false);
    assert.equal(result.reused, false);
    assert.equal(result.url, '/api/output?target=wide');
    const bytes = await readFile(join(root, ...result.path.split('/')));
    assert.deepEqual(pngSize(bytes), { width: 480, height: 300 }, 'the PNG really is 480x300');

    const again = await call(live, '/api/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ target: 'wide' }),
    });
    assert.equal(again.status, 200);
    const reused = (await again.json()) as { artifact: string; reused: boolean };
    assert.equal(reused.reused, true, 'an unchanged document reuses the result');
    assert.equal(reused.artifact, result.artifact);

    // 9. The output endpoint returns those exact bytes with a disposition.
    const output = await call(live, '/api/output?target=wide');
    assert.equal(output.status, 200);
    assert.match(output.headers.get('content-disposition') ?? '', /^attachment; filename="wide\.png"$/);
    assert.match(output.headers.get('content-type') ?? '', /^image\/png/);
    const outputBytes = Buffer.from(await output.arrayBuffer());
    assert.equal(outputBytes.toString('base64'), bytes.toString('base64'), 'output is the rendered file');
    assert.equal((await call(live, '/api/output?target=wide', {}, 'not-the-token')).status, 401);

    // 10. The status view reports the same result without rendering again.
    const status = (await (await call(live, '/api/status')).json()) as {
      document: { revision: number; contentHash: string };
      result: { path: string } | null;
    };
    assert.equal(status.document.revision, savedBody.revision);
    assert.equal(status.document.contentHash, savedBody.contentHash);
    assert.equal(status.result?.path, result.path);

    // 11. An edit made OUTSIDE the page (an Agent rewriting the source) makes the
    // recorded still STALE on first open — not silently "current" until a render.
    await writeFile(join(root, 'poster.html'), edited.replace('SECOND CUT', 'THIRD CUT'));
    const staleView = (await (await call(live, '/api/document')).json()) as {
      html: string;
      result: { path: string; stale: boolean } | null;
    };
    assert.match(staleView.html, /THIRD CUT/, 'the page sees the external edit');
    assert.equal(staleView.result?.path, result.path, 'the old result is still reported');
    assert.equal(staleView.result?.stale, true, 'but it is marked stale');
    const refreshed = await call(live, '/api/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ target: 'wide' }),
    });
    assert.equal(refreshed.status, 200);
    const refreshedBody = (await refreshed.json()) as { stale: boolean; reused: boolean; artifact: string };
    assert.equal(refreshedBody.reused, false, 'stale inputs cannot be reused');
    assert.equal(refreshedBody.stale, false);
    assert.notEqual(refreshedBody.artifact, result.artifact, 'a new still is recorded');
  } finally {
    await live.close();
    await rm(root, { recursive: true, force: true });
  }
});

const browserAvailable = await findBrowser().then(
  () => true,
  () => false,
);
const browserSkip = browserAvailable ? false : 'needs a Chrome/Chromium browser';

test(
  'the real page mounts the editor clean, and one programmatic move is saved through its queue',
  { skip: browserSkip },
  async () => {
    const root = await fixture();
    const live = await serveWorkbench(root, { document: 'poster', target: 'wide' });
    const browser = await puppeteer.launch({
      executablePath: await findBrowser(),
      headless: true,
      pipe: true,
      args: [
        // Same browser mode as the still capture path.
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--enable-unsafe-swiftshader',
        '--hide-scrollbars',
        '--mute-audio',
        '--no-first-run',
        '--no-default-browser-check',
        '--force-color-profile=srgb',
        '--font-render-hinting=none',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
      ],
    });
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1200, height: 900 });
      const pageErrors: string[] = [];
      page.on('pageerror', error => pageErrors.push(error instanceof Error ? error.message : String(error)));

      await page.goto(live.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // The shell reaches `mounted` only after the editor signalled hf-ready.
      await page.waitForFunction(() => document.getElementById('wb-app')?.getAttribute('data-phase') === 'mounted', {
        timeout: 30000,
      });

      const mounted = await page.evaluate(() => {
        const frame = document.getElementById('wb-frame') as HTMLIFrameElement | null;
        const win = frame?.contentWindow as
          | (Window & {
              __layerEditor?: { layers(): Array<{ el: HTMLElement; id: string }> };
            })
          | null;
        const doc = frame?.contentDocument;
        const state = document.getElementById('wb-save-state');
        return {
          saveState: state?.getAttribute('data-state') ?? '',
          saveLabel: document.getElementById('wb-save-label')?.textContent ?? '',
          title: document.getElementById('wb-title')?.textContent ?? '',
          target: document.getElementById('wb-target')?.textContent ?? '',
          hasEditor: Boolean(win?.__layerEditor),
          hfReady: doc?.documentElement.getAttribute('data-hf-ready') ?? '',
          authored: doc?.documentElement.getAttribute('data-authored') ?? '',
          toolbar: Boolean(doc?.querySelector('.hf-bar')),
          canvas: Boolean(doc?.querySelector('.hf-canvas')),
          layerCount: win?.__layerEditor?.layers().length ?? 0,
        };
      });

      assert.deepEqual(pageErrors, [], 'the page raised no error');
      assert.equal(mounted.saveState, 'clean', 'the page starts clean');
      assert.match(mounted.saveLabel, /No changes/);
      assert.equal(mounted.title, 'poster.html');
      assert.match(mounted.target, /240×150/);
      assert.equal(mounted.hasEditor, true, 'the editor global exists in the author frame');
      assert.equal(mounted.hfReady, '1', 'the editor finished initialising');
      assert.equal(mounted.authored, 'inline-ok', 'the author document’s own script ran in the frame');
      assert.equal(mounted.toolbar, true, 'the editor toolbar is mounted');
      assert.equal(mounted.canvas, true, 'the canvas is mounted');
      assert.equal(mounted.layerCount, 2, 'both declared layers are editable');

      // One programmatic DOM move (what a drag produces). The page polls the
      // layer signature, marks dirty and autosaves after the idle interval.
      const movedLeft = await page.evaluate(() => {
        const frame = document.getElementById('wb-frame') as HTMLIFrameElement;
        const win = frame.contentWindow as Window & {
          __layerEditor: { layers(): Array<{ el: HTMLElement; id: string }> };
        };
        const layer = win.__layerEditor.layers().find(item => item.id === 'title');
        if (!layer) throw new Error('title layer not found');
        layer.el.style.left = '42px';
        return layer.el.style.left;
      });
      assert.equal(movedLeft, '42px');

      await page.waitForFunction(
        () => document.getElementById('wb-save-state')?.getAttribute('data-state') === 'saved',
        { timeout: 20000 },
      );

      const savedHtml = await readFile(join(root, 'poster.html'), 'utf8');
      // The move is stored as an offset from the layer's own layout position;
      // the authored element itself is untouched.
      assert.match(savedHtml, /"id":"title","dx":22(?:[.,]0*)?[,}]/, 'the edit record kept the move');
      assert.match(
        savedHtml,
        /<div class="title" data-layer-id="title">FIRST CUT<\/div>/,
        'the authored markup is unchanged',
      );
      assert.doesNotMatch(savedHtml, /[?&]token=/, 'the preview token never reaches the author source');
      assert.doesNotMatch(savedHtml, /data-hf-|hf-/, 'no editor chrome reaches the author source');
      const status = (await (await call(live, '/api/status')).json()) as {
        document: { revision: number; contentHash: string };
      };
      assert.equal(status.document.revision, 2, 'the page save bumped the document revision once');
      assert.equal(
        status.document.contentHash,
        (await (await call(live, '/api/document')).json()).document.contentHash,
        'the on-disk source is what the Runtime reports',
      );
      assert.deepEqual(pageErrors, [], 'the page still raised no error');

      // The download link is a navigation, so it must carry the session token.
      // Render through the page's own button: that is the real save→render path.
      await page.click('#wb-render');
      await page.waitForFunction(
        () => document.getElementById('wb-out-state')?.getAttribute('data-state') === 'success',
        { timeout: 30000 },
      );
      const href = await page.evaluate(
        () => (document.getElementById('wb-download') as HTMLAnchorElement).getAttribute('href') ?? '',
      );
      assert.match(href, /\/api\/output\?target=wide/);
      assert.match(href, /token=/);
      const download = await fetch(new URL(href, live.url).href);
      assert.equal(download.status, 200, 'the download link works without a token header');
      assert.equal(Buffer.from(await download.arrayBuffer()).toString('ascii', 1, 4), 'PNG');
    } finally {
      await browser.close();
      await live.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('typing is autosaved without ending the text session, and Ctrl+S commits it', { skip: browserSkip }, async () => {
  const root = await fixture();
  const live = await serveWorkbench(root, { document: 'poster', target: 'wide' });
  const browser = await puppeteer.launch({
    executablePath: await findBrowser(),
    headless: true,
    pipe: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--enable-unsafe-swiftshader',
      '--hide-scrollbars',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--force-color-profile=srgb',
      '--font-render-hinting=none',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 900 });
    await page.goto(live.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => document.getElementById('wb-app')?.getAttribute('data-phase') === 'mounted', {
      timeout: 30000,
    });

    const frame = page.frames().find(candidate => candidate !== page.mainFrame());
    assert.ok(frame, 'the author document is mounted in its own frame');
    const pageOffset = await page.evaluate(() => {
      const box = document.getElementById('wb-frame')!.getBoundingClientRect();
      return { x: box.x, y: box.y };
    });
    const slot = await frame.evaluate(() => {
      const layer = document.querySelector('.title') as HTMLElement;
      const box = layer.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });

    // A real double click on the text enters the editor's text mode.
    await page.mouse.click(pageOffset.x + slot.x, pageOffset.y + slot.y, { clickCount: 2 });
    await page.waitForFunction(
      () => {
        const iframe = document.getElementById('wb-frame') as HTMLIFrameElement;
        const win = iframe.contentWindow as Window & { __layerEditor?: { isEditing(): boolean } };
        return win.__layerEditor?.isEditing() === true;
      },
      { timeout: 10000 },
    );

    // Typing is autosaved while the text session is still open: the page must
    // serialize the live slot without ending the edit, moving the caret or
    // dropping the contenteditable state.
    await page.keyboard.type('FIRST CUT!');
    await page.waitForFunction(() => document.getElementById('wb-save-state')?.getAttribute('data-state') === 'saved', {
      timeout: 20000,
    });
    assert.equal(await waitForRevision(root, 2), 2, 'autosave really wrote the typed text');
    assert.match(
      await readFile(join(root, 'poster.html'), 'utf8'),
      /FIRST CUT!/,
      'the typed text reached the author source',
    );
    const during = await page.evaluate(() => {
      const iframe = document.getElementById('wb-frame') as HTMLIFrameElement;
      const win = iframe.contentWindow as Window & { __layerEditor?: { isEditing(): boolean } };
      const selection = iframe.contentWindow?.getSelection();
      const slot = iframe.contentDocument?.querySelector('.title');
      return {
        editing: win.__layerEditor?.isEditing() === true,
        editable: slot?.getAttribute('contenteditable') ?? '',
        caretInside: Boolean(selection?.anchorNode && slot?.contains(selection.anchorNode)),
      };
    });
    assert.equal(during.editing, true, 'autosave did not end the text session');
    assert.equal(during.editable, 'plaintext-only', 'the slot is still editable');
    assert.equal(during.caretInside, true, 'the caret stayed in the edited slot');

    // A later manual Ctrl+S still commits and writes the newest text through
    // the same queue; one save covers the text typed since the autosave.
    await page.keyboard.type(' AGAIN');
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyS');
    await page.keyboard.up('Control');
    await page.waitForFunction(() => document.getElementById('wb-save-state')?.getAttribute('data-state') === 'saved', {
      timeout: 20000,
    });

    const saved = await readFile(join(root, 'poster.html'), 'utf8');
    assert.match(saved, /FIRST CUT! AGAIN/, 'the committed text reached the author source');
    const project = JSON.parse(await readFile(join(root, 'project.json'), 'utf8')) as {
      imageDocuments: Array<{ revision: number }>;
    };
    assert.ok(project.imageDocuments[0].revision >= 3, 'the committed text advanced the revision');
    const editing = await page.evaluate(() => {
      const iframe = document.getElementById('wb-frame') as HTMLIFrameElement;
      const win = iframe.contentWindow as Window & { __layerEditor?: { isEditing(): boolean } };
      return win.__layerEditor?.isEditing();
    });
    assert.equal(editing, false, 'Ctrl+S ended the text session');
  } finally {
    await browser.close();
    await live.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function saveState(page: Page): Promise<string> {
  return page.evaluate(() => document.getElementById('wb-save-state')?.getAttribute('data-state') ?? '');
}

async function moveTitle(page: Page, left: number): Promise<void> {
  await page.evaluate((value: number) => {
    const iframe = document.getElementById('wb-frame') as HTMLIFrameElement;
    const win = iframe.contentWindow as Window & {
      __layerEditor: { layers(): Array<{ el: HTMLElement; id: string }> };
    };
    const layer = win.__layerEditor.layers().find(item => item.id === 'title');
    if (!layer) throw new Error('title layer not found');
    layer.el.style.left = `${value}px`;
  }, left);
}

test('an old status response cannot turn a newer save into a conflict', { skip: browserSkip }, async () => {
  const root = await fixture();
  const live = await serveWorkbench(root, { document: 'poster', target: 'wide' });
  const browser = await launchBrowser();
  try {
    const opened = (await (await call(live, '/api/document')).json()) as {
      document: { revision: number; contentHash: string };
    };
    const page = await openWorkbench(live, browser);
    await page.setRequestInterception(true);
    let hold = true;
    let arrived!: () => void;
    const inFlight = new Promise<void>(resolve => {
      arrived = resolve;
    });
    page.on('request', request => {
      if (hold && request.method() === 'GET' && request.url().includes('/api/status')) {
        hold = false;
        arrived();
        // Answer with the state from BEFORE the save that happens meanwhile.
        setTimeout(() => {
          void request.respond({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              dirty: false,
              document: opened.document,
              savedAt: null,
              result: null,
            }),
          });
        }, 4000);
        return;
      }
      void request.continue();
    });

    await inFlight;
    // First move: an automatic save lands and advances the base revision while
    // the status request is still parked.
    await moveTitle(page, 42);
    await waitForRevision(root, 2, 10000);
    // Keep the page dirty until the old response arrives, so an unguarded poll
    // would see "older revision + unsaved edits" and raise a false conflict.
    const started = Date.now();
    let step = 0;
    while (Date.now() - started < 4200) {
      await moveTitle(page, 45 + (step % 10));
      await new Promise(resolve => setTimeout(resolve, 350));
      step += 1;
    }
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.notEqual(await saveState(page), 'conflict', 'the late response did not fabricate a conflict');
    assert.equal(
      await page.evaluate(() => Boolean(document.querySelector('.wb-banner[data-kind="conflict"]'))),
      false,
      'no conflict banner was raised',
    );
    await page.waitForFunction(() => document.getElementById('wb-save-state')?.getAttribute('data-state') === 'saved', {
      timeout: 20000,
    });
  } finally {
    await browser.close();
    await live.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('sustained typing stays in the text session while the disk is updated', { skip: browserSkip }, async () => {
  const root = await fixture();
  const live = await serveWorkbench(root, { document: 'poster', target: 'wide' });
  const browser = await launchBrowser();
  try {
    const page = await openWorkbench(live, browser);
    const frame = page.frames().find(candidate => candidate !== page.mainFrame());
    assert.ok(frame, 'the author document is mounted in its own frame');
    const pageOffset = await page.evaluate(() => {
      const box = document.getElementById('wb-frame')!.getBoundingClientRect();
      return { x: box.x, y: box.y };
    });
    const slot = await frame.evaluate(() => {
      const layer = document.querySelector('.title') as HTMLElement;
      const box = layer.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    await page.mouse.click(pageOffset.x + slot.x, pageOffset.y + slot.y, { clickCount: 2 });
    await page.waitForFunction(
      () => {
        const iframe = document.getElementById('wb-frame') as HTMLIFrameElement;
        const win = iframe.contentWindow as Window & { __layerEditor?: { isEditing(): boolean } };
        return win.__layerEditor?.isEditing() === true;
      },
      { timeout: 10000 },
    );

    const typed = 'ABCDEFGHIJKLMNOPQRSTUVWX';
    const started = Date.now();
    await page.keyboard.type(typed, { delay: 150 });
    assert.ok(Date.now() - started >= 3500, 'the burst really lasted at least 3.5s');

    assert.ok((await waitForRevision(root, 2)) >= 2, 'the 3s timer wrote during the burst');
    const inProgress = await readFile(join(root, 'poster.html'), 'utf8');
    assert.match(inProgress, /ABCDEFGH/, 'the disk holds the text typed so far');
    const stillEditing = await page.evaluate(() => {
      const iframe = document.getElementById('wb-frame') as HTMLIFrameElement;
      const win = iframe.contentWindow as Window & { __layerEditor?: { isEditing(): boolean } };
      const slot = iframe.contentDocument?.querySelector('.title');
      return {
        editing: win.__layerEditor?.isEditing() === true,
        editable: slot?.getAttribute('contenteditable') ?? '',
      };
    });
    assert.equal(stillEditing.editing, true, 'the text session survived the autosave');
    assert.equal(stillEditing.editable, 'plaintext-only', 'the slot never lost contenteditable');

    await page.keyboard.down('Control');
    await page.keyboard.press('KeyS');
    await page.keyboard.up('Control');
    await page.waitForFunction(() => document.getElementById('wb-save-state')?.getAttribute('data-state') === 'saved', {
      timeout: 20000,
    });
    assert.match(
      await readFile(join(root, 'poster.html'), 'utf8'),
      new RegExp(typed),
      'the committed burst is on disk',
    );
  } finally {
    await browser.close();
    await live.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a held pointer drag is autosaved before release', { skip: browserSkip }, async () => {
  const root = await fixture();
  const live = await serveWorkbench(root, { document: 'poster', target: 'wide' });
  const browser = await launchBrowser();
  try {
    const page = await openWorkbench(live, browser);
    const frame = page.frames().find(candidate => candidate !== page.mainFrame());
    assert.ok(frame);
    const pageOffset = await page.evaluate(() => {
      const box = document.getElementById('wb-frame')!.getBoundingClientRect();
      return { x: box.x, y: box.y };
    });
    const slot = await frame.evaluate(() => {
      const layer = document.querySelector('.title') as HTMLElement;
      const box = layer.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });

    await page.mouse.move(pageOffset.x + slot.x, pageOffset.y + slot.y);
    await page.mouse.down();
    await page.mouse.move(pageOffset.x + slot.x + 64, pageOffset.y + slot.y + 24, { steps: 6 });

    // No pointerup: the idle autosave must still land while the button is held.
    await waitForRevision(root, 2);
    const held = await page.evaluate(() => document.getElementById('wb-save-state')?.getAttribute('data-state'));
    assert.notEqual(held, 'failed', 'the save while holding the pointer did not fail');
    const saved = await readFile(join(root, 'poster.html'), 'utf8');
    const moved = saved.match(/"id":"title","dx":(-?[\d.]+)/);
    assert.ok(moved, 'the edit record carries the dragged layer');
    assert.notEqual(Number(moved[1]), 0, 'the drag really moved the layer');

    await page.mouse.up();
  } finally {
    await browser.close();
    await live.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the formal still and the workbench consume the same layout record', { skip: browserSkip }, async () => {
  const root = await fixture(LAYOUT_DOC, LAYOUT_CSS);
  const live = await serveWorkbench(root, { document: 'poster', target: 'wide' });
  const browser = await launchBrowser();
  try {
    const page = await openWorkbench(live, browser);
    const layerLeft = () =>
      page.evaluate(() => {
        const iframe = document.getElementById('wb-frame') as HTMLIFrameElement;
        const layer = iframe.contentDocument?.querySelector('[data-layer-id="title"]') as HTMLElement | null;
        return layer?.style.left ?? '';
      });
    assert.equal(await layerLeft(), '20px', 'the author load script owns the initial layout');

    await page.evaluate(() => {
      const iframe = document.getElementById('wb-frame') as HTMLIFrameElement;
      const layer = iframe.contentDocument?.querySelector('[data-layer-id="title"]') as HTMLElement | null;
      if (!layer) throw new Error('title layer not found');
      layer.style.left = '120px';
    });
    await page.waitForFunction(() => document.getElementById('wb-save-state')?.getAttribute('data-state') === 'saved', {
      timeout: 20000,
    });
    await waitForRevision(root, 2);

    const savedSource = await readFile(join(root, 'poster.html'), 'utf8');
    assert.match(savedSource, /"id":"title","dx":100(?:[.,]0*)?[,}]/, 'the record kept the user offset');
    assert.match(savedSource, /addEventListener\('load'/, 'the author load script was not deleted');

    const first = await renderImage(root, { target: 'wide' });
    assert.deepEqual({ width: first.width, height: first.height }, { width: 480, height: 300 });
    const firstBytes = await readFile(join(root, ...first.path.split('/')));
    const firstInk = await inkLeft(browser, firstBytes, 40, 120);
    assert.ok(firstInk >= 236 && firstInk <= 244, `the formal PNG applies the saved layout (ink at ${firstInk})`);

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => document.getElementById('wb-app')?.getAttribute('data-phase') === 'mounted', {
      timeout: 30000,
    });
    assert.equal(await layerLeft(), '120px', 'reopening applies the valid record');

    // An external author edit makes the record inert: the source (and its own
    // load script) wins in both the preview and the produced still.
    await appendFile(join(root, 'poster.html'), '\n<!-- author touch -->\n');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => document.getElementById('wb-app')?.getAttribute('data-phase') === 'mounted', {
      timeout: 30000,
    });
    assert.equal(await layerLeft(), '20px', 'a changed source wins over the stale record');

    const second = await renderImage(root, { target: 'wide' });
    assert.notEqual(second.artifact, first.artifact, 'a changed source produces a new still');
    const secondBytes = await readFile(join(root, ...second.path.split('/')));
    const secondInk = await inkLeft(browser, secondBytes, 40, 120);
    assert.ok(secondInk >= 36 && secondInk <= 44, `the formal PNG ignores the stale record (ink at ${secondInk})`);
  } finally {
    await browser.close();
    await live.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a save keeps the author HTML and records only the edits the user made', { skip: browserSkip }, async () => {
  const root = await fixture(DYNAMIC_DOC, DYNAMIC_CSS);
  const live = await serveWorkbench(root, { document: 'poster', target: 'wide' });
  const browser = await launchBrowser();
  const revision = async () =>
    (
      JSON.parse(await readFile(join(root, 'project.json'), 'utf8')) as {
        imageDocuments: Array<{ revision: number }>;
      }
    ).imageDocuments[0].revision;
  try {
    const page = await openWorkbench(live, browser);
    const view = () =>
      page.evaluate(() => {
        const iframe = document.getElementById('wb-frame') as HTMLIFrameElement;
        const doc = iframe.contentDocument!;
        const win = iframe.contentWindow as Window & {
          __layerEditor?: { layers(): Array<{ el: HTMLElement; id: string }> };
        };
        const title = doc.querySelector('[data-layer-id="title"]') as HTMLElement | null;
        const generated = doc.querySelectorAll('[data-layer-id="generated"]');
        const slot = generated[0]?.querySelector('span') as HTMLElement | null;
        return {
          authored: Number(doc.documentElement.dataset.generatedCount || 0),
          generated: generated.length,
          generatedText: generated[0]?.textContent ?? '',
          generatedFont: slot ? getComputedStyle(slot).fontSize : '',
          layers: (win.__layerEditor?.layers() ?? []).map(item => item.id).sort(),
          titleLeft: title?.style.left ?? '',
          sub: doc.querySelectorAll('[data-layer-id="sub"]').length,
        };
      });
    const point = async (selector: string) => {
      const offset = await page.evaluate(() => {
        const box = document.getElementById('wb-frame')!.getBoundingClientRect();
        return { x: box.x, y: box.y };
      });
      const local = await page.evaluate((sel: string) => {
        const iframe = document.getElementById('wb-frame') as HTMLIFrameElement;
        const el = iframe.contentDocument!.querySelector(sel) as HTMLElement;
        const box = el.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      }, selector);
      return { x: offset.x + local.x, y: offset.y + local.y };
    };

    const before = await view();
    assert.equal(before.authored, 3, 'the load script authored one layer on top of two static ones');
    assert.equal(before.generated, 1);
    assert.deepEqual(before.layers, ['generated', 'sub', 'title']);

    // A control render: the second static layer is really visible in the still.
    const control = await renderImage(root, { target: 'wide' });
    const controlBytes = await readFile(join(root, ...control.path.split('/')));
    assert.ok(
      (await inkLeft(browser, controlBytes, 200, 240)) >= 36,
      'the control still shows the layer that will be deleted',
    );

    // 1. Text typed into a layer the author script creates on every load.
    const note = await point('[data-layer-id="generated"] span');
    await page.mouse.click(note.x, note.y, { clickCount: 2 });
    await page.waitForFunction(
      () => {
        const iframe = document.getElementById('wb-frame') as HTMLIFrameElement;
        const win = iframe.contentWindow as Window & { __layerEditor?: { isEditing(): boolean } };
        return win.__layerEditor?.isEditing() === true;
      },
      { timeout: 10000 },
    );
    await page.keyboard.type('DYNAMIC TEXT');
    await page.keyboard.press('Enter');

    // 2. A layer moved inside a nested, flow-laid-out container.
    await moveTitle(page, 120);

    // 3. A font step on the generated layer, and 4. deletion of a static layer.
    await page.evaluate(() => {
      const iframe = document.getElementById('wb-frame') as HTMLIFrameElement;
      const win = iframe.contentWindow as Window & {
        __layerEditor: {
          layers(): Array<{ el: HTMLElement; id: string }>;
          select(el: HTMLElement): void;
          scaleFont(el: HTMLElement, factor: number): void;
          removeLayer(el: HTMLElement): void;
        };
      };
      const generated = win.__layerEditor.layers().find(item => item.id === 'generated');
      const sub = win.__layerEditor.layers().find(item => item.id === 'sub');
      if (!generated || !sub) throw new Error('expected layers are missing');
      win.__layerEditor.select(generated.el);
      win.__layerEditor.scaleFont(generated.el, 1.5);
      win.__layerEditor.removeLayer(sub.el);
    });
    await page.click('#wb-save');
    await page.waitForFunction(() => document.getElementById('wb-save-state')?.getAttribute('data-state') === 'saved', {
      timeout: 20000,
    });
    await waitForRevision(root, 2);

    // The saved document is the author's own HTML, byte for byte, plus one
    // record. Scripts, comments, nesting and the absence of editor artifacts
    // are all covered by that single comparison.
    const saved = await readFile(join(root, 'poster.html'), 'utf8');
    const authorPart = saved.replace(/<script type="application\/json" data-viscraft-layout>[\s\S]*?<\/script>\n/, '');
    assert.equal(authorPart, DYNAMIC_DOC, 'the author source was not rewritten');
    assert.match(saved, /"id":"title","dx":100(?:[.,]0*)?[,}]/, 'the move is recorded as an offset');
    assert.match(saved, /"removed":\["sub"\]/, 'the deletion is recorded, not applied to the source');
    assert.match(saved, /"layer":"generated"/, 'the text edit names the script-created layer');
    assert.match(
      saved,
      /"from":"generated copy","html":"DYNAMIC TEXT"/,
      'the text edit keeps the source text it replaced',
    );
    assert.match(saved, /"to":\{"size":"18px"/, 'the font step is recorded');

    const still = await renderImage(root, { target: 'wide' });
    const stillBytes = await readFile(join(root, ...still.path.split('/')));
    const movedInk = await inkLeft(browser, stillBytes, 40, 100);
    assert.ok(movedInk >= 236 && movedInk <= 244, `the still applies the recorded offset (ink at ${movedInk})`);
    assert.equal(await inkLeft(browser, stillBytes, 200, 240), -1, 'the still applies the recorded deletion');

    // A reopened page must reproduce the SAME document, not a new one.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => document.getElementById('wb-app')?.getAttribute('data-phase') === 'mounted', {
      timeout: 30000,
    });
    const after = await view();
    assert.equal(after.authored, 3, 'reopening did not multiply the generated layer');
    assert.equal(after.generated, 1, 'the generated layer exists exactly once');
    assert.equal(after.generatedText, 'DYNAMIC TEXT', 'the typed text survived the reopen');
    assert.equal(after.generatedFont, '18px', 'the recorded font step survived the reopen');
    assert.equal(after.titleLeft, '120px', 'the recorded offset survived the reopen');
    assert.equal(after.sub, 0, 'the recorded deletion survived the reopen');
    assert.deepEqual(after.layers, ['generated', 'title']);

    // Reopening must not look dirty: the record round-trips to the same bytes,
    // so an idle page never rewrites the source with a shifted record.
    await new Promise(resolve => setTimeout(resolve, 2500));
    assert.equal(await readFile(join(root, 'poster.html'), 'utf8'), saved, 'an idle reopen wrote nothing');
    assert.equal(await revision(), 2, 'an idle reopen did not advance the revision');

    // Editing the text and typing the same text back produces the same record.
    // The page compares the document it would save, so this is not an edit at
    // all: nothing is written and the file stays exactly as it was.
    const again = await point('[data-layer-id="generated"] span');
    await page.mouse.click(again.x, again.y, { clickCount: 2 });
    await page.waitForFunction(
      () => {
        const iframe = document.getElementById('wb-frame') as HTMLIFrameElement;
        const win = iframe.contentWindow as Window & { __layerEditor?: { isEditing(): boolean } };
        return win.__layerEditor?.isEditing() === true;
      },
      { timeout: 10000 },
    );
    await page.keyboard.type('DYNAMIC TEXT');
    await page.keyboard.press('Enter');
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(await saveState(page), 'clean', 'an edit that reproduces the same document is not dirty');
    assert.equal(
      await readFile(join(root, 'poster.html'), 'utf8'),
      saved,
      'a repeated edit did not rewrite the source',
    );
    assert.equal(await revision(), 2, 'a repeated edit did not advance the revision');
    assert.equal((await view()).generatedText, 'DYNAMIC TEXT', 'the text on screen is still the recorded one');

    // A later session composes with the recorded offset instead of replacing
    // it: the layer was already 100px right of its authored position.
    await moveTitle(page, 150);
    await page.waitForFunction(() => document.getElementById('wb-save-state')?.getAttribute('data-state') === 'saved', {
      timeout: 20000,
    });
    await waitForRevision(root, 3);
    assert.match(
      await readFile(join(root, 'poster.html'), 'utf8'),
      /"id":"title","dx":130(?:[.,]0*)?[,}]/,
      'the new move is measured against the authored position, not the recorded one',
    );
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => document.getElementById('wb-app')?.getAttribute('data-phase') === 'mounted', {
      timeout: 30000,
    });
    assert.equal((await view()).titleLeft, '150px', 'the composed offset reopened');
  } finally {
    await browser.close();
    await live.close();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'browser recovery writes restored edits before clearing their only recovery copy',
  { skip: browserSkip },
  async () => {
    const root = await fixture();
    const live = await serveWorkbench(root, { document: 'poster', target: 'wide' });
    const browser = await launchBrowser();
    try {
      const page = await openWorkbench(live, browser);
      page.on('dialog', dialog => {
        void dialog.accept();
      });
      let rejectSaves = true;
      let submittedSaves = 0;
      await page.setRequestInterception(true);
      page.on('request', request => {
        if (request.method() === 'PUT' && request.url().endsWith('/api/document')) {
          if (rejectSaves) {
            void request.respond({
              status: 409,
              contentType: 'application/json',
              body: JSON.stringify({ error: 'busy', message: 'Project author is busy' }),
            });
            return;
          }
          submittedSaves += 1;
        }
        void request.continue();
      });
      await moveTitle(page, 42);
      await page.waitForFunction(
        () => document.getElementById('wb-save-state')?.getAttribute('data-state') === 'failed',
        { timeout: 20000 },
      );
      await page.waitForFunction(() => localStorage.getItem('viscraft.workbench.recovery:poster') !== null);
      assert.equal(JSON.parse(await readFile(join(root, 'project.json'), 'utf8')).imageDocuments[0].revision, 1);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll('#wb-banners button')).some(
          button => button.textContent === 'Restore edits',
        ),
      );
      rejectSaves = false;
      await page.evaluate(() => {
        const button = Array.from(document.querySelectorAll('#wb-banners button')).find(
          item => item.textContent === 'Restore edits',
        ) as HTMLButtonElement;
        button.click();
      });
      await page.waitForFunction(
        () => document.getElementById('wb-save-state')?.getAttribute('data-state') === 'saved',
        { timeout: 10000 },
      );
      assert.equal(submittedSaves, 1, 'restoration must reach the Runtime save queue');
      assert.equal(await waitForRevision(root, 2), 2);
      assert.match(await readFile(join(root, 'poster.html'), 'utf8'), /"id":"title","dx":22(?:[.,]0*)?[,}]/);
      assert.equal(await page.evaluate(() => localStorage.getItem('viscraft.workbench.recovery:poster')), null);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => {
        const frame = document.getElementById('wb-frame') as HTMLIFrameElement;
        const layer = frame.contentDocument?.querySelector('[data-layer-id="title"]');
        return layer && getComputedStyle(layer).left === '42px';
      });
    } finally {
      await browser.close();
      await live.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'a busy save keeps the edit pending, shows the lock message, and a retry writes it',
  { skip: browserSkip },
  async () => {
    const root = await fixture();
    const live = await serveWorkbench(root, { document: 'poster', target: 'wide' });
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1200, height: 900 });
      let failSaves = true;
      await page.setRequestInterception(true);
      page.on('request', request => {
        if (failSaves && request.method() === 'PUT' && request.url().endsWith('/api/document')) {
          void request.respond({
            status: 409,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'busy', message: 'Project author is locked by PID 4242' }),
          });
          return;
        }
        void request.continue();
      });
      await page.goto(live.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForFunction(() => document.getElementById('wb-app')?.getAttribute('data-phase') === 'mounted', {
        timeout: 30000,
      });

      await page.evaluate(() => {
        const iframe = document.getElementById('wb-frame') as HTMLIFrameElement;
        const win = iframe.contentWindow as Window & {
          __layerEditor: { layers(): Array<{ el: HTMLElement; id: string }> };
        };
        const layer = win.__layerEditor.layers().find(item => item.id === 'title');
        if (!layer) throw new Error('title layer not found');
        layer.el.style.left = '42px';
      });
      await page.waitForFunction(
        () => document.getElementById('wb-save-state')?.getAttribute('data-state') === 'failed',
        {
          timeout: 20000,
        },
      );
      const failure = await page.evaluate(() => ({
        banner: document.querySelector('.wb-banner[data-kind="failed"]')?.textContent ?? '',
        retry: Boolean(document.querySelector('.wb-banner[data-kind="failed"] button')),
      }));
      assert.match(failure.banner, /PID 4242/, 'the busy reply surfaces the lock holder message');
      assert.equal(failure.retry, true, 'the page offers a retry instead of auto-looping');
      assert.equal(
        JSON.parse(await readFile(join(root, 'project.json'), 'utf8')).imageDocuments[0].revision,
        1,
        'the failed save wrote nothing',
      );

      // The failed response must not clear the dirty baseline: the retry still
      // has something to write.
      failSaves = false;
      await page.click('#wb-save');
      await page.waitForFunction(
        () => document.getElementById('wb-save-state')?.getAttribute('data-state') === 'saved',
        {
          timeout: 20000,
        },
      );
      assert.equal(await waitForRevision(root, 2), 2, 'the retry wrote the preserved edit');
      assert.match(await readFile(join(root, 'poster.html'), 'utf8'), /"id":"title","dx":22(?:[.,]0*)?[,}]/);
    } finally {
      await browser.close();
      await live.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'the outer Save and Render buttons commit an edit a snapshot autosave already stored',
  { skip: browserSkip },
  async () => {
    const root = await fixture();
    const live = await serveWorkbench(root, { document: 'poster', target: 'wide' });
    const browser = await launchBrowser();
    try {
      const page = await openWorkbench(live, browser);
      const frame = page.frames().find(candidate => candidate !== page.mainFrame());
      assert.ok(frame);
      const frameOffset = () =>
        page.evaluate(() => {
          const box = document.getElementById('wb-frame')!.getBoundingClientRect();
          return { x: box.x, y: box.y };
        });
      const slotCentre = async () =>
        frame.evaluate(() => {
          const layer = document.querySelector('.title') as HTMLElement;
          const box = layer.getBoundingClientRect();
          return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        });
      const enterText = async () => {
        const slot = await slotCentre();
        const pageOffset = await frameOffset();
        await page.mouse.click(pageOffset.x + slot.x, pageOffset.y + slot.y, { clickCount: 2 });
        await page.waitForFunction(
          () => {
            const iframe = document.getElementById('wb-frame') as HTMLIFrameElement;
            const win = iframe.contentWindow as Window & { __layerEditor?: { isEditing(): boolean } };
            return win.__layerEditor?.isEditing() === true;
          },
          { timeout: 10000 },
        );
      };
      const editing = () =>
        page.evaluate(() => {
          const iframe = document.getElementById('wb-frame') as HTMLIFrameElement;
          const win = iframe.contentWindow as Window & { __layerEditor?: { isEditing(): boolean } };
          return win.__layerEditor?.isEditing() === true;
        });

      // A snapshot autosave has already stored this text when the outer button
      // is clicked; the edit counter is settled, but the session is still open.
      await enterText();
      await page.keyboard.type('A MUCH LONGER TITLE THAT MUST REFIT');
      await page.waitForFunction(
        () => document.getElementById('wb-save-state')?.getAttribute('data-state') === 'saved',
        {
          timeout: 20000,
        },
      );
      assert.equal(await editing(), true, 'the snapshot autosave left the text session open');
      await page.click('#wb-save');
      await waitForRevision(root, 3, 20000);
      await page.waitForFunction(
        () => document.getElementById('wb-save-state')?.getAttribute('data-state') === 'saved',
        {
          timeout: 20000,
        },
      );
      assert.equal(await editing(), false, 'the outer Save committed and closed the session');
      const committed = await readFile(join(root, 'poster.html'), 'utf8');
      assert.match(committed, /A MUCH LONGER TITLE THAT MUST REFIT/, 'the committed text is on disk');
      const width = committed.match(/"id":"title"[^}]*"width":([\d.]+)/);
      assert.ok(width && Number(width[1]) >= 210, `the commit applied the editor refit (width=${width?.[1]})`);

      // The same gap on Render: snapshot-saved text, settled counter, open edit.
      // The outer Save inserted its notice banner above the stage; wait for that
      // layout change to land and settle before sampling the second click point.
      await page.waitForFunction(() => Boolean(document.querySelector('.wb-banner[data-kind="notice"]')));
      await page.evaluate(
        () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );
      await enterText();
      await page.keyboard.type('!');
      await page.waitForFunction(
        () => document.getElementById('wb-save-state')?.getAttribute('data-state') === 'saved',
        {
          timeout: 20000,
        },
      );
      assert.equal(await editing(), true, 'the second snapshot autosave left the session open');
      await page.click('#wb-render');
      await page.waitForFunction(
        () => document.getElementById('wb-out-state')?.getAttribute('data-state') === 'success',
        { timeout: 30000 },
      );
      assert.equal(await editing(), false, 'Render committed the open text before rasterizing');
      const href = await page.evaluate(
        () => (document.getElementById('wb-download') as HTMLAnchorElement).getAttribute('href') ?? '',
      );
      const download = await fetch(new URL(href, live.url).href);
      assert.equal(download.status, 200);
      assert.deepEqual(pngSize(Buffer.from(await download.arrayBuffer())), { width: 480, height: 300 });
    } finally {
      await browser.close();
      await live.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('a changed declared resource makes the shown output stale on the next poll', { skip: browserSkip }, async () => {
  const root = await fixture();
  const live = await serveWorkbench(root, { document: 'poster', target: 'wide' });
  const browser = await launchBrowser();
  try {
    const page = await openWorkbench(live, browser);
    await page.click('#wb-render');
    await page.waitForFunction(
      () => document.getElementById('wb-out-state')?.getAttribute('data-state') === 'success',
      { timeout: 30000 },
    );

    // The document bytes and revision do not change; only a declared resource.
    await appendFile(join(root, 'ink.css'), '\n.title{letter-spacing:3px}\n');
    await page.waitForFunction(() => document.getElementById('wb-out-state')?.getAttribute('data-state') === 'stale', {
      timeout: 15000,
    });
    const view = await page.evaluate(() => ({
      state: document.getElementById('wb-out-state')?.getAttribute('data-state'),
      detail: document.getElementById('wb-out-detail')?.textContent ?? '',
      download: (document.getElementById('wb-download') as HTMLAnchorElement).getAttribute('href') ?? '',
    }));
    assert.equal(view.state, 'stale');
    assert.match(view.detail, /declared resource changed/i);
    assert.match(view.download, /\/api\/output\?target=wide/, 'a stale output stays downloadable');
  } finally {
    await browser.close();
    await live.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a save response cannot clear text typed while it was in flight', { skip: browserSkip }, async () => {
  const root = await fixture();
  const live = await serveWorkbench(root, { document: 'poster', target: 'wide' });
  const browser = await launchBrowser();
  try {
    const page = await openWorkbench(live, browser);
    const frame = page.frames().find(candidate => candidate !== page.mainFrame());
    assert.ok(frame);
    const pageOffset = await page.evaluate(() => {
      const box = document.getElementById('wb-frame')!.getBoundingClientRect();
      return { x: box.x, y: box.y };
    });
    const slot = await frame.evaluate(() => {
      const layer = document.querySelector('.title') as HTMLElement;
      const box = layer.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    await page.mouse.click(pageOffset.x + slot.x, pageOffset.y + slot.y, { clickCount: 2 });
    await page.waitForFunction(
      () => {
        const iframe = document.getElementById('wb-frame') as HTMLIFrameElement;
        const win = iframe.contentWindow as Window & { __layerEditor?: { isEditing(): boolean } };
        return win.__layerEditor?.isEditing() === true;
      },
      { timeout: 10000 },
    );

    let started: () => void = () => undefined;
    const putStarted = new Promise<void>(resolve => {
      started = resolve;
    });
    await page.setRequestInterception(true);
    page.on('request', request => {
      void (async () => {
        if (request.method() === 'PUT' && request.url().endsWith('/api/document')) {
          started();
          await new Promise(resolve => setTimeout(resolve, 1200));
        }
        await request.continue();
      })();
    });

    // The first PUT snapshots 'A'; 'B' arrives while that response is pending.
    await page.keyboard.type('A');
    await putStarted;
    await page.keyboard.type('B');

    const deadline = Date.now() + 25000;
    let saved = '';
    for (;;) {
      saved = await readFile(join(root, 'poster.html'), 'utf8');
      if (/AB/.test(saved)) break;
      if (Date.now() > deadline)
        throw new Error(`the in-flight edit never reached disk (last bytes: ${saved.slice(0, 80)})`);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    await page.waitForFunction(() => document.getElementById('wb-save-state')?.getAttribute('data-state') === 'saved', {
      timeout: 20000,
    });
    assert.match(saved, /AB/, 'the newer text was written after the older response');
    const revision = await waitForRevision(root, 3);
    assert.ok(revision >= 3, 'the stale response did not advance the baseline past the newer edit');
  } finally {
    await browser.close();
    await live.close();
    await rm(root, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------
 * The fixed structure-view entry
 *
 * The shell owns the button; the editor owns expansion. The regression
 * below drives only the fixed shell button and observable editor state,
 * plus the real Save/Render pipeline, so it cannot pass by inspecting a
 * screenshot of the gallery.
 * ------------------------------------------------------------- */

type ViewSnapshot = {
  exists: boolean;
  label: string;
  pressed: string;
  disabled: boolean;
  busy: string;
  exploded: boolean;
  transitioning: boolean;
  bodyExploded: boolean;
  board: boolean;
  settled: boolean;
  selected: boolean;
  editing: boolean;
  tiles: number;
  primary: string;
  supplements: string;
  overview: number;
  background: number;
  groups: number;
  layerTiles: number;
};

async function viewSnapshot(page: Page): Promise<ViewSnapshot> {
  return page.evaluate(() => {
    const button = document.getElementById('wb-explode') as HTMLButtonElement | null;
    const frame = document.getElementById('wb-frame') as HTMLIFrameElement | null;
    const doc = frame?.contentDocument ?? null;
    const win = frame?.contentWindow as
      | (Window & {
          __layerEditor?: {
            state?: { exploded?: boolean; transitioning?: boolean };
            isEditing?: () => boolean;
          };
        })
      | null;
    const board = doc?.querySelector('.hf-exploded-board') as HTMLElement | null;
    return {
      exists: Boolean(button),
      label: button?.textContent?.trim() ?? '',
      pressed: button?.getAttribute('aria-pressed') ?? '',
      disabled: button?.disabled ?? false,
      busy: button?.getAttribute('aria-busy') ?? '',
      exploded: win?.__layerEditor?.state?.exploded === true,
      transitioning: win?.__layerEditor?.state?.transitioning === true,
      bodyExploded: doc?.body.classList.contains('hf-exploded-on') ?? false,
      board: Boolean(board),
      settled: board?.classList.contains('hf-exploded-settled') ?? false,
      selected: Boolean(doc?.querySelector('.hf-sel')),
      editing: win?.__layerEditor?.isEditing?.() === true,
      tiles: doc?.querySelectorAll('.hf-exploded-item').length ?? 0,
      primary: board?.dataset.explodedPrimaryCount ?? '',
      supplements: board?.dataset.explodedTextSupplements ?? '',
      overview: doc?.querySelectorAll('.hf-exploded-item[data-exploded-overview]').length ?? 0,
      background: doc?.querySelectorAll('.hf-exploded-item[data-exploded-background]').length ?? 0,
      groups: doc?.querySelectorAll('.hf-exploded-item[data-exploded-group]').length ?? 0,
      layerTiles: doc?.querySelectorAll('.hf-exploded-item[data-exploded-unit="layer"]').length ?? 0,
    };
  }) as Promise<ViewSnapshot>;
}

async function waitForView(page: Page, exploded: boolean): Promise<void> {
  await page.waitForFunction(
    (expected: boolean) => {
      const button = document.getElementById('wb-explode');
      const frame = document.getElementById('wb-frame') as HTMLIFrameElement | null;
      const win = frame?.contentWindow as
        (Window & { __layerEditor?: { state?: { exploded?: boolean; transitioning?: boolean } } }) | null;
      const doc = frame?.contentDocument;
      const board = doc?.querySelector('.hf-exploded-board') as HTMLElement | null;
      return (
        Boolean(button) &&
        button!.getAttribute('aria-pressed') === String(expected) &&
        win?.__layerEditor?.state?.exploded === expected &&
        win?.__layerEditor?.state?.transitioning === false &&
        Boolean(board) === expected &&
        (!expected || board!.classList.contains('hf-exploded-settled'))
      );
    },
    { timeout: 20000 },
    exploded,
  );
}

async function expandLayers(page: Page): Promise<void> {
  await page.click('#wb-explode');
  await waitForView(page, true);
}

async function collapseLayers(page: Page): Promise<void> {
  await page.click('#wb-explode');
  await waitForView(page, false);
}

async function focusInFrame(page: Page, selector: string): Promise<void> {
  const frame = page.frames().find(candidate => candidate !== page.mainFrame());
  assert.ok(frame, 'the author document frame is mounted');
  await frame.evaluate((target: string) => {
    const el = document.querySelector(target) as HTMLElement | null;
    if (!el) throw new Error(`${target} not found`);
    el.tabIndex = -1;
    el.focus();
  }, selector);
}

async function statusResult(live: WorkbenchServer): Promise<{ path: string; sha256?: string } | null> {
  const body = (await (await call(live, '/api/status')).json()) as {
    result: { path: string; sha256?: string } | null;
  };
  return body.result;
}

async function downloadOutput(live: WorkbenchServer, page: Page): Promise<Buffer> {
  const href = await page.evaluate(
    () => (document.getElementById('wb-download') as HTMLAnchorElement).getAttribute('href') ?? '',
  );
  assert.match(href, /\/api\/output\?target=wide/);
  const download = await fetch(new URL(href, live.url).href);
  assert.equal(download.status, 200);
  return Buffer.from(await download.arrayBuffer());
}

test(
  'the fixed View layers button opens and closes the real structure view without touching the author source',
  { skip: browserSkip },
  async () => {
    const root = await fixture(MULTI_DOC, MULTI_CSS);
    const live = await serveWorkbench(root, { document: 'poster', target: 'wide' });
    const browser = await launchBrowser();
    try {
      const page = await openWorkbench(live, browser);
      const sourceBefore = await readFile(join(root, 'poster.html'), 'utf8');
      const projectBefore = await readFile(join(root, 'project.json'), 'utf8');
      const resultBefore = await statusResult(live);

      const initial = await viewSnapshot(page);
      assert.equal(initial.exists, true, 'the fixed shell exposes the view button');
      assert.equal(initial.label, 'View layers');
      assert.equal(initial.pressed, 'false');
      assert.equal(initial.disabled, false);
      assert.equal(initial.board, false, 'the default view is plain editing');
      assert.equal(initial.bodyExploded, false);

      // Record every state the shell publishes while the transition runs.
      await page.evaluate(() => {
        const button = document.getElementById('wb-explode') as HTMLButtonElement;
        const log: Array<{ disabled: boolean; pressed: string; busy: string; label: string }> = [];
        (window as unknown as { __viewLog: typeof log }).__viewLog = log;
        new MutationObserver(() => {
          log.push({
            disabled: button.disabled,
            pressed: button.getAttribute('aria-pressed') ?? '',
            busy: button.getAttribute('aria-busy') ?? '',
            label: button.textContent?.trim() ?? '',
          });
        }).observe(button, { attributes: true, childList: true, characterData: true, subtree: true });
      });

      // Open the view and immediately click a real card while the expansion is
      // still transitioning. A hidden layer must not become selected, and the
      // open must not be cancelled by that premature click.
      const fastCardClick = await page.evaluate(() => {
        const button = document.getElementById('wb-explode') as HTMLButtonElement;
        button.click();
        const doc = (document.getElementById('wb-frame') as HTMLIFrameElement).contentDocument;
        const card = doc?.querySelector('.hf-exploded-item[data-exploded-unit="layer"]') as HTMLElement | null;
        card?.click();
        return Boolean(card);
      });
      assert.equal(fastCardClick, true, 'the gallery already exposes a card during the opening transition');
      await waitForView(page, true);

      const expanded = await viewSnapshot(page);
      assert.equal(expanded.label, 'Back to editing');
      assert.equal(expanded.pressed, 'true');
      assert.equal(expanded.disabled, false, 'the button is usable again once the transition settles');
      assert.equal(expanded.busy, '', 'no transition marker is left behind');
      assert.equal(expanded.exploded, true);
      assert.equal(expanded.bodyExploded, true);
      assert.equal(expanded.board, true);
      assert.equal(expanded.settled, true);
      assert.equal(expanded.selected, false, 'the premature card click did not select a hidden layer');
      assert.equal(expanded.editing, false);
      assert.equal(expanded.primary, '2', 'two primary units: the declared module and the standalone layer');
      assert.equal(expanded.supplements, '2', 'the grouped real text is shown as supplemental cards');
      assert.equal(expanded.overview, 1, 'the complete composition is shown');
      assert.equal(expanded.background, 1, 'the background is shown as a labelled reference, not a layer');
      assert.equal(expanded.groups, 1, 'the declared group stays one module');
      assert.ok(expanded.layerTiles >= 3, 'module + standalone + text cards are real content');
      assert.ok(expanded.tiles > expanded.layerTiles, 'overview/background exist without being counted as layers');
      const supplementText = await page.evaluate(() => {
        const doc = (document.getElementById('wb-frame') as HTMLIFrameElement).contentDocument;
        return Array.from(doc?.querySelectorAll('.hf-exploded-item[data-exploded-text-supplement]') ?? [])
          .map(node => node.textContent?.replace(/\s+/g, ' ').trim() ?? '')
          .join('|');
      });
      assert.match(supplementText, /STRUCTURE/, 'the grouped real text is cloned into the cards');

      const transitionLog = await page.evaluate(
        () => (window as unknown as { __viewLog: Array<{ disabled: boolean; label: string }> }).__viewLog,
      );
      assert.ok(
        transitionLog.some(entry => entry.disabled),
        'the shell disabled the fixed button while the transition owned the editor',
      );
      assert.ok(
        transitionLog.some(entry => entry.label === 'Back to editing'),
        'the shell published the expanded label during the same transition',
      );

      // The expanded view is display only: author bytes, the Project revision
      // and the recorded result stay byte-identical through an autosave period.
      assert.equal(await readFile(join(root, 'poster.html'), 'utf8'), sourceBefore);
      assert.equal(await readFile(join(root, 'project.json'), 'utf8'), projectBefore);
      assert.deepEqual(await statusResult(live), resultBefore);
      await new Promise(resolve => setTimeout(resolve, 2200));
      assert.equal(await readFile(join(root, 'poster.html'), 'utf8'), sourceBefore, 'no background save ran');
      assert.equal(await readFile(join(root, 'project.json'), 'utf8'), projectBefore, 'no revision moved');
      assert.deepEqual(await statusResult(live), resultBefore, 'no artifact was recorded');
      assert.ok(['clean', 'saved'].includes(await saveState(page)), 'the page never became dirty');

      await collapseLayers(page);
      const collapsed = await viewSnapshot(page);
      assert.equal(collapsed.label, 'View layers');
      assert.equal(collapsed.pressed, 'false');
      assert.equal(collapsed.board, false);
      assert.equal(collapsed.bodyExploded, false);
      assert.equal(await readFile(join(root, 'poster.html'), 'utf8'), sourceBefore);
      assert.equal(await readFile(join(root, 'project.json'), 'utf8'), projectBefore);
    } finally {
      await browser.close();
      await live.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'Escape, a card and the side panel all leave the view and keep the fixed button in sync',
  {
    skip: browserSkip,
  },
  async () => {
    const root = await fixture(MULTI_DOC, MULTI_CSS);
    const live = await serveWorkbench(root, { document: 'poster', target: 'wide' });
    const browser = await launchBrowser();
    try {
      const page = await openWorkbench(live, browser);
      const frame = page.frames().find(candidate => candidate !== page.mainFrame());
      assert.ok(frame);
      const source = await readFile(join(root, 'poster.html'), 'utf8');

      // Escape inside the author document.
      await expandLayers(page);
      await focusInFrame(page, '.hf-exploded-board');
      await page.keyboard.press('Escape');
      await waitForView(page, false);
      assert.equal((await viewSnapshot(page)).label, 'View layers');

      // Clicking a real gallery card returns to editing and selects its layer.
      await expandLayers(page);
      await frame.click('.hf-exploded-item[data-exploded-unit="layer"][data-layer-name="badge"]');
      await waitForView(page, false);
      const selected = await page.evaluate(() => {
        const doc = (document.getElementById('wb-frame') as HTMLIFrameElement).contentDocument;
        return doc?.querySelector('.hf-sel')?.getAttribute('data-layer-id') ?? '';
      });
      assert.equal(selected, 'badge', 'the card returns to editing on the clicked layer');

      // The editor side panel is another real exit path.
      await expandLayers(page);
      await frame.click('.hf-layer');
      await waitForView(page, false);
      const panelState = await viewSnapshot(page);
      assert.equal(panelState.label, 'View layers');
      assert.equal(panelState.pressed, 'false');
      assert.equal(panelState.board, false);
      assert.equal(await readFile(join(root, 'poster.html'), 'utf8'), source, 'exit paths never rewrote the source');
    } finally {
      await browser.close();
      await live.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'a single flat image layer is decoded once and not split into invented layers',
  {
    skip: browserSkip,
  },
  async () => {
    const root = await fixture(FLAT_DOC, FLAT_CSS, ['ink.css', 'photo.png'], { 'photo.png': PHOTO_PNG });
    const live = await serveWorkbench(root, { document: 'poster', target: 'wide' });
    const browser = await launchBrowser();
    try {
      const page = await openWorkbench(live, browser);
      await expandLayers(page);
      const view = await viewSnapshot(page);
      assert.equal(view.primary, '1', 'one real content unit');
      assert.equal(view.layerTiles, 1, 'the single flat layer is shown once');
      assert.equal(view.supplements, '0', 'no text was invented for the image layer');
      assert.equal(view.groups, 0);
      assert.equal(view.overview, 1);
      assert.equal(view.background, 1);
      assert.equal(view.tiles, 3, 'only overview, the real layer and background');

      await page.waitForFunction(
        () => {
          const doc = (document.getElementById('wb-frame') as HTMLIFrameElement).contentDocument;
          const image = doc?.querySelector(
            '.hf-exploded-item[data-exploded-unit="layer"] .hf-exploded-crop img',
          ) as HTMLImageElement | null;
          return Boolean(image && image.complete && image.naturalWidth > 0);
        },
        { timeout: 10000 },
      );
      const decoded = await page.evaluate(() => {
        const doc = (document.getElementById('wb-frame') as HTMLIFrameElement).contentDocument;
        const image = doc?.querySelector(
          '.hf-exploded-item[data-exploded-unit="layer"] .hf-exploded-crop img',
        ) as HTMLImageElement;
        return { naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight };
      });
      assert.ok(decoded.naturalWidth > 0 && decoded.naturalHeight > 0, 'the real image decoded');
    } finally {
      await browser.close();
      await live.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'Save and Render while expanded consume the original composition, not the gallery',
  {
    skip: browserSkip,
  },
  async () => {
    const root = await fixture(MULTI_DOC, MULTI_CSS);
    const live = await serveWorkbench(root, { document: 'poster', target: 'wide' });
    const browser = await launchBrowser();
    try {
      const page = await openWorkbench(live, browser);
      await moveTitle(page, 100);
      await page.waitForFunction(
        () => document.getElementById('wb-save-state')?.getAttribute('data-state') === 'saved',
        {
          timeout: 20000,
        },
      );
      const savedRevision = await waitForRevision(root, 2);
      const savedSource = await readFile(join(root, 'poster.html'), 'utf8');
      assert.match(savedSource, /"id":"title","dx":80(?:[.,]0*)?[,}]/, 'the edit is really saved first');

      // A real render in the normal view is the baseline product.
      await page.click('#wb-render');
      await page.waitForFunction(
        () => document.getElementById('wb-out-state')?.getAttribute('data-state') === 'success',
        { timeout: 30000 },
      );
      const baseline = await downloadOutput(live, page);
      assert.deepEqual(pngSize(baseline), { width: 480, height: 300 });
      const baselineInk = await inkLeft(browser, baseline, 40, 110);
      assert.ok(
        baselineInk >= 196 && baselineInk <= 204,
        `the real title starts at its saved left (ink ${baselineInk})`,
      );
      const baselineResult = await statusResult(live);
      assert.ok(baselineResult);

      await expandLayers(page);
      assert.equal((await viewSnapshot(page)).board, true);

      // Render again from the expanded shell: same saved source, same product.
      await page.click('#wb-render');
      await page.waitForFunction(
        () => document.getElementById('wb-out-state')?.getAttribute('data-state') === 'success',
        { timeout: 30000 },
      );
      const whileExpanded = await downloadOutput(live, page);
      assert.deepEqual(pngSize(whileExpanded), { width: 480, height: 300 });
      assert.deepEqual(await statusResult(live), baselineResult, 'the same artifact is reused, not the gallery');
      const expandedInk = await inkLeft(browser, whileExpanded, 40, 110);
      assert.ok(
        expandedInk >= baselineInk - 4 && expandedInk <= baselineInk + 4,
        `the expanded render is the original composition (ink ${expandedInk})`,
      );
      assert.equal(
        await readFile(join(root, 'poster.html'), 'utf8'),
        savedSource,
        'rendering from the view did not serialize the gallery',
      );
      assert.equal((await viewSnapshot(page)).board, true, 'Render does not kick the user out of the view');

      // Save while expanded is equally a no-op on the author source.
      await page.click('#wb-save');
      await page.waitForFunction(
        () => document.getElementById('wb-save-state')?.getAttribute('data-state') === 'saved',
        {
          timeout: 20000,
        },
      );
      const afterSave = await readFile(join(root, 'poster.html'), 'utf8');
      assert.equal(afterSave, savedSource);
      assert.doesNotMatch(afterSave, /hf-exploded|data-exploded|hf-exploded-board|hf-canvas|hf-stage-wrap/);
      const projectAfter = JSON.parse(await readFile(join(root, 'project.json'), 'utf8')) as {
        imageDocuments: Array<{ revision: number }>;
      };
      assert.equal(projectAfter.imageDocuments[0].revision, savedRevision, 'no gallery save advanced the revision');
      assert.equal((await viewSnapshot(page)).board, true, 'Save does not kick the user out of the view');

      await collapseLayers(page);
      assert.equal(await readFile(join(root, 'poster.html'), 'utf8'), savedSource);
    } finally {
      await browser.close();
      await live.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'Undo during the view cannot mutate hidden layers, and works again after returning',
  {
    skip: browserSkip,
  },
  async () => {
    const root = await fixture(MULTI_DOC, MULTI_CSS);
    const live = await serveWorkbench(root, { document: 'poster', target: 'wide' });
    const browser = await launchBrowser();
    try {
      const page = await openWorkbench(live, browser);
      const frame = page.frames().find(candidate => candidate !== page.mainFrame());
      assert.ok(frame);
      const pageOffset = await page.evaluate(() => {
        const box = document.getElementById('wb-frame')!.getBoundingClientRect();
        return { x: box.x, y: box.y };
      });
      const slot = await frame.evaluate(() => {
        const layer = document.querySelector('.title') as HTMLElement;
        const box = layer.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      });
      await page.mouse.move(pageOffset.x + slot.x, pageOffset.y + slot.y);
      await page.mouse.down();
      await page.mouse.move(pageOffset.x + slot.x + 64, pageOffset.y + slot.y + 16, { steps: 6 });
      await page.mouse.up();
      await page.waitForFunction(
        () => document.getElementById('wb-save-state')?.getAttribute('data-state') === 'saved',
        {
          timeout: 20000,
        },
      );
      const movedRevision = await waitForRevision(root, 2);
      const movedSource = await readFile(join(root, 'poster.html'), 'utf8');
      const moved = movedSource.match(/"id":"title","dx":(-?[\d.]+)/);
      assert.ok(moved, 'the drag was saved');
      const movedDx = Number(moved[1]);
      assert.notEqual(movedDx, 0, 'the drag moved the layer');

      const liveLeft = () =>
        page.evaluate(() => {
          const doc = (document.getElementById('wb-frame') as HTMLIFrameElement).contentDocument;
          return (doc?.querySelector('[data-layer-id="title"]') as HTMLElement | null)?.style.left ?? '';
        });
      const beforeUndo = await liveLeft();

      await expandLayers(page);
      await focusInFrame(page, '.hf-exploded-board');
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyZ');
      await page.keyboard.up('Control');
      await new Promise(resolve => setTimeout(resolve, 800));

      const during = await viewSnapshot(page);
      assert.equal(during.exploded, true, 'the view stayed open');
      assert.equal(during.selected, false);
      assert.equal(await liveLeft(), beforeUndo, 'the hidden canvas was not mutated');
      assert.equal(await readFile(join(root, 'poster.html'), 'utf8'), movedSource, 'Ctrl+Z did not write a rollback');
      assert.equal(
        JSON.parse(await readFile(join(root, 'project.json'), 'utf8')).imageDocuments[0].revision,
        movedRevision,
      );

      await collapseLayers(page);
      await focusInFrame(page, '.hf-canvas');
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyZ');
      await page.keyboard.up('Control');
      await page.waitForFunction(
        () => document.getElementById('wb-save-state')?.getAttribute('data-state') === 'saved',
        {
          timeout: 20000,
        },
      );
      await waitForRevision(root, movedRevision + 1);
      const undone = await readFile(join(root, 'poster.html'), 'utf8');
      assert.doesNotMatch(undone, /data-viscraft-layout/, 'undo returned the document to the authored source');
      assert.ok(
        Math.abs(
          (await page.evaluate(() => {
            const doc = (document.getElementById('wb-frame') as HTMLIFrameElement).contentDocument;
            return parseFloat(
              (doc?.querySelector('[data-layer-id="title"]') as HTMLElement | null)?.style.left ?? 'NaN',
            );
          })) - 20,
        ) <= 1,
        'Undo after returning restored the original left',
      );
      assert.equal((await viewSnapshot(page)).label, 'View layers');
    } finally {
      await browser.close();
      await live.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'entering the view commits an active text edit through the normal save queue',
  {
    skip: browserSkip,
  },
  async () => {
    const root = await fixture(MULTI_DOC, MULTI_CSS);
    const live = await serveWorkbench(root, { document: 'poster', target: 'wide' });
    const browser = await launchBrowser();
    try {
      const page = await openWorkbench(live, browser);
      const frame = page.frames().find(candidate => candidate !== page.mainFrame());
      assert.ok(frame);
      const pageOffset = await page.evaluate(() => {
        const box = document.getElementById('wb-frame')!.getBoundingClientRect();
        return { x: box.x, y: box.y };
      });
      const slot = await frame.evaluate(() => {
        const layer = document.querySelector('.title') as HTMLElement;
        const box = layer.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      });
      await page.mouse.click(pageOffset.x + slot.x, pageOffset.y + slot.y, { clickCount: 2 });
      await page.waitForFunction(
        () => {
          const win = (document.getElementById('wb-frame') as HTMLIFrameElement).contentWindow as Window & {
            __layerEditor?: { isEditing(): boolean };
          };
          return win.__layerEditor?.isEditing() === true;
        },
        { timeout: 10000 },
      );
      await page.keyboard.type('STRUCTURE NOW');

      // Do not wait for the debounce: entering the view itself ends the session
      // and the ordinary queue has to write the committed text.
      await expandLayers(page);
      const viewing = await viewSnapshot(page);
      assert.equal(viewing.editing, false, 'entering the view ended the text session');
      assert.equal(viewing.board, true);
      await waitForRevision(root, 2);
      const saved = await readFile(join(root, 'poster.html'), 'utf8');
      assert.match(saved, /STRUCTURE NOW/, 'the committed text reached the author source');
      assert.doesNotMatch(saved, /hf-exploded|data-exploded|hf-canvas|hf-stage-wrap/, 'no view markup was saved');
      assert.equal((await viewSnapshot(page)).board, true, 'the autosave did not close the view');

      await collapseLayers(page);
      assert.match(await readFile(join(root, 'poster.html'), 'utf8'), /STRUCTURE NOW/);
    } finally {
      await browser.close();
      await live.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'reduced motion settles the view and a reload starts back in editing',
  {
    skip: browserSkip,
  },
  async () => {
    const root = await fixture(MULTI_DOC, MULTI_CSS);
    const live = await serveWorkbench(root, { document: 'poster', target: 'wide' });
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1200, height: 900 });
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      await page.goto(live.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForFunction(() => document.getElementById('wb-app')?.getAttribute('data-phase') === 'mounted', {
        timeout: 30000,
      });
      const reduced = await page.evaluate(() => {
        const win = (document.getElementById('wb-frame') as HTMLIFrameElement).contentWindow;
        return win?.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
      });
      assert.equal(reduced, true, 'the frame sees the reduced-motion preference');
      const source = await readFile(join(root, 'poster.html'), 'utf8');

      await expandLayers(page);
      const expanded = await viewSnapshot(page);
      assert.equal(expanded.label, 'Back to editing');
      assert.equal(expanded.pressed, 'true');
      assert.equal(expanded.settled, true, 'the board settles instead of leaving a frozen transition');
      assert.equal(expanded.disabled, false);

      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForFunction(() => document.getElementById('wb-app')?.getAttribute('data-phase') === 'mounted', {
        timeout: 30000,
      });
      const reloaded = await viewSnapshot(page);
      assert.equal(reloaded.label, 'View layers', 'a reload never restores the expanded view');
      assert.equal(reloaded.pressed, 'false');
      assert.equal(reloaded.board, false);
      assert.equal(reloaded.bodyExploded, false);
      assert.equal(reloaded.exploded, false);
      assert.equal(await readFile(join(root, 'poster.html'), 'utf8'), source, 'the reload did not save the view');
    } finally {
      await browser.close();
      await live.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'font choices include project faces without CSS variables, and Undo returns to a clean saved design',
  { skip: browserSkip },
  async () => {
    const font = await readFile(
      join(process.cwd(), 'tests/fixtures/authoring/poster-and-film/fonts/NotoSansSC-400-subset.woff2'),
    );
    const root = await fixture(
      DOC,
      `@font-face{font-family:ProjectFace;src:url('font.woff2')}\n${CSS}\n.poster{font-family:ProjectFace,sans-serif}`,
      ['ink.css', 'font.woff2'],
      { 'font.woff2': font },
    );
    const live = await serveWorkbench(root, { document: 'poster', target: 'wide' });
    const browser = await launchBrowser();
    try {
      const page = await openWorkbench(live, browser);
      const frame = page.frames().find(f => f !== page.mainFrame())!;
      const before = await readFile(join(root, 'poster.html'), 'utf8');
      await frame.evaluate(() => {
        const win = window as Window & { __layerEditor?: { select(el: Element): void } };
        win.__layerEditor!.select(document.querySelector('.title')!);
      });
      const options = await frame.$$eval('#hf-ff option', items =>
        items.map(item => ({ value: (item as HTMLOptionElement).value, label: item.textContent })),
      );
      assert(options.some(o => o.label?.includes('ProjectFace') && o.label.includes('project font')));
      assert(options.some(o => o.value === 'serif'));
      assert(options.some(o => o.value === 'monospace'));
      assert.equal(await frame.$eval('#hf-ff-field', el => (el as HTMLElement).hidden), false);
      await frame.select('#hf-ff', 'monospace');
      assert.match(await frame.$eval('.title', el => getComputedStyle(el).fontFamily), /monospace/);
      await page.keyboard.down('Control');
      await page.keyboard.press('z');
      await page.keyboard.up('Control');
      await page.waitForFunction(() => document.getElementById('wb-save-state')?.dataset.state === 'clean');
      assert.match(await frame.$eval('.title', el => getComputedStyle(el).fontFamily), /ProjectFace/);

      // Font growth changes the auto-fitted box as well as the text style. Both
      // must return on Undo; leftover width would be a real unsaved edit.
      const width = await frame.$eval('.title', el => (el as HTMLElement).style.width);
      await frame.evaluate(() => {
        const win = window as Window & { __layerEditor?: { scaleFont(el: Element, factor: number): void } };
        win.__layerEditor!.scaleFont(document.querySelector('.title')!, 3);
      });
      await page.keyboard.down('Control');
      await page.keyboard.press('z');
      await page.keyboard.up('Control');
      await page.waitForFunction(() => document.getElementById('wb-save-state')?.dataset.state === 'clean');
      assert.equal(await frame.$eval('.title', el => (el as HTMLElement).style.width), width);
      await new Promise(resolve => setTimeout(resolve, 1600));
      assert.equal(await readFile(join(root, 'poster.html'), 'utf8'), before, 'a reverted edit produces no save');
      assert.equal(JSON.parse(await readFile(join(root, 'project.json'), 'utf8')).revision, 1);
    } finally {
      await browser.close();
      await live.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'Reset all edits restores this session opening design after saving; Undo reset restores its edits',
  { skip: browserSkip },
  async () => {
    const root = await fixture(DYNAMIC_DOC, DYNAMIC_CSS);
    const live = await serveWorkbench(root, { document: 'poster', target: 'wide' });
    const browser = await launchBrowser();
    try {
      const page = await openWorkbench(live, browser);
      const frame = page.frames().find(f => f !== page.mainFrame())!;
      await frame.evaluate(() => {
        const win = window as Window & {
          __layerEditor?: { setFont(el: Element, value: string): void; removeLayer(el: Element): void };
        };
        const title = document.querySelector('.title') as HTMLElement;
        title.firstChild!.textContent = 'REVISED ';
        title.style.left = '70px';
        win.__layerEditor!.setFont(title, 'monospace');
        win.__layerEditor!.removeLayer(document.querySelector('.sub')!);
      });
      await page.click('#wb-save');
      await waitForRevision(root, 2);
      await page.waitForFunction(() => document.getElementById('wb-save-state')?.dataset.state === 'saved');
      const accepted = await readFile(join(root, 'poster.html'), 'utf8');
      assert.match(accepted, /REVISED/);
      const resetFrame = page.frames().find(f => f !== page.mainFrame())!;
      assert.equal(await resetFrame.$eval('#hf-reset-all', el => (el as HTMLButtonElement).disabled), false);
      assert(
        await resetFrame.$eval(
          '.hf-reset-actions',
          el => Boolean(el.querySelector('#hf-reset')) && Boolean(el.querySelector('#hf-reset-all')),
        ),
        'both resets share one toolbar group',
      );
      page.once('dialog', dialog => {
        void dialog.dismiss();
      });
      assert(await resetFrame.$eval('#hf-reset-all', el => (el as HTMLElement).getBoundingClientRect().width > 0));
      await resetFrame.click('#hf-reset-all');
      assert.equal(await readFile(join(root, 'poster.html'), 'utf8'), accepted, 'cancel keeps saved changes');
      page.once('dialog', dialog => {
        void dialog.accept();
      });
      await resetFrame.click('#hf-reset-all');
      await page.waitForFunction(() => {
        const doc = (document.getElementById('wb-frame') as HTMLIFrameElement).contentDocument;
        return Boolean(doc?.querySelector('.sub')) && doc?.querySelector('.title')?.textContent === 'STATIC SLOT';
      });
      await waitForRevision(root, 3);
      await page.waitForFunction(() => document.getElementById('wb-save-state')?.dataset.state === 'saved');
      assert.equal(
        await readFile(join(root, 'poster.html'), 'utf8'),
        DYNAMIC_DOC,
        'full reset restores the opening design without rewriting the author program',
      );
      assert.equal(
        await page.evaluate(
          () =>
            (document.getElementById('wb-frame') as HTMLIFrameElement).contentDocument?.querySelectorAll('.note')
              .length,
        ),
        1,
      );
      assert(await page.$eval('#wb-banners', el => el.textContent?.includes('Undo reset')));
      await page.click('#wb-save'); // focus is on the outer shell, not the iframe
      await page.keyboard.down('Control');
      await page.keyboard.press('z');
      await page.keyboard.up('Control');
      await waitForRevision(root, 4);
      await page.waitForFunction(() => document.getElementById('wb-save-state')?.dataset.state === 'saved');
      assert.equal(
        await readFile(join(root, 'poster.html'), 'utf8'),
        accepted,
        'Undo reset restores the complete prior edit record',
      );
    } finally {
      await browser.close();
      await live.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'saved opening edits survive session reset; autosave and export preserve Undo, while reopening starts a new baseline',
  { skip: browserSkip },
  async () => {
    const root = await fixture(DYNAMIC_DOC, DYNAMIC_CSS);
    let live = await serveWorkbench(root, { document: 'poster', target: 'wide' });
    const browser = await launchBrowser();
    try {
      let page = await openWorkbench(live, browser);
      let frame = page.frames().find(f => f !== page.mainFrame())!;
      await frame.evaluate(() => {
        const ed = (window as any).__layerEditor;
        const title = document.querySelector('.title') as HTMLElement;
        title.style.left = '70px';
        ed.setFont(title, 'monospace');
        ed.removeLayer(document.querySelector('.sub'));
      });
      await page.click('#wb-save');
      await waitForRevision(root, 2);
      await page.waitForFunction(() => document.getElementById('wb-save-state')?.dataset.state === 'saved');
      const opening = await readFile(join(root, 'poster.html'), 'utf8');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.getElementById('wb-app')?.dataset.phase === 'mounted');
      frame = page.frames().find(f => f !== page.mainFrame())!;
      assert.equal(await frame.$eval('#hf-reset-all', el => (el as HTMLButtonElement).disabled), true);
      assert.equal(await frame.$eval('#hf-undo', el => (el as HTMLButtonElement).disabled), true);

      const changeFont = () =>
        frame.evaluate(() => {
          (window as any).__layerEditor.setFont(document.querySelector('.title'), 'serif');
        });
      const undo = async () => {
        await page.focus('#wb-save');
        await page.keyboard.down('Control');
        await page.keyboard.press('z');
        await page.keyboard.up('Control');
      };
      const waitSaved = async (revision: number) => {
        await waitForRevision(root, revision);
        await page.waitForFunction(() => document.getElementById('wb-save-state')?.dataset.state === 'saved');
      };
      await changeFont();
      await waitSaved(3); // no Save click: the real autosave queue writes the edit
      await undo();
      await waitSaved(4);
      assert.equal(await readFile(join(root, 'poster.html'), 'utf8'), opening, 'Undo survives autosave');

      await changeFont();
      await page.click('#wb-export');
      await page.waitForFunction(
        () =>
          document.getElementById('wb-out-state')?.dataset.state === 'success' &&
          document.getElementById('wb-export')?.getAttribute('aria-busy') === 'false',
      );
      await waitSaved(5);
      await undo();
      await waitSaved(6);
      assert.equal(await readFile(join(root, 'poster.html'), 'utf8'), opening, 'Undo survives export');

      await frame.evaluate(() => {
        const title = document.querySelector('.title') as HTMLElement;
        title.firstChild!.textContent = 'THIS SESSION ';
        title.style.left = '90px';
        const ed = (window as any).__layerEditor;
        ed.setFont(title, 'serif');
        ed.removeLayer(document.querySelector('.note'));
      });
      await page.click('#wb-save');
      await waitSaved(7);
      const latest = await readFile(join(root, 'poster.html'), 'utf8');
      page.once('dialog', dialog => {
        void dialog.accept();
      });
      await frame.click('#hf-reset-all');
      await waitSaved(8);
      assert.equal(
        await readFile(join(root, 'poster.html'), 'utf8'),
        opening,
        'reset retains edits and deletions saved before opening',
      );
      await page.click('#wb-banners button'); // Undo reset
      await waitSaved(9);
      assert.equal(await readFile(join(root, 'poster.html'), 'utf8'), latest);

      frame = page.frames().find(f => f !== page.mainFrame())!;
      await frame.click('#hf-reset');
      await waitSaved(10);
      assert.equal(
        await frame.$eval('.title', el => (el as HTMLElement).style.left),
        '70px',
        'layout reset keeps the opening geometry after reset/Undo reset remounts',
      );
      assert.match(await frame.$eval('.title', el => el.textContent!), /THIS SESSION/);
      assert.equal(await frame.$('.sub'), null, 'previous-session deletion remains');
      assert.equal(await frame.$('.note'), null, 'layout reset keeps this-session deletion');
      const saved = await readFile(join(root, 'poster.html'), 'utf8');

      await page.close();
      await live.close();
      live = await serveWorkbench(root, { document: 'poster', target: 'wide' });
      page = await openWorkbench(live, browser);
      frame = page.frames().find(f => f !== page.mainFrame())!;
      assert.equal(await frame.$eval('#hf-reset-all', el => (el as HTMLButtonElement).disabled), true);
      assert.equal(await frame.$eval('#hf-undo', el => (el as HTMLButtonElement).disabled), true);
      await frame.evaluate(() => {
        (window as any).__layerEditor.setFont(document.querySelector('.title'), 'sans-serif');
      });
      await page.click('#wb-save');
      await waitSaved(11);
      page.once('dialog', dialog => {
        void dialog.accept();
      });
      await frame.click('#hf-reset-all');
      await waitSaved(12);
      assert.equal(
        await readFile(join(root, 'poster.html'), 'utf8'),
        saved,
        'a restarted service opens the latest saved design as a new baseline',
      );
    } finally {
      await browser.close();
      await live.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'Export image saves the live edit and downloads the actual PNG, while failed or superseded renders download nothing',
  { skip: browserSkip },
  async () => {
    const root = await fixture();
    const downloads = await mkdtemp(join(tmpdir(), 'viscraft-image-download-'));
    const live = await serveWorkbench(root, { document: 'poster', target: 'wide' });
    const browser = await launchBrowser();
    try {
      const client = await browser.target().createCDPSession();
      await client.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloads,
        eventsEnabled: true,
      });
      const received: string[] = [];
      client.on('Browser.downloadWillBegin', event => {
        received.push(event.suggestedFilename);
      });
      const page = await openWorkbench(live, browser);
      const frame = page.frames().find(f => f !== page.mainFrame())!;
      await frame.click('.title', { clickCount: 2 });
      await frame.waitForSelector('.hf-editing');
      await page.keyboard.type('EXPORT READY');
      await page.click('#wb-export');
      let bytes: Buffer | undefined;
      const deadline = Date.now() + 20000;
      while (!bytes && Date.now() < deadline) {
        bytes = await readFile(join(downloads, 'wide.png')).catch(() => undefined);
        if (!bytes) await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert(bytes, 'the browser received a real downloaded image');
      assert.deepEqual(pngSize(bytes), { width: 480, height: 300 });
      const status = (await (await call(live, '/api/status')).json()) as { result: { path: string } };
      assert.deepEqual(bytes, await readFile(join(root, status.result.path)), 'download matches the Runtime result');
      assert.match(
        await readFile(join(root, 'poster.html'), 'utf8'),
        /EXPORT READY/,
        'the active text edit was saved before rendering',
      );
      assert.deepEqual(received, ['wide.png']);

      await page.setViewport({ width: 900, height: 700 });
      assert(
        await page.$eval('#wb-export', el => {
          const box = el.getBoundingClientRect();
          return box.width > 0 && box.right <= innerWidth;
        }),
        'the primary export action stays visible in a smaller window',
      );

      let mode = 'fail';
      let release: () => void = () => undefined;
      let announce: () => void = () => undefined;
      const held = new Promise<void>(resolve => {
        release = resolve;
      });
      const started = new Promise<void>(resolve => {
        announce = resolve;
      });
      await page.setRequestInterception(true);
      page.on('request', request => {
        void (async () => {
          if (request.method() === 'POST' && request.url().endsWith('/api/render')) {
            if (mode === 'fail') {
              await request.respond({
                status: 500,
                contentType: 'application/json',
                body: JSON.stringify({ error: 'render-failed', message: 'render failed for this test' }),
              });
              return;
            }
            announce();
            await held;
          }
          await request.continue();
        })();
      });
      await page.click('#wb-export');
      await page.waitForFunction(
        () =>
          document.getElementById('wb-out-state')?.dataset.state === 'failed' &&
          document.getElementById('wb-export')?.getAttribute('aria-busy') === 'false',
      );
      assert.deepEqual(received, ['wide.png'], 'a failed render never downloads the previous image');

      mode = 'hold';
      await page.click('#wb-export');
      await started;
      await frame.evaluate(() => {
        document.querySelector('.title')!.textContent = 'A NEWER DESIGN';
        (window as Window & { __viscraftWorkbench?: { changed(): void } }).__viscraftWorkbench!.changed();
      });
      release();
      await page.waitForFunction(() => document.getElementById('wb-export')?.getAttribute('aria-busy') === 'false');
      assert.deepEqual(received, ['wide.png'], 'editing during export prevents a superseded image from downloading');
      assert.equal(await page.$eval('#wb-out-state', el => (el as HTMLElement).dataset.state), 'stale');
    } finally {
      await browser.close();
      await live.close();
      await rm(root, { recursive: true, force: true });
      await rm(downloads, { recursive: true, force: true });
    }
  },
);
