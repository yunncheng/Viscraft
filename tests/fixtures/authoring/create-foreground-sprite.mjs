#!/usr/bin/env node
// Prepare a transparent foreground sprite from a caller-approved raster image
// using *explicit* extraction only. There is no CV model, no segmentation guess,
// no network access and no generation Provider: the foreground/background split
// is either the caller's own grayscale mask or a caller-declared chroma key.
//
// This is a host preparation step, not a Build: it never produces a canonical
// Artifact, never invents a Build/Take id and never claims the pixels came from
// a model. Rights and simulation provenance are taken verbatim from the caller.
//
// Usage:
//   node tests/fixtures/authoring/create-foreground-sprite.mjs <new-output-directory> <config.json>
//
// config.json (strictly validated, unknown keys rejected; every path is resolved
// relative to the config file's directory, never the cwd):
//   {
//     "input": { "path": "art/subject.png",
//                "rights": { "origin": "...", "license": "...", "redistributable": true },
//                "simulated": false },                    // PNG or JPEG raster
//     "extraction": { "kind": "mask",                       // OR the key form below
//                     "mask": { "path": "art/mask.png",
//                               "rights": { ... }, "simulated": false } },
//     "rights": { "origin": "...", "license": "...", "redistributable": true }
//   }
//   extraction "key" form (mutually exclusive with "mask"):
//     { "kind": "key", "color": "#00ff00",
//       "similarity": 0.1,   // finite, 0.01..1
//       "blend": 0.05,       // finite, 0..1
//       "despill": "green" } // optional, applied AFTER the key
//
// Semantics / guarantees:
//   * input and mask are validated by real signature (PNG/JPEG magic), capped at
//     16 MiB on disk and 4096x4096 pixels, and decoded with the existing ffmpeg.
//   * mask extraction requires the mask to have exactly the input's dimensions
//     (never silently scaled); the grayscale luma becomes straight alpha and the
//     input RGB is kept unassociated. Exact black is transparent, white opaque.
//   * key extraction runs `format=rgb24,colorkey=color:similarity:blend` with an
//     optional `despill` immediately AFTER the key, then `format=rgba`.
//   * the produced RGBA is decoded back in a private staging dir and must contain
//     at least one fully transparent AND one fully opaque pixel; all-opaque or
//     all-transparent output is refused (that is not a cutout).
//   * output is written to a private sibling staging dir and atomically renamed;
//     an existing destination is never overwritten and no input is ever mutated
//     (input/mask hashes are re-checked after extraction).
//
// Output directory contents:
//   input.<png|jpg>   exact original bytes
//   mask.<png|jpg>    exact mask bytes (mask extraction only)
//   sprite.png        extracted straight-alpha RGBA
//   provenance.json   original/mask hashes + rights + settings + alpha stats
import { constants } from 'node:fs';
import { copyFile, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { RightsSchema, probeMedia } from '../../../dist/src/index.js';
import { hashFile } from '../../../dist/src/shared/hash.js';
import { runCommand } from '../../../dist/src/shared/process.js';
import { resolveDestination } from '../../../dist/src/operations/delivery/portable.js';

const [directory, configFile] = process.argv.slice(2);
if (!directory || !configFile) {
  throw new Error(
    'Usage: node tests/fixtures/authoring/create-foreground-sprite.mjs <new-output-directory> <config.json>',
  );
}

const MAX_BYTES = 16 * 1024 * 1024; // 16 MiB on disk per raster
const MAX_EDGE = 4096; // pixels per side
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// --- Strict local config schema (only the documented keys are accepted). ----
const rasterSchema = z
  .object({
    path: z.string().min(1),
    rights: RightsSchema,
    simulated: z.boolean().default(false),
  })
  .strict();
const extractionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mask'), mask: rasterSchema }).strict(),
  z
    .object({
      kind: z.literal('key'),
      color: z.string().regex(/^#[a-fA-F0-9]{6}$/),
      similarity: z.number().finite().min(0.01).max(1),
      blend: z.number().finite().min(0).max(1),
      despill: z.enum(['green', 'blue']).optional(),
    })
    .strict(),
]);
const configSchema = z
  .object({
    input: rasterSchema,
    extraction: extractionSchema,
    rights: RightsSchema,
  })
  .strict();

const configPath = resolve(configFile);
const configDir = dirname(configPath);
const config = configSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));

/** Real signature sniffing; SVG/vector input is refused, never rasterized. */
const sniffImage = head => {
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  const text = head.subarray(0, 512).toString('latin1').trimStart();
  if (/^<\?xml/i.test(text) || /<svg[\s>]/i.test(text)) return 'svg';
  return 'unknown';
};

/**
 * Validate one declared raster: real signature, on-disk byte cap and decoded
 * dimensions. Returns the resolved absolute path plus the probed geometry.
 */
async function inspectRaster(spec, role) {
  const absolute = resolve(configDir, spec.path);
  let info;
  try {
    info = await stat(absolute);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${role} image not found: ${spec.path}`);
    throw error;
  }
  if (!info.isFile()) throw new Error(`${role} path is not a regular file: ${spec.path}`);
  if (info.size > MAX_BYTES)
    throw new Error(`${role} image is ${info.size} bytes, exceeding the ${MAX_BYTES}-byte cap`);
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
    throw new Error(`${role} is SVG/vector input; provide a raster PNG/JPEG — this tool never rasterizes vectors`);
  if (format !== 'png' && format !== 'jpeg')
    throw new Error(`${role} is neither PNG nor JPEG; only PNG and JPEG rasters are supported`);
  const media = await probeMedia(absolute);
  if (!media.width || !media.height) throw new Error(`${role} decoded to zero dimensions`);
  if (media.width > MAX_EDGE || media.height > MAX_EDGE)
    throw new Error(`${role} is ${media.width}x${media.height}, exceeding the ${MAX_EDGE}x${MAX_EDGE} cap`);
  return {
    ...spec,
    absolute,
    format,
    extension: format === 'png' ? 'png' : 'jpg',
    bytes: info.size,
    width: media.width,
    height: media.height,
    sha256: await hashFile(absolute),
  };
}

// --- Validate all inputs and hash them BEFORE any filesystem mutation --------
const input = await inspectRaster(config.input, 'input');
const mask = config.extraction.kind === 'mask' ? await inspectRaster(config.extraction.mask, 'mask') : undefined;
if (mask && (mask.width !== input.width || mask.height !== input.height)) {
  throw new Error(
    `mask is ${mask.width}x${mask.height} but input is ${input.width}x${input.height}; the mask must match the input exactly — this tool never scales`,
  );
}

const ffmpegVersion = (await runCommand('ffmpeg', ['-version'])).split('\n')[0].trim();

// The chroma-key filter chain: RGB -> colorkey -> optional despill AFTER key -> RGBA.
const keyColor = config.extraction.kind === 'key' ? `0x${config.extraction.color.slice(1).toLowerCase()}` : null;
const keyFilter =
  config.extraction.kind === 'key'
    ? `format=rgb24,colorkey=${keyColor}:${config.extraction.similarity}:${config.extraction.blend}${config.extraction.despill ? `,despill=type=${config.extraction.despill}` : ''},format=rgba`
    : null;

// --- Resolve the destination (must be new and outside the config directory) --
const rootReal = await realpath(configDir);
const { destReal, parentReal } = await resolveDestination(resolve(directory), rootReal);
const staging = join(parentReal, `.${basename(destReal)}.${randomUUID()}.staging`);
await mkdir(staging);

let committed = false;
try {
  // 1. Retain the exact original bytes, verified to match the pre-hash.
  const inputFile = `input.${input.extension}`;
  await copyFile(input.absolute, join(staging, inputFile), constants.COPYFILE_EXCL);
  if ((await hashFile(join(staging, inputFile))) !== input.sha256)
    throw new Error('retained input copy does not match the original bytes');
  let maskFile = null;
  if (mask) {
    maskFile = `mask.${mask.extension}`;
    await copyFile(mask.absolute, join(staging, maskFile), constants.COPYFILE_EXCL);
    if ((await hashFile(join(staging, maskFile))) !== mask.sha256)
      throw new Error('retained mask copy does not match the original bytes');
  }

  // 2. Extract the straight-alpha RGBA sprite with the existing ffmpeg.
  const spritePath = join(staging, 'sprite.png');
  if (mask) {
    await runCommand('ffmpeg', [
      '-v',
      'error',
      '-nostdin',
      '-y',
      '-filter_threads',
      '1',
      '-filter_complex_threads',
      '1',
      '-i',
      input.absolute,
      '-i',
      mask.absolute,
      '-filter_complex',
      `[0:v]format=rgb24[img];[1:v]format=gray[mk];[img][mk]alphamerge,format=rgba`,
      '-frames:v',
      '1',
      '-threads',
      '2',
      spritePath,
    ]);
  } else {
    await runCommand('ffmpeg', [
      '-v',
      'error',
      '-nostdin',
      '-y',
      '-filter_threads',
      '1',
      '-filter_complex_threads',
      '1',
      '-i',
      input.absolute,
      '-vf',
      keyFilter,
      '-frames:v',
      '1',
      '-threads',
      '2',
      spritePath,
    ]);
  }

  // 3. Prove the output geometry matches the input exactly (no silent scale).
  const spriteMedia = await probeMedia(spritePath);
  if (spriteMedia.width !== input.width || spriteMedia.height !== input.height) {
    throw new Error(
      `extracted sprite is ${spriteMedia.width}x${spriteMedia.height}, expected ${input.width}x${input.height}`,
    );
  }

  // 4. Decode the actual RGBA in the private staging dir and measure alpha.
  const decoded = join(staging, `.decoded-${randomUUID()}.rgba`);
  await runCommand('ffmpeg', [
    '-v',
    'error',
    '-nostdin',
    '-y',
    '-filter_threads',
    '1',
    '-filter_complex_threads',
    '1',
    '-i',
    spritePath,
    '-frames:v',
    '1',
    '-pix_fmt',
    'rgba',
    '-f',
    'rawvideo',
    '-threads',
    '2',
    decoded,
  ]);
  const raw = await readFile(decoded);
  await rm(decoded, { force: true });
  const total = input.width * input.height;
  if (raw.length !== total * 4)
    throw new Error(
      `decoded sprite is ${raw.length} bytes, expected ${total * 4} for ${input.width}x${input.height} RGBA`,
    );
  let transparent = 0,
    opaque = 0,
    partial = 0;
  for (let offset = 3; offset < raw.length; offset += 4) {
    const alpha = raw[offset];
    if (alpha === 0) transparent++;
    else if (alpha === 255) opaque++;
    else partial++;
  }
  if (transparent === 0)
    throw new Error(
      'extracted sprite has no fully transparent pixel; it is not a cutout (check the mask/key settings)',
    );
  if (opaque === 0)
    throw new Error(
      'extracted sprite has no fully opaque pixel; the whole foreground was removed (check the mask/key settings)',
    );

  // 5. The originals must be byte-identical after extraction (no mutation).
  if ((await hashFile(input.absolute)) !== input.sha256)
    throw new Error('input image changed during extraction; refusing to emit a mismatched sprite');
  if (mask && (await hashFile(mask.absolute)) !== mask.sha256)
    throw new Error('mask image changed during extraction; refusing to emit a mismatched sprite');

  const spriteSha = await hashFile(spritePath);
  const spriteBytes = (await stat(spritePath)).size;
  const simulated = input.simulated || Boolean(mask && mask.simulated);

  // 6. Provenance: caller rights verbatim, real hashes/stats, honest limits.
  const provenance = {
    kind: 'foreground-sprite-preparation',
    schemaVersion: 1,
    preparedBy: 'tests/fixtures/authoring/create-foreground-sprite.mjs',
    preparedAt: new Date().toISOString(),
    backend: { tool: 'ffmpeg', version: ffmpegVersion },
    extraction: mask
      ? { kind: 'mask', filter: '[0:v]format=rgb24[img];[1:v]format=gray[mk];[img][mk]alphamerge,format=rgba' }
      : {
          kind: 'key',
          color: config.extraction.color,
          similarity: config.extraction.similarity,
          blend: config.extraction.blend,
          despill: config.extraction.despill ?? null,
          filter: keyFilter,
        },
    input: {
      file: inputFile,
      format: input.format,
      bytes: input.bytes,
      width: input.width,
      height: input.height,
      sha256: input.sha256,
      rights: input.rights,
      simulated: input.simulated,
    },
    mask: mask
      ? {
          file: maskFile,
          format: mask.format,
          bytes: mask.bytes,
          width: mask.width,
          height: mask.height,
          sha256: mask.sha256,
          rights: mask.rights,
          simulated: mask.simulated,
        }
      : null,
    sprite: {
      file: 'sprite.png',
      bytes: spriteBytes,
      width: input.width,
      height: input.height,
      sha256: spriteSha,
      rights: config.rights,
      simulated,
    },
    alpha: { transparent, partial, opaque, total, transparentRatio: transparent / total, opaqueRatio: opaque / total },
    outputSha256: spriteSha,
    limitations: [
      'Foreground/background separation uses only the caller-declared mask or chroma key; nothing is inferred from pixels and no semantic layer is recovered.',
      ...(mask
        ? []
        : [
            'colorkey compares original color distance, so subject regions close to the key color can also be removed; this is not guaranteed segmentation.',
          ]),
      ...(mask ? ['The mask must match the input dimensions exactly; it is never scaled.'] : []),
      'Any alpha already present in the input is flattened to RGB before extraction (the split is defined by the mask/key only).',
      'Rights and simulation are recorded verbatim from the caller; this tool grants no derivative or public-permission and makes no licensing claim.',
    ],
  };
  await writeFile(join(staging, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`, { flag: 'wx' });

  // 7. Publish atomically: private staging -> rename into the new destination.
  await rename(staging, destReal);
  committed = true;

  console.log(
    JSON.stringify(
      {
        output: destReal,
        extracted: true,
        built: false,
        provider: null,
        input: {
          file: inputFile,
          format: input.format,
          bytes: input.bytes,
          width: input.width,
          height: input.height,
          sha256: input.sha256,
          simulated: input.simulated,
        },
        mask: mask
          ? {
              file: maskFile,
              format: mask.format,
              bytes: mask.bytes,
              width: mask.width,
              height: mask.height,
              sha256: mask.sha256,
              simulated: mask.simulated,
            }
          : null,
        extraction: provenance.extraction,
        sprite: {
          file: 'sprite.png',
          bytes: spriteBytes,
          width: input.width,
          height: input.height,
          sha256: spriteSha,
          rights: config.rights,
          simulated,
        },
        alpha: provenance.alpha,
        provenance: join(destReal, 'provenance.json'),
        notes: [
          'Prepared by explicit extraction only: no Build ran, no generation Provider was called, no Build/Take/Artifact id was invented.',
          'Foreground separation is the caller-declared mask or chroma key; no segmentation model was used and no semantics were recovered.',
          'The original input (and mask) are retained byte-identical and were re-hashed after extraction to prove they were not mutated.',
          'Rights are recorded verbatim from the caller; the sprite does not inherit any implied public or derivative permission.',
        ],
        next: 'Open sprite.png to inspect the actual alpha, then use it as an approved sprite together with a backdrop through tests/fixtures/authoring/create-cutout.mjs. This tool never ran a Build or a Provider.',
      },
      null,
      2,
    ),
  );
} finally {
  if (!committed) await rm(staging, { recursive: true, force: true });
}
