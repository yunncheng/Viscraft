// rubber-hose-toon.mjs — a small screen-space ink engine for the rubber-hose reference.
//
// Adapted from LemoLab's lemo-opuscar `styles/rubber-hose/demo/toon.js`
// (commit e3cb16f6, MIT). The mechanism is kept, the wiring rewritten:
//
//   1. Points are transformed to SCREEN space first and stroked afterwards, so
//      the ink weight stays constant at any zoom (a cartoon close-up never gets
//      thin lines).
//   2. Line boil: paths are resampled every ~7 screen px, displaced along the
//      normal by low-frequency noise, and the displacement cycles through three
//      drawings at 12 fps.
//   3. Flat fill → clip to the shape → hard-edged shadow block → outline last.
//
// Upstream held the matrix and boil state in module globals fixed at 1920x1080.
// Here one factory owns that state, so the background painter and the live scene
// can hold independent engines without sharing a matrix or a `sid` counter.

export const TAU = Math.PI * 2;

export const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const seg = (t, a, b) => clamp((t - a) / (b - a));
export const ss = (t) => {
  t = clamp(t);
  return t * t * (3 - 2 * t);
};
export const eio = (t) => {
  t = clamp(t);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};
export const eo = (t) => 1 - Math.pow(1 - clamp(t), 3);
export const ei = (t) => Math.pow(clamp(t), 3);
export const back = (t, s = 1.8) => {
  t = clamp(t) - 1;
  return 1 + t * t * ((s + 1) * t + s);
};
// Spring settle: 0 → 1 with one or two bounces.
export const spring = (t, k = 7, z = 0.35) => {
  t = Math.max(0, t);
  return 1 - Math.exp(-z * k * t) * Math.cos(k * Math.sqrt(1 - z * z) * t * 1.6);
};
export function mulberry(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const hash = (n) => {
  n = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return n - Math.floor(n);
};
export const vnoise = (x) => {
  const i = Math.floor(x),
    f = x - i,
    u = f * f * (3 - 2 * f);
  return lerp(hash(i), hash(i + 1), u);
};

/** Piecewise smooth interpolation of frames → objects with numeric fields. */
export function track(keys, t) {
  if (!keys.length) return {};
  if (t <= keys[0][0]) return keys[0][1];
  if (t >= keys[keys.length - 1][0]) return keys[keys.length - 1][1];
  let i = 0;
  while (t > keys[i + 1][0]) i++;
  const [t0, a] = keys[i];
  const [t1, b] = keys[i + 1];
  const u = ss((t - t0) / (t1 - t0));
  const out = {};
  for (const k of Object.keys(a)) out[k] = lerp(a[k], b[k], u);
  return out;
}

export function arcPts(cx, cy, rx, ry, a0, a1, n = 24) {
  const p = [];
  for (let i = 0; i <= n; i++) {
    const a = lerp(a0, a1, i / n);
    p.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return p;
}

export function ellPts(cx, cy, rx, ry, n = 32, a0 = 0) {
  const p = [];
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * TAU;
    p.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return p;
}

/** Catmull-Rom spline through control points. */
export function spline(c, closed = true, k = 8) {
  const n = c.length,
    out = [],
    P = (i) => (closed ? c[(i + n) % n] : c[clamp(i, 0, n - 1)]);
  const m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const p0 = P(i - 1),
      p1 = P(i),
      p2 = P(i + 1),
      p3 = P(i + 2);
    for (let j = 0; j < k; j++) {
      const t = j / k,
        t2 = t * t,
        t3 = t2 * t;
      out.push(
        [0, 1].map(
          (d) =>
            0.5 *
            (2 * p1[d] +
              (-p0[d] + p2[d]) * t +
              (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2 +
              (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3),
        ),
      );
    }
  }
  if (!closed) out.push(c[n - 1]);
  return out;
}

export function rr(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  const p = [];
  const c = [
    [x + w - r, y + r, -Math.PI / 2],
    [x + w - r, y + h - r, 0],
    [x + r, y + h - r, Math.PI / 2],
    [x + r, y + r, Math.PI],
  ];
  for (const [cx, cy, a] of c)
    for (let i = 0; i <= 6; i++) {
      const b = a + (i / 6) * (Math.PI / 2);
      p.push([cx + Math.cos(b) * r, cy + Math.sin(b) * r]);
    }
  return p;
}

export const rect = (x, y, w, h) => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];

export function quad(a, c, b, n = 16) {
  const p = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n,
      u = 1 - t;
    p.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]);
  }
  return p;
}

/** A constant-width noodle limb: a → b, quadratic bend, round caps. */
export function noodle(a, b, bend, w0, w1 = w0) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    L = Math.hypot(dx, dy) || 1,
    nx = -dy / L,
    ny = dx / L;
  const c = [(a[0] + b[0]) / 2 + nx * bend, (a[1] + b[1]) / 2 + ny * bend];
  const mid = quad(a, c, b, 14),
    L1 = [],
    R1 = [];
  for (let i = 0; i < mid.length; i++) {
    const p = mid[i],
      q = mid[Math.min(mid.length - 1, i + 1)],
      o = mid[Math.max(0, i - 1)];
    let tx = q[0] - o[0],
      ty = q[1] - o[1];
    const l = Math.hypot(tx, ty) || 1;
    tx /= l;
    ty /= l;
    const w = lerp(w0, w1, i / (mid.length - 1)) / 2;
    L1.push([p[0] - ty * w, p[1] + tx * w]);
    R1.push([p[0] + tx * w, p[1] - ty * w]);
  }
  const endA = Math.atan2(mid[mid.length - 1][1] - mid[mid.length - 2][1], mid[mid.length - 1][0] - mid[mid.length - 2][0]);
  const begA = Math.atan2(mid[1][1] - mid[0][1], mid[1][0] - mid[0][0]);
  const capB = arcPts(b[0], b[1], w1 / 2, w1 / 2, endA + Math.PI / 2, endA - Math.PI / 2, 8);
  const capA = arcPts(a[0], a[1], w0 / 2, w0 / 2, begA - Math.PI / 2, begA - Math.PI * 1.5, 8);
  return [...L1, ...capB, ...R1.reverse(), ...capA];
}

/** Create an engine bound to one 2-D context. */
export function createToon(g) {
  const S = { boil: 0, amp: 1.2, sid: 0, lw: 6, lwScale: 1 };
  let BASE = [1, 0, 0, 1, 0, 0];
  let M = [1, 0, 0, 1, 0, 0];
  const ST = [];

  const T = {
    g,
    S,
    push: () => ST.push(M.slice()),
    pop: () => {
      M = ST.pop();
    },
    reset: () => {
      M = BASE.slice();
      ST.length = 0;
    },
    setBase: (m) => {
      BASE = m.slice();
      M = BASE.slice();
    },
    setLwScale: (s) => {
      S.lwScale = s;
    },
    transform: (a, b, c, d, e, f) => {
      M = [
        M[0] * a + M[2] * b,
        M[1] * a + M[3] * b,
        M[0] * c + M[2] * d,
        M[1] * c + M[3] * d,
        M[0] * e + M[2] * f + M[4],
        M[1] * e + M[3] * f + M[5],
      ];
    },
    translate: (x, y) => {
      M = [M[0], M[1], M[2], M[3], M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
    },
    rotate: (a) => {
      const c = Math.cos(a),
        s = Math.sin(a);
      M = [M[0] * c + M[2] * s, M[1] * c + M[3] * s, -M[0] * s + M[2] * c, -M[1] * s + M[3] * c, M[4], M[5]];
    },
    scale: (sx, sy = sx) => {
      M = [M[0] * sx, M[1] * sx, M[2] * sy, M[3] * sy, M[4], M[5]];
    },
    tx: (x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]],
    zoom: () => Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2])),
    getM: () => M.slice(),
    setM: (m) => {
      M = m.slice();
    },

    /** Start a frame: pick the 12 fps boil drawing and reset the shape counter. */
    frame(t, { amp = 1.2 } = {}) {
      S.boil = Math.floor(t * 12 + 1e-6) % 3;
      S.amp = amp;
      S.sid = 0;
      M = BASE.slice();
      ST.length = 0;
      g.setTransform(BASE[0], BASE[1], BASE[2], BASE[3], BASE[4], BASE[5]);
    },

    ell(cx, cy, rx, ry, n = 0, a0 = 0) {
      if (!n) n = Math.max(16, Math.min(90, Math.round((rx + ry) * T.zoom() * 0.25)));
      return ellPts(cx, cy, rx, ry, n, a0);
    },
    arc: arcPts,
    spline,
    rr,
    rect,
    quad,
    noodle,

    shape(pts, o = {}) {
      const closed = o.closed !== false,
        id = S.sid++;
      const seed = hash(id * 1.37 + 3) * 90 + S.boil * 23.7;
      let s = toScreen(pts, closed);
      s = boilPts(s, closed, (o.boil ?? 1) * S.amp, seed);
      const P = pathOf(s, closed);
      g.setTransform(1, 0, 0, 1, 0, 0);
      if (o.alpha != null) g.globalAlpha = o.alpha;
      if (o.fill && closed) {
        g.fillStyle = o.fill;
        g.fill(P);
      }
      if (o.shade) {
        g.save();
        g.clip(P);
        o.shade();
        g.restore();
      }
      if (o.stroke !== false && o.line !== null) T.outline(P, o.lw ?? S.lw, o.line ?? '#0E0D0C');
      if (o.alpha != null) g.globalAlpha = 1;
      return P;
    },
    outline(P, lw = S.lw, col = '#0E0D0C') {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.lineWidth = lw * S.lwScale;
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.strokeStyle = col;
      g.stroke(P);
    },
    fillOnly(pts, fill, o = {}) {
      return T.shape(pts, { ...o, fill, stroke: false });
    },
    stroke(pts, lw = S.lw, o = {}) {
      return T.shape(pts, { ...o, closed: false, lw });
    },
    dot(x, y, r, col = '#0E0D0C') {
      const [a, b] = T.tx(x, y);
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = col;
      g.beginPath();
      g.arc(a, b, Math.max(1.5, r * T.zoom()), 0, TAU);
      g.fill();
    },
    screenRect(col, a = 1) {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = a;
      g.fillStyle = col;
      g.fillRect(0, 0, g.canvas.width, g.canvas.height);
      g.globalAlpha = 1;
    },
  };

  function toScreen(pts, closed) {
    const s = pts.map((p) => T.tx(p[0], p[1]));
    const out = [],
      step = 7;
    let acc = 0;
    const n = closed ? s.length : s.length - 1;
    out.push(s[0]);
    for (let i = 0; i < n; i++) {
      const a = s[i],
        b = s[(i + 1) % s.length],
        d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      let pos = step - acc;
      while (pos < d) {
        const u = pos / d;
        out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
        pos += step;
      }
      acc = d - (pos - step);
    }
    if (!closed) out.push(s[s.length - 1]);
    return out;
  }

  function boilPts(s, closed, amp, seed) {
    if (amp <= 0 || s.length < 3) return s;
    const n = s.length,
      L = n * 7,
      out = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = s[(i - 1 + n) % n],
        b = s[(i + 1) % n];
      const p = s[i],
        ia = closed ? a : s[Math.max(0, i - 1)],
        ib = closed ? b : s[Math.min(n - 1, i + 1)];
      let nx = -(ib[1] - ia[1]),
        ny = ib[0] - ia[0];
      const l = Math.hypot(nx, ny) || 1;
      nx /= l;
      ny /= l;
      const x = (i * 7) / 38;
      let v = vnoise(x + seed) * 2 - 1;
      if (closed) {
        const w = i / n;
        v = lerp(v, vnoise(x - L / 38 + seed) * 2 - 1, w);
      }
      const v2 = vnoise(x * 2.3 + seed * 1.7 + 50) * 2 - 1;
      const d = (v * 0.8 + v2 * 0.35) * amp;
      out[i] = [p[0] + nx * d, p[1] + ny * d];
    }
    return out;
  }

  function pathOf(s, closed) {
    const P = new Path2D();
    P.moveTo(s[0][0], s[0][1]);
    for (let i = 1; i < s.length; i++) P.lineTo(s[i][0], s[i][1]);
    if (closed) P.closePath();
    return P;
  }

  return T;
}
