/**
 * End-to-end runtime tests (real Code/Media + simulated-provider control chain).
 *
 * These drive the *real* `buildProject` pipeline: the CodeScene example is
 * rendered through headless Chrome, encoded with FFmpeg, composed, mixed and
 * muxed into a final H.264/AAC file. They assert the product-level invariants
 * for production, caching and recovery:
 *
 *  - a clean project created by `tests/fixtures/authoring/create-motion.mjs` builds a final with
 *    audio, and an unchanged rebuild reuses every operation/artifact;
 *  - editing one code source's params re-renders only that source; an audio-only
 *    edit re-renders no code; a moved project still reuses all artifacts;
 *  - a failed build preserves the previous `.viscraft/result.json`;
 *  - a simulated `success` Source runs through the normal build + trim + authored-audio path
 *    and marks the final as `simulated`;
 *  - `submit-unknown` and `download-fail-once` fail once, then succeed on re-run
 *    with exactly one submit;
 *  - a new failing attempt on an existing source keeps the previous result.
 *
 * Speed: this file builds a reduced 96x64 fixture (a few frames) so it stays a
 * fast regression. The original 640x360 / 6 s example is exercised separately.
 * The tests assume a real browser + FFmpeg are installed (see `viscraft doctor`).
 */

import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createSymlinkFixture } from './fs-fixtures.js';
import { ProjectSchema, type Asset, type BrowserPictureSource, type Project } from '../src/core/schema.js';
import { buildProject } from '../src/build/build.js';
import { readBuilds } from '../src/project/build-records.js';
import { loadProject, saveProject } from '../src/project/project.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { simulatedStatus } from '../src/backends/providers/simulated.js';
import { framesToSamples } from '../src/core/time.js';
import { writeSignalAsset } from './audio-fixtures.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CREATE_MOTION = join(REPO_ROOT, 'tests', 'fixtures', 'authoring', 'create-motion.mjs');

// Reduced fixture: even 96x64, 30fps, 48kHz stereo. 6 code frames => tiny but real.
const OUTPUT = {
  width: 96,
  height: 64,
  fps: { numerator: 30, denominator: 1 },
  sampleRate: 48000 as const,
  channels: 2 as const,
};

/** A two-shot, code-only project whose CodeScene is the shipped example. */
function smallCodeProject(signals: [Asset, Asset, Asset]): Project {
  const [lead, answer, padSignal] = signals;
  return {
    schemaVersion: 1,
    id: 'e2e-code',
    revision: 1,
    title: 'e2e code-only motion',
    soundTargets: [],
    direction: {
      intent: 'regression fixture',
      looks: [{ id: 'look_main', description: 'neon field' }],
      transitions: [],
    },
    assets: [lead, answer, padSignal],
    bindings: {},
    sources: [
      {
        id: 'src_a',
        kind: 'browser',
        output: 'picture',
        entry: 'motion.html',
        resources: [],
        bindings: [],
        params: {
          layout: 'assemble',
          text: 'CRAFT',
          palette: ['#00e5ff', '#ff2fb9'],
          beatFrames: 15,
          intensity: 1,
          stagger: 0.11,
        },
        seed: 11,
        frames: 4,
      },
      {
        id: 'src_b',
        kind: 'browser',
        output: 'picture',
        entry: 'motion.html',
        resources: [],
        bindings: [],
        params: {
          layout: 'rhythm',
          text: 'RHYTHM',
          subtext: '',
          palette: ['#00e5ff', '#ff2fb9'],
          beatFrames: 15,
          intensity: 1,
          bars: 36,
        },
        seed: 29,
        frames: 4,
      },
    ],
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'sc1', description: 'fixture scene' }],
      shots: [
        { id: 'sh_a', scene: 'sc1', look: 'look_main', intent: 'assemble', targetFrames: 4 },
        { id: 'sh_b', scene: 'sc1', look: 'look_main', intent: 'rhythm', targetFrames: 4 },
      ],
      placements: [
        { id: 'pl_a', shot: 'sh_a', source: 'src_a', inFrame: 0, outFrame: 4, startFrame: 0, audio: 'mute' },
        { id: 'pl_b', shot: 'sh_b', source: 'src_b', inFrame: 0, outFrame: 4, startFrame: 4, audio: 'mute' },
      ],
      transitions: [],
      audio: [
        {
          id: 'clip_0',
          kind: 'asset',
          asset: lead.id,
          inSample: 0,
          startSample: 0,
          durationSamples: 2400,
          gain: 0.25,
          fadeInSamples: 200,
          fadeOutSamples: 2000,
        },
        {
          id: 'clip_1',
          kind: 'asset',
          asset: answer.id,
          inSample: 0,
          startSample: 6400,
          durationSamples: 2400,
          gain: 0.25,
          fadeInSamples: 200,
          fadeOutSamples: 2000,
        },
        {
          id: 'pad',
          kind: 'asset',
          asset: padSignal.id,
          inSample: 0,
          startSample: 0,
          durationSamples: 12800,
          gain: 0.05,
          fadeInSamples: 1600,
          fadeOutSamples: 1600,
        },
      ],
    },
    imageDocuments: [],
    imageTargets: [],
  };
}

type Behavior = 'success' | 'fail' | 'submit-unknown' | 'download-fail-once';

/** A single simulated-source project that trims the take and adds authored audio. */
function smallSimProject(attempt: string, behavior: Behavior, signal: Asset): Project {
  return {
    schemaVersion: 1,
    id: 'e2e-sim',
    revision: 1,
    title: 'e2e simulated control chain',
    soundTargets: [],
    direction: {
      intent: 'regression fixture',
      looks: [{ id: 'look_main', description: 'simulated field' }],
      transitions: [],
    },
    assets: [signal],
    bindings: {},
    sources: [
      {
        id: 'src_sim',
        kind: 'simulated',
        prompt: 'e2e deterministic test pattern',
        frames: 8,
        seed: 5,
        attempt,
        behavior,
      },
    ],
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'sc1', description: 'fixture scene' }],
      shots: [{ id: 'sh_sim', scene: 'sc1', look: 'look_main', intent: 'simulated', targetFrames: 8 }],
      placements: [
        { id: 'pl_sim', shot: 'sh_sim', source: 'src_sim', inFrame: 0, outFrame: 8, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio: [
        {
          id: 'clip_sim',
          kind: 'asset',
          asset: signal.id,
          inSample: 0,
          startSample: 0,
          durationSamples: 6000,
          gain: 0.2,
          fadeInSamples: 200,
          fadeOutSamples: 5000,
        },
      ],
    },
    imageDocuments: [],
    imageTargets: [],
  };
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-e2e-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeProject(root: string, project: Project): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'project.json'), JSON.stringify(ProjectSchema.parse(project), null, 2) + '\n', 'utf8');
}

/** A real authored audio Asset at the output rate; each caller keeps its own span. */
async function writeRuntimeSignal(
  root: string,
  spec: { id: string; sampleRate?: number; samples?: number; frequency?: number; waveform?: 'sine' | 'triangle' },
): Promise<Asset> {
  return writeSignalAsset(root, {
    id: spec.id,
    path: `audio/${spec.id}.wav`,
    sampleRate: spec.sampleRate ?? 48000,
    channels: 2,
    samples: spec.samples ?? 12800,
    frequency: spec.frequency,
    waveform: spec.waveform,
  });
}

function codeSource(project: Project, id: string): BrowserPictureSource {
  const source = project.sources.find(s => s.id === id);
  if (!source || source.kind !== 'browser' || source.output !== 'picture')
    throw new Error(`expected code source ${id}`);
  return source;
}

async function jobFor(root: string, attempt: string): Promise<Record<string, unknown>> {
  const jobs = (await simulatedStatus(root)) as Array<Record<string, unknown>>;
  const job = jobs.find(j => j.attempt === attempt);
  if (!job) throw new Error(`expected a persisted job for attempt ${attempt}`);
  return job;
}

test('create-motion script + code-only lifecycle: build, reuse, selective edit, move, failure', async () => {
  await withRoot(async root => {
    const dir = join(root, 'motion');

    // 1. The example script creates a clean, buildable project and refuses to overwrite.
    await runCommand('node', [CREATE_MOTION, dir]);
    assert.ok(existsSync(join(dir, 'project.json')), 'script must write project.json');
    assert.ok(existsSync(join(dir, 'motion.html')), 'script must copy the CodeScene');
    await assert.rejects(runCommand('node', [CREATE_MOTION, dir]), /refusing to overwrite/);

    // 2. Swap in the reduced fixture for a fast regression (main runs the full 6 s piece).
    const signals: [Asset, Asset, Asset] = [
      await writeRuntimeSignal(dir, { id: 'lead_440', samples: 2400, frequency: 440 }),
      await writeRuntimeSignal(dir, {
        id: 'answer_660',
        samples: 2400,
        frequency: 660,
        waveform: 'triangle',
      }),
      await writeRuntimeSignal(dir, { id: 'pad_110', samples: 12800, frequency: 110 }),
    ];
    await writeProject(dir, smallCodeProject(signals));

    const build1 = await buildProject(dir);
    assert.equal(build1.status, 'succeeded');
    const final1 = build1.artifacts.find(a => a.id === build1.result!.artifact)!;
    assert.equal(final1.kind, 'video');
    assert.equal(final1.simulated, false, 'a pure code/media build is not simulated');
    assert.equal(final1.media?.frames, 8, 'final length equals the composition length');
    assert.ok(final1.media?.audio, 'final must carry an audio stream');

    // 3. An unchanged rebuild reuses every operation and artifact.
    const build2 = await buildProject(dir);
    assert.ok(build2.operations.length > 0);
    assert.ok(
      build2.operations.every(o => o.reused),
      'unchanged rebuild must reuse every operation',
    );

    // 4. Editing one code source's params re-renders only that source.
    let project = await loadProject(dir);
    const edited = structuredClone(project);
    codeSource(edited, 'src_b').params = { ...codeSource(edited, 'src_b').params, intensity: 1.3 };
    await saveProject(dir, edited, project.revision);
    const build3 = await buildProject(dir);
    const codeOps = build3.operations.filter(o => o.kind === 'browser');
    assert.equal(codeOps.length, 2);
    assert.equal(codeOps.filter(o => !o.reused).length, 1, 'exactly one source re-renders');
    assert.equal(codeOps.filter(o => o.reused).length, 1, 'the other source is reused');

    // 5. An audio-only edit re-renders no code.
    project = await loadProject(dir);
    const edited2 = structuredClone(project);
    const clip = edited2.composition!.audio.find(c => c.id === 'clip_0');
    if (!clip || clip.kind !== 'asset') throw new Error('expected clip_0 to be an authored audio clip');
    clip.gain = 0.35;
    await saveProject(dir, edited2, project.revision);
    const build4 = await buildProject(dir);
    assert.ok(
      build4.operations.filter(o => o.kind === 'browser').every(o => o.reused),
      'audio edit must not re-render code',
    );
    assert.equal(build4.operations.find(o => o.kind === 'mix-audio')!.reused, false, 'changed audio re-mixes');
    assert.equal(
      build4.operations.find(o => o.kind === 'compose-video')!.reused,
      true,
      'unchanged picture is not recomposed',
    );

    // 6. Moving the whole project to a new path still reuses every artifact.
    const moved = join(root, 'moved-motion');
    await rename(dir, moved);
    const build5 = await buildProject(moved);
    assert.ok(
      build5.operations.every(o => o.reused),
      'a moved project must still reuse all artifacts',
    );
    const resultPath = join(moved, '.viscraft', 'result.json');
    assert.ok(existsSync(resultPath), 'a successful build records result.json');

    // 7. A failing build (placement reads beyond the take) preserves the previous
    // result. The over-long interval is now caught by the preflight before the
    // code capture runs, so the guard names the Source rather than the Take.
    const before = await readFile(resultPath, 'utf8');
    const bad = structuredClone(await loadProject(moved));
    bad.composition!.placements = [{ ...bad.composition!.placements[0], outFrame: 9999 }];
    await writeProject(moved, bad);
    await assert.rejects(buildProject(moved), /beyond (Take|Source)/);
    assert.equal(await readFile(resultPath, 'utf8'), before, 'a failed build must keep the previous result.json');
  });
});

test('subtitle-only edits reuse code Takes, composition and mixed audio', async () => {
  await withRoot(async root => {
    const dir = join(root, 'captions');
    await runCommand('node', [CREATE_MOTION, dir]);
    const signals: [Asset, Asset, Asset] = [
      await writeRuntimeSignal(dir, { id: 'lead_440', samples: 2400, frequency: 440 }),
      await writeRuntimeSignal(dir, {
        id: 'answer_660',
        samples: 2400,
        frequency: 660,
        waveform: 'triangle',
      }),
      await writeRuntimeSignal(dir, { id: 'pad_110', samples: 12800, frequency: 110 }),
    ];
    const original = smallCodeProject(signals);
    original.composition!.subtitles = [
      { id: 'caption', text: 'ORBIT', startFrame: 2, endFrame: 6, fontSize: 12, color: '#ffffff' },
    ];
    await writeProject(dir, original);
    const first = await buildProject(dir);
    assert.ok(first.operations.some(operation => operation.kind === 'overlay-subtitles' && !operation.reused));
    const prior = await loadProject(dir);
    const changed = structuredClone(prior);
    changed.composition!.subtitles![0].text = 'NEW ORBIT';
    changed.composition!.subtitles![0].startFrame = 3;
    await saveProject(dir, changed, prior.revision);
    const second = await buildProject(dir);
    for (const operation of second.operations.filter(operation =>
      ['browser', 'compose-video', 'mix-audio'].includes(operation.kind),
    ))
      assert.equal(operation.reused, true, `${operation.kind} must be reused on a caption edit`);
    assert.equal(second.operations.find(operation => operation.kind === 'overlay-subtitles')!.reused, false);
    assert.equal(second.operations.find(operation => operation.kind === 'mux-final')!.reused, false);
    assert.deepEqual(
      second.takes.map(take => take.id),
      first.takes.map(take => take.id),
    );
    const final = second.artifacts.find(artifact => artifact.id === second.result!.artifact)!;
    assert.equal(final.media!.frames, 8);
    assert.equal(final.simulated, false);
    const resultBefore = await readFile(join(dir, '.viscraft/result.json'), 'utf8');
    const invalid = structuredClone(await loadProject(dir));
    invalid.composition!.subtitles![0].endFrame = 9;
    await assert.rejects(saveProject(dir, invalid, invalid.revision), /exceeds/);
    assert.equal(await readFile(join(dir, '.viscraft/result.json'), 'utf8'), resultBefore);
  });
});

test('unsafe pre-build paths release a live-process build lock', async context => {
  await withRoot(async root => {
    const signal = await writeRuntimeSignal(root, { id: 'signal' });
    await writeProject(root, smallSimProject('lock_path', 'success', signal));
    await mkdir(join(root, '.viscraft'), { recursive: true });
    const external = join(root, 'external');
    await mkdir(external);
    await createSymlinkFixture(context, external, join(root, '.viscraft', 'snapshots'));
    await assert.rejects(buildProject(root), /Symbolic links/);
    assert.equal(
      existsSync(join(root, '.viscraft', 'build.lock')),
      false,
      'path setup failure must release the acquired lock',
    );
    await rm(join(root, '.viscraft', 'snapshots'));
    const next = await buildProject(root);
    assert.equal(next.status, 'succeeded');
  });
});

test('correcting media asset simulated provenance invalidates falsely-real cached identity', async () => {
  await withRoot(async root => {
    const videoPath = join(root, 'media.mp4');
    await runCommand('ffmpeg', [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-filter_threads',
      '1',
      '-f',
      'lavfi',
      '-i',
      'color=blue:size=96x64:rate=30:duration=0.3',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-threads',
      '2',
      videoPath,
    ]);
    const signal = await writeRuntimeSignal(root, { id: 'signal' });
    const project = smallSimProject('media_identity', 'success', signal);
    project.sources = [];
    project.composition!.placements[0].source = undefined;
    project.composition!.placements[0].asset = 'video';
    project.assets = [
      {
        id: 'video',
        revision: 1,
        type: 'video',
        path: 'media.mp4',
        sha256: await hashFile(videoPath),
        rights: { origin: 'test fixture', license: 'original test media', redistributable: true },
        simulated: false,
      },
      signal,
    ];
    await writeProject(root, project);
    const first = await buildProject(root);
    assert.equal(first.result!.simulated, false);
    const current = await loadProject(root);
    current.assets[0].simulated = true;
    await saveProject(root, current, current.revision);
    const second = await buildProject(root);
    assert.equal(second.operations.find(operation => operation.kind === 'normalize-media')!.reused, false);
    assert.equal(second.takes[0].simulated, true);
    assert.equal(second.result!.simulated, true);
    assert.ok(
      second.artifacts
        .filter(artifact => ['normalize-media', 'compose-video', 'mux-final'].includes(artifact.operation))
        .every(artifact => artifact.simulated),
    );
  });
});

test('short high-FPS and rational-FPS Builds retain AAC tail content and remain reusable', async () => {
  await withRoot(async root => {
    for (const [index, { fps, frames }] of [
      { fps: { numerator: 120, denominator: 1 }, frames: 1 },
      { fps: { numerator: 120, denominator: 1 }, frames: 5 },
      { fps: { numerator: 30000, denominator: 1001 }, frames: 2 },
    ].entries()) {
      const dir = join(root, `short-${index}`);
      await mkdir(dir);
      const path = join(dir, 'media.mp4');
      await runCommand('ffmpeg', [
        '-hide_banner',
        '-nostdin',
        '-y',
        '-filter_threads',
        '1',
        '-f',
        'lavfi',
        '-i',
        `color=blue:size=96x64:rate=${fps.numerator}/${fps.denominator}`,
        '-frames:v',
        String(frames),
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-threads',
        '2',
        path,
      ]);
      const clipSamples = framesToSamples(frames, fps, 44100, 'ceil');
      const signal = await writeRuntimeSignal(dir, { id: 'signal', sampleRate: 44100, samples: clipSamples });
      const project = smallSimProject(`short_${index}`, 'success', signal);
      project.composition!.output = { ...OUTPUT, fps, sampleRate: 44100 };
      project.sources = [];
      project.composition!.placements[0].source = undefined;
      project.composition!.placements[0].asset = 'video';
      project.assets = [
        {
          id: 'video',
          revision: 1,
          type: 'video',
          path: 'media.mp4',
          sha256: await hashFile(path),
          rights: { origin: 'original fixture', license: 'original test media', redistributable: true },
          simulated: false,
        },
        signal,
      ];
      project.composition!.placements[0].outFrame = frames;
      project.composition!.shots[0].targetFrames = frames;
      project.composition!.audio = [
        {
          id: 'tail',
          kind: 'asset',
          asset: signal.id,
          inSample: 0,
          startSample: 0,
          durationSamples: clipSamples,
          gain: 0.3,
          fadeInSamples: 0,
          fadeOutSamples: 0,
        },
      ];
      await writeProject(dir, project);
      const first = await buildProject(dir);
      assert.equal(first.status, 'succeeded');
      assert.equal(first.result!.simulated, false);
      const final = first.artifacts.find(artifact => artifact.id === first.result!.artifact)!;
      assert.equal(final.media!.frames, frames);
      assert.ok(final.media!.audio);
      assert.ok(
        Math.abs(final.media!.audio.duration - clipSamples / 44100) <= 1 / 44100,
        'Build must not hide an early audio EOF within the one-video-frame smoke tolerance',
      );
      const pcmPath = join(dir, 'decoded.f32le');
      await runCommand('ffmpeg', [
        '-hide_banner',
        '-nostdin',
        '-y',
        '-i',
        join(dir, final.path),
        '-map',
        '0:a:0',
        '-f',
        'f32le',
        '-acodec',
        'pcm_f32le',
        pcmPath,
      ]);
      const pcm = await readFile(pcmPath);
      assert.ok(pcm.length / 8 >= clipSamples);
      let energy = 0;
      for (let sample = clipSamples - 64; sample < clipSamples; sample++) energy += pcm.readFloatLE(sample * 8) ** 2;
      assert.ok(Math.sqrt(energy / 64) > 0.05, 'final authored audio content must survive the complete Build');
      const second = await buildProject(dir);
      assert.ok(second.operations.every(operation => operation.reused));
      assert.equal(second.result!.artifact, first.result!.artifact);
    }
  });
});

test('simulated success source builds through trim + authored audio and is marked simulated', async () => {
  await withRoot(async root => {
    const dir = join(root, 'sim');
    const signal = await writeRuntimeSignal(dir, { id: 'signal' });
    await writeProject(dir, smallSimProject('att_ok', 'success', signal));

    const build1 = await buildProject(dir);
    assert.equal(build1.status, 'succeeded');
    const final = build1.artifacts.find(a => a.id === build1.result!.artifact)!;
    assert.equal(final.simulated, true, 'final inherits simulated provenance');
    assert.equal(final.media?.frames, 8, 'the take is trimmed to the placement length');
    assert.ok(final.media?.audio, 'the authored audio mix must be present');
    assert.ok(
      build1.takes.some(t => t.simulated),
      'the take is marked simulated',
    );

    const job1 = await jobFor(dir, 'att_ok');
    assert.equal(job1.submitted, 1);
    assert.equal(job1.state, 'succeeded');

    // An unchanged rebuild reuses everything and submits nothing new.
    const build2 = await buildProject(dir);
    assert.ok(build2.operations.every(o => o.reused));
    assert.equal((await jobFor(dir, 'att_ok')).submitted, 1, 'a reused take must not resubmit');
  });
});

test('a corrupted artifact is not a cache hit and is re-materialized', async () => {
  await withRoot(async root => {
    const dir = join(root, 'corrupt');
    const signal = await writeRuntimeSignal(dir, { id: 'signal' });
    await writeProject(dir, smallSimProject('att_corrupt', 'success', signal));
    const build1 = await buildProject(dir);
    assert.equal(build1.status, 'succeeded');

    // Damage the recorded final artifact bytes. A hash-checked cache must not
    // treat the damaged file as a hit; the build must regenerate and produce a
    // valid artifact whose bytes match its recorded hash again.
    const final1 = build1.artifacts.find(a => a.id === build1.result!.artifact)!;
    await writeFile(join(dir, final1.path), Buffer.from('corrupted, not a valid media file'));

    const build2 = await buildProject(dir);
    assert.equal(build2.status, 'succeeded', 'a corrupted artifact must be regenerated, not reused');
    assert.equal(
      build2.operations.find(o => o.kind === 'mux-final')!.reused,
      false,
      'the damaged final must not be reused',
    );
    const final2 = build2.artifacts.find(a => a.id === build2.result!.artifact)!;
    assert.equal(
      await hashFile(join(dir, final2.path)),
      final2.sha256,
      'the recovered artifact matches its recorded hash',
    );
  });
});

test('submit-unknown is reconciled on re-run without a second submit', async () => {
  await withRoot(async root => {
    const dir = join(root, 'unknown');
    const signal = await writeRuntimeSignal(dir, { id: 'signal' });
    await writeProject(dir, smallSimProject('att_unknown', 'submit-unknown', signal));

    await assert.rejects(buildProject(dir), /unknown/);
    let job = await jobFor(dir, 'att_unknown');
    assert.equal(job.state, 'submit-unknown');
    assert.equal(job.submitted, 1);

    const build = await buildProject(dir);
    assert.equal(build.status, 'succeeded');
    job = await jobFor(dir, 'att_unknown');
    assert.equal(job.state, 'succeeded');
    assert.equal(job.submitted, 1, 'reconciliation must not submit again');
    assert.equal(job.reconciled, true);
  });
});

test('download-fail-once resumes the download on re-run without a second submit', async () => {
  await withRoot(async root => {
    const dir = join(root, 'download');
    const signal = await writeRuntimeSignal(dir, { id: 'signal' });
    await writeProject(dir, smallSimProject('att_download', 'download-fail-once', signal));

    await assert.rejects(buildProject(dir), /download failed/);
    let job = await jobFor(dir, 'att_download');
    assert.equal(job.state, 'download-failed');
    assert.equal(job.submitted, 1);

    const build = await buildProject(dir);
    assert.equal(build.status, 'succeeded');
    job = await jobFor(dir, 'att_download');
    assert.equal(job.state, 'succeeded');
    assert.equal(job.submitted, 1, 'a resumed download must not resubmit');
  });
});

test('a new failing attempt on the same source keeps the previous result', async () => {
  await withRoot(async root => {
    const dir = join(root, 'keep');
    const signal = await writeRuntimeSignal(dir, { id: 'signal' });
    await writeProject(dir, smallSimProject('att_first', 'success', signal));
    const first = await buildProject(dir);
    assert.equal(first.status, 'succeeded');

    const resultPath = join(dir, '.viscraft', 'result.json');
    const before = await readFile(resultPath, 'utf8');

    const project = await loadProject(dir);
    const changed = structuredClone(project);
    const sim = changed.sources.find(s => s.id === 'src_sim');
    if (!sim || sim.kind !== 'simulated') throw new Error('expected src_sim to be simulated');
    sim.attempt = 'att_second';
    sim.behavior = 'fail';
    await saveProject(dir, changed, project.revision);

    await assert.rejects(buildProject(dir), /behavior=fail/);
    assert.equal(await readFile(resultPath, 'utf8'), before, 'a failed retry must keep the previous result');
    const builds = await readBuilds(dir);
    assert.ok(
      builds.some(b => b.id === first.id && b.status === 'succeeded'),
      'the earlier successful build record survives',
    );
  });
});
