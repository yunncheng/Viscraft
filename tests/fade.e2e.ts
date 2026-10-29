import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { buildProject } from '../src/build/build.js';
import { loadProject, saveProject, validateProject } from '../src/project/project.js';
import { framesToSamples } from '../src/core/time.js';
import type { BuildRecord, OutputSettings, Project } from '../src/core/schema.js';
import { resolveProjectPath } from '../src/shared/fs.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { writeSignalAsset } from './audio-fixtures.js';

// A 64x48 white plate at 30 fps so any luminance ramp is unambiguous. 60 source
// frames let the 40-frame programme be trimmed with handles left over.
const WIDTH = 64;
const HEIGHT = 48;
const FPS = { numerator: 30, denominator: 1 };
const OUTPUT: OutputSettings = { width: WIDTH, height: HEIGHT, fps: FPS, sampleRate: 48000, channels: 2 };
const TOTAL_FRAMES = 40;
const IN_FRAMES = 8;
const OUT_FRAMES = 8;
const TOTAL_SAMPLES = framesToSamples(TOTAL_FRAMES, FPS, OUTPUT.sampleRate, 'ceil');
const IN_SAMPLES = framesToSamples(IN_FRAMES, FPS, OUTPUT.sampleRate, 'ceil');
const OUT_START_SAMPLE = framesToSamples(TOTAL_FRAMES - OUT_FRAMES, FPS, OUTPUT.sampleRate, 'ceil');

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
  return fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-fade-e2e-'));
}

/** Write a real bright flat-media Asset and a valid Project that uses it. */
async function authorProject(root: string, fade: { inFrames: number; outFrames: number } | undefined): Promise<void> {
  const fixture = nodePath.join(root, 'plate.mp4');
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `color=c=0xffffff:size=${WIDTH}x${HEIGHT}:rate=30`,
    '-frames:v',
    String(TOTAL_FRAMES + 20),
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
    path: 'audio/signal.wav',
    sampleRate: OUTPUT.sampleRate,
    channels: 2,
    samples: TOTAL_SAMPLES,
  });
  const project: Project = validateProject({
    schemaVersion: 1,
    id: 'fade_work',
    revision: 1,
    title: 'Programme fade',
    direction: {
      intent: 'Whole-programme head/tail fade',
      looks: [{ id: 'flat', description: 'Flat' }],
      transitions: [],
    },
    assets: [
      signal,
      {
        id: 'plate',
        revision: 1,
        path: 'plate.mp4',
        sha256: await hashFile(fixture),
        type: 'video',
        rights: { origin: 'Original FFmpeg fixture', license: 'CC0-1.0', redistributable: true },
        simulated: false,
      },
    ],
    bindings: {},
    sources: [],
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: 'Flat plate' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'flat', intent: 'Plate', targetFrames: TOTAL_FRAMES }],
      placements: [
        { id: 'p', shot: 'shot', asset: 'plate', inFrame: 0, outFrame: TOTAL_FRAMES, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio: [
        {
          id: 'clip',
          kind: 'asset',
          asset: signal.id,
          inSample: 0,
          startSample: 0,
          durationSamples: TOTAL_SAMPLES,
          gain: 0.8,
          fadeInSamples: 0,
          fadeOutSamples: 0,
        },
      ],
      ...(fade ? { fade } : {}),
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

/** Mean displayed luminance (0..255) of one decoded RGB24 frame. */
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

/** RMS of channel 0 over the half-open sample window [start, end). */
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

function resultPath(root: string, build: BuildRecord): Promise<string> {
  const artifact = build.artifacts.find(item => item.id === build.result!.artifact)!;
  assert.ok(artifact, 'build must record a delivered result artifact');
  return resolveProjectPath(root, artifact.path);
}

test('a whole-programme fade ramps picture from black and back and follows on the mixed audio', async () => {
  const root = await tempDir();
  try {
    await authorProject(root, { inFrames: IN_FRAMES, outFrames: OUT_FRAMES });
    const build = await buildProject(root);
    assert.equal(build.status, 'succeeded');

    const movie = await resultPath(root, build);
    const frames = await decodeRgb(movie, root);
    assert.equal(frames.length, TOTAL_FRAMES, 'fade must not change the programme frame count');
    const full = meanLuma(frames[Math.floor(TOTAL_FRAMES / 2)]);

    // Half-open head ramp: frame i in [0, inFrames) has alpha = i / inFrames.
    for (let i = 0; i < IN_FRAMES; i++) {
      const ratio = meanLuma(frames[i]) / full;
      assert.ok(
        Math.abs(ratio - i / IN_FRAMES) < 0.1,
        `head frame ${i} must ramp at i/inFrames, got ${ratio.toFixed(3)}`,
      );
    }
    assert.ok(meanLuma(frames[0]) / full < 0.05, 'the first frame must start essentially black');
    // Frames after the head ramp are unattenuated.
    for (const i of [IN_FRAMES, Math.floor(TOTAL_FRAMES / 2), TOTAL_FRAMES - OUT_FRAMES - 1]) {
      assert.ok(meanLuma(frames[i]) / full > 0.9, `frame ${i} outside the ramps must stay at full luminance`);
    }
    // Half-open tail ramp: frame j in [totalFrames-outFrames, totalFrames) has alpha = (totalFrames-j)/outFrames.
    for (let j = TOTAL_FRAMES - OUT_FRAMES; j < TOTAL_FRAMES; j++) {
      const ratio = meanLuma(frames[j]) / full;
      assert.ok(
        Math.abs(ratio - (TOTAL_FRAMES - j) / OUT_FRAMES) < 0.1,
        `tail frame ${j} must ramp at (totalFrames-j)/outFrames, got ${ratio.toFixed(3)}`,
      );
    }
    assert.ok(meanLuma(frames[TOTAL_FRAMES - 1]) / full < 0.2, 'the last frame must end near black');

    // The mixed audio rides the same envelope over the same output span.
    const pcm = await decodePcm(movie, root);
    const mid = channelRms(
      pcm,
      Math.floor((IN_SAMPLES + OUT_START_SAMPLE) / 2) - 2400,
      Math.floor((IN_SAMPLES + OUT_START_SAMPLE) / 2) + 2400,
    );
    assert.ok(mid > 0.05, 'the mid-programme authored audio must actually be present');
    const headWindows = [0, 1600, 3200, 4800].map(start => channelRms(pcm, start, start + 1600) / mid);
    assert.ok(headWindows[0] < 0.12, `the first audio window must be near silence, got ${headWindows[0].toFixed(3)}`);
    for (let i = 1; i < headWindows.length; i++)
      assert.ok(headWindows[i] > headWindows[i - 1], `head audio envelope must rise (${headWindows.join(', ')})`);
    const tailWindows = [
      OUT_START_SAMPLE,
      OUT_START_SAMPLE + 1600,
      OUT_START_SAMPLE + 3200,
      OUT_START_SAMPLE + 4800,
    ].map(start => channelRms(pcm, start, start + 1600) / mid);
    assert.ok(
      tailWindows[0] > 0.85,
      `the first tail audio window must still be loud, got ${tailWindows[0].toFixed(3)}`,
    );
    for (let i = 1; i < tailWindows.length; i++)
      assert.ok(tailWindows[i] < tailWindows[i - 1], `tail audio envelope must fall (${tailWindows.join(', ')})`);
    const finalWindow = channelRms(pcm, TOTAL_SAMPLES - 1600, TOTAL_SAMPLES) / mid;
    assert.ok(finalWindow < 0.12, `the final audio window must be near silence, got ${finalWindow.toFixed(3)}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('removing the fade drops the ramps and re-runs the mux-final operation', async () => {
  const root = await tempDir();
  try {
    await authorProject(root, { inFrames: IN_FRAMES, outFrames: OUT_FRAMES });
    await buildProject(root);
    const edit = await loadProject(root);
    delete edit.composition!.fade;
    await saveProject(root, edit, edit.revision);
    const plain = await buildProject(root);
    assert.equal(
      plain.operations.find(operation => operation.kind === 'mux-final')!.reused,
      false,
      'a fade edit must invalidate the cached mux-final',
    );

    const movie = await resultPath(root, plain);
    const frames = await decodeRgb(movie, root);
    const full = meanLuma(frames[Math.floor(TOTAL_FRAMES / 2)]);
    assert.ok(meanLuma(frames[0]) / full > 0.9, 'without a fade the head must not ramp from black');
    assert.ok(meanLuma(frames[TOTAL_FRAMES - 1]) / full > 0.9, 'without a fade the tail must not ramp to black');
    const pcm = await decodePcm(movie, root);
    const head = channelRms(pcm, 0, 3200);
    const mid = channelRms(pcm, Math.floor(TOTAL_SAMPLES / 2) - 2400, Math.floor(TOTAL_SAMPLES / 2) + 2400);
    assert.ok(head / mid > 0.8, `without a fade the audio head must stay loud, got ${(head / mid).toFixed(3)}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
