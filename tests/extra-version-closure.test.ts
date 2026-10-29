/**
 * An explicitly carried extra version brings its RECURSIVE delivery
 * closure with it.
 *
 * A requested extra Build must carry its transitive dependencies as well as
 * its own record, snapshot and artifacts. The fixture uses the chain
 *
 *   Build A (video with audio) → extractAudio → Asset `vo`
 *     → Build B (programme mixing `vo`) → swap material → Build C (active)
 *     → carry B
 *
 * B's frozen `vo` Asset derives from A, so carrying B must include A's record,
 * snapshot and Artifact even though C is the active Result. The receiver must
 * be able to restore and rebuild B without the sender's workspace.
 *
 * Real FFmpeg/FFprobe only (no browser, no provider). Every assertion is about
 * observable facts: the carried lineage is physically present and hash-exact,
 * `requestedVersions` stays the caller's explicit selection, and the restored
 * package can revert to B and rebuild it.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { extractAudio } from '../src/operations/assets/audio-extract.js';
import { buildProject } from '../src/build/build.js';
import { ProjectSchema, type Project } from '../src/core/schema.js';
import { atomicJson } from '../src/shared/fs.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { loadProject, saveProject, validateProject } from '../src/project/project.js';
import { revertProject } from '../src/project/versions.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { archiveProject, restoreProject } from '../src/operations/delivery/archive.js';

const FPS = { numerator: 25, denominator: 1 };
const FRAMES = 50; // 2 s at 25 fps
const SAMPLE_RATE = 48000;

const PUBLIC_RIGHTS = {
  origin: 'fixture take audio, cleared for redistribution',
  license: 'CC0-1.0',
  redistributable: true,
};

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-extra-version-'));
}

async function ffmpeg(args: string[]): Promise<void> {
  await runCommand('ffmpeg', [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-loglevel',
    'error',
    '-threads',
    '2',
    '-filter_threads',
    '1',
    ...args,
  ]);
}

function baseProject(id: string): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id,
    revision: 1,
    title: 'Extra-version closure fixture',
    direction: { intent: 'test', looks: [{ id: 'look_main', description: 'main' }], transitions: [] },
    assets: [],
    bindings: {},
    sources: [],
    composition: {
      output: { width: 64, height: 48, fps: FPS, sampleRate: SAMPLE_RATE, channels: 2 },
      scenes: [{ id: 'scene_1', description: 'scene' }],
      shots: [{ id: 'shot_1', scene: 'scene_1', look: 'look_main', intent: 'shot', targetFrames: FRAMES }],
      placements: [],
      transitions: [],
      audio: [],
    },
  });
}

/** A real video asset carrying a real audio track, normalized by a real Build. */
async function writeClip(root: string, name: string, toneHz: number): Promise<{ path: string; sha256: string }> {
  const clipPath = nodePath.join(root, 'assets', name);
  await fs.mkdir(nodePath.dirname(clipPath), { recursive: true });
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=64x48:rate=25:duration=${FRAMES / 25}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${toneHz}:sample_rate=${SAMPLE_RATE}:duration=${FRAMES / 25}`,
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-frames:v',
    String(FRAMES),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-shortest',
    clipPath,
  ]);
  return { path: `assets/${name}`, sha256: await hashFile(clipPath) };
}

async function audioMediaProject(root: string): Promise<Project> {
  const clip = await writeClip(root, 'clip.mp4', 440);
  const project = baseProject('extra_version_closure');
  project.assets = [
    {
      id: 'clip',
      revision: 1,
      path: clip.path,
      sha256: clip.sha256,
      type: 'video',
      rights: PUBLIC_RIGHTS,
      simulated: false,
    },
  ];
  project.composition!.placements = [
    { id: 'place_1', shot: 'shot_1', asset: 'clip', inFrame: 0, outFrame: FRAMES, startFrame: 0, audio: 'keep' },
  ];
  return validateProject(project);
}

const manifestOf = async (destination: string): Promise<Record<string, any>> =>
  JSON.parse(await fs.readFile(nodePath.join(destination, '.viscraft', 'portable-manifest.json'), 'utf8'));

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = nodePath.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else out.push(nodePath.relative(base, full).split(nodePath.sep).join('/'));
  }
  return out;
}

/**
 * Build the three-Build chain and return the ids/artifacts the assertions need.
 * After this the ACTIVE result is Build C and the current project no longer
 * registers `vo`, so only the carried Build B's frozen snapshot still reaches A.
 */
async function buildChain(root: string): Promise<{
  buildA: { id: string; artifact: string; artifactPath: string; sha256: string };
  buildB: { id: string };
  buildC: { id: string };
}> {
  await atomicJson(nodePath.join(root, 'project.json'), await audioMediaProject(root));

  // Build A: the normalized video with its real audio stream.
  const buildA = await buildProject(root);
  const takeA = buildA.takes.find(item => item.asset === 'clip')!;
  assert.ok(takeA, 'Build A must register a Take for the video asset');
  const artifactA = buildA.artifacts.find(item => item.id === takeA.artifact)!;
  assert.ok(artifactA.media?.audio, 'Build A artifact must carry an audio stream');

  // A → extract audio → Asset `vo` (recorded parent = Build A / its artifact).
  await extractAudio(root, {
    take: takeA.id,
    assetId: 'vo',
    rights: PUBLIC_RIGHTS,
    expectedRevision: (await loadProject(root)).revision,
    streamIndex: 0,
  });

  // Build B: place the extracted audio as a programme clip and rebuild. B's
  // frozen snapshot therefore contains `vo` with its derivation parent A.
  const beforeB = await loadProject(root);
  const sampleRate = artifactA.media!.audio!.sampleRate;
  beforeB.composition!.audio = [
    {
      id: 'clip_audio',
      kind: 'asset',
      asset: 'vo',
      inSample: 0,
      startSample: 0,
      durationSamples: sampleRate,
      gain: 1,
      fadeInSamples: 0,
      fadeOutSamples: 0,
    },
  ];
  await saveProject(root, beforeB, beforeB.revision);
  const buildB = await buildProject(root);
  assert.equal(buildB.status, 'succeeded', 'Build B (programme mixing the extracted audio) must build');

  // Swap material: register a DIFFERENT video (distinct bytes → distinct
  // normalize artifact), point the placement at it, drop `vo` and the audio clip,
  // then Build C as the new active result. Now neither `vo` nor any A/B artifact
  // is reachable from C: the `derived` root can no longer reach A, and C shares no
  // Artifact with A — only carrying B's frozen closure can bring A.
  const clip2 = await writeClip(root, 'clip2.mp4', 660);
  const beforeC = await loadProject(root);
  beforeC.assets = [
    ...beforeC.assets.filter(asset => asset.id !== 'vo'),
    {
      id: 'clip2',
      revision: 1,
      path: clip2.path,
      sha256: clip2.sha256,
      type: 'video',
      rights: PUBLIC_RIGHTS,
      simulated: false,
    },
  ];
  beforeC.composition!.placements = [
    { id: 'place_1', shot: 'shot_1', asset: 'clip2', inFrame: 0, outFrame: FRAMES, startFrame: 0, audio: 'keep' },
  ];
  beforeC.composition!.audio = [];
  await saveProject(root, beforeC, beforeC.revision);
  const buildC = await buildProject(root);
  assert.equal(buildC.status, 'succeeded');
  assert.ok(
    !(await loadProject(root)).assets.some(asset => asset.id === 'vo'),
    'the material swap must remove `vo` from the current project',
  );

  return {
    buildA: {
      id: buildA.id,
      artifact: artifactA.id,
      artifactPath: artifactA.path,
      sha256: artifactA.sha256,
    },
    buildB: { id: buildB.id },
    buildC: { id: buildC.id },
  };
}

test('a carried extra version brings its recursive parent Build, snapshot and artifact', async () => {
  const root = await tempRoot();
  const parent = await tempRoot();
  try {
    const { buildA, buildB } = await buildChain(root);
    const destination = nodePath.join(parent, 'exported');
    const result = await exportProject(root, destination, { extraVersions: [buildB.id] });

    // The caller's explicit selection is recorded, and only that.
    assert.deepEqual(result.scope.requestedVersions, [buildB.id]);

    const manifest = await manifestOf(destination);
    // The requested Build AND the parent it derives from are both carried.
    assert.ok(manifest.builds.includes(buildB.id), 'the requested Build must be carried');
    assert.ok(manifest.builds.includes(buildA.id), 'the recursive parent Build must be carried');
    assert.equal(manifest.scope.counts.builds, manifest.builds.length);
    assert.equal(manifest.scope.counts.artifacts, manifest.artifacts.length);

    const files = await listFiles(destination);
    for (const relative of [
      `.viscraft/builds/${buildA.id}.json`,
      `.viscraft/snapshots/${buildA.id}.project.json`,
      `.viscraft/snapshots/${buildA.id}.inputs.json`,
      buildA.artifactPath,
    ])
      assert.ok(files.includes(relative), `expected the parent lineage to carry ${relative}`);

    // The carried parent Artifact bytes are the real, hash-verified bytes.
    const entry = manifest.files.find((file: { path: string }) => file.path === buildA.artifactPath);
    assert.ok(entry, 'the parent Artifact must be listed in the manifest');
    assert.equal(entry.sha256, buildA.sha256);
    assert.equal(await hashFile(nodePath.join(destination, ...buildA.artifactPath.split('/'))), buildA.sha256);

    // The extracted audio Asset rides along (B's frozen snapshot references it).
    assert.ok(
      manifest.snapshotAssets.some((asset: { provenance: { assetId?: string } }) => asset.provenance.assetId === 'vo'),
      'the derived audio Asset from the carried version must be present',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('a restored package can revert to the carried version and rebuild it', async () => {
  const root = await tempRoot();
  const parent = await tempRoot();
  try {
    const { buildA, buildB } = await buildChain(root);

    // Carry B in an archive, then restore it into an independent directory.
    const archive = nodePath.join(parent, 'extra.viscraft-archive');
    await archiveProject(root, archive, { extraVersions: [buildB.id] });
    const restored = nodePath.join(parent, 'restored');
    await restoreProject(archive, restored);

    const restoredManifest = await manifestOf(restored);
    assert.deepEqual(restoredManifest.scope.requestedVersions, [buildB.id]);
    assert.ok(restoredManifest.builds.includes(buildA.id), 'the parent Build must survive the archive round-trip');

    // The receiver can genuinely restore B's authored state and rebuild it —
    // which needs the parent A that the requested Build derives from.
    await revertProject(restored, buildB.id);
    const rebuilt = await buildProject(restored);
    assert.equal(rebuilt.status, 'succeeded', 'reverting to the carried version must rebuild');
    assert.ok(
      rebuilt.artifacts.some(item => item.media?.audio),
      'the rebuilt programme keeps its mixed audio',
    );

    // And it re-exports / re-archives with the same carried closure.
    const reexported = nodePath.join(parent, 'reexported');
    await exportProject(restored, reexported, { extraVersions: [buildB.id] });
    const again = await manifestOf(reexported);
    assert.deepEqual(again.scope.requestedVersions, [buildB.id]);
    assert.ok(again.builds.includes(buildA.id));
    const secondArchive = nodePath.join(parent, 'second.viscraft-archive');
    await archiveProject(restored, secondArchive, { extraVersions: [buildB.id] });
    await restoreProject(secondArchive, nodePath.join(parent, 'restored-again'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(parent, { recursive: true, force: true });
  }
});
