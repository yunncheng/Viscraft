/**
 * End-to-end cutout verification: approved original raster images are composited
 * as a real transparent sprite over a background through the normal CodeScene
 * capture path, edited per shot, and delivered.
 *
 * Three tests cover the whole capability path:
 *
 *  1. the generic authored example (`tests/fixtures/authoring/create-cutout.mjs` + `cutout.html`)
 *     authors a Project; `captureCode` is then driven directly with frozen image
 *     bindings and the emitted PNG frames prove real alpha compositing (a
 *     transparent sprite region reveals the uniform background) and real
 *     frame-to-frame motion;
 *  2. a normal two-shot Build is sounded, then one shot's registered sprite
 *     variant is applied through `bindingOverrides`: only that shot recaptures,
 *     the other Take and the mixed audio are reused, global bindings and rights
 *     are untouched, and the delivered portable export rebuilds with full reuse;
 *  3. the example refuses unsupported/malformed configs before authoring, a
 *     simulated sprite taints the genuine code Result, and a binding image that
 *     fails to decode fails the Build while preserving the previous active
 *     result (no fabricated blank frames).
 *
 * Fixtures are authored here as real RGBA PNGs (minimal zlib+CRC encoder) so the
 * sprite alpha is guaranteed present and is decoded back to verify it survived.
 */

import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { test } from 'node:test';

import { buildProject } from '../src/build/build.js';
import { captureCode, type CaptureBinding } from '../src/backends/browser/capture.js';
import { deliverProject } from '../src/operations/delivery/delivery.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { loadProject, resolveSourceBindings, saveProject } from '../src/project/project.js';
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

/** A 32x32 sprite: an opaque square in the middle, a fully transparent border. */
function spritePng(color: readonly [number, number, number]): Buffer {
  return encodePng(32, 32, (x, y) =>
    x >= 8 && x < 24 && y >= 8 && y < 24 ? [color[0], color[1], color[2], 255] : [0, 0, 0, 0],
  );
}

// ---------------------------------------------------------------------------
// Fixture / decode helpers
// ---------------------------------------------------------------------------

const RIGHTS = { origin: 'original test fixture', license: 'original test fixture', redistributable: true } as const;

interface CutoutPose {
  x: number;
  y: number;
  width: number;
  rotation: number;
}

interface CutoutAssetSpec {
  id: string;
  path: string;
  rights: { origin: string; license: string; redistributable: boolean };
  simulated?: boolean;
}

interface CutoutConfig {
  output: {
    width: number;
    height: number;
    fps: { numerator: number; denominator: number };
    sampleRate: number;
    channels: number;
  };
  assets: CutoutAssetSpec[];
  background: string;
  sprite: string;
  backgroundFit?: 'contain' | 'cover';
  backgroundColor?: string;
  pivot?: { x: number; y: number };
  shots: Array<{ frames: number; from: CutoutPose; to: CutoutPose; sprite?: string }>;
}

interface CutoutConfigOverrides {
  assets: CutoutAssetSpec[];
  background: string;
  sprite: string;
  shots: CutoutConfig['shots'];
  output?: CutoutConfig['output'];
  backgroundFit?: 'contain' | 'cover';
  backgroundColor?: string;
  pivot?: { x: number; y: number };
}

function makeConfig(overrides: CutoutConfigOverrides): CutoutConfig {
  return {
    output: overrides.output ?? {
      width: 64,
      height: 48,
      fps: { numerator: 30, denominator: 1 },
      sampleRate: 48000,
      channels: 2,
    },
    assets: overrides.assets,
    background: overrides.background,
    sprite: overrides.sprite,
    backgroundFit: overrides.backgroundFit ?? 'cover',
    ...(overrides.backgroundColor !== undefined ? { backgroundColor: overrides.backgroundColor } : {}),
    pivot: overrides.pivot ?? { x: 0.5, y: 0.5 },
    shots: overrides.shots,
  };
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

function runCutout(target: string, configPath: string): Promise<string> {
  return runCommand(process.execPath, [resolve('tests/fixtures/authoring/create-cutout.mjs'), target, configPath]);
}

async function decodeRGBA(file: string, width: number, height: number): Promise<Buffer> {
  const out = `${file}.decoded.rgba`;
  await runCommand('ffmpeg', ['-v', 'error', '-y', '-i', file, '-pix_fmt', 'rgba', '-f', 'rawvideo', out]);
  const raw = await readFile(out);
  assert.equal(raw.length, width * height * 4, `decoded ${file} must be a ${width}x${height} RGBA frame`);
  return raw;
}

async function decodeRGB24(file: string, width: number, height: number, frames: number): Promise<Buffer> {
  const out = `${file}.decoded.rgb24`;
  await runCommand('ffmpeg', ['-v', 'error', '-y', '-i', file, '-pix_fmt', 'rgb24', '-f', 'rawvideo', out]);
  const raw = await readFile(out);
  assert.equal(raw.length, width * height * 3 * frames, `decoded ${file} must hold ${frames} RGB frames`);
  return raw;
}

async function decodeF32(file: string): Promise<Buffer> {
  const out = `${file}.decoded.f32le`;
  await runCommand('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vn', '-f', 'f32le', '-acodec', 'pcm_f32le', out]);
  return readFile(out);
}

type RGB = readonly [number, number, number];

function pixel(buf: Buffer, width: number, channels: number, x: number, y: number): RGB {
  const offset = (y * width + x) * channels;
  return [buf[offset], buf[offset + 1], buf[offset + 2]];
}

/** Read a pixel from one frame of a raw multi-frame video buffer. */
function framePixel(
  buf: Buffer,
  width: number,
  height: number,
  channels: number,
  frame: number,
  x: number,
  y: number,
): RGB {
  return pixel(buf.subarray(frame * width * height * channels), width, channels, x, y);
}

const isRed: (p: RGB) => boolean = ([r, g, b]) => r >= 140 && g <= 110 && b <= 110;
const isGreen: (p: RGB) => boolean = ([r, g, b]) => g >= 140 && r <= 110 && b <= 110;
const isBlue: (p: RGB) => boolean = ([r, g, b]) => b >= 140 && r <= 110 && g <= 110;

function codeSource(project: Awaited<ReturnType<typeof loadProject>>, id: string): BrowserPictureSource {
  const source = project.sources.find(candidate => candidate.id === id);
  if (!source || source.kind !== 'browser' || source.output !== 'picture')
    throw new Error(`expected a code Source ${id}`);
  return source;
}

// ---------------------------------------------------------------------------
// 1. Real alpha compositing + motion through the direct capture path
// ---------------------------------------------------------------------------

test('cutout example composites a transparent sprite over the background and moves it frame to frame', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-cutout-capture-'));
  const fixtures = join(root, 'fixtures');
  const project = join(root, 'project');
  try {
    await mkdir(fixtures, { recursive: true });

    await writeFile(
      join(fixtures, 'bg.png'),
      encodePng(16, 16, () => [0, 200, 0, 255]),
    );
    await writeFile(join(fixtures, 'sprite.png'), spritePng([220, 30, 30]));

    // The fixture must actually carry transparency before we rely on it.
    const fixture = await decodeRGBA(join(fixtures, 'sprite.png'), 32, 32);
    assert.equal(fixture[(0 * 32 + 0) * 4 + 3], 0, 'sprite fixture corner must be fully transparent');
    assert.equal(fixture[(16 * 32 + 16) * 4 + 3], 255, 'sprite fixture centre must be opaque');

    const config = makeConfig({
      assets: [
        { id: 'bg', path: 'bg.png', rights: { ...RIGHTS } },
        { id: 'sprite', path: 'sprite.png', rights: { ...RIGHTS } },
      ],
      background: 'bg',
      sprite: 'sprite',
      shots: [
        {
          frames: 4,
          from: { x: 0.3, y: 0.5, width: 0.5, rotation: 0 },
          to: { x: 0.8, y: 0.5, width: 0.5, rotation: 0 },
        },
      ],
    });
    await writeJson(join(fixtures, 'config.json'), config);
    await runCutout(project, join(fixtures, 'config.json'));

    const loaded = await loadProject(project);
    const { width, height } = loaded.composition!.output;
    const placement = loaded.composition!.placements[0];
    const source = codeSource(loaded, placement.source!);
    const bindings = Object.fromEntries(
      resolveSourceBindings(loaded, source).map(({ binding, asset }) => [
        binding,
        { id: asset.id, path: asset.path, sha256: asset.sha256 },
      ]),
    ) as Record<string, CaptureBinding>;
    assert.deepEqual(Object.keys(bindings).sort(), ['background', 'sprite'], 'both image bindings must be frozen');

    const frames = join(root, 'frames');
    await captureCode(project, source, loaded.composition!.output, frames, bindings);

    const loadPng = async (index: number): Promise<Buffer> =>
      decodeRGBA(join(frames, `frame-${String(index).padStart(6, '0')}.png`), width, height);
    const frame0 = await loadPng(0);
    const frame3 = await loadPng(3);

    const midY = Math.round(0.5 * height);
    const x0 = Math.round(0.3 * width);
    const x3 = Math.round(0.8 * width);

    // Opaque sprite centre over the background.
    assert.ok(isRed(pixel(frame0, width, 4, x0, midY)), 'frame 0 sprite centre must be opaque red');
    assert.ok(isRed(pixel(frame3, width, 4, x3, midY)), 'frame 3 sprite centre must be opaque red');
    // A transparent part of the sprite must reveal the uniform green background,
    // not black and not the sprite colour.
    assert.ok(
      isGreen(pixel(frame0, width, 4, 6, midY - 13)),
      'frame 0 transparent sprite region must show the background',
    );
    // Real motion: the sprite leaves the frame-0 position and arrives at the frame-3 position.
    assert.ok(isGreen(pixel(frame0, width, 4, x3, midY)), 'frame 0 must not yet cover the frame-3 position');
    assert.ok(isGreen(pixel(frame3, width, 4, x0, midY)), 'frame 3 must have left the frame-0 position');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Scoped per-shot sprite variant, reuse, rights and delivery
// ---------------------------------------------------------------------------

test('a per-shot sprite variant recaptures only its shot, reuses sound and rights, and delivers a reusable export', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-cutout-scope-'));
  const fixtures = join(root, 'fixtures');
  const project = join(root, 'project');
  try {
    await mkdir(fixtures, { recursive: true });
    await writeFile(
      join(fixtures, 'bg.png'),
      encodePng(16, 16, () => [0, 200, 0, 255]),
    );
    await writeFile(join(fixtures, 'sprite.png'), spritePng([220, 30, 30]));
    await writeFile(join(fixtures, 'sprite_alt.png'), spritePng([30, 60, 220]));

    const config = makeConfig({
      assets: [
        { id: 'bg', path: 'bg.png', rights: { ...RIGHTS } },
        { id: 'sprite', path: 'sprite.png', rights: { ...RIGHTS } },
        { id: 'sprite_alt', path: 'sprite_alt.png', rights: { ...RIGHTS } },
      ],
      background: 'bg',
      sprite: 'sprite',
      shots: [
        {
          frames: 4,
          from: { x: 0.3, y: 0.5, width: 0.5, rotation: 0 },
          to: { x: 0.3, y: 0.5, width: 0.5, rotation: 0 },
        },
        {
          frames: 4,
          from: { x: 0.7, y: 0.5, width: 0.5, rotation: 0 },
          to: { x: 0.7, y: 0.5, width: 0.5, rotation: 0 },
        },
      ],
    });
    await writeJson(join(fixtures, 'config.json'), config);
    await runCutout(project, join(fixtures, 'config.json'));

    const baseline = await loadProject(project);
    assert.ok(
      baseline.assets.some(asset => asset.id === 'sprite_alt'),
      'the variant sprite must be a registered project asset',
    );
    const audioClips = baseline.composition!.audio;
    assert.ok(audioClips.length > 0, 'the example must author a soundtrack');
    for (const clip of audioClips) {
      if (clip.kind !== 'asset') assert.fail(`clip ${clip.id} must be a real PCM Asset clip, got ${clip.kind}`);
      const asset = baseline.assets.find(candidate => candidate.id === clip.asset);
      assert.ok(asset, `clip ${clip.id} points at a registered Asset`);
      assert.equal(asset.type, 'audio');
      assert.equal(await hashFile(join(project, asset.path)), asset.sha256, `${asset.path} bytes are real`);
    }

    const { width, height } = baseline.composition!.output;
    const midY = Math.round(0.5 * height);
    const placements = [...baseline.composition!.placements].sort((a, b) => a.startFrame - b.startFrame);
    assert.equal(placements.length, 2);
    const sourceA = placements[0].source!;
    const sourceB = placements[1].source!;
    const centerA = Math.round(config.shots[0].from.x * width);
    const centerB = Math.round(config.shots[1].from.x * width);

    // Baseline: both shots still use the default sprite, and the movie is sounded.
    const first = await buildProject(project);
    assert.equal(first.status, 'succeeded');
    assert.equal(first.result!.simulated, false, 'original raster fixtures keep the build non-simulated');
    const final1 = first.artifacts.find(artifact => artifact.id === first.result!.artifact)!;
    assert.ok(final1.media!.audio, 'the delivered movie must carry the generated audio track');
    assert.ok(final1.media!.frames === 8, 'the two-shot cutout is exactly 8 frames');
    const raw1 = await decodeRGB24(join(project, final1.path), width, height, final1.media!.frames);
    assert.ok(
      isRed(framePixel(raw1, width, height, 3, placements[0].startFrame, centerA, midY)),
      'baseline shot 1 must show the default red sprite',
    );
    assert.ok(
      isRed(framePixel(raw1, width, height, 3, placements[1].startFrame + 1, centerB, midY)),
      'baseline shot 2 must show the default red sprite',
    );

    const pcm = await decodeF32(join(project, final1.path));
    let energy = 0;
    const measured = Math.min(4800, Math.floor(pcm.length / 8));
    for (let sample = 0; sample < measured; sample++) energy += pcm.readFloatLE(sample * 8) ** 2;
    assert.ok(Math.sqrt(energy / measured) > 0.01, 'the mixed track must carry measured non-silent energy');

    // Scoped edit: point only shot 2 at the registered blue variant.
    const edited = await loadProject(project);
    codeSource(edited, sourceB).bindingOverrides = { sprite: 'sprite_alt' };
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

    const saved = await loadProject(project);
    assert.deepEqual(saved.bindings, baseline.bindings, 'the global bindings must not change');
    for (const spec of config.assets) {
      const asset = saved.assets.find(candidate => candidate.id === spec.id)!;
      assert.deepEqual(asset.rights, spec.rights, `rights for ${spec.id} must be preserved verbatim`);
      assert.equal(asset.derivedFrom, undefined, `${spec.id} must not gain a derived frame provenance`);
    }

    const final2 = second.artifacts.find(artifact => artifact.id === second.result!.artifact)!;
    const raw2 = await decodeRGB24(join(project, final2.path), width, height, final2.media!.frames);
    assert.ok(
      isRed(framePixel(raw2, width, height, 3, placements[0].startFrame, centerA, midY)),
      'shot 1 must keep the default red sprite',
    );
    assert.ok(
      isBlue(framePixel(raw2, width, height, 3, placements[1].startFrame + 1, centerB, midY)),
      'shot 2 must now show the blue variant',
    );

    // An unchanged rebuild reuses everything.
    const fixed = await buildProject(project);
    assert.ok(
      fixed.operations.every(operation => operation.reused),
      'an unchanged rebuild must reuse every operation',
    );

    // Deliver, then reopen the portable export as a disposable copy and rebuild it.
    const destination = join(root, 'bundle');
    const delivery = await deliverProject(project, destination, { review: true, stems: true });
    assert.equal(delivery.build, fixed.id);
    assert.equal(await hashFile(join(destination, 'movie', 'final.mp4')), delivery.movie!.sha256);

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

// ---------------------------------------------------------------------------
// 3. Authoring boundaries, simulation propagation and decode failure
// ---------------------------------------------------------------------------

test('the cutout example rejects malformed configs, taints simulated sprites and preserves the active result on decode failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-cutout-boundary-'));
  const fixtures = join(root, 'fixtures');
  try {
    await mkdir(fixtures, { recursive: true });
    await writeFile(
      join(fixtures, 'bg.png'),
      encodePng(16, 16, () => [0, 200, 0, 255]),
    );
    await writeFile(join(fixtures, 'sprite.png'), spritePng([220, 30, 30]));
    await writeFile(
      join(fixtures, 'bad.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>',
    );

    const pose = { x: 0.3, y: 0.5, width: 0.5, rotation: 0 };
    const oneShot = [{ frames: 4, from: pose, to: pose }];

    // (a) an unsupported raster format must be refused before authoring.
    const svgDir = join(root, 'svg-project');
    const svgConfig = join(fixtures, 'svg.json');
    await writeJson(
      svgConfig,
      makeConfig({
        assets: [{ id: 'art', path: 'bad.svg', rights: { ...RIGHTS } }],
        background: 'art',
        sprite: 'art',
        shots: oneShot,
      }),
    );
    await assert.rejects(runCutout(svgDir, svgConfig), 'the example must reject an unsupported SVG image');
    assert.equal(
      await exists(join(svgDir, 'project.json')),
      false,
      'no project.json may be written for an unsupported image',
    );

    // (b) malformed rights must be refused.
    const rightsDir = join(root, 'rights-project');
    const rightsConfig = join(fixtures, 'rights.json');
    await writeJson(
      rightsConfig,
      makeConfig({
        assets: [{ id: 'sprite', path: 'sprite.png', rights: { origin: 'x', license: 'y' } as never }],
        background: 'sprite',
        sprite: 'sprite',
        shots: oneShot,
      }),
    );
    await assert.rejects(runCutout(rightsDir, rightsConfig), 'the example must reject malformed rights');
    assert.equal(await exists(join(rightsDir, 'project.json')), false);

    // (c) a shot referencing an unregistered sprite variant must be refused.
    const variantDir = join(root, 'variant-project');
    const variantConfig = join(fixtures, 'variant.json');
    await writeJson(
      variantConfig,
      makeConfig({
        assets: [
          { id: 'bg', path: 'bg.png', rights: { ...RIGHTS } },
          { id: 'sprite', path: 'sprite.png', rights: { ...RIGHTS } },
        ],
        background: 'bg',
        sprite: 'sprite',
        shots: [{ frames: 4, from: pose, to: pose, sprite: 'ghost' }],
      }),
    );
    await assert.rejects(runCutout(variantDir, variantConfig), 'the example must reject an unknown sprite variant');
    assert.equal(await exists(join(variantDir, 'project.json')), false);

    // (d) an existing target directory must not be overwritten.
    const keepDir = join(root, 'keep-project');
    const keepConfig = join(fixtures, 'keep.json');
    await writeJson(
      keepConfig,
      makeConfig({
        assets: [
          { id: 'bg', path: 'bg.png', rights: { ...RIGHTS } },
          { id: 'sprite', path: 'sprite.png', rights: { ...RIGHTS } },
        ],
        background: 'bg',
        sprite: 'sprite',
        shots: oneShot,
      }),
    );
    await runCutout(keepDir, keepConfig);
    const authored = await hashFile(join(keepDir, 'project.json'));
    await assert.rejects(runCutout(keepDir, keepConfig), 'the example must refuse to overwrite existing work');
    assert.equal(await hashFile(join(keepDir, 'project.json')), authored, 'the existing project must be untouched');

    // (e) a simulated sprite taints the genuine code Result, and a decode failure
    //     keeps the previous active result instead of shipping blank frames.
    const simDir = join(root, 'sim-project');
    const simConfig = join(fixtures, 'sim.json');
    await writeJson(
      simConfig,
      makeConfig({
        assets: [
          { id: 'bg', path: 'bg.png', rights: { ...RIGHTS } },
          { id: 'sprite', path: 'sprite.png', rights: { ...RIGHTS }, simulated: true },
        ],
        background: 'bg',
        sprite: 'sprite',
        shots: oneShot,
      }),
    );
    await runCutout(simDir, simConfig);
    const record = await buildProject(simDir);
    assert.equal(record.status, 'succeeded');
    assert.equal(
      record.artifacts.find(artifact => artifact.operation === 'browser')!.simulated,
      true,
      'a simulated sprite must taint the genuine code Take',
    );
    assert.equal(record.result!.simulated, true, 'simulated asset provenance must reach the Result');

    const resultPath = join(simDir, '.viscraft', 'result.json');
    const active = await readFile(resultPath, 'utf8');
    const simulatedProject = await loadProject(simDir);
    const spriteAsset = simulatedProject.assets.find(asset => asset.id === 'sprite')!;
    await writeFile(join(simDir, spriteAsset.path), Buffer.from('this is not a decodable png'));
    const corruptedHash = await hashFile(join(simDir, spriteAsset.path));
    const onDisk = JSON.parse(await readFile(join(simDir, 'project.json'), 'utf8')) as {
      assets: Array<{ id: string; sha256: string }>;
    };
    onDisk.assets.find(asset => asset.id === 'sprite')!.sha256 = corruptedHash;
    await writeFile(join(simDir, 'project.json'), `${JSON.stringify(onDisk, null, 2)}\n`);
    await assert.rejects(buildProject(simDir), 'a binding image that cannot decode must fail the Build');
    assert.equal(
      await readFile(resultPath, 'utf8'),
      active,
      'a failed decode must preserve the previous active result',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
