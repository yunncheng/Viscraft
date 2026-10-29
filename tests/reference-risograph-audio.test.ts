/**
 * Pure Node PCM: the risograph score/Foley truth, without Runtime authoring.
 *
 * These tests import the study's local ESM modules directly (action-facts,
 * score, foley) and inspect their descriptors and rendered float PCM. They do
 * not call authorProject, a Browser, a Build, FFmpeg or any WAV encoder.
 *
 * What is proved here:
 *  - the descriptor entries are the authored facts (blue/yellow/pink gates,
 *    the two action windows, guitar at 0.75, vibes at 1.5, the exact Foley map);
 *  - renderMusic/renderFoley fill the exact four-second span and report the
 *    ordinary rawPeak/normalizationScale facts (one whole-buffer peak
 *    normalization, not a limiter);
 *  - moving ONLY the riverside PRESS yellow gate from 0.75 to 1.0 moves the
 *    first guitar attack, while the pre-0.75 waveform is unchanged after the
 *    reported normalization scale is divided out;
 *  - disabling ONLY the action-space `actionGain` multiplier restores the
 *    selected stems to 1.0, proving the duck is causal; the pre/post-action
 *    waveform is unchanged after normalization.
 *
 * The two copies used for the edits are real byte copies (`fs.cp`, no
 * hardlinks) and are asserted to be independent inodes. A failure keeps its
 * temporary copies for diagnosis; success removes them.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const STUDY_DIR = resolve('skills/viscraft/assets/studies/code-visuals/risograph');
const SAMPLE_RATE = 48000;
const FRAMES = 192000; // 4 s at 48 kHz, per channel
const FPS = 24;

interface MusicEvent {
  time: number;
  duration: number;
  voice: string;
  midi?: number;
  gain: number;
  pan?: number;
}

interface MusicSection {
  id: string;
  start: number;
  end: number;
}

interface MusicScore {
  seconds: number;
  variant: string;
  events: MusicEvent[];
  sections: MusicSection[];
  spaces: Array<{ start: number; end: number; contact: number; kind: string; gain: number; scope: string[] }>;
  cues: Array<{ id: string; time: number }>;
}

interface FoleyEvent {
  time: number;
  duration: number;
  kind: string;
  gain: number;
  pan?: number;
}

interface FoleyScore {
  seconds: number;
  variant: string;
  events: FoleyEvent[];
  sections: MusicSection[];
  cues: Array<{ id: string; time: number }>;
}

interface RenderReport {
  peak: number;
  rawPeak: number;
  normalizationScale: number;
  normalizationTarget: number;
  normalizationTargetDbfs: number;
  /** Music reports rms; the Foley report intentionally does not. */
  rms?: number;
  [key: string]: unknown;
}

interface RenderedCue {
  channels: Float32Array[];
  report: RenderReport;
}

interface ScoreModule {
  buildMusic(params?: Record<string, unknown>): MusicScore;
  renderMusic(args: Record<string, unknown>): RenderedCue;
}

interface FoleyModule {
  buildFoley(params?: Record<string, unknown>): FoleyScore;
  renderFoley(args: Record<string, unknown>): RenderedCue;
}

interface FactsModule {
  RIDES: {
    riverside: { bell: { strike: number } };
    bakery: { bakery: { catchContact: number; stowContact: number }; pigeons: { start: number } };
  };
  actionAt: (
    variant: 'riverside' | 'bakery',
    seconds: number,
  ) => {
    stepped: number;
    bell: number;
    reach: number;
    caught: number;
    stowed: number;
    inBasket: boolean;
    contact: number;
  };
}

async function load<T>(directory: string, file: string): Promise<T> {
  return (await import(pathToFileURL(join(directory, file)).href)) as T;
}

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A copied file must be a real independent inode, never a hardlink. */
async function assertIndependentCopy(source: string, copy: string): Promise<void> {
  const [from, to] = await Promise.all([stat(source, { bigint: true }), stat(copy, { bigint: true })]);
  assert.notEqual(from.ino, to.ino, `${copy} must be an independent byte copy, not a hardlink`);
}

function window(start: number, end: number): [number, number] {
  return [Math.max(0, Math.floor(start * SAMPLE_RATE)), Math.min(FRAMES, Math.ceil(end * SAMPLE_RATE))];
}

function peakBetween(channels: Float32Array[], start: number, end: number): number {
  const [from, to] = window(start, end);
  return peakSamples(channels, from, to);
}

function peakSamples(channels: Float32Array[], from: number, to: number): number {
  let peak = 0;
  for (const channel of channels) for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(channel[i]));
  return peak;
}

function rmsBetween(channels: Float32Array[], start: number, end: number): number {
  const [from, to] = window(start, end);
  let sum = 0;
  let count = 0;
  for (const channel of channels) {
    for (let i = from; i < to; i++) {
      sum += channel[i] * channel[i];
      count++;
    }
  }
  return Math.sqrt(sum / Math.max(1, count));
}

/** Single-bin Goertzel magnitude at `frequency` (mono average). */
function bandMagnitude(channels: Float32Array[], start: number, end: number, frequency: number): number {
  const [from, to] = window(start, end);
  const step = (2 * Math.PI * frequency) / SAMPLE_RATE;
  let real = 0;
  let imag = 0;
  for (let i = from; i < to; i++) {
    const value = (channels[0][i] + channels[1][i]) / 2;
    real += value * Math.cos(step * i);
    imag += value * Math.sin(step * i);
  }
  return Math.hypot(real, imag) / Math.max(1, to - from);
}

/** Divide the reported whole-buffer peak normalization back out. */
function normalized(result: RenderedCue): Float32Array[] {
  const { normalizationScale } = result.report;
  assert.ok(Number.isFinite(normalizationScale) && normalizationScale > 0, 'the render reports a usable scale');
  return result.channels.map(channel => channel.map(value => value / normalizationScale));
}

function maxDiff(a: Float32Array[], b: Float32Array[], start: number, end: number): number {
  const [from, to] = window(start, end);
  let difference = 0;
  for (let channel = 0; channel < a.length; channel++) {
    for (let i = from; i < to; i++) difference = Math.max(difference, Math.abs(a[channel][i] - b[channel][i]));
  }
  return difference;
}

function assertReportFacts(result: RenderedCue, label: string): void {
  const report = result.report;
  assert.equal(result.channels.length, 2, `${label}: stereo`);
  for (const channel of result.channels) assert.equal(channel.length, FRAMES, `${label}: exact 4 s span`);
  assert.ok(
    Number.isFinite(report.rawPeak) && report.rawPeak > 0,
    `${label}: rawPeak is the real summed dry+wet peak before normalization`,
  );
  assert.ok(Number.isFinite(report.peak) && report.peak > 0, `${label}: peak is reported`);
  assert.ok(report.peak <= 1, `${label}: the post-scale peak stays within full scale`);
  if (report.rms !== undefined)
    assert.ok(
      Number.isFinite(report.rms) && report.rms > 0 && report.rms <= 1,
      `${label}: a reported rms is finite and in range`,
    );
  const pcmRms = rmsBetween(result.channels, 0, 4);
  assert.ok(Number.isFinite(pcmRms) && pcmRms > 0, `${label}: the rendered PCM has finite nonzero rms (${pcmRms})`);
  assert.equal(report.normalizationTargetDbfs, -3, `${label}: the normalization fact is -3 dBFS`);
  assert.ok(
    Math.abs(report.normalizationTarget - Math.pow(10, -3 / 20)) < 1e-12,
    `${label}: the linear target matches -3 dBFS`,
  );
  assert.ok(
    Math.abs(report.peak - report.normalizationTarget) <= 1e-6,
    `${label}: post-scale peak is the reported target within float32 rounding`,
  );
  assert.ok(
    Math.abs(report.normalizationScale - report.normalizationTarget / report.rawPeak) < 1e-12,
    `${label}: scale = target / rawPeak (one whole-buffer normalization, not a limiter)`,
  );
  for (const channel of result.channels) {
    for (let i = 0; i < channel.length; i++) assert.ok(Number.isFinite(channel[i]), `${label}: finite sample ${i}`);
  }
  // `-0 === 0` is true, while strict deep equality distinguishes them; either
  // sign of zero is an exact silent close.
  assert.ok(result.channels[0][FRAMES - 1] === 0, `${label}: the closing fade ends at exact zero (L)`);
  assert.ok(result.channels[1][FRAMES - 1] === 0, `${label}: the closing fade ends at exact zero (R)`);
}

/** Zero every voice except guitar so the guitar onset alone is measurable. */
function isolateGuitar(text: string): string {
  const levels = 'const levels = { guitar: 0.62, bass: 0.7, vibes: 0.28, brush: 0.5 };';
  const sends = 'const sends = { guitar: 0.16, bass: 0.05, vibes: 0.26, brush: 0.05 };';
  assert.ok(text.includes(levels), 'the score exposes its voice levels');
  assert.ok(text.includes(sends), 'the score exposes its room sends');
  return text
    .replace(levels, 'const levels = { guitar: 0.62, bass: 0, vibes: 0, brush: 0 };')
    .replace(sends, 'const sends = { guitar: 0.16, bass: 0, vibes: 0, brush: 0 };');
}

/** Zero only bass so every remaining signal belongs to the action-space scope. */
function isolateDuckedScope(text: string): string {
  const levels = 'const levels = { guitar: 0.62, bass: 0.7, vibes: 0.28, brush: 0.5 };';
  const sends = 'const sends = { guitar: 0.16, bass: 0.05, vibes: 0.26, brush: 0.05 };';
  assert.ok(text.includes(levels), 'the score exposes its voice levels');
  assert.ok(text.includes(sends), 'the score exposes its room sends');
  return text
    .replace(levels, 'const levels = { guitar: 0.62, bass: 0, vibes: 0.28, brush: 0.5 };')
    .replace(sends, 'const sends = { guitar: 0.16, bass: 0, vibes: 0.26, brush: 0.05 };');
}

test('risograph score and Foley descriptors/PCM carry the authored action facts', async () => {
  const scoreModule = await load<ScoreModule>(STUDY_DIR, 'score.mjs');
  const foleyModule = await load<FoleyModule>(STUDY_DIR, 'foley.mjs');
  const facts = await load<FactsModule>(STUDY_DIR, 'action-facts.mjs');

  for (const variant of ['riverside', 'bakery'] as const) {
    const score = scoreModule.buildMusic({ variant, duration: 4 });
    assert.equal(score.seconds, 4);
    assert.equal(score.variant, variant);
    const section = (id: string): MusicSection => {
      const found = score.sections.find(candidate => candidate.id === id);
      assert.ok(found, `${variant}: section ${id} exists`);
      return found;
    };
    assert.equal(section('blue').start, 0);
    assert.equal(section('blue').end, 0.75);
    assert.equal(section('yellow').start, 0.75);
    assert.equal(section('yellow').end, 1.5);
    assert.equal(section('pink').start, 1.5);
    assert.equal(section('pink').end, 2.1);
    const action = section('action-space');
    assert.equal(action.start, 2.1);
    assert.equal(action.end, variant === 'riverside' ? 2.55 : 2.75);

    const guitarTimes = score.events.filter(event => event.voice === 'guitar').map(event => event.time);
    const vibeTimes = score.events.filter(event => event.voice === 'vibes').map(event => event.time);
    assert.equal(Math.min(...guitarTimes), 0.75, `${variant}: the guitar enters at the yellow gate`);
    assert.equal(Math.min(...vibeTimes), 1.5, `${variant}: the vibes enter at the pink gate`);
    assert.ok(
      score.events.some(event => event.voice === 'brush' && event.time === 0.5),
      `${variant}: the brush stroke is a real event`,
    );
    assert.deepEqual(
      score.spaces.map(({ start, end, contact, kind, gain, scope }) => ({ start, end, contact, kind, gain, scope })),
      [
        {
          start: 2.1,
          end: variant === 'riverside' ? 2.55 : 2.75,
          contact: variant === 'riverside' ? facts.RIDES.riverside.bell.strike : facts.RIDES.bakery.bakery.catchContact,
          kind: variant === 'riverside' ? 'bell' : 'catch',
          gain: 0.35,
          scope: ['guitar', 'brush', 'vibes'],
        },
      ],
    );
    const forbidden = new Set(['guitar', 'brush', 'vibes']);
    assert.ok(
      !score.events.some(event => forbidden.has(event.voice) && event.time >= 2.1 && event.time < action.end),
      `${variant}: no new selected-voice attack inside the action window`,
    );

    const foleyScore = foleyModule.buildFoley({ variant, duration: 4 });
    assert.equal(foleyScore.seconds, 4);
    if (variant === 'riverside') {
      assert.deepEqual(
        foleyScore.events.map(event => [event.kind, Number(event.time.toFixed(4))]),
        [
          ['bell', 2.3333],
          ['wing', 2.35],
          ['wing', 2.4],
          ['wing', 2.45],
          ['wing', 2.5],
          ['wing', 2.55],
        ],
      );
    } else {
      assert.deepEqual(
        foleyScore.events.map(event => [event.kind, Number(event.time.toFixed(4))]),
        [
          ['fabric', 2.1],
          ['catch', 2.75],
          ['wing', 2.85],
          ['stow', 3.1667],
        ],
      );
      assert.ok(!foleyScore.events.some(event => event.kind === 'bell'), 'the bakery has no bell');
    }
    assert.ok(
      !foleyScore.cues.some(cue => [0.75, 1.5, 3.3].includes(Number(cue.time.toFixed(4)))),
      `${variant}: plate gates and registration kicks are not Foley`,
    );
  }

  // The shared stepped observer the picture and both sound cues use.
  const bellFrame = Math.round(facts.RIDES.riverside.bell.strike * FPS);
  const catchFrame = Math.round(facts.RIDES.bakery.bakery.catchContact * FPS);
  const stowFrame = Math.round(facts.RIDES.bakery.bakery.stowContact * FPS);
  assert.deepEqual([bellFrame, catchFrame, stowFrame], [56, 66, 76]);
  assert.ok(facts.actionAt('riverside', bellFrame / FPS).bell > 0.999);
  assert.ok(facts.actionAt('riverside', (bellFrame - 1) / FPS).bell < 0.999);
  assert.equal(facts.actionAt('bakery', catchFrame / FPS).caught, 1);
  assert.ok(facts.actionAt('bakery', (catchFrame - 1) / FPS).caught < 1);
  assert.equal(facts.actionAt('bakery', stowFrame / FPS).inBasket, true);
  assert.equal(facts.actionAt('bakery', (stowFrame - 1) / FPS).inBasket, false);
  assert.ok(Math.abs(facts.actionAt('riverside', 0).contact - facts.RIDES.riverside.bell.strike) < 1e-12);
  assert.ok(Math.abs(facts.actionAt('bakery', 0).contact - facts.RIDES.bakery.bakery.catchContact) < 1e-12);

  for (const [variant, seed] of [
    ['riverside', 9241],
    ['bakery', 9242],
  ] as const) {
    const music = scoreModule.renderMusic({
      sampleRate: SAMPLE_RATE,
      channels: 2,
      frames: FRAMES,
      params: { variant, duration: 4 },
      seed,
    });
    assertReportFacts(music, `${variant} music`);
    const musicRms = music.report.rms;
    assert.ok(
      typeof musicRms === 'number' && Number.isFinite(musicRms) && musicRms > 0 && musicRms <= 1,
      `${variant}: the music report carries its own finite nonzero rms`,
    );
    const guitarBefore = bandMagnitude(music.channels, 0.6, 0.74, 185);
    const guitarAfter = bandMagnitude(music.channels, 0.76, 0.9, 185);
    assert.ok(guitarAfter > guitarBefore * 5, `${variant}: guitar rises at 0.75 (${guitarBefore} → ${guitarAfter})`);
    const vibesBefore = bandMagnitude(music.channels, 1.35, 1.49, 440);
    const vibesAfter = bandMagnitude(music.channels, 1.51, 1.65, 440);
    assert.ok(vibesAfter > vibesBefore * 5, `${variant}: vibes rise at 1.5 (${vibesBefore} → ${vibesAfter})`);
    assert.ok(bandMagnitude(music.channels, 0.05, 0.25, 73.4) > 0.0005, `${variant}: bass is present at the opening`);
    assert.ok(rmsBetween(music.channels, 0, 0.7) > 0.01, `${variant}: the opening is a real cue`);
    assert.ok(rmsBetween(music.channels, 2.7, 3.5) > 0.01, `${variant}: the answer remains music`);
    if (variant === 'riverside')
      assert.ok(
        rmsBetween(music.channels, 2.35, 2.55) < rmsBetween(music.channels, 2.0, 2.3) * 0.6,
        'riverside: the action space thins the music',
      );

    const foley = foleyModule.renderFoley({
      sampleRate: SAMPLE_RATE,
      channels: 2,
      frames: FRAMES,
      params: { variant, duration: 4 },
      seed,
    });
    assertReportFacts(foley, `${variant} foley`);
    if (variant === 'riverside') {
      assert.equal(peakSamples(foley.channels, 0, 112000), 0, 'riverside Foley is exactly zero before sample 112000');
      assert.ok(peakBetween(foley.channels, 2.32, 2.36) > 0.1, 'the bell attack is present');
      assert.ok(peakBetween(foley.channels, 2.35, 2.6) > 0.05, 'the pigeon flaps follow');
    } else {
      let firstNonZero = -1;
      for (let i = 0; i < FRAMES && firstNonZero < 0; i++) {
        if (foley.channels[0][i] !== 0 || foley.channels[1][i] !== 0) firstNonZero = i;
      }
      assert.equal(firstNonZero, 100801, 'bakery Foley starts with the 2.1 s fabric sample after its zero attack');
      assert.ok(peakBetween(foley.channels, 2.73, 2.77) > 0.1, 'the bread contact is present');
      assert.ok(peakBetween(foley.channels, 3.15, 3.18) > 0.01, 'the basket stow is present');
    }
  }
});

test('moving only the riverside PRESS yellow gate moves the first guitar attack', async () => {
  const base = await mkdtemp(join(tmpdir(), 'viscraft-riso-gate-base-'));
  const gated = await mkdtemp(join(tmpdir(), 'viscraft-riso-gate-moved-'));
  const baseGuitar = await mkdtemp(join(tmpdir(), 'viscraft-riso-gate-guitar-base-'));
  const gatedGuitar = await mkdtemp(join(tmpdir(), 'viscraft-riso-gate-guitar-moved-'));
  const probes = [base, gated, baseGuitar, gatedGuitar];
  let succeeded = false;
  try {
    for (const directory of probes) await cp(STUDY_DIR, directory, { recursive: true, force: true });
    for (const directory of probes)
      for (const file of ['score.mjs', 'action-facts.mjs'])
        await assertIndependentCopy(join(STUDY_DIR, file), join(directory, file));

    // The full-mix pair keeps the untouched score bytes; only the riverside
    // PRESS gate moves (the bakery gate is asserted unchanged).
    assert.equal(
      hash(await readFile(join(base, 'score.mjs'))),
      hash(await readFile(join(gated, 'score.mjs'))),
      'the two full-mix probes carry the same untouched score bytes',
    );
    const baseFacts = await readFile(join(base, 'action-facts.mjs'), 'utf8');
    const riversideGate = '  riverside: Object.freeze({\n    gates: Object.freeze([-0.5, 0.75, 1.5]),';
    assert.ok(baseFacts.includes(riversideGate), 'the riverside gate literal is present');
    const gatedFacts = baseFacts.replace(
      riversideGate,
      '  riverside: Object.freeze({\n    gates: Object.freeze([-0.5, 1.0, 1.5]),',
    );
    assert.notEqual(gatedFacts, baseFacts);
    assert.ok(
      gatedFacts.includes('  bakery: Object.freeze({\n    gates: Object.freeze([-0.5, 0.75, 1.5]),'),
      'only the riverside gate is edited',
    );
    await writeFile(join(gated, 'action-facts.mjs'), gatedFacts);
    await writeFile(join(gatedGuitar, 'action-facts.mjs'), gatedFacts);
    assert.notEqual(
      hash(await readFile(join(base, 'action-facts.mjs'))),
      hash(await readFile(join(gated, 'action-facts.mjs'))),
    );

    // Both isolated probes zero every non-guitar level and send, so the PCM
    // proves a guitar onset rather than guitar-band energy in a mixed bed.
    for (const directory of [baseGuitar, gatedGuitar]) {
      const scorePath = join(directory, 'score.mjs');
      const scoreText = await readFile(scorePath, 'utf8');
      const isolated = isolateGuitar(scoreText);
      assert.notEqual(isolated, scoreText, `${directory}: the score is isolated to guitar`);
      await writeFile(scorePath, isolated);
    }
    assert.equal(
      hash(await readFile(join(baseGuitar, 'score.mjs'))),
      hash(await readFile(join(gatedGuitar, 'score.mjs'))),
      'both isolated probes carry the same isolated score bytes',
    );
    assert.notEqual(
      hash(await readFile(join(baseGuitar, 'action-facts.mjs'))),
      hash(await readFile(join(gatedGuitar, 'action-facts.mjs'))),
      'only the gate differs between the isolated probes',
    );

    const args = {
      sampleRate: SAMPLE_RATE,
      channels: 2,
      frames: FRAMES,
      params: { variant: 'riverside', duration: 4 },
      seed: 9241,
    };
    const baseModule = await load<ScoreModule>(base, 'score.mjs');
    const gatedModule = await load<ScoreModule>(gated, 'score.mjs');
    const baseGuitarModule = await load<ScoreModule>(baseGuitar, 'score.mjs');
    const gatedGuitarModule = await load<ScoreModule>(gatedGuitar, 'score.mjs');

    const before = baseModule.renderMusic(args);
    const after = gatedModule.renderMusic(args);
    assertReportFacts(before, 'base gate');
    assertReportFacts(after, 'moved gate');
    const beforeNeutral = normalized(before);
    const afterNeutral = normalized(after);

    assert.ok(maxDiff(beforeNeutral, afterNeutral, 0, 0.75) < 1e-6, 'the pre-0.75 waveform is unchanged');
    assert.ok(maxDiff(beforeNeutral, afterNeutral, 0.8, 0.95) > 1e-4, 'the 0.8–0.95 s waveform changes');

    const guitarEntry = (module: ScoreModule) =>
      Math.min(
        ...module
          .buildMusic({ variant: 'riverside', duration: 4 })
          .events.filter(event => event.voice === 'guitar')
          .map(event => event.time),
      );
    assert.equal(guitarEntry(baseModule), 0.75, 'the base descriptor enters the guitar at 0.75');
    assert.equal(guitarEntry(gatedModule), 1.0, 'the moved descriptor enters the guitar at 1.0');

    const isolatedBase = baseGuitarModule.renderMusic(args);
    const isolatedGated = gatedGuitarModule.renderMusic(args);
    assertReportFacts(isolatedBase, 'isolated base guitar');
    assertReportFacts(isolatedGated, 'isolated moved guitar');
    const baseAttack = Math.round(0.75 * SAMPLE_RATE);
    const movedAttack = Math.round(1.0 * SAMPLE_RATE);
    assert.equal(
      peakSamples(isolatedBase.channels, 0, baseAttack),
      0,
      'the isolated base guitar is exactly silent before 0.75',
    );
    assert.ok(
      peakSamples(isolatedBase.channels, baseAttack, movedAttack) > 0.01,
      'the isolated base guitar attacks at 0.75',
    );
    assert.equal(
      peakSamples(isolatedGated.channels, 0, movedAttack),
      0,
      'the isolated moved guitar is exactly silent before 1.0',
    );
    assert.ok(
      peakSamples(isolatedGated.channels, movedAttack, movedAttack + Math.round(0.15 * SAMPLE_RATE)) > 0.01,
      'the isolated moved guitar attacks at 1.0',
    );
    succeeded = true;
  } finally {
    if (succeeded) for (const directory of probes) await rm(directory, { recursive: true, force: true });
    else console.error(`kept the risograph gate probes for inspection: ${probes.join(', ')}`);
  }
});

test('disabling only the action-space actionGain restores the selected stems to 1.0', async () => {
  const base = await mkdtemp(join(tmpdir(), 'viscraft-riso-duck-base-'));
  const ablated = await mkdtemp(join(tmpdir(), 'viscraft-riso-duck-ablated-'));
  let succeeded = false;
  try {
    await cp(STUDY_DIR, base, { recursive: true, force: true });
    await cp(STUDY_DIR, ablated, { recursive: true, force: true });
    await assertIndependentCopy(join(STUDY_DIR, 'score.mjs'), join(base, 'score.mjs'));
    await assertIndependentCopy(join(STUDY_DIR, 'score.mjs'), join(ablated, 'score.mjs'));

    const baseScorePath = join(base, 'score.mjs');
    const ablatedScorePath = join(ablated, 'score.mjs');
    const baseScore = isolateDuckedScope(await readFile(baseScorePath, 'utf8'));
    const ablatedScore = isolateDuckedScope(await readFile(ablatedScorePath, 'utf8'));
    await writeFile(baseScorePath, baseScore);

    const actionGain = '      const actionGain = ducked ? duck[i] : 1;';
    assert.ok(ablatedScore.includes(actionGain), 'the action-space gain line is present');
    const withoutDuck = ablatedScore.replace(
      actionGain,
      '      const actionGain = 1; // ablation: only the duck is disabled',
    );
    assert.notEqual(withoutDuck, ablatedScore);
    await writeFile(ablatedScorePath, withoutDuck);
    assert.equal(
      hash(await readFile(join(base, 'action-facts.mjs'))),
      hash(await readFile(join(ablated, 'action-facts.mjs'))),
    );
    assert.equal(
      baseScore.replace(actionGain, ''),
      withoutDuck.replace('      const actionGain = 1; // ablation: only the duck is disabled', ''),
      'the two scores differ only at the actionGain line',
    );

    const baseModule = await load<ScoreModule>(base, 'score.mjs');
    const ablatedModule = await load<ScoreModule>(ablated, 'score.mjs');
    const args = {
      sampleRate: SAMPLE_RATE,
      channels: 2,
      frames: FRAMES,
      params: { variant: 'riverside', duration: 4 },
      seed: 9241,
    };
    const ducked = baseModule.renderMusic(args);
    const plain = ablatedModule.renderMusic(args);
    assertReportFacts(ducked, 'ducked');
    assertReportFacts(plain, 'ablated');
    const duckedNeutral = normalized(ducked);
    const plainNeutral = normalized(plain);
    const space = baseModule.buildMusic({ variant: 'riverside', duration: 4 }).spaces[0];

    assert.ok(
      maxDiff(duckedNeutral, plainNeutral, 0, space.start - 0.07) < 1e-6,
      'the pre-action waveform is unchanged outside the duck edge',
    );
    assert.ok(
      maxDiff(duckedNeutral, plainNeutral, space.end + 0.07, 4) < 1e-6,
      'the post-release waveform is unchanged',
    );
    const duckedRms = rmsBetween(duckedNeutral, space.start + 0.06, space.end - 0.06);
    const plainRms = rmsBetween(plainNeutral, space.start + 0.06, space.end - 0.06);
    assert.ok(plainRms > 0, 'the control action window has signal');
    assert.ok(duckedRms < plainRms, 'disabling the gain raises the selected-stem level');
    assert.ok(
      Math.abs(duckedRms / plainRms - space.gain) < 1e-3,
      `the action-space gain is exactly ${space.gain} after normalization (${duckedRms / plainRms})`,
    );
    succeeded = true;
  } finally {
    if (succeeded) {
      await rm(base, { recursive: true, force: true });
      await rm(ablated, { recursive: true, force: true });
    } else console.error(`kept the risograph duck probes for inspection: ${base}, ${ablated}`);
  }
});
