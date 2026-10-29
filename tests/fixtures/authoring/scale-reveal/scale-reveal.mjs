#!/usr/bin/env node
/*
 * Viscraft author module: SCREEN-ANCHOR SCALE-REVEAL camera.
 *
 * A scale reveal is one of the recurring creative problems in code-authored
 * work: start wide on a whole system, push in until one detail fills the frame,
 * hold, then pull back. Naively you author the camera centre in world units and
 * push in; at high zoom the tiniest world-space error becomes a large
 * *screen-space* error, so the thing you meant to hold drifts out of frame. This
 * module plans the push in LOG space and solves the centre so a chosen WORLD
 * POINT lands on a chosen SCREEN FRACTION, exactly, at every frame.
 *
 * The module is content-free — it knows nothing about what is drawn — and it
 * will run unchanged in Node and in the browser:
 *
 *   const camera = createScaleReveal({
 *     worldFrame:  { width: 1600, height: 900 },   // the authored world frame
 *     fit:         'cover',                        // how that frame fits the view
 *     viewport:    { width: 640, height: 360 },    // reference OUTPUT (defines aspect)
 *     worldAnchor: { x: 520, y: 360 },             // the world point to hold
 *     anchorScreen:{ x: 0.62, y: 0.44 },           // screen fraction in [0,1] to hold it at
 *     zoom:        { from: 1, to: 16 },            // LINEAR units, planned in LOG space
 *     ease:        'inOutCubic',                   // named curve (see SCALE_REVEAL_EASINGS)
 *     holdIn: 4, holdOut: 6,                       // integer frames held at each end
 *     startFrame: 0, frames: 96,                   // scope on the composition clock
 *     bounds: { minX: 0, minY: 0, maxX: 1600, maxY: 900 }, // OPTIONAL clamp of the centre
 *   });
 *   const sample = camera.at(frame, { width, height });   // pure function of frame
 *   const px = project(camera.worldAnchor, sample, { width, height });
 *
 * Guarantees:
 *   - `at(frame)` is a PURE function of the frame index (plus the fixed spec and
 *     the viewport). Ordered and shuffled sampling return identical numbers, and
 *     nothing depends on wall-clock time or render cost. There is no follow,
 *     damping or stateful integration here: a screen-space damped camera would
 *     have to be fixed-step pre-computed, and is deliberately out of scope.
 *   - Given a viewport of ANY aspect, the sample satisfies
 *     `worldToScreen(worldAnchor) === anchorScreen * viewport` exactly, except
 *     where `bounds` clamps the centre (the clamp is intentional and reported).
 *
 * Time ownership: the module owns *camera* time only, as a pure map
 * frame -> sample. The host owns real time; the author must NOT feed render
 * timing, Date.now() or Math.random() into the camera.
 */

const clamp = (value, lo, hi) => (value < lo ? lo : value > hi ? hi : value);
const mix = (a, b, t) => a + (b - a) * t;

/**
 * Named easing curves. Each maps [0,1] -> [0,1], is defined at both ends
 * (f(0)=0, f(1)=1), and is monotonic non-decreasing. `ease(name, t)` clamps `t`
 * to [0,1] before evaluating, so an out-of-range sampler never extrapolates.
 *
 * Deliberately several curves, not one: a scale reveal wants an explosive open
 * (`outExpo`), a gentle settle, a mechanical `inOutCubic`, or a perfectly even
 * `linear` read for a survey-like push. Flattening all motion onto a single
 * ease would erase that choice.
 */
export const SCALE_REVEAL_EASINGS = {
  linear: (t) => t,
  smooth: (t) => t * t * (3 - 2 * t),
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  inOutQuint: (t) => (t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2),
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
};

export const EASING_NAMES = Object.keys(SCALE_REVEAL_EASINGS);

/** Resolve an easing by name (or accept a caller-supplied function of [0,1]). */
export function ease(name, t) {
  const fn = typeof name === 'function' ? name : SCALE_REVEAL_EASINGS[name ?? 'inOutCubic'];
  if (typeof fn !== 'function') throw new Error(`scale-reveal: unknown easing "${name}"`);
  const value = fn(clamp(t, 0, 1));
  // Normalise a negative zero (e.g. inOutSine at t=0) so an endpoint is exactly 0.
  return value === 0 ? 0 : value;
}

function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`scale-reveal: ${label} must be a finite number`);
  return value;
}

function positive(value, label) {
  const n = finite(value, label);
  if (n <= 0) throw new Error(`scale-reveal: ${label} must be > 0`);
  return n;
}

function point(value, label) {
  if (!value || typeof value !== 'object') throw new Error(`scale-reveal: ${label} must be { x, y }`);
  return { x: finite(value.x, `${label}.x`), y: finite(value.y, `${label}.y`) };
}

function fitScaleOf(worldFrame, viewport, fit) {
  const sx = viewport.width / worldFrame.width;
  const sy = viewport.height / worldFrame.height;
  return fit === 'contain' ? Math.min(sx, sy) : Math.max(sx, sy);
}

/**
 * Validate and normalise a scale-reveal spec. Everything is resolved here so a
 * malformed authored camera fails loudly at authoring time, never silently
 * mid-render. Returns a frozen, plain-data spec the sampler consumes.
 */
export function normalizeScaleReveal(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('scale-reveal: spec must be an object');

  const frames = spec.frames;
  if (!Number.isInteger(frames) || frames < 1) throw new Error('scale-reveal: frames must be an integer >= 1');
  const startFrame = spec.startFrame ?? 0;
  if (!Number.isInteger(startFrame) || startFrame < 0) throw new Error('scale-reveal: startFrame must be an integer >= 0');
  const holdIn = spec.holdIn ?? 0;
  const holdOut = spec.holdOut ?? 0;
  if (!Number.isInteger(holdIn) || holdIn < 0) throw new Error('scale-reveal: holdIn must be an integer >= 0');
  if (!Number.isInteger(holdOut) || holdOut < 0) throw new Error('scale-reveal: holdOut must be an integer >= 0');
  if (holdIn + holdOut > frames - 1) throw new Error('scale-reveal: holdIn + holdOut must leave at least one active frame');

  const worldFrameRaw = spec.worldFrame;
  if (!worldFrameRaw || typeof worldFrameRaw !== 'object') throw new Error('scale-reveal: worldFrame must be { width, height }');
  const worldFrame = { width: positive(worldFrameRaw.width, 'worldFrame.width'), height: positive(worldFrameRaw.height, 'worldFrame.height') };

  const viewportRaw = spec.viewport;
  if (!viewportRaw || typeof viewportRaw !== 'object') throw new Error('scale-reveal: viewport must be { width, height } (the reference output; it defines the handled aspect)');
  const viewport = { width: positive(viewportRaw.width, 'viewport.width'), height: positive(viewportRaw.height, 'viewport.height') };

  const fit = spec.fit ?? 'cover';
  if (fit !== 'cover' && fit !== 'contain') throw new Error('scale-reveal: fit must be "cover" or "contain"');

  const worldAnchor = point(spec.worldAnchor, 'worldAnchor');

  const anchorRaw = point(spec.anchorScreen, 'anchorScreen');
  if (anchorRaw.x < 0 || anchorRaw.x > 1 || anchorRaw.y < 0 || anchorRaw.y > 1) {
    throw new Error('scale-reveal: anchorScreen must be within [0, 1] on both axes');
  }

  const zoomRaw = spec.zoom;
  if (!zoomRaw || typeof zoomRaw !== 'object') throw new Error('scale-reveal: zoom must be { from, to }');
  const zoom = { from: positive(zoomRaw.from, 'zoom.from'), to: positive(zoomRaw.to, 'zoom.to') };

  const easeName = spec.ease ?? 'inOutCubic';
  if (typeof easeName !== 'function' && !SCALE_REVEAL_EASINGS[easeName]) throw new Error(`scale-reveal: unknown easing "${easeName}"`);

  let bounds = null;
  if (spec.bounds !== undefined && spec.bounds !== null) {
    const raw = spec.bounds;
    bounds = {
      minX: finite(raw.minX, 'bounds.minX'),
      minY: finite(raw.minY, 'bounds.minY'),
      maxX: finite(raw.maxX, 'bounds.maxX'),
      maxY: finite(raw.maxY, 'bounds.maxY'),
    };
    if (bounds.minX > bounds.maxX) throw new Error('scale-reveal: bounds.minX must be <= bounds.maxX');
    if (bounds.minY > bounds.maxY) throw new Error('scale-reveal: bounds.minY must be <= bounds.maxY');
  }

  return Object.freeze({
    frames,
    startFrame,
    holdIn,
    holdOut,
    activeFrames: frames - 1 - holdIn - holdOut,
    worldFrame: Object.freeze(worldFrame),
    viewport: Object.freeze(viewport),
    fit,
    worldAnchor: Object.freeze(worldAnchor),
    anchorScreen: Object.freeze(anchorRaw),
    zoom: Object.freeze(zoom),
    ease: easeName,
    bounds: bounds ? Object.freeze(bounds) : null,
    aspect: viewport.width / viewport.height,
  });
}

/**
 * Resolve the camera centre (world units) and the pixels-per-world-unit scale
 * for a given zoom and viewport. The centre is chosen so `worldAnchor` lands on
 * `anchorScreen` exactly; an optional `bounds` then clamps it, which is the one
 * documented case where the anchor can leave its screen fraction.
 */
function resolveCenter(spec, zoom, viewport) {
  const scale = fitScaleOf(spec.worldFrame, viewport, spec.fit) * zoom;
  const offsetX = ((spec.anchorScreen.x - 0.5) * viewport.width) / scale;
  const offsetY = ((spec.anchorScreen.y - 0.5) * viewport.height) / scale;
  let x = spec.worldAnchor.x - offsetX;
  let y = spec.worldAnchor.y - offsetY;
  let clamped = false;
  if (spec.bounds) {
    const cx = clamp(x, spec.bounds.minX, spec.bounds.maxX);
    const cy = clamp(y, spec.bounds.minY, spec.bounds.maxY);
    clamped = cx !== x || cy !== y;
    x = cx;
    y = cy;
  }
  return { centerWorld: { x, y }, scale, clamped };
}

/**
 * Map a world point to output pixels for a camera `sample`. This is the exact
 * inverse of the centre solve above, so `project(spec.worldAnchor, at(frame),
 * viewport)` lands on `anchorScreen * viewport` (when unclamped).
 */
export function project(pointWorld, sample, viewport) {
  const p = point(pointWorld, 'pointWorld');
  const vp = viewport ?? sample.viewport;
  if (!vp || typeof vp !== 'object') throw new Error('scale-reveal: project needs a viewport { width, height }');
  if (!sample || typeof sample !== 'object' || !sample.centerWorld) throw new Error('scale-reveal: project needs a camera sample');
  return {
    x: vp.width / 2 + (p.x - sample.centerWorld.x) * sample.scale,
    y: vp.height / 2 + (p.y - sample.centerWorld.y) * sample.scale,
  };
}

/**
 * Build a scale-reveal camera from a spec. The returned object is stateless:
 * `at(frame, viewport?)` is a pure function of the frame, so frames may be
 * sampled in any order with identical results.
 */
export function createScaleReveal(spec) {
  const normalized = normalizeScaleReveal(spec);

  /** Integer local frame inside the authored scope, clamped to the scope ends. */
  const localFrameOf = (frame) => {
    const globalFrame = Math.round(finite(frame, 'frame'));
    return clamp(globalFrame - normalized.startFrame, 0, normalized.frames - 1);
  };

  const at = (frame, viewport) => {
    const vp = viewport ? { width: positive(viewport.width, 'viewport.width'), height: positive(viewport.height, 'viewport.height') } : normalized.viewport;
    const local = localFrameOf(frame);
    // Active interval sits strictly between the two holds; a scope with no
    // active frames (holdIn + holdOut === frames - 1) resolves to the end state.
    const t = normalized.activeFrames <= 0 ? 1 : clamp((local - normalized.holdIn) / normalized.activeFrames, 0, 1);
    const e = ease(normalized.ease, t);
    // Plan the zoom in LOG space: equal eased steps give equal perceived
    // magnification steps, and the push never overshoots its endpoints. The two
    // held endpoints are returned exactly (`from`/`to`), not via exp/log round-trip.
    const zoom = e <= 0
      ? normalized.zoom.from
      : e >= 1
        ? normalized.zoom.to
        : Math.exp(mix(Math.log(normalized.zoom.from), Math.log(normalized.zoom.to), e));
    const resolved = resolveCenter(normalized, zoom, vp);
    return {
      frame: local,
      globalFrame: normalized.startFrame + local,
      t: e,
      zoom,
      scale: resolved.scale,
      centerWorld: resolved.centerWorld,
      clamped: resolved.clamped,
      viewport: { width: vp.width, height: vp.height },
    };
  };

  const worldToScreen = (frame, pointWorld, viewport) => project(pointWorld, at(frame, viewport), viewport);

  const visibleWorldBounds = (frame, viewport) => {
    const sample = at(frame, viewport);
    const halfWidth = sample.viewport.width / 2 / sample.scale;
    const halfHeight = sample.viewport.height / 2 / sample.scale;
    const minX = sample.centerWorld.x - halfWidth;
    const minY = sample.centerWorld.y - halfHeight;
    return {
      minX,
      minY,
      maxX: sample.centerWorld.x + halfWidth,
      maxY: sample.centerWorld.y + halfHeight,
      x: minX,
      y: minY,
      width: halfWidth * 2,
      height: halfHeight * 2,
    };
  };

  return {
    frames: normalized.frames,
    startFrame: normalized.startFrame,
    worldAnchor: normalized.worldAnchor,
    anchorScreen: normalized.anchorScreen,
    zoom: normalized.zoom,
    ease: normalized.ease,
    aspect: normalized.aspect,
    spec: normalized,
    at,
    project,
    worldToScreen,
    visibleWorldBounds,
  };
}
