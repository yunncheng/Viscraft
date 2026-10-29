/**
 * Runtime-owned directories ignore themselves in git.
 *
 * `.viscraft/` (execution records, snapshots, content store, provider media) and
 * `output/` (deliveries) are Runtime-owned: nothing under them is authored
 * content, so they must never be tracked by the author's git repository. Writing
 * a `*`-only `.gitignore` into each directory the first time the Runtime creates
 * it keeps `git status` limited to the author's own files without the author
 * configuring anything — and without the Runtime ever touching authored files.
 *
 * These ignore files are NOT delivered: Portable/Archive exports exclude them
 * (an exported Project re-creates its own on first Runtime write).
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Idempotently write a `*`-only `.gitignore` into an existing Runtime directory.
 * Never overwrites an existing file (including an author's own), so a Project
 * that already configured its ignore rules is left untouched.
 */
export async function ensureSelfIgnore(dir: string): Promise<void> {
  try {
    await writeFile(path.join(dir, '.gitignore'), '*\n', { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}
