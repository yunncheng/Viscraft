import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildProject } from '../src/build/build.js';
import { loadProject, saveProject, validateProject } from '../src/project/project.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { reviewBuild } from '../src/operations/analysis/review.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import type { Project } from '../src/core/schema.js';
import { writeSignalAsset } from './audio-fixtures.js';

const PAGE = `<!doctype html><html><body style="margin:0"><canvas id="c"></canvas><script>window.viscraft={render(ctx){const c=document.getElementById('c');c.width=ctx.width;c.height=ctx.height;const g=c.getContext('2d');g.fillStyle='#002244';g.fillRect(0,0,c.width,c.height);}};</script></body></html>`;

test('picture layer edits reuse base Takes and sound, keep provenance and portable layer-only Takes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-layer-e2e-'));
  const delivery = root + '-delivery';
  try {
    await writeFile(join(root, 'base.html'), PAGE);
    // Timeline/reuse assertions need raster pixels, not an optional SVG decoder.
    await runCommand('ffmpeg', [
      '-v',
      'error',
      '-nostdin',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=16x16',
      '-frames:v',
      '1',
      '-threads',
      '1',
      join(root, 'panel.png'),
    ]);
    const signal = await writeSignalAsset(root, {
      id: 'signal',
      path: 'audio/signal.wav',
      sampleRate: 48000,
      channels: 2,
      samples: 12800,
    });
    const initial: Project = {
      schemaVersion: 1,
      id: 'layers-e2e',
      revision: 1,
      title: 'Layered work',
      soundTargets: [],
      direction: {
        intent: 'Timed real image panel over independently authored motion',
        looks: [{ id: 'main', description: 'fixture' }],
        transitions: [],
      },
      assets: [
        signal,
        {
          id: 'panel',
          revision: 1,
          path: 'panel.png',
          sha256: await hashFile(join(root, 'panel.png')),
          type: 'image',
          rights: { origin: 'original fixture', license: 'CC0-1.0', redistributable: true },
          simulated: true,
        },
      ],
      bindings: {},
      sources: [
        {
          id: 'base',
          kind: 'browser',
          output: 'picture',
          entry: 'base.html',
          resources: [],
          bindings: [],
          params: {},
          seed: 0,
          frames: 8,
        },
      ],
      composition: {
        output: { width: 64, height: 48, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 },
        scenes: [{ id: 'scene', description: 'scene' }],
        shots: [{ id: 'shot', scene: 'scene', look: 'main', intent: 'picture overlay', targetFrames: 8 }],
        placements: [
          { id: 'main', shot: 'shot', source: 'base', inFrame: 0, outFrame: 8, startFrame: 0, audio: 'mute' },
        ],
        transitions: [],
        layers: [
          {
            id: 'panel',
            asset: 'panel',
            framing: { fit: 'contain', background: '#000000' },
            inFrame: 0,
            outFrame: 4,
            startFrame: 2,
            x: 16,
            y: 8,
            width: 32,
            height: 24,
            opacity: 1,
          },
        ],
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
    await writeFile(join(root, 'project.json'), JSON.stringify(validateProject(initial)));
    const first = await buildProject(root);
    assert.equal(first.takes.length, 2);
    assert.equal(
      first.artifacts.find(a => a.operation === 'compose-video')!.simulated,
      false,
      'base remains independent of the simulated layer',
    );
    assert.equal(first.artifacts.find(a => a.operation === 'overlay-picture-layers')!.simulated, true);
    assert.equal(first.result!.simulated, true, 'layer provenance must reach the final Result');
    const final = first.artifacts.find(a => a.id === first.result!.artifact)!;
    const raw = join(root, 'actual.rgb');
    await runCommand('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-i',
      join(root, final.path),
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      raw,
    ]);
    const bytes = await readFile(raw);
    const pixel = (frame: number) =>
      bytes.subarray(frame * 64 * 48 * 3 + (20 * 64 + 32) * 3, frame * 64 * 48 * 3 + (20 * 64 + 32) * 3 + 3);
    assert.ok(pixel(1)[0] < 30);
    assert.ok(pixel(2)[0] > 200 && pixel(5)[0] > 200);
    assert.ok(pixel(6)[0] < 30);
    const review = await reviewBuild(root, first.id);
    const report = JSON.parse(await readFile(join(root, review.report), 'utf8'));
    assert.equal(report.timeline.layers.length, 1);
    assert.deepEqual(report.timeline.layers[0].sampledFrames, [1, 2, 5, 6]);

    const changed = await loadProject(root);
    const panelTake = first.takes.find(take => take.asset === 'panel')!;
    changed.composition!.layers = [
      {
        ...initial.composition!.layers![0],
        source: undefined,
        asset: undefined,
        framing: undefined,
        take: panelTake.id,
        x: 24,
        width: 24,
      },
    ];
    await saveProject(root, changed, changed.revision);
    const second = await buildProject(root);
    assert.equal(second.operations.find(op => op.kind === 'browser')!.reused, true);
    assert.equal(second.operations.find(op => op.kind === 'compose-video')!.reused, true);
    assert.equal(second.operations.find(op => op.kind === 'mix-audio')!.reused, true);
    assert.equal(second.operations.find(op => op.kind === 'overlay-picture-layers')!.reused, false);
    assert.ok(
      !second.operations.some(op => op.kind === 'normalize-still'),
      'selected layer-only Take must not be re-rendered',
    );
    await exportProject(root, delivery);
    const reopened = await buildProject(delivery);
    assert.ok(reopened.operations.every(op => op.reused));
    assert.equal(reopened.result!.simulated, true);
    const invalid = await loadProject(root);
    invalid.composition!.layers![0].outFrame = 100;
    await assert.rejects(saveProject(root, invalid, invalid.revision), /Picture layer/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(delivery, { recursive: true, force: true });
  }
});
