/**
 * Plan and Build share dependency and request checks. Invalid inputs produce
 * no operations or submissions; legal inputs still submit exactly once.
 */
import { strict as assert } from 'node:assert';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildProject, planBuild, validateProject } from '../src/index.js';
import { minimaxH3Ref2vaExtension } from '../src/backends/providers/models/minimax-h3.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import type { Project } from '../src/core/schema.js';

const OUTPUT = { width: 96, height: 64, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 2 };
const RIGHTS = { origin: 'original FFmpeg fixture', license: 'CC0-1.0', redistributable: true };

// ---------------------------------------------------------------------------
// Real FFmpeg fixtures (cached across cases)
// ---------------------------------------------------------------------------

async function ffmpeg(args: string[]): Promise<void> {
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1', ...args]);
}

let cachedVideo: Promise<Buffer> | undefined;
/** A 1 s 96x64@24 H.264 fixture the loopback provider serves as its result. */
function providerVideo(): Promise<Buffer> {
  cachedVideo ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'viscraft-preflight-media-'));
    try {
      const file = join(dir, 'provider.mp4');
      await ffmpeg([
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=96x64:rate=24:duration=1',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-an',
        file,
      ]);
      return await readFile(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })();
  return cachedVideo;
}

// ---------------------------------------------------------------------------
// Loopback provider (generic vllm-omni-video) whose POSTs are counted
// ---------------------------------------------------------------------------

interface Loopback {
  baseUrl: string;
  posts: number;
}

async function withLoopback(fn: (loop: Loopback) => Promise<void>): Promise<void> {
  const media = await providerVideo();
  const loop: Loopback = { baseUrl: '', posts: 0 };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = req.url ?? '/';
      if (req.method === 'POST' && url === '/v1/videos') {
        loop.posts++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `fixture_${loop.posts}`, status: 'queued' }));
        return;
      }
      if (req.method === 'GET' && /^\/v1\/videos\/fixture_\d+$/.test(url)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: url.split('/').at(-1), status: 'completed', error: null }));
        return;
      }
      if (req.method === 'GET' && /^\/v1\/videos\/fixture_\d+\/content$/.test(url)) {
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
  loop.baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  try {
    await fn(loop);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

/** The generic vllm-omni-video loopback options (no model definition/knowledge needed). */
const genericOptions = (baseUrl: string) => ({ providers: { videoApi: { default: { testOnly: { baseUrl } } } } });
/** The H3 definition on the generic lane, so the read-only request check runs. */
const h3Options = (baseUrl: string) => ({
  providers: { videoApi: { default: { testOnly: { baseUrl }, extension: minimaxH3Ref2vaExtension() } } },
});

// ---------------------------------------------------------------------------
// Authorship helpers
// ---------------------------------------------------------------------------

function providerSource(id: string, attempt: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    kind: 'provider',
    output: 'picture',
    endpoint: 'default',
    model: 'fixture-video',
    prompt: `fixture ${id}`,
    mode: 'text',
    references: [],
    requestedFrames: 12,
    size: '96:64',
    fps: 24,
    attempt,
    ...extra,
  };
}

const silentAsset = (sha256: string) => ({
  id: 'silent',
  revision: 1,
  type: 'video',
  path: 'silent.mp4',
  sha256,
  rights: RIGHTS,
  simulated: false,
});

interface ProjectParts {
  assets: unknown[];
  sources: unknown[];
  placements: unknown[];
  audio?: unknown[];
  layers?: unknown[];
}

function makeProject(parts: ProjectParts): Project {
  return validateProject({
    schemaVersion: 1,
    id: 'preflight-parity',
    revision: 1,
    title: 'Preflight parity',
    direction: { intent: 'preflight parity', looks: [{ id: 'look', description: 'look' }], transitions: [] },
    assets: parts.assets,
    bindings: {},
    sources: parts.sources,
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: 'scene' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: 'shot', targetFrames: 120 }],
      placements: parts.placements,
      transitions: [],
      audio: parts.audio ?? [],
      ...(parts.layers ? { layers: parts.layers } : {}),
    },
  });
}

async function writeProject(root: string, project: Project): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
}

interface StoredBuild {
  status: string;
  operations: Array<{ kind: string }>;
  artifacts: Array<{ id: string; path: string; sha256: string }>;
  takes: Array<{ id: string; asset?: string }>;
}

async function readBuildRecords(root: string): Promise<StoredBuild[]> {
  const dir = join(root, '.viscraft', 'builds');
  const names = (await readdir(dir)).filter(name => name.endsWith('.json')).sort();
  return Promise.all(names.map(async name => JSON.parse(await readFile(join(dir, name), 'utf8')) as StoredBuild));
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-preflight-parity-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function silentVideo(root: string): Promise<string> {
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=96x64:rate=24:duration=1',
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    join(root, 'silent.mp4'),
  ]);
  return hashFile(join(root, 'silent.mp4'));
}

// ---------------------------------------------------------------------------
// a keep over a silent video Asset
// ---------------------------------------------------------------------------

test('a keep over a silent video Asset is refused before any POST', async () => {
  await withRoot(async root => {
    const silentSha = await silentVideo(root);
    await withLoopback(async loop => {
      await writeProject(
        root,
        makeProject({
          assets: [silentAsset(silentSha)],
          sources: [providerSource('gen', 'attempt_gen')],
          placements: [
            { id: 'main', shot: 'shot', source: 'gen', inFrame: 0, outFrame: 12, startFrame: 0, audio: 'mute' },
            { id: 'sil', shot: 'shot', asset: 'silent', inFrame: 0, outFrame: 12, startFrame: 12, audio: 'keep' },
          ],
        }),
      );

      const plan = await planBuild(root, genericOptions(loop.baseUrl));
      assert.equal(plan.buildable, false);
      assert.ok(
        plan.blockers.some(issue => issue.code === 'keep-audio-on-silent-asset' && issue.subject === 'sil'),
        `expected a keep-audio-on-silent-asset blocker, got ${JSON.stringify(plan.blockers)}`,
      );

      await assert.rejects(
        () => buildProject(root, genericOptions(loop.baseUrl)),
        /Placement sil has audio "keep" but its video Asset silent has no audio stream/,
      );
      assert.equal(loop.posts, 0, 'no provider POST may precede the silent-Asset keep refusal');
      const records = await readBuildRecords(root);
      assert.equal(records.length, 1);
      assert.equal(records[0].status, 'failed');
      assert.equal(records[0].operations.length, 0, 'no capture/normalize may precede the refusal');
      assert.equal(records[0].artifacts.length, 0, 'no artifact may be produced before the refusal');
    });
  });
});

// ---------------------------------------------------------------------------
// an asset audio clip reading past its Asset's length
// ---------------------------------------------------------------------------

test('an asset audio clip reading past its Asset is refused before any POST', async () => {
  await withRoot(async root => {
    const silentSha = await silentVideo(root);
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=1',
      '-ac',
      '2',
      '-ar',
      '48000',
      '-c:a',
      'pcm_s16le',
      join(root, 'bed.wav'),
    ]);
    const bedSha = await hashFile(join(root, 'bed.wav'));
    await withLoopback(async loop => {
      await writeProject(
        root,
        makeProject({
          assets: [
            silentAsset(silentSha),
            {
              id: 'bed',
              revision: 1,
              type: 'audio',
              path: 'bed.wav',
              sha256: bedSha,
              rights: RIGHTS,
              simulated: false,
            },
          ],
          sources: [providerSource('gen', 'attempt_gen')],
          placements: [
            { id: 'main', shot: 'shot', source: 'gen', inFrame: 0, outFrame: 12, startFrame: 0, audio: 'mute' },
          ],
          audio: [
            {
              id: 'music',
              kind: 'asset',
              asset: 'bed',
              inSample: 0,
              startSample: 0,
              durationSamples: 96000,
              gain: 0.2,
              fadeInSamples: 0,
              fadeOutSamples: 0,
            },
          ],
        }),
      );

      const plan = await planBuild(root, genericOptions(loop.baseUrl));
      assert.equal(plan.buildable, false);
      assert.ok(
        plan.blockers.some(issue => issue.code === 'audio-clip-reads-beyond-asset' && issue.subject === 'music'),
        `expected an audio-clip-reads-beyond-asset blocker, got ${JSON.stringify(plan.blockers)}`,
      );

      await assert.rejects(
        () => buildProject(root, genericOptions(loop.baseUrl)),
        /Audio clip music reads samples \[0, 96000\) beyond Asset bed/,
      );
      assert.equal(loop.posts, 0, 'no provider POST may precede the audio-clip interval refusal');
      const records = await readBuildRecords(root);
      assert.equal(records[0].status, 'failed');
      assert.equal(records[0].operations.length, 0, 'no picture/audio operation may precede the refusal');
    });
  });
});

// ---------------------------------------------------------------------------
// a picture layer selecting a Take whose Artifact file is gone
// ---------------------------------------------------------------------------

test('a picture layer whose selected Take artifact is missing is refused before any POST', async () => {
  await withRoot(async root => {
    const silentSha = await silentVideo(root);
    await withLoopback(async loop => {
      // Produce a real Take first (a local normalize), then remove its bytes.
      await writeProject(
        root,
        makeProject({
          assets: [silentAsset(silentSha)],
          sources: [],
          placements: [
            { id: 'main', shot: 'shot', asset: 'silent', inFrame: 0, outFrame: 12, startFrame: 0, audio: 'mute' },
          ],
        }),
      );
      const first = await buildProject(root, genericOptions(loop.baseUrl));
      const take = first.takes.find(entry => entry.asset === 'silent')!;
      const artifact = first.artifacts.find(entry => entry.id === take.artifact)!;
      await rm(join(root, artifact.path), { force: true });
      await assert.rejects(stat(join(root, artifact.path)), 'the artifact file must be gone');

      // Now a project whose LAYER selects that Take, over a provider base picture.
      await writeProject(
        root,
        makeProject({
          assets: [silentAsset(silentSha)],
          sources: [providerSource('gen', 'attempt_gen')],
          placements: [
            { id: 'main', shot: 'shot', source: 'gen', inFrame: 0, outFrame: 12, startFrame: 0, audio: 'mute' },
          ],
          layers: [
            {
              id: 'ov',
              take: take.id,
              inFrame: 0,
              outFrame: 4,
              startFrame: 2,
              x: 0,
              y: 0,
              width: 32,
              height: 24,
              opacity: 1,
            },
          ],
        }),
      );

      const plan = await planBuild(root, genericOptions(loop.baseUrl));
      assert.equal(plan.buildable, false);
      assert.ok(
        plan.blockers.some(issue => issue.code === 'selected-take-missing' && issue.subject === 'ov'),
        `expected a selected-take-missing layer blocker, got ${JSON.stringify(plan.blockers)}`,
      );

      await assert.rejects(
        () => buildProject(root, genericOptions(loop.baseUrl)),
        /Picture layer ov selects Take take-[0-9a-f]+, but its artifact .* is missing or its hash no longer matches/,
      );
      assert.equal(loop.posts, 0, 'no provider POST may precede the layer Take-artifact refusal');
      const records = await readBuildRecords(root);
      const refused = records.find(record => record.status === 'failed');
      assert.ok(refused, 'the refused Build is recorded as failed');
      assert.equal(refused.operations.length, 0, 'no capture/layer op may precede the refusal');
    });
  });
});

// ---------------------------------------------------------------------------
// a later provider Source whose read-only request is invalid
// ---------------------------------------------------------------------------

test('a later consumed code file is checked before any earlier provider submission', async () => {
  await withRoot(async root => {
    await withLoopback(async loop => {
      await writeProject(
        root,
        makeProject({
          assets: [],
          sources: [
            providerSource('remote', 'attempt_remote'),
            {
              id: 'code',
              kind: 'browser',
              output: 'picture',
              entry: 'missing.html',
              resources: [],
              bindings: [],
              params: {},
              seed: 0,
              frames: 12,
            },
          ],
          placements: [
            { id: 'first', shot: 'shot', source: 'remote', inFrame: 0, outFrame: 12, startFrame: 0, audio: 'mute' },
            { id: 'second', shot: 'shot', source: 'code', inFrame: 0, outFrame: 12, startFrame: 12, audio: 'mute' },
          ],
        }),
      );
      const options = genericOptions(loop.baseUrl);
      const plan = await planBuild(root, options);
      assert.equal(plan.buildable, false);
      assert.ok(plan.blockers.some(issue => issue.code === 'source-input-unavailable' && issue.subject === 'code'));
      await assert.rejects(() => buildProject(root, options), /Source code.*missing\.html.*not available/);
      assert.equal(loop.posts, 0, 'a missing later code input must not allow an earlier POST');
      const records = await readBuildRecords(root);
      assert.equal(records.length, 1);
      assert.equal(records[0].status, 'failed');
      assert.equal(records[0].operations.length, 0);
      assert.equal(records[0].artifacts.length, 0);
    });
  });
});

test('a later provider Source with an invalid request is refused before the first is generated', async () => {
  await withRoot(async root => {
    const silentSha = await silentVideo(root);
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=16x16:rate=1:duration=1',
      '-frames:v',
      '1',
      '-pix_fmt',
      'rgb24',
      join(root, 'ref.png'),
    ]);
    const refSha = await hashFile(join(root, 'ref.png'));
    await withLoopback(async loop => {
      await writeProject(
        root,
        makeProject({
          assets: [
            silentAsset(silentSha),
            {
              id: 'ref',
              revision: 1,
              type: 'image',
              path: 'ref.png',
              sha256: refSha,
              rights: RIGHTS,
              simulated: false,
            },
          ],
          sources: [
            // LEGAL: H3 reference mode with an image reference (Ref2VA is served).
            providerSource('ok', 'attempt_ok', {
              model: 'minimax-h3-base-ref2va',
              mode: 'reference',
              references: [{ asset: 'ref', category: 'image', role: 'identity' }],
            }),
            // INVALID: H3 text mode needs an FL2VA deployment the test-only lane does not declare.
            providerSource('bad', 'attempt_bad', { model: 'minimax-h3-base-ref2va', mode: 'text', references: [] }),
          ],
          placements: [
            { id: 'pl_ok', shot: 'shot', source: 'ok', inFrame: 0, outFrame: 12, startFrame: 0, audio: 'mute' },
            { id: 'pl_bad', shot: 'shot', source: 'bad', inFrame: 0, outFrame: 12, startFrame: 12, audio: 'mute' },
          ],
        }),
      );

      const plan = await planBuild(root, h3Options(loop.baseUrl));
      assert.equal(plan.buildable, false);
      assert.ok(
        plan.blockers.some(issue => issue.code === 'model-request-invalid' && issue.subject === 'bad'),
        `expected a model-request-invalid blocker for the bad Source, got ${JSON.stringify(plan.blockers)}`,
      );
      assert.ok(
        !plan.blockers.some(issue => issue.subject === 'ok' || issue.subject === 'pl_ok'),
        'the legal first Source must not be blocked',
      );

      await assert.rejects(
        () => buildProject(root, h3Options(loop.baseUrl)),
        /is invalid for model minimax-h3-base-ref2va/,
      );
      assert.equal(loop.posts, 0, 'the FIRST Source must not be generated before the request error is consumed');
      const records = await readBuildRecords(root);
      assert.equal(records[0].status, 'failed');
      assert.equal(records[0].operations.length, 0, 'no operation may precede the whole-request preflight');
      assert.equal(records[0].artifacts.length, 0);
    });
  });
});

// ---------------------------------------------------------------------------
// positive — two LEGAL provider Sources still build with exactly two POSTs
// ---------------------------------------------------------------------------

test('two legal provider Sources still build with exactly two POSTs', async () => {
  await withRoot(async root => {
    const silentSha = await silentVideo(root);
    await withLoopback(async loop => {
      await writeProject(
        root,
        makeProject({
          assets: [silentAsset(silentSha)],
          sources: [providerSource('a', 'attempt_a'), providerSource('b', 'attempt_b')],
          placements: [
            { id: 'pl_a', shot: 'shot', source: 'a', inFrame: 0, outFrame: 12, startFrame: 0, audio: 'mute' },
            { id: 'pl_b', shot: 'shot', source: 'b', inFrame: 0, outFrame: 12, startFrame: 12, audio: 'mute' },
          ],
        }),
      );

      const plan = await planBuild(root, genericOptions(loop.baseUrl));
      assert.equal(plan.buildable, true, `a legal two-source plan must be buildable: ${JSON.stringify(plan.blockers)}`);

      const build = await buildProject(root, genericOptions(loop.baseUrl));
      assert.equal(build.status, 'succeeded');
      assert.equal(loop.posts, 2, 'each distinct legal Source is generated exactly once');
    });
  });
});
