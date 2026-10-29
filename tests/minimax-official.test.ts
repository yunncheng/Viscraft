import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SourceSchema, ProjectSchema, type ProviderSource, type Asset } from '../src/core/schema.js';
import { prepareVideoRequest } from '../src/backends/providers/prepare.js';
import { generateVideoService } from '../src/backends/providers/video-service.js';
import { minimaxVideoProtocol } from '../src/backends/providers/services/minimax/video.js';
import { validateGenerationReferenceSet } from '../src/backends/providers/extension.js';
import { packagedExtensionFor } from '../src/backends/providers/models/registry.js';
import { planBuild, buildProject } from '../src/index.js';
import { probeMedia } from '../src/backends/media/probe.js';
import { runCommand } from '../src/shared/process.js';
import { hashFile } from '../src/shared/hash.js';

const OUTPUT = {
  width: 160,
  height: 90,
  fps: { numerator: 24, denominator: 1 },
  sampleRate: 48000,
  channels: 2,
} as const;
const ENDPOINT = { protocol: 'minimax-video-v2' as const, baseUrl: 'https://api.minimax.io' };
const source = (overrides: Partial<ProviderSource> = {}): ProviderSource =>
  SourceSchema.parse({
    id: 'h3',
    kind: 'provider',
    output: 'picture',
    model: 'MiniMax-H3',
    endpoint: 'default',
    prompt: 'SIMULATED contract test: a sphere crosses a room',
    mode: 'text',
    references: [],
    requestedFrames: 96,
    fps: 24,
    size: '1344:768',
    attempt: 'take1',
    ...overrides,
  }) as ProviderSource;

test('official H3 selects its native mapping without vLLM deployment settings', () => {
  const prepared = prepareVideoRequest(source(), { endpoint: ENDPOINT });
  assert.equal(prepared.extension?.mapping.protocol, 'minimax-video-v2');
  assert.equal(prepared.credentialName, 'MINIMAX_API_KEY');
  assert.deepEqual(JSON.parse(prepared.encodedBody as string), {
    model: 'MiniMax-H3',
    content: [{ type: 'text', text: source().prompt }],
    duration: 4,
    resolution: '768P',
    ratio: '16:9',
  });
  assert.throws(
    () => prepareVideoRequest(source(), { endpoint: { protocol: 'vllm-omni-video', baseUrl: ENDPOINT.baseUrl } }),
    /no model definition and service mapping/,
  );
  assert.throws(
    () => prepareVideoRequest(source(), { endpoint: { ...ENDPOINT, modelSettings: { taskType: 'both' } } }),
    /no deployment/,
  );
  for (const extra of [{ seed: 1 }, { steps: 30 }, { flowShift: 12 }])
    assert.throws(() => prepareVideoRequest(source(extra), { endpoint: ENDPOINT }), /does not expose/);
  assert.throws(() => prepareVideoRequest(source({ requestedFrames: 361 }), { endpoint: ENDPOINT }), /4\.\.15/);
  assert.throws(
    () =>
      prepareVideoRequest(source({ parameters: { durationSeconds: 4 }, requestedFrames: 120 }), { endpoint: ENDPOINT }),
    /shorter/,
  );
});

test('native content preserves roles/order and service-specific reference rules', () => {
  const refs = [
    { asset: 'last', category: 'image' as const, role: 'last-frame' as const },
    { asset: 'first', category: 'image' as const, role: 'first-frame' as const },
  ];
  const prepared = prepareVideoRequest(source({ mode: 'first-last-frame', references: refs }), { endpoint: ENDPOINT });
  const body = prepared.mappingBody!;
  assert.equal(body.ratio, 'adaptive');
  assert.deepEqual(
    (body.content as Array<{ role?: string }>).map(item => item.role),
    [undefined, 'last_frame', 'first_frame'],
  );
  assert.throws(
    () =>
      prepareVideoRequest(source({ mode: 'first-last-frame', references: refs, parameters: { ratio: '16:9' } }), {
        endpoint: ENDPOINT,
      }),
    /adaptive/,
  );
  const audio = source({ mode: 'reference', references: [{ asset: 'voice', category: 'audio', role: 'audio' }] });
  assert.doesNotThrow(() => prepareVideoRequest(audio, { endpoint: ENDPOINT }));
  assert.throws(
    () =>
      prepareVideoRequest(
        { ...audio, model: 'minimax-h3-base-ref2va' },
        { endpoint: { protocol: 'vllm-omni-video', baseUrl: ENDPOINT.baseUrl } },
      ),
    /at least one image or video/,
  );
  const extension = packagedExtensionFor('MiniMax-H3', 'minimax-video-v2')!;
  assert.throws(
    () =>
      validateGenerationReferenceSet(extension, source({ mode: 'first-last-frame', references: [refs[0]] }), [
        { reference: refs[0], bytes: 1, width: 128, height: 128 },
      ]),
    /dimensions/,
  );
  assert.throws(
    () =>
      validateGenerationReferenceSet(extension, source({ mode: 'first-last-frame', references: [refs[0]] }), [
        { reference: refs[0], bytes: 1, width: 512, height: 512 },
      ]),
    /aspect/,
  );
  assert.notDeepEqual(
    prepareVideoRequest(source(), { endpoint: ENDPOINT }).requestIdentity,
    prepareVideoRequest(source({ parameters: { resolution: '2K' } }), { endpoint: ENDPOINT }).requestIdentity,
  );
});

test('official task parser uses its own envelope/status paths and rejects incomplete results', () => {
  assert.equal(minimaxVideoProtocol.statusPath('job1'), '/v2/query/video_generation/job1');
  assert.equal(minimaxVideoProtocol.parseCreate({ task_id: 'job1' }), 'job1');
  assert.throws(() => minimaxVideoProtocol.parseCreate({ id: 'job1' }));
  for (const status of ['queued', 'running', 'failed', 'cancelled', 'succeeded']) {
    const parsed = minimaxVideoProtocol.parseStatus(
      { task: { id: 'job1', status, content: { url: 'https://cdn.example/result.mp4' } } },
      'job1',
    );
    assert.equal(
      parsed.state,
      status === 'succeeded' ? 'ready' : ['failed', 'cancelled'].includes(status) ? 'failed' : 'pending',
    );
  }
  assert.throws(
    () => minimaxVideoProtocol.parseStatus({ task: { id: 'another', status: 'running' } }, 'job1'),
    /task id does not match/,
  );
  assert.throws(
    () => minimaxVideoProtocol.parseStatus({ task: { id: 'job1', status: 'succeeded' } }, 'job1'),
    /no video URL/,
  );
});

test('official preflight checks raw file caps and aggregate Base64 size without reading/uploading media', () => {
  const audio = { asset: 'voice', category: 'audio' as const, role: 'audio' as const };
  assert.throws(
    () =>
      prepareVideoRequest(source({ mode: 'reference', references: [audio] }), { endpoint: ENDPOINT }, [
        {
          ...audio,
          sha256: 'a'.repeat(64),
          mime: 'audio/wav',
          bytes: new Uint8Array(),
          byteLength: 15 * 1024 * 1024 + 1,
        },
      ]),
    /exceeds/,
  );
  const images = [0, 1, 2].map(i => ({ asset: `image${i}`, category: 'image' as const, role: 'identity' as const }));
  assert.throws(
    () =>
      prepareVideoRequest(
        source({ mode: 'reference', references: images }),
        { endpoint: ENDPOINT },
        images.map(ref => ({
          ...ref,
          sha256: 'b'.repeat(64),
          mime: 'image/png',
          bytes: new Uint8Array(),
          byteLength: 21 * 1024 * 1024,
        })),
      ),
    /request body/,
  );
});

interface Fixture {
  base: string;
  posts: number;
  queries: number;
  downloads: number;
  unknown: boolean;
  failDownload: boolean;
  status: string;
  missingUrl: boolean;
  body: Record<string, unknown>;
  mediaAuth?: string;
}
async function fixture(fn: (root: string, state: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-minimax-official-'));
  try {
    await runCommand('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=24:duration=4',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=4',
      '-c:v',
      'libx264',
      '-threads',
      '1',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      join(root, 'result.mp4'),
    ]);
    await runCommand('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=red:size=512x288',
      '-frames:v',
      '1',
      '-threads',
      '1',
      join(root, 'hero.png'),
    ]);
    const media = await readFile(join(root, 'result.mp4'));
    const state: Fixture = {
      base: '',
      posts: 0,
      queries: 0,
      downloads: 0,
      unknown: false,
      failDownload: false,
      status: 'succeeded',
      missingUrl: false,
      body: {},
    };
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/v2/video_generation') {
        state.posts++;
        state.body = JSON.parse(Buffer.concat(chunks).toString());
        if (state.unknown) {
          req.socket.destroy();
          return;
        }
        res.end(JSON.stringify({ task_id: 'job1' }));
      } else if (req.url === '/v2/query/video_generation/job1') {
        state.queries++;
        res.end(
          JSON.stringify({
            task: {
              id: 'job1',
              status: state.status,
              task_type: 'generation',
              ...(!state.missingUrl ? { content: { url: `${state.base}/result.mp4?token=temporary` } } : {}),
            },
          }),
        );
      } else if (req.url === '/result.mp4?token=temporary') {
        state.downloads++;
        state.mediaAuth = req.headers.authorization;
        if (state.failDownload) {
          state.failDownload = false;
          res.statusCode = 503;
          res.end('{}');
          return;
        }
        res.setHeader('Content-Type', 'video/mp4');
        res.end(media);
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
const options = (state: Fixture) => ({
  endpoint: { ...ENDPOINT, baseUrl: state.base },
  testOnly: { baseUrl: state.base },
});
const jobFile = (root: string) => join(root, '.viscraft/jobs/video-api/h3.take1.json');
async function expireQueryDelay(root: string): Promise<void> {
  const path = jobFile(root);
  const job = JSON.parse(await readFile(path, 'utf8'));
  job.nextQueryAt = new Date(0).toISOString();
  await writeFile(path, JSON.stringify(job));
}

test('real HTTP: native generation, failed download recovery and local restore never resubmit', async () => {
  await fixture(async (root, state) => {
    const asset: Asset = {
      id: 'hero',
      revision: 1,
      path: 'hero.png',
      type: 'image',
      sha256: await hashFile(join(root, 'hero.png')),
      rights: { origin: 'original test fixture', license: 'CC0-1.0', redistributable: true },
      simulated: false,
    };
    const src = source({
      mode: 'first-last-frame',
      references: [{ asset: 'hero', category: 'image', role: 'first-frame' }],
    });
    const opts = { ...options(state), references: [{ asset, root }] };
    state.failDownload = true;
    await assert.rejects(generateVideoService(root, src, OUTPUT, 'out.mp4', opts), /download|503/);
    await expireQueryDelay(root);
    const result = await generateVideoService(root, src, OUTPUT, 'out.mp4', opts);
    assert.equal(state.posts, 1);
    assert.equal(state.queries, 2);
    assert.equal(state.downloads, 2);
    assert.equal(state.mediaAuth, undefined);
    assert.equal(result.generation?.provider, 'video-api');
    assert.equal(JSON.parse(await readFile(jobFile(root), 'utf8')).simulated, true);
    assert.ok((await probeMedia(join(root, 'out.mp4'))).audio);
    const body = state.body as { content: Array<{ image_url?: { url: string } }> };
    assert.match(body.content[1].image_url!.url, /^data:image\/png;base64,/);
    const saved = await readFile(jobFile(root), 'utf8');
    assert.ok(!saved.includes('token=temporary') && !saved.includes('base64,') && !saved.includes(src.prompt));
    await rm(join(root, 'out.mp4'));
    await generateVideoService(root, src, OUTPUT, 'out.mp4', opts);
    assert.equal(state.posts, 1);
    assert.equal(state.queries, 2);
    assert.equal(state.downloads, 2);
    await assert.rejects(
      generateVideoService(root, { ...src, parameters: { resolution: '2K' } }, OUTPUT, 'changed.mp4', opts),
      /different frozen request|changed/i,
    );
    assert.equal(state.posts, 1);
  });
});

test('real HTTP: unknown submission and pending/failed/malformed tasks preserve their attempt', async () => {
  for (const behavior of ['unknown', 'running', 'failed', 'cancelled', 'missing-url']) {
    await fixture(async (root, state) => {
      state.unknown = behavior === 'unknown';
      state.missingUrl = behavior === 'missing-url';
      if (['running', 'failed', 'cancelled'].includes(behavior)) state.status = behavior;
      const opts = options(state);
      const expected =
        behavior === 'unknown'
          ? /submit outcome .* is unknown/
          : behavior === 'running'
            ? /is running/
            : behavior === 'missing-url'
              ? /malformed/
              : /generation failed/;
      await assert.rejects(generateVideoService(root, source(), OUTPUT, 'out.mp4', opts), expected, behavior);
      assert.equal(state.posts, 1, `${behavior}: the fixture must receive exactly one submission`);
      assert.equal(state.downloads, 0);
      if (behavior === 'running') {
        state.status = 'succeeded';
        await expireQueryDelay(root);
        await generateVideoService(root, source(), OUTPUT, 'out.mp4', opts);
        assert.equal(state.posts, 1);
        assert.equal(state.downloads, 1);
      } else {
        await assert.rejects(generateVideoService(root, source(), OUTPUT, 'out.mp4', opts));
        assert.equal(state.posts, 1);
      }
    });
  }
});

test('ordinary Project Plan/Build selects native H3 and produces editable-cut media through the fixture', async () => {
  await fixture(async (root, state) => {
    const project = ProjectSchema.parse({
      schemaVersion: 1,
      id: 'official_test',
      revision: 1,
      title: 'Official API simulated integration',
      direction: { intent: 'contract fixture', looks: [{ id: 'main', description: 'test' }], transitions: [] },
      assets: [],
      bindings: {},
      sources: [source()],
      composition: {
        output: OUTPUT,
        scenes: [{ id: 'scene', description: 'fixture' }],
        shots: [{ id: 'shot', scene: 'scene', look: 'main', intent: 'fixture', targetFrames: 96 }],
        placements: [{ id: 'p', shot: 'shot', source: 'h3', inFrame: 0, outFrame: 96, startFrame: 0, audio: 'keep' }],
        transitions: [],
        audio: [],
      },
    });
    await writeFile(join(root, 'project.json'), JSON.stringify(project));
    const opts = { providers: { videoApi: { default: options(state) } } };
    const plan = await planBuild(root, opts);
    assert.deepEqual(plan.blockers, []);
    assert.deepEqual(plan.needsConfiguration, []);
    assert.equal(plan.buildable, true);
    assert.equal(state.posts, 0);
    await buildProject(root, opts);
    assert.equal(state.posts, 1);
    await buildProject(root, opts);
    assert.equal(state.posts, 1);
  });
});

test('production authorization and credentials are required before any submission', async () => {
  await fixture(async (root, state) => {
    const endpoint = { ...ENDPOINT, baseUrl: state.base, credential: 'VISCRAFT_TEST_MISSING_MINIMAX_KEY' };
    await assert.rejects(
      generateVideoService(root, source(), OUTPUT, 'out.mp4', { endpoint }),
      /authorization|consent/i,
    );
    await assert.rejects(
      generateVideoService(root, source(), OUTPUT, 'out.mp4', { endpoint, authorization: { submit: true } }),
      /credential/i,
    );
    assert.equal(state.posts, 0);
  });
});
