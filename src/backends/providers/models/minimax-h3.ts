/** MiniMax-H3 shared reference semantics and media validation.
 * Protocol-specific request fields, deployment partitions and service limits
 * belong to the selected mapping. Independently implemented from documented
 * behavior; no upstream source reuse.
 */
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import type { MediaInfo, Reference, ProviderSource } from '../../../core/schema.js';
import type { GenerationExtension, GenerationModel, ReferenceFacts } from '../extension.js';
import { minimaxH3Ref2vaMapping, minimaxH3Fl2vaMapping } from '../mappings/minimax-h3.js';
import { minimaxH3OfficialMapping, MinimaxH3OfficialParametersSchema } from '../mappings/minimax-official.js';

const MAX_IMAGE_REFERENCES = 9;
const MAX_VIDEO_REFERENCES = 3;
const MAX_AUDIO_REFERENCES = 3;
const MAX_TOTAL_REFERENCES = 12;
// Confirmed media windows (official vLLM-Omni H3 behavior; see
// `minimax_h3/reference_video.py`):
//  - per-file reference VIDEO duration 2..15 s;
//  - per-file reference AUDIO duration 2..15 s;
//  - the SUM of reference-video durations <= 15 s;
//  - the SUM of reference-audio durations <= 15 s.
const MIN_REFERENCE_VIDEO_SECONDS = 2;
const MAX_REFERENCE_VIDEO_SECONDS = 15;
const MIN_REFERENCE_AUDIO_SECONDS = 2;
const MAX_REFERENCE_AUDIO_SECONDS = 15;
const MAX_REFERENCE_TOTAL_DURATION = 15;

/**
 * H3 Base variants have no additional model-owned parameters.
 * The official service mapping exposes its own parameter schema.
 */
export const MinimaxH3ParametersSchema = z.object({}).strict();

interface ReferenceCounts {
  images: number;
  videos: number;
  audios: number;
}
function referenceCounts(references: readonly Reference[]): ReferenceCounts {
  return {
    images: references.filter(reference => reference.category === 'image').length,
    videos: references.filter(reference => reference.category === 'video').length,
    audios: references.filter(reference => reference.category === 'audio').length,
  };
}

/** Official Ref2VA reference-count set semantics; the SOLE numeric-count gate. */
function validateRef2vaReferenceCounts(references: readonly Reference[]): void {
  if (references.length === 0) throw new Error('MiniMax-H3 reference mode requires at least one reference');
  const { images, videos, audios } = referenceCounts(references);
  if (images > MAX_IMAGE_REFERENCES)
    throw new Error(`MiniMax-H3 Ref2VA accepts at most ${MAX_IMAGE_REFERENCES} image references (got ${images})`);
  if (videos > MAX_VIDEO_REFERENCES)
    throw new Error(`MiniMax-H3 Ref2VA accepts at most ${MAX_VIDEO_REFERENCES} video references (got ${videos})`);
  if (audios > MAX_AUDIO_REFERENCES)
    throw new Error(`MiniMax-H3 Ref2VA accepts at most ${MAX_AUDIO_REFERENCES} audio references (got ${audios})`);
  if (references.length > MAX_TOTAL_REFERENCES)
    throw new Error(
      `MiniMax-H3 Ref2VA accepts at most ${MAX_TOTAL_REFERENCES} mixed references (got ${references.length})`,
    );
}

/** Shared request semantics; deployment partition checks belong to the mapping. */
export function validateMinimaxH3Request(source: ProviderSource): void {
  if (source.mode === 'reference') validateRef2vaReferenceCounts(source.references ?? []);
}

/** The H3 reference-video media profile (applied to reference VIDEOS only). */
export function validateMinimaxH3Video(media: MediaInfo): void {
  const fps = media.fps.numerator / media.fps.denominator;
  if (
    Math.min(media.width, media.height) < 256 ||
    Math.max(media.width, media.height) > 5760 ||
    media.width / media.height < 0.4 ||
    media.width / media.height > 2.5 ||
    fps < 23.976 ||
    fps > 60 ||
    media.duration < MIN_REFERENCE_VIDEO_SECONDS ||
    media.duration > MAX_REFERENCE_VIDEO_SECONDS ||
    !['h264', 'h265', 'hevc'].includes(media.videoCodec)
  ) {
    throw new Error(
      `MiniMax-H3 reference video requires dimensions 256..5760, aspect 0.4..2.5, 23.976..60 fps, duration ${MIN_REFERENCE_VIDEO_SECONDS}..${MAX_REFERENCE_VIDEO_SECONDS} seconds and H.264/H.265`,
    );
  }
}

/** Diagnostic latent boundary only; actual decoded output is authoritative. */
export function minimaxH3AlignedFrames(requested: number): number {
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > Number.MAX_SAFE_INTEGER - 17) {
    throw new RangeError(
      `minimaxH3AlignedFrames: expected a safe integer frame count in 1..${Number.MAX_SAFE_INTEGER - 17}, got ${requested}`,
    );
  }
  return requested + ((5 - (requested % 17) + 17) % 17);
}

/** The MiniMax-H3 model definition: reference semantics + media profile. */
export const minimaxH3Model: GenerationModel = {
  id: 'MiniMax-H3',
  medium: 'video',
  parameters: MinimaxH3ParametersSchema,
  validate(source) {
    if (!('kind' in source)) throw new Error('MiniMax-H3 produces video');
    if (source.model !== 'MiniMax-H3')
      throw new Error(`MiniMax-H3 profile supports only model 'MiniMax-H3'; got '${source.model}'`);
    validateMinimaxH3Request(source);
  },
  validateReference(reference, media, audioCodecs) {
    if (reference.category !== 'video') return;
    validateMinimaxH3Video(media);
    if (audioCodecs.some(codec => !['aac', 'mp3'].includes(codec))) {
      throw new Error('MiniMax-H3 reference requires MP4 with optional AAC/MP3 audio');
    }
  },
  /**
   * Set-level validation over the whole ordered reference SET, for the facts a
   * per-reference check cannot own:
   *  - reference counts (images <= 9, videos <= 3, audios <= 3, mixed <= 12);
   *    the vLLM-only audio-only restriction belongs to its service mapping;
   *  - each reference AUDIO fact lasts 2..15 s (no per-audio media profile
   *    exists, so the set is its only gate);
   *  - the SUM of reference-video durations is <= 15 s and the SUM of
   *    reference-audio durations is <= 15 s.
   * PROVENANCE: the aggregate totals and the audio window are OFFICIAL, verified
   * against Apache-2.0 vLLM-Omni
   * `vllm_omni/model_executor/models/minimax_h3/reference_video.py`
   * (`MINIMAX_H3_MAX_REFERENCE_TOTAL_DURATION = 15.0`; `prepare_reference_videos`
   * refuses when the running total would exceed 15 s; `validate_reference_audio_*`
   * requires each audio in [2, 15] and a <= 15 s total).
   *
   * A reference VIDEO fact's per-file 2..15 s window is still NOT re-checked here:
   * `validateReference` owns it on every entry point, and Plan classifies a bad
   * reference FILE as `reference-media-invalid` — re-checking it in the set would
   * run first in Plan and mislabel the same file `model-request-invalid`. Only the
   * video TOTAL is genuinely set-level. A fact without a measured `duration`
   * skips the checks it cannot satisfy.
   */
  validateReferenceSet(source, facts: readonly ReferenceFacts[]) {
    if (!('kind' in source)) return;
    validateMinimaxH3Request(source);
    let videoSeconds = 0;
    let audioSeconds = 0;
    for (const fact of facts) {
      if (fact.duration === undefined) continue;
      if (fact.reference.category === 'video') {
        videoSeconds += fact.duration;
      } else if (fact.reference.category === 'audio') {
        if (fact.duration < MIN_REFERENCE_AUDIO_SECONDS || fact.duration > MAX_REFERENCE_AUDIO_SECONDS) {
          throw new Error(
            `MiniMax-H3 reference audio duration must be ${MIN_REFERENCE_AUDIO_SECONDS}..${MAX_REFERENCE_AUDIO_SECONDS} seconds (got ${fact.duration})`,
          );
        }
        audioSeconds += fact.duration;
      }
    }
    if (videoSeconds > MAX_REFERENCE_TOTAL_DURATION)
      throw new Error(`MiniMax-H3 reference videos must be at most ${MAX_REFERENCE_TOTAL_DURATION} seconds in total`);
    if (audioSeconds > MAX_REFERENCE_TOTAL_DURATION)
      throw new Error(`MiniMax-H3 reference audio must be at most ${MAX_REFERENCE_TOTAL_DURATION} seconds in total`);
  },
};

/** Explicit Base checkpoint identity; shared H3 media validation stays reusable. */
function baseExtension(variant: 'ref2va' | 'fl2va'): GenerationExtension {
  const mapping = variant === 'ref2va' ? minimaxH3Ref2vaMapping : minimaxH3Fl2vaMapping;
  return {
    model: {
      ...minimaxH3Model,
      id: mapping.model,
      validate(source) {
        if (!('kind' in source) || source.model !== mapping.model)
          throw new Error(`H3 Base ${variant} requires model '${mapping.model}'`);
        validateMinimaxH3Request(source);
      },
    },
    mapping,
    implementationFiles: [
      fileURLToPath(import.meta.url),
      fileURLToPath(new URL('../mappings/minimax-h3.js', import.meta.url)),
    ],
  };
}

export function minimaxH3Ref2vaExtension(): GenerationExtension {
  return baseExtension('ref2va');
}
export function minimaxH3Fl2vaExtension(): GenerationExtension {
  return baseExtension('fl2va');
}

/** The same H3 reference semantics, with the official service's parameter surface. */
export function minimaxH3OfficialExtension(): GenerationExtension {
  return {
    model: { ...minimaxH3Model, parameters: MinimaxH3OfficialParametersSchema },
    mapping: minimaxH3OfficialMapping,
    implementationFiles: [
      fileURLToPath(import.meta.url),
      fileURLToPath(new URL('../mappings/minimax-official.js', import.meta.url)),
      fileURLToPath(new URL('./request-semantics.js', import.meta.url)),
    ],
  };
}
