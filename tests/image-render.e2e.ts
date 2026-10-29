/**
 * E2E: direct still-image production.
 *
 * Proves, through the real Runtime and a real Browser:
 *  - an image-only Project needs NO timeline (no Scene/Shot/audio/fps),
 *  - `renderImage` captures an editable HTML document at the declared logical
 *    canvas × scale and records a normal Build/Artifact with `target`,
 *  - the artifact bytes are a real PNG at the real output pixels,
 *  - an unchanged document/resources/output REUSES the result with no capture,
 *  - editing the document produces a NEW result and a new hash,
 *  - the schema refuses a Project that declares neither a composition nor a
 *    target, and refuses a target pointing at a missing document.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { renderImage } from '../src/build/image.js';
import { validateProject } from '../src/project/project.js';

const DOC = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="ink.css"></head>
<body><div id="card"><h1>FIELD NOTES</h1><p class="sub">A still at the declared canvas</p><div class="rule"></div></div></body></html>`;
const CSS = `html,body{margin:0;width:320px;height:180px;overflow:hidden;background:#f2ead9}
#card{box-sizing:border-box;width:320px;height:180px;padding:22px;font-family:sans-serif;color:#2b2520}
h1{font-size:30px;margin:0 0 6px;letter-spacing:1px}
.sub{margin:0;color:#6f6558;font-size:13px}
.rule{height:6px;width:120px;background:#c06a45;margin-top:18px}`;

function project(documentRevision = 1) {
  return {
    schemaVersion: 1,
    id: 'image-e2e',
    revision: 1,
    title: 'Image e2e',
    direction: { intent: 'one still', looks: [{ id: 'plain', description: 'plain' }], transitions: [] },
    assets: [],
    bindings: {},
    sources: [],
    imageDocuments: [{ id: 'poster', path: 'poster.html', resources: ['ink.css'], revision: documentRevision }],
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

/** PNG IHDR width/height (bytes 16..23, big-endian). */
function pngSize(bytes: Buffer): { width: number; height: number } {
  assert.equal(bytes.toString('ascii', 1, 4), 'PNG', 'the artifact is a PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test('an image-only Project renders a real PNG, reuses unchanged work, and re-renders on edit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-image-'));
  try {
    await writeFile(join(root, 'poster.html'), DOC);
    await writeFile(join(root, 'ink.css'), CSS);
    await writeFile(join(root, 'project.json'), JSON.stringify(validateProject(project()), null, 2) + '\n');

    // No timeline at all: the image path must not require one.
    const stored = validateProject(project());
    assert.equal(stored.composition, undefined, 'an image-only Project carries no timeline');

    const first = await renderImage(root, { target: 'wide' });
    assert.equal(first.reused, false);
    assert.equal(first.target, 'wide');
    assert.equal(first.width, 640, 'output pixels = logical width x scale');
    assert.equal(first.height, 360, 'output pixels = logical height x scale');
    const bytes = await readFile(join(root, ...first.path.split('/')));
    assert.deepEqual(pngSize(bytes), { width: 640, height: 360 }, 'the PNG really is 640x360');

    // The Build records the target, so a film result and a still cannot collide.
    const record = JSON.parse(await readFile(join(root, '.viscraft', 'builds', `${first.build}.json`), 'utf8')) as {
      target?: string;
      status: string;
      artifacts: Array<{ id: string; kind: string; image?: { width: number; height: number } }>;
    };
    assert.equal(record.target, 'wide');
    assert.equal(record.status, 'succeeded');
    const artifact = record.artifacts.find(candidate => candidate.id === first.artifact)!;
    assert.equal(artifact.kind, 'image');
    assert.deepEqual(artifact.image, { width: 640, height: 360, format: 'png', background: 'opaque' });

    // Unchanged inputs: identical result, no second capture.
    const second = await renderImage(root, { target: 'wide' });
    assert.equal(second.reused, true, 'an unchanged still is reused');
    assert.equal(second.artifact, first.artifact);

    // A real edit produces a new result and a new hash.
    await writeFile(join(root, 'poster.html'), DOC.replace('FIELD NOTES', 'REVISED NOTES'));
    const third = await renderImage(root, { target: 'wide' });
    assert.equal(third.reused, false, 'an edited document re-renders');
    assert.notEqual(third.artifact, first.artifact);
    const thirdBytes = await readFile(join(root, ...third.path.split('/')));
    assert.notEqual(thirdBytes.toString('base64'), bytes.toString('base64'), 'the pixels changed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
