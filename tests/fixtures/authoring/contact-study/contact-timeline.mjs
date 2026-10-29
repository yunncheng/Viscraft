/**
 * contact-study — the ONE authored event clock the picture and the sound share.
 *
 * The study is one operation: a counterweighted striker swings down onto a
 * marimba bar, the head meets the bar at `contactFrame`, and the arm rebounds
 * while the bar rings. This file owns the event itself:
 *
 *   - `contactFrame` is the frame where the mallet head touches the bar. The
 *     picture animates to it and draws the contact effects FROM it; the sound
 *     places its attack on that frame's exact sample.
 *   - `approachStart` / `liftEnd` are derived, never written
 *     twice, so there is no second copy of the timing to drift.
 *   - `events` names the sound events in frame terms; the sound scene converts
 *     frames to samples with the composition clock (`sampleAt`).
 *
 * Both browser Sources (picture and sound) declare this file in `resources`, so
 * editing it invalidates both and rebuilds both from the same numbers. That is
 * deliberate: a contact and its sound cannot be edited independently.
 *
 * Change the timing here, not in the scene. `frames` (the Source length in
 * frames) is passed in by the caller and must leave room for the whole action;
 * `timelineFor` throws rather than silently clamping a contact that would not
 * fit inside the piece.
 *
 * No DOM, no clock, no randomness: this module is a plain, dependency-free ESM
 * data map.
 */

/** The authored study. Only `contactFrame` is a free timing choice. */
export const STUDY = Object.freeze({
  /** The study is authored at 24 fps; the Sound Source length is derived from it. */
  fps: 24,
  /** The frame where the mallet head meets the C6 bar. */
  contactFrame: 12,
  /** Frames of descent before contact (the approach starts this many frames earlier). */
  approachFrames: 5,
  /** Frames from contact to the fully withdrawn position. */
  liftFrames: 6,
});

const FPS = STUDY.fps;

/** The exact sample of a picture frame on the composition clock. */
export function sampleAt(frame, sampleRate) {
  if (!Number.isInteger(frame) || frame < 0) throw new Error(`contact-timeline: invalid frame ${frame}`);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0)
    throw new Error(`contact-timeline: invalid sampleRate ${sampleRate}`);
  return Math.ceil((frame * sampleRate) / FPS);
}

/**
 * Resolve the authored study against a Source length.
 *
 * @param {number} frames The Source length in picture frames.
 * @returns {{
 *   fps: number,
 *   frames: number,
 *   contactFrame: number,
 *   approachStart: number,
 *   liftEnd: number,
 *   rest: { startFrame: number, endFrame: number },
 *   events: Array<{ id: string, frame: number, voices: string[], role: string }>,
 *   phases: Array<{ id: string, startFrame: number, endFrame: number }>,
 * }}
 */
export function timelineFor(frames) {
  if (!Number.isInteger(frames) || frames <= 0)
    throw new Error(`contact-timeline: frames must be a positive integer, got ${frames}`);
  const { contactFrame, approachFrames, liftFrames } = STUDY;
  if (!Number.isInteger(contactFrame) || contactFrame <= 0)
    throw new Error(`contact-timeline: STUDY.contactFrame must be a positive integer, got ${contactFrame}`);
  // There must be at least one held frame of prior state, and at least one
  // readable frame after the withdrawal.
  if (contactFrame < approachFrames + 1)
    throw new Error(
      `contact-timeline: contactFrame ${contactFrame} leaves no prior state for a ${approachFrames}-frame approach`,
    );
  if (contactFrame + liftFrames > frames - 1)
    throw new Error(
      `contact-timeline: contactFrame ${contactFrame} + ${liftFrames} lift frames does not fit in ${frames} frames; ` +
        'lengthen the Source or move the contact earlier',
    );

  const approachStart = contactFrame - approachFrames;
  const liftEnd = contactFrame + liftFrames;
  // ONE attack, on the contact. The result is the struck bar's own decay, not a
  // second musical event: there is nothing to schedule after the impact.
  const events = [
    {
      id: 'impact',
      frame: contactFrame,
      voices: ['celloPizz', 'marimba'],
      role: 'the mallet meets the C6 bar: one instant, one sample',
    },
  ];
  const phases = [
    { id: 'prior', startFrame: 0, endFrame: approachStart },
    { id: 'approach', startFrame: approachStart, endFrame: contactFrame },
    { id: 'reveal', startFrame: contactFrame, endFrame: liftEnd },
    { id: 'hold', startFrame: liftEnd, endFrame: frames - 1 },
  ];
  return {
    fps: FPS,
    frames,
    contactFrame,
    approachStart,
    liftEnd,
    // Nothing is struck before the contact: the lead-in is an authored rest.
    rest: { startFrame: 0, endFrame: contactFrame },
    events,
    phases,
  };
}

/** The study in one line, for a caption or a build summary. */
export function describeTimeline(timeline) {
  return (
    `${timeline.frames} frames @ ${timeline.fps} fps; contact at frame ${timeline.contactFrame}; ` +
    `rest frames ${timeline.rest.startFrame}–${timeline.rest.endFrame - 1}`
  );
}
