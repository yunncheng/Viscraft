import { fileURLToPath } from 'node:url';
import { withGitDiscoveryBoundary } from './git-fixtures.js';
/**
 * Generated media protection, Project diffs, measured disk usage, archive
 * group selection and safe Project creation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createProject, scaffoldProject } from '../src/project/create.js';
import { loadProject } from '../src/project/project.js';
import { readBuilds } from '../src/project/build-records.js';
import { ProjectSchema, type Artifact, type BuildRecord, type Project } from '../src/core/schema.js';
import { productionClosure } from '../src/project/closure.js';
import { applyClean, planClean } from '../src/project/clean.js';
import { projectUsage } from '../src/project/usage.js';
import { projectStatus } from '../src/project/status.js';
import { diffIsEmpty, diffProjects } from '../src/project/diff.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';

const HEX = 'a'.repeat(64);
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function generatedArtifact(id: string, path: string, sha256: string): Artifact {
  return {
    id,
    path,
    sha256,
    kind: 'video',
    simulated: false,
    operation: 'generation',
    inputs: [],
    backend: 'runway',
    generation: {
      provider: 'runway',
      model: 'gen4',
      taskId: `task-${id}`,
      requestHash: HEX,
      originalSha256: sha256,
      references: [],
    },
  };
}

function buildRecord(id: string, status: 'succeeded' | 'failed', artifacts: Artifact[]): BuildRecord {
  return {
    schemaVersion: 1,
    id,
    run: { id: `run-${id}`, goal: 'fixture' },
    plan: { operations: [] },
    revision: 1,
    snapshotHash: 'fixture-snapshot-hash',
    status,
    medium: 'picture',
    startedAt: '2026-01-01T00:00:00.000Z',
    operations: [],
    artifacts,
    takes: [],
  };
}

test('a completed generated Artifact in a FAILED Build stays protected, and a failed Build with no snapshot does not crash clean/usage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-protection-'));
  try {
    await createProject(root, { title: 'Protection fixture' });
    await mkdir(join(root, '.viscraft', 'artifacts'), { recursive: true });
    await mkdir(join(root, '.viscraft', 'builds'), { recursive: true });
    await mkdir(join(root, '.viscraft', 'scratch'), { recursive: true });
    await mkdir(join(root, '.viscraft', 'snapshots'), { recursive: true });

    // Model a non-simulated generated Artifact retained by a failed Build with
    // no snapshot metadata. These opaque bytes test protection and bookkeeping;
    // this test does not decode them or claim a real generation result.
    const genPath = '.viscraft/artifacts/artifact-gen1.mp4';
    await writeFile(join(root, genPath), Buffer.alloc(4096, 7));
    const genSha = await hashFile(join(root, genPath));
    await writeFile(
      join(root, '.viscraft', 'builds', 'build-failed.json'),
      JSON.stringify(buildRecord('build-failed', 'failed', [generatedArtifact('artifact-gen1', genPath, genSha)])),
    );

    // A second failed Build that DID write a snapshot: the Build may then be
    // added to the closure and its snapshot expanded without error.
    const snapPath = '.viscraft/artifacts/artifact-gen2.mp4';
    await writeFile(join(root, snapPath), Buffer.alloc(1024, 8));
    const snapSha = await hashFile(join(root, snapPath));
    await writeFile(
      join(root, '.viscraft', 'builds', 'build-failed-snap.json'),
      JSON.stringify(
        buildRecord('build-failed-snap', 'failed', [generatedArtifact('artifact-gen2', snapPath, snapSha)]),
      ),
    );
    await writeFile(
      join(root, '.viscraft', 'snapshots', 'build-failed-snap.project.json'),
      await readFile(join(root, 'project.json'), 'utf8'),
    );
    await writeFile(
      join(root, '.viscraft', 'snapshots', 'build-failed-snap.inputs.json'),
      JSON.stringify({ files: {}, unavailable: [] }),
    );

    // Only a scratch leftover is genuinely reclaimable.
    await writeFile(join(root, '.viscraft', 'scratch', 'leftover.bin'), Buffer.alloc(2048, 3));

    const project = await loadProject(root);
    const builds = await readBuilds(root);
    const closure = await productionClosure(root, project, builds, [
      'author',
      'active-result',
      'retained',
      'checkpoint',
      'derived',
      'generated',
    ]);
    assert.equal(
      closure.artifacts.get('artifact-gen1'),
      'generated',
      'a failed Build’s generated artifact is protected',
    );
    assert.equal(closure.artifacts.get('artifact-gen2'), 'generated');
    assert.ok(closure.files.has(genPath), 'the protected generated file is in the closure');

    const plan = await planClean(root);
    assert.ok(
      plan.items.every(item => item.path !== genPath && item.path !== snapPath),
      'clean never plans a protected generated artifact',
    );
    assert.equal(plan.byReason.rebuildable, undefined, 'nothing reachable is called rebuildable');
    assert.equal(plan.freedPhysicalBytes, 2048, 'only the scratch leftover is reclaimable');

    const usage = await projectUsage(root);
    assert.equal(usage.artifacts['protected-generated']?.files, 2, 'usage reports both as protected-generated');
    assert.equal(
      usage.reclaimablePhysicalBytes,
      plan.freedPhysicalBytes,
      'usage.reclaimable must equal the clean plan for the same project ()',
    );

    const applied = await applyClean(root, plan.planHash);
    assert.equal(applied.status, 'complete');
    assert.equal(await hashFile(join(root, genPath)), genSha, 'the generated artifact survives clean');
    assert.equal(await hashFile(join(root, snapPath)), snapSha);
    await assert.rejects(lstat(join(root, '.viscraft', 'scratch', 'leftover.bin')), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- ----------------------------------------------------------------

function baseProject(): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'diff_fixture',
    revision: 1,
    title: 'Diff fixture',
    direction: { intent: 'original intent', looks: [{ id: 'look', description: 'L' }], transitions: [] },
    assets: [],
    bindings: { old: 'a9', b: 'a1' },
    sources: [],
    composition: {
      output: { width: 32, height: 24, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [],
      shots: [],
      placements: [],
      layers: [{ id: 'lay', asset: 'a1', inFrame: 0, outFrame: 24, startFrame: 0, x: 0, y: 0, width: 8, height: 8 }],
    },
  });
}

test('the Project diff reports sound targets, layers, bindings, worlds, title and direction changes', () => {
  const before = baseProject();
  before.soundTargets = [{ id: 'score', outputSamples: 4800, sampleRate: 48000, channels: 1, audio: [] }];
  const soundEdited = structuredClone(before);
  Object.assign(soundEdited.soundTargets[0], { outputSamples: 8820, sampleRate: 44100, channels: 2 });
  const soundDiff = diffProjects(before, soundEdited, {}, {});
  assert.deepEqual(soundDiff.soundTargets, [
    { id: 'score', change: 'modified', fields: ['channels', 'outputSamples', 'sampleRate'] },
  ]);
  assert.equal(diffIsEmpty(soundDiff), false, 'a sound-only edit is a production change');
  assert.deepEqual(soundDiff.counts, { added: 0, removed: 0, modified: 1 });
  const after = baseProject();
  after.title = 'Diff fixture renamed';
  after.direction.intent = 'a changed intent';
  after.direction.transitions = [{ from: 'look', to: 'look', intent: 'new direction transition' }];
  after.composition!.layers![0].x = 4;
  after.bindings = { b: 'a2', bg: 'a1' };
  after.worlds = [
    {
      id: 'world',
      revision: 1,
      units: 'meters',
      coordinates: 'right-handed-y-up',
      fps: { numerator: 24, denominator: 1 },
      frames: 24,
      entities: [],
      trajectories: [],
      cameras: [{ id: 'cam', position: [0, 0, 0], target: [0, 0, 0], fov: 50 }],
    },
  ];

  const diff = diffProjects(before, after, {}, {});
  assert.deepEqual(
    diff.layers.map(entry => [entry.id, entry.change, entry.fields]),
    [['lay', 'modified', ['x']]],
  );
  assert.deepEqual(diff.bindings.map(entry => [entry.id, entry.change]).sort(), [
    ['b', 'modified'],
    ['bg', 'added'],
    ['old', 'removed'],
  ]);
  assert.deepEqual(
    diff.worlds.map(entry => [entry.id, entry.change]),
    [['world', 'added']],
  );
  assert.deepEqual(
    diff.directionTransitions.map(entry => [entry.id, entry.change]),
    [['look->look', 'added']],
  );
  assert.deepEqual(diff.project, ['title']);
  assert.deepEqual(diff.direction, ['intent']);
  assert.equal(diffIsEmpty(diff), false, 'these edits are not an empty diff');
});

// --- ----------------------------------------------------------------

test('status does not report a fake byte total', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-status-usage-'));
  try {
    await createProject(root, { title: 'Status usage' });
    const status = await projectStatus(root);
    assert.equal(Object.hasOwn(status.usage, 'totalBytes'), false, 'no fake totalBytes field');
    assert.equal(status.usage.measured, false);
    assert.match(status.usage.detail, /viscraft usage/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- ----------------------------------------------------------------

test('usage skips install/VCS trees, excludes output/.gitignore from delivery, and states its scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-usage-scope-'));
  try {
    await createProject(root, { title: 'Usage scope' });
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
    await mkdir(join(root, '.git', 'objects'), { recursive: true });
    await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await mkdir(join(root, 'output'), { recursive: true });
    await writeFile(join(root, 'output', '.gitignore'), '*\n');
    await writeFile(join(root, 'output', 'delivery.bin'), Buffer.alloc(512, 1));

    const usage = await projectUsage(root);
    assert.deepEqual(
      usage.scope.excluded.map(entry => entry.path).sort(),
      ['.git', 'node_modules'],
      'the install and version-control trees are named as excluded',
    );
    assert.ok(
      usage.attention.every(entry => !entry.includes('outside the known layout')),
      'a normal install layout is not reported as an unknown-layout anomaly',
    );
    assert.equal(usage.categories.other.files, 0, 'no install-tree file is left unclassified');
    assert.ok(usage.categories.records.reasons.includes('self-ignore'), 'output/.gitignore is metadata');
    assert.equal(usage.categories.output.files, 1, 'only the real delivery is in the output category');
    assert.ok(
      usage.output.every(entry => entry.name !== '.gitignore'),
      'output/.gitignore is not reported as a delivery',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- ----------------------------------------------------------------

const PARTS_PREFIX = 'output/arch.tar.gz';

async function shardedArchiveFixture(root: string): Promise<string[]> {
  await createProject(root, { title: 'Archive group' });
  await mkdir(join(root, 'output'), { recursive: true });
  const members = [`${PARTS_PREFIX}.parts.json`, PARTS_PREFIX, `${PARTS_PREFIX}.part-001`, `${PARTS_PREFIX}.part-002`];
  for (const relative of members) await writeFile(join(root, relative), relative);
  // Same-prefix NON-members that must survive.
  await writeFile(join(root, `${PARTS_PREFIX}.part-999`), 'foreign part');
  await writeFile(join(root, `${PARTS_PREFIX}.extra`), 'foreign file');
  await writeFile(
    join(root, `${PARTS_PREFIX}.parts.json`),
    JSON.stringify({
      format: 'viscraft-archive-parts',
      version: 1,
      projectId: 'archive_group',
      revision: 1,
      archive: { sha256: 'd'.repeat(64), bytes: 1500 },
      parts: [
        { name: 'arch.tar.gz.part-001', sha256: 'b'.repeat(64), bytes: 1000 },
        { name: 'arch.tar.gz.part-002', sha256: 'c'.repeat(64), bytes: 500 },
      ],
    }),
  );
  await mkdir(join(root, '.viscraft', 'deliveries'), { recursive: true });
  await writeFile(
    join(root, '.viscraft', 'deliveries', 'arch.tar.gz.json'),
    JSON.stringify({
      name: 'arch.tar.gz',
      path: 'arch.tar.gz.parts.json',

      kind: 'archive',
      revision: 1,
      deliveredAt: '2026-01-01T00:00:00.000Z',
      manifestSha256: 'e'.repeat(64),
    }),
  );
  return members;
}

test('clean --include resolves a sharded archive to its whole group, preserving same-prefix non-members', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-clean-group-'));
  try {
    const members = await shardedArchiveFixture(root);

    const byStem = await planClean(root, { include: [PARTS_PREFIX] });
    const includedStem = byStem.items
      .filter(item => item.reason === 'included-output')
      .map(item => item.path)
      .sort();
    assert.deepEqual(includedStem, [...members].sort(), 'the whole group is planned by the record stem');

    const byList = await planClean(root, { include: [`${PARTS_PREFIX}.parts.json`] });
    const includedList = byList.items
      .filter(item => item.reason === 'included-output')
      .map(item => item.path)
      .sort();
    assert.deepEqual(includedList, [...members].sort(), 'naming the parts list plans the same whole group');

    const planned = new Set(byStem.items.map(item => item.path));
    assert.equal(planned.has(`${PARTS_PREFIX}.part-999`), false, 'a foreign part is not a member');
    assert.equal(planned.has(`${PARTS_PREFIX}.extra`), false, 'a same-prefix non-member is preserved');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- ----------------------------------------------------------------

function runCli(args: string[]): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: process.env });
  return { status: result.status, stderr: result.stderr };
}

test('create refuses a missing-value or unknown option before writing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-create-cli-'));
  try {
    const missing = runCli(['create', join(root, 'a'), 'Title', '--size']);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /requires a value/);
    await assert.rejects(lstat(join(root, 'a', 'project.json')), /ENOENT/);

    const unknown = runCli(['create', join(root, 'b'), 'Title', '--bogus', '1']);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /unknown option/);
    await assert.rejects(lstat(join(root, 'b', 'project.json')), /ENOENT/);

    const ok = runCli(['create', join(root, 'c'), 'Title', '--size', '64x48']);
    assert.equal(ok.status, 0, ok.stderr);
    const project = JSON.parse(await readFile(join(root, 'c', 'project.json'), 'utf8')) as Project;
    assert.equal(project.composition!.output.width, 64);
    assert.equal(project.composition!.output.height, 48);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function gitAvailable(): Promise<boolean> {
  try {
    await runCommand('git', ['--version']);
    return true;
  } catch {
    return false;
  }
}

test('scaffoldProject does not git init on an undetermined probe', async t => {
  if (!(await gitAvailable())) return t.skip('git is not available');
  const root = await mkdtemp(join(tmpdir(), 'viscraft-gitprobe-'));
  try {
    await withGitDiscoveryBoundary(root, async () => {
      // A malformed `.git` file makes `git rev-parse` fail with "invalid gitfile
      // format", rather than "not a git repository". Initialising here would be wrong.
      await writeFile(join(root, '.git'), 'garbage\n');
      const result = await scaffoldProject(root);
      assert.equal(result.git, 'probe-failed', 'an undetermined git state is reported, never initialised');
      assert.equal((await lstat(join(root, '.git'))).isFile(), true, 'the directory was left untouched');
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
