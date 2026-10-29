import type { MappingReference, ServiceMapping } from '../extension.js';

/** A validated reference image as a fal data-URI file input. */
function dataUri(reference: MappingReference): string {
  return `data:${reference.mime};base64,${Buffer.from(reference.bytes).toString('base64')}`;
}

/**
 * fal `alibaba/wan-3.0/image-to-video` queue request mapping. Its request body is
 * `{ prompt,
 * start_image_url, end_image_url?, duration, resolution, aspect_ratio, audio,
 * seed?, enable_safety_checker: true, enable_prompt_expansion: false,
 * enable_thinking: false }`.
 *
 * Read from the official OpenAPI 3.0.4 (verified 2026-10-08); no source copied:
 * `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=alibaba/wan-3.0/image-to-video`.
 *
 * `endpointId` is the lane's ROUTE facet: the queue submit/status/result paths
 * are derived from it (see `fal.ts`) instead of a hardcoded literal. It is a
 * fal-specific extension of the shared `ServiceMapping`, deliberately NOT added
 * to that shared interface.
 */
export const wan30FalMapping = {
  model: 'alibaba/wan-3.0/image-to-video',
  protocol: 'fal-queue',
  endpointId: 'alibaba/wan-3.0/image-to-video',
  validate(source) {
    if (!('kind' in source)) throw new Error('fal queue mapping requires a video request');
  },
  videoBody(source, parameters, _wireModel, references) {
    const p = parameters as { durationSeconds: number; resolution: string; ratio: string; audio: boolean };
    const first = references.find(reference => reference.role === 'first-frame');
    const last = references.find(reference => reference.role === 'last-frame');
    if (!first) throw new Error('Wan 3.0 requires a first-frame image reference');
    return {
      prompt: source.prompt,
      start_image_url: dataUri(first),
      ...(last ? { end_image_url: dataUri(last) } : {}),
      duration: p.durationSeconds,
      resolution: p.resolution,
      aspect_ratio: p.ratio,
      audio: p.audio,
      ...(source.seed !== undefined ? { seed: source.seed } : {}),
      // Moderation stays on; expansion and thinking stay off.
      enable_safety_checker: true,
      enable_prompt_expansion: false,
      enable_thinking: false,
    };
  },
  requestIdentity(source, parameters, _wireModel, references) {
    const p = parameters as { durationSeconds: number; resolution: string; ratio: string; audio: boolean };
    const first = references.find(reference => reference.role === 'first-frame');
    const last = references.find(reference => reference.role === 'last-frame');
    if (!first) throw new Error('Wan 3.0 requires a first-frame image reference');
    return {
      prompt: source.prompt,
      // References participate by content hash, never as raw base64 data URIs.
      start_image: { sha256: first.sha256 },
      end_image: last ? { sha256: last.sha256 } : null,
      duration: p.durationSeconds,
      resolution: p.resolution,
      aspect_ratio: p.ratio,
      audio: p.audio,
      ...(source.seed !== undefined ? { seed: source.seed } : {}),
      enable_safety_checker: true,
      enable_prompt_expansion: false,
      enable_thinking: false,
    };
  },
} satisfies ServiceMapping & { endpointId: string };
