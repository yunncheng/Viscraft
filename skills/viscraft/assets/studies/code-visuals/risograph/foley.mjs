/**
 * RISOGRAPH RIDE — local Foley for the two four-second rides.
 *
 * The events are read from `action-facts.mjs`, not invented from the print
 * registration grid:
 *
 *   riverside  one bicycle-bell strike at the first 12 Hz step that reaches the
 *              2.3 s target (2.3333... s), then five wing flaps at the real
 *              pigeon flush starts 2.35 + i*0.05 s.
 *   bakery     no bell. A soft sleeve at the 2.1 s reach, the bread/hand contact
 *              at the first full 12 Hz catch step (2.75 s), one pavement-pigeon
 *              flap at 2.85 s, and the basket contact at the first 12 Hz step
 *              where stowed > 0.82 (3.1667 s).
 *
 * `press.kicks` in the shared facts are visual registration impulses and are
 * never Foley onsets here. Everything is procedural: filtered noise, damped
 * resonances and the local `synth.mjs` bell. No samples, voice, fonts or network.
 */
import { RIDES, FPS, RIDE_SECONDS } from './action-facts.mjs';
import {
  bandpass,
  bell,
  gaussian,
  kick,
  lowpass,
  makeRandom,
  onePoleLowpass,
  room,
  shaker,
} from './synth.mjs';

function add(events, event, duration) {
  if (event.time < 0 || event.time >= duration) return;
  events.push(event);
}

function buildEvents(variant, duration) {
  const ride = RIDES[variant];
  const events = [];
  if (variant === 'riverside') {
    add(
      events,
      {
        time: ride.bell.strike,
        duration: 1.2,
        kind: 'bell',
        gain: 0.72,
        pan: 0.16,
      },
      duration,
    );
    ride.pigeons.flapTimes.forEach((time, index) => {
      add(
        events,
        {
          time,
          duration: 0.16,
          kind: 'wing',
          gain: 0.34 + index * 0.035,
          pan: -0.15 + index * 0.09,
        },
        duration,
      );
    });
  } else {
    add(events, { time: ride.bakery.reachStart, duration: 0.26, kind: 'fabric', gain: 0.2, pan: -0.18 }, duration);
    add(
      events,
      { time: ride.bakery.catchContact, duration: 0.2, kind: 'catch', gain: 0.62, pan: 0.12 },
      duration,
    );
    add(events, { time: ride.pigeons.start, duration: 0.3, kind: 'wing', gain: 0.38, pan: -0.1 }, duration);
    add(
      events,
      { time: ride.bakery.stowContact, duration: 0.22, kind: 'stow', gain: 0.5, pan: 0.2 },
      duration,
    );
  }
  events.sort((a, b) => a.time - b.time || a.kind.localeCompare(b.kind));
  for (const event of events) {
    if (
      !Number.isFinite(event.time) ||
      !Number.isFinite(event.duration) ||
      event.time < 0 ||
      event.time >= duration
    )
      throw new Error(
        `risograph foley: invalid event ${event.kind} at ${event.time} (duration ${duration})`,
      );
  }
  return events;
}

/** Pure Foley descriptor for one ride. */
export function buildFoley(params = {}) {
  const variant = params.variant ?? 'riverside';
  if (variant !== 'riverside' && variant !== 'bakery')
    throw new Error(`risograph foley: unknown ride "${variant}"`);
  const duration = params.duration == null ? RIDE_SECONDS : Number(params.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > RIDE_SECONDS)
    throw new Error(`risograph foley: duration must be > 0 and <= ${RIDE_SECONDS} s, got ${duration}`);
  const ride = RIDES[variant];
  const actionStart = ride.foley.start;
  const actionEnd = ride.foley.end;
  const events = buildEvents(variant, duration);
  return {
    seconds: duration,
    bpm: 120,
    variant,
    fps: FPS,
    events,
    sections: [
      { id: 'silence', start: 0, end: Math.min(duration, actionStart), label: 'Music carries the cue' },
      { id: 'action', start: Math.max(0, actionStart), end: Math.min(duration, actionEnd), label: 'Ride action' },
      { id: 'tail', start: Math.min(duration, actionEnd), end: duration, label: 'Tail' },
    ].filter(section => section.end > section.start),
    rests: [],
    cues: [
      ...(variant === 'riverside'
        ? [
            { id: 'bell_strike', time: ride.bell.strike },
            ...ride.pigeons.flapTimes.map((time, index) => ({ id: `wing_${index + 1}`, time })),
          ]
        : [
            { id: 'reach', time: ride.bakery.reachStart },
            { id: 'catch', time: ride.bakery.catchContact },
            { id: 'wing_1', time: ride.pigeons.start },
            { id: 'stow', time: ride.bakery.stowContact },
          ]),
    ],
  };
}

function wing(velocity, duration, sampleRate, rng) {
  const samples = Math.max(1, Math.floor(duration * sampleRate));
  let noise = new Float32Array(samples);
  for (let i = 0; i < samples; i++) noise[i] = rng() * 2 - 1;
  noise = bandpass(noise, 1350, 0.75, sampleRate);
  noise = lowpass(noise, 4200, 0.707, sampleRate);
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const envelope = Math.min(1, t / 0.012) * Math.exp(-t / (duration * 0.55));
    const flutter = 0.72 + 0.28 * Math.abs(Math.sin(2 * Math.PI * 9 * t));
    noise[i] *= envelope * flutter * velocity;
  }
  return noise;
}

function fabric(velocity, duration, sampleRate, rng) {
  const samples = Math.max(1, Math.floor(duration * sampleRate));
  let noise = new Float32Array(samples);
  for (let i = 0; i < samples; i++) noise[i] = rng() * 2 - 1;
  noise = bandpass(noise, 2600, 0.6, sampleRate);
  noise = lowpass(noise, 7000, 0.707, sampleRate);
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    noise[i] *= Math.sin(Math.PI * Math.min(1, t / duration)) ** 1.4 * velocity;
  }
  return noise;
}

function contact(velocity, duration, sampleRate, rng) {
  const samples = Math.max(1, Math.floor(duration * sampleRate));
  const noise = new Float32Array(samples);
  for (let i = 0; i < samples; i++) noise[i] = rng() * 2 - 1;
  const low = onePoleLowpass(noise, 480, sampleRate);
  const out = new Float32Array(samples);
  let phase = 0;
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const frequency = 105 + 35 * Math.exp(-t / 0.025);
    phase += (2 * Math.PI * frequency) / sampleRate;
    out[i] =
      (Math.sin(phase) * Math.exp(-t / 0.07) * 0.75 + low[i] * Math.exp(-t / 0.018) * 0.5) * velocity;
  }
  return out;
}

function stow(velocity, duration, sampleRate, rng) {
  const samples = Math.max(1, Math.floor(duration * sampleRate));
  const out = new Float32Array(samples);
  const thud = kick(velocity * 0.55, sampleRate, rng);
  const rattle = shaker(velocity * 0.25, sampleRate, rng);
  for (let i = 0; i < samples; i++) {
    out[i] = (thud[i] ?? 0) + (rattle[i] ?? 0) * Math.exp(-i / (sampleRate * 0.12));
  }
  return out;
}

function addPanned(left, right, mono, offset, gain, pan) {
  const angle = ((Math.max(-1, Math.min(1, pan)) + 1) * Math.PI) / 4;
  const lg = Math.cos(angle) * gain;
  const rg = Math.sin(angle) * gain;
  const count = Math.min(mono.length, left.length - offset);
  for (let i = 0; i < count; i++) {
    left[offset + i] += mono[i] * lg;
    right[offset + i] += mono[i] * rg;
  }
}

/** Explicit local closing fade; no fake rest window. */
function closingFade(frames, sampleRate, startSeconds) {
  const envelope = new Float32Array(frames);
  envelope.fill(1);
  const start = Math.max(0, Math.min(frames, Math.round(startSeconds * sampleRate)));
  const span = Math.max(1, frames - start);
  for (let i = start; i < frames; i++) {
    const t = (i - start) / span;
    envelope[i] = Math.pow(1 - t, 1.5);
  }
  if (frames > 0) envelope[frames - 1] = 0;
  return envelope;
}

/** Render one Foley cue to exact PCM samples. */
export function renderFoley({ sampleRate, channels, frames, params = {}, seed = 9241 } = {}) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0)
    throw new Error('risograph foley: sampleRate must be a positive number');
  if (channels !== 2) throw new Error('risograph foley: stereo only');
  if (!Number.isInteger(frames) || frames <= 0) throw new Error('risograph foley: frames must be a positive integer');
  if (!Number.isInteger(seed)) throw new Error('risograph foley: seed must be an integer');
  const score = buildFoley(params);
  const expected = Math.round(score.seconds * sampleRate);
  if (frames !== expected)
    throw new Error(
      `risograph foley: duration ${score.seconds} s at ${sampleRate} Hz is ${expected} samples; got ${frames}. ` +
        'The sound contract uses samples/channel from Source.durationSamples. Do not stretch or truncate here.',
    );

  const rng = makeRandom(seed);
  const nextGaussian = gaussian(rng);
  const tail = Math.ceil(1.5 * sampleRate);
  const busLength = frames + tail;
  const leftBus = new Float32Array(busLength);
  const rightBus = new Float32Array(busLength);
  for (const event of score.events) {
    const offset = Math.round(event.time * sampleRate);
    if (offset >= busLength) continue;
    let mono;
    if (event.kind === 'bell') mono = bell(event.gain, sampleRate, rng, nextGaussian);
    else if (event.kind === 'wing') mono = wing(event.gain, event.duration, sampleRate, rng);
    else if (event.kind === 'fabric') mono = fabric(event.gain, event.duration, sampleRate, rng);
    else if (event.kind === 'catch') mono = contact(event.gain, event.duration, sampleRate, rng);
    else if (event.kind === 'stow') mono = stow(event.gain, event.duration, sampleRate, rng);
    else throw new Error(`risograph foley: unknown kind "${event.kind}"`);
    addPanned(leftBus, rightBus, mono, offset, 1, event.pan);
  }

  const dryLeft = leftBus.subarray(0, frames);
  const dryRight = rightBus.subarray(0, frames);
  const send = new Float32Array(frames);
  for (let i = 0; i < frames; i++) send[i] = (dryLeft[i] + dryRight[i]) * 0.70710678 * 0.12;
  const [wetLeft, wetRight] = room(send, sampleRate);
  const gate = closingFade(frames, sampleRate, Math.max(0, score.seconds - 0.15));
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  let peak = 0;
  for (let i = 0; i < frames; i++) {
    left[i] = (dryLeft[i] * 0.72 + wetLeft[i]) * gate[i];
    right[i] = (dryRight[i] * 0.72 + wetRight[i]) * gate[i];
    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  }
  const target = Math.pow(10, -3 / 20);
  const scale = peak > 1e-12 ? target / peak : 0;
  let outputPeak = 0;
  for (let i = 0; i < frames; i++) {
    left[i] *= scale;
    right[i] *= scale;
    if (!Number.isFinite(left[i]) || !Number.isFinite(right[i]))
      throw new Error(`risograph foley: non-finite output at ${i}`);
    if (Math.abs(left[i]) > 1 || Math.abs(right[i]) > 1)
      throw new Error(`risograph foley: output exceeds full scale at ${i}`);
    outputPeak = Math.max(outputPeak, Math.abs(left[i]), Math.abs(right[i]));
  }
  return {
    channels: [left, right],
    report: {
      role: 'foley',
      seconds: score.seconds,
      variant: score.variant,
      sampleRate,
      samples: frames,
      peak: outputPeak,
      rawPeak: peak,
      normalizationScale: scale,
      normalizationTarget: target,
      normalizationTargetDbfs: -3,
      events: score.events.length,
      cues: score.cues,
    },
  };
}
