import { z } from 'zod';
import type { VideoProtocol } from '../video.js';

/** MiniMax official H3 API. Independently implemented from the documented v2
 * create/query contract; not the vLLM-Omni serving protocol. */
const task = z.object({
  id: z.string().min(1),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  task_type: z.literal('generation').optional(),
  content: z.object({ url: z.string().url().optional() }).optional(),
});

export const MINIMAX_BODY_BYTES = 64 * 1024 * 1024;
export const minimaxVideoProtocol: VideoProtocol = {
  id: 'minimax-video-v2',
  tasksPath: '/v2/video_generation',
  statusPath: id => `/v2/query/video_generation/${id}`,
  encode(_source, _model, _references, mapped) {
    if (!mapped) throw new Error('minimax-video-v2 requires a model definition and service mapping');
    const body = JSON.stringify(mapped);
    if (Buffer.byteLength(body) > MINIMAX_BODY_BYTES)
      throw new Error('MiniMax request body exceeds 64 MiB; use authorized hosted media URLs');
    return body;
  },
  requestIdentity(_source, _model, references, mapped) {
    if (!mapped) throw new Error('minimax-video-v2 requires a model definition and service mapping');
    return {
      protocol: 'minimax-video-v2',
      tasksPath: '/v2/video_generation',
      body: mapped,
      references: references.map(({ category, role, sha256 }) => ({ category, role, sha256 })),
    };
  },
  parseCreate(value) {
    return z.object({ task_id: z.string().min(1) }).parse(value).task_id;
  },
  parseStatus(value, id) {
    const parsed = z.object({ task }).parse(value).task;
    if (parsed.id !== id) throw new Error('task id does not match the persisted task id');
    if (parsed.status === 'succeeded' && !parsed.content?.url)
      throw new Error('succeeded MiniMax task has no video URL');
    return {
      state:
        parsed.status === 'succeeded'
          ? 'ready'
          : ['failed', 'cancelled'].includes(parsed.status)
            ? 'failed'
            : 'pending',
      status: parsed.status,
      ...(parsed.content?.url ? { contentUrl: parsed.content.url } : {}),
    };
  },
};
