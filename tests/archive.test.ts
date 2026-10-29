/**
 * Unit-level verification of the single-file project archive transport.
 *
 * These tests exercise the PUBLIC `archiveProject` / `restoreProject` contract
 * and the internal path validator. Adversarial tar/gzip fixtures are encoded
 * HERE, independently of the transport writer (a private USTAR encoder in this
 * file), so a writer bug cannot rubber-stamp its own hostile input. Nothing here
 * launches a browser, runs FFmpeg or touches the network; real production
 * round-trips live in tests/archive.e2e.ts.
 *
 * A few result-field expectations (e.g. that `archiveProject(...).files` counts
 * the physical members excluding the manifest, and that `restoreProject`
 * reports the input archive) are documented next to the assertion so a contract
 * change is easy to reconcile.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import { archiveProject, restoreProject } from '../src/operations/delivery/archive.js';
import {
  assertArchivePath,
  assertArchivePaths,
  readArchiveTransport,
} from '../src/operations/delivery/archive-transport.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { loadProject, validateProject } from '../src/project/project.js';
import { hashFile } from '../src/shared/hash.js';
import { snapshotHashOf } from '../src/project/state.js';
import type { Asset, Composition, Project } from '../src/core/schema.js';
import { createSymlinkFixture } from './fs-fixtures.js';

const PORTABLE_MANIFEST = '.viscraft/portable-manifest.json';
const HEX_ZERO = '0'.repeat(64);
const BUILD_ID = `build-${'b'.repeat(36)}`;

test('restore accepts an archive through a caller-selected directory alias', async t => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await authorCodeProject(root);
    const physical = path.join(parent, 'physical');
    const alias = path.join(parent, 'alias');
    await mkdir(physical);
    if (!(await createSymlinkFixture(t, physical, alias))) return;
    const archive = path.join(physical, 'work.viscraft-archive');
    await archiveProject(root, archive);
    const restored = path.join(parent, 'restored');
    await restoreProject(path.join(alias, 'work.viscraft-archive'), restored);
    assert.deepEqual(
      await readFile(path.join(restored, 'project.json')),
      await readFile(path.join(root, 'project.json')),
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('restore rejects a symbolic-link archive file even in a trusted parent', async t => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await authorCodeProject(root);
    const archive = path.join(parent, 'work.viscraft-archive');
    const alias = path.join(parent, 'linked.viscraft-archive');
    await archiveProject(root, archive);
    if (!(await createSymlinkFixture(t, archive, alias))) return;
    await assert.rejects(restoreProject(alias, path.join(parent, 'restored')), /regular file without symbolic links/);
  } finally {
    await rm(parent, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
const ARTIFACT_ID = `artifact-${'c'.repeat(40)}`;
const TAKE_ID = `take-${'d'.repeat(40)}`;
const ARTIFACT_REL = `.viscraft/artifacts/${ARTIFACT_ID}.mp4`;
const REDISTRIBUTABLE = { origin: 'test', license: 'CC0-1.0', redistributable: true } as const;

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

async function tmp(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'viscraft-archive-'));
}
async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
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
function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// Independent USTAR/gzip fixture codec (deliberately NOT the transport writer)
// ---------------------------------------------------------------------------

interface TarMember {
  name: string;
  body: Buffer;
  typeflag?: string;
  prefix?: string;
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  const text = value
    .toString(8)
    .padStart(length - 1, '0')
    .slice(-(length - 1));
  header.write(text, offset, text.length, 'ascii');
  header[offset + length - 1] = 0;
}
function tarHeader(member: TarMember): Buffer {
  const header = Buffer.alloc(512);
  header.write(member.name, 0, Math.min(Buffer.byteLength(member.name, 'utf8'), 100), 'utf8');
  if (member.prefix) header.write(member.prefix, 345, Math.min(Buffer.byteLength(member.prefix, 'utf8'), 155), 'utf8');
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, member.body.length);
  writeOctal(header, 136, 12, 0);
  header.write(member.typeflag ?? '0', 156, 1, 'ascii');
  header.write('ustar', 257, 5, 'ascii');
  header[262] = 0;
  header.write('00', 263, 2, 'ascii');
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}
function encodeTar(members: TarMember[]): Buffer {
  const parts: Buffer[] = [];
  for (const member of members) {
    parts.push(tarHeader(member));
    parts.push(member.body);
    const pad = (512 - (member.body.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024)); // two zero blocks terminate the archive
  return Buffer.concat(parts);
}
function cstr(buffer: Buffer, offset: number, length: number): string {
  const nul = buffer.indexOf(0, offset);
  const stop = nul === -1 || nul > offset + length ? offset + length : nul;
  return buffer.toString('utf8', offset, stop);
}
function decodeTar(raw: Buffer): TarMember[] {
  const members: TarMember[] = [];
  let offset = 0;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    let name = cstr(header, 0, 100);
    const prefix = cstr(header, 345, 155);
    if (prefix) name = `${prefix}/${name}`;
    const size = Number.parseInt(cstr(header, 124, 12).trim() || '0', 8);
    members.push({
      name,
      body: Buffer.from(raw.subarray(offset + 512, offset + 512 + size)),
      typeflag: String.fromCharCode(header[156]),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return members;
}
/** Re-encode a decoded member list into an independent gzip tar. */
function reseal(members: TarMember[]): Buffer {
  return gzipSync(encodeTar(members));
}
/** Decode a real archive with the independent codec, run `transform`, reseal. */
function rearchive(archiveBytes: Buffer, transform: (members: TarMember[]) => TarMember[] | void): Buffer {
  const members = decodeTar(gunzipSync(archiveBytes));
  const next = transform(members);
  return reseal(next ?? members);
}
function member(members: TarMember[], name: string): TarMember {
  const found = members.find(candidate => candidate.name === name);
  if (!found) throw new Error(`fixture is missing tar member ${name}`);
  return found;
}
function readManifest(members: TarMember[]): Record<string, any> {
  return JSON.parse(member(members, PORTABLE_MANIFEST).body.toString('utf8'));
}
function writeManifest(members: TarMember[], manifest: unknown): void {
  member(members, PORTABLE_MANIFEST).body = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
}
/** Keep the manifest honest after a member body is mutated (so ONLY the tested defence fires). */
function refreshFileHash(members: TarMember[], target: string): void {
  const manifest = readManifest(members);
  const entry = manifest.files.find((file: { path: string }) => file.path === target);
  if (!entry) throw new Error(`manifest has no entry for ${target}`);
  entry.sha256 = sha256(member(members, target).body);
  entry.bytes = member(members, target).body.length;
  writeManifest(members, manifest);
}
async function writeArchive(file: string, bytes: Buffer): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
  return file;
}

// ---------------------------------------------------------------------------
// Project fixtures
// ---------------------------------------------------------------------------

function codeSource(entry: string, resources: string[] = [], id = 'src'): Project['sources'][number] {
  return { id, kind: 'browser', output: 'picture', entry, resources, bindings: [], params: {}, seed: 0, frames: 1 };
}
function output(): Composition['output'] {
  return { width: 32, height: 32, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 };
}
function baseProject(overrides: Partial<Project> = {}): Project {
  return {
    schemaVersion: 1,
    id: 'archive-test',
    revision: 1,
    title: 'Archive Test',
    direction: { intent: '', looks: [{ id: 'look', description: '' }], transitions: [] },
    assets: [],
    bindings: {},
    sources: [codeSource('scene.html')],
    composition: {
      output: output(),
      scenes: [{ id: 'scene', description: '' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: '', targetFrames: 1 }],
      placements: [{ id: 'edit', shot: 'shot', source: 'src', inFrame: 0, outFrame: 1, startFrame: 0, audio: 'mute' }],
      transitions: [],
      audio: [],
    },
    ...overrides,
  } as Project;
}
/** Author a minimal, self-contained code project (entry + optional resources). */
async function authorCodeProject(root: string, resources: string[] = [], id = 'archive-test'): Promise<Project> {
  const project = baseProject({ id, sources: [codeSource('scene.html', resources)] });
  await writeJson(path.join(root, 'project.json'), project);
  await writeFile(path.join(root, 'scene.html'), '<html>scene</html>');
  for (const relative of resources) {
    const file = path.join(root, ...relative.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `resource:${relative}`);
  }
  return project;
}
function lineageProject(take: string, assets: Asset[] = []): Project {
  return baseProject({
    id: 'archive-lineage',
    title: 'Lineage',
    assets,
    sources: [],
    composition: {
      output: output(),
      scenes: [{ id: 'scene', description: '' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: '', targetFrames: 2 }],
      placements: [{ id: 'edit', shot: 'shot', take, inFrame: 0, outFrame: 2, startFrame: 0, audio: 'mute' }],
      transitions: [],
      audio: [],
    },
  });
}
/**
 * A self-consistent Build/Artifact/selected-Take lineage with an optional frozen
 * Asset. Mirrors the real exporter's expectations (frozen inputs hash equals the
 * Build snapshotHash; frozen Asset is eligible for content addressing).
 */
async function makeLineage(root: string, options: { frozenAsset?: Asset } = {}): Promise<void> {
  const { frozenAsset } = options;
  const frozen = baseProject({
    id: 'archive-lineage',
    sources: [codeSource('scene.html', [], 'src_code')],
    assets: frozenAsset ? [frozenAsset] : [],
    composition: {
      output: output(),
      scenes: [{ id: 'scene', description: '' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: '', targetFrames: 2 }],
      placements: [{ id: 'edit', shot: 'shot', take: TAKE_ID, inFrame: 0, outFrame: 2, startFrame: 0, audio: 'mute' }],
      transitions: [],
      audio: [],
    },
  });
  const frozenParsed = validateProject(frozen);

  const snapshotDir = path.join(root, '.viscraft', 'snapshots', BUILD_ID);
  await mkdir(snapshotDir, { recursive: true });
  const entryFile = path.join(snapshotDir, 'scene.html');
  await writeFile(entryFile, '<html>frozen</html>');
  const files: Record<string, string> = { 'scene.html': await hashFile(entryFile) };
  if (frozenAsset) {
    const assetFile = path.join(snapshotDir, ...frozenAsset.path.split('/'));
    await mkdir(path.dirname(assetFile), { recursive: true });
    await writeFile(assetFile, 'frozen-asset-bytes');
    files[frozenAsset.path] = await hashFile(assetFile);
  }
  const computedHash = snapshotHashOf(frozenParsed, files, []);
  await writeJson(path.join(root, '.viscraft', 'snapshots', `${BUILD_ID}.project.json`), frozen);
  await writeJson(path.join(root, '.viscraft', 'snapshots', `${BUILD_ID}.inputs.json`), {
    files,
    unavailable: [],
  });

  const artifactFile = path.join(root, ...ARTIFACT_REL.split('/'));
  await mkdir(path.dirname(artifactFile), { recursive: true });
  await writeFile(artifactFile, 'fake-simulated-mp4-bytes');
  const actualSha = await hashFile(artifactFile);
  const artifact = {
    id: ARTIFACT_ID,
    path: ARTIFACT_REL,
    sha256: actualSha,
    kind: 'video',
    simulated: true,
    operation: 'simulated',
    inputs: [HEX_ZERO],
    backend: 'ffmpeg-simulated/test-only',
    media: {
      frames: 2,
      fps: { numerator: 30, denominator: 1 },
      width: 32,
      height: 32,
      duration: 2 / 30,
      videoCodec: 'h264',
    },
  };
  const take = {
    id: TAKE_ID,
    artifact: ARTIFACT_ID,
    source: 'src_code',
    sourceKey: HEX_ZERO,
    medium: 'picture',
    frames: 2,
    fps: { numerator: 30, denominator: 1 },
    simulated: true,
  };
  const build = {
    schemaVersion: 1,
    id: BUILD_ID,
    medium: 'picture',
    run: { id: `run-${'a'.repeat(36)}`, goal: 'archive unit lineage' },
    plan: { operations: ['op-' + 'e'.repeat(32)] },
    revision: 1,
    snapshotHash: computedHash,
    status: 'succeeded',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    operations: [
      {
        id: 'op-' + 'e'.repeat(32),
        kind: 'simulated',
        key: HEX_ZERO,
        inputs: [HEX_ZERO],
        artifact: ARTIFACT_ID,
        reused: false,
      },
    ],
    artifacts: [artifact],
    takes: [take],
    result: { artifact: ARTIFACT_ID, simulated: true },
  };
  await writeJson(path.join(root, '.viscraft', 'builds', `${BUILD_ID}.json`), build);
  await writeJson(path.join(root, '.viscraft', 'result.json'), {
    build: BUILD_ID,
    artifact: ARTIFACT_ID,
    simulated: true,
    path: ARTIFACT_REL,
    sha256: actualSha,
  });
  await writeJson(path.join(root, 'project.json'), lineageProject(TAKE_ID));
}

// ---------------------------------------------------------------------------
// 1. Archive structure and round-trip
// ---------------------------------------------------------------------------

test('archiveProject emits a gzip USTAR whose first member is the portable manifest and whose members match the manifest exactly', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    const project = await authorCodeProject(root, ['lib/util.js'], 'archive-structure');
    const projectBytes = await readFile(path.join(root, 'project.json'));
    const entryBytes = await readFile(path.join(root, 'scene.html'));
    const archive = path.join(parent, 'work.viscraft-archive');

    const result = await archiveProject(root, archive);
    assert.equal(result.path, archive);
    assert.equal(result.sha256, await hashFile(archive), 'sha256 must be the archive file digest');
    assert.equal(result.compressedBytes, (await stat(archive)).size, 'compressedBytes must be the archive file size');
    assert.equal(result.simulated, false);
    assert.ok(result.contentBytes > 0, 'contentBytes must count uncompressed member bytes');

    const members = decodeTar(gunzipSync(await readFile(archive)));
    assert.equal(members[0].name, PORTABLE_MANIFEST, 'the portable manifest must be the first tar member');
    const manifest = readManifest(members);
    assert.equal(manifest.version, 1, 'the current exporter always emits portable v1');
    assert.equal(result.files, manifest.files.length, 'files counts physical members, excluding the manifest');

    const actualPaths = members.map(item => item.name).sort();
    const expectedPaths = [PORTABLE_MANIFEST, ...manifest.files.map((file: { path: string }) => file.path)].sort();
    assert.deepEqual(actualPaths, expectedPaths, 'tar members must equal the manifest allowlist exactly');
    for (const file of manifest.files as Array<{ path: string; sha256: string }>) {
      assert.equal(
        sha256(member(members, file.path).body),
        file.sha256,
        `member body hash must match the manifest for ${file.path}`,
      );
    }

    // The source project is never modified by archiving.
    assert.deepEqual(await readFile(path.join(root, 'project.json')), projectBytes);
    assert.deepEqual(await readFile(path.join(root, 'scene.html')), entryBytes);
    assert.equal((await loadProject(root)).id, project.id);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('restoreProject round-trips exact bytes into a fresh unrelated directory and reports the input archive', async () => {
  const root = await tmp();
  const parent = await tmp();
  const unrelated = await tmp();
  try {
    await authorCodeProject(root, ['lib/util.js'], 'archive-roundtrip');
    const archive = path.join(parent, 'work.viscraft-archive');
    const archived = await archiveProject(root, archive);
    const archiveBytes = await readFile(archive);

    const destination = path.join(unrelated, 'reopened');
    const restored = await restoreProject(archive, destination);
    assert.equal(restored.path, destination);
    assert.equal(restored.simulated, false);
    // Documented assumption: restore reports the input archive it read.
    assert.equal(restored.sha256, archived.sha256);
    assert.equal(restored.compressedBytes, archived.compressedBytes);
    assert.equal(restored.files, archived.files);

    assert.equal((await loadProject(destination)).id, 'archive-roundtrip');
    assert.deepEqual(
      await readFile(path.join(destination, 'project.json')),
      await readFile(path.join(root, 'project.json')),
      'project.json bytes must survive verbatim',
    );
    for (const relative of ['project.json', 'scene.html', 'lib/util.js']) {
      assert.equal(
        await hashFile(path.join(destination, ...relative.split('/'))),
        await hashFile(path.join(root, ...relative.split('/'))),
        `${relative} must survive verbatim`,
      );
    }
    const restoredFiles = await listFiles(destination);
    assert.deepEqual(
      restoredFiles.filter(file => !file.startsWith('.viscraft/')).sort(),
      ['lib/util.js', 'project.json', 'scene.html'],
      'only the authored project files are restored at the author root',
    );
    // Generated pages live under the runtime dir, so an authored file may legally
    // be named VISCRAFT.md or ATTRIBUTION.md. The attribution page exists only
    // when there is material attribution to state.
    const archivedManifest = readManifest(decodeTar(gunzipSync(archiveBytes)));
    assert.ok(restoredFiles.includes('.viscraft/pages/VISCRAFT.md'), 'the fact page must be generated');
    assert.equal(
      restoredFiles.includes('.viscraft/pages/ATTRIBUTION.md'),
      archivedManifest.files.some((file: { path: string }) => file.path === '.viscraft/pages/ATTRIBUTION.md'),
      'the attribution page is present exactly when the manifest carries it',
    );
    assert.equal(await hashFile(archive), archived.sha256, 'restore must not modify the archive');
    assert.deepEqual(await readFile(archive), archiveBytes);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
    await rm(unrelated, { recursive: true, force: true });
  }
});

test('a project directory without a prior manifest archives as the current format tar', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await authorCodeProject(root, [], 'archive-directory');
    const exported = path.join(parent, 'directory-export');
    await exportProject(root, exported);
    const archive = path.join(parent, 'directory.viscraft-archive');
    await archiveProject(exported, archive);
    const manifest = readManifest(decodeTar(gunzipSync(await readFile(archive))));
    assert.equal(manifest.version, 1, 'archiving a directory export always produces the current container');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('restoreProject refuses an existing destination, a missing parent and a destination inside the project root', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    await authorCodeProject(root, [], 'archive-dest');
    const archive = path.join(parent, 'work.viscraft-archive');
    await archiveProject(root, archive);

    const used = path.join(parent, 'used');
    await mkdir(used, { recursive: true });
    await writeFile(path.join(used, 'sentinel.txt'), 'keep me');
    await assert.rejects(restoreProject(archive, used), /exist/i);
    assert.equal(
      await readFile(path.join(used, 'sentinel.txt'), 'utf8'),
      'keep me',
      'an existing destination must be left untouched',
    );

    await assert.rejects(restoreProject(archive, path.join(parent, 'missing', 'child')), /parent|ENOENT|exist/i);

    // Archiving into the project root (or a descendant) is refused.
    await assert.rejects(archiveProject(root, path.join(root, 'inside.viscraft-archive')), /outside|root|exist/i);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Manifest allowlist / integrity defence
// ---------------------------------------------------------------------------

test('restoreProject rejects an unlisted, missing, duplicated or content-corrupt member', async () => {
  const root = await tmp();
  const parent = await tmp();
  const staging = await tmp();
  try {
    await authorCodeProject(root, ['lib/util.js'], 'archive-integrity');
    const archive = path.join(parent, 'work.viscraft-archive');
    await archiveProject(root, archive);
    const bytes = await readFile(archive);

    const cases: Array<{ name: string; tamper: (members: TarMember[]) => TarMember[] | void }> = [
      {
        name: 'an unlisted extra member',
        tamper: members => {
          members.push({ name: 'evil.txt', body: Buffer.from('smuggled') });
        },
      },
      {
        name: 'a listed member removed',
        tamper: members => members.filter(item => item.name !== 'scene.html'),
      },
      {
        name: 'a duplicated member',
        tamper: members => {
          const entry = member(members, 'scene.html');
          members.push({ name: entry.name, body: Buffer.from(entry.body) });
        },
      },
      {
        name: 'a corrupt member body',
        tamper: members => {
          member(members, 'scene.html').body = Buffer.from('<html>tampered</html>');
        },
      },
    ];

    for (const [index, item] of cases.entries()) {
      const hostile = await writeArchive(
        path.join(staging, `hostile-${index}.viscraft-archive`),
        rearchive(bytes, item.tamper),
      );
      const destination = path.join(staging, `out-${index}`);
      await assert.rejects(restoreProject(hostile, destination), /./, `expected ${item.name} to be rejected`);
      assert.equal(
        await stat(destination).then(
          () => true,
          () => false,
        ),
        false,
        `no destination may be published for ${item.name}`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
  }
});

test('restoreProject rejects forged provenance, self-declared credential/scratch files and an invalid extra Build record', async () => {
  const root = await tmp();
  const parent = await tmp();
  const staging = await tmp();
  try {
    await authorCodeProject(root, ['lib/util.js'], 'archive-forged');
    const archive = path.join(parent, 'work.viscraft-archive');
    await archiveProject(root, archive);
    const bytes = await readFile(archive);

    const cases: Array<{ name: string; tamper: (members: TarMember[]) => TarMember[] | void }> = [
      {
        name: 'a forged file provenance',
        tamper: members => {
          const manifest = readManifest(members);
          manifest.files.find((file: { path: string }) => file.path === 'scene.html').provenance = { kind: 'project' };
          writeManifest(members, manifest);
        },
      },
      {
        name: 'a self-declared credential file',
        tamper: members => {
          const body = Buffer.from('API_KEY=leak');
          members.push({ name: '.env', body });
          const manifest = readManifest(members);
          manifest.files.push({
            path: '.env',
            sha256: sha256(body),
            provenance: { kind: 'source', sourceId: 'src', role: 'resource' },
          });
          writeManifest(members, manifest);
        },
      },
      {
        name: 'a self-declared runtime scratch file',
        tamper: members => {
          const body = Buffer.from('scratch');
          members.push({ name: '.viscraft/scratch/state.bin', body });
          const manifest = readManifest(members);
          manifest.files.push({
            path: '.viscraft/scratch/state.bin',
            sha256: sha256(body),
            provenance: { kind: 'source', sourceId: 'src', role: 'resource' },
          });
          writeManifest(members, manifest);
        },
      },
      {
        name: 'an invalid extra Build record the reader would prune',
        tamper: members => {
          const body = Buffer.from('{ this is not a valid build record');
          const relative = `.viscraft/builds/build-${'9'.repeat(36)}.json`;
          members.push({ name: relative, body });
          const manifest = readManifest(members);
          manifest.files.push({
            path: relative,
            sha256: sha256(body),
            provenance: { kind: 'build', buildId: `build-${'9'.repeat(36)}` },
          });
          writeManifest(members, manifest);
        },
      },
      {
        name: 'a corrupt manifest (invalid JSON)',
        tamper: members => {
          member(members, PORTABLE_MANIFEST).body = Buffer.from('{ this is not a valid portable manifest');
        },
      },
      {
        name: 'an unknown manifest field',
        tamper: members => {
          const manifest = readManifest(members);
          manifest.unknownInjectedField = true;
          writeManifest(members, manifest);
        },
      },
      {
        name: 'a forged but well-formed source-role provenance',
        tamper: members => {
          const manifest = readManifest(members);
          manifest.files.find((file: { path: string }) => file.path === 'lib/util.js').provenance = {
            kind: 'source',
            sourceId: 'src',
            role: 'entry',
          };
          writeManifest(members, manifest);
        },
      },
    ];

    for (const [index, item] of cases.entries()) {
      const hostile = await writeArchive(
        path.join(staging, `hostile-${index}.viscraft-archive`),
        rearchive(bytes, item.tamper),
      );
      const destination = path.join(staging, `out-${index}`);
      await assert.rejects(restoreProject(hostile, destination), /./, `expected ${item.name} to be rejected`);
      assert.equal(
        await stat(destination).then(
          () => true,
          () => false,
        ),
        false,
        `no destination may be published for ${item.name}`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. v1 deduplicated frozen Asset trust boundary
// ---------------------------------------------------------------------------

test('a v1 lineage archive restores, and rejections cover unused mappings, undeclared blobs and corrupt/missing blobs', async () => {
  const root = await tmp();
  const parent = await tmp();
  const staging = await tmp();
  try {
    const frozenAsset: Asset = {
      id: 'asset-frozen',
      revision: 1,
      path: 'media/a.bin',
      sha256: HEX_ZERO,
      type: 'image',
      rights: REDISTRIBUTABLE,
      simulated: false,
    };
    await makeLineage(root, { frozenAsset });
    const archive = path.join(parent, 'lineage.viscraft-archive');
    const archived = await archiveProject(root, archive);
    assert.equal(archived.simulated, true, 'the simulated lineage must be reported as simulated');
    const members = decodeTar(gunzipSync(await readFile(archive)));
    const manifest = readManifest(members);
    assert.equal(manifest.version, 1);
    assert.equal(manifest.snapshotAssets.length, 1, 'the eligible frozen Asset must be content-addressed');
    const blob = manifest.snapshotAssets[0].content as string;
    assert.equal(manifest.snapshotAssets[0].sha256, sha256(member(members, blob).body));
    const bytes = await readFile(archive);

    // A faithful restore succeeds and preserves the simulated provenance.
    const destination = path.join(staging, 'faithful');
    const restored = await restoreProject(archive, destination);
    assert.equal(restored.simulated, true);
    assert.equal((await loadProject(destination)).id, 'archive-lineage');
    assert.equal(
      await hashFile(path.join(destination, ...ARTIFACT_REL.split('/'))),
      sha256(Buffer.from('fake-simulated-mp4-bytes')),
    );

    const cases: Array<{ name: string; tamper: (members: TarMember[]) => TarMember[] | void }> = [
      {
        name: 'an unused extra snapshot-asset mapping',
        tamper: members => {
          const next = readManifest(members);
          next.snapshotAssets.push({
            path: `.viscraft/snapshots/${BUILD_ID}/media/unused.bin`,
            sha256: next.snapshotAssets[0].sha256,
            content: next.snapshotAssets[0].content,
            provenance: next.snapshotAssets[0].provenance,
          });
          writeManifest(members, next);
        },
      },
      {
        name: 'an undeclared content blob',
        tamper: members => {
          const body = Buffer.from('unreferenced blob');
          const relative = `.viscraft/content/${sha256(body)}`;
          members.push({ name: relative, body });
          const next = readManifest(members);
          next.files.push({ path: relative, sha256: sha256(body), provenance: { kind: 'snapshot-content' } });
          writeManifest(members, next);
        },
      },
      {
        name: 'a corrupt content blob',
        tamper: members => {
          member(members, blob).body = Buffer.from('corrupted blob bytes');
        },
      },
      {
        name: 'a missing content blob',
        tamper: members => members.filter(item => item.name !== blob),
      },
    ];

    for (const [index, item] of cases.entries()) {
      const hostile = await writeArchive(
        path.join(staging, `hostile-${index}.viscraft-archive`),
        rearchive(bytes, item.tamper),
      );
      const target = path.join(staging, `out-${index}`);
      await assert.rejects(restoreProject(hostile, target), /./, `expected ${item.name} to be rejected`);
      assert.equal(
        await stat(target).then(
          () => true,
          () => false,
        ),
        false,
        `no destination may be published for ${item.name}`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
  }
});

test('restoreProject rejects a rights or simulated provenance mismatch between the manifest and the project', async () => {
  const root = await tmp();
  const parent = await tmp();
  const staging = await tmp();
  try {
    const frozenAsset: Asset = {
      id: 'asset-frozen',
      revision: 1,
      path: 'media/a.bin',
      sha256: HEX_ZERO,
      type: 'image',
      rights: REDISTRIBUTABLE,
      simulated: false,
    };
    await makeLineage(root, { frozenAsset });
    const archive = path.join(parent, 'lineage.viscraft-archive');
    await archiveProject(root, archive);
    const bytes = await readFile(archive);

    const cases: Array<{ name: string; tamper: (members: TarMember[]) => TarMember[] | void }> = [
      {
        name: 'a frozen Asset simulated flag flip',
        tamper: members => {
          const manifest = readManifest(members);
          manifest.snapshotAssets[0].provenance.simulated = true;
          writeManifest(members, manifest);
        },
      },
      {
        name: 'a frozen Asset rights change',
        tamper: members => {
          const manifest = readManifest(members);
          manifest.snapshotAssets[0].provenance.rights.license = 'forged-license';
          writeManifest(members, manifest);
        },
      },
      {
        name: 'a package-level simulated flag flip',
        tamper: members => {
          const manifest = readManifest(members);
          manifest.simulated = false;
          writeManifest(members, manifest);
        },
      },
      {
        name: 'a forged but well-formed artifact provenance',
        tamper: members => {
          const manifest = readManifest(members);
          const artifactFile = manifest.files.find((file: { path: string }) => file.path === ARTIFACT_REL);
          if (!artifactFile) throw new Error('fixture has no artifact file entry');
          artifactFile.provenance = {
            kind: 'artifact',
            artifactId: ARTIFACT_ID,
            operation: 'forged-operation',
            simulated: true,
          };
          writeManifest(members, manifest);
        },
      },
    ];

    for (const [index, item] of cases.entries()) {
      const hostile = await writeArchive(
        path.join(staging, `hostile-${index}.viscraft-archive`),
        rearchive(bytes, item.tamper),
      );
      const target = path.join(staging, `out-${index}`);
      await assert.rejects(restoreProject(hostile, target), /./, `expected ${item.name} to be rejected`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Framing faults and size caps
// ---------------------------------------------------------------------------

test('restoreProject rejects framing faults: truncation, bad checksum/magic/version, oversized sizes, missing end blocks and trailing bytes', async () => {
  const root = await tmp();
  const parent = await tmp();
  const staging = await tmp();
  try {
    await authorCodeProject(root, [], 'archive-framing');
    const archive = path.join(parent, 'work.viscraft-archive');
    await archiveProject(root, archive);
    const gzipBytes = await readFile(archive);
    const raw = gunzipSync(gzipBytes);

    // Offset of the second member (first physical file) so we can mutate a real header.
    const firstSize = Number.parseInt(cstr(raw.subarray(124, 136), 0, 12).trim(), 8);
    const secondHeader = 512 + Math.ceil(firstSize / 512) * 512;

    const mutations: Array<{ name: string; bytes: Buffer }> = [];
    mutations.push({ name: 'a truncated gzip stream', bytes: gzipBytes.subarray(0, Math.floor(gzipBytes.length / 2)) });
    mutations.push({ name: 'a truncated decoded stream', bytes: gzipSync(raw.subarray(0, secondHeader + 8)) });

    const badChecksum = Buffer.from(raw);
    badChecksum[secondHeader] = badChecksum[secondHeader] === 0x7a ? 0x7b : 0x7a;
    mutations.push({ name: 'a bad header checksum', bytes: gzipSync(badChecksum) });

    const badMagic = Buffer.from(raw);
    badMagic.write('bad!!', secondHeader + 257, 'ascii');
    mutations.push({ name: 'a bad USTAR magic', bytes: gzipSync(badMagic) });

    const badVersion = Buffer.from(raw);
    badVersion.write('xx', secondHeader + 263, 'ascii');
    mutations.push({ name: 'a bad USTAR version', bytes: gzipSync(badVersion) });

    const oversized = Buffer.from(raw);
    oversized.write('77777777777', secondHeader + 124, 'ascii');
    mutations.push({ name: 'an oversized declared member size', bytes: gzipSync(oversized) });

    const nonEmptyLink = Buffer.from(raw);
    nonEmptyLink.write('target', secondHeader + 157, 'ascii');
    mutations.push({ name: 'a non-empty linkname on a regular file', bytes: gzipSync(nonEmptyLink) });

    if (firstSize % 512 !== 0) {
      const dirtyPadding = Buffer.from(raw);
      dirtyPadding[512 + firstSize] = 0x41;
      mutations.push({ name: 'non-zero header padding', bytes: gzipSync(dirtyPadding) });
    }

    mutations.push({ name: 'missing terminating zero blocks', bytes: gzipSync(raw.subarray(0, raw.length - 1024)) });
    mutations.push({
      name: 'trailing decoded bytes after the end blocks',
      bytes: gzipSync(Buffer.concat([raw, Buffer.alloc(512, 0x41)])),
    });

    for (const [index, mutation] of mutations.entries()) {
      const hostile = await writeArchive(path.join(staging, `hostile-${index}.viscraft-archive`), mutation.bytes);
      const target = path.join(staging, `out-${index}`);
      await assert.rejects(restoreProject(hostile, target), /./, `expected ${mutation.name} to be rejected`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
  }
});

test('restoreProject refuses an unsupported manifest tar and non-regular or traversal member types', async () => {
  const root = await tmp();
  const parent = await tmp();
  const staging = await tmp();
  try {
    await authorCodeProject(root, [], 'archive-framing2');
    const archive = path.join(parent, 'work.viscraft-archive');
    await archiveProject(root, archive);
    const bytes = await readFile(archive);

    const unsupported = rearchive(bytes, members => {
      const manifest = readManifest(members);
      manifest.version = 99;
      writeManifest(members, manifest);
      return members;
    });
    await assert.rejects(
      restoreProject(
        await writeArchive(path.join(staging, 'unsupported.viscraft-archive'), unsupported),
        path.join(staging, 'unsupported-out'),
      ),
      /version|unsupported/i,
    );

    const asDirectory = rearchive(bytes, members => {
      member(members, 'scene.html').typeflag = '5';
    });
    await assert.rejects(
      restoreProject(
        await writeArchive(path.join(staging, 'dir.viscraft-archive'), asDirectory),
        path.join(staging, 'dir-out'),
      ),
    );

    const asSymlink = rearchive(bytes, members => {
      member(members, 'scene.html').typeflag = '2';
    });
    await assert.rejects(
      restoreProject(
        await writeArchive(path.join(staging, 'link.viscraft-archive'), asSymlink),
        path.join(staging, 'link-out'),
      ),
    );

    const traversal = rearchive(bytes, members => {
      members.push({ name: '../escape.txt', body: Buffer.from('escape') });
    });
    await assert.rejects(
      restoreProject(
        await writeArchive(path.join(staging, 'trav.viscraft-archive'), traversal),
        path.join(staging, 'trav-out'),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
  }
});

test('restoreProject enforces path-based size caps so a huge JSON member cannot ride an ordinary provenance', async () => {
  const root = await tmp();
  const parent = await tmp();
  const staging = await tmp();
  try {
    await authorCodeProject(root, [], 'archive-caps');
    const archive = path.join(parent, 'work.viscraft-archive');
    await archiveProject(root, archive);
    const bytes = await readFile(archive);

    // An over-cap portable manifest is refused up front.
    const bigManifest = rearchive(bytes, members => {
      const manifest = readManifest(members);
      manifest.notes = ['x'.repeat(9 * 1024 * 1024)];
      writeManifest(members, manifest);
    });
    await assert.rejects(
      restoreProject(
        await writeArchive(path.join(staging, 'big-manifest.viscraft-archive'), bigManifest),
        path.join(staging, 'big-manifest-out'),
      ),
      /cap|limit|size|manifest/i,
    );

    // An over-cap project.json is refused even though its manifest hash matches.
    const bigProject = rearchive(bytes, members => {
      const project = JSON.parse(member(members, 'project.json').body.toString('utf8'));
      project.title = 'x'.repeat(9 * 1024 * 1024);
      member(members, 'project.json').body = Buffer.from(`${JSON.stringify(project, null, 2)}\n`);
      refreshFileHash(members, 'project.json');
    });
    await assert.rejects(
      restoreProject(
        await writeArchive(path.join(staging, 'big-project.viscraft-archive'), bigProject),
        path.join(staging, 'big-project-out'),
      ),
      /cap|limit|size|metadata/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
  }
});

test('restoreProject refuses an over-cap snapshot-inputs JSON metadata member even with a matching manifest hash', async () => {
  const root = await tmp();
  const parent = await tmp();
  const staging = await tmp();
  try {
    const frozenAsset: Asset = {
      id: 'asset-frozen',
      revision: 1,
      path: 'media/a.bin',
      sha256: HEX_ZERO,
      type: 'image',
      rights: REDISTRIBUTABLE,
      simulated: false,
    };
    await makeLineage(root, { frozenAsset });
    const archive = path.join(parent, 'lineage.viscraft-archive');
    await archiveProject(root, archive);
    const bytes = await readFile(archive);
    const relative = `.viscraft/snapshots/${BUILD_ID}.inputs.json`;

    const hostile = rearchive(bytes, members => {
      const inputs = JSON.parse(member(members, relative).body.toString('utf8'));
      inputs.environment = { runtime: 'test', padding: 'x'.repeat(9 * 1024 * 1024) };
      member(members, relative).body = Buffer.from(`${JSON.stringify(inputs, null, 2)}\n`);
      refreshFileHash(members, relative);
    });
    await assert.rejects(
      restoreProject(
        await writeArchive(path.join(staging, 'big-inputs.viscraft-archive'), hostile),
        path.join(staging, 'big-inputs-out'),
      ),
      /cap|limit|size|metadata/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. Long paths and internal path validation
// ---------------------------------------------------------------------------

test('archiveProject preserves long UTF-8 paths by USTAR prefix splitting and refuses unrepresentable names without truncation', async () => {
  const root = await tmp();
  const parent = await tmp();
  const unrelated = await tmp();
  try {
    // Total > 100 bytes, each component <= 100 bytes and the prefix <= 155 bytes:
    // must be representable by name/prefix splitting, never truncated.
    const splittable = `${'d'.repeat(60)}/${'n'.repeat(60)}.js`;
    await authorCodeProject(root, [splittable], 'archive-longpath');
    const archive = path.join(parent, 'long.viscraft-archive');
    await archiveProject(root, archive);
    const destination = path.join(unrelated, 'long-out');
    await restoreProject(archive, destination);
    assert.equal(
      await hashFile(path.join(destination, ...splittable.split('/'))),
      await hashFile(path.join(root, ...splittable.split('/'))),
      'a prefix-split path must round-trip byte-exact',
    );

    // A single component beyond the USTAR name field cannot be represented and
    // must be refused, not silently renamed.
    const root2 = await tmp();
    const unrepresentable = `${'x'.repeat(120)}.js`;
    await authorCodeProject(root2, [unrepresentable], 'archive-toolong');
    const rejectedArchive = path.join(parent, 'toolong.viscraft-archive');
    await assert.rejects(archiveProject(root2, rejectedArchive));
    assert.equal(
      await stat(rejectedArchive).then(
        () => true,
        () => false,
      ),
      false,
      'a refused path must not leave an archive behind',
    );
    await rm(root2, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
    await rm(unrelated, { recursive: true, force: true });
  }
});

test('assertArchivePath rejects hostile names and assertArchivePaths rejects duplicate/casefold/NFC/parent-file collisions', () => {
  const hostile = [
    '../escape',
    '/absolute/path',
    'a/../../b',
    'dir/',
    'dir//file',
    '',
    'C:/windows',
    'C:\\windows',
    '\\\\server\\share',
    'name:',
    'a\u0001b',
    'a\u007fb',
    'CON',
    'NUL',
    'COM1',
    'AUX',
    'trailing ',
    'trailing.',
    'trail. ',
    'a?b',
    'a*b',
    'a"b',
    'a<b',
    'a>b',
    'a|b',
  ];
  for (const name of hostile) {
    assert.throws(() => assertArchivePath(name), `expected assertArchivePath to reject ${JSON.stringify(name)}`);
  }
  // Ordinary names, including inner spaces and dots, are allowed.
  for (const name of ['scene.html', 'lib/util.js', 'a b/c.d', '.hidden', 'assets/secret-garden.png']) {
    assert.doesNotThrow(() => assertArchivePath(name), `expected assertArchivePath to accept ${name}`);
  }

  assert.doesNotThrow(() => assertArchivePaths(['a/b', 'c/d']));
  assert.throws(() => assertArchivePaths(['a/b', 'a/b']), /duplicate|twice/i);
  assert.throws(() => assertArchivePaths(['A/b', 'a/b']), /case|collid|duplicate/i);
  assert.throws(() => assertArchivePaths(['caf\u00e9', 'cafe\u0301']), /nfc|normal|collid|duplicate/i);
  assert.throws(() => assertArchivePaths(['a', 'a/b']), /parent|file|collid/i);
  // Case-folded / NFC-normalized ancestors and directory aliases must also be
  // rejected, not only exactly-equal member names.
  assert.throws(() => assertArchivePaths(['A', 'a/x']), /case|collid|duplicate|parent/i);
  assert.throws(() => assertArchivePaths(['caf\u00e9', 'cafe\u0301/x']), /nfc|normal|collid|duplicate|parent/i);
  assert.throws(() => assertArchivePaths(['e\u0301/x', '\u00e9/y']), /nfc|normal|collid|duplicate/i);
  assert.throws(() => assertArchivePaths(['A/x', 'a/y']), /case|collid|duplicate/i);
  // Distinct siblings, repeated same-case directories, a file next to another
  // directory, and a directory/file name reused at different depths must all
  // stay representable (guarding against over-rejection).
  for (const allowed of [
    ['a/x', 'a/y'],
    ['A/x', 'A/y'],
    ['x', 'dir/x'],
    ['a/b', 'b/c'],
    ['a', 'b/a'],
  ] as const) {
    assert.doesNotThrow(() => assertArchivePaths([...allowed]), `expected ${JSON.stringify(allowed)} to be accepted`);
  }
});

// ---------------------------------------------------------------------------
// 6. Production hash identity is untouched
// ---------------------------------------------------------------------------

test('shared/hash.ts hashFile keeps the canonical sha256 identity the archive transport must not change', async () => {
  const root = await tmp();
  try {
    const file = path.join(root, 'identity.bin');
    await writeFile(file, Buffer.from('viscraft-archive-identity'));
    assert.equal(await hashFile(file), sha256(Buffer.from('viscraft-archive-identity')));
    assert.equal(sha256(Buffer.alloc(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. Split archives and manifest-declared limits
// ---------------------------------------------------------------------------

async function treeHashes(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const relative of (await listFiles(root)).sort()) {
    if (relative === PORTABLE_MANIFEST) continue; // exportedAt differs between two exports
    out[relative] = await hashFile(path.join(root, ...relative.split('/')));
  }
  return out;
}

test('archive --part-size splits into verified parts that restore byte-identically to the single-file archive', async () => {
  const root = await tmp();
  const other = await tmp();
  const parent = await tmp();
  try {
    await authorCodeProject(root, ['lib/util.js'], 'archive-parts');
    // Incompressible bytes so the archive spans several 4 KiB parts.
    await writeFile(path.join(root, 'lib', 'util.js'), (await import('node:crypto')).randomBytes(20_000));
    const single = await archiveProject(root, path.join(parent, 'single.tar.gz'));
    const split = await archiveProject(root, path.join(parent, 'split.tar.gz'), { partSize: 4096 });
    assert.equal(split.path, path.join(parent, 'split.tar.gz.parts.json'));
    assert.ok(split.parts!.length >= 5, 'the archive is cut into several parts');
    assert.ok(split.parts!.every(part => part.bytes <= 4096));
    assert.deepEqual(
      split.parts!.map(part => part.name),
      split.parts!.map((_, index) => `split.tar.gz.part-${String(index + 1).padStart(3, '0')}`),
    );
    const list = JSON.parse(await readFile(split.path, 'utf8'));
    assert.deepEqual(
      { projectId: list.projectId, revision: list.revision, archive: list.archive },
      { projectId: 'archive-parts', revision: 1, archive: { sha256: split.sha256, bytes: split.compressedBytes } },
    );

    const fromSingle = await restoreProject(single.path, path.join(parent, 'from-single'));
    const fromParts = await restoreProject(split.path, path.join(parent, 'from-parts'));
    assert.equal(fromParts.sha256, split.sha256);
    assert.deepEqual(await treeHashes(fromParts.path), await treeHashes(fromSingle.path));

    // A foreign archive with the same part names, for the "mixed-in part" case.
    await authorCodeProject(other, [], 'archive-foreign');
    await writeFile(path.join(other, 'scene.html'), (await import('node:crypto')).randomBytes(20_000));
    const foreignDir = await tmp();
    try {
      const foreign = await archiveProject(other, path.join(foreignDir, 'split.tar.gz'), { partSize: 4096 });
      const cases: Array<{ name: string; tamper: (dir: string) => Promise<void>; pattern: RegExp }> = [
        {
          name: 'a missing part',
          tamper: dir => rm(path.join(dir, split.parts![1].name)),
          pattern: /part is missing/,
        },
        {
          name: 'one flipped byte',
          tamper: async dir => {
            const file = path.join(dir, split.parts![2].name);
            const bytes = await readFile(file);
            bytes[10] ^= 0xff;
            await writeFile(file, bytes);
          },
          pattern: /recorded hash/,
        },
        {
          name: 'a part from another archive',
          tamper: dir => copyFile(path.join(foreignDir, foreign.parts![1].name), path.join(dir, split.parts![1].name)),
          pattern: /recorded|bytes/,
        },
        {
          name: 'a parts list that names another project',
          tamper: async dir => {
            const file = path.join(dir, 'split.tar.gz.parts.json');
            const edited = JSON.parse(await readFile(file, 'utf8'));
            edited.projectId = 'archive-foreign';
            await writeFile(file, JSON.stringify(edited));
          },
          pattern: /different project/,
        },
        {
          name: 'a parts list whose total disagrees with the parts',
          tamper: async dir => {
            const file = path.join(dir, 'split.tar.gz.parts.json');
            const edited = JSON.parse(await readFile(file, 'utf8'));
            edited.archive.bytes += 1;
            await writeFile(file, JSON.stringify(edited));
          },
          pattern: /records/,
        },
      ];
      for (const [index, item] of cases.entries()) {
        const dir = await tmp();
        try {
          for (const name of [...split.parts!.map(part => part.name), 'split.tar.gz.parts.json'])
            await copyFile(path.join(parent, name), path.join(dir, name));
          await item.tamper(dir);
          const destination = path.join(dir, `out-${index}`);
          await assert.rejects(
            restoreProject(path.join(dir, 'split.tar.gz.parts.json'), destination),
            item.pattern,
            item.name,
          );
          await assert.rejects(stat(destination), /ENOENT/, `${item.name} publishes nothing`);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
    } finally {
      await rm(foreignDir, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test('the reader holds an archive to its manifest declaration and to the absolute content cap', async () => {
  const root = await tmp();
  const parent = await tmp();
  const staging = await tmp();
  try {
    await authorCodeProject(root, ['lib/util.js'], 'archive-declared');
    const archive = path.join(parent, 'work.tar.gz');
    const archived = await archiveProject(root, archive);
    const bytes = await readFile(archive);

    // One extra content byte in a member the manifest declares (hash kept honest).
    const extraByte = rearchive(bytes, members => {
      const target = member(members, 'lib/util.js');
      target.body = Buffer.concat([target.body, Buffer.from('!')]);
      const manifest = readManifest(members);
      manifest.files.find((file: { path: string }) => file.path === 'lib/util.js').sha256 = sha256(target.body);
      writeManifest(members, manifest);
    });
    await assert.rejects(
      restoreProject(await writeArchive(path.join(staging, 'extra-byte.tar.gz'), extraByte), path.join(staging, 'a')),
      /differs from the manifest declaration/,
    );

    // One extra decoded block after the end marker exceeds the exact declared decoded size.
    const raw = gunzipSync(bytes);
    const extraBlock = gzipSync(Buffer.concat([raw, Buffer.alloc(512)]));
    await assert.rejects(
      restoreProject(await writeArchive(path.join(staging, 'extra-block.tar.gz'), extraBlock), path.join(staging, 'b')),
      /decoded content/,
    );

    // A compressed input larger than its parts list declares.
    await assert.rejects(
      readArchiveTransport(archive, staging, async () => undefined, { compressedBytes: archived.compressedBytes - 1 }),
      /parts list declares/,
    );

    // Absolute caps: restoring or archiving above --max-content is refused with the flag named.
    await assert.rejects(
      restoreProject(archive, path.join(staging, 'c'), { maxContent: archived.contentBytes - 1 }),
      /--max-content/,
    );
    await assert.rejects(
      archiveProject(root, path.join(parent, 'capped.tar.gz'), { maxContent: 1024 }),
      /--max-content/,
    );
    const restored = await restoreProject(archive, path.join(staging, 'd'), { maxContent: archived.contentBytes });
    assert.equal(restored.contentBytes, archived.contentBytes, 'a cap equal to the declaration is enough');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
  }
});

test('archive packages non-redistributable assets only with the explicit opt-in', async () => {
  const root = await tmp();
  const parent = await tmp();
  try {
    const privateAsset: Asset = {
      id: 'asset-private',
      revision: 1,
      path: 'media/private.png',
      sha256: sha256('private'),
      type: 'image',
      rights: { origin: 'stock', license: 'editorial-only', redistributable: false },
      simulated: false,
    };
    const project = baseProject({
      assets: [privateAsset],
      bindings: { picture: 'asset-private' },
      sources: [
        {
          id: 'src',
          kind: 'browser',
          output: 'picture',
          entry: 'scene.html',
          resources: [],
          bindings: ['picture'],
          params: {},
          seed: 0,
          frames: 1,
        },
      ],
    });
    await writeJson(path.join(root, 'project.json'), project);
    await writeFile(path.join(root, 'scene.html'), '<html>scene</html>');
    await mkdir(path.join(root, 'media'), { recursive: true });
    await writeFile(path.join(root, 'media', 'private.png'), 'private');
    await assert.rejects(
      archiveProject(root, path.join(parent, 'default.tar.gz')),
      /not redistributable/,
      'the default archive must refuse a non-redistributable asset',
    );
    const archived = await archiveProject(root, path.join(parent, 'allowed.tar.gz'), {
      allowNonRedistributable: true,
    });
    assert.ok(archived.files >= 1, 'the explicit opt-in packages the private asset');
    const restored = await restoreProject(path.join(parent, 'allowed.tar.gz'), path.join(parent, 'restored'));
    assert.equal(restored.contentBytes, archived.contentBytes, 'the opt-in archive restores to the same content');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

/**
 * Archive/restore must replay the AUTHOR scope, not flatten a restricted export
 * into "complete": the restored package still lacks the declared file, so a
 * default re-export refuses and the manifest keeps saying it is not whole.
 */
test('archive and restore replay a restricted author scope without claiming completeness', async () => {
  const root = await tmp();
  const parent = await tmp();
  const unrelated = await tmp();
  try {
    const ghost = { ...codeSource('ghost.html', [], 'ghost') };
    const project = baseProject({ sources: [codeSource('scene.html'), ghost] });
    await writeJson(path.join(root, 'project.json'), project);
    await writeFile(path.join(root, 'scene.html'), '<html>scene</html>');

    const exported = path.join(parent, 'restricted');
    await exportProject(root, exported, { allowIncompleteAuthored: true });
    const manifest = JSON.parse(await readFile(path.join(exported, PORTABLE_MANIFEST), 'utf8'));
    assert.equal(manifest.scope.authoredScope, 'allow-incomplete');
    assert.equal(manifest.scope.authorComplete, false);
    assert.equal(manifest.scope.wholeAuthorRestorable, false);
    assert.deepEqual(
      manifest.scope.authoredGaps.map((gap: { path: string }) => gap.path),
      ['ghost.html'],
    );

    // Archiving re-exports the directory, so the restricted scope is requested
    // again explicitly — it is never inherited silently from the old manifest.
    const archive = path.join(parent, 'restricted.viscraft-archive');
    await archiveProject(exported, archive, { allowIncompleteAuthored: true });
    const destination = path.join(unrelated, 'reopened');
    await restoreProject(archive, destination);
    assert.equal((await loadProject(destination)).id, 'archive-test');
    const restored = JSON.parse(await readFile(path.join(destination, PORTABLE_MANIFEST), 'utf8'));
    assert.equal(restored.scope.authoredScope, 'allow-incomplete', 'the scope survives transport');
    assert.equal(
      restored.files.some((file: { path: string }) => file.path === 'ghost.html'),
      false,
    );

    // The restored bytes really lack the file: a default re-export still refuses.
    await assert.rejects(exportProject(destination), /ghost\.html|author state/i);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
    await rm(unrelated, { recursive: true, force: true });
  }
});
