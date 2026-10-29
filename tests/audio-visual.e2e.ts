/**
 * End-to-end audio-directed visual verification.
 *
 * A real, original PCM16 WAV is analyzed with the canonical
 * `analyzeAudioReference` heuristic, then the generic authoring example
 * (`tests/fixtures/authoring/create-audio-visual.mjs` + `audio-visual.html`) turns the
 * *reported* sample onsets into a multi-shot Canvas visual whose soundtrack is
 * the actual trimmed input audio clip (never a synthesized stand-in). The
 * normal Build then produces real frames + audio.
 *
 * Three independent tests cover the capability path:
 *
 *  1. author -> normal Build -> direct `captureCode`:
 *       - the analyzer report is honest and sample-exact;
 *       - the example copies the real WAV, trims it with the canonical clock
 *         (`framesToSamples`), and registers it with the caller rights;
 *       - each shot's code params carry only the onsets inside its own cut,
 *         as `{frame: reportedOutputFrame - cutStart, sample, strength}`;
 *       - a real Browser capture shows the pulse at the onset integer frame
 *         (adjacent non-event/event frames differ at the known wave origin);
 *       - the kept soundtrack peaks at the trim-relative onset sample, proving
 *         the sound is the real input audio and not an invented beat.
 *  2. scoped edit reuse + delivery:
 *       - changing one Source mode/palette recaptures only that shot and keeps
 *         the mixed audio; changing only the sound gain keeps every code Take
 *         plus `compose-video` while re-running `mix-audio`/`mux-final`;
 *       - a simulated report source propagates an honest simulated marker;
 *       - delivery reopens as a disposable copy and rebuilds with full reuse;
 *         caller rights are never rewritten.
 *  3. boundaries: tampered audio hash, incompatible fps/rate, unknown or
 *     out-of-bounds selected onsets, invalid cuts, a non-PCM-WAV source and an
 *     existing target path are all refused *before* anything is created, and
 *     the example never claims a provider or a codec.
 */

import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { analyzeAudioReference } from '../src/operations/analysis/audio-reference.js';
import { buildProject } from '../src/build/build.js';
import { captureCode, type CaptureBinding } from '../src/backends/browser/capture.js';
import { deliverProject } from '../src/operations/delivery/delivery.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { loadProject, resolveSourceBindings, saveProject } from '../src/project/project.js';
import {
  AudioReferenceSchema,
  ProjectSchema,
  type AudioReference,
  type Fps,
  type Project,
} from '../src/core/schema.js';
import { framesToSamples } from '../src/core/time.js';

// ---------------------------------------------------------------------------
// Agreed example contract (tests/fixtures/authoring/create-audio-visual.mjs)
// ---------------------------------------------------------------------------

const RIGHTS = { origin: 'original test fixture', license: 'original test fixture', redistributable: true } as const;
const FPS: Fps = { numerator: 30, denominator: 1 };
const SAMPLE_RATE = 48000 as const;
const OUTPUT = { width: 64, height: 48, fps: FPS, sampleRate: SAMPLE_RATE, channels: 2 as const };
/** Visual modes cycle per shot in this exact order. */
const MODES = ['ripples', 'spokes', 'tiles'] as const;
const PALETTE = { background: '#101418', foreground: '#e8e8f0', accent: '#38d6ff' };

/** Pulses start on exact frame boundaries so their reported output frames are integers. */
const PULSE_START_FRAMES = [6, 15, 24];
const PULSE_SAMPLES = PULSE_START_FRAMES.map(frame => frame * framesToSamples(1, FPS, SAMPLE_RATE));
const PULSE_LENGTH_SAMPLES = 2400;

const IN_FRAME = 4;
const OUT_FRAME = 28;
const CUTS = [12, 20];
/** Boundaries [inFrame, ...cuts, outFrame] split the trim into equal 8-frame shots. */
const SHOT_BOUNDARIES = [IN_FRAME, ...CUTS, OUT_FRAME];

// ---------------------------------------------------------------------------
// Minimal PCM16 WAV fixture writer (mono, dependency-free)
// ---------------------------------------------------------------------------

function wavPcm16Mono(sampleRate: number, totalSamples: number, fill: (index: number) => number): Buffer {
  const data = Buffer.alloc(totalSamples * 2);
  for (let i = 0; i < totalSamples; i++) {
    const value = Math.max(-1, Math.min(1, fill(i)));
    data.writeInt16LE(Math.round(value * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function writePulsesWav(path: string, sampleRate: number, totalSamples: number, starts: number[]): Promise<void> {
  const buffer = wavPcm16Mono(sampleRate, totalSamples, index => {
    for (const start of starts) {
      if (index >= start && index < start + PULSE_LENGTH_SAMPLES) {
        return Math.sin((2 * Math.PI * 440 * (index - start)) / sampleRate) * 0.8;
      }
    }
    return 0;
  });
  await writeFile(path, buffer);
}

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

/** A minimal but valid seed Project the canonical analyzer can read. */
function seedProject(assets: Project['assets'] = []): Project {
  const frames = 30;
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'audio_visual_seed',
    revision: 1,
    title: 'Audio visual seed',
    direction: { intent: 'seed', looks: [{ id: 'look_main', description: 'seed' }], transitions: [] },
    assets,
    bindings: {},
    sources: [
      { id: 'src_sim', kind: 'simulated', prompt: 'seed', frames, seed: 0, attempt: 'attempt_1', behavior: 'success' },
    ],
    composition: {
      output: { ...OUTPUT },
      scenes: [{ id: 'scene_1', description: 'scene' }],
      shots: [{ id: 'shot_1', scene: 'scene_1', look: 'look_main', intent: 'seed', targetFrames: frames }],
      placements: [
        {
          id: 'place_1',
          shot: 'shot_1',
          source: 'src_sim',
          inFrame: 0,
          outFrame: frames,
          startFrame: 0,
          audio: 'mute',
        },
      ],
      transitions: [],
      audio: [],
    },
  });
}

async function writeProject(root: string, project: Project): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
}

interface AuthorConfig {
  report: string;
  audio: string;
  rights: { origin: string; license: string; redistributable: boolean };
  output: typeof OUTPUT;
  inFrame: number;
  outFrame: number;
  cuts: number[];
  selectedOnsetSamples: number[];
  gain?: number;
  palette?: typeof PALETTE;
}

function runAuthor(target: string, configPath: string): Promise<string> {
  return runCommand(process.execPath, [
    resolve('tests/fixtures/authoring/create-audio-visual.mjs'),
    target,
    configPath,
  ]);
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function codeSource(project: Project, id: string) {
  const source = project.sources.find(candidate => candidate.id === id);
  if (!source || source.kind !== 'browser' || source.output !== 'picture')
    throw new Error(`expected a code Source ${id}`);
  return source;
}

async function decodeRGBA(file: string, width: number, height: number): Promise<Buffer> {
  const out = `${file}.decoded.rgba`;
  await runCommand('ffmpeg', ['-v', 'error', '-y', '-i', file, '-pix_fmt', 'rgba', '-f', 'rawvideo', out]);
  const raw = await readFile(out);
  assert.equal(raw.length, width * height * 4, `decoded ${file} must be a ${width}x${height} RGBA frame`);
  return raw;
}

function rgbaPixel(buffer: Buffer, width: number, x: number, y: number): [number, number, number, number] {
  const offset = (y * width + x) * 4;
  return [buffer[offset], buffer[offset + 1], buffer[offset + 2], buffer[offset + 3]];
}

/** Decode a movie's audio to mono f32le so we can measure the real waveform. */
async function decodeMonoF32(file: string): Promise<Float32Array> {
  const out = `${file}.decoded.f32le`;
  await runCommand('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-i',
    file,
    '-vn',
    '-f',
    'f32le',
    '-acodec',
    'pcm_f32le',
    '-ac',
    '1',
    out,
  ]);
  const raw = await readFile(out);
  const total = Math.floor(raw.length / 4);
  const samples = new Float32Array(total);
  for (let i = 0; i < total; i++) samples[i] = raw.readFloatLE(i * 4);
  return samples;
}

/** Index of the maximum |amplitude| inside [from, to). */
function peakIndex(samples: Float32Array, from: number, to: number): number {
  let best = from;
  let bestValue = -1;
  for (let i = Math.max(0, from); i < Math.min(samples.length, to); i++) {
    const value = Math.abs(samples[i]);
    if (value > bestValue) {
      bestValue = value;
      best = i;
    }
  }
  return best;
}

/**
 * Author one reference fixture set: a real WAV, a matching canonical report,
 * and a config that trims a nonzero window with caller-chosen cuts. Returns the
 * fixtures directory plus the parsed report.
 */
async function makeFixture(
  configDir: string,
  options: {
    seedAssets?: Project['assets'];
    fps?: Fps;
    sampleRate?: 44100 | 48000;
    starts?: number[];
    totalSamples?: number;
  } = {},
) {
  const starts = options.starts ?? PULSE_SAMPLES;
  const sampleRate = options.sampleRate ?? SAMPLE_RATE;
  const fps = options.fps ?? FPS;
  const totalSamples = options.totalSamples ?? framesToSamples(OUT_FRAME, fps, sampleRate) + sampleRate;
  await mkdir(configDir, { recursive: true });

  // Seed Project the analyzer reads (never mutated), then analyze the real WAV.
  const seedDir = join(configDir, 'seed');
  await writeProject(seedDir, seedProject(options.seedAssets ?? []));
  await mkdir(join(seedDir, 'refs'), { recursive: true });
  await writePulsesWav(join(seedDir, 'refs', 'pulses.wav'), sampleRate, totalSamples, starts);
  const report = await analyzeAudioReference(seedDir, 'refs/pulses.wav', { fps: options.fps ?? FPS, sampleRate });

  // Copy the exact analyzed bytes next to the config; the example re-hashes them.
  const audio = join(configDir, 'pulses.wav');
  await writeFile(audio, await readFile(join(seedDir, 'refs', 'pulses.wav')));
  await writeJson(join(configDir, 'report.json'), report);
  assert.equal(await hashFile(audio), report.source.sha256, 'the copied audio must hash to the analyzed source');
  assert.deepEqual(AudioReferenceSchema.parse(report), report, 'report must satisfy the canonical schema');
  return { report, audio };
}

function baseConfig(overrides: Partial<AuthorConfig> & Pick<AuthorConfig, 'report' | 'audio'>): AuthorConfig {
  return {
    rights: { ...RIGHTS },
    output: { ...OUTPUT },
    inFrame: IN_FRAME,
    outFrame: OUT_FRAME,
    cuts: [...CUTS],
    selectedOnsetSamples: [...PULSE_SAMPLES],
    palette: { ...PALETTE },
    ...overrides,
  };
}

/** The reported onsets whose sample falls inside a [inFrame, outFrame) trim. */
function onsetsInside(report: AudioReference, inFrame: number, outFrame: number): AudioReference['onsets'] {
  const start = framesToSamples(inFrame, report.fps, report.sampleRate);
  const end = framesToSamples(outFrame, report.fps, report.sampleRate);
  return report.onsets.filter(onset => onset.sample >= start && onset.sample < end);
}

// ---------------------------------------------------------------------------
// 1. Real onsets -> params -> real frames + kept soundtrack
// ---------------------------------------------------------------------------

test('a reported WAV drives real onset pixels and keeps the trimmed soundtrack', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-audio-visual-capture-'));
  try {
    const fixtures = join(root, 'fixtures');
    const project = join(root, 'project');
    const { report } = await makeFixture(fixtures);

    // The analyzer is honest: three pulses at exact sample positions/frames.
    const insideOnsets = onsetsInside(report, IN_FRAME, OUT_FRAME);
    assert.deepEqual(
      insideOnsets.map(onset => onset.sample),
      PULSE_SAMPLES,
      'all three pulses are real onsets inside the trim',
    );

    await writeJson(join(fixtures, 'config.json'), baseConfig({ report: 'report.json', audio: 'pulses.wav' }));
    const stdout = await runAuthor(project, join(fixtures, 'config.json'));
    const authored = JSON.parse(stdout) as Record<string, unknown>;
    assert.equal(authored.authored, true);
    assert.equal(authored.provider ?? null, null, 'authoring must not claim a generation provider');

    // The example's own reported timing: localFrame = report.outputFrame - shot.globalStartFrame.
    const shotsOut = authored.shots as Array<{
      id: string;
      mode: string;
      globalStartFrame: number;
      startFrame: number;
      sourceFrames: number;
      events: number;
    }>;
    const selectedOut = authored.selectedEvents as Array<{
      shot: string;
      localFrame: number;
      sample: number;
      outputFrame: number;
      strength: number;
    }>;
    assert.equal(shotsOut.length, SHOT_BOUNDARIES.length - 1, 'one reported shot per cut');
    for (const [index, shot] of shotsOut.entries()) {
      assert.equal(shot.id, `shot-${index + 1}`);
      assert.equal(shot.mode, MODES[index % MODES.length]);
      assert.equal(shot.globalStartFrame, SHOT_BOUNDARIES[index], 'globalStartFrame is the absolute shot start');
      assert.equal(shot.startFrame, SHOT_BOUNDARIES[index] - IN_FRAME);
      assert.equal(shot.sourceFrames, SHOT_BOUNDARIES[index + 1] - SHOT_BOUNDARIES[index]);
    }
    assert.equal(selectedOut.length, PULSE_SAMPLES.length, 'every chosen onset must be reported once');
    const shotById = new Map(shotsOut.map(shot => [shot.id, shot]));
    const onsetBySample = new Map(report.onsets.map(onset => [onset.sample, onset]));
    for (const event of selectedOut) {
      const onset = onsetBySample.get(event.sample)!;
      const shot = shotById.get(event.shot)!;
      assert.equal(
        event.localFrame,
        onset.outputFrame - shot.globalStartFrame,
        'no seconds and no second time conversion',
      );
      assert.equal(event.outputFrame, onset.outputFrame, 'the reported source timing is unchanged');
      assert.equal(event.strength, onset.strength);
    }

    const authoredProject = await loadProject(project);

    // The soundtrack is the real approved audio, plus a hashed report-evidence asset.
    const clip = authoredProject.composition!.audio[0];
    assert.equal(authoredProject.composition!.audio.length, 1, 'the soundtrack is exactly one real audio clip');
    assert.equal(clip.kind, 'asset');
    const assetId = clip.kind === 'asset' ? clip.asset : undefined;
    assert.equal(assetId, 'track');
    const audioAsset = authoredProject.assets.find(candidate => candidate.id === 'track');
    assert.ok(audioAsset, 'the audio clip must reference the registered track');
    assert.equal(audioAsset!.path, 'assets/track.wav');
    assert.equal(audioAsset!.type, 'audio');
    assert.deepEqual(audioAsset!.rights, RIGHTS, 'caller rights must be recorded verbatim');
    assert.equal(audioAsset!.sha256, report.source.sha256, 'the asset must be the exact analyzed bytes');
    assert.equal(
      audioAsset!.simulated,
      report.source.simulated,
      'the asset simulation flag must mirror the report, not be invented',
    );
    assert.equal(
      await hashFile(join(project, audioAsset!.path)),
      report.source.sha256,
      'the copied WAV must be byte-identical',
    );

    // A second, code-typed evidence asset holds the canonical report JSON.
    const evidenceAsset = authoredProject.assets.find(candidate => candidate.id === 'audio-evidence');
    assert.ok(evidenceAsset, 'the report must be recorded as a real evidence asset');
    assert.equal(evidenceAsset!.type, 'code');
    assert.deepEqual(evidenceAsset!.rights, RIGHTS, 'the evidence asset must carry the caller rights');
    assert.equal(
      evidenceAsset!.simulated,
      report.source.simulated,
      'the evidence asset must mirror the report simulation',
    );
    assert.equal(
      await hashFile(join(project, evidenceAsset!.path)),
      evidenceAsset!.sha256,
      'the evidence hash must be the real written bytes',
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(project, evidenceAsset!.path), 'utf8')),
      report,
      'the evidence asset must be the canonical report, unmodified',
    );
    assert.deepEqual(authoredProject.bindings, { evidence: 'audio-evidence' });

    // Canonical trim arithmetic on the sample clock.
    const inSample = framesToSamples(IN_FRAME, FPS, SAMPLE_RATE);
    const durationSamples = framesToSamples(OUT_FRAME - IN_FRAME, FPS, SAMPLE_RATE, 'ceil');
    assert.ok(clip.kind === 'asset');
    assert.equal(clip.inSample, inSample, 'inSample must use the canonical framesToSamples clock');
    assert.equal(clip.startSample, 0);
    assert.equal(clip.durationSamples, durationSamples);
    assert.equal(clip.gain, 0.6, 'the example default sound gain is 0.6');
    assert.equal(clip.fadeInSamples, 0);
    assert.equal(clip.fadeOutSamples, 0);
    assert.ok(inSample + durationSamples <= report.samples, 'the trim must fit the analyzed samples');

    // One code Source per cut, with only its own onsets and the exact mapping.
    const placements = [...authoredProject.composition!.placements].sort((a, b) => a.startFrame - b.startFrame);
    assert.equal(placements.length, SHOT_BOUNDARIES.length - 1, 'one placement per cut');
    assert.ok(authoredProject.composition!.shots.length === placements.length);
    for (const [index, placement] of placements.entries()) {
      const cutStart = SHOT_BOUNDARIES[index];
      const frames = SHOT_BOUNDARIES[index + 1] - cutStart;
      const source = codeSource(authoredProject, placement.source!);
      assert.equal(source.entry, 'audio-visual.html');
      assert.equal(placement.inFrame, 0);
      assert.equal(placement.outFrame, frames);
      assert.equal(placement.startFrame, cutStart - IN_FRAME);
      assert.equal(placement.audio, 'mute', 'the code shots must not re-introduce source audio');
      assert.equal(source.frames, frames);
      const params = source.params as {
        frames: number;
        globalStartFrame: number;
        inFrame: number;
        sourceHash: string;
        mode: string;
        palette: unknown;
        events: Array<{ frame: number; sample: number; strength: number }>;
      };
      assert.equal(params.frames, frames);
      assert.equal(
        params.globalStartFrame,
        cutStart,
        'globalStartFrame is the absolute shot start on the report frame grid',
      );
      assert.equal(params.inFrame, IN_FRAME, 'the trim start is carried alongside for provenance');
      assert.equal(params.sourceHash, report.source.sha256);
      assert.equal(params.mode, MODES[index % MODES.length], 'visual modes cycle deterministically per shot');
      assert.deepEqual(params.palette, PALETTE, 'the caller palette must be recorded verbatim');

      const expected = report.onsets
        .filter(onset => onset.outputFrame >= cutStart && onset.outputFrame < SHOT_BOUNDARIES[index + 1])
        .map(onset => ({ frame: onset.outputFrame - cutStart, sample: onset.sample, strength: onset.strength }));
      assert.deepEqual(
        params.events,
        expected,
        `shot ${index + 1} must carry exactly its reported onsets as outputFrame - cutStart`,
      );

      // The Source binds only the code evidence asset, never the audio track, so a
      // sound edit cannot force a shot rebuild.
      const resolved = resolveSourceBindings(authoredProject, source);
      assert.deepEqual(
        resolved.map(({ binding, asset }) => [binding, asset.id]),
        [['evidence', 'audio-evidence']],
      );
      assert.ok(
        resolved.every(({ asset }) => asset.id !== 'track'),
        'the code Source must not bind the audio track',
      );
    }

    // Normal Build: real frames and a real, non-silent soundtrack.
    const build = await buildProject(project);
    assert.equal(build.status, 'succeeded');
    assert.equal(build.result!.simulated, false, 'an original WAV keeps the build non-simulated');
    const final = build.artifacts.find(artifact => artifact.id === build.result!.artifact)!;
    assert.equal(final.media!.frames, OUT_FRAME - IN_FRAME, 'the composition holds exactly the trimmed frame count');
    assert.ok(final.media!.audio, 'the delivered movie must carry the kept soundtrack');

    const samples = await decodeMonoF32(join(project, final.path));
    const onsetRelative = PULSE_SAMPLES[0] - inSample;
    const halfFrame = Math.round(framesToSamples(1, FPS, SAMPLE_RATE) / 2);
    const peak = peakIndex(samples, onsetRelative - halfFrame, onsetRelative + halfFrame);
    assert.ok(
      Math.abs(peak - onsetRelative) <= halfFrame,
      `the soundtrack must peak at the trim-relative onset sample (${onsetRelative} ± ${halfFrame}), got ${peak} — the audio is the real input, not a synthesized beat`,
    );

    // Direct Browser capture of the first (ripples) shot proves a real pulse.
    const source = codeSource(authoredProject, placements[0].source!);
    const framesDir = join(root, 'frames');
    const captureBindings = Object.fromEntries(
      resolveSourceBindings(authoredProject, source).map(({ binding, asset }) => [
        binding,
        { id: asset.id, path: asset.path, sha256: asset.sha256 },
      ]),
    ) as Record<string, CaptureBinding>;
    await captureCode(project, source, authoredProject.composition!.output, framesDir, captureBindings);
    const eventFrame = report.onsets.find(onset => onset.sample === PULSE_SAMPLES[0])!.outputFrame - SHOT_BOUNDARIES[0];
    assert.ok(
      eventFrame > 0 && eventFrame < source.frames - 1,
      'the chosen onset must have non-event neighbours inside the shot',
    );
    const event = await decodeRGBA(
      join(framesDir, `frame-${String(eventFrame).padStart(6, '0')}.png`),
      OUTPUT.width,
      OUTPUT.height,
    );
    const before = await decodeRGBA(
      join(framesDir, `frame-${String(eventFrame - 1).padStart(6, '0')}.png`),
      OUTPUT.width,
      OUTPUT.height,
    );
    const centerX = Math.floor(OUTPUT.width / 2);
    const centerY = Math.floor(OUTPUT.height / 2);
    // The center marker is drawn in every mode and at every frame, so this is NOT
    // an "is it lit" check: at the exact onset frame its composited alpha is 1.0
    // and its radius is ~4.2x the base, while one frame earlier the pulse is
    // absent (alpha 0.55, base radius), so the centre RGB must differ.
    assert.notDeepEqual(
      rgbaPixel(event, OUTPUT.width, centerX, centerY),
      rgbaPixel(before, OUTPUT.width, centerX, centerY),
      'the onset frame must visibly differ from its non-event neighbour at the wave origin',
    );
    assert.notDeepEqual(event, before, 'the whole onset frame must differ from a non-event frame');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Scoped edit reuse, simulation propagation and delivery
// ---------------------------------------------------------------------------

test('visual edits recapture one shot, sound-only edits keep every picture, and delivery reopens with reuse', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-audio-visual-reuse-'));
  try {
    const fixtures = join(root, 'fixtures');
    const project = join(root, 'project');
    await makeFixture(fixtures);
    await writeJson(join(fixtures, 'config.json'), baseConfig({ report: 'report.json', audio: 'pulses.wav' }));
    await runAuthor(project, join(fixtures, 'config.json'));

    const baseline = await loadProject(project);
    const baselineRights = structuredClone(baseline.assets.map(asset => asset.rights));
    const first = await buildProject(project);
    assert.equal(first.status, 'succeeded');
    const firstCode = first.operations.filter(operation => operation.kind === 'browser');
    assert.equal(firstCode.length, 3, 'one code operation per shot');

    // (a) Change one shot's visual mode: only that shot recaptures; audio is reused.
    const current = await loadProject(project);
    const edited = structuredClone(current);
    const target = codeSource(edited, 'shot-2');
    (target.params as { mode: string }).mode = 'tiles';
    await saveProject(project, edited, current.revision);

    const second = await buildProject(project);
    const secondCode = second.operations.filter(operation => operation.kind === 'browser');
    assert.equal(secondCode.filter(operation => operation.reused).length, 2, 'the untouched shots must be reused');
    const recaptured = secondCode.filter(operation => !operation.reused);
    assert.equal(recaptured.length, 1, 'only the edited shot may recapture');
    assert.equal(second.takes.find(take => take.artifact === recaptured[0].artifact)!.source, 'shot-2');
    assert.equal(
      second.operations.find(operation => operation.kind === 'mix-audio')!.reused,
      true,
      'editing a picture mode must not re-mix the sound',
    );
    assert.equal(
      second.operations.find(operation => operation.kind === 'compose-video')!.reused,
      false,
      'the recomposited picture changes',
    );
    const firstAudio = first.artifacts.find(artifact => artifact.operation === 'mix-audio')!;
    const secondAudio = second.artifacts.find(artifact => artifact.operation === 'mix-audio')!;
    assert.equal(secondAudio.id, firstAudio.id, 'the audio artifact must be byte-identical and reused');

    // (b) Change only the sound gain: every picture operation is reused, mix/mux re-run.
    const beforeGain = await loadProject(project);
    const gained = structuredClone(beforeGain);
    const gainClip = gained.composition!.audio[0];
    assert.ok(gainClip.kind === 'asset');
    gainClip.gain = 0.5;
    await saveProject(project, gained, beforeGain.revision);

    const third = await buildProject(project);
    assert.ok(
      third.operations.filter(operation => operation.kind === 'browser').every(operation => operation.reused),
      'a gain-only edit must reuse every code operation',
    );
    assert.equal(
      third.operations.find(operation => operation.kind === 'compose-video')!.reused,
      true,
      'a gain-only edit must reuse the composited picture',
    );
    assert.equal(
      third.operations.find(operation => operation.kind === 'mix-audio')!.reused,
      false,
      'the gain change must re-mix the audio',
    );
    assert.equal(
      third.operations.find(operation => operation.kind === 'mux-final')!.reused,
      false,
      'the mux must re-run after the new mix',
    );

    // (c) A simulated report source propagates an honest marker, never a provider claim.
    const simFixtures = join(root, 'sim-fixtures');
    const simSeedDir = join(simFixtures, 'seed');
    const simAudio = join(simFixtures, 'pulses.wav');
    await mkdir(simFixtures, { recursive: true });
    // Register the WAV as a simulated audio Asset *before* analysis so the report taints.
    await writePulsesWav(join(simFixtures, 'source.wav'), SAMPLE_RATE, SAMPLE_RATE, PULSE_SAMPLES);
    const simHash = await hashFile(join(simFixtures, 'source.wav'));
    await writeProject(
      simSeedDir,
      seedProject([
        {
          id: 'audio_ref',
          revision: 1,
          path: 'refs/pulses.wav',
          sha256: simHash,
          type: 'audio',
          rights: { ...RIGHTS },
          simulated: true,
        },
      ]),
    );
    await mkdir(join(simSeedDir, 'refs'), { recursive: true });
    await writeFile(join(simSeedDir, 'refs', 'pulses.wav'), await readFile(join(simFixtures, 'source.wav')));
    const simReport = await analyzeAudioReference(simSeedDir, 'refs/pulses.wav', { fps: FPS, sampleRate: SAMPLE_RATE });
    assert.equal(simReport.source.origin, 'asset');
    assert.equal(simReport.source.simulated, true, 'a simulated audio asset must taint the report');
    await writeFile(simAudio, await readFile(join(simFixtures, 'source.wav')));
    await writeJson(join(simFixtures, 'report.json'), simReport);
    await writeJson(join(simFixtures, 'config.json'), baseConfig({ report: 'report.json', audio: 'pulses.wav' }));
    const simProject = join(root, 'sim-project');
    await runAuthor(simProject, join(simFixtures, 'config.json'));
    const simLoaded = await loadProject(simProject);
    const simClip = simLoaded.composition!.audio[0];
    assert.ok(simClip.kind === 'asset');
    assert.equal(simClip.asset, 'track');
    assert.equal(
      simLoaded.assets.find(asset => asset.id === 'track')!.simulated,
      true,
      'the simulated report source must mark the authored track',
    );
    assert.equal(
      simLoaded.assets.find(asset => asset.id === 'audio-evidence')!.simulated,
      true,
      'the evidence asset must mirror the report simulation',
    );
    const simBuild = await buildProject(simProject);
    assert.equal(simBuild.result!.simulated, true, 'simulation provenance must reach the Build result');

    // (d) Delivery bundles the actual Build; the disposable copy rebuilds with reuse.
    const destination = join(root, 'bundle');
    const delivery = await deliverProject(project, destination, { review: true, stems: true });
    assert.equal(delivery.build, third.id);
    assert.equal(await hashFile(join(destination, 'movie', 'final.mp4')), delivery.movie!.sha256);

    const saved = await loadProject(project);
    assert.deepEqual(
      saved.assets.map(asset => asset.rights),
      baselineRights,
      'editing must never rewrite caller rights',
    );

    const disposable = join(root, 'disposable');
    await cp(join(destination, 'project'), disposable, { recursive: true });
    const reopened = await buildProject(disposable);
    assert.ok(
      reopened.operations.every(operation => operation.reused),
      'the exported project must rebuild with full reuse',
    );
    assert.equal(
      reopened.artifacts.find(artifact => artifact.id === reopened.result!.artifact)!.sha256,
      delivery.movie!.sha256,
      'the disposable export must reproduce the delivered movie',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Refusals happen before anything is created
// ---------------------------------------------------------------------------

test('the example refuses tampered, incompatible or out-of-range evidence before authoring', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-audio-visual-boundary-'));
  try {
    const fixtures = join(root, 'fixtures');
    const { report } = await makeFixture(fixtures);
    const goodConfig = join(fixtures, 'config.json');
    await writeJson(goodConfig, baseConfig({ report: 'report.json', audio: 'pulses.wav' }));

    // Each config is written beside the files it references: the example resolves
    // relative paths from the config file's directory, exactly as documented.
    const refused = async (
      projectDir: string,
      configDir: string,
      config: AuthorConfig,
      label: string,
    ): Promise<void> => {
      const configPath = join(configDir, `${label}.config.json`);
      await writeJson(configPath, config);
      await assert.rejects(runAuthor(projectDir, configPath), `expected a refusal for: ${label}`);
      assert.equal(
        await exists(join(projectDir, 'project.json')),
        false,
        `no project.json may be written for: ${label}`,
      );
    };

    // (a) A tampered audio file no longer matches the report hash.
    const tamperDir = join(root, 'tamper-fixtures');
    await makeFixture(tamperDir);
    const tampered = await readFile(join(tamperDir, 'pulses.wav'));
    tampered[tampered.length - 1] ^= 0xff;
    await writeFile(join(tamperDir, 'pulses.wav'), tampered);
    await refused(
      join(root, 'tamper-project'),
      tamperDir,
      baseConfig({ report: 'report.json', audio: 'pulses.wav' }),
      'tampered',
    );

    // (b) Incompatible fps: the report was mapped onto a different fps than the output.
    const fpsDir = join(root, 'fps-fixtures');
    const fpsFixture = await makeFixture(fpsDir, { fps: { numerator: 25, denominator: 1 } });
    await refused(
      join(root, 'fps-project'),
      fpsDir,
      baseConfig({
        report: 'report.json',
        audio: 'pulses.wav',
        selectedOnsetSamples: onsetsInside(fpsFixture.report, IN_FRAME, OUT_FRAME).map(onset => onset.sample),
      }),
      'fps',
    );

    // (c) Incompatible sample rate: report analyzed at 44.1 kHz, output at 48 kHz.
    const rateDir = join(root, 'rate-fixtures');
    const rateFixture = await makeFixture(rateDir, { sampleRate: 44100 });
    await refused(
      join(root, 'rate-project'),
      rateDir,
      baseConfig({
        report: 'report.json',
        audio: 'pulses.wav',
        selectedOnsetSamples: onsetsInside(rateFixture.report, IN_FRAME, OUT_FRAME).map(onset => onset.sample),
      }),
      'rate',
    );

    // (d) An unknown selected onset (inside the trim but not a reported onset).
    await refused(
      join(root, 'unknown-project'),
      fixtures,
      baseConfig({
        report: 'report.json',
        audio: 'pulses.wav',
        selectedOnsetSamples: [report.onsets[0].sample + 1920],
      }),
      'unknown',
    );

    // (e) An actual reported onset outside the chosen trim.
    await refused(
      join(root, 'bounds-project'),
      fixtures,
      baseConfig({
        report: 'report.json',
        audio: 'pulses.wav',
        inFrame: 10,
        outFrame: 28,
        cuts: [20],
        selectedOnsetSamples: [report.onsets[0].sample],
      }),
      'bounds',
    );

    // (f) Invalid cuts: below the trim start, beyond the trim end, and non-increasing.
    await refused(
      join(root, 'cut-low-project'),
      fixtures,
      baseConfig({ report: 'report.json', audio: 'pulses.wav', cuts: [2, 20] }),
      'cut-low',
    );
    await refused(
      join(root, 'cut-high-project'),
      fixtures,
      baseConfig({ report: 'report.json', audio: 'pulses.wav', cuts: [12, 40] }),
      'cut-high',
    );
    await refused(
      join(root, 'cut-order-project'),
      fixtures,
      baseConfig({ report: 'report.json', audio: 'pulses.wav', cuts: [20, 12] }),
      'cut-order',
    );

    // (g) A non-PCM-WAV source is refused, never silently reinterpreted.
    const mp4Dir = join(root, 'mp4-fixtures');
    await makeFixture(mp4Dir);
    await writeFile(
      join(mp4Dir, 'audio.mp4'),
      Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]),
    );
    await refused(join(root, 'mp4-project'), mp4Dir, baseConfig({ report: 'report.json', audio: 'audio.mp4' }), 'mp4');

    // (h) An existing target path is never overwritten.
    const keepDir = join(root, 'keep-project');
    await runAuthor(keepDir, goodConfig);
    const authoredHash = await hashFile(join(keepDir, 'project.json'));
    await assert.rejects(runAuthor(keepDir, goodConfig), 'the example must refuse to overwrite existing work');
    assert.equal(await hashFile(join(keepDir, 'project.json')), authoredHash, 'the existing project must be untouched');

    // (i) The authored project claims no provider and no fabricated provenance.
    const kept = await loadProject(keepDir);
    assert.ok(
      kept.sources.every(source => source.kind === 'browser'),
      'only local code Sources are authored',
    );
    assert.ok(
      kept.assets.every(asset => asset.derivedFrom === undefined),
      'no frame provenance is fabricated',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
