/**
 * End-to-end framing regression: a flat, licensed video Asset reauthored as a
 * portrait deliverable through the *normal* `buildProject` pipeline.
 *
 * One real source asset (H.264/AAC, 96x54) is reframed into a 60x120 portrait
 * composition, trimmed to a 20-frame placement with its source audio kept:
 *
 *  - the Build succeeds with real pixels + audio, marked NOT simulated;
 *  - an unchanged rebuild reuses every operation/artifact;
 *  - changing `Placement.framing` re-runs only the media normalization and
 *    yields genuinely different bytes;
 *  - a failing edit (placement beyond the Take) keeps the active result.json;
 *  - `deliverProject` bundles the movie + an editable project export that
 *    reopens as a disposable copy and re-delivers with no generation provider.
 *
 * Requires real FFmpeg (see `viscraft doctor`); no browser or provider is used.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { buildProject } from '../src/build/build.js';
import { deliverProject } from '../src/operations/delivery/delivery.js';
import { loadProject, saveProject } from '../src/project/project.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { ProjectSchema, type MediaFraming, type Project } from '../src/core/schema.js';

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-reframe-e2e-'));
  try {
    await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function writeProject(root: string, project: Project): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    nodePath.join(root, 'project.json'),
    JSON.stringify(ProjectSchema.parse(project), null, 2) + '\n',
    'utf8',
  );
}

/** A real 96x54 H.264/AAC fixture, ~1s at 25fps, used as a licensed flat Asset. */
async function makeFlatVideo(root: string, name: string): Promise<string> {
  const out = nodePath.join(root, name);
  await runCommand('ffmpeg', [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-filter_threads',
    '1',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=96x54:rate=25:duration=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=1',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-r',
    '25',
    '-threads',
    '2',
    '-c:a',
    'aac',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-shortest',
    out,
  ]);
  return out;
}

/** A portrait composition that keeps a trimmed window of the flat source audio. */
function flatMediaProject(assetSha: string, framing: MediaFraming): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'reframe_flat_media',
    revision: 1,
    title: 'Reframed flat media',
    direction: {
      intent: 'reauthor a flat clip as a portrait cut',
      looks: [{ id: 'look_main', description: 'as captured' }],
      transitions: [],
    },
    assets: [
      {
        id: 'asset_flat',
        revision: 1,
        type: 'video',
        path: 'flat.mp4',
        sha256: assetSha,
        rights: { origin: 'original test fixture', license: 'original test media', redistributable: true },
        simulated: false,
      },
    ],
    bindings: {},
    sources: [],
    composition: {
      output: { width: 60, height: 120, fps: { numerator: 25, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene_1', description: 'flat' }],
      shots: [{ id: 'shot_1', scene: 'scene_1', look: 'look_main', intent: 'reframe', targetFrames: 20 }],
      placements: [
        {
          id: 'pl_1',
          shot: 'shot_1',
          asset: 'asset_flat',
          framing,
          inFrame: 0,
          outFrame: 20,
          startFrame: 0,
          audio: 'keep',
        },
      ],
      transitions: [],
      audio: [],
    },
  });
}

async function readFraming(root: string): Promise<MediaFraming | undefined> {
  const project = await loadProject(root);
  const placement = project.composition!.placements.find(candidate => candidate.id === 'pl_1');
  if (!placement) throw new Error('expected the placement');
  return placement.framing;
}

test('flat licensed media Asset reframes to a sounded portrait through normal Build and delivers a disposable export', async () => {
  await withRoot(async root => {
    const dir = nodePath.join(root, 'authoring');
    await fs.mkdir(dir, { recursive: true });
    const videoPath = await makeFlatVideo(dir, 'flat.mp4');
    const sha = await hashFile(videoPath);

    await writeProject(dir, flatMediaProject(sha, { fit: 'cover', position: { x: 0, y: 0.5 } }));

    // 1. A normal Build reframes + trims the real media with its audio kept.
    const first = await buildProject(dir);
    assert.equal(first.status, 'succeeded');
    assert.equal(first.result!.simulated, false, 'a pure media build is not simulated');
    const final1 = first.artifacts.find(artifact => artifact.id === first.result!.artifact)!;
    assert.equal(final1.media!.width, 60, 'the delivered raster is portrait');
    assert.equal(final1.media!.height, 120);
    assert.equal(final1.media!.frames, 20, 'the placement is trimmed to 20 frames');
    assert.ok(final1.media!.audio, 'the kept source audio must survive the Build');
    assert.equal(first.operations.find(operation => operation.kind === 'normalize-media')!.reused, false);
    assert.ok(
      first.takes.some(take => take.medium === 'picture' && take.frames === 25),
      'the full-source Take is available before trimming',
    );

    // The kept audio carries real non-silent PCM energy (a measured RMS, not a
    // subjective listening judgement).
    const pcmPath = nodePath.join(dir, 'final.f32le');
    await runCommand('ffmpeg', [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-i',
      nodePath.join(dir, final1.path),
      '-vn',
      '-f',
      'f32le',
      '-acodec',
      'pcm_f32le',
      pcmPath,
    ]);
    const pcm = await fs.readFile(pcmPath);
    let energy = 0;
    const measured = Math.min(4800, pcm.length / 8);
    for (let sample = 0; sample < measured; sample++) energy += pcm.readFloatLE(sample * 8) ** 2;
    const rms = Math.sqrt(energy / measured);
    assert.ok(rms > 0.01, `the final PCM must carry measured non-silent energy, got RMS ${rms.toFixed(4)}`);

    // 2. An unchanged rebuild reuses every operation and artifact.
    const second = await buildProject(dir);
    assert.ok(
      second.operations.every(operation => operation.reused),
      'an unchanged flat-media rebuild reuses everything',
    );
    assert.equal(second.result!.artifact, first.result!.artifact);

    // 3. Changing the framing really re-normalizes the media into new pixels.
    const current = await loadProject(dir);
    const edited = structuredClone(current);
    const editedPlacement = edited.composition!.placements.find(candidate => candidate.id === 'pl_1');
    if (!editedPlacement) throw new Error('expected the placement');
    editedPlacement.framing = { fit: 'contain', background: '#101020', position: { x: 1, y: 1 } };
    await saveProject(dir, edited, current.revision);

    const third = await buildProject(dir);
    assert.equal(
      third.operations.find(operation => operation.kind === 'normalize-media')!.reused,
      false,
      'changed framing must re-run media normalization',
    );
    const final3 = third.artifacts.find(artifact => artifact.id === third.result!.artifact)!;
    assert.notEqual(final3.sha256, final1.sha256, 'a real framing change must produce different bytes');
    assert.equal(final3.media!.width, 60);
    assert.equal(final3.media!.height, 120);

    // 4. A failing edit keeps the active result.json byte-for-byte. The overlarge
    //    interval is now a KNOWN error: the direct video Asset's real length is
    //    probed, so the shared placement preflight rejects it BEFORE any capture,
    //    naming the normalized Asset rather than the later per-Take guard.
    const resultPath = nodePath.join(dir, '.viscraft', 'result.json');
    const before = await fs.readFile(resultPath, 'utf8');
    const invalid = structuredClone(await loadProject(dir));
    invalid.composition!.placements[0].outFrame = 9999;
    await writeProject(dir, invalid);
    await assert.rejects(buildProject(dir), /reads frames \[0, 9999\) beyond the normalized video Asset/);
    assert.equal(await fs.readFile(resultPath, 'utf8'), before, 'a failed build must keep the active result');

    // 5. Restore the valid portrait framing, rebuild, then deliver.
    const broken = await loadProject(dir);
    const restored = structuredClone(broken);
    restored.composition!.placements[0].outFrame = 20;
    await saveProject(dir, restored, broken.revision);
    const fourth = await buildProject(dir);
    assert.equal(fourth.status, 'succeeded');

    const destination = nodePath.join(root, 'bundle');
    const delivery = await deliverProject(dir, destination, { review: true, stems: true });
    assert.equal(delivery.build, fourth.id);
    assert.equal(delivery.playable, null, 'a flat-media project has no playable package to bundle');
    assert.equal(await hashFile(nodePath.join(destination, 'movie', 'final.mp4')), delivery.movie!.sha256);
    assert.deepEqual(await readFraming(nodePath.join(destination, 'project')), {
      fit: 'contain',
      background: '#101020',
      position: { x: 1, y: 1 },
    });

    // 6. The editable export reopens as a disposable copy and re-delivers with
    //    no generation provider in play at any point.
    const disposable = nodePath.join(root, 'disposable');
    await fs.cp(nodePath.join(destination, 'project'), disposable, { recursive: true });
    const reopened = await loadProject(disposable);
    assert.equal(reopened.sources.length, 0, 'a direct-asset export carries no Sources and needs no provider');
    assert.deepEqual(await readFraming(disposable), {
      fit: 'contain',
      background: '#101020',
      position: { x: 1, y: 1 },
    });

    const rebuilt = await buildProject(disposable);
    assert.ok(
      rebuilt.operations.every(operation => operation.reused),
      'exported project must actually rebuild with full operation reuse',
    );
    assert.equal(
      rebuilt.artifacts.find(artifact => artifact.id === rebuilt.result!.artifact)!.sha256,
      delivery.movie!.sha256,
    );
    const disposableDestination = nodePath.join(root, 'disposable-bundle');
    const again = await deliverProject(disposable, disposableDestination, { review: true, stems: true });
    assert.equal(again.playable, null);
    assert.equal(
      await hashFile(nodePath.join(disposableDestination, 'movie', 'final.mp4')),
      delivery.movie!.sha256,
      'the disposable copy re-delivers the same movie',
    );
    assert.deepEqual(await readFraming(nodePath.join(disposableDestination, 'project')), {
      fit: 'contain',
      background: '#101020',
      position: { x: 1, y: 1 },
    });
  });
});
