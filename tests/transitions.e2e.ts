import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { buildProject } from '../src/build/build.js';
import { reviewBuild } from '../src/operations/analysis/review.js';
import { loadProject, saveProject, validateProject } from '../src/project/project.js';
import type { BuildRecord, Composition, OutputSettings, Project } from '../src/core/schema.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';

const WIDTH = 64;
const HEIGHT = 48;
const FPS = { numerator: 25, denominator: 1 };
const OUTPUT: OutputSettings = { width: WIDTH, height: HEIGHT, fps: FPS, sampleRate: 48000, channels: 2 };
const LENGTH = 20;
const START = 14;

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
  return fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-transitions-e2e-'));
}

async function colorAsset(root: string, name: string, color: string): Promise<{ path: string; sha256: string }> {
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

/** Author a two-shot project whose cut mixes `kind` over the explicit overlap [14, 20). */
async function authorProject(root: string, kind: 'dissolve' | 'wipeleft'): Promise<void> {
  const red = await colorAsset(root, 'red.mp4', 'red');
  const blue = await colorAsset(root, 'blue.mp4', 'blue');
  const project: Project = validateProject({
    schemaVersion: 1,
    id: 'transition_work',
    revision: 1,
    title: 'Transition reuse',
    direction: { intent: 'Between-shot transition', looks: [{ id: 'flat', description: 'Flat' }], transitions: [] },
    assets: [
      {
        id: 'red',
        revision: 1,
        path: red.path,
        sha256: red.sha256,
        type: 'video',
        rights: { origin: 'Original FFmpeg fixture', license: 'CC0-1.0', redistributable: true },
        simulated: false,
      },
      {
        id: 'blue',
        revision: 1,
        path: blue.path,
        sha256: blue.sha256,
        type: 'video',
        rights: { origin: 'Original FFmpeg fixture', license: 'CC0-1.0', redistributable: true },
        simulated: false,
      },
    ],
    bindings: {},
    sources: [],
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: 'Two flat plates' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'flat', intent: 'Plate', targetFrames: 34 }],
      placements: [
        { id: 'p_a', shot: 'shot', asset: 'red', inFrame: 0, outFrame: LENGTH, startFrame: 0, audio: 'mute' },
        { id: 'p_b', shot: 'shot', asset: 'blue', inFrame: 0, outFrame: LENGTH, startFrame: START, audio: 'mute' },
      ],
      transitions: [{ from: 'p_a', to: 'p_b', kind, startFrame: 14, endFrame: 20 }],
      audio: [],
    },
  });
  await fs.writeFile(nodePath.join(root, 'project.json'), JSON.stringify(project));
}

const takeIds = (build: BuildRecord): string[] => build.takes.map(take => take.id).sort();
const reused = (build: BuildRecord, kind: string): boolean | undefined =>
  build.operations.find(operation => operation.kind === kind)?.reused;

test('changing only the transition kind re-runs compose-video while the Takes are reused', async () => {
  const root = await tempDir();
  try {
    await authorProject(root, 'dissolve');
    const first = await buildProject(root);
    assert.equal(first.status, 'succeeded');
    assert.equal(reused(first, 'compose-video'), false, 'a fresh build must run compose-video');
    assert.equal(reused(first, 'mux-final'), false, 'a fresh build must run mux-final');
    const mediaOps = first.operations.filter(operation => operation.kind === 'normalize-media');
    assert.ok(mediaOps.length >= 2, 'both flat assets must be normalized');
    assert.ok(
      mediaOps.every(operation => operation.reused === false),
      'a fresh build must run the media normalization',
    );
    const takesBefore = takeIds(first);
    assert.equal(takesBefore.length, 2, 'one Take per flat-media source');

    // Edit ONLY the transition kind. The overlap, range, placements and assets
    // are byte-identical, so only the transition-keyed picture work should rerun.
    const edit = await loadProject(root);
    edit.composition!.transitions[0].kind = 'wipeleft';
    await saveProject(root, edit, edit.revision);

    const second = await buildProject(root);
    assert.equal(second.status, 'succeeded');
    assert.equal(
      reused(second, 'compose-video'),
      false,
      'changing the transition kind must invalidate the cached compose-video',
    );
    assert.equal(reused(second, 'mux-final'), false, 'a changed picture must re-run mux-final');
    assert.deepEqual(takeIds(second), takesBefore, 'the source Takes must be reused unchanged');
    assert.ok(
      second.operations
        .filter(operation => operation.kind === 'normalize-media')
        .every(operation => operation.reused === true),
      'the flat-media Takes must be reused without renormalizing',
    );

    // An unchanged project must reuse compose-video entirely.
    const third = await buildProject(root);
    assert.equal(third.status, 'succeeded');
    assert.equal(reused(third, 'compose-video'), true, 'an unchanged project must reuse compose-video');
    assert.deepEqual(takeIds(third), takesBefore, 'an unchanged project must keep the same Takes');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/**
 * Author a two-plate HARD-CUT project (adjacent placements, zero overlap) with
 * an optional Match-Cut assertion. `matchCuts` is metadata only: it must not
 * change a single rendered pixel.
 */
async function authorMatchCutProject(root: string, matchCuts?: Composition['matchCuts']): Promise<void> {
  const red = await colorAsset(root, 'red.mp4', 'red');
  const blue = await colorAsset(root, 'blue.mp4', 'blue');
  const project: Project = validateProject({
    schemaVersion: 1,
    id: 'match_cut_work',
    revision: 1,
    title: 'Match cut fact',
    direction: { intent: 'Hard-cut match cut', looks: [{ id: 'flat', description: 'Flat' }], transitions: [] },
    assets: [
      {
        id: 'red',
        revision: 1,
        path: red.path,
        sha256: red.sha256,
        type: 'video',
        rights: { origin: 'Original FFmpeg fixture', license: 'CC0-1.0', redistributable: true },
        simulated: false,
      },
      {
        id: 'blue',
        revision: 1,
        path: blue.path,
        sha256: blue.sha256,
        type: 'video',
        rights: { origin: 'Original FFmpeg fixture', license: 'CC0-1.0', redistributable: true },
        simulated: false,
      },
    ],
    bindings: {},
    sources: [],
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: 'Two flat plates' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'flat', intent: 'Plate', targetFrames: LENGTH * 2 }],
      placements: [
        { id: 'p_a', shot: 'shot', asset: 'red', inFrame: 0, outFrame: LENGTH, startFrame: 0, audio: 'mute' },
        { id: 'p_b', shot: 'shot', asset: 'blue', inFrame: 0, outFrame: LENGTH, startFrame: LENGTH, audio: 'mute' },
      ],
      transitions: [],
      ...(matchCuts !== undefined ? { matchCuts } : {}),
      audio: [],
    },
  });
  await fs.writeFile(nodePath.join(root, 'project.json'), JSON.stringify(project));
}

const finalSha = (build: BuildRecord): string => {
  assert.ok(build.result, 'a succeeded build must have a result');
  const artifact = build.artifacts.find(candidate => candidate.id === build.result!.artifact);
  assert.ok(artifact, 'the result artifact must be registered');
  return artifact.sha256;
};

test('a match-cut declaration is metadata only and is reported by review as a FACT, not a verdict', async () => {
  const root = await tempDir();
  try {
    // 1) Baseline hard cut with NO match-cut declaration.
    await authorMatchCutProject(root);
    const baseline = await buildProject(root);
    assert.equal(baseline.status, 'succeeded');
    const baselineSha = finalSha(baseline);
    assert.equal(await probeMediaPath(root, baseline), LENGTH * 2);

    // 2) Declare a match cut. This is metadata: the picture must be untouched.
    await authorMatchCutProject(root, [
      { from: 'p_a', to: 'p_b', subject: 'front_wheel', action: 'clockwise_rotation', fromFrame: 18, toFrame: 2 },
    ]);
    const declared = await buildProject(root);
    assert.equal(declared.status, 'succeeded');
    assert.equal(finalSha(declared), baselineSha, 'declaring a match cut must not change the rendered picture bytes');
    assert.equal(reused(declared, 'compose-video'), true, 'declaring a match cut must not invalidate the picture work');

    // 3) Review reports the declaration plus the REAL boundary frames as facts.
    const review = await reviewBuild(root, declared.id);
    const report = JSON.parse(await fs.readFile(nodePath.join(root, review.report), 'utf8')) as {
      matchCuts: Array<Record<string, unknown>>;
      limitations: string[];
    };
    assert.equal(report.matchCuts.length, 1, 'exactly one declared match cut must be reported');
    const fact = report.matchCuts[0];
    assert.equal(fact.from, 'p_a');
    assert.equal(fact.to, 'p_b');
    assert.equal(fact.subject, 'front_wheel');
    assert.equal(fact.action, 'clockwise_rotation');
    assert.equal(fact.declaredFromFrame, 18);
    assert.equal(fact.declaredToFrame, 2);
    assert.equal(fact.cutFrame, LENGTH, 'the real cut boundary is the incoming placement start');
    assert.deepEqual(fact.boundary, { fromEndFrame: LENGTH, toStartFrame: LENGTH, overlapFrames: 0, hardCut: true });
    assert.equal(fact.fromAnchorOutputFrame, 18);
    assert.equal(fact.toAnchorOutputFrame, LENGTH + 2);
    assert.equal(fact.fromAnchorInsidePlacement, true);
    assert.equal(fact.toAnchorInsidePlacement, true);

    // It is a FACT, not a verdict: no score/pass/fail/similarity field exists,
    // and the recorded observation says so explicitly.
    for (const verdictKey of ['score', 'similarity', 'passed', 'failed', 'verdict', 'match', 'quality']) {
      assert.ok(!Object.hasOwn(fact, verdictKey), `a match cut must not report a "${verdictKey}" verdict`);
    }
    assert.match(String(fact.observation), /no subject-similarity score is computed/);
    assert.ok(
      report.limitations.some(line => /matchCut/.test(line)),
      'the report must state the match-cut limitation',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/** Probe the result artifact's frame count from a build record. */
async function probeMediaPath(root: string, build: BuildRecord): Promise<number> {
  const artifact = build.artifacts.find(candidate => candidate.id === build.result!.artifact);
  assert.ok(artifact, 'the result artifact must be registered');
  const probe = JSON.parse(
    await runCommand('ffprobe', [
      '-v',
      'error',
      '-count_frames',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=nb_read_frames',
      '-of',
      'json',
      nodePath.join(root, artifact.path),
    ]),
  ) as { streams?: Array<{ nb_read_frames?: string }> };
  return Number(probe.streams?.[0]?.nb_read_frames);
}
