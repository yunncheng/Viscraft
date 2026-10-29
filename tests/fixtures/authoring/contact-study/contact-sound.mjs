/**
 * contact-study — the example's OWN sound scene.
 *
 * The sound is the same event as the picture, on the same sample: one strike at
 * the authored contact frame, then the struck bar's own decay. There is no bed,
 * no tone under the whole piece and no per-frame sound.
 *
 *   frames 0 .. contact-1   silence (the authored rest: the arm is still)
 *   contact                 the recorded marimba C6 (the bar is printed C6, so it
 *                           is the recorded pitch, not a transposition) with a
 *                           low cello pizzicato at the same sample for body
 *   contact+1 .. end        the marimba's natural tail, closed by the module's
 *                           authored end fade
 *
 * It reuses the vendored `sound-arrange.mjs` sampler and renderer: real recorded
 * material, transient-aligned to 2 ms, per-voice level normalisation, a stereo
 * pan and the module's small room, rendered to exactly the Source's sample span.
 * The event's frame is read from `contact-timeline.mjs`, the same file the
 * picture scene reads — never from a second copy of the timing.
 *
 * Pure ESM with no DOM: the browser page only loads the recordings this study
 * actually strikes and hands the bytes in. `renderContactSound` is deterministic
 * for a given `{ sampleRate, channels, samples, params, seed, bytes }`.
 */

import { SAMPLE_PACK, Sampler, renderArrangement } from './sound-arrange.mjs';
import { CONTACT_PACKS } from './contact-packs.mjs';
import { STUDY, sampleAt, timelineFor } from './contact-timeline.mjs';

export { CONTACT_PACKS };

/** The recordings this study uses, in `SAMPLE_PACK` order. */
export const CONTACT_SAMPLE_FILES = Object.freeze(
  CONTACT_PACKS.flatMap(pack => SAMPLE_PACK[pack].files.map(entry => entry.file)),
);

/** 60 BPM is a display grid only: this piece has one attack, not a tempo. */
const BPM = 60;

/**
 * Build the score descriptor handed to `renderArrangement`. The arrangement is
 * deliberately tiny: two voices on one sample, then nothing.
 *
 * @param {ReturnType<typeof timelineFor>} timeline
 * @param {number} sampleRate
 * @param {{ mix?: number }} [options]
 */
export function buildContactScore(timeline, sampleRate, { mix = 1 } = {}) {
  const contact = timeline.contactFrame;
  const sample = sampleAt(contact, sampleRate);
  const totalSamples = sampleAt(timeline.frames, sampleRate);
  const sections = [
    {
      id: 'rest',
      label: 'rest — the arm is still; nothing is struck',
      startFrame: 0,
      endFrame: contact,
      startSample: 0,
      endSample: sample,
    },
    {
      id: 'strike',
      label: 'strike — one attack, on the contact sample',
      startFrame: contact,
      endFrame: timeline.liftEnd,
      startSample: sample,
      endSample: sampleAt(timeline.liftEnd, sampleRate),
    },
    {
      id: 'ring',
      label: 'ring — the C6 bar decays; no new attacks',
      startFrame: timeline.liftEnd,
      endFrame: timeline.frames,
      startSample: sampleAt(timeline.liftEnd, sampleRate),
      endSample: totalSamples,
    },
  ];
  const beat = contact / timeline.fps;
  const events = [
    {
      id: 'impact-body',
      voice: 'celloPizz',
      section: 'strike',
      frame: contact,
      sample,
      beat,
      velocity: 0.8,
      midi: 43,
      note: 'G2',
      holdSeconds: 0.3,
      pan: -0.14,
      tag: 'impact',
    },
    {
      id: 'impact-bar',
      voice: 'marimba',
      section: 'strike',
      frame: contact,
      sample,
      beat,
      // The recorded note IS C6 (rootMidi 84 on the marimba pack): the bar's
      // printed note and the recording agree, so this is not a transposition.
      velocity: 0.95,
      midi: 84,
      note: 'C6',
      holdSeconds: 0.52,
      pan: 0.06,
      tag: 'impact',
    },
  ];
  return {
    params: { bpm: BPM, seconds: timeline.frames / timeline.fps, fps: timeline.fps, mix },
    fps: timeline.fps,
    sampleRate,
    frames: timeline.frames,
    seconds: timeline.frames / timeline.fps,
    bpm: BPM,
    totalBeats: timeline.frames / timeline.fps,
    sections,
    events,
    accents: ['impact-bar'],
    rest: { section: 'rest', ...sections[0] },
    motif: { marimba: ['C6'], cello: ['G2'] },
  };
}

/**
 * Render the study to stereo float channels of exactly `samples` per channel.
 *
 * @param {{
 *   sampleRate: number,
 *   channels: number,
 *   samples: number,
 *   params: Record<string, unknown>,
 *   seed: number,
 *   bytes: Record<string, Uint8Array>,
 * }} request The `window.viscraftSound.render` arguments plus the WAV bytes.
 */
export function renderContactSound({ sampleRate, channels, samples, params, seed, bytes }) {
  if (channels !== 2) throw new Error(`contact-sound: stereo only, got ${channels} channels`);
  const mix = typeof params?.mix === 'number' ? params.mix : 1;
  if (!(mix >= 0 && mix <= 1)) throw new Error(`contact-sound: params.mix must be within [0, 1], got ${mix}`);
  // The picture frame count travels in params so the Sound Source cannot guess a
  // different length than the picture it is cut against.
  const pictureFrames =
    typeof params?.frames === 'number'
      ? Math.round(params.frames)
      : Math.round((samples * STUDY.fps) / sampleRate);
  const timeline = timelineFor(pictureFrames);
  const expected = sampleAt(timeline.frames, sampleRate);
  if (expected !== samples)
    throw new Error(
      `contact-sound: the clock handed ${samples} samples but ${timeline.frames} frames @ ${timeline.fps}fps ` +
        `is exactly ${expected}; params.frames and source.durationSamples must describe the same piece`,
    );
  if (!bytes || typeof bytes !== 'object') throw new Error('contact-sound: the WAV bytes were not provided');
  for (const file of CONTACT_SAMPLE_FILES) {
    if (!bytes[file]) throw new Error(`contact-sound: the sound kit is incomplete (missing ${file})`);
  }

  const sampler = new Sampler(bytes, { sampleRate });
  const score = buildContactScore(timeline, sampleRate, { mix });
  const { channels: rendered, report } = renderArrangement(score, { sampler, frames: samples, seed, mix });
  return {
    channels: rendered,
    report: {
      ...report,
      timeline: {
        frames: timeline.frames,
        fps: timeline.fps,
        contactFrame: timeline.contactFrame,
        contactSample: sampleAt(timeline.contactFrame, sampleRate),
        rest: timeline.rest,
      },
      renderedEvents: score.events.map(event => ({
        id: event.id,
        voice: event.voice,
        frame: event.frame,
        sample: event.sample,
        file: event.renderedFile,
        midi: event.midi,
      })),
    },
  };
}
