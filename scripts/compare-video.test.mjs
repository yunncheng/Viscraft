import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { compareVideos, makeTimeline } from '../skills/viscraft/scripts/compare-video.mjs';

const exec = (command, args, options = {}) => promisify(execFile)(command, args, { ...options, windowsHide: true });
const command = args => exec('ffmpeg', ['-v', 'error', '-nostdin', ...args], { encoding: 'buffer' });
const probe = async file =>
  JSON.parse((await exec('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file])).stdout);
const pixel = async (file, frame, x) => [
  ...(
    await command([
      '-i',
      file,
      '-vf',
      `select=eq(n\\,${frame}),crop=20:20:${x}:120,scale=1:1`,
      '-frames:v',
      '1',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      '-threads',
      '1',
      '-',
    ])
  ).stdout,
];

test('actual media: trimmed mixed-FPS sources, nonzero PTS, manual events, gaps and retimed overview', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-compare-test-'));
  try {
    // A known colour change is the authored event, independent of the comparison implementation.
    for (const [name, fps, seconds, event, offset] of [
      ['left', 25, 2, 0.8, 5],
      ['right', 10, 2.8, 1.2, 0],
    ]) {
      await command([
        '-f',
        'lavfi',
        '-i',
        `color=blue:s=160x90:r=${fps}:d=${seconds}`,
        '-vf',
        `drawbox=color=red:t=fill:enable='gte(t,${event})',setpts=PTS+${offset}/TB`,
        '-c:v',
        'ffv1',
        '-threads',
        '1',
        path.join(root, `${name}.mkv`),
      ]);
    }
    const request = {
      left: { path: 'left.mkv', label: 'Motion', in: 0.4, out: 1.6 },
      right: { path: 'right.mkv', label: 'Candidate', in: 0.2, out: 2.6 },
      alignment: { mode: 'elapsed' },
      fps: 5,
      width: 320,
      samples: 3,
    };
    const elapsedDir = path.join(root, 'elapsed');
    const elapsed = await compareVideos(request, elapsedDir, root);
    assert.equal(elapsed.timeline.frames.length, 12);
    assert.equal(elapsed.clips[0].firstPTS, 5);
    assert.equal(elapsed.timeline.frames[0].sides[0].sourcePTS, 5.4);
    assert.equal(elapsed.timeline.frames[0].sides[1].frame, 2);
    assert.equal(elapsed.timeline.frames[8].sides[0], null);
    const before = await pixel(path.join(elapsedDir, 'comparison.mp4'), 1, 100);
    const after = await pixel(path.join(elapsedDir, 'comparison.mp4'), 3, 100);
    assert.ok(before[2] > 180 && before[0] < 30, `before event is blue: ${before}`);
    assert.ok(after[0] > 180 && after[2] < 30, `after event is red: ${after}`);
    const gap = await pixel(path.join(elapsedDir, 'comparison.mp4'), 8, 100);
    assert.ok(
      gap.every(channel => Math.abs(channel - 20) < 5),
      `missing side is blank: ${gap}`,
    );
    const film = (await probe(path.join(elapsedDir, 'comparison.mp4'))).streams[0];
    assert.equal(film.nb_frames, '12');
    assert.equal(film.avg_frame_rate, '5/1');
    const sheet = (await probe(path.join(elapsedDir, 'contact-sheet.png'))).streams[0];
    assert.equal(sheet.width, 640);
    assert.equal(sheet.height, 264 * 3);
    assert.deepEqual(elapsed.sampleIndices, [0, 6, 11]);
    await assert.rejects(compareVideos(request, elapsedDir, root), /EEXIST/);

    const event = await compareVideos(
      {
        ...request,
        alignment: { mode: 'event', leftEvent: 0.8, rightEvent: 1.2 },
      },
      path.join(root, 'event'),
      root,
    );
    const zero = event.timeline.frames.find(row => Math.abs(row.comparisonTime) < 1e-8);
    assert.ok(zero);
    assert.equal(zero.sides[0].frame, 20);
    assert.equal(zero.sides[1].frame, 12);
    for (const x of [100, 420]) {
      const colour = await pixel(path.join(root, 'event/comparison.mp4'), zero.index, x);
      assert.ok(colour[0] > 180 && colour[2] < 30);
    }
    assert.equal(event.timeline.frames[0].sides[0], null);
    const normalized = await compareVideos(
      { ...request, alignment: { mode: 'normalized' } },
      path.join(root, 'normalized'),
      root,
    );
    assert.ok(normalized.timeline.frames.every(row => row.sides.every(Boolean)));
    assert.notEqual(normalized.timeline.frames[4].sides[0].editTime, normalized.timeline.frames[4].sides[1].editTime);

    const invalidDir = path.join(root, 'invalid');
    await assert.rejects(
      compareVideos({ ...request, right: { ...request.right, out: 99 } }, invalidDir, root),
      /Invalid selected interval/,
    );
    await assert.rejects(fs.stat(invalidDir), /ENOENT/);
    await assert.rejects(
      compareVideos(
        {
          ...request,
          alignment: { mode: 'event', leftEvent: 0.8, rightEvent: 9 },
        },
        invalidDir,
        root,
      ),
      /event anchor/,
    );
    await assert.rejects(compareVideos({ ...request, alignement: {} }, invalidDir, root), /Unknown request/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('irregular PTS samples use source presentation time, never decoded index divided by FPS', () => {
  const clip = { in: 0, out: 1, pts: [7, 7.1, 7.5, 7.9] };
  const result = makeTimeline(clip, clip, { mode: 'elapsed' }, 4);
  assert.deepEqual(
    result.frames.map(row => row.sides[0].frame),
    [0, 1, 2, 2],
  );
  assert.deepEqual(
    result.frames.map(row => row.sides[0].sourcePTS),
    [7, 7.1, 7.5, 7.5],
  );
});

test('24 FPS boundaries select exact frames without rounded-seconds errors', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-compare-fraction-'));
  try {
    await command([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=160x90:r=24:d=2',
      '-c:v',
      'ffv1',
      '-threads',
      '1',
      path.join(root, 'fraction.mkv'),
    ]);
    const clip = { path: 'fraction.mkv', label: 'Fractional clock', in: 14 / 24, out: 38 / 24 };
    const report = await compareVideos(
      { left: clip, right: clip, alignment: { mode: 'elapsed' }, fps: 12, width: 320, samples: 2 },
      path.join(root, 'preview'),
      root,
    );
    // Matroska quantizes to milliseconds: use an MP4 with an exact 1/12288 base
    // for the strict clock boundary assertion instead.
    await command([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=160x90:r=24:d=2',
      '-c:v',
      'libx264',
      '-threads',
      '1',
      path.join(root, 'fraction.mp4'),
    ]);
    const exact = { ...clip, path: 'fraction.mp4' };
    const exactReport = await compareVideos(
      { left: exact, right: exact, alignment: { mode: 'elapsed' }, fps: 12, width: 320, samples: 2 },
      path.join(root, 'exact'),
      root,
    );
    assert.equal(report.timeline.frames.length, 12);
    assert.deepEqual(
      exactReport.timeline.frames.map(row => row.sides[0].frame),
      Array.from({ length: 12 }, (_, i) => 14 + i * 2),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('real VFR decode preserves irregular presentation timestamps', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-compare-vfr-'));
  try {
    await command([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=120x160:r=10:d=1.2',
      '-vf',
      'select=not(eq(n\\,3)+eq(n\\,4)+eq(n\\,7))',
      '-fps_mode',
      'passthrough',
      '-c:v',
      'ffv1',
      '-threads',
      '1',
      path.join(root, 'vfr.mkv'),
    ]);
    const clip = { path: 'vfr.mkv', label: 'VFR', in: 0, out: 1 };
    const report = await compareVideos(
      {
        left: clip,
        right: clip,
        alignment: { mode: 'elapsed' },
        fps: 4,
        width: 320,
        samples: 2,
      },
      path.join(root, 'preview'),
      root,
    );
    assert.deepEqual(
      report.timeline.frames.map(row => row.sides[0].frame),
      [0, 2, 3, 4],
    );
    assert.deepEqual(
      report.timeline.frames.map(row => row.sides[0].sourcePTS),
      [0, 0.2, 0.5, 0.6],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
