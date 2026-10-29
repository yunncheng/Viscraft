// motion-camera.mjs — a reusable MOTION + CAMERA planner for a browser CodeScene.
//
// Two halves that share one clock, and nothing else:
//
//   1. MOTION — pure "time -> number" curves and segmentation: named easings
//      (both closed-form and CSS cubic-bezier), springs, a stepped cadence, an
//      eased scope with head/tail holds, and a staggered (lagged) start. Every
//      function is a pure map from time/frame to a number, so the same frame
//      always evaluates to the same value.
//   2. CAMERA — a pure "frame -> camera sample" planner over ONE continuous
//      world canvas. A camera is `{ x, y, z, r }`: the world point (x, y) sits
//      at the centre of the screen, `z` is the zoom (>1 pushes in), `r` is a
//      rotation about the centre. `createCamera({...}).at(frame, size)` returns
//      that camera for one frame; the scene reprojects its world every frame, so
//      a smooth zoom never magnifies a baked bitmap.
//
// WHY ONE MODULE. In code-authored work the recurring problems are: a move that
// must not depend on render cost, a push that must keep a chosen subject framed,
// and a set of reveals that arrive on a shared, deliberate cadence. Splitting
// those across ad-hoc `sin()` calls per project is how "the camera drifts" and
// "the reveal stutters" bugs happen. This module fixes the mechanisms once:
//
//   * `at(frame, size)` is a PURE function of the frame (plus the fixed spec and
//     the output size). Ordered and shuffled sampling agree exactly. There is no
//     wall clock, no `Date.now`, no `Math.random`, no `requestAnimationFrame` and
//     no stateful follow/damping — a damped camera would have to be fixed-step
//     pre-computed and is deliberately out of scope here.
//   * Zoom is interpolated in LOG space (`zlerp`), so equal eased steps give
//     equal perceived magnification steps and a push never overshoots.
//   * An `aim` holds a chosen world point on a chosen screen fraction at whatever
//     zoom the key track is at; an optional `bounds` clamps the resolved centre
//     (the one documented case where the aim can leave its fraction, reported as
//     `clamped`).
//
// PROVENANCE. The timing curves and the camera model are adapted from
// huashu-art-motion `scripts/engine/lib/{motion,camera,util}.js` at commit
// f178bd7754a71d6d399473af1501634548efa6cb (author alchaincyf), MIT. The
// upstream code is IIFEs that register onto window globals (`MO`, `CAM`, `U`)
// and hook a `U.onStage` stage loop; this file DE-GLOBALIZES all of it into
// plain ESM functions plus one `createCamera` factory, parameterises the stage
// size (upstream was fixed at 1920x1080) and replaces the stage hook with a
// per-call `size`. Portions of `motion.js` are themselves derived from Manim /
// ManimCommunity (3Blue1Brown, MIT) — see the header of `EASINGS` below and the
// module README; those notices must be retained wherever this file is shipped.
// No fonts, images, audio or upstream runtime are carried over.

export const TAU = Math.PI * 2;

const finite = (value, label) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`motion-camera: ${label} must be a finite number`);
  return value;
};
const positive = (value, label) => {
  const n = finite(value, label);
  if (n <= 0) throw new Error(`motion-camera: ${label} must be > 0`);
  return n;
};
const integer = (value, label, { min } = {}) => {
  if (!Number.isInteger(value)) throw new Error(`motion-camera: ${label} must be an integer`);
  if (min !== undefined && value < min) throw new Error(`motion-camera: ${label} must be >= ${min}`);
  return value;
};

// ---------------------------------------------------------------------------
// Scalars and windows (util.js / motion.js time helpers)
// ---------------------------------------------------------------------------

export const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, p) => a + (b - a) * p;

/** Smoothstep of `x` over the window [a, b] (upstream `U.ss`). */
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Normalise `t` inside the window [a, b] to 0..1 (upstream `MO.seg`/`U.seg`). */
export const seg = (t, a, b) => clamp((t - a) / (b - a));

/** Normalise `t` inside the window [t0, t0 + dur] to 0..1 (upstream `MO.at`). */
export const window01 = (t, t0, dur) => clamp((t - t0) / dur);

/**
 * Stepped cadence: quantise continuous time to an `fps` step (upstream `MO.step`
 * / `U.stepTime`). The "on twos" judder is a deliberate style here — the caller
 * chooses which layer is stepped (a held subject pose) and which is not (a
 * camera, which stays smooth).
 */
export const stepTime = (t, fps = 12) => {
  finite(t, 'time');
  positive(fps, 'fps');
  return Math.floor(t * fps + 1e-6) / fps;
};

// ---------------------------------------------------------------------------
// Easing curves
//
// MOTION.js provenance note: the closed-form curves below are the standard
// Penner/AE/CSS set (independently reproducible), BUT the manim-derived group
// (`smooth`, `smoothCE`, `thereAndBack`, `rushInto`, `rushFrom`, `doubleSmooth`,
// `wiggle`, `lagged`) is derived, via huashu `motion.js`, from Manim /
// ManimCommunity (3Blue1Brown, MIT). Those permission notices must be retained.
// ---------------------------------------------------------------------------

const sig = (x) => 1 / (1 + Math.exp(-x));

/** A cubic-bezier timing function (CSS `cubic-bezier(x1,y1,x2,y2)`) via Newton. */
export function bezier(x1, y1, x2, y2) {
  for (const [v, l] of [[x1, 'x1'], [y1, 'y1'], [x2, 'x2'], [y2, 'y2']]) finite(v, `bezier.${l}`);
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const X = (s) => ((ax * s + bx) * s + cx) * s;
  const Y = (s) => ((ay * s + by) * s + cy) * s;
  const dX = (s) => (3 * ax * s + 2 * bx) * s + cx;
  return (p) => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    let s = p;
    for (let k = 0; k < 8; k++) {
      const e = X(s) - p;
      const d = dX(s);
      if (Math.abs(e) < 1e-6 || Math.abs(d) < 1e-6) break;
      s -= e / d;
    }
    return Y(clamp(s));
  };
}

/**
 * Named easing curves. All map [0,1] -> [0,1] except the deliberate overshoot
 * curves (`backOut`, `elasticOut`), which may exceed 1 by design. `ease(name, t)`
 * clamps `t` to [0,1] before evaluating so an out-of-range sampler never
 * extrapolates.
 *
 * One deliberate oddity: `thereAndBack` is an "indicate" curve that goes out AND
 * returns, so it ends at 0 (f(1) = 0), not 1 — that is the point of the curve.
 *
 * Deliberately many curves, not one: an explainer settles with `smooth`, a
 * product beat snaps with a spring, a title pops on `expoOut`, a camera pans on
 * `sineInOut`, an incidental move uses `longTail`. Collapsing all motion onto a
 * single ease would erase that choice.
 */
export const EASINGS = {
  linear: (t) => t,
  smooth: (t) => t * t * t * (10 - 15 * t + 6 * t * t), // smootherstep: v and a zero at both ends
  smoothCE: (t, inflection = 10) => {
    const e = sig(-inflection / 2);
    return clamp((sig(inflection * (t - 0.5)) - e) / (1 - 2 * e));
  },
  thereAndBack: (t) => EASINGS.smooth(t < 0.5 ? 2 * t : 2 * (1 - t)),
  rushInto: (t) => 2 * EASINGS.smooth(t / 2),
  rushFrom: (t) => 2 * EASINGS.smooth(t / 2 + 0.5) - 1,
  doubleSmooth: (t) => (t < 0.5 ? 0.5 * EASINGS.smooth(2 * t) : 0.5 * (1 + EASINGS.smooth(2 * t - 1))),
  sineInOut: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  cubicIn: (t) => t * t * t,
  cubicOut: (t) => 1 - Math.pow(1 - t, 3),
  cubicInOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  quartOut: (t) => 1 - Math.pow(1 - t, 4),
  quintIn: (t) => t ** 5,
  quintOut: (t) => 1 - Math.pow(1 - t, 5),
  quintInOut: (t) => (t < 0.5 ? 16 * t ** 5 : 1 - Math.pow(-2 * t + 2, 5) / 2),
  expoIn: (t) => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10)),
  expoOut: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  expoInOut: (t) =>
    t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2,
  backOut: (t, s = 1.70158) => {
    const q = t - 1;
    return 1 + (s + 1) * q * q * q + s * q * q;
  },
  elasticOut: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (TAU / 3)) + 1),
  // Named CSS beziers used across the referenced work (album/keys/loops).
  appleOut: null,
  emphasized: null,
  k75: null,
  easyEase: null,
  longTail: null,
};

// Build the named bezier curves once (the fields above are filled here so the
// object literal stays readable and every key is enumerable in EASING_NAMES).
EASINGS.appleOut = bezier(0.25, 0.1, 0.25, 1); // CSS `ease` — product/launch transitions
EASINGS.emphasized = bezier(0.2, 0, 0, 1); // Material 3 "emphasized": long-tailed deceleration
EASINGS.k75 = bezier(0.75, 0, 0.25, 1); // Kurzgesagt "other motion at 75% influence"
EASINGS.easyEase = bezier(0.333, 0, 0.667, 1); // AE Easy Ease — looping actions
EASINGS.longTail = bezier(0.33, 0, 0.2, 1); // fast start, long settle — "follow the line, then land"

export const EASING_NAMES = Object.keys(EASINGS);

/**
 * Resolve an easing by name (or accept a caller-supplied function of [0,1]).
 * `t` is clamped to [0,1]; a negative zero is normalised so an endpoint is
 * exactly 0.
 */
export function ease(name, t) {
  const fn = typeof name === 'function' ? name : EASINGS[name ?? 'cubicInOut'];
  if (typeof fn !== 'function') throw new Error(`motion-camera: unknown easing "${name}"`);
  const v = fn(clamp(t, 0, 1));
  // Snap floating-point endpoint noise so an endpoint is EXACTLY 0 or 1 (an
  // overshoot curve is left untouched because its interior is > 1 by design).
  if (Math.abs(v) < 1e-9) return 0;
  if (Math.abs(v - 1) < 1e-9) return 1;
  return v;
}

/**
 * An eased scope with integer head/tail holds, returning progress in [0,1].
 * `frames` is the scope length, `localFrame` an integer frame inside it; the
 * active interval sits strictly between the two holds. A scope with no active
 * frames resolves to the end state (1).
 */
export function scopeProgress(localFrame, frames, { holdIn = 0, holdOut = 0, ease: easeName = 'cubicInOut' } = {}) {
  integer(frames, 'scope.frames', { min: 1 });
  integer(holdIn, 'scope.holdIn', { min: 0 });
  integer(holdOut, 'scope.holdOut', { min: 0 });
  if (holdIn + holdOut > frames - 1) throw new Error('motion-camera: holdIn + holdOut must leave at least one active frame');
  const local = clamp(Math.round(finite(localFrame, 'localFrame')), 0, frames - 1);
  const active = frames - 1 - holdIn - holdOut;
  const t = active <= 0 ? 1 : clamp((local - holdIn) / active, 0, 1);
  return ease(easeName, t);
}

/** `MO.anim`: eased progress of the window [start, start + dur] at time `t`. */
export function anim(t, start, dur, easeName = 'smooth') {
  return ease(easeName, window01(finite(t, 'time'), finite(start, 'start'), positive(dur, 'dur')));
}

/**
 * Staggered (lagged) start: with `n` items laid out over a total of
 * `1 + (n - 1) * ratio` progress units, the local progress of item `i` at global
 * progress `p` (upstream `MO.lagged`). Item i occupies [i*ratio, i*ratio + 1].
 */
export function lagged(i, n, p, ratio = 0.05) {
  integer(n, 'lagged.n', { min: 1 });
  integer(i, 'lagged.i', { min: 0 });
  if (i >= n) throw new Error('motion-camera: lagged.i must be < lagged.n');
  if (!(ratio >= 0)) throw new Error('motion-camera: lagged.ratio must be >= 0');
  return clamp(finite(p, 'lagged.p') * (1 + (n - 1) * ratio) - i * ratio);
}

/** Binary-search inverse of a monotonic easing: the `t` where `ease(t) === y`. */
export function invert(easeName, y, iters = 30) {
  const fn = typeof easeName === 'function' ? easeName : EASINGS[easeName];
  if (typeof fn !== 'function') throw new Error(`motion-camera: unknown easing "${easeName}"`);
  let a = 0;
  let b = 1;
  for (let i = 0; i < iters; i++) {
    const m = (a + b) / 2;
    if (fn(m) < y) a = m;
    else b = m;
  }
  return (a + b) / 2;
}

/** Beats -> seconds (upstream `MO.beat`). */
export const beat = (n, bpm = 120) => (finite(n, 'beat.n') * 60) / positive(bpm, 'beat.bpm');

/** The segment start that puts `revealP` of a transition of length `trDur` on `barTime`. */
export const onBeat = (barTime, revealP, trDur) => finite(barTime, 'barTime') - revealP * finite(trDur, 'trDur');

// ---------------------------------------------------------------------------
// Springs and sustained motion (motion.js)
// ---------------------------------------------------------------------------

/**
 * A damped spring step 0 -> 1 (may overshoot > 1), parameterised like SwiftUI:
 * `duration` is the settle time, `bounce` the overshoot fraction (0 = critically
 * damped), `v0` an initial velocity. `t` is in seconds.
 */
export function spring(t, { duration = 0.5, bounce = 0, v0 = 0 } = {}) {
  positive(duration, 'spring.duration');
  finite(bounce, 'spring.bounce');
  finite(v0, 'spring.v0');
  if (t <= 0) return 0;
  const w = TAU / duration;
  const z = 1 - bounce;
  let x; // remaining displacement (1 -> 0)
  if (Math.abs(z - 1) < 1e-4) x = Math.exp(-w * t) * (1 + (w - v0) * t);
  else if (z < 1) {
    const wd = w * Math.sqrt(1 - z * z);
    x = Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w - v0) / wd) * Math.sin(wd * t));
  } else {
    const r = Math.sqrt(z * z - 1);
    const a = -w * (z - r);
    const b = -w * (z + r);
    const A = (-v0 - b) / (a - b);
    x = A * Math.exp(a * t) + (1 - A) * Math.exp(b * t);
  }
  return 1 - x;
}

/**
 * Under-damped spring step response by frequency/decay (upstream `MO.springHz`):
 * `freq` Hz, `decay` 1/s. Small overshoots for "landing" accents — freq 3/decay 6
 * slams in (~37%), 2.5/9 is a normal pop (~16%), 2.2/10 a soft settle (~8%).
 */
export const springHz = (t, freq = 2.5, decay = 9) =>
  t <= 0 ? 0 : 1 - Math.exp(-decay * t) * Math.cos(TAU * freq * t);

/** Post-contact ring-down after the action lands (body squash, screen shake). */
export const settle = (t, amp, freq = 3, decay = 5) =>
  t <= 0 ? 0 : (amp * Math.sin(TAU * freq * t)) / Math.exp(decay * t);

/**
 * Sustained float: a two-frequency sine sum. Periods deliberately avoid ~5 s
 * (a slow ~0.2 Hz sway is uncomfortable), matching the HIG guidance upstream.
 */
export const float = (t, amp = 6, period = 4, phase = 0) =>
  amp *
  (0.75 * Math.sin(TAU * t / period + phase) + 0.25 * Math.sin(TAU * t / (period * 0.53) + phase * 1.7));

// ---------------------------------------------------------------------------
// Seeded randomness (util.js) — the ONLY source of variation this module allows.
// ---------------------------------------------------------------------------

/** mulberry32: a small, fast, deterministic PRNG in [0,1) keyed by an integer seed. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stateless hash in [0,1) keyed by (i, j) — for cached, per-index placement. */
export function hash01(i, j = 0) {
  let h = (i * 374761393 + j * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------
// Camera model (camera.js) — de-fixed to a parameterised stage size, no globals.
//
// A camera is `{ x, y, z, r }` in WORLD units (the reference `stage` frame).
// World -> screen is: scale by (fitScale * z), rotate by r, then centre on the
// output. `fit` decides how a `stage`-sized world frame fills a differently
// sized output (`cover` crops, `contain` letterboxes).
// ---------------------------------------------------------------------------

function stageSize(stage) {
  if (!stage || typeof stage !== 'object') throw new Error('motion-camera: stage must be { width, height }');
  return { width: positive(stage.width, 'stage.width'), height: positive(stage.height, 'stage.height') };
}

function outSize(size, stage) {
  if (size === undefined || size === null) return stage;
  return { width: positive(size.width, 'size.width'), height: positive(size.height, 'size.height') };
}

function fitKind(fit) {
  if (fit !== 'cover' && fit !== 'contain') throw new Error('motion-camera: fit must be "cover" or "contain"');
  return fit;
}

/** The scalar that maps one world unit to output pixels at z = 1. */
export function fitScale(stage, size, fit = 'cover') {
  const s = stageSize(stage);
  const o = outSize(size, s);
  const sx = o.width / s.width;
  const sy = o.height / s.height;
  return fitKind(fit) === 'contain' ? Math.min(sx, sy) : Math.max(sx, sy);
}

/** Log-space zoom interpolation: equal eased steps give equal perceived magnification. */
export const zlerp = (z0, z1, e) => {
  positive(z0, 'z0');
  positive(z1, 'z1');
  return e <= 0 ? z0 : e >= 1 ? z1 : z0 * Math.pow(z1 / z0, clamp(e));
};

/**
 * The minimum zoom for an opening of world radius `radius` centred at
 * (cx, cy) to fill the whole output by the end of a transition.
 */
export function coverZoom(radius, size, stage, fit = 'cover', cx, cy) {
  const s = stageSize(stage);
  const o = outSize(size, s);
  const k = fitScale(s, o, fit);
  const halfW = o.width / 2 / k;
  const halfH = o.height / 2 / k;
  return Math.hypot(halfW, halfH) / positive(radius, 'coverZoom.radius');
}

/** The camera that puts world point (wx, wy) at screen pixels (sx, sy) at zoom z. */
export function anchorCamera(world, z, r, screenFrac, size, stage, fit = 'cover') {
  const s = stageSize(stage);
  const o = outSize(size, s);
  const k = fitScale(s, o, fit) * positive(z, 'z');
  let dx = screenFrac.x * o.width - o.width / 2;
  let dy = screenFrac.y * o.height - o.height / 2;
  if (r) {
    const cs = Math.cos(-r);
    const sn = Math.sin(-r);
    [dx, dy] = [dx * cs - dy * sn, dx * sn + dy * cs];
  }
  return { x: world.x - dx / k, y: world.y - dy / k, z, r: r || 0 };
}

/** World -> output pixels for a camera sample. */
export function camToScreen(cam, world, size, stage, fit = 'cover') {
  const s = stageSize(stage);
  const o = outSize(size, s);
  const k = fitScale(s, o, fit) * (cam.z ?? 1);
  let dx = (world.x - cam.x) * k;
  let dy = (world.y - cam.y) * k;
  const r = cam.r || 0;
  if (r) {
    const cs = Math.cos(r);
    const sn = Math.sin(r);
    [dx, dy] = [dx * cs - dy * sn, dx * sn + dy * cs];
  }
  return { x: o.width / 2 + dx, y: o.height / 2 + dy };
}

/** Output pixels -> world point for a camera sample (inverse of `camToScreen`). */
export function camToWorld(cam, screen, size, stage, fit = 'cover') {
  const s = stageSize(stage);
  const o = outSize(size, s);
  const k = fitScale(s, o, fit) * (cam.z ?? 1);
  let dx = screen.x - o.width / 2;
  let dy = screen.y - o.height / 2;
  const r = cam.r || 0;
  if (r) {
    const cs = Math.cos(-r);
    const sn = Math.sin(-r);
    [dx, dy] = [dx * cs - dy * sn, dx * sn + dy * cs];
  }
  return { x: cam.x + dx / k, y: cam.y + dy / k };
}

/**
 * A parallax camera for a depth plane: `depth` 1 is the subject plane, < 1 is
 * farther (moves less, scales as z^depth), > 1 is nearer. Drawing a layer through
 * this camera gives depth without a second world.
 */
export function parallaxCamera(cam, depth, stage) {
  const s = stageSize(stage);
  return {
    x: lerp(s.width / 2, cam.x, depth),
    y: lerp(s.height / 2, cam.y, depth),
    z: Math.pow(cam.z ?? 1, depth),
    r: cam.r || 0,
  };
}

/** Sample a keyframe TRACK (camera.js `CAM.at`) at an integer frame. */
export function keyframeAt(keys, frame) {
  if (!Array.isArray(keys) || keys.length === 0) throw new Error('motion-camera: keys must be a non-empty array');
  const f = finite(frame, 'frame');
  const first = keys[0];
  if (f <= first.frame) return { x: first.x, y: first.y, z: first.z, r: first.r ?? 0, v: 0 };
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    if (f <= b.frame) {
      const e = ease(b.ease ?? 'cubicInOut', seg(f, a.frame, b.frame));
      return {
        x: lerp(a.x, b.x, e),
        y: lerp(a.y, b.y, e),
        z: zlerp(a.z, b.z, e),
        r: lerp(a.r ?? 0, b.r ?? 0, e),
        v: e,
      };
    }
  }
  const last = keys[keys.length - 1];
  return { x: last.x, y: last.y, z: last.z, r: last.r ?? 0, v: 1 };
}

/** Decide the camera at a world point (camera.js `CAM.pushTo`). */
export function pushToCamera(base, world, Z, e, k, to, size, stage, fit = 'cover') {
  const s = stageSize(stage);
  const o = outSize(size, s);
  const s0 = camToScreen(base, world, o, s, fit);
  const z = zlerp(base.z ?? 1, Z, clamp(finite(e, 'e')));
  const t = k === undefined ? clamp(finite(e, 'e')) : clamp(finite(k, 'k'));
  const target = to ?? { x: o.width / 2, y: o.height / 2 };
  return anchorCamera(
    world,
    z,
    base.r || 0,
    { x: lerp(s0.x, target.x, t) / o.width, y: lerp(s0.y, target.y, t) / o.height },
    o,
    s,
    fit,
  );
}

/** Screen-space camera velocity in px/frame straight from the sampler (for blur). */
export function cameraVelocity(atFn, frame, fps = 24) {
  positive(fps, 'fps');
  const a = atFn(frame);
  const b = atFn(frame - 1);
  const z = a.z ?? 1;
  return { vx: (a.x - b.x) * z, vy: (a.y - b.y) * z };
}

/** Offsets along a velocity vector for a simple directional motion blur. */
export function blurOffsets(vx, vy, taps = 7) {
  integer(taps, 'taps', { min: 2 });
  const offsets = [];
  for (let i = 0; i < taps; i++) {
    const q = i / (taps - 1) - 0.5;
    offsets.push({ x: -vx * q, y: -vy * q, alpha: i === 0 ? 1 : 1 / (i + 1) });
  }
  return offsets;
}

/** Handheld micro-drift, two incommensurate sines; returns a world-px offset. */
export function cameraDrift(t, { amp = 6, seed = 0 } = {}) {
  finite(seed, 'drift.seed');
  return {
    x: amp * Math.sin(t * 0.9 + seed) + amp * 0.4 * Math.sin(t * 2.3 + seed * 2),
    y: amp * 0.7 * Math.sin(t * 1.1 + seed * 3),
  };
}

// ---------------------------------------------------------------------------
// createCamera — the pure per-frame sampler.
// ---------------------------------------------------------------------------

function normalizeKeys(keys, stage) {
  if (keys === undefined) return [{ frame: 0, x: stage.width / 2, y: stage.height / 2, z: 1, r: 0 }];
  if (!Array.isArray(keys) || keys.length === 0) throw new Error('motion-camera: keys must be a non-empty array');
  let prevFrame = -Infinity;
  return keys.map((key, i) => {
    const frame = integer(key.frame, `keys[${i}].frame`, { min: 0 });
    if (frame < prevFrame) throw new Error('motion-camera: keys must be sorted by ascending frame');
    prevFrame = frame;
    return {
      frame,
      x: finite(key.x ?? stage.width / 2, `keys[${i}].x`),
      y: finite(key.y ?? stage.height / 2, `keys[${i}].y`),
      z: positive(key.z ?? 1, `keys[${i}].z`),
      r: finite(key.r ?? 0, `keys[${i}].r`),
      ease: key.ease,
    };
  });
}

function normalizeAim(aim) {
  if (aim === undefined || aim === null) return null;
  if (typeof aim !== 'object') throw new Error('motion-camera: aim must be { world, screen }');
  if (!aim.world || !aim.screen) throw new Error('motion-camera: aim needs { world, screen }');
  const screen = { x: finite(aim.screen.x, 'aim.screen.x'), y: finite(aim.screen.y, 'aim.screen.y') };
  if (screen.x < 0 || screen.x > 1 || screen.y < 0 || screen.y > 1) {
    throw new Error('motion-camera: aim.screen must be within [0, 1] on both axes');
  }
  return { world: { x: finite(aim.world.x, 'aim.world.x'), y: finite(aim.world.y, 'aim.world.y') }, screen };
}

function normalizeBounds(bounds) {
  if (bounds === undefined || bounds === null) return null;
  const b = {
    minX: finite(bounds.minX, 'bounds.minX'),
    minY: finite(bounds.minY, 'bounds.minY'),
    maxX: finite(bounds.maxX, 'bounds.maxX'),
    maxY: finite(bounds.maxY, 'bounds.maxY'),
  };
  if (b.minX > b.maxX) throw new Error('motion-camera: bounds.minX must be <= bounds.maxX');
  if (b.minY > b.maxY) throw new Error('motion-camera: bounds.minY must be <= bounds.maxY');
  return b;
}

/**
 * Build a camera planner. The returned object is STATELESS: `at(frame, size)` is
 * a pure function of the frame and the output size, so frames may be sampled in
 * any order with identical results.
 *
 * spec:
 *   stage      { width, height }  reference WORLD frame (required)
 *   fit        'cover' | 'contain' how the stage fills a differently sized output
 *   keys       [{ frame, x, y, z, r, ease }]  keyframe track in local frames
 *              (default: a single static camera at the stage centre, z = 1)
 *   aim        { world:{x,y}, screen:{x,y} }  hold a world point on a screen fraction
 *   drift      { amp, seed }      handheld micro-drift (world px), time-based
 *   bounds     { minX,minY,maxX,maxY }  clamp the resolved centre
 *   startFrame integer            offset of frame 0 on the composition clock
 *   frames     integer            scope length (local frames 0..frames-1)
 *   fps        integer            clock rate for drift/velocity (default 24)
 */
export function createCamera(spec = {}) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('motion-camera: spec must be an object');
  const stage = stageSize(spec.stage);
  const fit = fitKind(spec.fit ?? 'cover');
  const frames = integer(spec.frames ?? 1, 'frames', { min: 1 });
  const startFrame = integer(spec.startFrame ?? 0, 'startFrame', { min: 0 });
  const fps = positive(spec.fps ?? 24, 'fps');
  const keys = normalizeKeys(spec.keys, stage);
  const aim = normalizeAim(spec.aim);
  const bounds = normalizeBounds(spec.bounds);
  const drift = spec.drift === undefined || spec.drift === null ? null : { amp: finite(spec.drift.amp ?? 6, 'drift.amp'), seed: finite(spec.drift.seed ?? 0, 'drift.seed') };

  const at = (frame, size) => {
    const o = outSize(size, stage);
    const local = clamp(Math.round(finite(frame, 'frame')), 0, frames - 1);
    const keyed = keyframeAt(keys, local);
    let x = keyed.x;
    let y = keyed.y;
    const z = keyed.z;
    const r = keyed.r;
    let aimed = false;
    if (aim) {
      const a = anchorCamera(aim.world, z, r, aim.screen, o, stage, fit);
      x = a.x;
      y = a.y;
      aimed = true;
    }
    let driftX = 0;
    let driftY = 0;
    if (drift) {
      const d = cameraDrift(local / fps, drift);
      driftX = d.x;
      driftY = d.y;
      x += driftX;
      y += driftY;
    }
    let clamped = false;
    if (bounds) {
      const cx = clamp(x, bounds.minX, bounds.maxX);
      const cy = clamp(y, bounds.minY, bounds.maxY);
      clamped = cx !== x || cy !== y;
      x = cx;
      y = cy;
    }
    return {
      frame: local,
      globalFrame: startFrame + local,
      x,
      y,
      z,
      r,
      t: keyed.v,
      keyed,
      aimed,
      clamped,
      drift: { x: driftX, y: driftY },
      stage: { ...stage },
      size: { ...o },
      fit,
    };
  };

  return {
    frames,
    startFrame,
    stage: { ...stage },
    fit,
    keys,
    at,
    toScreen: (world, sample, size) => camToScreen(sample, world, size ?? sample.size, stage, fit),
    toWorld: (screen, sample, size) => camToWorld(sample, screen, size ?? sample.size, stage, fit),
    visibleWorldBounds: (sample, size) => {
      const o = outSize(size, sample.size);
      const k = fitScale(stage, o, fit) * sample.z;
      const halfW = o.width / 2 / k;
      const halfH = o.height / 2 / k;
      return {
        minX: sample.x - halfW,
        minY: sample.y - halfH,
        maxX: sample.x + halfW,
        maxY: sample.y + halfH,
        width: halfW * 2,
        height: halfH * 2,
      };
    },
    velocity: (frame, size) => cameraVelocity((f) => at(f, size), frame, fps),
    coverZoom: (radius, size, cx, cy) => coverZoom(radius, size ?? stage, stage, fit, cx, cy),
    parallax: (sample, depth) => parallaxCamera(sample, depth, stage),
  };
}
