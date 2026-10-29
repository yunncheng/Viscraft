import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { hashFile } from './hash.js';

/** Identity of distributed Runtime files, independent of installation location
 * and npm's dependency/cache files. The release receipt carries this same hash. */
export async function runtimeContentSha256(packageRoot: string): Promise<string> {
  const files = ['LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md', 'package.json'];
  async function walk(relative: string): Promise<void> {
    for (const entry of await readdir(path.join(packageRoot, relative), { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) files.push(name);
      else throw new Error(`Runtime package member is not a regular file: ${name}`);
    }
  }
  await walk('dist/src');
  const identity = createHash('sha256');
  for (const name of files.sort()) {
    if (!(await lstat(path.join(packageRoot, name))).isFile())
      throw new Error(`Runtime package member is not a regular file: ${name}`);
    identity.update(`${await hashFile(path.join(packageRoot, name))}  ${name}\n`);
  }
  return identity.digest('hex');
}
