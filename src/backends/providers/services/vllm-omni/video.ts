import { z } from 'zod';
import type { ProviderSource } from '../../../../core/schema.js';
import type { MappingReference } from '../../extension.js';
import type { VideoProtocol } from '../video.js';

const response = z.object({
  id: z.string().min(1),
  status: z.enum(['queued', 'in_progress', 'completed', 'failed']).nullable().optional(),
  inference_time_s: z.number().finite().nonnegative().nullable().optional(),
});

export interface VllmOmniVideoFields {
  model: string;
  prompt: string;
  width: number;
  height: number;
  fps: number;
  num_frames: number;
  num_inference_steps?: number;
  seed?: number;
  flow_shift?: number;
  /** Model/deployment-specific request extras as a JSON string (e.g. H3
   * `frame_indices`). Always present; `'{}'` when the model needs none. */
  extra_params: string;
}

/**
 * The exact scalar multipart fields a `vllm-omni-video` request sends. A configured
 * service mapping (`mapped`) REPLACES the generic defaults, so a model that needs
 * frame indices or task roles expresses them here. Kept separate from
 * `encode`/`requestIdentity` so the wire body and the frozen identity cannot
 * drift.
 */
export function vllmOmniVideoFields(
  source: ProviderSource,
  model: string,
  mapped?: Record<string, unknown>,
): VllmOmniVideoFields {
  if (mapped) return mapped as unknown as VllmOmniVideoFields;
  const [width, height] = source.size.split(':').map(Number);
  return {
    model,
    prompt: source.prompt,
    width,
    height,
    fps: source.fps,
    num_frames: source.requestedFrames,
    ...(source.steps !== undefined ? { num_inference_steps: source.steps } : {}),
    ...(source.seed !== undefined ? { seed: source.seed } : {}),
    ...(source.flowShift !== undefined ? { flow_shift: source.flowShift } : {}),
    extra_params: '{}',
  };
}

/** The multipart filename a reference part is uploaded under (deterministic). */
export function referenceFilename(reference: MappingReference): string {
  const extension =
    reference.category === 'image'
      ? reference.mime === 'image/png'
        ? 'png'
        : 'jpg'
      : reference.category === 'video'
        ? 'mp4'
        : reference.mime === 'audio/wav'
          ? 'wav'
          : 'mp3';
  return `reference.${extension}`;
}

export const vllmOmniVideoProtocol: VideoProtocol = {
  id: 'vllm-omni-video',
  tasksPath: '/v1/videos',
  statusPath: id => `/v1/videos/${id}`,
  encode(source, model, references, mapped) {
    const fields = vllmOmniVideoFields(source, model, mapped);
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (!['string', 'number', 'boolean'].includes(typeof value))
        throw new Error(`vllm-omni-video field ${key} must be scalar`);
      form.set(key, String(value));
    }
    for (const ref of references)
      form.append(
        'input_references',
        new Blob([new Uint8Array(ref.bytes)], { type: ref.mime }),
        referenceFilename(ref),
      );
    return form;
  },
  // Identity covers the encoded fields (including `extra_params`/frame indices)
  // and each reference's order/type/role/content hash — never the multipart
  // boundary, the temp filename or raw bytes.
  requestIdentity(source, model, references, mapped) {
    return {
      protocol: 'vllm-omni-video',
      tasksPath: '/v1/videos',
      fields: vllmOmniVideoFields(source, model, mapped),
      references: references.map(reference => ({
        category: reference.category,
        role: reference.role,
        sha256: reference.sha256,
        mime: reference.mime,
        locator: reference.locator ?? null,
      })),
    };
  },
  parseCreate(value) {
    return response.parse(value).id;
  },
  parseStatus(value, id) {
    const parsed = response.parse(value);
    if (parsed.id !== id) throw new Error('task id does not match the persisted task id');
    const status = parsed.status ?? 'queued';
    return {
      state: status === 'failed' ? 'failed' : status === 'completed' ? 'ready' : 'pending',
      status,
      ...(parsed.inference_time_s != null ? { inferenceSeconds: parsed.inference_time_s } : {}),
    };
  },
  contentPath(id) {
    return `/v1/videos/${id}/content`;
  },
};
