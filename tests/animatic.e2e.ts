import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildProject } from '../src/build/build.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { loadProject, saveProject, validateProject } from '../src/project/project.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import type { Asset, Project } from '../src/core/schema.js';
import { writeSignalAsset } from './audio-fixtures.js';

function authoredProject(sha256: string, signal: Asset): Project {
  return {
    schemaVersion: 1,
    id: 'animatic',
    revision: 1,
    title: 'Hero-frame animatic',
    soundTargets: [],
    direction: {
      intent: 'Approve timed image composition and sound before motion',
      looks: [{ id: 'main', description: 'red hero' }],
      transitions: [],
    },
    assets: [
      signal,
      {
        id: 'hero',
        revision: 1,
        path: 'hero.png',
        sha256,
        type: 'image',
        rights: { origin: 'original fixture', license: 'CC0-1.0', redistributable: true },
        simulated: false,
      },
    ],
    bindings: {},
    sources: [],
    composition: {
      output: { width: 64, height: 48, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene', description: 'hero study' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'main', intent: 'frame-first', targetFrames: 8 }],
      placements: [
        {
          id: 'edit',
          shot: 'shot',
          asset: 'hero',
          framing: { fit: 'contain', background: '#000000' },
          inFrame: 0,
          outFrame: 8,
          startFrame: 0,
          audio: 'mute',
          durationFrames: 8,
        },
      ],
      transitions: [],
      audio: [
        {
          id: 'bed',
          kind: 'asset',
          asset: signal.id,
          inSample: 0,
          gain: 0.2,
          startSample: 0,
          durationSamples: 12800,
          fadeInSamples: 0,
          fadeOutSamples: 0,
          automation: [
            { sample: 0, gain: 1 },
            { sample: 2000, gain: 1 },
            { sample: 4000, gain: 0.2 },
            { sample: 8000, gain: 0.2 },
            { sample: 10000, gain: 1 },
          ],
        },
      ],
    },
    imageDocuments: [],
    imageTargets: [],
  };
}

test('approved image produces sounded animatic Takes, edit reuse and portable delivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-animatic-'));
  const delivery = root + '-delivery';
  try {
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
      join(root, 'hero.png'),
    ]);
    const signal = await writeSignalAsset(root, {
      id: 'signal',
      path: 'audio/signal.wav',
      sampleRate: 48000,
      channels: 2,
      samples: 12800,
    });
    const initial = authoredProject(await hashFile(join(root, 'hero.png')), signal);
    validateProject(initial);
    await writeFile(join(root, 'project.json'), JSON.stringify(initial));
    const first = await buildProject(root);
    assert.equal(first.status, 'succeeded');
    assert.equal(first.result!.simulated, false);
    const firstTake = first.takes[0];
    if (firstTake.medium !== 'picture') assert.fail('the animatic Take must be a picture Take');
    assert.equal(firstTake.frames, 8);
    assert.ok(first.operations.some(op => op.kind === 'normalize-still'));
    const final = first.artifacts.find(a => a.id === first.result!.artifact)!;
    const pcmPath = join(root, 'mix.f32le');
    const rawPath = join(root, 'picture.rgb');
    await runCommand('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-i',
      join(root, final.path),
      '-frames:v',
      '1',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      rawPath,
    ]);
    const rgb = await readFile(rawPath);
    const pixel = (x: number, y: number) => [...rgb.subarray((y * 64 + x) * 3, (y * 64 + x) * 3 + 3)];
    assert.ok(pixel(32, 24)[0] > 200, 'approved hero pixels must be visible');
    assert.ok(
      pixel(0, 24).every(channel => channel < 20),
      'contain must retain authored background bars',
    );
    const mixed = first.artifacts.find(a => a.operation === 'mix-audio')!;
    await runCommand('ffmpeg', ['-v', 'error', '-y', '-i', join(root, mixed.path), '-f', 'f32le', pcmPath]);
    const pcm = await readFile(pcmPath);
    const rms = (start: number) => {
      let energy = 0;
      for (let i = start; i < start + 1000; i++) energy += pcm.readFloatLE(i * 8) ** 2;
      return Math.sqrt(energy / 1000);
    };
    assert.ok(rms(5000) < rms(500) * 0.25, 'authored ducking must change the actual soundtrack');
    const unchanged = await buildProject(root);
    assert.ok(unchanged.operations.every(op => op.reused));
    const audioEdit = await loadProject(root);
    audioEdit.composition!.audio[0].automation![2].gain = 0.4;
    await saveProject(root, audioEdit, audioEdit.revision);
    const remix = await buildProject(root);
    assert.equal(remix.operations.find(op => op.kind === 'normalize-still')!.reused, true);
    assert.equal(remix.operations.find(op => op.kind === 'compose-video')!.reused, true);
    assert.equal(remix.operations.find(op => op.kind === 'mix-audio')!.reused, false);
    const reframed = await loadProject(root);
    reframed.composition!.placements[0].framing = { fit: 'cover', background: '#000000' };
    await saveProject(root, reframed, reframed.revision);
    const cover = await buildProject(root);
    assert.equal(cover.operations.find(op => op.kind === 'normalize-still')!.reused, false);
    assert.equal(cover.operations.find(op => op.kind === 'mix-audio')!.reused, true);
    await exportProject(root, delivery);
    const moved = await buildProject(delivery);
    assert.ok(moved.operations.every(op => op.reused));
    await writeFile(join(root, 'hero.png'), 'broken image');
    const recovered = await buildProject(root);
    assert.ok(
      recovered.operations.every(op => op.reused),
      'known verified bytes in the content store preserve reuse',
    );
    assert.equal(recovered.result!.artifact, cover.result!.artifact);
    assert.equal(
      await readFile(join(root, 'hero.png'), 'utf8'),
      'broken image',
      'recovery never rewrites author bytes',
    );
    await assert.rejects(exportProject(root, delivery + '-damaged-author'), /authored.*unavailable|hash-mismatch/i);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(delivery, { recursive: true, force: true });
  }
});
