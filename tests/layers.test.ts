import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { overlayPictureLayers } from '../src/backends/media/layers.js';
import type { PictureLayerClip } from '../src/backends/media/layers.js';
import { probeMedia } from '../src/backends/media/probe.js';
import { runCommand } from '../src/shared/process.js';
import type { OutputSettings, PictureLayer } from '../src/core/schema.js';

const OUT: OutputSettings = {
  width: 64,
  height: 48,
  fps: { numerator: 25, denominator: 1 },
  sampleRate: 48000,
  channels: 2,
};

async function ffmpeg(args: string[]): Promise<void> {
  await runCommand('ffmpeg', [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-loglevel',
    'error',
    '-threads',
    '2',
    '-filter_threads',
    '1',
    ...args,
  ]);
}

async function tempDir(): Promise<string> {
  return fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-layers-'));
}

/** A solid-colour CFR clip at the output grid size and rate. */
async function makeColorClip(dir: string, name: string, color: string, frames: number): Promise<string> {
  const out = nodePath.join(dir, name);
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:size=${OUT.width}x${OUT.height}:rate=25`,
    '-frames:v',
    String(frames),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-r',
    '25',
    '-an',
    out,
  ]);
  return out;
}

function makeClip(layer: Partial<PictureLayer>, path: string, media: PictureLayerClip['media']): PictureLayerClip {
  return {
    path,
    media,
    layer: {
      id: 'layer',
      source: 'src',
      inFrame: 0,
      outFrame: 1,
      startFrame: 0,
      x: 0,
      y: 0,
      width: OUT.width,
      height: OUT.height,
      opacity: 1,
      ...layer,
    } as PictureLayer,
  };
}

/** Decode every frame to raw RGB24 and expose a per-frame pixel accessor. */
async function decodeRgb(
  file: string,
  scratch: string,
): Promise<(frame: number, x: number, y: number) => [number, number, number]> {
  const raw = nodePath.join(scratch, `rgb-${Math.random().toString(36).slice(2)}.raw`);
  await ffmpeg(['-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw]);
  const buf = await fs.readFile(raw);
  await fs.rm(raw, { force: true });
  const perFrame = OUT.width * OUT.height * 3;
  return (frame, x, y) => {
    const offset = frame * perFrame + (y * OUT.width + x) * 3;
    return [buf[offset], buf[offset + 1], buf[offset + 2]];
  };
}

const isBlack = ([r, g, b]: [number, number, number]) => r < 20 && g < 20 && b < 20;
const isRed = ([r, g, b]: [number, number, number]) => r > 200 && g < 80 && b < 80;
const isBlue = ([r, , b]: [number, number, number]) => b > 200 && r < 80;

test('maps each layer source window onto the exact base frames over a black base', async () => {
  const root = await tempDir();
  try {
    const base = await makeColorClip(root, 'base.mp4', 'black', 10);
    const red = await makeColorClip(root, 'red.mp4', 'red', 5);
    const blue = await makeColorClip(root, 'blue.mp4', 'blue', 5);
    const frames = 10;

    // Red covers output frames [2, 5); blue covers [6, 8); the rest stays black.
    const clips: PictureLayerClip[] = [
      makeClip({ id: 'red', inFrame: 1, outFrame: 4, startFrame: 2 }, red, await probeMedia(red)),
      makeClip({ id: 'blue', inFrame: 0, outFrame: 2, startFrame: 6 }, blue, await probeMedia(blue)),
    ];

    const dest = nodePath.join(root, 'out.mp4');
    await overlayPictureLayers(base, clips, OUT, frames, dest);

    const info = await probeMedia(dest);
    assert.equal(info.frames, frames);
    assert.deepEqual(info.fps, OUT.fps);

    const pixel = await decodeRgb(dest, root);
    for (const frame of [0, 1])
      assert.ok(isBlack(pixel(frame, 32, 24)), `frame ${frame} must stay black before the first layer`);
    for (const frame of [2, 3, 4]) assert.ok(isRed(pixel(frame, 32, 24)), `frame ${frame} must show the red layer`);
    assert.ok(isBlack(pixel(5, 32, 24)), 'frame 5 must be black between layers');
    for (const frame of [6, 7]) assert.ok(isBlue(pixel(frame, 32, 24)), `frame ${frame} must show the blue layer`);
    for (const frame of [8, 9])
      assert.ok(isBlack(pixel(frame, 32, 24)), `frame ${frame} must be black after the last layer`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('composites overlapping layers in array order', async () => {
  const root = await tempDir();
  try {
    const base = await makeColorClip(root, 'base.mp4', 'black', 10);
    const red = await makeColorClip(root, 'red.mp4', 'red', 4);
    const blue = await makeColorClip(root, 'blue.mp4', 'blue', 4);
    const redMedia = await probeMedia(red);
    const blueMedia = await probeMedia(blue);
    const redClip = () => makeClip({ id: 'red', inFrame: 0, outFrame: 4, startFrame: 1 }, red, redMedia);
    const blueClip = () => makeClip({ id: 'blue', inFrame: 0, outFrame: 4, startFrame: 1 }, blue, blueMedia);

    const blueOnTop = nodePath.join(root, 'blue-top.mp4');
    await overlayPictureLayers(base, [redClip(), blueClip()], OUT, 10, blueOnTop);
    const bluePixel = await decodeRgb(blueOnTop, root);
    assert.ok(isBlue(bluePixel(2, 32, 24)), 'the last array element must be drawn topmost');
    assert.ok(isBlack(bluePixel(0, 32, 24)), 'stacking must not leak before the layer start');
    assert.ok(isBlack(bluePixel(5, 32, 24)), 'stacking must not leak past the layer end');

    const redOnTop = nodePath.join(root, 'red-top.mp4');
    await overlayPictureLayers(base, [blueClip(), redClip()], OUT, 10, redOnTop);
    const redPixel = await decodeRgb(redOnTop, root);
    assert.ok(isRed(redPixel(2, 32, 24)), 'reversing the array must reverse the stacking order');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('applies opacity inside the pixel rect and rejects out-of-range trim and rect', async () => {
  const root = await tempDir();
  try {
    const base = await makeColorClip(root, 'base.mp4', 'black', 6);
    const red = await makeColorClip(root, 'red.mp4', 'red', 5);
    const redMedia = await probeMedia(red);

    // Half-opacity red panel occupying the right half, lower two thirds.
    const dest = nodePath.join(root, 'opacity.mp4');
    await overlayPictureLayers(
      base,
      [
        makeClip(
          { id: 'panel', inFrame: 0, outFrame: 5, startFrame: 0, x: 32, y: 12, width: 32, height: 24, opacity: 0.5 },
          red,
          redMedia,
        ),
      ],
      OUT,
      6,
      dest,
    );
    const pixel = await decodeRgb(dest, root);
    const [r, g, b] = pixel(0, 48, 24);
    assert.ok(r > 90 && r < 170, `half-opacity red over black should be a partial red, got ${r}`);
    assert.ok(g < 60 && b < 60, `opacity must keep green/blue low, got ${g}/${b}`);
    assert.ok(isBlack(pixel(0, 10, 24)), 'area left of the layer rect must stay black');
    assert.ok(isBlack(pixel(0, 48, 2)), 'area above the layer rect must stay black');

    await assert.rejects(
      overlayPictureLayers(
        base,
        [makeClip({ id: 'bad-trim', inFrame: 0, outFrame: 9, startFrame: 0 }, red, redMedia)],
        OUT,
        6,
        nodePath.join(root, 'bad-trim.mp4'),
      ),
      /source only has 5/,
    );
    await assert.rejects(
      overlayPictureLayers(
        base,
        [makeClip({ id: 'bad-rect', inFrame: 0, outFrame: 2, startFrame: 0, x: 40, width: 32 }, red, redMedia)],
        OUT,
        6,
        nodePath.join(root, 'bad-rect.mp4'),
      ),
      /viewport/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
