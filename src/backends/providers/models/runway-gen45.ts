/**
 * Runway request constraints, independent of API address and deployment.
 * Independently implemented from the inspected Runway Node SDK (Apache-2.0); no
 * source reuse.
 *
 * LIMIT PROVENANCE (which limits are enforced and why):
 *  - gen4.5 text-to-video aspect ratios are the SDK's `Gen4_5` text-to-video
 *    union (`1280:720 | 720:1280`); the image-to-video union ADDS four ratios
 *    (`1104:832 | 960:960 | 832:1104 | 1584:672`). A text-only request cannot use
 *    the image-to-video-only ratios, so this profile enforces the subset according
 *    to whether a first-frame image is present.
 *  - gen4.5 is text-to-video OR a single first-frame image-to-video: the
 *    multi-modal `reference` mode is not a gen4.5 capability and is refused.
 *  - `proresProfile` is only valid when `outputFormat` is `prores`. (The SDK also
 *    allows `hdr_prores`, which this adapter does not accept: the Take pipeline
 *    normalizes every provider output to the composition codec, so only the
 *    plain, ingestible video formats are offered.)
 *  - Runway's `ratio` strings ARE generation resolutions (`1280:720` means the
 *    1280x720 output), not symbolic aspects, so the media-typed
 *    `provider` Source's raster `size` must EQUAL the requested `ratio`:
 *    a differing raster would be silently discarded by the vendor.
 *  - `durationSeconds` is the generation-request length; `requestedFrames / fps`
 *    is the author's expected take length. A request shorter than the expected
 *    take cannot fill the shot and is refused (a longer request is the normal
 *    margin a cut trims).
 *  - `gen4_turbo` is IMAGE-TO-VIDEO ONLY (the SDK exposes it in
 *    `ImageToVideoCreateParams`, not `TextToVideoCreateParams`): it requires a
 *    first-frame `promptImage`, takes the same six ratios, and its `duration` is
 *    an optional number with NO stated min/max, so this profile deliberately
 *    accepts any value rather than inventing a `2..10` range.
 */
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import type { GenerationExtension, GenerationModel } from '../extension.js';
import { runwayGen45Mapping, gen4TurboMapping } from '../mappings/runway-gen45.js';
import { validateGenerationLength } from './request-semantics.js';

const TEXT_TO_VIDEO_RATIOS = ['1280:720', '720:1280'] as const;

export const RunwayGen45ParametersSchema = z
  .object({
    durationSeconds: z.number().int().min(2).max(10),
    ratio: z.enum(['1280:720', '720:1280', '1104:832', '960:960', '832:1104', '1584:672']),
    outputFormat: z.enum(['mp4', 'prores']).optional(),
    proresProfile: z.enum(['422', '4444', '422 Proxy', '422 LT', '422 HQ', '4444 XQ']).optional(),
    contentModeration: z
      .object({ publicFigureThreshold: z.enum(['auto', 'low']) })
      .strict()
      .optional(),
  })
  .strict();
export type RunwayGen45Parameters = z.infer<typeof RunwayGen45ParametersSchema>;

export const Gen4TurboParametersSchema = z
  .object({
    // The SDK documents `duration?: number` with no stated range: any supplied
    // number is accepted; absence means the vendor chooses the default.
    durationSeconds: z.number().optional(),
    ratio: z.enum(['1280:720', '720:1280', '1104:832', '832:1104', '960:960', '1584:672']),
    contentModeration: z
      .object({ publicFigureThreshold: z.enum(['auto', 'low']) })
      .strict()
      .optional(),
  })
  .strict();
export type Gen4TurboParameters = z.infer<typeof Gen4TurboParametersSchema>;

export const runwayGen45Model: GenerationModel = {
  id: 'gen4.5',
  medium: 'video',
  parameters: RunwayGen45ParametersSchema,
  validate(source, input) {
    if (!('kind' in source)) throw new Error('Runway gen4.5 produces video');
    const parameters = RunwayGen45ParametersSchema.parse(input);
    if (source.model !== 'gen4.5')
      throw new Error(`Runway gen4.5 profile supports only model 'gen4.5'; got '${source.model}'`);
    if (source.prompt.length > 1000) throw new Error('Runway gen4.5 prompt must be at most 1000 characters');
    if (source.steps !== undefined) throw new Error('Runway gen4.5 does not accept `steps`');
    if (source.flowShift !== undefined) throw new Error('Runway gen4.5 does not accept `flowShift`');
    if (source.seed !== undefined && (source.seed < 0 || source.seed > 4294967295))
      throw new Error('Runway gen4.5 seed must be a uint32 from 0 to 4294967295');
    if (source.size !== parameters.ratio) {
      throw new Error(
        `Runway gen4.5 requires source.size to equal the requested ratio '${parameters.ratio}' (the model accepts only that ratio string); got size '${source.size}'`,
      );
    }
    validateGenerationLength(source, parameters.durationSeconds, 'Runway gen4.5');
    if (source.mode === 'reference') {
      throw new Error('Runway gen4.5 does not support reference-mode conditioning; use text or first-last-frame');
    }
    const references = source.references ?? [];
    if (source.mode === 'text') {
      if (references.length > 0) throw new Error('Runway gen4.5 text-to-video must not declare references');
      if (!(TEXT_TO_VIDEO_RATIOS as readonly string[]).includes(parameters.ratio)) {
        throw new Error(
          `Runway gen4.5 text-to-video accepts only ratios ${TEXT_TO_VIDEO_RATIOS.join(', ')}; the ratio '${parameters.ratio}' requires a first-frame image (image-to-video)`,
        );
      }
    } else {
      if (references.length !== 1 || references[0].category !== 'image' || references[0].role !== 'first-frame') {
        throw new Error('Runway gen4.5 image-to-video requires exactly one image reference with role "first-frame"');
      }
    }
    if (parameters.proresProfile !== undefined && (parameters.outputFormat ?? 'mp4') !== 'prores') {
      throw new Error(
        `Runway gen4.5 proresProfile is only valid when outputFormat is 'prores'; got outputFormat '${parameters.outputFormat ?? 'mp4'}'`,
      );
    }
  },
};

export const gen4TurboModel: GenerationModel = {
  id: 'gen4_turbo',
  medium: 'video',
  parameters: Gen4TurboParametersSchema,
  validate(source, input) {
    if (!('kind' in source)) throw new Error('Runway gen4_turbo produces video');
    const parameters = Gen4TurboParametersSchema.parse(input);
    if (source.model !== 'gen4_turbo')
      throw new Error(`Runway gen4_turbo profile supports only model 'gen4_turbo'; got '${source.model}'`);
    if (source.prompt.length > 1000) throw new Error('Runway gen4_turbo prompt must be at most 1000 characters');
    if (source.steps !== undefined) throw new Error('Runway gen4_turbo does not accept `steps`');
    if (source.flowShift !== undefined) throw new Error('Runway gen4_turbo does not accept `flowShift`');
    if (source.seed !== undefined && (source.seed < 0 || source.seed > 4294967295))
      throw new Error('Runway gen4_turbo seed must be a uint32 from 0 to 4294967295');
    if (source.size !== parameters.ratio) {
      throw new Error(
        `Runway gen4_turbo requires source.size to equal the requested ratio '${parameters.ratio}' (the model accepts only that ratio string); got size '${source.size}'`,
      );
    }
    validateGenerationLength(source, parameters.durationSeconds, 'Runway gen4_turbo');
    if (source.mode === 'reference')
      throw new Error('Runway gen4_turbo does not support reference-mode conditioning; use a single first-frame image');
    if (source.mode === 'text')
      throw new Error('Runway gen4_turbo is image-to-video only; a first-frame image is required');
    const references = source.references ?? [];
    if (references.length !== 1 || references[0].category !== 'image' || references[0].role !== 'first-frame') {
      throw new Error('Runway gen4_turbo image-to-video requires exactly one image reference with role "first-frame"');
    }
  },
};

/** Select the packaged gen4.5 model + Runway mapping under the ordinary contract. */
export function runwayGen45Extension(): GenerationExtension {
  return {
    model: runwayGen45Model,
    mapping: runwayGen45Mapping,
    implementationFiles: [
      fileURLToPath(import.meta.url),
      fileURLToPath(new URL('../mappings/runway-gen45.js', import.meta.url)),
    ],
  };
}

/** Select the packaged `gen4_turbo` model + Runway image-to-video mapping. */
export function gen4TurboExtension(): GenerationExtension {
  return {
    model: gen4TurboModel,
    mapping: gen4TurboMapping,
    implementationFiles: [
      fileURLToPath(import.meta.url),
      fileURLToPath(new URL('../mappings/runway-gen45.js', import.meta.url)),
    ],
  };
}
