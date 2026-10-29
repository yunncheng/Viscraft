import type { ServiceMapping } from '../extension.js';

/** Ark's JSON content array preserves authored reference order and roles. */
export const seedance25ArkMapping: ServiceMapping = {
  model: 'Seedance-2.5',
  protocol: 'ark-video-v3',
  validate(source) {
    if (!('kind' in source)) throw new Error('Ark video mapping requires a video request');
  },
  videoBody(source, parameters, wireModel, references) {
    const content: Record<string, unknown>[] = [{ type: 'text', text: source.prompt }];
    for (const ref of references) {
      const type = `${ref.category}_url`;
      if (ref.category === 'video' && !ref.locator)
        throw new Error(
          `Ark reference video ${ref.asset} requires an authorized hosted URL or asset:// locator bound to its sha256`,
        );
      const url = ref.locator ?? `data:${ref.mime};base64,${Buffer.from(ref.bytes).toString('base64')}`;
      const role =
        ref.role === 'first-frame'
          ? 'first_frame'
          : ref.role === 'last-frame'
            ? 'last_frame'
            : `reference_${ref.category}`;
      content.push({ type, [type]: { url }, role });
    }
    return {
      model: wireModel,
      content,
      duration: parameters.durationSeconds ?? source.requestedFrames / source.fps,
      resolution: parameters.resolution,
      ratio: parameters.ratio,
      generate_audio: parameters.generateAudio,
      output_format: parameters.outputFormat,
      ...(source.mode === 'reference' ? { omni_reference_task_type: parameters.task } : {}),
      ...(source.seed !== undefined ? { seed: source.seed } : {}),
    };
  },
};
