/*
 * Ink wash — a xieyi figure, loaded brushwork and a rice-paper compositor.
 *
 * This is a self-contained, Canvas2D + WebGL2 browser source. Every frame is a
 * pure function of { frame, time, fps, params, seed } and the fixed-size layer
 * cache; nothing reads a wall clock and nothing accumulates between frames.
 *
 * What is adapted from lemo-opuscar styles/ink-wash (commit
 * e3cb16f63768c68693ff0e15171d6e755457cc32, MIT, © 2026 LemoLab):
 *   - ink.js: the stroke model (centreline × pressure profile × width noise ×
 *     bristle load), the wet/dry split, loaded-stroke dark side, blot and mass;
 *   - comp.js: the WebGL2 rice-paper compositor (procedural paper, wet bleed,
 *     edge pigment, dry paper tooth, ink bloom reveal);
 *   - hero.js: the 100-unit side/front figure rig, POSE/mixPose, hat, robe and
 *     sleeve construction, ribbon;
 *   - land.js: ridge function, per-pixel mountain layer, cun, cliff, pine,
 *     reeds, ink rings;
 *   - wave.js: the gesture-built wave body, used here as a low river swell.
 * The exact adopted ranges, file hashes and exclusions are in README.md,
 * rights.mjs and the project's licence handoff.
 *
 * What is original here:
 *   - the two scene clocks (river crossing; pine path), their poses, beats and
 *     camera moves;
 *   - the river/pine staging, bank/rock/path composition and the opening
 *     ink-bloom reveal placement;
 *   - the staff, the vermilion sash and the abstract end chop;
 *   - the single-source WebGL2 layer/compositor wiring and resize handling.
 *
 * Excluded from the upstream film: the written 水 (glyph.js), all inscriptions,
 * subtitles, the whole-film story/shot runner, the face close-up, the sword and
 * its actions, external fonts, music, voice and sound effects. No text is drawn
 * and no font is loaded.
 */

export const DEFAULT_FRAMES = 168;
export const DEFAULT_WIDTH = 1920;
export const DEFAULT_HEIGHT = 1080;

export const TONE = { jiao: 0.96, nong: 0.82, zhong: 0.6, dan: 0.34, qing: 0.16 };

const VERM = [176, 46, 34];
const DESIGN_H = 1080;
const WATER_Y = 812;
const BANK_Y = 796;

const TAU = Math.PI * 2;

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const seg = (t, a, b) => clamp((t - a) / (b - a));
const ss = (t) => {
  t = clamp(t);
  return t * t * (3 - 2 * t);
};
const eo = (t) => 1 - Math.pow(1 - clamp(t), 3);

function mulberry(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hash = (n) => {
  n = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return n - Math.floor(n);
};
const vnoise = (x) => {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return lerp(hash(i), hash(i + 1), u);
};

/* ── brush engine (ink.js) ─────────────────────────────────────────────── */

function densify(P, per = 8) {
  if (P.length < 3) {
    const out = [];
    const [a, b] = [P[0], P[P.length - 1]];
    for (let i = 0; i <= per; i += 1) {
      const t = i / per;
      out.push([lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2] ?? 1, b[2] ?? 1, t)]);
    }
    return out;
  }
  const out = [];
  for (let i = 0; i < P.length - 1; i += 1) {
    const p0 = P[Math.max(0, i - 1)];
    const p1 = P[i];
    const p2 = P[i + 1];
    const p3 = P[Math.min(P.length - 1, i + 2)];
    for (let k = 0; k < per; k += 1) {
      const t = k / per;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a, b, c, d) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1]), lerp(p1[2] ?? 1, p2[2] ?? 1, t)]);
    }
  }
  const l = P[P.length - 1];
  out.push([l[0], l[1], l[2] ?? 1]);
  return out;
}

function resample(D, ds) {
  const acc = [0];
  for (let i = 1; i < D.length; i += 1) {
    acc.push(acc[i - 1] + Math.hypot(D[i][0] - D[i - 1][0], D[i][1] - D[i - 1][1]));
  }
  const L = acc[acc.length - 1] || 1e-6;
  const n = Math.max(2, Math.min(600, Math.ceil(L / ds) + 1));
  const out = [];
  let j = 0;
  for (let i = 0; i < n; i += 1) {
    const s = (L * i) / (n - 1);
    while (j < D.length - 2 && acc[j + 1] < s) j += 1;
    const u = clamp((s - acc[j]) / (acc[j + 1] - acc[j] || 1e-6));
    out.push([lerp(D[j][0], D[j + 1][0], u), lerp(D[j][1], D[j + 1][1], u), lerp(D[j][2], D[j + 1][2], u)]);
  }
  return { pts: out, len: L };
}

// Pressure envelopes: entry load, taper, and the profiles the figure and
// landscape actually use (the calligraphic `na`/`cone` profiles of the source
// were only needed by the excluded 水 glyph and sealed sword).
const PROF = {
  brush: (s) => Math.min(1, 0.45 + (s / 0.1) * 0.55) * Math.pow(1 - s * 0.9, 0.45),
  even: (s) => Math.min(1, 0.55 + (s / 0.05) * 0.45) * Math.min(1, 0.5 + ((1 - s) / 0.06) * 0.5),
  tip: (s) => Math.pow(Math.sin(Math.PI * clamp(s * 0.96 + 0.02)), 0.6),
  lens: (s) => Math.pow(Math.sin(Math.PI * clamp(s)), 0.75),
  nail: (s) => Math.pow(1 - s, 0.7) * Math.min(1, 0.7 + s * 6),
  press: (s) => Math.min(1, 0.3 + (s / 0.15) * 0.7) * Math.min(1, ((1 - s) / 0.12) * 0.8 + 0.2),
  robe: (s) => (0.75 + 0.25 * s) * Math.min(1, (s / 0.05) * 0.5 + 0.5) * Math.min(1, ((1 - s) / 0.08) * 0.7 + 0.3),
  rise: (s) => Math.min(1, 0.12 + (s / 0.14) * 0.88) * Math.min(1, ((1 - s) / 0.08) * 0.7 + 0.3),
  dot: (s) => Math.pow(Math.sin(Math.PI * clamp(s * 0.9 + 0.05)), 0.45),
};

let SEED = 1;

function mk(pts, o = {}) {
  const w = o.w ?? 4;
  const seed = o.seed ?? (SEED = (SEED * 16807) % 2147483647);
  const ds = o.ds ?? Math.max(0.25, w * 0.18);
  const { pts: P, len } = resample(densify(pts, o.per ?? 10), ds);
  const n = P.length;
  const prof = typeof o.prof === 'function' ? o.prof : PROF[o.prof || 'brush'];
  const rough = o.rough ?? 0.12;
  const ws = [];
  const nx = [];
  const ny = [];
  for (let i = 0; i < n; i += 1) {
    const s = i / (n - 1);
    ws.push(
      Math.max(
        w * 0.04,
        w * prof(s) * P[i][2] * (1 + rough * (vnoise(seed * 0.013 + (o.boil || 0) * 0.35 + (s * (o.gapLen ?? len)) / (w * 1.3 + 1)) * 2 - 1)),
      ),
    );
    const a = P[Math.max(0, i - 1)];
    const b = P[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1;
    nx.push(-dy / L);
    ny.push(dx / L);
  }
  const dry = o.dry ?? 0.25;
  let side = o.side || 0;
  if (o.darkDir) {
    let ax = 0;
    let ay = 0;
    for (let i = 0; i < n; i += 1) {
      ax += nx[i];
      ay += ny[i];
    }
    side = Math.abs(o.side || 1) * Math.sign(ax * o.darkDir[0] + ay * o.darkDir[1] || 1);
  }
  const nb = o.nb ?? Math.round(clamp(w * 1.1, 4, 56));
  const R = mulberry(seed);
  const br = [];
  for (let j = 0; j < nb; j += 1) {
    const off = (j + 0.5) / nb - 0.5 + ((R() - 0.5) * 0.6) / nb;
    const edge = Math.abs(off) * 2;
    br.push({
      off,
      bw: (w / nb) * (1 + R() * 1.1),
      a: 0.55 + R() * 0.45,
      ph: R() * 1000,
      load: 1 - dry * (0.15 + 0.85 * edge) * (0.5 + R() * 0.7),
      gs: 0.5 + R() * 1.6,
      end: 1 - R() * dry * 0.35,
    });
  }
  return {
    P,
    n,
    len,
    ws,
    nx,
    ny,
    w,
    tone: o.tone ?? TONE.nong,
    dry,
    wet: o.wet ?? 0,
    br,
    seed,
    fade: o.fade ?? dry * 0.55,
    bodyK: o.body ?? 1,
    brK: o.bristle ?? 1,
    color: o.color || null,
    side,
    brWet: !!o.brWet,
    solid: !!o.solid,
    gapLen: o.gapLen ?? null,
  };
}

// Draw one stroke into {wet, dry, col}; p = progress, am = overall alpha.
function draw(L, s, p = 1, am = 1) {
  if (p <= 0 || am <= 0) return;
  p = clamp(p);
  const { P, n, ws, nx, ny } = s;
  const m = (n - 1) * p;
  const k = Math.floor(m);
  const f = m - k;
  const cnt = f > 0.001 && k < n - 1 ? k + 2 : k + 1;
  const X = (i) => (i <= k ? P[i][0] : lerp(P[k][0], P[k + 1][0], f));
  const Y = (i) => (i <= k ? P[i][1] : lerp(P[k][1], P[k + 1][1], f));
  const CC = s.color ? s.color.join(',') : '0,0,0';
  const WW = (i) => ws[Math.min(i, n - 1)] * (p < 1 && i >= cnt - 2 ? 0.75 : 1);
  const bodyA = s.tone * Math.pow(1 - s.dry, 1.6) * s.bodyK * am;
  if (bodyA > 0.004) {
    const path = new Path2D();
    for (let i = 0; i < cnt; i += 1) {
      const j = Math.min(i, n - 1);
      const hw = WW(i) / 2;
      const x = X(i) + nx[j] * hw;
      const y = Y(i) + ny[j] * hw;
      if (i) path.lineTo(x, y);
      else path.moveTo(x, y);
    }
    for (let i = cnt - 1; i >= 0; i -= 1) {
      const j = Math.min(i, n - 1);
      const hw = WW(i) / 2;
      path.lineTo(X(i) - nx[j] * hw, Y(i) - ny[j] * hw);
    }
    path.closePath();
    const g = (c, a) => {
      if (a <= 0.003) return;
      const gr = c.createLinearGradient(P[0][0], P[0][1], P[n - 1][0], P[n - 1][1]);
      gr.addColorStop(0, `rgba(${CC},${clamp(a)})`);
      gr.addColorStop(1, `rgba(${CC},${clamp(a * (1 - s.fade))})`);
      c.fillStyle = gr;
      c.fill(path);
    };
    if (s.color) {
      if (L.col) g(L.col, bodyA);
    } else if (s.solid) {
      if (L.dry) g(L.dry, bodyA * 0.92);
      if (L.wet && s.wet > 0) g(L.wet, bodyA * s.wet);
    } else {
      if (s.wet > 0 && L.wet) g(L.wet, bodyA * s.wet);
      if (s.wet < 1 && L.dry) g(L.dry, bodyA * (1 - s.wet) * 0.8);
    }
  }
  // Bristle tracks: dry brush flying white, or wet bristles inside a loaded
  // stroke (brWet) so the dark side carries the contour.
  const c = s.color ? L.col : s.brWet ? L.wet : L.dry;
  if (!c || s.brK <= 0) return;
  const brA = s.tone * am * s.brK * (s.brWet ? 1 : s.wet > 0.6 ? 0.12 : 1);
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.strokeStyle = `rgb(${CC})`;
  const dsl = (s.gapLen ?? s.len) / (n - 1);
  for (const b of s.br) {
    const e = Math.min(m, (n - 1) * b.end);
    const kk = Math.floor(e);
    if (kk < 1) continue;
    const lat = s.side ? lerp(1 - Math.abs(s.side), 1, clamp(b.off * Math.sign(s.side) * 1.6 + 0.5)) : 1;
    c.globalAlpha = clamp(brA * b.a * lat);
    c.lineWidth = b.bw;
    c.beginPath();
    let on = false;
    const gsc = Math.max(6, s.w * 1.4) * b.gs;
    for (let i = 0; i <= kk; i += 1) {
      const u = i / (n - 1);
      const sl = i * dsl;
      const ink = b.load - s.dry * (0.08 + 1.15 * Math.pow(u, 1.25));
      const v =
        ink +
        (vnoise(b.ph + sl / gsc) - 0.5) * 0.9 * s.dry +
        (vnoise(b.ph * 1.7 + sl / (gsc * 0.18)) - 0.5) * 0.25 * s.dry;
      if (v > 0.42 * s.dry + 0.02) {
        const hw = ws[i] * (b.off + (vnoise(b.ph * 3 + sl / (gsc * 2)) - 0.5) * 0.07);
        const x = P[i][0] + nx[i] * hw;
        const y = P[i][1] + ny[i] * hw;
        if (on) c.lineTo(x, y);
        else c.moveTo(x, y);
        on = true;
      } else on = false;
    }
    c.stroke();
  }
  c.globalAlpha = 1;
}

// A pressed blot: moss dot, spray, ink drop.
function blot(c, x, y, r, a, rot = 0, sq = 1, seed = 0) {
  if (a <= 0.003 || r <= 0.05) return;
  c.save();
  c.translate(x, y);
  c.rotate(rot);
  c.scale(1, sq);
  c.globalAlpha = clamp(a);
  c.fillStyle = '#000';
  c.beginPath();
  const N = 18;
  const ph = seed * 7.13 + x * 0.01;
  for (let i = 0; i <= N; i += 1) {
    const t = (i / N) * TAU;
    const rr = r * (0.78 + 0.44 * vnoise(ph + i * 0.9) + 0.12 * Math.sin(t * 3 + ph));
    if (i) c.lineTo(Math.cos(t) * rr, Math.sin(t) * rr);
    else c.moveTo(Math.cos(t) * rr, Math.sin(t) * rr);
  }
  c.fill();
  c.restore();
  c.globalAlpha = 1;
}

// A wet mass polygon (hat, robe wash, bank): jittered edge and optional
// linear alpha gradient.
function mass(c, poly, a, jit = 0, seed = 0, g = null) {
  if (a <= 0.003) return;
  const pts = [];
  const N = poly.length;
  for (let i = 0; i < N; i += 1) {
    const p = poly[i];
    const q = poly[(i + 1) % N];
    const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const k = jit ? Math.max(1, Math.min(24, Math.round(L / Math.max(2, jit * 2.5)))) : 1;
    const nx = -(q[1] - p[1]) / (L || 1);
    const ny = (q[0] - p[0]) / (L || 1);
    for (let j = 0; j < k; j += 1) {
      const u = j / k;
      const d = jit ? (vnoise(seed * 3.1 + i * 5.3 + u * k * 0.8) - 0.5) * jit * 2 : 0;
      pts.push([lerp(p[0], q[0], u) + nx * d, lerp(p[1], q[1], u) + ny * d]);
    }
  }
  c.globalAlpha = 1;
  if (g) {
    const gr = c.createLinearGradient(g[0], g[1], g[2], g[3]);
    gr.addColorStop(0, `rgba(0,0,0,${clamp(a * g[4])})`);
    gr.addColorStop(1, `rgba(0,0,0,${clamp(a * g[5])})`);
    c.fillStyle = gr;
  } else {
    c.fillStyle = `rgba(0,0,0,${clamp(a)})`;
  }
  c.beginPath();
  pts.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])));
  c.closePath();
  c.fill();
}

/* ── figure (hero.js) ─────────────────────────────────────────────────── */

// Side: H hip, C chest, Hd head, aF/aB front/back arm [shoulder, elbow, hand],
// lF/lB front/back leg [hip, knee, foot], hemF/hemB hem points, flare, rib.
// Front/back-facing poses carry aL/aR and lL/lR.
export const POSE = {
  stand: {
    v: 'side', H: [-0.5, -46], C: [1.5, -75], Hd: [3.5, -83], tilt: 0.03,
    aF: [[2.5, -74], [7, -60], [11.5, -50]], aB: null,
    lF: [[1, -46], [3, -23], [4, 0]], lB: [[-1, -46], [-2, -23], [-4, 0]],
    hemF: [10, -6], hemB: [-14, -6.5], flare: 0.6, rib: [-1, 0.08, 22],
  },
  leap: {
    v: 'side', H: [0, -52], C: [14, -70], Hd: [21, -76.5], tilt: -0.28,
    aF: [[13, -69], [3, -64.5], [-8, -63]], aB: [[12, -69.5], [1, -71], [-11, -73.5]],
    lF: [[2, -52], [15, -47], [6, -38]], lB: [[-1, -52], [-11, -44], [-20, -38]],
    hemF: [11, -43], hemB: [-44, -58], flare: 1.5, rib: [-1, -0.2, 46],
  },
  touch: {
    v: 'side', H: [0, -46], C: [8, -72], Hd: [12.5, -80], tilt: -0.14,
    aF: [[8, -71], [0, -64], [-9, -60]], aB: [[7, -71.5], [-2, -71], [-12, -72]],
    lF: [[1, -46], [5, -23], [3, 0]], lB: [[-1, -46], [11, -38], [4, -28]],
    hemF: [10, -9], hemB: [-32, -30], flare: 1.2, rib: [-1, -0.05, 34],
  },
  skid: {
    v: 'side', H: [-3, -38], C: [-5, -65], Hd: [-3.5, -73.5], tilt: 0.08,
    aF: [[-4, -64], [5, -56], [13, -54]], aB: [[-6, -64], [-15, -58], [-23, -62]],
    lF: [[-2, -38], [10, -21], [20, 0]], lB: [[-4, -38], [-10, -18], [-14, 0]],
    hemF: [16, -6], hemB: [-12, -4], flare: -0.4, rib: [1, 0.05, 18],
  },
  walk1: {
    v: 'side', H: [0, -46], C: [1.5, -75], Hd: [3.5, -83], tilt: 0,
    aF: [[2, -74], [7, -60], [11.5, -50]], aB: null,
    lF: [[1, -46], [5, -23], [8, 0]], lB: [[-1, -46], [-4, -23], [-8, 0]],
    hemF: [12, -6], hemB: [-13, -5.5], flare: 0.3, rib: [-1, 0.08, 22],
  },
  walk2: {
    v: 'side', H: [0, -47], C: [1.5, -76], Hd: [3.5, -84], tilt: 0,
    aF: [[2, -75], [7, -61], [11.5, -51]], aB: null,
    lF: [[1, -47], [1, -24], [0, -1]], lB: [[-1, -47], [-1, -24], [1, -2]],
    hemF: [10, -6], hemB: [-12, -5.5], flare: 0.3, rib: [-1, 0.08, 22],
  },
  front: {
    v: 'front', H: [0, -46], C: [0, -75], Hd: [0, -83], tilt: 0,
    aL: [[-8.5, -74], [-11, -60], [-11.5, -48]], aR: [[8.5, -74], [11, -60], [11.5, -48]],
    lL: [[-3, -46], [-4, -23], [-4.5, 0]], lR: [[3, -46], [4, -23], [4.5, 0]],
    hemL: [-14, -5.5], hemR: [14, -5.5], rib: [0, 1, 0],
  },
  bow: {
    v: 'front', H: [0, -46], C: [0, -73.5], Hd: [0, -78.8], tilt: 0.06,
    aL: [[-8.5, -73], [-13, -63], [-2.5, -64.5]], aR: [[8.5, -73], [13, -63], [2.5, -64.5]],
    lL: [[-3, -46], [-4, -23], [-4.5, 0]], lR: [[3, -46], [4, -23], [4.5, 0]],
    hemL: [-14, -5.5], hemR: [14, -5.5], fist: 1, rib: [0, 1, 0],
  },
};

export function mixPose(a, b, t) {
  if (typeof a === 'number' && typeof b === 'number') return lerp(a, b, t);
  if (Array.isArray(a) && Array.isArray(b)) return a.map((x, i) => mixPose(x, b[i], t));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const o = {};
    for (const k in b) o[k] = k in a ? mixPose(a[k], b[k], t) : b[k];
    return o;
  }
  return t < 0.5 ? a : b;
}

const add2 = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mid = (a, b, t = 0.5) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
const rot = (p, c, a) => {
  const s = Math.sin(a);
  const co = Math.cos(a);
  const x = p[0] - c[0];
  const y = p[1] - c[1];
  return [c[0] + x * co - y * s, c[1] + x * s + y * co];
};

function legBelow(l, hemY) {
  const [hp, kn, ft] = l;
  if (kn[1] >= hemY) {
    const u = clamp((hemY - hp[1]) / (kn[1] - hp[1] || 1));
    return [mid(hp, kn, u), kn, ft];
  }
  const u = clamp((hemY - kn[1]) / (ft[1] - kn[1] || 1));
  return [mid(kn, ft, u), ft];
}

function hatStrokes(S, Hd, tilt, half = 20, M, skew = 0) {
  const R = (p) => rot(p, Hd, tilt);
  const by = Hd[1] - 3;
  const ap = [Hd[0] + skew, by - 11.5];
  const bl = [Hd[0] - half * 0.92, by + 0.4];
  const br = [Hd[0] + half * 1.05, by + 0.8];
  const bc = [Hd[0] + skew * 0.3, by + 1.6];
  // One wet mass for the cone, two dry ridge strokes, one burnt brim line.
  M([R(ap), R(add2(mid(ap, bl), [-0.6, -0.8])), R(bl), R(bc), R(br), R(add2(mid(ap, br), [0.6, -0.8]))], 0.5);
  S([R(add2(bl, [2, -1])), R(add2(bc, [0, -1.6])), R(add2(br, [-2, -1]))], LOAD(4, 0.55, [0, 1], { dry: 0.5, prof: 'lens' }));
  S([R(add2(ap, [-0.3, 0.3])), R(add2(mid(ap, bl), [-0.6, -0.6])), R(bl)], { w: 2.4, tone: TONE.jiao, wet: 0.2, dry: 0.5, prof: 'nail' });
  S([R(add2(ap, [0.3, 0.3])), R(add2(mid(ap, br), [0.6, -0.6])), R(br)], { w: 2.2, tone: TONE.jiao, wet: 0.2, dry: 0.55, prof: 'nail' });
  S([R(add2(ap, [0.5, 2.5])), R(mid(bl, br, 0.62))], { w: 1, tone: TONE.nong, dry: 0.85, prof: 'tip' });
  S([R([bl[0] - 1.2, bl[1] + 0.2]), R(bc), R([br[0] + 1.2, br[1] + 0.2])], { w: 1.9, tone: TONE.jiao, wet: 0.1, dry: 0.45, prof: 'tip' });
}

function ribbon(S, p0, rib, t, w = 1.5) {
  const [dx, dy, L] = rib;
  if (L <= 0) return;
  const pts = [];
  const n = 6;
  for (let i = 0; i <= n; i += 1) {
    const u = i / n;
    const wav = Math.sin(t * 6.3 - u * 5.5) * 2.2 * u;
    pts.push([p0[0] + dx * L * u - dy * wav, p0[1] + dy * L * u + dx * wav * 0.9 + u * u * 2]);
  }
  S(pts, { w, tone: TONE.zhong, dry: 0.45, wet: 0.1, prof: 'tip' });
}

// The vermilion sash end. Only the colour layer receives it, exactly one accent
// per figure.
function sash(S, x, y, t, side = 1) {
  const sway = Math.sin(t * 2.3 + side) * 1.2;
  S(
    [
      [x, y],
      [x + side * 1.5 + sway, y + 7],
      [x + side * 3 + sway * 1.5, y + 14],
    ],
    { w: 1.9, tone: 0.92, dry: 0.3, prof: 'tip', color: VERM, nb: 4 },
  );
}

const curve = (a, c, b, n) => {
  const o = [];
  for (let i = 0; i < n; i += 1) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const u = 1 - t;
    o.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]);
  }
  return o;
};

// A loaded stroke: ink at the tip, water at the root; the dark side IS the
// contour (boneless painting).
const LOAD = (w, tone, dark, o = {}) => ({
  w,
  tone,
  darkDir: dark,
  side: o.side ?? 0.85,
  brWet: true,
  body: o.body ?? 0.18,
  dry: o.dry ?? 0.38,
  wet: 0.9,
  prof: o.prof || 'robe',
  nb: o.nb,
  rough: 0.12,
});

function faceSide(S, Hd, tilt) {
  const R = (p) => rot(p, Hd, tilt);
  S([R([Hd[0] + 0.5, Hd[1] - 1.5]), R([Hd[0] + 2.2, Hd[1] + 2.2]), R([Hd[0] + 1.2, Hd[1] + 4.8])], { w: 5.5, tone: 0.1, wet: 1, dry: 0, prof: 'lens' });
  S([R([Hd[0] - 2.5, Hd[1] - 2]), R([Hd[0] + 3.5, Hd[1] - 2.2])], { w: 2.4, tone: 0.3, wet: 1, dry: 0.1, prof: 'lens' });
  S([R([Hd[0] + 3.4, Hd[1] - 1.8]), R([Hd[0] + 4.6, Hd[1] + 0.8]), R([Hd[0] + 3.6, Hd[1] + 2]), R([Hd[0] + 4, Hd[1] + 3.6]), R([Hd[0] + 2.4, Hd[1] + 5.2])], { w: 1.2, tone: TONE.nong, dry: 0.35, prof: 'tip' });
  S([R([Hd[0] + 3.2, Hd[1] + 4.3]), R([Hd[0] + 2.4, Hd[1] + 8.2])], { w: 1.1, tone: TONE.nong, dry: 0.55, prof: 'tip' });
  S([R([Hd[0] - 2.6, Hd[1] - 1.5]), R([Hd[0] - 3.2, Hd[1] + 2.5])], { w: 2.2, tone: TONE.nong, wet: 0.3, dry: 0.4, prof: 'tip' });
}

function sideStrokes(P, S, M, t, staff) {
  const [hx, hy] = P.H;
  const [, cy] = P.C;
  const Hd = P.Hd;
  const nape = [Hd[0] - 3.5, Hd[1] + 5];
  const bw = [hx - 7, hy - 1];
  const fw = [hx + 7, hy - 2];
  const chestF = [P.C[0] + 5, cy + 1.5];
  const tail = [P.hemB[0] - 6 * P.flare, P.hemB[1] - 3 * Math.abs(P.flare)];
  const hemC = [lerp(P.hemB[0], P.hemF[0], 0.5), Math.max(P.hemB[1], P.hemF[1]) + 1];
  const hem = curve(tail, hemC, P.hemF, 4);
  const hemCurve = curve(tail, hemC, P.hemF, 40);
  const hemAt = (x) => {
    let best = hem[0][1];
    let bd = 1e9;
    for (let i = 0; i < 40; i += 1) {
      const q = hemCurve[i];
      const d = Math.abs(q[0] - x);
      if (d < bd) {
        bd = d;
        best = q[1];
      }
    }
    return best;
  };
  // Back arm, palest.
  if (P.aB) {
    const [s, e, h] = P.aB;
    S([s, e, h], LOAD(7.5, 0.4, [0, 1], { dry: 0.5 }));
  }
  // Legs under the hem.
  for (const l of [P.lB, P.lF]) {
    const kx = lerp(l[1][0], l[2][0], 0.3);
    S(legBelow(l, hemAt(kx) + 1.5), { w: 2, tone: TONE.nong, dry: 0.4, wet: 0.1, prof: 'even' });
    const ft = l[2];
    S([[ft[0] - 1, ft[1] - 0.3], [ft[0] + 4, ft[1] + 0.3]], { w: 2.8, tone: TONE.jiao, dry: 0.2, wet: 0.2, prof: 'nail' });
  }
  // Robe: one pale mass, two loaded strokes (dark edge at back and front).
  M([nape, chestF, add2(fw, [1, 0]), P.hemF, ...hem.slice(1, -1).reverse(), tail, add2(bw, [-1, 0])], 0.19 + 0.05 * clamp(P.flare - 0.8));
  S([[nape[0] + 0.5, nape[1] - 1], add2(mid(nape, bw), [-1.6, 0]), [bw[0] - 0.8, bw[1]], add2(mid(bw, tail, 0.55), [-1.4, 0]), tail], LOAD(10, 0.78, [-1, 0], { dry: 0.42 }));
  S([[chestF[0] - 1, chestF[1] - 1.5], add2(mid(chestF, fw), [1, 0]), fw, add2(mid(fw, P.hemF), [0.6, 0]), P.hemF], LOAD(7, 0.55, [1, 0], { dry: 0.5 }));
  // Folds.
  S([add2(mid(nape, chestF, 0.5), [0, 7]), add2(mid(bw, fw, 0.45), [0, 2]), hem[1]], { w: 1.2, tone: TONE.zhong, dry: 0.75, prof: 'tip' });
  // Crossed collar.
  S([[Hd[0] - 1.5, Hd[1] + 6], [P.C[0] + 3.5, cy + 3.5], [fw[0] - 1, fw[1] - 6]], { w: 2.1, tone: TONE.nong, dry: 0.45, prof: 'tip' });
  // Hem line.
  S(hem.map((p, i) => [p[0], p[1] + (i === 0 || i === hem.length - 1 ? 0 : 0.8)]), { w: 1.6, tone: TONE.zhong, dry: 0.7, prof: 'tip' });
  // Belt, burnt ink.
  S([[bw[0] - 1, bw[1] - 1.5], [hx, hy - 2.5], [fw[0] + 1.2, fw[1] - 2]], { w: 3.4, tone: TONE.jiao, dry: 0.3, wet: 0.2, prof: 'nail' });
  sash(S, bw[0] + 1, bw[1] - 0.5, t, 1);
  // Staff (a walking staff, not a weapon). Drawn before the front sleeve so the
  // hand closes over the grip.
  if (staff) {
    const hand = P.aF[2];
    const plant = staff.plant ?? 8;
    S([[hand[0] + 4, -100], [hand[0] + 9, -50], [hand[0] + plant, 1]], { w: 3.4, tone: 0.8, dry: 0.3, wet: 0.2, prof: 'even', nb: 5 });
    S([[hand[0] + 4, -100], [hand[0] + 3.4, -93]], { w: 3.9, tone: TONE.jiao, dry: 0.42, prof: 'nail' });
  }
  // Front sleeve: one pale mass, one loaded stroke, one cuff.
  {
    const [sh, e, h] = P.aF;
    const droop = add2(mid(e, h, 0.6), [-0.5, 7.5]);
    M([add2(sh, [-2, -1]), add2(e, [0, -2]), add2(h, [0, -2.2]), add2(h, [0.5, 4]), droop, add2(e, [-1, 3])], 0.12);
    S([[sh[0] - 1, sh[1] - 0.5], add2(e, [0, 1]), add2(h, [0, 0.5])], LOAD(7, 0.5, [0, 1], { dry: 0.45 }));
    S([add2(e, [-0.5, 3]), droop, add2(h, [0.4, 4.2])], LOAD(3.5, 0.7, [0, 1], { dry: 0.5, prof: 'tip' }));
    S([add2(h, [-0.4, -1.5]), add2(h, [0.3, 3.2])], { w: 1.8, tone: TONE.nong, dry: 0.45, prof: 'tip' });
  }
  // Face, hat, ribbon.
  faceSide(S, Hd, P.tilt);
  hatStrokes(S, Hd, P.tilt, 20, M, -1);
  const R = (p) => rot(p, Hd, P.tilt);
  ribbon(S, R([Hd[0] - 4, Hd[1] - 1]), P.rib, t);
}

function frontStrokes(P, S, M, t) {
  const [hx, hy] = P.H;
  const [, cy] = P.C;
  const Hd = P.Hd;
  const sL = [P.C[0] - 8.5, cy + 1.5];
  const sR = [P.C[0] + 8.5, cy + 1.5];
  const nL = [Hd[0] - 4.5, Hd[1] + 6];
  const nR = [Hd[0] + 4.5, Hd[1] + 6];
  const wL = [hx - 7.5, hy - 1];
  const wR = [hx + 7.5, hy - 1];
  const hemC = [hx, Math.max(P.hemL[1], P.hemR[1]) + 1.2];
  const hem = curve(P.hemL, hemC, P.hemR, 5);
  const sleeve = (a, side) => {
    const [sh, e, h] = a;
    const droop = add2(mid(e, h, 0.55), [side * 2.5, 8]);
    M([add2(sh, [-side * 2, -1]), add2(e, [side * 1.5, -1]), add2(h, [0, -1.5]), add2(h, [0, 4]), droop, add2(e, [-side * 1, 3])], 0.12);
    S([sh, add2(e, [side * 1, 1]), h], LOAD(7, 0.5, [side, 0.3], { dry: 0.45 }));
    S([add2(e, [side * 1.5, 3]), droop, add2(h, [0, 4.2])], LOAD(3.5, 0.66, [side, 1], { dry: 0.5, prof: 'tip' }));
  };
  for (const l of [P.lL, P.lR]) {
    S(legBelow(l, hemC[1] - 3), { w: 2.2, tone: TONE.nong, dry: 0.35, wet: 0.1, prof: 'even' });
    const ft = l[2];
    S([[ft[0] - 1.8, ft[1]], [ft[0] + 1.8, ft[1] + 0.3]], { w: 3, tone: TONE.jiao, dry: 0.2, wet: 0.2, prof: 'even' });
  }
  M([nL, sL, add2(wL, [-1, 0]), ...hem, add2(wR, [1, 0]), sR, nR], 0.19);
  S([add2(nL, [-0.5, -1]), add2(mid(sL, wL), [-1.2, 0]), add2(wL, [-0.8, 0]), add2(mid(wL, P.hemL), [-0.8, 0]), P.hemL], LOAD(8.5, 0.66, [-1, 0], { dry: 0.42 }));
  S([add2(nR, [0.5, -1]), add2(mid(sR, wR), [1.2, 0]), add2(wR, [0.8, 0]), add2(mid(wR, P.hemR), [0.8, 0]), P.hemR], LOAD(8, 0.6, [1, 0], { dry: 0.46 }));
  S(hem, { w: 1.5, tone: TONE.zhong, dry: 0.7, prof: 'tip' });
  S([[Hd[0] - 4, Hd[1] + 5.5], [Hd[0] + 1, cy + 4], [hx + 4.5, hy - 4]], { w: 2.2, tone: TONE.nong, dry: 0.45, prof: 'tip' });
  S([[Hd[0] + 4, Hd[1] + 5.5], [Hd[0] + 1.5, cy + 2]], { w: 2, tone: TONE.nong, dry: 0.45, prof: 'tip' });
  S([add2(wL, [3, 3]), add2(hem[1], [0.8, -1])], { w: 1.1, tone: TONE.zhong, dry: 0.75, prof: 'tip' });
  S([add2(wR, [-2.5, 3]), add2(hem[3], [-0.8, -1])], { w: 1.1, tone: TONE.zhong, dry: 0.75, prof: 'tip' });
  S([[wL[0] - 1, wL[1] - 2.5], [hx, hy - 3.2], [wR[0] + 1, wR[1] - 2.5]], { w: 3.4, tone: TONE.jiao, dry: 0.3, wet: 0.2, prof: 'nail' });
  sash(S, wL[0] + 3.5, wL[1] - 1, t, 1);
  sleeve(P.aL, -1);
  sleeve(P.aR, 1);
  if (P.fist) {
    const h = mid(P.aL[2], P.aR[2]);
    // One dark fist reads the salute: the pale sleeve edges stop at it and the
    // small mass is the only solid shape at the centre of the V.
    M(
      [
        add2(h, [-3.4, -1.2]), add2(h, [-2.4, -3.0]), add2(h, [0.4, -3.4]),
        add2(h, [3.2, -2.2]), add2(h, [3.6, 0.4]), add2(h, [1.8, 2.6]),
        add2(h, [-1.4, 2.8]), add2(h, [-3.2, 1.4]),
      ],
      0.62,
    );
    S([add2(h, [-3.4, -1.2]), add2(h, [-2.4, -3.0]), add2(h, [0.4, -3.4]), add2(h, [3.2, -2.2])], { w: 1.3, tone: TONE.jiao, dry: 0.3, prof: 'tip' });
    S([add2(h, [-1.6, -1.0]), add2(h, [1.8, -0.8])], { w: 1.0, tone: TONE.nong, dry: 0.55, prof: 'tip' });
  } else {
    for (const a of [P.aL, P.aR]) {
      const h = a[2];
      S([add2(h, [0, 3.8]), add2(h, [0, 6.2])], { w: 2.6, tone: 0.2, wet: 0.7, dry: 0.1, prof: 'dot' });
    }
  }
  const R = (p) => rot(p, Hd, P.tilt);
  S([R([Hd[0], Hd[1] - 1.5]), R([Hd[0], Hd[1] + 3])], { w: 7, tone: 0.1, wet: 1, dry: 0, prof: 'lens' });
  S([R([Hd[0] - 4, Hd[1] - 2.2]), R([Hd[0] + 4, Hd[1] - 2.2])], { w: 2.4, tone: 0.3, wet: 1, dry: 0.1, prof: 'lens' });
  S([R([Hd[0] - 3.4, Hd[1] + 0.5]), R([Hd[0] - 2.2, Hd[1] + 3.6]), R([Hd[0], Hd[1] + 4.6]), R([Hd[0] + 2.2, Hd[1] + 3.6]), R([Hd[0] + 3.4, Hd[1] + 0.5])], { w: 1.1, tone: TONE.nong, dry: 0.45, prof: 'tip' });
  S([R([Hd[0], Hd[1] + 3.8]), R([Hd[0] + 0.3, Hd[1] + 7.5])], { w: 1.2, tone: TONE.nong, dry: 0.55, prof: 'tip' });
  S([R([Hd[0] - 2.2, Hd[1] + 1.4]), R([Hd[0], Hd[1] + 1]), R([Hd[0] + 2.2, Hd[1] + 1.4])], { w: 1, tone: TONE.nong, dry: 0.5, prof: 'tip' });
  S([R([Hd[0] - 3.8, Hd[1] - 1.5]), R([Hd[0] - 4.2, Hd[1] + 2])], { w: 1.8, tone: TONE.nong, wet: 0.3, dry: 0.4, prof: 'tip' });
  if (P.eyes) {
    // Closed smiling eyes for the salute.
    S([R([Hd[0] - 3.2, Hd[1] - 0.2]), R([Hd[0] - 1.9, Hd[1] - 0.9]), R([Hd[0] - 0.8, Hd[1] - 0.2])], { w: 0.9, tone: TONE.jiao, dry: 0.3, prof: 'tip' });
    S([R([Hd[0] + 0.8, Hd[1] - 0.2]), R([Hd[0] + 1.9, Hd[1] - 0.9]), R([Hd[0] + 3.2, Hd[1] - 0.2])], { w: 0.9, tone: TONE.jiao, dry: 0.3, prof: 'tip' });
  }
  S([R([Hd[0] + 3.8, Hd[1] - 1.5]), R([Hd[0] + 4.2, Hd[1] + 2])], { w: 1.8, tone: TONE.nong, wet: 0.3, dry: 0.4, prof: 'tip' });
  hatStrokes(S, Hd, P.tilt, 20, M);
}

// Draw the figure. X: {x, y, s, dir, seed, t, am, boil, staff}.
export function hero(L, pose, X = {}) {
  const x0 = X.x ?? 0;
  const y0 = X.y ?? 0;
  const sc = X.s ?? 1;
  const dir = X.dir ?? 1;
  const t = X.t ?? 0;
  const am = X.am ?? 1;
  const list = [];
  let idx = 0;
  const T = (p) => [x0 + p[0] * sc * dir, y0 + p[1] * sc, p[2] ?? 1];
  const S = (pts, o) => {
    const oo = {
      ...o,
      w: o.w * sc,
      seed: (X.seed ?? 7) * 1000 + idx * 97,
      gapLen: 45 * sc,
      boil: X.boil ? Math.floor(X.boil) % 5 : 0,
    };
    if (o.darkDir) oo.darkDir = [o.darkDir[0] * dir, o.darkDir[1]];
    idx += 1;
    list.push({ s: mk(pts.map(T), oo) });
  };
  const M = (poly, a) => {
    list.push({ m: poly.map(T), a, seed: idx });
    idx += 1;
  };
  if (pose.v === 'side') sideStrokes(pose, S, M, t, X.staff);
  else frontStrokes(pose, S, M, t);
  const p = X.p ?? 1;
  const N = list.length;
  for (let i = 0; i < N; i += 1) {
    const it = list[i];
    const pi = p >= 1 ? 1 : (p - (i / N) * 0.8) / 0.25;
    if (pi <= 0) continue;
    if (it.s) draw(L, it.s, pi, am);
    else mass(L.wet, it.m, it.a * am * clamp(pi), 0.6 * sc, it.seed);
  }
}

/* ── landscape (land.js) ───────────────────────────────────────────────── */

const fbm1 = (x) => vnoise(x) * 0.55 + vnoise(x * 2.1 + 17) * 0.28 + vnoise(x * 4.7 + 41) * 0.17;

const h2 = (x, y) => {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
};
function vn2(x, y) {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const f = x - i;
  const g = y - j;
  const u = f * f * (3 - 2 * f);
  const v = g * g * (3 - 2 * g);
  return lerp(lerp(h2(i, j), h2(i + 1, j), u), lerp(h2(i, j + 1), h2(i + 1, j + 1), u), v);
}
const fbm2 = (x, y) => vn2(x, y) * 0.5 + vn2(x * 2.07 + 5.1, y * 2.07 + 1.3) * 0.3 + vn2(x * 4.3 + 9, y * 4.3 + 3) * 0.2;

export function ridgeFn(peaks, base, seed = 1, rough = 18) {
  return (x) => {
    let y = 0;
    for (const [px, h, w] of peaks) {
      const d = Math.abs(x - px) / w;
      y = Math.max(y, h * Math.exp(-Math.pow(d, 1.7)) * (1 - 0.12 * Math.exp(-d * d * 30)));
    }
    const n =
      (fbm1(x * 0.004 + seed) - 0.5) * rough +
      (vnoise(x * 0.018 + seed * 3) - 0.5) * rough * 0.45 +
      (vnoise(x * 0.07 + seed * 5) - 0.5) * rough * 0.12;
    return base - y * (1 + (vnoise(x * 0.01 + seed) - 0.5) * 0.25) - n;
  };
}

// A mountain body: dark ridge line fading downward into a mist cut. Pixels are
// computed once per cached build, in output pixels.
export function mountainLayer(o) {
  const W = Math.round(o.W);
  const H = Math.round(o.H);
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const c = cv.getContext('2d');
  const img = c.createImageData(W, H);
  const D = img.data;
  const sd = o.seed || 1;
  const depth = o.depth;
  const rimW = o.rimW || 16;
  for (let x = 0; x < W; x += 1) {
    const r = o.ridge(x + (o.x0 || 0));
    const y0 = Math.max(0, Math.floor(r));
    const colK = 0.8 + 0.4 * vn2(x * 0.012 + sd, 3.3);
    const xm = o.xmask ? o.xmask(x + (o.x0 || 0)) : 1;
    if (xm <= 0) continue;
    for (let y = y0; y < Math.min(H, r + depth); y += 1) {
      const d = y - r;
      if (d < -1) continue;
      const cover = d < 0 ? 1 + d : 1;
      const f = Math.pow(1 - d / depth, 1.6);
      const tex = 0.7 + 0.6 * fbm2((x + (o.x0 || 0)) * 0.018 + sd, y * 0.03);
      const mist = o.mist ? clamp(1 - o.mist * Math.max(0, fbm2((x + (o.x0 || 0)) * 0.0025 + sd * 2, y * 0.012) - 0.38) * 3.2) : 1;
      const a = o.tone * (f * 0.6 * tex + Math.exp(-d / rimW) * (o.rim ?? 0.7) * colK) * mist * cover * xm;
      D[(y * W + x) * 4 + 3] = Math.min(255, a * 255);
    }
  }
  c.putImageData(img, 0, 0);
  return cv;
}

export function cun(L, o) {
  const R = mulberry(o.seed || 1);
  const nC = Math.round(((o.x1 - o.x0) / 100) * (o.cun ?? 1.2));
  for (let i = 0; i < nC; i += 1) {
    const x = lerp(o.x0 + 20, o.x1 - 20, R());
    const y = o.ridge(x) + 4 + R() * 30 * (o.cunDepth || 1);
    const sl = (o.ridge(x + 8) - o.ridge(x - 8)) / 16;
    const len = (25 + R() * 60) * (o.cunLen || 1);
    const dx = clamp(sl * len * 0.8, -len * 0.7, len * 0.7);
    const pts = [[x, y], [x + dx * 0.45 + (R() - 0.5) * 6, y + len * 0.5], [x + dx * 0.8, y + len]];
    draw(L, mk(pts, { w: (7 + R() * 9) * (o.cunW || 1), tone: o.tone * (1.3 + R() * 0.8), darkDir: [-1, 0], side: 0.7, brWet: true, body: 0.25, dry: 0.6 + R() * 0.2, wet: 0.8, prof: 'tip', seed: (o.seed || 1) * 1000 + i }), 1, 0.75);
  }
  const nM = Math.round(((o.x1 - o.x0) / 100) * (o.moss ?? 1.5));
  for (let i = 0; i < nM; i += 1) {
    const x = lerp(o.x0 + 10, o.x1 - 10, R());
    const y = o.ridge(x) + R() * 8;
    for (let k = 0; k < 3; k += 1) {
      blot(L.wet, x + (R() - 0.5) * 14, y + R() * 5, (1.2 + R() * 2.2) * (o.mossR || 1), clamp(o.tone * 3), R() * 3, 0.6 + R() * 0.3, (o.seed || 1) + i * 3 + k);
    }
  }
}

// Cliff: outline, axe-cut texture, shadow wash and moss.
export function cliff(L, x, y, s, seed = 3, flip = 1) {
  const R = mulberry(seed);
  const T = (p) => [x + p[0] * s * flip, y + p[1] * s];
  const top = [[-40, 3], [0, -1], [45, 1], [90, -2], [128, 1], [152, 4]];
  const face = [[152, 4], [172, 22], [167, 62], [188, 98], [183, 142], [204, 192], [214, 262]];
  const facets = [[[112, 4], [132, 42], [127, 92], [148, 150], [152, 240]], [[62, 3], [80, 52], [74, 120], [94, 210]], [[18, 2], [30, 60], [26, 150]]];
  mass(L.wet, [...top, ...face.slice(1), [70, 262], [10, 150], [-25, 40]].map(T), 0.2, 2 * s, seed, [0, y, 0, y + 250 * s, 1.2, 0.05]);
  const shade = [face, ...facets];
  shade.forEach((f, i) => {
    draw(L, mk(f.map((p) => [p[0] - 12, p[1] + 4]).map(T), { w: (i === 0 ? 34 : 22) * s, tone: i === 0 ? 0.55 : 0.35, darkDir: [flip, 0], side: 0.85, brWet: true, body: 0.3, dry: 0.55, wet: 0.9, prof: 'rise', seed: seed * 5 + i }), 1, 0.9);
  });
  const outline = (pts, w, sd) => {
    for (let i = 0; i < pts.length - 1; i += 2) {
      draw(L, mk(pts.slice(i, i + 3).map((p, j) => [...T(p), j === 1 ? 1.2 : 0.7]), { w: w * s, tone: 0.92, dry: 0.5, wet: 0.25, prof: 'brush', seed: sd + i }));
    }
  };
  outline(top, 4.2, seed * 13);
  outline(face, 4.6, seed * 17);
  facets.forEach((f, i) => {
    draw(L, mk(f.slice(0, 3 + (i === 0 ? 1 : 0)).map(T), { w: (3 - i * 0.6) * s, tone: 0.85, dry: 0.6, wet: 0.2, prof: 'tip', seed: seed * 23 + i }));
  });
  for (const f of [face, ...facets]) {
    for (let i = 0; i < 6; i += 1) {
      const u = R() * 0.75;
      const k = Math.floor(u * (f.length - 1));
      const fr = u * (f.length - 1) - k;
      const px = lerp(f[k][0], f[k + 1][0], fr) - 4 - R() * 10;
      const py = lerp(f[k][1], f[k + 1][1], fr) + 4;
      const len = 16 + R() * 22;
      draw(L, mk([[px, py], [px - len * 0.35, py + len * 0.5], [px - len * 0.5, py + len]].map(T), { w: (7 + R() * 7) * s, tone: 0.75, dry: 0.6, wet: 0.4, prof: 'nail', seed: seed * 50 + i + f.length * 7 }), 1, clamp(1.3 - py / 200));
    }
  }
  for (let c = 0; c < 5; c += 1) {
    const cx = R() * 150;
    for (let i = 0; i < 4; i += 1) {
      const p = T([cx + (R() - 0.5) * 16, -1 + R() * 4]);
      blot(L.wet, p[0], p[1], (1.2 + R() * 2) * s, 0.85, R() * 3, 0.6, c * 10 + i + seed);
    }
  }
  for (let i = 0; i < 6; i += 1) {
    const px = 10 + R() * 140;
    const p0 = T([px, 0]);
    draw(L, mk([p0, [p0[0] + (R() - 0.5) * 10 * s, p0[1] - (8 + R() * 12) * s]], { w: 1.5 * s, tone: 0.8, dry: 0.5, prof: 'tip', seed: seed * 300 + i }));
  }
}

export function pine(L, x, y, s, seed = 5, _t = 0, wind = 0, flip = 1) {
  const R = mulberry(seed);
  const trunk = [[0, 0], [-6, -40], [4, -90], [-10, -140], [10, -185], [40, -215], [80, -226]];
  const T = (p) => [x + p[0] * s * flip, y + p[1] * s];
  draw(L, mk(trunk.map(T), { w: 14 * s, tone: 0.75, darkDir: [flip, 0], side: 0.8, brWet: true, body: 0.3, dry: 0.6, wet: 0.8, prof: 'press', seed: seed * 11 }));
  for (let i = 0; i < 9; i += 1) {
    const u = 0.1 + R() * 0.8;
    const k = Math.floor(u * (trunk.length - 1));
    const f = u * (trunk.length - 1) - k;
    const p = [lerp(trunk[k][0], trunk[k + 1][0], f), lerp(trunk[k][1], trunk[k + 1][1], f)];
    draw(L, mk([T([p[0] - 5, p[1]]), T([p[0] + 3, p[1] + 3])], { w: 2.2 * s, tone: 0.85, dry: 0.5, prof: 'lens', seed: seed * 90 + i }));
  }
  const branches = [
    [[4, -90], [-40, -110], [-80, -112]],
    [[-10, -140], [-50, -160], [-70, -175]],
    [[10, -185], [50, -190], [90, -186]],
    [[40, -215], [70, -240], [110, -245]],
    [[80, -226], [120, -220], [150, -228]],
  ];
  branches.forEach((b, i) => {
    draw(L, mk(b.map(T), { w: 5 * s, tone: 0.8, dry: 0.55, wet: 0.3, prof: 'tip', seed: seed * 20 + i }));
  });
  const clusters = [
    [-80, -114, 1], [-70, -178, 0.9], [-35, -165, 0.8], [90, -190, 1], [55, -196, 0.8],
    [110, -248, 1.1], [150, -232, 0.9], [75, -244, 0.8], [120, -222, 0.7], [-45, -112, 0.7],
  ];
  clusters.forEach(([cx, cy, k], i) => {
    const sw = Math.sin(_t * 1.3 + i) * wind * 2;
    for (let layer = 0; layer < 2; layer += 1) {
      const n = 11;
      const spread = 1.35;
      const rr = (layer ? 22 : 28) * k;
      for (let j = 0; j < n; j += 1) {
        const a = -Math.PI / 2 + (j / (n - 1) - 0.5) * spread * 2 + (layer ? 0.12 : 0);
        const c0 = T([cx + sw, cy + (layer ? 4 : 0)]);
        const c1 = [c0[0] + Math.cos(a) * rr * s, c0[1] + Math.sin(a) * rr * s * 0.55 + rr * s * 0.18];
        draw(L, mk([c0, c1], { w: 2.1 * s, tone: layer ? 0.9 : 0.7, dry: 0.35, wet: 0.35, prof: 'tip', seed: seed * 1000 + i * 40 + layer * 20 + j }));
      }
      const c0 = T([cx + sw, cy + 6]);
      blot(L.wet, c0[0], c0[1], 16 * k * s, 0.18, 0, 0.35, i);
    }
  });
}

export function reed(L, x, y, h, s, seed = 9, bend = 0, tone = 0.8) {
  const R = mulberry(seed);
  const top = [x + bend * h * 0.35, y - h];
  draw(L, mk([[x, y], [x + bend * h * 0.1, y - h * 0.5], top], { w: 2.4 * s, tone, dry: 0.35, wet: 0.3, prof: 'tip', seed: seed * 3 }));
  for (let i = 0; i < 3; i += 1) {
    const u = 0.25 + i * 0.2 + R() * 0.08;
    const px = x + bend * h * 0.1 * u * 2;
    const py = y - h * u;
    const dir = R() < 0.5 ? -1 : 1;
    const L2 = h * (0.3 + R() * 0.25);
    draw(L, mk([[px, py], [px + dir * L2 * 0.45, py - L2 * 0.35], [px + dir * L2 * 0.9 + bend * 10, py - L2 * 0.1]], { w: 5 * s, tone: tone * 0.9, dry: 0.4, wet: 0.4, prof: 'lens', seed: seed * 10 + i }));
  }
  draw(L, mk([top, [top[0] + bend * 14 * s + 6 * s, top[1] - 4 * s], [top[0] + bend * 26 * s + 14 * s, top[1] + 8 * s]], { w: 6 * s, tone: tone * 0.7, dry: 0.7, wet: 0.3, prof: 'lens', seed: seed * 17 }));
}

// One open ink ring (a single brush circuit with a gap).
export function ripple(L, x, y, r, a, seed = 1, sq = 0.2, w = 3) {
  if (a <= 0.01 || r < 1) return;
  const n = 28;
  const ph = (seed * 1.7) % TAU;
  const pts = [];
  for (let i = 0; i <= n; i += 1) {
    const t = ph + (i / n) * Math.PI * 1.86;
    pts.push([x + Math.cos(t) * r, y + Math.sin(t) * r * sq]);
  }
  draw(L, mk(pts, { w, tone: 0.75, dry: 0.55, wet: 0.45, prof: 'brush', seed: seed * 7 }), 1, a);
}

/* ── wave (wave.js) ────────────────────────────────────────────────────── */

function cr(pts, n = 8) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let k = 0; k < n; k += 1) {
      const t = k / n;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (j) =>
        0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3);
      out.push([f(0), f(1)]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

export function waveShape(o) {
  const r = o.rise ?? 1;
  const c = o.curl ?? 1;
  const t = o.t ?? 0;
  const sway = Math.sin(t * 1.7) * 6;
  const face = [[-460, 0], [-310, -55 * r], [-165, -210 * r], [-70, -440 * r], [-10 + sway * 0.3, -610 * r]];
  const crest = [-10 + sway * 0.5, -650 * r];
  const lip = [
    [40, -600 * r], crest, [lerp(-10, -90, c), lerp(-690, -725, c) * r],
    [lerp(0, -200, c), lerp(-700, -728, c) * r], [lerp(10, -272, c), lerp(-680, -684, c) * r],
    [lerp(20, -290, c) + sway, lerp(-650, -618, c) * r],
  ];
  const back = [crest, [130, -590 * r], [310, -420 * r], [540, -260 * r], [820, -150 * r], [1150, -70 * r], [1500, -20 * r]];
  return { face, crest, lip, back, r, c };
}

// A gestural wave: pale body, 4-5 huge loaded strokes along the face, back
// strokes, water lines and spray. In this study it is scaled down to a rising
// swell at the landing; it is the same mechanism, not a re-drawn brush.
export function wave(L, o) {
  const x0 = o.x ?? 0;
  const y0 = o.y ?? 0;
  const s = o.s ?? 1;
  const am = o.am ?? 1;
  const R = mulberry(o.seed ?? 21);
  const t = o.t ?? 0;
  const W = waveShape(o);
  const T = (p) => [x0 + p[0] * s, y0 + p[1] * s];
  const r = W.r;
  if (r <= 0.02) return W;
  const body = [...W.face, W.crest, ...W.back.slice(1), [1500, 30], [-460, 30]].map(T);
  mass(L.wet, body, 0.32 * am, 8 * s, 3, [0, y0 - 650 * r * s, 0, y0 + 20 * s, 1, 0.15]);
  const guide = [...W.face, ...W.lip.slice(1)];
  const strokes = [
    { off: [0, 0], w: 130, tone: 0.85, dry: 0.42, k: 1 },
    { off: [90, 30], w: 110, tone: 0.7, dry: 0.5, k: 0.93 },
    { off: [190, 70], w: 95, tone: 0.55, dry: 0.55, k: 0.85 },
    { off: [300, 110], w: 80, tone: 0.45, dry: 0.6, k: 0.74 },
    { off: [-40, -10], w: 36, tone: 0.95, dry: 0.35, k: 1.03 },
  ];
  strokes.forEach((st, i) => {
    const pts = guide.map((p, j) => {
      const u = j / (guide.length - 1);
      return [p[0] * st.k + st.off[0] * (1 - u * 0.9), p[1] * st.k * (1 - (1 - st.k) * 0.2) + st.off[1] * (1 - u)];
    });
    draw(L, mk(cr(pts, 4).map(T), { w: st.w * s, tone: st.tone, darkDir: [-1, -1], side: 0.9, brWet: true, body: 0.32, dry: st.dry, wet: 0.85, prof: 'rise', rough: 0.2, nb: 56, seed: 300 + i }), 1, am);
  });
  for (let k = 0; k < 2; k += 1) {
    const pts = W.back.map((p) => [p[0] + 20 + k * 60, p[1] + 30 + k * 70 * r]);
    draw(L, mk(cr(pts, 3).map(T), { w: (70 - k * 20) * s, tone: 0.4 - k * 0.12, darkDir: [0, -1], side: 0.8, brWet: true, body: 0.3, dry: 0.55, wet: 0.9, prof: 'lens', seed: 350 + k }), 1, am);
  }
  for (let k = 0; k < 6; k += 1) {
    const f = k / 5;
    const off = 60 + f * 380;
    const g = [
      [-420 + off * 0.5, -6], [-280 + off * 0.8, -70 * r * (1 - f * 0.5)],
      [-140 + off, -230 * r * (1 - f * 0.45)], [-50 + off * 0.9, -440 * r * (1 - f * 0.4)],
      [off * 0.75, -580 * r * (1 - f * 0.35)],
    ];
    draw(L, mk(cr(g, 3).map(T), { w: 2.6 * s, tone: 0.8, dry: 0.6, wet: 0.2, prof: 'tip', seed: 400 + k }), 1, am * 0.8);
  }
  const n = Math.round(46 * W.c);
  for (let i = 0; i < n; i += 1) {
    const a = R() * Math.PI;
    const d = 30 + R() * 160;
    const px = W.crest[0] - 120 + Math.cos(a) * d * 1.4 + Math.sin(t * 2 + i) * 6;
    const py = W.crest[1] - Math.sin(a) * d * 0.8 - 20 + Math.cos(t * 1.7 + i) * 5;
    const p = T([px, py]);
    blot(L.wet, p[0], p[1], (2 + R() * 7) * s, 0.75 * am, R() * 3, 0.7 + R() * 0.3, i);
  }
  return W;
}

/* ── rice-paper compositor (comp.js) ───────────────────────────────────── */

const VS = `#version 300 es
in vec2 p; void main(){ gl_Position = vec4(p,0,1); }`;

const FS = `#version 300 es
precision highp float; out vec4 o;
uniform sampler2D wA, dA, cA;
uniform vec2 res;
uniform vec3 paperX;
uniform vec2 bleed;
uniform float rim;
uniform vec4 rev;
uniform vec2 shake;
uniform float vig, warm;
uniform vec3 paperCol;
float h21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
float fbm(vec2 p){ float a = 0., w = .5; for(int i=0;i<5;i++){ a += w*vn(p); p = p*2.03 + 17.1; w *= .5; } return a; }
float fiber(vec2 p, float ang){ float c = cos(ang), s = sin(ang); vec2 q = vec2(c*p.x + s*p.y, -s*p.x + c*p.y);
  float n = vn(vec2(q.x*.018, q.y*.9)); return smoothstep(.78, .95, n); }
vec3 paper(vec2 fc, vec3 X){
  vec2 p = (fc + X.xy) / X.z;
  float fine = clamp(X.z*1.2, 0., 1.);
  float cloud = fbm(p*.0028) - .5, cloud2 = fbm(p*.011 + 3.) - .5;
  float fb = fiber(p, .35) + fiber(p + 91., 2.1) * .8 + fiber(p*1.7 + 13., 1.2) * .6;
  float grain = vn(p*.9) - .5;
  vec3 c = paperCol * (1. + cloud*.07 + cloud2*.03*fine + grain*.035*fine);
  c += vec3(.018,.016,.012) * fb * fine;
  c -= vec3(.012,.014,.018) * smoothstep(.65,.9, vn(p*.05 + 7.)) * fine;
  return c;
}
const vec2 PD[12] = vec2[](vec2(-.326,-.406), vec2(-.840,-.074), vec2(-.696,.457), vec2(-.203,.621), vec2(.962,-.195), vec2(.473,-.480),
  vec2(.519,.767), vec2(.185,-.893), vec2(.507,.064), vec2(.896,.412), vec2(-.322,-.933), vec2(-.792,-.598));
float revealM(vec2 fc){
  if (rev.w < .5) return 1.;
  float d = length(fc - rev.xy); float n = fbm(fc*.004 + 5.)*.55 + fbm(fc*.02)*.25;
  float dn = d * (.7 + n);
  return 1. - smoothstep(rev.z*.92, rev.z, dn);
}
float inkD(sampler2D W, sampler2D D, vec2 fc, float R, float rimK, vec3 X){
  vec2 p = (fc + X.xy) / X.z;
  vec2 disp = vec2(fbm(p*.012), fbm(p*.012 + 31.)) - .5;
  vec2 feather = vec2(vn(p*.21), vn(p*.21 + 7.)) - .5;
  vec2 q = fc + disp * R * 1.1 + feather * R * .35;
  float a = 0., b = 0.;
  for (int i = 0; i < 12; i++) {
    vec2 o1 = q + PD[i] * R * .5, o2 = q + PD[i] * R * 1.35;
    a += texture(W, o1 / res).a; b += texture(W, o2 / res).a;
  }
  a /= 12.; b /= 12.;
  float s0 = texture(W, q / res).a;
  float edge = max(0., a - b);
  float g1 = vn(p*.35), g2 = fbm(p*.06);
  float wet = mix(s0, a, .72) * (.86 + .22*g2) + edge * rimK * (.8 + .5*g1) + b * .10;
  vec2 j = vec2(vn(p*.7), vn(p*.7 + 5.)) - .5;
  float dry = texture(D, (fc + j * 1.6) / res).a;
  float tooth = smoothstep(.62, .9, vn(p*.55 + 3.)) * .45;
  dry *= 1. - tooth * (1. - dry*.5);
  return clamp(1. - (1. - clamp(wet,0.,1.)) * (1. - clamp(dry,0.,1.)), 0., 1.);
}
vec3 inkCol(float D){ return mix(vec3(.52,.55,.58), vec3(.075,.068,.062), smoothstep(.0, .85, D)); }
vec3 shade(vec3 pc, float D, vec4 col, vec2 fc, vec3 X){
  vec3 c = pc * mix(vec3(1.), inkCol(D), clamp(D*1.05, 0., 1.));
  vec2 p = (fc + X.xy) / X.z;
  float sp = smoothstep(.2, .45, vn(p*.8 + 11.)) * .25 + .75;
  c = mix(c, col.rgb * (pc / paperCol), col.a * sp);
  return c;
}
void main(){
  vec2 fc = gl_FragCoord.xy; fc.y = res.y - fc.y; fc += shake;
  vec3 pa = paper(fc, paperX);
  float DA = inkD(wA, dA, fc, bleed.x, rim, paperX);
  vec4 CA = texture(cA, fc / res);
  float rv = revealM(fc);
  DA *= rv; CA.a *= rv;
  vec3 c = shade(pa, DA, CA, fc, paperX);
  vec2 uv = gl_FragCoord.xy / res - .5;
  c *= 1. - vig * dot(uv*vec2(1.,.9), uv*vec2(1.,.9)) * 1.2;
  c = mix(c, c * vec3(1.02, .99, .94), warm);
  o = vec4(clamp(c, 0., 1.), 1.);
}`;

// The context attributes are final at first creation: opaque, no depth/stencil,
// no MSAA, preserved drawing buffer for the frame screenshot.
const GL_ATTRS = {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  premultipliedAlpha: false,
  preserveDrawingBuffer: true,
};

function createCompositor(canvas) {
  const gl = canvas.getContext('webgl2', GL_ATTRS);
  if (!gl) throw new Error('ink-wash requires a WebGL2 context');
  const sh = (type, src) => {
    const x = gl.createShader(type);
    gl.shaderSource(x, src);
    gl.compileShader(x);
    if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x) || 'shader compile failed');
    return x;
  };
  const pr = gl.createProgram();
  gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS));
  gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr) || 'program link failed');
  gl.useProgram(pr);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = (n) => gl.getUniformLocation(pr, n);
  const tex = ['wA', 'dA', 'cA'].map((n, i) => {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + i);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    gl.uniform1i(U(n), i);
    return t;
  });
  return {
    gl,
    U,
    tex,
    draw(layers, o) {
      const W = layers.W;
      const H = layers.H;
      gl.viewport(0, 0, W, H);
      const up = (i, cv) => {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, tex[i]);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
      };
      up(0, layers.wet);
      up(1, layers.dry);
      up(2, layers.col);
      gl.uniform2f(U('res'), W, H);
      const px = o.paper;
      gl.uniform3f(U('paperX'), px[0], px[1], px[2]);
      gl.uniform2f(U('bleed'), o.bleed ?? 5, 0);
      gl.uniform1f(U('rim'), o.rim ?? 1);
      const rv = o.rev || [0, 0, 0, 0];
      gl.uniform4f(U('rev'), rv[0], rv[1], rv[2], rv[3]);
      const sk = o.shake || [0, 0];
      gl.uniform2f(U('shake'), sk[0], sk[1]);
      gl.uniform1f(U('vig'), o.vig ?? 0.22);
      gl.uniform1f(U('warm'), o.warm ?? 0.5);
      const pc = o.paperCol || [0.95, 0.925, 0.87];
      gl.uniform3f(U('paperCol'), pc[0], pc[1], pc[2]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}

function makeLayerSet(W, H) {
  const mkCanvas = () => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    return c;
  };
  const wet = mkCanvas();
  const dry = mkCanvas();
  const col = mkCanvas();
  const L = {
    wet,
    dry,
    col,
    W,
    H,
    cw: wet.getContext('2d'),
    cd: dry.getContext('2d'),
    cc: col.getContext('2d'),
  };
  L.ink = { wet: L.cw, dry: L.cd, col: L.cc };
  L.clear = () => {
    for (const c of [L.cw, L.cd, L.cc]) {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalAlpha = 1;
      c.globalCompositeOperation = 'source-over';
      c.clearRect(0, 0, W, H);
    }
  };
  return L;
}

/* ── the two scene clocks (pure) ───────────────────────────────────────── */

/** 12 drawings per second, however the output fps is declared. */
export function figureClock(time) {
  return Math.floor(time * 12 + 1e-6) / 12;
}

const CAM_LEAD = 153; // screen x of the figure at 1920 design width: 1113

function ringsFor(time, events) {
  const out = [];
  for (const e of events) {
    const age = time - e.t;
    if (age < 0) continue;
    for (let j = 0; j < 3; j += 1) {
      const a2 = age - j * 0.22;
      if (a2 < 0) continue;
      out.push({
        x: e.x,
        y: WATER_Y + 4,
        r: (14 + 210 * Math.pow(a2, 0.6) * (1 - j * 0.18)) * (e.size ?? 1),
        a: clamp(1 - a2 / 2.4) * (j ? 0.55 : 0.9),
        seed: e.seed * 7 + j,
        width: (3.2 - j * 0.8) * (e.size ?? 1),
      });
    }
  }
  return out;
}

function sprayFor(time, events) {
  const out = [];
  for (const e of events) {
    const age = time - e.t;
    if (age < 0 || age > 0.35) continue;
    const R = mulberry(e.seed + 40);
    for (let i = 0; i < 7; i += 1) {
      const a = -Math.PI * R();
      const d = 20 + ((60 * age) / 0.35) * R();
      out.push({
        x: e.x + Math.cos(a) * d * 1.4,
        y: WATER_Y + 4 + Math.sin(a) * d * 0.6 - 30 * Math.sin((age / 0.35) * Math.PI) * R(),
        r: (2 + R() * 3) * (e.size ?? 1),
        a: 0.8 * (1 - age / 0.35),
        seed: i,
      });
    }
  }
  return out;
}

/**
 * River crossing: bank → touch → touch → leap → land → skid → settle.
 * Pure. Fractions keep the action inside any authored length; the 7 s default
 * is the readable cut. Two clocks are exposed: `t12` (figure drawings) and the
 * continuous camera/swell/ring values.
 */
export function riverAt(time, o = {}) {
  const frames = Math.max(2, Math.round(o.frames ?? DEFAULT_FRAMES));
  const fps = o.fps ?? 24;
  const dur = frames / fps;
  const u = clamp(time / dur);
  const t12 = figureClock(time);
  const pu = clamp(t12 / dur); // pose/phase clock: held drawings
  const x0 = -900;
  const x1 = -560;
  const x2 = -60;
  const x3 = 470;
  const xEnd = 530;
  const phases = { ready: 0.11, crouch: 0.15, touch1: 0.21, touch2: 0.33, land: 0.55, impact: 0.6, skid: 0.69, rise: 0.81 };
  const ringEvents = [
    { t: phases.touch1 * dur, x: x1 + 8, seed: 3, size: 0.75 },
    { t: phases.touch2 * dur, x: x2 + 8, seed: 7, size: 0.75 },
    { t: phases.land * dur, x: x3 - 168, seed: 11, size: 1.55 },
  ];
  let x = x0;
  let y = BANK_Y;
  if (u < phases.ready) {
    // hold on the bank
  } else if (u < phases.crouch) {
    // gather, position still continuous
  } else if (u < phases.touch1) {
    const k = ss(seg(u, phases.crouch, phases.touch1));
    x = lerp(x0, x1, k);
    y = lerp(BANK_Y, WATER_Y, k) - 110 * Math.sin(Math.PI * k);
  } else if (u < phases.touch1 + 0.012) {
    x = x1;
    y = WATER_Y;
  } else if (u < phases.touch2) {
    const k = ss(seg(u, phases.touch1 + 0.012, phases.touch2));
    x = lerp(x1, x2, k);
    y = WATER_Y - 65 * Math.sin(Math.PI * k);
  } else if (u < phases.touch2 + 0.012) {
    x = x2;
    y = WATER_Y;
  } else if (u < phases.land) {
    const k = ss(seg(u, phases.touch2 + 0.012, phases.land));
    x = lerp(x2, x3, k);
    y = lerp(WATER_Y, BANK_Y, k) - 150 * Math.sin(Math.PI * k);
  } else if (u < phases.impact) {
    const k = ss(seg(u, phases.land, phases.impact));
    x = lerp(x3, x3 + 12, k);
    y = BANK_Y;
  } else if (u < phases.skid) {
    const k = ss(seg(u, phases.impact, phases.skid));
    x = lerp(x3 + 12, xEnd, k);
    y = BANK_Y;
  } else if (u < phases.rise) {
    x = xEnd;
    y = BANK_Y;
  } else {
    x = xEnd;
    y = BANK_Y;
  }
  // The drawing clock chooses the phase and the pose, so the figure is held on
  // twos while x/y, camera, rings, swell and shake stay on the raw output clock.
  let phase = 'ready';
  let pose = POSE.stand;
  if (pu < phases.ready) {
    phase = 'ready';
  } else if (pu < phases.crouch) {
    phase = 'crouch';
    pose = mixPose(POSE.stand, POSE.skid, 0.58 * ss(seg(pu, phases.ready, phases.crouch)));
  } else if (pu < phases.touch1) {
    phase = 'takeoff';
    pose = POSE.leap;
  } else if (pu < phases.touch1 + 0.012) {
    phase = 'touch';
    pose = POSE.touch;
  } else if (pu < phases.touch2) {
    phase = 'hop';
    const k = ss(seg(pu, phases.touch1 + 0.012, phases.touch2));
    pose = k < 0.14 ? POSE.touch : k < 0.36 ? mixPose(POSE.touch, POSE.leap, ss((k - 0.14) / 0.22)) : k < 0.8 ? POSE.leap : mixPose(POSE.leap, POSE.touch, ss((k - 0.8) / 0.2));
  } else if (pu < phases.touch2 + 0.012) {
    phase = 'touch';
    pose = POSE.touch;
  } else if (pu < phases.land) {
    phase = 'long-leap';
    const k = ss(seg(pu, phases.touch2 + 0.012, phases.land));
    pose = k < 0.82 ? POSE.leap : mixPose(POSE.leap, POSE.touch, ss((k - 0.82) / 0.18));
  } else if (pu < phases.impact) {
    phase = 'land';
    const k = ss(seg(pu, phases.land, phases.impact));
    pose = mixPose(POSE.touch, POSE.skid, k);
  } else if (pu < phases.skid) {
    phase = 'skid';
    pose = POSE.skid;
  } else if (pu < phases.rise) {
    phase = 'rise';
    const k = ss(seg(pu, phases.skid, phases.rise));
    pose = mixPose(POSE.skid, POSE.stand, k);
  } else {
    phase = 'settle';
    pose = POSE.stand;
  }
  const landingAge = time - phases.land * dur;
  const swell =
    landingAge >= 0
      ? {
          x: 120,
          y: WATER_Y + 62,
          s: 0.78,
          rise: (0.04 + 0.17 * ss(clamp(landingAge / 0.9))) * (1 - 0.55 * ss(clamp((landingAge - 1.3) / 1.5))),
          curl: 0.3 * ss(clamp(landingAge / 1.2)),
          am: 0.42 * (1 - ss(clamp((landingAge - 1.7) / 1.2))),
          age: landingAge,
        }
      : null;
  const shakeK = landingAge >= 0 && landingAge < 0.5 ? 1.2 * Math.exp(-landingAge * 8) : 0;
  return {
    variant: 'river',
    u,
    t12,
    phase,
    pose,
    x,
    y,
    dir: 1,
    staff: null,
    camera: { x: x - CAM_LEAD, z: 1 + 0.035 * ss(u) },
    rings: ringsFor(time, ringEvents),
    spray: sprayFor(time, ringEvents),
    swell,
    shake: [Math.sin(time * 61) * shakeK, Math.cos(time * 47) * shakeK * 0.7],
    reveal: { on: u < 0.1, x: -1120, y: 650, r: 110 + 2890 * eo(u / 0.1) },
    seal: clamp(seg(u, 0.93, 0.975)),
  };
}

/**
 * Pine path: walk with a staff → stop and plant it → hard cut to a closer
 * frontal salute (fist-and-palm), hold, rise, chop.
 */
export function pineAt(time, o = {}) {
  const frames = Math.max(2, Math.round(o.frames ?? DEFAULT_FRAMES));
  const fps = o.fps ?? 24;
  const dur = frames / fps;
  const u = clamp(time / dur);
  const t12 = figureClock(time);
  const cut = 0.56;
  const walkX = lerp(-700, 120, seg(u, 0.06, 0.52));
  if (u < cut) {
    const step = Math.floor(t12 / 0.3333) % 2;
    const bob = -3 * Math.abs(Math.sin(Math.PI * ((t12 / 0.3333) % 1)));
    const planted = u >= 0.52;
    const pose = planted ? POSE.walk1 : step ? POSE.walk2 : POSE.walk1;
    return {
      variant: 'pine',
      shot: 'walk',
      u,
      t12,
      phase: u < 0.06 ? 'ready' : planted ? 'plant' : 'walk',
      pose,
      x: walkX,
      y: 1000 + bob,
      dir: 1,
      staff: { plant: planted ? 30 : 24 },
      camera: { x: walkX + 60, z: 1 + 0.02 * ss(u) },
      dust: planted ? Math.max(0, 1 - (u - 0.52) / 0.04) : 0,
      reveal: { on: u < 0.085, x: -700, y: 600, r: 110 + 2890 * eo(u / 0.085) },
      seal: 0,
    };
  }
  const v = clamp((u - cut) / (1 - cut));
  const pv = clamp((clamp(t12 / dur) - cut) / (1 - cut));
  const b = ss(seg(pv, 0.12, 0.38));
  const up = ss(seg(pv, 0.72, 0.86));
  const pose = mixPose(mixPose(POSE.front, POSE.bow, b), POSE.front, up);
  pose.fist = b > 0.5 && up < 0.5 ? 1 : 0;
  pose.eyes = b > 0.5 && up < 0.5 ? 1 : 0;
  return {
    variant: 'pine',
    shot: 'bow',
    u,
    t12,
    phase: up > 0 ? 'rise' : b < 0.5 ? 'salute' : 'bow',
    pose,
    x: 900,
    y: 1040,
    dir: 1,
    staff: null,
    camera: { x: 960, z: 1 + 0.025 * ss(v) },
    dust: 0,
    reveal: { on: false, x: 0, y: 0, r: 0 },
    seal: clamp(seg(v, 0.84, 0.92)),
  };
}

/* ── scenery caches ────────────────────────────────────────────────────── */

function buildFarRange(scale, width, height, peaks, base, seed, tone, mist) {
  const ridgeDesign = ridgeFn(peaks, base, seed, 26);
  const cv = document.createElement('canvas');
  cv.width = Math.round(width * scale);
  cv.height = Math.round(height * scale);
  const c = cv.getContext('2d');
  c.setTransform(scale, 0, 0, scale, 0, 0);
  const far = mountainLayer({
    W: width * scale,
    H: height * scale,
    ridge: (x) => ridgeDesign(x / scale) * scale,
    depth: 210 * scale,
    tone,
    rim: 0.5,
    rimW: 24 * scale,
    mist,
    seed,
  });
  c.drawImage(far, 0, 0, width, height);
  // A nearer range gives the band depth without becoming a subject.
  const midRidge = ridgeFn([[260, 130, 230], [980, 210, 210], [1620, 150, 240], [2260, 230, 210], [2940, 160, 230], [3560, 120, 210], [4060, 180, 200]], base + 90, seed + 5, 30);
  const mid = mountainLayer({
    W: width * scale,
    H: height * scale,
    ridge: (x) => midRidge(x / scale) * scale,
    depth: 280 * scale,
    tone: tone + 0.12,
    rim: 0.62,
    rimW: 16 * scale,
    mist: 0.7,
    seed: seed + 5,
  });
  c.drawImage(mid, 0, 0, width, height);
  return cv;
}

function buildRiverStatics(W, H) {
  const scale = H / DESIGN_H;
  const worldX0 = -1300;
  const worldW = 2600;
  const mkCanvas = () => {
    const c = document.createElement('canvas');
    c.width = Math.round(worldW * scale);
    c.height = Math.round(DESIGN_H * scale);
    return c;
  };
  const wet = mkCanvas();
  const dry = mkCanvas();
  const cw = wet.getContext('2d');
  const cd = dry.getContext('2d');
  cw.setTransform(scale, 0, 0, scale, -worldX0 * scale, 0);
  cd.setTransform(scale, 0, 0, scale, -worldX0 * scale, 0);
  const L = { wet: cw, dry: cd };
  // Left bank: a low, sloping ground, not a pillar. Its foot fades into the
  // river so the water stays "blank paper".
  mass(cw, [[-1300, 1080], [-1300, 930], [-1190, 846], [-1080, 812], [-995, 801], [-905, 796], [-822, 806], [-772, 832], [-742, 884], [-738, 1080]], 0.17, 4, 31);
  mass(cw, [[-1240, 860], [-1100, 824], [-980, 812], [-870, 816], [-790, 840], [-760, 880], [-1240, 900]], 0.12, 5, 33);
  cun(L, { x0: -1240, x1: -800, ridge: ridgeFn([[-1080, 52, 150], [-930, 34, 120]], 814, 21, 10), tone: 0.26, cun: 0.7, moss: 1.0, seed: 21, cunLen: 0.55 });
  cliff(L, -1080, 806, 0.34, 3, -1);
  cliff(L, -1180, 814, 0.24, 9, 1);
  draw(L, mk([[-1190, 812], [-1100, 802], [-1010, 796], [-920, 795], [-850, 804], [-800, 822]], { w: 3.0, tone: 0.82, dry: 0.5, wet: 0.25, prof: 'brush', seed: 71 }), 1, 0.85);
  draw(cd, mk([[-1200, 880], [-1060, 846], [-960, 836], [-860, 846]], { w: 2.2, tone: 0.3, dry: 0.78, prof: 'tip', seed: 72 }), 1, 0.6);
  for (let i = 0; i < 7; i += 1) {
    const gx = -1190 + i * 40;
    draw(dry, mk([[gx, 806], [gx - 3, 788], [gx - 8, 774]], { w: 1.4, tone: 0.55, dry: 0.7, prof: 'tip', seed: 610 + i }), 1, 0.7);
  }
  // Right bank: the landing, a slope rising out of the water.
  mass(cw, [[356, 1080], [372, 930], [416, 856], [482, 814], [560, 798], [646, 791], [726, 801], [806, 832], [862, 900], [872, 1080]], 0.17, 4, 37);
  mass(cw, [[420, 880], [520, 836], [640, 822], [740, 840], [820, 888], [860, 930], [420, 930]], 0.1, 5, 39);
  cun(L, { x0: 400, x1: 840, ridge: ridgeFn([[500, 48, 150], [680, 30, 120]], 808, 23, 9), tone: 0.25, cun: 0.65, moss: 1.1, seed: 23, cunLen: 0.5 });
  cliff(L, 392, 824, 0.28, 13, -1);
  pine(L, 790, 800, 1.02, 5, 0, 0, 1);
  draw(L, mk([[430, 808], [520, 797], [620, 792], [700, 798], [770, 816], [825, 842]], { w: 3.0, tone: 0.82, dry: 0.5, wet: 0.25, prof: 'brush', seed: 73 }), 1, 0.85);
  draw(cd, mk([[450, 874], [560, 846], [680, 842], [790, 872]], { w: 2.2, tone: 0.3, dry: 0.78, prof: 'tip', seed: 74 }), 1, 0.6);
  for (let i = 0; i < 8; i += 1) {
    const gx = 450 + i * 40;
    draw(dry, mk([[gx, 800], [gx + 3, 782], [gx + 9, 770]], { w: 1.4, tone: 0.5, dry: 0.72, prof: 'tip', seed: 660 + i }), 1, 0.65);
  }
  // Dissolve both bank feet into the river (no hard bottom edge).
  for (const c of [cw, cd]) {
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'destination-in';
    const g = c.createLinearGradient(0, 890 * scale, 0, 1010 * scale);
    g.addColorStop(0, '#000');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, wet.width, wet.height);
    c.restore();
  }
  return { wet, dry, worldX0, worldW, scale };
}

function buildPineWalkStatics(W, H) {
  const scale = H / DESIGN_H;
  const worldX0 = -1600;
  const worldW = 3200;
  const mkCanvas = () => {
    const c = document.createElement('canvas');
    c.width = Math.round(worldW * scale);
    c.height = Math.round(DESIGN_H * scale);
    return c;
  };
  const wet = mkCanvas();
  const dry = mkCanvas();
  const cw = wet.getContext('2d');
  const cd = dry.getContext('2d');
  cw.setTransform(scale, 0, 0, scale, -worldX0 * scale, 0);
  cd.setTransform(scale, 0, 0, scale, -worldX0 * scale, 0);
  const L = { wet: cw, dry: cd };
  const ridge = ridgeFn([[-900, 250, 180], [-260, 160, 200], [420, 210, 190], [980, 120, 160]], 650, 31, 24);
  const cvM = mountainLayer({
    W: worldW * scale,
    H: DESIGN_H * scale,
    ridge: (x) => ridge(x / scale + worldX0) * scale,
    depth: 285 * scale,
    tone: 0.34,
    rim: 0.52,
    rimW: 22 * scale,
    mist: 0.42,
    seed: 31,
  });
  cw.drawImage(cvM, worldX0, 0, worldW, DESIGN_H);
  // Distant trees on the ridge.
  for (const [i, x, h] of [[0, -880, 84], [1, -170, 70], [2, 610, 96]]) {
    draw(L, mk([[x, 996], [x + 3, 996 - h - 50], [x - 1, 996 - h - 84]], { w: 3.2, tone: 0.66, dry: 0.55, prof: 'tip', seed: 820 + i }), 1, 0.8);
    const R = mulberry(90 + i);
    for (let k = 0; k < 12; k += 1) blot(cw, x + (R() - 0.5) * 40, 910 - h * 0.4 + (R() - 0.5) * 30, 4 + R() * 5, 0.36, 0, 0.6, k + i * 20);
  }
  // Path: a pale ground wash, one long dry sweep and stones.
  mass(cw, [[-1600, 1080], [-1600, 1018], [-900, 1010], [-200, 1006], [500, 1010], [1200, 1020], [1600, 1030], [1600, 1080]], 0.12, 3, 35);
  draw(L, mk([[-1300, 1008], [-700, 1002], [-100, 1000], [500, 1002], [1230, 1010]], { w: 9, tone: 0.42, dry: 0.68, wet: 0.14, prof: 'even', seed: 830 }), 1, 0.85);
  draw(L, mk([[-1180, 1028], [-560, 1020], [120, 1018], [820, 1024]], { w: 2.6, tone: 0.42, dry: 0.75, prof: 'tip', seed: 831 }), 1, 0.6);
  for (let i = 0; i < 12; i += 1) {
    const sxp = -1080 + i * 180;
    blot(cw, sxp, 1002 + (i % 3) * 6, 3 + (i % 4), 0.45, 0, 0.5, 40 + i);
  }
  // Rocks and the two pines.
  pine(L, -520, 1000, 0.9, 5, 0, 0, -1);
  pine(L, 560, 1000, 1.6, 7, 0, 0, 1);
  return { wet, dry, worldX0, worldW, scale };
}

function buildPineBowStatics(W, H) {
  const scale = H / DESIGN_H;
  const cvW = Math.round(1920 * scale);
  const cvH = Math.round(DESIGN_H * scale);
  const mkCanvas = () => {
    const c = document.createElement('canvas');
    c.width = cvW;
    c.height = cvH;
    return c;
  };
  const wet = mkCanvas();
  const dry = mkCanvas();
  const cw = wet.getContext('2d');
  const cd = dry.getContext('2d');
  cw.setTransform(scale, 0, 0, scale, 0, 0);
  cd.setTransform(scale, 0, 0, scale, 0, 0);
  const L = { wet: cw, dry: cd };
  const ridge = ridgeFn([[1480, 260, 190], [1060, 150, 190], [460, 190, 200], [-60, 120, 150]], 600, 41, 26);
  const cvM = mountainLayer({
    W: 1920 * scale,
    H: DESIGN_H * scale,
    ridge: (x) => ridge(x / scale) * scale,
    depth: 230 * scale,
    tone: 0.13,
    rim: 0.5,
    rimW: 24 * scale,
    mist: 0.9,
    seed: 41,
  });
  cw.drawImage(cvM, 0, 0, 1920, DESIGN_H);
  // A nearer, higher range on the right.
  const near = ridgeFn([[1600, 180, 150], [1840, 120, 120]], 720, 47, 18);
  const cvN = mountainLayer({
    W: 1920 * scale,
    H: DESIGN_H * scale,
    ridge: (x) => near(x / scale) * scale,
    depth: 170 * scale,
    tone: 0.36,
    rim: 0.7,
    rimW: 18 * scale,
    mist: 0.6,
    seed: 47,
    xmask: (x) => clamp((x - 1100 * scale) / (180 * scale)),
  });
  cw.drawImage(cvN, 0, 0, 1920, DESIGN_H);
  cun(L, { x0: 1150, x1: 1920, ridge: near, tone: 0.24, cun: 1.2, cunW: 0.9, cunLen: 0.9, moss: 0.7, seed: 47 });
  // Path and stones.
  draw(L, mk([[-40, 1054], [420, 1050], [960, 1048], [1500, 1052], [1920, 1056]], { w: 8, tone: 0.32, dry: 0.72, wet: 0.1, prof: 'even', seed: 850 }), 1, 0.8);
  draw(L, mk([[120, 1068], [700, 1062], [1300, 1064]], { w: 2.6, tone: 0.5, dry: 0.72, prof: 'tip', seed: 851 }), 1, 0.7);
  mass(cw, [[0, 1080], [0, 1064], [420, 1058], [960, 1056], [1500, 1060], [1920, 1066], [1920, 1080]], 0.1, 3, 87);
  for (let i = 0; i < 10; i += 1) blot(cw, 100 + i * 190, 1048 + (i % 4) * 5, 3 + (i % 5), 0.42, 0, 0.5, 70 + i);
  cliff(L, 300, 1045, 0.82, 13, 1);
  pine(L, 1500, 1045, 1.8, 7, 0, 0, 1);
  for (let i = 0; i < 9; i += 1) {
    const gx = 60 + i * 220;
    draw(dry, mk([[gx, 1050], [gx + 4, 1028], [gx + 12, 1014]], { w: 1.6, tone: 0.48, dry: 0.72, prof: 'tip', seed: 700 + i }), 1, 0.6);
  }
  return { wet, dry, worldX0: 0, worldW: 1920, scale };
}

/* ── end chop ──────────────────────────────────────────────────────────── */

// An abstract chop: irregular square, knocked-out border, ink-paste speckles.
// It carries no glyph, character or font.
function drawChop(c, x, y, size, am, seed = 3) {
  if (am <= 0) return;
  c.save();
  c.translate(x, y);
  const S = size;
  const jit = S * 0.018;
  c.beginPath();
  const N = 28;
  for (let i = 0; i < N; i += 1) {
    const t = (i / N) * 4;
    const side = Math.floor(t);
    const u = t - side;
    let px;
    let py;
    if (side === 0) {
      px = u * S;
      py = 0;
    } else if (side === 1) {
      px = S;
      py = u * S;
    } else if (side === 2) {
      px = S - u * S;
      py = S;
    } else {
      px = 0;
      py = S - u * S;
    }
    px += (vnoise(seed + i * 1.3) - 0.5) * jit * 2;
    py += (vnoise(seed + 40 + i * 1.3) - 0.5) * jit * 2;
    if (i) c.lineTo(px, py);
    else c.moveTo(px, py);
  }
  c.closePath();
  c.fillStyle = `rgba(${VERM.join(',')},${clamp(am)})`;
  c.fill();
  // Knock out a thin inner border and two edge notches (paste resist), so the
  // mark reads as a chop without any character.
  c.globalCompositeOperation = 'destination-out';
  c.fillStyle = '#000';
  c.fillRect(S * 0.08, S * 0.08, S * 0.84, S * 0.022);
  c.fillRect(S * 0.08, S * 0.898, S * 0.84, S * 0.022);
  c.fillRect(S * 0.08, S * 0.08, S * 0.022, S * 0.84);
  c.fillRect(S * 0.898, S * 0.08, S * 0.022, S * 0.84);
  for (let i = 0; i < 70; i += 1) {
    const a = vnoise(seed + i * 3.7);
    const b = vnoise(seed + 91 + i * 2.9);
    c.globalAlpha = 0.5 + 0.5 * vnoise(i * 1.1);
    c.beginPath();
    c.arc(a * S, b * S, S * (0.004 + 0.012 * vnoise(i * 5.3)), 0, TAU);
    c.fill();
  }
  c.restore();
}

/* ── per-frame scene painting ──────────────────────────────────────────── */

// The mark that starts the bloom: a small wet drop at the reveal centre. It is
// inside the first reveal radius, so frame 0 is a drop on paper, not a blank
// sheet.
function openingDrop(K, story) {
  if (!story.reveal.on) return;
  const d = clamp(story.u / 0.03);
  blot(K.wet, story.reveal.x, story.reveal.y, 7 - 4 * d, 0.9 * (1 - d), 0, 0.85, 7);
}

function drawRiver(state, L, story, scale, t) {
  const K = L.ink;
  const camX = story.camera.x;
  const z = story.camera.z;
  const set = (c) => c.setTransform(scale * z, 0, 0, scale * z, -camX * scale * z + state.W / 2, -540 * scale * z + state.H / 2);
  // Far range is a screen-plane backdrop with slow parallax (not a world object,
  // because the handscroll keeps it far behind the moving water).
  const screen = (c) => c.setTransform(scale * z, 0, 0, scale * z, state.W / 2 - 960 * scale * z, state.H / 2 - 540 * scale * z);
  screen(L.cw);
  L.cw.drawImage(state.far, -700 - camX * 0.12, 0, state.farW, DESIGN_H);
  set(L.cw);
  set(L.cd);
  set(L.cc);
  // Water: a few long, faint lines make the blank paper read as a river before
  // the banks cover their share.
  for (let i = 0; i < 4; i += 1) {
    const wy = 834 + i * 38;
    draw(K, mk([[-1350, wy], [-600, wy - 2], [160, wy + 1], [1000, wy - 2]], { w: 2.6 - i * 0.2, tone: 0.22 + i * 0.02, dry: 0.82, wet: 0.14, prof: 'even', seed: 960 + i, gapLen: 700 }), 1, 0.45);
  }
  for (let i = 0; i < 18; i += 1) {
    const R = mulberry(900 + i);
    const wy = 846 + Math.pow(R(), 1.3) * 190;
    const wx = ((((R() * 3200 - camX * 0.4) % 2600) + 2600) % 2600) - 1300;
    const len = 80 + R() * 150;
    draw(K, mk([[wx, wy], [wx + len * 0.5, wy - 2], [wx + len, wy + 1]], { w: 2.0, tone: 0.32, dry: 0.72, wet: 0.24, prof: 'tip', seed: 900 + i, gapLen: 60 }), 1, 0.5);
  }
  // Static banks (drawn over the water lines; their feet fade into it).
  L.cw.drawImage(state.staticWet, state.worldX0, 0, state.worldW, DESIGN_H);
  L.cd.drawImage(state.staticDry, state.worldX0, 0, state.worldW, DESIGN_H);
  // Landing swell.
  if (story.swell) {
    wave(K, {
      x: story.swell.x,
      y: story.swell.y,
      s: story.swell.s,
      rise: story.swell.rise,
      curl: story.swell.curl,
      t,
      seed: 21,
      am: story.swell.am ?? 1,
    });
  }
  // Rings and spray.
  for (const r of story.rings) ripple(K, r.x, r.y, r.r, r.a, r.seed, 0.2, r.width);
  for (const p of story.spray) blot(K.wet, p.x, p.y, p.r, p.a, 0, 1, p.seed);
  // Hero at 12 drawings per second.
  hero(K, story.pose, { x: story.x, y: story.y, s: 3.15, dir: story.dir, seed: 2, t: story.t12, boil: story.t12 * 12 });
  // Foreground reeds rooted at the two banks, in front of the figure.
  for (const [k, wx] of [-1180, 840].entries()) {
    for (let j = 0; j < 4; j += 1) {
      reed(K, wx + j * 32, 1140, 210 + j * 30 + (k % 2) * 30, 2.2, k * 20 + j, -0.3 + j * 0.07 + Math.sin(t * 2 + j) * 0.035, 0.92);
    }
  }
  // Screen-space chop in the col layer.
  L.cc.setTransform(1, 0, 0, 1, 0, 0);
  openingDrop(K, story);
  drawChop(L.cc, state.W * 0.1, state.H * 0.79, state.H * 0.105, story.seal, 5);
}

function drawPine(state, L, story, scale, t) {
  const K = L.ink;
  const camX = story.camera.x;
  const z = story.camera.z;
  const set = (c) => c.setTransform(scale * z, 0, 0, scale * z, -camX * scale * z + state.W / 2, -540 * scale * z + state.H / 2);
  set(L.cw);
  set(L.cd);
  set(L.cc);
  if (story.shot === 'walk') {
    L.cw.drawImage(state.walkWet, state.walkWorldX0, 0, state.walkWorldW, DESIGN_H);
    L.cd.drawImage(state.walkDry, state.walkWorldX0, 0, state.walkWorldW, DESIGN_H);
    if (story.dust > 0) {
      const R = mulberry(41);
      for (let i = 0; i < 6; i += 1) {
        const px = story.x + 26 + (R() - 0.5) * 26;
        blot(K.wet, px, 1000 + (R() - 0.5) * 8, 2 + R() * 3.5, 0.2 * story.dust, 0, 0.5, i);
      }
    }
    hero(K, story.pose, { x: story.x, y: story.y, s: 3.3, dir: story.dir, seed: 4, t: story.t12, boil: story.t12 * 12, staff: story.staff });
    // Path-side grass in front.
    for (let i = 0; i < 9; i += 1) {
      const gx = -1080 + i * 260;
      const sx = ((((gx - camX * 1.1) % 3000) + 3000) % 3000) - 500;
      draw(K, mk([[sx, 1100], [sx + 6, 1056], [sx + 16, 1032]], { w: 1.8, tone: 0.5, dry: 0.75, prof: 'tip', seed: 940 + i }), 1, 0.6);
    }
  } else {
    L.cw.drawImage(state.bowWet, 0, 0, 1920, DESIGN_H);
    L.cd.drawImage(state.bowDry, 0, 0, 1920, DESIGN_H);
    // Planted staff beside him.
    draw(K, mk([[1072, 646], [1078, 848], [1088, 1046]], { w: 5.2, tone: 0.74, darkDir: [1, 0], side: 0.7, brWet: true, body: 0.24, dry: 0.4, wet: 0.65, prof: 'even', seed: 990 }), 1, 1);
    draw(K, mk([[1072, 646], [1071.4, 656]], { w: 5.6, tone: TONE.jiao, dry: 0.4, prof: 'nail', seed: 991 }), 1, 1);
    draw(K, mk([[1077, 846], [1080, 852]], { w: 3.2, tone: 0.6, dry: 0.5, prof: 'tip', seed: 992 }), 1, 0.9);
    blot(K.wet, 1090, 1046, 7, 0.3, 0, 0.35, 12);
    hero(K, story.pose, { x: story.x, y: story.y, s: 6.6, dir: story.dir, seed: 4, t: story.t12, boil: story.t12 * 12 });
    // Foreground grass, closer.
    for (let i = 0; i < 7; i += 1) {
      const gx = 40 + i * 280;
      draw(K, mk([[gx, 1100], [gx + 8, 1042], [gx + 20, 1016]], { w: 2.2, tone: 0.5, dry: 0.75, prof: 'tip', seed: 970 + i }), 1, 0.65);
    }
  }
  L.cc.setTransform(1, 0, 0, 1, 0, 0);
  openingDrop(K, story);
  drawChop(L.cc, state.W * 0.1, state.H * 0.79, state.H * 0.105, story.seal, 7);
}

/* ── state + public entry ──────────────────────────────────────────────── */

let STATE = null;

function ensureState(canvas, W, H) {
  const key = `${W}x${H}`;
  if (STATE && STATE.canvas === canvas && STATE.key === key) return STATE;
  const scale = H / DESIGN_H;
  if (!STATE || STATE.canvas !== canvas) {
    STATE = { canvas, comp: createCompositor(canvas) };
  }
  // A new size invalidates every layer and cached scene; the compositor program
  // itself is size-independent and is reused.
  STATE.key = key;
  STATE.W = W;
  STATE.H = H;
  STATE.scale = scale;
  STATE.layers = makeLayerSet(W, H);
  const farW = 4200;
  STATE.farW = farW;
  STATE.far = buildFarRange(scale, farW, DESIGN_H, [[520, 200, 170], [1100, 140, 170], [1700, 250, 150], [2300, 160, 180], [2900, 220, 160], [3500, 150, 170], [4050, 90, 150]], 590, 13, 0.13, 0.9);
  const river = buildRiverStatics(W, H);
  STATE.staticWet = river.wet;
  STATE.staticDry = river.dry;
  STATE.worldX0 = river.worldX0;
  STATE.worldW = river.worldW;
  const walk = buildPineWalkStatics(W, H);
  STATE.walkWet = walk.wet;
  STATE.walkDry = walk.dry;
  STATE.walkWorldX0 = walk.worldX0;
  STATE.walkWorldW = walk.worldW;
  const bow = buildPineBowStatics(W, H);
  STATE.bowWet = bow.wet;
  STATE.bowDry = bow.dry;
  return STATE;
}

function resolveFrames(params) {
  const n = Math.round(params.frames ?? DEFAULT_FRAMES);
  return Number.isFinite(n) && n >= 2 ? n : DEFAULT_FRAMES;
}

/**
 * Render one frame. `ctx` is the Runtime's browser frame context: frame, time,
 * fps, width, height, seed and params. The entry page only forwards it.
 */
export function renderInk(canvas, ctx) {
  const W = Math.max(2, Math.round(ctx.width));
  const H = Math.max(2, Math.round(ctx.height));
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const state = ensureState(canvas, W, H);
  const params = ctx.params ?? {};
  const fps = ctx.fps ?? 24;
  const frames = resolveFrames(params);
  const time = ctx.time ?? ctx.frame / fps;
  const variant = params.variant === 'pine' ? 'pine' : 'river';
  const story = variant === 'pine' ? pineAt(time, { frames, fps }) : riverAt(time, { frames, fps });
  const L = state.layers;
  L.clear();
  const scale = state.scale;
  const z = story.camera.z;
  const camX = story.camera.x;
  const tx = W / 2 - camX * scale * z;
  const ty = H / 2 - 540 * scale * z;
  if (variant === 'pine') drawPine(state, L, story, scale, time);
  else drawRiver(state, L, story, scale, time);
  // Reveal centre in output pixels.
  const rvX = story.reveal.x * scale * z + tx;
  const rvY = story.reveal.y * scale * z + ty;
  state.comp.draw(L, {
    paper: [-tx, -ty, scale * z],
    bleed: 5 * scale,
    rim: 1,
    rev: [rvX, rvY, story.reveal.r * scale, story.reveal.on ? 1 : 0],
    shake: story.shake,
    vig: 0.22,
    warm: 0.45,
    paperCol: [0.95, 0.925, 0.87],
  });
}
