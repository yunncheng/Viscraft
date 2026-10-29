import { createSymlinkFixture } from './fs-fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeContentSha256 } from '../src/shared/runtime-identity.js';

async function fixture(root: string): Promise<void> {
  await mkdir(join(root, 'dist/src'), { recursive: true });
  for (const file of ['LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md', 'package.json'])
    await writeFile(join(root, file), file);
  await writeFile(join(root, 'dist/src/engine.js'), 'export const value = 1;');
}

test('Runtime identity survives relocation and npm state, but detects changed shipped bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-runtime-identity-'));
  try {
    const first = join(root, 'first');
    const second = join(root, 'second');
    await fixture(first);
    const identity = await runtimeContentSha256(first);
    await cp(first, second, { recursive: true });
    await mkdir(join(second, 'node_modules'), { recursive: true });
    await writeFile(join(second, 'node_modules/.package-lock.json'), 'npm-managed state');
    assert.equal(await runtimeContentSha256(second), identity);
    await writeFile(join(second, 'dist/src/engine.js'), 'export const value = 2;');
    assert.notEqual(await runtimeContentSha256(second), identity);
    await writeFile(join(second, 'dist/src/engine.js'), 'export const value = 1;');
    await writeFile(join(second, 'README.md'), 'changed distribution documentation');
    assert.notEqual(await runtimeContentSha256(second), identity);
    await rm(join(second, 'README.md'));
    await assert.rejects(runtimeContentSha256(second), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Runtime identity refuses a symlink added to the distributed file tree', async t => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-runtime-identity-link-'));
  try {
    await fixture(root);
    if (!(await createSymlinkFixture(t, join(root, 'README.md'), join(root, 'dist/src/injected.js')))) return;
    await assert.rejects(runtimeContentSha256(root), /not a regular file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
