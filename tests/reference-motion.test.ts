import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { trackReferenceMarker } from '../src/operations/analysis/reference-motion.js';
import { ProjectSchema } from '../src/core/schema.js';
import type { Asset, Fps, Project } from '../src/core/schema.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { loadProject } from '../src/project/project.js';

// Fixtures are original, synthetically authored RGB24 frames (no third-party
// media): a red square marker on a black background is written to a raw buffer
// and losslessly encoded with FFV1/gbrp, so decoded colours round-trip exactly.
const WIDTH = 64;
const HEIGHT = 64;
const FRAMES = 8;
const MISSING_FRAME = 3;
const MARKER_SIZE = 4;
const COLOR: [number, number, number] = [255, 0, 0];

/** Marker top-left pixel per frame; null frames carry no marker. */
const POSITIONS: Array<{ x: number; y: number } | null> = Array.from({ length: FRAMES }, (_, frame) =>
  frame === MISSING_FRAME ? null : { x: 8 + frame * 4, y: 8 + frame * 2 },
);

function expectedCenterX(marker: { x: number }): number {
  return (marker.x + MARKER_SIZE / 2) / WIDTH;
}
function expectedCenterY(marker: { y: number }): number {
  return (marker.y + MARKER_SIZE / 2) / HEIGHT;
}

async function tempDir(): Promise<string> {
  return fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-reference-motion-test-'));
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

function makeProject(fps: Fps = { numerator: 10, denominator: 1 }, assets: Asset[] = []): Project {
  const frames = 25;
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'ref_motion_project',
    revision: 1,
    title: 'Reference motion test',
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

/** Pack RGB24 frames with a red marker at each non-null position. */
function rawFrames(width: number, height: number, positions: Array<{ x: number; y: number } | null>): Buffer {
  const buffer = Buffer.alloc(width * height * positions.length * 3, 0);
  for (let frame = 0; frame < positions.length; frame++) {
    const marker = positions[frame];
    if (!marker) continue;
    for (let y = marker.y; y < marker.y + MARKER_SIZE; y++) {
      for (let x = marker.x; x < marker.x + MARKER_SIZE; x++) {
        const offset = (frame * width * height + y * width + x) * 3;
        buffer[offset] = COLOR[0];
        buffer[offset + 1] = COLOR[1];
        buffer[offset + 2] = COLOR[2];
      }
    }
  }
  return buffer;
}

/** Encode packed RGB24 frames to a lossless FFV1/Matroska clip. */
async function encodeRaw(
  dir: string,
  name: string,
  raw: Buffer,
  width: number,
  height: number,
  fps: number,
  offsetSeconds?: number,
): Promise<string> {
  const rawPath = nodePath.join(dir, `${name}.rgb24`);
  const out = nodePath.join(dir, `${name}.mkv`);
  await fs.writeFile(rawPath, raw);
  const args = [
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-s',
    `${width}x${height}`,
    '-r',
    String(fps),
    '-i',
    rawPath,
    '-c:v',
    'ffv1',
    '-pix_fmt',
    'gbrp',
  ];
  if (offsetSeconds !== undefined) args.push('-output_ts_offset', String(offsetSeconds));
  args.push('-f', 'matroska', out);
  await ffmpeg(args);
  await fs.rm(rawPath, { force: true });
  return out;
}

/** Build the standard 8-frame, one-marker-missing fixture. */
async function makeFixture(dir: string, name: string, offsetSeconds?: number): Promise<string> {
  return encodeRaw(dir, name, rawFrames(WIDTH, HEIGHT, POSITIONS), WIDTH, HEIGHT, 10, offsetSeconds);
}

function markerOf(frame: number): { x: number; y: number } {
  const marker = POSITIONS[frame];
  assert.ok(marker, `frame ${frame} is expected to carry a marker`);
  return marker;
}

test('trackReferenceMarker reads native centroids, exact PTS, and leaves source/Project untouched', async () => {
  const root = await tempDir();
  try {
    await writeProject(root, makeProject({ numerator: 10, denominator: 1 }));
    const refs = await makeReferenceDir(root);
    const video = await makeFixture(refs, 'marker');
    const projectBefore = await fs.readFile(nodePath.join(root, 'project.json'));
    const videoHash = await hashFile(video);

    const report = await trackReferenceMarker(root, 'refs/marker.mkv', { color: COLOR });

    assert.equal(report.kind, 'reference-track');
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.source.path, 'refs/marker.mkv');
    assert.equal(report.source.sha256, videoHash);
    assert.equal(report.source.origin, 'material');
    assert.equal(report.source.simulated, false);

    assert.equal(report.media.frames, FRAMES);
    assert.deepEqual(report.fps, { numerator: 10, denominator: 1 });
    assert.deepEqual(report.clock.timeBase, { numerator: 1, denominator: 1000 });
    assert.equal(report.clock.originPts, '0');
    assert.equal(report.clock.endPts, '800');
    assert.equal(report.clock.durationMethod, 'source-duration');
    assert.equal(report.clock.variableFrameRate, false);

    assert.deepEqual(report.marker, { color: COLOR, tolerance: 40, minPixels: 4 });
    assert.deepEqual(report.roi, { x: 0, y: 0, width: WIDTH, height: HEIGHT });
    assert.match(report.paramsHash, /^[a-f0-9]{64}$/);

    assert.equal(report.frames.length, FRAMES);
    const area = WIDTH * HEIGHT;
    for (let frame = 0; frame < FRAMES; frame++) {
      const row = report.frames[frame];
      assert.equal(row.index, frame, 'frame indices must match decoded presentation order');
      assert.equal(row.pts, String(frame * 100));
      assert.equal(row.outputFrame, frame, 'source 10fps maps 1:1 onto a 10fps timeline');
      if (frame === MISSING_FRAME) {
        assert.equal(row.present, false);
        assert.equal(row.x, null);
        assert.equal(row.y, null);
        assert.equal(row.matchedPixels, 0);
        assert.equal(row.confidence, 0);
      } else {
        const marker = markerOf(frame);
        assert.equal(row.present, true);
        assert.ok(
          Math.abs(row.x! - expectedCenterX(marker)) < 1e-12,
          `frame ${frame} x ${row.x} != ${expectedCenterX(marker)}`,
        );
        assert.ok(
          Math.abs(row.y! - expectedCenterY(marker)) < 1e-12,
          `frame ${frame} y ${row.y} != ${expectedCenterY(marker)}`,
        );
        assert.equal(row.matchedPixels, MARKER_SIZE * MARKER_SIZE);
        assert.ok(Math.abs(row.confidence - (MARKER_SIZE * MARKER_SIZE) / area) < 1e-12);
      }
    }

    assert.ok(report.reportPath.startsWith('.viscraft/reference-tracks/'));
    assert.ok(report.reportPath.endsWith('/report.json'));
    const onDisk = JSON.parse(await fs.readFile(nodePath.join(root, report.reportPath), 'utf8'));
    assert.deepEqual(onDisk, report);

    assert.ok(report.limitations.some(line => /RGB tolerance/i.test(line)));
    assert.ok(report.limitations.some(line => /not a semantic detection probability/i.test(line)));
    assert.ok(report.limitations.some(line => /occlusion/i.test(line)));
    assert.ok(
      report.limitations.some(line =>
        /no 3D reconstruction, no identity recognition, and no pose estimation/i.test(line),
      ),
    );
    assert.ok(report.limitations.some(line => /never interpolated across gaps/i.test(line)));

    // Nothing was registered and no authoring file changed.
    assert.deepEqual(await fs.readFile(nodePath.join(root, 'project.json')), projectBefore);
    assert.equal(await hashFile(video), videoHash);
    assert.equal((await loadProject(root)).assets.length, 0);
    assert.equal((await loadProject(root)).revision, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('trackReferenceMarker normalises centroids to the full source frame when an ROI is given', async () => {
  const root = await tempDir();
  try {
    await writeProject(root, makeProject({ numerator: 10, denominator: 1 }));
    const refs = await makeReferenceDir(root);
    await makeFixture(refs, 'marker');

    const roi = { x: 0, y: 0, width: 32, height: 32 };
    const report = await trackReferenceMarker(root, 'refs/marker.mkv', { color: COLOR, roi });

    assert.deepEqual(report.roi, roi);
    // Markers at frames 0,1,2,4,5 fall inside [0,32)x[0,32); frames 6,7 and the
    // genuinely missing frame 3 do not.
    const present = new Set([0, 1, 2, 4, 5]);
    for (let frame = 0; frame < FRAMES; frame++) {
      const row = report.frames[frame];
      if (present.has(frame)) {
        const marker = markerOf(frame);
        assert.equal(row.present, true, `frame ${frame} should be present`);
        // Full-source normalisation: the ROI has no x/y offset here, but the
        // divisor is the full width/height and the marker block centroid holds.
        assert.ok(Math.abs(row.x! - expectedCenterX(marker)) < 1e-12, `frame ${frame} x must use full-source width`);
        assert.ok(Math.abs(row.y! - expectedCenterY(marker)) < 1e-12, `frame ${frame} y must use full-source height`);
        // If the ROI sub-rectangle had been used, x would be (marker.x+2)/32.
        assert.notEqual(row.x, (marker.x + MARKER_SIZE / 2) / roi.width);
        assert.equal(row.matchedPixels, MARKER_SIZE * MARKER_SIZE);
        assert.ok(Math.abs(row.confidence - (MARKER_SIZE * MARKER_SIZE) / (roi.width * roi.height)) < 1e-12);
      } else {
        assert.equal(row.present, false, `frame ${frame} should be absent`);
        assert.equal(row.x, null);
        assert.equal(row.y, null);
        assert.equal(row.matchedPixels, 0);
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('trackReferenceMarker honours fps/minPixels/tolerance options and never fabricates a position', async () => {
  const root = await tempDir();
  try {
    await writeProject(root, makeProject({ numerator: 10, denominator: 1 }));
    const refs = await makeReferenceDir(root);
    await makeFixture(refs, 'marker');

    // Half the output frame rate: source frames collapse onto a 5fps timeline.
    const half = await trackReferenceMarker(root, 'refs/marker.mkv', {
      color: COLOR,
      fps: { numerator: 5, denominator: 1 },
    });
    assert.deepEqual(half.fps, { numerator: 5, denominator: 1 });
    assert.deepEqual(
      half.frames.map(frame => frame.outputFrame),
      [0, 1, 1, 2, 2, 3, 3, 4],
    );
    assert.ok(!half.limitations.some(line => /defaulted to the current Project composition fps/i.test(line)));

    // A minPixels floor above the marker area reports every frame as absent.
    const strict = await trackReferenceMarker(root, 'refs/marker.mkv', {
      color: COLOR,
      minPixels: MARKER_SIZE * MARKER_SIZE + 1,
    });
    for (let frame = 0; frame < FRAMES; frame++) {
      const row = strict.frames[frame];
      assert.equal(row.present, false);
      assert.equal(row.x, null);
      assert.equal(row.y, null);
      assert.equal(row.matchedPixels, frame === MISSING_FRAME ? 0 : MARKER_SIZE * MARKER_SIZE);
    }

    // A colour absent from the frame produces no matches, not a default origin.
    const wrong = await trackReferenceMarker(root, 'refs/marker.mkv', { color: [0, 255, 0], tolerance: 0 });
    for (const frame of wrong.frames) {
      assert.equal(frame.present, false);
      assert.equal(frame.x, null);
      assert.equal(frame.matchedPixels, 0);
      assert.equal(frame.confidence, 0);
    }
    assert.ok(wrong.limitations.some(line => /fully present|never interpolated across gaps/i.test(line)));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('trackReferenceMarker maps a nonzero PTS origin onto the output timeline exactly', async () => {
  const root = await tempDir();
  try {
    await writeProject(root, makeProject({ numerator: 10, denominator: 1 }));
    const refs = await makeReferenceDir(root);
    await makeFixture(refs, 'offset', 5);

    const report = await trackReferenceMarker(root, 'refs/offset.mkv', { color: COLOR });

    assert.equal(report.clock.originPts, '5000');
    assert.equal(report.clock.endPts, '5800');
    assert.equal(report.frames[0].outputFrame, 0, 'origin frame must map to output frame 0');
    assert.equal(report.frames[1].outputFrame, 1);
    assert.equal(report.frames[7].outputFrame, 7);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('trackReferenceMarker rejects an ROI that leaves the source frame and bounded-option violations', async () => {
  const root = await tempDir();
  try {
    await writeProject(root, makeProject({ numerator: 10, denominator: 1 }));
    const refs = await makeReferenceDir(root);
    await makeFixture(refs, 'marker');

    await assert.rejects(
      () =>
        trackReferenceMarker(root, 'refs/marker.mkv', {
          color: COLOR,
          roi: { x: 8, y: 8, width: WIDTH, height: HEIGHT },
        }),
      /exceeds the 64x64 source frame/i,
    );
    await assert.rejects(() =>
      trackReferenceMarker(root, 'refs/marker.mkv', { color: COLOR, roi: { x: 0, y: 0, width: 0, height: 10 } }),
    );
    await assert.rejects(() => trackReferenceMarker(root, 'refs/marker.mkv', { color: [256, 0, 0] }));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('trackReferenceMarker refuses an over-long clip and an over-large native decode before decoding', async () => {
  const root = await tempDir();
  try {
    await writeProject(root, makeProject());
    const refs = await makeReferenceDir(root);

    // 601 frames: just over the 600-frame tracking boundary.
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=32x32:r=601:d=1',
      '-c:v',
      'ffv1',
      '-pix_fmt',
      'gbrp',
      '-f',
      'matroska',
      nodePath.join(refs, 'overlong.mkv'),
    ]);
    await assert.rejects(
      () => trackReferenceMarker(root, 'refs/overlong.mkv', { color: COLOR }),
      /capped at 600 frames/i,
    );

    // 600 frames at 256x256 exceed the 64 MiB native-ROI decode bound.
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=256x256:r=600:d=1',
      '-c:v',
      'ffv1',
      '-pix_fmt',
      'gbrp',
      '-f',
      'matroska',
      nodePath.join(refs, 'huge.mkv'),
    ]);
    await assert.rejects(
      () => trackReferenceMarker(root, 'refs/huge.mkv', { color: COLOR }),
      /capped at 67108864 bytes/i,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('trackReferenceMarker taints provenance by hash and refuses a path whose recorded hash differs', async () => {
  const root = await tempDir();
  try {
    const refs = await makeReferenceDir(root);
    const video = await makeFixture(refs, 'marker');
    const sha256 = await hashFile(video);
    const asset: Asset = {
      id: 'asset_ref',
      revision: 1,
      path: 'refs/marker.mkv',
      sha256,
      type: 'video',
      rights: { origin: 'test-only', license: 'test-only', redistributable: false },
      simulated: true,
    };
    await writeProject(root, makeProject({ numerator: 10, denominator: 1 }, [asset]));

    const report = await trackReferenceMarker(root, 'refs/marker.mkv', { color: COLOR });
    assert.equal(report.source.origin, 'asset');
    assert.equal(report.source.simulated, true);
    assert.ok(!report.limitations.some(line => /provenance is unknown/i.test(line)));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('trackReferenceMarker treats a stale recorded hash as unregistered material, not a match', async () => {
  const root = await tempDir();
  try {
    const refs = await makeReferenceDir(root);
    await makeFixture(refs, 'marker');
    const asset: Asset = {
      id: 'asset_ref',
      revision: 1,
      path: 'refs/marker.mkv',
      sha256: '0'.repeat(64),
      type: 'video',
      rights: { origin: 'test-only', license: 'test-only', redistributable: false },
      simulated: true,
    };
    await writeProject(root, makeProject({ numerator: 10, denominator: 1 }, [asset]));

    const report = await trackReferenceMarker(root, 'refs/marker.mkv', { color: COLOR });
    assert.equal(report.source.origin, 'material', 'a stale recorded hash must not establish identity');
    assert.equal(report.source.simulated, false);
    assert.ok(report.limitations.some(line => /recorded sha256 differs/i.test(line)));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('trackReferenceMarker publishes each run to a unique directory and never deletes prior reports', async () => {
  const root = await tempDir();
  try {
    await writeProject(root, makeProject({ numerator: 10, denominator: 1 }));
    const refs = await makeReferenceDir(root);
    await makeFixture(refs, 'marker');

    const first = await trackReferenceMarker(root, 'refs/marker.mkv', { color: COLOR });
    const second = await trackReferenceMarker(root, 'refs/marker.mkv', { color: COLOR, minPixels: 5 });

    assert.notEqual(first.reportPath, second.reportPath, 'each run must publish to a unique directory');
    assert.notEqual(first.paramsHash, second.paramsHash, 'distinct options must produce distinct parameter hashes');
    const firstOnDisk = JSON.parse(await fs.readFile(nodePath.join(root, first.reportPath), 'utf8'));
    assert.deepEqual(firstOnDisk, first);
    assert.deepEqual(JSON.parse(await fs.readFile(nodePath.join(root, second.reportPath), 'utf8')), second);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
