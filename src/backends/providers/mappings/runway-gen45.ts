import type { MappingReference, MappingReferenceIdentity, ServiceMapping } from '../extension.js';

/** A validated reference image as a Runway `promptImage` base64 data URI. */
function dataUri(reference: MappingReference): string {
  return `data:${reference.mime};base64,${Buffer.from(reference.bytes).toString('base64')}`;
}

function firstFrame(references: readonly MappingReference[]): MappingReference | undefined;
function firstFrame(references: readonly MappingReferenceIdentity[]): MappingReferenceIdentity | undefined;
function firstFrame(
  references: readonly (MappingReference | MappingReferenceIdentity)[],
): MappingReference | MappingReferenceIdentity | undefined {
  return references.find(reference => reference.role === 'first-frame');
}

/**
 * Runway gen4.5 request mapping. Its request body is
 * `{ model, duration, ratio, promptImage?, promptText,
 * seed?, outputFormat?, proresProfile?, contentModeration? }`. The wire path
 * (`/v1/text_to_video` vs `/v1/image_to_video`) is a protocol-route fact owned by
 * the lane (chosen from the presence of a first-frame reference), not per model.
 */
export const runwayGen45Mapping: ServiceMapping = {
  model: 'gen4.5',
  protocol: 'runway-v1',
  validate(source) {
    if (!('kind' in source)) throw new Error('Runway mapping requires a video request');
    // The Runway service route is text OR a single first-frame image; a
    // multi-reference request is not expressible and is refused HERE so Plan
    // rejects it even for a caller-supplied custom model.
    if (source.mode === 'reference')
      throw new Error('Runway gen4.5 does not support reference-mode conditioning; use text or first-last-frame');
    const references = source.references ?? [];
    if (source.mode === 'first-last-frame') {
      if (references.length !== 1 || references[0].category !== 'image' || references[0].role !== 'first-frame') {
        throw new Error(
          'Runway gen4.5 image-to-video requires exactly one image reference with role "first-frame" (no last frame on this service)',
        );
      }
    } else if (references.length > 0) {
      throw new Error('Runway gen4.5 text-to-video must not declare references');
    }
  },
  videoBody(source, parameters, wireModel, references) {
    const p = parameters as {
      durationSeconds: number;
      ratio: string;
      outputFormat?: string;
      proresProfile?: string;
      contentModeration?: unknown;
    };
    const image = firstFrame(references);
    return {
      model: wireModel,
      duration: p.durationSeconds,
      ratio: p.ratio,
      ...(image ? { promptImage: dataUri(image) } : {}),
      promptText: source.prompt,
      ...(source.seed !== undefined ? { seed: source.seed } : {}),
      ...(p.outputFormat !== undefined ? { outputFormat: p.outputFormat } : {}),
      ...(p.proresProfile !== undefined ? { proresProfile: p.proresProfile } : {}),
      ...(p.contentModeration !== undefined ? { contentModeration: p.contentModeration } : {}),
    };
  },
  requestIdentity(source, parameters, wireModel, references) {
    const p = parameters as {
      durationSeconds: number;
      ratio: string;
      outputFormat?: string;
      proresProfile?: string;
      contentModeration?: unknown;
    };
    const image = firstFrame(references);
    return {
      route: image ? 'image_to_video' : 'text_to_video',
      model: wireModel,
      duration: p.durationSeconds,
      ratio: p.ratio,
      promptText: source.prompt,
      ...(source.seed !== undefined ? { seed: source.seed } : {}),
      ...(p.outputFormat !== undefined ? { outputFormat: p.outputFormat } : {}),
      ...(p.proresProfile !== undefined ? { proresProfile: p.proresProfile } : {}),
      ...(p.contentModeration !== undefined ? { contentModeration: p.contentModeration } : {}),
      // The image participates by content hash, never as a raw base64 data URI.
      promptImage: image ? { sha256: image.sha256 } : null,
    };
  },
};

/**
 * Runway `gen4_turbo` request mapping (image-to-video only). It always sends the
 * required first-frame `promptImage`; `duration` is omitted when the author did
 * not supply one (the field is optional in the SDK, with no stated range).
 */
export const gen4TurboMapping: ServiceMapping = {
  model: 'gen4_turbo',
  protocol: 'runway-v1',
  validate(source) {
    if (!('kind' in source)) throw new Error('Runway mapping requires a video request');
    if (source.mode !== 'first-last-frame')
      throw new Error('Runway gen4_turbo is image-to-video only; a first-frame image is required');
    const references = source.references ?? [];
    if (references.length !== 1 || references[0].category !== 'image' || references[0].role !== 'first-frame') {
      throw new Error(
        'Runway gen4_turbo image-to-video requires exactly one image reference with role "first-frame" (no last frame on this service)',
      );
    }
  },
  videoBody(source, parameters, wireModel, references) {
    const p = parameters as { durationSeconds?: number; ratio: string; contentModeration?: unknown };
    const image = firstFrame(references);
    if (!image) throw new Error('Runway gen4_turbo requires a first-frame image reference');
    return {
      model: wireModel,
      ratio: p.ratio,
      promptImage: dataUri(image),
      ...(p.durationSeconds !== undefined ? { duration: p.durationSeconds } : {}),
      promptText: source.prompt,
      ...(source.seed !== undefined ? { seed: source.seed } : {}),
      ...(p.contentModeration !== undefined ? { contentModeration: p.contentModeration } : {}),
    };
  },
  requestIdentity(source, parameters, wireModel, references) {
    const p = parameters as { durationSeconds?: number; ratio: string; contentModeration?: unknown };
    const image = firstFrame(references);
    if (!image) throw new Error('Runway gen4_turbo requires a first-frame image reference');
    return {
      route: 'image_to_video',
      model: wireModel,
      ratio: p.ratio,
      ...(p.durationSeconds !== undefined ? { duration: p.durationSeconds } : {}),
      promptText: source.prompt,
      ...(source.seed !== undefined ? { seed: source.seed } : {}),
      ...(p.contentModeration !== undefined ? { contentModeration: p.contentModeration } : {}),
      promptImage: { sha256: image.sha256 },
    };
  },
};
