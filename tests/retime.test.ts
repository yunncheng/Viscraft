import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { retimeClip } from '../src/backends/media/retime.js';
import { probeMedia } from '../src/backends/media/probe.js';
import { runCommand } from '../src/shared/process.js';
import { framesToSamples } from '../src/core/time.js';
import type { OutputSettings } from '../src/core/schema.js';

const OUT_25: OutputSettings = {
  width: 64,
  height: 48,
  fps: { numerator: 25, denominator: 1 },
  sampleRate: 48000,
  channels: 2,
};
const OUT_10: OutputSettings = {
  width: 64,
  height: 48,
  fps: { numerator: 10, denominator: 1 },
  sampleRate: 48000,
  channels: 2,
};

const WIDTH = 64;
const HEIGHT = 48;
// The source gradient raises the luma by this much every frame (before wrap).
const STEP = 5;

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
  return fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-retime-test-'));
}

/**
 * A frame-by-frame luma ramp (value = frame index * STEP) so retimed frame order
 * and duplication/dropping are directly observable; optional 440 Hz tone.
 */
async function makeGradientClip(
  dir: string,
  name: string,
  frames: number,
  fpsStr: string,
  fpsNumber: number,
  withAudio: boolean,
): Promise<string> {
  const out = nodePath.join(dir, name);
  const args = ['-f', 'lavfi', '-i', `color=c=black:s=${WIDTH}x${HEIGHT}:r=${fpsStr}`];
  if (withAudio) {
    args.push('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${(frames / fpsNumber).toFixed(6)}`);
  }
  args.push(
    '-frames:v',
    String(frames),
    '-vf',
    "format=gray,geq=lum='mod(N*5,256)'",
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-r',
    fpsStr,
  );
  if (withAudio) args.push('-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest');
  else args.push('-an');
  args.push(out);
  await ffmpeg(args);
  return out;
}

/** Decode every frame's centre luma value. */
async function decodeCenterLuma(file: string, scratchDir: string): Promise<number[]> {
  const raw = nodePath.join(scratchDir, `luma-${Math.random().toString(36).slice(2)}.gray`);
  await ffmpeg(['-i', file, '-f', 'rawvideo', '-pix_fmt', 'gray', raw]);
  const buf = await fs.readFile(raw);
  const perFrame = WIDTH * HEIGHT;
  const count = Math.floor(buf.length / perFrame);
  const values: number[] = [];
  for (let i = 0; i < count; i++) values.push(buf[i * perFrame + (HEIGHT / 2) * WIDTH + WIDTH / 2]);
  await fs.rm(raw, { force: true });
  return values;
}

/** Estimate the dominant frequency of a tone by hysteretic zero crossings. */
async function measureToneHz(file: string, sampleRate: number, scratchDir: string): Promise<number> {
  const raw = nodePath.join(scratchDir, `tone-${Math.random().toString(36).slice(2)}.f32le`);
  await ffmpeg(['-i', file, '-vn', '-f', 'f32le', '-acodec', 'pcm_f32le', '-ar', String(sampleRate), '-ac', '1', raw]);
  const buf = await fs.readFile(raw);
  const count = Math.floor(buf.length / 4);
  let state = 0;
  let crossings = 0;
  for (let i = 0; i < count; i++) {
    const value = buf.readFloatLE(i * 4);
    if (state <= 0 && value > 0.02) {
      state = 1;
      crossings++;
    } else if (state >= 0 && value < -0.02) {
      state = -1;
      crossings++;
    }
  }
  await fs.rm(raw, { force: true });
  const seconds = count / sampleRate;
  return crossings / 2 / seconds;
}

test('retimeClip duplicates and drops frames to an exact count from a nonzero selection', async () => {
  const dir = await tempDir();
  try {
    const source = await makeGradientClip(dir, 'grad25.mp4', 40, '25', 25, true);

    const cases = [
      { tag: 'slow2x', inFrame: 8, outFrame: 18, duration: 20 },
      { tag: 'speed2x', inFrame: 8, outFrame: 28, duration: 10 },
    ];
    for (const { tag, inFrame, outFrame, duration } of cases) {
      const interval = outFrame - inFrame;
      const destination = nodePath.join(dir, `${tag}.mp4`);
      await retimeClip(source, OUT_25, inFrame, outFrame, duration, destination);

      const info = await probeMedia(destination);
      assert.equal(info.frames, duration, `${tag}: exact output frame count`);
      assert.deepEqual(info.fps, { numerator: 25, denominator: 1 }, `${tag}: output fps`);
      assert.equal(info.videoCodec, 'h264', `${tag}: H.264 picture`);
      assert.ok(info.audio, `${tag}: source audio must be preserved`);
      assert.equal(info.audio!.sampleRate, 48000);
      assert.equal(info.audio!.channels, 2);

      const luma = await decodeCenterLuma(destination, dir);
      assert.equal(luma.length, duration, `${tag}: decoded frame count`);
      for (let k = 0; k < duration; k++) {
        // The stable half-open mapping: output frame k shows source frame
        // inFrame + floor(k * interval / duration).
        const expected = (inFrame + Math.floor((k * interval) / duration)) * STEP;
        assert.ok(
          Math.abs(luma[k] - expected) <= 4,
          `${tag}: frame ${k} luma ${luma[k]} should match source frame ${expected / STEP} (~${expected})`,
        );
        if (k > 0) assert.ok(luma[k] + 4 >= luma[k - 1], `${tag}: motion must not run backwards at frame ${k}`);
      }
      // Selection boundaries: first frame is the selection start, last stays
      // inside the take and never jumps past outFrame-1.
      assert.ok(Math.abs(luma[0] - inFrame * STEP) <= 4, `${tag}: first frame must be source ${inFrame}`);
      const lastExpected = (inFrame + Math.floor(((duration - 1) * interval) / duration)) * STEP;
      assert.ok(
        Math.abs(luma[duration - 1] - lastExpected) <= 4,
        `${tag}: last frame must be source ${lastExpected / STEP}`,
      );
      assert.ok(luma[duration - 1] <= (outFrame - 1) * STEP + 4, `${tag}: last frame must stay inside the take`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('retimeClip time-stretches source audio with pitch preserved', async () => {
  const dir = await tempDir();
  try {
    const source = await makeGradientClip(dir, 'tone10.mp4', 40, '10', 10, true);

    const cases = [
      { tag: 'slow2x', inFrame: 10, outFrame: 20, duration: 20 },
      { tag: 'speed2x', inFrame: 10, outFrame: 30, duration: 10 },
    ];
    for (const { tag, inFrame, outFrame, duration } of cases) {
      const destination = nodePath.join(dir, `audio-${tag}.mp4`);
      await retimeClip(source, OUT_10, inFrame, outFrame, duration, destination);

      const info = await probeMedia(destination);
      assert.equal(info.frames, duration, `${tag}: exact output frame count`);
      assert.deepEqual(info.fps, { numerator: 10, denominator: 1 }, `${tag}: output fps`);
      assert.ok(info.audio, `${tag}: audio stream expected`);
      const expectedSamples = framesToSamples(duration, OUT_10.fps, OUT_10.sampleRate, 'ceil');
      assert.ok(
        Math.abs(info.audio!.duration - expectedSamples / OUT_10.sampleRate) <= 1 / OUT_10.sampleRate,
        `${tag}: audio must cover exactly ${expectedSamples} samples (got ${info.audio!.duration}s)`,
      );
      // Both retimes are >= 1 second so the pitch estimate is meaningful.
      assert.ok(expectedSamples / OUT_10.sampleRate >= 1, `${tag}: measurement window must be at least one second`);

      const hz = await measureToneHz(destination, OUT_10.sampleRate, dir);
      // Pitch preserved at 440 Hz: neither halved (220) nor doubled (880).
      assert.ok(hz > 400 && hz < 480, `${tag}: 440 Hz must survive retiming, measured ${hz.toFixed(1)} Hz`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('retimeClip emits honest picture-only video and rejects invalid selections', async () => {
  const dir = await tempDir();
  try {
    const silent = await makeGradientClip(dir, 'silent25.mp4', 40, '25', 25, false);

    const destination = nodePath.join(dir, 'silent-out.mp4');
    await retimeClip(silent, OUT_25, 5, 15, 25, destination);
    const info = await probeMedia(destination);
    assert.equal(info.frames, 25, 'picture-only retime frame count');
    assert.deepEqual(info.fps, { numerator: 25, denominator: 1 });
    assert.equal(info.audio, undefined, 'a silent source must not gain a fabricated audio track');

    await assert.rejects(
      () => retimeClip(silent, OUT_25, 0, 100, 10, nodePath.join(dir, 'oob.mp4')),
      /exceeds source frame count/,
    );
    await assert.rejects(
      () => retimeClip(silent, OUT_25, 10, 10, 10, nodePath.join(dir, 'empty.mp4')),
      /greater than inFrame/,
    );
    await assert.rejects(
      () => retimeClip(silent, OUT_25, 0, 10, 10.5, nodePath.join(dir, 'frac.mp4')),
      /positive safe integer/,
    );
    await assert.rejects(
      () => retimeClip(nodePath.join(dir, 'missing.mp4'), OUT_25, 0, 10, 10, nodePath.join(dir, 'missing-out.mp4')),
      /ffprobe failed/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
