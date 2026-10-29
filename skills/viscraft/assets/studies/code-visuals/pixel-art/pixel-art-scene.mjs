// pixel-art-scene.mjs — an original night-shrine scene for the indexed-colour
// rig. Wren walks in, kneels, raises the staff and the shrine crystal answers.
// The second variant stages Arlo in a non-combat guardian stance: he plants his
// sword, lowers his head and the two shrine lamps light.
//
// This is a low-level pixel-character/animation reference. It is not an RPG,
// has no World, no real-time input, no menu, no save state and no audio.
import { W, H, C, LUT, FB, bayer, hash, lerp, clamp, ss, makeOut } from './px.mjs';
import { drawChar, blendPose, scarfTail } from './sprites.mjs';
import { text, hasGlyph, COVERAGE } from './font.mjs';

export const FPS = 24;
export const DEFAULT_FRAMES = 144;
export const VARIANTS = ['offer', 'guard'];
export const SUBJECT = { offer: 'wren', guard: 'arlo' };
export const DEFAULT_CAPTIONS = {
  offer: 'STILL SHRINE: RESTORED',
  guard: 'THE KEEPING: HELD',
};

// The shrine is staged in the 320x180 logical frame. The character's feet
// anchor is (24,44) inside the 48x48 sprite, so the scene blits at
// (x - 24, GROUND - 44): the ground contact is independent of the pose.
export const GROUND = 152;
export const OFFER_START_X = 64;
export const OFFER_X = 146;
export const ARLO_X = 150;
export const CRYSTAL_X = 240;
export const CRYSTAL_Y = 110;
export const LAMP_L = [207, 92];
export const LAMP_R = [273, 92];

// Beat fractions, used for every source length.
const OFFER_BEATS = Object.freeze({
  walkEnd: 0.22,
  settleEnd: 0.36,
  kneelAt: 0.42,
  castAt: 0.58,
  responseStart: 0.64,
  responseEnd: 0.86,
});
const GUARD_BEATS = Object.freeze({
  plantAt: 0.16,
  guardAt: 0.28,
  lampStart: 0.5,
  lampEnd: 0.74,
  lookAt: 0.7,
});
export const BEATS = Object.freeze({ offer: OFFER_BEATS, guard: GUARD_BEATS });

function beat(frames, fraction, floorFrame) {
  const last = Math.max(0, frames - 1);
  return clamp(Math.round(frames * fraction), Math.min(floorFrame, last), last);
}
function frame01(frame, frames) {
  if (frames <= 1) return 0;
  return clamp(frame, 0, frames - 1) / (frames - 1);
}

/**
 * The single authored clock. Rendering and tests read the same function, so a
 * test never re-derives the pose/response timing from independent constants.
 *
 * @returns {{
 *   frame:number, frames:number, variant:'offer'|'guard', subject:string,
 *   phase:string, pose:string, fromPose:string, toPose:string, mix:number,
 *   x:number, facing:1|-1, wind:number, response:number, flood:number,
 *   crystal:number, lamps:number, caption:string
 * }}
 * `pose` is the target pose name for the phase; `fromPose`/`toPose`/`mix` give
 * the actual rendered blend during a transition (mix 0 keeps the previous pose).
 */
export function timelineAt(frame, options = {}) {
  const frames = Number.isInteger(options.frames) ? options.frames : DEFAULT_FRAMES;
  if (frames < 2) throw new Error('pixel-art requires at least 2 frames');
  const variant = options.variant ?? 'offer';
  if (!VARIANTS.includes(variant)) throw new Error(`unknown pixel-art variant "${variant}"; use one of ${VARIANTS.join(', ')}`);
  const caption = options.caption ?? DEFAULT_CAPTIONS[variant];
  if (typeof caption !== 'string') throw new Error('pixel-art caption must be a string');
  for (const ch of caption)
    if (!hasGlyph(ch))
      throw new Error(
        `pixel-art caption contains "${ch}", which the bitmap font does not cover; ` +
          `supported characters are: ${COVERAGE}. No system font or CJK fallback is used.`,
      );
  const f = clamp(Math.round(frame), 0, frames - 1);
  const u = frame01(f, frames);

  if (variant === 'offer') {
    const walkEnd = beat(frames, OFFER_BEATS.walkEnd, 1);
    const settleEnd = beat(frames, OFFER_BEATS.settleEnd, walkEnd + 1);
    const kneelAt = beat(frames, OFFER_BEATS.kneelAt, settleEnd + 1);
    const castAt = beat(frames, OFFER_BEATS.castAt, kneelAt + 1);
    const responseStart = beat(frames, OFFER_BEATS.responseStart, castAt + 1);
    const responseEnd = beat(frames, OFFER_BEATS.responseEnd, responseStart + 1);

    let phase;
    let pose;
    let fromPose;
    let toPose;
    let mix;
    let x = OFFER_X;
    let wind = 0.4;
    if (f < walkEnd) {
      phase = 'walk';
      x = Math.round(lerp(OFFER_START_X, OFFER_X, ss(0, 1, walkEnd <= 1 ? 1 : f / walkEnd)));
      pose = `walk${Math.floor((f * 8) / FPS) % 4}`;
      fromPose = pose;
      toPose = pose;
      mix = 0;
      wind = 0.55;
    } else if (f < kneelAt) {
      phase = 'settle';
      const t = ss(walkEnd, walkEnd + 6, f);
      const lastWalk = `walk${Math.floor(((walkEnd - 1) * 8) / FPS) % 4}`;
      pose = 'breathe';
      fromPose = lastWalk;
      toPose = 'breathe';
      mix = t;
    } else if (f < castAt) {
      // The kneel blend starts ON the kneel branch, so the first kneel frame is
      // still the previous breathe pose instead of a one-frame hard cut.
      phase = 'kneel';
      const t = ss(kneelAt, kneelAt + 6, f);
      pose = 'kneel';
      fromPose = 'breathe';
      toPose = 'kneel';
      mix = t;
      wind = 0.35;
    } else {
      phase = 'cast';
      const t = ss(castAt, castAt + 6, f);
      pose = 'cast';
      fromPose = 'kneel';
      toPose = 'cast';
      mix = t;
      wind = 0.7;
    }
    const response = ss(responseStart, responseEnd, f);
    return {
      frame: f,
      frames,
      variant,
      subject: SUBJECT[variant],
      phase,
      pose,
      fromPose,
      toPose,
      mix,
      x,
      facing: 1,
      wind,
      response,
      flood: response * 380,
      crystal: response,
      lamps: 0,
      caption,
      u,
    };
  }

  const plantAt = beat(frames, GUARD_BEATS.plantAt, 1);
  const guardAt = beat(frames, GUARD_BEATS.guardAt, plantAt + 1);
  const lampStart = beat(frames, GUARD_BEATS.lampStart, guardAt + 1);
  const lampEnd = beat(frames, GUARD_BEATS.lampEnd, lampStart + 1);
  const lookAt = beat(frames, GUARD_BEATS.lookAt, guardAt + 1);

  let phase;
  let pose;
  let fromPose;
  let toPose;
  let mix;
  if (f < plantAt) {
    phase = 'stand';
    pose = Math.floor(f / 18) % 2 === 0 ? 'breathe' : 'idle';
    fromPose = pose;
    toPose = pose;
    mix = 0;
  } else if (f < guardAt) {
    phase = 'plant';
    pose = 'plant';
    fromPose = 'breathe';
    toPose = 'plant';
    mix = ss(plantAt, plantAt + 6, f);
  } else if (f < lookAt) {
    phase = 'guard';
    pose = 'guard';
    fromPose = 'plant';
    toPose = 'guard';
    mix = ss(guardAt, guardAt + 6, f);
  } else {
    phase = 'look';
    pose = 'guardlook';
    fromPose = 'guard';
    toPose = 'guardlook';
    mix = ss(lookAt, lookAt + 6, f);
  }
  const response = ss(lampStart, lampEnd, f);
  return {
    frame: f,
    frames,
    variant,
    subject: SUBJECT[variant],
    phase,
    pose,
    fromPose,
    toPose,
    mix,
    x: ARLO_X,
    facing: 1,
    wind: 0.3,
    response,
    flood: response * 380,
    crystal: 0,
    lamps: response,
    caption,
    u,
  };
}

/* ── environment ─────────────────────────────────────────────────────────── */

function drawSky(fb, time) {
  fb.gradV(0, 0, W, 126, [C.ink, C.night, C.dslate]);
  // A small moon gives the faded table a readable light source and balances the
  // shrine on the right.
  const mx = 272;
  const my = 38;
  for (let dy = -12; dy <= 12; dy++)
    for (let dx = -12; dx <= 12; dx++) {
      const d = Math.hypot(dx, dy);
      if (d <= 9) fb.px(mx + dx, my + dy, d > 8 ? C.steel : C.silver);
      else if (d <= 13 && bayer(mx + dx, my + dy) < 0.18) fb.px(mx + dx, my + dy, C.dslate);
    }
  fb.disc(mx - 2, my - 2, 5, C.white);
  fb.px(mx + 2, my + 1, C.steel);
  fb.px(mx + 3, my + 2, C.steel);
  fb.px(mx - 1, my + 4, C.steel);
  for (let i = 0; i < 30; i++) {
    const x = Math.floor(hash(i, 1) * W);
    const y = Math.floor(hash(i, 2) * 88);
    const twinkle = hash(i, 3, Math.floor(time * 3));
    if (twinkle < 0.18) continue;
    fb.px(x, y, twinkle > 0.72 ? C.white : twinkle > 0.42 ? C.silver : C.steel);
    if (hash(i, 4) > 0.8) fb.px(x + 1, y, C.dslate);
  }
}

function drawHills(fb) {
  for (let x = 0; x < W; x++) {
    const far = 10 + Math.round(vnoiseAt(x * 0.035 + 4) * 12);
    fb.vline(x, 126 - far, 126, C.dgreen);
    const near = 4 + Math.round(vnoiseAt(x * 0.06 + 21) * 8);
    fb.vline(x, 126 - near, 126, C.teal);
  }
  // A few darker tree pins on the near ridge.
  for (let i = 0; i < 9; i++) {
    const x = Math.floor(hash(i, 11) * W);
    const base = 126 - (4 + Math.round(vnoiseAt(x * 0.06 + 21) * 8));
    fb.vline(x, base - 5, base, C.dgreen);
    fb.px(x - 1, base - 4, C.dgreen);
    fb.px(x + 1, base - 3, C.dgreen);
  }
}
function vnoiseAt(x) {
  const i = Math.floor(x);
  const f = x - i;
  const t = f * f * (3 - 2 * f);
  return hash(i) * (1 - t) + hash(i + 1) * t;
}

function drawGround(fb, state) {
  fb.rect(0, 126, W, H - 126, C.dslate);
  fb.hline(0, W - 1, 126, C.steel);
  fb.hline(0, W - 1, 127, C.night);
  for (let y = 134; y < H; y += 11) {
    fb.hline(0, W - 1, y, C.night);
    const shift = ((y / 11) | 0) % 2 === 0 ? 0 : 14;
    for (let x = shift; x < W; x += 28) fb.vline(x, y + 1, Math.min(H - 1, y + 10), C.night);
  }
  // Flagstone highlights, deterministic and sparse.
  for (let i = 0; i < 26; i++) {
    const x = Math.floor(hash(i, 31) * W);
    const y = 132 + Math.floor(hash(i, 32) * 46);
    fb.px(x, y, C.slate);
    if (hash(i, 33) > 0.7) fb.px(x + 1, y, C.night);
  }
  // Character shadow: a dithered ellipse on the ground.
  const sx = Math.round(state.x);
  for (let dy = 0; dy < 4; dy++) {
    const half = 10 - dy * 2;
    for (let dx = -half; dx <= half; dx++) {
      if (bayer(sx + dx, GROUND + dy) > 0.55 - dy * 0.1) fb.px(sx + dx, GROUND + dy, C.night);
    }
  }
}

function drawShrine(fb, state, time) {
  // Stepped platform and pedestal, original geometry for this study.
  fb.rect(212, 142, 56, 6, C.slate);
  fb.hline(212, 267, 142, C.steel);
  fb.hline(212, 267, 147, C.night);
  fb.rect(220, 136, 40, 6, C.slate);
  fb.hline(220, 259, 136, C.steel);
  fb.rect(228, 131, 24, 5, C.steel);
  fb.hline(228, 251, 131, C.silver);
  fb.hline(228, 251, 135, C.dslate);

  // Two pillars with capped lamps.
  for (const px of [204, 270]) {
    fb.rect(px, 96, 7, 46, C.slate);
    fb.vline(px, 96, 141, C.steel);
    fb.vline(px + 6, 96, 141, C.night);
    fb.rect(px - 2, 92, 11, 4, C.steel);
    fb.hline(px - 2, px + 8, 92, C.silver);
    fb.hline(px - 2, px + 8, 95, C.night);
    // Moss at the base.
    fb.px(px, 141, C.dgreen);
    fb.px(px + 1, 141, C.dgreen);
    fb.px(px + 5, 141, C.teal);
  }

  const lit = state.lamps;
  drawLamp(fb, LAMP_L[0], LAMP_L[1], lit, state.frame);
  drawLamp(fb, LAMP_R[0], LAMP_R[1], lit, state.frame + 3);
  drawCrystal(fb, state, time);
}

function drawLamp(fb, cx, cy, lit, frame) {
  // Lamp housing.
  fb.rect(cx - 3, cy - 2, 7, 2, C.dbrown);
  fb.rect(cx - 3, cy + 6, 7, 2, C.dbrown);
  fb.vline(cx - 3, cy - 2, cy + 7, C.umber);
  fb.vline(cx + 3, cy - 2, cy + 7, C.umber);
  if (lit <= 0) {
    fb.rect(cx - 2, cy, 5, 6, C.night);
    fb.vline(cx, cy + 1, cy + 4, C.dslate);
    return;
  }
  // The flame is drawn in protected-adjacent warm indices; the response flood
  // restores the full palette around it.
  const h = 2 + Math.round(lit * 5);
  fb.rect(cx - 2, cy, 5, 6, C.amber);
  fb.rect(cx - 1, cy + 1, 3, 4, C.yellow);
  for (let i = 0; i < h; i++) {
    const w = Math.max(0, 1 - Math.floor(i / 2));
    const flicker = hash(cx, i, Math.floor(frame / 3)) > 0.4 ? C.yellow : C.white;
    fb.hline(cx - w, cx + w, cy - 1 - i, i > 2 ? C.orange : flicker);
  }
  fb.px(cx, cy - 1 - h, C.white);
  // Halo through an ordered-dither ring.
  const r = 7 + Math.round(lit * 5);
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      const d = Math.hypot(dx, dy);
      if (d > r || d < r - 3) continue;
      if (bayer(cx + dx, cy + dy) > lit * 0.5) fb.px(cx + dx, cy + dy, d > r - 1 ? C.amber : C.orange);
    }
}

function crystalY(state, time) {
  return CRYSTAL_Y + Math.round(Math.sin(time * 1.1) * 2);
}

function drawCrystal(fb, state, time) {
  const cx = CRYSTAL_X;
  const cy = crystalY(state, time);
  const lit = state.crystal;
  // Faceted diamond, protected cyan indices: colour survives the faded LUT.
  const rows = [
    [-8, 1, C.xw],
    [-7, 2, C.xc],
    [-6, 3, C.xc],
    [-5, 4, C.xb],
    [-4, 5, C.xb],
    [-3, 4, C.xb],
    [-2, 3, C.xd],
    [-1, 2, C.xd],
    [0, 1, C.xd],
  ];
  for (const [dy, half, col] of rows) fb.hline(cx - half, cx + half, cy + dy, col);
  fb.vline(cx - 2, cy - 7, cy - 2, C.xw);
  fb.vline(cx + 2, cy - 5, cy - 1, C.xb);
  fb.px(cx, cy - 5, C.xw);
  // Response halo and ripple rings.
  if (lit > 0) {
    const r = 9 + Math.round(lit * 20);
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      const x = Math.round(cx + Math.cos(a) * r);
      const y = Math.round(cy + Math.sin(a) * r * 0.72);
      if (bayer(x, y) < 0.2 + lit * 0.55) fb.px(x, y, i % 4 === 0 ? C.xw : C.xc);
    }
    // Eight short sparkle rays, not a solid glow disc.
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      for (let d = 7; d <= r; d += 3) {
        const x = Math.round(cx + Math.cos(a) * d);
        const y = Math.round(cy + Math.sin(a) * d * 0.8);
        if (bayer(x, y) < lit * 0.55) fb.px(x, y, d > r - 4 ? C.xw : C.xc);
      }
    }
    for (let dy = -10; dy <= 10; dy++)
      for (let dx = -10; dx <= 10; dx++) {
        const d = Math.hypot(dx, dy);
        if (d > 10 || d < 7) continue;
        if (bayer(cx + dx, cy + dy) < lit * 0.22) fb.px(cx + dx, cy + dy, C.xb);
      }
  } else {
    fb.px(cx - 1, cy - 5, C.white);
  }
}

function drawBeam(fb, state, time, tip) {
  if (state.crystal <= 0 || !tip) return;
  const ax = state.x + tip.x;
  const ay = GROUND + tip.y;
  const bx = CRYSTAL_X;
  const by = crystalY(state, time);
  const n = 120;
  const pulse = (time * 1.6) % 1;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = Math.round(lerp(ax, bx, t));
    const y = Math.round(lerp(ay, by, t) + Math.sin(t * Math.PI) * -3);
    const nearPulse = Math.abs(t - pulse) < 0.08;
    if (bayer(x, y) > 0.28 + state.crystal * 0.35 && !nearPulse) continue;
    fb.px(x, y, nearPulse ? C.xw : t > 0.65 ? C.xc : C.xb);
    if (nearPulse || t < 0.25) fb.px(x, y + 1, C.xb);
  }
  fb.disc(ax, ay, 2, C.xw);
  fb.disc(ax, ay, 3, C.xc);
}

function drawMotes(fb, state, time) {
  for (let i = 0; i < 22; i++) {
    const speed = 3 + hash(i, 4) * 7;
    const y = 126 - ((hash(i, 2) * 150 + time * speed) % 150);
    const x = Math.round(hash(i, 1) * W + Math.sin(time * 0.5 + i) * 3);
    const bright = hash(i, 5) > 0.55;
    fb.px(x, y, bright ? C.silver : C.steel);
    if (bright && hash(i, 6) > 0.7) fb.px(x + 1, y, C.dslate);
  }
  if (state.lamps > 0.15) {
    for (let i = 0; i < 12; i++) {
      const side = i % 2 === 0 ? LAMP_L[0] : LAMP_R[0];
      const rise = (time * (8 + hash(i, 7) * 8) + hash(i, 8) * 20) % 26;
      const x = Math.round(side + (hash(i, 9) - 0.5) * 10 + Math.sin(time + i) * 2);
      const y = Math.round(LAMP_L[1] - 4 - rise);
      if (hash(i, 10) > 0.35) fb.px(x, y, rise < 8 ? C.yellow : C.amber);
    }
  }
}

function drawCaption(fb, state) {
  text(fb, state.caption, 8, 7, C.white, C.ink);
}

function drawCharacter(fb, state, time, sprite) {
  const sx = Math.round(state.x);
  const sy = GROUND - 44;
  // Back tail, sprite, then the shorter near tail: the front/back scarf layers
  // are kept as separate passes around the body.
  scarfTail(fb, sx - 1, GROUND - 23, time, state.wind * 0.9, 1, 14);
  fb.blit(sprite, sx - 24, sy);
  scarfTail(fb, sx, GROUND - 22, time, state.wind, 1, 9);
  return { sx, sy };
}

function pickFor(state, time) {
  const centers =
    state.variant === 'offer'
      ? [[CRYSTAL_X, crystalY(state, time)]]
      : [
          [LAMP_L[0], LAMP_L[1]],
          [LAMP_R[0], LAMP_R[1]],
        ];
  const r = state.flood;
  return (x, y) => {
    for (const [cx, cy] of centers) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= r - 3) return true;
      if (d <= r && bayer(x, y) < (r - d) / 3) return true;
    }
    return false;
  };
}

/* ── entry ───────────────────────────────────────────────────────────────── */

let presenter = null;
let presenterKey = '';

function presenterFor(canvas, ctx) {
  const key = `${ctx.width}x${ctx.height}`;
  if (!presenter || presenterKey !== key) {
    presenter = makeOut(canvas, ctx);
    presenterKey = key;
  }
  return presenter;
}

/** Render one frame. Pure in (frame, params); no wall clock or randomness. */
export function renderPixelArt(canvas, ctx) {
  const time = Number.isFinite(ctx.time) ? ctx.time : ctx.frame / FPS;
  const state = timelineAt(ctx.frame, ctx.params ?? {});
  const pose = blendPose(state.fromPose, state.toPose, state.mix);
  const sprite = drawChar(state.subject, pose, { t: time, wind: state.wind, scarf: true });
  const fb = new FB();
  fb.clear(C.ink);
  drawSky(fb, time);
  drawHills(fb);
  drawGround(fb, state);
  drawShrine(fb, state, time);
  drawMotes(fb, state, time);
  drawBeam(fb, state, time, sprite.staffTip);
  drawCharacter(fb, state, time, sprite);
  drawCaption(fb, state);

  const out = presenterFor(canvas, ctx);
  if (state.response > 0) out.present(fb, LUT.faded, LUT.full, pickFor(state, time));
  else out.present(fb, LUT.faded);
  out.show();
}
