/**
 * Preview range resolution, shared by `buildProject({ preview })` and
 * `planBuild({ preview })` so the Plan predicts exactly the work the preview
 * Build performs.
 *
 * A preview runs the ORDINARY Build pipeline over a sub-range and writes neither
 * the author timeline (`project.json`) nor the active result (`result.json`), so
 * both stay byte-identical. It composes on the same Operations as a full Build,
 * except that:
 *  - a Placement whose picture AND audio reach (incl. J/L lead/tail and offset,
 *    and any transition touching it) lie wholly outside `[start, end)` is
 *    substituted by a black, silent stand-in of the same length, so its Source
 *    is never resolved and no executor for it runs;
 *  - picture Layers wholly outside the range are dropped.
 * The final programme is cut to `[start, end)` and scaled.
 *
 * WHAT A PREVIEW MAY SPEND (it is NOT a "no generation / no submission" path):
 *  - Out-of-range Sources never execute: a substituted Placement's Source is not
 *    produced, so a range that only touches cached or in-range work spends
 *    nothing.
 *  - An in-range Source whose exact Operation key already exists (an existing
 *    valid Take, or a matching SUCCEEDED provider job) is REUSED as-is: the Build
 *    cache returns the verified artifact, and a provider adapter restores the
 *    retained local media, so nothing is re-submitted.
 *  - An in-range provider Source that has NO Take yet MAY perform its FIRST
 *    generation. That is a real POST, so it is still gated by the ordinary
 *    authorization the adapter owns — `authorization.submit` and per-Asset
 *    `uploadAssets`, plus the endpoint/credential checks — and a preview neither
 *    weakens nor duplicates them. `planBuild({ preview })` reports the same work
 *    read-only (zero submission) BEFORE the preview runs.
 *  - A small preview does NOT ask the model for only that short range. A provider
 *    Source is produced over its FULL authored request (`requestedFrames`, mode
 *    and references); only the final composed programme is cut/scaled to the
 *    range.
 *
 * `--scale` (`scale < 1`) is a PROXY raster for CAPTURED Sources only (browser
 * picture, blender): they render at `proxyOutput(output, scale)` under a
 * DIFFERENT Operation key, so a proxy Take is never reused by a full Build.
 * Provider Sources do NOT proxy (`proxyRasterFor` is false) — a real model is
 * billed once and returns a real Take at the FULL output; asking it again merely
 * to render small would be a second submission and is never done. Existing media
 * and generated Takes are likewise produced at full output and only scaled when
 * composed. A preview is therefore a way to LOOK at a passage, never a technique
 * for shortening the real Programme or for cheapening a paid generation: author
 * the range you actually want in the timeline.
 *
 * No cache miss starts a hidden retry: an adapter-owned refusal stays a refusal
 * (a succeeded job whose retained original is corrupt, an unknown submit, an
 * interrupted submit), and a preview adds no silently-degraded fake picture to
 * stand in for a Take the adapter refused.
 */
import { requireComposition, type OutputSettings, type Project, type Source } from '../core/schema.js';
import { compositionFrames } from '../core/composition.js';
import { sourceExecutor } from './executors/index.js';

export interface PreviewRequest {
  /** Output-frame range, left-closed right-open. */
  frames: [number, number];
  /** 0.25–1; default 1. */
  scale?: number;
  /** Extract the range's single frame as a PNG (requires a one-frame range). */
  still?: boolean;
}

export interface ResolvedPreview {
  frames: [number, number];
  scale: number;
  still: boolean;
  substituted: Set<string>;
  droppedLayers: Set<string>;
}

/**
 * Whether a Source is rendered at the proxy raster for a `scale < 1` preview.
 * True only for capture-backed Sources (browser picture, blender), whose output
 * a preview may render smaller because the Take is a local render. `false` for
 * provider Sources (a real model is billed at the full request/output, never a
 * proxy) and for the `simulated` test-double; their Takes are produced at full
 * output and only scaled when composed.
 */
export function rendersAtProxy(source: Source): boolean {
  return sourceExecutor(source).proxyRasterFor(source);
}

/**
 * The even proxy raster for `output × scale` (`scale = 1` returns `output`).
 * Used for capture-backed Source Takes that proxy-render (see
 * {@link rendersAtProxy}) and for the final range cut; provider and existing
 * Takes keep the full output and are only scaled when composed.
 */
export function proxyOutput(output: OutputSettings, scale: number): OutputSettings {
  if (scale === 1) return output;
  const even = (value: number) => Math.max(2, Math.round((value * scale) / 2) * 2);
  return { ...output, width: even(output.width), height: even(output.height) };
}

function samplesToFrames(samples: number, project: Project): number {
  const { fps, sampleRate } = requireComposition(project).output;
  return Math.ceil((Math.abs(samples) * fps.numerator) / (sampleRate * fps.denominator));
}

export function resolvePreview(project: Project, request: PreviewRequest): ResolvedPreview {
  const composition = requireComposition(project);
  const [start, end] = request.frames;
  const total = compositionFrames(project);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > total)
    throw new Error(
      `Preview range ${start}:${end} must be a nonempty [start, end) within the ${total}-frame programme`,
    );
  const scale = request.scale ?? 1;
  if (!Number.isFinite(scale) || scale < 0.25 || scale > 1)
    throw new Error(`Preview scale ${scale} must be between 0.25 and 1`);
  const still = request.still === true;
  if (still && end - start !== 1) throw new Error('A still preview needs a one-frame range');
  const overlaps = (from: number, to: number) => from < end && to > start;
  const needed = new Set<string>();
  for (const placement of composition.placements) {
    const length = placement.durationFrames ?? placement.outFrame - placement.inFrame;
    let from = placement.startFrame;
    let to = placement.startFrame + length;
    if (placement.audio === 'keep') {
      const offset = samplesToFrames(placement.audioOffsetSamples ?? 0, project);
      from -= samplesToFrames(placement.audioLeadSamples ?? 0, project) + offset;
      to += samplesToFrames(Math.max(0, placement.audioTailSamples ?? 0), project) + offset;
    }
    if (overlaps(from, to)) needed.add(placement.id);
  }
  for (const transition of composition.transitions)
    if (overlaps(transition.startFrame, transition.endFrame)) {
      needed.add(transition.from);
      needed.add(transition.to);
    }
  const substituted = new Set(composition.placements.map(p => p.id).filter(id => !needed.has(id)));
  const droppedLayers = new Set(
    (composition.layers ?? [])
      .filter(layer => !overlaps(layer.startFrame, layer.startFrame + layer.outFrame - layer.inFrame))
      .map(layer => layer.id),
  );
  return { frames: [start, end], scale, still, substituted, droppedLayers };
}
