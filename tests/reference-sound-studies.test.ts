import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const SAMPLE_RATE = 48000;
const AUDIO_STUDIES = resolve('skills/viscraft/assets/studies/audio');

interface ScoreModule {
  buildScore(): {
    seconds: number;
    rests: Array<{ start: number; end: number; scope: string }>;
    events: Array<{ time: number; duration: number; role?: string }>;
  };
  renderScore(input: { sampleRate: number; channels: number; frames: number; seed: number }): {
    channels: Float32Array[];
  };
}

async function renderStudy(name: string) {
  const score = (await import(pathToFileURL(join(AUDIO_STUDIES, name, 'score.mjs')).href)) as ScoreModule;
  const descriptor = score.buildScore();
  const frames = Math.round(descriptor.seconds * SAMPLE_RATE);
  assert.ok(Number.isSafeInteger(frames) && frames > 0, 'the descriptor supplies a usable sample span');
  const { channels } = score.renderScore({ sampleRate: SAMPLE_RATE, channels: 2, frames, seed: 20261019 });

  assert.equal(channels.length, 2);
  for (const channel of channels) {
    assert.equal(channel.length, frames);
    assert.equal(
      channel.findIndex(value => !Number.isFinite(value) || Math.abs(value) > 1),
      -1,
    );
  }

  const peak = (start: number, end: number) => {
    const first = Math.max(0, Math.ceil(start * SAMPLE_RATE));
    const last = Math.min(frames, Math.floor(end * SAMPLE_RATE));
    assert.ok(last > first, 'the measured interval must contain samples');
    let value = 0;
    for (const channel of channels) {
      for (let i = first; i < last; i++) value = Math.max(value, Math.abs(channel[i]));
    }
    return value;
  };

  return { ...descriptor, peak };
}

for (const name of ['storybook-score', 'plucked-breath']) {
  test(`${name}: the declared all-voice rest interrupts audible audio`, async () => {
    const { rests, peak } = await renderStudy(name);
    const rest = rests.find(rest => rest.scope === 'all');
    assert.ok(rest && rest.end - rest.start > 0.2, 'the shipped score declares a measurable all-voice rest');
    assert.ok(peak(rest.start - 0.25, rest.start) > 0.01, 'audio is playing into the rest');
    assert.equal(peak(rest.start + 0.1, rest.end - 0.1), 0, 'a lingering voice or room tail breaks the rest');
    assert.ok(peak(rest.end, rest.end + 1) > 0.01, 'audio returns after the rest');
  });
}

test('cartoon-jazz: Foley remains audible during the music stop and the ending drops to silence', async () => {
  const { rests, events, seconds, peak } = await renderStudy('cartoon-jazz');
  const stop = rests.find(rest => rest.scope === 'music');
  assert.ok(stop, 'the shipped score declares a music stop');
  const cues = events.filter(event => event.time >= stop.start && event.time + event.duration <= stop.end);
  const foley = cues.filter(event => event.role === 'foley');
  assert.ok(foley.length >= 2, 'the stop contains distinct Foley cues');
  assert.ok(
    cues.every(event => event.role === 'foley'),
    'the music stop retains only Foley',
  );
  for (const event of foley) {
    assert.ok(peak(event.time, event.time + event.duration) > 0.01, 'the Foley cue survives the stop');
  }
  const firstGap = foley.findIndex((event, index) => foley[index + 1]?.time - (event.time + event.duration) >= 0.12);
  assert.ok(firstGap >= 0, 'there is an interval between Foley cues to measure');
  const gapStart = foley[firstGap].time + foley[firstGap].duration;
  assert.equal(peak(gapStart + 0.02, foley[firstGap + 1].time - 0.02), 0, 'the stop has no music or room tail');
  assert.ok(peak(seconds - 0.4, seconds - 0.3) > 0.01, 'the close begins with an audible tail');
  assert.ok(peak(seconds - 0.001, seconds) < 0.001, 'the rendered close settles below the audible tail');
});

test('cartoon-jazz: the rendered high note preserves pitch at both supported sample rates', async () => {
  const { banjo } = (await import(pathToFileURL(join(AUDIO_STUDIES, 'cartoon-jazz/synth.mjs')).href)) as {
    banjo(input: { midi: number; duration: number; sampleRate: number; seed: number }): Float32Array;
  };
  const midi = 81;
  const frequency = 440 * 2 ** ((midi - 69) / 12);

  for (const sampleRate of [44100, 48000]) {
    const note = banjo({ midi, duration: 0.6, sampleRate, seed: 20261019 });
    const from = Math.round(0.15 * sampleRate);
    const length = Math.round(0.35 * sampleRate);
    assert.ok(note.length >= from + length);
    const powerAt = (cents: number) => {
      const coefficient = 2 * Math.cos((2 * Math.PI * frequency * 2 ** (cents / 1200)) / sampleRate);
      let prior = 0;
      let previous = 0;
      for (let i = 0; i < length; i++) {
        const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1));
        const next = note[from + i] * window + coefficient * previous - prior;
        prior = previous;
        previous = next;
      }
      return previous ** 2 + prior ** 2 - coefficient * previous * prior;
    };
    const offsets = Array.from({ length: 101 }, (_, i) => i - 50);
    const best = offsets.map(cents => ({ cents, power: powerAt(cents) })).sort((a, b) => b.power - a.power)[0];
    assert.ok(
      best.power > 0.01 && Math.abs(best.cents) <= 10,
      `expected audible pitch at ${sampleRate} Hz, got ${best.cents} cents`,
    );
  }
});
