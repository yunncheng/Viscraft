// rubber-hose.mjs — a complete 1930s rubber-hose acting beat.
//
// One reusable author module. Two content variants:
//
//   spoon-stir   The diner mug and the sugar cube hand a spoon across the
//                counter; the mug stirs its own coffee, tastes it, and the
//                steam turns into a heart while both hold the result.
//   stair-clock  The sugar cube climbs a staircase of plates (each landing
//                presses a plate), reaches the shelf, and the alarm clock
//                wakes up and rings at it.
//
// The look is the mechanism, not a filter: equal-width noodle limbs, pie eyes,
// four-finger gloves, big shoes, flat fills with one hard shadow band, a
// screen-space ink outline that stays constant at any scale, three boil
// drawings cycling at 12 fps, every prop breathing on the beat, and a 4:3 film
// gate with weave, flicker, scratches and vignette on the 24 fps camera clock.
//
// Adapted from LemoLab's lemo-opuscar `styles/rubber-hose/demo/` (toon.js,
// chars.js, film.js, cast.js, bg.js, and core/lib.js helpers), commit
// e3cb16f6, MIT. The scene, staging, spoon, clock business and both timelines
// are new for Viscraft. No font, voice, music, sample or title card is included.
//
// Provenance: see rights.mjs and LICENSES.md beside this file.

import { TAU, clamp, lerp, seg, ss, eio, spring, hash, vnoise, mulberry, track, rect, createToon } from './rubber-hose-toon.mjs';
import {
  P,
  mug,
  cube,
  clock,
  plate,
  spoon,
  spoonBowl,
  hangingLadle,
  mugGripGloves,
  cubeGripGloves,
  mugShoulder,
  cubeShoulder,
  mugCoffeeAperture,
  armHandLocal,
} from './rubber-hose-actors.mjs';

export const VARIANTS = ['spoon-stir', 'stair-clock'];

export const DEFAULT_PARAMS = {
  variant: 'spoon-stir',
  bpm: 120,
  boilAmp: 1.2,
  inkWeight: 6,
  pushIn: 0.035,
  damage: 1,
  duration: 8,
};

const DESIGN_W = 1920;
const DESIGN_H = 1080;
/** The action was authored on 192 frames at 24 fps; other durations remap onto it. */
const DESIGN_SECONDS = 8;
const DESIGN_FRAMES = 192;
/** Characters and line boil are sampled at 12 Hz from the real capture clock. */
const POSE_HZ = 12;
const GATE = { x: 240, y: 0, w: 1440, h: 1080, r: 28 };

const MUG_X = 720;
const MUG_Y = 880;
const CUBE_X = 1120;
const CUBE_Y = 880;
const CUBE_K = 1.35;

// Plate stair (surface y), used by the variant and painted into its set.
export const PLATE_STEPS = [
  { x: 520, y: 900 },
  { x: 640, y: 810 },
  { x: 760, y: 720 },
  { x: 880, y: 630 },
  { x: 1000, y: 540 },
  { x: 1120, y: 450 },
];
const CLOCK = { x: 1440, y: 520 };

// Spoon keyframes: grip origin, angle. The bowl is at origin − 100*(cos, sin).
// The two keys at 86 and 112 hold the stir entry/exit; two full circles run
// between them, so both ends meet the circular path exactly.
const SPOON_KEYS = [
  [0, { x: 1015, y: 866, a: 0 }],
  [28, { x: 1015, y: 866, a: 0 }],
  [40, { x: 1022, y: 830, a: 0.34 }],
  [56, { x: 966, y: 772, a: 0.75 }],
  [64, { x: 936, y: 754, a: 0.92 }],
  [76, { x: 878, y: 750, a: 1.02 }],
  [84, { x: 840, y: 718, a: 1.16 }],
  [86, { x: 841, y: 712, a: 1.16 }],
  [112, { x: 841, y: 712, a: 1.16 }],
  [118, { x: 843, y: 820, a: 0.44 }],
  [124, { x: 845, y: 818, a: 0.96 }],
  [132, { x: 872, y: 810, a: 1.32 }],
  [146, { x: 878, y: 806, a: 1.5 }],
  [192, { x: 878, y: 806, a: 1.5 }],
];

/** Two stir circles inside the cup: 86..112 is exactly two 13-frame cycles. */
const STIR = { from: 86, to: 112, period: 13, cx: 832, cy: 712, rx: 9, ry: 7, a: 1.16, fade: 5 };
/** The spoon crosses the mug wall at the dip, before the stir itself starts. */
const IN_CUP = { from: 74, to: STIR.to };

export function boilDrawing(time) {
  return Math.floor(time * 12 + 1e-6) % 3;
}

export function beatAt(time, bpm = 120) {
  return time / (60 / bpm);
}

/** Spoon pose in design coordinates, as a pure function of the frame time. */
export function spoonPose(t) {
  const base = track(SPOON_KEYS, t);
  const u = seg(t, STIR.from, STIR.to);
  if (u <= 0 || u >= 1) return base;
  const phase = (t - STIR.from) * (TAU / STIR.period);
  const circle = {
    x: STIR.cx + Math.cos(phase) * STIR.rx,
    y: STIR.cy + Math.sin(phase) * STIR.ry,
    a: STIR.a + Math.sin(phase) * 0.1,
  };
  // Ease the circular motion in and out of the held key so the loop has no
  // branch cut at either end while the stir itself stays at full amplitude.
  const w = ss(seg(t, STIR.from, STIR.from + STIR.fade)) * (1 - ss(seg(t, STIR.to - STIR.fade, STIR.to)));
  if (w <= 0) return base;
  return { x: lerp(base.x, circle.x, w), y: lerp(base.y, circle.y, w), a: lerp(base.a, circle.a, w) };
}

/** Climb pose for the sugar cube, as a pure function of the frame time. */
export function climbPose(t) {
  const last = PLATE_STEPS[PLATE_STEPS.length - 1];
  if (t <= 24)
    return { i: 0, x: PLATE_STEPS[0].x, feet: PLATE_STEPS[0].y - 12, air: 0, squash: 1, lean: 0, tuck: 0 };
  const k = clamp((t - 24) / 24, 0, 5);
  if (k >= 5) return { i: 5, x: last.x, feet: last.y - 12, air: 0, squash: 1, lean: 0, tuck: 0 };
  const i = Math.floor(k);
  const u = k - i;
  const a = PLATE_STEPS[i];
  const b = PLATE_STEPS[i + 1];
  const v = clamp((u - 0.18) / 0.82);
  const air = Math.sin(Math.PI * v) * 92;
  let squash = 1;
  if (u < 0.18) squash = 1 - 0.14 * ss(u / 0.18);
  else if (u < 0.32) squash = 1.12;
  else if (u > 0.86) squash = 1 - 0.16 * Math.cos(((u - 0.86) / 0.14) * Math.PI * 0.5);
  return {
    i,
    x: lerp(a.x, b.x, eio(v)),
    feet: lerp(a.y - 12, b.y - 12, eio(v)) - air,
    air,
    squash,
    lean: 0.05 * Math.sin(Math.PI * v),
    tuck: v > 0.1 && v < 0.9 ? Math.sin(Math.PI * v) : 0,
  };
}

/** Validate and fill the Source params. Unknown keys are ignored by design. */
export function normalizeParams(raw = {}) {
  const variant = raw.variant ?? DEFAULT_PARAMS.variant;
  if (!VARIANTS.includes(variant)) throw new Error(`rubber-hose: "variant" must be one of ${VARIANTS.join(', ')}`);
  const num = (key, min, max) => {
    const v = raw[key] ?? DEFAULT_PARAMS[key];
    if (!Number.isFinite(v) || v < min || v > max)
      throw new Error(`rubber-hose: "${key}" must be a number in [${min}, ${max}]`);
    return v;
  };
  const duration = raw.duration ?? DEFAULT_PARAMS.duration;
  if (!Number.isFinite(duration) || duration <= 0)
    throw new Error('rubber-hose: "duration" must be a positive number of seconds');
  return {
    variant,
    bpm: num('bpm', 60, 240),
    boilAmp: num('boilAmp', 0, 4),
    inkWeight: num('inkWeight', 3, 12),
    pushIn: num('pushIn', 0, 0.12),
    damage: num('damage', 0, 2),
    duration,
  };
}

// ———————————————————— painted sets ————————————————————

const BG_PS = 1.25;
const bgCache = new Map();

function bgRect(T, x, y, w, h, col) {
  const [a, b] = T.tx(x, y);
  const z = T.zoom();
  const g = T.g;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = col;
  g.fillRect(a, b, w * z, h * z);
}

function paperGrain(T, w, h, seed = 3) {
  const rnd = mulberry(seed);
  const g = T.g;
  g.setTransform(1, 0, 0, 1, 0, 0);
  const z = T.zoom();
  for (let i = 0; i < (w * h) / 900; i++) {
    g.fillStyle = rnd() > 0.5 ? 'rgba(20,18,15,.06)' : 'rgba(255,255,250,.05)';
    g.fillRect(rnd() * w * z, rnd() * h * z, 1 + rnd() * 2, 1 + rnd() * 2);
  }
}

/** One flat wash: base + soft blotches + edge darkening + a thin grey line. */
function wash(T, pts, col, o = {}) {
  const g = T.g;
  const path = T.shape(pts, { fill: col, stroke: false, boil: 0 });
  const rnd = mulberry(o.seed ?? 7);
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clip(path);
  const bb = pts.map((p) => T.tx(p[0], p[1]));
  const xs = bb.map((p) => p[0]),
    ys = bb.map((p) => p[1]);
  const x0 = Math.min(...xs),
    x1 = Math.max(...xs),
    y0 = Math.min(...ys),
    y1 = Math.max(...ys);
  const n = Math.min(110, Math.max(8, Math.floor(((x1 - x0) * (y1 - y0)) / 9000) | 0));
  g.filter = 'blur(10px)';
  for (let i = 0; i < n; i++) {
    const r = 20 + rnd() * 90;
    g.fillStyle =
      rnd() > 0.5 ? `rgba(30,28,25,${0.03 + rnd() * 0.05})` : `rgba(255,253,245,${0.03 + rnd() * 0.05})`;
    g.beginPath();
    g.ellipse(x0 + rnd() * (x1 - x0), y0 + rnd() * (y1 - y0), r, r * (0.5 + rnd() * 0.6), rnd() * 3, 0, TAU);
    g.fill();
  }
  if ((o.edge ?? 0.16) > 0) {
    g.filter = 'blur(7px)';
    g.strokeStyle = `rgba(20,18,16,${o.edge ?? 0.16})`;
    g.lineWidth = 26;
    g.stroke(path);
  }
  g.filter = 'none';
  g.restore();
  if (o.line !== false) T.outline(path, o.lw ?? 3.2, o.lineCol ?? '#2A2927');
  return path;
}

function makeBackground(T, kind, seed) {
  T.setBase([BG_PS, 0, 0, BG_PS, 0, 0]);
  T.setLwScale(BG_PS);
  T.frame(0, { amp: 0 });
  T.g.setTransform(1, 0, 0, 1, 0, 0);
  T.g.fillStyle = P.paper;
  T.g.fillRect(0, 0, DESIGN_W * BG_PS, DESIGN_H * BG_PS);
  if (kind === 'pantry') paintPantry(T);
  else paintKitchen(T);
  paperGrain(T, DESIGN_W, DESIGN_H, seed + 3);
  T.g.setTransform(1, 0, 0, 1, 0, 0);
  T.setBase([1, 0, 0, 1, 0, 0]);
  T.setLwScale(1);
}

function paintKitchen(T) {
  // ceiling and wall
  wash(T, rect(0, 0, DESIGN_W, 74), '#3E3D3A', { seed: 21, edge: 0 });
  wash(T, rect(0, 62, DESIGN_W, 18), '#5A5853', { seed: 22 });
  wash(T, rect(0, 80, DESIGN_W, 520), '#8C8981', { seed: 1, line: false, edge: 0 });
  for (let x = 6; x < DESIGN_W; x += 64) bgRect(T, x, 80, 22, 520, 'rgba(255,253,245,.07)');
  for (let x = 38; x < DESIGN_W; x += 128)
    for (let y = 120; y < 560; y += 96) {
      const [a, b] = T.tx(x, y);
      const z = T.zoom();
      T.g.setTransform(1, 0, 0, 1, 0, 0);
      T.g.fillStyle = 'rgba(30,28,24,.2)';
      T.g.beginPath();
      T.g.moveTo(a, b - 8 * z);
      T.g.lineTo(a + 6 * z, b);
      T.g.lineTo(a, b + 8 * z);
      T.g.lineTo(a - 6 * z, b);
      T.g.fill();
    }

  // hanging lamp
  T.stroke([[960, 80], [960, 214]], 3.4, { line: '#2A2927' });
  wash(T, T.arc(960, 214, 78, 20, Math.PI, TAU, 18), '#5E5C57', { seed: 23 });
  T.shape(T.rect(930, 214, 60, 12), { fill: '#4A4844', lw: 2.6 });

  // shelf, jars and a framed still life on the wall
  for (const [sx, n] of [
    [250, 4],
    [1320, 4],
  ]) {
    wash(T, rect(sx, 404, 420, 22), '#4A4844', { seed: sx });
    for (let i = 0; i < n; i++) {
      const w = 66 + (i % 2) * 16,
        h = 96 + ((i * 37) % 62);
      wash(T, T.rr(sx + 30 + i * 96, 404 - h, w, h, 14), i === 1 ? '#8E8B83' : '#B3B0A8', {
        seed: sx + i * 7,
        edge: 0.1,
      });
      wash(T, T.rr(sx + 26 + i * 96, 404 - h - 14, w + 8, 18, 6), '#4A4844', { seed: sx + i * 3, edge: 0.1 });
    }
  }
  wash(T, T.rr(770, 200, 176, 216, 8), '#5E5C57', { seed: 24 });
  wash(T, T.rr(790, 220, 136, 176, 4), '#A9A69E', { seed: 25, edge: 0.1 });
  wash(
    T,
    T.spline(
      [
        [823, 350],
        [818, 310],
        [853, 288],
        [888, 310],
        [884, 350],
      ],
      true,
      5,
    ),
    '#6E6B64',
    { seed: 26, edge: 0 },
  );

  // tiled splashback
  wash(T, rect(0, 600, DESIGN_W, 278), '#A29F97', { line: false, seed: 2, edge: 0.08 });
  for (let y = 600; y < 878; y += 52) T.stroke([[0, y], [DESIGN_W, y]], 2.2, { line: 'rgba(40,38,34,.4)', boil: 0 });
  for (let x = 0; x < DESIGN_W; x += 52) T.stroke([[x, 600], [x, 878]], 2.2, { line: 'rgba(40,38,34,.4)', boil: 0 });
  wash(T, rect(0, 592, DESIGN_W, 14), '#4A4844', { lw: 3, seed: 4 });

  // counter slab and cabinet front
  wash(T, rect(0, 878, DESIGN_W, 24), '#C4C1B8', { seed: 11, edge: 0.05 });
  wash(T, rect(0, 902, DESIGN_W, 38), '#3F3E3A', { seed: 12 });
  wash(T, rect(0, 940, DESIGN_W, 140), '#66635D', { seed: 13, line: false });
  for (let x = 30; x < DESIGN_W; x += 300) {
    wash(T, T.rr(x, 960, 270, 108, 10), '#726F68', { seed: x, edge: 0.14 });
    wash(T, T.rr(x + 22, 974, 226, 80, 8), '#7C7972', { seed: x + 1, edge: 0.1 });
    T.shape(T.ell(x + ((x / 300) % 2 ? 36 : 234), 1006, 11, 11), { fill: '#2A2927', lw: 2.4 });
  }
  wash(T, rect(0, 1044, DESIGN_W, 36), '#2E2D2A', { seed: 15 });
}

function paintPantry(T) {
  // cupboard interior
  wash(T, rect(0, 0, DESIGN_W, DESIGN_H), '#55534E', { seed: 31, line: false, edge: 0 });
  for (let x = 0; x < DESIGN_W; x += 120) bgRect(T, x, 0, 10, DESIGN_H, 'rgba(20,18,16,.22)');
  for (let x = 46; x < DESIGN_W; x += 120) bgRect(T, x, 0, 2, DESIGN_H, 'rgba(255,253,245,.05)');
  wash(T, rect(0, 0, DESIGN_W, 54), '#3E3D3A', { seed: 32, edge: 0 });
  wash(T, rect(0, 54, DESIGN_W, 16), '#6E6B64', { seed: 33 });
  wash(T, rect(0, 1038, DESIGN_W, 42), '#2E2D2A', { seed: 34 });

  // stepped wooden treads under the plate stair
  for (let i = 0; i < PLATE_STEPS.length; i++) {
    const p = PLATE_STEPS[i];
    const w = i === 0 ? 220 : 190;
    wash(T, rect(p.x - w / 2, p.y + 10, w, 26), '#4A4844', { seed: 40 + i, edge: 0.16 });
    bgRect(T, p.x - w / 2 + 4, p.y + 12, w - 8, 7, 'rgba(196,193,184,.28)');
    bgRect(T, p.x - w / 2, p.y + 36, w, 10, 'rgba(15,14,12,.38)');
    // side brackets down to the cabinet back
    for (const sx of [p.x - w / 2 + 10, p.x + w / 2 - 10]) {
      T.stroke([[sx, p.y + 46], [sx, p.y + 118]], 7, { line: '#3F3E3A', boil: 0 });
      T.stroke([[sx, p.y + 46], [sx + (sx < p.x ? 34 : -34), p.y + 86]], 5, { line: '#3F3E3A', boil: 0 });
    }
  }

  // the ledge the alarm clock stands on
  wash(T, rect(1330, 524, 220, 18), '#6E6B64', { seed: 51, edge: 0.16 });
  bgRect(T, 1330, 542, 220, 9, 'rgba(15,14,12,.4)');
  T.stroke([[1350, 550], [1350, 620]], 6, { line: '#3F3E3A', boil: 0 });
  T.stroke([[1530, 550], [1530, 620]], 6, { line: '#3F3E3A', boil: 0 });

  // shelf above the clock, a few tins, a hanging spoon
  wash(T, rect(1180, 250, 460, 16), '#6E6B64', { seed: 50 });
  for (let i = 0; i < 3; i++) {
    const h = 68 + i * 14;
    wash(T, T.rr(1215 + i * 96, 250 - h, 62, h, 10), '#8E8B83', { seed: 60 + i, edge: 0.12 });
    wash(T, T.rr(1211 + i * 96, 250 - h - 12, 70, 14, 5), '#3F3E3A', { seed: 66 + i, edge: 0.1 });
  }
  wash(T, rect(160, 132, 250, 16), '#6E6B64', { seed: 70 });
  for (let i = 0; i < 2; i++) {
    const h = 74 + i * 18;
    wash(T, T.rr(190 + i * 100, 132 - h, 66, h, 10), '#8E8B83', { seed: 72 + i, edge: 0.12 });
    wash(T, T.rr(186 + i * 100, 132 - h - 12, 74, 14, 5), '#3F3E3A', { seed: 75 + i, edge: 0.1 });
  }
  wash(T, rect(250, 332, 280, 14), '#6E6B64', { seed: 78 });
  T.stroke([[1360, 100], [1360, 128]], 3, { line: '#3F3E3A', boil: 0 });
}

function getBackground(kind, seed) {
  const key = `${kind}:${seed}`;
  if (bgCache.has(key)) return bgCache.get(key);
  const cv = document.createElement('canvas');
  cv.width = Math.round(DESIGN_W * BG_PS);
  cv.height = Math.round(DESIGN_H * BG_PS);
  const T = createToon(cv.getContext('2d'));
  makeBackground(T, kind, (kind === 'pantry' ? 91 : 7) + seed * 0.13);
  bgCache.set(key, cv);
  return cv;
}

// ———————————————————— film gate ————————————————————

/**
 * Camera push-in. The scene pre-divides its ink width by this same zoom, so the
 * bitmap scale below never thickens the drawn outline.
 */
function cameraZoom(time, duration, pushIn) {
  return 1 + pushIn * eio(clamp(time / Math.max(1e-6, duration)));
}

/**
 * Composite the design-space scene into the real canvas: 4:3 rounded gate,
 * gate weave, flicker, scratches, dust, one hair, a soft inner gate shadow and
 * a vignette. The camera push and pan run on real seconds while the characters
 * were sampled on the 12 Hz pose clock; the gate itself never moves.
 */
export function compositeFilm(g, scene, time, o) {
  const W = o.width,
    H = o.height;
  const s = Math.min(W / DESIGN_W, H / DESIGN_H);
  const ox = (W - DESIGN_W * s) / 2,
    oy = (H - DESIGN_H * s) / 2;
  const dmg = o.damage;
  const dur = Math.max(1e-6, o.duration || DESIGN_SECONDS);
  const f = Math.floor(time * 24 + 1e-6);
  const sd = (o.seed || 0) * 0.37;

  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.filter = 'none';
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);

  g.save();
  g.translate(ox, oy);
  g.scale(s, s);

  const { x, y, w, h, r } = GATE;
  const wx =
    ((vnoise(time * 1.3 + sd) - 0.5) * 2.4 + (hash(f * 7.1) > 0.985 ? (hash(f) - 0.5) * 5 : 0)) * dmg;
  const wy =
    ((vnoise(time * 1.1 + 40 + sd) - 0.5) * 2.6 + (hash(f * 3.3) > 0.985 ? (hash(f + 9) - 0.5) * 6 : 0)) * dmg;

  g.save();
  g.beginPath();
  g.roundRect(x + 0.5, y - 4, w - 1, h + 8, r);
  g.clip();

  const u = eio(clamp(time / dur));
  const z = cameraZoom(time, dur, o.pushIn);
  g.translate(wx, wy);
  g.translate(960 + (o.panX || 0) * u, 540 + (o.panY || 0) * u);
  g.scale(z, z);
  g.translate(-960, -540);
  g.filter = 'blur(0.55px) contrast(1.14)';
  g.drawImage(scene, 0, 0, DESIGN_W, DESIGN_H);
  g.filter = 'none';

  if (dmg > 0.001) {
    const fl = ((hash(f * 1.618 + sd) - 0.5) * 0.08 + (vnoise(time * 3) - 0.5) * 0.04) * dmg;
    if (fl > 0) {
      g.fillStyle = `rgba(255,252,240,${fl})`;
      g.fillRect(x, y, w, h);
    } else {
      g.fillStyle = `rgba(0,0,0,${-fl})`;
      g.fillRect(x, y, w, h);
    }
    const segI = Math.floor(time * 2.3);
    for (let i = 0; i < 3; i++) {
      if (hash(segI * 13.7 + i * 3.1) < 0.45) continue;
      const sx = x + hash(segI * 5.3 + i + sd) * w + Math.sin(time * 7 + i) * 6,
        light = hash(segI + i * 9) > 0.4;
      g.strokeStyle = light ? 'rgba(245,242,230,.5)' : 'rgba(10,10,8,.45)';
      g.lineWidth = 0.8 + hash(segI * 2 + i) * 1.4;
      g.beginPath();
      const y0 = hash(segI * 3 + i) * h * 0.5;
      g.moveTo(sx, y0);
      g.lineTo(sx + (hash(f + i) - 0.5) * 3, y0 + h * (0.4 + hash(segI + i * 5) * 0.6));
      g.stroke();
    }
    const nd = 3 + Math.floor(hash(f * 2.7) * 6);
    for (let i = 0; i < nd; i++) {
      const dx = x + hash(f * 11.1 + i * 1.7 + sd) * w,
        dy = y + hash(f * 17.3 + i * 2.9) * h,
        rr2 = 0.8 + hash(f + i * 4.4) * 2.8,
        dark = hash(f * 1.3 + i) > 0.35;
      g.fillStyle = dark ? 'rgba(12,11,10,.75)' : 'rgba(250,248,240,.7)';
      g.beginPath();
      g.ellipse(dx, dy, rr2 * (1 + hash(i + f) * 1.5), rr2, hash(i * 3 + f) * 3, 0, TAU);
      g.fill();
    }
    if (hash(Math.floor(time * 1.5) * 9.9) > 0.82) {
      const s0 = Math.floor(time * 1.5),
        hx = x + hash(s0 * 2.2) * w,
        hy = y + hash(s0 * 4.4) * h;
      g.strokeStyle = 'rgba(15,14,12,.6)';
      g.lineWidth = 1.3;
      g.beginPath();
      g.moveTo(hx, hy);
      for (let i = 1; i <= 8; i++) g.lineTo(hx + i * 7 + Math.sin(i * 1.3 + s0) * 8, hy + Math.sin(i * 0.9 + s0 * 2) * 10 + i * 3);
      g.stroke();
    }
  }

  const vg = g.createRadialGradient(960, 540, 380, 960, 540, 900);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(0.7, 'rgba(0,0,0,.18)');
  vg.addColorStop(1, 'rgba(0,0,0,.62)');
  g.fillStyle = vg;
  g.fillRect(x, y, w, h);

  g.strokeStyle = 'rgba(0,0,0,.55)';
  g.lineWidth = 14;
  g.filter = 'blur(6px)';
  g.beginPath();
  g.roundRect(x, y - 4, w, h + 8, r);
  g.stroke();
  g.filter = 'none';
  g.restore();
  g.restore();
}

// ———————————————————— staging ————————————————————

const clamp1 = (v) => clamp(v, -1, 1);

function contactShadow(T, x, y, w, h, a = 0.24) {
  T.shape(T.ell(x, y, w, h, 28), { fill: `rgba(18,16,14,${a})`, stroke: false, boil: 0 });
}

function sceneSpoonStir(T, f, p, seed) {
  // `f` is the design-frame time of the current 12 Hz pose drawing (the
  // authored timeline is 192 design frames = 8 s), so the steam, shake and
  // prop breathing hold for the same drawing as the pose.
  const t = f / 24;
  T.g.drawImage(getBackground('kitchen', seed), 0, 0, DESIGN_W, DESIGN_H);
  const beats = beatAt(t, p.bpm);
  const b = Math.sin(TAU * beats);

  // a living prop: the hanging ladle breathes and swings on the beat
  hangingLadle(T, 1500, 214, 1, Math.sin(TAU * beats + 0.6) * 0.035);

  contactShadow(T, MUG_X, MUG_Y + 3, 96, 13);
  contactShadow(T, CUBE_X, CUBE_Y + 2, 44, 8, 0.2);

  const sp = spoonPose(f);

  // ---- mug: reaches from its idle hand to the spoon grip, then holds it ----
  const holdFrom = 64;
  const reach = eio(seg(f, 44, 64));
  const idleHand = { x: 862, y: 736 };
  const holding = f >= holdFrom;
  const hand = holding
    ? { x: sp.x, y: sp.y }
    : { x: lerp(idleHand.x, sp.x, reach), y: lerp(idleHand.y, sp.y, reach) };

  let eyes = { lx: clamp1((sp.x - 736) / 240), ly: clamp1((sp.y - 708) / 240), lid: 0.12, type: 'open' };
  let mouthType = 'smile';
  let brows = null;
  let steamType = 'lazy';
  let blush = false;
  if (f < 18) eyes.lid = 0.24;
  if (f >= 52 && f < 66) {
    brows = 'up';
    mouthType = 'o';
  }
  if (f >= 80 && f < 112) {
    eyes.lx = 0.1;
    eyes.ly = 0.9;
    eyes.lid = 0.06;
  }
  if (f >= 112 && f < 120) {
    eyes = { type: 'shut' };
    mouthType = 'o';
    brows = 'up';
  }
  if (f >= 120 && f < 128) {
    eyes = { type: 'wide', lx: 0.2, ly: -0.1 };
    mouthType = 'open';
    brows = 'up';
    steamType = 'up';
  }
  if (f >= 128) {
    eyes = { type: 'happy' };
    mouthType = 'grin';
    steamType = 'heart';
    blush = true;
  }
  // two blinks in the hold
  if ((f >= 152 && f < 154.5) || (f >= 176 && f < 178.5)) eyes = { type: 'shut' };

  const stretch = f >= 128 && f < 144 ? 0.035 * Math.sin(((f - 128) / 16) * Math.PI) : 0;
  const mp = {
    x: MUG_X,
    y: MUG_Y - Math.max(0, stretch) * 40,
    k: 1,
    turn: f < 44 ? 10 : f < 70 ? 6 : 0,
    sx: 1 - b * 0.028,
    sy: 1 + b * 0.045 + stretch,
    lean: f < 70 ? -0.02 : 0,
    t,
    eyes,
    mouth: { type: mouthType, w: 66, open: mouthType === 'o' ? 0.9 : 0.6 },
    brows,
    blush,
    steam: steamType,
    steamX: -6,
    armL: { x: -148, y: -116, hand: 'open', bend: 18 },
    legL: { x: -38, y: 0, bend: 5 },
    legR: { x: 38, y: 0, bend: -5 },
  };
  // Aim the glove PALM, not the wrist, at the grip, through the live body
  // transform (translate, squash/stretch, lean).
  const mugWrist = armHandLocal(mp, mugShoulder(1), hand.x, hand.y, 0.95);
  mp.armR = {
    x: mugWrist.x,
    y: mugWrist.y,
    hand: 'grab',
    grip: f >= 44,
    front: true,
    bend: -16,
    hk: 0.95,
  };

  // From the dip until the stir ends the handle is behind the mug front wall
  // and only the bowl's intersection with the actual coffee surface is exposed.
  // Before the dip and during the taste the whole spoon is in front of the mug.
  const inCup = f >= IN_CUP.from && f < IN_CUP.to;
  const drawSpoon = () => spoon(T, { x: sp.x, y: sp.y, a: sp.a, k: 1 });
  if (inCup) {
    drawSpoon();
    mug(T, mp);
    const aperture = mugCoffeeAperture(mp).map(([x, y]) => T.tx(x, y));
    const clip = new Path2D();
    clip.moveTo(aperture[0][0], aperture[0][1]);
    for (let i = 1; i < aperture.length; i++) clip.lineTo(aperture[i][0], aperture[i][1]);
    clip.closePath();
    const g = T.g;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clip(clip);
    spoonBowl(T, { x: sp.x, y: sp.y, a: sp.a, k: 1 });
    g.restore();
  } else {
    mug(T, mp);
    drawSpoon();
  }

  // ---- sugar cube: offers the spoon, then watches and reacts ----
  const grab = eio(seg(f, 26, 40));
  const release = eio(seg(f, 70, 84));
  const cIdle = { x: 1062, y: 838 };
  // The cube grips a little further along the handle than the mug, so the two
  // gloves read as two hands during the hand-off instead of one blob.
  const cGrip = { x: sp.x - 22 * Math.cos(sp.a), y: sp.y - 22 * Math.sin(sp.a) };
  let cHand;
  if (f < 26) cHand = cIdle;
  else if (f < 70) cHand = { x: lerp(cIdle.x, cGrip.x, grab), y: lerp(cIdle.y, cGrip.y, grab) };
  else cHand = { x: lerp(cGrip.x, cIdle.x, release), y: lerp(cGrip.y, cIdle.y, release) };

  let cEyes = { lx: clamp1((sp.x - CUBE_X) / 260), ly: clamp1((sp.y - 790) / 200), lid: 0.08, type: 'open' };
  let cMouth = 'smile';
  let cBrows = null;
  if (f >= 40 && f < 56) {
    cMouth = 'grin';
    cBrows = 'up';
  }
  if (f >= 56 && f < 70) cMouth = 'smile';
  if (f >= 70 && f < 84) {
    cMouth = 'o';
    cEyes.ly = 0.2;
  }
  if (f >= 84 && f < 112) {
    cMouth = 'smile';
    cEyes.lid = 0.18;
  }
  if (f >= 112 && f < 124) {
    cEyes = { type: 'wide', lx: -0.5, ly: -0.2 };
    cMouth = 'o';
    cBrows = 'up';
  }
  if (f >= 124) {
    cEyes = { type: 'happy' };
    cMouth = 'grin';
  }
  // one hop of approval, landing with a squash
  const hopU = seg(f, 156, 172);
  const hop = hopU > 0 && hopU < 1 ? Math.sin(Math.PI * hopU) * 22 : 0;
  const land = f >= 172 ? Math.max(0, 1 - spring((f - 172) / 6, 9, 0.3)) : 0;
  const cp = {
    x: CUBE_X,
    y: CUBE_Y - hop,
    k: CUBE_K,
    turn: 8,
    sx: 1 + land * 0.1 - b * 0.03,
    sy: 1 - land * 0.14 + b * 0.05 + (hop > 1 ? 0.05 : 0),
    lean: f >= 84 && f < 112 ? -0.05 : 0,
    eyes: cEyes,
    mouth: { type: cMouth, w: 25, open: 0.65 },
    brows: cBrows,
    armL: null,
    armR: f >= 124 ? { x: 74, y: -132, hand: 'wave', bend: -16 } : { x: 56, y: -28, hand: 'open', bend: 10 },
    legL: { x: -15, y: 0, bend: 3 },
    legR: { x: 15, y: 0, bend: -3 },
  };
  const cubeWrist = armHandLocal(cp, cubeShoulder(cp, -1), cHand.x, cHand.y, 0.52);
  cp.armL = {
    x: cubeWrist.x,
    y: cubeWrist.y,
    hand: 'grab',
    grip: f >= 26 && f <= 70,
    bend: -6,
  };
  if (hopU > 0.15 && hopU < 0.85) {
    cp.legL = { x: -20, y: -14, bend: 12 };
    cp.legR = { x: 20, y: -14, bend: -12 };
  }
  cube(T, cp);

  mugGripGloves(T, mp);
  cubeGripGloves(T, cp);
}

function sceneStairClock(T, f, p, seed) {
  const t = f / 24;
  T.g.drawImage(getBackground('pantry', seed), 0, 0, DESIGN_W, DESIGN_H);
  const beats = beatAt(t, p.bpm);
  const b = Math.sin(TAU * beats);

  hangingLadle(T, 700, 30, 0.7, Math.sin(TAU * beats + 1.2) * 0.03);

  // plates: the stepped stair; a landing presses its plate
  for (let i = 0; i < PLATE_STEPS.length; i++) {
    const ps = PLATE_STEPS[i];
    let press = 0;
    if (i > 0) {
      const landT = 24 + (i - 1) * 24 + 20;
      const dt = f - landT;
      if (dt >= 0 && dt < 14) press = (1 - dt / 14) * Math.cos(dt * 0.55);
    }
    plate(T, ps.x, ps.y, 1.3, { press, rot: press * 0.01 });
  }

  // the alarm clock: sleepy until the cube arrives, then rings
  const ring = seg(f, 156, 166) * (1 - ss(seg(f, 182, 192)) * 0.75);
  let cEyes = { type: 'open', lx: -0.9, ly: 0.5, lid: 0.3 };
  let cMouth = 'smile';
  if (f >= 156) {
    cEyes = { type: 'wide', lx: -0.9, ly: 0.4 };
    cMouth = 'o';
  }
  if (f >= 180) {
    cEyes = { type: 'happy' };
    cMouth = 'grin';
  }
  clock(T, CLOCK.x, CLOCK.y, 1.15, b, { ring, t, eyes: cEyes.type, lx: cEyes.lx, ly: cEyes.ly, mouth: cMouth });

  const cp = climbPose(f);
  const onTop = f >= 144;
  const look = onTop ? { lx: 0.9, ly: -0.8 } : { lx: 0.5, ly: -0.3 };
  let eyes = { type: 'open', ...look, lid: 0.06 };
  let mouthType = 'smile';
  let brows = null;
  if (f >= 144 && f < 156) {
    mouthType = 'grin';
    brows = 'up';
  }
  if (f >= 156 && f < 176) {
    eyes = { type: 'wide', lx: -0.3, ly: -0.1 };
    mouthType = 'o';
    brows = 'up';
  }
  if (f >= 176) {
    eyes = { type: 'happy' };
    mouthType = 'grin';
  }

  // arms: swing with the hop, cover ears while the clock rings, then cheer
  let armL, armR;
  if (f >= 156 && f < 176) {
    armL = { x: -26, y: -104, hand: 'open', bend: 14 };
    armR = { x: 26, y: -104, hand: 'open', bend: -14 };
  } else if (onTop) {
    armL = { x: -52, y: -84 + Math.sin(TAU * beats) * 3, hand: 'open', bend: 10 };
    armR = { x: 62, y: -118 + Math.sin(TAU * beats + 1) * 3, hand: 'wave', bend: -14 };
  } else {
    const swing = Math.sin(Math.PI * clamp((f - 24) / 24, 0, 1));
    armL = { x: -34 - cp.tuck * 14, y: -70 - cp.tuck * 18, hand: 'open', bend: 16 };
    armR = { x: 34 + cp.tuck * 14, y: -70 - cp.tuck * 18, hand: 'open', bend: -16 };
    if (swing > 0.2) {
      armL.y -= 10;
      armR.y -= 10;
    }
  }

  const cp2 = {
    x: cp.x,
    y: cp.feet,
    k: CUBE_K,
    turn: 10,
    sx: 1 + (cp.squash - 1) * -0.6 + b * 0.02,
    sy: cp.squash + b * 0.04,
    lean: cp.lean,
    eyes,
    mouth: { type: mouthType, w: 25, open: 0.7 },
    brows,
    armL: { ...armL, bend: 12 },
    armR: { ...armR, bend: -12 },
    legL: { x: -15 - cp.tuck * 6, y: -cp.tuck * 20, bend: 3 },
    legR: { x: 15 + cp.tuck * 6, y: -cp.tuck * 20, bend: -3 },
  };
  contactShadow(T, cp.x, cp.feet + 2, cp.air > 4 ? 34 : 40, 7, cp.air > 4 ? 0.12 : 0.2);
  cube(T, cp2);
}

function drawScene(T, f, params, seed) {
  T.g.setTransform(1, 0, 0, 1, 0, 0);
  T.g.fillStyle = P.paper;
  T.g.fillRect(0, 0, DESIGN_W, DESIGN_H);
  T.S.lw = params.inkWeight;
  if (params.variant === 'stair-clock') sceneStairClock(T, f, params, seed);
  else sceneSpoonStir(T, f, params, seed);
}

// ———————————————————— public render ————————————————————

const RENDER_CACHE = new WeakMap();

function cacheFor(canvas) {
  let c = RENDER_CACHE.get(canvas);
  if (!c) {
    const scene = document.createElement('canvas');
    scene.width = DESIGN_W;
    scene.height = DESIGN_H;
    c = { scene, toon: createToon(scene.getContext('2d')) };
    RENDER_CACHE.set(canvas, c);
  }
  return c;
}

/**
 * Draw one frame. `ctx` is the Runtime's browser capture context:
 *   { frame, time, fps, width, height, seed, params, bindings }
 * The scene is a pure function of (frame, params): no wall clock, no unseeded
 * randomness, no network, no fonts.
 */
export function renderRubberHose(canvas, ctx) {
  if (!canvas || typeof canvas.getContext !== 'function')
    throw new Error('rubber-hose: renderRubberHose needs a canvas element');
  const params = normalizeParams(ctx.params ?? {});
  const width = Math.max(1, Math.floor(ctx.width ?? canvas.width));
  const height = Math.max(1, Math.floor(ctx.height ?? canvas.height));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;

  const fps = Number.isFinite(ctx.fps) && ctx.fps > 0 ? ctx.fps : 24;
  const frame = Number.isFinite(ctx.frame) ? ctx.frame : Math.round((ctx.time ?? 0) * fps);
  const rawTime = frame / fps;
  // The authored action is 192 design frames = 8 s. Real seconds are mapped
  // onto that timeline, so a shorter or longer capture still completes it.
  // The 12 Hz pose clock is sampled from real seconds (two 24 fps frames per
  // drawing at the authored rate); the camera and gate stay on raw seconds.
  const duration = params.duration;
  const poseTime = Math.floor(rawTime * POSE_HZ + 1e-6) / POSE_HZ;
  const drawingFrame = clamp((poseTime / duration) * DESIGN_FRAMES, 0, DESIGN_FRAMES);
  const cache = cacheFor(canvas);
  const T = cache.toon;
  const amp = params.boilAmp * (DESIGN_W / width);

  T.frame(poseTime, { amp });
  const seed = Number.isFinite(ctx.seed) ? ctx.seed : 0;
  // Keep the ink at one screen width when the composite camera zooms the plate.
  T.setLwScale(1 / cameraZoom(rawTime, duration, params.pushIn));
  drawScene(T, drawingFrame, params, seed);
  T.setLwScale(1);

  const g = canvas.getContext('2d');
  compositeFilm(g, cache.scene, rawTime, {
    width,
    height,
    duration,
    pushIn: params.pushIn,
    damage: params.damage,
    seed,
    panY: params.variant === 'stair-clock' ? -34 : 0,
  });

  const sp = spoonPose(drawingFrame);
  const cp = climbPose(drawingFrame);
  return {
    variant: params.variant,
    frame,
    time: rawTime,
    fps,
    beat: beatAt(rawTime, params.bpm),
    boil: boilDrawing(rawTime),
    inkWeight: params.inkWeight,
    spoon: { x: sp.x, y: sp.y, angle: sp.a },
    climb: { plate: cp.i, x: cp.x, feet: cp.feet },
  };
}
