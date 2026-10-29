import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { lstat, mkdir, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RelativePath } from '../core/schema.js';

export async function resolveProjectPath(root: string, relative: string): Promise<string> {
  RelativePath.parse(relative);
  const base = await realpath(root);
  const target = path.join(base, relative);
  let current = base;
  for (const component of relative.split('/')) {
    current = path.join(current, component);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in project paths: ${relative}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return target;
}
/** Atomically replace a staged file, tolerating brief reader or scanner locks. */
export async function replaceFile(staged: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(staged, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt === 5 || !['EACCES', 'EPERM', 'EBUSY'].includes(code ?? '')) throw error;
      await delay(10 * 2 ** attempt);
    }
  }
}

export async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await replaceFile(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
