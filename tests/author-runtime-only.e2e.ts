/**
 * Runtime-only authoring and portable resource closure.
 *
 * 1. A detached recipe (a copy outside the repository, no Skill beside it) uses
 *    only the running Runtime SDK and generates its OWN adopted module/scene —
 *    no Skill template and no Runtime creative resource catalogue. The Project
 *    still builds, exports, reopens and serves the fixed Runtime workbench from
 *    its own bytes after the recipe disappears.
 * 2. The Project exports/reopens into an independent workspace; the authoring
 *    recipe and original workspace are removed, the exported Project adopts a
 *    real code-module edit through `refreshCodeAsset`, and the rebuilt pixels
 *    change while the original Project and its artifact stay byte-identical.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { buildProject } from '../src/build/build.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { refreshCodeAsset } from '../src/project/code-assets.js';
import { loadProject } from '../src/project/project.js';
import { serveWorkbench } from '../src/workbench/server.js';
import { authorRecipe } from './authoring-helpers.js';

const RECIPE_FIXTURES = resolve('tests/fixtures/authoring/recipes');

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Decode the first frame of a video to raw RGB. */
function firstFrame(file: string): Buffer {
  const result = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostdin', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 1 << 26 },
  );
  assert.equal(result.status, 0, `ffmpeg decode failed: ${result.stderr?.toString() ?? ''}`);
  return result.stdout;
}

/** Fraction of pixels that differ by a loud margin (a real picture change). */
function changedFraction(a: Buffer, b: Buffer): number {
  assert.equal(a.length, b.length, 'compared frames must have the same size');
  let changed = 0;
  for (let i = 0; i < a.length; i += 3) {
    const distance = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (distance > 60) changed++;
  }
  return changed / (a.length / 3);
}

test('a detached self-contained recipe needs no Skill or Runtime creative library and stays portable', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-runtime-only-'));
  const recipeDir = join(parent, 'detached-recipes');
  const root = join(parent, 'project');
  try {
    // Copy ONLY the recipe, outside the repository and away from the Skill.
    await cp(RECIPE_FIXTURES, recipeDir, { recursive: true });
    assert.equal(existsSync(join(recipeDir, 'minimal.mjs')), true);
    assert.equal(existsSync(join(recipeDir, 'node_modules')), false, 'no dependency tree beside the recipe');
    const recipe = join(recipeDir, 'runtime-only.mjs');

    const { summary } = await authorRecipe({
      recipe,
      root,
      cwd: parent,
      options: { width: 160, height: 90, frames: 2 },
    });
    assert.deepEqual(
      summary.assets.map(asset => asset.path).sort(),
      ['adopted.mjs', 'scene.html'],
      'the recipe generated both the scene and the adopted module itself',
    );
    assert.deepEqual(summary.sources, [{ id: 'ro_src', kind: 'browser' }]);

    // The Project owns a real executable closure: a generated module imported by
    // a generated scene, with no Runtime creative selection involved.
    assert.match(await readFile(join(root, 'scene.html'), 'utf8'), /from '\.\/adopted\.mjs'/);
    assert.match(await readFile(join(root, 'adopted.mjs'), 'utf8'), /export const COLOR = '#e8b04b'/);
    const project = await loadProject(root);
    assert.deepEqual((project.handoff ?? []).map(file => [file.path, file.role]).sort(), [
      ['LICENSES.md', 'license'],
      ['README.md', 'readme'],
    ]);
    assert.match(await readFile(join(root, 'LICENSES.md'), 'utf8'), /CC0-1\.0/);
    assert.doesNotMatch(JSON.stringify(project), /\/lustre-data\/|\/root\/|\/tmp\//);

    // The fixed workbench is Runtime UI: it serves without any Skill present.
    const live = await serveWorkbench(root, { document: 'still', target: 'still' });
    try {
      const page = await fetch(`${live.url}/workbench?document=still&target=still&token=${live.token}`);
      assert.equal(page.status, 200, 'the fixed Runtime workbench page is served');
      const script = await fetch(`${live.url}/workbench/workbench.js`);
      assert.equal(script.status, 200, 'the UI script comes from the Runtime, not the Skill');
      assert.ok((await script.text()).length > 100, 'the served UI script is real');
    } finally {
      await live.close();
    }

    // The recipe directory is no longer available: the Project owns its closure.
    await rm(recipeDir, { recursive: true, force: true });
    const built = await buildProject(root);
    assert.equal(built.status, 'succeeded', `the Runtime-only Project must build: ${built.error ?? ''}`);
    assert.ok(built.result, 'a succeeded build records a result');

    // Export to an independent workspace and reopen it.
    const exportedPath = join(parent, 'exported');
    const exported = await exportProject(root, exportedPath);
    assert.equal(exported.path, exportedPath);
    const reopened = await loadProject(exportedPath);
    assert.deepEqual(reopened.assets, project.assets, 'the exported Project keeps the adopted Asset identities');
    for (const asset of reopened.assets) {
      assert.equal(sha256(await readFile(join(exportedPath, asset.path))), asset.sha256, `${asset.path} closure`);
    }
    assert.equal(existsSync(join(exportedPath, 'LICENSES.md')), true, 'the licence text travels');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('an exported Project rebuilds from a modified adopted author file with the original workspace gone', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-portable-author-'));
  const recipeDir = join(parent, 'recipes');
  const root = join(parent, 'project');
  try {
    await cp(RECIPE_FIXTURES, recipeDir, { recursive: true });
    await authorRecipe({
      recipe: join(recipeDir, 'portable.mjs'),
      root,
      cwd: parent,
      options: { width: 64, height: 36, frames: 2 },
    });
    const originalProject = await readFile(join(root, 'project.json'), 'utf8');
    const originalModule = await readFile(join(root, 'adopted.mjs'));
    const before = await buildProject(root);
    assert.equal(before.status, 'succeeded', `the authored Project must build: ${before.error ?? ''}`);
    const beforeArtifact = before.artifacts.find(artifact => artifact.id === before.result!.artifact)!;
    const beforePath = join(root, beforeArtifact.path);
    const beforeHash = sha256(await readFile(beforePath));
    const beforePixels = firstFrame(beforePath);

    // Export while the original workspace is still available.
    const exportedPath = join(parent, 'exported');
    await exportProject(root, exportedPath);
    assert.equal(
      await readFile(join(root, 'project.json'), 'utf8'),
      originalProject,
      'export does not edit the original',
    );
    assert.equal(
      sha256(await readFile(join(root, 'adopted.mjs'))),
      sha256(originalModule),
      'export does not edit the original bytes',
    );

    // The export is a complete closure: every referenced authored file exists.
    const exportedProject = await loadProject(exportedPath);
    for (const asset of exportedProject.assets) {
      assert.equal(existsSync(join(exportedPath, asset.path)), true, `${asset.path} is carried`);
      assert.equal(sha256(await readFile(join(exportedPath, asset.path))), asset.sha256);
    }
    for (const file of exportedProject.handoff ?? []) {
      assert.equal(existsSync(join(exportedPath, file.path)), true, `${file.path} is carried`);
    }
    assert.doesNotMatch(JSON.stringify(exportedProject), new RegExp(parent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    // Move the source recipe AND the original workspace aside rather than
    // deleting them: the exported copy must work without them, and the original
    // evidence must survive the exported edit untouched.
    const asideRoot = join(parent, 'project-aside');
    const asideRecipes = join(parent, 'recipes-aside');
    await rename(recipeDir, asideRecipes);
    await rename(root, asideRoot);
    assert.equal(existsSync(recipeDir), false, 'the source recipe is unavailable');
    assert.equal(existsSync(root), false, 'the original workspace is unavailable');

    const modified = `// Adopted author module. The exported Project owns these bytes.\nexport const COLOR = '#d54a2f';\nexport const LABEL = 'adopted v2';\n`;
    await writeFile(join(exportedPath, 'adopted.mjs'), modified);
    // Editing a registered `code` Asset is a real edit; the Project must record
    // the current bytes explicitly rather than silently ignoring the change.
    const refreshed = await refreshCodeAsset(exportedPath, {
      assetId: 'portable_module',
      expectedRevision: exportedProject.revision,
    });
    assert.equal(refreshed.revision, 2, 'the refreshed code Asset advances its revision');
    assert.equal(refreshed.sha256, sha256(Buffer.from(modified)));
    const rebuilt = await buildProject(exportedPath);
    assert.equal(
      rebuilt.status,
      'succeeded',
      `the exported Project must rebuild from its own bytes: ${rebuilt.error ?? ''}`,
    );
    const afterPath = join(
      exportedPath,
      rebuilt.artifacts.find(artifact => artifact.id === rebuilt.result!.artifact)!.path,
    );
    assert.notEqual(sha256(await readFile(afterPath)), beforeHash, 'the modified adopted source changed the output');
    // Decode the actual pixels: a different container hash alone would not prove
    // the adopted module's bytes reached the picture.
    const afterPixels = firstFrame(afterPath);
    assert.ok(
      changedFraction(beforePixels, afterPixels) > 0.2,
      'the adopted module edit changed the decoded picture, not only the container bytes',
    );
    assert.notEqual(
      sha256(originalModule),
      sha256(Buffer.from(modified)),
      'the exported edit is a real new adopted byte',
    );

    // The original workspace was only moved aside: the exported edit, refresh
    // and rebuild must not have touched the original Project, module or the
    // Artifact produced before the move.
    assert.equal(
      await readFile(join(asideRoot, 'project.json'), 'utf8'),
      originalProject,
      'the original Project is untouched',
    );
    assert.equal(
      sha256(await readFile(join(asideRoot, 'adopted.mjs'))),
      sha256(originalModule),
      'the original adopted module bytes are untouched',
    );
    assert.equal(
      sha256(await readFile(join(asideRoot, beforeArtifact.path))),
      beforeHash,
      'the Artifact produced before the move is untouched',
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
