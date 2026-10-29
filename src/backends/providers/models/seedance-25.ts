/** Seedance 2.5 author semantics; independently implemented from the official
 * Ark model and create-task documentation, not from third-party source.
 * https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh
 * https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh
 */
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import type { GenerationExtension, GenerationModel } from '../extension.js';
import { seedance25ArkMapping } from '../mappings/seedance-ark.js';
import { validateGenerationLength, parseTerms, sameAspect } from './request-semantics.js';

export const Seedance25ParametersSchema = z
  .object({
    durationSeconds: z.union([z.literal(-1), z.number().int().min(4).max(30)]).optional(),
    resolution: z.enum(['480p', '720p', '1080p']).default('720p'),
    ratio: z.enum(['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive']).default('adaptive'),
    generateAudio: z.boolean().default(true),
    task: z.enum(['reference', 'edit', 'extend']).default('reference'),
    outputFormat: z.enum(['mp4', 'mov']).default('mp4'),
  })
  .strict();

export const seedance25Model: GenerationModel = {
  id: 'Seedance-2.5',
  medium: 'video',
  parameters: Seedance25ParametersSchema,
  validate(source, input) {
    if (!('kind' in source)) throw new Error('Seedance 2.5 produces video');
    const p = Seedance25ParametersSchema.parse(input);
    if (source.steps !== undefined || source.flowShift !== undefined)
      throw new Error('Seedance 2.5 does not accept diffusion steps or H3 flowShift');
    if (source.seed !== undefined && source.seed > 2147483647)
      throw new Error('Seedance 2.5 seed must be in 0..2147483647');
    const duration = p.durationSeconds ?? source.requestedFrames / source.fps;
    if (duration !== -1 && (!Number.isInteger(duration) || duration < 4 || duration > 30))
      throw new Error('Seedance 2.5 duration must be an integer in 4..30 seconds, or -1');
    validateGenerationLength(source, p.durationSeconds, 'Seedance 2.5');
    // A non-`adaptive` ratio fixes the output aspect, so the Source's raster
    // canvas must agree with it; `adaptive` lets the model derive aspect from the
    // input, so the canvas is unconstrained.
    if (p.ratio !== 'adaptive') {
      const raster = parseTerms(source.size, 'Seedance 2.5 source.size raster canvas');
      if (!sameAspect(raster, parseTerms(p.ratio, 'Seedance 2.5 parameters.ratio'))) {
        throw new Error(
          `Seedance 2.5 source.size '${source.size}' (a raster canvas) does not match the requested ratio '${p.ratio}'; use ratio 'adaptive' or state a consistent canvas.`,
        );
      }
    }
    const refs = source.references;
    const count = (category: string) => refs.filter(ref => ref.category === category).length;
    if (count('image') > 30 || count('video') > 10 || count('audio') > 10 || refs.length > 50)
      throw new Error('Seedance 2.5 accepts at most 30 images, 10 videos, 10 audios and 50 references total');
    if (refs.some(ref => ref.role === 'mask'))
      throw new Error('Seedance 2.5 does not support mask references through this mapping');
    if (source.mode === 'first-last-frame') {
      if (!refs.some(ref => ref.role === 'first-frame'))
        throw new Error('Seedance 2.5 frame mode requires a first frame');
      if (p.ratio !== 'adaptive') throw new Error('Seedance 2.5 first/last-frame mode requires ratio adaptive');
    }
    if (p.task !== 'reference') {
      if (source.mode !== 'reference' || !count('video'))
        throw new Error('Seedance 2.5 edit/extend requires a reference-video request');
      if (p.ratio !== 'adaptive') throw new Error('Seedance 2.5 edit/extend requires ratio adaptive');
      if (p.task === 'edit' && duration !== -1) throw new Error('Seedance 2.5 editing requires durationSeconds -1');
    }
  },
  validateReference(reference, media, audioCodecs) {
    if (reference.category === 'video') {
      const fps = media.fps.numerator / media.fps.denominator;
      if (
        media.duration < 2 ||
        media.duration > 30 ||
        fps < 24 ||
        fps > 60 ||
        Math.min(media.width, media.height) < 300 ||
        Math.max(media.width, media.height) > 6000 ||
        media.width / media.height < 0.4 ||
        media.width / media.height > 2.5 ||
        media.width * media.height < 407696 ||
        media.width * media.height > 8295044
      )
        throw new Error('Seedance 2.5 reference video violates duration, FPS or geometry requirements');
      if (
        !['h264', 'h265', 'hevc'].includes(media.videoCodec) ||
        audioCodecs.some(codec => !['aac', 'mp3'].includes(codec))
      )
        throw new Error('Seedance 2.5 reference video requires H.264/H.265 with optional AAC/MP3 audio');
    }
  },
  validateReferenceSet(source, facts) {
    const parameters = Seedance25ParametersSchema.parse(source.parameters ?? {});
    for (const fact of facts) {
      const category = fact.reference.category;
      if (
        category === 'video' &&
        (fact.bytes > 200 * 1024 * 1024 || (parameters.task === 'edit' && (fact.duration ?? 0) < 4))
      )
        throw new Error('Seedance 2.5 reference video exceeds its byte/duration limits');
      if (
        category === 'image' &&
        (!fact.width ||
          !fact.height ||
          Math.min(fact.width, fact.height) < 300 ||
          Math.max(fact.width, fact.height) > 6000 ||
          fact.width / fact.height < 0.4 ||
          fact.width / fact.height > 2.5 ||
          fact.bytes >= 30 * 1024 * 1024)
      )
        throw new Error('Seedance 2.5 reference image violates geometry or byte limits');
      if (
        category === 'audio' &&
        (!['wav', 'mp3'].includes(fact.format ?? '') ||
          (fact.duration ?? 0) < 2 ||
          (fact.duration ?? 0) > 30 ||
          fact.bytes > 15 * 1024 * 1024)
      )
        throw new Error('Seedance 2.5 reference audio requires WAV/MP3 within duration and byte limits');
    }
    for (const category of ['video', 'audio'])
      if (
        facts
          .filter(fact => fact.reference.category === category)
          .reduce((sum, fact) => sum + (fact.duration ?? 0), 0) > 30.001
      )
        throw new Error(`Seedance 2.5 ${category} references exceed 30 seconds total`);
  },
};

/** Select this packaged model+Ark mapping, using the same extension interface
 * available to project-owned image and video model modules.
 */
export function seedance25ArkExtension(): GenerationExtension {
  return {
    model: seedance25Model,
    mapping: seedance25ArkMapping,
    implementationFiles: [
      fileURLToPath(import.meta.url),
      fileURLToPath(new URL('../mappings/seedance-ark.js', import.meta.url)),
    ],
  };
}
