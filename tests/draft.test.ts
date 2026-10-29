// The unedited-draft contract around a ZERO-placement composition.
//
// A freshly created Project legitimately has no picture yet. Its composition
// length is a finite 0 (never `Math.max()` over an empty list), Save/Inspect
// read it, Validate accepts it, and a declared `outputFrames` gives it an
// explicit padded programme length. Build, however, must refuse LOUDLY before
// any media work — it must NOT silently pad a missing picture into a
// placeholder video — and `planBuild` must report the same gap as a blocker.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildProject,
  compositionFrames,
  createProject,
  loadProject,
  planBuild,
  saveProject,
  validateProject,
} from '../src/index.js';
import type { Project } from '../src/index.js';

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-draft-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A valid draft with a scene + shot but still ZERO placements. */
async function writeZeroPlacementDraft(root: string): Promise<{ created: Project; saved: Project }> {
  const created = await createProject(root, { title: 'Unedited draft', output: {} });
  const draft = structuredClone(created);
  draft.composition!.scenes.push({ id: 'scene', description: 'the only scene' });
  draft.composition!.shots.push({
    id: 'shot',
    scene: 'scene',
    look: 'default',
    intent: 'the only shot',
    targetFrames: 30,
  });
  const saved = await saveProject(root, draft, created.revision);
  return { created, saved };
}

/** Directory entries, or `[]` when the directory does not exist. */
async function entriesOrEmpty(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test('a zero-placement draft saves, reloads, validates and has a finite zero length', async () => {
  await withRoot(async root => {
    const { saved } = await writeZeroPlacementDraft(root);
    assert.equal(saved.revision, 2, 'saving advances the revision');
    assert.deepEqual(saved.composition!.placements, [], 'still no placements');
    assert.doesNotThrow(() => validateProject(saved));

    const reloaded = await loadProject(root);
    assert.deepEqual(reloaded, saved, 'the draft round-trips through Save/Load');
    assert.equal(compositionFrames(reloaded), 0);
    assert.ok(Number.isFinite(compositionFrames(reloaded)), 'never -Infinity for an empty composition');
  });
});

test('a zero-placement draft with outputFrames reports that explicit programme length', async () => {
  await withRoot(async root => {
    const { created } = await writeZeroPlacementDraft(root);
    const current = await loadProject(root);
    const padded = structuredClone(current);
    padded.composition!.outputFrames = 30;

    const saved = await saveProject(root, padded, current.revision);
    assert.equal(saved.revision, created.revision + 2);
    assert.equal(saved.composition!.outputFrames, 30);
    assert.doesNotThrow(() => validateProject(saved));

    const reloaded = await loadProject(root);
    assert.equal(reloaded.composition!.outputFrames, 30);
    assert.equal(compositionFrames(reloaded), 30, 'the explicit length is the programme length');
    assert.ok(Number.isFinite(compositionFrames(reloaded)));
  });
});

test('buildProject refuses a zero-placement draft before any media work', async () => {
  await withRoot(async root => {
    await writeZeroPlacementDraft(root);

    await assert.rejects(
      buildProject(root),
      (error: Error) => {
        assert.match(error.message, /no placements/, 'the message names the missing picture');
        return true;
      },
      'an unedited draft with no placements must be refused',
    );

    assert.equal(
      await exists(join(root, '.viscraft', 'result.json')),
      false,
      'no result is published for a refused draft',
    );
    const artifacts = await entriesOrEmpty(join(root, '.viscraft', 'artifacts'));
    assert.deepEqual(artifacts, [], 'no placeholder artifact was produced');
  });
});

test('planBuild reports a zero-placement draft as not buildable', async () => {
  await withRoot(async root => {
    await writeZeroPlacementDraft(root);

    const plan = await planBuild(root);
    assert.equal(plan.buildable, false, 'a draft with no picture is not buildable');
    assert.equal(plan.timeline.placements, 0);
    assert.equal(plan.timeline.contentFrames, 0);
    const blocker = plan.blockers.find(issue => issue.code === 'not-buildable');
    assert.ok(blocker, 'the not-buildable blocker is present');
    assert.equal(blocker!.level, 'blocked');
  });
});
