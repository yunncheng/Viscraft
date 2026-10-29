// A `provider` Source's implementation closure is scoped to the
// selected protocol's adapter. Different protocols have distinct, stable
// fingerprints, so an unrelated vendor edit cannot invalidate a Take.

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { backendEntries, operationImplementation, runtimeRoot, videoOperationClosure } from '../src/build/identity.js';

test('video-generation implementation fingerprints are protocol-scoped and stable', async () => {
  const root = await runtimeRoot();
  const fallback = await backendEntries(root);
  const runway = await operationImplementation(root, 'provider', fallback, { protocol: 'runway-v1' });
  const fal = await operationImplementation(root, 'provider', fallback, { protocol: 'fal-queue' });
  const generic = await operationImplementation(root, 'provider', fallback, { protocol: 'vllm-omni-video' });
  const unknown = await operationImplementation(root, 'provider', fallback, undefined);

  assert.equal(
    runway,
    await operationImplementation(root, 'provider', fallback, { protocol: 'runway-v1' }),
    'same protocol is stable',
  );
  assert.notEqual(runway, fal, 'the Runway and fal closures must differ (protocol-scoped, not the all-vendor union)');
  assert.notEqual(runway, generic, 'a vendor protocol and the generic transport differ');
  assert.notEqual(fal, generic, 'a vendor protocol and the generic transport differ');
  // No selected protocol → conservative backends-wide closure (fail safe).
  assert.notEqual(unknown, runway);
  assert.notEqual(unknown, fal);

  // The selected model/mapping files participate: adding them changes the key, and
  // two protocols with their OWN mapping files differ.
  const runwayExt = await operationImplementation(root, 'provider', fallback, {
    protocol: 'runway-v1',
    implementationFiles: [join(root, 'backends/providers/models/runway-gen45.js')],
  });
  const falExt = await operationImplementation(root, 'provider', fallback, {
    protocol: 'fal-queue',
    implementationFiles: [join(root, 'backends/providers/models/wan-30.js')],
  });
  assert.notEqual(runwayExt, runway, 'the selected extension files participate in the closure');
  assert.notEqual(runwayExt, falExt);

  // The vendor adapters' own modules are the difference: a generic protocol must
  // not carry the Runway or fal adapter bytes.
  const withAdapter = await backendEntries(root);
  assert.ok(
    withAdapter.includes('backends/providers/services/runway/index.js'),
    'runway adapter exists in the runtime tree',
  );
  assert.ok(withAdapter.includes('backends/providers/services/fal/index.js'), 'fal adapter exists in the runtime tree');
});

// Cross-vendor isolation: a selected vendor's closure must not carry the OTHER
// vendor's adapter or model/mapping. `effective.ts` eagerly imports every packaged vendor
// extension, so any module that imports it must be leaf-hashed; otherwise editing
// Wan 3.0 would redo a Runway Take, violating "unrelated provider changes must
// not redo this Take".
test('a video Take closure is isolated from the unselected vendor', async () => {
  const root = await runtimeRoot();
  const members = async (protocol: string, file: string) => {
    const closure = await videoOperationClosure(root, protocol, [join(root, file)]);
    return [...closure.core, ...closure.adapter, ...closure.routing, ...closure.extension];
  };

  const runway = await members('runway-v1', 'backends/providers/models/runway-gen45.js');
  assert.ok(runway.includes('backends/providers/services/runway/index.js'), 'the Runway Take carries its own adapter');
  assert.ok(
    runway.includes('backends/providers/models/runway-gen45.js'),
    'the Runway Take carries its own model definition',
  );
  assert.ok(
    !runway.includes('backends/providers/services/fal/index.js'),
    'the Runway Take must NOT carry the fal adapter',
  );
  assert.ok(!runway.includes('backends/providers/models/wan-30.js'), 'the Runway Take must NOT carry the Wan model');
  assert.ok(
    !runway.includes('backends/providers/models/seedance-25.js'),
    'the Runway Take must NOT carry an unrelated model',
  );

  const fal = await members('fal-queue', 'backends/providers/models/wan-30.js');
  assert.ok(fal.includes('backends/providers/services/fal/index.js'), 'the fal Take carries its own adapter');
  assert.ok(fal.includes('backends/providers/models/wan-30.js'), 'the fal Take carries its own model definition');
  assert.ok(
    !fal.includes('backends/providers/services/runway/index.js'),
    'the fal Take must NOT carry the Runway adapter',
  );
  assert.ok(!fal.includes('backends/providers/models/runway-gen45.js'), 'the fal Take must NOT carry the Runway model');

  // A generic (vllm-omni-video / ark-video-v3) Take carries NO vendor at all.
  const generic = await members('vllm-omni-video', 'backends/providers/models/minimax-h3.js');
  assert.ok(
    !generic.includes('backends/providers/services/runway/index.js') &&
      !generic.includes('backends/providers/services/fal/index.js'),
    'a generic Take carries no vendor adapter',
  );
  assert.ok(
    !generic.includes('backends/providers/models/wan-30.js') &&
      !generic.includes('backends/providers/models/runway-gen45.js'),
    'a generic Take carries no vendor model',
  );
});
