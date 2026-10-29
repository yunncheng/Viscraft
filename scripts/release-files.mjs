// Maintainer-side file hashing, source inventory and npm invocation.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Find Python 3 without invoking a shell or relying on a platform-specific name. */
export async function pythonCommand() {
  const candidates = [
    { program: 'python3', args: [] },
    { program: 'python', args: [] },
    ...(process.platform === 'win32' ? [{ program: 'py', args: ['-3'] }] : []),
  ];
  for (const candidate of candidates) {
    try {
      await exec(candidate.program, [...candidate.args, '-c', 'import sys; assert sys.version_info.major == 3'], {
        windowsHide: true,
      });
      return candidate;
    } catch {
      // Try the next conventional Python 3 entry point.
    }
  }
  throw new Error('Python 3 is required to create and verify the source ZIP; install it and reopen your terminal.');
}

export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function listFiles(root, prefix = '') {
  const result = [];
  for (const item of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isSymbolicLink()) throw new Error(`Symlinks are not release files: ${relative}`);
    if (item.isDirectory()) result.push(...(await listFiles(root, relative)));
    else if (item.isFile()) result.push(relative);
    else throw new Error(`Not a regular release file: ${relative}`);
  }
  return result.sort();
}

/** Run npm's JS entry on Windows: .cmd files require a shell, which would also
 * interpret user-chosen folder names. Keep paths as literal process arguments. */
export async function npmCommand(
  args,
  { platform = process.platform, environment = process.env, nodeExecutable = process.execPath } = {},
) {
  if (platform !== 'win32') return { program: 'npm', args };
  const pathValue = Object.entries(environment).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const directories = [
    ...pathValue
      .split(';')
      .filter(Boolean)
      .map(value => value.replace(/^"(.*)"$/, '$1')),
    path.dirname(nodeExecutable),
  ];
  const candidates = [
    ...(environment.npm_execpath && /npm-cli\.js$/i.test(environment.npm_execpath) ? [environment.npm_execpath] : []),
    ...directories.map(directory => path.join(directory, 'node_modules/npm/bin/npm-cli.js')),
  ];
  for (const candidate of candidates) {
    try {
      if ((await fs.stat(candidate)).isFile()) return { program: nodeExecutable, args: [candidate, ...args] };
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
  }
  throw new Error('Cannot locate npm. Install Node.js 22+ with npm, reopen your terminal, and try again.');
}
