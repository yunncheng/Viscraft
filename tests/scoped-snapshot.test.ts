/**
 * Honest whole-author snapshots: an UNRELATED missing authored file must not
 * become a silent "this Project has fewer files", and must not block a normal
 * local target. A CONSUMED file still refuses production. Portable export keeps
 * the distinction: default strict, or an explicit restricted scope that records
 * the unused gap and never claims the package is complete.
 *
 * These assertions are written against the CURRENT contract (snapshot inputs
 * carry `unavailable` gaps, scope carries authorComplete/authoredGaps); a package
 * that silently drops the missing path can never pass them.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { imageRenderIdentity, imageRenderKey, renderImage } from '../src/build/image.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { PortableManifestSchema } from '../src/operations/delivery/portable-contract.js';
import { validateProject } from '../src/project/project.js';
import { listVersions, revertProject } from '../src/project/versions.js';
import { contentPath } from '../src/project/content-store.js';
import { hashFile } from '../src/shared/hash.js';
import { authoringStatus } from '../src/project/state.js';
import { projectStatus } from '../src/project/status.js';

const DIAGRAM_HTML = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="diagram.css"></head>
<body><div class="canvas" data-canvas-width="80" data-canvas-height="60">
<div class="box" data-layer-id="flow">A</div>
</div></body></html>`;
const DIAGRAM_CSS = `html,body{margin:0;width:80px;height:60px;overflow:hidden;background:#f7f4ec}
.canvas{position:relative;width:80px;height:60px;overflow:hidden}
.box{position:absolute;left:4px;top:20px;width:72px;height:20px;background:#e4dcc8;font:10px sans-serif;text-align:center;line-height:20px}`;

function project() {
  return validateProject({
    schemaVersion: 1,
    id: 'scoped_snapshot',
    revision: 1,
    title: 'Scoped snapshot',
    direction: { intent: 'one still', looks: [{ id: 'plain', description: 'plain' }], transitions: [] },
    assets: [],
    bindings: {},
    sources: [
      {
        id: 'unused',
        kind: 'browser',
        output: 'picture',
        entry: 'unused.html',
        resources: [],
        bindings: [],
        params: {},
        seed: 0,
        frames: 1,
      },
    ],
    imageDocuments: [{ id: 'flow', path: 'diagram.html', resources: ['diagram.css'], revision: 1 }],
    imageTargets: [
      {
        id: 'diagram',
        document: 'flow',
        width: 80,
        height: 60,
        scale: 1,
        format: 'png',
        background: 'opaque',
      },
    ],
  });
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'viscraft-scoped-snapshot-'));
  await writeFile(path.join(root, 'project.json'), `${JSON.stringify(project(), null, 2)}\n`);
  await writeFile(path.join(root, 'diagram.html'), DIAGRAM_HTML);
  await writeFile(path.join(root, 'diagram.css'), DIAGRAM_CSS);
  // `unused.html` is declared by a Source this Project never consumes, and its
  // bytes are deliberately absent.
  return root;
}

/** The same Project with the unrelated Source's bytes present, so no gap exists. */
async function fixtureWithGapResolved(): Promise<string> {
  const root = await fixture();
  await writeFile(path.join(root, 'unused.html'), '<html>unused</html>');
  return root;
}

async function inputsOf(root: string, buildId: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(path.join(root, '.viscraft', 'snapshots', `${buildId}.inputs.json`), 'utf8'),
  ) as Record<string, unknown>;
}

test('an unconsumed missing authored file is a recorded gap, not a blocked still', async () => {
  const root = await fixture();
  try {
    const still = await renderImage(root, { target: 'diagram' });
    assert.ok(still.build, 'the consumed image target renders normally');
    const inputs = await inputsOf(root, still.build);
    const gaps = inputs.unavailable as Array<{ path: string }> | undefined;
    assert.ok(Array.isArray(gaps), 'the snapshot records the whole-author gaps');
    assert.deepEqual(
      gaps.map(gap => gap.path),
      ['unused.html'],
      'only the actually missing authored file is a gap',
    );
    // The gap is part of the snapshot identity, so an older snapshot that simply
    // omitted the file cannot be mistaken for this author state.
    await unlink(path.join(root, 'diagram.css'));
    const broken = await imageRenderKey(root, 'diagram').catch(() => null);
    assert.equal(broken, null, 'a consumed file that is now missing is not a current render key');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a consumed missing authored file refuses production', async () => {
  const root = await fixture();
  try {
    await unlink(path.join(root, 'diagram.css'));
    await assert.rejects(renderImage(root, { target: 'diagram' }), /diagram\.css|resource|missing|ENOENT/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('default export refuses an authored gap; the restricted scope records it and is not complete', async () => {
  const root = await fixture();
  try {
    await assert.rejects(
      exportProject(root),
      /unused\.html|gap|incomplete|allowIncompleteAuthored|missing/i,
      'the default export must not silently drop the missing authored file',
    );

    const restricted = await exportProject(root, undefined, {
      allowIncompleteAuthored: true,
    });
    const manifest = PortableManifestSchema.parse(
      JSON.parse(await readFile(path.join(restricted.path, '.viscraft', 'portable-manifest.json'), 'utf8')),
    );
    const scope = manifest.scope;
    assert.equal(scope.authorComplete, false);
    assert.equal(scope.selectedProductionComplete, true, 'the consumed still closure is complete');
    assert.equal(scope.wholeAuthorRestorable, false);
    assert.deepEqual(
      scope.authoredGaps.map(gap => gap.path),
      ['unused.html'],
    );
    assert.equal(
      manifest.files.some(file => file.path === 'unused.html'),
      false,
      'a gap is recorded, never fabricated as carried bytes',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('restricted export preserves an unconsumed missing recording as an explicit gap', async () => {
  const root = await fixtureWithGapResolved();
  try {
    const draft = project();
    const source = draft.sources[0];
    if (source.kind !== 'browser' || source.output !== 'picture') throw new Error('Expected the browser fixture');
    source.recording = 'recordings/missing/session.json';
    await writeFile(path.join(root, 'project.json'), JSON.stringify(draft));
    await assert.rejects(() => exportProject(root), /recording|gap|incomplete/i);
    const exported = await exportProject(root, undefined, { allowIncompleteAuthored: true });
    const manifest = PortableManifestSchema.parse(
      JSON.parse(await readFile(path.join(exported.path, '.viscraft', 'portable-manifest.json'), 'utf8')),
    );
    assert.equal(manifest.scope.authorComplete, false);
    assert.deepEqual(
      manifest.scope.authoredGaps.map(gap => gap.path),
      [source.recording],
    );
    const received = validateProject(JSON.parse(await readFile(path.join(exported.path, 'project.json'), 'utf8')));
    assert.deepEqual(received.sources, draft.sources, 'the declared recording is retained, not silently deleted');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the restricted scope still refuses a gap inside the selected production closure', async () => {
  const root = await fixture();
  try {
    // The still is the SELECTED production here: its Build's target consumes the
    // document. Losing a document resource afterwards is damage to that result,
    // not an unconsumed authoring gap, so even the explicit restricted scope
    // refuses instead of carrying a half-renderable document.
    await renderImage(root, { target: 'diagram' });
    await unlink(path.join(root, 'diagram.css'));
    await assert.rejects(
      exportProject(root, undefined, { allowIncompleteAuthored: true }),
      /diagram\.css|production|closure|missing|complete/i,
      'an unconsumed-only opt-in must not carry an incomplete selected result',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a readable file that disagrees with its declared digest keeps its ACTUAL bytes and records hash-mismatch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'viscraft-scoped-mismatch-'));
  try {
    const declared = 'f'.repeat(64);
    const base = project();
    const withAsset = validateProject({
      ...base,
      assets: [
        {
          id: 'logo',
          revision: 1,
          path: 'logo.png',
          sha256: declared,
          type: 'image',
          rights: { origin: 'test', license: 'CC0-1.0', redistributable: true },
          simulated: false,
        },
      ],
    });
    await writeFile(path.join(root, 'project.json'), `${JSON.stringify(withAsset, null, 2)}\n`);
    await writeFile(path.join(root, 'diagram.html'), DIAGRAM_HTML);
    await writeFile(path.join(root, 'diagram.css'), DIAGRAM_CSS);
    // Unconsumed declared bytes that exist but are NOT the declared bytes.
    await writeFile(path.join(root, 'logo.png'), 'not-the-declared-logo');
    const actual = await hashFile(path.join(root, 'logo.png'));
    assert.notEqual(actual, declared);

    const still = await renderImage(root, { target: 'diagram' });
    const inputs = await inputsOf(root, still.build);
    const files = inputs.files as Record<string, string>;
    assert.equal(files['logo.png'], actual, 'the readable ACTUAL digest stays in files');
    const gaps = (inputs.unavailable as Array<Record<string, unknown>>).filter(gap => gap.path === 'logo.png');
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].reason, 'hash-mismatch');
    assert.equal(gaps[0].expectedSha256, declared);
    assert.equal(gaps[0].actualSha256, actual);

    // The default export refuses to package those bytes under the declared identity.
    await assert.rejects(exportProject(root), /logo\.png/);
    const listed = await listVersions(root);
    assert.equal(listed.versions[0].snapshot?.complete, false, 'a mismatch is a recorded gap');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a frozen file lost AFTER the freeze is damage, never converted into a gap', async () => {
  const root = await fixtureWithGapResolved();
  try {
    const still = await renderImage(root, { target: 'diagram' });
    const inputs = await inputsOf(root, still.build);
    const cssSha = (inputs.files as Record<string, string>)['diagram.css'];
    const complete = (await listVersions(root)).versions[0].snapshot;
    assert.equal(complete?.complete, true, 'nothing was unavailable at freeze time');
    assert.equal(complete?.restorable, true);

    // Remove BOTH the frozen copy and the content-store blob: the listed bytes
    // are now gone, which is damage — not an acceptable freeze-time gap.
    await unlink(path.join(root, '.viscraft', 'snapshots', still.build, 'diagram.css'));
    await unlink(path.join(root, contentPath(cssSha)));

    const damaged = (await listVersions(root)).versions[0].snapshot;
    assert.equal(damaged?.complete, true, 'the freeze recorded no gap');
    assert.equal(damaged?.restorable, false, 'the lost listed bytes make the version unrestorable');
    assert.deepEqual(damaged?.gaps, [], 'damage is never reported as a gap');

    const before = await hashFile(path.join(root, 'diagram.css'));
    await assert.rejects(revertProject(root, still.build), /frozen bytes|missing/i);
    assert.equal(await hashFile(path.join(root, 'diagram.css')), before, 'no author file was written');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a hand-edited frozen inputs file is unverifiable, never reported as a verdict', async () => {
  const root = await fixture();
  try {
    const still = await renderImage(root, { target: 'diagram' });
    const project = validateProject(JSON.parse(await readFile(path.join(root, 'project.json'), 'utf8')));
    const record = JSON.parse(await readFile(path.join(root, '.viscraft', 'builds', `${still.build}.json`), 'utf8'));
    assert.equal(await authoringStatus(root, project, record), 'unchanged', 'the real snapshot is comparable');

    // Drop a readable file from the frozen map WITHOUT recording a gap: the map
    // no longer matches the Build's recorded snapshotHash.
    const inputsPath = path.join(root, '.viscraft', 'snapshots', `${still.build}.inputs.json`);
    const inputs = JSON.parse(await readFile(inputsPath, 'utf8')) as {
      files: Record<string, string>;
      unavailable: unknown[];
    };
    delete inputs.files['diagram.css'];
    await writeFile(inputsPath, `${JSON.stringify(inputs, null, 2)}\n`);
    assert.equal(await authoringStatus(root, project, record), 'unknown');

    // A non-mismatch gap that also claims readable bytes is equally unverifiable.
    const restored = JSON.parse(await readFile(inputsPath, 'utf8')) as { files: Record<string, string> };
    restored.files['diagram.css'] = 'f'.repeat(64);
    await writeFile(
      inputsPath,
      `${JSON.stringify(
        {
          files: restored.files,
          unavailable: [
            { path: 'diagram.css', reason: 'path-missing', actualSha256: null, owners: ['image-document:flow'] },
          ],
        },
        null,
        2,
      )}\n`,
    );
    assert.equal(await authoringStatus(root, project, record), 'unknown');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a still is never reported current on a matching key alone when its environment differs', async () => {
  const root = await fixture();
  try {
    const still = await renderImage(root, { target: 'diagram' });
    const identity = await imageRenderIdentity(root, 'diagram');
    const buildPath = path.join(root, '.viscraft', 'builds', `${still.build}.json`);
    const record = JSON.parse(await readFile(buildPath, 'utf8')) as {
      environment: Record<string, string>;
      operations: Array<{ kind: string; key: string }>;
    };
    assert.equal(
      record.operations.find(operation => operation.kind === 'render-image')?.key,
      identity.key,
      'the author key still matches; only the environment is being changed',
    );
    if (identity.environmentVerified)
      assert.equal((await listVersions(root)).versions[0].current, true, 'a fully observed machine is current');

    // A recorded environment that cannot equal the observed one: the same author
    // bytes are NOT proof that this result is current.
    record.environment = { ...record.environment, browser: 'not-this-browser' };
    await writeFile(buildPath, `${JSON.stringify(record, null, 2)}\n`);
    const listed = (await listVersions(root)).versions[0];
    assert.equal(listed.current, false, 'key equality alone must not claim current');
    assert.equal(listed.stale, true);
    const status = await projectStatus(root);
    assert.equal(status.stills[0]?.stale, true, 'status uses the same verdict');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
