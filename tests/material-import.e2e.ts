import { createSymlinkFixture } from './fs-fixtures.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProjectSchema, type Asset, type Project } from '../src/core/schema.js';
import { importAsset, inspectAssetInputs, type ImportAssetOptions } from '../src/operations/assets/import.js';
import { loadProject, validateProject } from '../src/project/project.js';
import { atomicJson } from '../src/shared/fs.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';

const RIGHTS = { origin: 'original local material-import test', license: 'CC0-1.0', redistributable: true };
const CHILD_RIGHTS = {
  origin: 'approved derivative test session',
  license: 'private test approval',
  redistributable: false,
};
const HEX = 'a'.repeat(64);

function project(assets: Asset[] = []): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'import_test',
    revision: 1,
    title: 'Local material admission',
    direction: { intent: 'test', looks: [{ id: 'look', description: 'test' }], transitions: [] },
    assets,
    bindings: {},
    sources: [{ id: 'source', kind: 'browser', output: 'picture', entry: 'scene.html', frames: 24 }],
    composition: {
      output: { width: 32, height: 24, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene', description: 'test' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: 'test', targetFrames: 24 }],
      placements: [
        { id: 'placement', shot: 'shot', source: 'source', inFrame: 0, outFrame: 24, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio: [],
    },
  });
}

async function makePng(destination: string, color: string): Promise<void> {
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
    `color=c=${color}:s=32x24`,
    '-frames:v',
    '1',
    destination,
  ]);
}

async function fixture(): Promise<{ base: string; root: string; source: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'viscraft-material-import-'));
  const root = path.join(base, 'project');
  const source = path.join(base, 'original.png');
  await mkdir(root);
  await atomicJson(path.join(root, 'project.json'), project());
  await makePng(source, '0x3467aa');
  return { base, root, source };
}

async function plainAsset(root: string, id: string, bytes: string, simulated = false): Promise<Asset> {
  const relative = `assets/${id}.js`;
  await mkdir(path.join(root, 'assets'), { recursive: true });
  await writeFile(path.join(root, relative), bytes);
  return {
    id,
    revision: 1,
    path: relative,
    sha256: await hashFile(path.join(root, relative)),
    type: 'code',
    rights: RIGHTS,
    simulated,
  };
}

async function assertRejectedUnchanged(root: string, options: ImportAssetOptions, reason: RegExp): Promise<void> {
  const before = await readFile(path.join(root, 'project.json'));
  const names = await readdir(path.join(root, 'assets')).catch(() => []);
  await assert.rejects(importAsset(root, options), reason);
  assert.deepEqual(await readFile(path.join(root, 'project.json')), before, 'rejection preserves Project bytes');
  assert.deepEqual(
    await readdir(path.join(root, 'assets')).catch(() => []),
    names,
    'rejection leaves no admitted or partial target',
  );
  assert.deepEqual(await readdir(path.join(root, '.viscraft', 'scratch')).catch(() => []), [], 'staging is removed');
  const runtimeFiles: string[] = await readdir(path.join(root, '.viscraft')).catch(() => []);
  assert.equal(runtimeFiles.includes('author.lock'), false, 'author lock is released');
}

test('importAsset admits decoded PNG bytes with explicit rights, immutable identity and frozen production inputs', async () => {
  const { base, root, source } = await fixture();
  try {
    const sourceBefore = await readFile(source);
    const parent = await importAsset(root, {
      assetId: 'reference',
      sourcePath: source,
      type: 'image',
      rights: RIGHTS,
      expectedRevision: 1,
    });
    const child = await importAsset(root, {
      assetId: 'approved_variant',
      sourcePath: source,
      type: 'image',
      rights: CHILD_RIGHTS,
      expectedRevision: 2,
      expectedSha256: parent.sha256,
      inputs: [{ asset: 'reference', role: '  retain composition  ' }],
    });
    assert.deepEqual(child.rights, CHILD_RIGHTS, 'caller supplies derivative rights; parent approval is not inherited');
    assert.equal(child.revision, 1);
    assert.equal(child.simulated, false);
    // Identical bytes already registered as an Asset reuse its physical copy, so
    // a second identity never duplicates media in the author area.
    assert.equal(child.path, parent.path, 'identical bytes reuse the registered copy instead of duplicating it');
    assert.deepEqual(child.inputs, [
      { asset: parent.id, revision: parent.revision, sha256: parent.sha256, role: 'retain composition' },
    ]);
    assert.deepEqual(await readFile(path.join(root, child.path)), sourceBefore);
    assert.deepEqual(await readFile(source), sourceBefore, 'admission does not alter host output');
    assert.equal(await hashFile(path.join(root, child.path)), child.sha256);
    const current = await loadProject(root);
    assert.equal(current.revision, 3);
    assert.deepEqual(current.assets, [parent, child]);
    assert.equal(inspectAssetInputs(current)[0].status, 'current');
    assert.deepEqual(
      await readdir(path.join(root, '.viscraft', 'builds')).catch(() => []),
      [],
      'admission does not fabricate a Build',
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('font and code admission copies bytes without pretending to validate or execute them', async () => {
  const { base, root } = await fixture();
  try {
    const source = path.join(base, 'host-output.js');
    const marker = path.join(base, 'executed');
    await writeFile(source, `throw new Error('must not execute'); // ${marker}\n`);
    const code = await importAsset(root, {
      assetId: 'code',
      sourcePath: source,
      type: 'code',
      rights: RIGHTS,
      expectedRevision: 1,
    });
    assert.deepEqual(await readFile(path.join(root, code.path)), await readFile(source));
    const fontSource = path.join(base, 'unvalidated-font.woff2');
    await writeFile(fontSource, 'not a real font; admission is copy-only');
    const font = await importAsset(root, {
      assetId: 'font',
      sourcePath: fontSource,
      type: 'font',
      rights: RIGHTS,
      expectedRevision: 2,
    });
    assert.deepEqual(await readFile(path.join(root, font.path)), await readFile(fontSource));
    await assert.rejects(readFile(marker), /ENOENT/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('invalid identity, revision, digest, media and production inputs reject without partial admission', async () => {
  const { base, root, source } = await fixture();
  try {
    const parent = await importAsset(root, {
      assetId: 'parent',
      sourcePath: source,
      type: 'image',
      rights: RIGHTS,
      expectedRevision: 1,
    });
    const options: ImportAssetOptions = {
      assetId: 'child',
      sourcePath: source,
      type: 'image',
      rights: RIGHTS,
      expectedRevision: 2,
    };
    await assertRejectedUnchanged(root, { ...options, assetId: parent.id }, /already exists/);
    await assertRejectedUnchanged(root, { ...options, expectedRevision: 1 }, /revision conflict/);
    await assertRejectedUnchanged(root, { ...options, expectedSha256: HEX }, /expectedSha256/);
    await assertRejectedUnchanged(root, { ...options, rights: { ...RIGHTS, origin: '' } }, /at least 1/);
    // Rights parse successfully, but whole-Project credential policy rejects
    // after staging/destination creation. A distinct out-of-root file (new
    // bytes, no registered twin) forces a freshly created destination so this
    // exercises actual rollback rather than only failures caught before one exists.
    const credentialSource = path.join(base, 'credential.png');
    await makePng(credentialSource, '0xaa3344');
    await assertRejectedUnchanged(
      root,
      {
        ...options,
        sourcePath: credentialSource,
        rights: { ...RIGHTS, origin: 'Bearer deliberately_fake_test_string_1234' },
      },
      /Credential-bearing/,
    );
    await assertRejectedUnchanged(
      root,
      { ...options, inputs: [{ asset: 'absent', role: 'identity' }] },
      /unique existing production inputs/,
    );
    await assertRejectedUnchanged(
      root,
      {
        ...options,
        inputs: [
          { asset: parent.id, role: 'identity' },
          { asset: parent.id, role: 'layout' },
        ],
      },
      /unique existing production inputs/,
    );
    const invalid = path.join(base, 'invalid.png');
    await writeFile(invalid, Buffer.from('89504e470d0a1a0a00000000', 'hex'));
    await assertRejectedUnchanged(root, { ...options, sourcePath: invalid }, /ffprobe|ffmpeg|usable/);
    await writeFile(path.join(root, parent.path), 'tampered approved parent');
    await assertRejectedUnchanged(
      root,
      { ...options, inputs: [{ asset: parent.id, role: 'identity' }] },
      /input hash mismatch/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('Project path symlinks and conflicting destinations are refused while matching preexisting bytes survive', async t => {
  const { base, root, source } = await fixture();
  try {
    const external = path.join(base, 'external');
    await mkdir(external);
    await createSymlinkFixture(t, external, path.join(root, 'assets'));
    const options: ImportAssetOptions = {
      assetId: 'new',
      sourcePath: source,
      type: 'image',
      rights: RIGHTS,
      expectedRevision: 1,
    };
    await assertRejectedUnchanged(root, options, /Symbolic links/);
    assert.deepEqual(await readdir(external), [], 'no write escapes through a Project symlink');
    await rm(path.join(root, 'assets'));
    await mkdir(path.join(root, 'assets'));
    const target = path.join(root, `assets/new-${(await hashFile(source)).slice(0, 16)}.png`);
    await writeFile(target, 'existing conflicting bytes');
    await assertRejectedUnchanged(root, options, /Refusing to overwrite/);
    assert.equal(await readFile(target, 'utf8'), 'existing conflicting bytes');
    await writeFile(target, await readFile(source));
    const admitted = await importAsset(root, options);
    assert.equal(await hashFile(target), admitted.sha256, 'matching existing media may be adopted without overwrite');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('simulated provenance propagates through a parent, identical bytes, and known Build artifact hashes', async () => {
  const { base, root } = await fixture();
  try {
    const parent = await plainAsset(root, 'simulated_parent', 'original mock parent', true);
    await atomicJson(path.join(root, 'project.json'), project([parent]));
    const source = path.join(base, 'new.js');
    await writeFile(source, 'new independently authored bytes');
    const throughParent = await importAsset(root, {
      assetId: 'child',
      sourcePath: source,
      type: 'code',
      rights: RIGHTS,
      expectedRevision: 1,
      inputs: [{ asset: parent.id, role: 'layout' }],
    });
    assert.equal(throughParent.simulated, true);
    const throughBytes = await importAsset(root, {
      assetId: 'same_bytes',
      sourcePath: path.join(root, parent.path),
      type: 'code',
      rights: RIGHTS,
      expectedRevision: 2,
      simulated: false,
    });
    assert.equal(throughBytes.simulated, true, 'caller cannot clear same-content simulation provenance');

    const known = await plainAsset(root, 'known_input', 'known simulated Build bytes');
    const current = await loadProject(root);
    await atomicJson(path.join(root, 'project.json'), { ...current, assets: [...current.assets, known] });
    await atomicJson(path.join(root, '.viscraft/builds/build-mock.json'), {
      schemaVersion: 1,
      id: 'build-mock',
      run: { id: 'run-mock', goal: 'provenance fixture only' },
      plan: { operations: [] },
      revision: 1,
      snapshotHash: HEX,
      status: 'succeeded',
      medium: 'picture',
      startedAt: '2026-10-09T00:00:00.000Z',
      operations: [],
      takes: [],
      artifacts: [
        {
          id: 'mock-artifact',
          path: 'artifacts/mock.mp4',
          sha256: known.sha256,
          kind: 'video',
          simulated: true,
          operation: 'test',
          inputs: [],
          backend: 'test-only',
        },
      ],
    });
    const viaHistory = await importAsset(root, {
      assetId: 'history_copy',
      sourcePath: path.join(root, known.path),
      type: 'code',
      rights: RIGHTS,
      expectedRevision: 3,
    });
    assert.equal(
      viaHistory.simulated,
      true,
      'known mock Artifact bytes retain their provenance even without a parent link',
    );
    const viaInputHistory = await importAsset(root, {
      assetId: 'history_child',
      sourcePath: source,
      type: 'code',
      rights: RIGHTS,
      expectedRevision: 4,
      inputs: [{ asset: known.id, role: 'performance plan' }],
    });
    assert.equal(viaInputHistory.simulated, true, 'a known simulated production input taints different output bytes');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('input inspection reports changed or missing provenance without modifying accepted children or Project state', async () => {
  const { base, root } = await fixture();
  try {
    const parent = await plainAsset(root, 'parent', 'approved original');
    const child = await plainAsset(root, 'child', 'approved child bytes');
    child.inputs = [{ asset: parent.id, revision: parent.revision, sha256: parent.sha256, role: 'identity' }];
    const value = project([parent, child]);
    await atomicJson(path.join(root, 'project.json'), value);
    const projectBefore = await readFile(path.join(root, 'project.json'));
    const childBefore = await readFile(path.join(root, child.path));
    assert.equal(inspectAssetInputs(value)[0].status, 'current');
    const revised = structuredClone(value);
    revised.assets[0].revision++;
    assert.equal(inspectAssetInputs(revised)[0].status, 'changed');
    revised.assets[0].revision = parent.revision;
    revised.assets[0].sha256 = HEX;
    const changed = inspectAssetInputs(revised)[0];
    assert.equal(changed.status, 'changed');
    assert.deepEqual(changed.expected, { revision: parent.revision, sha256: parent.sha256 });
    assert.deepEqual(changed.current, { revision: parent.revision, sha256: HEX });
    revised.assets.shift();
    assert.equal(inspectAssetInputs(revised)[0].status, 'missing');
    assert.deepEqual(value, project([parent, child]), 'query never mutates its input');
    assert.deepEqual(await readFile(path.join(root, 'project.json')), projectBefore);
    assert.deepEqual(await readFile(path.join(root, child.path)), childBefore);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('Project validation rejects missing, duplicate, cyclic or simulation-clearing lineage while accepting stale input versions', () => {
  const parent: Asset = {
    id: 'parent',
    revision: 2,
    path: 'assets/parent.js',
    sha256: HEX,
    type: 'code',
    rights: RIGHTS,
    simulated: false,
  };
  const child: Asset = {
    ...parent,
    id: 'child',
    path: 'assets/child.js',
    inputs: [{ asset: parent.id, revision: 1, sha256: 'b'.repeat(64), role: 'identity' }],
  };
  assert.doesNotThrow(
    () => validateProject(project([parent, child])),
    'stale provenance is reportable, not automatic invalidation of an accepted Asset',
  );
  assert.throws(() => validateProject(project([child])), /unique existing production inputs/);
  assert.throws(
    () => validateProject(project([parent, { ...child, inputs: [...child.inputs!, ...child.inputs!] }])),
    /unique existing production inputs/,
  );
  assert.throws(
    () =>
      validateProject(
        project([{ ...parent, inputs: [{ asset: child.id, revision: 1, sha256: HEX, role: 'cycle' }] }, child]),
      ),
    /Cyclic production references/,
  );
  assert.throws(
    () =>
      validateProject(project([{ ...parent, inputs: [{ asset: parent.id, revision: 1, sha256: HEX, role: 'self' }] }])),
    /Cyclic production references/,
  );
  assert.throws(
    () => validateProject(project([{ ...parent, simulated: true }, child])),
    /cannot clear simulated provenance/,
  );
});

test('large local media and its complete parent relations are admitted without re-encoding', async () => {
  const { base, root } = await fixture();
  try {
    const source = path.join(base, 'large-master.wav');
    const bytes = 513 * 1024 * 1024;
    const file = await open(source, 'w');
    try {
      const header = Buffer.alloc(44);
      header.write('RIFF');
      header.writeUInt32LE(bytes - 8, 4);
      header.write('WAVE', 8);
      header.write('fmt ', 12);
      header.writeUInt32LE(16, 16);
      header.writeUInt16LE(1, 20);
      header.writeUInt16LE(1, 22);
      header.writeUInt32LE(48000, 24);
      header.writeUInt32LE(96000, 28);
      header.writeUInt16LE(2, 32);
      header.writeUInt16LE(16, 34);
      header.write('data', 36);
      header.writeUInt32LE(bytes - 44, 40);
      await file.write(header);
      await file.truncate(bytes);
    } finally {
      await file.close();
    }
    const originalSha = await hashFile(source);
    const first = await importAsset(root, {
      assetId: 'master',
      sourcePath: source,
      type: 'audio',
      rights: RIGHTS,
      expectedRevision: 1,
    });
    assert.equal(first.sha256, originalSha);
    assert.equal((await stat(path.join(root, first.path))).size, bytes);
    const second = await importAsset(root, {
      assetId: 'alternate_role',
      sourcePath: source,
      type: 'audio',
      rights: RIGHTS,
      expectedRevision: 2,
    });
    assert.equal(second.path, first.path, 'identical approved bytes remain deduplicated');
    const childPath = path.join(base, 'derived.js');
    await writeFile(childPath, 'export const masterRoles = 2;');
    const child = await importAsset(root, {
      assetId: 'derived',
      sourcePath: childPath,
      type: 'code',
      rights: RIGHTS,
      expectedRevision: 3,
      inputs: [
        { asset: first.id, role: 'source' },
        { asset: second.id, role: 'reference' },
      ],
    });
    assert.deepEqual(child.inputs, [
      { asset: first.id, revision: first.revision, sha256: originalSha, role: 'source' },
      { asset: second.id, revision: second.revision, sha256: originalSha, role: 'reference' },
    ]);
    assert.equal(await hashFile(source), originalSha, 'the source master stays byte-identical');
    assert.equal(await hashFile(path.join(root, first.path)), originalSha);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
