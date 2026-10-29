// The packaged model REGISTRY auto-selects a model DEFINITION + service mapping
// from the canonical identity a request already carries — `(source.model,
// endpoint.protocol)` — so a user who writes only `endpoints.json` (no
// run-options `GenerationExtension`) gets the packaged model for the canonical
// name they authored. The DEPLOYMENT alias `endpoint.model` is only the wire field
// and never selects or validates a definition.
//
// These tests pin model discovery and service selection:
//   - one registry match auto-selects (Ark/H3/Runway gen4.5 AND gen4_turbo/fal);
//   - the alias is sent while validation uses the canonical definition;
//   - a Source naming an unpackaged model is `needsConfiguration` (NOT a blocker,
//     NEVER a silent substitute);
//   - a canonical name misplaced in `endpoint.model` is not "guessed";
//   - an explicit extension still wins;
//   - auto-selected and explicit copies of one packaged extension share a request
//     identity, while a changed alias changes it;
//   - a duplicate registry key is rejected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProjectSchema, planBuild, prepareVideoRequest, seedance25ArkExtension } from '../src/index.js';
import type { GenerationExtension, Project, ProviderSource } from '../src/index.js';
import { SourceSchema } from '../src/core/schema.js';
import {
  buildPackagedRegistry,
  packagedExtensionFor,
  packagedModelsForProtocol,
} from '../src/backends/providers/models/registry.js';
import { runwayGen45Extension } from '../src/backends/providers/models/runway-gen45.js';
import { generationExtensionIdentity } from '../src/backends/providers/extension.js';

const OUTPUT = { width: 64, height: 48, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 2 };
const RIGHTS = { origin: 'original registry test fixture', license: 'original test media', redistributable: true };
const SHA = 'a'.repeat(64);

const videoSource = (overrides: Record<string, unknown> = {}): ProviderSource =>
  SourceSchema.parse({
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
    ...overrides,
  }) as ProviderSource;

const imageAsset = (id: string) => ({
  id,
  revision: 1,
  type: 'image' as const,
  path: `${id}.png`,
  sha256: SHA,
  rights: RIGHTS,
  simulated: false,
});

function makeProject(source: unknown, asset?: unknown): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'model_registry',
    revision: 1,
    title: 'Model registry',
    direction: { intent: 'registry', looks: [{ id: 'default', description: 'Default look' }], transitions: [] },
    assets: asset ? [asset] : [],
    bindings: {},
    sources: [source],
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

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-model-registry-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeProject(root: string, project: Project, assetPaths: string[] = []): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const path of assetPaths) await writeFile(join(root, path), 'x', 'utf8');
  await writeFile(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
}

/** A loopback fixture that records every request; a Plan/preflight must send none. */
async function withLoopback(fn: (baseUrl: string, requests: string[]) => Promise<void>): Promise<void> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await fn(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    await new Promise<void>(done => server.close(() => done()));
  }
}

const CODES = (issues: readonly { code: string }[]) => issues.map(issue => issue.code);

// ---------------------------------------------------------------------------
// Registry selection: one canonical (model, protocol) match auto-selects.
// ---------------------------------------------------------------------------

const CANONICAL: {
  model: string;
  protocol: 'ark-video-v3' | 'vllm-omni-video' | 'runway-v1' | 'fal-queue';
  source: ProviderSource;
}[] = [
  {
    model: 'Seedance-2.5',
    protocol: 'ark-video-v3',
    source: videoSource({ model: 'Seedance-2.5', mode: 'text', size: '1280:720', parameters: { durationSeconds: 4 } }),
  },
  {
    model: 'minimax-h3-base-ref2va',
    protocol: 'vllm-omni-video',
    source: videoSource({
      model: 'minimax-h3-base-ref2va',
      mode: 'reference',
      references: [{ asset: 'hero', category: 'image', role: 'identity' }],
    }),
  },
  {
    model: 'gen4.5',
    protocol: 'runway-v1',
    source: videoSource({
      model: 'gen4.5',
      mode: 'text',
      size: '1280:720',
      parameters: { durationSeconds: 4, ratio: '1280:720' },
    }),
  },
  {
    model: 'gen4_turbo',
    protocol: 'runway-v1',
    source: videoSource({
      model: 'gen4_turbo',
      mode: 'first-last-frame',
      references: [{ asset: 'hero', category: 'image', role: 'first-frame' }],
      size: '720:1280',
      parameters: { ratio: '720:1280' },
    }),
  },
  {
    model: 'alibaba/wan-3.0/image-to-video',
    protocol: 'fal-queue',
    source: videoSource({
      model: 'alibaba/wan-3.0/image-to-video',
      mode: 'first-last-frame',
      references: [{ asset: 'hero', category: 'image', role: 'first-frame' }],
      size: '1280:720',
      parameters: { durationSeconds: 5, resolution: '720p', ratio: '16:9', audio: true },
    }),
  },
];

test('the registry resolves the packaged definition by the canonical (model, protocol)', () => {
  assert.deepEqual(packagedModelsForProtocol('runway-v1'), ['gen4.5', 'gen4_turbo']);
  assert.equal(packagedExtensionFor('gen4.5', 'runway-v1')?.model.id, 'gen4.5');
  assert.equal(packagedExtensionFor('gen4_turbo', 'runway-v1')?.model.id, 'gen4_turbo');
  assert.equal(packagedExtensionFor('minimax-h3-base-ref2va', 'vllm-omni-video')?.model.id, 'minimax-h3-base-ref2va');
  assert.equal(packagedExtensionFor('Seedance-2.5', 'ark-video-v3')?.model.id, 'Seedance-2.5');
  assert.equal(packagedExtensionFor('gen4_turbo', 'fal-queue'), undefined);
});

test('a duplicate (model, protocol) registry key is rejected, never silently resolved', () => {
  assert.throws(
    () => buildPackagedRegistry([runwayGen45Extension, runwayGen45Extension]),
    /Duplicate packaged model definition/,
  );
});

for (const { model, protocol, source } of CANONICAL) {
  test(`direct SDK auto-selects '${model}' for protocol '${protocol}' with no injected extension`, () => {
    const prepared = prepareVideoRequest(source, { endpoint: { protocol, baseUrl: 'https://example.test' } });
    assert.equal(
      prepared.extension?.model.id,
      model,
      'the packaged definition for the canonical model must be selected',
    );
    assert.equal(
      prepared.wireModel,
      prepared.extension?.mapping.wireModel ?? model,
      'the selected mapping supplies the service model name',
    );
    assert.ok(prepared.requestIdentity, 'a request identity is produced from the auto-selected definition');
  });
}

test('the deployment alias (endpoint.model) is what the wire body carries, while validation uses the canonical definition', () => {
  const source = videoSource({
    model: 'gen4.5',
    mode: 'text',
    size: '1280:720',
    parameters: { durationSeconds: 4, ratio: '1280:720' },
  });
  const prepared = prepareVideoRequest(source, {
    // A deployment alias that is NOT a known model id: the request is still
    // validated against the CANONICAL packaged gen4.5 definition and only the
    // wire field carries the alias.
    endpoint: { protocol: 'runway-v1', baseUrl: 'https://api.dev.runwayml.com', model: 'deployment-gen45-x' },
  });
  assert.equal(prepared.extension?.model.id, 'gen4.5');
  assert.equal(prepared.wireModel, 'deployment-gen45-x');
  assert.equal((prepared.mappingBody as { model: string }).model, 'deployment-gen45-x');
  assert.equal((prepared.requestIdentity as { model: string }).model, 'deployment-gen45-x');
});

// ---------------------------------------------------------------------------
// Plan auto-selects with ONLY configuration (no extension), zero POST.
// ---------------------------------------------------------------------------

for (const { model, protocol, source } of CANONICAL) {
  test(`Plan auto-selects '${model}' for '${protocol}' from configuration only, with zero POST`, async () => {
    await withLoopback(async (baseUrl, requests) => {
      await withRoot(async root => {
        const needsAsset = (source.references ?? []).length > 0;
        const project = makeProject(source, needsAsset ? imageAsset('hero') : undefined);
        await writeProject(root, project, needsAsset ? ['hero.png'] : []);

        const plan = await planBuild(root, {
          providers: {
            videoApi: {
              ep: {
                endpoint: { protocol, baseUrl: 'https://example.test' },
                testOnly: { baseUrl },
                authorization: { submit: true },
              },
            },
          },
        });

        assert.equal(
          CODES(plan.needsConfiguration).includes('video-model-not-configured'),
          false,
          `the packaged '${model}' must be auto-selected, not flagged as unconfigured`,
        );
        assert.equal(
          CODES(plan.blockers).includes('model-request-invalid'),
          false,
          `a valid canonical '${model}' request must not be a model-request-invalid blocker: ${JSON.stringify(plan.blockers)}`,
        );
        assert.deepEqual(requests, [], 'a Plan preflight subscribes nothing');
      });
    });
  });
}

// ---------------------------------------------------------------------------
// An unpackaged canonical model is `needsConfiguration`, never a blocker.
// ---------------------------------------------------------------------------

test('a Source naming an unpackaged model is needsConfiguration (not a blocker, not another definition)', async () => {
  await withRoot(async root => {
    const source = videoSource({ model: 'private-runway-model', mode: 'text', size: '1280:720' });
    await writeProject(root, makeProject(source));
    const plan = await planBuild(root, {
      providers: {
        videoApi: {
          ep: { endpoint: { protocol: 'runway-v1', baseUrl: 'https://example.test' }, authorization: { submit: true } },
        },
      },
    });
    const issue = plan.needsConfiguration.find(item => item.code === 'video-model-not-configured');
    assert.ok(issue, `expected video-model-not-configured, got ${JSON.stringify(CODES(plan.needsConfiguration))}`);
    assert.equal(issue!.level, 'needs_configuration');
    assert.match(issue!.message, /gen4\.5/);
    assert.match(issue!.message, /gen4_turbo/);
    assert.equal(
      CODES(plan.blockers).includes('model-request-invalid'),
      false,
      'a missing definition is not a blocker',
    );
    assert.equal(plan.buildable, false);
  });
});

test('a generic-protocol request WITH parameters and an unpackaged model is needsConfiguration, not a blocker', async () => {
  await withRoot(async root => {
    const source = videoSource({ model: 'private-generic', mode: 'text', parameters: { task: 'reference' } });
    await writeProject(root, makeProject(source));
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
    assert.equal(
      CODES(plan.needsConfiguration).includes('video-model-not-configured'),
      true,
      'a parametered request needs a definition',
    );
    assert.equal(CODES(plan.blockers).includes('model-request-invalid'), false);
  });
});

test('a canonical name misplaced in endpoint.model while the Source writes an alias is NOT guessed into a definition', async () => {
  await withRoot(async root => {
    const source = videoSource({ model: 'deployment-alias-x', mode: 'text', size: '1280:720' });
    await writeProject(root, makeProject(source));
    const plan = await planBuild(root, {
      providers: {
        videoApi: {
          ep: {
            endpoint: { protocol: 'runway-v1', baseUrl: 'https://example.test', model: 'gen4.5' },
            authorization: { submit: true },
          },
        },
      },
    });
    assert.equal(
      CODES(plan.needsConfiguration).includes('video-model-not-configured'),
      true,
      'the alias must not select the packaged gen4.5 definition',
    );
    assert.equal(CODES(plan.blockers).includes('model-request-invalid'), false);
  });
});

// ---------------------------------------------------------------------------
// An explicit extension still wins.
// ---------------------------------------------------------------------------

test('an explicit options.extension beats the auto-selected packaged definition', () => {
  const source = videoSource({
    model: 'gen4.5',
    mode: 'text',
    size: '1280:720',
    parameters: { durationSeconds: 4, ratio: '1280:720' },
  });
  const packaged = runwayGen45Extension();
  const custom: GenerationExtension = {
    implementationFiles: [fileURLToPath(import.meta.url)],
    model: packaged.model,
    mapping: { ...packaged.mapping, videoBody: (_s, _p, wireModel) => ({ model: wireModel, custom: true }) },
  };
  const prepared = prepareVideoRequest(source, {
    endpoint: { protocol: 'runway-v1', baseUrl: 'https://api.dev.runwayml.com' },
    extension: custom,
  });
  assert.equal(prepared.extension, custom, 'the caller-supplied extension must win over the packaged one');
  assert.equal((prepared.mappingBody as { custom?: boolean }).custom, true);
});

// ---------------------------------------------------------------------------
// Extension identity: auto == explicit; a changed deployment alias changes it.
// ---------------------------------------------------------------------------

test('auto-selected and explicitly-injected copies of one packaged extension share a request identity; a changed alias does not', async () => {
  const source = videoSource({
    model: 'gen4.5',
    mode: 'text',
    size: '1280:720',
    parameters: { durationSeconds: 4, ratio: '1280:720' },
  });
  const endpoint = { protocol: 'runway-v1' as const, baseUrl: 'https://api.dev.runwayml.com' };

  const auto = prepareVideoRequest(source, { endpoint });
  const explicit = prepareVideoRequest(source, { endpoint, extension: runwayGen45Extension() });
  assert.deepEqual(auto.requestIdentity, explicit.requestIdentity, 'auto and explicit selection must be identical');
  assert.deepEqual(auto.extension?.model.id, explicit.extension?.model.id);
  assert.equal(
    await generationExtensionIdentity({ extension: auto.extension }),
    await generationExtensionIdentity({ extension: explicit.extension }),
    'the extension identity is the same for both copies',
  );

  const aliased = prepareVideoRequest(source, { endpoint: { ...endpoint, model: 'deployment-gen45-x' } });
  assert.deepEqual(aliased.extension?.model.id, 'gen4.5', 'the alias does not change the selected definition');
  assert.notDeepEqual(
    auto.requestIdentity,
    aliased.requestIdentity,
    'a changed deployment alias must change the frozen request identity',
  );
});

// ---------------------------------------------------------------------------
// A sanity check that the packaged Seedance extension is still the Ark one.
// ---------------------------------------------------------------------------

test('Seedance remains the packaged ark-video-v3 extension', () => {
  assert.equal(seedance25ArkExtension().model.id, 'Seedance-2.5');
  assert.equal(packagedExtensionFor('Seedance-2.5', 'ark-video-v3')?.model.id, 'Seedance-2.5');
});
