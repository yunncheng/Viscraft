/**
 * Atlas reveal — the example's own author scene.
 *
 * This file is the part of the example the example OWNS: it is not a vendored
 * module but the small composition that puts TWO vendored author modules into
 * ONE frame. Every frame draws
 *
 *   1. a cel + watercolour terrain plate (./cel-watercolor.mjs) filling the
 *      frame, and
 *   2. an editorial data legend (./type-chart.mjs) composited into a panel.
 *
 * so the two modules are genuinely combined rather than shown side by side on
 * separate canvases. Both modules are pure functions of `(frame, seed, params)`
 * and repaint their whole surface on every call (the cel module lays a paper
 * base; the chart module fills its panel background), so the reused offscreen
 * surfaces never carry a previous frame's pixels. Nothing here uses the wall
 * clock, `Math.random` or `requestAnimationFrame`.
 *
 * The page contract (see atlas-scene.html) is
 * `window.viscraft = { render(ctx) }`, called once per frame.
 */

import { renderCelWatercolor } from './cel-watercolor.mjs';
import { renderTypeChart } from './type-chart.mjs';

// Two offscreen surfaces, created once and reused every frame. `??=` keeps the
// reference stable across calls; the memory of a module-scope module is fine
// because a capture renders frames in ascending order in one page.
let terrainSurface;
let legendSurface;

const DEFAULT_PANEL = { x: 0.52, y: 0.14, w: 0.42, h: 0.68, opacity: 0.97, border: 0.55 };

function finite(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Validate the panel rectangle. Out-of-range values fail loudly, never silently. */
function normalizePanel(raw) {
  const panel = raw && typeof raw === 'object' ? raw : {};
  const w = finite(panel.w, DEFAULT_PANEL.w);
  const h = finite(panel.h, DEFAULT_PANEL.h);
  if (w <= 0 || w > 1) throw new Error('atlas-scene: panel.w must be in (0, 1]');
  if (h <= 0 || h > 1) throw new Error('atlas-scene: panel.h must be in (0, 1]');
  return {
    x: finite(panel.x, DEFAULT_PANEL.x),
    y: finite(panel.y, DEFAULT_PANEL.y),
    w,
    h,
    opacity: finite(panel.opacity, DEFAULT_PANEL.opacity),
    border: finite(panel.border, DEFAULT_PANEL.border),
  };
}

/**
 * Compose the two vendored modules into one frame.
 *
 * `ctx` is the capture contract: `{ frame, time, fps, width, height, seed,
 * params, bindings }`. `params.terrain` is forwarded verbatim to the
 * cel-watercolor module, `params.legend` to the type-chart module, and
 * `params.panel` positions the legend. The canvas is resized to
 * `ctx.width × ctx.height` every call, so one scene frames any output size.
 */
export function renderAtlas(canvas, ctx = {}) {
  if (!canvas || typeof canvas.getContext !== 'function')
    throw new Error('atlas-scene: renderAtlas needs a canvas element');
  const width = Math.max(8, Math.floor(ctx.width ?? canvas.width ?? 640));
  const height = Math.max(8, Math.floor(ctx.height ?? canvas.height ?? 360));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const g = canvas.getContext('2d');

  const params = ctx.params ?? {};
  const terrainParams = params.terrain ?? {};
  const legendParams = params.legend ?? {};
  const panel = normalizePanel(params.panel);
  const seed = finite(ctx.seed, 0);
  const frame = finite(ctx.frame, 0);
  const fps = finite(ctx.fps, 24) > 0 ? ctx.fps : 24;
  const time = finite(ctx.time, frame / fps);

  // 1. The painted terrain plate fills the frame. The seed is offset so the two
  //    modules never key their generated geometry off the same stream.
  terrainSurface ??= document.createElement('canvas');
  renderCelWatercolor(terrainSurface, {
    frame,
    time,
    fps,
    width,
    height,
    seed: seed + 101,
    params: terrainParams,
  });

  // 2. The editorial legend, rendered at the panel's own size.
  const panelW = Math.max(48, Math.round(width * panel.w));
  const panelH = Math.max(36, Math.round(height * panel.h));
  legendSurface ??= document.createElement('canvas');
  renderTypeChart(legendSurface, {
    frame,
    time,
    fps,
    width: panelW,
    height: panelH,
    seed: seed + 211,
    params: legendParams,
  });

  // 3. Composite onto the visible canvas.
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.shadowBlur = 0;
  g.drawImage(terrainSurface, 0, 0, width, height);

  const px = Math.round(width * panel.x);
  const py = Math.round(height * panel.y);
  g.globalAlpha = panel.opacity;
  g.drawImage(legendSurface, px, py, panelW, panelH);
  g.globalAlpha = 1;

  if (panel.border > 0) {
    g.lineWidth = Math.max(1, Math.round(Math.min(width, height) * 0.004));
    g.strokeStyle = `rgba(24, 26, 24, ${panel.border})`;
    g.strokeRect(px + 0.5, py + 0.5, panelW - 1, panelH - 1);
  }

  // Exposed for verification/authoring convenience; the pixels are the contract.
  window.atlasState = {
    width,
    height,
    frame,
    subject: terrainParams.subject ?? 'grove',
    text: legendParams.text ?? '',
    panel: { x: px, y: py, w: panelW, h: panelH },
  };
}
