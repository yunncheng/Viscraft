import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, open, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportPlayable } from '../src/operations/delivery/playable-export.js';
import { hashFile } from '../src/shared/hash.js';
import {
  PlayableLiveProjectSchema,
  PlayablePackageManifestSchema,
  type Asset,
  type Project,
} from '../src/core/schema.js';

const OUTPUT = {
  width: 32,
  height: 32,
  fps: { numerator: 5, denominator: 1 },
  sampleRate: 48000 as const,
  channels: 1 as const,
};

const CONTENTS: Record<string, string> = {
  'game.html':
    '<!doctype html>\n<html><body><canvas></canvas><script type="module" src="./game.js"></script></body></html>\n',
  'other.html': '<!doctype html><html></html>\n',
  'vendor/three.module.js': 'export const threeVendor = 1;\n',
  LICENSE: 'MIT License\nCopyright (c) 2026 test vendor\n',
  'world-state.js': 'export const sampleWorld = () => ({ entities: [] });\n',
  'assets/blue.svg': '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#0000ff"/></svg>\n',
  'assets/red.svg': '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#ff0000"/></svg>\n',
  'assets/gate.svg': '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#00ff00"/></svg>\n',
  'assets/font.woff2': 'wOF2 fake font payload bytes',
  'assets/private.png': 'not a real png but a private unrelated asset',
};

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

const TEMP_DIRS: string[] = [];
async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'viscraft-playable-export-'));
  TEMP_DIRS.push(dir);
  return dir;
}

// Every temporary project/package directory created by this file is removed once
// the suite finishes, so a run leaves no debris on the host.
after(async () => {
  await Promise.all(TEMP_DIRS.map(dir => rm(dir, { recursive: true, force: true })));
});

async function writeRelative(root: string, relative: string, data: Buffer | string): Promise<string> {
  const absolute = path.join(root, ...relative.split('/'));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, data);
  return absolute;
}

async function readJson<T = any>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

const VENDOR_RIGHTS = { origin: 'Three.js r186 (test)', license: 'MIT', redistributable: true };

interface FixtureOptions {
  bindingOverrides?: Record<string, string>;
  blueRedistributable?: boolean;
  vendorRedistributable?: boolean;
  gateRedistributable?: boolean;
  redSimulated?: boolean;
  blueDerivedFrom?: boolean;
  entryRegistered?: 'private' | 'public';
  entry?: string;
  resources?: string[];
  /** When set, the `game` Source is a recorded-session replay carrying this path. */
  recording?: string;
}

interface Fixture {
  root: string;
  project: Project;
  assets: Record<string, Asset>;
}

function asset(id: string, type: Asset['type'], relative: string, rights: Asset['rights'], simulated = false): Asset {
  return { id, revision: 1, path: relative, sha256: sha256(CONTENTS[relative]), type, rights, simulated };
}

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await tmp();
  for (const [relative, content] of Object.entries(CONTENTS)) await writeRelative(root, relative, content);

  const entry = options.entry ?? 'game.html';
  const resources = options.resources ?? ['vendor/three.module.js', 'LICENSE', 'world-state.js'];

  const assets: Record<string, Asset> = {
    asset_blue: asset('asset_blue', 'image', 'assets/blue.svg', {
      origin: 'authored blue',
      license: 'CC0',
      redistributable: options.blueRedistributable ?? true,
    }),
    asset_red: asset(
      'asset_red',
      'image',
      'assets/red.svg',
      { origin: 'authored red', license: 'CC0', redistributable: true },
      options.redSimulated ?? false,
    ),
    asset_font: asset('asset_font', 'font', 'assets/font.woff2', {
      origin: 'authored font',
      license: 'OFL',
      redistributable: true,
    }),
    asset_gate: asset('asset_gate', 'image', 'assets/gate.svg', {
      origin: 'authored gate',
      license: 'CC0',
      redistributable: options.gateRedistributable ?? true,
    }),
    asset_vendor: asset('asset_vendor', 'code', 'vendor/three.module.js', {
      ...VENDOR_RIGHTS,
      redistributable: options.vendorRedistributable ?? true,
    }),
    asset_private: asset('asset_private', 'image', 'assets/private.png', {
      origin: 'private draft',
      license: 'all-rights-reserved',
      redistributable: false,
    }),
  };
  if (options.blueDerivedFrom) {
    assets.asset_blue = {
      ...assets.asset_blue,
      derivedFrom: {
        kind: 'frame',
        build: 'build-parent-0001',
        artifact: 'artifact-parent-0001',
        sha256: 'a'.repeat(64),
        frame: 0,
      },
    };
  }
  if (options.entryRegistered) {
    assets.asset_entry_html = asset('asset_entry_html', 'code', entry, {
      origin: 'authored entry',
      license: 'CC0',
      redistributable: options.entryRegistered === 'public',
    });
  }

  const overrides = options.bindingOverrides;
  const gameSource =
    options.recording !== undefined
      ? {
          id: 'game',
          kind: 'browser' as const,
          output: 'picture' as const,
          entry,
          resources,
          bindings: ['blue', 'font'],
          params: { speed: 3 },
          seed: 7,
          frames: 12,
          recording: options.recording,
          world: { id: 'world_a', camera: 'cam_main', mode: 'define' as const },
          ...(overrides ? { bindingOverrides: overrides } : {}),
        }
      : {
          id: 'game',
          kind: 'browser' as const,
          output: 'picture' as const,
          entry,
          resources,
          bindings: ['blue', 'font'],
          params: { speed: 3, palette: '#123456' },
          seed: 7,
          frames: 12,
          world: { id: 'world_a', camera: 'cam_main', mode: 'define' as const },
          ...(overrides ? { bindingOverrides: overrides } : {}),
        };

  const project = {
    schemaVersion: 1,
    id: 'playable-export-fixture',
    revision: 4,
    title: 'Playable Export Fixture',
    direction: { intent: '', looks: [{ id: 'look', description: '' }], transitions: [] },
    assets: Object.values(assets),
    bindings: { blue: 'asset_blue', font: 'asset_font' },
    sources: [
      gameSource,
      {
        id: 'other',
        kind: 'browser' as const,
        output: 'picture' as const,
        entry: 'other.html',
        resources: [],
        bindings: [],
        params: { secretMarker: 'UNRELATED_SOURCE_PARAM' },
        seed: 0,
        frames: 1,
      },
      {
        // A non-picture browser Source: exportPlayable only accepts a browser
        // PICTURE Source, so naming this one is a wrong-kind rejection.
        id: 'film',
        kind: 'browser' as const,
        output: 'sound' as const,
        entry: 'other.html',
        resources: [],
        params: {},
        seed: 0,
        durationSamples: 5,
        sampleRate: 48000,
      },
    ],
    worlds: [
      {
        id: 'world_a',
        revision: 1,
        units: 'meters' as const,
        coordinates: 'right-handed-y-up' as const,
        fps: { numerator: 5, denominator: 1 },
        frames: 12,
        entities: [
          {
            id: 'blue_box',
            asset: 'asset_blue',
            transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
            state: {},
          },
          {
            id: 'gate',
            asset: 'asset_gate',
            transform: { position: [3, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
            state: {},
          },
        ],
        trajectories: [],
        cameras: [{ id: 'cam_main', position: [0, 2, -5], target: [0, 0, 0], fov: 50 }],
      },
    ],
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: '' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: '', targetFrames: 12 }],
      placements: [
        { id: 'edit', shot: 'shot', source: 'game', inFrame: 0, outFrame: 12, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio: [],
    },
  } as unknown as Project;

  await writeRelative(root, 'project.json', `${JSON.stringify(project, null, 2)}\n`);
  return { root, project, assets };
}

async function exportTo(
  fixture: Fixture,
  sourceId = 'game',
  destination?: string,
): Promise<{ result: Awaited<ReturnType<typeof exportPlayable>>; dest: string }> {
  const dest = destination ?? path.join(await tmp(), 'package');
  const result = await exportPlayable(fixture.root, sourceId, dest);
  return { result, dest };
}

test('exports a standalone live package for a code source and omits unrelated/private content', async () => {
  const fixture = await createFixture();
  const { result, dest } = await exportTo(fixture);

  assert.match(result.id, /^playable-[a-f0-9]{16}$/);
  assert.equal(result.entry, 'game.html');
  assert.equal(result.simulated, false);
  assert.equal(result.path, await realpath(dest));

  const manifest = PlayablePackageManifestSchema.parse(await readJson(path.join(dest, 'playable-manifest.json')));
  assert.equal(manifest.id, result.id);
  assert.equal(result.files, manifest.files.length);
  assert.equal(manifest.format, 'viscraft-playable-package');
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.project, { id: fixture.project.id, revision: 4, title: 'Playable Export Fixture' });
  assert.equal(manifest.source.id, 'game');
  assert.equal(manifest.source.entry, 'game.html');
  assert.match(manifest.source.sourceHash, /^[a-f0-9]{64}$/);
  assert.equal(manifest.simulated, false);
  assert.equal(result.sha256, sha256(await readFile(path.join(dest, 'playable-manifest.json'))));

  const byPath = new Map(manifest.files.map(file => [file.path, file]));
  assert.equal(byPath.get('project.json')?.role, 'configuration');
  assert.equal(byPath.get('game.html')?.role, 'entry');
  assert.equal(byPath.get('LICENSE')?.role, 'resource');
  assert.equal(byPath.get('world-state.js')?.role, 'resource');
  assert.equal(byPath.get('vendor/three.module.js')?.role, 'asset');
  assert.equal(byPath.get('vendor/three.module.js')?.asset, 'asset_vendor');
  assert.deepEqual(byPath.get('vendor/three.module.js')?.rights, VENDOR_RIGHTS);
  assert.equal(byPath.get('assets/blue.svg')?.asset, 'asset_blue');
  assert.equal(byPath.get('assets/font.woff2')?.asset, 'asset_font');
  assert.equal(byPath.get('assets/gate.svg')?.asset, 'asset_gate');

  // Unrelated private asset and the not-selected red asset are legitimately excluded.
  assert.ok(!byPath.has('assets/private.png'));
  assert.ok(!byPath.has('assets/red.svg'));
  assert.ok(!manifest.files.some(file => file.path.startsWith('.viscraft/')));
  assert.ok(!manifest.files.some(file => file.path.includes('recordings/')));

  // Every manifest hash matches the real bytes on disk, and those bytes equal the origin.
  for (const file of manifest.files) {
    assert.equal(await hashFile(path.join(dest, ...file.path.split('/'))), file.sha256, `hash of ${file.path}`);
  }
  assert.equal(await readFile(path.join(dest, 'game.html'), 'utf8'), CONTENTS['game.html']);
  assert.equal(await readFile(path.join(dest, 'assets/blue.svg'), 'utf8'), CONTENTS['assets/blue.svg']);

  // Live configuration is exactly the narrow schema and nothing else.
  const config = PlayableLiveProjectSchema.parse(await readJson(path.join(dest, 'project.json')));
  assert.equal(config.sources.length, 1);
  const liveSource = config.sources[0];
  assert.equal(liveSource.kind, 'browser');
  if (liveSource.kind !== 'browser' || liveSource.output !== 'picture')
    throw new Error('live config source must be a browser picture Source');
  assert.deepEqual(liveSource.bindings, ['blue', 'font']);
  assert.deepEqual(config.bindings, { blue: 'asset_blue', font: 'asset_font' });
  assert.deepEqual(Object.keys(config.composition), ['output']);
  assert.equal(config.worlds?.length, 1);
  assert.equal(config.worlds?.[0].cameras.length, 1);
  assert.deepEqual(
    config.worlds?.[0].entities.map(entity => [entity.id, entity.asset]),
    [
      ['blue_box', 'asset_blue'],
      ['gate', 'asset_gate'],
    ],
  );
  assert.deepEqual(
    config.assets.map(item => item.id),
    ['asset_blue', 'asset_font', 'asset_gate', 'asset_vendor'],
  );

  const configText = await readFile(path.join(dest, 'project.json'), 'utf8');
  assert.ok(!configText.includes('UNRELATED_SOURCE_PARAM'));
  assert.ok(!configText.includes('private.png'));
  assert.ok(!configText.includes('"shots"'));
  assert.ok(!configText.includes('"placements"'));
  assert.ok(!configText.includes('"scenes"'));
  assert.ok(!configText.includes('recording'));
  // The packaged project.json is the narrow live configuration, never the editable origin Project.
  assert.notEqual(sha256(configText), sha256(await readFile(path.join(fixture.root, 'project.json'))));
});

test('flattens scoped binding overrides into the resolved world, bindings and selected assets', async () => {
  const fixture = await createFixture({ bindingOverrides: { blue: 'asset_red' } });
  const { dest } = await exportTo(fixture);

  const manifest = PlayablePackageManifestSchema.parse(await readJson(path.join(dest, 'playable-manifest.json')));
  const byPath = new Map(manifest.files.map(file => [file.path, file]));
  assert.equal(byPath.get('assets/red.svg')?.asset, 'asset_red');
  assert.equal(byPath.get('assets/gate.svg')?.asset, 'asset_gate');
  assert.ok(!byPath.has('assets/blue.svg'));

  const config = PlayableLiveProjectSchema.parse(await readJson(path.join(dest, 'project.json')));
  assert.deepEqual(config.bindings, { blue: 'asset_red', font: 'asset_font' });
  assert.ok(!Object.hasOwn(config.sources[0], 'bindingOverrides'));
  const liveSource = config.sources[0];
  if (liveSource.kind !== 'browser' || liveSource.output !== 'picture')
    throw new Error('live config source must be a browser picture Source');
  assert.deepEqual(liveSource.bindings, ['blue', 'font']);
  assert.deepEqual(
    config.worlds?.[0].entities.map(entity => [entity.id, entity.asset]),
    [
      ['blue_box', 'asset_red'],
      ['gate', 'asset_gate'],
    ],
  );
  assert.deepEqual(
    config.assets.map(item => item.id),
    ['asset_font', 'asset_gate', 'asset_red', 'asset_vendor'],
  );
});

test('converts a playable source to live code without copying or replaying its recording', async () => {
  const fixture = await createFixture({ recording: 'recordings/rec/session.json' });
  const { result, dest } = await exportTo(fixture);

  // The recording was never created on disk; the export must not read it.
  await assert.rejects(() => stat(path.join(fixture.root, 'recordings/rec/session.json')));

  const config = PlayableLiveProjectSchema.parse(await readJson(path.join(dest, 'project.json')));
  assert.equal(config.sources[0].kind, 'browser');
  assert.ok(!Object.hasOwn(config.sources[0], 'recording'));
  assert.equal(result.simulated, false);

  const manifest = PlayablePackageManifestSchema.parse(await readJson(path.join(dest, 'playable-manifest.json')));
  assert.equal(manifest.simulated, false);
  assert.ok(!manifest.files.some(file => file.path.includes('recordings/')));
  assert.ok(!(await listFiles(dest)).some(relative => relative.includes('recordings/')));
});

test('taints the package as simulated when a selected asset is simulated', async () => {
  const fixture = await createFixture({ bindingOverrides: { blue: 'asset_red' }, redSimulated: true });
  const { result, dest } = await exportTo(fixture);
  assert.equal(result.simulated, true);
  const manifest = PlayablePackageManifestSchema.parse(await readJson(path.join(dest, 'playable-manifest.json')));
  assert.equal(manifest.simulated, true);
});

test('does not modify the origin Project or its active Result', async () => {
  const fixture = await createFixture();
  const projectBefore = await readFile(path.join(fixture.root, 'project.json'));
  const resultSentinel = `${JSON.stringify({ sentinel: 'untouched' })}\n`;
  await writeRelative(fixture.root, '.viscraft/result.json', resultSentinel);

  await exportTo(fixture);

  assert.equal(sha256(await readFile(path.join(fixture.root, 'project.json'))), sha256(projectBefore));
  assert.equal(await readFile(path.join(fixture.root, '.viscraft/result.json'), 'utf8'), resultSentinel);
});

test('is deterministic: identical input yields identical id and manifest hash', async () => {
  const fixture = await createFixture();
  const first = await exportTo(fixture);
  const second = await exportTo(fixture);
  assert.equal(first.result.id, second.result.id);
  assert.equal(first.result.sha256, second.result.sha256);
  assert.equal(first.result.files, second.result.files);
  assert.equal(
    sha256(await readFile(path.join(first.dest, 'playable-manifest.json'))),
    sha256(await readFile(path.join(second.dest, 'playable-manifest.json'))),
  );
});

test('rejects a non-redistributable bound asset', async () => {
  const fixture = await createFixture({ blueRedistributable: false });
  await assert.rejects(
    exportPlayable(fixture.root, 'game', path.join(await tmp(), 'package')),
    /asset_blue is not redistributable/,
  );
});

test('rejects a non-redistributable registered resource asset', async () => {
  const fixture = await createFixture({ vendorRedistributable: false });
  await assert.rejects(
    exportPlayable(fixture.root, 'game', path.join(await tmp(), 'package')),
    /resource asset asset_vendor is not redistributable/,
  );
});

test('rejects credential and reserved content paths', async () => {
  const credential = await createFixture({ resources: ['vendor/three.module.js', '.env'] });
  await writeRelative(credential.root, '.env', 'SECRET=1\n');
  await assert.rejects(exportPlayable(credential.root, 'game', path.join(await tmp(), 'package')), /credential file/);
  const credentialAlias = await createFixture({ resources: ['vendor/three.module.js', '.ENV'] });
  await writeRelative(credentialAlias.root, '.ENV', 'FAKE_FIXTURE=1\n');
  await assert.rejects(
    exportPlayable(credentialAlias.root, 'game', path.join(await tmp(), 'package')),
    /credential file/,
  );

  const reservedEntry = await createFixture({ entry: 'project.json' });
  await assert.rejects(
    exportPlayable(reservedEntry.root, 'game', path.join(await tmp(), 'package')),
    /reserved package file/,
  );

  const reservedResource = await createFixture({ resources: ['vendor/three.module.js', 'playable-manifest.json'] });
  await assert.rejects(
    exportPlayable(reservedResource.root, 'game', path.join(await tmp(), 'package')),
    /reserved package file/,
  );
  const reservedAlias = await createFixture({ resources: ['vendor/three.module.js', 'PLAYABLE-MANIFEST.JSON'] });
  await assert.rejects(
    exportPlayable(reservedAlias.root, 'game', path.join(await tmp(), 'package')),
    /reserved package file/,
  );
});

test('rejects damaged registered assets before exporting current bytes as approved', async () => {
  const fixture = await createFixture();
  await writeFile(path.join(fixture.root, 'assets/blue.svg'), 'changed approved content');
  await assert.rejects(exportPlayable(fixture.root, 'game', path.join(await tmp(), 'package')), /hash mismatch/i);
});

test('rejects an existing destination, a destination inside the root, and unknown/wrong-kind sources', async () => {
  const fixture = await createFixture();

  const existing = path.join(await tmp(), 'package');
  await mkdir(existing, { recursive: true });
  await assert.rejects(exportPlayable(fixture.root, 'game', existing), /already exists/);

  await assert.rejects(
    exportPlayable(fixture.root, 'game', path.join(fixture.root, 'package')),
    /outside the project root/,
  );

  await assert.rejects(
    exportPlayable(fixture.root, 'missing-source', path.join(await tmp(), 'package')),
    /unknown source/,
  );
  await assert.rejects(
    exportPlayable(fixture.root, 'film', path.join(await tmp(), 'package')),
    /must be a browser picture Source/,
  );
});

test('rejects a non-redistributable asset referenced only by a World entity', async () => {
  const fixture = await createFixture({ gateRedistributable: false });
  await assert.rejects(
    exportPlayable(fixture.root, 'game', path.join(await tmp(), 'package')),
    /asset_gate is not redistributable/,
  );
});

test('checks rights for a registered entry Asset instead of letting it bypass the closure', async () => {
  const denied = await createFixture({ entryRegistered: 'private' });
  await assert.rejects(
    exportPlayable(denied.root, 'game', path.join(await tmp(), 'package')),
    /asset_entry_html is not redistributable/,
  );

  const allowed = await createFixture({ entryRegistered: 'public' });
  const { dest } = await exportTo(allowed);
  const manifest = PlayablePackageManifestSchema.parse(await readJson(path.join(dest, 'playable-manifest.json')));
  const entry = manifest.files.find(file => file.path === 'game.html');
  assert.equal(entry?.role, 'entry');
  assert.equal(entry?.asset, 'asset_entry_html');
  assert.equal(entry?.rights?.redistributable, true);
  const config = PlayableLiveProjectSchema.parse(await readJson(path.join(dest, 'project.json')));
  assert.ok(config.assets.some(item => item.id === 'asset_entry_html'));
});

test('keeps derivedFrom metadata as a reference without packaging the parent video', async () => {
  const fixture = await createFixture({ blueDerivedFrom: true });
  const { dest } = await exportTo(fixture);

  const manifest = PlayablePackageManifestSchema.parse(await readJson(path.join(dest, 'playable-manifest.json')));
  assert.ok(!manifest.files.some(file => file.path.startsWith('.viscraft/')));
  assert.ok(!manifest.files.some(file => file.path.includes('artifact-parent-0001')));

  const config = PlayableLiveProjectSchema.parse(await readJson(path.join(dest, 'project.json')));
  const blue = config.assets.find(item => item.id === 'asset_blue');
  assert.deepEqual(blue?.derivedFrom, {
    kind: 'frame',
    build: 'build-parent-0001',
    artifact: 'artifact-parent-0001',
    sha256: 'a'.repeat(64),
    frame: 0,
  });
  assert.ok(!(await listFiles(dest)).some(relative => relative.includes('artifact-parent-0001')));
});

test('a default playable package replaces in place when unmodified and refuses a member edit', async () => {
  const fixture = await createFixture();
  const first = await exportPlayable(fixture.root, 'game');
  assert.equal(first.path, path.join(fixture.root, 'output', 'playable-game'));
  const second = await exportPlayable(fixture.root, 'game');
  assert.equal(second.path, first.path, 'an unmodified package is replaced in place');

  // Edit a package member while leaving playable-manifest.json untouched.
  const entry = path.join(first.path, 'game.html');
  const edited = `${await readFile(entry, 'utf8')}<!-- edited -->\n`;
  await writeFile(entry, edited);
  await assert.rejects(() => exportPlayable(fixture.root, 'game'), /already exists and has been modified/i);
  assert.equal(await readFile(entry, 'utf8'), edited, 'the edited member is preserved');
});

test('a playable carries a required resource larger than 100 MiB without altering it', async () => {
  const relative = 'assets/large-texture.bin';
  const { root } = await createFixture({ resources: [relative] });
  const source = path.join(root, relative);
  await mkdir(path.dirname(source), { recursive: true });
  const file = await open(source, 'w');
  try {
    await file.write(Buffer.from('resource bytes'));
    await file.truncate(101 * 1024 * 1024);
  } finally {
    await file.close();
  }
  const originalSha = await hashFile(source);
  const projectBefore = await readFile(path.join(root, 'project.json'));
  const destination = await tmp();
  await rm(destination, { recursive: true });
  const exported = await exportPlayable(root, 'game', destination);
  const manifest = await readJson<{ files: Array<{ path: string; sha256: string }> }>(
    path.join(destination, 'playable-manifest.json'),
  );
  const sizes = await Promise.all(
    manifest.files.map(async entry => (await stat(path.join(destination, entry.path))).size),
  );
  assert.ok(sizes.reduce((sum, bytes) => sum + bytes, 0) > 100 * 1024 * 1024);
  assert.equal(manifest.files.find(entry => entry.path === relative)?.sha256, originalSha);
  assert.equal(await hashFile(path.join(exported.path, relative)), originalSha);
  assert.deepEqual(await readFile(path.join(root, 'project.json')), projectBefore);
  assert.equal(await hashFile(source), originalSha);
});
