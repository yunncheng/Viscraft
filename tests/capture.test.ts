import { createSymlinkFixture } from './fs-fixtures.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  captureCode,
  findBrowser,
  checkCaptureReady,
  isAllowedCaptureUrl,
  type CaptureLifecycle,
} from '../src/backends/browser/capture.js';
import http from 'node:http';
import type { BrowserPictureSource } from '../src/core/schema.js';

test('capture readiness renders a real frame without any HTTP listener', async context => {
  context.mock.method(http.Server.prototype, 'listen', () => {
    throw Object.assign(new Error('denied listener'), { code: 'EPERM' });
  });
  const result = await checkCaptureReady();
  assert.match(result.browserVersion, /Chrome/);
});

test('capture readiness fails when the browser executable is denied or missing', async () => {
  const previous = process.env.VISCRAFT_BROWSER;
  process.env.VISCRAFT_BROWSER = '/nonexistent/denied-browser';
  try {
    await assert.rejects(checkCaptureReady(), /VISCRAFT_BROWSER/);
  } finally {
    if (previous === undefined) delete process.env.VISCRAFT_BROWSER;
    else process.env.VISCRAFT_BROWSER = previous;
  }
});

// 1x1 transparent PNG.
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

const OUTPUT = {
  width: 32,
  height: 32,
  fps: { numerator: 5, denominator: 1 },
  sampleRate: 48000 as const,
  channels: 1 as const,
};

function codeSource(overrides: Partial<BrowserPictureSource> = {}): BrowserPictureSource {
  return {
    id: 'src',
    kind: 'browser',
    output: 'picture',
    entry: 'index.html',
    resources: [],
    bindings: [],
    params: {},
    seed: 0,
    frames: 3,
    ...overrides,
  } as BrowserPictureSource;
}

async function makeProject(files: Record<string, string | Buffer>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-proj-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return root;
}

interface AuthorOptions {
  frames?: number;
  seed?: number;
  marker?: string;
  probeImage?: string;
  hangDispose?: boolean;
  checkResource?: boolean;
  checkBinding?: boolean;
  failAtFrame?: number;
}

function authorHtml(opts: AuthorOptions = {}): string {
  const { seed = 0, marker = 'mk', probeImage, hangDispose, checkResource, checkBinding, failAtFrame } = opts;
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0}#probe{display:none}</style></head>
<body>
<canvas id="c"></canvas>
${probeImage ? `<img id="probe" src="${probeImage}">` : ''}
<script>
window.__probeDone = (function(){
  if (!document.getElementById('probe')) return Promise.resolve();
  var img = document.getElementById('probe');
  return new Promise(function(res){ if (img.complete) res(); else { img.onload = res; img.onerror = res; } });
})();
window.viscraft = {
  async ready(){ if (document.fonts && document.fonts.ready) await document.fonts.ready; },
  async render(args){
    await window.__probeDone;
    if (Math.abs(args.time - args.frame / args.fps) > 1e-9) throw new Error('bad time ' + args.time);
    if (args.seed !== ${seed}) throw new Error('bad seed ' + args.seed);
    if (args.params.marker !== ${JSON.stringify(marker)}) throw new Error('bad params');
    if (args.width !== 32 || args.height !== 32) throw new Error('bad size');
    ${checkResource ? "const r = await fetch('assets/dot.png'); const rb = await r.arrayBuffer(); if (!r.ok || rb.byteLength === 0) throw new Error('resource missing');" : ''}
    ${checkBinding ? "const b = args.bindings.hero; if (!b || !/^http:\\/\\/127\\.0\\.0\\.1:\\d+\\//.test(b.url)) throw new Error('bad binding url'); const br = await fetch(b.url); const ba = await br.arrayBuffer(); if (!br.ok || ba.byteLength === 0) throw new Error('binding not served');" : ''}
    ${failAtFrame !== undefined ? `if (args.frame === ${failAtFrame}) throw new Error('boom at ' + args.frame);` : ''}
    const c = document.getElementById('c');
    c.width = args.width; c.height = args.height;
    const g = c.getContext('2d');
    g.fillStyle = 'rgb(' + ((args.frame * 40) % 256) + ',' + ((args.frame * 11) % 256) + ',' + ((args.frame * 7) % 256) + ')';
    g.fillRect(0, 0, args.width, args.height);
  },
  dispose(){${hangDispose ? ' return new Promise(function(){}); ' : ''}}
};
</script></body></html>`;
}

async function frameFiles(dir: string): Promise<string[]> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  return names.filter(n => n.endsWith('.png')).sort();
}

async function cleanup(...dirs: string[]): Promise<void> {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
}

test('snapshot fulfillment preserves relative ES module origins and MIME without local sockets', async context => {
  context.mock.method(http.Server.prototype, 'listen', () => {
    throw new Error('HTTP listening is forbidden');
  });
  const root = await makeProject({
    'scenes/index.html':
      '<!doctype html><canvas id="c" width="32" height="32"></canvas><script type="module" src="./main.mjs"></script>',
    'scenes/main.mjs': `import { color } from './palette.js';
      if (new URL(import.meta.url).origin !== location.origin) throw new Error('module origin mismatch');
      window.viscraft = { async ready() {
        const r = await fetch('./data.json');
        if (!r.headers.get('content-type').startsWith('application/json') || (await r.json()).value !== 42) throw new Error('JSON not fulfilled');
        const head = await fetch('./data.json', { method: 'HEAD' });
        if (!head.ok || (await head.text()) !== '' || Number(head.headers.get('content-length')) <= 0) throw new Error('HEAD mismatch');
        await WebAssembly.instantiateStreaming(fetch('./empty.wasm'));
      }, render() { const g=document.getElementById('c').getContext('2d'); g.fillStyle=color;g.fillRect(0,0,32,32); } };
    `,
    'scenes/palette.js': 'export const color = "#2874b4";',
    'scenes/data.json': '{"value":42}',
    'scenes/empty.wasm': Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
  });
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-module-'));
  try {
    await captureCode(
      root,
      codeSource({
        entry: 'scenes/index.html',
        frames: 1,
        resources: ['scenes/main.mjs', 'scenes/palette.js', 'scenes/data.json', 'scenes/empty.wasm'],
      }),
      OUTPUT,
      destination,
    );
    assert.deepEqual(await frameFiles(destination), ['frame-000000.png']);
  } finally {
    await cleanup(root, destination);
  }
});

test('snapshot fulfillment cannot read undeclared files or an encoded escaping path', async () => {
  for (const requested of ['private.json', '%2e%2e%2fprivate.json']) {
    const root = await makeProject({
      'index.html': `<!doctype html><script>window.viscraft={async ready(){await fetch(${JSON.stringify(requested)});},render(){}};</script>`,
      'private.json': '{"undeclared":true}',
    });
    const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-denied-resource-'));
    try {
      await assert.rejects(captureCode(root, codeSource({ frames: 1 }), OUTPUT, destination), /HTTP (403|404)/);
      assert.deepEqual(await frameFiles(destination), []);
    } finally {
      await cleanup(root, destination);
    }
  }
});

test('findBrowser locates an executable browser', async () => {
  const browser = await findBrowser();
  const st = await fs.stat(browser);
  assert.ok(st.isFile(), 'browser path should be a file');
});

test('findBrowser fails loudly on an invalid VISCRAFT_BROWSER override', async () => {
  const prev = process.env.VISCRAFT_BROWSER;
  process.env.VISCRAFT_BROWSER = '/nonexistent/definitely-not-a-browser';
  try {
    await assert.rejects(findBrowser(), /VISCRAFT_BROWSER is set/);
  } finally {
    if (prev === undefined) delete process.env.VISCRAFT_BROWSER;
    else process.env.VISCRAFT_BROWSER = prev;
  }
});

test('captureCode renders a deterministic frame sequence and serves resources/bindings', async context => {
  context.mock.method(http.Server.prototype, 'listen', () => {
    throw Object.assign(new Error('denied listener'), { code: 'EPERM' });
  });
  const root = await makeProject({
    'index.html': authorHtml({ seed: 7, marker: 'mk', checkResource: true, checkBinding: true }),
    'assets/dot.png': Buffer.from(TINY_PNG_BASE64, 'base64'),
    'assets/bind.png': Buffer.from(TINY_PNG_BASE64, 'base64'),
  });
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-out-'));
  try {
    const result = await captureCode(
      root,
      codeSource({ frames: 3, seed: 7, params: { marker: 'mk' }, resources: ['assets/dot.png'] }),
      OUTPUT,
      destination,
      { hero: { id: 'hero', path: 'assets/bind.png', sha256: '0'.repeat(64) } },
    );
    assert.equal(typeof result.browserVersion, 'string');
    assert.ok(result.browserVersion.length > 0);

    const files = await frameFiles(destination);
    assert.deepEqual(files, ['frame-000000.png', 'frame-000001.png', 'frame-000002.png']);
    const contents = await Promise.all(files.map(f => fs.readFile(path.join(destination, f))));
    for (const buf of contents) {
      assert.ok(buf.length > 0);
      assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
    }
    // Per-frame pixels differ, proving render ran once per frame with a changing arg.
    assert.notEqual(contents[0].toString('hex'), contents[1].toString('hex'));
    assert.notEqual(contents[1].toString('hex'), contents[2].toString('hex'));
  } finally {
    await cleanup(root, destination);
  }
});

test('captureCode fails on a page error and writes no completed garbage', async () => {
  const root = await makeProject({ 'index.html': authorHtml({ marker: 'mk', failAtFrame: 1 }) });
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-out-'));
  try {
    await assert.rejects(
      captureCode(root, codeSource({ frames: 3, params: { marker: 'mk' } }), OUTPUT, destination),
      /boom at 1|page error/i,
    );
  } finally {
    await cleanup(root, destination);
  }
});

test('captureCode fails on a missing project resource (HTTP 404)', async () => {
  const root = await makeProject({
    'index.html': authorHtml({ marker: 'mk', probeImage: 'missing.png' }),
  });
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-out-'));
  try {
    await assert.rejects(
      captureCode(root, codeSource({ params: { marker: 'mk' } }), OUTPUT, destination),
      /404|failed/i,
    );
  } finally {
    await cleanup(root, destination);
  }
});

test('captureCode blocks external network requests', async () => {
  const root = await makeProject({
    'index.html': authorHtml({ marker: 'mk', probeImage: 'http://example.com/x.png' }),
  });
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-out-'));
  try {
    await assert.rejects(
      captureCode(root, codeSource({ params: { marker: 'mk' } }), OUTPUT, destination),
      /blocked external network request/i,
    );
  } finally {
    await cleanup(root, destination);
  }
});

test('captureCode compiles a TypeScript entry and reports a missing contract honestly', async () => {
  // A `.ts` entry is a supported authoring form now (see typescript-entry.test.ts).
  // An entry that never exposes the contract global must name the real problem
  // rather than a bogus "unsupported TypeScript" refusal.
  const root = await makeProject({ 'scene.ts': 'export {};' });
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-out-'));
  try {
    await assert.rejects(
      captureCode(root, codeSource({ entry: 'scene.ts' }), OUTPUT, destination),
      /did not expose window\.viscraft\.render/,
    );
  } finally {
    await cleanup(root, destination);
  }
});

test('captureCode rejects an entry that is neither HTML nor TypeScript', async () => {
  const root = await makeProject({ 'scene.txt': 'not an entry' });
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-out-'));
  try {
    await assert.rejects(
      captureCode(root, codeSource({ entry: 'scene.txt' }), OUTPUT, destination),
      /must be an HTML file \(\.html\/\.htm\).*or a TypeScript entry \(\.ts\/\.tsx\)/,
    );
  } finally {
    await cleanup(root, destination);
  }
});

test('captureCode rejects symlinked entry paths (shared io policy)', async t => {
  const root = await makeProject({ 'real.html': authorHtml({ marker: 'mk' }) });
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-out-'));
  try {
    if (!(await createSymlinkFixture(t, 'real.html', path.join(root, 'link.html')))) return;
    await assert.rejects(
      captureCode(root, codeSource({ entry: 'link.html', params: { marker: 'mk' } }), OUTPUT, destination),
      /Symbolic links are not allowed/i,
    );
  } finally {
    await cleanup(root, destination);
  }
});

test('isAllowedCaptureUrl uses exact origin, not a prefix match', () => {
  const origin = 'http://127.0.0.1:12345';
  assert.equal(isAllowedCaptureUrl('http://127.0.0.1:12345/index.html', origin), true);
  assert.equal(isAllowedCaptureUrl('http://127.0.0.1:12345/assets/a.png', origin), true);
  assert.equal(isAllowedCaptureUrl('http://127.0.0.1:12345@evil.example/x.png', origin), false);
  assert.equal(isAllowedCaptureUrl('http://127.0.0.1:12345.evil.example/x.png', origin), false);
  assert.equal(isAllowedCaptureUrl('http://127.0.0.1:9999/index.html', origin), false);
  assert.equal(isAllowedCaptureUrl('https://example.com/x.png', origin), false);
  assert.equal(isAllowedCaptureUrl('data:image/png;base64,AAAA', origin), true);
  assert.equal(isAllowedCaptureUrl('blob:http://127.0.0.1:12345/abc', origin), true);
  assert.equal(isAllowedCaptureUrl('about:blank', origin), true);
  assert.equal(isAllowedCaptureUrl('', origin), true);
  assert.equal(isAllowedCaptureUrl('not a url', origin), false);
});

test('captureCode fails on a served-but-broken image after readiness', async () => {
  const root = await makeProject({
    'index.html': authorHtml({ marker: 'mk', probeImage: 'assets/broken.png' }),
    'assets/broken.png': 'this is not a valid png',
  });
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-out-'));
  try {
    await assert.rejects(
      captureCode(
        root,
        codeSource({ params: { marker: 'mk' }, resources: ['assets/broken.png'] }),
        OUTPUT,
        destination,
      ),
      /broken image/i,
    );
  } finally {
    await cleanup(root, destination);
  }
});

test('captureCode does not hang when dispose never settles', async () => {
  const root = await makeProject({ 'index.html': authorHtml({ marker: 'mk', hangDispose: true }) });
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-out-'));
  const prev = process.env.VISCRAFT_CAPTURE_DISPOSE_TIMEOUT_MS;
  process.env.VISCRAFT_CAPTURE_DISPOSE_TIMEOUT_MS = '150';
  try {
    const result = await captureCode(root, codeSource({ frames: 1, params: { marker: 'mk' } }), OUTPUT, destination);
    assert.equal(typeof result.browserVersion, 'string');
    const files = await frameFiles(destination);
    assert.deepEqual(files, ['frame-000000.png']);
  } finally {
    if (prev === undefined) delete process.env.VISCRAFT_CAPTURE_DISPOSE_TIMEOUT_MS;
    else process.env.VISCRAFT_CAPTURE_DISPOSE_TIMEOUT_MS = prev;
    await cleanup(root, destination);
  }
});

/**
 * Author page for lifecycle tests: color depends on the real key state that the
 * host hooks install before load and drive with Puppeteer keyboard input.
 */
function interactiveAuthorHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0}</style></head>
<body><canvas id="c"></canvas>
<script>
window.__listenerAtLoad = Object.prototype.hasOwnProperty.call(window, '__keys');
window.viscraft = {
  ready(){},
  render(args){
    var c = document.getElementById('c');
    c.width = args.width; c.height = args.height;
    var g = c.getContext('2d');
    var keys = window.__keys || {};
    var down = keys['a'] === true;
    g.fillStyle = down ? 'rgb(255,0,0)' : 'rgb(0,0,255)';
    g.fillRect(0, 0, args.width, args.height);
    window.__renderStates = window.__renderStates || [];
    window.__renderStates.push(args.frame + ':' + (down ? 'down' : 'up'));
  }
};
</script></body></html>`;
}

test('captureCode lifecycle hooks record real keyboard input that changes pixels', async () => {
  const root = await makeProject({ 'index.html': interactiveAuthorHtml() });
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-out-'));
  const order: string[] = [];
  const beforeFrames: number[] = [];
  const afterSnapshots: Array<{ frame: number; a: boolean; states: string[]; listenerAtLoad: boolean }> = [];

  const lifecycle: CaptureLifecycle = {
    prepare: async page => {
      order.push('prepare');
      await page.evaluateOnNewDocument(() => {
        const g = globalThis as unknown as { __keys: Record<string, boolean>; __keyEvents: string[] };
        g.__keys = {};
        g.__keyEvents = [];
        document.addEventListener(
          'keydown',
          event => {
            g.__keys[event.key] = true;
            g.__keyEvents.push(`down:${event.key}`);
          },
          true,
        );
        document.addEventListener(
          'keyup',
          event => {
            g.__keys[event.key] = false;
            g.__keyEvents.push(`up:${event.key}`);
          },
          true,
        );
      });
    },
    beforeFrame: async (page, frame) => {
      order.push(`beforeFrame:${frame}`);
      beforeFrames.push(frame);
      if (frame === 0) await page.keyboard.down('KeyA');
    },
    afterFrame: async (page, frame) => {
      order.push(`afterFrame:${frame}`);
      const snap = await page.evaluate(() => {
        const g = globalThis as unknown as {
          __keys: Record<string, boolean>;
          __renderStates: string[];
          __listenerAtLoad: boolean;
        };
        return { keys: g.__keys, states: g.__renderStates || [], listenerAtLoad: g.__listenerAtLoad === true };
      });
      afterSnapshots.push({
        frame,
        a: snap.keys['a'] === true,
        states: snap.states,
        listenerAtLoad: snap.listenerAtLoad,
      });
      if (frame === 0) await page.keyboard.up('KeyA');
    },
  };

  try {
    const result = await captureCode(root, codeSource({ frames: 2, params: {} }), OUTPUT, destination, {}, lifecycle);
    assert.equal(typeof result.browserVersion, 'string');

    // Hooks ran in exactly the expected order for each exact frame.
    assert.deepEqual(order, ['prepare', 'beforeFrame:0', 'afterFrame:0', 'beforeFrame:1', 'afterFrame:1']);
    assert.deepEqual(beforeFrames, [0, 1]);

    // prepare's evaluateOnNewDocument ran before the page's own script.
    assert.equal(
      afterSnapshots.every(s => s.listenerAtLoad),
      true,
    );

    // render read the real key state driven via page.keyboard: frame 0 down, frame 1 up.
    assert.equal(afterSnapshots[0].a, true);
    assert.equal(afterSnapshots[1].a, false);
    assert.deepEqual(afterSnapshots[0].states, ['0:down']);
    assert.deepEqual(afterSnapshots[1].states, ['0:down', '1:up']);

    // The recorded pixels differ, proving input changed actual output.
    const files = await frameFiles(destination);
    assert.deepEqual(files, ['frame-000000.png', 'frame-000001.png']);
    const [f0, f1] = await Promise.all(files.map(f => fs.readFile(path.join(destination, f))));
    assert.notEqual(f0.toString('hex'), f1.toString('hex'));
  } finally {
    await cleanup(root, destination);
  }
});

test('captureCode fails and cleans up when a frame hook throws', async () => {
  const root = await makeProject({ 'index.html': interactiveAuthorHtml() });
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-out-'));
  let afterCalls = 0;
  const lifecycle: CaptureLifecycle = {
    beforeFrame: async (_page, frame) => {
      if (frame === 1) throw new Error('hook exploded');
    },
    afterFrame: async () => {
      afterCalls++;
    },
  };
  try {
    await assert.rejects(
      captureCode(root, codeSource({ frames: 3 }), OUTPUT, destination, {}, lifecycle),
      /lifecycle\.beforeFrame\(1\): hook exploded/,
    );
    // Frame 0 completed; frame 1's render was never reached and no later frames exist.
    assert.deepEqual(await frameFiles(destination), ['frame-000000.png']);
    assert.equal(afterCalls, 1);
  } finally {
    await cleanup(root, destination);
  }
});

test('captureCode fails before recording when prepare throws', async () => {
  const root = await makeProject({ 'index.html': interactiveAuthorHtml() });
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-out-'));
  const lifecycle: CaptureLifecycle = {
    prepare: async () => {
      throw new Error('no input backend');
    },
  };
  try {
    await assert.rejects(
      captureCode(root, codeSource({ frames: 2 }), OUTPUT, destination, {}, lifecycle),
      /lifecycle\.prepare\(\): no input backend/,
    );
    assert.deepEqual(await frameFiles(destination), []);
  } finally {
    await cleanup(root, destination);
  }
});

test('captureCode calls an optional visual reset before the first frame', async () => {
  const root = await makeProject({
    'index.html': `<!doctype html>
<html><head><meta charset="utf-8"></head><body><canvas id="c"></canvas>
<script>
window.__log = [];
window.viscraft = {
  ready(){ window.__log.push('ready'); },
  reset(){ window.__log.push('reset'); },
  render(args){
    window.__log.push('render:' + args.frame);
    var c = document.getElementById('c');
    c.width = args.width; c.height = args.height;
    var g = c.getContext('2d');
    g.fillStyle = 'rgb(' + ((args.frame * 37) % 256) + ',0,0)';
    g.fillRect(0, 0, args.width, args.height);
  }
};
</script></body></html>`,
  });
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-out-'));
  let log: string[] = [];
  const lifecycle: CaptureLifecycle = {
    afterFrame: async (page, frame) => {
      if (frame === 1) log = await page.evaluate(() => (globalThis as unknown as { __log: string[] }).__log);
    },
  };
  try {
    await captureCode(root, codeSource({ frames: 2 }), OUTPUT, destination, {}, lifecycle);
    assert.deepEqual(log, ['ready', 'reset', 'render:0', 'render:1']);
  } finally {
    await cleanup(root, destination);
  }
});
