/**
 * Riso plate drawing (adapted).
 *
 * A drawing colour is a triple of ink densities [blue, yellow, pink] in 0..1.
 * The plate itself is ONE RGB canvas: R = blue density, G = yellow density,
 * B = pink density. Ordinary drawing is source-over, so a later shape covers
 * ink on all three plates ("knockout"). `over()` adds ink on the selected
 * channels only ("overprint").
 *
 * `layer(fn, halo)` first draws a separate transparent character layer, then
 * stamps a paper-white halo (zero ink on all plates) around it before compositing.
 * That halo is the separation you see around the rider; it is part of the print
 * language, not a post effect.
 *
 * Adapted from lemo-opuscar styles/risograph/demo/draw.js
 * @e3cb16f63768c68693ff0e15171d6e755457cc32 (LemoLab, MIT).
 */
export let W = 0;
export let H = 0;

/** The packed plate canvas: one RGB canvas carries all three separations. */
export const plate = document.createElement('canvas');
const plateContext = plate.getContext('2d', { alpha: false });
export let g = plateContext;

const layerCanvas = document.createElement('canvas');
const layerContext = layerCanvas.getContext('2d');

/** Size the packed plate and the knockout layer for one output frame. */
export function configurePlate(width, height) {
  if (W === width && H === height) return;
  W = width;
  H = height;
  plate.width = width;
  plate.height = height;
  layerCanvas.width = width;
  layerCanvas.height = height;
  resetTransform();
}

export function resetTransform() {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-over';
  g.filter = 'none';
}

/**
 * Draw `fn` on a transparent layer, stamp a zero-ink halo around it, then
 * composite the layer onto the packed plate.
 */
export function layer(fn, halo = 5) {
  layerContext.setTransform(1, 0, 0, 1, 0, 0);
  layerContext.globalCompositeOperation = 'source-over';
  layerContext.clearRect(0, 0, W, H);
  const previous = g;
  layerContext.setTransform(previous.getTransform());
  g = layerContext;
  try {
    fn();
  } finally {
    g = previous;
  }
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  if (halo > 0) {
    g.filter = 'brightness(0)';
    const steps = 12;
    for (let i = 0; i < steps; i++) {
      const angle = (i / steps) * Math.PI * 2;
      g.drawImage(layerCanvas, Math.cos(angle) * halo, Math.sin(angle) * halo);
    }
    g.filter = 'none';
  }
  g.drawImage(layerCanvas, 0, 0);
  g.restore();
}

/** Per-plate mask (0..1). The model-sheet view uses it to reveal plates one by one. */
export const S = { mask: [1, 1, 1] };

const to255 = (value) => Math.round(Math.max(0, Math.min(1, value)) * 255);
export const ink = (blue = 0, yellow = 0, pink = 0) =>
  `rgb(${to255(blue * S.mask[0])},${to255(yellow * S.mask[1])},${to255(pink * S.mask[2])})`;
export const inkA = (triple) => ink(triple[0], triple[1], triple[2]);

/** Clear the plate to "no ink" on all three separations. */
export function clear() {
  g.globalCompositeOperation = 'source-over';
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = 'rgb(0,0,0)';
  g.fillRect(0, 0, W, H);
}

/** Overprint: draw only into the selected ink channels, without knocking out. */
export function over(fn) {
  const previous = g.globalCompositeOperation;
  g.globalCompositeOperation = 'lighter';
  fn();
  g.globalCompositeOperation = previous;
}

export function fill(color) {
  g.fillStyle = Array.isArray(color) ? inkA(color) : color;
  g.fill();
}

export function circle(x, y, r, color) {
  g.beginPath();
  g.arc(x, y, Math.max(0.01, r), 0, Math.PI * 2);
  fill(color);
}

export function ellipse(x, y, rx, ry, rotation, color) {
  g.beginPath();
  g.ellipse(x, y, Math.max(0.01, rx), Math.max(0.01, ry), rotation, 0, Math.PI * 2);
  fill(color);
}

export function rect(x, y, w, h, color) {
  g.fillStyle = Array.isArray(color) ? inkA(color) : color;
  g.fillRect(x, y, w, h);
}

export function rrect(x, y, w, h, r, color) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
  fill(color);
}

export function poly(points, color) {
  g.beginPath();
  g.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) g.lineTo(points[i][0], points[i][1]);
  g.closePath();
  fill(color);
}

/** Smooth closed shape: quadratic curves through the midpoints of the points. */
export function blob(points, color) {
  const n = points.length;
  g.beginPath();
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const start = mid(points[n - 1], points[0]);
  g.moveTo(start[0], start[1]);
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const q = mid(p, points[(i + 1) % n]);
    g.quadraticCurveTo(p[0], p[1], q[0], q[1]);
  }
  g.closePath();
  fill(color);
}

export function line(points, width, color, cap = 'round') {
  g.beginPath();
  g.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) g.lineTo(points[i][0], points[i][1]);
  g.lineWidth = width;
  g.lineCap = cap;
  g.lineJoin = 'round';
  g.strokeStyle = Array.isArray(color) ? inkA(color) : color;
  g.stroke();
}

/** Smooth open curve through the points. */
export function curve(points, width, color) {
  g.beginPath();
  g.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length - 1; i++) {
    const q = [(points[i][0] + points[i + 1][0]) / 2, (points[i][1] + points[i + 1][1]) / 2];
    g.quadraticCurveTo(points[i][0], points[i][1], q[0], q[1]);
  }
  const last = points[points.length - 1];
  g.lineTo(last[0], last[1]);
  g.lineWidth = width;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.strokeStyle = Array.isArray(color) ? inkA(color) : color;
  g.stroke();
}

export function ring(x, y, r, width, color) {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.lineWidth = width;
  g.strokeStyle = Array.isArray(color) ? inkA(color) : color;
  g.stroke();
}

/** Capsule from a to b. `stripes` = [colourA, colourB, width] draws cross stripes. */
export function limb(a, b, width, color, stripes) {
  if (!stripes) {
    line([a, b], width, color);
    return;
  }
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy) || 1;
  const angle = Math.atan2(dy, dx);
  g.save();
  g.beginPath();
  g.moveTo(a[0], a[1]);
  g.lineTo(b[0], b[1]);
  g.lineWidth = width;
  g.lineCap = 'round';
  g.strokeStyle = inkA(stripes[0]);
  g.stroke();
  g.translate(a[0], a[1]);
  g.rotate(angle);
  g.beginPath();
  g.arc(0, 0, width / 2, Math.PI / 2, Math.PI * 1.5);
  g.lineTo(length, -width / 2);
  g.arc(length, 0, width / 2, -Math.PI / 2, Math.PI / 2);
  g.closePath();
  g.clip();
  g.fillStyle = inkA(stripes[1]);
  const stripeWidth = stripes[2];
  const offset = stripes[3] || 0;
  for (let x = -width + (offset % (stripeWidth * 2)); x < length + width; x += stripeWidth * 2)
    g.fillRect(x, -width, stripeWidth, width * 2);
  g.restore();
}

/** Two-bone IK: root, target, lengths, bend direction. */
export function ik(a, target, l1, l2, bend = 1) {
  const dx = target[0] - a[0];
  const dy = target[1] - a[1];
  let distance = Math.hypot(dx, dy);
  const max = l1 + l2 - 0.01;
  if (distance > max) distance = max;
  const base = Math.atan2(dy, dx);
  const cosA = (l1 * l1 + distance * distance - l2 * l2) / (2 * l1 * distance);
  const A = Math.acos(Math.max(-1, Math.min(1, cosA))) * bend;
  const joint = [a[0] + Math.cos(base + A) * l1, a[1] + Math.sin(base + A) * l1];
  const end = [a[0] + Math.cos(base) * distance, a[1] + Math.sin(base) * distance];
  return [joint, end];
}

export const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const rot2 = (p, a) => [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a)];
