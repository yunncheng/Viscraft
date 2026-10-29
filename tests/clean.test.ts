/**
 * `clean` (plan / apply / resume / abort, snapshot compaction) and the
 * archive release path (`--release-archived`, `restore-media`) on a small
 * deterministic code-authored project.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildProject, previewProject } from '../src/build/build.js';
import { planBuild } from '../src/build/plan.js';
import { archiveProject } from '../src/operations/delivery/archive.js';
import { deliverProject } from '../src/operations/delivery/delivery.js';
import { abortClean, applyClean, planClean, resumeClean, setCleanStepHookForTest } from '../src/project/clean.js';
import { productionClosure } from '../src/project/closure.js';
import { contentPath } from '../src/project/content-store.js';
import { loadProject } from '../src/project/project.js';
import { readBuilds } from '../src/project/build-records.js';
import { releaseArchived, restoreMedia } from '../src/project/release.js';
import { projectStatus } from '../src/project/status.js';
import { keepVersion, listVersions, revertProject } from '../src/project/versions.js';
import { hashFile } from '../src/shared/hash.js';
import type { BuildRecord, Project } from '../src/core/schema.js';

const scene = (color: string, broken = false) => `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden}canvas{display:block}</style></head>
<body><canvas id="c"></canvas><script>
window.viscraft = { render(ctx) {
  ${broken ? "throw new Error('deliberately broken scene');" : ''}
  const c = document.getElementById('c'); c.width = ctx.width; c.height = ctx.height;
  const g = c.getContext('2d'); g.fillStyle = '${color}'; g.fillRect(0, 0, ctx.width, ctx.height);
  g.fillStyle = '#fff'; g.fillRect(ctx.frame * 4, 2, 4, 4);
} };
</script></body></html>
`;

function project(take?: string): Project {
  return {
    schemaVersion: 1,
    id: 'clean_fixture',
    revision: 1,
    title: 'Clean fixture',
    soundTargets: [],
    direction: { intent: '', looks: [{ id: 'look', description: '' }], transitions: [] },
    assets: [],
    bindings: {},
    sources: [
      {
        id: 'src',
        kind: 'browser',
        output: 'picture',
        entry: 'scene.html',
        resources: [],
        bindings: [],
        params: {},
        seed: 1,
        frames: 2,
      },
    ],
    composition: {
      output: { width: 32, height: 24, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene', description: '' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: '', targetFrames: 2 }],
      placements: [
        take
          ? { id: 'pl', shot: 'shot', take, inFrame: 0, outFrame: 2, startFrame: 0, audio: 'mute' }
          : { id: 'pl', shot: 'shot', source: 'src', inFrame: 0, outFrame: 2, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio: [],
    },
    imageDocuments: [],
    imageTargets: [],
  };
}

async function writeProject(root: string, value: Project): Promise<void> {
  await writeFile(path.join(root, 'project.json'), `${JSON.stringify(value, null, 2)}\n`);
}

async function listTree(root: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true }).catch(() => [])) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listTree(root, relative)));
    else out.push(relative);
  }
  return out.sort();
}

async function fingerprint(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const relative of await listTree(root)) {
    const info = await lstat(path.join(root, relative));
    out.push(`${relative}:${info.size}:${info.mtimeMs}:${info.ino}`);
  }
  return out;
}

const resultSha = (record: BuildRecord) => record.artifacts.find(a => a.id === record.result?.artifact)!.sha256;

/** v1 (red) → v2 (blue) → failed (broken) → v3 (green), plus a preview, scratch and a delivery. */
async function history(): Promise<{ root: string; v1: BuildRecord; v2: BuildRecord; v3: BuildRecord }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'viscraft-clean-'));
  await writeProject(root, project());
  await writeFile(path.join(root, 'scene.html'), scene('#c33'));
  const v1 = await buildProject(root);
  await writeFile(path.join(root, 'scene.html'), scene('#33c'));
  const v2 = await buildProject(root);
  await writeFile(path.join(root, 'scene.html'), scene('#3c3', true));
  await assert.rejects(buildProject(root), /failed/);
  await writeFile(path.join(root, 'scene.html'), scene('#3c3'));
  const v3 = await buildProject(root);
  await previewProject(root, { frames: [0, 1], scale: 0.5 });
  await mkdir(path.join(root, '.viscraft', 'scratch'), { recursive: true });
  await writeFile(path.join(root, '.viscraft', 'scratch', 'left-over.tmp'), 'scratch bytes');
  await deliverProject(root, undefined);
  return { root, v1, v2, v3 };
}

test('clean plans only unprotected bytes, refuses a stale plan and leaves every entry point working', async () => {
  const { root, v1, v2, v3 } = await history();
  try {
    await keepVersion(root, v2.id, 'approved blue');
    const before = await fingerprint(root);
    const plan = await planClean(root);
    assert.deepEqual(await fingerprint(root), before, 'a dry-run plan writes nothing');

    // Nothing protected is planned.
    const builds = await readBuilds(root);
    const closure = await productionClosure(root, await loadProject(root), builds, [
      'author',
      'active-result',
      'retained',
      'checkpoint',
      'derived',
      'generated',
    ]);
    for (const item of plan.items.filter(item => item.action === 'delete'))
      assert.equal(closure.files.has(item.path), false, `${item.path} is protected but planned`);
    assert.ok(
      plan.items.every(item => !item.path.startsWith('.viscraft/builds/')),
      'records are never planned',
    );
    assert.ok(
      plan.items.every(item => !item.path.startsWith('output/')),
      'deliveries need --include',
    );
    const reasons = new Set(plan.items.map(item => item.reason));
    for (const reason of ['scratch', 'preview', 'failed-snapshot', 'preview-snapshot'])
      assert.ok(reasons.has(reason as never), `plan includes ${reason}`);

    // A failed snapshot whose frozen bytes are still referenced elsewhere frees 0.
    const failed = builds.find(build => build.status === 'failed')!;
    const failedProjectFile = plan.items.find(item => item.path.startsWith(`.viscraft/snapshots/${failed.id}/`))!;
    const failedSceneShared = plan.items.find(
      item => item.reason === 'failed-snapshot' && item.path.endsWith('/scene.html'),
    );
    assert.ok(failedProjectFile, 'the failed Build snapshot directory is planned');
    // The broken scene's bytes are unique to the failed Build: its store entry
    // becomes an orphan in the same plan, so the pair frees exactly one copy.
    const orphan = plan.items.find(item => item.reason === 'orphan-content');
    assert.ok(orphan && failedSceneShared, 'the failed-only content entry is orphaned by the same plan');
    assert.equal(
      orphan!.physicalBytes + failedSceneShared!.physicalBytes,
      (await lstat(path.join(root, failedSceneShared!.path))).size,
    );
    assert.equal(
      plan.freedPhysicalBytes,
      plan.items.reduce((sum, item) => sum + item.physicalBytes, 0),
    );

    // A stale plan hash is refused.
    await writeFile(path.join(root, '.viscraft', 'scratch', 'another.tmp'), 'more');
    await assert.rejects(applyClean(root, plan.planHash), /plan changed/);
    const fresh = await planClean(root);
    const applied = await applyClean(root, fresh.planHash);
    assert.equal(applied.status, 'complete');
    assert.equal(applied.skipped.length, 0);
    assert.equal(applied.freedPhysicalBytes, fresh.freedPhysicalBytes);
    for (const item of fresh.items.filter(item => item.action === 'delete'))
      await assert.rejects(lstat(path.join(root, item.path)), /ENOENT/, `${item.path} removed`);
    assert.ok(
      (await readdir(path.join(root, '.viscraft', 'builds'))).includes(`${failed.id}.json`),
      'the failed Build record stays',
    );

    // Entry points after cleaning.
    const status = await projectStatus(root);
    assert.equal(status.current?.build, v3.id);
    assert.equal(status.current?.available, true);
    const versions = await listVersions(root);
    assert.equal(versions.versions.find(entry => entry.id === v2.id)?.result?.available, true, 'retained stays');
    const plan2 = await planBuild(root);
    assert.equal(plan2.work.length, 0, 'unchanged Sources keep reusing');
    await revertProject(root, v1.id);
    const rebuilt = await buildProject(root);
    assert.equal(resultSha(rebuilt), resultSha(v1), 'an unprotected old version rebuilds byte-identically');
    await deliverProject(root, undefined, {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('clean compacts duplicate snapshot copies into store links without changing frozen bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'viscraft-clean-compact-'));
  try {
    await writeProject(root, project());
    await writeFile(path.join(root, 'scene.html'), scene('#c33'));
    const build = await buildProject(root);
    const frozen = path.join(root, '.viscraft', 'snapshots', build.id, 'scene.html');
    // Turn the store link into an independent physical copy (as an older Build left it).
    await copyFile(frozen, `${frozen}.copy`);
    await rm(frozen, { force: true });
    await rename(`${frozen}.copy`, frozen);
    const sha = await hashFile(frozen);
    const entry = path.join(root, ...contentPath(sha).split('/'));
    assert.notEqual((await lstat(frozen)).ino, (await lstat(entry)).ino);

    const plan = await planClean(root);
    const compact = plan.items.find(item => item.action === 'compact');
    assert.ok(compact, 'the duplicate copy is planned for compaction');
    assert.equal(compact!.physicalBytes, (await lstat(frozen)).size);
    await applyClean(root, plan.planHash);
    assert.equal((await lstat(frozen)).ino, (await lstat(entry)).ino, 'the snapshot path now links the store entry');
    assert.equal(await hashFile(frozen), sha, 'frozen bytes unchanged');
    assert.equal((await planClean(root)).items.length, 0, 'nothing left to do');
    assert.equal((await planBuild(root)).work.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an interrupted clean resumes from its record and skips items protected meanwhile', async () => {
  const { root, v1 } = await history();
  try {
    const plan = await planClean(root, { include: [v1.id] });
    const v1Artifact = v1.artifacts.find(artifact => artifact.id === v1.result!.artifact)!;
    assert.ok(plan.items.some(item => item.path === v1Artifact.path && item.reason === 'included-artifact'));
    let calls = 0;
    setCleanStepHookForTest(() => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('simulated interrupt'), { simulatedInterrupt: true });
    });
    try {
      await assert.rejects(applyClean(root, plan.planHash, { include: [v1.id] }), /simulated interrupt/);
    } finally {
      setCleanStepHookForTest();
    }
    const status = await projectStatus(root);
    assert.ok(status.attention.some(item => item.code === 'cleanup-incomplete'));
    await assert.rejects(applyClean(root, (await planClean(root)).planHash), /cleanup is incomplete/);
    await assert.rejects(revertProject(root, v1.id), /cleanup is incomplete/);

    await keepVersion(root, v1.id);
    const resumed = await resumeClean(root);
    assert.equal(resumed.status, 'complete');
    assert.ok(
      resumed.skipped.some(item => item.path === v1Artifact.path && item.reason === 'now-protected'),
      'the version kept during the interruption is skipped',
    );
    assert.equal(await hashFile(path.join(root, v1Artifact.path)), v1Artifact.sha256);
    assert.equal(
      (await projectStatus(root)).attention.some(item => item.code === 'cleanup-incomplete'),
      false,
    );

    // --abort only marks the record.
    await mkdir(path.join(root, '.viscraft', 'scratch'), { recursive: true });
    await writeFile(path.join(root, '.viscraft', 'scratch', 'x.tmp'), 'x');
    const next = await planClean(root);
    setCleanStepHookForTest(() => {
      throw Object.assign(new Error('simulated interrupt'), { simulatedInterrupt: true });
    });
    try {
      await assert.rejects(applyClean(root, next.planHash), /simulated interrupt/);
    } finally {
      setCleanStepHookForTest();
    }
    assert.equal((await abortClean(root)).status, 'aborted');
    await assert.rejects(resumeClean(root), /no incomplete cleanup/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('release-archived frees media only after a verified outside archive, and restore-media brings it back', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'viscraft-release-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'viscraft-release-archive-'));
  try {
    await writeProject(root, project());
    await writeFile(path.join(root, 'scene.html'), scene('#c33'));
    const v0 = await buildProject(root);
    await writeFile(path.join(root, 'scene.html'), scene('#33c'));
    const v1 = await buildProject(root);
    const take = v1.takes[0];
    await writeProject(root, project(take.id));
    await buildProject(root);
    const takeArtifact = v1.artifacts.find(artifact => artifact.id === take.artifact)!;

    const archive = path.join(outside, 'clean.tar.gz');
    await archiveProject(root, archive);
    const inside = await archiveProject(root);

    await assert.rejects(releaseArchived(root, archive, []), /no "all"|--include/);
    await assert.rejects(releaseArchived(root, inside.path, [take.artifact]), /outside the Project/);
    const corrupt = path.join(outside, 'corrupt.tar.gz');
    const bytes = await readFile(archive);
    bytes[bytes.length - 20] ^= 0xff;
    await writeFile(corrupt, bytes);
    await assert.rejects(releaseArchived(root, corrupt, [take.artifact]));
    // The red v0 result is no longer in the current lineage, so the archive does not carry it.
    await assert.rejects(releaseArchived(root, archive, [v0.result!.artifact]), /does not hold/);
    assert.equal(await hashFile(path.join(root, takeArtifact.path)), takeArtifact.sha256, 'refusals free nothing');

    const released = await releaseArchived(root, archive, [take.artifact]);
    assert.deepEqual(
      released.released.map(item => item.artifact),
      [take.artifact],
    );
    await assert.rejects(lstat(path.join(root, takeArtifact.path)), /ENOENT/);
    assert.ok((await readdir(path.join(root, '.viscraft', 'archive-receipts'))).includes(`${released.archive}.json`));
    const records = await readBuilds(root);
    assert.ok(
      records.some(build => build.id === v1.id),
      'Build records stay',
    );
    assert.ok(
      records
        .flatMap(build => build.artifacts)
        .filter(artifact => artifact.id === take.artifact)
        .every(a => a.archived),
    );
    const plan = await planBuild(root);
    assert.ok(
      plan.blockers.some(issue => issue.code === 'archived-media'),
      'Plan says restore from the archive first',
    );
    await assert.rejects(buildProject(root), /restore-media/);

    const restored = await restoreMedia(root, archive);
    assert.deepEqual(
      restored.restored.map(item => item.artifact),
      [take.artifact],
    );
    assert.equal(await hashFile(path.join(root, takeArtifact.path)), takeArtifact.sha256);
    assert.ok((await readBuilds(root)).flatMap(build => build.artifacts).every(artifact => !artifact.archived));
    const again = await buildProject(root);
    assert.ok(
      again.operations.every(operation => operation.reused),
      'the restored media is reused',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
