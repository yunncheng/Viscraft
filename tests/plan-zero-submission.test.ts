// EXPLICIT zero-submission / zero-upload evidence for the production preflight.
//
// `planBuild` is the dry-run a host runs before committing spend. Even for a
// FULLY configured, submit-authorized generation Source it must remain a pure
// read: it creates NO provider job and NO artifact, and does not even materialize
// the `.viscraft` working directory. These tests pin that on a fresh Project so a
// regression that starts touching the provider boundary during planning is caught
// loudly rather than silently submitting.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProjectSchema, planBuild } from '../src/index.js';
import type { Project } from '../src/index.js';

// A credential the planned Endpoints name; present in the environment for this file.
process.env.VISCRAFT_TEST_CREDENTIAL = 'test';

const OUTPUT = { width: 64, height: 48, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 2 };

/** A schema-valid Project with the given Sources/placements over one shot. */
function makeProject(sources: unknown[], placements: unknown[]): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'plan_zero',
    revision: 1,
    title: 'Zero submission',
    direction: { intent: 'preflight', looks: [{ id: 'default', description: 'Default look' }], transitions: [] },
    assets: [],
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

async function writeProject(root: string, project: Project): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-plan-zero-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// A configured, submit-authorized video-generation endpoint: everything a real
// Build would need to submit — yet a preflight must submit nothing.
const CONFIGURED_VIDEO = {
  providers: {
    videoApi: {
      ep: {
        endpoint: { protocol: 'vllm-omni-video' as const, baseUrl: 'https://example.test' },
        authorization: { submit: true },
      },
    },
  },
};

test('planning a configured video-generation Source creates no jobs, artifacts or .viscraft directory', async () => {
  await withRoot(async root => {
    const source = {
      id: 'src_vid',
      kind: 'provider',
      output: 'picture',
      endpoint: 'ep',
      model: 'some-model',
      prompt: 'p',
      mode: 'text',
      requestedFrames: 48,
      size: '1280:720',
      seed: 0,
      attempt: 'a1',
    };
    const placement = {
      id: 'pl',
      shot: 'shot',
      source: 'src_vid',
      inFrame: 0,
      outFrame: 48,
      startFrame: 0,
      audio: 'mute',
    };
    await writeProject(root, makeProject([source], [placement]));

    await planBuild(root, CONFIGURED_VIDEO);

    assert.equal(await exists(join(root, '.viscraft', 'jobs')), false, 'preflight submitted no provider job');
    assert.equal(await exists(join(root, '.viscraft', 'artifacts')), false, 'preflight wrote no artifact');
    assert.equal(
      await exists(join(root, '.viscraft')),
      false,
      'preflight did not even create the .viscraft working directory',
    );
  });
});

test('planning a configured Runway video-generation Source still creates no jobs', async () => {
  await withRoot(async root => {
    const source = {
      id: 'src_rw',
      kind: 'provider',
      output: 'picture',
      endpoint: 'runway',
      model: 'gen4.5',
      prompt: 'p',
      mode: 'text',
      references: [],
      requestedFrames: 48,
      size: '1280:720',
      attempt: 'a1',
      parameters: { durationSeconds: 5, ratio: '1280:720' },
    };
    const placement = {
      id: 'pl',
      shot: 'shot',
      source: 'src_rw',
      inFrame: 0,
      outFrame: 48,
      startFrame: 0,
      audio: 'mute',
    };
    await writeProject(root, makeProject([source], [placement]));

    const plan = await planBuild(root, {
      providers: {
        videoApi: {
          runway: {
            endpoint: {
              protocol: 'runway-v1',
              baseUrl: 'https://example.test',
              credential: 'VISCRAFT_TEST_CREDENTIAL',
            },
            authorization: { submit: true },
          },
        },
      },
    });

    assert.deepEqual(plan.blockers, [], 'a configured, authorized Runway request has no blocker');
    assert.equal(await exists(join(root, '.viscraft', 'jobs')), false, 'preflight submitted no Runway job');
    assert.equal(await exists(join(root, '.viscraft')), false, 'preflight did not create .viscraft');
  });
});

test('planning twice is idempotent and still creates nothing', async () => {
  await withRoot(async root => {
    const source = {
      id: 'src_vid',
      kind: 'provider',
      output: 'picture',
      endpoint: 'ep',
      model: 'some-model',
      prompt: 'p',
      mode: 'text',
      requestedFrames: 48,
      size: '1280:720',
      seed: 0,
      attempt: 'a1',
    };
    const placement = {
      id: 'pl',
      shot: 'shot',
      source: 'src_vid',
      inFrame: 0,
      outFrame: 48,
      startFrame: 0,
      audio: 'mute',
    };
    await writeProject(root, makeProject([source], [placement]));

    const first = await planBuild(root, CONFIGURED_VIDEO);
    const second = await planBuild(root, CONFIGURED_VIDEO);

    assert.deepEqual(second, first, 'a read-only preflight is idempotent');
    assert.equal(await exists(join(root, '.viscraft', 'jobs')), false, 'the second planning created no job');
    assert.equal(await exists(join(root, '.viscraft')), false, 'the second planning created no .viscraft');
  });
});
