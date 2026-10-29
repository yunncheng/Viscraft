/** Playable and TypeScript input contracts: declaration checking, MIME types, resource allowlists, World mode and exact frame-clock validation. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDeclarationPath, transpileStagedTypeScript } from '../src/backends/browser/transpile.js';
import { servePlayable, type PlayableServer } from '../src/backends/playable/playable-server.js';
import { captureReplay, recordPlayable } from '../src/backends/playable/playable.js';
import { loadRecording } from '../src/backends/playable/recording.js';
import { PlayablePackageManifestSchema } from '../src/core/schema.js';
import type { BrowserPictureSource, PlayableInput } from '../src/core/schema.js';

const OUTPUT = {
  width: 32,
  height: 32,
  fps: { numerator: 5, denominator: 1 },
  sampleRate: 48000 as const,
  channels: 1 as const,
};

/** 50/2 fps is the same grid as 25/1; a probe reports the reduced form. */
const OUTPUT_50_2 = { ...OUTPUT, fps: { numerator: 50, denominator: 2 } };

const SHIFT: PlayableInput[] = [
  { frame: 0, type: 'down', key: 'ArrowRight' },
  { frame: 3, type: 'up', key: 'ArrowRight' },
];

async function makeProject(files: Record<string, string | Buffer>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-fixture-playable-'));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, ...relative.split('/'));
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
  }
  return root;
}

async function cleanup(...directories: string[]): Promise<void> {
  for (const directory of directories) await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * A small deterministic "player" whose `state()` reflects real DOM key events,
 * so `recordPlayable` has a real observation to freeze.
 */
function gameHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000;overflow:hidden}</style></head>
<body><canvas id="c" width="32" height="32"></canvas>
<script>
window.viscraft = (function(){
  var held = { ArrowRight:false };
  var player = { x: 4, score: 0 };
  window.addEventListener('keydown', function(e){ if (e.key === 'ArrowRight') held.ArrowRight = true; });
  window.addEventListener('keyup', function(e){ if (e.key === 'ArrowRight') held.ArrowRight = false; });
  return {
    render: function(ctx){
      if (held.ArrowRight) player.x = Math.min(28, player.x + 4);
      var c = document.getElementById('c'); c.width = ctx.width; c.height = ctx.height;
      var g = c.getContext('2d');
      g.fillStyle = 'rgb(' + ((ctx.frame * 13) % 256) + ',0,0)'; g.fillRect(0, 0, ctx.width, ctx.height);
      g.fillStyle = '#00ff00'; g.fillRect(player.x, 8, 4, 4);
    },
    state: function(){ return { x: player.x, score: player.score }; }
  };
})();
</script></body></html>`;
}

function browserSource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'game',
    kind: 'browser',
    output: 'picture',
    entry: 'game.html',
    resources: [],
    bindings: [],
    params: {},
    seed: 0,
    frames: 5,
    ...overrides,
  };
}

function projectJson(source: Record<string, unknown>, output = OUTPUT, worlds: unknown[] = []): string {
  return JSON.stringify({
    schemaVersion: 1,
    id: 'fixture-playable-project',
    revision: 1,
    title: 'Playable',
    direction: { intent: 'test', looks: [{ id: 'look', description: 'flat' }], transitions: [] },
    assets: [],
    bindings: {},
    worlds,
    sources: [source],
    composition: {
      output,
      scenes: [{ id: 'scene', description: '' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: '', targetFrames: 5 }],
      placements: [{ id: 'edit', shot: 'shot', source: 'game', inFrame: 0, outFrame: 5, startFrame: 0, audio: 'mute' }],
      transitions: [],
      audio: [],
    },
  });
}

function playableSource(recording: string): BrowserPictureSource {
  return {
    id: 'game-replay',
    kind: 'browser',
    output: 'picture',
    entry: 'game.html',
    resources: [],
    bindings: [],
    params: {},
    seed: 0,
    frames: 5,
    recording,
  } as BrowserPictureSource;
}

// ---------------------------------------------------------------------------
// `.d.ts` participates in type checking but is never an emit unit
// ---------------------------------------------------------------------------

test('transpileStagedTypeScript type-checks .d.ts without emitting a .d.js sibling', async () => {
  assert.equal(isDeclarationPath('types.d.ts'), true);
  assert.equal(isDeclarationPath('scene.ts'), false);

  // `main.ts` imports a type from the declaration, so the `.d.ts` must really be
  // in the program (Bundler resolution maps `./types.js` to `./types.d.ts`).
  const snapshot = await makeProject({
    'main.ts': `import type { Foo } from './types.js';
export function make(n: number): Foo { return { n }; }
`,
    'types.d.ts': `export interface Foo { n: number }
`,
  });
  try {
    const emitted = await transpileStagedTypeScript({
      snapshotRoot: snapshot,
      files: ['main.ts', 'types.d.ts'],
      label: 'captureCode',
    });
    assert.deepEqual(emitted, ['main.js'], 'only the `.ts` unit is emitted');
    assert.ok(
      (await fs.readFile(path.join(snapshot, 'main.js'), 'utf8')).includes('export function make'),
      'the `.ts` entry is transpiled as before',
    );
    await assert.rejects(() => fs.access(path.join(snapshot, 'types.d.js')), 'no meaningless .d.js may be written');
  } finally {
    await cleanup(snapshot);
  }
});

test('a bad .d.ts still reports a real TypeScript diagnostic', async () => {
  // `skipLibCheck` suppresses semantic errors *inside* a declaration file, but a
  // syntactic error is still reported — proving declarations are type-checked
  // and not merely skipped by the emit loop.
  const snapshot = await makeProject({
    'main.ts': `import type { Foo } from './types.js';
export function make(n: number): Foo { return { n }; }
`,
    'types.d.ts': `export interface Foo { n: number
`,
  });
  try {
    await assert.rejects(
      transpileStagedTypeScript({ snapshotRoot: snapshot, files: ['main.ts', 'types.d.ts'], label: 'captureCode' }),
      /captureCode: TypeScript authoring entry failed to compile[\s\S]*types\.d\.ts:\d+:\d+ TS1005/,
    );
  } finally {
    await cleanup(snapshot);
  }
});

// ---------------------------------------------------------------------------
// a declared `.wasm` is served with the correct MIME type
// ---------------------------------------------------------------------------

test('servePlayable serves a declared .wasm as application/wasm, 409 on tamper and 404 when undeclared', async () => {
  const root = await makeProject({
    'index.html': '<!doctype html><html><body></body></html>\n',
    'mod.wasm': Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
  });
  const live = JSON.stringify({
    schemaVersion: 1,
    id: 'wasm-pkg',
    revision: 1,
    title: 'Wasm Package',
    sources: [
      {
        id: 'game',
        kind: 'browser',
        output: 'picture',
        entry: 'index.html',
        resources: ['mod.wasm'],
        bindings: [],
        params: {},
        seed: 0,
        frames: 1,
      },
    ],
    assets: [],
    bindings: {},
    composition: { output: OUTPUT },
  });
  await fs.writeFile(path.join(root, 'project.json'), live);
  const manifest = PlayablePackageManifestSchema.parse({
    format: 'viscraft-playable-package',
    version: 1,
    id: 'wasm-pkg',
    project: { id: 'wasm-pkg', revision: 1, title: 'Wasm Package' },
    source: { id: 'game', entry: 'index.html', sourceHash: 'a'.repeat(64) },
    simulated: false,
    files: [
      { path: 'index.html', sha256: sha256(await fs.readFile(path.join(root, 'index.html'))), role: 'entry' },
      { path: 'project.json', sha256: sha256(live), role: 'configuration' },
      { path: 'mod.wasm', sha256: sha256(await fs.readFile(path.join(root, 'mod.wasm'))), role: 'resource' },
    ],
    notes: ['test package'],
  });
  await fs.writeFile(path.join(root, 'playable-manifest.json'), JSON.stringify(manifest));

  let server: PlayableServer | undefined;
  try {
    server = await servePlayable(root);
    const wasm = await fetch(new URL('mod.wasm', server.url));
    assert.equal(wasm.status, 200);
    assert.equal(wasm.headers.get('content-type'), 'application/wasm');
    assert.equal(Buffer.from(await wasm.arrayBuffer()).length, 8);

    // An undeclared path is still outside the allowlist.
    assert.equal((await fetch(new URL('secret.txt', server.url))).status, 404);

    // A tampered wasm fails the hash guard instead of being served.
    await fs.writeFile(path.join(root, 'mod.wasm'), 'tampered');
    assert.equal((await fetch(new URL('mod.wasm', server.url))).status, 409);
  } finally {
    await server?.close();
    await cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// a `drive`-mode World is refused before any capture
// ---------------------------------------------------------------------------

function world(mode: 'drive' | 'define'): { worlds: unknown[]; source: Record<string, unknown> } {
  return {
    worlds: [
      {
        id: 'world_a',
        revision: 1,
        units: 'meters',
        coordinates: 'right-handed-y-up',
        fps: { numerator: 5, denominator: 1 },
        frames: 5,
        entities: [],
        trajectories: [],
        cameras: [{ id: 'cam_main', position: [0, 2, -5], target: [0, 0, 0], fov: 50 }],
      },
    ],
    source: browserSource({
      world: { id: 'world_a', camera: 'cam_main', mode, ...(mode === 'drive' ? { startFrame: 0 } : {}) },
    }),
  };
}

test('recordPlayable refuses a drive-mode World before writing any recording', async () => {
  const drive = world('drive');
  const root = await makeProject({
    'game.html': gameHtml(),
    'project.json': projectJson(drive.source, OUTPUT, drive.worlds),
  });
  try {
    await assert.rejects(recordPlayable(root, 'game', SHIFT), /mode 'drive'/);
    await assert.rejects(
      () => fs.access(path.join(root, 'recordings')),
      'no recordings/ directory may be created for a refused drive recording',
    );
  } finally {
    await cleanup(root);
  }

  // Control: the same source in `define` mode still records (only the definition
  // is handed over), so the refusal is about `drive`, not about World at all.
  const define = world('define');
  const defineRoot = await makeProject({
    'game.html': gameHtml(),
    'project.json': projectJson(define.source, OUTPUT, define.worlds),
  });
  try {
    const recording = await recordPlayable(defineRoot, 'game', SHIFT);
    assert.ok(recording.source.world, 'a define-mode recording freezes its World definition');
    await fs.access(path.join(defineRoot, 'recordings', recording.id, 'session.json'));
  } finally {
    await cleanup(defineRoot);
  }
});

// ---------------------------------------------------------------------------
// write side runs the shared read-side guards before persisting
// ---------------------------------------------------------------------------

test('recordPlayable refuses a credential param before persisting, and a normal record round-trips load→replay', async () => {
  // `x-api-key` passes `validateProject` (which only blocks a narrower key set)
  // but is caught by the recording's credential guard before persistence.
  const credential = await makeProject({
    'game.html': gameHtml(),
    'project.json': projectJson(browserSource({ params: { 'x-api-key': 'redacted' } })),
  });
  try {
    await assert.rejects(recordPlayable(credential, 'game', SHIFT), /credential\/header field/);
    const written = await fs.readdir(path.join(credential, 'recordings')).catch(() => [] as string[]);
    assert.deepEqual(written, [], 'a session that fails the read-side guards must not be left on disk');
  } finally {
    await cleanup(credential);
  }

  const root = await makeProject({ 'game.html': gameHtml(), 'project.json': projectJson(browserSource()) });
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-fixture-replay-'));
  try {
    const recording = await recordPlayable(root, 'game', SHIFT);
    const rel = `recordings/${recording.id}/session.json`;
    const loaded = await loadRecording(root, rel);
    assert.deepEqual(loaded, recording, 'the shared validator accepts what the write side accepted');
    await captureReplay(root, playableSource(rel), OUTPUT, destination, {});
  } finally {
    await cleanup(root, destination);
  }
});

// ---------------------------------------------------------------------------
// the frame clock is compared as exact rationals
// ---------------------------------------------------------------------------

test('recordPlayable accepts a probe-reduced fps (50/2 == 25/1) and refuses a different grid', async () => {
  const root = await makeProject({
    'game.html': gameHtml(),
    'project.json': projectJson(browserSource(), OUTPUT_50_2),
  });
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-fixture-fps-'));
  try {
    const recording = await recordPlayable(root, 'game', SHIFT);
    const rel = `recordings/${recording.id}/session.json`;
    const sessionPath = path.join(root, rel);

    // The probe reports the grid in reduced form; the rationals are equal.
    const mediaFps = recording.media.info.fps;
    assert.equal(
      mediaFps.numerator * recording.output.fps.denominator,
      recording.output.fps.numerator * mediaFps.denominator,
      'the recorded preview sits on the same rational grid as the output',
    );

    // `loadRecording` accepts it, and a replay over the same output works.
    await loadRecording(root, rel);
    await captureReplay(root, playableSource(rel), OUTPUT_50_2, destination, {});

    // A representation the old raw-hash comparison rejected: {25,1} vs output
    // {50,2} — same value, different rational form. It must now load cleanly.
    const session = JSON.parse(await fs.readFile(sessionPath, 'utf8')) as {
      media: { info: { fps: { numerator: number; denominator: number } } };
    };
    session.media.info.fps = { numerator: 25, denominator: 1 };
    await fs.writeFile(sessionPath, JSON.stringify(session));
    await loadRecording(root, rel);

    // A genuinely different grid is still refused.
    session.media.info.fps = { numerator: 24, denominator: 1 };
    await fs.writeFile(sessionPath, JSON.stringify(session));
    await assert.rejects(loadRecording(root, rel), /frame clock/);
  } finally {
    await cleanup(root, destination);
  }
});
