// The production feasibility preflight (`planBuild`) and its timeline arithmetic.
//
// `planBuild` is a pure read: it answers what a Build WOULD do — the edit
// timeline arithmetic, each Source's expected length/audio, and which generation
// Sources need approval or are unsupported by their endpoint partition — WITHOUT
// any provider submission, upload or media write. These tests pin that contract
// and the exact timeline rules `composeVideo` enforces.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProjectSchema, analyzeTimeline, buildProject, loadProject, planBuild, saveProject } from '../src/index.js';
import { staticSourceAudio, staticSourceFrames } from '../src/build/plan.js';
import { hashFile } from '../src/shared/hash.js';
import type { Placement, Project, Transition } from '../src/index.js';

const OUTPUT = { width: 64, height: 48, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 2 };
const RIGHTS = { origin: 'original test fixture', license: 'original test media', redistributable: true };

/** A schema-valid Project with the given Sources/placements over a single shot. */
function makeProject(
  sources: unknown[],
  placements: unknown[] = [],
  assets: unknown[] = [],
  transitions: unknown[] = [],
): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'plan_unit',
    revision: 1,
    title: 'Plan unit',
    direction: { intent: 'preflight', looks: [{ id: 'default', description: 'Default look' }], transitions: [] },
    assets,
    bindings: {},
    sources,
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: 'scene' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'default', intent: 'shot', targetFrames: 48 }],
      placements,
      transitions,
      audio: [],
    },
  });
}

const SIMULATED = {
  id: 'src_sim',
  kind: 'simulated',
  prompt: 'x',
  frames: 48,
  attempt: 'attempt-1',
  behavior: 'success',
};
const SIM_PLACEMENT = {
  id: 'pl',
  shot: 'shot',
  source: 'src_sim',
  inFrame: 0,
  outFrame: 48,
  startFrame: 0,
  audio: 'mute',
};

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-plan-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test('a single simulated placement is buildable and plans one simulated work item', async () => {
  await withRoot(async root => {
    await writeProject(root, makeProject([SIMULATED], [SIM_PLACEMENT]));

    const plan = await planBuild(root);
    assert.equal(plan.kind, 'build-plan');
    assert.equal(plan.buildable, true);
    assert.deepEqual(plan.blockers, [], 'a clean simulated plan has no blockers');
    assert.equal(plan.timeline.totalFrames, 48);
    assert.equal(plan.timeline.contentFrames, 48);
    assert.equal(plan.timeline.placements, 1);

    const source = plan.sources.find(entry => entry.id === 'src_sim');
    assert.ok(source, 'the simulated Source is described');
    assert.equal(source!.simulated, true);
    assert.equal(source!.external, false, 'a simulated Source is not an external service');
    assert.equal(source!.expectedFrames, 48);
    assert.equal(source!.carriesAudio, false);

    const work = plan.work.find(entry => entry.subject === 'src_sim');
    assert.ok(work, 'the Source appears in the work list');
    assert.equal(work!.simulated, true);
    assert.equal(work!.kind, 'simulated');

    // Planning is a read: it must not create the provider job directory.
    assert.equal(await exists(join(root, '.viscraft', 'jobs')), false, 'the preflight submitted nothing');
  });
});

test('an unconfigured video endpoint requires approval', async () => {
  await withRoot(async root => {
    const sources = [
      {
        id: 'src_vid',
        kind: 'provider',
        output: 'picture',
        endpoint: 'ep',
        model: 'm',
        prompt: 'p',
        mode: 'text',
        requestedFrames: 48,
        size: '1280:720',
        seed: 0,
        attempt: 'a1',
      },
    ];
    const placements = [
      { id: 'pl_vid', shot: 'shot', source: 'src_vid', inFrame: 0, outFrame: 48, startFrame: 0, audio: 'mute' },
    ];
    await writeProject(root, makeProject(sources, placements));

    const plan = await planBuild(root, {});
    const setup = plan.needsConfiguration.find(issue => issue.code === 'video-endpoint-not-configured');
    assert.ok(setup, 'the unconfigured endpoint is flagged as configuration the user must supply');
    assert.equal(setup!.level, 'needs_configuration');
    assert.equal(setup!.subject, 'src_vid');
    // `buildable` answers "could a Build run to completion under this
    // configuration?": missing setup (or an approval, or an unsupported request)
    // gates it just as a structural blocker does, so it is false, while the issue
    // itself stays in `needsConfiguration` (never folded into `blockers`).
    // `pending` facts do not gate it — they are only known after the run.
    assert.deepEqual(plan.blockers, [], 'missing setup is not a structural blocker');
    assert.equal(plan.buildable, false, 'missing setup gates the build');
  });
});

test('H3 partition settings do not constrain a different video model', async () => {
  await withRoot(async root => {
    const assets = [
      {
        id: 'img',
        revision: 1,
        type: 'image',
        path: 'img.png',
        sha256: 'a'.repeat(64),
        rights: RIGHTS,
        simulated: false,
      },
    ];
    const sources = [
      {
        id: 'src_ref',
        kind: 'provider',
        output: 'picture',
        endpoint: 'ep',
        model: 'm',
        prompt: 'p',
        mode: 'reference',
        references: [{ asset: 'img', category: 'image', role: 'identity' }],
        requestedFrames: 48,
        size: '1280:720',
        seed: 0,
        attempt: 'a1',
      },
    ];
    const placements = [
      { id: 'pl_ref', shot: 'shot', source: 'src_ref', inFrame: 0, outFrame: 48, startFrame: 0, audio: 'mute' },
    ];
    await writeProject(root, makeProject(sources, placements, assets));

    const options = {
      providers: {
        videoApi: {
          ep: {
            endpoint: {
              protocol: 'vllm-omni-video' as const,
              baseUrl: 'https://example.test',
              modelSettings: { taskType: 'fl2va' as const },
            },
          },
        },
      },
    };
    const plan = await planBuild(root, options);

    assert.equal(
      plan.unsupported.some(issue => issue.code === 'mode-not-supported-by-partition'),
      false,
      'H3 task partitions do not constrain another model',
    );
  });
});

test('planBuild surfaces a timeline blocker when the first placement does not start at zero', async () => {
  await withRoot(async root => {
    await writeProject(root, makeProject([SIMULATED], [{ ...SIM_PLACEMENT, startFrame: 5 }]));

    const plan = await planBuild(root);
    assert.equal(plan.buildable, false);
    const blocker = plan.blockers.find(issue => issue.code === 'timeline-does-not-start-at-zero');
    assert.ok(blocker, 'a nonzero first start is a structural blocker');
    assert.equal(blocker!.subject, 'pl');
  });
});

test('planBuild surfaces a timeline blocker for a gap between placements', async () => {
  await withRoot(async root => {
    const placements = [
      SIM_PLACEMENT,
      { id: 'pl2', shot: 'shot', source: 'src_sim', inFrame: 0, outFrame: 48, startFrame: 60, audio: 'mute' },
    ];
    await writeProject(root, makeProject([SIMULATED], placements));

    const plan = await planBuild(root);
    assert.equal(plan.buildable, false);
    assert.ok(
      plan.blockers.some(issue => issue.code === 'timeline-gap'),
      'the 12-frame gap is a structural blocker',
    );
  });
});

test('analyzeTimeline reports an unauthorized overlap and an unconsumed transition', () => {
  const placement = (id: string, startFrame: number): Placement => ({
    id,
    shot: 'shot',
    source: 'src',
    inFrame: 0,
    outFrame: 48,
    startFrame,
    audio: 'mute',
  });

  const overlapping = analyzeTimeline([placement('p1', 0), placement('p2', 40)], []);
  assert.ok(
    overlapping.blockers.some(issue => issue.code === 'unauthorized-overlap'),
    'an 8-frame overlap with no transition is unauthorized',
  );

  const hardCutTransition: Transition = { from: 'p1', to: 'p2', kind: 'dissolve', startFrame: 48, endFrame: 48 };
  const hardCut = analyzeTimeline([placement('p1', 0), placement('p2', 48)], [hardCutTransition]);
  assert.ok(
    hardCut.blockers.some(issue => issue.code === 'transition-not-consumed'),
    'a declared transition over a zero-overlap hard cut cannot apply',
  );

  // An overlap authorized by exactly one matching transition is recorded, not blocked.
  const authorized: Transition = { from: 'p1', to: 'p2', kind: 'dissolve', startFrame: 40, endFrame: 48 };
  const authorizedResult = analyzeTimeline([placement('p1', 0), placement('p2', 40)], [authorized]);
  assert.deepEqual(authorizedResult.blockers, [], 'a correctly declared transition authorizes the overlap');
  assert.equal(authorizedResult.overlaps.length, 1);
  assert.equal(authorizedResult.overlaps[0].overlap, 8);
  assert.equal(authorizedResult.overlaps[0].transition, 'dissolve');
});

test('staticSourceFrames knows deterministic lengths and defers the rest', () => {
  const sources = [
    SIMULATED,
    {
      id: 'src_vid',
      kind: 'provider',
      output: 'picture',
      endpoint: 'ep',
      model: 'm',
      prompt: 'p',
      mode: 'text',
      requestedFrames: 48,
      size: '1280:720',
      seed: 0,
      attempt: 'a1',
    },
  ];
  const assets = [
    {
      id: 'a1',
      revision: 1,
      type: 'video',
      path: 'clip.mp4',
      sha256: 'a'.repeat(64),
      rights: RIGHTS,
      simulated: false,
    },
  ];
  const project = makeProject(sources, [], assets);

  const byId = new Map(project.sources.map(source => [source.id, source]));
  assert.equal(
    staticSourceFrames(project, byId.get('src_sim')!),
    48,
    'a simulated 48-frame source at 24 fps yields 48 frames',
  );
  assert.equal(staticSourceFrames(project, byId.get('src_vid')!), undefined, 'real generation is service-decided');
});

test('staticSourceAudio knows deterministic audio presence and defers the rest', () => {
  const sources = [
    {
      id: 'src_sound',
      kind: 'browser',
      output: 'sound',
      entry: 'sound.html',
      durationSamples: 96000,
      sampleRate: 48000,
    },
    { id: 'src_code', kind: 'browser', output: 'picture', entry: 'scene.html', frames: 48 },
    {
      id: 'src_vid',
      kind: 'provider',
      output: 'picture',
      endpoint: 'ep',
      model: 'm',
      prompt: 'p',
      mode: 'text',
      requestedFrames: 48,
      size: '1280:720',
      seed: 0,
      attempt: 'a1',
    },
  ];
  const assets = [
    {
      id: 'a1',
      revision: 1,
      type: 'video',
      path: 'clip.mp4',
      sha256: 'a'.repeat(64),
      rights: RIGHTS,
      simulated: false,
    },
  ];
  const project = makeProject(sources, [], assets);

  const byId = new Map(project.sources.map(source => [source.id, source]));
  assert.equal(staticSourceAudio(byId.get('src_sound')!), true, 'a sound Source carries audio');
  assert.equal(staticSourceAudio(byId.get('src_code')!), false, 'a code Source produces no audio stream');
  assert.equal(staticSourceAudio(byId.get('src_vid')!), undefined, 'generated audio is service-decided');
});

test('reuse is exact: an unchanged Source is reusable and an edited Source is work', async () => {
  await withRoot(async root => {
    // The simulated provider produces real, openable media via FFmpeg, so this
    // exercises the real Build → succeeded operation → plan path.
    await writeProject(root, makeProject([SIMULATED], [SIM_PLACEMENT]));
    const build = await buildProject(root);
    assert.equal(build.status, 'succeeded', 'the simulated Build succeeds');

    const planned = await planBuild(root);
    assert.ok(
      planned.reuse.some(entry => entry.subject === 'src_sim'),
      'the unchanged Source matches a succeeded operation key and is reusable',
    );
    assert.deepEqual(planned.work, [], 'nothing needs production');

    // Editing the authored prompt changes the operation identity, so the same
    // Source id must NOT be reported as reusable any more.
    const edited = await loadProject(root);
    const source = edited.sources.find(candidate => candidate.id === 'src_sim');
    if (!source || source.kind !== 'simulated') throw new Error('expected the simulated Source');
    source.prompt = 'a genuinely different prompt';
    await saveProject(root, edited, edited.revision);

    const replanned = await planBuild(root);
    assert.deepEqual(replanned.reuse, [], 'an edited Source is no longer reusable');
    assert.ok(
      replanned.work.some(entry => entry.subject === 'src_sim'),
      'the edited Source becomes production work',
    );
  });
});

/** The minimal Build-record shape these regressions inspect, as stored on disk. */
interface StoredBuild {
  status: string;
  operations: Array<{ id: string; kind: string; key: string; artifact: string; reused: boolean }>;
  artifacts: Array<{ id: string; path: string; sha256: string }>;
}

/** Every persisted Build record under `.viscraft/builds/` (sorted by file name). */
async function readBuildRecords(root: string): Promise<StoredBuild[]> {
  const dir = join(root, '.viscraft', 'builds');
  const names = (await readdir(dir)).filter(name => name.endsWith('.json')).sort();
  return Promise.all(names.map(async name => JSON.parse(await readFile(join(dir, name), 'utf8')) as StoredBuild));
}

test('a locally-available subtitle font is resolved before any capture/compose/picture work', async () => {
  await withRoot(async root => {
    const base = makeProject([SIMULATED], [SIM_PLACEMENT]);
    const project = ProjectSchema.parse({
      ...base,
      composition: {
        ...base.composition,
        subtitles: [{ id: 'sub', text: 'HI', startFrame: 0, endFrame: 48, fontSize: 10, color: '#ffffff' }],
      },
    });
    await writeProject(root, project);

    const previous = process.env.VISCRAFT_SUBTITLE_FONT;
    // An explicitly configured but missing font is a hard error (never a silent
    // fallback to the system font), so this deterministically simulates a host
    // without the required subtitle font.
    process.env.VISCRAFT_SUBTITLE_FONT = join(root, 'missing-font.ttf');
    try {
      // The Plan reports the gap through the SAME shared check the Build runs.
      const plan = await planBuild(root);
      assert.equal(plan.buildable, false, 'a missing subtitle font gates the build');
      assert.ok(
        plan.blockers.some(issue => issue.code === 'subtitle-font-unavailable'),
        `expected a subtitle-font-unavailable blocker, got ${JSON.stringify(plan.blockers)}`,
      );

      // The Build fails on the font BEFORE any picture work.
      await assert.rejects(buildProject(root), /subtitle font/i);
    } finally {
      if (previous === undefined) delete process.env.VISCRAFT_SUBTITLE_FONT;
      else process.env.VISCRAFT_SUBTITLE_FONT = previous;
    }

    // The failed Build persisted a record, but it ran ZERO operations/artifacts:
    // no capture, compose or picture work happened before the font was resolved.
    const records = await readBuildRecords(root);
    assert.equal(records.length, 1, 'exactly one (failed) Build record exists');
    assert.equal(records[0].status, 'failed');
    assert.equal(
      records[0].operations.length,
      0,
      'the font failure must precede every operation (capture/compose/picture)',
    );
    assert.equal(records[0].artifacts.length, 0, 'no artifact may be produced before the font is resolved');
  });
});

test("a retry reuses a failed Build's completed, hash-verified operation without re-encoding", async () => {
  await withRoot(async root => {
    const ok = { ...SIMULATED, id: 'src_ok', prompt: 'keep this operation', attempt: 'a-ok' };
    const bad = { ...SIMULATED, id: 'src_bad', prompt: 'fail here', attempt: 'a-bad', behavior: 'fail' };
    const placements = [
      { id: 'pl_ok', shot: 'shot', source: 'src_ok', inFrame: 0, outFrame: 48, startFrame: 0, audio: 'mute' },
      { id: 'pl_bad', shot: 'shot', source: 'src_bad', inFrame: 0, outFrame: 48, startFrame: 48, audio: 'mute' },
    ];
    await writeProject(root, makeProject([ok, bad], placements));

    // First Build: the first Source completes, the second fails at production.
    await assert.rejects(buildProject(root), /failed/);
    const failed = (await readBuildRecords(root))[0];
    assert.equal(failed.status, 'failed', 'the first Build failed after a partial run');
    const completed = failed.operations.find(operation => operation.kind === 'simulated');
    assert.ok(completed, `the first Build completed an operation before failing: ${JSON.stringify(failed.operations)}`);
    assert.equal(completed!.reused, false, 'the first run genuinely produced the operation');
    const completedArtifact = failed.artifacts.find(artifact => artifact.id === completed!.artifact)!;
    assert.equal(
      await hashFile(join(root, ...completedArtifact.path.split('/'))),
      completedArtifact.sha256,
      'the completed operation left a present, hash-verified artifact',
    );

    // The Plan predicts reusing the failed Build's completed operation.
    const plan = await planBuild(root);
    const reuse = plan.reuse.find(entry => entry.subject === 'src_ok');
    assert.ok(reuse, `expected src_ok reuse in the plan, got ${JSON.stringify(plan.reuse)}`);
    assert.equal(reuse!.artifact, completed!.artifact, "the plan predicts the failed Build's artifact");
    assert.ok(
      plan.work.some(entry => entry.subject === 'src_bad'),
      'the failing Source remains production work',
    );

    // Fix ONLY the failing Source, then retry.
    const project = await loadProject(root);
    const badSource = project.sources.find(source => source.id === 'src_bad');
    if (!badSource || badSource.kind !== 'simulated') throw new Error('expected the simulated Source');
    badSource.behavior = 'success';
    badSource.attempt = 'a-bad-2';
    await saveProject(root, project, project.revision);

    const retry = await buildProject(root);
    assert.equal(retry.status, 'succeeded', 'the retry Build succeeds');
    const reused = retry.operations.find(operation => operation.key === completed!.key);
    assert.ok(reused, 'the retry records the same operation key');
    assert.equal(reused!.reused, true, 'the retry REUSES the completed operation instead of re-encoding it');
    assert.equal(reused!.artifact, completed!.artifact, "the retry reuses the failed Build's artifact");
  });
});
