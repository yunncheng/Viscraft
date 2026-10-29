// The read-only Plan must prepare the SAME effective request the adapter would, so
// the documented counter-examples are classified in the preflight (never a false
// `buildable`). Each case pins one confirmed defect: a malformed/plaintext
// Endpoint, a reference that would be transmitted without per-Asset consent, a
// credential resolved from the wrong place, and a mapping that collides with a
// protocol-reserved field.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { ProjectSchema, planBuild, createProject, preflightGenerateImage } from '../src/index.js';
import type { Project } from '../src/index.js';

// A credential the planned Endpoints name; present in the environment for this file.
process.env.VISCRAFT_TEST_CREDENTIAL = 'test';

const OUTPUT = { width: 64, height: 48, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 2 };
const HASH = 'a'.repeat(64);

function imageAsset(id: string) {
  return {
    id,
    revision: 1,
    path: `${id}.png`,
    sha256: HASH,
    type: 'image',
    rights: { origin: 'fixture', license: 'CC0-1.0', redistributable: true },
    simulated: false,
  };
}

function makeProject(sources: unknown[], assets: unknown[] = []): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'req_preflight',
    revision: 1,
    title: 'Request preflight',
    direction: { intent: 'preflight', looks: [{ id: 'default', description: 'Default look' }], transitions: [] },
    assets,
    bindings: {},
    sources,
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: 'scene' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'default', intent: 'shot', targetFrames: 48 }],
      placements: [{ id: 'pl', shot: 'shot', source: 'src', inFrame: 0, outFrame: 48, startFrame: 0, audio: 'mute' }],
      transitions: [],
      audio: [],
    },
  });
}

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function writeProject(root: string, project: Project): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
  // Materialize referenced image Assets so the read-only identity pass has real
  // bytes to hash (the preflight still uploads nothing).
  for (const asset of project.assets) if (asset.type === 'image') await writeFile(join(root, asset.path), PNG_1X1);
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-req-preflight-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const codes = (issues: readonly { code: string }[]): string[] => issues.map(issue => issue.code);

test('case 2: a remote plaintext HTTP endpoint is a Plan BLOCKER, not buildable', async () => {
  await withRoot(async root => {
    const source = {
      id: 'src',
      kind: 'provider',
      output: 'picture',
      endpoint: 'ep',
      model: 'some-model',
      prompt: 'p',
      mode: 'text',
      references: [],
      requestedFrames: 48,
      size: '1280:720',
      attempt: 'a1',
    };
    await writeProject(root, makeProject([source]));
    const plan = await planBuild(root, {
      providers: {
        videoApi: {
          ep: {
            endpoint: { protocol: 'vllm-omni-video', baseUrl: 'http://example.com' },
            authorization: { submit: true },
          },
        },
      },
    });
    assert.equal(plan.buildable, false);
    assert.ok(
      codes(plan.blockers).includes('video-endpoint-invalid'),
      `expected video-endpoint-invalid, got ${JSON.stringify(codes(plan.blockers))}`,
    );
    assert.equal(await exists(join(root, '.viscraft')), false, 'a blocked Plan writes no provider state');
  });
});

test('case 1: a mapping that returns a protocol-reserved field is reported by the generate-image preflight before any upload', async () => {
  await withRoot(async root => {
    await createProject(root, { title: 'Reserved fields' });
    const extension = {
      model: { id: 'reserved-fields', medium: 'image' as const, parameters: z.object({}).strict(), validate() {} },
      mapping: {
        model: 'reserved-fields',
        protocol: 'vllm-omni-image',
        validate() {},
        imageFields: () => ({ prompt: 'override' }),
      },
      implementationFiles: [fileURLToPath(import.meta.url)],
    };
    const report = await preflightGenerateImage(
      root,
      {
        id: 's',
        attempt: 1,
        asset: 'out',
        rights: { origin: 'o', license: 'CC0-1.0', redistributable: true },
        endpoint: 'ep',
        operation: 'generate',
        model: 'reserved-fields',
        prompt: 'p',
      },
      {
        providers: {
          imageApi: {
            ep: {
              endpoint: { protocol: 'vllm-omni-image', baseUrl: 'http://127.0.0.1:9' },
              authorization: { submit: true },
              extension,
            },
          },
        },
      },
    );
    assert.equal(report.ok, false);
    assert.ok(
      report.issues.some(issue => issue.code === 'request-invalid' && /reserved|prompt/i.test(issue.message)),
      `expected a reserved-field issue, got ${JSON.stringify(report.issues)}`,
    );
    assert.equal(
      await exists(join(root, '.viscraft/jobs')),
      false,
      'the preflight uploads/POSTs nothing and writes no provider state',
    );
  });
});

test('case 3: a transmitted reference without per-Asset consent is a Plan APPROVAL', async () => {
  await withRoot(async root => {
    const source = {
      id: 'src',
      kind: 'provider',
      output: 'picture',
      endpoint: 'ep',
      model: 'some-model',
      prompt: 'p',
      mode: 'first-last-frame',
      references: [{ asset: 'hero', category: 'image', role: 'first-frame' }],
      requestedFrames: 48,
      size: '1280:720',
      attempt: 'a1',
    };
    await writeProject(root, makeProject([source], [imageAsset('hero')]));
    const plan = await planBuild(root, {
      providers: {
        videoApi: {
          ep: {
            endpoint: { protocol: 'vllm-omni-video', baseUrl: 'https://example.test' },
            authorization: { submit: true },
          },
        },
      },
    });
    assert.ok(
      codes(plan.requiresApproval).includes('video-upload-not-authorized'),
      `expected video-upload-not-authorized, got ${JSON.stringify(codes(plan.requiresApproval))}`,
    );
    assert.equal(plan.buildable, false, 'an unauthorized transmission is not buildable');
    assert.equal(
      await exists(join(root, '.viscraft')),
      false,
      'a Plan that needs an approval writes no provider state',
    );
  });
});

test('case 4: a missing credential is provider CONFIGURATION, reported before any submit approval', async () => {
  await withRoot(async root => {
    const envName = 'VISCRAFT_PREFLIGHT_UNSET_KEY';
    delete process.env[envName];
    const source = {
      id: 'src',
      kind: 'provider',
      output: 'picture',
      endpoint: 'ep',
      model: 'some-model',
      prompt: 'p',
      mode: 'text',
      references: [],
      requestedFrames: 48,
      size: '1280:720',
      attempt: 'a1',
    };
    await writeProject(root, makeProject([source]));
    const plan = await planBuild(root, {
      providers: {
        videoApi: {
          ep: {
            endpoint: { protocol: 'vllm-omni-video', baseUrl: 'https://example.test', credential: envName },
            authorization: { submit: true },
          },
        },
      },
    });
    assert.ok(
      codes(plan.needsConfiguration).includes('video-credential-missing'),
      `expected video-credential-missing, got ${JSON.stringify(codes(plan.needsConfiguration))}`,
    );
    assert.deepEqual(codes(plan.requiresApproval), [], 'missing setup is not reported as a consent question');
    assert.match(plan.needsConfiguration[0]!.message, /viscraft auth set VISCRAFT_PREFLIGHT_UNSET_KEY/);
    assert.equal(plan.buildable, false);
  });
});

test('positive control: a fully configured, authorized, consented request has no blocker or approval', async () => {
  await withRoot(async root => {
    const source = {
      id: 'src',
      kind: 'provider',
      output: 'picture',
      endpoint: 'ep',
      model: 'some-model',
      prompt: 'p',
      mode: 'first-last-frame',
      references: [{ asset: 'hero', category: 'image', role: 'first-frame' }],
      requestedFrames: 48,
      size: '1280:720',
      attempt: 'a1',
    };
    await writeProject(root, makeProject([source], [imageAsset('hero')]));
    const plan = await planBuild(root, {
      providers: {
        videoApi: {
          ep: {
            endpoint: { protocol: 'vllm-omni-video', baseUrl: 'https://example.test' },
            authorization: { submit: true, uploadAssets: ['hero'] },
          },
        },
      },
    });
    assert.deepEqual(plan.blockers, [], 'no blocker for a valid request');
    assert.deepEqual(codes(plan.requiresApproval), [], 'no approval for a valid, consented request');
  });
});

test('a valid Runway plan still reports no blocker (no regression)', async () => {
  await withRoot(async root => {
    const source = {
      id: 'src',
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
    await writeProject(root, makeProject([source]));
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
    assert.deepEqual(plan.blockers, []);
    assert.deepEqual(codes(plan.requiresApproval), []);
  });
});
