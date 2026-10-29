import { falStatus } from './services/fal/index.js';
import { imageApiStatus } from './services/vllm-omni/image-api.js';
import { runwayStatus } from './services/runway/index.js';
import { simulatedStatus } from './simulated.js';
import { videoApiStatus } from './services/video-tasks.js';

/** Every persisted generation job record in the Project, across all adapters (read-only). */
export async function providerJobStatus(root: string): Promise<unknown[]> {
  return [
    ...(await simulatedStatus(root)),
    ...(await runwayStatus(root)),
    ...(await videoApiStatus(root)),
    ...(await falStatus(root)),
    ...(await imageApiStatus(root)),
  ];
}
