import { z } from 'zod';
import type { ServiceMapping } from '../extension.js';
import { parseTerms, sameAspect, validateGenerationLength } from '../models/request-semantics.js';

const ratios = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] as const;
export const MinimaxH3OfficialParametersSchema = z
  .object({
    durationSeconds: z.number().int().min(4).max(15).optional(),
    resolution: z.enum(['768P', '2K']).default('768P'),
    ratio: z.enum(['adaptive', ...ratios]).optional(),
  })
  .strict();

/** Native API fields and service constraints, separate from H3 model semantics. */
export const minimaxH3OfficialMapping: ServiceMapping = {
  model: 'MiniMax-H3',
  protocol: 'minimax-video-v2',
  validate(source, parameters, settings) {
    if (!('kind' in source)) throw new Error('MiniMax H3 produces video');
    if (Object.keys(settings).length) throw new Error('MiniMax official API has no deployment taskType/modelSettings');
    if (source.steps !== undefined || source.flowShift !== undefined || source.seed !== undefined)
      throw new Error('MiniMax official H3 API does not expose steps, flowShift or seed');
    if (source.prompt.length > 7000) throw new Error('MiniMax official H3 prompt exceeds 7000 characters');
    if (source.fps !== 24) throw new Error('MiniMax official H3 output uses 24 fps');
    const duration = parameters.durationSeconds ?? Math.max(4, Math.ceil(source.requestedFrames / source.fps));
    if (typeof duration !== 'number' || duration < 4 || duration > 15)
      throw new Error('MiniMax official H3 duration must be an integer in 4..15 seconds');
    validateGenerationLength(source, duration, 'MiniMax official H3');
    const raster = parseTerms(source.size, 'source.size');
    if (source.mode === 'first-last-frame') {
      if (parameters.ratio !== undefined && parameters.ratio !== 'adaptive')
        throw new Error('MiniMax first/last-frame ratio is adaptive, determined by the input image');
    } else {
      if (source.mode === 'text' && parameters.ratio === 'adaptive')
        throw new Error('MiniMax text-to-video requires a concrete ratio');
      if (parameters.ratio !== 'adaptive') {
        const ratio = parameters.ratio ?? ratios.find(value => sameAspect(raster, parseTerms(value, 'ratio')));
        if (!ratio || !sameAspect(raster, parseTerms(String(ratio), 'ratio')))
          throw new Error('MiniMax ratio must match source.size and a supported aspect ratio');
      }
    }
    const refs = source.references;
    if (source.mode === 'text' && refs.length) throw new Error('MiniMax text mode accepts no references');
    if (
      source.mode === 'first-last-frame' &&
      (refs.length < 1 ||
        refs.length > 2 ||
        refs.some(ref => ref.category !== 'image' || !['first-frame', 'last-frame'].includes(ref.role)) ||
        new Set(refs.map(ref => ref.role)).size !== refs.length)
    )
      throw new Error('MiniMax first-last-frame needs one or two distinct first/last image references');
    if (source.mode === 'reference' && refs.some(ref => ['first-frame', 'last-frame', 'mask'].includes(ref.role)))
      throw new Error('MiniMax reference mode cannot mix first/last-frame or mask roles');
  },
  validateReferenceSet(source, facts) {
    if (!('kind' in source)) return;
    for (const fact of facts) {
      if (fact.reference.category !== 'image' || fact.width === undefined || fact.height === undefined) continue;
      if (
        Math.min(fact.width, fact.height) < 256 ||
        Math.max(fact.width, fact.height) > 5760 ||
        fact.width / fact.height < 0.4 ||
        fact.width / fact.height > 2.5
      )
        throw new Error('MiniMax input image dimensions must be 256..5760 with aspect ratio 0.4..2.5');
      if (
        source.mode === 'first-last-frame' &&
        !sameAspect({ width: fact.width, height: fact.height }, parseTerms(source.size, 'source.size'))
      )
        throw new Error('MiniMax first/last-frame image aspect must match source.size');
    }
  },
  videoBody(source, parameters, wireModel, references) {
    if (wireModel !== 'MiniMax-H3') throw new Error('This MiniMax mapping supports the official MiniMax-H3 model only');
    const content: Record<string, unknown>[] = [{ type: 'text', text: source.prompt }];
    for (const ref of references) {
      if (ref.locator?.startsWith('asset://'))
        throw new Error('MiniMax requires a hosted HTTPS URL or inline media; asset:// is not supported');
      const type = `${ref.category}_url`;
      const url = ref.locator ?? `data:${ref.mime};base64,${Buffer.from(ref.bytes).toString('base64')}`;
      const role =
        ref.role === 'first-frame'
          ? 'first_frame'
          : ref.role === 'last-frame'
            ? 'last_frame'
            : `reference_${ref.category}`;
      content.push({ type, [type]: { url }, role });
    }
    const raster = parseTerms(source.size, 'source.size');
    return {
      model: wireModel,
      content,
      duration: parameters.durationSeconds ?? Math.max(4, Math.ceil(source.requestedFrames / source.fps)),
      resolution: parameters.resolution,
      ratio:
        source.mode === 'first-last-frame'
          ? 'adaptive'
          : (parameters.ratio ?? ratios.find(value => sameAspect(raster, parseTerms(value, 'ratio')))),
    };
  },
};
