import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

// The pinned three.js r186 (three@0.186.1) bytes that the code examples are
// allowed to vendor. These are the observable contract, not the implementation.
const THREE_MODULE_SHA256 = '9052042d676cb0fdc1ddfefe193053f34b7ac0513a616fdac4535d49987812ea';
const THREE_CORE_SHA256 = '9edde002b066a9a05676a6127f67735b62baf399bdea529f2f7e31657da769e6';
const THREE_LICENSE_SHA256 = '8b378ebe60e2fe500158cb0ac71cb5e8b7d92953c2abcc63a0eb90499653b5bc';

const CREATE_RACE = resolve('tests/fixtures/authoring/create-race.mjs');

interface CreateRaceRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCreateRace(args: string[]): CreateRaceRun {
  // utf8 encoding guarantees string stdout/stderr; normalize null away so the
  // assertions below stay strictly typed.
  const result = spawnSync(process.execPath, [CREATE_RACE, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

test('create-race vendors the installed three build with no external three directory', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-three-default-'));
  const root = join(parent, 'race-study');
  try {
    // Default resolution: the installed `three` dependency. Only the project
    // directory is passed — there is no external donor path.
    const run = runCreateRace([root]);
    assert.equal(run.status, 0, 'default (no-arg) resolution must succeed: ' + run.stderr + run.stdout);

    // The vendored bytes equal the pinned sha256 (observable contract).
    assert.equal(sha256(await readFile(join(root, 'vendor/three.module.js'))), THREE_MODULE_SHA256);
    assert.equal(sha256(await readFile(join(root, 'vendor/three.core.js'))), THREE_CORE_SHA256);
    assert.equal(sha256(await readFile(join(root, 'vendor/LICENSE'))), THREE_LICENSE_SHA256);

    // The registered Project Assets keep the same pinned hashes and MIT rights.
    const project = JSON.parse(await readFile(join(root, 'project.json'), 'utf8')) as {
      assets: Array<{ path: string; sha256: string; rights: { license: string } }>;
    };
    const byPath = new Map(project.assets.map(asset => [asset.path, asset]));
    assert.equal(byPath.get('vendor/three.module.js')?.sha256, THREE_MODULE_SHA256);
    assert.equal(byPath.get('vendor/three.core.js')?.sha256, THREE_CORE_SHA256);
    assert.equal(byPath.get('vendor/LICENSE')?.sha256, THREE_LICENSE_SHA256);
    assert.equal(byPath.get('vendor/three.module.js')?.rights.license, 'MIT');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('create-race refuses an unverified three build before writing anything', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-three-badhash-'));
  const root = join(parent, 'race-study');
  const fakeThree = join(parent, 'fake-three');
  try {
    // An explicit override directory whose module bytes do NOT match the pinned
    // hash must be refused; the correct core/license are irrelevant.
    await mkdir(join(fakeThree, 'build'), { recursive: true });
    await writeFile(join(fakeThree, 'build/three.module.js'), '// not the pinned three.js build\n');
    await writeFile(join(fakeThree, 'build/three.core.js'), '// not the pinned three.js core\n');
    await writeFile(join(fakeThree, 'LICENSE'), 'not the three.js license\n');

    const run = runCreateRace([root, fakeThree]);
    assert.notEqual(run.status, 0, 'a hash mismatch must fail loudly');
    assert.match(run.stderr, /sha256|unverified/i, 'the failure must name the hash check');

    // Nothing was written: the check runs before any project bytes are created.
    assert.equal(existsSync(join(root, 'project.json')), false, 'project.json must not be written');
    assert.equal(existsSync(join(root, 'vendor/three.module.js')), false, 'no vendor bytes must be written');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
