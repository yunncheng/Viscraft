import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildProject } from '../src/build/build.js';
import { loadProject, saveProject, validateProject } from '../src/project/project.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { simulatedStatus } from '../src/backends/providers/simulated.js';
import type { Project } from '../src/core/schema.js';
import { makeSignalAsset } from './audio-fixtures.js';

const SIGNAL = makeSignalAsset({
  id: 'bed',
  path: 'bed.wav',
  sampleRate: 48000,
  channels: 2,
  samples: 38400,
  frequency: 440,
});

test('one Run produces explicit candidate Takes with handles while leaving the edit unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-candidates-'));
  const delivery = root + '-delivery';
  try {
    const project: Project = {
      schemaVersion: 1,
      id: 'candidate-fixture',
      revision: 1,
      title: 'SIMULATED candidate control chain',
      soundTargets: [],
      direction: {
        intent: 'Explicit test-only candidate comparison, no model quality claim',
        looks: [{ id: 'look', description: 'Test pattern' }],
        transitions: [],
      },
      assets: [SIGNAL.asset],
      bindings: {},
      sources: ['a', 'b'].map((id, index) => ({
        id,
        kind: 'simulated' as const,
        prompt: `SIMULATED candidate ${id}`,
        frames: 45,
        seed: index,
        attempt: `attempt-${id}`,
        behavior: 'success' as const,
      })),
      composition: {
        output: { width: 96, height: 64, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 },
        scenes: [{ id: 'scene', description: 'One shot, two candidates' }],
        shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: 'Select a middle portion', targetFrames: 24 }],
        placements: [{ id: 'edit', shot: 'shot', source: 'a', inFrame: 6, outFrame: 30, startFrame: 0, audio: 'mute' }],
        transitions: [],
        audio: [
          {
            id: 'bed',
            kind: 'asset',
            asset: 'bed',
            inSample: 0,
            startSample: 0,
            durationSamples: 38400,
            gain: 0.2,
            fadeInSamples: 0,
            fadeOutSamples: 800,
          },
        ],
      },
      imageDocuments: [],
      imageTargets: [],
    };
    await writeFile(join(root, 'project.json'), JSON.stringify(validateProject(project)));
    await writeFile(join(root, SIGNAL.asset.path), SIGNAL.bytes);
    const before = await readFile(join(root, 'project.json'), 'utf8');
    const candidates = [{ shot: 'shot', sources: ['a', 'b'] }];
    const first = await buildProject(root, { candidates });
    assert.deepEqual(first.plan.candidates, candidates);
    assert.equal(first.takes.length, 2);
    assert.ok(first.takes.every(take => take.medium === 'picture' && take.frames === 60 && take.simulated));
    assert.equal(await readFile(join(root, 'project.json'), 'utf8'), before);
    const final = first.artifacts.find(artifact => artifact.id === first.result!.artifact)!;
    assert.equal(final.media!.frames, 24, 'candidate duration is not final-shot duration');
    const candidateExport = root + '-candidates';
    try {
      await exportProject(root, candidateExport);
      const manifest = JSON.parse(await readFile(join(candidateExport, '.viscraft/portable-manifest.json'), 'utf8'));
      for (const take of first.takes)
        assert.ok(manifest.artifacts.includes(take.artifact), 'unselected active candidates remain available');
    } finally {
      await rm(candidateExport, { recursive: true, force: true });
    }
    const second = await buildProject(root, { candidates });
    assert.ok(second.operations.every(operation => operation.reused));
    assert.equal(
      ((await simulatedStatus(root)) as Array<{ submitted: number }>).reduce((total, job) => total + job.submitted, 0),
      2,
    );
    const edit = await loadProject(root);
    const take = first.takes.find(take => take.source === 'b')!;
    edit.composition!.placements = [
      { id: 'edit', shot: 'shot', take: take.id, inFrame: 12, outFrame: 36, startFrame: 0, audio: 'mute' },
    ];
    await saveProject(root, edit, edit.revision);
    const selected = await buildProject(root);
    assert.equal(selected.takes[0].id, take.id);
    assert.ok(!selected.operations.some(operation => operation.kind === 'simulated'));
    assert.equal(selected.operations.find(operation => operation.kind === 'mix-audio')!.reused, true);
    await exportProject(root, delivery);
    assert.ok((await buildProject(delivery)).operations.every(operation => operation.reused));
    await assert.rejects(buildProject(root, { candidates: [{ shot: 'missing', sources: ['a'] }] }), /Candidate plan/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(delivery, { recursive: true, force: true });
  }
});
