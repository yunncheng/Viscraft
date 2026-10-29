import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { buildProject } from '../src/build/build.js';
import { reviewBuild } from '../src/operations/analysis/review.js';
import { framesToSamples } from '../src/core/time.js';
import type { BuildRecord, OutputSettings, Project } from '../src/core/schema.js';
import { resolveProjectPath } from '../src/shared/fs.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { validateProject } from '../src/project/project.js';
import { writeSignalAsset } from './audio-fixtures.js';

const WIDTH = 64;
const HEIGHT = 48;
const FPS = { numerator: 30, denominator: 1 };
const OUTPUT: OutputSettings = { width: WIDTH, height: HEIGHT, fps: FPS, sampleRate: 48000, channels: 2 };
const SAMPLES_PER_FRAME = framesToSamples(1, FPS, OUTPUT.sampleRate, 'ceil'); // 1600

async function ffmpeg(args: string[]): Promise<void> {
  await runCommand('ffmpeg', [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-loglevel',
    'error',
    '-threads',
    '2',
    '-filter_threads',
    '1',
    ...args,
  ]);
}

async function tempDir(): Promise<string> {
  return fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-beats-e2e-'));
}

/**
 * A two-placement dissolve edit: `p1` occupies [0,20) and `p2` occupies
 * [18,38), so the content ends at frame 38 with a `[18,20)` dissolve. The beat
 * grid declares onsets at frames 10 (sample 16000) and 18 (sample 28800).
 */
async function authorProject(root: string, beats?: Array<{ id: string; sample: number }>): Promise<void> {
  const fixture = nodePath.join(root, 'plate.mp4');
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `color=c=0xffffff:size=${WIDTH}x${HEIGHT}:rate=30`,
    '-frames:v',
    '60',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-r',
    '30',
    '-an',
    fixture,
  ]);
  const durationSamples = framesToSamples(38, FPS, OUTPUT.sampleRate, 'ceil');
  const signal = await writeSignalAsset(root, {
    id: 'signal',
    path: 'audio/signal.wav',
    sampleRate: OUTPUT.sampleRate,
    channels: 2,
    samples: durationSamples,
  });
  const project: Project = validateProject({
    schemaVersion: 1,
    id: 'beats_work',
    revision: 1,
    title: 'Beat grid work',
    direction: {
      intent: 'Cuts against a declared beat grid',
      looks: [{ id: 'flat', description: 'Flat' }],
      transitions: [],
    },
    assets: [
      signal,
      {
        id: 'plate',
        revision: 1,
        path: 'plate.mp4',
        sha256: await hashFile(fixture),
        type: 'video',
        rights: { origin: 'Original FFmpeg fixture', license: 'CC0-1.0', redistributable: true },
        simulated: false,
      },
    ],
    bindings: {},
    sources: [],
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: 'Flat plate' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'flat', intent: 'Plate', targetFrames: 20 }],
      placements: [
        { id: 'p1', shot: 'shot', asset: 'plate', inFrame: 0, outFrame: 20, startFrame: 0, audio: 'mute' },
        { id: 'p2', shot: 'shot', asset: 'plate', inFrame: 0, outFrame: 20, startFrame: 18, audio: 'mute' },
      ],
      transitions: [{ from: 'p1', to: 'p2', kind: 'dissolve', startFrame: 18, endFrame: 20 }],
      audio: [
        {
          id: 'clip',
          kind: 'asset',
          asset: signal.id,
          inSample: 0,
          startSample: 0,
          durationSamples,
          gain: 0.5,
          fadeInSamples: 480,
          fadeOutSamples: 480,
        },
      ],
      ...(beats ? { beats } : {}),
    },
  });
  await fs.writeFile(nodePath.join(root, 'project.json'), JSON.stringify(project));
}

async function resultFile(root: string, build: BuildRecord): Promise<string> {
  const artifact = build.artifacts.find(item => item.id === build.result!.artifact)!;
  assert.ok(artifact, 'build must record a delivered result artifact');
  return resolveProjectPath(root, artifact.path);
}

test('a declared beat grid changes no media bytes and is invalidation-only time authority', async () => {
  const plain = await tempDir();
  const withBeats = await tempDir();
  const twin = await tempDir();
  const grid = [
    { id: 'b10', sample: 10 * SAMPLES_PER_FRAME },
    { id: 'b18', sample: 18 * SAMPLES_PER_FRAME },
  ];
  try {
    await authorProject(plain);
    const buildPlain = await buildProject(plain);
    assert.equal(buildPlain.status, 'succeeded');
    const plainMovie = await resultFile(plain, buildPlain);

    await authorProject(withBeats, grid);
    const buildBeats = await buildProject(withBeats);
    assert.equal(buildBeats.status, 'succeeded');
    const beatsMovie = await resultFile(withBeats, buildBeats);
    assert.equal(
      await hashFile(beatsMovie),
      await hashFile(plainMovie),
      'adding a beat grid must not change the delivered media bytes',
    );

    // The grid is time authority: it changes operation keys (invalidation) even
    // though the bytes are identical. compose-video and the audio mix re-run.
    const compose = buildBeats.operations.find(operation => operation.kind === 'compose-video')!;
    const mix = buildBeats.operations.find(operation => operation.kind === 'mix-audio')!;
    assert.equal(compose.reused, false, 'a beat edit must invalidate the cached compose-video');
    assert.equal(mix.reused, false, 'a beat edit must invalidate the cached audio mix');
    const plainCompose = buildPlain.operations.find(operation => operation.kind === 'compose-video')!;
    assert.notEqual(compose.key, plainCompose.key, 'the grid must participate in the compose-video key');

    // Determinism: the identical grid project in a fresh root yields identical bytes.
    await authorProject(twin, grid);
    const buildTwin = await buildProject(twin);
    assert.equal(
      await hashFile(await resultFile(twin, buildTwin)),
      await hashFile(beatsMovie),
      'a beat-grid build must be deterministic across runs',
    );
  } finally {
    await fs.rm(plain, { recursive: true, force: true });
    await fs.rm(withBeats, { recursive: true, force: true });
    await fs.rm(twin, { recursive: true, force: true });
  }
});

test("review reports each boundary's nearest-beat distance as a fact, including a cut deliberately off the grid", async () => {
  const root = await tempDir();
  try {
    const grid = [
      { id: 'b10', sample: 10 * SAMPLES_PER_FRAME },
      { id: 'b18', sample: 18 * SAMPLES_PER_FRAME },
    ];
    await authorProject(root, grid);
    const build = await buildProject(root);
    assert.equal(build.status, 'succeeded');
    const review = await reviewBuild(root, build.id);
    const report = JSON.parse(await fs.readFile(nodePath.join(root, review.report), 'utf8'));

    assert.equal(report.timeline.expectedFrames, 38, 'no explicit length: the programme is the content end');
    assert.deepEqual(report.beats.declared, [
      { id: 'b10', sample: 16000, frame: 10 },
      { id: 'b18', sample: 28800, frame: 18 },
    ]);
    assert.equal(report.beats.toleranceFrames, 1);

    // Boundaries: p1 start@0, p2 start@18, dissolve start@18, dissolve end@20.
    const byKey = new Map<string, Record<string, unknown>>();
    for (const boundary of report.beats.boundaries) {
      byKey.set(`${boundary.kind}:${boundary.placement ?? boundary.from}`, boundary);
    }
    assert.equal(report.beats.boundaries.length, 4);

    const p1 = byKey.get('placement-start:p1')!;
    assert.equal(p1.frame, 0);
    assert.equal(p1.sample, 0);
    assert.deepEqual(p1.nearestBeat, { id: 'b10', sample: 16000 });
    assert.equal(p1.distanceSamples, 16000);
    assert.equal(p1.distanceFrames, 10);
    assert.equal(p1.onBeat, false);

    const p2 = byKey.get('placement-start:p2')!;
    assert.equal(p2.frame, 18);
    assert.deepEqual(p2.nearestBeat, { id: 'b18', sample: 28800 });
    assert.equal(p2.distanceSamples, 0);
    assert.equal(p2.onBeat, true);

    // The dissolve END at frame 20 is deliberately 2 frames off the declared grid.
    const end = byKey.get('transition-end:p1')!;
    assert.equal(end.kind, 'transition-end');
    assert.equal(end.frame, 20);
    assert.equal(end.sample, 20 * SAMPLES_PER_FRAME);
    assert.deepEqual(end.nearestBeat, { id: 'b18', sample: 28800 });
    assert.equal(end.distanceSamples, 2 * SAMPLES_PER_FRAME);
    assert.equal(end.distanceFrames, 2);
    assert.equal(end.onBeat, false);

    assert.deepEqual(report.beats.summary, { boundaries: 4, onBeat: 2, offBeat: 2, note: report.beats.summary.note });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('review without a beat grid still reports boundaries and null distances', async () => {
  const root = await tempDir();
  try {
    await authorProject(root);
    const build = await buildProject(root);
    const review = await reviewBuild(root, build.id);
    const report = JSON.parse(await fs.readFile(nodePath.join(root, review.report), 'utf8'));
    assert.deepEqual(report.beats.declared, []);
    assert.equal(report.beats.boundaries.length, 4);
    for (const boundary of report.beats.boundaries) {
      assert.equal(boundary.nearestBeat, null);
      assert.equal(boundary.distanceSamples, null);
      assert.equal(boundary.onBeat, false);
    }
    assert.deepEqual(report.beats.summary, { boundaries: 4, onBeat: 0, offBeat: 4, note: report.beats.summary.note });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
