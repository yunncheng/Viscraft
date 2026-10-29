/*
 * Viscraft author module: sound-arrange
 *
 * Arranges the eight pinned CC0 recordings in `samples/` into a
 * short, structured score on the SAME frame clock as the picture. This file is
 * plain, dependency-free ESM: it runs in the browser sound scene
 * (`window.viscraftSound`), in the picture
 * slate (`window.viscraft`) and directly in Node for authoring/tests.
 *
 * What is adapted, and from where
 * -------------------------------
 * The *mechanisms* — round-robin/velocity sample selection, envelope shaping,
 * one-shot truncation, pitched playback by resampling, and the event-score
 * (sections, accents, a rest) — are adapted from LemoLab's `lemo-opuscar`
 * (MIT, commit e3cb16f6) `core/audio/sampler.py`, `core/audio/sfx.py`,
 * `core/audio/pluck.py`, `styles/living-screencast/demo/sound.py` and
 * `styles/pictogram-motion/demo/music/music.py`, and from the event/era score
 * layout of `huashu-art-motion` (MIT, commit f178bd77)
 * `scripts/audio/synth_艺术史速通.py`. The code below is an independent
 * JavaScript implementation for the current contract — no Python, no NumPy,
 * no soxr, no upstream runtime, and no Lemo/huashu media, fonts or model files
 * are copied. Karplus-Strong follows the physical model described in
 * `pluck.py` (a delay-line waveguide with a one-pole loop loss and body
 * resonance), reimplemented here.
 *
 * The eight WAV files are CC0 1.0; provenance and digests are in
 * `samples/LICENSE.md`. They are read as recordings: the
 * physical pluck is a separate synthetic low voice, never passed off as a
 * recorded cello.
 *
 * Determinism: no wall clock, no unseeded Math.random, no network. Seeded
 * jitter is used only for micro-variation (velocity/pan), never for timing:
 * every event's frame and sample are exact integers computed from the score.
 */

export const SAMPLE_PACK = {
  clap: {
    kind: 'hit',
    bus: 'perc',
    role: 'unpitched accent (three round-robin recordings)',
    files: [
      {
        file: 'clap-rr1.wav',
        repo: 'sgossner/VCSL',
        commit: 'c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e',
        path: 'Idiophones/Struck Idiophones/Claps/Clap_rr1.wav',
        bytes: 141974,
        sha256: '4c9f3fe4a34733b9be6ed9ce5e5aad48b19c1029ae9c6dd1b96294a847539e3f',
      },
      {
        file: 'clap-rr2.wav',
        repo: 'sgossner/VCSL',
        commit: 'c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e',
        path: 'Idiophones/Struck Idiophones/Claps/Clap_rr2.wav',
        bytes: 136950,
        sha256: '5ae64e838b76d0658cc541f07c3c7dcfd4b08815a915f32843a8279bf2c33b9a',
      },
      {
        file: 'clap-rr3.wav',
        repo: 'sgossner/VCSL',
        commit: 'c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e',
        path: 'Idiophones/Struck Idiophones/Claps/Clap_rr3.wav',
        bytes: 132222,
        sha256: 'e8c13dc41f31b479f8e3ec49e9dfc49c17d299cce36eedb657fe170f0e6fcb44',
      },
    ],
  },
  woodblock: {
    kind: 'hit',
    bus: 'perc',
    role: 'wooden marker for section boundaries',
    files: [
      {
        file: 'woodblock-2-mp.wav',
        repo: 'sgossner/VCSL',
        commit: 'c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e',
        path: 'Idiophones/Struck Idiophones/Woodblock/wood_click2_mp.wav',
        bytes: 370954,
        sha256: 'cfb04b07ceb70b6056ab1849cbbba53f658b4453982a6f44b4a05e19676361dd',
      },
    ],
  },
  shaker: {
    kind: 'hit',
    bus: 'perc',
    role: 'small shaker, eighth/sixteenth texture',
    files: [
      {
        file: 'shaker-double-down-rr1.wav',
        repo: 'sgossner/VCSL',
        commit: 'c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e',
        path: 'Idiophones/Struck Idiophones/Shaker, Small/Mid_ShakerDouble_Down_rr1.wav',
        bytes: 46844,
        sha256: '0df7c271e1dba4de7304f7df81886390dd9ae698bfdd6df570026af4f2223574',
      },
    ],
  },
  celloPizz: {
    kind: 'pitched',
    bus: 'music',
    rootMidi: 59, // B3, the recorded pitch of pizzT_B3
    role: 'cello-section pizzicato, two round-robin takes on B3',
    files: [
      {
        file: 'cello-pizz-b3-rr1.wav',
        repo: 'sgossner/VSCO-2-CE',
        commit: '440300901dfe9275fd84e0b7763af1f8443ae62e',
        path: 'Strings/Cello Section/pizzT/pizzT_B3_v1_RR1.wav',
        bytes: 637034,
        sha256: 'ded9d0b8a7651e21883c937fc4cce2199f0d973ca683fac5d61582093b0f00fa',
      },
      {
        file: 'cello-pizz-b3-rr2.wav',
        repo: 'sgossner/VSCO-2-CE',
        commit: '440300901dfe9275fd84e0b7763af1f8443ae62e',
        path: 'Strings/Cello Section/pizzT/pizzT_B3_v1_RR2.wav',
        bytes: 462368,
        sha256: '20cc1931f37d67a3d7dd7fbc920fff45005bacd0bb306dbeff69ce8a8dac5e0a',
      },
    ],
  },
  marimba: {
    kind: 'pitched',
    bus: 'music',
    rootMidi: 84, // C6, the recorded note Marimba_hit_Outrigger_C6_loud_01
    role: 'marimba C6, loud mallet',
    files: [
      {
        file: 'marimba-c6-loud-01.wav',
        repo: 'sgossner/VSCO-2-CE',
        commit: '440300901dfe9275fd84e0b7763af1f8443ae62e',
        path: 'Percussion/Marimba/Marimba_hit_Outrigger_C6_loud_01.wav',
        bytes: 472142,
        sha256: '2e42b1b6f6923f32e3daadc12b063e94d15af20fa410ddcb267eb906fd6e0e89',
      },
    ],
  },
};

/** Stable file order, used by the scene loader and by create.mjs. */
export const SAMPLE_FILES = Object.freeze(
  Object.values(SAMPLE_PACK).flatMap(pack => pack.files.map(entry => entry.file)),
);

/**
 * Per-voice level target: the peak a performance at velocity 0.8 should reach.
 * The recordings are conservatively captured (a cello pizz peaks at 0.04–0.08
 * full scale, a clap at 0.95), so each pack is normalised by its own median
 * take peak rather than by a shared magic gain. Take-to-take differences inside
 * a pack are preserved.
 */
export const VOICE_GAIN = Object.freeze({
  clap: 0.42,
  woodblock: 0.28,
  shaker: 0.16,
  celloPizz: 0.42,
  marimba: 0.3,
  pluck: 0.3,
});

export const DEFAULT_PARAMS = Object.freeze({
  bpm: 90,
  seconds: 6,
  fps: 24,
  mix: 1,
});

const BEAT_SECTIONS = [
  { id: 'intro', from: 0, to: 2 / 9, label: 'intro — marimba motif, shaker enters' },
  { id: 'groove', from: 2 / 9, to: 5 / 9, label: 'groove — pizzicato riff, woodblock offbeats' },
  { id: 'rest', from: 5 / 9, to: 6 / 9, label: 'rest — no new attacks; the last marimba rings' },
  { id: 'peak', from: 6 / 9, to: 8 / 9, label: 'peak — claps, sixteenth shaker, accent riff' },
  { id: 'tail', from: 8 / 9, to: 1, label: 'tail — one low pizz and one marimba into silence' },
];

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

/** Seeded PRNG (mulberry32): same seed → same stream. */
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

/** A stable per-event jitter in [-1, 1], independent of iteration order. */
export function hashUnit(seed, index) {
  let h = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 2147483648 - 1;
}

const NOTE_OFFSETS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** `'C#4'` / `'Bb3'` → MIDI number (C4 = 60). */
export function parsePitch(pitch) {
  const match = /^\s*([A-Ga-g])([#b]?)(-?\d+)\s*$/.exec(String(pitch));
  if (!match) throw new Error(`sound-arrange: cannot parse pitch ${JSON.stringify(pitch)}`);
  const accidental = match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0;
  return 12 * (Number(match[3]) + 1) + NOTE_OFFSETS[match[1].toUpperCase()] + accidental;
}

export function midiToHz(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function noteName(midi) {
  const rounded = Math.round(midi);
  return NOTE_NAMES[((rounded % 12) + 12) % 12] + (Math.floor(rounded / 12) - 1);
}

function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new Error('sound-arrange: expected WAV bytes as Uint8Array/ArrayBuffer');
}

// ---------------------------------------------------------------------------
// WAV decoding (PCM 16/24/32 and float 32, mono/stereo/multichannel)
// ---------------------------------------------------------------------------

/**
 * Decode a RIFF/WAVE byte buffer to de-interleaved Float32 channels in [-1, 1].
 * Supports PCM 8/16/24/32-bit, IEEE float 32/64-bit and WAVE_FORMAT_EXTENSIBLE.
 * Throws on anything else rather than guessing.
 */
export function decodeWav(input) {
  const bytes = toBytes(input);
  if (bytes.byteLength < 44) throw new Error('sound-arrange: WAV is too short to contain a header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = offset =>
    String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  if (ascii(0) !== 'RIFF' || ascii(8) !== 'WAVE')
    throw new Error('sound-arrange: not a RIFF/WAVE file');

  let format;
  let dataOffset = -1;
  let dataBytes = 0;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= bytes.byteLength) {
      let audioFormat = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const blockAlign = view.getUint16(body + 12, true);
      const bits = view.getUint16(body + 14, true);
      if (audioFormat === 0xfffe && body + 26 <= bytes.byteLength) audioFormat = view.getUint16(body + 24, true);
      format = { audioFormat, channels, sampleRate, blockAlign, bits };
    } else if (id === 'data') {
      dataOffset = body;
      dataBytes = Math.min(size, bytes.byteLength - body);
    }
    offset = body + size + (size % 2);
  }
  if (!format) throw new Error('sound-arrange: WAV has no fmt chunk');
  if (dataOffset < 0) throw new Error('sound-arrange: WAV has no data chunk');
  const { audioFormat, channels, sampleRate, blockAlign, bits } = format;
  if (!channels || !sampleRate) throw new Error('sound-arrange: WAV declares no channels/sample rate');
  const bytesPerSample = Math.ceil(bits / 8);
  if (blockAlign !== bytesPerSample * channels)
    throw new Error(`sound-arrange: unsupported WAV block alignment ${blockAlign} (${bits}-bit, ${channels}ch)`);
  const frames = Math.floor(dataBytes / blockAlign);
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  const read = {
    1: (at, ch) => (bytes[at + ch] - 128) / 128,
    2: (at, ch) => view.getInt16(at + ch * 2, true) / 32768,
    3: (at, ch) => {
      const i = at + ch * 3;
      let value = bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16);
      if (value & 0x800000) value -= 0x1000000;
      return value / 8388608;
    },
    4: (at, ch) => view.getInt32(at + ch * 4, true) / 2147483648,
  };
  if (audioFormat === 1) {
    const fn = read[bytesPerSample];
    if (!fn) throw new Error(`sound-arrange: unsupported PCM width ${bits} bits`);
    for (let i = 0; i < frames; i++) {
      const at = dataOffset + i * blockAlign;
      for (let ch = 0; ch < channels; ch++) out[ch][i] = fn(at, ch);
    }
  } else if (audioFormat === 3 && (bits === 32 || bits === 64)) {
    for (let i = 0; i < frames; i++) {
      const at = dataOffset + i * blockAlign;
      for (let ch = 0; ch < channels; ch++)
        out[ch][i] = bits === 32 ? view.getFloat32(at + ch * 4, true) : view.getFloat64(at + ch * 8, true);
    }
  } else {
    throw new Error(`sound-arrange: unsupported WAV encoding (format ${audioFormat}, ${bits} bits)`);
  }
  return { sampleRate, channels: out, frames, bits, audioFormat };
}

// ---------------------------------------------------------------------------
// Sample-rate conversion / pitched playback
// ---------------------------------------------------------------------------

const RESAMPLE_TAPS = 12;

/**
 * Deterministic band-limited resampling by `step` source samples per output
 * sample (step > 1 raises pitch and shortens; step < 1 lowers and lengthens it). A
 * Blackman-windowed sinc is evaluated per output sample; weights are normalised
 * so DC does not drift. No FFT, no dependency.
 */
export function resampleChannel(source, step) {
  if (!(step > 0) || !Number.isFinite(step)) throw new Error(`sound-arrange: invalid resample step ${step}`);
  if (source.length === 0) return new Float32Array(0);
  if (Math.abs(step - 1) < 1e-12) return source.slice();
  const outLength = Math.max(1, Math.floor((source.length - 1) / step) + 1);
  const out = new Float32Array(outLength);
  const wide = Math.max(1, step);
  const half = RESAMPLE_TAPS * wide;
  const cutoff = 0.5 / wide; // cycles per source sample
  const twoFc = 2 * cutoff;
  for (let n = 0; n < outLength; n++) {
    const center = n * step;
    const first = Math.max(0, Math.ceil(center - half));
    const last = Math.min(source.length - 1, Math.floor(center + half));
    let sum = 0;
    let weight = 0;
    for (let k = first; k <= last; k++) {
      const x = center - k;
      const arg = Math.PI * twoFc * x;
      const sinc = Math.abs(arg) < 1e-9 ? 1 : Math.sin(arg) / arg;
      const window =
        Math.abs(x) >= half ? 0 : 0.42 + 0.5 * Math.cos((Math.PI * x) / half) + 0.08 * Math.cos((2 * Math.PI * x) / half);
      const w = sinc * window;
      sum += source[k] * w;
      weight += w;
    }
    out[n] = weight > 1e-9 ? sum / weight : 0;
  }
  return out;
}

function onePoleLowpass(channels, cutoffHz, sampleRate) {
  const fc = clamp(cutoffHz, 20, sampleRate * 0.45);
  const a = Math.exp((-2 * Math.PI * fc) / sampleRate);
  for (const channel of channels) {
    let state = 0;
    for (let i = 0; i < channel.length; i++) {
      state = (1 - a) * channel[i] + a * state;
      channel[i] = state;
    }
  }
}

function normalizePeak(channels, target) {
  let peak = 0;
  for (const channel of channels) for (let i = 0; i < channel.length; i++) peak = Math.max(peak, Math.abs(channel[i]));
  if (peak < 1e-9) return 0;
  const gain = target / peak;
  for (const channel of channels) for (let i = 0; i < channel.length; i++) channel[i] *= gain;
  return peak;
}

/** Apply attack → hold → exponential release, then a short click-free end fade. */
export function applyEnvelope(channels, sampleRate, { attack = 0.002, holdSeconds, release = 0.08 }) {
  const length = channels[0].length;
  const attackSamples = Math.min(length, Math.max(1, Math.round(attack * sampleRate)));
  const holdSamples = clamp(Math.round(holdSeconds * sampleRate), 1, length);
  const releaseSamples = Math.max(64, Math.round(release * sampleRate));
  const endFade = Math.min(96, length);
  for (const channel of channels) {
    for (let i = 0; i < attackSamples && i < length; i++) channel[i] *= i / attackSamples;
    if (holdSamples < length) {
      const span = Math.min(releaseSamples, length - holdSamples);
      for (let i = 0; i < span; i++) channel[holdSamples + i] *= Math.exp((-6.9 * i) / Math.max(span, 1));
      for (let i = holdSamples + span; i < length; i++) channel[i] = 0;
    }
    for (let i = 0; i < endFade; i++) channel[length - 1 - i] *= i / endFade;
  }
  return channels;
}

// ---------------------------------------------------------------------------
// Sampler: round-robin, velocity, alternate takes, pitched playback
// ---------------------------------------------------------------------------

export class Sampler {
  /**
   * @param {Record<string, Uint8Array|ArrayBuffer>} files WAV bytes keyed by file name.
   * @param {{sampleRate: number}} options Target sample rate of the composition.
   */
  constructor(files, { sampleRate }) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0)
      throw new Error(`sound-arrange: invalid sampleRate ${sampleRate}`);
    this.sampleRate = sampleRate;
    this.bytes = files;
    this.decoded = new Map();
    this.playable = new Map();
    this.counters = new Map();
    this.lastPick = new Map();
    this.norms = new Map();
  }

  _decoded(file) {
    if (!this.decoded.has(file)) {
      const bytes = this.bytes[file];
      if (!bytes) throw new Error(`sound-arrange: sample ${file} was not provided`);
      const decoded = decodeWav(bytes);
      // Align to the RECORDING's transient, not to the file header: a woodblock
      // take here has 8 ms of room tone before the strike. Keep 2 ms of pre-roll
      // so the attack is never clipped, and drop the rest of the lead-in.
      let peak = 0;
      for (const channel of decoded.channels)
        for (let i = 0; i < channel.length; i++) peak = Math.max(peak, Math.abs(channel[i]));
      const threshold = peak * 0.01;
      let onset = 0;
      outer: for (let i = 0; i < decoded.frames; i++) {
        for (const channel of decoded.channels) {
          if (Math.abs(channel[i]) > threshold) {
            onset = i;
            break outer;
          }
        }
      }
      const start = Math.max(0, onset - Math.round(decoded.sampleRate * 0.002));
      this.decoded.set(file, {
        ...decoded,
        sourceFrames: decoded.frames,
        onsetSourceSample: onset,
        headTrimSamples: start,
        frames: decoded.frames - start,
        channels: decoded.channels.map(channel => channel.slice(start)),
      });
    }
    return this.decoded.get(file);
  }

  /** Measured lead-in of a recording, kept as a fact (samples at its own rate). */
  headTrim(file) {
    const decoded = this._decoded(file);
    return { head: decoded.headTrimSamples, onset: decoded.onsetSourceSample, sourceFrames: decoded.sourceFrames };
  }

  /** Peak-normalise a pack by the median peak of its takes (level, not identity). */
  _norm(packId) {
    if (this.norms.has(packId)) return this.norms.get(packId);
    const peaks = SAMPLE_PACK[packId].files.map(entry => {
      const decoded = this._decoded(entry.file);
      let peak = 0;
      for (const channel of decoded.channels)
        for (let i = 0; i < channel.length; i++) peak = Math.max(peak, Math.abs(channel[i]));
      return peak;
    });
    const sorted = peaks.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 1;
    const gain = (VOICE_GAIN[packId] ?? 0.3) / Math.max(median, 1e-6);
    this.norms.set(packId, gain);
    return gain;
  }

  /** Pick a round-robin index for a pack; explicit `variant` resets the cycle. */
  _pick(packId, variant) {
    const pack = SAMPLE_PACK[packId];
    if (!pack) throw new Error(`sound-arrange: unknown sample pack ${packId}`);
    if (variant !== null && variant !== undefined) {
      if (!Number.isInteger(variant)) throw new Error(`sound-arrange: variant must be an integer, got ${variant}`);
      const index = ((variant % pack.files.length) + pack.files.length) % pack.files.length;
      this.counters.set(packId, (index + 1) % pack.files.length);
      this.lastPick.set(packId, index);
      return index;
    }
    const index = this.counters.get(packId) ?? 0;
    this.counters.set(packId, (index + 1) % pack.files.length);
    this.lastPick.set(packId, index);
    return index;
  }

  /** Rate-convert a hit sample once; later hits reuse the buffer. */
  _hitBuffer(file) {
    const key = `hit|${file}|${this.sampleRate}`;
    if (this.playable.has(key)) return this.playable.get(key);
    const decoded = this._decoded(file);
    const step = decoded.sampleRate / this.sampleRate;
    const channels = decoded.channels.map(channel => resampleChannel(channel, step));
    this.playable.set(key, channels);
    return channels;
  }

  /** Pitch-shift a pitched sample to `midi` by resampling, cached per pitch. */
  _pitchedBuffer(packId, file, midi) {
    const pack = SAMPLE_PACK[packId];
    const semitones = midi - pack.rootMidi;
    const key = `note|${file}|${semitones.toFixed(3)}|${this.sampleRate}`;
    if (this.playable.has(key)) return this.playable.get(key);
    const decoded = this._decoded(file);
    const rate = 2 ** (semitones / 12);
    const step = (decoded.sampleRate / this.sampleRate) * rate;
    const channels = decoded.channels.map(channel => resampleChannel(channel, step));
    this.playable.set(key, channels);
    return channels;
  }

  /**
   * One unpitched hit. Velocity shapes gain and, on soft strokes, darkens the
   * top end (a single recorded velocity layer is never re-labelled as many).
   * @returns {{channels: Float32Array[], file: string, variant: number}}
   */
  hit(packId, { velocity = 0.8, variant = null } = {}) {
    const pack = SAMPLE_PACK[packId];
    if (pack.kind !== 'hit') throw new Error(`sound-arrange: ${packId} is pitched; use note()`);
    const index = this._pick(packId, variant);
    const file = pack.files[index].file;
    const channels = this._hitBuffer(file).map(channel => channel.slice());
    const vel = clamp(velocity, 0.01, 1);
    const gain = this._norm(packId) * (vel / 0.8) ** 1.3;
    for (const channel of channels) for (let i = 0; i < channel.length; i++) channel[i] *= gain;
    if (vel < 0.72) onePoleLowpass(channels, 900 + 14000 * vel ** 2, this.sampleRate);
    return { channels, file, variant: index };
  }

  /**
   * One pitched note from a recorded root, resampled to `midi`. The sample's
   * natural decay is kept; `holdSeconds` damps it with a release when shorter
   * than the recording.
   * @returns {{channels: Float32Array[], file: string, variant: number, midi: number}}
   */
  note(packId, { midi, velocity = 0.8, holdSeconds = 0.6, releaseSeconds = 0.12, variant = null } = {}) {
    const pack = SAMPLE_PACK[packId];
    if (pack.kind !== 'pitched') throw new Error(`sound-arrange: ${packId} is unpitched; use hit()`);
    if (!Number.isFinite(midi)) throw new Error(`sound-arrange: note() needs a numeric midi pitch, got ${midi}`);
    const index = this._pick(packId, variant);
    const file = pack.files[index].file;
    const source = this._pitchedBuffer(packId, file, midi);
    const hold = Math.max(1, Math.round(holdSeconds * this.sampleRate));
    const release = Math.max(1, Math.round(releaseSeconds * this.sampleRate));
    const span = Math.min(source[0].length, hold + release);
    const channels = source.map(channel => channel.slice(0, span));
    const vel = clamp(velocity, 0.01, 1);
    const gain = this._norm(packId) * (vel / 0.8) ** 1.2;
    for (const channel of channels) for (let i = 0; i < channel.length; i++) channel[i] *= gain;
    if (vel < 0.72) onePoleLowpass(channels, 1200 + 12000 * vel ** 2, this.sampleRate);
    applyEnvelope(channels, this.sampleRate, { attack: 0.003, holdSeconds, release: releaseSeconds });
    return { channels, file, variant: index, midi };
  }
}

// ---------------------------------------------------------------------------
// Physical pluck (Karplus-Strong) — a synthetic low voice, not a recording
// ---------------------------------------------------------------------------

/**
 * Karplus-Strong plucked string: seeded noise excitation, a one-pole loop loss
 * and a short body resonance. Used under the sampled pizzicato for weight.
 * @returns {Float32Array[]} two equal channels
 */
export function pluck({
  midi,
  sampleRate,
  seconds = 1.2,
  velocity = 0.8,
  seed = 7,
  t60 = 1.8,
  brightness = 0.45,
  index = 0,
}) {
  const frequency = midiToHz(midi);
  const delay = Math.max(2, Math.round(sampleRate / frequency));
  const total = Math.max(delay * 2, Math.ceil(seconds * sampleRate));
  const rng = mulberry32((seed ^ Math.imul(index + 1, 0x2545f491)) >>> 0);
  const buffer = new Float32Array(delay);
  let state = 0;
  for (let i = 0; i < delay; i++) {
    const noise = rng() * 2 - 1;
    state += brightness * (noise - state);
    // A plucked string starts displaced near the pluck point: weight the burst
    // toward the first third of the period instead of pure noise.
    const shape = 0.6 + 0.4 * Math.sin((Math.PI * i) / delay);
    buffer[i] = state * shape;
  }
  normalizePeak([buffer], 0.9);
  const loss = Math.pow(10, -3 / Math.max(1, t60 * frequency));
  const damping = clamp(0.28 + 0.5 * (1 - brightness), 0.05, 0.7);
  const out = new Float32Array(total);
  let cursor = 0;
  for (let i = 0; i < total; i++) {
    const current = buffer[cursor];
    const next = buffer[(cursor + 1) % delay];
    out[i] = current;
    buffer[cursor] = loss * ((1 - damping) * current + damping * next);
    cursor = (cursor + 1) % delay;
  }
  // Body: a resonant band around the fundamental plus a soft hand thump.
  const body = out.slice();
  const w = (2 * Math.PI * frequency) / sampleRate;
  const q = 3.2;
  const alpha = Math.sin(w) / (2 * q);
  const b0 = alpha;
  const b2 = -alpha;
  const a0 = 1 + alpha;
  const a1 = -2 * Math.cos(w);
  const a2 = 1 - alpha;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < total; i++) {
    const x0 = body[i];
    const y0 = (b0 * x0 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    let thump = 0;
    if (i < sampleRate * 0.06) {
      const t = i / sampleRate;
      thump = velocity * 0.25 * Math.sin(2 * Math.PI * 62 * t) * Math.exp(-t / 0.012);
    }
    out[i] = out[i] * (1 - velocity * 0.25) + y0 * 0.55 + thump;
  }
  const attack = Math.max(1, Math.round(0.0015 * sampleRate));
  for (let i = 0; i < attack; i++) out[i] *= i / attack;
  normalizePeak([out], 0.35 * clamp(velocity, 0.05, 1));
  return [out, out.slice()];
}

// ---------------------------------------------------------------------------
// The event score
// ---------------------------------------------------------------------------

const MARIMBA_MOTIF = [
  { pitch: 'C6', offset: 0 },
  { pitch: 'A5', offset: 0.5 },
  { pitch: 'G5', offset: 1 },
  { pitch: 'E5', offset: 1.5 },
];
const CELLO_MOTIF = ['B3', 'A3', 'G3', 'F#3', 'E3'];

/** Validate/normalise authoring parameters; unknown keys are rejected. */
export function normalizeParams(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const known = new Set(Object.keys(DEFAULT_PARAMS));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) throw new Error(`sound-arrange: unknown parameter "${key}"`);
  }
  const params = { ...DEFAULT_PARAMS, ...input };
  for (const key of ['bpm', 'seconds', 'fps', 'mix']) {
    if (!Number.isFinite(params[key])) throw new Error(`sound-arrange: parameter "${key}" must be a finite number`);
  }
  if (params.bpm < 20 || params.bpm > 300) throw new Error('sound-arrange: bpm must be between 20 and 300');
  if (params.seconds < 1 || params.seconds > 600)
    throw new Error('sound-arrange: seconds must be between 1 and 600');
  if (!Number.isInteger(params.fps) || params.fps < 1 || params.fps > 240)
    throw new Error('sound-arrange: fps must be an integer between 1 and 240');
  if (params.mix < 0 || params.mix > 1) throw new Error('sound-arrange: mix must be between 0 and 1');
  return params;
}

/**
 * Build the score: explicit section boundaries and an ordered event list, all
 * in integer frames plus their exact sample position on the composition clock.
 *
 * @param {object} rawParams Authoring parameters (see DEFAULT_PARAMS).
 * @param {{fps: number, sampleRate: number, totalFrames?: number}} clock
 *   `fps`/`sampleRate` must be the composition's values; `totalFrames` may pin
 *   the authored length instead of deriving it from `seconds`.
 */
export function buildArrangement(rawParams, { fps, sampleRate, totalFrames } = {}) {
  const params = normalizeParams(rawParams);
  if (!Number.isInteger(fps) || fps < 1) throw new Error(`sound-arrange: invalid fps ${fps}`);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error(`sound-arrange: invalid sampleRate ${sampleRate}`);
  if (params.fps !== fps)
    throw new Error(`sound-arrange: params.fps (${params.fps}) does not match the composition fps (${fps})`);
  const frames = totalFrames === undefined ? Math.round(params.seconds * fps) : totalFrames;
  if (!Number.isInteger(frames) || frames <= 0) throw new Error(`sound-arrange: invalid totalFrames ${frames}`);

  const secondsPerBeat = 60 / params.bpm;
  const totalBeats = frames / fps / secondsPerBeat;
  const frameOfBeat = beat => clamp(Math.round(beat * secondsPerBeat * fps), 0, frames);
  const sampleOfFrame = frame => Math.ceil((frame * sampleRate) / fps);

  const sections = BEAT_SECTIONS.map((section, index) => {
    const startFrame = frameOfBeat(section.from * totalBeats);
    const endFrame = frameOfBeat(section.to * totalBeats);
    return {
      id: section.id,
      index,
      label: section.label,
      startFrame,
      endFrame,
      startSample: sampleOfFrame(startFrame),
      endSample: sampleOfFrame(endFrame),
    };
  });
  for (let i = 1; i < sections.length; i++) {
    if (sections[i].startFrame < sections[i - 1].startFrame)
      throw new Error('sound-arrange: section boundaries are not monotonic');
  }
  sections[sections.length - 1].endFrame = frames;
  sections[sections.length - 1].endSample = sampleOfFrame(frames);

  const sectionBeat = id => {
    const found = BEAT_SECTIONS.find(section => section.id === id);
    return { from: found.from * totalBeats, to: found.to * totalBeats };
  };
  const bounds = {
    intro: sectionBeat('intro'),
    groove: sectionBeat('groove'),
    rest: sectionBeat('rest'),
    peak: sectionBeat('peak'),
    tail: sectionBeat('tail'),
  };

  /** @type {Array<Record<string, unknown>>} */
  const events = [];
  let sequence = 0;
  const add = (event) => {
    const frame = frameOfBeat(event.beat);
    if (frame < 0 || frame >= frames) return;
    const index = sequence++;
    events.push({
      id: `${event.voice}-${String(index).padStart(3, '0')}`,
      order: index,
      voice: event.voice,
      section: event.section,
      frame,
      sample: sampleOfFrame(frame),
      beat: Number(event.beat.toFixed(4)),
      velocity: Number(clamp(event.velocity, 0.01, 1).toFixed(4)),
      ...(event.midi !== undefined ? { midi: event.midi } : {}),
      ...(event.holdSeconds !== undefined ? { holdSeconds: Number(event.holdSeconds.toFixed(3)) } : {}),
      ...(event.note !== undefined ? { note: event.note } : {}),
      ...(event.variant !== undefined ? { variant: event.variant } : {}),
      ...(event.pan !== undefined ? { pan: event.pan } : {}),
      ...(event.tag !== undefined ? { tag: event.tag } : {}),
    });
  };

  // ---- intro: the falling marimba motive, a woodblock marker, shaker enters
  const intro = bounds.intro;
  MARIMBA_MOTIF.forEach((step, i) => {
    add({
      voice: 'marimba',
      section: 'intro',
      beat: intro.from + step.offset,
      midi: parsePitch(step.pitch),
      note: step.pitch,
      velocity: 0.3 + i * 0.045,
      holdSeconds: 0.7,
      pan: i % 2 === 0 ? -0.14 : 0.12,
      tag: 'motif',
    });
  });
  add({ voice: 'woodblock', section: 'intro', beat: intro.from, velocity: 0.42, pan: -0.05, tag: 'marker' });
  for (let beat = intro.from + 1; beat < intro.to - 1e-6; beat += 0.5) {
    add({
      voice: 'shaker',
      section: 'intro',
      beat,
      velocity: 0.1 + 0.05 * ((beat - intro.from) % 1),
      pan: 0.28,
      tag: 'texture',
    });
  }

  // ---- groove: pizzicato riff on eighths, woodblock offbeats, pluck weight
  const groove = bounds.groove;
  const riff = [0, 0, 1, 2, 3, 2, 1, 0];
  const riffVel = [0.78, 0.5, 0.66, 0.58, 0.72, 0.52, 0.6, 0.55];
  riff.forEach((step, i) => {
    const beat = groove.from + i * 0.5;
    if (beat >= groove.to - 1e-6) return;
    add({
      voice: 'celloPizz',
      section: 'groove',
      beat,
      midi: parsePitch(CELLO_MOTIF[step]),
      note: CELLO_MOTIF[step],
      velocity: riffVel[i],
      holdSeconds: i === 0 ? 0.75 : 0.42,
      pan: -0.16,
      tag: 'riff',
    });
  });
  // A 16th pickup into the rest, deliberately soft.
  add({
    voice: 'celloPizz',
    section: 'groove',
    beat: groove.to - 0.25,
    midi: parsePitch('B3'),
    note: 'B3',
    velocity: 0.34,
    holdSeconds: 0.3,
    pan: -0.2,
    tag: 'pickup',
  });
  for (const offset of [0.5, 1.5, 2.5]) {
    if (groove.from + offset >= groove.to - 1e-6) continue;
    add({
      voice: 'woodblock',
      section: 'groove',
      beat: groove.from + offset,
      velocity: 0.24,
      pan: 0.18,
      tag: 'offbeat',
    });
  }
  add({ voice: 'pluck', section: 'groove', beat: groove.from, midi: parsePitch('B1'), velocity: 0.62, holdSeconds: 0.9, pan: 0, tag: 'sub' });
  add({ voice: 'pluck', section: 'groove', beat: groove.from + 2, midi: parsePitch('E2'), velocity: 0.5, holdSeconds: 0.9, pan: 0, tag: 'sub' });
  for (let beat = groove.from + 1.5; beat < groove.to - 1e-6; beat += 0.25) {
    add({
      voice: 'shaker',
      section: 'groove',
      beat,
      velocity: beat % 0.5 === 0 ? 0.16 : 0.11,
      pan: 0.3,
      tag: 'sixteenth',
    });
  }
  add({
    voice: 'marimba',
    section: 'groove',
    beat: groove.from + 2.5,
    midi: parsePitch('D6'),
    note: 'D6',
    velocity: 0.32,
    holdSeconds: 0.55,
    pan: 0.1,
    tag: 'answer',
  });

  // ---- rest: exactly one ringing note, then no attacks at all
  const rest = bounds.rest;
  add({
    voice: 'marimba',
    section: 'rest',
    beat: rest.from,
    midi: parsePitch('C6'),
    note: 'C6',
    velocity: 0.38,
    holdSeconds: 0.9,
    pan: 0.08,
    tag: 'ring',
  });

  // ---- peak: claps on the backbeat, accented riff, sixteenth shaker
  const peak = bounds.peak;
  const peakRiff = [0, 3, 2, 1, 0, 2, 3, 4];
  peakRiff.forEach((step, i) => {
    const beat = peak.from + i * 0.5;
    if (beat >= peak.to - 1e-6) return;
    add({
      voice: 'celloPizz',
      section: 'peak',
      beat,
      midi: parsePitch(CELLO_MOTIF[step]),
      note: CELLO_MOTIF[step],
      velocity: 0.72 + (i % 2 === 0 ? 0.16 : 0),
      holdSeconds: i === 0 ? 0.6 : 0.36,
      pan: -0.12,
      tag: 'riff',
    });
  });
  add({
    voice: 'celloPizz',
    section: 'peak',
    beat: peak.to - 0.25,
    midi: parsePitch('B3'),
    note: 'B3',
    velocity: 0.68,
    holdSeconds: 0.6,
    pan: -0.1,
    tag: 'pickup',
  });
  add({ voice: 'woodblock', section: 'peak', beat: peak.from, velocity: 0.5, pan: 0.15, tag: 'marker' });
  add({ voice: 'clap', section: 'peak', beat: peak.from + 0.5, velocity: 0.72, pan: 0.06, tag: 'backbeat' });
  add({ voice: 'clap', section: 'peak', beat: peak.from + 1.5, velocity: 0.66, pan: 0.06, tag: 'backbeat' });
  add({ voice: 'clap', section: 'peak', beat: peak.from + 1.75, velocity: 0.44, pan: 0.12, tag: 'flam' });
  add({ voice: 'pluck', section: 'peak', beat: peak.from, midi: parsePitch('B1'), velocity: 0.7, holdSeconds: 0.8, pan: 0, tag: 'sub' });
  add({ voice: 'pluck', section: 'peak', beat: peak.from + 1.5, midi: parsePitch('B1'), velocity: 0.62, holdSeconds: 0.8, pan: 0, tag: 'sub' });
  for (let beat = peak.from; beat < peak.to - 1e-6; beat += 0.25) {
    const accent = Math.abs(beat - Math.round(beat)) < 1e-6;
    add({
      voice: 'shaker',
      section: 'peak',
      beat,
      velocity: accent ? 0.2 : 0.13,
      pan: 0.3,
      tag: 'sixteenth',
    });
  }
  add({
    voice: 'marimba',
    section: 'peak',
    beat: peak.from + 0.5,
    midi: parsePitch('D6'),
    note: 'D6',
    velocity: 0.44,
    holdSeconds: 0.5,
    pan: 0.12,
    tag: 'answer',
  });
  add({
    voice: 'marimba',
    section: 'peak',
    beat: peak.from + 1.5,
    midi: parsePitch('E6'),
    note: 'E6',
    velocity: 0.4,
    holdSeconds: 0.5,
    pan: -0.08,
    tag: 'answer',
  });

  // ---- tail: one low pizz, one marimba, then silence
  const tail = bounds.tail;
  add({
    voice: 'celloPizz',
    section: 'tail',
    beat: tail.from,
    midi: parsePitch('B3'),
    note: 'B3',
    velocity: 0.62,
    holdSeconds: 1.1,
    pan: -0.1,
    tag: 'resolve',
  });
  add({
    voice: 'marimba',
    section: 'tail',
    beat: tail.from,
    midi: parsePitch('C6'),
    note: 'C6',
    velocity: 0.34,
    holdSeconds: 0.9,
    pan: 0.06,
    tag: 'resolve',
  });
  add({ voice: 'woodblock', section: 'tail', beat: tail.from, velocity: 0.46, pan: 0.12, tag: 'marker' });

  if (events.length === 0) throw new Error('sound-arrange: the score produced no events');
  // The event list is chronological; ties keep their authored order, so the
  // list is stable regardless of how the sections were written.
  events.sort((a, b) => a.frame - b.frame || a.order - b.order);
  for (const event of events) delete event.order;

  const accents = events.filter(event => event.velocity >= 0.68).map(event => event.id);
  return {
    params,
    fps,
    sampleRate,
    frames,
    seconds: frames / fps,
    bpm: params.bpm,
    totalBeats,
    sections,
    events,
    accents,
    rest: { section: 'rest', ...sections.find(section => section.id === 'rest') },
    motif: { marimba: MARIMBA_MOTIF.map(step => step.pitch), cello: CELLO_MOTIF },
  };
}

// ---------------------------------------------------------------------------
// Rendering: event score → stereo float channels
// ---------------------------------------------------------------------------

function addAt(target, source, at, gain, pan) {
  if (pan === 0) {
    for (let i = 0; i < source.length; i++) {
      const index = at + i;
      if (index >= target[0].length) break;
      target[0][index] += source[i] * gain;
      target[1][index] += source[i] * gain;
    }
    return;
  }
  const angle = ((clamp(pan, -1, 1) + 1) * Math.PI) / 4;
  const left = Math.SQRT2 * Math.cos(angle);
  const right = Math.SQRT2 * Math.sin(angle);
  for (let i = 0; i < source.length; i++) {
    const index = at + i;
    if (index >= target[0].length) break;
    target[0][index] += source[i] * gain * left;
    target[1][index] += source[i] * gain * right;
  }
}

function addStereoAt(target, channels, at, gain, pan) {
  const left = channels[0];
  const right = channels[1] ?? channels[0];
  const angle = ((clamp(pan, -1, 1) + 1) * Math.PI) / 4;
  const gl = Math.SQRT2 * Math.cos(angle);
  const gr = Math.SQRT2 * Math.sin(angle);
  for (let i = 0; i < left.length; i++) {
    const index = at + i;
    if (index >= target[0].length) break;
    target[0][index] += left[i] * gain * gl;
    target[1][index] += right[i] * gain * gr;
  }
}

/**
 * A small deterministic Schroeder-style room (four damped combs + two
 * allpasses), driven by a mono send. This is synthesis, not convolution and not
 * a claim about a real space.
 */
function room(send, sampleRate) {
  const n = send.length;
  const out = [new Float32Array(n), new Float32Array(n)];
  const delays = [0.0297, 0.0371, 0.0411, 0.0437];
  const feedbacks = [0.79, 0.77, 0.75, 0.73];
  for (let channel = 0; channel < 2; channel++) {
    const lines = delays.map((delay, i) => ({
      buffer: new Float32Array(Math.round((delay + channel * 0.0011) * sampleRate)),
      index: 0,
      damp: 0,
      feedback: feedbacks[i],
    }));
    const apDelays = [0.005, 0.0017];
    const allpasses = apDelays.map(delay => ({
      buffer: new Float32Array(Math.round((delay + channel * 0.0007) * sampleRate)),
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

/**
 * Render the score to two Float32 channels of exactly `frames` samples.
 *
 * @param {ReturnType<typeof buildArrangement>} arrangement
 * @param {{
 *   sampler: Sampler,
 *   frames: number,
 *   seed?: number,
 *   mix?: number,
 *   reverb?: number,
 *   fadeSeconds?: number,
 * }} options
 * @returns {{channels: Float32Array[], report: object}}
 */
export function renderArrangement(arrangement, { sampler, frames, seed = 7, mix = 1, reverb = 0.9, fadeSeconds = 0.3 }) {
  if (!(sampler instanceof Sampler)) throw new Error('sound-arrange: renderArrangement needs a Sampler');
  if (!Number.isInteger(frames) || frames <= 0) throw new Error(`sound-arrange: invalid render length ${frames}`);
  const sampleRate = sampler.sampleRate;
  const expected = Math.ceil((arrangement.frames * sampleRate) / arrangement.fps);
  if (expected !== frames)
    throw new Error(
      `sound-arrange: the clock handed ${frames} samples but ${arrangement.frames} frames @ ${arrangement.fps}fps ` +
        `is exactly ${expected}; the arrangement must span the whole source (never pad or trim)`,
    );

  const buses = {
    music: [new Float32Array(frames), new Float32Array(frames)],
    perc: [new Float32Array(frames), new Float32Array(frames)],
  };
  const report = {
    events: arrangement.events.length,
    rendered: 0,
    voices: {},
    variants: {},
    peak: 0,
    rms: 0,
    busRms: {},
    sectionRms: [],
    restSamples: 0,
    trimmed: false,
  };

  arrangement.events.forEach((event, index) => {
    const panJitter = hashUnit(seed, index) * 0.04;
    const velocityJitter = 1 + hashUnit(seed ^ 0x5f356495, index) * 0.03;
    const pan = (event.pan ?? 0) + panJitter;
    let rendered;
    let voice;
    if (event.voice === 'pluck') {
      const hold = event.holdSeconds ?? 0.9;
      const channels = pluck({
        midi: event.midi,
        sampleRate,
        seconds: hold + 0.25,
        velocity: event.velocity * velocityJitter,
        seed,
        index,
        brightness: 0.42,
      });
      rendered = { channels, file: 'karpus-strong', variant: 0 };
      voice = 'pluck';
    } else if (SAMPLE_PACK[event.voice].kind === 'hit') {
      rendered = sampler.hit(event.voice, {
        velocity: event.velocity * velocityJitter,
        variant: event.variant ?? null,
      });
      voice = event.voice;
    } else {
      rendered = sampler.note(event.voice, {
        midi: event.midi,
        velocity: event.velocity * velocityJitter,
        holdSeconds: event.holdSeconds ?? 0.6,
        releaseSeconds: 0.14,
        variant: event.variant ?? null,
      });
      voice = event.voice;
    }
    const bus = voice === 'pluck' ? 'music' : SAMPLE_PACK[voice].bus;
    addStereoAt(buses[bus], rendered.channels, event.sample, mix, pan);
    report.rendered++;
    report.voices[voice] = (report.voices[voice] ?? 0) + 1;
    const variantKey = `${voice}/${rendered.file}`;
    report.variants[variantKey] = (report.variants[variantKey] ?? 0) + 1;
    event.renderedFile = rendered.file;
    event.renderedVariant = rendered.variant;
  });

  // A single small room on the music bus; the percussive bus stays drier so
  // transients keep their attack.
  const musicSend = new Float32Array(frames);
  for (let i = 0; i < frames; i++) musicSend[i] = (buses.music[0][i] + buses.music[1][i]) * 0.5;
  const wet = room(musicSend, sampleRate);
  for (let i = 0; i < frames; i++) {
    buses.music[0][i] += wet[0][i] * reverb * 0.35;
    buses.music[1][i] += wet[1][i] * reverb * 0.35;
  }

  const output = [new Float32Array(frames), new Float32Array(frames)];
  for (let i = 0; i < frames; i++) {
    output[0][i] = buses.music[0][i] + buses.perc[0][i];
    output[1][i] = buses.music[1][i] + buses.perc[1][i];
  }

  // Authored end fade: the tail lands, then the programme closes cleanly.
  const fade = Math.min(frames, Math.round(fadeSeconds * sampleRate));
  for (let i = 0; i < fade; i++) {
    const gain = 0.5 + 0.5 * Math.cos((Math.PI * (i + 1)) / fade);
    output[0][frames - fade + i] *= gain;
    output[1][frames - fade + i] *= gain;
  }

  let peak = 0;
  for (let i = 0; i < frames; i++) peak = Math.max(peak, Math.abs(output[0][i]), Math.abs(output[1][i]));
  if (peak > 0.98) {
    // Headroom safety is an authoring gain, applied before the Runtime ever sees
    // the buffer: the Runtime refuses |sample| > 1 and never clamps for us.
    const trim = 0.98 / peak;
    for (const channel of output) for (let i = 0; i < frames; i++) channel[i] *= trim;
    peak *= trim;
    report.trimmed = true;
  }
  let sum = 0;
  for (let i = 0; i < frames; i++) sum += output[0][i] * output[0][i] + output[1][i] * output[1][i];
  report.peak = peak;
  report.rms = Math.sqrt(sum / (frames * 2));
  for (const [bus, channels] of Object.entries(buses)) {
    let energy = 0;
    for (let i = 0; i < frames; i++) energy += channels[0][i] ** 2 + channels[1][i] ** 2;
    report.busRms[bus] = Number(Math.sqrt(energy / (frames * 2)).toFixed(6));
  }
  for (const section of arrangement.sections) {
    const from = section.startSample;
    const to = Math.min(frames, section.endSample);
    let energy = 0;
    const count = Math.max(1, to - from);
    for (let i = from; i < to; i++) energy += output[0][i] ** 2 + output[1][i] ** 2;
    report.sectionRms.push({
      id: section.id,
      startFrame: section.startFrame,
      endFrame: section.endFrame,
      rms: Number(Math.sqrt(energy / (count * 2)).toFixed(6)),
    });
  }
  const rest = arrangement.rest;
  report.restSamples = Math.max(0, rest.endSample - rest.startSample);
  report.headTrimSamples = {};
  for (const file of new Set(arrangement.events.map(event => event.renderedFile).filter(Boolean))) {
    if (file === 'karpus-strong') continue;
    report.headTrimSamples[file] = sampler.headTrim(file);
  }
  report.peak = Number(report.peak.toFixed(6));
  report.rms = Number(report.rms.toFixed(6));
  return { channels: output, report };
}
