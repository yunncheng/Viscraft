/** User-facing service choices, resolved into existing execution contracts. */
import { PACKAGED_VIDEO_EXTENSIONS } from '../backends/providers/models/registry.js';
import { normalizeProductionBase } from '../backends/providers/lane.js';
import type { UserConnection, Medium } from './user-settings.js';

const SERVICES = {
  minimax: { video: 'minimax-video-v2', url: 'https://api.minimax.io', authentication: true },
  ark: { video: 'ark-video-v3', url: 'https://ark.cn-beijing.volces.com/api/v3', authentication: true },
  runway: { video: 'runway-v1', url: 'https://api.dev.runwayml.com', authentication: true },
  fal: { video: 'fal-queue', url: 'https://queue.fal.run', authentication: true },
  'vllm-omni': { video: 'vllm-omni-video', image: 'vllm-omni-image', authentication: false },
} as const;

export function supportedConnections(): {
  service: string;
  medium: Medium;
  model: string;
  sourceModel: string;
  urlRequired: boolean;
  apiKeyRequired: boolean;
}[] {
  const routes = PACKAGED_VIDEO_EXTENSIONS.flatMap(factory => {
    const extension = factory();
    const service = Object.entries(SERVICES).find(([, value]) => value.video === extension.mapping.protocol);
    return service
      ? [
          {
            service: service[0],
            medium: 'video' as const,
            model: extension.model.id,
            sourceModel: extension.model.id,
            urlRequired: !('url' in service[1]),
            apiKeyRequired: service[1].authentication,
          },
        ]
      : [];
  });
  // This image route is contract-tested with the original Qwen/Qwen-Image. Other models use an
  // explicit trusted SDK definition/mapping until they have an integration.
  return [
    ...routes,
    {
      service: 'vllm-omni',
      medium: 'image',
      model: 'Qwen/Qwen-Image',
      sourceModel: 'Qwen/Qwen-Image',
      urlRequired: true,
      apiKeyRequired: false,
    },
  ];
}

export function resolveConnection(
  medium: Medium,
  connection: UserConnection,
): {
  protocol: string;
  baseUrl: string;
  model: string;
  sourceModel: string;
  credential?: string;
} {
  const routes = supportedConnections().filter(route => route.medium === medium);
  const route = routes.find(
    route => route.service === connection.service && route.model.toLowerCase() === connection.model.toLowerCase(),
  );
  if (!route)
    throw new Error(
      `Unsupported service/model combination. Supported ${medium} choices: ${routes.map(route => `${route.service}/${route.model}`).join(', ')}`,
    );
  const service = SERVICES[route.service as keyof typeof SERVICES];
  const protocol = medium === 'video' ? service.video : 'image' in service ? service.image : undefined;
  if (!protocol) throw new Error(`The selected service does not support ${medium} requests`);
  const rawUrl = connection.url || ('url' in service ? service.url : undefined);
  if (!rawUrl) throw new Error('Private deployment requires its service URL');
  const baseUrl = normalizeProductionBase(rawUrl, 'Service URL');
  if (connection.service === 'ark' && !connection.deploymentModel)
    throw new Error('Ark requires deploymentModel: copy the deployment model id from your account');
  const extension = PACKAGED_VIDEO_EXTENSIONS.map(factory => factory()).find(
    extension => extension.model.id === route.sourceModel && extension.mapping.protocol === service.video,
  );
  return {
    protocol,
    baseUrl,
    model: connection.deploymentModel ?? extension?.mapping.wireModel ?? route.sourceModel,
    sourceModel: route.sourceModel,
    ...(service.authentication || connection.hasApiKey ? { credential: connection.credentialName } : {}),
  };
}
