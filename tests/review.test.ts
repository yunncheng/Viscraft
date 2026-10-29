import { createSymlinkFixture } from './fs-fixtures.js';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { buildProject } from '../src/build/build.js';
import { reviewBuild } from '../src/operations/analysis/review.js';
import { hashFile } from '../src/shared/hash.js';
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
  return fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-review-test-'));
}

/** Three 20-frame simulated shots (two cuts) plus one registered audio signal Asset and one subtitle. */
function makeProject(): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'review_test',
    revision: 1,
    title: 'Review Test',
    direction: {
      intent: 'Three-shot simulated build for review coverage.',
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
      {
        id: 'src_c',
        kind: 'simulated',
        prompt: 'shot c',
        frames: 20,
        seed: 3,
        attempt: 'attempt_c',
        behavior: 'success',
      },
    ],
    composition: {
      output: { width: 160, height: 120, fps: { numerator: 25, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene_1', description: 'scene' }],
      shots: [
        { id: 'shot_a', scene: 'scene_1', look: 'look_main', intent: 'a', targetFrames: 20 },
        { id: 'shot_b', scene: 'scene_1', look: 'look_main', intent: 'b', targetFrames: 20 },
        { id: 'shot_c', scene: 'scene_1', look: 'look_main', intent: 'c', targetFrames: 20 },
      ],
      placements: [
        { id: 'pl_a', shot: 'shot_a', source: 'src_a', inFrame: 0, outFrame: 20, startFrame: 0, audio: 'mute' },
        { id: 'pl_b', shot: 'shot_b', source: 'src_b', inFrame: 0, outFrame: 20, startFrame: 20, audio: 'mute' },
        { id: 'pl_c', shot: 'shot_c', source: 'src_c', inFrame: 0, outFrame: 20, startFrame: 40, audio: 'mute' },
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
      subtitles: [{ id: 'sub_1', text: 'Hello world', startFrame: 20, endFrame: 40, fontSize: 32, color: '#ffffff' }],
    },
  });
}

/**
 * Three placements across only TWO unique shots: `shot_x` is placed at the
 * start and the end, with `shot_y` placed between them. A per-shot aggregation
 * would sample a frame from `shot_y` for `shot_x`'s middle still.
 */
function makeRepeatedShotProject(): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'review_repeat',
    revision: 1,
    title: 'Review Repeated Shot',
    direction: {
      intent: 'One shot placed twice with a different shot in between.',
      looks: [{ id: 'look_main', description: 'main look' }],
      transitions: [],
    },
    assets: [SIGNAL.asset],
    bindings: {},
    sources: [
      {
        id: 'src_x1',
        kind: 'simulated',
        prompt: 'shot x, first placement',
        frames: 20,
        seed: 1,
        attempt: 'attempt_x1',
        behavior: 'success',
      },
      {
        id: 'src_y',
        kind: 'simulated',
        prompt: 'shot y',
        frames: 20,
        seed: 2,
        attempt: 'attempt_y',
        behavior: 'success',
      },
      {
        id: 'src_x2',
        kind: 'simulated',
        prompt: 'shot x, second placement',
        frames: 20,
        seed: 3,
        attempt: 'attempt_x2',
        behavior: 'success',
      },
    ],
    composition: {
      output: { width: 160, height: 120, fps: { numerator: 25, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene_1', description: 'scene' }],
      shots: [
        { id: 'shot_x', scene: 'scene_1', look: 'look_main', intent: 'x', targetFrames: 20 },
        { id: 'shot_y', scene: 'scene_1', look: 'look_main', intent: 'y', targetFrames: 20 },
      ],
      placements: [
        { id: 'pl_x1', shot: 'shot_x', source: 'src_x1', inFrame: 0, outFrame: 20, startFrame: 0, audio: 'mute' },
        { id: 'pl_y', shot: 'shot_y', source: 'src_y', inFrame: 0, outFrame: 20, startFrame: 20, audio: 'mute' },
        { id: 'pl_x2', shot: 'shot_x', source: 'src_x2', inFrame: 0, outFrame: 20, startFrame: 40, audio: 'mute' },
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

function pngSize(buffer: Buffer): { width: number; height: number } {
  assert.ok(buffer.length >= 24, 'PNG header is truncated');
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'expected a real PNG signature');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Write the Project and the real audio signal Asset its composition uses. */
async function writeProject(root: string, project: Project): Promise<void> {
  await fs.writeFile(nodePath.join(root, 'project.json'), JSON.stringify(project, null, 2));
  await fs.writeFile(nodePath.join(root, SIGNAL.asset.path), SIGNAL.bytes);
}

/** Half-open [start, end) interval covered by a placement. */
function placementInterval(placement: { startFrame: number; inFrame: number; outFrame: number }): {
  start: number;
  end: number;
} {
  return { start: placement.startFrame, end: placement.startFrame + (placement.outFrame - placement.inFrame) };
}

test('reviewBuild extracts traceable stills and a technical report from a real build', async () => {
  const root = await tempDir();
  try {
    await writeProject(root, makeProject());
    const record = await buildProject(root);
    assert.equal(record.status, 'succeeded');
    assert.ok(record.result, 'a succeeded build must have a result');

    const artifactFiles = record.artifacts.map(artifact => nodePath.join(root, artifact.path));
    const beforeHashes = await Promise.all(artifactFiles.map(hashFile));
    const resultPath = nodePath.join(root, '.viscraft', 'result.json');
    const resultBefore = await fs.readFile(resultPath, 'utf8');
    const projectBefore = await fs.readFile(nodePath.join(root, 'project.json'), 'utf8');

    const review = await reviewBuild(root);
    assert.equal(review.build, record.id);
    assert.equal(review.simulated, true, 'simulated sources must be reported');
    assert.equal(review.seams.length, 2, 'three placements produce two cuts');

    // Contact sheet: one row of three frames per placement (first / middle / last).
    const contact = pngSize(await fs.readFile(nodePath.join(root, review.contactSheet)));
    assert.equal(contact.width, 3 * 320);
    assert.equal(contact.height, 3 * 240, 'three placements stacked vertically');

    // Seam strips: four frames around each cut.
    for (const seamRel of review.seams) {
      const seam = pngSize(await fs.readFile(nodePath.join(root, seamRel)));
      assert.equal(seam.width, 4 * 320);
      assert.equal(seam.height, 240);
    }

    const report = JSON.parse(await fs.readFile(nodePath.join(root, review.report), 'utf8'));
    assert.equal(report.build, record.id);
    assert.equal(report.simulated, true);
    assert.equal(
      report.observation,
      'extracted stills + technical audio analysis; subjective audio review not performed',
    );
    assert.equal(report.timeline.expectedFrames, 60);
    assert.equal(report.final.probe.frames, 60);
    assert.equal(report.final.conformance.framesMatch, true);
    assert.equal(report.final.conformance.fpsMatch, true);
    assert.equal(report.final.conformance.audioMatch, true);
    assert.equal(report.timeline.cuts.length, 2);
    assert.deepEqual(report.timeline.cuts[0].sampledFrames, [18, 19, 20, 21]);

    // Contact cells are scoped to placements, and every cell reports its placement.
    assert.equal(report.timeline.contactSheetCells.length, 9);
    const placementsById = new Map<string, { startFrame: number; inFrame: number; outFrame: number }>(
      report.timeline.placements.map(
        (placement: { id: string; startFrame: number; inFrame: number; outFrame: number }) => [placement.id, placement],
      ),
    );
    for (const cell of report.timeline.contactSheetCells) {
      const placement = placementsById.get(cell.placement);
      assert.ok(placement, `contact cell references placement ${cell.placement}`);
      const { start, end } = placementInterval(placement!);
      assert.ok(
        cell.frame >= start && cell.frame < end,
        `${cell.placement} ${cell.position} frame ${cell.frame} must lie in [${start}, ${end})`,
      );
    }
    assert.deepEqual(
      [...new Set(report.timeline.contactSheetCells.map((cell: { placement: string }) => cell.placement))],
      ['pl_a', 'pl_b', 'pl_c'],
    );

    // Shots are authoring groupings with placement ids, not continuous intervals.
    for (const shot of report.timeline.shots) {
      assert.ok(
        Array.isArray(shot.placementIds) && shot.placementIds.length > 0,
        `shot ${shot.shot} must list its placements`,
      );
      assert.equal('start' in shot, false, 'a shot must not imply one continuous start');
      assert.equal('end' in shot, false, 'a shot must not imply one continuous end');
    }

    // Authored subtitle ranges/text are reported verbatim for frame proofing.
    assert.deepEqual(report.timeline.subtitles, [{ id: 'sub_1', startFrame: 20, endFrame: 40, text: 'Hello world' }]);

    assert.equal(report.audio.expected.sampleRate, 48000);
    assert.equal(report.audio.actual.sampleRate, 48000);
    assert.equal(report.audio.loudness.available, true);
    assert.ok(Number.isFinite(report.audio.loudness.integratedLufs), 'integrated LUFS must be a real measurement');
    assert.ok(Number.isFinite(report.audio.loudness.truePeakDbfs), 'true peak must be a real measurement');
    assert.equal(report.audio.silence.available, true);
    assert.ok(Array.isArray(report.video.blackFrames));
    for (const artifact of report.artifacts)
      assert.equal(artifact.hashMatches, true, `artifact ${artifact.id} must verify`);

    // Review never rewrites the project, the active result or any artifact.
    assert.equal(await fs.readFile(nodePath.join(root, 'project.json'), 'utf8'), projectBefore);
    assert.equal(await fs.readFile(resultPath, 'utf8'), resultBefore);
    assert.deepEqual(await Promise.all(artifactFiles.map(hashFile)), beforeHashes);

    // The reviewed timeline comes from the frozen snapshot, not the live project.
    await fs.writeFile(
      nodePath.join(root, 'project.json'),
      JSON.stringify({ schemaVersion: 1, note: 'edited after the build' }),
    );
    const again = await reviewBuild(root);
    const reportAgain = JSON.parse(await fs.readFile(nodePath.join(root, again.report), 'utf8'));
    assert.equal(reportAgain.timeline.expectedFrames, 60, 'timeline must come from the frozen snapshot');
    assert.equal(again.seams.length, 2);

    // The frozen code file tree may contain a user resource literally named
    // `project.json`; it must never be mistaken for the Project metadata.
    const codeTreeProject = nodePath.join(root, '.viscraft', 'snapshots', record.id, 'project.json');
    await fs.mkdir(nodePath.dirname(codeTreeProject), { recursive: true });
    await fs.writeFile(codeTreeProject, JSON.stringify({ schemaVersion: 1, note: 'decoy user resource' }));
    const withDecoy = await reviewBuild(root);
    assert.equal(withDecoy.build, record.id);
    assert.equal(
      (
        JSON.parse(await fs.readFile(nodePath.join(root, withDecoy.report), 'utf8')) as {
          timeline: { expectedFrames: number };
        }
      ).timeline.expectedFrames,
      60,
    );

    // A damaged artifact fails hash verification before any product is written.
    const finalFile = nodePath.join(
      root,
      record.artifacts.find(artifact => artifact.id === record.result!.artifact)!.path,
    );
    await fs.appendFile(finalFile, 'corrupt');
    await assert.rejects(() => reviewBuild(root), /failed verification|hash mismatch/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('reviewBuild samples each placement, not an aggregated shot span', async () => {
  const root = await tempDir();
  try {
    await writeProject(root, makeRepeatedShotProject());
    const record = await buildProject(root);
    assert.equal(record.status, 'succeeded');

    const review = await reviewBuild(root);
    const report = JSON.parse(await fs.readFile(nodePath.join(root, review.report), 'utf8'));

    // Two unique shots, three placements: a shot is not a continuous interval.
    assert.deepEqual(
      report.timeline.shots.map((shot: { shot: string }) => shot.shot),
      ['shot_x', 'shot_y'],
    );
    const shotX = report.timeline.shots.find((shot: { shot: string }) => shot.shot === 'shot_x');
    assert.deepEqual(
      shotX.placementIds,
      ['pl_x1', 'pl_x2'],
      'a repeated shot lists every placement that references it',
    );

    // One contact row per placement: three rows despite only two shots.
    const contact = pngSize(await fs.readFile(nodePath.join(root, review.contactSheet)));
    assert.equal(contact.width, 3 * 320);
    assert.equal(contact.height, 3 * 240, 'one contact row per placement');

    const cells: Array<{ placement: string; shot: string; position: string; frame: number }> =
      report.timeline.contactSheetCells;
    assert.equal(cells.length, 9, 'three placements x three positions');
    const placementsById = new Map<string, { startFrame: number; inFrame: number; outFrame: number }>(
      report.timeline.placements.map(
        (placement: { id: string; startFrame: number; inFrame: number; outFrame: number }) => [placement.id, placement],
      ),
    );
    for (const cell of cells) {
      const placement = placementsById.get(cell.placement)!;
      assert.ok(placement, `contact cell references placement ${cell.placement}`);
      const { start, end } = placementInterval(placement);
      assert.ok(
        cell.frame >= start && cell.frame < end,
        `${cell.placement} ${cell.position} frame ${cell.frame} must lie inside its own placement [${start}, ${end})`,
      );
    }

    // Every shot_x still must come from its own placement, never shot_y's interval.
    assert.ok(
      cells.filter(cell => cell.shot === 'shot_x').every(cell => cell.frame < 20 || cell.frame >= 40),
      'shot_x cells must stay inside its own placements',
    );
    assert.equal(cells.find(cell => cell.placement === 'pl_x1' && cell.position === 'last')!.frame, 19);
    assert.equal(cells.find(cell => cell.placement === 'pl_x2' && cell.position === 'first')!.frame, 40);

    // The final delivered frame index is exactly the last frame of the timeline.
    assert.equal(report.timeline.expectedFrames, 60);
    assert.equal(report.final.probe.frames, 60);
    assert.equal(
      cells.find(cell => cell.placement === 'pl_x2' && cell.position === 'last')!.frame,
      report.timeline.expectedFrames - 1,
    );

    // Cuts stay placement-bound: pl_x1 -> pl_y -> pl_x2.
    assert.equal(report.timeline.cuts.length, 2);
    assert.equal(report.timeline.cuts[0].from, 'pl_x1');
    assert.equal(report.timeline.cuts[0].to, 'pl_y');
    assert.deepEqual(report.timeline.cuts[0].sampledFrames, [18, 19, 20, 21]);
    assert.equal(report.timeline.cuts[1].from, 'pl_y');
    assert.equal(report.timeline.cuts[1].to, 'pl_x2');
    assert.deepEqual(report.timeline.cuts[1].sampledFrames, [38, 39, 40, 41]);

    // No authored subtitles on this project reports as an empty list, not a guess.
    assert.deepEqual(report.timeline.subtitles, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('concurrent reviews stage frames privately and publish only complete products', async () => {
  const root = await tempDir();
  try {
    await writeProject(root, makeProject());
    const record = await buildProject(root);
    assert.equal(record.status, 'succeeded');

    // Simulate another run's in-flight private staging directory sitting in the
    // review folder. Cleanup must remove only this run's own staging dirs.
    const reviewDir = nodePath.join(root, '.viscraft', 'reviews', record.id);
    const foreignDir = nodePath.join(reviewDir, '.frames-other');
    await fs.mkdir(foreignDir, { recursive: true });
    await fs.writeFile(nodePath.join(foreignDir, 'marker.txt'), 'other run staging');

    // Concurrent publishers and a receiver reading the first completed report
    // must not share frame paths, expose partial JSON or block one another.
    const [first, second, third] = await Promise.all(
      Array.from({ length: 3 }, async () => {
        const review = await reviewBuild(root);
        const published = JSON.parse(await fs.readFile(nodePath.join(root, review.report), 'utf8'));
        assert.equal(published.build, record.id);
        assert.equal(published.timeline.contactSheetCells.length, 9);
        return review;
      }),
    );
    assert.equal(first.build, record.id);
    assert.equal(second.build, record.id);
    assert.equal(first.contactSheet, second.contactSheet);
    assert.equal(first.report, second.report);
    assert.equal(third.report, first.report);

    // Both published products are complete, openable files.
    const contact = pngSize(await fs.readFile(nodePath.join(root, first.contactSheet)));
    assert.equal(contact.width, 3 * 320);
    assert.equal(contact.height, 3 * 240);
    for (const seamRel of first.seams) pngSize(await fs.readFile(nodePath.join(root, seamRel)));
    const report = JSON.parse(await fs.readFile(nodePath.join(root, first.report), 'utf8'));
    assert.equal(report.build, record.id);
    assert.equal(report.timeline.contactSheetCells.length, 9);

    // Cleanup removed only this run's own private staging dirs: the foreign
    // staging directory and its contents survive untouched.
    assert.equal(await fs.readFile(nodePath.join(foreignDir, 'marker.txt'), 'utf8'), 'other run staging');
    const entries = await fs.readdir(reviewDir);
    assert.deepEqual(
      entries.filter(entry => entry.startsWith('.frames-') && entry !== '.frames-other'),
      [],
      "this run's private staging dirs are cleaned up",
    );
    assert.deepEqual(
      entries.filter(entry => !entry.startsWith('.frames-')).sort(),
      ['contact-sheet.png', 'report.json', 'seam-00.png', 'seam-01.png'].sort(),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('reviewBuild cannot be redirected through a stale shared _frames symlink', async t => {
  const root = await tempDir();
  try {
    await writeProject(root, makeProject());
    const record = await buildProject(root);
    assert.equal(record.status, 'succeeded');

    // An unowned shared-looking path must not redirect private frame extraction
    // outside the Project.
    const reviewDir = nodePath.join(root, '.viscraft', 'reviews', record.id);
    const outside = nodePath.join(root, 'outside');
    await fs.mkdir(reviewDir, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await createSymlinkFixture(t, outside, nodePath.join(reviewDir, '_frames'));

    const review = await reviewBuild(root);
    assert.equal(review.build, record.id);

    // No frame or tiling artifact leaked through the symlink.
    assert.deepEqual(await fs.readdir(outside), [], 'private work must not be written through the _frames symlink');

    // Real products were still published as complete files.
    const contact = pngSize(await fs.readFile(nodePath.join(root, review.contactSheet)));
    assert.equal(contact.width, 3 * 320);
    assert.equal(contact.height, 3 * 240);
    const report = JSON.parse(await fs.readFile(nodePath.join(root, review.report), 'utf8'));
    assert.equal(report.timeline.contactSheetCells.length, 9);

    // The private staging directory used for this run is gone; the decoy symlink
    // is left as-is (review owns neither).
    const leftovers = (await fs.readdir(reviewDir)).filter(entry => entry.startsWith('.frames-'));
    assert.deepEqual(leftovers, [], "this run's private staging dirs are cleaned up");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('reviewBuild rejects unknown, failed and result-less builds', async () => {
  const root = await tempDir();
  try {
    await assert.rejects(() => reviewBuild(root, 'build-missing'), /no build record/i);

    await fs.mkdir(nodePath.join(root, '.viscraft', 'builds'), { recursive: true });
    const failed = {
      schemaVersion: 1,
      id: 'build-failed-001',
      run: { id: 'run-failed-001', goal: 'failed probe' },
      plan: { operations: [] },
      revision: 1,
      snapshotHash: '',
      status: 'failed',
      medium: 'picture',
      startedAt: new Date().toISOString(),
      error: 'boom',
      operations: [],
      artifacts: [],
      takes: [],
    };
    await fs.writeFile(nodePath.join(root, '.viscraft', 'builds', 'build-failed-001.json'), JSON.stringify(failed));

    await assert.rejects(() => reviewBuild(root), /no successful build with a film result/i);
    await assert.rejects(() => reviewBuild(root, 'build-failed-001'), /no result to review/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
