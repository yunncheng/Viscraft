import { createSymlinkFixture } from './fs-fixtures.js';
import { withGitDiscoveryBoundary } from './git-fixtures.js';
// `createProject`: the standard, non-interactive Project entry point.
//
// It must write ONE valid current-format Project into (a possibly empty)
// directory — a stable id, the title and a single named Look — a legal EMPTY
// DRAFT that Inspect can read and Build refuses until it has a target. A
// composition is created only when the caller asks for a film output; an image
// or sound target is never fabricated. It must also refuse to overwrite an
// existing `project.json`, so it can never clobber authoring state.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  createProject,
  inspectProject,
  loadProject,
  validateProject,
  compositionFrames,
  type CreateProjectOptions,
} from '../src/index.js';
import { runtimeLocation, scaffoldProject } from '../src/project/create.js';
import { runCommand } from '../src/shared/process.js';

async function gitAvailable(): Promise<boolean> {
  try {
    await runCommand('git', ['--version']);
    return true;
  } catch {
    return false;
  }
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'viscraft-create-'));
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await tempDir();
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('createProject with only a title produces a legal empty draft (no fabricated composition)', async () => {
  await withRoot(async root => {
    const project = await createProject(root, { title: 'Only a Title' });

    assert.match(project.id, /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/, 'the derived id must satisfy the Id contract');
    assert.equal(project.revision, 1);
    assert.equal(project.title, 'Only a Title');
    assert.ok(project.direction.looks.length >= 1, 'Direction always carries at least one named Look');
    assert.equal(project.composition, undefined, 'a draft must not invent a timeline');
    assert.deepEqual(project.imageTargets, []);
    assert.deepEqual(project.soundTargets, []);
    assert.deepEqual(project.sources, []);
    assert.deepEqual(project.assets, []);

    // Round-trip: the file Inspect/Save read is the same project, with no builds.
    const reloaded = await loadProject(root);
    assert.deepEqual(reloaded, project);
    const inspected = await inspectProject(root);
    assert.deepEqual(inspected.project, project);
    assert.equal(inspected.builds.length, 0);
  });
});

test('createProject creates an empty FILM composition only when an output is asked for', async () => {
  await withRoot(async root => {
    const project = await createProject(root, { title: 'Film', output: {} });
    assert.ok(project.composition, 'an explicit output asks for a film draft');
    assert.deepEqual(project.composition.placements, [], 'a fresh film draft has no placements');
    assert.equal(project.composition.output.width, 1920);
    assert.equal(project.composition.output.height, 1080);
    assert.deepEqual(project.composition.output.fps, { numerator: 30, denominator: 1 });
    assert.equal(project.composition.output.sampleRate, 48000);
    assert.equal(project.composition.output.channels, 2);
  });
});

test('createProject honors custom output, id, intent and looks', async () => {
  await withRoot(async root => {
    const project = await createProject(root, {
      title: 'Custom',
      id: 'custom_project',
      intent: 'a precise custom brief',
      looks: [
        { id: 'noir', description: 'high-contrast noir' },
        { id: 'warm', description: 'warm film' },
      ],
      output: {
        width: 1280,
        height: 720,
        fps: { numerator: 30000, denominator: 1001 },
        sampleRate: 44100,
        channels: 1,
      },
    });

    assert.equal(project.id, 'custom_project');
    assert.equal(project.direction.intent, 'a precise custom brief');
    assert.deepEqual(
      project.direction.looks.map(look => look.id),
      ['noir', 'warm'],
    );
    assert.equal(project.composition!.output.width, 1280);
    assert.equal(project.composition!.output.height, 720);
    assert.deepEqual(project.composition!.output.fps, { numerator: 30000, denominator: 1001 });
    assert.equal(project.composition!.output.sampleRate, 44100);
    assert.equal(project.composition!.output.channels, 1);

    const reloaded = await loadProject(root);
    assert.deepEqual(reloaded, project, 'custom settings survive a reload');
  });
});

test('a second createProject refuses to overwrite and leaves project.json byte-identical', async () => {
  await withRoot(async root => {
    await createProject(root, { title: 'Original' });
    const before = await readFile(join(root, 'project.json'));

    await assert.rejects(
      createProject(root, { title: 'Replacement' }),
      /Refusing to overwrite/,
      'creating over an existing project must be refused',
    );

    const after = await readFile(join(root, 'project.json'));
    assert.deepEqual(after, before, 'the original bytes must be untouched');
  });
});

test('createProject rejects a missing or empty title', async () => {
  await withRoot(async root => {
    await assert.rejects(createProject(root, {} as CreateProjectOptions), /non-empty title/);
    await assert.rejects(createProject(root, { title: '' }), /non-empty title/);
    await assert.rejects(createProject(root, { title: '   ' }), /non-empty title/);
  });
});

test('a created project validates; a draft has no composition and a film draft is a finite zero', async () => {
  await withRoot(async root => {
    const draft = await createProject(root, { title: 'Draft' });
    assert.doesNotThrow(() => validateProject(draft));
    assert.throws(() => compositionFrames(draft), /composition/i, 'a draft has no timeline to measure');

    const film = await createProject(join(root, 'film'), { title: 'Finite', output: {} });
    assert.doesNotThrow(() => validateProject(film));
    assert.equal(compositionFrames(film), 0, 'an unedited film draft is a finite 0, never -Infinity');
  });
});

test('scaffoldProject initializes Git, writes workspace files and ignores generated state', async t => {
  if (!(await gitAvailable())) return t.skip('git is not available');
  await withRoot(root =>
    withGitDiscoveryBoundary(root, async () => {
      const result = await scaffoldProject(root);
      assert.equal(result.agentsMd, 'written');
      assert.equal(result.gitignore, 'written');
      assert.equal(result.git, 'initialized', 'an empty directory outside any repo is initialised');
      assert.ok((await stat(join(root, 'AGENTS.md'))).size > 0, 'workspace notes are created');
      assert.ok((await stat(join(root, '.git'))).isDirectory(), 'git init created a repository');
      await createProject(root, { title: 'Workspace ignore fixture' });
      await mkdir(join(root, 'node_modules'));
      await writeFile(join(root, 'node_modules', 'dependency.js'), 'export {};');
      await writeFile(join(root, '.viscraft', 'private.json'), '{}');
      const ignored = await runCommand('git', [
        '-C',
        root,
        'check-ignore',
        'node_modules/dependency.js',
        '.viscraft/private.json',
      ]);
      assert.deepEqual(ignored.trim().split(/\r?\n/).sort(), ['.viscraft/private.json', 'node_modules/dependency.js']);
      const visible = await runCommand('git', ['-C', root, 'ls-files', '--others', '--exclude-standard']);
      assert.ok(visible.split(/\r?\n/).includes('project.json'), 'author state remains visible to Git');
    }),
  );
});

test('scaffoldProject does not git init inside an existing work tree', async t => {
  if (!(await gitAvailable())) return t.skip('git is not available');
  await withRoot(async root => {
    await runCommand('git', ['-C', root, 'init', '--quiet']);
    const nested = join(root, 'inner', 'project');
    const result = await scaffoldProject(nested);
    assert.equal(result.git, 'already-in-repo');
    await assert.rejects(stat(join(nested, '.git')), 'it must not nest a second repository inside the enclosing one');
  });
});

test('scaffoldProject never overwrites an existing AGENTS.md or .gitignore', async () => {
  await withRoot(async root => {
    await writeFile(join(root, 'AGENTS.md'), '# my own notes\n');
    await writeFile(join(root, '.gitignore'), 'build/\n');
    const result = await scaffoldProject(root);
    assert.equal(result.agentsMd, 'existing');
    assert.equal(result.gitignore, 'existing');
    assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), '# my own notes\n');
    assert.equal(await readFile(join(root, '.gitignore'), 'utf8'), 'build/\n');
  });
});

test('runtimeLocation reports real CLI and SDK entries without requiring a project install', async () => {
  await withRoot(async root => {
    const location = await runtimeLocation(root);
    assert.equal(location.name, 'viscraft-runtime');
    assert.match(location.version, /^\d+\.\d+\.\d+/, 'the package version is reported');
    assert.equal(location.inProject, false, 'a fresh temp directory has no node_modules/ install');
    assert.ok((await stat(location.entry)).isFile(), 'the CLI entry exists outside the work');
    assert.ok((await stat(location.sdkEntry)).isFile(), 'the exported SDK entry exists');
    assert.ok((await stat(location.path)).isDirectory(), 'the reported package path is real');
  });
});

test('runtimeLocation reports inProject when the Runtime is installed in the project', async t => {
  await withRoot(async root => {
    const location = await runtimeLocation(root);
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await createSymlinkFixture(t, location.path, join(root, 'node_modules', 'viscraft-runtime'));
    const installed = await runtimeLocation(root);
    assert.equal(installed.inProject, true, 'a project-local node_modules install is detected');
  });
});

test('the same Runtime identifies itself from two independent works without creating dependencies', async () => {
  await withRoot(async root => {
    const location = await runtimeLocation(root);
    const seen: string[] = [];
    for (const name of ['first-work', 'second-work']) {
      const work = join(root, name);
      await createProject(work, { title: name });
      const { stdout } = await promisify(execFile)(process.execPath, [location.entry, '--version'], { cwd: work });
      const reported = JSON.parse(stdout);
      assert.equal(reported.inProject, false);
      assert.match(reported.contentSha256, /^[a-f0-9]{64}$/);
      assert.equal(reported.sdkEntry, location.sdkEntry);
      seen.push(reported.path);
      await assert.rejects(stat(join(work, 'node_modules')), { code: 'ENOENT' });
      await assert.rejects(stat(join(work, 'package.json')), { code: 'ENOENT' });
    }
    assert.deepEqual(seen, [location.path, location.path]);
  });
});
