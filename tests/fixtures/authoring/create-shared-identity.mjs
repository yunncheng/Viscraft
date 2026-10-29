#!/usr/bin/env node
/*
 * Viscraft technical fixture: author a multi-shot work in which EVERY generated shot is
 * conditioned on the SAME approved still, so cross-shot identity/environment can
 * be reviewed on real output rather than asserted.
 *
 *   node tests/fixtures/authoring/create-shared-identity.mjs <new-project-directory> <PNG-or-JPEG> <rights.json> <prompts.json>
 *
 * <prompts.json>:
 *   {
 *     "title": "...",                     // optional
 *     "model": "MiniMax-H3",             // optional; defaults to validated H3 profile
 *     "endpoint": "default",              // binding key, not a deployment URL
 *     "fps": 24,                          // generation rate; model constraints apply
 *     "steps": 30,
 *     "requestedFrames": 97,
 *     "size": "1344:768",                 // width:height; model constraints apply
 *     "role": "identity",                 // optional reference purpose (default identity)
 *     "referenceIntent": "…",             // optional authored retain/replace intent,
 *                                         //   prepended to EVERY shot prompt
 *     "shots": [
 *       { "id": "shot_a", "prompt": "…", "seed": 123 },
 *       { "id": "shot_b", "prompt": "…", "seed": 456 }
 *     ]
 *   }
 *
 * The reference PURPOSE (`role`) and the RETAIN/REPLACE intent are authored by
 * the caller: there is NO baked-in "preserve all shape/material/lighting"
 * instruction. Write what must stay and what may change in each `prompt` (or a
 * shared `referenceIntent`); the still only CONDITIONS the request.
 *
 * This creates a NEW Project (it refuses to overwrite) with:
 *   - one `image` Asset (`reference`) for the approved still, held directly by the
 *     whole-timeline animatic board placement (a registered Asset, not a Source)
 *     and sounded by `tone` clips,
 *   - one unselected `provider` Source (`src_<id>`) per shot, each referencing the
 *     SAME `reference` Asset in its ordered `references`.
 *
 * Authoring performs NO provider work: no authorization is passed and nothing is
 * submitted, so an ordinary `build` renders only the animatic. Produce each shot
 * later with `tests/fixtures/authoring/produce-video-api.mjs` (or `buildProject` with explicit
 * authorization). The still is a visual CONDITION, not a guarantee of exact
 * identity; inspect the actual Takes before accepting, and decide each shot's
 * native audio explicitly (`audio: 'keep' | 'mute'`).
 */
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RightsSchema, validateProject } from '../../../dist/src/index.js';
import { hashFile } from '../../../dist/src/shared/hash.js';
import { makeSignalAsset } from './lib/audio-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FPS = 24;
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const SHOT_FRAMES = 96;

function fail(message) {
  console.error(`create-shared-identity: ${message}`);
  process.exit(1);
}

const [directory, reference, rightsFile, promptsFile] = process.argv.slice(2);
if (!directory || !reference || !rightsFile || !promptsFile) {
  fail(
    'usage: node tests/fixtures/authoring/create-shared-identity.mjs <new-project-directory> <PNG-or-JPEG> <rights.json> <prompts.json>',
  );
}
const config = JSON.parse(await readFile(resolve(promptsFile), 'utf8'));
const shots = config.shots;
if (!Array.isArray(shots) || shots.length < 2 || shots.length > 8) fail('prompts.json "shots" must list 2..8 shots');
const ids = new Set();
for (const [index, shot] of shots.entries()) {
  if (typeof shot?.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(shot.id))
    fail(`shot ${index} needs an id matching [A-Za-z0-9_-]+`);
  if (ids.has(shot.id)) fail(`duplicate shot id ${shot.id}`);
  ids.add(shot.id);
  if (typeof shot.prompt !== 'string' || shot.prompt.trim().length === 0)
    fail(`shot ${shot.id} needs a non-empty prompt`);
}
const steps = config.steps ?? 30;
const requestedFrames = config.requestedFrames ?? 97;
const size = config.size ?? '1344:768';
if (!Number.isSafeInteger(steps) || steps < 1) fail('"steps" must be a positive integer');
if (!Number.isSafeInteger(requestedFrames) || requestedFrames < 1) fail('"requestedFrames" must be a positive integer');
if (typeof size !== 'string' || !/^[1-9]\d{0,4}:[1-9]\d{0,4}$/.test(size)) fail('"size" must be width:height');
if (config.role !== undefined && (typeof config.role !== 'string' || config.role.trim().length === 0))
  fail('"role" must be a non-empty string when set');
if (config.referenceIntent !== undefined && typeof config.referenceIntent !== 'string')
  fail('"referenceIntent" must be a string when set');

const rights = RightsSchema.parse(JSON.parse(await readFile(resolve(rightsFile), 'utf8')));
const bytes = await readFile(resolve(reference));
const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
if (!png && !jpeg) fail('reference must be an approved PNG or JPEG; SVG is not silently converted');

const root = resolve(directory);
try {
  await access(root);
  fail(`refusing to overwrite existing ${root}`);
} catch {
  /* new project required */
}
await mkdir(root, { recursive: false }).catch(() => fail(`could not create ${root}`));
await mkdir(join(root, 'assets'), { recursive: true });

const image = `assets/reference.${png ? 'png' : 'jpg'}`;
await copyFile(resolve(reference), join(root, image), constants.COPYFILE_EXCL);
const sha256 = await hashFile(join(root, image));

// The animatic board spans the whole timeline: SHOT_FRAMES per generated shot,
// so the timeline already matches the plan before any real Take exists.
const totalFrames = SHOT_FRAMES * shots.length;
const totalSamples = Math.ceil((totalFrames / FPS) * SAMPLE_RATE);
// Two real PCM beds, declared as audio Assets; the clip timing/gain stay as
// authored. The Project carries the files, so no Runtime tone synthesis.
const bedLow = makeSignalAsset({
  id: 'bed_low',
  path: 'bed-low.wav',
  sampleRate: SAMPLE_RATE,
  channels: CHANNELS,
  samples: totalSamples,
  frequency: 110,
  waveform: 'sine',
});
const bedHigh = makeSignalAsset({
  id: 'bed_high',
  path: 'bed-high.wav',
  sampleRate: SAMPLE_RATE,
  channels: CHANNELS,
  samples: totalSamples,
  frequency: 330,
  waveform: 'triangle',
});
// The retain/replace intent is AUTHORED by the caller (per-shot `prompt` and/or
// a shared `referenceIntent`); this example bakes in no preservation claim.
const referenceIntent =
  typeof config.referenceIntent === 'string' && config.referenceIntent.trim().length > 0
    ? config.referenceIntent.trim() + ' '
    : '';

const project = validateProject({
  schemaVersion: 1,
  id: `shared-identity-${randomUUID()}`,
  revision: 1,
  title: config.title ?? 'ONE SUBJECT, MULTIPLE SHOTS — shared image-reference identity',
  direction: {
    intent:
      'Every generated shot is conditioned on the SAME approved still so cross-shot identity/environment can be reviewed on real Takes. The still is a conditioning reference, not a guarantee of exact identity; inspect the actual output before accepting.',
    looks: [
      {
        id: 'shared-look',
        description: 'Keep the shared subject palette and lighting across shots; judge the real Takes, not the prompt.',
      },
    ],
    transitions: [],
  },
  assets: [
    { id: 'reference', revision: 1, path: image, type: 'image', sha256, simulated: false, rights },
    bedLow.asset,
    bedHigh.asset,
  ],
  bindings: {},
  sources: [
    ...shots.map((shot, index) => ({
      id: `src_${shot.id}`,
      kind: 'provider',
      output: 'picture',
      endpoint: config.endpoint ?? 'default',
      fps: config.fps ?? 24,
      model: config.model ?? 'MiniMax-H3',
      mode: 'reference',
      references: [{ asset: 'reference', category: 'image', role: config.role ?? 'identity' }],
      prompt: `${referenceIntent}${shot.prompt.trim()}`,
      requestedFrames,
      size,
      steps,
      ...(config.flowShift !== undefined ? { flowShift: config.flowShift } : {}),
      seed: Number.isInteger(shot.seed) ? shot.seed : 20261009 + index,
      attempt: `video-${shot.id}-${randomUUID()}`,
    })),
  ],
  composition: {
    output: {
      width: 640,
      height: 360,
      fps: { numerator: FPS, denominator: 1 },
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
    },
    scenes: [{ id: 'scene', description: 'Shared still conditioning multiple independently generated shots' }],
    shots: [
      {
        id: 'shot_board',
        scene: 'scene',
        look: 'shared-look',
        intent: 'Sounded animatic over the whole timeline until real Takes replace intervals.',
        targetFrames: totalFrames,
      },
      ...shots.map(shot => ({
        id: `shot_${shot.id}`,
        scene: 'scene',
        look: 'shared-look',
        intent: `Generated motion for ${shot.id} from the shared still.`,
        targetFrames: SHOT_FRAMES,
      })),
    ],
    // Only the animatic board is placed, so a plain `build` performs NO provider
    // work. Each generated Take is produced later (produce-video-api.mjs /
    // buildProject with authorization), inspected, and then selected by editing
    // these placements to reference the accepted Take's interval.
    placements: [
      {
        id: 'p_board',
        shot: 'shot_board',
        asset: 'reference',
        framing: { fit: 'contain', background: '#0a0e16' },
        inFrame: 0,
        outFrame: totalFrames,
        startFrame: 0,
        audio: 'mute',
        durationFrames: totalFrames,
      },
    ],
    transitions: [],
    audio: [
      {
        id: 'bed_low',
        kind: 'asset',
        asset: 'bed_low',
        inSample: 0,
        startSample: 0,
        durationSamples: totalSamples,
        gain: 0.06,
        fadeInSamples: 12000,
        fadeOutSamples: 24000,
      },
      {
        id: 'bed_high',
        kind: 'asset',
        asset: 'bed_high',
        inSample: 0,
        startSample: 0,
        durationSamples: totalSamples,
        gain: 0.025,
        fadeInSamples: 24000,
        fadeOutSamples: 24000,
      },
    ],
  },
});
await writeFile(join(root, bedLow.asset.path), bedLow.bytes, { flag: 'wx' });
await writeFile(join(root, bedHigh.asset.path), bedHigh.bytes, { flag: 'wx' });
await writeFile(join(root, 'project.json'), JSON.stringify(project, null, 2) + '\n', { flag: 'wx' });

console.log(
  JSON.stringify(
    {
      project: root,
      referenceSha256: sha256,
      output: `${FPS} fps, ${totalFrames} frames, ${SAMPLE_RATE} Hz ${CHANNELS}ch`,
      sharedImageSources: shots.map(shot => `src_${shot.id}`),
      script: join(HERE, 'produce-video-api.mjs'),
      next: [
        'Build and review the animatic (no provider work): build the project normally.',
        'Set VISCRAFT_VIDEO_API_URL to an existing vllm-omni-video service; optionally set VISCRAFT_VIDEO_API_MODEL, VISCRAFT_VIDEO_API_KEY_ENV and the deployment partition VISCRAFT_VIDEO_API_TASK_TYPE.',
        ...shots.map(
          shot =>
            `Produce the real Take with explicit authorization: node tests/fixtures/authoring/produce-video-api.mjs ${root} src_${shot.id} shot_${shot.id} --authorize`,
        ),
        'Inspect each real Take, select a usable middle interval, and decide its native audio explicitly (audio keep/mute).',
      ],
    },
    null,
    2,
  ),
);
