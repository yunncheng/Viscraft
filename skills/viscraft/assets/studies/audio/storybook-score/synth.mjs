/*
 * storybook-score / synth.mjs — deterministic, dependency-free instrument
 * synthesis for the picture-book score. No samples, no fetch, no Web Audio, no
 * wall clock. Every voice below is generated from oscillators, seeded noise and
 * filters, and is named as synthesis in the README.
 *
 * Adapted mechanisms (LemoLab, MIT, lemo-opuscar@e3cb16f6):
 *   - music_box modal partials, mechanical click and body resonances from
 *     core/audio/pluck.py `_modal` (the `music_box` branch);
 *   - the harp string is a compact Karplus-Strong waveguide after the `harp`
 *     preset in core/audio/pluck.py (fractional delay, one-pole loop loss,
 *     frequency-dependent t60);
 *   - the toy piano's inharmonic metal-bar partials, hammer noise and thud are
 *     adapted from styles/crayon-book/demo/music/score.py `toy()`.
 * The flute and reed are original additive/formant voices for this study: no
 * upstream flute or clarinet recording exists here and none is imitated by
 * relabelling a recording. See LICENSES.md for the full MIT text.
 */

const TAU = Math.PI * 2;

/** Seeded PRNG (mulberry32): the same seed produces the same stream. */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function midiToHz(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value;
}

function peakOf(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = Math.abs(samples[i]);
    if (value > peak) peak = value;
  }
  return peak;
}

/** Peak-normalise in place; a silent buffer is returned unchanged. */
function normalisePeak(samples, target) {
  const peak = peakOf(samples);
  if (peak > 0) {
    const scale = target / peak;
    for (let i = 0; i < samples.length; i++) samples[i] *= scale;
  }
  return samples;
}

/** Short raised-cosine attack and release; no clicks at either edge. */
function applyEnvelope(samples, sampleRate, attackSeconds, releaseSeconds, holdSamples = samples.length) {
  const attack = Math.max(1, Math.floor(attackSeconds * sampleRate));
  const release = Math.max(1, Math.floor(releaseSeconds * sampleRate));
  for (let i = 0; i < samples.length; i++) {
    const inGain = i < attack ? 0.5 - 0.5 * Math.cos((Math.PI * i) / attack) : 1;
    let outGain = 1;
    if (i >= holdSamples) {
      const progress = (i - holdSamples) / release;
      outGain = progress >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * progress);
    }
    samples[i] *= inGain * outGain;
  }
  return samples;
}

// ---------------------------------------------------------------------------
// Filters (RBJ biquad, direct form I). Pure sample loops; no Web Audio nodes.
// ---------------------------------------------------------------------------

function biquadCoefficients(type, frequency, q, sampleRate) {
  const w0 = (TAU * clamp(frequency, 10, sampleRate * 0.49)) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * Math.max(q, 0.05));
  let b0;
  let b1;
  let b2;
  let a0;
  let a1;
  let a2;
  if (type === 'lowpass') {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = (1 - cos) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  } else if (type === 'highpass') {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  } else if (type === 'bandpass') {
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  } else {
    throw new Error(`synth: unknown biquad type ${type}`);
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

export function biquad(samples, type, frequency, q, sampleRate) {
  const c = biquadCoefficients(type, frequency, q, sampleRate);
  const out = new Float32Array(samples.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    out[i] = y;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
  }
  return out;
}

function noise(sampleRate, seconds, rng) {
  const length = Math.max(1, Math.ceil(seconds * sampleRate));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = rng() * 2 - 1;
  return out;
}

// ---------------------------------------------------------------------------
// Music box: struck steel comb tooth. Partials and body follow the MIT modal
// model; the note is still synthesis, never a recording.
// ---------------------------------------------------------------------------

export function musicBox(midi, { sampleRate, seed = 7, velocity = 0.7, hold = null } = {}) {
  const f0 = midiToHz(midi);
  const rng = mulberry32((seed ^ Math.imul(Math.round(midi * 100), 0x9e3779b1)) >>> 0);
  const t60 = 1.8 * Math.sqrt(880 / Math.max(f0, 200));
  const seconds = (hold ?? t60) + t60 * 0.6;
  const length = Math.max(1, Math.floor(Math.min(seconds, t60 * 2.2) * sampleRate));
  const out = new Float32Array(length);
  const partials = [
    [1, 1, 1],
    [1.003, 0.35, 0.9],
    [6.27, 0.3 * velocity + 0.08, 0.22],
    [17.55, 0.12 * velocity, 0.07],
    [3, 0.05, 0.3],
  ];
  for (const [ratio, amplitude, decay] of partials) {
    const frequency = f0 * ratio;
    if (frequency > sampleRate * 0.45) continue;
    const phase = rng() * TAU;
    const denominator = Math.max(t60 * decay, 0.01);
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      out[i] += amplitude * Math.sin(TAU * frequency * t + phase) * Math.exp((-6.9 * t) / denominator);
    }
  }
  // Mechanical click: tiny high-passed noise burst at the pluck.
  const clickLength = Math.max(1, Math.floor(0.012 * sampleRate));
  const click = new Float32Array(clickLength);
  for (let i = 0; i < clickLength; i++) click[i] = (rng() * 2 - 1) * Math.exp(-i / (0.0015 * sampleRate));
  const banded = biquad(click, 'bandpass', 6200, 0.8, sampleRate);
  for (let i = 0; i < clickLength; i++) out[i] += banded[i] * 0.25 * velocity * 4;
  // Comb/wood body: two broad resonances, mixed under the direct partials.
  const bodyLow = biquad(out, 'bandpass', 600, 3, sampleRate);
  const bodyHigh = biquad(out, 'bandpass', 1400, 3, sampleRate);
  for (let i = 0; i < length; i++) out[i] = out[i] * 0.8 + (bodyLow[i] + bodyHigh[i] * 0.6) * 0.35;
  const fadeIn = Math.min(64, length);
  for (let i = 0; i < fadeIn; i++) out[i] *= i / fadeIn;
  const fadeOut = Math.min(Math.floor(0.02 * sampleRate), length);
  for (let i = 0; i < fadeOut; i++) out[length - 1 - i] *= i / fadeOut;
  return normalisePeak(out, 0.78 * clamp(velocity, 0.05, 1) ** 0.9);
}

// ---------------------------------------------------------------------------
// Toy piano: hammered metal bar. Inharmonic partials, fast decay, hammer noise
// and a wooden thud (adapted from the MIT upstream `toy()`).
// ---------------------------------------------------------------------------

export function toyPiano(midi, { sampleRate, seed = 7, velocity = 0.7 } = {}) {
  const rng = mulberry32((seed ^ Math.imul(701 + Math.round(midi), 0x85ebca6b)) >>> 0);
  const detuneCents = rng() * 18 - 9;
  const f0 = midiToHz(midi) * 2 ** (detuneCents / 1200);
  const seconds = 1.6;
  const length = Math.max(1, Math.floor(seconds * sampleRate));
  const out = new Float32Array(length);
  const partials = [
    [1, 1, 1.1],
    [2.92, 0.42, 0.38],
    [5.84, 0.2, 0.18],
    [9.3, 0.1, 0.09],
    [1.004, 0.35, 1],
  ];
  for (const [ratio, amplitude, t60] of partials) {
    const frequency = f0 * ratio;
    if (frequency > sampleRate * 0.45) continue;
    const phase = rng() * TAU;
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      out[i] += amplitude * Math.sin(TAU * frequency * t + phase) * Math.exp((-6.9 * t) / t60);
    }
  }
  // Hammer: 10 ms band-limited noise.
  const hammerLength = Math.max(1, Math.floor(0.01 * sampleRate));
  const hammer = new Float32Array(hammerLength);
  for (let i = 0; i < hammerLength; i++) hammer[i] = (rng() * 2 - 1) * Math.exp(-i / (0.0012 * sampleRate));
  const hammerBanded = biquad(hammer, 'bandpass', 3400, 1.1, sampleRate);
  for (let i = 0; i < hammerLength; i++) out[i] += hammerBanded[i] * 0.6 * velocity;
  // Wooden case thud.
  const thudLength = Math.max(1, Math.floor(0.05 * sampleRate));
  for (let i = 0; i < thudLength; i++) {
    const t = i / sampleRate;
    out[i] += Math.sin(TAU * 180 * t) * Math.exp(-t / 0.012) * 0.25;
  }
  const lowpassed = biquad(out, 'lowpass', 7000, 0.707, sampleRate);
  out.set(lowpassed);
  const fadeIn = Math.min(48, length);
  for (let i = 0; i < fadeIn; i++) out[i] *= i / fadeIn;
  const fadeOut = Math.min(Math.floor(0.01 * sampleRate), length);
  for (let i = 0; i < fadeOut; i++) out[length - 1 - i] *= i / fadeOut;
  return normalisePeak(out, 0.82 * clamp(velocity, 0.05, 1) ** 1.2);
}

// ---------------------------------------------------------------------------
// Flute: additive air-column tone with a delayed vibrato and breath noise.
// Original synthesis for this study.
// ---------------------------------------------------------------------------

export function flute(midi, { sampleRate, seed = 7, velocity = 0.5, hold = 0.6 } = {}) {
  const rng = mulberry32((seed ^ Math.imul(1301 + Math.round(midi * 10), 0xc2b2ae35)) >>> 0);
  const f0 = midiToHz(midi);
  const release = 0.35;
  const length = Math.max(1, Math.floor((hold + release) * sampleRate));
  const out = new Float32Array(length);
  const harmonics = [
    [1, 1],
    [2, 0.3],
    [3, 0.14],
    [4, 0.06],
    [5, 0.028],
  ];
  for (const [ratio, amplitude] of harmonics) {
    const frequency = f0 * ratio;
    if (frequency > sampleRate * 0.42) continue;
    let phase = rng() * TAU;
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      const vibratoStart = 0.18;
      // Bounded, integrated vibrato: the instantaneous frequency returns to f0;
      // the pitch depth does not grow with the note's duration.
      const vibrato =
        t > vibratoStart
          ? 0.0028 * Math.min(1, (t - vibratoStart) / 0.35) * Math.sin(TAU * 5.1 * (t - vibratoStart))
          : 0;
      out[i] += amplitude * Math.sin(phase);
      phase += (TAU * frequency * (1 + vibrato)) / sampleRate;
    }
  }
  // Breath: band-limited noise following the same envelope.
  const breath = biquad(noise(sampleRate, length / sampleRate, rng), 'bandpass', 2100, 0.7, sampleRate);
  for (let i = 0; i < length; i++) out[i] += breath[i] * 0.09 * clamp(velocity, 0.05, 1);
  const holdSamples = Math.max(1, Math.floor(hold * sampleRate));
  applyEnvelope(out, sampleRate, 0.06, release, holdSamples);
  return normalisePeak(out, 0.58 * clamp(velocity, 0.05, 1) ** 0.85);
}

// ---------------------------------------------------------------------------
// Reed: stopped-pipe clarinet-like tone. Odd-harmonic weight, three formants
// and a short breath attack. Original synthesis for this study.
// ---------------------------------------------------------------------------

export function reed(midi, { sampleRate, seed = 7, velocity = 0.5, hold = 0.45, staccato = false } = {}) {
  const rng = mulberry32((seed ^ Math.imul(1901 + Math.round(midi * 10), 0x27d4eb2f)) >>> 0);
  const f0 = midiToHz(midi);
  const release = staccato ? 0.07 : 0.16;
  const length = Math.max(1, Math.floor((hold + release) * sampleRate));
  const out = new Float32Array(length);
  for (let harmonic = 1; harmonic <= 13; harmonic++) {
    const frequency = f0 * harmonic;
    if (frequency > sampleRate * 0.42) continue;
    const odd = harmonic % 2 === 1;
    const base = (odd ? 1 : 0.42) / harmonic ** 1.12;
    const formant1 = 0.35 + 0.65 * Math.exp(-(((frequency - 1100) / 850) ** 2));
    const formant2 = 0.2 + 0.35 * Math.exp(-(((frequency - 2600) / 1300) ** 2));
    const amplitude = base * (formant1 + formant2);
    const phase = rng() * TAU;
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      const flutter = 1 + 0.012 * Math.sin(TAU * 4.6 * t);
      out[i] += amplitude * flutter * Math.sin(TAU * frequency * t + phase);
    }
  }
  const breath = biquad(noise(sampleRate, length / sampleRate, rng), 'bandpass', 1500, 1.1, sampleRate);
  for (let i = 0; i < length; i++) out[i] += breath[i] * 0.07 * clamp(velocity, 0.05, 1);
  const holdSamples = Math.max(1, Math.floor(hold * sampleRate));
  applyEnvelope(out, sampleRate, staccato ? 0.012 : 0.035, release, holdSamples);
  return normalisePeak(out, 0.55 * clamp(velocity, 0.05, 1) ** 0.85);
}

// ---------------------------------------------------------------------------
// Harp: compact Karplus-Strong string after the MIT upstream harp preset.
// Fractional delay, one-pole loop loss and a frequency-dependent decay.
// ---------------------------------------------------------------------------

export function harp(midi, { sampleRate, seed = 7, velocity = 0.5, hold = 2.4 } = {}) {
  const f0 = midiToHz(midi);
  const rng = mulberry32((seed ^ Math.imul(2609 + Math.round(midi * 10), 0x165667b1)) >>> 0);
  const ring = 1.6;
  const length = Math.max(1, Math.floor((hold + ring) * sampleRate));
  const delay = Math.max(4, sampleRate / f0 - 0.5);
  const bufferLength = Math.ceil(delay) + 4;
  const buffer = new Float32Array(bufferLength);
  const out = new Float32Array(length);
  const t60 = clamp(6.0 * (220 / Math.max(f0, 60)) ** 0.35, 1.4, 7.5);
  const loopGain = 10 ** (-3 / (t60 * f0));
  const damp = 0.4;
  let index = 0;
  let previous = 0;
  const excitationLength = Math.max(2, Math.round(sampleRate / f0));
  // A zero-mean triangular displacement plus a little noise. The mean removal
  // is important: a positive-only pluck shape would inject DC into the loop.
  const excitation = new Float32Array(excitationLength);
  let excitationMean = 0;
  for (let i = 0; i < excitationLength; i++) {
    const x = i / excitationLength;
    const triangle = 1 - Math.abs(2 * x - 1);
    excitation[i] = (triangle * 0.85 + (rng() * 2 - 1) * 0.15) * (1 - x) * 0.7;
    excitationMean += excitation[i];
  }
  excitationMean /= excitationLength;
  for (let i = 0; i < excitationLength; i++) excitation[i] -= excitationMean;
  for (let i = 0; i < length; i++) {
    const i0 = Math.floor(delay);
    const frac = delay - i0;
    // Read the PAST of the delay line: x[n - delay]. `index - i0` and
    // `index - i0 - 1` are the two adjacent taps; adding the buffer length
    // before the modulo handles the negative index.
    const first = buffer[(index - i0 + bufferLength) % bufferLength];
    const second = buffer[(index - i0 - 1 + bufferLength) % bufferLength];
    const delayed = first * (1 - frac) + second * frac;
    const filtered = delayed * (1 - damp) + previous * damp;
    previous = filtered;
    buffer[index] = (i < excitationLength ? excitation[i] : 0) + filtered * loopGain;
    out[i] = delayed;
    index = (index + 1) % bufferLength;
  }
  const holdSamples = Math.max(1, Math.floor(hold * sampleRate));
  const releaseSamples = Math.max(1, Math.floor(ring * 0.55 * sampleRate));
  for (let i = holdSamples; i < length; i++) out[i] *= Math.exp((-6.9 * (i - holdSamples)) / releaseSamples);
  const fadeIn = Math.min(32, length);
  for (let i = 0; i < fadeIn; i++) out[i] *= i / fadeIn;
  const fadeOut = Math.min(Math.floor(0.02 * sampleRate), length);
  for (let i = 0; i < fadeOut; i++) out[length - 1 - i] *= i / fadeOut;
  return normalisePeak(out, 0.72 * clamp(velocity, 0.05, 1) ** 0.9);
}

/** Dispatch by declared voice name; unknown voices are a hard authoring error. */
export function synthesize(voice, midi, options) {
  if (voice === 'musicbox') return musicBox(midi, options);
  if (voice === 'toy') return toyPiano(midi, options);
  if (voice === 'flute') return flute(midi, options);
  if (voice === 'reed') return reed(midi, options);
  if (voice === 'harp') return harp(midi, options);
  throw new Error(`storybook-score: unknown voice "${voice}"`);
}

/**
 * A small deterministic Schroeder room (four damped combs, two allpasses) on a
 * mono send. This is synthesis, not convolution and not a claim about a real
 * space; the same input always produces the same bytes.
 */
export function room(send, sampleRate) {
  const length = send.length;
  const out = [new Float32Array(length), new Float32Array(length)];
  const delays = [0.0297, 0.0371, 0.0411, 0.0437];
  const feedbacks = [0.78, 0.76, 0.74, 0.72];
  for (let channel = 0; channel < 2; channel++) {
    const combs = delays.map((delay, index) => ({
      buffer: new Float32Array(Math.max(1, Math.round((delay + channel * 0.0011) * sampleRate))),
      index: 0,
      damp: 0,
      feedback: feedbacks[index],
    }));
    const allpasses = [0.005, 0.0017].map(delay => ({
      buffer: new Float32Array(Math.max(1, Math.round((delay + channel * 0.0007) * sampleRate))),
      index: 0,
    }));
    for (let i = 0; i < length; i++) {
      let sum = 0;
      for (const comb of combs) {
        const value = comb.buffer[comb.index];
        comb.damp = value * 0.7 + comb.damp * 0.3;
        comb.buffer[comb.index] = send[i] + comb.damp * comb.feedback;
        comb.index = (comb.index + 1) % comb.buffer.length;
        sum += value;
      }
      let value = sum * 0.25;
      for (const allpass of allpasses) {
        const buffered = allpass.buffer[allpass.index];
        const produced = buffered - 0.5 * value;
        allpass.buffer[allpass.index] = value + 0.5 * produced;
        allpass.index = (allpass.index + 1) % allpass.buffer.length;
        value = produced;
      }
      out[channel][i] = value;
    }
  }
  return out;
}
