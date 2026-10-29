/**
 * Still-image production against the current contract:
 *
 *  - an image-only Project (no film composition) renders and reuses a real PNG;
 *  - an unrelated declared Asset whose bytes are missing becomes an explicit
 *    snapshot gap and does NOT block the still, while the consumed document and
 *    resources stay strict;
 *  - the recorded machine environment is separate from the author key: a browser
 *    that cannot be probed never makes an intact recorded still look current, and
 *    never changes the author identity.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { imageRenderIdentity, renderImage } from '../src/build/image.js';
import { validateProject } from '../src/project/project.js';

const DOC = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="poster.css"></head>
<body><div id="card"><h1>STILL ONLY</h1><p>no film timeline</p></div></body></html>`;
const CSS = `html,body{margin:0;width:120px;height:80px;overflow:hidden;background:#efe7d8}
#card{padding:10px;font-family:sans-serif;color:#332a20}h1{font-size:16px;margin:0 0 4px}p{margin:0;font-size:8px}`;

const UNUSED_ASSET = {
  id: 'unused',
  revision: 1,
  path: 'unused.bin',
  sha256: 'a'.repeat(64),
  type: 'image' as const,
  rights: { origin: 'unused fixture', license: 'CC0-1.0', redistributable: true },
  simulated: false,
};

function imageOnlyProject(assets: unknown[] = []) {
  return validateProject({
    schemaVersion: 1,
    id: 'image-only',
    revision: 1,
    title: 'Still only',
    direction: { intent: 'one still without a film', looks: [{ id: 'plain', description: 'plain' }], transitions: [] },
    assets,
    bindings: {},
    sources: [],
    imageDocuments: [{ id: 'poster', path: 'poster.html', resources: ['poster.css'], revision: 1 }],
    imageTargets: [
      {
        id: 'card',
        document: 'poster',
        width: 120,
        height: 80,
        scale: 2,
        format: 'png',
        background: 'opaque',
      },
    ],
  });
}

async function makeImageProject(): Promise<{ parent: string; root: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-image-only-'));
  const root = join(parent, 'project');
  await mkdir(root, { recursive: true });
  return { parent, root };
}

test('an image-only Project renders and reuses its still without a film', async () => {
  const { parent, root } = await makeImageProject();
  try {
    await writeFile(join(root, 'poster.html'), DOC);
    await writeFile(join(root, 'poster.css'), CSS);
    await writeFile(join(root, 'project.json'), `${JSON.stringify(imageOnlyProject(), null, 2)}\n`);

    const first = await renderImage(root, { target: 'card' });
    assert.equal(first.reused, false);
    assert.equal(first.width, 240);
    assert.equal(first.height, 160);
    assert.equal(first.format, 'png');

    const record = JSON.parse(await readFile(join(root, '.viscraft', 'builds', `${first.build}.json`), 'utf8')) as {
      target?: string;
      composition?: unknown;
      environment?: Record<string, string>;
      operations?: Array<{ key: string }>;
    };
    assert.equal(record.target, 'card');
    assert.equal(record.composition, undefined, 'no film composition is invented for a still');

    // The machine that painted the still is recorded, separately from the key.
    assert.deepEqual(Object.keys(record.environment ?? {}).sort(), [
      'browser',
      'capture',
      'layout',
      'node',
      'platform',
      'runtime',
      'transpile',
    ]);
    for (const field of ['capture', 'layout', 'transpile'] as const)
      assert.match(record.environment![field], /^[a-f0-9]{64}$/);
    assert.notEqual(record.environment!.browser, 'unknown');

    const second = await renderImage(root, { target: 'card' });
    assert.equal(second.reused, true);
    assert.equal(second.build, first.build);
    assert.equal(second.artifact, first.artifact);

    // An unprobeable browser is a real observation: same author key, unverified
    // environment, and the recorded still is NOT served as current.
    const previous = process.env.VISCRAFT_BROWSER;
    process.env.VISCRAFT_BROWSER = '/nonexistent/definitely-not-a-browser';
    try {
      const unverified = await imageRenderIdentity(root, 'card');
      assert.equal(unverified.key, record.operations![0].key, 'the author identity did not change');
      assert.equal(unverified.environmentVerified, false);
      assert.equal(unverified.environment.browser, 'unknown');
      await assert.rejects(renderImage(root, { target: 'card' }), /VISCRAFT_BROWSER/);
    } finally {
      if (previous === undefined) delete process.env.VISCRAFT_BROWSER;
      else process.env.VISCRAFT_BROWSER = previous;
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('an unrelated missing Asset is an explicit gap, not a blocked still', async () => {
  const { parent, root } = await makeImageProject();
  try {
    await writeFile(join(root, 'poster.html'), DOC);
    await writeFile(join(root, 'poster.css'), CSS);
    await writeFile(join(root, 'project.json'), `${JSON.stringify(imageOnlyProject([UNUSED_ASSET]), null, 2)}\n`);

    const rendered = await renderImage(root, { target: 'card' });
    assert.equal(rendered.reused, false);
    assert.equal(rendered.width, 240);

    const inputs = JSON.parse(
      await readFile(join(root, '.viscraft', 'snapshots', `${rendered.build}.inputs.json`), 'utf8'),
    ) as { files: Record<string, string>; unavailable: Array<{ path: string; reason: string; owners: string[] }> };
    assert.deepEqual(Object.keys(inputs.files).sort(), ['poster.css', 'poster.html']);
    assert.equal(inputs.unavailable.length, 1);
    assert.equal(inputs.unavailable[0].path, 'unused.bin');
    assert.equal(inputs.unavailable[0].reason, 'path-missing');
    assert.deepEqual(inputs.unavailable[0].owners, ['asset:unused']);

    // The still is reusable from intact author bytes + the same environment.
    const again = await renderImage(root, { target: 'card' });
    assert.equal(again.reused, true);
    assert.equal(again.build, rendered.build);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('a changed consumed resource is rejected instead of rendering old bytes', async () => {
  const { parent, root } = await makeImageProject();
  try {
    await writeFile(join(root, 'poster.html'), DOC);
    await writeFile(join(root, 'poster.css'), CSS);
    await writeFile(join(root, 'project.json'), `${JSON.stringify(imageOnlyProject(), null, 2)}\n`);
    const first = await renderImage(root, { target: 'card' });

    // Editing a CONSUMED resource must produce a new still, never reuse.
    await writeFile(join(root, 'poster.css'), `${CSS}\nh1{color:#a00}`);
    const second = await renderImage(root, { target: 'card' });
    assert.equal(second.reused, false);
    assert.notEqual(second.build, first.build);
    assert.notEqual(second.artifact, first.artifact);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
