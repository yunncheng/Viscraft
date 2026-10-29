#!/usr/bin/env node
/*
 * Viscraft technical fixture: create a 6-second, CPU-rendered kinetic-typography project.
 *
 *   node tests/fixtures/authoring/create-motion.mjs <project-dir>
 *
 * The script creates the directory and writes the CodeScene, audio signals and
 * a schema-valid project.json without overwriting existing files.
 *
 * The piece is built from three independent code sources that all share the same
 * motion.html entry but differ by params, seed and frame count. Each shot places
 * exactly one source, so editing one source only re-renders that source's take.
 *
 * No external media is used: visuals are drawn on a 2D canvas and audio is
 * written as generated PCM signal files, so there is no unknown-copyright material.
 */
import { access, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSignalAsset } from './lib/audio-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_HTML = join(HERE, 'motion.html');

// --- fixed smoke-test configuration (CPU Canvas + integer fps + 48kHz) ---
const FPS = 30;
const DURATION_SECONDS = 6;
const FRAMES = FPS * DURATION_SECONDS; // 180
const WIDTH = 640;
const HEIGHT = 360;
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const SAMPLES_PER_FRAME = SAMPLE_RATE / FPS; // 1600
const BEAT_FRAMES = 15; // 120 BPM at 30fps
const BEAT_SAMPLES = BEAT_FRAMES * SAMPLES_PER_FRAME; // 24000
const BEATS = FRAMES / BEAT_FRAMES; // 12
const SHOT_FRAMES = FRAMES / 3; // 60 per shot

const NEON = ['#00e5ff', '#ff2fb9', '#7c4dff', '#00ffa3'];
const SOLAR = ['#ffd166', '#ff6b6b', '#4dabf7', '#f8f9fa'];
// C5 D5 E5 G5 A5 — a short pentatonic run for the per-beat ticks.
const SCALE = [523.25, 587.33, 659.25, 783.99, 880.0];

function fail(message) {
  console.error('create-motion: ' + message);
  process.exit(1);
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function slugToId(name) {
  const cleaned =
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'study';
  const safe = /^[a-z0-9]/.test(cleaned) ? cleaned : 'p-' + cleaned;
  return ('motion-' + safe).slice(0, 96);
}

function buildAudio() {
  const audio = [];
  const assets = [];
  const signals = [];
  const add = (id, frequency, waveform, startSample, durationSamples, gain, fadeInSamples, fadeOutSamples) => {
    const assetId = `sig_${id}`;
    const signal = makeSignalAsset({
      id: assetId,
      path: `${id}.wav`,
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      samples: durationSamples,
      frequency,
      waveform,
    });
    assets.push(signal.asset);
    signals.push({ path: signal.asset.path, bytes: signal.bytes });
    audio.push({
      id,
      kind: 'asset',
      asset: assetId,
      inSample: 0,
      startSample,
      durationSamples,
      gain,
      fadeInSamples,
      fadeOutSamples,
    });
  };

  // One tick per beat, alternately triangle/sine, short fades around each hit.
  for (let i = 0; i < BEATS; i++) {
    add(
      'beat_' + String(i).padStart(2, '0'),
      SCALE[i % SCALE.length],
      i % 2 === 0 ? 'triangle' : 'sine',
      i * BEAT_SAMPLES,
      4000,
      0.16,
      200,
      3600,
    );
  }

  // A bass note on each bar downbeat (beats 0, 4, 8).
  for (const bar of [0, 4, 8]) {
    add('bass_' + bar, 110, 'sine', bar * BEAT_SAMPLES, 12000, 0.3, 400, 9000);
  }

  // A low pad bed under each 2-second shot so the piece is layered, not just clicks.
  const shotSamples = SHOT_FRAMES * SAMPLES_PER_FRAME;
  for (let k = 0; k < 3; k++) {
    add('pad_' + k, 65.41, 'sine', k * shotSamples, shotSamples, 0.06, 4800, 9600);
  }

  // Final accent landing on the last beat.
  add(
    'accent_final',
    1046.5,
    'triangle',
    (BEATS - 1) * BEAT_SAMPLES,
    8000,
    0.22,
    200,
    7000,
  );

  return { audio, assets, signals };
}

function buildProject(id) {
  const sound = buildAudio();
  const project = {
    schemaVersion: 1,
    id,
    revision: 1,
    title: 'CRAFT — kinetic typography study',
    direction: {
      intent:
        'A six-second, CPU-only kinetic-typography piece driven by a 120 BPM beat grid. ' +
        'Letters assemble, ride and settle while a neon grid pulses behind them. ' +
        'Two named looks cover the rhythmic build and the final lockup.',
      looks: [
        {
          id: 'neon_grid',
          description: 'Dark field with cyan/magenta neon, expanding beat rings and a slow spoke grid.',
        },
        {
          id: 'solar_lockup',
          description: 'Warmer amber/blue palette, calmer settle, a drawn underline and corner brackets.',
        },
      ],
      transitions: [],
    },
    assets: sound.assets,
    bindings: {},
    sources: [
      {
        id: 'src_assemble',
        kind: 'browser', output: 'picture',
        entry: 'motion.html',
        resources: [],
        bindings: [],
        params: {
          layout: 'assemble',
          text: 'CRAFT',
          subtext: '',
          palette: NEON,
          beatFrames: BEAT_FRAMES,
          hue: 0,
          intensity: 1,
          stagger: 0.11,
        },
        seed: 11,
        frames: SHOT_FRAMES,
      },
      {
        id: 'src_rhythm',
        kind: 'browser', output: 'picture',
        entry: 'motion.html',
        resources: [],
        bindings: [],
        params: {
          layout: 'rhythm',
          text: 'RHYTHM',
          subtext: 'in motion',
          palette: NEON,
          beatFrames: BEAT_FRAMES,
          hue: 0.05,
          intensity: 1,
          bars: 36,
        },
        seed: 29,
        frames: SHOT_FRAMES,
      },
      {
        id: 'src_lockup',
        kind: 'browser', output: 'picture',
        entry: 'motion.html',
        resources: [],
        bindings: [],
        params: {
          layout: 'lockup',
          text: 'CRAFT',
          subtext: 'a viscraft study',
          palette: SOLAR,
          beatFrames: BEAT_FRAMES,
          hue: 0.1,
          intensity: 0.9,
        },
        seed: 47,
        frames: SHOT_FRAMES,
      },
    ],
    composition: {
      output: {
        width: WIDTH,
        height: HEIGHT,
        fps: { numerator: FPS, denominator: 1 },
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
      },
      scenes: [
        { id: 'scene_rhythm', description: 'Two shots establish the beat and the letterforms.' },
        { id: 'scene_finale', description: 'The lockup resolves the title and settles.' },
      ],
      shots: [
        {
          id: 'shot_assemble',
          scene: 'scene_rhythm',
          look: 'neon_grid',
          targetFrames: SHOT_FRAMES,
          intent: 'Letters of CRAFT drop in one per beat over a pulsing neon field.',
        },
        {
          id: 'shot_rhythm',
          scene: 'scene_rhythm',
          look: 'neon_grid',
          targetFrames: SHOT_FRAMES,
          intent: 'The word RHYTHM bobs on the beat over an equalizer backdrop.',
        },
        {
          id: 'shot_lockup',
          scene: 'scene_finale',
          look: 'solar_lockup',
          targetFrames: SHOT_FRAMES,
          intent: 'The title locks up, the underline draws in and the glow settles.',
        },
      ],
      placements: [
        {
          id: 'pl_assemble',
          shot: 'shot_assemble',
          source: 'src_assemble',
          inFrame: 0,
          outFrame: SHOT_FRAMES,
          startFrame: 0,
          audio: 'mute',
        },
        {
          id: 'pl_rhythm',
          shot: 'shot_rhythm',
          source: 'src_rhythm',
          inFrame: 0,
          outFrame: SHOT_FRAMES,
          startFrame: SHOT_FRAMES,
          audio: 'mute',
        },
        {
          id: 'pl_lockup',
          shot: 'shot_lockup',
          source: 'src_lockup',
          inFrame: 0,
          outFrame: SHOT_FRAMES,
          startFrame: 2 * SHOT_FRAMES,
          audio: 'mute',
        },
      ],
      transitions: [],
      audio: sound.audio,
    },
  };
  return { project, signals: sound.signals };
}

async function main() {
  const arg = process.argv[2];
  if (!arg || arg === '--help' || arg === '-h') {
    fail('usage: node tests/fixtures/authoring/create-motion.mjs <project-dir>');
  }
  if (!(await exists(SOURCE_HTML))) {
    fail('motion.html is missing next to this script (' + SOURCE_HTML + ')');
  }

  const dir = resolve(arg);
  const projectJson = join(dir, 'project.json');
  if (await exists(projectJson)) {
    fail('refusing to overwrite existing ' + projectJson);
  }

  const id = slugToId(basename(dir));
  const { project, signals } = buildProject(id);

  await mkdir(dir, { recursive: true });
  await copyFile(SOURCE_HTML, join(dir, 'motion.html'), constants.COPYFILE_EXCL);
  for (const signal of signals) await writeFile(join(dir, signal.path), signal.bytes, { flag: 'wx' });
  await writeFile(projectJson, JSON.stringify(project, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });

  console.log('created project: ' + projectJson);
  console.log('  title        : ' + project.title);
  console.log('  output       : ' + WIDTH + 'x' + HEIGHT + ' @ ' + FPS + 'fps, ' + DURATION_SECONDS + 's');
  console.log('  sources      : ' + project.sources.length + ' code sources (entry motion.html)');
  console.log(
    '  shots        : ' + project.composition.shots.length + ', placements: ' + project.composition.placements.length,
  );
  console.log(
    '  audio clips  : ' + project.composition.audio.length + ' PCM signal assets @ ' + SAMPLE_RATE + 'Hz stereo',
  );
  console.log('');
  console.log('next:');
  console.log('  npm run build');
  console.log('  node dist/src/cli.js doctor');
  console.log('  node dist/src/cli.js build ' + dir);
  console.log('  node dist/src/cli.js status ' + dir);
}

main().catch(err => fail(err && err.message ? err.message : String(err)));
