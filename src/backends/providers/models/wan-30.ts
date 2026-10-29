/**
 * fal `alibaba/wan-3.0/image-to-video` request constraints, independent of API
 * address and deployment. Independently implemented from the inspected fal
 * queue OpenAPI (2026-10-08); no source reuse.
 *
 * LIMIT PROVENANCE (which limits are enforced and why):
 *  - The model is image-to-video only: it requires a first frame and accepts an
 *    optional last frame (`start_image_url` / `end_image_url`), so there is no
 *    text or multi-reference mode.
 *  - `durationSeconds` is an integer 2..30 s; `resolution` is `480p|720p|1080p`;
 *    `ratio` is the aspect ratio enum `16:9|4:3|1:1|3:4|9:16` (the API's
 *    `adaptive` is deliberately not offered); `audio` is a required boolean;
 *    `seed` is an optional int32 (0..2147483647).
 *  - `ratio` is a SYMBOLIC aspect selector, not a pixel canvas: the vendor picks
 *    the exact pixels from `resolution` + `ratio` (e.g. 720p/16:9). The
 *    media-typed `provider` Source's `size` stays the author's real
 *    raster canvas (`WIDTH:HEIGHT`), and this profile only checks that its
 *    aspect matches `ratio` — it never fabricates a `16x9` raster from `16:9`.
 *  - `durationSeconds` is the generation-request length; `requestedFrames / fps`
 *    is the author's expected take length. A request shorter than the expected
 *    take cannot fill the shot and is refused (a longer request is the normal
 *    margin a cut trims).
 */
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import type { GenerationExtension, GenerationModel } from '../extension.js';
import { wan30FalMapping } from '../mappings/fal-wan30.js';
import { parseTerms, sameAspect, validateGenerationLength } from './request-semantics.js';

export const Wan30ParametersSchema = z
  .object({
    durationSeconds: z.number().int().min(2).max(30),
    resolution: z.enum(['480p', '720p', '1080p']),
    ratio: z.enum(['16:9', '4:3', '1:1', '3:4', '9:16']),
    audio: z.boolean(),
  })
  .strict();
export type Wan30Parameters = z.infer<typeof Wan30ParametersSchema>;

export const wan30Model: GenerationModel = {
  id: 'alibaba/wan-3.0/image-to-video',
  medium: 'video',
  parameters: Wan30ParametersSchema,
  validate(source, input) {
    if (!('kind' in source)) throw new Error('Wan 3.0 produces video');
    const parameters = Wan30ParametersSchema.parse(input);
    if (source.model !== 'alibaba/wan-3.0/image-to-video') {
      throw new Error(`Wan 3.0 fal queue supports only model 'alibaba/wan-3.0/image-to-video'; got '${source.model}'`);
    }
    if (source.prompt.length > 20000) throw new Error('Wan 3.0 prompt must be at most 20000 characters');
    if (source.steps !== undefined) throw new Error('Wan 3.0 does not accept `steps`');
    if (source.flowShift !== undefined) throw new Error('Wan 3.0 does not accept `flowShift`');
    if (source.seed !== undefined && (source.seed < 0 || source.seed > 2147483647))
      throw new Error('Wan 3.0 seed must be an int32 from 0 to 2147483647');
    validateGenerationLength(source, parameters.durationSeconds, 'Wan 3.0');
    // `parameters.ratio` is symbolic (the vendor derives the pixels); the Source
    // `size` is the author's raster canvas. They must not disagree in aspect.
    const raster = parseTerms(source.size, 'Wan 3.0 source.size raster canvas');
    const ratio = parseTerms(parameters.ratio, 'Wan 3.0 parameters.ratio');
    if (!sameAspect(raster, ratio)) {
      throw new Error(
        `Wan 3.0 source.size '${source.size}' (a raster canvas) does not match the requested aspect ratio '${parameters.ratio}'; state one consistent aspect, or change \`ratio\`.`,
      );
    }
    if (source.mode !== 'first-last-frame') {
      throw new Error(
        'Wan 3.0 image-to-video requires first-last-frame mode (it takes a required first frame and an optional last frame)',
      );
    }
    const references = source.references ?? [];
    if (references.length < 1 || references.length > 2)
      throw new Error('Wan 3.0 requires one (first) or two (first+last) image references');
    if (
      references.some(
        reference =>
          reference.category !== 'image' || (reference.role !== 'first-frame' && reference.role !== 'last-frame'),
      )
    ) {
      throw new Error('Wan 3.0 references must be images with role "first-frame" or "last-frame"');
    }
    if (!references.some(reference => reference.role === 'first-frame'))
      throw new Error('Wan 3.0 requires a "first-frame" image reference');
    if (references.length === 2 && new Set(references.map(reference => reference.role)).size !== 2) {
      throw new Error('A two-reference Wan 3.0 request needs one "first-frame" and one "last-frame" reference');
    }
  },
};

/** Select the packaged Wan 3.0 model + fal queue mapping under the ordinary contract. */
export function wan30FalExtension(): GenerationExtension {
  return {
    model: wan30Model,
    mapping: wan30FalMapping,
    implementationFiles: [
      fileURLToPath(import.meta.url),
      fileURLToPath(new URL('../mappings/fal-wan30.js', import.meta.url)),
    ],
  };
}
