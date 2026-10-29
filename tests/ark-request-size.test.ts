/** Ark request-size accounting covers full reference bytes and size-only stubs. Base64 expansion is counted exactly once. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import type { ProviderSource } from '../src/core/schema.js';
import type { GenerationExtension, MappingReference } from '../src/backends/providers/extension.js';
import { prepareVideoRequest } from '../src/backends/providers/prepare.js';
import { seedance25ArkMapping } from '../src/backends/providers/mappings/seedance-ark.js';
import { ARK_BODY_BYTES } from '../src/backends/providers/transfer-bounds.js';

const SHA = 'a'.repeat(64);
const MIB = 1024 * 1024;

const arkSource = (): ProviderSource => ({
  id: 'arkref',
  kind: 'provider',
  output: 'picture',
  endpoint: 'ep',
  model: 'Seedance-2.5',
  prompt: 'p',
  mode: 'reference',
  references: [{ asset: 'big', category: 'image', role: 'identity' }],
  requestedFrames: 96,
  fps: 24,
  size: '1280:720',
  attempt: 'a1',
  parameters: {},
});

/** A permissive extension so ONLY the Ark TRANSPORT size check runs. */
function permissiveExtension(): GenerationExtension {
  return {
    implementationFiles: [fileURLToPath(import.meta.url)],
    model: { id: 'Seedance-2.5', medium: 'video', parameters: z.object({}).strict(), validate() {} },
    mapping: seedance25ArkMapping,
  };
}

const arkOptions = {
  endpoint: { protocol: 'ark-video-v3' as const, baseUrl: 'https://ark.example.test' },
  extension: permissiveExtension(),
};

test('a REAL reference set under 64 MiB is NOT refused (base64 counted once)', () => {
  // 30 MiB of real in-memory bytes -> base64 = 4*ceil(30 MiB/3) = 40 MiB, which
  // the Ark encoder ALREADY inlined into `encodedBody`. The correct total is
  // ~40 MiB (< the 64 MiB cap) and passes; the old double-counting loop reported
  // ~80 MiB and threw here.
  const declared = 30 * MIB;
  const reference: MappingReference = {
    asset: 'big',
    sha256: SHA,
    category: 'image',
    role: 'identity',
    mime: 'image/png',
    bytes: new Uint8Array(declared),
    // No `byteLength`: this is a real adapter payload, `sizeOf` == bytes.length.
  };

  const prepared = prepareVideoRequest(arkSource(), arkOptions, [reference]);
  assert.equal(typeof prepared.encodedBody, 'string', 'the Ark body is an encoded JSON string');
  const bodyBytes = Buffer.byteLength(prepared.encodedBody as string);
  assert.ok(bodyBytes > 39 * MIB && bodyBytes < 41 * MIB, `encoded body should be ~40 MiB, got ${bodyBytes}`);
  assert.ok(bodyBytes <= ARK_BODY_BYTES, `encoded body must be under the ${ARK_BODY_BYTES}-byte cap, got ${bodyBytes}`);
  // Load-bearing evidence: the OLD formula (add the inlined base64 a second time)
  // would have exceeded the cap.
  const doubleCounted = bodyBytes + 4 * Math.ceil(declared / 3);
  assert.ok(doubleCounted > ARK_BODY_BYTES, `double-counted size would be over the cap, got ${doubleCounted}`);
});

test('a genuinely oversized inline body is STILL refused (size message)', () => {
  // The Plan/preflight STUB shape: the real asset size is declared as
  // `byteLength` while `bytes` is empty (the body inlines only the
  // `data:;base64,` header). 50 MiB -> ~66.7 MiB of base64 -> over the cap.
  const reference: MappingReference = {
    asset: 'big',
    sha256: SHA,
    category: 'image',
    role: 'identity',
    mime: '',
    bytes: new Uint8Array(0),
    byteLength: 50 * MIB,
  };

  assert.throws(
    () => prepareVideoRequest(arkSource(), arkOptions, [reference]),
    new RegExp(`the Ark request body is ~\\d+ bytes, over the ${ARK_BODY_BYTES}-byte limit`),
  );
});
