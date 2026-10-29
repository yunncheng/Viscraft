/**
 * fal `alibaba/wan-3.0/image-to-video` Provider end-to-end proof through the
 * normal Build path.
 *
 * This test drives the *public* runtime API (`../src/index.js`) against a real
 * loopback HTTP fixture that speaks the verified fal queue protocol
 * (`POST <endpoint>` -> `{status:'IN_QUEUE', request_id, status_url, response_url}`, then
 * `GET status_url` until `COMPLETED`, then `GET response_url` -> `{video:{url}}`).
 * It proves the whole chain:
 *
 *   two authored PNG Assets  ->  still animatic  ->  candidate fal Take with
 *   first/end data-URI conditioning  ->  select the middle Take and keep its
 *   generated audio  ->  deliverProject  ->  reopen with no further submission
 *   ->  a later failing Build preserves the previous result.
 *
 * Only the provider path is simulated: the two authored PNG Assets and the
 * still animatic are real, local FFmpeg-authored files, while the fal candidate
 * is produced by a deterministic loopback fixture (no account, no real fal
 * network call and no generative model are involved). The fixture serves a
 * deterministic FFmpeg test pattern at 12 fps over a shorter duration than the
 * 2 s request, so the *actual probed* provider duration (not the requested one)
 * is what must end up on the timeline. The adapter runs in its documented
 * test-only transport: the loopback fixture is authorized by a fixed, non-secret
 * placeholder while both the caller-provided key and any environment key are
 * never transmitted, and the generated Take/Artifact is marked `simulated`.
 */

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildProject,
  deliverProject,
  loadProject,
  probeMedia,
  readBuilds,
  saveProject,
  validateProject,
} from '../src/index.js';
import { falStatus } from '../src/backends/providers/services/fal/index.js';
import { archiveProject, restoreProject } from '../src/operations/delivery/archive.js';
import { releaseArchived, restoreMedia } from '../src/project/release.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import type { Project } from '../src/core/schema.js';
import { writeSignalAsset } from './audio-fixtures.js';

const JOB_ID = 'req_fal_fixture_1';
const FIXTURE_KEY = 'fixture-key-not-secret';
const ENV_KEY = 'env-fal-secret-should-be-ignored';
// The adapter's documented test-only transport authorizes the loopback fixture
// with this fixed, non-secret placeholder instead of any caller/environment key.
const TEST_PLACEHOLDER = 'fixture';
const PNG_DATA_URI = 'data:image/png;base64,';

/** Decode a PNG data URI (as sent by the adapter) and return its sha256. */
function dataUriSha256(uri: string): string {
  assert.ok(uri.startsWith(PNG_DATA_URI), `expected a PNG data URI, got ${uri.slice(0, 32)}`);
  return createHash('sha256')
    .update(Buffer.from(uri.slice(PNG_DATA_URI.length), 'base64'))
    .digest('hex');
}

test('fal queue fixture: two authored PNGs condition a simulated image-to-video candidate, middle Take keeps audio, delivers, reopens, survives a failing Build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-fal-e2e-'));
  const delivery = root + '-delivery';
  const previousEnv = process.env.FAL_KEY;
  const previousNamedCredential = process.env.VISCRAFT_FAL_FIXTURE_KEY;
  process.env.FAL_KEY = ENV_KEY;
  process.env.VISCRAFT_FAL_FIXTURE_KEY = FIXTURE_KEY;

  let submissions = 0;
  let statusPolls = 0;
  let downloads = 0;
  let base = '';
  let sentPrompt = '';
  let sentDuration = -1;
  let sentResolution = '';
  let sentRatio = '';
  let sentAudio = false;
  let sentSafety = false;
  let sentExpansion: unknown = 'unset';
  let sentThinking: unknown = 'unset';
  let sentRaw = '';
  let startHash = '';
  let endHash = '';
  let statusPathSeen = '';
  let resultPathSeen = '';
  const authSeen: string[] = [];

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', async () => {
      try {
        authSeen.push(request.headers.authorization ?? '');
        const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
        if (request.method === 'POST' && path.endsWith('/image-to-video')) {
          submissions++;
          sentRaw = Buffer.concat(chunks).toString('utf8');
          const body = JSON.parse(sentRaw) as Record<string, unknown>;
          sentPrompt = String(body.prompt ?? '');
          sentDuration = Number(body.duration);
          sentResolution = String(body.resolution ?? '');
          // Read ONLY the exact verified wire field; never fall back to a
          // differently-named field that would mask a wrong request shape.
          sentRatio = typeof body.aspect_ratio === 'string' ? body.aspect_ratio : '';
          sentAudio = body.audio === true;
          sentSafety = body.enable_safety_checker === true;
          sentExpansion = body.enable_prompt_expansion;
          sentThinking = body.enable_thinking;
          assert.equal(typeof body.start_image_url, 'string', 'the first frame must be sent as start_image_url');
          startHash = dataUriSha256(String(body.start_image_url));
          if (body.end_image_url !== undefined && body.end_image_url !== null)
            endHash = dataUriSha256(String(body.end_image_url));
          if (sentPrompt.includes('unknown')) {
            request.socket.destroy();
            return;
          }
          response.setHeader('Content-Type', 'application/json');
          // The provider may return either the official endpoint-scoped path or
          // the SDK's stripped short alias; return one of each to prove both are
          // accepted: /alibaba/wan-3.0/[image-to-video/]requests/{id}[/status].
          response.end(
            JSON.stringify({
              status: 'IN_QUEUE',
              request_id: JOB_ID,
              status_url: `${base}/alibaba/wan-3.0/image-to-video/requests/${JOB_ID}/status`,
              response_url: `${base}/alibaba/wan-3.0/requests/${JOB_ID}`,
              cancel_url: `${base}/alibaba/wan-3.0/requests/${JOB_ID}/cancel`,
            }),
          );
        } else if (request.method === 'GET' && /\/requests\/[^/]+\/status$/.test(path)) {
          statusPolls++;
          statusPathSeen = path;
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ request_id: JOB_ID, status: statusPolls === 1 ? 'IN_PROGRESS' : 'COMPLETED' }));
        } else if (request.method === 'GET' && /\/requests\/[^/]+$/.test(path)) {
          resultPathSeen = path;
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ video: { url: `${base}/video.mp4` }, seed: 20241008, duration: 1 }));
        } else if (request.method === 'GET' && path === '/video.mp4') {
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
    // Real short provider media WITH audio: 1 s at 12 fps -> 12 frames. The
    // request asks for 2 s, so the recorded duration must come from the probe.
    await runCommand('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-threads',
      '2',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x90:rate=12:duration=1',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      join(root, 'fixture.mp4'),
    ]);
    const probe = await probeMedia(join(root, 'fixture.mp4'));
    assert.equal(probe.frames, 12);
    assert.equal(probe.fps.numerator / probe.fps.denominator, 12);
    assert.ok(probe.audio, 'the provider fixture must carry audio');

    // Two genuinely distinct authored PNG Assets (real files, hashed).
    await runCommand('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=64x64',
      '-frames:v',
      '1',
      join(root, 'first.png'),
    ]);
    await runCommand('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=64x64',
      '-frames:v',
      '1',
      join(root, 'last.png'),
    ]);
    const firstSha = await hashFile(join(root, 'first.png'));
    const lastSha = await hashFile(join(root, 'last.png'));

    // A real 330 Hz WAV exercises Asset mixing, gain, fades and rights tracking.
    const bed = await writeSignalAsset(root, {
      id: 'bed_signal',
      path: 'audio/bed.wav',
      sampleRate: 48000,
      channels: 2,
      samples: 38400,
      frequency: 330,
      waveform: 'sine',
    });
    assert.equal(bed.type, 'audio');
    assert.equal(bed.sha256, await hashFile(join(root, bed.path)));
    assert.ok(bed.rights.license.length > 0, 'the audio Asset carries explicit test rights');

    const initial: Project = {
      schemaVersion: 1,
      id: 'fal-normal',
      revision: 1,
      title: 'SIMULATED fal queue contract fixture',
      soundTargets: [],
      direction: {
        intent: 'Approve a still animatic, then extend it with a test-only fal pass',
        looks: [{ id: 'look', description: 'Explicitly simulated test pattern' }],
        transitions: [],
      },
      assets: [
        {
          id: 'first',
          revision: 1,
          type: 'image',
          path: 'first.png',
          sha256: firstSha,
          rights: { origin: 'original FFmpeg fixture', license: 'CC0-1.0', redistributable: true },
          simulated: false,
        },
        {
          id: 'last',
          revision: 1,
          type: 'image',
          path: 'last.png',
          sha256: lastSha,
          rights: { origin: 'original FFmpeg fixture', license: 'CC0-1.0', redistributable: true },
          simulated: false,
        },
        bed,
      ],
      bindings: {},
      sources: [
        {
          id: 'motion',
          kind: 'provider',
          output: 'picture',
          endpoint: 'fal',
          model: 'alibaba/wan-3.0/image-to-video',
          prompt: 'SIMULATED TEST-ONLY fal queue fixture',
          mode: 'first-last-frame',
          references: [
            { asset: 'first', category: 'image', role: 'first-frame' },
            { asset: 'last', category: 'image', role: 'last-frame' },
          ],
          requestedFrames: 24,
          size: '854:480',
          fps: 24,
          seed: 20241008,
          attempt: 'fal-one',
          parameters: { durationSeconds: 2, resolution: '480p', ratio: '16:9', audio: true },
        },
      ],
      composition: {
        output: { width: 96, height: 64, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 },
        scenes: [{ id: 'scene', description: 'Still to model motion' }],
        shots: [
          {
            id: 'shot',
            scene: 'scene',
            look: 'look',
            intent: 'Review the animatic, then the fal candidate',
            targetFrames: 24,
          },
        ],
        placements: [
          {
            id: 'edit',
            shot: 'shot',
            asset: 'first',
            framing: { fit: 'contain', background: '#000000' },
            inFrame: 0,
            outFrame: 24,
            startFrame: 0,
            audio: 'mute',
            durationFrames: 24,
          },
        ],
        transitions: [],
        audio: [
          {
            id: 'bed',
            kind: 'asset',
            asset: 'bed_signal',
            inSample: 0,
            startSample: 0,
            durationSamples: 38400,
            gain: 0.15,
            fadeInSamples: 400,
            fadeOutSamples: 400,
          },
        ],
      },
      imageDocuments: [],
      imageTargets: [],
    };
    await writeFile(join(root, 'project.json'), JSON.stringify(validateProject(initial)));

    // --- 1. Animatic from the approved first frame (no model, not simulated) --
    const animatic = await buildProject(root);
    assert.equal(animatic.status, 'succeeded');
    assert.equal(animatic.result!.simulated, false);
    assert.ok(animatic.operations.some(operation => operation.kind === 'normalize-still'));

    await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', () => resolveListen()));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    base = `http://127.0.0.1:${address.port}`;
    const options = {
      providers: {
        videoApi: {
          fal: {
            endpoint: { protocol: 'fal-queue' as const, baseUrl: base, credential: 'VISCRAFT_FAL_FIXTURE_KEY' },
            testOnly: { baseUrl: base },
          },
        },
      },
    };

    // --- 2. fal candidate: first poll IN_PROGRESS, retry completes, one POST --
    await assert.rejects(
      buildProject(root, { candidates: [{ shot: 'shot', sources: ['motion'] }], ...options }),
      /IN_PROGRESS|in_progress|pending|not complete/i,
    );
    assert.equal(submissions, 1);
    const candidates = await buildProject(root, { candidates: [{ shot: 'shot', sources: ['motion'] }], ...options });
    assert.equal(candidates.status, 'succeeded');
    assert.equal(submissions, 1, 'exactly one POST across the pending retry');
    assert.equal(statusPolls, 2, 'exactly two status GET steps');
    assert.equal(downloads, 1);
    // Both returned URL shapes are followed verbatim (official + SDK short alias).
    assert.equal(statusPathSeen, `/alibaba/wan-3.0/image-to-video/requests/${JOB_ID}/status`);
    assert.equal(resultPathSeen, `/alibaba/wan-3.0/requests/${JOB_ID}`);

    // The submitted conditioning images decode to the exact frozen Assets.
    assert.equal(startHash, firstSha, 'start_image_url must hash to the approved first Asset');
    assert.equal(endHash, lastSha, 'end_image_url must hash to the approved end Asset');
    assert.equal(sentDuration, 2);
    assert.equal(sentResolution, '480p');
    assert.equal(sentRatio, '16:9');
    assert.equal(sentAudio, true);
    assert.equal(sentSafety, true, 'enable_safety_checker must stay on (the API security default)');
    assert.equal(sentExpansion, false, 'prompt expansion must be off as documented');
    assert.equal(sentThinking, false, 'thinking must be off as documented');
    // The raw submit body must never carry a credential or an auth header value.
    assert.ok(!/authorization/i.test(sentRaw), 'the submit body must not contain an authorization field');
    assert.ok(
      !sentRaw.includes(FIXTURE_KEY) && !sentRaw.includes(ENV_KEY),
      'no credential may appear in the submit body',
    );

    // Test-only transport uses its fixed non-secret placeholder: the
    // caller-provided key and the environment key must never be transmitted.
    assert.ok(
      authSeen.some(value => value === `Key ${TEST_PLACEHOLDER}`),
      'the loopback fixture must be authorized by the fixed test placeholder',
    );
    assert.ok(
      authSeen.every(value => !value.includes(ENV_KEY)),
      'the environment key must never be transmitted',
    );
    assert.ok(
      authSeen.every(value => !value.includes(FIXTURE_KEY)),
      'the caller key must not be transmitted in test-only mode',
    );

    // The real animatic stays selected: an unused simulated candidate must not taint it.
    assert.equal(
      candidates.result!.simulated,
      false,
      'a simulated candidate must not taint the real animatic still selected',
    );
    const take = candidates.takes.find(entry => entry.source === 'motion');
    assert.ok(take, 'the fal candidate must produce a Take');
    assert.equal(take.simulated, true);
    if (take.medium !== 'picture') assert.fail('the fal candidate must produce a picture Take');
    // 1 s of 12 fps provider media normalized to the 30 fps output clock: 30 frames.
    assert.equal(take.frames, 30);
    assert.equal(take.fps.numerator / take.fps.denominator, 30);
    const generated = candidates.artifacts.find(artifact => artifact.id === take.artifact)!;
    assert.match(generated.backend, /fal.*test-only/);
    assert.equal(generated.media!.fps.numerator / generated.media!.fps.denominator, 30);
    assert.equal(generated.generation!.provider, 'fal');
    assert.equal(generated.generation!.model, 'alibaba/wan-3.0/image-to-video');
    assert.equal(generated.generation!.taskId, JOB_ID);
    assert.deepEqual(generated.generation!.references, [
      { asset: 'first', sha256: firstSha, category: 'image', role: 'first-frame' },
      { asset: 'last', sha256: lastSha, category: 'image', role: 'last-frame' },
    ]);
    // The retained provider original is the real 12 fps/12-frame source; the
    // actual probed duration wins over the requested 2 s, and the normalized
    // Take (30 frames at 30 fps) carries that same 1 s, not the requested 2 s.
    assert.equal(generated.generation!.originalMedia!.frames, 12);
    assert.equal(
      generated.generation!.originalMedia!.fps.numerator / generated.generation!.originalMedia!.fps.denominator,
      12,
    );
    assert.ok(
      generated.generation!.originalMedia!.duration <= 1.1,
      'the recorded duration must be the actual probe, not the requested 2 s',
    );
    // The provider media is keyed by the Source-scoped stem (`<source>.<attempt>`),
    // so the bare attempt is never a bare filename.
    const originalPath = join(root, '.viscraft/provider-media', 'fal-motion.fal-one.mp4');
    assert.ok(existsSync(originalPath), 'the original provider media must be retained');
    const original = await probeMedia(originalPath);
    assert.equal(original.frames, 12);
    assert.equal(original.fps.numerator / original.fps.denominator, 12);
    assert.ok(original.duration <= 1.1, 'the actual probed duration must be recorded, not the requested 2 s');

    const jobs = JSON.stringify(await falStatus(root));
    assert.ok(
      !jobs.includes(base) && !jobs.includes('data:image/') && !jobs.includes('SIMULATED TEST-ONLY fal queue fixture'),
    );
    assert.ok(!jobs.includes(FIXTURE_KEY) && !jobs.includes(ENV_KEY));

    // --- 3. Choose the middle Take and keep its generated audio; edit only ----
    const selected = await loadProject(root);
    selected.composition!.placements = [
      {
        id: 'edit',
        shot: 'shot',
        take: take.id,
        inFrame: 0,
        outFrame: 24,
        startFrame: 0,
        audio: 'keep',
        durationFrames: 20,
      },
    ];
    await saveProject(root, selected, selected.revision);
    const movie = await buildProject(root);
    assert.equal(movie.status, 'succeeded');
    assert.equal(movie.result!.simulated, true);
    assert.ok(
      !movie.operations.some(operation => operation.kind === 'provider'),
      'a selected Take must not regenerate the model',
    );
    assert.ok(
      movie.operations.some(operation => operation.kind === 'source-audio-trim'),
      'the generated audio must be kept',
    );
    const final = movie.artifacts.find(artifact => artifact.id === movie.result!.artifact)!;
    assert.equal(final.media!.frames, 20);
    assert.ok(final.media!.audio, 'the final movie must carry the kept generated audio');
    assert.equal(submissions, 1, 'selecting a Take must not submit again');

    // --- 4. Deliver the bundle ----------------------------------------------
    const bundle = await deliverProject(root, delivery, { review: true, stems: true });
    assert.equal(bundle.build, movie.id);
    assert.equal(bundle.simulated, true);
    assert.equal(bundle.movie!.path, 'movie/final.mp4');
    assert.equal(await hashFile(join(delivery, 'movie', 'final.mp4')), bundle.movie!.sha256);
    assert.equal(bundle.review!.build, movie.id);

    // --- 5. Reopen the delivered editable project: no submission -------------
    const reopened = await buildProject(join(delivery, 'project'));
    assert.ok(
      reopened.operations.every(operation => operation.reused),
      'the delivered project must rebuild entirely from cached artifacts',
    );
    assert.equal(reopened.result!.simulated, true);
    assert.equal(submissions, 1, 'reopening must not POST again');
    assert.equal(statusPolls, 2);
    assert.equal(downloads, 1);

    // --- 5b. Archive carries the provider original; release/restore is intact --
    // A Portable export now carries the REQUIRED provider original (H3), so the
    // archive holds BOTH the normalized Artifact and the raw original. Prove the
    // release/restore convergence: `releaseArchived` frees only the selected
    // Artifact and can never delete the original it cannot write back;
    // `restoreMedia` brings the Artifact back; the original stays byte-identical
    // throughout and neither step submits a provider request.
    const archiveParent = await mkdtemp(join(tmpdir(), 'viscraft-fal-archive-'));
    const archive = join(archiveParent, 'fal.viscraft-archive');
    const postsBeforeRelease = submissions;
    const pollsBeforeRelease = statusPolls;
    const downloadsBeforeRelease = downloads;
    try {
      await archiveProject(root, archive);
      const restoredArchive = join(archiveParent, 'restored');
      await restoreProject(archive, restoredArchive);
      const carriedOriginal = join(restoredArchive, '.viscraft', 'provider-media', 'fal-motion.fal-one.mp4');
      assert.ok(existsSync(carriedOriginal), 'the archive must carry the provider original');
      assert.equal(
        await hashFile(carriedOriginal),
        await hashFile(originalPath),
        'the carried original must be byte-identical to the retained one',
      );
      assert.equal(
        await hashFile(join(restoredArchive, ...generated.path.split('/'))),
        generated.sha256,
        'the archive must carry the normalized artifact too',
      );

      const liveOriginalHash = await hashFile(originalPath);
      const released = await releaseArchived(root, archive, [generated.id]);
      assert.deepEqual(
        released.released.map(item => item.artifact),
        [generated.id],
      );
      assert.ok(
        released.originals.some(
          original => original.path === '.viscraft/provider-media/fal-motion.fal-one.mp4' && !original.released,
        ),
        'the retained provider original must be reported and never released',
      );
      assert.equal(
        await hashFile(originalPath),
        liveOriginalHash,
        'release must leave the provider original byte-identical',
      );
      assert.ok(!existsSync(join(root, ...generated.path.split('/'))), 'release frees the selected Artifact');

      const restoredMedia = await restoreMedia(root, archive);
      assert.deepEqual(
        restoredMedia.restored.map(item => item.artifact),
        [generated.id],
      );
      assert.equal(
        await hashFile(join(root, ...generated.path.split('/'))),
        generated.sha256,
        'restore-media brings the Artifact back',
      );
      assert.equal(await hashFile(originalPath), liveOriginalHash, 'restore-media never touches the provider original');
    } finally {
      await rm(archiveParent, { recursive: true, force: true });
    }
    assert.equal(submissions, postsBeforeRelease, 'archive/release/restore must not POST');
    assert.equal(statusPolls, pollsBeforeRelease);
    assert.equal(downloads, downloadsBeforeRelease);

    // --- 6. A later failing Build preserves the previous active result -------
    const previousResult = await readFile(join(root, '.viscraft/result.json'), 'utf8');
    const failing = await loadProject(root);
    const failingSource = failing.sources.find(entry => entry.id === 'motion');
    assert.equal(failingSource?.kind, 'provider');
    if (failingSource?.kind !== 'provider') throw new Error('wrong fixture Source');
    failingSource.prompt = 'SIMULATED TEST-ONLY unknown fal submission';
    failingSource.attempt = 'fal-unknown';
    failing.composition!.placements = [
      { id: 'edit', shot: 'shot', source: 'motion', inFrame: 6, outFrame: 30, startFrame: 0, audio: 'mute' },
    ];
    await saveProject(root, failing, failing.revision);
    await assert.rejects(buildProject(root, options), /unknown/i);
    await assert.rejects(buildProject(root, options), /unknown|not resubmit/i);
    assert.equal(submissions, 2, 'an ambiguous submit must never be repeated');
    assert.equal(
      await readFile(join(root, '.viscraft/result.json'), 'utf8'),
      previousResult,
      'a failed Build must not replace the active result',
    );
    assert.ok((await readBuilds(root)).some(build => build.status === 'failed'));
    assert.ok(
      authSeen.every(value => !value.includes(ENV_KEY)),
      'the environment key must never be transmitted',
    );
  } finally {
    if (previousEnv === undefined) delete process.env.FAL_KEY;
    else process.env.FAL_KEY = previousEnv;
    if (previousNamedCredential === undefined) delete process.env.VISCRAFT_FAL_FIXTURE_KEY;
    else process.env.VISCRAFT_FAL_FIXTURE_KEY = previousNamedCredential;
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    await rm(root, { recursive: true, force: true });
    await rm(delivery, { recursive: true, force: true });
  }
});
