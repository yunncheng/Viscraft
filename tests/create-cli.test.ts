/**
 * The non-interactive entry points an agent actually calls: `create` and the
 * `--target` selector shared by `plan`/`build`.
 *
 * These assertions are about REAL stdout/exit behaviour, not the help text:
 *  - `create` defaults to a legal EMPTY DRAFT (no composition, no fabricated
 *    image/sound target) and only an explicit film/output request creates one;
 *  - `--medium image|sound` refuses film output settings instead of silently
 *    creating a timeline;
 *  - `plan`/`build` accept `--target` and pass it to the SDK (an unknown id is
 *    refused by the target resolver, not ignored).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function run(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd, timeout: 120_000 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('create defaults to a legal empty draft and only an explicit film request adds a composition', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-create-cli-'));
  try {
    const draftDir = join(parent, 'draft');
    const draft = run(['create', draftDir, 'A draft'], parent);
    assert.equal(draft.status, 0, draft.stderr);
    const draftSummary = JSON.parse(draft.stdout) as { medium: string; composition: boolean; output: unknown };
    assert.equal(draftSummary.medium, 'draft');
    assert.equal(draftSummary.composition, false);
    assert.equal(draftSummary.output, null);
    const draftProject = JSON.parse(await readFile(join(draftDir, 'project.json'), 'utf8'));
    assert.equal(draftProject.composition, undefined, 'the file itself declares no timeline');
    assert.deepEqual(draftProject.soundTargets, []);

    const filmDir = join(parent, 'film');
    const film = run(['create', filmDir, 'A film', '--medium', 'film'], parent);
    assert.equal(film.status, 0, film.stderr);
    const filmSummary = JSON.parse(film.stdout) as { medium: string; composition: boolean };
    assert.equal(filmSummary.medium, 'film');
    assert.equal(filmSummary.composition, true);
    const filmProject = JSON.parse(await readFile(join(filmDir, 'project.json'), 'utf8'));
    assert.deepEqual(filmProject.composition.placements, []);
    assert.equal(filmProject.composition.output.width, 1920);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('create refuses film output settings on an image/sound draft and an unknown medium', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-create-cli-'));
  try {
    const image = run(['create', join(parent, 'img'), 'Image', '--medium', 'image', '--size', '512x512'], parent);
    assert.notEqual(image.status, 0);
    assert.match(image.stderr, /describe a film output/);

    const bogus = run(['create', join(parent, 'bad'), 'Bad', '--medium', 'video'], parent);
    assert.notEqual(bogus.status, 0);
    assert.match(bogus.stderr, /--medium must be draft, film, image or sound/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('plan and build pass --target to the target resolver instead of ignoring it', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-create-cli-'));
  try {
    const root = join(parent, 'draft');
    assert.equal(run(['create', root, 'Targets'], parent).status, 0);

    const plan = run(['plan', root, '--target', 'nope'], parent);
    assert.notEqual(plan.status, 0);
    assert.match(plan.stderr, /unknown target "nope"/);

    const build = run(['build', root, '--target', 'nope'], parent);
    assert.notEqual(build.status, 0);
    assert.match(build.stderr, /unknown target "nope"/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
