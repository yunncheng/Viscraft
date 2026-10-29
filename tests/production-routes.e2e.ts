/**
 * Composition evidence for the two production routes.
 *
 * ROUTE 1 — proxy video → final video (Test A, the most important chain):
 *   a small real Browser/Code proxy with real motion/occlusion change is rendered
 *   to a REAL video Take; one frame is promoted to an image Asset (`promoteFrame`)
 *   with `derivedFrom{kind:'frame',...}`; a SIMULATED vllm-omni-image service produces a
 *   decodable TARGET image whose `Asset.inputs` record the promoted parent; the
 *   proxy VIDEO (imported as a video Asset — no Take→video promotion exists yet, so
 *   the artifact is byte-copied outside root and re-imported) and the TARGET image
 *   are passed TOGETHER, in order, into a SIMULATED MiniMax-H3 Ref2VA service; the
 *   accepted Take is selected, composed and delivered; the exported project
 *   rebuilds from cache without a second POST. Preservation (a new target variant
 *   under the SAME attempt is refused; the proxy Asset and the accepted Take media
 *   are untouched) and a per-Asset transmission-consent refusal (before any POST)
 *   are also asserted.
 *
 * ROUTE 2 — playable World recording, two uses (Test B):
 *   the direct-edit branch selects a recorded replay Take with NO generation
 *   service configured; the re-creation branch imports the recording's
 *   `preview.mp4` as a video Asset and feeds it as the H3 `motion` reference. The
 *   safe-variant branch records R1, creates a NEW author source and re-records the
 *   SAME events into R2, proves R1's session/media bytes are unchanged, and proves
 *   an OLD session replayed against the CHANGED source is refused.
 *
 * HONESTY / REAL vs SIMULATED:
 *   - REAL: Browser capture, FFmpeg Build/compose/mux, `promoteFrame` decode,
 *     `importAsset` real media decode, hash/probe bookkeeping.
 *   - SIMULATED / TEST-ONLY: the vllm-omni-image and vllm-omni-video services are loopback
 *     `testOnly` fixtures that speak the documented protocols and serve
 *     deterministic FFmpeg media. No GPU, no real model, no paid call, no
 *     external network. The H3 Take is `simulated: true`.
 *   - NOT CLAIMED: visual edit quality, motion fidelity or aesthetics.
 *     This file proves the CONTROL CHAIN, provenance, bytes/hashes/order,
 *     authorization and reuse only.
 *
 * Shared authoring, reference, World and provider fixtures keep both routes on
 * the ordinary Project/Build/selection/delivery contract.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildProject,
  captureReplay,
  deliverProject,
  exportProject,
  generateImage,
  importAsset,
  inspectAssetInputs,
  loadProject,
  probeMedia,
  promoteFrame,
  recordPlayable,
  saveProject,
  validateProject,
  type BrowserPictureSource,
  type OutputSettings,
  type PlayableInput,
  type Project,
  type ProviderSource,
} from '../src/index.js';
import { generateVideoApi, videoApiStatus } from '../src/backends/providers/services/video-tasks.js';
import { minimaxH3Ref2vaExtension } from '../src/backends/providers/models/minimax-h3.js';
import { hashFile, stableHash } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';

const RIGHTS = { origin: 'Original FFmpeg test fixture', license: 'CC0-1.0', redistributable: true };

// The proxy raster must satisfy MiniMax-H3's reference-VIDEO profile
// (`validateMinimaxH3Video`: min(width,height) >= 256). A 96x64 preview would be
// refused as a motion reference, so the proxy is authored at 320x256.
const OUTPUT: OutputSettings = {
  width: 320,
  height: 256,
  fps: { numerator: 30, denominator: 1 },
  sampleRate: 48000,
  channels: 2,
};
// 3 s at 30 fps: inside H3's 2..15 s reference-video window with margin.
const PROXY_FRAMES = 90;
const FRAME_INDEX = 30;

/** A deterministic CodeScene with real motion and an occlusion/contact change. */
const PROXY_SCENE = `<!doctype html><html><body style="margin:0;background:#000"><canvas id="c" style="display:block"></canvas><script>
window.viscraft = { render(ctx) {
  var c = document.getElementById('c'); c.width = ctx.width; c.height = ctx.height;
  var g = c.getContext('2d');
  g.fillStyle = '#0a1424'; g.fillRect(0, 0, ctx.width, ctx.height);
  // A camera-panning ground line: shifts with the frame index.
  var pan = (ctx.frame * 3) % ctx.width;
  g.fillStyle = '#204060'; g.fillRect(0, ctx.height - 60, ctx.width, 60);
  g.fillStyle = '#356089'; g.fillRect(-pan, ctx.height - 60, 40, 60);
  g.fillRect(ctx.width - pan, ctx.height - 60, 40, 60);
  // A foreground block that crosses and occludes a background marker.
  g.fillStyle = '#e0b24a';
  var x = (ctx.frame * 5) % Math.max(1, ctx.width - 48);
  g.fillRect(120, 40, 48, 48);
  g.fillStyle = '#b02a2a';
  g.fillRect(x, 100, 64, 64);
}};</script></body></html>`;

/** Minimal multipart/form-data parser for the loopback fixtures (test-only). */
function parseMultipart(
  body: Buffer,
  contentType: string | undefined,
): { fields: Record<string, string>; files: Array<{ name: string; filename?: string; type?: string; data: Buffer }> } {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  const result = {
    fields: {} as Record<string, string>,
    files: [] as Array<{ name: string; filename?: string; type?: string; data: Buffer }>,
  };
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

// ---------------------------------------------------------------------------
// Loopback fixtures (test-only)
// ---------------------------------------------------------------------------

interface VideoFixtureState {
  posts: number;
  gets: number;
  downloads: number;
  uploads: Array<{ name: string; type?: string; sha256: string }>;
}

/** A documented vllm-omni-video loopback: one POST, one status GET, one content GET. */
async function startVideoFixture(
  media: Buffer,
): Promise<{ baseUrl: string; state: VideoFixtureState; close: () => Promise<void> }> {
  const state: VideoFixtureState = { posts: 0, gets: 0, downloads: 0, uploads: [] };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      try {
        const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
        if (request.method === 'POST' && path === '/v1/videos') {
          state.posts++;
          const parsed = parseMultipart(Buffer.concat(chunks), request.headers['content-type']);
          state.uploads = parsed.files.map(file => ({
            name: file.name,
            type: file.type,
            sha256: createHash('sha256').update(file.data).digest('hex'),
          }));
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ id: 'routes_job_1', status: 'queued', model: 'MiniMax-H3' }));
        } else if (request.method === 'GET' && path === '/v1/videos/routes_job_1') {
          state.gets++;
          response.setHeader('Content-Type', 'application/json');
          response.end(
            JSON.stringify({
              id: 'routes_job_1',
              status: 'completed',
              model: 'MiniMax-H3',
              error: null,
              inference_time_s: 3,
            }),
          );
        } else if (request.method === 'GET' && path === '/v1/videos/routes_job_1/content') {
          state.downloads++;
          response.setHeader('Content-Type', 'video/mp4');
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
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    state,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

interface ImageFixtureState {
  requests: Array<{ path: string; body: Buffer }>;
}

/**
 * A documented vllm-omni-image loopback. It returns image A for requests whose body
 * does not contain `marker`, and image B for requests that do — so a second,
 * genuinely DIFFERENT target variant can be produced deterministically.
 */
async function startImageFixture(
  imageA: Buffer,
  imageB: Buffer,
  marker: string,
): Promise<{ baseUrl: string; state: ImageFixtureState; close: () => Promise<void> }> {
  const state: ImageFixtureState = { requests: [] };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (!(request.method === 'POST' && (path === '/v1/images/generations' || path === '/v1/images/edits'))) {
        response.statusCode = 404;
        response.end('nf');
        return;
      }
      const body = Buffer.concat(chunks);
      state.requests.push({ path, body });
      const png = body.includes(Buffer.from(marker, 'utf8')) ? imageB : imageA;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ created: 1, data: [{ b64_json: png.toString('base64') }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    state,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

/** A deterministic real PNG fixture of one solid colour. */
async function solidPng(file: string, colour: string, size = 96): Promise<Buffer> {
  await runCommand('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-threads',
    '1',
    '-f',
    'lavfi',
    '-i',
    `color=c=${colour}:s=${size}x${size}`,
    '-frames:v',
    '1',
    '-pix_fmt',
    'rgb24',
    file,
  ]);
  return readFile(file);
}

/** A deterministic real reference clip that satisfies H3's reference-video profile. */
async function referenceClip(file: string): Promise<Buffer> {
  await runCommand('ffmpeg', [
    '-v',
    'error',
    '-y',
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
  return readFile(file);
}

const imageOptions = (baseUrl: string) => ({ providers: { imageApi: { test: { testOnly: { baseUrl } } } } });
const videoOptions = (baseUrl: string) => ({
  providers: { videoApi: { default: { testOnly: { baseUrl }, extension: minimaxH3Ref2vaExtension() } } },
});

function bootstrapProject(): Project {
  return validateProject({
    schemaVersion: 1,
    id: 'production-routes-proxy',
    revision: 1,
    title: 'SIMULATED proxy -> final video production route',
    direction: {
      intent: 'A real browser proxy is chained into a simulated joint-reference video service.',
      looks: [{ id: 'look', description: 'Explicitly simulated test pattern' }],
      transitions: [],
    },
    assets: [],
    bindings: {},
    sources: [
      {
        id: 'proxy',
        kind: 'browser',
        output: 'picture',
        entry: 'proxy.html',
        resources: [],
        bindings: [],
        params: {},
        seed: 0,
        frames: PROXY_FRAMES,
      },
    ],
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: 'One scene, one shot' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: 'Proxy then final', targetFrames: PROXY_FRAMES }],
      placements: [
        {
          id: 'edit',
          shot: 'shot',
          source: 'proxy',
          inFrame: 0,
          outFrame: PROXY_FRAMES,
          startFrame: 0,
          audio: 'mute',
        },
      ],
      transitions: [],
      audio: [],
    },
  });
}

test('ROUTE 1 (simulated): real proxy video + edited target image -> H3 joint reference -> Take -> compose -> deliver -> reuse, with preservation + consent refusals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-routes-a-'));
  const delivery = `${root}-delivery`;
  const exported = `${root}-export`;
  const staging = await mkdtemp(join(tmpdir(), 'viscraft-routes-a-media-'));
  try {
    const imageA = await solidPng(join(staging, 'a.png'), '0x2f5d8c');
    const imageB = await solidPng(join(staging, 'b.png'), '0x8c2f5d');
    assert.notEqual(
      createHash('sha256').update(imageA).digest('hex'),
      createHash('sha256').update(imageB).digest('hex'),
      'the two target variants must be genuinely different bytes',
    );
    const clip = await referenceClip(join(staging, 'clip.mp4'));

    await writeFile(join(root, 'proxy.html'), PROXY_SCENE);
    await writeFile(join(root, 'project.json'), JSON.stringify(bootstrapProject()));

    const image = await startImageFixture(imageA, imageB, 'VARIANT-B');
    const video = await startVideoFixture(clip);
    try {
      // 1. REAL proxy: the browser/Code Source is rendered through the normal Build.
      const animatic = await buildProject(root);
      assert.equal(animatic.status, 'succeeded', JSON.stringify(animatic.error));
      assert.equal(animatic.result!.simulated, false);
      const proxyTake = animatic.takes.find(take => take.source === 'proxy');
      assert.ok(proxyTake, 'the proxy Source must produce a Take');
      if (proxyTake.medium !== 'picture') assert.fail('the proxy Take must be a picture Take');
      assert.equal(proxyTake.simulated, false, 'a real code render is not simulated');
      assert.equal(proxyTake.frames, PROXY_FRAMES);
      const proxyArtifact = animatic.artifacts.find(artifact => artifact.id === proxyTake.artifact);
      assert.ok(proxyArtifact);
      assert.equal(proxyArtifact.kind, 'video');
      assert.equal(proxyArtifact.media!.frames, PROXY_FRAMES);
      assert.equal(proxyArtifact.media!.width, OUTPUT.width);
      assert.equal(proxyArtifact.media!.height, OUTPUT.height);

      // 2. REAL frame promotion: approve one decoded proxy frame as an image Asset.
      const afterAnimatic = await loadProject(root);
      const frameAsset = await promoteFrame(root, {
        take: proxyTake.id,
        frame: FRAME_INDEX,
        assetId: 'proxy-frame',
        rights: RIGHTS,
        expectedRevision: afterAnimatic.revision,
      });
      assert.equal(frameAsset.type, 'image');
      assert.equal(frameAsset.simulated, false, 'the proxy is real, so its frame is not tainted');
      assert.ok(frameAsset.derivedFrom, 'a promoted frame records its provenance');
      assert.equal(frameAsset.derivedFrom!.kind, 'frame');
      assert.equal(frameAsset.derivedFrom!.artifact, proxyArtifact.id);
      assert.equal(frameAsset.derivedFrom!.sha256, proxyArtifact.sha256);
      assert.equal(frameAsset.derivedFrom!.frame, FRAME_INDEX);
      assert.equal(frameAsset.derivedFrom!.take, proxyTake.id);
      const frameInfo = await probeMedia(join(root, frameAsset.path));
      assert.equal(frameInfo.frames, 1);
      assert.equal(frameInfo.width, OUTPUT.width);
      assert.equal(frameInfo.height, OUTPUT.height);

      // 3. SIMULATED image edit: the promoted frame is the frozen identity parent.
      const target = await generateImage(
        root,
        {
          id: 'req-target',
          attempt: 1,
          asset: 'target',
          rights: RIGHTS,
          endpoint: 'test',
          operation: 'edit',
          model: 'Qwen-Image',
          prompt: 'SIMULATED TEST-ONLY repaint of the promoted proxy frame',
          references: [{ asset: 'proxy-frame', category: 'image', role: 'identity' }],
        },
        imageOptions(image.baseUrl),
      );
      assert.equal(image.state.requests.length, 1, 'exactly one image request');
      assert.equal(image.state.requests[0].path, '/v1/images/edits');
      assert.equal(target.asset.imageGeneration!.operation, 'edit');
      assert.deepEqual(target.asset.inputs, [
        { asset: 'proxy-frame', revision: frameAsset.revision, sha256: frameAsset.sha256, role: 'identity' },
      ]);
      assert.equal(
        inspectAssetInputs(await loadProject(root)).find(status => status.asset === 'target')!.status,
        'current',
        'the recorded parent relation matches the live parent',
      );
      // The produced target is a real decodable image and its bytes are the Asset bytes.
      assert.equal(await hashFile(join(root, target.asset.path)), target.asset.sha256);
      const targetInfo = await probeMedia(join(root, target.asset.path));
      assert.equal(targetInfo.frames, 1);
      assert.ok(targetInfo.width > 0 && targetInfo.height > 0);

      // 4. Make the proxy video a video Asset. There is NO Take/Artifact -> video
      // promotion, so the artifact is byte-copied OUTSIDE root
      // and re-imported. NOTE: an imported video carries no `derivedFrom` — that
      // absence is exactly why this is a documented workaround, not a provenance
      // claim.
      const proxySource = join(staging, 'proxy.mp4');
      await copyFile(join(root, proxyArtifact.path), proxySource);
      const afterTarget = await loadProject(root);
      const proxyAsset = await importAsset(root, {
        assetId: 'proxy',
        sourcePath: proxySource,
        type: 'video',
        rights: RIGHTS,
        expectedSha256: proxyArtifact.sha256,
        expectedRevision: afterTarget.revision,
      });
      assert.equal(proxyAsset.type, 'video');
      assert.equal(proxyAsset.sha256, proxyArtifact.sha256, 'the video Asset must carry the artifact bytes');
      assert.equal(proxyAsset.derivedFrom, undefined, 'an imported video has no promoted provenance (the workaround)');

      // 5. SIMULATED joint-reference video service: target image + proxy video.
      const authored = await loadProject(root);
      authored.sources.push({
        id: 'motion',
        kind: 'provider',
        output: 'picture',
        endpoint: 'default',
        model: 'minimax-h3-base-ref2va',
        prompt: 'SIMULATED TEST-ONLY joint reference from the proxy video and its edited target image',
        mode: 'reference',
        references: [
          { asset: 'target', category: 'image', role: 'identity' },
          { asset: 'proxy', category: 'video', role: 'motion' },
        ],
        requestedFrames: 60,
        size: '768:768',
        fps: 24,
        steps: 30,
        seed: 7,
        attempt: 'h3-joint-one',
      });
      await saveProject(root, authored, authored.revision);

      const candidates = await buildProject(root, {
        candidates: [{ shot: 'shot', sources: ['motion'] }],
        ...videoOptions(video.baseUrl),
      });
      assert.equal(candidates.status, 'succeeded', JSON.stringify(candidates.error));
      assert.equal(video.state.posts, 1, 'exactly one POST to the video service');
      assert.equal(video.state.gets, 1);
      assert.equal(video.state.downloads, 1);

      // The transmitted bytes, in the DECLARED order: frozen target image, proxy video.
      assert.equal(video.state.uploads.length, 2, 'image and video must both be uploaded');
      assert.deepEqual(
        video.state.uploads.map(entry => entry.name),
        ['input_references', 'input_references'],
      );
      assert.deepEqual(
        video.state.uploads.map(entry => entry.type),
        ['image/png', 'video/mp4'],
      );
      assert.deepEqual(
        video.state.uploads.map(entry => entry.sha256),
        [target.asset.sha256, proxyAsset.sha256],
        'the uploaded bytes must hash to the frozen target and proxy Assets, in order',
      );

      const take = candidates.takes.find(candidate => candidate.source === 'motion');
      assert.ok(take);
      if (take.medium !== 'picture') assert.fail('the generated video Take must be a picture Take');
      assert.equal(take.simulated, true, 'a test-only run must be tainted simulated');
      const artifact = candidates.artifacts.find(candidate => candidate.id === take.artifact)!;
      assert.match(artifact.backend, /test-only/);
      assert.deepEqual(artifact.generation!.references[0], {
        asset: 'target',
        sha256: target.asset.sha256,
        category: 'image',
        role: 'identity',
      });
      assert.equal(artifact.generation!.references[1].asset, 'proxy');
      assert.equal(artifact.generation!.references[1].category, 'video');
      assert.equal(artifact.generation!.references[1].role, 'motion');
      assert.equal(artifact.generation!.references[1].sha256, proxyAsset.sha256);
      assert.equal(artifact.generation!.references[1].media!.frames, PROXY_FRAMES);

      // 6. Select the Take: no model pass, then compose, deliver and re-open.
      const selected = await loadProject(root);
      selected.composition!.placements = [
        { id: 'edit', shot: 'shot', take: take.id, inFrame: 0, outFrame: take.frames, startFrame: 0, audio: 'mute' },
      ];
      await saveProject(root, selected, selected.revision);
      const movie = await buildProject(root, videoOptions(video.baseUrl));
      assert.equal(movie.status, 'succeeded', JSON.stringify(movie.error));
      assert.ok(
        !movie.operations.some(operation => operation.kind === 'provider'),
        'a selected Take must not regenerate',
      );
      assert.equal(video.state.posts, 1, 'selecting the Take must not re-submit');
      assert.equal(
        movie.artifacts.find(candidate => candidate.id === movie.result!.artifact)!.media!.frames,
        take.frames,
      );

      const bundle = await deliverProject(root, delivery, { review: true, stems: true });
      assert.equal(bundle.simulated, true, 'simulated provenance must propagate into the delivery');
      assert.equal((await probeMedia(join(delivery, bundle.movie!.path))).frames, take.frames);

      await exportProject(root, exported);
      const reopened = await buildProject(exported);
      assert.ok(
        reopened.operations.every(operation => operation.reused),
        'the exported project must rebuild from cached artifacts',
      );
      assert.equal(reopened.result!.simulated, true);
      assert.equal(video.state.posts, 1, 'reopening the exported project must not POST again');
      assert.equal((await videoApiStatus(root)).length, 1);

      // 7. Preservation: a NEW target variant re-pointed under the SAME attempt is
      // refused; the proxy Asset and the accepted Take media are untouched.
      const acceptedMediaPath = join(root, artifact.path);
      const acceptedMediaSha = artifact.sha256;
      const proxySha = proxyAsset.sha256;
      const variant = await generateImage(
        root,
        {
          id: 'req-target-2',
          attempt: 1,
          asset: 'target2',
          rights: RIGHTS,
          endpoint: 'test',
          operation: 'edit',
          model: 'Qwen-Image',
          prompt: 'SIMULATED TEST-ONLY VARIANT-B repaint of the promoted proxy frame',
          references: [{ asset: 'proxy-frame', category: 'image', role: 'identity' }],
        },
        imageOptions(image.baseUrl),
      );
      assert.notEqual(variant.asset.sha256, target.asset.sha256, 'the variant must be a different image');

      const repointed = await loadProject(root);
      const motion = repointed.sources.find(source => source.id === 'motion');
      assert.equal(motion?.kind, 'provider');
      if (motion?.kind !== 'provider') throw new Error('wrong fixture Source');
      motion.references = [{ asset: 'target2', category: 'image', role: 'identity' }, motion.references[1]];
      repointed.composition!.placements = [
        { id: 'edit', shot: 'shot', source: 'motion', inFrame: 0, outFrame: take.frames, startFrame: 0, audio: 'mute' },
      ];
      await saveProject(root, repointed, repointed.revision);
      await assert.rejects(
        () =>
          buildProject(root, {
            candidates: [{ shot: 'shot', sources: ['motion'] }],
            ...videoOptions(video.baseUrl),
          }),
        /different frozen request|new attempt/i,
      );
      assert.equal(video.state.posts, 1, 'a changed reference must not reach the service');
      assert.equal((await videoApiStatus(root)).length, 1, 'no new job record is created');
      const afterReject = await loadProject(root);
      assert.equal(afterReject.assets.find(asset => asset.id === 'proxy')!.sha256, proxySha);
      assert.equal(await hashFile(acceptedMediaPath), acceptedMediaSha, 'the accepted Take media is unchanged');

      // 8. Per-Asset transmission consent is required BEFORE any POST.
      const consentSource: ProviderSource = {
        id: 'motion_consent',
        kind: 'provider',
        output: 'picture',
        endpoint: 'default',
        model: 'minimax-h3-base-ref2va',
        prompt: 'SIMULATED TEST-ONLY consent boundary',
        mode: 'reference',
        references: [
          { asset: 'target2', category: 'image', role: 'identity' },
          { asset: 'proxy', category: 'video', role: 'motion' },
        ],
        requestedFrames: 60,
        size: '768:768',
        fps: 24,
        steps: 30,
        seed: 7,
        attempt: 'h3-consent',
      };
      const consentProject = await loadProject(root);
      await assert.rejects(
        () =>
          generateVideoApi(root, consentSource, OUTPUT, '.viscraft/scratch/consent/a.mp4', {
            endpoint: { protocol: 'vllm-omni-video', baseUrl: video.baseUrl },
            extension: minimaxH3Ref2vaExtension(),
            authorization: { submit: true, uploadAssets: ['target2'] },
            references: [
              { asset: consentProject.assets.find(asset => asset.id === 'target2')!, root },
              { asset: consentProject.assets.find(asset => asset.id === 'proxy')!, root },
            ],
          }),
        /consent|uploadAssets/i,
      );
      assert.equal(video.state.posts, 1, 'a missing consent must not reach the service');
    } finally {
      await image.close();
      await video.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(delivery, { recursive: true, force: true });
    await rm(exported, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ROUTE 2 — playable World recording, two uses (Test B)
// ---------------------------------------------------------------------------

const PLAYABLE_FRAMES = 75;
const SCHEDULE: PlayableInput[] = [
  { frame: 0, type: 'down', key: 'ArrowRight' },
  { frame: 20, type: 'up', key: 'ArrowRight' },
];

/**
 * A small deterministic "player": real DOM key handlers move the sprite, the
 * camera follows, and `state()` reports the observed simulation state. `tint`
 * changes ONLY the rendered colour, so two sources with different tints share
 * identical input-driven state but different pixels.
 */
function gameHtml(tint: number): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000;overflow:hidden}</style></head>
<body><canvas id="c"></canvas>
<script>
window.viscraft = (function(){
  var keys = { ArrowLeft:false, ArrowRight:false, ArrowUp:false, ArrowDown:false, Space:false, r:false };
  var player = { x: 8, y: 40, score: 0, camera: 0, events: [] };
  function norm(e){
    if (e.key === ' ') return 'Space';
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') return e.key;
    if (e.key && e.key.length === 1 && e.key.toLowerCase() === 'r') return 'r';
    return null;
  }
  window.addEventListener('keydown', function(e){
    var k = norm(e);
    if (k && !keys[k]) { keys[k] = true; player.events.push('down:' + k); if (k === 'Space') player.score += 1; }
  });
  window.addEventListener('keyup', function(e){
    var k = norm(e);
    if (k) { keys[k] = false; player.events.push('up:' + k); }
  });
  return {
    render: function(ctx){
      if (keys.ArrowRight) player.x = Math.min(ctx.width - 24, player.x + 6);
      if (keys.ArrowLeft) player.x = Math.max(0, player.x - 6);
      player.camera = player.x;
      var c = document.getElementById('c'); c.width = ctx.width; c.height = ctx.height;
      var g = c.getContext('2d');
      g.fillStyle = 'rgb(' + ((${tint} + ctx.frame * 7) % 256) + ',20,40)';
      g.fillRect(0, 0, ctx.width, ctx.height);
      g.fillStyle = '#204060'; g.fillRect(0, ctx.height - 48, ctx.width, 48);
      g.fillStyle = '#00ff00';
      g.fillRect(player.x, player.y, 20, 20);
    },
    state: function(){ return { x: player.x, y: player.y, score: player.score, camera: player.camera, keys: Object.keys(keys).filter(function(k){ return keys[k]; }), events: player.events.slice(-8) }; }
  };
})();
</script></body></html>`;
}

function playableSource(recording: string, overrides: Partial<BrowserPictureSource> = {}): BrowserPictureSource {
  return {
    id: 'replay',
    kind: 'browser',
    output: 'picture',
    entry: 'game.html',
    resources: [],
    bindings: [],
    params: {},
    seed: 0,
    frames: PLAYABLE_FRAMES,
    recording,
    ...overrides,
  } as BrowserPictureSource;
}

function playableProject(): Project {
  return validateProject({
    schemaVersion: 1,
    id: 'production-routes-playable',
    revision: 1,
    title: 'SIMULATED playable recording production route',
    direction: {
      intent: 'A recorded play session is used directly, then as a motion reference.',
      looks: [{ id: 'look', description: 'flat' }],
      transitions: [],
    },
    assets: [],
    bindings: {},
    sources: [
      {
        id: 'game',
        kind: 'browser',
        output: 'picture',
        entry: 'game.html',
        resources: [],
        bindings: [],
        params: {},
        seed: 0,
        frames: PLAYABLE_FRAMES,
      },
    ],
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: 'One scene, one shot' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: '', targetFrames: PLAYABLE_FRAMES }],
      placements: [
        {
          id: 'edit',
          shot: 'shot',
          source: 'game',
          inFrame: 0,
          outFrame: PLAYABLE_FRAMES,
          startFrame: 0,
          audio: 'mute',
        },
      ],
      transitions: [],
      audio: [],
    },
  });
}

test('ROUTE 2 (simulated): recorded replay Take is used directly (no generation service), then imported as a motion reference; a safe variant keeps the original session/media and refuses an old replay on a changed source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-routes-b-'));
  const staging = await mkdtemp(join(tmpdir(), 'viscraft-routes-b-media-'));
  const replayA = await mkdtemp(join(tmpdir(), 'viscraft-routes-b-replay-'));
  const replayB = await mkdtemp(join(tmpdir(), 'viscraft-routes-b-replay-'));
  try {
    const clip = await referenceClip(join(staging, 'clip.mp4'));
    const targetPng = await solidPng(join(staging, 'target.png'), '0x2f5d8c');
    await writeFile(join(staging, 'target.png'), targetPng);
    await writeFile(join(root, 'game.html'), gameHtml(0));
    await writeFile(join(root, 'project.json'), JSON.stringify(playableProject()));

    const video = await startVideoFixture(clip);
    try {
      // 1. Record a real play session (R1) driven by a real keyboard schedule.
      const R1 = await recordPlayable(root, 'game', SCHEDULE);
      assert.deepEqual(R1.events, SCHEDULE);
      assert.equal(R1.simulated, false);
      assert.equal(R1.media.info.frames, PLAYABLE_FRAMES);
      assert.equal(R1.media.info.width, OUTPUT.width);
      assert.equal(R1.media.info.height, OUTPUT.height);
      const r1SessionPath = join(root, 'recordings', R1.id, 'session.json');
      const r1MediaPath = join(root, R1.media.path);
      const r1SessionSha = await hashFile(r1SessionPath);
      const r1MediaSha = await hashFile(r1MediaPath);
      assert.equal(r1MediaSha, R1.media.sha256);

      // 2. DIRECT-EDIT BRANCH: select the recorded replay Take onto the timeline.
      const withReplay = await loadProject(root);
      const game = withReplay.sources.find(source => source.id === 'game');
      assert.equal(game?.kind, 'browser');
      if (game?.kind !== 'browser' || game.output !== 'picture') throw new Error('wrong fixture Source');
      game.recording = `recordings/${R1.id}/session.json`;
      await saveProject(root, withReplay, withReplay.revision);
      const replayed = await buildProject(root);
      assert.equal(replayed.status, 'succeeded', JSON.stringify(replayed.error));
      const replayTake = replayed.takes.find(take => take.source === 'game');
      assert.ok(replayTake);
      assert.equal(replayTake.simulated, false);

      const direct = await loadProject(root);
      direct.composition!.placements = [
        {
          id: 'edit',
          shot: 'shot',
          take: replayTake.id,
          inFrame: 0,
          outFrame: PLAYABLE_FRAMES,
          startFrame: 0,
          audio: 'mute',
        },
      ];
      await saveProject(root, direct, direct.revision);
      const directCut = await buildProject(root);
      assert.equal(directCut.status, 'succeeded', JSON.stringify(directCut.error));
      assert.ok(
        !directCut.operations.some(operation => operation.kind === 'browser'),
        'a selected replay Take must not replay the game again',
      );
      assert.ok(
        !directCut.operations.some(operation => operation.kind === 'provider'),
        'the direct-edit branch must not involve a generation service',
      );
      assert.equal(video.state.posts, 0, 'the direct-edit branch contacts no generation service');

      // 3. INTEGRATION BRANCH: import the recording preview as a video Asset and
      // feed it as the H3 `motion` reference (with a real target image).
      const beforeImport = await loadProject(root);
      const clipAsset = await importAsset(root, {
        assetId: 'clip',
        sourcePath: r1MediaPath,
        type: 'video',
        rights: RIGHTS,
        expectedSha256: R1.media.sha256,
        expectedRevision: beforeImport.revision,
      });
      assert.equal(clipAsset.type, 'video');
      assert.equal(clipAsset.sha256, R1.media.sha256, 'the imported motion reference is the recorded preview bytes');

      const targetAsset = await importAsset(root, {
        assetId: 'target',
        sourcePath: join(staging, 'target.png'),
        type: 'image',
        rights: RIGHTS,
        expectedRevision: (await loadProject(root)).revision,
      });

      const authored = await loadProject(root);
      authored.sources.push({
        id: 'motion',
        kind: 'provider',
        output: 'picture',
        endpoint: 'default',
        model: 'minimax-h3-base-ref2va',
        prompt: 'SIMULATED TEST-ONLY joint reference from a recorded play preview',
        mode: 'reference',
        references: [
          { asset: 'target', category: 'image', role: 'identity' },
          { asset: 'clip', category: 'video', role: 'motion' },
        ],
        requestedFrames: 60,
        size: '768:768',
        fps: 24,
        steps: 30,
        seed: 7,
        attempt: 'h3-rec-one',
      });
      await saveProject(root, authored, authored.revision);

      const candidates = await buildProject(root, {
        candidates: [{ shot: 'shot', sources: ['motion'] }],
        ...videoOptions(video.baseUrl),
      });
      assert.equal(candidates.status, 'succeeded', JSON.stringify(candidates.error));
      assert.equal(video.state.posts, 1);
      assert.equal(video.state.uploads.length, 2);
      assert.deepEqual(
        video.state.uploads.map(entry => entry.sha256),
        [targetAsset.sha256, clipAsset.sha256],
        'the recorded preview is uploaded as the motion video reference',
      );
      const recTake = candidates.takes.find(candidate => candidate.source === 'motion');
      assert.ok(recTake);
      assert.equal(recTake.simulated, true);
      const recArtifact = candidates.artifacts.find(candidate => candidate.id === recTake.artifact)!;
      assert.equal(recArtifact.generation!.references[1].asset, 'clip');
      assert.equal(recArtifact.generation!.references[1].category, 'video');
      assert.equal(recArtifact.generation!.references[1].role, 'motion');
      assert.equal(recArtifact.generation!.references[1].media!.frames, PLAYABLE_FRAMES);

      // 4. SAFE VARIANT: a NEW author source, re-recorded with the SAME events.
      await writeFile(join(root, 'game2.html'), gameHtml(128));
      const variantProject = await loadProject(root);
      variantProject.sources.push({
        id: 'game2',
        kind: 'browser',
        output: 'picture',
        entry: 'game2.html',
        resources: [],
        bindings: [],
        params: {},
        seed: 0,
        frames: PLAYABLE_FRAMES,
      });
      await saveProject(root, variantProject, variantProject.revision);
      const R2 = await recordPlayable(root, 'game2', SCHEDULE);
      assert.deepEqual(R2.events, SCHEDULE, 'the variant replays the SAME recorded input events');

      // The original recording is untouched: same session and media bytes.
      assert.equal(await hashFile(r1SessionPath), r1SessionSha, 'R1 session must be unchanged by re-recording');
      assert.equal(await hashFile(r1MediaPath), r1MediaSha, 'R1 preview media must be unchanged by re-recording');
      // The changed render is a correct redo, not a distorted one: the observed
      // input-driven state is identical while the pixels genuinely differ.
      assert.equal(stableHash(R1.states), stableHash(R2.states), 'the same events drive the same observed state');
      assert.notEqual(R1.media.sha256, R2.media.sha256, 'the changed render produces different pixels');

      // 5. Refusal: the OLD session replayed against the CHANGED source is refused,
      // because the frozen source signature no longer matches.
      const r1Rel = `recordings/${R1.id}/session.json`;
      await assert.rejects(
        () => captureReplay(root, playableSource(r1Rel, { entry: 'game2.html' }), OUTPUT, replayA, {}),
        /signature does not match|do not exactly match/i,
      );

      // 6. Refusal (playable.test.ts idiom): a tampered source file after recording
      // is refused before any capture, and R1 stays byte-identical.
      const r2Rel = `recordings/${R2.id}/session.json`;
      const game2 = await readFile(join(root, 'game2.html'), 'utf8');
      await writeFile(join(root, 'game2.html'), `${game2}\n<!-- edited after recording -->\n`);
      await assert.rejects(
        () => captureReplay(root, playableSource(r2Rel, { entry: 'game2.html' }), OUTPUT, replayB, {}),
        /changed since recording/i,
      );
      assert.equal(await hashFile(r1SessionPath), r1SessionSha);
      assert.equal(await hashFile(r1MediaPath), r1MediaSha);
    } finally {
      await video.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
    await rm(replayA, { recursive: true, force: true });
    await rm(replayB, { recursive: true, force: true });
  }
});
