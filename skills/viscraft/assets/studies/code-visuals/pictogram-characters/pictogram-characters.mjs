/*
 * Pictogram characters — icon-body actors and a purposeful hand-off.
 *
 * The body IS the icon (a star, a cloud or a gear). Arms and legs attach to
 * points/lobes of that silhouette; there is no human torso, no round head and no
 * icon-as-head skeleton. The module is Canvas2D-only and stateless: every frame
 * is a pure function of { frame, params, seed }.
 *
 * What is adapted from lemo-opuscar styles/pictogram-motion/demo/engine.js and
 * poses/base.js (commit e3cb16f63768c68693ff0e15171d6e755457cc32, MIT):
 *   - the idea of a joint chain expressed as angle poses;
 *   - keyframe interpolation with a per-segment easing choice (`keyPose`);
 *   - a far/near draw order so a prop can pass behind a body and in front of it;
 *   - simple geometric props (disc, baton).
 *
 * What is original here:
 *   - the icon-body actors, their silhouette anchors and their two-bone IK arm;
 *   - the hand-off choreography, phases and ownership change;
 *   - the palette, stage, contact/transfer cues and the deterministic grain.
 *
 * Excluded from the upstream demo: its official five-colour palette, motif and
 * pattern system, event names/marks, athlete poses, fonts, music and `ref/`
 * imagery. No font is loaded and no audio is authored.
 */

export const DEFAULT_FRAMES = 48;

const W = 1920;
const H = 1080;
const GROUND = 900;
const BODY_Y = 560;
const CONTACT_FRACTION = 0.32;
const TRANSFER_DELAY_FRACTION = 0.13;

const TAU = Math.PI * 2;
const D2R = Math.PI / 180;

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const mixPoint = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];

const EASE = {
  inOut: (t) => 0.5 - 0.5 * Math.cos(Math.PI * clamp(t)),
  outCubic: (t) => 1 - Math.pow(1 - clamp(t), 3),
  inCubic: (t) => Math.pow(clamp(t), 3),
  outQuint: (t) => 1 - Math.pow(1 - clamp(t), 5),
};

const VARIANTS = {
  'star-disc': {
    senderShape: 'star',
    receiverShape: 'cloud',
    prop: 'disc',
    palette: { sender: '#d9543b', receiver: '#2f6f8f', token: '#e0a33a' },
  },
  'cloud-baton': {
    senderShape: 'cloud',
    receiverShape: 'gear',
    prop: 'baton',
    palette: { sender: '#6c5ba8', receiver: '#c9792e', token: '#2b8c86' },
  },
};

const BASE_PALETTE = {
  field: '#f3eee2',
  ground: '#ddd2bd',
  line: '#b6a98f',
  ink: '#17212b',
};

const SHAPES = {
  star: { armX: 200, armY: 0, armUpper: 110, armLower: 105, legX: 100, legY: 158, upper: 70, lower: 85 },
  cloud: { armX: 150, armY: -10, armUpper: 140, armLower: 105, legX: 85, legY: 100, upper: 100, lower: 113 },
  gear: { armX: 200, armY: 0, armUpper: 110, armLower: 105, legX: 105, legY: 165, upper: 66, lower: 82 },
};

const ARM = { upper: 110, lower: 105, hand: 27 };
const LEG = { width: 56, shin: 48, foot: 27 };

/* ── deterministic helpers ─────────────────────────────────────────────── */

function hash32(value) {
  let a = value >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function shade(hex, k) {
  const rgb = hexToRgb(hex).map((v) => Math.round(clamp(v * k, 0, 255)));
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

function alpha(hex, a) {
  const rgb = hexToRgb(hex);
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
}

/* ── the public hand-off clock (pure) ──────────────────────────────────── */

/**
 * Resolve the hand-off clock for one source.
 *
 * Frames are counted from 0. The two hands meet at `contactFrame`, the prop's
 * ownership flips at `transferFrame`, and the receiver holds it through the
 * last frame. Both frames are derived from the source length unless an explicit
 * override is supplied, so a shorter test source keeps a readable contact beat.
 */
export function handoffAt(frame, options = {}) {
  const frames = Math.max(4, Math.round(options.frames ?? DEFAULT_FRAMES));
  const last = frames - 1;
  const rawContact = options.contactFrame ?? Math.round(CONTACT_FRACTION * last);
  const contactFrame = clamp(Math.round(rawContact), 2, Math.max(2, last - 1));
  const rawTransfer = options.transferFrame ?? contactFrame + Math.max(2, Math.round(TRANSFER_DELAY_FRACTION * last));
  const transferFrame = clamp(Math.round(rawTransfer), contactFrame + 1, Math.max(contactFrame + 1, last));

  const f = clamp(Math.round(frame), 0, last);
  const u = last === 0 ? 0 : f / last;
  const contactPulse = f >= contactFrame && f < contactFrame + 8 ? 1 - (f - contactFrame) / 8 : 0;
  const transferPulse = f >= transferFrame && f < transferFrame + 6 ? 1 - (f - transferFrame) / 6 : 0;

  const prepareEnd = Math.max(1, Math.round(0.10 * last));
  const reachEnd = Math.max(prepareEnd + 1, Math.round(0.28 * last));
  const resultEnd = Math.max(reachEnd + 1, Math.round(0.70 * last));
  const phase =
    f < prepareEnd
      ? 'settle'
      : f < reachEnd
        ? 'prepare'
        : f < contactFrame
          ? 'approach'
          : f === contactFrame
            ? 'contact'
            : f < transferFrame
              ? 'transfer'
              : f < resultEnd
                ? 'result'
                : 'hold';

  return {
    frame: f,
    u,
    frames,
    lastFrame: last,
    contactFrame,
    transferFrame,
    phase,
    contact: f === contactFrame,
    transfer: f === transferFrame,
    owner: f >= transferFrame ? 'receiver' : 'sender',
    contactPulse,
    transferPulse,
  };
}

/* ── pose keys ─────────────────────────────────────────────────────────── */
/*
 * `innerDX` is measured from the actor's centre toward its partner (the facing
 * sign is applied later), so one table serves both variants. `innerDY` is an
 * offset from BODY_Y. Angles are degrees from straight down; positive angles
 * lean toward the partner.
 */
const POSE_DEFAULT = {
  lean: 0,
  squash: 1,
  innerDX: 230,
  innerDY: 110,
  outerUpper: -20,
  outerLower: -4,
  innerLegUpper: 0,
  innerLegLower: 0,
  outerLegUpper: 0,
  outerLegLower: 0,
  open: 0.15,
  propAngle: 45,
};

const SENDER_KEYS = [
  { u: 0, innerDX: 245, innerDY: 125, lean: -2, open: 0.15, propAngle: 58, outerUpper: -20, outerLower: -4, innerLegUpper: 0, innerLegLower: 0, outerLegUpper: 0, outerLegLower: 0 },
  { u: 0.1, innerDX: 270, innerDY: 20, lean: 2, open: 0.7, propAngle: 30, outerUpper: -18, outerLower: -2, innerLegUpper: -4, innerLegLower: 2, outerLegUpper: 4, outerLegLower: -2 },
  { u: 0.3, innerDX: 390, innerDY: 15, lean: 7, open: 0.75, propAngle: 10, outerUpper: -18, outerLower: 12, innerLegUpper: -5, innerLegLower: 3, outerLegUpper: 5, outerLegLower: -3 },
  { u: 0.34, innerDX: 390, innerDY: 15, lean: 8, squash: 0.97, open: 0.12, propAngle: 0 },
  { u: 0.44, innerDX: 390, innerDY: 15, lean: 7, squash: 1, open: 0.1, propAngle: 0 },
  { u: 0.56, innerDX: 250, innerDY: 70, lean: 1, open: 0.9, propAngle: 20, outerUpper: -20, outerLower: 0 },
  { u: 0.7, innerDX: 245, innerDY: 125, lean: -2, open: 0.2, propAngle: 50, outerUpper: -20, outerLower: -4 },
  { u: 0.84, innerDX: 245, innerDY: 125, lean: -1, open: 0.15, propAngle: 58, outerUpper: -20, outerLower: -4 },
  { u: 1, innerDX: 245, innerDY: 125, lean: -1, open: 0.15, propAngle: 58, outerUpper: -20, outerLower: -4 },
];

const RECEIVER_KEYS = [
  { u: 0, innerDX: 250, innerDY: 120, lean: 2, open: 0.15, propAngle: 45, outerUpper: -20, outerLower: -4, innerLegUpper: 0, innerLegLower: 0, outerLegUpper: 0, outerLegLower: 0 },
  { u: 0.1, innerDX: 290, innerDY: 40, lean: 3, open: 0.75, propAngle: 40, outerUpper: -18, outerLower: -2, innerLegUpper: -4, innerLegLower: 2, outerLegUpper: 4, outerLegLower: -2 },
  { u: 0.3, innerDX: 390, innerDY: 15, lean: 5, open: 0.8, propAngle: 20, outerUpper: 14, outerLower: -8, innerLegUpper: -5, innerLegLower: 3, outerLegUpper: 5, outerLegLower: -3 },
  { u: 0.34, innerDX: 390, innerDY: 15, lean: 6, squash: 0.97, open: 0.1, propAngle: 0 },
  { u: 0.44, innerDX: 390, innerDY: 15, lean: 5, squash: 1, open: 0, propAngle: 0 },
  { u: 0.56, innerDX: 330, innerDY: 45, lean: 3, open: 0, propAngle: 10 },
  { u: 0.7, innerDX: 330, innerDY: -190, lean: -3, open: 0, propAngle: 80, outerUpper: 18, outerLower: -10 },
  { u: 0.84, innerDX: 330, innerDY: -182, lean: -2, open: 0, propAngle: 74 },
  { u: 1, innerDX: 330, innerDY: -185, lean: -2, open: 0, propAngle: 74 },
];

function lerpPose(a, b, t) {
  const out = {};
  for (const key of Object.keys(POSE_DEFAULT)) {
    const va = a[key] ?? POSE_DEFAULT[key];
    const vb = b[key] ?? POSE_DEFAULT[key];
    out[key] = typeof va === 'number' ? lerp(va, vb, t) : t < 0.5 ? va : vb;
  }
  return out;
}

function samplePose(keys, u) {
  if (u <= keys[0].u) return lerpPose(keys[0], keys[0], 0);
  for (let i = 0; i < keys.length - 1; i += 1) {
    const a = keys[i];
    const b = keys[i + 1];
    if (u < b.u) {
      const t = (u - a.u) / (b.u - a.u);
      return lerpPose(a, b, (EASE[b.ease ?? 'inOut'] ?? EASE.inOut)(t));
    }
  }
  const last = keys[keys.length - 1];
  return lerpPose(last, last, 0);
}

/* ── silhouettes ───────────────────────────────────────────────────────── */

function starPath(ctx) {
  const R = 200;
  const r = 96;
  ctx.beginPath();
  for (let i = 0; i < 16; i += 1) {
    const radius = i % 2 === 0 ? R : r;
    const angle = -Math.PI / 2 + (i * TAU) / 16;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function cloudPath(ctx) {
  const discs = [
    [0, -14, 112],
    [-78, 16, 78],
    [78, 16, 78],
    [-46, -60, 66],
    [46, -60, 66],
  ];
  for (const [x, y, r] of discs) {
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, TAU);
  }
  // A soft rounded base keeps the lobes from looking like floating circles.
  ctx.roundRect(-110, 2, 220, 96, 48);
}

function gearPath(ctx) {
  const R = 200;
  const r = 154;
  const teeth = 10;
  let first = true;
  ctx.beginPath();
  for (let i = 0; i < teeth; i += 1) {
    const a0 = (i * TAU) / teeth;
    const step = TAU / teeth;
    const pts = [
      [a0 - step * 0.24, R],
      [a0 - step * 0.12, R],
      [a0 + step * 0.12, R],
      [a0 + step * 0.24, R],
      [a0 + step * 0.34, r],
      [a0 + step * 0.66, r],
    ];
    for (const [angle, radius] of pts) {
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      if (first) {
        ctx.moveTo(x, y);
        first = false;
      } else ctx.lineTo(x, y);
    }
  }
  ctx.closePath();
}

function drawShape(ctx, shape, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  if (shape === 'star') starPath(ctx);
  else if (shape === 'cloud') cloudPath(ctx);
  else gearPath(ctx);
  ctx.fill();
}

function anchorsFor(shape, facing) {
  const s = SHAPES[shape];
  return {
    innerArm: [facing * s.armX, s.armY],
    outerArm: [-facing * s.armX, s.armY],
    innerLeg: [facing * s.legX, s.legY],
    outerLeg: [-facing * s.legX, s.legY],
  };
}

function transformLocal(point, originX, originY, rotation, squash) {
  const sx = 1 + (1 - squash) * 0.25;
  const px = point[0] * sx;
  const py = point[1] * squash;
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  return [originX + px * c - py * s, originY + px * s + py * c];
}

/* ── limbs and props ───────────────────────────────────────────────────── */

function chain(anchor, upper, lower, upperLength, lowerLength, facing) {
  const dir = (deg) => [Math.sin(deg * D2R) * facing, Math.cos(deg * D2R)];
  const a = dir(upper);
  const b = dir(lower);
  const joint = [anchor[0] + a[0] * upperLength, anchor[1] + a[1] * upperLength];
  const end = [joint[0] + b[0] * lowerLength, joint[1] + b[1] * lowerLength];
  return [anchor, joint, end];
}

function ik2(anchor, target, upperLength, lowerLength) {
  let dx = target[0] - anchor[0];
  let dy = target[1] - anchor[1];
  let distance = Math.hypot(dx, dy);
  const max = upperLength + lowerLength - 0.5;
  let hand = target;
  if (distance > max) {
    const k = max / distance;
    dx *= k;
    dy *= k;
    distance = max;
    hand = [anchor[0] + dx, anchor[1] + dy];
  }
  distance = Math.max(1, distance);
  const base = Math.atan2(dx, dy);
  const cosOffset = clamp((upperLength * upperLength + distance * distance - lowerLength * lowerLength) / (2 * upperLength * distance), -1, 1);
  const offset = Math.acos(cosOffset);
  const e1 = [anchor[0] + Math.sin(base + offset) * upperLength, anchor[1] + Math.cos(base + offset) * upperLength];
  const e2 = [anchor[0] + Math.sin(base - offset) * upperLength, anchor[1] + Math.cos(base - offset) * upperLength];
  const elbow = e1[1] >= e2[1] ? e1 : e2;
  return [anchor, elbow, hand];
}

function drawLimb(ctx, points, color, upperWidth, lowerWidth, endRadius) {
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineWidth = upperWidth;
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  ctx.lineTo(points[1][0], points[1][1]);
  ctx.stroke();
  ctx.lineWidth = lowerWidth;
  ctx.beginPath();
  ctx.moveTo(points[1][0], points[1][1]);
  ctx.lineTo(points[2][0], points[2][1]);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(points[2][0], points[2][1], endRadius, 0, TAU);
  ctx.fill();
}

function drawHand(ctx, point, color, open, field) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(point[0], point[1], ARM.hand, 0, TAU);
  ctx.fill();
  if (open > 0.45) {
    ctx.fillStyle = field;
    ctx.beginPath();
    ctx.arc(point[0], point[1], 8 + open * 5, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(point[0], point[1], 14 + open * 4, Math.PI * 0.15, Math.PI * 1.85);
    ctx.stroke();
  }
}

function drawProp(ctx, kind, point, angle, fill, ownerColor, flash) {
  ctx.save();
  ctx.translate(point[0], point[1]);
  ctx.rotate(angle * D2R);
  if (kind === 'baton') {
    const length = 200;
    const width = 44;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.roundRect(-length / 2, -width / 2, length, width, width / 2);
    ctx.fill();
    ctx.fillStyle = ownerColor;
    ctx.beginPath();
    ctx.roundRect(-length / 2 + 10, -width / 2 + 7, 22, width - 14, 8);
    ctx.roundRect(length / 2 - 32, -width / 2 + 7, 22, width - 14, 8);
    ctx.fill();
    ctx.strokeStyle = shade(fill, 0.82);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-length * 0.18, 0);
    ctx.lineTo(length * 0.18, 0);
    ctx.stroke();
  } else {
    const radius = 58;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = ownerColor;
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.arc(0, 0, radius - 8, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = shade(fill, 0.85);
    ctx.beginPath();
    ctx.arc(-15, 0, 6, 0, TAU);
    ctx.arc(15, 0, 6, 0, TAU);
    ctx.fill();
  }
  if (flash > 0) {
    ctx.strokeStyle = `rgba(255,255,255,${0.85 * flash})`;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(0, 0, kind === 'baton' ? 118 : 70, 0, TAU);
    ctx.stroke();
  }
  ctx.restore();
}

/* ── stage ─────────────────────────────────────────────────────────────── */

function setupCanvas(canvas, ctx, palette) {
  const width = Math.max(2, Math.round(ctx.width));
  const height = Math.max(2, Math.round(ctx.height));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const c = canvas.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, width, height);
  c.fillStyle = palette.field;
  c.fillRect(0, 0, width, height);
  const scale = Math.min(width / W, height / H);
  c.setTransform(scale, 0, 0, scale, (width - W * scale) / 2, (height - H * scale) / 2);
  return c;
}

function drawStage(ctx, seed, palette) {
  ctx.fillStyle = palette.field;
  ctx.fillRect(0, 0, W, H);

  // A quiet ground band and one line; no event grid or emblem language.
  ctx.fillStyle = palette.ground;
  ctx.fillRect(0, GROUND, W, H - GROUND);
  ctx.fillStyle = palette.line;
  ctx.fillRect(0, GROUND - 3, W, 3);

  const random = hash32(seed * 2654435761 + 17);
  ctx.fillStyle = alpha(palette.ink, 0.035);
  for (let i = 0; i < 70; i += 1) {
    const x = random() * W;
    const y = random() * H;
    const r = 1 + random() * 1.6;
    ctx.fillRect(x, y, r, r);
  }
}

function drawShadow(ctx, x, squash, palette) {
  ctx.fillStyle = alpha(palette.ink, 0.1);
  ctx.beginPath();
  ctx.ellipse(x, GROUND + 6, 188 * squash, 18, 0, 0, TAU);
  ctx.fill();
}

function drawActorBase(ctx, actor, pose, palette) {
  const { shape, x, facing, color } = actor;
  const rotation = facing * pose.lean * D2R;
  const origin = [x, BODY_Y];
  const local = anchorsFor(shape, facing);
  const legInner = transformLocal(local.innerLeg, origin[0], origin[1], rotation, pose.squash);
  const legOuter = transformLocal(local.outerLeg, origin[0], origin[1], rotation, pose.squash);
  const far = shade(color, 0.72);

  drawLimb(ctx, chain(legOuter, pose.outerLegUpper, pose.outerLegLower, SHAPES[shape].upper, SHAPES[shape].lower, facing), far, LEG.width, LEG.shin, LEG.foot);
  drawLimb(ctx, chain(legInner, pose.innerLegUpper, pose.innerLegLower, SHAPES[shape].upper, SHAPES[shape].lower, facing), color, LEG.width, LEG.shin, LEG.foot);

  ctx.save();
  ctx.translate(origin[0], origin[1]);
  ctx.rotate(rotation);
  ctx.scale(1 + (1 - pose.squash) * 0.25, pose.squash);
  ctx.translate(0, 5);
  drawShape(ctx, shape, shade(color, 0.8));
  ctx.translate(0, -5);
  drawShape(ctx, shape, color);
  ctx.restore();

  const outerArm = transformLocal(local.outerArm, origin[0], origin[1], rotation, pose.squash);
  const outer = chain(outerArm, pose.outerUpper, pose.outerLower, ARM.upper, ARM.lower, facing);
  drawLimb(ctx, outer, far, 36, 32, ARM.hand);
}

function drawActorInner(ctx, actor, chainPoints, open, field) {
  const { color } = actor;
  drawLimb(ctx, chainPoints, color, 38, 34, ARM.hand);
  drawHand(ctx, chainPoints[2], color, open, field);
}

function actorHand(actor, pose) {
  const { shape, x, facing } = actor;
  const rotation = facing * pose.lean * D2R;
  const local = anchorsFor(shape, facing);
  const anchor = transformLocal(local.innerArm, x, BODY_Y, rotation, pose.squash);
  const target = [x + facing * pose.innerDX, BODY_Y + pose.innerDY];
  return ik2(anchor, target, SHAPES[shape].armUpper, SHAPES[shape].armLower);
}

/* ── render ────────────────────────────────────────────────────────────── */

function resolveConfig(params = {}) {
  const variant = Object.prototype.hasOwnProperty.call(VARIANTS, params.variant) ? params.variant : 'star-disc';
  const base = VARIANTS[variant];
  const frames = Number.isInteger(params.frames) ? params.frames : DEFAULT_FRAMES;
  return {
    variant,
    senderShape: base.senderShape,
    receiverShape: base.receiverShape,
    prop: base.prop,
    frames,
    contactFrame: Number.isInteger(params.contactFrame) ? params.contactFrame : undefined,
    transferFrame: Number.isInteger(params.transferFrame) ? params.transferFrame : undefined,
    palette: { ...BASE_PALETTE, ...base.palette, ...(params.palette ?? {}) },
  };
}

export function renderPictogram(canvas, ctx) {
  const cfg = resolveConfig(ctx.params ?? {});
  const clock = handoffAt(ctx.frame, {
    frames: cfg.frames,
    contactFrame: cfg.contactFrame,
    transferFrame: cfg.transferFrame,
  });
  const c = setupCanvas(canvas, ctx, cfg.palette);
  drawStage(c, ctx.seed ?? 1, cfg.palette);

  const mirror = cfg.variant === 'cloud-baton';
  const sender = {
    shape: cfg.senderShape,
    x: mirror ? 1350 : 570,
    facing: mirror ? -1 : 1,
    color: cfg.palette.sender,
  };
  const receiver = {
    shape: cfg.receiverShape,
    x: mirror ? 570 : 1350,
    facing: mirror ? 1 : -1,
    color: cfg.palette.receiver,
  };

  const senderPose = samplePose(SENDER_KEYS, clock.u);
  const receiverPose = samplePose(RECEIVER_KEYS, clock.u);
  const senderHand = actorHand(sender, senderPose);
  const receiverHand = actorHand(receiver, receiverPose);

  drawShadow(c, sender.x, 1 + (1 - senderPose.squash) * 0.2, cfg.palette);
  drawShadow(c, receiver.x, 1 + (1 - receiverPose.squash) * 0.2, cfg.palette);

  drawActorBase(c, sender, senderPose, cfg.palette);
  drawActorBase(c, receiver, receiverPose, cfg.palette);

  // The prop sits in front of both bodies but behind both near hands.
  const transferStart = clock.contactFrame;
  const transferSpan = Math.max(1, clock.transferFrame - transferStart);
  const q = clamp((clock.frame - transferStart) / transferSpan);
  const senderGrip = [senderHand[2][0] + sender.facing * 10, senderHand[2][1]];
  const receiverGrip = [receiverHand[2][0] + receiver.facing * 10, receiverHand[2][1]];
  const propPoint = mixPoint(senderGrip, receiverGrip, q);
  const ownerColor = clock.owner === 'receiver' ? cfg.palette.receiver : cfg.palette.sender;
  const holderPose = clock.owner === 'receiver' ? receiverPose : senderPose;
  drawProp(
    c,
    cfg.prop,
    propPoint,
    holderPose.propAngle,
    cfg.palette.token,
    ownerColor,
    clock.transferPulse,
  );

  if (clock.contactPulse > 0) {
    const p = 1 - clock.contactPulse;
    const centre = mixPoint(senderHand[2], receiverHand[2], 0.5);
    c.save();
    for (let i = 0; i < 2; i += 1) {
      c.strokeStyle = alpha(cfg.palette.ink, (1 - p) * (0.32 - i * 0.1));
      c.lineWidth = 4 - i;
      c.beginPath();
      c.arc(centre[0], centre[1], 58 + i * 34 + p * 92, 0, TAU);
      c.stroke();
    }
    c.restore();
  }

  drawActorInner(c, sender, senderHand, senderPose.open, cfg.palette.field);
  drawActorInner(c, receiver, receiverHand, receiverPose.open, cfg.palette.field);
}
