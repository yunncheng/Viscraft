import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { promoteFrame } from '../src/operations/assets/assets.js';
import { buildProject } from '../src/build/build.js';
import { ProjectSchema, BuildRecordSchema } from '../src/core/schema.js';
import type { Artifact, BuildRecord, Project, Take } from '../src/core/schema.js';
import { atomicJson } from '../src/shared/fs.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { loadProject } from '../src/project/project.js';

const FPS = { numerator: 25, denominator: 1 };
const FRAMES = 50; // 2 s at 25 fps -> one simulated duration tier

const RIGHTS = { origin: 'authoring session 2026-10-08', license: 'private approval only', redistributable: false };

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-assets-test-'));
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

function simulatedProject(): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'promote_frames',
    revision: 1,
    title: 'Frame promotion',
    direction: { intent: 'test', looks: [{ id: 'look_main', description: 'main' }], transitions: [] },
    assets: [],
    bindings: {},
    sources: [
      {
        id: 'src_sim',
        kind: 'simulated',
        prompt: 'control chain',
        frames: FRAMES,
        seed: 0,
        attempt: 'attempt_promote',
        behavior: 'success',
      },
    ],
    composition: {
      output: { width: 64, height: 48, fps: FPS, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene_1', description: 'scene' }],
      shots: [{ id: 'shot_1', scene: 'scene_1', look: 'look_main', intent: 'shot', targetFrames: FRAMES }],
      placements: [
        {
          id: 'place_1',
          shot: 'shot_1',
          source: 'src_sim',
          inFrame: 0,
          outFrame: FRAMES,
          startFrame: 0,
          audio: 'mute',
        },
      ],
      transitions: [],
      audio: [],
    },
  });
}

async function writeProject(root: string, project: Project): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await atomicJson(nodePath.join(root, 'project.json'), project);
}

/** Real non-simulated media project: a genuine FFmpeg clip registered as a video Asset. */
async function mediaProject(root: string): Promise<Project> {
  const clipPath = nodePath.join(root, 'assets', 'clip.mp4');
  await fs.mkdir(nodePath.dirname(clipPath), { recursive: true });
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=64x48:rate=25:duration=2`,
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
    '-an',
    clipPath,
  ]);
  const sha256 = await hashFile(clipPath);
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'promote_media',
    revision: 1,
    title: 'Frame promotion from real media',
    direction: { intent: 'test', looks: [{ id: 'look_main', description: 'main' }], transitions: [] },
    assets: [
      { id: 'clip', revision: 1, path: 'assets/clip.mp4', sha256, type: 'video', rights: RIGHTS, simulated: false },
    ],
    bindings: {},
    sources: [],
    composition: {
      output: { width: 64, height: 48, fps: FPS, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene_1', description: 'scene' }],
      shots: [{ id: 'shot_1', scene: 'scene_1', look: 'look_main', intent: 'shot', targetFrames: FRAMES }],
      placements: [
        {
          id: 'place_1',
          shot: 'shot_1',
          asset: 'clip',
          inFrame: 0,
          outFrame: FRAMES,
          startFrame: 0,
          audio: 'mute',
        },
      ],
      transitions: [],
      audio: [],
    },
  });
}

interface BuiltProject {
  root: string;
  build: BuildRecord;
  take: Take;
  artifact: Artifact;
  artifactPath: string;
}

async function builtSimulated(): Promise<BuiltProject> {
  const root = await tempRoot();
  await writeProject(root, simulatedProject());
  const build = await buildProject(root);
  const take = build.takes.find(item => item.source === 'src_sim')!;
  assert.ok(take, 'simulated build must register a Take');
  const artifact = build.artifacts.find(item => item.id === take.artifact)!;
  return { root, build, take, artifact, artifactPath: nodePath.join(root, artifact.path) };
}

async function builtMedia(): Promise<BuiltProject> {
  const root = await tempRoot();
  await writeProject(root, await mediaProject(root));
  const build = await buildProject(root);
  const take = build.takes.find(item => item.asset === 'clip')!;
  assert.ok(take, 'media build must register a Take');
  const artifact = build.artifacts.find(item => item.id === take.artifact)!;
  return { root, build, take, artifact, artifactPath: nodePath.join(root, artifact.path) };
}

function isPng(buffer: Buffer): boolean {
  return (
    buffer.length > 24 && buffer.toString('latin1', 1, 4) === 'PNG' && buffer.toString('latin1', 12, 16) === 'IHDR'
  );
}

test('promoteFrame approves distinct source frames as content-addressed image Assets', async () => {
  const built = await builtSimulated();
  const { root, build, take, artifact } = built;
  if (take.medium !== 'picture') assert.fail('a promoted hero Take must be a picture Take');
  try {
    const parentBefore = await hashFile(built.artifactPath);
    const buildsBefore = (await fs.readdir(nodePath.join(root, '.viscraft', 'builds'))).length;
    const projectBefore = await loadProject(root);

    const first = await promoteFrame(root, {
      take: take.id,
      frame: 0,
      assetId: 'hero_first',
      rights: RIGHTS,
      expectedRevision: projectBefore.revision,
    });
    const afterFirst = await loadProject(root);
    const last = await promoteFrame(root, {
      take: take.id,
      frame: take.frames - 1,
      assetId: 'hero_last',
      rights: RIGHTS,
      expectedRevision: afterFirst.revision,
    });

    assert.equal(first.type, 'image');
    assert.equal(first.revision, 1);
    assert.match(first.sha256, /^[a-f0-9]{64}$/);
    assert.equal(first.path, `assets/hero_first-${first.sha256.slice(0, 16)}.png`);
    assert.notEqual(first.sha256, last.sha256, 'first and last source frames must differ');

    for (const asset of [first, last]) {
      const bytes = await fs.readFile(nodePath.join(root, asset.path));
      assert.ok(isPng(bytes), `${asset.id} must be a real PNG`);
      assert.equal(
        await hashFile(nodePath.join(root, asset.path)),
        asset.sha256,
        `${asset.id} content hash must match record`,
      );
      assert.deepEqual(asset.rights, RIGHTS, `${asset.id} keeps the caller rights verbatim`);
    }

    assert.equal(first.simulated, true, 'a simulated Take must taint its promoted frame');
    assert.deepEqual(first.derivedFrom, {
      kind: 'frame',
      build: build.id,
      artifact: artifact.id,
      sha256: artifact.sha256,
      frame: 0,
      take: take.id,
    });

    const projectAfter = await loadProject(root);
    assert.equal(projectAfter.revision, projectBefore.revision + 2);
    assert.deepEqual(
      projectAfter.assets.map(asset => asset.id),
      ['hero_first', 'hero_last'],
    );

    assert.equal(await hashFile(built.artifactPath), parentBefore, 'the parent Artifact bytes must never change');
    assert.equal(
      (await fs.readdir(nodePath.join(root, '.viscraft', 'builds'))).length,
      buildsBefore,
      'promotion must not fabricate a Build record',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('promoteFrame rejects out-of-range frames without touching the Project', async () => {
  const built = await builtSimulated();
  const { root, take } = built;
  if (take.medium !== 'picture') assert.fail('a promoted hero Take must be a picture Take');
  try {
    const before = await fs.readFile(nodePath.join(root, 'project.json'));

    await assert.rejects(
      () =>
        promoteFrame(root, { take: take.id, frame: take.frames, assetId: 'oob', rights: RIGHTS, expectedRevision: 1 }),
      /out of range/,
    );
    await assert.rejects(
      () =>
        promoteFrame(root, {
          take: take.id,
          frame: take.frames + 1000,
          assetId: 'oob2',
          rights: RIGHTS,
          expectedRevision: 1,
        }),
      /out of range/,
    );

    assert.deepEqual(
      await fs.readFile(nodePath.join(root, 'project.json')),
      before,
      'a failed promotion must leave project.json byte-identical',
    );
    const project = await loadProject(root);
    assert.equal(project.revision, 1);
    assert.deepEqual(project.assets, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('promoteFrame enforces revision and refuses an existing Asset id', async () => {
  const built = await builtSimulated();
  const { root, take } = built;
  try {
    await assert.rejects(
      () => promoteFrame(root, { take: take.id, frame: 0, assetId: 'hero', rights: RIGHTS, expectedRevision: 99 }),
      /revision conflict/,
    );

    const asset = await promoteFrame(root, {
      take: take.id,
      frame: 0,
      assetId: 'hero',
      rights: RIGHTS,
      expectedRevision: 1,
    });
    const before = await fs.readFile(nodePath.join(root, 'project.json'));
    await assert.rejects(
      () => promoteFrame(root, { take: take.id, frame: 1, assetId: 'hero', rights: RIGHTS, expectedRevision: 2 }),
      /already exists/,
    );

    assert.deepEqual(
      await fs.readFile(nodePath.join(root, 'project.json')),
      before,
      'a refused id collision must not modify the Project',
    );
    const project = await loadProject(root);
    assert.deepEqual(
      project.assets.map(item => item.id),
      ['hero'],
    );
    assert.equal(project.assets[0].sha256, asset.sha256);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('promoteFrame reports unknown Takes/Artifacts and non-video parents honestly', async () => {
  const built = await builtSimulated();
  const { root, build, take } = built;
  try {
    await assert.rejects(
      () => promoteFrame(root, { take: 'take-missing', frame: 0, assetId: 'x', rights: RIGHTS, expectedRevision: 1 }),
      /Unknown Take/,
    );
    await assert.rejects(
      () =>
        promoteFrame(root, {
          artifact: 'artifact-missing',
          frame: 0,
          assetId: 'x',
          rights: RIGHTS,
          expectedRevision: 1,
        }),
      /Unknown Artifact/,
    );

    const audio = build.artifacts.find(item => item.kind === 'audio');
    assert.ok(audio, 'the build must contain an audio Artifact to reject');
    await assert.rejects(
      () => promoteFrame(root, { artifact: audio!.id, frame: 0, assetId: 'x', rights: RIGHTS, expectedRevision: 1 }),
      /not a video/,
    );

    await assert.rejects(
      () =>
        promoteFrame(root, {
          take: take.id,
          artifact: 'artifact-x',
          frame: 0,
          assetId: 'x',
          rights: RIGHTS,
          expectedRevision: 1,
        }),
      /exactly one/i,
    );
    await assert.rejects(
      () => promoteFrame(root, { frame: 0, assetId: 'x', rights: RIGHTS, expectedRevision: 1 }),
      /exactly one/i,
    );

    assert.deepEqual((await loadProject(root)).assets, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('promoteFrame refuses a tampered parent Artifact and leaves the Project untouched', async () => {
  const built = await builtSimulated();
  const { root, take } = built;
  try {
    const original = await fs.readFile(built.artifactPath);
    try {
      await fs.writeFile(built.artifactPath, Buffer.concat([original, Buffer.from('corrupt')]));
      const before = await fs.readFile(nodePath.join(root, 'project.json'));
      await assert.rejects(
        () => promoteFrame(root, { take: take.id, frame: 0, assetId: 'tampered', rights: RIGHTS, expectedRevision: 1 }),
        /hash mismatch/,
      );
      assert.deepEqual(await fs.readFile(nodePath.join(root, 'project.json')), before);
    } finally {
      await fs.writeFile(built.artifactPath, original);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('promoteFrame keeps real media real and taints from any matching-hash record', async () => {
  const built = await builtMedia();
  const { root, take, artifact } = built;
  try {
    const honest = await promoteFrame(root, {
      artifact: artifact.id,
      frame: 0,
      assetId: 'real_still',
      rights: RIGHTS,
      expectedRevision: 1,
    });
    assert.equal(honest.simulated, false, 'a purely real Code/Media parent must not be marked simulated');
    assert.deepEqual(honest.derivedFrom, {
      kind: 'frame',
      build: built.build.id,
      artifact: artifact.id,
      sha256: artifact.sha256,
      frame: 0,
    });

    // A second, earlier Build records the same bytes as simulated. Even though the
    // newest record is honest, the shared hash must taint the derived Asset.
    const recordFile = nodePath.join(root, '.viscraft', 'builds', `${built.build.id}.json`);
    const record = BuildRecordSchema.parse(JSON.parse(await fs.readFile(recordFile, 'utf8')));
    const fixture: BuildRecord = BuildRecordSchema.parse({
      ...record,
      id: 'build-taint-fixture',
      run: { id: 'run-taint-fixture', goal: 'simulated twin' },
      startedAt: '2000-01-01T00:00:00.000Z',
      artifacts: record.artifacts.map(item => ({ ...item, simulated: true })),
    });
    await atomicJson(nodePath.join(root, '.viscraft', 'builds', `${fixture.id}.json`), fixture);

    const tainted = await promoteFrame(root, {
      take: take.id,
      frame: 0,
      assetId: 'tainted_still',
      rights: RIGHTS,
      expectedRevision: 2,
    });
    assert.equal(tainted.simulated, true, 'any known record with the same parent hash must taint the frame');

    const project = await loadProject(root);
    assert.equal(project.assets.find(asset => asset.id === 'real_still')!.simulated, false);
    assert.equal(project.assets.find(asset => asset.id === 'tainted_still')!.simulated, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('promoteFrame reuses an identical still left by an earlier promotion', async () => {
  const built = await builtSimulated();
  const { root, take } = built;
  try {
    const first = await promoteFrame(root, {
      take: take.id,
      frame: 0,
      assetId: 'reuse',
      rights: RIGHTS,
      expectedRevision: 1,
    });
    const bytes = await fs.readFile(nodePath.join(root, first.path));

    // Drop the Asset registration but keep the content-addressed file on disk.
    const project = await loadProject(root);
    await writeProject(root, {
      ...project,
      revision: project.revision + 1,
      assets: project.assets.filter(asset => asset.id !== 'reuse'),
    });

    const again = await promoteFrame(root, {
      take: take.id,
      frame: 0,
      assetId: 'reuse',
      rights: RIGHTS,
      expectedRevision: project.revision + 1,
    });
    assert.equal(again.path, first.path);
    assert.equal(again.sha256, first.sha256);
    assert.deepEqual(await fs.readFile(nodePath.join(root, again.path)), bytes);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
