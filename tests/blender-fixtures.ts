import { resolveBlenderRuntime, type BlenderOptions } from '../src/backends/blender/render.js';

/** Use the production discovery contract, so the same configuration works in tests. */
export async function configuredBlenderForTests(): Promise<BlenderOptions | undefined> {
  try {
    const runtime = await resolveBlenderRuntime();
    return runtime.kind === 'blender' ? { executable: runtime.executable } : { bpyPython: runtime.python };
  } catch (error) {
    // Explicit configuration errors are failures; an unconfigured optional runtime
    // is unavailable and its real-render tests can state that condition as a skip.
    if (
      [process.env.VISCRAFT_BLENDER, process.env.VISCRAFT_BLENDER_ROOT, process.env.VISCRAFT_BPY_PYTHON].some(value =>
        value?.trim(),
      )
    )
      throw error;
    return undefined;
  }
}
