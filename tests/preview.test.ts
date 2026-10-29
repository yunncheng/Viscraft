/**
 * `preview`: a range/proxy/still preview never touches authored state or the
 * active result; at scale 1 the in-range Source Takes are the full Build's own
 * Operations (reused afterwards); a proxy Take is never reused by a full Build;
 * out-of-range Placements are substituted and their Sources not produced.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildProject, previewProject } from '../src/build/build.js';
import { planBuild } from '../src/build/plan.js';
import { probeMedia } from '../src/backends/media/probe.js';
import { projectStatus } from '../src/project/status.js';
import { hashFile } from '../src/shared/hash.js';
import type { Project } from '../src/core/schema.js';

const CODE_SCENE = `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;overflow:hidden;background:#111}canvas{display:block}</style></head>
<body><canvas id="scene"></canvas><script>
window.viscraft = {
  render(ctx) {
    const canvas = document.getElementById('scene');
    canvas.width = ctx.width; canvas.height = ctx.height;
    const g = canvas.getContext('2d');
    g.fillStyle = 'hsl(' + ((ctx.frame * 30 + Number(ctx.params.shift || 0)) % 360) + ',65%,45%)';
    g.fillRect(0, 0, ctx.width, ctx.height);
  }
};
</script></body></html>
`;

function project(): Project {
  return {
    schemaVersion: 1,
    id: 'preview_fixture',
    revision: 1,
    title: 'Preview fixture',
    soundTargets: [],
    direction: { intent: '', looks: [{ id: 'look', description: '' }], transitions: [] },
    assets: [],
    bindings: {},
    sources: [
      {
        id: 'src_a',
        kind: 'browser',
        output: 'picture',
        entry: 'scene.html',
        resources: [],
        bindings: [],
        params: {},
        seed: 1,
        frames: 4,
      },
      {
        id: 'src_b',
        kind: 'browser',
        output: 'picture',
        entry: 'scene.html',
        resources: [],
        bindings: [],
        params: { shift: 90 },
        seed: 2,
        frames: 4,
      },
    ],
    composition: {
      output: { width: 64, height: 48, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene', description: '' }],
      shots: [
        { id: 'shot_a', scene: 'scene', look: 'look', intent: '', targetFrames: 4 },
        { id: 'shot_b', scene: 'scene', look: 'look', intent: '', targetFrames: 4 },
      ],
      placements: [
        { id: 'pl_a', shot: 'shot_a', source: 'src_a', inFrame: 0, outFrame: 4, startFrame: 0, audio: 'mute' },
        { id: 'pl_b', shot: 'shot_b', source: 'src_b', inFrame: 0, outFrame: 4, startFrame: 4, audio: 'mute' },
      ],
      transitions: [],
      audio: [],
    },
    imageDocuments: [],
    imageTargets: [],
  };
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'viscraft-preview-'));
  await writeFile(path.join(root, 'project.json'), JSON.stringify(project()));
  await writeFile(path.join(root, 'scene.html'), CODE_SCENE);
  return root;
}

const sourceOps = (record: { operations: Array<{ kind: string; key: string; reused: boolean }> }) =>
  record.operations.filter(operation => operation.kind === 'browser');

test('scale-1 range preview: zero author/result writes, out-of-range Source not produced, Takes reused by the full Build', async () => {
  const root = await fixture();
  try {
    const before = await hashFile(path.join(root, 'project.json'));
    const plan = await planBuild(root, { preview: { frames: [1, 3] } });
    assert.deepEqual(plan.preview, { frames: [1, 3], scale: 1, substituted: ['pl_b'] });
    assert.deepEqual(
      plan.work.map(item => item.subject),
      ['src_a'],
    );

    const record = await previewProject(root, { frames: [1, 3] });
    assert.equal(record.status, 'succeeded');
    assert.equal(record.result, undefined, 'a preview has no result');
    assert.deepEqual(record.preview?.substituted, ['pl_b']);
    assert.deepEqual(
      record.takes.map(take => take.source),
      ['src_a'],
      'the substituted Placement Source was not produced',
    );
    const movie = record.artifacts.find(artifact => artifact.id === record.preview?.artifact)!;
    const info = await probeMedia(path.join(root, movie.path));
    assert.equal(info.frames, 2);
    assert.equal(await hashFile(path.join(root, 'project.json')), before);
    await assert.rejects(readFile(path.join(root, '.viscraft', 'result.json')), { code: 'ENOENT' });

    const status = await projectStatus(root);
    assert.equal(status.current, null);
    assert.equal(status.latestBuild, null, 'a preview is not the latest Build');
    assert.equal(status.previews.total, 1);

    const full = await buildProject(root);
    const ops = sourceOps(full);
    const a = ops.find(operation => record.operations.some(o => o.key === operation.key));
    assert.ok(a?.reused, 'the preview Take of src_a is reused by the full Build');
    assert.equal(ops.filter(operation => !operation.reused).length, 1, 'only src_b is newly produced');
    assert.ok(JSON.parse(await readFile(path.join(root, '.viscraft', 'result.json'), 'utf8')).build === full.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('proxy preview is never reused by a full Build; --still writes a PNG at output × scale', async () => {
  const root = await fixture();
  try {
    const proxy = await previewProject(root, { still: 5, scale: 0.5 });
    assert.equal(proxy.status, 'succeeded');
    assert.deepEqual(proxy.preview?.frames, [5, 6]);
    assert.deepEqual(proxy.preview?.substituted, ['pl_a']);
    const still = proxy.preview?.still;
    assert.ok(still);
    const png = await readFile(path.join(root, still.path));
    assert.equal(await hashFile(path.join(root, still.path)), still.sha256);
    assert.equal(png.readUInt32BE(16), 32, 'PNG width = 64 × 0.5');
    assert.equal(png.readUInt32BE(20), 24, 'PNG height = 48 × 0.5');

    const full = await buildProject(root);
    const proxyKeys = new Set(sourceOps(proxy).map(operation => operation.key));
    assert.ok(
      sourceOps(full).every(operation => !operation.reused && !proxyKeys.has(operation.key)),
      'no full-Build Source reuses a proxy Take',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an out-of-programme range is refused by plan and preview alike', async () => {
  const root = await fixture();
  try {
    const plan = await planBuild(root, { preview: { frames: [6, 12] } });
    assert.ok(plan.blockers.some(issue => issue.code === 'invalid-preview'));
    await assert.rejects(previewProject(root, { frames: [6, 12] }), /within the 8-frame programme/);
    await assert.rejects(previewProject(root, { frames: [0, 2], scale: 0.1 }), /between 0.25 and 1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
