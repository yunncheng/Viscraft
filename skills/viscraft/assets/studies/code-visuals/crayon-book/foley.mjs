/**
 * Wax friction and wet pigment, attached to this page's visible mark growth.
 * Filter/noise and material-band methods adapted from LemoLab (MIT),
 * lemo-opuscar@e3cb16f63768c68693ff0e15171d6e755457cc32:
 * styles/urban-sketch/demo/audio/foley.py (pen/wet), core/audio/sfx.py.
 * See LICENSES.md. No upstream story, movement track or recordings are used.
 */
import { PAGE_ACTIONS, pageActionAt } from './action-facts.mjs';
const TAU = Math.PI * 2;

function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function whiteNoise(length, rng) {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = rng() * 2 - 1;
  return out;
}

function onePoleLowpass(input, cutoff, sampleRate, passes = 1) {
  const out = new Float32Array(input.length);
  const a = clamp(1 - Math.exp((-TAU * Math.max(1, cutoff)) / sampleRate), 1e-6, 1);
  for (let p = 0; p < passes; p++) {
    let state = 0;
    for (let i = 0; i < input.length; i++) {
      const x = p === 0 ? input[i] : out[i];
      state += a * (x - state);
      out[i] = state;
    }
  }
  return out;
}

function onePoleHighpass(input, cutoff, sampleRate, passes = 1) {
  const out = new Float32Array(input.length);
  const a = 1 / (1 + (TAU * Math.max(1, cutoff)) / sampleRate);
  for (let p = 0; p < passes; p++) {
    let state = 0;
    let previous = 0;
    for (let i = 0; i < input.length; i++) {
      const x = p === 0 ? input[i] : out[i];
      state = a * (state + x - previous);
      previous = x;
      out[i] = state;
    }
  }
  return out;
}

function bandpass(input, low, high, sampleRate, passes = 1) {
  return onePoleLowpass(onePoleHighpass(input, low, sampleRate, passes), high, sampleRate, passes);
}

export function buildFoley({ duration = 10 } = {}) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('crayon foley: duration must be positive');
  return {
    seconds: duration,
    events: [['drawOutline', 'wax-outline', 0.09], ['drawFill', 'wax-colour', 0.07], ['wash', 'wet-pigment', 0.07]]
      .map(([action, material, gain]) => ({ action, material, gain,
        time: PAGE_ACTIONS[action][0] * duration,
        duration: (PAGE_ACTIONS[action][1] - PAGE_ACTIONS[action][0]) * duration })),
  };
}

function normalise(signal) {
  let peak = 0;
  for (const value of signal) peak = Math.max(peak, Math.abs(value));
  if (peak > 0) for (let i = 0; i < signal.length; i++) signal[i] /= peak;
  return signal;
}

export function renderFoley({ sampleRate, channels, frames, params = {}, seed = 7321 }) {
  const score = buildFoley(params);
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || channels !== 2 ||
      !Number.isInteger(frames) || frames !== Math.round(score.seconds * sampleRate))
    throw new Error('crayon foley: expected an exact stereo sample span at the declared duration');
  const output = [new Float32Array(frames), new Float32Array(frames)];
  const rng = mulberry32(seed);
  const attacks = [];
  for (const event of score.events) {
    // Half-open sample interval: sound never leaks into a non-drawing hold.
    const start = Math.ceil(event.time * sampleRate);
    const end = Math.min(frames, Math.ceil((event.time + event.duration) * sampleRate));
    const length = end - start;
    const wet = event.action === 'wash';
    const noise = whiteNoise(length, rng);
    const grain = normalise(bandpass(noise, wet ? 180 : 1300, wet ? 2600 : 6100, sampleRate, 2));
    const body = normalise(onePoleLowpass(whiteNoise(length, rng), wet ? 30 : 700, sampleRate));
    const [a, b] = PAGE_ACTIONS[event.action];
    for (let i = 0; i < length; i++) {
      const fraction = (start + i) / sampleRate / score.seconds;
      const u = Math.max(0, Math.min(1, (fraction - a) / (b - a)));
      // Derivative of the SAME smoothstep used by the picture: no movement,
      // no friction; maximum growth has the strongest material energy.
      const activity = 4 * u * (1 - u);
      const edge = Math.min(1, i / (sampleRate * 0.008), (length - 1 - i) / (sampleRate * 0.008));
      const voice = wet ? grain[i] * (0.5 + 0.8 * Math.abs(body[i])) : grain[i] + body[i] * 0.22;
      const value = voice * activity * edge * event.gain * Math.SQRT1_2;
      output[0][start + i] += value;
      output[1][start + i] += value;
    }
    attacks.push({ action: event.action, startSample: start, endSample: end,
      pictureProgressAtStart: pageActionAt(event.time / score.seconds)[event.action] });
  }
  return { channels: output, report: { seconds: score.seconds, attacks,
    scope: 'procedural mark-growth texture, not a recorded crayon or per-stroke contact reconstruction' } };
}
