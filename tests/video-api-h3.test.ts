/**
 * MiniMax-H3 over the shared vllm-omni-video client — contract tests — real local transport, real media.
 *
 * These tests drive the adapter through a real Node HTTP fixture on loopback
 * (the adapter's documented transport) that speaks the vLLM-Omni async video
 * protocol, and assert on the persisted `.viscraft/jobs/video-api/<attempt>.json`
 * records. A successful case downloads real provider bytes, then normalizes
 * them with the shared FFmpeg media plane, so a passing run means an actual
 * probeable H.264 file was produced — not a type-checked stub. No GPU, no paid
 * service, no external network.
 *
 * High-risk invariants covered by the adapter:
 *  - malformed and insecure endpoint configurations are refused before any work;
 *    fixture requests without a configured token do not carry credentials;
 *  - real submission is gated on explicit authorization + per-Asset transmission
 *    consent, before any job is created or any request is sent;
 *  - an ambiguous submit is never auto-resubmitted (state stays `submit-unknown`);
 *  - a failed download resumes without regenerating (submit count stays 1) and
 *    without re-querying (deterministic content path);
 *  - the request hash binds mode/base/source/image/output, so a changed request is
 *    rejected before contacting the service;
 *  - the requested frame count is sent verbatim while the model's `17n+5`
 *    alignment (97 -> 107) is a separate model diagnostic; actual media is authoritative.
 */

import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Asset, Reference, ProviderSource, OutputSettings } from '../src/core/schema.js';
import {
  generateVideoApi,
  videoApiStatus,
  VideoApiPendingError,
} from '../src/backends/providers/services/video-tasks.js';
import {
  minimaxH3AlignedFrames,
  minimaxH3Ref2vaExtension,
  minimaxH3Fl2vaExtension,
  minimaxH3Model,
} from '../src/backends/providers/models/minimax-h3.js';
import { attemptStem } from '../src/backends/providers/job-store.js';
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
// The job record, per-attempt lock and retained provider media are keyed by the
// Source-scoped stem (`sourceId.attempt`), so two Sources may reuse an attempt id.
const stem = (attempt: string) => attemptStem(`s_${attempt}`, attempt);
const PROVIDER_FILE_REL = (attempt: string) => `.viscraft/provider-media/video-api-${stem(attempt)}.mp4`;
const JOB_FILE_REL = (attempt: string) => `.viscraft/jobs/video-api/${stem(attempt)}.json`;

type RemoteStatus = 'queued' | 'in_progress' | 'completed' | 'failed';

function source(attempt: string, overrides: Partial<ProviderSource> = {}): ProviderSource {
  return {
    id: `s_${attempt}`,
    kind: 'provider',
    output: 'picture',
    endpoint: 'default',
    fps: 24,
    model: 'minimax-h3-base-ref2va',
    prompt: 'a red rally car drifting through a snowy mountain pass at dawn',
    mode: 'reference',
    references: [{ asset: 'hero', category: 'image', role: 'identity' }],
    requestedFrames: 97,
    size: '1344:768',
    steps: 30,
    flowShift: 12,
    seed: 7,
    attempt,
    ...overrides,
  };
}

async function readJob(root: string, attempt: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, JOB_FILE_REL(attempt)), 'utf8')) as Record<string, unknown>;
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-video-generation-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// --- A real, probeable media fixture (tiny 16:9 H.264), built once. ---
let cachedMedia: Promise<Buffer> | undefined;
function providerMedia(): Promise<Buffer> {
  cachedMedia ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'viscraft-video-generation-media-'));
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

/** A real encoded PNG (via the installed FFmpeg) used as an approved hero image. */
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

function imageAsset(id: string, path: string, sha256: string, simulated = false): Asset {
  return {
    id,
    revision: 1,
    path,
    sha256,
    type: 'image',
    rights: { origin: 'original FFmpeg fixture', license: 'CC0-1.0', redistributable: true },
    simulated,
  };
}

/** A single approved hero Asset + its frozen root, ready for options.image. */
async function hero(root: string, id = 'hero', size = 64, simulated = false): Promise<{ asset: Asset; root: string }> {
  await writePng(join(root, 'assets'), `${id}.png`, size);
  const sha256 = await hashFile(join(root, 'assets', `${id}.png`));
  return { asset: imageAsset(id, `assets/${id}.png`, sha256, simulated), root };
}

/** A real 1 s H.264 MP4 (below the H3 reference-video 2 s floor) as an Asset. */
async function shortVideo(root: string, id = 'clip'): Promise<{ asset: Asset; root: string }> {
  const file = join(root, `${id}.mp4`);
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
    'testsrc2=size=640x360:rate=24:duration=1',
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    file,
  ]);
  const sha256 = await hashFile(file);
  return {
    asset: {
      id,
      revision: 1,
      path: `${id}.mp4`,
      sha256,
      type: 'video',
      rights: { origin: 'original FFmpeg fixture', license: 'CC0-1.0', redistributable: true },
      simulated: false,
    },
    root,
  };
}

/** A real H.264 MP4 of the given duration (default inside the 2..15 s window). */
async function referenceVideo(root: string, id = 'clip', seconds = 2): Promise<{ asset: Asset; root: string }> {
  const file = join(root, `${id}.mp4`);
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
    `testsrc2=size=640x360:rate=24:duration=${seconds}`,
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    file,
  ]);
  const sha256 = await hashFile(file);
  return {
    asset: {
      id,
      revision: 1,
      path: `${id}.mp4`,
      sha256,
      type: 'video',
      rights: { origin: 'original FFmpeg fixture', license: 'CC0-1.0', redistributable: true },
      simulated: false,
    },
    root,
  };
}

/** A real WAV of the given duration as an audio reference Asset. */
async function audioWav(root: string, id = 'track', seconds = 2): Promise<{ asset: Asset; root: string }> {
  const file = join(root, `${id}.wav`);
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
    `sine=frequency=440:duration=${seconds}`,
    '-c:a',
    'pcm_s16le',
    file,
  ]);
  const sha256 = await hashFile(file);
  return {
    asset: {
      id,
      revision: 1,
      path: `${id}.wav`,
      sha256,
      type: 'audio',
      rights: { origin: 'original FFmpeg fixture', license: 'CC0-1.0', redistributable: true },
      simulated: false,
    },
    root,
  };
}

// --- Minimal multipart/form-data parser for the fixture (test-only). ---
interface Multipart {
  fields: Record<string, string>;
  files: Array<{ name: string; filename?: string; type?: string; data: Buffer }>;
}

function parseMultipart(body: Buffer, contentType: string | undefined): Multipart {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  const result: Multipart = { fields: {}, files: [] };
  if (!match) return result;
  const boundary = Buffer.from(`--${(match[1] ?? match[2]).trim()}`, 'latin1');
  let index = body.indexOf(boundary);
  while (index !== -1) {
    const afterBoundary = index + boundary.length;
    if (body.subarray(afterBoundary, afterBoundary + 2).toString('latin1') === '--') break;
    const headerStart = afterBoundary + 2; // skip CRLF
    const nextBoundary = body.indexOf(boundary, headerStart);
    if (nextBoundary === -1) break;
    const part = body.subarray(headerStart, nextBoundary);
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

interface FixtureState {
  submits: number;
  gets: number;
  downloads: number;
  requests: { method: string; path: string; contentType?: string; authorization?: string; multipart?: Multipart }[];
}

interface FixtureConfig {
  jobId: string;
  /** Optional id the status endpoint echoes back (to exercise the id-match guard). */
  statusId?: string;
  statuses: RemoteStatus[];
  submit: 'ok' | 'http500' | 'http400' | 'malformed' | 'network';
  download: 'ok' | 'fail-once';
  inferenceSeconds: number;
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
  const state: FixtureState = { submits: 0, gets: 0, downloads: 0, requests: [] };
  const full: FixtureConfig = {
    jobId: 'video_gen_fixture_1',
    statuses: ['completed'],
    submit: 'ok',
    download: 'ok',
    inferenceSeconds: 3.5,
    ...config,
  };
  let port = 0;
  const baseUrl = () => `http://127.0.0.1:${port}`;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const contentType = req.headers['content-type'];
      const record: FixtureState['requests'][number] = {
        method: req.method ?? '',
        path,
        contentType,
        authorization: req.headers.authorization,
      };
      if ((contentType ?? '').startsWith('multipart/form-data')) record.multipart = parseMultipart(raw, contentType);
      state.requests.push(record);

      const videosPath = `/v1/videos/${full.jobId}`;

      if (req.method === 'POST' && path === '/v1/videos') {
        state.submits++;
        if (full.submit === 'network') {
          req.socket?.destroy();
          return;
        }
        if (full.submit === 'http500') {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal' }));
          return;
        }
        if (full.submit === 'http400') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad request' }));
          return;
        }
        if (full.submit === 'malformed') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('this is not json {');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: full.jobId, status: 'queued', model: 'MiniMax-H3' }));
        return;
      }

      if (req.method === 'GET' && path === `${videosPath}/content`) {
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

      if (req.method === 'GET' && path === videosPath) {
        state.gets++;
        const id = full.statusId ?? full.jobId;
        const status = full.statuses.length > 1 ? full.statuses.shift()! : full.statuses[0];
        if (status === 'failed') {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id, status, error: { code: 500, message: 'engine died' } }));
          return;
        }
        const payload: Record<string, unknown> = { id, status, model: 'MiniMax-H3', error: null };
        if (status === 'completed') payload.inference_time_s = full.inferenceSeconds;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
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

test('frame alignment mirrors the MiniMax H3 17n+5 model contract (97 -> 107) and rejects unsafe input', () => {
  assert.equal(minimaxH3AlignedFrames(97), 107);
  assert.equal(minimaxH3AlignedFrames(96), 107);
  assert.equal(minimaxH3AlignedFrames(107), 107);
  assert.equal(minimaxH3AlignedFrames(360), 362);
  assert.equal(minimaxH3AlignedFrames(360) % 17, 5);
  assert.equal(minimaxH3AlignedFrames(1), 5);
  // The upper safe bound stays a safe integer and lands on the boundary.
  const upper = Number.MAX_SAFE_INTEGER - 17;
  assert.equal(Number.isSafeInteger(minimaxH3AlignedFrames(upper)), true);
  assert.equal(minimaxH3AlignedFrames(upper) % 17, 5);
  // Unsafe magnitudes must throw rather than stagnate in an increment loop.
  for (const invalid of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_VALUE,
    2 ** 53,
  ]) {
    assert.throws(() => minimaxH3AlignedFrames(invalid), RangeError, `expected ${invalid} to be rejected`);
  }
});

test('the H3 reference SET is validated: Ref2VA counts plus confirmed per-file duration windows', () => {
  const vid = (asset: string): Reference => ({ asset, category: 'video', role: 'motion' });
  const img = (asset: string): Reference => ({ asset, category: 'image', role: 'identity' });
  const aud = (asset: string): Reference => ({ asset, category: 'audio', role: 'audio' });
  const fact = (reference: Reference, duration: number | undefined) => ({ reference, bytes: 1, duration });
  const set = (references: Reference[]) => source('set_probe', { references });

  const validate = (refs: Reference[], facts: ReturnType<typeof fact>[]) =>
    minimaxH3Model.validateReferenceSet!(set(refs), facts);

  // Ref2VA set-count rules apply on the set path too.
  assert.throws(
    () =>
      validate(
        Array.from({ length: 10 }, (_u, i) => img(`i${i}`)),
        [],
      ),
    /at most 9 image references/,
  );
  assert.doesNotThrow(
    () => validate([aud('track')], [fact(aud('track'), 2)]),
    'audio-only is a service-specific constraint',
  );
  // Per-file AUDIO window 2..15 s (the set is an audio reference's only gate).
  assert.throws(
    () => validate([img('hero'), aud('track')], [fact(aud('track'), 1)]),
    /reference audio duration must be 2\.\.15 seconds \(got 1\)/,
  );
  assert.throws(
    () => validate([img('hero'), aud('track')], [fact(aud('track'), 16)]),
    /reference audio duration must be 2\.\.15 seconds \(got 16\)/,
  );
  // Aggregate totals are OFFICIAL and set-level: > 15 s of reference video, or
  // > 15 s of reference audio, is refused even when each file is in-window.
  assert.throws(
    () => validate([img('hero'), vid('a'), vid('b')], [fact(vid('a'), 8), fact(vid('b'), 8)]),
    /reference videos must be at most 15 seconds in total/,
  );
  assert.throws(
    () => validate([img('hero'), aud('a'), aud('b')], [fact(aud('a'), 8), fact(aud('b'), 8)]),
    /reference audio must be at most 15 seconds in total/,
  );
  // A reference video's per-file 2..15 s window is owned by validateReference, so
  // the SET does not re-check it (Plan would otherwise mislabel the file
  // model-request-invalid instead of reference-media-invalid).
  assert.doesNotThrow(() => validate([img('hero'), vid('clip')], [fact(vid('clip'), 1)]));
  // Valid totals (two 6 s videos = 12 s) pass; a fact without duration skips only its checks.
  assert.doesNotThrow(() => validate([img('hero'), vid('a'), vid('b')], [fact(vid('a'), 6), fact(vid('b'), 6)]));
  assert.doesNotThrow(() =>
    validate(
      [img('hero'), vid('clip'), aud('track')],
      [fact(img('hero'), undefined), fact(vid('clip'), 2), fact(aud('track'), 2)],
    ),
  );
  assert.doesNotThrow(() =>
    validate(
      [img('hero'), vid('clip'), aud('track')],
      [fact(img('hero'), undefined), fact(vid('clip'), undefined), fact(aud('track'), undefined)],
    ),
  );
});

test('the API endpoint rejects insecure remote URLs, credentials and query strings', async () => {
  await withRoot(async root => {
    const image = await hero(root);
    for (const bad of [
      'ftp://example.com',
      'http://example.com:8000',
      'http://127.0.0.1:8000/path?x=1',
      'http://user:pass@127.0.0.1:8000',
    ]) {
      await assert.rejects(
        () =>
          generateVideoApi(
            root,
            source(`att_bad_${Buffer.from(bad).toString('hex').slice(0, 8)}`),
            OUTPUT,
            'build/a.mp4',
            { endpoint: { protocol: 'vllm-omni-video', baseUrl: bad }, references: [image] },
          ),
        /https|credentials|query|path|http|URL/i,
      );
    }
    assert.ok(!existsSync(join(root, '.viscraft', 'jobs', 'video-api')) || (await videoApiStatus(root)).length === 0);
  });
});

test('an out-of-contract source is rejected by canonical validation before any request', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      const image = await hero(root);
      // Ten image references exceed the official Ref2VA limit of 9: refused by the
      // H3 model profile before any reference resolution or request.
      const tenImages = Array.from({ length: 10 }, () => ({
        asset: 'hero',
        category: 'image' as const,
        role: 'identity' as const,
      }));
      const bad = source('att_bad_contract', { references: tenImages });
      await assert.rejects(
        () =>
          generateVideoApi(root, bad, OUTPUT, 'build/b.mp4', {
            testOnly: { baseUrl: fixture.baseUrl },
            extension: minimaxH3Ref2vaExtension(),
            references: [image],
          }),
        /MiniMax-H3|at most 9 image references/i,
      );
      assert.equal(fixture.state.submits, 0, 'an invalid source must not reach the service');
    });
  });
});

test('real submission is gated on explicit authorization plus per-Asset transmission consent', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      const image = await hero(root);
      // A service must be supplied; no cluster-specific default exists.
      await assert.rejects(
        () =>
          generateVideoApi(root, source('att_noendpoint'), OUTPUT, 'build/a.mp4', {
            authorization: { submit: true, uploadAssets: ['hero'] },
            references: [image],
          }),
        /missing endpoint|endpoint configuration|is not configured/i,
      );
      // No authorization at all.
      await assert.rejects(
        () =>
          generateVideoApi(root, source('att_noauth'), OUTPUT, 'build/a.mp4', {
            endpoint: { protocol: 'vllm-omni-video', baseUrl: fixture.baseUrl },
            extension: minimaxH3Ref2vaExtension(),
            references: [image],
          }),
        /authorization/i,
      );
      // Authorization given, but no per-Asset transmission consent.
      await assert.rejects(
        () =>
          generateVideoApi(root, source('att_noconsent'), OUTPUT, 'build/a.mp4', {
            endpoint: { protocol: 'vllm-omni-video' as const, baseUrl: fixture.baseUrl },
            extension: minimaxH3Ref2vaExtension(),
            authorization: { submit: true },
            references: [image],
          }),
        /consent|uploadAssets/i,
      );
      assert.equal(fixture.state.submits, 0, 'the gate must run before any request');
      assert.ok(!existsSync(join(root, JOB_FILE_REL('att_noendpoint'))));
      assert.ok(!existsSync(join(root, JOB_FILE_REL('att_noauth'))));
      assert.ok(!existsSync(join(root, JOB_FILE_REL('att_noconsent'))));
      for (const request of fixture.state.requests)
        assert.equal(request.authorization, undefined, 'no credential may ever be sent');
    });
  });
});

test('real transport: queued -> in_progress -> completed produces normalized media with a single submit', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      const image = await hero(root);
      const options = {
        testOnly: { baseUrl: fixture.baseUrl },
        extension: minimaxH3Ref2vaExtension(),
        references: [image],
      };
      fixture.config.statuses = ['queued', 'in_progress', 'completed'];

      const pending = await generateVideoApi(root, source('att_ok'), OUTPUT, 'build/take.mp4', options).then(
        () => null,
        (e: unknown) => e,
      );
      assert.ok(pending instanceof VideoApiPendingError, 'first invocation is pending');
      assert.equal(pending.recoverable, true);

      const submittedJob = await readJob(root, 'att_ok');
      assert.equal((submittedJob.references as Array<Record<string, unknown>>)[0].mime, 'image/png');
      // Exercise an already-valid current job written before reference MIME was
      // recorded. Recovery may infer PNG vs JPEG only by rebuilding each
      // candidate request identity and matching the complete persisted hash.
      delete (submittedJob.references as Array<Record<string, unknown>>)[0].mime;
      await writeFile(join(root, JOB_FILE_REL('att_ok')), JSON.stringify(submittedJob));

      // Once the provider accepted the request, its immutable job record is
      // enough to reconstruct the semantic request identity for GET recovery.
      // The original image is not re-opened or re-uploaded.
      await rm(join(root, 'assets', 'hero.png'));
      const getsBeforeMismatch = fixture.state.gets;
      await assert.rejects(
        () => generateVideoApi(root, source('att_ok', { requestedFrames: 114 }), OUTPUT, 'build/changed.mp4', options),
        /different frozen request|reference .* differs|cannot be resumed/i,
      );
      await assert.rejects(
        () =>
          generateVideoApi(
            root,
            source('att_ok', { prompt: 'a different authored prompt' }),
            OUTPUT,
            'build/changed-prompt.mp4',
            options,
          ),
        /different frozen request|cannot be resumed/i,
      );
      await assert.rejects(
        () =>
          generateVideoApi(
            root,
            source('att_ok', {
              mode: 'first-last-frame',
              references: [{ asset: 'hero', category: 'image', role: 'first-frame' }],
            }),
            OUTPUT,
            'build/changed-mode.mp4',
            options,
          ),
        /first-last-frame|Ref2VA supports reference generation only/i,
      );
      const changedEndpoint = new URL(fixture.baseUrl);
      changedEndpoint.port = String(Number(changedEndpoint.port) + 1);
      await assert.rejects(
        () =>
          generateVideoApi(root, source('att_ok'), OUTPUT, 'build/changed-endpoint.mp4', {
            ...options,
            testOnly: { baseUrl: changedEndpoint.origin },
          }),
        /different frozen request|cannot be resumed/i,
      );
      await assert.rejects(
        () =>
          generateVideoApi(root, source('att_ok'), OUTPUT, 'build/changed-locator.mp4', {
            ...options,
            referenceLocators: { hero: { url: 'asset://hero', sha256: image.asset.sha256 } },
          }),
        /different frozen request|cannot be resumed/i,
      );
      assert.equal(fixture.state.gets, getsBeforeMismatch, 'changed authored requests are refused before polling');

      const ambiguousJob = await readJob(root, 'att_ok');
      const originalRequestHash = ambiguousJob.requestHash;
      ambiguousJob.requestHash = '0'.repeat(64);
      await writeFile(join(root, JOB_FILE_REL('att_ok')), JSON.stringify(ambiguousJob));
      await assert.rejects(
        () => generateVideoApi(root, source('att_ok'), OUTPUT, 'build/unproven.mp4', options),
        /cannot be resumed/i,
      );
      assert.equal(
        fixture.state.gets,
        getsBeforeMismatch,
        'an identity with no matching MIME candidate is refused before GET',
      );
      assert.equal(fixture.state.submits, 1, 'an identity with no matching candidate never creates a second POST');
      ambiguousJob.requestHash = originalRequestHash;
      await writeFile(join(root, JOB_FILE_REL('att_ok')), JSON.stringify(ambiguousJob));

      const running = await generateVideoApi(root, source('att_ok'), OUTPUT, 'build/take.mp4', options).then(
        () => null,
        (e: unknown) => e,
      );
      assert.ok(running instanceof VideoApiPendingError, 'second invocation still running');

      const result = await generateVideoApi(root, source('att_ok'), OUTPUT, 'build/take.mp4', options);
      assert.equal(result.backend, 'vllm-omni-video/minimax-h3-base-ref2va');

      // Portable provider provenance is returned for a success (no URLs / secrets / invented cost).
      assert.equal(result.generation.provider, 'video-api');
      assert.equal(result.generation.model, 'minimax-h3-base-ref2va');
      assert.equal(result.generation.taskId, 'video_gen_fixture_1');
      assert.equal(result.generation.requestedFrames, 97);
      assert.equal(result.generation.inferenceSeconds, 3.5);
      assert.deepEqual(result.generation.references, [
        { asset: 'hero', sha256: image.asset.sha256, category: 'image', role: 'identity' },
      ]);
      assert.ok(!JSON.stringify(result.generation).includes('http'), 'generation must not embed remote URLs');
      assert.equal(result.generation.estimatedCredits, undefined);

      // Real normalized media at the target settings.
      const normalized = await probeMedia(join(root, 'build', 'take.mp4'));
      assert.match(normalized.videoCodec, /h264/i);
      assert.equal(normalized.width, OUTPUT.width);
      assert.equal(normalized.height, OUTPUT.height);
      assert.equal(normalized.frames, 60);

      // Original provider bytes retained and hashed.
      const original = join(root, PROVIDER_FILE_REL('att_ok'));
      assert.ok(existsSync(original), 'original provider media must be retained');
      assert.equal((await probeMedia(original)).frames, 60);

      const job = await readJob(root, 'att_ok');
      assert.equal(job.state, 'succeeded');
      assert.equal(job.submitted, 1, 'exactly one submit across all resume invocations');
      assert.equal(job.simulated, true, 'a test-only (loopback fixture) run must be marked simulated');
      assert.equal(job.mode, 'test');
      assert.equal(job.taskId, 'video_gen_fixture_1');
      assert.equal(job.requestedFrames, 97);
      assert.equal(job.alignedFrames, undefined, 'generic job records keep actual media authoritative');
      assert.equal(job.width, 1344);
      assert.equal(job.height, 768);
      assert.deepEqual(job.references, [
        {
          asset: 'hero',
          sha256: image.asset.sha256,
          category: 'image',
          role: 'identity',
          simulated: false,
        },
      ]);
      assert.equal(job.originalMediaSha256, await hashFile(original));
      assert.equal(job.artifactSha256, await hashFile(join(root, 'build', 'take.mp4')));
      assert.equal(job.artifactPath, 'build/take.mp4');

      // Exactly one submit, one download, and one status GET per invocation.
      assert.equal(fixture.state.submits, 1);
      assert.equal(fixture.state.downloads, 1);
      assert.equal(fixture.state.gets, 3);

      // The submit used the documented multipart wire contract.
      const submit = fixture.state.requests.find(r => r.method === 'POST');
      assert.ok(submit?.multipart);
      assert.equal(submit.authorization, undefined, 'no credential may ever be sent');
      const { fields, files } = submit.multipart;
      assert.equal(fields.model, 'MiniMax-H3');
      assert.equal(fields.prompt, source('att_ok').prompt);
      assert.equal(fields.width, '1344');
      assert.equal(fields.height, '768');
      assert.equal(fields.fps, '24');
      assert.equal(fields.num_frames, '97');
      assert.equal(fields.num_inference_steps, '30');
      assert.equal(fields.flow_shift, '12');
      assert.equal(fields.seed, '7');
      // The reference-mode task now reaches the wire as real extra_params.
      const extra = JSON.parse(fields.extra_params) as { task: string; frame_indices?: number[] };
      assert.equal(extra.task, 'ref2va');
      assert.equal(extra.frame_indices, undefined, 'reference mode carries no frame indices');
      assert.equal(files.length, 1);
      assert.equal(files[0].name, 'input_references');
      assert.match(files[0].type ?? '', /^image\/png$/);
      assert.equal(
        createHash('sha256').update(files[0].data).digest('hex'),
        image.asset.sha256,
        'the exact uploaded bytes must hash to the approved Asset',
      );

      // The job records provenance only — never image bytes or the prompt.
      const raw = await readFile(join(root, JOB_FILE_REL('att_ok')), 'utf8');
      assert.ok(!raw.includes(source('att_ok').prompt), 'the raw prompt must never be persisted');
      assert.ok(!raw.includes(files[0].data.toString('base64').slice(0, 32)), 'no image bytes may be persisted');

      // Restoring a succeeded job must not touch the network or resubmit.
      const before = fixture.state;
      const restored = await generateVideoApi(root, source('att_ok'), OUTPUT, 'exports/again.mp4', options);
      assert.ok(existsSync(join(root, 'exports', 'again.mp4')));
      assert.equal(
        restored.generation.taskId,
        'video_gen_fixture_1',
        'a local restore still reports provider provenance',
      );
      assert.equal(before.submits, 1);
      assert.equal(before.gets, 3);
      assert.equal(before.downloads, 1);

      const listed = (await videoApiStatus(root)) as Array<Record<string, unknown>>;
      assert.equal(listed.length, 1);
      assert.equal(listed[0].attempt, 'att_ok');
    });
  });
});

test('a failed download resumes without resubmitting or re-querying', async () => {
  await withRoot(async root => {
    await withFixture(
      async fixture => {
        const image = await hero(root);
        const options = {
          testOnly: { baseUrl: fixture.baseUrl },
          extension: minimaxH3Ref2vaExtension(),
          references: [image],
        };
        await assert.rejects(
          () => generateVideoApi(root, source('att_dl'), OUTPUT, 'build/dl.mp4', options),
          /download failed/i,
        );
        const first = await readJob(root, 'att_dl');
        assert.equal(first.state, 'download-failed');
        assert.equal(first.submitted, 1);
        assert.ok(!existsSync(join(root, 'build', 'dl.mp4')));

        await generateVideoApi(root, source('att_dl'), OUTPUT, 'build/dl.mp4', options);
        const second = await readJob(root, 'att_dl');
        assert.equal(second.state, 'succeeded');
        assert.equal(second.submitted, 1, 'resuming the download must not submit again');
        assert.equal(fixture.state.submits, 1);
        assert.equal(fixture.state.downloads, 2);
        assert.equal(fixture.state.gets, 1, 'the deterministic content path needs no re-query');
        assert.equal((await probeMedia(join(root, 'build', 'dl.mp4'))).frames, 60);
      },
      { download: 'fail-once', statuses: ['completed'] },
    );
  });
});

test('an ambiguous submit never resubmits and blocks further attempts', async () => {
  for (const submit of ['network', 'http500', 'malformed'] as const) {
    await withRoot(async root => {
      await withFixture(
        async fixture => {
          const image = await hero(root);
          const options = {
            testOnly: { baseUrl: fixture.baseUrl },
            extension: minimaxH3Ref2vaExtension(),
            references: [image],
          };
          await assert.rejects(
            () => generateVideoApi(root, source(`att_unknown_${submit}`), OUTPUT, 'build/u.mp4', options),
            /unknown/i,
          );
          const first = await readJob(root, `att_unknown_${submit}`);
          assert.equal(first.state, 'submit-unknown');
          assert.equal(first.submitted, 1);

          await assert.rejects(
            () => generateVideoApi(root, source(`att_unknown_${submit}`), OUTPUT, 'build/u.mp4', options),
            /unknown|not resubmit/i,
          );
          assert.equal(fixture.state.submits, 1, 'an ambiguous submit must never be retried');
          const second = await readJob(root, `att_unknown_${submit}`);
          assert.equal(second.submitted, 1);
        },
        { submit },
      );
    });
  }
});

test('a failed job is terminal and never resubmits', async () => {
  await withRoot(async root => {
    await withFixture(
      async fixture => {
        const image = await hero(root);
        const options = {
          testOnly: { baseUrl: fixture.baseUrl },
          extension: minimaxH3Ref2vaExtension(),
          references: [image],
        };
        await assert.rejects(
          () => generateVideoApi(root, source('att_fail'), OUTPUT, 'build/f.mp4', options),
          /failed/i,
        );
        const failed = await readJob(root, 'att_fail');
        assert.equal(failed.state, 'failed');
        await assert.rejects(
          () => generateVideoApi(root, source('att_fail'), OUTPUT, 'build/f.mp4', options),
          /permanent|not resubmitting/i,
        );
        assert.equal(fixture.state.submits, 1);
      },
      { statuses: ['failed'] },
    );
  });
});

test('the job id must match the persisted id; a mismatched status id is refused', async () => {
  await withRoot(async root => {
    await withFixture(
      async fixture => {
        const image = await hero(root);
        const options = {
          testOnly: { baseUrl: fixture.baseUrl },
          extension: minimaxH3Ref2vaExtension(),
          references: [image],
        };
        await assert.rejects(
          () => generateVideoApi(root, source('att_mismatch'), OUTPUT, 'build/m.mp4', options),
          /does not match/i,
        );
        assert.equal((await readJob(root, 'att_mismatch')).state, 'submitted');
      },
      { statuses: ['in_progress'], statusId: 'video_gen_other' },
    );
  });
});

test('reusing an attempt id with changed parameters is rejected before any request', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      const image = await hero(root);
      const options = {
        testOnly: { baseUrl: fixture.baseUrl },
        extension: minimaxH3Ref2vaExtension(),
        references: [image],
      };
      await generateVideoApi(root, source('att_conflict'), OUTPUT, 'build/c.mp4', options);
      const before = fixture.state.submits;
      await assert.rejects(
        () => generateVideoApi(root, source('att_conflict', { requestedFrames: 200 }), OUTPUT, 'build/c2.mp4', options),
        /different frozen request|new attempt/i,
      );
      assert.equal(fixture.state.submits, before, 'a changed request must be rejected before contacting the service');
      const job = await readJob(root, 'att_conflict');
      assert.equal(job.requestedFrames, 97);
      assert.equal(job.submitted, 1);
    });
  });
});

test('a held per-attempt lock refuses a concurrent generation of the same attempt', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      const image = await hero(root);
      const options = {
        testOnly: { baseUrl: fixture.baseUrl },
        extension: minimaxH3Ref2vaExtension(),
        references: [image],
      };
      const lockDir = join(root, '.viscraft', 'jobs', 'video-api');
      await mkdir(lockDir, { recursive: true });
      await writeFile(join(lockDir, `${stem('att_lock')}.lock`), 'held by another run\n');

      await assert.rejects(
        () => generateVideoApi(root, source('att_lock'), OUTPUT, 'build/l.mp4', options),
        /already being generated|concurrently/i,
      );
      assert.equal(fixture.state.submits, 0, 'a locked attempt must not contact the service');
      assert.ok(!existsSync(join(root, JOB_FILE_REL('att_lock'))), 'no job record is written while locked');
    });
  });
});

test('a simulated reference Asset taints a production (real service) job', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      const image = await hero(root, 'hero', 64, true);
      const options = {
        endpoint: { protocol: 'vllm-omni-video' as const, baseUrl: fixture.baseUrl },
        extension: minimaxH3Ref2vaExtension(),
        authorization: { submit: true, uploadAssets: ['hero'] },
        references: [image],
      };
      const result = await generateVideoApi(root, source('att_taint'), OUTPUT, 'build/t.mp4', options);
      assert.equal(result.generation.provider, 'video-api');
      const job = await readJob(root, 'att_taint');
      assert.equal(job.mode, 'production');
      assert.equal(job.simulated, true, 'a real-service run over a simulated Asset must be tainted');
      assert.equal(job.submitted, 1);
      assert.equal(fixture.state.submits, 1);
    });
  });
});

// ---------------------------------------------------------------------------
// Task-partition semantics: the deployment's declared partition decides which
// request modes exist, and an incompatible mode is refused with the PARTITION
// reason (never a reference-count reason that would imply the wrong partition).
// ---------------------------------------------------------------------------

test('explicit H3 Base identities allow only their own tasks before submission', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      const image = await hero(root);
      const base = { testOnly: { baseUrl: fixture.baseUrl }, references: [image] };
      const fl = minimaxH3Fl2vaExtension();
      const ref = minimaxH3Ref2vaExtension();
      await generateVideoApi(
        root,
        source('fl_text', { model: fl.model.id, mode: 'text', references: [] }),
        OUTPUT,
        'build/text.mp4',
        { ...base, extension: fl, references: [] },
      );
      await generateVideoApi(
        root,
        source('fl_frame', {
          model: fl.model.id,
          mode: 'first-last-frame',
          references: [{ asset: 'hero', category: 'image', role: 'first-frame' }],
        }),
        OUTPUT,
        'build/frame.mp4',
        { ...base, extension: fl },
      );
      const submitted = fixture.state.submits;
      await assert.rejects(
        () =>
          generateVideoApi(root, source('bad_fl', { model: fl.model.id }), OUTPUT, 'build/bad.mp4', {
            ...base,
            extension: fl,
          }),
        /FL2VA.*reference generation/,
      );
      await assert.rejects(
        () =>
          generateVideoApi(root, source('bad_ref', { mode: 'text', references: [] }), OUTPUT, 'build/bad.mp4', {
            ...base,
            extension: ref,
            references: [],
          }),
        /Ref2VA.*reference generation only/,
      );
      await assert.rejects(
        () =>
          generateVideoApi(root, source('bad_settings'), OUTPUT, 'build/bad.mp4', {
            ...base,
            extension: ref,
            endpoint: { protocol: 'vllm-omni-video', baseUrl: fixture.baseUrl, modelSettings: { taskType: 'both' } },
          }),
        /no modelSettings/,
      );
      assert.equal(fixture.state.submits, submitted, 'wrong model capability and removed settings cannot submit');
    });
  });
});

// ---------------------------------------------------------------------------
// Mode encoding: every H3 mode reaches the wire as `extra_params.task` plus
// (`fl2va` only) `extra_params.frame_indices`, derived from the authored
// reference roles/order. References stay ordered multipart `input_references`.
// ---------------------------------------------------------------------------

test('every H3 mode encodes its task and frame positions on the wire', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      const a = await hero(root, 'heroA');
      const b = await hero(root, 'heroB');
      const opts = { testOnly: { baseUrl: fixture.baseUrl } };

      const modes: Array<{
        attempt: string;
        overrides: Partial<ProviderSource>;
        refs: { asset: Asset; root: string }[];
        task: string;
        frameIndices?: number[];
      }> = [
        { attempt: 'mode_text', overrides: { mode: 'text', references: [] }, refs: [], task: 't2va' },
        {
          attempt: 'mode_first',
          overrides: {
            mode: 'first-last-frame',
            references: [{ asset: 'heroA', category: 'image', role: 'first-frame' }],
          },
          refs: [a],
          task: 'fl2va',
          frameIndices: [0],
        },
        {
          attempt: 'mode_last',
          overrides: {
            mode: 'first-last-frame',
            references: [{ asset: 'heroA', category: 'image', role: 'last-frame' }],
          },
          refs: [a],
          task: 'fl2va',
          frameIndices: [-1],
        },
        {
          attempt: 'mode_firstlast',
          overrides: {
            mode: 'first-last-frame',
            references: [
              { asset: 'heroA', category: 'image', role: 'first-frame' },
              { asset: 'heroB', category: 'image', role: 'last-frame' },
            ],
          },
          refs: [a, b],
          task: 'fl2va',
          frameIndices: [0, -1],
        },
        {
          attempt: 'mode_reverse',
          overrides: {
            mode: 'first-last-frame',
            references: [
              { asset: 'heroB', category: 'image', role: 'last-frame' },
              { asset: 'heroA', category: 'image', role: 'first-frame' },
            ],
          },
          refs: [b, a],
          task: 'fl2va',
          frameIndices: [-1, 0],
        },
        {
          attempt: 'mode_ref',
          overrides: {
            mode: 'reference',
            references: [
              { asset: 'heroA', category: 'image', role: 'identity' },
              { asset: 'heroB', category: 'image', role: 'style' },
            ],
          },
          refs: [a, b],
          task: 'ref2va',
        },
      ];

      for (const mode of modes) {
        const extension = mode.task === 'ref2va' ? minimaxH3Ref2vaExtension() : minimaxH3Fl2vaExtension();
        await generateVideoApi(
          root,
          source(mode.attempt, { ...mode.overrides, model: extension.model.id }),
          OUTPUT,
          `build/${mode.attempt}.mp4`,
          {
            ...opts,
            extension,
            references: mode.refs,
          },
        );
      }

      const posts = fixture.state.requests.filter(request => request.method === 'POST');
      assert.equal(posts.length, modes.length);
      modes.forEach((mode, index) => {
        const extra = JSON.parse(posts[index].multipart!.fields.extra_params) as {
          task: string;
          frame_indices?: number[];
        };
        assert.equal(extra.task, mode.task, `${mode.attempt}: task`);
        if (mode.frameIndices)
          assert.deepEqual(extra.frame_indices, mode.frameIndices, `${mode.attempt}: frame_indices`);
        else assert.equal(extra.frame_indices, undefined, `${mode.attempt}: no frame indices`);
      });

      // Reference mode keeps the authored order on the wire: parts are appended
      // in Source order, with no separate role field.
      const refPost = posts[modes.length - 1];
      assert.equal(refPost.multipart!.files.length, 2);
      assert.ok(refPost.multipart!.files.every(file => file.name === 'input_references'));
      assert.equal(
        createHash('sha256').update(refPost.multipart!.files[0].data).digest('hex'),
        a.asset.sha256,
        'first authored reference is sent first',
      );
      assert.equal(
        createHash('sha256').update(refPost.multipart!.files[1].data).digest('hex'),
        b.asset.sha256,
        'second authored reference follows',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Set-level reference validation: an out-of-window reference file is refused
// before any upload, and a valid image+video+audio set is transmitted in order.
// ---------------------------------------------------------------------------

test('an out-of-window or over-total H3 reference set is refused before upload', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      const heroAsset = await hero(root);
      const short = await shortVideo(root, 'short'); // 1 s video, below the 2 s floor
      const longVideo = await referenceVideo(root, 'longvideo', 16); // 16 s, above the 15 s ceiling
      const longAudio = await audioWav(root, 'longaudio', 16); // 16 s, above the audio ceiling
      const shortAudio = await audioWav(root, 'shortaudio', 1); // 1 s, below the 2 s floor
      const videoA = await referenceVideo(root, 'v8a', 8);
      const videoB = await referenceVideo(root, 'v8b', 8);
      const audioA = await audioWav(root, 'a8a', 8);
      const audioB = await audioWav(root, 'a8b', 8);
      const opts = { testOnly: { baseUrl: fixture.baseUrl }, extension: minimaxH3Ref2vaExtension() };
      const imageRef = { asset: 'hero', category: 'image' as const, role: 'identity' as const };
      const videoRef = (asset: string) => ({ asset, category: 'video' as const, role: 'motion' as const });
      const audioRef = (asset: string) => ({ asset, category: 'audio' as const, role: 'audio' as const });

      // Per-file VIDEO window (owned by validateReference, still pre-upload).
      await assert.rejects(
        () =>
          generateVideoApi(
            root,
            source('set_short_video', { references: [imageRef, videoRef('short')] }),
            OUTPUT,
            'build/a.mp4',
            { ...opts, references: [heroAsset, short] },
          ),
        /duration 2\.\.15/i,
      );
      await assert.rejects(
        () =>
          generateVideoApi(
            root,
            source('set_long_video', { references: [imageRef, videoRef('longvideo')] }),
            OUTPUT,
            'build/b.mp4',
            { ...opts, references: [heroAsset, longVideo] },
          ),
        /duration 2\.\.15/i,
      );
      // Per-file AUDIO window 2..15 s.
      await assert.rejects(
        () =>
          generateVideoApi(
            root,
            source('set_long_audio', { references: [imageRef, audioRef('longaudio')] }),
            OUTPUT,
            'build/c.mp4',
            { ...opts, references: [heroAsset, longAudio] },
          ),
        /reference audio duration must be 2\.\.15/i,
      );
      await assert.rejects(
        () =>
          generateVideoApi(
            root,
            source('set_short_audio', { references: [imageRef, audioRef('shortaudio')] }),
            OUTPUT,
            'build/d.mp4',
            { ...opts, references: [heroAsset, shortAudio] },
          ),
        /reference audio duration must be 2\.\.15/i,
      );
      // Aggregate totals (official): two 8 s videos / two 8 s audios exceed 15 s.
      await assert.rejects(
        () =>
          generateVideoApi(
            root,
            source('set_video_total', { references: [imageRef, videoRef('v8a'), videoRef('v8b')] }),
            OUTPUT,
            'build/e.mp4',
            { ...opts, references: [heroAsset, videoA, videoB] },
          ),
        /reference videos must be at most 15 seconds in total/i,
      );
      await assert.rejects(
        () =>
          generateVideoApi(
            root,
            source('set_audio_total', { references: [imageRef, audioRef('a8a'), audioRef('a8b')] }),
            OUTPUT,
            'build/f.mp4',
            { ...opts, references: [heroAsset, audioA, audioB] },
          ),
        /reference audio must be at most 15 seconds in total/i,
      );
      assert.equal(fixture.state.submits, 0, 'a set-level rejection must never reach the service');
    });
  });
});

test('a valid image+video+audio H3 reference set passes and uploads in authored order', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      const heroAsset = await hero(root);
      const clip = await referenceVideo(root, 'clip');
      const track = await audioWav(root, 'track', 2);
      const references = [
        { asset: 'hero', category: 'image' as const, role: 'identity' as const },
        { asset: 'clip', category: 'video' as const, role: 'motion' as const },
        { asset: 'track', category: 'audio' as const, role: 'audio' as const },
      ];
      const result = await generateVideoApi(root, source('set_valid', { references }), OUTPUT, 'build/set.mp4', {
        testOnly: { baseUrl: fixture.baseUrl },
        extension: minimaxH3Ref2vaExtension(),
        references: [heroAsset, clip, track],
      });
      assert.equal(result.generation.provider, 'video-api');
      const submit = fixture.state.requests.find(request => request.method === 'POST');
      assert.ok(submit?.multipart);
      const parts = submit.multipart.files.filter(file => file.name === 'input_references');
      assert.equal(parts.length, 3, 'image, video and audio are all transmitted');
      assert.deepEqual(
        parts.map(part => createHash('sha256').update(part.data).digest('hex')),
        [heroAsset.asset.sha256, clip.asset.sha256, track.asset.sha256],
      );
      const extra = JSON.parse(submit.multipart.fields.extra_params) as { task: string };
      assert.equal(extra.task, 'ref2va');

      // A two-video set within the 15 s total (6 s + 6 s) is accepted.
      const videoA = await referenceVideo(root, 'v6a', 6);
      const videoB = await referenceVideo(root, 'v6b', 6);
      const twoVideos = [
        { asset: 'hero', category: 'image' as const, role: 'identity' as const },
        { asset: 'v6a', category: 'video' as const, role: 'motion' as const },
        { asset: 'v6b', category: 'video' as const, role: 'motion' as const },
      ];
      const accepted = await generateVideoApi(
        root,
        source('set_total_valid', { references: twoVideos }),
        OUTPUT,
        'build/total.mp4',
        {
          testOnly: { baseUrl: fixture.baseUrl },
          extension: minimaxH3Ref2vaExtension(),
          references: [heroAsset, videoA, videoB],
        },
      );
      assert.equal(accepted.generation.provider, 'video-api');
    });
  });
});

// ---------------------------------------------------------------------------
// Model isolation: the H3 profile is scoped to the model, so another model
// neither inherits its reference counts nor its reference-video media profile.
// ---------------------------------------------------------------------------

test('an unprofiled model neither inherits H3 reference counts nor its reference-video media profile', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      const image = await hero(root);
      const thirteen = Array.from({ length: 13 }, () => ({
        asset: 'hero',
        category: 'image' as const,
        role: 'identity' as const,
      }));
      const providedImages = Array.from({ length: 13 }, () => image);

      // 13 image references are legal for a model the profile does not name; all
      // 13 are transmitted (no global cap silently drops the extras).
      const result = await generateVideoApi(
        root,
        source('att_other_13', { model: 'Some-Other-Video-Model', references: thirteen }),
        OUTPUT,
        'build/o.mp4',
        { testOnly: { baseUrl: fixture.baseUrl }, references: providedImages },
      );
      assert.equal(result.generation.model, 'Some-Other-Video-Model');
      const submit = fixture.state.requests.find(request => request.method === 'POST');
      assert.equal(submit?.multipart?.files.length, 13, 'every reference is transmitted for an unprofiled model');
      // The same request to MiniMax-H3 is refused by the model profile.
      await assert.rejects(
        () =>
          generateVideoApi(root, source('att_h3_13', { references: thirteen }), OUTPUT, 'build/h.mp4', {
            testOnly: { baseUrl: fixture.baseUrl },
            extension: minimaxH3Ref2vaExtension(),
            references: providedImages,
          }),
        /at most 9 image references/,
      );

      // A reference video the H3 media profile would reject is accepted for an
      // unprofiled model: the H3 2..15 s / codec rules must not leak.
      const { asset: clipAsset, root: clipRoot } = await shortVideo(root);
      const videoRefs = [
        { asset: 'hero', category: 'image' as const, role: 'identity' as const },
        { asset: 'clip', category: 'video' as const, role: 'motion' as const },
      ];
      const provided = [image, { asset: clipAsset, root: clipRoot }];
      const other = await generateVideoApi(
        root,
        source('att_other_video', { model: 'Some-Other-Video-Model', references: videoRefs }),
        OUTPUT,
        'build/ov.mp4',
        { testOnly: { baseUrl: fixture.baseUrl }, references: provided },
      );
      assert.equal(other.generation.model, 'Some-Other-Video-Model');
      await assert.rejects(
        () =>
          generateVideoApi(root, source('att_h3_video', { references: videoRefs }), OUTPUT, 'build/hv.mp4', {
            testOnly: { baseUrl: fixture.baseUrl },
            extension: minimaxH3Ref2vaExtension(),
            references: provided,
          }),
        /duration 2\.\.15|MiniMax-H3 reference video/i,
      );
    });
  });
});

test('conflicting duplicate provided references for one Asset id are refused, never silently resolved', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      const image = await hero(root);
      const declared = [
        { asset: 'hero', category: 'image' as const, role: 'identity' as const },
        { asset: 'hero', category: 'image' as const, role: 'style' as const },
      ];
      await assert.rejects(
        () =>
          generateVideoApi(root, source('att_dup', { references: declared }), OUTPUT, 'build/d.mp4', {
            testOnly: { baseUrl: fixture.baseUrl },
            extension: minimaxH3Ref2vaExtension(),
            references: [image, { asset: { ...image.asset, sha256: '0'.repeat(64) }, root }],
          }),
        /conflicting duplicate options\.references entries/i,
      );
      assert.equal(fixture.state.submits, 0, 'an ambiguous reference set must not reach the service');
    });
  });
});
