// rubber-hose-actors.mjs — the reusable rubber-hose kit: pie eyes, mouths, gloves, shoes,
// constant-width noodle limbs, steam, and the object actors (mug, sugar cube,
// alarm clock, plate). The mug and cube rigs are adapted from LemoLab's
// lemo-opuscar `styles/rubber-hose/demo/chars.js` (MIT, commit e3cb16f6);
// the clock and plate are adapted from the same demo's `cast.js`. The spoon is
// new for this reference.
//
// All rig coordinates are local: the origin is the ground point between the
// feet, +y is down. The caller supplies the actor's world placement.

import { TAU, clamp, lerp, hash, spline, ellPts } from './rubber-hose-toon.mjs';

// Six-step grey ramp plus the separate character white. Characters own the
// extremes; backgrounds live in the middle greys.
export const P = {
  white: '#FCFBF7',
  paper: '#F1EEE6',
  pale: '#E2DFD6',
  light: '#C8C5BC',
  mid: '#9A978F',
  dmid: '#6B6963',
  dark: '#3B3A37',
  ink: '#0E0D0C',
};

const D2R = Math.PI / 180;

/** A tapered ribbon along a centreline (steam, fingers, spoon handles). */
export function ribbon(T, c, w0, w1 = w0, caps = true) {
  const n = c.length,
    L = [],
    R = [];
  for (let i = 0; i < n; i++) {
    const a = c[Math.max(0, i - 1)],
      b = c[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0],
      dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    const w = lerp(w0, w1, i / (n - 1)) / 2;
    L.push([c[i][0] - dy * w, c[i][1] + dx * w]);
    R.push([c[i][0] + dy * w, c[i][1] - dx * w]);
  }
  if (!caps) return [...L, ...R.reverse()];
  const e = c[n - 1],
    e2 = c[n - 2],
    s0 = c[0],
    s1 = c[1];
  const aE = Math.atan2(e[1] - e2[1], e[0] - e2[0]),
    aS = Math.atan2(s1[1] - s0[1], s1[0] - s0[0]);
  return [
    ...L,
    ...T.arc(e[0], e[1], w1 / 2, w1 / 2, aE + Math.PI / 2, aE - Math.PI / 2, 6),
    ...R.reverse(),
    ...T.arc(s0[0], s0[1], w0 / 2, w0 / 2, aS - Math.PI / 2, aS - Math.PI * 1.5, 6),
  ];
}

/** Union stroke: thick-stroke every part, then fill them, leaving one outline. */
export function union(T, list, fill, lw = T.S.lw) {
  const ps = list.map((pts) => T.shape(pts, { stroke: false }));
  ps.forEach((p) => T.outline(p, lw * 2));
  T.g.setTransform(1, 0, 0, 1, 0, 0);
  T.g.fillStyle = fill;
  ps.forEach((p) => T.g.fill(p));
  return ps;
}

export function fillLocal(T, pts, col) {
  const s = pts.map((p) => T.tx(p[0], p[1]));
  const g = T.g;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = col;
  g.beginPath();
  g.moveTo(s[0][0], s[0][1]);
  for (const q of s) g.lineTo(q[0], q[1]);
  g.closePath();
  g.fill();
}

/** Glove palm centre measured from the wrist along the arm axis, in rig units. */
const PALM_REACH = 22;

/** Inverse of the actor body transform for a world point, in rig space. */
function bodyInverse(p, wx, wy) {
  let x = wx - p.x,
    y = wy - p.y;
  if (p.mirror) x = -x;
  const k = p.k || 1;
  x /= k;
  y /= k;
  x /= p.sx || 1;
  y /= p.sy || 1;
  if (p.lean) {
    const c = Math.cos(-p.lean),
      s = Math.sin(-p.lean);
    [x, y] = [x * c - y * s, x * s + y * c];
  }
  return [x, y];
}

/**
 * Rig-space wrist target that puts the glove PALM at the world point (wx, wy).
 * The glove hangs 22·hk rig units past the wrist along the shoulder→wrist axis,
 * so the wrist is pulled back along the shoulder→grip line. Body squash,
 * stretch, scale, lean and mirror are inverted first.
 */
export function armHandLocal(p, shoulder, wx, wy, hk = 1) {
  const [gx, gy] = bodyInverse(p, wx, wy);
  const dx = gx - shoulder[0],
    dy = gy - shoulder[1],
    L = Math.hypot(dx, dy) || 1;
  const off = PALM_REACH * hk;
  return { x: gx - (dx / L) * off, y: gy - (dy / L) * off };
}

function roundPoly(T, pts, r) {
  const n = pts.length,
    out = [];
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n],
      b = pts[i],
      c = pts[(i + 1) % n];
    const la = Math.hypot(a[0] - b[0], a[1] - b[1]),
      lc = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const ra = Math.min(r, la * 0.45),
      rc = Math.min(r, lc * 0.45);
    const p0 = [b[0] + ((a[0] - b[0]) / la) * ra, b[1] + ((a[1] - b[1]) / la) * ra];
    const p1 = [b[0] + ((c[0] - b[0]) / lc) * rc, b[1] + ((c[1] - b[1]) / lc) * rc];
    out.push(...T.quad(p0, b, p1, 5));
  }
  return out;
}

function hull(ps) {
  const p = ps.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [],
    up = [];
  for (const q of p) {
    while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  for (const q of p.slice().reverse()) {
    while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

// ———————————————————— shared parts ————————————————————

/**
 * Pie eye: white oval, large black pupil with a pie wedge cut toward the upper
 * right. `type` open | wide | happy | squeeze | shut | sad.
 */
export function pieEye(T, cx, cy, rx, ry, o = {}) {
  const type = o.type || 'open',
    lw = T.S.lw * (o.lwk ?? 0.85);
  if (type === 'happy') {
    T.stroke(T.arc(cx, cy + ry * 0.35, rx * 0.95, ry * 0.55, Math.PI * 1.08, Math.PI * 1.92, 14), lw * 1.25);
    return;
  }
  if (type === 'shut') {
    T.stroke(T.arc(cx, cy - ry * 0.15, rx * 0.95, ry * 0.4, Math.PI * 0.1, Math.PI * 0.9, 12), lw * 1.2);
    return;
  }
  if (type === 'squeeze') {
    const s = o.side ?? 1;
    T.stroke(
      [
        [cx - rx * s, cy - ry * 0.6],
        [cx + rx * 0.8 * s, cy],
        [cx - rx * s, cy + ry * 0.6],
      ],
      lw * 1.35,
    );
    return;
  }
  const big = type === 'wide' ? 1.18 : 1;
  const eR = rx * big,
    eY = ry * big;
  const lx = clamp(o.lx ?? 0, -1, 1),
    ly = clamp(o.ly ?? 0, -1, 1);
  const pr = type === 'wide' ? 0.42 : 0.64,
    pry = type === 'wide' ? 0.48 : 0.74;
  const pcx = cx + lx * eR * (1 - pr) * 0.95,
    pcy = cy + ly * eY * (1 - pry) * 0.9 + eY * 0.05;
  T.shape(T.ell(cx, cy, eR, eY), {
    fill: P.white,
    lw,
    shade: () => {
      const w0 = -100 * D2R,
        w1 = -40 * D2R,
        prx = eR * pr,
        pry2 = eY * pry,
        pts = [];
      const apx = pcx + Math.cos((w0 + w1) / 2) * prx * 0.16,
        apy = pcy + Math.sin((w0 + w1) / 2) * pry2 * 0.16;
      for (let i = 0; i <= 28; i++) {
        const a = w1 + (i / 28) * (TAU - (w1 - w0));
        pts.push([pcx + Math.cos(a) * prx, pcy + Math.sin(a) * pry2]);
      }
      pts.push([apx, apy]);
      fillLocal(T, pts, P.ink);
      if (o.lid) {
        const yl = cy - eY + o.lid * 2 * eY;
        fillLocal(
          T,
          [
            [cx - eR * 1.2, cy - eY * 1.3],
            [cx + eR * 1.2, cy - eY * 1.3],
            [cx + eR * 1.2, yl + (o.lidTilt || 0) * eR],
            [cx - eR * 1.2, yl - (o.lidTilt || 0) * eR],
          ],
          o.lidCol || P.white,
        );
      }
    },
  });
  if (o.lid) {
    const yl = cy - eY + o.lid * 2 * eY,
      hw = Math.sqrt(Math.max(0, 1 - Math.pow((yl - cy) / eY, 2))) * eR;
    if (hw > 2)
      T.stroke(
        [
          [cx - hw, yl - (o.lidTilt || 0) * hw],
          [cx + hw, yl + (o.lidTilt || 0) * hw],
        ],
        lw * 1.05,
      );
  }
}

/** Brow: up (alarmed), sad, angry, flat, determined. `side` -1 left, +1 right. */
export function brow(T, cx, cy, w, type, side = 1) {
  const s = side,
    lw = T.S.lw * 1.15,
    ix = cx - s * w * 0.5,
    ox = cx + s * w * 0.5;
  if (type === 'up') T.stroke(T.arc(cx, cy + w * 0.5, w * 0.55, w * 0.4, Math.PI * 1.15, Math.PI * 1.85, 10), lw);
  else if (type === 'sad') T.stroke(T.quad([ix, cy - w * 0.36], [cx, cy - w * 0.14], [ox, cy + w * 0.06]), lw);
  else if (type === 'angry') T.stroke(T.quad([ix, cy + w * 0.14], [cx, cy - w * 0.06], [ox, cy - w * 0.3]), lw);
  else if (type === 'flat') T.stroke([[cx - w * 0.45, cy], [cx + w * 0.45, cy]], lw);
}

/** Mouth: smile / grin / open / o / frown / wavy / pucker / beam / yawn / flat. */
export function mouth(T, cx, cy, w, type = 'smile', o = {}) {
  const lw = T.S.lw * 0.95,
    h = w * (o.open ?? 0.6);
  const tongue = (pts) => () => fillLocal(T, pts, P.dmid);
  if (type === 'smile') {
    T.stroke(T.quad([cx - w / 2, cy - w * 0.08], [cx, cy + w * 0.32], [cx + w / 2, cy - w * 0.08]), lw * 1.1);
    T.stroke(T.arc(cx - w / 2 - 2, cy - w * 0.08, w * 0.09, w * 0.09, Math.PI * 0.6, Math.PI * 1.4, 6), lw * 0.8);
    T.stroke(T.arc(cx + w / 2 + 2, cy - w * 0.08, w * 0.09, w * 0.09, -Math.PI * 0.4, Math.PI * 0.4, 6), lw * 0.8);
    return;
  }
  if (type === 'frown') {
    T.stroke(T.quad([cx - w / 2, cy + w * 0.12], [cx, cy - w * 0.22], [cx + w / 2, cy + w * 0.12]), lw * 1.1);
    return;
  }
  if (type === 'flat') {
    T.stroke([[cx - w * 0.4, cy], [cx + w * 0.4, cy + 2]], lw * 1.1);
    return;
  }
  if (type === 'pucker') {
    T.stroke(
      T.spline(
        [
          [cx - w * 0.28, cy],
          [cx - w * 0.14, cy - w * 0.1],
          [cx, cy + w * 0.06],
          [cx + w * 0.14, cy - w * 0.1],
          [cx + w * 0.28, cy],
        ],
        false,
        6,
      ),
      lw * 1.1,
    );
    T.stroke(T.arc(cx - w * 0.42, cy - w * 0.02, w * 0.1, w * 0.16, Math.PI * 0.55, Math.PI * 1.45, 6), lw * 0.7);
    T.stroke(T.arc(cx + w * 0.42, cy - w * 0.02, w * 0.1, w * 0.16, -Math.PI * 0.45, Math.PI * 0.45, 6), lw * 0.7);
    return;
  }
  if (type === 'wavy') {
    const top = [],
      bot = [];
    for (let i = 0; i <= 12; i++) {
      const u = i / 12,
        x = cx - w / 2 + u * w;
      top.push([x, cy - h * 0.25 + Math.sin(u * TAU * 2) * w * 0.05]);
      bot.push([x, cy + h * 0.35 + Math.sin(u * TAU * 2 + 1) * w * 0.05]);
    }
    T.shape([...top, ...bot.reverse()], { fill: P.ink, lw });
    return;
  }
  if (type === 'o') {
    const r = w * 0.22;
    T.shape(T.ell(cx, cy + r * 0.2, r, r * 1.25 * (o.open ?? 1)), {
      fill: P.ink,
      lw,
      shade: tongue(T.ell(cx, cy + r * 1.25, r * 0.75, r * 0.55)),
    });
    return;
  }
  if (type === 'bleh') {
    mouth(T, cx, cy, w, 'open', { open: 0.45 });
    T.shape(
      T.spline(
        [
          [cx - w * 0.16, cy + w * 0.14],
          [cx - w * 0.2, cy + w * 0.42],
          [cx, cy + w * 0.58],
          [cx + w * 0.2, cy + w * 0.42],
          [cx + w * 0.16, cy + w * 0.14],
        ],
        true,
        6,
      ),
      { fill: P.dmid, lw: lw * 0.9 },
    );
    T.stroke([[cx, cy + w * 0.2], [cx, cy + w * 0.42]], lw * 0.6);
    return;
  }
  if (type === 'yawn') {
    const r = w * 0.3;
    T.shape(T.ell(cx, cy + r * 0.5, r, r * 1.5), {
      fill: P.ink,
      lw,
      shade: tongue(T.ell(cx, cy + r * 1.6, r * 0.8, r * 0.6)),
    });
    return;
  }
  const up = type === 'beam' ? 0.1 : type === 'grin' ? 0.04 : -0.02;
  const pts = [
    ...T.quad([cx - w / 2, cy - w * up], [cx, cy + w * (up * 0.6)], [cx + w / 2, cy - w * up], 10),
    ...T.quad([cx + w / 2, cy - w * up], [cx, cy + h * 1.55], [cx - w / 2, cy - w * up], 14).slice(1),
  ];
  T.shape(pts, {
    fill: P.ink,
    lw,
    shade: () => {
      fillLocal(T, T.ell(cx, cy + h * 0.95, w * 0.26, h * 0.42), P.dmid);
      if (type === 'grin' || type === 'beam')
        fillLocal(
          T,
          [
            [cx - w / 2, cy - w * up - 20],
            [cx + w / 2, cy - w * up - 20],
            [cx + w / 2, cy + h * 0.18],
            [cx - w / 2, cy + h * 0.18],
          ],
          P.white,
        );
    },
  });
  if (type === 'grin' || type === 'beam') {
    T.stroke(T.arc(cx - w / 2 - 3, cy - w * up, w * 0.08, w * 0.1, Math.PI * 0.5, Math.PI * 1.5, 6), lw * 0.8);
    T.stroke(T.arc(cx + w / 2 + 3, cy - w * up, w * 0.08, w * 0.1, -Math.PI * 0.5, Math.PI * 0.5, 6), lw * 0.8);
  }
}

/**
 * White four-finger glove. Local: wrist at the origin, fingers toward +x.
 * `type` open | fist | point | grab | wave | thumb.
 */
export function glove(T, x, y, ang, type = 'open', k = 1, o = {}) {
  T.push();
  T.translate(x, y);
  T.rotate(ang);
  T.scale(k, k * (o.flip ? -1 : 1));
  const fw = 13.5,
    parts = [];
  const finger = (a, len, w = fw, curl = 0) => {
    const b = [PALM_REACH + Math.cos(a * D2R) * len, Math.sin(a * D2R) * len];
    const c = [
      PALM_REACH + Math.cos(a * D2R) * len * 0.55 + Math.cos((a + 90) * D2R) * curl,
      Math.sin(a * D2R) * len * 0.55 + Math.sin((a + 90) * D2R) * curl,
    ];
    parts.push(ribbon(T, T.quad([PALM_REACH, 0], c, b, 8), w, w * 0.96));
  };
  if (type === 'open' || type === 'wave') {
    finger(-34, 30);
    finger(-4, 33);
    finger(27, 29);
    finger(-88, 22, fw * 1.05);
  } else if (type === 'point') {
    finger(-6, 44, fw * 0.95);
    finger(-95, 18, fw * 1.05);
  } else if (type === 'grab') {
    finger(-26, 24, fw, 9);
    finger(2, 26, fw, 9);
    finger(28, 22, fw, 9);
    finger(-88, 19, fw * 1.05);
  } else if (type === 'thumb') {
    finger(-90, 26, fw * 1.1);
  } else if (type === 'fist') {
    finger(-90, 14, fw * 1.1);
  }
  const palmR = type === 'fist' || type === 'point' || type === 'thumb' ? 19 : 17;
  parts.push(T.ell(PALM_REACH, 0, palmR, palmR * 0.95, 26));
  const cuff = T.spline(
    [
      [-6, -12],
      [4, -20],
      [11, -15],
      [11, 15],
      [4, 20],
      [-6, 12],
      [-8, 0],
    ],
    true,
    5,
  );
  union(T, [...parts, cuff], P.white);
  const lw = T.S.lw * 0.6;
  if (type !== 'fist' && type !== 'point' && type !== 'thumb') {
    for (const dy of [-6, 0, 6]) T.stroke([[14, dy * 1.1], [25, dy * 1.4]], lw, { boil: 0.5 });
  } else {
    T.stroke(T.arc(30, 0, 9, 13, -1.2, 1.2, 8), lw);
    T.stroke([[31, -6], [38, -7]], lw);
    T.stroke([[31, 6], [38, 7]], lw);
  }
  T.stroke(T.quad([2, -16], [6, 0], [2, 16]), lw);
  T.pop();
}

/** Big round shoe. Local: heel at the origin, toe toward +x. */
export function shoe(T, x, y, dir = 1, k = 1, ang = 0) {
  T.push();
  T.translate(x, y);
  T.rotate(ang);
  T.scale(dir * k, k);
  T.shape(
    T.spline(
      [
        [-15, 0],
        [-17, -12],
        [-6, -19],
        [10, -21],
        [27, -18],
        [37, -8],
        [34, 3],
        [12, 5],
        [-8, 4],
      ],
      true,
      6,
    ),
    { fill: P.ink, lw: T.S.lw * 0.9 },
  );
  T.shape(T.ell(22, -12, 7, 3.6, 12, 0), { fill: P.white, stroke: false, boil: 0.3 });
  T.pop();
}

/** An equal-width rubber-hose limb. */
export const hose = (T, a, b, bend, w, col = P.ink) => T.shape(T.noodle(a, b, bend, w, w), { fill: col, lw: T.S.lw * 0.8 });

/** Steam; the secondary feature that carries the mug's mood. */
export function steam(T, x, y, type = 'lazy', t = 0, k = 1) {
  if (type === 'none') return;
  const lw = T.S.lw * 0.8,
    col = type === 'bitter' ? P.mid : P.white;
  if (type === 'sad') {
    const c = T.spline(
      [
        [x - 8 * k, y],
        [x - 14 * k, y - 42 * k],
        [x + 4 * k, y - 76 * k],
        [x + 36 * k, y - 70 * k],
        [x + 46 * k, y - 44 * k + Math.sin(t * 4) * 3 * k],
      ],
      false,
      6,
    );
    T.shape(ribbon(T, c, 14 * k, 4 * k), { fill: col, lw });
    return;
  }
  const wisps = type === 'heart' ? [] : [
    [-26, 0, 0.9],
    [2, 0.4, 1.1],
    [28, 0.8, 0.85],
  ];
  for (const [dx, ph, sc] of wisps) {
    const c = [];
    for (let i = 0; i <= 16; i++) {
      const u = i / 16,
        hgt = 110 * sc * k;
      let px = x + dx * k,
        py = y - u * hgt;
      if (type === 'lazy') {
        px += Math.sin(u * 5 + t * 5 + ph * 7) * 10 * u * k;
        py += u * u * 30 * k;
        px += u * u * 22 * k * Math.sign(dx || 1);
      }
      if (type === 'bitter') px += (i % 4 < 2 ? 1 : -1) * 13 * k * (0.5 + u);
      if (type === 'blown') {
        px = x + dx * 0.4 * k - u * hgt * 1.1;
        py = y - u * 36 * k + Math.sin(u * 7 + t * 16 + ph * 5) * 7 * k * u + dx * 0.3 * k;
      }
      if (type === 'up') {
        px += Math.sin(i * 2.7 + t * 30) * 2 * k;
        py -= u * 20 * k;
      }
      if (type === 'sad') {
        const sd = dx > 5 ? 1 : dx < -5 ? -1 : 0;
        px = x + dx * 0.6 * k + sd * Math.sin(u * 2.2) * 46 * k * sc + (sd ? 0 : Math.sin(u * 4) * 6 * k);
        py = y - (sd ? Math.sin(u * 2.6) * 44 : u * 50) * k * sc;
      }
      c.push([px, py]);
    }
    const pts = type === 'bitter' ? c.filter((_, i) => i % 2 === 0) : T.spline(c.filter((_, i) => i % 2 === 0), false, 5);
    T.shape(ribbon(T, pts, (type === 'bitter' ? 16 : 13) * k, (type === 'bitter' ? 5 : 3) * k), { fill: col, lw });
  }
  if (type === 'heart') {
    const hy = y - 95 * k,
      r = 26 * k;
    const L = [
      [x, y - 4 * k],
      [x - 8 * k, y - 30 * k],
      [x - 34 * k, hy + 34 * k],
      [x - 2 * r, hy],
      [x - r * 1.4, hy - r * 1.05],
      [x - r * 0.4, hy - r * 0.95],
      [x, hy - r * 0.35],
    ];
    const R = L.map((p) => [2 * x - p[0], p[1]]);
    T.shape(ribbon(T, T.spline(L, false, 6), 12 * k, 8 * k), { fill: P.white, lw });
    T.shape(ribbon(T, T.spline(R, false, 6), 12 * k, 8 * k), { fill: P.white, lw });
  }
}

// ———————————————————— the mug ————————————————————

export const MUG = { R: 104, y0: -70, y1: -250, leg: 70, ry: 24 };

/** Rig-space shoulder for the mug's left (-1) or right (+1) arm. */
export function mugShoulder(s) {
  return [s * (MUG.R - 8), -150];
}

/**
 * The visible coffee surface (the dark inner ellipse in mug()) in design space,
 * carried through the same body transform as the mug. A front layer of a spoon
 * that is inside the cup may be clipped to this aperture instead of floating
 * over the rim and front wall.
 */
export function mugCoffeeAperture(p) {
  const k = p.k || 1,
    sx = p.sx || 1,
    sy = p.sy || 1,
    lean = p.lean || 0,
    c = Math.cos(lean),
    s = Math.sin(lean);
  return ellPts(0, MUG.y1 + 1.5, MUG.R - 11, MUG.ry - 6, 40).map(([x0, y0]) => {
    let x = x0,
      y = y0;
    if (lean) [x, y] = [x * c - y * s, x * s + y * c];
    x = x * sx * k;
    y = y * sy * k;
    if (p.mirror) x = -x;
    return [x + p.x, y + p.y];
  });
}

function mugArmAngle(A, s, sh) {
  if (A.rot != null) return A.rot;
  if (A.via) {
    const c = spline([sh, ...A.via, [A.x, A.y]], false, 10);
    const q = c[c.length - 3];
    return Math.atan2(A.y - q[1], A.x - q[0]);
  }
  return Math.atan2(A.y - sh[1], A.x - sh[0]);
}

/**
 * The hero mug. `p`:
 *   x,y,k,turn(°),mirror,sx,sy,lean,shake,t,
 *   armL/armR {x,y,hand,rot,bend,via,front,grip},
 *   legL/legR {x,y,bend,dir,ang},
 *   eyes {type,lx,ly,lid}, mouth {type,open,w}, brows, blush,
 *   steam ('lazy'|'bitter'|'up'|'heart'|'sad'|'blown'|'none'), steamX
 */
export function mug(T, p) {
  const { R, y0, y1 } = MUG,
    th = (p.turn || 0) * D2R;
  T.push();
  T.translate(p.x, p.y);
  if (p.mirror) T.scale(-1, 1);
  T.scale(p.k || 1);
  T.scale(p.sx || 1, p.sy || 1);
  if (p.lean) T.rotate(p.lean);
  const hipY = y0 + 6;

  const legs = [
    ['legL', -1],
    ['legR', 1],
  ];
  for (const [key, s] of legs) {
    const L = p[key] || { x: s * 36, y: 0 };
    hose(T, [s * 30, hipY], [L.x, L.y - 8], L.bend ?? s * 4, 14);
  }
  for (const [key, s] of legs) {
    const L = p[key] || { x: s * 36, y: 0 };
    shoe(T, L.x - (L.dir ?? (p.turn ? 1 : s)) * 6, L.y, L.dir ?? (Math.abs(p.turn || 0) > 20 ? 1 : s), 1, L.ang || 0);
  }

  const shoulderY = -150;
  const arm = (key, s) => {
    const A = p[key];
    if (!A) return;
    const sh = [s * (R - 8), shoulderY];
    let ang;
    if (A.via) {
      const c = spline([sh, ...A.via, [A.x, A.y]], false, 10);
      T.shape(ribbon(T, c, 13, 13), { fill: P.ink, lw: T.S.lw * 0.8 });
      const q = c[c.length - 3];
      ang = A.rot ?? Math.atan2(A.y - q[1], A.x - q[0]);
    } else {
      hose(T, sh, [A.x, A.y], A.bend ?? s * -14, 13);
      ang = A.rot ?? Math.atan2(A.y - sh[1], A.x - sh[0]);
    }
    if (!A.grip) glove(T, A.x, A.y, ang, A.hand || 'open', A.hk || 1, { flip: A.flip ?? s < 0 });
  };
  for (const [key, s] of [
    ['armL', -1],
    ['armR', 1],
  ])
    if (p[key] && !p[key].front) arm(key, s);

  const ha = th - 120 * D2R,
    hs = Math.sin(ha),
    hz = Math.cos(ha);
  const handle = () => {
    const pts = [],
      n = 18;
    for (let i = 0; i <= n; i++) {
      const u = i / n,
        a = u * Math.PI;
      const r = R + 2 + Math.sin(a) * 60,
        yy = lerp(-214, -118, (1 - Math.cos(a)) / 2) + Math.sin(a) * 6;
      pts.push([r * hs, yy]);
    }
    const P2 = T.shape(pts, { closed: false, stroke: false });
    const g = T.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const zk = T.zoom();
    g.strokeStyle = P.ink;
    g.lineWidth = 24 * zk + T.S.lw * 2 * T.S.lwScale;
    g.stroke(P2);
    g.strokeStyle = P.white;
    g.lineWidth = 24 * zk;
    g.stroke(P2);
    g.strokeStyle = P.light;
    g.lineWidth = 7 * zk;
    g.globalAlpha = 0.9;
    g.stroke(P2);
    g.globalAlpha = 1;
  };
  if (hz <= 0) handle();

  const ry = MUG.ry,
    rb = R * 0.9;
  const side = (s) => T.quad([s * R, y1], [s * R * 1.1, (y1 + y0) / 2], [s * rb, y0 - 6], 12);
  const bodyOutline = [
    ...T.arc(0, y1, R, ry, Math.PI, TAU, 24),
    ...side(1).slice(1),
    ...T.arc(0, y0 - 6, rb, ry * 0.95, 0, Math.PI, 24).slice(1),
    ...side(-1).reverse().slice(1),
  ];
  T.shape(bodyOutline, {
    fill: P.white,
    shade: () => {
      const sh = [];
      for (let i = 0; i <= 20; i++) {
        const u = i / 20,
          yy = lerp(y1, y0 + 20, u);
        sh.push([R * 0.6 + Math.sin(u * Math.PI) * 4, yy]);
      }
      fillLocal(
        T,
        [...sh, [R + 20, y0 + 30], [R + 20, y1 - 30]],
        P.light,
      );
      const band = (yy, w) => T.stroke(T.arc(0, yy, R + 2, ry, 0, Math.PI, 24), w, { boil: 0.6 });
      band(y1 + 17, T.S.lw * 1.9);
      band(y1 + 33, T.S.lw * 0.7);
    },
  });
  T.shape(T.ell(0, y1, R, ry, 40), { fill: P.white, lw: T.S.lw * 0.9 });
  T.shape(T.ell(0, y1 + 1.5, R - 11, ry - 6, 40), { fill: P.ink, lw: T.S.lw * 0.6 });
  T.shape(ribbon(T, T.arc(-8, y1 + 1, R - 26, ry - 11, Math.PI * 1.12, Math.PI * 1.55, 10), 3, 6), {
    fill: P.white,
    stroke: false,
    boil: 0.3,
  });
  if (hz > 0) handle();

  const showFace = Math.cos(th) > -0.25;
  const fx = R * 0.7 * Math.sin(th),
    fk = 0.56 + 0.44 * Math.cos(th),
    fy = -172;
  const sj = p.shake ? [Math.sin(p.t * 97) * p.shake, Math.cos(p.t * 83) * p.shake * 0.5] : [0, 0];
  T.push();
  T.translate(sj[0], sj[1]);
  if (showFace) {
    const E = p.eyes || {},
      eyeDX = 24 * fk,
      erx = 23 * (0.7 + 0.3 * fk),
      ery = 33;
    const eyeFar = Math.abs(p.turn || 0) < 58;
    const sgn = Math.sin(th) >= 0 ? 1 : -1;
    const eyeL = [fx - eyeDX, fy],
      eyeR = [fx + eyeDX, fy];
    const lidCol = P.white;
    const drawEye = (c, side) => pieEye(T, c[0], c[1], erx, ery, { ...E, lx: E.lx ?? 0, lidCol, side });
    if (eyeFar || sgn > 0) drawEye(eyeL, 1);
    if (eyeFar || sgn < 0) drawEye(eyeR, -1);
    if (p.brows) {
      brow(T, eyeL[0], fy - ery - 10, 32, p.brows, -1);
      if (eyeFar) brow(T, eyeR[0], fy - ery - 10, 32, p.brows, 1);
    }
    const nx = fx + 14 * Math.sin(th) * 1.9,
      ny = fy + 36;
    T.shape(T.ell(nx, ny, 13 * (0.8 + 0.2 * fk), 10, 18), { fill: P.ink, lw: T.S.lw * 0.6 });
    T.shape(T.ell(nx - 3, ny - 3, 3.2, 2.2, 10), { fill: P.white, stroke: false, boil: 0 });
    const M = p.mouth || { type: 'smile' };
    mouth(T, fx + 8 * Math.sin(th), fy + 62, (M.w || 66) * (0.7 + 0.3 * fk), M.type, M);
    if (p.blush) {
      T.shape(T.ell(fx - eyeDX - 22, fy + 46, 12, 7), { fill: P.light, stroke: false, boil: 0.3 });
      if (eyeFar) T.shape(T.ell(fx + eyeDX + 22, fy + 46, 12, 7), { fill: P.light, stroke: false, boil: 0.3 });
    }
  }
  T.pop();

  for (const [key, s] of [
    ['armL', -1],
    ['armR', 1],
  ])
    if (p[key] && p[key].front) arm(key, s);

  if (p.steam !== 'none') steam(T, p.steamX || 0, y1 - 8, p.steam || 'lazy', p.t || 0);
  T.pop();
}

/** Draw only the gloves of mug arms flagged `grip`, over the held prop. */
export function mugGripGloves(T, p) {
  const th = (p.turn || 0) * D2R;
  T.push();
  T.translate(p.x, p.y);
  if (p.mirror) T.scale(-1, 1);
  T.scale(p.k || 1);
  T.scale(p.sx || 1, p.sy || 1);
  if (p.lean) T.rotate(p.lean);
  for (const [key, s] of [
    ['armL', -1],
    ['armR', 1],
  ]) {
    const A = p[key];
    if (!A || !A.grip) continue;
    const sh = [s * (MUG.R - 8), -150];
    const ang = mugArmAngle(A, s, sh);
    glove(T, A.x, A.y, ang, A.hand || 'grab', A.hk || 1, { flip: A.flip ?? s < 0 });
  }
  T.pop();
}

// ———————————————————— the sugar cube ————————————————————

export const CUBE = { a: 66, leg: 28, e: 0.26 };

function cubeHull(p) {
  const { a, e } = CUBE,
    legLen = p.legLen ?? CUBE.leg,
    th = (p.turn || 0) * D2R;
  const h = a / 2,
    ce = Math.cos(e),
    se = Math.sin(e),
    ct = Math.cos(th),
    st = Math.sin(th);
  const pr = (X, Y, Z) => {
    const x2 = X * ct + Z * st,
      z2 = -X * st + Z * ct;
    return [x2, -Y * ce + z2 * se - legLen];
  };
  const V = [];
  for (const X of [-h, h]) for (const Y of [0, a]) for (const Z of [-h, h]) V.push(pr(X, Y, Z));
  const hl = hull(V),
    xs = hl.map((q) => q[0]);
  return { hl, minX: Math.min(...xs), maxX: Math.max(...xs), midY: -legLen - a * 0.45 * ce };
}

/** Rig-space shoulder for the cube's left (-1) or right (+1) arm. */
export function cubeShoulder(p, s) {
  const { minX, maxX, midY } = cubeHull(p);
  return [s > 0 ? maxX - 5 : minX + 5, midY];
}

/**
 * The sugar cube, a real projected 3-D box with the face mapped onto its front.
 * `p`: x,y,k,turn,sx,sy,lean,armL/armR,legL/legR,eyes,mouth,brows,sweat,blush
 */
export function cube(T, p) {
  const { a, e } = CUBE,
    legLen = p.legLen ?? CUBE.leg,
    th = (p.turn || 0) * D2R;
  T.push();
  T.translate(p.x, p.y);
  if (p.mirror) T.scale(-1, 1);
  T.scale(p.k || 1);
  T.scale(p.sx || 1, p.sy || 1);
  if (p.lean) T.rotate(p.lean);
  const h = a / 2,
    ce = Math.cos(e),
    se = Math.sin(e),
    ct = Math.cos(th),
    st = Math.sin(th);
  const pr = (X, Y, Z) => {
    const x2 = X * ct + Z * st,
      z2 = -X * st + Z * ct;
    return [x2, -Y * ce + z2 * se - legLen];
  };
  const V = [];
  for (const X of [-h, h]) for (const Y of [0, a]) for (const Z of [-h, h]) V.push({ X, Y, Z, p: pr(X, Y, Z) });

  const F = [
    { n: 'front', N: [st, 0, ct], q: [[-h, a, h], [h, a, h], [h, 0, h], [-h, 0, h]] },
    { n: 'right', N: [ct, 0, -st], q: [[h, a, h], [h, a, -h], [h, 0, -h], [h, 0, h]] },
    { n: 'back', N: [-st, 0, -ct], q: [[h, a, -h], [-h, a, -h], [-h, 0, -h], [h, 0, -h]] },
    { n: 'left', N: [-ct, 0, st], q: [[-h, a, -h], [-h, a, h], [-h, 0, h], [-h, 0, -h]] },
    { n: 'top', N: [0, 1, 0], q: [[-h, a, -h], [h, a, -h], [h, a, h], [-h, a, h]] },
  ];
  const vis = F.filter((f) => f.n === 'top' || f.N[2] > 0.02);
  const light = [-0.55, 0.75, 0.45],
    tone = (f) => {
      const d = f.N[0] * light[0] + f.N[1] * light[1] + f.N[2] * light[2];
      return d > 0.5 ? P.white : d > 0.05 ? P.pale : P.light;
    };

  for (const [key, s] of [
    ['legL', -1],
    ['legR', 1],
  ]) {
    const L = p[key] || { x: s * 15, y: 0 };
    hose(T, [s * 13, -legLen + 6], [L.x, L.y - 5], L.bend ?? s * 3, 8);
  }
  for (const [key, s] of [
    ['legL', -1],
    ['legR', 1],
  ]) {
    const L = p[key] || { x: s * 15, y: 0 };
    shoe(T, L.x - 4 * (L.dir ?? s), L.y, L.dir ?? (Math.abs(p.turn || 0) > 20 ? 1 : s), 0.56, L.ang || 0);
  }

  const { hl, minX, maxX, midY } = cubeHull(p);
  const arm = (key, s) => {
    const A = p[key];
    if (!A) return;
    const sh = [s > 0 ? maxX - 5 : minX + 5, midY];
    const ang = A.rot ?? Math.atan2(A.y - sh[1], A.x - sh[0]);
    hose(T, sh, [A.x, A.y], A.bend ?? s * -8, 7.5);
    if (!A.grip) glove(T, A.x, A.y, ang, A.hand || 'open', A.hk ?? 0.52, { flip: A.flip ?? s < 0 });
  };
  for (const [key, s] of [
    ['armL', -1],
    ['armR', 1],
  ])
    if (p[key] && !p[key].front) arm(key, s);

  const sil = roundPoly(T, hl, 9);
  const faceAffine = (f) => {
    const c = f.q.map((q) => pr(q[0], q[1], q[2]));
    const o = [(c[0][0] + c[2][0]) / 2, (c[0][1] + c[2][1]) / 2];
    const u = [(c[1][0] - c[0][0]) / 2, (c[1][1] - c[0][1]) / 2];
    const v = [(c[3][0] - c[0][0]) / 2, (c[3][1] - c[0][1]) / 2];
    return [u[0], u[1], v[0], v[1], o[0], o[1]];
  };
  T.shape(sil, {
    fill: P.white,
    shade: () => {
      for (const f of vis) {
        fillLocal(T, f.q.map((q) => pr(q[0], q[1], q[2])), tone(f));
        const A = faceAffine(f);
        T.push();
        T.transform(...A);
        for (let i = 0; i < 16; i++) {
          const u = hash(i * 3.1 + f.n.length * 7) * 1.7 - 0.85,
            v = hash(i * 5.7 + f.n.length * 3) * 1.7 - 0.85;
          const pt = T.tx(u, v),
            g = T.g;
          g.setTransform(1, 0, 0, 1, 0, 0);
          g.fillStyle = f.n === 'top' ? P.light : P.mid;
          g.globalAlpha = 0.55;
          g.fillRect(pt[0] - 1.2, pt[1] - 1.2, 2.6, 2.4);
          g.globalAlpha = 1;
        }
        T.pop();
      }
    },
  });
  const edges = [];
  for (let i = 0; i < vis.length; i++)
    for (let j = i + 1; j < vis.length; j++) {
      const A = vis[i].q,
        B = vis[j].q,
        sh = A.filter((q) => B.some((r) => r[0] === q[0] && r[1] === q[1] && r[2] === q[2]));
      if (sh.length === 2) edges.push(sh.map((q) => pr(q[0], q[1], q[2])));
    }
  for (const [e0, e1] of edges) {
    const k0 = 0.12,
      a0 = [lerp(e0[0], e1[0], k0), lerp(e0[1], e1[1], k0)],
      a1 = [lerp(e0[0], e1[0], 1 - k0), lerp(e0[1], e1[1], 1 - k0)];
    T.stroke([a0, a1], T.S.lw * 0.6, { boil: 0.6 });
  }
  const front = vis.find((f) => f.n === 'front');
  if (front && front.N[2] > 0.3) {
    T.push();
    T.transform(...faceAffine(front));
    T.scale(1 / 33, 1 / 33);
    const E = p.eyes || {},
      ex = 11.5,
      ey = -7;
    pieEye(T, -ex, ey, 10.5, 15, { ...E, lidCol: P.white, lwk: 0.7, side: 1 });
    pieEye(T, ex, ey, 10.5, 15, { ...E, lidCol: P.white, lwk: 0.7, side: -1 });
    if (p.brows) {
      brow(T, -ex, ey - 20, 15, p.brows, -1);
      brow(T, ex, ey - 20, 15, p.brows, 1);
    }
    const M = p.mouth || { type: 'smile' };
    mouth(T, 0, 16, M.w || 25, M.type, M);
    if (p.blush !== false) {
      T.shape(T.ell(-21, 11, 5, 3), { fill: P.light, stroke: false, boil: 0.3 });
      T.shape(T.ell(21, 11, 5, 3), { fill: P.light, stroke: false, boil: 0.3 });
    }
    T.pop();
  }
  for (const [key, s] of [
    ['armL', -1],
    ['armR', 1],
  ])
    if (p[key] && p[key].front) arm(key, s);
  if (p.sweat)
    for (const [sx, sy, r] of p.sweat)
      T.shape(
        T.spline(
          [
            [sx, sy - r * 1.6],
            [sx + r, sy],
            [sx, sy + r],
            [sx - r, sy],
          ],
          true,
          5,
        ),
        { fill: P.white, lw: T.S.lw * 0.6 },
      );
  T.pop();
}

/** Draw only the gloves of cube arms flagged `grip`, over the held prop. */
export function cubeGripGloves(T, p) {
  const { midY, minX, maxX } = cubeHull(p);
  T.push();
  T.translate(p.x, p.y);
  if (p.mirror) T.scale(-1, 1);
  T.scale(p.k || 1);
  T.scale(p.sx || 1, p.sy || 1);
  if (p.lean) T.rotate(p.lean);
  for (const [key, s] of [
    ['armL', -1],
    ['armR', 1],
  ]) {
    const A = p[key];
    if (!A || !A.grip) continue;
    const sh = [s > 0 ? maxX - 5 : minX + 5, midY];
    const ang = A.rot ?? Math.atan2(A.y - sh[1], A.x - sh[0]);
    glove(T, A.x, A.y, ang, A.hand || 'grab', A.hk ?? 0.52, { flip: A.flip ?? s < 0 });
  }
  T.pop();
}

// ———————————————————— living props ————————————————————

/** Just the bowl, for the front layer of a spoon resting inside a cup. */
export function spoonBowl(T, s) {
  T.push();
  T.translate(s.x, s.y);
  T.rotate(s.a || 0);
  T.scale(s.k || 1);
  T.shape(T.ell(-100, 0, 23, 16, 30), {
    fill: P.pale,
    lw: T.S.lw * 0.8,
    shade: () => fillLocal(T, T.ell(-103, 2, 16, 10, 24), P.light),
  });
  T.stroke(T.arc(-100, -1, 14, 8, Math.PI * 1.05, Math.PI * 1.95, 12), T.S.lw * 0.55, { line: P.white, boil: 0.4 });
  T.pop();
}

/** A spoon. Local: grip at the origin, handle toward +x, bowl at +100. */
export function spoon(T, s) {
  T.push();
  T.translate(s.x, s.y);
  T.rotate(s.a || 0);
  T.scale(s.k || 1);
  T.shape(ribbon(T, [[-14, 0], [-46, 1], [-74, 1], [-88, 0]], 12, 9), { fill: P.pale, lw: T.S.lw * 0.8 });
  T.pop();
  spoonBowl(T, s);
  T.push();
  T.translate(s.x, s.y);
  T.rotate(s.a || 0);
  T.scale(s.k || 1);
  T.shape(T.ell(-14, 0, 7, 7), { fill: P.pale, lw: T.S.lw * 0.7 });
  T.pop();
}

/** Alarm clock: the face is the face, the two bells are its hat. */
export function clock(T, x, y, k = 1, b = 0, o = {}) {
  T.push();
  T.translate(x, y);
  T.scale(k);
  const ring = o.ring || 0,
    jit = ring ? Math.sin((o.t || 0) * 120) * 5 * ring : 0;
  T.translate(jit, -Math.abs(Math.sin((o.t || 0) * 30)) * 16 * ring);
  T.rotate(jit * 0.01);
  T.scale(1 - b * 0.036, 1 + b * 0.06);
  shoe(T, -40, 0, -1, 0.6);
  shoe(T, 40, 0, 1, 0.6);
  hose(T, [-26, -24], [-40, -8], 3, 9);
  hose(T, [26, -24], [40, -8], -3, 9);
  for (const s of [-1, 1]) {
    T.push();
    T.translate(s * 52, -146);
    T.rotate(s * (0.5 + (ring ? Math.sin((o.t || 0) * 90 + s) * 0.15 : 0)));
    T.shape(T.arc(0, 10, 34, 34, Math.PI, TAU, 18), { fill: P.dmid });
    T.shape(T.ell(0, -26, 6, 6), { fill: P.dark });
    T.pop();
  }
  T.stroke([[0, -150], [0, -176]], T.S.lw * 1.4);
  T.shape(T.ell(0, -180, 8, 8), { fill: P.dark });
  T.shape(T.ell(0, -86, 72, 72, 48), { fill: P.dmid });
  T.shape(T.ell(0, -86, 58, 58, 44), {
    fill: P.white,
    shade: () => {
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * TAU;
        T.stroke(
          [
            [Math.cos(a) * 49, -86 + Math.sin(a) * 49],
            [Math.cos(a) * 55, -86 + Math.sin(a) * 55],
          ],
          T.S.lw * (i % 3 ? 0.5 : 0.9),
          { boil: 0.3 },
        );
      }
    },
  });
  pieEye(T, -17, -104, 12, 17, { lx: o.lx || 0, ly: o.ly || 0, type: o.eyes, lwk: 0.7 });
  pieEye(T, 17, -104, 12, 17, { lx: o.lx || 0, ly: o.ly || 0, type: o.eyes, lwk: 0.7 });
  const hA = (7 / 12) * TAU - Math.PI / 2;
  T.stroke([[0, -80], [Math.cos(hA) * 30, -80 + Math.sin(hA) * 30]], T.S.lw * 1.1);
  T.stroke([[0, -80], [0, -80 - 44]], T.S.lw * 0.7);
  T.shape(T.ell(0, -80, 5, 5), { fill: P.ink });
  mouth(T, 6, -58, 26, o.mouth || 'smile', { open: 0.7 });
  T.pop();
}

/** A single plate; `press` pushes it down when stepped on, `rot` tilts it. */
export function plate(T, x, y, k = 1, o = {}) {
  T.push();
  T.translate(x, y + (o.press || 0) * 9);
  T.scale(k);
  T.rotate(o.rot || 0);
  T.shape([...T.arc(0, -8, 62, 13, 0, Math.PI, 16), ...T.arc(0, 0, 62, 13, Math.PI, 0, 16)], { fill: P.pale });
  T.shape(T.ell(0, -8, 62, 13, 30), {
    fill: P.white,
    shade: () => T.stroke(T.arc(0, -8, 44, 8, 0, TAU, 24), T.S.lw * 0.5, { line: P.mid }),
  });
  T.pop();
}

/** A hanging ladle; origin at the hook, `swing` in radians. */
export function hangingLadle(T, x, y, k = 1, swing = 0) {
  T.push();
  T.translate(x, y);
  T.scale(k);
  T.shape(T.ell(0, 0, 6, 6), { fill: P.dark });
  T.rotate(swing);
  T.stroke([[0, 0], [0, 18]], T.S.lw * 0.8);
  T.shape(ribbon(T, [[0, 18], [0, 150]], 10, 10), { fill: P.light });
  T.shape(T.arc(0, 150, 34, 30, 0, Math.PI, 16), {
    fill: P.light,
    shade: () => T.shape(T.rect(8, 140, 30, 50), { fill: P.mid, stroke: false, boil: 0 }),
  });
  T.pop();
}
