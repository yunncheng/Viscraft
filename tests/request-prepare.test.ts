// ONE read-only request-preparation pipeline (`prepareVideoRequest`) is shared by
// the Plan preflight, the ordinary Build and the direct SDK, so:
//   (a) the same bad mapping / route / config / reference form is rejected
//       identically on every path, with a mapping/encoding problem surfaced as a
//       Plan BLOCKER;
//   (b) a missing or illegal fal `endpointId` is a Plan blocker (and a Build /
//       direct-SDK rejection) with zero upload and zero POST;
//   (c) a `vllm-omni-video` and an `ark-video-v3` request still prepare to the same
//       wire body and identity the protocol/extension own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import {
  ProjectSchema,
  planBuild,
  buildProject,
  prepareVideoRequest,
  validateVideoServiceRequest,
  seedance25ArkExtension,
} from '../src/index.js';
import type { Project, GenerationExtension, ProviderSource } from '../src/index.js';
import { vllmOmniVideoProtocol } from '../src/backends/providers/services/vllm-omni/video.js';
import type { MappingReference, MappingReferenceIdentity } from '../src/backends/providers/extension.js';
import { SourceSchema } from '../src/core/schema.js';

const OUTPUT = { width: 64, height: 48, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 2 };
const RIGHTS = { origin: 'original test fixture', license: 'original test media', redistributable: true };
const SHA = 'a'.repeat(64);
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_SHA = createHash('sha256').update(PNG_1X1).digest('hex');

const mappingRef = (over: Partial<MappingReference> = {}): MappingReference => ({
  asset: 'hero',
  sha256: SHA,
  category: 'image',
  role: 'first-frame',
  mime: 'image/png',
  bytes: new Uint8Array([1, 2, 3]),
  ...over,
});

const videoSource = (over: Record<string, unknown> = {}): ProviderSource =>
  SourceSchema.parse({
    id: 'src',
    kind: 'provider',
    output: 'picture',
    endpoint: 'ep',
    model: 'some-model',
    prompt: 'p',
    mode: 'text',
    references: [],
    requestedFrames: 48,
    size: '1280:720',
    fps: 24,
    attempt: 'a1',
    ...over,
  }) as ProviderSource;

/** A caller-supplied video extension with the given mapping behaviour. */
function videoExtension(
  model: string,
  protocol: string,
  mapping: Partial<GenerationExtension['mapping']> = {},
  modelValidate: () => void = () => {},
): GenerationExtension {
  return {
    implementationFiles: [fileURLToPath(import.meta.url)],
    model: { id: model, medium: 'video', parameters: z.record(z.unknown()), validate: modelValidate },
    mapping: { model, protocol, validate() {}, videoBody: () => ({}), ...mapping },
  };
}

function makeProject(sources: unknown[], assets: unknown[] = []): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'request_prepare',
    revision: 1,
    title: 'Request prepare',
    direction: { intent: 'preflight', looks: [{ id: 'default', description: 'Default look' }], transitions: [] },
    assets,
    bindings: {},
    sources,
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: 'scene' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'default', intent: 'shot', targetFrames: 48 }],
      placements: [{ id: 'pl', shot: 'shot', source: 'src', inFrame: 0, outFrame: 48, startFrame: 0, audio: 'mute' }],
      transitions: [],
      audio: [],
    },
  });
}

async function writeProject(root: string, project: Project, assetPaths: string[] = []): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const path of assetPaths) await writeFile(join(root, path), PNG_1X1);
  await writeFile(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-request-prepare-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const imageAsset = (id: string) => ({
  id,
  revision: 1,
  type: 'image' as const,
  path: `${id}.png`,
  sha256: PNG_SHA,
  rights: RIGHTS,
  simulated: false,
});

// ---------------------------------------------------------------------------
// (a) Plan and direct SDK reject the same bad mapping / config identically
// ---------------------------------------------------------------------------

test('a service-subset mapping rejection is a Plan blocker AND a direct-SDK rejection with the same reason', async () => {
  await withRoot(async root => {
    const source = videoSource();
    const extension = videoExtension('some-model', 'vllm-omni-video', {
      validate() {
        throw new Error('This service supports one image only');
      },
    });
    const config = {
      endpoint: { protocol: 'vllm-omni-video' as const, baseUrl: 'https://example.test' },
      extension,
      authorization: { submit: true },
    };
    await writeProject(root, makeProject([source]));

    const plan = await planBuild(root, { providers: { videoApi: { ep: config } } });
    const blocker = plan.blockers.find(issue => issue.code === 'model-request-invalid');
    assert.ok(blocker, 'a mapping the service subset refuses must be a Plan blocker');
    assert.match(blocker!.message, /one image only/);
    assert.equal(plan.buildable, false);

    assert.throws(() => validateVideoServiceRequest(source, config), /one image only/);
  });
});

test('a mapping/encode structural failure (non-scalar field) is a Plan blocker, never deferred to execution', async () => {
  await withRoot(async root => {
    const source = videoSource();
    const extension = videoExtension('some-model', 'vllm-omni-video', {
      videoBody: (_s, _p, wireModel) => ({ model: wireModel, prompt: 'p', nested: {} }),
    });
    const config = {
      endpoint: { protocol: 'vllm-omni-video' as const, baseUrl: 'https://example.test' },
      extension,
      authorization: { submit: true },
    };
    await writeProject(root, makeProject([source]));

    const plan = await planBuild(root, { providers: { videoApi: { ep: config } } });
    const blocker = plan.blockers.find(issue => issue.code === 'model-request-invalid');
    assert.ok(blocker, 'a non-scalar vllm-omni-video field must be a Plan blocker');
    assert.match(blocker!.message, /scalar/);
    assert.equal(plan.buildable, false);

    assert.throws(() => validateVideoServiceRequest(source, config), /scalar/);
  });
});

// ---------------------------------------------------------------------------
// (b) fal endpointId missing/illegal → Plan blocker + Build/SDK rejection, 0 POST
// ---------------------------------------------------------------------------

for (const [caseName, endpointId] of [
  ['missing', undefined],
  ['empty', ''],
  ['illegal (non-string)', 42],
  // A real route validation, not just "non-empty string" (a route that would
  // escape the endpoint path, carry a query/fragment, or hold whitespace).
  ['path traversal + query', '../escape?x=1'],
  ['interior whitespace', 'alibaba/wan 3.0/image-to-video'],
  ['doubled slash', 'alibaba//wan-3.0'],
  ['leading slash', '/alibaba/wan-3.0'],
  ['trailing slash', 'alibaba/wan-3.0/'],
  ['fragment', 'alibaba/wan-3.0#x'],
] as const) {
  test(`fal endpointId ${caseName} is refused on Plan, Build and direct SDK with zero upload and zero POST`, async () => {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    try {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const base = `http://127.0.0.1:${address.port}`;
      await withRoot(async root => {
        const source = videoSource({
          model: 'custom-fal-model',
          mode: 'first-last-frame',
          references: [{ asset: 'hero', category: 'image', role: 'first-frame' }],
        });
        const mapping: GenerationExtension['mapping'] = {
          model: 'custom-fal-model',
          protocol: 'fal-queue',
          validate() {},
          videoBody: () => ({}),
        };
        if (endpointId !== undefined) (mapping as unknown as { endpointId: unknown }).endpointId = endpointId;
        const extension: GenerationExtension = {
          implementationFiles: [fileURLToPath(import.meta.url)],
          model: { id: 'custom-fal-model', medium: 'video', parameters: z.record(z.unknown()), validate() {} },
          mapping,
        };
        const asset = imageAsset('hero');
        await writeProject(root, makeProject([source], [asset]), ['hero.png']);
        const config = {
          endpoint: { protocol: 'fal-queue' as const, baseUrl: base },
          testOnly: { baseUrl: base },
          extension,
          references: [{ asset, root }],
        };

        const plan = await planBuild(root, { providers: { videoApi: { ep: config } } });
        const blocker = plan.blockers.find(issue => issue.code === 'model-request-invalid');
        assert.ok(blocker, 'a fal mapping without a usable endpointId must be a Plan blocker');
        assert.match(blocker!.message, /endpointId/);
        assert.equal(plan.buildable, false);

        assert.throws(() => validateVideoServiceRequest(source, config), /endpointId/);
        await assert.rejects(() => buildProject(root, { providers: { videoApi: { ep: config } } }), /endpointId/);
        assert.deepEqual(requests, [], 'a refused route facet must send no request on any path');
      });
    } finally {
      await new Promise<void>(done => server.close(() => done()));
    }
  });
}

test('the packaged Wan fal route still prepares with its declared endpointId (no regression)', () => {
  const source = videoSource({
    model: 'alibaba/wan-3.0/image-to-video',
    mode: 'first-last-frame',
    references: [{ asset: 'hero', category: 'image', role: 'first-frame' }],
    size: '1280:720',
    parameters: { durationSeconds: 5, resolution: '720p', ratio: '16:9', audio: true },
  });
  const prepared = prepareVideoRequest(source, {
    endpoint: { protocol: 'fal-queue', baseUrl: 'https://queue.fal.run' },
  });
  assert.equal(prepared.endpointId, 'alibaba/wan-3.0/image-to-video');
  assert.ok(prepared.mappingBody);
});

test('a custom multi-level fal endpointId still prepares and routes (no over-rejection)', () => {
  const source = videoSource({ model: 'custom-fal-model', mode: 'text', references: [] });
  const mapping: GenerationExtension['mapping'] = {
    model: 'custom-fal-model',
    protocol: 'fal-queue',
    validate() {},
    videoBody: () => ({}),
    endpointId: 'acme/video/models/turbo',
  } as GenerationExtension['mapping'];
  const extension: GenerationExtension = {
    implementationFiles: [fileURLToPath(import.meta.url)],
    model: { id: 'custom-fal-model', medium: 'video', parameters: z.record(z.unknown()), validate() {} },
    mapping,
  };
  const prepared = prepareVideoRequest(source, {
    endpoint: { protocol: 'fal-queue', baseUrl: 'https://queue.fal.run' },
    extension,
  });
  assert.equal(prepared.endpointId, 'acme/video/models/turbo');
});

// ---------------------------------------------------------------------------
// (b2) A reference form the lane's transport cannot carry is refused everywhere
// ---------------------------------------------------------------------------

test('a Runway reference form the lane cannot carry is refused on Plan, Build and direct SDK with zero POST', async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    await withRoot(async root => {
      // The Source declares an IDENTITY image; the Runway lane carries exactly one
      // first-frame image and nothing else, so the request must be refused before
      // any adapter encodes it — not silently dropped (which is what a per-adapter
      // first-frame lookup would do).
      const source = videoSource({
        model: 'custom-runway-model',
        mode: 'reference',
        references: [{ asset: 'hero', category: 'image', role: 'identity' }],
      });
      const extension = videoExtension('custom-runway-model', 'runway-v1');
      const asset = imageAsset('hero');
      await writeProject(root, makeProject([source], [asset]), ['hero.png']);
      const config = {
        endpoint: { protocol: 'runway-v1' as const, baseUrl: base },
        testOnly: { baseUrl: base },
        extension,
        references: [{ asset, root }],
      };

      const plan = await planBuild(root, { providers: { videoApi: { ep: config } } });
      const blocker = plan.blockers.find(issue => issue.code === 'model-request-invalid');
      assert.ok(blocker, 'a reference form the Runway lane cannot carry must be a Plan blocker');
      assert.match(blocker!.message, /cannot transmit/);
      assert.equal(plan.buildable, false);

      assert.throws(() => validateVideoServiceRequest(source, config), /cannot transmit/);
      await assert.rejects(() => buildProject(root, { providers: { videoApi: { ep: config } } }), /cannot transmit/);
      assert.deepEqual(requests, [], 'a refused reference form must send no request on any path');
    });
  } finally {
    await new Promise<void>(done => server.close(() => done()));
  }
});

test('a fal reference form the queue transport cannot carry (a video reference) is refused before any upload', async () => {
  const source = videoSource({
    model: 'custom-fal-model',
    mode: 'reference',
    references: [{ asset: 'clip', category: 'video', role: 'material' }],
  });
  const mapping: GenerationExtension['mapping'] = {
    model: 'custom-fal-model',
    protocol: 'fal-queue',
    validate() {},
    videoBody: () => ({}),
    endpointId: 'acme/queue',
  } as GenerationExtension['mapping'];
  const extension: GenerationExtension = {
    implementationFiles: [fileURLToPath(import.meta.url)],
    model: { id: 'custom-fal-model', medium: 'video', parameters: z.record(z.unknown()), validate() {} },
    mapping,
  };
  assert.throws(
    () =>
      prepareVideoRequest(source, { endpoint: { protocol: 'fal-queue', baseUrl: 'https://queue.fal.run' }, extension }),
    /cannot transmit/,
  );
});

test('a Runway source with TWO references is refused by the shared count limit on Plan, Build and direct SDK (no transmit-without-consent)', async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    await withRoot(async root => {
      // A caller-supplied mapping whose `validate` does not itself restrict the
      // set: the per-reference rule alone would let BOTH images through, so the
      // shared preparation must enforce the lane's count too — otherwise the
      // second image would reach the wire without being in the consent scope.
      const source = videoSource({
        model: 'custom-runway-model',
        mode: 'reference',
        references: [
          { asset: 'a', category: 'image', role: 'first-frame' },
          { asset: 'b', category: 'image', role: 'first-frame' },
        ],
      });
      const extension = videoExtension('custom-runway-model', 'runway-v1');
      const assets = [imageAsset('a'), imageAsset('b')];
      await writeProject(root, makeProject([source], assets), ['a.png', 'b.png']);
      const config = {
        endpoint: { protocol: 'runway-v1' as const, baseUrl: base },
        testOnly: { baseUrl: base },
        extension,
        references: [
          { asset: assets[0], root },
          { asset: assets[1], root },
        ],
      };

      const plan = await planBuild(root, { providers: { videoApi: { ep: config } } });
      const blocker = plan.blockers.find(issue => issue.code === 'model-request-invalid');
      assert.ok(blocker, 'two references on the single-image Runway lane must be a Plan blocker');
      assert.match(blocker!.message, /at most 1/);
      assert.equal(plan.buildable, false);

      assert.throws(() => validateVideoServiceRequest(source, config), /at most 1/);
      await assert.rejects(() => buildProject(root, { providers: { videoApi: { ep: config } } }), /at most 1/);
      assert.deepEqual(requests, [], 'a refused reference count must send no request on any path');
    });
  } finally {
    await new Promise<void>(done => server.close(() => done()));
  }
});

// ---------------------------------------------------------------------------
// (c) vllm-omni-video and ark-video-v3 prepare to the same body/identity as before
// ---------------------------------------------------------------------------

test('identity-only preparation has no byte payload and never invokes the upload body or encoder', () => {
  const reference = {
    asset: 'hero',
    category: 'image' as const,
    role: 'first-frame' as const,
  };
  const identity: MappingReferenceIdentity = {
    ...reference,
    sha256: PNG_SHA,
    mime: 'image/png',
  };
  const extension = videoExtension('some-model', 'vllm-omni-video', {
    videoBody: () => {
      throw new Error('upload mapping must not run during identity-only preparation');
    },
    identityBody: source => ({
      model: source.model,
      prompt: source.prompt,
      width: 1280,
      height: 720,
      fps: source.fps,
      num_frames: source.requestedFrames,
      extra_params: '{}',
    }),
  });
  const prepared = prepareVideoRequest(
    videoSource({ mode: 'first-last-frame', references: [reference] }),
    { testOnly: { baseUrl: 'http://127.0.0.1:43210' }, extension },
    [identity],
    'identity-only test',
    true,
  );
  assert.equal(prepared.encodedBody, undefined);
  assert.ok(prepared.requestIdentity);
});

test('a vllm-omni-video request prepares to the generic encoder body and identity', () => {
  const source = videoSource();
  const prepared = prepareVideoRequest(source, {
    endpoint: { protocol: 'vllm-omni-video', baseUrl: 'https://example.test' },
  });
  assert.ok(prepared.encodedBody instanceof FormData);
  const form = prepared.encodedBody as FormData;
  assert.equal(form.get('model'), 'some-model');
  assert.equal(form.get('prompt'), 'p');
  assert.equal(form.get('num_frames'), '48');
  assert.equal(form.get('width'), '1280');
  assert.equal(form.get('height'), '720');
  assert.equal(prepared.wireModel, 'some-model');
  assert.deepEqual(
    prepared.requestIdentity,
    vllmOmniVideoProtocol.requestIdentity(prepared.source, prepared.wireModel, [], undefined),
  );
});

test('an ark-video-v3 request prepares to the JSON body and reference identity', () => {
  const source = videoSource({
    model: 'Seedance-2.5',
    mode: 'reference',
    references: [{ asset: 'hero', category: 'image', role: 'identity' }],
    requestedFrames: 96,
    size: '320:180',
    parameters: { durationSeconds: 4, resolution: '720p', ratio: '16:9', generateAudio: true },
  });
  const refs = [mappingRef({ asset: 'hero', role: 'identity', bytes: new Uint8Array([9]) })];
  const prepared = prepareVideoRequest(
    source,
    { endpoint: { protocol: 'ark-video-v3', baseUrl: 'https://example.test' }, extension: seedance25ArkExtension() },
    refs,
  );
  assert.equal(typeof prepared.encodedBody, 'string');
  const body = JSON.parse(prepared.encodedBody as string) as {
    model: string;
    duration: number;
    content: Array<{ type: string; text?: string }>;
  };
  assert.equal(body.model, 'Seedance-2.5');
  assert.equal(body.duration, 4);
  assert.equal(body.content[0].type, 'text');
  assert.equal(body.content[0].text, 'p');
  assert.equal((prepared.requestIdentity as { protocol: string }).protocol, 'ark-video-v3');
});

test('the default vendor extension is what an unconfigured Runway lane prepares against', () => {
  const source = videoSource({
    model: 'gen4.5',
    mode: 'text',
    size: '1280:720',
    parameters: { durationSeconds: 4, ratio: '1280:720' },
  });
  const prepared = prepareVideoRequest(source, {
    endpoint: { protocol: 'runway-v1', baseUrl: 'https://api.dev.runwayml.com' },
  });
  assert.equal(prepared.extension?.model.id, 'gen4.5');
  assert.equal((prepared.mappingBody as { model: string }).model, 'gen4.5');
  assert.equal((prepared.requestIdentity as { route: string }).route, 'text_to_video');
});
