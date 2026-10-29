/**
 * RISOGRAPH RIDE — one packed separation plate, three spot inks, one action.
 *
 * Composition is authored in a 1920x1080 design space and scaled to the output
 * frame. Two variants share the same rider, bicycle and printing language but
 * change place, route, object and event:
 *
 *   riverside : a quay above a river; the rider rings the bell and the pigeons
 *               flush from the wall; trees, bridge and town give the parallax.
 *   bakery    : a narrow street; the baker reaches out of the window and the
 *               rider catches a baguette in passing, then drops it in the basket.
 *
 * Printing is not a filter. The packed plate (one RGB canvas) carries the three
 * ink densities; the shader separates them with independent registration,
 * halftone angle, grain and roller-gate timing. draw.mjs owns knockout and
 * overprint; `layer()` keeps the paper halo around the characters.
 *
 * Everything here is a pure function of (frame, seed, params). The character
 * animation is stepped on twos, the camera and wheels move every frame, the
 * ink boils at 12 fps, and the paper sheet changes only between variants.
 */
import {
  g, W, H, plate, configurePlate, clear, layer, over, inkA,
  circle, ellipse, rect, rrect, poly, blob, line, curve, ring,
} from './draw.mjs';
import { PAL, riderBike, pigeon, baguette } from './rider.mjs';
import { makeRiso } from './riso.mjs';
import { PRESS, RIDES, actionAt } from './action-facts.mjs';

const DESIGN_W = 1920;
const DESIGN_H = 1080;
const FPS = 24;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (t) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};
const seg = (t, a, b) => clamp01((t - a) / (b - a));
const hash = (n) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** Deterministic 32-bit PRNG for paper-level composition details. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// RIVERSIDE
// ---------------------------------------------------------------------------

const RIVER = { horizon: 600, quay: 900, designW: DESIGN_W };

function skyBands(y0, y1, colours) {
  const n = colours.length;
  const h = (y1 - y0) / n;
  for (let i = 0; i < n; i++) rect(0, y1 - (i + 1) * h - 1, DESIGN_W, h + 2, colours[i]);
}

function townSilhouette(cx, horizon) {
  const random = mulberry32(11);
  let x = -300;
  while (x < 2600) {
    const w = 42 + random() * 78;
    const h = 20 + random() * 62;
    const top = horizon - h;
    const X = x - cx * 0.08;
    if (X < DESIGN_W + 200 && X + w > -200) {
      g.beginPath();
      g.moveTo(X, horizon + 2);
      g.lineTo(X, top);
      const kind = random();
      if (kind < 0.35) {
        g.lineTo(X + w / 2, top - w * 0.42);
        g.lineTo(X + w, top);
      } else if (kind < 0.46) {
        g.arc(X + w / 2, top, w / 2, Math.PI, 0);
      } else if (kind < 0.54) {
        g.lineTo(X + w * 0.42, top);
        g.lineTo(X + w * 0.5, top - 86);
        g.lineTo(X + w * 0.58, top);
        g.lineTo(X + w, top);
      } else {
        g.lineTo(X + w, top);
      }
      g.lineTo(X + w, horizon + 2);
      g.closePath();
      if (random() < 0.5) g.rect(X + w * 0.22, top - 14, 8, 16);
    }
    x += w + (random() < 0.2 ? 8 + random() * 26 : -2);
  }
  g.fillStyle = inkA([0.55, 0, 0]);
  g.fill();
}

function bridge(cx) {
  const bx = 330 - cx * 0.16;
  g.beginPath();
  g.moveTo(bx - 500, RIVER.horizon - 54);
  g.lineTo(bx + 500, RIVER.horizon - 54);
  g.lineTo(bx + 500, RIVER.horizon);
  for (let i = 2; i >= -2; i--) {
    const ax = bx + i * 180;
    g.lineTo(ax + 70, RIVER.horizon);
    g.arc(ax, RIVER.horizon, 70, 0, Math.PI, true);
  }
  g.lineTo(bx - 500, RIVER.horizon);
  g.closePath();
  g.fillStyle = inkA([1, 0, 0.05]);
  g.fill();
  for (let i = -2; i <= 3; i++) rect(bx + i * 180 - 88 - 3, RIVER.horizon - 66, 6, 12, [1, 0, 0.1]);
}

function tree(x, ground, k, seed) {
  const cx = x;
  line([[cx, ground], [cx, ground - 200]], 16, [0.8, 0.15, 0.18]);
  const random = mulberry32(seed);
  const pts = [];
  for (let i = 0; i < 13; i++) {
    const a = (i / 13) * Math.PI * 2;
    const r = 108 + random() * 30;
    pts.push([cx + Math.cos(a) * r * 1.12, ground - 300 + Math.sin(a) * r * 0.86]);
  }
  blob(pts, [0.45, 0.8, 0.06]);
  const pts2 = [];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const r = 58 + random() * 22;
    pts2.push([cx - 26 + Math.cos(a) * r, ground - 330 + Math.sin(a) * r * 0.8]);
  }
  blob(pts2, [0.3, 0.95, 0.12]);
  over(() => {
    for (let i = 0; i < 16; i++) {
      const a = random() * Math.PI * 2;
      const r = random() * 96;
      circle(cx + Math.cos(a) * r, ground - 320 + Math.sin(a) * r * 0.7, 5 + random() * 8, [0, 0.5, 0.05]);
    }
  });
}

function lamp(x, groundY, height, on) {
  line([[x, groundY], [x, groundY - height]], 10, [1, 0, 0.3]);
  curve([[x, groundY - height], [x + 10, groundY - height - 26], [x + 44, groundY - height - 30]], 8, [1, 0, 0.3]);
  poly(
    [[x + 28, groundY - height - 30], [x + 62, groundY - height - 30], [x + 56, groundY - height - 10], [x + 34, groundY - height - 10]],
    [1, 0, 0.3],
  );
  if (on) over(() => circle(x + 46, groundY - height - 6, 36, [0, 0.65, 0]));
}

function riversideBackground(t, cx) {
  // Sky: blue holds the volume, yellow adds the morning temperature.
  skyBands(0, RIVER.horizon, [
    [0.1, 0.16, 0],
    [0.16, 0.28, 0],
    [0.22, 0.42, 0],
    [0.3, 0.62, 0],
  ]);
  // Sun: solid pink, with a yellow overprint core.
  const sunX = 1490 - cx * 0.03;
  circle(sunX, 268, 188, [0, 0, 1]);
  over(() => circle(sunX, 268, 126, [0, 0.7, 0]));
  // Town in blue; inside the sun disc the same town is overprinted pink -> violet.
  townSilhouette(cx, RIVER.horizon);
  g.save();
  g.beginPath();
  g.arc(sunX, 268, 188, 0, Math.PI * 2);
  g.clip();
  over(() => {
    townSilhouette(cx, RIVER.horizon);
    g.fillStyle = inkA([0, 0, 1]);
    g.fill();
  });
  g.restore();

  bridge(cx);
  // Far bank and river.
  rect(0, RIVER.horizon, DESIGN_W, 16, [0.4, 0.55, 0.1]);
  rect(0, RIVER.horizon, DESIGN_W, RIVER.quay - RIVER.horizon, [0.58, 0.2, 0.02]);
  const random = mulberry32(3);
  for (let i = 0; i < 48; i++) {
    const u = Math.pow(random(), 1.3);
    const y = RIVER.horizon + 10 + u * (RIVER.quay - RIVER.horizon - 24);
    const x = ((random() * 2600 - cx * (0.25 + u * 0.6)) % 2600 + 2600) % 2600 - 300;
    const w = 30 + random() * 110 * (1 + u * 2);
    rect(x, y, w, 3 + u * 4, [0.7, 0.1, 0.02]);
  }
  // Paper-white ripples: short knocked-out lines that read as water glare.
  for (let i = 0; i < 9; i++) {
    const y = RIVER.horizon + 34 + i * 27;
    const x = ((i * 231 - cx * 0.55) % 2200 + 2200) % 2200 - 120;
    const w = 96 + (i % 3) * 64;
    line([[x, y], [x + w * 0.45, y + 2], [x + w, y - 1]], 2.4, [0, 0, 0]);
    over(() => line([[x + 14, y + 4], [x + w - 14, y + 2]], 1.6, [0, 0.26, 0]));
  }
  // Sun glitter as pink overprint on the water.
  over(() => {
    for (let i = 0; i < 7; i++) {
      const y = RIVER.horizon + 34 + i * 30;
      const w = 22 + (i % 4) * 16;
      rect(sunX - 70 + (i % 4) * 38, y, w, 2.5, [0.08, 0, 0.4]);
    }
  });

  // Quay wall: blue + pink reads as the dark violet stone.
  rect(0, RIVER.quay, DESIGN_W, DESIGN_H - RIVER.quay, [0.9, 0, 0.45]);
  rect(0, RIVER.quay, DESIGN_W, 16, [0.4, 0, 0.2]);
  for (let r = 0; r < 4; r++) {
    const yy = RIVER.quay + 28 + r * 46;
    for (let k = -2; k < 12; k++) {
      const xx = ((k * 168 + (r % 2) * 84 - cx * 0.5) % 2016 + 2016) % 2016 - 120;
      rect(xx, yy + 4, 3, 38, [0.45, 0, 0.36]);
    }
    rect(0, yy + 40, DESIGN_W, 3, [0.45, 0, 0.36]);
  }

  // Trees on the near bank, framing the rider.
  tree(170 - cx * 0.42, RIVER.quay + 18, 1, 31);
  tree(1810 - cx * 0.42, RIVER.quay + 18, 1, 37);
  // Foreground lamp.
  lamp(120 - cx * 0.72, DESIGN_H + 30, 520, 1);
}

function pigeonPositions(cx, t, variant) {
  const base = variant === 'riverside' ? RIVER.quay + 2 : 1030;
  const spots = [
    { x: 980, y: base, flip: false },
    { x: 1062, y: base, flip: true },
    { x: 1150, y: base, flip: false },
    { x: 1238, y: base, flip: true },
    { x: 1320, y: base, flip: false },
  ];
  const flush = RIDES[variant].pigeons;
  return spots.map((spot, i) => {
    const delay = i * flush.delay;
    const f = smooth(seg(t, flush.start + delay, flush.end + delay));
    return {
      x: spot.x - cx * (variant === 'riverside' ? 0.98 : 1) + f * (600 + i * 80),
      y: spot.y - f * (330 + i * 40) - Math.sin(f * Math.PI) * 34,
      s: 0.52,
      pose: f > 0.02 ? 'fly' : Math.floor(t * 2 + i) % 4 === 0 ? 'peck' : 'walk',
      step: t * 2 + i * 0.31,
      frame: Math.floor((t + i * 0.12) * 12) % 4,
      flip: spot.flip,
      tilt: f > 0.02 ? -0.12 : Math.sin(t * 1.7 + i) * 0.16,
    };
  });
}

function riversideActors(t, frame, cx) {
  const scale = 0.72;
  const ground = RIVER.quay + 4;
  const worldX = 520 + 250 * t;
  const wa = (worldX - 520) / (96 * scale);
  const crank = wa / 2.2;
  const stepped = Math.floor(t * 12) / 12;
  const bell = actionAt('riverside', t).bell;
  const grip = [42, -306];
  const bellTarget = [94, -338];
  const nearHand = [mix(grip[0], bellTarget[0], bell), mix(grip[1], bellTarget[1], bell)];
  const pigeons = pigeonPositions(cx, t, 'riverside');
  for (const p of pigeons) {
    layer(
      () =>
        pigeon(p.x, p.y, p.s, {
          pose: p.pose,
          step: p.step,
          frame: p.frame,
          flip: p.flip,
          tilt: p.tilt,
        }),
      4,
    );
  }
  layer(
    () =>
      riderBike(760, ground, scale, {
        crank,
        wa,
        lean: 0.2,
        ph: stepped * 1.4,
        scarfAmt: 0.82,
        expr: bell > 0.03 ? 'surprise' : 'calm',
        headO: { tilt: bell * -0.14 },
        armN: bell > 0.001 ? nearHand : undefined,
        armBend: -1,
        bob: Math.sin(crank * 2) * 1.8,
        shadow: false,
        inBasket: () => baguette(200, -330, 190, -1.15),
      }),
    5,
  );
  return { worldX, scale, ground, stepped };
}

// ---------------------------------------------------------------------------
// BAKERY STREET
// ---------------------------------------------------------------------------

const STREET = { sky: 300, roof: 430, facade: 900, ground: 985 };

function streetBackground(t, cx) {
  skyBands(0, STREET.sky, [
    [0.08, 0.18, 0],
    [0.12, 0.28, 0],
    [0.16, 0.4, 0],
  ]);
  // Haze/far roofs fill the gap between the sky and the near facades.
  rect(0, STREET.sky, DESIGN_W, STREET.roof - STREET.sky + 26, [0.1, 0.32, 0]);
  // Distant roofs.
  const random = mulberry32(21);
  for (let x = -400; x < 2600; x += 140) {
    const X = x - cx * 0.14;
    const h = 36 + random() * 58;
    rect(X, STREET.roof - h, 138, h + 10, [0.5, 0, 0.12]);
  }

  // Street facades.
  const facades = [
    { x: -260, w: 420, c: [0.32, 0.18, 0.06] },
    { x: 160, w: 390, c: [0.24, 0.04, 0.2] },
    { x: 550, w: 420, c: [0.34, 0.12, 0.11] },
    { x: 970, w: 300, c: [0.28, 0.26, 0.04] },
    { x: 1270, w: 360, c: [0.2, 0.08, 0.26] },
    { x: 1630, w: 420, c: [0.36, 0.22, 0.08] },
  ];
  for (let fi = 0; fi < facades.length; fi++) {
    const f = facades[fi];
    const X = f.x - cx;
    if (X > DESIGN_W + 200 || X + f.w < -200) continue;
    const top = fi === 3 ? 520 : 470;
    rect(X, top, f.w, STREET.facade - top, f.c);
    // Mansard roof.
    if (fi % 2 === 0) {
      poly([[X - 8, top], [X + f.w + 8, top], [X + f.w - 26, top - 62], [X + 26, top - 62]], [0.66, 0, 0.14]);
      for (let d = 0; d < Math.floor(f.w / 96); d++) {
        rect(X + 46 + d * 96, top - 50, 34, 38, [0.72, 0.05, 0.18]);
      }
    } else {
      rect(X, top - 14, f.w, 14, [0.58, 0, 0.1]);
    }
    // Windows, some lit.
    const nx = Math.max(2, Math.floor((f.w - 50) / 130));
    const gap = (f.w - 30) / nx;
    for (let floor = 0; floor < 3; floor++) {
      for (let k = 0; k < nx; k++) {
        const wx = X + 18 + gap * k + gap / 2 - 22;
        const wy = top + 34 + floor * 124;
        rect(wx - 18, wy - 4, 15, 84, [0.36, 0.62, 0]);
        rect(wx + 46, wy - 4, 15, 84, [0.36, 0.62, 0]);
        const lit = (k + floor + fi) % 5 === 0;
        rect(wx, wy, 44, 78, lit ? [0.1, 0.9, 0.1] : [1, 0, 0.24]);
        line([[wx + 22, wy], [wx + 22, wy + 78]], 3, [0.5, 0, 0.1]);
      }
    }
  }

  // Bakery front (world x 1080..1420). Window, door and striped awning.
  const bx = 1080 - cx;
  rect(bx, 590, 340, STREET.facade - 590, [0.24, 0.4, 0.05]);
  rect(bx + 18, 640, 232, 210, [0.9, 0.1, 0.32]); // window frame
  rect(bx + 32, 654, 204, 182, [0.05, 0.82, 0.12]); // lit glass
  for (let k = 0; k < 3; k++) rect(bx + 34, 700 + k * 46, 200, 5, [0.55, 0.38, 0.18]);
  // Loaves in the window.
  for (let k = 0; k < 5; k++) {
    ellipse(bx + 58 + k * 38, 690, 15, 8, 0, [0.15, 1, 0.55]);
    ellipse(bx + 58 + k * 38, 744, 12, 7, 0, [0.15, 1, 0.7]);
  }
  // Door.
  rect(bx + 268, 676, 58, STREET.facade - 676, [0.85, 0.12, 0.3]);
  rect(bx + 276, 688, 42, 86, [0.08, 0.78, 0.14]);
  // Awning: alternate blue and yellow stripes with a scalloped edge.
  for (let k = 0; k < 10; k++) {
    const x = bx + 6 + k * 33;
    poly([[x, 606], [x + 33, 606], [x + 40, 660], [x + 4, 660]], k % 2 ? [0.1, 0.2, 0] : [0.1, 1, 0.08]);
    g.beginPath();
    g.arc(x + 22, 660, 17, 0, Math.PI);
    g.fillStyle = inkA(k % 2 ? [0.1, 0.2, 0] : [0.1, 1, 0.08]);
    g.fill();
  }
  // Sign board: geometry only, no lettering.
  rrect(bx + 72, 548, 196, 40, 6, [1, 0, 0.3]);
  rrect(bx + 88, 560, 164, 16, 4, [0.2, 0.95, 0.1]);
  // Cat on the sill.
  layer(() => {
    const cx0 = bx + 246;
    ellipse(cx0, 640, 20, 15, 0, [1, 0, 0.2]);
    circle(cx0 + 14, 620, 11, [1, 0, 0.2]);
    poly([[cx0 + 5, 612], [cx0 + 9, 600], [cx0 + 15, 610]], [1, 0, 0.2]);
    poly([[cx0 + 15, 610], [cx0 + 22, 600], [cx0 + 24, 614]], [1, 0, 0.2]);
    curve([[cx0 - 18, 634], [cx0 - 30, 648], [cx0 - 26, 668]], 5, [1, 0, 0.2]);
  }, 3);

  // Pavement and cobbles.
  rect(0, STREET.facade, DESIGN_W, DESIGN_H - STREET.facade, [0.2, 0.12, 0.06]);
  rect(0, STREET.facade, DESIGN_W, 12, [0.95, 0, 0.16]);
  for (let row = 0; row < 5; row++) {
    const y = STREET.facade + 28 + row * 34;
    const step = 74 + row * 8;
    for (let k = -2; k < DESIGN_W / step + 3; k++) {
      if (hash(k * 13 + row * 7 + Math.floor(cx / step)) > 0.24) continue;
      const x = k * step - (cx % step) + (row % 2) * (step / 2);
      g.beginPath();
      g.arc(x, y + 14, step * 0.4, Math.PI * 1.2, Math.PI * 1.8);
      g.lineWidth = 3;
      g.strokeStyle = inkA([1, 0.04, 0.14]);
      g.stroke();
    }
  }
  // A second lamp behind the rider.
  lamp(1640 - cx * 0.8, STREET.facade + 10, 260, 0.8);
}

function bakeryActors(t, frame, cx) {
  const scale = 0.72;
  const ground = STREET.ground;
  const worldX = 520 + 205 * t;
  const wa = (worldX - 520) / (96 * scale);
  const crank = wa / 2.2;
  const stepped = Math.floor(t * 12) / 12;
  const bakeryFacts = RIDES.bakery.bakery;
  const pigeonFacts = RIDES.bakery.pigeons;
  const { reach, caught, stowed } = actionAt('bakery', t);
  const nearHand = reach > 0.001 ? [mix(42, 186, reach), mix(-306, -566, reach)] : undefined;

  // Baker's hand comes out of the window. One baguette travels from the baker's
  // holding position to the rider's actual IK wrist; the rider then keeps it.
  const wx = 1080 - cx + 150;
  const wy = 690;
  const hx = mix(wx, 900, reach);
  const hy = mix(wy, 590, reach);
  const bakerBread = [(hx + 44 - 760) / scale, (hy - 18 - ground) / scale];
  if (reach > 0.01) {
    const sx = wx - 30;
    const sy = wy + 30;
    const ex = mix(sx, hx, 0.55);
    const ey = mix(sy, hy, 0.55) - 26;
    line([[sx, sy], [ex, ey], [hx, hy]], 27, [0.2, 0.9, 0.12]);
    line([[sx, sy], [ex, ey], [hx, hy]], 20, [0.98, 0.1, 0.32]);
    circle(hx, hy, 12, PAL.skin);
    if (reach > 0.25 && caught <= 0) {
      baguette(hx + 44, hy - 18, 190, -0.55);
    }
  }

  const puddles = [{ x: 1380, y: 1030, flip: true }];
  for (const p of puddles) {
    const flap = smooth(seg(t, pigeonFacts.start, pigeonFacts.end));
    layer(
      () =>
        pigeon(p.x - cx, p.y - flap * 90, 0.46, {
          pose: flap > 0.05 ? 'fly' : Math.floor(t * 2) % 4 === 0 ? 'peck' : 'stand',
          step: t * 2,
          frame: Math.floor(t * 12) % 4,
          flip: p.flip,
          tilt: flap > 0.05 ? -0.1 : 0.2,
        }),
      3,
    );
  }

  const inBasket = () => baguette(200, -330, 190, -1.15);
  layer(
    () =>
      riderBike(760, ground, scale, {
        crank,
        wa,
        lean: 0.16,
        ph: stepped * 1.4,
        scarfAmt: 0.75,
        expr: reach > 0.15 ? 'surprise' : caught > 0.1 ? 'joy' : 'calm',
        headO: { tilt: reach > 0.15 ? -0.1 : 0 },
        armN: nearHand,
        armBend: 1,
        bob: Math.sin(crank * 2) * 1.6,
        shadow: false,
        inBasket: stowed > bakeryFacts.stowVisible ? inBasket : undefined,
        hand:
          caught > 0 && stowed < 0.8
            ? (w) => {
                const k = smooth(caught);
                const bx = mix(bakerBread[0], w[0] + 4, k);
                const by = mix(bakerBread[1], w[1] - 30, k);
                // The baker's bread is drawn in design units; the rider's in rider-local
                // units. Interpolate length and thickness too, so one loaf shrinks
                // continuously into the existing hand-held size instead of popping.
                const length = mix(190 / scale, 190, k);
                const radius = mix(13 / scale, 13, k);
                baguette(bx, by, length, mix(-0.55, mix(-0.9, -1.2, stowed), k), { r: radius });
                circle(w[0], w[1], 10.5, PAL.skin);
              }
            : undefined,
      }),
    5,
  );
  return { worldX, scale, ground, stepped };
}

// ---------------------------------------------------------------------------
// PRINT CONTROL
// ---------------------------------------------------------------------------

const VARIANTS = PRESS;

function registration(t, variant, k) {
  const conf = VARIANTS[variant];
  const offsets = conf.base.map(([x, y]) => [x * k, y * k]);
  for (const beat of conf.kicks) {
    const dt = t - beat;
    if (dt < 0 || dt > 0.45) continue;
    const decay = Math.exp(-dt * 12) * Math.cos(dt * 38);
    for (let i = 0; i < 3; i++) {
      const angle = hash(beat * 13 + i * 5) * Math.PI * 2;
      const amplitude = 8 * k * decay * (i ? 1 : 0.5);
      offsets[i][0] += Math.cos(angle) * amplitude;
      offsets[i][1] += Math.sin(angle) * amplitude;
    }
  }
  return offsets;
}

function plateState(t, variant, width) {
  const conf = VARIANTS[variant];
  const gate = [];
  const sweep = [];
  for (let i = 0; i < 3; i++) {
    const start = conf.gates[i];
    const on = t >= start ? 1 : 0;
    gate.push(on);
    sweep.push(on ? mix(-0.05 * width, width * 1.1, smooth(seg(t, start, start + 0.45))) : 1e5);
  }
  return { gate, sweep };
}

// ---------------------------------------------------------------------------
// ENTRY
// ---------------------------------------------------------------------------

let printer = null;
let printerWidth = 0;
let printerHeight = 0;

function ensurePrinter(canvas, width, height) {
  if (printer && printerWidth === width && printerHeight === height) return printer;
  canvas.width = width;
  canvas.height = height;
  printer = makeRiso(canvas, width, height);
  printerWidth = width;
  printerHeight = height;
  return printer;
}

/**
 * Render one deterministic frame. `ctx.params.variant` selects the composition;
 * all other inputs are derived from the frame clock and the Render seed.
 */
export function renderRiso(canvas, ctx) {
  const width = Math.max(2, Math.round(ctx.width));
  const height = Math.max(2, Math.round(ctx.height));
  const params = ctx.params || {};
  const variant = params.variant === 'bakery' ? 'bakery' : 'riverside';
  const t = ctx.frame / (ctx.fps || FPS);

  const print = ensurePrinter(canvas, width, height);
  configurePlate(width, height);
  clear();

  const k = Math.min(width / DESIGN_W, height / DESIGN_H);
  const ox = (width - DESIGN_W * k) / 2;
  const oy = (height - DESIGN_H * k) / 2;
  g.setTransform(k, 0, 0, k, ox, oy);

  const worldX = 520 + (variant === 'riverside' ? 250 : 205) * t;
  const cx = Math.max(0, worldX - 760);
  let water = null;

  if (variant === 'riverside') {
    riversideBackground(t, cx);
    riversideActors(t, ctx.frame, cx);
    water = {
      y: oy + RIVER.horizon * k,
      b: oy + RIVER.quay * k,
      amp: 10 * k,
      t,
      sep: 0.35,
      refl: 0.3,
    };
  } else {
    streetBackground(t, cx);
    bakeryActors(t, ctx.frame, cx);
  }

  // Trim/crop marks sit on the paper, not in the drawing: registration language only.
  g.setTransform(1, 0, 0, 1, 0, 0);
  const mark = Math.max(8, 16 * k);
  for (const [mx, my] of [
    [mark, mark],
    [width - mark, mark],
    [mark, height - mark],
    [width - mark, height - mark],
  ]) {
    line([[mx - mark * 0.45, my], [mx + mark * 0.45, my]], 2, [0.5, 0, 0]);
    line([[mx, my - mark * 0.45], [mx, my + mark * 0.45]], 2, [0.5, 0, 0]);
  }

  const conf = VARIANTS[variant];
  const plates = plateState(t, variant, width);
  print(plate, {
    seed: Math.floor(ctx.frame / 2),
    sheet: conf.sheet + (ctx.seed || 0) * 0.0001,
    boil: 0.34,
    off: registration(t, variant, k),
    rot: [0, 0.0005, -0.0004],
    ang: [0.2618, 0, 1.309],
    period: Math.max(4, 7 * Math.max(k, 0.4)),
    grain: 0.6,
    gate: plates.gate,
    sweep: plates.sweep,
    water,
  });
}
