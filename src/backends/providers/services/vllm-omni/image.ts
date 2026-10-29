/**
 * vllm-omni-image protocol: the pure wire contract of the OpenAI-compatible
 * synchronous image generation/editing surface exposed by vLLM-Omni and
 * compatible services. Independent implementation only — no source was copied.
 *
 * This module owns ONLY the request/response encoding of the protocol:
 *  - the scalar-only request field map (`model`, `prompt`, optional `size` /
 *    `seed`, `response_format`, plus a configured mapping's scalar extras);
 *  - the reserved-key / scalar / URL boundary checks a mapping must satisfy;
 *  - the JSON body (`POST /v1/images/generations`) and the multipart form
 *    (`POST /v1/images/edits`) construction, with the ordered reference image
 *    parts and the mask in place;
 *  - the canonical, transport-independent request identity; and
 *  - response decoding + the image boundary helper.
 *
 * It is deliberately dependency-light and byte-thin: the field and identity
 * checks are pure functions of the Source and the mapping's scalar output, so a
 * read-only preflight can run them WITHOUT reading or base64-expanding any
 * reference bytes. Reference bytes are materialized only when the multipart body
 * is actually built. Whether the endpoint is local or remote is NOT the
 * protocol's concern — that is a per-deployment decision in the executor.
 *
 * Wire-contract source: vLLM-Omni image generation / image editing docs.
 */
import { z } from 'zod';
import type { GenerateImageRequest, ReferenceRole } from '../../../../core/schema.js';

/** Protocol-owned scalar fields a configured service mapping must not override. */
export const VLLM_OMNI_IMAGE_RESERVED_FIELDS = ['model', 'prompt', 'image', 'mask_image', 'response_format'] as const;

export const VLLM_OMNI_IMAGE_GENERATIONS_PATH = '/v1/images/generations';
export const VLLM_OMNI_IMAGE_EDITS_PATH = '/v1/images/edits';

export type VllmOmniImageMime = 'image/png' | 'image/jpeg';
export type VllmOmniImageScalar = string | number | boolean;

/**
 * The exact scalar request fields an `vllm-omni-image` request sends. A configured
 * service mapping's scalar extras are merged onto these; the reserved keys are
 * owned by the protocol and may never be overridden. Kept separate from the
 * body/form builders and the request identity so the wire body and the frozen
 * identity cannot drift.
 */
export interface VllmOmniImageFields {
  model: string;
  prompt: string;
  response_format: 'b64_json';
  size?: string;
  seed?: number;
  [key: string]: VllmOmniImageScalar | undefined;
}

/** One ordered reference image part. Bytes are only read when the form is built. */
export interface VllmOmniImagePart {
  role: ReferenceRole;
  mime: VllmOmniImageMime;
  bytes: Uint8Array;
}

/** The ordered reference facts the request identity pins (never the bytes). */
export interface VllmOmniImageReferenceIdentity {
  role: ReferenceRole;
  sha256: string;
}

/** A decoded/validated synchronous response body. */
export type VllmOmniImageDecode =
  | { kind: 'image'; bytes: Buffer; mime: VllmOmniImageMime }
  | { kind: 'malformed' }
  | { kind: 'empty' }
  | { kind: 'oversize'; bytes: number }
  | { kind: 'not-image' };

function isScalar(value: unknown): value is VllmOmniImageScalar {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Validate a configured mapping's `imageFields` output against the scalar
 * `vllm-omni-image` wire contract, WITHOUT touching reference bytes. Refuses:
 *  - a reserved protocol key (`model`, `prompt`, `image`, `mask_image`,
 *    `response_format`), which the protocol owns;
 *  - a non-scalar value: nested JSON cannot be expressed by a scalar field;
 *  - a non-finite number;
 *  - an absolute URL or inline `data:` URI: this protocol transmits media as
 *    ordered multipart byte parts, never as a URL scalar. A model that truly
 *    needs URL inputs needs its own thin protocol adapter, not a silent scalar.
 */
export function assertVllmOmniImageMapping(mapped: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(mapped)) {
    if ((VLLM_OMNI_IMAGE_RESERVED_FIELDS as readonly string[]).includes(key)) {
      throw new Error(`vllm-omni-image mapping cannot override the protocol-owned field '${key}'`);
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error(`vllm-omni-image mapping field '${key}' must be a finite number`);
    }
    if (!isScalar(value)) {
      throw new Error(
        `vllm-omni-image mapping field '${key}' must be a scalar (string, number or boolean); nested JSON is not expressible by this scalar protocol`,
      );
    }
    if (typeof value === 'string' && /^(?:https?|data):/i.test(value)) {
      throw new Error(
        `vllm-omni-image mapping field '${key}' is a URL or inline data URI; this protocol transmits media as multipart byte parts, not as a URL scalar`,
      );
    }
  }
}

/**
 * The exact scalar field map an `vllm-omni-image` request sends: the protocol-owned
 * fields from the Source, then the mapping's validated scalar extras. Throws if
 * the mapping collides with a reserved key or yields a non-scalar / URL value.
 */
export function vllmOmniImageFields(
  source: GenerateImageRequest,
  wireModel: string,
  mapped?: Record<string, unknown>,
): VllmOmniImageFields {
  const fields: VllmOmniImageFields = {
    model: wireModel,
    prompt: source.prompt,
    ...(source.size !== undefined ? { size: source.size } : {}),
    ...(source.seed !== undefined ? { seed: source.seed } : {}),
    response_format: 'b64_json',
  };
  if (mapped && Object.keys(mapped).length > 0) {
    assertVllmOmniImageMapping(mapped);
    for (const [key, value] of Object.entries(mapped)) fields[key] = value as VllmOmniImageScalar;
  }
  return fields;
}

/**
 * The exact JSON body sent to `POST /v1/images/generations` (text-to-image and
 * reference-free requests). A request that carries any reference is routed to
 * the multipart edits endpoint instead, which is JSON-only and cannot carry
 * image bytes.
 */
export function vllmOmniImageJsonBody(
  source: GenerateImageRequest,
  wireModel: string,
  mapped?: Record<string, unknown>,
): Record<string, unknown> {
  return { ...vllmOmniImageFields(source, wireModel, mapped) };
}

/**
 * The exact multipart body sent to `POST /v1/images/edits`. Non-mask references
 * are appended as ordered `image` parts; a `mask` reference becomes the
 * `mask_image` part. Reference bytes are materialized here only.
 */
export function vllmOmniImageForm(
  source: GenerateImageRequest,
  wireModel: string,
  parts: readonly VllmOmniImagePart[],
  mapped?: Record<string, unknown>,
): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(vllmOmniImageFields(source, wireModel, mapped))) {
    form.set(key, String(value));
  }
  for (const part of parts) {
    if (part.role === 'mask') {
      form.set(
        'mask_image',
        new Blob([new Uint8Array(part.bytes)], { type: part.mime }),
        part.mime === 'image/png' ? 'mask.png' : 'mask.jpg',
      );
    } else {
      form.append(
        'image',
        new Blob([new Uint8Array(part.bytes)], { type: part.mime }),
        part.mime === 'image/png' ? 'reference.png' : 'reference.jpg',
      );
    }
  }
  return form;
}

/**
 * A canonical, transport-independent identity of the request this protocol
 * ENCODES: its routing, its scalar field map (including a mapping's validated
 * `imageFields`), and every reference's category/role/content hash in authored
 * order. It deliberately excludes anything non-deterministic or secret — the
 * multipart boundary, per-run temp filenames, credentials, full base64 payloads
 * or private URLs — so re-hashing the same logical request is stable while a
 * changed encoded field or route changes the frozen request hash.
 */
export function vllmOmniImageRequestIdentity(
  source: GenerateImageRequest,
  wireModel: string,
  references: readonly VllmOmniImageReferenceIdentity[],
  mapped?: Record<string, unknown>,
): unknown {
  return {
    protocol: 'vllm-omni-image',
    operation: source.operation,
    route: references.length === 0 ? VLLM_OMNI_IMAGE_GENERATIONS_PATH : VLLM_OMNI_IMAGE_EDITS_PATH,
    fields: vllmOmniImageFields(source, wireModel, mapped),
    references: references.map(reference => ({
      category: 'image' as const,
      role: reference.role,
      sha256: reference.sha256,
    })),
  };
}

/** Identify the image container by magic bytes. SVG/other formats are not matched. */
export function detectImageMime(bytes: Uint8Array): VllmOmniImageMime | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}

// The synchronous image response is `{ created?, data: [{ b64_json }] }`. Unknown
// sibling fields are tolerated (stripped); `b64_json` is required.
const responseSchema = z.object({
  created: z.number().optional(),
  data: z.array(z.object({ b64_json: z.string().min(1) })).min(1),
});

/**
 * Decode + boundary-check a synchronous `vllm-omni-image` response body. Distinguishes
 * a malformed/empty body (an ambiguous submit the executor must never resubmit)
 * from a decoded-but-unusable payload (a definitive provider failure).
 */
export function decodeVllmOmniImageResponse(text: string, maxBytes: number): VllmOmniImageDecode {
  let parsed: z.infer<typeof responseSchema>;
  try {
    parsed = responseSchema.parse(JSON.parse(text));
  } catch {
    return { kind: 'malformed' };
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(parsed.data[0].b64_json, 'base64');
  } catch {
    bytes = Buffer.alloc(0);
  }
  if (bytes.length === 0) return { kind: 'empty' };
  if (bytes.length > maxBytes) return { kind: 'oversize', bytes: bytes.length };
  const mime = detectImageMime(bytes);
  if (!mime) return { kind: 'not-image' };
  return { kind: 'image', bytes, mime };
}
