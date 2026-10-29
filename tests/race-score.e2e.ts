import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { buildProject } from '../src/build/build.js';
import { loadProject, saveProject, validateProject } from '../src/project/project.js';
import { recordPlayable } from '../src/backends/playable/playable.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import type { Project, BrowserPictureSource } from '../src/core/schema.js';

const PAGE = `<!doctype html><body style="margin:0"><canvas id="canvas"></canvas><script>
let offset=0,current=null;const keys=new Set();addEventListener('keydown',e=>keys.add(e.key));addEventListener('keyup',e=>keys.delete(e.key));
window.viscraft={reset(){offset=0;keys.clear();current=null},render(ctx){offset+=keys.has('ArrowRight')?0.1:0;current={speed:keys.has(' ')?2:1,offset,checkpointEvents:(ctx.frame===4||ctx.frame===8)?['actual-checkpoint']:[]};const c=document.getElementById('canvas');c.width=ctx.width;c.height=ctx.height;const g=c.getContext('2d');g.fillStyle='#113355';g.fillRect(0,0,c.width,c.height);g.fillStyle='#ffffff';g.fillRect(8+ctx.frame+offset*10,16,8,8)},state(){return current}};
</script></body>`;

test('recorded-state score creates original audio and sound-only builds reuse accepted picture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-recorded-score-'));
  const delivery = root + '-delivery';
  try {
    await writeFile(join(root, 'game.html'), PAGE);
    const initial: Project = {
      schemaVersion: 1,
      id: 'recorded-score',
      revision: 1,
      title: 'Original score contract',
      soundTargets: [],
      direction: {
        intent: 'Actual recorded state drives original sound',
        looks: [{ id: 'look', description: 'fixture' }],
        transitions: [],
      },
      assets: [],
      bindings: {},
      sources: [
        {
          id: 'drive',
          kind: 'browser',
          output: 'picture',
          entry: 'game.html',
          resources: [],
          bindings: [],
          params: {},
          seed: 7,
          frames: 12,
        },
      ],
      composition: {
        output: { width: 96, height: 64, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 },
        scenes: [{ id: 'scene', description: 'Recorded state' }],
        shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: 'Driving clip', targetFrames: 12 }],
        placements: [
          { id: 'edit', shot: 'shot', source: 'drive', inFrame: 0, outFrame: 12, startFrame: 0, audio: 'mute' },
        ],
        transitions: [],
        audio: [],
      },
      imageDocuments: [],
      imageTargets: [],
    };
    await writeFile(join(root, 'project.json'), JSON.stringify(validateProject(initial)));
    const recording = await recordPlayable(root, 'drive', [
      { frame: 1, type: 'down', key: 'ArrowRight' },
      { frame: 3, type: 'up', key: 'ArrowRight' },
      { frame: 3, type: 'down', key: 'Space' },
      { frame: 7, type: 'up', key: 'Space' },
      { frame: 8, type: 'down', key: 'ArrowDown' },
      { frame: 10, type: 'up', key: 'ArrowDown' },
    ]);
    const project = await loadProject(root);
    project.sources[0] = {
      ...project.sources[0],
      kind: 'browser',
      output: 'picture',
      recording: `recordings/${recording.id}/session.json`,
    } as BrowserPictureSource;
    await saveProject(root, project, project.revision);
    const replay = await buildProject(root);
    const selected = await loadProject(root);
    selected.composition!.placements = [
      { id: 'first', shot: 'shot', take: replay.takes[0].id, inFrame: 0, outFrame: 6, startFrame: 0, audio: 'mute' },
      {
        id: 'last',
        shot: 'shot',
        take: replay.takes[0].id,
        inFrame: 6,
        outFrame: 12,
        durationFrames: 12,
        startFrame: 6,
        audio: 'mute',
      },
    ];
    await saveProject(root, selected, selected.revision);
    const before = await buildProject(root);
    const script = resolve('tests/fixtures/authoring/score-race-recording.mjs');
    await runCommand(process.execPath, [script, root, recording.id]);
    const authored = await loadProject(root);
    assert.deepEqual(authored.composition!.placements, selected.composition!.placements);
    assert.deepEqual(authored.sources, selected.sources);
    assert.deepEqual(authored.worlds, selected.worlds);
    assert.ok(authored.composition!.audio.some(clip => clip.kind === 'asset'));
    const soundAssets = authored.assets.filter(asset => asset.type === 'audio');
    assert.ok(soundAssets.length > 0);
    const hashes = [];
    for (const asset of soundAssets) {
      assert.equal(asset.simulated, false);
      assert.equal(await hashFile(join(root, asset.path)), asset.sha256);
      hashes.push(asset.sha256);
      const pcm = join(root, 'probe.pcm');
      await runCommand('ffmpeg', [
        '-v',
        'error',
        '-y',
        '-i',
        join(root, asset.path),
        '-f',
        'f32le',
        '-ac',
        '2',
        '-ar',
        '48000',
        pcm,
      ]);
      const bytes = await readFile(pcm);
      assert.equal(bytes.length, 28800 * 2 * 4);
      let peak = 0;
      for (let at = 0; at < bytes.length; at += 4) peak = Math.max(peak, Math.abs(bytes.readFloatLE(at)));
      assert.ok(peak > 0.01 && peak < 1, 'original score must be non-silent with headroom');
    }
    const scored = await buildProject(root);
    assert.equal(scored.status, 'succeeded');
    assert.ok(!scored.operations.some(operation => operation.kind === 'browser'));
    assert.equal(scored.operations.find(operation => operation.kind === 'compose-video')!.reused, true);
    assert.equal(scored.operations.find(operation => operation.kind === 'retime-clip')!.reused, true);
    const final = scored.artifacts.find(artifact => artifact.id === scored.result!.artifact)!;
    assert.equal(final.media!.frames, 18);
    assert.equal(final.media!.audio!.duration, 0.6);
    assert.notEqual(final.id, before.result!.artifact);
    await runCommand(process.execPath, [script, root, recording.id]);
    const again = await loadProject(root);
    assert.deepEqual(
      again.assets.filter(asset => asset.type === 'audio').map(asset => asset.sha256),
      hashes,
    );
    await exportProject(root, delivery);
    assert.ok((await buildProject(delivery)).operations.every(operation => operation.reused));
    await runCommand(process.execPath, [script, delivery, recording.id]);
    const reopened = await loadProject(delivery);
    assert.deepEqual(
      reopened.composition!.audio,
      again.composition!.audio,
      'portable score preserves the exact recorded session producer',
    );
    reopened.composition!.placements[0].inFrame = 1;
    reopened.composition!.placements[0].durationFrames = 6;
    await saveProject(delivery, reopened, reopened.revision);
    await runCommand(process.execPath, [script, delivery, recording.id]);
    const revised = await buildProject(delivery);
    assert.ok(
      !revised.operations.some(operation => operation.kind === 'browser'),
      're-scoring an exported edit must not replay gameplay',
    );
    assert.equal(revised.takes[0].id, replay.takes[0].id);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(delivery, { recursive: true, force: true });
  }
});
