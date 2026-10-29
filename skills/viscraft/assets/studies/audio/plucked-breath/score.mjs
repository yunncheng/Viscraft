/*
 * plucked-breath — a 32-second passage for plucked strings, breath and silence.
 *
 * This module is the whole audible piece. It has two public entry points:
 *
 *   buildScore(params = {})  -> a plain, inspectable score descriptor
 *   renderScore({sampleRate, channels, frames, params, seed})
 *                              -> { channels: Float32Array[] }
 *
 * `buildScore` is the single authority for the passage: sections, events,
 * rests, cues and the hard-cut point all come from it. `renderScore` is a pure,
 * seeded synthesiser: it renders exactly `frames` per-channel samples (samples,
 * not 24 fps picture frames), returns finite values within full scale and does
 * not read a clock, the network or unseeded randomness. Two calls with the same
 * arguments return byte-identical Float32Arrays.
 *
 * The instruments are procedural, not recordings:
 *   - a guqin-like digital waveguide: variable fractional delay (bend / vibrato /
 *     slide), frequency-dependent loop loss, one allpass for string stiffness,
 *     pluck-position excitation and a parallel body-resonance bank;
 *   - a guqin-like harmonic (touched node, brighter and thinner body);
 *   - a synthetic xiao-like breath/flute: a low harmonic stack with a filtered
 *     breath component and a slow vibrato — NOT a recording of a xiao;
 *   - procedural gran cassa, timpani, frame drum and small gong: no samples, no
 *     TTS and no sword/combat narrative.
 *
 * Adopted MIT mechanisms and their exact upstream ranges are recorded in
 * LICENSES.md; this file is an independent JavaScript implementation for the
 * current `window.viscraftSound` contract, not a copy of the Python module.
 */

/** The passage's picture grid. The Runtime receives samples, not this value. */
export const FPS = 24;
/** 32 s at 24 fps = 768 whole frames. */
export const TOTAL_FRAMES = 768;
export const SECONDS = TOTAL_FRAMES / FPS;
export const BPM = 90;

export const HARD_CUT_FRAME = 584; // 24.333 s — the greppable literal the E2E edits
/** The alternate plan's cut, kept separate so base and alternate differ materially. */
export const ALTERNATE_HARD_CUT_FRAME = 604; // 25.167 s
export const GAP_END_FRAME = 640; // 26.667 s
export const ALTERNATE_GAP_END_FRAME = 660; // 27.500 s


/** Only these params exist. No duration option: there is no arbitrary truncation. */
export const DEFAULT_PARAMS = Object.freeze({
  variant: 'base',
  transpose: 0,
  gain: 1,
});

const PARAM_KEYS = new Set(['variant', 'transpose', 'gain']);
const VARIANTS = new Set(['base', 'alternate']);
const TAU = Math.PI * 2;

/* -------------------------------------------------------------------------- */
/* Notes and params                                                           */
/* -------------------------------------------------------------------------- */

const NOTE_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Parse a scientific pitch name such as `F2`, `C#5` or `Bb3` to a MIDI number. */
export function noteToMidi(name) {
  const match = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(String(name).trim());
  if (!match) throw new Error(`plucked-breath: cannot parse pitch ${JSON.stringify(name)}`);
  const pc = NOTE_PC[match[1].toUpperCase()] + (match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0);
  return 12 * (Number(match[3]) + 1) + pc;
}

export function midiToHz(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function normalizeParams(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('plucked-breath params must be a plain object');
  for (const key of Object.keys(raw))
    if (!PARAM_KEYS.has(key))
      throw new Error(`plucked-breath does not take the param "${key}"; use ${[...PARAM_KEYS].join(', ')}`);
  const variant = raw.variant ?? DEFAULT_PARAMS.variant;
  if (!VARIANTS.has(variant))
    throw new Error(`plucked-breath variant must be "base" or "alternate", got ${JSON.stringify(variant)}`);
  const transpose = raw.transpose ?? DEFAULT_PARAMS.transpose;
  if (!Number.isInteger(transpose) || transpose < -24 || transpose > 24)
    throw new Error('plucked-breath transpose must be an integer between -24 and 24');
  const gain = raw.gain ?? DEFAULT_PARAMS.gain;
  if (!Number.isFinite(gain) || gain < 0.05 || gain > 2)
    throw new Error('plucked-breath gain must be a number between 0.05 and 2');
  return { variant, transpose, gain };
}

/* -------------------------------------------------------------------------- */
/* Score                                                                      */
/* -------------------------------------------------------------------------- */

const sec = (frame) => frame / FPS;

/**
 * The two plans differ materially, not by seed:
 *   base      — rising three-note harmonic answer, 22-hit roll to a late cut,
 *               three isolated harmonics, a 3-second F cadence;
 *   alternate — a four-note answer an octave higher with a different rhythm,
 *               a shorter/later roll with frame-drum ticks, a double cut cue,
 *               a four-note high harmonic group and a later, shorter cadence.
 */
function planFor(variant) {
  if (variant === 'alternate')
    return {
      sparseEnd: 160,
      answersEnd: 304,
      ostinatoEnd: 490,
      crescendoEnd: ALTERNATE_HARD_CUT_FRAME, // cut at 25.167 s by default
      gapEnd: ALTERNATE_GAP_END_FRAME, // 2.333 s of true silence
      harmonicsEnd: 712,
      end: 768,
    };
  return {
    sparseEnd: 160,
    answersEnd: 304,
    ostinatoEnd: 490,
    crescendoEnd: HARD_CUT_FRAME, // cut at 24.333 s by default
    gapEnd: GAP_END_FRAME, // 2.333 s of true silence
    harmonicsEnd: 696,
    end: 768,
  };
}

const SECTION_LABELS = {
  sparse: 'Sparse open strings and breath',
  answers: 'Harmonic answers',
  ostinato: '90 BPM ostinato and steps',
  crescendo: 'Deep drum crescendo',
  gap: 'Hard cut and true quiet gap',
  harmonics: 'Isolated harmonics',
  cadence: 'Restrained F cadence and settle',
};

function sectionAt(plan, frame) {
  if (frame < plan.sparseEnd) return 'sparse';
  if (frame < plan.answersEnd) return 'answers';
  if (frame < plan.ostinatoEnd) return 'ostinato';
  if (frame < plan.crescendoEnd) return 'crescendo';
  if (frame < plan.gapEnd) return 'gap';
  if (frame < plan.harmonicsEnd) return 'harmonics';
  return 'cadence';
}

/**
 * Build the complete score descriptor.
 *
 * All times are seconds on the 24 fps grid; frame boundaries divide exactly.
 * There is no length parameter and no internal clamp: the plan is the piece.
 */
export function buildScore(params = {}) {
  const normalized = normalizeParams(params);
  const plan = planFor(normalized.variant);
  if (plan.crescendoEnd >= plan.gapEnd)
    throw new Error(
      `plucked-breath: the hard cut (${plan.crescendoEnd}) must fall before the gap end (${plan.gapEnd})`,
    );
  const transpose = normalized.transpose;
  const sections = [
    ['sparse', 0, plan.sparseEnd],
    ['answers', plan.sparseEnd, plan.answersEnd],
    ['ostinato', plan.answersEnd, plan.ostinatoEnd],
    ['crescendo', plan.ostinatoEnd, plan.crescendoEnd],
    ['gap', plan.crescendoEnd, plan.gapEnd],
    ['harmonics', plan.gapEnd, plan.harmonicsEnd],
    ['cadence', plan.harmonicsEnd, plan.end],
  ].map(([id, start, end]) => ({
    id,
    label: SECTION_LABELS[id],
    start: sec(start),
    end: sec(end),
  }));

  const events = [];
  let eventId = 0;

  const add = (frame, duration, voice, extra = {}) => {
    const time = sec(frame);
    const section = sectionAt(plan, frame);
    const role =
      extra.role ??
      extra.tag ??
      (voice === 'guqinHarmonic' ? 'harmonic' : voice === 'guqin' ? 'string' : voice);
    const event = {
      id: `ink-${String(++eventId).padStart(3, '0')}`,
      time,
      duration,
      voice,
      role,
      gain: extra.gain ?? 1,
      pan: extra.pan ?? 0,
      section,
    };
    if (extra.midi !== undefined) {
      const midi = extra.midi + (voice === 'granCassa' || voice === 'timpani' || voice === 'frameDrum' || voice === 'gong' ? 0 : transpose);
      if (!Number.isFinite(midi) || midi < 12 || midi > 120)
        throw new Error(`plucked-breath: transposed midi ${midi} is outside 12..120 at event ${event.id}`);
      event.midi = midi;
    }
    for (const key of ['tag', 'harmonic', 'bend', 'vib', 'glide', 'attack', 'release', 'decay', 'vel'])
      if (extra[key] !== undefined) event[key] = extra[key];
    events.push(event);
    return event;
  };

  const G = (frame, duration, pitch, extra = {}) =>
    add(frame, duration, 'guqin', { ...extra, midi: noteToMidi(pitch) });
  const H = (frame, duration, pitch, extra = {}) =>
    add(frame, duration, 'guqinHarmonic', { ...extra, midi: noteToMidi(pitch), harmonic: true });
  const X = (frame, duration, pitch, extra = {}) =>
    add(frame, duration, 'xiao', { ...extra, midi: noteToMidi(pitch) });
  const D = (frame, kind, extra = {}) => add(frame, extra.duration ?? 1.4, kind, extra);

  if (normalized.variant === 'base') {
    /* A — 虚白: one drop, one breath, three harmonic flecks, a falling slide. */
    G(22, 5.2, 'F2', { gain: 1.25, tag: 'ink-drop' });
    X(62, 3.6, 'C4', { gain: 0.8, pan: -0.2, attack: 1.4 });
    H(82, 1.15, 'C5', { gain: 0.9, pan: 0.25 });
    H(96, 1.05, 'F5', { gain: 0.9, pan: -0.1 });
    H(110, 0.95, 'A5', { gain: 0.85, pan: 0.15 });
    G(144, 1.0, 'D3', { gain: 0.9, pan: 0.1, bend: [[0, 0], [0.25, 0], [1.0, -2]], tag: 'slide-in' });

    /* B — 江岸: press-slide in, one vibrato, three strokes, a high fleck. */
    G(168, 1.4, 'A3', { gain: 1, pan: 0.05, bend: [[0, -2], [0.25, 0]] });
    G(192, 0.8, 'C4', { gain: 0.85, pan: 0.1, vib: [4.5, 0.18, 0.3] });
    G(211, 0.55, 'F3', { gain: 1.1, vel: 0.75 });
    G(226, 0.55, 'A3', { gain: 1.1, vel: 0.75 });
    G(240, 0.55, 'C4', { gain: 1.1, vel: 0.75, tag: 'three-strokes' });
    H(247, 0.8, 'F6', { gain: 0.85, pan: 0.3, tag: 'tassel' });
    X(216, 2.0, 'A4', { gain: 0.55, pan: -0.22, attack: 0.7 });
    G(269, 1.8, 'D3', { gain: 0.8, pan: -0.1, bend: [[0, 0], [0.9, 0], [1.6, -2]] });
    G(288, 1.2, 'G2', { gain: 0.75, pan: 0.1 });
    H(302, 0.8, 'C5', { gain: 0.55, pan: -0.2 });

    /* C — 过江: low ostinato at 90 BPM (eighth = 8 frames) and steps. */
    const seq = ['F2', 'C3', 'F3', 'C3', 'G2', 'D3', 'G3', 'D3'];
    for (let i = 0, frame = 304; frame < 472; frame += 8, i++) {
      const fade = 1 - Math.max(0, (sec(frame) - 19.0) / 1.0) * 0.7;
      G(frame, 0.32, seq[i % 8], {
        gain: 0.7 * fade,
        pan: (i % 2 ? 0.12 : -0.12),
        vel: 0.34 * fade,
        tag: 'ostinato',
      });
    }
    const stepPitches = ['C4', 'D4', 'F4', 'D4', 'C4', 'A3', 'C4', 'D4'];
    for (let k = 0; k < 8; k++) {
      const frame = 368 + k * 16;
      G(frame, 0.22, stepPitches[k], {
        gain: 0.75,
        pan: k % 2 ? 0.15 : -0.15,
        vel: 0.62,
        tag: 'step',
      });
      D(frame, 'frameDrum', { gain: 0.5, pan: 0.1, vel: 0.45, duration: 0.22, tag: 'step-tick' });
    }
    for (const [frame, pitch, duration, gain] of [
      [360, 'A4', 1.33, 0.55],
      [392, 'C5', 1.33, 0.5],
      [424, 'D5', 0.67, 0.5],
      [440, 'C5', 0.67, 0.5],
      [456, 'A4', 1.33, 0.62],
      [480, 'G4', 1.0, 0.55],
    ])
      X(frame, duration, pitch, { gain, pan: -0.2, attack: 0.25, vel: 0.5 });
    G(470, 1.2, 'F2', { gain: 0.9, bend: [[0, 0], [0.4, 0], [1.1, -1]], tag: 'sink' });

    /* D — 浪起: deep hits, four falling low strings, a 28-hit roll to the cut. */
    D(490, 'granCassa', { gain: 0.85, vel: 0.95 });
    D(490, 'timpani', { gain: 0.65, vel: 0.85, pan: 0.05 });
    G(490, 3.0, 'C2', { gain: 0.85, pan: -0.1, bend: [[0, 0], [0.4, 0], [2.8, -2]] });
    G(506, 2.0, 'F2', { gain: 0.55, pan: 0.15, bend: [[0, 0], [0.5, 0], [1.8, -1]] });
    G(538, 1.2, 'A2', { gain: 0.7, pan: -0.15, bend: [[0, 0], [0.3, 0], [1.1, -2]] });
    G(562, 1.5, 'C2', { gain: 0.8, pan: 0.1, bend: [[0, 0], [0.2, 0], [1.4, -3]] });
    for (let frame = 528; frame < 584; frame += 2) {
      const ramp = ((sec(frame) - 22) / (sec(584) - 22)) ** 2.2;
      D(frame, 'granCassa', {
        duration: 0.28,
        gain: 0.1 + 0.4 * ramp,
        vel: 0.12 + 0.78 * ramp,
        pan: frame % 4 === 0 ? -0.08 : 0.08,
        tag: 'roll',
      });
    }
    D(554, 'timpani', { gain: 0.35, vel: 0.5, pan: -0.2 });
    D(570, 'timpani', { gain: 0.45, vel: 0.7, pan: 0.2 });
    D(580, 'granCassa', { gain: 1.0, vel: 1.0, tag: 'cut-hit' });

    /* F — 静: three isolated harmonics after the true gap. */
    H(646, 1.0, 'G5', { gain: 0.95, pan: 0.15 });
    H(660, 0.95, 'C6', { gain: 0.95, pan: -0.1 });
    H(674, 0.9, 'D6', { gain: 0.9, pan: 0.05 });

    /* G — 收卷: a restrained F cadence, one high seal, then settle. */
    G(696, 3.0, 'F2', { gain: 1.0, tag: 'cadence-root' });
    G(712, 2.2, 'C3', { gain: 0.8, pan: 0.1 });
    G(728, 1.6, 'F3', { gain: 0.8, pan: -0.08 });
    G(728, 1.6, 'A3', { gain: 0.7, pan: 0.12 });
    H(738, 1.6, 'F5', { gain: 0.95, pan: 0.05, tag: 'seal' });
    D(738, 'gong', { gain: 0.28, vel: 0.35, pan: 0.12, duration: 2.4, tag: 'seal-gong' });
  } else {
    /* Alternate: different answer register/phrase, roll shape, cut cue,
       harmonic group and cadence. It remains a quiet, non-combat passage. */
    G(22, 5.2, 'F2', { gain: 1.2, tag: 'ink-drop' });
    X(58, 3.2, 'A3', { gain: 0.75, pan: -0.18, attack: 1.2 });
    H(78, 0.9, 'F5', { gain: 0.82, pan: 0.3 });
    H(90, 0.9, 'A5', { gain: 0.86, pan: -0.05 });
    H(102, 0.85, 'C6', { gain: 0.84, pan: 0.2 });
    H(114, 0.8, 'D6', { gain: 0.8, pan: 0.35 });
    G(144, 1.0, 'D3', { gain: 0.9, pan: 0.1, bend: [[0, 0], [0.2, 0], [0.8, -2]], tag: 'slide-in' });

    G(164, 1.3, 'A3', { gain: 0.95, pan: 0.05, bend: [[0, -2], [0.22, 0]] });
    G(190, 0.75, 'C4', { gain: 0.82, pan: 0.1, vib: [4.2, 0.16, 0.28] });
    G(206, 0.5, 'A3', { gain: 1.0, vel: 0.7 });
    G(218, 0.5, 'C4', { gain: 1.05, vel: 0.72 });
    G(230, 0.5, 'D4', { gain: 1.05, vel: 0.72, tag: 'three-strokes' });
    H(242, 0.75, 'A6', { gain: 0.72, pan: 0.28, tag: 'tassel' });
    X(210, 1.8, 'F4', { gain: 0.5, pan: -0.25, attack: 0.6 });
    G(266, 1.7, 'D3', { gain: 0.78, pan: -0.1, bend: [[0, 0], [0.8, 0], [1.5, -2]] });
    G(286, 1.1, 'G2', { gain: 0.72, pan: 0.1 });
    H(300, 0.75, 'A5', { gain: 0.52, pan: -0.15 });

    const seq = ['F2', 'D3', 'F3', 'C3', 'G2', 'D3', 'A3', 'D3'];
    for (let i = 0, frame = 304; frame < 472; frame += 8, i++) {
      const fade = 1 - Math.max(0, (sec(frame) - 19.0) / 1.0) * 0.7;
      G(frame, 0.3, seq[i % 8], {
        gain: 0.68 * fade,
        pan: (i % 2 ? 0.14 : -0.14),
        vel: 0.32 * fade,
        tag: 'ostinato',
      });
    }
    const stepPitches = ['D4', 'F4', 'A3', 'C4', 'D4', 'F4', 'D4', 'C4'];
    for (let k = 0; k < 8; k++) {
      const frame = 360 + k * 16;
      G(frame, 0.2, stepPitches[k], {
        gain: 0.72,
        pan: k % 2 ? -0.12 : 0.16,
        vel: 0.58,
        tag: 'step',
      });
      D(frame, 'frameDrum', { gain: 0.44, pan: -0.1, vel: 0.4, duration: 0.2, tag: 'step-tick' });
    }
    for (const [frame, pitch, duration, gain] of [
      [356, 'F4', 1.2, 0.5],
      [388, 'A4', 1.2, 0.48],
      [420, 'C5', 0.65, 0.48],
      [436, 'A4', 0.65, 0.48],
      [452, 'F4', 1.2, 0.58],
      [478, 'D4', 0.95, 0.5],
    ])
      X(frame, duration, pitch, { gain, pan: -0.18, attack: 0.25, vel: 0.48 });
    G(470, 1.2, 'F2', { gain: 0.88, bend: [[0, 0], [0.4, 0], [1.1, -1]], tag: 'sink' });

    D(490, 'granCassa', { gain: 0.85, vel: 0.9 });
    D(490, 'timpani', { gain: 0.65, vel: 0.8, pan: 0.05 });
    G(490, 2.8, 'C2', { gain: 0.82, pan: -0.1, bend: [[0, 0], [0.35, 0], [2.5, -2]] });
    G(512, 1.8, 'F2', { gain: 0.55, pan: 0.12, bend: [[0, 0], [0.45, 0], [1.6, -1]] });
    G(548, 1.1, 'A2', { gain: 0.68, pan: -0.12, bend: [[0, 0], [0.25, 0], [1.0, -2]] });
    G(578, 1.2, 'C2', { gain: 0.75, pan: 0.1, bend: [[0, 0], [0.2, 0], [1.1, -3]] });
    for (let frame = 536; frame < 604; frame += 3) {
      const ramp = ((sec(frame) - 22.333) / (sec(604) - 22.333)) ** 1.6;
      D(frame, 'granCassa', {
        duration: 0.24,
        gain: 0.09 + 0.45 * ramp,
        vel: 0.1 + 0.85 * ramp,
        pan: frame % 6 === 0 ? -0.1 : 0.1,
        tag: 'roll',
      });
      if (frame % 6 === 0) D(frame, 'frameDrum', { gain: 0.1 + 0.18 * ramp, vel: 0.3 + 0.3 * ramp, duration: 0.16, pan: 0.2, tag: 'roll-tick' });
    }
    D(592, 'timpani', { gain: 0.45, vel: 0.62, pan: -0.18 });
    D(600, 'frameDrum', { gain: 0.7, vel: 0.9, pan: 0.18, duration: 0.2, tag: 'cut-tick' });
    D(602, 'granCassa', { gain: 0.95, vel: 0.98, tag: 'cut-hit' });

    H(666, 0.9, 'A5', { gain: 0.9, pan: -0.1 });
    H(678, 0.85, 'C6', { gain: 0.88, pan: 0.15 });
    H(690, 0.8, 'F6', { gain: 0.82, pan: 0.3 });
    H(701, 0.75, 'A6', { gain: 0.74, pan: -0.15 });

    G(712, 2.4, 'F2', { gain: 1.0, tag: 'cadence-root' });
    G(724, 1.9, 'C3', { gain: 0.78, pan: 0.1 });
    G(738, 1.4, 'F3', { gain: 0.78, pan: -0.08 });
    G(738, 1.4, 'A3', { gain: 0.66, pan: 0.12 });
    H(746, 1.2, 'F5', { gain: 0.9, pan: 0.05, tag: 'seal' });
    D(746, 'gong', { gain: 0.24, vel: 0.32, pan: 0.12, duration: 2.0, tag: 'seal-gong' });
  }

  // The descriptor is chronological; the renderer and an E2E both rely on it.
  events.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));

  const cutTime = sec(plan.crescendoEnd);
  const gapEnd = sec(plan.gapEnd);

  const cues = [
    { id: 'ink-drop', time: sec(22) },
    { id: 'harmonic-answers', time: sec(plan.sparseEnd) },
    { id: 'ostinato', time: sec(plan.answersEnd) },
    { id: 'crescendo', time: sec(plan.ostinatoEnd) },
    { id: 'cut-cue', time: cutTime },
    { id: 'hard-cut', time: cutTime },
    { id: 'gap-end', time: gapEnd },
    { id: 'cadence', time: sec(plan.harmonicsEnd) },
  ];
  if (normalized.variant === 'alternate') cues.push({ id: 'cut-tick', time: sec(600) });
  else cues.push({ id: 'last-roll', time: sec(580) });
  cues.sort((a, b) => a.time - b.time);

  return {
    seconds: SECONDS,
    fps: FPS,
    frames: TOTAL_FRAMES,
    bpm: BPM,
    variant: normalized.variant,
    transpose: normalized.transpose,
    gain: normalized.gain,
    sections,
    events,
    rests: [{ start: cutTime, end: gapEnd, scope: 'all' }],
    cues,
    cut: { time: cutTime, gapEnd },
    plan: { ...plan },
  };
}

/* -------------------------------------------------------------------------- */
/* Deterministic numeric helpers                                              */
/* -------------------------------------------------------------------------- */

function makeRandom(seed) {
  let state = (Number.isInteger(seed) ? seed : 7) >>> 0;
  if (state === 0) state = 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

function gaussian(rand) {
  const u1 = Math.max(rand(), 1e-12);
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(TAU * u2);
}

function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

/** One-pole low-pass; returns the filtered buffer. */
function onePoleLowpass(input, cutoff, sampleRate) {
  const a = 1 - Math.exp((-TAU * cutoff) / sampleRate);
  const out = new Float64Array(input.length);
  let state = 0;
  for (let i = 0; i < input.length; i++) {
    state += a * (input[i] - state);
    out[i] = state;
  }
  return out;
}

/** One-pole high-pass (input minus its low-pass state). */
function onePoleHighpass(input, cutoff, sampleRate) {
  const a = 1 - Math.exp((-TAU * cutoff) / sampleRate);
  const out = new Float64Array(input.length);
  let state = 0;
  for (let i = 0; i < input.length; i++) {
    state += a * (input[i] - state);
    out[i] = input[i] - state;
  }
  return out;
}

/** Phase delay of the one-pole loop loss at `f`, in samples. */
function lowpassDelay(p, f, sampleRate) {
  const w = (TAU * f) / sampleRate;
  return Math.atan2(p * Math.sin(w), 1 - p * Math.cos(w)) / w;
}

/** Phase delay of the first-order allpass (a + z^-1)/(1 + a z^-1), in samples. */
function allpassDelay(a, f, sampleRate) {
  const w = (TAU * f) / sampleRate;
  const num = Math.atan2(-Math.sin(w), a + Math.cos(w));
  const den = Math.atan2(-a * Math.sin(w), 1 + a * Math.cos(w));
  return -(num - den) / w;
}

/** RBJ band-pass biquad (0 dB peak), applied in place to a fresh buffer. */
function bandpass(input, frequency, q, sampleRate) {
  const out = new Float64Array(input.length);
  const f = clamp(frequency, 20, sampleRate * 0.45);
  const w0 = (TAU * f) / sampleRate;
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0;
  const b2 = -alpha / a0;
  const a1 = (-2 * Math.cos(w0)) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    out[i] = y;
  }
  return out;
}

/** Parallel body-resonance bank; `modes` are [Hz, Q, gain]. */
function bodyResonance(input, modes, wetMix, sampleRate) {
  if (!modes.length) return input;
  const wet = new Float64Array(input.length);
  for (const [frequency, q, gain] of modes) {
    if (frequency >= sampleRate * 0.45) continue;
    const band = bandpass(input, frequency, q, sampleRate);
    for (let i = 0; i < wet.length; i++) wet[i] += gain * band[i];
  }
  const out = new Float64Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i] * (1 - wetMix) + wet[i] * wetMix * 2.5;
  return out;
}

/* -------------------------------------------------------------------------- */
/* Guqin-like waveguide                                                       */
/* -------------------------------------------------------------------------- */

const GUQIN = Object.freeze({
  t60: 7.0,
  damp: 0.45,
  pos: 0.13,
  bright: 0.35,
  body: [
    [95, 5, 1],
    [210, 6, 0.8],
    [420, 6, 0.5],
    [820, 5, 0.35],
    [1500, 4, 0.2],
  ],
  bodyMix: 0.55,
  noise: 0.02,
  slideNoise: 0.5,
});

function pitchCurve(midi, n, sampleRate, bend, vib, glide) {
  const curve = new Float64Array(n);
  const time = (i) => i / sampleRate;
  let bendTimes = null;
  let bendValues = null;
  if (bend) {
    const sorted = [...bend].sort((a, b) => a[0] - b[0]);
    bendTimes = sorted.map((p) => p[0]);
    bendValues = sorted.map((p) => p[1]);
  }
  for (let i = 0; i < n; i++) {
    const t = time(i);
    let value = midi;
    if (bendTimes) {
      if (t <= bendTimes[0]) value += bendValues[0];
      else if (t >= bendTimes[bendTimes.length - 1]) value += bendValues[bendValues.length - 1];
      else {
        let k = 1;
        while (k < bendTimes.length && bendTimes[k] < t) k++;
        const span = bendTimes[k] - bendTimes[k - 1];
        const frac = span > 1e-9 ? (t - bendTimes[k - 1]) / span : 0;
        value += bendValues[k - 1] + (bendValues[k] - bendValues[k - 1]) * frac;
      }
    }
    if (glide) {
      const [targetName, seconds] = glide;
      const target = typeof targetName === 'number' ? targetName : noteToMidi(targetName);
      value += (target - midi) * clamp(t / Math.max(seconds, 1e-3), 0, 1) ** 1.5;
    }
    if (vib) {
      const [rate, depth, start = 0.3] = vib;
      const ramp = clamp((t - start) / 0.4, 0, 1);
      value += depth * ramp * Math.sin(TAU * rate * Math.max(t - start, 0));
    }
    curve[i] = value;
  }
  return curve;
}

function pluckExcitation(f0, sampleRate, velocity, position, bright, noiseAmount, rand, harmonic) {
  const n = Math.max(4, Math.round(sampleRate / f0));
  const k = Math.max(1, Math.round(position * n));
  const tri = new Float64Array(n);
  for (let i = 0; i < n; i++) tri[i] = i < k ? i / k : (n - i) / (n - k);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += tri[i];
  mean /= n;
  const excited = new Float64Array(n);
  for (let i = 0; i < n; i++) excited[i] = tri[i] - mean;
  if (!harmonic) for (let i = 0; i < n; i++) excited[i] += noiseAmount * gaussian(rand) * (1 + velocity);
  const cutoff = clamp(700 + 15000 * bright * velocity ** 1.3, 400, sampleRate * 0.45);
  const filtered = onePoleLowpass(excited, cutoff, sampleRate);
  const d = Math.max(1, Math.round(position * n));
  const combed = new Float64Array(n);
  for (let i = 0; i < n; i++) combed[i] = filtered[i] - (i >= d ? filtered[i - d] * 0.6 : 0);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(combed[i]));
  if (peak > 1e-9) for (let i = 0; i < n; i++) combed[i] /= peak;
  return combed;
}

/**
 * Render one guqin-like note. The waveguide is the adapted core: a variable
 * fractional delay (3rd-order Lagrange) lets the pitch move per sample, a
 * one-pole loop loss darkens the decay, one allpass adds string stiffness, and
 * a parallel body bank gives the dark wooden body.
 */
function synthString({ sampleRate, midi, duration, velocity, harmonic, bend, vib, glide, rand, secondsLeft }) {
  const f0 = midiToHz(midi);
  const preset = GUQIN;
  const damp = harmonic ? Math.min(0.85, preset.damp + 0.3) : preset.damp;
  const position = harmonic ? 0.5 : preset.pos;
  const bright = harmonic ? 0.15 : preset.bright;
  const noiseAmount = harmonic ? 0 : preset.noise;
  const nap = harmonic ? 0 : 1;
  const ap = -0.05;
  const t60Base = preset.t60 * (harmonic ? 1.8 : 1) * (220 / Math.max(f0, 30)) ** 0.35;
  const tail = harmonic ? 0.8 : 0.25;
  const wanted = (duration + Math.min(t60Base, 4)) * sampleRate;
  const n = Math.max(32, Math.min(Math.ceil(wanted), Math.max(32, Math.ceil(secondsLeft * sampleRate))));

  const pitch = pitchCurve(midi, n, sampleRate, bend, vib, glide);
  const compensation = lowpassDelay(damp, f0, sampleRate) + (nap ? allpassDelay(ap, f0, sampleRate) : 0);
  let minFrequency = f0;
  for (let i = 0; i < n; i += 16) minFrequency = Math.min(minFrequency, midiToHz(pitch[i]));
  const maxDelay = sampleRate / Math.max(minFrequency, 20) + 16;
  let size = 16;
  while (size < maxDelay + 16) size *= 2;
  const mask = size - 1;
  const buffer = new Float64Array(size);

  const excitation = new Float64Array(n);
  const pluck = pluckExcitation(f0, sampleRate, velocity, position, bright, noiseAmount, rand, harmonic);
  for (let i = 0; i < pluck.length && i < n; i++) excitation[i] += pluck[i] * velocity;

  const loopGain = 10 ** (-3 / (t60Base * f0));
  const out = new Float64Array(n);
  let write = 0;
  let loss = 0;
  let apX = 0;
  let apY = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.max(4, sampleRate / midiToHz(pitch[i]) - compensation);
    const read = write - d;
    const integer = Math.floor(read);
    const frac = read - integer;
    const x0 = buffer[(integer - 1) & mask];
    const x1 = buffer[integer & mask];
    const x2 = buffer[(integer + 1) & mask];
    const x3 = buffer[(integer + 2) & mask];
    const c0 = (-frac * (frac - 1) * (frac - 2)) / 6;
    const c1 = ((frac + 1) * (frac - 1) * (frac - 2)) / 2;
    const c2 = (-(frac + 1) * frac * (frac - 2)) / 2;
    const c3 = ((frac + 1) * frac * (frac - 1)) / 6;
    const delayed = c0 * x0 + c1 * x1 + c2 * x2 + c3 * x3;
    loss = (1 - damp) * delayed + damp * loss;
    let value = loopGain * loss;
    if (nap) {
      const y = ap * value + apX - ap * apY;
      apX = value;
      apY = y;
      value = y;
    }
    const sample = excitation[i] + value;
    buffer[write & mask] = sample;
    out[i] = sample;
    write += 1;
  }

  let voiced = out;
  if (harmonic) voiced = onePoleHighpass(voiced, f0 * 0.7, sampleRate);
  voiced = bodyResonance(voiced, preset.body, preset.bodyMix, sampleRate);

  if (bend || vib || glide) {
    const slide = new Float64Array(n);
    const gradient = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const prev = pitch[Math.max(0, i - 1)];
      const next = pitch[Math.min(n - 1, i + 1)];
      gradient[i] = Math.min(Math.abs(next - prev) * sampleRate, 8) / 8;
    }
    const smoothed = onePoleLowpass(gradient, 40, sampleRate);
    const raw = new Float64Array(n);
    for (let i = 0; i < n; i++) raw[i] = gaussian(rand);
    const hiss = onePoleHighpass(onePoleLowpass(raw, 4500, sampleRate), 900, sampleRate);
    for (let i = 0; i < n; i++) {
      slide[i] = preset.slideNoise * 0.04 * velocity * hiss[i] * smoothed[i] * Math.exp(-i / (sampleRate * t60Base * 0.6));
    }
    for (let i = 0; i < n; i++) voiced[i] += slide[i];
  }

  if (duration > 0) {
    const releaseStart = Math.floor(duration * sampleRate);
    if (releaseStart < n) {
      for (let i = releaseStart; i < n; i++) {
        const t = (i - releaseStart) / sampleRate;
        voiced[i] *= Math.exp((-6.9 * t) / Math.max(tail, 0.01));
      }
      const end = Math.min(n, releaseStart + Math.ceil(tail * sampleRate));
      const trimmed = new Float64Array(end);
      trimmed.set(voiced.subarray(0, end));
      voiced = trimmed;
    }
  }

  // Level: normalize on the loudest 100 ms window, then velocity; cap peak.
  const window = Math.min(voiced.length, Math.ceil(0.1 * sampleRate));
  let rmsPeak = 0;
  if (voiced.length > window) {
    let sum = 0;
    for (let i = 0; i < window; i++) sum += voiced[i] * voiced[i];
    rmsPeak = Math.sqrt(sum / window);
    for (let i = window; i < Math.min(voiced.length, Math.ceil(1.5 * sampleRate)); i++) {
      const leaving = voiced[i - window];
      sum += voiced[i] * voiced[i] - leaving * leaving;
      rmsPeak = Math.max(rmsPeak, Math.sqrt(Math.max(sum, 0) / window));
    }
  } else {
    let peak = 0;
    for (let i = 0; i < voiced.length; i++) peak = Math.max(peak, Math.abs(voiced[i]));
    rmsPeak = peak;
  }
  const scale = rmsPeak > 1e-9 ? (0.1 / rmsPeak) * (velocity / 0.8) ** 1.2 : 0;
  let peak = 0;
  for (let i = 0; i < voiced.length; i++) {
    voiced[i] *= scale;
    peak = Math.max(peak, Math.abs(voiced[i]));
  }
  if (peak > 0.9) for (let i = 0; i < voiced.length; i++) voiced[i] *= 0.9 / peak;
  return voiced;
}

/* -------------------------------------------------------------------------- */
/* Synthetic xiao-like breath flute                                           */
/* -------------------------------------------------------------------------- */

function synthXiao({ sampleRate, midi, duration, velocity, attack, release, rand }) {
  const f0 = midiToHz(midi);
  const releaseTime = release ?? 0.6;
  const n = Math.max(32, Math.ceil((duration + releaseTime + 0.1) * sampleRate));
  const out = new Float64Array(n);
  const breathLp = { value: 0 };
  const breathHp = { value: 0 };
  const toneLp = { value: 0 };
  const toneLp2 = { value: 0 };
  let phase = 0;
  let phase2 = 0;
  const vibRate = 4.8;
  const vibDepth = 0.11;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const vibRamp = clamp((t - 0.35) / 0.55, 0, 1);
    const vibrato = vibDepth * vibRamp * Math.sin(TAU * vibRate * Math.max(t - 0.35, 0));
    const frequency = f0 * 2 ** (vibrato / 12);
    phase += (TAU * frequency) / sampleRate;
    if (phase > TAU) phase -= TAU;
    phase2 += (TAU * frequency * 1.003) / sampleRate;
    if (phase2 > TAU) phase2 -= TAU;
    const tone =
      Math.sin(phase) +
      0.34 * Math.sin(2 * phase) +
      0.17 * Math.sin(3 * phase) +
      0.075 * Math.sin(4 * phase) +
      0.14 * Math.sin(phase2);
    const white = rand() * 2 - 1;
    breathLp.value += 0.42 * (white - breathLp.value);
    const high = white - breathLp.value;
    breathHp.value += 0.06 * (high - breathHp.value);
    const breath = high - breathHp.value;
    const attackTime = attack ?? 0.6;
    const attackGain = Math.min(1, (t / Math.max(attackTime, 0.02)) ** 1.15);
    const after = Math.max(0, t - duration);
    const releaseGain = after > 0 ? Math.exp((-6.9 * after) / Math.max(releaseTime, 0.01)) : 1;
    const envelope = attackGain * releaseGain;
    const chiff = 0.5 * Math.exp(-t / 0.055);
    const value = tone * envelope + breath * envelope * 0.38 + white * chiff * 0.1;
    toneLp.value += 0.24 * (value - toneLp.value);
    toneLp2.value += 0.24 * (toneLp.value - toneLp2.value);
    out[i] = toneLp2.value;
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  const scale = peak > 1e-9 ? (0.9 * (velocity / 0.8) ** 1.2) / peak : 0;
  for (let i = 0; i < n; i++) out[i] *= scale;
  return out;
}

/* -------------------------------------------------------------------------- */
/* Procedural drums                                                           */
/* -------------------------------------------------------------------------- */

function synthDrum({ kind, sampleRate, velocity, duration, rand }) {
  if (kind === 'granCassa') {
    const n = Math.max(64, Math.ceil((duration ?? 1.4) * sampleRate));
    const out = new Float64Array(n);
    let phase = 0;
    let noiseLp = 0;
    let noiseHp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      const frequency = 34 + 30 * Math.exp(-t / 0.16);
      phase += (TAU * frequency) / sampleRate;
      const body = Math.sin(phase) * Math.exp(-t / 0.32);
      const sub = Math.sin(phase * 0.5) * Math.exp(-t / 0.5) * 0.35;
      const white = rand() * 2 - 1;
      noiseLp += 0.2 * (white - noiseLp);
      noiseHp += 0.02 * (noiseLp - noiseHp);
      const noise = (noiseLp - noiseHp) * Math.exp(-t / 0.035) * 1.5;
      const raw = body + sub + noise;
      out[i] = Math.tanh(1.8 * raw * velocity);
    }
    return normalizePeak(out, 0.8 * velocity ** 1.1);
  }
  if (kind === 'timpani') {
    const n = Math.max(64, Math.ceil((duration ?? 1.4) * sampleRate));
    const out = new Float64Array(n);
    const f0 = 82;
    const partials = [
      [1, 1, 1.15],
      [1.5, 0.6, 0.72],
      [2.1, 0.34, 0.5],
      [2.7, 0.18, 0.36],
    ];
    const phases = partials.map(() => 0);
    let noiseLp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      const pitch = f0 * (1 - 0.015 * Math.min(1, t / 0.08));
      let value = 0;
      for (let p = 0; p < partials.length; p++) {
        const [ratio, amp, decay] = partials[p];
        phases[p] += (TAU * pitch * ratio) / sampleRate;
        value += amp * Math.sin(phases[p]) * Math.exp(-t / decay);
      }
      const white = rand() * 2 - 1;
      noiseLp += 0.35 * (white - noiseLp);
      value += noiseLp * Math.exp(-t / 0.02) * 0.7;
      out[i] = Math.tanh(1.15 * value * velocity);
    }
    return normalizePeak(out, 0.8 * velocity ** 1.1);
  }
  if (kind === 'frameDrum') {
    const n = Math.max(64, Math.ceil((duration ?? 0.22) * sampleRate));
    const out = new Float64Array(n);
    const partials = [
      [185, 1, 0.055],
      [310, 0.55, 0.04],
      [470, 0.25, 0.03],
    ];
    const phases = partials.map(() => 0);
    let noiseLp = 0;
    let noiseHp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      let value = 0;
      for (let p = 0; p < partials.length; p++) {
        const [frequency, amp, decay] = partials[p];
        phases[p] += (TAU * frequency) / sampleRate;
        value += amp * Math.sin(phases[p]) * Math.exp(-t / decay);
      }
      const white = rand() * 2 - 1;
      noiseLp += 0.5 * (white - noiseLp);
      noiseHp += 0.03 * (noiseLp - noiseHp);
      value += (noiseLp - noiseHp) * Math.exp(-t / 0.006) * 1.4;
      out[i] = Math.tanh(1.4 * value * velocity);
    }
    return normalizePeak(out, 0.8 * velocity ** 1.1);
  }
  if (kind === 'gong') {
    const n = Math.max(64, Math.ceil((duration ?? 2.4) * sampleRate));
    const out = new Float64Array(n);
    const f0 = 168;
    const partials = [
      [1, 0.7, 2.2],
      [1.48, 0.5, 1.8],
      [2.09, 0.4, 1.5],
      [2.83, 0.3, 1.2],
      [3.91, 0.2, 1.0],
      [5.2, 0.12, 0.8],
    ];
    const phases = partials.map(() => 0);
    let noiseLp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      let value = 0;
      for (let p = 0; p < partials.length; p++) {
        const [ratio, amp, decay] = partials[p];
        phases[p] += (TAU * f0 * ratio) / sampleRate;
        value += amp * Math.sin(phases[p]) * Math.exp(-t / decay);
      }
      const white = rand() * 2 - 1;
      noiseLp += 0.3 * (white - noiseLp);
      value += noiseLp * Math.exp(-t / 0.03) * 0.5;
      out[i] = Math.tanh(0.8 * value * velocity);
    }
    return normalizePeak(out, 0.8 * velocity ** 1.1);
  }
  throw new Error(`plucked-breath: unknown drum "${kind}"`);
}

function normalizePeak(signal, peak) {
  let current = 0;
  for (let i = 0; i < signal.length; i++) current = Math.max(current, Math.abs(signal[i]));
  if (current > 1e-9) {
    const scale = peak / current;
    for (let i = 0; i < signal.length; i++) signal[i] *= scale;
  }
  return signal;
}

/* -------------------------------------------------------------------------- */
/* Small deterministic room                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Four damped combs and two allpasses per channel, with a small right-channel
 * offset. Causal: no wet sample exists before its input.
 */
function room(input, sampleRate, size, wet, spread) {
  const n = input.length;
  const scale = (sampleRate / 44100) * size;
  const combLengths = [1116, 1188, 1277, 1356].map((d) => Math.max(2, Math.round(d * scale) + spread));
  const allpassLengths = [225, 556].map((d) => Math.max(2, Math.round(d * scale) + spread));
  const combs = combLengths.map((length) => ({
    length,
    buffer: new Float64Array(length),
    index: 0,
    damped: 0,
  }));
  const allpasses = allpassLengths.map((length) => ({
    length,
    buffer: new Float64Array(length),
    index: 0,
  }));
  const wetSignal = new Float64Array(n);
  const feedback = 0.78;
  const damping = 0.3;
  for (let i = 0; i < n; i++) {
    const x = input[i];
    let sum = 0;
    for (const comb of combs) {
      const delayed = comb.buffer[comb.index];
      comb.damped = delayed * (1 - damping) + comb.damped * damping;
      comb.buffer[comb.index] = x + comb.damped * feedback;
      comb.index = (comb.index + 1) % comb.length;
      sum += delayed;
    }
    wetSignal[i] = sum / combs.length;
  }
  for (const allpass of allpasses) {
    const g = 0.5;
    for (let i = 0; i < n; i++) {
      const staged = allpass.buffer[allpass.index];
      const y = -g * wetSignal[i] + staged;
      allpass.buffer[allpass.index] = wetSignal[i] + g * y;
      allpass.index = (allpass.index + 1) % allpass.length;
      wetSignal[i] = y;
    }
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = input[i] * (1 - wet) + wetSignal[i] * wet * 2;
  return out;
}

function roomStereo(stereo, sampleRate, size, wet) {
  return [room(stereo[0], sampleRate, size, wet, 0), room(stereo[1], sampleRate, size, wet, 23)];
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

const BUS_ROOM = {
  guqin: { size: 0.5, wet: 0.2 },
  xiao: { size: 0.62, wet: 0.3 },
  drums: { size: 0.55, wet: 0.16 },
  pad: { size: 0.5, wet: 0.15 },
};

function busForVoice(voice) {
  if (voice === 'guqin' || voice === 'guqinHarmonic') return 'guqin';
  if (voice === 'xiao') return 'xiao';
  if (voice === 'gong') return 'pad';
  return 'drums';
}

function makeStereo(n) {
  return [new Float64Array(n), new Float64Array(n)];
}

function stereoAdd(stereo, mono, offset, gain, pan, sampleRate) {
  const angle = ((clamp(pan, -1, 1) + 1) * Math.PI) / 4;
  const left = Math.cos(angle) * gain;
  const right = Math.sin(angle) * gain;
  const start = Math.max(0, Math.round(offset * sampleRate));
  const count = Math.min(mono.length, stereo[0].length - start);
  for (let i = 0; i < count; i++) {
    stereo[0][start + i] += mono[i] * left;
    stereo[1][start + i] += mono[i] * right;
  }
}

/**
 * Render the score. `frames` is a SAMPLE count per channel. Nothing is padded,
 * resampled or clamped; the only level operation is a final safety trim to the
 * documented peak if an extreme gain would otherwise exceed full scale.
 */
export function renderScore({ sampleRate, channels, frames, params = {}, seed = 7 } = {}) {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000)
    throw new Error('plucked-breath: sampleRate must be between 8000 and 192000');
  if (!Number.isInteger(channels) || (channels !== 1 && channels !== 2))
    throw new Error('plucked-breath: channels must be 1 or 2');
  if (!Number.isInteger(frames) || frames <= 0)
    throw new Error('plucked-breath: frames must be a positive integer sample count');
  if (seed !== undefined && !Number.isInteger(seed)) throw new Error('plucked-breath: seed must be an integer');

  const score = buildScore(params);
  const rand = makeRandom(seed ?? 7);
  const cutSample = Math.round(score.cut.time * sampleRate);
  const gapEndSample = Math.round(score.cut.gapEnd * sampleRate);

  const pre = {
    guqin: makeStereo(frames),
    xiao: makeStereo(frames),
    drums: makeStereo(frames),
    pad: makeStereo(frames),
  };
  const post = {
    guqin: makeStereo(frames),
    xiao: makeStereo(frames),
    drums: makeStereo(frames),
    pad: makeStereo(frames),
  };

  for (const event of score.events) {
    if (event.time >= frames / sampleRate) continue;
    const target = event.time < score.cut.time ? pre : post;
    const bus = busForVoice(event.voice);
    // The synthesis buffer never exceeds the span it can actually reach: the
    // cut for pre events, the requested sample span for post events.
    const spanEnd = Math.min(
      frames / sampleRate,
      event.time < score.cut.time ? score.cut.time : frames / sampleRate,
    );
    const secondsLeft = Math.max(0, spanEnd - event.time);
    let mono;
    switch (event.voice) {
      case 'guqin':
        mono = synthString({
          sampleRate,
          midi: event.midi,
          duration: event.duration,
          velocity: event.vel ?? 0.7,
          harmonic: false,
          bend: event.bend,
          vib: event.vib,
          glide: event.glide,
          rand,
          secondsLeft,
        });
        break;
      case 'guqinHarmonic':
        mono = synthString({
          sampleRate,
          midi: event.midi,
          duration: event.duration,
          velocity: event.vel ?? 0.55,
          harmonic: true,
          bend: event.bend,
          vib: event.vib,
          glide: event.glide,
          rand,
          secondsLeft,
        });
        break;
      case 'xiao':
        mono = synthXiao({
          sampleRate,
          midi: event.midi,
          duration: event.duration,
          velocity: event.vel ?? 0.55,
          attack: event.attack,
          release: event.release,
          rand,
        });
        break;
      case 'granCassa':
      case 'timpani':
      case 'frameDrum':
      case 'gong':
        mono = synthDrum({
          kind: event.voice,
          sampleRate,
          velocity: event.vel ?? 0.8,
          duration: event.decay ?? event.duration,
          rand,
        });
        break;
      default:
        throw new Error(`plucked-breath: unknown voice "${event.voice}"`);
    }
    stereoAdd(target[bus], mono, event.time, event.gain, event.pan, sampleRate);
  }

  // Reverb is applied per bus BEFORE the cut, so the hard cut removes the wet
  // tail as well as the dry signal. Post-gap events have their own room.
  const preMixed = makeStereo(frames);
  const postMixed = makeStereo(frames);
  for (const bus of Object.keys(pre)) {
    const preRoom = roomStereo(pre[bus], sampleRate, BUS_ROOM[bus].size, BUS_ROOM[bus].wet);
    const postRoom = roomStereo(post[bus], sampleRate, BUS_ROOM[bus].size, BUS_ROOM[bus].wet);
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < frames; i++) {
        preMixed[c][i] += preRoom[c][i];
        postMixed[c][i] += postRoom[c][i];
      }
    }
  }

  // Hard cut: a 20 ms authored fade into an exact zero. Everything after the
  // cut, including every reverb tail, is removed.
  const fade = Math.max(1, Math.round(0.02 * sampleRate));
  for (let c = 0; c < 2; c++) {
    const begin = Math.max(0, cutSample - fade);
    for (let i = begin; i < cutSample && i < frames; i++) {
      const gain = (cutSample - i) / (cutSample - begin);
      preMixed[c][i] *= gain;
    }
    for (let i = cutSample; i < frames; i++) preMixed[c][i] = 0;
  }

  // Mix and gate the true gap to digital zero (scope "all").
  const mix = makeStereo(frames);
  for (let c = 0; c < 2; c++)
    for (let i = 0; i < frames; i++) mix[c][i] = preMixed[c][i] + postMixed[c][i];

  // 20 Hz DC blocker. It is a stateful filter, so it runs before the gap gate:
  // otherwise its decaying state would leak a small tail into the authored rest.
  for (let c = 0; c < 2; c++) {
    let state = 0;
    const a = 1 - Math.exp((-TAU * 20) / sampleRate);
    for (let i = 0; i < frames; i++) {
      state += a * (mix[c][i] - state);
      mix[c][i] -= state;
    }
  }

  // The true quiet gap is exact digital zero, in both channels.
  for (let c = 0; c < 2; c++)
    for (let i = cutSample; i < Math.min(gapEndSample, frames); i++) mix[c][i] = 0;

  // Authored settle: the last 0.3 s fades to zero so the 32 s edge is clean.
  const settle = Math.min(frames, Math.round(0.3 * sampleRate));
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < settle; i++) {
      const index = frames - settle + i;
      mix[c][index] *= 0.5 + 0.5 * Math.cos((Math.PI * (i + 1)) / settle);
    }
  }

  // Author gain, then one safety trim if an extreme value exceeds the ceiling.
  const gain = score.gain;
  let peak = 0;
  for (let c = 0; c < 2; c++)
    for (let i = 0; i < frames; i++) {
      mix[c][i] *= gain;
      peak = Math.max(peak, Math.abs(mix[c][i]));
    }
  const ceiling = 0.94;
  if (peak > ceiling) for (let c = 0; c < 2; c++) for (let i = 0; i < frames; i++) mix[c][i] *= ceiling / peak;

  let out;
  if (channels === 2) {
    out = [new Float32Array(frames), new Float32Array(frames)];
    for (let i = 0; i < frames; i++) {
      out[0][i] = mix[0][i];
      out[1][i] = mix[1][i];
    }
  } else {
    out = [new Float32Array(frames)];
    for (let i = 0; i < frames; i++) out[0][i] = (mix[0][i] + mix[1][i]) * 0.5;
  }
  return { channels: out };
}

/* -------------------------------------------------------------------------- */
/* Measured report (not an acceptance)                                        */
/* -------------------------------------------------------------------------- */

/** Measure a rendered result. Facts only; no claim that the music is good. */
export function scoreReport(channels, sampleRate, score) {
  const length = channels[0]?.length ?? 0;
  let peak = 0;
  let energy = 0;
  for (const channel of channels)
    for (let i = 0; i < channel.length; i++) {
      peak = Math.max(peak, Math.abs(channel[i]));
      energy += channel[i] * channel[i];
    }
  const rms = Math.sqrt(energy / Math.max(1, length * channels.length));
  const rmsBetween = (start, end) => {
    const a = Math.max(0, Math.round(start * sampleRate));
    const b = Math.min(length, Math.round(end * sampleRate));
    if (b <= a) return 0;
    let sum = 0;
    for (const channel of channels) for (let i = a; i < b; i++) sum += channel[i] * channel[i];
    return Math.sqrt(sum / ((b - a) * channels.length));
  };
  const maxBetween = (start, end) => {
    const a = Math.max(0, Math.round(start * sampleRate));
    const b = Math.min(length, Math.round(end * sampleRate));
    let value = 0;
    for (const channel of channels) for (let i = a; i < b; i++) value = Math.max(value, Math.abs(channel[i]));
    return value;
  };
  const cadence = score.sections.find((section) => section.id === 'cadence');
  return {
    seconds: length / sampleRate,
    frames: length,
    channels: channels.length,
    sampleRate,
    peak,
    rms,
    peakDbfs: 20 * Math.log10(Math.max(peak, 1e-12)),
    sectionRms: Object.fromEntries(score.sections.map((section) => [section.id, rmsBetween(section.start, section.end)])),
    rests: score.rests.map((rest) => ({ ...rest, maxAbs: maxBetween(rest.start, rest.end) })),
    cues: score.cues,
    cadenceRms: cadence ? rmsBetween(cadence.start, cadence.end) : 0,
  };
}
