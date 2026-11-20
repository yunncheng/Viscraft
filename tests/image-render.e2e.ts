/**
 * E2E: direct still-image production.
 *
 * Covers image-target schema boundaries and decoded transparency.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { renderImage } from '../src/build/image.js';
import { validateProject } from '../src/project/project.js';

function project() {
  return {
    schemaVersion: 1,
    id: 'image-e2e',
    revision: 1,
    title: 'Image e2e',
    direction: { intent: 'one still', looks: [{ id: 'plain', description: 'plain' }], transitions: [] },
    assets: [],
    bindings: {},
    sources: [],
    imageDocuments: [{ id: 'poster', path: 'poster.html', resources: ['ink.css'], revision: 1 }],
    imageTargets: [
      {
        id: 'wide',
        document: 'poster',
        width: 320,
        height: 180,
        scale: 2,
        format: 'png' as const,
        background: 'opaque' as const,
      },
    ],
  };
}

test('the schema accepts an unedited draft but refuses an unknown image document', () => {
  const empty = { ...project(), imageTargets: [], imageDocuments: [] };
  assert.doesNotThrow(() => validateProject(empty));
  const missingDocument = { ...project(), imageDocuments: [] };
  assert.throws(() => validateProject(missingDocument), /references unknown image document/);
});

test('JPEG cannot declare transparency, and a transparent WebP really keeps alpha', async () => {
  // JPEG has no alpha channel: the schema refuses the combination instead of
  // silently rendering an opaque background the target did not ask for.
  assert.throws(
    () =>
      validateProject({
        ...project(),
        imageTargets: [{ ...project().imageTargets[0], format: 'jpeg', background: 'transparent' }],
      }),
    /JPEG has no alpha channel/,
  );

  const root = await mkdtemp(join(tmpdir(), 'viscraft-image-alpha-'));
  try {
    const alpha = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;width:160px;height:100px;background:transparent">
<div style="margin:20px;width:60px;height:40px;background:#c06a45"></div></body></html>`;
    await writeFile(join(root, 'alpha.html'), alpha);
    await writeFile(
      join(root, 'project.json'),
      JSON.stringify(
        validateProject({
          ...project(),
          imageDocuments: [{ id: 'alpha', path: 'alpha.html', resources: [], revision: 1 }],
          imageTargets: [
            {
              id: 'alpha-webp',
              document: 'alpha',
              width: 160,
              height: 100,
              scale: 2,
              format: 'webp' as const,
              background: 'transparent' as const,
            },
          ],
        }),
        null,
        2,
      ) + '\n',
    );

    const still = await renderImage(root, { target: 'alpha-webp' });
    const bytes = await readFile(join(root, ...still.path.split('/')));
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF', 'the artifact is a WebP container');
    assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
    // Decode the real alpha channel: the unpainted canvas must be transparent and
    // the painted box opaque. A WebP that quietly dropped alpha would fail here.
    const decoded = spawnSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-v',
        'error',
        '-i',
        join(root, ...still.path.split('/')),
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgba',
        '-',
      ],
      { maxBuffer: 1 << 26 },
    );
    assert.equal(decoded.status, 0, decoded.stderr?.toString() ?? '');
    const pixels = decoded.stdout as Buffer;
    let transparent = 0;
    let opaque = 0;
    for (let offset = 3; offset < pixels.length; offset += 4) {
      if (pixels[offset] === 0) transparent += 1;
      else if (pixels[offset] === 255) opaque += 1;
    }
    assert.ok(transparent > 1000, 'the unpainted canvas is really transparent');
    assert.ok(opaque > 1000, 'the painted box is really opaque');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
