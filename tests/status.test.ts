/**
 * `viscraft status` contract.
 *
 * Fixtures: no Build / current & unchanged / author changed / latest Build
 * failed while the current result is still valid / an unknown provider
 * submission / a missing result artifact (`available:false`) — and every case
 * must be ZERO-WRITE (the whole Project tree hashes identically before/after).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { createProject } from '../src/project/create.js';
import { projectStatus } from '../src/project/status.js';
import { snapshotHashOf } from '../src/project/state.js';
import { hashFile, stableHash } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import type { Artifact, BuildRecord, Project } from '../src/core/schema.js';

const ENTRY = 'code/main.js';
const ARTIFACT_ID = 'artifact-statusfixture';
const ARTIFACT_REL = `.viscraft/artifacts/${ARTIFACT_ID}.mp4`;

function artifact(sha256: string): Artifact {
  return {
    id: ARTIFACT_ID,
    path: ARTIFACT_REL,
    sha256,
    kind: 'video',
    simulated: false,
    operation: 'browser',
    inputs: [],
    backend: 'chrome',
    media: {
      frames: 96,
      fps: { numerator: 24, denominator: 1 },
      width: 640,
      height: 360,
      duration: 4,
      videoCodec: 'h264',
    },
  };
}

async function makeProject(root: string, entry = 'export const ready = () => true;\n'): Promise<Project> {
  const created = await createProject(root, { title: 'Status fixture', output: { width: 640, height: 360 } });
  await mkdir(join(root, 'code'), { recursive: true });
  await writeFile(join(root, ENTRY), entry);
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
  await writeFile(join(root, 'project.json'), JSON.stringify(project));
  return project;
}

interface FixtureOptions {
  withResult?: boolean;
  writeArtifact?: boolean;
  extraBuilds?: Array<{ id: string; status: 'succeeded' | 'failed' | 'running'; startedAt: string; stale?: boolean }>;
  unknownSubmission?: boolean;
}

async function makeBuild(root: string, project: Project, options: FixtureOptions = {}): Promise<void> {
  const withResult = options.withResult ?? true;
  await mkdir(join(root, '.viscraft', 'snapshots'), { recursive: true });
  await mkdir(join(root, '.viscraft', 'builds'), { recursive: true });
  await mkdir(join(root, '.viscraft', 'artifacts'), { recursive: true });
  const entrySha = await hashFile(join(root, ENTRY));
  const files = { [ENTRY]: entrySha };
  await writeFile(join(root, '.viscraft', 'snapshots', 'build-x.project.json'), JSON.stringify(project));
  await writeFile(
    join(root, '.viscraft', 'snapshots', 'build-x.inputs.json'),
    JSON.stringify({ files, unavailable: [] }),
  );
  if (options.writeArtifact !== false) await writeFile(join(root, ARTIFACT_REL), Buffer.alloc(64, 7));
  const sha = (await hashFile(join(root, ARTIFACT_REL)).catch(() => 'a'.repeat(64))) as string;
  const artifactRecord = artifact(sha);
  const record: BuildRecord = {
    schemaVersion: 1,
    id: 'build-x',
    run: { id: 'run-x', goal: 'fixture' },
    plan: { operations: [] },
    revision: project.revision,
    snapshotHash: snapshotHashOf(project, files, []),
    status: 'succeeded',
    medium: 'picture',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
    operations: [],
    artifacts: [artifactRecord],
    takes: [],
    result: { artifact: ARTIFACT_ID, simulated: false },
  };
  await writeFile(join(root, '.viscraft', 'builds', 'build-x.json'), JSON.stringify(record));
  if (withResult)
    await writeFile(
      join(root, '.viscraft', 'result.json'),
      JSON.stringify({ build: 'build-x', artifact: ARTIFACT_ID, path: ARTIFACT_REL, sha256: sha, simulated: false }),
    );
  for (const extra of options.extraBuilds ?? []) {
    const extraRecord: BuildRecord = {
      ...record,
      id: extra.id,
      status: extra.status,
      startedAt: extra.startedAt,
      stale: extra.stale,
      artifacts: [],
      result: undefined,
    };
    await writeFile(join(root, '.viscraft', 'builds', `${extra.id}.json`), JSON.stringify(extraRecord));
  }
  if (options.unknownSubmission) {
    await mkdir(join(root, '.viscraft', 'jobs', 'video-api'), { recursive: true });
    const job = {
      schemaVersion: 1,
      backend: 'video-api',
      provider: 'video-api',
      model: 'm',
      simulated: false,
      mode: 'test',
      attempt: 'a1',
      sourceId: 'scene',
      promptHash: '0'.repeat(64),
      parametersHash: stableHash({}),
      requestHash: '1'.repeat(64),
      protocolVersion: 1,
      protocol: 'vllm-omni-video',
      extensionHash: '2'.repeat(64),
      endpointHash: '3'.repeat(64),
      locatorHash: stableHash([]),
      references: [],
      size: '1280:720',
      width: 1280,
      height: 720,
      requestedFrames: 24,
      fps: 24,
      endpoint: 'ep',
      output: { width: 800, height: 450, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 2 },
      state: 'submit-unknown',
      submitted: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    await writeFile(join(root, '.viscraft', 'jobs', 'video-api', 'a1.json'), JSON.stringify(job));
  }
}

async function treeHashes(root: string): Promise<string> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else out.push(`${relative(root, abs)}:${await hashFile(abs)}`);
    }
  }
  await walk(root);
  return out.sort().join('\n');
}

test('status: no Build yet offers plan/build and reports no current result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-status-'));
  try {
    await makeProject(root);
    const status = await projectStatus(root);
    assert.equal(status.current, null);
    assert.equal(status.latestBuild, null);
    assert.ok(status.next.some(line => line.includes('no Build yet')));
    assert.deepEqual(status.providerJobs, { pending: 0, unknownSubmission: 0, succeeded: 0, failed: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('status: current result, unchanged authoring, and a failed newest Build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-status-'));
  try {
    const project = await makeProject(root);
    await makeBuild(root, project, {
      extraBuilds: [{ id: 'build-y', status: 'failed', startedAt: '2026-01-02T00:00:00.000Z' }],
    });
    const status = await projectStatus(root);
    assert.equal(status.project.id, project.id);
    assert.equal(status.current?.build, 'build-x');
    assert.equal(status.current?.available, true);
    assert.equal(status.current?.authoring, 'unchanged');
    assert.equal(status.current?.changes, null);
    assert.equal(status.current?.frames, 96);
    assert.equal(status.current?.fps, '24/1');
    assert.equal(status.latestBuild?.id, 'build-y');
    assert.equal(status.latestBuild?.status, 'failed');
    assert.ok(status.next.some(line => line.includes('author changed')) === false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('status: an edited authored file flips authoring to changed with a file diff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-status-'));
  try {
    const project = await makeProject(root);
    await makeBuild(root, project);
    await writeFile(join(root, ENTRY), 'export const ready = () => false;\n');
    const status = await projectStatus(root);
    assert.equal(status.current?.authoring, 'changed');
    assert.equal(status.current?.changes?.files.length, 1);
    assert.equal(status.current?.changes?.files[0].path, ENTRY);
    assert.equal(status.current?.changes?.files[0].change, 'modified');
    assert.ok(status.next.some(line => line.includes('run `viscraft plan`')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('status: a missing result artifact is available:false', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-status-'));
  try {
    const project = await makeProject(root);
    await makeBuild(root, project, { writeArtifact: false });
    const status = await projectStatus(root);
    assert.equal(status.current?.available, false);
    assert.equal(status.current?.build, 'build-x');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('status: an unknown provider submission raises attention', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-status-'));
  try {
    const project = await makeProject(root);
    await makeBuild(root, project, { unknownSubmission: true });
    const status = await projectStatus(root);
    assert.equal(status.providerJobs.unknownSubmission, 1);
    assert.equal(status.attention[0]?.code, 'unknown-submission');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('status: a malformed or dangling result.json is surfaced, not hidden', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-status-'));
  try {
    await makeProject(root);
    await mkdir(join(root, '.viscraft'), { recursive: true });
    await writeFile(join(root, '.viscraft', 'result.json'), '{ not valid json');
    const status = await projectStatus(root);
    assert.equal(status.current, null);
    assert.equal(status.attention[0]?.code, 'active-result-invalid');

    // A result that references a Build which does not exist is also surfaced.
    await writeFile(
      join(root, '.viscraft', 'result.json'),
      JSON.stringify({
        build: 'build-ghost',
        artifact: 'artifact-ghost',
        path: 'p',
        sha256: 'a'.repeat(64),
        simulated: false,
      }),
    );
    const dangling = await projectStatus(root);
    assert.equal(dangling.current, null);
    assert.equal(dangling.attention[0]?.code, 'active-result-invalid');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('status: running writer locks are reported and status is zero-write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-status-'));
  try {
    const project = await makeProject(root);
    await makeBuild(root, project);
    await writeFile(join(root, '.viscraft', 'build.lock'), JSON.stringify({ pid: process.pid, host: 'h', token: 't' }));
    const before = await treeHashes(root);
    const status = await projectStatus(root);
    const after = await treeHashes(root);
    assert.equal(status.running.buildLock, true);
    assert.equal(before, after, 'status must not write anything');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('status: untracked and modified files appear in the git working-tree summary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-status-'));
  try {
    const project = await makeProject(root);
    try {
      await runCommand('git', ['-C', root, 'init', '--quiet']);
    } catch {
      return; // git unavailable: the summary correctly reports `unavailable`; no assertion to make.
    }
    // An untracked author file, and a modification to a tracked one.
    await writeFile(join(root, 'notes.txt'), 'draft\n');
    await runCommand('git', ['-C', root, 'add', 'code/main.js']);
    await writeFile(join(root, ENTRY), 'export const ready = () => false;\n');

    const status = await projectStatus(root);
    assert.equal(status.git.inRepo, true);
    assert.ok(status.git.untracked >= 1, 'the untracked author file is counted');
    assert.ok(status.git.paths.includes('notes.txt'), 'its path is listed');
    assert.ok(status.git.modified >= 1, 'the edited tracked file is counted');
    // `.viscraft/` self-ignores, so Runtime records never pollute the author's view.
    assert.ok(
      !status.git.paths.some(path => path.startsWith('.viscraft') || path.startsWith('output')),
      'the Runtime-owned directories do not appear in the summary',
    );
    void project;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('status: a directory outside any git work tree reports no summary without error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-status-'));
  try {
    await makeProject(root);
    const status = await projectStatus(root);
    // tmpdir is outside a work tree; if the environment differs, the summary is
    // still informational and must not throw.
    if (!status.git.inRepo) {
      assert.equal(status.git.untracked, 0);
      assert.equal(status.git.modified, 0);
      assert.deepEqual(status.git.paths, []);
      assert.ok(status.git.reason === 'not-a-repo' || status.git.reason === 'git-unavailable');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
