#!/usr/bin/env node
// Run one explicitly authorized API candidate to completion, then register it
// through the normal Build path. Selection remains a host-agent review decision.
//
// SCOPE: this driver is generic over the Source's OWN ordered reference list.
// It uploads EXACTLY the references the Source declares — every category
// (image / video / audio), in the declared order — and passes nothing else.
// Nothing is filtered, reordered, capped or silently dropped here; the model/
// service decides what is legal and refuses an illegal request loudly. A
// video-only (image-less) request and a text-only request are therefore the
// same code path with fewer entries, and a single-image request is simply the
// simplest case, not a special branch.
//
// Local and hosted services use the same Source and vllm-omni-video API contract.
// Configure:
//   VISCRAFT_VIDEO_API_URL        (required) already-deployed vllm-omni-video base URL
//   VISCRAFT_VIDEO_API_MODEL      optional wire model name override
//   VISCRAFT_VIDEO_API_KEY_ENV    optional env var holding a Bearer token
//   VISCRAFT_VIDEO_API_TASK_TYPE  optional deployment partition: ref2va | fl2va
//                                 (a Ref2VA deployment refuses FL2VA text /
//                                 first-last-frame requests, and vice versa)
//
// Usage:
//   VISCRAFT_VIDEO_API_URL=<service-base-url> node tests/fixtures/authoring/produce-video-api.mjs \
//     <project-directory> <source-id> <shot-id> --authorize
//
// `--authorize` is the single explicit consent for this candidate: it permits
// submitting the request and transmitting the declared reference Assets to the
// configured service. Because the Source itself owns the reference set, the
// uploaded list is exactly that set — there is no separate asset-id argument to
// drift out of sync with it.
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildProject, generateVideoService, loadProject, VideoApiPendingError } from '../../../dist/src/index.js';
import { resolveProjectPath } from '../../../dist/src/shared/fs.js';

const [directory, sourceId, shotId, flag] = process.argv.slice(2);
if (!directory || !sourceId || !shotId || flag !== '--authorize')
  throw new Error(
    'Usage: VISCRAFT_VIDEO_API_URL=<service-base-url> node tests/fixtures/authoring/produce-video-api.mjs <project-directory> <source-id> <shot-id> --authorize',
  );
const baseUrl = process.env.VISCRAFT_VIDEO_API_URL;
if (!baseUrl)
  throw new Error(
    'Set VISCRAFT_VIDEO_API_URL to your already deployed vllm-omni-video API. This example does not install or start a model.',
  );
const taskType = process.env.VISCRAFT_VIDEO_API_TASK_TYPE;
if (taskType !== undefined && taskType !== 'ref2va' && taskType !== 'fl2va')
  throw new Error("VISCRAFT_VIDEO_API_TASK_TYPE must be 'ref2va' or 'fl2va' when set");
const endpoint = {
  protocol: 'vllm-omni-video',
  baseUrl,
  ...(process.env.VISCRAFT_VIDEO_API_MODEL ? { model: process.env.VISCRAFT_VIDEO_API_MODEL } : {}),
  ...(process.env.VISCRAFT_VIDEO_API_KEY_ENV ? { credential: process.env.VISCRAFT_VIDEO_API_KEY_ENV } : {}),
  ...(taskType ? { modelSettings: { taskType } } : {}),
};
const root = resolve(directory);
const project = await loadProject(root);
const source = project.sources.find(source => source.id === sourceId);
if (source?.kind !== 'provider') throw new Error('Expected a video-generation Source');
if (!project.composition.shots.some(shot => shot.id === shotId)) throw new Error('Unknown candidate Shot');

// The Source owns the ordered reference set; resolve each entry to its approved
// Asset and preserve the Source's order, which is the adapter's request hash and
// wire order. A declared reference whose Asset is missing (or is not the media
// category it claims) is a loud error before any network call.
const declared = source.references ?? [];
const references = declared.map(reference => {
  const asset = project.assets.find(asset => asset.id === reference.asset);
  if (!asset)
    throw new Error(
      `Source '${source.id}' declares a ${reference.category} reference Asset '${reference.asset}' that is not present in this Project`,
    );
  if (asset.type !== reference.category)
    throw new Error(
      `Reference Asset '${asset.id}' is type '${asset.type}' but the Source declares it as '${reference.category}'`,
    );
  return { asset, root };
});
// The actually-transmitted Asset list is exactly the declared, ordered list.
const authorization = { submit: true, uploadAssets: declared.map(reference => reference.asset) };
console.log(
  JSON.stringify(
    {
      event: 'upload-plan',
      mode: source.mode,
      partition: taskType ?? '(deployment default)',
      references: declared.map(reference => ({
        asset: reference.asset,
        category: reference.category,
        role: reference.role,
      })),
    },
    null,
    2,
  ),
);

// These bytes are checked against the approved hash on every invocation. The
// subsequent normal Build freezes its own snapshot and reuses this known job.
const staging = await resolveProjectPath(root, '.viscraft/video-api-stage');
await mkdir(staging, { recursive: true });
const destination = join(staging, `${randomUUID()}.mp4`);
const deadline = Date.now() + 20 * 60 * 1000;
try {
  for (;;) {
    try {
      const result = await generateVideoService(root, source, project.composition.output, destination, {
        endpoint,
        authorization,
        references,
      });
      console.log(JSON.stringify({ event: 'generation-completed', generation: result.generation }));
      break;
    } catch (error) {
      if (!(error instanceof VideoApiPendingError)) throw error;
      if (Date.now() >= deadline)
        throw new Error(
          'API generation remains pending; its recorded attempt is preserved. Resume this same command, do not create a duplicate attempt.',
        );
      console.log(
        JSON.stringify({ event: 'generation-pending', attempt: source.attempt, nextQueryAt: error.nextQueryAt }),
      );
      const next = error.nextQueryAt ? Date.parse(error.nextQueryAt) : Date.now() + 5000;
      await delay(Math.max(5000, next - Date.now()));
    }
  }
  const build = await buildProject(root, {
    goal: `Produce and register API candidate ${sourceId}; do not automatically select it`,
    candidates: [{ shot: shotId, sources: [sourceId] }],
    providers: { videoApi: { [source.endpoint]: { endpoint, authorization } } },
  });
  console.log(
    JSON.stringify(
      {
        event: 'candidate-build-completed',
        build: build.id,
        takes: build.takes.filter(take => take.source === sourceId),
        result: build.result,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(destination, { force: true });
}
