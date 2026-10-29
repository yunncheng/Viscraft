/**
 * Blender executor: a `blender` Source is a Python author script rendered
 * headlessly by the independent Blender runtime, optionally driven by a shared
 * World sidecar. Its binding/World resolution, identity, authored-file closure
 * and render step are owned here.
 */
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { captureBlender, type BlenderWorldInput } from '../../backends/blender/render.js';
import { encodeFrames } from '../../backends/media/encoding.js';
import { resolveProjectPath } from '../../shared/fs.js';
import type { Source } from '../../core/schema.js';
import { boundInputs, resolveBoundSource } from './shared.js';
import type { SourceExecutor } from './types.js';

type BlenderSource = Extract<Source, { kind: 'blender' }>;

const blenderExecutor: SourceExecutor = {
  kind: 'blender',
  outputOf: () => 'picture',
  implementationModules: ['backends/media/encoding', 'backends/blender/render'],
  tools: { blender: true },
  proxyRasterFor: () => true,
  staticFrames: (_project, source) => (source as BlenderSource).frames,
  staticAudio: () => false,
  probeAsset: () => undefined,
  testOnly: () => false,
  external: () => false,
  simulated: () => false,
  resolve: async (source, context) => {
    const blender = source as BlenderSource;
    // Blender is a `drive`-only World consumer: its renderer samples the shared
    // World per frame into the `--world` sidecar. A `define` binding would need a
    // per-shot movement path this executor does not implement, so refuse it loudly.
    if (blender.world && blender.world.mode !== 'drive')
      throw new Error(
        `Blender Source ${blender.id} only supports a World binding in mode 'drive' (got '${blender.world.mode}')`,
      );
    return resolveBoundSource(context.project, blender, context.loadRoot);
  },
  identify: async (source, resolved, context) => {
    const blender = source as BlenderSource;
    return {
      inputs: boundInputs(blender, resolved, context.files),
      parameters: {
        source: blender,
        output: context.output,
        bindingAssets: resolved.bindingAssets,
        ...(resolved.resolvedWorld ? { world: resolved.resolvedWorld, worldAssets: resolved.worldAssets } : {}),
      },
    };
  },
  produce: async (source, resolved, context) => {
    const blender = source as BlenderSource;
    const directory = path.join(context.scratch, `frames-${blender.id}`);
    await mkdir(directory, { recursive: true });
    const worldInput: BlenderWorldInput | undefined = resolved.resolvedWorld
      ? {
          world: resolved.resolvedWorld,
          camera: blender.world!.camera,
          startFrame: blender.world!.startFrame!,
          assets: Object.fromEntries(
            await Promise.all(
              resolved.worldAssets.map(
                async asset =>
                  [
                    asset.id,
                    { path: await resolveProjectPath(context.frozenRoot, asset.path), sha256: asset.sha256 },
                  ] as const,
              ),
            ),
          ),
          bindings: Object.fromEntries(
            await Promise.all(
              resolved.bindingAssets.map(
                async bound =>
                  [
                    bound.binding,
                    {
                      id: bound.asset.id,
                      path: await resolveProjectPath(context.frozenRoot, bound.asset.path),
                      sha256: bound.asset.sha256,
                    },
                  ] as const,
              ),
            ),
          ),
        }
      : undefined;
    await captureBlender(
      context.frozenRoot,
      blender,
      context.output,
      directory,
      {
        executable: context.blender?.executable,
        bpyPython: context.blender?.bpyPython,
        timeoutMs: context.blender?.timeoutMs,
      },
      worldInput,
    );
    await encodeFrames(directory, context.output, blender.frames, context.destination);
    await rm(directory, { recursive: true });
    return {};
  },
};

export { blenderExecutor };
