import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promoteFrame } from '../src/operations/assets/assets.js';
import { buildProject } from '../src/build/build.js';
import { loadProject, saveProject, validateProject } from '../src/project/project.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import type { Project } from '../src/core/schema.js';

test('actual Code Take frame becomes approved image, animatic and local conditioned candidate with portable parent lineage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-promoted-frame-'));
  const delivery = root + '-delivery';
  let base = '',
    submissions = 0,
    sentHash = '';
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'POST' && request.url === '/v1/image_to_video') {
        submissions++;
        let text = '';
        for await (const chunk of request) text += chunk;
        const body = JSON.parse(text);
        sentHash = createHash('sha256')
          .update(Buffer.from(body.promptImage.split(',')[1], 'base64'))
          .digest('hex');
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ id: 'hero-task' }));
      } else if (request.url === '/v1/tasks/hero-task') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ id: 'hero-task', status: 'SUCCEEDED', output: [`${base}/candidate.mp4`] }));
      } else if (request.url === '/candidate.mp4') {
        response.setHeader('Content-Type', 'video/mp4');
        response.end(await readFile(join(root, 'fixture.mp4')));
      } else {
        response.statusCode = 404;
        response.end();
      }
    } catch {
      response.statusCode = 500;
      response.end();
    }
  });
  try {
    await writeFile(
      join(root, 'scene.html'),
      `<!doctype html><body style="margin:0"><canvas id="c"></canvas><script>window.viscraft={render(ctx){const c=document.getElementById('c');c.width=ctx.width;c.height=ctx.height;const g=c.getContext('2d');g.fillStyle='#071423';g.fillRect(0,0,c.width,c.height);g.fillStyle='#ff3355';g.fillRect(8+ctx.frame*3,16,12,12)}};</script></body>`,
    );
    const project: Project = {
      schemaVersion: 1,
      id: 'promoted-hero',
      revision: 1,
      title: 'Original code hero and conditioned fixture',
      soundTargets: [],
      direction: {
        intent: 'Real original frame promotion, explicitly simulated conditioned candidate',
        looks: [{ id: 'main', description: 'Red subject, dark field' }],
        transitions: [],
      },
      assets: [],
      bindings: {},
      sources: [
        {
          id: 'code',
          kind: 'browser',
          output: 'picture',
          entry: 'scene.html',
          resources: [],
          bindings: [],
          params: {},
          seed: 7,
          frames: 8,
        },
      ],
      composition: {
        output: { width: 96, height: 64, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 },
        scenes: [{ id: 'scene', description: 'Original field' }],
        shots: [{ id: 'shot', scene: 'scene', look: 'main', intent: 'Original hero', targetFrames: 8 }],
        placements: [
          { id: 'edit', shot: 'shot', source: 'code', inFrame: 0, outFrame: 8, startFrame: 0, audio: 'mute' },
        ],
        transitions: [],
        audio: [],
      },
      imageDocuments: [],
      imageTargets: [],
    };
    await writeFile(join(root, 'project.json'), JSON.stringify(validateProject(project)));
    const built = await buildProject(root);
    const take = built.takes[0],
      parent = built.artifacts.find(artifact => artifact.id === take.artifact)!;
    const asset = await promoteFrame(root, {
      take: take.id,
      frame: 3,
      assetId: 'hero',
      expectedRevision: 1,
      rights: { origin: 'original code artwork; selected Take frame', license: 'CC0-1.0', redistributable: true },
    });
    assert.equal(asset.type, 'image');
    assert.equal(asset.simulated, false);
    assert.equal(asset.derivedFrom!.artifact, parent.id);
    assert.equal(asset.derivedFrom!.kind, 'frame');
    if (asset.derivedFrom!.kind !== 'frame') throw new Error('expected a frame derivation');
    assert.equal(asset.derivedFrom!.frame, 3);
    assert.equal(await hashFile(join(root, parent.path)), parent.sha256);
    await runCommand('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=96x64:rate=30:duration=2',
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-threads',
      '2',
      join(root, 'fixture.mp4'),
    ]);
    const author = await loadProject(root);
    author.sources.push({
      id: 'candidate',
      kind: 'provider',
      output: 'picture',
      endpoint: 'runway',
      model: 'gen4.5',
      prompt: 'SIMULATED TEST-ONLY promoted first image',
      mode: 'first-last-frame',
      references: [{ asset: asset.id, category: 'image', role: 'first-frame' }],
      requestedFrames: 24,
      size: '1280:720',
      fps: 24,
      attempt: 'promoted-one',
      parameters: { durationSeconds: 2, ratio: '1280:720' },
    });
    author.composition!.placements = [
      {
        id: 'edit',
        shot: 'shot',
        asset: asset.id,
        framing: { fit: 'contain', background: '#000000' },
        inFrame: 0,
        outFrame: 8,
        startFrame: 0,
        audio: 'mute',
        durationFrames: 8,
      },
    ];
    await saveProject(root, author, author.revision);
    const animatic = await buildProject(root);
    assert.equal(animatic.result!.simulated, false);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}`;
    const candidates = await buildProject(root, {
      candidates: [{ shot: 'shot', sources: ['candidate'] }],
      providers: {
        videoApi: {
          runway: { endpoint: { protocol: 'runway-v1' as const, baseUrl: base }, testOnly: { baseUrl: base } },
        },
      },
    });
    assert.equal(submissions, 1);
    assert.equal(sentHash, asset.sha256);
    assert.equal(candidates.result!.simulated, false);
    const selection = await loadProject(root);
    const candidate = candidates.takes.find(take => take.source === 'candidate')!;
    selection.composition!.placements = [
      { id: 'edit', shot: 'shot', take: candidate.id, inFrame: 6, outFrame: 14, startFrame: 0, audio: 'mute' },
    ];
    await saveProject(root, selection, selection.revision);
    const final = await buildProject(root);
    assert.equal(final.result!.simulated, true);
    await exportProject(root, delivery);
    assert.equal(await hashFile(join(delivery, asset.path)), asset.sha256);
    assert.equal(await hashFile(join(delivery, parent.path)), parent.sha256);
    assert.ok((await buildProject(delivery)).operations.every(operation => operation.reused));
    assert.equal(submissions, 1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    await rm(delivery, { recursive: true, force: true });
  }
});
