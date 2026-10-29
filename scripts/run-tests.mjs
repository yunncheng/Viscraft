#!/usr/bin/env node
// Expand test files without shell globs and keep private provider configuration
// out of fixture runs. Tests that need configuration create their own fixtures.
import { readdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const suite = process.argv[2];
if (!['unit', 'e2e'].includes(suite)) throw new Error('Usage: node scripts/run-tests.mjs unit|e2e');
const suffix = suite === 'unit' ? '.test.js' : '.e2e.js';
const files = (await readdir(path.join(root, 'dist/tests')))
  .filter(file => file.endsWith(suffix))
  .sort()
  .map(file => path.join(root, 'dist/tests', file));
if (!files.length) throw new Error('No compiled tests found; run npm run build first');
// System temp paths may be aliases (/var on macOS, 8.3 paths on Windows).
// Use one physical path for fixtures and the Runtime's returned paths.
const temporaryRoot = await realpath(os.tmpdir());
const home = await mkdtemp(path.join(temporaryRoot, 'viscraft-test-config-'));
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT' && !/^VISCRAFT_(?:VIDEO|IMAGE)_/i.test(key)),
);
try {
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', '--test-concurrency=2', ...files], {
      cwd: root,
      env: { ...environment, TMPDIR: temporaryRoot, TMP: temporaryRoot, TEMP: temporaryRoot, VISCRAFT_CONFIG_HOME: home },
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
} finally {
  await rm(home, { recursive: true, force: true });
}
