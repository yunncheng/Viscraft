/**
 * The one thin authoring runner: `viscraft author <recipe> <new-project-dir>
 * [--options <json-file>]`.
 *
 * The Runtime parses/imports the explicitly selected local recipe ONCE, calls
 * `authorProject`, and prints one common factual summary. Recipe defaults and
 * creative validation stay in the recipe; `--build` is not part of authoring.
 * Recipe and options file paths resolve against the invocation cwd.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { validateProject } from '../src/project/project.js';
import { hashFile } from '../src/shared/hash.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const RECIPES = resolve('tests/fixtures/authoring/recipes');

interface Summary {
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

function runAuthor(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, 'author', ...args], { encoding: 'utf8', cwd, timeout: 120_000 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('viscraft author runs one recipe, publishes the Project and prints common facts (no Build)', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-author-cli-'));
  const source = join(parent, 'option-source.txt');
  await writeFile(source, 'option-valued input\n');
  const options = join(parent, 'options.json');
  await writeFile(options, JSON.stringify({ title: 'CLI authored', frames: 2, source: 'option-source.txt' }));
  const root = join(parent, 'project');
  try {
    const run = runAuthor([join(RECIPES, 'minimal.mjs'), root, '--options', options], parent);
    assert.equal(run.status, 0, `author must succeed:\n${run.stderr}${run.stdout}`);
    const summary = JSON.parse(run.stdout) as Summary;
    assert.equal(summary.path, root);
    assert.equal(summary.title, 'CLI authored');
    assert.equal(summary.revision, 1);
    assert.equal(typeof summary.project, 'string');
    assert.equal(summary.files, 3, 'scene + notes + the cwd-resolved option source');
    assert.deepEqual(summary.assets.map(asset => asset.path).sort(), ['assets/from-option.txt', 'scene.html']);
    for (const asset of summary.assets) {
      assert.equal(asset.revision, 1);
      assert.equal(asset.sha256, await hashFile(join(root, asset.path)), `${asset.path} carries its real hash`);
      assert.equal(asset.license, 'CC0-1.0');
      assert.equal(asset.redistributable, true);
    }
    assert.deepEqual(summary.sources, [{ id: 'detached_src', kind: 'browser' }]);

    // The Project is real, and the relative option path resolved against cwd.
    const project = validateProject(JSON.parse(await readFile(join(root, 'project.json'), 'utf8')));
    assert.equal(project.title, 'CLI authored');
    assert.equal(await readFile(join(root, 'assets/from-option.txt'), 'utf8'), 'option-valued input\n');
    assert.equal(existsSync(join(root, 'notes/README.md')), true, 'unregistered author files are still published');
    assert.ok(!project.assets.some(asset => asset.path === 'notes/README.md'), 'documents stay unregistered');

    // Authoring performs no Build, render or provider work.
    assert.equal(existsSync(join(root, '.viscraft', 'result.json')), false, 'authoring records no Build result');
    assert.equal(existsSync(join(root, '.viscraft', 'author.lock')), false, 'the author lock is released');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('viscraft author resolves the recipe path against cwd and accepts no --build', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-author-cli-paths-'));
  const root = join(parent, 'project');
  try {
    // Relative recipe + relative destination, with the invocation cwd as the base.
    const run = runAuthor(['recipes/minimal.mjs', 'project'], parent);
    // `recipes/minimal.mjs` is not under this temp cwd; the failure proves the
    // cwd rule (not a repo-relative fallback) and creates nothing.
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /Cannot find|ERR_MODULE_NOT_FOUND|fixture/i);
    assert.equal(existsSync(root), false);

    const built = runAuthor([join(RECIPES, 'minimal.mjs'), root, '--build'], parent);
    assert.notEqual(built.status, 0, '`--build` is not an authoring flag');
    assert.match(built.stderr, /Usage: viscraft author/);
    assert.equal(existsSync(root), false, 'a usage error publishes nothing');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('viscraft author refuses an existing destination and preserves its content', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-author-cli-existing-'));
  const root = join(parent, 'project');
  try {
    await writeFile(join(parent, 'keep'), 'not used');
    await mkdir(root);
    await writeFile(join(root, 'keep.txt'), 'keep me\n');
    const run = runAuthor([join(RECIPES, 'minimal.mjs'), root], parent);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /Refusing to author into existing/);
    assert.equal(await readFile(join(root, 'keep.txt'), 'utf8'), 'keep me\n');
    assert.equal(existsSync(join(root, 'project.json')), false);
    assert.equal(existsSync(join(root, 'scene.html')), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('viscraft author rejects malformed recipes without reporting a Project', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-author-cli-bad-'));
  try {
    const cases: Array<[string, RegExp]> = [
      ['no-default.mjs', /must default-export a function/],
      ['bad-shape.mjs', /must return \{ project, files \}/],
      ['throws.mjs', /fixture recipe failed deliberately/],
      ['project-json.mjs', /project\.json is written by the Runtime/],
    ];
    for (const [name, matcher] of cases) {
      const root = join(parent, name.replace('.mjs', ''));
      const run = runAuthor([join(RECIPES, name), root], parent);
      assert.notEqual(run.status, 0, `${name} must fail`);
      assert.match(run.stderr, matcher, `${name} failure must name its contract: ${run.stderr}`);
      assert.equal(existsSync(root), false, `${name} must publish nothing`);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
