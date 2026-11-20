/**
 * The SAME Runway adapter and the SAME fal adapter each execute MULTIPLE different
 * model definitions through Plan → Build, with at least one being a PROJECT-OWNED
 * custom `GenerationExtension` (and, for fal, a text-to-video model with zero
 * references).
 *
 * This is the direct consequence of decoupling the adapters from a hard-coded
 * model: the deployment model comes from `options.endpoint.model ?? source.model`
 * and the EFFECTIVE extension, so a single transport can serve many models. For
 * each adapter we build:
 *   - a packaged model definition (gen4.5 / wan-3.0), and
 *   - a project-owned custom definition whose OWN mapping shapes the wire body,
 * through the SAME adapter entry and the SAME loopback fixture, then assert:
 *   - Plan is buildable with zero submits;
 *   - the wire BODY matches that model's mapping (and only that mapping);
 *   - the extension / request identity DIFFERS per model;
 *   - a re-Build of each model REUSES its accepted Take (no new submit).
 *
 * Loopback fixtures only; zero external calls. All records are `simulated`.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { z } from 'zod';
import {
  buildProject,
  createProject,
  loadProject,
  saveProject,
  planBuild,
  runwayGen45Extension,
  wan30FalExtension,
  type Asset,
  type GenerationExtension,
  type OutputSettings,
  type ProviderSource,
} from '../src/index.js';
import { generateFal } from '../src/backends/providers/services/fal/index.js';
import { generateRunway } from '../src/backends/providers/services/runway/index.js';
import { probeMedia } from '../src/backends/media/probe.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';

const OUTPUT: OutputSettings = {
  width: 160,
  height: 90,
  fps: { numerator: 30, denominator: 1 },
  sampleRate: 48000,
  channels: 1,
};

interface Recorded {
  method: string;
  path: string;
  body: string;
}
interface Fixture {
  baseUrl: string;
  submits: Recorded[];
}

/** A real, probeable provider media fixture (tiny 16:9 H.264), built once. */
let cachedMedia: Promise<Buffer> | undefined;
function providerMedia(): Promise<Buffer> {
  cachedMedia ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'viscraft-adapter-reuse-media-'));
    const file = join(dir, 'provider.mp4');
    await runCommand('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-threads',
      '2',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=30/1:duration=2',
      '-frames:v',
      '60',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      file,
    ]);
    return readFile(file);
  })();
  return cachedMedia;
}

/**
 * One loopback fixture serving BOTH lanes (routed by path): Runway (`/v1/*`) and
 * the fal queue (any other submit path, whose status/result paths derive from the
 * submit path so a project-owned `endpointId` works unchanged).
 */
async function withFixture(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  const media = await providerMedia();
  const submits: Recorded[] = [];
  let counter = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      const body = Buffer.concat(chunks).toString('utf8');
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      // --- Runway lane ---
      if (req.method === 'POST' && (path === '/v1/text_to_video' || path === '/v1/image_to_video')) {
        submits.push({ method: 'POST', path, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `task_${++counter}`, estimatedCost: { credits: 1 } }));
        return;
      }
      if (req.method === 'GET' && path.startsWith('/v1/tasks/')) {
        const id = decodeURIComponent(path.slice('/v1/tasks/'.length));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ id, status: 'SUCCEEDED', cost: { credits: 1 }, output: [`${origin}/media/${id}.mp4`] }),
        );
        return;
      }
      if (req.method === 'GET' && path.startsWith('/media/')) {
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': media.length });
        res.end(media);
        return;
      }

      // --- fal queue lane ---
      if (req.method === 'POST') {
        submits.push({ method: 'POST', path, body });
        const id = `req_${++counter}`;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'IN_QUEUE',
            request_id: id,
            status_url: `${origin}${path}/requests/${id}/status`,
            response_url: `${origin}${path}/requests/${id}`,
          }),
        );
        return;
      }
      if (req.method === 'GET' && /\/requests\/[^/]+\/status$/.test(path)) {
        const id = path.split('/requests/')[1].replace(/\/status$/, '');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'COMPLETED',
            request_id: id,
            status_url: `${origin}${path}`,
            response_url: `${origin}${path.replace(/\/status$/, '')}`,
          }),
        );
        return;
      }
      if (req.method === 'GET' && /\/requests\/[^/]+$/.test(path)) {
        const id = path.split('/requests/')[1];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ video: { url: `${origin}/media/${id}.mp4` }, seed: 1, duration: 5 }));
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
  });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', () => resolveListen()));
  const fixture: Fixture = { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, submits };
  try {
    await fn(fixture);
  } finally {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  }
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-adapter-reuse-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A real encoded PNG (via the installed FFmpeg) used as an approved frame image. */
async function writePng(dir: string, name: string, size: number): Promise<void> {
  await mkdir(dir, { recursive: true });
  await runCommand('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-threads',
    '1',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${size}x${size}:rate=1:duration=1`,
    '-frames:v',
    '1',
    '-pix_fmt',
    'rgb24',
    join(dir, name),
  ]);
}

function imageAsset(id: string, path: string, sha256: string): Asset {
  return {
    id,
    revision: 1,
    path,
    sha256,
    type: 'image',
    rights: { origin: 'original FFmpeg fixture', license: 'CC0-1.0', redistributable: true },
    simulated: false,
  };
}

/** A schema-valid Project with one shot/placement over the given Source. */
async function writeProjectFixture(
  root: string,
  source: ProviderSource,
  asset: Asset | undefined,
  frames: number,
): Promise<void> {
  const p = await createProject(root, { title: 'Adapter model reuse verification', output: OUTPUT });
  if (asset) p.assets = [asset];
  p.sources = [source];
  p.composition!.scenes = [{ id: 'scene', description: 'Actual decoded fixture media' }];
  p.composition!.shots = [
    {
      id: 'shot',
      scene: 'scene',
      look: p.direction.looks[0].id,
      intent: 'Verify the ordinary production path',
      targetFrames: frames,
    },
  ];
  p.composition!.placements = [
    { id: 'cut', shot: 'shot', source: source.id, inFrame: 0, outFrame: frames, startFrame: 0, audio: 'mute' },
  ];
  await saveProject(root, p, p.revision);
}

/** Swap the single project Source (keeping assets/history) for the second model. */
async function setSource(root: string, source: ProviderSource): Promise<void> {
  const p = await loadProject(root);
  p.sources = [source];
  for (const placement of p.composition!.placements) if (placement.source) placement.source = source.id;
  await saveProject(root, p, p.revision);
}

const generationOf = (build: Awaited<ReturnType<typeof buildProject>>): string => {
  const artifact = build.artifacts.find(item => item.generation);
  assert.ok(artifact?.generation?.extensionHash, 'a succeeded Take must record an extension hash');
  return artifact.generation.extensionHash;
};

// ---------------------------------------------------------------------------
// Runway: gen4.5 (packaged) + Study-Runway (project-owned), one adapter.
// ---------------------------------------------------------------------------

function runwayGen45Source(attempt: string): ProviderSource {
  return {
    id: `s_${attempt}`,
    kind: 'provider',
    output: 'picture',
    endpoint: 'runway',
    model: 'gen4.5',
    prompt: 'a red rally car drifting through a snowy mountain pass at dawn',
    mode: 'text',
    references: [],
    requestedFrames: 24,
    fps: 24,
    size: '1280:720',
    seed: 7,
    attempt,
    parameters: { durationSeconds: 4, ratio: '1280:720' },
  };
}

function runwayStudySource(attempt: string): ProviderSource {
  return {
    id: `s_${attempt}`,
    kind: 'provider',
    output: 'picture',
    endpoint: 'runway',
    model: 'Study-Runway',
    prompt: 'an original test pattern moving across the frame',
    mode: 'text',
    references: [],
    requestedFrames: 24,
    fps: 24,
    size: '1280:720',
    attempt,
    parameters: { style: 'custom' },
  };
}

/**
 * A project-owned Runway model definition + mapping: a DIFFERENT model id with a
 * DIFFERENT wire body, executed by the SAME `runway-v1` adapter.
 */
async function runwayStudyExtension(root: string): Promise<GenerationExtension> {
  const modulePath = join(root, 'study-runway.mjs');
  await writeFile(
    modulePath,
    `export function extension(z, file) { return { implementationFiles: [file], model: { id: 'Study-Runway', medium: 'video', parameters: z.object({ style: z.literal('custom') }).strict(), validate(source) { if (source.kind !== 'provider') throw Error('video only'); if (source.mode !== 'text') throw Error('text only'); } }, mapping: { model: 'Study-Runway', protocol: 'runway-v1', validate() {}, videoBody(source, parameters, wireModel) { return { model: wireModel, promptText: source.prompt, studyStyle: parameters.style }; }, requestIdentity(source, parameters, wireModel) { return { route: 'text_to_video', model: wireModel, promptText: source.prompt, studyStyle: parameters.style }; } } }; }`,
  );
  const module = (await import(pathToFileURL(modulePath).href)) as {
    extension(zod: typeof z, file: string): GenerationExtension;
  };
  return module.extension(z, modulePath);
}

test('the same Runway adapter executes two different model definitions (one project-owned) through Plan -> Build', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      await writePng(join(root, 'assets'), 'hero.png', 64);
      const asset = imageAsset('hero', 'assets/hero.png', await hashFile(join(root, 'assets', 'hero.png')));

      // --- Model A: packaged gen4.5, selected on the ordinary endpoint. ---
      const configGen45 = {
        endpoint: { protocol: 'runway-v1' as const, baseUrl: fixture.baseUrl, model: 'gen4.5' },
        testOnly: { baseUrl: fixture.baseUrl },
        extension: runwayGen45Extension(),
      };
      await writeProjectFixture(root, runwayGen45Source('reuse-gen45'), asset, 24);
      const planA = await planBuild(root, { providers: { videoApi: { runway: configGen45 } } });
      assert.equal(planA.buildable, true, JSON.stringify(planA.blockers));
      assert.equal(fixture.submits.length, 0, 'Plan must not submit');
      const buildA = await buildProject(root, { providers: { videoApi: { runway: configGen45 } } });
      assert.equal(buildA.status, 'succeeded', buildA.error);
      assert.equal(buildA.result?.simulated, true);
      assert.equal(fixture.submits.length, 1);
      assert.equal(fixture.submits[0].path, '/v1/text_to_video');
      const bodyA = JSON.parse(fixture.submits[0].body) as Record<string, unknown>;
      assert.equal(bodyA.model, 'gen4.5');
      assert.equal(bodyA.ratio, '1280:720');
      assert.equal(bodyA.duration, 4);
      assert.equal(bodyA.studyStyle, undefined, 'gen4.5 must not carry the custom model field');
      const hashA = generationOf(buildA);
      const againA = await buildProject(root, { providers: { videoApi: { runway: configGen45 } } });
      assert.equal(againA.status, 'succeeded', againA.error);
      assert.equal(fixture.submits.length, 1, 'a re-Build of gen4.5 must reuse its Take');
      assert.ok(againA.operations.find(item => item.kind === 'provider')!.reused);

      // --- Model B: a PROJECT-OWNED custom Runway model, SAME adapter. ---
      const extension = await runwayStudyExtension(root);
      const configStudy = {
        endpoint: { protocol: 'runway-v1' as const, baseUrl: fixture.baseUrl },
        testOnly: { baseUrl: fixture.baseUrl },
        extension,
      };
      await setSource(root, runwayStudySource('reuse-study'));
      const planB = await planBuild(root, { providers: { videoApi: { runway: configStudy } } });
      assert.equal(planB.buildable, true, JSON.stringify(planB.blockers));
      assert.equal(fixture.submits.length, 1, 'Plan of the second model must not submit');
      const buildB = await buildProject(root, { providers: { videoApi: { runway: configStudy } } });
      assert.equal(buildB.status, 'succeeded', buildB.error);
      assert.equal(fixture.submits.length, 2);
      assert.equal(fixture.submits[1].path, '/v1/text_to_video');
      const bodyB = JSON.parse(fixture.submits[1].body) as Record<string, unknown>;
      assert.equal(bodyB.model, 'Study-Runway');
      assert.equal(bodyB.studyStyle, 'custom', 'the custom mapping must shape the wire body');
      assert.equal(bodyB.ratio, undefined, 'the packaged gen4.5 field must not leak into the custom model');
      const hashB = generationOf(buildB);
      assert.notEqual(hashB, hashA, 'the extension/request identity must differ per model');
      const againB = await buildProject(root, { providers: { videoApi: { runway: configStudy } } });
      assert.equal(againB.status, 'succeeded', againB.error);
      assert.equal(fixture.submits.length, 2, 'a re-Build of the custom model must reuse its Take');
      assert.ok(againB.operations.find(item => item.kind === 'provider')!.reused);

      // The SAME adapter entry point executes the custom model directly too.
      const direct = await generateRunway(root, runwayStudySource('reuse-study-direct'), OUTPUT, 'build/direct.mp4', {
        ...configStudy,
        references: undefined,
      });
      assert.equal(direct.backend, 'runway-gen4.5');
      assert.equal(direct.generation?.model, 'Study-Runway');
      assert.equal(fixture.submits.length, 3);
    });
  });
});

// ---------------------------------------------------------------------------
// fal: wan-3.0 (packaged) + Study-Fal (project-owned), one adapter.
// ---------------------------------------------------------------------------

const firstFrame = (asset: string): ProviderSource['references'] => [{ asset, category: 'image', role: 'first-frame' }];

function wan30Source(attempt: string): ProviderSource {
  return {
    id: `s_${attempt}`,
    kind: 'provider',
    output: 'picture',
    endpoint: 'fal',
    model: 'alibaba/wan-3.0/image-to-video',
    prompt: 'a red rally car drifting through a snowy mountain pass at dawn',
    mode: 'first-last-frame',
    references: firstFrame('hero'),
    requestedFrames: 24,
    fps: 24,
    size: '1280:720',
    seed: 7,
    attempt,
    parameters: { durationSeconds: 5, resolution: '720p', ratio: '16:9', audio: true },
  };
}

function falStudySource(attempt: string): ProviderSource {
  return {
    id: `s_${attempt}`,
    kind: 'provider',
    output: 'picture',
    endpoint: 'fal',
    model: 'Study-Fal',
    prompt: 'an original test pattern moving across the frame',
    mode: 'first-last-frame',
    references: firstFrame('hero'),
    requestedFrames: 24,
    fps: 24,
    size: '1280:720',
    attempt,
    parameters: { style: 'queue' },
  };
}

/**
 * A project-owned fal queue model definition + mapping with its OWN `endpointId`
 * route facet, executed by the SAME `fal-queue` adapter.
 */
async function falStudyExtension(root: string): Promise<GenerationExtension> {
  const modulePath = join(root, 'study-fal.mjs');
  await writeFile(
    modulePath,
    `export function extension(z, file) { return { implementationFiles: [file], model: { id: 'Study-Fal', medium: 'video', parameters: z.object({ style: z.literal('queue') }).strict(), validate(source) { if (source.kind !== 'provider') throw Error('video only'); } }, mapping: { model: 'Study-Fal', protocol: 'fal-queue', endpointId: 'study/queue-model', validate() {}, videoBody(source, parameters, wireModel, references) { const first = references.find(r => r.role === 'first-frame'); return { prompt: source.prompt, start_image_url: 'data:' + first.mime + ';base64,' + Buffer.from(first.bytes).toString('base64'), studyStyle: parameters.style }; }, requestIdentity(source, parameters, wireModel, references) { const first = references.find(r => r.role === 'first-frame'); return { route: 'queue', model: wireModel, prompt: source.prompt, start_image: { sha256: first.sha256 }, studyStyle: parameters.style }; } } }; }`,
  );
  const module = (await import(pathToFileURL(modulePath).href)) as {
    extension(zod: typeof z, file: string): GenerationExtension;
  };
  return module.extension(z, modulePath);
}

test('the same fal adapter executes two different model definitions (one project-owned) through Plan -> Build', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      await writePng(join(root, 'assets'), 'hero.png', 64);
      const asset = imageAsset('hero', 'assets/hero.png', await hashFile(join(root, 'assets', 'hero.png')));

      // --- Model A: packaged wan-3.0 on the ordinary endpoint. ---
      const configWan = {
        endpoint: { protocol: 'fal-queue' as const, baseUrl: fixture.baseUrl, model: 'alibaba/wan-3.0/image-to-video' },
        testOnly: { baseUrl: fixture.baseUrl },
        extension: wan30FalExtension(),
        references: [{ asset, root }],
      };
      await writeProjectFixture(root, wan30Source('reuse-wan'), asset, 24);
      const planA = await planBuild(root, { providers: { videoApi: { fal: configWan } } });
      assert.equal(planA.buildable, true, JSON.stringify(planA.blockers));
      assert.equal(fixture.submits.length, 0, 'Plan must not submit');
      const buildA = await buildProject(root, { providers: { videoApi: { fal: configWan } } });
      assert.equal(buildA.status, 'succeeded', buildA.error);
      assert.equal(buildA.result?.simulated, true);
      assert.equal(fixture.submits.length, 1);
      assert.equal(fixture.submits[0].path, '/alibaba/wan-3.0/image-to-video');
      const bodyA = JSON.parse(fixture.submits[0].body) as Record<string, unknown>;
      assert.equal(bodyA.aspect_ratio, '16:9');
      assert.equal(bodyA.resolution, '720p');
      assert.equal(bodyA.studyStyle, undefined, 'wan-3.0 must not carry the custom model field');
      const hashA = generationOf(buildA);
      const againA = await buildProject(root, { providers: { videoApi: { fal: configWan } } });
      assert.equal(againA.status, 'succeeded', againA.error);
      assert.equal(fixture.submits.length, 1, 'a re-Build of wan-3.0 must reuse its Take');
      assert.ok(againA.operations.find(item => item.kind === 'provider')!.reused);

      // --- Model B: a PROJECT-OWNED custom fal model with its own route facet. ---
      const extension = await falStudyExtension(root);
      const configStudy = {
        endpoint: { protocol: 'fal-queue' as const, baseUrl: fixture.baseUrl },
        testOnly: { baseUrl: fixture.baseUrl },
        extension,
        references: [{ asset, root }],
      };
      await setSource(root, falStudySource('reuse-study-fal'));
      const planB = await planBuild(root, { providers: { videoApi: { fal: configStudy } } });
      assert.equal(planB.buildable, true, JSON.stringify(planB.blockers));
      assert.equal(fixture.submits.length, 1, 'Plan of the second model must not submit');
      const buildB = await buildProject(root, { providers: { videoApi: { fal: configStudy } } });
      assert.equal(buildB.status, 'succeeded', buildB.error);
      assert.equal(fixture.submits.length, 2);
      assert.equal(
        fixture.submits[1].path,
        '/study/queue-model',
        'the queue paths must derive from the custom mapping endpointId',
      );
      const bodyB = JSON.parse(fixture.submits[1].body) as Record<string, unknown>;
      assert.equal(bodyB.studyStyle, 'queue', 'the custom mapping must shape the wire body');
      assert.equal(bodyB.aspect_ratio, undefined, 'the packaged wan-3.0 field must not leak into the custom model');
      const hashB = generationOf(buildB);
      assert.notEqual(hashB, hashA, 'the extension/request identity must differ per model');
      const againB = await buildProject(root, { providers: { videoApi: { fal: configStudy } } });
      assert.equal(againB.status, 'succeeded', againB.error);
      assert.equal(fixture.submits.length, 2, 'a re-Build of the custom model must reuse its Take');
      assert.ok(againB.operations.find(item => item.kind === 'provider')!.reused);

      // The SAME adapter entry point executes the custom model directly too.
      const direct = await generateFal(
        root,
        falStudySource('reuse-study-fal-direct'),
        OUTPUT,
        'build/direct.mp4',
        configStudy,
      );
      assert.equal(direct.backend, 'fal-wan-3.0');
      assert.equal(direct.generation?.model, 'Study-Fal');
      assert.equal(fixture.submits.length, 3);

      // Each accepted Take decodes to real media.
      for (const artifact of buildB.artifacts.filter(item => item.generation)) {
        assert.ok(
          (await probeMedia(join(root, artifact.path))).frames > 0,
          'a produced Take must be real decodable media',
        );
      }
    });
  });
});

// ---------------------------------------------------------------------------
// fal: the SAME queue transport also serves a TEXT-to-video model with ZERO
// references — the adapter must not assume the packaged first-frame shape.
// ---------------------------------------------------------------------------

function falTextSource(attempt: string): ProviderSource {
  return {
    id: `s_${attempt}`,
    kind: 'provider',
    output: 'picture',
    endpoint: 'fal',
    model: 'Study-Fal-Text',
    prompt: 'an original text-to-video test pattern moving across the frame',
    mode: 'text',
    references: [],
    requestedFrames: 24,
    fps: 24,
    size: '1280:720',
    attempt,
    parameters: { style: 'text' },
  };
}

/** A project-owned fal queue model with NO references: a text-to-video mapping. */
async function falTextExtension(root: string): Promise<GenerationExtension> {
  const modulePath = join(root, 'study-fal-text.mjs');
  await writeFile(
    modulePath,
    `export function extension(z, file) { return { implementationFiles: [file], model: { id: 'Study-Fal-Text', medium: 'video', parameters: z.object({ style: z.literal('text') }).strict(), validate(source) { if (source.kind !== 'provider') throw Error('video only'); if (source.mode !== 'text') throw Error('text only'); if ((source.references ?? []).length) throw Error('text model takes no references'); } }, mapping: { model: 'Study-Fal-Text', protocol: 'fal-queue', endpointId: 'study/queue-text', validate() {}, videoBody(source, parameters) { return { prompt: source.prompt, studyStyle: parameters.style }; }, requestIdentity(source, parameters) { return { route: 'text', prompt: source.prompt, studyStyle: parameters.style }; } } }; }`,
  );
  const module = (await import(pathToFileURL(modulePath).href)) as {
    extension(zod: typeof z, file: string): GenerationExtension;
  };
  return module.extension(z, modulePath);
}

test('the same fal adapter executes a TEXT-to-video model with zero references through Plan -> Build', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      const extension = await falTextExtension(root);
      const config = {
        endpoint: { protocol: 'fal-queue' as const, baseUrl: fixture.baseUrl },
        testOnly: { baseUrl: fixture.baseUrl },
        extension,
      };
      await writeProjectFixture(root, falTextSource('reuse-fal-text'), undefined, 24);

      const plan = await planBuild(root, { providers: { videoApi: { fal: config } } });
      assert.equal(plan.buildable, true, JSON.stringify(plan.blockers));
      assert.equal(fixture.submits.length, 0, 'Plan must not submit');

      const build = await buildProject(root, { providers: { videoApi: { fal: config } } });
      assert.equal(build.status, 'succeeded', build.error);
      assert.equal(fixture.submits.length, 1);
      assert.equal(
        fixture.submits[0].path,
        '/study/queue-text',
        'the text-to-video route derives from the custom endpointId',
      );
      const body = JSON.parse(fixture.submits[0].body) as Record<string, unknown>;
      assert.equal(body.studyStyle, 'text');
      assert.equal(body.start_image_url, undefined, 'a text-to-video request must carry no image field');
      const artifact = build.artifacts.find(item => item.generation);
      assert.ok(artifact, 'the build must produce a generation artifact');
      assert.equal(
        (artifact!.generation as { references: unknown[] }).references.length,
        0,
        'a zero-reference request records no transmitted references',
      );
      assert.ok(
        (await probeMedia(join(root, artifact!.path))).frames > 0,
        'the produced Take must be real decodable media',
      );

      const again = await buildProject(root, { providers: { videoApi: { fal: config } } });
      assert.equal(again.status, 'succeeded', again.error);
      assert.equal(fixture.submits.length, 1, 'a re-Build of the text-to-video model must reuse its Take');
      assert.ok(again.operations.find(item => item.kind === 'provider')!.reused);

      const direct = await generateFal(
        root,
        falTextSource('reuse-fal-text-direct'),
        OUTPUT,
        'build/direct-text.mp4',
        config,
      );
      assert.equal(direct.backend, 'fal-wan-3.0');
      assert.equal(direct.generation?.model, 'Study-Fal-Text');
      assert.equal(direct.generation?.references.length, 0);
      assert.equal(fixture.submits.length, 2);
    });
  });
});
