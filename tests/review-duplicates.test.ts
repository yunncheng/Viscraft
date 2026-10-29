import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { buildProject } from '../src/build/build.js';
import { detectRepeatedFrames, reviewBuild } from '../src/operations/analysis/review.js';
import { ProjectSchema } from '../src/core/schema.js';
import type { Project } from '../src/core/schema.js';
import { makeSignalAsset } from './audio-fixtures.js';

const SIGNAL = makeSignalAsset({
  id: 'bed',
  path: 'signal.wav',
  sampleRate: 48000,
  channels: 2,
  samples: 24000,
  frequency: 440,
});

async function tempDir(): Promise<string> {
  return fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-review-dupes-'));
}

/** Run ffmpeg quietly and reject with its tail on a nonzero exit. */
function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', data => {
      stderr = (stderr + String(data)).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`));
    });
  });
}

const frameName = (index: number): string => `f-${String(index + 1).padStart(4, '0')}.png`;

/**
 * Encode a movie whose frames 0..total-1 are all distinct except that the
 * half-open 0-based range [freezeFrom, freezeTo] is a byte-identical copy of
 * frame `freezeFrom` (a genuine held span in the source). Encoded exactly like
 * the runtime's own media pipeline (libx264, crf 18, yuv420p).
 */
async function makeFrozenMovie(root: string, total: number, freezeFrom: number, freezeTo: number): Promise<string> {
  const seq = nodePath.join(root, 'seq');
  await fs.mkdir(seq, { recursive: true });
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x120:rate=25',
    '-frames:v',
    String(total),
    nodePath.join(seq, 'f-%04d.png'),
  ]);
  for (let i = freezeFrom + 1; i <= freezeTo; i++) {
    await fs.copyFile(nodePath.join(seq, frameName(freezeFrom)), nodePath.join(seq, frameName(i)));
  }
  const out = nodePath.join(root, 'frozen.mp4');
  await ffmpeg([
    '-framerate',
    '25',
    '-i',
    nodePath.join(seq, 'f-%04d.png'),
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    out,
  ]);
  return out;
}

/** Encode `total` all-distinct frames (a continuously moving test pattern). */
async function makeDistinctMovie(root: string, total: number): Promise<string> {
  const out = nodePath.join(root, 'distinct.mp4');
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x120:rate=25',
    '-frames:v',
    String(total),
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    out,
  ]);
  return out;
}

/** Encode a single still image held for the whole duration (one real PNG, looped). */
async function makeStillMovie(root: string, total: number): Promise<string> {
  const still = nodePath.join(root, 'still.png');
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=25', '-frames:v', '1', still]);
  const out = nodePath.join(root, 'still.mp4');
  await ffmpeg([
    '-loop',
    '1',
    '-framerate',
    '25',
    '-i',
    still,
    '-frames:v',
    String(total),
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    out,
  ]);
  return out;
}

/** Two simulated 20-frame shots with one cut, for the reviewBuild integration test. */
function makeProject(): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'review_dup',
    revision: 1,
    title: 'Review Duplicate Frames Test',
    direction: {
      intent: 'Two-shot simulated build for repeated-frame coverage.',
      looks: [{ id: 'look_main', description: 'main look' }],
      transitions: [],
    },
    assets: [SIGNAL.asset],
    bindings: {},
    sources: [
      {
        id: 'src_a',
        kind: 'simulated',
        prompt: 'shot a',
        frames: 20,
        seed: 1,
        attempt: 'attempt_a',
        behavior: 'success',
      },
      {
        id: 'src_b',
        kind: 'simulated',
        prompt: 'shot b',
        frames: 20,
        seed: 2,
        attempt: 'attempt_b',
        behavior: 'success',
      },
    ],
    composition: {
      output: { width: 160, height: 120, fps: { numerator: 25, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene_1', description: 'scene' }],
      shots: [
        { id: 'shot_a', scene: 'scene_1', look: 'look_main', intent: 'a', targetFrames: 20 },
        { id: 'shot_b', scene: 'scene_1', look: 'look_main', intent: 'b', targetFrames: 20 },
      ],
      placements: [
        { id: 'pl_a', shot: 'shot_a', source: 'src_a', inFrame: 0, outFrame: 20, startFrame: 0, audio: 'mute' },
        { id: 'pl_b', shot: 'shot_b', source: 'src_b', inFrame: 0, outFrame: 20, startFrame: 20, audio: 'mute' },
      ],
      transitions: [],
      audio: [
        {
          id: 'bed',
          kind: 'asset',
          asset: 'bed',
          inSample: 0,
          startSample: 0,
          durationSamples: 24000,
          gain: 0.3,
          fadeInSamples: 480,
          fadeOutSamples: 480,
        },
      ],
    },
  });
}

test('a deliberately frozen span of frames is reported exactly', async () => {
  const root = await tempDir();
  try {
    // Frames 0..19 distinct except a genuine held span at 0-based frames 10..19.
    const movie = await makeFrozenMovie(root, 20, 10, 19);
    const result = await detectRepeatedFrames(movie, 20);
    assert.equal(result.analysedFrames, 20);
    assert.equal(result.spanCount, 1, 'exactly one held span');
    assert.deepEqual(result.spans, [{ startFrame: 10, endFrame: 19, lengthFrames: 10 }]);
    // The summary counts the redundant frames (span length minus its first frame).
    assert.equal(result.repeatedFrames, 9);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a movie whose picture changes every frame reports no spans', async () => {
  const root = await tempDir();
  try {
    const movie = await makeDistinctMovie(root, 20);
    const result = await detectRepeatedFrames(movie, 20);
    assert.equal(result.analysedFrames, 20);
    assert.equal(result.spanCount, 0);
    assert.equal(result.repeatedFrames, 0);
    assert.deepEqual(result.spans, [], 'the fact is an always-present empty structure when there are none');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a single still held for the whole duration reports one span covering it', async () => {
  const root = await tempDir();
  try {
    const movie = await makeStillMovie(root, 15);
    const result = await detectRepeatedFrames(movie, 15);
    assert.equal(result.analysedFrames, 15);
    assert.deepEqual(result.spans, [{ startFrame: 0, endFrame: 14, lengthFrames: 15 }]);
    assert.equal(result.repeatedFrames, 14);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('repeated-frame detection is deterministic across runs', async () => {
  const root = await tempDir();
  try {
    const movie = await makeFrozenMovie(root, 20, 4, 9);
    const first = await detectRepeatedFrames(movie, 20);
    const second = await detectRepeatedFrames(movie, 20);
    assert.deepEqual(second, first, 'the same input must produce byte-identical facts');
    assert.equal(typeof first.method, 'string');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a decoded frame-count mismatch is surfaced, never masked as "no repeats"', async () => {
  const root = await tempDir();
  try {
    const movie = await makeDistinctMovie(root, 20);
    await assert.rejects(() => detectRepeatedFrames(movie, 19), /decoded .* frames but the final has 19/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('reviewBuild always reports the repeated-frame fact and stays byte-deterministic', async () => {
  const root = await tempDir();
  try {
    await fs.writeFile(nodePath.join(root, 'project.json'), JSON.stringify(makeProject(), null, 2));
    await fs.writeFile(nodePath.join(root, SIGNAL.asset.path), SIGNAL.bytes);
    const record = await buildProject(root);
    assert.equal(record.status, 'succeeded');

    const review = await reviewBuild(root);
    const reportPath = nodePath.join(root, review.report);
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));

    // Repeated-frame facts are always present and internally consistent.
    const spans = report.video.repeatedFrameSpans;
    assert.ok(spans, 'video.repeatedFrameSpans must always be present');
    assert.equal(spans.analysedFrames, report.final.probe.frames, 'every delivered frame is analysed');
    assert.equal(spans.sampleWidth, 64);
    assert.equal(spans.sampleHeight, 64);
    assert.equal(typeof spans.toleranceMaxAbsDiff, 'number');
    assert.equal(typeof spans.toleranceMeanAbsDiff, 'number');
    assert.equal(typeof spans.method, 'string');
    assert.equal(spans.spanCount, spans.spans.length);
    assert.equal(
      spans.repeatedFrames,
      spans.spans.reduce((sum: number, span: { lengthFrames: number }) => sum + (span.lengthFrames - 1), 0),
    );
    for (const span of spans.spans) {
      assert.ok(span.lengthFrames >= 2, 'a span is at least two frames');
      assert.equal(span.lengthFrames, span.endFrame - span.startFrame + 1);
      assert.ok(
        span.startFrame >= 0 && span.endFrame < report.final.probe.frames,
        'spans stay inside the delivered frame range',
      );
    }

    // The report also retains timeline and conformance facts.
    assert.ok(Array.isArray(report.video.blackFrames));
    assert.equal(report.timeline.expectedFrames, 40);
    assert.equal(report.final.conformance.framesMatch, true);

    // Same input => same report bytes across two reviews.
    const bytesBefore = await fs.readFile(reportPath, 'utf8');
    const again = await reviewBuild(root);
    assert.equal(again.report, review.report);
    assert.equal(
      await fs.readFile(reportPath, 'utf8'),
      bytesBefore,
      'a repeat review must produce identical report bytes',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
