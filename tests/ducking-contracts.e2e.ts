/**
 * Automatic sidechain ducking — schema contract, mixer curve and build validation.
 *
 * Semantics under test: a `composition.ducking` entry names a `control` bus and
 * a `target` bus; while the control bus is loud, target-bus members are
 * attenuated along a deterministic envelope-following gain curve with
 * configurable threshold/ratio/attack/release and a gain floor.
 *
 *  - a project with NO `ducking` mixes identically whether the field is omitted
 *    or set to `ducking: []` (both mean "no ducking");
 *  - while the control bus is loud the target is attenuated by approximately
 *    `maxAttenuationDb`; after it stops the target recovers over roughly
 *    `releaseSamples`;
 *  - `target === control` is rejected by the schema;
 *  - a `target` bus with no members is a loud build error;
 *  - a stem pass for the target bus is ducked, an unrelated stem is untouched.
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
import { mixAudio } from '../src/backends/media/audio-mix.js';
import type { Composition, Ducking, Project } from '../src/core/schema.js';
import { framesToSamples } from '../src/core/time.js';
import { validateProject } from '../src/project/project.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { writeSignalAsset } from './audio-fixtures.js';

const FPS30 = { numerator: 30, denominator: 1 } as const;
const OUTPUT = { width: 64, height: 48, fps: FPS30, sampleRate: 48000, channels: 2 } as const;
const SAMPLE_RATE = 48000;

/** The default release constant for `DuckingSchema` at this output rate. */
const DEFAULT_RELEASE_SAMPLES = Math.round(SAMPLE_RATE * 0.2); // 9600 (200 ms)
const DEFAULT_MAX_ATTENUATION_DB = -18;

type Clip = Composition['audio'][number];

function samplesFor(frames: number): number {
  return framesToSamples(frames, FPS30, SAMPLE_RATE, 'ceil');
}

function makeProject(audio: Clip[], ducking?: Ducking[], assets: Project['assets'] = []): Project {
  return {
    schemaVersion: 1,
    id: 'ducking-unit',
    revision: 1,
    title: 'Ducking unit',
    soundTargets: [],
    direction: {
      intent: 'Envelope-following bus ducking',
      looks: [{ id: 'look', description: 'identity' }],
      transitions: [],
    },
    assets,
    bindings: {},
    sources: [
      {
        id: 'scene',
        kind: 'browser',
        output: 'picture',
        entry: 'scene.html',
        resources: [],
        bindings: [],
        params: {},
        seed: 0,
        frames: 1,
      },
    ],
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: 'Ducking' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: 'Ducking', targetFrames: 1 }],
      placements: [
        { id: 'edit', shot: 'shot', source: 'scene', inFrame: 0, outFrame: 1, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio,
      ...(ducking === undefined ? {} : { ducking }),
    },
    imageDocuments: [],
    imageTargets: [],
  };
}

function signalClip(
  id: string,
  asset: string,
  gain: number,
  startSample: number,
  durationSamples: number,
  bus?: string,
): Clip {
  return {
    id,
    kind: 'asset',
    asset,
    inSample: 0,
    startSample,
    durationSamples,
    gain,
    fadeInSamples: 0,
    fadeOutSamples: 0,
    ...(bus === undefined ? {} : { bus }),
  };
}

/** Write a distinct-frequency signal Asset at the real output rate/stereo. */
function signalAsset(root: string, id: string, frequency: number, samples: number): Promise<Project['assets'][number]> {
  return writeSignalAsset(root, { id, path: `${id}.wav`, sampleRate: SAMPLE_RATE, channels: 2, samples, frequency });
}

/** Parse the runtime's canonical 44/16/le PCM WAV back to normalized floats. */
function decodePcm16Wav(buffer: Buffer): { sampleRate: number; channels: number; samples: Float32Array } {
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buffer.toString('ascii', 8, 12), 'WAVE');
  let offset = 12;
  let fmt: { sampleRate: number; channels: number; bits: number } | undefined;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ')
      fmt = {
        sampleRate: buffer.readUInt32LE(body + 4),
        channels: buffer.readUInt16LE(body + 2),
        bits: buffer.readUInt16LE(body + 14),
      };
    else if (id === 'data') {
      dataOffset = body;
      dataLength = Math.min(size, buffer.length - body);
    }
    offset = body + size + (size % 2);
  }
  assert(fmt && dataOffset >= 0, 'canonical PCM WAV must expose fmt and data chunks');
  assert.equal(fmt.bits, 16, 'mixer output must be PCM16');
  const frames = Math.floor(dataLength / (fmt.channels * 2));
  const samples = new Float32Array(frames * fmt.channels);
  for (let i = 0; i < samples.length; i++) samples[i] = buffer.readInt16LE(dataOffset + i * 2) / 32767;
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, samples };
}

/** Channel-averaged RMS over the half-open sample window [start, end). */
function windowRms(samples: Float32Array, channels: number, start: number, end: number): number {
  let energy = 0;
  let count = 0;
  for (let s = start; s < end; s++) {
    let value = 0;
    for (let c = 0; c < channels; c++) value += samples[s * channels + c];
    value /= channels;
    energy += value * value;
    count++;
  }
  return Math.sqrt(energy / Math.max(1, count));
}

async function render(
  root: string,
  project: Project,
  name: string,
  totalFrames: number,
  bus?: string,
  ducking?: Ducking[],
): Promise<Buffer> {
  const destination = join(root, name);
  await mixAudio(root, project, [], totalFrames, destination, undefined, bus, ducking);
  return readFile(destination);
}

test('a project with no ducking mixes identically whether the rule list is omitted or empty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-ducking-baseline-'));
  try {
    const totalFrames = 30;
    const totalSamples = samplesFor(totalFrames);
    const low = await signalAsset(root, 'lowAsset', 220, totalSamples);
    const high = await signalAsset(root, 'highAsset', 660, totalSamples);
    const clips = [
      signalClip('low', 'lowAsset', 0.4, 0, totalSamples),
      signalClip('high', 'highAsset', 0.3, 0, totalSamples),
    ];

    const omitted = makeProject(clips, undefined, [low, high]); // no `ducking` key at all
    const empty = makeProject(clips, [], [low, high]); // an explicitly empty rule set
    assert.doesNotThrow(() => validateProject(omitted), 'the field remains optional');
    assert.doesNotThrow(() => validateProject(empty), 'an empty ducking list is valid');

    const a = await render(root, omitted, 'a.wav', totalFrames);
    const b = await render(root, empty, 'b.wav', totalFrames);
    const c = await render(root, omitted, 'c.wav', totalFrames);
    assert.deepEqual(a, b, 'an empty ducking list must not change a single output byte');
    assert.deepEqual(a, c, 'the no-ducking mix must be deterministic');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a loud control bus attenuates its target by ~maxAttenuationDb and releases over ~releaseSamples', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-ducking-curve-'));
  try {
    const totalFrames = 120; // 4 s
    const totalSamples = samplesFor(totalFrames); // 192000
    const controlStart = samplesFor(40); // 1.0 s
    const controlEnd = samplesFor(80); // 2.0 s

    // A steady music bed and a dialogue burst loud enough to clamp at the floor.
    const music = await signalAsset(root, 'musicAsset', 300, totalSamples);
    const dialogue = await signalAsset(root, 'dialogueAsset', 800, controlEnd - controlStart);
    const project = makeProject(
      [
        signalClip('music', 'musicAsset', 0.3, 0, totalSamples, 'music'),
        signalClip('dialogue', 'dialogueAsset', 0.9, controlStart, controlEnd - controlStart, 'dialogue'),
      ],
      undefined,
      [music, dialogue],
    );

    const entry: Ducking = { target: 'music', control: 'dialogue' };
    const unducked = decodePcm16Wav(await render(root, project, 'unducked.wav', totalFrames, 'music'));
    const ducked = decodePcm16Wav(await render(root, project, 'ducked.wav', totalFrames, 'music', [entry]));
    assert.equal(unducked.channels, 2);

    const WINDOW = 1200; // 25 ms
    const ratioAt = (start: number): number =>
      windowRms(ducked.samples, 2, start, start + WINDOW) / windowRms(unducked.samples, 2, start, start + WINDOW);

    const bedRms = windowRms(unducked.samples, 2, controlStart, controlStart + WINDOW);
    assert.ok(bedRms > 0.05, `the music bed must actually be present (rms ${bedRms})`);

    // Mid-burst: the target rides the gain floor.
    const attenuatedDb = 20 * Math.log10(ratioAt(samplesFor(75)));
    console.log(
      `[ducking] mid-burst attenuation = ${attenuatedDb.toFixed(2)} dB (expected ~${DEFAULT_MAX_ATTENUATION_DB})`,
    );
    assert.ok(
      Math.abs(attenuatedDb - DEFAULT_MAX_ATTENUATION_DB) < 1.5,
      `mid-burst attenuation must approach maxAttenuationDb, got ${attenuatedDb.toFixed(2)} dB`,
    );

    // Late, well after the burst and the release tail: back to the unducked level.
    const recoveredDb = 20 * Math.log10(ratioAt(samplesFor(115)));
    console.log(`[ducking] late recovery residual = ${recoveredDb.toFixed(2)} dB`);
    assert.ok(Math.abs(recoveredDb) < 0.5, `the target must recover to ~0 dB, got ${recoveredDb.toFixed(2)} dB`);

    // One release time constant: the dB gain has recovered 1/e of the way from
    // the floor back to 0 dB, i.e. -18/e dB => a linear curve of 10^(-18/e/20).
    const thresholdCurve = 10 ** (DEFAULT_MAX_ATTENUATION_DB / Math.E / 20);
    let recoverySamples = -1;
    for (let start = controlEnd; start + WINDOW <= totalSamples; start += WINDOW) {
      if (ratioAt(start) >= thresholdCurve) {
        recoverySamples = start - controlEnd;
        break;
      }
    }
    assert.ok(recoverySamples >= 0, 'the target must recover within the programme');
    const recoveryMs = (recoverySamples / SAMPLE_RATE) * 1000;
    console.log(
      `[ducking] 1/e recovery = ${recoverySamples} samples (${recoveryMs.toFixed(1)} ms); default releaseSamples = ${DEFAULT_RELEASE_SAMPLES}`,
    );
    assert.ok(
      recoverySamples >= DEFAULT_RELEASE_SAMPLES * 0.5 && recoverySamples <= DEFAULT_RELEASE_SAMPLES * 3,
      `recovery must take roughly releaseSamples, got ${recoverySamples}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a ducking target may not equal its control', () => {
  const totalSamples = samplesFor(30);
  const signal: Project['assets'][number] = {
    id: 'signal',
    revision: 1,
    path: 'signal.wav',
    sha256: 'a'.repeat(64),
    type: 'audio',
    rights: { origin: 'generated test signal', license: 'CC0-1.0', redistributable: true },
    simulated: false,
  };
  const project = makeProject(
    [signalClip('music', 'signal', 0.3, 0, totalSamples, 'music')],
    [{ target: 'music', control: 'music' }],
    [signal],
  );
  assert.throws(() => validateProject(project), /target and control must differ/, 'a bus cannot duck itself');
});

test('a stem pass for the target bus is ducked while an unrelated stem is untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-ducking-stem-'));
  try {
    const totalFrames = 120;
    const totalSamples = samplesFor(totalFrames);
    const controlStart = samplesFor(40);
    const controlEnd = samplesFor(80);
    const music = await signalAsset(root, 'musicAsset', 300, totalSamples);
    const dialogue = await signalAsset(root, 'dialogueAsset', 800, controlEnd - controlStart);
    const sfx = await signalAsset(root, 'sfxAsset', 1200, totalSamples);
    const project = makeProject(
      [
        signalClip('music', 'musicAsset', 0.3, 0, totalSamples, 'music'),
        signalClip('dialogue', 'dialogueAsset', 0.9, controlStart, controlEnd - controlStart, 'dialogue'),
        signalClip('sfx', 'sfxAsset', 0.2, 0, totalSamples, 'sfx'),
      ],
      undefined,
      [music, dialogue, sfx],
    );
    const entry: Ducking = { target: 'music', control: 'dialogue' };

    const musicUnducked = await render(root, project, 'stem-music-plain.wav', totalFrames, 'music');
    const musicDucked = await render(root, project, 'stem-music-ducked.wav', totalFrames, 'music', [entry]);
    assert.notDeepEqual(musicDucked, musicUnducked, 'the target stem must actually be ducked');

    // The burst region of the ducked stem is measurably quieter than the plain stem.
    const plain = decodePcm16Wav(musicUnducked);
    const ducked = decodePcm16Wav(musicDucked);
    const att =
      20 *
      Math.log10(
        windowRms(ducked.samples, 2, samplesFor(75), samplesFor(75) + 1200) /
          windowRms(plain.samples, 2, samplesFor(75), samplesFor(75) + 1200),
      );
    assert.ok(att < -12, `the target stem must be clearly ducked, got ${att.toFixed(2)} dB`);

    // A rule that targets `music` must leave the `sfx` stem byte-identical.
    const sfxUnducked = await render(root, project, 'stem-sfx-plain.wav', totalFrames, 'sfx');
    const sfxDucked = await render(root, project, 'stem-sfx-ducked.wav', totalFrames, 'sfx', [entry]);
    assert.deepEqual(sfxDucked, sfxUnducked, 'an unrelated stem must not be touched by a rule on another bus');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a build refuses a ducking rule whose target or control bus has no members', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-ducking-emptybus-'));
  try {
    const totalFrames = 30;
    const fixture = join(root, 'plate.mp4');
    await runCommand('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-filter_threads',
      '1',
      '-f',
      'lavfi',
      '-i',
      'color=c=0x336699:size=64x48:rate=30',
      '-frames:v',
      '30',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-threads',
      '2',
      fixture,
    ]);
    const totalSamples = samplesFor(totalFrames);
    const music = await signalAsset(root, 'musicAsset', 300, totalSamples);
    const dialogue = await signalAsset(root, 'dialogueAsset', 800, totalSamples);
    const plateSha = await hashFile(fixture);
    const author = (ducking: Ducking[]): Project =>
      validateProject({
        schemaVersion: 1,
        id: 'ducking-build',
        revision: 1,
        title: 'Ducking build validation',
        direction: {
          intent: 'Reject inert ducking rules',
          looks: [{ id: 'flat', description: 'Flat' }],
          transitions: [],
        },
        assets: [
          {
            id: 'plate',
            revision: 1,
            path: 'plate.mp4',
            sha256: plateSha,
            type: 'video',
            rights: { origin: 'Original FFmpeg fixture', license: 'CC0-1.0', redistributable: true },
            simulated: false,
          },
          music,
          dialogue,
        ],
        bindings: {},
        sources: [],
        composition: {
          output: OUTPUT,
          scenes: [{ id: 'scene', description: 'Flat' }],
          shots: [{ id: 'shot', scene: 'scene', look: 'flat', intent: 'Flat', targetFrames: totalFrames }],
          placements: [
            {
              id: 'edit',
              shot: 'shot',
              asset: 'plate',
              inFrame: 0,
              outFrame: totalFrames,
              startFrame: 0,
              audio: 'mute',
            },
          ],
          transitions: [],
          audio: [
            signalClip('music', 'musicAsset', 0.3, 0, totalSamples, 'music'),
            signalClip('dialogue', 'dialogueAsset', 0.5, 0, totalSamples, 'dialogue'),
          ],
          ducking,
        },
      });

    const valid = author([{ target: 'music', control: 'dialogue' }]);

    const missingControl = structuredClone(valid);
    missingControl.composition!.ducking = [{ target: 'music', control: 'ghost' }];
    await writeFile(join(root, 'project.json'), JSON.stringify(missingControl));
    await assert.rejects(
      buildProject(root),
      /ducking control bus "ghost" has no members/,
      'an inert control bus must fail loudly',
    );

    const missingTarget = structuredClone(valid);
    missingTarget.composition!.ducking = [{ target: 'ghost', control: 'dialogue' }];
    await writeFile(join(root, 'project.json'), JSON.stringify(missingTarget));
    await assert.rejects(
      buildProject(root),
      /ducking target bus "ghost" has no members/,
      'an inert target bus must fail loudly',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
