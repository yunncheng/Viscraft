/**
 * Capture-transport regression: the browser-backed capture path must work with
 * every TCP listener denied, and must drive Chrome over a DevTools pipe bound to
 * the browser it actually launched (no debug port, no /proc or global scanning).
 *
 * The facts are read from the live capture's own browser process via the trusted
 * lifecycle hook: `page.browser().process().spawnargs`.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { captureCode, type CaptureLifecycle } from '../src/backends/browser/capture.js';
import { captureWorld } from '../src/backends/world/world.js';
import type { BrowserPictureSource, World } from '../src/core/schema.js';

const OUTPUT = {
  width: 32,
  height: 32,
  fps: { numerator: 5, denominator: 1 },
  sampleRate: 48000 as const,
  channels: 1 as const,
};

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

/** Deny both HTTP and raw TCP listeners for the duration of `context`. */
function denyAllListeners(context: TestContext): void {
  const deny = () => {
    throw Object.assign(new Error('listener denied'), { code: 'EPERM' });
  };
  context.mock.method(http.Server.prototype, 'listen', deny);
  context.mock.method(net.Server.prototype, 'listen', deny);
}

async function makeProject(files: Record<string, string | Buffer>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-transport-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return root;
}

async function frameFiles(dir: string): Promise<string[]> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  return names.filter(n => n.endsWith('.png')).sort();
}

async function cleanup(...dirs: string[]): Promise<void> {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
}

/** Assert the captured browser spoke DevTools over a pipe and opened no port. */
function assertPipeTransport(spawnargs: string[]): void {
  assert.ok(spawnargs.length > 0, 'lifecycle hook captured no browser spawnargs');
  assert.ok(
    spawnargs.some(arg => arg.includes('chrome') || arg.includes('chromium')),
    `spawnargs do not look like a browser process: ${spawnargs.slice(0, 3).join(' ')}`,
  );
  assert.ok(spawnargs.includes('--remote-debugging-pipe'), 'browser was not launched with --remote-debugging-pipe');
  assert.ok(
    !spawnargs.some(arg => arg.startsWith('--remote-debugging-port')),
    'browser was launched with a remote debugging port',
  );
}

test('capture is listener-free and its captured browser uses a DevTools pipe', async context => {
  denyAllListeners(context);
  const root = await makeProject({
    'index.html': `<!doctype html><html><body>
<canvas id="c" width="32" height="32"></canvas>
<iframe id="frame" src="./frame.html" style="display:none"></iframe>
<script type="module">
import { value } from './shared.mjs';
function waitSubframe() {
  return new Promise((resolve, reject) => {
    let ticks = 0;
    const tick = () => {
      const win = document.getElementById('frame').contentWindow;
      if (win && win.__frameDone === true) return resolve();
      if (++ticks > 500) return reject(new Error('subframe never signalled'));
      setTimeout(tick, 10);
    };
    tick();
  });
}
window.viscraft = {
  async ready() {
    if (value !== 7) throw new Error('module value not served');
    const data = await fetch('./data.json');
    if (!data.ok || !(data.headers.get('content-type') || '').startsWith('application/json')) throw new Error('JSON not fulfilled');
    if ((await data.json()).value !== 42) throw new Error('JSON value mismatch');
    await waitSubframe();
  },
  async render(ctx) {
    const picture = await fetch(ctx.bindings.hero.url);
    if (!picture.ok || (await picture.arrayBuffer()).byteLength === 0) throw new Error('binding not served');
    const g = document.getElementById('c').getContext('2d');
    g.fillStyle = 'rgb(' + ((ctx.frame * 40) % 256) + ',0,0)';
    g.fillRect(0, 0, ctx.width, ctx.height);
  }
};
</script></body></html>`,
    'shared.mjs': 'export const value = 7;\n',
    'data.json': '{"value":42}',
    'frame.html': `<!doctype html><script>fetch('./frame-data.json').then(r => r.json()).then(d => { window.__frameDone = d.ok === true; });</script>`,
    'frame-data.json': '{"ok":true}',
    'assets/bind.png': Buffer.from(TINY_PNG_BASE64, 'base64'),
  });
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-transport-out-'));

  let spawnargs: string[] = [];
  const lifecycle: CaptureLifecycle = {
    prepare: async page => {
      const process_ = page.browser().process();
      spawnargs = process_ ? [...process_.spawnargs] : [];
    },
  };
  const source: BrowserPictureSource = {
    id: 'transport',
    kind: 'browser',
    output: 'picture',
    entry: 'index.html',
    resources: ['shared.mjs', 'data.json', 'frame.html', 'frame-data.json'],
    bindings: ['hero'],
    params: {},
    seed: 0,
    frames: 2,
  };

  try {
    await captureCode(
      root,
      source,
      OUTPUT,
      destination,
      { hero: { id: 'hero', path: 'assets/bind.png', sha256: '0'.repeat(64) } },
      lifecycle,
    );
    assert.deepEqual(await frameFiles(destination), ['frame-000000.png', 'frame-000001.png']);
    assertPipeTransport(spawnargs);
  } finally {
    await cleanup(root, destination);
  }
});

test('captureWorld renders a sampled World with every listener denied', async context => {
  denyAllListeners(context);
  const root = await makeProject({
    'world.html': `<!doctype html><canvas id="c" width="32" height="32"></canvas><script>
window.viscraft = {
  render(ctx) {
    const world = window.__viscraftWorld;
    if (!world || world.id !== 'w1' || world.camera.id !== 'cam') throw new Error('no World snapshot');
    const x = world.entities[0].transform.position[0];
    const g = document.getElementById('c').getContext('2d');
    g.fillStyle = 'rgb(' + Math.round((x * 10) % 256) + ',0,0)';
    g.fillRect(0, 0, ctx.width, ctx.height);
  }
};
</script>`,
  });
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-transport-world-'));

  const world: World = {
    id: 'w1',
    revision: 1,
    units: 'meters',
    coordinates: 'right-handed-y-up',
    fps: { numerator: 5, denominator: 1 },
    frames: 20,
    entities: [
      { id: 'car', asset: 'a1', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, state: {} },
    ],
    trajectories: [
      {
        id: 't1',
        entity: 'car',
        keyframes: [
          { frame: 0, position: [0, 0, 0] },
          { frame: 19, position: [19, 9, 0] },
        ],
      },
    ],
    cameras: [{ id: 'cam', position: [0, 0, 5], target: [0, 0, 0], fov: 50 }],
  };
  const source: BrowserPictureSource = {
    id: 'ws',
    kind: 'browser',

    output: 'picture',

    world: { id: 'w1', camera: 'cam', mode: 'drive', startFrame: 0 },
    entry: 'world.html',
    resources: [],
    bindings: [],
    params: {},
    seed: 0,
    frames: 3,
  };

  try {
    await captureWorld(root, source, world, OUTPUT, destination);
    const files = await frameFiles(destination);
    assert.deepEqual(files, ['frame-000000.png', 'frame-000001.png', 'frame-000002.png']);
    const [first, last] = await Promise.all([files[0], files[2]].map(f => fs.readFile(path.join(destination, f))));
    assert.notEqual(first.toString('hex'), last.toString('hex'), 'sampled World must change pixels across frames');
  } finally {
    await cleanup(root, destination);
  }
});
