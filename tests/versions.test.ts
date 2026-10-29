/**
 * `versions` / `keep` / `unkeep` / `revert` (checkpoint, rollback, resume,
 * abort) on a small deterministic code-authored project.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildProject } from '../src/build/build.js';
import { planBuild } from '../src/build/plan.js';
import { acquireLock, loadProject, validateProject } from '../src/project/project.js';
import { projectStatus } from '../src/project/status.js';
import { projectUsage } from '../src/project/usage.js';
import { contentPath } from '../src/project/content-store.js';
import {
  abortRevert,
  keepVersion,
  listVersions,
  resumeRevert,
  revertProject,
  setRevertApplyHookForTest,
  unkeepVersion,
} from '../src/project/versions.js';
import { hashFile } from '../src/shared/hash.js';
import { snapshotHashOf } from '../src/project/state.js';
import { productionClosure } from '../src/project/closure.js';
import { readBuilds } from '../src/project/build-records.js';
import type { BuildRecord, Project } from '../src/core/schema.js';

const scene = (color: string) => `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden}canvas{display:block}</style></head>
<body><canvas id="c"></canvas><script>
window.viscraft = { render(ctx) {
  const c = document.getElementById('c'); c.width = ctx.width; c.height = ctx.height;
  const g = c.getContext('2d'); g.fillStyle = '${color}'; g.fillRect(0, 0, ctx.width, ctx.height);
  g.fillStyle = '#fff'; g.fillRect(ctx.frame * 4 + Number(ctx.params.shift || 0), 2, 4, 4);
} };
</script></body></html>
`;

function project(): Project {
  return {
    schemaVersion: 1,
    id: 'versions_fixture',
    revision: 1,
    title: 'Versions fixture',
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
      placements: [{ id: 'pl', shot: 'shot', source: 'src', inFrame: 0, outFrame: 2, startFrame: 0, audio: 'mute' }],
      transitions: [],
      audio: [],
    },
    imageDocuments: [],
    imageTargets: [],
    soundTargets: [],
  };
}

async function writeProject(root: string, value: Project): Promise<void> {
  await writeFile(path.join(root, 'project.json'), `${JSON.stringify(value, null, 2)}\n`);
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

const resultSha = (record: BuildRecord) => record.artifacts.find(a => a.id === record.result?.artifact)!.sha256;

/** v1 (red) → v2 (blue scene) → v3 (params shift + an extra resource file). */
async function threeVersions(): Promise<{ root: string; builds: BuildRecord[] }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'viscraft-versions-'));
  await writeProject(root, project());
  await writeFile(path.join(root, 'scene.html'), scene('#c33'));
  const v1 = await buildProject(root);
  await writeFile(path.join(root, 'scene.html'), scene('#33c'));
  const v2 = await buildProject(root);
  const p3 = project();
  p3.sources[0] = { ...(p3.sources[0] as Extract<Project['sources'][number], { kind: 'browser'; output: 'picture' }>) };
  (p3.sources[0] as { params: Record<string, unknown>; resources: string[] }).params = { shift: 8 };
  (p3.sources[0] as { params: Record<string, unknown>; resources: string[] }).resources = ['extra.txt'];
  await writeFile(path.join(root, 'extra.txt'), 'v3 only\n');
  await writeProject(root, p3);
  const v3 = await buildProject(root);
  return { root, builds: [v1, v2, v3] };
}

async function authorBytes(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const file of ['scene.html', 'extra.txt']) out[file] = await hashFile(path.join(root, file));
  return out;
}

test('versions lists succeeded versions newest first with current/changes; keep protects, unkeep releases', async () => {
  const { root, builds } = await threeVersions();
  const [v1, v2, v3] = builds;
  try {
    const listed = await listVersions(root);
    assert.deepEqual(
      listed.versions.map(entry => entry.id),
      [v3.id, v2.id, v1.id],
    );
    assert.deepEqual(
      listed.versions.map(entry => entry.current),
      [true, false, false],
    );
    assert.ok(listed.versions[0].changesFromPrevious!.modified > 0);
    assert.ok(listed.versions[1].changesFromPrevious!.modified > 0);
    assert.equal(listed.versions[2].changesFromPrevious, null);
    assert.equal(listed.versions[2].result?.available, true);

    await keepVersion(root, v1.id, 'user liked the red pass');
    assert.equal((await listVersions(root)).versions[2].retained?.note, 'user liked the red pass');
    const usage = await projectUsage(root);
    assert.ok(usage.artifacts['protected-retained']?.files > 0, 'kept result is protected-retained');
    await unkeepVersion(root, v1.id);
    assert.equal((await listVersions(root)).versions[2].retained, null);
    await assert.rejects(keepVersion(root, 'build-missing'), /No Build record/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('revert → zero work, same result; revert <checkpoint> restores bytes; untouched kept', async () => {
  const { root, builds } = await threeVersions();
  const [v1, , v3] = builds;
  try {
    const before = await authorBytes(root);
    const revision = (await loadProject(root)).revision;
    const reverted = await revertProject(root, v1.id);
    assert.deepEqual(reverted.written, ['scene.html']);
    assert.deepEqual(reverted.untouched, ['extra.txt']);
    assert.equal(reverted.revision, revision + 1);
    assert.equal(await readFile(path.join(root, 'extra.txt'), 'utf8'), 'v3 only\n');
    const status = await projectStatus(root);
    assert.equal(status.current?.build, v3.id, 'revert never changes the current result');
    assert.equal(status.current?.authoring, 'changed');

    const plan = await planBuild(root);
    assert.equal(plan.work.length, 0, 'deterministic Source is reused');
    const rebuilt = await buildProject(root);
    assert.equal(resultSha(rebuilt), resultSha(v1));

    const undo = await revertProject(root, reverted.checkpoint);
    assert.deepEqual(undo.written.sort(), ['scene.html']);
    assert.deepEqual(await authorBytes(root), before);
    const restored = await loadProject(root);
    assert.deepEqual(restored.sources, (await loadProject(root)).sources);
    assert.deepEqual((restored.sources[0] as { params: unknown }).params, { shift: 8 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('incomplete target, mid-apply failure, interruption (resume/abort) and a held lock', async () => {
  const { root, builds } = await threeVersions();
  const [v1, v2] = builds;
  try {
    const before = await authorBytes(root);
    const projectBefore = await hashFile(path.join(root, 'project.json'));

    // A failure while applying rolls back to the checkpoint.
    setRevertApplyHookForTest(relative => {
      if (relative === 'project.json') throw new Error('injected');
    });
    await assert.rejects(revertProject(root, v1.id), /rolled back.*injected/);
    assert.deepEqual(await authorBytes(root), before);
    assert.equal(await hashFile(path.join(root, 'project.json')), projectBefore);

    // A simulated process death leaves the revert applying.
    setRevertApplyHookForTest(relative => {
      if (relative === 'project.json') throw Object.assign(new Error('killed'), { simulatedInterrupt: true });
    });
    await assert.rejects(revertProject(root, v1.id), /killed/);
    setRevertApplyHookForTest();
    const status = await projectStatus(root);
    assert.ok(status.attention.some(item => item.code === 'revert-incomplete'));
    await assert.rejects(buildProject(root), /incomplete/);
    await assert.rejects(revertProject(root, v2.id), /incomplete/);
    await abortRevert(root);
    assert.deepEqual(await authorBytes(root), before);
    assert.equal(await hashFile(path.join(root, 'project.json')), projectBefore);

    setRevertApplyHookForTest(relative => {
      if (relative === 'project.json') throw Object.assign(new Error('killed'), { simulatedInterrupt: true });
    });
    await assert.rejects(revertProject(root, v1.id), /killed/);
    setRevertApplyHookForTest();
    const resumed = await resumeRevert(root);
    assert.equal(resumed.status, 'complete');
    assert.equal(
      await hashFile(path.join(root, 'scene.html')),
      await hashFile(path.join(root, '.viscraft', 'snapshots', v1.id, 'scene.html')),
    );

    // A held build lock refuses.
    const release = await acquireLock(root, 'build');
    try {
      await assert.rejects(revertProject(root, v2.id), /locked/);
    } finally {
      await release();
    }

    // A target missing frozen bytes is refused with zero author writes.
    const now = await authorBytes(root);
    const frozen = JSON.parse(
      await readFile(path.join(root, '.viscraft', 'snapshots', `${v2.id}.inputs.json`), 'utf8'),
    ) as { files: Record<string, string> };
    await unlink(path.join(root, '.viscraft', 'snapshots', v2.id, 'scene.html'));
    await unlink(path.join(root, contentPath(frozen.files['scene.html'])));
    await assert.rejects(revertProject(root, v2.id), /missing the frozen bytes/);
    assert.deepEqual(await authorBytes(root), now);
  } finally {
    setRevertApplyHookForTest();
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * A sound programme is a first-class version of ITS target: it is listed with its
 * sample facts, it is the target's current result, and it is protected by the
 * production closure even though it never writes the film's `result.json`.
 */
test('a sound programme is a current version of its target and the film pointer stays untouched', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'viscraft-sound-versions-'));
  try {
    const soundProject: Project = {
      schemaVersion: 1,
      id: 'versions_sound',
      revision: 1,
      title: 'Sound versions fixture',
      direction: { intent: '', looks: [{ id: 'look', description: '' }], transitions: [] },
      assets: [],
      bindings: {},
      sources: [],
      imageDocuments: [],
      imageTargets: [],
      soundTargets: [
        {
          id: 'score',
          sampleRate: 48000,
          channels: 2,
          outputSamples: 4800,
          audio: [
            {
              id: 'bed',
              kind: 'asset',
              asset: 'bed',
              inSample: 0,
              startSample: 0,
              durationSamples: 4800,
              gain: 0.2,
              fadeInSamples: 0,
              fadeOutSamples: 0,
            },
          ],
        },
      ],
    };
    // One audio Asset the target mixes: its bytes are part of the programme's
    // identity, so editing them must make the old WAV stale.
    const wav = path.join(root, 'note.wav');
    await writeFile(wav, Buffer.from('RIFF-fake-wav-bytes'));
    const wavSha = await hashFile(wav);
    const asset = {
      id: 'bed',
      revision: 1,
      path: 'note.wav',
      sha256: wavSha,
      type: 'audio' as const,
      rights: { origin: 'test', license: 'CC0-1.0', redistributable: true },
      simulated: false,
    };
    soundProject.assets = [asset];
    const project = validateProject(soundProject);
    await writeProject(root, project);
    const artifactId = `artifact-${'a'.repeat(40)}`;
    const artifactRel = `.viscraft/artifacts/${artifactId}.wav`;
    await mkdir(path.dirname(path.join(root, artifactRel)), { recursive: true });
    await writeFile(path.join(root, artifactRel), await readFile(wav));

    const build = {
      schemaVersion: 1,
      id: `build-${'b'.repeat(36)}`,
      medium: 'sound',
      target: 'score',
      run: { id: `run-${'c'.repeat(36)}`, goal: 'Sound fixture' },
      plan: { operations: ['op-' + 'd'.repeat(32)] },
      revision: 1,
      snapshotHash: snapshotHashOf(project, { 'note.wav': wavSha }, []),
      status: 'succeeded',
      startedAt: '2026-02-01T00:00:00.000Z',
      finishedAt: '2026-02-01T00:00:01.000Z',
      operations: [
        {
          id: 'op-' + 'd'.repeat(32),
          kind: 'mix-audio',
          key: 'e'.repeat(64),
          inputs: [],
          artifact: artifactId,
          reused: false,
        },
      ],
      artifacts: [
        {
          id: artifactId,
          path: artifactRel,
          sha256: wavSha,
          kind: 'audio',
          simulated: true,
          operation: 'mix-audio',
          inputs: [],
          backend: 'viscraft-simulated/audio',
        },
      ],
      takes: [],
      result: { artifact: artifactId, simulated: true },
    };
    await writeJson(path.join(root, '.viscraft', 'builds', `${build.id}.json`), build);
    await writeJson(path.join(root, '.viscraft', 'snapshots', `${build.id}.project.json`), project);
    await writeJson(path.join(root, '.viscraft', 'snapshots', `${build.id}.inputs.json`), {
      files: { 'note.wav': wavSha },
      unavailable: [],
    });

    const listed = (await listVersions(root)).versions;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].medium, 'sound');
    assert.equal(listed[0].target, 'score');
    assert.equal(listed[0].current, true);
    assert.equal(listed[0].stale, false);
    assert.equal(listed[0].result?.frames, null, 'a sound result has no picture frame count');
    assert.deepEqual(listed[0].result?.audio, { samples: 4800, sampleRate: 48000, channels: 2 });

    const status = await projectStatus(root);
    assert.equal(status.current, null, 'a sound Build never becomes the film current result');
    assert.deepEqual(
      status.sounds.map(item => ({ target: item.target, samples: item.samples, rate: item.sampleRate })),
      [{ target: 'score', samples: 4800, rate: 48000 }],
    );

    // The newest programme of a target is protected by the shared closure, so a
    // clean/export can never free the delivered bytes.
    const closure = await productionClosure(root, project, await readBuilds(root), ['active-result']);
    assert.ok(closure.builds.has(build.id));
    assert.ok(closure.artifacts.has(artifactId));

    // Editing a fact the programme was built from (the mixed clip's gain) makes
    // the recorded WAV stale — the newest programme is NOT automatically current.
    const edited = structuredClone(project);
    edited.soundTargets[0].audio[0] = { ...edited.soundTargets[0].audio[0], gain: 0.9 } as never;
    Object.assign(edited.soundTargets[0], { outputSamples: 8820, sampleRate: 44100, channels: 1 });
    await writeProject(root, validateProject(edited));
    const afterEdit = (await listVersions(root)).versions[0];
    assert.equal(afterEdit.current, false, 'an edited target must not leave the old WAV current');
    assert.equal(afterEdit.stale, true);
    const editedStatus = await projectStatus(root);
    assert.equal(editedStatus.sounds[0]?.stale, true);
    assert.deepEqual(
      editedStatus.sounds.map(item => ({
        samples: item.samples,
        sampleRate: item.sampleRate,
        channels: item.channels,
      })),
      [{ samples: 4800, sampleRate: 48000, channels: 2 }],
      'the stale WAV keeps its frozen clocks after the target changes',
    );
    assert.match(editedStatus.next.join('\n'), /viscraft build \. --target <target>/);

    // Editing the mixed bytes has the same effect.
    await writeProject(root, project);
    await writeFile(wav, Buffer.from('RIFF-different-bytes'));
    const afterBytes = (await listVersions(root)).versions[0];
    assert.equal(afterBytes.current, false, 'edited audio bytes must not leave the old WAV current');
    await writeFile(wav, Buffer.from('RIFF-fake-wav-bytes'));
    assert.equal((await listVersions(root)).versions[0].current, true, 'restoring the facts restores current');
    await writeProject(root, validateProject(edited));
    await writeJson(path.join(root, '.viscraft', 'snapshots', `${build.id}.project.json`), edited);
    const tamperedStatus = (await projectStatus(root)).sounds[0];
    assert.equal(tamperedStatus.stale, true, 'an unverified snapshot cannot establish a current programme');
    assert.deepEqual(
      { samples: tamperedStatus.samples, sampleRate: tamperedStatus.sampleRate, channels: tamperedStatus.channels },
      { samples: null, sampleRate: null, channels: null },
    );
    const tamperedVersion = (await listVersions(root)).versions[0];
    assert.equal(tamperedVersion.current, false);
    assert.equal(tamperedVersion.stale, true);
    assert.equal(tamperedVersion.result?.audio, null);
    await unlink(path.join(root, '.viscraft', 'snapshots', `${build.id}.project.json`));
    const unknown = (await projectStatus(root)).sounds[0];
    assert.equal(unknown.available, true, 'the recorded WAV still exists without its snapshot');
    assert.equal(unknown.stale, true);
    assert.deepEqual(
      { samples: unknown.samples, sampleRate: unknown.sampleRate, channels: unknown.channels },
      { samples: null, sampleRate: null, channels: null },
      'unreadable frozen clocks are reported as unknown',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
