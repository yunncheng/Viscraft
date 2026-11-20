import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { promoteFrame, promoteRange } from '../src/operations/assets/assets.js';
import { buildProject } from '../src/build/build.js';
import { ProjectSchema } from '../src/core/schema.js';
import type { Asset, Artifact, BuildRecord, Project, Take } from '../src/core/schema.js';
import { atomicJson } from '../src/shared/fs.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { loadProject } from '../src/project/project.js';

const FPS = { numerator: 25, denominator: 1 };
const FRAMES = 50; // 2 s at 25 fps

const RIGHTS = {
  origin: 'storyboard authoring session 2026-10-09',
  license: 'private approval only',
  redistributable: false,
};

const execFileAsync = promisify(execFile);

/** Narrow a promoted Asset's derivation to the frame relation, failing loudly otherwise. */
function frameOf(asset: Asset): number {
  const derivation = asset.derivedFrom;
  if (!derivation || derivation.kind !== 'frame') throw new Error(`${asset.id} must carry a frame derivation`);
  return derivation.frame;
}

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-promote-range-'));
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

/** A real, non-simulated media project: an FFmpeg testsrc2 clip registered as a video Asset. */
async function mediaProject(root: string, frames: number = FRAMES): Promise<Project> {
  const clipPath = nodePath.join(root, 'assets', 'clip.mp4');
  await fs.mkdir(nodePath.dirname(clipPath), { recursive: true });
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=64x48:rate=25:duration=${frames / 25}`,
    '-frames:v',
    String(frames),
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
    id: 'promote_range_media',
    revision: 1,
    title: 'Storyboard range promotion from real media',
    direction: { intent: 'test', looks: [{ id: 'look_main', description: 'main' }], transitions: [] },
    assets: [
      { id: 'clip', revision: 1, path: 'assets/clip.mp4', sha256, type: 'video', rights: RIGHTS, simulated: false },
    ],
    bindings: {},
    sources: [],
    composition: {
      output: { width: 64, height: 48, fps: FPS, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene_1', description: 'scene' }],
      shots: [{ id: 'shot_1', scene: 'scene_1', look: 'look_main', intent: 'shot', targetFrames: frames }],
      placements: [
        {
          id: 'place_1',
          shot: 'shot_1',
          asset: 'clip',
          inFrame: 0,
          outFrame: frames,
          startFrame: 0,
          audio: 'mute',
        },
      ],
      transitions: [],
      audio: [],
    },
  });
}

interface BuiltMedia {
  root: string;
  build: BuildRecord;
  take: Take;
  artifact: Artifact;
  artifactPath: string;
}

async function builtMedia(frames: number = FRAMES): Promise<BuiltMedia> {
  const root = await tempRoot();
  await atomicJson(nodePath.join(root, 'project.json'), await mediaProject(root, frames));
  const build = await buildProject(root);
  const take = build.takes.find(item => item.asset === 'clip')!;
  assert.ok(take, 'media build must register a Take');
  if (take.medium !== 'picture') assert.fail('the normalized video clip Take must be a picture Take');
  const artifact = build.artifacts.find(item => item.id === take.artifact)!;
  assert.equal(take.frames, frames, `the take must span ${frames} frames`);
  return { root, build, take, artifact, artifactPath: nodePath.join(root, artifact.path) };
}

/** A simulated/test-only video project, so a promoted range inherits its taint. */
async function builtSimulatedMedia(frames: number = FRAMES): Promise<BuiltMedia> {
  const root = await tempRoot();
  await atomicJson(
    nodePath.join(root, 'project.json'),
    ProjectSchema.parse({
      schemaVersion: 1,
      id: 'promote_range_simulated',
      revision: 1,
      title: 'Storyboard range promotion from simulated media',
      direction: { intent: 'test', looks: [{ id: 'look_main', description: 'main' }], transitions: [] },
      assets: [],
      bindings: {},
      sources: [
        {
          id: 'src_sim',
          kind: 'simulated',
          prompt: 'control chain',
          frames,
          seed: 0,
          attempt: 'attempt_promote_range',
          behavior: 'success',
        },
      ],
      composition: {
        output: { width: 64, height: 48, fps: FPS, sampleRate: 48000, channels: 2 },
        scenes: [{ id: 'scene_1', description: 'scene' }],
        shots: [{ id: 'shot_1', scene: 'scene_1', look: 'look_main', intent: 'shot', targetFrames: frames }],
        placements: [
          {
            id: 'place_1',
            shot: 'shot_1',
            source: 'src_sim',
            inFrame: 0,
            outFrame: frames,
            startFrame: 0,
            audio: 'mute',
          },
        ],
        transitions: [],
        audio: [],
      },
    }),
  );
  const build = await buildProject(root);
  const take = build.takes.find(item => item.source === 'src_sim')!;
  assert.ok(take, 'simulated build must register a Take');
  const artifact = build.artifacts.find(item => item.id === take.artifact)!;
  return { root, build, take, artifact, artifactPath: nodePath.join(root, artifact.path) };
}

function isPng(buffer: Buffer): boolean {
  return (
    buffer.length > 24 && buffer.toString('latin1', 1, 4) === 'PNG' && buffer.toString('latin1', 12, 16) === 'IHDR'
  );
}

/** Independently decode one exact source frame of a media file via FFmpeg. */
async function extractFrame(source: string, frame: number, destination: string): Promise<void> {
  await ffmpeg([
    '-i',
    source,
    '-vf',
    `select=eq(n\\,${frame})`,
    '-frames:v',
    '1',
    '-an',
    '-pix_fmt',
    'rgb24',
    destination,
  ]);
}

/** Mean absolute per-pixel difference between two same-size images (0 = identical). */
async function meanAbsDiff(a: string, b: string): Promise<number> {
  const diff = `${a}.diff.gray`;
  try {
    await ffmpeg([
      '-i',
      a,
      '-i',
      b,
      '-lavfi',
      '[0:v][1:v]blend=all_mode=difference,format=gray',
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      diff,
    ]);
    const bytes = await fs.readFile(diff);
    let sum = 0;
    for (const value of bytes) sum += value;
    return sum / bytes.length;
  } finally {
    await fs.rm(diff, { force: true });
  }
}

test('promoteRange promotes a strided half-open range into content-addressed image Assets', async () => {
  const built = await builtMedia();
  const { root, build, take, artifact, artifactPath } = built;
  try {
    const parentBefore = await hashFile(artifactPath);
    const buildsBefore = (await fs.readdir(nodePath.join(root, '.viscraft', 'builds'))).length;
    const projectBefore = await loadProject(root);

    const assets = await promoteRange(root, {
      take: take.id,
      inFrame: 10,
      outFrame: 13,
      expectedRevision: projectBefore.revision,
      rights: RIGHTS,
    });

    assert.equal(assets.length, 3);
    assert.deepEqual(
      assets.map(asset => asset.id),
      ['clip-f10', 'clip-f11', 'clip-f12'],
    );
    assert.deepEqual(assets.map(frameOf), [10, 11, 12]);
    for (const asset of assets) {
      assert.equal(asset.type, 'image');
      assert.equal(asset.revision, 1);
      assert.equal(asset.simulated, false, 'a purely real media Take must not taint its frames');
      assert.match(asset.sha256, /^[a-f0-9]{64}$/);
      assert.equal(asset.path, `assets/${asset.id}-${asset.sha256.slice(0, 16)}.png`);
      assert.deepEqual(asset.rights, RIGHTS, 'caller rights are kept verbatim');
      assert.deepEqual(asset.derivedFrom, {
        kind: 'frame',
        build: build.id,
        artifact: artifact.id,
        sha256: artifact.sha256,
        frame: frameOf(asset),
        take: take.id,
      });
      const bytes = await fs.readFile(nodePath.join(root, asset.path));
      assert.ok(isPng(bytes), `${asset.id} must be a real PNG`);
      assert.equal(
        await hashFile(nodePath.join(root, asset.path)),
        asset.sha256,
        `${asset.id} content hash must match its independent hash`,
      );
    }

    // The decoded still must really be the requested source frame, and the check
    // must discriminate against a different frame.
    for (let index = 0; index < assets.length; index++) {
      const asset = assets[index];
      const reference = nodePath.join(root, `.ref-${index}.png`);
      const other = nodePath.join(root, `.other-${index}.png`);
      await extractFrame(artifactPath, frameOf(asset), reference);
      await extractFrame(artifactPath, frameOf(asset) + 20, other);
      const same = await meanAbsDiff(nodePath.join(root, asset.path), reference);
      const different = await meanAbsDiff(nodePath.join(root, asset.path), other);
      assert.ok(
        same < 1,
        `${asset.id} should be identical to an independent decode of frame ${frameOf(asset)} (MAD ${same})`,
      );
      assert.ok(different > 3, `${asset.id} must differ from an unrelated frame (MAD ${different})`);
      await fs.rm(reference, { force: true });
      await fs.rm(other, { force: true });
    }

    const projectAfter = await loadProject(root);
    assert.equal(projectAfter.revision, projectBefore.revision + 1, 'the whole range is one atomic revision bump');
    assert.deepEqual(
      projectAfter.assets.map(asset => asset.id),
      ['clip', 'clip-f10', 'clip-f11', 'clip-f12'],
    );

    assert.equal(await hashFile(artifactPath), parentBefore, 'the parent Artifact bytes must never change');
    assert.equal(
      (await fs.readdir(nodePath.join(root, '.viscraft', 'builds'))).length,
      buildsBefore,
      'promotion must not fabricate a Build record',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('promoteRange propagates a simulated parent taint and keeps caller rights', async () => {
  const built = await builtSimulatedMedia();
  const { root, build, take, artifact } = built;
  try {
    const before = await loadProject(root);
    const assets = await promoteRange(root, {
      take: take.id,
      inFrame: 4,
      outFrame: 6,
      expectedRevision: before.revision,
      rights: RIGHTS,
    });

    assert.equal(assets.length, 2);
    for (const asset of assets) {
      assert.equal(asset.type, 'image');
      // A cut-point frame from a simulated Take must stay tainted along its lineage.
      assert.equal(asset.simulated, true, 'a simulated parent taints every promoted frame');
      assert.deepEqual(asset.rights, RIGHTS, 'caller rights are kept verbatim');
      assert.deepEqual(asset.derivedFrom, {
        kind: 'frame',
        build: build.id,
        artifact: artifact.id,
        sha256: artifact.sha256,
        frame: frameOf(asset),
        take: take.id,
      });
      assert.ok(isPng(await fs.readFile(nodePath.join(root, asset.path))), `${asset.id} must be a real PNG`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('promoteRange honours the every stride and an explicit idPrefix', async () => {
  const built = await builtMedia();
  const { root, take } = built;
  try {
    const dense = await promoteRange(root, {
      take: take.id,
      inFrame: 10,
      outFrame: 13,
      idPrefix: 'board_dense',
      expectedRevision: 1,
      rights: RIGHTS,
    });
    assert.deepEqual(dense.map(frameOf), [10, 11, 12], 'every defaults to 1');

    const sparse = await promoteRange(root, {
      take: take.id,
      inFrame: 10,
      outFrame: 13,
      every: 2,
      idPrefix: 'board_sparse',
      expectedRevision: 2,
      rights: RIGHTS,
    });
    assert.deepEqual(sparse.map(frameOf), [10, 12], 'a stride of 2 selects inFrame, inFrame+2, ... while < outFrame');
    assert.equal(sparse.length, 2);
    assert.deepEqual(
      sparse.map(asset => asset.id),
      ['board_sparse-f10', 'board_sparse-f12'],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('promoteRange accepts an Artifact id as the source and defaults the prefix from it', async () => {
  const built = await builtMedia();
  const { root, artifact } = built;
  try {
    const assets = await promoteRange(root, {
      artifact: artifact.id,
      inFrame: 0,
      outFrame: 2,
      expectedRevision: 1,
      rights: RIGHTS,
    });
    assert.deepEqual(
      assets.map(asset => asset.id),
      [`${artifact.id}-f0`, `${artifact.id}-f1`],
    );
    assert.deepEqual(assets[0].derivedFrom, {
      kind: 'frame',
      build: built.build.id,
      artifact: artifact.id,
      sha256: artifact.sha256,
      frame: 0,
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('promoteRange rejects out-of-range, empty, non-positive-stride and unknown inputs without touching the Project', async () => {
  const built = await builtMedia();
  const { root, take } = built;
  try {
    const before = await fs.readFile(nodePath.join(root, 'project.json'));

    await assert.rejects(
      () =>
        promoteRange(root, { take: take.id, inFrame: 0, outFrame: FRAMES + 1, expectedRevision: 1, rights: RIGHTS }),
      /out of range/,
    );
    await assert.rejects(
      () => promoteRange(root, { take: take.id, inFrame: 5, outFrame: 5, expectedRevision: 1, rights: RIGHTS }),
      /nonempty/,
    );
    await assert.rejects(
      () =>
        promoteRange(root, { take: take.id, inFrame: 0, outFrame: 5, every: 0, expectedRevision: 1, rights: RIGHTS }),
      /positive/,
    );
    await assert.rejects(
      () =>
        promoteRange(root, { take: take.id, inFrame: 0, outFrame: 5, every: -1, expectedRevision: 1, rights: RIGHTS }),
      /positive/,
    );
    await assert.rejects(
      () => promoteRange(root, { take: 'take-missing', inFrame: 0, outFrame: 2, expectedRevision: 1, rights: RIGHTS }),
      /Unknown Take/,
    );
    await assert.rejects(
      () =>
        promoteRange(root, {
          artifact: 'artifact-missing',
          inFrame: 0,
          outFrame: 2,
          expectedRevision: 1,
          rights: RIGHTS,
        }),
      /Unknown Artifact/,
    );
    await assert.rejects(
      () =>
        promoteRange(root, {
          take: take.id,
          artifact: 'artifact-x',
          inFrame: 0,
          outFrame: 2,
          expectedRevision: 1,
          rights: RIGHTS,
        }),
      /exactly one/i,
    );
    await assert.rejects(
      () => promoteRange(root, { take: take.id, inFrame: 0, outFrame: 2, expectedRevision: 99, rights: RIGHTS }),
      /revision conflict/,
    );

    assert.deepEqual(
      await fs.readFile(nodePath.join(root, 'project.json')),
      before,
      'a rejected range must leave project.json byte-identical',
    );
    const project = await loadProject(root);
    assert.equal(project.revision, 1);
    assert.deepEqual(
      project.assets.map(asset => asset.id),
      ['clip'],
      'no partial Assets may survive a rejection',
    );
    const scratch = await fs.readdir(nodePath.join(root, '.viscraft', 'scratch')).catch(() => []);
    assert.deepEqual(scratch, [], 'scratch staging must be cleaned up');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('promoteRange preserves all requested frames beyond the former 200-frame quota', async () => {
  const count = 240;
  const { root, take } = await builtMedia(count);
  try {
    const images = await promoteRange(root, {
      take: take.id,
      inFrame: 0,
      outFrame: count,
      every: 1,
      expectedRevision: 1,
      rights: RIGHTS,
    });
    assert.equal(images.length, count);
    assert.deepEqual(
      images.map(frameOf),
      Array.from({ length: count }, (_, index) => index),
    );
    assert.equal((await loadProject(root)).revision, 2, 'the complete selection commits as one author revision');
    for (const image of images) assert.equal(await hashFile(nodePath.join(root, image.path)), image.sha256);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('promoteRange refuses an existing Asset id and refuses to overwrite differing file content', async () => {
  const built = await builtMedia();
  const { root, take } = built;
  try {
    const first = await promoteRange(root, {
      take: take.id,
      inFrame: 0,
      outFrame: 2,
      idPrefix: 'board',
      expectedRevision: 1,
      rights: RIGHTS,
    });
    const beforeConflict = await fs.readFile(nodePath.join(root, 'project.json'));
    await assert.rejects(
      () =>
        promoteRange(root, {
          take: take.id,
          inFrame: 0,
          outFrame: 2,
          idPrefix: 'board',
          expectedRevision: 2,
          rights: RIGHTS,
        }),
      /already exists/,
    );
    assert.deepEqual(
      await fs.readFile(nodePath.join(root, 'project.json')),
      beforeConflict,
      'an id collision must not modify the Project',
    );

    // Drop the registrations but keep the content-addressed files, then corrupt
    // one file. Re-promotion must now refuse to overwrite differing content.
    const project = await loadProject(root);
    await atomicJson(nodePath.join(root, 'project.json'), {
      ...project,
      revision: project.revision + 1,
      assets: project.assets.filter(asset => asset.id !== 'board-f0' && asset.id !== 'board-f1'),
    });
    await fs.writeFile(nodePath.join(root, first[0].path), Buffer.from('not the same png at all'));

    const beforeDiff = await fs.readFile(nodePath.join(root, 'project.json'));
    await assert.rejects(
      () =>
        promoteRange(root, {
          take: take.id,
          inFrame: 0,
          outFrame: 2,
          idPrefix: 'board',
          expectedRevision: project.revision + 1,
          rights: RIGHTS,
        }),
      /Refusing to overwrite/,
    );
    assert.deepEqual(await fs.readFile(nodePath.join(root, 'project.json')), beforeDiff);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('promoteRange is idempotent over unregistered output and leaves promoteFrame untouched', async () => {
  const built = await builtMedia();
  const { root, take } = built;
  try {
    const first = await promoteRange(root, {
      take: take.id,
      inFrame: 20,
      outFrame: 23,
      idPrefix: 'board',
      expectedRevision: 1,
      rights: RIGHTS,
    });
    const bytes = await Promise.all(first.map(asset => fs.readFile(nodePath.join(root, asset.path))));

    const project = await loadProject(root);
    await atomicJson(nodePath.join(root, 'project.json'), {
      ...project,
      revision: project.revision + 1,
      assets: project.assets.filter(asset => !asset.id.startsWith('board-')),
    });

    const again = await promoteRange(root, {
      take: take.id,
      inFrame: 20,
      outFrame: 23,
      idPrefix: 'board',
      expectedRevision: project.revision + 1,
      rights: RIGHTS,
    });
    assert.deepEqual(
      again.map(asset => asset.path),
      first.map(asset => asset.path),
      'identical frames reuse the same content-addressed paths',
    );
    assert.deepEqual(
      again.map(asset => asset.sha256),
      first.map(asset => asset.sha256),
    );
    for (let index = 0; index < again.length; index++)
      assert.deepEqual(await fs.readFile(nodePath.join(root, again[index].path)), bytes[index]);

    // promoteFrame still approves exactly one frame, unchanged.
    const current = await loadProject(root);
    const single = await promoteFrame(root, {
      take: take.id,
      frame: 30,
      assetId: 'single_frame',
      expectedRevision: current.revision,
      rights: RIGHTS,
    });
    assert.equal(single.type, 'image');
    assert.equal(single.derivedFrom!.kind, 'frame');
    assert.equal(frameOf(single), 30);
    const registered = await loadProject(root);
    assert.ok(registered.assets.some(asset => asset.id === 'single_frame'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('cli promote-range command dispatches to promoteRange', async () => {
  const built = await builtMedia();
  const { root, take } = built;
  try {
    await atomicJson(nodePath.join(root, 'options.json'), {
      take: take.id,
      inFrame: 0,
      outFrame: 2,
      idPrefix: 'cli_board',
      expectedRevision: 1,
      rights: RIGHTS,
    });
    const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
    const { stdout } = await execFileAsync(process.execPath, [cliPath, 'promote-range', root, 'options.json']);
    const parsed = JSON.parse(stdout);
    assert.ok(Array.isArray(parsed), 'the CLI must print the promoted Asset array');
    assert.deepEqual(
      parsed.map((asset: { id: string }) => asset.id),
      ['cli_board-f0', 'cli_board-f1'],
    );

    // An unknown command must be rejected with the usage string that now lists promote-range.
    await assert.rejects(
      () => execFileAsync(process.execPath, [cliPath, 'promote-range-typo', root]),
      error =>
        /promote-range\s+<project-directory> <relative-options\.json>/.test(
          String((error as { stderr?: string }).stderr ?? (error as Error).message),
        ),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
