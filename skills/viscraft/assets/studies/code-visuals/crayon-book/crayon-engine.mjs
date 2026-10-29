/*
 * Crayon mark engine for the crayon-book reference.
 *
 * The methods are adapted from LemoLab's lemo-opuscar crayon-book demo
 * (crayon.js, rig.js) at commit e3cb16f... (MIT); the character and page art in
 * crayon-book.mjs are original to this reference. Each mark is drawn into a
 * "pressure layer": RGB is the crayon colour and A is the pressure (0..1). The
 * WebGL compositor decides how much wax sticks to the paper tooth.
 *
 * Coordinates are a 1600x900 design page. `setView` maps them to the real
 * canvas dimensions each frame, so line widths and tooth scale with the actual
 * capture size. The hand wobble and boil are deterministic functions of the
 * mark seed and a 12 fps step.
 */

// ---- local deterministic helpers (from Lemo core/lib.js, MIT) --------------
export const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const hash = (n) => {
  n = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return n - Math.floor(n);
};
export const vnoise = (x) => {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return lerp(hash(i), hash(i + 1), u);
};
export const ss = (t) => {
  t = clamp(t);
  return t * t * (3 - 2 * t);
};
export const seg = (t, a, b) => clamp((t - a) / (b - a));

export const PAGE_W = 1600;
export const PAGE_H = 900;

// ---- view: design page -> actual canvas pixels ------------------------------
const view = { w: 640, h: 360, u: 0.4, x: 800, y: 450, z: 1 };

export function setView(width, height, cam) {
  view.w = width;
  view.h = height;
  view.u = Math.min(width / PAGE_W, height / PAGE_H);
  view.x = cam.x;
  view.y = cam.y;
  view.z = cam.z;
}
export const sx = (x) => (x - view.x) * view.u * view.z + view.w / 2;
export const sy = (y) => (y - view.y) * view.u * view.z + view.h / 2;
/** Screen width for a design-page width, gently following camera zoom. */
export const ws = (w) => w * view.u * Math.pow(view.z, 0.45);
export const canvasSize = () => ({ w: view.w, h: view.h });
export const viewScale = () => view.u * view.z;

// ---- layers ----------------------------------------------------------------
export function layer(width, height) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const g = c.getContext('2d');
  if (!g) throw new Error('crayon-book: 2D canvas context unavailable');
  g.lineCap = 'round';
  g.lineJoin = 'round';
  return { c, g };
}
export function clear(L) {
  L.g.setTransform(1, 0, 0, 1, 0, 0);
  L.g.globalAlpha = 1;
  L.g.globalCompositeOperation = 'source-over';
  L.g.clearRect(0, 0, L.c.width, L.c.height);
}

// ---- stroke ----------------------------------------------------------------
const n1 = (seed, x) => vnoise(x + seed * 17.31) * 2 - 1;

function toScreen(pts) {
  return pts.map((p) => [sx(p[0]), sy(p[1])]);
}
function resample(sp, step, closed = false) {
  const q = closed ? [...sp, sp[0]] : sp;
  const out = [q[0].slice()];
  const L = [0];
  let acc = 0;
  let total = 0;
  for (let i = 1; i < q.length; i++) {
    const [ax, ay] = q[i - 1];
    const [bx, by] = q[i];
    const d = Math.hypot(bx - ax, by - ay);
    if (d < 1e-6) continue;
    let pos = step - acc;
    while (pos <= d) {
      const u = pos / d;
      out.push([ax + (bx - ax) * u, ay + (by - ay) * u]);
      total += step;
      L.push(total);
      pos += step;
    }
    acc = d - (pos - step);
  }
  const last = q[q.length - 1];
  const lp = out[out.length - 1];
  const rem = Math.hypot(last[0] - lp[0], last[1] - lp[1]);
  if (rem > 0.3) {
    out.push(last.slice());
    total += rem;
    L.push(total);
  }
  return { p: out, L, total };
}

/**
 * One crayon stroke.
 * o: col, w (design px), p (pressure), seed, wob, boil, taper, draw, streak,
 * closed. The width is mapped to screen pixels through `ws`, so it survives a
 * resize without becoming hairlines.
 */
export function line(L, pts, o = {}) {
  const g = L.g;
  const col = o.col || '#2d3263';
  const w = ws(o.w ?? 7);
  const p = o.p ?? 0.8;
  const seed = o.seed ?? 1;
  const wob = o.wob ?? 1;
  const boil = o.boil ?? 1;
  const draw = o.draw ?? 1;
  if (draw <= 0 || pts.length < 2) return;
  const sp = toScreen(pts);
  const R = resample(sp, Math.max(2.5, 3.5 * view.u), o.closed);
  const n = R.p.length;
  if (n < 2) return;
  const lim = R.total * clamp(draw);
  const st = o.boilStep ?? 0;
  const ba = (o.boilAmp ?? 1) * boil;
  const jx = (hash(seed * 3.1 + st * 7.7) - 0.5) * 1.6 * ba;
  const jy = (hash(seed * 5.3 + st * 3.9) - 0.5) * 1.6 * ba;
  const P = [];
  const Wd = [];
  const taper = o.taper ?? 0.25;
  const tl = Math.min(R.total * taper, ws(28));
  for (let i = 0; i < n; i++) {
    const s = R.L[i];
    if (s > lim) break;
    const a = R.p[Math.max(0, i - 1)];
    const b = R.p[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0];
    let ty = b[1] - a[1];
    const tn = Math.hypot(tx, ty) || 1;
    tx /= tn;
    ty /= tn;
    const off = n1(seed, s / 85) * 1.7 * wob + n1(seed + st * 1.37 + 11, s / 38) * 0.9 * ba;
    P.push([R.p[i][0] - ty * off + jx, R.p[i][1] + tx * off + jy, -ty, tx]);
    const e0 = o.closed ? 1 : clamp(s / (tl + 1e-3));
    const e1 = o.closed ? 1 : clamp((Math.min(lim, R.total) - s) / (tl + 1e-3));
    Wd.push(w * (0.82 + 0.3 * n1(seed + 3, s / 55)) * (0.45 + 0.55 * Math.min(e0, e1)));
  }
  if (P.length < 2) return;
  g.fillStyle = col;
  g.strokeStyle = col;
  ribbon(g, P, Wd, 1);
  g.globalAlpha = p * 0.5;
  g.fill();
  ribbon(g, P, Wd, 0.5);
  g.globalAlpha = p * 0.34;
  g.fill();
  const ns = o.streak ?? 2;
  for (let k = 0; k < ns; k++) {
    const side = (hash(seed + k * 9.1) - 0.5) * 0.9;
    g.beginPath();
    for (let i = 0; i < P.length; i++) {
      const q = P[i];
      const d = side * Wd[i];
      const x = q[0] + q[2] * d;
      const y = q[1] + q[3] * d;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.lineWidth = Math.max(1, w * 0.22);
    g.globalAlpha = p * 0.3;
    g.stroke();
  }
  g.globalAlpha = 1;
}

function ribbon(g, P, Wd, k) {
  g.beginPath();
  for (let i = 0; i < P.length; i++) {
    const q = P[i];
    const d = Wd[i] * 0.5 * k;
    i ? g.lineTo(q[0] + q[2] * d, q[1] + q[3] * d) : g.moveTo(q[0] + q[2] * d, q[1] + q[3] * d);
  }
  for (let i = P.length - 1; i >= 0; i--) {
    const q = P[i];
    const d = Wd[i] * 0.5 * k;
    g.lineTo(q[0] - q[2] * d, q[1] - q[3] * d);
  }
  g.closePath();
}

/**
 * Zig-zag crayon colouring inside a polygon, overshooting the outline.
 * o: col, p, ang, gap, w, over, seed, draw, boil, cross, crossAng, crossP.
 */
export function fill(L, poly, o = {}) {
  const g = L.g;
  const col = o.col || '#f5c63c';
  const p = o.p ?? 0.62;
  const seed = o.seed ?? 1;
  const boil = o.boil ?? 1;
  const st = o.boilStep ?? 0;
  const ba = (o.boilAmp ?? 1) * boil;
  const ang = (o.ang ?? 0.62) + (hash(seed + st * 1.9) - 0.5) * 0.035 * ba;
  const gap = ws(o.gap ?? 10.5);
  const w = ws(o.w ?? 11);
  const over = ws(o.over ?? 7);
  const draw = o.draw ?? 1;
  if (draw <= 0 || poly.length < 3) return;
  const sp = toScreen(poly);
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const rp = sp.map(([x, y]) => [x * ca + y * sa, -x * sa + y * ca]);
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const q of rp) {
    y0 = Math.min(y0, q[1]);
    y1 = Math.max(y1, q[1]);
  }
  const rows = [];
  let y = y0 + gap * (0.35 + 0.3 * hash(seed + st * 0.7 * ba));
  let r = 0;
  while (y < y1) {
    const xs = [];
    for (let i = 0; i < rp.length; i++) {
      const a = rp[i];
      const b = rp[(i + 1) % rp.length];
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y))
        xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    xs.sort((a, b) => a - b);
    const spans = [];
    for (let i = 0; i + 1 < xs.length; i += 2) spans.push([xs[i], xs[i + 1]]);
    rows.push({ y, spans, r });
    r++;
    y += gap * (0.8 + 0.4 * hash(seed * 1.3 + r * 3.7));
  }
  const strokes = [];
  let curS = null;
  let prev = null;
  for (const row of rows) {
    if (row.spans.length !== 1) {
      curS = null;
      prev = null;
      for (const s of row.spans) strokes.push([[s, row.y, row.r]]);
      continue;
    }
    const s = row.spans[0];
    if (curS && prev && s[0] < prev[1] && s[1] > prev[0]) curS.push([s, row.y, row.r]);
    else {
      curS = [[s, row.y, row.r]];
      strokes.push(curS);
    }
    prev = s;
  }
  const paths = strokes.map((S, si) => {
    const pts = [];
    S.forEach(([s, yy, rr], k) => {
      const len = s[1] - s[0];
      const oA = over * (hash(seed + rr * 5.1 + 0.3) * 1.1 - 0.15);
      const oB = over * (hash(seed + rr * 2.3 + 0.7) * 1.1 - 0.15);
      const yj = (hash(seed + rr * 1.7 + st * 0.31 * ba) - 0.5) * gap * 0.35 * Math.max(ba, 0.3);
      const a = [s[0] - oA, yy + yj];
      const b = [s[1] + oB, yy + yj + (hash(seed + rr) - 0.5) * gap * 0.6];
      if ((k + si) % 2 === 0) pts.push(a, b);
      else pts.push(b, a);
    });
    return pts.map(([x, y2]) => [x * ca - y2 * sa, x * sa + y2 * ca]);
  });
  let total = 0;
  const lens = paths.map((pp) => {
    let l = 0;
    for (let i = 1; i < pp.length; i++) l += Math.hypot(pp[i][0] - pp[i - 1][0], pp[i][1] - pp[i - 1][1]);
    total += l;
    return l;
  });
  let budget = total * draw;
  g.strokeStyle = col;
  g.lineWidth = w;
  for (let k = 0; k < paths.length && budget > 0; k++) {
    const pp = paths[k];
    const cut = cutPath(pp, budget);
    budget -= lens[k];
    for (let i = 1; i < cut.length; i++) {
      const pr = p * (0.72 + 0.42 * hash(seed * 0.37 + k * 13.1 + i * 0.71));
      g.beginPath();
      g.moveTo(cut[i - 1][0], cut[i - 1][1]);
      g.lineTo(cut[i][0], cut[i][1]);
      g.globalAlpha = pr * 0.62;
      g.lineWidth = w;
      g.stroke();
      g.globalAlpha = pr * 0.3;
      g.lineWidth = w * 0.42;
      g.stroke();
    }
  }
  g.globalAlpha = 1;
  if (o.cross) {
    fill(L, poly, {
      ...o,
      cross: false,
      ang: (o.ang ?? 0.62) + (o.crossAng ?? 1.25),
      seed: seed + 101,
      p: p * (o.crossP ?? 0.7),
    });
  }
}

function cutPath(pp, len) {
  const out = [pp[0]];
  let acc = 0;
  for (let i = 1; i < pp.length; i++) {
    const d = Math.hypot(pp[i][0] - pp[i - 1][0], pp[i][1] - pp[i - 1][1]);
    if (acc + d >= len) {
      const u = (len - acc) / d;
      out.push([lerp(pp[i - 1][0], pp[i][0], u), lerp(pp[i - 1][1], pp[i][1], u)]);
      return out;
    }
    acc += d;
    out.push(pp[i]);
  }
  return out;
}

/** Small circular scrub fill (cheeks, eye glints, small dots). */
export function dab(L, x, y, r, o = {}) {
  fill(
    L,
    handCircle(x, y, r, o.seed ?? 1, 0, 20).map(([px, py]) => [px, y + (py - y) * (o.sq ?? 1)]),
    {
      col: o.col || '#ee8ea4',
      p: o.p ?? 0.7,
      gap: o.gap ?? 4.5,
      w: o.w ?? 6,
      over: o.over ?? 1.5,
      seed: o.seed ?? 1,
      ang: o.ang ?? 0.5,
      boil: o.boil ?? 1,
      boilStep: o.boilStep,
      boilAmp: o.boilAmp,
    },
  );
}

// ---- shapes (design page coordinates) --------------------------------------
export function ellipse(cx, cy, rx, ry, n = 48, a0 = 0, a1 = Math.PI * 2, rot = 0) {
  const out = [];
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    const x = Math.cos(a) * rx;
    const y = Math.sin(a) * ry;
    out.push([cx + x * c - y * s, cy + x * s + y * c]);
  }
  return out;
}
export function handCircle(cx, cy, r, seed = 1, over = 0.12, n = 56) {
  const out = [];
  const a0 = hash(seed) * 6.28;
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const a = a0 + u * Math.PI * 2 * (1 + over);
    const rr =
      r *
      (1 + 0.035 * Math.sin(a * 2 + seed) + (u > 1 - over ? (0.04 * (u - (1 - over))) / over : 0));
    out.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  return out;
}
export function bez(c, n = 16) {
  const out = [c[0]];
  for (let i = 0; i + 3 < c.length; i += 3) {
    const [a, b, d, e] = [c[i], c[i + 1], c[i + 2], c[i + 3]];
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const u = 1 - t;
      out.push([
        u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * d[0] + t * t * t * e[0],
        u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * d[1] + t * t * t * e[1],
      ]);
    }
  }
  return out;
}
export function smooth(pts, n = 8, closed = true) {
  const out = [];
  const m = pts.length;
  const N = closed ? m : m - 1;
  for (let i = 0; i < N; i++) {
    const p0 = pts[(i - 1 + m) % m];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % m];
    const p3 = pts[(i + 2) % m];
    const P0 = closed || i > 0 ? p0 : p1;
    const P3 = closed || i + 2 < m ? p3 : p2;
    for (let k = 0; k < n; k++) {
      const t = k / n;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push([
        0.5 *
          (2 * p1[0] +
            (-P0[0] + p2[0]) * t +
            (2 * P0[0] - 5 * p1[0] + 4 * p2[0] - P3[0]) * t2 +
            (-P0[0] + 3 * p1[0] - 3 * p2[0] + P3[0]) * t3),
        0.5 *
          (2 * p1[1] +
            (-P0[1] + p2[1]) * t +
            (2 * P0[1] - 5 * p1[1] + 4 * p2[1] - P3[1]) * t2 +
            (-P0[1] + 3 * p1[1] - 3 * p2[1] + P3[1]) * t3),
      ]);
    }
  }
  if (!closed) out.push(pts[m - 1]);
  else out.push(out[0]);
  return out;
}
export function xf(pts, { x = 0, y = 0, r = 0, s = 1, sx: kx = 1, sy: ky = 1, ox = 0, oy = 0 } = {}) {
  const c = Math.cos(r);
  const sn = Math.sin(r);
  return pts.map(([px, py]) => {
    const X = (px - ox) * s * kx;
    const Y = (py - oy) * s * ky;
    return [x + ox + X * c - Y * sn, y + oy + X * sn + Y * c];
  });
}

// ---- character rigs --------------------------------------------------------
export function group() {
  const { w, h } = canvasSize();
  return { k: layer(w, h), f: layer(w, h), l: layer(w, h) };
}
export function clearGroup(C) {
  clear(C.k);
  clear(C.f);
  clear(C.l);
}
function pathScreen(g, poly) {
  g.beginPath();
  poly.forEach(([x, y], i) => (i ? g.lineTo(sx(x), sy(y)) : g.moveTo(sx(x), sy(y))));
  g.closePath();
}
export function erase(L, poly) {
  const g = L.g;
  g.save();
  g.globalCompositeOperation = 'destination-out';
  g.globalAlpha = 1;
  g.fillStyle = '#000';
  pathScreen(g, poly);
  g.fill();
  g.restore();
}
export function knock(C, poly) {
  const g = C.k.g;
  g.save();
  g.globalAlpha = 1;
  g.fillStyle = '#000';
  pathScreen(g, poly);
  g.fill();
  g.restore();
}

/**
 * Draw one body part. It knocks the paper behind itself, erases the parts
 * behind it inside its outline, then colours and outlines itself — the
 * child-drawing occlusion the reference preserves.
 */
export function part(C, poly, fo, lo, { occ = true, kn = true } = {}) {
  if (occ) {
    erase(C.l, poly);
    if (fo) erase(C.f, poly);
  }
  if (kn) knock(C, poly);
  if (fo) fill(C.f, poly, fo);
  if (lo) line(C.l, [...poly, poly[1] || poly[0]], lo);
}

/** A limb as a closed tube along a polyline. */
export function tube(pts, w0, w1 = w0) {
  const n = pts.length;
  const L = [];
  const R = [];
  const dirs = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    const d = Math.hypot(dx, dy) || 1;
    dx /= d;
    dy /= d;
    dirs.push([dx, dy]);
    const w = (w0 + ((w1 - w0) * i) / (n - 1)) / 2;
    L.push([pts[i][0] - dy * w, pts[i][1] + dx * w]);
    R.push([pts[i][0] + dy * w, pts[i][1] - dx * w]);
  }
  const cap = (c, d, w, from) => {
    const out = [];
    const a0 = Math.atan2(d[1], d[0]);
    for (let k = 1; k < 8; k++) {
      const a = a0 + from + (Math.PI * k) / 8;
      out.push([c[0] + Math.cos(a) * w, c[1] + Math.sin(a) * w]);
    }
    return out;
  };
  return [
    ...L,
    ...cap(pts[n - 1], dirs[n - 1], w1 / 2, Math.PI / 2),
    ...R.reverse(),
    ...cap(pts[0], dirs[0], w0 / 2, -Math.PI / 2),
  ];
}

/** Squared-off smoothing of a joint chain. */
export function curve(pts, n = 6) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = mid(pts[i - 1], pts[i]);
    const b = mid(pts[i], pts[i + 1]);
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const u = 1 - t;
      out.push([
        u * u * a[0] + 2 * u * t * pts[i][0] + t * t * b[0],
        u * u * a[1] + 2 * u * t * pts[i][1] + t * t * b[1],
      ]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}
