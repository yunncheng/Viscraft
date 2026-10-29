/**
 * E4 — what a range preview REALLY executes and consumes.
 *
 * The preview source comments and the Skill `runtime/lifecycle.md` page once
 * claimed a preview "does not generate or submit". That is false for an in-range
 * provider Source with no Take yet: such a preview runs the ordinary executor and
 * MAY perform its FIRST generation. These tests pin the true contract on a LOCAL
 * LOOPBACK fixture — no real model, no external network, no key — by counting the
 * actual POSTs the provider adapter sends:
 *
 *  - out-of-range → POST 0 (the substituted Placement's Source never runs);
 *  - in-range, NOT authorized → POST 0 (the adapter's own submit gate refuses);
 *  - in-range, no Take/success record, authorized → FIRST POST 1, and the Plan
 *    predicted exactly that work;
 *  - a matching successful job / an explicit Take → POST does not grow;
 *  - the author timeline and the active Result stay byte-identical.
 *
 * The lane is deliberately NON-testOnly (a production `vllm-omni-video` endpoint on a
 * loopback 127.0.0.1 origin, which `normalizeProductionBase` allows) so that
 * `authorization.submit` is the REAL gate under test rather than a bypassed
 * fixture flag. The served media is a real FFmpeg-encoded MP4, so the Take is
 * genuinely decodable; the "service" is a local mock and is never evidence of
 * real model quality.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildProject, createProject, loadProject, planBuild, previewProject, saveProject } from '../src/index.js';
import type { OutputSettings, ProviderSource, SimulatedSource } from '../src/index.js';
import { probeMedia } from '../src/backends/media/probe.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';

const OUTPUT: OutputSettings = {
  width: 96,
  height: 64,
  fps: { numerator: 24, denominator: 1 },
  sampleRate: 48000,
  channels: 2,
};

// The provider Take is requested at exactly 24 frames over a 48-frame programme,
// so a 4-frame preview range proves only the composed programme is shortened,
// never the model's own request.
const REQUESTED_FRAMES = 24;
const PRE_END = 24;

/** A production-mode `vllm-omni-video` endpoint on the loopback fixture (no submit consent). */
function endpointOnly(baseUrl: string) {
  return { providers: { videoApi: { ep: { endpoint: { protocol: 'vllm-omni-video' as const, baseUrl } } } } };
}

/** The same endpoint WITH explicit spend consent. */
function endpointAuthorized(baseUrl: string) {
  return {
    providers: {
      videoApi: {
        ep: { endpoint: { protocol: 'vllm-omni-video' as const, baseUrl }, authorization: { submit: true } },
      },
    },
  };
}

interface Fixture {
  baseUrl: string;
  /** POST /v1/videos count — the one number E4 is about. */
  posts: number;
  /** The most recent submit body (multipart), for the "full request, not the range" check. */
  lastBody: string;
}

let cachedMedia: Promise<Buffer> | undefined;

/** A real, probeable provider media fixture (tiny 24-frame H.264), built once. */
function providerMedia(): Promise<Buffer> {
  cachedMedia ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'viscraft-preview-e4-media-'));
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
        'testsrc2=size=96x64:rate=24/1:duration=1',
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
  return cachedMedia;
}

/** A local mock of the `vllm-omni-video` wire: submit, status, content. Never a real model. */
async function withFixture(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  const media = await providerMedia();
  const fixture: Fixture = { baseUrl: '', posts: 0, lastBody: '' };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = req.url ?? '/';
      if (req.method === 'POST' && url === '/v1/videos') {
        fixture.posts += 1;
        fixture.lastBody = Buffer.concat(chunks).toString('utf8');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 'preview_task', status: 'queued' }));
        return;
      }
      if (req.method === 'GET' && url === '/v1/videos/preview_task') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 'preview_task', status: 'completed', inference_time_s: 0.1 }));
        return;
      }
      if (req.method === 'GET' && url === '/v1/videos/preview_task/content') {
        res.setHeader('content-type', 'video/mp4');
        res.end(media);
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  fixture.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(fixture);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

/** Read one scalar multipart field (`extra_params` etc.; no reference parts here). */
function multipartField(body: string, name: string): string | undefined {
  return new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`).exec(body)?.[1];
}

function generatedSource(attempt: string): ProviderSource {
  return {
    id: 'src_gen',
    kind: 'provider',
    output: 'picture',
    endpoint: 'ep',
    model: 'preview-model',
    prompt: 'a local fixture passage',
    mode: 'text',
    references: [],
    requestedFrames: REQUESTED_FRAMES,
    size: '96:64',
    fps: 24,
    seed: 1,
    attempt,
  };
}

const localSource: SimulatedSource = {
  id: 'src_local',
  kind: 'simulated',
  prompt: 'local test pattern',
  frames: PRE_END,
  seed: 1,
  attempt: 'sim1',
  behavior: 'success',
};

/**
 * A 48-frame programme = one local (no-network) Placement in `[0,24)` and one
 * provider Placement in `[24,48)`. The two ranges let a preview touch either
 * side, so the provider's Source is out of range or in range independently.
 */
async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-preview-e4-'));
  const project = await createProject(root, { title: 'Preview provider consumption', output: OUTPUT });
  project.direction.looks = [{ id: 'look', description: 'Look' }];
  project.sources = [localSource, generatedSource('prov1')];
  project.composition!.scenes = [{ id: 'scene', description: 'scene' }];
  project.composition!.shots = [
    { id: 'shot_pre', scene: 'scene', look: 'look', intent: 'local passage', targetFrames: PRE_END },
    { id: 'shot_gen', scene: 'scene', look: 'look', intent: 'generated passage', targetFrames: REQUESTED_FRAMES },
  ];
  project.composition!.placements = [
    {
      id: 'pl_pre',
      shot: 'shot_pre',
      source: 'src_local',
      inFrame: 0,
      outFrame: PRE_END,
      startFrame: 0,
      audio: 'mute',
    },
    {
      id: 'pl_gen',
      shot: 'shot_gen',
      source: 'src_gen',
      inFrame: 0,
      outFrame: REQUESTED_FRAMES,
      startFrame: PRE_END,
      audio: 'mute',
    },
  ];
  await saveProject(root, project, project.revision);
  return root;
}

test('an in-range, uncached provider Source preview performs its FIRST generation; POSTs are gated, reused and never hidden', async () => {
  await withFixture(async fixture => {
    const root = await makeRoot();
    try {
      const projectFile = join(root, 'project.json');
      const resultFile = join(root, '.viscraft', 'result.json');
      const authorBefore = await hashFile(projectFile);

      // (a) OUT OF RANGE: the provider Placement is substituted; its Source never runs.
      const outPlan = await planBuild(root, { preview: { frames: [10, 14] } });
      assert.deepEqual(outPlan.preview, { frames: [10, 14], scale: 1, substituted: ['pl_gen'] });
      assert.equal(
        outPlan.work.some(item => item.subject === 'src_gen'),
        false,
        'the out-of-range provider Source is not planned work',
      );
      assert.equal(outPlan.reuse.length, 0);
      const outPreview = await previewProject(root, { frames: [10, 14] });
      assert.equal(outPreview.status, 'succeeded', outPreview.error);
      assert.equal(
        outPreview.takes.some(take => take.source === 'src_gen'),
        false,
        'the substituted provider Source produced no Take',
      );
      assert.equal(fixture.posts, 0, 'POST 0 — an out-of-range provider Source never executes');

      // (b) IN RANGE but NOT authorized: the adapter's own submit gate refuses; POST 0.
      await assert.rejects(
        previewProject(root, { frames: [30, 34], ...endpointOnly(fixture.baseUrl) }),
        /authorization/,
      );
      assert.equal(fixture.posts, 0, 'POST 0 — an unauthorized in-range Source sends nothing');

      // (c) IN RANGE, no Take/success record, AUTHORIZED: the FIRST generation happens,
      //     exactly as the read-only Plan predicted.
      const inPlan = await planBuild(root, { preview: { frames: [30, 34] }, ...endpointAuthorized(fixture.baseUrl) });
      assert.equal(inPlan.buildable, true, JSON.stringify(inPlan.blockers));
      assert.deepEqual(
        inPlan.work.map(item => item.subject),
        ['src_gen'],
        'the Plan predicts the provider generation',
      );
      assert.equal(inPlan.reuse.length, 0, 'nothing is reusable yet');
      assert.equal(fixture.posts, 0, 'POST 0 — Plan is read-only and submits nothing');

      const first = await previewProject(root, { frames: [30, 34], ...endpointAuthorized(fixture.baseUrl) });
      assert.equal(first.status, 'succeeded', first.error);
      assert.equal(first.result, undefined, 'a preview has no active result');
      assert.equal(fixture.posts, 1, 'POST 1 — an authorized in-range uncached provider Source generates once');

      // A SMALL preview does not shorten the model's request: the wire asked for the
      // full authored frame count, and the Take is produced at the FULL output.
      assert.equal(multipartField(fixture.lastBody, 'num_frames'), String(REQUESTED_FRAMES));
      const genTake = first.takes.find(take => take.source === 'src_gen');
      assert.ok(genTake, 'the provider Take is registered');
      const genArtifact = first.artifacts.find(artifact => artifact.id === genTake.artifact);
      assert.ok(genArtifact, 'the provider Take has an artifact');
      const genMedia = await probeMedia(join(root, genArtifact.path));
      assert.equal(genMedia.frames, REQUESTED_FRAMES, 'the model produced its full request, not the 4-frame range');
      assert.equal(genMedia.width, OUTPUT.width, 'a provider Take keeps the FULL raster, never a proxy');
      assert.equal(genMedia.height, OUTPUT.height);
      const previewMovie = first.artifacts.find(artifact => artifact.id === first.preview?.artifact);
      assert.ok(previewMovie, 'the preview has its composed movie');
      assert.equal((await probeMedia(join(root, previewMovie.path))).frames, 4, 'only the composed programme is cut');

      // (d) A matching SUCCESS record: the second preview reuses it; POST does not grow.
      const againPlan = await planBuild(root, {
        preview: { frames: [30, 34] },
        ...endpointAuthorized(fixture.baseUrl),
      });
      assert.deepEqual(
        againPlan.work.map(item => item.subject),
        [],
        'the provider is now reusable, not work',
      );
      assert.deepEqual(
        againPlan.reuse.map(item => item.subject),
        ['src_gen'],
      );
      const again = await previewProject(root, { frames: [30, 34], ...endpointAuthorized(fixture.baseUrl) });
      assert.equal(again.status, 'succeeded', again.error);
      assert.equal(fixture.posts, 1, 'POST does not grow — a matching successful job is reused without resubmitting');

      // Preview wrote neither the author timeline nor any active Result.
      assert.equal(await hashFile(projectFile), authorBefore, 'no preview wrote the author timeline');
      await assert.rejects(readFile(resultFile), { code: 'ENOENT' });

      // (e) An EXPLICIT Take: the Placement selects the produced Take directly; POST does not grow.
      const edited = await loadProject(root);
      for (const placement of edited.composition!.placements) {
        if (placement.id !== 'pl_gen') continue;
        const mutable = placement as { source?: string; take?: string };
        delete mutable.source;
        mutable.take = genTake.id;
      }
      await saveProject(root, edited, edited.revision);
      const authorAfterEdit = await hashFile(projectFile);
      const byTake = await previewProject(root, { frames: [30, 34], ...endpointAuthorized(fixture.baseUrl) });
      assert.equal(byTake.status, 'succeeded', byTake.error);
      assert.equal(fixture.posts, 1, 'POST does not grow — an explicit Take is reused directly');
      assert.equal(await hashFile(projectFile), authorAfterEdit, 'the preview did not write the author timeline');
      await assert.rejects(readFile(resultFile), { code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test('a preview leaves the active Result and the author state byte-identical, reusing an existing provider Take', async () => {
  await withFixture(async fixture => {
    const root = await makeRoot();
    try {
      const projectFile = join(root, 'project.json');
      const resultFile = join(root, '.viscraft', 'result.json');

      const full = await buildProject(root, endpointAuthorized(fixture.baseUrl));
      assert.equal(full.status, 'succeeded', full.error);
      assert.equal(fixture.posts, 1, 'the full Build performs the provider first generation');
      const resultBefore = await readFile(resultFile);
      const authorBefore = await hashFile(projectFile);

      const preview = await previewProject(root, { frames: [30, 34], ...endpointAuthorized(fixture.baseUrl) });
      assert.equal(preview.status, 'succeeded', preview.error);
      assert.equal(preview.result, undefined, 'a preview writes no result');
      assert.equal(fixture.posts, 1, 'the preview reuses the successful provider job; POST does not grow');
      assert.deepEqual(await readFile(resultFile), resultBefore, 'the active Result is byte-identical after a preview');
      assert.equal(await hashFile(projectFile), authorBefore, 'the author timeline is byte-identical after a preview');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
