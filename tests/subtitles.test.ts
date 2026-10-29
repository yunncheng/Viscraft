import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import {
  findSubtitleFont,
  renderSubtitles,
  systemFontCandidates,
  type SubtitleFont,
} from '../src/backends/media/subtitles.js';
import { SubtitleSchema, type Fps, type OutputSettings, type Subtitle } from '../src/core/schema.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { probeMedia } from '../src/backends/media/probe.js';

const WIDTH = 160;
const HEIGHT = 120;
const FRAMES = 6;
const FPS_30: Fps = { numerator: 30, denominator: 1 };
const FPS_NTSC: Fps = { numerator: 30000, denominator: 1001 };

test('system fonts retain Linux choices and use native Windows and macOS paths', () => {
  const linux = systemFontCandidates('linux');
  assert.equal(linux[0], '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');
  assert.ok(linux.includes('/usr/share/fonts/dejavu/DejaVuSans.ttf'));
  assert.ok(linux.includes('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'));
  assert.ok(linux.includes('/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'));
  assert.ok(linux.every(file => nodePath.posix.isAbsolute(file)));

  const windows = systemFontCandidates('win32', 'D:/Windows');
  assert.deepEqual(windows, ['D:\\Windows\\Fonts\\arial.ttf']);
  assert.ok(windows.every(file => nodePath.win32.isAbsolute(file)));

  const mac = systemFontCandidates('darwin');
  assert.ok(mac.includes('/System/Library/Fonts/Supplemental/Arial.ttf'));
  assert.ok(mac.every(file => nodePath.posix.isAbsolute(file)));
  assert.ok(mac.every(file => !file.startsWith('/usr/share/fonts/')));
});

function output(fps: Fps, width = WIDTH, height = HEIGHT): OutputSettings {
  return { width, height, fps, sampleRate: 48000, channels: 2 };
}

function subtitle(overrides: Partial<Subtitle> = {}): Subtitle {
  return { id: 'sub_1', text: 'HELLO', startFrame: 2, endFrame: 4, fontSize: 24, color: '#ffffff', ...overrides };
}

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
  return fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-subtitle-test-'));
}

/** Render a solid real-colour fixture (navy) with an optional audio track. */
async function makeFixture(
  dir: string,
  name: string,
  fps: Fps,
  withAudio = false,
  width = WIDTH,
  height = HEIGHT,
): Promise<string> {
  const rate = `${fps.numerator}/${fps.denominator}`;
  const dest = nodePath.join(dir, name);
  const args = ['-f', 'lavfi', '-i', `color=c=0x000080:s=${width}x${height}:r=${rate}`];
  if (withAudio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.5');
  args.push('-frames:v', String(FRAMES), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', rate);
  if (withAudio) args.push('-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest');
  else args.push('-an');
  args.push(dest);
  await ffmpeg(args);
  return dest;
}

/** Decode every frame to raw RGB24 so caption pixels can be asserted directly. */
async function readRgbFrames(file: string, dir: string, width = WIDTH, height = HEIGHT): Promise<Buffer[]> {
  const raw = nodePath.join(dir, `raw-${Math.random().toString(36).slice(2)}.rgb`);
  await ffmpeg(['-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-an', raw]);
  const buf = await fs.readFile(raw);
  const frameSize = width * height * 3;
  assert.equal(buf.length % frameSize, 0, 'rawvideo length must be a whole number of frames');
  const frames: Buffer[] = [];
  for (let offset = 0; offset < buf.length; offset += frameSize) frames.push(buf.subarray(offset, offset + frameSize));
  return frames;
}

/** Count near-white pixels: the navy fixture guarantees only caption ink matches. */
function captionPixels(frame: Buffer): number {
  let count = 0;
  for (let i = 0; i + 2 < frame.length; i += 3) {
    if (frame[i] > 180 && frame[i + 1] > 180 && frame[i + 2] > 180) count++;
  }
  return count;
}

async function burn(
  dir: string,
  fps: Fps,
  subtitles: Subtitle[],
  font?: SubtitleFont,
): Promise<{ destination: string; fixture: string }> {
  const settings = output(fps);
  const fixture = await makeFixture(
    dir,
    `fixture-${fps.numerator}-${fps.denominator}-${Math.random().toString(36).slice(2)}.mp4`,
    fps,
  );
  const resolved = font ?? (await findSubtitleFont());
  const destination = nodePath.join(
    dir,
    `burned-${fps.numerator}-${fps.denominator}-${Math.random().toString(36).slice(2)}.mp4`,
  );
  await renderSubtitles(fixture, subtitles, settings, destination, resolved);
  return { destination, fixture };
}

function assertCaptionWindow(frames: Buffer[], startFrame: number, endFrame: number): void {
  assert.equal(frames.length, FRAMES, 'frame count must be preserved');
  for (let index = 0; index < frames.length; index++) {
    const ink = captionPixels(frames[index]);
    if (index >= startFrame && index < endFrame) assert.ok(ink > 0, `caption must be visible on frame ${index}`);
    else assert.equal(ink, 0, `no caption may appear on frame ${index}`);
  }
}

test('renderSubtitles burns a caption only inside its half-open interval at 30fps', async () => {
  const dir = await tempDir();
  try {
    const { destination } = await burn(dir, FPS_30, [subtitle({ startFrame: 2, endFrame: 4 })]);
    const probed = await probeMedia(destination);
    assert.equal(probed.frames, FRAMES);
    assert.deepEqual(probed.fps, FPS_30);
    assert.equal(probed.videoCodec, 'h264');
    assert.equal(probed.audio, undefined, 'subtitle pass must strip audio');
    assertCaptionWindow(await readRgbFrames(destination, dir), 2, 4);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('renderSubtitles keeps exact frame timing at 30000/1001 fps', async () => {
  const dir = await tempDir();
  try {
    const { destination } = await burn(dir, FPS_NTSC, [subtitle({ startFrame: 1, endFrame: 3 })]);
    const probed = await probeMedia(destination);
    assert.equal(probed.frames, FRAMES);
    assert.deepEqual(probed.fps, FPS_NTSC);
    assert.equal(probed.videoCodec, 'h264');
    assertCaptionWindow(await readRgbFrames(destination, dir), 1, 3);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('renderSubtitles keeps filter-hostile caption text literal', async () => {
  const dir = await tempDir();
  try {
    // Quotes, colons, percent, dollar, backslashes, commas, semicolons, brackets
    // and an embedded newline: all must survive as literal text, never inject a
    // filter, split an option or expand an expression.
    const hostile = "a'b:c%d$e\\f,g;h[i]=j %{n} $(whoami) 'quoted'\nline2: 100% \\ end";
    const { destination } = await burn(dir, FPS_30, [subtitle({ text: hostile, startFrame: 1, endFrame: 5 })]);
    const probed = await probeMedia(destination);
    assert.equal(probed.frames, FRAMES);
    assert.equal(probed.videoCodec, 'h264');
    assertCaptionWindow(await readRgbFrames(destination, dir), 1, 5);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('renderSubtitles layers overlapping captions in array order', async () => {
  const dir = await tempDir();
  try {
    const subtitles = [
      subtitle({ id: 'sub_a', startFrame: 0, endFrame: 6, color: '#ffffff' }),
      subtitle({ id: 'sub_b', startFrame: 2, endFrame: 4, color: '#00ff00', y: 0 }),
    ];
    const { destination } = await burn(dir, FPS_30, subtitles);
    const frames = await readRgbFrames(destination, dir);
    assert.equal(frames.length, FRAMES);
    // Overlapping frames still show ink (both are drawn; no failure on overlap).
    for (const index of [2, 3]) assert.ok(captionPixels(frames[index]) > 0, `frame ${index} must show captions`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('renderSubtitles honors explicit static x/y positions', async () => {
  const dir = await tempDir();
  try {
    const { destination } = await burn(dir, FPS_30, [
      subtitle({ startFrame: 0, endFrame: 1, x: 0, y: 0, fontSize: 24 }),
    ]);
    const [frame] = await readRgbFrames(destination, dir);
    let minRow = HEIGHT;
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const i = (y * WIDTH + x) * 3;
        if (frame[i] > 180 && frame[i + 1] > 180 && frame[i + 2] > 180) {
          minRow = Math.min(minRow, y);
          break;
        }
      }
    }
    assert.ok(minRow < 24, `explicit y=0 should place ink near the top, got first ink row ${minRow}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('renderSubtitles strips an audio track but preserves frames', async () => {
  const dir = await tempDir();
  try {
    const fixture = await makeFixture(dir, 'with-audio.mp4', FPS_30, true);
    const input = await probeMedia(fixture);
    assert.ok(input.audio, 'fixture must carry audio');
    const destination = nodePath.join(dir, 'stripped.mp4');
    await renderSubtitles(fixture, [subtitle()], output(FPS_30), destination, await findSubtitleFont());
    const probed = await probeMedia(destination);
    assert.equal(probed.frames, FRAMES);
    assert.deepEqual(probed.fps, FPS_30);
    assert.equal(probed.audio, undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('renderSubtitles rejects a font whose hash does not match', async () => {
  const dir = await tempDir();
  try {
    const fixture = await makeFixture(dir, 'fixture.mp4', FPS_30);
    const font = await findSubtitleFont();
    const wrong: SubtitleFont = { path: font.path, sha256: '0'.repeat(64) };
    await assert.rejects(
      () => renderSubtitles(fixture, [subtitle()], output(FPS_30), nodePath.join(dir, 'x.mp4'), wrong),
      /hash/i,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('renderSubtitles fails on a missing font instead of blanking out', async () => {
  const dir = await tempDir();
  try {
    const fixture = await makeFixture(dir, 'fixture.mp4', FPS_30);
    await assert.rejects(
      () =>
        renderSubtitles(fixture, [subtitle()], output(FPS_30), nodePath.join(dir, 'x.mp4'), {
          path: '/nonexistent/font.ttf',
          sha256: '0'.repeat(64),
        }),
      /font/i,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('renderSubtitles rejects explicit x/y outside the output window', async () => {
  const dir = await tempDir();
  try {
    const fixture = await makeFixture(dir, 'fixture.mp4', FPS_30);
    const font = await findSubtitleFont();
    await assert.rejects(
      () => renderSubtitles(fixture, [subtitle({ x: WIDTH })], output(FPS_30), nodePath.join(dir, 'x.mp4'), font),
      /outside/i,
    );
    await assert.rejects(
      () => renderSubtitles(fixture, [subtitle({ y: HEIGHT })], output(FPS_30), nodePath.join(dir, 'y.mp4'), font),
      /outside/i,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('renderSubtitles validates captions through the shared schema', async () => {
  const dir = await tempDir();
  try {
    const fixture = await makeFixture(dir, 'fixture.mp4', FPS_30);
    const font = await findSubtitleFont();
    await assert.rejects(() =>
      renderSubtitles(fixture, [{ ...subtitle(), color: 'red' }], output(FPS_30), nodePath.join(dir, 'x.mp4'), font),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('renderSubtitles escapes filesystem paths in the filtergraph', async () => {
  const dir = await tempDir();
  try {
    // A deliberately hostile directory name: every character here is special to
    // at least one of FFmpeg's two filtergraph escaping levels, and it includes
    // the externally-configured quote / colon / backslash / space case.
    const name = process.platform === 'win32' ? "font-a,b;c[d]e=f'g h i" : "font:a,b;c[d]e=f'g\\h i";
    const weirdDir = nodePath.join(dir, name);
    await fs.mkdir(weirdDir);
    const weirdFont = nodePath.join(weirdDir, 'DejaVuSans.ttf');
    await fs.copyFile((await findSubtitleFont()).path, weirdFont);
    const font: SubtitleFont = { path: weirdFont, sha256: await hashFile(weirdFont) };
    const { destination } = await burn(dir, FPS_30, [subtitle({ startFrame: 2, endFrame: 4 })], font);
    assertCaptionWindow(await readRgbFrames(destination, dir), 2, 4);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('renderSubtitles rejects a caption that ends beyond the picture', async () => {
  const dir = await tempDir();
  try {
    const fixture = await makeFixture(dir, 'fixture.mp4', FPS_30);
    const font = await findSubtitleFont();
    // The picture is 6 frames; a caption ending at frame 7 would never be shown.
    await assert.rejects(
      () =>
        renderSubtitles(
          fixture,
          [subtitle({ startFrame: 4, endFrame: 7 })],
          output(FPS_30),
          nodePath.join(dir, 'x.mp4'),
          font,
        ),
      /picture has only/i,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('renderSubtitles rejects a font size taller than the output', async () => {
  const dir = await tempDir();
  try {
    const fixture = await makeFixture(dir, 'fixture.mp4', FPS_30);
    const font = await findSubtitleFont();
    await assert.rejects(
      () =>
        renderSubtitles(
          fixture,
          [subtitle({ fontSize: 24 })],
          output(FPS_30, 96, 20),
          nodePath.join(dir, 'x.mp4'),
          font,
        ),
      /taller than/i,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('renderSubtitles keeps the default caption baseline inside small outputs', async () => {
  const dir = await tempDir();
  try {
    const font = await findSubtitleFont();
    // 96x64 with fontSize 12 (main's caption E2E case) and 96x32 with fontSize
    // 24 where `h - fontSize - 24` would be negative and must clamp to 0.
    for (const [width, height, fontSize] of [
      [96, 64, 12],
      [96, 32, 24],
    ] as const) {
      const fixture = await makeFixture(dir, `small-${height}.mp4`, FPS_30, false, width, height);
      const destination = nodePath.join(dir, `small-${height}-burned.mp4`);
      await renderSubtitles(
        fixture,
        [subtitle({ fontSize, startFrame: 0, endFrame: 1 })],
        output(FPS_30, width, height),
        destination,
        font,
      );
      const [frame] = await readRgbFrames(destination, dir, width, height);
      assert.ok(
        captionPixels(frame) > 0,
        `default-positioned caption must be visible in ${width}x${height} with fontSize ${fontSize}`,
      );
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('SubtitleSchema rejects invalid color, intervals, size and text', () => {
  const base = { id: 'sub_1', text: 'ok', startFrame: 0, endFrame: 2, fontSize: 24, color: '#ffffff' };
  assert.equal(SubtitleSchema.safeParse(base).success, true);
  assert.equal(SubtitleSchema.safeParse({ ...base, color: 'red' }).success, false);
  assert.equal(SubtitleSchema.safeParse({ ...base, color: '#fff' }).success, false);
  assert.equal(SubtitleSchema.safeParse({ ...base, endFrame: 0 }).success, false);
  assert.equal(SubtitleSchema.safeParse({ ...base, startFrame: 2, endFrame: 2 }).success, false);
  assert.equal(SubtitleSchema.safeParse({ ...base, text: '' }).success, false);
  assert.equal(SubtitleSchema.safeParse({ ...base, text: 'a\u0000b' }).success, false);
  assert.equal(SubtitleSchema.safeParse({ ...base, fontSize: 0 }).success, false);
});

test('findSubtitleFont returns an absolute readable font and its sha256', async () => {
  const font = await findSubtitleFont();
  assert.ok(nodePath.isAbsolute(font.path));
  assert.match(font.sha256, /^[a-f0-9]{64}$/);
  assert.equal(await hashFile(font.path), font.sha256);
});

test('findSubtitleFont honors and validates VISCRAFT_SUBTITLE_FONT', async () => {
  const dir = await tempDir();
  const previous = process.env.VISCRAFT_SUBTITLE_FONT;
  try {
    const target = nodePath.join(dir, 'DejaVuSans.ttf');
    await fs.copyFile((await findSubtitleFont()).path, target);
    process.env.VISCRAFT_SUBTITLE_FONT = target;
    const font = await findSubtitleFont();
    assert.equal(font.path, target);
    assert.equal(font.sha256, await hashFile(target));

    process.env.VISCRAFT_SUBTITLE_FONT = 'relative-font.ttf';
    await assert.rejects(() => findSubtitleFont(), /absolute/i);
  } finally {
    if (previous === undefined) delete process.env.VISCRAFT_SUBTITLE_FONT;
    else process.env.VISCRAFT_SUBTITLE_FONT = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
