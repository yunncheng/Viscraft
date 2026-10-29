/*
 * Risograph ride — dependency-free bossa synthesis.
 *
 * This file is the local DSP half of the audiovisual risograph study. It contains only
 * the mechanisms this reference actually uses:
 *
 *   - a seeded PRNG (no Math.random, no clock);
 *   - Karplus-Strong-style waveguide strings for nylon guitar and bass;
 *   - modal synthesis for vibraphone (inharmonic partials + motor tremolo);
 *   - a continuous whistle line with portamento, delayed vibrato and trill;
 *   - shaker / rim / brush / kick / cymbal / brush-roll / bicycle-bell voices;
 *   - RBJ filters, a small deterministic Schroeder room, and a post-room gate.
 *
 * Nothing here reads a sample, font, network resource or wall clock. Every
 * random draw comes from the caller's seeded generator, so two renders with the
 * same inputs are byte-identical in the same engine.
 *
 * Adapted from lemo-opuscar styles/risograph/demo/music/score.py and bell.py at
 * commit e3cb16f63768c68693ff0e15171d6e755457cc32 (LemoLab, MIT). The upstream
 * files use NumPy/SciPy/Numba; this is an independent JavaScript implementation
 * of the same published mechanisms. See LICENSES.md for the full MIT text and
 * the exact adopted ranges.
 */

/** Mulberry32. Returns a function in [0, 1). */
export function makeRandom(seed) {
  let a = (Number(seed) || 0) >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard-normal draw from a uniform generator (Box-Muller, one draw cached). */
export function gaussian(rng) {
  let spare;
  return function next() {
    if (spare !== undefined) {
      const value = spare;
      spare = undefined;
      return value;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    const radius = Math.sqrt(-2 * Math.log(u));
    const angle = 2 * Math.PI * v;
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
}

export function midiToHz(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value;
}

/** One-pole low-pass. Returns a new Float32Array. */
export function onePoleLowpass(input, cutoff, sampleRate) {
  const x = input instanceof Float32Array ? input : Float32Array.from(input);
  const out = new Float32Array(x.length);
  const fc = clamp(cutoff, 1, sampleRate * 0.49);
  const a = 1 - Math.exp((-2 * Math.PI * fc) / sampleRate);
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    y += a * (x[i] - y);
    out[i] = y;
  }
  return out;
}

/** RBJ biquad coefficients; `type` is lowpass | highpass | bandpass | peak. */
export function biquadCoefficients(type, frequency, q, sampleRate, gainDb = 0) {
  const f = clamp(frequency, 10, sampleRate * 0.45);
  const w = (2 * Math.PI * f) / sampleRate;
  const cos = Math.cos(w);
  const sin = Math.sin(w);
  const alpha = sin / (2 * Math.max(0.0001, q));
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
  } else if (type === 'peak') {
    const A = Math.pow(10, gainDb / 40);
    b0 = 1 + alpha * A;
    b1 = -2 * cos;
    b2 = 1 - alpha * A;
    a0 = 1 + alpha / A;
    a1 = -2 * cos;
    a2 = 1 - alpha / A;
  } else {
    throw new Error(`synth: unknown biquad type ${type}`);
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** Transposed direct-form II biquad over a whole buffer. */
export function biquad(input, coefficients) {
  const x = input instanceof Float32Array ? input : Float32Array.from(input);
  const out = new Float32Array(x.length);
  const { b0, b1, b2, a1, a2 } = coefficients;
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = b0 * x[i] + z1;
    z1 = b1 * x[i] - a1 * y + z2;
    z2 = b2 * x[i] - a2 * y;
    out[i] = y;
  }
  return out;
}

export function bandpass(input, frequency, q, sampleRate) {
  return biquad(input, biquadCoefficients('bandpass', frequency, q, sampleRate));
}

export function lowpass(input, frequency, q, sampleRate) {
  return biquad(input, biquadCoefficients('lowpass', frequency, q, sampleRate));
}

export function highpass(input, frequency, q, sampleRate) {
  return biquad(input, biquadCoefficients('highpass', frequency, q, sampleRate));
}

export function peak(input, frequency, gainDb, q, sampleRate) {
  return biquad(input, biquadCoefficients('peak', frequency, q, sampleRate, gainDb));
}

/** Linear attack-to-zero release envelope, matching the upstream rel_env use. */
export function releaseEnvelope(samples, holdSeconds, releaseSeconds, sampleRate) {
  const envelope = new Float32Array(samples);
  envelope.fill(1);
  const held = Math.min(samples, Math.max(0, Math.floor(holdSeconds * sampleRate)));
  const release = Math.max(1, Math.floor(releaseSeconds * sampleRate));
  if (held < samples) {
    const span = Math.min(release, samples - held);
    for (let i = 0; i < span; i++) envelope[held + i] = 1 - (i + 1) / span;
    for (let i = held + span; i < samples; i++) envelope[i] = 0;
  }
  return envelope;
}

function windowedNoise(length, rng) {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = rng() * 2 - 1;
  return out;
}

function gaussianNoise(length, nextGaussian) {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = nextGaussian();
  return out;
}

/**
 * Waveguide string.
 *
 * Fractional delay is split into an integer loop delay plus a first-order
 * all-pass; a one-pole loop filter provides frequency-dependent loss; the
 * excitation is a windowed noise burst with a pluck-position comb.
 */
export function stringVoice(
  midi,
  seconds,
  {
    sampleRate,
    rng,
    nextGaussian,
    velocity = 0.7,
    t60 = 3.0,
    damping = 0.35,
    position = 0.15,
    brightness = 0.5,
    cents = 0,
  },
) {
  const f0 = midiToHz(midi + cents / 100);
  const period = sampleRate / f0;
  const a = clamp(damping * (1 - brightness * 0.5), 0.0001, 0.94);
  const lowpassDelay = a / (1 - a);
  let total = period - lowpassDelay;
  let delay = Math.floor(total - 0.15);
  let fraction = total - delay;
  if (fraction < 0.15) {
    delay -= 1;
    fraction += 1;
  }
  delay = Math.max(1, delay);
  const allpassCoefficient = (1 - fraction) / (1 + fraction);
  const loopGain = Math.pow(10, -3 / (f0 * t60));
  const samples = Math.max(1, Math.floor(seconds * sampleRate));
  const excitationLength = Math.max(8, Math.floor(period));

  let excitation = gaussianNoise(excitationLength, nextGaussian);
  excitation = onePoleLowpass(
    excitation,
    clamp(800 + 5000 * brightness * velocity, 200, sampleRate * 0.45),
    sampleRate,
  );
  const half = Math.max(1, excitationLength - 1);
  for (let i = 0; i < excitationLength; i++) {
    excitation[i] *= Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / half));
  }
  const pluck = Math.max(0, Math.min(excitationLength - 1, Math.floor(position * excitationLength)));
  if (pluck > 0) {
    for (let i = excitationLength - 1; i >= pluck; i--) excitation[i] -= excitation[i - pluck];
  }
  let maximum = 0;
  for (let i = 0; i < excitationLength; i++) maximum = Math.max(maximum, Math.abs(excitation[i]));
  if (maximum > 0) {
    const scale = velocity / maximum;
    for (let i = 0; i < excitationLength; i++) excitation[i] *= scale;
  }

  const bufferLength = delay + 4;
  const buffer = new Float64Array(bufferLength);
  const out = new Float32Array(samples);
  let write = 0;
  let loopState = 0;
  let allpassX = 0;
  let allpassY = 0;
  for (let i = 0; i < samples; i++) {
    let read = (write - delay) % bufferLength;
    if (read < 0) read += bufferLength;
    const delayed = buffer[read];
    loopState = (1 - a) * delayed + a * loopState;
    const allpassOut = allpassCoefficient * loopState + allpassX - allpassCoefficient * allpassY;
    allpassX = loopState;
    allpassY = allpassOut;
    const value = (i < excitationLength ? excitation[i] : 0) + loopGain * allpassOut;
    buffer[write] = value;
    out[i] = value;
    write++;
    if (write === bufferLength) write = 0;
  }
  return out;
}

/** Nylon-string guitar note: waveguide + release. */
export function guitarNote(
  midi,
  holdSeconds,
  {
    sampleRate,
    rng,
    nextGaussian,
    velocity = 0.7,
    brightness = 0.45,
    t60 = 3.2,
  },
) {
  const samples = Math.floor(Math.min(holdSeconds + 0.5, 4.5) * sampleRate);
  const note = stringVoice(midi, samples / sampleRate, {
    sampleRate,
    rng,
    nextGaussian,
    velocity,
    t60,
    damping: 0.42,
    position: 0.14 + rng() * 0.03,
    brightness,
    cents: nextGaussian() * 2,
  });
  const envelope = releaseEnvelope(samples, holdSeconds, 0.09, sampleRate);
  for (let i = 0; i < note.length; i++) note[i] *= envelope[i];
  return note;
}

/** Upright bass note: waveguide + finger thump + short finger noise. */
export function bassNote(
  midi,
  holdSeconds,
  { sampleRate, rng, nextGaussian, velocity = 0.8 },
) {
  const samples = Math.floor(Math.min(holdSeconds + 0.4, 3) * sampleRate);
  const note = stringVoice(midi, samples / sampleRate, {
    sampleRate,
    rng,
    nextGaussian,
    velocity,
    t60: 1.6,
    damping: 0.6,
    position: 0.27,
    brightness: 0.25,
    cents: nextGaussian() * 3,
  });
  const frequency = midiToHz(midi);
  const thump = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    thump[i] = Math.sin(2 * Math.PI * frequency * t) * Math.exp(-t / 0.12) * 0.5 * velocity;
  }
  const finger = onePoleLowpass(windowedNoise(samples, rng), 900, sampleRate);
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    note[i] += thump[i] + finger[i] * Math.exp(-t / 0.006) * 0.25 * velocity;
  }
  const envelope = releaseEnvelope(samples, holdSeconds, 0.07, sampleRate);
  for (let i = 0; i < note.length; i++) note[i] *= envelope[i];
  return note;
}

/** Vibraphone note: inharmonic modal partials, mallet noise and motor tremolo. */
export function vibeNote(
  midi,
  holdSeconds,
  {
    sampleRate,
    rng,
    nextGaussian,
    velocity = 0.7,
    motor = 5.6,
    pedal = 0.6,
    release = 0.25,
  },
) {
  const ring = Math.min(holdSeconds + 1.8, 4);
  const samples = Math.floor(ring * sampleRate);
  const frequency = midiToHz(midi);
  const tremoloPhase = rng() * 6;
  const mallet = onePoleLowpass(windowedNoise(samples, rng), 2500, sampleRate);
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    let value =
      Math.sin(2 * Math.PI * frequency * t) * Math.exp(-t / 1.9) +
      0.28 * Math.sin(2 * Math.PI * frequency * 3.93 * t) * Math.exp(-t / 0.45);
    if (frequency * 9.9 < 16000)
      value += 0.1 * Math.sin(2 * Math.PI * frequency * 9.9 * t) * Math.exp(-t / 0.12);
    const tremolo = 1 - 0.28 * (0.5 + 0.5 * Math.sin(2 * Math.PI * motor * t + tremoloPhase));
    out[i] = (value * tremolo + mallet[i] * Math.exp(-t / 0.004) * 0.15) * velocity;
  }
  const envelope = releaseEnvelope(samples, holdSeconds + pedal, release, sampleRate);
  for (let i = 0; i < out.length; i++) out[i] *= envelope[i];
  return out;
}

/**
 * One continuous whistle line from descriptor events.
 *
 * `events` is an ordered list of { time, duration, midi, gain, trill? }. Gaps
 * are silence; a note whose start is within 35 ms of the previous note's end is
 * portamento. The line uses a delayed 5.4 Hz vibrato and an optional upper-
 * second trill, then adds a narrow-band breath layer.
 */
export function whistleLine(events, samples, sampleRate, rng) {
  const frequency = new Float32Array(samples);
  const amplitude = new Float32Array(samples);
  let previous;
  const ordered = events
    .filter(event => typeof event.midi === 'number' && Number.isFinite(event.time))
    .sort((a, b) => a.time - b.time);
  for (const event of ordered) {
    const start = Math.max(0, Math.round(event.time * sampleRate));
    const end = Math.min(samples, Math.round((event.time + event.duration) * sampleRate));
    if (end <= start) continue;
    const midi = event.midi;
    const velocity = event.gain == null ? 0.8 : event.gain;
    const trill = Number(event.trill) || 0;
    const connected =
      previous && Math.abs(previous.time + previous.duration - event.time) < 0.035
        ? previous.midi
        : undefined;
    for (let i = start; i < end; i++) {
      const t = (i - start) / sampleRate;
      let base = midi - 0.6 * Math.exp(-t / 0.035);
      if (connected !== undefined) base += (connected - midi) * Math.exp(-t / 0.03);
      const vibratoDepth = 0.18 * clamp((t - 0.18) / 0.25, 0, 1);
      base += vibratoDepth * Math.sin(2 * Math.PI * 5.4 * t);
      if (trill > 0 && t < trill) base += Math.sin(2 * Math.PI * 14 * t) > 0 ? 1 : 0;
      frequency[i] = midiToHz(base);
      const envelope =
        Math.min(1, t / 0.03) *
        Math.min(1, (event.duration - t) / 0.05) *
        velocity;
      if (envelope > amplitude[i]) amplitude[i] = envelope;
    }
    previous = event;
  }

  const breathA = bandpass(windowedNoise(samples, rng), 2400, 1.5, sampleRate);
  const breathB = bandpass(windowedNoise(samples, rng), 1200, 4, sampleRate);
  const out = new Float32Array(samples);
  let phase = 0;
  for (let i = 0; i < samples; i++) {
    const f = frequency[i] === 0 ? 800 : frequency[i];
    phase += (2 * Math.PI * f) / sampleRate;
    const tone = Math.sin(phase) + 0.06 * Math.sin(2 * phase) + 0.02 * Math.sin(3 * phase);
    out[i] = tone + breathA[i] * 0.05 + breathB[i] * 0.03;
  }
  const smoothed = onePoleLowpass(amplitude, 40, sampleRate);
  for (let i = 0; i < samples; i++) out[i] *= smoothed[i];
  return out;
}

export function shaker(velocity, sampleRate, rng) {
  const duration = 0.09;
  const samples = Math.floor(duration * sampleRate);
  let noise = windowedNoise(samples, rng);
  noise = bandpass(noise, 5200, 1.1, sampleRate);
  noise = lowpass(noise, 9000, 0.707, sampleRate);
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    noise[i] *= Math.min(1, t / 0.008) * Math.exp(-Math.max(0, t - 0.008) / 0.03) * velocity;
  }
  return noise;
}

export function rim(velocity, big, sampleRate, rng) {
  const duration = 0.12;
  const samples = Math.floor(duration * sampleRate);
  const noise = highpass(windowedNoise(samples, rng), 2000, 0.707, sampleRate);
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    let value =
      Math.sin(2 * Math.PI * 1750 * t) * Math.exp(-t / 0.018) +
      0.6 * Math.sin(2 * Math.PI * 820 * t) * Math.exp(-t / 0.03) +
      0.35 * Math.sin(2 * Math.PI * 380 * t) * Math.exp(-t / 0.04);
    value += noise[i] * Math.exp(-t / 0.002) * 0.8;
    if (big) value += Math.sin(2 * Math.PI * 540 * t) * Math.exp(-t / 0.06) * 0.8;
    out[i] = value * velocity;
  }
  return lowpass(out, 8500, 0.707, sampleRate);
}

export function brush(velocity, duration, sampleRate, rng) {
  const samples = Math.max(1, Math.floor(duration * sampleRate));
  let noise = highpass(windowedNoise(samples, rng), 1500, 0.707, sampleRate);
  noise = lowpass(noise, 7000, 0.707, sampleRate);
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const envelope = Math.pow(Math.sin(Math.PI * Math.min(1, t / duration)), 1.5);
    noise[i] *= envelope * velocity;
  }
  return noise;
}

export function kick(velocity, sampleRate, rng) {
  const duration = 0.25;
  const samples = Math.floor(duration * sampleRate);
  const noise = lowpass(windowedNoise(samples, rng), 400, 0.707, sampleRate);
  const out = new Float32Array(samples);
  let phase = 0;
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const f = 62 + 40 * Math.exp(-t / 0.02);
    phase += (2 * Math.PI * f) / sampleRate;
    out[i] =
      (Math.sin(phase) * Math.exp(-t / 0.09) + noise[i] * Math.exp(-t / 0.01) * 0.3) * velocity;
  }
  return out;
}

export function cymbal(velocity, duration, swell, sampleRate, rng) {
  const samples = Math.max(1, Math.floor(duration * sampleRate));
  let noise = windowedNoise(samples, rng);
  const high = bandpass(noise, 6000, 0.8, sampleRate);
  const low = bandpass(windowedNoise(samples, rng), 3500, 2, sampleRate);
  for (let i = 0; i < samples; i++) noise[i] = high[i] * 0.7 + low[i] * 0.4;
  noise = lowpass(noise, 9500, 0.707, sampleRate);
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const envelope =
      swell > 0
        ? Math.pow(t / duration, 2.2)
        : Math.exp(-t / (duration * 0.35)) * Math.min(1, t / 0.003);
    noise[i] *= envelope * velocity;
  }
  return noise;
}

export function brushRoll(velocity, duration, sampleRate, rng) {
  const samples = Math.max(1, Math.floor(duration * sampleRate));
  let noise = highpass(windowedNoise(samples, rng), 1200, 0.707, sampleRate);
  noise = lowpass(noise, 7500, 0.707, sampleRate);
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const modulation = 0.6 + 0.4 * Math.abs(Math.sin(2 * Math.PI * 8 * t));
    noise[i] *= modulation * Math.pow(t / duration, 1.8) * velocity;
  }
  return noise;
}

/** Bicycle bell: one strike of inharmonic metal partials plus a short transient. */
export function bell(velocity, sampleRate, rng, nextGaussian) {
  const duration = 1.2;
  const samples = Math.floor(duration * sampleRate);
  const partials = [
    [2100, 1.0, 0.55],
    [2106.5, 0.55, 0.6],
    [3400, 0.62, 0.32],
    [3409, 0.3, 0.28],
    [5230, 0.16, 0.12],
    [1045, 0.1, 0.25],
  ];
  const out = new Float32Array(samples);
  for (const [frequency, amount, decay] of partials) {
    const detune = 1 + nextGaussian() * 0.0004;
    const phase = rng() * 6.28;
    for (let i = 0; i < samples; i++) {
      const t = i / sampleRate;
      out[i] += amount * Math.sin(2 * Math.PI * frequency * detune * t + phase) * Math.exp(-t / decay);
    }
  }
  const transientSamples = Math.max(1, Math.floor(0.004 * sampleRate));
  let transient = windowedNoise(transientSamples, rng);
  transient = highpass(transient, 3000, 0.707, sampleRate);
  for (let i = 0; i < transientSamples; i++) out[i] += transient[i] * Math.exp(-i / (sampleRate * 0.0015)) * 0.9;
  let filtered = highpass(out, 700, 0.707, sampleRate);
  filtered = lowpass(filtered, 9000, 0.707, sampleRate);
  let maximum = 0;
  for (let i = 0; i < filtered.length; i++) maximum = Math.max(maximum, Math.abs(filtered[i]));
  if (maximum > 0) {
    const scale = (0.9 * velocity) / maximum;
    for (let i = 0; i < filtered.length; i++) filtered[i] *= scale;
  }
  return filtered;
}

/**
 * Small deterministic Schroeder room: four damped feedback combs and two
 * all-passes per channel, with slightly different delays for the right channel.
 * Returns [left, right]; each array has exactly `dry.length` samples.
 */
export function room(dry, sampleRate) {
  const length = dry.length;
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  const delayTimes = [0.0297, 0.0371, 0.0411, 0.0437];
  const feedback = [0.78, 0.76, 0.74, 0.72];
  const damping = 0.35;
  const allpasses = [
    [0.005, 0.5],
    [0.0017, 0.5],
  ];
  for (let channel = 0; channel < 2; channel++) {
    const out = channel === 0 ? left : right;
    const scale = channel === 0 ? 1 : 1.021;
    for (let comb = 0; comb < delayTimes.length; comb++) {
      const delay = Math.max(1, Math.round(delayTimes[comb] * scale * sampleRate));
      const buffer = new Float32Array(delay);
      let index = 0;
      let low = 0;
      const gain = feedback[comb];
      for (let i = 0; i < length; i++) {
        const delayed = buffer[index];
        low = delayed * (1 - damping) + low * damping;
        buffer[index] = dry[i] + low * gain;
        out[i] += delayed;
        index++;
        if (index === delay) index = 0;
      }
    }
    for (const [time, gain] of allpasses) {
      const delay = Math.max(1, Math.round(time * scale * sampleRate));
      const buffer = new Float32Array(delay);
      let index = 0;
      for (let i = 0; i < length; i++) {
        const delayed = buffer[index];
        const value = -gain * out[i] + delayed;
        buffer[index] = out[i] + gain * value;
        out[i] = value;
        index++;
        if (index === delay) index = 0;
      }
    }
    const wetGain = 0.12;
    for (let i = 0; i < length; i++) out[i] *= wetGain;
  }
  return [left, right];
}

/**
 * Post-room gate: a 25 ms fade to silence at `breakStart`, silence until
 * `breakEnd`, then unity; and an authored power fade from `fadeStart` to the
 * last sample. Applying this after the room is what cuts every tail.
 */
export function makeGate(samples, sampleRate, breakStart, breakEnd, fadeStart = 39, fadeEnd = 40) {
  const gate = new Float32Array(samples);
  gate.fill(1);
  const start = Math.min(samples, Math.max(0, Math.round(breakStart * sampleRate)));
  const end = Math.min(samples, Math.max(start, Math.round(breakEnd * sampleRate)));
  const fade = Math.max(1, Math.round(0.025 * sampleRate));
  for (let i = start; i < Math.min(start + fade, samples); i++) gate[i] = 1 - (i - start) / fade;
  for (let i = start + fade; i < end; i++) gate[i] = 0;
  const fadeOutStart = Math.min(samples, Math.max(0, Math.round(fadeStart * sampleRate)));
  const fadeOutEnd = Math.min(samples, Math.max(fadeOutStart + 1, Math.round(fadeEnd * sampleRate)));
  for (let i = fadeOutStart; i < fadeOutEnd; i++) {
    const t = (i - fadeOutStart) / (fadeOutEnd - fadeOutStart);
    gate[i] = Math.pow(1 - t, 1.5);
  }
  if (samples > 0) gate[samples - 1] = 0;
  return gate;
}
