import { createSymlinkFixture } from './fs-fixtures.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordPlayable, captureReplay, capturePlayable } from '../src/backends/playable/playable.js';
import { loadRecording } from '../src/backends/playable/recording.js';
import { buildProject } from '../src/build/build.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { loadProject, saveProject } from '../src/project/project.js';
import { hashFile } from '../src/shared/hash.js';
import {
  SourceSchema,
  PlayableRecordingSchema,
  type BrowserPictureSource,
  type PlayableInput,
} from '../src/core/schema.js';

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
  } as BrowserPictureSource;
}

function playableSource(recording: string, overrides: Partial<BrowserPictureSource> = {}): BrowserPictureSource {
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
    ...overrides,
  } as BrowserPictureSource;
}

function projectJson(source: BrowserPictureSource = codeSource()): string {
  return JSON.stringify({
    schemaVersion: 1,
    id: 'playable-project',
    revision: 1,
    title: 'Playable Test',
    direction: { intent: 'test', looks: [{ id: 'look', description: 'flat' }], transitions: [] },
    assets: [],
    bindings: {},
    sources: [source],
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: '' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: '', targetFrames: 5 }],
      placements: [
        { id: 'edit', shot: 'shot', source: source.id, inFrame: 0, outFrame: 5, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio: [],
    },
  });
}

/**
 * A small deterministic "player": real DOM keydown/keyup handlers move the
 * sprite and log events; `render` paints from the current state; `state()`
 * returns the observed simulation state. Background colour depends on the
 * frame index, so distinct frames always produce distinct pixels.
 */
function gameHtml(options: { withState?: boolean; failAtFrame?: number } = {}): string {
  const { withState = true, failAtFrame } = options;
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000;overflow:hidden}</style></head>
<body><canvas id="c" width="32" height="32"></canvas>
<script>
window.viscraft = (function(){
  var keys = { ArrowLeft:false, ArrowRight:false, ArrowUp:false, ArrowDown:false, Space:false, r:false };
  var player = { x: 4, y: 8, score: 0, camera: 0, events: [] };
  function norm(e){
    if (e.key === ' ') return 'Space';
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') return e.key;
    if (e.key && e.key.length === 1 && e.key.toLowerCase() === 'r') return 'r';
    return null;
  }
  window.addEventListener('keydown', function(e){
    var k = norm(e);
    if (k && !keys[k]) { keys[k] = true; player.events.push('down:' + k); if (k === 'Space') player.score += 1; if (k === 'r') player.x = 4; }
  });
  window.addEventListener('keyup', function(e){
    var k = norm(e);
    if (k) { keys[k] = false; player.events.push('up:' + k); }
  });
  return {
    render: function(ctx){
      ${failAtFrame !== undefined ? `if (ctx.frame === ${failAtFrame}) throw new Error('render boom at ' + ctx.frame);` : ''}
      if (keys.ArrowRight) player.x = Math.min(28, player.x + 4);
      if (keys.ArrowLeft) player.x = Math.max(0, player.x - 4);
      player.camera = player.x;
      var c = document.getElementById('c'); c.width = ctx.width; c.height = ctx.height;
      var g = c.getContext('2d');
      g.fillStyle = 'rgb(' + ((ctx.frame * 13) % 256) + ',0,0)';
      g.fillRect(0, 0, ctx.width, ctx.height);
      g.fillStyle = '#00ff00';
      g.fillRect(player.x, player.y, 4, 4);
    }${
      withState
        ? `,
    state: function(){ return { x: player.x, y: player.y, score: player.score, camera: player.camera, keys: Object.keys(keys).filter(function(k){ return keys[k]; }), events: player.events.slice(-8) }; }`
        : ''
    }
  };
})();
</script></body></html>`;
}

async function makeProject(files: Record<string, string | Buffer>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-playable-'));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
  }
  return root;
}

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-playable-out-'));
}

async function frameBuffers(directory: string): Promise<Buffer[]> {
  const names = (await fs.readdir(directory)).filter(name => /^frame-\d{6}\.png$/.test(name)).sort();
  return Promise.all(names.map(name => fs.readFile(path.join(directory, name))));
}

async function cleanup(...directories: string[]): Promise<void> {
  for (const directory of directories) await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
}

/** Wait until recordPlayable has finished capturing and is in its publish window. */
async function waitForPublishWindow(root: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.stat(path.join(root, 'recordings'));
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  throw new Error('recordPlayable did not reach its publish window');
}

const SHIFT: PlayableInput[] = [
  { frame: 0, type: 'down', key: 'ArrowRight' },
  { frame: 3, type: 'up', key: 'ArrowRight' },
];

const EXAMPLE_PLAYABLE = fileURLToPath(new URL('../../tests/fixtures/authoring/playable.html', import.meta.url));

test('recordPlayable records real DOM key events and per-frame state as authored material', async () => {
  const root = await makeProject({ 'game.html': gameHtml(), 'project.json': projectJson() });
  try {
    const recording = await recordPlayable(root, 'game', SHIFT);

    assert.equal(recording.schemaVersion, 1);
    assert.equal(recording.frames, 5);
    assert.equal(recording.simulated, false);
    // The recorded events are the real DOM events the page emitted.
    assert.deepEqual(recording.events, SHIFT);
    assert.deepEqual(
      recording.states.map(entry => entry.frame),
      [0, 1, 2, 3, 4],
    );
    const x0 = (recording.states[0].state as { x: number }).x;
    const x3 = (recording.states[3].state as { x: number }).x;
    assert.notEqual(x0, x3, 'holding ArrowRight must shift the recorded x');
    assert.ok(recording.source.files.some(file => file.path === 'game.html'));
    assert.match(recording.source.key, /^[a-f0-9]{64}$/);

    // Authored material on disk, outside .viscraft.
    const sessionPath = path.join(root, 'recordings', recording.id, 'session.json');
    const previewPath = path.join(root, 'recordings', recording.id, 'preview.mp4');
    const session = JSON.parse(await fs.readFile(sessionPath, 'utf8')) as { id: string; events: PlayableInput[] };
    assert.equal(session.id, recording.id);
    assert.deepEqual(session.events, SHIFT);
    const preview = await fs.stat(previewPath);
    assert.ok(preview.size > 0, 'preview.mp4 must be encoded');
    assert.equal(recording.media.path, `recordings/${recording.id}/preview.mp4`);
    assert.equal(recording.media.info.frames, 5);
    assert.equal(recording.media.info.width, 32);
    assert.equal(recording.media.info.height, 32);

    // loadRecording round-trips through the canonical schema + media hash.
    const rel = `recordings/${recording.id}/session.json`;
    const loaded = await loadRecording(root, rel);
    assert.deepEqual(loaded, recording);
  } finally {
    await cleanup(root);
  }
});

test('a source parameter edit before publication is rejected instead of published as current', async () => {
  const root = await makeProject({
    'game.html': gameHtml(),
    'project.json': projectJson(codeSource({ frames: 12 })),
  });
  try {
    // Keep an early capture failure from becoming an unhandled rejection while
    // the test waits for the publish window.
    const pending = recordPlayable(root, 'game', SHIFT).then(
      () => null,
      (error: unknown) => error as Error,
    );
    // `recordings/` appears after capture, while the preview is still encoding:
    // mutating now races the short final publish lock exactly like a concurrent
    // author edit. The same check covers an edit made during capture, because the
    // signature compared here is the one read before capture started.
    await waitForPublishWindow(root);

    const current = await loadProject(root);
    current.revision = 2;
    const edited = current.sources.find(source => source.id === 'game');
    if (!edited || edited.kind !== 'browser' || edited.output !== 'picture')
      assert.fail('the fixture must declare a browser picture source');
    edited.params = { changedDuringCapture: true };
    // Use the public author path so this is a real concurrent edit, not a raw write.
    await saveProject(root, current, 1);

    const failure = await pending;
    assert.ok(failure instanceof Error, 'a concurrent author edit must not be published as current');
    assert.match(failure.message, /changed during capture|record again/);
    assert.deepEqual(
      await fs.readdir(path.join(root, 'recordings')),
      [],
      'a rejected recording leaves no session that could be mistaken for current',
    );
  } finally {
    await cleanup(root);
  }
});

test('captureReplay reproduces the recording byte-for-byte in the same environment', async () => {
  const root = await makeProject({ 'game.html': gameHtml(), 'project.json': projectJson() });
  const recordedFrames = await tempDir();
  const replayA = await tempDir();
  const replayB = await tempDir();
  try {
    const recording = await recordPlayable(root, 'game', SHIFT);
    const rel = `recordings/${recording.id}/session.json`;

    // A fresh scripted capture over the same source + inputs is the reference
    // "record" frame set; replay must reproduce it exactly.
    await capturePlayable(root, codeSource(), OUTPUT, recordedFrames, SHIFT, {});
    await captureReplay(root, playableSource(rel), OUTPUT, replayA, {});
    await captureReplay(root, playableSource(rel), OUTPUT, replayB, {});

    const reference = await frameBuffers(recordedFrames);
    const first = await frameBuffers(replayA);
    const second = await frameBuffers(replayB);
    assert.equal(reference.length, 5);
    assert.deepEqual(
      first.map(buffer => buffer.toString('hex')),
      reference.map(buffer => buffer.toString('hex')),
      'replay must reproduce the recorded frames byte-for-byte',
    );
    assert.deepEqual(
      first.map(buffer => buffer.toString('hex')),
      second.map(buffer => buffer.toString('hex')),
      'replay must be deterministic in the same environment',
    );
    assert.notEqual(first[0].toString('hex'), first[3].toString('hex'), 'input must change pixels');
  } finally {
    await cleanup(root, recordedFrames, replayA, replayB);
  }
});

test('recordPlayable rejects out-of-bounds and non-canonical input schedules', async () => {
  const root = await makeProject({ 'game.html': gameHtml(), 'project.json': projectJson() });
  try {
    await assert.rejects(
      recordPlayable(root, 'game', [{ frame: 99, type: 'down', key: 'ArrowRight' }]),
      /outside the recorded interval/,
    );
    await assert.rejects(
      recordPlayable(root, 'game', [{ frame: 0, type: 'down', key: 'a' } as unknown as PlayableInput]),
      /Invalid|invalid/,
    );
    await assert.rejects(
      recordPlayable(root, 'game', [
        { frame: 2, type: 'down', key: 'ArrowRight' },
        { frame: 1, type: 'up', key: 'ArrowRight' },
      ]),
      /nondecreasing/,
    );
  } finally {
    await cleanup(root);
  }
});

test('recordPlayable requires a real state() and fails on page errors', async () => {
  const missing = await makeProject({ 'game.html': gameHtml({ withState: false }), 'project.json': projectJson() });
  const broken = await makeProject({ 'game.html': gameHtml({ failAtFrame: 1 }), 'project.json': projectJson() });
  try {
    await assert.rejects(recordPlayable(missing, 'game', []), /state is not a function/);
    await assert.rejects(recordPlayable(broken, 'game', []), /render boom|page error/i);
  } finally {
    await cleanup(missing, broken);
  }
});

test('captureReplay rejects tampered sources, inputs and media', async () => {
  const root = await makeProject({ 'game.html': gameHtml(), 'project.json': projectJson() });
  const destination = await tempDir();
  try {
    const recording = await recordPlayable(root, 'game', SHIFT);
    const rel = `recordings/${recording.id}/session.json`;
    const sessionPath = path.join(root, recording.media.path.replace('preview.mp4', 'session.json'));

    // A declared source file changing after recording is rejected.
    const originalHtml = await fs.readFile(path.join(root, 'game.html'), 'utf8');
    await fs.writeFile(path.join(root, 'game.html'), `${originalHtml}\n<!-- edited after recording -->\n`);
    await assert.rejects(captureReplay(root, playableSource(rel), OUTPUT, destination, {}), /changed since recording/);
    await fs.writeFile(path.join(root, 'game.html'), originalHtml);

    // A tampered recorded input diverges from the recorded state.
    const session = JSON.parse(await fs.readFile(sessionPath, 'utf8')) as { events: PlayableInput[] };
    session.events = [
      { frame: 0, type: 'down', key: 'ArrowLeft' },
      { frame: 3, type: 'up', key: 'ArrowLeft' },
    ];
    await fs.writeFile(sessionPath, JSON.stringify(session, null, 2));
    await assert.rejects(
      captureReplay(root, playableSource(rel), OUTPUT, destination, {}),
      /diverged from the recording/,
    );

    // Restore a good recording by re-recording, then corrupt the preview media.
    const fresh = await recordPlayable(root, 'game', SHIFT);
    const freshRel = `recordings/${fresh.id}/session.json`;
    await fs.writeFile(path.join(root, fresh.media.path), 'not a real mp4');
    await assert.rejects(loadRecording(root, freshRel), /preview media hash mismatch/);
    await assert.rejects(
      captureReplay(root, playableSource(freshRel), OUTPUT, destination, {}),
      /preview media hash mismatch/,
    );

    // A missing preview media is rejected too.
    await fs.rm(path.join(root, fresh.media.path));
    await assert.rejects(loadRecording(root, freshRel), /missing/);
  } finally {
    await cleanup(root, destination);
  }
});

/** A code-source project whose `game` source binds a frozen image asset. */
function bindingProjectJson(assetSha: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    id: 'playable-binding-project',
    revision: 1,
    title: 'Playable Binding',
    direction: { intent: 'test', looks: [{ id: 'look', description: 'flat' }], transitions: [] },
    assets: [
      {
        id: 'hero_asset',
        revision: 1,
        path: 'assets/bind.png',
        sha256: assetSha,
        type: 'image',
        rights: { origin: 'test', license: 'test', redistributable: true },
        simulated: false,
      },
    ],
    bindings: { hero: 'hero_asset' },
    sources: [
      {
        id: 'game',
        kind: 'browser',
        output: 'picture',
        entry: 'game.html',
        resources: [],
        bindings: ['hero'],
        params: {},
        seed: 0,
        frames: 5,
      },
    ],
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: '' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: '', targetFrames: 5 }],
      placements: [{ id: 'edit', shot: 'shot', source: 'game', inFrame: 0, outFrame: 5, startFrame: 0, audio: 'mute' }],
      transitions: [],
      audio: [],
    },
  });
}

function playableProjectJson(recording: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    id: 'playable-build-project',
    revision: 1,
    title: 'Playable Build',
    direction: { intent: 'test', looks: [{ id: 'look', description: 'flat' }], transitions: [] },
    assets: [],
    bindings: {},
    sources: [
      {
        id: 'game',
        kind: 'browser',
        output: 'picture',
        entry: 'game.html',
        resources: [],
        bindings: [],
        params: {},
        seed: 0,
        frames: 5,
        recording,
      },
    ],
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: '' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: '', targetFrames: 5 }],
      placements: [{ id: 'edit', shot: 'shot', source: 'game', inFrame: 0, outFrame: 5, startFrame: 0, audio: 'mute' }],
      transitions: [],
      audio: [],
    },
  });
}

test('buildProject replays a playable recording into a real Take and final', async () => {
  const root = await makeProject({ 'game.html': gameHtml(), 'project.json': projectJson() });
  try {
    const recording = await recordPlayable(root, 'game', SHIFT);
    await fs.writeFile(path.join(root, 'project.json'), playableProjectJson(`recordings/${recording.id}/session.json`));

    const build = await buildProject(root);
    assert.equal(build.status, 'succeeded');
    assert.ok(build.result, 'playable build must produce a result');
    const take = build.takes.find(candidate => candidate.source === 'game');
    if (!take || take.medium !== 'picture') assert.fail('playable build must record a picture Take');
    assert.equal(take.simulated, false);
    assert.equal(take.frames, 5);
    const artifact = build.artifacts.find(candidate => candidate.id === build.result!.artifact);
    assert.ok(artifact, 'final artifact must be declared');
    assert.equal(artifact.kind, 'video');
    assert.equal(artifact.media?.frames, 5);
  } finally {
    await cleanup(root);
  }
});

test('portable export carries the playable recording and reopens to a rebuildable project', async () => {
  const root = await makeProject({ 'game.html': gameHtml(), 'project.json': projectJson() });
  const parent = await tempDir();
  const destination = path.join(parent, 'exported');
  try {
    const recording = await recordPlayable(root, 'game', SHIFT);
    await fs.writeFile(path.join(root, 'project.json'), playableProjectJson(`recordings/${recording.id}/session.json`));
    await buildProject(root);

    await exportProject(root, destination);
    const reopened = await loadProject(destination);
    assert.equal(reopened.sources.find(source => source.id === 'game')?.kind, 'browser');
    const reopenedRecording = await loadRecording(destination, `recordings/${recording.id}/session.json`);
    assert.deepEqual(reopenedRecording, recording);

    const rebuilt = await buildProject(destination);
    assert.equal(rebuilt.status, 'succeeded');
  } finally {
    await cleanup(root, parent);
  }
});

test('recorded Take trailer trims and repeats without replaying gameplay and survives export', async () => {
  const root = await makeProject({ 'game.html': gameHtml(), 'project.json': projectJson() });
  const parent = await tempDir();
  try {
    const recording = await recordPlayable(root, 'game', SHIFT);
    await fs.writeFile(path.join(root, 'project.json'), playableProjectJson(`recordings/${recording.id}/session.json`));
    const captured = await buildProject(root);
    const take = captured.takes[0];
    const project = await loadProject(root);
    project.composition!.placements = [
      { id: 'cut-a', shot: 'shot', take: take.id, inFrame: 0, outFrame: 2, startFrame: 0, audio: 'mute' },
      { id: 'cut-b', shot: 'shot', take: take.id, inFrame: 3, outFrame: 5, startFrame: 2, audio: 'mute' },
    ];
    project.composition!.subtitles = [
      { id: 'title', text: 'FLY', startFrame: 0, endFrame: 4, fontSize: 12, color: '#ffffff' },
    ];
    await saveProject(root, project, project.revision);
    const trailer = await buildProject(root);
    assert.ok(
      trailer.operations.every(operation => operation.kind !== 'browser' && operation.kind !== 'browser'),
      'editing accepted Take placements must not replay or recapture gameplay',
    );
    assert.equal(trailer.takes[0].id, take.id);
    assert.equal(trailer.artifacts.find(artifact => artifact.id === trailer.result!.artifact)!.media!.frames, 4);
    const destination = path.join(parent, 'trailer');
    await exportProject(root, destination);
    const reopened = await buildProject(destination);
    assert.ok(reopened.operations.every(operation => operation.reused));
    assert.equal(reopened.takes[0].id, take.id);
    const captionEdit = await loadProject(destination);
    captionEdit.composition!.subtitles![0].text = 'BOOST';
    await saveProject(destination, captionEdit, captionEdit.revision);
    const revised = await buildProject(destination);
    assert.ok(
      revised.operations
        .filter(operation => ['compose-video', 'mix-audio'].includes(operation.kind))
        .every(operation => operation.reused),
    );
    assert.ok(revised.operations.every(operation => operation.kind !== 'browser'));
  } finally {
    await cleanup(root, parent);
  }
});

test('captureReplay rejects a source file deleted after recording', async () => {
  const root = await makeProject({ 'game.html': gameHtml(), 'project.json': projectJson() });
  const destination = await tempDir();
  try {
    const recording = await recordPlayable(root, 'game', SHIFT);
    await fs.rm(path.join(root, 'game.html'));
    await assert.rejects(
      captureReplay(root, playableSource(`recordings/${recording.id}/session.json`), OUTPUT, destination, {}),
      /missing or unreadable/,
    );
  } finally {
    await cleanup(root, destination);
  }
});

test('captureReplay rejects a tampered binding asset hash and an extra recorded file', async () => {
  const root = await makeProject({
    'game.html': gameHtml(),
    'assets/bind.png': Buffer.from(TINY_PNG_BASE64, 'base64'),
  });
  const destination = await tempDir();
  try {
    const assetSha = await hashFile(path.join(root, 'assets', 'bind.png'));
    await fs.writeFile(path.join(root, 'project.json'), bindingProjectJson(assetSha));
    const recording = await recordPlayable(root, 'game', SHIFT);
    const rel = `recordings/${recording.id}/session.json`;
    const source = playableSource(rel, { bindings: ['hero'] });
    const goodBinding = { hero: { id: 'hero_asset', path: 'assets/bind.png', sha256: assetSha } };

    await assert.rejects(
      captureReplay(root, source, OUTPUT, destination, { hero: { ...goodBinding.hero, sha256: 'f'.repeat(64) } }),
      /asset hash does not match/,
    );

    const session = JSON.parse(await fs.readFile(path.join(root, rel), 'utf8')) as {
      source: { files: Array<{ path: string; sha256: string }> };
    };
    session.source.files.push({ path: 'extra.txt', sha256: '0'.repeat(64) });
    await fs.writeFile(path.join(root, rel), JSON.stringify(session));
    await assert.rejects(captureReplay(root, source, OUTPUT, destination, goodBinding), /exactly match/);
  } finally {
    await cleanup(root, destination);
  }
});

test('loadRecording protects signatures and credentials while allowing an explicit memory budget', async () => {
  const root = await makeProject({ 'game.html': gameHtml(), 'project.json': projectJson() });
  try {
    const recording = await recordPlayable(root, 'game', SHIFT);
    const rel = `recordings/${recording.id}/session.json`;
    const sessionPath = path.join(root, rel);
    const original = await fs.readFile(sessionPath, 'utf8');
    const session = JSON.parse(original) as { source: { key: string; params: Record<string, unknown> } };

    session.source.key = 'a'.repeat(64);
    await fs.writeFile(sessionPath, JSON.stringify(session));
    await assert.rejects(loadRecording(root, rel), /signature does not match/);

    session.source.key = (JSON.parse(original) as { source: { key: string } }).source.key;
    session.source.params = { authorization: 'Bearer abcdefghijklmnopqrstuvwxyz123456' };
    await fs.writeFile(sessionPath, JSON.stringify(session));
    await assert.rejects(loadRecording(root, rel), /credential\/header field/);

    const oldBudget = process.env.VISCRAFT_RECORDING_MAX_BYTES;
    try {
      await fs.writeFile(sessionPath, original.padEnd(1_000_001, ' '));
      process.env.VISCRAFT_RECORDING_MAX_BYTES = '1000000';
      await assert.rejects(loadRecording(root, rel), /recording memory budget/);
      process.env.VISCRAFT_RECORDING_MAX_BYTES = '2000000';
      assert.equal((await loadRecording(root, rel)).id, recording.id);
    } finally {
      if (oldBudget === undefined) delete process.env.VISCRAFT_RECORDING_MAX_BYTES;
      else process.env.VISCRAFT_RECORDING_MAX_BYTES = oldBudget;
    }
  } finally {
    await cleanup(root);
  }
});

test('recording schemas preserve long sessions and dense input schedules', () => {
  const frames = 3601;
  const source = SourceSchema.parse(codeSource({ frames, recording: 'recordings/session.json' }));
  assert.equal(source.kind, 'browser');
  const events = Array.from({ length: 12001 }, (_unused, index) => ({
    frame: Math.floor(index / 4),
    type: index % 2 === 0 ? 'down' : 'up',
    key: 'ArrowRight',
  }));
  const recording = PlayableRecordingSchema.parse({
    schemaVersion: 1,
    id: 'long-session',
    source: {
      id: 'game',
      key: 'a'.repeat(64),
      entry: 'game.html',
      resources: [],
      bindings: [],
      params: {},
      seed: 0,
      files: [],
    },
    output: OUTPUT,
    frames,
    events,
    states: Array.from({ length: frames }, (_unused, frame) => ({ frame, state: { frame } })),
    media: {
      path: 'recordings/preview.mp4',
      sha256: 'b'.repeat(64),
      info: { frames, fps: OUTPUT.fps, width: 32, height: 32, duration: frames / 5, videoCodec: 'h264' },
    },
    simulated: false,
  });
  assert.equal(recording.frames, frames);
  assert.equal(recording.events.length, events.length);
  assert.equal(recording.states.length, frames);
});

test('recordPlayable and captureReplay interoperate with the shipped tests/fixtures/authoring/playable.html', async () => {
  const html = await fs.readFile(EXAMPLE_PLAYABLE, 'utf8');
  const root = await makeProject({
    'playable.html': html,
    'project.json': projectJson(
      codeSource({ entry: 'playable.html', frames: 6, seed: 7, params: { title: 'INTEROP' } }),
    ),
  });
  const destination = await tempDir();
  try {
    const schedule: PlayableInput[] = [
      { frame: 0, type: 'down', key: 'ArrowUp' },
      { frame: 3, type: 'up', key: 'ArrowUp' },
    ];
    const recording = await recordPlayable(root, 'game', schedule);
    assert.deepEqual(recording.events, schedule, 'DOM log must equal the real injected schedule');
    const states = recording.states.map(
      entry => entry.state as { frame: number; velocity: number; events: Array<{ type: string; frame: number }> },
    );
    assert.equal(states[0].frame, 0);
    assert.ok(
      states[0].events.some(event => event.type === 'boost' && event.frame === 0),
      'real ArrowUp at frame 0 should emit a boost event at frame 0',
    );
    assert.ok(states[0].velocity > 6.5, 'ArrowUp at frame 0 should boost the probe above its 6.5 base speed');
    assert.ok(states[3].velocity < states[2].velocity, 'releasing ArrowUp at frame 3 should lower velocity');

    const replaySource = playableSource(`recordings/${recording.id}/session.json`, {
      entry: 'playable.html',
      frames: 6,
      seed: 7,
      params: { title: 'INTEROP' },
    });
    await captureReplay(root, replaySource, OUTPUT, destination, {});
  } finally {
    await cleanup(root, destination);
  }
});

test('recordPlayable rejects a symlinked source entry (shared path policy)', async t => {
  const root = await makeProject({
    'game.html': gameHtml(),
    'project.json': projectJson(codeSource({ entry: 'link.html' })),
  });
  try {
    if (!(await createSymlinkFixture(t, 'game.html', path.join(root, 'link.html')))) return;
    await assert.rejects(recordPlayable(root, 'game', []), /Symbolic links are not allowed/);
  } finally {
    await cleanup(root);
  }
});

test('recordPlayable rejects an unknown or unsupported source id', async () => {
  const root = await makeProject({ 'game.html': gameHtml(), 'project.json': projectJson() });
  try {
    await assert.rejects(recordPlayable(root, 'missing', []), /unknown source/);
  } finally {
    await cleanup(root);
  }
});

test('recording and replay preserve large per-frame state without shape quotas', async () => {
  const html = gameHtml().replace(
    'state: function(){ return { x:',
    "state: function(){ return { detail: 'x'.repeat(40 * 1024), entities: Array.from({length:10001}, (_,i)=>i), x:",
  );
  const root = await makeProject({ 'game.html': html, 'project.json': projectJson() });
  const destination = await tempDir();
  try {
    const recording = await recordPlayable(root, 'game', SHIFT);
    const state = recording.states[0].state as { detail: string; entities: number[] };
    assert.equal(state.detail.length, 40 * 1024);
    assert.equal(state.entities.length, 10001);
    await captureReplay(root, playableSource('recordings/' + recording.id + '/session.json'), OUTPUT, destination, {});
    assert.equal((await frameBuffers(destination)).length, 5);
  } finally {
    await cleanup(root, destination);
  }
});

test('recording stops at its cumulative memory budget without changing authoring or dropping states', async () => {
  const html = gameHtml().replace(
    'state: function(){ return { x:',
    "state: function(){ return { detail: 'x'.repeat(1000), x:",
  );
  const root = await makeProject({ 'game.html': html, 'project.json': projectJson() });
  const before = await fs.readFile(path.join(root, 'project.json'));
  const oldBudget = process.env.VISCRAFT_RECORDING_MAX_BYTES;
  try {
    process.env.VISCRAFT_RECORDING_MAX_BYTES = '2400';
    await assert.rejects(recordPlayable(root, 'game', []), /recording memory budget/);
    assert.deepEqual(await fs.readFile(path.join(root, 'project.json')), before);
    assert.deepEqual(await fs.readdir(path.join(root, 'recordings')).catch(() => []), []);
    process.env.VISCRAFT_RECORDING_MAX_BYTES = '100000';
    const recording = await recordPlayable(root, 'game', []);
    assert.equal(recording.states.length, 5);
    assert.deepEqual(await fs.readFile(path.join(root, 'project.json')), before);
  } finally {
    if (oldBudget === undefined) delete process.env.VISCRAFT_RECORDING_MAX_BYTES;
    else process.env.VISCRAFT_RECORDING_MAX_BYTES = oldBudget;
    await cleanup(root);
  }
});
