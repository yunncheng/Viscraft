/**
 * Node-side structural and PCM checks for the three independent sound references.
 *
 * These tests import each study's plain ESM score module directly and prove the
 * authored descriptor and the rendered samples independently of the browser:
 *
 *  - one common descriptor/clock contract (seconds, contiguous sections, sorted
 *    events, real rests/cues, exact finite sample spans, deterministic renders);
 *  - storybook: 3/4 bars, a separate re-orchestration, a gated silent bar, the
 *    complete four-bar theme and a coda whose rate and pitch settle;
 *  - cartoon: the same theme stated at half speed, a music-only band stop
 *    where only dry foley remains audible, a fractional-delay banjo that holds
 *    its written pitch, and a closing fade that descends to exact silence;
 *  - ink: sparse vs dense writing, an exact zero after the hard reverb cut, and
 *    punctuated harmonic events after the gap;
 *
 * These are measured facts, not listening approval. The browser/creator/export
 * path is covered separately in `reference-sound-studies.e2e.ts`.
 */
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const SEED = 20261019;

const AUDIO_STUDIES = resolve('skills/viscraft/assets/studies/audio');

interface ScoreSection {
  id: string;
  start: number;
  end: number;
}

interface ScoreEvent {
  id?: string;
  section?: string;
  time: number;
  duration: number;
  voice: string;
  midi?: number;
  gain: number;
  pan: number;
  role?: string;
  rate?: number;
  speed?: number;
  [key: string]: unknown;
}

interface ScoreRest {
  start: number;
  end: number;
  scope: string | string[];
}

interface ScoreCue {
  id: string;
  time: number;
}

interface ScoreDescriptor {
  seconds: number;
  sections: ScoreSection[];
  events: ScoreEvent[];
  rests: ScoreRest[];
  cues: ScoreCue[];
  meter?: string;
  beatsPerBar?: number;
  bpm?: number;
  coda?: { start: number; end: number };
  cut?: { time: number; gapEnd: number };
  track?: Array<{ time: number; x: number; speed: number }>;
  plates?: Array<{ id: string; enters: number; instruments: string[] }>;
  [key: string]: unknown;
}

interface RenderReport {
  trimmed?: boolean;
  [key: string]: unknown;
}

interface RenderResult {
  channels: Float32Array[];
  report?: RenderReport;
}

interface ScoreModule {
  DEFAULT_PARAMS: Record<string, unknown>;
  buildScore(params?: Record<string, unknown>): ScoreDescriptor;
  renderScore(args: {
    sampleRate: number;
    channels: number;
    frames: number;
    params?: Record<string, unknown>;
    seed?: number;
  }): RenderResult;
}

async function loadScoreModule(study: string): Promise<ScoreModule> {
  const entry = join(AUDIO_STUDIES, study, 'score.mjs');
  const module = (await import(pathToFileURL(entry).href)) as unknown as ScoreModule;
  assert.equal(typeof module.buildScore, 'function', `${study} exports buildScore`);
  assert.equal(typeof module.renderScore, 'function', `${study} exports renderScore`);
  assert.ok(module.DEFAULT_PARAMS && typeof module.DEFAULT_PARAMS === 'object', `${study} exports DEFAULT_PARAMS`);
  return module;
}

function sectionById(score: ScoreDescriptor, id: string): ScoreSection {
  const section = score.sections.find(candidate => candidate.id === id);
  assert.ok(section, `section ${id} exists`);
  return section;
}

function eventsBetween(score: ScoreDescriptor, start: number, end: number): ScoreEvent[] {
  return score.events.filter(event => event.time >= start && event.time < end);
}

function voicesBetween(score: ScoreDescriptor, start: number, end: number): string[] {
  return [...new Set(eventsBetween(score, start, end).map(event => event.voice))].sort();
}

function cueById(score: ScoreDescriptor, id: string): ScoreCue {
  const cue = score.cues.find(candidate => candidate.id === id);
  assert.ok(cue, `cue ${id} exists`);
  return cue;
}

function peakOf(channels: Float32Array[]): number {
  let peak = 0;
  for (const channel of channels) for (let i = 0; i < channel.length; i++) peak = Math.max(peak, Math.abs(channel[i]));
  return peak;
}

function rmsOf(channels: Float32Array[], startSeconds: number, endSeconds: number): number {
  let sum = 0;
  let count = 0;
  for (const channel of channels) {
    const from = Math.max(0, Math.floor(startSeconds * SAMPLE_RATE));
    const to = Math.min(channel.length, Math.ceil(endSeconds * SAMPLE_RATE));
    for (let i = from; i < to; i++) {
      sum += channel[i] * channel[i];
      count++;
    }
  }
  return count > 0 ? Math.sqrt(sum / count) : 0;
}

function maxAbsOf(channels: Float32Array[], startSeconds: number, endSeconds: number): number {
  let peak = 0;
  for (const channel of channels) {
    const from = Math.max(0, Math.floor(startSeconds * SAMPLE_RATE));
    const to = Math.min(channel.length, Math.ceil(endSeconds * SAMPLE_RATE));
    for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(channel[i]));
  }
  return peak;
}

function sameChannels(a: Float32Array[], b: Float32Array[]): boolean {
  if (a.length !== b.length) return false;
  for (let channel = 0; channel < a.length; channel++) {
    if (a[channel].length !== b[channel].length) return false;
    for (let i = 0; i < a[channel].length; i++) if (a[channel][i] !== b[channel][i]) return false;
  }
  return true;
}

function assertCommonContract(name: string, score: ScoreDescriptor, module: ScoreModule): void {
  assert.ok(Number.isFinite(score.seconds), `${name}: seconds is finite`);
  assert.ok(score.seconds >= 20 && score.seconds <= 40, `${name}: a complete 20-40 s passage (${score.seconds} s)`);
  assert.ok(Array.isArray(score.sections) && score.sections.length >= 4, `${name}: real section structure`);

  let previousEnd = 0;
  const sectionIds = new Set<string>();
  for (const section of score.sections) {
    assert.ok(section.id.length > 0, `${name}: section id`);
    assert.ok(!sectionIds.has(section.id), `${name}: unique section ${section.id}`);
    sectionIds.add(section.id);
    assert.ok(
      Math.abs(section.start - previousEnd) < 1e-6,
      `${name}: section ${section.id} starts where the last ended`,
    );
    assert.ok(section.end > section.start, `${name}: section ${section.id} is nonempty`);
    previousEnd = section.end;
  }
  assert.ok(Math.abs(previousEnd - score.seconds) < 1e-6, `${name}: sections span the whole passage`);

  assert.ok(Array.isArray(score.events) && score.events.length >= 12, `${name}: a written passage, not a single tone`);
  let previousTime = -Infinity;
  for (const event of score.events) {
    assert.ok(Number.isFinite(event.time), `${name}: event time is finite`);
    assert.ok(event.time >= 0 && event.time < score.seconds, `${name}: event ${event.time} is inside the passage`);
    assert.ok(event.time >= previousTime - 1e-9, `${name}: events are chronological`);
    assert.ok(Number.isFinite(event.duration) && event.duration > 0, `${name}: event duration is positive`);
    assert.ok(event.voice.length > 0, `${name}: event names a voice`);
    assert.ok(Number.isFinite(event.gain) && event.gain >= 0, `${name}: event gain is finite`);
    assert.ok(Number.isFinite(event.pan) && event.pan >= -1 && event.pan <= 1, `${name}: pan is in [-1, 1]`);
    if (event.midi !== undefined) assert.ok(Number.isInteger(event.midi), `${name}: midi is an integer`);
    previousTime = event.time;
  }

  for (const rest of score.rests) {
    assert.ok(rest.start >= 0 && rest.end <= score.seconds, `${name}: rest is inside the passage`);
    assert.ok(rest.end > rest.start, `${name}: rest is nonempty`);
    if (Array.isArray(rest.scope)) assert.ok(rest.scope.length > 0, `${name}: rest scope is not empty`);
    else assert.ok(rest.scope.length > 0, `${name}: rest names its scope`);
  }

  const cueIds = new Set<string>();
  let previousCue = -Infinity;
  for (const cue of score.cues) {
    assert.ok(cue.id.length > 0, `${name}: cue id`);
    assert.ok(!cueIds.has(cue.id), `${name}: unique cue ${cue.id}`);
    cueIds.add(cue.id);
    assert.ok(Number.isFinite(cue.time) && cue.time >= 0 && cue.time <= score.seconds, `${name}: cue time is inside`);
    assert.ok(cue.time >= previousCue - 1e-9, `${name}: cues are chronological`);
    previousCue = cue.time;
  }

  assert.equal(JSON.stringify(module.buildScore()), JSON.stringify(score), `${name}: the descriptor is a pure value`);
}

function renderPassage(
  name: string,
  module: ScoreModule,
  score: ScoreDescriptor,
  params: Record<string, unknown> = {},
): { channels: Float32Array[]; frames: number; report?: RenderReport } {
  const frames = Math.round(score.seconds * SAMPLE_RATE);
  const first = module.renderScore({ sampleRate: SAMPLE_RATE, channels: CHANNELS, frames, params, seed: SEED });
  assert.equal(first.channels.length, CHANNELS, `${name}: stereo render`);
  for (const channel of first.channels) {
    assert.equal(channel.length, frames, `${name}: exactly ${frames} samples per channel`);
    for (let i = 0; i < channel.length; i++) assert.ok(Number.isFinite(channel[i]), `${name}: finite sample ${i}`);
  }
  const peak = peakOf(first.channels);
  assert.ok(peak <= 1, `${name}: no sample exceeds full scale (peak ${peak})`);
  assert.ok(peak > 0.01, `${name}: the passage is audible (peak ${peak})`);

  const second = module.renderScore({ sampleRate: SAMPLE_RATE, channels: CHANNELS, frames, params, seed: SEED });
  assert.ok(
    sameChannels(first.channels, second.channels),
    `${name}: the same descriptor/seed renders byte-identically`,
  );
  return { channels: first.channels, frames, report: first.report };
}

// ---------------------------------------------------------------------------
// storybook: 3/4 form, re-orchestration, gated rest, full theme, settling coda
// ---------------------------------------------------------------------------
test('storybook-score: 3/4 theme, re-orchestration, rest, full return and settling coda', async () => {
  const name = 'storybook-score';
  const module = await loadScoreModule(name);
  const score = module.buildScore();
  assertCommonContract(name, score, module);
  assert.equal(score.meter, '3/4');
  assert.equal(score.beatsPerBar, 3);
  assert.deepEqual(
    score.sections.map(section => section.id),
    ['opening', 'toys', 'rest', 'theme', 'cadence', 'coda'],
  );

  const rest = score.rests.find(candidate => candidate.scope === 'all');
  assert.ok(rest, 'a rest that silences every voice');
  assert.ok(Math.abs(rest.end - rest.start - 2.5) < 1e-6, 'one 3/4 bar of rest');
  assert.equal(eventsBetween(score, rest.start, rest.end).length, 0, 'no new attacks inside the rest');

  const opening = voicesBetween(score, sectionById(score, 'opening').start, sectionById(score, 'opening').end);
  assert.deepEqual(opening, ['musicbox'], 'the opening is the music-box motif alone');
  const toys = voicesBetween(score, sectionById(score, 'toys').start, sectionById(score, 'toys').end);
  assert.ok(toys.includes('toy') && toys.includes('reed'), 'the second statement changes the orchestration');
  assert.notDeepEqual(toys, opening, 'the change is not a gain tweak');
  const theme = voicesBetween(score, sectionById(score, 'theme').start, sectionById(score, 'theme').end);
  for (const voice of ['flute', 'musicbox', 'reed', 'harp'])
    assert.ok(theme.includes(voice), `full theme has ${voice}`);
  const openingNotes = eventsBetween(score, 0, 5).filter(event => event.voice === 'musicbox').length;
  const themeNotes = eventsBetween(score, 15, 25).filter(event => event.voice === 'musicbox').length;
  assert.ok(themeNotes > openingNotes * 1.2, 'the complete four-bar theme is longer than the two-bar opening');

  const coda = score.events
    .filter(event => event.section === 'coda' && typeof event.rate === 'number')
    .sort((a, b) => a.time - b.time);
  assert.ok(coda.length >= 9, 'the coda has a written phrase');
  assert.ok(
    coda.every(event => (event.rate as number) <= 1),
    'the coda never speeds up',
  );
  assert.ok((coda[coda.length - 1].rate as number) < (coda[0].rate as number) - 0.05, 'the playback rate winds down');
  assert.ok(
    (coda[coda.length - 1].midi as number) <= (coda[0].midi as number) - 12,
    'the final coda note is an octave below the first statement',
  );

  const { channels } = renderPassage(name, module, score);
  assert.equal(maxAbsOf(channels, 13, 14.5), 0, 'the gated rest is exactly silent');
  assert.ok(rmsOf(channels, 12, 12.4) > 0.005, 'the phrase is playing into the rest');
  assert.ok(rmsOf(channels, 15.2, 15.8) > 0.01, 'the full theme restarts after the rest');
});

// ---------------------------------------------------------------------------
// print: plate-by-plate entry, 2 s rest, return and one-by-one withdrawal
// ---------------------------------------------------------------------------
interface MelodyGroup {
  voice: string;
  events: ScoreEvent[];
  meanGain: number;
}

function melodyGroups(score: ScoreDescriptor, sectionId: string): MelodyGroup[] {
  const byVoice = new Map<string, ScoreEvent[]>();
  for (const event of score.events) {
    if (event.section !== sectionId || event.role !== 'music' || typeof event.midi !== 'number') continue;
    const list = byVoice.get(event.voice) ?? [];
    list.push(event);
    byVoice.set(event.voice, list);
  }
  const groups: MelodyGroup[] = [];
  for (const [voice, events] of byVoice) {
    events.sort((a, b) => a.time - b.time);
    let monophonic = true;
    for (let index = 1; index < events.length; index++) {
      if (events[index].time - events[index - 1].time <= 1e-9) monophonic = false;
    }
    if (!monophonic || events.length < 4) continue;
    groups.push({ voice, events, meanGain: events.reduce((sum, event) => sum + event.gain, 0) / events.length });
  }
  return groups;
}

interface SynthModule {
  banjo(args: { midi: number; duration: number; sampleRate: number; seed: number }): Float32Array;
}

async function loadSynthModule(study: string): Promise<SynthModule> {
  const entry = join(AUDIO_STUDIES, study, 'synth.mjs');
  const module = (await import(pathToFileURL(entry).href)) as unknown as SynthModule;
  assert.equal(typeof module.banjo, 'function', `${study} exports banjo`);
  return module;
}

/**
 * Independent fundamental estimate for one isolated voice note.
 *
 * A Hann-windowed Goertzel power is scanned across ±100 cents of the written
 * pitch; the peak offset is returned in cents. The span cannot fold onto a
 * harmonic and the estimate is taken after the pick transient while the string
 * still rings, so an integer-rounded delay line shows up as a flat fundamental
 * rather than as a plausible-sounding strum.
 */
function measureCents(samples: Float32Array, sampleRate: number, targetHz: number): number {
  const from = Math.round(0.15 * sampleRate);
  const length = Math.round(0.35 * sampleRate);
  assert.ok(from + length <= samples.length, 'the pitch window fits inside the isolated note');
  const window = new Float64Array(length);
  for (let i = 0; i < length; i++)
    window[i] = samples[from + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1)));

  let bestCents = 0;
  let bestPower = -Infinity;
  for (let cents = -100; cents <= 100; cents += 0.25) {
    const frequency = targetHz * Math.pow(2, cents / 1200);
    const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / sampleRate);
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < length; i++) {
      const s0 = window[i] + coefficient * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    const power = s1 * s1 + s2 * s2 - coefficient * s1 * s2;
    if (power > bestPower) {
      bestPower = power;
      bestCents = cents;
    }
  }
  return bestCents;
}

const FADE_SECONDS = 0.35;
const FADE_DECLARATION = 'const fadeSamples = Math.min(frames, Math.round(0.35 * sampleRate));';

/**
 * Copy a study with the filesystem `cp` API (real byte copies, no hardlinks)
 * into a caller-owned temporary directory, then disable ONLY the production
 * closing fade. Replacing an exact declaration means a re-authored close fails
 * loudly instead of silently comparing production with itself.
 */
async function copyStudyWithoutEndFade(study: string, dir: string): Promise<ScoreModule> {
  await cp(join(AUDIO_STUDIES, study), dir, { recursive: true, force: true });
  const entry = join(dir, 'score.mjs');
  const source = await readFile(entry, 'utf8');
  assert.ok(source.includes(FADE_DECLARATION), `${study}: the closing fade is still the authored block`);
  await writeFile(entry, source.replace(FADE_DECLARATION, 'const fadeSamples = 0; // probe: closing fade disabled'));
  const module = (await import(pathToFileURL(entry).href)) as unknown as ScoreModule;
  assert.equal(typeof module.renderScore, 'function', `${study}: the unfaded probe exports renderScore`);
  return module;
}

test('cartoon-jazz: the same theme at a slower pace and a music-only stop with dry foley', async () => {
  const name = 'cartoon-jazz';
  const module = await loadScoreModule(name);
  const score = module.buildScore();
  assertCommonContract(name, score, module);
  assert.deepEqual(
    score.sections.map(section => section.id),
    ['theme', 'inspect', 'chase', 'bandstop', 'answer', 'slow', 'cadence'],
  );

  const bands = sectionById(score, 'bandstop');
  const stopped = eventsBetween(score, bands.start, bands.end);
  assert.ok(stopped.length >= 3, 'the stop has physical events');
  assert.ok(
    stopped.every(event => event.role === 'foley'),
    'no music event survives the band stop',
  );
  const rest = score.rests.find(candidate => candidate.scope === 'music');
  assert.ok(rest, 'the authored rest scopes the music bus');
  assert.equal(eventsBetween(score, rest.start, rest.end).filter(event => event.role === 'music').length, 0);

  const themeGroups = melodyGroups(score, 'theme');
  assert.ok(themeGroups.length >= 2, 'the theme has more than one melodic voice');
  const lead = themeGroups.sort((a, b) => b.meanGain - a.meanGain)[0];
  const themeMidi = lead.events.slice(0, 4).map(event => event.midi);
  const slow = melodyGroups(score, 'slow').find(group =>
    group.events.slice(0, 4).every((event, index) => event.midi === themeMidi[index]),
  );
  assert.ok(slow, 'the slow section restates the same four-note theme');
  const themeDeltas = lead.events.slice(1, 4).map((event, index) => event.time - lead.events[index].time);
  const slowDeltas = slow.events.slice(1, 4).map((event, index) => event.time - slow.events[index].time);
  for (let index = 0; index < 3; index++) {
    const ratio = slowDeltas[index] / themeDeltas[index];
    assert.ok(Math.abs(ratio - 2) < 0.1, `the same theme moves at half speed (ratio ${ratio.toFixed(3)})`);
  }

  const { channels, frames, report } = renderPassage(name, module, score);
  assert.ok(rmsOf(channels, 0, 0.5) > 0.05, 'the band is playing at the opening');
  assert.equal(maxAbsOf(channels, 18.65, 18.88), 0, 'the music bus and its room are exactly silent between foley hits');
  assert.ok(maxAbsOf(channels, 18.2, 18.28) > 0.01, 'the first stop tick is audible');
  assert.ok(maxAbsOf(channels, 19.1, 19.65) > 0.01, 'the stop gesture is audible while the band is stopped');

  // Fractional delay must preserve the written pitch across sample rates;
  // rounding the delay length detunes these high notes.
  const synth = await loadSynthModule(name);
  for (const midi of [76, 81])
    assert.ok(
      score.events.some(event => event.voice === 'banjo' && event.midi === midi),
      `the score actually writes banjo midi ${midi}`,
    );
  for (const sampleRate of [44100, 48000]) {
    for (const midi of [76, 81]) {
      const note = synth.banjo({ midi, duration: 0.6, sampleRate, seed: SEED });
      assert.ok(peakOf([note]) > 0.5, 'the isolated banjo note is audible');
      const targetHz = 440 * Math.pow(2, (midi - 69) / 12);
      const cents = measureCents(note, sampleRate, targetHz);
      assert.ok(
        Math.abs(cents) <= 10,
        `banjo midi ${midi} at ${sampleRate} Hz holds its fundamental (${cents.toFixed(2)} cents)`,
      );
    }
  }

  // The authored close descends from unity to exact zero over the
  // last 0.35 s. Compare against a byte copy whose only difference is the fade,
  // so the measured ratio is the applied multiplier, not a re-synthesis.
  assert.equal(report?.trimmed, false, 'the default cartoon passage is not peak-trimmed');
  assert.equal(score.gain, 1, 'the default cartoon gain is unity');
  const fadeSamples = Math.round(FADE_SECONDS * SAMPLE_RATE);
  const fadeStart = frames - fadeSamples;
  assert.ok(fadeStart > 0, 'the closing fade starts inside the passage');

  let probeDir: string | undefined;
  try {
    probeDir = await mkdtemp(join(tmpdir(), 'viscraft-cartoon-fade-'));
    const unfadedModule = await copyStudyWithoutEndFade(name, probeDir);
    assert.equal(
      JSON.stringify(unfadedModule.buildScore()),
      JSON.stringify(score),
      'disabling the end fade changes no authored event',
    );
    const unfaded = unfadedModule.renderScore({
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      frames,
      params: {},
      seed: SEED,
    });
    assert.equal(unfaded.report?.trimmed, false, 'the unfaded control is not peak-trimmed either');
    assert.equal(unfaded.channels.length, CHANNELS, 'the unfaded control is stereo');

    let changedBeforeFade: string | null = null;
    for (let channel = 0; channel < CHANNELS && changedBeforeFade === null; channel++) {
      for (let i = 0; i < fadeStart; i++) {
        if (channels[channel][i] !== unfaded.channels[channel][i]) {
          changedBeforeFade = `channel ${channel}, sample ${i}`;
          break;
        }
      }
    }
    assert.equal(
      changedBeforeFade,
      null,
      `the fade touches nothing before ${fadeStart} (first change ${changedBeforeFade})`,
    );

    // Sample the largest control value in each decile: the ratio is only
    // meaningful where the source is audible, and the per-sample multiplier is
    // independent of the waveform's own oscillation.
    const deciles = 10;
    const measured: number[] = [];
    const expected: number[] = [];
    for (let decile = 0; decile < deciles; decile++) {
      const from = fadeStart + Math.floor((decile * fadeSamples) / deciles);
      const to = fadeStart + Math.floor(((decile + 1) * fadeSamples) / deciles);
      let channelAtMax = 0;
      let indexAtMax = -1;
      let magnitudeAtMax = 0;
      for (let channel = 0; channel < CHANNELS; channel++) {
        for (let i = from; i < to; i++) {
          const magnitude = Math.abs(unfaded.channels[channel][i]);
          if (magnitude > magnitudeAtMax) {
            magnitudeAtMax = magnitude;
            channelAtMax = channel;
            indexAtMax = i;
          }
        }
      }
      assert.ok(indexAtMax >= 0 && magnitudeAtMax > 0.01, `the unfaded control still rings in fade decile ${decile}`);
      measured.push(channels[channelAtMax][indexAtMax] / unfaded.channels[channelAtMax][indexAtMax]);
      expected.push(0.5 + 0.5 * Math.cos((Math.PI * (indexAtMax - fadeStart + 1)) / fadeSamples));
    }

    assert.ok(measured[0] > 0.95, `the fade opens near unity (${measured[0].toFixed(4)})`);
    assert.ok(measured[deciles - 1] < 0.01, `the fade closes near zero (${measured[deciles - 1].toFixed(4)})`);
    for (let index = 0; index < deciles; index++) {
      assert.ok(
        Math.abs(measured[index] - expected[index]) < 5e-3,
        `fade decile ${index} is the descending cosine (${measured[index].toFixed(5)} vs ${expected[index].toFixed(5)})`,
      );
      if (index > 0)
        assert.ok(measured[index] < measured[index - 1], `the applied multiplier descends at decile ${index}`);
    }

    const tailSamples = Math.max(1, Math.round(0.001 * SAMPLE_RATE));
    const tailPeak = (bus: Float32Array[]): number => {
      let peak = 0;
      for (const channel of bus)
        for (let i = Math.max(0, frames - tailSamples); i < frames; i++) peak = Math.max(peak, Math.abs(channel[i]));
      return peak;
    };
    assert.ok(
      tailPeak(unfaded.channels) > 1e-3,
      `the unfaded ring is still sounding in the last millisecond (${tailPeak(unfaded.channels).toExponential(2)})`,
    );
    assert.ok(
      tailPeak(channels) < 1e-3,
      `the authored close is silent in the last millisecond (${tailPeak(channels).toExponential(2)})`,
    );
    for (let channel = 0; channel < CHANNELS; channel++)
      assert.equal(channels[channel][frames - 1], 0, `channel ${channel} ends at exact zero`);
  } catch (error) {
    if (probeDir) console.error(`kept the cartoon fade probe for inspection: ${probeDir}`);
    throw error;
  }
  if (probeDir) await rm(probeDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ink: density, exact hard cut of the reverb, punctuated harmonics after the gap
// ---------------------------------------------------------------------------
test('plucked-breath: sparse/dense writing, exact hard cut and punctuated harmonics', async () => {
  const name = 'plucked-breath';
  const module = await loadScoreModule(name);
  const score = module.buildScore();
  assertCommonContract(name, score, module);
  assert.deepEqual(
    score.sections.map(section => section.id),
    ['sparse', 'answers', 'ostinato', 'crescendo', 'gap', 'harmonics', 'cadence'],
  );

  const density = (id: string): number => {
    const section = sectionById(score, id);
    return eventsBetween(score, section.start, section.end).length / (section.end - section.start);
  };
  assert.ok(density('ostinato') > density('sparse') * 3, 'the ostinato is measurably denser than the sparse opening');

  const cut = cueById(score, 'hard-cut');
  const cutPoint = score.cut;
  assert.ok(cutPoint, 'the descriptor exposes the cut point');
  assert.ok(Math.abs(cutPoint.time - cut.time) < 1e-9, 'the cue and the cut agree');
  const rest = score.rests.find(candidate => candidate.scope === 'all');
  assert.ok(rest, 'the cut opens an all-voice gap');
  assert.ok(Math.abs(rest.start - cut.time) < 1e-9, 'the rest starts exactly at the cut');
  assert.equal(eventsBetween(score, rest.start, rest.end).length, 0, 'nothing is scheduled in the gap');

  const harmonics = score.events.filter(event => event.section === 'harmonics' && event.voice === 'guqinHarmonic');
  assert.ok(harmonics.length >= 3, 'the gap resolves into discrete harmonic events');
  for (let index = 1; index < harmonics.length; index++) {
    assert.ok(harmonics[index].time - harmonics[index - 1].time >= 0.4, 'the harmonics are punctuated, not a pad');
  }

  const { channels } = renderPassage(name, module, score);
  assert.ok(rmsOf(channels, cut.time - 0.08, cut.time) > 0.05, 'the crescendo and its reverb are ringing into the cut');
  assert.equal(maxAbsOf(channels, cut.time + 0.04, cut.time + 0.4), 0, 'the cut removes every previous tail exactly');
  for (const event of harmonics) {
    assert.ok(maxAbsOf(channels, event.time, event.time + 0.2) > 0.01, `harmonic at ${event.time} is audible`);
  }
});
