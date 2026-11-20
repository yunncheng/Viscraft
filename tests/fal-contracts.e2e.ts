/**
 * fal adapter contract tests — real local transport, real media.
 *
 * These tests drive `generateFal` through a real Node HTTP fixture on loopback
 * (the adapter's documented test-only transport) and assert on the persisted
 * `.viscraft/jobs/fal/<sourceId>.<attempt>.json` records. A successful case downloads real
 * provider bytes and normalizes them with the shared FFmpeg media plane, so a
 * passing run means an actual probeable H.264 file was produced.
 *
 * The wire contract under test is the official OpenAPI for
 * `alibaba/wan-3.0/image-to-video` (queue origin `https://queue.fal.run`): submit
 * → `{ status, request_id, status_url, response_url }`; status → the queue enum;
 * result → `{ video: { url }, seed, duration }`. The fixture deliberately returns
 * the SDK's stripped status/result paths (`/alibaba/wan-3.0/requests/{id}`) to
 * prove both the official and stripped URL forms are accepted.
 *
 * High-risk invariants covered:
 *  - production submit is gated on explicit authorization + key, and each image on
 *    explicit per-Asset upload consent, before any job record or request;
 *  - an ambiguous submit (network/500/malformed/unusable URL) is never resubmitted;
 *  - a failed download resumes without regenerating (submit count stays 1);
 *  - a changed request under the same attempt id is rejected before any request;
 *  - secrets, prompts, data URIs and remote URLs are never persisted.
 */

import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Asset, OutputSettings, ProviderSource } from '../src/core/schema.js';
import { generateFal, cancelFal, falCapabilities, falStatus } from '../src/backends/providers/services/fal/index.js';
import { wan30FalMapping } from '../src/backends/providers/mappings/fal-wan30.js';
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
const JOB_FILE_REL = (attempt: string) => `.viscraft/jobs/fal/s_${attempt}.${attempt}.json`;
const PROVIDER_FILE_REL = (attempt: string) => `.viscraft/provider-media/fal-s_${attempt}.${attempt}.mp4`;

type RemoteStatus = 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED';

/** The default Wan 3.0 parameters (the model profile owns these, not the Source). */
const DEFAULT_PARAMETERS = { durationSeconds: 5, resolution: '720p', ratio: '16:9', audio: true } as const;

interface SourceOverrides {
  prompt?: string;
  mode?: 'text' | 'first-last-frame' | 'reference';
  references?: ProviderSource['references'];
  parameters?: Record<string, unknown>;
  seed?: number;
  size?: string;
}

function source(attempt: string, overrides: SourceOverrides = {}): ProviderSource {
  const parameters = overrides.parameters ?? { ...DEFAULT_PARAMETERS };
  return {
    id: `s_${attempt}`,
    kind: 'provider',
    output: 'picture',
    endpoint: 'fal',
    model: 'alibaba/wan-3.0/image-to-video',
    prompt: overrides.prompt ?? 'a red rally car drifting through a snowy mountain pass at dawn',
    mode: overrides.mode ?? 'first-last-frame',
    references: overrides.references ?? firstFrame('hero'),
    requestedFrames: 24,
    fps: 24,
    // The vendor accepts only its ratio strings; the required raster `size` must
    // match the requested ratio, so it is derived from it here.
    size: overrides.size ?? (parameters.ratio as string) ?? '16:9',
    seed: overrides.seed ?? 7,
    attempt,
    parameters,
  };
}

const firstFrame = (asset: string): ProviderSource['references'] => [{ asset, category: 'image', role: 'first-frame' }];
const framePair = (first: string, last: string): ProviderSource['references'] => [
  { asset: first, category: 'image', role: 'first-frame' },
  { asset: last, category: 'image', role: 'last-frame' },
];

async function readJob(root: string, attempt: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, JOB_FILE_REL(attempt)), 'utf8')) as Record<string, unknown>;
}

/** Concatenate the textual contents of every file under `root` (for leak scans). */
async function readAllText(root: string): Promise<string> {
  const parts: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile()) parts.push((await readFile(abs)).toString('utf8'));
    }
  };
  await walk(root);
  return parts.join('\n');
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-fal-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// --- A real, probeable provider media fixture (tiny 16:9 H.264), built once. ---
let cachedMedia: Promise<Buffer> | undefined;
function providerMedia(): Promise<Buffer> {
  cachedMedia ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'viscraft-fal-media-'));
    const file = join(dir, 'provider.mp4');
    try {
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
      return await readFile(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })();
  return cachedMedia;
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

function imageAsset(id: string, path: string, sha256: string, redistributable = true): Asset {
  return {
    id,
    revision: 1,
    path,
    sha256,
    type: 'image',
    rights: { origin: 'original FFmpeg fixture', license: 'CC0-1.0', redistributable },
    simulated: false,
  };
}

interface FixtureState {
  submits: number;
  statusGets: number;
  resultGets: number;
  downloads: number;
  cancels: number;
  requests: { method: string; path: string; authorization?: string; body: string }[];
}

interface FixtureConfig {
  requestId: string;
  /** Optional id the status endpoint echoes back (to exercise the id-match guard). */
  statusId?: string;
  statuses: RemoteStatus[];
  submit: 'ok' | 'http500' | 'http400' | 'malformed' | 'network';
  download: 'ok' | 'fail-once';
  /** Override the returned status_url (to exercise URL validation). */
  statusUrl?: (baseUrl: string, id: string) => string;
  /** Omit the returned status_url/response_url so the adapter must use the mapping's own route paths. */
  omitQueueUrls?: boolean;
  providerSeed: number;
  providerDuration: number;
  statusCode?: number;
  resultCode?: number;
  /** Cancel endpoint outcome (default: 202 CANCELLATION_REQUESTED). */
  cancel?: 'ok' | 'already-completed' | 'not-found';
  /**
   * Hostile-provider mode: the named endpoint answers HTTP 401 with a body that
   * deliberately echoes the `Authorization` header it received, so a test can
   * prove no credential is interpolated into an error or persisted.
   */
  echoAuth401?: 'submit' | 'status' | 'result';
}

interface Fixture {
  baseUrl: string;
  state: FixtureState;
  config: FixtureConfig;
  close: () => Promise<void>;
}

async function withFixture(
  fn: (fixture: Fixture) => Promise<void>,
  config: Partial<FixtureConfig> = {},
): Promise<void> {
  const media = await providerMedia();
  const state: FixtureState = { submits: 0, statusGets: 0, resultGets: 0, downloads: 0, cancels: 0, requests: [] };
  const full: FixtureConfig = {
    requestId: 'req_fixture_1',
    statuses: ['COMPLETED'],
    submit: 'ok',
    download: 'ok',
    providerSeed: 42,
    providerDuration: 5,
    ...config,
  };
  let port = 0;
  const baseUrl = () => `http://127.0.0.1:${port}`;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      state.requests.push({
        method: req.method ?? '',
        path,
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks).toString('utf8'),
      });

      if (req.method === 'POST' && path === '/alibaba/wan-3.0/image-to-video') {
        state.submits++;
        if (full.echoAuth401 === 'submit') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: `unauthorized: ${req.headers.authorization ?? ''}` }));
          return;
        }
        if (full.submit === 'network') {
          req.socket?.destroy();
          return;
        }
        if (full.submit === 'http500') {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ detail: 'internal' }));
          return;
        }
        if (full.submit === 'http400') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ detail: 'bad request' }));
          return;
        }
        if (full.submit === 'malformed') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('this is not json {');
          return;
        }
        const id = full.requestId;
        const statusUrl = full.statusUrl
          ? full.statusUrl(baseUrl(), id)
          : `${baseUrl()}/alibaba/wan-3.0/requests/${id}/status`;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(
            full.omitQueueUrls
              ? { status: 'IN_QUEUE', request_id: id }
              : {
                  status: 'IN_QUEUE',
                  request_id: id,
                  status_url: statusUrl,
                  response_url: `${baseUrl()}/alibaba/wan-3.0/requests/${id}`,
                },
          ),
        );
        return;
      }

      if (req.method === 'GET' && /^\/alibaba\/wan-3\.0\/(?:image-to-video\/)?requests\/[^/]+\/status$/.test(path)) {
        state.statusGets++;
        if (full.echoAuth401 === 'status') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: `unauthorized: ${req.headers.authorization ?? ''}` }));
          return;
        }
        if (full.statusCode) {
          res.writeHead(full.statusCode);
          res.end();
          return;
        }
        const requestedId = path.split('/requests/')[1].replace(/\/status$/, '');
        const id = full.statusId ?? requestedId;
        const status = full.statuses.length > 1 ? full.statuses.shift()! : full.statuses[0];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            status,
            request_id: id,
            status_url: `${baseUrl()}${path}`,
            response_url: `${baseUrl()}/alibaba/wan-3.0/requests/${id}`,
          }),
        );
        return;
      }

      if (req.method === 'GET' && /^\/alibaba\/wan-3\.0\/(?:image-to-video\/)?requests\/[^/]+$/.test(path)) {
        state.resultGets++;
        if (full.echoAuth401 === 'result') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: `unauthorized: ${req.headers.authorization ?? ''}` }));
          return;
        }
        if (full.resultCode) {
          res.writeHead(full.resultCode);
          res.end();
          return;
        }
        const id = path.split('/requests/')[1];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            video: { url: `${baseUrl()}/media/${id}.mp4`, content_type: 'video/mp4' },
            seed: full.providerSeed,
            duration: full.providerDuration,
          }),
        );
        return;
      }

      if (req.method === 'PUT' && /^\/alibaba\/wan-3\.0\/(?:image-to-video\/)?requests\/[^/]+\/cancel$/.test(path)) {
        state.cancels++;
        if (full.cancel === 'already-completed') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'ALREADY_COMPLETED' }));
          return;
        }
        if (full.cancel === 'not-found') {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'NOT_FOUND' }));
          return;
        }
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'CANCELLATION_REQUESTED' }));
        return;
      }

      if (req.method === 'GET' && path.startsWith('/media/')) {
        state.downloads++;
        if (full.download === 'fail-once' && state.downloads === 1) {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('transient');
          return;
        }
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': media.length });
        res.end(media);
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
  });

  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', () => resolveListen()));
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
  const fixture: Fixture = {
    baseUrl: baseUrl(),
    state,
    config: full,
    close: () => new Promise<void>(resolveClose => server.close(() => resolveClose())),
  };
  try {
    await fn(fixture);
  } finally {
    await fixture.close();
  }
}

test('capabilities describe the transport, not a default model or account', () => {
  assert.equal(falCapabilities.capabilityScope, 'protocol');
  assert.equal('model' in falCapabilities, false, 'the transport must not name a default model');
  assert.equal(
    'endpointId' in falCapabilities,
    false,
    'the route facet belongs to the selected mapping, not the transport',
  );
  assert.equal('durationSeconds' in falCapabilities, false, 'model-owned limits belong to the model definition');
  assert.equal('ratios' in falCapabilities, false, 'model-owned limits belong to the model definition');
  assert.equal('resolutions' in falCapabilities, false, 'model-owned limits belong to the model definition');
  assert.equal(falCapabilities.textOnly, false);
  assert.equal(
    falCapabilities.promptImage.required,
    false,
    'whether an image reference is required is model-owned, not a transport fact',
  );
  assert.deepEqual(falCapabilities.promptImage.formats, ['image/png', 'image/jpeg']);
  assert.equal(falCapabilities.endImage.supported, true);
  assert.equal(falCapabilities.supportsTailFrame, true);
  assert.equal(falCapabilities.safetyChecker, true, 'moderation is always forced on');
  assert.equal(falCapabilities.promptExpansion, false);
  assert.equal(falCapabilities.thinking, false);
  assert.equal(falCapabilities.supportsIdempotencyKeyLookup, false);
  assert.equal(falCapabilities.cancel.supported, true, 'the adapter documents real cancel support');
  assert.match(falCapabilities.cancel.note, /un-bill|cancellation/i);
  assert.equal(falCapabilities.accountAvailability, 'unknown');
  assert.equal(falCapabilities.productionBaseUrl, 'https://queue.fal.run');
  assert.equal(falCapabilities.clientSdkReference.license, 'MIT');
});

test('test-only base must be loopback http; non-local overrides are refused', async () => {
  await withRoot(async root => {
    await assert.rejects(
      () =>
        generateFal(root, source('att_bad_base'), OUTPUT, 'build/a.mp4', {
          testOnly: { baseUrl: 'http://example.com' },
        }),
      /loopback/i,
    );
    await assert.rejects(
      () =>
        generateFal(root, source('att_bad_scheme'), OUTPUT, 'build/a.mp4', {
          testOnly: { baseUrl: 'https://127.0.0.1:8443' },
        }),
      /plain http|loopback/i,
    );
    assert.ok(!existsSync(join(root, '.viscraft', 'jobs', 'fal')));
  });
});

test('an out-of-contract source is rejected before any request', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      const bad = source('att_bad_contract', { parameters: { ...DEFAULT_PARAMETERS, durationSeconds: 31 } });
      await assert.rejects(
        () => generateFal(root, bad, OUTPUT, 'build/b.mp4', { testOnly: { baseUrl: fixture.baseUrl } }),
        /invalid .*parameters/i,
      );
      assert.equal(fixture.state.submits, 0, 'an invalid source must not reach the provider');
    });
  });
});

/** A production-shaped fal Endpoint. These tests stop at the authorization or
 * upload-consent gate, so no request is ever attempted. */
const PRODUCTION_URL = 'https://queue.fal.run';

test('production submit is gated on explicit authorization and a key, before any job or request', async () => {
  await withRoot(async root => {
    await writePng(join(root, 'assets'), 'hero.png', 64);
    const sha256 = await hashFile(join(root, 'assets', 'hero.png'));
    const image = { asset: imageAsset('hero', 'assets/hero.png', sha256), root };
    const previous = process.env.FAL_KEY;
    delete process.env.FAL_KEY;
    try {
      await assert.rejects(
        () =>
          generateFal(root, source('att_noauth'), OUTPUT, 'build/a.mp4', {
            endpoint: { protocol: 'fal-queue' as const, baseUrl: PRODUCTION_URL },
            references: [image],
          }),
        /authorization/i,
      );
      await assert.rejects(
        () =>
          generateFal(root, source('att_nokey'), OUTPUT, 'build/a.mp4', {
            endpoint: { protocol: 'fal-queue' as const, baseUrl: PRODUCTION_URL },
            authorization: { submit: true },
            references: [image],
          }),
        /API key/i,
      );
    } finally {
      if (previous !== undefined) process.env.FAL_KEY = previous;
    }
    assert.ok(!existsSync(join(root, JOB_FILE_REL('att_noauth'))));
    assert.ok(!existsSync(join(root, JOB_FILE_REL('att_nokey'))));
  });
});

test('real transport: first + last frame produce normalized media with a single submit', async () => {
  await withRoot(async root => {
    await withFixture(
      async fixture => {
        await writePng(join(root, 'assets'), 'hero.png', 64);
        await writePng(join(root, 'assets'), 'tail.png', 48);
        const heroSha = await hashFile(join(root, 'assets', 'hero.png'));
        const tailSha = await hashFile(join(root, 'assets', 'tail.png'));
        const options = {
          testOnly: { baseUrl: fixture.baseUrl },
          references: [
            imageAsset('hero', 'assets/hero.png', heroSha),
            imageAsset('tail', 'assets/tail.png', tailSha),
          ].map(asset => ({ asset, root })),
        };

        const src = source('att_ok', { references: framePair('hero', 'tail') });

        const pending = await generateFal(root, src, OUTPUT, 'build/take.mp4', options).then(
          () => null,
          (e: unknown) => e as { name: string; recoverable?: boolean },
        );
        assert.ok(pending, 'first invocation is pending');
        assert.equal(pending.name, 'FalPendingError');
        assert.equal(pending.recoverable, true);

        const result = await generateFal(root, src, OUTPUT, 'build/take.mp4', options);
        assert.equal(result.backend, 'fal-wan-3.0');
        assert.ok(result.generation);
        assert.equal(result.generation.provider, 'fal');
        assert.equal(result.generation.model, 'alibaba/wan-3.0/image-to-video');
        assert.equal(result.generation.taskId, 'req_fixture_1');
        assert.deepEqual(result.generation.references, [
          { asset: 'hero', sha256: heroSha, category: 'image', role: 'first-frame' },
          { asset: 'tail', sha256: tailSha, category: 'image', role: 'last-frame' },
        ]);
        assert.ok(!JSON.stringify(result.generation).includes('http'), 'generation must not embed remote URLs');
        assert.ok(!JSON.stringify(result.generation).includes('key-test'), 'generation must not embed secrets');

        const normalized = await probeMedia(join(root, 'build', 'take.mp4'));
        assert.match(normalized.videoCodec, /h264/i);
        assert.equal(normalized.width, OUTPUT.width);
        assert.equal(normalized.height, OUTPUT.height);
        assert.equal(normalized.frames, 60);

        const original = join(root, PROVIDER_FILE_REL('att_ok'));
        assert.ok(existsSync(original), 'original provider media must be retained');

        const job = await readJob(root, 'att_ok');
        assert.equal(job.state, 'succeeded');
        assert.equal(job.submitted, 1, 'exactly one submit across all resume invocations');
        assert.equal(job.simulated, true, 'a test-only run must be marked simulated');
        assert.equal(job.requestId, 'req_fixture_1');
        assert.equal(job.providerSeed, 42);
        assert.equal(job.providerDurationSeconds, 5);
        assert.deepEqual(job.references, [
          { id: 'hero', sha256: heroSha, type: 'image', role: 'first-frame' },
          { id: 'tail', sha256: tailSha, type: 'image', role: 'last-frame' },
        ]);
        assert.equal(job.originalMediaSha256, await hashFile(original));
        assert.equal(job.artifactSha256, await hashFile(join(root, 'build', 'take.mp4')));

        assert.equal(fixture.state.submits, 1);
        assert.equal(fixture.state.statusGets, 2, 'one status GET per invocation');
        assert.equal(fixture.state.resultGets, 1);
        assert.equal(fixture.state.downloads, 1);

        const submit = fixture.state.requests.find(r => r.method === 'POST');
        assert.ok(submit);
        assert.equal(submit.path, '/alibaba/wan-3.0/image-to-video');
        // The caller's real key is NEVER forwarded to the loopback fixture.
        assert.equal(submit.authorization, 'Key fixture');
        assert.ok(
          !fixture.state.requests.some(r => (r.authorization ?? '').includes('key-test-fal-SECRET')),
          'the caller key must never reach the fixture',
        );
        const body = JSON.parse(submit.body) as Record<string, unknown>;
        assert.equal(body.prompt, src.prompt);
        assert.equal(body.duration, 5);
        assert.equal(body.resolution, '720p');
        assert.equal(body.aspect_ratio, '16:9');
        assert.equal(body.audio, true);
        assert.equal(body.seed, 7);
        assert.equal(body.enable_safety_checker, true);
        assert.equal(body.enable_prompt_expansion, false);
        assert.equal(body.enable_thinking, false);
        for (const [field, sha] of [
          ['start_image_url', heroSha],
          ['end_image_url', tailSha],
        ] as const) {
          const dataUri = String(body[field]);
          assert.match(dataUri, /^data:image\/png;base64,/);
          const decoded = Buffer.from(dataUri.slice(dataUri.indexOf(',') + 1), 'base64');
          assert.equal(
            createHash('sha256').update(decoded).digest('hex'),
            sha,
            'the exact transmitted bytes must hash to the approved Asset',
          );
        }

        // Restoring a succeeded job must not touch the network or resubmit.
        const before = fixture.state;
        const restored = await generateFal(root, src, OUTPUT, 'exports/again.mp4', options);
        assert.ok(existsSync(join(root, 'exports', 'again.mp4')));
        assert.equal(restored.generation?.taskId, 'req_fixture_1');
        assert.equal(before.submits, 1);
        assert.equal(before.statusGets, 2);
        assert.equal(before.resultGets, 1);
        assert.equal(before.downloads, 1);

        const raw = await readFile(join(root, JOB_FILE_REL('att_ok')), 'utf8');
        assert.ok(!raw.includes('key-test-fal-SECRET-do-not-persist'), 'api key must never be persisted');
        assert.ok(!raw.includes('http://'), 'remote URLs must never be persisted');
        assert.ok(!raw.includes('data:image/'), 'no image data URI may be persisted');
        assert.ok(!raw.includes('"prompt"'), 'no raw prompt field may be persisted');
        assert.ok(!raw.includes(src.prompt), 'the raw prompt text must never be persisted');
        assert.equal(typeof job.promptHash, 'string');

        const listed = (await falStatus(root)) as Array<Record<string, unknown>>;
        assert.equal(listed.length, 1);
        assert.equal(listed[0].attempt, 'att_ok');
      },
      { statuses: ['IN_PROGRESS', 'COMPLETED'] },
    );
  });
});

test('a submitted fal task resumes after its reference bytes are removed, without another POST', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      fixture.config.statuses = ['IN_QUEUE', 'COMPLETED'];
      await writePng(join(root, 'assets'), 'hero.png', 64);
      const asset = imageAsset('hero', 'assets/hero.png', await hashFile(join(root, 'assets', 'hero.png')));
      const referencePath = join(root, 'assets', 'hero.png');
      const originalBytes = await readFile(referencePath);
      const src = source('att_missing_ref_resume', { references: firstFrame('hero') });
      const options = { testOnly: { baseUrl: fixture.baseUrl }, references: [{ asset, root }] };
      await assert.rejects(generateFal(root, src, OUTPUT, 'build/resume.mp4', options), /pending/i);
      assert.equal(fixture.state.submits, 1);
      const getsBefore = fixture.state.statusGets;
      await writeFile(referencePath, Buffer.from('changed but still present'));
      await assert.rejects(
        generateFal(root, src, OUTPUT, 'build/changed.mp4', options),
        /bytes do not match its recorded sha256/i,
      );
      assert.equal(fixture.state.statusGets, getsBefore, 'mismatched bytes are refused before queue polling');
      assert.equal(fixture.state.submits, 1, 'mismatched bytes never create another queue task');
      await writeFile(referencePath, originalBytes);
      await rm(referencePath);
      await assert.rejects(
        generateFal(root, { ...src, seed: 8 }, OUTPUT, 'build/resume.mp4', options),
        /different frozen request/i,
      );
      assert.equal(fixture.state.statusGets, getsBefore, 'changed identity is rejected before a task GET');
      await generateFal(root, src, OUTPUT, 'build/resume.mp4', options);
      assert.equal(fixture.state.submits, 1, 'resuming an accepted task never submits again');
      assert.equal(fixture.state.statusGets, getsBefore + 1, 'valid resume only queries the existing task');
      assert.equal((await readJob(root, 'att_missing_ref_resume')).submitted, 1);
      assert.ok(existsSync(join(root, 'build', 'resume.mp4')));
      await writeFile(referencePath, Buffer.from('changed after task success'));
      await assert.rejects(
        generateFal(root, src, OUTPUT, 'build/local-changed.mp4', options),
        /bytes do not match its recorded sha256/i,
      );
      assert.equal(fixture.state.submits, 1, 'a mismatched Asset cannot bypass local success identity checks');
      await rm(referencePath);
      await generateFal(root, src, OUTPUT, 'build/local-restored.mp4', options);
      assert.equal(fixture.state.submits, 1, 'a missing original reference remains locally restorable');
    });
  });
});

test('the same Asset as first and last frame is accepted (no false duplicate rejection)', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      await writePng(join(root, 'assets'), 'hero.png', 64);
      const sha256 = await hashFile(join(root, 'assets', 'hero.png'));
      const options = {
        testOnly: { baseUrl: fixture.baseUrl },
        references: [{ asset: imageAsset('hero', 'assets/hero.png', sha256), root }],
      };
      const src = source('att_same', { references: framePair('hero', 'hero') });
      const result = await generateFal(root, src, OUTPUT, 'build/same.mp4', options);
      assert.deepEqual(result.generation?.references, [
        { asset: 'hero', sha256, category: 'image', role: 'first-frame' },
        { asset: 'hero', sha256, category: 'image', role: 'last-frame' },
      ]);
      const submit = fixture.state.requests.find(r => r.method === 'POST');
      assert.ok(submit);
      const body = JSON.parse(submit.body) as Record<string, unknown>;
      assert.equal(body.start_image_url, body.end_image_url, 'same first/last Asset must transmit the same data URI');
      assert.equal(fixture.state.submits, 1);
    });
  });
});

test('conflicting duplicate options.references entries for one Asset are rejected before any request', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      await writePng(join(root, 'assets'), 'hero.png', 64);
      await writePng(join(root, 'assets'), 'hero-alt.png', 96);
      const shaA = await hashFile(join(root, 'assets', 'hero.png'));
      const shaB = await hashFile(join(root, 'assets', 'hero-alt.png'));
      assert.notEqual(shaA, shaB);
      const options = {
        testOnly: { baseUrl: fixture.baseUrl },
        references: [
          { asset: imageAsset('hero', 'assets/hero.png', shaA), root },
          { asset: imageAsset('hero', 'assets/hero-alt.png', shaB), root },
        ],
      };
      await assert.rejects(
        () => generateFal(root, source('att_dupconf'), OUTPUT, 'build/d.mp4', options),
        /conflicting duplicate/i,
      );
      assert.equal(fixture.state.submits, 0);
      assert.ok(!existsSync(join(root, JOB_FILE_REL('att_dupconf'))));
    });
  });
});

test('test-only transport never reads or forwards the real FAL_KEY', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      await writePng(join(root, 'assets'), 'hero.png', 64);
      const sha256 = await hashFile(join(root, 'assets', 'hero.png'));
      const image = { asset: imageAsset('hero', 'assets/hero.png', sha256), root };
      const previous = process.env.FAL_KEY;
      process.env.FAL_KEY = 'key-env-REAL-must-not-leak';
      try {
        await generateFal(root, source('att_key'), OUTPUT, 'build/k.mp4', {
          testOnly: { baseUrl: fixture.baseUrl },
          references: [image],
        });
      } finally {
        if (previous === undefined) delete process.env.FAL_KEY;
        else process.env.FAL_KEY = previous;
      }
      for (const request of fixture.state.requests)
        assert.ok(
          !(request.authorization ?? '').includes('key-env-REAL'),
          'the environment key must never reach the fixture',
        );
      const raw = await readFile(join(root, JOB_FILE_REL('att_key')), 'utf8');
      assert.ok(!raw.includes('key-env-REAL'), 'the environment key must never be persisted');
    });
  });
});

test('a hostile provider echoing the Authorization header cannot leak a key into an error or any persisted file', async () => {
  const KEY = 'key-test-fal-SECRET-do-not-persist';
  const previous = process.env.FAL_KEY;
  process.env.FAL_KEY = KEY;
  try {
    for (const where of ['submit', 'status', 'result'] as const) {
      await withRoot(async root => {
        await withFixture(
          async fixture => {
            await writePng(join(root, 'assets'), 'hero.png', 64);
            const sha256 = await hashFile(join(root, 'assets', 'hero.png'));
            const attempt = `att_leak_${where}`;
            const options = {
              testOnly: { baseUrl: fixture.baseUrl },
              references: [{ asset: imageAsset('hero', 'assets/hero.png', sha256), root }],
            };

            const error = await generateFal(root, source(attempt), OUTPUT, 'build/leak.mp4', options).then(
              () => null,
              (e: unknown) => e as Error,
            );
            assert.ok(error, `the hostile ${where} response must surface as a thrown error`);
            assert.ok(!error.message.includes(KEY), `the caller key must not leak into the ${where} error message`);

            // The fixture really did receive an Authorization header and echoed it back.
            const received = [
              ...new Set(fixture.state.requests.map(r => r.authorization).filter((a): a is string => Boolean(a))),
            ];
            assert.ok(received.length > 0, `the ${where} run must carry an Authorization header`);
            for (const value of received) {
              assert.equal(value, 'Key fixture', 'test mode sends only the fixed non-secret credential');
              assert.ok(
                !error.message.includes(value),
                `the echoed Authorization value must not appear in the ${where} error message`,
              );
            }

            // Nothing under the project root (job records, attempt locks, results) may contain the secret.
            const persisted = await readAllText(root);
            assert.ok(!persisted.includes(KEY), `the key must not be persisted anywhere on the ${where} path`);
            for (const value of received) {
              assert.ok(!persisted.includes(value), `the transmitted credential must not be persisted (${where})`);
            }

            // The provider job-store JSON specifically must be clean (src/backends/providers/job-store.ts).
            const jobRaw = await readFile(join(root, JOB_FILE_REL(attempt)), 'utf8');
            assert.ok(!jobRaw.includes(KEY), 'the key must never appear in the provider job-store record');
            for (const value of received) {
              assert.ok(
                !jobRaw.includes(value),
                `the transmitted Authorization value must not appear in the provider job-store record (${where})`,
              );
            }
          },
          { echoAuth401: where },
        );
      });
    }
  } finally {
    if (previous === undefined) delete process.env.FAL_KEY;
    else process.env.FAL_KEY = previous;
  }
});

test('an ambiguous submit never resubmits and blocks further attempts', async () => {
  for (const submit of ['network', 'http500', 'malformed'] as const) {
    await withRoot(async root => {
      await withFixture(
        async fixture => {
          await writePng(join(root, 'assets'), 'hero.png', 64);
          const sha256 = await hashFile(join(root, 'assets', 'hero.png'));
          const options = {
            testOnly: { baseUrl: fixture.baseUrl },
            references: [{ asset: imageAsset('hero', 'assets/hero.png', sha256), root }],
          };
          await assert.rejects(
            () => generateFal(root, source(`att_unknown_${submit}`), OUTPUT, 'build/u.mp4', options),
            /unknown/i,
          );
          const first = await readJob(root, `att_unknown_${submit}`);
          assert.equal(first.state, 'submit-unknown');
          assert.equal(first.submitted, 1);

          await assert.rejects(
            () => generateFal(root, source(`att_unknown_${submit}`), OUTPUT, 'build/u.mp4', options),
            /unknown|not resubmit/i,
          );
          assert.equal(fixture.state.submits, 1, 'an ambiguous submit must never be retried');
          assert.equal((await readJob(root, `att_unknown_${submit}`)).submitted, 1);
        },
        { submit },
      );
    });
  }
});

test('an unusable queue URL in the submit response is treated as an ambiguous submit, never used', async () => {
  await withRoot(async root => {
    await withFixture(
      async fixture => {
        await writePng(join(root, 'assets'), 'hero.png', 64);
        const sha256 = await hashFile(join(root, 'assets', 'hero.png'));
        const options = {
          testOnly: { baseUrl: fixture.baseUrl },
          references: [{ asset: imageAsset('hero', 'assets/hero.png', sha256), root }],
        };
        await assert.rejects(
          () => generateFal(root, source('att_bad_url'), OUTPUT, 'build/u.mp4', options),
          /unknown/i,
        );
        const job = await readJob(root, 'att_bad_url');
        assert.equal(job.state, 'submit-unknown');
        assert.equal(job.statusPath, undefined);
        assert.equal(fixture.state.statusGets, 0, 'an unvalidated queue URL must never be followed');
      },
      { statusUrl: (_base, id) => `https://evil.example/alibaba/wan-3.0/image-to-video/requests/${id}/status` },
    );
  });
});

test('a status_url that is not the status path is rejected (role binding), never polled', async () => {
  await withRoot(async root => {
    await withFixture(
      async fixture => {
        await writePng(join(root, 'assets'), 'hero.png', 64);
        const sha256 = await hashFile(join(root, 'assets', 'hero.png'));
        const options = {
          testOnly: { baseUrl: fixture.baseUrl },
          references: [{ asset: imageAsset('hero', 'assets/hero.png', sha256), root }],
        };
        await assert.rejects(() => generateFal(root, source('att_role'), OUTPUT, 'build/r.mp4', options), /unknown/i);
        const job = await readJob(root, 'att_role');
        assert.equal(job.state, 'submit-unknown');
        assert.equal(job.statusPath, undefined);
        assert.equal(fixture.state.statusGets, 0, 'a result path must never be used as a status URL');
      },
      // Correct request path and id, but missing the required `/status` suffix.
      { statusUrl: (base, id) => `${base}/alibaba/wan-3.0/requests/${id}` },
    );
  });
});

test('a queue URL carrying a secret query is rejected and never persisted', async () => {
  await withRoot(async root => {
    await withFixture(
      async fixture => {
        await writePng(join(root, 'assets'), 'hero.png', 64);
        const sha256 = await hashFile(join(root, 'assets', 'hero.png'));
        const options = {
          testOnly: { baseUrl: fixture.baseUrl },
          references: [{ asset: imageAsset('hero', 'assets/hero.png', sha256), root }],
        };
        await assert.rejects(() => generateFal(root, source('att_query'), OUTPUT, 'build/q.mp4', options), /unknown/i);
        const raw = await readFile(join(root, JOB_FILE_REL('att_query')), 'utf8');
        assert.ok(!raw.includes('SECRET-signature-must-not-persist'), 'a signed query must never be persisted');
        assert.equal((await readJob(root, 'att_query')).state, 'submit-unknown');
        assert.equal(fixture.state.statusGets, 0);
      },
      {
        statusUrl: (base, id) =>
          `${base}/alibaba/wan-3.0/requests/${id}/status?token=SECRET-signature-must-not-persist`,
      },
    );
  });
});

test('a mismatched status request id is refused', async () => {
  await withRoot(async root => {
    await withFixture(
      async fixture => {
        await writePng(join(root, 'assets'), 'hero.png', 64);
        const sha256 = await hashFile(join(root, 'assets', 'hero.png'));
        const options = {
          testOnly: { baseUrl: fixture.baseUrl },
          references: [{ asset: imageAsset('hero', 'assets/hero.png', sha256), root }],
        };
        await assert.rejects(
          () => generateFal(root, source('att_mismatch'), OUTPUT, 'build/m.mp4', options),
          /does not match/i,
        );
        assert.equal((await readJob(root, 'att_mismatch')).submitted, 1);
      },
      { requestId: 'req_real', statusId: 'req_other', statuses: ['COMPLETED'] },
    );
  });
});

test('query-side credential failures preserve the known job for recovery without another POST', async () => {
  for (const statusCode of [401, 403]) {
    await withRoot(async root => {
      await withFixture(
        async fixture => {
          await writePng(join(root, 'assets'), 'hero.png', 64);
          const sha = await hashFile(join(root, 'assets', 'hero.png'));
          const options = {
            testOnly: { baseUrl: fixture.baseUrl },
            references: [{ asset: imageAsset('hero', 'assets/hero.png', sha), root }],
          };
          await assert.rejects(generateFal(root, source('auth-query'), OUTPUT, 'build/out.mp4', options), /pending/i);
          fixture.config.statusCode = statusCode;
          await assert.rejects(
            generateFal(root, source('auth-query'), OUTPUT, 'build/out.mp4', options),
            /credentials/i,
          );
          assert.equal((await readJob(root, 'auth-query')).state, 'submitted');
          fixture.config.statusCode = undefined;
          fixture.config.resultCode = statusCode;
          await assert.rejects(
            generateFal(root, source('auth-query'), OUTPUT, 'build/out.mp4', options),
            /credentials/i,
          );
          assert.equal((await readJob(root, 'auth-query')).state, 'remote-completed');
          fixture.config.resultCode = undefined;
          await generateFal(root, source('auth-query'), OUTPUT, 'build/out.mp4', options);
          assert.equal(fixture.state.submits, 1);
        },
        { statuses: ['IN_PROGRESS', 'COMPLETED'] },
      );
    });
  }
});

test('a failed download resumes without resubmitting', async () => {
  await withRoot(async root => {
    await withFixture(
      async fixture => {
        await writePng(join(root, 'assets'), 'hero.png', 64);
        const sha256 = await hashFile(join(root, 'assets', 'hero.png'));
        const options = {
          testOnly: { baseUrl: fixture.baseUrl },
          references: [{ asset: imageAsset('hero', 'assets/hero.png', sha256), root }],
        };
        await assert.rejects(
          () => generateFal(root, source('att_dl'), OUTPUT, 'build/dl.mp4', options),
          /download failed/i,
        );
        const first = await readJob(root, 'att_dl');
        assert.equal(first.state, 'download-failed');
        assert.equal(first.submitted, 1);
        assert.ok(!existsSync(join(root, 'build', 'dl.mp4')));

        await generateFal(root, source('att_dl'), OUTPUT, 'build/dl.mp4', options);
        const second = await readJob(root, 'att_dl');
        assert.equal(second.state, 'succeeded');
        assert.equal(second.submitted, 1, 'resuming the download must not submit again');
        assert.equal(fixture.state.submits, 1);
        assert.equal(fixture.state.downloads, 2);
        assert.equal((await probeMedia(join(root, 'build', 'dl.mp4'))).frames, 60);
      },
      { download: 'fail-once' },
    );
  });
});

test('reusing an attempt id with changed parameters is rejected before any request', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      await writePng(join(root, 'assets'), 'hero.png', 64);
      const sha256 = await hashFile(join(root, 'assets', 'hero.png'));
      const options = {
        testOnly: { baseUrl: fixture.baseUrl },
        references: [{ asset: imageAsset('hero', 'assets/hero.png', sha256), root }],
      };
      await generateFal(root, source('att_conflict'), OUTPUT, 'build/c.mp4', options);
      const before = fixture.state.submits;
      await assert.rejects(
        () =>
          generateFal(
            root,
            source('att_conflict', { parameters: { ...DEFAULT_PARAMETERS, durationSeconds: 8 } }),
            OUTPUT,
            'build/c2.mp4',
            options,
          ),
        /different frozen request|new attempt/i,
      );
      assert.equal(fixture.state.submits, before, 'a changed request must be rejected before contacting the provider');
      const job = await readJob(root, 'att_conflict');
      assert.equal((job.parameters as Record<string, unknown>).durationSeconds, 5);
      assert.equal(job.submitted, 1);
    });
  });
});

test('reusing an attempt with a changed end image is rejected before any new POST', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      await writePng(join(root, 'assets'), 'hero.png', 64);
      await writePng(join(root, 'assets'), 'tail.png', 48);
      const heroSha = await hashFile(join(root, 'assets', 'hero.png'));
      const tailSha = await hashFile(join(root, 'assets', 'tail.png'));
      const options = {
        testOnly: { baseUrl: fixture.baseUrl },
        references: [
          { asset: imageAsset('hero', 'assets/hero.png', heroSha), root },
          { asset: imageAsset('tail', 'assets/tail.png', tailSha), root },
        ],
      };
      await generateFal(
        root,
        source('att_img_change', { references: framePair('hero', 'tail') }),
        OUTPUT,
        'build/c.mp4',
        options,
      );
      assert.equal(fixture.state.submits, 1);

      await assert.rejects(
        () =>
          generateFal(root, source('att_img_change', { references: firstFrame('hero') }), OUTPUT, 'build/c2.mp4', {
            ...options,
          }),
        /different frozen request|new attempt/i,
      );
      assert.equal(fixture.state.submits, 1, 'a changed end image must be rejected before any new POST');
    });
  });
});

test('production image transmission needs explicit per-Asset consent; a redistributable license is never consent', async () => {
  await withRoot(async root => {
    await writePng(join(root, 'assets'), 'hero.png', 64);
    const sha256 = await hashFile(join(root, 'assets', 'hero.png'));
    const image = { asset: imageAsset('hero', 'assets/hero.png', sha256, true), root };
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    const previousKey = process.env.FAL_KEY;
    process.env.FAL_KEY = 'key-dummy-not-real';
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error('network must not be reached without upload consent');
    }) as typeof fetch;
    try {
      await assert.rejects(
        () =>
          generateFal(root, source('att_upload_auth'), OUTPUT, 'build/a.mp4', {
            endpoint: { protocol: 'fal-queue' as const, baseUrl: PRODUCTION_URL },
            authorization: { submit: true },
            references: [image],
          }),
        /upload|authorization/i,
      );
      assert.equal(fetchCalls, 0, 'no network call may be attempted without upload consent');
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.FAL_KEY;
      else process.env.FAL_KEY = previousKey;
    }
    assert.ok(
      !existsSync(join(root, JOB_FILE_REL('att_upload_auth'))),
      'no job record is written without upload consent',
    );
  });
});

test('a promptImage source with no matching approved Asset is rejected before any work', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      await assert.rejects(
        () =>
          generateFal(root, source('att_img_missing'), OUTPUT, 'build/m.mp4', {
            testOnly: { baseUrl: fixture.baseUrl },
          }),
        /no matching options\.images|image Asset/i,
      );
      assert.equal(fixture.state.submits, 0);
      assert.ok(!existsSync(join(root, JOB_FILE_REL('att_img_missing'))));
    });
  });
});

test('a non-PNG/JPEG frame image (SVG) is refused rather than converted', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>';
      await mkdir(join(root, 'assets'), { recursive: true });
      await writeFile(join(root, 'assets', 'hero.svg'), svg);
      const sha256 = await hashFile(join(root, 'assets', 'hero.svg'));
      await assert.rejects(
        () =>
          generateFal(root, source('att_svg'), OUTPUT, 'build/s.mp4', {
            testOnly: { baseUrl: fixture.baseUrl },
            references: [{ asset: imageAsset('hero', 'assets/hero.svg', sha256), root }],
          }),
        /PNG or JPEG|signature/i,
      );
      assert.equal(fixture.state.submits, 0, 'an unconvertible image must never reach the provider');
      assert.ok(!existsSync(join(root, JOB_FILE_REL('att_svg'))));
    });
  });
});

test('destinations that escape the project root are rejected', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      await writePng(join(root, 'assets'), 'hero.png', 64);
      const sha256 = await hashFile(join(root, 'assets', 'hero.png'));
      const options = {
        testOnly: { baseUrl: fixture.baseUrl },
        references: [{ asset: imageAsset('hero', 'assets/hero.png', sha256), root }],
      };
      await assert.rejects(
        () => generateFal(root, source('att_esc'), OUTPUT, '../escape.mp4', options),
        /escapes|safe project-relative/i,
      );
      assert.ok(!existsSync(join(root, '..', 'escape.mp4')));
      assert.equal(fixture.state.submits, 0);
    });
  });
});

test('a held per-attempt lock refuses a concurrent generation of the same attempt', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      await writePng(join(root, 'assets'), 'hero.png', 64);
      const sha256 = await hashFile(join(root, 'assets', 'hero.png'));
      const options = {
        testOnly: { baseUrl: fixture.baseUrl },
        references: [{ asset: imageAsset('hero', 'assets/hero.png', sha256), root }],
      };
      const lockDir = join(root, '.viscraft', 'jobs', 'fal');
      await mkdir(lockDir, { recursive: true });
      await writeFile(join(lockDir, 's_att_lock.att_lock.lock'), 'held by another run\n');

      await assert.rejects(
        () => generateFal(root, source('att_lock'), OUTPUT, 'build/l.mp4', options),
        /already being generated|concurrently/i,
      );
      assert.equal(fixture.state.submits, 0, 'a locked attempt must not contact the provider');
      assert.ok(!existsSync(join(root, JOB_FILE_REL('att_lock'))), 'no job record is written while locked');
    });
  });
});

test('cancelFal cancels a submitted job with exactly one PUT and never resubmits or polls', async () => {
  await withRoot(async root => {
    await withFixture(
      async fixture => {
        await writePng(join(root, 'assets'), 'hero.png', 64);
        const sha256 = await hashFile(join(root, 'assets', 'hero.png'));
        const options = {
          testOnly: { baseUrl: fixture.baseUrl },
          references: [{ asset: imageAsset('hero', 'assets/hero.png', sha256), root }],
        };

        // First run submits and stays pending, so the job is persisted as `submitted`.
        await assert.rejects(
          () => generateFal(root, source('att_cancel'), OUTPUT, 'build/c.mp4', options),
          /not complete|pending/i,
        );
        const pending = await readJob(root, 'att_cancel');
        assert.equal(pending.state, 'submitted');
        assert.equal(pending.requestId, 'req_fixture_1');
        assert.equal(fixture.state.submits, 1);
        assert.equal(fixture.state.statusGets, 1);

        const result = await cancelFal(root, 'att_cancel', { testOnly: { baseUrl: fixture.baseUrl } });
        assert.deepEqual(result, { attempt: 'att_cancel', requestId: 'req_fixture_1', state: 'cancelled' });

        const job = await readJob(root, 'att_cancel');
        assert.equal(job.state, 'cancelled');
        assert.equal(job.requestId, 'req_fixture_1');

        const cancels = fixture.state.requests.filter(r => r.method === 'PUT');
        assert.equal(cancels.length, 1, 'exactly one cancel request');
        assert.equal(fixture.state.cancels, 1);
        assert.equal(cancels[0].path, '/alibaba/wan-3.0/requests/req_fixture_1/cancel');
        assert.equal(cancels[0].authorization, 'Key fixture', 'test mode sends only the fixed non-secret credential');
        assert.equal(fixture.state.submits, 1, 'cancel must never resubmit');
        assert.equal(fixture.state.statusGets, 1, 'cancel must not poll status');
      },
      { statuses: ['IN_PROGRESS'] },
    );
  });
});

test('cancelFal refuses an unknown attempt without any HTTP call', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      await assert.rejects(
        () => cancelFal(root, 'att_missing', { testOnly: { baseUrl: fixture.baseUrl } }),
        /no job record|nothing to cancel/i,
      );
      assert.equal(fixture.state.requests.length, 0, 'an unknown attempt must not contact the provider');
    });
  });
});

test('cancelFal surfaces ALREADY_COMPLETED and NOT_FOUND as loud errors, never a fake success', async () => {
  for (const cancel of ['already-completed', 'not-found'] as const) {
    await withRoot(async root => {
      await withFixture(
        async fixture => {
          await writePng(join(root, 'assets'), 'hero.png', 64);
          const sha256 = await hashFile(join(root, 'assets', 'hero.png'));
          const options = {
            testOnly: { baseUrl: fixture.baseUrl },
            references: [{ asset: imageAsset('hero', 'assets/hero.png', sha256), root }],
          };
          const attempt = `att_cancel_${cancel}`;

          await assert.rejects(
            () => generateFal(root, source(attempt), OUTPUT, 'build/c.mp4', options),
            /not complete|pending/i,
          );
          assert.equal((await readJob(root, attempt)).state, 'submitted');

          fixture.config.cancel = cancel;
          await assert.rejects(
            () => cancelFal(root, attempt, { testOnly: { baseUrl: fixture.baseUrl } }),
            cancel === 'already-completed' ? /already completed/i : /not found/i,
          );

          const job = await readJob(root, attempt);
          assert.equal(job.state, 'submitted', 'a refused cancel must not mark the job cancelled');
          assert.equal(fixture.state.cancels, 1, 'exactly one cancel attempt, no retry');
          assert.equal(fixture.state.submits, 1, 'cancel must never resubmit');
        },
        { statuses: ['IN_PROGRESS'] },
      );
    });
  }
});

test('the queue submit/status/result paths derive from the mapping route facet, not a hardcoded literal', async () => {
  await withRoot(async root => {
    // With no returned status_url/response_url the adapter must use the paths
    // derived from `wan30FalMapping.endpointId`.
    await withFixture(
      async fixture => {
        await writePng(join(root, 'assets'), 'hero.png', 64);
        const sha256 = await hashFile(join(root, 'assets', 'hero.png'));
        const options = {
          testOnly: { baseUrl: fixture.baseUrl },
          references: [{ asset: imageAsset('hero', 'assets/hero.png', sha256), root }],
        };
        await generateFal(root, source('att_route'), OUTPUT, 'build/route.mp4', options);

        const endpointId = wan30FalMapping.endpointId;
        assert.equal(endpointId, 'alibaba/wan-3.0/image-to-video');
        const paths = fixture.state.requests.map(request => request.path);
        assert.ok(paths.includes(`/${endpointId}`), 'the submit path is the mapping endpoint id');
        assert.ok(
          paths.includes(`/${endpointId}/requests/req_fixture_1/status`),
          'the status path derives from the mapping route facet',
        );
        assert.ok(
          paths.includes(`/${endpointId}/requests/req_fixture_1`),
          'the result path derives from the mapping route facet',
        );
        assert.equal(fixture.state.submits, 1);
        // The persisted route facet is the mapping's endpoint id.
        assert.equal((await readJob(root, 'att_route')).endpointId, endpointId);
      },
      { omitQueueUrls: true },
    );
  });
});
