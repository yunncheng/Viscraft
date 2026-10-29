// glass-study.mjs — an author STUDY over the reusable `glass-product` Look.
//
// The reusable module (`glass-product.mjs`) is vendored byte-for-byte beside this file.
// This study does NOT fork it and does NOT change it. It authors three real changes on
// top of the module's own renderer:
//
//   1. PRODUCT PROPORTIONS. The module exports its case geometry as config (`CASE`) that
//      it reads when the Look is built. The study re-proportions the case before
//      `createLook()`: a narrower, deeper pebble with a lower lid. `CASE.hb` stays at the
//      module's 15 because the module's mirror floor height (`FLOOR_Y`) is a const and the
//      base must keep sitting on it.
//   2. MATERIAL. The module exports its light-guide palette as `ACCENT`, read when the
//      guide/edge materials and the aura light are built; its `accentA`/`accentB` params
//      update those same materials on every frame. The study recolours the exported
//      palette before `createLook()` so the Look is built with it, and carries the same
//      colours in its params — a real emissive material change, visible when the guide
//      ignites.
//   3. ONE CAMERA/LIGHTING BEAT. The module's `explode` beat is its only tight, single-bud,
//      hard-key camera. The study renders that beat with `explode: 0`, so the product stays
//      whole: the staging the module reserves for an exploded view becomes an intact detail
//      shot that ends on the module's own snap/ignition, lit by a slow exposure ramp instead
//      of the module's constant exposure. This beat is not shown intact anywhere in the
//      module's default piece.
//
// The study is a pure function of the frame clock exactly like the module: no wall clock,
// no unseeded randomness, no network. It builds the Look from the FIRST frame's params
// (geometry/material config must be set before `createLook`), then delegates every frame to
// the module's `render`.

import { ACCENT, BEATS, CASE, beatAt, clamp, createLook, lerp, normalizeParams } from './glass-product.mjs';

export const PRODUCT = 'AURELIS';

// The module's internal snap point inside its `explode` beat (`SNAP_U`): the moment the
// parts finish snapping together and the guide ignites. The study holds its detail shot
// across it, so the shot ends on a material reveal rather than a dissolve.
const MODULE_SNAP_U = 0.78;
const EXPLODE = BEATS.find((beat) => beat.name === 'explode');
export const IGNITION_X = EXPLODE.from + MODULE_SNAP_U * (EXPLODE.to - EXPLODE.from);

// The module's intrinsic beat clock. Its beats are fractions of this length, so the study
// drives the module at a fixed 4 s clock and maps its own frame clock onto it.
export const MODULE_CLOCK = 4;

export const CASE_VARIANT = { rx: 30, rz: 35, hb: 15, hl: 11 };
export const GUIDE_MATERIAL = { a: '#ffb25e', b: '#ff5f8f' };

/**
 * Two authored shots over one module. `baseFrom`/`baseTo` are positions on the module's
 * own clock (0..1), so the study says exactly which of the module's beats it is using.
 * `detail` sits inside the module's `explode` beat (0.64–0.88) and crosses the ignition;
 * `hero` is the module's `hero` beat (0.88–1).
 */
export const SHOTS = {
  detail: {
    baseFrom: 0.645,
    baseTo: 0.877,
    exposureFrom: 0.92,
    exposureTo: 1.18,
    bloom: 0.34,
    pulse: 1.25,
    explode: 0,
  },
  hero: {
    baseFrom: 0.88,
    baseTo: 0.999,
    exposureFrom: 1.08,
    exposureTo: 1.2,
    bloom: 0.3,
    pulse: 1,
    explode: 0,
  },
};

export const STUDY_DEFAULTS = {
  shot: 'detail',
  product: PRODUCT,
  // The study's own length in seconds. `create.mjs` sets it to `frames / fps`, the same
  // convention the module uses for its own `duration` param.
  duration: 1,
  accentA: GUIDE_MATERIAL.a,
  accentB: GUIDE_MATERIAL.b,
  caseRx: CASE_VARIANT.rx,
  caseRz: CASE_VARIANT.rz,
  caseHl: CASE_VARIANT.hl,
  exposureFrom: SHOTS.detail.exposureFrom,
  exposureTo: SHOTS.detail.exposureTo,
  bloom: SHOTS.detail.bloom,
  pulse: SHOTS.detail.pulse,
};

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function number(value, fallback, label, { min, max } = {}) {
  const v = value === undefined ? fallback : value;
  if (!finite(v)) throw new Error(`glass-study: ${label} must be a finite number`);
  if (min !== undefined && v < min) throw new Error(`glass-study: ${label} must be >= ${min}`);
  if (max !== undefined && v > max) throw new Error(`glass-study: ${label} must be <= ${max}`);
  return v;
}

function colour(value, fallback, label) {
  const v = value === undefined ? fallback : value;
  if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v))
    throw new Error(`glass-study: ${label} must be a #rrggbb colour`);
  return v;
}

/**
 * Validate and fill the study's params. `raw` is a Source's `params.study` object (the
 * module's own params are derived here, never authored twice).
 */
export function normalizeStudy(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('glass-study: study params must be an object');
  const shot = raw.shot === undefined ? STUDY_DEFAULTS.shot : raw.shot;
  if (!Object.prototype.hasOwnProperty.call(SHOTS, shot))
    throw new Error(`glass-study: shot must be one of ${Object.keys(SHOTS).join(', ')}`);
  const spec = SHOTS[shot];
  const base = {
    duration: number(raw.duration, STUDY_DEFAULTS.duration, 'duration', { min: 1e-3 }),
    accentA: colour(raw.accentA, STUDY_DEFAULTS.accentA, 'accentA'),
    accentB: colour(raw.accentB, STUDY_DEFAULTS.accentB, 'accentB'),
    caseRx: number(raw.caseRx, STUDY_DEFAULTS.caseRx, 'caseRx', { min: 24, max: 40 }),
    caseRz: number(raw.caseRz, STUDY_DEFAULTS.caseRz, 'caseRz', { min: 24, max: 46 }),
    caseHl: number(raw.caseHl, STUDY_DEFAULTS.caseHl, 'caseHl', { min: 6, max: 17 }),
  };
  return {
    ...base,
    shot,
    product: typeof raw.product === 'string' && raw.product.length > 0 ? raw.product : STUDY_DEFAULTS.product,
    // A shot's lighting defaults are the spec's; an explicit value is the authored override.
    exposureFrom: number(raw.exposureFrom, spec.exposureFrom, 'exposureFrom', { min: 0, max: 8 }),
    exposureTo: number(raw.exposureTo, spec.exposureTo, 'exposureTo', { min: 0, max: 8 }),
    bloom: number(raw.bloom, spec.bloom, 'bloom', { min: 0, max: 4 }),
    pulse: number(raw.pulse, spec.pulse, 'pulse', { min: 0, max: 8 }),
    explode: spec.explode,
  };
}

/** Every setting that forces a rebuild of the Look (geometry + materials). */
export function variantKey(study) {
  return JSON.stringify([study.caseRx, study.caseRz, study.caseHl, study.accentA, study.accentB]);
}

/** Progress 0..1 through a Source of `frames` frames at `fps` (frame N-1 is not the end). */
export function studyProgress(study, frame, fps) {
  const rate = finite(fps) && fps > 0 ? fps : 24;
  return clamp((Number.isFinite(frame) ? frame : 0) / rate / study.duration);
}

/**
 * The whole per-frame plan: where on the module's clock this study frame sits, which
 * module beat that is, the exposure at this point, and the exact module frame to render.
 * Pure — the test uses it to assert keyframes against the module's own `beatAt`.
 */
export function planFrame(rawParams, frame, fps) {
  const study = normalizeStudy(rawParams?.study ?? {});
  const spec = SHOTS[study.shot];
  const progress = studyProgress(study, frame, fps);
  const x = lerp(spec.baseFrom, spec.baseTo, progress);
  const rate = finite(fps) && fps > 0 ? fps : 24;
  const exposure = lerp(study.exposureFrom, study.exposureTo, progress);
  // The module derives its own beat from `t / duration`; feed it a frame that lands exactly
  // on `x` of its 4 s clock.
  const moduleFrame = x * MODULE_CLOCK * rate;
  const params = normalizeParams({
    duration: MODULE_CLOCK,
    product: study.product,
    accentA: study.accentA,
    accentB: study.accentB,
    bloom: study.bloom,
    exposure,
    orbit: 1,
    explode: study.explode,
    pulse: study.pulse,
  });
  return { study, progress, x, exposure, moduleFrame, beat: beatAt(x).name, params };
}

/** Read the case geometry + material palette config the module consumes at build time. */
export function applyVariant(study) {
  CASE.rx = study.caseRx;
  CASE.rz = study.caseRz;
  CASE.hb = CASE_VARIANT.hb;
  CASE.hl = study.caseHl;
  ACCENT.a = study.accentA;
  ACCENT.b = study.accentB;
}

/**
 * Build the study's Look. Geometry and materials are applied once, from the first frame's
 * params; every later frame must carry the same variant (a capture uses one params set per
 * Source, and a silent rebuild mid-capture would be a real bug, so it throws instead).
 */
export async function createStudyLook({ canvas } = {}) {
  if (!canvas || typeof canvas.getContext !== 'function')
    throw new Error('glass-study: createStudyLook needs a canvas element');
  let look = null;
  let built = null;

  return {
    async render(ctx = {}) {
      const plan = planFrame(ctx.params ?? {}, Number.isFinite(ctx.frame) ? ctx.frame : 0, ctx.fps);
      const key = variantKey(plan.study);
      if (look === null) {
        applyVariant(plan.study);
        look = await createLook({ canvas });
        built = key;
      } else if (key !== built) {
        throw new Error('glass-study: the product variant changed mid-capture; one Source must carry one product');
      }
      look.render({
        frame: plan.moduleFrame,
        fps: Number.isFinite(ctx.fps) && ctx.fps > 0 ? ctx.fps : 24,
        width: ctx.width,
        height: ctx.height,
        seed: ctx.seed,
        params: plan.params,
        bindings: ctx.bindings ?? {},
      });
    },
    dispose() {
      look?.dispose();
    },
  };
}
