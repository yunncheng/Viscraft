/**
 * Browser realization of a sampled World.
 *
 * A `World` is optional, persistent shared-space state:
 * entities that reference Project assets, optional trajectories, cameras, and a
 * fixed frame clock. It is *not* a second renderer and *not* a second asset
 * registry — it only supplies the deterministic spatial truth a renderer samples.
 *
 * The pure, browser-safe half of that contract — {@link sampleWorld} and the
 * {@link WorldFrame} snapshot types — lives in `world-state.ts`, which has no
 * Node-only imports. This module owns the browser-backed half:
 *
 * - {@link captureWorld} realizes a `world` source to a real PNG frame sequence by
 *   reusing the existing {@link captureCode} browser chain — no second browser
 *   engine. It installs `window.__viscraftWorld = sampleWorld(...)` immediately
 *   before each frame's render, so an author page reads the current snapshot from
 *   that global. The author-facing render `ctx.frame`/`ctx.time` stay the local
 *   clip clock; only the global snapshot crosses the world/clip boundary.
 *
 * {@link sampleWorld} and its snapshot types are re-exported here so the existing
 * `./world.js` import surface (see `index.ts`) is unchanged.
 *
 * Time: the World clock is the integer frame grid of `world.frames` and
 * `world.fps`. A `world` source maps its local clip frame `f` to the global World
 * frame `source.startFrame + f`; the source interval must stay inside the World
 * clock and its output fps must match the World fps, so no frame is re-quantized.
 */
import { captureCode, type CaptureBinding, type CaptureResult, type CaptureLifecycle } from '../browser/capture.js';
import { sampleWorld } from '../../core/world-state.js';
import type { BrowserPictureSource, OutputSettings, World } from '../../core/schema.js';

export { sampleWorld };
export type { WorldFrame, WorldEntitySample, WorldCameraSample, WorldTransform } from '../../core/world-state.js';

/** The live Puppeteer page handed to a capture lifecycle hook, derived from `CaptureLifecycle`. */
export type WorldCapturePage = Parameters<NonNullable<CaptureLifecycle['beforeFrame']>>[0];

/**
 * Install one sampled World frame on a capture page.
 *
 * Node-side companion to {@link sampleWorld}: samples `world` for `camera` at the
 * global `worldFrame`, then sets `globalThis.__viscraftWorld` on the live page to
 * that snapshot. Exposed so every browser-backed world path — `captureWorld`
 * here, plus `capturePlayable` and the code-with-world build path — shares one
 * injector instead of re-implementing the `page.evaluate` hand-off.
 */
export async function installWorldDefinition(page: WorldCapturePage, world: World): Promise<void> {
  await page.evaluateOnNewDocument(definition => {
    (globalThis as unknown as { __viscraftWorldDefinition: World }).__viscraftWorldDefinition = definition;
  }, world);
}

export async function applyWorldFrame(
  page: WorldCapturePage,
  world: World,
  camera: string,
  worldFrame: number,
): Promise<void> {
  const snapshot = sampleWorld(world, camera, worldFrame);
  await page.evaluate(value => {
    (globalThis as unknown as { __viscraftWorld: unknown }).__viscraftWorld = value;
  }, snapshot);
}

/**
 * Realize a browser `picture` Source with a World binding in mode `drive` to a
 * PNG frame sequence through the shared browser capture chain.
 *
 * Each local clip frame `f` in `[0, source.frames)` is rendered at the global
 * World frame `source.world.startFrame + f`, with `window.__viscraftWorld` set to
 * that frame's {@link WorldFrame} immediately before `window.viscraft.render`
 * runs. The author page reads `window.__viscraftWorld` for the spatial snapshot;
 * the render `ctx` (and `params`) are passed through unchanged. All validation
 * happens before the browser launches, so an inconsistent source/world fails fast.
 *
 * @param root Project root (path policy and snapshotting come from `captureCode`).
 * @param source A browser `picture` Source carrying a `world` binding (camera,
 *   start frame, clip length).
 * @param world The World the source references; must match `source.world.id`,
 *   contain `source.world.camera`, sit on the same fps grid as `output`, and
 *   cover the interval.
 * @param output Output settings; `output.fps` must equal `world.fps`.
 * @param destination Directory receiving `frame-%06d.png`.
 * @param bindings Frozen asset bindings for the entry page (unchanged).
 */
export async function captureWorld(
  root: string,
  source: BrowserPictureSource,
  world: World,
  output: OutputSettings,
  destination: string,
  bindings: Record<string, CaptureBinding> = {},
): Promise<CaptureResult> {
  const ref = source.world;
  if (!ref) throw new Error(`captureWorld: source "${source.id}" has no World binding`);
  if (world.id !== ref.id) {
    throw new Error(
      `captureWorld: source "${source.id}" references World "${ref.id}" but was given World "${world.id}"`,
    );
  }
  if (!world.cameras.some(camera => camera.id === ref.camera)) {
    throw new Error(`captureWorld: World "${world.id}" has no camera "${ref.camera}"`);
  }
  if (world.fps.numerator * output.fps.denominator !== output.fps.numerator * world.fps.denominator) {
    throw new Error(`captureWorld: source "${source.id}" output fps does not match World "${world.id}" frame grid`);
  }
  if (ref.startFrame! + source.frames > world.frames) {
    throw new Error(
      `captureWorld: source "${source.id}" interval [${ref.startFrame}, ${ref.startFrame! + source.frames}) exceeds World "${world.id}" clock of ${world.frames} frames`,
    );
  }

  const page = {
    id: source.id,
    entry: source.entry,
    resources: source.resources,
    params: source.params,
    seed: source.seed,
    frames: source.frames,
  };

  const lifecycle: CaptureLifecycle = {
    beforeFrame: async (page, frame) => {
      await applyWorldFrame(page, world, ref.camera, ref.startFrame! + frame);
    },
  };

  return captureCode(root, page, output, destination, bindings, lifecycle);
}
