import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildProject } from '../src/build/build.js';
import { loadProject, saveProject, validateProject, resolveWorldBinding } from '../src/project/project.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { recordPlayable } from '../src/backends/playable/playable.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import type { BrowserPictureSource, Project } from '../src/core/schema.js';

const PAGE = `<!doctype html><html><body style="margin:0"><canvas id="c"></canvas><script>
let current=null,held=false;addEventListener('keydown',e=>{if(e.key==='ArrowRight')held=true});addEventListener('keyup',e=>{if(e.key==='ArrowRight')held=false});
window.viscraft={reset(){held=false;current=null},async render(ctx){
const w=window.__viscraftWorld||window.__viscraftWorldDefinition;
if(!w||ctx.bindings.hero.id!==w.entities[0].asset)throw Error('scoped World asset does not match actual binding');
const color=await fetch(ctx.bindings.hero.url).then(r=>r.text());const c=document.getElementById('c');c.width=ctx.width;c.height=ctx.height;
const g=c.getContext('2d');g.fillStyle=color;g.fillRect(0,0,c.width,c.height);if(held){g.fillStyle='white';g.fillRect(0,0,10,10)}
current={asset:w.entities[0].asset,color,held,frame:ctx.frame};},state:()=>current};</script></body></html>`;

test('scoped variants change one World shot, preserve global identity and freeze recording dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-scoped-'));
  const delivery = root + '-delivery';
  try {
    await writeFile(join(root, 'scene.html'), PAGE);
    await writeFile(join(root, 'red.txt'), 'red');
    await writeFile(join(root, 'blue.txt'), 'blue');
    const assets: Project['assets'] = [];
    for (const id of ['red', 'blue'])
      assets.push({
        id,
        revision: 1,
        path: `${id}.txt`,
        sha256: await hashFile(join(root, `${id}.txt`)),
        type: 'code',
        rights: { origin: 'original fixture', license: 'CC0-1.0', redistributable: true },
        simulated: false,
      });
    const initial: Project = {
      schemaVersion: 1,
      id: 'scoped',
      revision: 1,
      title: 'Scoped asset variants',
      soundTargets: [],
      direction: {
        intent: 'Change only the third camera Source, not global identity',
        looks: [{ id: 'main', description: 'fixture' }],
        transitions: [],
      },
      assets,
      bindings: { hero: 'red' },
      worlds: [
        {
          id: 'world',
          revision: 1,
          units: 'meters',
          coordinates: 'right-handed-y-up',
          fps: { numerator: 30, denominator: 1 },
          frames: 8,
          entities: [
            {
              id: 'entity',
              asset: 'red',
              transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
              state: {},
            },
          ],
          trajectories: [],
          cameras: [{ id: 'camera', position: [0, 1, -2], target: [0, 0, 0], fov: 50 }],
        },
      ],
      sources: [0, 1, 2].map((index): BrowserPictureSource => ({
        id: `world_${index}`,
        kind: 'browser',

        output: 'picture',

        world: { id: 'world', camera: 'camera', mode: 'drive', startFrame: 0 },
        entry: 'scene.html',
        resources: [],
        bindings: ['hero'],
        params: { index },
        seed: index,
        frames: 4,
      })),
      composition: {
        output: { width: 64, height: 48, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 },
        scenes: [{ id: 'scene', description: 'scene' }],
        shots: [0, 1, 2].map(index => ({
          id: `shot_${index}`,
          scene: 'scene',
          look: 'main',
          intent: 'coverage',
          targetFrames: 4,
        })),
        placements: [0, 1, 2].map(index => ({
          id: `edit_${index}`,
          shot: `shot_${index}`,
          source: `world_${index}`,
          inFrame: 0,
          outFrame: 4,
          startFrame: index * 4,
          audio: 'mute',
        })),
        transitions: [],
        audio: [],
      },
      imageDocuments: [],
      imageTargets: [],
    };
    initial.sources.push({
      id: 'interactive',
      kind: 'browser',
      output: 'picture',
      entry: 'scene.html',
      resources: [],
      bindings: ['hero'],
      bindingOverrides: { hero: 'blue' },
      params: {},
      seed: 0,
      frames: 4,
      world: { id: 'world', camera: 'camera', mode: 'define' },
    });
    await writeFile(join(root, 'project.json'), JSON.stringify(validateProject(initial)));
    const first = await buildProject(root);
    const changed = await loadProject(root);
    (changed.sources[2] as BrowserPictureSource).bindingOverrides = { hero: 'blue' };
    await saveProject(root, changed, changed.revision);
    const second = await buildProject(root);
    const worldOps = second.operations.filter(op => op.kind === 'browser');
    assert.equal(worldOps.filter(op => op.reused).length, 2);
    assert.equal(worldOps.filter(op => !op.reused).length, 1);
    assert.equal(second.operations.find(op => op.kind === 'mix-audio')!.reused, true);
    assert.equal(second.takes[0].id, first.takes[0].id);
    assert.equal(second.takes[1].id, first.takes[1].id);
    assert.notEqual(second.takes[2].id, first.takes[2].id);
    const saved = await loadProject(root);
    assert.deepEqual(saved.bindings, initial.bindings);
    assert.deepEqual(saved.worlds, initial.worlds);
    const selected = resolveWorldBinding(
      saved,
      { id: 'world', camera: 'camera', mode: 'drive', startFrame: 0 },
      saved.sources[2] as BrowserPictureSource,
    )!;
    assert.equal(selected.entities[0].asset, 'blue');
    const final = second.artifacts.find(artifact => artifact.id === second.result!.artifact)!;
    const raw = join(root, 'rgb.raw');
    await runCommand('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-i',
      join(root, final.path),
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      raw,
    ]);
    const rgb = await readFile(raw);
    const center = (frame: number) => [
      ...rgb.subarray(frame * 64 * 48 * 3 + (24 * 64 + 32) * 3, frame * 64 * 48 * 3 + (24 * 64 + 32) * 3 + 3),
    ];
    assert.ok(
      center(2)[0] > 200 && center(6)[0] > 200 && center(10)[2] > 200,
      'only the third actual rendered shot should change',
    );

    const recording = await recordPlayable(root, 'interactive', [
      { frame: 0, type: 'down', key: 'ArrowRight' },
      { frame: 2, type: 'up', key: 'ArrowRight' },
    ]);
    assert.deepEqual(recording.source.bindingOverrides, { hero: 'blue' });
    assert.equal(recording.source.world!.entities[0].asset, 'blue');
    assert.ok(recording.source.files.some(file => file.path === 'blue.txt'));
    assert.ok(!recording.source.files.some(file => file.path === 'red.txt'));
    const play = await loadProject(root);
    const code = play.sources.find(source => source.id === 'interactive') as BrowserPictureSource;
    play.sources = play.sources.map(source =>
      source.id === code.id ? { ...code, recording: `recordings/${recording.id}/session.json` } : source,
    );
    play.composition!.placements = [
      { id: 'play', shot: 'shot_0', source: code.id, inFrame: 0, outFrame: 4, startFrame: 0, audio: 'mute' },
    ];
    await saveProject(root, play, play.revision);
    const replay = await buildProject(root);
    assert.equal(replay.status, 'succeeded');
    await exportProject(root, delivery);
    assert.ok((await buildProject(delivery)).operations.every(op => op.reused));
    const bad = await loadProject(root);
    (bad.sources.find(source => source.id === 'interactive') as BrowserPictureSource).bindingOverrides = {
      hero: 'red',
    };
    await saveProject(root, bad, bad.revision);
    await assert.rejects(buildProject(root), /World changed since recording|signature does not match/);
    const ambiguous = structuredClone(initial);
    ambiguous.bindings.alias = 'red';
    const worldSource = ambiguous.sources[0] as BrowserPictureSource;
    worldSource.bindings.push('alias');
    worldSource.bindingOverrides = { hero: 'blue' };
    assert.throws(() => validateProject(ambiguous), /Ambiguous scoped asset/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(delivery, { recursive: true, force: true });
  }
});
