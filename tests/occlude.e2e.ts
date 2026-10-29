import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { buildProject } from '../src/build/build.js';
import { planBuild } from '../src/build/plan.js';
import { loadProject, saveProject, validateProject } from '../src/project/project.js';
import type { BuildRecord, OutputSettings, Project } from '../src/core/schema.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';

const WIDTH = 64;
const HEIGHT = 48;
const OUTPUT: OutputSettings = {
  width: WIDTH,
  height: HEIGHT,
  fps: { numerator: 25, denominator: 1 },
  sampleRate: 48000,
  channels: 2,
};
const LENGTH = 20;
const START = 14;
const OVERLAP_START = 14;
const OVERLAP_END = 20;
const OVERLAP = OVERLAP_END - OVERLAP_START; // 6
const TOTAL = 34;
const CUT_FRAME = OVERLAP_START + Math.floor(OVERLAP / 2); // 17

// The occluder plate colour and the two shot colours are mutually exclusive.
const OCCLUDER_RGB: [number, number, number] = [0, 255, 0]; // lime
const OCCLUDER_RGB_2: [number, number, number] = [255, 255, 0]; // yellow

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
  return fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-occlude-e2e-'));
}

async function colorClip(root: string, name: string, color: string): Promise<{ path: string; sha256: string }> {
  const path = nodePath.join(root, name);
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:size=${WIDTH}x${HEIGHT}:rate=25`,
    '-frames:v',
    String(LENGTH + 20),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-r',
    '25',
    '-an',
    path,
  ]);
  return { path: name, sha256: await hashFile(path) };
}

/** A solid opaque PNG occluder plate written under the project root. */
async function occluderPng(root: string, name: string, color: string): Promise<{ path: string; sha256: string }> {
  const path = nodePath.join(root, name);
  await ffmpeg(['-f', 'lavfi', '-i', `color=c=${color}:size=${WIDTH}x${HEIGHT}:rate=1`, '-frames:v', '1', path]);
  return { path: name, sha256: await hashFile(path) };
}

/** Decode every frame of the composed result to RGB24 buffers. */
async function decodeFrames(file: string, dir: string): Promise<Buffer[]> {
  const raw = nodePath.join(dir, `rgb-${Math.random().toString(36).slice(2)}.raw`);
  await ffmpeg(['-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-an', raw]);
  const bytes = await fs.readFile(raw);
  const perFrame = WIDTH * HEIGHT * 3;
  assert.equal(bytes.length % perFrame, 0, 'decoded picture must be a whole number of frames');
  const frames: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += perFrame)
    frames.push(bytes.subarray(offset, offset + perFrame));
  await fs.rm(raw, { force: true });
  return frames;
}

/** Fraction of pixels within `tol` of an RGB triple. */
function fractionNear(frame: Buffer, [r, g, b]: [number, number, number], tol = 60): number {
  let hits = 0;
  const total = frame.length / 3;
  for (let i = 0; i < frame.length; i += 3) {
    if (Math.abs(frame[i] - r) <= tol && Math.abs(frame[i + 1] - g) <= tol && Math.abs(frame[i + 2] - b) <= tol) hits++;
  }
  return hits / total;
}

const reused = (build: BuildRecord, kind: string): boolean | undefined =>
  build.operations.find(operation => operation.kind === kind)?.reused;

function resultPath(root: string, build: BuildRecord): string {
  assert.ok(build.result, 'a succeeded build must have a result');
  const artifact = build.artifacts.find(candidate => candidate.id === build.result!.artifact);
  assert.ok(artifact, 'the result artifact must be registered');
  return nodePath.join(root, artifact.path);
}

/**
 * Author a two-shot project whose cut is either an occlusion transition (with an
 * opaque `occluder.png` Asset) or a plain dissolve, so the same fixtures cover
 * both the new capability and the untouched no-occlude path.
 */
async function authorProject(root: string, kind: 'occlude' | 'dissolve', occluderSha: string): Promise<void> {
  const red = await colorClip(root, 'red.mp4', 'red');
  const blue = await colorClip(root, 'blue.mp4', 'blue');
  const rights = { origin: 'Original FFmpeg fixture', license: 'CC0-1.0', redistributable: true };
  const transition =
    kind === 'occlude'
      ? {
          from: 'p_a',
          to: 'p_b',
          kind: 'occlude' as const,
          startFrame: OVERLAP_START,
          endFrame: OVERLAP_END,
          occluder: 'occl',
        }
      : { from: 'p_a', to: 'p_b', kind: 'dissolve' as const, startFrame: OVERLAP_START, endFrame: OVERLAP_END };
  const project: Project = validateProject({
    schemaVersion: 1,
    id: 'occlude_work',
    revision: 1,
    title: 'Occlusion transition',
    direction: {
      intent: 'Hide the cut behind a passing occluder',
      looks: [{ id: 'flat', description: 'Flat' }],
      transitions: [],
    },
    assets: [
      { id: 'red', revision: 1, path: red.path, sha256: red.sha256, type: 'video', rights, simulated: false },
      { id: 'blue', revision: 1, path: blue.path, sha256: blue.sha256, type: 'video', rights, simulated: false },
      { id: 'occl', revision: 1, path: 'occluder.png', sha256: occluderSha, type: 'image', rights, simulated: false },
    ],
    bindings: {},
    sources: [],
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: 'Two flat plates' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'flat', intent: 'Plate', targetFrames: TOTAL }],
      placements: [
        { id: 'p_a', shot: 'shot', asset: 'red', inFrame: 0, outFrame: LENGTH, startFrame: 0, audio: 'mute' },
        { id: 'p_b', shot: 'shot', asset: 'blue', inFrame: 0, outFrame: LENGTH, startFrame: START, audio: 'mute' },
      ],
      transitions: [transition],
      audio: [],
    },
  });
  await fs.writeFile(nodePath.join(root, 'project.json'), JSON.stringify(project));
}

test('a built occlusion transition hides the cut behind an opaque occluder and keys on the occluder bytes', async () => {
  const root = await tempDir();
  try {
    const occl = await occluderPng(root, 'occluder.png', 'lime');
    await authorProject(root, 'occlude', occl.sha256);
    const simulatedProject = await loadProject(root);
    simulatedProject.assets.find(asset => asset.id === 'occl')!.simulated = true;
    await saveProject(root, simulatedProject, simulatedProject.revision);

    const first = await buildProject(root);
    assert.equal(first.status, 'succeeded');
    assert.equal(first.result?.simulated, true, 'a simulated occluder taints the composed result');
    assert.equal(first.artifacts.find(artifact => artifact.operation === 'compose-video')?.simulated, true);
    assert.equal(reused(first, 'compose-video'), false);
    const out = resultPath(root, first);
    assert.equal(
      (
        await runCommand('ffprobe', [
          '-v',
          'error',
          '-count_frames',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=nb_read_frames',
          '-of',
          'csv=p=0',
          out,
        ])
      ).trim(),
      String(TOTAL),
      'the union length must be preserved',
    );

    const frames = await decodeFrames(out, root);
    const atCut = fractionNear(frames[CUT_FRAME], OCCLUDER_RGB);
    assert.ok(atCut > 0.95, `the cut frame must be dominated by the occluder colour (got ${atCut.toFixed(3)})`);
    assert.ok(
      fractionNear(frames[CUT_FRAME], [255, 0, 0]) < 0.05 && fractionNear(frames[CUT_FRAME], [0, 0, 255]) < 0.05,
      'neither source picture may survive at the cut',
    );
    assert.ok(fractionNear(frames[OVERLAP_START], [255, 0, 0]) > 0.95, 'the overlap opens on the outgoing shot');

    // An unchanged rebuild reuses the picture entirely.
    const second = await buildProject(root);
    assert.equal(second.status, 'succeeded');
    assert.equal(reused(second, 'compose-video'), true, 'an unchanged project must reuse compose-video');

    // Change ONLY the occluder plate's bytes (and its recorded sha256). The
    // occluder participates in the compose-video key, so the picture must rerun;
    // the two flat-media Takes must NOT.
    const occl2 = await occluderPng(root, 'occluder.png', 'yellow');
    const invalidPlan = await planBuild(root);
    assert.equal(invalidPlan.buildable, false);
    assert.ok(invalidPlan.blockers.some(issue => /Asset occl.*recorded Asset digest/.test(issue.message)));
    await assert.rejects(() => buildProject(root), /Asset occl.*recorded Asset digest/);
    const edit = await loadProject(root);
    edit.assets.find(asset => asset.id === 'occl')!.sha256 = occl2.sha256;
    await saveProject(root, edit, edit.revision);

    const third = await buildProject(root);
    assert.equal(third.status, 'succeeded');
    assert.equal(
      reused(third, 'compose-video'),
      false,
      'changing the occluder Asset bytes must invalidate compose-video',
    );
    assert.ok(
      third.operations
        .filter(operation => operation.kind === 'normalize-media')
        .every(operation => operation.reused === true),
      'the flat-media Takes must be reused',
    );

    const frames2 = await decodeFrames(resultPath(root, third), root);
    assert.ok(
      fractionNear(frames2[CUT_FRAME], OCCLUDER_RGB_2) > 0.95,
      'the rebuilt cut must use the new occluder colour',
    );
    assert.ok(fractionNear(frames2[CUT_FRAME], OCCLUDER_RGB) < 0.05, 'the old occluder colour must be gone');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a project with no occlusion transition is unaffected and reuses normally', async () => {
  const root = await tempDir();
  try {
    const occl = await occluderPng(root, 'occluder.png', 'lime');
    await authorProject(root, 'dissolve', occl.sha256);

    const first = await buildProject(root);
    assert.equal(first.status, 'succeeded');
    assert.equal(
      (
        await runCommand('ffprobe', [
          '-v',
          'error',
          '-count_frames',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=nb_read_frames',
          '-of',
          'csv=p=0',
          resultPath(root, first),
        ])
      ).trim(),
      String(TOTAL),
    );
    const second = await buildProject(root);
    assert.equal(second.status, 'succeeded');
    assert.equal(
      reused(second, 'compose-video'),
      true,
      'a no-occlude project must reuse compose-video on an unchanged rebuild',
    );

    // Authoring an occlude transition without an occluder is refused loudly.
    const edit = await loadProject(root);
    const broken = {
      ...edit,
      composition: {
        ...edit.composition,
        transitions: [
          { from: 'p_a', to: 'p_b', kind: 'occlude' as const, startFrame: OVERLAP_START, endFrame: OVERLAP_END },
        ],
      },
    };
    assert.throws(() => validateProject(broken), /requires an `occluder`/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
