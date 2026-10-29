/**
 * Combination-chaining proof: a real keyframe image → a reference-conditioned
 * generated-video Take → mixed with a code-authored Take on ONE timeline.
 *
 * This chains a brief, a keyframe image, reference-conditioned video and mixed
 * editing through the current Runtime contract with no paid generation:
 *
 *  1. a real PNG keyframe (a host-tool-style output written into the authored
 *     area) is registered with the SDK `importAsset` — the image is byte-checked,
 *     hashed and given an Asset identity;
 *  2. a `provider` Source uses that image as an ordered `identity`
 *     reference (MiniMax-H3 Ref2VA);
 *  3. the animatic (code) Take and the generation candidate Take are produced
 *     through the normal Build path; the generation service is the documented
 *     LOOPBACK TEST FIXTURE, so the resulting Take is `simulated: true`;
 *  4. both Takes — a code render and a conditioned generation — are selected onto
 *     one composition timeline and composed into a single movie;
 *  5. the movie is delivered.
 *
 * No GPU, no real generative model and no external network are involved. The
 * fixture serves a deterministic FFmpeg test pattern and the Take is marked
 * `simulated`; this test proves the CONTROL CHAIN and composition wiring, not
 * any photographic quality of a real model.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildProject,
  deliverProject,
  importAsset,
  loadProject,
  probeMedia,
  saveProject,
  validateProject,
} from '../src/index.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { minimaxH3Ref2vaExtension } from '../src/backends/providers/models/minimax-h3.js';
import type { Project } from '../src/core/schema.js';

const JOB_ID = 'combinations_job_1';
const OUTPUT = { width: 320, height: 180, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 };
const RIGHTS = { origin: 'Original FFmpeg test fixture', license: 'CC0-1.0', redistributable: true };
const CODE_FRAMES = 20;

/** A deterministic CPU-canvas CodeScene: a coloured field with a moving bar. */
const SCENE = `<!doctype html><html><body style="margin:0;background:#000"><canvas id="c" style="display:block"></canvas><script>
window.viscraft = { render(ctx) {
  var c = document.getElementById('c'); c.width = ctx.width; c.height = ctx.height;
  var g = c.getContext('2d');
  g.fillStyle = '#0a1424'; g.fillRect(0, 0, ctx.width, ctx.height);
  g.fillStyle = '#e0b24a';
  g.fillRect((ctx.frame * 9) % Math.max(1, ctx.width - 8), 20, 8, ctx.height - 40);
}};</script></body></html>`;

/** Minimal multipart/form-data parser for the loopback fixture (test-only). */
function parseMultipart(
  body: Buffer,
  contentType: string | undefined,
): { fields: Record<string, string>; files: Array<{ name: string; data: Buffer }> } {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  const result = { fields: {} as Record<string, string>, files: [] as Array<{ name: string; data: Buffer }> };
  if (!match) return result;
  const boundary = Buffer.from(`--${(match[1] ?? match[2]).trim()}`, 'latin1');
  let index = body.indexOf(boundary);
  while (index !== -1) {
    const afterBoundary = index + boundary.length;
    if (body.subarray(afterBoundary, afterBoundary + 2).toString('latin1') === '--') break;
    const nextBoundary = body.indexOf(boundary, afterBoundary + 2);
    if (nextBoundary === -1) break;
    const part = body.subarray(afterBoundary + 2, nextBoundary);
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n', 'latin1'));
    if (headerEnd !== -1) {
      const headerText = part.subarray(0, headerEnd).toString('latin1');
      let data = part.subarray(headerEnd + 4);
      if (data.length >= 2 && data[data.length - 2] === 0x0d && data[data.length - 1] === 0x0a)
        data = data.subarray(0, data.length - 2);
      const name = /name="([^"]*)"/i.exec(headerText)?.[1];
      const filename = /filename="([^"]*)"/i.exec(headerText)?.[1];
      if (name !== undefined) {
        if (filename !== undefined) result.files.push({ name, data: Buffer.from(data) });
        else result.fields[name] = data.toString('utf8');
      }
    }
    index = nextBoundary;
  }
  return result;
}

/** The bootstrap project: one code Source placed, plus an (empty) second shot for the candidate. */
function bootstrapProject(): Project {
  return validateProject({
    schemaVersion: 1,
    id: 'combinations-e2e',
    revision: 1,
    title: 'SIMULATED keyframe → reference generation → mixed cut',
    direction: {
      intent: 'A code animatic and a keyframe-conditioned generation candidate share one timeline.',
      looks: [{ id: 'look', description: 'Explicitly simulated test pattern' }],
      transitions: [],
    },
    assets: [],
    bindings: {},
    sources: [
      {
        id: 'open',
        kind: 'browser',
        output: 'picture',
        entry: 'scene.html',
        resources: [],
        bindings: [],
        params: {},
        seed: 0,
        frames: CODE_FRAMES,
      },
    ],
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: 'One scene, two shots' }],
      shots: [
        { id: 'shot-a', scene: 'scene', look: 'look', intent: 'Code opening', targetFrames: CODE_FRAMES },
        { id: 'shot-b', scene: 'scene', look: 'look', intent: 'Keyframe-conditioned motion', targetFrames: 60 },
      ],
      placements: [
        {
          id: 'edit-a',
          shot: 'shot-a',
          source: 'open',
          inFrame: 0,
          outFrame: CODE_FRAMES,
          startFrame: 0,
          audio: 'mute',
        },
      ],
      transitions: [],
      audio: [],
    },
  });
}

test('keyframe image → reference video generation (simulated) → mixed with a code Take on one timeline → delivered', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-combinations-e2e-'));
  const delivery = root + '-delivery';
  let posts = 0;
  let downloads = 0;
  let uploadedSha = '';
  let base = '';
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', async () => {
      try {
        const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
        if (request.method === 'POST' && path === '/v1/videos') {
          posts++;
          const parsed = parseMultipart(Buffer.concat(chunks), request.headers['content-type']);
          const part = parsed.files.find(entry => entry.name === 'input_references');
          assert.ok(part, 'the keyframe image must be uploaded as an input_references part');
          uploadedSha = createHash('sha256').update(part.data).digest('hex');
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ id: JOB_ID, status: 'queued', model: 'MiniMax-H3' }));
        } else if (request.method === 'GET' && path === `/v1/videos/${JOB_ID}`) {
          response.setHeader('Content-Type', 'application/json');
          response.end(
            JSON.stringify({
              id: JOB_ID,
              status: 'completed',
              model: 'MiniMax-H3',
              error: null,
              inference_time_s: 2.5,
            }),
          );
        } else if (request.method === 'GET' && path === `/v1/videos/${JOB_ID}/content`) {
          downloads++;
          const media = await readFile(join(root, 'fixture.mp4'));
          response.setHeader('Content-Type', 'video/mp4');
          response.setHeader('Content-Length', String(media.length));
          response.end(media);
        } else {
          response.statusCode = 404;
          response.end();
        }
      } catch (error) {
        response.statusCode = 500;
        response.end(`fixture error: ${String(error)}`);
      }
    });
  });
  try {
    // 1. Real host-tool-style keyframe PNG + the code scene + the bootstrap project.
    await writeFile(join(root, 'scene.html'), SCENE);
    await runCommand('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=0x2f5d8c:s=320x180',
      '-frames:v',
      '1',
      '-threads',
      '1',
      join(root, 'keyframe.png'),
    ]);
    await writeFile(join(root, 'project.json'), JSON.stringify(bootstrapProject()));

    // 2. The host image enters the Project through the SDK registration path.
    const keyframe = await importAsset(root, {
      assetId: 'keyframe',
      sourcePath: join(root, 'keyframe.png'),
      type: 'image',
      rights: RIGHTS,
      expectedRevision: 1,
    });
    assert.equal(keyframe.type, 'image');
    assert.equal(keyframe.sha256, await hashFile(join(root, 'keyframe.png')));

    // 3. A generation Source conditions on that Asset as an ordered reference.
    const authored = await loadProject(root);
    authored.sources.push({
      id: 'motion',
      kind: 'provider',
      output: 'picture',
      endpoint: 'default',
      model: 'minimax-h3-base-ref2va',
      prompt: 'SIMULATED TEST-ONLY keyframe-conditioned motion',
      mode: 'reference',
      references: [{ asset: keyframe.id, category: 'image', role: 'identity' }],
      requestedFrames: 96,
      size: '768:768',
      fps: 24,
      steps: 30,
      seed: 7,
      attempt: 'combo-one',
    });
    await saveProject(root, authored, authored.revision);

    // 4. Animatic: the code Take (no provider involved, not simulated).
    const animatic = await buildProject(root);
    assert.equal(animatic.status, 'succeeded');
    assert.equal(animatic.result!.simulated, false);
    const codeTake = animatic.takes.find(take => take.source === 'open')!;
    if (codeTake.medium !== 'picture') assert.fail('the code Take must be a picture Take');
    assert.equal(codeTake.frames, CODE_FRAMES);

    // The loopback fixture serves a real 2 s / 24 fps MP4 (48 frames).
    await runCommand('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-threads',
      '2',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=24:duration=2',
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      join(root, 'fixture.mp4'),
    ]);
    await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', () => resolveListen()));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}`;

    // 5. The conditioned generation candidate: exactly one simulated POST.
    const options = {
      providers: { videoApi: { default: { testOnly: { baseUrl: base }, extension: minimaxH3Ref2vaExtension() } } },
    };
    const candidates = await buildProject(root, {
      candidates: [{ shot: 'shot-b', sources: ['motion'] }],
      ...options,
    });
    assert.equal(candidates.status, 'succeeded');
    assert.equal(posts, 1, 'exactly one POST');
    assert.equal(downloads, 1);
    assert.equal(uploadedSha, keyframe.sha256, 'the uploaded bytes must hash to the imported keyframe');
    const genTake = candidates.takes.find(take => take.source === 'motion')!;
    if (genTake.medium !== 'picture') assert.fail('the generated video Take must be a picture Take');
    assert.equal(genTake.simulated, true, 'a test-only run must be tainted simulated');
    assert.equal(genTake.frames, 60, '2 s of 24fps media normalized to the 30fps output clock');
    const genArtifact = candidates.artifacts.find(artifact => artifact.id === genTake.artifact)!;
    assert.equal(genArtifact.generation!.references[0].asset, keyframe.id);
    assert.equal(genArtifact.generation!.references[0].category, 'image');

    // 6. Mix: select the code Take and the generated Take onto one timeline.
    const mixed = await loadProject(root);
    mixed.composition!.placements = [
      {
        id: 'edit-a',
        shot: 'shot-a',
        take: codeTake.id,
        inFrame: 0,
        outFrame: CODE_FRAMES,
        startFrame: 0,
        audio: 'mute',
      },
      {
        id: 'edit-b',
        shot: 'shot-b',
        take: genTake.id,
        inFrame: 0,
        outFrame: genTake.frames,
        startFrame: CODE_FRAMES,
        audio: 'mute',
      },
    ];
    await saveProject(root, mixed, mixed.revision);
    const composed = await buildProject(root, options);
    assert.equal(composed.status, 'succeeded');
    assert.equal(posts, 1, 'selecting the Take must not re-submit');
    assert.ok(
      !composed.operations.some(operation => operation.kind === 'provider'),
      'a selected Take must not regenerate',
    );
    const final = composed.artifacts.find(artifact => artifact.id === composed.result!.artifact)!;
    assert.equal(final.media!.frames, CODE_FRAMES + genTake.frames, 'both shots compose into one programme');

    // 7. Deliver the mixed movie (simulated provenance propagates).
    const bundle = await deliverProject(root, delivery, { review: true, stems: true });
    assert.equal(bundle.simulated, true);
    assert.equal((await probeMedia(join(delivery, bundle.movie!.path))).frames, CODE_FRAMES + genTake.frames);
  } finally {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    await rm(root, { recursive: true, force: true });
    await rm(delivery, { recursive: true, force: true });
  }
});
