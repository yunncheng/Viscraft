/**
 * Browser capture diagnostics (non-blocking).
 *
 * After the readiness chain and before recording, a real browser capture reports
 * technical risks that can degrade picture quality while still rendering:
 *  - `canvas-upscaled` — a significant canvas whose backing buffer is smaller
 *    than its display pixels;
 *  - `canvas-aspect-mismatch` — a significant canvas whose buffer aspect differs
 *    from its displayed aspect by more than 1% (a camera not synced to size);
 *  - `font-fallback` — a declared web font that is not actually available.
 *
 * They never fail the capture; a broken image still FAILS it (unchanged). The
 * Build records them per operation, carries them across a reused operation, and
 * `review` surfaces them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureCode, type CaptureDiagnostic } from '../src/backends/browser/capture.js';
import { buildProject } from '../src/build/build.js';
import { reviewBuild } from '../src/operations/analysis/review.js';
import { ProjectSchema, type BrowserPictureSource, type OutputSettings, type Project } from '../src/core/schema.js';

async function makeRoot(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-diag-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return root;
}

async function cleanup(...dirs: string[]): Promise<void> {
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

function codes(diagnostics: Array<{ code: string }>): string[] {
  return diagnostics.map(diagnostic => diagnostic.code).sort();
}

const RESET_CSS = 'html,body{margin:0;padding:0;overflow:hidden}canvas{display:block}';

/** A full-viewport page whose single canvas has an explicit backing buffer. */
function canvasPage(bufferWidth: number, bufferHeight: number, extraHead = '', extraBody = ''): string {
  return `<!doctype html><html><head><style>${RESET_CSS}canvas{width:100vw;height:100vh}${extraHead}</style></head><body>
<canvas id="c" width="${bufferWidth}" height="${bufferHeight}"></canvas>${extraBody}
<script>window.viscraft={render(){const g=document.getElementById('c').getContext('2d');g.fillStyle='#123456';g.fillRect(0,0,${bufferWidth},${bufferHeight});}};</script></body></html>`;
}

const SOURCE = (frames: number): BrowserPictureSource => ({
  id: 'src',
  kind: 'browser',
  output: 'picture',
  entry: 'index.html',
  resources: [],
  bindings: [],
  params: {},
  seed: 0,
  frames,
});

async function capture(
  root: string,
  output: OutputSettings,
  frames = 1,
): Promise<{ diagnostics: CaptureDiagnostic[] }> {
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-diag-out-'));
  try {
    return await captureCode(root, SOURCE(frames), output, destination);
  } finally {
    await cleanup(destination);
  }
}

const HD: OutputSettings = {
  width: 1280,
  height: 720,
  fps: { numerator: 5, denominator: 1 },
  sampleRate: 48000,
  channels: 1,
};
const SD: OutputSettings = {
  width: 64,
  height: 64,
  fps: { numerator: 5, denominator: 1 },
  sampleRate: 48000,
  channels: 1,
};

test('capture reports canvas-upscaled for a small buffer upscaled into 1280x720', async () => {
  const root = await makeRoot({ 'index.html': canvasPage(640, 360) });
  try {
    const { diagnostics } = await capture(root, HD);
    assert.deepEqual(codes(diagnostics), ['canvas-upscaled'], JSON.stringify(diagnostics));
    const [diagnostic] = diagnostics;
    assert.equal(diagnostic.code, 'canvas-upscaled');
    assert.equal(diagnostic.detail.buffer, '640x360');
    assert.equal(diagnostic.detail.display, '1280x720');
    assert.equal(diagnostic.detail.output, '1280x720');
  } finally {
    await cleanup(root);
  }
});

test('capture reports canvas-aspect-mismatch for a WebGL canvas whose display aspect differs', async () => {
  const root = await makeRoot({
    'index.html': `<!doctype html><html><head><style>${RESET_CSS}canvas{display:block;width:100vw;height:50vh}</style></head><body>
<canvas id="c" width="1280" height="720"></canvas>
<script>
window.viscraft={
  ready(){const c=document.getElementById('c');const gl=c.getContext('webgl2')||c.getContext('webgl');if(!gl)throw new Error('no webgl');gl.clearColor(0.1,0.2,0.3,1);gl.clear(gl.COLOR_BUFFER_BIT);},
  render(){const c=document.getElementById('c');const gl=c.getContext('webgl2')||c.getContext('webgl');gl.clearColor(0.1,0.2,0.3,1);gl.clear(gl.COLOR_BUFFER_BIT);}
};</script></body></html>`,
  });
  try {
    const { diagnostics } = await capture(root, HD);
    assert.deepEqual(codes(diagnostics), ['canvas-aspect-mismatch'], JSON.stringify(diagnostics));
    assert.equal(diagnostics[0].detail.context, 'webgl');
    assert.equal(diagnostics[0].detail.buffer, '1280x720');
    assert.equal(diagnostics[0].detail.display, '1280x360');
  } finally {
    await cleanup(root);
  }
});

test('capture reports font-fallback for a declared-but-unavailable font', async () => {
  // An invalid data-URL font fails to decode (status "error") WITHOUT a network
  // 404, so only the font diagnostic — not a broken request — is raised.
  const root = await makeRoot({
    'index.html': canvasPage(
      64,
      64,
      `@font-face{font-family:'Viscraft Missing Font';src:url('data:font/woff2;base64,AAAA') format('woff2')}`,
      `<div style="font-family:'Viscraft Missing Font',sans-serif">diagnostics</div>`,
    ),
  });
  try {
    const { diagnostics } = await capture(root, SD);
    assert.deepEqual(codes(diagnostics), ['font-fallback'], JSON.stringify(diagnostics));
    assert.equal(diagnostics[0].detail.family, 'Viscraft Missing Font');
  } finally {
    await cleanup(root);
  }
});

test('capture reports no diagnostics for a matched canvas and an available font', async () => {
  const root = await makeRoot({
    'index.html': canvasPage(64, 64, `body{font-family:monospace}`, `<div>diagnostics</div>`),
  });
  try {
    const { diagnostics } = await capture(root, SD);
    assert.deepEqual(diagnostics, []);
  } finally {
    await cleanup(root);
  }
});

test('capture still fails on a broken image (regression)', async () => {
  const root = await makeRoot({
    'index.html': `<!doctype html><html><body>
<canvas id="c" width="64" height="64"></canvas><img src="data:image/png;base64,AAAA" alt="broken">
<script>window.viscraft={render(){const g=document.getElementById('c').getContext('2d');g.fillRect(0,0,64,64);}};</script></body></html>`,
  });
  try {
    await assert.rejects(
      () => capture(root, SD),
      /broken image\(s\)/,
      'a broken image must still fail the capture, not become a diagnostic',
    );
  } finally {
    await cleanup(root);
  }
});

test('Build records capture diagnostics and carries them across a reused operation', async () => {
  const root = await makeRoot({ 'index.html': canvasPage(32, 32) });
  const project: Project = ProjectSchema.parse({
    schemaVersion: 1,
    id: 'diag_build',
    revision: 1,
    title: 'Diagnostics Build',
    direction: { intent: 'capture diagnostics', looks: [{ id: 'look_main', description: 'main' }], transitions: [] },
    assets: [],
    bindings: {},
    sources: [
      {
        id: 'src',
        kind: 'browser',
        output: 'picture',
        entry: 'index.html',
        resources: [],
        bindings: [],
        params: {},
        seed: 0,
        frames: 1,
      },
    ],
    composition: {
      output: { width: 64, height: 64, fps: { numerator: 5, denominator: 1 }, sampleRate: 48000, channels: 1 },
      scenes: [{ id: 'scene', description: 'scene' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look_main', intent: 'x', targetFrames: 1 }],
      placements: [{ id: 'pl', shot: 'shot', source: 'src', inFrame: 0, outFrame: 1, startFrame: 0, audio: 'mute' }],
      transitions: [],
    },
  });
  try {
    await fs.writeFile(path.join(root, 'project.json'), JSON.stringify(project, null, 2));

    const first = await buildProject(root);
    assert.equal(first.status, 'succeeded', 'a diagnostic must not fail the Build');
    assert.deepEqual(codes(first.diagnostics ?? []), ['canvas-upscaled']);
    const operationIds = new Set(first.operations.map(operation => operation.id));
    for (const diagnostic of first.diagnostics ?? [])
      assert.ok(operationIds.has(diagnostic.operation), 'each diagnostic names a real operation');

    // Reused capture: the operation is served from cache, so nothing is
    // re-observed — the earlier run's diagnostics must be carried forward.
    const second = await buildProject(root);
    assert.equal(second.status, 'succeeded');
    assert.ok(
      second.operations.some(operation => operation.reused),
      'the second Build must reuse the cached capture operation',
    );
    assert.ok(
      (second.diagnostics ?? []).some(diagnostic => diagnostic.code === 'canvas-upscaled'),
      'reused operation diagnostics must carry into the new Build record',
    );

    const review = await reviewBuild(root);
    const report = JSON.parse(await fs.readFile(path.join(root, review.report), 'utf8')) as {
      diagnostics: Array<{ code: string }>;
      limitations: string[];
    };
    assert.ok(
      report.diagnostics.some(diagnostic => diagnostic.code === 'canvas-upscaled'),
      'review/report.json must surface the Build diagnostics',
    );
    assert.ok(
      report.limitations.some(line => line.includes('canvas-upscaled')),
      'the report must state that diagnostics are non-blocking technical facts',
    );
  } finally {
    await cleanup(root);
  }
});
