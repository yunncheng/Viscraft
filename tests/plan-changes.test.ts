/**
 * Plan contract: `planBuild.changes` compares the current author state to the
 * ACTIVE result Build through the same contentHash + diff as Status, and
 * `planBuild.identity` warns when a stable Source identity was replaced.
 * Read-only (zero writes).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProjectSchema, planBuild } from '../src/index.js';
import { snapshotHashOf } from '../src/project/state.js';
import { hashFile } from '../src/shared/hash.js';
import type { BuildRecord, Project } from '../src/core/schema.js';

const OUTPUT = { width: 64, height: 48, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 2 };
const ENTRY = 'code/main.js';

function project(sourceId: string): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'plan_changes',
    revision: 1,
    title: 'Plan changes',
    direction: { intent: 'preflight', looks: [{ id: 'default', description: 'Default look' }], transitions: [] },
    assets: [],
    bindings: {},
    sources: [
      {
        id: sourceId,
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
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: 'scene' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'default', intent: 'shot', targetFrames: 24 }],
      placements: [
        { id: 'pl', shot: 'shot', source: sourceId, inFrame: 0, outFrame: 24, startFrame: 0, audio: 'keep' },
      ],
      transitions: [],
      audio: [],
    },
  });
}

async function writeResult(root: string, frozen: Project): Promise<void> {
  await mkdir(join(root, '.viscraft', 'snapshots'), { recursive: true });
  await mkdir(join(root, '.viscraft', 'builds'), { recursive: true });
  const files = { [ENTRY]: await hashFile(join(root, ENTRY)) };
  await writeFile(join(root, '.viscraft', 'snapshots', 'build-x.project.json'), JSON.stringify(frozen));
  await writeFile(
    join(root, '.viscraft', 'snapshots', 'build-x.inputs.json'),
    JSON.stringify({ files, unavailable: [] }),
  );
  const record: BuildRecord = {
    schemaVersion: 1,
    id: 'build-x',
    run: { id: 'run-x', goal: 'fixture' },
    plan: { operations: [] },
    revision: frozen.revision,
    snapshotHash: snapshotHashOf(frozen, files, []),
    status: 'succeeded',
    medium: 'picture',
    startedAt: '2026-01-01T00:00:00.000Z',
    operations: [],
    artifacts: [],
    takes: [],
    result: { artifact: 'artifact-x', simulated: false },
  };
  await writeFile(join(root, '.viscraft', 'builds', 'build-x.json'), JSON.stringify(record));
  await writeFile(
    join(root, '.viscraft', 'result.json'),
    JSON.stringify({
      build: 'build-x',
      artifact: 'artifact-x',
      path: '.viscraft/artifacts/artifact-x.mp4',
      sha256: 'a'.repeat(64),
      simulated: false,
    }),
  );
}

test('plan.changes is null with no active result and empty when unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-planchanges-'));
  try {
    await mkdir(join(root, 'code'), { recursive: true });
    await writeFile(join(root, ENTRY), 'export const ready = () => true;\n');
    const base = project('src_a');
    await writeFile(join(root, 'project.json'), JSON.stringify(base));

    const noResult = await planBuild(root);
    assert.equal(noResult.changes, null, 'no active result -> changes is null');

    await writeResult(root, base);
    const unchanged = await planBuild(root);
    assert.equal(unchanged.changes, null, 'unchanged authoring -> changes is null');
    assert.deepEqual(unchanged.identity, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('plan.changes lists the touched file after editing a Source parameter file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-planchanges-'));
  try {
    await mkdir(join(root, 'code'), { recursive: true });
    await writeFile(join(root, ENTRY), 'export const ready = () => true;\n');
    const base = project('src_a');
    await writeFile(join(root, 'project.json'), JSON.stringify(base));
    await writeResult(root, base);

    await writeFile(join(root, ENTRY), 'export const ready = () => false;\n');
    const plan = await planBuild(root);
    assert.notEqual(plan.changes, null);
    assert.equal(plan.changes?.files.length, 1);
    assert.equal(plan.changes?.files[0].path, ENTRY);
    assert.equal(plan.changes?.files[0].change, 'modified');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('plan.identity hints when a Source id is replaced with a same-kind, same-file Source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-planchanges-'));
  try {
    await mkdir(join(root, 'code'), { recursive: true });
    await writeFile(join(root, ENTRY), 'export const ready = () => true;\n');
    const base = project('src_a');
    await writeFile(join(root, 'project.json'), JSON.stringify(base));
    await writeResult(root, base);

    // Replace the Source id only (same kind, same authored entry, same Shot).
    const replaced = project('src_b');
    await writeFile(join(root, 'project.json'), JSON.stringify(replaced));
    const plan = await planBuild(root);
    assert.ok(
      plan.identity.some(hint => hint.includes('src_a') && hint.includes('src_b')),
      `expected an identity hint, got ${JSON.stringify(plan.identity)}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
