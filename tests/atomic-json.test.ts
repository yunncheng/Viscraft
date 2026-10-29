import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicJson } from '../src/shared/fs.js';

test('atomic JSON keeps the prior file complete through transient replacement failures', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'viscraft-atomic-json-'));
  const file = join(root, 'project.json');
  const previous = '{"revision":1}\n';
  await fs.writeFile(file, previous);
  const rename = fs.rename;
  let calls = 0;
  const mock = t.mock.method(fs, 'rename', async (from: string, to: string) => {
    const code = ['EPERM', 'EACCES', 'EBUSY'][calls++];
    if (code) {
      assert.equal(await fs.readFile(file, 'utf8'), previous);
      assert.deepEqual(JSON.parse(await fs.readFile(from, 'utf8')), { revision: 2 });
      throw Object.assign(new Error('temporary file lock'), { code });
    }
    await rename(from, to);
  });
  try {
    await atomicJson(file, { revision: 2 });
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { revision: 2 });
    assert.deepEqual(await fs.readdir(root), ['project.json']);
  } finally {
    mock.mock.restore();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a persistent replacement denial propagates and cleans its temporary JSON without losing the prior file', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'viscraft-atomic-json-'));
  const file = join(root, 'project.json');
  const previous = '{"revision":1}\n';
  await fs.writeFile(file, previous);
  const denied = Object.assign(new Error('replacement denied'), { code: 'EPERM' });
  let calls = 0;
  const mock = t.mock.method(fs, 'rename', async () => {
    calls++;
    throw denied;
  });
  try {
    await assert.rejects(atomicJson(file, { revision: 2 }), error => error === denied);
    assert.ok(calls > 1 && calls <= 6, 'retry must be bounded');
    assert.equal(await fs.readFile(file, 'utf8'), previous);
    assert.deepEqual(await fs.readdir(root), ['project.json']);
  } finally {
    mock.mock.restore();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a non-transient replacement failure propagates immediately without changing the prior JSON', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'viscraft-atomic-json-'));
  const file = join(root, 'project.json');
  await fs.writeFile(file, '{"revision":1}\n');
  const failure = Object.assign(new Error('different filesystem'), { code: 'EXDEV' });
  let calls = 0;
  const mock = t.mock.method(fs, 'rename', async () => {
    calls++;
    throw failure;
  });
  try {
    await assert.rejects(atomicJson(file, { revision: 2 }), error => error === failure);
    assert.equal(calls, 1);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { revision: 1 });
    assert.deepEqual(await fs.readdir(root), ['project.json']);
  } finally {
    mock.mock.restore();
    await fs.rm(root, { recursive: true, force: true });
  }
});
