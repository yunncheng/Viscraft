// sprites.mjs — a small 48x48 character rig with hand-placed ASCII heads.
//
// Adapted from lemo-opuscar styles/pixel-rpg/demo/sprites.js @ e3cb16f
// (LemoLab, MIT): capsule limbs with upper-left three-tone shading, per-part
// inner lines, a one-pixel global ink outline, the hand-placed Wren/Arlo heads,
// the sprite origin ox=24/oy=44 (feet centre), the scarf tails and the 3-frame
// stepping flutter. Only the side and down heads and the poses this study uses
// are carried; portraits, front/back views, the sword swing and the combat
// poses are not.
import { C, T, sprFromRows } from './px.mjs';

// --- material ramps [line, dark, mid, light] -------------------------------
export const MAT = {
  skin: [C.brown, C.skinS, C.skin, C.sand],
  hairA: [C.umber, C.umber, C.dbrown, C.brown],
  tunicA: [C.ink, C.night, C.navy, C.blue],
  steel: [C.night, C.slate, C.steel, C.silver],
  leather: [C.umber, C.umber, C.dbrown, C.brown],
  pants: [C.ink, C.night, C.dslate, C.slate],
  boots: [C.ink, C.umber, C.dbrown, C.brown],
  gold: [C.dbrown, C.brown, C.amber, C.yellow],
  scarf: [C.umber, C.scarfD, C.scarf, C.scarfL],
  hairW: [C.umber, C.dbrown, C.rust, C.clay],
  cloakW: [C.teal, C.dgreen, C.green, C.lime],
  wood: [C.umber, C.dbrown, C.brown, C.tan],
  glow: [C.orange, C.orange, C.amber, C.yellow],
  blade: [C.dslate, C.steel, C.silver, C.white],
};
const L = [-0.55, -0.83]; // light from the upper left

// --- hand-placed heads ------------------------------------------------------
// h/H/j hair mid/light/dark, f/F skin light/dark, e eye ink, w eye white,
// b brow, m mouth. No outer outline here: the rig adds the global ink outline.
const HEADS_A = {
  side: [
    '......jjjj....',
    '...jjhhhhhhj..',
    '..jhhHHHHHhhj.',
    '.jhHHHHHHHHhhj',
    'jjhHHhhhhhhhhh',
    '.jjhhhhhhhhhhh',
    '..jhhhhhhjhjhh',
    '.jjhhhhhjffhff',
    'jjhhhhhFfffbbf',
    '.jjhhhFFfffeff',
    '..jhhhFffffeff',
    '..jjhhhFfffff.',
    '....jjFffffmf.',
    '......FFfff...',
  ],
  down: [
    '..............',
    '......jjjj....',
    '...jjhhhhhhj..',
    '..jhhHHHHHhhj.',
    '.jhHHHHHHHHhhj',
    'jjhHHhhhhhhhhh',
    '.jjhhhhhhhhhhh',
    '..jhhhhhhjhjhh',
    '.jjhhhhhjfbbhf',
    'jjhhhhhFffffFf',
    '.jjhhhFFfffeff',
    '..jhhhFffffmff',
    '..jjhhhFffff..',
    '....jjFFff....',
  ],
};
const HEADS_W = {
  side: [
    '....jjhhhj....',
    '..jhhHHHHhhj..',
    '.jhHHHHHHHhhj.',
    'jhHHHhhhhhhhhh',
    'jhhhhhhhhhhhhh',
    'jhhhhhhhhjhhhf',
    'jhhhhhhhjfhfff',
    'jhhhhhhFfffbbf',
    'jhhhhhFFfffeef',
    'hjjhhhFfFffwef',
    'hhjjhhFFffffff',
    'jhhjjhFFfffmf.',
    '.jhj..FFffff..',
    '..j....FFF....',
  ],
  down: [
    '..............',
    '....jjhhhj....',
    '..jhhHHHHhhj..',
    '.jhHHHHHHHhhj.',
    'jhHHHhhhhhhhhh',
    'jhhhhhhhhhhhhh',
    'jhhhhhhhhjhhhf',
    'jhhhhhhhjfhfff',
    'jhhhhhhFfffbbf',
    'jhhhhhFFffffFf',
    'hjjhhhFfFfffef',
    'hhjjhhFFfffmf.',
    'jhhjjhFFffff..',
    '.jhj...FFF....',
  ],
};
export function headSprite(rows, hairMat) {
  const hm = MAT[hairMat];
  const sk = MAT.skin;
  return sprFromRows(rows, {
    h: hm[2], H: hm[3], j: hm[1], f: sk[2], F: sk[1], e: C.ink, w: C.white, b: hm[1], m: sk[0],
  });
}

// --- rig -------------------------------------------------------------------
// Canvas 48x48; the anchor (feet centre) is (24,44). The scene blits at
// (x - 24, groundY - 44), so the ground contact never depends on the pose.
const SW = 48;
const SH = 48;
const OX = 24;
const OY = 44;
class Buf {
  constructor() {
    this.m = new Int16Array(SW * SH).fill(-1);
    this.part = new Int16Array(SW * SH).fill(-1);
    this.np = 0;
  }
  // Stamp one part; where it meets a different part, use the material's line tone.
  stamp(pix, mat) {
    const id = this.np++;
    const set = new Set(pix.map(p => p.i));
    for (const p of pix) {
      const x = p.i % SW;
      const y = (p.i / SW) | 0;
      let edgeOnOther = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const X = x + dx;
        const Y = y + dy;
        if (X < 0 || Y < 0 || X >= SW || Y >= SH) continue;
        const j = Y * SW + X;
        if (!set.has(j) && this.part[j] >= 0 && this.part[j] !== id) edgeOnOther = true;
      }
      const tone = this.flat && p.tone === 3 ? 2 : p.tone;
      this.m[p.i] = edgeOnOther && mat.line !== false ? MAT[mat.name][0] : MAT[mat.name][tone];
      this.part[p.i] = id;
    }
  }
  raw(x, y, c) {
    x = Math.round(x) + OX;
    y = Math.round(y) + OY;
    if (x < 0 || y < 0 || x >= SW || y >= SH) return;
    this.m[y * SW + x] = c;
    this.part[y * SW + x] = 999;
  }
  sprite(spr, x0, y0, flip = false) {
    for (let y = 0; y < spr.h; y++)
      for (let x = 0; x < spr.w; x++) {
        const c = spr.d[y * spr.w + (flip ? spr.w - 1 - x : x)];
        if (c === T) continue;
        const X = x0 + x + OX;
        const Y = y0 + y + OY;
        if (X < 0 || Y < 0 || X >= SW || Y >= SH) continue;
        this.m[Y * SW + X] = c;
        this.part[Y * SW + X] = 998;
      }
  }
  finish(outline = C.ink) {
    const d = new Uint8Array(SW * SH).fill(T);
    for (let i = 0; i < d.length; i++) if (this.m[i] >= 0) d[i] = this.m[i];
    const o = d.slice();
    for (let y = 0; y < SH; y++)
      for (let x = 0; x < SW; x++) {
        const i = y * SW + x;
        if (d[i] !== T) continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const X = x + dx;
          const Y = y + dy;
          if (X >= 0 && Y >= 0 && X < SW && Y < SH && d[Y * SW + X] !== T) {
            o[i] = outline;
            break;
          }
        }
      }
    return { w: SW, h: SH, d: o, ox: OX, oy: OY };
  }
}
function toneOf(nx, ny, ramp = [0.38, -0.28]) {
  const v = nx * L[0] + ny * L[1];
  return v > ramp[0] ? 3 : v < ramp[1] ? 1 : 2;
}
function capsule(x0, y0, x1, y1, r0, r1 = r0, bias = 0) {
  const pix = [];
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1e-6;
  const ux = dx / len;
  const uy = dy / len;
  const px_ = -uy;
  const py_ = ux;
  const R = Math.max(r0, r1) + 1;
  for (let y = Math.floor(Math.min(y0, y1) - R); y <= Math.ceil(Math.max(y0, y1) + R); y++)
    for (let x = Math.floor(Math.min(x0, x1) - R); x <= Math.ceil(Math.max(x0, x1) + R); x++) {
      const cx = x + 0.5 - 0.5;
      const cy = y;
      const t = Math.max(0, Math.min(1, ((cx - x0) * ux + (cy - y0) * uy) / len));
      const qx = x0 + ux * len * t;
      const qy = y0 + uy * len * t;
      const r = r0 + (r1 - r0) * t;
      const d = Math.hypot(cx - qx, cy - qy);
      if (d > r + 0.15) continue;
      const s = ((cx - qx) * px_ + (cy - qy) * py_) / Math.max(0.6, r);
      const nx = px_ * s;
      const ny = py_ * s;
      const X = x + OX;
      const Y = y + OY;
      if (X < 0 || Y < 0 || X >= SW || Y >= SH) continue;
      pix.push({ i: Y * SW + X, tone: toneOf(nx + bias * L[0], ny + bias * L[1]) });
    }
  return pix;
}
function poly(pts, cx, cy, rx, ry, ramp) {
  const pix = [];
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const [, y] of pts) {
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
    const xs = [];
    const yc = y;
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2)
      for (let x = Math.round(xs[k]); x < Math.round(xs[k + 1]); x++) {
        const X = x + OX;
        const Y = y + OY;
        if (X < 0 || Y < 0 || X >= SW || Y >= SH) continue;
        pix.push({ i: Y * SW + X, tone: toneOf((x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry, ramp) });
      }
  }
  return pix;
}
function disc(cx, cy, r) {
  const pix = [];
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++)
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > r * r + 0.3) continue;
      const X = x + OX;
      const Y = y + OY;
      if (X < 0 || Y < 0 || X >= SW || Y >= SH) continue;
      pix.push({ i: Y * SW + X, tone: toneOf(dx / (r || 1), dy / (r || 1)) });
    }
  return pix;
}
const rot = (a, x, y) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
// Forward kinematics: angle 0 points down, positive bends toward +x.
function limb(root, a1, l1, a2, l2) {
  const k = [root[0] + Math.sin(a1) * l1, root[1] + Math.cos(a1) * l1];
  const e = [k[0] + Math.sin(a1 - a2) * l2, k[1] + Math.cos(a1 - a2) * l2];
  return [k, e];
}
function ahoge(b, x, y, dir, t) {
  const sw = Math.floor(t * 8) % 2;
  const hc = MAT.hairA;
  if (dir === 0) {
    b.raw(x, y - 1, hc[2]);
    b.raw(x, y - 2, hc[2]);
    b.raw(x + 1 - sw, y - 3, hc[3]);
    b.raw(x + 2 - sw, y - 3, hc[2]);
    return;
  }
  b.raw(x, y - 1, hc[2]);
  b.raw(x, y - 2, hc[2]);
  b.raw(x + dir, y - 3, hc[3]);
  b.raw(x + dir * 2, y - 3 + sw, hc[2]);
}

// --- characters -------------------------------------------------------------
export const CHARS = {
  arlo: { heads: HEADS_A, hair: 'hairA', tunic: 'tunicA', h: 1, scarf: true, sword: true },
  wren: { heads: HEADS_W, hair: 'hairW', tunic: 'cloakW', h: 0, scarf: true, staff: true, dress: true },
};
const headCache = new Map();
function head(ch, kind) {
  const k = ch + kind;
  if (!headCache.has(k)) headCache.set(k, headSprite(CHARS[ch].heads[kind] || CHARS[ch].heads.side, CHARS[ch].hair));
  return headCache.get(k);
}

// Poses. `plant`/`guard`/`guardlook` are new non-combat guardian stances; the
// walk, kneel and cast poses are the upstream shapes. No attack/swing pose is
// carried.
export const POSE = {
  idle: { by: 0, lean: 0, legF: [0.12, 0], legB: [-0.1, 0], armF: [-0.05, -0.25], armB: [0.1, -0.2], head: 'side' },
  breathe: { by: 0, lean: 0, rise: 1, legF: [0.12, 0], legB: [-0.1, 0], armF: [-0.1, -0.2], armB: [0.12, -0.15], head: 'side' },
  walk0: { by: 0, legF: [0.48, 0.12], legB: [-0.42, 0.3], armF: [-0.4, -0.35], armB: [0.4, -0.3], head: 'side' },
  walk1: { by: -1, legF: [0.05, 0.05], legB: [0.3, 1.0], armF: [0, -0.3], armB: [0, -0.25], head: 'side' },
  walk2: { by: 0, legF: [-0.42, 0.3], legB: [0.48, 0.12], armF: [0.4, -0.35], armB: [-0.4, -0.3], head: 'side' },
  walk3: { by: -1, legF: [0.3, 1.0], legB: [0.05, 0.05], armF: [0, -0.3], armB: [0, -0.25], head: 'side' },
  kneel: { by: 5, lean: 0.32, legF: [1.5, 1.5], legB: [0.1, 1.7], armF: [0.5, 0.3], armB: [0.3, 0.1], head: 'down' },
  cast: { by: 0, lean: 0.05, legF: [0.3, 0.1], legB: [-0.25, 0.1], armF: [1.9, 0.3], armB: [0.3, -0.5], head: 'side', item: 'raise' },
  plant: { by: 1, lean: 0.12, legF: [0.4, 0.2], legB: [-0.35, 0.1], armF: [0.75, 1.0], armB: [0.35, 0.85], head: 'down', item: 'plant' },
  guard: { by: 1, lean: 0.05, legF: [0.28, 0.08], legB: [-0.3, 0.05], armF: [0.5, 1.05], armB: [0.25, 0.95], head: 'down', item: 'plant' },
  guardlook: { by: 1, lean: -0.04, legF: [0.26, 0.06], legB: [-0.28, 0.04], armF: [0.46, 1.0], armB: [0.22, 0.9], head: 'side', item: 'plant' },
};

/**
 * Blend two named poses for a smooth step between discrete actions. Numeric
 * pose channels and their arrays are interpolated; `head` and `item` switch at
 * the halfway point so a sprite never carries two contradictory cues.
 */
export function blendPose(from, to, t) {
  if (t <= 0) return POSE[from];
  if (t >= 1) return POSE[to];
  const a = POSE[from];
  const b = POSE[to];
  const out = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const av = a[key];
    const bv = b[key];
    if (typeof av === 'number' && typeof bv === 'number') out[key] = av + (bv - av) * t;
    else if (Array.isArray(av) && Array.isArray(bv)) out[key] = av.map((v, i) => v + (bv[i] - v) * t);
    else out[key] = t < 0.5 ? (av ?? bv) : (bv ?? av);
  }
  return out;
}

/** Draw one character frame. `pose` is a name or a blended pose object. */
export function drawChar(ch, pose, opts = {}) {
  const P = typeof pose === 'string' ? POSE[pose] : pose;
  const D = CHARS[ch];
  const b = new Buf();
  b.flat = !!opts.flat;
  const H0 = D.h;
  const by = P.by || 0;
  const lean = P.lean || 0;
  const rise = P.rise || 0;
  const hip = [0, -12 - H0 + by];
  const [shx, shy] = rot(lean, 0, -8 - rise);
  const sh = [hip[0] + shx, hip[1] + shy];
  const neck = [sh[0] + rot(lean, 0, -1.5)[0] + 0.5, sh[1] - 1.5];
  const tunic = D.tunic;
  // Staff tip in feet-origin coordinates, used by the scene so a cast beam
  // starts at the actual staff top for the current pose/blend, not a guessed
  // screen offset. Null for characters without a staff.
  let staffTop = null;

  // Back arm and back leg (darker bias).
  const legLen = [6, 6];
  const [kB, aB] = limb(hip, P.legB[0], legLen[0], P.legB[1], legLen[1]);
  b.stamp(capsule(hip[0] - 0.5, hip[1], kB[0], kB[1], 1.7, 1.4, -0.6), { name: 'pants' });
  b.stamp(capsule(kB[0], kB[1], aB[0], aB[1], 1.5, 1.4, -0.6), { name: 'boots' });
  b.stamp(capsule(aB[0], aB[1], aB[0] + 2.2 * Math.cos(P.legB[0] - P.legB[1]), aB[1], 1.2, 1.1, -0.6), { name: 'boots' });
  const [eB, hB] = limb(sh, P.armB[0], 4.5, P.armB[1], 4.5);
  b.stamp(capsule(sh[0], sh[1] + 0.5, eB[0], eB[1], 1.3, 1.2, -0.7), { name: tunic });
  b.stamp(capsule(eB[0], eB[1], hB[0], hB[1], 1.1, 1.1, -0.7), { name: ch === 'arlo' ? 'leather' : 'skin' });

  // Wren's staff rides behind the body except when the cast raises it.
  if (D.staff && P.item !== 'raise') {
    const bot = [hB[0] + 1.5, -1 + Math.min(0, (P.by || 0) - 3)];
    const top = [bot[0] + 3, bot[1] - 31 + (P.by || 0)];
    staffTop = top;
    b.stamp(capsule(bot[0], bot[1], top[0], top[1], 0.7, 0.7, -0.5), { name: 'wood' });
    b.stamp(disc(top[0], top[1] - 1, 1.6), { name: 'glow' });
  }

  // Torso and hem.
  const [hx1, hy1] = rot(lean, 3.4, -8);
  const [hx0, hy0] = rot(lean, -3.6, -8);
  const flare = D.dress ? 5.2 : 4.2;
  const hem = D.dress ? 5.5 : 3.5;
  b.stamp(
    poly(
      [
        [hip[0] + hx0, hip[1] + hy0 - rise],
        [hip[0] + hx1, hip[1] + hy1 - rise],
        [hip[0] + flare, hip[1] + hem],
        [hip[0] - flare - 0.5, hip[1] + hem],
      ],
      hip[0] - 0.5 + rot(lean, 0, -4)[0],
      hip[1] - 4,
      4.2,
      6.5,
    ),
    { name: tunic },
  );
  const beltY = hip[1] - 1;
  b.stamp(
    poly(
      [
        [hip[0] - 4.2, beltY - 1],
        [hip[0] + 4, beltY - 1],
        [hip[0] + 4.2, beltY + 1],
        [hip[0] - 4.4, beltY + 1],
      ],
      hip[0],
      beltY,
      5,
      3,
    ),
    { name: 'leather' },
  );
  b.raw(hip[0] + 2.6, beltY - 0.5, C.amber);
  b.raw(hip[0] + 2.6, beltY + 0.5, C.brown);

  // Arlo's sheathed sword at the hip unless he plants it.
  if (D.sword && P.item !== 'plant') {
    b.stamp(capsule(hip[0] + 1, hip[1] - 0.5, hip[0] - 7, hip[1] + 4.5, 0.9, 0.8), { name: 'leather' });
    b.raw(hip[0] - 7, hip[1] + 4.5, C.amber);
    b.stamp(capsule(hip[0] + 1.5, hip[1] - 1.5, hip[0] + 4, hip[1] - 3.2, 0.6), { name: 'steel' });
    b.raw(hip[0] + 1.5, hip[1] - 0.5, C.amber);
    b.raw(hip[0] + 1.5, hip[1] - 2.5, C.amber);
  }

  // Front leg.
  const [kF, aF] = limb(hip, P.legF[0], legLen[0], P.legF[1], legLen[1]);
  b.stamp(capsule(hip[0] + 0.5, hip[1], kF[0], kF[1], 1.7, 1.4), { name: 'pants' });
  b.stamp(capsule(kF[0], kF[1], aF[0], aF[1], 1.5, 1.4), { name: 'boots' });
  b.stamp(capsule(aF[0], aF[1], aF[0] + 2.4, aF[1], 1.2, 1.1), { name: 'boots' });

  // Head.
  const hk = P.head || 'side';
  const hs = head(ch, hk);
  const hx = Math.round(neck[0] - 6);
  const hy = Math.round(neck[1] - 13);
  b.sprite(hs, hx, hy);
  if (ch === 'arlo') ahoge(b, hx + 8, hy, hk === 'up' ? -1 : 1, opts.t || 0);
  if (opts.scarf ?? D.scarf) {
    const sy = Math.round(neck[1]) - 1;
    b.stamp(
      poly(
        [
          [neck[0] - 3.5, sy - 1],
          [neck[0] + 3, sy - 1.5],
          [neck[0] + 3.5, sy + 1.5],
          [neck[0] - 3.5, sy + 1.5],
        ],
        neck[0] - 1,
        sy - 2,
        4,
        3,
      ),
      { name: 'scarf' },
    );
  }
  if (ch === 'arlo') b.stamp(disc(sh[0] - 0.5, sh[1] + 1, 2.3), { name: 'steel' });

  // Front arm.
  const [eF, hF] = limb(sh, P.armF[0], 4.5, P.armF[1], 4.5);
  b.stamp(capsule(sh[0], sh[1] + 0.5, eF[0], eF[1], 1.4, 1.2), { name: tunic });
  b.stamp(capsule(eF[0], eF[1], hF[0], hF[1], 1.2, 1.1), { name: ch === 'arlo' ? 'steel' : 'skin' });
  b.stamp(disc(hF[0], hF[1], 1.1), { name: ch === 'arlo' ? 'leather' : 'skin' });

  if (D.staff && P.item === 'raise') {
    const bot = [hF[0] - 2, hF[1] + 8];
    const dir = [0.45, -1];
    const n = Math.hypot(dir[0], dir[1]);
    const len = 20;
    const top = [bot[0] + (dir[0] / n) * len, bot[1] + (dir[1] / n) * len];
    staffTop = top;
    b.stamp(capsule(bot[0], bot[1], top[0], top[1], 0.7), { name: 'wood' });
    b.stamp(disc(top[0], top[1] - 1, 1.6), { name: 'glow' });
  }

  // Arlo's planted sword: grip at the hand, blade down to the ground anchor.
  if (D.sword && P.item === 'plant') {
    const tipX = hF[0] + 2.2;
    const tipY = -0.5;
    b.stamp(capsule(hF[0], hF[1], tipX, tipY, 0.8, 0.55, 0), { name: 'blade', line: false });
    b.stamp(capsule(hF[0] - 2.2, hF[1], hF[0] + 2.2, hF[1], 0.55), { name: 'gold' });
    b.stamp(capsule(hF[0], hF[1], hF[0], hF[1] - 2.6, 0.5), { name: 'leather' });
    b.stamp(disc(hF[0], hF[1] - 2.8, 1.0), { name: 'gold' });
  }
  const out = b.finish();
  out.staffTip = staffTop ? { x: staffTop[0], y: staffTop[1] } : null;
  return out;
}

// Scarf tail, side view: two chains stepped at 8 fps (a hand-drawn 3-frame
// flutter), `dir = 1` faces right. The scene draws one behind the sprite and a
// shorter one in front, preserving the front/back layering of the reference.
export function scarfTail(fb, x, y, t, wind = 0.5, dir = 1, len = 15, pal = [C.scarfD, C.scarf, C.scarfL]) {
  const ph = (Math.floor(t * 8) % 3) * 2.1;
  for (let k = 0; k < 2; k++) {
    const L2 = len - k * 4;
    for (let i = 1; i <= L2; i++) {
      const f = i / L2;
      const wave = Math.sin(ph - i * 0.62 + k * 1.4) * (0.5 + wind * 1.7) * f;
      const nx = x - dir * i * (0.3 + wind * 0.7);
      const ny = y + k + i * (1 - wind * 0.85) * 0.75 + wave;
      const X = Math.round(nx);
      const Y = Math.round(ny);
      const lit = Math.sin(ph - i * 0.62 + k * 1.4) > 0.45;
      fb.px(X, Y, i === L2 ? pal[0] : lit ? pal[2] : k ? pal[0] : pal[1]);
      fb.px(X, Y + 1, i === L2 ? C.ink : k ? C.ink : pal[0]);
    }
  }
}
