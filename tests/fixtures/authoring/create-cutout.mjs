#!/usr/bin/env node
// Author a multi-shot cutout animation from caller-approved raster images.
//
// This is a *generic* authoring entry point: the caller supplies the images,
// their explicit rights, the background and sprite, the per-shot pose endpoints
// (from/to) and an optional sprite variant per shot. The script composites the
// real RGBA images itself inside an ordinary CodeScene Canvas *before* the
// opaque screenshot — no Core alpha/mask/layer feature is involved — and it
// writes project.json plus a copy of cutout.html. It never calls a generation
// Provider, never claims the images came from a model, and never infers an
// image's origin or rights: those are taken verbatim from the caller's config.
//
// Usage:
//   node tests/fixtures/authoring/create-cutout.mjs <new-project-directory> <config.json>
//
// config.json (strictly validated, unknown keys rejected; asset paths are
// resolved relative to the config file's directory, never the cwd):
//   {
//     "title": "optional display title",
//     "output": { "width": 1280, "height": 720,
//                 "fps": { "numerator": 30, "denominator": 1 },
//                 "sampleRate": 48000, "channels": 2 },
//     "assets": [ { "id": "bg", "path": "art/backdrop.png",
//                   "rights": { "origin": "...", "license": "...", "redistributable": true },
//                   "simulated": false } ],           // 1..30, unique ids, images only
//     "background": "bg",                             // asset id; PNG or JPEG
//     "sprite": "hero",                               // asset id; PNG with alpha
//     "backgroundFit": "cover",                       // optional: contain|cover
//     "backgroundColor": "#09131d",                   // optional opaque fill
//     "pivot": { "x": 0.5, "y": 0.5 },                // optional, normalized [0,1]
//     "shots": [ { "frames": 90,
//                  "from": { "x": 0.3, "y": 0.6, "width": 0.4, "rotation": -8 },
//                  "to":   { "x": 0.6, "y": 0.5, "width": 0.5, "rotation": 6 },
//                  "sprite": "hero-alt" } ]           // optional per-shot variant
//   }
// Constraints: 1..12 shots, total frames <= 1800. background/sprite/every shot
// variant must resolve to an existing asset. Sprite assets (and variants) must
// be PNG; the background may be PNG or JPEG. SVG/other vector input is refused,
// never rasterized. New project directories are required; an existing path is
// never overwritten.
import { constants } from 'node:fs';
import { copyFile, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Id, OutputSchema, RightsSchema, framesToSamples, validateProject } from '../../../dist/src/index.js';
import { hashFile } from '../../../dist/src/shared/hash.js';
import { makeSignalAsset } from './lib/audio-fixture.mjs';

const [directory, configFile] = process.argv.slice(2);
if (!directory || !configFile) {
  throw new Error('Usage: node tests/fixtures/authoring/create-cutout.mjs <new-project-directory> <config.json>');
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_HTML = join(HERE, 'cutout.html');

// --- Strict local config schema (only the documented keys are accepted). ----
const poseSchema = z
  .object({
    x: z.number().finite().min(-1).max(2),
    y: z.number().finite().min(-1).max(2),
    width: z.number().finite().gt(0).max(2),
    rotation: z.number().finite().min(-360).max(360),
  })
  .strict();
const assetSchema = z
  .object({
    id: Id,
    path: z.string().min(1),
    rights: RightsSchema,
    simulated: z.boolean().default(false),
  })
  .strict();
const shotSchema = z
  .object({
    frames: z.number().int().min(1).max(600),
    from: poseSchema,
    to: poseSchema,
    sprite: Id.optional(),
  })
  .strict();
const configSchema = z
  .object({
    title: z.string().min(1).optional(),
    output: OutputSchema,
    assets: z.array(assetSchema).min(1).max(30),
    background: Id,
    sprite: Id,
    backgroundFit: z.enum(['contain', 'cover']).optional(),
    backgroundColor: z
      .string()
      .regex(/^#[a-fA-F0-9]{6}$/)
      .optional(),
    pivot: z
      .object({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1) })
      .strict()
      .optional(),
    shots: z.array(shotSchema).min(1).max(12),
  })
  .strict();

const configPath = resolve(configFile);
const configDir = dirname(configPath);
const config = configSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));

// --- Cross-field validation: identities, references and total budget. -------
const assetIds = new Set(config.assets.map(asset => asset.id));
if (assetIds.size !== config.assets.length) throw new Error('Config asset ids must be unique');
const requireAsset = (id, role) => {
  if (!assetIds.has(id)) throw new Error(`${role} "${id}" does not match any configured asset`);
};
requireAsset(config.background, 'background');
requireAsset(config.sprite, 'sprite');
for (const [index, shot] of config.shots.entries())
  if (shot.sprite) requireAsset(shot.sprite, `shot ${index + 1} sprite variant`);
const totalFrames = config.shots.reduce((sum, shot) => sum + shot.frames, 0);
if (totalFrames > 1800) throw new Error(`Total shot frames ${totalFrames} exceeds the 1800-frame budget`);

const pngSpriteRoles = new Set([config.sprite, ...config.shots.map(shot => shot.sprite).filter(Boolean)]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const sniffImage = head => {
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  const text = head.subarray(0, 512).toString('latin1').trimStart();
  if (/^<\?xml/i.test(text) || /<svg[\s>]/i.test(text)) return 'svg';
  return 'unknown';
};

// --- Resolve paths, sniff real signatures and hash every source BEFORE any
//     filesystem mutation, so a bad config never leaves a half-built project. -
if (
  !(await hashFile(SOURCE_HTML).then(
    () => true,
    () => false,
  ))
)
  throw new Error(`Missing CodeScene entry ${SOURCE_HTML}`);
const prepared = [];
for (const asset of config.assets) {
  const absolute = resolve(configDir, asset.path);
  const handle = await open(absolute, 'r');
  let head;
  try {
    head = Buffer.alloc(16);
    const { bytesRead } = await handle.read(head, 0, 16, 0);
    head = head.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const format = sniffImage(head);
  if (format === 'svg')
    throw new Error(
      `Asset "${asset.id}" is SVG/vector input; provide a raster PNG (sprite) or PNG/JPEG (background) instead — this script never rasterizes vectors`,
    );
  if (format !== 'png' && format !== 'jpeg')
    throw new Error(`Asset "${asset.id}" is neither PNG nor JPEG; only PNG and JPEG raster images are supported`);
  if (pngSpriteRoles.has(asset.id) && format !== 'png')
    throw new Error(
      `Asset "${asset.id}" is used as a sprite/variant but is ${format}; sprites must be PNG so their alpha is preserved`,
    );
  const extension = format === 'png' ? 'png' : 'jpg';
  prepared.push({
    ...asset,
    absolute,
    format,
    extension,
    assetPath: `assets/${asset.id}.${extension}`,
    sha256: await hashFile(absolute),
  });
}

// --- Create the new Project only now; refuse to overwrite existing work. ----
const root = resolve(directory);
try {
  await mkdir(root);
} catch (error) {
  if (error.code === 'EEXIST')
    throw new Error(`Refusing to overwrite existing path ${root}; choose a new project directory`);
  throw error;
}
await mkdir(join(root, 'assets'));
for (const asset of prepared) {
  await copyFile(asset.absolute, join(root, asset.assetPath), constants.COPYFILE_EXCL);
  if ((await hashFile(join(root, asset.assetPath))) !== asset.sha256) {
    throw new Error(
      `Copied asset "${asset.id}" bytes do not match the original; aborting instead of authoring a mismatched Project`,
    );
  }
}
await copyFile(SOURCE_HTML, join(root, 'cutout.html'), constants.COPYFILE_EXCL);

// --- Original signal score (no audio service, no external samples) ----------
const output = config.output;
const fps = output.fps;
const sampleRate = output.sampleRate;
const signalAssets = [];
const signalFiles = [];
const tone = (id, frequency, waveform, startSample, durationSamples, gain, fadeInRatio, fadeOutRatio) => {
  const fadeInSamples = Math.min(durationSamples, Math.max(0, Math.floor(durationSamples * fadeInRatio)));
  const fadeOutSamples = Math.min(
    durationSamples - fadeInSamples,
    Math.max(0, Math.floor(durationSamples * fadeOutRatio)),
  );
  const assetId = `sig_${id}`;
  const signal = makeSignalAsset({
    id: assetId,
    path: `${id}.wav`,
    sampleRate,
    channels: output.channels,
    samples: durationSamples,
    frequency,
    waveform,
  });
  signalAssets.push(signal.asset);
  signalFiles.push({ path: signal.asset.path, bytes: signal.bytes });
  return {
    id,
    kind: 'asset',
    asset: assetId,
    inSample: 0,
    startSample,
    durationSamples,
    gain,
    fadeInSamples,
    fadeOutSamples,
  };
};
const beatFrames = 15; // 120 BPM at 30 fps; a different output fps only changes tempo
const totalSamples = framesToSamples(totalFrames, fps, sampleRate, 'ceil');
const tickSamples = Math.max(1, framesToSamples(6, fps, sampleRate));
const scale = [523.25, 587.33, 659.25, 783.99, 880.0]; // C5 D5 E5 G5 A5
const audio = [];
for (let beat = 0; beat * beatFrames < totalFrames; beat++) {
  const start = framesToSamples(beat * beatFrames, fps, sampleRate);
  audio.push(
    tone(
      `beat_${String(beat).padStart(3, '0')}`,
      scale[beat % scale.length],
      beat % 2 === 0 ? 'triangle' : 'sine',
      start,
      Math.min(tickSamples, totalSamples - start),
      0.14,
      0.03,
      0.22,
    ),
  );
}
let cursor = 0;
for (const [index, shot] of config.shots.entries()) {
  audio.push(
    tone(
      `pad_${index + 1}`,
      index % 2 === 0 ? 65.41 : 73.42,
      'sine',
      framesToSamples(cursor, fps, sampleRate),
      framesToSamples(cursor + shot.frames, fps, sampleRate) - framesToSamples(cursor, fps, sampleRate),
      0.07,
      0.12,
      0.22,
    ),
  );
  cursor += shot.frames;
}
const accentStart = framesToSamples(Math.max(0, totalFrames - 10), fps, sampleRate);
audio.push(tone('accent_final', 1046.5, 'triangle', accentStart, totalSamples - accentStart, 0.12, 0.08, 0.5));

// --- Author one code Source per shot so scoped sprite variants stay per cut. -
const scene = 'cutout-scene';
const look = 'cutout-look';
const pivot = config.pivot ?? { x: 0.5, y: 0.5 };
const backgroundFit = config.backgroundFit ?? 'cover';
const backgroundColor = config.backgroundColor ?? '#09131d';
const sources = [];
const shots = [];
const placements = [];
let startFrame = 0;
for (const [index, shot] of config.shots.entries()) {
  const id = index + 1;
  const sourceId = `shot-${id}`;
  sources.push({
    id: sourceId,
    kind: 'browser', output: 'picture',
    entry: 'cutout.html',
    resources: [],
    bindings: ['background', 'sprite'],
    ...(shot.sprite ? { bindingOverrides: { sprite: shot.sprite } } : {}),
    params: { from: shot.from, to: shot.to, pivot, backgroundFit, backgroundColor, frames: shot.frames },
    seed: 0,
    frames: shot.frames,
  });
  const variant = shot.sprite ? `, sprite=${shot.sprite}` : '';
  shots.push({
    id: sourceId,
    scene,
    look,
    targetFrames: shot.frames,
    intent: `Cut ${id}: interpolate the approved sprite from pose (${shot.from.x},${shot.from.y},w=${shot.from.width},r=${shot.from.rotation}) to (${shot.to.x},${shot.to.y},w=${shot.to.width},r=${shot.to.rotation}) over ${shot.frames} frames${variant}, composited over the approved background. Review the actual Build frames before accepting.`,
  });
  placements.push({
    id: `cut-${id}`,
    shot: sourceId,
    source: sourceId,
    inFrame: 0,
    outFrame: shot.frames,
    startFrame,
    audio: 'mute',
  });
  startFrame += shot.frames;
}

const project = validateProject({
  schemaVersion: 1,
  id: `cutout-${randomUUID()}`,
  revision: 1,
  title: config.title ?? 'CUTOUT — approved-image layered animation',
  direction: {
    intent:
      'Composite caller-approved raster images into an editable multi-shot cutout animation using an ordinary CodeScene Canvas: each frame fills an opaque background, fits the approved background image, then draws the transparent sprite PNG source-over at a deterministic interpolated pose between the authored from/to endpoints. No Core alpha/mask/layer feature and no generation Provider is involved; image origin and rights come only from the caller config and are never inferred from pixels. Per-shot sprite variants are scoped with bindingOverrides so editing one cut cannot leak into the others. Review the actual Build frames, then adjust poses, look, sound or delivery.',
    looks: [
      {
        id: look,
        description:
          'Approved raster background with caller-chosen contain/cover fit plus the approved sprite PNG placed by authored pose; no automatic segmentation or recoloring.',
      },
    ],
    transitions: [],
  },
  assets: [
    ...prepared.map(asset => ({
      id: asset.id,
      revision: 1,
      path: asset.assetPath,
      sha256: asset.sha256,
      type: 'image',
      rights: asset.rights,
      simulated: asset.simulated,
    })),
    ...signalAssets,
  ],
  bindings: { background: config.background, sprite: config.sprite },
  sources,
  composition: {
    output,
    scenes: [{ id: scene, description: 'Caller-ordered cutout sequence; one pose-interpolated Source per cut' }],
    shots,
    placements,
    transitions: [], // No silent transitions: cuts are hard and explicit.
    audio, // Original PCM signals only; placements stay mute so the score is the only sound.
  },
});
for (const signal of signalFiles) await writeFile(join(root, signal.path), signal.bytes, { flag: 'wx' });
await writeFile(join(root, 'project.json'), JSON.stringify(project, null, 2) + '\n', { flag: 'wx' });

console.log(
  JSON.stringify(
    {
      project: root,
      authored: true,
      built: false,
      provider: null,
      title: project.title,
      output,
      shots: config.shots.length,
      frames: totalFrames,
      background: { id: config.background, fit: backgroundFit, color: backgroundColor },
      sprite: { id: config.sprite, pivot },
      assets: prepared.map(asset => ({
        id: asset.id,
        path: asset.assetPath,
        type: 'image',
        format: asset.format,
        sha256: asset.sha256,
        simulated: asset.simulated,
      })),
      audioClips: audio.length,
      notes: [
        'Authored project.json + cutout.html only: no Build ran, no Provider was called, and no image was generated.',
        'The images are caller-approved rasters; their rights are recorded verbatim and their origin is never inferred from pixels.',
        'Each shot is its own code Source (entry cutout.html) so a scoped sprite variant via bindingOverrides cannot leak across cuts.',
        'The sprite pose is a pure linear interpolation between from/to over integer frames; there is no physics, wall clock or randomness.',
        'The soundtrack is locally written PCM signal files sized with the canonical framesToSamples clock; no audio service is claimed.',
      ],
      next: 'Review this authored cutout; then run the canonical Build (buildProject) to composite the images into frames, inspect the actual output, and adjust poses, variants, timing or sound. Then review and deliver. This script never called a Build or Provider.',
    },
    null,
    2,
  ),
);
