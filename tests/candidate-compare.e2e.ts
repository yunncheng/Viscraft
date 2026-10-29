/**
 * E2E: candidate-Take comparison in `reviewBuild`.
 *
 * `plan.candidates` makes a Build render every candidate Source's Take without
 * composing them all. This test proves the review layer now *compares* them:
 * one real comparison strip per candidate shot (first / middle / last frame of
 * each candidate artifact, one row per candidate) plus a `candidateComparisons`
 * report field that reports each Take's own frame count and marks the Take the
 * composed result actually uses.
 *
 * The fixture uses two real Code Sources rendered through the normal Browser
 * backend, so no Provider or network is involved. It assumes a real browser +
 * FFmpeg are installed (see `viscraft doctor`).
 */

import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildProject } from '../src/build/build.js';
import { reviewBuild } from '../src/operations/analysis/review.js';
import { validateProject } from '../src/project/project.js';
import type { Project } from '../src/core/schema.js';
import { makeSignalAsset } from './audio-fixtures.js';

const CANDIDATE_SIGNAL = makeSignalAsset({
  id: 'bed',
  path: 'bed.wav',
  sampleRate: 48000,
  channels: 2,
  samples: 12800,
  frequency: 440,
});
const PLAIN_SIGNAL = makeSignalAsset({
  id: 'bed',
  path: 'bed.wav',
  sampleRate: 48000,
  channels: 2,
  samples: 9600,
  frequency: 330,
});

const OUTPUT = {
  width: 96,
  height: 64,
  fps: { numerator: 30, denominator: 1 },
  sampleRate: 48000 as const,
  channels: 2 as const,
};

/** A tiny deterministic CPU-canvas CodeScene: a coloured field plus a bar that moves per frame. */
const SCENE = `<!doctype html><html><body style="margin:0;background:#000"><canvas id="c" style="display:block"></canvas><script>
window.viscraft = { render(ctx) {
  var c = document.getElementById('c');
  c.width = ctx.width; c.height = ctx.height;
  var g = c.getContext('2d');
  var col = ctx.params.color || [10, 10, 10];
  g.fillStyle = 'rgb(' + col[0] + ',' + col[1] + ',' + col[2] + ')';
  g.fillRect(0, 0, ctx.width, ctx.height);
  var x = (ctx.frame * 7) % Math.max(1, ctx.width - 4);
  g.fillStyle = '#ffffff';
  g.fillRect(x, 0, 4, ctx.height);
}};</script></body></html>`;

/** One shot with two real candidate Sources of DIFFERENT lengths; the edit uses `cand_a`. */
function candidateProject(): Project {
  return validateProject({
    schemaVersion: 1,
    id: 'candidate-compare-e2e',
    revision: 1,
    title: 'Candidate comparison e2e',
    direction: {
      intent: 'Two real candidate Takes for one shot; no Provider is called.',
      looks: [{ id: 'look', description: 'flat canvas' }],
      transitions: [],
    },
    assets: [CANDIDATE_SIGNAL.asset],
    bindings: {},
    sources: [
      {
        id: 'cand_a',
        kind: 'browser',
        output: 'picture',
        entry: 'scene.html',
        resources: [],
        bindings: [],
        params: { color: [180, 20, 60] },
        seed: 1,
        frames: 12,
      },
      {
        id: 'cand_b',
        kind: 'browser',
        output: 'picture',
        entry: 'scene.html',
        resources: [],
        bindings: [],
        params: { color: [20, 60, 180] },
        seed: 2,
        frames: 10,
      },
    ],
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: 'one candidate shot' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: 'pick candidate a', targetFrames: 8 }],
      placements: [
        { id: 'edit', shot: 'shot', source: 'cand_a', inFrame: 0, outFrame: 8, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio: [
        {
          id: 'bed',
          kind: 'asset',
          asset: 'bed',
          inSample: 0,
          startSample: 0,
          durationSamples: 12800,
          gain: 0.2,
          fadeInSamples: 0,
          fadeOutSamples: 800,
        },
      ],
    },
  });
}

/** A single simulated shot with no candidate plan at all. */
function plainProject(): Project {
  return validateProject({
    schemaVersion: 1,
    id: 'candidate-absent-e2e',
    revision: 1,
    title: 'No candidate plan',
    direction: {
      intent: 'Control fixture without candidates.',
      looks: [{ id: 'look', description: 'test pattern' }],
      transitions: [],
    },
    assets: [PLAIN_SIGNAL.asset],
    bindings: {},
    sources: [
      {
        id: 'solo',
        kind: 'simulated',
        prompt: 'SIMULATED control',
        frames: 12,
        seed: 3,
        attempt: 'attempt-solo',
        behavior: 'success',
      },
    ],
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: 'one shot' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: 'control', targetFrames: 6 }],
      placements: [{ id: 'edit', shot: 'shot', source: 'solo', inFrame: 0, outFrame: 6, startFrame: 0, audio: 'mute' }],
      transitions: [],
      audio: [
        {
          id: 'bed',
          kind: 'asset',
          asset: 'bed',
          inSample: 0,
          startSample: 0,
          durationSamples: 9600,
          gain: 0.2,
          fadeInSamples: 0,
          fadeOutSamples: 800,
        },
      ],
    },
  });
}

test('reviewBuild compares candidate Takes and marks the composed selection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-candidate-compare-'));
  try {
    await writeFile(join(root, 'project.json'), JSON.stringify(candidateProject(), null, 2));
    await writeFile(join(root, 'scene.html'), SCENE);
    await writeFile(join(root, CANDIDATE_SIGNAL.asset.path), CANDIDATE_SIGNAL.bytes);

    const candidates = [{ shot: 'shot', sources: ['cand_a', 'cand_b'] }];
    const build = await buildProject(root, { candidates });
    assert.equal(build.status, 'succeeded');
    assert.deepEqual(build.plan.candidates, candidates);
    assert.equal(build.takes.length, 2, 'both candidate Sources must produce a real Take');

    const review = await reviewBuild(root);
    assert.equal(review.build, build.id);
    assert.equal(review.candidateComparisons.length, 1);

    const comparison = review.candidateComparisons[0];
    assert.equal(comparison.shot, 'shot');
    assert.ok(comparison.strip, 'a comparison strip path must be surfaced');

    // The strip is a real openable PNG beside the other review products:
    // 3 columns (first / middle / last) x 2 rows (one per candidate).
    const strip = await readFile(join(root, comparison.strip!));
    assert.equal(strip.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'expected a real PNG signature');
    assert.equal(strip.readUInt32BE(16), 3 * 320, 'three cells across');
    const stripHeight = strip.readUInt32BE(20);
    assert.equal(stripHeight % 2, 0);
    const rowHeight = stripHeight / 2;
    assert.ok(
      Math.abs(rowHeight - (320 * OUTPUT.height) / OUTPUT.width) <= 2,
      `row height ${rowHeight} must track the 96x64 aspect`,
    );

    // Entries follow the authored candidate order and report each Take's OWN facts.
    assert.deepEqual(
      comparison.entries.map(entry => entry.source),
      ['cand_a', 'cand_b'],
    );
    const ownFrames: Record<string, number> = { cand_a: 12, cand_b: 10 };
    for (const entry of comparison.entries) {
      const take = build.takes.find(candidate => candidate.source === entry.source)!;
      if (take.medium !== 'picture') assert.fail(`candidate Take ${take.id} must be a picture Take`);
      const artifact = build.artifacts.find(candidate => candidate.id === entry.artifact)!;
      assert.equal(entry.take, take.id);
      assert.equal(entry.artifact, take.artifact);
      assert.equal(entry.frames, ownFrames[entry.source], `Take for ${entry.source} must report its own frame count`);
      assert.equal(entry.frames, take.frames);
      assert.deepEqual(entry.fps, OUTPUT.fps);
      assert.equal(entry.simulated, false, 'real Code Takes are not simulated');
      assert.equal(entry.sha256, artifact.sha256);
    }

    // The composed result uses `cand_a`, so exactly one candidate is selected.
    const selected = comparison.entries.filter(entry => entry.selected);
    assert.equal(selected.length, 1, 'exactly one candidate must be selected');
    assert.equal(selected[0].source, 'cand_a');

    // The report carries the same comparison data and the candidate artifacts verify.
    const report = JSON.parse(await readFile(join(root, review.report), 'utf8'));
    assert.deepEqual(report.candidateComparisons, review.candidateComparisons);
    for (const entry of comparison.entries) {
      const check = report.artifacts.find(
        (artifact: { id: string; hashMatches: boolean }) => artifact.id === entry.artifact,
      );
      assert.ok(check && check.hashMatches, `candidate artifact ${entry.artifact} must verify`);
    }

    // Idempotence: a second review reproduces identical strip bytes and report bytes.
    const firstReportBytes = await readFile(join(root, review.report), 'utf8');
    const second = await reviewBuild(root);
    assert.deepEqual(second.candidateComparisons, review.candidateComparisons);
    assert.ok(
      strip.equals(await readFile(join(root, comparison.strip!))),
      'the comparison sheet must be byte-identical across reviews',
    );
    assert.equal(
      await readFile(join(root, second.report), 'utf8'),
      firstReportBytes,
      'the report must be byte-identical across reviews',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reviewBuild writes no comparison product when the Build declared no candidates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-candidate-absent-'));
  try {
    await writeFile(join(root, 'project.json'), JSON.stringify(plainProject(), null, 2));
    await writeFile(join(root, PLAIN_SIGNAL.asset.path), PLAIN_SIGNAL.bytes);
    const build = await buildProject(root);
    assert.equal(build.status, 'succeeded');
    assert.equal(build.plan.candidates, undefined);

    const review = await reviewBuild(root);
    assert.deepEqual(review.candidateComparisons, [], 'no candidates yields an empty comparison list');

    const report = JSON.parse(await readFile(join(root, review.report), 'utf8'));
    assert.deepEqual(report.candidateComparisons, []);

    const reviewDir = join(root, '.viscraft', 'reviews', build.id);
    const entries = await readdir(reviewDir);
    assert.equal(entries.filter(entry => entry.startsWith('candidate-')).length, 0, 'no candidate PNG is written');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
