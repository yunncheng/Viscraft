import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildProject } from '../src/build/build.js';
import { readBuilds } from '../src/project/build-records.js';
import { loadProject, saveProject, validateProject } from '../src/project/project.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { runwayStatus } from '../src/backends/providers/services/runway/index.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import type { Project } from '../src/core/schema.js';
import { writeSignalAsset } from './audio-fixtures.js';

test('Runway loopback fixture uses normal Build/Take/edit/sound/provenance and portable selection without new submission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-runway-e2e-'));
  const delivery = root + '-delivery';
  let submissions = 0,
    queries = 0,
    downloads = 0,
    base = '';
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'POST' && request.url === '/v1/text_to_video') {
        submissions++;
        let body = '';
        for await (const chunk of request) body += chunk;
        const parsed = JSON.parse(body);
        assert.equal(parsed.model, 'gen4.5');
        assert.equal(parsed.duration, 2);
        assert.equal(request.headers['x-runway-version'], '2024-11-06');
        if (parsed.promptText.includes('unknown')) {
          request.socket.destroy();
          return;
        }
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ id: 'fixture-task', estimatedCost: { credits: 8 } }));
      } else if (request.method === 'GET' && request.url === '/v1/tasks/fixture-task') {
        queries++;
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify(
            queries === 1
              ? { id: 'fixture-task', status: 'PENDING', estimatedCost: { credits: 8 } }
              : {
                  id: 'fixture-task',
                  status: 'SUCCEEDED',
                  cost: { credits: 6 },
                  output: [`${base}/fixture.mp4?signature=fixture-only-secret`],
                },
          ),
        );
      } else if (request.method === 'GET' && request.url?.startsWith('/fixture.mp4')) {
        downloads++;
        assert.equal(request.headers.authorization, undefined, 'API credentials must not reach media downloads');
        response.setHeader('Content-Type', 'video/mp4');
        response.end(await readFile(join(root, 'fixture.mp4')));
      } else {
        response.statusCode = 404;
        response.end();
      }
    } catch {
      response.statusCode = 500;
      response.end('fixture error');
    }
  });
  try {
    await runCommand('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x90:rate=30:duration=2',
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-threads',
      '2',
      join(root, 'fixture.mp4'),
    ]);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}`;
    const options = {
      providers: {
        videoApi: {
          runway: {
            endpoint: { protocol: 'runway-v1' as const, baseUrl: base },
            testOnly: { baseUrl: base },
          },
        },
      },
    };
    // A real 440 Hz WAV exercises Asset mixing, gain and fades.
    const bed = await writeSignalAsset(root, {
      id: 'bed_signal',
      path: 'audio/bed.wav',
      sampleRate: 48000,
      channels: 2,
      samples: 38400,
      frequency: 440,
      waveform: 'sine',
    });
    assert.equal(bed.type, 'audio');
    assert.equal(bed.sha256, await hashFile(join(root, bed.path)));
    assert.ok(bed.rights.license.length > 0, 'the audio Asset carries explicit test rights');

    const initial: Project = {
      schemaVersion: 1,
      id: 'runway-fixture',
      revision: 1,
      title: 'SIMULATED HTTP contract fixture',
      soundTargets: [],
      direction: {
        intent: 'Test-only media, not real generation',
        looks: [{ id: 'fixture', description: 'Explicitly simulated test pattern' }],
        transitions: [],
      },
      assets: [bed],
      bindings: {},
      sources: [
        {
          id: 'generated',
          kind: 'provider',
          output: 'picture',
          endpoint: 'runway',
          model: 'gen4.5',
          prompt: 'SIMULATED TEST-ONLY fixture',
          mode: 'text',
          references: [],
          requestedFrames: 24,
          size: '1280:720',
          fps: 24,
          attempt: 'fixture-one',
          parameters: { durationSeconds: 2, ratio: '1280:720' },
        },
      ],
      composition: {
        output: { width: 96, height: 64, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 },
        scenes: [{ id: 'scene', description: 'Contract fixture' }],
        shots: [
          {
            id: 'shot',
            scene: 'scene',
            look: 'fixture',
            intent: 'Choose middle section with handles',
            targetFrames: 24,
          },
        ],
        placements: [
          { id: 'edit', shot: 'shot', source: 'generated', inFrame: 6, outFrame: 30, startFrame: 0, audio: 'mute' },
        ],
        transitions: [],
        audio: [
          {
            id: 'bed',
            kind: 'asset',
            asset: 'bed_signal',
            inSample: 0,
            startSample: 0,
            durationSamples: 38400,
            gain: 0.2,
            fadeInSamples: 400,
            fadeOutSamples: 400,
          },
        ],
      },
      imageDocuments: [],
      imageTargets: [],
    };
    await writeFile(join(root, 'project.json'), JSON.stringify(validateProject(initial)));
    await assert.rejects(buildProject(root, options), /PENDING|pending/i);
    assert.equal(submissions, 1);
    const built = await buildProject(root, options);
    assert.equal(built.status, 'succeeded');
    assert.equal(submissions, 1);
    assert.equal(downloads, 1);
    const take = built.takes[0];
    assert.ok(take);
    if (take.medium !== 'picture') assert.fail('the runway fixture must produce a picture Take');
    assert.equal(take.frames, 60);
    assert.equal(take.simulated, true);
    const generated = built.artifacts.find(artifact => artifact.id === take.artifact)!;
    assert.match(generated.backend, /runway.*test-only/);
    assert.equal(generated.generation?.taskId, 'fixture-task');
    assert.equal(generated.generation?.estimatedCredits, 8);
    assert.equal(generated.generation?.finalCredits, 6);
    assert.match(generated.generation!.originalSha256, /^[a-f0-9]{64}$/);
    const final = built.artifacts.find(artifact => artifact.id === built.result!.artifact)!;
    assert.equal(final.media!.frames, 24);
    assert.equal(final.media!.audio!.duration, 0.8);
    assert.equal(final.simulated, true);
    assert.equal(built.artifacts.find(artifact => artifact.operation === 'mix-audio')!.simulated, false);
    const jobs = JSON.stringify(await runwayStatus(root));
    assert.ok(!jobs.includes('fixture-api-secret') && !jobs.includes('fixture-only-secret') && !jobs.includes(base));
    const repeated = await buildProject(root, options);
    assert.ok(repeated.operations.every(operation => operation.reused));
    assert.equal(submissions, 1);

    const edit = await loadProject(root);
    edit.composition!.placements = [
      { id: 'edit', shot: 'shot', take: take.id, inFrame: 12, outFrame: 36, startFrame: 0, audio: 'mute' },
    ];
    await saveProject(root, edit, edit.revision);
    const recut = await buildProject(root);
    assert.ok(!recut.operations.some(operation => operation.kind === 'provider'));
    assert.equal(recut.operations.find(operation => operation.kind === 'mix-audio')!.reused, true);
    await exportProject(root, delivery);
    const reopened = await buildProject(delivery);
    assert.ok(reopened.operations.every(operation => operation.reused));
    assert.equal(reopened.result!.simulated, true);
    const manifest = await readFile(join(delivery, '.viscraft/portable-manifest.json'), 'utf8');
    assert.ok(!manifest.includes('.viscraft/jobs/') && !manifest.includes('fixture-api-secret'));
    assert.equal(submissions, 1);

    const before = await readFile(join(root, '.viscraft/result.json'), 'utf8');
    const fail = await loadProject(root);
    const source = fail.sources[0];
    assert.equal(source.kind, 'provider');
    if (source.kind !== 'provider') throw Error('wrong fixture Source');
    source.prompt = 'SIMULATED TEST-ONLY unknown submission';
    source.attempt = 'fixture-unknown';
    fail.composition!.placements = initial.composition!.placements;
    await saveProject(root, fail, fail.revision);
    await assert.rejects(buildProject(root, options), /unknown/i);
    await assert.rejects(buildProject(root, options), /unknown/i);
    assert.equal(submissions, 2, 'ambiguous submit must never be repeated');
    assert.equal(await readFile(join(root, '.viscraft/result.json'), 'utf8'), before);
    assert.ok((await readBuilds(root)).some(build => build.status === 'failed'));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    await rm(delivery, { recursive: true, force: true });
  }
});

test('approved hero image animatic feeds an image-conditioned candidate through frozen Asset provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-hero-image-e2e-'));
  const delivery = root + '-delivery';
  let submittedHash = '',
    submissions = 0,
    base = '';
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'POST' && request.url === '/v1/image_to_video') {
        submissions++;
        let text = '';
        for await (const chunk of request) text += chunk;
        const body = JSON.parse(text);
        const image = typeof body.promptImage === 'string' ? body.promptImage : body.promptImage[0].uri;
        assert.match(image, /^data:image\/png;base64,/);
        const { createHash } = await import('node:crypto');
        submittedHash = createHash('sha256')
          .update(Buffer.from(image.split(',')[1], 'base64'))
          .digest('hex');
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ id: 'image-task', estimatedCost: { credits: 8 } }));
      } else if (request.url === '/v1/tasks/image-task') {
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            id: 'image-task',
            status: 'SUCCEEDED',
            cost: { credits: 6 },
            output: [`${base}/video.mp4`],
          }),
        );
      } else if (request.url === '/video.mp4') {
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
    await runCommand('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x90:rate=30:duration=2',
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-threads',
      '2',
      join(root, 'fixture.mp4'),
    ]);
    await runCommand('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-i',
      join(root, 'fixture.mp4'),
      '-frames:v',
      '1',
      '-threads',
      '1',
      join(root, 'hero.png'),
    ]);
    const sha256 = await hashFile(join(root, 'hero.png'));
    // The authored bed is a real audio Asset (same 440 Hz sine, gain and
    // asymmetric fades as the old declaration).
    const bed = await writeSignalAsset(root, {
      id: 'bed_signal',
      path: 'audio/bed.wav',
      sampleRate: 48000,
      channels: 2,
      samples: 38400,
      frequency: 440,
      waveform: 'sine',
    });
    assert.equal(bed.type, 'audio');
    assert.equal(bed.sha256, await hashFile(join(root, bed.path)));
    assert.ok(bed.rights.license.length > 0, 'the audio Asset carries explicit test rights');

    const project: Project = {
      schemaVersion: 1,
      id: 'hero-condition',
      revision: 1,
      title: 'SIMULATED hero-image contract workflow',
      soundTargets: [],
      direction: {
        intent: 'Original hero frame first, local simulated generation second',
        looks: [{ id: 'look', description: 'Planning test pattern' }],
        transitions: [],
      },
      assets: [
        {
          id: 'hero',
          revision: 1,
          type: 'image',
          path: 'hero.png',
          sha256,
          rights: { origin: 'original FFmpeg fixture', license: 'CC0-1.0', redistributable: true },
          simulated: false,
        },
        bed,
      ],
      bindings: {},
      sources: [
        {
          id: 'motion',
          kind: 'provider',
          output: 'picture',
          endpoint: 'runway',
          model: 'gen4.5',
          prompt: 'SIMULATED TEST-ONLY first-image conditioned motion',
          mode: 'first-last-frame',
          references: [{ asset: 'hero', category: 'image', role: 'first-frame' }],
          requestedFrames: 24,
          size: '1280:720',
          fps: 24,
          attempt: 'image-one',
          parameters: { durationSeconds: 2, ratio: '1280:720' },
        },
      ],
      composition: {
        output: { width: 96, height: 64, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 },
        scenes: [{ id: 'scene', description: 'Hero frame to timed motion' }],
        shots: [
          { id: 'shot', scene: 'scene', look: 'look', intent: 'Review animatic before motion', targetFrames: 24 },
        ],
        placements: [
          {
            id: 'edit',
            shot: 'shot',
            asset: 'hero',
            framing: { fit: 'contain', background: '#000000' },
            inFrame: 0,
            outFrame: 24,
            startFrame: 0,
            audio: 'mute',
            durationFrames: 24,
          },
        ],
        transitions: [],
        audio: [
          {
            id: 'bed',
            kind: 'asset',
            asset: 'bed_signal',
            inSample: 0,
            startSample: 0,
            durationSamples: 38400,
            gain: 0.2,
            fadeInSamples: 0,
            fadeOutSamples: 800,
          },
        ],
      },
      imageDocuments: [],
      imageTargets: [],
    };
    await writeFile(join(root, 'project.json'), JSON.stringify(validateProject(project)));
    const animatic = await buildProject(root);
    assert.equal(animatic.result!.simulated, false);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}`;
    const candidates = await buildProject(root, {
      candidates: [{ shot: 'shot', sources: ['motion'] }],
      providers: {
        videoApi: {
          runway: { endpoint: { protocol: 'runway-v1' as const, baseUrl: base }, testOnly: { baseUrl: base } },
        },
      },
    });
    assert.equal(submissions, 1);
    assert.equal(submittedHash, sha256);
    assert.equal(
      candidates.result!.simulated,
      false,
      'simulated candidate must not taint real animatic still selected',
    );
    const take = candidates.takes.find(take => take.source === 'motion')!;
    assert.equal(take.simulated, true);
    const artifact = candidates.artifacts.find(artifact => artifact.id === take.artifact)!;
    assert.deepEqual(artifact.generation!.references, [
      { asset: 'hero', sha256, category: 'image', role: 'first-frame' },
    ]);
    const jobs = JSON.stringify(await runwayStatus(root));
    assert.ok(!jobs.includes('data:image/') && !jobs.includes(base));
    const selected = await loadProject(root);
    selected.composition!.placements = [
      { id: 'edit', shot: 'shot', take: take.id, inFrame: 6, outFrame: 30, startFrame: 0, audio: 'mute' },
    ];
    await saveProject(root, selected, selected.revision);
    const motion = await buildProject(root);
    assert.equal(motion.result!.simulated, true);
    assert.ok(!motion.operations.some(operation => operation.kind === 'provider'));
    assert.equal(motion.operations.find(operation => operation.kind === 'mix-audio')!.reused, true);
    await exportProject(root, delivery);
    assert.equal(await hashFile(join(delivery, 'hero.png')), sha256);
    assert.ok((await buildProject(delivery)).operations.every(operation => operation.reused));
    assert.equal(submissions, 1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    await rm(delivery, { recursive: true, force: true });
  }
});
