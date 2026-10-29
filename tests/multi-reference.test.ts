/**
 * Ordered multi-reference contract — freedom and boundaries — real local
 * transport, real media. No GPU, no paid service, no external network.
 *
 * Covers ordered references and service constraints:
 *  - a legal ordered multi-reference request succeeds through the full chain and
 *    transmits its references in the declared order;
 *  - an image-less video-reference request is accepted on the Ref2VA default;
 *    a genuinely unsupported mode (text / first-last-frame on a Ref2VA
 *    deployment) is refused with the real reason;
 *  - reordering, dropping, exceeding the 9/3/3/12 counts, audio-only, and
 *    missing per-Asset transmission consent each produce a distinct loud
 *    outcome (never a silent stale reuse);
 *  - a simulated reference taints the job (the marker propagates);
 *  - a recovered job is never resubmitted;
 *  - the image provider accepts ordered multi-references (routing to its
 *    image-carrying edits endpoint) and keeps a mask distinguishable.
 */
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Asset, OutputSettings, Reference, ProviderSource } from '../src/core/schema.js';
import {
  generateVideoApi as generateVideoApiRaw,
  videoApiStatus,
} from '../src/backends/providers/services/video-tasks.js';
import { generateImageApi } from '../src/backends/providers/services/vllm-omni/image-api.js';
import { minimaxH3Ref2vaExtension } from '../src/backends/providers/models/minimax-h3.js';
import { attemptStem } from '../src/backends/providers/job-store.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';

// Every video Source in this file is MiniMax-H3, and H3 is opt-in: select the
// packaged definition+mapping on every call so its counts/media/partition rules
// and its real wire task/frame semantics actually run.
type RawArgs = Parameters<typeof generateVideoApiRaw>;
const generateVideoApi = (
  root: RawArgs[0],
  src: RawArgs[1],
  out: RawArgs[2],
  dest: RawArgs[3],
  options: NonNullable<RawArgs[4]> = {},
) => generateVideoApiRaw(root, src, out, dest, { extension: minimaxH3Ref2vaExtension(), ...options });

const OUTPUT: OutputSettings = {
  width: 96,
  height: 64,
  fps: { numerator: 24, denominator: 1 },
  sampleRate: 48000,
  channels: 1,
};

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-multiref-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function makePng(dir: string, name: string, size = 64): Promise<void> {
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
async function makeMp4(file: string): Promise<void> {
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
    'testsrc2=size=640x360:rate=24:duration=2',
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    file,
  ]);
}
async function makeM4a(file: string): Promise<void> {
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
    'sine=frequency=440:duration=2',
    '-c:a',
    'aac',
    file,
  ]);
}

async function assetOf(
  root: string,
  id: string,
  rel: string,
  type: 'image' | 'video' | 'audio',
  simulated = false,
): Promise<Asset> {
  return {
    id,
    revision: 1,
    path: rel,
    sha256: await hashFile(join(root, rel)),
    type,
    rights: { origin: 'original FFmpeg fixture', license: 'CC0-1.0', redistributable: true },
    simulated,
  };
}

function ref(asset: string, category: Reference['category'], role: Reference['role']): Reference {
  return { asset, category, role };
}

function source(attempt: string, references: Reference[], overrides: Partial<ProviderSource> = {}): ProviderSource {
  const base: ProviderSource = {
    id: `s_${attempt}`,
    kind: 'provider',
    output: 'picture',
    endpoint: 'default',
    model: 'minimax-h3-base-ref2va',
    prompt: 'SIMULATED TEST-ONLY multi-reference',
    mode: 'reference',
    references,
    requestedFrames: 96,
    size: '768:768',
    fps: 24,
    steps: 30,
    seed: 7,
    attempt,
  };
  return { ...base, ...overrides } as ProviderSource;
}

interface Part {
  name: string;
  filename?: string;
  type?: string;
  data: Buffer;
}
function parseMultipart(
  body: Buffer,
  contentType: string | undefined,
): { fields: Record<string, string>; files: Part[] } {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  const result = { fields: {} as Record<string, string>, files: [] as Part[] };
  if (!match) return result;
  const boundary = Buffer.from(`--${(match[1] ?? match[2]).trim()}`, 'latin1');
  let index = body.indexOf(boundary);
  while (index !== -1) {
    const after = index + boundary.length;
    if (body.subarray(after, after + 2).toString('latin1') === '--') break;
    const next = body.indexOf(boundary, after + 2);
    if (next === -1) break;
    const part = body.subarray(after + 2, next);
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n', 'latin1'));
    if (headerEnd !== -1) {
      const header = part.subarray(0, headerEnd).toString('latin1');
      let data = part.subarray(headerEnd + 4);
      if (data.length >= 2 && data[data.length - 2] === 0x0d && data[data.length - 1] === 0x0a)
        data = data.subarray(0, data.length - 2);
      const name = /name="([^"]*)"/i.exec(header)?.[1];
      const filename = /filename="([^"]*)"/i.exec(header)?.[1];
      const type = /content-type:\s*([^\r\n]+)/i.exec(header)?.[1]?.trim();
      if (name !== undefined) {
        if (filename !== undefined) result.files.push({ name, filename, type, data: Buffer.from(data) });
        else result.fields[name] = data.toString('utf8');
      }
    }
    index = next;
  }
  return result;
}

interface Fixture {
  baseUrl: string;
  posts: number;
  statusGets: number;
  downloads: number;
  uploads: Part[];
  close: () => Promise<void>;
}

async function withVideoFixture(fn: (fixture: Fixture) => Promise<void>, media: Buffer): Promise<void> {
  const fixture: Fixture = { baseUrl: '', posts: 0, statusGets: 0, downloads: 0, uploads: [], close: async () => {} };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (req.method === 'POST' && path === '/v1/videos') {
        fixture.posts++;
        fixture.uploads = parseMultipart(Buffer.concat(chunks), req.headers['content-type']).files;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'job_multiref', status: 'queued', model: 'MiniMax-H3' }));
      } else if (req.method === 'GET' && path === '/v1/videos/job_multiref') {
        fixture.statusGets++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'job_multiref',
            status: 'completed',
            model: 'MiniMax-H3',
            error: null,
            inference_time_s: 1.5,
          }),
        );
      } else if (req.method === 'GET' && path === '/v1/videos/job_multiref/content') {
        fixture.downloads++;
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(media.length) });
        res.end(media);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  fixture.baseUrl = `http://127.0.0.1:${address.port}`;
  fixture.close = () => new Promise<void>(resolve => server.close(() => resolve()));
  try {
    await fn(fixture);
  } finally {
    await fixture.close();
  }
}

/** PNG bytes served as the image provider's inline result. */
let cachedPng: Promise<Buffer> | undefined;
function providerPng(): Promise<Buffer> {
  cachedPng ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'viscraft-multiref-png-'));
    const file = join(dir, 'g.png');
    try {
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
        'testsrc2=size=96x64:rate=1:duration=1',
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

interface ImageFixture {
  baseUrl: string;
  requests: { path: string; body: Buffer }[];
  close: () => Promise<void>;
}
async function withImageFixture(fn: (fixture: ImageFixture) => Promise<void>): Promise<void> {
  const png = await providerPng();
  const fixture: ImageFixture = { baseUrl: '', requests: [], close: async () => {} };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (!(req.method === 'POST' && (path === '/v1/images/generations' || path === '/v1/images/edits'))) {
        res.writeHead(404);
        res.end();
        return;
      }
      fixture.requests.push({ path, body: Buffer.concat(chunks) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ created: 1, data: [{ b64_json: png.toString('base64') }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  fixture.baseUrl = `http://127.0.0.1:${address.port}`;
  fixture.close = () => new Promise<void>(resolve => server.close(() => resolve()));
  try {
    await fn(fixture);
  } finally {
    await fixture.close();
  }
}

test('video: an ordered multi-reference request submits in order, records ordered provenance, and resumes without resubmit', async () => {
  await withRoot(async root => {
    await makePng(join(root, 'assets'), 'hero.png');
    await makePng(join(root, 'assets'), 'bg.png');
    await makeMp4(join(root, 'clip.mp4'));
    const hero = await assetOf(root, 'hero', 'assets/hero.png', 'image');
    const bg = await assetOf(root, 'bg', 'assets/bg.png', 'image');
    const clip = await assetOf(root, 'clip', 'clip.mp4', 'video');
    const media = await readFile(join(root, 'clip.mp4'));
    const references = [
      ref('hero', 'image', 'identity'),
      ref('clip', 'video', 'motion'),
      ref('bg', 'image', 'environment'),
    ];
    const options = {
      testOnly: { baseUrl: '' },
      references: [
        { asset: hero, root },
        { asset: clip, root },
        { asset: bg, root },
      ],
    };

    await withVideoFixture(async fixture => {
      const opts = { ...options, testOnly: { baseUrl: fixture.baseUrl } };
      const result = await generateVideoApi(root, source('att_order', references), OUTPUT, 'build/a.mp4', opts);
      assert.equal(fixture.posts, 1);
      assert.equal(fixture.uploads.length, 3, 'all three references are transmitted');
      assert.deepEqual(
        fixture.uploads.map(part => part.name),
        ['input_references', 'input_references', 'input_references'],
      );
      assert.deepEqual(
        fixture.uploads.map(part => part.type),
        ['image/png', 'video/mp4', 'image/png'],
      );
      assert.deepEqual(
        fixture.uploads.map(part => createHash('sha256').update(part.data).digest('hex')),
        [hero.sha256, clip.sha256, bg.sha256],
        'the multipart part order must match the declared reference order',
      );
      assert.deepEqual(
        result.generation.references.map(reference => [reference.asset, reference.category, reference.role]),
        [
          ['hero', 'image', 'identity'],
          ['clip', 'video', 'motion'],
          ['bg', 'image', 'environment'],
        ],
      );

      // A succeeded job is restored locally without a second POST.
      await generateVideoApi(root, source('att_order', references), OUTPUT, 'exports/again.mp4', opts);
      assert.equal(fixture.posts, 1, 'a recovered job must never be resubmitted');
      assert.ok(existsSync(join(root, 'exports', 'again.mp4')));
      const jobs = (await videoApiStatus(root)) as Array<Record<string, unknown>>;
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].simulated, true, 'a test-only run is marked simulated');
    }, media);
  });
});

test('video: an image-less video-reference request is accepted on the Ref2VA default', async () => {
  await withRoot(async root => {
    await makeMp4(join(root, 'clip.mp4'));
    const clip = await assetOf(root, 'clip', 'clip.mp4', 'video');
    const media = await readFile(join(root, 'clip.mp4'));
    await withVideoFixture(async fixture => {
      const result = await generateVideoApi(
        root,
        source('att_video_only', [ref('clip', 'video', 'motion')]),
        OUTPUT,
        'build/v.mp4',
        { testOnly: { baseUrl: fixture.baseUrl }, references: [{ asset: clip, root }] },
      );
      assert.equal(fixture.posts, 1, 'a video reference with no image must be accepted');
      assert.equal(fixture.uploads.length, 1);
      assert.equal(fixture.uploads[0].type, 'video/mp4');
      assert.deepEqual(result.generation.references, [
        {
          asset: 'clip',
          sha256: clip.sha256,
          category: 'video',
          role: 'motion',
          media: result.generation.references[0].media,
        },
      ]);
    }, media);
  });
});

test('video: reordering references changes the request identity instead of reusing a result', async () => {
  await withRoot(async root => {
    await makePng(join(root, 'assets'), 'hero.png');
    await makeMp4(join(root, 'clip.mp4'));
    const hero = await assetOf(root, 'hero', 'assets/hero.png', 'image');
    const clip = await assetOf(root, 'clip', 'clip.mp4', 'video');
    const media = await readFile(join(root, 'clip.mp4'));
    await withVideoFixture(async fixture => {
      const opts = {
        testOnly: { baseUrl: fixture.baseUrl },
        references: [
          { asset: hero, root },
          { asset: clip, root },
        ],
      };
      await generateVideoApi(
        root,
        source('att_reorder', [ref('hero', 'image', 'identity'), ref('clip', 'video', 'motion')]),
        OUTPUT,
        'build/a.mp4',
        opts,
      );
      await assert.rejects(
        () =>
          generateVideoApi(
            root,
            source('att_reorder', [ref('clip', 'video', 'motion'), ref('hero', 'image', 'identity')]),
            OUTPUT,
            'build/a.mp4',
            {
              ...opts,
              references: [
                { asset: clip, root },
                { asset: hero, root },
              ],
            },
          ),
        /different frozen request|new attempt/i,
      );
      assert.equal(fixture.posts, 1, 'a reordered request must not reach the service');
    }, media);
  });
});

test('video: dropping a reference is a changed request, and a provided-list mismatch is refused', async () => {
  await withRoot(async root => {
    await makePng(join(root, 'assets'), 'hero.png');
    await makeMp4(join(root, 'clip.mp4'));
    const hero = await assetOf(root, 'hero', 'assets/hero.png', 'image');
    const clip = await assetOf(root, 'clip', 'clip.mp4', 'video');
    const media = await readFile(join(root, 'clip.mp4'));
    await withVideoFixture(async fixture => {
      const opts = {
        testOnly: { baseUrl: fixture.baseUrl },
        references: [
          { asset: hero, root },
          { asset: clip, root },
        ],
      };
      await generateVideoApi(
        root,
        source('att_drop', [ref('hero', 'image', 'identity'), ref('clip', 'video', 'motion')]),
        OUTPUT,
        'build/a.mp4',
        opts,
      );
      // Dropping one declared reference (same attempt) changes the request hash.
      await assert.rejects(
        () =>
          generateVideoApi(root, source('att_drop', [ref('hero', 'image', 'identity')]), OUTPUT, 'build/a.mp4', {
            testOnly: { baseUrl: fixture.baseUrl },
            references: [{ asset: hero, root }],
          }),
        /different frozen request|new attempt/i,
      );
      // A provided list that does not cover the declared references is refused.
      await assert.rejects(
        () =>
          generateVideoApi(
            root,
            source('att_uncovered', [ref('hero', 'image', 'identity'), ref('clip', 'video', 'motion')]),
            OUTPUT,
            'build/b.mp4',
            { testOnly: { baseUrl: fixture.baseUrl }, references: [{ asset: hero, root }] },
          ),
        /declares 2 reference|were provided|mismatch/i,
      );
      assert.equal(fixture.posts, 1);
    }, media);
  });
});

test('video: over-limit counts and audio-only are refused before any request', async () => {
  await withRoot(async root => {
    await makePng(join(root, 'assets'), 'hero.png');
    await makeM4a(join(root, 'track.m4a'));
    const hero = await assetOf(root, 'hero', 'assets/hero.png', 'image');
    const audio = await assetOf(root, 'track', 'track.m4a', 'audio');
    const provided = {
      testOnly: { baseUrl: 'http://127.0.0.1:1' },
      references: [
        { asset: hero, root },
        { asset: audio, root },
      ],
    };
    // Ten images exceed the official Ref2VA image limit of 9.
    await assert.rejects(
      () =>
        generateVideoApi(
          root,
          source(
            'att_ten_images',
            Array.from({ length: 10 }, () => ref('hero', 'image', 'identity')),
          ),
          OUTPUT,
          'build/x.mp4',
          provided,
        ),
      /at most 9 image references/i,
    );
    // Four videos exceed the video limit of 3.
    await assert.rejects(
      () =>
        generateVideoApi(
          root,
          source(
            'att_four_videos',
            Array.from({ length: 4 }, () => ref('hero', 'video', 'motion')),
          ),
          OUTPUT,
          'build/x.mp4',
          provided,
        ),
      /at most 3 video references/i,
    );
    // Audio may not be the only input.
    await assert.rejects(
      () =>
        generateVideoApi(root, source('att_audio_only', [ref('track', 'audio', 'audio')]), OUTPUT, 'build/x.mp4', {
          testOnly: { baseUrl: 'http://127.0.0.1:1' },
          references: [{ asset: audio, root }],
        }),
      /at least one image or video|audio may not be the only input/i,
    );
    // A 13-entry MIXED list that stays within each per-category limit is refused
    // by the H3 model profile's total bound (9/3/3/12), NOT by the general
    // schema: the schema deliberately imposes no numeric reference cap, so the
    // same list is legal for a different model (see tests/limit-scoping.test.ts).
    const thirteenMixed = [
      ...Array.from({ length: 9 }, () => ref('hero', 'image', 'identity')),
      ...Array.from({ length: 3 }, () => ref('hero', 'video', 'motion')),
      ref('track', 'audio', 'audio'),
    ];
    await assert.rejects(
      () => generateVideoApi(root, source('att_total', thirteenMixed), OUTPUT, 'build/x.mp4', provided),
      /MiniMax-H3 Ref2VA accepts at most 12 mixed references \(got 13\)/,
    );
  });
});

test('video: every transmitted reference needs its own per-Asset consent', async () => {
  await withRoot(async root => {
    await makePng(join(root, 'assets'), 'hero.png');
    await makeMp4(join(root, 'clip.mp4'));
    const hero = await assetOf(root, 'hero', 'assets/hero.png', 'image');
    const clip = await assetOf(root, 'clip', 'clip.mp4', 'video');
    const media = await readFile(join(root, 'clip.mp4'));
    await withVideoFixture(async fixture => {
      await assert.rejects(
        () =>
          generateVideoApi(
            root,
            source('att_consent', [ref('hero', 'image', 'identity'), ref('clip', 'video', 'motion')]),
            OUTPUT,
            'build/a.mp4',
            {
              endpoint: { protocol: 'vllm-omni-video', baseUrl: fixture.baseUrl },
              authorization: { submit: true, uploadAssets: ['hero'] },
              references: [
                { asset: hero, root },
                { asset: clip, root },
              ],
            },
          ),
        /consent|uploadAssets/i,
      );
      assert.equal(fixture.posts, 0, 'a missing per-Asset consent must stop before any request');
      assert.ok(
        !existsSync(
          join(root, '.viscraft', 'jobs', 'video-api', `${attemptStem('s_att_consent', 'att_consent')}.json`),
        ),
      );
    }, media);
  });
});

test('video: a simulated reference taints a production job (marker propagates)', async () => {
  await withRoot(async root => {
    await makePng(join(root, 'assets'), 'hero.png');
    await makeMp4(join(root, 'clip.mp4'));
    const hero = await assetOf(root, 'hero', 'assets/hero.png', 'image', true);
    const media = await readFile(join(root, 'clip.mp4'));
    await withVideoFixture(async fixture => {
      const result = await generateVideoApi(
        root,
        source('att_taint', [ref('hero', 'image', 'identity')]),
        OUTPUT,
        'build/t.mp4',
        {
          endpoint: { protocol: 'vllm-omni-video', baseUrl: fixture.baseUrl },
          authorization: { submit: true, uploadAssets: ['hero'] },
          references: [{ asset: hero, root }],
        },
      );
      assert.equal(result.generation.provider, 'video-api');
      const jobs = (await videoApiStatus(root)) as Array<Record<string, unknown>>;
      assert.equal(jobs[0].mode, 'production');
      assert.equal(jobs[0].simulated, true, 'a real-service run over a simulated Asset must be tainted');
    }, media);
  });
});

test('image: ordered references route to the image-carrying endpoint and preserve order and mask', async () => {
  await withRoot(async root => {
    await makePng(join(root, 'assets'), 'hero.png');
    await makePng(join(root, 'assets'), 'bg.png');
    await makePng(join(root, 'assets'), 'm.png');
    const hero = await assetOf(root, 'hero', 'assets/hero.png', 'image');
    const bg = await assetOf(root, 'bg', 'assets/bg.png', 'image');
    const mask = await assetOf(root, 'm', 'assets/m.png', 'image');
    await withImageFixture(async fixture => {
      // A `generate` that carries references is a legal multi-reference request and
      // must route to the multipart edits endpoint (generations is JSON-only).
      const generated = await generateImageApi(
        root,
        {
          id: 's_g',
          attempt: 1,
          asset: 'out_g',
          rights: { origin: 'generated by the vllm-omni-image fixture', license: 'CC0-1.0', redistributable: true },
          endpoint: 'test',
          operation: 'generate',
          model: 'Qwen-Image',
          prompt: 'compose the subject into the environment',
          references: [ref('hero', 'image', 'identity'), ref('bg', 'image', 'environment')],
        },
        'build/g.png',
        {
          testOnly: { baseUrl: fixture.baseUrl },
          references: [
            { asset: hero, root },
            { asset: bg, root },
          ],
        },
      );
      assert.equal(fixture.requests.length, 1);
      assert.equal(fixture.requests[0].path, '/v1/images/edits', 'references must go to the image-carrying endpoint');
      const text = fixture.requests[0].body.toString('latin1');
      assert.equal(
        (text.match(/name="image"/g) ?? []).length,
        2,
        'both references are transmitted as ordered image parts',
      );
      assert.equal(text.includes('name="mask_image"'), false, 'a generate must not carry a mask part');
      assert.deepEqual(generated.generation.inputSha256, [hero.sha256, bg.sha256]);
      assert.deepEqual(
        generated.generation.references.map(reference => [reference.asset, reference.role]),
        [
          ['hero', 'identity'],
          ['bg', 'environment'],
        ],
      );

      // An edit with a mask keeps the mask distinguishable and ordered.
      await generateImageApi(
        root,
        {
          id: 's_e',
          attempt: 2,
          asset: 'out_e',
          rights: { origin: 'generated by the vllm-omni-image fixture', license: 'CC0-1.0', redistributable: true },
          endpoint: 'test',
          operation: 'edit',
          model: 'Qwen-Image',
          prompt: 'replace the marked region',
          references: [ref('hero', 'image', 'identity'), ref('m', 'image', 'mask')],
        },
        'build/e.png',
        {
          testOnly: { baseUrl: fixture.baseUrl },
          references: [
            { asset: hero, root },
            { asset: mask, root },
          ],
        },
      );
      const editText = fixture.requests[1].body.toString('latin1');
      assert.equal((editText.match(/name="image"/g) ?? []).length, 1);
      assert.equal(editText.includes('name="mask_image"'), true, 'a mask reference becomes the mask part');
    });
  });
});

test('image: reordering references changes the image request hash', async () => {
  await withRoot(async root => {
    await makePng(join(root, 'assets'), 'hero.png');
    await makePng(join(root, 'assets'), 'bg.png');
    const hero = await assetOf(root, 'hero', 'assets/hero.png', 'image');
    const bg = await assetOf(root, 'bg', 'assets/bg.png', 'image');
    const base = {
      id: 's_r',
      attempt: 5,
      asset: 'out_r',
      rights: { origin: 'generated by the vllm-omni-image fixture', license: 'CC0-1.0', redistributable: true },
      endpoint: 'test',
      operation: 'generate',
      model: 'Qwen-Image',
      prompt: 'x',
    } as const;
    await withImageFixture(async fixture => {
      const opts = { testOnly: { baseUrl: fixture.baseUrl } };
      await generateImageApi(
        root,
        { ...base, references: [ref('hero', 'image', 'identity'), ref('bg', 'image', 'environment')] },
        'build/g.png',
        {
          ...opts,
          references: [
            { asset: hero, root },
            { asset: bg, root },
          ],
        },
      );
      await assert.rejects(
        () =>
          generateImageApi(
            root,
            { ...base, references: [ref('bg', 'image', 'environment'), ref('hero', 'image', 'identity')] },
            'build/g.png',
            {
              ...opts,
              references: [
                { asset: bg, root },
                { asset: hero, root },
              ],
            },
          ),
        /different frozen request|new attempt/i,
      );
      assert.equal(fixture.requests.length, 1);
    });
  });
});
