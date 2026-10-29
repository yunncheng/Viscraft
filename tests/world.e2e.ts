import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildProject } from '../src/build/build.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { hashFile } from '../src/shared/hash.js';
import { loadProject, saveProject, validateProject } from '../src/project/project.js';
import { sampleWorld } from '../src/backends/world/world.js';
import type { Asset, Project, BrowserPictureSource } from '../src/core/schema.js';
import { writeSignalAsset } from './audio-fixtures.js';

const PAGE = `<!doctype html><html><body style="margin:0"><canvas id="c"></canvas><script>
window.viscraft={async render(ctx){
 const w=window.__viscraftWorld;if(!w||w.id!=='shared')throw Error('missing shared state');
 const binding=ctx.bindings.hero;if(!binding||binding.id!==w.entities[0].asset)throw Error('missing entity asset');
 const data=await fetch(binding.url).then(r=>r.text());if(data!=='original sprite')throw Error('wrong frozen asset');
 const c=document.getElementById('c');c.width=ctx.width;c.height=ctx.height;const g=c.getContext('2d');
 g.fillStyle=w.camera.id==='wide'?'#001144':'#441100';g.fillRect(0,0,c.width,c.height);
 g.fillStyle='#ffffff';g.fillRect(w.entities[0].transform.position[0]*3+8,8,8,8);
}};</script></body></html>`;

function project(sha256: string, signal: Asset): Project {
  return {
    schemaVersion: 1,
    id: 'world-e2e',
    revision: 1,
    title: 'Shared World integration',
    soundTargets: [],
    direction: {
      intent: 'One action covered by two cameras',
      looks: [{ id: 'main', description: 'fixture' }],
      transitions: [],
    },
    assets: [
      signal,
      {
        id: 'hero',
        revision: 1,
        path: 'hero.txt',
        sha256,
        type: 'code',
        rights: { origin: 'original fixture', license: 'CC0-1.0', redistributable: true },
        simulated: false,
      },
    ],
    bindings: { hero: 'hero' },
    worlds: [
      {
        id: 'shared',
        revision: 1,
        units: 'meters',
        coordinates: 'right-handed-y-up',
        fps: { numerator: 30, denominator: 1 },
        frames: 12,
        entities: [
          {
            id: 'courier',
            asset: 'hero',
            transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
            state: {},
          },
        ],
        trajectories: [
          {
            id: 'route',
            entity: 'courier',
            keyframes: [
              { frame: 0, position: [0, 0, 0] },
              { frame: 11, position: [11, 0, 0] },
            ],
          },
        ],
        cameras: [
          { id: 'wide', position: [0, 2, -4], target: [0, 0, 0], fov: 50 },
          { id: 'low', position: [0, 1, -4], target: [0, 0, 0], fov: 60 },
        ],
      },
    ],
    sources: ['a', 'b'].map((id, i): BrowserPictureSource => ({
      id,
      kind: 'browser',

      output: 'picture',

      world: { id: 'shared', camera: i ? 'low' : 'wide', mode: 'drive', startFrame: i ? 4 : 0 },
      entry: 'world.html',
      resources: [],
      bindings: ['hero'],
      params: {},
      seed: 0,
      frames: 6,
    })),
    composition: {
      output: { width: 64, height: 48, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene', description: 'one shared action' }],
      shots: ['a', 'b'].map(id => ({ id, scene: 'scene', look: 'main', intent: 'coverage', targetFrames: 4 })),
      placements: ['a', 'b'].map((id, i) => ({
        id,
        shot: id,
        source: id,
        inFrame: 0,
        outFrame: 4,
        startFrame: i * 4,
        audio: 'mute',
      })),
      transitions: [],
      audio: [
        {
          id: 'bed',
          kind: 'asset',
          asset: signal.id,
          inSample: 0,
          startSample: 0,
          durationSamples: 12800,
          gain: 0.2,
          fadeInSamples: 0,
          fadeOutSamples: 0,
        },
      ],
    },
    imageDocuments: [],
    imageTargets: [],
  };
}

test('shared World produces normal Takes, selective camera edits, shared edits and portable reuse', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-world-e2e-'));
  const delivery = root + '-delivery';
  try {
    await writeFile(join(root, 'hero.txt'), 'original sprite');
    await writeFile(join(root, 'world.html'), PAGE);
    const signal = await writeSignalAsset(root, {
      id: 'signal',
      path: 'audio/signal.wav',
      sampleRate: 48000,
      channels: 2,
      samples: 12800,
    });
    const initial = project(await hashFile(join(root, 'hero.txt')), signal);
    validateProject(initial);
    await writeFile(join(root, 'project.json'), JSON.stringify(initial));
    const wide = sampleWorld(initial.worlds![0], 'wide', 4),
      low = sampleWorld(initial.worlds![0], 'low', 4);
    assert.deepEqual(wide.entities, low.entities);
    assert.notDeepEqual(wide.camera, low.camera);
    const first = await buildProject(root);
    assert.equal(first.status, 'succeeded');
    assert.equal(first.takes.length, 2);
    assert.ok(first.operations.filter(op => op.kind === 'browser').every(op => !op.reused));
    const final = first.artifacts.find(a => a.id === first.result!.artifact)!;
    assert.equal(final.media!.frames, 8);
    assert.ok(Math.abs(final.media!.audio!.duration - 8 / 30) <= 1 / 48000);
    assert.equal(first.result!.simulated, false);
    const frozen = JSON.parse(await readFile(join(root, `.viscraft/snapshots/${first.id}.project.json`), 'utf8'));
    assert.deepEqual(frozen.worlds, initial.worlds);
    const unchanged = await buildProject(root);
    assert.ok(unchanged.operations.every(op => op.reused));

    const cameraEdit = await loadProject(root);
    (cameraEdit.sources[1] as BrowserPictureSource).world!.camera = 'wide';
    await saveProject(root, cameraEdit, cameraEdit.revision);
    const recamera = await buildProject(root);
    assert.equal(recamera.operations.filter(op => op.kind === 'browser' && !op.reused).length, 1);
    assert.equal(recamera.operations.find(op => op.kind === 'mix-audio')!.reused, true);
    assert.equal(recamera.takes[0].id, first.takes[0].id);
    assert.notEqual(recamera.takes[1].id, first.takes[1].id);

    const edit = await loadProject(root);
    edit.composition!.placements = edit.composition!.placements.map((p, i) => {
      const { source: _source, ...rest } = p;
      return { ...rest, take: recamera.takes[i].id, inFrame: 1, outFrame: 5 };
    });
    await saveProject(root, edit, edit.revision);
    const recut = await buildProject(root);
    assert.ok(
      !recut.operations.some(op => op.kind === 'browser'),
      'accepted Take editing must not sample the World again',
    );
    assert.equal(recut.operations.find(op => op.kind === 'mix-audio')!.reused, true);

    const sharedEdit = await loadProject(root);
    sharedEdit.worlds![0].revision++;
    sharedEdit.worlds![0].trajectories[0].keyframes[1].position[0] = 8;
    sharedEdit.composition!.placements = initial.composition!.placements;
    await saveProject(root, sharedEdit, sharedEdit.revision);
    const changed = await buildProject(root);
    assert.equal(
      changed.operations.filter(op => op.kind === 'browser' && !op.reused).length,
      2,
      'shared spatial edit affects both actual dependents',
    );
    assert.equal(changed.operations.find(op => op.kind === 'mix-audio')!.reused, true);
    await exportProject(root, delivery);
    assert.deepEqual((await loadProject(delivery)).worlds, sharedEdit.worlds);
    const reopened = await buildProject(delivery);
    assert.ok(reopened.operations.every(op => op.reused));

    const invalid = await loadProject(root);
    invalid.worlds![0].trajectories[0].keyframes[1].frame = 0;
    const priorResult = await readFile(join(root, '.viscraft/result.json'), 'utf8');
    await assert.rejects(saveProject(root, invalid, invalid.revision), /keyframes must increase/);
    assert.equal(await readFile(join(root, '.viscraft/result.json'), 'utf8'), priorResult);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(delivery, { recursive: true, force: true });
  }
});
