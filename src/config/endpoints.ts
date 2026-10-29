import { z } from 'zod';
import { ImageApiEndpointSchema, type ImageApiOptions } from '../backends/providers/services/vllm-omni/image-api.js';
import { VideoApiEndpointSchema, type VideoApiOptions } from '../backends/providers/services/video-tasks.js';
import { readUserSettings, userEndpointsFile } from './user-settings.js';
import { resolveConnection } from './services.js';

const ResolvedEndpointsSchema = z.object({
  video: z.record(VideoApiEndpointSchema),
  image: z.record(ImageApiEndpointSchema),
});
export type UserEndpoints = z.infer<typeof ResolvedEndpointsSchema>;
export { userEndpointsFile } from './user-settings.js';
export interface UserEndpointsReport {
  endpoints: UserEndpoints;
  errors: string[];
}

/** Resolve user choices without returning keys. A bad entry does not hide good
 * entries from status; Plan/Build refuse the error rather than changing routes. */
export function loadUserEndpointsReport(): UserEndpointsReport {
  const { connections, errors } = readUserSettings();
  const endpoints: UserEndpoints = { video: {}, image: {} };
  for (const medium of ['video', 'image'] as const) {
    for (const [name, connection] of Object.entries(connections[medium])) {
      try {
        const resolved = resolveConnection(medium, connection);
        if (medium === 'video') endpoints.video[name] = VideoApiEndpointSchema.parse(resolved);
        else endpoints.image[name] = ImageApiEndpointSchema.parse(resolved);
      } catch (error) {
        errors.push(`${medium}.${name}: ${(error as Error).message}`);
      }
    }
  }
  return { endpoints, errors };
}

export function loadUserEndpoints(): UserEndpoints {
  const { endpoints, errors } = loadUserEndpointsReport();
  if (errors.length)
    throw new Error(`Invalid user endpoint configuration ${userEndpointsFile()}: ${errors.join('; ')}`);
  return endpoints;
}

type Providers = { videoApi?: Record<string, VideoApiOptions>; imageApi?: Record<string, ImageApiOptions> };

/**
 * Fill each provider entry that names no `endpoint` (and no test fixture) from
 * the user's Endpoints. An explicitly passed endpoint always wins; per-run
 * fields (authorization, extension, references) are kept as given.
 */
export function withUserEndpoints<T extends { providers?: Providers }>(options: T): T {
  const user = loadUserEndpoints();
  if (!Object.keys(user.video).length && !Object.keys(user.image).length) return options;
  const merge = <O extends { endpoint?: unknown; testOnly?: unknown }>(
    given: Record<string, O> | undefined,
    configured: Record<string, NonNullable<O['endpoint']>>,
  ): Record<string, O> => {
    const merged: Record<string, O> = { ...given };
    for (const [name, endpoint] of Object.entries(configured)) {
      const entry = merged[name];
      if (!entry?.endpoint && !entry?.testOnly) merged[name] = { ...entry, endpoint } as O;
    }
    return merged;
  };
  return {
    ...options,
    providers: {
      ...options.providers,
      videoApi: merge(options.providers?.videoApi, user.video),
      imageApi: merge(options.providers?.imageApi, user.image),
    },
  };
}
