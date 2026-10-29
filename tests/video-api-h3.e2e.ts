/**
 * Local MiniMax-H3 Provider end-to-end proof through the normal Build path.
 *
 * This test drives the *public* runtime API (`../src/index.js`) against a real
 * loopback HTTP fixture that speaks the vLLM-Omni async video protocol, with a
 * real short FFmpeg media file (video + audio). It proves the whole chain:
 *
 *   image animatic  ->  candidate video generation Take  ->  24fps provider media
 *   normalized to 30fps  ->  select the middle Take and keep its generated
 *   audio  ->  retime + mix + movie  ->  deliverProject  ->  reopen with no
 *   further submission  ->  a later failing Build preserves the previous result.
 *
 * No GPU and no real generative model are involved: the fixture serves a
 * deterministic FFmpeg test pattern, the adapter runs in its documented
 * test-only transport, and every recorded Take/Artifact is marked `simulated`.
 */

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  buildProject,
  deliverProject,
  loadProject,
  probeMedia,
  readBuilds,
  saveProject,
  validateProject,
} from '../src/index.js';
import { videoApiStatus } from '../src/backends/providers/services/video-tasks.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { minimaxH3Ref2vaExtension } from '../src/backends/providers/models/minimax-h3.js';
import { attemptStem } from '../src/backends/providers/job-store.js';
import type { Project } from '../src/core/schema.js';
import { writeSignalAsset } from './audio-fixtures.js';

const JOB_ID = 'video_gen_fixture_1';

/** Minimal multipart/form-data parser for the fixture (test-only). */
function parseMultipart(
  body: Buffer,
  contentType: string | undefined,
): { fields: Record<string, string>; files: Array<{ name: string; data: Buffer }> } {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  const result = { fields: {} as Record<string, string>, files: [] as Array<{ name: string; data: Buffer }> };
  if (!match) return result;
  const boundary = Buffer.from(`--${(match[1] ?? match[2]).trim()}`, 'latin1');
  let index = body.indexOf(boundary);
  while (index !== -1) {
    const afterBoundary = index + boundary.length;
    if (body.subarray(afterBoundary, afterBoundary + 2).toString('latin1') === '--') break;
    const nextBoundary = body.indexOf(boundary, afterBoundary + 2);
    if (nextBoundary === -1) break;
    const part = body.subarray(afterBoundary + 2, nextBoundary);
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n', 'latin1'));
    if (headerEnd !== -1) {
      const headerText = part.subarray(0, headerEnd).toString('latin1');
      let data = part.subarray(headerEnd + 4);
      if (data.length >= 2 && data[data.length - 2] === 0x0d && data[data.length - 1] === 0x0a)
        data = data.subarray(0, data.length - 2);
      const name = /name="([^"]*)"/i.exec(headerText)?.[1];
      const filename = /filename="([^"]*)"/i.exec(headerText)?.[1];
      if (name !== undefined) {
        if (filename !== undefined) result.files.push({ name, data: Buffer.from(data) });
        else result.fields[name] = data.toString('utf8');
      }
    }
    index = nextBoundary;
  }
  return result;
}

test('normal Build: image animatic feeds a video generation candidate, middle Take keeps generated audio, then delivers, reopens and survives a failing Build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-video-generation-e2e-'));
  const delivery = root + '-delivery';
  let submissions = 0;
  let statusPolls = 0;
  let downloads = 0;
  let submittedHash = '';
  const guide = await readFile(resolve('skills/viscraft/references/providers/models/minimax-h3.md'), 'utf8');
  const guidePrompt = [...guide.matchAll(/```text\n([\s\S]*?)\n```/g)][1]?.[1];
  assert.ok(guidePrompt, 'H3 guide must supply its illustrative reference prompt');
  let submittedPrompt = '';
  let base = '';

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', async () => {
      try {
        const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
        if (request.method === 'POST' && path === '/v1/videos') {
          submissions++;
          const raw = Buffer.concat(chunks);
          const parsed = parseMultipart(raw, request.headers['content-type']);
          const file = parsed.files.find(entry => entry.name === 'input_references');
          assert.ok(file, 'the reference image must be uploaded as an input_references part');
          submittedHash = createHash('sha256').update(file.data).digest('hex');
          assert.equal(parsed.fields.num_frames, '96', 'the requested frame count is sent verbatim');
          assert.equal(parsed.fields.fps, '24');
          assert.equal(request.headers.authorization, undefined, 'no credential may ever be sent');
          if ((parsed.fields.prompt ?? '').includes('unknown')) {
            request.socket.destroy();
            return;
          }
          submittedPrompt = parsed.fields.prompt;
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ id: JOB_ID, status: 'queued', model: 'MiniMax-H3' }));
        } else if (request.method === 'GET' && path === `/v1/videos/${JOB_ID}`) {
          statusPolls++;
          // Two status steps: in_progress first, completed on the retry.
          const status = statusPolls === 1 ? 'in_progress' : 'completed';
          response.setHeader('Content-Type', 'application/json');
          // The real local service returns nullable fields (`inference_time_s:
          // null`, `error: null`) while a job is still running; the in-flight
          // response mirrors that so a non-nullable schema would be caught here.
          response.end(
            JSON.stringify(
              status === 'completed'
                ? { id: JOB_ID, status, model: 'MiniMax-H3', inference_time_s: 4.25, error: null }
                : { id: JOB_ID, status, model: 'MiniMax-H3', inference_time_s: null, error: null },
            ),
          );
        } else if (request.method === 'GET' && path === `/v1/videos/${JOB_ID}/content`) {
          downloads++;
          const media = await readFile(join(root, 'fixture.mp4'));
          response.setHeader('Content-Type', 'video/mp4');
          response.setHeader('Content-Length', String(media.length));
          response.end(media);
        } else {
          response.statusCode = 404;
          response.end();
        }
      } catch (error) {
        response.statusCode = 500;
        response.end(`fixture error: ${String(error)}`);
      }
    });
  });

  try {
    // Real short 24fps provider media WITH audio (2 s -> 48 frames). The fixture
    // serves exactly this, so normalization must resample 24 -> 30 fps.
    await runCommand('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-threads',
      '2',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=24:duration=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      join(root, 'fixture.mp4'),
    ]);
    const providerBytes = await probeMedia(join(root, 'fixture.mp4'));
    assert.equal(providerBytes.frames, 48);
    assert.equal(providerBytes.fps.numerator / providerBytes.fps.denominator, 24);
    assert.ok(providerBytes.audio, 'the provider fixture must carry audio');

    // A real approved hero PNG extracted from the provider media (PNG by signature).
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
    const heroSha = await hashFile(join(root, 'hero.png'));

    // A real 330 Hz WAV exercises Asset mixing, timing, gain and fades.
    const bed = await writeSignalAsset(root, {
      id: 'bed_signal',
      path: 'audio/bed.wav',
      sampleRate: 48000,
      channels: 2,
      samples: 38400,
      frequency: 330,
      waveform: 'sine',
    });
    assert.equal(bed.type, 'audio');
    assert.equal(bed.sha256, await hashFile(join(root, bed.path)));
    assert.ok(bed.rights.license.length > 0, 'the audio Asset carries explicit test rights');

    const initial: Project = {
      schemaVersion: 1,
      id: 'video-generation-normal',
      revision: 1,
      title: 'SIMULATED local H3 normal-build fixture',
      soundTargets: [],
      direction: {
        intent: 'Approve a still animatic, then extend it with a local test-only model pass',
        looks: [{ id: 'look', description: 'Explicitly simulated test pattern' }],
        transitions: [],
      },
      assets: [
        {
          id: 'hero',
          revision: 1,
          type: 'image',
          path: 'hero.png',
          sha256: heroSha,
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
          endpoint: 'default',
          fps: 24,
          model: 'minimax-h3-base-ref2va',
          prompt: guidePrompt,
          mode: 'reference',
          references: [{ asset: 'hero', category: 'image', role: 'identity' }],
          requestedFrames: 96,
          size: '768:768',
          steps: 30,
          seed: 7,
          attempt: 'h3-one',
        },
      ],
      composition: {
        output: { width: 96, height: 64, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 },
        scenes: [{ id: 'scene', description: 'Still to local motion' }],
        shots: [
          {
            id: 'shot',
            scene: 'scene',
            look: 'look',
            intent: 'Review the animatic, then the model candidate',
            targetFrames: 24,
          },
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
            gain: 0.15,
            fadeInSamples: 400,
            fadeOutSamples: 400,
          },
        ],
      },
      imageDocuments: [],
      imageTargets: [],
    };
    await writeFile(join(root, 'project.json'), JSON.stringify(validateProject(initial)));

    // --- 1. Animatic from the approved image (no model, not simulated) ------
    const animatic = await buildProject(root);
    assert.equal(animatic.status, 'succeeded');
    assert.equal(animatic.result!.simulated, false);
    assert.ok(animatic.operations.some(operation => operation.kind === 'normalize-still'));

    await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', () => resolveListen()));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}`;
    const options = {
      providers: { videoApi: { default: { testOnly: { baseUrl: base }, extension: minimaxH3Ref2vaExtension() } } },
    };

    // --- 2. video generation candidate: first poll is in_progress, retry completes ---
    await assert.rejects(
      buildProject(root, { candidates: [{ shot: 'shot', sources: ['motion'] }], ...options }),
      /in_progress|pending/i,
    );
    assert.equal(submissions, 1);
    const candidates = await buildProject(root, { candidates: [{ shot: 'shot', sources: ['motion'] }], ...options });
    assert.equal(candidates.status, 'succeeded');
    assert.equal(submissions, 1, 'exactly one POST across the pending retry');
    assert.equal(statusPolls, 2, 'exactly two status GET steps');
    assert.equal(downloads, 1);
    assert.equal(
      submittedPrompt,
      guidePrompt.replace(/\r?\n/g, '\r\n'),
      'multipart applies CRLF line endings, with the complete prompt content otherwise unchanged',
    );
    assert.equal(submittedHash, heroSha, 'the uploaded multipart bytes must hash to the approved hero Asset');

    const take = candidates.takes.find(entry => entry.source === 'motion');
    assert.ok(take);
    assert.equal(take.simulated, true);
    if (take.medium !== 'picture') assert.fail('the H3 candidate must produce a picture Take');
    // 2 s of 24fps provider media normalized to the 30fps output clock.
    assert.equal(take.frames, 60);
    assert.equal(take.fps.numerator / take.fps.denominator, 30);
    const generated = candidates.artifacts.find(artifact => artifact.id === take.artifact)!;
    assert.match(generated.backend, /vllm-omni-video.*test-only/);
    assert.equal(generated.media!.fps.numerator / generated.media!.fps.denominator, 30);
    assert.equal(generated.generation!.provider, 'video-api');
    assert.equal(generated.generation!.taskId, JOB_ID);
    assert.equal(generated.generation!.requestedFrames, 96);
    assert.equal(generated.generation!.inferenceSeconds, 4.25);
    assert.deepEqual(generated.generation!.references, [
      { asset: 'hero', sha256: heroSha, category: 'image', role: 'identity' },
    ]);
    // The retained provider original is the real 24fps/48-frame source; the
    // artifact is resampled, never padded or truncated to requestedFrames.
    assert.equal(generated.generation!.originalMedia!.frames, 48);
    assert.equal(
      generated.generation!.originalMedia!.fps.numerator / generated.generation!.originalMedia!.fps.denominator,
      24,
    );
    // The retained provider original is keyed by the Source-scoped stem.
    assert.ok(existsSync(join(root, `.viscraft/provider-media/video-api-${attemptStem('motion', 'h3-one')}.mp4`)));
    const jobs = JSON.stringify(await videoApiStatus(root));
    assert.ok(
      !jobs.includes(base) && !jobs.includes('data:image/') && !jobs.includes('SIMULATED TEST-ONLY local H3 motion'),
    );

    // --- 3. Choose the middle Take and keep its generated audio; retime+edit --
    const selected = await loadProject(root);
    selected.composition!.placements = [
      {
        id: 'edit',
        shot: 'shot',
        take: take.id,
        inFrame: 12,
        outFrame: 36,
        startFrame: 0,
        audio: 'keep',
        durationFrames: 20,
      },
    ];
    await saveProject(root, selected, selected.revision);
    const movie = await buildProject(root);
    assert.equal(movie.status, 'succeeded');
    assert.equal(movie.result!.simulated, true);
    assert.ok(
      !movie.operations.some(operation => operation.kind === 'provider'),
      'a selected Take must not regenerate the model',
    );
    assert.ok(movie.operations.some(operation => operation.kind === 'retime-clip'));
    assert.ok(
      movie.operations.some(operation => operation.kind === 'source-audio-trim'),
      'the generated audio must be kept',
    );
    const final = movie.artifacts.find(artifact => artifact.id === movie.result!.artifact)!;
    assert.equal(final.media!.frames, 20);
    assert.ok(final.media!.audio, 'the final movie must carry the kept generated audio');
    assert.equal(submissions, 1, 'selecting a Take must not submit again');

    // --- 4. Deliver the bundle ---------------------------------------------
    const bundle = await deliverProject(root, delivery, { review: true, stems: true });
    assert.equal(bundle.build, movie.id);
    assert.equal(bundle.simulated, true);
    assert.equal(bundle.movie!.path, 'movie/final.mp4');
    assert.ok(existsSync(join(delivery, 'index.html')));
    assert.equal(await hashFile(join(delivery, 'movie', 'final.mp4')), bundle.movie!.sha256);
    assert.equal(bundle.review!.build, movie.id);

    // --- 5. Reopen the delivered editable project: no submission ------------
    const reopened = await buildProject(join(delivery, 'project'));
    assert.ok(
      reopened.operations.every(operation => operation.reused),
      'the delivered project must rebuild entirely from cached artifacts',
    );
    assert.equal(reopened.result!.simulated, true);
    assert.equal(submissions, 1, 'reopening must not POST again');
    assert.equal(statusPolls, 2);

    // --- 6. A later failing Build preserves the previous active result ------
    const previousResult = await readFile(join(root, '.viscraft/result.json'), 'utf8');
    const failing = await loadProject(root);
    const failingSource = failing.sources.find(entry => entry.id === 'motion');
    assert.equal(failingSource?.kind, 'provider');
    if (failingSource?.kind !== 'provider') throw new Error('wrong fixture Source');
    failingSource.prompt = 'SIMULATED TEST-ONLY unknown submission';
    failingSource.attempt = 'h3-unknown';
    failing.composition!.placements = [
      { id: 'edit', shot: 'shot', source: 'motion', inFrame: 12, outFrame: 36, startFrame: 0, audio: 'mute' },
    ];
    await saveProject(root, failing, failing.revision);
    await assert.rejects(buildProject(root, options), /unknown/i);
    await assert.rejects(buildProject(root, options), /unknown|not resubmit/i);
    assert.equal(submissions, 2, 'an ambiguous submit must never be repeated');
    assert.equal(
      await readFile(join(root, '.viscraft/result.json'), 'utf8'),
      previousResult,
      'a failed Build must not replace the active result',
    );
    assert.ok((await readBuilds(root)).some(build => build.status === 'failed'));
  } finally {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    await rm(root, { recursive: true, force: true });
    await rm(delivery, { recursive: true, force: true });
  }
});
