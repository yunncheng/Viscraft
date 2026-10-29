/** Real loopback HTTP and FFmpeg fixtures, never model inference.
 * testOnly cases carry simulated provenance. The normal-endpoint case only
 * exercises credential transport and cache reuse against the same fixture.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ProviderSource, Asset, OutputSettings } from '../src/core/schema.js';
import {
  generateVideoApi,
  videoApiStatus,
  VideoApiPendingError,
} from '../src/backends/providers/services/video-tasks.js';
import { minimaxH3Ref2vaExtension } from '../src/backends/providers/models/minimax-h3.js';
import { attemptStem } from '../src/backends/providers/job-store.js';
import { probeMedia } from '../src/backends/media/probe.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';

// Job records, per-attempt locks and retained provider media are keyed by the
// Source-scoped stem (`sourceId.attempt`). Every Source in this file has id 'motion'.
const stem = (attempt: string) => attemptStem('motion', attempt);
const jobRel = (attempt: string) => `.viscraft/jobs/video-api/${stem(attempt)}.json`;
const mediaRel = (attempt: string) => `.viscraft/provider-media/video-api-${stem(attempt)}.mp4`;

const OUTPUT: OutputSettings = {
  width: 96,
  height: 64,
  fps: { numerator: 24, denominator: 1 },
  sampleRate: 48000,
  channels: 2,
};
const source = (attempt: string, overrides: Partial<ProviderSource> = {}): ProviderSource => ({
  id: 'motion',
  kind: 'provider',
  output: 'picture',
  model: 'fixture-video',
  endpoint: 'default',
  prompt: 'SIMULATED PRIVATE PROMPT',
  mode: 'text',
  references: [],
  requestedFrames: 12,
  size: '96:64',
  fps: 12,
  steps: 3,
  seed: 9,
  attempt,
  ...overrides,
});
let mediaPromise: Promise<Buffer> | undefined;
async function media(): Promise<Buffer> {
  mediaPromise ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'viscraft-video-api-media-'));
    try {
      const path = join(dir, 'sample.mp4');
      await runCommand('ffmpeg', [
        '-y',
        '-v',
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
        path,
      ]);
      return await readFile(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })();
  return mediaPromise;
}
interface Part {
  name: string;
  filename?: string;
  data: Buffer;
}
function parts(body: Buffer, contentType: string): Part[] {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  assert.ok(boundary);
  const marker = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  const result: Part[] = [];
  let at = body.indexOf(marker);
  while (at >= 0) {
    const start = at + marker.length;
    const next = body.indexOf(marker, start);
    if (next < 0) break;
    const chunk = body.subarray(start + 2, next - 2);
    const split = chunk.indexOf('\r\n\r\n');
    const header = chunk.subarray(0, split).toString();
    const name = /name="([^"]+)"/.exec(header)?.[1];
    if (name) result.push({ name, filename: /filename="([^"]+)"/.exec(header)?.[1], data: chunk.subarray(split + 4) });
    at = next;
  }
  return result;
}
interface Fixture {
  baseUrl: string;
  posts: number;
  gets: number;
  downloads: number;
  captured: Part[];
  auth: string | undefined;
  status: 'queued' | 'in_progress' | 'completed';
  rejectSubmit: boolean;
  failDownload: boolean;
  downloadRedirect?: string;
}
async function fixture(fn: (f: Fixture, root: string) => Promise<void>): Promise<void> {
  const bytes = await media();
  const root = await mkdtemp(join(tmpdir(), 'viscraft-video-api-'));
  const f: Fixture = {
    baseUrl: '',
    posts: 0,
    gets: 0,
    downloads: 0,
    captured: [],
    auth: undefined,
    status: 'completed',
    rejectSubmit: false,
    failDownload: false,
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/videos') {
        f.posts++;
        f.auth = req.headers.authorization;
        f.captured = parts(Buffer.concat(chunks), req.headers['content-type'] ?? '');
        if (f.rejectSubmit) {
          req.socket.destroy();
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 'fixture_task', status: 'queued' }));
      } else if (req.url === '/v1/videos/fixture_task/content') {
        f.downloads++;
        if (f.downloadRedirect) {
          res.statusCode = 302;
          res.setHeader('location', f.downloadRedirect);
          res.end();
          return;
        }
        if (f.failDownload) {
          f.failDownload = false;
          res.statusCode = 503;
          res.end('retry later');
          return;
        }
        res.setHeader('content-type', 'video/mp4');
        res.end(bytes);
      } else if (req.url === '/v1/videos/fixture_task') {
        f.gets++;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 'fixture_task', status: f.status, error: null, inference_time_s: 0.1 }));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  f.baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await fn(f, root);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}
async function image(root: string): Promise<{ asset: Asset; root: string }> {
  await writeFile(join(root, 'video.mp4'), await media());
  await runCommand('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-i',
    join(root, 'video.mp4'),
    '-frames:v',
    '1',
    '-threads',
    '1',
    join(root, 'hero.png'),
  ]);
  return {
    root,
    asset: {
      id: 'hero',
      revision: 1,
      type: 'image',
      path: 'hero.png',
      sha256: await hashFile(join(root, 'hero.png')),
      rights: { origin: 'original test fixture', license: 'CC0-1.0', redistributable: true },
      simulated: false,
    },
  };
}

test('generic text-only API sends model and custom request settings, produces media and portable simulated provenance', async () => {
  await fixture(async (f, root) => {
    const result = await generateVideoApi(root, source('text_only'), OUTPUT, 'build/take.mp4', {
      testOnly: { baseUrl: f.baseUrl },
    });
    const fields = Object.fromEntries(f.captured.filter(p => !p.filename).map(p => [p.name, p.data.toString()]));
    assert.equal(fields.model, 'fixture-video');
    assert.equal(fields.num_frames, '12');
    assert.equal(fields.width, '96');
    assert.equal(fields.height, '64');
    assert.equal(fields.fps, '12');
    assert.equal(fields.num_inference_steps, '3');
    assert.equal(fields.seed, '9');
    assert.equal(fields.flow_shift, undefined, 'H3-specific flow shift must not leak to other models');
    assert.equal(f.captured.filter(p => p.filename).length, 0, 'text-only must not fabricate an image');
    assert.equal(f.auth, undefined);
    assert.equal(f.posts, 1);
    assert.equal(result.generation.provider, 'video-api');
    assert.equal(result.generation.model, 'fixture-video');
    assert.equal((await probeMedia(join(root, 'build/take.mp4'))).frames, 24, 'decoded output is authoritative');
    const jobs = (await videoApiStatus(root)) as Array<Record<string, unknown>>;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].simulated, true);
    const persisted = JSON.stringify(jobs);
    assert.ok(!persisted.includes('SIMULATED PRIVATE PROMPT'));
    assert.ok(!persisted.includes(f.baseUrl));
    assert.ok(existsSync(join(root, mediaRel('text_only'))));
  });
});

test('queued tasks resume without another submission and successful requests reuse normalized output', async () => {
  await fixture(async (f, root) => {
    const options = { testOnly: { baseUrl: f.baseUrl } };
    f.status = 'queued';
    await assert.rejects(
      () => generateVideoApi(root, source('resume'), OUTPUT, 'build/take.mp4', options),
      VideoApiPendingError,
    );
    f.status = 'in_progress';
    await assert.rejects(
      () => generateVideoApi(root, source('resume'), OUTPUT, 'build/take.mp4', options),
      VideoApiPendingError,
    );
    f.status = 'completed';
    await generateVideoApi(root, source('resume'), OUTPUT, 'build/take.mp4', options);
    await generateVideoApi(root, source('resume'), OUTPUT, 'build/take.mp4', options);
    assert.equal(f.posts, 1);
    assert.equal(f.gets, 3);
    assert.equal(f.downloads, 1);
  });
});

test('ambiguous submit remains submit-unknown and cannot be retried implicitly', async () => {
  await fixture(async (f, root) => {
    f.rejectSubmit = true;
    const options = { testOnly: { baseUrl: f.baseUrl } };
    await assert.rejects(() => generateVideoApi(root, source('unknown'), OUTPUT, 'build/take.mp4', options));
    assert.equal(((await videoApiStatus(root))[0] as Record<string, unknown>).state, 'submit-unknown');
    f.rejectSubmit = false;
    await assert.rejects(
      () => generateVideoApi(root, source('unknown'), OUTPUT, 'build/take.mp4', options),
      /unknown|uncertain|ambiguous|new attempt/i,
    );
    assert.equal(f.posts, 1);
    assert.equal(f.gets, 0);
  });
});

test('download failure resumes content retrieval without requerying or regenerating', async () => {
  await fixture(async (f, root) => {
    f.failDownload = true;
    const options = { testOnly: { baseUrl: f.baseUrl } };
    await assert.rejects(() => generateVideoApi(root, source('download'), OUTPUT, 'build/take.mp4', options));
    await generateVideoApi(root, source('download'), OUTPUT, 'build/take.mp4', options);
    assert.equal(f.posts, 1);
    assert.equal(f.gets, 1);
    assert.equal(f.downloads, 2);
  });
});

test('same attempt cannot change endpoint or model after submission', async () => {
  await fixture(async (f, root) => {
    const options = { testOnly: { baseUrl: f.baseUrl } };
    await generateVideoApi(root, source('frozen'), OUTPUT, 'build/take.mp4', options);
    for (const overrides of [{ model: 'different-video' }, { endpoint: 'different-binding' }]) {
      await assert.rejects(
        () => generateVideoApi(root, source('frozen', overrides), OUTPUT, 'build/take.mp4', options),
        /different frozen request|new attempt|request.*changed/i,
      );
    }
    await assert.rejects(
      () =>
        generateVideoApi(root, source('frozen'), OUTPUT, 'build/take.mp4', {
          testOnly: { baseUrl: 'http://127.0.0.1:1' },
        }),
      /different frozen request|new attempt|request.*changed/i,
    );
    assert.equal(f.posts, 1);
  });
});

test('missing endpoint, missing submission consent, missing asset consent and input hash mismatch fail before HTTP', async () => {
  await fixture(async (f, root) => {
    const endpoint = { protocol: 'vllm-omni-video' as const, baseUrl: f.baseUrl };
    await assert.rejects(
      () => generateVideoApi(root, source('missing_endpoint'), OUTPUT, 'build/take.mp4', {}),
      /endpoint|configuration/i,
    );
    await assert.rejects(
      () => generateVideoApi(root, source('no_submit'), OUTPUT, 'build/take.mp4', { endpoint }),
      /authorization|submit/i,
    );
    const missingKey = 'VISCRAFT_VIDEO_API_UNSET_FIXTURE_KEY';
    const previous = process.env[missingKey];
    delete process.env[missingKey];
    try {
      await assert.rejects(
        () =>
          generateVideoApi(root, source('no_credential'), OUTPUT, 'build/take.mp4', {
            endpoint: { ...endpoint, credential: missingKey },
            authorization: { submit: true },
          }),
        /credential|missing|invalid/i,
      );
      assert.ok(
        !existsSync(join(root, jobRel('no_credential'))),
        'invalid credential configuration must not create a job',
      );
    } finally {
      if (previous !== undefined) process.env[missingKey] = previous;
    }
    const hero = await image(root);
    const referenced = (attempt: string) =>
      source(attempt, { mode: 'reference', references: [{ asset: 'hero', category: 'image', role: 'identity' }] });
    await assert.rejects(
      () =>
        generateVideoApi(root, referenced('no_upload'), OUTPUT, 'build/take.mp4', {
          endpoint,
          authorization: { submit: true },
          references: [hero],
        }),
      /consent|uploadAssets/i,
    );
    await assert.rejects(
      () =>
        generateVideoApi(root, referenced('changed_input'), OUTPUT, 'build/take.mp4', {
          testOnly: { baseUrl: f.baseUrl },
          references: [{ ...hero, asset: { ...hero.asset, sha256: '0'.repeat(64) } }],
        }),
      /hash mismatch|do not match.*sha256/i,
    );
    assert.equal(f.posts, 0);
    assert.equal(f.gets, 0);
    assert.equal((await videoApiStatus(root)).length, 0);
  });
});

test('generic API preserves the known H3 model constraints instead of bypassing them', async () => {
  await fixture(async (f, root) => {
    // A MiniMax-H3 text-mode request cannot be verified against an undeclared
    // task partition and is refused with the real reason (not a fake capability).
    // H3 is opt-in: its definition/mapping is selected via the Endpoint extension.
    await assert.rejects(
      () =>
        generateVideoApi(root, source('h3_bad', { model: 'minimax-h3-base-ref2va' }), OUTPUT, 'build/take.mp4', {
          testOnly: { baseUrl: f.baseUrl },
          extension: minimaxH3Ref2vaExtension(),
        }),
      /FL2VA|text-only|taskType|reference/i,
    );
    assert.equal(f.posts, 0);
  });
});

test('test-only transport never reads or sends endpoint credentials', async () => {
  await fixture(async (f, root) => {
    const key = 'VISCRAFT_VIDEO_API_FIXTURE_KEY';
    const previous = process.env[key];
    process.env[key] = 'private-fixture-secret';
    try {
      await generateVideoApi(root, source('test_credentials'), OUTPUT, 'build/take.mp4', {
        testOnly: { baseUrl: f.baseUrl },
        endpoint: { protocol: 'vllm-omni-video', baseUrl: f.baseUrl, credential: key },
      });
      assert.equal(f.auth, undefined);
      const job = await readFile(join(root, jobRel('test_credentials')), 'utf8');
      assert.ok(!job.includes('private-fixture-secret'));
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });
});

test('configured API model alias and bearer key apply on the wire, while local cache reuse needs no credentials', async () => {
  await fixture(async (f, root) => {
    const key = 'VISCRAFT_VIDEO_API_ALIAS_KEY';
    const previous = process.env[key];
    process.env[key] = 'never-persist-this-fixture-key';
    const options = {
      endpoint: {
        protocol: 'vllm-omni-video' as const,
        baseUrl: f.baseUrl,
        model: 'deployed-model-alias',
        credential: key,
      },
      authorization: { submit: true },
    };
    try {
      await generateVideoApi(root, source('model_alias'), OUTPUT, 'build/take.mp4', options);
      assert.equal(f.captured.find(part => part.name === 'model')?.data.toString(), 'deployed-model-alias');
      assert.equal(f.auth, 'Bearer never-persist-this-fixture-key');
      const job = await readFile(join(root, jobRel('model_alias')), 'utf8');
      assert.ok(!job.includes('never-persist-this-fixture-key'));
      assert.ok(!job.includes(f.baseUrl));
      delete process.env[key];
      await generateVideoApi(root, source('model_alias'), OUTPUT, 'build/take.mp4', options);
      assert.equal(f.posts, 1);
      assert.equal(f.gets, 1);
      assert.equal(f.downloads, 1);
      await assert.rejects(
        () =>
          generateVideoApi(root, source('model_alias'), OUTPUT, 'build/take.mp4', {
            ...options,
            endpoint: { ...options.endpoint, model: 'different-alias' },
          }),
        /different frozen request|new attempt|request.*changed/i,
      );
      assert.equal(f.posts, 1);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });
});

test('known H3 profile supplies its defaults while the API transport remains generic', async () => {
  await fixture(async (f, root) => {
    const hero = await image(root);
    await generateVideoApi(
      root,
      source('h3_profile', {
        model: 'minimax-h3-base-ref2va',
        mode: 'reference',
        references: [{ asset: 'hero', category: 'image', role: 'identity' }],
        requestedFrames: 97,
        size: '768:768',
        fps: 24,
        steps: 30,
      }),
      OUTPUT,
      'build/take.mp4',
      { testOnly: { baseUrl: f.baseUrl }, extension: minimaxH3Ref2vaExtension(), references: [hero] },
    );
    const fields = Object.fromEntries(
      f.captured.filter(part => !part.filename).map(part => [part.name, part.data.toString()]),
    );
    assert.equal(fields.model, 'MiniMax-H3');
    assert.equal(fields.flow_shift, '12');
    assert.equal(fields.num_frames, '97');
    // The reference-mode task really reaches the wire now.
    assert.deepEqual(JSON.parse(fields.extra_params), { task: 'ref2va' });
    assert.equal(f.captured.filter(part => part.filename).length, 1);
    assert.equal(((await videoApiStatus(root))[0] as Record<string, unknown>).simulated, true);
  });
});

test('generic SDK recovery rejects changed present reference bytes before polling or local restoration', async () => {
  await fixture(async (f, root) => {
    const hero = await image(root);
    const referencePath = join(root, hero.asset.path);
    const originalBytes = await readFile(referencePath);
    const request = source('h3_changed_present_bytes', {
      model: 'minimax-h3-base-ref2va',
      mode: 'reference',
      references: [{ asset: 'hero', category: 'image', role: 'identity' }],
      requestedFrames: 97,
      size: '768:768',
      fps: 24,
      steps: 30,
    });
    const options = {
      testOnly: { baseUrl: f.baseUrl },
      extension: minimaxH3Ref2vaExtension(),
      references: [hero],
    };
    f.status = 'queued';
    await assert.rejects(
      generateVideoApi(root, request, OUTPUT, 'build/take.mp4', options),
      error => error instanceof VideoApiPendingError,
    );
    assert.equal(f.posts, 1);
    const getsBeforeChangedBytes = f.gets;
    const nonFilePath = join(root, 'reference-directory');
    await mkdir(nonFilePath);
    await assert.rejects(
      generateVideoApi(root, request, OUTPUT, 'build/directory.mp4', {
        ...options,
        references: [{ root, asset: { ...hero.asset, path: 'reference-directory' } }],
      }),
      /could not be read safely/i,
    );
    assert.equal(f.gets, getsBeforeChangedBytes, 'a non-file reference is not mistaken for a missing file');
    await writeFile(referencePath, Buffer.from('changed but still present'));
    await assert.rejects(
      generateVideoApi(root, request, OUTPUT, 'build/changed.mp4', options),
      /bytes do not match its recorded sha256/i,
    );
    assert.equal(f.gets, getsBeforeChangedBytes, 'mismatched bytes are rejected before task polling');
    assert.equal(f.posts, 1, 'mismatched bytes cannot start another task');

    await writeFile(referencePath, originalBytes);
    f.status = 'completed';
    await generateVideoApi(root, request, OUTPUT, 'build/take.mp4', options);
    assert.equal(f.posts, 1);
    const getsBeforeLocalRestore = f.gets;
    await writeFile(referencePath, Buffer.from('changed after success'));
    await assert.rejects(
      generateVideoApi(root, request, OUTPUT, 'build/local-changed.mp4', options),
      /bytes do not match its recorded sha256/i,
    );
    assert.equal(f.gets, getsBeforeLocalRestore, 'mismatched bytes are rejected before local success restore');
    assert.equal(f.posts, 1);
  });
});

test('invalid endpoint URLs and insecure remote transport fail before any request', async () => {
  await fixture(async (f, root) => {
    const invalid = [
      'not-a-url',
      'http://example.com',
      'http://localhost:8000',
      'ftp://127.0.0.1:8000',
      'https://user:secret@example.com',
      'https://example.com?api_key=secret',
      'https://example.com#secret',
    ];
    for (const [index, baseUrl] of invalid.entries()) {
      await assert.rejects(
        () =>
          generateVideoApi(root, source(`bad_url_${index}`), OUTPUT, 'build/take.mp4', {
            endpoint: { protocol: 'vllm-omni-video', baseUrl },
            authorization: { submit: true },
          }),
        /URL|HTTP|loopback|transport|credentials|query|fragment/i,
      );
    }
    // A remote HTTPS endpoint is permitted configuration, but authorization is
    // still required before any network operation (no external request here).
    await assert.rejects(
      () =>
        generateVideoApi(root, source('https_permitted'), OUTPUT, 'build/take.mp4', {
          endpoint: { protocol: 'vllm-omni-video', baseUrl: 'https://model.example/service' },
        }),
      /authorization/i,
    );
    assert.equal(f.posts, 0);
    assert.equal((await videoApiStatus(root)).length, 0);
  });
});

test('cross-origin media redirects are refused without forwarding credentials or making a second-origin request', async () => {
  await fixture(async (f, root) => {
    let foreignRequests = 0;
    const foreign = createServer((_req, res) => {
      foreignRequests++;
      res.end('must never be reached');
    });
    await new Promise<void>(resolve => foreign.listen(0, '127.0.0.1', resolve));
    const address = foreign.address();
    assert.ok(address && typeof address === 'object');
    const key = 'VISCRAFT_VIDEO_API_REDIRECT_KEY';
    const previous = process.env[key];
    process.env[key] = 'redirect-private-fixture-key';
    f.downloadRedirect = `http://127.0.0.1:${address.port}/video.mp4`;
    try {
      await assert.rejects(
        () =>
          generateVideoApi(root, source('redirect'), OUTPUT, 'build/take.mp4', {
            endpoint: { protocol: 'vllm-omni-video', baseUrl: f.baseUrl, credential: key },
            authorization: { submit: true },
          }),
        /same.*origin|download failed/i,
      );
      assert.equal(foreignRequests, 0, 'credentials must never reach a second origin');
      assert.equal(f.posts, 1);
      assert.equal(f.downloads, 1);
      const job = await readFile(join(root, jobRel('redirect')), 'utf8');
      assert.ok(!job.includes('redirect-private-fixture-key'));
      assert.ok(!job.includes(f.downloadRedirect));
      assert.ok(!existsSync(join(root, 'build/take.mp4')));
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
      await new Promise<void>(resolve => foreign.close(() => resolve()));
    }
  });
});

test('cached jobs cannot change model provenance or remove simulated labeling', async () => {
  await fixture(async (f, root) => {
    const options = { testOnly: { baseUrl: f.baseUrl } };
    await generateVideoApi(root, source('provenance'), OUTPUT, 'build/take.mp4', options);
    const path = join(root, jobRel('provenance'));
    const original = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(original.schemaVersion, 1);
    const unsupported = JSON.stringify({ ...original, schemaVersion: 99 });
    await writeFile(path, unsupported);
    await assert.rejects(
      () => generateVideoApi(root, source('provenance'), OUTPUT, 'build/take.mp4', options),
      /job record failed validation/,
    );
    assert.equal(
      await readFile(path, 'utf8'),
      unsupported,
      'unsupported state must remain intact, never be migrated or replaced',
    );
    assert.equal(f.posts, 1, 'unreadable state must never trigger another submission');
    for (const changes of [{ model: 'fabricated-model' }, { simulated: false }, { backend: 'fabricated-backend' }]) {
      await writeFile(path, JSON.stringify({ ...original, ...changes }));
      await assert.rejects(
        () => generateVideoApi(root, source('provenance'), OUTPUT, 'build/take.mp4', options),
        /different frozen request/,
      );
    }
    assert.equal(f.posts, 1);
    assert.equal(f.downloads, 1);
  });
});
