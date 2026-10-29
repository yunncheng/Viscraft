/**
 * Automatic sidechain ducking through a real Build — end to end.
 *
 * A real code-authored picture is scored with a music bus and a dialogue bus.
 * The project is built once without ducking, then again with a single
 * `ducking` entry added and nothing else changed. Because ducking enters the
 * `mix-audio` cache key but never the picture keys:
 *
 *  - the `code` source render and `compose-video` are REUSED (their keys are
 *    untouched by an audio-only rule);
 *  - `mix-audio` re-runs, and so must `mux-final` (it consumes the new mix);
 *  - the delivered movie's picture is byte-identical while its audio changes.
 *
 * This is an envelope-following, bus-keyed rule with a gain floor — NOT dialogue
 * detection, a full compressor, a lookahead limiter or a broadcast-standard
 * sidechain.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildProject } from '../src/build/build.js';
import { loadProject, saveProject, validateProject } from '../src/project/project.js';
import { framesToSamples } from '../src/core/time.js';
import type { BuildRecord, OutputSettings, Project } from '../src/core/schema.js';
import { resolveProjectPath } from '../src/shared/fs.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { writeSignalAsset } from './audio-fixtures.js';

const PAGE =
  '<!doctype html><body style="margin:0"><canvas id="c"></canvas><script>window.viscraft={render(ctx){const c=document.getElementById("c");c.width=ctx.width;c.height=ctx.height;const g=c.getContext("2d");g.fillStyle="#286eb0";g.fillRect(0,0,c.width,c.height);g.fillStyle="#ffffff";g.fillRect(ctx.frame*2,4,4,4);}};</script>';

const FPS = { numerator: 30, denominator: 1 };
const OUTPUT: OutputSettings = { width: 64, height: 48, fps: FPS, sampleRate: 48000, channels: 2 };
const TOTAL_FRAMES = 60; // 2 s
const TOTAL_SAMPLES = framesToSamples(TOTAL_FRAMES, FPS, OUTPUT.sampleRate, 'ceil');
const CONTROL_START = framesToSamples(20, FPS, OUTPUT.sampleRate, 'ceil');
const CONTROL_END = framesToSamples(40, FPS, OUTPUT.sampleRate, 'ceil');

async function authorProject(root: string): Promise<void> {
  await writeFile(join(root, 'scene.html'), PAGE);
  const music = await writeSignalAsset(root, {
    id: 'musicAsset',
    path: 'music.wav',
    sampleRate: OUTPUT.sampleRate,
    channels: 2,
    samples: TOTAL_SAMPLES,
    frequency: 300,
  });
  const dialogue = await writeSignalAsset(root, {
    id: 'dialogueAsset',
    path: 'dialogue.wav',
    sampleRate: OUTPUT.sampleRate,
    channels: 2,
    samples: CONTROL_END - CONTROL_START,
    frequency: 800,
  });
  const project: Project = validateProject({
    schemaVersion: 1,
    id: 'ducking_e2e',
    revision: 1,
    title: 'Ducked score',
    direction: {
      intent: 'Duck the music under dialogue',
      looks: [{ id: 'flat', description: 'Flat' }],
      transitions: [],
    },
    assets: [music, dialogue],
    bindings: {},
    sources: [
      {
        id: 'graphic',
        kind: 'browser',
        output: 'picture',
        entry: 'scene.html',
        resources: [],
        bindings: [],
        params: {},
        seed: 0,
        frames: TOTAL_FRAMES,
      },
    ],
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: 'Flat graphic' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'flat', intent: 'Graphic', targetFrames: TOTAL_FRAMES }],
      placements: [
        {
          id: 'edit',
          shot: 'shot',
          source: 'graphic',
          inFrame: 0,
          outFrame: TOTAL_FRAMES,
          startFrame: 0,
          audio: 'mute',
        },
      ],
      transitions: [],
      audio: [
        {
          id: 'music',
          kind: 'asset',
          asset: 'musicAsset',
          inSample: 0,
          startSample: 0,
          durationSamples: TOTAL_SAMPLES,
          gain: 0.2,
          fadeInSamples: 0,
          fadeOutSamples: 0,
          bus: 'music',
        },
        {
          id: 'dialogue',
          kind: 'asset',
          asset: 'dialogueAsset',
          inSample: 0,
          startSample: CONTROL_START,
          durationSamples: CONTROL_END - CONTROL_START,
          gain: 0.7,
          fadeInSamples: 0,
          fadeOutSamples: 0,
          bus: 'dialogue',
        },
      ],
    },
  });
  await writeFile(join(root, 'project.json'), JSON.stringify(project));
}

async function resultMovie(root: string, build: BuildRecord): Promise<string> {
  const artifact = build.artifacts.find(item => item.id === build.result!.artifact)!;
  assert.ok(artifact, 'build must record a delivered result artifact');
  return resolveProjectPath(root, artifact.path);
}

async function decodeVideo(file: string, dir: string): Promise<Buffer> {
  const raw = join(dir, `v-${Math.random().toString(36).slice(2)}.rgb`);
  await runCommand('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-threads',
    '2',
    '-i',
    file,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-an',
    raw,
  ]);
  return readFile(raw);
}

async function decodeAudio(file: string, dir: string): Promise<Buffer> {
  const raw = join(dir, `a-${Math.random().toString(36).slice(2)}.f32le`);
  await runCommand('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-threads',
    '2',
    '-i',
    file,
    '-map',
    '0:a:0',
    '-f',
    'f32le',
    '-acodec',
    'pcm_f32le',
    raw,
  ]);
  return readFile(raw);
}

test('adding a ducking rule re-runs the mix but reuses every picture operation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-ducking-e2e-'));
  try {
    await authorProject(root);
    const first = await buildProject(root);
    assert.equal(first.status, 'succeeded');
    const firstMovie = await resultMovie(root, first);
    const firstVideo = await decodeVideo(firstMovie, root);
    const firstAudio = await decodeAudio(firstMovie, root);

    // Add ONLY the ducking rule; nothing else in the project changes.
    const edit = await loadProject(root);
    edit.composition!.ducking = [{ target: 'music', control: 'dialogue' }];
    await saveProject(root, edit, edit.revision);

    const second = await buildProject(root);
    assert.equal(second.status, 'succeeded');

    // Picture operations are keyed only on what changes the pixels, so an
    // audio-only rule reuses them completely.
    assert.equal(
      second.operations.find(operation => operation.kind === 'browser')!.reused,
      true,
      'the code render must be reused',
    );
    assert.equal(
      second.operations.find(operation => operation.kind === 'compose-video')!.reused,
      true,
      'the composed picture must be reused',
    );
    assert.equal(
      second.operations.find(operation => operation.kind === 'mix-audio')!.reused,
      false,
      'the ducking rule must invalidate the programme mix',
    );
    assert.equal(
      second.operations.find(operation => operation.kind === 'mux-final')!.reused,
      false,
      'a new mix must re-run the final mux',
    );

    // The reused picture artifact is literally the same bytes.
    assert.equal(
      second.operations.find(operation => operation.kind === 'compose-video')!.artifact,
      first.operations.find(operation => operation.kind === 'compose-video')!.artifact,
    );

    const secondMovie = await resultMovie(root, second);
    assert.notEqual(
      await hashFile(secondMovie),
      await hashFile(firstMovie),
      'the delivered movie must change once the score is ducked',
    );

    // Same picture, different audio: the movie changed only in its audio.
    assert.deepEqual(await decodeVideo(secondMovie, root), firstVideo, 'the delivered picture must be byte-identical');
    const secondAudio = await decodeAudio(secondMovie, root);
    assert.notDeepEqual(secondAudio, firstAudio, 'the delivered audio must change');
    assert.equal(secondAudio.length, firstAudio.length, 'the audio span must be unchanged');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * With ducking declared, which member carries which label IS behaviour of the
 * programme mix (the curve is applied per member by its label, and the control
 * signal is the control bus's own mix). A routing change that keeps every label
 * populated must therefore invalidate the mix: routing labels participate
 * in the operation's parameter identity.
 */
test('swapping two bus labels under an active ducking rule re-runs the mix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-ducking-routing-'));
  try {
    await writeFile(join(root, 'scene.html'), PAGE);
    const bed = await writeSignalAsset(root, {
      id: 'bedAsset',
      path: 'bed.wav',
      sampleRate: OUTPUT.sampleRate,
      channels: 2,
      samples: TOTAL_SAMPLES,
      frequency: 300,
    });
    const burst = await writeSignalAsset(root, {
      id: 'burstAsset',
      path: 'burst.wav',
      sampleRate: OUTPUT.sampleRate,
      channels: 2,
      samples: CONTROL_END - CONTROL_START,
      frequency: 900,
    });
    const project: Project = validateProject({
      schemaVersion: 1,
      id: 'ducking_routing',
      revision: 1,
      title: 'Routing swap',
      direction: {
        intent: 'Duck the bed under the burst',
        looks: [{ id: 'flat', description: 'Flat' }],
        transitions: [],
      },
      assets: [bed, burst],
      bindings: {},
      sources: [
        {
          id: 'graphic',
          kind: 'browser',
          output: 'picture',
          entry: 'scene.html',
          resources: [],
          bindings: [],
          params: {},
          seed: 0,
          frames: TOTAL_FRAMES,
        },
      ],
      composition: {
        output: OUTPUT,
        scenes: [{ id: 'scene', description: 'Flat graphic' }],
        shots: [{ id: 'shot', scene: 'scene', look: 'flat', intent: 'Graphic', targetFrames: TOTAL_FRAMES }],
        placements: [
          {
            id: 'edit',
            shot: 'shot',
            source: 'graphic',
            inFrame: 0,
            outFrame: TOTAL_FRAMES,
            startFrame: 0,
            audio: 'mute',
          },
        ],
        transitions: [],
        // Two clips on two declared buses. `bed` is a full-length low signal;
        // `burst` is a short high signal. Both labels stay populated through the
        // swap, so the only thing that changes is WHICH clip is ducked by WHICH.
        audio: [
          {
            id: 'a',
            kind: 'asset',
            asset: 'bedAsset',
            inSample: 0,
            startSample: 0,
            durationSamples: TOTAL_SAMPLES,
            gain: 0.2,
            fadeInSamples: 0,
            fadeOutSamples: 0,
            bus: 'music',
          },
          {
            id: 'b',
            kind: 'asset',
            asset: 'burstAsset',
            inSample: 0,
            startSample: CONTROL_START,
            durationSamples: CONTROL_END - CONTROL_START,
            gain: 0.3,
            fadeInSamples: 0,
            fadeOutSamples: 0,
            bus: 'sfx',
          },
        ],
        ducking: [{ target: 'music', control: 'sfx' }],
      },
    });
    await writeFile(join(root, 'project.json'), JSON.stringify(project));

    const first = await buildProject(root);
    assert.equal(first.status, 'succeeded');
    const firstAudio = await decodeAudio(await resultMovie(root, first), root);

    // Swap the two labels; every label is still populated and nothing else changes.
    const edit = await loadProject(root);
    edit.composition!.audio.find(clip => clip.id === 'a')!.bus = 'sfx';
    edit.composition!.audio.find(clip => clip.id === 'b')!.bus = 'music';
    await saveProject(root, edit, edit.revision);

    const second = await buildProject(root);
    assert.equal(second.status, 'succeeded');
    assert.equal(
      second.operations.find(operation => operation.kind === 'browser')!.reused,
      true,
      'a routing change must not touch the picture',
    );
    assert.equal(
      second.operations.find(operation => operation.kind === 'compose-video')!.reused,
      true,
      'a routing change must not touch the composed picture',
    );
    assert.equal(
      second.operations.find(operation => operation.kind === 'mix-audio')!.reused,
      false,
      'a routing change under ducking must invalidate the programme mix',
    );
    assert.notEqual(
      await hashFile(await resultMovie(root, second)),
      await hashFile(await resultMovie(root, first)),
      'the delivered movie must change when the ducking routing changes',
    );
    assert.notDeepEqual(
      await decodeAudio(await resultMovie(root, second), root),
      firstAudio,
      'the delivered audio must actually differ after the label swap',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
