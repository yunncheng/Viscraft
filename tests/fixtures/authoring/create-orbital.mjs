#!/usr/bin/env node
/*
 * Viscraft technical fixture: re-author a reference edit's *timing* as a new, original
 * code-authored Project.
 *
 *   node tests/fixtures/authoring/create-orbital.mjs <reference-report.json> <new-project-directory>
 *
 * What this does (and deliberately does NOT do):
 *
 *   - It reads a ReferenceReport produced by the runtime's reference analyzer
 *     (`analyzeReference` in src/operations/analysis/reference.ts). `report.segments` are OUTPUT
 *     composition-timeline frame intervals at `report.fps` (they tile
 *     [0, totalOutputFrames)), so they are fed straight into this Project's
 *     timing with no additional timescale conversion.
 *   - Every reference segment becomes one `browser` picture Source. Each source renders
 *     `orbital.html` with its own seed and an explicit
 *     `{ layout, variant, globalStartFrame, segmentFrames }` binding, so the new
 *     subject matches the reference's incoming/outgoing *cut rhythm* while being
 *     wholly re-drawn orbital geometry.
 *   - It NEVER copies the reference material, never lists its path as project
 *     content, and never pretends to recover the reference's original editable
 *     source. Only the non-secret content hash and the timing are retained, and
 *     the reference file itself stays opaque to this project.
 *   - The retained cut grid is *heuristic guidance for timing only* (FFmpeg
 *     scene-score candidates, not editorial truth). If the report's source is
 *     marked `simulated`, that means the analysed MATERIAL was simulated/test-only;
 *     the timestamp measurement itself is real. This project's imagery is
 *     independently authored code either way — no model and no reference pixels.
 *
 * Output is a fixed, deterministic smoke configuration: 640x360, the report's
 * rational fps, 48 kHz stereo. Audio is authored as real PCM signal files
 * scheduled on rational frame boundaries (no captured WebAudio, no Runtime
 * tone synthesis).
 *
 * The runtime must be built (`npm run build`); this script imports its canonical
 * `ReferenceReportSchema`, `framesToSamples` and `validateProject` rather than
 * duplicating any schema or clock conversion. It refuses to overwrite an
 * existing <new-project-directory>/project.json or orbital.html.
 */
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSignalAsset } from './lib/audio-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_HTML = join(HERE, 'orbital.html');

// --- fixed smoke-test configuration ---
const WIDTH = 640;
const HEIGHT = 360;
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const MAX_TOTAL_FRAMES = 18000; // upper bound on re-authored output length

const PALETTE = ['#ffd166', '#ff8f5a', '#4dabf7', '#b28dff', '#7cf0ff'];
// Layouts are cycled across segments so consecutive shots read as genuinely
// different camera arrangements of the same subject rather than a repeat.
const LAYOUT_ROTATION = ['orbital', 'solar', 'eclipsing', 'spiral', 'binary', 'lockup'];
const SCALE = [523.25, 587.33, 659.25, 783.99, 880.0]; // C5 D5 E5 G5 A5

function fail(message) {
  console.error('create-orbital: ' + message);
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

/**
 * Load the single canonical runtime. This script intentionally has no fallback
 * schema or clock conversion: if the package is not built the failure is loud
 * and actionable, so the generated Project can never drift from the runtime's
 * own contract.
 */
async function loadRuntime() {
  try {
    return await import(new URL('../../../dist/src/index.js', import.meta.url));
  } catch (error) {
    fail('the Viscraft runtime is not built or not importable; run `npm run build` first (' + messageOf(error) + ')');
  }
}

// --- audio ------------------------------------------------------------------
function buildAudio(framesToSamples, fps, segments, totalFrames, sceneStarts, beatFrames) {
  const totalSamples = framesToSamples(totalFrames, fps, SAMPLE_RATE, 'ceil');
  const audio = [];
  const assets = [];
  const signals = [];
  const seen = new Set();

  // A signal spanning [startFrame, startFrame+lenFrames); clipped so it never runs
  // past the composition, and with fades that always fit inside the clip.
  const addTone = (id, frequency, waveform, startFrame, lenFrames, gain, fadeInFrames, fadeOutFrames) => {
    if (seen.has(id)) throw new Error(`duplicate audio id ${id}`);
    let start = framesToSamples(startFrame, fps, SAMPLE_RATE, 'nearest');
    let end = framesToSamples(startFrame + lenFrames, fps, SAMPLE_RATE, 'nearest');
    if (start >= totalSamples) return;
    if (end > totalSamples) end = totalSamples;
    const durationSamples = end - start;
    if (durationSamples <= 0) return;
    let fadeIn = Math.max(0, framesToSamples(fadeInFrames, fps, SAMPLE_RATE, 'nearest'));
    let fadeOut = Math.max(0, framesToSamples(fadeOutFrames, fps, SAMPLE_RATE, 'nearest'));
    if (fadeIn + fadeOut > durationSamples) {
      const k = durationSamples / (fadeIn + fadeOut);
      fadeIn = Math.floor(fadeIn * k);
      fadeOut = durationSamples - fadeIn;
    }
    seen.add(id);
    // One real PCM file per cue; the clip keeps the authored start/level/fades.
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
      startSample: start,
      durationSamples,
      gain,
      fadeInSamples: fadeIn,
      fadeOutSamples: fadeOut,
    });
  };

  // 1. One accented thump + bright tick on every cut (segment start).
  segments.forEach((segment, i) => {
    addTone(`cut_low_${String(i).padStart(2, '0')}`, 82.41, 'sine', segment.startFrame, beatFrames, 0.3, 1, beatFrames);
    addTone(
      `cut_tick_${String(i).padStart(2, '0')}`,
      SCALE[(i * 2) % SCALE.length] * 2,
      'triangle',
      segment.startFrame,
      Math.max(1, Math.round(beatFrames / 2)),
      0.16,
      1,
      Math.round(beatFrames / 2),
    );
  });

  // 2. A low pad bed under each scene so the piece is layered, not just clicks.
  sceneStarts.forEach((start, i) => {
    const next = sceneStarts[i + 1] ?? totalFrames;
    const span = Math.max(1, next - start);
    addTone(
      `pad_${String(i).padStart(2, '0')}`,
      65.41,
      'sine',
      start,
      span,
      0.06,
      Math.round(span * 0.25),
      Math.round(span * 0.4),
    );
  });

  // 3. One musical tick per beat, plus a final accent landing on the last beat.
  const beats = Math.floor((totalFrames - 1) / beatFrames);
  for (let b = 1; b < beats; b++) {
    addTone(
      `beat_${String(b).padStart(3, '0')}`,
      SCALE[b % SCALE.length],
      b % 2 === 0 ? 'triangle' : 'sine',
      b * beatFrames,
      Math.max(1, Math.round(beatFrames * 0.32)),
      0.11,
      1,
      Math.round(beatFrames * 0.28),
    );
  }
  addTone(
    'accent_final',
    SCALE[0] * 2,
    'triangle',
    Math.max(0, totalFrames - beatFrames),
    beatFrames,
    0.2,
    1,
    Math.round(beatFrames * 0.8),
  );

  return { audio, assets, signals };
}

// --- project ------------------------------------------------------------------
function sceneIndexFor(i, segmentCount, sceneCount) {
  return Math.min(sceneCount - 1, Math.floor((i * sceneCount) / segmentCount));
}

function lookFor(layout) {
  if (layout === 'lockup') return 'orbital_emblem';
  if (layout === 'solar' || layout === 'eclipsing') return 'solar_flare';
  return 'deep_field';
}

function buildProject(id, report, segments, totalFrames, framesToSamples) {
  const fps = { numerator: report.fps.numerator, denominator: report.fps.denominator };
  const n = segments.length;
  // Cap the montage at three parts; fewer segments simply yield fewer scenes so
  // no part is a phantom with no shot.
  const sceneCount = Math.max(1, Math.min(3, n));
  const beatFrames = Math.max(1, Math.round(fps.numerator / fps.denominator / 2)); // 120 BPM

  const baseSeed = parseInt(report.source.sha256.slice(0, 8), 16) >>> 0;

  // scenes + their start frames (for the audio pad beds)
  const sceneStarts = [];
  const scenes = [];
  for (let s = 0; s < sceneCount; s++) {
    const first = segments.findIndex((_, i) => sceneIndexFor(i, n, sceneCount) === s);
    sceneStarts[s] = first >= 0 ? segments[first].startFrame : 0;
    scenes.push({
      id: `scene_${String(s + 1).padStart(2, '0')}`,
      description: `Montage part ${s + 1} of ${sceneCount}: shots re-cut from the retained reference grid onto new orbital geometry.`,
    });
  }

  const sources = segments.map((segment, i) => {
    const layout = LAYOUT_ROTATION[i % LAYOUT_ROTATION.length];
    const frames = segment.endFrame - segment.startFrame;
    return {
      id: `src_seg_${String(i + 1).padStart(2, '0')}`,
      kind: 'browser', output: 'picture',
      entry: 'orbital.html',
      resources: [],
      bindings: [],
      params: {
        layout,
        variant: i % 4,
        globalStartFrame: segment.startFrame,
        segmentFrames: frames,
        duration: (frames * fps.denominator) / fps.numerator,
        palette: PALETTE,
        intensity: 1,
        // Non-secret provenance only: the reference material's content hash and
        // the fact its source was marked simulated. Never the reference path —
        // this project cannot and does not reconstruct that material.
        referenceSha: report.source.sha256,
        referenceSimulated: report.source.simulated,
      },
      seed: (baseSeed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0,
      frames,
    };
  });

  const shots = segments.map((segment, i) => {
    const layout = LAYOUT_ROTATION[i % LAYOUT_ROTATION.length];
    const frames = segment.endFrame - segment.startFrame;
    return {
      id: `shot_seg_${String(i + 1).padStart(2, '0')}`,
      scene: scenes[sceneIndexFor(i, n, sceneCount)].id,
      look: lookFor(layout),
      intent: `Retained reference cut ${i + 1} (${frames} frames, a heuristic candidate): a ${layout} arrangement replaces the source imagery.`,
      targetFrames: frames,
    };
  });

  const placements = segments.map((segment, i) => ({
    id: `pl_seg_${String(i + 1).padStart(2, '0')}`,
    shot: shots[i].id,
    source: sources[i].id,
    inFrame: 0,
    outFrame: segment.endFrame - segment.startFrame,
    startFrame: segment.startFrame,
    audio: 'mute',
  }));

  const simulatedNote = report.source.simulated
    ? ' The reference source was marked simulated/test-only, so its measured timing comes from simulated material; the analysis itself is a real timestamp measurement.'
    : ' The reference source was not marked simulated; its timing was measured from the reference material, which stays opaque to this project.';

  const sound = buildAudio(framesToSamples, fps, segments, totalFrames, sceneStarts, beatFrames);
  const project = {
    schemaVersion: 1,
    id,
    revision: 1,
    title: 'ORBITAL — re-authored from reference timing',
    direction: {
      intent:
        'A code-only piece that re-authors the *timing* of a reference edit. ' +
        'The reference cut grid is used as heuristic guidance for timing only — it is not a description of the reference content, it is not editorial truth, ' +
        'and none of the reference imagery is reproduced. Every reference segment boundary becomes a placement boundary here, so the piece inherits the reference ' +
        'cut rhythm, while the reference subject is replaced completely by original orbital geometry drawn in code: seeded starfields, orbit rings, body trails, ' +
        'corona glow and multiple camera arrangements. Consecutive segments change layout, composition and palette so the retained cuts read as an intentional ' +
        'montage of one continuous subject. The reference material is never copied, loaded or reconstructed; only its non-secret content hash and segment timing ' +
        "are kept. This project's imagery is authored independently in code, with no generative model and no pixels imported from the reference." +
        simulatedNote,
      looks: [
        { id: 'deep_field', description: 'Deep-field starscape with orbit rings, body trails and a debris belt.' },
        { id: 'solar_flare', description: 'A dominant star with corona rays, a debris belt and a foreground transit.' },
        {
          id: 'orbital_emblem',
          description: 'Concentric orbital rings form a geometric emblem in place of a wordmark.',
        },
      ],
      transitions: [],
    },
    assets: sound.assets,
    bindings: {},
    sources,
    composition: {
      output: { width: WIDTH, height: HEIGHT, fps, sampleRate: SAMPLE_RATE, channels: CHANNELS },
      scenes,
      shots,
      placements,
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
  return ('orbital-' + safe).slice(0, 96);
}

async function main() {
  const [reportArg, dirArg] = process.argv.slice(2);
  if (!reportArg || reportArg === '--help' || reportArg === '-h' || !dirArg) {
    fail('usage: node tests/fixtures/authoring/create-orbital.mjs <reference-report.json> <new-project-directory>');
  }
  if (!(await exists(SOURCE_HTML))) fail('orbital.html is missing next to this script (' + SOURCE_HTML + ')');

  const runtime = await loadRuntime();
  const { ReferenceReportSchema, framesToSamples, validateProject } = runtime ?? {};
  if (
    typeof ReferenceReportSchema?.parse !== 'function' ||
    typeof framesToSamples !== 'function' ||
    typeof validateProject !== 'function'
  ) {
    fail(
      'the built runtime is missing required exports (ReferenceReportSchema, framesToSamples, validateProject); run `npm run build`',
    );
  }

  const reportPath = resolve(reportArg);
  if (!(await exists(reportPath))) fail('reference report not found: ' + reportPath);

  let raw;
  try {
    raw = JSON.parse(await readFile(reportPath, 'utf8'));
  } catch (error) {
    fail('could not read reference report: ' + messageOf(error));
  }

  // Canonical validation is the single source of truth for report shape and
  // referential integrity (cuts/frames/reviewFrames against the source clock).
  const parsed = ReferenceReportSchema.safeParse(raw);
  if (!parsed.success) {
    fail(
      'reference report is not a valid ReferenceReport: ' +
        parsed.error.issues.map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; '),
    );
  }
  const report = parsed.data;
  const segments = report.segments.map(segment => ({ startFrame: segment.startFrame, endFrame: segment.endFrame }));
  const totalFrames = segments[segments.length - 1].endFrame;
  if (totalFrames > MAX_TOTAL_FRAMES)
    fail(`reference timeline is ${totalFrames} output frames, exceeding the ${MAX_TOTAL_FRAMES}-frame bound`);

  const dir = resolve(dirArg);
  const projectJson = join(dir, 'project.json');
  const htmlDest = join(dir, 'orbital.html');
  if (await exists(projectJson)) fail('refusing to overwrite existing ' + projectJson);
  if (await exists(htmlDest)) fail('refusing to overwrite existing ' + htmlDest);

  const id = slugToId(basename(dir));
  const { project, signals } = buildProject(id, report, segments, totalFrames, framesToSamples);
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

  const seconds = (totalFrames * report.fps.denominator) / report.fps.numerator;
  console.log('created project: ' + projectJson);
  console.log('  title        : ' + project.title);
  console.log(
    '  output       : ' +
      WIDTH +
      'x' +
      HEIGHT +
      ' @ ' +
      report.fps.numerator +
      '/' +
      report.fps.denominator +
      'fps, ' +
      seconds.toFixed(3) +
      's',
  );
  console.log(
    '  reference    : sha256 ' +
      report.source.sha256.slice(0, 12) +
      '… origin=' +
      report.source.origin +
      (report.source.simulated ? ' (simulated source material)' : '') +
      ' — material not copied',
  );
  console.log(
    '  segments     : ' + segments.length + ' → ' + project.sources.length + ' code sources (entry orbital.html)',
  );
  console.log(
    '  scenes/shots : ' +
      project.composition.scenes.length +
      ' scenes, ' +
      project.composition.shots.length +
      ' shots, ' +
      project.composition.placements.length +
      ' placements',
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

main().catch(err => fail(messageOf(err)));
