// The production preflight (`planBuild`) must run the SELECTED model profile's
// OWN request validation — not a second copy of its limits — so a request the
// real Build would reject is reported as a `blocked` issue BEFORE any
// submission. These tests pin that contract for MiniMax-H3 (reference counts,
// task-partition semantics and reference-video media limits) and the generic
// deployment-partition rule that still applies to models WITHOUT a profile.
//
// `planBuild` is a pure read: no provider submission, no upload, no media write.
// It DOES hash the authored-file closure, so every declared Asset needs a real
// file on disk or the plan reports a spurious `identity-unavailable` blocker.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { ProjectSchema, planBuild } from '../src/index.js';
import { minimaxH3Ref2vaExtension, minimaxH3Fl2vaExtension } from '../src/backends/providers/models/minimax-h3.js';
import type { Project } from '../src/index.js';

const execFileAsync = promisify(execFile);

const OUTPUT = { width: 64, height: 48, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 2 };
const RIGHTS = { origin: 'original test fixture', license: 'original test media', redistributable: true };
const SHA = 'a'.repeat(64);

/** A schema-valid Project with the given Sources/placements/assets over one shot. */
function makeProject(sources: unknown[], placements: unknown[], assets: unknown[] = []): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'plan_model',
    revision: 1,
    title: 'Plan model preflight',
    direction: { intent: 'preflight', looks: [{ id: 'default', description: 'Default look' }], transitions: [] },
    assets,
    bindings: {},
    sources,
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: 'scene' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'default', intent: 'shot', targetFrames: 48 }],
      placements,
      transitions: [],
      audio: [],
    },
  });
}

/** A H3 reference-mode Source over the single shot, placed 0..48 at 24 fps. */
function h3Source(references: unknown[]): unknown {
  return {
    id: 'src_h3',
    kind: 'provider',
    output: 'picture',
    endpoint: 'ep',
    model: 'minimax-h3-base-ref2va',
    prompt: 'p',
    mode: 'reference',
    references,
    requestedFrames: 48,
    size: '1280:720',
    seed: 0,
    attempt: 'a1',
  };
}
const H3_PLACEMENT = {
  id: 'pl',
  shot: 'shot',
  source: 'src_h3',
  inFrame: 0,
  outFrame: 48,
  startFrame: 0,
  audio: 'mute',
};

/** An image Asset declaration plus its (1-byte) on-disk file. */
function imageAsset(id: string): Record<string, unknown> {
  return { id, revision: 1, type: 'image', path: `img-${id}.png`, sha256: SHA, rights: RIGHTS, simulated: false };
}
const imageReference = (id: string) => ({ asset: id, category: 'image', role: 'identity' });

/**
 * The same Endpoint, with the packaged H3 definition+mapping selected (H3 is
 * opt-in). A production request that TRANSMITS references now needs per-Asset
 * upload consent, so the transmitted asset ids are listed here; a case that
 * deliberately omits consent uses `configuredEndpoint`/no `uploadAssets`.
 */
const h3Endpoint = (taskType: 'ref2va' | 'fl2va', uploadAssets: string[] = []) => ({
  providers: {
    videoApi: {
      ep: {
        endpoint: {
          protocol: 'vllm-omni-video' as const,
          baseUrl: 'https://example.test',
          sourceModel: `minimax-h3-base-${taskType}`,
        },
        extension: taskType === 'ref2va' ? minimaxH3Ref2vaExtension() : minimaxH3Fl2vaExtension(),
        authorization: { submit: true, ...(uploadAssets.length ? { uploadAssets } : {}) },
      },
    },
  },
});

async function writeProject(root: string, project: Project, assetPaths: string[] = []): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const path of assetPaths) await writeFile(join(root, path), 'x', 'utf8');
  await writeFile(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-plan-model-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('H3 Ref2VA with ten image references is a model-request-invalid blocker', async () => {
  await withRoot(async root => {
    const ids = Array.from({ length: 10 }, (_, index) => `img${index + 1}`);
    const references = ids.map(imageReference);
    const assets = ids.map(imageAsset);
    await writeProject(
      root,
      makeProject([h3Source(references)], [H3_PLACEMENT], assets),
      ids.map(id => `img-${id}.png`),
    );

    const plan = await planBuild(root, h3Endpoint('ref2va', ids));

    const blocker = plan.blockers.find(issue => issue.code === 'model-request-invalid');
    assert.ok(blocker, 'ten image references exceed the H3 Ref2VA limit and must block');
    assert.equal(blocker!.level, 'blocked');
    assert.equal(blocker!.subject, 'src_h3');
    assert.equal(plan.buildable, false, 'a model-request-invalid blocker gates the build');
  });
});

test('H3 Ref2VA with two image references is buildable with no request blocker', async () => {
  await withRoot(async root => {
    const ids = ['img1', 'img2'];
    await writeProject(
      root,
      makeProject([h3Source(ids.map(imageReference))], [H3_PLACEMENT], ids.map(imageAsset)),
      ids.map(id => `img-${id}.png`),
    );

    const plan = await planBuild(root, h3Endpoint('ref2va', ids));

    assert.equal(
      plan.blockers.find(issue => issue.code === 'model-request-invalid'),
      undefined,
      'two references are within the H3 Ref2VA limit',
    );
    assert.deepEqual(plan.blockers, [], 'a configured, authorized, on-disk-complete request has no blocker');
    assert.equal(plan.buildable, true);
  });
});

test('H3 reference mode on a fl2va deployment is refused by the model profile, not the generic partition rule', async () => {
  await withRoot(async root => {
    const ids = ['img1'];
    await writeProject(
      root,
      makeProject(
        [{ ...(h3Source(ids.map(imageReference)) as object), model: 'minimax-h3-base-fl2va' }],
        [H3_PLACEMENT],
        ids.map(imageAsset),
      ),
      ids.map(id => `img-${id}.png`),
    );

    const plan = await planBuild(root, h3Endpoint('fl2va', ids));

    const blocker = plan.blockers.find(issue => issue.code === 'model-request-invalid');
    assert.ok(blocker, 'the H3 profile owns the partition rule for H3');
    assert.equal(blocker!.subject, 'src_h3');
    assert.equal(
      plan.unsupported.find(issue => issue.code === 'mode-not-supported-by-partition'),
      undefined,
      'H3 is covered by its own profile, so the generic deployment-partition rule must not fire a second time',
    );
    assert.equal(plan.buildable, false);
  });
});

test('a different model does not inherit H3 deployment-partition rules', async () => {
  await withRoot(async root => {
    const ids = ['img1'];
    const source = {
      id: 'src_other',
      kind: 'provider',
      output: 'picture',
      endpoint: 'ep',
      model: 'some-other-model',
      prompt: 'p',
      mode: 'reference',
      references: ids.map(imageReference),
      requestedFrames: 48,
      size: '1280:720',
      seed: 0,
      attempt: 'a1',
    };
    const placement = { ...H3_PLACEMENT, source: 'src_other' };
    await writeProject(
      root,
      makeProject([source], [placement], ids.map(imageAsset)),
      ids.map(id => `img-${id}.png`),
    );

    const plan = await planBuild(root, {
      providers: {
        videoApi: {
          ep: {
            endpoint: { protocol: 'vllm-omni-video', baseUrl: 'https://example.test' },
            authorization: { submit: true, uploadAssets: ids },
          },
        },
      },
    });

    assert.equal(
      plan.unsupported.some(issue => issue.code === 'mode-not-supported-by-partition'),
      false,
    );
    assert.equal(
      plan.blockers.some(issue => issue.code === 'model-request-invalid'),
      false,
    );
  });
});

test('a text-only Runway video-generation Source with an image-only ratio is a model-request-invalid blocker', async () => {
  await withRoot(async root => {
    // A Runway `provider` Source is validated by its OWN model profile
    // (gen4.5): the image-to-video-only ratio `1104:832` needs a first-frame
    // image, which this text-mode request does not carry. No Asset is declared,
    // so the plan hashes only project.json.
    const runwaySource = {
      id: 'src_runway',
      kind: 'provider',
      output: 'picture',
      endpoint: 'runway',
      model: 'gen4.5',
      prompt: 'a red rally car drifting through snow',
      mode: 'text',
      references: [],
      requestedFrames: 48,
      size: '1104:832',
      seed: 7,
      attempt: 'a1',
      parameters: { durationSeconds: 4, ratio: '1104:832' },
    };
    const placement = {
      id: 'pl',
      shot: 'shot',
      source: 'src_runway',
      inFrame: 0,
      outFrame: 48,
      startFrame: 0,
      audio: 'mute',
    };
    await writeProject(root, makeProject([runwaySource], [placement]));

    const plan = await planBuild(root, {
      providers: {
        videoApi: {
          runway: {
            endpoint: { protocol: 'runway-v1' as const, baseUrl: 'https://example.test' },
            authorization: { submit: true },
          },
        },
      },
    });

    const blocker = plan.blockers.find(issue => issue.code === 'model-request-invalid');
    assert.ok(blocker, 'a text-only Runway request using an image-to-video ratio must block');
    assert.equal(blocker!.level, 'blocked');
    assert.equal(blocker!.subject, 'src_runway');
    assert.equal(plan.buildable, false, 'a model-request-invalid blocker gates the build');
  });
});

const FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

test(
  'H3 reference-video media below the 2s minimum is a reference-media-invalid blocker',
  { skip: FFMPEG ? false : 'ffmpeg not on PATH' },
  async () => {
    await withRoot(async root => {
      const asset = {
        id: 'refvid',
        revision: 1,
        type: 'video',
        path: 'ref.mp4',
        sha256: SHA,
        rights: RIGHTS,
        simulated: false,
      };
      const source = h3Source([{ asset: 'refvid', category: 'video', role: 'motion' }]);
      await writeProject(root, makeProject([source], [H3_PLACEMENT], [asset]));

      // A real ~1s H.264 MP4 — shorter than H3's 2s minimum reference-video duration.
      await execFileAsync('ffmpeg', [
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=64x48:rate=24:duration=1',
        '-pix_fmt',
        'yuv420p',
        join(root, 'ref.mp4'),
      ]);

      const plan = await planBuild(root, h3Endpoint('ref2va', ['refvid']));

      const blocker = plan.blockers.find(issue => issue.code === 'reference-media-invalid');
      assert.ok(blocker, 'a 1s reference video violates H3 media limits and must block');
      assert.equal(blocker!.level, 'blocked');
      assert.equal(blocker!.subject, 'refvid');
      assert.equal(
        plan.blockers.find(issue => issue.code === 'model-request-invalid'),
        undefined,
        'the request itself (one video reference) is legal',
      );
      assert.equal(plan.buildable, false);
    });
  },
);
