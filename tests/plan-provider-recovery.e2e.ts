// Plan-level recovery, authorization and configuration facts for `provider`
// Sources.
//
// A generation attempt is a persisted, billed fact. Plan must read the SAME
// record the adapter enforces, so:
//  - a NEW request asks for spend/upload authorization;
//  - a request that was already submitted resumes without asking again;
//  - a finished attempt whose bytes are local needs neither an Endpoint nor a key;
//  - an ambiguous/terminal outcome or a changed request is refused, never retried;
//  - and none of this creates a record, uploads a byte or sends a request.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProjectSchema, buildProject, planBuild } from '../src/index.js';
import { providerReadiness } from '../src/config/readiness.js';
import { VideoApiPendingError, generateVideoApi } from '../src/backends/providers/services/video-tasks.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import type { Project } from '../src/index.js';
import type { ProviderSource } from '../src/core/schema.js';

const OUTPUT = {
  width: 64,
  height: 48,
  fps: { numerator: 24, denominator: 1 },
  sampleRate: 48000,
  channels: 2,
} as const;

const JOB_REL = 'video-api/plan_recovery.1.json';

function makeProject(prompt: string): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'plan_recovery',
    revision: 1,
    title: 'Plan recovery',
    direction: { intent: 'preflight', looks: [{ id: 'default', description: 'Default look' }], transitions: [] },
    assets: [],
    bindings: {},
    sources: [
      {
        id: 'plan_recovery',
        kind: 'provider',
        output: 'picture',
        endpoint: 'ep',
        model: 'some-model',
        prompt,
        mode: 'text',
        references: [],
        requestedFrames: 24,
        size: '64:48',
        fps: 24,
        attempt: '1',
      },
    ],
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: 'scene' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'default', intent: 'shot', targetFrames: 24 }],
      placements: [
        { id: 'pl', shot: 'shot', source: 'plan_recovery', inFrame: 0, outFrame: 24, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio: [],
    },
  });
}

async function writeProject(root: string, project: Project): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-plan-recovery-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A loopback service that accepts one task and then reports it as still running. */
async function withService(fn: (service: { baseUrl: string; posts: () => number }) => Promise<void>): Promise<void> {
  let posts = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST') {
      posts += 1;
      req.resume();
      res.end(JSON.stringify({ id: 'task-1' }));
      return;
    }
    res.end(JSON.stringify({ status: 'in_progress' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await fn({ baseUrl: `http://127.0.0.1:${address.port}`, posts: () => posts });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

const optionsFor = (baseUrl: string) => ({
  providers: {
    videoApi: {
      ep: {
        endpoint: { protocol: 'vllm-omni-video' as const, baseUrl },
        authorization: { submit: true },
      },
    },
  },
});

test('a new request asks for submission consent; planning it sends nothing', async () => {
  await withRoot(async root => {
    await withService(async service => {
      await writeProject(root, makeProject('first'));
      // The Endpoint is configured but NOT authorized for submission.
      const plan = await planBuild(root, {
        providers: {
          videoApi: {
            ep: { endpoint: { protocol: 'vllm-omni-video' as const, baseUrl: service.baseUrl } },
          },
        },
      });
      assert.equal(service.posts(), 0, 'Plan must never submit');
      assert.ok(
        plan.requiresApproval.some(issue => issue.code === 'video-submit-not-authorized'),
        `an unauthorized Endpoint must ask for consent: ${JSON.stringify(plan.requiresApproval)}`,
      );
      assert.equal(plan.buildable, false);
    });
  });
});

test('an already-submitted attempt resumes without asking for spend or upload consent', async () => {
  await withRoot(async root => {
    await withService(async service => {
      await writeProject(root, makeProject('first'));
      const options = { ...optionsFor(service.baseUrl).providers.videoApi.ep, references: [] };
      const source = (await importProject(root)).sources[0] as ProviderSource;
      await assert.rejects(
        () => generateVideoApi(root, source, OUTPUT, 'build/take.mp4', options),
        VideoApiPendingError,
      );
      assert.equal(service.posts(), 1);

      // The same Source, now recorded as submitted: resume, not a new decision.
      const plan = await planBuild(root, optionsFor(service.baseUrl));
      assert.equal(service.posts(), 1, 'Plan must not submit again');
      assert.equal(
        plan.requiresApproval.some(issue => issue.code === 'video-submit-not-authorized'),
        false,
        'continuing a known task is not a new spend decision',
      );
      assert.ok(plan.pending.some(issue => issue.code === 'provider-attempt-resume'));
      assert.equal(plan.buildable, true);
    });
  });
});

test('a changed request under a used attempt is refused, and an ambiguous or failed attempt is never retried', async () => {
  await withRoot(async root => {
    await withService(async service => {
      await writeProject(root, makeProject('first'));
      const options = { ...optionsFor(service.baseUrl).providers.videoApi.ep, references: [] };
      const source = (await importProject(root)).sources[0] as ProviderSource;
      await assert.rejects(
        () => generateVideoApi(root, source, OUTPUT, 'build/take.mp4', options),
        VideoApiPendingError,
      );

      // Changed authored request, same attempt.
      await writeProject(root, makeProject('changed'));
      const changed = await planBuild(root, optionsFor(service.baseUrl));
      assert.ok(
        changed.blockers.some(issue => issue.code === 'provider-attempt-request-changed'),
        JSON.stringify(changed.blockers),
      );
      assert.equal(service.posts(), 1);

      // Restore the matching request, then tamper with the recorded outcome.
      await writeProject(root, makeProject('first'));
      const jobFile = join(root, '.viscraft/jobs', JOB_REL);
      const record = JSON.parse(await readFile(jobFile, 'utf8')) as Record<string, unknown>;
      for (const [state, code] of [
        ['submit-unknown', 'provider-submit-indeterminate'],
        ['failed', 'provider-attempt-terminal'],
      ] as const) {
        await writeFile(jobFile, JSON.stringify({ ...record, state }), 'utf8');
        const plan = await planBuild(root, optionsFor(service.baseUrl));
        assert.ok(
          plan.blockers.some(issue => issue.code === code),
          `${state} must be ${code}: ${JSON.stringify(plan.blockers)}`,
        );
        assert.equal(service.posts(), 1, 'a terminal/unknown attempt must never be resubmitted');
      }
    });
  });
});

test('a finished attempt whose bytes are local needs no Endpoint, credential or consent', async () => {
  await withRoot(async root => {
    await withService(async service => {
      await writeProject(root, makeProject('first'));
      const options = { ...optionsFor(service.baseUrl).providers.videoApi.ep, references: [] };
      const source = (await importProject(root)).sources[0] as ProviderSource;
      await assert.rejects(
        () => generateVideoApi(root, source, OUTPUT, 'build/take.mp4', options),
        VideoApiPendingError,
      );
      const jobFile = join(root, '.viscraft/jobs', JOB_REL);
      const record = JSON.parse(await readFile(jobFile, 'utf8')) as Record<string, unknown>;
      // The provider finished and its normalized Take is in the project.
      const takeRel = 'build/take.mp4';
      await mkdir(join(root, 'build'), { recursive: true });
      await runCommand('ffmpeg', [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-threads',
        '1',
        '-f',
        'lavfi',
        '-i',
        'color=c=red:s=64x48:r=24:d=1',
        '-frames:v',
        '24',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        join(root, takeRel),
      ]);
      const artifactSha256 = await hashFile(join(root, takeRel));
      await writeFile(
        jobFile,
        JSON.stringify({
          ...record,
          state: 'succeeded',
          artifactPath: takeRel,
          artifactSha256,
          artifactOutput: OUTPUT,
        }),
        'utf8',
      );

      // With verified local bytes, a completed Take is local data.
      const verifiedPlan = await planBuild(root, {});
      assert.ok(
        verifiedPlan.pending.some(issue => issue.code === 'provider-attempt-local'),
        JSON.stringify(verifiedPlan.pending),
      );

      // A second Source is ready to submit. If the first Source's cached Take is
      // corrupted but still exists, Build must classify it as a remote resume;
      // with its Endpoint absent, the global preflight blocks before Source two
      // can create another paid task.
      const project = (await importProject(root)) as Project;
      const first = project.sources[0] as ProviderSource;
      project.sources.push({ ...first, id: 'second', endpoint: 'ep2', prompt: 'second task', attempt: '1' });
      project.composition!.shots.push({
        id: 'second-shot',
        scene: 'scene',
        look: 'default',
        intent: 'second source',
        targetFrames: 24,
      });
      project.composition!.placements.push({
        id: 'second-placement',
        shot: 'second-shot',
        source: 'second',
        inFrame: 0,
        outFrame: 24,
        startFrame: 24,
        audio: 'mute',
      });
      await writeProject(root, project);
      await writeFile(
        jobFile,
        JSON.stringify({
          ...JSON.parse(await readFile(jobFile, 'utf8')),
          artifactSha256: 'a'.repeat(64),
        }),
        'utf8',
      );
      await assert.rejects(
        buildProject(root, { providers: { videoApi: { ep2: { testOnly: { baseUrl: service.baseUrl } } } } }),
        /endpoint.*not configured|not configured.*endpoint/i,
      );
      assert.equal(service.posts(), 1, 'a damaged local result blocks the Build before Source two submits');

      const plan = await planBuild(root, {});
      assert.equal(
        plan.needsConfiguration.some(issue => issue.code === 'video-endpoint-not-configured'),
        true,
        'a damaged local artifact must be classified as a resume requiring its service',
      );
      assert.equal(service.posts(), 1);
    });
  });
});

test('readiness reports an undeclared credential as unknown, not as "not required"', async () => {
  const home = await mkdtemp(join(tmpdir(), 'viscraft-readiness-'));
  const previous = process.env.VISCRAFT_CONFIG_HOME;
  process.env.VISCRAFT_CONFIG_HOME = home;
  try {
    await writeFile(
      join(home, 'endpoints.json'),
      JSON.stringify({
        video: [
          {
            endpoint: 'generic',
            service: 'vllm-omni',
            model: 'minimax-h3-base-ref2va',
            url: 'https://service.example.test',
          },
          {
            endpoint: 'plaintext',
            service: 'vllm-omni',
            model: 'minimax-h3-base-ref2va',
            url: 'http://service.example.test',
          },
          {
            endpoint: 'always_authed',
            service: 'ark',
            model: 'seedance-2.5',
            deploymentModel: 'account-model',
            url: 'https://ark.example.test',
          },
        ],
        image: [{ endpoint: 'malformed', protocol: 'vllm-omni-image' }],
      }),
      'utf8',
    );
    const readiness = providerReadiness();
    const generic = readiness.capabilities.provider.endpoints[0]!;
    assert.equal(generic.credential, null);
    assert.equal(
      generic.credentialSource,
      'unknown',
      'a generic deployment that names no credential may still require one',
    );
    assert.equal(generic.ready, true, 'the declared URL and protocol are configured');
    assert.equal(generic.problem, null);

    // The SAME URL rule the lanes enforce is applied here, so a configuration
    // that would be refused before a request is never reported as ready.
    assert.ok(!readiness.capabilities.provider.endpoints.some(entry => entry.endpoint === 'plaintext'));
    assert.match(readiness.error ?? '', /HTTPS|loopback/);
    // A protocol that ALWAYS authenticates must not be reported as ready without a
    // key, and must not be softened into the generic "unknown" state.
    const alwaysAuthed = readiness.capabilities.provider.endpoints[1]!;
    assert.equal(alwaysAuthed.credentialSource, 'missing');
    assert.equal(alwaysAuthed.ready, false);
    // A missing required field is a loud configuration error, not a silent drop.
    assert.match(readiness.error ?? '', /malformed/);
  } finally {
    if (previous === undefined) delete process.env.VISCRAFT_CONFIG_HOME;
    else process.env.VISCRAFT_CONFIG_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test('resuming an existing task needs the service credential but asks for no new consent', async () => {
  await withRoot(async root => {
    await withService(async service => {
      await writeProject(root, makeProject('first'));
      const endpoint = {
        protocol: 'vllm-omni-video' as const,
        baseUrl: service.baseUrl,
        credential: 'VISCRAFT_TEST_RECOVERY_KEY',
      };
      const options = { endpoint, authorization: { submit: true }, references: [] };
      const source = (await importProject(root)).sources[0] as ProviderSource;
      process.env.VISCRAFT_TEST_RECOVERY_KEY = 'test-only-value';
      try {
        await assert.rejects(
          () => generateVideoApi(root, source, OUTPUT, 'build/take.mp4', options),
          VideoApiPendingError,
        );
      } finally {
        delete process.env.VISCRAFT_TEST_RECOVERY_KEY;
      }
      assert.equal(service.posts(), 1);

      const plan = await planBuild(root, { providers: { videoApi: { ep: { endpoint } } } });
      assert.equal(service.posts(), 1, 'Plan must not submit again');
      assert.ok(
        plan.needsConfiguration.some(issue => issue.code === 'video-credential-missing'),
        `a resume needs the key that continues the known task: ${JSON.stringify(plan.needsConfiguration)}`,
      );
      assert.equal(
        plan.requiresApproval.some(issue => issue.code === 'video-submit-not-authorized'),
        false,
        'continuing a known task is not a new spend decision',
      );
    });
  });
});

test('a resumed attempt is recognized without re-reading reference bytes that are gone', async () => {
  await withRoot(async root => {
    await withService(async service => {
      const bytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      );
      await writeFile(join(root, 'ref.png'), bytes);
      const ref = {
        id: 'ref',
        revision: 1,
        path: 'ref.png',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        type: 'image' as const,
        rights: { origin: 'test', license: 'test-only', redistributable: false },
        simulated: false,
      };
      const project = makeProject('first');
      project.assets = [ref];
      const authored = project.sources[0] as ProviderSource;
      authored.references = [{ asset: 'ref', category: 'image', role: 'first-frame' }];
      authored.mode = 'first-last-frame';
      await writeProject(root, project);

      const endpoint = { protocol: 'vllm-omni-video' as const, baseUrl: service.baseUrl };
      const options = {
        endpoint,
        authorization: { submit: true, uploadAssets: ['ref'] },
        references: [{ root, asset: ref }],
      };
      const source = (await importProject(root)).sources[0] as ProviderSource;
      await assert.rejects(
        () => generateVideoApi(root, source, OUTPUT, 'build/take.mp4', options),
        VideoApiPendingError,
      );
      assert.equal(service.posts(), 1);

      // The bytes are gone, but the attempt is already submitted: recovery must
      // not re-read them, and must not report a model-rule failure.
      await rm(join(root, 'ref.png'));
      const plan = await planBuild(root, { providers: { videoApi: { ep: { endpoint } } } });
      assert.equal(service.posts(), 1, 'Plan must not submit again');
      assert.ok(
        plan.pending.some(issue => issue.code === 'provider-attempt-resume'),
        JSON.stringify(plan.pending),
      );
      assert.equal(
        plan.blockers.some(
          issue => issue.code === 'reference-media-unreadable' || issue.code === 'model-request-invalid',
        ),
        false,
        `a resume must not probe the reference: ${JSON.stringify(plan.blockers)}`,
      );
    });
  });
});

test('Plan rejects a provider Asset whose present bytes changed even when its declaration and attempt hash did not', async () => {
  await withRoot(async root => {
    await withService(async service => {
      const bytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      );
      await writeFile(join(root, 'ref.png'), bytes);
      const ref = {
        id: 'ref',
        revision: 1,
        path: 'ref.png',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        type: 'image' as const,
        rights: { origin: 'test', license: 'test-only', redistributable: false },
        simulated: false,
      };
      const project = makeProject('first');
      project.assets = [ref];
      const authored = project.sources[0] as ProviderSource;
      authored.references = [{ asset: 'ref', category: 'image', role: 'first-frame' }];
      authored.mode = 'first-last-frame';
      await writeProject(root, project);
      const endpoint = { protocol: 'vllm-omni-video' as const, baseUrl: service.baseUrl };
      const options = {
        endpoint,
        authorization: { submit: true, uploadAssets: ['ref'] },
        references: [{ root, asset: ref }],
      };
      const source = (await importProject(root)).sources[0] as ProviderSource;
      await assert.rejects(
        () => generateVideoApi(root, source, OUTPUT, 'build/take.mp4', options),
        VideoApiPendingError,
      );
      assert.equal(service.posts(), 1);
      // Keep the Asset declaration and the already-submitted job untouched while
      // replacing the actual bytes at the same path.
      await writeFile(join(root, 'ref.png'), Buffer.from('different bytes at the declared path'));
      const plan = await planBuild(root, { providers: { videoApi: { ep: { endpoint } } } });
      assert.ok(
        plan.blockers.some(issue => issue.code === 'reference-media-changed'),
        JSON.stringify(plan.blockers),
      );
      assert.equal(service.posts(), 1, 'stale bytes cannot trigger another submit');
    });
  });
});

test('an unreadable or unsupported attempt record blocks instead of looking like a new request', async () => {
  await withRoot(async root => {
    await withService(async service => {
      await writeProject(root, makeProject('first'));
      const options = { ...optionsFor(service.baseUrl).providers.videoApi.ep, references: [] };
      const source = (await importProject(root)).sources[0] as ProviderSource;
      await assert.rejects(
        () => generateVideoApi(root, source, OUTPUT, 'build/take.mp4', options),
        VideoApiPendingError,
      );
      assert.equal(service.posts(), 1);
      const jobFile = join(root, '.viscraft/jobs', JOB_REL);

      for (const corrupt of ['{not json', JSON.stringify({ schemaVersion: 99 })]) {
        await writeFile(jobFile, corrupt, 'utf8');
        const plan = await planBuild(root, optionsFor(service.baseUrl));
        assert.ok(
          plan.blockers.some(issue => issue.code === 'provider-attempt-unreadable'),
          `an unreadable record must never be treated as new: ${JSON.stringify(plan.blockers)}`,
        );
        assert.equal(
          plan.requiresApproval.some(issue => issue.code === 'video-submit-not-authorized'),
          false,
          'an unreadable record must not be presented as an authorizable new request',
        );
        assert.equal(service.posts(), 1, 'Plan must not submit');
      }
      // The evidence itself is untouched: never migrated, never replaced.
      assert.equal(await readFile(jobFile, 'utf8'), JSON.stringify({ schemaVersion: 99 }));
    });
  });
});

test('an attempt is bound to its service address, not just its prompt', async () => {
  await withRoot(async root => {
    await withService(async service => {
      await writeProject(root, makeProject('first'));
      const options = { ...optionsFor(service.baseUrl).providers.videoApi.ep, references: [] };
      const source = (await importProject(root)).sources[0] as ProviderSource;
      await assert.rejects(
        () => generateVideoApi(root, source, OUTPUT, 'build/take.mp4', options),
        VideoApiPendingError,
      );
      assert.equal(service.posts(), 1);

      // Same authored request, different deployment: the durable routing identity
      // must refuse the reuse instead of reporting a resumable task.
      const moved = `http://127.0.0.1:${Number(new URL(service.baseUrl).port) + 1}`;
      const plan = await planBuild(root, {
        providers: { videoApi: { ep: { endpoint: { protocol: 'vllm-omni-video', baseUrl: moved } } } },
      });
      assert.ok(
        plan.blockers.some(
          issue => issue.code === 'provider-attempt-request-changed' && /endpoint/.test(issue.message),
        ),
        JSON.stringify(plan.blockers),
      );
      assert.equal(plan.requiresApproval.length, 0, 'a changed request is not an authorization question');
      assert.equal(service.posts(), 1, 'Plan must not submit');
    });
  });
});

test('the external fact follows the configured address, not a guess about cost or keys', async () => {
  await withRoot(async root => {
    await writeProject(root, makeProject('first'));
    const of = async (baseUrl: string) =>
      (
        await planBuild(root, {
          providers: { videoApi: { ep: { endpoint: { protocol: 'vllm-omni-video', baseUrl } } } },
        })
      ).sources[0]!.external;
    assert.equal(await of('http://127.0.0.1:9'), false, 'a loopback deployment stays on this machine');
    assert.equal(await of('https://service.example.test'), true, 'a remote deployment leaves it');
  });
});

/** Load the Project a test just wrote (the adapter validates its own boundary). */
async function importProject(root: string): Promise<Project> {
  const raw = JSON.parse(await readFile(join(root, 'project.json'), 'utf8')) as unknown;
  return ProjectSchema.parse(raw);
}
