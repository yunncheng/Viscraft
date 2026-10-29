/**
 * Programmatic voices for the cartoon-jazz reference.
 *
 * Every sound here is SYNTHESISED in JavaScript. There is no recorded sample,
 * no sample pack, no TTS and no drum library: the stride piano, tuba, banjo,
 * trumpet, clarinet, xylophone, brushes, cymbals, ticks, springs and slide
 * whistles are all generated from oscillators, deterministic noise and simple
 * filters. A synthesised trumpet is not a recorded trumpet; this file is named
 * so no listener mistakes one for the other.
 *
 * Adapted (not translated line-for-line) from lemo-opuscar
 * core/audio/pluck.py (Karplus-Strong waveguide and body resonance) and
 * core/audio/sfx.py (pan mixing, one-pole filtering, band-limited noise) plus
 * styles/rubber-hose/demo/music/score.py (the slide-whistle and spring-boing
 * gestures and the small synthetic room), commit
 * e3cb16f63768c68693ff0e15171d6e755457cc32, LemoLab, MIT. See LICENSES.md.
 *
 * Contract: every voice returns a mono Float32Array with a peak of at most 1,
 * for a requested duration and sample rate. All randomness is a seeded
 * mulberry32 stream, so a score and seed render the same signal.
 */

const TWO_PI = Math.PI * 2;

// A linear-interpolated sine table is materially faster than Math.sin in the
// inner additive loops and is accurate enough for these voices.
const TABLE_SIZE = 4096;
const SINE = new Float32Array(TABLE_SIZE + 1);
for (let i = 0; i <= TABLE_SIZE; i++) SINE[i] = Math.sin((TWO_PI * i) / TABLE_SIZE);

function sinCycle(cycles) {
  const wrapped = cycles - Math.floor(cycles);
  const x = wrapped * TABLE_SIZE;
  const i = x | 0;
  const f = x - i;
  return SINE[i] + (SINE[i + 1] - SINE[i]) * f;
}

/** Deterministic 32-bit PRNG; the same seed always produces the same stream. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOTE_OFFSETS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Parse `A4`, `Bb3`, `F#5`, `C-1` to a MIDI number. */
export function pitchToMidi(pitch) {
  if (typeof pitch === 'number') return pitch;
  const match = /^\s*([A-Ga-g])([#sb]*)(-?\d+)\s*$/.exec(String(pitch));
  if (!match) throw new Error(`cartoon-jazz: cannot parse pitch ${JSON.stringify(pitch)}`);
  const letter = match[1].toUpperCase();
  const accidentals = match[2];
  return (
    12 * (Number(match[3]) + 1) +
    NOTE_OFFSETS[letter] +
    accidentals.split('#').length -
    1 -
    (accidentals.split('b').length - 1) +
    (accidentals.split('s').length - 1)
  );
}

export function midiToHz(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

function voiceLength(sampleRate, seconds) {
  return Math.max(4, Math.ceil(seconds * sampleRate));
}

function normalizePeak(samples, target = 1) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  if (peak < 1e-9) return samples;
  const gain = target / peak;
  for (let i = 0; i < samples.length; i++) samples[i] *= gain;
  return samples;
}

/** One-pole low-pass state used by several voices. */
function onePole(cutoffHz, sampleRate) {
  return 1 - Math.exp((-TWO_PI * Math.max(20, cutoffHz)) / sampleRate);
}

/** RBJ band-pass (constant skirt gain), returned as a stateful step object. */
function bandPass(f0, q, sampleRate) {
  const w0 = (TWO_PI * clamp(f0, 20, sampleRate * 0.49)) / sampleRate;
  const alpha = Math.sin(w0) / (2 * clamp(q, 0.1, 20));
  const a0 = 1 + alpha;
  return {
    b0: alpha / a0,
    b2: -alpha / a0,
    a1: (-2 * Math.cos(w0)) / a0,
    a2: (1 - alpha) / a0,
    x1: 0,
    x2: 0,
    y1: 0,
    y2: 0,
    step(x) {
      const y = this.b0 * x + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1;
      this.x1 = x;
      this.y2 = this.y1;
      this.y1 = y;
      return y;
    },
  };
}

function noise(rng) {
  return rng() * 2 - 1;
}

// ---------------------------------------------------------------------------
// Pitched voices
// ---------------------------------------------------------------------------

/** Struck upright piano: seven harmonics, per-harmonic decay and a hammer tap. */
export function piano({ midi, duration, sampleRate, seed }) {
  const f = midiToHz(midi);
  const release = 0.14;
  const n = voiceLength(sampleRate, duration + release);
  const out = new Float32Array(n);
  const nyquist = sampleRate * 0.45;
  const t60 = 1.9 * Math.pow(220 / Math.max(f, 60), 0.35);
  const partials = [];
  for (let k = 1; k <= 7; k++) {
    const fk = f * k * (1 + 0.00035 * k * k);
    if (fk >= nyquist) continue;
    partials.push({
      inc: fk / sampleRate,
      amp: Math.pow(k, -1.35),
      decay: (6.9 / t60) * (1 + 0.55 * (k - 1)),
    });
  }
  const rng = mulberry32((seed ^ 0x51ed270b) >>> 0);
  const hammerSamples = Math.max(1, Math.round(0.008 * sampleRate));
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let sum = 0;
    for (const partial of partials) {
      sum += partial.amp * Math.exp(-partial.decay * t) * sinCycle(partial.inc * i);
    }
    if (i < hammerSamples) sum += noise(rng) * 0.18 * Math.exp(-t / 0.0015);
    const attack = Math.min(1, t / 0.004);
    const releaseGain = t <= duration ? 1 : Math.exp(-(t - duration) / 0.045);
    out[i] = sum * attack * releaseGain;
  }
  return normalizePeak(out, 1);
}

/** Tuba oom: a dark harmonic stack through a time-varying one-pole low-pass. */
export function tuba({ midi, duration, sampleRate, seed }) {
  const f = midiToHz(midi);
  const n = voiceLength(sampleRate, duration + 0.1);
  const out = new Float32Array(n);
  const nyquist = sampleRate * 0.45;
  const rng = mulberry32((seed ^ 0x37a9b1c5) >>> 0);
  let lp = 0;
  let breath = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let sum = 0;
    for (let k = 1; k <= 16; k++) {
      const fk = f * k;
      if (fk >= nyquist) break;
      sum += (1 / k) * sinCycle((fk * i) / sampleRate);
    }
    const cutoff = 260 + 420 * Math.min(1, t / 0.035) * Math.exp(-t / 0.22);
    lp += onePole(cutoff, sampleRate) * (sum - lp);
    breath += onePole(900, sampleRate) * (noise(rng) - breath);
    const attack = Math.min(1, t / 0.03);
    const releaseGain = t <= duration ? 1 : Math.exp(-(t - duration) / 0.05);
    out[i] = (lp + breath * 0.04) * attack * releaseGain;
  }
  return normalizePeak(out, 1);
}

/** Trumpet / trombone: bright harmonic stack with a delayed vibrato and scoop. */
function brass({ midi, duration, sampleRate, seed, muted = false, dark = false }) {
  const f = midiToHz(midi);
  const n = voiceLength(sampleRate, duration + 0.16);
  const out = new Float32Array(n);
  const nyquist = sampleRate * 0.45;
  const rng = mulberry32((seed ^ (muted ? 0x7f4a7c15 : 0x2c1b3d4e)) >>> 0);
  const formant = dark ? 700 : muted ? 1500 : 1150;
  const formantWidth = dark ? 500 : 700;
  const vibratoRate = dark ? 4.6 : 5.4;
  let phase = 0;
  let lp = 0;
  let hp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const scoop = 1 - 0.012 * Math.exp(-t / 0.03);
    const vibratoDepth = 0.004 * clamp((t - 0.14) / 0.2, 0, 1);
    const vibrato = 1 + vibratoDepth * Math.sin(TWO_PI * vibratoRate * Math.max(0, t - 0.14));
    phase += (f * scoop * vibrato) / sampleRate;
    let sum = 0;
    for (let k = 1; k <= 18; k++) {
      const fk = f * k * scoop;
      if (fk >= nyquist) break;
      const formantGain = 1 + 0.9 * Math.exp(-Math.pow((fk - formant) / formantWidth, 2));
      sum += (Math.pow(k, dark ? -1.05 : -0.95) * formantGain) * sinCycle(phase * k);
    }
    const cutoff = muted
      ? t < 0.12
        ? 350 + (2400 - 350) * (t / 0.12)
        : duration > 0.6 && t > 0.42
          ? Math.max(420, 2400 - 1700 * Math.min(1, (t - 0.42) / 0.55))
          : 2400
      : dark
        ? 1600
        : 5200;
    lp += onePole(cutoff, sampleRate) * (sum - lp);
    if (muted) {
      hp += onePole(1400, sampleRate) * (lp - hp);
      lp = lp * 0.55 + (lp - hp) * 0.45;
    }
    const attack = Math.min(1, t / (dark ? 0.045 : 0.022));
    const releaseGain = t <= duration ? 1 : Math.exp(-(t - duration) / 0.06);
    out[i] = (lp + noise(rng) * 0.012) * attack * releaseGain;
  }
  return normalizePeak(out, 1);
}

export function trumpet(args) {
  return brass(args);
}

export function trumpetMuted(args) {
  return brass({ ...args, muted: true });
}

export function trombone(args) {
  return brass({ ...args, dark: true });
}

/** Clarinet: odd-harmonic pulse with a breathy edge and a light formant. */
export function clarinet({ midi, duration, sampleRate, seed }) {
  const f = midiToHz(midi);
  const n = voiceLength(sampleRate, duration + 0.1);
  const out = new Float32Array(n);
  const nyquist = sampleRate * 0.45;
  const rng = mulberry32((seed ^ 0x0badf00d) >>> 0);
  let phase = 0;
  let breath = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const vibratoDepth = 0.0028 * clamp((t - 0.18) / 0.25, 0, 1);
    const vibrato = 1 + vibratoDepth * Math.sin(TWO_PI * 4.8 * Math.max(0, t - 0.18));
    phase += (f * vibrato) / sampleRate;
    let sum = 0;
    for (let k = 1; k <= 11; k += 2) {
      const fk = f * k;
      if (fk >= nyquist) break;
      const formantGain = 1 + 0.45 * Math.exp(-Math.pow((fk - 1500) / 900, 2));
      sum += (Math.pow(k, -1.15) * formantGain) * sinCycle(phase * k);
    }
    sum += 0.12 * sinCycle(phase * 2); // a little even harmonic; not a pure square
    breath += onePole(2600, sampleRate) * (noise(rng) - breath);
    const attack = Math.min(1, t / 0.015);
    const releaseGain = t <= duration ? 1 : Math.exp(-(t - duration) / 0.05);
    out[i] = (sum * 0.9 + breath * 0.03) * attack * releaseGain;
  }
  return normalizePeak(out, 1);
}

/**
 * Banjo: a Karplus-Strong delay loop with a bright pick excitation, a short
 * body-resonance layer and a plucked-string release. The fractional delay is a
 * third-order Lagrange interpolator (the same technique as the upstream
 * pluck.py waveguide). The one-pole loop filter `0.5*(read+last)` contributes
 * exactly one sample of phase delay at low frequencies, so the delay line is
 * `sampleRate/f - 1`; the loop period is then sampleRate/f, not a rounded
 * integer. Independent measurement over the used register (midi 64–81) is
 * within about 1.2 cents at 44.1/48 kHz; midi 84 is about 1.3 cents.
 */
export function banjo({ midi, duration, sampleRate, seed }) {
  const f = midiToHz(midi);
  const targetDelay = sampleRate / f;
  const loopDelay = Math.max(1.5, targetDelay - 1.0); // one-pole loop filter adds 1
  const integerDelay = Math.floor(loopDelay);
  const size = integerDelay + 4;
  const buffer = new Float32Array(size);
  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  let low = 0;
  for (let i = 0; i < size; i++) {
    low = 0.35 * noise(rng) + 0.65 * low;
    buffer[i] = low * (1 - 0.35 * (i / size));
  }
  const loopGain = Math.pow(10, -3 / Math.max(0.25, 1.15 * f));
  const n = voiceLength(sampleRate, duration + 0.2);
  const out = new Float32Array(n);
  let index = 0;
  let last = 0;
  for (let i = 0; i < n; i++) {
    const readPosition = index - loopDelay;
    const ri = Math.floor(readPosition);
    const fr = readPosition - ri;
    const x0 = buffer[(ri - 1 + size * 2) % size];
    const x1 = buffer[(ri + size * 2) % size];
    const x2 = buffer[(ri + 1 + size * 2) % size];
    const x3 = buffer[(ri + 2 + size * 2) % size];
    const c0 = (-fr * (fr - 1) * (fr - 2)) / 6;
    const c1 = ((fr + 1) * (fr - 1) * (fr - 2)) / 2;
    const c2 = (-(fr + 1) * fr * (fr - 2)) / 2;
    const c3 = ((fr + 1) * fr * (fr - 1)) / 6;
    const read = c0 * x0 + c1 * x1 + c2 * x2 + c3 * x3;
    last = 0.5 * (read + last);
    buffer[index] = last * loopGain;
    out[i] = last;
    index = (index + 1) % size;
  }
  const pickSamples = Math.max(1, Math.round(0.006 * sampleRate));
  const pickRng = mulberry32((seed ^ 0x1b873593) >>> 0);
  for (let i = 0; i < Math.min(n, pickSamples); i++) {
    out[i] += noise(pickRng) * 0.3 * Math.exp(-i / (0.0015 * sampleRate));
  }
  // A small banjo body: a few short resonances, deliberately not a sample.
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const body =
      0.22 * Math.sin(TWO_PI * 380 * t) * Math.exp(-t / 0.055) +
      0.16 * Math.sin(TWO_PI * 860 * t) * Math.exp(-t / 0.04);
    out[i] += body;
    const releaseGain = t <= duration ? 1 : Math.exp(-(t - duration) / 0.045);
    out[i] *= releaseGain;
  }
  return normalizePeak(out, 1);
}

/** Xylophone bar: inharmonic partials with very different decay times. */
export function xylophone({ midi, duration, sampleRate, seed }) {
  const f = midiToHz(midi);
  const n = voiceLength(sampleRate, Math.min(duration + 0.3, 2.2));
  const out = new Float32Array(n);
  const partials = [
    [1, 1, 0.5],
    [3.0, 0.42, 0.2],
    [6.25, 0.2, 0.11],
    [9.9, 0.09, 0.06],
  ];
  const rng = mulberry32((seed ^ 0xd1b54a32) >>> 0);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let sum = 0;
    for (const [ratio, amp, tau] of partials) {
      const fk = f * ratio;
      if (fk >= sampleRate * 0.45) continue;
      sum += amp * Math.sin(TWO_PI * fk * t) * Math.exp(-6.9 * t / tau);
    }
    if (t < 0.004) sum += noise(rng) * 0.25 * Math.exp(-t / 0.0012);
    const releaseGain = t <= duration ? 1 : Math.exp(-(t - duration) / 0.04);
    out[i] = sum * releaseGain;
  }
  return normalizePeak(out, 1);
}

// ---------------------------------------------------------------------------
// Percussion and comedy foley
// ---------------------------------------------------------------------------

/** Brushed snare sweep: band-limited noise with a slow brush attack. */
export function brush({ duration, sampleRate, seed }) {
  const n = voiceLength(sampleRate, duration);
  const out = new Float32Array(n);
  const rng = mulberry32((seed ^ 0x85ebca6b) >>> 0);
  const bp = bandPass(2600, 0.65, sampleRate);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = (1 - Math.exp(-t / 0.05)) * Math.exp(-t / (duration * 0.72));
    out[i] = bp.step(noise(rng)) * env;
  }
  return normalizePeak(out, 1);
}

/** Snare tap: a short noise crack over a 185 Hz body. */
export function snare({ duration = 0.2, sampleRate, seed }) {
  const n = voiceLength(sampleRate, duration);
  const out = new Float32Array(n);
  const rng = mulberry32((seed ^ 0xc2b2ae35) >>> 0);
  const bp = bandPass(2400, 0.55, sampleRate);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const crack = bp.step(noise(rng)) * Math.exp(-t / 0.045);
    const body = Math.sin(TWO_PI * 185 * t) * Math.exp(-t / 0.035) * 0.45;
    out[i] = crack + body;
  }
  return normalizePeak(out, 1);
}

/** Bass drum: a pitch-dropping sine plus a beater click. */
export function bassDrum({ duration = 0.3, sampleRate, seed }) {
  const n = voiceLength(sampleRate, duration);
  const out = new Float32Array(n);
  const rng = mulberry32((seed ^ 0x27d4eb2f) >>> 0);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const f = 96 * Math.exp(-t / 0.09) + 46;
    phase += f / sampleRate;
    const thump = Math.sin(TWO_PI * phase) * Math.exp(-t / 0.11);
    const click = t < 0.008 ? noise(rng) * 0.3 * Math.exp(-t / 0.002) : 0;
    out[i] = thump + click;
  }
  return normalizePeak(out, 1);
}

/** Cymbal: a crowd of inharmonic metallic partials plus high noise. */
export function cymbal({ duration = 0.8, sampleRate, seed }) {
  const n = voiceLength(sampleRate, duration);
  const out = new Float32Array(n);
  const rng = mulberry32((seed ^ 0x165667b1) >>> 0);
  const partials = [205, 304, 369, 522, 641, 807, 1010, 1290, 1580, 2000, 2500, 3100, 3900];
  let hp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let sum = 0;
    for (let k = 0; k < partials.length; k++) {
      const fk = partials[k] * (1 + 0.0007 * k);
      if (fk >= sampleRate * 0.45) continue;
      sum += (0.5 / (1 + k * 0.35)) * Math.sin(TWO_PI * fk * t + k) * Math.exp(-t / (0.26 + 0.025 * k));
    }
    // One-pole high-passed noise keeps the cymbal airy without a sample.
    hp += onePole(3200, sampleRate) * (noise(rng) - hp);
    const air = (noise(rng) - hp) * 0.22 * Math.exp(-t / 0.18);
    out[i] = (sum + air) * Math.min(1, t / 0.004);
  }
  return normalizePeak(out, 1);
}

/** A small clock/toaster tick: high resonant modes and a click. */
export function tick({ sampleRate, seed, midi = 84 }) {
  const n = voiceLength(sampleRate, 0.06);
  const out = new Float32Array(n);
  const rng = mulberry32((seed ^ 0x68e31da4) >>> 0);
  const base = clamp(midiToHz(midi), 900, 4200);
  const modes = [
    [base, 0.013, 1],
    [base * 1.53, 0.009, 0.6],
    [base * 2.27, 0.006, 0.35],
  ];
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let sum = 0;
    for (const [f, tau, amp] of modes) sum += amp * Math.sin(TWO_PI * f * t) * Math.exp(-t / tau);
    if (t < 0.003) sum += noise(rng) * 0.4 * Math.exp(-t / 0.0008);
    out[i] = sum;
  }
  return normalizePeak(out, 1);
}

/** A woodblock knock: two or three dry modes with a short body. */
export function woodblock({ sampleRate, seed, midi = 72 }) {
  const n = voiceLength(sampleRate, 0.14);
  const out = new Float32Array(n);
  const rng = mulberry32((seed ^ 0x7feb352d) >>> 0);
  const base = clamp(midiToHz(midi), 380, 1800);
  const modes = [
    [base, 0.028, 1],
    [base * 1.61, 0.019, 0.55],
    [base * 2.72, 0.011, 0.28],
  ];
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let sum = 0;
    for (const [f, tau, amp] of modes) sum += amp * Math.sin(TWO_PI * f * t) * Math.exp(-t / tau);
    if (t < 0.005) sum += noise(rng) * 0.35 * Math.exp(-t / 0.0012);
    out[i] = sum;
  }
  return normalizePeak(out, 1);
}

/**
 * Spring "boing": a downward FM chirp with a wobble. This is the same gesture
 * as the upstream score's boing, reimplemented without NumPy.
 */
export function boing({ sampleRate, seed, midi = 57, duration = 0.55 }) {
  const n = voiceLength(sampleRate, duration);
  const out = new Float32Array(n);
  const f0 = midiToHz(midi);
  let phase = 0;
  let modPhase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const f = f0 * (1 + 0.9 * Math.exp(-t * 9)) * (1 + 0.12 * Math.sin(TWO_PI * 18 * t) * Math.exp(-t * 3));
    phase += f / sampleRate;
    modPhase += (f * 1.5) / sampleRate;
    const x = Math.sin(TWO_PI * phase + 2.2 * Math.sin(TWO_PI * modPhase) * Math.exp(-t * 5));
    out[i] = x * Math.exp(-t * 4.5) * Math.min(1, t / 0.004);
  }
  return normalizePeak(out, 1);
}

/**
 * Slide whistle: an exponential glide with a breath band. `midiTo` is the end
 * pitch; the caller supplies it because a whistle is a gesture, not a note.
 */
export function slideWhistle({ midi, midiTo, duration, sampleRate, seed }) {
  const n = voiceLength(sampleRate, duration);
  const out = new Float32Array(n);
  const f0 = midiToHz(midi);
  const f1 = midiToHz(midiTo ?? midi + 12);
  const rng = mulberry32((seed ^ 0x2545f491) >>> 0);
  let phase = 0;
  const breath = bandPass(3200, 0.7, sampleRate);
  for (let i = 0; i < n; i++) {
    const u = i / Math.max(1, n - 1);
    const t = i / sampleRate;
    const f = f0 * Math.pow(f1 / f0, u) * (1 + 0.006 * Math.sin(TWO_PI * 6 * t));
    phase += f / sampleRate;
    const env = Math.min(1, t / 0.03) * Math.min(1, (n - i) / (0.05 * sampleRate));
    out[i] = (Math.sin(TWO_PI * phase) + 0.12 * Math.sin(TWO_PI * 2 * phase) + 0.08 * breath.step(noise(rng))) * env;
  }
  return normalizePeak(out, 1);
}

// ---------------------------------------------------------------------------
// Mixing and room
// ---------------------------------------------------------------------------

/** Equal-power pan of a mono voice into a stereo bus, with hard bounds. */
export function addToBus(bus, samples, at, gain, pan) {
  const left = bus[0];
  const right = bus[1];
  const angle = ((clamp(pan ?? 0, -1, 1) + 1) * Math.PI) / 4;
  const gl = Math.SQRT2 * Math.cos(angle) * gain;
  const gr = Math.SQRT2 * Math.sin(angle) * gain;
  for (let i = 0; i < samples.length; i++) {
    const index = at + i;
    if (index >= left.length) break;
    if (index < 0) continue;
    left[index] += samples[i] * gl;
    right[index] += samples[i] * gr;
  }
}

/**
 * A small deterministic Schroeder room (four damped combs + two allpasses) fed
 * by a mono send. This is synthesis, not convolution and not a claim about a
 * real room. It is applied to the music bus only; close foley stays dry.
 */
export function room(send, sampleRate) {
  const n = send.length;
  const out = [new Float32Array(n), new Float32Array(n)];
  const delays = [0.0297, 0.0371, 0.0411, 0.0437];
  const feedbacks = [0.79, 0.77, 0.75, 0.73];
  for (let channel = 0; channel < 2; channel++) {
    const lines = delays.map((delay, i) => ({
      buffer: new Float32Array(Math.max(2, Math.round((delay + channel * 0.0011) * sampleRate))),
      index: 0,
      damp: 0,
      feedback: feedbacks[i],
    }));
    const allpasses = [0.005, 0.0017].map(delay => ({
      buffer: new Float32Array(Math.max(2, Math.round((delay + channel * 0.0007) * sampleRate))),
      index: 0,
    }));
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (const line of lines) {
        const value = line.buffer[line.index];
        line.damp = value * 0.7 + line.damp * 0.3;
        line.buffer[line.index] = send[i] + line.damp * line.feedback;
        line.index = (line.index + 1) % line.buffer.length;
        sum += value;
      }
      let value = sum * 0.25;
      for (const allpass of allpasses) {
        const buffered = allpass.buffer[allpass.index];
        const output = buffered - 0.5 * value;
        allpass.buffer[allpass.index] = value + 0.5 * output;
        allpass.index = (allpass.index + 1) % allpass.buffer.length;
        value = output;
      }
      out[channel][i] = value;
    }
  }
  return out;
}

/** Per-voice dispatch. `midiTo` is only used by the slide whistle. */
export function synthesise(voice, args) {
  switch (voice) {
    case 'piano':
      return piano(args);
    case 'tuba':
      return tuba(args);
    case 'trumpet':
      return trumpet(args);
    case 'trumpetMuted':
      return trumpetMuted(args);
    case 'trombone':
      return trombone(args);
    case 'clarinet':
      return clarinet(args);
    case 'banjo':
      return banjo(args);
    case 'xylophone':
      return xylophone(args);
    case 'brush':
      return brush(args);
    case 'snare':
      return snare(args);
    case 'bassDrum':
      return bassDrum(args);
    case 'cymbal':
      return cymbal(args);
    case 'tick':
      return tick(args);
    case 'woodblock':
      return woodblock(args);
    case 'boing':
      return boing(args);
    case 'slideWhistle':
      return slideWhistle(args);
    default:
      throw new Error(`cartoon-jazz: unknown synthetic voice "${voice}"`);
  }
}
