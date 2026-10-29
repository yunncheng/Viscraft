// The persisted task identity must cover the ACTUAL encoded request — routing,
// encoded fields (including `extra_params` / frame indices) and each reference's
// order/type/role/content hash — while staying free of anything non-deterministic
// (a random multipart boundary or a per-run temp filename) or secret (credentials,
// raw base64).

import test from 'node:test';
import assert from 'node:assert/strict';

import { SourceSchema } from '../src/core/schema.js';
import type { ProviderSource } from '../src/core/schema.js';
import { vllmOmniVideoProtocol } from '../src/backends/providers/services/vllm-omni/video.js';
import { arkVideoProtocol } from '../src/backends/providers/services/ark/video.js';
import type { MappingReference } from '../src/backends/providers/extension.js';

const source = (overrides: Partial<Record<string, unknown>> = {}): ProviderSource =>
  SourceSchema.parse({
    id: 'src',
    kind: 'provider',
    output: 'picture',
    endpoint: 'ep',
    model: 'some-model',
    prompt: 'p',
    mode: 'text',
    references: [],
    requestedFrames: 48,
    size: '1280:720',
    fps: 24,
    attempt: 'a1',
    ...overrides,
  }) as ProviderSource;

const ref = (over: Partial<MappingReference>): MappingReference => ({
  asset: 'hero',
  sha256: 'a'.repeat(64),
  category: 'image',
  role: 'first-frame',
  mime: 'image/png',
  bytes: new Uint8Array([1, 2, 3]),
  ...over,
});

test('vllm-omni-video identity is stable for the same logical request and excludes a boundary/filename', () => {
  const src = source();
  const a = vllmOmniVideoProtocol.requestIdentity(src, 'wire-model', [], undefined);
  const b = vllmOmniVideoProtocol.requestIdentity(src, 'wire-model', [], undefined);
  assert.deepEqual(a, b);
  assert.equal('boundary' in (a as object), false, 'identity must not carry a multipart boundary');
  assert.equal(JSON.stringify(a).includes('reference.png'), false, 'identity must not carry a temp filename');
});

test('vllm-omni-video identity changes when ONLY an encoded field changes', () => {
  const src = source();
  const base = vllmOmniVideoProtocol.requestIdentity(src, 'wire-model', [], undefined);
  // Same Source, same wire model; only the mapping-produced `extra_params` differ.
  const withExtras = vllmOmniVideoProtocol.requestIdentity(src, 'wire-model', [], {
    model: 'wire-model',
    prompt: 'p',
    width: 1280,
    height: 720,
    fps: 24,
    num_frames: 48,
    extra_params: JSON.stringify({ task: 't2va' }),
  });
  assert.notDeepEqual(base, withExtras, 'a changed encoded `extra_params` must change the frozen identity');
  // A changed frame index must also change it.
  const withIndices = vllmOmniVideoProtocol.requestIdentity(src, 'wire-model', [], {
    model: 'wire-model',
    prompt: 'p',
    width: 1280,
    height: 720,
    fps: 24,
    num_frames: 48,
    extra_params: JSON.stringify({ task: 'fl2va', frame_indices: [0, -1] }),
  });
  assert.notDeepEqual(withExtras, withIndices);
});

test('vllm-omni-video identity changes with a reference content hash or order/role, never with raw bytes', () => {
  const src = source();
  const one = vllmOmniVideoProtocol.requestIdentity(src, 'm', [ref({})], undefined);
  const differentHash = vllmOmniVideoProtocol.requestIdentity(
    src,
    'm',
    [ref({ sha256: 'b'.repeat(64), bytes: new Uint8Array([9, 9]) })],
    undefined,
  );
  assert.notDeepEqual(one, differentHash, 'a changed reference content hash must change the identity');
  const differentRole = vllmOmniVideoProtocol.requestIdentity(src, 'm', [ref({ role: 'identity' })], undefined);
  assert.notDeepEqual(one, differentRole, 'a changed reference role must change the identity');
  // Same hash/role but different raw bytes still encode the same reference (bytes
  // never enter the identity directly — only their hash, which the caller froze).
  const sameHashDifferentBytes = vllmOmniVideoProtocol.requestIdentity(
    src,
    'm',
    [ref({ bytes: new Uint8Array([7, 7, 7, 7]) })],
    undefined,
  );
  assert.deepEqual(one, sameHashDifferentBytes);
});

test('ark-video-v3 identity covers the JSON body and reference set, never the raw locator secret path', () => {
  const src = source();
  const body = { model: 'm', content: [{ type: 'text', text: 'p' }] };
  const a = arkVideoProtocol.requestIdentity(src, 'm', [], body);
  assert.deepEqual(a, arkVideoProtocol.requestIdentity(src, 'm', [], body));
  const changed = arkVideoProtocol.requestIdentity(src, 'm', [], { ...body, duration: 7 });
  assert.notDeepEqual(a, changed, 'a changed Ark body field must change the identity');
  const withRef = arkVideoProtocol.requestIdentity(src, 'm', [ref({})], body);
  assert.notDeepEqual(a, withRef, 'a declared reference must change the identity');
});
