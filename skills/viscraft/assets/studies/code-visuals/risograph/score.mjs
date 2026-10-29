/**
 * RISOGRAPH RIDE — a four-second bossa cue for one ride.
 *
 * The cue is deliberately short because the picture is one 96-frame ride, not
 * a film. At 120 BPM one ride is two bars (8 beats). The plate gates in
 * `action-facts.mjs` are also the musical entries (default: blue 0.00 s,
 * yellow 0.75 s, pink 1.50 s).
 *
 * The two action moments are left open: the riverside bell strike is at
 * 2.3333 s (the first 12 Hz visual step that actually reaches the 2.3 s bell
 * target) and the bakery catch contact is at 2.75 s (the first 12 Hz step at
 * the full caught position). Guitar, brush and vibes start no new attacks in
 * the action window and their sustained tail is ducked; low bass may continue.
 * The cue answers after each action and closes on Dmaj9 by 4.0 s. There is no
 * continuous pad or uniform tone bed.
 *
 * This module is local to the risograph study. `buildMusic` returns a small
 * descriptor; `renderMusic` consumes it and returns exact PCM samples. It uses
 * the local `synth.mjs` copy for its voices; there are no samples, fonts, voice
 * or network resources.
 */
import { RIDES, FPS, RIDE_SECONDS, BEAT, BAR } from './action-facts.mjs';
import {
  bassNote,
  brush,
  gaussian,
  guitarNote,
  makeRandom,
  room,
  vibeNote,
} from './synth.mjs';

const D_MAJ9_HIGH = ['A4', 'C#5', 'E5'];
const B_MIN9_HIGH = ['B4', 'D5', 'F#5'];
const D_MAJ9_FINAL = ['D3', 'F#3', 'A3', 'C#4', 'E4'];

const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function noteToMidi(name) {
  const letter = NOTE[name[0]];
  if (letter === undefined) throw new Error(`risograph music: bad note "${name}"`);
  let pitch = letter;
  let index = 1;
  while (index < name.length && (name[index] === '#' || name[index] === 'b')) {
    pitch += name[index] === '#' ? 1 : -1;
    index++;
  }
  return 12 * (Number(name.slice(index)) + 1) + pitch;
}

function smooth01(value) {
  const x = Math.max(0, Math.min(1, value));
  return x * x * (3 - 2 * x);
}

/**
 * The action window is derived from the same ride facts as the picture and
 * Foley. Guitar, brush and vibes may not start a new attack inside it; the
 * sustained vibes tail is ducked after the room. Low bass may continue.
 */
function actionSpaceFor(ride) {
  return {
    start: ride.action.start,
    end: ride.action.end,
    contact: ride.action.contact,
    kind: ride.action.kind,
    scope: ['guitar', 'brush', 'vibes'],
    gain: 0.35,
    label: 'Action space: no new guitar/brush/vibes attacks; bass may sustain',
  };
}

function add(events, event, duration, space) {
  if (!event || event.time < 0 || event.time >= duration) return;
  if (event.time >= space.start && event.time < space.end && space.scope.includes(event.voice)) return;
  events.push(event);
}

function addChord(events, duration, space, time, names, hold, gain, options = {}) {
  names.forEach((name, index) => {
    add(
      events,
      {
        time: time + index * 0.004,
        duration: hold,
        voice: options.voice ?? 'guitar',
        midi: noteToMidi(name),
        gain: gain * (0.92 + 0.02 * index),
        pan: options.pan ?? -0.2,
        ...(options.bright != null ? { bright: options.bright } : {}),
        ...(options.motor != null ? { motor: options.motor } : {}),
        ...(options.pedal != null ? { pedal: options.pedal } : {}),
      },
      duration,
      space,
    );
  });
}

function sectionsFor(duration, ride, space) {
  const gates = ride.press.gates;
  const g0 = Math.max(0, gates[0]);
  const g1 = Math.max(g0, gates[1]);
  const g2 = Math.max(g1, gates[2]);
  const raw = [];
  if (g0 > 0) raw.push({ id: 'idle', start: 0, end: g0, label: 'Before blue' });
  raw.push(
    { id: 'blue', start: g0, end: g1, label: 'Blue: bass and brush' },
    { id: 'yellow', start: g1, end: g2, label: 'Yellow: guitar enters' },
    { id: 'pink', start: g2, end: space.start, label: 'Pink: vibes enter' },
    { id: 'action-space', start: space.start, end: space.end, label: space.label },
    { id: 'answer', start: space.end, end: 3.5, label: 'Return and answer' },
    { id: 'close', start: 3.5, end: 4, label: 'Close on Dmaj9' },
  );
  return raw
    .map(section => ({ ...section, end: Math.min(section.end, duration) }))
    .filter(section => section.end > section.start)
    .map(section => ({ ...section }));
}

/**
 * Pure music descriptor for one ride. `duration` is the source length in
 * seconds (4 for the full ride); shorter values trim the tail, they do not
 * stretch the phrase.
 */
export function buildMusic(params = {}) {
  const variant = params.variant ?? 'riverside';
  if (variant !== 'riverside' && variant !== 'bakery')
    throw new Error(`risograph music: unknown ride "${variant}"`);
  const duration = params.duration == null ? RIDE_SECONDS : Number(params.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > RIDE_SECONDS)
    throw new Error(`risograph music: duration must be > 0 and <= ${RIDE_SECONDS} s, got ${duration}`);
  const ride = RIDES[variant];
  const space = actionSpaceFor(ride);
  const gates = ride.press.gates;
  const g0 = Math.max(0, gates[0]);
  const g1 = Math.max(g0, gates[1]);
  const g2 = Math.max(g1, gates[2]);
  const postAction = space.end + 0.2;
  const events = [];

  // Bass: the bossa root/fifth pulse, with a return to D at 3.0 s. Bass is
  // deliberately outside the action-space duck so a low pulse can continue.
  add(events, { time: g0, duration: 0.7, voice: 'bass', midi: noteToMidi('D2'), gain: 0.85, pan: 0 }, duration, space);
  add(events, { time: g0 + BEAT * 1.5, duration: 0.22, voice: 'bass', midi: noteToMidi('A2'), gain: 0.55, pan: 0 }, duration, space);
  add(events, { time: g0 + BEAT * 2, duration: 0.7, voice: 'bass', midi: noteToMidi('D2'), gain: 0.75, pan: 0 }, duration, space);
  add(events, { time: g0 + BEAT * 3.5, duration: 0.22, voice: 'bass', midi: noteToMidi('A2'), gain: 0.5, pan: 0 }, duration, space);
  add(events, { time: g0 + BAR, duration: 0.7, voice: 'bass', midi: noteToMidi('B2'), gain: 0.8, pan: 0 }, duration, space);
  add(events, { time: g0 + BAR + BEAT * 1.5, duration: 0.22, voice: 'bass', midi: noteToMidi('F#2'), gain: 0.52, pan: 0 }, duration, space);
  add(events, { time: g0 + BAR + BEAT * 2, duration: 0.95, voice: 'bass', midi: noteToMidi('D2'), gain: 0.82, pan: 0 }, duration, space);

  // Brush: soft strokes, with the action window left open.
  for (const time of [g0 + 0.5, g0 + 1.5, postAction, 3.5]) {
    add(events, { time, duration: 0.18, voice: 'brush', gain: 0.18, pan: 0.16 }, duration, space);
  }

  // Guitar enters at the yellow gate, and the notes are relative to that gate.
  addChord(events, duration, space, g1, ['F#3', 'A3', 'C#4', 'E4'], 0.28, 0.5, { bright: 0.45 });
  addChord(events, duration, space, g1 + 0.5, ['F#3', 'A3', 'C#4'], 0.24, 0.42, { bright: 0.5 });
  addChord(events, duration, space, g1 + 1.0, ['F#3', 'A3', 'C#4', 'E4'], 0.24, 0.44, { bright: 0.5 });
  addChord(events, duration, space, postAction, ['D3', 'F#3', 'A3', 'C#4'], 0.26, 0.44, {
    bright: 0.48,
  });
  addChord(events, duration, space, 3.0, ['F#3', 'A3', 'C#4', 'E4'], 0.22, 0.4, { bright: 0.52 });

  // Vibes enter at the pink gate; the answer differs by ride.
  addChord(events, duration, space, g2, D_MAJ9_HIGH, 0.42, 0.5, {
    voice: 'vibes',
    pan: 0.3,
    motor: 5.6,
    pedal: 0.35,
  });
  addChord(events, duration, space, g2 + 0.5, B_MIN9_HIGH, 0.42, 0.42, {
    voice: 'vibes',
    pan: 0.3,
    motor: 5.6,
    pedal: 0.3,
  });
  if (variant === 'riverside') {
    addChord(events, duration, space, postAction, D_MAJ9_HIGH, 0.34, 0.42, {
      voice: 'vibes',
      pan: 0.3,
      motor: 5.4,
      pedal: 0.2,
    });
  } else {
    addChord(events, duration, space, postAction, ['F#4', 'A4', 'C#5'], 0.34, 0.42, {
      voice: 'vibes',
      pan: 0.3,
      motor: 6,
      pedal: 0.2,
    });
  }
  addChord(events, duration, space, 3.0, D_MAJ9_HIGH, 0.34, 0.44, {
    voice: 'vibes',
    pan: 0.3,
    motor: 5.6,
    pedal: 0.2,
  });

  // Close: a final Dmaj9 strum and vibes chord, ringing into the closing fade.
  addChord(events, duration, space, 3.5, D_MAJ9_FINAL, 0.5, 0.58, { bright: 0.5 });
  addChord(events, duration, space, 3.5, ['D4', 'F#4', 'A4', 'C#5', 'E5'], 0.5, 0.5, {
    voice: 'vibes',
    pan: 0.3,
    motor: 5.6,
    pedal: 0.2,
  });

  events.sort((a, b) => a.time - b.time || a.voice.localeCompare(b.voice));
  for (const event of events) {
    if (
      !Number.isFinite(event.time) ||
      !Number.isFinite(event.duration) ||
      event.time < 0 ||
      event.time >= duration
    )
      throw new Error(
        `risograph music: invalid event ${event.voice} at ${event.time} (duration ${duration})`,
      );
  }
  return {
    seconds: duration,
    bpm: 120,
    variant,
    fps: FPS,
    events,
    sections: sectionsFor(duration, ride, space),
    spaces: [{ ...space }],
    rests: [],
    cues: [
      { id: 'bass_in', time: g0 },
      { id: 'guitar_in', time: g1 },
      { id: 'vibes_in', time: g2 },
      { id: 'action_space_start', time: space.start },
      { id: 'action_space_end', time: space.end },
      { id: space.kind === 'bell' ? 'bell_strike' : 'catch', time: space.contact },
      { id: 'return', time: 3.0 },
      { id: 'close', time: 3.5 },
    ],
  };
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

/** Smooth duck for the selected action-space stems, applied after the room. */
function duckEnvelope(frames, sampleRate, startSeconds, endSeconds, depth, edgeSeconds = 0.06) {
  const envelope = new Float32Array(frames);
  envelope.fill(1);
  const start = Math.max(0, Math.min(frames, Math.round(startSeconds * sampleRate)));
  const end = Math.max(start, Math.min(frames, Math.round(endSeconds * sampleRate)));
  const edge = Math.max(1, Math.round(edgeSeconds * sampleRate));
  for (let i = Math.max(0, start - edge); i < start; i++) {
    const t = (i - (start - edge)) / edge;
    envelope[i] = 1 - (1 - depth) * smooth01(t);
  }
  for (let i = start; i < end; i++) envelope[i] = depth;
  for (let i = end; i < Math.min(frames, end + edge); i++) {
    const t = (i - end) / edge;
    envelope[i] = depth + (1 - depth) * smooth01(t);
  }
  return envelope;
}

/**
 * Render one music cue. `frames` is the exact per-channel SAMPLE count from the
 * sound contract, not a video frame count.
 */
export function renderMusic({ sampleRate, channels, frames, params = {}, seed = 9241 } = {}) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0)
    throw new Error('risograph music: sampleRate must be a positive number');
  if (channels !== 2) throw new Error('risograph music: stereo only');
  if (!Number.isInteger(frames) || frames <= 0) throw new Error('risograph music: frames must be a positive integer');
  if (!Number.isInteger(seed)) throw new Error('risograph music: seed must be an integer');
  const score = buildMusic(params);
  const expected = Math.round(score.seconds * sampleRate);
  if (frames !== expected)
    throw new Error(
      `risograph music: duration ${score.seconds} s at ${sampleRate} Hz is ${expected} samples; got ${frames}. ` +
        'The sound contract uses samples/channel from Source.durationSamples. Do not stretch or truncate here.',
    );

  const rng = makeRandom(seed);
  const nextGaussian = gaussian(rng);
  const tail = Math.ceil(1.5 * sampleRate);
  const busLength = frames + tail;
  const buses = {
    guitar: { left: new Float32Array(busLength), right: new Float32Array(busLength) },
    bass: { left: new Float32Array(busLength), right: new Float32Array(busLength) },
    vibes: { left: new Float32Array(busLength), right: new Float32Array(busLength) },
    brush: { left: new Float32Array(busLength), right: new Float32Array(busLength) },
  };
  for (const event of score.events) {
    const offset = Math.round(event.time * sampleRate);
    if (offset >= busLength) continue;
    let mono;
    if (event.voice === 'guitar') {
      mono = guitarNote(event.midi, event.duration, {
        sampleRate,
        rng,
        nextGaussian,
        velocity: event.gain,
        brightness: event.bright ?? 0.48,
        t60: 3.2,
      });
    } else if (event.voice === 'bass') {
      mono = bassNote(event.midi, event.duration, { sampleRate, rng, nextGaussian, velocity: event.gain });
    } else if (event.voice === 'vibes') {
      mono = vibeNote(event.midi, event.duration, {
        sampleRate,
        rng,
        nextGaussian,
        velocity: event.gain,
        motor: event.motor ?? 5.6,
        pedal: event.pedal ?? 0.3,
        release: 0.2,
      });
    } else if (event.voice === 'brush') {
      mono = brush(event.gain, event.duration, sampleRate, rng);
    } else {
      throw new Error(`risograph music: unknown voice "${event.voice}"`);
    }
    addPanned(buses[event.voice].left, buses[event.voice].right, mono, offset, 1, event.pan);
  }

  const levels = { guitar: 0.62, bass: 0.7, vibes: 0.28, brush: 0.5 };
  const sends = { guitar: 0.16, bass: 0.05, vibes: 0.26, brush: 0.05 };
  const space = score.spaces[0];
  const duck = duckEnvelope(frames, sampleRate, space.start, space.end, space.gain, 0.06);
  const gate = closingFade(frames, sampleRate, Math.max(0, score.seconds - 0.2));
  const stems = {};
  for (const voice of Object.keys(buses)) {
    const dryLeft = buses[voice].left.subarray(0, frames);
    const dryRight = buses[voice].right.subarray(0, frames);
    const send = new Float32Array(frames);
    for (let i = 0; i < frames; i++) send[i] = (dryLeft[i] + dryRight[i]) * 0.70710678 * sends[voice];
    const [wetLeft, wetRight] = room(send, sampleRate);
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    const ducked = space.scope.includes(voice);
    for (let i = 0; i < frames; i++) {
      const actionGain = ducked ? duck[i] : 1;
      left[i] = (dryLeft[i] * levels[voice] + wetLeft[i]) * gate[i] * actionGain;
      right[i] = (dryRight[i] * levels[voice] + wetRight[i]) * gate[i] * actionGain;
    }
    stems[voice] = [left, right];
  }

  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  let peak = 0;
  for (let i = 0; i < frames; i++) {
    let l = 0;
    let r = 0;
    for (const voice of Object.keys(stems)) {
      l += stems[voice][0][i];
      r += stems[voice][1][i];
    }
    left[i] = l;
    right[i] = r;
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
  }
  const target = Math.pow(10, -3 / 20);
  const scale = peak > 1e-12 ? target / peak : 0;
  let outputPeak = 0;
  for (let i = 0; i < frames; i++) {
    left[i] *= scale;
    right[i] *= scale;
    if (!Number.isFinite(left[i]) || !Number.isFinite(right[i]))
      throw new Error(`risograph music: non-finite output at ${i}`);
    if (Math.abs(left[i]) > 1 || Math.abs(right[i]) > 1)
      throw new Error(`risograph music: output exceeds full scale at ${i}`);
    outputPeak = Math.max(outputPeak, Math.abs(left[i]), Math.abs(right[i]));
  }
  return {
    channels: [left, right],
    report: {
      role: 'music',
      seconds: score.seconds,
      bpm: score.bpm,
      sampleRate,
      samples: frames,
      peak: outputPeak,
      rawPeak: peak,
      normalizationScale: scale,
      normalizationTarget: target,
      normalizationTargetDbfs: -3,
      rms: Math.sqrt(
        left.reduce((sum, value) => sum + value * value, 0) / frames / 2 +
          right.reduce((sum, value) => sum + value * value, 0) / frames / 2,
      ),
      events: score.events.length,
      sections: score.sections,
      spaces: score.spaces,
      actionSpace: score.spaces[0],
    },
  };
}
