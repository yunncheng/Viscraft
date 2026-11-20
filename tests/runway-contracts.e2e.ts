/**
 * Runway adapter contract tests — real local transport, real media.
 *
 * These tests drive the adapter through a real Node HTTP fixture on loopback
 * (the adapter's documented test-only transport) and assert on the persisted
 * `.viscraft/jobs/runway/<sourceId>.<attempt>.json` records. A successful case downloads
 * real provider bytes, then normalizes them with the shared FFmpeg media plane,
 * so a passing run means an actual probeable H.264 file was produced — not a
 * type-checked stub. No paid API, no external network.
 *
 * High-risk invariants covered by the adapter:
 *  - production submit is gated on explicit authorization + key, before any job
 *    is created or any request is sent;
 *  - an ambiguous submit is never auto-resubmitted (state stays `submit-unknown`);
 *  - a failed download resumes without regenerating (submit count stays 1);
 *  - a known task is queried at most once per invocation and a >5 s real poll is
 *    gated by `nextQueryAt` (bypassed in test mode);
 *  - the request hash binds mode/base/output, so a changed request is rejected;
 *  - secrets and remote URLs are never persisted.
 */

import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import type { Asset, OutputSettings, ProviderSource } from '../src/core/schema.js';
import { generateRunway, runwayCapabilities, runwayStatus } from '../src/backends/providers/services/runway/index.js';
import {
  planBuild,
  buildProject,
  createProject,
  saveProject,
  loadProject,
  gen4TurboExtension,
  type GenerationExtension,
} from '../src/index.js';
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
const PROVIDER_FILE_REL = (attempt: string) => `.viscraft/provider-media/s_${attempt}.${attempt}.mp4`;
const JOB_FILE_REL = (attempt: string) => `.viscraft/jobs/runway/s_${attempt}.${attempt}.json`;

type RemoteStatus = 'PENDING' | 'THROTTLED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

/** The default gen4.5 parameters (the model profile owns these, not the Source). */
const DEFAULT_PARAMETERS = { durationSeconds: 4, ratio: '1280:720' } as const;

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
    endpoint: 'runway',
    model: 'gen4.5',
    prompt: overrides.prompt ?? 'a red rally car drifting through a snowy mountain pass at dawn',
    mode: overrides.mode ?? 'text',
    references: overrides.references ?? [],
    requestedFrames: 24,
    fps: 24,
    // The vendor accepts only its ratio strings; the required raster `size` must
    // match the requested ratio, so it is derived from it here.
    size: overrides.size ?? (parameters.ratio as string) ?? '1280:720',
    seed: overrides.seed ?? 7,
    attempt,
    parameters,
  };
}

/** A first-frame reference list for the given Asset id. */
const firstFrame = (asset: string): ProviderSource['references'] => [{ asset, category: 'image', role: 'first-frame' }];

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
  const root = await mkdtemp(join(tmpdir(), 'viscraft-runway-'));
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
    const dir = await mkdtemp(join(tmpdir(), 'viscraft-runway-media-'));
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
  gets: number;
  downloads: number;
  requests: { method: string; path: string; authorization?: string; version?: string; body: string }[];
}

interface FixtureConfig {
  taskId: string;
  /** Optional id the status endpoint echoes back (to exercise the id-match guard). */
  statusId?: string;
  statuses: RemoteStatus[];
  submit: 'ok' | 'http500' | 'http400' | 'malformed' | 'network';
  download: 'ok' | 'fail-once';
  cost: number;
  finalCost: number;
  /**
   * Hostile-provider mode: the named endpoint answers HTTP 401 with a body that
   * deliberately echoes the `Authorization` header it received, so a test can
   * prove no credential is interpolated into an error or persisted. Runway has no
   * separate result endpoint — the task GET carries both status and output, so
   * `'status'` covers the result fetch too.
   */
  echoAuth401?: 'submit' | 'status';
}

interface Fixture {
  baseUrl: string;
  mediaUrl: (id: string) => string;
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
    taskId: 'task_fixture_1',
    statuses: ['SUCCEEDED'],
    submit: 'ok',
    download: 'ok',
    cost: 12,
    finalCost: 10,
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
        version: req.headers['x-runway-version'] as string | undefined,
        body: Buffer.concat(chunks).toString('utf8'),
      });

      if (req.method === 'POST' && (path === '/v1/text_to_video' || path === '/v1/image_to_video')) {
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
        res.end(JSON.stringify({ id: full.taskId, estimatedCost: { credits: full.cost } }));
        return;
      }

      if (req.method === 'GET' && path.startsWith('/v1/tasks/')) {
        state.gets++;
        if (full.echoAuth401 === 'status') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: `unauthorized: ${req.headers.authorization ?? ''}` }));
          return;
        }
        const requestedId = decodeURIComponent(path.slice('/v1/tasks/'.length));
        const id = full.statusId ?? requestedId;
        const status = full.statuses.length > 1 ? full.statuses.shift()! : full.statuses[0];
        const base = { id, createdAt: new Date().toISOString() };
        let payload: Record<string, unknown>;
        if (status === 'SUCCEEDED') {
          payload = { ...base, status, cost: { credits: full.finalCost }, output: [`${baseUrl()}/media/${id}.mp4`] };
        } else if (status === 'FAILED') {
          payload = { ...base, status, cost: { credits: 0 }, failure: 'content moderation', failureCode: 'SAFETY' };
        } else if (status === 'CANCELLED') {
          payload = { ...base, status, cost: { credits: 0 } };
        } else {
          payload = { ...base, status, estimatedCost: { credits: full.cost } };
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
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
    mediaUrl: id => `${baseUrl()}/media/${id}.mp4`,
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
  assert.equal(runwayCapabilities.capabilityScope, 'protocol');
  assert.equal('model' in runwayCapabilities, false, 'the transport must not name a default model');
  assert.equal('durationSeconds' in runwayCapabilities, false, 'model-owned limits belong to the model definition');
  assert.equal('ratios' in runwayCapabilities, false, 'model-owned limits belong to the model definition');
  assert.equal('outputFormats' in runwayCapabilities, false, 'model-owned limits belong to the model definition');
  assert.equal(runwayCapabilities.modality, 'text-to-video | image-to-video');
  assert.equal(runwayCapabilities.textOnly, false);
  assert.deepEqual(runwayCapabilities.promptImage.formats, ['image/png', 'image/jpeg']);
  assert.equal(runwayCapabilities.promptImage.position, 'first');
  assert.equal(runwayCapabilities.supportsTailFrame, false);
  assert.equal(runwayCapabilities.supportsVideoReference, false);
  assert.equal(runwayCapabilities.supportsVideoEditing, false);
  assert.equal(runwayCapabilities.supportsHostedUpload, false);
  assert.equal(
    runwayCapabilities.supportsIdempotencyKeyLookup,
    false,
    'no idempotency lookup is verified, so unknown submits must block',
  );
  assert.equal(runwayCapabilities.accountAvailability, 'unknown');
  assert.equal(runwayCapabilities.productionBaseUrl, 'https://api.dev.runwayml.com');
});

test('test-only base must be loopback http; non-local overrides are refused', async () => {
  await withRoot(async root => {
    await assert.rejects(
      () =>
        generateRunway(root, source('att_bad_base'), OUTPUT, 'build/a.mp4', {
          testOnly: { baseUrl: 'http://example.com' },
        }),
      /loopback/i,
    );
    await assert.rejects(
      () =>
        generateRunway(root, source('att_bad_scheme'), OUTPUT, 'build/a.mp4', {
          testOnly: { baseUrl: 'https://127.0.0.1:8443' },
        }),
      /plain http|loopback/i,
    );
    assert.ok(!existsSync(join(root, '.viscraft', 'jobs', 'runway')));
  });
});

test('an out-of-contract source is rejected by canonical validation before any request', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      const bad = source('att_bad_contract', { parameters: { ...DEFAULT_PARAMETERS, durationSeconds: 20 } });
      await assert.rejects(
        () => generateRunway(root, bad, OUTPUT, 'build/b.mp4', { testOnly: { baseUrl: fixture.baseUrl } }),
        /invalid gen4\.5 parameters/i,
      );
      assert.equal(fixture.state.submits, 0, 'an invalid source must not reach the provider');
    });
  });
});

/** A production-shaped Endpoint. No request is ever sent in these tests: the
 * authorization/credential gate refuses first, which is the point. */
const PRODUCTION_URL = 'https://api.dev.runwayml.com';

test('production submit is gated on explicit authorization and a key, before any job or request', async () => {
  await withRoot(async root => {
    const previous = process.env.RUNWAYML_API_SECRET;
    delete process.env.RUNWAYML_API_SECRET;
    try {
      // No authorization at all.
      await assert.rejects(
        () =>
          generateRunway(root, source('att_noauth'), OUTPUT, 'build/a.mp4', {
            endpoint: { protocol: 'runway-v1' as const, baseUrl: PRODUCTION_URL },
          }),
        /authorization/i,
      );
      // Authorization given, but no key available.
      await assert.rejects(
        () =>
          generateRunway(root, source('att_nokey'), OUTPUT, 'build/a.mp4', {
            endpoint: { protocol: 'runway-v1' as const, baseUrl: PRODUCTION_URL },
            authorization: { submit: true },
          }),
        /API key/i,
      );
    } finally {
      if (previous !== undefined) process.env.RUNWAYML_API_SECRET = previous;
    }
    // The gate runs before the pre-submit record is written (the attempt lock is released).
    assert.ok(!existsSync(join(root, JOB_FILE_REL('att_noauth'))));
    assert.ok(!existsSync(join(root, JOB_FILE_REL('att_nokey'))));
  });
});

test('real transport: PENDING -> RUNNING -> SUCCEEDED produces normalized media with a single submit', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      const options = { testOnly: { baseUrl: fixture.baseUrl } };
      fixture.config.statuses = ['PENDING', 'RUNNING', 'SUCCEEDED'];

      const pending = await generateRunway(root, source('att_ok'), OUTPUT, 'build/take.mp4', options).then(
        () => null,
        (e: unknown) => e as { name: string; recoverable?: boolean },
      );
      assert.ok(pending, 'first invocation is pending');
      assert.equal(pending.name, 'RunwayPendingError');
      assert.equal(pending.recoverable, true);

      const running = await generateRunway(root, source('att_ok'), OUTPUT, 'build/take.mp4', options).then(
        () => null,
        (e: unknown) => e as { name: string },
      );
      assert.ok(running, 'second invocation still running');
      assert.equal(running.name, 'RunwayPendingError');

      const result = await generateRunway(root, source('att_ok'), OUTPUT, 'build/take.mp4', options);
      assert.equal(result.backend, 'runway-gen4.5');

      // Portable provider provenance is returned for a success (no URLs / secrets / invented cost).
      assert.ok(result.generation, 'success must populate generation provenance');
      assert.equal(result.generation.provider, 'runway');
      assert.equal(result.generation.model, 'gen4.5');
      assert.equal(result.generation.taskId, 'task_fixture_1');
      assert.equal(result.generation.estimatedCredits, 12);
      assert.equal(result.generation.finalCredits, 10);
      assert.ok(!JSON.stringify(result.generation).includes('http'), 'generation must not embed remote URLs');
      assert.ok(!JSON.stringify(result.generation).includes('sk-test'), 'generation must not embed secrets');

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
      assert.equal(job.taskId, 'task_fixture_1');
      assert.equal(job.estimatedCostCredits, 12);
      assert.equal(job.finalCostCredits, 10);
      assert.equal(job.originalMediaSha256, await hashFile(original));
      assert.equal(job.artifactSha256, await hashFile(join(root, 'build', 'take.mp4')));
      assert.equal(job.artifactPath, 'build/take.mp4');

      // Exactly one submit, one download, and one status GET per invocation.
      assert.equal(fixture.state.submits, 1);
      assert.equal(fixture.state.downloads, 1);
      assert.equal(fixture.state.gets, 3);

      // The submit used the documented wire contract.
      const submit = fixture.state.requests.find(r => r.method === 'POST');
      assert.ok(submit);
      assert.equal(submit.version, '2024-11-06');
      // The caller's real key is NEVER forwarded to the loopback fixture.
      assert.equal(submit.authorization, 'Bearer fixture-test-only');
      assert.ok(
        !fixture.state.requests.some(r => (r.authorization ?? '').includes('sk-test-runway-SECRET')),
        'the caller key must never reach the fixture',
      );
      const body = JSON.parse(submit.body) as Record<string, unknown>;
      assert.equal(body.model, 'gen4.5');
      assert.equal(body.duration, 4);
      assert.equal(body.ratio, '1280:720');
      assert.equal(body.seed, 7);
      assert.equal(typeof body.promptText, 'string');

      // Restoring a succeeded job must not touch the network or resubmit.
      const before = fixture.state;
      const restored = await generateRunway(root, source('att_ok'), OUTPUT, 'exports/again.mp4', options);
      assert.ok(existsSync(join(root, 'exports', 'again.mp4')));
      assert.equal(restored.generation?.taskId, 'task_fixture_1', 'a local restore still reports provider provenance');
      assert.equal(before.submits, 1);
      assert.equal(before.gets, 3);
      assert.equal(before.downloads, 1);

      // No secrets and no remote URLs persisted.
      const raw = await readFile(join(root, JOB_FILE_REL('att_ok')), 'utf8');
      assert.ok(!raw.includes('sk-test-runway-SECRET-do-not-persist'), 'api key must never be persisted');
      assert.ok(!raw.includes('http://'), 'remote URLs must never be persisted');
      assert.ok(!raw.includes('promptText'), 'raw prompt must never be persisted');
      assert.equal(typeof job.promptHash, 'string');

      const listed = (await runwayStatus(root)) as Array<Record<string, unknown>>;
      assert.equal(listed.length, 1);
      assert.equal(listed[0].attempt, 'att_ok');
    });
  });
});

test('a submitted Runway task resumes after its reference bytes are removed, without another POST', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      fixture.config.statuses = ['PENDING', 'SUCCEEDED'];
      await writePng(join(root, 'assets'), 'hero.png', 64);
      const asset = imageAsset('hero', 'assets/hero.png', await hashFile(join(root, 'assets', 'hero.png')));
      const referencePath = join(root, 'assets', 'hero.png');
      const originalBytes = await readFile(referencePath);
      const src = source('att_missing_ref_resume', { mode: 'first-last-frame', references: firstFrame('hero') });
      const options = { testOnly: { baseUrl: fixture.baseUrl }, references: [{ asset, root }] };
      await assert.rejects(generateRunway(root, src, OUTPUT, 'build/resume.mp4', options), /pending/i);
      assert.equal(fixture.state.submits, 1);
      const getsBefore = fixture.state.gets;
      await writeFile(referencePath, Buffer.from('changed but still present'));
      await assert.rejects(
        generateRunway(root, src, OUTPUT, 'build/changed.mp4', options),
        /bytes do not match its recorded sha256/i,
      );
      assert.equal(fixture.state.gets, getsBefore, 'mismatched bytes are refused before a task GET');
      assert.equal(fixture.state.submits, 1, 'mismatched bytes never resubmit');
      await writeFile(referencePath, originalBytes);
      await rm(referencePath);
      await assert.rejects(
        generateRunway(root, { ...src, seed: 8 }, OUTPUT, 'build/resume.mp4', options),
        /different frozen request/i,
      );
      assert.equal(fixture.state.gets, getsBefore, 'changed identity is rejected before a task GET');
      await generateRunway(root, src, OUTPUT, 'build/resume.mp4', options);
      assert.equal(fixture.state.submits, 1, 'resuming an accepted task never submits again');
      assert.equal(fixture.state.gets, getsBefore + 1, 'valid resume only queries the existing task');
      assert.equal((await readJob(root, 'att_missing_ref_resume')).submitted, 1);
      assert.ok(existsSync(join(root, 'build', 'resume.mp4')));
      await writeFile(referencePath, Buffer.from('changed after task success'));
      await assert.rejects(
        generateRunway(root, src, OUTPUT, 'build/local-changed.mp4', options),
        /bytes do not match its recorded sha256/i,
      );
      assert.equal(fixture.state.submits, 1, 'a mismatched Asset cannot bypass local success identity checks');
      await rm(referencePath);
      await generateRunway(root, src, OUTPUT, 'build/local-restored.mp4', options);
      assert.equal(fixture.state.submits, 1, 'a missing original reference remains locally restorable');
    });
  });
});

test('a failed download resumes without resubmitting', async () => {
  await withRoot(async root => {
    await withFixture(
      async fixture => {
        const options = { testOnly: { baseUrl: fixture.baseUrl } };
        await assert.rejects(
          () => generateRunway(root, source('att_dl'), OUTPUT, 'build/dl.mp4', options),
          /download failed/i,
        );
        const first = await readJob(root, 'att_dl');
        assert.equal(first.state, 'download-failed');
        assert.equal(first.submitted, 1);
        assert.ok(!existsSync(join(root, 'build', 'dl.mp4')));

        await generateRunway(root, source('att_dl'), OUTPUT, 'build/dl.mp4', options);
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

test('an ambiguous submit never resubmits and blocks further attempts', async () => {
  for (const submit of ['network', 'http500', 'malformed'] as const) {
    await withRoot(async root => {
      await withFixture(
        async fixture => {
          const options = { testOnly: { baseUrl: fixture.baseUrl } };
          await assert.rejects(
            () => generateRunway(root, source(`att_unknown_${submit}`), OUTPUT, 'build/u.mp4', options),
            /unknown/i,
          );
          const first = await readJob(root, `att_unknown_${submit}`);
          assert.equal(first.state, 'submit-unknown');
          assert.equal(first.submitted, 1);

          await assert.rejects(
            () => generateRunway(root, source(`att_unknown_${submit}`), OUTPUT, 'build/u.mp4', options),
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

test('failed and cancelled tasks are terminal, carry real cost, and never resubmit', async () => {
  await withRoot(async root => {
    await withFixture(
      async fixture => {
        const options = { testOnly: { baseUrl: fixture.baseUrl } };
        await assert.rejects(() => generateRunway(root, source('att_fail'), OUTPUT, 'build/f.mp4', options), /failed/i);
        const failed = await readJob(root, 'att_fail');
        assert.equal(failed.state, 'failed');
        assert.equal(failed.finalCostCredits, 0, 'a provider-reported zero cost is recorded, never invented');
        await assert.rejects(
          () => generateRunway(root, source('att_fail'), OUTPUT, 'build/f.mp4', options),
          /permanent|not resubmitting/i,
        );
        assert.equal(fixture.state.submits, 1);
      },
      { statuses: ['FAILED'] },
    );
  });

  await withRoot(async root => {
    await withFixture(
      async fixture => {
        const options = { testOnly: { baseUrl: fixture.baseUrl } };
        await assert.rejects(
          () => generateRunway(root, source('att_cancel'), OUTPUT, 'build/c.mp4', options),
          /cancel/i,
        );
        const cancelled = await readJob(root, 'att_cancel');
        assert.equal(cancelled.state, 'cancelled');
        await assert.rejects(
          () => generateRunway(root, source('att_cancel'), OUTPUT, 'build/c.mp4', options),
          /cancel/i,
        );
        assert.equal(fixture.state.submits, 1);
      },
      { statuses: ['CANCELLED'] },
    );
  });
});

test('the task id must match the persisted task; a mismatched status id is refused', async () => {
  await withRoot(async root => {
    await withFixture(
      async fixture => {
        const options = { testOnly: { baseUrl: fixture.baseUrl } };
        await assert.rejects(
          () => generateRunway(root, source('att_mismatch'), OUTPUT, 'build/m.mp4', options),
          /does not match/i,
        );
        const job = await readJob(root, 'att_mismatch');
        assert.equal(job.submitted, 1);
        assert.notEqual(job.state, 'succeeded');
      },
      { taskId: 'task_real', statusId: 'task_other', statuses: ['RUNNING'] },
    );
  });
});

test('reusing an attempt id with changed parameters is rejected before any request', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      const options = { testOnly: { baseUrl: fixture.baseUrl } };
      await generateRunway(root, source('att_conflict'), OUTPUT, 'build/c.mp4', options);
      const before = fixture.state.submits;
      await assert.rejects(
        () =>
          generateRunway(
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
      assert.equal((job.parameters as Record<string, unknown>).durationSeconds, 4);
      assert.equal(job.submitted, 1);
    });
  });
});

test('destinations that escape the project root are rejected', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      const options = { testOnly: { baseUrl: fixture.baseUrl } };
      await assert.rejects(
        () => generateRunway(root, source('att_esc'), OUTPUT, '../escape.mp4', options),
        /escapes|safe project-relative/i,
      );
      assert.ok(!existsSync(join(root, '..', 'escape.mp4')));
      assert.equal(fixture.state.submits, 0);
    });
  });
});

test('test-only transport never reads or forwards the real key', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      const previous = process.env.RUNWAYML_API_SECRET;
      process.env.RUNWAYML_API_SECRET = 'sk-env-REAL-must-not-leak';
      try {
        await generateRunway(root, source('att_key'), OUTPUT, 'build/k.mp4', {
          testOnly: { baseUrl: fixture.baseUrl },
        });
      } finally {
        if (previous === undefined) delete process.env.RUNWAYML_API_SECRET;
        else process.env.RUNWAYML_API_SECRET = previous;
      }
      for (const request of fixture.state.requests) {
        assert.ok(
          !(request.authorization ?? '').includes('sk-env-REAL'),
          'the environment key must never reach the fixture',
        );
      }
      const raw = await readFile(join(root, JOB_FILE_REL('att_key')), 'utf8');
      assert.ok(!raw.includes('sk-env-REAL'), 'the environment key must never be persisted');
    });
  });
});

test('a hostile provider echoing the Authorization header cannot leak a key into an error or any persisted file', async () => {
  const KEY = 'sk-test-runway-SECRET-do-not-persist';
  const previous = process.env.RUNWAYML_API_SECRET;
  process.env.RUNWAYML_API_SECRET = KEY;
  try {
    for (const where of ['submit', 'status'] as const) {
      await withRoot(async root => {
        await withFixture(
          async fixture => {
            const attempt = `att_leak_${where}`;
            const options = { testOnly: { baseUrl: fixture.baseUrl } };

            const error = await generateRunway(root, source(attempt), OUTPUT, 'build/leak.mp4', options).then(
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
              assert.equal(value, 'Bearer fixture-test-only', 'test mode sends only the fixed non-secret credential');
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
    if (previous === undefined) delete process.env.RUNWAYML_API_SECRET;
    else process.env.RUNWAYML_API_SECRET = previous;
  }
});

test('a held per-attempt lock refuses a concurrent generation of the same attempt', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      const options = { testOnly: { baseUrl: fixture.baseUrl } };
      const lockDir = join(root, '.viscraft', 'jobs', 'runway');
      await mkdir(lockDir, { recursive: true });
      await writeFile(join(lockDir, 's_att_lock.att_lock.lock'), 'held by another run\n');

      await assert.rejects(
        () => generateRunway(root, source('att_lock'), OUTPUT, 'build/l.mp4', options),
        /already being generated|concurrently/i,
      );
      assert.equal(fixture.state.submits, 0, 'a locked attempt must not contact the provider');
      assert.ok(!existsSync(join(root, JOB_FILE_REL('att_lock'))), 'no job record is written while locked');
    });
  });
});

// ---------------------------------------------------------------------------
// Image-conditioned production (approved hero image -> first-frame video)
// ---------------------------------------------------------------------------

test('image-conditioned request uploads the approved Asset as a hashed PNG data URI and persists only its hash', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      await writePng(join(root, 'assets'), 'hero.png', 64);
      const sha256 = await hashFile(join(root, 'assets', 'hero.png'));
      const asset = imageAsset('hero', 'assets/hero.png', sha256);
      const src = source('att_img', { mode: 'first-last-frame', references: firstFrame('hero') });
      const options = { testOnly: { baseUrl: fixture.baseUrl }, references: [{ asset, root }] };

      const result = await generateRunway(root, src, OUTPUT, 'build/img.mp4', options);
      assert.equal(result.backend, 'runway-gen4.5');
      assert.deepEqual(result.generation?.references, [
        { asset: 'hero', sha256, category: 'image', role: 'first-frame' },
      ]);

      // The POST went to the documented image endpoint with a decodable PNG data URI.
      const submit = fixture.state.requests.find(r => r.method === 'POST');
      assert.ok(submit);
      assert.equal(submit.path, '/v1/image_to_video');
      assert.equal(submit.version, '2024-11-06');
      assert.equal(submit.authorization, 'Bearer fixture-test-only', 'test mode must never forward a real key');
      const body = JSON.parse(submit.body) as Record<string, unknown>;
      assert.equal(body.model, 'gen4.5');
      assert.equal(body.promptText, src.prompt);
      assert.equal(body.duration, 4);
      assert.equal(body.ratio, '1280:720');
      assert.equal(body.seed, 7);
      const dataUri = String(body.promptImage);
      assert.match(dataUri, /^data:image\/png;base64,/);
      const decoded = Buffer.from(dataUri.slice(dataUri.indexOf(',') + 1), 'base64');
      assert.equal(
        createHash('sha256').update(decoded).digest('hex'),
        sha256,
        'the exact uploaded bytes must hash to the approved Asset',
      );

      // The job records provenance only — never bytes, a data URI or the prompt.
      const job = await readJob(root, 'att_img');
      assert.equal(job.mode, 'test');
      assert.equal(job.modality, 'image-to-video');
      assert.deepEqual(job.image, { id: 'hero', sha256, type: 'image' });
      const raw = await readFile(join(root, JOB_FILE_REL('att_img')), 'utf8');
      assert.ok(!raw.includes('data:image/'), 'no image data URI may be persisted');
      assert.ok(!raw.includes(decoded.toString('base64').slice(0, 64)), 'no image bytes may be persisted');
      assert.ok(!raw.includes('promptText'), 'the raw prompt must never be persisted');

      // A local restore of the succeeded job still reports image provenance.
      const restored = await generateRunway(root, src, OUTPUT, 'exports/again.mp4', options);
      assert.deepEqual(restored.generation?.references, [
        { asset: 'hero', sha256, category: 'image', role: 'first-frame' },
      ]);
      assert.equal(fixture.state.submits, 1);
    });
  });
});

test('a text-only generation records text modality and no image provenance', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      const result = await generateRunway(root, source('att_text_modality'), OUTPUT, 'build/t.mp4', {
        testOnly: { baseUrl: fixture.baseUrl },
      });
      assert.deepEqual(result.generation?.references, []);
      const job = await readJob(root, 'att_text_modality');
      assert.equal(job.modality, 'text-to-video');
      assert.equal(job.image, undefined);
      const submit = fixture.state.requests.find(r => r.method === 'POST');
      assert.ok(submit);
      assert.equal(submit.path, '/v1/text_to_video');
      assert.equal(JSON.parse(submit.body).promptImage, undefined);
    });
  });
});

test('a first-frame source with no matching approved Asset is rejected before any work', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      await assert.rejects(
        () =>
          generateRunway(
            root,
            source('att_img_missing', { mode: 'first-last-frame', references: firstFrame('hero') }),
            OUTPUT,
            'build/m.mp4',
            { testOnly: { baseUrl: fixture.baseUrl } },
          ),
        /no matching options\.references|reference image/i,
      );
      assert.equal(fixture.state.submits, 0);
      assert.ok(!existsSync(join(root, JOB_FILE_REL('att_img_missing'))));
    });
  });
});

test('a non-PNG/JPEG reference image (SVG) is refused rather than converted', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>';
      await mkdir(join(root, 'assets'), { recursive: true });
      await writeFile(join(root, 'assets', 'hero.svg'), svg);
      const sha256 = await hashFile(join(root, 'assets', 'hero.svg'));
      const asset = imageAsset('hero', 'assets/hero.svg', sha256);
      await assert.rejects(
        () =>
          generateRunway(
            root,
            source('att_svg', { mode: 'first-last-frame', references: firstFrame('hero') }),
            OUTPUT,
            'build/s.mp4',
            { testOnly: { baseUrl: fixture.baseUrl }, references: [{ asset, root }] },
          ),
        /PNG or JPEG|signature/i,
      );
      assert.equal(fixture.state.submits, 0, 'an unconvertible image must never reach the provider');
      assert.ok(!existsSync(join(root, JOB_FILE_REL('att_svg'))));
    });
  });
});

test('production image upload needs explicit per-Asset consent; a redistributable license is never consent', async () => {
  await withRoot(async root => {
    await writePng(join(root, 'assets'), 'hero.png', 64);
    const sha256 = await hashFile(join(root, 'assets', 'hero.png'));
    const asset = imageAsset('hero', 'assets/hero.png', sha256, true);
    const src = source('att_upload_auth', { mode: 'first-last-frame', references: firstFrame('hero') });

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    const previousKey = process.env.RUNWAYML_API_SECRET;
    process.env.RUNWAYML_API_SECRET = 'sk-dummy-not-a-real-key';
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error('network must not be reached without upload consent');
    }) as typeof fetch;
    try {
      await assert.rejects(
        () =>
          generateRunway(root, src, OUTPUT, 'build/a.mp4', {
            endpoint: { protocol: 'runway-v1' as const, baseUrl: PRODUCTION_URL },
            authorization: { submit: true },
            references: [{ asset, root }],
          }),
        /upload|authorization/i,
      );
      assert.equal(fetchCalls, 0, 'no network call may be attempted without upload consent');
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.RUNWAYML_API_SECRET;
      else process.env.RUNWAYML_API_SECRET = previousKey;
    }
    assert.ok(
      !existsSync(join(root, JOB_FILE_REL('att_upload_auth'))),
      'no job record is written without upload consent',
    );
  });
});

test('reusing an attempt with a changed reference image is rejected before any new POST', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      await writePng(join(root, 'assets'), 'hero.png', 64);
      const sha256 = await hashFile(join(root, 'assets', 'hero.png'));
      const asset = imageAsset('hero', 'assets/hero.png', sha256);
      const options = { testOnly: { baseUrl: fixture.baseUrl }, references: [{ asset, root }] };
      const imageSource = (assetId: string) =>
        source('att_img_change', { mode: 'first-last-frame', references: firstFrame(assetId) });
      await generateRunway(root, imageSource('hero'), OUTPUT, 'build/c.mp4', options);
      assert.equal(fixture.state.submits, 1);

      // Same attempt: the image content (and its hash) changed.
      await writePng(join(root, 'assets'), 'hero.png', 96);
      const changedSha = await hashFile(join(root, 'assets', 'hero.png'));
      assert.notEqual(changedSha, sha256);
      await assert.rejects(
        () =>
          generateRunway(root, imageSource('hero'), OUTPUT, 'build/c2.mp4', {
            ...options,
            references: [{ asset: imageAsset('hero', 'assets/hero.png', changedSha), root }],
          }),
        /different frozen request|new attempt/i,
      );

      // Same attempt: the referenced Asset id changed.
      await assert.rejects(
        () =>
          generateRunway(root, imageSource('hero2'), OUTPUT, 'build/c3.mp4', {
            ...options,
            references: [{ asset: imageAsset('hero2', 'assets/hero.png', changedSha), root }],
          }),
        /different frozen request|new attempt/i,
      );
      assert.equal(fixture.state.submits, 1, 'a changed reference image must be rejected before any new POST');
      const job = await readJob(root, 'att_img_change');
      assert.deepEqual(job.image, { id: 'hero', sha256, type: 'image' });
    });
  });
});

// ---------------------------------------------------------------------------
// gen4.5 request fidelity (ratio / outputFormat / contentModeration)
// ---------------------------------------------------------------------------
// The model profile owns the gen4.5 request limits: the image-to-video-only
// ratios need a first-frame image, and `proresProfile` needs `outputFormat:
// 'prores'`. These run BEFORE any job record or network call, so a rejection is
// loud and the fixture records no submit POST.

test('a text-only source may not use an image-to-video-only ratio; rejected before any POST', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      await assert.rejects(
        () =>
          generateRunway(
            root,
            source('att_txt_ratio', { parameters: { ...DEFAULT_PARAMETERS, ratio: '1104:832' } }),
            OUTPUT,
            'build/r.mp4',
            { testOnly: { baseUrl: fixture.baseUrl } },
          ),
        /first-frame image/,
      );
      assert.equal(fixture.state.submits, 0, 'a text-only ratio violation must be caught before any submit POST');
    });
  });
});

test('an image-to-video source may use the extended ratios; the ratio reaches the body', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      await writePng(join(root, 'assets'), 'hero.png', 64);
      const sha256 = await hashFile(join(root, 'assets', 'hero.png'));
      const asset = imageAsset('hero', 'assets/hero.png', sha256);
      const src = source('att_img_ratio', {
        mode: 'first-last-frame',
        references: firstFrame('hero'),
        parameters: { ...DEFAULT_PARAMETERS, ratio: '1104:832' },
      });

      const result = await generateRunway(root, src, OUTPUT, 'build/ir.mp4', {
        testOnly: { baseUrl: fixture.baseUrl },
        references: [{ asset, root }],
      });
      assert.equal(result.backend, 'runway-gen4.5');

      const submit = fixture.state.requests.find(r => r.method === 'POST');
      assert.ok(submit);
      assert.equal(submit.path, '/v1/image_to_video');
      const body = JSON.parse(submit.body) as Record<string, unknown>;
      assert.equal(body.ratio, '1104:832');
    });
  });
});

test('proresProfile requires outputFormat prores; a valid prores request reaches the body', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      const options = { testOnly: { baseUrl: fixture.baseUrl } };
      await assert.rejects(
        () =>
          generateRunway(
            root,
            source('att_prores_bad', { parameters: { ...DEFAULT_PARAMETERS, proresProfile: '422 HQ' } }),
            OUTPUT,
            'build/p.mp4',
            options,
          ),
        /only valid when outputFormat is 'prores'/,
      );
      assert.equal(fixture.state.submits, 0, 'a proresProfile without outputFormat must not reach the provider');

      const result = await generateRunway(
        root,
        source('att_prores_ok', {
          parameters: { ...DEFAULT_PARAMETERS, outputFormat: 'prores', proresProfile: '422 HQ' },
        }),
        OUTPUT,
        'build/p2.mp4',
        options,
      );
      assert.equal(result.backend, 'runway-gen4.5');
      const submit = fixture.state.requests.find(r => r.method === 'POST');
      assert.ok(submit);
      const body = JSON.parse(submit.body) as Record<string, unknown>;
      assert.equal(body.outputFormat, 'prores');
      assert.equal(body.proresProfile, '422 HQ');
    });
  });
});

test('contentModeration is forwarded into the request body', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      await generateRunway(
        root,
        source('att_mod', {
          parameters: { ...DEFAULT_PARAMETERS, contentModeration: { publicFigureThreshold: 'low' } },
        }),
        OUTPUT,
        'build/mod.mp4',
        { testOnly: { baseUrl: fixture.baseUrl } },
      );
      const submit = fixture.state.requests.find(r => r.method === 'POST');
      assert.ok(submit);
      const body = JSON.parse(submit.body) as Record<string, unknown>;
      assert.deepEqual(body.contentModeration, { publicFigureThreshold: 'low' });
    });
  });
});

// ---------------------------------------------------------------------------
// A SECOND Runway model on the same service (gen4_turbo) through the ordinary
// entry: a model definition + service mapping + Endpoint binding only.
// ---------------------------------------------------------------------------
// `gen4_turbo` is IMAGE-TO-VIDEO ONLY and its `duration` is an optional number
// with no stated range (Runway Node SDK, commit a76ba47, Apache-2.0 — read only,
// no source reuse). This is a SIMULATED / test-only proof of the execution PATH
// (loopback fixture), NOT real model identity or generation quality.

function turboSource(attempt: string, overrides: SourceOverrides = {}): ProviderSource {
  const parameters = overrides.parameters ?? { ratio: '1280:720' };
  return {
    id: `s_${attempt}`,
    kind: 'provider',
    output: 'picture',
    endpoint: 'runway',
    model: 'gen4_turbo',
    prompt: overrides.prompt ?? 'an original vehicle on a mountain road, a slow push-in',
    mode: overrides.mode ?? 'first-last-frame',
    references: overrides.references ?? firstFrame('hero'),
    requestedFrames: 24,
    fps: 24,
    size: overrides.size ?? (parameters.ratio as string) ?? '1280:720',
    seed: overrides.seed ?? 7,
    attempt,
    parameters,
  };
}

/** A schema-valid Project with one shot/placement over the given Source. */
async function writeProjectFixture(root: string, source: ProviderSource, asset: Asset, frames: number): Promise<void> {
  const p = await createProject(root, { title: 'Runway second-model verification', output: OUTPUT });
  p.assets = [asset];
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

/**
 * A project-owned binding module that selects the packaged `gen4_turbo`
 * definition + mapping and declares ITS OWN bytes as the implementation file,
 * so mutating the module changes the extension's implementation identity.
 */
async function turboBinding(root: string): Promise<{ extension: GenerationExtension; modulePath: string }> {
  const runtime = new URL('../src/index.js', import.meta.url).href;
  const modulePath = join(root, 'gen4-turbo-binding.mjs');
  await writeFile(
    modulePath,
    `import { gen4TurboModel, gen4TurboMapping } from ${JSON.stringify(runtime)};\nexport function extension(file) { return { implementationFiles: [file], model: gen4TurboModel, mapping: gen4TurboMapping }; }\n`,
  );
  const module = (await import(pathToFileURL(modulePath).href)) as { extension(file: string): GenerationExtension };
  return { extension: module.extension(modulePath), modulePath };
}

test('a second Runway model (gen4_turbo) runs Plan/Build through the ordinary entry; its mapping emits the wire request and identity follows the implementation file', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      await writePng(join(root, 'assets'), 'hero.png', 64);
      const sha256 = await hashFile(join(root, 'assets', 'hero.png'));
      const asset = imageAsset('hero', 'assets/hero.png', sha256);
      const { extension, modulePath } = await turboBinding(root);
      const config = {
        endpoint: { protocol: 'runway-v1' as const, baseUrl: fixture.baseUrl },
        testOnly: { baseUrl: fixture.baseUrl },
        extension,
      };
      const buildOptions = { providers: { videoApi: { runway: config } } };
      const valid = turboSource('turbo-one', { parameters: { ratio: '720:1280', durationSeconds: 3 } });
      await writeProjectFixture(root, valid, asset, 24);

      // Plan is buildable with zero requests, using the SAME definition+mapping.
      const plan = await planBuild(root, buildOptions);
      assert.equal(plan.buildable, true, JSON.stringify(plan.blockers));
      assert.equal(fixture.state.submits, 0, 'Plan must not submit');

      const built = await buildProject(root, buildOptions);
      assert.equal(built.status, 'succeeded', built.error);
      assert.equal(built.result?.simulated, true);
      assert.equal(fixture.state.submits, 1);

      // The mapping actually emitted the gen4_turbo image-to-video wire request.
      const submit = fixture.state.requests.find(r => r.method === 'POST');
      assert.ok(submit);
      assert.equal(submit.path, '/v1/image_to_video');
      const body = JSON.parse(submit.body) as Record<string, unknown>;
      assert.equal(body.model, 'gen4_turbo');
      assert.equal(body.ratio, '720:1280');
      assert.equal(body.duration, 3);
      assert.equal(body.seed, 7);
      assert.equal(typeof body.promptText, 'string');
      const dataUri = String(body.promptImage);
      assert.match(dataUri, /^data:image\/png;base64,/);
      assert.equal(
        createHash('sha256')
          .update(Buffer.from(dataUri.slice(dataUri.indexOf(',') + 1), 'base64'))
          .digest('hex'),
        sha256,
        'the exact uploaded bytes must hash to the approved Asset',
      );
      // gen4.5-only mapping fields must not leak into the second model.
      assert.equal(body.outputFormat, undefined);
      assert.equal(body.proresProfile, undefined);

      const artifact = built.artifacts.find(item => item.generation)!;
      assert.equal(artifact.generation!.model, 'gen4_turbo');
      assert.match(artifact.generation!.extensionHash!, /^[a-f0-9]{64}$/);

      // An unchanged extension reuses the accepted Take with no second submit.
      const again = await buildProject(root, buildOptions);
      assert.equal(again.status, 'succeeded', again.error);
      assert.equal(fixture.state.submits, 1);
      assert.ok(again.operations.find(item => item.kind === 'provider')!.reused);

      // A cached Take does not make changed bytes under its declared Asset hash
      // current. Plan reports the stale input and Build rejects before reuse.
      const originalHero = await readFile(join(root, 'assets', 'hero.png'));
      await writeFile(join(root, 'assets', 'hero.png'), Buffer.from('replacement bytes at the same authored path'));
      const stalePlan = await planBuild(root, buildOptions);
      assert.ok(stalePlan.blockers.some(item => item.code === 'reference-media-changed'));
      await assert.rejects(() => buildProject(root, buildOptions), /do not match the recorded Asset digest/i);
      assert.equal(fixture.state.submits, 1, 'stale bytes cannot miss the cache and incur another submit');
      await writeFile(join(root, 'assets', 'hero.png'), originalHero);

      // An invalid gen4_turbo request (a ratio outside the documented union) is
      // blocked in Plan and rejected before any submit.
      const invalid = await loadProject(root);
      invalid.sources = [turboSource('turbo-one', { parameters: { ratio: '1920:1080' }, size: '1920:1080' })];
      await saveProject(root, invalid, invalid.revision);
      const invalidPlan = await planBuild(root, buildOptions);
      assert.equal(invalidPlan.buildable, false);
      // The attempt already produced this Take, so a changed ratio is refused as a
      // CHANGED REQUEST for a used attempt id — the accurate, actionable fact —
      // rather than re-validating a request the Build would never send.
      assert.ok(invalidPlan.blockers.some(item => item.code === 'provider-attempt-request-changed'));
      await assert.rejects(
        () =>
          generateRunway(
            root,
            turboSource('turbo-bad', { parameters: { ratio: '1920:1080' }, size: '1920:1080' }),
            OUTPUT,
            'build/bad.mp4',
            { ...config, references: [{ asset, root }] },
          ),
        /parameters/,
      );
      assert.equal(fixture.state.submits, 1, 'an invalid request must not reach the provider');

      // Mutating the declared implementation file changes the identity: reuse is
      // no longer predicted, and reusing the same attempt is rejected as a
      // different frozen request (no second submit).
      const restored = await loadProject(root);
      restored.sources = [valid];
      await saveProject(root, restored, restored.revision);
      await writeFile(
        modulePath,
        `${await readFile(modulePath, 'utf8')}\n// changed binding implementation identity\n`,
      );
      assert.equal(
        (await planBuild(root, buildOptions)).reuse.some(item => item.subject === valid.id),
        false,
      );
      await assert.rejects(
        () => generateRunway(root, valid, OUTPUT, 'build/again.mp4', { ...config, references: [{ asset, root }] }),
        /different frozen request/,
      );
      assert.equal(fixture.state.submits, 1);
    });
  });
});

test('Build rejects an unverified content-store reference before the first POST across multiple Sources', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      await writePng(join(root, 'assets'), 'hero.png', 64);
      const asset = imageAsset('hero', 'assets/hero.png', await hashFile(join(root, 'assets', 'hero.png')));
      const first = source('multi-first', { mode: 'text', references: [] });
      await writeProjectFixture(root, first, asset, 24);
      const project = await loadProject(root);
      const laterMissing = turboSource('multi-missing');
      project.sources.push(laterMissing);
      project.composition!.shots.push({
        id: 'shot-invalid',
        scene: 'scene',
        look: project.direction.looks[0]!.id,
        intent: 'second Source with a missing reference file',
        targetFrames: 24,
      });
      project.composition!.placements.push({
        id: 'cut-invalid',
        shot: 'shot-invalid',
        source: laterMissing.id,
        inFrame: 0,
        outFrame: 24,
        startFrame: 24,
        audio: 'mute',
      });
      await saveProject(root, project, project.revision);
      await rm(join(root, 'assets', 'hero.png'));
      await mkdir(join(root, '.viscraft', 'content'), { recursive: true });
      await writeFile(join(root, '.viscraft', 'content', asset.sha256), Buffer.from('corrupted content-store bytes'));
      const config = {
        endpoint: { protocol: 'runway-v1' as const, baseUrl: fixture.baseUrl },
        testOnly: { baseUrl: fixture.baseUrl },
      };
      let failure = '';
      await buildProject(root, { providers: { videoApi: { runway: config } } }).catch(error => {
        failure = error instanceof Error ? error.message : String(error);
      });
      assert.match(failure, /reference|authored bytes|unreadable/i, failure);
      assert.equal(
        fixture.state.submits,
        0,
        `the valid first Source must not submit before later missing-input preflight fails; Build error: ${failure}`,
      );
    });
  });
});

test('Build uses a valid content-store blob to freeze references before submitting multiple Sources', async () => {
  await withRoot(async root => {
    await withFixture(async fixture => {
      await writePng(join(root, 'assets'), 'hero.png', 64);
      const heroPath = join(root, 'assets', 'hero.png');
      const originalBytes = await readFile(heroPath);
      const asset = imageAsset('hero', 'assets/hero.png', await hashFile(heroPath));
      const first = source('store-first', { mode: 'text', references: [] });
      await writeProjectFixture(root, first, asset, 24);
      const project = await loadProject(root);
      const second = turboSource('store-second');
      project.sources.push(second);
      project.composition!.shots.push({
        id: 'shot-store-second',
        scene: 'scene',
        look: project.direction.looks[0]!.id,
        intent: 'reference restored from the verified Project content store',
        targetFrames: 24,
      });
      project.composition!.placements.push({
        id: 'cut-store-second',
        shot: 'shot-store-second',
        source: second.id,
        inFrame: 0,
        outFrame: 24,
        startFrame: 24,
        audio: 'mute',
      });
      await saveProject(root, project, project.revision);
      await mkdir(join(root, '.viscraft', 'content'), { recursive: true });
      await writeFile(join(root, '.viscraft', 'content', asset.sha256), originalBytes);
      await rm(heroPath);
      const config = {
        endpoint: { protocol: 'runway-v1' as const, baseUrl: fixture.baseUrl },
        testOnly: { baseUrl: fixture.baseUrl },
      };
      const built = await buildProject(root, { providers: { videoApi: { runway: config } } });
      assert.equal(built.status, 'succeeded', built.error);
      assert.equal(fixture.state.submits, 2, 'both requests may submit only after the verified snapshot is prepared');
      const restoredReference = await readFile(join(root, 'assets', 'hero.png')).catch(() => null);
      assert.equal(restoredReference, null, 'content-store recovery does not overwrite the authored path');
    });
  });
});

test('gen4_turbo resumes a failed download without resubmitting, and an ambiguous submit never resubmits', async () => {
  await withRoot(async root => {
    await withFixture(
      async fixture => {
        await writePng(join(root, 'assets'), 'hero.png', 64);
        const sha256 = await hashFile(join(root, 'assets', 'hero.png'));
        const asset = imageAsset('hero', 'assets/hero.png', sha256);
        const options = {
          testOnly: { baseUrl: fixture.baseUrl },
          extension: gen4TurboExtension(),
          references: [{ asset, root }],
        };
        const src = turboSource('turbo-dl', { parameters: { ratio: '1280:720', durationSeconds: 4 } });
        await assert.rejects(() => generateRunway(root, src, OUTPUT, 'build/dl.mp4', options), /download failed/i);
        assert.equal((await readJob(root, 'turbo-dl')).submitted, 1);
        await generateRunway(root, src, OUTPUT, 'build/dl.mp4', options);
        assert.equal((await readJob(root, 'turbo-dl')).state, 'succeeded');
        assert.equal(fixture.state.submits, 1, 'resuming the download must not submit again');
        assert.equal(fixture.state.downloads, 2);
      },
      { download: 'fail-once' },
    );
  });

  await withRoot(async root => {
    await withFixture(
      async fixture => {
        await writePng(join(root, 'assets'), 'hero.png', 64);
        const sha256 = await hashFile(join(root, 'assets', 'hero.png'));
        const asset = imageAsset('hero', 'assets/hero.png', sha256);
        const options = {
          testOnly: { baseUrl: fixture.baseUrl },
          extension: gen4TurboExtension(),
          references: [{ asset, root }],
        };
        const src = turboSource('turbo-unknown', { parameters: { ratio: '1280:720' } });
        await assert.rejects(() => generateRunway(root, src, OUTPUT, 'build/u.mp4', options), /unknown/i);
        await assert.rejects(() => generateRunway(root, src, OUTPUT, 'build/u.mp4', options), /unknown|not resubmit/i);
        assert.equal(fixture.state.submits, 1, 'an ambiguous submit must never be retried');
        assert.equal((await readJob(root, 'turbo-unknown')).submitted, 1);
      },
      { submit: 'network' },
    );
  });
});
