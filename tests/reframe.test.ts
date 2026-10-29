/**
 * Aspect-preserving framing regression tests (canonical MediaFraming).
 *
 * These verify the *real* `normalizeMedia` control plane and the strict schema
 * contract behind `Placement.framing` on a directly referenced Asset:
 *
 *  - `MediaFramingSchema` is strict: it rejects an unknown fit, a non-#RRGGBB
 *    background, out-of-range/unknown position keys, and never injects a
 *    default `framing` into a Placement that omits it;
 *  - `normalizeMedia` decode-verified pixels: `contain` letter/pillarboxes
 *    without stretching (top/bottom bars stay black, the horizontal band order
 *    is preserved), `cover` crops and the normalized `position` fraction really
 *    shifts which source region is visible (0 = left/top, 1 = right/bottom);
 *  - input DAR (including a real anamorphic sample aspect ratio) drives an
 *    even-raster scale rather than a naive 1:1 stretch;
 *  - a real shared-origin A/V offset (sound entering 0.2s after picture)
 *    survives a portrait reframe as leading silence, with rational fps and
 *    preserved duration (no independent per-stream rebase).
 *
 * The framing is a constant placement fraction, never subject tracking.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { normalizeMedia } from '../src/backends/media/picture.js';
import { probeMedia } from '../src/backends/media/probe.js';
import { MediaFramingSchema, PlacementSchema } from '../src/core/schema.js';
import type { OutputSettings } from '../src/core/schema.js';
import { runCommand } from '../src/shared/process.js';

const PORTRAIT: OutputSettings = {
  width: 60,
  height: 120,
  fps: { numerator: 25, denominator: 1 },
  sampleRate: 48000,
  channels: 2,
};

const LANDSCAPE: OutputSettings = {
  width: 120,
  height: 60,
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
  return fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-reframe-test-'));
}

/** Decode every frame of `file` to raw RGB24 and slice per-frame buffers. */
async function decodeFrames(file: string, width: number, height: number, scratchDir: string): Promise<Buffer[]> {
  const raw = nodePath.join(scratchDir, `rgb-${Math.random().toString(36).slice(2)}.raw`);
  await ffmpeg(['-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw]);
  const buf = await fs.readFile(raw);
  const perFrame = width * height * 3;
  const frames: Buffer[] = [];
  for (let offset = 0; offset + perFrame <= buf.length; offset += perFrame)
    frames.push(buf.subarray(offset, offset + perFrame));
  await fs.rm(raw, { force: true });
  return frames;
}

function pixel(frame: Buffer, width: number, x: number, y: number): [number, number, number] {
  const offset = (y * width + x) * 3;
  return [frame[offset], frame[offset + 1], frame[offset + 2]];
}

type Rgb = [number, number, number];
const isBlack = ([r, g, b]: Rgb) => r < 45 && g < 45 && b < 45;
const isRed = ([r, g, b]: Rgb) => r > 170 && g < 95 && b < 95;
const isGreen = ([r, g, b]: Rgb) => g > 140 && r < 110 && b < 110;
const isBlue = ([r, g, b]: Rgb) => b > 170 && r < 95 && g < 95;

/** A 96x54 clip of three equal vertical bands: red | green | blue. */
async function makeThreeBandClip(dir: string, name: string): Promise<string> {
  const out = nodePath.join(dir, name);
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=32x54',
    '-f',
    'lavfi',
    '-i',
    'color=c=lime:s=32x54',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=32x54',
    '-filter_complex',
    '[0:v][1:v][2:v]hstack=inputs=3,format=yuv420p[out]',
    '-map',
    '[out]',
    '-frames:v',
    '6',
    '-r',
    '25',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '18',
    out,
  ]);
  return out;
}

/** A 48x48 red clip flagged with a 2:1 sample aspect ratio (display DAR 2.0). */
async function makeAnamorphicClip(dir: string, name: string): Promise<string> {
  const out = nodePath.join(dir, name);
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=48x48:rate=25',
    '-frames:v',
    '6',
    '-vf',
    'setsar=2/1',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '18',
    out,
  ]);
  return out;
}

/** A 54x96 clip of three equal horizontal bands: red | green | blue (top→bottom). */
async function makeVerticalBandClip(dir: string, name: string): Promise<string> {
  const out = nodePath.join(dir, name);
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=54x32',
    '-f',
    'lavfi',
    '-i',
    'color=c=lime:s=54x32',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=54x32',
    '-filter_complex',
    '[0:v][1:v][2:v]vstack=inputs=3,format=yuv420p[out]',
    '-map',
    '[out]',
    '-frames:v',
    '6',
    '-r',
    '25',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '18',
    out,
  ]);
  return out;
}

async function firstNonSilentSample(
  file: string,
  sampleRate: number,
  scratchDir: string,
  channel = 0,
): Promise<number> {
  const raw = nodePath.join(scratchDir, `scan-${Math.random().toString(36).slice(2)}.f32le`);
  await ffmpeg([
    '-i',
    file,
    '-vn',
    '-f',
    'f32le',
    '-acodec',
    'pcm_f32le',
    '-ar',
    String(sampleRate),
    '-ac',
    String(channel + 1),
    raw,
  ]);
  const buf = await fs.readFile(raw);
  const channels = channel + 1;
  for (let frame = 0; frame * channels * 4 + 4 <= buf.length; frame++) {
    if (Math.abs(buf.readFloatLE(frame * channels * 4)) > 0.005) return frame;
  }
  return Math.floor(buf.length / (4 * channels));
}

test('MediaFramingSchema is strict and never injects framing into a placement', () => {
  // Valid shapes (both lowercase and uppercase hex; the full position range).
  assert.deepEqual(MediaFramingSchema.parse({}), {}, 'an empty framing has no injected defaults');
  assert.deepEqual(MediaFramingSchema.parse({ fit: 'cover', background: '#1a2B3c', position: { x: 0, y: 1 } }), {
    fit: 'cover',
    background: '#1a2B3c',
    position: { x: 0, y: 1 },
  });

  for (const invalid of [
    { fit: 'fill' },
    { fit: 'CONTAIN' },
    { fit: {} },
    { background: 'black' },
    { background: '#fff' },
    { background: '#12345g' },
    { position: { x: 1.5, y: 0.5 } },
    { position: { x: 0.5, y: -0.1 } },
    { position: { x: 0.5, y: 0.5, z: 0 } },
    { position: { x: 0.5 } },
    { fit: 'cover', extra: true },
    { tracking: 'subject' },
  ]) {
    assert.equal(MediaFramingSchema.safeParse(invalid).success, false, `must reject ${JSON.stringify(invalid)}`);
  }

  const base = { id: 'p', shot: 'shot', asset: 'asset_flat', inFrame: 0, outFrame: 8, startFrame: 0, audio: 'mute' };
  // Parsing an omitted optional field must not invent an authored framing choice.
  const bare = PlacementSchema.parse(base);
  assert.equal(bare.asset, 'asset_flat');
  assert.equal('framing' in bare, false, 'a placement without framing must not gain one');
  assert.equal(bare.framing, undefined);

  // A valid framing round-trips through the Placement schema unchanged.
  const framed = PlacementSchema.parse({
    ...base,
    framing: { fit: 'cover', background: '#000000', position: { x: 1, y: 0 } },
  });
  assert.deepEqual(framed.framing, { fit: 'cover', background: '#000000', position: { x: 1, y: 0 } });

  // The strictness still holds on the real consumer path.
  assert.equal(PlacementSchema.safeParse({ ...base, framing: { fit: 'fill' } }).success, false);
});

test('normalizeMedia contain/cover, normalized position, and anamorphic DAR change real decoded pixels', async () => {
  const dir = await tempDir();
  try {
    const src = await makeThreeBandClip(dir, 'bands.mp4');

    // --- contain: letterboxed, not stretched ------------------------------
    const contain = nodePath.join(dir, 'contain.mp4');
    await normalizeMedia(src, PORTRAIT, contain, { fit: 'contain' });
    const containInfo = await probeMedia(contain);
    assert.equal(containInfo.width, PORTRAIT.width);
    assert.equal(containInfo.height, PORTRAIT.height);
    const [cf] = await decodeFrames(contain, PORTRAIT.width, PORTRAIT.height, dir);
    // Top/bottom bars are black, so the wide source was letterboxed, not
    // stretched to fill a portrait raster.
    assert.ok(isBlack(pixel(cf, PORTRAIT.width, 30, 2)), 'contain must leave a black top bar');
    assert.ok(isBlack(pixel(cf, PORTRAIT.width, 30, 118)), 'contain must leave a black bottom bar');
    // The horizontal band order survives at the vertical centre.
    assert.ok(isRed(pixel(cf, PORTRAIT.width, 10, 60)), 'contain band order: left stays red');
    assert.ok(isGreen(pixel(cf, PORTRAIT.width, 30, 60)), 'contain band order: middle stays green');
    assert.ok(isBlue(pixel(cf, PORTRAIT.width, 50, 60)), 'contain band order: right stays blue');

    const tinted = nodePath.join(dir, 'tinted.mp4');
    await normalizeMedia(src, PORTRAIT, tinted, { fit: 'contain', background: '#204060', position: { x: 0.5, y: 0 } });
    const [tf] = await decodeFrames(tinted, PORTRAIT.width, PORTRAIT.height, dir);
    assert.ok(isGreen(pixel(tf, PORTRAIT.width, 30, 10)), 'contain y=0 places the image at the top');
    const tintedBar = pixel(tf, PORTRAIT.width, 30, 110);
    for (const [index, value] of [32, 64, 96].entries())
      assert.ok(Math.abs(tintedBar[index] - value) <= 8, 'custom pad colour must survive decoding');

    // --- cover: crops and the position fraction selects the source region --
    const decodeCover = async (name: string, position: { x: number; y: number }): Promise<Buffer> => {
      const dest = nodePath.join(dir, name);
      await normalizeMedia(src, PORTRAIT, dest, { fit: 'cover', position });
      const [frame] = await decodeFrames(dest, PORTRAIT.width, PORTRAIT.height, dir);
      return frame;
    };
    const left = await decodeCover('cover_left.mp4', { x: 0, y: 0.5 });
    const center = await decodeCover('cover_center.mp4', { x: 0.5, y: 0.5 });
    const right = await decodeCover('cover_right.mp4', { x: 1, y: 0.5 });
    assert.ok(isRed(pixel(left, PORTRAIT.width, 30, 60)), 'cover x=0 must reveal the left/red source region');
    assert.ok(
      isGreen(pixel(center, PORTRAIT.width, 30, 60)),
      'cover x=0.5 must reveal the centred/green source region',
    );
    assert.ok(isBlue(pixel(right, PORTRAIT.width, 30, 60)), 'cover x=1 must reveal the right/blue source region');
    // A cover fills the whole portrait raster: no black bars remain.
    assert.ok(!isBlack(pixel(right, PORTRAIT.width, 30, 2)), 'cover must not leave a black top bar');
    assert.ok(!isBlack(pixel(right, PORTRAIT.width, 30, 118)), 'cover must not leave a black bottom bar');

    // --- anamorphic input: DAR/SAR drives an even raster, never a 1:1 stretch
    const anamorphic = await makeAnamorphicClip(dir, 'anamorphic.mp4');
    const sarProbe = JSON.parse(
      await runCommand('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=sample_aspect_ratio',
        '-of',
        'json',
        anamorphic,
      ]),
    ) as { streams: Array<{ sample_aspect_ratio: string }> };
    assert.equal(sarProbe.streams[0].sample_aspect_ratio, '2:1', 'fixture must really carry a 2:1 sample aspect ratio');
    const anamorphicDest = nodePath.join(dir, 'anamorphic_contain.mp4');
    await normalizeMedia(anamorphic, PORTRAIT, anamorphicDest, { fit: 'contain' });
    const [af] = await decodeFrames(anamorphicDest, PORTRAIT.width, PORTRAIT.height, dir);
    // DAR 2.0 into a 60x120 portrait => a ~60x30 even-raster band, vertically centred.
    let firstRow = -1;
    let lastRow = -1;
    for (let y = 0; y < PORTRAIT.height; y++) {
      if (!isBlack(pixel(af, PORTRAIT.width, 30, y))) {
        if (firstRow < 0) firstRow = y;
        lastRow = y;
      }
    }
    const bandHeight = lastRow - firstRow + 1;
    assert.ok(bandHeight >= 28 && bandHeight <= 32, `anamorphic DAR must scale to a ~30px band, got ${bandHeight}`);
    assert.ok(
      isBlack(pixel(af, PORTRAIT.width, 30, 35)),
      'a 1:1 stretch would have filled row 35; DAR must keep it black',
    );
    assert.ok(isRed(pixel(af, PORTRAIT.width, 30, 60)), 'the centered band is the source colour');

    // --- cover vertical travel: the y fraction selects the source row region
    const vertical = await makeVerticalBandClip(dir, 'vertical.mp4');
    const decodeCoverVertical = async (name: string, y: number): Promise<Buffer> => {
      const dest = nodePath.join(dir, name);
      await normalizeMedia(vertical, LANDSCAPE, dest, { fit: 'cover', position: { x: 0.5, y } });
      const [frame] = await decodeFrames(dest, LANDSCAPE.width, LANDSCAPE.height, dir);
      return frame;
    };
    const top = await decodeCoverVertical('cover_top.mp4', 0);
    const middle = await decodeCoverVertical('cover_middle.mp4', 0.5);
    const bottom = await decodeCoverVertical('cover_bottom.mp4', 1);
    assert.ok(isRed(pixel(top, LANDSCAPE.width, 60, 30)), 'cover y=0 must reveal the top/red source region');
    assert.ok(
      isGreen(pixel(middle, LANDSCAPE.width, 60, 30)),
      'cover y=0.5 must reveal the centred/green source region',
    );
    assert.ok(isBlue(pixel(bottom, LANDSCAPE.width, 60, 30)), 'cover y=1 must reveal the bottom/blue source region');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('portrait reframe preserves a shared-origin A/V offset and rational clock', async () => {
  const dir = await tempDir();
  try {
    // Video starts at 0; audio enters 0.2s later (same origin).
    const src = nodePath.join(dir, 'delayed.mp4');
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=160x120:rate=25:duration=1',
      '-itsoffset',
      '0.2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-r',
      '25',
      '-c:a',
      'aac',
      '-ar',
      '48000',
      '-ac',
      '2',
      src,
    ]);

    const output: OutputSettings = {
      width: 60,
      height: 120,
      fps: { numerator: 30000, denominator: 1001 },
      sampleRate: 48000,
      channels: 2,
    };
    const dest = nodePath.join(dir, 'delayed_portrait.mp4');
    await normalizeMedia(src, output, dest, { fit: 'cover', position: { x: 0.5, y: 0.5 } });

    const info = await probeMedia(dest);
    assert.deepEqual(
      info.fps,
      { numerator: 30000, denominator: 1001 },
      'the reframe must keep the exact rational output clock',
    );
    assert.equal(info.width, 60);
    assert.equal(info.height, 120);
    assert.ok(info.frames >= 28 && info.frames <= 31, `~1s at 29.97fps, got ${info.frames}`);
    assert.ok(Math.abs(info.duration - 1) < 0.15, `duration ${info.duration} should stay ~1s`);
    assert.ok(info.audio, 'source audio must be preserved by the reframe');
    assert.equal(info.audio!.sampleRate, 48000);
    assert.equal(info.audio!.channels, 2);

    // mixAudio later decodes from sample 0 and ignores container offsets, so the
    // delay must live in the PCM: the audio stream starts at 0 and the first
    // real sample appears ~0.2s in.
    const probe = JSON.parse(
      await runCommand('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=start_time',
        '-of',
        'json',
        dest,
      ]),
    ) as { streams: Array<{ start_time: string }> };
    assert.equal(Number(probe.streams[0].start_time), 0);

    const first = await firstNonSilentSample(dest, 48000, dir);
    assert.ok(first > 4800, `the 0.2s lead-in must not collapse toward 0 (got ${first} samples)`);
    assert.ok(
      Math.abs(first - 9600) <= 1024,
      `leading silence ${first} samples (~${(first / 48000).toFixed(4)}s) should be ~0.2s within one AAC frame`,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
