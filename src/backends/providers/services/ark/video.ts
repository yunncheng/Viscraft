import { z } from 'zod';
import { ARK_BODY_BYTES } from '../../transfer-bounds.js';
import type { VideoProtocol } from '../video.js';

const task = z.object({
  id: z.string().min(1),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired']),
  content: z.object({ video_url: z.string().url().optional() }).optional(),
});
export const arkVideoProtocol: VideoProtocol = {
  id: 'ark-video-v3',
  tasksPath: '/contents/generations/tasks',
  statusPath: id => `/contents/generations/tasks/${id}`,
  encode(_source, _model, _references, mapped) {
    if (!mapped) throw new Error('ark-video-v3 requires a configured model definition and service mapping');
    const body = JSON.stringify(mapped);
    if (Buffer.byteLength(body) > ARK_BODY_BYTES)
      throw new Error('Ark request body exceeds 64 MiB; use authorized hosted media locators');
    return body;
  },
  requestIdentity(_source, _model, references, mapped) {
    if (!mapped) throw new Error('ark-video-v3 requires a configured model definition and service mapping');
    // The Ark body already carries hosted locator URLs (never bytes), so it is the
    // canonical identity; references are also listed by order/role/hash so a
    // changed reference set is visible even if the mapping omitted it.
    return {
      protocol: 'ark-video-v3',
      tasksPath: '/contents/generations/tasks',
      body: mapped,
      references: references.map(reference => ({
        category: reference.category,
        role: reference.role,
        sha256: reference.sha256,
      })),
    };
  },
  parseCreate(value) {
    return z.object({ id: z.string().min(1) }).parse(value).id;
  },
  parseStatus(value, id) {
    const parsed = task.parse(value);
    if (parsed.id !== id) throw new Error('task id does not match the persisted task id');
    if (parsed.status === 'succeeded' && !parsed.content?.video_url)
      throw new Error('succeeded Ark task has no video URL');
    return {
      state:
        parsed.status === 'succeeded'
          ? 'ready'
          : ['failed', 'cancelled', 'expired'].includes(parsed.status)
            ? 'failed'
            : 'pending',
      status: parsed.status,
      ...(parsed.content?.video_url ? { contentUrl: parsed.content.video_url } : {}),
    };
  },
};
