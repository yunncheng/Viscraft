/**
 * Local MiniMax-H3 video-reference end-to-end proof through the normal Build path.
 *
 * Proves the genuine video-reference transformation wiring added to the runtime:
 * a video generation Source that carries BOTH a required reference image and an optional
 * MP4 reference video. The adapter must upload the frozen PNG and the frozen MP4
 * as two `input_references` parts (image first, video second), record the video
 * provenance in the Artifact generation metadata, taint the Take as simulated in
 * test mode, and reuse the accepted Take on select/export without re-submitting.
 *
 * Boundary cases prove every malformed/out-of-contract reference video, and a
 * missing per-Asset video transmission consent, are rejected BEFORE any network
 * POST, and that swapping the reference video under a reused attempt id is
 * rejected without a new POST.
 *
 * No GPU and no real service are involved: the fixture speaks the documented
 * vLLM-Omni async video protocol on loopback and serves a deterministic FFmpeg
 * file. The image Source uses the runtime's existing Chromium capture path
 * (same as tests/animatic.e2e.ts and tests/video-api-h3.e2e.ts).
 */

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildProject, exportProject, loadProject, saveProject, validateProject } from '../src/index.js';
import { generateVideoApi, videoApiStatus } from '../src/backends/providers/services/video-tasks.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { minimaxH3Ref2vaExtension } from '../src/backends/providers/models/minimax-h3.js';
import { attemptStem } from '../src/backends/providers/job-store.js';
import type { Asset, ProviderSource, OutputSettings, Project } from '../src/core/schema.js';
import { writeSignalAsset } from './audio-fixtures.js';

const JOB_ID = 'video_gen_ref_1';
const OUTPUT: OutputSettings = {
  width: 96,
  height: 64,
  fps: { numerator: 30, denominator: 1 },
  sampleRate: 48000,
  channels: 2,
};

/** Minimal multipart/form-data parser for the fixture (test-only). */
function parseMultipart(
  body: Buffer,
  contentType: string | undefined,
): { fields: Record<string, string>; files: Array<{ name: string; filename?: string; type?: string; data: Buffer }> } {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  const result = {
    fields: {} as Record<string, string>,
    files: [] as Array<{ name: string; filename?: string; type?: string; data: Buffer }>,
  };
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
      const type = /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1]?.trim();
      if (name !== undefined) {
        if (filename !== undefined) result.files.push({ name, filename, type, data: Buffer.from(data) });
        else result.fields[name] = data.toString('utf8');
      }
    }
    index = nextBoundary;
  }
  return result;
}

async function makeVideo(file: string, size: string, rate: number, duration: number, audio = false): Promise<void> {
  const args = [
    '-v',
    'error',
    '-y',
    '-threads',
    '2',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${size}:rate=${rate}:duration=${duration}`,
  ];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${duration}`);
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
  if (audio) args.push('-c:a', 'aac', '-shortest');
  else args.push('-an');
  args.push(file);
  await runCommand('ffmpeg', args);
}

async function makePng(source: string, file: string): Promise<void> {
  await runCommand('ffmpeg', ['-v', 'error', '-y', '-i', source, '-frames:v', '1', '-threads', '1', file]);
}

function asset(id: string, path: string, sha256: string, type: 'image' | 'video'): Asset {
  return {
    id,
    revision: 1,
    path,
    sha256,
    type,
    rights: { origin: 'original FFmpeg fixture', license: 'CC0-1.0', redistributable: true },
    simulated: false,
  };
}

interface FixtureState {
  posts: number;
  gets: number;
  downloads: number;
  fields: Record<string, string>;
  uploads: Array<{ name: string; filename?: string; type?: string; sha256: string }>;
}

interface Fixture {
  baseUrl: string;
  state: FixtureState;
  close: () => Promise<void>;
}

async function withFixture(fn: (fixture: Fixture) => Promise<void>, media?: Buffer): Promise<void> {
  const state: FixtureState = { posts: 0, gets: 0, downloads: 0, fields: {}, uploads: [] };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', async () => {
      try {
        const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
        if (request.method === 'POST' && path === '/v1/videos') {
          state.posts++;
          const parsed = parseMultipart(Buffer.concat(chunks), request.headers['content-type']);
          state.fields = parsed.fields;
          state.uploads = parsed.files.map(file => ({
            name: file.name,
            filename: file.filename,
            type: file.type,
            sha256: createHash('sha256').update(file.data).digest('hex'),
          }));
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ id: JOB_ID, status: 'queued', model: 'MiniMax-H3' }));
        } else if (request.method === 'GET' && path === `/v1/videos/${JOB_ID}`) {
          state.gets++;
          response.setHeader('Content-Type', 'application/json');
          response.end(
            JSON.stringify({
              id: JOB_ID,
              status: 'completed',
              model: 'MiniMax-H3',
              error: null,
              inference_time_s: 3.5,
            }),
          );
        } else if (request.method === 'GET' && path === `/v1/videos/${JOB_ID}/content`) {
          state.downloads++;
          response.setHeader('Content-Type', 'video/mp4');
          response.end(media ?? Buffer.alloc(0));
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
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', () => resolveListen()));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const fixture: Fixture = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    state,
    close: () => new Promise<void>(resolveClose => server.close(() => resolveClose())),
  };
  try {
    await fn(fixture);
  } finally {
    await fixture.close();
  }
}

test('normal Build: video-reference video generation candidate uploads frozen PNG+MP4, records video metadata, and reuses on select/export', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-h3-video-e2e-'));
  const delivery = root + '-delivery';
  try {
    // A real short original: 2 s, 640x360, 24fps, H.264, no audio.
    await makeVideo(join(root, 'clip.mp4'), '640x360', 24, 2, false);
    await makePng(join(root, 'clip.mp4'), join(root, 'hero.png'));
    const heroSha = await hashFile(join(root, 'hero.png'));
    const clipSha = await hashFile(join(root, 'clip.mp4'));
    // Second real original with a different hash, for the identity-change refusal.
    await makeVideo(join(root, 'clip2.mp4'), '640x360', 24, 3, false);
    const clip2Sha = await hashFile(join(root, 'clip2.mp4'));

    // The authored soundtrack is a real audio Asset; the clip below keeps the
    // old 330 Hz sine bed, gain, timing and fades exactly.
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

    const project: Project = {
      schemaVersion: 1,
      id: 'h3-video-normal',
      revision: 1,
      title: 'SIMULATED local H3 video-reference fixture',
      soundTargets: [],
      direction: {
        intent: 'Test-only reference video contract, not real generation',
        looks: [{ id: 'look', description: 'Explicitly simulated test pattern' }],
        transitions: [],
      },
      assets: [asset('hero', 'hero.png', heroSha, 'image'), asset('clip', 'clip.mp4', clipSha, 'video'), bed],
      bindings: {},
      sources: [
        {
          id: 'motion',
          kind: 'provider',
          output: 'picture',
          endpoint: 'default',
          fps: 24,
          model: 'minimax-h3-base-ref2va',
          prompt: 'SIMULATED TEST-ONLY reference-video transformation',
          mode: 'reference',
          references: [
            { asset: 'hero', category: 'image', role: 'identity' },
            { asset: 'clip', category: 'video', role: 'motion' },
          ],
          requestedFrames: 96,
          size: '768:768',
          steps: 30,
          seed: 7,
          attempt: 'h3-ref-one',
        },
      ],
      composition: {
        output: OUTPUT,
        scenes: [{ id: 'scene', description: 'Still plus reference video' }],
        shots: [
          {
            id: 'shot',
            scene: 'scene',
            look: 'look',
            intent: 'Review the animatic, then the video-conditioned candidate',
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
    await writeFile(join(root, 'project.json'), JSON.stringify(validateProject(project)));

    const animatic = await buildProject(root);
    assert.equal(animatic.status, 'succeeded');
    assert.equal(animatic.result!.simulated, false);

    const generated = await readFile(join(root, 'clip.mp4'));
    await withFixture(async fixture => {
      const options = {
        providers: {
          videoApi: { default: { testOnly: { baseUrl: fixture.baseUrl }, extension: minimaxH3Ref2vaExtension() } },
        },
      };
      const candidates = await buildProject(root, { candidates: [{ shot: 'shot', sources: ['motion'] }], ...options });
      assert.equal(candidates.status, 'succeeded');
      assert.equal(fixture.state.posts, 1, 'exactly one POST');
      assert.equal(fixture.state.gets, 1);
      assert.equal(fixture.state.downloads, 1);

      // The mixed multipart body: frozen PNG first, frozen MP4 second, no start offset.
      assert.equal(fixture.state.uploads.length, 2, 'image and video must both be uploaded');
      assert.deepEqual(
        fixture.state.uploads.map(entry => entry.name),
        ['input_references', 'input_references'],
      );
      assert.equal(fixture.state.uploads[0].type, 'image/png');
      assert.match(fixture.state.uploads[0].filename ?? '', /\.png$/);
      assert.equal(fixture.state.uploads[0].sha256, heroSha, 'the uploaded image bytes must hash to the frozen Asset');
      assert.equal(fixture.state.uploads[1].type, 'video/mp4');
      assert.match(fixture.state.uploads[1].filename ?? '', /\.mp4$/);
      assert.equal(fixture.state.uploads[1].sha256, clipSha, 'the uploaded MP4 bytes must hash to the frozen Asset');
      assert.equal(fixture.state.fields.num_frames, '96');
      assert.equal(fixture.state.fields.model, 'MiniMax-H3');
      assert.equal(fixture.state.fields.start_time_seconds, undefined, 'no start offset is sent');

      const take = candidates.takes.find(entry => entry.source === 'motion');
      assert.ok(take);
      assert.equal(take.simulated, true, 'a test-only run must be tainted simulated');
      if (take.medium !== 'picture') assert.fail('the H3 reference candidate must produce a picture Take');
      assert.equal(take.frames, 60, '2 s of 24fps media normalized to the 30fps output clock');
      const artifact = candidates.artifacts.find(entry => entry.id === take.artifact)!;
      assert.match(artifact.backend, /vllm-omni-video.*test-only/);
      assert.deepEqual(artifact.generation!.references[0], {
        asset: 'hero',
        sha256: heroSha,
        category: 'image',
        role: 'identity',
      });
      assert.equal(artifact.generation!.references[1].asset, 'clip');
      assert.equal(artifact.generation!.references[1].category, 'video');
      assert.equal(artifact.generation!.references[1].role, 'motion');
      assert.equal(artifact.generation!.references[1].sha256, clipSha);
      assert.equal(artifact.generation!.references[1].media!.frames, 48);
      assert.ok(
        artifact.generation!.references[1].media!.duration >= 2 &&
          artifact.generation!.references[1].media!.duration <= 15,
      );
      assert.equal(artifact.generation!.taskId, JOB_ID);

      // The job record keeps video provenance only (no bytes/URLs).
      const jobs = JSON.stringify(await videoApiStatus(root));
      assert.ok(
        !jobs.includes(fixture.baseUrl) &&
          !jobs.includes('data:video') &&
          !jobs.includes('SIMULATED TEST-ONLY reference-video transformation'),
      );

      // Select the middle Take: no model pass, deterministic reuse of the edit.
      const selected = await loadProject(root);
      selected.composition!.placements = [
        { id: 'edit', shot: 'shot', take: take.id, inFrame: 12, outFrame: 36, startFrame: 0, audio: 'mute' },
      ];
      await saveProject(root, selected, selected.revision);
      const movie = await buildProject(root);
      assert.equal(movie.status, 'succeeded');
      assert.ok(
        !movie.operations.some(operation => operation.kind === 'provider'),
        'a selected Take must not regenerate',
      );
      assert.equal(movie.operations.find(operation => operation.kind === 'mix-audio')!.reused, true);
      assert.equal(fixture.state.posts, 1);

      await exportProject(root, delivery);
      const reopened = await buildProject(delivery);
      assert.ok(
        reopened.operations.every(operation => operation.reused),
        'the exported project must rebuild from cached artifacts',
      );
      assert.equal(reopened.result!.simulated, true);
      assert.equal(fixture.state.posts, 1, 'reopen must not POST again');

      // Identity change: the same attempt id with a different reference video is
      // rejected before any POST.
      const edited = await loadProject(root);
      edited.assets = [...edited.assets, asset('clip2', 'clip2.mp4', clip2Sha, 'video')];
      const motion = edited.sources.find(source => source.id === 'motion');
      assert.equal(motion?.kind, 'provider');
      if (motion?.kind !== 'provider') throw new Error('wrong fixture Source');
      motion.references = [motion.references[0], { asset: 'clip2', category: 'video', role: 'motion' }];
      edited.composition!.placements = [
        { id: 'edit', shot: 'shot', source: 'motion', inFrame: 12, outFrame: 36, startFrame: 0, audio: 'mute' },
      ];
      await saveProject(root, edited, edited.revision);
      await assert.rejects(
        () =>
          buildProject(root, {
            providers: {
              videoApi: { default: { testOnly: { baseUrl: fixture.baseUrl }, extension: minimaxH3Ref2vaExtension() } },
            },
          }),
        /different frozen request|new attempt/i,
      );
      assert.equal(fixture.state.posts, 1, 'a changed reference video must not reach the service');
      assert.equal((await videoApiStatus(root)).length, 1, 'no new job record is created');
    }, generated);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(delivery, { recursive: true, force: true });
  }
});

test('boundary: malformed / wrong-hash / short / low-fps / wrong-type / no video consent all reject before any POST', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-h3-video-boundary-'));
  try {
    await makeVideo(join(root, 'clip.mp4'), '640x360', 24, 2, false);
    await makeVideo(join(root, 'short.mp4'), '640x360', 24, 1, false);
    await makeVideo(join(root, 'slow.mp4'), '640x360', 12, 2, false);
    await makePng(join(root, 'clip.mp4'), join(root, 'hero.png'));
    await writeFile(join(root, 'bad.mp4'), 'this is not an MP4 container');

    const heroSha = await hashFile(join(root, 'hero.png'));
    const clipSha = await hashFile(join(root, 'clip.mp4'));
    const shortSha = await hashFile(join(root, 'short.mp4'));
    const slowSha = await hashFile(join(root, 'slow.mp4'));
    const badSha = await hashFile(join(root, 'bad.mp4'));

    const hero = asset('hero', 'hero.png', heroSha, 'image');
    const bad = asset('bad', 'bad.mp4', badSha, 'video');
    const wrongHash = asset('clip', 'clip.mp4', '0'.repeat(64), 'video');
    const short = asset('short', 'short.mp4', shortSha, 'video');
    const slow = asset('slow', 'slow.mp4', slowSha, 'video');
    const wrongType = asset('heroimg', 'hero.png', heroSha, 'image');
    const valid = asset('clip', 'clip.mp4', clipSha, 'video');

    const source = (attempt: string, referenceVideo: string): ProviderSource => ({
      id: `s_${attempt}`,
      kind: 'provider',
      output: 'picture',
      endpoint: 'default',
      fps: 24,
      model: 'minimax-h3-base-ref2va',
      prompt: 'SIMULATED TEST-ONLY boundary',
      mode: 'reference',
      references: [
        { asset: 'hero', category: 'image', role: 'identity' },
        { asset: referenceVideo, category: 'video', role: 'motion' },
      ],
      requestedFrames: 96,
      size: '768:768',
      steps: 30,
      seed: 7,
      attempt,
    });

    await withFixture(async fixture => {
      // Ordered references parallel to the Source: image first, video second.
      const refs = (videoAsset: Asset) => ({
        testOnly: { baseUrl: fixture.baseUrl },
        extension: minimaxH3Ref2vaExtension(),
        references: [
          { asset: hero, root },
          { asset: videoAsset, root },
        ],
      });
      // Malformed container (no ftyp).
      await assert.rejects(
        () => generateVideoApi(root, source('b_malformed', 'bad'), OUTPUT, 'build/a.mp4', refs(bad)),
        /MP4 container|ftyp/i,
      );
      // Hash mismatch against the frozen Asset.
      await assert.rejects(
        () => generateVideoApi(root, source('b_hash', 'clip'), OUTPUT, 'build/a.mp4', refs(wrongHash)),
        /hash mismatch|do not match its recorded sha256/i,
      );
      // Duration below the 2 s floor.
      await assert.rejects(
        () => generateVideoApi(root, source('b_short', 'short'), OUTPUT, 'build/a.mp4', refs(short)),
        /duration 2\.\.15/,
      );
      // Frame rate below the 23.976 floor.
      await assert.rejects(
        () => generateVideoApi(root, source('b_slow', 'slow'), OUTPUT, 'build/a.mp4', refs(slow)),
        /23\.976\.\.60 fps/,
      );
      // A reference video Asset that is not a video.
      await assert.rejects(
        () => generateVideoApi(root, source('b_type', 'heroimg'), OUTPUT, 'build/a.mp4', refs(wrongType)),
        /is not a video/i,
      );
      // A provided list that does not cover the declared references.
      await assert.rejects(
        () =>
          generateVideoApi(root, source('b_missing', 'clip'), OUTPUT, 'build/a.mp4', {
            testOnly: { baseUrl: fixture.baseUrl },
            extension: minimaxH3Ref2vaExtension(),
            references: [{ asset: hero, root }],
          }),
        /declares 2 reference|were provided|mismatch/i,
      );
      // Production without per-Asset video transmission consent.
      await assert.rejects(
        () =>
          generateVideoApi(root, source('b_consent', 'clip'), OUTPUT, 'build/a.mp4', {
            endpoint: { protocol: 'vllm-omni-video', baseUrl: fixture.baseUrl },
            extension: minimaxH3Ref2vaExtension(),
            authorization: { submit: true, uploadAssets: ['hero'] },
            references: [
              { asset: hero, root },
              { asset: valid, root },
            ],
          }),
        /consent|uploadAssets/i,
      );

      assert.equal(fixture.state.posts, 0, 'no boundary rejection may reach the service');
      for (const attempt of ['b_malformed', 'b_hash', 'b_short', 'b_slow', 'b_type', 'b_missing', 'b_consent']) {
        assert.ok(
          !existsSync(join(root, '.viscraft', 'jobs', 'video-api', `${attemptStem(`s_${attempt}`, attempt)}.json`)),
          `no job record for ${attempt}`,
        );
      }
      assert.equal((await videoApiStatus(root)).length, 0);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
