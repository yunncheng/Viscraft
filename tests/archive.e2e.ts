/**
 * Real, behaviour-level verification of the single-file project archive on a
 * genuine Browser + FFmpeg production.
 *
 * These tests prove the production path, not the mere existence of a symbol:
 *  - a real two-Source sounded Code work is Built, archived to one file, then
 *    restored into an unrelated directory that shares no inode with the source;
 *  - the restored project rebuilds with EVERY operation reused and reproduces
 *    the exact final movie bytes (the archive is a truthful project transport,
 *    not a screenshot of a result);
 *  - editing one Source's params re-renders exactly that Source while the other
 *    Source/Take and the sound mix are preserved;
 *  - a sound-only edit re-runs only the mix/final while every picture identity
 *    is preserved;
 *  - the edited project still delivers and re-archives, and the second restore
 *    rebuilds with all reuse again;
 *  - a simulated/test-only accepted Take restores without submitting a new job
 *    and keeps its simulated provenance separate from real Code/media quality;
 *  - a simulated provider failure still throws AFTER persisting a failed Build
 *    record and never replaces the previously active Result.
 *
 * Independent verification: the archive file is decoded here with the test's
 * own USTAR reader, restored media is hashed and probed separately, and the
 * simulated job store is queried directly. No subjective listening/viewing claim
 * is made.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import { archiveProject, restoreProject } from '../src/operations/delivery/archive.js';
import { buildProject } from '../src/build/build.js';
import { readBuilds } from '../src/project/build-records.js';
import { deliverProject } from '../src/operations/delivery/delivery.js';
import { loadProject, saveProject, validateProject } from '../src/project/project.js';
import { simulatedStatus } from '../src/backends/providers/simulated.js';
import { findBrowser } from '../src/backends/browser/capture.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { framesToSamples } from '../src/core/time.js';
import { probeMedia } from '../src/backends/media/probe.js';
import type { Project } from '../src/core/schema.js';
import { makeSignalAsset } from './audio-fixtures.js';

/** Minimal, self-contained CodeScene: a solid hue plus a moving block. */
const CODE_SCENE = `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;overflow:hidden;background:#111}canvas{display:block}</style></head>
<body><canvas id="scene"></canvas><script>
window.viscraft = {
  render(ctx) {
    const canvas = document.getElementById('scene');
    canvas.width = ctx.width; canvas.height = ctx.height;
    const g = canvas.getContext('2d');
    const hue = (Number(ctx.params.hue || 0) * 360 + ctx.frame * 12 + Number(ctx.params.shift || 0)) % 360;
    g.fillStyle = 'hsl(' + hue + ',65%,45%)';
    g.fillRect(0, 0, ctx.width, ctx.height);
    g.fillStyle = '#fff';
    g.fillRect(2 + ctx.frame * 8 + Number(ctx.params.shift || 0), 2, 6, 6);
  }
};
</script></body></html>
`;

const FPS30 = { numerator: 30, denominator: 1 };
const TOTAL_FRAMES = 150; // 5 s at 30 fps — a real sounded work (> 4 s of sound)
const SOUND_SAMPLES = framesToSamples(TOTAL_FRAMES, FPS30, 48000, 'ceil');

/** The registered audio signals used as the two worked beds. */
const BED = makeSignalAsset({
  id: 'bed',
  path: 'bed.wav',
  sampleRate: 48000,
  channels: 2,
  samples: SOUND_SAMPLES,
  frequency: 220,
});
const SIM_BED = makeSignalAsset({
  id: 'sim_bed',
  path: 'sim-bed.wav',
  sampleRate: 48000,
  channels: 2,
  samples: 4800,
  frequency: 330,
});

/** Two code Sources sharing one entry, differing only by params, over a registered signal bed. */
function twoSourceWork(): Project {
  return {
    schemaVersion: 1,
    id: 'archive-work',
    revision: 1,
    title: 'Archive Work',
    soundTargets: [],
    direction: {
      intent: 'two sources over a registered signal bed',
      looks: [{ id: 'look', description: 'identity' }],
      transitions: [],
    },
    assets: [BED.asset],
    bindings: {},
    sources: [
      {
        id: 'src_a',
        kind: 'browser',
        output: 'picture',
        entry: 'motion.html',
        resources: [],
        bindings: [],
        params: { shift: 0 },
        seed: 1,
        frames: 75,
      },
      {
        id: 'src_b',
        kind: 'browser',
        output: 'picture',
        entry: 'motion.html',
        resources: [],
        bindings: [],
        params: { shift: 60 },
        seed: 2,
        frames: 75,
      },
    ],
    composition: {
      output: { width: 64, height: 64, fps: FPS30, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene', description: 'two shots' }],
      shots: [
        { id: 'shot_a', scene: 'scene', look: 'look', intent: 'first source', targetFrames: 75 },
        { id: 'shot_b', scene: 'scene', look: 'look', intent: 'second source', targetFrames: 75 },
      ],
      placements: [
        { id: 'pl_a', shot: 'shot_a', source: 'src_a', inFrame: 0, outFrame: 75, startFrame: 0, audio: 'mute' },
        { id: 'pl_b', shot: 'shot_b', source: 'src_b', inFrame: 0, outFrame: 75, startFrame: 75, audio: 'mute' },
      ],
      transitions: [],
      audio: [
        {
          id: 'bed',
          kind: 'asset',
          asset: 'bed',
          inSample: 0,
          startSample: 0,
          durationSamples: SOUND_SAMPLES,
          gain: 0.2,
          fadeInSamples: 4800,
          fadeOutSamples: 4800,
        },
      ],
    },
    imageDocuments: [],
    imageTargets: [],
  } as Project;
}

/** One simulated/test-only Source; `behavior` selects success or a provider failure. */
function simulatedWork(attempt: string, behavior: 'success' | 'fail'): Project {
  return {
    schemaVersion: 1,
    id: 'archive-sim',
    revision: 1,
    title: 'Archive Sim',
    soundTargets: [],
    direction: { intent: '', looks: [{ id: 'look', description: '' }], transitions: [] },
    assets: [SIM_BED.asset],
    bindings: {},
    sources: [
      {
        id: 'gen',
        kind: 'simulated',
        prompt: 'archive e2e deterministic pattern',
        frames: 3,
        seed: 7,
        attempt,
        behavior,
      },
    ],
    composition: {
      output: { width: 64, height: 64, fps: FPS30, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene', description: '' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: '', targetFrames: 3 }],
      placements: [{ id: 'pl', shot: 'shot', source: 'gen', inFrame: 0, outFrame: 3, startFrame: 0, audio: 'mute' }],
      transitions: [],
      audio: [
        {
          id: 'sim_bed',
          kind: 'asset',
          asset: 'sim_bed',
          inSample: 0,
          startSample: 0,
          durationSamples: 4800,
          gain: 0.2,
          fadeInSamples: 200,
          fadeOutSamples: 4000,
        },
      ],
    },
    imageDocuments: [],
    imageTargets: [],
  } as Project;
}

async function tmp(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'viscraft-archive-e2e-'));
}
async function writeProject(root: string, project: Project): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'project.json'), `${JSON.stringify(validateProject(project), null, 2)}\n`);
  // A signal Asset is real authored audio: its file must exist beside the Project.
  for (const signal of [BED, SIM_BED])
    if (project.assets.some(asset => asset.path === signal.asset.path))
      await writeFile(path.join(root, signal.asset.path), signal.bytes);
}

/** Independent USTAR reader: list member names in order, without trusting the writer. */
function tarNames(gzipBytes: Buffer): string[] {
  const cstr = (buffer: Buffer, offset: number, length: number): string => {
    const nul = buffer.indexOf(0, offset);
    const stop = nul === -1 || nul > offset + length ? offset + length : nul;
    return buffer.toString('utf8', offset, stop);
  };
  const raw = gunzipSync(gzipBytes);
  const names: string[] = [];
  let offset = 0;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    let name = cstr(header, 0, 100);
    const prefix = cstr(header, 345, 155);
    if (prefix) name = `${prefix}/${name}`;
    const size = Number.parseInt(cstr(header, 124, 12).trim() || '0', 8);
    names.push(name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

const browserAvailable = await findBrowser().then(
  () => true,
  () => false,
);
const ffmpegAvailable = await runCommand('ffmpeg', ['-version']).then(
  () => true,
  () => false,
);
const codeE2eSkip =
  browserAvailable && ffmpegAvailable
    ? false
    : `needs a Chrome/Chromium browser and FFmpeg (browser=${browserAvailable}, ffmpeg=${ffmpegAvailable})`;
const simE2eSkip = ffmpegAvailable ? false : 'needs FFmpeg';

test(
  'a real sounded Code work archives, restores into an unrelated directory, reuses everything and keeps selective edits',
  { skip: codeE2eSkip },
  async () => {
    const authorParent = await tmp();
    const restoreParent = await tmp();
    try {
      const root = path.join(authorParent, 'authoring');
      await writeProject(root, twoSourceWork());
      await writeFile(path.join(root, 'motion.html'), CODE_SCENE);

      // --- 1. Real production build -----------------------------------------
      const build1 = await buildProject(root);
      assert.equal(build1.status, 'succeeded');
      assert.ok(build1.result, 'the source build must record a result');
      assert.equal(
        build1.artifacts.find(artifact => artifact.id === build1.result!.artifact)!.simulated,
        false,
        'real Code production is not simulated',
      );
      const finalArtifact = build1.artifacts.find(artifact => artifact.id === build1.result!.artifact)!;
      const finalBytes = await readFile(path.join(root, finalArtifact.path));
      const finalInfo = await probeMedia(path.join(root, finalArtifact.path));
      assert.equal(finalInfo.frames, TOTAL_FRAMES, 'the production really covers the authored timeline');
      assert.ok(finalInfo.audio, 'the production carries real audio');
      assert(
        Math.abs(finalInfo.audio!.duration - SOUND_SAMPLES / 48000) <= 1 / 48000,
        'the produced sound is at least the authored span',
      );
      const projectBytes = await readFile(path.join(root, 'project.json'));

      // --- 2. Archive --------------------------------------------------------
      const archive = path.join(authorParent, 'work.viscraft-archive');
      const archived = await archiveProject(root, archive);
      assert.equal(archived.path, archive);
      assert.equal(archived.sha256, await hashFile(archive));
      assert.equal(archived.compressedBytes, (await stat(archive)).size);
      assert.equal(archived.simulated, false, 'real Code production must not be reported as simulated');
      assert.ok(archived.files > 0 && archived.contentBytes > 0);
      const names = tarNames(await readFile(archive));
      assert.equal(names[0], '.viscraft/portable-manifest.json', 'the portable manifest is the first tar member');
      assert.equal(
        names.length,
        archived.files + 1,
        'the tar holds the manifest plus exactly the reported physical files',
      );
      // The source project and its produced movie are untouched by archiving.
      assert.deepEqual(await readFile(path.join(root, 'project.json')), projectBytes);
      assert.deepEqual(await readFile(path.join(root, finalArtifact.path)), finalBytes);

      // --- 3. Restore into an unrelated directory ---------------------------
      const restored = path.join(restoreParent, 'reopened');
      const restoredResult = await restoreProject(archive, restored);
      assert.equal(restoredResult.path, restored);
      assert.equal(restoredResult.simulated, false);
      assert.deepEqual(
        await readFile(path.join(restored, 'project.json')),
        projectBytes,
        'restored project.json is byte-identical',
      );
      assert.equal(
        await hashFile(path.join(restored, finalArtifact.path)),
        finalArtifact.sha256,
        'the produced movie survives the round-trip hash-identically',
      );
      assert.deepEqual(await readFile(path.join(restored, finalArtifact.path)), finalBytes);
      assert.equal(await hashFile(archive), archived.sha256, 'restore must not modify the archive');

      // --- 4. Baseline rebuild reuses every operation -----------------------
      const baseline = await buildProject(restored);
      assert.equal(baseline.status, 'succeeded');
      assert.ok(
        baseline.operations.every(operation => operation.reused),
        'the restored project must reuse every packaged operation',
      );
      assert.equal(
        baseline.result!.artifact,
        build1.result!.artifact,
        'the baseline rebuild reproduces the exact final artifact identity',
      );
      assert.deepEqual(
        await readFile(path.join(restored, finalArtifact.path)),
        finalBytes,
        'the reused baseline movie is byte-identical',
      );
      const originalTakes = new Map(build1.takes.map(take => [take.source, take.id] as const));
      const mixArtifact = build1.operations.find(operation => operation.kind === 'mix-audio')!.artifact;

      // --- 5. Edit one Source: exactly it re-renders, the rest is preserved --
      const beforeEdit = await loadProject(restored);
      const edited = structuredClone(beforeEdit);
      const sourceB = edited.sources.find(source => source.id === 'src_b');
      if (!sourceB || sourceB.kind !== 'browser') throw new Error('expected code source src_b');
      sourceB.params = { ...sourceB.params, shift: 123 };
      await saveProject(restored, edited, beforeEdit.revision);
      const editBuild = await buildProject(restored);
      const codeOps = editBuild.operations.filter(operation => {
        const artifact = editBuild.artifacts.find(a => a.id === operation.artifact);
        return artifact?.operation === 'browser' && artifact.kind === 'video';
      });
      assert.equal(codeOps.filter(operation => !operation.reused).length, 1, 'exactly one Source re-renders');
      assert.equal(codeOps.filter(operation => operation.reused).length, 1, 'the untouched Source is reused');
      assert.equal(
        editBuild.takes.find(take => take.source === 'src_a')!.id,
        originalTakes.get('src_a'),
        'the untouched Source Take is preserved',
      );
      assert.equal(
        editBuild.operations.find(operation => operation.kind === 'mix-audio')!.reused,
        true,
        'a picture-only edit reuses the sound mix',
      );
      assert.equal(
        editBuild.operations.find(operation => operation.kind === 'mix-audio')!.artifact,
        mixArtifact,
        'the sound mix identity is preserved',
      );

      // --- 6. Sound-only edit: pictures are preserved -----------------------
      const beforeSound = await loadProject(restored);
      const soundEdit = structuredClone(beforeSound);
      soundEdit.composition!.audio = soundEdit.composition!.audio.map(clip =>
        clip.id === 'bed' ? { ...clip, gain: 0.33 } : clip,
      );
      await saveProject(restored, soundEdit, beforeSound.revision);
      const soundBuild = await buildProject(restored);
      for (const kind of ['browser', 'compose-video']) {
        assert.equal(
          soundBuild.operations.find(operation => operation.kind === kind)!.reused,
          true,
          `${kind} must reuse on a sound-only edit`,
        );
      }
      assert.equal(
        soundBuild.operations.find(operation => operation.kind === 'mix-audio')!.reused,
        false,
        'a sound edit must rerun the mix',
      );
      assert.equal(
        soundBuild.operations.find(operation => operation.kind === 'mux-final')!.reused,
        false,
        'a sound edit must rerun the final mux',
      );
      assert.deepEqual(
        soundBuild.takes.map(take => take.id).sort(),
        editBuild.takes.map(take => take.id).sort(),
        'every picture Take identity is preserved',
      );
      const editedFinal = soundBuild.artifacts.find(artifact => artifact.id === soundBuild.result!.artifact)!;
      const editedFinalHash = await hashFile(path.join(restored, editedFinal.path));

      // --- 7. The edited project still delivers -----------------------------
      const delivery = await deliverProject(restored, path.join(restoreParent, 'delivery'), {});
      assert.equal(delivery.build, soundBuild.id);
      assert.equal(delivery.simulated, false);
      assert.equal(
        await hashFile(path.join(restoreParent, 'delivery', 'movie', 'final.mp4')),
        delivery.movie!.sha256,
        'the delivered movie is the edited active result',
      );
      const deliveredReopen = await buildProject(path.join(restoreParent, 'delivery', 'project'));
      assert.ok(
        deliveredReopen.operations.every(operation => operation.reused),
        'the delivered editable project reopens with full reuse',
      );

      // --- 8. Re-archive the edited project and reopen it again -------------
      const archive2 = path.join(authorParent, 'work2.viscraft-archive');
      await archiveProject(restored, archive2);
      const reopened2 = path.join(restoreParent, 'reopened2');
      const restored2 = await restoreProject(archive2, reopened2);
      assert.equal(restored2.simulated, false);
      const finalBuild = await buildProject(reopened2);
      assert.ok(
        finalBuild.operations.every(operation => operation.reused),
        'the re-archived edited project reuses every operation',
      );
      assert.equal(
        finalBuild.result!.artifact,
        soundBuild.result!.artifact,
        'the reopened edited result identity is preserved',
      );
      assert.equal(
        await hashFile(path.join(reopened2, editedFinal.path)),
        editedFinalHash,
        'the reopened edited movie bytes are intact',
      );
      assert.equal(
        (await loadProject(reopened2)).composition!.audio.find(clip => clip.id === 'bed')!.gain,
        0.33,
        'the sound-only edit persists across re-archive',
      );
    } finally {
      await rm(authorParent, { recursive: true, force: true });
      await rm(restoreParent, { recursive: true, force: true });
    }
  },
);

test(
  'a simulated accepted Take restores without a new job and keeps its simulated provenance',
  { skip: simE2eSkip },
  async () => {
    const authorParent = await tmp();
    const restoreParent = await tmp();
    try {
      const root = path.join(authorParent, 'authoring');
      await writeProject(root, simulatedWork('archive_ok', 'success'));

      const build1 = await buildProject(root);
      assert.equal(build1.status, 'succeeded');
      assert.equal(build1.result!.simulated, true, 'simulated provenance is explicit');
      assert.equal((await simulatedStatus(root)).length, 1, 'the first build submits exactly one simulated job');

      const archive = path.join(authorParent, 'sim.viscraft-archive');
      const archived = await archiveProject(root, archive);
      assert.equal(archived.simulated, true, 'the package must report simulated provenance');

      const restored = path.join(restoreParent, 'reopened');
      const restoredResult = await restoreProject(archive, restored);
      assert.equal(restoredResult.simulated, true);
      // Simulated provider request/job state carries request identity and is not packaged.
      assert.equal((await simulatedStatus(restored)).length, 0, 'job state must not be packaged');

      const build2 = await buildProject(restored);
      assert.equal(build2.status, 'succeeded');
      assert.ok(
        build2.operations.every(operation => operation.reused),
        'the restored simulated work reuses every accepted operation',
      );
      assert.equal(
        build2.result!.artifact,
        build1.result!.artifact,
        'the accepted Take/artifact identity is preserved',
      );
      assert.equal(
        build2.artifacts.find(artifact => artifact.id === build2.result!.artifact)!.simulated,
        true,
        'simulated provenance is preserved, never upgraded to real',
      );
      assert.equal(
        (await simulatedStatus(restored)).length,
        0,
        'reusing an accepted simulated Take must not submit a new job',
      );
    } finally {
      await rm(authorParent, { recursive: true, force: true });
      await rm(restoreParent, { recursive: true, force: true });
    }
  },
);

test(
  'a simulated provider failure throws after persisting a failed Build and preserves the active Result',
  { skip: simE2eSkip },
  async () => {
    const root = await tmp();
    try {
      await writeProject(root, simulatedWork('archive_ok', 'success'));
      const accepted = await buildProject(root);
      assert.equal(accepted.status, 'succeeded');
      const activeBytes = await readFile(path.join(root, '.viscraft', 'result.json'));

      // A new attempt with behavior=fail reaches a permanent simulated failure.
      const failing = structuredClone(await loadProject(root));
      const source = failing.sources.find(candidate => candidate.id === 'gen');
      if (!source || source.kind !== 'simulated') throw new Error('expected the simulated source');
      source.attempt = 'archive_bad';
      source.behavior = 'fail';
      await saveProject(root, failing, failing.revision);

      await assert.rejects(buildProject(root), /failed|simulated provider failure/i);
      assert.deepEqual(
        await readFile(path.join(root, '.viscraft', 'result.json')),
        activeBytes,
        'a failed build must not replace the active Result',
      );

      const history = await readBuilds(root);
      const failed = history.find(build => build.status === 'failed');
      assert.ok(failed, 'the failed attempt must be persisted as a failed Build record');
      assert.equal(failed!.result, undefined, 'a failed Build records no result');

      // The previously accepted Take still rebuilds with full reuse.
      const revert = structuredClone(await loadProject(root));
      const revertSource = revert.sources.find(candidate => candidate.id === 'gen');
      if (!revertSource || revertSource.kind !== 'simulated') throw new Error('expected the simulated source');
      revertSource.attempt = 'archive_ok';
      revertSource.behavior = 'success';
      await saveProject(root, revert, revert.revision);
      const rebuilt = await buildProject(root);
      assert.ok(
        rebuilt.operations.every(operation => operation.reused),
        'the accepted Take survives a sibling failure',
      );
      assert.equal(rebuilt.result!.artifact, accepted.result!.artifact);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
