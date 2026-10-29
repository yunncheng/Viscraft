/**
 * contact-study — the example's OWN picture scene.
 *
 * One original subject performs one readable operation: a counterweighted
 * striker swings down onto a marimba bar, the bar is struck on the authored
 * contact frame, and the arm rebounds while the bar rings. The bar is printed
 * C6 and the sound at that same sample is the recorded marimba C6, so the
 * picture and the sound are the same event rather than two timelines that
 * happen to overlap.
 *
 * The scene does not own the timing. `contact-timeline.mjs` is the single
 * authority for the contact frame, the approach and the rebound; this file maps
 * that record to pixels. Both this scene and the sound scene import the same
 * file, so a contact and its sound cannot drift apart.
 *
 * It composes three vendored author modules:
 *
 *  - `motion-camera.mjs` — the frame -> camera planner. The push-in onto the
 *    struck bar is a real `createCamera` keyframe track with log-space zoom; the
 *    swing and rebound use its named easings. The module plans, this scene draws.
 *  - `paint-material.mjs` — the material mechanisms: seeded paper grain, the
 *    hand-painted wood grain (`inkStroke`), the contact smudge (`inkBloom`), and
 *    the deformed silhouette helpers that keep the bar edges from looking
 *    machine-perfect.
 *  - `contact-timeline.mjs` (owned) — the event clock.
 *
 * The result is a deliberately stylised cel look: flat base, a hard light
 * terminator, an ink contour. It is not a character rig, not a physics
 * simulation, and not an art reference.
 *
 * The page contract is `window.viscraft = { render(ctx) }`, called once per
 * frame. Everything below is a pure function of `(frame, seed, params, frames)`:
 * no wall clock, no unseeded random, no state carried between frames.
 */

import { createCamera, ease, fitScale } from './motion-camera.mjs';
import {
  deform,
  hexToRgb,
  inkBloom,
  inkStroke,
  mulberry32,
  paperGrain,
  rectPoints,
  rgba,
} from './paint-material.mjs';
import { timelineFor } from './contact-timeline.mjs';

/** The reference world. The camera fits this to any output size. */
const STAGE = { width: 480, height: 270 };

/** The instrument, in world units. Three naturals; the middle one is struck. */
const BAR_TOP = 162;
const BAR_H = 15;
const BARS = [
  { id: 'G5', x: 148, w: 60, struck: false },
  { id: 'C6', x: 212, w: 60, struck: true },
  { id: 'E6', x: 276, w: 60, struck: false },
];

/** The striker: one rigid arm rotating about a fixed hub. */
const HUB = { x: 352, y: 70, r: 9 };
const ARM_LENGTH = 138.2;
const CONTACT_ANGLE = (144.1 * Math.PI) / 180;
const REST_ANGLE = (159.1 * Math.PI) / 180;
const HEAD_R = 12;

const DEFAULTS = {
  palette: {
    paper: '#e9dfca',
    paperDeep: '#d6c8ad',
    desk: '#cdbb9c',
    ink: '#2a2420',
    wood: '#b5763a',
    woodLight: '#cf9557',
    woodDark: '#7d4a20',
    metal: '#3d4a52',
    metalLight: '#66767f',
    metalDark: '#20272c',
    yarn: '#e6d0a3',
    yarnDark: '#b08c55',
    strike: '#fff3d8',
  },
  camera: { push: 1.2, focusX: 240, focusY: 172 },
};

function finite(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Merge the caller's params over the authored defaults, loud on bad shapes. */
export function normalizeParams(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const palette = { ...DEFAULTS.palette, ...(input.palette ?? {}) };
  for (const [key, value] of Object.entries(palette)) {
    if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value))
      throw new Error(`contact-scene: palette.${key} must be a #rrggbb string, got ${JSON.stringify(value)}`);
  }
  const camera = { ...DEFAULTS.camera, ...(input.camera ?? {}) };
  if (!(finite(camera.push, 0) > 1) || camera.push > 3)
    throw new Error('contact-scene: camera.push must be a number in (1, 3]');
  return { palette, camera };
}

/** A rounded rectangle as a reusable path (for clip/stroke/fill). */
function roundRect(x, y, w, h, r) {
  const path = new Path2D();
  const radius = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  path.moveTo(x + radius, y);
  path.lineTo(x + w - radius, y);
  path.quadraticCurveTo(x + w, y, x + w, y + radius);
  path.lineTo(x + w, y + h - radius);
  path.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  path.lineTo(x + radius, y + h);
  path.quadraticCurveTo(x, y + h, x, y + h - radius);
  path.lineTo(x, y + radius);
  path.quadraticCurveTo(x, y, x + radius, y);
  path.closePath();
  return path;
}

function polygonPath(points) {
  const path = new Path2D();
  points.forEach((point, index) => (index === 0 ? path.moveTo(point[0], point[1]) : path.lineTo(point[0], point[1])));
  path.closePath();
  return path;
}

/**
 * A cel fill: flat base, a hard shadow half-plane clipped to the shape (not a
 * gradient), then the ink contour. `shade` is the alpha of the terminator.
 */
function celFill(g, path, box, colors, { light = 0.55, shade = 1, contour = 1.6 } = {}) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const span = Math.max(box.w, box.h) * 1.6;
  g.fillStyle = colors.base;
  g.fill(path);
  if (shade > 0) {
    g.save();
    g.clip(path);
    g.translate(cx, cy);
    g.rotate(light);
    g.globalAlpha = shade;
    g.fillStyle = colors.shadow;
    g.fillRect(-span, 0, span * 2, span);
    g.globalAlpha = 1;
    g.restore();
  }
  g.strokeStyle = colors.ink;
  g.lineWidth = contour;
  g.lineJoin = 'round';
  g.stroke(path);
}

function drawBackground(g, width, height, palette) {
  const paper = hexToRgb(palette.paper);
  g.fillStyle = palette.paper;
  g.fillRect(0, 0, width, height);
  // A soft table plane behind the instrument, not a second scene.
  const table = g.createLinearGradient(0, height * 0.55, 0, height);
  table.addColorStop(0, rgba(hexToRgb(palette.paperDeep), 0));
  table.addColorStop(1, rgba(hexToRgb(palette.desk), 0.5));
  g.fillStyle = table;
  g.fillRect(0, height * 0.55, width, height * 0.45);
  const glow = g.createRadialGradient(width * 0.46, height * 0.36, 0, width * 0.46, height * 0.36, width * 0.8);
  glow.addColorStop(0, rgba([paper[0] + 12, paper[1] + 10, paper[2] + 6], 0.5));
  glow.addColorStop(0.6, rgba(paper, 0));
  glow.addColorStop(1, rgba(hexToRgb(palette.paperDeep), 0.36));
  g.fillStyle = glow;
  g.fillRect(0, 0, width, height);
  // One stable material pass. `paperGrain` caches per (size, seed), so the grain
  // never re-rolls between frames and the material does not boil.
  paperGrain(g, { width, height, seed: 4211, density: 0.05, alpha: 0.1, color: [58, 46, 32] });
}

/** The frame and legs, behind the bars. */
function drawInstrument(g, palette) {
  const ink = hexToRgb(palette.ink);
  // Legs.
  for (const x of [166, 300]) {
    const leg = roundRect(x, 196, 10, 44, 2);
    celFill(g, leg, { x, y: 196, w: 10, h: 44 }, { base: palette.woodDark, shadow: 'rgba(0,0,0,0.35)', ink: palette.ink }, {
      light: 0.4,
      contour: 1.3,
    });
  }
  // The rail the bars rest on.
  const rail = roundRect(138, 177, 214, 12, 2);
  celFill(g, rail, { x: 138, y: 177, w: 214, h: 12 }, { base: palette.woodDark, shadow: 'rgba(0,0,0,0.3)', ink: palette.ink }, {
    light: 0.35,
    contour: 1.4,
  });
  // Resonator pins under each bar.
  g.fillStyle = rgba(ink, 0.5);
  for (const bar of BARS) {
    for (const dx of [0.24, 0.76]) {
      g.beginPath();
      g.arc(bar.x + bar.w * dx, 182, 2, 0, Math.PI * 2);
      g.fill();
    }
  }
  // A shadow the instrument casts on the desk.
  g.save();
  g.fillStyle = 'rgba(70,50,28,0.16)';
  g.beginPath();
  g.ellipse(246, 242, 128, 9, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

/** One bar, as a cut piece of tonewood with painted grain. */
function drawBar(g, bar, dip, palette, seed) {
  const y = BAR_TOP + dip;
  const rng = mulberry32((seed ^ (bar.id.charCodeAt(0) * 977)) >>> 0);
  const outline = deform(rectPoints(bar.x, y, bar.w, BAR_H), 2, 0.55, rng);
  const path = polygonPath(outline);
  const colors = {
    base: bar.struck ? palette.woodLight : palette.wood,
    shadow: rgba(hexToRgb(palette.woodDark), 0.6),
    ink: palette.ink,
  };
  celFill(g, path, { x: bar.x, y, w: bar.w, h: BAR_H }, colors, { light: 0.42, shade: 0.7, contour: 1.5 });

  // Painted grain: two dry strokes in a darker tone, seeded per bar.
  const grain = hexToRgb(palette.woodDark);
  for (let line = 0; line < 2; line++) {
    const at = y + 4.6 + line * 4.4;
    const bend = (rng() - 0.5) * 3;
    inkStroke(
      g,
      [
        [bar.x + 6, at],
        [bar.x + bar.w * 0.4, at + bend],
        [bar.x + bar.w - 6, at - bend * 0.6],
      ],
      {
        rng: mulberry32(seed + line * 31 + bar.x),
        width: 1.6,
        color: grain,
        tone: 0.3,
        dry: 0.55,
        bristles: 3,
        noiseSeed: 17 + line,
      },
    );
  }

  // The printed note name, kept on the bar's lower half so the strike never
  // covers it: it stays legible at every frame, including contact.
  g.save();
  g.fillStyle = rgba(hexToRgb(palette.ink), 0.72);
  g.font = '600 8px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(bar.id, bar.x + bar.w / 2, y + BAR_H - 4.4);
  g.restore();
}

/** The contact smudge on the bar and the mark of the strike (grows from contact). */
function drawBarState(g, frame, contact, dip, palette, seed) {
  const since = frame - contact;
  if (since < 0) {
    // Prior state: a faint registration notch above the struck bar.
    const struck = BARS.find(bar => bar.struck);
    const ink = hexToRgb(palette.ink);
    g.save();
    g.strokeStyle = rgba(ink, 0.22);
    g.lineWidth = 1;
    g.setLineDash([2, 3]);
    g.beginPath();
    g.arc(struck.x + struck.w / 2, BAR_TOP - 14, 9, 0, Math.PI * 2);
    g.stroke();
    g.restore();
    return;
  }
  const struck = BARS.find(bar => bar.struck);
  const cx = struck.x + struck.w / 2;
  const top = BAR_TOP + dip;
  const fade = Math.max(0, 1 - since / 10);
  const strike = hexToRgb(palette.strike);
  g.save();
  // The result is PERMANENT: the strike leaves a small dent and a chipped edge
  // in the bar. It does not fade, so the last frame still carries the event.
  g.fillStyle = rgba(hexToRgb(palette.ink), 0.42);
  g.beginPath();
  g.ellipse(cx + 1, top + 2.4, 4.6, 1.35, -0.1, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = rgba(strike, 0.55);
  g.lineWidth = 1;
  g.beginPath();
  g.arc(cx + 1, top + 2.4, 4.9, 0.12 * Math.PI, 0.88 * Math.PI);
  g.stroke();
  // The contact itself: a bright seam on the bar edge for the frames of impact.
  if (since <= 3) {
    g.fillStyle = rgba(strike, 0.85 * (1 - since / 4));
    g.fillRect(cx - 13, top - 1, 26, 2.2);
  }
  // A small smudge in the wood and a warm ring above it: the transient.
  inkBloom(g, rectPoints(cx - 8, top + 0.4, 16, 4), {
    color: rgba(hexToRgb(palette.ink), 1),
    grow: 1,
    blur: 2.6,
    alpha: 0.16 * fade + 0.05,
  });
  const ring = 16 + since * 4.2;
  g.strokeStyle = rgba(strike, 0.7 * fade);
  g.lineWidth = 1.6;
  for (const side of [-1, 1]) {
    g.beginPath();
    g.arc(cx, BAR_TOP, ring, side > 0 ? 0.18 * Math.PI : 0.82 * Math.PI, side > 0 ? 0.34 * Math.PI : 0.66 * Math.PI);
    g.stroke();
  }
  // A soft resonance bloom over the bar: the bar is ringing.
  const halo = g.createRadialGradient(cx, BAR_TOP - 10, 2, cx, BAR_TOP - 10, 46);
  halo.addColorStop(0, rgba(strike, 0.2 * fade));
  halo.addColorStop(1, rgba(strike, 0));
  g.fillStyle = halo;
  g.beginPath();
  g.ellipse(cx, BAR_TOP - 10, 46, 22, 0, 0, Math.PI * 2);
  g.fill();
  // Wood dust from the strike, seeded and rising.
  const rng = mulberry32((seed ^ 0x5bd1) >>> 0);
  g.fillStyle = rgba(hexToRgb(palette.woodDark), 0.3 * fade);
  for (let i = 0; i < 6; i++) {
    const angle = -0.92 * Math.PI + rng() * 0.84 * Math.PI;
    const speed = 1.2 + rng() * 1.6;
    const x = cx + Math.cos(angle) * (10 + since * speed * 2);
    const y = BAR_TOP + Math.sin(angle) * (2 + since * speed * 0.6);
    g.beginPath();
    g.arc(x, y, 0.8 + rng() * 0.8, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
}

/** The striker: hub bracket, counterweighted arm and yarn mallet. */
function drawStriker(g, angle, palette) {
  const ink = hexToRgb(palette.ink);
  const head = { x: HUB.x + Math.cos(angle) * ARM_LENGTH, y: HUB.y + Math.sin(angle) * ARM_LENGTH };
  const counter = { x: HUB.x - Math.cos(angle) * 34, y: HUB.y - Math.sin(angle) * 34 };

  // Post and foot: the machine is bolted to the desk, not floating.
  const post = roundRect(346, 78, 12, 158, 3);
  celFill(g, post, { x: 346, y: 78, w: 12, h: 158 }, {
    base: palette.metal,
    shadow: palette.metalDark,
    ink: palette.ink,
  }, { light: 0.3, contour: 1.4 });
  g.fillStyle = palette.metalDark;
  g.fillRect(332, 232, 40, 9);
  g.strokeStyle = palette.ink;
  g.lineWidth = 1.3;
  g.strokeRect(332, 232, 40, 9);

  // Counterweight, behind the arm.
  g.beginPath();
  g.arc(counter.x, counter.y, 11, 0, Math.PI * 2);
  g.fillStyle = palette.metalDark;
  g.fill();
  g.strokeStyle = palette.ink;
  g.lineWidth = 1.5;
  g.stroke();
  g.beginPath();
  g.arc(counter.x - 3, counter.y - 3, 2.6, 0, Math.PI * 2);
  g.fillStyle = rgba(hexToRgb(palette.metalLight), 0.8);
  g.fill();

  // The arm: a tapered rod drawn as two stroked lines (contour, then fill). The
  // shaft ends at the head's rim, not at its centre, so the head reads as a
  // separate yarn ball rather than a bead pinned on a wire.
  const shaft = {
    x: HUB.x + Math.cos(angle) * (ARM_LENGTH - HEAD_R + 1),
    y: HUB.y + Math.sin(angle) * (ARM_LENGTH - HEAD_R + 1),
  };
  g.lineCap = 'round';
  g.strokeStyle = palette.ink;
  g.lineWidth = 10;
  g.beginPath();
  g.moveTo(HUB.x, HUB.y);
  g.lineTo(shaft.x, shaft.y);
  g.stroke();
  g.strokeStyle = palette.metal;
  g.lineWidth = 7;
  g.beginPath();
  g.moveTo(HUB.x, HUB.y);
  g.lineTo(shaft.x, shaft.y);
  g.stroke();
  g.strokeStyle = rgba(hexToRgb(palette.metalLight), 0.85);
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(HUB.x - 2, HUB.y - 3);
  g.lineTo(shaft.x - 2, shaft.y - 3);
  g.stroke();

  // Hub bracket + bolt.
  g.beginPath();
  g.arc(HUB.x, HUB.y, HUB.r, 0, Math.PI * 2);
  g.fillStyle = palette.metalLight;
  g.fill();
  g.strokeStyle = palette.ink;
  g.lineWidth = 1.8;
  g.stroke();
  g.beginPath();
  g.arc(HUB.x, HUB.y, 3, 0, Math.PI * 2);
  g.fillStyle = palette.metalDark;
  g.fill();

  // Yarn mallet head: a flat base, a hard terminator, a seam or two.
  g.save();
  g.beginPath();
  g.arc(head.x, head.y, HEAD_R, 0, Math.PI * 2);
  g.fillStyle = palette.yarn;
  g.fill();
  g.save();
  g.clip();
  g.fillStyle = rgba(hexToRgb(palette.yarnDark), 0.85);
  g.beginPath();
  g.arc(head.x + 5, head.y + 6, HEAD_R, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = rgba(hexToRgb(palette.yarnDark), 0.5);
  g.lineWidth = 1;
  for (let i = -2; i <= 2; i++) {
    g.beginPath();
    g.arc(head.x - 6, head.y + i * 4, HEAD_R + 4, -0.7, 0.7);
    g.stroke();
  }
  g.restore();
  g.strokeStyle = palette.ink;
  g.lineWidth = 1.6;
  g.beginPath();
  g.arc(head.x, head.y, HEAD_R, 0, Math.PI * 2);
  g.stroke();
  // The collar where the shaft enters the head.
  g.fillStyle = palette.metalDark;
  g.beginPath();
  g.ellipse(shaft.x - Math.cos(angle) * 2, shaft.y - Math.sin(angle) * 2, 5.4, 2.6, angle, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = palette.ink;
  g.lineWidth = 1;
  g.stroke();
  g.restore();

  // A small pivot label, in print, not a caption: this is a mechanism study.
  g.save();
  g.fillStyle = rgba(ink, 0.4);
  g.font = '600 6px sans-serif';
  g.textAlign = 'center';
  g.fillText('PIVOT', HUB.x, HUB.y + 22);
  g.restore();
}

function drawCaption(g, width, height, timeline, palette) {
  const ink = hexToRgb(palette.ink);
  const pad = Math.max(10, Math.round(width * 0.03));
  const size = Math.max(8, Math.round(width * 0.017));
  g.save();
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.fillStyle = rgba(ink, 0.62);
  g.font = `600 ${size}px sans-serif`;
  g.fillText('CONTACT STUDY / 01', pad, pad + size);
  g.fillStyle = rgba(ink, 0.34);
  g.font = `${Math.max(7, size - 2)}px sans-serif`;
  g.fillText(
    `ONE STRIKE · FRAME ${String(timeline.contactFrame).padStart(2, '0')} OF ${timeline.frames}`,
    pad,
    height - pad,
  );
  g.restore();
}

/**
 * Compose one frame.
 *
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas
 * @param {{frame?: number, fps?: number, width?: number, height?: number, seed?: number,
 *          params?: Record<string, unknown>}} ctx The capture contract.
 */
export function renderContact(canvas, ctx = {}) {
  if (!canvas || typeof canvas.getContext !== 'function')
    throw new Error('contact-scene: renderContact needs a canvas element');
  const width = Math.max(8, Math.floor(ctx.width ?? canvas.width ?? STAGE.width));
  const height = Math.max(8, Math.floor(ctx.height ?? canvas.height ?? STAGE.height));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('contact-scene: the canvas has no 2d context');

  const params = normalizeParams(ctx.params);
  const palette = params.palette;
  const frame = Math.max(0, Math.floor(finite(ctx.frame, 0)));
  const seed = finite(ctx.seed, 0);
  const frames = Math.max(1, Math.floor(finite(ctx.params?.frames, canvas.dataset?.frames ?? 24)));
  const timeline = timelineFor(frames);
  const contact = timeline.contactFrame;

  // Reset every piece of canvas state a previous frame could have left behind.
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.filter = 'none';
  g.shadowBlur = 0;
  g.shadowOffsetX = 0;
  g.shadowOffsetY = 0;
  g.setLineDash([]);

  drawBackground(g, width, height, palette);

  // ---- the camera: a held establishing frame, then a push onto the strike.
  // The push begins with the rebound, so the eye follows one object from contact
  // to result; it is a camera change motivated by the reveal, not a cut.
  const settleKey = Math.min(timeline.liftEnd, frames - 2);
  const camera = createCamera({
    stage: STAGE,
    fit: 'cover',
    frames,
    fps: timeline.fps,
    keys: [
      { frame: 0, x: 240, y: 140, z: 1, r: 0 },
      { frame: Math.max(1, contact - 3), x: 240, y: 142, z: 1.02, r: 0, ease: 'cubicInOut' },
      {
        frame: settleKey,
        x: params.camera.focusX,
        y: params.camera.focusY,
        z: params.camera.push,
        r: 0,
        ease: 'cubicInOut',
      },
      { frame: frames - 1, x: params.camera.focusX, y: params.camera.focusY, z: params.camera.push, r: 0, ease: 'linear' },
    ],
  });
  const cam = camera.at(frame, { width, height });
  const k = fitScale(STAGE, { width, height }, 'cover') * cam.z;
  g.save();
  g.translate(width / 2, height / 2);
  if (cam.r) g.rotate(cam.r);
  g.scale(k, k);
  g.translate(-cam.x, -cam.y);

  drawInstrument(g, palette);

  // The struck bar's damped vibration: it dips at contact and settles. A damped
  // cosine is deterministic and reads as a ring, not a slide.
  const since = frame - contact;
  const dip = since <= 0 ? 0 : 2.2 * Math.exp(-since * 0.55) * Math.sin(since * 1.9);
  for (const bar of BARS) drawBar(g, bar, bar.struck ? dip : 0, palette, seed);
  drawBarState(g, frame, contact, dip, palette, seed);

  // ---- the authored motion: hold, accelerate down, meet the bar, rebound.
  let angle;
  if (frame <= timeline.approachStart) angle = REST_ANGLE;
  else if (frame <= contact)
    angle = REST_ANGLE + (CONTACT_ANGLE - REST_ANGLE) * ease('cubicIn', (frame - timeline.approachStart) / (contact - timeline.approachStart));
  else
    // The rebound lifts the head past its resting angle, then holds: a swing, not
    // a slide. The arm stops while the bar keeps vibrating.
    angle =
      CONTACT_ANGLE +
      (REST_ANGLE - CONTACT_ANGLE + 0.12) * ease('cubicOut', clamp01((frame - contact) / (timeline.liftEnd - contact)));

  // The mallet's contact shadow: tighter and darker as the head gets closer.
  const headY = HUB.y + Math.sin(angle) * ARM_LENGTH;
  const gap = Math.max(0, BAR_TOP - (headY + HEAD_R));
  const spread = 10 + gap * 0.55;
  const alpha = Math.max(0, 0.34 - gap * 0.008);
  if (alpha > 0.02) {
    g.save();
    const gradient = g.createRadialGradient(240, BAR_TOP, 0, 240, BAR_TOP, spread);
    gradient.addColorStop(0, `rgba(48,32,16,${alpha})`);
    gradient.addColorStop(0.6, `rgba(48,32,16,${alpha * 0.4})`);
    gradient.addColorStop(1, 'rgba(48,32,16,0)');
    g.fillStyle = gradient;
    g.beginPath();
    g.ellipse(240, BAR_TOP, spread, spread * 0.22, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }

  drawStriker(g, angle, palette);
  g.restore();

  drawCaption(g, width, height, timeline, palette);

  // Authoring/diagnostic facts. Pixels remain the contract; this is not one.
  window.contactState = {
    frame,
    frames,
    width,
    height,
    contactFrame: contact,
    angle: Number(angle.toFixed(4)),
    headY: Number(headY.toFixed(3)),
    dip: Number(dip.toFixed(3)),
    touching: frame >= contact,
    camera: { x: Number(cam.x.toFixed(2)), y: Number(cam.y.toFixed(2)), z: Number(cam.z.toFixed(4)) },
  };
}
