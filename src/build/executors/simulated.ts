/**
 * `simulated` executor: the deterministic test-double provider. Its length is a
 * fixed duration tier, it carries no audio, and it is always reported as
 * simulated.
 */
import { generateSimulated, pickTierSeconds, quantizeFrames } from '../../backends/providers/simulated.js';
import { stableHash } from '../../shared/hash.js';
import { requireComposition, type Project, type Source } from '../../core/schema.js';
import { emptyResolved } from './shared.js';
import type { SourceExecutor } from './types.js';

type SimulatedSource = Extract<Source, { kind: 'simulated' }>;

const simulatedExecutor: SourceExecutor = {
  kind: 'simulated',
  outputOf: () => 'picture',
  implementationModules: ['backends/providers/simulated'],
  tools: {},
  proxyRasterFor: () => false,
  staticFrames: (project: Project, source) =>
    quantizeFrames(
      pickTierSeconds((source as SimulatedSource).frames, requireComposition(project).output.fps),
      requireComposition(project).output.fps,
    ),
  staticAudio: () => false,
  probeAsset: () => undefined,
  testOnly: () => false,
  external: () => false,
  simulated: () => true,
  resolve: async () => emptyResolved(),
  identify: async (source, _resolved, context) => {
    const simulated = source as SimulatedSource;
    return {
      inputs: [stableHash(simulated.prompt)],
      parameters: { source: simulated, output: context.output, bindingAssets: [] },
    };
  },
  classify: (source, _context, out) => {
    out.pending.push({
      level: 'pending',
      code: 'simulated-source',
      subject: source.id,
      message: `Source ${source.id} is a simulated/test-only provider; its Take is deterministic but must never be reported as a real generation.`,
    });
  },
  produce: async (source, _resolved, context) => {
    await generateSimulated(context.root, source as SimulatedSource, context.output, context.destination);
    return {};
  },
};

export { simulatedExecutor };
