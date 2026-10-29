/**
 * Shared test helper for the ONE authoring boundary.
 *
 * Every current creator test drives the public CLI (`viscraft author <recipe>
 * <new-project-directory> [--options <json-file>]`) and then reads the Project /
 * runs the separate Build command. This helper keeps that wiring in one place so
 * the tests assert creative/verification facts instead of re-implementing the
 * Runtime's file writing.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

export function sha256(buffer: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export interface AuthorSummary {
  project: string;
  revision: number;
  path: string;
  title: string;
  files: number;
  assets: Array<{
    id: string;
    revision: number;
    path: string;
    type: string;
    sha256: string;
    license: string;
    redistributable: boolean;
  }>;
  sources: Array<{ id: string; kind: string }>;
}

export interface AuthorRun {
  status: number | null;
  stdout: string;
  stderr: string;
  summary: AuthorSummary;
}

/**
 * Run `viscraft author <recipe> <root> --options <file>`.
 *
 * `options` is serialized into a private file in `cwd`; path-valued options are
 * left as the caller wrote them so the documented cwd rule is exercised.
 */
export async function authorRecipe(args: {
  recipe: string;
  root: string;
  cwd: string;
  options?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
}): Promise<AuthorRun> {
  const argv = [CLI, 'author', args.recipe, args.root];
  if (args.options !== undefined) {
    const file = join(args.cwd, `author-options-${sha256(JSON.stringify(args.options)).slice(0, 12)}.json`);
    await writeFile(file, `${JSON.stringify(args.options, null, 2)}\n`);
    argv.push('--options', file);
  }
  const result = spawnSync(process.execPath, argv, {
    encoding: 'utf8',
    cwd: args.cwd,
    env: args.env ?? process.env,
    timeout: 300_000,
    maxBuffer: 1 << 24,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (result.status !== 0) {
    throw new Error(`viscraft author ${args.recipe} failed (status ${result.status}):\n${stderr}${stdout}`);
  }
  return { status: result.status, stdout, stderr, summary: JSON.parse(stdout) as AuthorSummary };
}
