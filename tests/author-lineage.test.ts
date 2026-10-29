/**
 * Asset lineage survives authoring and Portable export.
 *
 * A Project authored through `authorProject` carries a frozen parent identity
 * in `inputs`, exports/reopens unchanged, and preserves both the parent bytes
 * and the derivative's relation to that version.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { exportProject } from '../src/operations/delivery/portable.js';
import { loadProject } from '../src/project/project.js';
import { authorRecipe } from './authoring-helpers.js';

const RECIPE = resolve('tests/fixtures/authoring/recipes/lineage.mjs');

test('an authored frozen parent relation survives export and reopen', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-lineage-'));
  const root = join(parent, 'project');
  const exportedPath = join(parent, 'exported');
  try {
    await authorRecipe({ recipe: RECIPE, root, cwd: parent });
    const authored = await loadProject(root);
    const child = authored.assets.find(asset => asset.id === 'lineage_child')!;
    const parentAsset = authored.assets.find(asset => asset.id === 'lineage_parent')!;
    assert.equal(child.inputs?.length, 1);
    assert.deepEqual(child.inputs![0], {
      asset: 'lineage_parent',
      revision: parentAsset.revision,
      sha256: parentAsset.sha256,
      role: 'source',
    });

    await exportProject(root, exportedPath);
    const reopened = await loadProject(exportedPath);
    assert.deepEqual(reopened.assets, authored.assets, 'lineage identities and frozen parents are unchanged');
    const reopenedChild = reopened.assets.find(asset => asset.id === 'lineage_child')!;
    assert.deepEqual(reopenedChild.inputs, child.inputs, 'the derivative still freezes the same parent identity');

    // Check the exported originals as well as their metadata.
    assert.equal(await readFile(join(exportedPath, 'src/parent.txt'), 'utf8'), 'lineage parent v1\n');
    assert.equal(
      await readFile(join(exportedPath, 'src/child.txt'), 'utf8'),
      'lineage child derived from the parent\n',
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
