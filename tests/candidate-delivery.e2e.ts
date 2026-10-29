/**
 * E2E: candidate-Take comparison strips in the delivery bundle.
 *
 * `reviewBuild` writes a `candidate-<shot>.png` strip per shot the Build declared
 * `plan.candidates` for, plus a `candidateComparisons` report field marking the
 * Take the frozen composition actually selected. This test proves
 * `deliverProject` now carries that product through the whole delivery path:
 * every strip is copied into `review/`, hashed like any other member, listed in
 * `delivery-manifest.json` with `candidate-comparison` provenance, and surfaced
 * in the static index — and that a Build with no candidate plan adds none of it.
 *
 * The fixture uses real Code Sources rendered through the normal Browser backend,
 * so no Provider or network is involved. It assumes a real browser + FFmpeg are
 * installed (see `viscraft doctor`).
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { buildProject } from '../src/build/build.js';
import { reviewBuild } from '../src/operations/analysis/review.js';
import { deliverProject } from '../src/operations/delivery/delivery.js';
import { hashFile } from '../src/shared/hash.js';
import { validateProject } from '../src/project/project.js';
import type { Project } from '../src/core/schema.js';
import { makeSignalAsset } from './audio-fixtures.js';

const SIGNAL = makeSignalAsset({
  id: 'bed',
  path: 'bed.wav',
  sampleRate: 48000,
  channels: 2,
  samples: 19200,
  frequency: 440,
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

/**
 * Two shots, each authored with TWO real candidate Code Sources. The composition
 * selects `cand_a1` for `shot_a` and `cand_b1` for `shot_b`, so review writes one
 * comparison strip per shot (two strips total) and marks exactly one candidate
 * selected per shot.
 */
function candidateProject(): Project {
  return validateProject({
    schemaVersion: 1,
    id: 'candidate-delivery-e2e',
    revision: 1,
    title: 'Candidate delivery e2e',
    direction: {
      intent: 'Two shots, two real candidate Takes each; no Provider is called.',
      looks: [{ id: 'look', description: 'flat canvas' }],
      transitions: [],
    },
    assets: [SIGNAL.asset],
    bindings: {},
    sources: [
      {
        id: 'cand_a1',
        kind: 'browser',
        output: 'picture',
        entry: 'scene.html',
        resources: [],
        bindings: [],
        params: { color: [200, 30, 40] },
        seed: 1,
        frames: 10,
      },
      {
        id: 'cand_a2',
        kind: 'browser',
        output: 'picture',
        entry: 'scene.html',
        resources: [],
        bindings: [],
        params: { color: [30, 200, 40] },
        seed: 2,
        frames: 10,
      },
      {
        id: 'cand_b1',
        kind: 'browser',
        output: 'picture',
        entry: 'scene.html',
        resources: [],
        bindings: [],
        params: { color: [40, 30, 200] },
        seed: 3,
        frames: 10,
      },
      {
        id: 'cand_b2',
        kind: 'browser',
        output: 'picture',
        entry: 'scene.html',
        resources: [],
        bindings: [],
        params: { color: [200, 200, 30] },
        seed: 4,
        frames: 10,
      },
    ],
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: 'two candidate shots' }],
      shots: [
        { id: 'shot_a', scene: 'scene', look: 'look', intent: 'pick candidate a1', targetFrames: 6 },
        { id: 'shot_b', scene: 'scene', look: 'look', intent: 'pick candidate b1', targetFrames: 6 },
      ],
      placements: [
        { id: 'edit_a', shot: 'shot_a', source: 'cand_a1', inFrame: 0, outFrame: 6, startFrame: 0, audio: 'mute' },
        { id: 'edit_b', shot: 'shot_b', source: 'cand_b1', inFrame: 0, outFrame: 6, startFrame: 6, audio: 'mute' },
      ],
      transitions: [],
      audio: [
        {
          id: 'bed',
          kind: 'asset',
          asset: 'bed',
          inSample: 0,
          startSample: 0,
          durationSamples: 19200,
          gain: 0.2,
          fadeInSamples: 0,
          fadeOutSamples: 800,
        },
      ],
    },
  });
}

async function writeProject(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(nodePath.join(root, 'project.json'), JSON.stringify(candidateProject(), null, 2));
  await fs.writeFile(nodePath.join(root, 'scene.html'), SCENE);
  await fs.writeFile(nodePath.join(root, SIGNAL.asset.path), SIGNAL.bytes);
}

interface ManifestFile {
  path: string;
  sha256: string;
  bytes: number;
  role: string;
  provenance?: { kind?: string; build?: string; shot?: string };
}
interface Manifest {
  files: ManifestFile[];
  review: { candidates: string[]; candidatesSha256: string[] };
  notes: string[];
}

/** Parse the candidate section of the static index into per-shot candidate rows. */
function candidateRowsByShot(indexHtml: string): Map<string, Array<{ source: string; selected: boolean }>> {
  const section = /<section id="candidates">([\s\S]*?)<\/section>/.exec(indexHtml);
  assert.ok(section, 'the candidate section must be present in the index');
  const byShot = new Map<string, Array<{ source: string; selected: boolean }>>();
  for (const block of section![1].matchAll(/<h3>(.*?)<\/h3>([\s\S]*?)(?=<h3>|$)/g)) {
    const rows = [...block[2].matchAll(/<tr>((?:<td>.*?<\/td>)+)<\/tr>/g)].map(row => {
      const cells = [...row[1].matchAll(/<td>(.*?)<\/td>/g)].map(cell => cell[1]);
      return { source: cells[0], selected: cells[4] === 'yes' };
    });
    byShot.set(block[1], rows);
  }
  return byShot;
}

test('deliverProject bundles candidate-Take strips, hashes them and marks the selected candidate', async () => {
  const parent = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-candidate-delivery-'));
  const root = nodePath.join(parent, 'authoring');
  const destination = nodePath.join(parent, 'bundle');
  try {
    await writeProject(root);

    const candidates = [
      { shot: 'shot_a', sources: ['cand_a1', 'cand_a2'] },
      { shot: 'shot_b', sources: ['cand_b1', 'cand_b2'] },
    ];
    const record = await buildProject(root, { candidates });
    assert.equal(record.status, 'succeeded');
    assert.equal(record.takes.length, 4, 'every candidate Source must produce a real Take');

    const review = await reviewBuild(root);
    assert.equal(review.candidateComparisons.length, 2, 'one comparison per candidate shot');
    for (const comparison of review.candidateComparisons) {
      assert.ok(comparison.strip, `shot ${comparison.shot} must surface a comparison strip`);
      assert.equal(comparison.entries.length, 2, `shot ${comparison.shot} must compare both candidates`);
      assert.equal(
        comparison.entries.filter(entry => entry.selected).length,
        1,
        `shot ${comparison.shot} must select exactly one candidate`,
      );
    }

    const delivery = await deliverProject(root, destination, { review: true, stems: true });
    assert.equal(delivery.build, record.id);

    const manifest = JSON.parse(
      await fs.readFile(nodePath.join(destination, 'delivery-manifest.json'), 'utf8'),
    ) as Manifest;

    // The bundle's own re-hash verification: every manifest sha256 equals an
    // independently computed hash of the staged file.
    for (const file of manifest.files) {
      assert.equal(
        await hashFile(nodePath.join(destination, ...file.path.split('/'))),
        file.sha256,
        `manifest hash must match the staged file ${file.path}`,
      );
    }

    // Both candidate strips land in review/ with the candidate-comparison provenance.
    const stripEntries = manifest.files.filter(file => file.provenance?.kind === 'candidate-comparison');
    assert.deepEqual(
      stripEntries.map(file => file.path),
      ['review/candidate-shot_a.png', 'review/candidate-shot_b.png'],
    );
    assert.deepEqual(
      delivery.review!.candidates,
      stripEntries.map(file => file.path),
    );
    assert.equal(delivery.review!.candidatesSha256.length, 2);
    for (const file of stripEntries) {
      assert.equal(file.role, 'review');
      const stat = await fs.stat(nodePath.join(destination, file.path));
      assert.equal(stat.size, file.bytes, `recorded byte size must match ${file.path}`);
      assert.ok(stat.size > 0, `${file.path} must be a real non-empty file`);
    }
    assert.deepEqual(
      stripEntries.map(file => file.provenance),
      [
        { kind: 'candidate-comparison', build: record.id, shot: 'shot_a' },
        { kind: 'candidate-comparison', build: record.id, shot: 'shot_b' },
      ],
    );

    // Each staged strip is a byte copy of the strip reviewBuild published.
    for (const comparison of review.candidateComparisons) {
      const original = await hashFile(nodePath.join(root, comparison.strip!));
      const bundled = await hashFile(nodePath.join(destination, 'review', nodePath.posix.basename(comparison.strip!)));
      assert.equal(bundled, original, `bundled ${comparison.shot} strip must be a byte copy of the reviewed strip`);
    }

    // The index names every candidate and marks exactly the selected one per shot.
    const indexHtml = await fs.readFile(nodePath.join(destination, 'index.html'), 'utf8');
    assert.ok(indexHtml.includes('id="candidates"'), 'a candidate section must be rendered');
    assert.ok(
      indexHtml.includes('review/candidate-shot_a.png') && indexHtml.includes('review/candidate-shot_b.png'),
      'the index must link both candidate strips',
    );
    const rowsByShot = candidateRowsByShot(indexHtml);
    assert.deepEqual([...rowsByShot.keys()].sort(), ['shot_a', 'shot_b']);
    assert.deepEqual(
      rowsByShot
        .get('shot_a')!
        .map(row => row.source)
        .sort(),
      ['cand_a1', 'cand_a2'],
    );
    assert.deepEqual(
      rowsByShot
        .get('shot_b')!
        .map(row => row.source)
        .sort(),
      ['cand_b1', 'cand_b2'],
    );
    for (const [shot, expectedSource] of [
      ['shot_a', 'cand_a1'],
      ['shot_b', 'cand_b1'],
    ] as const) {
      const rows = rowsByShot.get(shot)!;
      const selected = rows.filter(row => row.selected);
      assert.equal(selected.length, 1, `${shot} must mark exactly one selected candidate`);
      assert.equal(selected[0].source, expectedSource, `${shot} must mark ${expectedSource} selected`);
    }

    // --- A Build with no candidate plan adds none of it ---------------------
    const plainRoot = nodePath.join(parent, 'plain-authoring');
    const plainDestination = nodePath.join(parent, 'plain-bundle');
    await writeProject(plainRoot);
    const plainRecord = await buildProject(plainRoot);
    assert.equal(plainRecord.status, 'succeeded');
    assert.equal(plainRecord.plan.candidates, undefined);

    const plainReview = await reviewBuild(plainRoot);
    assert.deepEqual(plainReview.candidateComparisons, []);

    const plainDelivery = await deliverProject(plainRoot, plainDestination, { review: true, stems: true });
    assert.deepEqual(plainDelivery.review!.candidates, []);

    const plainManifest = JSON.parse(
      await fs.readFile(nodePath.join(plainDestination, 'delivery-manifest.json'), 'utf8'),
    ) as Manifest;
    assert.equal(
      plainManifest.files.filter(file => file.provenance?.kind === 'candidate-comparison').length,
      0,
      'no candidate manifest entries without candidates',
    );
    assert.equal(
      plainManifest.files.some(file => nodePath.posix.basename(file.path).startsWith('candidate-')),
      false,
      'no candidate file is bundled without candidates',
    );

    const plainReviewDir = await fs.readdir(nodePath.join(plainDestination, 'review'));
    assert.equal(
      plainReviewDir.filter(name => name.startsWith('candidate-')).length,
      0,
      'no candidate PNG is staged without candidates',
    );

    const plainIndex = await fs.readFile(nodePath.join(plainDestination, 'index.html'), 'utf8');
    assert.equal(plainIndex.includes('id="candidates"'), false, 'no empty candidate section without candidates');
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
