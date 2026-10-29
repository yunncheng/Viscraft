/** API contract -> candidates -> selected edit -> audio -> delivery -> cached reopen.
 * The server returns original FFmpeg fixture bytes, never real model generation.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildProject, deliverProject, loadProject, saveProject, validateProject } from '../src/index.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { probeMedia } from '../src/backends/media/probe.js';
import type { Project } from '../src/core/schema.js';
import { writeSignalAsset } from './audio-fixtures.js';

test('simulated video API runs through normal candidates, selection, audio, delivery and local revision without resubmission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-video-api-e2e-'));
  const destination = `${root}-delivery`;
  let posts = 0;
  let gets = 0;
  let downloads = 0;
  const uploaded: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/videos') {
        posts++;
        uploaded.push(Buffer.concat(chunks).toString());
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: `fixture_${posts}`, status: 'queued' }));
      } else if (/^\/v1\/videos\/fixture_\d+\/content$/.test(req.url ?? '')) {
        downloads++;
        readFile(join(root, 'proxy.mp4')).then(
          bytes => {
            res.setHeader('content-type', 'video/mp4');
            res.end(bytes);
          },
          () => {
            res.statusCode = 500;
            res.end();
          },
        );
      } else if (/^\/v1\/videos\/fixture_\d+$/.test(req.url ?? '')) {
        gets++;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: req.url!.split('/').at(-1), status: 'completed', error: null }));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  try {
    await runCommand('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-threads',
      '1',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=96x64:rate=24:duration=1',
      '-frames:v',
      '24',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-an',
      join(root, 'proxy.mp4'),
    ]);
    // A real 330 Hz WAV exercises Asset mixing, gain and fades.
    const bed = await writeSignalAsset(root, {
      id: 'bed_signal',
      path: 'audio/bed.wav',
      sampleRate: 48000,
      channels: 2,
      samples: 24000,
      frequency: 330,
      waveform: 'sine',
    });
    assert.equal(bed.type, 'audio');
    assert.equal(bed.sha256, await hashFile(join(root, bed.path)));
    assert.ok(bed.rights.license.length > 0, 'the audio Asset carries explicit test rights');

    const project: Project = validateProject({
      schemaVersion: 1,
      id: 'video-api-e2e',
      revision: 1,
      title: 'SIMULATED video API contract proof',
      direction: {
        intent: 'Test-only provider lifecycle; no visual generation claim',
        looks: [{ id: 'look', description: 'Original FFmpeg pattern' }],
        transitions: [],
      },
      assets: [
        {
          id: 'proxy',
          revision: 1,
          path: 'proxy.mp4',
          sha256: await hashFile(join(root, 'proxy.mp4')),
          type: 'video',
          rights: { origin: 'Original FFmpeg test pattern', license: 'CC0-1.0', redistributable: true },
          simulated: false,
        },
        bed,
      ],
      bindings: {},
      sources: [
        ...['candidate_a', 'candidate_b'].map((id, index) => ({
          id,
          kind: 'provider',
          output: 'picture',
          model: 'fixture-video',
          endpoint: 'default',
          prompt: `SIMULATED text-only candidate ${index}`,
          mode: 'text',
          references: [],
          requestedFrames: 12,
          size: '96:64',
          fps: 12,
          steps: 3,
          seed: index,
          attempt: `attempt_${index}`,
        })),
      ],
      composition: {
        output: { width: 96, height: 64, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 2 },
        scenes: [{ id: 'scene', description: 'A single editable shot' }],
        shots: [
          {
            id: 'shot',
            scene: 'scene',
            look: 'look',
            intent: 'Compare two candidates and choose a trim',
            targetFrames: 12,
          },
        ],
        placements: [
          { id: 'edit', shot: 'shot', asset: 'proxy', inFrame: 0, outFrame: 12, startFrame: 0, audio: 'mute' },
        ],
        transitions: [],
        audio: [
          {
            id: 'bed',
            kind: 'asset',
            asset: 'bed_signal',
            inSample: 0,
            startSample: 0,
            durationSamples: 24000,
            gain: 0.1,
            fadeInSamples: 100,
            fadeOutSamples: 100,
          },
        ],
      },
    });
    await writeFile(join(root, 'project.json'), JSON.stringify(project));
    const animatic = await buildProject(root);
    assert.equal(animatic.status, 'succeeded');
    assert.equal(animatic.result!.simulated, false);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const options = {
      providers: { videoApi: { default: { testOnly: { baseUrl: `http://127.0.0.1:${address.port}` } } } },
    };
    const candidates = await buildProject(root, {
      ...options,
      candidates: [{ shot: 'shot', sources: ['candidate_a', 'candidate_b'] }],
    });
    assert.equal(candidates.status, 'succeeded');
    assert.equal(posts, 2);
    assert.equal(gets, 2);
    assert.equal(downloads, 2);
    assert.equal(uploaded.length, 2);
    assert.ok(
      uploaded.every(body => body.includes('fixture-video') && !body.includes('filename=')),
      'text-only must pass model without fabricated references',
    );
    const takes = candidates.takes.filter(take => take.source?.startsWith('candidate_'));
    assert.equal(takes.length, 2);
    assert.ok(takes.every(take => take.simulated));
    for (const take of takes) {
      const artifact = candidates.artifacts.find(a => a.id === take.artifact)!;
      assert.equal(artifact.generation!.provider, 'video-api');
      assert.equal(artifact.generation!.model, 'fixture-video');
      assert.ok(!JSON.stringify(artifact.generation).includes(`http://127.0.0.1:${address.port}`));
    }
    const selectedTake = takes.find(take => take.source === 'candidate_b')!;
    const selected = await loadProject(root);
    selected.composition!.placements = [
      { id: 'edit', shot: 'shot', take: selectedTake.id, inFrame: 4, outFrame: 16, startFrame: 0, audio: 'mute' },
    ];
    await saveProject(root, selected, selected.revision);
    const final = await buildProject(root);
    assert.equal(final.status, 'succeeded');
    assert.equal(final.result!.simulated, true);
    assert.equal(posts, 2);
    assert.equal(final.operations.find(op => op.kind === 'mix-audio')!.reused, true);
    const finalArtifact = final.artifacts.find(artifact => artifact.id === final.result!.artifact)!;
    const info = await probeMedia(join(root, finalArtifact.path));
    assert.equal(info.frames, 12);
    assert.ok(info.audio, 'final must contain the authored soundtrack');
    const delivery = await deliverProject(root, destination, { review: true, stems: true });
    assert.equal(delivery.simulated, true);
    assert.equal((await probeMedia(join(destination, delivery.movie!.path))).frames, 12);
    const portable = join(destination, delivery.project!.path);
    const reopened = await buildProject(portable);
    assert.equal(reopened.status, 'succeeded');
    assert.ok(reopened.operations.every(op => op.reused));
    assert.equal(
      reopened.artifacts.find(artifact => artifact.id === reopened.result!.artifact)!.sha256,
      finalArtifact.sha256,
    );
    assert.equal(posts, 2);
    // Retiming at the available Edit level must retain both generated candidates.
    const revised = await loadProject(portable);
    revised.composition!.placements[0].inFrame = 6;
    revised.composition!.placements[0].outFrame = 18;
    await saveProject(portable, revised, revised.revision);
    const revision = await buildProject(portable);
    assert.equal(revision.status, 'succeeded');
    assert.equal(revision.result!.simulated, true);
    assert.equal(revision.operations.find(op => op.kind === 'mix-audio')!.reused, true);
    assert.equal(posts, 2, 'delivery reopen and edit-only revision must not submit again');
    assert.ok(
      revision.takes.some(take => take.id === selectedTake.id),
      'the accepted Take identity survives revision',
    );
    assert.equal(
      (
        await probeMedia(
          join(portable, revision.artifacts.find(artifact => artifact.id === revision.result!.artifact)!.path),
        )
      ).frames,
      12,
    );
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    await rm(destination, { recursive: true, force: true });
  }
});
