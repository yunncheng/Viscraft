// cel-watercolor.mjs — a reusable CEL + WATERCOLOUR Look module for a browser Source.
//
// This is an ordered PAINT STACK, not a noise/posterize filter:
//
//     PAINT_STAGES = ['paper','sky','celHills','terminator','bleed','ground',
//                     'plants','foliage','detail','contour']
//
// Two material families are combined, deliberately, so the Look is neither a
// plain cel plate nor a plain wash:
//
//   * CEL helpers — a FLAT base silhouette, a HARD light/shadow terminator (a
//     crescent cut by clipping to the shape, no gradient), an INK contour, and
//     a deliberate sub-pixel misregistration of that ink.
//   * WATERCOLOUR helpers — a graded WASH, a broken WET EDGE, PIGMENT POOLING
//     (granulation), a soft BLEED halo, procedural PAPER GRAIN, and
//     plant/foliage drawn as tapered brush strokes with local reveal.
//
// The whole scene is a PURE FUNCTION of (frame, seed, params, size): geometry is
// rebuilt from a seeded PRNG every call, so two frames never re-roll marks
// (no `Math.random`, no `Date.now`, no `requestAnimationFrame`, no wall clock).
// The paper grain is generated on a cached offscreen canvas from seeded value
// noise — the upstream project baked it with Python/PIL; here it is canvas JS
// (no Python port, no image asset).
//
// Provenance: adapted from the MIT-licensed `lemo-opuscar` canvas-2D demos
// (`styles/cel-anime-80s/demo/cel.js` and `styles/watercolor/demo/{engine,
// plants,scene}.js`, LemoLab, commit e3cb16f6). The watercolour show's plain
// `<script>` global chain (`window.DUR/VO`, `window.render(t)`, `READY`, RAF)
// is DE-GLOBALISED into this ESM module exposing the pure per-frame
// `window.viscraft.render(ctx)` contract. No upstream font, voice, music or
// paper image is included.
//
// The pure helpers (normalizeParams, mulberry32, hash01, revealAt, qcurve,
// buildScene, …) run in Node; the drawing helpers and renderCelWatercolor need a
// canvas.

export const PAINT_STAGES = [
  'paper',
  'sky',
  'celHills',
  'terminator',
  'bleed',
  'ground',
  'plants',
  'foliage',
  'detail',
  'contour',
];

export const SUBJECTS = ['grove', 'meadow'];
export const LAYOUTS = ['wide', 'portrait', 'square'];

// `layout` is a framing hint: it moves the horizon / ground line so the same
// scene reads at different aspect ratios.
const FRAMING = {
  wide: { horizon: 0.52, ground: 0.8 },
  square: { horizon: 0.5, ground: 0.82 },
  portrait: { horizon: 0.46, ground: 0.86 },
};

export const DEFAULT_PALETTE = {
  paper: '#f1e9da',
  sky: '#cdd7d8',
  skyDeep: '#a9bcc2',
  hillFar: '#a9b79b',
  hillMid: '#829677',
  hillNear: '#6f8468',
  ground: '#cdbf94',
  trunk: '#7a6a57',
  leaf: '#5f8a52',
  leafDeep: '#3f6a3e',
  ink: '#2b2520',
  accent: '#c06a45',
};

export const DEFAULT_PARAMS = {
  subject: 'grove',
  layout: 'wide',
  revealFrames: 48,
  celEdge: 0.85,
  azimuth: 2.3,
  bleed: 0.6,
  wetEdge: 0.55,
  pooling: 0.5,
  grain: 0.35,
  inkWeight: 2.4,
  misregistration: { dx: 0.8, dy: -0.6 },
  density: 1,
  palette: { ...DEFAULT_PALETTE },
};

const TAU = Math.PI * 2;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

function parseHex(value, label) {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new Error(`cel-watercolor: ${label} must be a #rrggbb colour`);
  }
  const n = parseInt(value.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Mix two #rrggbb colours; deterministic, no colour library. */
export function mixHex(a, b, t) {
  const A = parseHex(a, 'mixHex(a)');
  const B = parseHex(b, 'mixHex(b)');
  const m = A.map((v, i) => Math.round(v + (B[i] - v) * clamp(t)).toString(16).padStart(2, '0')).join('');
  return '#' + m;
}

/** `rgba()` from a #rrggbb colour and an alpha in [0,1]. */
export function rgba(hex, alpha = 1) {
  const [r, g, b] = parseHex(hex, 'rgba(hex)');
  return `rgba(${r},${g},${b},${clamp(alpha).toFixed(3)})`;
}

// ---------------------------------------------------------------------------
// Deterministic PRNG / noise
// ---------------------------------------------------------------------------

/** Mulberry32: a tiny, fast, seedable PRNG returning [0,1). */
export function mulberry32(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash-based value in [0,1) keyed by (seed, index) — no state, no re-roll. */
export function hash01(seed, index) {
  const x = Math.sin(seed * 127.1 + index * 311.7 + 74.7) * 43758.5453;
  return x - Math.floor(x);
}

function hash2i(i, j, seed) {
  const x = Math.sin(i * 127.1 + j * 311.7 + seed * 74.7) * 43758.5453;
  return x - Math.floor(x);
}

function vnoise2(x, y, seed) {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  return lerp(lerp(hash2i(i, j, seed), hash2i(i + 1, j, seed), u), lerp(hash2i(i, j + 1, seed), hash2i(i + 1, j + 1, seed), u), v);
}

function fbm2(x, y, seed) {
  return vnoise2(x, y, seed) * 0.55 + vnoise2(x * 2.1 + 17, y * 2.1 + 9, seed) * 0.3 + vnoise2(x * 4.3 + 41, y * 4.3 + 23, seed) * 0.15;
}

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

function number(value, fallback, label, { min, max, integer } = {}) {
  const v = value === undefined ? fallback : value;
  if (!finite(v)) throw new Error(`cel-watercolor: ${label} must be a finite number`);
  if (integer && !Number.isInteger(v)) throw new Error(`cel-watercolor: ${label} must be an integer`);
  if (min !== undefined && v < min) throw new Error(`cel-watercolor: ${label} must be >= ${min}`);
  if (max !== undefined && v > max) throw new Error(`cel-watercolor: ${label} must be <= ${max}`);
  return v;
}

/** Validate and fill a Source's `params`; unknown/invalid values fail loudly. */
export function normalizeParams(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('cel-watercolor: params must be an object');
  const subject = raw.subject === undefined ? DEFAULT_PARAMS.subject : raw.subject;
  if (!SUBJECTS.includes(subject)) throw new Error(`cel-watercolor: unknown subject "${subject}"; expected one of ${SUBJECTS.join(', ')}`);
  const layout = raw.layout === undefined ? DEFAULT_PARAMS.layout : raw.layout;
  if (!LAYOUTS.includes(layout)) throw new Error(`cel-watercolor: unknown layout "${layout}"; expected one of ${LAYOUTS.join(', ')}`);
  const misregistration = raw.misregistration === undefined ? DEFAULT_PARAMS.misregistration : raw.misregistration;
  if (misregistration === null || typeof misregistration !== 'object') throw new Error('cel-watercolor: misregistration must be an object { dx, dy }');
  const paletteIn = raw.palette === undefined ? {} : raw.palette;
  if (paletteIn === null || typeof paletteIn !== 'object') throw new Error('cel-watercolor: palette must be an object');
  const palette = {};
  for (const key of Object.keys(DEFAULT_PALETTE)) {
    const v = paletteIn[key] === undefined ? DEFAULT_PALETTE[key] : paletteIn[key];
    parseHex(v, `palette.${key}`);
    palette[key] = v;
  }
  return {
    subject,
    layout,
    palette,
    revealFrames: number(raw.revealFrames, DEFAULT_PARAMS.revealFrames, 'revealFrames', { min: 1, integer: true }),
    celEdge: number(raw.celEdge, DEFAULT_PARAMS.celEdge, 'celEdge', { min: 0, max: 1 }),
    azimuth: number(raw.azimuth, DEFAULT_PARAMS.azimuth, 'azimuth'),
    bleed: number(raw.bleed, DEFAULT_PARAMS.bleed, 'bleed', { min: 0, max: 1 }),
    wetEdge: number(raw.wetEdge, DEFAULT_PARAMS.wetEdge, 'wetEdge', { min: 0, max: 1 }),
    pooling: number(raw.pooling, DEFAULT_PARAMS.pooling, 'pooling', { min: 0, max: 1 }),
    grain: number(raw.grain, DEFAULT_PARAMS.grain, 'grain', { min: 0, max: 1 }),
    inkWeight: number(raw.inkWeight, DEFAULT_PARAMS.inkWeight, 'inkWeight', { min: 0 }),
    density: number(raw.density, DEFAULT_PARAMS.density, 'density', { min: 0, max: 4 }),
    misregistration: {
      dx: number(misregistration.dx, DEFAULT_PARAMS.misregistration.dx, 'misregistration.dx'),
      dy: number(misregistration.dy, DEFAULT_PARAMS.misregistration.dy, 'misregistration.dy'),
    },
  };
}

// ---------------------------------------------------------------------------
// Reveal timing — a pure function of the frame index
// ---------------------------------------------------------------------------

/** 0..1 progress of a window that starts at `start` frame and lasts `duration`. */
export function revealAt(frame, start, duration) {
  if (!finite(frame)) throw new Error('cel-watercolor: frame must be a finite number');
  if (!finite(start)) throw new Error('cel-watercolor: start must be a finite number');
  if (!finite(duration) || duration < 0) throw new Error('cel-watercolor: duration must be a finite number >= 0');
  if (duration === 0) return frame >= start ? 1 : 0;
  return clamp((frame - start) / duration);
}

/** Stagger item `i` of `n` inside a stage progress `p` (last item finishes at 1). */
function stagger(p, i, n) {
  if (!(n > 1)) return clamp(p);
  const start = (i / (n - 1)) * 0.6;
  return clamp((p - start) / 0.4);
}

// ---------------------------------------------------------------------------
// Geometry (pure)
// ---------------------------------------------------------------------------

/** Quadratic curve sampled into a polyline; `bend` offsets the control point. */
export function qcurve(x0, y0, x1, y1, bend = 0, n = 12) {
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const L = Math.hypot(dx, dy) || 1;
  const cx = mx - (dy / L) * bend;
  const cy = my + (dx / L) * bend;
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1]);
  }
  return out;
}

/** A stroke spine from (x,y) at angle `ang`, length `len`, with `bend`. */
export function polar(x, y, ang, len, bend = 0, n = 8) {
  return qcurve(x, y, x + Math.cos(ang) * len, y + Math.sin(ang) * len, bend, n);
}

/** A hill ridge line left→right: a sine plus seeded jitter. */
export function ridgePoints(width, y, amp, waves, phase, seed, n = 24) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    const yy = y - amp * (0.5 + 0.5 * Math.sin(s * waves * TAU + phase)) - amp * 0.35 * (hash01(seed, i) - 0.5);
    pts.push([s * width, yy]);
  }
  return pts;
}

function closedHill(ridge, width, height) {
  const pts = ridge.slice();
  pts.push([width + 2, height + 2]);
  pts.push([-2, height + 2]);
  return pts;
}

function boundsOf(pts) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[0] > x1) x1 = p[0];
    if (p[1] > y1) y1 = p[1];
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function leafCols(pal) {
  return [pal.leaf, pal.leafDeep, mixHex(pal.leaf, pal.leafDeep, 0.5)];
}

// ---------------------------------------------------------------------------
// Scene plan (pure): all geometry, seeded and cached-free.
// ---------------------------------------------------------------------------

function buildTree(params, width, height, groundY, u, rng) {
  const pal = params.palette;
  const bx = width * 0.6;
  const by = groundY + u * 0.05;
  const topY = by - u * (0.42 + rng() * 0.05);
  const lean = (rng() - 0.5) * u * 0.1;
  const trunkPts = qcurve(bx, by, bx + lean, topY, (rng() - 0.5) * u * 0.05, 10);
  const trunkW = u * 0.03;
  const strokes = [{ pts: trunkPts, w: trunkW, color: pal.trunk, profile: 'trunk', seed: 1 + Math.floor(rng() * 1e6) }];
  const groups = [];
  const nb = 3;
  for (let i = 0; i < nb; i++) {
    const k = Math.round(lerp(2, trunkPts.length - 2, (i + 1) / (nb + 1)));
    const p = trunkPts[k];
    const side = i % 2 ? 1 : -1;
    const ang = -Math.PI / 2 + side * (0.45 + rng() * 0.4);
    const len = u * (0.13 + rng() * 0.07);
    const bpts = polar(p[0], p[1], ang, len, side * u * 0.03, 6);
    strokes.push({ pts: bpts, w: trunkW * 0.5, color: pal.trunk, profile: 'tip', seed: 1 + Math.floor(rng() * 1e6) });
    const tip = bpts[bpts.length - 1];
    groups.push({
      cx: tip[0],
      cy: tip[1],
      r: u * (0.085 + rng() * 0.04),
      count: Math.round(15 * params.density),
      colors: leafCols(pal),
      seed: 1 + Math.floor(rng() * 1e6),
      dir: Math.PI / 2,
      spread: 0.75,
      l0: u * 0.028,
      l1: u * 0.055,
      w0: u * 0.014,
      w1: u * 0.028,
      sx: 1.25,
      sy: 0.85,
    });
  }
  groups.push({
    cx: bx + lean * 0.6,
    cy: topY - u * 0.03,
    r: u * 0.13,
    count: Math.round(22 * params.density),
    colors: leafCols(pal),
    seed: 1 + Math.floor(rng() * 1e6),
    dir: 0,
    spread: Math.PI,
    l0: u * 0.03,
    l1: u * 0.06,
    w0: u * 0.014,
    w1: u * 0.03,
    sx: 1.3,
    sy: 0.9,
  });
  return { kind: 'tree', strokes, groups, base: { x: bx, y: by } };
}

function buildShrub(params, x, y, r, u, rng) {
  const pal = params.palette;
  return {
    kind: 'shrub',
    strokes: [],
    groups: [
      {
        cx: x,
        cy: y - r,
        r,
        count: Math.round(16 * params.density),
        colors: [pal.leaf, pal.leafDeep, mixHex(pal.leaf, pal.ground, 0.3)],
        seed: 1 + Math.floor(rng() * 1e6),
        dir: Math.PI / 2,
        spread: 0.9,
        l0: u * 0.02,
        l1: u * 0.05,
        w0: u * 0.012,
        w1: u * 0.026,
        sx: 1.3,
        sy: 0.85,
      },
    ],
    base: { x, y },
  };
}

/**
 * Build the whole scene geometry from (subject, params, size, seed). Pure, so it
 * runs in Node; `renderCelWatercolour` only draws this plan.
 */
export function buildScene(subject, params, width, height, seed) {
  if (!SUBJECTS.includes(subject)) throw new Error(`cel-watercolor: unknown subject "${subject}"`);
  if (!finite(width) || !finite(height) || !(width > 0) || !(height > 0)) throw new Error('cel-watercolor: width and height must be > 0');
  if (!finite(seed)) throw new Error('cel-watercolor: seed must be a finite number');
  const framing = FRAMING[params.layout] ?? FRAMING.wide;
  const pal = params.palette;
  const u = Math.min(width, height);
  const horizonY = height * framing.horizon;
  const groundY = height * framing.ground;
  const rng = mulberry32((((seed | 0) * 0x9e3779b1) ^ 0x85ebca6b) >>> 0);

  const ridgeSpecs = [
    { y: horizonY + u * 0.03, amp: u * 0.05, waves: 1.3, base: pal.hillFar },
    { y: lerp(horizonY, groundY, 0.62), amp: u * 0.055, waves: 2.1, base: pal.hillMid },
  ];
  const hills = [];
  for (let i = 0; i < ridgeSpecs.length; i++) {
    const spec = ridgeSpecs[i];
    const phase = rng() * TAU;
    const hseed = 1 + Math.floor(rng() * 1e6);
    const ridge = ridgePoints(width, spec.y, spec.amp, spec.waves, phase, hseed, 26);
    hills.push({ index: i, pts: closedHill(ridge, width, height), ridge, base: spec.base, seed: hseed });
  }

  const gseed = 1 + Math.floor(rng() * 1e6);
  const groundRidge = ridgePoints(width, groundY, u * 0.028, 1.1, rng() * TAU, gseed, 22);
  const ground = { pts: closedHill(groundRidge, width, height), ridge: groundRidge, base: pal.ground, seed: gseed };

  const sky = { bottom: horizonY + u * 0.07, clouds: [] };
  const cloudCount = 2 + Math.floor(rng() * 2);
  for (let i = 0; i < cloudCount; i++) {
    const cy = horizonY * (0.2 + rng() * 0.5);
    const cx = width * (0.1 + rng() * 0.8);
    const len = u * (0.28 + rng() * 0.25);
    sky.clouds.push({
      pts: qcurve(cx - len / 2, cy, cx + len / 2, cy, (rng() * 2 - 1) * u * 0.05, 12),
      w: u * (0.05 + rng() * 0.04),
      seed: 1 + Math.floor(rng() * 1e6),
      f: cy / Math.max(1, horizonY),
    });
  }
  sky.clouds.sort((a, b) => a.f - b.f);

  const tussockCount = Math.round((subject === 'meadow' ? 22 : 9) * params.density);
  const tussocks = [];
  for (let i = 0; i < tussockCount; i++) {
    const fx = (i + 0.5) / tussockCount;
    const depth = 0.15 + rng() * 0.85;
    const x = fx * width + (rng() - 0.5) * u * 0.06;
    const y = groundY + u * 0.02 + depth * (height - groundY - u * 0.02);
    const h = u * (0.045 + rng() * 0.05) * lerp(0.7, 1.35, depth);
    tussocks.push({
      x,
      y,
      h,
      count: 7 + Math.floor(rng() * 7),
      colors: [pal.leaf, pal.leafDeep, mixHex(pal.leaf, pal.ground, 0.4)],
      seed: 1 + Math.floor(rng() * 1e6),
      f: depth,
    });
  }
  tussocks.sort((a, b) => a.f - b.f);

  const plants = [];
  if (subject === 'grove') {
    plants.push(buildTree(params, width, height, groundY, u, rng));
  } else {
    const shrubs = 2 + Math.floor(rng() * 2);
    for (let i = 0; i < shrubs; i++) {
      plants.push(buildShrub(params, width * (0.12 + rng() * 0.76), groundY + u * (0.04 + rng() * 0.1), u * (0.06 + rng() * 0.05), u, rng));
    }
  }

  const accents = [];
  const accentCount = subject === 'grove' ? 4 : 3;
  for (let i = 0; i < accentCount; i++) {
    accents.push({
      x: width * (0.08 + rng() * 0.84),
      y: groundY + u * (0.05 + rng() * 0.16),
      r: u * (0.008 + rng() * 0.006),
      seed: 1 + Math.floor(rng() * 1e6),
      f: rng(),
    });
  }
  accents.sort((a, b) => a.f - b.f);

  return { width, height, u, framing, horizonY, groundY, sky, hills, ground, plants, tussocks, accents };
}

// ---------------------------------------------------------------------------
// Canvas primitives — CEL
// ---------------------------------------------------------------------------

function tracePoly(g, pts) {
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  g.closePath();
}

function traceOpen(g, pts) {
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
}

/** A flat, single-tone CEL base fill of a closed polygon. */
export function flatBase(g, pts, color, opacity = 1) {
  if (!(opacity > 0)) return;
  g.save();
  g.beginPath();
  tracePoly(g, pts);
  g.globalAlpha = clamp(opacity);
  g.fillStyle = color;
  g.fill();
  g.restore();
}

/**
 * A HARD terminator: clip to the shape and fill the crescent left by shifting a
 * copy of the shape along the light axis (`azimuth`) by `mag` px. No gradient —
 * a crisp cel light/shadow edge, as in the upstream `cel()` `so` mechanism.
 */
export function hardTerminator(g, pts, { color, opacity = 0.4, azimuth = 2.3, mag = 0 } = {}) {
  if (!(opacity > 0) || !(mag > 0)) return;
  const dx = Math.cos(azimuth) * mag;
  const dy = Math.sin(azimuth) * mag * 0.7;
  g.save();
  g.beginPath();
  tracePoly(g, pts);
  g.clip();
  g.beginPath();
  tracePoly(g, pts);
  tracePoly(
    g,
    pts.map((p) => [p[0] + dx, p[1] + dy]),
  );
  g.globalAlpha = clamp(opacity);
  g.fillStyle = color;
  g.fill('evenodd');
  g.restore();
}

/** The cleaned ink contour of a polyline / polygon. */
export function inkContour(g, pts, { color, width = 2, opacity = 1, closed = false } = {}) {
  if (!(opacity > 0)) return;
  g.save();
  g.globalAlpha = clamp(opacity);
  g.strokeStyle = color;
  g.lineWidth = width;
  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.beginPath();
  if (closed) tracePoly(g, pts);
  else traceOpen(g, pts);
  g.stroke();
  g.restore();
}

/** Run `draw(g)` offset by a sub-pixel vector — a deliberate ink misregister. */
export function misregistered(g, { dx = 0, dy = 0 }, draw) {
  g.save();
  g.translate(dx, dy);
  draw(g);
  g.restore();
}

// ---------------------------------------------------------------------------
// Canvas primitives — WATERCOLOUR
// ---------------------------------------------------------------------------

const PROFILE = {
  brush: (s) => Math.min(1, s / 0.1 + 0.3) * Math.pow(1 - s * 0.85, 0.6),
  leaf: (s) => Math.pow(Math.sin(Math.PI * (s * 0.94 + 0.03)), 0.7),
  tip: (s) => Math.pow(1 - s * 0.92, 0.85) * Math.min(1, s / 0.05 + 0.6),
  even: (s) => Math.min(1, s / 0.06 + 0.35) * Math.min(1, (1 - s) / 0.08 + 0.4),
  trunk: (s) => (1 - s * 0.62) * (1 + Math.max(0, 0.06 - s) * 9),
};

/**
 * One tapered brush stroke: a spine polyline drawn as a width-profiled ribbon,
 * with a seeded rough edge. `p` draws only the first `p` of the spine, so a
 * stroke can be revealed stroke-by-stroke.
 */
export function brushStroke(g, pts, width, color, opts = {}) {
  const n = pts.length;
  if (n < 2 || !(width > 0)) return;
  const p = clamp(opts.p === undefined ? 1 : opts.p);
  if (p <= 0) return;
  const profile = PROFILE[opts.profile] ?? PROFILE.brush;
  const rough = opts.rough === undefined ? 0.22 : opts.rough;
  const opacity = opts.opacity === undefined ? 0.9 : opts.opacity;
  const seed = Math.floor(opts.seed ?? 1);
  const ws = [];
  const nx = [];
  const ny = [];
  for (let i = 0; i < n; i++) {
    const s = n === 1 ? 0 : i / (n - 1);
    const jitter = 1 + rough * (hash01(seed, i * 0.9) * 2 - 1);
    ws.push(Math.max(0.5, width * profile(s) * jitter));
  }
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1;
    nx.push(-dy / L);
    ny.push(dx / L);
  }
  const m = (n - 1) * p;
  const k = Math.floor(m);
  const f = m - k;
  const cnt = f > 0.001 && k < n - 1 ? k + 2 : k + 1;
  const X = (i) => (i <= k ? pts[i][0] : lerp(pts[k][0], pts[k + 1][0], f));
  const Y = (i) => (i <= k ? pts[i][1] : lerp(pts[k][1], pts[k + 1][1], f));
  g.save();
  g.beginPath();
  for (let i = 0; i < cnt; i++) {
    const j = Math.min(i, n - 1);
    const hw = (ws[j] / 2) * (p < 1 && i === cnt - 1 ? 0.5 : 1);
    const x = X(i) + nx[j] * hw;
    const y = Y(i) + ny[j] * hw;
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  for (let i = cnt - 1; i >= 0; i--) {
    const j = Math.min(i, n - 1);
    const hw = (ws[j] / 2) * (p < 1 && i === cnt - 1 ? 0.5 : 1);
    g.lineTo(X(i) - nx[j] * hw, Y(i) - ny[j] * hw);
  }
  g.closePath();
  g.fillStyle = rgba(color, opacity);
  g.fill();
  g.restore();
}

/**
 * A broken WET EDGE: the darker rim where a wash pools at its boundary, drawn as
 * per-segment strokes with seeded wobble and varying alpha (never a clean line).
 */
export function wetEdge(g, pts, { color, width = 2, opacity = 0.5, seed = 1, p = 1 } = {}) {
  const n = pts.length;
  if (n < 2 || !(opacity > 0)) return;
  const m = Math.max(1, Math.round((n - 1) * clamp(p)));
  g.save();
  g.strokeStyle = color;
  g.lineWidth = width;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (let i = 0; i < m; i++) {
    const a = pts[i];
    const b = pts[i + 1] ?? pts[n - 1];
    const jx = (hash01(seed, i) - 0.5) * width * 1.2;
    const jy = (hash01(seed, i + 99) - 0.5) * width * 1.2;
    g.globalAlpha = clamp(opacity * (0.6 + 0.4 * hash01(seed, i + 7)));
    g.beginPath();
    g.moveTo(a[0] + jx, a[1] + jy);
    g.lineTo(b[0] + jx, b[1] + jy);
    g.stroke();
  }
  g.restore();
}

/** Pigment granulation: seeded soft blobs clipped to the caller's shape. */
export function pigmentPool(g, shape, params, u, p = 1) {
  if (!(params.pooling > 0) || !(p > 0)) return;
  const b = boundsOf(shape.pts);
  const rng = mulberry32(((shape.seed >>> 0) ^ 0x51ed270b) >>> 0);
  const blobs = Math.round(14 * params.pooling);
  const dark = mixHex(shape.base, params.palette.ink, 0.25);
  for (let i = 0; i < blobs; i++) {
    const x = b.x + rng() * b.w;
    const y = b.y + rng() * b.h;
    const r = u * (0.02 + rng() * 0.05);
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, rgba(dark, 1));
    gr.addColorStop(1, rgba(dark, 0));
    g.save();
    g.globalAlpha = clamp(0.1 * p);
    g.fillStyle = gr;
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
    g.restore();
  }
}

/** A soft BLEED halo along a wet boundary (a blurred stroke of the wash tone). */
export function bleedWash(g, pts, { color, width = 2, blur = 8, opacity = 0.4 } = {}) {
  if (!(opacity > 0) || !(blur > 0)) return;
  g.save();
  g.globalAlpha = clamp(opacity);
  g.shadowColor = rgba(color, 1);
  g.shadowBlur = blur;
  g.strokeStyle = rgba(color, 0.6);
  g.lineWidth = width;
  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.beginPath();
  traceOpen(g, pts);
  g.stroke();
  g.restore();
}

/** A graded WASH clipped to a polygon: `color` at the top of the bbox → `to` at the bottom. */
export function wash(g, pts, { color, to = null, opacity = 0.5 } = {}) {
  if (!(opacity > 0)) return;
  const b = boundsOf(pts);
  g.save();
  g.beginPath();
  tracePoly(g, pts);
  g.clip();
  if (to) {
    const gr = g.createLinearGradient(0, b.y, 0, b.y + b.h);
    gr.addColorStop(0, rgba(color, opacity));
    gr.addColorStop(1, rgba(to, opacity));
    g.fillStyle = gr;
  } else {
    g.fillStyle = rgba(color, opacity);
  }
  g.fillRect(b.x - 2, b.y - 2, b.w + 4, b.h + 4);
  g.restore();
}

// ---- paper grain (procedural; the upstream baked it in Python/PIL) ----------

const GRAIN_CACHE = new Map();

function buildGrainCanvas(width, height, seed) {
  const gw = Math.max(8, Math.ceil(width / 2));
  const gh = Math.max(8, Math.ceil(height / 2));
  const cv = document.createElement('canvas');
  cv.width = gw;
  cv.height = gh;
  const g2 = cv.getContext('2d');
  const img = g2.createImageData(gw, gh);
  const data = img.data;
  const s = Math.floor(seed) || 1;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const v = 0.86 + 0.1 * fbm2(x * 0.06, y * 0.06, s) + 0.06 * fbm2(x * 0.7, y * 0.7, s + 5);
      const gv = Math.max(0, Math.min(255, Math.round(v * 255)));
      const idx = (y * gw + x) * 4;
      data[idx] = gv;
      data[idx + 1] = gv;
      data[idx + 2] = gv;
      data[idx + 3] = 255;
    }
  }
  g2.putImageData(img, 0, 0);
  const rng = mulberry32((s ^ 0x9e3779b9) >>> 0);
  const fibers = Math.round((gw * gh) / 900);
  g2.globalAlpha = 0.5;
  g2.strokeStyle = '#d9d2c2';
  g2.lineWidth = 0.8;
  for (let i = 0; i < fibers; i++) {
    const x = rng() * gw;
    const y = rng() * gh;
    const ang = rng() * Math.PI;
    const len = 3 + rng() * 9;
    g2.beginPath();
    g2.moveTo(x, y);
    g2.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    g2.stroke();
  }
  return cv;
}

/**
 * Fill `g` with procedural paper: the base tone multiplied by seeded value
 * noise (tooth) plus a few dark fibres. The noise canvas is generated once per
 * (seed,size) and cached, so it is byte-stable across frames.
 */
export function paperGrain(g, width, height, { seed = 0, strength = 0.35, base = '#f1e9da' } = {}) {
  if (!(strength > 0)) return;
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    g.fillStyle = base;
    g.fillRect(0, 0, width, height);
    return;
  }
  const key = `${Math.floor(seed)}:${width}x${height}`;
  let cv = GRAIN_CACHE.get(key);
  if (!cv) {
    cv = buildGrainCanvas(width, height, seed);
    GRAIN_CACHE.set(key, cv);
  }
  g.save();
  g.globalCompositeOperation = 'multiply';
  g.globalAlpha = clamp(strength);
  g.imageSmoothingEnabled = true;
  g.drawImage(cv, 0, 0, width, height);
  g.restore();
}

// ---- foliage / plants -------------------------------------------------------

/**
 * A clump of leaf strokes (the upstream `clump`). Leaf geometry is derived from
 * a seeded PRNG in a fixed order, so `p` only changes HOW MANY leaves are drawn,
 * never their placement.
 */
export function foliage(g, group, opts = {}) {
  const { cx, cy, r, count, colors, seed, dir, spread = 0.6, l0, l1, w0, w1, sx = 1.25, sy = 0.8, opacity = 0.85 } = group;
  const p = clamp(opts.p === undefined ? 1 : opts.p);
  if (p <= 0 || count <= 0) return 0;
  const rng = mulberry32((seed >>> 0) ^ 0x51ed270b);
  const leaves = [];
  for (let i = 0; i < count; i++) {
    const a = rng() * TAU;
    const rr = Math.sqrt(rng());
    const x = cx + Math.cos(a) * rr * r * sx;
    const y = cy + Math.sin(a) * rr * r * sy;
    const d = dir === undefined ? rng() * TAU : dir + (rng() * 2 - 1) * spread;
    const len = lerp(l0, l1, rng());
    const wid = lerp(w0, w1, rng());
    const col = colors[Math.floor(rng() * colors.length)];
    const leafSeed = 1 + Math.floor(rng() * 1e6);
    leaves.push({ x, y, d, len, wid, col, leafSeed });
  }
  const drawn = Math.ceil(count * p);
  let n = 0;
  for (let i = 0; i < leaves.length && i < drawn; i++) {
    const L = leaves[i];
    const local = i === drawn - 1 ? clamp(count * p - (drawn - 1)) : 1;
    const bend = (hash01(L.leafSeed, 3) - 0.5) * 6;
    const pts = qcurve(L.x, L.y, L.x + Math.cos(L.d) * L.len, L.y + Math.sin(L.d) * L.len, bend, 5);
    brushStroke(g, pts, L.wid, L.col, { profile: 'leaf', seed: L.leafSeed, opacity, rough: 0.3, p: local });
    n++;
  }
  return n;
}

/** A grass tussock: a fan of tapered blades from a base point. */
export function tussock(g, spec, opts = {}) {
  const { x, y, h, count, colors, seed } = spec;
  const p = clamp(opts.p === undefined ? 1 : opts.p);
  if (p <= 0 || count <= 0) return 0;
  const rng = mulberry32((seed >>> 0) ^ 0x2545f491);
  const blades = [];
  for (let i = 0; i < count; i++) {
    const side = rng() * 2 - 1;
    const ang = -Math.PI / 2 + side * (0.5 + rng() * 0.5);
    const len = h * (0.6 + rng() * 0.6);
    blades.push({ side, ang, len, col: colors[Math.floor(rng() * colors.length)], bseed: 1 + Math.floor(rng() * 1e6) });
  }
  const drawn = Math.ceil(count * p);
  let n = 0;
  for (let i = 0; i < blades.length && i < drawn; i++) {
    const B = blades[i];
    const local = i === drawn - 1 ? clamp(count * p - (drawn - 1)) : 1;
    const pts = polar(x + B.side * h * 0.06, y, B.ang, B.len, B.side * B.len * 0.22, 6);
    brushStroke(g, pts, Math.max(0.8, h * 0.05), B.col, { profile: 'tip', seed: B.bseed, opacity: 0.82, rough: 0.25, p: local });
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Frame assembly
// ---------------------------------------------------------------------------

const WINDOWS = {
  sky: [0.0, 0.14],
  hills: [0.1, 0.4],
  ground: [0.3, 0.5],
  plants: [0.42, 0.7],
  foliage: [0.56, 0.88],
  detail: [0.72, 0.94],
  contour: [0.82, 1.0],
};

function stageProgress(frame, total) {
  const out = { paper: 1, master: clamp(frame / total) };
  for (const key of Object.keys(WINDOWS)) {
    const [a, b] = WINDOWS[key];
    out[key] = revealAt(frame, a * total, (b - a) * total);
  }
  return out;
}

function drawSky(g, plan, params, p) {
  if (p <= 0) return;
  const pal = params.palette;
  const w = plan.width;
  const u = plan.u;
  const rect = [
    [-2, -2],
    [w + 2, -2],
    [w + 2, plan.sky.bottom],
    [-2, plan.sky.bottom],
  ];
  wash(g, rect, { color: pal.sky, to: pal.skyDeep, opacity: 0.7 * p });
  for (let i = 0; i < plan.sky.clouds.length; i++) {
    const c = plan.sky.clouds[i];
    const cp = stagger(p, i, plan.sky.clouds.length);
    if (cp <= 0) continue;
    brushStroke(g, c.pts, c.w, mixHex(pal.sky, '#ffffff', 0.6), { profile: 'leaf', seed: c.seed, opacity: 0.28 * cp, rough: 0.25, p: cp });
  }
  if (params.wetEdge > 0) {
    const hy = plan.sky.bottom - u * 0.01;
    const pts = [];
    for (let i = 0; i <= 20; i++) pts.push([(i / 20) * w, hy]);
    wetEdge(g, pts, { color: mixHex(pal.sky, pal.ink, 0.25), width: Math.max(1, u * 0.005), opacity: params.wetEdge * 0.35 * p, seed: 991, p });
  }
}

function drawCelBand(g, band, params, p, u) {
  if (p <= 0) return;
  const pal = params.palette;
  if (params.bleed > 0) {
    bleedWash(g, band.ridge, { color: band.base, width: Math.max(1, u * 0.02), blur: u * 0.05 * params.bleed, opacity: 0.4 * params.bleed * p });
  }
  flatBase(g, band.pts, band.base, p);
  if (params.pooling > 0) {
    g.save();
    g.beginPath();
    tracePoly(g, band.pts);
    g.clip();
    pigmentPool(g, band, params, u, p);
    g.restore();
  }
  hardTerminator(g, band.pts, { color: mixHex(band.base, pal.ink, 0.4), opacity: params.celEdge * 0.5 * p, azimuth: params.azimuth, mag: u * 0.06 });
  if (params.wetEdge > 0) {
    wetEdge(g, band.ridge, { color: mixHex(band.base, pal.ink, 0.35), width: Math.max(1, u * 0.006), opacity: params.wetEdge * 0.55 * p, seed: band.seed + 7, p });
  }
}

function drawContour(g, plan, params, p, sw) {
  if (p <= 0) return;
  const pal = params.palette;
  g.save();
  g.globalAlpha = 1;
  g.strokeStyle = pal.ink;
  g.lineWidth = sw;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  misregistered(g, params.misregistration, (gg) => {
    const ridges = plan.hills.map((h) => h.ridge).concat([plan.ground.ridge]);
    for (let i = 0; i < ridges.length; i++) {
      const rp = stagger(p, i, ridges.length);
      if (rp <= 0) continue;
      gg.globalAlpha = clamp(rp * 0.85);
      gg.beginPath();
      traceOpen(gg, ridges[i]);
      gg.stroke();
    }
    gg.globalAlpha = clamp(p * 0.8);
    for (const plant of plan.plants) {
      for (const stroke of plant.strokes) {
        gg.beginPath();
        traceOpen(gg, stroke.pts);
        gg.stroke();
      }
    }
  });
  g.restore();
}

function drawAccents(g, plan, params, p) {
  if (p <= 0) return;
  const pal = params.palette;
  for (let i = 0; i < plan.accents.length; i++) {
    const a = plan.accents[i];
    const ap = stagger(p, i, plan.accents.length);
    if (ap <= 0) continue;
    const pts = polar(a.x, a.y, -Math.PI / 2 + (hash01(a.seed, 1) - 0.5), a.r * 6, 0, 4);
    brushStroke(g, pts, a.r * 2.2, pal.accent, { profile: 'tip', seed: a.seed, opacity: 0.9 * ap, rough: 0.2, p: ap });
  }
}

/**
 * Draw one deterministic frame. `ctx` is the CodeScene render argument:
 * { frame, time, fps, width, height, seed, params, bindings }. The reveal is a
 * pure function of `frame`; geometry is a pure function of `seed`.
 */
export function renderCelWatercolor(canvas, ctx) {
  if (!canvas || typeof canvas.getContext !== 'function') throw new Error('cel-watercolor: renderCelWatercolor needs a canvas element');
  const params = normalizeParams(ctx.params ?? {});
  const width = Math.max(1, Math.floor(ctx.width ?? canvas.width));
  const height = Math.max(1, Math.floor(ctx.height ?? canvas.height));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const g = canvas.getContext('2d');
  const seed = finite(ctx.seed) ? ctx.seed : 0;
  const fps = finite(ctx.fps) && ctx.fps > 0 ? ctx.fps : 24;
  const frame = finite(ctx.frame) ? ctx.frame : Math.round((finite(ctx.time) ? ctx.time : 0) * fps);

  const plan = buildScene(params.subject, params, width, height, seed);
  const total = Math.max(1, Math.round(params.revealFrames));
  const S = stageProgress(frame, total);
  const pal = params.palette;
  const u = plan.u;
  const sw = Math.max(0.6, params.inkWeight * (u / 400));

  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.shadowBlur = 0;
  g.setLineDash([]);
  g.lineJoin = 'round';
  g.lineCap = 'round';

  // paper
  g.fillStyle = pal.paper;
  g.fillRect(0, 0, width, height);
  paperGrain(g, width, height, { seed, strength: params.grain, base: pal.paper });

  drawSky(g, plan, params, S.sky);

  for (let i = 0; i < plan.hills.length; i++) {
    drawCelBand(g, plan.hills[i], params, stagger(S.hills, i, plan.hills.length), u);
  }
  drawCelBand(g, plan.ground, params, S.ground, u);

  // trunks / branches
  for (let i = 0; i < plan.plants.length; i++) {
    const plant = plan.plants[i];
    const pp = stagger(S.plants, i, Math.max(1, plan.plants.length));
    for (let s = 0; s < plant.strokes.length; s++) {
      const stroke = plant.strokes[s];
      const sp = stagger(pp, s, plant.strokes.length);
      if (sp <= 0) continue;
      brushStroke(g, stroke.pts, stroke.w, stroke.color, { profile: stroke.profile, seed: stroke.seed, opacity: 0.95, rough: 0.3, p: sp });
    }
  }

  // grass
  for (let i = 0; i < plan.tussocks.length; i++) {
    tussock(g, plan.tussocks[i], { p: stagger(S.plants, i, plan.tussocks.length) });
  }

  // foliage
  const groups = [];
  for (const plant of plan.plants) for (const gr of plant.groups) groups.push(gr);
  for (let i = 0; i < groups.length; i++) {
    foliage(g, groups[i], { p: stagger(S.foliage, i, groups.length) });
  }

  drawAccents(g, plan, params, S.detail);
  drawContour(g, plan, params, S.contour, sw);

  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.shadowBlur = 0;

  return {
    stages: PAINT_STAGES.slice(),
    subject: params.subject,
    progress: S.master,
    frame,
    revealFrames: total,
    hills: plan.hills.length,
    plants: plan.plants.length,
    tussocks: plan.tussocks.length,
    foliage: groups.length,
  };
}
