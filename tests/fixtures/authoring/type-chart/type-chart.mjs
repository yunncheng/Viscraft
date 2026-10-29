// type-chart.mjs — a reusable TYPE + CHART author module for a browser Source.
//
// It folds two recurring code-visual problems into one deterministic module:
//
//   * TYPOGRAPHY that is CJK-aware — measure a run, break it into lines by
//     width (CJK breaks per glyph, Latin/digits break per word, no line starts
//     on a closing punctuation), shrink a size until it truly fits, align, and
//     REVEAL-IN per glyph / per line on a staggered cadence; and
//   * a small DATA CHART — linear value→screen scaling, "nice" ticks, grid,
//     bars that grow from the zero baseline, a line drawn up to a moving head,
//     candles, annotations and a print-style frame — revealed in stages.
//
// ADAPTATION (source and full notices: rights.mjs and ../../../../THIRD_PARTY_NOTICES.md):
//   adapted from huashu-art-motion
//     scripts/engine/lib/typo.js, scripts/engine/lib/chart.js,
//     scripts/engine/lib/util.js
//   @ f178bd7754a71d6d399473af1501634548efa6cb (alchaincyf), MIT.
// The upstream files are IIFEs that hang `TY`/`CH`/`U` off `window` and drive a
// global stage via `U.onStage`. Here they are DE-GLOBALIZED into pure ESM and
// the stage loop becomes an explicit `stage` {width,height} passed in — every
// mechanism is a PURE FUNCTION of its arguments, with no wall clock and no
// unseeded randomness. `renderTypeChart(canvas, ctx)` is the only canvas-bound
// entry, and it is a pure function of (frame, time, width, height, seed, params).
//
// DROPPED UPSTREAM MECHANISMS (and why):
//   * `TY.slam` and `TY.keyword`'s spring "hit", and `CH.callout`'s spring dot +
//     pulse ring, all call `MO.spring`/`MO.springHz`. That spring lives in
//     `motion.js`, which is OUTSIDE this module's licensed file set, so it is
//     not ported. `calloutFrame` keeps the annotation *mechanism* (dot → leader
//     line → text) on the eased clocks declared in `EASINGS` instead of a
//     spring; `charRevealFrame`/`lineRevealFrame` cover the staggered entrance.
//   * `U.loadCmaps` / `U.assertGlyphs` (WOFF/TTF cmap table parsing for a
//     bundled font set) are not ported: this module BUNDLES NO FONTS. It takes a
//     font FAMILY in `params` and relies on a generic system family
//     (`'sans-serif'`) by default, so the module has no font dependency and no
//     network access. See README.md — that is exactly why CJK glyph coverage is
//     the host's system-font responsibility.
//   * `U.poly` (a `Path2D` builder) is a thin browser convenience; the trace
//     helpers here build paths directly on the passed context.
//
// TIME OWNERSHIP: the module owns *reveal* time only, as a pure map
// frame -> progress (see `revealProgress`). The host owns real time; the author
// must NOT feed render timing, `Date.now()` or `Math.random()` in.

// ---------------------------------------------------------------------------
// Math + easing (from util.js `U`, de-globalized; a couple of standard curves
// are added where typo.js/chart.js reached for `MO.*`).
// ---------------------------------------------------------------------------

export const TAU = Math.PI * 2;

/** Clamp `x` into [lo, hi] (defaults [0, 1]). */
export const clamp = (x, lo = 0, hi = 1) => (x < lo ? lo : x > hi ? hi : x);
/** Linear mix: `a` at t=0, `b` at t=1. */
export const lerp = (a, b, t) => a + (b - a) * t;
/** Normalise `p`'s [a,b] span to 0..1 (util.js `U.seg`). */
export const seg = (p, a, b) => clamp((p - a) / (b - a));
/** Quantise continuous time to `fps` steps (util.js `U.stepTime`). */
export const stepTime = (t, fps) => Math.floor(t * fps) / fps;

/**
 * Named easing curves. Each maps [0,1] -> [0,1]. `linear`, `inCubic`,
 * `outCubic`, `inOutCubic`, `outBack` and `smoothstep` come from util.js `U.ease`
 * / `U.ss`; `quintOut` and `expoOut` are the standard curves typo.js/chart.js
 * obtained from `MO.*` (which is why they must be spelled out here).
 */
export const EASINGS = {
  linear: (t) => t,
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  quintOut: (t) => 1 - Math.pow(1 - t, 5),
  expoOut: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  outBack: (t) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  smoothstep: (t) => t * t * (3 - 2 * t),
};

export const EASING_NAMES = Object.keys(EASINGS);

/** Resolve an easing by name (or an explicit [0,1]->[0,1] function) and clamp t. */
export function ease(name, t) {
  const fn = typeof name === 'function' ? name : EASINGS[name ?? 'quintOut'];
  if (typeof fn !== 'function') throw new Error(`type-chart: unknown easing "${name}"`);
  const v = fn(clamp(t));
  return v === 0 ? 0 : v; // normalise -0 at the endpoints
}

// ---------------------------------------------------------------------------
// Text: font spec, measuring, byte/width-aware breaking, fitting, alignment.
// ---------------------------------------------------------------------------

/**
 * A CSS font string from a font *spec*. This module bundles no fonts: `family`
 * is a family name resolved by the host system (default `'sans-serif'`).
 */
export function fontString({ size, family = 'sans-serif', weight = 400, style = 'normal' } = {}) {
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) throw new Error('type-chart: fontString needs a positive numeric size');
  const fam = String(family).trim();
  if (!fam) throw new Error('type-chart: fontString needs a non-empty family');
  const quoted = /["']/.test(fam) || /\s/.test(fam) ? `"${fam.replace(/["']/g, '')}"` : fam;
  return `${style} ${weight} ${n}px ${quoted}`;
}

// CJK-per-glyph + Latin/digits-per-word tokenizer (typo.js `TY.wrap`).
const TOKEN_RE = /[A-Za-z0-9.,%+\-'’]+\s*|\s+|./gu;
// A closing punctuation that must not start a line (CJK + ASCII forms).
const NO_LINE_START = /^[，。、：；！？」』）》,.!?)]$/;

/** Split text into wrap tokens: Latin words, whitespace runs, or single glyphs. */
export function tokenize(text) {
  return String(text).match(TOKEN_RE) || [];
}

/**
 * Build a measuring function bound to a canvas 2D context. The returned
 * `measure(text, size, letterSpacing?)` sets the font, measures, and restores
 * the context; results are cached per (size, letterSpacing, text). Measurement
 * is the only text operation that needs a canvas, so everything that consumes a
 * `measure` callback stays runnable in Node.
 */
export function createMeasure(ctx, { family = 'sans-serif', weight = 400 } = {}) {
  if (!ctx || typeof ctx.measureText !== 'function') throw new Error('type-chart: createMeasure needs a canvas 2D context');
  const cache = new Map();
  return (text, size, letterSpacing = 0) => {
    const key = `${size}|${letterSpacing}|${text}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    ctx.save();
    ctx.font = fontString({ size, family, weight });
    if (letterSpacing) ctx.letterSpacing = `${letterSpacing}px`;
    const w = ctx.measureText(String(text)).width;
    ctx.restore();
    cache.set(key, w);
    return w;
  };
}

/**
 * Break `text` into lines no wider than `maxW`. CJK breaks between glyphs;
 * Latin words, numbers and `%` stay together; a trailing closing punctuation is
 * pulled down with the next line rather than starting one (typo.js `TY.wrap`).
 * `measure(str)` measures at the currently-set font size.
 */
export function breakLines(text, maxW, measure) {
  if (typeof measure !== 'function') throw new Error('type-chart: breakLines needs a measure function');
  const toks = tokenize(text);
  const lines = [];
  let cur = '';
  for (const tk of toks) {
    if (tk === '\n') {
      lines.push(cur);
      cur = '';
      continue;
    }
    if (cur && measure(cur + tk.trimEnd()) > maxW && !NO_LINE_START.test(tk)) {
      lines.push(cur.trimEnd());
      cur = tk.trimStart();
    } else cur += tk;
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  return lines;
}

/**
 * Shrink `size` until the text both fits `maxW` AND uses no more than
 * `maxLines` lines — checking the measured width of every line (a single long
 * Latin word that cannot break would otherwise overflow even though the line
 * COUNT is fine). `measure(str, size)` measures at an arbitrary size.
 * Returns `{ size, lines, ok }` (`ok:false` when `soft` gave up above `min`).
 */
export function fitText(text, { maxW, size, maxLines = 2, min = 0.45, soft = false, measure } = {}) {
  if (typeof measure !== 'function') throw new Error('type-chart: fitText needs a measure function');
  if (!(maxW > 0)) throw new Error('type-chart: fitText needs maxW > 0');
  const atSize = (s) => (str) => measure(str, s);
  let sizeAt = size;
  const ok = (lines) => lines.length <= maxLines && lines.every((l) => measure(l, sizeAt) <= maxW + 0.5);
  let lines = [String(text)];
  let good = false;
  for (; sizeAt >= size * (soft ? min : 0.2) - 1e-9; sizeAt *= 0.94) {
    lines = breakLines(text, maxW, atSize(sizeAt));
    if (ok(lines)) {
      good = true;
      break;
    }
    if (sizeAt < size * min && soft) break;
  }
  if (!good && !soft) sizeAt /= 0.94;
  return { size: sizeAt, lines, ok: good };
}

/** The x at which a run of width `w` should start to satisfy `align` around `x`. */
export function alignX(align, x, w) {
  if (align === 'left') return x;
  if (align === 'right') return x - w;
  if (align === 'center') return x - w / 2;
  throw new Error(`type-chart: unknown align "${align}"`);
}

/**
 * Lay `str` out on a per-cell grid so digits all occupy `digitW` (tabular
 * figures: a rolling number never jitters in width). Returns the cell widths and
 * the total. `measure(str)` measures a single glyph at the current font.
 */
export function tabularCells(str, digitW, measure) {
  const chars = [...String(str)];
  const widths = chars.map((ch) => (/[0-9]/.test(ch) ? digitW : measure(ch)));
  return { chars, widths, total: widths.reduce((a, b) => a + b, 0) };
}

/** Thousands-separated number with a true minus sign (typo.js `TY.fmt`). */
export function formatNumber(v, dec = 0, sep = true) {
  const s = Math.abs(v).toFixed(dec);
  const [i, f] = s.split('.');
  const ii = sep ? i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : i;
  return (v < 0 ? '−' : '') + ii + (f ? '.' + f : '');
}

// ---------------------------------------------------------------------------
// Reveal-in: per glyph, per line, and by character count.
// ---------------------------------------------------------------------------

/** The visible prefix of `str` at progress `p` (typo.js `TY.typed`). */
export function revealCount(str, p) {
  const chars = [...String(str)];
  return chars.slice(0, Math.round(clamp(p) * chars.length)).join('');
}

/** How many characters a typewriter has emitted at time `t` (typo.js `TY.typedCount`). */
export function typedCount(t, t0, rate, fps = 0) {
  const tt = fps ? stepTime(t, fps) : t;
  return Math.max(0, Math.floor((tt - t0) * rate + 1e-6) + 1);
}

/**
 * Precompute the per-glyph layout of a run: the character widths (plus
 * `spacing`) and the total width. Pure — call it once, then `charRevealFrame`
 * per frame.
 */
export function charRevealSpec(str, { measure, size, spacing = 0 } = {}) {
  if (typeof measure !== 'function') throw new Error('type-chart: charRevealSpec needs a measure function');
  const chars = [...String(str)];
  const widths = chars.map((ch) => measure(ch, size) + spacing);
  const total = widths.reduce((a, b) => a + b, 0) - (chars.length ? spacing : 0);
  return { chars, widths, spacing, total };
}

/**
 * The staggered per-glyph reveal. Two drivers, one geometry:
 *
 *  - **time mode** (default): glyph `i` animates over `dur` seconds starting at
 *    `i*stagger`, so pass elapsed seconds as `t`;
 *  - **driver mode**: pass `driver` (a 0..1 progress, e.g. from
 *    `revealProgress`) and glyph `i` gets `lagged(i, count, driver, cascade)` —
 *    the cascade then always *completes* when the driver reaches 1, however
 *    many frames the reveal spans.
 *
 * Each glyph rises from `dy`, scales from `scale0` and fades in. PURE function
 * of (`t` or `driver`). Returns per-glyph `{ char, index, progress, alpha,
 * scale, x, y, visible }` plus the total width.
 */
export function charRevealFrame(spec, t, { x = 0, y = 0, dur = 0.35, stagger = 0.04, dy = 24, scale0 = 1, align = 'left', ease: easeName = 'outCubic', driver, cascade = 0.55 } = {}) {
  const { chars, widths, total } = spec;
  const startX = alignX(align, x, total);
  let cx = startX;
  const glyphs = chars.map((ch, i) => {
    const q = driver === undefined ? clamp((t - i * stagger) / dur) : lagged(i, chars.length, driver, cascade);
    const e = ease(easeName, q);
    const g = {
      char: ch,
      index: i,
      progress: q,
      alpha: clamp(q * 2.2),
      scale: lerp(scale0, 1, e),
      x: cx + widths[i] / 2,
      y: y + dy * (1 - e),
      visible: q > 0,
    };
    cx += widths[i];
    return g;
  });
  return { glyphs, totalWidth: total, startX };
}

/**
 * The staggered per-line reveal (fade + rise). Same two drivers as
 * `charRevealFrame`: elapsed seconds `t` (default) or a 0..1 `driver`. PURE.
 */
export function lineRevealFrame(lines, t, { stagger = 0.12, dur = 0.4, dy = 18, ease: easeName = 'outCubic', driver, cascade = 0.55 } = {}) {
  return lines.map((line, i) => {
    const q = driver === undefined ? clamp((t - i * stagger) / dur) : lagged(i, lines.length, driver, cascade);
    const e = ease(easeName, q);
    return { line, index: i, progress: q, alpha: q, dy: (1 - e) * dy };
  });
}

/**
 * A highlighter bar that wipes left→right (typo.js `TY.marker`): a skewed quad
 * behind the text. Pure — returns the four corners.
 */
export function markerRect(x, y, w, h, p, { skew = 0.18, ease: easeName = 'expoOut' } = {}) {
  const e = ease(easeName, clamp(p));
  const ww = w * e;
  return [
    [x + h * skew, y],
    [x + ww + h * skew, y],
    [x + ww, y + h],
    [x, y + h],
  ];
}

/** A ruler that draws left→right (typo.js `TY.underline`). Pure. */
export function underlineSegment(x, y, w, p, { ease: easeName = 'expoOut' } = {}) {
  const e = ease(easeName, clamp(p));
  return { x0: x, y0: y, x1: x + w * e, y1: y };
}

// ---------------------------------------------------------------------------
// Chart: scales, ticks, colour, and the geometry of each mark.
// ---------------------------------------------------------------------------

/** Linear value→screen mapping; `f.inv(y)` inverts it (chart.js `CH.lin`). */
export function linearScale(d0, d1, r0, r1) {
  if (d1 === d0) throw new Error('type-chart: linearScale needs a non-zero domain (d0 !== d1)');
  const f = (v) => r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
  f.inv = (y) => d0 + ((y - r0) / (r1 - r0)) * (d1 - d0);
  return f;
}

/** "Nice" 1/2/2.5/5×10^k ticks in [min,max] (chart.js `CH.ticks`). */
export function niceTicks(min, max, n = 5) {
  const raw = (max - min) / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const steps = [1, 2, 2.5, 5, 10];
  const step = steps.map((s) => s * mag).find((s) => s >= raw) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

/** `#rrggbb` -> [r,g,b]. */
export function parseHex(hex) {
  if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error(`type-chart: parseHex needs #rrggbb, got "${hex}"`);
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/** Mix two `#rrggbb` colours into an `rgb(...)` string (chart.js `CH.mixHex`). */
export function mixHex(a, b, t) {
  const A = parseHex(a);
  const B = parseHex(b);
  return `rgb(${lerp(A[0], B[0], t) | 0},${lerp(A[1], B[1], t) | 0},${lerp(A[2], B[2], t) | 0})`;
}

/**
 * Staggered sub-progress for item `index` of `count`: item 0 starts at p=0 and
 * item `count-1` starts at p=`lag`, and every item finishes at p=1. (This is
 * the `lagged` grace-note typo.js/chart.js took from `MO.lagged`; reimplemented
 * here so the module carries no dependency on the unselected motion.js.)
 */
export function lagged(index, count, p, lag) {
  const P = clamp(p);
  if (count <= 1) return P;
  const span = 1 - clamp(lag, 0, 1);
  const t0 = (index / (count - 1)) * clamp(lag, 0, 1);
  return clamp((P - t0) / span);
}

/**
 * Bar geometry at total progress `p`: each `{x,v}` grows from the zero baseline
 * `yS(0)` with its own lagged ease (chart.js `CH.bars`). Returns per-bar
 * `{ index, x, y, base, value, height, q }`. Pure — the scene draws the rects.
 */
export function barGeometry(data, yS, p, { lag = 0.18, ease: easeName = 'quintOut' } = {}) {
  const y0 = yS(0);
  return data.map((d, i) => {
    const q = lagged(i, data.length, p, lag);
    const e = ease(easeName, q);
    const v = d.v * e;
    const y = yS(v);
    return { index: i, x: d.x, y, base: y0, value: d.v, shown: v, height: y0 - y, q };
  });
}

/**
 * Line geometry at progress `p`: the polyline drawn up to a moving x (chart.js
 * `CH.line`), with the interpolated head point. Pure.
 */
export function lineGeometry(pts, p) {
  if (!Array.isArray(pts) || pts.length === 0) throw new Error('type-chart: lineGeometry needs a non-empty point list');
  const P = clamp(p);
  if (P <= 0) return { vis: [pts[0]], head: pts[0], xEnd: pts[0][0], q: 0 };
  const xEnd = lerp(pts[0][0], pts[pts.length - 1][0], P);
  const vis = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][0] <= xEnd) vis.push(pts[i]);
    else {
      const a = pts[i - 1];
      const b = pts[i];
      const q = (xEnd - a[0]) / (b[0] - a[0]);
      vis.push([xEnd, lerp(a[1], b[1], q)]);
      break;
    }
  }
  return { vis, head: vis[vis.length - 1], xEnd, q: P };
}

/** The polyline's y at screen x (chart.js `CH.yAt`). */
export function yAtX(pts, x) {
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][0] >= x) {
      const a = pts[i - 1];
      const b = pts[i];
      return lerp(a[1], b[1], (x - a[0]) / (b[0] - a[0]));
    }
  }
  return pts[pts.length - 1][1];
}

/**
 * Candlestick geometry at progress `p`: each row's body grows from open to
 * close, then its wick appears (chart.js `CH.candles`). Red-up/green-down by
 * default (the A-share convention the upstream documents).
 */
export function candleGeometry(rows, xs, yS, p, { lag = 0.06, up = '#e0322f', down = '#11a05a' } = {}) {
  return rows.map((r, i) => {
    const q = lagged(i, rows.length, p, lag);
    const body = ease('quintOut', seg(q, 0, 0.7));
    const wick = ease('quintOut', seg(q, 0.35, 1));
    const isUp = r.c >= r.o;
    const yo = yS(r.o);
    const yc = lerp(yo, yS(r.c), body);
    return { index: i, x: xs[i], yo, yc, isUp, colour: isUp ? up : down, wick, body, q };
  });
}

/** Grid-line reveal: one `{ value, y, e, alpha }` per tick (chart.js `CH.grid`). */
export function gridFrame(ys, yS, p, { lag = 0.12, ease: easeName = 'quintOut' } = {}) {
  return ys.map((v, i) => {
    const q = lagged(i, ys.length, p, lag);
    return { value: v, y: yS(v), q, e: ease(easeName, q), alpha: seg(q, 0.3, 1) };
  });
}

/** X-axis label reveal: `{ x, label, alpha, dy }` per item (chart.js `CH.xLabels`). */
export function xLabelFrame(items, p, { lag = 0.1, ease: easeName = 'quintOut' } = {}) {
  return items.map((it, i) => {
    const q = ease(easeName, lagged(i, items.length, p, lag));
    return { x: it.x, label: it.label, alpha: q, dy: (1 - q) * 14 };
  });
}

export function placeCalloutText({ textWidth, leaderX, gap, leftLimit, rightLimit }) {
  let x = leaderX + gap;
  let align = 'left';
  if (x + textWidth > rightLimit) {
    // Prefer the left side of the leader anchor when the right side would run
    // past the frame; keep a right-aligned run inside the left limit.
    x = leaderX - gap;
    align = 'right';
    if (x - textWidth < leftLimit) {
      // Neither side fits: clamp a left-aligned box inside the frame.
      align = 'left';
      x = Math.max(leftLimit, rightLimit - textWidth);
    }
  }
  return { x, align };
}

/**
 * Annotation reveal at `t` seconds since `t0` (chart.js `CH.callout`, minus the
 * spring): a dot scales up, a leader line then draws, then the text fades in.
 * Pure; returns `null` before the annotation starts.
 */
export function calloutFrame(t, t0, { r = 11 } = {}) {
  const k = t - t0;
  if (k <= 0) return null;
  return {
    dotR: r * Math.max(0, ease('outBack', seg(k, 0, 0.45))),
    lineP: ease('quintOut', seg(k, 0.12, 0.45)),
    textP: ease('quintOut', seg(k, 0.3, 0.7)),
  };
}

// ---------------------------------------------------------------------------
// Staged reveal: the frame -> progress map (replaces the upstream stage loop).
// ---------------------------------------------------------------------------

/**
 * The whole reveal's progress at an integer frame: 0 at `startFrame`, 1 at
 * `startFrame + frames - 1`. PURE function of the frame — the same frame gives
 * the same progress regardless of sampling order — so the individual mark
 * reveals (`barGeometry`, `lineGeometry`, ...) can be driven from it.
 */
export function revealProgress(frame, { startFrame = 0, frames = 24, ease: easeName = 'quintOut' } = {}) {
  if (!Number.isFinite(frame)) throw new Error('type-chart: revealProgress needs a finite frame');
  const span = Math.max(1, frames - 1);
  return ease(easeName, clamp((frame - startFrame) / span));
}

// ---------------------------------------------------------------------------
// Params.
// ---------------------------------------------------------------------------

export const DEFAULT_PALETTE = {
  bg: '#f7f6f2',
  panel: '#ffffff',
  ink: '#141414',
  sub: '#4f5b61',
  rule: '#e3120b',
  grid: 'rgba(0,0,0,0.12)',
  zero: '#141414',
  axis: '#5b5b5b',
  bar: '#1f5c99',
  barDim: '#b9c3cc',
  line: '#e3120b',
  accent: '#ffd166',
  source: '#7c868b',
};

export const DEFAULT_PARAMS = {
  // Text (mixed CJK + Latin by default to exercise the CJK-aware wrapper).
  text: '数据叙事 Data Story',
  subtitle: 'Index, 2020 = 100 · 示意数据',
  source: 'Source: illustrative figures',
  badge: '示意数据',
  fontFamily: 'sans-serif',
  fontWeight: 700,
  // Chart data.
  chart: {
    values: [38, 52, 44, 61, 55, 72, 80],
    labels: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7'],
    unit: 'index',
    yMin: 0,
    yMax: 90,
    tickCount: 5,
    highlight: 6,
  },
  // Reveal.
  revealFrames: 24,
  startFrame: 0,
  layout: 'chart', // 'chart' | 'type'
  palette: { ...DEFAULT_PALETTE },
};

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function num(value, fallback, label, { min, max, integer } = {}) {
  const v = value === undefined ? fallback : value;
  if (!finite(v)) throw new Error(`type-chart: ${label} must be a finite number`);
  if (integer && !Number.isInteger(v)) throw new Error(`type-chart: ${label} must be an integer`);
  if (min !== undefined && v < min) throw new Error(`type-chart: ${label} must be >= ${min}`);
  if (max !== undefined && v > max) throw new Error(`type-chart: ${label} must be <= ${max}`);
  return v;
}

function colour(value, fallback, label) {
  const v = value === undefined ? fallback : value;
  if (typeof v !== 'string' || !/^(#[0-9a-fA-F]{6}|rgba?\([^)]*\))$/.test(v)) {
    throw new Error(`type-chart: ${label} must be a #rrggbb or rgb()/rgba() colour`);
  }
  return v;
}

function text(value, fallback, label) {
  const v = value === undefined ? fallback : value;
  if (typeof v !== 'string') throw new Error(`type-chart: ${label} must be a string`);
  return v;
}

/** Validate and fill a Source's `params`; unknown/invalid values fail loudly. */
export function normalizeParams(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('type-chart: params must be an object');
  const layout = raw.layout === undefined ? DEFAULT_PARAMS.layout : raw.layout;
  if (layout !== 'chart' && layout !== 'type') throw new Error(`type-chart: unknown layout "${layout}"; expected "chart" or "type"`);

  const cIn = raw.chart === undefined ? {} : raw.chart;
  if (cIn === null || typeof cIn !== 'object' || Array.isArray(cIn)) throw new Error('type-chart: chart must be an object');
  const values = cIn.values === undefined ? DEFAULT_PARAMS.chart.values : cIn.values;
  if (!Array.isArray(values) || values.length === 0 || !values.every(finite)) {
    throw new Error('type-chart: chart.values must be a non-empty array of finite numbers');
  }
  const labels = cIn.labels === undefined ? DEFAULT_PARAMS.chart.labels : cIn.labels;
  if (!Array.isArray(labels) || labels.length !== values.length || !labels.every((l) => typeof l === 'string')) {
    throw new Error('type-chart: chart.labels must be an array of strings the same length as chart.values');
  }
  const highlight = cIn.highlight === undefined ? DEFAULT_PARAMS.chart.highlight : cIn.highlight;
  if (!Number.isInteger(highlight) || highlight < -1 || highlight >= values.length) {
    throw new Error('type-chart: chart.highlight must be an integer in [-1, values.length)`');
  }
  const yMin = num(cIn.yMin, DEFAULT_PARAMS.chart.yMin, 'chart.yMin');
  const yMax = num(cIn.yMax, DEFAULT_PARAMS.chart.yMax, 'chart.yMax');
  if (!(yMax > yMin)) throw new Error('type-chart: chart.yMax must be > chart.yMin');

  const pIn = raw.palette === undefined ? {} : raw.palette;
  if (pIn === null || typeof pIn !== 'object' || Array.isArray(pIn)) throw new Error('type-chart: palette must be an object');
  const palette = {};
  for (const key of Object.keys(DEFAULT_PALETTE)) palette[key] = colour(pIn[key], DEFAULT_PALETTE[key], `palette.${key}`);

  return {
    text: text(raw.text, DEFAULT_PARAMS.text, 'text'),
    subtitle: text(raw.subtitle, DEFAULT_PARAMS.subtitle, 'subtitle'),
    source: text(raw.source, DEFAULT_PARAMS.source, 'source'),
    badge: text(raw.badge, DEFAULT_PARAMS.badge, 'badge'),
    fontFamily: text(raw.fontFamily, DEFAULT_PARAMS.fontFamily, 'fontFamily'),
    fontWeight: num(raw.fontWeight, DEFAULT_PARAMS.fontWeight, 'fontWeight', { integer: true, min: 1, max: 1000 }),
    layout,
    chart: {
      values: values.slice(),
      labels: labels.slice(),
      unit: text(cIn.unit, DEFAULT_PARAMS.chart.unit, 'chart.unit'),
      yMin,
      yMax,
      tickCount: num(cIn.tickCount, DEFAULT_PARAMS.chart.tickCount, 'chart.tickCount', { integer: true, min: 2, max: 12 }),
      highlight,
    },
    revealFrames: num(raw.revealFrames, DEFAULT_PARAMS.revealFrames, 'revealFrames', { integer: true, min: 2 }),
    startFrame: num(raw.startFrame, DEFAULT_PARAMS.startFrame, 'startFrame', { integer: true, min: 0 }),
    palette,
  };
}

// ---------------------------------------------------------------------------
// Render — the one canvas-bound entry point. Pure in its arguments.
// ---------------------------------------------------------------------------

function line(ctx, ax, ay, bx, by) {
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.stroke();
}

function tracePoly(ctx, pts) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
}

/**
 * Draw one deterministic frame. `ctx` is the CodeScene render argument:
 * { frame, time, fps, width, height, seed, params, bindings }. Everything drawn
 * is a pure function of (frame, seed, params, width, height) — the reveal is
 * driven from the frame index (`revealProgress`), so `time`/`fps` are accepted
 * but not needed. No wall clock, no `Math.random`.
 */
export function renderTypeChart(canvas, ctx) {
  if (!canvas || typeof canvas.getContext !== 'function') throw new Error('type-chart: renderTypeChart needs a canvas element');
  const params = normalizeParams(ctx?.params ?? {});
  const width = Math.max(8, Math.floor(ctx?.width ?? canvas.width));
  const height = Math.max(8, Math.floor(ctx?.height ?? canvas.height));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const g = canvas.getContext('2d');
  const frame = finite(ctx?.frame) ? Math.round(ctx.frame) : 0;
  const pal = params.palette;

  const measure = createMeasure(g, { family: params.fontFamily, weight: params.fontWeight });
  const u = Math.min(width, height);

  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.textBaseline = 'alphabetic';
  g.lineJoin = 'round';
  g.lineCap = 'round';

  g.fillStyle = pal.bg;
  g.fillRect(0, 0, width, height);

  const p = revealProgress(frame, { startFrame: params.startFrame, frames: params.revealFrames });

  // --- layout 'type': a pure typographic card (no chart) -------------------
  // Uses the same reveal progress but exercises the per-glyph / per-line
  // mechanisms, the highlighter and a tabular counting number.
  if (params.layout === 'type') {
    const padX = width * 0.08;
    const cx = width / 2;
    const fit = fitText(params.text, {
      maxW: width - padX * 2,
      size: Math.round(u * 0.17),
      maxLines: 3,
      min: 0.4,
      measure: (s, sz) => measure(s, sz),
    });
    const subSize = Math.round(u * 0.05);
    const numSize = Math.round(u * 0.13);
    const lead = fit.size * 1.18;
    const headBlock = fit.size + (fit.lines.length - 1) * lead;
    // A centred vertical stack (headline → subtitle → figure) with explicit
    // gaps, so however the headline fits, nothing overlaps.
    const subGap = subSize * 1.6;
    const numGap = numSize * 1.5;
    const content = headBlock + subGap + subSize + numGap + numSize;
    const top = Math.max(height * 0.1, (height - content) / 2);
    g.textAlign = 'center';
    for (const [i, lineText] of fit.lines.entries()) {
      const spec = charRevealSpec(lineText, { measure: (ch, sz) => measure(ch, sz), size: fit.size, spacing: fit.size * 0.01 });
      const baseY = top + fit.size + i * lead;
      if (i === 0) {
        const corners = markerRect(cx - spec.total / 2, baseY - fit.size * 0.92, spec.total, fit.size * 1.12, ease('expoOut', seg(p, 0.25, 0.7)));
        g.globalAlpha = 0.85;
        g.fillStyle = pal.accent;
        g.beginPath();
        corners.forEach((c, k) => (k ? g.lineTo(c[0], c[1]) : g.moveTo(c[0], c[1])));
        g.closePath();
        g.fill();
        g.globalAlpha = 1;
      }
      // The whole cascade is driven by the reveal progress, so it *completes* on
      // the last authored frame however short the reveal is.
      const lineDriver = lagged(i, fit.lines.length, p, 0.45);
      const frameGlyphs = charRevealFrame(spec, 0, { x: cx, y: baseY, align: 'center', dy: fit.size * 0.6, driver: lineDriver, cascade: 0.5 });
      g.font = fontString({ size: fit.size, family: params.fontFamily, weight: params.fontWeight });
      g.fillStyle = pal.ink;
      for (const gl of frameGlyphs.glyphs) {
        if (!gl.visible) continue;
        g.save();
        g.globalAlpha = gl.alpha;
        g.translate(gl.x, gl.y);
        g.scale(gl.scale, gl.scale);
        g.fillText(gl.char, 0, 0);
        g.restore();
      }
    }

    const subFrame = lineRevealFrame([params.subtitle], 0, { driver: seg(p, 0.6, 1) })[0];
    const subW = measure(params.subtitle, subSize);
    const subY = top + headBlock + subGap;
    g.font = fontString({ size: subSize, family: params.fontFamily, weight: 400 });
    g.fillStyle = pal.sub;
    g.globalAlpha = subFrame.alpha;
    g.fillText(params.subtitle, cx, subY + subFrame.dy);
    g.globalAlpha = 1;
    const uSpan = underlineSegment(cx - subW / 2, subY + subSize * 0.45, subW, seg(p, 0.55, 0.9));
    g.strokeStyle = pal.rule;
    g.lineWidth = Math.max(2, u * 0.008);
    line(g, uSpan.x0, uSpan.y0, uSpan.x1, uSpan.y1);

    // A tabular counting figure: digits share one cell so the number never jitters.
    const last = params.chart.values[params.chart.values.length - 1];
    const shown = Math.round(lerp(0, last, ease('quintOut', seg(p, 0.3, 1))));
    const numY = subY + subSize + numGap;
    g.font = fontString({ size: numSize, family: params.fontFamily, weight: params.fontWeight });
    g.fillStyle = pal.rule;
    const cells = tabularCells(formatNumber(shown, 0), measure('0', numSize), (ch) => measure(ch, numSize));
    let nx = cx - cells.total / 2;
    for (const [i, ch] of cells.chars.entries()) {
      g.fillText(ch, nx + cells.widths[i] / 2, numY);
      nx += cells.widths[i];
    }

    return { frame, layout: 'type', reveal: p, lines: fit.lines.slice(), fittedSize: fit.size, shown };
  }

  // --- layout 'chart': the print-style frame + the data chart --------------

  const padX = width * 0.07;
  const padTop = height * 0.14;
  const padBottom = height * 0.12;

  // --- print-style frame: top rule, title block, source, demo badge ---------
  const ruleP = ease('quintOut', seg(p, 0.02, 0.3));
  g.fillStyle = pal.rule;
  g.fillRect(0, 0, width * ruleP, Math.max(2, u * 0.012));

  const titleSize = Math.round(u * 0.085);
  const titleFit = fitText(params.text, {
    maxW: width - padX * 2,
    size: titleSize,
    maxLines: 2,
    min: 0.5,
    measure: (s, sz) => measure(s, sz),
  });
  const titleTop = padTop;
  g.fillStyle = pal.ink;
  g.font = fontString({ size: titleFit.size, family: params.fontFamily, weight: params.fontWeight });
  g.textAlign = 'left';
  for (const [i, lineText] of titleFit.lines.entries()) {
    // Frame-driven per-line reveal (completes on the last authored frame).
    const q = ease('outCubic', lagged(i, titleFit.lines.length, seg(p, 0.02, 0.35), 0.4));
    g.globalAlpha = q;
    // The CJK-aware break is what put these lines here; the reveal is per line.
    g.fillText(lineText, padX, titleTop + titleFit.size + i * titleFit.size * 1.18 + (1 - q) * u * 0.02);
  }
  g.globalAlpha = 1;

  const subSize = Math.round(u * 0.042);
  g.font = fontString({ size: subSize, family: params.fontFamily, weight: 400 });
  g.fillStyle = pal.sub;
  const subP = ease('quintOut', seg(p, 0.1, 0.4));
  g.globalAlpha = subP;
  g.fillText(params.subtitle, padX, titleTop + titleFit.size * (titleFit.lines.length * 1.18 + 0.35));
  g.globalAlpha = 1;

  // --- the chart proper ----------------------------------------------------
  const chartBottom = height - padBottom;
  const chartTop = padTop + titleFit.size * (titleFit.lines.length * 1.18 + 0.9);
  const chartLeft = padX;
  const chartRight = width - padX;
  const F = { x: chartLeft, y: chartTop, w: chartRight - chartLeft, h: chartBottom - chartTop };

  const { values, labels, yMin, yMax, tickCount, highlight, unit } = params.chart;
  const yS = linearScale(yMin, yMax, F.y + F.h, F.y); // value -> screen y
  const ys = niceTicks(yMin, yMax, tickCount);

  // 1) coordinate system first: grid + y labels + x labels.
  const gFrame = gridFrame(ys, yS, p);
  const tickSize = Math.round(u * 0.032);
  g.font = fontString({ size: tickSize, family: params.fontFamily, weight: 400 });
  for (const row of gFrame) {
    if (row.q <= 0) continue;
    const y = Math.round(row.y) + 0.5;
    const isZero = Math.abs(row.value) < 1e-9;
    g.strokeStyle = isZero ? pal.zero : pal.grid;
    g.lineWidth = isZero ? Math.max(1.5, u * 0.006) : 1;
    line(g, F.x, y, F.x + F.w * row.e, y);
    g.globalAlpha = row.alpha;
    g.fillStyle = pal.axis;
    g.textAlign = 'left';
    g.fillText(formatNumber(row.value, 0), F.x, y - u * 0.012);
    g.globalAlpha = 1;
  }

  // the axis unit, right-aligned on the top tick's baseline (never left of it)
  if (unit) {
    g.fillStyle = pal.axis;
    g.textAlign = 'right';
    g.fillText(unit, F.x + F.w, F.y - u * 0.012);
    g.textAlign = 'left';
  }

  const bw = (F.w / values.length) * 0.52;
  const barData = values.map((v, i) => ({ x: F.x + (F.w / values.length) * (i + 0.5), v }));
  const xItems = barData.map((d, i) => ({ x: d.x, label: labels[i] }));
  g.font = fontString({ size: tickSize, family: params.fontFamily, weight: 400 });
  for (const it of xLabelFrame(xItems, p)) {
    if (it.alpha <= 0) continue;
    g.globalAlpha = it.alpha;
    g.fillStyle = pal.axis;
    g.textAlign = 'center';
    g.fillText(it.label, it.x, F.y + F.h + u * 0.05 + it.dy);
    g.globalAlpha = 1;
  }

  // 2) data next: bars grow from zero, highlighted bar stays saturated.
  const bars = barGeometry(barData, yS, p, { lag: 0.22 });
  for (const b of bars) {
    if (b.q <= 0) continue;
    const isHi = b.index === highlight;
    g.fillStyle = highlight >= 0 && !isHi ? mixHex(pal.bar, pal.barDim, 0.55) : pal.bar;
    g.fillRect(b.x - bw / 2, b.y, bw, b.base - b.y);
    // value label, tabular so a rolling figure never jitters
    g.font = fontString({ size: tickSize, family: params.fontFamily, weight: 700 });
    g.fillStyle = pal.ink;
    g.globalAlpha = seg(b.q, 0.4, 1);
    const cells = tabularCells(formatNumber(b.value, 0), measure('0', tickSize), (ch) => measure(ch, tickSize));
    let cx = b.x - cells.total / 2;
    g.textAlign = 'center';
    cells.chars.forEach((ch, i) => {
      g.fillText(ch, cx + cells.widths[i] / 2, b.y - u * 0.014);
      cx += cells.widths[i];
    });
    g.globalAlpha = 1;
  }

  // 3) a line drawn up to a moving head (the same data, as a trend).
  const linePts = values.map((v, i) => [barData[i].x, yS(v)]);
  const lg = lineGeometry(linePts, ease('inOutCubic', clamp((p - 0.25) / 0.75)));
  const lw = Math.max(2, u * 0.011);
  g.strokeStyle = pal.line;
  g.lineWidth = lw;
  if (lg.vis.length > 1) {
    tracePoly(g, lg.vis);
    g.stroke();
  }
  if (p > 0.25) {
    g.fillStyle = pal.line;
    g.beginPath();
    g.arc(lg.head[0], lg.head[1], lw * 1.1, 0, TAU);
    g.fill();
    g.strokeStyle = pal.panel;
    g.lineWidth = Math.max(2, lw * 0.5);
    g.stroke();
  }

  // 4) annotation last: one callout on the peak — one annotated fact per shot.
  const hi = highlight >= 0 ? highlight : values.indexOf(Math.max(...values));
  // The annotation occupies the last 30% of the reveal (frame-driven, so it
  // appears no matter how long the reveal is).
  const co = calloutFrame(seg(p, 0.7, 1), 0);
  if (co && hi >= 0) {
    const dotX = barData[hi].x;
    const dotY = yS(values[hi]);
    const leaderX = Math.min(F.x + F.w - u * 0.02, dotX + F.w * 0.18);
    const leaderY = Math.max(F.y + titleFit.size * 0.4, dotY - F.h * 0.28);
    g.fillStyle = pal.rule;
    g.beginPath();
    g.arc(dotX, dotY, co.dotR, 0, TAU);
    g.fill();
    if (co.lineP > 0) {
      g.strokeStyle = pal.ink;
      g.lineWidth = Math.max(1.5, u * 0.004);
      line(g, dotX, dotY, lerp(dotX, leaderX, co.lineP), lerp(dotY, leaderY, co.lineP));
    }
    if (co.textP > 0) {
      const size = tickSize * 1.05;
      g.globalAlpha = co.textP;
      g.fillStyle = pal.ink;
      g.font = fontString({ size, family: params.fontFamily, weight: 700 });
      const text = `▲ ${labels[hi]} · ${formatNumber(values[hi], 0)}`;
      const gap = u * 0.02;
      const leftLimit = F.x + u * 0.01;
      const rightLimit = F.x + F.w - u * 0.01;
      const textWidth = g.measureText(text).width;
      const slide = (1 - co.textP) * -gap;
      // The leader anchor is clamped, but the TEXT box is wider than the anchor
      // slack: place it on whichever side of the anchor keeps the whole run
      // inside the chart frame (a right-edge annotation must not be cut off).
      const placed = placeCalloutText({ textWidth, leaderX, gap, leftLimit, rightLimit });
      g.textAlign = placed.align;
      g.fillText(text, placed.x + slide, leaderY);
      g.textAlign = 'left';
      g.globalAlpha = 1;
    }
  }

  // --- footer: source note + "illustrative data" badge every shot ----------
  const footSize = Math.round(u * 0.03);
  g.font = fontString({ size: footSize, family: params.fontFamily, weight: 400 });
  g.fillStyle = pal.source;
  g.textAlign = 'left';
  g.fillText(params.source, padX, height - padBottom * 0.3);
  if (params.badge) {
    const bwid = measure(params.badge, footSize) + u * 0.05;
    const bx = width - padX - bwid;
    const by = height - padBottom * 0.3 - footSize * 0.75;
    g.fillStyle = 'rgba(227,18,11,0.06)';
    g.beginPath();
    if (typeof g.roundRect === 'function') g.roundRect(bx, by, bwid, footSize * 1.5, u * 0.012);
    else g.rect(bx, by, bwid, footSize * 1.5);
    g.fill();
    g.fillStyle = pal.rule;
    g.textAlign = 'center';
    g.fillText(params.badge, bx + bwid / 2, by + footSize * 1.05);
  }
  g.globalAlpha = 1;

  return {
    frame,
    reveal: p,
    lines: titleFit.lines.slice(),
    fittedSize: titleFit.size,
    ticks: ys.slice(),
    bars: bars.length,
    highlight: hi,
  };
}
