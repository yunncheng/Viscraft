import { createSymlinkFixture } from './fs-fixtures.js';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { analyzeReference } from '../src/operations/analysis/reference.js';
import { ProjectSchema } from '../src/core/schema.js';
import type { Asset, Fps, Project } from '../src/core/schema.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { loadProject } from '../src/project/project.js';

const PNG_MAGIC = '89504e470d0a1a0a';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-reference-test-'));
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

function makeProject(fps: Fps = { numerator: 25, denominator: 1 }, assets: Asset[] = []): Project {
  const frames = 25;
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'ref_project',
    revision: 1,
    title: 'Reference test',
    direction: { intent: 'test', looks: [{ id: 'look_main', description: 'main' }], transitions: [] },
    assets,
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

async function makeReferenceDir(root: string): Promise<string> {
  const dir = nodePath.join(root, 'refs');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** A red->blue hard cut: exactly one scene transition at the midpoint. */
async function makeRedBlue(
  dir: string,
  name: string,
  options: { fps?: number; seconds?: number; offset?: number } = {},
): Promise<string> {
  const fps = options.fps ?? 10;
  const seconds = options.seconds ?? 1;
  const out = nodePath.join(dir, name);
  const args = [
    '-f',
    'lavfi',
    '-i',
    `color=c=red:s=64x48:r=${fps}:d=${seconds}`,
    '-f',
    'lavfi',
    '-i',
    `color=c=blue:s=64x48:r=${fps}:d=${seconds}`,
    '-filter_complex',
    '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map',
    '[v]',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(fps),
  ];
  if (options.offset !== undefined) args.push('-output_ts_offset', String(options.offset));
  args.push(out);
  await ffmpeg(args);
  return out;
}

/** A genuinely variable-frame-rate clip: 10fps for 1s then 20fps for 1s. */
async function makeVfr(dir: string, name: string): Promise<string> {
  const out = nodePath.join(dir, name);
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=64x48:r=10:d=1',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=64x48:r=20:d=1',
    '-filter_complex',
    '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map',
    '[v]',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-fps_mode',
    'vfr',
    out,
  ]);
  return out;
}

function assertTiles(segments: Array<{ startFrame: number; endFrame: number }>, total: number): void {
  assert.equal(segments[0].startFrame, 0);
  for (let i = 1; i < segments.length; i++) assert.equal(segments[i].startFrame, segments[i - 1].endFrame);
  assert.equal(segments[segments.length - 1].endFrame, total);
  for (const segment of segments) assert.ok(segment.endFrame > segment.startFrame);
}

async function assertPngReviewFrames(
  root: string,
  report: Awaited<ReturnType<typeof analyzeReference>>,
): Promise<void> {
  assert.ok(report.reviewFrames.length > 0, 'expected review contact frames');
  for (const frame of report.reviewFrames) {
    assert.ok(frame.sourceFrame >= 0 && frame.sourceFrame < report.frames.length);
    const buf = await fs.readFile(nodePath.join(root, frame.path));
    assert.equal(buf.toString('hex', 0, 8), PNG_MAGIC, `review frame ${frame.path} should be a PNG`);
  }
}

test('analyzeReference reports a known red->blue cut with exact PTS clock and leaves source/Project untouched', async () => {
  const root = await tempDir();
  try {
    await writeProject(root, makeProject({ numerator: 10, denominator: 1 }));
    const refs = await makeReferenceDir(root);
    const video = await makeRedBlue(refs, 'redblue.mp4');
    const projectBefore = await fs.readFile(nodePath.join(root, 'project.json'));
    const videoHash = await hashFile(video);

    const report = await analyzeReference(root, 'refs/redblue.mp4');

    assert.equal(report.kind, 'reference-analysis');
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.source.path, 'refs/redblue.mp4');
    assert.equal(report.source.sha256, videoHash);
    assert.equal(report.source.origin, 'material');
    assert.equal(report.source.simulated, false);
    assert.deepEqual(report.fps, { numerator: 10, denominator: 1 });
    assert.equal(report.media.frames, 20);

    assert.deepEqual(report.clock.timeBase, { numerator: 1, denominator: 10240 });
    assert.equal(report.clock.originPts, '0');
    assert.equal(report.clock.endPts, '20480');
    assert.equal(report.clock.durationMethod, 'source-duration');
    assert.equal(report.clock.variableFrameRate, false);

    assert.equal(report.frames.length, 20);
    assert.equal(report.frames[0].outputFrame, 0);
    assert.equal(report.frames[10].outputFrame, 10);

    assert.equal(report.cuts.length, 1);
    assert.equal(report.cuts[0].sourceFrame, 10);
    assert.equal(report.cuts[0].outputFrame, 10);
    assert.ok(Math.abs(report.cuts[0].score - 0.4) < 0.05, `score ${report.cuts[0].score}`);

    assert.deepEqual(report.segments, [
      { startFrame: 0, endFrame: 10 },
      { startFrame: 10, endFrame: 20 },
    ]);

    await assertPngReviewFrames(root, report);

    assert.ok(report.reportPath.startsWith('.viscraft/references/'));
    assert.ok(report.reportPath.endsWith('/report.json'));
    const onDisk = JSON.parse(await fs.readFile(nodePath.join(root, report.reportPath), 'utf8'));
    assert.deepEqual(onDisk, report);

    // Nothing was registered and no authoring file changed.
    assert.deepEqual(await fs.readFile(nodePath.join(root, 'project.json')), projectBefore);
    assert.equal(await hashFile(video), videoHash);
    assert.equal((await loadProject(root)).assets.length, 0);
    assert.equal((await loadProject(root)).revision, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('analyzeReference handles a nonzero PTS origin without rebasing errors', async () => {
  const root = await tempDir();
  try {
    await writeProject(root, makeProject({ numerator: 10, denominator: 1 }));
    const refs = await makeReferenceDir(root);
    await makeRedBlue(refs, 'offset.mp4', { offset: 5 });

    const report = await analyzeReference(root, 'refs/offset.mp4');

    // 5s * 10240 ticks/s = 51200; 20 frames of 1024 ticks => end 20480 later.
    assert.equal(report.clock.originPts, '51200');
    assert.equal(report.clock.endPts, '71680');
    assert.equal(report.frames[0].outputFrame, 0, 'origin frame must map to output frame 0');
    assert.equal(report.frames[10].outputFrame, 10);
    assert.equal(report.cuts[0].sourceFrame, 10);
    assert.equal(report.cuts[0].outputFrame, 10);
    assert.deepEqual(report.segments, [
      { startFrame: 0, endFrame: 10 },
      { startFrame: 10, endFrame: 20 },
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('analyzeReference maps PTS to output frames with exact half-up rational rounding', async () => {
  const root = await tempDir();
  try {
    // Source 10fps @1/10240 -> at 25fps each tick frame is 2.5 output frames.
    await writeProject(root, makeProject({ numerator: 25, denominator: 1 }));
    const refs = await makeReferenceDir(root);
    await makeRedBlue(refs, 'redblue.mp4');

    const report = await analyzeReference(root, 'refs/redblue.mp4');

    assert.equal(report.frames[1].outputFrame, 3, '1024 ticks @10fps -> 2.5 output frames half-up');
    assert.equal(report.frames[2].outputFrame, 5);
    assert.equal(report.frames[3].outputFrame, 8, '3072 ticks -> 7.5 frames half-up');
    assert.equal(report.cuts[0].outputFrame, 25);
    assert.deepEqual(report.segments, [
      { startFrame: 0, endFrame: 25 },
      { startFrame: 25, endFrame: 50 },
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('analyzeReference tiles a 2s 10fps reference into 60 output frames at 30fps', async () => {
  const root = await tempDir();
  try {
    await writeProject(root, makeProject({ numerator: 30, denominator: 1 }));
    const refs = await makeReferenceDir(root);
    await makeRedBlue(refs, 'redblue.mp4');

    const report = await analyzeReference(root, 'refs/redblue.mp4');

    assert.deepEqual(report.fps, { numerator: 30, denominator: 1 });
    assert.equal(report.clock.endPts, '20480');
    // 2s at 30fps = 60 output frames (not 20 source frames).
    assert.equal(report.frames[report.frames.length - 1].outputFrame, 57);
    assert.equal(report.cuts[0].outputFrame, 30);
    assert.deepEqual(report.segments, [
      { startFrame: 0, endFrame: 30 },
      { startFrame: 30, endFrame: 60 },
    ]);
    assertTiles(report.segments, 60);
    await assertPngReviewFrames(root, report);
    // The detected cut's source frame is still addressable in the source material.
    assert.ok(report.reviewFrames.some(frame => frame.sourceFrame === 10));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('analyzeReference detects variable frame rate and resolves the end from duration evidence or the documented fallback', async () => {
  const root = await tempDir();
  try {
    await writeProject(root, makeProject({ numerator: 25, denominator: 1 }));
    const refs = await makeReferenceDir(root);
    await makeVfr(refs, 'vfr.mp4');

    const report = await analyzeReference(root, 'refs/vfr.mp4');

    assert.equal(report.media.frames, 30);
    assert.deepEqual(report.clock.timeBase, { numerator: 1, denominator: 1000000 });
    assert.equal(report.clock.variableFrameRate, true, 'unequal PTS deltas must be detected exactly');
    const probe = JSON.parse(
      await runCommand('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'frame=duration,pkt_duration',
        '-of',
        'json',
        nodePath.join(refs, 'vfr.mp4'),
      ]),
    ) as { frames: Array<{ duration?: number; pkt_duration?: number }> };
    const finalFrame = probe.frames.at(-1)!;
    const duration = Number(finalFrame.pkt_duration ?? finalFrame.duration ?? 0);
    const expectedEnd = duration > 0 ? 1950000 + duration : 2020000;
    const expectedFrames = Math.floor((expectedEnd * 25 + 500000) / 1000000);
    assert.equal(report.clock.durationMethod, duration > 0 ? 'source-duration' : 'frame-rate-fallback');
    assert.equal(report.clock.originPts, '0');
    // If no duration is exposed, 1/avg_fps supplies 70000 ticks after the last PTS.
    assert.equal(report.clock.endPts, String(expectedEnd));
    assert.equal(report.frames[1].outputFrame, 3, '100000 ticks = 2.5 output frames half-up');
    assert.equal(report.cuts[0].outputFrame, 25);
    assert.deepEqual(report.segments, [
      { startFrame: 0, endFrame: 25 },
      { startFrame: 25, endFrame: expectedFrames },
    ]);
    assertTiles(report.segments, expectedFrames);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('analyzeReference refuses to buffer a reference longer than the frame cap', async () => {
  const root = await tempDir();
  try {
    await writeProject(root, makeProject());
    const refs = await makeReferenceDir(root);
    // 10001 tiny frames: just over the 10000-frame analysis boundary.
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=32x32:rate=1000:duration=10.001',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-r',
      '1000',
      nodePath.join(refs, 'long.mp4'),
    ]);
    await assert.rejects(() => analyzeReference(root, 'refs/long.mp4'), /capped at 10000 frames/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('analyzeReference rejects unsafe, symlinked, and missing reference paths', async t => {
  const root = await tempDir();
  try {
    await writeProject(root, makeProject());
    const refs = await makeReferenceDir(root);
    const video = await makeRedBlue(refs, 'redblue.mp4');

    await assert.rejects(() => analyzeReference(root, '../escape.mp4'), /safe project-relative path/i);
    await assert.rejects(() => analyzeReference(root, '/etc/passwd'), /safe project-relative path/i);
    await assert.rejects(() => analyzeReference(root, 'refs/missing.mp4'), /not readable/i);
    await assert.rejects(() => analyzeReference(root, 'C:\\windows\\evil.mp4'));

    const link = nodePath.join(refs, 'link.mp4');
    await t.test('file symlink is refused', async t => {
      if (!(await createSymlinkFixture(t, video, link))) return;
      await assert.rejects(() => analyzeReference(root, 'refs/link.mp4'), /Symbolic links are not allowed/i);
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('analyzeReference taints provenance from a simulated Media Asset', async () => {
  const root = await tempDir();
  try {
    const refs = await makeReferenceDir(root);
    const video = await makeRedBlue(refs, 'redblue.mp4');
    const sha256 = await hashFile(video);
    const asset: Asset = {
      id: 'asset_ref',
      revision: 1,
      path: 'refs/redblue.mp4',
      sha256,
      type: 'video',
      rights: { origin: 'test-only', license: 'test-only', redistributable: false },
      simulated: true,
    };
    await writeProject(root, makeProject({ numerator: 10, denominator: 1 }, [asset]));

    const report = await analyzeReference(root, 'refs/redblue.mp4');

    assert.equal(report.source.origin, 'asset');
    assert.equal(report.source.simulated, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('analyzeReference taints provenance from a simulated Build artifact', async () => {
  const root = await tempDir();
  try {
    await writeProject(root, makeProject({ numerator: 10, denominator: 1 }));
    const refs = await makeReferenceDir(root);
    const video = await makeRedBlue(refs, 'redblue.mp4');
    const sha256 = await hashFile(video);

    const buildsDir = nodePath.join(root, '.viscraft', 'builds');
    await fs.mkdir(buildsDir, { recursive: true });
    await fs.writeFile(
      nodePath.join(buildsDir, 'build-sim.json'),
      JSON.stringify(buildRecord('artifact_sim', 'refs/redblue.mp4', sha256, true)),
    );

    const report = await analyzeReference(root, 'refs/redblue.mp4');

    assert.equal(report.source.origin, 'artifact');
    assert.equal(report.source.simulated, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('analyzeReference unions simulated taint across every hash-matching record', async () => {
  const root = await tempDir();
  try {
    const refs = await makeReferenceDir(root);
    const video = await makeRedBlue(refs, 'redblue.mp4');
    const sha256 = await hashFile(video);
    const asset: Asset = {
      id: 'asset_ref',
      revision: 1,
      path: 'refs/redblue.mp4',
      sha256,
      type: 'video',
      rights: { origin: 'test-only', license: 'test-only', redistributable: false },
      simulated: false,
    };
    await writeProject(root, makeProject({ numerator: 10, denominator: 1 }, [asset]));
    const buildsDir = nodePath.join(root, '.viscraft', 'builds');
    await fs.mkdir(buildsDir, { recursive: true });
    await fs.writeFile(
      nodePath.join(buildsDir, 'build-sim.json'),
      JSON.stringify(buildRecord('artifact_sim', '.viscraft/artifacts/other.mp4', sha256, true)),
    );

    const report = await analyzeReference(root, 'refs/redblue.mp4');

    assert.equal(report.source.origin, 'asset', 'asset identity wins when the hash matches both');
    assert.equal(report.source.simulated, true, 'taint must union across all hash-matching records');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('analyzeReference refuses to guess identity from a path whose recorded hash differs', async () => {
  const root = await tempDir();
  try {
    const refs = await makeReferenceDir(root);
    await makeRedBlue(refs, 'redblue.mp4');
    const asset: Asset = {
      id: 'asset_ref',
      revision: 1,
      path: 'refs/redblue.mp4',
      sha256: '0'.repeat(64),
      type: 'video',
      rights: { origin: 'test-only', license: 'test-only', redistributable: false },
      simulated: true,
    };
    await writeProject(root, makeProject({ numerator: 10, denominator: 1 }, [asset]));

    const report = await analyzeReference(root, 'refs/redblue.mp4');

    assert.equal(report.source.origin, 'material', 'a stale recorded hash must not establish identity');
    assert.equal(report.source.simulated, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('analyzeReference marks unregistered material provenance as unknown, not real', async () => {
  const root = await tempDir();
  try {
    await writeProject(root, makeProject({ numerator: 10, denominator: 1 }));
    const refs = await makeReferenceDir(root);
    await makeRedBlue(refs, 'redblue.mp4');

    const report = await analyzeReference(root, 'refs/redblue.mp4');

    assert.equal(report.source.origin, 'material');
    assert.equal(report.source.simulated, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('analyzeReference honors threshold and fps options and validates the threshold range', async () => {
  const root = await tempDir();
  try {
    await writeProject(root, makeProject({ numerator: 10, denominator: 1 }));
    const refs = await makeReferenceDir(root);
    await makeRedBlue(refs, 'redblue.mp4');

    const above = await analyzeReference(root, 'refs/redblue.mp4', { threshold: 0.5 });
    assert.deepEqual(above.cuts, []);
    assert.deepEqual(above.segments, [{ startFrame: 0, endFrame: 20 }]);
    assert.equal(above.threshold, 0.5);

    const inclusive = await analyzeReference(root, 'refs/redblue.mp4', { threshold: 0.4 });
    assert.equal(inclusive.cuts.length, 1);

    const lowFps = await analyzeReference(root, 'refs/redblue.mp4', { fps: { numerator: 5, denominator: 1 } });
    assert.deepEqual(lowFps.fps, { numerator: 5, denominator: 1 });
    assert.equal(lowFps.frames[10].outputFrame, 5);
    assert.deepEqual(lowFps.segments, [
      { startFrame: 0, endFrame: 5 },
      { startFrame: 5, endFrame: 10 },
    ]);

    await assert.rejects(
      () => analyzeReference(root, 'refs/redblue.mp4', { threshold: 1.5 }),
      /threshold must be a finite number in \[0, 1\]/i,
    );
    await assert.rejects(
      () => analyzeReference(root, 'refs/redblue.mp4', { threshold: -0.1 }),
      /threshold must be a finite number in \[0, 1\]/i,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('analyzeReference publishes each run to a unique directory and never deletes prior reports', async () => {
  const root = await tempDir();
  try {
    await writeProject(root, makeProject({ numerator: 10, denominator: 1 }));
    const refs = await makeReferenceDir(root);
    await makeRedBlue(refs, 'redblue.mp4');

    const first = await analyzeReference(root, 'refs/redblue.mp4');
    const second = await analyzeReference(root, 'refs/redblue.mp4');

    assert.notEqual(first.reportPath, second.reportPath, 'each run must publish to a unique directory');
    // The first report must still exist intact after the second run.
    const firstOnDisk = JSON.parse(await fs.readFile(nodePath.join(root, first.reportPath), 'utf8'));
    assert.deepEqual(firstOnDisk, first);
    assert.deepEqual(JSON.parse(await fs.readFile(nodePath.join(root, second.reportPath), 'utf8')), second);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function buildRecord(artifactId: string, path: string, sha256: string, simulated: boolean) {
  return {
    schemaVersion: 1,
    id: 'build-sim',
    run: { id: 'run-1', goal: 'test' },
    plan: { operations: [] },
    revision: 1,
    snapshotHash: 'deadbeef',
    status: 'succeeded',
    medium: 'picture',
    startedAt: '2026-01-01T00:00:00.000Z',
    operations: [],
    artifacts: [
      {
        id: artifactId,
        path,
        sha256,
        kind: 'video',
        simulated,
        operation: 'code-motion',
        inputs: [],
        backend: 'ffmpeg-simulated/test-only',
      },
    ],
    takes: [],
  };
}
