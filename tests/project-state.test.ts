/**
 * contract: one author-state definition and one production closure.
 *
 *  - `snapshotHash` is the frozen-snapshot integrity hash (unchanged).
 *  - `contentHash` is the "has the author changed the work?" hash: it must NOT
 *    move when only `revision` (bumped by revert) or `handoff` (a fact-page
 *    field) changes, and MUST move when a real input changes.
 *  - `productionClosure` reaches the authored files from a root, and
 *    `artifactAvailable` reports a missing/damaged Artifact honestly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createProject } from '../src/project/create.js';
import { authoringStatus, contentHashOf, snapshotHashOf } from '../src/project/state.js';
import { artifactAvailable, productionClosure } from '../src/project/closure.js';
import { resolveProjectPath } from '../src/shared/fs.js';
import { hashFile, stableHash } from '../src/shared/hash.js';
import type { Artifact, BuildRecord, Project } from '../src/core/schema.js';

const ENTRY = 'code/main.js';

async function fixture(): Promise<{ root: string; project: Project }> {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-state-'));
  const created = await createProject(root, { title: 'State contract' });
  await mkdir(await resolveProjectPath(root, 'code'), { recursive: true });
  await writeFile(await resolveProjectPath(root, ENTRY), 'export const ready = () => true;\n');
  const project: Project = {
    ...created,
    sources: [
      {
        id: 'scene',
        kind: 'browser',
        output: 'picture',
        entry: ENTRY,
        resources: [],
        bindings: [],
        params: {},
        seed: 0,
        frames: 24,
      },
    ],
  };
  return { root, project };
}

test('contentHash ignores revision and handoff; snapshotHash does not', () => {
  const files = { [ENTRY]: 'a'.repeat(64) };
  const base = { revision: 1, title: 't', assets: [], sources: [], imageDocuments: [] } as unknown as Project;
  const bumped = { ...base, revision: 7, handoff: [{ path: 'NOTES.md', role: 'notes' }] } as Project;

  assert.equal(
    contentHashOf(base, files, []),
    contentHashOf(bumped, files, []),
    'revision/handoff must not move contentHash',
  );
  assert.notEqual(
    snapshotHashOf(base, files, []),
    snapshotHashOf(bumped, files, []),
    'snapshotHash sees the raw fields',
  );
  assert.equal(snapshotHashOf(base, files, []), stableHash({ project: base, files, unavailable: [] }));

  const changed = { ...base, title: 'different' };
  assert.notEqual(
    contentHashOf(base, files, []),
    contentHashOf(changed, files, []),
    'a real change must move contentHash',
  );
});

test('authoringStatus compares current bytes to the frozen snapshot by contentHash', async () => {
  const { root, project } = await fixture();
  try {
    const authorHash = await hashFile(await resolveProjectPath(root, ENTRY));
    await mkdir(await resolveProjectPath(root, '.viscraft/snapshots'), { recursive: true });
    await writeFile(
      await resolveProjectPath(root, '.viscraft/snapshots/build-x.project.json'),
      JSON.stringify(project),
    );
    await writeFile(
      await resolveProjectPath(root, '.viscraft/snapshots/build-x.inputs.json'),
      JSON.stringify({ files: { [ENTRY]: authorHash }, unavailable: [] }),
    );
    const build = { id: 'build-x', snapshotHash: snapshotHashOf(project, { [ENTRY]: authorHash }, []) } as BuildRecord;

    assert.equal(await authoringStatus(root, project, build), 'unchanged');

    // A revert-like revision bump (author-facing metadata only) is not a change.
    assert.equal(await authoringStatus(root, { ...project, revision: project.revision + 1 }, build), 'unchanged');

    // Editing a real authored file IS a change.
    await writeFile(await resolveProjectPath(root, ENTRY), 'export const ready = () => false;\n');
    assert.equal(await authoringStatus(root, project, build), 'changed');

    // A missing snapshot is `unknown`, never a false verdict.
    await rm(await resolveProjectPath(root, '.viscraft/snapshots'), { recursive: true, force: true });
    assert.equal(await authoringStatus(root, project, build), 'unknown');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('productionClosure reaches authored files and artifactAvailable reports missing bytes', async () => {
  const { root, project } = await fixture();
  try {
    const closure = await productionClosure(root, project, [], ['author']);
    assert.ok(closure.files.has(ENTRY), 'the author root reaches the code entry');
    assert.deepEqual(closure.files.get(ENTRY)!.reasons, ['author']);

    const missing: Artifact = {
      id: 'artifact-absent',
      path: '.viscraft/artifacts/artifact-absent.mp4',
      sha256: 'b'.repeat(64),
      kind: 'video',
      simulated: false,
      operation: 'browser',
      inputs: [],
      backend: 'ffmpeg',
    };
    assert.equal(await artifactAvailable(root, missing), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('authoringStatus returns unknown when an authored file is missing', async () => {
  const { root, project } = await fixture();
  try {
    const authorHash = await hashFile(await resolveProjectPath(root, ENTRY));
    await mkdir(await resolveProjectPath(root, '.viscraft/snapshots'), { recursive: true });
    await writeFile(
      await resolveProjectPath(root, '.viscraft/snapshots/build-x.project.json'),
      JSON.stringify(project),
    );
    await writeFile(
      await resolveProjectPath(root, '.viscraft/snapshots/build-x.inputs.json'),
      JSON.stringify({ files: { [ENTRY]: authorHash }, unavailable: [] }),
    );
    await rm(await resolveProjectPath(root, ENTRY));
    assert.equal(await authoringStatus(root, project, { id: 'build-x' } as BuildRecord), 'unknown');
    // keep readFile imported meaningfully
    assert.ok((await readFile(await resolveProjectPath(root, 'project.json'), 'utf8')).length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
