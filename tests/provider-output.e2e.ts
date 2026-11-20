// A `provider` author Source must DECLARE its picture medium (`output:
// 'picture'`) in the strict current contract, exactly like the `browser` and
// `blender` Sources. Missing, wrong or unknown `output` is REJECTED loudly (no
// implicit default), while the `simulated` test double keeps
// its own shape with NO `output` field.
//
// The second half proves the legal provider shape is not merely accepted by the
// schema: it flows through the real Plan -> (simulated) execution -> select-Take
// -> delivery/continue loop against a loopback HTTP fixture (real FFmpeg bytes,
// never model inference), and no step resubmits.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SourceSchema } from '../src/core/schema.js';
import type { Project } from '../src/core/schema.js';
import { buildProject, deliverProject, loadProject, planBuild, saveProject, validateProject } from '../src/index.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';

/** A minimal schema-legal `provider` Source; overrides make an illegal variant. */
const legalProvider = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'prov',
  kind: 'provider',
  output: 'picture',
  endpoint: 'default',
  model: 'fixture-video',
  prompt: 'SIMULATED contract fixture',
  mode: 'text',
  references: [],
  requestedFrames: 12,
  size: '96:64',
  fps: 12,
  attempt: 'a1',
  ...overrides,
});

test('provider missing output is rejected', () => {
  const { output: _output, ...noOutput } = legalProvider();
  const result = SourceSchema.safeParse(noOutput);
  assert.equal(result.success, false, 'a provider Source without `output` must be rejected');
});

test('provider wrong output is rejected', () => {
  const result = SourceSchema.safeParse(legalProvider({ output: 'sound' }));
  assert.equal(result.success, false, 'there is no provider audio capability; `output: "sound"` must be rejected');
});

test('provider unknown field is rejected', () => {
  const result = SourceSchema.safeParse(legalProvider({ medium: 'picture' }));
  assert.equal(result.success, false, 'an unknown key must be rejected by the strict object, not ignored');
});

test('a legal picture provider is accepted; a simulated test double keeps no output field', () => {
  const provider = SourceSchema.safeParse(legalProvider());
  assert.equal(provider.success, true, 'the declared picture provider is legal');
  if (provider.success) assert.equal(provider.data.kind === 'provider' && provider.data.output, 'picture');

  // The test double is NOT tidied together with the author executors: it has no
  // `output` field at all, and one must not be silently accepted either.
  const simulated = SourceSchema.safeParse({
    id: 'sim',
    kind: 'simulated',
    prompt: 'x',
    frames: 48,
    attempt: 'a1',
    behavior: 'success',
  });
  assert.equal(simulated.success, true, 'the simulated test double keeps its own no-output shape');
  const simulatedWithOutput = SourceSchema.safeParse({
    id: 'sim',
    kind: 'simulated',
    output: 'picture',
    prompt: 'x',
    frames: 48,
    attempt: 'a1',
    behavior: 'success',
  });
  assert.equal(simulatedWithOutput.success, false, 'the simulated test double must not gain an output field');
});

test('a legal picture provider plans, executes (simulated), selects a Take and continues without resubmission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-provider-output-'));
  const destination = `${root}-handoff`;
  let posts = 0;
  let gets = 0;
  let downloads = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/videos') {
        posts++;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: `fixture_${posts}`, status: 'queued' }));
      } else if (/^\/v1\/videos\/fixture_\d+\/content$/.test(req.url ?? '')) {
        downloads++;
        readFile(join(root, 'proxy.mp4')).then(
          bytes => {
            res.setHeader('content-type', 'video/mp4');
            res.end(bytes);
          },
          () => {
            res.statusCode = 500;
            res.end();
          },
        );
      } else if (/^\/v1\/videos\/fixture_\d+$/.test(req.url ?? '')) {
        gets++;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: req.url!.split('/').at(-1), status: 'completed', error: null }));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  try {
    await runCommand('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-threads',
      '1',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=96x64:rate=24:duration=1',
      '-frames:v',
      '24',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-an',
      join(root, 'proxy.mp4'),
    ]);
    const project: Project = validateProject({
      schemaVersion: 1,
      id: 'provider-output',
      revision: 1,
      title: 'E3 provider output picture',
      direction: {
        intent: 'test-only provider lifecycle',
        looks: [{ id: 'look', description: 'fixture' }],
        transitions: [],
      },
      assets: [
        {
          id: 'proxy',
          revision: 1,
          path: 'proxy.mp4',
          sha256: await hashFile(join(root, 'proxy.mp4')),
          type: 'video',
          rights: { origin: 'Original FFmpeg test pattern', license: 'CC0-1.0', redistributable: true },
          simulated: false,
        },
      ],
      bindings: {},
      sources: [SourceSchema.parse(legalProvider({ id: 'prov' }))],
      composition: {
        output: { width: 96, height: 64, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 2 },
        scenes: [{ id: 'scene', description: 'scene' }],
        shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: 'shot', targetFrames: 12 }],
        placements: [
          { id: 'edit', shot: 'shot', source: 'prov', inFrame: 0, outFrame: 12, startFrame: 0, audio: 'mute' },
        ],
        transitions: [],
        audio: [],
      },
    });
    await writeFile(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const options = {
      providers: { videoApi: { default: { testOnly: { baseUrl: `http://127.0.0.1:${address.port}` } } } },
    };

    // 1. PLAN: the legal picture provider plans as buildable under the configured
    //    loopback endpoint, and planning performs zero network I/O.
    const plan = await planBuild(root, options);
    assert.equal(plan.buildable, true, 'a configured picture provider is buildable');
    assert.equal(posts, 0, 'planning must not submit');
    assert.equal(gets, 0, 'planning must not poll');
    assert.ok(plan.work.some(entry => entry.subject === 'prov' && entry.kind === 'provider'));

    // 2. EXECUTE (simulated transport): the Take is produced from the loopback
    //    fixture and carries `simulated` provenance.
    const build = await buildProject(root, options);
    assert.equal(build.status, 'succeeded');
    assert.equal(posts, 1, 'one real POST produces the Take');
    const take = build.takes.find(candidate => candidate.source === 'prov');
    assert.ok(take, 'the provider Source produces a Take');
    assert.equal(take!.simulated, true);
    assert.equal(build.result!.simulated, true);

    // 3. SELECT: replace the Source placement with the produced Take. The provider
    //    Source is no longer referenced, so a rebuild reuses the Take (no POST).
    const selected = await loadProject(root);
    selected.composition!.placements = [
      { id: 'edit', shot: 'shot', take: take!.id, inFrame: 0, outFrame: 12, startFrame: 0, audio: 'mute' },
    ];
    await saveProject(root, selected, selected.revision);
    const final = await buildProject(root);
    assert.equal(final.status, 'succeeded');
    assert.equal(final.result!.simulated, true);
    assert.equal(posts, 1, 'selecting an existing Take must not submit again');

    // 4. CONTINUE: hand the work over with `deliver `, reopen the
    //    exported project and rebuild — every operation is reused, no resubmission.
    const delivery = await deliverProject(root, destination, {});
    assert.ok(delivery.project, 'the continue delivery bundles the editable project');
    const portable = join(destination, delivery.project!.path);
    const reopened = await buildProject(portable);
    assert.equal(reopened.status, 'succeeded');
    assert.ok(
      reopened.operations.every(operation => operation.reused),
      'the reopened build reuses the Take',
    );
    assert.equal(posts, 1, 'the continue/reopen loop must not resubmit');
    assert.equal(gets, 1);
    assert.equal(downloads, 1);
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    await rm(destination, { recursive: true, force: true });
  }
});
