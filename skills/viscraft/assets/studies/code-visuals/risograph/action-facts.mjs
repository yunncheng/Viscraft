/**
 * RISOGRAPH RIDE — shared, truthful action facts.
 *
 * This module is the single source of the timing facts that both the picture
 * (`scene.mjs`) and the two sound scenes (`score.mjs`, `foley.mjs`) consume.
 * Editing a value here intentionally changes both the visible action and the
 * matching sound; editing only `score.mjs` or only `foley.mjs` re-renders just
 * that sound Source.
 *
 * The values are the ones the existing 96-frame rides already use. They are
 * authored seconds at 24 fps, not an invented score grid:
 *
 * - PRESS is the print machinery: per-plate gates, sheet value, static
 *   registration and the short registration kicks. `press.kicks` are VISUAL
 *   registration impulses only; they are never physical Foley onsets.
 * - Riverside bell: the hand reaches the bell target over 2.1-2.3 s, holds to
 *   2.55 s and retracts by 2.8 s. The drawing is stepped at 12 Hz, so the first
 *   visible step that actually reaches the 2.3 s target is ceil(2.3*12)/12 =
 *   2.3333... s. A 2.25 s attack is still short of the target and is wrong.
 * - Riverside pigeons: five birds start their flush at 2.35 + i*0.05 s and
 *   climb through 3.4 s. The five flap onsets are those real starts, not one
 *   beep per animation frame.
 * - Bakery: the baker reaches 2.1-2.4 s and retracts 2.7-2.95 s; the bread is
 *   caught 2.45-2.7 s, so the continuous caught value is full at 2.7 s. The
 *   drawing is stepped at 12 Hz, so the first visible step at full is 2.75 s;
 *   that is the Foley contact, not a bare 2.7 assumption. The basket stow runs
 *   2.85-3.15 s; the first 12 Hz step where `stowed > 0.82` is 3.1667 s, which
 *   is the basket contact. There is no bicycle bell in this ride. The pavement
 *   pigeon flaps 2.85-3.15 s.
 */
export const FPS = 24;
export const RIDE_FRAMES = 96;
export const RIDE_SECONDS = 4;
export const ACTION_STEP = 1 / 12;
export const BPM = 120;
export const BEAT = 60 / BPM;
export const BAR = 4 * BEAT;

/** The first 12 Hz stepped time that reaches `seconds` (the drawing's clock). */
export function firstStepAtOrAfter(seconds) {
  return Math.ceil(seconds * 12) / 12;
}

/** The first 12 Hz stepped time where a linear 0..1 ramp reaches a fraction. */
export function firstStepWhere(start, end, fraction) {
  return firstStepAtOrAfter(start + (end - start) * fraction);
}

/** The baguette is visually stowed once `stowed` passes this fraction. */
export const BAKERY_STOW_VISIBLE = 0.82;

/** Print machinery facts, preserving the existing 96-frame rides exactly. */
export const PRESS = Object.freeze({
  riverside: Object.freeze({
    gates: Object.freeze([-0.5, 0.75, 1.5]),
    sheet: 3.7,
    base: Object.freeze([
      Object.freeze([0, 0]),
      Object.freeze([3, -2]),
      Object.freeze([-3, 2.5]),
    ]),
    kicks: Object.freeze([0.75, 1.5, 2.35, 3.3]),
  }),
  bakery: Object.freeze({
    gates: Object.freeze([-0.5, 0.75, 1.5]),
    sheet: 7.9,
    base: Object.freeze([
      Object.freeze([0, 0]),
      Object.freeze([2.5, -2.5]),
      Object.freeze([-2.5, 3]),
    ]),
    kicks: Object.freeze([0.75, 1.5, 2.55, 3.35]),
  }),
});

const RIVERSIDE_FLAPS = Object.freeze(
  Array.from({ length: 5 }, (_, index) => Object.freeze(2.35 + index * 0.05)),
);

/**
 * Bell timing. `strike` is derived from `target` in the same call, so editing
 * `target` moves the picture reach (which stops at `target`) and the Foley
 * bell together. It is never restated as an independent literal.
 */
function bellFacts({ reachStart, target, holdEnd, retract }) {
  return Object.freeze({
    reachStart,
    target,
    holdEnd,
    retract,
    strike: firstStepAtOrAfter(target),
  });
}

const RIVERSIDE_BELL = bellFacts({
  reachStart: 2.1,
  target: 2.3,
  holdEnd: 2.55,
  retract: 2.8,
});

const BAKERY_ACTION = Object.freeze({
  reachStart: 2.1,
  reachEnd: 2.4,
  retractStart: 2.7,
  retractEnd: 2.95,
  caughtStart: 2.45,
  caughtEnd: 2.7,
  stowedStart: 2.85,
  stowedEnd: 3.15,
  stowVisible: BAKERY_STOW_VISIBLE,
});

const RIVERSIDE_PIGEONS = Object.freeze({
  start: 2.35,
  end: 3.4,
  count: 5,
  delay: 0.05,
  flapTimes: RIVERSIDE_FLAPS,
});

const BAKERY_PIGEONS = Object.freeze({
  start: 2.85,
  end: 3.15,
  count: 1,
  delay: 0,
  flapTimes: Object.freeze([2.85]),
});

const BAKERY = Object.freeze({
  ...BAKERY_ACTION,
  catchContact: firstStepAtOrAfter(BAKERY_ACTION.caughtEnd),
  stowContact: firstStepWhere(
    BAKERY_ACTION.stowedStart,
    BAKERY_ACTION.stowedEnd,
    BAKERY_ACTION.stowVisible,
  ),
});

/**
 * Complete facts for one ride.
 *
 * `action` is the one physical-action window both sound modules consume:
 *   riverside  reach 2.10 s .. bell hold end 2.55 s; contact = the stepped
 *              strike derived from `bell.target`.
 *   bakery     reach 2.10 s .. the stepped catch contact 2.75 s.
 * `foley` is the Foley span for the same ride (through the pigeon flush on the
 * riverside and through the stepped basket contact on the bakery). Both are
 * built from the same values in this module rather than restated as literals;
 * they are references, not an independent timing authority.
 */
export const RIDES = Object.freeze({
  riverside: Object.freeze({
    id: 'river-ride',
    variant: 'riverside',
    frames: RIDE_FRAMES,
    seconds: RIDE_SECONDS,
    press: PRESS.riverside,
    bell: RIVERSIDE_BELL,
    pigeons: RIVERSIDE_PIGEONS,
    bakery: null,
    action: Object.freeze({
      kind: 'bell',
      start: RIVERSIDE_BELL.reachStart,
      end: RIVERSIDE_BELL.holdEnd,
      contact: RIVERSIDE_BELL.strike,
    }),
    foley: Object.freeze({
      start: RIVERSIDE_BELL.reachStart,
      end: RIVERSIDE_PIGEONS.end,
    }),
  }),
  bakery: Object.freeze({
    id: 'bakery-catch',
    variant: 'bakery',
    frames: RIDE_FRAMES,
    seconds: RIDE_SECONDS,
    press: PRESS.bakery,
    bell: null,
    pigeons: BAKERY_PIGEONS,
    bakery: BAKERY,
    action: Object.freeze({
      kind: 'catch',
      start: BAKERY.reachStart,
      end: BAKERY.catchContact,
      contact: BAKERY.catchContact,
    }),
    foley: Object.freeze({
      start: BAKERY.reachStart,
      end: BAKERY.stowContact,
    }),
  }),
});

/** Select one ride; unknown variants are an authoring error, not a fallback. */
export function rideFacts(variant) {
  const ride = RIDES[variant];
  if (!ride) throw new Error(`risograph action facts: unknown ride "${variant}"`);
  return ride;
}

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const ramp = (time, start, end) => clamp01((time - start) / (end - start));

/**
 * Deterministic visible action state for one frame time in seconds.
 *
 * This is the exact stepped 12 Hz math the picture uses (`scene.mjs`), exposed
 * as a pure observer so a test can assert the same state the drawing shows.
 * `inBasket` is the same `stowed > stowVisible` threshold the drawing uses.
 */
export function actionAt(variant, seconds) {
  const ride = rideFacts(variant);
  const stepped = Math.floor(seconds * 12) / 12;
  if (ride.bell) {
    const bell = ride.bell;
    return Object.freeze({
      variant,
      stepped,
      bell:
        ramp(stepped, bell.reachStart, bell.target) *
        (1 - ramp(stepped, bell.holdEnd, bell.retract)),
      reach: 0,
      caught: 0,
      stowed: 0,
      inBasket: false,
      contact: bell.strike,
    });
  }
  const bakery = ride.bakery;
  const reach =
    ramp(stepped, bakery.reachStart, bakery.reachEnd) *
    (1 - ramp(stepped, bakery.retractStart, bakery.retractEnd));
  const caught = ramp(stepped, bakery.caughtStart, bakery.caughtEnd);
  const stowed = ramp(stepped, bakery.stowedStart, bakery.stowedEnd);
  return Object.freeze({
    variant,
    stepped,
    bell: 0,
    reach,
    caught,
    stowed,
    inBasket: stowed > bakery.stowVisible,
    contact: bakery.catchContact,
  });
}

/** Explicit statement carried by the facts and the README. */
export const REGISTRATION_KICKS_ARE_VISUAL_ONLY = true;
