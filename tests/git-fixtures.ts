import { dirname } from 'node:path';

/** Bound real Git discovery to this fixture, even when TMP is inside a checkout.
 * Other tests can still exercise enclosing repositories without this boundary. */
export async function withGitDiscoveryBoundary<T>(root: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = dirname(root);
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = previous;
  }
}
