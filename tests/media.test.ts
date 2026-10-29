import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { composeVideo, normalizeMedia } from '../src/backends/media/picture.js';
import { encodeFrames } from '../src/backends/media/encoding.js';
import { mixAudio } from '../src/backends/media/audio-mix.js';
import { muxVideo } from '../src/backends/media/mux.js';
import { probeAudio, probeMedia } from '../src/backends/media/probe.js';
import type { ComposeClip } from '../src/backends/media/picture.js';
import { ProjectSchema } from '../src/core/schema.js';
import type { Composition, OutputSettings, Placement, Project } from '../src/core/schema.js';
import { runCommand } from '../src/shared/process.js';
import { framesToSamples } from '../src/core/time.js';
import { writeSignalAsset } from './audio-fixtures.js';

const OUT: OutputSettings = {
  width: 160,
  height: 120,
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
  return fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-media-test-'));
}

async function makeClip(dir: string, name: string, seconds: number, fps = 25, withAudio = false): Promise<string> {
  const out = nodePath.join(dir, name);
  const args = ['-f', 'lavfi', '-i', `testsrc=size=160x120:rate=${fps}:duration=${seconds}`];
  if (withAudio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`);
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', String(fps));
  if (withAudio) args.push('-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest');
  else args.push('-an');
  args.push(out);
  await ffmpeg(args);
  return out;
}

function makeProject(
  placements: Placement[],
  transitions: Composition['transitions'],
  audio: Composition['audio'] = [],
  assets: Project['assets'] = [],
): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'test_project',
    revision: 1,
    title: 'Test',
    direction: { intent: 'test', looks: [{ id: 'look_main', description: 'main look' }], transitions: [] },
    assets,
    bindings: {},
    sources: [],
    composition: {
      output: OUT,
      scenes: [{ id: 'scene_1', description: 'scene' }],
      shots: [{ id: 'shot_1', scene: 'scene_1', look: 'look_main', intent: 'shot', targetFrames: 25 }],
      placements,
      transitions,
      audio,
    },
  });
}

function placement(
  id: string,
  inFrame: number,
  outFrame: number,
  startFrame: number,
  audio: 'mute' | 'keep' = 'mute',
): Placement {
  return { id, shot: 'shot_1', source: 'src_1', inFrame, outFrame, startFrame, audio };
}

function makeProjectAt(
  output: OutputSettings,
  placements: Placement[],
  transitions: Composition['transitions'],
): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'test_project',
    revision: 1,
    title: 'Test',
    direction: { intent: 'test', looks: [{ id: 'look_main', description: 'main look' }], transitions: [] },
    assets: [],
    bindings: {},
    sources: [],
    composition: {
      output,
      scenes: [{ id: 'scene_1', description: 'scene' }],
      shots: [{ id: 'shot_1', scene: 'scene_1', look: 'look_main', intent: 'shot', targetFrames: 30 }],
      placements,
      transitions,
      audio: [],
    },
  });
}

/** A solid-colour 64x48 clip at an exact rational rate and frame count. */
async function makeColorClip(
  dir: string,
  name: string,
  color: string,
  frames: number,
  fpsStr: string,
): Promise<string> {
  const out = nodePath.join(dir, name);
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:size=64x48:rate=${fpsStr}`,
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
    fpsStr,
    '-an',
    out,
  ]);
  return out;
}

/** Decode every frame of a 64x48 file and return the centre RGB pixel. */
async function decodeCenterColors(file: string, scratchDir: string): Promise<Array<[number, number, number]>> {
  const raw = nodePath.join(scratchDir, `rgb-${Math.random().toString(36).slice(2)}.raw`);
  await ffmpeg(['-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw]);
  const buf = await fs.readFile(raw);
  const perFrame = 64 * 48 * 3;
  const count = Math.floor(buf.length / perFrame);
  const colors: Array<[number, number, number]> = [];
  for (let i = 0; i < count; i++) {
    const offset = i * perFrame + (24 * 64 + 32) * 3;
    colors.push([buf[offset], buf[offset + 1], buf[offset + 2]]);
  }
  await fs.rm(raw, { force: true });
  return colors;
}

const isRed = ([r, g, b]: [number, number, number]) => r > 200 && g < 80 && b < 80;
const isBlue = ([r, , b]: [number, number, number]) => b > 200 && r < 80;
const isGreen = ([r, g]: [number, number, number]) => g > 80 && r < 80;

function readWav16(file: Buffer): { sampleRate: number; channels: number; samples: Int16Array } {
  assert.equal(file.toString('ascii', 0, 4), 'RIFF');
  assert.equal(file.toString('ascii', 8, 12), 'WAVE');
  const sampleRate = file.readUInt32LE(24);
  const channels = file.readUInt16LE(22);
  const dataOffset = 44;
  const count = (file.length - dataOffset) / 2;
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i++) samples[i] = file.readInt16LE(dataOffset + i * 2);
  return { sampleRate, channels, samples };
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

test('probeMedia counts frames and reports rational fps plus audio', async () => {
  const dir = await tempDir();
  try {
    const src = await makeClip(dir, 'src.mp4', 1, 25, true);
    const info = await probeMedia(src);
    assert.equal(info.frames, 25);
    assert.deepEqual(info.fps, { numerator: 25, denominator: 1 });
    assert.equal(info.width, 160);
    assert.equal(info.height, 120);
    assert.ok(Math.abs(info.duration - 1) < 0.15, `duration ${info.duration}`);
    assert.ok(info.audio, 'audio stream expected');
    assert.equal(info.audio!.sampleRate, 48000);
    assert.equal(info.audio!.channels, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('probeMedia reports the real audio duration, never the video duration', async () => {
  const dir = await tempDir();
  try {
    // Short 60fps clip: AAC frame padding is large relative to the clip length.
    const clip = nodePath.join(dir, 'short60.mp4');
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=160x120:rate=60:duration=0.1',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-shortest',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-r',
      '60',
      '-c:a',
      'aac',
      '-ar',
      '48000',
      '-ac',
      '2',
      clip,
    ]);
    const info = await probeMedia(clip);
    assert.ok(info.audio);
    assert.equal(info.frames, 6);
    const ref = JSON.parse(
      await runCommand('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=duration',
        '-of',
        'json',
        clip,
      ]),
    );
    const expected = Number(ref.streams[0].duration);
    assert.ok(
      Math.abs(info.audio!.duration - expected) < 1e-6,
      `audio duration ${info.audio!.duration} != stream ${expected}`,
    );
    assert.notEqual(info.audio!.duration, info.duration, 'audio duration must not be the video duration');
    const oneFrame = info.fps.denominator / info.fps.numerator;
    assert.ok(
      Math.abs(info.audio!.duration - info.duration) <= oneFrame,
      `A/V gap ${Math.abs(info.audio!.duration - info.duration)} exceeds one 60fps frame (${oneFrame})`,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('probeMedia measures audio duration by decoding when the container omits it', async () => {
  const dir = await tempDir();
  try {
    // Matroska exposes neither duration nor duration_ts for the audio stream.
    const clip = nodePath.join(dir, 'short60.mkv');
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=160x120:rate=60:duration=0.1',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-shortest',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-r',
      '60',
      '-c:a',
      'aac',
      '-ar',
      '48000',
      '-ac',
      '2',
      clip,
    ]);
    const info = await probeMedia(clip);
    assert.ok(info.audio);

    const raw = nodePath.join(dir, 'ref.f32le');
    await ffmpeg(['-i', clip, '-vn', '-f', 'f32le', '-acodec', 'pcm_f32le', '-ar', '48000', '-ac', '2', raw]);
    const buf = await fs.readFile(raw);
    const expected = buf.length / 8 / 48000;
    assert.ok(
      Math.abs(info.audio!.duration - expected) < 1e-6,
      `decoded audio ${info.audio!.duration} != samples ${expected}`,
    );
    assert.notEqual(info.audio!.duration, info.duration, 'audio duration must not be the video duration');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('probeAudio reports audio-only facts and never requires a video stream', async () => {
  const dir = await tempDir();
  try {
    // Audio-only WAV: 0.5 s, 48 kHz, stereo -> exactly 24000 sample frames.
    const wav = nodePath.join(dir, 'tone.wav');
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=0.5',
      '-c:a',
      'pcm_s16le',
      '-ar',
      '48000',
      '-ac',
      '2',
      wav,
    ]);
    const info = await probeAudio(wav);
    assert.deepEqual(info, { sampleRate: 48000, channels: 2, duration: 0.5, samples: 24000 });
    // `probeMedia` still requires a video stream: that is exactly why an audio
    // artifact (a code-authored sound Take) needs its own probe.
    await assert.rejects(() => probeMedia(wav), /no video stream/);

    // A video-only file has no audio stream and must be a loud probeAudio error.
    const videoOnly = await makeClip(dir, 'video-only.mp4', 1, 25, false);
    await assert.rejects(() => probeAudio(videoOnly), /no audio stream/);

    // An A/V file reports real audio facts, not the video/container clock.
    const av = await makeClip(dir, 'av.mp4', 1, 25, true);
    const avInfo = await probeAudio(av);
    assert.equal(avInfo.sampleRate, 48000);
    assert.equal(avInfo.channels, 2);
    assert.ok(avInfo.samples > 0 && Number.isSafeInteger(avInfo.samples));
    assert.ok(Math.abs(avInfo.duration - avInfo.samples / avInfo.sampleRate) <= 1 / avInfo.sampleRate);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('encodeFrames encodes an exact frame count from frame-%06d.png', async () => {
  const dir = await tempDir();
  try {
    const framesDir = nodePath.join(dir, 'frames');
    await fs.mkdir(framesDir);
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=160x120:rate=25:duration=1',
      '-frames:v',
      '12',
      '-start_number',
      '0',
      nodePath.join(framesDir, 'frame-%06d.png'),
    ]);
    const dest = nodePath.join(dir, 'encoded.mp4');
    await encodeFrames(framesDir, OUT, 12, dest);
    const info = await probeMedia(dest);
    assert.equal(info.frames, 12);
    assert.deepEqual(info.fps, { numerator: 25, denominator: 1 });
    assert.equal(info.audio, undefined, 'encoded video has no audio stream');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('normalizeMedia resamples to CFR without changing duration', async () => {
  const dir = await tempDir();
  try {
    const src = await makeClip(dir, 'src24.mp4', 1, 24);
    const dest = nodePath.join(dir, 'norm.mp4');
    await normalizeMedia(src, OUT, dest);
    const info = await probeMedia(dest);
    assert.deepEqual(info.fps, { numerator: 25, denominator: 1 });
    assert.ok(Math.abs(info.duration - 1) < 0.15, `duration ${info.duration} should stay ~1s`);
    assert.ok(info.frames >= 24 && info.frames <= 26, `frames ${info.frames} should be ~25`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('normalizeMedia preserves and re-encodes source audio', async () => {
  const dir = await tempDir();
  try {
    const src = await makeClip(dir, 'src24a.mp4', 1, 24, true);
    const dest = nodePath.join(dir, 'norm_audio.mp4');
    await normalizeMedia(src, OUT, dest);
    const info = await probeMedia(dest);
    assert.deepEqual(info.fps, { numerator: 25, denominator: 1 });
    assert.ok(info.audio, 'source audio must be preserved');
    assert.equal(info.audio!.sampleRate, 48000);
    assert.equal(info.audio!.channels, 2);
    assert.ok(Math.abs(info.duration - 1) < 0.15, `duration ${info.duration}`);
    assert.ok(Math.abs(info.audio!.duration - 1) < 0.25, `audio duration ${info.audio!.duration}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('normalizeMedia preserves a real A/V offset as leading silence (shared origin)', async () => {
  const dir = await tempDir();
  try {
    // Video starts at 0; audio enters 0.2s later.
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
    const dest = nodePath.join(dir, 'norm_delayed.mp4');
    await normalizeMedia(src, OUT, dest);

    // Audio must be materialized as samples starting at stream time 0,
    // because mixAudio decodes from sample 0 and ignores container offsets.
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
    );
    assert.equal(Number(probe.streams[0].start_time), 0);

    const first = await firstNonSilentSample(dest, 48000, dir);
    // ~0.2s at 48k = 9600 samples; AAC frame quantum is 1024 samples.
    assert.ok(first > 4800, `audio delay must not collapse toward 0 (got ${first} samples)`);
    assert.ok(
      Math.abs(first - 9600) <= 1024,
      `leading silence ${first} samples (~${(first / 48000).toFixed(4)}s) should be ~0.2s within one AAC frame`,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('mixAudio throws instead of silently clipping an overloaded mix', async () => {
  const dir = await tempDir();
  try {
    const asset = await writeSignalAsset(dir, {
      id: 'overload_signal',
      path: 'assets/overload.wav',
      sampleRate: 48000,
      channels: 2,
      samples: 4800,
    });
    const audio: Composition['audio'] = [
      {
        id: 'signal_a',
        kind: 'asset',
        asset: asset.id,
        inSample: 0,
        startSample: 0,
        durationSamples: 4800,
        gain: 1,
        fadeInSamples: 0,
        fadeOutSamples: 0,
      },
      {
        id: 'signal_b',
        kind: 'asset',
        asset: asset.id,
        inSample: 0,
        startSample: 0,
        durationSamples: 4800,
        gain: 1,
        fadeInSamples: 0,
        fadeOutSamples: 0,
      },
    ];
    const project = makeProject([placement('place_a', 0, 25, 0)], [], audio, [asset]);
    await assert.rejects(() => mixAudio(dir, project, [], 25, nodePath.join(dir, 'over.wav')), /overload/i);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('probeMedia propagates ffprobe failures instead of reporting silence', async () => {
  const dir = await tempDir();
  try {
    await assert.rejects(() => probeMedia(nodePath.join(dir, 'missing.mp4')));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('composeVideo tiles placements and honors an explicit dissolve without re-subtracting', async () => {
  const dir = await tempDir();
  try {
    const clipA = await makeClip(dir, 'a.mp4', 1, 25);
    const clipB = await makeClip(dir, 'b.mp4', 1, 25);
    const infoA = await probeMedia(clipA);
    const infoB = await probeMedia(clipB);
    // p1 occupies [0,25); p2 occupies [20,45) -> overlap [20,25) covered by a dissolve.
    const p1 = placement('place_a', 0, 25, 0);
    const p2 = placement('place_b', 0, 25, 20);
    const transitions: Composition['transitions'] = [
      { from: 'place_a', to: 'place_b', kind: 'dissolve', startFrame: 20, endFrame: 25 },
    ];
    const project = makeProject([p1, p2], transitions);
    const clips: ComposeClip[] = [
      { placement: p1, path: clipA, media: infoA },
      { placement: p2, path: clipB, media: infoB },
    ];
    const dest = nodePath.join(dir, 'composed.mp4');
    await composeVideo(project, clips, dest);
    const info = await probeMedia(dest);
    assert.equal(info.frames, 45);
    assert.deepEqual(info.fps, { numerator: 25, denominator: 1 });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('composeVideo rejects gaps, unauthorized overlaps and out-of-range trims', async () => {
  const dir = await tempDir();
  try {
    const clipA = await makeClip(dir, 'a.mp4', 1, 25);
    const infoA = await probeMedia(clipA);

    // Gap: p2 starts at 30 while p1 ends at 25.
    {
      const p1 = placement('place_a', 0, 25, 0);
      const p2 = placement('place_b', 0, 25, 30);
      const project = makeProject([p1, p2], []);
      const clips: ComposeClip[] = [
        { placement: p1, path: clipA, media: infoA },
        { placement: p2, path: clipA, media: infoA },
      ];
      await assert.rejects(() => composeVideo(project, clips, nodePath.join(dir, 'gap.mp4')), /gap/i);
    }

    // Unauthorized overlap: p2 starts at 20 with no transition.
    {
      const p1 = placement('place_a', 0, 25, 0);
      const p2 = placement('place_b', 0, 25, 20);
      const project = makeProject([p1, p2], []);
      const clips: ComposeClip[] = [
        { placement: p1, path: clipA, media: infoA },
        { placement: p2, path: clipA, media: infoA },
      ];
      await assert.rejects(() => composeVideo(project, clips, nodePath.join(dir, 'overlap.mp4')), /overlap/i);
    }

    // Out-of-range trim: source only has 25 frames.
    {
      const p1 = placement('place_a', 0, 30, 0);
      const project = makeProject([p1], []);
      const clips: ComposeClip[] = [{ placement: p1, path: clipA, media: infoA }];
      await assert.rejects(() => composeVideo(project, clips, nodePath.join(dir, 'oob.mp4')), /only has 25/);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('composeVideo composes 3-clip timelines in both concat/xfade orders at rational rates', async () => {
  const dir = await tempDir();
  try {
    for (const { fpsStr, fps } of [
      { fpsStr: '30000/1001', fps: { numerator: 30000, denominator: 1001 } },
      { fpsStr: '24000/1001', fps: { numerator: 24000, denominator: 1001 } },
    ]) {
      const tag = fps.numerator;
      const red = await makeColorClip(dir, `red-${tag}.mp4`, 'red', 30, fpsStr);
      const blue = await makeColorClip(dir, `blue-${tag}.mp4`, 'blue', 30, fpsStr);
      const green = await makeColorClip(dir, `green-${tag}.mp4`, 'green', 30, fpsStr);
      const infoR = await probeMedia(red);
      const infoB = await probeMedia(blue);
      const infoG = await probeMedia(green);
      const output: OutputSettings = { width: 64, height: 48, fps, sampleRate: 48000, channels: 2 };

      // Order 1: xfade then concat. [0,30) dissolve [24,30) [24,54) hard cut [54,84).
      {
        const p1 = placement('place_a', 0, 30, 0);
        const p2 = placement('place_b', 0, 30, 24);
        const p3 = placement('place_c', 0, 30, 54);
        const project = makeProjectAt(
          output,
          [p1, p2, p3],
          [{ from: 'place_a', to: 'place_b', kind: 'dissolve', startFrame: 24, endFrame: 30 }],
        );
        const clips: ComposeClip[] = [
          { placement: p1, path: red, media: infoR },
          { placement: p2, path: blue, media: infoB },
          { placement: p3, path: green, media: infoG },
        ];
        const dest = nodePath.join(dir, `xfade-concat-${tag}.mp4`);
        await composeVideo(project, clips, dest);
        const info = await probeMedia(dest);
        assert.equal(info.frames, 84);
        assert.deepEqual(info.fps, fps);
        const colors = await decodeCenterColors(dest, dir);
        assert.equal(colors.length, 84);
        assert.ok(isRed(colors[0]) && isRed(colors[23]), `xfade-concat ${fpsStr}: frames 0..23 must be red`);
        assert.ok(isBlue(colors[30]) && isBlue(colors[53]), `xfade-concat ${fpsStr}: frames 30..53 must be blue`);
        assert.ok(isGreen(colors[54]) && isGreen(colors[83]), `xfade-concat ${fpsStr}: frames 54..83 must be green`);
      }

      // Order 2: hard cut then dissolve. [0,30) hard cut [30,60) dissolve [54,60) [54,84).
      // The concatenated segment and xfade must share the composition timebase.
      {
        const p1 = placement('place_a', 0, 30, 0);
        const p2 = placement('place_b', 0, 30, 30);
        const p3 = placement('place_c', 0, 30, 54);
        const project = makeProjectAt(
          output,
          [p1, p2, p3],
          [{ from: 'place_b', to: 'place_c', kind: 'dissolve', startFrame: 54, endFrame: 60 }],
        );
        const clips: ComposeClip[] = [
          { placement: p1, path: red, media: infoR },
          { placement: p2, path: blue, media: infoB },
          { placement: p3, path: green, media: infoG },
        ];
        const dest = nodePath.join(dir, `concat-xfade-${tag}.mp4`);
        await composeVideo(project, clips, dest);
        const info = await probeMedia(dest);
        assert.equal(info.frames, 84);
        assert.deepEqual(info.fps, fps);
        const colors = await decodeCenterColors(dest, dir);
        assert.equal(colors.length, 84);
        assert.ok(
          isRed(colors[0]) && isRed(colors[29]),
          `concat-xfade ${fpsStr}: frames 0..29 must be red (hard cut at 30)`,
        );
        assert.ok(isBlue(colors[30]) && isBlue(colors[53]), `concat-xfade ${fpsStr}: frames 30..53 must be blue`);
        assert.ok(isGreen(colors[60]) && isGreen(colors[83]), `concat-xfade ${fpsStr}: frames 60..83 must be green`);
        // Dissolve [54,60) fades blue into green across exactly those frames.
        assert.ok(
          colors[54][2] > colors[59][2] && colors[59][1] > colors[54][1],
          `concat-xfade ${fpsStr}: dissolve must blend blue->green (${colors[54]} -> ${colors[59]})`,
        );
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('composeVideo rejects unused, dangling, duplicate and non-adjacent transitions', async () => {
  const dir = await tempDir();
  try {
    const clip = await makeColorClip(dir, 'red60.mp4', 'red', 60, '25');
    const info = await probeMedia(clip);
    const p1 = placement('place_a', 0, 30, 0);
    const p2 = placement('place_b', 0, 30, 30);
    const p3 = placement('place_c', 0, 30, 60);
    const p2overlap = placement('place_b', 0, 30, 24);
    const clips12: ComposeClip[] = [
      { placement: p1, path: clip, media: info },
      { placement: p2, path: clip, media: info },
    ];

    // Zero-overlap (stale) dissolve: p1 and p2 tile exactly, so the declared
    // range can never be consumed by an overlap.
    {
      const project = makeProjectAt(
        OUT,
        [p1, p2],
        [{ from: 'place_a', to: 'place_b', kind: 'dissolve', startFrame: 30, endFrame: 36 }],
      );
      await assert.rejects(() => composeVideo(project, clips12, nodePath.join(dir, 'zero.mp4')), /not consumed/i);
    }

    // Dangling reference to unknown placement ids.
    {
      const project = makeProjectAt(
        OUT,
        [p1, p2],
        [{ from: 'ghost_x', to: 'ghost_y', kind: 'dissolve', startFrame: 30, endFrame: 36 }],
      );
      await assert.rejects(
        () => composeVideo(project, clips12, nodePath.join(dir, 'dangling.mp4')),
        /unknown placement/i,
      );
    }

    // Duplicate declarations for one directed pair.
    {
      const project = makeProjectAt(
        OUT,
        [p1, p2overlap],
        [
          { from: 'place_a', to: 'place_b', kind: 'dissolve', startFrame: 24, endFrame: 30 },
          { from: 'place_a', to: 'place_b', kind: 'dissolve', startFrame: 24, endFrame: 30 },
        ],
      );
      const clips: ComposeClip[] = [
        { placement: p1, path: clip, media: info },
        { placement: p2overlap, path: clip, media: info },
      ];
      await assert.rejects(
        () => composeVideo(project, clips, nodePath.join(dir, 'duplicate.mp4')),
        /duplicate transition/i,
      );
    }

    // Non-adjacent placements (a -> c while b sits between them).
    {
      const project = makeProjectAt(
        OUT,
        [p1, p2, p3],
        [{ from: 'place_a', to: 'place_c', kind: 'dissolve', startFrame: 30, endFrame: 36 }],
      );
      const clips: ComposeClip[] = [
        { placement: p1, path: clip, media: info },
        { placement: p2, path: clip, media: info },
        { placement: p3, path: clip, media: info },
      ];
      await assert.rejects(() => composeVideo(project, clips, nodePath.join(dir, 'nonadjacent.mp4')), /adjacent/i);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('mixAudio places an audio asset at the exact sample offset with fades', async () => {
  const dir = await tempDir();
  try {
    const asset = await writeSignalAsset(dir, {
      id: 'offset_signal',
      path: 'assets/offset.wav',
      sampleRate: 48000,
      channels: 2,
      samples: 9600,
    });
    const audio: Composition['audio'] = [
      {
        id: 'signal_1',
        kind: 'asset',
        asset: asset.id,
        inSample: 0,
        startSample: 4800,
        durationSamples: 9600,
        gain: 0.5,
        fadeInSamples: 480,
        fadeOutSamples: 480,
      },
    ];
    const project = makeProject([placement('place_a', 0, 25, 0)], [], audio, [asset]);
    const dest = nodePath.join(dir, 'mix.wav');
    await mixAudio(dir, project, [], 25, dest);

    const wav = readWav16(await fs.readFile(dest));
    assert.equal(wav.sampleRate, 48000);
    assert.equal(wav.channels, 2);
    // 25 frames @25fps = 1s = 48000 samples, stereo => 96000 int16 values.
    assert.equal(wav.samples.length, 48000 * 2);

    const frame = (s: number, c = 0) => wav.samples[s * 2 + c];
    for (let s = 0; s < 4800; s++) {
      assert.equal(frame(s), 0, `sample ${s} should be silent`);
      assert.equal(frame(s, 1), 0);
    }
    assert.equal(frame(4800), 0, 'first fade-in sample must be zero');
    let peak = 0;
    for (let s = 5000; s < 14000; s++) peak = Math.max(peak, Math.abs(frame(s)));
    assert.ok(peak > 0, 'the authored signal body should be non-silent');
    for (let s = 14400; s < 48000; s++) {
      assert.equal(frame(s), 0, `sample ${s} after the clip should be silent`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('mixAudio applies sample-exact authored ducking automation to an audio asset clip', async () => {
  const dir = await tempDir();
  try {
    const asset = await writeSignalAsset(dir, {
      id: 'bed_asset',
      path: 'assets/bed.wav',
      sampleRate: 48000,
      channels: 2,
      samples: 48000,
    });
    const base: Composition['audio'][number] = {
      id: 'bed',
      kind: 'asset',
      asset: asset.id,
      inSample: 0,
      startSample: 0,
      durationSamples: 48000,
      gain: 0.3,
      fadeInSamples: 0,
      fadeOutSamples: 0,
    };
    const project = makeProject([placement('place_a', 0, 25, 0)], [], [base], [asset]);
    const reference = nodePath.join(dir, 'reference.wav');
    await mixAudio(dir, project, [], 25, reference);
    const original = readWav16(await fs.readFile(reference));
    const automation = [
      { sample: 0, gain: 1 },
      { sample: 10000, gain: 1 },
      { sample: 12000, gain: 0.2 },
      { sample: 24000, gain: 0.2 },
      { sample: 26000, gain: 1 },
      { sample: 47999, gain: 1 },
    ];
    project.composition!.audio[0].automation = automation;
    const destination = nodePath.join(dir, 'automated.wav');
    await mixAudio(dir, project, [], 25, destination);
    const result = readWav16(await fs.readFile(destination));
    for (const [sample, gain] of [
      [6001, 1],
      [11001, 0.5996],
      [16001, 0.2],
      [25001, 0.6004],
      [30001, 1],
    ]) {
      assert.ok(
        Math.abs(result.samples[sample * 2] - original.samples[sample * 2] * gain) <= 2,
        `wrong gain at sample ${sample}`,
      );
    }
    project.composition!.audio[0].automation = [
      { sample: 10, gain: 1 },
      { sample: 10, gain: 0.2 },
    ];
    await assert.rejects(
      mixAudio(dir, project, [], 25, nodePath.join(dir, 'invalid.wav')),
      /invalid local gain automation/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('mixAudio keeps source audio at a timeline frame (audio crosses cuts)', async () => {
  const dir = await tempDir();
  try {
    const clip = await makeClip(dir, 'with_audio.mp4', 1, 25, true);
    const project = makeProject([placement('place_a', 0, 25, 0, 'keep')], []);
    const dest = nodePath.join(dir, 'kept.wav');
    await mixAudio(dir, project, [{ path: clip, startFrame: 10 }], 25, dest);

    const wav = readWav16(await fs.readFile(dest));
    assert.equal(wav.samples.length, 48000 * 2);
    // startFrame 10 @25fps = 0.4s = 19200 samples of leading silence.
    for (let s = 0; s < 19200; s++) assert.equal(wav.samples[s * 2], 0, `sample ${s} should be silent`);
    let peak = 0;
    for (let s = 19200; s < 48000; s++) peak = Math.max(peak, Math.abs(wav.samples[s * 2]));
    assert.ok(peak > 0, 'kept audio should be present after its start frame');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('mixAudio skips a kept source that has no audio stream', async () => {
  const dir = await tempDir();
  try {
    const clip = await makeClip(dir, 'silent.mp4', 1, 25, false);
    const project = makeProject([placement('place_a', 0, 25, 0, 'keep')], []);
    const dest = nodePath.join(dir, 'silent_mix.wav');
    await mixAudio(dir, project, [{ path: clip, startFrame: 0 }], 25, dest);
    const wav = readWav16(await fs.readFile(dest));
    for (let s = 0; s < wav.samples.length; s++) assert.equal(wav.samples[s], 0, `sample ${s} should be silent`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('mixAudio throws when a kept source is unreadable', async () => {
  const dir = await tempDir();
  try {
    const project = makeProject([placement('place_a', 0, 25, 0, 'keep')], []);
    await assert.rejects(() =>
      mixAudio(
        dir,
        project,
        [{ path: nodePath.join(dir, 'nope.mp4'), startFrame: 0 }],
        25,
        nodePath.join(dir, 'x.wav'),
      ),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('muxVideo retains the final AAC content on short high-FPS and rational-FPS timelines', async () => {
  const dir = await tempDir();
  try {
    const cases = [
      { fps: { numerator: 120, denominator: 1 }, sampleRate: 44100 as const, frames: 1 },
      { fps: { numerator: 120, denominator: 1 }, sampleRate: 44100 as const, frames: 5 },
      { fps: { numerator: 30000, denominator: 1001 }, sampleRate: 44100 as const, frames: 2 },
      { fps: { numerator: 30000, denominator: 1001 }, sampleRate: 48000 as const, frames: 2 },
      { fps: { numerator: 120, denominator: 1 }, sampleRate: 48000 as const, frames: 1 },
      { fps: { numerator: 24000, denominator: 1001 }, sampleRate: 44100 as const, frames: 2 },
    ];
    for (const [index, { fps, sampleRate, frames }] of cases.entries()) {
      const output: OutputSettings = { width: 64, height: 48, fps, sampleRate, channels: index === 5 ? 1 : 2 };
      const samples = framesToSamples(frames, fps, sampleRate, 'ceil');
      const project = makeProjectAt(output, [placement('place_a', 0, frames, 0)], []);
      const signal = await writeSignalAsset(dir, {
        id: `signal_${index}`,
        path: `signal-${index}.wav`,
        sampleRate,
        channels: output.channels,
        samples,
      });
      project.assets = [signal];
      project.composition!.audio = [
        {
          id: 'tail',
          kind: 'asset',
          asset: signal.id,
          inSample: 0,
          startSample: 0,
          durationSamples: samples,
          gain: 0.3,
          fadeInSamples: 0,
          fadeOutSamples: 0,
        },
      ];
      const video = await makeColorClip(
        dir,
        `video-${index}.mp4`,
        'blue',
        frames,
        `${fps.numerator}/${fps.denominator}`,
      );
      const audio = nodePath.join(dir, `mix-${index}.wav`);
      await mixAudio(dir, project, [], frames, audio);
      assert.equal(readWav16(await fs.readFile(audio)).samples.length, samples * output.channels);
      const destination = nodePath.join(dir, `final-${index}.mp4`);
      await muxVideo(video, audio, output, frames, destination);
      const info = await probeMedia(destination);
      assert.equal(info.frames, frames);
      assert.deepEqual(info.fps, fps);
      assert.ok(info.audio, 'even a sub-AAC-frame clip must retain its audio stream');
      assert.equal(info.audio.sampleRate, sampleRate);
      assert.equal(info.audio.channels, output.channels);
      assert.ok(
        Math.abs(info.audio.duration - samples / sampleRate) <= 1 / sampleRate,
        `case ${index}: audio duration ${info.audio.duration}`,
      );
      const clock = JSON.parse(
        await runCommand('ffprobe', [
          '-v',
          'error',
          '-select_streams',
          'a:0',
          '-show_entries',
          'stream=start_time,duration_ts,time_base',
          '-of',
          'json',
          destination,
        ]),
      );
      assert.equal(Number(clock.streams[0].start_time), 0, 'AAC priming must not shift the authored audio origin');
      assert.equal(Number(clock.streams[0].duration_ts), samples);
      assert.equal(clock.streams[0].time_base, `1/${sampleRate}`);
      const raw = nodePath.join(dir, `decoded-${index}.f32le`);
      await ffmpeg(['-i', destination, '-map', '0:a:0', '-f', 'f32le', '-acodec', 'pcm_f32le', raw]);
      const pcm = await fs.readFile(raw);
      assert.ok(
        pcm.length / (4 * output.channels) >= samples,
        'decoded audio must cover every authored sample, excluding allowed trailing codec padding',
      );
      let startEnergy = 0;
      for (let sample = 0; sample < 64; sample++) startEnergy += pcm.readFloatLE(sample * output.channels * 4) ** 2;
      assert.ok(
        Math.sqrt(startEnergy / 64) > 0.05,
        'priming must not replace the authored beginning with a silence frame',
      );
      const tailFrames = Math.min(128, Math.floor(samples / 4));
      let energy = 0;
      for (let sample = samples - tailFrames; sample < samples; sample++)
        energy += pcm.readFloatLE(sample * output.channels * 4) ** 2;
      assert.ok(
        Math.sqrt(energy / tailFrames) > 0.05,
        'the final authored signal samples must survive, not be replaced with silence',
      );
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('muxVideo pads short audio and bounds long audio to the composition sample span', async () => {
  const dir = await tempDir();
  try {
    const video = await makeColorClip(dir, 'video.mp4', 'blue', 25, '25');
    for (const audioFrames of [5, 50]) {
      const samples = framesToSamples(audioFrames, OUT.fps, OUT.sampleRate);
      const project = makeProjectAt(OUT, [placement('place_a', 0, audioFrames, 0)], []);
      const signal = await writeSignalAsset(dir, {
        id: `signal_${audioFrames}`,
        path: `signal-${audioFrames}.wav`,
        sampleRate: OUT.sampleRate,
        channels: OUT.channels,
        samples,
      });
      project.assets = [signal];
      project.composition!.audio = [
        {
          id: 'signal',
          kind: 'asset',
          asset: signal.id,
          inSample: 0,
          startSample: 0,
          durationSamples: samples,
          gain: 0.3,
          fadeInSamples: 0,
          fadeOutSamples: 0,
        },
      ];
      const audio = nodePath.join(dir, `audio-${audioFrames}.wav`);
      await mixAudio(dir, project, [], audioFrames, audio);
      const destination = nodePath.join(dir, `final-${audioFrames}.mp4`);
      await muxVideo(video, audio, OUT, 25, destination);
      const info = await probeMedia(destination);
      assert.equal(info.frames, 25);
      assert.ok(info.audio);
      assert.ok(Math.abs(info.audio.duration - 1) <= 0.001);
      const raw = nodePath.join(dir, `pcm-${audioFrames}.f32le`);
      await ffmpeg(['-i', destination, '-map', '0:a:0', '-f', 'f32le', '-acodec', 'pcm_f32le', raw]);
      const pcm = await fs.readFile(raw);
      const last = pcm.readFloatLE(47000 * OUT.channels * 4);
      assert.ok(
        audioFrames === 5 ? Math.abs(last) < 0.001 : Math.abs(last) > 0.01,
        'tail must reflect explicit padding versus retained longer content',
      );
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('muxVideo produces H.264/AAC with the exact frame count', async () => {
  const dir = await tempDir();
  try {
    const clip = await makeClip(dir, 'src.mp4', 1, 25, true);
    const dest = nodePath.join(dir, 'muxed.mp4');
    await muxVideo(clip, clip, OUT, 25, dest);
    const info = await probeMedia(dest);
    assert.equal(info.frames, 25);
    assert.equal(info.videoCodec, 'h264');
    assert.ok(info.audio, 'muxed output must contain audio');
    assert.equal(info.audio!.sampleRate, 48000);
    assert.equal(info.audio!.channels, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/**
 * Observe process arguments while `body` runs the real FFmpeg. This uses the
 * same executable and assertions on every platform, without a shell wrapper.
 * Restore the process launcher even when the body fails.
 */
async function withFfmpegLogger<T>(body: () => Promise<T>): Promise<{ result: T; calls: string[] }> {
  const calls: string[] = [];
  const original = childProcess.spawn;
  const traced = (...args: Parameters<typeof childProcess.spawn>) => {
    if (args[0] === 'ffmpeg') calls.push((args[1] ?? []).join(' '));
    return original(...args);
  };
  childProcess.spawn = traced as typeof childProcess.spawn;
  syncBuiltinESMExports();
  try {
    return { result: await body(), calls };
  } finally {
    childProcess.spawn = original;
    syncBuiltinESMExports();
  }
}

test('mixAudio decodes a repeated Asset once across a programme pass and a stem pass', async () => {
  const dir = await tempDir();
  try {
    const asset = await writeSignalAsset(dir, {
      id: 'bed_asset',
      path: 'assets/bed.wav',
      sampleRate: 48000,
      channels: 2,
      samples: 48000,
      // Two clips overlap with gains 1 and 0.25; half scale keeps the real
      // sum (0.625) below full scale without touching the decode-count probe.
      amplitude: 0.5,
    });
    const assets: Project['assets'] = [asset];
    // Three clips read the SAME asset on one bus; the programme (bus unset) and
    // the grouped stem both route every clip again.
    const audio: Composition['audio'] = [
      {
        id: 'a',
        kind: 'asset',
        asset: 'bed_asset',
        inSample: 0,
        startSample: 0,
        durationSamples: 24000,
        gain: 1,
        fadeInSamples: 0,
        fadeOutSamples: 0,
        bus: 'bed',
      },
      {
        id: 'b',
        kind: 'asset',
        asset: 'bed_asset',
        inSample: 24000,
        startSample: 24000,
        durationSamples: 24000,
        gain: 0.5,
        fadeInSamples: 0,
        fadeOutSamples: 0,
        bus: 'bed',
      },
      {
        id: 'c',
        kind: 'asset',
        asset: 'bed_asset',
        inSample: 0,
        startSample: 0,
        durationSamples: 12000,
        gain: 0.25,
        fadeInSamples: 0,
        fadeOutSamples: 0,
        bus: 'bed',
      },
    ];
    const project = makeProject([placement('place_a', 0, 25, 0)], [], audio, assets);
    const programme = nodePath.join(dir, 'programme.wav');
    const stem = nodePath.join(dir, 'stem.wav');
    const { calls } = await withFfmpegLogger(async () => {
      await mixAudio(dir, project, [], 25, programme);
      await mixAudio(dir, project, [], 25, stem, undefined, 'bed');
    });
    const decodes = calls.filter(line => line.includes('bed.wav') && line.includes('f32le'));
    assert.equal(
      decodes.length,
      1,
      `three clips over two passes must decode their shared asset once; saw ${decodes.length}`,
    );

    const wav = readWav16(await fs.readFile(programme));
    assert.equal(wav.samples.length, 48000 * 2);
    let peak = 0;
    for (let s = 0; s < 48000; s++) peak = Math.max(peak, Math.abs(wav.samples[s * 2]));
    assert.ok(peak > 0, 'the shared decoded asset must still contribute audio');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('mixAudio J/L-cut placement is identical whether the Take is the same file or a byte copy', async () => {
  const dir = await tempDir();
  try {
    const take = await makeClip(dir, 'take.mp4', 1, 25, true);
    const copy = nodePath.join(dir, 'take-copy.mp4');
    await fs.copyFile(take, copy);
    const project = makeProject([placement('place_a', 0, 100, 0)], []);
    // startFrame 5 @25fps = 9600; a 4800-sample pre-roll leads it (leading edge
    // 4800) and a 4800-sample tail trails it.
    const options = {
      startFrame: 5,
      gain: 0.6,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      offsetSamples: 0,
      tailSamples: 4800,
      leadSamples: 4800,
      takeInSample: 4800,
      takeBodySamples: 48000,
    };
    const sharedDest = nodePath.join(dir, 'shared.wav');
    const copyDest = nodePath.join(dir, 'copied.wav');
    await mixAudio(dir, project, [{ path: take, takePath: take, ...options }], 100, sharedDest);
    await mixAudio(dir, project, [{ path: take, takePath: copy, ...options }], 100, copyDest);

    const shared = await fs.readFile(sharedDest);
    assert.deepEqual(await fs.readFile(copyDest), shared, 'sharing a decode must equal decoding an identical copy');

    const wav = readWav16(shared);
    for (let s = 0; s < 4800; s++)
      assert.equal(wav.samples[s * 2], 0, `sample ${s} before the J-cut lead must be silent`);
    let peak = 0;
    for (let s = 4800; s < 57600; s++) peak = Math.max(peak, Math.abs(wav.samples[s * 2]));
    assert.ok(peak > 0, 'audio from the J-cut lead through the body must be present');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
