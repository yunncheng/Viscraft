/**
 * TypeScript authoring entry for CodeScene capture.
 *
 * These tests drive the REAL browser capture path (`captureCode`) and the REAL
 * build scheduler, not a transpile stub:
 *  - a `.ts` entry that imports a shared `.ts` module renders actual PNG frames;
 *  - a `.ts` file with a deliberate type error fails loudly (naming the file and
 *    the TS diagnostic) and never writes a frame — with a corrected control that
 *    proves the failure is about the error, not about TypeScript being broken;
 *  - editing the shared imported `.ts` module invalidates the `code` operation
 *    on the next real build while an unchanged rebuild stays fully reused;
 *  - the new transpile module is inside the `code` and `sound` operation
 *    closures (so editing it invalidates them) but NOT inside a pure media
 *    operation — demonstrated on independent copies of the compiled runtime,
 *    the same way `tests/fingerprint.test.ts` pins the shipped closure map;
 *  - `.tsx` is supported only with a declared, dependency-free `h` factory, and
 *    JSX without that factory is refused loudly;
 *  - an HTML entry may load a TypeScript module resource.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureCode } from '../src/backends/browser/capture.js';
import { emittedJsPath, isTypeScriptPath, transpileStagedTypeScript } from '../src/backends/browser/transpile.js';
import { buildProject, operationImplementation } from '../src/build/build.js';
import type { BrowserPictureSource } from '../src/core/schema.js';

const OUTPUT = {
  width: 32,
  height: 32,
  fps: { numerator: 5, denominator: 1 },
  sampleRate: 48000 as const,
  channels: 1 as const,
};

const VALID_HELPER = `export function tint(frame: number): [number, number, number] {
  return [(frame * 40) % 256, (frame * 11) % 256, (frame * 7) % 256];
}
`;

const VALID_ENTRY = `import { tint } from './helper.js';

const canvas = document.createElement('canvas');
document.body.appendChild(canvas);

interface RenderArgs { frame: number; width: number; height: number; }

const viscraft = {
  render(args: RenderArgs): void {
    canvas.width = args.width;
    canvas.height = args.height;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('no 2d context');
    const rgb = tint(args.frame);
    g.fillStyle = 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
    g.fillRect(0, 0, args.width, args.height);
  },
};

(window as unknown as { viscraft: typeof viscraft }).viscraft = viscraft;
`;

/** Same entry, but the helper returns different pixels, so a rebuild differs. */
const CHANGED_HELPER = `export function tint(frame: number): [number, number, number] {
  return [255 - ((frame * 40) % 256), (frame * 90) % 256, (frame * 200) % 256];
}
`;

/** The helper with a real type error: a string assigned to a number. */
const BROKEN_HELPER = `export function tint(frame: number): [number, number, number] {
  const bad: number = 'not a number';
  return [bad, frame, 0];
}
`;

function codeSource(overrides: Partial<BrowserPictureSource> = {}): BrowserPictureSource {
  return {
    id: 'src',
    kind: 'browser',
    output: 'picture',
    entry: 'scene.ts',
    resources: ['helper.ts'],
    bindings: [],
    params: {},
    seed: 0,
    frames: 2,
    ...overrides,
  } as BrowserPictureSource;
}

async function makeProject(files: Record<string, string | Buffer>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-ts-'));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
  }
  return root;
}

async function cleanup(...dirs: string[]): Promise<void> {
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

async function frameFiles(dir: string): Promise<string[]> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  return names.filter(name => /^frame-\d{6}\.png$/.test(name)).sort();
}

async function frameBuffers(destination: string): Promise<Buffer[]> {
  const files = await frameFiles(destination);
  return Promise.all(files.map(file => fs.readFile(path.join(destination, file))));
}

test('emittedJsPath and isTypeScriptPath map staged TypeScript correctly', () => {
  assert.equal(isTypeScriptPath('scene.ts'), true);
  assert.equal(isTypeScriptPath('scenes/view.tsx'), true);
  assert.equal(isTypeScriptPath('index.html'), false);
  assert.equal(isTypeScriptPath('helper.js'), false);
  assert.equal(emittedJsPath('scene.ts'), 'scene.js');
  assert.equal(emittedJsPath('scenes/view.tsx'), 'scenes/view.js');
  assert.equal(emittedJsPath('scenes/a.b.ts'), 'scenes/a.b.js');
});

test('a .ts entry importing a shared .ts module renders real frames', async () => {
  const root = await makeProject({ 'scene.ts': VALID_ENTRY, 'helper.ts': VALID_HELPER });
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-ts-out-'));
  try {
    const result = await captureCode(root, codeSource(), OUTPUT, destination);
    assert.match(result.browserVersion, /Chrome/);

    const files = await frameFiles(destination);
    assert.deepEqual(files, ['frame-000000.png', 'frame-000001.png']);
    const buffers = await frameBuffers(destination);
    for (const buf of buffers) {
      assert.ok(buf.length > 0);
      assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
    }
    assert.notEqual(
      buffers[0].toString('hex'),
      buffers[1].toString('hex'),
      'frames must differ, proving the imported transpiled helper ran',
    );
  } finally {
    await cleanup(root, destination);
  }
});

test('a .ts type error fails loudly and writes no frame (non-vacuous)', async () => {
  const brokenRoot = await makeProject({ 'scene.ts': VALID_ENTRY, 'helper.ts': BROKEN_HELPER });
  const brokenOut = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-ts-out-'));
  try {
    // The failure names the offending file, position and diagnostic — never a blank frame.
    await assert.rejects(
      captureCode(brokenRoot, codeSource(), OUTPUT, brokenOut),
      /captureCode: TypeScript authoring entry failed to compile[\s\S]*helper\.ts:2:\d+ TS2322: Type 'string' is not assignable to type 'number'/,
    );
    assert.deepEqual(await frameFiles(brokenOut), [], 'no frames may be written for a type error');
  } finally {
    await cleanup(brokenRoot, brokenOut);
  }

  // Control: the identical staged set with the type error removed compiles, so the
  // rejection above is caused by the diagnostic and not by TypeScript being unusable.
  const fixedRoot = await makeProject({ 'scene.ts': VALID_ENTRY, 'helper.ts': VALID_HELPER });
  let staged: string | undefined;
  try {
    staged = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-ts-stage-'));
    await fs.copyFile(path.join(fixedRoot, 'scene.ts'), path.join(staged, 'scene.ts'));
    await fs.copyFile(path.join(fixedRoot, 'helper.ts'), path.join(staged, 'helper.ts'));
    const emitted = await transpileStagedTypeScript({
      snapshotRoot: staged,
      files: ['scene.ts', 'helper.ts'],
      label: 'captureCode',
    });
    assert.deepEqual(emitted.sort(), ['helper.js', 'scene.js']);
    const helperJs = await fs.readFile(path.join(staged, 'helper.js'), 'utf8');
    assert.match(helperJs, /export function tint/);
    assert.match(helperJs, /sourceMappingURL=data:/, 'the emitted .js embeds an inline source map');
  } finally {
    await cleanup(fixedRoot, ...(staged ? [staged] : []));
  }
});

/** Minimal valid project whose single code Source is the given entry/resources. */
function tsProjectJson(entry: string, resources: string[]): string {
  return JSON.stringify({
    schemaVersion: 1,
    id: 'ts-entry-project',
    revision: 1,
    title: 'TypeScript Entry Test',
    direction: { intent: 'test', looks: [{ id: 'look', description: 'flat' }], transitions: [] },
    assets: [],
    bindings: {},
    sources: [
      { id: 'src', kind: 'browser', output: 'picture', entry, resources, bindings: [], params: {}, seed: 0, frames: 3 },
    ],
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: '' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: '', targetFrames: 3 }],
      placements: [{ id: 'edit', shot: 'shot', source: 'src', inFrame: 0, outFrame: 3, startFrame: 0, audio: 'mute' }],
      transitions: [],
      audio: [],
    },
  });
}

test('editing a shared imported .ts module invalidates the code operation on a real build', async () => {
  const root = await makeProject({
    'scene.ts': VALID_ENTRY,
    'helper.ts': VALID_HELPER,
    'project.json': tsProjectJson('scene.ts', ['helper.ts']),
  });
  try {
    const first = await buildProject(root);
    assert.equal(first.status, 'succeeded');
    assert.equal(first.operations.find(op => op.kind === 'browser')!.reused, false, 'the first build renders fresh');
    const firstSha = first.artifacts.find(a => a.id === first.result!.artifact)!.sha256;

    const second = await buildProject(root);
    assert.equal(second.status, 'succeeded');
    assert.ok(
      second.operations.every(op => op.reused),
      'an unchanged TypeScript project reuses every operation',
    );
    assert.equal(second.artifacts.find(a => a.id === second.result!.artifact)!.sha256, firstSha);

    // Change only the shared imported `.ts` module, not the entry.
    await fs.writeFile(path.join(root, 'helper.ts'), CHANGED_HELPER);
    const third = await buildProject(root);
    assert.equal(third.status, 'succeeded');
    assert.equal(
      third.operations.find(op => op.kind === 'browser')!.reused,
      false,
      'a change to the shared imported .ts module must invalidate the code operation',
    );
    assert.notEqual(
      third.artifacts.find(a => a.id === third.result!.artifact)!.sha256,
      firstSha,
      'the re-rendered picture must actually differ',
    );
  } finally {
    await cleanup(root);
  }
});

test('the transpile module is inside the code and sound operation closures, not a pure media one', async () => {
  const runtime = fileURLToPath(new URL('../src', import.meta.url));
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-transpile-closure-'));
  const copy = path.join(base, 'runtime');
  try {
    await fs.cp(runtime, copy, { recursive: true });
    const transpile = path.join(copy, 'backends', 'browser', 'transpile.js');
    await fs.writeFile(transpile, (await fs.readFile(transpile, 'utf8')) + '\n// closure probe\n');

    // Editing the transpiler must move the browser operation whose capture path
    // it backs (both picture and sound go through capture.js)...
    for (const kind of ['browser']) {
      assert.notEqual(
        await operationImplementation(copy, kind, []),
        await operationImplementation(runtime, kind, []),
        `a transpile change must move the ${kind} fingerprint`,
      );
    }
    // ...but must NOT move an operation that never captures in the browser.
    assert.equal(
      await operationImplementation(copy, 'compose-video', []),
      await operationImplementation(runtime, 'compose-video', []),
      'the transpiler is not a media dependency, so compose-video must be unchanged',
    );
  } finally {
    await cleanup(base);
  }
});

const VALID_TSX_ENTRY = `function h(type: string, props: Record<string, unknown> | null, ...children: unknown[]): { type: string; props: Record<string, unknown> | null; children: unknown[] } {
  return { type, props, children };
}

const card = <div class="card">{'hello'}</div>;

const canvas = document.createElement('canvas');
document.body.appendChild(canvas);

const viscraft = {
  render(args: { width: number; height: number }): void {
    if (card.type !== 'div') throw new Error('JSX factory did not run');
    canvas.width = args.width;
    canvas.height = args.height;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('no 2d context');
    g.fillStyle = '#102030';
    g.fillRect(0, 0, args.width, args.height);
  },
};

(window as unknown as { viscraft: typeof viscraft }).viscraft = viscraft;
`;

test('.tsx is supported with a declared dependency-free h factory', async () => {
  const root = await makeProject({ 'scene.tsx': VALID_TSX_ENTRY });
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-tsx-out-'));
  try {
    const result = await captureCode(
      root,
      codeSource({ entry: 'scene.tsx', resources: [], frames: 1 }),
      OUTPUT,
      destination,
    );
    assert.match(result.browserVersion, /Chrome/);
    assert.deepEqual(await frameFiles(destination), ['frame-000000.png']);
  } finally {
    await cleanup(root, destination);
  }
});

test('.tsx JSX without the declared h factory is refused loudly', async () => {
  const noFactory = `const card = <div/>;
(window as unknown as { viscraft: { render(): void } }).viscraft = { render(): void { void card; } };
`;
  const root = await makeProject({ 'scene.tsx': noFactory });
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-tsx-out-'));
  try {
    await assert.rejects(
      captureCode(root, codeSource({ entry: 'scene.tsx', resources: [], frames: 1 }), OUTPUT, destination),
      /TS2874: 'h' to be in scope|TS2874/,
    );
    assert.deepEqual(await frameFiles(destination), []);
  } finally {
    await cleanup(root, destination);
  }
});

test('an HTML entry may load a TypeScript module resource', async () => {
  const root = await makeProject({
    'index.html':
      '<!doctype html><html><head><meta charset="utf-8"></head><body><canvas id="c"></canvas><script type="module" src="./main.js"></script></body></html>',
    'main.ts': `import { shade } from './palette.js';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const viscraft = {
  render(args: { frame: number; width: number; height: number }): void {
    canvas.width = args.width;
    canvas.height = args.height;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('no 2d context');
    g.fillStyle = shade(args.frame);
    g.fillRect(0, 0, args.width, args.height);
  },
};
(window as unknown as { viscraft: typeof viscraft }).viscraft = viscraft;
`,
    'palette.ts': `export function shade(frame: number): string {
  return 'rgb(' + ((frame * 30) % 256) + ',40,80)';
}
`,
  });
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-ts-html-out-'));
  try {
    await captureCode(
      root,
      codeSource({ entry: 'index.html', resources: ['main.ts', 'palette.ts'], frames: 2 }),
      OUTPUT,
      destination,
    );
    assert.deepEqual(await frameFiles(destination), ['frame-000000.png', 'frame-000001.png']);
  } finally {
    await cleanup(root, destination);
  }
});
