import { stat, symlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { TestContext } from 'node:test';

/** Directory junctions exercise the same path rejection on Windows without
 * administrator privileges. File symlinks need Developer Mode or that privilege;
 * report a skip only when creating that specific fixture is denied. */
export async function createSymlinkFixture(
  context: Pick<TestContext, 'skip'>,
  target: string,
  link: string,
): Promise<boolean> {
  const absoluteTarget = resolve(dirname(link), target);
  const directory = (await stat(absoluteTarget)).isDirectory();
  const junction = process.platform === 'win32' && directory;
  try {
    await symlink(junction ? absoluteTarget : target, link, junction ? 'junction' : directory ? 'dir' : 'file');
    return true;
  } catch (error) {
    if (process.platform === 'win32' && !directory && (error as NodeJS.ErrnoException).code === 'EPERM') {
      context.skip('Windows file symlink creation requires Developer Mode or administrator privileges');
      return false;
    }
    throw error;
  }
}
