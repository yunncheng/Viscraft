// paint-material.mjs — a reusable PROCEDURAL-PAINT material module for a browser Source.
//
// It draws a deliberately PAINTED, hand-made Look from three families of
// mechanisms, each a separate mode:
//
//   PAINT_MODES = ['wash', 'brush', 'collage']
//
//   * wash    — watercolor: midpoint-displacement region silhouettes filled in
//               low-alpha multiply layers with a same-colour edge deposit
//               (the "water edge"), over a paper ground.
//   * brush   — ink/impasto strokes: a Chinese brush whose core is a width-
//               profiled ribbon and whose "flying white" comes from per-bristle
//               broken lines, plus a thick bristle (impasto) accent stroke and
//               a soft pigment bloom over the subject.
//   * collage — cut paper: torn-edge cut-outs with a white sticker edge and a
//               drop shadow, laid down in a 12fps-stepped slide-in, then taped,
//               pinned and marker-highlighted.
//
// This is a DEGLOBALIZED, PURE-FRAME adaptation of three MIT files from
// huashu-art-motion (`lib/paint.js`, `lib/brush.js`, `lib/collage.js`, with the
// shared helpers from `lib/util.js`). The upstream files are IIFEs that register
// onto `window.PAINT` / `window.CL` and hook a `U.onStage` render loop. Here:
//
//   * there is no `window`, no `PAINT`, no `CL`, no `U`; every mechanism is a
//     plain ESM export,
//   * randomness is an EXPLICIT seeded PRNG (`mulberry32`) passed in by the
//     caller — never `Math.random`,
//   * there is no `requestAnimationFrame` and no wall clock; the frame is drawn
//     as a pure function of `(frame, seed, params)`, so `renderPaint` is
//     deterministic and order-independent (a shuffled sample equals the ordered
//     sample),
//   * the canvas size and the whole composition are parameterized instead of the
//     upstream fixed 1920x1080, and paper grain / textures are seeded and cached.
//
// Time ownership: the module owns no clock. `ctx.time` is the capture's virtual
// time; the optional `boilFps` re-seeds the hand-drawn line at that rate (the
// stylized "boiling line" of hand-drawn animation) — a pure function of time,
// never of real elapsed time.
//
// HONEST SCOPE: this is a STYLIZED procedural paint/collage Look. It is NOT
// photorealism, NOT a general raster-paint engine, and it does not repaint an
// arbitrary supplied bitmap (there is no external image in the pure-frame
// contract) — it synthesizes its own simple composition and paints that. A
// successful render proves deterministic execution, not artistic approval.
//
// License: MIT (adapted from huashu-art-motion by alchaincyf). See create.mjs
// for the exact rights record written into every authored Project.

export const PAINT_MODES = ['wash', 'brush', 'collage'];
export const PAINT_SUBJECTS = ['landscape', 'still'];

export const DEFAULT_PALETTE = {
  paper: '#efe6d2',
  sky: '#a7c6d8',
  ground: '#cfa964',
  sun: '#e7a94a',
  hillBack: '#8aa892',
  hillFront: '#5f8268',
  subject: '#b9583f',
  ink: '#241c1a',
  accent: '#c94f3c',
};

export const DEFAULT_PARAMS = {
  mode: 'wash',
  subject: 'landscape',
  reveal: 1,
  revealSeconds: 0,
  seed: 0,
  boilFps: 0,
  grainDensity: 0.05,
  grainAlpha: 0.16,
  washLayers: 6,
  washAlpha: 0.16,
  washAmp: 12,
  washEdge: 0.1,
  inkWidth: 18,
  inkDry: 0.5,
  inkBristles: 9,
  inkTone: 0.88,
  inkStrokes: 8,
  collagePieces: 8,
  collageBorder: 10,
  collageRotate: 0.06,
  collageTape: true,
  collagePin: true,
  collageMarker: true,
  collageShadow: true,
  palette: { ...DEFAULT_PALETTE },
};

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Math + explicit seeded PRNG. Everything downstream is deterministic.
// ---------------------------------------------------------------------------

export function clamp(x, a = 0, b = 1) {
  return x < a ? a : x > b ? b : x;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Smoothstep from 0 at x<=a to 1 at x>=b (defined for a === b). */
export function smoothstep(a, b, x) {
  if (a === b) return x < a ? 0 : 1;
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** mulberry32: the seeded PRNG the caller threads through every mechanism. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic hash-based PRNG in [0,1) keyed by (seed, index). */
export function hash01(seed, index) {
  let h = (Math.imul(seed | 0, 374761393) + Math.imul(index | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Perlin permutation table built once from a fixed seed, so `noise2` is
// byte-identical in Node and the browser and across every frame.
const PERM = (() => {
  const p = new Uint8Array(512);
  const r = mulberry32(1337);
  const a = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) {
    const j = (r() * (i + 1)) | 0;
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  for (let i = 0; i < 512; i++) p[i] = a[i & 255];
  return p;
})();

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const grad = (h, x, y) => {
  const u = h & 1 ? x : -x;
  const v = h & 2 ? y : -y;
  return h & 4 ? u + v * 0.5 : u * 0.5 + v;
};

/** 2-D Perlin noise, roughly in [-1, 1]. Pure. */
export function noise2(x, y) {
  const X = Math.floor(x) & 255;
  const Y = Math.floor(y) & 255;
  x -= Math.floor(x);
  y -= Math.floor(y);
  const u = fade(x);
  const v = fade(y);
  const A = PERM[X] + Y;
  const B = PERM[X + 1] + Y;
  return lerp(
    lerp(grad(PERM[A], x, y), grad(PERM[B], x - 1, y), u),
    lerp(grad(PERM[A + 1], x, y - 1), grad(PERM[B + 1], x - 1, y - 1), u),
    v,
  );
}

/** Fractal Brownian motion over `noise2`. Pure. */
export function fbm2(x, y, octaves = 4) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(x * freq, y * freq);
    amp *= 0.5;
    freq *= 2;
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Colour. All pure; hex in, [r,g,b] out.
// ---------------------------------------------------------------------------

export function hexToRgb(hex) {
  let h = String(hex).replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgba(c, alpha = 1) {
  return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${alpha})`;
}

export function mixRgb(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

export function jitterRgb(c, rng, amt) {
  return [c[0] + (rng() - 0.5) * amt, c[1] + (rng() - 0.5) * amt, c[2] + (rng() - 0.5) * amt];
}

/** A picker that draws a random swatch and blends the base colour back in. */
export function swatch(hexes, mixBase = 0.35) {
  const cs = hexes.map(hexToRgb);
  return (colour, rng) => mixRgb(cs[(rng() * cs.length) | 0], colour, mixBase);
}

// ---------------------------------------------------------------------------
// Geometry — all PURE point-list builders. Nothing here needs a canvas, so the
// whole geometry contract is testable in Node.
// ---------------------------------------------------------------------------

export function rectPoints(x, y, w, h) {
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
}

export function ellipsePoints(cx, cy, rx, ry, n = 24) {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * TAU;
    return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry];
  });
}

export function bezierPoints(p0, p1, p2, p3, n = 24) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return out;
}

/** Catmull-Rom densify of a control polyline (smooths it without a canvas). */
export function densify(pts, per = 5) {
  if (pts.length < 2) return pts.map((p) => [p[0], p[1]]);
  const P = pts;
  const get = (i) => P[Math.max(0, Math.min(P.length - 1, i))];
  const out = [];
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = get(i - 1);
    const p1 = get(i);
    const p2 = get(i + 1);
    const p3 = get(i + 2);
    for (let j = 0; j < per; j++) {
      const t = j / per;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  out.push([P[P.length - 1][0], P[P.length - 1][1]]);
  return out;
}

/** Equal-arc-length resample to ~`step` px spacing (stable stroke texture). */
export function resample(pts, step = 4) {
  if (pts.length < 2) return pts.map((p) => [p[0], p[1]]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  const total = cum[cum.length - 1];
  const n = Math.max(1, Math.round(total / step));
  const out = [];
  let seg = 0;
  for (let k = 0; k <= n; k++) {
    const target = (total * k) / n;
    while (seg < pts.length - 2 && cum[seg + 1] < target) seg++;
    const segLen = cum[seg + 1] - cum[seg] || 1;
    const t = (target - cum[seg]) / segLen;
    out.push([lerp(pts[seg][0], pts[seg + 1][0], t), lerp(pts[seg][1], pts[seg + 1][1], t)]);
  }
  return out;
}

/** Midpoint-displacement edge deformation — the watercolor bleed. Pure. */
export function deform(pts, depth, amp, rng) {
  let out = pts;
  for (let d = 0; d < depth; d++) {
    const n = [];
    for (let i = 0; i < out.length; i++) {
      const a = out[i];
      const b = out[(i + 1) % out.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const g = (rng() + rng() + rng() - 1.5) * amp * Math.min(1, len / 80);
      const nx = -(b[1] - a[1]) / (len || 1);
      const ny = (b[0] - a[0]) / (len || 1);
      n.push(a, [(a[0] + b[0]) / 2 + nx * g, (a[1] + b[1]) / 2 + ny * g]);
    }
    out = n;
    amp *= 0.6;
  }
  return out;
}

/** Scissor-cut a closed outline: resample every `step` px, jitter by ±amp. Pure. */
export function cutPolygon(pts, rng, step = 18, amp = 2.5) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(L / step));
    for (let k = 0; k < n; k++) {
      const q = k / n;
      out.push([lerp(a[0], b[0], q) + (rng() - 0.5) * amp * 2, lerp(a[1], b[1], q) + (rng() - 0.5) * amp * 2]);
    }
  }
  if (out.length) out.push([out[0][0], out[0][1]]);
  return out;
}

/** A torn/ripped edge between two points (jagged + fibre), deterministic. Pure. */
export function tornEdge(x0, y0, x1, y1, { step = 9, amp = 10, seed = 5 } = {}) {
  const rng = mulberry32(seed);
  const L = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(2, Math.round(L / step));
  const nx = -(y1 - y0) / (L || 1);
  const ny = (x1 - x0) / (L || 1);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const q = i / n;
    const k = noise2(i * 0.18, seed) * amp + (rng() - 0.5) * amp * 0.9;
    out.push([lerp(x0, x1, q) + nx * k, lerp(y0, y1, q) + ny * k]);
  }
  return out;
}

/** A closed torn-edged rectangle (four torn edges). Pure. */
export function tornRectPoints(x, y, w, h, seed, amp = 5) {
  return [
    ...tornEdge(x, y, x + w, y, { amp, seed }),
    ...tornEdge(x + w, y, x + w, y + h, { amp, seed: seed + 1 }),
    ...tornEdge(x + w, y + h, x, y + h, { amp, seed: seed + 2 }),
    ...tornEdge(x, y + h, x, y, { amp, seed: seed + 3 }),
  ];
}

function centroidOf(pts) {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
  }
  return [x / pts.length, y / pts.length];
}

/** Rotate a point list about its centroid and translate it. Pure. */
export function transformPoints(pts, rotate = 0, offset = [0, 0]) {
  const [cx, cy] = centroidOf(pts);
  const ca = Math.cos(rotate);
  const sa = Math.sin(rotate);
  return pts.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    return [cx + dx * ca - dy * sa + offset[0], cy + dx * sa + dy * ca + offset[1]];
  });
}

export function boundsOf(pts) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

// ---------------------------------------------------------------------------
// Parameters. Unknown/invalid values fail loudly at authoring time.
// ---------------------------------------------------------------------------

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function number(value, fallback, label, { min, max, integer } = {}) {
  const v = value === undefined ? fallback : value;
  if (!finite(v)) throw new Error(`paint: ${label} must be a finite number`);
  if (integer && !Number.isInteger(v)) throw new Error(`paint: ${label} must be an integer`);
  if (min !== undefined && v < min) throw new Error(`paint: ${label} must be >= ${min}`);
  if (max !== undefined && v > max) throw new Error(`paint: ${label} must be <= ${max}`);
  return v;
}

function colour(value, fallback, label) {
  const v = value === undefined ? fallback : value;
  if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) throw new Error(`paint: ${label} must be a #rrggbb colour`);
  return v;
}

function boolean(value, fallback, label) {
  const v = value === undefined ? fallback : value;
  if (typeof v !== 'boolean') throw new Error(`paint: ${label} must be a boolean`);
  return v;
}

/** Validate and fill a Source's `params`; unknown/invalid values fail loudly. */
export function normalizeParams(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('paint: params must be an object');
  const mode = raw.mode === undefined ? DEFAULT_PARAMS.mode : raw.mode;
  if (!PAINT_MODES.includes(mode)) throw new Error(`paint: unknown mode "${mode}"; expected one of ${PAINT_MODES.join(', ')}`);
  const subject = raw.subject === undefined ? DEFAULT_PARAMS.subject : raw.subject;
  if (!PAINT_SUBJECTS.includes(subject)) throw new Error(`paint: unknown subject "${subject}"; expected one of ${PAINT_SUBJECTS.join(', ')}`);
  const paletteIn = raw.palette === undefined ? {} : raw.palette;
  if (paletteIn === null || typeof paletteIn !== 'object' || Array.isArray(paletteIn)) throw new Error('paint: palette must be an object');
  const palette = {};
  for (const key of Object.keys(DEFAULT_PALETTE)) {
    palette[key] = colour(paletteIn[key], DEFAULT_PALETTE[key], `palette.${key}`);
  }
  return {
    mode,
    subject,
    palette,
    reveal: number(raw.reveal, DEFAULT_PARAMS.reveal, 'reveal', { min: 0, max: 1 }),
    revealSeconds: number(raw.revealSeconds, DEFAULT_PARAMS.revealSeconds, 'revealSeconds', { min: 0 }),
    seed: number(raw.seed, DEFAULT_PARAMS.seed, 'seed'),
    boilFps: number(raw.boilFps, DEFAULT_PARAMS.boilFps, 'boilFps', { min: 0 }),
    grainDensity: number(raw.grainDensity, DEFAULT_PARAMS.grainDensity, 'grainDensity', { min: 0, max: 1 }),
    grainAlpha: number(raw.grainAlpha, DEFAULT_PARAMS.grainAlpha, 'grainAlpha', { min: 0, max: 1 }),
    washLayers: number(raw.washLayers, DEFAULT_PARAMS.washLayers, 'washLayers', { min: 1, max: 40, integer: true }),
    washAlpha: number(raw.washAlpha, DEFAULT_PARAMS.washAlpha, 'washAlpha', { min: 0, max: 1 }),
    washAmp: number(raw.washAmp, DEFAULT_PARAMS.washAmp, 'washAmp', { min: 0 }),
    washEdge: number(raw.washEdge, DEFAULT_PARAMS.washEdge, 'washEdge', { min: 0, max: 1 }),
    inkWidth: number(raw.inkWidth, DEFAULT_PARAMS.inkWidth, 'inkWidth', { min: 0 }),
    inkDry: number(raw.inkDry, DEFAULT_PARAMS.inkDry, 'inkDry', { min: 0, max: 1 }),
    inkBristles: number(raw.inkBristles, DEFAULT_PARAMS.inkBristles, 'inkBristles', { min: 1, max: 40, integer: true }),
    inkTone: number(raw.inkTone, DEFAULT_PARAMS.inkTone, 'inkTone', { min: 0, max: 1 }),
    inkStrokes: number(raw.inkStrokes, DEFAULT_PARAMS.inkStrokes, 'inkStrokes', { min: 1, max: 60, integer: true }),
    collagePieces: number(raw.collagePieces, DEFAULT_PARAMS.collagePieces, 'collagePieces', { min: 1, max: 30, integer: true }),
    collageBorder: number(raw.collageBorder, DEFAULT_PARAMS.collageBorder, 'collageBorder', { min: 0 }),
    collageRotate: number(raw.collageRotate, DEFAULT_PARAMS.collageRotate, 'collageRotate', { min: 0 }),
    collageTape: boolean(raw.collageTape, DEFAULT_PARAMS.collageTape, 'collageTape'),
    collagePin: boolean(raw.collagePin, DEFAULT_PARAMS.collagePin, 'collagePin'),
    collageMarker: boolean(raw.collageMarker, DEFAULT_PARAMS.collageMarker, 'collageMarker'),
    collageShadow: boolean(raw.collageShadow, DEFAULT_PARAMS.collageShadow, 'collageShadow'),
  };
}

/** The painted fraction in [0,1]: from `reveal`, or animated over `revealSeconds`. */
export function resolveReveal(params, time) {
  if (params.revealSeconds > 0) return smoothstep(0, params.revealSeconds, time);
  return clamp(params.reveal, 0, 1);
}

/** The boiling-line step index: a pure function of time, 0 when boiling is off. */
export function resolveBoil(params, time) {
  return params.boilFps > 0 ? Math.floor(time * params.boilFps) : 0;
}

// ---------------------------------------------------------------------------
// The composition. Pure geometry: a simple horizon/sun/hills/vase scene that
// the paint mechanisms paint over. There is no external bitmap to repaint.
// ---------------------------------------------------------------------------

function hillPoints(cx, baseY, w, h, n = 24) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = cx - w / 2 + w * t;
    pts.push([x, baseY - Math.sin(t * Math.PI) * h]);
  }
  pts.push([cx - w / 2, baseY]);
  return pts;
}

function vaseProfile(t) {
  const body = Math.sin(Math.PI * (0.15 + 0.7 * t));
  const neck = 1 - smoothstep(0.78, 1, t) * 0.55;
  return Math.max(0.08, (0.25 + 0.75 * body) * neck);
}

function vasePoints(cx, baseY, h, n = 16) {
  const w = h * 0.42;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push([cx + w * vaseProfile(t), baseY - h * t]);
  }
  for (let i = n; i >= 0; i--) {
    const t = i / n;
    pts.push([cx - w * vaseProfile(t), baseY - h * t]);
  }
  return pts;
}

/** Build the base composition (shapes with `role`, `color`, `points`). Pure. */
export function baseComposition(subject, width, height, palette) {
  if (!PAINT_SUBJECTS.includes(subject)) throw new Error(`paint: unknown subject "${subject}"`);
  if (!finite(width) || !finite(height) || width <= 0 || height <= 0) throw new Error('paint: width and height must be > 0');
  if (!palette) throw new Error('paint: baseComposition needs a palette');
  const W = width;
  const H = height;
  const m = Math.min(W, H);
  const isStill = subject === 'still';
  const horizon = H * (isStill ? 0.7 : 0.6);
  const shapes = [
    { id: 'sky', role: 'backdrop', color: palette.sky, points: rectPoints(0, 0, W, horizon) },
    { id: 'ground', role: 'backdrop', color: palette.ground, points: rectPoints(0, horizon, W, H - horizon) },
    { id: 'sun', role: 'light', color: palette.sun, points: ellipsePoints(W * 0.72, H * 0.26, m * 0.1, m * 0.1, 28) },
    { id: 'hillBack', role: 'landform', color: palette.hillBack, points: hillPoints(W * 0.28, horizon, W * 0.55, m * 0.22) },
    { id: 'hillFront', role: 'landform', color: palette.hillFront, points: hillPoints(W * 0.72, horizon, W * 0.42, m * 0.16) },
  ];
  const baseY = isStill ? H * 0.86 : horizon + (H - horizon) * 0.55;
  shapes.push({ id: 'subject', role: 'subject', color: palette.subject, points: vasePoints(W * 0.44, baseY, m * 0.3) });
  return { subject, width: W, height: H, horizon, shapes };
}

/** Stroke specs for the brush mode (pure — no canvas). Deterministic per rng. */
export function inkStrokes(scene, params, rng) {
  const { width: W, height: H, horizon, shapes } = scene;
  const pal = params.palette;
  const strokes = [];
  const hpts = [];
  const hn = 6;
  for (let i = 0; i <= hn; i++) {
    const t = i / hn;
    hpts.push([W * 0.06 + W * 0.88 * t, horizon + (rng() - 0.5) * H * 0.02]);
  }
  strokes.push({ kind: 'ink', pts: hpts, width: params.inkWidth * 0.7, dry: 0.35, tone: 0.8, color: pal.ink });
  const subject = shapes.find((s) => s.role === 'subject');
  if (subject) {
    strokes.push({ kind: 'ink', pts: subject.points.concat([subject.points[0].slice()]), width: params.inkWidth, dry: 0.5, tone: 0.9, color: pal.ink });
  }
  const extras = Math.max(0, params.inkStrokes - strokes.length);
  for (let k = 0; k < extras; k++) {
    const x0 = W * (0.08 + rng() * 0.84);
    const y0 = H * (0.12 + rng() * 0.76);
    const len = Math.min(W, H) * (0.14 + rng() * 0.3);
    const ang = (rng() - 0.5) * 2.6 - 0.4;
    const pts = [];
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      pts.push([x0 + Math.cos(ang) * len * t + (rng() - 0.5) * 7, y0 + Math.sin(ang) * len * t + (rng() - 0.5) * 7]);
    }
    const heavy = k % 3 === 2;
    strokes.push({
      kind: heavy ? 'impasto' : 'ink',
      pts,
      width: params.inkWidth * (heavy ? 1.1 : 0.5 + rng() * 0.6),
      dry: 0.4 + rng() * 0.4,
      tone: 0.6 + rng() * 0.3,
      color: heavy ? pal.sun : k % 2 ? pal.accent : pal.ink,
    });
  }
  return strokes;
}

/** Cut-paper piece specs for the collage mode (pure). Deterministic per rng. */
export function collagePieces(scene, params, rng) {
  const pal = params.palette;
  const pieces = [];
  scene.shapes.forEach((shape, i) => {
    const cut = cutPolygon(shape.points, rng, Math.max(6, params.collageBorder * 0.9), params.collageBorder * 0.35);
    pieces.push({
      id: shape.id,
      pts: cut,
      fill: shape.color,
      rotate: (rng() - 0.5) * 2 * params.collageRotate,
      at: 0.12 * i,
      span: 0.35,
      marker: false,
      tape: false,
      pin: false,
    });
  });
  const extra = Math.max(0, params.collagePieces - scene.shapes.length);
  const accents = [pal.accent, pal.sun, pal.paper];
  for (let i = 0; i < extra; i++) {
    const w = scene.width * (0.1 + rng() * 0.16);
    const h = scene.height * (0.08 + rng() * 0.14);
    const x = rng() * (scene.width - w);
    const y = rng() * (scene.height - h);
    pieces.push({
      id: `scrap${i}`,
      pts: tornRectPoints(x, y, w, h, (params.seed * 97 + i * 29) | 0, params.collageBorder * 0.6),
      fill: accents[i % accents.length],
      rotate: (rng() - 0.5) * 2 * params.collageRotate * 1.6,
      at: 0.55 + 0.08 * i,
      span: 0.4,
      marker: i === 0,
      tape: params.collageTape,
      pin: params.collagePin,
    });
  }
  return pieces;
}

// ---------------------------------------------------------------------------
// Drawing primitives. These need a canvas 2-D context (`g`). The caller always
// passes an explicit seeded rng where randomness is needed.
// ---------------------------------------------------------------------------

function tracePoly(g, pts) {
  if (!pts || !pts.length) return;
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  g.closePath();
}

function traceOpen(g, pts) {
  if (!pts || !pts.length) return;
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
}

let SCRATCH = null;
function scratchCanvas(width, height) {
  if (!SCRATCH) SCRATCH = document.createElement('canvas');
  if (SCRATCH.width !== width) SCRATCH.width = width;
  if (SCRATCH.height !== height) SCRATCH.height = height;
  return SCRATCH;
}

const GRAIN_CACHE = new Map();

/**
 * Paper grain: a seeded speckle overlay. The speckle image is generated once
 * per (size, seed, params) and cached, so it never re-rolls across frames.
 */
export function paperGrain(g, { width, height, seed = 1, density = 0.05, alpha = 0.16, color = [40, 35, 30] } = {}) {
  if (!finite(width) || !finite(height) || width <= 0 || height <= 0) throw new Error('paint: paperGrain needs width and height > 0');
  const key = `${width}x${height}:${seed}:${density}:${alpha}:${color.join(',')}`;
  let img = GRAIN_CACHE.get(key);
  if (!img || img.width !== width || img.height !== height) {
    img = g.createImageData(width, height);
    const d = img.data;
    const rng = mulberry32(seed * 97 + 3);
    for (let i = 0; i < width * height; i++) {
      if (rng() < density) {
        const a = alpha * (0.4 + rng() * 0.6);
        d[i * 4] = color[0];
        d[i * 4 + 1] = color[1];
        d[i * 4 + 2] = color[2];
        d[i * 4 + 3] = Math.round(255 * a);
      }
    }
    GRAIN_CACHE.set(key, img);
  }
  const c = scratchCanvas(width, height);
  const gg = c.getContext('2d');
  gg.setTransform(1, 0, 0, 1, 0, 0);
  gg.globalAlpha = 1;
  gg.globalCompositeOperation = 'source-over';
  gg.putImageData(img, 0, 0);
  g.save();
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.filter = 'none';
  g.drawImage(c, 0, 0);
  g.restore();
}

function ribbon(g, D, widthFn) {
  const n = D.length;
  const L = [];
  const R = [];
  for (let i = 0; i < n; i++) {
    const A = D[Math.max(0, i - 1)];
    const B = D[Math.min(n - 1, i + 1)];
    const dx = B[0] - A[0];
    const dy = B[1] - A[1];
    const d = Math.hypot(dx, dy) || 1;
    const nx = -dy / d;
    const ny = dx / d;
    const hw = Math.max(0.05, widthFn(i / (n - 1), i)) / 2;
    L.push([D[i][0] + nx * hw, D[i][1] + ny * hw]);
    R.push([D[i][0] - nx * hw, D[i][1] - ny * hw]);
  }
  g.beginPath();
  L.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
  for (let i = R.length - 1; i >= 0; i--) g.lineTo(R[i][0], R[i][1]);
  g.closePath();
}

/**
 * A Chinese ink brush stroke: a width-profiled ribbon core plus per-bristle
 * broken lines ("flying white") that get drier toward the tail. `reveal` 0..1
 * writes the stroke out progressively. `rng` is the explicit seeded PRNG.
 */
export function inkStroke(g, pts, {
  rng = mulberry32(1),
  width = 14,
  color = [26, 22, 20],
  tone = 0.88,
  dry = 0.45,
  bristles = 8,
  reveal = 1,
  head = 0.12,
  tail = 0.4,
  noiseSeed = 1,
} = {}) {
  if (reveal <= 0 || !pts || pts.length < 2) return;
  const D = resample(densify(pts, 5), 4);
  const n = D.length;
  const m = Math.max(2, Math.ceil(n * clamp(reveal)));
  const prof = (q) => smoothstep(0, head, q) * (1 - 0.7 * smoothstep(1 - tail, 1, q)) * (0.85 + 0.15 * noise2(noiseSeed * 3.3, q * 6)) + 0.08;
  const N = [];
  for (let i = 0; i < n; i++) {
    const A = D[Math.max(0, i - 1)];
    const B = D[Math.min(n - 1, i + 1)];
    const dx = B[0] - A[0];
    const dy = B[1] - A[1];
    const d = Math.hypot(dx, dy) || 1;
    N.push([-dy / d, dx / d]);
  }
  const core = (q) => width * prof(q) * (1 - dry * 0.85 * Math.pow(q, 0.8));
  g.save();
  g.lineCap = 'butt';
  g.lineJoin = 'round';
  g.fillStyle = rgba(color, tone * 0.72);
  ribbon(g, D.slice(0, m), (q) => core(q));
  g.fill();
  for (let k = 0; k < bristles; k++) {
    const off = (bristles > 1 ? k / (bristles - 1) - 0.5 : 0) * 0.95;
    const bw = (width / bristles) * (0.9 + rng() * 0.9);
    const ph = rng() * 50;
    g.strokeStyle = rgba(color, tone * (0.45 + rng() * 0.35));
    g.lineWidth = Math.max(0.7, bw);
    g.beginPath();
    let on = false;
    for (let i = 0; i < m; i++) {
      const q = i / (n - 1);
      const dryness = dry * Math.pow(q, 1.2);
      const vis = noise2(k * 1.9 + ph, i * 0.09) * 0.5 + 0.5 > dryness * 0.95 + 0.05;
      const o = off * width * prof(q);
      const x = D[i][0] + N[i][0] * o;
      const y = D[i][1] + N[i][1] * o;
      if (vis) {
        on ? g.lineTo(x, y) : g.moveTo(x, y);
        on = true;
      } else {
        on = false;
      }
    }
    g.stroke();
  }
  g.restore();
}

/**
 * A watercolor wash: the region silhouette is edge-deformed into several
 * low-alpha multiply layers; each layer deposits a faint same-colour edge (the
 * water edge). `color` is a CSS colour string. `rng` is explicit.
 */
export function watercolorWash(g, pts, color, { rng = mulberry32(1), layers = 6, alpha = 0.13, amp = 10, edge = 0.1, blend = 'multiply' } = {}) {
  if (!pts || pts.length < 3 || layers <= 0 || alpha <= 0) return;
  const base = deform(pts, 3, amp, rng);
  g.save();
  g.globalCompositeOperation = blend;
  g.lineJoin = 'round';
  for (let k = 0; k < layers; k++) {
    const q = deform(base, 2, amp * 0.55, rng);
    tracePoly(g, q);
    g.globalAlpha = alpha;
    g.fillStyle = color;
    g.fill();
    if (edge) {
      g.globalAlpha = edge;
      g.strokeStyle = color;
      g.lineWidth = 1.6;
      g.stroke();
    }
  }
  g.restore();
}

/** A soft pigment bloom around a shape (an ink halo). Uses a blur filter. */
export function inkBloom(g, pts, { color = 'rgba(30,24,22,1)', grow = 1, blur = 8, alpha = 0.16 } = {}) {
  if (grow <= 0 || !pts || pts.length < 3) return;
  g.save();
  g.globalCompositeOperation = 'multiply';
  tracePoly(g, pts);
  g.filter = `blur(${Math.max(0.5, blur * (1.4 - grow * 0.4)).toFixed(2)}px)`;
  g.globalAlpha = alpha * grow;
  g.fillStyle = color;
  g.fill();
  g.filter = 'none';
  g.restore();
}

/**
 * A thick bristle (impasto) stroke: one stroke becomes several parallel bristles
 * with per-bristle light variation, a soft under-shadow and a few highlights.
 * `color` is a hex string or [r,g,b]; `rng` is explicit.
 */
export function impastoStroke(g, pts, width = 18, color = '#e6d6c0', highlight = null, rng = mulberry32(1)) {
  if (!pts || pts.length < 2) return;
  const base = Array.isArray(color) ? color : hexToRgb(typeof color === 'string' && color[0] === '#' ? color : '#e6d6c0');
  const A = pts[0];
  const B = pts[pts.length - 1];
  const ang = Math.atan2(B[1] - A[1], B[0] - A[0]);
  const nx = -Math.sin(ang);
  const ny = Math.cos(ang);
  const nb = Math.max(3, Math.round(width / 1.3));
  g.save();
  g.lineCap = 'round';
  g.strokeStyle = 'rgba(40,18,6,0.28)';
  g.lineWidth = width * 0.9;
  traceOpen(g, pts.map((p) => [p[0] + nx * width * 0.45 + 1, p[1] + ny * width * 0.45 + 1.5]));
  g.stroke();
  for (let k = 0; k < nb; k++) {
    const o = (k / (nb - 1) - 0.5) * width;
    const s0 = rng() * 0.25;
    const s1 = 1 - rng() * 0.25;
    const sh = (rng() - 0.5) * 34 + (k < nb / 2 ? 14 : -10);
    g.strokeStyle = rgba([base[0] + sh, base[1] + sh, base[2] + sh * 0.8], 0.55 + rng() * 0.4);
    g.lineWidth = 1.4 + rng() * 1.2;
    g.beginPath();
    const n = pts.length - 1;
    for (let i = 0; i <= 8; i++) {
      const q = lerp(s0, s1, i / 8);
      const j = Math.min(n - 1, Math.floor(q * n));
      const f = q * n - j;
      const x = lerp(pts[j][0], pts[j + 1][0], f) + nx * o;
      const y = lerp(pts[j][1], pts[j + 1][1], f) + ny * o;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
  }
  g.fillStyle = highlight || 'rgba(255,250,232,0.7)';
  const dots = 2 + width / 3;
  for (let k = 0; k < dots; k++) {
    const q = rng();
    const x = lerp(A[0], B[0], q) - nx * width * 0.3;
    const y = lerp(A[1], B[1], q) - ny * width * 0.3;
    g.beginPath();
    g.arc(x, y, 0.9 + rng(), 0, TAU);
    g.fill();
  }
  g.restore();
}

/**
 * A cut-paper cut-out: a torn-edge silhouette with a white sticker edge and a
 * drop shadow. `rng` is explicit.
 */
export function collageCutout(g, pts, { rng = mulberry32(1), fill = '#cccccc', edge = '#f4f2ec', border = 10, shadow = null } = {}) {
  if (!pts || pts.length < 3) return;
  const cut = cutPolygon(pts, rng, Math.max(5, border * 0.8), border * 0.35);
  g.save();
  if (shadow) {
    g.shadowColor = shadow.color;
    g.shadowBlur = shadow.blur;
    g.shadowOffsetX = shadow.x;
    g.shadowOffsetY = shadow.y;
  }
  if (border > 0) {
    g.strokeStyle = edge;
    g.lineWidth = border * 2;
    g.lineJoin = 'round';
    tracePoly(g, cut);
    g.stroke();
  } else {
    tracePoly(g, cut);
    g.fillStyle = fill;
    g.fill();
  }
  g.restore();
  if (border > 0) {
    tracePoly(g, cut);
    g.fillStyle = fill;
    g.fill();
  }
}

/** A marker-pen highlight that sweeps left-to-right by `q` (0..1). */
export function markerHighlight(g, x0, y0, w, h, q, color = 'rgba(218,207,8,0.9)') {
  if (q <= 0 || w <= 0 || h <= 0) return;
  g.save();
  g.globalCompositeOperation = 'multiply';
  g.fillStyle = color;
  const ww = w * clamp(q, 0, 1);
  g.beginPath();
  g.moveTo(x0, y0 + 4);
  for (let i = 0; i <= 20; i++) g.lineTo(x0 + (ww * i) / 20, y0 + Math.sin(i * 1.7) * 2);
  g.lineTo(x0 + ww + 6, y0 + h / 2);
  g.lineTo(x0 + ww, y0 + h);
  for (let i = 20; i >= 0; i--) g.lineTo(x0 + (ww * i) / 20, y0 + h + Math.sin(i * 2.3) * 2);
  g.closePath();
  g.fill();
  g.restore();
}

/** A torn strip of tape. */
export function tapeStrip(g, x, y, angle, w = 120, color = 'rgba(226,220,200,0.85)') {
  g.save();
  g.translate(x, y);
  g.rotate(angle);
  g.fillStyle = color;
  g.translate(-w / 2, -17);
  tracePoly(g, tornRectPoints(0, 0, w, 34, (x * 7 + y) | 0, 3));
  g.fill();
  g.restore();
}

/** A push pin. */
export function pushPin(g, x, y, color = '#b8433f') {
  g.save();
  g.translate(x, y);
  g.fillStyle = 'rgba(0,0,0,0.25)';
  g.beginPath();
  g.arc(3, 5, 12, 0, TAU);
  g.fill();
  g.fillStyle = color;
  g.beginPath();
  g.arc(0, 0, 12, 0, TAU);
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.55)';
  g.beginPath();
  g.arc(-4, -4, 4, 0, TAU);
  g.fill();
  g.restore();
}

// ---------------------------------------------------------------------------
// The three modes.
// ---------------------------------------------------------------------------

// A flat, low-key underpainting of the whole composition. It is drawn in EVERY
// mode and is never gated by the reveal, so a reveal animates from a clean
// underpainting to a finished picture — it never opens on an empty frame.
function underpaint(g, scene, params, mixAmount) {
  scene.shapes.forEach((shape) => {
    const base = mixRgb(hexToRgb(shape.color), hexToRgb(params.palette.paper), mixAmount);
    tracePoly(g, shape.points);
    g.globalAlpha = 1;
    g.fillStyle = rgba(base, 0.95);
    g.fill();
  });
}

function drawWash(g, scene, params, seed, width, height, reveal) {
  const rng = mulberry32((seed * 1013 + 7) | 0);
  underpaint(g, scene, params, 0.18);
  scene.shapes.forEach((shape, i) => {
    const p = smoothstep(0.1 * i, 0.1 * i + 0.45, reveal);
    if (p <= 0) return;
    watercolorWash(g, shape.points, rgba(hexToRgb(shape.color), 1), {
      rng,
      layers: Math.max(1, Math.round(params.washLayers * p)),
      alpha: params.washAlpha * p,
      amp: params.washAmp,
      edge: params.washEdge,
    });
  });
  paperGrain(g, { width, height, seed: (seed + 11) | 0, density: params.grainDensity, alpha: params.grainAlpha, color: hexToRgb('#2a241f') });
}

function drawBrush(g, scene, params, seed, time, width, height, reveal) {
  const boil = resolveBoil(params, time);
  underpaint(g, scene, params, 0.5);
  const subject = scene.shapes.find((s) => s.role === 'subject');
  if (subject) {
    inkBloom(g, subject.points, { color: rgba(hexToRgb(params.palette.ink), 1), grow: reveal, blur: Math.min(width, height) * 0.02, alpha: 0.16 });
  }
  const strokes = inkStrokes(scene, params, mulberry32((seed * 211 + 3 + boil * 997) | 0));
  strokes.forEach((s, i) => {
    const p = smoothstep(0.07 * i, 0.07 * i + 0.5, reveal);
    if (p <= 0) return;
    const strokeRng = mulberry32((seed * 1000 + i * 13 + 5 + boil * 991) | 0);
    if (s.kind === 'impasto') {
      impastoStroke(g, s.pts, s.width, s.color, null, strokeRng);
    } else {
      inkStroke(g, s.pts, { rng: strokeRng, width: s.width, color: hexToRgb(s.color), tone: s.tone * params.inkTone + (1 - params.inkTone), dry: s.dry * params.inkDry * 2, bristles: params.inkBristles, reveal: p, noiseSeed: i + 1 });
    }
  });
  paperGrain(g, { width, height, seed: (seed + 19) | 0, density: params.grainDensity * 0.7, alpha: params.grainAlpha * 0.8, color: hexToRgb('#2a241f') });
}

function drawCollage(g, scene, params, seed, width, height, reveal) {
  underpaint(g, scene, params, 0.55);
  paperGrain(g, { width, height, seed: (seed + 23) | 0, density: params.grainDensity * 1.4, alpha: params.grainAlpha, color: hexToRgb('#2a241f') });
  const pieces = collagePieces(scene, params, mulberry32((seed * 307 + 11) | 0));
  pieces.forEach((piece, i) => {
    const p = smoothstep(piece.at, piece.at + piece.span, reveal);
    if (p <= 0) return;
    const rng = mulberry32((seed * 1000 + i * 29 + 7) | 0);
    const offset = [(1 - p) * width * 0.22, (1 - p) * height * -0.06];
    const tp = transformPoints(piece.pts, piece.rotate, offset);
    collageCutout(g, tp, {
      rng,
      fill: piece.fill,
      edge: params.palette.paper,
      border: params.collageBorder,
      shadow: params.collageShadow ? { color: 'rgba(50,40,25,0.30)', blur: Math.max(4, params.collageBorder), x: 3, y: 6 } : null,
    });
    const box = boundsOf(tp);
    if (piece.tape) tapeStrip(g, box.cx, box.y, piece.rotate, Math.min(box.w * 0.6, width * 0.16));
    if (piece.pin) pushPin(g, box.cx, box.cy, params.palette.accent);
    if (piece.marker) markerHighlight(g, box.x, box.cy - box.h * 0.1, box.w * p, Math.max(6, box.h * 0.16), 1, 'rgba(218,207,8,0.7)');
  });
}

/**
 * Draw one deterministic frame. `ctx` is the CodeScene render argument:
 * { frame, time, fps, width, height, seed, params, bindings }.
 */
export function renderPaint(canvas, ctx) {
  if (!canvas || typeof canvas.getContext !== 'function') throw new Error('paint: renderPaint needs a canvas element');
  const params = normalizeParams(ctx.params ?? {});
  const width = Math.max(1, Math.floor(ctx.width ?? canvas.width));
  const height = Math.max(1, Math.floor(ctx.height ?? canvas.height));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const g = canvas.getContext('2d');
  const seed = finite(ctx.seed) ? ctx.seed : params.seed;
  const time = finite(ctx.time) ? ctx.time : 0;
  const reveal = resolveReveal(params, time);
  const scene = baseComposition(params.subject, width, height, params.palette);

  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.filter = 'none';
  g.fillStyle = params.palette.paper;
  g.fillRect(0, 0, width, height);

  if (params.mode === 'wash') drawWash(g, scene, params, seed, width, height, reveal);
  else if (params.mode === 'brush') drawBrush(g, scene, params, seed, time, width, height, reveal);
  else drawCollage(g, scene, params, seed, width, height, reveal);

  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.filter = 'none';
  return { mode: params.mode, subject: params.subject, reveal, shapes: scene.shapes.length };
}
