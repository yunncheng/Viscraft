import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { muxVideo } from '../src/backends/media/mux.js';
import { probeMedia } from '../src/backends/media/probe.js';
import { FadeSchema, ProjectSchema } from '../src/core/schema.js';
import type { OutputSettings } from '../src/core/schema.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';

const OUT: OutputSettings = {
  width: 64,
  height: 48,
  fps: { numerator: 30, denominator: 1 },
  sampleRate: 48000,
  channels: 2,
};
const FRAMES = 30;

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
  return fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-fade-test-'));
}

/** A solid bright 64x48 clip at the exact output raster and clock. */
async function makeVideo(dir: string, name: string, frames: number): Promise<string> {
  const out = nodePath.join(dir, name);
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'color=c=0xffffff:size=64x48:rate=30',
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
    '30',
    '-an',
    out,
  ]);
  return out;
}

/** A constant 440 Hz sine PCM16 WAV long enough for the mux bounds. */
async function makeAudio(dir: string, name: string): Promise<string> {
  const out = nodePath.join(dir, name);
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=2',
    '-ac',
    '2',
    '-c:a',
    'pcm_s16le',
    out,
  ]);
  return out;
}

/** Minimal valid Project so the optional `composition.fade` placement is exercised. */
function projectJson(): unknown {
  return {
    schemaVersion: 1,
    id: 'fade_contract',
    revision: 1,
    title: 'Fade contract',
    direction: { intent: 'fade', looks: [{ id: 'look', description: 'look' }], transitions: [] },
    assets: [],
    bindings: {},
    sources: [],
    composition: {
      output: OUT,
      scenes: [{ id: 'scene', description: 'scene' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: 'shot', targetFrames: FRAMES }],
      placements: [
        { id: 'p', shot: 'shot', source: 'flat', inFrame: 0, outFrame: FRAMES, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio: [],
    },
  };
}

test('FadeSchema defaults and validates the whole-programme fade shape', () => {
  assert.deepEqual(FadeSchema.parse({}), { inFrames: 0, outFrames: 0 });
  assert.deepEqual(FadeSchema.parse({ inFrames: 6 }), { inFrames: 6, outFrames: 0 });
  assert.deepEqual(FadeSchema.parse({ outFrames: 9 }), { inFrames: 0, outFrames: 9 });
  assert.equal(FadeSchema.parse({ inFrames: 0, outFrames: 0 }).inFrames, 0);
  assert.throws(() => FadeSchema.parse({ inFrames: -1 }), 'a negative in-fade must be rejected');
  assert.throws(() => FadeSchema.parse({ outFrames: -1 }), 'a negative out-fade must be rejected');
  assert.throws(() => FadeSchema.parse({ inFrames: 1.5 }), 'a fractional fade must be rejected');
  assert.throws(() => FadeSchema.parse({ inFrames: 0, outFrames: 0, extra: 1 }), 'unknown keys must be rejected');
  assert.throws(() => FadeSchema.parse({ kind: 'dissolve' }), 'a dissolve is not a programme fade');
});

test('composition.fade is optional, defaults its fields and stays strict', () => {
  const base = projectJson();
  assert.equal(ProjectSchema.parse(base).composition!.fade, undefined, 'an absent fade must stay absent');
  const withFade = {
    ...(base as Record<string, unknown>),
    composition: { ...(base as { composition: Record<string, unknown> }).composition, fade: { inFrames: 4 } },
  };
  assert.deepEqual(ProjectSchema.parse(withFade).composition!.fade, { inFrames: 4, outFrames: 0 });
  const invalid = {
    ...(base as Record<string, unknown>),
    composition: {
      ...(base as { composition: Record<string, unknown> }).composition,
      fade: { inFrames: -1, outFrames: 0 },
    },
  };
  assert.throws(() => ProjectSchema.parse(invalid), 'a negative fade must be rejected at the Project level');
  const unknown = {
    ...(base as Record<string, unknown>),
    composition: {
      ...(base as { composition: Record<string, unknown> }).composition,
      fade: { inFrames: 0, outFrames: 0, curve: 'linear' },
    },
  };
  assert.throws(() => ProjectSchema.parse(unknown), 'an unknown fade key must be rejected at the Project level');
});

test('muxVideo rejects a fade longer than the programme before touching media', async () => {
  await assert.rejects(
    () =>
      muxVideo('missing-video.mp4', 'missing-audio.wav', OUT, 20, '/tmp/never-written.mp4', {
        inFrames: 12,
        outFrames: 12,
      }),
    /exceeds the 20-frame programme/,
    'inFrames + outFrames > totalFrames must be rejected with a clear message',
  );
  await assert.rejects(
    () =>
      muxVideo('missing-video.mp4', 'missing-audio.wav', OUT, 20, '/tmp/never-written.mp4', {
        inFrames: -1,
        outFrames: 0,
      }),
    'a negative fade must be rejected by the media layer too',
  );
});

test('an absent or all-zero fade leaves the mux unfiltered (byte-identical) while a real fade changes output', async () => {
  const dir = await tempDir();
  try {
    const video = await makeVideo(dir, 'video.mp4', FRAMES);
    const audio = await makeAudio(dir, 'audio.wav');
    const absent = nodePath.join(dir, 'absent.mp4');
    const zero = nodePath.join(dir, 'zero.mp4');
    const faded = nodePath.join(dir, 'faded.mp4');
    await muxVideo(video, audio, OUT, FRAMES, absent);
    await muxVideo(video, audio, OUT, FRAMES, zero, { inFrames: 0, outFrames: 0 });
    await muxVideo(video, audio, OUT, FRAMES, faded, { inFrames: 6, outFrames: 6 });
    for (const file of [absent, zero, faded]) {
      const info = await probeMedia(file);
      assert.equal(info.frames, FRAMES);
      assert.ok(info.audio, 'fade must preserve the audio stream');
    }
    assert.equal(
      await hashFile(zero),
      await hashFile(absent),
      'an all-zero fade must produce identical bytes to no fade',
    );
    assert.notEqual(await hashFile(faded), await hashFile(absent), 'a real fade must change the encoded output');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
