/*
 * Crayon picture-book page — a small, complete page action in wax crayon.
 *
 * A girl draws a star beside her with a crayon, colours it in, reaches up as it
 * lifts off the page, and a single ultramarine wash reveals a white-wax
 * constellation that was on the paper all along. The page is redrawn every
 * frame: the tooth, the strokes and the watercolour are material passes, not a
 * filter. The character and star outlines are original to this reference; the
 * mark/compositor mechanisms are adapted from LemoLab's crayon-book demo
 * (MIT, commit e3cb16f...).
 *
 * Contract: window.viscraft.ready() waits for the WebGL2 compositor;
 * window.viscraft.render(ctx) is a pure function of ctx (frame/time/fps/width/
 * height/seed/params). The character/pose boil steps at 12 fps while the camera
 * and the wash edge are evaluated continuously at the output frame rate.
 */
import { pageActionAt } from './action-facts.mjs';
import {
  PAGE_W,
  PAGE_H,
  clamp,
  lerp,
  hash,
  ss,
  seg,
  layer,
  clear,
  setView,
  sx,
  sy,
  ws,
  viewScale,
  line,
  fill,
  dab,
  ellipse,
  handCircle,
  smooth,
  xf,
  group,
  clearGroup,
  part,
  tube,
  curve,
} from './crayon-engine.mjs';
import { createCompositor } from './crayon-gl.mjs';

const PAL = {
  paper: [0.957, 0.937, 0.89],
  ink: '#2b2f5a',
  yellow: '#f3c33f',
  orange: '#e58a3a',
  red: '#cf4b3f',
  pink: '#ec91a8',
  peach: '#f2c6a2',
  brown: '#6f4630',
  ochre: '#e2b05c',
  green: '#4f8c62',
  sky: '#6f9fca',
  violet: '#6c5aa2',
  white: '#fbf7ea',
  cream: '#f6ead2',
};

const state = {
  canvas: null,
  comp: null,
  w: 0,
  h: 0,
  bg: null,
  star: null,
  girl: null,
  wash: null,
  washG: null,
};

export async function readyCrayonBook(canvas) {
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('crayon-book: ready() needs the page canvas');
  const probe = canvas.getContext('webgl2', {
    preserveDrawingBuffer: true,
    premultipliedAlpha: false,
    antialias: false,
    alpha: false,
  });
  if (!probe) {
    throw new Error(
      'crayon-book requires WebGL2 for its paper-tooth and wax compositor; this browser/headless session did not provide a WebGL2 context.',
    );
  }
  state.canvas = canvas;
}

function ensureState(canvas, width, height) {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  if (!state.comp) {
    state.comp = createCompositor(canvas, w, h);
    state.comp.toothScale = 1;
  } else {
    state.comp.resize(w, h);
  }
  if (w !== state.w || h !== state.h) {
    state.w = w;
    state.h = h;
    state.bg = group();
    state.star = group();
    state.girl = group();
    state.wash = layer(w, h);
    state.washG = state.wash.g;
  }
  return state;
}

// ---- page camera -----------------------------------------------------------
function cameraAt(t) {
  const push = ss(seg(t, 0.0, 0.62));
  const pull = ss(seg(t, 0.74, 0.86));
  const settle = ss(seg(t, 0.9, 1.0));
  return {
    x: 800 + 30 * push - 30 * pull,
    y: 450 + 46 * push - 46 * pull,
    z: 1 + 0.17 * push - 0.17 * pull + 0.025 * settle,
  };
}

// ---- original page props ---------------------------------------------------
const GROUND_Y = 812;
const CONSTELLATION = [
  [690, 190],
  [820, 132],
  [962, 118],
  [1104, 142],
  [1240, 196],
  [1362, 268],
  [1452, 350],
];
const starBase = { x: 782, y: 560, r: 88 };

function starShape(seed) {
  const pts = [];
  const radii = [1.0, 0.44, 0.92, 0.42, 1.08, 0.46, 0.95, 0.4, 1.0, 0.47];
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    const r = starBase.r * radii[k] * (1 + 0.035 * (hash(seed + k * 3.1) - 0.5));
    pts.push([starBase.x + Math.cos(a) * r, starBase.y + Math.sin(a) * r]);
  }
  return pts;
}

function pathPoint(poly, u) {
  const total = [];
  let len = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    total.push({ a, b, d, start: len });
    len += d;
  }
  let target = clamp(u) * len;
  for (const s of total) {
    if (target <= s.start + s.d) {
      const q = s.d < 1e-6 ? 0 : (target - s.start) / s.d;
      return [lerp(s.a[0], s.b[0], q), lerp(s.a[1], s.b[1], q)];
    }
  }
  return poly[0].slice();
}

function constellationMarks(L, step, amp, alpha = 1) {
  CONSTELLATION.forEach(([x, y], i) => {
    const r = 7.5;
    line(L, [[x - r, y], [x + r, y]], { col: PAL.white, w: 4.8, p: alpha, seed: 900 + i, boilStep: step, boilAmp: amp, wob: 0.3, taper: 0.15, streak: 0 });
    line(L, [[x, y - r], [x, y + r]], { col: PAL.white, w: 4.8, p: alpha, seed: 910 + i, boilStep: step, boilAmp: amp, wob: 0.3, taper: 0.15, streak: 0 });
  });
  // A small wax disc under each cross makes a solid paper-white point after
  // the wash; before the wash it is nearly invisible on the warm paper.
  CONSTELLATION.forEach(([x, y], i) => {
    fill(L, handCircle(x, y, 6.2, 905 + i, 0.08, 18), { col: PAL.white, p: 1, gap: 2.4, w: 4.4, over: 0.6, seed: 905 + i, boilStep: step, boilAmp: amp });
  });
  for (let i = 1; i < CONSTELLATION.length; i++) {
    const a = CONSTELLATION[i - 1];
    const b = CONSTELLATION[i];
    const mx = (a[0] + b[0]) / 2 + (hash(920 + i) - 0.5) * 18;
    const my = (a[1] + b[1]) / 2 + (hash(930 + i) - 0.5) * 14;
    line(L, [a, [mx, my], b], { col: PAL.white, w: 2.2, p: 0.9 * alpha, seed: 940 + i, boilStep: step, boilAmp: amp, wob: 0.25, taper: 0.1, streak: 0 });
  }
}

function drawBackground(bg, seed, step, amp) {
  const g = bg.f.g;
  // Warm ground: a low rolling band, coloured with a light wash of green.
  const hill = [];
  for (let i = 0; i <= 24; i++) {
    const x = -10 + (PAGE_W + 20) * (i / 24);
    hill.push([x, GROUND_Y - 8 + Math.sin(i * 0.7 + seed) * 7 + (hash(seed + i) - 0.5) * 5]);
  }
  hill.push([PAGE_W + 10, PAGE_H + 10], [-10, PAGE_H + 10]);
  fill(bg.f, hill, { col: PAL.green, p: 0.55, gap: 15, w: 16, ang: 0.08, seed: seed + 2, boilStep: step, boilAmp: amp, over: 4 });
  line(bg.l, hill.slice(0, -2), { col: PAL.ink, w: 5.2, p: 0.75, seed: seed + 3, boilStep: step, boilAmp: amp, wob: 0.8 });
  // A few grass ticks.
  for (let i = 0; i < 9; i++) {
    const x = 90 + i * 168 + (hash(seed + i * 2.3) - 0.5) * 30;
    const y = GROUND_Y + 2;
    line(bg.l, [[x, y], [x - 5, y - 13]], { col: PAL.green, w: 3.5, p: 0.8, seed: seed + 20 + i, boilStep: step, boilAmp: amp, taper: 0.4, streak: 0 });
    line(bg.l, [[x + 3, y], [x + 9, y - 10]], { col: PAL.green, w: 3.2, p: 0.75, seed: seed + 30 + i, boilStep: step, boilAmp: amp, taper: 0.4, streak: 0 });
  }
  constellationMarks(bg.l, step, amp, 1);
}

// ---- original girl ---------------------------------------------------------
const GIRL = { x: 620, foot: 812, headY: 470, headR: 58 };

function ik2(shoulder, target, l1, l2, bend) {
  let dx = target[0] - shoulder[0];
  let dy = target[1] - shoulder[1];
  let d = Math.hypot(dx, dy) || 1;
  const maxD = l1 + l2 - 1;
  const minD = Math.abs(l1 - l2) + 1;
  const dc = clamp(d, minD, maxD);
  dx /= d;
  dy /= d;
  const a = Math.atan2(dy, dx);
  const cosA = clamp((l1 * l1 + dc * dc - l2 * l2) / (2 * l1 * dc), -1, 1);
  const off = Math.acos(cosA);
  const ea = a + bend * off;
  const elbow = [shoulder[0] + Math.cos(ea) * l1, shoulder[1] + Math.sin(ea) * l1];
  const hand = [shoulder[0] + dx * dc, shoulder[1] + dy * dc];
  return { elbow, hand };
}

function girlTorso(x, lean) {
  return smooth(
    [
      [x - 54, 540 + lean],
      [x + 54, 540 + lean],
      [x + 64, 688],
      [x + 18, 706],
      [x - 18, 706],
      [x - 64, 688],
    ],
    4,
  );
}

function drawGirl(C, t, seed, step, amp, armTarget, reach, crayon) {
  const x = GIRL.x + 3 * reach;
  const lean = 2 * reach;
  const sd = seed + 100;
  const outline = (s, extra = {}) => ({ col: PAL.ink, w: 5.8, p: 0.9, seed: sd + s, boilStep: step, boilAmp: amp, ...extra });
  const skinF = { col: PAL.peach, p: 0.92, gap: 5.5, w: 11, ang: 0.4, seed: sd + 1, over: 3, cross: true, crossP: 0.55, boilStep: step, boilAmp: amp };
  const hairF = { col: PAL.brown, p: 0.96, gap: 5.5, w: 10, ang: 1.05, seed: sd + 2, over: 2.5, boilStep: step, boilAmp: amp };
  const dressF = { col: PAL.green, p: 0.94, gap: 6.5, w: 12, ang: 0.25, seed: sd + 3, over: 3.5, cross: true, crossP: 0.5, boilStep: step, boilAmp: amp };
  const bootF = { col: PAL.brown, p: 0.95, gap: 5, w: 9, ang: 0.9, seed: sd + 4, over: 2, boilStep: step, boilAmp: amp };
  const sockL = { col: PAL.orange, p: 0.92, gap: 4.5, w: 8, ang: 1.3, seed: sd + 5, over: 2, boilStep: step, boilAmp: amp };
  const sockR = { col: PAL.sky, p: 0.92, gap: 4.5, w: 8, ang: 1.3, seed: sd + 6, over: 2, boilStep: step, boilAmp: amp };

  const partNoKnock = (poly, f, l) => part(C, poly, f, l, { occ: true, kn: false });

  // ---- left arm (behind the pinafore) ----
  const lSh = [x - 47, 552 + lean];
  const lHandT = [x - 66, 646];
  const lIk = ik2(lSh, lHandT, 72, 70, -1);
  partNoKnock(tube(curve([lSh, lIk.elbow, lIk.hand], 4), 20), skinF, outline(10));
  partNoKnock(handCircle(lIk.hand[0], lIk.hand[1], 11, sd + 11, 0, 16), skinF, outline(12, { w: 4.6 }));

  // ---- legs, mismatched socks, boots ----
  const legL = [[x - 20, 690], [x - 24, 752], [x - 22, 796]];
  const legR = [[x + 20, 690], [x + 32, 748], [x + 36, 796]];
  partNoKnock(tube(curve(legL, 4), 21), skinF, outline(20));
  partNoKnock(tube(curve(legR, 4), 21), skinF, outline(21));
  const sockAt = (leg, f, s) => {
    const a = leg[leg.length - 2];
    const b = leg[leg.length - 1];
    const p0 = [lerp(a[0], b[0], 0.35), lerp(a[1], b[1], 0.35)];
    partNoKnock(tube(curve([p0, b], 3), 23), f, outline(s, { w: 5 }));
    for (let k = 0; k < 2; k++) {
      const u = 0.5 + k * 0.2;
      const c = [lerp(a[0], b[0], u), lerp(a[1], b[1], u)];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const d = Math.hypot(dx, dy) || 1;
      line(C.l, [[c[0] - (dy / d) * 10, c[1] + (dx / d) * 10], [c[0] + (dy / d) * 10, c[1] - (dx / d) * 10]], {
        col: PAL.cream,
        w: 3.4,
        p: 0.9,
        seed: s + 4 + k,
        boilStep: step,
        boilAmp: amp,
        taper: 0.2,
        streak: 0,
      });
    }
    const foot = ellipse(b[0] + 5, b[1] + 7, 17, 9, 18);
    partNoKnock(foot, bootF, outline(s + 3, { w: 4.8 }));
  };
  sockAt(legL, sockL, sd + 30);
  sockAt(legR, sockR, sd + 40);

  // ---- pinafore ----
  const body = girlTorso(x, lean);
  partNoKnock(body, dressF, outline(50, { w: 6.2 }));
  // Shirt collar + two buttons at the bib.
  const collar = smooth([[x - 13, 544 + lean], [x + 13, 544 + lean], [x + 8, 562 + lean], [x - 8, 562 + lean]], 3);
  partNoKnock(collar, { ...dressF, col: PAL.cream, seed: sd + 51 }, outline(52, { w: 4.2 }));
  for (const [bx, by] of [
    [x - 22, 606],
    [x - 22, 636],
  ]) {
    dab(C.f, bx, by, 4.2, { col: PAL.ochre, p: 0.9, seed: sd + 55 + by, gap: 2.5, w: 3, over: 0.4, boilStep: step, boilAmp: amp });
  }
  // Pocket on the pinafore.
  const pocket = smooth([[x - 40, 640], [x - 6, 640], [x - 9, 680], [x - 37, 680]], 3);
  partNoKnock(pocket, { ...dressF, p: 0.62, seed: sd + 56 }, outline(57, { w: 3.8, p: 0.75 }));

  // ---- neck + head ----
  const headC = [x, GIRL.headY + lean];
  partNoKnock(tube([[x - 9, 540 + lean], [x, 528 + lean], [x + 9, 540 + lean]], 16), skinF, outline(60, { w: 4.4 }));
  // Back hair mass, then two low buns.
  const backHair = smooth(
    [
      [headC[0] - 62, headC[1] + 18],
      [headC[0] - 68, headC[1] - 30],
      [headC[0] - 38, headC[1] - 62],
      [headC[0] + 6, headC[1] - 68],
      [headC[0] + 46, headC[1] - 56],
      [headC[0] + 66, headC[1] - 18],
      [headC[0] + 60, headC[1] + 20],
      [headC[0] + 20, headC[1] + 34],
      [headC[0] - 20, headC[1] + 34],
    ],
    4,
  );
  partNoKnock(backHair, hairF, null);
  partNoKnock(ellipse(headC[0] - 60, headC[1] + 6, 27, 25, 22), hairF, outline(62, { w: 4.8 }));
  partNoKnock(ellipse(headC[0] + 60, headC[1] + 6, 29, 27, 22), hairF, outline(63, { w: 4.8 }));
  // Hair ties (orange bands) on the buns.
  for (const [tx, ty, s] of [
    [headC[0] - 37, headC[1] + 2, 64],
    [headC[0] + 37, headC[1] + 2, 65],
  ]) {
    partNoKnock(ellipse(tx, ty, 7, 9, 12), { ...bootF, col: PAL.orange }, outline(s, { w: 3.2 }));
  }
  // Face.
  const face = ellipse(headC[0], headC[1] + 4, 52, 50, 40);
  partNoKnock(face, skinF, null);
  line(C.l, ellipse(headC[0], headC[1] + 4, 52, 50, 34, -0.05, Math.PI + 0.05), outline(66));
  // Side-swept fringe: a filled mass with only its lower edge inked.
  const fringe = smooth(
    [
      [headC[0] - 54, headC[1] - 4],
      [headC[0] - 58, headC[1] - 34],
      [headC[0] - 34, headC[1] - 60],
      [headC[0] + 4, headC[1] - 66],
      [headC[0] + 48, headC[1] - 50],
      [headC[0] + 58, headC[1] - 16],
      [headC[0] + 38, headC[1] - 8],
      [headC[0] + 20, headC[1] - 30],
      [headC[0] - 2, headC[1] - 16],
      [headC[0] - 22, headC[1] - 34],
      [headC[0] - 40, headC[1] - 14],
    ],
    4,
  );
  partNoKnock(fringe, { ...hairF, seed: sd + 70 }, null);
  line(C.l, fringe.slice(6, fringe.length - 1), outline(71, { w: 5.2 }));

  // Eyes look toward the crayon tip.
  const look = armTarget ? [clamp((armTarget[0] - headC[0]) / 260, -1, 1), clamp((armTarget[1] - headC[1]) / 240, -1, 1)] : [0, 0];
  const eyeY = headC[1] + 8;
  for (const [ex, k] of [
    [headC[0] - 18, 1],
    [headC[0] + 19, 1],
  ]) {
    partNoKnock(ellipse(ex + 2 * look[0], eyeY + 2 * look[1], 5.4, 6.8, 14), { col: PAL.ink, p: 1, gap: 3, w: 4, over: 0.4, seed: sd + 80 + k, boilStep: step, boilAmp: amp }, null);
    dab(C.l, ex + 2 * look[0] + 1.8, eyeY + 2 * look[1] - 2.4, 1.7, { col: PAL.white, p: 1, seed: sd + 82 + k, gap: 1.6, w: 2.4, boilStep: step, boilAmp: amp });
  }
  // Brows, nose, smile.
  line(C.l, [[headC[0] - 27, headC[1] - 8], [headC[0] - 12, headC[1] - 12]], outline(84, { w: 3.4, p: 0.75 }));
  line(C.l, [[headC[0] + 13, headC[1] - 12], [headC[0] + 28, headC[1] - 8]], outline(85, { w: 3.4, p: 0.75 }));
  line(C.l, [[headC[0] - 4, headC[1] + 16], [headC[0] + 1, headC[1] + 21], [headC[0] + 5, headC[1] + 17]], outline(86, { w: 3, p: 0.7 }));
  line(C.l, [[headC[0] - 12, headC[1] + 29], [headC[0], headC[1] + 35], [headC[0] + 12, headC[1] + 28]], outline(87, { w: 3.8, p: 0.85 }));
  dab(C.f, headC[0] - 36, headC[1] + 25, 8, { col: PAL.pink, p: 0.8, seed: sd + 88, sq: 0.7, boilStep: step, boilAmp: amp });
  dab(C.f, headC[0] + 36, headC[1] + 25, 8, { col: PAL.pink, p: 0.8, seed: sd + 89, sq: 0.7, boilStep: step, boilAmp: amp });

  // ---- right arm + crayon (in front) ----
  const rSh = [x + 47, 552 + lean];
  const ik = ik2(rSh, armTarget, 78, 76, 1);
  partNoKnock(tube(curve([rSh, ik.elbow, ik.hand], 4), 22), skinF, outline(90));
  // Sleeve over the upper arm.
  const sleeve = tube(curve([rSh, [lerp(rSh[0], ik.elbow[0], 0.58), lerp(rSh[1], ik.elbow[1], 0.58)]], 3), 27);
  partNoKnock(sleeve, { col: PAL.cream, p: 0.8, gap: 5, w: 8, ang: 1.2, seed: sd + 91, over: 1.5, boilStep: step, boilAmp: amp }, outline(92, { w: 4.6 }));
  for (let i = 0; i < 3; i++) {
    const u = 0.25 + i * 0.22;
    const px = lerp(rSh[0], ik.elbow[0], u);
    const py = lerp(rSh[1], ik.elbow[1], u);
    line(C.l, [[px - 10, py - 8], [px + 10, py + 8]], { col: PAL.red, w: 4.5, p: 0.9, seed: sd + 93 + i, boilStep: step, boilAmp: amp, taper: 0.3, streak: 0 });
  }
  const handAng = Math.atan2(ik.hand[1] - ik.elbow[1], ik.hand[0] - ik.elbow[0]);
  const mitten = xf(
    smooth([[-11, -8], [2, -11], [13, -6], [16, 1], [12, 8], [2, 11], [-8, 7], [-12, 0]], 3),
    { x: ik.hand[0], y: ik.hand[1], r: handAng },
  );
  partNoKnock(mitten, skinF, outline(96, { w: 4.8 }));
  const thumb = xf(
    smooth([[0, -3], [7, -12], [12, -10], [9, -2], [4, 1]], 3),
    { x: ik.hand[0], y: ik.hand[1], r: handAng },
  );
  partNoKnock(thumb, skinF, outline(97, { w: 3.8 }));
  const cuff = [
    [ik.hand[0] - Math.cos(handAng) * 12 - Math.sin(handAng) * 9, ik.hand[1] - Math.sin(handAng) * 12 + Math.cos(handAng) * 9],
    [ik.hand[0] - Math.cos(handAng) * 12 + Math.sin(handAng) * 9, ik.hand[1] - Math.sin(handAng) * 12 - Math.cos(handAng) * 9],
  ];
  line(C.l, cuff, { col: PAL.ink, w: 3.6, p: 0.8, seed: sd + 98, boilStep: step, boilAmp: amp, taper: 0.2, streak: 0 });

  if (crayon) {
    // A short wax crayon held between hand and tip; the tip is the drawing point.
    const tip = crayon.tip;
    const base = ik.hand;
    const dx = tip[0] - base[0];
    const dy = tip[1] - base[1];
    const d = Math.hypot(dx, dy) || 1;
    const nx = (-dy / d) * 7;
    const ny = (dx / d) * 7;
    const bodyPts = [
      [base[0] + nx, base[1] + ny],
      [tip[0] + nx * 0.7, tip[1] + ny * 0.7],
      [tip[0] - nx * 0.7, tip[1] - ny * 0.7],
      [base[0] - nx, base[1] - ny],
    ];
    partNoKnock(bodyPts, { col: crayon.col, p: 0.95, gap: 3, w: 5.5, ang: Math.atan2(dy, dx), seed: sd + 97, over: 0.5, boilStep: step, boilAmp: amp }, outline(98, { w: 3.8 }));
    // Paper band around the crayon body.
    const b0 = [lerp(base[0], tip[0], 0.34), lerp(base[1], tip[1], 0.34)];
    const b1 = [lerp(base[0], tip[0], 0.5), lerp(base[1], tip[1], 0.5)];
    line(C.l, [b0, b1], { col: PAL.cream, w: 8, p: 1, seed: sd + 99, boilStep: step, boilAmp: amp, taper: 0.1, streak: 0 });
    partNoKnock(ellipse(tip[0], tip[1], 5.5, 4.5, 10, 0, 6.3, Math.atan2(dy, dx)), { col: crayon.col, p: 1, seed: sd + 100, gap: 2, w: 3, over: 0.3, boilStep: step, boilAmp: amp }, outline(101, { w: 3 }));
  }
}

// ---- star ------------------------------------------------------------------
function drawStar(C, spec, step, amp, seed) {
  const { pts, drawOutline, drawFill, tail, tailDraw = 0 } = spec;
  if (tail && tailDraw > 0) {
    // The comet tail appears only as the object lifts, so it never reads as a
    // stick in the child's hand while she is drawing. It trails left/up,
    // opposite the rise, and is revealed by the same lift progress.
    const root = pts[6] || pts[0];
    for (let i = 0; i < 3; i++) {
      const off = (i - 1) * 20;
      const end = [root[0] - 320 - i * 26, root[1] - 86 + off];
      line(C.f, [root, [lerp(root[0], end[0], 0.5), lerp(root[1], end[1], 0.5) - 14], end], {
        col: i === 1 ? PAL.orange : PAL.yellow,
        w: 10 - i * 2.5,
        p: 0.8 - i * 0.1,
        seed: seed + 210 + i,
        draw: tailDraw,
        boilStep: step,
        boilAmp: amp,
        taper: 0.75,
        streak: 2,
      });
    }
  }
  if (drawFill > 0) {
    fill(C.f, pts, { col: PAL.yellow, p: 0.96, gap: 6, w: 12, ang: 0.55, seed: seed + 220, draw: drawFill, over: 4.5, cross: true, crossP: 0.55, boilStep: step, boilAmp: amp });
    fill(C.f, pts, { col: PAL.orange, p: 0.6, gap: 10, w: 8, ang: 1.2, seed: seed + 221, draw: drawFill, over: 3.5, cross: false, boilStep: step, boilAmp: amp });
  }
  if (drawOutline > 0) {
    line(C.l, [...pts, pts[0]], { col: PAL.ink, w: 6.4, p: 0.95, seed: seed + 230, draw: drawOutline, taper: 0.18, streak: 2, boilStep: step, boilAmp: amp });
  }
  if (drawFill > 0.7) {
    // A couple of interior shade strokes, only after most of the colour is down.
    const c = starBase;
    line(C.f, [[c.x - 24, c.y + 12], [c.x + 20, c.y - 10]], { col: PAL.orange, w: 6, p: 0.6, seed: seed + 240, draw: clamp((drawFill - 0.7) / 0.3), boilStep: step, boilAmp: amp, taper: 0.4, streak: 0 });
    line(C.f, [[c.x - 8, c.y + 30], [c.x + 26, c.y + 14]], { col: PAL.ochre, w: 5, p: 0.55, seed: seed + 241, draw: clamp((drawFill - 0.7) / 0.3), boilStep: step, boilAmp: amp, taper: 0.4, streak: 0 });
  }
}

// ---- wash ------------------------------------------------------------------
function drawWash(wash, progress, step, amp) {
  const g = wash.g;
  const { w, h } = { w: wash.c.width, h: wash.c.height };
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, w, h);
  if (progress <= 0) return;
  const top = h * (1.08 - 1.2 * progress);
  const edge = [];
  for (let i = 0; i <= 48; i++) {
    const x = (i / 48) * w;
    const y =
      top +
      Math.sin(i * 0.42 + step * 0.31) * h * 0.009 +
      (hash(i + step * 0.7) - 0.5) * h * 0.004;
    edge.push([x, y]);
  }
  // A soft pigment front: transparent above, dense below, with a wavy lip.
  const grad = g.createLinearGradient(0, top - h * 0.12, 0, top + h * 0.03);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.5)');
  grad.addColorStop(1, 'rgba(255,255,255,0.94)');
  g.fillStyle = grad;
  g.beginPath();
  g.moveTo(0, h);
  edge.forEach(([x, y]) => g.lineTo(x, y));
  g.lineTo(w, h);
  g.closePath();
  g.fill();
  // Two broad overlaps keep the wash from reading as one flat field.
  g.globalAlpha = 0.08;
  for (let i = 0; i < 2; i++) {
    const off = (i - 0.5) * h * 0.14;
    g.fillRect(0, top + off, w, h * 0.24);
  }
  // The darker wet leading edge.
  g.globalAlpha = 0.3;
  g.strokeStyle = '#fff';
  g.lineWidth = Math.max(1.5, h * 0.0045);
  g.beginPath();
  edge.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.stroke();
  g.globalAlpha = 1;
}

// ---- public render ---------------------------------------------------------
export function renderCrayonBook(canvas, ctx) {
  const width = Math.max(1, Math.floor(ctx.width));
  const height = Math.max(1, Math.floor(ctx.height));
  const params = ctx.params && typeof ctx.params === 'object' ? ctx.params : {};
  const duration = Number.isFinite(params.duration) && params.duration > 0 ? params.duration : 10;
  const t = clamp((ctx.time ?? 0) / duration, 0, 1);
  const seed = Number.isFinite(ctx.seed) ? ctx.seed : 1;
  const motif = params.motif === 'comet' ? 'comet' : 'star';
  const boilStep = Math.floor((ctx.time ?? 0) * 12);
  const boilAmp = lerp(1, 0.5, ss(seg(t, 0.88, 1)));

  const cam = cameraAt(t);
  setView(width, height, cam);
  const s = ensureState(canvas, width, height);
  s.comp.resize(width, height);
  s.comp.paperCam(cam.x, cam.y, viewScale());
  s.comp.toothScale = 1;

  clearGroup(s.bg);
  clearGroup(s.star);
  clearGroup(s.girl);
  drawBackground(s.bg, seed, boilStep, boilAmp * 0.55);

  // Action timings are fractions of the authored duration.
  const { drawOutline, drawFill, reach, lift, wash, settle } = pageActionAt(t);

  const basePts = starShape(seed + 7);
  const starC = {
    x: lerp(starBase.x, 1158, lift),
    y: lerp(starBase.y, 272, lift) + Math.sin(t * Math.PI * 2) * 5 * lift,
    r: starBase.r * (1 + 0.13 * lift) + Math.sin(t * Math.PI * 4) * 1.6 * settle,
    rot: 0.18 * lift + 0.02 * Math.sin(t * Math.PI * 2) * settle,
  };
  const pts = xf(basePts, { x: starC.x - starBase.x, y: starC.y - starBase.y, r: starC.rot, s: starC.r / starBase.r, ox: starBase.x, oy: starBase.y });
  drawStar(
    s.star,
    { pts, drawOutline, drawFill, tail: motif === 'comet', tailDraw: lift },
    boilStep,
    boilAmp,
    seed,
  );

  // Crayon tip follows the outline, then the fill guide, then the reach.
  let tip = null;
  if (t < 0.6) {
    if (drawFill <= 0.001) tip = pathPoint(pts, drawOutline);
    else {
      const rows = 7;
      const idx = drawFill * rows;
      const row = Math.floor(idx);
      const f = idx - row;
      const y0 = starBase.y - 40 + (row / rows) * 88;
      const y1 = starBase.y - 40 + ((row + 1) / rows) * 88;
      const dir = row % 2 ? -1 : 1;
      const x0 = starC.x + dir * lerp(-42, 42, f);
      const x1 = starC.x - dir * lerp(-42, 42, f);
      tip = [lerp(x0, x1, f), lerp(y0, y1, f)];
    }
  }
  if (!tip) {
    const low = xf([[starBase.x, starBase.y + starBase.r * 0.9]], { x: starC.x - starBase.x, y: starC.y - starBase.y, r: starC.rot, s: starC.r / starBase.r, ox: starBase.x, oy: starBase.y })[0];
    tip = low;
  }

  const reachTarget = (() => {
    const shoulder = [GIRL.x + 47 + 3 * reach, 552 + 2 * reach];
    const low = xf([[starBase.x, starBase.y + starBase.r * 0.86]], { x: starC.x - starBase.x, y: starC.y - starBase.y, r: starC.rot, s: starC.r / starBase.r, ox: starBase.x, oy: starBase.y })[0];
    const want = t < 0.6 ? tip : low;
    const dx = want[0] - shoulder[0];
    const dy = want[1] - shoulder[1];
    const d = Math.hypot(dx, dy) || 1;
    const max = 176;
    if (t < 0.6) return want;
    const k = Math.min(1, max / d);
    return [shoulder[0] + dx * k, shoulder[1] + dy * k];
  })();

  // The page opens with the crayon held low; she raises it into the first
  // stroke instead of starting already frozen on the star.
  const intro = ss(seg(t, 0.0, 0.07));
  if (t < 0.6 && intro < 1) {
    const rest = [GIRL.x + 36, 648];
    tip = [lerp(rest[0] + 18, tip[0], intro), lerp(rest[1] - 12, tip[1], intro)];
  }

  const armTarget = (() => {
    const shoulder = [GIRL.x + 47 + 3 * reach, 552 + 2 * reach];
    if (t < 0.6) {
      // Hand holds the crayon a little behind its tip.
      const dx = tip[0] - shoulder[0];
      const dy = tip[1] - shoulder[1];
      const d = Math.hypot(dx, dy) || 1;
      return [tip[0] - (dx / d) * 58, tip[1] - (dy / d) * 58];
    }
    return reachTarget;
  })();

  drawGirl(s.girl, t, seed, boilStep, boilAmp, armTarget, reach, t < 0.6 ? { tip, col: drawFill <= 0.001 ? PAL.ink : PAL.yellow } : null);

  s.comp.begin(PAL.paper, [0, 0]);
  s.comp.crayon(s.bg.f.c, { gain: 1, soft: 0.07 });
  s.comp.crayon(s.bg.l.c, { gain: 1, soft: 0.07 });
  drawWash(s.wash, wash, boilStep, boilAmp);
  if (wash > 0) s.comp.wash(s.wash.c, { color: [0.12, 0.16, 0.44], resist: 0.93, edge: 1.7, gran: 0.62 });
  s.comp.crayon(s.star.f.c, { gain: 1, soft: 0.07 });
  s.comp.crayon(s.star.l.c, { gain: 1, soft: 0.07 });
  s.comp.crayon(s.girl.f.c, { gain: 1, soft: 0.07 });
  s.comp.crayon(s.girl.l.c, { gain: 1, soft: 0.07 });
  s.comp.finish({ vig: 0.28, emb: 0.55, lift: 1, lamp: [0.5, 0.5, 1, 0] });
}

/** Design-page helper exports for model sheets/tests. */
export const page = { width: PAGE_W, height: PAGE_H, ground: GROUND_Y, star: starBase, constellation: CONSTELLATION };

/**
 * Pure clock facts for regression: the camera is continuous at the output rate,
 * while the mark/pose boil advances on twos (12 fps). Calling this twice one
 * output frame apart returns different cameras and (usually) the same boil.
 */
export function crayonClocks(time, duration = 10) {
  const t = clamp(time / duration, 0, 1);
  return { time, camera: cameraAt(t), boilStep: Math.floor(time * 12) };
}
