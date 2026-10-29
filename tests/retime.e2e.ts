import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildProject } from '../src/build/build.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { reviewBuild } from '../src/operations/analysis/review.js';
import { loadProject, saveProject, validateProject } from '../src/project/project.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import type { Project } from '../src/core/schema.js';

test('explicit retiming preserves accepted Takes, source sound, review mapping and portable reuse', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-retime-e2e-'));
  const delivery = root + '-delivery';
  try {
    const media = join(root, 'source.mp4');
    await runCommand('ffmpeg', [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-filter_threads',
      '1',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=64x48:rate=10:duration=3',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=3',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-ac',
      '2',
      '-threads',
      '2',
      media,
    ]);
    const project: Project = {
      schemaVersion: 1,
      id: 'retime-e2e',
      revision: 1,
      title: 'Retime source audio',
      soundTargets: [],
      direction: {
        intent: 'Same accepted clip slowed then shortened without changing pitch',
        looks: [{ id: 'main', description: 'fixture' }],
        transitions: [],
      },
      assets: [
        {
          id: 'clip',
          revision: 1,
          path: 'source.mp4',
          sha256: await hashFile(media),
          type: 'video',
          rights: { origin: 'original test pattern and tone', license: 'CC0-1.0', redistributable: true },
          simulated: false,
        },
      ],
      bindings: {},
      sources: [],
      composition: {
        output: { width: 64, height: 48, fps: { numerator: 10, denominator: 1 }, sampleRate: 48000, channels: 2 },
        scenes: [{ id: 'scene', description: 'scene' }],
        shots: [{ id: 'shot', scene: 'scene', look: 'main', intent: 'retime', targetFrames: 20 }],
        placements: [
          {
            id: 'edit',
            shot: 'shot',
            asset: 'clip',
            inFrame: 5,
            outFrame: 15,
            startFrame: 0,
            durationFrames: 20,
            audio: 'keep',
          },
        ],
        transitions: [],
        audio: [],
      },
      imageDocuments: [],
      imageTargets: [],
    };
    await writeFile(join(root, 'project.json'), JSON.stringify(validateProject(project)));
    const first = await buildProject(root);
    const originalTake = first.takes[0];
    assert.ok(first.operations.some(op => op.kind === 'retime-clip'));
    const final = first.artifacts.find(a => a.id === first.result!.artifact)!;
    assert.equal(final.media!.frames, 20);
    assert.equal(final.media!.audio!.duration, 2);
    const review = await reviewBuild(root, first.id);
    const report = JSON.parse(await readFile(join(root, review.report), 'utf8'));
    assert.deepEqual(
      report.timeline.contactSheetCells.map((cell: { frame: number }) => cell.frame),
      [0, 9, 19],
    );
    assert.equal(report.timeline.placements[0].inFrame, 5);
    assert.equal(report.timeline.placements[0].outFrame, 15);
    assert.equal(report.timeline.placements[0].durationFrames, 20);
    const pcmPath = join(root, 'final.f32le');
    await runCommand('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-i',
      join(root, final.path),
      '-map',
      '0:a:0',
      '-f',
      'f32le',
      '-ac',
      '1',
      pcmPath,
    ]);
    const pcm = await readFile(pcmPath);
    let rising = 0,
      positive = false;
    for (let i = 4800; i < 90000; i++) {
      const value = pcm.readFloatLE(i * 4);
      if (!positive && value > 0.02) {
        rising++;
        positive = true;
      }
      if (value < -0.02) positive = false;
    }
    const hz = rising / ((90000 - 4800) / 48000);
    assert.ok(hz > 420 && hz < 460, `source audio should keep its 440Hz pitch, measured ${hz}`);
    const unchanged = await buildProject(root);
    assert.ok(unchanged.operations.every(op => op.reused));
    const edit = await loadProject(root);
    const { source: _source, asset: _asset, framing: _framing, ...placement } = edit.composition!.placements[0];
    edit.composition!.placements = [{ ...placement, take: originalTake.id, durationFrames: 5 }];
    await saveProject(root, edit, edit.revision);
    const shortened = await buildProject(root);
    assert.ok(
      !shortened.operations.some(op => op.kind === 'normalize-media'),
      'selected Take retiming must not re-normalize source media',
    );
    assert.equal(shortened.takes[0].id, originalTake.id);
    assert.equal(shortened.artifacts.find(a => a.id === shortened.result!.artifact)!.media!.frames, 5);
    await exportProject(root, delivery);
    const moved = await buildProject(delivery);
    assert.ok(moved.operations.every(op => op.reused));
    const prior = await readFile(join(root, '.viscraft/result.json'), 'utf8');
    const bad = await loadProject(root);
    bad.composition!.placements[0].outFrame = 100;
    await saveProject(root, bad, bad.revision);
    await assert.rejects(buildProject(root), /reads frames \[5, 100\) beyond Take/);
    assert.equal(await readFile(join(root, '.viscraft/result.json'), 'utf8'), prior);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(delivery, { recursive: true, force: true });
  }
});
