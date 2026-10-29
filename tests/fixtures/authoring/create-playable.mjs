#!/usr/bin/env node
/*
 * Viscraft technical fixture: create a 6-second, CPU-rendered, keyboard-PLAYABLE game
 * project whose single CodeScene (`playable.html`) is a genuine interactive
 * "orbital navigator" that is simultaneously a deterministic offline renderer.
 *
 *   node tests/fixtures/authoring/create-playable.mjs <new-project-directory>
 *
 * What this creates (and deliberately does NOT do):
 *
 *   - One `browser` picture Source whose entry is `playable.html`, with a fixed seed (7)
 *     and 180 frames (6 s at 30 fps). The page draws a controllable probe that
 *     is steered through rings and past asteroids; it is a real game when opened
 *     in a browser and a pure function of (frame, seed, params, recorded input)
 *     when driven offline.
 *   - This first Project ships the playable Source directly, so a plain
 *     `viscraft build` already produces a valid code-only piece with the probe
 *     auto-flying its deterministic course (no input). When the runtime grows a
 *     real input-recording pipeline, a later Project revision can replace this
 *     code Source with the recorded playthrough while keeping the same entry and
 *     composition — nothing here fabricates a recording that does not exist yet.
 *   - Audio is 20 real PCM signal files scheduled on rational frame boundaries
 *     (no captured WebAudio, no Runtime tone synthesis).
 *
 * No external media, model, CDN or World state is used. The piece is a complete
 * original work authored in code.
 *
 * The runtime must be built (`npm run build`); this script imports its canonical
 * `validateProject` and `framesToSamples` rather than duplicating any schema or
 * clock conversion. It refuses to overwrite an existing project.json/playable.html.
 */
import { access, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSignalAsset } from './lib/audio-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_HTML = join(HERE, 'playable.html');

// --- fixed smoke configuration: 640x360, integer fps, 48 kHz stereo ---
const FPS = 30;
const DURATION_SECONDS = 6;
const FRAMES = FPS * DURATION_SECONDS; // 180
const WIDTH = 640;
const HEIGHT = 360;
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BEAT_FRAMES = 15; // 120 BPM at 30 fps
const SEED = 7;

const ORBITAL = ['#ffd166', '#ff8f5a', '#4dabf7', '#b28dff', '#7cf0ff'];
// C5 D5 E5 G5 A5 — a short pentatonic run for the per-beat ticks.
const SCALE = [523.25, 587.33, 659.25, 783.99, 880.0];

function fail(message) {
  console.error('create-playable: ' + message);
  process.exit(1);
}

function messageOf(error) {
  return error && error.message ? error.message : String(error);
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Load the single canonical runtime. No fallback schema or clock conversion. */
async function loadRuntime() {
  try {
    return await import(new URL('../../../dist/src/index.js', import.meta.url));
  } catch (error) {
    fail('the Viscraft runtime is not built or not importable; run `npm run build` first (' + messageOf(error) + ')');
  }
}

// --- audio: exactly 20 real PCM signal clips --------------------------------
function buildAudio(framesToSamples, fps) {
  const toSamples = (frames, rounding) => framesToSamples(frames, fps, SAMPLE_RATE, rounding || 'nearest');
  const audio = [];
  const assets = [];
  const signals = [];
  const add = (id, frequency, waveform, startFrame, durationFrames, gain, fadeInFrames, fadeOutFrames) => {
    const startSample = toSamples(startFrame);
    const durationSamples = toSamples(durationFrames);
    let fadeIn = Math.max(0, toSamples(fadeInFrames));
    let fadeOut = Math.max(0, toSamples(fadeOutFrames));
    if (fadeIn + fadeOut > durationSamples) {
      const k = durationSamples / (fadeIn + fadeOut);
      fadeIn = Math.floor(fadeIn * k);
      fadeOut = durationSamples - fadeIn;
    }
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
      fadeInSamples: fadeIn,
      fadeOutSamples: fadeOut,
    });
  };

  // 1. Twelve beat ticks (one per beat) — 12 clips.
  for (let b = 0; b < FRAMES / BEAT_FRAMES; b++) {
    add(
      `beat_${String(b).padStart(2, '0')}`,
      SCALE[b % SCALE.length],
      b % 2 === 0 ? 'triangle' : 'sine',
      b * BEAT_FRAMES,
      9,
      0.14,
      1,
      7,
    );
  }
  // 2. Four bright chimes landing on the bar quarter-points — 4 clips.
  for (const b of [2, 5, 8, 11]) {
    add(
      `chime_${String(b).padStart(2, '0')}`,
      SCALE[b % SCALE.length] * 2,
      'triangle',
      b * BEAT_FRAMES,
      12,
      0.1,
      1,
      10,
    );
  }
  // 3. Three low pad beds, one under each 2-second third — 3 clips.
  for (let k = 0; k < 3; k++) {
    const span = FRAMES / 3;
    add(
      `pad_${k}`,
      55 + k * 12,
      'sine',
      Math.round(k * span),
      Math.round(span),
      0.06,
      Math.round(span * 0.25),
      Math.round(span * 0.4),
    );
  }
  // 4. A final accent landing on the last beat — 1 clip.
  add('accent_final', SCALE[0] * 2, 'triangle', FRAMES - BEAT_FRAMES, 14, 0.2, 1, 12);

  if (audio.length !== 20) fail(`expected 20 audio clips, built ${audio.length}`);
  return { audio, assets, signals };
}

// --- project ----------------------------------------------------------------
function look(id, description) {
  return { id, description };
}

function buildProject(id, framesToSamples) {
  const fps = { numerator: FPS, denominator: 1 };
  const sound = buildAudio(framesToSamples, fps);
  const project = {
    schemaVersion: 1,
    id,
    revision: 1,
    title: 'ORBITAL NAVIGATOR — playable study',
    direction: {
      intent:
        'A six-second, code-only "orbital navigator": the viewer-participant flies a small probe down an asteroid corridor, ' +
        'steering left and right and boosting forward to thread glowing rings while dodging drifting rock. Rings reward precise line-up ' +
        'with a rising combo multiplier; impacts cost score and flash the frame. Every starfield, nebula, ring, asteroid and engine flare is ' +
        'drawn procedurally on a 2D canvas from a fixed seed — no bitmap, no font, no generative model and no reference material of any kind. ' +
        'The same page is a real game in a browser and a deterministic renderer offline: pixels are a pure function of (frame, seed, params, recorded input). ' +
        'Score events (ring / boost / collision) are computed by the simulation itself and exposed through the page state, so a playthrough can be recorded ' +
        'with real keyboard input and replayed at exact frames. This first revision ships the playable source directly, letting the probe fly its seeded ' +
        'course without input; a later revision can substitute a recorded playthrough without changing the composition.',
      looks: [
        look(
          'deep_corridor',
          'Deep-space corridor: cool blue/violet starfield, drifting nebula haze, a glowing probe with an engine trail, and rings that swell toward the camera.',
        ),
        look(
          'boost_burn',
          'Boost state: a warm amber flare at the frame edges, a longer thruster plume and a faster star rush as the probe accelerates.',
        ),
      ],
      transitions: [],
    },
    assets: sound.assets,
    bindings: {},
    sources: [
      {
        id: 'src_playable',
        kind: 'browser', output: 'picture',
        entry: 'playable.html',
        resources: [],
        bindings: [],
        // The page itself owns its defaults; these params keep the authored
        // look explicit and stable across a future recorded-input revision.
        params: {
          title: 'ORBITAL NAVIGATOR',
          palette: ORBITAL,
          baseSpeed: 6.5,
          boostSpeed: 12.5,
        },
        seed: SEED,
        frames: FRAMES,
      },
    ],
    composition: {
      output: { width: WIDTH, height: HEIGHT, fps, sampleRate: SAMPLE_RATE, channels: CHANNELS },
      scenes: [
        {
          id: 'scene_course',
          description: 'One continuous flight down the corridor: the probe threads rings and dodges asteroids.',
        },
      ],
      shots: [
        {
          id: 'shot_course',
          scene: 'scene_course',
          look: 'deep_corridor',
          intent:
            'The probe flies the seeded corridor; rings and asteroids pass and resolve against the probe, raising or costing score.',
          targetFrames: FRAMES,
        },
      ],
      placements: [
        {
          id: 'pl_course',
          shot: 'shot_course',
          source: 'src_playable',
          inFrame: 0,
          outFrame: FRAMES,
          startFrame: 0,
          audio: 'mute',
        },
      ],
      transitions: [],
      audio: sound.audio,
    },
  };
  return { project, signals: sound.signals };
}

function slugToId(name) {
  const cleaned =
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'study';
  const safe = /^[a-z0-9]/.test(cleaned) ? cleaned : 'p-' + cleaned;
  return ('playable-' + safe).slice(0, 96);
}

async function main() {
  const dirArg = process.argv[2];
  if (!dirArg || dirArg === '--help' || dirArg === '-h') {
    fail('usage: node tests/fixtures/authoring/create-playable.mjs <new-project-directory>');
  }
  if (!(await exists(SOURCE_HTML))) fail('playable.html is missing next to this script (' + SOURCE_HTML + ')');

  const runtime = await loadRuntime();
  const { validateProject, framesToSamples } = runtime ?? {};
  if (typeof validateProject !== 'function' || typeof framesToSamples !== 'function') {
    fail('the built runtime is missing required exports (validateProject, framesToSamples); run `npm run build`');
  }

  const dir = resolve(dirArg);
  const projectJson = join(dir, 'project.json');
  const htmlDest = join(dir, 'playable.html');
  if (await exists(projectJson)) fail('refusing to overwrite existing ' + projectJson);
  if (await exists(htmlDest)) fail('refusing to overwrite existing ' + htmlDest);

  const id = slugToId(basename(dir));
  const { project, signals } = buildProject(id, framesToSamples);
  try {
    validateProject(project);
  } catch (error) {
    fail('generated project failed validation: ' + messageOf(error));
  }
  for (const signal of signals) {
    if (await exists(join(dir, signal.path))) fail('refusing to overwrite existing ' + join(dir, signal.path));
  }

  await mkdir(dir, { recursive: true });
  await copyFile(SOURCE_HTML, htmlDest, constants.COPYFILE_EXCL);
  for (const signal of signals) await writeFile(join(dir, signal.path), signal.bytes, { flag: 'wx' });
  // Exclusive create: never clobber a file that appeared after the checks above.
  await writeFile(projectJson, JSON.stringify(project, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });

  console.log('created project: ' + projectJson);
  console.log('  title        : ' + project.title);
  console.log('  output       : ' + WIDTH + 'x' + HEIGHT + ' @ ' + FPS + 'fps, ' + DURATION_SECONDS + 's');
  console.log('  source       : 1 code source (entry playable.html, seed ' + SEED + ', ' + FRAMES + ' frames)');
  console.log(
    '  scene/shot   : ' +
      project.composition.scenes.length +
      ' scene, ' +
      project.composition.shots.length +
      ' shot, ' +
      project.composition.placements.length +
      ' placement (frames 0–' +
      FRAMES +
      ')',
  );
  console.log(
    '  audio clips  : ' + project.composition.audio.length + ' PCM signal assets @ ' + SAMPLE_RATE + 'Hz stereo',
  );
  console.log('  play         : open ' + htmlDest + ' in a browser — ◀ ▶ steer, ▲/Space boost, R reset');
  console.log('');
  console.log('next:');
  console.log('  npm run build');
  console.log('  node dist/src/cli.js doctor');
  console.log('  node dist/src/cli.js build ' + dir);
  console.log('  node dist/src/cli.js status ' + dir);
}

main().catch(err => fail(messageOf(err)));
