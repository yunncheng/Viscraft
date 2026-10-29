// cel.mjs — a small reusable cel-layering material/styling module for a browser Source.
//
// It draws deliberately CEL-LAYERED subjects: a flat base, a hard offset shadow,
// a highlight, and an inked outline. This is an ORDERED DRAW STACK, not a noise
// or posterize filter applied after the fact:
//
//     CEL_LAYERS = ['base', 'shadow', 'highlight', 'line']
//
// The whole craft point (see skills/viscraft/references/craft/motion-cinematography.md
// §"Performance and camera clocks" and code-visuals.md §"Build the Look from
// mechanisms") is that the SUBJECT POSE is quantized to a held cel cadence while
// LIGHTING and the hand-inked REGISTRATION are NOT:
//
//   * poseTime = floor(time * poseRate) / poseRate   — stepped subject poses
//   * lightAzimuth = shadowAzimuth + lightDrift * time — the ACTUAL frame time
//   * registration: a constant deliberate sub-pixel line/colour misregister
//
// Static hatch/stipple marks are drawn from a deterministic PRNG keyed by
// (seed, markIndex) and CACHED, so their placement is computed once and is
// byte-identical across frames — never re-rolled per frame.
//
// The module is plain ESM (browser + Node): the pure functions (normalizeParams,
// quantizePose, hash01, staticMarks, subjectPose) run anywhere, while renderCel
// needs a canvas. Two DIFFERENT subjects are parameterized from the same module.

export const CEL_LAYERS = ['base', 'shadow', 'highlight', 'line'];

export const SUBJECTS = ['figure', 'vehicle'];
export const LAYOUTS = ['wide', 'portrait', 'square'];

// `layout` is a framing hint: it scales the subject within the frame and moves
// its ground line, so the same subject reads at different aspect ratios.
const LAYOUT_FRAMING = {
  wide: { scale: 1, anchor: 0.86 },
  square: { scale: 0.92, anchor: 0.84 },
  portrait: { scale: 0.82, anchor: 0.82 },
};

export const DEFAULT_PALETTE = {
  bg: '#20222c',
  base: '#ecdcbf',
  shadow: '#7d5a86',
  shadowOpacity: 0.45,
  highlight: '#fff4d6',
  highlightOpacity: 0.5,
  line: '#241d2b',
  ink: '#3a2f45',
};

export const DEFAULT_PARAMS = {
  subject: 'figure',
  layout: 'wide',
  poseRate: 8,
  lineWidth: 3,
  shadowAzimuth: 2.4,
  shadowLength: 0.9,
  registration: { dx: 0.8, dy: -0.6 },
  lightDrift: 0.25,
  motion: 1,
  speed: 1.15,
  hatchCount: 24,
  palette: { ...DEFAULT_PALETTE },
};

const TAU = Math.PI * 2;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function number(value, fallback, label, { min, max, integer } = {}) {
  let v = value === undefined ? fallback : value;
  if (!finite(v)) throw new Error(`cel: ${label} must be a finite number`);
  if (integer && !Number.isInteger(v)) throw new Error(`cel: ${label} must be an integer`);
  if (min !== undefined && v < min) throw new Error(`cel: ${label} must be >= ${min}`);
  if (max !== undefined && v > max) throw new Error(`cel: ${label} must be <= ${max}`);
  return v;
}

function colour(value, fallback, label) {
  const v = value === undefined ? fallback : value;
  if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) throw new Error(`cel: ${label} must be a #rrggbb colour`);
  return v;
}

/** Validate recognized Source `params`, fill defaults, and reject invalid values. */
export function normalizeParams(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('cel: params must be an object');
  const subject = raw.subject === undefined ? DEFAULT_PARAMS.subject : raw.subject;
  if (!SUBJECTS.includes(subject)) throw new Error(`cel: unknown subject "${subject}"; expected one of ${SUBJECTS.join(', ')}`);
  const layout = raw.layout === undefined ? DEFAULT_PARAMS.layout : raw.layout;
  if (!LAYOUTS.includes(layout)) throw new Error(`cel: unknown layout "${layout}"; expected one of ${LAYOUTS.join(', ')}`);
  const registration = raw.registration === undefined ? DEFAULT_PARAMS.registration : raw.registration;
  if (registration === null || typeof registration !== 'object') throw new Error('cel: registration must be an object { dx, dy }');
  const paletteIn = raw.palette === undefined ? {} : raw.palette;
  if (paletteIn === null || typeof paletteIn !== 'object') throw new Error('cel: palette must be an object');
  const palette = {
    bg: colour(paletteIn.bg, DEFAULT_PALETTE.bg, 'palette.bg'),
    base: colour(paletteIn.base, DEFAULT_PALETTE.base, 'palette.base'),
    shadow: colour(paletteIn.shadow, DEFAULT_PALETTE.shadow, 'palette.shadow'),
    highlight: colour(paletteIn.highlight, DEFAULT_PALETTE.highlight, 'palette.highlight'),
    line: colour(paletteIn.line, DEFAULT_PALETTE.line, 'palette.line'),
    ink: colour(paletteIn.ink, DEFAULT_PALETTE.ink, 'palette.ink'),
    shadowOpacity: number(paletteIn.shadowOpacity, DEFAULT_PALETTE.shadowOpacity, 'palette.shadowOpacity', { min: 0, max: 1 }),
    highlightOpacity: number(paletteIn.highlightOpacity, DEFAULT_PALETTE.highlightOpacity, 'palette.highlightOpacity', { min: 0, max: 1 }),
  };
  return {
    subject,
    layout,
    palette,
    poseRate: number(raw.poseRate, DEFAULT_PARAMS.poseRate, 'poseRate', { min: 1e-6 }),
    lineWidth: number(raw.lineWidth, DEFAULT_PARAMS.lineWidth, 'lineWidth', { min: 0 }),
    shadowAzimuth: number(raw.shadowAzimuth, DEFAULT_PARAMS.shadowAzimuth, 'shadowAzimuth'),
    shadowLength: number(raw.shadowLength, DEFAULT_PARAMS.shadowLength, 'shadowLength', { min: 0 }),
    registration: {
      dx: number(registration.dx, DEFAULT_PARAMS.registration.dx, 'registration.dx'),
      dy: number(registration.dy, DEFAULT_PARAMS.registration.dy, 'registration.dy'),
    },
    lightDrift: number(raw.lightDrift, DEFAULT_PARAMS.lightDrift, 'lightDrift'),
    motion: number(raw.motion, DEFAULT_PARAMS.motion, 'motion', { min: 0 }),
    speed: number(raw.speed, DEFAULT_PARAMS.speed, 'speed', { min: 1e-6 }),
    hatchCount: number(raw.hatchCount, DEFAULT_PARAMS.hatchCount, 'hatchCount', { min: 0, max: 400, integer: true }),
  };
}

/** The cel cadence: hold the subject pose for 1/poseRate of a second. */
export function quantizePose(time, poseRate) {
  if (!finite(time)) throw new Error('cel: time must be a finite number');
  if (!finite(poseRate) || poseRate <= 0) throw new Error('cel: poseRate must be a positive number');
  return Math.floor(time * poseRate) / poseRate;
}

/** Deterministic hash-based PRNG in [0,1) keyed by (seed, index). */
export function hash01(seed, index) {
  const x = Math.sin(seed * 127.1 + index * 311.7 + 74.7) * 43758.5453;
  return x - Math.floor(x);
}

const MARK_CACHE = new Map();

/**
 * Static hatch/stipple marks keyed by (seed, index), computed ONCE and cached.
 * The returned array is stable for a given seed/count, so two frames never
 * re-roll mark placement.
 */
export function staticMarks(seed, count) {
  if (!finite(seed)) throw new Error('cel: seed must be a finite number');
  if (!Number.isInteger(count) || count < 0) throw new Error('cel: mark count must be a non-negative integer');
  const key = `${seed}:${count}`;
  const cached = MARK_CACHE.get(key);
  if (cached) return cached;
  const marks = [];
  for (let i = 0; i < count; i++) {
    marks.push({
      u: 0.05 + hash01(seed, i * 5 + 1) * 0.9,
      v: 0.05 + hash01(seed, i * 5 + 2) * 0.9,
      len: 0.02 + hash01(seed, i * 5 + 3) * 0.05,
      tilt: (hash01(seed, i * 5 + 4) - 0.5) * 0.9,
      weight: 0.4 + hash01(seed, i * 5 + 5) * 0.6,
    });
  }
  MARK_CACHE.set(key, marks);
  return marks;
}

// ---------------------------------------------------------------------------
// Pose: pure geometry, no time/light coupling. Two parameterized subjects.
// ---------------------------------------------------------------------------

function figurePose(poseT, params, width, u, groundY) {
  const cx = width * 0.5;
  const m = params.motion;
  const phase = poseT * params.speed * TAU;
  const swing = 0.5 * m;
  const bob = u * 0.014 * m * (0.5 + 0.5 * Math.cos(phase * 2));
  const legLen = u * 0.34;
  const torsoLen = u * 0.26;
  const hipY = groundY - legLen * 0.9 - bob;
  const shoulder = { x: cx + u * 0.006, y: hipY - torsoLen };
  const headR = u * 0.072;
  const head = { x: shoulder.x + u * 0.006, y: shoulder.y - headR * 1.3 };
  const legSpread = u * 0.03;
  const legs = [0, 1].map((side) => {
    const hipX = cx - u * 0.012 + side * legSpread;
    const ang = swing * Math.sin(phase + side * Math.PI);
    const knee = { x: hipX + legLen * 0.5 * Math.sin(ang), y: hipY + legLen * 0.5 * Math.cos(ang) };
    const footX = hipX + legLen * Math.sin(ang);
    const footY = Math.min(groundY, hipY + legLen * Math.cos(ang));
    const foot = { x: footX, y: footY };
    const toe = { x: footX + u * 0.05, y: footY };
    return { hip: { x: hipX, y: hipY }, knee, foot, toe };
  });
  const arms = [0, 1].map((side) => {
    const ang = 0.5 + swing * 1.4 * Math.sin(phase + (side ? 0 : Math.PI));
    const elbow = { x: shoulder.x + torsoLen * 0.42 * Math.sin(ang), y: shoulder.y + torsoLen * 0.36 * Math.cos(ang) };
    const hand = { x: shoulder.x + torsoLen * 0.72 * Math.sin(ang), y: shoulder.y + torsoLen * 0.66 * Math.cos(ang) };
    return { elbow, hand };
  });
  const hip = { x: cx - u * 0.012, y: hipY };
  const probe = [head, { x: head.x, y: head.y - headR }, shoulder, hip, ...legs.map((l) => l.foot), ...legs.map((l) => l.toe), ...arms.map((a) => a.hand)];
  return { kind: 'figure', u, groundY, hip, hipY, shoulder, head, headR, legs, arms, probe };
}

function vehiclePose(poseT, params, width, u, groundY) {
  const cx = width * 0.5;
  const wheelR = u * 0.14;
  const base = u * 0.62;
  const wheelY = groundY - wheelR;
  const wheelRear = { x: cx - base * 0.5, y: wheelY };
  const wheelFront = { x: cx + base * 0.5, y: wheelY };
  // Rolling follows travelled distance / radius (quantized with the pose).
  const distance = params.speed * u * poseT;
  const rotation = distance / wheelR;
  const bob = params.motion * u * 0.008 * Math.sin(poseT * params.speed * 7);
  const bodyBottom = wheelY - wheelR * 0.15 + bob;
  const hw = base * 0.56;
  const bodyTop = bodyBottom - wheelR * 1.15;
  const chassis = [
    { x: cx - hw, y: bodyTop },
    { x: cx + hw, y: bodyTop },
    { x: cx + hw, y: bodyBottom },
    { x: cx - hw, y: bodyBottom },
  ];
  const cabW = hw * 0.9;
  const cabH = wheelR * 0.95;
  const cabin = [
    { x: cx - hw * 0.45, y: bodyTop - cabH },
    { x: cx - hw * 0.45 + cabW, y: bodyTop - cabH },
    { x: cx - hw * 0.45 + cabW, y: bodyTop },
    { x: cx - hw * 0.45, y: bodyTop },
  ];
  const probe = [wheelRear, wheelFront, { x: cx - hw, y: bodyTop - cabH }, { x: cx + hw, y: bodyBottom }];
  return { kind: 'vehicle', u, groundY, wheelR, wheelRear, wheelFront, rotation, chassis, cabin, bodyTop, bodyBottom, bob, probe };
}

/** Subject geometry for a quantized poseTime. Pure; safe to call in Node. */
export function subjectPose(subject, poseTime, params, width, height) {
  if (!SUBJECTS.includes(subject)) throw new Error(`cel: unknown subject "${subject}"`);
  if (!finite(poseTime)) throw new Error('cel: poseTime must be a finite number');
  const framing = LAYOUT_FRAMING[params.layout] ?? LAYOUT_FRAMING.wide;
  const u = Math.min(width, height) * framing.scale;
  if (!(u > 0)) throw new Error('cel: width and height must be > 0');
  const groundY = height * framing.anchor;
  return subject === 'figure' ? figurePose(poseTime, params, width, u, groundY) : vehiclePose(poseTime, params, width, u, groundY);
}

// ---------------------------------------------------------------------------
// Path builders — every subpath is traced with the SAME winding so a multi-part
// silhouette fills and clips as a clean union (no cancellation holes).
// ---------------------------------------------------------------------------

function capsule(g, ax, ay, bx, by, r) {
  g.moveTo(ax + r, ay);
  g.arc(ax, ay, r, 0, TAU);
  g.moveTo(bx + r, by);
  g.arc(bx, by, r, 0, TAU);
  const dx = bx - ax;
  const dy = by - ay;
  const d = Math.hypot(dx, dy) || 1;
  const nx = (-dy / d) * r;
  const ny = (dx / d) * r;
  g.moveTo(ax + nx, ay + ny);
  g.lineTo(ax - nx, ay - ny);
  g.lineTo(bx - nx, by - ny);
  g.lineTo(bx + nx, by + ny);
  g.closePath();
}

function circle(g, cx, cy, r) {
  g.moveTo(cx + r, cy);
  g.arc(cx, cy, r, 0, TAU);
}

function polygon(g, points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    area += p.x * q.y - q.x * p.y;
  }
  const pts = area < 0 ? [...points].reverse() : points;
  g.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
  g.closePath();
}

function traceFigure(g, pose) {
  const u = pose.u;
  const legR = u * 0.03;
  const armR = u * 0.022;
  const torsoR = u * 0.072;
  for (const leg of pose.legs) {
    capsule(g, leg.hip.x, leg.hip.y, leg.knee.x, leg.knee.y, legR);
    capsule(g, leg.knee.x, leg.knee.y, leg.foot.x, leg.foot.y, legR * 0.9);
    capsule(g, leg.foot.x - u * 0.012, leg.foot.y, leg.toe.x, leg.toe.y, u * 0.018);
  }
  capsule(g, pose.hip.x, pose.hip.y, pose.shoulder.x, pose.shoulder.y, torsoR);
  for (const arm of pose.arms) {
    capsule(g, pose.shoulder.x, pose.shoulder.y, arm.elbow.x, arm.elbow.y, armR);
    capsule(g, arm.elbow.x, arm.elbow.y, arm.hand.x, arm.hand.y, armR * 0.85);
  }
  capsule(g, pose.shoulder.x, pose.shoulder.y, pose.head.x, pose.head.y, u * 0.028);
  circle(g, pose.head.x, pose.head.y, pose.headR);
}

function traceVehicle(g, pose) {
  polygon(g, pose.chassis);
  polygon(g, pose.cabin);
  circle(g, pose.wheelRear.x, pose.wheelRear.y, pose.wheelR);
  circle(g, pose.wheelFront.x, pose.wheelFront.y, pose.wheelR);
}

function traceSubject(g, subject, pose) {
  g.beginPath();
  if (subject === 'figure') traceFigure(g, pose);
  else traceVehicle(g, pose);
}

function poseBounds(pose) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pose.probe) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function poseCentroidExtent(bounds, angle) {
  const nx = Math.cos(angle);
  const ny = Math.sin(angle);
  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;
  const extent = Math.max(1e-3, 0.5 * (Math.abs(nx) * bounds.w + Math.abs(ny) * bounds.h));
  return { cx, cy, nx, ny, extent };
}

/** A large rectangle in the frame whose x-axis is `angle`, spanning x in [x0,x0+w]. */
function rectCorners(cx, cy, angle, x0, w, half) {
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const P = (x, y) => ({ x: cx + x * ca - y * sa, y: cy + x * sa + y * ca });
  return [P(x0, -half), P(x0 + w, -half), P(x0 + w, half), P(x0, half)];
}

function drawMarks(g, marks, bounds, params) {
  if (marks.length === 0) return;
  const s = Math.min(bounds.w, bounds.h);
  const base = params.shadowAzimuth + Math.PI / 2;
  for (const m of marks) {
    const x = bounds.x + m.u * bounds.w;
    const y = bounds.y + m.v * bounds.h;
    const len = m.len * s;
    const ang = base + m.tilt;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    g.stroke();
  }
}

function drawInterior(g, subject, pose, sw) {
  g.lineCap = 'round';
  g.lineJoin = 'round';
  if (subject === 'figure') {
    g.lineWidth = Math.max(0.5, sw * 0.7);
    // a belt across the torso and a cuff on each sleeve — deliberate ink marks
    const t = pose.u * 0.02;
    const beltY = pose.hip.y + (pose.shoulder.y - pose.hip.y) * 0.32;
    g.beginPath();
    g.moveTo(pose.hip.x - t * 3, beltY);
    g.lineTo(pose.hip.x + t * 3, beltY);
    g.stroke();
    for (const arm of pose.arms) {
      g.beginPath();
      g.moveTo(arm.elbow.x - t, arm.elbow.y);
      g.lineTo(arm.elbow.x + t, arm.elbow.y);
      g.stroke();
    }
  } else {
    g.lineWidth = Math.max(0.5, sw * 0.55);
    for (const wheel of [pose.wheelRear, pose.wheelFront]) {
      g.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = pose.rotation + (i * TAU) / 6;
        g.moveTo(wheel.x, wheel.y);
        g.lineTo(wheel.x + Math.cos(a) * pose.wheelR * 0.86, wheel.y + Math.sin(a) * pose.wheelR * 0.86);
      }
      g.stroke();
      g.beginPath();
      g.arc(wheel.x, wheel.y, pose.wheelR * 0.16, 0, TAU);
      g.stroke();
    }
    // cabin window line + headlight
    const c = pose.cabin;
    const wy = c[0].y + (c[3].y - c[0].y) * 0.55;
    g.beginPath();
    g.moveTo(c[0].x + pose.u * 0.02, wy);
    g.lineTo(c[1].x - pose.u * 0.02, wy);
    g.stroke();
    g.beginPath();
    g.arc(pose.chassis[1].x - pose.u * 0.02, pose.bodyTop + pose.u * 0.02, pose.u * 0.012, 0, TAU);
    g.stroke();
  }
}

let SCRATCH = null;
function scratchCanvas(width, height) {
  if (!SCRATCH) SCRATCH = document.createElement('canvas');
  if (SCRATCH.width !== width) SCRATCH.width = width;
  if (SCRATCH.height !== height) SCRATCH.height = height;
  return SCRATCH;
}

/**
 * Draw one deterministic frame. `ctx` is the CodeScene render argument:
 * { frame, time, fps, width, height, seed, params, bindings }.
 */
export function renderCel(canvas, ctx) {
  if (!canvas || typeof canvas.getContext !== 'function') throw new Error('cel: renderCel needs a canvas element');
  const params = normalizeParams(ctx.params ?? {});
  const width = Math.max(1, Math.floor(ctx.width ?? canvas.width));
  const height = Math.max(1, Math.floor(ctx.height ?? canvas.height));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const g = canvas.getContext('2d');
  const seed = finite(ctx.seed) ? ctx.seed : 0;
  const time = finite(ctx.time) ? ctx.time : 0;

  const poseTime = quantizePose(time, params.poseRate);
  const lightAzimuth = params.shadowAzimuth + params.lightDrift * time; // ACTUAL frame time
  const pose = subjectPose(params.subject, poseTime, params, width, height);
  const u = pose.u;
  const sw = Math.max(0.5, params.lineWidth * (u / 400)); // size-independent weight
  const marks = staticMarks(seed, params.hatchCount);
  const bounds = poseBounds(pose);
  // The lit axis points TOWARD the light; the shadow is cast to the opposite
  // side. A hard terminator across the form is what makes it read as cel.
  const lightAngle = lightAzimuth + Math.PI;
  const { cx, cy, extent } = poseCentroidExtent(bounds, lightAngle);
  const shadowEdge = -(0.12 + 0.42 * params.shadowLength) * extent; // along +light axis
  const highlightEdge = 0.26 * extent;
  const reach = extent * 6 + Math.hypot(width, height);
  const shadowRect = rectCorners(cx, cy, lightAngle, shadowEdge - reach, reach, reach);
  const highlightRect = rectCorners(cx, cy, lightAngle, highlightEdge, reach, reach);

  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.lineJoin = 'round';
  g.lineCap = 'round';

  // backdrop
  g.fillStyle = params.palette.bg;
  g.fillRect(0, 0, width, height);

  // --- layer 1: base ---
  traceSubject(g, params.subject, pose);
  g.fillStyle = params.palette.base;
  g.fill();

  // --- layer 2: shadow (hard lit/shadow split, clipped to the subject) + the
  // cached, seeded static hatching on the shadow side ---
  g.save();
  traceSubject(g, params.subject, pose);
  g.clip();
  g.beginPath();
  polygon(g, shadowRect);
  g.globalAlpha = params.palette.shadowOpacity;
  g.fillStyle = params.palette.shadow;
  g.fill();
  g.globalAlpha = Math.min(0.55, params.palette.shadowOpacity);
  g.strokeStyle = params.palette.ink;
  g.lineWidth = Math.max(0.4, sw * 0.35);
  drawMarks(g, marks, bounds, params); // clipped to subject ∩ shadow
  g.restore();

  // --- layer 3: highlight (lit side, clipped to the subject) ---
  g.save();
  traceSubject(g, params.subject, pose);
  g.clip();
  g.beginPath();
  polygon(g, highlightRect);
  g.globalAlpha = params.palette.highlightOpacity;
  g.fillStyle = params.palette.highlight;
  g.fill();
  g.restore();

  // --- layer 4: line (clean outer contour + interior ink), deliberately
  // misregistered for a hand-inked feel ---
  const off = scratchCanvas(width, height);
  const og = off.getContext('2d');
  og.setTransform(1, 0, 0, 1, 0, 0);
  og.globalAlpha = 1;
  og.globalCompositeOperation = 'source-over';
  og.clearRect(0, 0, width, height);
  og.lineJoin = 'round';
  og.lineCap = 'round';
  og.strokeStyle = params.palette.line;
  og.lineWidth = sw * 2; // outer half after the interior punch-out is `sw`
  traceSubject(og, params.subject, pose);
  og.stroke();
  og.globalCompositeOperation = 'destination-out';
  traceSubject(og, params.subject, pose);
  og.fill();
  og.globalCompositeOperation = 'source-over';

  g.globalAlpha = 1;
  g.save();
  g.translate(params.registration.dx, params.registration.dy);
  g.drawImage(off, 0, 0);
  g.strokeStyle = params.palette.ink;
  drawInterior(g, params.subject, pose, sw);
  g.restore();

  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  return { layers: CEL_LAYERS.slice(), poseTime, lightAzimuth, marks: marks.length };
}
