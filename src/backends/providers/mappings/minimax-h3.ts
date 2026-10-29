/**
 * MiniMax-H3 `vllm-omni-video` request mapping.
 *
 * The `vllm-omni-video` protocol carries the task type and frame positions that the
 * generic field set does not: the OFFICIAL vLLM-Omni H3 recipe (checked
 * 2026-10-11) puts
 *  - the task in `extra_params.task` (`t2va` text, `fl2va` first/last frame,
 *    `ref2va` multi-reference) and
 *  - the frame positions in `extra_params.frame_indices`, a JSON array of
 *    integer indices where the FIRST frame is `0` and the LAST frame is `-1`
 *    (negative = counted from the end): first-only `[0]`, last-only `[-1]`,
 *    first+last `[0, -1]`.
 *
 * The frame indices come from the Source's OWN ordered reference ROLES
 * (`first-frame` -> 0, `last-frame` -> -1), so the authored order is preserved
 * (a request authored last-then-first emits `[-1, 0]`).
 *
 * References are transmitted as REPEATED multipart `input_references` parts (the
 * generic vllm-omni-video encoder), never embedded in the scalar field map: the wire
 * contract keeps the repeated plural field with no singular/plural fallback.
 * Reference roles are positional; there is no separate role field.
 */
import type { MappingReference, MappingReferenceIdentity, ServiceMapping } from '../extension.js';
import type { ProviderSource } from '../../../core/schema.js';

/** The H3 task carried in `extra_params.task`. */
function taskOf(source: ProviderSource): 't2va' | 'fl2va' | 'ref2va' {
  if (source.mode === 'text') return 't2va';
  if (source.mode === 'first-last-frame') return 'fl2va';
  return 'ref2va';
}

/** Frame positions from the authored reference ROLES/order (first 0, last -1). */
function frameIndicesOf(source: ProviderSource): number[] {
  if (source.mode !== 'first-last-frame') return [];
  return (source.references ?? []).map(reference => {
    if (reference.role === 'first-frame') return 0;
    if (reference.role === 'last-frame') return -1;
    throw new Error(
      `MiniMax-H3 first-last-frame references must use role "first-frame" or "last-frame"; got role "${reference.role}"`,
    );
  });
}

function h3Fields(source: ProviderSource, wireModel: string): Record<string, unknown> {
  const task = taskOf(source);
  const frameIndices = frameIndicesOf(source);
  const [width, height] = source.size.split(':').map(Number);
  return {
    model: wireModel,
    prompt: source.prompt,
    width,
    height,
    fps: source.fps,
    num_frames: source.requestedFrames,
    num_inference_steps: source.steps ?? 30,
    flow_shift: source.flowShift ?? 12,
    ...(source.seed !== undefined ? { seed: source.seed } : {}),
    extra_params: JSON.stringify({ task, ...(frameIndices.length ? { frame_indices: frameIndices } : {}) }),
  };
}

function baseMapping(model: string, variant: 'ref2va' | 'fl2va'): ServiceMapping {
  return {
    model,
    wireModel: 'MiniMax-H3',
    protocol: 'vllm-omni-video',
    /**
     * Structural mode/reference agreement, independent of the model profile: a
     * caller-supplied request must be shaped for the mode it declares, so Plan
     * rejects a mis-shaped request before any submission.
     */
    validate(source, parameters, settings) {
      if (Object.keys(parameters).length) throw new Error('vLLM-Omni H3 does not support official API parameters');
      if (!('kind' in source)) throw new Error('MiniMax-H3 mapping requires a video request');
      if (Object.keys(settings).length) throw new Error('H3 Base has no modelSettings; select an explicit Base model');
      if (variant === 'ref2va') {
        if (source.mode !== 'reference')
          throw new Error(
            'H3 Base Ref2VA supports reference generation only; choose H3 Base FL2VA for text or first/last frames',
          );
        if (!(source.references ?? []).some(reference => reference.category !== 'audio'))
          throw new Error(
            'H3 Base Ref2VA requires at least one image or video; audio-only is not supported by this service',
          );
      } else if (source.mode === 'reference') {
        throw new Error('H3 Base FL2VA does not support reference generation; choose H3 Base Ref2VA');
      }
      const references = source.references ?? [];
      if (source.mode === 'text') {
        if (references.length > 0) throw new Error('MiniMax-H3 text mode must not declare references');
        return;
      }
      if (source.mode === 'first-last-frame') {
        if (references.length < 1 || references.length > 2)
          throw new Error('MiniMax-H3 first-last-frame mode requires one (first) or two (first+last) image references');
        if (
          references.some(
            reference =>
              reference.category !== 'image' || (reference.role !== 'first-frame' && reference.role !== 'last-frame'),
          )
        ) {
          throw new Error(
            'MiniMax-H3 first-last-frame references must be images with role "first-frame" or "last-frame"',
          );
        }
        if (references.length === 2 && new Set(references.map(reference => reference.role)).size !== 2) {
          throw new Error(
            'A two-reference MiniMax-H3 first-last-frame request needs one "first-frame" and one "last-frame" reference',
          );
        }
        return;
      }
      if (references.length === 0) throw new Error('MiniMax-H3 reference mode requires at least one reference');
    },
    /** The full `vllmOmniVideoFields`-shaped scalar map, including `extra_params`. */
    videoBody(source, _parameters, wireModel, _references: readonly MappingReference[]) {
      return h3Fields(source, wireModel);
    },
    identityBody(source, _parameters, wireModel, _references: readonly MappingReferenceIdentity[]) {
      return h3Fields(source, wireModel);
    },
  };
}

export const minimaxH3Ref2vaMapping = baseMapping('minimax-h3-base-ref2va', 'ref2va');
export const minimaxH3Fl2vaMapping = baseMapping('minimax-h3-base-fl2va', 'fl2va');
