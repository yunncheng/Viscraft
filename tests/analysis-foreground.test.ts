// Tests for the reference foreground-segmentation capability.
//
// Fixtures are original, synthetically authored 8-bit grayscale frames (no
// third-party media): a mid-gray static background with a bright moving block
// (plus a smaller one), losslessly encoded with FFV1/gray so decoded gray levels
// round-trip exactly. Frames 5..7 draw no foreground at all, so the report must
// show a real three-frame gap rather than a fabricated position.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { analyzeReferenceForeground } from '../src/operations/analysis/reference-foreground.js';
import { ProjectSchema } from '../src/core/schema.js';
import type { Fps, Project } from '../src/core/schema.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { ptsToFrames } from '../src/core/time.js';
import { loadProject } from '../src/project/project.js';

const WIDTH = 48;
const HEIGHT = 36;
const FRAMES = 12;
const OCCLUDED = new Set([5, 6, 7]);
const BACKGROUND = 60;
const FOREGROUND = 220;
const BIG_SIZE = 6;
const SMALL_SIZE = 2;

function bigPosition(frame: number): { x: number; y: number } {
  return { x: 2 + frame * 3, y: 4 + frame };
}
function smallPosition(frame: number): { x: number; y: number } {
  return { x: 40 - frame * 2, y: 26 };
}

function fill(buffer: Buffer, x0: number, y0: number, size: number, value: number): void {
  for (let y = y0; y < y0 + size; y++) {
    for (let x = x0; x < x0 + size; x++) buffer[y * WIDTH + x] = value;
  }
}

/** Pack grayscale frames; occluded frames carry only the background. */
function rawFrames(): Buffer {
  const buffer = Buffer.alloc(WIDTH * HEIGHT * FRAMES, BACKGROUND);
  for (let frame = 0; frame < FRAMES; frame++) {
    if (OCCLUDED.has(frame)) continue;
    const base = frame * WIDTH * HEIGHT;
    const region = buffer.subarray(base, base + WIDTH * HEIGHT);
    const big = bigPosition(frame);
    const small = smallPosition(frame);
    fill(region, big.x, big.y, BIG_SIZE, FOREGROUND);
    fill(region, small.x, small.y, SMALL_SIZE, FOREGROUND);
  }
  return buffer;
}

async function tempDir(): Promise<string> {
  return fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-reference-foreground-test-'));
}

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

function makeProject(fps: Fps = { numerator: 10, denominator: 1 }): Project {
  const frames = 25;
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'ref_foreground_project',
    revision: 1,
    title: 'Reference foreground test',
    direction: { intent: 'test', looks: [{ id: 'look_main', description: 'main' }], transitions: [] },
    assets: [],
    bindings: {},
    sources: [
      { id: 'src_sim', kind: 'simulated', prompt: 'test', frames, seed: 0, attempt: 'attempt_1', behavior: 'success' },
    ],
    composition: {
      output: { width: 160, height: 120, fps, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene_1', description: 'scene' }],
      shots: [{ id: 'shot_1', scene: 'scene_1', look: 'look_main', intent: 'shot', targetFrames: frames }],
      placements: [
        {
          id: 'place_1',
          shot: 'shot_1',
          source: 'src_sim',
          inFrame: 0,
          outFrame: frames,
          startFrame: 0,
          audio: 'mute',
        },
      ],
      transitions: [],
      audio: [],
    },
  });
}

async function writeProject(root: string, project: Project): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(nodePath.join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
}

async function makeFixture(root: string): Promise<string> {
  const refs = nodePath.join(root, 'refs');
  await fs.mkdir(refs, { recursive: true });
  const rawPath = nodePath.join(refs, 'moving.gray');
  const out = nodePath.join(refs, 'moving.mkv');
  await fs.writeFile(rawPath, rawFrames());
  await ffmpeg([
    '-f',
    'rawvideo',
    '-pix_fmt',
    'gray',
    '-s',
    `${WIDTH}x${HEIGHT}`,
    '-r',
    '10',
    '-i',
    rawPath,
    '-c:v',
    'ffv1',
    '-pix_fmt',
    'gray',
    '-f',
    'matroska',
    out,
  ]);
  await fs.rm(rawPath, { force: true });
  return out;
}

test('analyzeReferenceForeground segments moving foreground and reports a real gap, not a fabricated blob', async () => {
  const root = await tempDir();
  try {
    await writeProject(root, makeProject());
    const video = await makeFixture(root);
    const projectBefore = await fs.readFile(nodePath.join(root, 'project.json'));
    const videoHash = await hashFile(video);

    const report = await analyzeReferenceForeground(root, 'refs/moving.mkv', {});

    assert.equal(report.kind, 'reference-foreground');
    assert.equal(report.method, 'temporal-median-background-subtraction');
    assert.deepEqual(report.params, { threshold: 24, minArea: 12 });
    assert.equal(report.source.sha256, videoHash);
    assert.equal(report.source.origin, 'material');
    assert.equal(report.media.frames, FRAMES);

    const area = WIDTH * HEIGHT;
    // Every non-occluded frame shows the two squares (36 + 4 px); the largest
    // blob is the 6x6 block and its spatial-coherence confidence is 36/40.
    for (let frame = 0; frame < FRAMES; frame++) {
      const row = report.frames[frame];
      assert.equal(row.index, frame);
      assert.equal(row.outputFrame, ptsToFrames(row.pts, report.clock.originPts, report.clock.timeBase, report.fps));
      if (OCCLUDED.has(frame)) {
        assert.equal(row.present, false, `frame ${frame} must be reported absent, not fabricated`);
        assert.equal(row.foregroundPixels, 0);
        assert.equal(row.largestArea, 0);
        assert.equal(row.componentCount, 0);
        assert.equal(row.confidence, 0);
        assert.equal(row.centroid, null);
        assert.equal(row.bbox, null);
        continue;
      }
      const big = bigPosition(frame);
      assert.equal(row.present, true);
      assert.equal(row.foregroundPixels, BIG_SIZE * BIG_SIZE + SMALL_SIZE * SMALL_SIZE);
      assert.equal(row.componentCount, 2);
      assert.equal(row.largestArea, BIG_SIZE * BIG_SIZE);
      assert.ok(Math.abs(row.foregroundFraction - 40 / area) < 1e-12);
      assert.ok(Math.abs(row.confidence - 36 / 40) < 1e-12);
      assert.deepEqual(row.bbox, { x: big.x, y: big.y, width: BIG_SIZE, height: BIG_SIZE });
      assert.ok(row.centroid);
      assert.ok(
        Math.abs(row.centroid.x - (big.x + (BIG_SIZE - 1) / 2 + 0.5) / WIDTH) < 1e-9,
        `frame ${frame} centroid x`,
      );
      assert.ok(
        Math.abs(row.centroid.y - (big.y + (BIG_SIZE - 1) / 2 + 0.5) / HEIGHT) < 1e-9,
        `frame ${frame} centroid y`,
      );
    }

    // The three hidden frames are one contiguous gap in both frame spaces.
    assert.equal(report.coverage.presentFrames, FRAMES - OCCLUDED.size);
    assert.equal(report.coverage.missingFrames, OCCLUDED.size);
    assert.equal(report.coverage.fullyPresent, false);
    assert.deepEqual(report.coverage.gaps, [
      { sourceFrameStart: 5, sourceFrameEnd: 7, outputFrameStart: 5, outputFrameEnd: 7, sourceFrames: 3 },
    ]);
    assert.equal(report.coverage.longestGapFrames, 3);
    assert.ok(Math.abs(report.coverage.minConfidence - 36 / 40) < 1e-12);

    assert.ok(report.reportPath.startsWith('.viscraft/reference-foreground/'));
    const onDisk = JSON.parse(await fs.readFile(nodePath.join(root, report.reportPath), 'utf8'));
    assert.deepEqual(onDisk, report);

    assert.ok(report.limitations.some(line => /background subtraction/i.test(line)));
    assert.ok(report.limitations.some(line => /not a recognized person, object, face or identity/i.test(line)));
    assert.ok(
      report.limitations.some(line =>
        /No pose estimation, identity recognition, depth estimation or 3D reconstruction/i.test(line),
      ),
    );
    assert.ok(report.limitations.some(line => /does not edit, regenerate, continue or retime video/i.test(line)));
    assert.ok(report.limitations.some(line => /never interpolated across gaps/i.test(line)));

    // Nothing was registered and no authoring file changed.
    assert.deepEqual(await fs.readFile(nodePath.join(root, 'project.json')), projectBefore);
    assert.equal(await hashFile(video), videoHash);
    assert.equal((await loadProject(root)).assets.length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('analyzeReferenceForeground maps source PTS onto a requested output fps exactly', async () => {
  const root = await tempDir();
  try {
    await writeProject(root, makeProject());
    await makeFixture(root);

    const half = await analyzeReferenceForeground(root, 'refs/moving.mkv', {
      fps: { numerator: 5, denominator: 1 },
      minArea: 12,
    });
    assert.deepEqual(half.fps, { numerator: 5, denominator: 1 });
    // Output positions are the shared half-up resample, not the source index.
    for (const row of half.frames) {
      assert.equal(row.outputFrame, ptsToFrames(row.pts, half.clock.originPts, half.clock.timeBase, half.fps));
    }
    assert.ok(!half.limitations.some(line => /defaulted to the current Project composition fps/i.test(line)));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('analyzeReferenceForeground refuses an out-of-range threshold or minArea', async () => {
  const root = await tempDir();
  try {
    await writeProject(root, makeProject());
    await makeFixture(root);
    await assert.rejects(
      () => analyzeReferenceForeground(root, 'refs/moving.mkv', { threshold: 0 }),
      /threshold must be an integer in \[1, 255\]/,
    );
    await assert.rejects(
      () => analyzeReferenceForeground(root, 'refs/moving.mkv', { threshold: 300 }),
      /threshold must be an integer in \[1, 255\]/,
    );
    await assert.rejects(
      () => analyzeReferenceForeground(root, 'refs/moving.mkv', { minArea: 0 }),
      /minArea must be a positive integer/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('analyzeReferenceForeground fails loudly before decoding an over-long clip or an over-large frame', async () => {
  const root = await tempDir();
  try {
    await writeProject(root, makeProject());
    const refs = nodePath.join(root, 'refs');
    await fs.mkdir(refs, { recursive: true });

    // 601 frames: just over the 600-frame segmentation boundary.
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=c=gray:s=32x32:r=601:d=1',
      '-c:v',
      'ffv1',
      '-pix_fmt',
      'gray',
      '-f',
      'matroska',
      nodePath.join(refs, 'overlong.mkv'),
    ]);
    await assert.rejects(() => analyzeReferenceForeground(root, 'refs/overlong.mkv', {}), /capped at 600 frames/i);

    // 700x400 = 280000 px/frame: over the per-frame pixel cap.
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=c=gray:s=700x400:r=1:d=1',
      '-c:v',
      'ffv1',
      '-pix_fmt',
      'gray',
      '-f',
      'matroska',
      nodePath.join(refs, 'huge.mkv'),
    ]);
    await assert.rejects(
      () => analyzeReferenceForeground(root, 'refs/huge.mkv', {}),
      /capped at 230400 pixels per frame/i,
    );

    // A non-media file must fail loudly, not produce an empty report.
    await fs.writeFile(nodePath.join(refs, 'notes.txt'), 'not a video\n');
    await assert.rejects(() => analyzeReferenceForeground(root, 'refs/notes.txt', {}));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
