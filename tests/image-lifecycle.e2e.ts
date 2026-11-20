/**
 * Image versions are FIRST-CLASS versions.
 *
 * A still Build writes the same flat snapshot metadata a film Build does, so the
 * existing lifecycle works on it without a second image history:
 *  - `versions` lists a still with its target, current/stale from the target's
 *    own render key (never the film's `.viscraft/result.json`),
 *  - `keep` + `export --versions retained` carries an older accepted still (its
 *    Build record, standard snapshot metadata and real PNG),
 *  - `revert` restores the document that version was rendered from,
 *  - the production closure protects the newest still of every declared target,
 *    so `clean --include` cannot delete the current target (an older version is
 *    explicitly reclaimable),
 *  - editing an unrelated film source does not re-render the still,
 *  - a missing document resource marks the recorded still stale while its PNG
 *    stays available,
 *  - a removed target drops out of `status.stills`.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { renderImage } from '../src/build/image.js';
import { readBuild } from '../src/project/build-records.js';
import { reviewBuild } from '../src/operations/analysis/review.js';
import { planClean } from '../src/project/clean.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { validateProject } from '../src/project/project.js';
import { snapshotHashOf } from '../src/project/state.js';
import { hashFile, stableHash } from '../src/shared/hash.js';
import { projectStatus } from '../src/project/status.js';
import {
  abortRevert,
  keepVersion,
  listVersions,
  revertProject,
  setRevertApplyHookForTest,
  unkeepVersion,
} from '../src/project/versions.js';

const DOC = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="poster.css"></head>
<body><div id="card"><h1>FIRST CUT</h1><p>A still with a real edit history</p></div></body></html>`;
const CSS = `html,body{margin:0;width:120px;height:80px;overflow:hidden;background:#f2ead9}
#card{padding:10px;font-family:sans-serif;color:#2b2520}
h1{font-size:16px;margin:0 0 4px}p{margin:0;font-size:8px;color:#6f6558}`;
const FILM = `<!doctype html><html><body><canvas id="c" width="320" height="180"></canvas></body></html>`;

function project(documentRevision = 1, projectRevision = 1) {
  return {
    schemaVersion: 1,
    id: 'image-lifecycle',
    revision: projectRevision,
    title: 'Image lifecycle',
    direction: { intent: 'one accepted still', looks: [{ id: 'plain', description: 'plain' }], transitions: [] },
    assets: [],
    bindings: {},
    sources: [
      {
        id: 'film',
        kind: 'browser' as const,
        output: 'picture' as const,
        entry: 'film.html',
        resources: [],
        bindings: [],
        params: {},
        seed: 1,
        frames: 4,
      },
    ],
    composition: {
      output: { width: 320, height: 180, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene_main', description: 'one scene' }],
      shots: [{ id: 'shot_a', scene: 'scene_main', look: 'plain', intent: 'a shot', targetFrames: 4 }],
      placements: [
        { id: 'pl_a', shot: 'shot_a', source: 'film', inFrame: 0, outFrame: 4, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio: [],
    },
    imageDocuments: [{ id: 'poster', path: 'poster.html', resources: ['poster.css'], revision: documentRevision }],
    imageTargets: [
      {
        id: 'card',
        document: 'poster',
        width: 120,
        height: 80,
        scale: 2,
        format: 'png' as const,
        background: 'opaque' as const,
      },
    ],
  };
}

function pngSize(bytes: Buffer): { width: number; height: number } {
  assert.equal(bytes.toString('ascii', 1, 4), 'PNG', 'the bytes are a PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test('a still with a different recorded operation identity is not reused', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-image-cache-identity-'));
  const root = join(parent, 'project');
  await mkdir(root, { recursive: true });
  try {
    await writeFile(join(root, 'poster.html'), DOC);
    await writeFile(join(root, 'poster.css'), CSS);
    await writeFile(join(root, 'film.html'), FILM);
    await writeFile(join(root, 'project.json'), JSON.stringify(validateProject(project()), null, 2) + '\n');
    const old = await renderImage(root, { target: 'card' });

    // A successful record for different production inputs must not satisfy this request.
    const unmatchedKey = stableHash({ fixture: 'different capture inputs' });
    const record = JSON.parse(await readFile(join(root, '.viscraft', 'builds', `${old.build}.json`), 'utf8')) as {
      operations: Array<{ key: string }>;
    };
    record.operations[0].key = unmatchedKey;
    await writeFile(join(root, '.viscraft', 'builds', `${old.build}.json`), JSON.stringify(record, null, 2));

    const fresh = await renderImage(root, { target: 'card' });
    assert.equal(fresh.reused, false, 'a different production identity is not reused');
    assert.notEqual(fresh.build, old.build);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('still simulation provenance follows consumed Assets through rendering and reuse', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-image-provenance-'));
  try {
    await writeFile(join(root, 'poster.html'), DOC);
    await writeFile(join(root, 'poster.css'), CSS);
    await writeFile(join(root, 'unused.css'), 'body { color: red; }');
    await writeFile(join(root, 'film.html'), FILM);
    const draft = validateProject(project());
    draft.assets = await Promise.all(
      ['poster.css', 'unused.css'].map(async (file, index) => ({
        id: index === 0 ? 'style' : 'unused',
        revision: 1,
        path: file,
        sha256: await hashFile(join(root, file)),
        type: 'code' as const,
        simulated: index === 1,
        rights: { origin: 'local test fixture', license: 'CC0-1.0', redistributable: true },
      })),
    );
    await writeFile(join(root, 'project.json'), JSON.stringify(draft));
    const first = await renderImage(root, { target: 'card' });
    assert.equal(first.simulated, false, 'an unrelated simulated Asset does not taint the still');
    draft.assets[0].simulated = true;
    draft.revision += 1;
    await writeFile(join(root, 'project.json'), JSON.stringify(draft));
    const second = await renderImage(root, { target: 'card' });
    assert.equal(second.reused, false, 'a provenance edit cannot reuse an artifact labelled real');
    assert.equal(second.simulated, true);
    assert.deepEqual(pngSize(await readFile(join(root, second.path))), { width: 240, height: 160 });
    const record = await readBuild(root, second.build);
    assert.equal(record.result?.simulated, true);
    assert.equal(record.artifacts.find(artifact => artifact.id === second.artifact)?.simulated, true);
    const reused = await renderImage(root, { target: 'card' });
    assert.equal(reused.reused, true);
    assert.equal(reused.simulated, true);
    assert.equal(reused.artifact, second.artifact);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a still is a normal version: keep, interrupted revert, retained export, protection and stale source', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-image-lifecycle-'));
  const root = join(parent, 'project');
  await mkdir(root, { recursive: true });
  try {
    await writeFile(join(root, 'poster.html'), DOC);
    await writeFile(join(root, 'poster.css'), CSS);
    await writeFile(join(root, 'film.html'), FILM);
    await writeFile(join(root, 'project.json'), JSON.stringify(validateProject(project()), null, 2) + '\n');

    // ---- 1. A still Build writes the standard flat snapshot metadata -------
    const first = await renderImage(root, { target: 'card' });
    assert.equal(first.reused, false);
    assert.deepEqual(pngSize(await readFile(join(root, ...first.path.split('/')))), { width: 240, height: 160 });

    const firstRecord = await readBuild(root, first.build);
    const frozenProject = validateProject(
      JSON.parse(await readFile(join(root, '.viscraft', 'snapshots', `${first.build}.project.json`), 'utf8')),
    );
    const frozenInputs = JSON.parse(
      await readFile(join(root, '.viscraft', 'snapshots', `${first.build}.inputs.json`), 'utf8'),
    ) as { files: Record<string, string>; unavailable: [] };
    assert.equal(
      firstRecord.snapshotHash,
      snapshotHashOf(frozenProject, frozenInputs.files, frozenInputs.unavailable),
      'the still records the standard snapshot hash, not a render-only key',
    );
    assert.equal(firstRecord.target, 'card');

    // `review` analyses a film timeline; a still is never presented as a video
    // review, either by default or when named explicitly.
    await assert.rejects(() => reviewBuild(root), /no successful build with a film result/i);
    await assert.rejects(() => reviewBuild(root, first.build), /still-image Build/i);

    // ---- 2. versions reports the still by target, current from its own key -
    const listed = await listVersions(root);
    const firstEntry = listed.versions.find(entry => entry.id === first.build)!;
    assert.equal(firstEntry.target, 'card');
    assert.equal(firstEntry.stale, false);
    assert.equal(firstEntry.current, true, 'the film has no result, yet the target is current');
    assert.equal(firstEntry.result?.available, true);

    // ---- 3. A real edit makes a NEW still; the old one is stale history ----
    await writeFile(join(root, 'poster.html'), DOC.replace('FIRST CUT', 'SECOND CUT'));
    await writeFile(join(root, 'project.json'), JSON.stringify(validateProject(project(2, 2)), null, 2) + '\n');
    const second = await renderImage(root, { target: 'card' });
    assert.equal(second.reused, false);
    assert.notEqual(second.artifact, first.artifact);

    const afterEdit = await listVersions(root);
    const oldEntry = afterEdit.versions.find(entry => entry.id === first.build)!;
    const newEntry = afterEdit.versions.find(entry => entry.id === second.build)!;
    assert.equal(oldEntry.stale, true);
    assert.equal(oldEntry.current, false);
    assert.equal(newEntry.stale, false);
    assert.equal(newEntry.current, true);
    assert.ok(
      (newEntry.changesFromPrevious?.modified ?? 0) >= 2,
      'the diff against the previous still counts the document edit',
    );

    // The current target's Build is protected: it cannot be reclaimed even when
    // named explicitly.
    await assert.rejects(
      planClean(root, { include: [second.build] }),
      /protected \(image-result\)/,
      'clean --include refuses the current still target',
    );

    // ---- 4. keep an older accepted still and carry it explicitly -----------
    await keepVersion(root, first.build, 'approved first cut');
    assert.equal(
      (await listVersions(root)).versions.find(entry => entry.id === first.build)?.retained?.note,
      'approved first cut',
    );

    const exported = join(parent, 'handoff');
    const bundle = await exportProject(root, exported, { extraVersions: ['retained'] });
    assert.deepEqual(bundle.scope.requestedVersions, [first.build], 'the retained still is the requested version');
    assert.equal(bundle.scope.historyComplete, true);
    const exportedRecord = await readBuild(exported, first.build);
    assert.equal(exportedRecord.snapshotHash, firstRecord.snapshotHash);
    assert.deepEqual(
      pngSize(await readFile(join(exported, ...first.path.split('/')))),
      { width: 240, height: 160 },
      'the accepted PNG travels with its record',
    );
    assert.ok(
      (await readFile(join(exported, '.viscraft', 'snapshots', `${first.build}.project.json`), 'utf8')).length > 0,
      'the standard snapshot metadata travels too',
    );

    // ---- 5. revert restores the document that version was rendered from ----
    // Release the keep first: protection after the revert must come from the
    // target's CURRENT render key, not from `retained`.
    await unkeepVersion(root, first.build);
    setRevertApplyHookForTest(relative => {
      if (relative === 'project.json')
        throw Object.assign(new Error('interrupted before publishing the restored Project'), {
          simulatedInterrupt: true,
        });
    });
    try {
      await assert.rejects(() => revertProject(root, first.build), /interrupted before publishing/);
    } finally {
      setRevertApplyHookForTest();
    }
    const partialProject = await readFile(join(root, 'project.json'));
    const partialDocument = await readFile(join(root, 'poster.html'));
    await assert.rejects(() => renderImage(root, { target: 'card' }), /Revert .* is incomplete/);
    assert.deepEqual(await readFile(join(root, 'project.json')), partialProject);
    assert.deepEqual(await readFile(join(root, 'poster.html')), partialDocument);
    await abortRevert(root);
    const reverted = await revertProject(root, first.build);
    assert.ok(reverted.written.includes('poster.html'), 'revert writes the edited document back');
    assert.match(await readFile(join(root, 'poster.html'), 'utf8'), /FIRST CUT/);
    assert.equal(reverted.revision, 3);

    // After the revert the first cut is current again and the second is history.
    const afterRevert = await listVersions(root);
    assert.equal(afterRevert.versions.find(entry => entry.id === first.build)?.current, true);
    assert.equal(afterRevert.versions.find(entry => entry.id === second.build)?.stale, true);
    // status must report the SAME reusable Build a render would return, not the
    // newer-but-stale Build.
    const stillAfterRevert = (await projectStatus(root)).stills.find(still => still.target === 'card')!;
    assert.equal(stillAfterRevert.build, first.build);
    assert.equal(stillAfterRevert.stale, false);
    assert.equal(stillAfterRevert.artifact, first.artifact);

    // The reverted version is now the CURRENT still: its bytes are the key the
    // author state produces, so it is protected even though `keep` was released.
    await assert.rejects(
      planClean(root, { include: [first.build] }),
      /protected \(image-result\)/,
      'the target current after a revert cannot be reclaimed',
    );

    // The reverted bytes really reuse the recorded artifact (no new capture).
    const reused = await renderImage(root, { target: 'card' });
    assert.equal(reused.reused, true);
    assert.equal(reused.build, first.build);
    assert.equal(reused.artifact, first.artifact);

    // A default export made NOW carries the version the render actually reuses,
    // not the newer stale Build: status/versions/closure/export agree.
    const postRevertParent = await mkdtemp(join(tmpdir(), 'viscraft-image-post-revert-'));
    try {
      const postRevert = await exportProject(root, join(postRevertParent, 'project'));
      const firstRecordExists = await stat(join(postRevert.path, '.viscraft', 'builds', `${first.build}.json`)).then(
        () => true,
      );
      assert.equal(firstRecordExists, true, 'the current reusable Build is carried');
      assert.equal(
        await stat(join(postRevert.path, '.viscraft', 'builds', `${second.build}.json`))
          .then(() => true)
          .catch(() => false),
        false,
        'the newer stale Build is history, not the target current',
      );
      const revived = await renderImage(postRevert.path, { target: 'card' });
      assert.equal(revived.reused, true);
      assert.equal(revived.build, first.build);
      assert.equal(revived.artifact, first.artifact);
    } finally {
      await rm(postRevertParent, { recursive: true, force: true });
    }

    // An older, now-historical still is explicitly reclaimable by id.
    const historicalPlan = await planClean(root, { include: [second.build] });
    assert.ok(
      historicalPlan.items.some(item => item.reason === 'included-artifact' && item.path === second.path),
      'an unprotected older still is explicit include history',
    );

    // ---- 6. An unrelated film edit does not re-render the still ------------
    await writeFile(join(root, 'film.html'), FILM.replace('</body>', '<p>film edit</p></body>'));
    assert.equal((await renderImage(root, { target: 'card' })).reused, true, 'the still key ignores film sources');

    // ---- 7. An independent directory renders the carried current target ----
    const relocated = await renderImage(exported, { target: 'card' });
    assert.equal(relocated.reused, true, 'the exported Project carries the current still and its artifact');
    assert.equal(relocated.artifact, second.artifact);
    assert.deepEqual(pngSize(await readFile(join(exported, ...relocated.path.split('/')))), {
      width: 240,
      height: 160,
    });

    // ---- 8. A missing source resource is stale, not an unavailable result --
    const css = await readFile(join(root, 'poster.css'), 'utf8');
    await rm(join(root, 'poster.css'));
    const staleStill = (await projectStatus(root)).stills.find(still => still.target === 'card')!;
    assert.equal(staleStill.stale, true, 'a missing declared resource makes the still stale');
    assert.equal(staleStill.available, true, 'the recorded PNG itself is still there');
    await writeFile(join(root, 'poster.css'), css);

    // ---- 9. A removed target is no longer a current still ------------------
    const removed = project(1, 4);
    removed.imageTargets = [];
    await writeFile(join(root, 'project.json'), JSON.stringify(validateProject(removed), null, 2) + '\n');
    assert.deepEqual(
      (await projectStatus(root)).stills,
      [],
      'a Build for a target the Project no longer declares is history, not a current still',
    );
    const removedVersion = (await listVersions(root)).versions.find(entry => entry.id === first.build)!;
    assert.equal(removedVersion.stale, true);
    assert.equal(removedVersion.current, false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
