/**
 * Thin dispatcher for the media-typed `provider` Source. It routes by the
 * Endpoint's declared protocol so Runway gen4.5 / gen4_turbo and the fal Wan 3.0
 * queue are authored through the SAME `provider` Source (never a
 * per-vendor Source kind), while the REAL protocol adapters keep owning auth /
 * submit / query / cancel / result collection.
 *
 * The effective Endpoint resolution (protocol, base URL, wire model, credential,
 * transmitted references) is resolved by `lane.ts`, and the effective model
 * definition + service mapping by `effective.ts`. The request's validation,
 * encoding and identity all come from the ONE read-only pipeline
 * (`prepareVideoRequest`) shared with Plan, the ordinary Build and the direct
 * SDK, so a request the Build would reject is reported as a structured issue
 * BEFORE any submission.
 */
import type { OutputSettings, ProviderSource } from '../../core/schema.js';
import type { VideoApiOptions, VideoApiResult } from './services/video-tasks.js';
import { generateVideoApi } from './services/video-tasks.js';
import { generateRunway, type RunwayResult } from './services/runway/index.js';
import { generateFal, type FalResult } from './services/fal/index.js';
import type { VideoServiceProtocol } from './lane.js';
import { requireVideoServiceProtocol, videoServiceProtocol } from './lane.js';
import { prepareVideoRequest } from './prepare.js';

export {
  requireVideoServiceProtocol,
  videoServiceProtocol,
  isVendorProtocol,
  resolveVideoLane,
  VENDOR_PROTOCOLS,
} from './lane.js';
export type { VideoServiceProtocol, VendorProtocol, VideoLaneResolution, VideoLaneOptions } from './lane.js';
export { resolveEffectiveExtension } from './effective.js';
export { prepareVideoRequest } from './prepare.js';
export type { PreparedVideoRequest, PrepareVideoOptions } from './prepare.js';

export type VideoServiceResult = VideoApiResult | RunwayResult | FalResult;

/**
 * The ONE validator shared by Plan and Produce. It runs the same read-only
 * request-preparation pipeline the adapters run (resolve the effective
 * definition + mapping, normalize parameters, validate the model and the service
 * subset, encode, identify), returning the normalized parameters and Source.
 */
export function validateVideoServiceRequest(
  source: ProviderSource,
  options: VideoApiOptions = {},
): { parameters: Record<string, unknown>; source: ProviderSource } {
  const prepared = prepareVideoRequest(source, options);
  return { parameters: prepared.parameters as Record<string, unknown>, source: prepared.source };
}

/** Produce a normalized Take through the adapter that owns the Endpoint's protocol. */
export async function generateVideoService(
  root: string,
  source: ProviderSource,
  output: OutputSettings,
  destination: string,
  options: VideoApiOptions = {},
): Promise<VideoServiceResult> {
  // The Endpoint's protocol selects the adapter. A production request must name
  // it; only the loopback fixture keeps the generic transport's own default.
  const protocol: VideoServiceProtocol = options.testOnly
    ? videoServiceProtocol(options)
    : requireVideoServiceProtocol(options, source, 'Video service');
  if (protocol === 'runway-v1') return generateRunway(root, source, output, destination, options);
  if (protocol === 'fal-queue') return generateFal(root, source, output, destination, options);
  return generateVideoApi(root, source, output, destination, options);
}
