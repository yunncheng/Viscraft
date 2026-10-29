/**
 * Provider, credential and extension boundaries. Real adapters run against
 * loopback fixtures and tiny local media; no real credentials or generation.
 */
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import type { Asset, OutputSettings, ProviderSource } from '../src/core/schema.js';
import { isPrivateAddress } from '../src/backends/providers/address.js';
import { cancelFal, generateFal } from '../src/backends/providers/services/fal/index.js';
import { generateVideoApi, VideoApiPendingError } from '../src/backends/providers/services/video-tasks.js';
import {
  generateImageApi,
  prepareImageRequest,
  type ImageApiOptions,
} from '../src/backends/providers/services/vllm-omni/image-api.js';
import { generationExtensionIdentity, type GenerationExtension } from '../src/backends/providers/extension.js';
import { prepareVideoRequest } from '../src/backends/providers/prepare.js';
import { minimaxH3Ref2vaExtension } from '../src/backends/providers/models/minimax-h3.js';
import { wan30FalMapping } from '../src/backends/providers/mappings/fal-wan30.js';
import { seedance25ArkMapping } from '../src/backends/providers/mappings/seedance-ark.js';
import { attemptStem } from '../src/backends/providers/job-store.js';
import { sourceOperationIdentity } from '../src/build/identity.js';
import { createProject, generateImage, planBuild, preflightGenerateImage, ProjectSchema } from '../src/index.js';
import { providerReadiness } from '../src/config/readiness.js';
import { loadUserEndpoints } from '../src/config/endpoints.js';
import { stableHash, hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';

const OUTPUT: OutputSettings = {
  width: 96,
  height: 64,
  fps: { numerator: 24, denominator: 1 },
  sampleRate: 48000,
  channels: 1,
};

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-fixture-prov-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Real FFmpeg fixtures (tiny, fast)
// ---------------------------------------------------------------------------

let cachedVideo: Promise<Buffer> | undefined;
function providerVideo(): Promise<Buffer> {
  cachedVideo ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'viscraft-fixture-media-'));
    try {
      const file = join(dir, 'provider.mp4');
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
        'testsrc2=size=96x64:rate=24:duration=1',
        '-frames:v',
        '24',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        file,
      ]);
      return await readFile(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })();
  return cachedVideo;
}

let cachedPng: Promise<Buffer> | undefined;
function providerPng(): Promise<Buffer> {
  cachedPng ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'viscraft-fixture-png-'));
    try {
      const file = join(dir, 'hero.png');
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
        'testsrc2=size=96x96:rate=1:duration=1',
        '-frames:v',
        '1',
        '-pix_fmt',
        'rgb24',
        file,
      ]);
      return await readFile(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })();
  return cachedPng;
}

async function writePng(root: string, rel: string): Promise<Asset> {
  const abs = join(root, rel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, await providerPng());
  return {
    id: 'hero',
    revision: 1,
    path: rel,
    sha256: await hashFile(abs),
    type: 'image',
    rights: { origin: 'original FFmpeg fixture', license: 'CC0-1.0', redistributable: true },
    simulated: false,
  };
}

// ---------------------------------------------------------------------------
// the ONE shared address classifier
// ---------------------------------------------------------------------------

test('the shared address classifier normalizes mapped IPv6 and refuses multicast/reserved', () => {
  // IPv4-mapped IPv6 must classify exactly like its IPv4 form, including
  // multicast ranges.
  assert.equal(isPrivateAddress('::ffff:224.0.0.1'), true, 'mapped multicast must be private');
  assert.equal(isPrivateAddress('0:0:0:0:0:ffff:224.0.0.1'), true, 'expanded mapped multicast must be private');
  assert.equal(isPrivateAddress('::ffff:8.8.8.8'), false, 'mapped public stays public');
  assert.equal(isPrivateAddress('224.0.0.1'), true, 'IPv4 multicast must be private');
  assert.equal(isPrivateAddress('255.255.255.255'), true, 'reserved/broadcast must be private');
  assert.equal(isPrivateAddress('ff02::1'), true, 'IPv6 multicast must be private');
  assert.equal(isPrivateAddress('fe80::1'), true, 'IPv6 link-local must be private');
  assert.equal(isPrivateAddress('fc00::1'), true, 'IPv6 unique-local must be private');
  assert.equal(isPrivateAddress('::1'), true, 'IPv6 loopback must be private');
  assert.equal(isPrivateAddress('127.0.0.1'), true, 'IPv4 loopback must be private');
  assert.equal(isPrivateAddress('10.0.0.1'), true, 'RFC1918 must be private');
  assert.equal(isPrivateAddress('192.168.1.1'), true, 'RFC1918 must be private');
  assert.equal(isPrivateAddress('100.64.0.1'), true, 'CGNAT must be private');
  assert.equal(isPrivateAddress('8.8.8.8'), false, 'a public IPv4 stays public');
  assert.equal(isPrivateAddress('2606:4700:4700::1111'), false, 'a public IPv6 stays public');
  assert.equal(isPrivateAddress('not-an-address'), true, 'an unparseable host is treated as unsafe');
});

// ---------------------------------------------------------------------------
// cancelFal binds the persisted mode + queue base
// ---------------------------------------------------------------------------

type FalStatus = 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED';

interface FalFixture {
  baseUrl: string;
  state: { submits: number; cancels: number; paths: { method: string; path: string }[] };
  status: FalStatus;
  close: () => Promise<void>;
}

async function withFalFixture(
  fn: (fixture: FalFixture) => Promise<void>,
  options: { prefix?: string; status?: FalStatus } = {},
): Promise<void> {
  const media = await providerVideo();
  const prefix = options.prefix ?? '';
  const state: FalFixture['state'] = { submits: 0, cancels: 0, paths: [] };
  let status: FalStatus = options.status ?? 'IN_QUEUE';
  let port = 0;
  const base = () => `http://127.0.0.1:${port}${prefix}`;
  const routes = (id: string) => ({
    status: `${base()}/alibaba/wan-3.0/image-to-video/requests/${id}/status`,
    result: `${base()}/alibaba/wan-3.0/image-to-video/requests/${id}`,
  });
  const strip = (rawPath: string): string =>
    prefix && rawPath.startsWith(prefix) ? rawPath.slice(prefix.length) || '/' : rawPath;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const rawPath = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const path = strip(rawPath);
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      state.paths.push({ method: req.method ?? '', path: rawPath });
      if (req.method === 'POST' && path === '/alibaba/wan-3.0/image-to-video') {
        state.submits++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'IN_QUEUE',
            request_id: 'req_p0',
            status_url: routes('req_p0').status,
            response_url: routes('req_p0').result,
          }),
        );
        return;
      }
      if (req.method === 'GET' && /\/requests\/req_p0\/status$/.test(path)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status, request_id: 'req_p0' }));
        return;
      }
      if (req.method === 'GET' && /\/requests\/req_p0$/.test(path)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ video: { url: `${base()}/media/out.mp4` }, seed: 1, duration: 5 }));
        return;
      }
      if (req.method === 'GET' && path.startsWith('/media/')) {
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': media.length });
        res.end(media);
        return;
      }
      if (req.method === 'PUT' && /\/requests\/req_p0\/cancel$/.test(path)) {
        state.cancels++;
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'CANCELLATION_REQUESTED' }));
        return;
      }
      res.writeHead(404);
      res.end('nf');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
  const fixture: FalFixture = {
    baseUrl: base(),
    state,
    get status() {
      return status;
    },
    set status(next: FalStatus) {
      status = next;
    },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
  try {
    await fn(fixture);
  } finally {
    await fixture.close();
  }
}

function falSource(attempt: string): ProviderSource {
  return {
    id: 'falx',
    kind: 'provider',
    output: 'picture',
    endpoint: 'fal',
    model: 'alibaba/wan-3.0/image-to-video',
    prompt: 'a red kite over a calm sea',
    mode: 'first-last-frame',
    references: [{ asset: 'hero', category: 'image', role: 'first-frame' }],
    requestedFrames: 24,
    fps: 24,
    size: '16:9',
    seed: 3,
    attempt,
    parameters: { durationSeconds: 5, resolution: '720p', ratio: '16:9', audio: true },
  };
}

test('cancelFal refuses a mode/origin mismatch before any PUT and never targets production', async () => {
  await withRoot(async root => {
    const hero = await writePng(root, 'assets/hero.png');
    await withFalFixture(async fixture => {
      const options = { testOnly: { baseUrl: fixture.baseUrl }, references: [{ asset: hero, root }] };
      // Submit once; the fixture keeps the request IN_QUEUE so the job stays `submitted`.
      fixture.status = 'IN_QUEUE';
      await assert.rejects(() => generateFal(root, falSource('c1'), OUTPUT, 'build/c.mp4', options));
      assert.equal(fixture.state.submits, 1);

      // Omitted options resolve the PRODUCTION queue -> refused, no PUT.
      await assert.rejects(
        () => cancelFal(root, 'c1', {}),
        /production queue|different service|loopback|refus|baseUrl|production address/i,
      );
      assert.equal(fixture.state.cancels, 0, 'a mode mismatch must not send a cancel');

      // A different test fixture origin resolves the same mode but a different
      // queue base -> refused, no PUT.
      await withFalFixture(
        async other => {
          await assert.rejects(
            () => cancelFal(root, 'c1', { testOnly: { baseUrl: other.baseUrl } }),
            /different queue|refus/i,
          );
          assert.equal(other.state.cancels, 0);
        },
        { status: 'IN_QUEUE' },
      );

      // The matching fixture cancels exactly once.
      const cancelled = await cancelFal(root, 'c1', options);
      assert.deepEqual(cancelled, { attempt: 'c1', requestId: 'req_p0', state: 'cancelled' });
      assert.equal(fixture.state.cancels, 1);
      assert.equal(fixture.state.submits, 1, 'cancel never resubmits');
    });
  });
});

// ---------------------------------------------------------------------------
// full queue base prefix + endpointId in the fal request identity
// ---------------------------------------------------------------------------

test('fal uses the FULL queue base prefix on the wire and freezes it (queueHash) with the endpointId', async () => {
  await withRoot(async root => {
    const hero = await writePng(root, 'assets/hero.png');
    const key = 'FAL_KEY';
    const previous = process.env[key];
    process.env[key] = 'fixture-fal-fixture-key';
    try {
      await withFalFixture(
        async fixture => {
          fixture.status = 'IN_QUEUE';
          const options = {
            endpoint: { protocol: 'fal-queue' as const, baseUrl: fixture.baseUrl },
            authorization: { submit: true, uploadAssets: ['hero'] },
            references: [{ asset: hero, root }],
          };
          await assert.rejects(() => generateFal(root, falSource('h1'), OUTPUT, 'build/h.mp4', options));
          // The submit reached the PREFIXED path, not the bare origin path.
          assert.ok(
            fixture.state.paths.some(
              entry => entry.method === 'POST' && entry.path === '/api/queue/alibaba/wan-3.0/image-to-video',
            ),
            `submit must use the prefixed route, saw ${JSON.stringify(fixture.state.paths)}`,
          );
          const job = JSON.parse(
            await readFile(join(root, `.viscraft/jobs/fal/${attemptStem('falx', 'h1')}.json`), 'utf8'),
          ) as { queueHash: string; endpointId: string; origin?: string };
          assert.equal(job.endpointId, 'alibaba/wan-3.0/image-to-video');
          assert.equal(
            job.queueHash,
            stableHash(fixture.baseUrl),
            'the full prefixed base is frozen, not just its origin',
          );
          assert.equal(job.origin, undefined, 'no remote URL is persisted');
        },
        { prefix: '/api/queue', status: 'IN_QUEUE' },
      );
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });
});

// ---------------------------------------------------------------------------
// local output change is NOT a different remote request
// ---------------------------------------------------------------------------

interface VllmOmniVideoFixture {
  baseUrl: string;
  state: { posts: number; gets: number; downloads: number };
  status: 'queued' | 'completed';
  failDownload: boolean;
  close: () => Promise<void>;
}

async function withVllmOmniVideoFixture(fn: (fixture: VllmOmniVideoFixture) => Promise<void>): Promise<void> {
  const media = await providerVideo();
  const state: VllmOmniVideoFixture['state'] = { posts: 0, gets: 0, downloads: 0 };
  let status: 'queued' | 'completed' = 'completed';
  let failDownload = false;
  let port = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (req.method === 'POST' && url === '/v1/videos') {
        state.posts++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'task_p0', status: 'queued' }));
        return;
      }
      if (req.method === 'GET' && url === '/v1/videos/task_p0') {
        state.gets++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'task_p0', status, error: null, inference_time_s: 0.1 }));
        return;
      }
      if (req.method === 'GET' && url === '/v1/videos/task_p0/content') {
        state.downloads++;
        if (failDownload) {
          failDownload = false;
          res.writeHead(503);
          res.end('retry');
          return;
        }
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': media.length });
        res.end(media);
        return;
      }
      res.writeHead(404);
      res.end('nf');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
  const fixture: VllmOmniVideoFixture = {
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    get status() {
      return status;
    },
    set status(next: 'queued' | 'completed') {
      status = next;
    },
    get failDownload() {
      return failDownload;
    },
    set failDownload(next: boolean) {
      failDownload = next;
    },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
  try {
    await fn(fixture);
  } finally {
    await fixture.close();
  }
}

function videoSource(attempt: string): ProviderSource {
  return {
    id: 'motion',
    kind: 'provider',
    output: 'picture',
    model: 'fixture-video',
    endpoint: 'default',
    prompt: 'a slow dolly across a quiet pier',
    mode: 'text',
    references: [],
    requestedFrames: 12,
    size: '96:64',
    fps: 12,
    attempt,
  };
}

test('a changed LOCAL output re-materializes the retained original with zero POST (video-api)', async () => {
  await withRoot(async root => {
    await withVllmOmniVideoFixture(async fixture => {
      const options = { testOnly: { baseUrl: fixture.baseUrl } };
      await generateVideoApi(root, videoSource('i1'), OUTPUT, 'build/i.mp4', options);
      assert.equal(fixture.state.posts, 1);

      // Same remote request, different LOCAL sampleRate: must NOT read as a
      // different frozen request, must NOT re-POST, and must adopt the new output.
      const changed: OutputSettings = { ...OUTPUT, sampleRate: 44100 };
      await generateVideoApi(root, videoSource('i1'), changed, 'build/i2.mp4', options);
      assert.equal(fixture.state.posts, 1, 'a local output change must not resubmit');
      const job = JSON.parse(
        await readFile(join(root, `.viscraft/jobs/video-api/${attemptStem('motion', 'i1')}.json`), 'utf8'),
      ) as { output: OutputSettings };
      assert.equal(job.output.sampleRate, 44100, 'the record adopts the new local output');

      // The recorded remote identity still rejects a genuinely changed request.
      await assert.rejects(
        () =>
          generateVideoApi(
            root,
            { ...videoSource('i1'), prompt: 'a totally different scene' },
            changed,
            'build/i3.mp4',
            options,
          ),
        /different frozen request|new attempt|request.*changed/i,
      );
      assert.equal(fixture.state.posts, 1);
    });
  });
});

test('a changed LOCAL output re-materializes the retained original with zero POST (fal)', async () => {
  await withRoot(async root => {
    const hero = await writePng(root, 'assets/hero.png');
    await withFalFixture(async fixture => {
      const options = { testOnly: { baseUrl: fixture.baseUrl }, references: [{ asset: hero, root }] };
      fixture.status = 'COMPLETED';
      await generateFal(root, falSource('i2'), OUTPUT, 'build/f.mp4', options);
      assert.equal(fixture.state.submits, 1);

      await generateFal(root, falSource('i2'), { ...OUTPUT, sampleRate: 44100 }, 'build/f2.mp4', options);
      assert.equal(fixture.state.submits, 1, 'a local output change must not resubmit');
      const job = JSON.parse(
        await readFile(join(root, `.viscraft/jobs/fal/${attemptStem('falx', 'i2')}.json`), 'utf8'),
      ) as { output: OutputSettings };
      assert.equal(job.output.sampleRate, 44100);
    });
  });
});

// ---------------------------------------------------------------------------
// video-api consumes the auto-selected packaged extension
// ---------------------------------------------------------------------------

test('video-api uses the auto-selected packaged extension for the frozen identity when none is supplied', async () => {
  await withRoot(async root => {
    const hero = await writePng(root, 'assets/hero.png');
    await withVllmOmniVideoFixture(async fixture => {
      fixture.status = 'queued';
      // A MiniMax-H3 request with NO explicit extension: the packaged definition
      // must be auto-selected (as `prepareVideoRequest` does) and used for the
      // frozen extension identity, not the caller's (undefined) extension.
      const source: ProviderSource = {
        id: 'h3auto',
        kind: 'provider',
        output: 'picture',
        model: 'minimax-h3-base-ref2va',
        endpoint: 'default',
        prompt: 'a paper boat on a puddle',
        mode: 'reference',
        references: [{ asset: 'hero', category: 'image', role: 'identity' }],
        requestedFrames: 97,
        size: '768:768',
        fps: 24,
        attempt: 'f1',
        parameters: {},
      };
      await assert.rejects(
        () =>
          generateVideoApi(root, source, OUTPUT, 'build/h3.mp4', {
            testOnly: { baseUrl: fixture.baseUrl },
            references: [{ asset: hero, root }],
          }),
        // The fixture reports `queued`, so the run is a recoverable pending — the
        // submit + persisted identity already happened.
        /not complete|resubmitting|pending/i,
      );
      const expected = await generationExtensionIdentity({ extension: minimaxH3Ref2vaExtension() });
      const job = JSON.parse(
        await readFile(join(root, `.viscraft/jobs/video-api/${attemptStem('h3auto', 'f1')}.json`), 'utf8'),
      ) as { extensionHash: string };
      assert.equal(job.extensionHash, expected, 'the auto-selected packaged definition must drive the frozen identity');
      assert.equal(fixture.state.posts, 1);
    });
  });
});

// ---------------------------------------------------------------------------
// a zero-reference image request with a validating extension
// ---------------------------------------------------------------------------

test('a zero-reference image request with a validating extension does not throw', async () => {
  let setCalls = 0;
  const extension: GenerationExtension = {
    implementationFiles: [fileURLToPath(import.meta.url)],
    model: {
      id: 'Fixture-Image',
      medium: 'image',
      parameters: z.object({}).strict(),
      validate() {},
      validateReferenceSet() {
        setCalls++;
      },
    },
    mapping: {
      model: 'Fixture-Image',
      protocol: 'vllm-omni-image',
      validate() {},
      imageFields() {
        return {};
      },
    },
  };
  const options: ImageApiOptions = { testOnly: { baseUrl: 'http://127.0.0.1:1' }, extension };
  const prepared = await prepareImageRequest(
    {
      id: 'img_zero',
      attempt: 1,
      asset: 'out_zero',
      rights: { origin: 'x', license: 'CC0-1.0', redistributable: true },
      endpoint: 'test',
      operation: 'generate',
      model: 'Fixture-Image',
      prompt: 'a blue circle',
    },
    options,
  );
  assert.equal(prepared.references.length, 0);
  assert.equal(setCalls, 1, 'the effective extension validateReferenceSet runs with an empty reference set');
});

// ---------------------------------------------------------------------------
// image success evidence before the target write + preflight provenance
// ---------------------------------------------------------------------------

interface ImageFixture {
  baseUrl: string;
  posts: number;
  close: () => Promise<void>;
}

async function withImageFixture(fn: (fixture: ImageFixture) => Promise<void>): Promise<void> {
  const png = await providerPng();
  const fixture: ImageFixture = { baseUrl: '', posts: 0, close: async () => {} };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (req.method === 'POST' && (path === '/v1/images/generations' || path === '/v1/images/edits')) {
        fixture.posts++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ created: 1, data: [{ b64_json: png.toString('base64') }] }));
        return;
      }
      res.writeHead(404);
      res.end('nf');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  fixture.baseUrl = `http://127.0.0.1:${port}`;
  fixture.close = () => new Promise<void>(resolve => server.close(() => resolve()));
  try {
    await fn(fixture);
  } finally {
    await fixture.close();
  }
}

const IMAGE_REQUEST = {
  id: 'req',
  attempt: 1,
  asset: 'out',
  rights: { origin: 'generated by fixture', license: 'CC0-1.0', redistributable: true },
  endpoint: 'test',
  operation: 'generate' as const,
  model: 'Qwen-Image',
  prompt: 'a lone lighthouse on a stormy cliff',
};
const JOB_REL = `.viscraft/jobs/image-api/req.1.json`;

test('a target-write failure leaves a recoverable `succeeded` record (zero POST on retry)', async () => {
  await withRoot(async root => {
    await withImageFixture(async fixture => {
      const options = { testOnly: { baseUrl: fixture.baseUrl } };
      // A destination that resolves but cannot be written: it is an existing
      // DIRECTORY, so the retained-original write succeeds and the target
      // `rename` fails.
      await mkdir(join(root, 'outdir'));
      await assert.rejects(() => generateImageApi(root, IMAGE_REQUEST, 'outdir', options));
      assert.equal(fixture.posts, 1);
      const afterFailure = JSON.parse(await readFile(join(root, JOB_REL), 'utf8')) as { state: string };
      assert.equal(afterFailure.state, 'succeeded', 'definite-success evidence is persisted before the target write');

      // Retry against a free destination: re-materializes, no POST.
      await generateImageApi(root, IMAGE_REQUEST, 'build/out.png', options);
      assert.equal(fixture.posts, 1, 'the retry must not resubmit');
      assert.ok(existsSync(join(root, 'build/out.png')));
    });
  });
});

test('the generate-image preflight requires matching generation provenance, not just bytes', async () => {
  await withRoot(async root => {
    await createProject(root, { title: 'Provenance' });
    await withImageFixture(async fixture => {
      const options = { providers: { imageApi: { test: { testOnly: { baseUrl: fixture.baseUrl } } } } };
      await generateImage(root, IMAGE_REQUEST, options);

      // Tamper ONLY the recorded provenance identity on the registered Asset,
      // keeping its bytes/hash: a different request that happened to produce the
      // same image is NOT the same occurrence.
      const projectFile = join(root, 'project.json');
      const project = JSON.parse(await readFile(projectFile, 'utf8')) as {
        assets: Array<{ id: string; imageGeneration?: { requestHash: string } }>;
      };
      const out = project.assets.find(asset => asset.id === 'out')!;
      out.imageGeneration!.requestHash = 'f'.repeat(64);
      await writeFile(projectFile, JSON.stringify(project));

      const check = await preflightGenerateImage(root, IMAGE_REQUEST, options);
      assert.equal(check.action, 'blocked');
      assert.equal(check.target.exists, true);
      assert.notEqual(check.target.sameContent, true, 'identical bytes with a different provenance must not be reused');
      assert.ok(
        check.issues.some(issue => issue.code === 'asset-conflict'),
        `expected an asset-conflict, got ${JSON.stringify(check.issues)}`,
      );
      assert.equal(fixture.posts, 1, 'a blocked preflight sends nothing');
    });
  });
});

// ---------------------------------------------------------------------------
// Ark result refresh is a gated query; a pending refresh stays waitable
// ---------------------------------------------------------------------------

interface ArkFixture {
  baseUrl: string;
  state: { posts: number; statusGets: number; downloads: number };
  status: 'queued' | 'running' | 'succeeded';
  failDownload: boolean;
  close: () => Promise<void>;
}

async function withArkFixture(fn: (fixture: ArkFixture) => Promise<void>): Promise<void> {
  const media = await providerVideo();
  const state: ArkFixture['state'] = { posts: 0, statusGets: 0, downloads: 0 };
  let status: ArkFixture['status'] = 'succeeded';
  let failDownload = false;
  let port = 0;
  const base = () => `http://127.0.0.1:${port}`;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (req.method === 'POST' && url.pathname === '/contents/generations/tasks') {
        state.posts++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'ark_p0' }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/contents/generations/tasks/ark_p0') {
        state.statusGets++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'ark_p0',
            status,
            ...(status === 'succeeded'
              ? { content: { video_url: `${base()}/media/out.mp4?signature=secret-token` } }
              : {}),
          }),
        );
        return;
      }
      if (req.method === 'GET' && url.pathname === '/media/out.mp4') {
        state.downloads++;
        if (failDownload) {
          failDownload = false;
          res.writeHead(503);
          res.end('retry');
          return;
        }
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': media.length });
        res.end(media);
        return;
      }
      res.writeHead(404);
      res.end('nf');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
  const fixture: ArkFixture = {
    baseUrl: base(),
    state,
    get status() {
      return status;
    },
    set status(next: ArkFixture['status']) {
      status = next;
    },
    get failDownload() {
      return failDownload;
    },
    set failDownload(next: boolean) {
      failDownload = next;
    },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
  try {
    await fn(fixture);
  } finally {
    await fixture.close();
  }
}

function arkSource(attempt: string): ProviderSource {
  return {
    id: 'seed',
    kind: 'provider',
    output: 'picture',
    model: 'Seedance-2.5',
    endpoint: 'ark',
    prompt: 'a slow aerial over rice terraces',
    mode: 'text',
    references: [],
    requestedFrames: 96,
    size: '1280:720',
    fps: 24,
    attempt,
    parameters: { ratio: 'adaptive' },
  };
}

test('Ark refresh runs through the query path and a pending refresh stays waitable (never a download failure)', async () => {
  await withRoot(async root => {
    await withArkFixture(async fixture => {
      // The Ark protocol must be declared so the packaged Seedance definition is
      // auto-selected; the loopback `testOnly` still wins for transport.
      const options = {
        endpoint: { protocol: 'ark-video-v3' as const, baseUrl: fixture.baseUrl },
        testOnly: { baseUrl: fixture.baseUrl },
      };
      // 1) Complete + fail the download once.
      fixture.status = 'succeeded';
      fixture.failDownload = true;
      await assert.rejects(
        () => generateVideoApi(root, arkSource('k1'), OUTPUT, 'build/k.mp4', options),
        /download failed/i,
      );
      const failed = JSON.parse(
        await readFile(join(root, `.viscraft/jobs/video-api/${attemptStem('seed', 'k1')}.json`), 'utf8'),
      ) as { state: string };
      assert.equal(failed.state, 'download-failed');
      // The signed URL / its secret query is never persisted.
      const raw = await readFile(join(root, `.viscraft/jobs/video-api/${attemptStem('seed', 'k1')}.json`), 'utf8');
      assert.ok(!raw.includes('signature=secret-token'), 'the signed URL must not be persisted');
      assert.equal(fixture.state.posts, 1);
      const getsAfterFirst = fixture.state.statusGets;

      // 2) Resume while the task is still running: a bounded, recoverable pending,
      //    NOT a generic download failure (which would be unrecoverable noise).
      fixture.status = 'running';
      await assert.rejects(
        () => generateVideoApi(root, arkSource('k1'), OUTPUT, 'build/k.mp4', options),
        VideoApiPendingError,
      );
      const stillFailed = JSON.parse(
        await readFile(join(root, `.viscraft/jobs/video-api/${attemptStem('seed', 'k1')}.json`), 'utf8'),
      ) as { state: string };
      assert.equal(stillFailed.state, 'download-failed', 'a pending refresh must not be mislabeled a download failure');
      assert.ok(fixture.state.statusGets > getsAfterFirst, 'the refresh used the gated query path');
      assert.equal(fixture.state.posts, 1);

      // 3) Task completes: the fresh signed URL is used for a legitimate download.
      fixture.status = 'succeeded';
      const result = await generateVideoApi(root, arkSource('k1'), OUTPUT, 'build/k.mp4', options);
      assert.equal(result.backend.length > 0, true);
      assert.equal(fixture.state.posts, 1, 'the resume never resubmits');
      const done = JSON.parse(
        await readFile(join(root, `.viscraft/jobs/video-api/${attemptStem('seed', 'k1')}.json`), 'utf8'),
      ) as { state: string };
      assert.equal(done.state, 'succeeded');
    });
  });
});

// ---------------------------------------------------------------------------
// per-endpoint config parsing + honest Ark credential readiness
// ---------------------------------------------------------------------------

async function withConfigHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'viscraft-fixture-config-'));
  const previous = process.env.VISCRAFT_CONFIG_HOME;
  process.env.VISCRAFT_CONFIG_HOME = home;
  try {
    await fn(home);
  } finally {
    if (previous === undefined) delete process.env.VISCRAFT_CONFIG_HOME;
    else process.env.VISCRAFT_CONFIG_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

test('a malformed Endpoint does not discard the good ones, and Ark needs a credential', async () => {
  await withConfigHome(async home => {
    // One good image endpoint + one malformed video endpoint, plus an Ark endpoint
    // with no named credential.
    await writeFile(
      join(home, 'endpoints.json'),
      JSON.stringify({
        video: [
          { endpoint: 'broken', service: 'nope', model: 'nope' },
          {
            endpoint: 'ark',
            service: 'ark',
            model: 'seedance-2.5',
            url: 'https://ark.example.test',
            deploymentModel: 'seedance-account',
          },
        ],
        image: [
          { endpoint: 'default', service: 'vllm-omni', model: 'Qwen/Qwen-Image', url: 'https://img.example.test' },
        ],
      }),
    );

    const readiness = providerReadiness();
    // The good video (Ark) and image entries survive; the malformed one is reported.
    const videoEndpoints = readiness.capabilities.provider.endpoints.map(entry => entry.endpoint);
    assert.ok(videoEndpoints.includes('ark'), `good video endpoint kept, got ${JSON.stringify(videoEndpoints)}`);
    assert.ok(!videoEndpoints.includes('broken'), 'the malformed endpoint is dropped, not fatal');
    assert.ok(
      readiness.capabilities['image-generation'].endpoints.some(entry => entry.endpoint === 'default'),
      'a malformed video endpoint must not empty the image list',
    );
    assert.ok(readiness.error && /broken/.test(readiness.error), `the malformed entry is reported: ${readiness.error}`);

    // Ark v3 always authenticates even when the Endpoint names no credential.
    const ark = readiness.capabilities.provider.endpoints.find(entry => entry.endpoint === 'ark')!;
    assert.equal(ark.credential, 'VISCRAFT_VIDEO_ARK_API_KEY');
    assert.equal(ark.credentialSource, 'missing');
    assert.equal(ark.ready, false, 'Ark must not report ready without a credential');
    assert.equal(readiness.capabilities.provider.ready, false);

    // The strict loader still refuses a mis-typed binding loudly (Plan/Build path).
    assert.throws(() => loadUserEndpoints(), /Invalid user endpoint configuration/);
  });
});

test('an Ark endpoint with a named credential present reports ready', async () => {
  await withConfigHome(async home => {
    const key = 'VISCRAFT_VIDEO_ARK_API_KEY';
    const previous = process.env[key];
    process.env[key] = 'fixture-ark-secret';
    try {
      await writeFile(
        join(home, 'endpoints.json'),
        JSON.stringify({
          video: [
            {
              endpoint: 'ark',
              service: 'ark',
              model: 'seedance-2.5',
              url: 'https://ark.example.test',
              deploymentModel: 'seedance-account',
            },
          ],
        }),
      );
      const readiness = providerReadiness();
      const ark = readiness.capabilities.provider.endpoints.find(entry => entry.endpoint === 'ark')!;
      assert.equal(ark.credential, key);
      assert.equal(ark.credentialSource, 'environment');
      assert.equal(ark.ready, true);
      assert.equal(readiness.capabilities.provider.ready, true);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });
});

// ---------------------------------------------------------------------------
// provider preflight uses the REAL reference byte size
// ---------------------------------------------------------------------------

const BIG_SHA = 'a'.repeat(64);

function bigAsset(id: string, path: string, type: Asset['type'] = 'image'): Asset {
  return {
    id,
    revision: 1,
    path,
    sha256: BIG_SHA,
    type,
    rights: { origin: 'original FFmpeg fixture', license: 'CC0-1.0', redistributable: true },
    simulated: false,
  };
}

/** A permissive extension so only the TRANSPORT size check runs (no model media profile). */
function permissiveExtension(id: string, mapping: GenerationExtension['mapping']): GenerationExtension {
  return {
    implementationFiles: [fileURLToPath(import.meta.url)],
    model: {
      id,
      medium: 'video',
      parameters: z.object({}).strict(),
      validate() {},
    },
    mapping,
  };
}

test('an oversized fal reference image is refused at preflight (no POST)', async () => {
  await withRoot(async root => {
    // 4 MiB > the 3.5 MiB raw transfer cap.
    await writeFile(join(root, 'big.png'), Buffer.alloc(4 * 1024 * 1024));
    const asset = bigAsset('big', 'big.png');
    const source: ProviderSource = {
      id: 'falbig',
      kind: 'provider',
      output: 'picture',
      endpoint: 'ep',
      model: 'alibaba/wan-3.0/image-to-video',
      prompt: 'p',
      mode: 'first-last-frame',
      references: [{ asset: 'big', category: 'image', role: 'first-frame' }],
      requestedFrames: 24,
      fps: 24,
      size: '16:9',
      attempt: 'b1',
      parameters: {},
    };
    assert.throws(
      () =>
        prepareVideoRequest(source, {
          endpoint: { protocol: 'fal-queue', baseUrl: 'https://queue.fal.run' },
          extension: permissiveExtension('alibaba/wan-3.0/image-to-video', wan30FalMapping),
          references: [{ asset, root }],
        }),
      /raw transfer limit/,
    );
  });
});

test('an oversized generic reference is refused at preflight (no POST)', async () => {
  await withRoot(async root => {
    // 31 MiB > the 30 MiB image transfer cap.
    await writeFile(join(root, 'big.bin'), Buffer.alloc(31 * 1024 * 1024));
    const asset = bigAsset('big', 'big.bin');
    const source: ProviderSource = {
      id: 'genericbig',
      kind: 'provider',
      output: 'picture',
      endpoint: 'ep',
      model: 'fixture-video',
      prompt: 'p',
      mode: 'reference',
      references: [{ asset: 'big', category: 'image', role: 'identity' }],
      requestedFrames: 24,
      fps: 24,
      size: '96:64',
      attempt: 'g1',
    };
    assert.throws(
      () =>
        prepareVideoRequest(source, {
          endpoint: { protocol: 'vllm-omni-video', baseUrl: 'https://example.test' },
          references: [{ asset, root }],
        }),
      /transfer limit/,
    );
  });
});

test('an Ark body over 64 MiB (inline reference) is refused at preflight (no POST)', async () => {
  await withRoot(async root => {
    // 50 MiB of inline image -> base64 ~66.7 MiB -> over the 64 MiB Ark body cap.
    await writeFile(join(root, 'big.png'), Buffer.alloc(50 * 1024 * 1024));
    const asset = bigAsset('big', 'big.png');
    const source: ProviderSource = {
      id: 'arkbig',
      kind: 'provider',
      output: 'picture',
      endpoint: 'ep',
      model: 'Seedance-2.5',
      prompt: 'p',
      mode: 'reference',
      references: [{ asset: 'big', category: 'image', role: 'identity' }],
      requestedFrames: 96,
      fps: 24,
      size: '1280:720',
      attempt: 'a1',
      parameters: {},
    };
    assert.throws(
      () =>
        prepareVideoRequest(source, {
          endpoint: { protocol: 'ark-video-v3', baseUrl: 'https://ark.example.test' },
          extension: permissiveExtension('Seedance-2.5', seedance25ArkMapping),
          references: [{ asset, root }],
        }),
      /Ark request body/,
    );
  });
});

test('an oversized reference is a PLAN blocker (no submission)', async () => {
  await withRoot(async root => {
    await writeFile(join(root, 'big.bin'), Buffer.alloc(31 * 1024 * 1024));
    const project = ProjectSchema.parse({
      schemaVersion: 1,
      id: 'p0size',
      revision: 1,
      title: 'Size preflight',
      direction: { intent: 'p', looks: [{ id: 'default', description: 'd' }], transitions: [] },
      assets: [bigAsset('big', 'big.bin')],
      bindings: {},
      sources: [
        {
          id: 'src',
          kind: 'provider',
          output: 'picture',
          endpoint: 'ep',
          model: 'fixture-video',
          prompt: 'p',
          mode: 'reference',
          references: [{ asset: 'big', category: 'image', role: 'identity' }],
          requestedFrames: 48,
          size: '96:64',
          fps: 24,
          attempt: 'a1',
        },
      ],
      composition: {
        output: { width: 96, height: 64, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 1 },
        scenes: [{ id: 'scene', description: 's' }],
        shots: [{ id: 'shot', scene: 'scene', look: 'default', intent: 'i', targetFrames: 48 }],
        placements: [{ id: 'pl', shot: 'shot', source: 'src', inFrame: 0, outFrame: 48, startFrame: 0, audio: 'mute' }],
        transitions: [],
        audio: [],
      },
    });
    await writeFile(join(root, 'project.json'), JSON.stringify(project));
    const plan = await planBuild(root, {
      providers: { videoApi: { ep: { endpoint: { protocol: 'vllm-omni-video', baseUrl: 'https://example.test' } } } },
    });
    const blocker = plan.blockers.find(issue => issue.code === 'model-request-invalid');
    assert.ok(blocker, `expected a model-request-invalid blocker, got ${JSON.stringify(plan.blockers)}`);
    assert.equal(plan.buildable, false);
  });
});

// ---------------------------------------------------------------------------
// the Operation key freezes only the locators the protocol USES
// ---------------------------------------------------------------------------

function locatorProject(model: string): ReturnType<typeof ProjectSchema.parse> {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'locators',
    revision: 1,
    title: 'Locators',
    direction: { intent: 'p', looks: [{ id: 'default', description: 'd' }], transitions: [] },
    assets: [bigAsset('img', 'img.png')],
    bindings: {},
    sources: [
      {
        id: 'src',
        kind: 'provider',
        output: 'picture',
        endpoint: 'ep',
        model,
        prompt: 'p',
        mode: 'reference',
        references: [{ asset: 'img', category: 'image', role: 'identity' }],
        requestedFrames: 48,
        size: '96:64',
        fps: 24,
        attempt: 'a1',
      },
    ],
    composition: {
      output: { width: 96, height: 64, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 1 },
      scenes: [{ id: 'scene', description: 's' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'default', intent: 'i', targetFrames: 48 }],
      placements: [{ id: 'pl', shot: 'shot', source: 'src', inFrame: 0, outFrame: 48, startFrame: 0, audio: 'mute' }],
      transitions: [],
      audio: [],
    },
  });
}

test('an UNUSED locator does not change the Operation key, a USED one does', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-fixture-locator-'));
  try {
    await writeFile(join(root, 'img.png'), 'x');
    const output: OutputSettings = OUTPUT;
    const identity = async (
      protocol: 'fal-queue' | 'runway-v1' | 'ark-video-v3',
      model: string,
      locators: Record<string, { url: string; sha256: string }>,
    ) => {
      const project = locatorProject(model);
      project.assets[0].sha256 = await hashFile(join(root, 'img.png'));
      const baseUrl =
        protocol === 'fal-queue'
          ? 'https://queue.fal.run'
          : protocol === 'runway-v1'
            ? 'https://api.dev.runwayml.com'
            : 'https://ark.example.test';
      const config = {
        providers: {
          videoApi: {
            ep: {
              endpoint: { protocol, baseUrl },
              referenceLocators: locators,
            },
          },
        },
      };
      const files = new Map(project.assets.map(asset => [asset.path, asset.sha256]));
      const resolved = await sourceOperationIdentity(project, project.sources[0], config, files, output, root);
      return stableHash(resolved.parameters);
    };
    const digest = await hashFile(join(root, 'img.png'));
    const locatorA = { img: { url: 'asset://img', sha256: digest } };
    const locatorB = { img: { url: 'asset://other', sha256: digest } };
    const unreferenced = { other: { url: 'asset://unused', sha256: BIG_SHA } };

    // (b) A vendor protocol never transmits through locators: changing one is invisible.
    assert.equal(
      await identity('fal-queue', 'alibaba/wan-3.0/image-to-video', locatorA),
      await identity('fal-queue', 'alibaba/wan-3.0/image-to-video', locatorB),
      'an unused locator must not change the fal Operation key',
    );
    assert.equal(
      await identity('runway-v1', 'gen4.5', locatorA),
      await identity('runway-v1', 'gen4.5', locatorB),
      'an unused locator must not change the Runway Operation key',
    );

    // (a) A locator for an asset the Source does not reference is not transmitted:
    // adding/removing it must be invisible on a generic protocol too.
    assert.equal(
      await identity('ark-video-v3', 'Seedance-2.5', locatorA),
      await identity('ark-video-v3', 'Seedance-2.5', { ...locatorA, ...unreferenced }),
      'a locator for an unreferenced asset must not change the Operation key',
    );

    // (c) The generic Ark transport transmits through locators: changing the
    // locator of a TRANSMITTED reference must invalidate the request.
    assert.notEqual(
      await identity('ark-video-v3', 'Seedance-2.5', locatorA),
      await identity('ark-video-v3', 'Seedance-2.5', locatorB),
      'a used locator must change the Ark Operation key',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unused (unreferenced) locator does not force a resubmit; a transmitted one does', async () => {
  await withRoot(async root => {
    const hero = await writePng(root, 'assets/hero.png');
    await withVllmOmniVideoFixture(async fixture => {
      const source: ProviderSource = {
        id: 'loc',
        kind: 'provider',
        output: 'picture',
        model: 'fixture-video',
        endpoint: 'default',
        prompt: 'a slow pan across a harbour',
        mode: 'reference',
        references: [{ asset: 'hero', category: 'image', role: 'identity' }],
        requestedFrames: 12,
        size: '96:64',
        fps: 12,
        attempt: 'l1',
      };
      const base = { testOnly: { baseUrl: fixture.baseUrl }, references: [{ asset: hero, root }] };
      const unusedLocator = (url: string) => ({ extra: { url, sha256: 'a'.repeat(64) } });

      // (a) A locator for an asset this Source does NOT reference is unused:
      // editing it must NOT read as a different frozen request.
      await generateVideoApi(root, source, OUTPUT, 'build/l1.mp4', {
        ...base,
        referenceLocators: unusedLocator('asset://extra-one'),
      });
      assert.equal(fixture.state.posts, 1);
      await generateVideoApi(root, source, OUTPUT, 'build/l2.mp4', {
        ...base,
        referenceLocators: unusedLocator('asset://extra-two'),
      });
      assert.equal(fixture.state.posts, 1, 'an unused locator must not force a resubmit');

      // (c) A locator for a TRANSMITTED reference IS part of the request identity:
      // changing it is a real request change and reuse must be refused.
      const refSource: ProviderSource = { ...source, attempt: 'l2' };
      await generateVideoApi(root, refSource, OUTPUT, 'build/m1.mp4', {
        ...base,
        referenceLocators: { hero: { url: 'asset://hero', sha256: hero.sha256 } },
      });
      assert.equal(fixture.state.posts, 2);
      await assert.rejects(
        () =>
          generateVideoApi(root, refSource, OUTPUT, 'build/m2.mp4', {
            ...base,
            referenceLocators: { hero: { url: 'asset://hero-changed', sha256: hero.sha256 } },
          }),
        /different frozen request|changed parameters/i,
      );
      assert.equal(
        fixture.state.posts,
        2,
        'a changed locator on a transmitted reference must be refused without resubmit',
      );
    });
  });
});
