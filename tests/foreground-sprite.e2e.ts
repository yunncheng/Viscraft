/**
 * Independent end-to-end verification of explicit foreground extraction
 * (`tests/fixtures/authoring/create-foreground-sprite.mjs`) and its downstream production.
 *
 * The tool performs NO inference: the foreground/background split is either the
 * caller's grayscale mask or a caller-declared chroma key, and rights/simulation
 * are taken verbatim. These tests independently decode the produced RGBA (they
 * do not trust the tool's own alpha statistics) and prove:
 *
 *  1. mask extraction preserves the source RGB exactly, turns exact black into
 *     alpha 0, white into 255 and mid-gray into ~128, and retains the original
 *     input/mask files byte-identical with hashes, verbatim rights and OR-ed
 *     simulation recorded in provenance.json (and no Build/Take/Artifact id);
 *  2. the key path removes the declared key, keeps the subject, and an optional
 *     despill applied AFTER the key measurably reduces a green fringe (with no
 *     color-preservation guarantee asserted for the subject);
 *  3. malformed, mixed, out-of-range, non-finite, dimension-mismatched, non-raster,
 *     all-opaque, all-transparent, oversized and unsafe (inside-config / overwrite /
 *     missing-parent) requests are refused before any output exists, no private
 *     staging directory survives, and the inputs are never mutated;
 *  4. the ACTUAL prepared sprite drives a real browser cutout Build (via the
 *     existing authoring example), a scoped pose edit recaptures only its own
 *     Source, a changed rebuild reuses the sound mix, and a delivered portable
 *     export explicitly packages the original input, mask and provenance with
 *     their rights and without an invented derivedFrom — then reopens all-reuse.
 *
 * Fixtures are authored here as real RGBA PNGs (minimal zlib+CRC encoder) so the
 * mask/alpha and RGB values are guaranteed and are decoded back independently.
 */

import assert from 'node:assert/strict';
import {
  access,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { test } from 'node:test';

import { buildProject } from '../src/build/build.js';
import { deliverProject } from '../src/operations/delivery/delivery.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { loadProject, saveProject } from '../src/project/project.js';
import { probeMedia } from '../src/backends/media/probe.js';
import type { BrowserPictureSource } from '../src/core/schema.js';

// ---------------------------------------------------------------------------
// Minimal, dependency-free RGBA PNG writer (zlib + CRC32)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

type RGBA = readonly [number, number, number, number];

function encodePng(width: number, height: number, pixel: (x: number, y: number) => RGBA): Buffer {
  const stride = 1 + width * 4;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      const offset = rowStart + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const RIGHTS: { origin: string; license: string; redistributable: boolean } = {
  origin: 'original synthetic test fixture',
  license: 'original test fixture (no third-party bytes)',
  redistributable: true,
};

const W = 20;
const H = 20;
const TOTAL = W * H;

/** Opaque 20x20 source whose RGB varies with x so preservation is provable. */
function sourceInputPng(): Buffer {
  return encodePng(W, H, x => [40 + x * 8, 200, 60, 255]);
}

/**
 * 20x20 mask: columns 0..7 white (opaque), 8..11 mid-gray 128 (partial),
 * 12..19 black (transparent).
 */
function maskPng(): Buffer {
  return encodePng(W, H, x => {
    const value = x < 8 ? 255 : x < 12 ? 128 : 0;
    return [value, value, value, 255];
  });
}

/** Key fixture: pure green field, a red subject, and one greenish fringe pixel. */
function keyInputPng(): Buffer {
  return encodePng(W, H, (x, y) => {
    if (x >= 7 && x < 13 && y >= 7 && y < 13) return [220, 30, 30, 255];
    if (x === 3 && y === 10) return [200, 255, 200, 255];
    return [0, 255, 0, 255];
  });
}

function solidPng(value: readonly [number, number, number]): Buffer {
  return encodePng(W, H, () => [value[0], value[1], value[2], 255]);
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function runSprite(target: string, configPath: string): Promise<string> {
  return runCommand(process.execPath, [
    resolve('tests/fixtures/authoring/create-foreground-sprite.mjs'),
    target,
    configPath,
  ]);
}

function runCutout(target: string, configPath: string): Promise<string> {
  return runCommand(process.execPath, [resolve('tests/fixtures/authoring/create-cutout.mjs'), target, configPath]);
}

async function decodeRGBA(file: string, width: number, height: number, outFile: string): Promise<Buffer> {
  await runCommand('ffmpeg', ['-v', 'error', '-y', '-i', file, '-pix_fmt', 'rgba', '-f', 'rawvideo', outFile]);
  const raw = await readFile(outFile);
  assert.equal(raw.length, width * height * 4, `decoded ${file} must be a ${width}x${height} RGBA frame`);
  return raw;
}

async function decodeRGB24(
  file: string,
  width: number,
  height: number,
  frames: number,
  outFile: string,
): Promise<Buffer> {
  await runCommand('ffmpeg', ['-v', 'error', '-y', '-i', file, '-pix_fmt', 'rgb24', '-f', 'rawvideo', outFile]);
  const raw = await readFile(outFile);
  assert.equal(raw.length, width * height * 3 * frames, `decoded ${file} must hold ${frames} RGB frames`);
  return raw;
}

type RGBA4 = readonly [number, number, number, number];
type RGB = readonly [number, number, number];

function rgbaPixel(buf: Buffer, width: number, x: number, y: number): RGBA4 {
  const offset = (y * width + x) * 4;
  return [buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]];
}

function framePixel(buf: Buffer, width: number, height: number, frame: number, x: number, y: number): RGB {
  const offset = frame * width * height * 3 + (y * width + x) * 3;
  return [buf[offset], buf[offset + 1], buf[offset + 2]];
}

const isGreen: (p: RGB) => boolean = ([r, g, b]) => g >= 150 && r <= 130 && b <= 130;
const isBlue: (p: RGB) => boolean = ([r, g, b]) => b >= 150 && r <= 120 && g <= 120;
const isRed: (p: RGB) => boolean = ([r, g, b]) => r >= 160 && g <= 90 && b <= 90;

async function assertNoStaging(parent: string, label: string): Promise<void> {
  const entries = await readdir(parent, { withFileTypes: true });
  const stray = entries.filter(entry => entry.name.includes('.staging')).map(entry => entry.name);
  assert.deepEqual(stray, [], `${label}: no private staging directory may survive a failure`);
}

function codeSource(project: Awaited<ReturnType<typeof loadProject>>, id: string): BrowserPictureSource {
  const source = project.sources.find(candidate => candidate.id === id);
  if (!source || source.kind !== 'browser' || source.output !== 'picture')
    throw new Error(`expected a code Source ${id}`);
  return source;
}

// ---------------------------------------------------------------------------
// 1. Mask extraction: real alpha, exact RGB preservation and retained lineage
// ---------------------------------------------------------------------------

test('the foreground-sprite example turns a real mask into straight alpha, preserves source RGB, retains both inputs byte-identical and records honest provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-fg-mask-'));
  const fixtures = join(root, 'fixtures');
  const out = join(root, 'out');
  try {
    await mkdir(fixtures, { recursive: true });
    const inputBytes = sourceInputPng();
    const maskBytes = maskPng();
    await writeFile(join(fixtures, 'input.png'), inputBytes);
    await writeFile(join(fixtures, 'mask.png'), maskBytes);

    const inputRights = {
      origin: 'caller-supplied subject raster',
      license: 'original test fixture',
      redistributable: true,
    };
    const maskRights = {
      origin: 'caller-authored grayscale mask',
      license: 'original test fixture',
      redistributable: true,
    };
    const spriteRights = { origin: 'prepared sprite output', license: 'original test fixture', redistributable: true };
    const config = join(fixtures, 'config.json');
    await writeJson(config, {
      input: { path: 'input.png', rights: inputRights },
      extraction: { kind: 'mask', mask: { path: 'mask.png', rights: maskRights } },
      rights: spriteRights,
    });

    const summary = JSON.parse(await runSprite(out, config)) as Record<string, any>;
    assert.equal(summary.extracted, true, 'the tool must report that it extracted');
    assert.equal(summary.built, false, 'no Build may be claimed');
    assert.equal(summary.provider, null, 'no generation Provider may be involved');
    assert.equal(summary.output, await realpath(out), 'the reported output must be the created directory');

    // Only the documented files, and the originals retained byte-identical.
    assert.deepEqual((await readdir(out)).sort(), ['input.png', 'mask.png', 'provenance.json', 'sprite.png']);
    const retainedInput = await readFile(join(out, 'input.png'));
    const retainedMask = await readFile(join(out, 'mask.png'));
    assert.ok(retainedInput.equals(inputBytes), 'the retained input must be the exact original bytes');
    assert.ok(retainedMask.equals(maskBytes), 'the retained mask must be the exact original bytes');
    assert.equal(await hashFile(join(out, 'input.png')), await hashFile(join(fixtures, 'input.png')));
    assert.equal(await hashFile(join(out, 'mask.png')), await hashFile(join(fixtures, 'mask.png')));

    // The produced sprite is a real 20x20 raster inside the documented caps.
    const spriteMedia = await probeMedia(join(out, 'sprite.png'));
    assert.equal(spriteMedia.width, W);
    assert.equal(spriteMedia.height, H);
    assert.ok(
      spriteMedia.width <= 4096 && spriteMedia.height <= 4096,
      'sprite dimensions must stay within the 4096 cap',
    );
    assert.ok(
      (await stat(join(out, 'sprite.png'))).size <= 16 * 1024 * 1024,
      'sprite bytes must stay within the 16 MiB cap',
    );

    // Independently decode the RGBA and prove the alpha/RGB contract.
    const sprite = await decodeRGBA(join(out, 'sprite.png'), W, H, join(root, 'sprite.decoded.rgba'));
    const opaque = rgbaPixel(sprite, W, 4, 10);
    const partial = rgbaPixel(sprite, W, 10, 10);
    const transparent = rgbaPixel(sprite, W, 16, 10);
    assert.equal(opaque[3], 255, 'white mask must become fully opaque');
    assert.deepEqual(
      [opaque[0], opaque[1], opaque[2]],
      [40 + 4 * 8, 200, 60],
      'opaque source RGB must be preserved exactly',
    );
    assert.ok(Math.abs(partial[3] - 128) <= 2, `mid-gray mask must become ~128 alpha, got ${partial[3]}`);
    assert.deepEqual(
      [partial[0], partial[1], partial[2]],
      [40 + 10 * 8, 200, 60],
      'partial source RGB must be preserved exactly',
    );
    assert.equal(transparent[3], 0, 'black mask must become fully transparent');
    assert.deepEqual(
      [transparent[0], transparent[1], transparent[2]],
      [40 + 16 * 8, 200, 60],
      'transparent source RGB must remain unassociated',
    );

    // Provenance: hashes, verbatim rights, OR-ed simulation, honest limits, no Build ids.
    const provenance = JSON.parse(await readFile(join(out, 'provenance.json'), 'utf8')) as Record<string, any>;
    assert.equal(provenance.kind, 'foreground-sprite-preparation');
    assert.equal(provenance.backend.tool, 'ffmpeg');
    assert.equal(provenance.extraction.kind, 'mask');
    assert.match(provenance.extraction.filter, /alphamerge/);
    assert.equal(provenance.input.sha256, await hashFile(join(fixtures, 'input.png')));
    assert.equal(provenance.mask.sha256, await hashFile(join(fixtures, 'mask.png')));
    assert.equal(provenance.sprite.sha256, await hashFile(join(out, 'sprite.png')));
    assert.equal(provenance.sprite.file, 'sprite.png');
    assert.deepEqual(provenance.input.rights, inputRights, 'input rights must be recorded verbatim');
    assert.deepEqual(provenance.mask.rights, maskRights, 'mask rights must be recorded verbatim');
    assert.deepEqual(provenance.sprite.rights, spriteRights, 'output rights must be recorded verbatim');
    assert.equal(provenance.input.simulated, false);
    assert.equal(provenance.mask.simulated, false);
    assert.equal(provenance.sprite.simulated, false);
    assert.equal(provenance.alpha.transparent > 0 && provenance.alpha.opaque > 0, true);
    assert.equal(provenance.alpha.total, TOTAL);
    assert.ok(Array.isArray(provenance.limitations) && provenance.limitations.length > 0);
    assert.equal('build' in provenance, false, 'no Build id may be invented');
    assert.equal('take' in provenance, false, 'no Take id may be invented');
    assert.equal(provenance.sprite.id, undefined, 'no Artifact id may be invented on the sprite');

    // Simulation provenance is the OR of input/mask flags.
    const simInput = join(root, 'sim-input');
    const simMask = join(root, 'sim-mask');
    const simOnlyInput = join(root, 'sim-input-only');
    await writeJson(join(fixtures, 'sim-input.json'), {
      input: { path: 'input.png', rights: inputRights, simulated: true },
      extraction: { kind: 'mask', mask: { path: 'mask.png', rights: maskRights } },
      rights: spriteRights,
    });
    const simInputSummary = JSON.parse(await runSprite(simInput, join(fixtures, 'sim-input.json'))) as Record<
      string,
      any
    >;
    assert.equal(simInputSummary.sprite.simulated, true, 'a simulated input must taint the sprite');
    await writeJson(join(fixtures, 'sim-mask.json'), {
      input: { path: 'input.png', rights: inputRights },
      extraction: { kind: 'mask', mask: { path: 'mask.png', rights: maskRights, simulated: true } },
      rights: spriteRights,
    });
    const simMaskSummary = JSON.parse(await runSprite(simMask, join(fixtures, 'sim-mask.json'))) as Record<string, any>;
    assert.equal(simMaskSummary.sprite.simulated, true, 'a simulated mask must taint the sprite');
    await writeJson(join(fixtures, 'sim-none.json'), {
      input: { path: 'input.png', rights: inputRights },
      extraction: { kind: 'mask', mask: { path: 'mask.png', rights: maskRights } },
      rights: spriteRights,
    });
    const simNoneSummary = JSON.parse(await runSprite(simOnlyInput, join(fixtures, 'sim-none.json'))) as Record<
      string,
      any
    >;
    assert.equal(simNoneSummary.sprite.simulated, false, 'genuine inputs must not be marked simulated');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Chroma key: declared key removed, subject kept, despill AFTER the key
// ---------------------------------------------------------------------------

test('the chroma-key path removes the declared key, keeps the subject, and a green despill applied after the key measurably reduces a green fringe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-fg-key-'));
  const fixtures = join(root, 'fixtures');
  try {
    await mkdir(fixtures, { recursive: true });
    await writeFile(join(fixtures, 'keyin.png'), keyInputPng());

    const key = { kind: 'key' as const, color: '#00FF00', similarity: 0.15, blend: 0 };
    const plainConfig = join(fixtures, 'plain.json');
    const despillConfig = join(fixtures, 'despill.json');
    await writeJson(plainConfig, {
      input: { path: 'keyin.png', rights: RIGHTS },
      extraction: key,
      rights: RIGHTS,
    });
    await writeJson(despillConfig, {
      input: { path: 'keyin.png', rights: RIGHTS },
      extraction: { ...key, despill: 'green' },
      rights: RIGHTS,
    });

    const plainOut = join(root, 'plain');
    const despillOut = join(root, 'despill');
    const plainSummary = JSON.parse(await runSprite(plainOut, plainConfig)) as Record<string, any>;
    const despillSummary = JSON.parse(await runSprite(despillOut, despillConfig)) as Record<string, any>;
    assert.equal(plainSummary.built, false);
    assert.equal(despillSummary.built, false);
    // Key extraction retains no mask file.
    assert.deepEqual((await readdir(plainOut)).sort(), ['input.png', 'provenance.json', 'sprite.png']);

    const plain = await decodeRGBA(join(plainOut, 'sprite.png'), W, H, join(root, 'plain.rgba'));
    const despill = await decodeRGBA(join(despillOut, 'sprite.png'), W, H, join(root, 'despill.rgba'));

    // The declared key is removed and the subject is present.
    const plainBackground = rgbaPixel(plain, W, 1, 1);
    const plainSubject = rgbaPixel(plain, W, 10, 10);
    assert.equal(plainBackground[3], 0, 'the declared key color must become transparent');
    assert.equal(plainSubject[3], 255, 'the subject must remain fully opaque');
    assert.ok(
      isRed([plainSubject[0], plainSubject[1], plainSubject[2]]),
      'the subject keeps its own color after keying',
    );
    assert.equal(rgbaPixel(despill, W, 10, 10)[3], 255, 'the subject must survive despill');

    // The green fringe is preserved as-is without despill, and its green channel
    // is measurably reduced by a despill applied AFTER the key.
    const plainFringe = rgbaPixel(plain, W, 3, 10);
    const despillFringe = rgbaPixel(despill, W, 3, 10);
    assert.equal(plainFringe[3], 255, 'the green fringe pixel must survive the key');
    assert.ok(plainFringe[1] >= 230, `the undespilled fringe must keep its green, got ${plainFringe[1]}`);
    assert.ok(
      despillFringe[1] < plainFringe[1] - 20,
      `despill must reduce the fringe green (${despillFringe[1]} vs ${plainFringe[1]})`,
    );

    // Provenance records the verbatim key plus the despill ordering.
    const plainProv = JSON.parse(await readFile(join(plainOut, 'provenance.json'), 'utf8')) as Record<string, any>;
    const despillProv = JSON.parse(await readFile(join(despillOut, 'provenance.json'), 'utf8')) as Record<string, any>;
    assert.equal(plainProv.extraction.kind, 'key');
    assert.equal(plainProv.extraction.color, '#00FF00', 'the caller color must be recorded verbatim');
    assert.equal(plainProv.extraction.similarity, 0.15);
    assert.equal(plainProv.extraction.blend, 0);
    assert.equal(plainProv.extraction.despill, null, 'no despill is recorded unless requested');
    assert.match(plainProv.extraction.filter, /colorkey=0x00ff00:0\.15:0/);
    assert.doesNotMatch(plainProv.extraction.filter, /despill/);
    assert.equal(despillProv.extraction.despill, 'green');
    assert.ok(
      despillProv.extraction.filter.indexOf('despill') > despillProv.extraction.filter.indexOf('colorkey'),
      'despill must be applied AFTER the key in the filter chain',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Boundaries: malformed, unsafe, oversized and degenerate requests
// ---------------------------------------------------------------------------

test('the foreground-sprite example refuses malformed, non-finite, mismatched, non-raster, degenerate and unsafe requests without partial or private output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-fg-boundary-'));
  const fixtures = join(root, 'fixtures');
  try {
    await mkdir(fixtures, { recursive: true });
    await writeFile(join(fixtures, 'input.png'), sourceInputPng());
    await writeFile(join(fixtures, 'mask.png'), maskPng());
    await writeFile(
      join(fixtures, 'maskSmall.png'),
      encodePng(10, 10, x => [x < 5 ? 255 : 0, 0, 0, 255]),
    );
    await writeFile(join(fixtures, 'allWhite.png'), solidPng([255, 255, 255]));
    await writeFile(join(fixtures, 'allBlack.png'), solidPng([0, 0, 0]));
    await writeFile(join(fixtures, 'note.txt'), 'this is not an image at all\n');
    await writeFile(
      join(fixtures, 'vector.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>',
    );
    await writeFile(
      join(fixtures, 'huge.png'),
      encodePng(4097, 2, () => [10, 20, 30, 255]),
    );
    const oversize = Buffer.alloc(17 * 1024 * 1024, 0);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(oversize, 0);
    await writeFile(join(fixtures, 'big.png'), oversize);

    const inputHash = await hashFile(join(fixtures, 'input.png'));
    const maskHash = await hashFile(join(fixtures, 'mask.png'));

    const maskConfig = (maskPath: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      input: { path: 'input.png', rights: RIGHTS },
      extraction: { kind: 'mask', mask: { path: maskPath, rights: RIGHTS }, ...extra },
      rights: RIGHTS,
    });

    const rejectsRun = async (
      name: string,
      configPath: string,
      outDir: string,
      stageRoot: string,
      matcher?: RegExp,
    ): Promise<void> => {
      const promise = runSprite(outDir, configPath);
      await (matcher ? assert.rejects(promise, matcher) : assert.rejects(promise));
      assert.equal(await exists(outDir), false, `${name}: no output directory may be created`);
      await assertNoStaging(stageRoot, name);
    };

    // (a) unknown top-level field.
    await writeJson(join(fixtures, 'a.json'), { ...maskConfig('mask.png'), unknownField: true });
    await rejectsRun('unknown field', join(fixtures, 'a.json'), join(root, 'out-a'), root, /Unrecognized key/);

    // (b) mutually exclusive mask + key fields.
    await writeJson(join(fixtures, 'b.json'), maskConfig('mask.png', { color: '#00ff00', similarity: 0.2, blend: 0 }));
    await rejectsRun('mixed mask+key', join(fixtures, 'b.json'), join(root, 'out-b'), root, /Unrecognized key/);

    // (c..e) numeric fields out of their documented bounds.
    await writeJson(join(fixtures, 'c.json'), {
      input: { path: 'input.png', rights: RIGHTS },
      extraction: { kind: 'key', color: '#00ff00', similarity: 0, blend: 0 },
      rights: RIGHTS,
    });
    await rejectsRun(
      'similarity 0',
      join(fixtures, 'c.json'),
      join(root, 'out-c'),
      root,
      /greater than or equal to 0\.01/,
    );
    await writeJson(join(fixtures, 'd.json'), {
      input: { path: 'input.png', rights: RIGHTS },
      extraction: { kind: 'key', color: '#00ff00', similarity: 1.5, blend: 0 },
      rights: RIGHTS,
    });
    await rejectsRun('similarity 1.5', join(fixtures, 'd.json'), join(root, 'out-d'), root, /less than or equal to 1/);
    await writeJson(join(fixtures, 'e.json'), {
      input: { path: 'input.png', rights: RIGHTS },
      extraction: { kind: 'key', color: '#00ff00', similarity: 0.5, blend: -0.1 },
      rights: RIGHTS,
    });
    await rejectsRun('blend -0.1', join(fixtures, 'e.json'), join(root, 'out-e'), root);

    // (f..g) non-finite JSON numbers (1e999 parses to Infinity).
    await writeFile(
      join(fixtures, 'f.json'),
      `{
      "input": { "path": "input.png", "rights": ${JSON.stringify(RIGHTS)} },
      "extraction": { "kind": "key", "color": "#00ff00", "similarity": 1e999, "blend": 0 },
      "rights": ${JSON.stringify(RIGHTS)}
    }`,
      'utf8',
    );
    await rejectsRun('Infinity similarity', join(fixtures, 'f.json'), join(root, 'out-f'), root);
    await writeFile(
      join(fixtures, 'g.json'),
      `{
      "input": { "path": "input.png", "rights": ${JSON.stringify(RIGHTS)} },
      "extraction": { "kind": "key", "color": "#00ff00", "similarity": 0.5, "blend": -1e999 },
      "rights": ${JSON.stringify(RIGHTS)}
    }`,
      'utf8',
    );
    await rejectsRun('negative Infinity blend', join(fixtures, 'g.json'), join(root, 'out-g'), root);

    // (h) mask dimensions that do not match the input (never silently scaled).
    await writeJson(join(fixtures, 'h.json'), maskConfig('maskSmall.png'));
    await rejectsRun(
      'mask dims mismatch',
      join(fixtures, 'h.json'),
      join(root, 'out-h'),
      root,
      /mask must match the input exactly/,
    );

    // (i) a non-raster input.
    await writeJson(join(fixtures, 'i.json'), {
      input: { path: 'note.txt', rights: RIGHTS },
      extraction: maskConfig('mask.png').extraction,
      rights: RIGHTS,
    });
    await rejectsRun('non-raster input', join(fixtures, 'i.json'), join(root, 'out-i'), root, /neither PNG nor JPEG/);

    // (j) SVG/vector input is refused, never rasterized.
    await writeJson(join(fixtures, 'j.json'), {
      input: { path: 'vector.svg', rights: RIGHTS },
      extraction: maskConfig('mask.png').extraction,
      rights: RIGHTS,
    });
    await rejectsRun('svg input', join(fixtures, 'j.json'), join(root, 'out-j'), root, /SVG\/vector/);

    // (k) all-opaque and all-transparent masks are not cutouts.
    await writeJson(join(fixtures, 'k.json'), maskConfig('allWhite.png'));
    await rejectsRun(
      'all-opaque mask',
      join(fixtures, 'k.json'),
      join(root, 'out-k'),
      root,
      /no fully transparent pixel/,
    );
    await writeJson(join(fixtures, 'l.json'), maskConfig('allBlack.png'));
    await rejectsRun(
      'all-transparent mask',
      join(fixtures, 'l.json'),
      join(root, 'out-l'),
      root,
      /no fully opaque pixel/,
    );

    // (m) an input beyond the 16 MiB on-disk cap.
    await writeJson(join(fixtures, 'm.json'), {
      input: { path: 'big.png', rights: RIGHTS },
      extraction: maskConfig('mask.png').extraction,
      rights: RIGHTS,
    });
    await rejectsRun('oversized bytes', join(fixtures, 'm.json'), join(root, 'out-m'), root, /16777216-byte cap/);

    // (n) an input beyond the 4096x4096 cap.
    await writeJson(join(fixtures, 'n.json'), {
      input: { path: 'huge.png', rights: RIGHTS },
      extraction: maskConfig('mask.png').extraction,
      rights: RIGHTS,
    });
    await rejectsRun('oversized dimensions', join(fixtures, 'n.json'), join(root, 'out-n'), root, /4096x4096 cap/);

    // (o) an output inside the config directory.
    await writeJson(join(fixtures, 'o.json'), maskConfig('mask.png'));
    await rejectsRun(
      'output inside config dir',
      join(fixtures, 'o.json'),
      join(fixtures, 'inside'),
      fixtures,
      /outside the project root/,
    );

    // (p) an output whose parent does not exist.
    await rejectsRun(
      'missing parent',
      join(fixtures, 'o.json'),
      join(root, 'no-such-parent', 'out'),
      root,
      /parent does not exist/,
    );

    // (q) an existing destination is never overwritten.
    const keepDir = join(root, 'out-keep');
    await writeJson(join(fixtures, 'q.json'), maskConfig('mask.png'));
    await runSprite(keepDir, join(fixtures, 'q.json'));
    const keptSpriteHash = await hashFile(join(keepDir, 'sprite.png'));
    await assert.rejects(runSprite(keepDir, join(fixtures, 'q.json')), /already exists/);
    assert.equal(await hashFile(join(keepDir, 'sprite.png')), keptSpriteHash, 'an existing output must stay untouched');
    await assertNoStaging(root, 'overwrite');

    // The inputs were never mutated by any request.
    assert.equal(await hashFile(join(fixtures, 'input.png')), inputHash);
    assert.equal(await hashFile(join(fixtures, 'mask.png')), maskHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Downstream: prepared sprite -> browser cutout -> scoped edit -> delivery
// ---------------------------------------------------------------------------

test('the prepared sprite drives a real browser cutout build, a scoped pose edit recaptures only its Source, and the delivered export packages the input, mask and provenance with rights', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-fg-downstream-'));
  const fixtures = join(root, 'fixtures');
  const prepared = join(root, 'prepared');
  const project = join(root, 'project');
  try {
    await mkdir(fixtures, { recursive: true });
    await writeFile(join(fixtures, 'input.png'), sourceInputPng());
    await writeFile(join(fixtures, 'mask.png'), maskPng());
    await writeFile(join(fixtures, 'bg.png'), solidPng([30, 60, 220]));

    // Prepare the sprite (mask path) so the downstream consumes the ACTUAL output.
    const prepareConfig = join(fixtures, 'prepare.json');
    const inputRights = {
      origin: 'caller-supplied subject raster',
      license: 'original test fixture',
      redistributable: true,
    };
    const maskRights = {
      origin: 'caller-authored grayscale mask',
      license: 'original test fixture',
      redistributable: true,
    };
    const spriteRights = { origin: 'prepared sprite output', license: 'original test fixture', redistributable: true };
    const provenanceRights = {
      origin: 'derived preparation report',
      license: 'original test fixture',
      redistributable: true,
    };
    await writeJson(prepareConfig, {
      input: { path: 'input.png', rights: inputRights },
      extraction: { kind: 'mask', mask: { path: 'mask.png', rights: maskRights } },
      rights: spriteRights,
    });
    const prepareSummary = JSON.parse(await runSprite(prepared, prepareConfig)) as Record<string, any>;
    assert.equal(prepareSummary.built, false);

    // Author the cutout with the existing example, pointing at the real sprite.
    const cutoutConfig = join(fixtures, 'cutout.json');
    await writeJson(cutoutConfig, {
      title: 'FOREGROUND SPRITE E2E',
      output: { width: 64, height: 48, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 },
      assets: [
        { id: 'bg', path: 'bg.png', rights: RIGHTS },
        { id: 'sprite', path: '../prepared/sprite.png', rights: spriteRights },
      ],
      background: 'bg',
      sprite: 'sprite',
      shots: [
        {
          frames: 4,
          from: { x: 0.4, y: 0.5, width: 0.5, rotation: 0 },
          to: { x: 0.4, y: 0.5, width: 0.5, rotation: 0 },
        },
        {
          frames: 4,
          from: { x: 0.7, y: 0.5, width: 0.5, rotation: 0 },
          to: { x: 0.7, y: 0.5, width: 0.5, rotation: 0 },
        },
      ],
    });
    await runCutout(project, cutoutConfig);

    // Retain the original input, mask and provenance as declared Project state.
    await copyFile(join(prepared, 'input.png'), join(project, 'assets', 'source-input.png'));
    await copyFile(join(prepared, 'mask.png'), join(project, 'assets', 'source-mask.png'));
    await copyFile(join(prepared, 'provenance.json'), join(project, 'assets', 'source-provenance.json'));

    const authored = await loadProject(project);
    const retained = [
      { id: 'source_input', path: 'assets/source-input.png', type: 'image' as const, rights: inputRights },
      { id: 'source_mask', path: 'assets/source-mask.png', type: 'image' as const, rights: maskRights },
      {
        id: 'source_provenance',
        path: 'assets/source-provenance.json',
        type: 'code' as const,
        rights: provenanceRights,
      },
    ];
    for (const entry of retained) {
      authored.assets.push({
        id: entry.id,
        revision: 1,
        path: entry.path,
        sha256: await hashFile(join(project, entry.path)),
        type: entry.type,
        rights: entry.rights,
        simulated: false,
      });
    }
    // Prove the JSON metadata is retained as an explicit code Source resource too
    // (nothing about JSON metadata is packaged automatically).
    const firstSource = codeSource(
      authored,
      [...authored.composition!.placements].sort((a, b) => a.startFrame - b.startFrame)[0].source!,
    );
    firstSource.resources = ['assets/source-provenance.json'];
    await saveProject(project, authored, authored.revision);

    const baseline = await loadProject(project);
    const { width, height } = baseline.composition!.output;
    const placements = [...baseline.composition!.placements].sort((a, b) => a.startFrame - b.startFrame);
    assert.equal(placements.length, 2);
    const sourceA = placements[0].source!;
    const sourceB = placements[1].source!;

    // Baseline build composites the sprite over the background for real.
    const first = await buildProject(project);
    assert.equal(first.status, 'succeeded');
    assert.equal(first.result!.simulated, false, 'genuine prepared rasters must keep the build non-simulated');
    const final1 = first.artifacts.find(artifact => artifact.id === first.result!.artifact)!;
    assert.ok(final1.media!.audio, 'the cutout movie must carry the synthesized audio');
    assert.equal(final1.media!.frames, 8, 'two 4-frame shots make an 8-frame movie');
    const raw1 = await decodeRGB24(
      join(project, final1.path),
      width,
      height,
      final1.media!.frames,
      join(root, 'raw1.rgb24'),
    );
    assert.ok(
      isGreen(framePixel(raw1, width, height, placements[0].startFrame, 16, 24)),
      'the opaque sprite region must show the sprite color',
    );
    assert.ok(
      isBlue(framePixel(raw1, width, height, placements[0].startFrame, 35, 24)),
      'a transparent sprite region must reveal the background',
    );
    assert.ok(
      isBlue(framePixel(raw1, width, height, placements[0].startFrame, 5, 24)),
      'outside the sprite must reveal the background',
    );

    // Scoped pose edit: only the second shot's own Source is retimed.
    const edited = await loadProject(project);
    const moved = codeSource(edited, sourceB);
    moved.params = {
      ...moved.params,
      from: { x: 0.6, y: 0.5, width: 0.5, rotation: 0 },
      to: { x: 0.6, y: 0.5, width: 0.5, rotation: 0 },
    };
    await saveProject(project, edited, edited.revision);

    const second = await buildProject(project);
    const codeOps = second.operations.filter(operation => operation.kind === 'browser');
    assert.equal(codeOps.length, 2, 'one code operation per shot');
    assert.equal(codeOps.filter(operation => operation.reused).length, 1, 'the untouched shot must be reused');
    assert.equal(codeOps.filter(operation => !operation.reused).length, 1, 'only the edited shot must recapture');
    const recaptured = second.takes.find(
      take => take.artifact === codeOps.find(operation => !operation.reused)!.artifact,
    )!;
    assert.equal(recaptured.source, sourceB, 'the recaptured code operation must belong to the edited shot');
    assert.notEqual(
      second.takes.find(take => take.source === sourceB)!.id,
      first.takes.find(take => take.source === sourceB)!.id,
      'the edited shot must produce a new Take',
    );
    assert.equal(
      second.operations.find(operation => operation.kind === 'mix-audio')!.reused,
      true,
      'sound must be reused',
    );
    assert.equal(
      second.takes.find(take => take.source === sourceA)!.id,
      first.takes.find(take => take.source === sourceA)!.id,
      'the untouched shot Take must stay identical',
    );

    // Rights preserved verbatim, global bindings untouched, no invented derivation.
    const saved = await loadProject(project);
    assert.deepEqual(saved.bindings, baseline.bindings, 'the global bindings must not change');
    for (const entry of retained) {
      const asset = saved.assets.find(candidate => candidate.id === entry.id)!;
      assert.deepEqual(asset.rights, entry.rights, `rights for ${entry.id} must be preserved verbatim`);
      assert.equal(asset.derivedFrom, undefined, `${entry.id} must not gain an invented frame provenance`);
    }
    for (const spec of ['bg', 'sprite'] as const) {
      const asset = saved.assets.find(candidate => candidate.id === spec)!;
      assert.equal(asset.derivedFrom, undefined, `${spec} must not gain an invented frame provenance`);
    }

    // An unchanged rebuild reuses everything.
    const fixed = await buildProject(project);
    assert.ok(
      fixed.operations.every(operation => operation.reused),
      'an unchanged rebuild must reuse every operation',
    );

    // Deliver, then prove the portable export explicitly packages the retained
    // input/mask/provenance (with rights) rather than assuming JSON rides along.
    const destination = join(root, 'bundle');
    const delivery = await deliverProject(project, destination, { review: true, stems: true });
    assert.equal(delivery.build, fixed.id);
    assert.equal(await hashFile(join(destination, 'movie', 'final.mp4')), delivery.movie!.sha256);

    const portable = JSON.parse(
      await readFile(join(destination, 'project', '.viscraft', 'portable-manifest.json'), 'utf8'),
    ) as {
      files: Array<{ path: string; provenance: { kind: string; rights?: unknown; simulated?: boolean } }>;
    };
    const packagedPaths = new Set(portable.files.map(file => file.path));
    for (const entry of retained) {
      assert.ok(packagedPaths.has(entry.path), `${entry.path} must be explicitly packaged into the portable export`);
      const record = portable.files.find(file => file.path === entry.path)!;
      assert.equal(record.provenance.kind, 'asset', `${entry.id} must ship as a declared Asset`);
      assert.deepEqual(record.provenance.rights, entry.rights, `${entry.id} must keep its rights in the manifest`);
      assert.equal(record.provenance.simulated, false);
    }
    // The provenance bytes and the delivered current project also carry them.
    assert.equal(
      await hashFile(join(destination, 'project', 'assets', 'source-provenance.json')),
      await hashFile(join(prepared, 'provenance.json')),
      'the provenance bytes must survive the round trip',
    );
    const deliveredProject = JSON.parse(await readFile(join(destination, 'project', 'project.json'), 'utf8')) as {
      assets: Array<{ id: string; path: string; rights: unknown; derivedFrom?: unknown }>;
    };
    for (const entry of retained) {
      const asset = deliveredProject.assets.find(candidate => candidate.id === entry.id)!;
      assert.ok(asset, `${entry.id} must be declared in the delivered project`);
      assert.deepEqual(asset.rights, entry.rights, `${entry.id} rights must be preserved in the delivered project`);
      assert.equal(asset.derivedFrom, undefined, `${entry.id} must not gain an invented derivedFrom`);
    }

    // Reopen the portable export as a disposable copy and rebuild it all-reuse.
    const disposable = join(root, 'disposable');
    await cp(join(destination, 'project'), disposable, { recursive: true });
    const reopened = await buildProject(disposable);
    assert.ok(
      reopened.operations.every(operation => operation.reused),
      'the exported project must rebuild with full reuse',
    );
    assert.equal(
      reopened.artifacts.find(artifact => artifact.id === reopened.result!.artifact)!.sha256,
      delivery.movie!.sha256,
      'the disposable export must reproduce the delivered movie',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
