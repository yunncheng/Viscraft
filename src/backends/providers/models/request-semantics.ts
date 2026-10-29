/** Shared model-side helpers for the two `A:B`-shaped authoring quantities that
 * must stay distinct, plus the generation-length relation between the model's
 * wire request and the author's expected take.
 *
 *  - `source.size` is the **raster canvas** the author wants the Take rendered
 *    in, `WIDTH:HEIGHT` in real pixels (e.g. `1280:720`). It is NEVER a symbolic
 *    ratio such as `16:9` — a model that accepts only a symbolic ratio must not
 *    be handed a fabricated `16x9` raster.
 *  - A model's own `ratio`/`resolution` parameter is the model-side aspect
 *    selector (a symbolic `16:9` for fal Wan, or an exact, dimension-shaped
 *    `1280:720` for Runway, whose ratio string IS its generation resolution).
 *
 * A model checks the two for **consistency** (aspect for a symbolic ratio;
 * exact equality when the ratio string is itself the resolution) so two
 * conflicting author intents are surfaced at Plan instead of silently dropped.
 *
 * These are model DEFINITION logic shared by several packaged models, not
 * transport normalization, so they live here rather than in any generic
 * transport helper.
 */
import type { ProviderSource } from '../../../core/schema.js';

export interface Raster {
  width: number;
  height: number;
}

/** Parse a raster canvas or a model ratio string `A:B` into its positive terms. */
export function parseTerms(value: string, what: string): Raster {
  const match = /^([1-9]\d{0,4}):([1-9]\d{0,4})$/.exec(value);
  if (!match) throw new Error(`Expected ${what} as 'A:B' with positive terms; got '${value}'`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** True when two rasters/ratios select the same aspect within a relative tolerance. */
export function sameAspect(a: Raster, b: Raster, tolerance = 0.02): boolean {
  const target = b.width / b.height;
  return Math.abs(a.width / a.height - target) <= tolerance * target;
}

/**
 * Validate a seconds-based model's generation-request length against the
 * author's expected take length. `durationSeconds` is the model-side WIRE
 * request length; `requestedFrames / fps` is the length the author expects the
 * Take to fill. A request shorter than the expected take cannot fill the shot,
 * so it is a real conflict (surfaced at Plan); a longer request is the normal
 * margin a cut later trims. `undefined`/`-1` means the vendor chooses, which is
 * left to the post-run decoded-take verification instead of a guess here.
 */
export function validateGenerationLength(
  source: ProviderSource,
  durationSeconds: number | undefined,
  model: string,
): void {
  if (durationSeconds === undefined || durationSeconds < 0) return;
  const requested = durationSeconds * source.fps;
  // One frame of tolerance: `requestedFrames` may round the requested seconds.
  if (requested + 1 < source.requestedFrames) {
    throw new Error(
      `${model} generation request (${durationSeconds}s at ${source.fps}fps = ${requested} frames) is shorter than the expected take length (requestedFrames ${source.requestedFrames}); a Take cannot fill the shot. Raise \`durationSeconds\` or lower \`requestedFrames\`.`,
    );
  }
}
