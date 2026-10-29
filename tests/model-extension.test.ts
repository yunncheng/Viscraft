import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, cp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { z } from 'zod';
import {
  buildProject,
  createProject,
  generateImage,
  loadProject,
  preflightGenerateImage,
  saveProject,
  planBuild,
  seedance25ArkExtension,
  runwayGen45Extension,
  gen4TurboExtension,
  wan30FalExtension,
} from '../src/index.js';
import { generateVideoApi, videoApiStatus } from '../src/backends/providers/services/video-tasks.js';
import { generateRunway } from '../src/backends/providers/services/runway/index.js';
import { generateFal } from '../src/backends/providers/services/fal/index.js';
import { generateVideoService, validateVideoServiceRequest } from '../src/backends/providers/video-service.js';
import type { VideoApiOptions } from '../src/backends/providers/services/video-tasks.js';
import type { ImageApiOptions } from '../src/backends/providers/services/vllm-omni/image-api.js';
import type { GenerationExtension } from '../src/backends/providers/extension.js';
import type { Asset, ProviderSource, Source } from '../src/core/schema.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { probeMedia } from '../src/backends/media/probe.js';

const OUTPUT = {
  width: 320,
  height: 180,
  fps: { numerator: 24, denominator: 1 },
  sampleRate: 48000 as const,
  channels: 2 as const,
};
const videoSource = (attempt: string, changes: Partial<ProviderSource> = {}): ProviderSource => ({
  id: 'seedance',
  kind: 'provider',
  output: 'picture',
  endpoint: 'default',
  model: 'Seedance-2.5',
  prompt: 'SIMULATED protocol fixture, not model quality evidence',
  mode: 'reference',
  references: [{ asset: 'hero', category: 'image', role: 'identity' }],
  requestedFrames: 96,
  fps: 24,
  size: '320:180',
  parameters: { durationSeconds: 4, resolution: '720p', ratio: '16:9', generateAudio: true },
  attempt,
  ...changes,
});

async function fixture(fn: (root: string, state: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-model-extension-'));
  try {
    await runCommand('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-threads',
      '1',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x640:rate=24:duration=4',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=330:duration=4',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      join(root, 'motion.mp4'),
    ]);
    await runCommand('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-i',
      join(root, 'motion.mp4'),
      '-frames:v',
      '1',
      '-threads',
      '1',
      join(root, 'hero.png'),
    ]);
    await runCommand('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-i',
      join(root, 'motion.mp4'),
      '-vn',
      '-t',
      '2',
      '-c:a',
      'pcm_s16le',
      join(root, 'voice.wav'),
    ]);
    const video = await readFile(join(root, 'motion.mp4'));
    const png = await readFile(join(root, 'hero.png'));
    const state: Fixture = {
      base: '',
      requests: 0,
      posts: 0,
      images: 0,
      gets: 0,
      downloads: 0,
      pending: false,
      failDownload: false,
      unknown: false,
      body: {},
      imageBody: {},
      mediaAuth: undefined,
    };
    const server = createServer(async (req, res) => {
      state.requests++;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/api/v3/contents/generations/tasks') {
        state.posts++;
        state.body = JSON.parse(Buffer.concat(chunks).toString());
        if (state.unknown) {
          req.socket.destroy();
          return;
        }
        res.end(JSON.stringify({ id: 'cgt-fixture' }));
      } else if (req.url === '/api/v3/contents/generations/tasks/cgt-fixture') {
        state.gets++;
        res.end(
          JSON.stringify({
            id: 'cgt-fixture',
            status: state.nativeStatus ?? (state.pending ? 'running' : 'succeeded'),
            ...(state.pending || state.missingUrl
              ? {}
              : { content: { video_url: `${state.base}/result.mp4?token=fixture-only` } }),
          }),
        );
      } else if (req.url === '/result.mp4?token=fixture-only') {
        state.downloads++;
        state.mediaAuth = req.headers.authorization;
        if (state.failDownload) {
          state.failDownload = false;
          res.statusCode = 503;
          res.end('{}');
          return;
        }
        res.setHeader('Content-Type', 'video/mp4');
        res.end(video);
      } else if (req.url === '/reference.mp4') {
        res.setHeader('Content-Type', 'video/mp4');
        res.end(video);
      } else if (req.method === 'POST' && req.url === '/v1/images/generations') {
        state.images++;
        state.imageBody = JSON.parse(Buffer.concat(chunks).toString());
        res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    state.base = `http://127.0.0.1:${address.port}`;
    try {
      await fn(root, state);
    } finally {
      await new Promise<void>(done => server.close(() => done()));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
interface Fixture {
  base: string;
  requests: number;
  posts: number;
  images: number;
  gets: number;
  downloads: number;
  pending: boolean;
  failDownload: boolean;
  unknown: boolean;
  nativeStatus?: string;
  missingUrl?: boolean;
  body: Record<string, unknown>;
  imageBody: Record<string, unknown>;
  mediaAuth: string | undefined;
}
async function hero(root: string): Promise<Asset> {
  return {
    id: 'hero',
    revision: 1,
    path: 'hero.png',
    sha256: await hashFile(join(root, 'hero.png')),
    type: 'image',
    rights: { origin: 'original FFmpeg test fixture', license: 'CC0-1.0', redistributable: true },
    simulated: false,
  };
}
function options(root: string, state: Fixture, asset: Asset): VideoApiOptions {
  return {
    endpoint: { protocol: 'ark-video-v3', baseUrl: `${state.base}/api/v3`, model: 'doubao-seedance-2-5-260628' },
    extension: seedance25ArkExtension(),
    testOnly: { baseUrl: state.base },
    references: [{ asset, root }],
  };
}

// The vendor lanes (Runway, fal) now execute the SAME definition + mapping
// contract as every other provider: a caller-supplied extension whose model or
// protocol mismatches the lane is rejected before any job/request, while a
// matching extension is accepted. The first half proves the mismatched-extensions
// rejection; the second half proves the matching ones are accepted (the full
// second-model proof lives in tests/runway.test.ts).
for (const protocol of ['runway-v1', 'fal-queue'] as const) {
  test(`${protocol} rejects a mismatched extension in Plan, Build and direct execution before any job or request`, async () => {
    await fixture(async (root, state) => {
      const asset = await hero(root);
      const source = videoSource(
        `mismatched-${protocol}`,
        protocol === 'runway-v1'
          ? {
              model: 'gen4.5',
              mode: 'text',
              references: [],
              size: '1280:720',
              parameters: { durationSeconds: 4, ratio: '1280:720' },
            }
          : {
              model: 'alibaba/wan-3.0/image-to-video',
              mode: 'first-last-frame',
              references: [{ asset: asset.id, category: 'image', role: 'first-frame' }],
              size: '1280:720',
              parameters: { durationSeconds: 5, resolution: '720p', ratio: '16:9', audio: true },
            },
      );
      let handlerCalls = 0;
      // The model matches the authored Source, but the mapping declares a
      // protocol this lane does not execute — it must be rejected loudly.
      const extension: GenerationExtension = {
        implementationFiles: [fileURLToPath(import.meta.url)],
        model: {
          id: source.model,
          medium: 'video',
          parameters: z.record(z.unknown()),
          validate() {
            handlerCalls++;
          },
        },
        mapping: {
          model: source.model,
          protocol: 'ark-video-v3',
          validate() {
            handlerCalls++;
          },
          videoBody() {
            handlerCalls++;
            return {};
          },
        },
      };
      const config: VideoApiOptions = {
        endpoint: { protocol, baseUrl: state.base },
        testOnly: { baseUrl: state.base },
        extension,
        references: [{ asset, root }],
      };
      await project(root, source, asset, 24);
      const plan = await planBuild(root, { providers: { videoApi: { default: config } } });
      assert.equal(plan.buildable, false);
      assert.ok(plan.blockers.some(issue => issue.code === 'model-request-invalid'));
      assert.throws(() => validateVideoServiceRequest(source, config));
      await assert.rejects(() => buildProject(root, { providers: { videoApi: { default: config } } }));
      const direct = protocol === 'runway-v1' ? generateRunway : generateFal;
      for (const generate of [generateVideoService, direct]) {
        await assert.rejects(generate(root, source, OUTPUT, 'out.mp4', config), /does not match the selected protocol/);
      }
      assert.equal(handlerCalls, 0, 'a rejected binding must not partially execute handlers');
      assert.equal(state.requests, 0, 'the fixture must observe zero requests on every path');
      assert.deepEqual([state.posts, state.images, state.gets, state.downloads], [0, 0, 0, 0]);
      assert.equal(
        (await readdir(join(root, '.viscraft'))).includes('jobs'),
        false,
        'rejection must not create provider state',
      );
    });
  });
}

test('vendor protocols accept a matching model definition + service mapping', () => {
  const runway = videoSource('matched-runway', {
    model: 'gen4.5',
    mode: 'text',
    references: [],
    size: '1280:720',
    parameters: { durationSeconds: 4, ratio: '1280:720' },
  });
  assert.doesNotThrow(() =>
    validateVideoServiceRequest(runway, {
      endpoint: { protocol: 'runway-v1', baseUrl: 'https://api.dev.runwayml.com' },
      extension: runwayGen45Extension(),
    }),
  );
  // The packaged second Runway model: a different definition + image-to-video mapping.
  const turbo = videoSource('matched-turbo', {
    model: 'gen4_turbo',
    mode: 'first-last-frame',
    references: [{ asset: 'hero', category: 'image', role: 'first-frame' }],
    size: '720:1280',
    parameters: { ratio: '720:1280', durationSeconds: 4 },
  });
  assert.doesNotThrow(() =>
    validateVideoServiceRequest(turbo, {
      endpoint: { protocol: 'runway-v1', baseUrl: 'https://api.dev.runwayml.com' },
      extension: gen4TurboExtension(),
    }),
  );
  const fal = videoSource('matched-fal', {
    model: 'alibaba/wan-3.0/image-to-video',
    mode: 'first-last-frame',
    references: [{ asset: 'hero', category: 'image', role: 'first-frame' }],
    size: '1280:720',
    parameters: { durationSeconds: 5, resolution: '720p', ratio: '16:9', audio: true },
  });
  assert.doesNotThrow(() =>
    validateVideoServiceRequest(fal, {
      endpoint: { protocol: 'fal-queue', baseUrl: 'https://queue.fal.run' },
      extension: wan30FalExtension(),
    }),
  );
});

async function project(root: string, source: Source, asset: Asset | Asset[], frames: number): Promise<void> {
  const p = await createProject(root, { title: 'Provider extension technical verification', output: OUTPUT });
  p.assets = Array.isArray(asset) ? asset : [asset];
  p.sources = [source];
  p.composition!.scenes = [{ id: 'scene', description: 'Actual decoded fixture media' }];
  p.composition!.shots = [
    {
      id: 'shot',
      scene: 'scene',
      look: p.direction.looks[0].id,
      intent: 'Verify the normal production path',
      targetFrames: frames,
    },
  ];
  p.composition!.placements = [
    {
      id: 'cut',
      shot: 'shot',
      source: source.id,
      inFrame: 0,
      outFrame: frames,
      startFrame: 0,
      audio: source.kind === 'provider' ? 'keep' : 'mute',
    },
  ];
  await saveProject(root, p, p.revision);
}

test('Seedance Ark JSON -> durable task -> decoded audiovisual Build; repeat Build and unused extension do not submit', async () => {
  await fixture(async (root, state) => {
    const asset = await hero(root),
      source = videoSource('seedance-accepted');
    const guide = await readFile(resolve('skills/viscraft/references/providers/models/seedance-25.md'), 'utf8');
    const prompt = guide.match(/```text\n([\s\S]*?)\n```/)?.[1];
    assert.ok(prompt, 'the model guide must supply an illustrative authoring prompt');
    source.prompt = prompt;
    const config = options(root, state, asset);
    const motion: Asset = {
      ...asset,
      id: 'motion',
      type: 'video',
      path: 'motion.mp4',
      sha256: await hashFile(join(root, 'motion.mp4')),
    };
    const voice: Asset = {
      ...asset,
      id: 'voice',
      type: 'audio',
      path: 'voice.wav',
      sha256: await hashFile(join(root, 'voice.wav')),
    };
    source.references.push(
      { asset: 'motion', category: 'video', role: 'camera' },
      { asset: 'voice', category: 'audio', role: 'audio' },
    );
    config.references = [asset, motion, voice].map(asset => ({ root, asset }));
    config.referenceLocators = { motion: { url: `${state.base}/reference.mp4`, sha256: motion.sha256 } };
    await project(root, source, [asset, motion, voice], 96);
    const buildOptions = { providers: { videoApi: { default: config } } };
    const plan = await planBuild(root, buildOptions);
    assert.equal(plan.buildable, true, JSON.stringify(plan.blockers));
    assert.equal(state.posts, 0);
    assert.equal(state.gets, 0);
    for (const locator of [
      { ...config.referenceLocators.motion, sha256: '0'.repeat(64) },
      { ...config.referenceLocators.motion, url: 'http://invalid.example/reference.mp4' },
    ]) {
      const invalidPlan = await planBuild(root, {
        providers: { videoApi: { default: { ...config, referenceLocators: { motion: locator } } } },
      });
      assert.equal(invalidPlan.buildable, false);
      assert.ok(invalidPlan.blockers.some(item => /locator/i.test(item.message)));
    }
    const subset = {
      ...config,
      extension: {
        ...config.extension!,
        mapping: {
          ...config.extension!.mapping,
          validate() {
            throw new Error('This service supports one image only');
          },
        },
      },
    };
    const subsetPlan = await planBuild(root, { providers: { videoApi: { default: subset } } });
    assert.equal(subsetPlan.buildable, false);
    assert.ok(subsetPlan.blockers.some(item => /one image only/.test(item.message)));
    await assert.rejects(() => generateVideoApi(root, source, OUTPUT, 'subset.mp4', subset), /one image only/);
    assert.equal(state.posts, 0);
    assert.equal(state.gets, 0);
    assert.equal(state.downloads, 0);
    const built = await buildProject(root, buildOptions);
    assert.equal(built.status, 'succeeded', built.error);
    assert.equal(built.result?.simulated, true);
    assert.equal(state.posts, 1);
    assert.equal(state.downloads, 1);
    assert.equal(state.body.model, 'doubao-seedance-2-5-260628');
    assert.equal(state.body.duration, 4);
    assert.equal(state.body.generate_audio, true);
    assert.equal(state.body.omni_reference_task_type, 'reference');
    assert.equal(state.body.num_inference_steps, undefined);
    const content = state.body.content as Array<{
      type: string;
      text?: string;
      role?: string;
      image_url?: { url: string };
      video_url?: { url: string };
      audio_url?: { url: string };
    }>;
    assert.equal(
      content[0].text,
      source.prompt,
      'model-specific prompt notation must reach the wire verbatim, without an adapter prefix',
    );
    assert.equal(content[1].role, 'reference_image');
    assert.deepEqual(
      Buffer.from(content[1].image_url!.url.split(',')[1], 'base64'),
      await readFile(join(root, 'hero.png')),
    );
    assert.equal(content[2].role, 'reference_video');
    assert.equal(content[2].video_url!.url, config.referenceLocators.motion.url);
    assert.deepEqual(
      Buffer.from(await (await fetch(content[2].video_url!.url)).arrayBuffer()),
      await readFile(join(root, 'motion.mp4')),
    );
    assert.equal(content[3].role, 'reference_audio');
    assert.deepEqual(
      Buffer.from(content[3].audio_url!.url.split(',')[1], 'base64'),
      await readFile(join(root, 'voice.wav')),
    );
    const artifact = built.artifacts.find(item => item.id === built.result!.artifact)!;
    const final = join(root, artifact.path);
    const info = await probeMedia(final);
    assert.equal(info.frames, 96);
    assert.equal(info.width, 320);
    assert.equal(info.height, 180);
    assert.ok(info.audio);
    await runCommand('ffmpeg', ['-v', 'error', '-i', final, '-f', 'null', '-']);
    const take = built.artifacts.find(item => item.generation)!;
    assert.equal(take.generation!.protocol, 'ark-video-v3');
    assert.equal(take.generation!.references[0].sha256, asset.sha256);
    assert.deepEqual(
      take.generation!.references.map(ref => ref.sha256),
      [asset.sha256, motion.sha256, voice.sha256],
    );
    assert.match(take.generation!.extensionHash!, /^[a-f0-9]{64}$/);
    const publicStatus = JSON.stringify(await videoApiStatus(root));
    assert.ok(!publicStatus.includes('token=fixture-only') && !publicStatus.includes(state.base));
    const again = await buildProject(root, {
      providers: {
        videoApi: {
          default: config,
          unused: {
            ...config,
            extension: { ...config.extension!, model: { ...config.extension!.model, id: 'unused-model' } },
          },
        },
      },
    });
    assert.equal(again.status, 'succeeded', again.error);
    assert.equal(state.posts, 1);
    assert.ok(again.operations.find(item => item.kind === 'provider')!.reused);
    const runtimeUrl = new URL('../src/index.js', import.meta.url).href;
    await writeFile(
      join(root, 'providers.mjs'),
      `import {seedance25ArkExtension} from ${JSON.stringify(runtimeUrl)}; export default {providers:{videoApi:{default:{endpoint:${JSON.stringify(config.endpoint)},testOnly:${JSON.stringify(config.testOnly)},referenceLocators:${JSON.stringify(config.referenceLocators)},extension:seedance25ArkExtension()}}}};`,
    );
    const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
    const cliPlan = await runCommand(process.execPath, [cli, 'plan', root, '--config', 'providers.mjs']);
    assert.equal(JSON.parse(cliPlan).buildable, true);
    await runCommand(process.execPath, [cli, 'build', root, '--config', 'providers.mjs']);
    assert.equal(state.posts, 1);
    if (process.env.VISCRAFT_EXTENSION_PROOF_DIR) {
      const destination = resolve(process.env.VISCRAFT_EXTENSION_PROOF_DIR);
      await cp(root, destination, { recursive: true, errorOnExist: true, force: false });
      await writeFile(
        join(destination, 'verification.json'),
        JSON.stringify(
          {
            simulatedApi: true,
            realMediaAndBuild: true,
            final: artifact.path,
            sha256: await hashFile(final),
            frames: info.frames,
            audio: info.audio,
            posts: state.posts,
            repeatBuildReused: true,
          },
          null,
          2,
        ),
      );
    }
  });
});

test('Seedance pending task resumes in a fresh Node process; failed download resumes without another POST', async () => {
  await fixture(async (root, state) => {
    const asset = await hero(root),
      source = videoSource('seedance-resume'),
      config = options(root, state, asset);
    state.pending = true;
    await assert.rejects(() => generateVideoApi(root, source, OUTPUT, 'take.mp4', config), /running|not resubmitting/);
    assert.equal(state.posts, 1);
    state.pending = false;
    state.failDownload = true;
    await assert.rejects(() => generateVideoApi(root, source, OUTPUT, 'take.mp4', config), /download failed/);
    const script = join(root, 'resume.mjs');
    const runtime = fileURLToPath(new URL('../src/index.js', import.meta.url));
    await writeFile(
      script,
      `import {generateVideoService,seedance25ArkExtension} from ${JSON.stringify(pathToFileURL(runtime).href)};\nconst config=${JSON.stringify({ ...config, extension: undefined })};\nconfig.extension=seedance25ArkExtension();\nawait generateVideoService(${JSON.stringify(root)},${JSON.stringify(source)},${JSON.stringify(OUTPUT)},'take.mp4',config);`,
    );
    await runCommand(process.execPath, [script]);
    assert.equal(state.posts, 1);
    assert.equal(state.downloads, 2);
    assert.equal((await probeMedia(join(root, 'take.mp4'))).frames, 96);
    assert.equal(state.mediaAuth, undefined);
  });
});

test('Seedance unsupported request, mapping subset, bad input and changed extension fail before any submission', async () => {
  await fixture(async (root, state) => {
    const asset = await hero(root),
      config = options(root, state, asset);
    const invalid = videoSource('invalid', { steps: 30 });
    await project(root, invalid, asset, 96);
    const plan = await planBuild(root, { providers: { videoApi: { default: config } } });
    assert.equal(plan.buildable, false);
    assert.ok(plan.blockers.some(item => item.code === 'model-request-invalid'));
    await assert.rejects(() => generateVideoApi(root, invalid, OUTPUT, 'bad.mp4', config), /steps/);
    const wrongModelResolution = videoSource('invalid-4k', { parameters: { resolution: '4k' } });
    const resolutionProject = await loadProject(root);
    resolutionProject.sources = [wrongModelResolution];
    await saveProject(root, resolutionProject, resolutionProject.revision);
    const resolutionPlan = await planBuild(root, { providers: { videoApi: { default: config } } });
    assert.equal(resolutionPlan.buildable, false);
    assert.ok(resolutionPlan.blockers.some(item => item.code === 'model-request-invalid'));
    await assert.rejects(
      () => generateVideoApi(root, wrongModelResolution, OUTPUT, 'bad.mp4', config),
      /resolution|Invalid enum/,
    );
    const frame = videoSource('frames', {
      mode: 'first-last-frame',
      references: [{ asset: 'hero', category: 'image', role: 'first-frame' }],
    });
    await assert.rejects(() => generateVideoApi(root, frame, OUTPUT, 'bad.mp4', config), /ratio adaptive/);
    const subset = {
      ...config,
      extension: {
        ...config.extension!,
        mapping: {
          ...config.extension!.mapping,
          validate() {
            throw new Error('This service does not support multi-reference requests');
          },
        },
      },
    };
    await assert.rejects(
      () => generateVideoApi(root, videoSource('subset'), OUTPUT, 'bad.mp4', subset),
      /does not support/,
    );
    await assert.rejects(
      () =>
        generateVideoApi(root, videoSource('corrupt'), OUTPUT, 'bad.mp4', {
          ...config,
          references: [{ root, asset: { ...asset, sha256: '0'.repeat(64) } }],
        }),
      /sha256/,
    );
    assert.equal(state.posts, 0);
    assert.equal(state.gets, 0);
    assert.equal(state.downloads, 0);
    const source = videoSource('accepted');
    await generateVideoApi(root, source, OUTPUT, 'good.mp4', config);
    // A different loaded mapping handler is a DIFFERENT implementation identity,
    // so the completed attempt is refused before its replacement rule can run:
    // the artifact already in the project belongs to the original implementation.
    await assert.rejects(
      () => generateVideoApi(root, source, OUTPUT, 'changed.mp4', subset),
      /different frozen request/,
    );
    const changed = {
      ...config,
      extension: {
        ...config.extension!,
        mapping: {
          ...config.extension!.mapping,
          validate() {
            /* A different loaded implementation. */
          },
        },
      },
    };
    await assert.rejects(
      () => generateVideoApi(root, source, OUTPUT, 'changed.mp4', changed),
      /different frozen request/,
    );
    assert.equal(state.posts, 1);
  });
});

test('Seedance ambiguous submit never automatically resubmits', async () => {
  await fixture(async (root, state) => {
    const config = options(root, state, await hero(root)),
      source = videoSource('unknown');
    state.unknown = true;
    await assert.rejects(() => generateVideoApi(root, source, OUTPUT, 'take.mp4', config), /unknown/);
    await assert.rejects(() => generateVideoApi(root, source, OUTPUT, 'take.mp4', config), /unknown/);
    assert.equal(state.posts, 1);
    assert.equal(state.gets, 0);
  });
});

test('Ark terminal failures and missing result URL preserve the accepted task instead of resubmitting', async () => {
  await fixture(async (root, state) => {
    const config = options(root, state, await hero(root));
    for (const status of ['failed', 'cancelled', 'expired']) {
      state.nativeStatus = status;
      const source = videoSource(`native-${status}`);
      await assert.rejects(() => generateVideoApi(root, source, OUTPUT, 'failed.mp4', config), /failed/);
      const job = JSON.parse(
        await readFile(join(root, '.viscraft/jobs/video-api', `${source.id}.${source.attempt}.json`), 'utf8'),
      );
      assert.equal(job.state, 'failed');
      assert.equal(job.error, `provider generation ${status}`);
      await assert.rejects(
        () => generateVideoApi(root, source, OUTPUT, 'failed.mp4', config),
        /permanent provider failure/,
      );
    }
    assert.equal(state.posts, 3);
    assert.equal(state.downloads, 0);
    state.nativeStatus = 'succeeded';
    state.missingUrl = true;
    const source = videoSource('missing-url');
    await assert.rejects(
      () => generateVideoApi(root, source, OUTPUT, 'take.mp4', config),
      /malformed; not resubmitting/,
    );
    assert.equal(state.posts, 4);
    state.missingUrl = false;
    await generateVideoApi(root, source, OUTPUT, 'take.mp4', config);
    assert.equal(state.posts, 4);
    assert.equal(state.downloads, 1);
  });
});

test('project-owned image definition and mapping use the same extension contract and register a real PNG Asset', async () => {
  await fixture(async (root, state) => {
    const modulePath = join(root, 'image-model.mjs');
    await writeFile(
      modulePath,
      `export function extension(z,file) { return { implementationFiles:[file], model:{ id:'Study-Image', medium:'image', parameters:z.object({quality:z.enum(['fine','draft'])}).strict(), validate(source) { if(source.operation!=='generate') throw Error('Generation only'); } }, mapping:{ model:'Study-Image', protocol:'vllm-omni-image', validate(_source,p) { if(p.quality==='draft') throw Error('This service supports fine quality only'); }, imageFields(_source,p) { return {quality:p.quality==='fine'?'high':'low'}; } } }; }`,
    );
    const module = (await import(pathToFileURL(modulePath).href)) as {
      extension(zod: typeof z, path: string): GenerationExtension;
    };
    const extension = module.extension(z, modulePath);
    const config: ImageApiOptions = { extension, testOnly: { baseUrl: state.base } };
    const created = await createProject(root, { title: 'Image extension', output: OUTPUT });
    created.assets = [await hero(root)];
    await saveProject(root, created, created.revision);

    const request = {
      id: 'image',
      attempt: 1,
      asset: 'generated',
      rights: { origin: 'generated by the image fixture', license: 'CC0-1.0', redistributable: true },
      endpoint: 'images',
      operation: 'generate' as const,
      model: 'Study-Image',
      prompt: 'Fixture only',
      parameters: { quality: 'fine' },
    };
    const imageOptions = { providers: { imageApi: { images: config } } };

    const preflight = await preflightGenerateImage(root, request, imageOptions);
    assert.equal(preflight.ok, true, JSON.stringify(preflight.issues));
    assert.equal(state.images, 0, 'a preflight submits nothing');

    const result = await generateImage(root, request, imageOptions);
    assert.equal(state.images, 1);
    assert.equal(state.imageBody.quality, 'high');
    assert.equal(result.generation.simulated, true, 'a loopback test fixture is simulated');
    assert.match(result.generation.extensionHash!, /^[a-f0-9]{64}$/);
    assert.equal(result.asset.id, 'generated');
    assert.equal(result.asset.type, 'image');
    assert.equal(result.asset.simulated, true, 'the Asset keeps the simulated taint');
    assert.equal(await hashFile(join(root, result.asset.path)), result.asset.sha256);
    assert.ok((await probeMedia(join(root, result.asset.path))).width > 0, 'a real image Asset was registered');

    // A repeated execution returns the SAME Asset without a second image request.
    const again = await generateImage(root, request, imageOptions);
    assert.equal(again.asset.id, result.asset.id);
    assert.equal(again.asset.sha256, result.asset.sha256);
    assert.equal(state.images, 1, 'a succeeded request never resubmits');

    // The same read-only model/mapping validator rejects an unsupported value
    // before any submission.
    await assert.rejects(
      () => generateImage(root, { ...request, attempt: 2, parameters: { quality: 'draft' } }, imageOptions),
      /fine quality only/,
    );
    await assert.rejects(
      () => generateImage(root, { ...request, attempt: 2, parameters: { invented: 1 } }, imageOptions),
      /quality|Unrecognized/,
    );

    // Changing the mapping implementation changes the frozen request identity of a
    // NEW attempt (so an old paid result is never silently reused).
    const before = await preflightGenerateImage(root, { ...request, attempt: 3 }, imageOptions);
    await writeFile(modulePath, `${await readFile(modulePath, 'utf8')}\n// changed implementation identity\n`);
    const changed = (
      (await import(`${pathToFileURL(modulePath).href}?v=${Date.now()}`)) as {
        extension(zod: typeof z, path: string): GenerationExtension;
      }
    ).extension(z, modulePath);
    const after = await preflightGenerateImage(
      root,
      { ...request, attempt: 3 },
      {
        providers: { imageApi: { images: { extension: changed, testOnly: { baseUrl: state.base } } } },
      },
    );
    assert.notEqual(before.requestHash, after.requestHash, 'a changed implementation must change the request hash');
    assert.equal(state.images, 1);
  });
});

test('a new project-owned video model reuses Ark execution without changing Core, Plan or Build', async () => {
  await fixture(async (root, state) => {
    const modulePath = join(root, 'video-model.mjs');
    await writeFile(
      modulePath,
      `export function extension(z,file) { return {implementationFiles:[file],model:{id:'Study-Video',medium:'video',parameters:z.object({quality:z.literal('cinematic')}).strict(),validate(s){if(s.mode!=='text')throw Error('Text only');}},mapping:{model:'Study-Video',protocol:'ark-video-v3',validate(){},videoBody(s,p,wireModel){return {model:wireModel,content:[{type:'text',text:s.prompt}],quality:p.quality,duration:s.requestedFrames/s.fps};}}};}`,
    );
    const module = (await import(pathToFileURL(modulePath).href)) as {
      extension(zod: typeof z, file: string): GenerationExtension;
    };
    const extension = module.extension(z, modulePath);
    const config: VideoApiOptions = {
      endpoint: { protocol: 'ark-video-v3', baseUrl: `${state.base}/api/v3`, model: 'fixture-study-video' },
      extension,
      testOnly: { baseUrl: state.base },
    };
    const source = videoSource('study-video', {
      model: 'Study-Video',
      mode: 'text',
      references: [],
      parameters: { quality: 'cinematic' },
    });
    await project(root, source, [], 96);
    const buildOptions = { providers: { videoApi: { default: config } } };
    assert.equal((await planBuild(root, buildOptions)).buildable, true);
    assert.equal(state.posts, 0);
    const built = await buildProject(root, buildOptions);
    assert.equal(built.status, 'succeeded', built.error);
    assert.equal(state.posts, 1);
    assert.equal(state.body.model, 'fixture-study-video');
    assert.equal(state.body.quality, 'cinematic');
    assert.equal(
      (await probeMedia(join(root, built.artifacts.find(a => a.id === built.result!.artifact)!.path))).frames,
      96,
    );
    assert.equal((await buildProject(root, buildOptions)).status, 'succeeded');
    assert.equal(state.posts, 1);
  });
});
