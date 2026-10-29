/**
 * A still has TWO identities, and they must stay separate:
 *
 *  - the AUTHOR key (document + resources + output settings + simulation provenance) recorded on the
 *    `render-image` operation, which decides whether recorded pixels describe
 *    the current author bytes; and
 *  - the MACHINE environment (runtime/node/platform/browser and the executing
 *    capture/layout/transpile closure), which decides whether this machine can
 *    reproduce them.
 *
 * Folding the machine into the key made a missing browser look like an author
 * edit and made every recorded still unusable for read-only copy/verify. These
 * cases pin the split and the honest-unknown rule.
 */
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ImageDocument, ImageTarget } from '../src/core/schema.js';
import { imageRenderIdentity, imageRenderKeyFrom } from '../src/build/image.js';
import { imageEnvironment } from '../src/build/image-identity.js';
import { validateProject } from '../src/project/project.js';

const document = {
  id: 'poster',
  path: 'poster.html',
  resources: ['poster.css'],
  revision: 1,
} as ImageDocument;

const target = {
  id: 'card',
  document: 'poster',
  width: 120,
  height: 80,
  scale: 2,
  format: 'png',
  background: 'opaque',
} as ImageTarget;

const resources = [{ path: 'poster.css', sha256: 'e'.repeat(64) }];
const documentSha256 = 'd'.repeat(64);

test('the author key follows document inputs, output settings and simulation provenance', () => {
  const base = imageRenderKeyFrom({ simulated: false, document, documentSha256, resources, target });
  assert.match(base, /^[a-f0-9]{64}$/);
  assert.equal(
    imageRenderKeyFrom({ simulated: false, document, documentSha256, resources, target }),
    base,
    'identical author inputs reuse the key',
  );

  assert.notEqual(
    imageRenderKeyFrom({ simulated: false, document, documentSha256: 'f'.repeat(64), resources, target }),
    base,
    'edited document bytes change the key',
  );
  assert.notEqual(
    imageRenderKeyFrom({
      simulated: false,
      document,
      documentSha256,
      resources: [{ path: 'poster.css', sha256: '0'.repeat(64) }],
      target,
    }),
    base,
    'edited resource bytes change the key',
  );
  assert.notEqual(
    imageRenderKeyFrom({ simulated: false, document, documentSha256, resources, target: { ...target, width: 144 } }),
    base,
    'a changed output width changes the key',
  );
  assert.notEqual(
    imageRenderKeyFrom({
      simulated: false,
      document,
      documentSha256,
      resources,
      target: { ...target, format: 'webp' },
    }),
    base,
    'a changed output format changes the key',
  );
  assert.notEqual(
    imageRenderKeyFrom({
      simulated: false,
      document: { ...document, id: 'other' } as ImageDocument,
      documentSha256,
      resources,
      target,
    }),
    base,
    'a different document changes the key',
  );
});

test('a machine fact is recorded separately and never a cached lie', async () => {
  const previous = process.env.VISCRAFT_BROWSER;
  const fake = join(tmpdir(), `viscraft-fake-browser-${process.pid}${process.platform === 'win32' ? '.exe' : ''}`);
  try {
    process.env.VISCRAFT_BROWSER = '/nonexistent/definitely-not-a-browser';
    const failed = await imageEnvironment();
    assert.deepEqual(Object.keys(failed.facts).sort(), [
      'browser',
      'capture',
      'layout',
      'node',
      'platform',
      'runtime',
      'transpile',
    ]);
    assert.equal(failed.facts.browser, 'unknown', 'a failed probe is unknown, not a fake current version');
    assert.equal(failed.verified, false, 'an unprobed fact leaves the environment unverified');
    assert.match(failed.facts.runtime, /^viscraft-runtime-/);
    assert.equal(failed.facts.node, process.version);
    assert.match(failed.facts.platform, /^[a-z0-9]+\/[a-z0-9]+$/);
    for (const field of ['capture', 'layout', 'transpile'] as const)
      assert.match(
        failed.facts[field],
        /^[a-f0-9]{64}$/,
        `${field} must hash the executing implementation, not report unknown`,
      );

    // A browser installed at the configured path is picked up on the NEXT probe:
    // the earlier failure is not cached for the life of the process.
    if (process.platform === 'win32') await copyFile(process.execPath, fake);
    else {
      await writeFile(fake, '#!/bin/sh\necho "Fake Chrome 999.0.0.0"\n');
      await chmod(fake, 0o755);
    }
    process.env.VISCRAFT_BROWSER = fake;
    const recovered = await imageEnvironment();
    assert.equal(recovered.facts.browser, process.platform === 'win32' ? process.version : 'Fake Chrome 999.0.0.0');
    assert.equal(recovered.verified, true);

    // ...and a later failure is not masked by that earlier success.
    process.env.VISCRAFT_BROWSER = '/nonexistent/definitely-not-a-browser';
    const failedAgain = await imageEnvironment();
    assert.equal(failedAgain.facts.browser, 'unknown');
    assert.equal(failedAgain.verified, false);
  } finally {
    await rm(fake, { force: true });
    if (previous === undefined) delete process.env.VISCRAFT_BROWSER;
    else process.env.VISCRAFT_BROWSER = previous;
  }
});

test('an unverified machine never changes the author identity of a still', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-image-identity-'));
  const root = join(parent, 'project');
  const previous = process.env.VISCRAFT_BROWSER;
  await mkdir(root, { recursive: true });
  try {
    await writeFile(join(root, 'poster.html'), '<!doctype html><html><body>still</body></html>');
    await writeFile(join(root, 'poster.css'), 'html,body{margin:0}');
    await writeFile(
      join(root, 'project.json'),
      `${JSON.stringify(
        validateProject({
          schemaVersion: 1,
          id: 'identity',
          revision: 1,
          title: 'Identity',
          direction: { intent: 'still', looks: [{ id: 'plain', description: 'plain' }], transitions: [] },
          assets: [],
          bindings: {},
          sources: [],
          imageDocuments: [document],
          imageTargets: [target],
        }),
        null,
        2,
      )}\n`,
    );

    const observed = await imageRenderIdentity(root, 'card');
    assert.match(observed.key, /^[a-f0-9]{64}$/);

    process.env.VISCRAFT_BROWSER = '/nonexistent/definitely-not-a-browser';
    const unverified = await imageRenderIdentity(root, 'card');
    assert.equal(unverified.environmentVerified, false);
    assert.equal(unverified.environment.browser, 'unknown');
    assert.equal(unverified.key, observed.key, 'a browser that cannot be probed must not look like an edited document');
  } finally {
    if (previous === undefined) delete process.env.VISCRAFT_BROWSER;
    else process.env.VISCRAFT_BROWSER = previous;
    await rm(parent, { recursive: true, force: true });
  }
});
