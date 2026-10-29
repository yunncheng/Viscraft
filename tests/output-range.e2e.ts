import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { buildProject } from '../src/build/build.js';
import { probeMedia } from '../src/backends/media/probe.js';
import { framesToSamples } from '../src/core/time.js';
import type { BuildRecord, OutputSettings, Project } from '../src/core/schema.js';
import { resolveProjectPath } from '../src/shared/fs.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { validateProject } from '../src/project/project.js';
import { writeSignalAsset } from './audio-fixtures.js';

const WIDTH = 64;
const HEIGHT = 48;
const FPS = { numerator: 30, denominator: 1 };
const OUTPUT: OutputSettings = { width: WIDTH, height: HEIGHT, fps: FPS, sampleRate: 48000, channels: 2 };
const CONTENT = 30; // placement content frames
const PLATE = 60; // fixture frames, with handles left over
const CONTENT_SAMPLES = framesToSamples(CONTENT, FPS, OUTPUT.sampleRate, 'ceil');

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
  return fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-range-e2e-'));
}

/** A bright flat plate, plus a Project that resolves the asset and registers it. */
async function authorProject(
  root: string,
  options: { outputFrames?: number; fade?: { inFrames: number; outFrames: number } },
): Promise<void> {
  const fixture = nodePath.join(root, 'plate.mp4');
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `color=c=0xffffff:size=${WIDTH}x${HEIGHT}:rate=30`,
    '-frames:v',
    String(PLATE),
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
    fixture,
  ]);
  const signal = await writeSignalAsset(root, {
    id: 'signal',
    path: 'signal.wav',
    sampleRate: OUTPUT.sampleRate,
    channels: 2,
    samples: CONTENT_SAMPLES,
    frequency: 440,
  });
  const project: Project = validateProject({
    schemaVersion: 1,
    id: 'range_work',
    revision: 1,
    title: 'Explicit programme length',
    direction: {
      intent: 'Exact-duration master with a black tail',
      looks: [{ id: 'flat', description: 'Flat' }],
      transitions: [],
    },
    assets: [
      {
        id: 'plate',
        revision: 1,
        path: 'plate.mp4',
        sha256: await hashFile(fixture),
        type: 'video',
        rights: { origin: 'Original FFmpeg fixture', license: 'CC0-1.0', redistributable: true },
        simulated: false,
      },
      signal,
    ],
    bindings: {},
    sources: [],
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: 'Flat plate' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'flat', intent: 'Plate', targetFrames: CONTENT }],
      placements: [
        { id: 'p', shot: 'shot', asset: 'plate', inFrame: 0, outFrame: CONTENT, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio: [
        {
          id: 'signal',
          kind: 'asset',
          asset: 'signal',
          inSample: 0,
          startSample: 0,
          durationSamples: CONTENT_SAMPLES,
          gain: 0.8,
          fadeInSamples: 480,
          fadeOutSamples: 480,
        },
      ],
      ...(options.outputFrames !== undefined ? { outputFrames: options.outputFrames } : {}),
      ...(options.fade ? { fade: options.fade } : {}),
    },
  });
  await fs.writeFile(nodePath.join(root, 'project.json'), JSON.stringify(project));
}

async function decodeRgb(file: string, dir: string): Promise<Buffer[]> {
  const raw = nodePath.join(dir, `raw-${Math.random().toString(36).slice(2)}.rgb`);
  await ffmpeg(['-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-an', raw]);
  const bytes = await fs.readFile(raw);
  const perFrame = WIDTH * HEIGHT * 3;
  assert.equal(bytes.length % perFrame, 0, 'decoded picture must be a whole number of frames');
  const frames: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += perFrame)
    frames.push(bytes.subarray(offset, offset + perFrame));
  return frames;
}

function meanLuma(frame: Buffer): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i += 3) sum += (frame[i] + frame[i + 1] + frame[i + 2]) / 3;
  return sum / (frame.length / 3);
}

async function decodePcm(file: string, dir: string): Promise<Buffer> {
  const raw = nodePath.join(dir, `pcm-${Math.random().toString(36).slice(2)}.f32le`);
  await ffmpeg(['-i', file, '-map', '0:a:0', '-f', 'f32le', '-acodec', 'pcm_f32le', raw]);
  return fs.readFile(raw);
}

function channelRms(pcm: Buffer, start: number, end: number): number {
  let energy = 0;
  let count = 0;
  for (let sample = start; sample < end; sample++) {
    const value = pcm.readFloatLE(sample * OUTPUT.channels * 4);
    energy += value * value;
    count++;
  }
  return Math.sqrt(energy / Math.max(1, count));
}

/** Count the pixels of a decoded RGB frame that read as saturated red. */
function redPixels(frame: Buffer): number {
  let count = 0;
  for (let i = 0; i < frame.length; i += 3) if (frame[i] > 160 && frame[i + 1] < 90 && frame[i + 2] < 90) count++;
  return count;
}

/** Count near-white pixels (a burned-in caption glyph reads as white). */
function brightPixels(frame: Buffer): number {
  let count = 0;
  for (let i = 0; i < frame.length; i += 3) if ((frame[i] + frame[i + 1] + frame[i + 2]) / 3 > 200) count++;
  return count;
}

async function resultFile(root: string, build: BuildRecord): Promise<string> {
  const artifact = build.artifacts.find(item => item.id === build.result!.artifact)!;
  assert.ok(artifact, 'build must record a delivered result artifact');
  return resolveProjectPath(root, artifact.path);
}

test("an explicit programme length pads a black/silent tail; an equal length matches today's bytes exactly", async () => {
  const base = await tempDir();
  const explicit = await tempDir();
  const explicitTwin = await tempDir();
  try {
    // Baseline: no explicit length -> content end (30 frames).
    await authorProject(base, {});
    const buildBase = await buildProject(base);
    assert.equal(buildBase.status, 'succeeded');
    const baseMovie = await resultFile(base, buildBase);
    const baseFrames = await decodeRgb(baseMovie, base);
    assert.equal(baseFrames.length, CONTENT, 'without outputFrames the programme is the content end');
    const baselineSha = await hashFile(baseMovie);

    // Explicit length 40: exactly 40 frames, black/silent tail of 10.
    const M = 40;
    await authorProject(explicit, { outputFrames: M });
    const buildExplicit = await buildProject(explicit);
    assert.equal(buildExplicit.status, 'succeeded');
    const movie = await resultFile(explicit, buildExplicit);
    const frames = await decodeRgb(movie, explicit);
    assert.equal(frames.length, M, `explicit outputFrames must yield exactly ${M} frames`);
    assert.notEqual(await hashFile(movie), baselineSha, 'a longer programme must not be byte-identical');

    const full = meanLuma(frames[Math.floor(CONTENT / 2)]);
    for (let i = 0; i < CONTENT; i++)
      assert.ok(meanLuma(frames[i]) / full > 0.9, `content frame ${i} must stay bright`);
    for (let i = CONTENT; i < M; i++) assert.ok(meanLuma(frames[i]) < 0.05, `padded tail frame ${i} must be black`);

    const pcm = await decodePcm(movie, explicit);
    const totalSamples = framesToSamples(M, FPS, OUTPUT.sampleRate, 'ceil');
    const mid = channelRms(pcm, 20000, 24000);
    assert.ok(mid > 0.05, 'the authored signal must be present inside the content');
    const tail = channelRms(pcm, CONTENT_SAMPLES, totalSamples);
    assert.ok(tail < 0.02, `the padded audio tail must be silent, got ${tail.toFixed(5)}`);

    // An explicit length equal to the content end adds no pad and therefore
    // encodes to the same bytes as an omitted programme length.
    await authorProject(explicitTwin, { outputFrames: CONTENT });
    const buildEqual = await buildProject(explicitTwin);
    const equalMovie = await resultFile(explicitTwin, buildEqual);
    assert.equal((await decodeRgb(equalMovie, explicitTwin)).length, CONTENT);
    assert.equal(
      await hashFile(equalMovie),
      baselineSha,
      'outputFrames equal to the content end must be byte-identical to omitting it',
    );

    // Determinism: an identical explicit project in a fresh root yields identical bytes.
    const twin = await tempDir();
    try {
      await authorProject(twin, { outputFrames: M });
      const buildTwin = await buildProject(twin);
      assert.equal(
        await hashFile(await resultFile(twin, buildTwin)),
        await hashFile(movie),
        'an explicit length build must be deterministic across runs',
      );
    } finally {
      await fs.rm(twin, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(explicit, { recursive: true, force: true });
    await fs.rm(explicitTwin, { recursive: true, force: true });
  }
});

test('fade.outFrames ramps against the explicit length, reaching black at the last explicit frame', async () => {
  const root = await tempDir();
  try {
    const M = 40;
    const OUT_FRAMES = 16;
    await authorProject(root, { outputFrames: M, fade: { inFrames: 0, outFrames: OUT_FRAMES } });
    const build = await buildProject(root);
    assert.equal(build.status, 'succeeded');
    const movie = await resultFile(root, build);
    const frames = await decodeRgb(movie, root);
    assert.equal(frames.length, M, 'the fade must not change the explicit length');
    const full = meanLuma(frames[5]);

    // The tail ramp starts at M - outFrames = 24, NOT at CONTENT - outFrames = 14.
    // Frame 14 is therefore still bright, and frame 25 (inside content) is close
    // to full while a content-relative ramp would have dimmed it to 0.31.
    assert.ok(meanLuma(frames[14]) / full > 0.9, 'the ramp must not start a content-relative 14');
    const at25 = meanLuma(frames[25]) / full;
    assert.ok(
      Math.abs(at25 - (M - 25) / OUT_FRAMES) < 0.1,
      `frame 25 must ramp at (M-25)/outFrames = ${(M - 25) / OUT_FRAMES}, got ${at25.toFixed(3)}`,
    );
    assert.ok(meanLuma(frames[M - 1]) < 0.05, 'the final explicit frame must end black');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the tail pad yields the exact frame count at a rational fps (30000/1001)', async () => {
  const root = await tempDir();
  try {
    const FPS_R = { numerator: 30000, denominator: 1001 };
    const OUT_R: OutputSettings = { width: WIDTH, height: HEIGHT, fps: FPS_R, sampleRate: 48000, channels: 2 };
    const CONTENT_R = 15;
    const M_R = 30;
    const fixture = nodePath.join(root, 'plate.mp4');
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      `color=c=0x808080:size=${WIDTH}x${HEIGHT}:rate=30000/1001`,
      '-frames:v',
      '40',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-an',
      fixture,
    ]);
    const contentSamplesR = framesToSamples(CONTENT_R, FPS_R, OUT_R.sampleRate, 'ceil');
    const signal = await writeSignalAsset(root, {
      id: 'signal',
      path: 'signal.wav',
      sampleRate: OUT_R.sampleRate,
      channels: 2,
      samples: contentSamplesR,
      frequency: 440,
    });
    const project: Project = validateProject({
      schemaVersion: 1,
      id: 'range_rational',
      revision: 1,
      title: 'Rational explicit length',
      direction: {
        intent: 'Exact length at 30000/1001',
        looks: [{ id: 'flat', description: 'Flat' }],
        transitions: [],
      },
      assets: [
        {
          id: 'plate',
          revision: 1,
          path: 'plate.mp4',
          sha256: await hashFile(fixture),
          type: 'video',
          rights: { origin: 'Original FFmpeg fixture', license: 'CC0-1.0', redistributable: true },
          simulated: false,
        },
        signal,
      ],
      bindings: {},
      sources: [],
      composition: {
        output: OUT_R,
        scenes: [{ id: 'scene', description: 'scene' }],
        shots: [{ id: 'shot', scene: 'scene', look: 'flat', intent: 'Plate', targetFrames: CONTENT_R }],
        placements: [
          { id: 'p', shot: 'shot', asset: 'plate', inFrame: 0, outFrame: CONTENT_R, startFrame: 0, audio: 'mute' },
        ],
        transitions: [],
        audio: [
          {
            id: 'signal',
            kind: 'asset',
            asset: 'signal',
            inSample: 0,
            startSample: 0,
            durationSamples: contentSamplesR,
            gain: 0.8,
            fadeInSamples: 0,
            fadeOutSamples: 0,
          },
        ],
        outputFrames: M_R,
      },
    });
    await fs.writeFile(nodePath.join(root, 'project.json'), JSON.stringify(project));
    const build = await buildProject(root);
    assert.equal(build.status, 'succeeded');
    const artifact = build.artifacts.find(item => item.id === build.result!.artifact)!;
    const movie = await resolveProjectPath(root, artifact.path);

    const info = await probeMedia(movie);
    assert.equal(info.frames, M_R, 'a rational fps must still produce the exact explicit frame count');
    assert.equal(
      info.fps.numerator * FPS_R.denominator,
      FPS_R.numerator * info.fps.denominator,
      'rational fps preserved',
    );

    const frames = await decodeRgb(movie, root);
    assert.equal(frames.length, M_R);
    for (let i = 0; i < CONTENT_R; i++)
      assert.ok(meanLuma(frames[i]) > 60, `content frame ${i} must be the gray plate`);
    for (let i = CONTENT_R; i < M_R; i++)
      assert.ok(meanLuma(frames[i]) < 0.05, `rational tail frame ${i} must be black`);

    const pcm = await decodePcm(movie, root);
    const totalSamplesR = framesToSamples(M_R, FPS_R, OUT_R.sampleRate, 'ceil');
    const mid = channelRms(pcm, 2000, 6000);
    const tail = channelRms(pcm, contentSamplesR, totalSamplesR);
    assert.ok(mid > 0.05, 'the signal must be present inside the rational content');
    assert.ok(tail < 0.02, `the rational padded tail must be silent, got ${tail.toFixed(5)}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('outputFrames composes with subtitles and picture layers without bleeding into the tail', async () => {
  const root = await tempDir();
  try {
    const M = 40;
    const basePlate = nodePath.join(root, 'base.mp4');
    const redPlate = nodePath.join(root, 'red.mp4');
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      `color=c=0x808080:size=${WIDTH}x${HEIGHT}:rate=30`,
      '-frames:v',
      '60',
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
      basePlate,
    ]);
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=c=0xff0000:size=32x24:rate=30',
      '-frames:v',
      '60',
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
      redPlate,
    ]);
    const signal = await writeSignalAsset(root, {
      id: 'signal',
      path: 'signal.wav',
      sampleRate: OUTPUT.sampleRate,
      channels: 2,
      samples: CONTENT_SAMPLES,
      frequency: 440,
    });
    const project: Project = validateProject({
      schemaVersion: 1,
      id: 'range_compose',
      revision: 1,
      title: 'Explicit length with layers and subtitles',
      direction: { intent: 'compose', looks: [{ id: 'flat', description: 'Flat' }], transitions: [] },
      assets: [
        {
          id: 'base',
          revision: 1,
          path: 'base.mp4',
          sha256: await hashFile(basePlate),
          type: 'video',
          rights: { origin: 'fixture', license: 'CC0-1.0', redistributable: true },
          simulated: false,
        },
        {
          id: 'red',
          revision: 1,
          path: 'red.mp4',
          sha256: await hashFile(redPlate),
          type: 'video',
          rights: { origin: 'fixture', license: 'CC0-1.0', redistributable: true },
          simulated: false,
        },
        signal,
      ],
      bindings: {},
      sources: [],
      composition: {
        output: OUTPUT,
        scenes: [{ id: 'scene', description: 'scene' }],
        shots: [{ id: 'shot', scene: 'scene', look: 'flat', intent: 'Plate', targetFrames: CONTENT }],
        placements: [
          { id: 'p', shot: 'shot', asset: 'base', inFrame: 0, outFrame: CONTENT, startFrame: 0, audio: 'mute' },
        ],
        transitions: [],
        audio: [
          {
            id: 'signal',
            kind: 'asset',
            asset: 'signal',
            inSample: 0,
            startSample: 0,
            durationSamples: CONTENT_SAMPLES,
            gain: 0.8,
            fadeInSamples: 0,
            fadeOutSamples: 0,
          },
        ],
        subtitles: [
          { id: 'sub', text: 'HELLO', startFrame: 4, endFrame: 10, fontSize: 16, color: '#ffffff', x: 4, y: 30 },
        ],
        layers: [
          {
            id: 'lay',
            asset: 'red',
            inFrame: 0,
            outFrame: 6,
            startFrame: 8,
            x: 0,
            y: 0,
            width: 32,
            height: 24,
            opacity: 1,
          },
        ],
        outputFrames: M,
      },
    });
    await fs.writeFile(nodePath.join(root, 'project.json'), JSON.stringify(project));
    const build = await buildProject(root);
    assert.equal(build.status, 'succeeded');
    const artifact = build.artifacts.find(item => item.id === build.result!.artifact)!;
    const movie = await resolveProjectPath(root, artifact.path);
    const frames = await decodeRgb(movie, root);
    assert.equal(frames.length, M, 'subtitles/layers must not change the explicit length');

    // Caption interval [4, 10): white glyphs present inside, absent outside.
    for (let n = 4; n < 10; n++) assert.ok(brightPixels(frames[n]) > 0, `caption must be visible on frame ${n}`);
    for (const n of [0, 2, 10, 12, 16, CONTENT, M - 1])
      assert.equal(brightPixels(frames[n]), 0, `no caption may appear on frame ${n}`);

    // Picture layer interval [8, 14): red rect present inside, absent outside.
    for (let n = 8; n < 14; n++) assert.ok(redPixels(frames[n]) > 100, `red layer must be visible on frame ${n}`);
    for (const n of [0, 6, 7, 14, 16, CONTENT, M - 1])
      assert.equal(redPixels(frames[n]), 0, `no layer may appear on frame ${n}`);

    // The padded tail is black with no caption or layer bleeding into it.
    for (let n = CONTENT; n < M; n++) {
      assert.ok(meanLuma(frames[n]) < 0.05, `tail frame ${n} must be black`);
      assert.equal(brightPixels(frames[n]), 0, `caption must not bleed into tail frame ${n}`);
      assert.equal(redPixels(frames[n]), 0, `layer must not bleed into tail frame ${n}`);
    }

    const pcm = await decodePcm(movie, root);
    const totalSamples = framesToSamples(M, FPS, OUTPUT.sampleRate, 'ceil');
    assert.ok(channelRms(pcm, 20000, 24000) > 0.05, 'signal present in content');
    assert.ok(channelRms(pcm, CONTENT_SAMPLES, totalSamples) < 0.02, 'padded tail must stay silent');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an outputFrames shorter than the content is rejected before any media is written', async () => {
  const root = await tempDir();
  try {
    // A raw, intentionally-invalid Project: content ends at 30 but asks for 20.
    const raw = {
      schemaVersion: 1,
      id: 'range_bad',
      revision: 1,
      title: 'Truncating length',
      direction: { intent: 'bad', looks: [{ id: 'flat', description: 'Flat' }], transitions: [] },
      assets: [],
      bindings: {},
      sources: [],
      composition: {
        output: OUTPUT,
        scenes: [{ id: 'scene', description: 'scene' }],
        shots: [{ id: 'shot', scene: 'scene', look: 'flat', intent: 'Plate', targetFrames: CONTENT }],
        placements: [
          { id: 'p', shot: 'shot', source: 'flat', inFrame: 0, outFrame: CONTENT, startFrame: 0, audio: 'mute' },
        ],
        transitions: [],
        audio: [],
        outputFrames: 20,
      },
    };
    await fs.writeFile(nodePath.join(root, 'project.json'), JSON.stringify(raw));
    await assert.rejects(() => buildProject(root), /shorter than the content end \(30\); shorten placements/);

    // No delivery result and no rendered artifact were written.
    await assert.rejects(
      fs.access(nodePath.join(root, '.viscraft', 'result.json')),
      'a rejected length must not write a result',
    );
    await assert.rejects(
      fs.access(nodePath.join(root, '.viscraft', 'artifacts')),
      'a rejected length must not write artifacts',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
