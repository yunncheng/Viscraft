/**
 * The ONE source of truth for the client-side TRANSFER caps the provider lanes
 * enforce on transmitted references / request bodies.
 *
 * These are Viscraft's OWN transport budgets (what we are willing to send), not
 * a model's or a service's input limits: a model's own caps (counts, geometry,
 * durations, bytes) belong to its `GenerationModel` and are enforced by
 * `validateReferenceSet` / the deployed service. They live in one module so the
 * read-only request preparation (`prepare.ts`, which enforces them at preflight
 * on the real reference sizes) and each adapter's final byte-exact guard cannot
 * drift apart.
 */
const MIB = 1024 * 1024;

/** fal `wan-3.0` reference image: raw bytes and the resulting base64 data URI. */
export const FAL_IMAGE_RAW_BYTES = Math.floor(3.5 * MIB);
export const FAL_DATA_URI_BYTES = 6 * MIB;

/** Runway reference image: raw bytes and the resulting base64 data URI (< 5MB). */
export const RUNWAY_IMAGE_RAW_BYTES = Math.floor(3.5 * MIB);
export const RUNWAY_DATA_URI_BYTES = 5 * MIB;

/** The generic `vllm-omni-video` multipart transport: per-category raw upload caps. */
export const VIDEO_API_IMAGE_BYTES = 30 * MIB;
export const VIDEO_API_VIDEO_BYTES = 50 * MIB;
export const VIDEO_API_AUDIO_BYTES = 50 * MIB;

/** Ark v3 accepts a JSON body up to 64 MiB (inline data URIs count against it). */
export const ARK_BODY_BYTES = 64 * MIB;

/** vllm-omni-image reference part cap (the adapter's own vllm-omni-image upload budget). */
export const IMAGE_API_REFERENCE_BYTES = 30 * MIB;

/**
 * The byte length of a `data:<mime>;base64,<payload>` URI for a raw payload of
 * `bytes` (base64 expands 3 bytes to 4 chars; the header is `data:` + mime +
 * `;base64,`). Used to check the ENCODED transfer size at preflight without
 * building the payload.
 */
export function dataUriEncodedBytes(mime: string, bytes: number): number {
  return 5 + mime.length + 8 + 4 * Math.ceil(bytes / 3);
}
