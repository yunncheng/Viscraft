/** Output changes are compared with the persisted artifact output specification. After a failed write, retries must materialize and probe the requested output without submitting generation again. */
import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Asset, OutputSettings, ProviderSource } from '../src/core/schema.js';
import { probeMedia } from '../src/backends/media/probe.js';
import { generateVideoService } from '../src/backends/providers/video-service.js';
import { generateFal } from '../src/backends/providers/services/fal/index.js';
import { generateRunway } from '../src/backends/providers/services/runway/index.js';
import { attemptStem } from '../src/backends/providers/job-store.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';

// Spec A and spec B differ in EVERY probed dimension (raster, clock, audio).
const SPEC_A: OutputSettings = {
  width: 96,
  height: 64,
  fps: { numerator: 24, denominator: 1 },
  sampleRate: 48000,
  channels: 1,
};
const SPEC_B: OutputSettings = {
  width: 128,
  height: 72,
  fps: { numerator: 25, denominator: 1 },
  sampleRate: 44100,
  channels: 2,
};

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-fixture-spec-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// --- A real, probeable provider media fixture: 16:9 H.264 WITH an audio stream,
// so audio sampleRate/channels are meaningful. Built once. ---
let cachedMedia: Promise<Buffer> | undefined;
function providerMedia(): Promise<Buffer> {
  cachedMedia ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'viscraft-fixture-media-'));
    try {
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
        'testsrc2=size=320x180:rate=30:duration=1',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000:duration=1',
        '-frames:v',
        '30',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-shortest',
        file,
      ]);
      return await readFile(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })();
  return cachedMedia;
}

/** A real encoded PNG used as an approved first-frame image for the fal lane. */
async function writePng(root: string, rel: string): Promise<Asset> {
  const abs = join(root, rel);
  await mkdir(join(abs, '..'), { recursive: true });
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
    abs,
  ]);
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

/**
 * Drive the three-step reproduction for one lane. `run` performs a single
 * generation of `source` at the given output spec into `destination`, and
 * `probe` returns the probed facts of the destination media. `conflict` names
 * the destination used for steps 2–3 (a different path than step 1, so the
 * step-1 artifact survives — that survival is what makes step 3 load-bearing).
 */
async function assertSpecRetry(opts: {
  root: string;
  step1Dest: string;
  conflictDest: string;
  jobFile: string;
  run: (output: OutputSettings, destination: string) => Promise<unknown>;
  submits: () => number;
}): Promise<void> {
  const { root, step1Dest, conflictDest, jobFile, run, submits } = opts;

  // 1) First generation at spec A succeeds; probe the produced media.
  await run(SPEC_A, step1Dest);
  assert.equal(submits(), 1, 'one real submit produces the Take');
  const a = await probeMedia(join(root, step1Dest));
  assert.equal(a.width, SPEC_A.width);
  assert.equal(a.height, SPEC_A.height);
  assert.deepEqual(a.fps, { numerator: 24, denominator: 1 });
  assert.ok(a.audio, 'the produced spec-A media must carry the fixture audio stream');
  assert.equal(a.audio!.sampleRate, 48000);
  assert.equal(a.audio!.channels, 1);

  // 2) Change the SAME attempt to spec B and force the target write to fail: the
  //    destination is an existing DIRECTORY where the file must be written. The
  //    call must fail and must never resubmit.
  await mkdir(join(root, conflictDest), { recursive: true });
  await assert.rejects(
    () => run(SPEC_B, conflictDest),
    /EISDIR|ENOTDIR|EEXIST|ENOTEMPTY|is a directory|not a directory|rename/i,
    'a target write into a directory must fail the call',
  );
  assert.equal(submits(), 1, 'a local write failure never induces a resubmit');

  // 3) Remove the conflict and retry with the SAME spec B: this must return
  //    spec-B media, not the retained spec-A artifact.
  await rm(join(root, conflictDest), { recursive: true, force: true });
  await run(SPEC_B, conflictDest);
  assert.equal(submits(), 1, 'the same-spec retry never resubmits');

  const b = await probeMedia(join(root, conflictDest));
  assert.equal(b.width, SPEC_B.width, 'the retried media must be the NEW raster width');
  assert.equal(b.height, SPEC_B.height, 'the retried media must be the NEW raster height');
  assert.deepEqual(b.fps, { numerator: 25, denominator: 1 }, 'the retried media must be the NEW clock');
  assert.ok(b.audio, 'the retried media must carry audio');
  assert.equal(b.audio!.sampleRate, SPEC_B.sampleRate, 'the retried media must be the NEW audio sample rate');
  assert.equal(b.audio!.channels, SPEC_B.channels, 'the retried media must be the NEW channel count');

  // The persisted record must agree with the bytes: output AND artifactOutput are
  // spec B, and the recorded artifact metadata matches the probed media.
  const job = JSON.parse(await readFile(join(root, jobFile), 'utf8')) as {
    output: OutputSettings;
    artifactOutput?: OutputSettings;
    artifact?: {
      width: number;
      height: number;
      fps: OutputSettings['fps'];
      audio?: { sampleRate: number; channels: number };
    };
  };
  assert.deepEqual(job.output, SPEC_B, 'the record adopts spec B');
  assert.deepEqual(job.artifactOutput, SPEC_B, 'the artifact was produced at (and recorded as) spec B');
  assert.ok(job.artifact, 'the record carries artifact metadata');
  assert.equal(job.artifact!.width, SPEC_B.width);
  assert.equal(job.artifact!.height, SPEC_B.height);
  assert.equal(job.artifact!.audio?.sampleRate, SPEC_B.sampleRate);
  assert.equal(job.artifact!.audio?.channels, SPEC_B.channels);
}

// ---------------------------------------------------------------------------
// Generic `vllm-omni-video` lane, driven through the public `generateVideoService`.
// ---------------------------------------------------------------------------

interface GenericFixture {
  baseUrl: string;
  state: { posts: number };
}

async function withGenericFixture(fn: (fixture: GenericFixture) => Promise<void>): Promise<void> {
  const media = await providerMedia();
  const state: GenericFixture['state'] = { posts: 0 };
  let port = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '/';
      if (req.method === 'POST' && url === '/v1/videos') {
        state.posts++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'p1gen', status: 'queued' }));
        return;
      }
      if (req.method === 'GET' && url === '/v1/videos/p1gen') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'p1gen', status: 'completed', error: null, inference_time_s: 0.1 }));
        return;
      }
      if (req.method === 'GET' && url === '/v1/videos/p1gen/content') {
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
  try {
    await fn({ baseUrl: `http://127.0.0.1:${port}`, state });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function genericSource(attempt: string): ProviderSource {
  return {
    id: 'p1gen',
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

test('same-spec retry after a failed materialization returns the NEW spec (generic lane)', async () => {
  await withRoot(async root => {
    await withGenericFixture(async fixture => {
      const options = { testOnly: { baseUrl: fixture.baseUrl } };
      const source = genericSource('rgen');
      const jobFile = `.viscraft/jobs/video-api/${attemptStem('p1gen', 'rgen')}.json`;
      await assertSpecRetry({
        root,
        step1Dest: 'build/keep.mp4',
        conflictDest: 'build/out.mp4',
        jobFile,
        run: (output, destination) => generateVideoService(root, source, output, destination, options),
        submits: () => fixture.state.posts,
      });

      // The recorded remote identity still rejects a genuinely changed request.
      await assert.rejects(
        () =>
          generateVideoService(
            root,
            { ...source, prompt: 'a totally different scene' },
            SPEC_B,
            'build/out.mp4',
            options,
          ),
        /different frozen request|new attempt|changed parameters/i,
      );
      assert.equal(fixture.state.posts, 1, 'a changed remote request must be refused without resubmit');
    });
  });
});

test('a plain first-time success produces exactly the requested spec (generic lane)', async () => {
  await withRoot(async root => {
    await withGenericFixture(async fixture => {
      const options = { testOnly: { baseUrl: fixture.baseUrl } };
      await generateVideoService(root, genericSource('first'), SPEC_B, 'build/first.mp4', options);
      assert.equal(fixture.state.posts, 1);
      const probed = await probeMedia(join(root, 'build/first.mp4'));
      assert.equal(probed.width, SPEC_B.width);
      assert.equal(probed.height, SPEC_B.height);
      assert.deepEqual(probed.fps, { numerator: 25, denominator: 1 });
      assert.equal(probed.audio?.sampleRate, 44100);
      assert.equal(probed.audio?.channels, 2);
    });
  });
});

// ---------------------------------------------------------------------------
// fal queue lane (`generateFal`) — targeted end-to-end.
// ---------------------------------------------------------------------------

interface FalFixture {
  baseUrl: string;
  state: { submits: number };
}

async function withFalFixture(fn: (fixture: FalFixture) => Promise<void>): Promise<void> {
  const media = await providerMedia();
  const state: FalFixture['state'] = { submits: 0 };
  let port = 0;
  const base = () => `http://127.0.0.1:${port}`;
  const routes = (id: string) => ({
    status: `${base()}/alibaba/wan-3.0/image-to-video/requests/${id}/status`,
    result: `${base()}/alibaba/wan-3.0/image-to-video/requests/${id}`,
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'POST' && path === '/alibaba/wan-3.0/image-to-video') {
        state.submits++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'IN_QUEUE',
            request_id: 'req_p1',
            status_url: routes('req_p1').status,
            response_url: routes('req_p1').result,
          }),
        );
        return;
      }
      if (req.method === 'GET' && /\/requests\/req_p1\/status$/.test(path)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'COMPLETED', request_id: 'req_p1' }));
        return;
      }
      if (req.method === 'GET' && /\/requests\/req_p1$/.test(path)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ video: { url: `${base()}/media/out.mp4` }, seed: 1, duration: 5 }));
        return;
      }
      if (req.method === 'GET' && path === '/media/out.mp4') {
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
  try {
    await fn({ baseUrl: base(), state });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function falSource(attempt: string): ProviderSource {
  return {
    id: 'p1fal',
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

test('same-spec retry after a failed materialization returns the NEW spec (fal lane)', async () => {
  await withRoot(async root => {
    const hero = await writePng(root, 'assets/hero.png');
    await withFalFixture(async fixture => {
      const options = { testOnly: { baseUrl: fixture.baseUrl }, references: [{ asset: hero, root }] };
      await assertSpecRetry({
        root,
        step1Dest: 'build/keep.mp4',
        conflictDest: 'build/out.mp4',
        jobFile: `.viscraft/jobs/fal/${attemptStem('p1fal', 'rfal')}.json`,
        run: (output, destination) => generateFal(root, falSource('rfal'), output, destination, options),
        submits: () => fixture.state.submits,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Runway lane (`generateRunway`) — targeted end-to-end.
// ---------------------------------------------------------------------------

interface RunwayFixture {
  baseUrl: string;
  state: { submits: number };
}

async function withRunwayFixture(fn: (fixture: RunwayFixture) => Promise<void>): Promise<void> {
  const media = await providerMedia();
  const state: RunwayFixture['state'] = { submits: 0 };
  let port = 0;
  const base = () => `http://127.0.0.1:${port}`;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'POST' && path === '/v1/text_to_video') {
        state.submits++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'p1rw', estimatedCost: { credits: 5 } }));
        return;
      }
      if (req.method === 'GET' && path === '/v1/tasks/p1rw') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'p1rw',
            status: 'SUCCEEDED',
            cost: { credits: 4 },
            output: [`${base()}/media/p1rw.mp4`],
          }),
        );
        return;
      }
      if (req.method === 'GET' && path === '/media/p1rw.mp4') {
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
  try {
    await fn({ baseUrl: base(), state });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function runwaySource(attempt: string): ProviderSource {
  return {
    id: 'p1rw',
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

test('same-spec retry after a failed materialization returns the NEW spec (runway lane)', async () => {
  await withRoot(async root => {
    await withRunwayFixture(async fixture => {
      const options = { testOnly: { baseUrl: fixture.baseUrl } };
      await assertSpecRetry({
        root,
        step1Dest: 'build/keep.mp4',
        conflictDest: 'build/out.mp4',
        jobFile: `.viscraft/jobs/runway/${attemptStem('p1rw', 'rrw')}.json`,
        run: (output, destination) => generateRunway(root, runwaySource('rrw'), output, destination, options),
        submits: () => fixture.state.submits,
      });
    });
  });
});
