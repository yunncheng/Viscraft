/**
 * cartoon-jazz — a complete 32-second cartoon cue, written as data.
 *
 * The score is a single 4/4 passage at 120 BPM (16 bars, 32 s, 768 frames at
 * 24 fps) in F major. It states one syncopated theme and then keeps that theme
 * recognisable while the picture changes pace:
 *
 *   theme     bars 1–4     the syncopated F theme, full stride band
 *   inspect   bars 5–6     the same motif augmented ×2, thin comic inspection
 *   chase     bars 7–9     the theme compressed to sixteenths, new orchestration
 *   bandstop  bar 10       the band stops; only tick / spring (or wood / whistle)
 *   answer    bars 11–12   call-and-response restart on the theme
 *   slow      bars 13–15   augmented resolution, half-time harmony
 *   cadence   bar 16       final F chord, tag and ring-out
 *
 * Nothing here is a recording: `synth.mjs` generates every voice. There are no
 * sample files to fetch, so the score is complete offline and the reference can
 * be adopted without a sample licence.
 *
 * Adapted from lemo-opuscar `styles/rubber-hose/demo/music/score.py` (the
 * syncopated theme, stride/oompah accompaniment, slide-whistle and boing
 * gestures, stop-time gates and the F-major harmonic plan) and
 * `core/audio/pluck.py` (Karplus-Strong), commit
 * e3cb16f63768c68693ff0e15171d6e755457cc32, LemoLab, MIT. The arrangement is
 * re-authored as data for the current Viscraft sound contract; see LICENSES.md.
 */

import {
  addToBus,
  pitchToMidi,
  room,
  synthesise,
} from './synth.mjs';

export const BPM = 120;
export const BEAT_SECONDS = 60 / BPM;
export const BAR_SECONDS = 4 * BEAT_SECONDS;
export const DURATION_SECONDS = 32;
export const TOTAL_BARS = 16;
export const SOURCE_FPS = 24;
export const SOURCE_FRAMES = DURATION_SECONDS * SOURCE_FPS;
export const PEAK_CEILING = 0.98;

export const DEFAULT_PARAMS = Object.freeze({
  variant: 'base',
  transpose: 0,
  gain: 1,
});

/**
 * The syncopated theme (F major, 4 bars = 16 beats), as [offset, duration,
 * pitch] in beats from bar 1 beat 1. The off-beat entries (2.5, 3.5, 5.5, 6.5,
 * 10.5, 11.5, 13.5) are the identity of the tune, not decoration.
 */
export const THEME = Object.freeze([
  [0, 0.5, 'A4'], [0.5, 0.5, 'C5'], [1, 0.5, 'F5'], [1.5, 1, 'E5'],
  [2.5, 0.5, 'F5'], [3, 0.5, 'A5'], [3.5, 0.5, 'G5'],
  [4, 0.5, 'F#5'], [4.5, 1, 'A5'], [5.5, 0.5, 'F#5'], [6, 0.5, 'D5'],
  [6.5, 0.5, 'C5'], [7, 1, 'A4'],
  [8, 0.5, 'B4'], [8.5, 0.5, 'D5'], [9, 0.5, 'G5'], [9.5, 1, 'F5'],
  [10.5, 0.5, 'E5'], [11, 0.5, 'G5'], [11.5, 0.5, 'Bb4'],
  [12, 1.5, 'A4'], [13.5, 0.5, 'C5'], [14, 1, 'F5'],
]);

export const THEME_CHORDS = Object.freeze([
  ['F', 'F'],
  ['D7', 'D7'],
  ['G7', 'C7'],
  ['F', 'F'],
]);

const CHORDS = Object.freeze({
  F: { root: 'F2', fifth: 'C2', triad: ['A3', 'C4', 'F4'] },
  D7: { root: 'D2', fifth: 'A1', triad: ['F#3', 'C4', 'D4'] },
  G7: { root: 'G2', fifth: 'D2', triad: ['F3', 'B3', 'D4'] },
  C7: { root: 'C2', fifth: 'G1', triad: ['E3', 'Bb3', 'C4'] },
  Bb: { root: 'Bb1', fifth: 'F2', triad: ['F3', 'Bb3', 'D4'] },
  Dm: { root: 'D2', fifth: 'A1', triad: ['F3', 'A3', 'D4'] },
  Gm: { root: 'G2', fifth: 'D2', triad: ['Bb3', 'D4', 'G4'] },
  G: { root: 'G2', fifth: 'D2', triad: ['B3', 'D4', 'G4'] },
  C: { root: 'C2', fifth: 'G1', triad: ['E3', 'G3', 'C4'] },
  A7: { root: 'A1', fifth: 'E2', triad: ['G3', 'C#4', 'E4'] },
});

/** Sections are half-open in seconds. A rest is a separate statement. */
const SECTION_PLAN = [
  ['theme', 0, 8],
  ['inspect', 8, 12],
  ['chase', 12, 18],
  ['bandstop', 18, 20],
  ['answer', 20, 24],
  ['slow', 24, 30],
  ['cadence', 30, 32],
];

/** The authored band stop. Music tails are gated AFTER the room; foley is dry. */
export const RESTS = Object.freeze([{ start: 18.02, end: 19.96, scope: 'music' }]);

function normalizeParams(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const known = new Set(Object.keys(DEFAULT_PARAMS));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) {
      throw new Error(
        `cartoon-jazz: unknown parameter "${key}"; this score takes ${[...known].join(', ')}`,
      );
    }
  }
  const params = { ...DEFAULT_PARAMS, ...input };
  if (!['base', 'alternate'].includes(params.variant)) {
    throw new Error('cartoon-jazz: variant must be "base" or "alternate"');
  }
  if (!Number.isInteger(params.transpose) || Math.abs(params.transpose) > 24) {
    throw new Error('cartoon-jazz: transpose must be an integer between -24 and 24');
  }
  if (!Number.isFinite(params.gain) || params.gain < 0 || params.gain > 2) {
    throw new Error('cartoon-jazz: gain must be a finite number between 0 and 2');
  }
  return params;
}

/**
 * Authored gains below are relative balances; this is the single internal level
 * that places the whole cue at a healthy source peak without clipping. It is
 * applied once, here, so the exported event gains stay the real applied values.
 */
const MIX_LEVEL = 2.2;

const barBeat = bar => (bar - 1) * 4;
const timeOfBeat = beat => beat * BEAT_SECONDS;
const timeOf = (bar, beat = 1) => timeOfBeat(barBeat(bar) + (beat - 1));

/**
 * Slice the theme in beats, optionally stretched (augmentation > 1, diminution
 * < 1) and shifted. The pitch sequence is preserved; only its rhythm changes.
 */
function themeSlice(lo, hi, { stretch = 1, offset = 0 } = {}) {
  return THEME.filter(([at]) => at >= lo && at < hi).map(([at, duration, pitch]) => [
    (at - lo) * stretch + offset,
    duration * stretch,
    pitch,
  ]);
}

function makeWriter(section, notes, params) {
  return function push(event) {
    const { time, duration, voice, midi, midiTo, gain = 0.05, pan = 0, role = 'music' } = event;
    // Transpose is a musical parameter: physical foley (a tick, a spring, a
    // woodblock, a slide whistle) keeps its own pitch whatever key the theme is
    // in. Only music events follow the key.
    const shift = role === 'foley' ? 0 : params.transpose;
    const shifted = midi === undefined ? undefined : midi + shift;
    const shiftedTo = midiTo === undefined ? undefined : midiTo + shift;
    if (shifted !== undefined && (shifted < 0 || shifted > 127)) {
      throw new Error(`cartoon-jazz: transpose ${params.transpose} pushes ${voice} outside MIDI 0..127`);
    }
    if (shiftedTo !== undefined && (shiftedTo < 0 || shiftedTo > 127)) {
      throw new Error(`cartoon-jazz: transpose ${params.transpose} pushes ${voice} outside MIDI 0..127`);
    }
    notes.push({
      section,
      time: Number(time.toFixed(6)),
      duration: Number(duration.toFixed(6)),
      voice,
      ...(shifted === undefined ? {} : { midi: shifted }),
      ...(shiftedTo === undefined ? {} : { midiTo: shiftedTo }),
      gain: Number((gain * MIX_LEVEL).toFixed(6)),
      pan: Number(pan.toFixed(6)),
      role,
    });
  };
}

/** Stride piano: root/fifth octaves on 1 and 3, short chord on 2 and 4. */
function stride(push, bar, chords, { gain = 1, pan = -0.15 } = {}) {
  for (let beat = 1; beat <= 4; beat++) {
    const chord = CHORDS[chords[beat <= 2 ? 0 : 1]];
    const time = timeOf(bar, beat);
    if (beat === 1 || beat === 3) {
      const pitch = beat === 1 ? chord.root : chord.fifth;
      const midi = pitchToMidi(pitch);
      push({ time, duration: 0.4, voice: 'piano', midi, gain: 0.052 * gain, pan });
      push({ time, duration: 0.4, voice: 'piano', midi: midi + 12, gain: 0.042 * gain, pan });
    } else {
      chord.triad.forEach((pitch, index) => {
        push({
          time: time + index * 0.004,
          duration: 0.16,
          voice: 'piano',
          midi: pitchToMidi(pitch),
          gain: 0.03 * gain,
          pan: pan + 0.2,
        });
      });
    }
  }
}

/** Oompah: tuba on 1 and 3, banjo strum on 2 and 4. */
function oompah(push, bar, chords, { gain = 1, twoBeat = false } = {}) {
  for (const beat of [1, 3]) {
    if (twoBeat && beat === 3) continue;
    const chord = CHORDS[chords[beat === 1 ? 0 : 1]];
    let pitch = beat === 1 ? chord.root : chord.fifth;
    let midi = pitchToMidi(pitch);
    if (midi < 36) midi += 12;
    push({ time: timeOf(bar, beat), duration: 0.34, voice: 'tuba', midi, gain: 0.072 * gain, pan: -0.08 });
  }
  for (const beat of [2, 4]) {
    if (twoBeat && beat === 2) continue;
    const chord = CHORDS[chords[beat === 2 ? 0 : 1]];
    const pitches = [
      pitchToMidi(chord.triad[0]) + 12,
      pitchToMidi(chord.triad[1]) + 12,
      pitchToMidi(chord.triad[2]) + 12,
      pitchToMidi(chord.triad[0]) + 24,
    ];
    pitches.forEach((midi, index) => {
      push({
        time: timeOf(bar, beat) - 0.012 + index * 0.014,
        duration: 0.2,
        voice: 'banjo',
        midi,
        gain: 0.023 * gain,
        pan: 0.38,
      });
    });
  }
}

function brushes(push, bar, { gain = 1 } = {}) {
  for (let beat = 1; beat <= 4; beat++) {
    push({ time: timeOf(bar, beat), duration: 0.38, voice: 'brush', gain: 0.028 * gain, pan: 0.05 });
  }
}

function backbeat(push, bar, { gain = 1 } = {}) {
  for (const beat of [2, 4]) {
    push({ time: timeOf(bar, beat), duration: 0.16, voice: 'snare', gain: 0.034 * gain, pan: 0 });
  }
  for (const beat of [1, 3]) {
    push({ time: timeOf(bar, beat), duration: 0.22, voice: 'bassDrum', gain: 0.065 * gain, pan: 0 });
  }
}

function cymbal(push, time, { duration = 0.8, gain = 0.05, pan = 0.1 } = {}) {
  push({ time, duration, voice: 'cymbal', gain, pan });
}

function melody(push, startBeat, notes, { voice, gain, pan, legato = 0.96, shift = 0 }) {
  for (const [offset, duration, pitch] of notes) {
    push({
      time: timeOfBeat(startBeat + offset),
      duration: duration * BEAT_SECONDS * legato,
      voice,
      midi: pitchToMidi(pitch) + shift,
      gain,
      pan,
    });
  }
}

function chordBlock(push, time, pitches, { voice, gain, duration, pan = 0, spread = 0.008 }) {
  pitches.forEach((pitch, index) => {
    push({
      time: time + index * spread,
      duration,
      voice,
      midi: pitchToMidi(pitch),
      gain,
      pan,
    });
  });
}

function buildTheme(push, params) {
  const base = params.variant === 'base';
  melody(push, 0, themeSlice(0, 16), {
    voice: base ? 'trumpet' : 'clarinet',
    gain: base ? 0.085 : 0.062,
    pan: base ? 0.2 : -0.2,
  });
  if (base) {
    // Brass lead with a reed an octave above and trombone weight below.
    melody(push, 0, themeSlice(0, 8), {
      voice: 'clarinet',
      gain: 0.04,
      pan: -0.25,
      shift: 12,
    });
    melody(push, 0, themeSlice(0, 8), { voice: 'trombone', gain: 0.034, pan: -0.05, shift: -12 });
  } else {
    // Reed lead, muted brass shadow below and a banjo doubling: a different band.
    melody(push, 0, themeSlice(4, 16), { voice: 'trumpetMuted', gain: 0.033, pan: 0.22, shift: -12 });
    melody(push, 0, themeSlice(0, 8), { voice: 'banjo', gain: 0.024, pan: 0.3, legato: 0.9 });
  }
  THEME_CHORDS.forEach((chords, index) => {
    const bar = index + 1;
    stride(push, bar, chords);
    oompah(push, bar, chords);
    brushes(push, bar);
    backbeat(push, bar);
  });
  cymbal(push, timeOf(1), { gain: 0.045 });
  // A slide-whistle pickup into the inspection; a gesture, not a melody note.
  push({
    time: timeOf(4, 4),
    duration: 0.45,
    voice: 'slideWhistle',
    midi: 72,
    midiTo: 84,
    gain: 0.055,
    pan: 0.2,
  });
}

function buildInspect(push, params) {
  const base = params.variant === 'base';
  // The same opening motif, augmented ×2: the tune is slower, not a new tune.
  melody(push, 16, themeSlice(0, 4, { stretch: 2 }), {
    voice: base ? 'clarinet' : 'trumpetMuted',
    gain: base ? 0.06 : 0.05,
    pan: -0.12,
    legato: 0.99,
  });
  melody(push, 16, themeSlice(0, 4, { stretch: 2 }), {
    voice: base ? 'trombone' : 'clarinet',
    gain: 0.03,
    pan: -0.05,
    legato: 0.99,
    shift: -12,
  });
  const chords = [
    ['F', 'F'],
    ['Dm', 'Dm'],
  ];
  chords.forEach((pair, index) => {
    const bar = index + 5;
    const root = pitchToMidi(pair[0] === 'F' ? 'F2' : 'D2');
    push({ time: timeOf(bar, 1), duration: 0.9, voice: 'tuba', midi: root, gain: 0.075, pan: -0.08 });
    push({ time: timeOf(bar, 3), duration: 0.9, voice: 'tuba', midi: root + 7, gain: 0.065, pan: -0.08 });
    stride(push, bar, pair, { gain: 0.55 });
  });
  // Woodblock glances: comic punctuation, quiet and off the beat.
  [17.5, 18.5, 21.5, 22.5].forEach((beat, index) => {
    push({
      time: timeOfBeat(beat),
      duration: 0.11,
      voice: 'woodblock',
      midi: index % 2 === 0 ? 84 : 72,
      gain: 0.075,
      pan: index % 2 === 0 ? -0.35 : 0.35,
    });
  });
  if (base) {
    // The classic filtered mute-wah: three held notes through a moving low-pass.
    // The long third note lets the mute close again (see synth.mjs trumpetMuted).
    [
      ['Bb4', 0.45, 21.0],
      ['A4', 0.45, 21.5],
      ['Ab4', 0.9, 22.0],
    ].forEach(([pitch, duration, time]) => {
      push({ time, duration, voice: 'trumpetMuted', midi: pitchToMidi(pitch), gain: 0.032, pan: 0.24 });
    });
  } else {
    push({ time: timeOf(6, 4), duration: 0.32, voice: 'trumpetMuted', midi: pitchToMidi('F4'), gain: 0.028, pan: 0.2 });
  }
}

function buildChase(push, params) {
  const base = params.variant === 'base';
  // Compression, not a new tune: the same theme at half the note values, so the
  // interval density doubles while the pitch order is recognisable.
  melody(push, 24, themeSlice(0, 8, { stretch: 0.5 }), {
    voice: base ? 'clarinet' : 'trumpetMuted',
    gain: base ? 0.05 : 0.042,
    pan: -0.2,
    legato: 0.72,
  });
  melody(push, 28, themeSlice(8, 16, { stretch: 0.5 }), {
    voice: base ? 'clarinet' : 'trumpetMuted',
    gain: base ? 0.05 : 0.042,
    pan: -0.2,
    legato: 0.72,
  });

  // The other half of the chase band: banjo tremolo in the base, a xylophone
  // eighth-note sparkle in the alternate. The harmony stays the same.
  const runChords = [
    [7, 'F', ['F', 'D7']],
    [8, 'D7', ['G7', 'C7']],
    [9, 'G7', ['G7', 'C7']],
  ];
  for (const [bar, chordName, barChords] of runChords) {
    if (base) {
      barChords.forEach((name, index) => {
        const triad = CHORDS[name].triad.map(pitch => pitchToMidi(pitch) + 12);
        for (let step = 0; step < 4; step++) {
          push({
            time: timeOf(bar, 1 + index * 2 + step * 0.5),
            duration: 0.1,
            voice: 'banjo',
            midi: triad[step % triad.length],
            gain: 0.018,
            pan: 0.38,
          });
        }
      });
    } else {
      const triad = CHORDS[chordName].triad.map(pitch => pitchToMidi(pitch) + 12);
      for (let step = 0; step < 8; step++) {
        push({
          time: timeOf(bar, 1 + step * 0.5),
          duration: 0.09,
          voice: 'xylophone',
          midi: triad[step % triad.length],
          gain: 0.024,
          pan: 0.3,
        });
      }
    }
  }

  // Tuba ostinato and off-beat piano stabs under the chase.
  const bassPlan = [
    [7, ['F2', 'F2', 'D2', 'A1']],
    [8, ['G2', 'G2', 'C2', 'C2']],
    [9, ['G2', 'G2', 'C2', 'C2']],
  ];
  for (const [bar, pitches] of bassPlan) {
    pitches.forEach((pitch, index) => {
      let midi = pitchToMidi(pitch);
      if (midi < 36) midi += 12;
      push({ time: timeOf(bar, index + 1), duration: 0.24, voice: 'tuba', midi, gain: 0.095, pan: -0.1 });
    });
    const stabs = bar === 7 ? ['F', 'F', 'D7', 'D7'] : bar === 8 ? ['G7', 'G7', 'C7', 'C7'] : ['G7', 'G7', 'C7', 'C7'];
    for (const [index, beat] of [1.5, 2.5, 3.5, 4.5].entries()) {
      const triad = CHORDS[stabs[index]].triad;
      triad.forEach((pitch, tone) => {
        push({
          time: timeOf(bar, beat) + tone * 0.003,
          duration: 0.1,
          voice: 'piano',
          midi: pitchToMidi(pitch),
          gain: 0.024,
          pan: 0.12,
        });
      });
    }
    for (let step = 0; step < 8; step++) {
      push({
        time: timeOf(bar, 1 + step * 0.5),
        duration: 0.12,
        voice: 'snare',
        gain: 0.022 + step * 0.001,
        pan: -0.05,
      });
    }
    for (const beat of [1, 2, 3, 4]) {
      push({ time: timeOf(bar, beat), duration: 0.2, voice: 'bassDrum', gain: 0.055, pan: 0 });
    }
  }
  // Brass jabs at the downbeats, not a second tune.
  for (const bar of [7, 8, 9]) {
    chordBlock(push, timeOf(bar), ['A4', 'C5', 'F5'], {
      voice: 'trumpet',
      gain: 0.03,
      duration: 0.14,
      pan: 0.2,
      spread: 0.004,
    });
  }
  // Bar 9: a rising sixteenth run and a roll build into the stop.
  const run = ['C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'Bb4', 'B4', 'C5', 'D5', 'E5', 'F5', 'G5', 'A5', 'Bb5', 'C6'];
  run.forEach((pitch, index) => {
    push({
      time: timeOfBeat(32 + index * 0.25),
      duration: 0.11,
      voice: 'clarinet',
      midi: pitchToMidi(pitch),
      gain: 0.04 + index * 0.0012,
      pan: -0.2,
    });
  });
  for (let step = 0; step < 8; step++) {
    push({
      time: timeOfBeat(32 + step * 0.5),
      duration: 0.12,
      voice: 'snare',
      gain: 0.03 + step * 0.004,
      pan: -0.05,
    });
  }
  cymbal(push, timeOf(7), { gain: 0.05 });
  cymbal(push, timeOf(8), { gain: 0.04 });
  push({ time: timeOfBeat(35.7), duration: 0.18, voice: 'cymbal', gain: 0.055, pan: 0.1 });
  push({ time: timeOf(9, 4), duration: 0.24, voice: 'bassDrum', gain: 0.075, pan: 0 });
}

function buildBandstop(push, params) {
  const base = params.variant === 'base';
  // No music events here at all. The stop is physical business, on the dry bus.
  const cues = base
    ? [
        { time: 18.2, voice: 'tick', midi: 84, gain: 0.16 },
        { time: 18.55, voice: 'tick', midi: 88, gain: 0.14 },
        { time: 18.9, voice: 'tick', midi: 84, gain: 0.15 },
        { time: 19.1, voice: 'boing', midi: 57, gain: 0.15, duration: 0.55 },
      ]
    : [
        { time: 18.2, voice: 'woodblock', midi: 76, gain: 0.14 },
        { time: 18.55, voice: 'woodblock', midi: 65, gain: 0.13 },
        { time: 18.9, voice: 'woodblock', midi: 76, gain: 0.14 },
        { time: 19.08, voice: 'slideWhistle', midi: 72, midiTo: 84, gain: 0.085, duration: 0.5 },
      ];
  for (const cue of cues) {
    push({
      time: cue.time,
      duration: cue.duration ?? 0.08,
      voice: cue.voice,
      midi: cue.midi,
      ...(cue.midiTo === undefined ? {} : { midiTo: cue.midiTo }),
      gain: cue.gain,
      pan: cue.voice === 'boing' || cue.voice === 'slideWhistle' ? 0.15 : 0.28,
      role: 'foley',
    });
  }
}

function buildAnswer(push, params) {
  const base = params.variant === 'base';
  stride(push, 11, ['F', 'F']);
  stride(push, 12, ['G7', 'C7']);
  oompah(push, 11, ['F', 'F']);
  oompah(push, 12, ['G7', 'C7']);
  brushes(push, 11);
  brushes(push, 12);
  backbeat(push, 11);
  backbeat(push, 12);
  cymbal(push, timeOf(11), { gain: 0.055 });

  if (base) {
    melody(push, 40, themeSlice(8, 12), { voice: 'clarinet', gain: 0.062, pan: -0.22 });
    melody(push, 42, themeSlice(0, 4), { voice: 'trumpet', gain: 0.068, pan: 0.2 });
    melody(push, 44, themeSlice(12, 16), { voice: 'trumpet', gain: 0.072, pan: 0.2 });
    melody(push, 46, themeSlice(12, 16), { voice: 'clarinet', gain: 0.052, pan: -0.22, shift: 12 });
  } else {
    melody(push, 40, themeSlice(4, 8), { voice: 'trumpet', gain: 0.068, pan: 0.2 });
    melody(push, 42, themeSlice(8, 12), { voice: 'clarinet', gain: 0.062, pan: -0.22, shift: 12 });
    melody(push, 44, themeSlice(0, 4), { voice: 'clarinet', gain: 0.058, pan: -0.22 });
    melody(push, 46, themeSlice(0, 4), { voice: 'trumpet', gain: 0.07, pan: 0.2 });
  }
}

function buildSlow(push, params) {
  const base = params.variant === 'base';
  const lead = base ? 'clarinet' : 'trumpetMuted';
  const leadNotes = base ? themeSlice(0, 4, { stretch: 2 }) : themeSlice(4, 8, { stretch: 2 });
  const answerNotes = base ? themeSlice(12, 16) : themeSlice(8, 12);
  melody(push, 48, leadNotes, { voice: lead, gain: 0.058, pan: -0.15, legato: 0.99 });
  melody(push, 56, answerNotes, { voice: lead, gain: 0.05, pan: -0.15, legato: 0.99 });
  if (base) {
    melody(push, 48, leadNotes, { voice: 'trombone', gain: 0.028, pan: -0.02, legato: 0.99, shift: -12 });
  } else {
    melody(push, 48, leadNotes, { voice: 'clarinet', gain: 0.032, pan: -0.25, legato: 0.99, shift: -12 });
  }

  const chords = base
    ? [
        [13, ['F', 'F']],
        [14, ['Dm', 'Dm']],
        [15, ['Bb', 'C7']],
      ]
    : [
        [13, ['D7', 'D7']],
        [14, ['Gm', 'Gm']],
        [15, ['G7', 'C7']],
      ];
  for (const [bar, pair] of chords) {
    for (const beat of [1, 3]) {
      const name = pair[beat === 1 ? 0 : 1];
      const chord = CHORDS[name];
      const midi = pitchToMidi(chord.root);
      push({ time: timeOf(bar, beat), duration: 0.92, voice: 'tuba', midi: midi < 36 ? midi + 12 : midi, gain: 0.062, pan: -0.08 });
      chordBlock(push, timeOf(bar, beat) + 0.01, [chord.triad[0], chord.triad[2]], {
        voice: 'piano',
        gain: 0.026,
        duration: 0.9,
        pan: 0.02,
        spread: 0.012,
      });
    }
  }
}

function buildCadence(push, params) {
  const base = params.variant === 'base';
  // Tutti F: this is the cadence the whole passage has been pointing at.
  chordBlock(push, timeOf(16), ['F1', 'F2', 'C3', 'F3', 'A3', 'C4', 'F4'], {
    voice: 'piano',
    gain: 0.032,
    duration: 1.9,
    pan: 0,
    spread: 0.008,
  });
  chordBlock(push, timeOf(16), ['F4', 'A4', 'C5'], {
    voice: 'trumpet',
    gain: 0.042,
    duration: 1.7,
    pan: 0.2,
    spread: 0.006,
  });
  push({ time: timeOf(16), duration: 1.7, voice: 'clarinet', midi: pitchToMidi('F5'), gain: 0.04, pan: -0.2 });
  push({ time: timeOf(16), duration: 1.8, voice: 'tuba', midi: pitchToMidi('F2'), gain: 0.085, pan: -0.08 });
  push({ time: timeOf(16), duration: 0.9, voice: 'xylophone', midi: pitchToMidi('F6'), gain: 0.06, pan: 0.15 });
  push({ time: timeOf(16) + 0.02, duration: 0.9, voice: 'xylophone', midi: pitchToMidi('C7'), gain: 0.045, pan: 0.18 });
  push({ time: timeOf(16), duration: 0.24, voice: 'bassDrum', gain: 0.09, pan: 0 });
  cymbal(push, timeOf(16), { duration: 0.9, gain: 0.055 });
  // A last comic tag on the theme's cadential cell, then the low F.
  melody(push, 61, themeSlice(12, 15), { voice: base ? 'clarinet' : 'trumpetMuted', gain: 0.036, pan: -0.1, legato: 0.99 });
  chordBlock(push, timeOf(16, 3), ['F4', 'A4', 'C5', 'F5'], {
    voice: 'piano',
    gain: 0.022,
    duration: 1.5,
    pan: 0.03,
    spread: 0.01,
  });
  push({ time: timeOf(16, 3), duration: 1.6, voice: 'tuba', midi: pitchToMidi('F1'), gain: 0.055, pan: -0.05 });
}

/**
 * Build the complete score descriptor.
 *
 * @param {object} rawParams `{ variant: 'base'|'alternate', transpose, gain }`.
 * @returns {{
 *   seconds: number, bpm: number, variant: string, transpose: number, gain: number,
 *   sections: Array<{id: string, start: number, end: number}>,
 *   events: Array<{id: string, section: string, time: number, duration: number,
 *     voice: string, midi?: number, midiTo?: number, gain: number, pan: number,
 *     role: 'music'|'foley'}>,
 *   rests: Array<{start: number, end: number, scope: 'music'|'all'}>,
 *   cues: Array<{id: string, time: number}>,
 *   theme: ReadonlyArray<readonly [number, number, string]>,
 * }}
 */
export function buildScore(rawParams = {}) {
  const params = normalizeParams(rawParams);
  const events = [];
  const theme = makeWriter('theme', events, params);
  const inspect = makeWriter('inspect', events, params);
  const chase = makeWriter('chase', events, params);
  const bandstop = makeWriter('bandstop', events, params);
  const answer = makeWriter('answer', events, params);
  const slow = makeWriter('slow', events, params);
  const cadence = makeWriter('cadence', events, params);

  buildTheme(theme, params);
  buildInspect(inspect, params);
  buildChase(chase, params);
  buildBandstop(bandstop, params);
  buildAnswer(answer, params);
  buildSlow(slow, params);
  buildCadence(cadence, params);

  // Stable sort on time (and duration) preserves the authored insertion order
  // for ties, so the event ids do not depend on an engine locale.
  events.sort((a, b) => a.time - b.time || a.duration - b.duration);
  events.forEach((event, index) => {
    event.id = `e${String(index).padStart(4, '0')}`;
    if (event.time < 0 || event.time >= DURATION_SECONDS) {
      throw new Error(`cartoon-jazz: event ${event.id} (${event.voice}) starts outside the 32 s passage`);
    }
  });

  const sections = SECTION_PLAN.map(([id, start, end]) => ({ id, start, end }));
  const cues = [
    ['open', 0],
    ['inspect', 8],
    ['chase_launch', 12],
    ['chase_build', 16],
    ['stop', 18],
    ['stop_tick_a', 18.2],
    ['stop_tick_b', 18.55],
    ['stop_tick_c', 18.9],
    ['stop_release', params.variant === 'base' ? 19.1 : 19.08],
    ['restart', 20],
    ['answer_reply', 22],
    ['slow_theme', 24],
    ['sigh', 28],
    ['cadence', 30],
    ['tag', 31],
  ].map(([id, time]) => ({ id, time }));

  return {
    seconds: DURATION_SECONDS,
    bpm: BPM,
    variant: params.variant,
    transpose: params.transpose,
    gain: params.gain,
    sections,
    events,
    rests: RESTS.map(rest => ({ ...rest })),
    cues,
    theme: THEME,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function rmsOf(bus, from, to) {
  const start = Math.max(0, Math.min(bus[0].length, Math.round(from)));
  const end = Math.max(start, Math.min(bus[0].length, Math.round(to)));
  let energy = 0;
  for (let i = start; i < end; i++) energy += bus[0][i] * bus[0][i] + bus[1][i] * bus[1][i];
  return Math.sqrt(energy / Math.max(1, (end - start) * 2));
}

/**
 * Gate a stereo bus over a rest. The fade-out starts just before the rest so a
 * ringing room tail cannot click; the interior is exactly zero. This runs AFTER
 * the room is added, which is the point: a real rest silences the reverb tail,
 * not just the next note.
 */
function gate(bus, startSample, endSample, sampleRate) {
  const fade = Math.max(1, Math.round(0.025 * sampleRate));
  const from = Math.max(0, Math.round(startSample));
  const to = Math.min(bus[0].length, Math.round(endSample));
  for (let i = Math.max(0, from - fade); i < from; i++) {
    const gain = (from - i) / fade;
    bus[0][i] *= gain;
    bus[1][i] *= gain;
  }
  for (let i = from; i < to; i++) {
    bus[0][i] = 0;
    bus[1][i] = 0;
  }
}

/**
 * Render the score to exactly `frames` stereo samples.
 *
 * @param {{sampleRate: number, channels: number, frames: number, params?: object, seed?: number}} args
 * @returns {{channels: Float32Array[], report: object}}
 */
export function renderScore({ sampleRate, channels, frames, params = {}, seed = 7 }) {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000) {
    throw new Error(`cartoon-jazz: invalid sampleRate ${sampleRate}`);
  }
  if (channels !== 2) {
    throw new Error(`cartoon-jazz: stereo only (the voices and pan law are stereo), got ${channels} channels`);
  }
  if (!Number.isInteger(frames) || frames <= 0) {
    throw new Error(`cartoon-jazz: invalid frame count ${frames}`);
  }
  const score = buildScore(params);
  const expected = Math.round(DURATION_SECONDS * sampleRate);
  if (frames !== expected) {
    throw new Error(
      `cartoon-jazz: the Runtime expects ${frames} samples but this 32 s score at ${sampleRate} Hz ` +
        `is exactly ${expected}. Source.durationSamples is the render length: keep 32 s ` +
        `or re-author the score; this contract has no truncation option.`,
    );
  }

  const music = [new Float32Array(frames), new Float32Array(frames)];
  const foley = [new Float32Array(frames), new Float32Array(frames)];
  const voiceCounts = {};
  const rendered = [];
  for (const [index, event] of score.events.entries()) {
    const x = synthesise(event.voice, {
      midi: event.midi,
      midiTo: event.midiTo,
      duration: event.duration,
      sampleRate,
      seed: (seed >>> 0) ^ Math.imul(index + 1, 0x9e3779b1),
    });
    addToBus(event.role === 'foley' ? foley : music, x, Math.round(event.time * sampleRate), event.gain, event.pan);
    voiceCounts[event.voice] = (voiceCounts[event.voice] ?? 0) + 1;
    rendered.push({
      id: event.id,
      voice: event.voice,
      role: event.role,
      time: event.time,
      samples: x.length,
    });
  }

  // Music room, then the rest gate (after the room), then the dry foley bus.
  const send = new Float32Array(frames);
  for (let i = 0; i < frames; i++) send[i] = (music[0][i] + music[1][i]) * 0.5;
  const wet = room(send, sampleRate);
  for (let i = 0; i < frames; i++) {
    music[0][i] += wet[0][i] * 0.18;
    music[1][i] += wet[1][i] * 0.18;
  }

  const restReports = [];
  for (const rest of score.rests) {
    if (rest.scope === 'all') gate(foley, rest.start * sampleRate, rest.end * sampleRate, sampleRate);
    gate(music, rest.start * sampleRate, rest.end * sampleRate, sampleRate);
    restReports.push({
      start: rest.start,
      end: rest.end,
      scope: rest.scope,
      musicRms: Number(rmsOf(music, rest.start * sampleRate, rest.end * sampleRate).toFixed(6)),
      musicPeak: (() => {
        let peak = 0;
        const a = Math.round(rest.start * sampleRate);
        const b = Math.round(rest.end * sampleRate);
        for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(music[0][i]), Math.abs(music[1][i]));
        return Number(peak.toFixed(6));
      })(),
      foleyRms: Number(rmsOf(foley, rest.start * sampleRate, rest.end * sampleRate).toFixed(6)),
    });
  }

  const output = [new Float32Array(frames), new Float32Array(frames)];
  for (let i = 0; i < frames; i++) {
    output[0][i] = music[0][i] + foley[0][i];
    output[1][i] = music[1][i] + foley[1][i];
  }

  // An authored close: the final chord rings, then the passage fades to exact
  // silence at the last sample. Iterate FORWARD from the fade start; reading
  // the cosine from i=0 at the last sample would silently invert the fade.
  const fadeSamples = Math.min(frames, Math.round(0.35 * sampleRate));
  for (let i = 0; i < fadeSamples; i++) {
    const index = frames - fadeSamples + i;
    const gain = 0.5 + 0.5 * Math.cos((Math.PI * (i + 1)) / fadeSamples);
    output[0][index] *= gain;
    output[1][index] *= gain;
  }

  if (score.gain !== 1) {
    for (const channel of output) {
      for (let i = 0; i < frames; i++) channel[i] *= score.gain;
    }
  }

  let peak = 0;
  for (let i = 0; i < frames; i++) {
    peak = Math.max(peak, Math.abs(output[0][i]), Math.abs(output[1][i]));
  }
  let trimmed = false;
  if (peak > PEAK_CEILING) {
    // Authoring headroom, not a limiter: the Runtime rejects |sample| > 1 and
    // never clamps. Scaling the whole programme preserves the mix.
    const trim = PEAK_CEILING / peak;
    for (const channel of output) {
      for (let i = 0; i < frames; i++) channel[i] *= trim;
    }
    peak *= trim;
    trimmed = true;
  }

  const report = {
    seconds: DURATION_SECONDS,
    sampleRate,
    frames,
    variant: score.variant,
    transpose: score.transpose,
    gain: score.gain,
    peak: Number(peak.toFixed(6)),
    rms: Number(rmsOf(output, 0, frames).toFixed(6)),
    musicRms: Number(rmsOf(music, 0, frames).toFixed(6)),
    foleyRms: Number(rmsOf(foley, 0, frames).toFixed(6)),
    trimmed,
    events: {
      total: score.events.length,
      music: score.events.filter(event => event.role === 'music').length,
      foley: score.events.filter(event => event.role === 'foley').length,
    },
    voices: voiceCounts,
    sections: score.sections.map(section => ({
      id: section.id,
      start: section.start,
      end: section.end,
      rms: Number(rmsOf(output, section.start * sampleRate, section.end * sampleRate).toFixed(6)),
    })),
    rests: restReports,
    cues: score.cues,
    rendered,
  };
  return { channels: output, report };
}

export { normalizeParams };
