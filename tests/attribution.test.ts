/**
 * Attribution carry closure.
 *
 * Proves the author-recorded attribution facts on the single Asset rights
 * authority (`author`, `sourceUrl`, `licenseUrl`, `notice`, `modifications`,
 * `attributionRequired`) actually travel across move-directory, export/restore,
 * archive/restore and final delivery; and that the declared-flag completeness
 * gate is loud. Technical checks are kept separate from real license judgement:
 * these fixtures prove the carry path, never an external grant.
 *
 * Real tiny media only (FFmpeg-generated PNG/MP4), no network, no browser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { importAsset } from '../src/operations/assets/import.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { archiveProject, restoreProject } from '../src/operations/delivery/archive.js';
import { deliverProject } from '../src/operations/delivery/delivery.js';
import { buildProject } from '../src/build/build.js';
import { loadProject, validateProject } from '../src/project/project.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { ProjectSchema, type Project } from '../src/core/schema.js';

async function tmp(prefix = 'viscraft-attribution-'): Promise<string> {
  return fs.mkdtemp(nodePath.join(os.tmpdir(), prefix));
}

/** Author-recorded rights with every attribution fact populated. */
const ATTRIBUTION_RIGHTS = {
  origin: 'Cloud Study by Ada Example, obtained 2026-10-11',
  license: 'CC BY 4.0',
  redistributable: true,
  author: 'Ada & Co',
  sourceUrl: 'https://source.example/art/cloud',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  notice: 'Cloud Study & <b>Ada</b> — CC BY 4.0',
  modifications: 'cropped to 2048x2048 and desaturated',
  attributionRequired: true,
} as const;

const BASE_RIGHTS = { origin: 'test fixture', license: 'test-only', redistributable: true } as const;
const PRIVATE_RIGHTS = { ...ATTRIBUTION_RIGHTS, redistributable: false } as const;

/** A minimal, valid Project around the given Assets (no build needed to export). */
function project(assets: Project['assets'], sources: Project['sources'] = []): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'attribution_test',
    revision: 1,
    title: 'Attribution carry test',
    direction: { intent: 'test', looks: [{ id: 'look', description: 'test' }], transitions: [] },
    assets,
    bindings: {},
    sources,
    composition: {
      output: { width: 32, height: 24, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [],
      shots: [],
      placements: [],
      transitions: [],
      audio: [],
    },
  });
}

async function writeProject(root: string, value: Project): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(nodePath.join(root, 'project.json'), `${JSON.stringify(value, null, 2)}\n`);
}

/** A real, decodable 32x24 PNG fixture. */
async function pngFixture(base: string): Promise<string> {
  const file = nodePath.join(base, 'tiny.png');
  await runCommand('ffmpeg', [
    '-hide_banner',
    '-nostdin',
    '-v',
    'error',
    '-threads',
    '2',
    '-filter_threads',
    '1',
    '-f',
    'lavfi',
    '-i',
    'color=c=0x336699:s=32x24',
    '-frames:v',
    '1',
    file,
  ]);
  return file;
}

/** A real, decodable 160x120 MP4 fixture written under `root`. */
async function mp4Fixture(root: string, id: string): Promise<{ path: string; sha256: string }> {
  await fs.mkdir(root, { recursive: true });
  const relative = `${id}.mp4`;
  const file = nodePath.join(root, relative);
  await runCommand('ffmpeg', [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-filter_threads',
    '1',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=160x120:rate=25:duration=1',
    '-pix_fmt',
    'yuv420p',
    '-threads',
    '2',
    file,
  ]);
  return { path: relative, sha256: await hashFile(file) };
}

/** One media Source + placement around a single video Asset (plus any extras). */
function mediaProject(asset: Project['assets'][number], extra: Project['assets'] = []): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'attribution_media',
    revision: 1,
    title: 'Attribution media test',
    direction: { intent: 'one media shot', looks: [{ id: 'look_main', description: 'main look' }], transitions: [] },
    assets: [asset, ...extra],
    bindings: {},
    sources: [],
    composition: {
      output: { width: 160, height: 120, fps: { numerator: 25, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene_1', description: 'scene' }],
      shots: [{ id: 'shot_a', scene: 'scene_1', look: 'look_main', intent: 'a', targetFrames: 25 }],
      placements: [
        { id: 'pl_a', shot: 'shot_a', asset: asset.id, inFrame: 0, outFrame: 25, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio: [],
    },
  });
}

async function buildAt(root: string, value: Project): Promise<string> {
  await writeProject(root, value);
  const record = await buildProject(root);
  assert.equal(record.status, 'succeeded');
  return record.id;
}

// ---------------------------------------------------------------------------
// Positive carry: import -> move-directory -> export/restore -> archive/restore
// ---------------------------------------------------------------------------

test('attribution facts survive import, move-directory, export and archive restore', async () => {
  const base = await tmp();
  try {
    const root = nodePath.join(base, 'project');
    await writeProject(root, project([]));
    const source = await pngFixture(base);

    const asset = await importAsset(root, {
      assetId: 'cloud',
      sourcePath: source,
      type: 'image',
      rights: ATTRIBUTION_RIGHTS,
      expectedRevision: 1,
    });
    assert.deepEqual(asset.rights, ATTRIBUTION_RIGHTS, 'import records every attribution fact');

    // (a) Move directory: relative Asset paths reopen with the same rights.
    const moved = nodePath.join(base, 'moved');
    await fs.rename(root, moved);
    const reopened = await loadProject(moved);
    assert.deepEqual(reopened.assets[0].rights, ATTRIBUTION_RIGHTS, 'rights survive a directory move');

    // (b) Export -> reopen the portable export, and its manifest provenance.
    const exported = nodePath.join(base, 'exported');
    await exportProject(moved, exported);
    const fromExport = await loadProject(exported);
    assert.deepEqual(fromExport.assets[0].rights, ATTRIBUTION_RIGHTS, 'rights survive export/restore');
    const manifest = JSON.parse(
      await fs.readFile(nodePath.join(exported, '.viscraft', 'portable-manifest.json'), 'utf8'),
    ) as {
      files: Array<{ path: string; provenance: { kind: string; assetId?: string; rights?: unknown } }>;
    };
    const provenance = manifest.files.find(
      file => file.provenance.kind === 'asset' && file.provenance.assetId === 'cloud',
    );
    assert.ok(provenance, 'the portable manifest records the Asset provenance');
    assert.deepEqual(
      provenance.provenance.rights,
      ATTRIBUTION_RIGHTS,
      'portable manifest provenance carries every attribution fact',
    );

    // (b2) Archive -> restore into a fresh unrelated directory.
    const archive = nodePath.join(base, 'project.viscraft-archive');
    await archiveProject(moved, archive);
    const restored = nodePath.join(base, 'restored');
    await restoreProject(archive, restored);
    const fromArchive = await loadProject(restored);
    assert.deepEqual(fromArchive.assets[0].rights, ATTRIBUTION_RIGHTS, 'rights survive archive/restore');
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Positive carry: delivery index + project export + portable manifest
// ---------------------------------------------------------------------------

test('delivery carries attribution facts into index.html (escaped), project.json and the portable manifest', async () => {
  const base = await tmp();
  const root = nodePath.join(base, 'authoring');
  const destination = nodePath.join(base, 'bundle');
  try {
    const fixture = await mp4Fixture(root, 'cloud_clip');
    const asset = {
      id: 'cloud',
      revision: 1,
      path: fixture.path,
      sha256: fixture.sha256,
      type: 'video' as const,
      rights: ATTRIBUTION_RIGHTS,
      simulated: false,
    };
    await buildAt(root, mediaProject(asset));

    await deliverProject(root, destination, { review: true, stems: true });

    // index.html: every fact is present and HTML-escaped.
    const index = await fs.readFile(nodePath.join(destination, 'index.html'), 'utf8');
    assert.ok(index.includes('Ada &amp; Co'), 'author is rendered escaped');
    assert.ok(index.includes('https://source.example/art/cloud'), 'source link is rendered');
    assert.ok(index.includes('https://creativecommons.org/licenses/by/4.0/'), 'license link is rendered');
    assert.ok(index.includes('cropped to 2048x2048 and desaturated'), 'modification note is rendered');
    assert.ok(index.includes('Cloud Study &amp; &lt;b&gt;Ada&lt;/b&gt;'), 'notice text is rendered HTML-escaped');
    assert.equal(index.includes('<b>Ada</b>'), false, 'no unescaped markup is injected from the notice');

    // project/project.json keeps the authored rights verbatim.
    const exportedProject = validateProject(
      JSON.parse(await fs.readFile(nodePath.join(destination, 'project', 'project.json'), 'utf8')),
    );
    assert.deepEqual(
      exportedProject.assets.find(item => item.id === 'cloud')!.rights,
      ATTRIBUTION_RIGHTS,
      'bundled project.json carries the rights',
    );

    // Portable manifest provenance keeps them too.
    const portable = JSON.parse(
      await fs.readFile(nodePath.join(destination, 'project', '.viscraft', 'portable-manifest.json'), 'utf8'),
    ) as {
      files: Array<{ path: string; provenance: { kind: string; assetId?: string; rights?: unknown } }>;
      snapshotAssets: Array<{ provenance: { kind: string; assetId?: string; rights?: unknown } }>;
    };
    const authored = portable.files.find(
      file => file.provenance.kind === 'asset' && file.provenance.assetId === 'cloud',
    );
    assert.ok(authored, 'portable manifest lists the authored Asset');
    assert.deepEqual(
      authored!.provenance.rights,
      ATTRIBUTION_RIGHTS,
      'portable manifest provenance carries the rights',
    );
    const frozen = portable.snapshotAssets.find(item => item.provenance.assetId === 'cloud');
    assert.ok(frozen, 'the frozen Asset keeps its logical identity');
    assert.deepEqual(frozen!.provenance.rights, ATTRIBUTION_RIGHTS, 'frozen Asset provenance carries the rights');
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Negative 1: HTML detail page saved as .png -> import rejects
// ---------------------------------------------------------------------------

test('importAsset rejects detail-page HTML bytes masquerading as a PNG', async () => {
  const base = await tmp();
  try {
    const root = nodePath.join(base, 'project');
    await writeProject(root, project([]));
    const fake = nodePath.join(base, 'cloud.png');
    await fs.writeFile(fake, '<!doctype html><html><body><h1>Cloud Study</h1>Download</body></html>');
    await assert.rejects(
      importAsset(root, { assetId: 'fake', sourcePath: fake, type: 'image', rights: BASE_RIGHTS, expectedRevision: 1 }),
      /PNG\/JPEG\/WebP bytes/,
    );
    assert.equal((await loadProject(root)).assets.length, 0, 'no Asset is admitted on rejection');
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Negative 2: glTF referencing an unregistered external texture -> import rejects
// ---------------------------------------------------------------------------

test('importAsset rejects a glTF that references a missing/unregistered texture', async () => {
  const base = await tmp();
  try {
    const root = nodePath.join(base, 'project');
    await writeProject(root, project([]));
    const model = nodePath.join(base, 'prop.gltf');
    await fs.writeFile(
      model,
      JSON.stringify({
        asset: { version: '2.0' },
        meshes: [{ primitives: [] }],
        images: [{ uri: 'texture.png' }],
      }),
    );
    await assert.rejects(
      importAsset(root, {
        assetId: 'prop',
        sourcePath: model,
        type: 'model',
        rights: BASE_RIGHTS,
        expectedRevision: 1,
      }),
      /external image "texture\.png"/,
    );
    assert.equal((await loadProject(root)).assets.length, 0, 'no model is admitted with a dangling texture');
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Negative 3: redistribution forbidden -> strict export/archive/delivery abort
// ---------------------------------------------------------------------------

test('a non-redistributable Asset aborts strict export/archive/delivery unless the explicit opt-in is passed', async () => {
  const base = await tmp();
  try {
    const root = nodePath.join(base, 'authoring');
    const fixture = await mp4Fixture(root, 'private_clip');
    const asset = {
      id: 'private_clip',
      revision: 1,
      path: fixture.path,
      sha256: fixture.sha256,
      type: 'video' as const,
      rights: PRIVATE_RIGHTS,
      simulated: false,
    };
    await buildAt(root, mediaProject(asset));

    await assert.rejects(exportProject(root, nodePath.join(base, 'strict-export')), /not redistributable/);
    // Strict archive export rejects private assets unless explicitly permitted.
    await assert.rejects(archiveProject(root, nodePath.join(base, 'strict.viscraft-archive')), /not redistributable/);
    await assert.rejects(deliverProject(root, nodePath.join(base, 'strict-bundle')), /not redistributable/);

    // The explicit opt-in packages the private bytes and carries the attribution
    // facts on the private-Asset list (and its index table).
    const optIn = nodePath.join(base, 'opt-in-bundle');
    const delivery = await deliverProject(root, optIn, { review: true, stems: true, allowNonRedistributable: true });
    assert.equal(delivery.containsNonRedistributableAssets, true);
    assert.deepEqual(delivery.nonRedistributableAssets, [
      {
        asset: 'private_clip',
        path: fixture.path,
        origin: PRIVATE_RIGHTS.origin,
        license: PRIVATE_RIGHTS.license,
        author: PRIVATE_RIGHTS.author,
        sourceUrl: PRIVATE_RIGHTS.sourceUrl,
        licenseUrl: PRIVATE_RIGHTS.licenseUrl,
        notice: PRIVATE_RIGHTS.notice,
        modifications: PRIVATE_RIGHTS.modifications,
        attributionRequired: PRIVATE_RIGHTS.attributionRequired,
      },
    ]);
    const manifest = JSON.parse(await fs.readFile(nodePath.join(optIn, 'delivery-manifest.json'), 'utf8')) as {
      nonRedistributableAssets: Array<Record<string, unknown>>;
    };
    assert.equal(manifest.nonRedistributableAssets[0].author, PRIVATE_RIGHTS.author);
    assert.equal(manifest.nonRedistributableAssets[0].notice, PRIVATE_RIGHTS.notice);
    const index = await fs.readFile(nodePath.join(optIn, 'index.html'), 'utf8');
    assert.ok(index.includes('Ada &amp; Co'), 'the private-Asset table shows the author');
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Negative 4: declared attribution with no notice -> delivery fails loudly
// ---------------------------------------------------------------------------

test('deliverProject fails loudly when an Asset asserts attributionRequired with no notice, and passes once noticed', async () => {
  const base = await tmp();
  const root = nodePath.join(base, 'authoring');
  try {
    const fixture = await mp4Fixture(root, 'cloud_clip');
    const { notice: _omitted, ...rightsWithoutNotice } = ATTRIBUTION_RIGHTS;
    const asset = {
      id: 'cloud',
      revision: 1,
      path: fixture.path,
      sha256: fixture.sha256,
      type: 'video' as const,
      rights: rightsWithoutNotice,
      simulated: false,
    };
    const value = mediaProject(asset);
    await buildAt(root, value);

    await assert.rejects(deliverProject(root, nodePath.join(base, 'bundle-missing-notice')), (error: Error) => {
      assert.match(error.message, /attributionRequired/, 'the failure names the declared flag');
      assert.match(error.message, /no rights\.notice/, 'the failure states the missing notice');
      assert.match(error.message, /\bcloud\b/, 'the failure names the offending Asset id');
      return true;
    });
    assert.equal(
      await fs.stat(nodePath.join(base, 'bundle-missing-notice')).then(
        () => true,
        () => false,
      ),
      false,
      'no destination is created on failure',
    );

    // Recording the notice the author says is required makes the same project pass.
    const noticed = { ...rightsWithoutNotice, notice: ATTRIBUTION_RIGHTS.notice };
    await buildAt(root, mediaProject({ ...asset, revision: 1, rights: noticed }));
    const destination = nodePath.join(base, 'bundle-noticed');
    await deliverProject(root, destination, { review: true, stems: true });
    const index = await fs.readFile(nodePath.join(destination, 'index.html'), 'utf8');
    assert.ok(
      index.includes('Cloud Study &amp; &lt;b&gt;Ada&lt;/b&gt;'),
      'the recorded notice is delivered in the index',
    );
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

// The bundle ships the CURRENT editable project as `project/`, so the gate must
// cover Assets authored after the Build — not only the frozen snapshot — or an
// unattributed Asset would ride along unnoticed.
test('an Asset authored after the Build is still gated by delivery', async () => {
  const base = await tmp();
  const root = nodePath.join(base, 'authoring');
  try {
    const fixture = await mp4Fixture(root, 'cloud_clip');
    const built = {
      id: 'cloud',
      revision: 1,
      path: fixture.path,
      sha256: fixture.sha256,
      type: 'video' as const,
      rights: BASE_RIGHTS,
      simulated: false,
    };
    await buildAt(root, mediaProject(built));

    // Author a SECOND Asset after the Build, asserting a required notice but
    // recording none, and bump the revision WITHOUT rebuilding.
    const { notice: _omitted, ...rightsWithoutNotice } = ATTRIBUTION_RIGHTS;
    const late = {
      id: 'late',
      revision: 1,
      path: fixture.path,
      sha256: fixture.sha256,
      type: 'video' as const,
      rights: rightsWithoutNotice,
      simulated: false,
    };
    const bumped = ProjectSchema.parse({ ...mediaProject(built, [late]), revision: 2 });
    await writeProject(root, bumped);

    await assert.rejects(deliverProject(root, nodePath.join(base, 'bundle-stale-unnoticed')), (error: Error) => {
      assert.match(error.message, /\blate\b/, 'the failure names the post-Build Asset id');
      return true;
    });
    assert.equal(
      await fs.stat(nodePath.join(base, 'bundle-stale-unnoticed')).then(
        () => true,
        () => false,
      ),
      false,
      'no destination is created on failure',
    );

    // Recording the notice clears it without a rebuild.
    const noticed = ProjectSchema.parse({
      ...mediaProject(built, [{ ...late, rights: { ...rightsWithoutNotice, notice: ATTRIBUTION_RIGHTS.notice } }]),
      revision: 3,
    });
    await writeProject(root, noticed);
    await deliverProject(root, nodePath.join(base, 'bundle-late-noticed'));
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
