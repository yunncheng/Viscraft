/**
 * End-to-end test for reference-timing re-authoring through the orbital example.
 *
 * It exercises the *real* chain, not a mock:
 *
 *   1. A genuine FFmpeg fixture (three solid-colour segments, 3 cuts => 3
 *      segments) is analysed by the real `analyzeReference`, producing a
 *      schema-valid `ReferenceReport` with exact rational PTS timing.
 *   2. `tests/fixtures/authoring/create-orbital.mjs` consumes that report and authors a NEW
 *      Project: every reference segment becomes one `browser` picture Source rendering
 *      `orbital.html`, with the retained cut grid as its placement boundaries.
 *      The reference material itself is never copied, listed or reconstructed —
 *      only its non-secret content hash is retained.
 *   3. The authored Project is reduced to a small 64x64 fixture, then BUILT for
 *      real (headless Chrome capture + FFmpeg compose/mix/mux). We assert the
 *      audio track matches the (shortened) timeline, that an unchanged rebuild
 *      reuses every operation, and that editing one Source re-renders only it.
 *
 * The second test is the mixed-FPS regression: a 10 fps reference analysed at
 * 30 fps must feed segment intervals straight into the composition timing (so a
 * 2 s segment becomes 60 output frames), never re-mapping already-output frames.
 *
 * Assumes a real browser + FFmpeg are installed (see `viscraft doctor`).
 */
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  ProjectSchema,
  ReferenceReportSchema,
  type BrowserPictureSource,
  type Fps,
  type Project,
} from '../src/core/schema.js';
import { analyzeReference } from '../src/operations/analysis/reference.js';
import { buildProject } from '../src/build/build.js';
import { loadProject, saveProject } from '../src/project/project.js';
import { compositionFrames } from '../src/core/composition.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CREATE_ORBITAL = join(REPO_ROOT, 'tests', 'fixtures', 'authoring', 'create-orbital.mjs');
const REFERENCE_FPS: Fps = { numerator: 10, denominator: 1 };

/** A stand-in Project used only so `analyzeReference` can read a composition fps. */
function analysisHostProject(fps: Fps): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'orbital_ref_host',
    revision: 1,
    title: 'reference analysis host',
    direction: {
      intent: 'host project for reference analysis',
      looks: [{ id: 'look_main', description: 'host look' }],
      transitions: [],
    },
    assets: [],
    bindings: {},
    sources: [
      { id: 'src_host', kind: 'simulated', prompt: 'host', frames: 1, seed: 0, attempt: 'host_1', behavior: 'success' },
    ],
    composition: {
      output: { width: 160, height: 120, fps, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene_1', description: 'host scene' }],
      shots: [{ id: 'shot_1', scene: 'scene_1', look: 'look_main', intent: 'host shot', targetFrames: 1 }],
      placements: [
        { id: 'place_1', shot: 'shot_1', source: 'src_host', inFrame: 0, outFrame: 1, startFrame: 0, audio: 'mute' },
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

/** Three solid-colour segments at `fps` (one hard cut between each) => three segments. */
async function makeThreeSegmentReference(directory: string, fps = 10, seconds = 1): Promise<void> {
  await mkdir(directory, { recursive: true });
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
    '-f',
    'lavfi',
    '-i',
    `color=c=red:s=64x48:r=${fps}:d=${seconds}`,
    '-f',
    'lavfi',
    '-i',
    `color=c=blue:s=64x48:r=${fps}:d=${seconds}`,
    '-f',
    'lavfi',
    '-i',
    `color=c=green:s=64x48:r=${fps}:d=${seconds}`,
    '-filter_complex',
    '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
    '-map',
    '[v]',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(fps),
    join(directory, 'tri.mp4'),
  ]);
}

function codeSource(project: Project, index: number): BrowserPictureSource {
  const source = project.sources[index];
  if (!source || source.kind !== 'browser' || source.output !== 'picture')
    throw new Error(`expected code source at index ${index}`);
  return source;
}

/**
 * Shrink the authored Project to a fast 64x64 fixture: each segment keeps only
 * `per` frames. The original audio Asset clips are kept untouched so the build
 * must clip them to the shorter timeline rather than mis-size the mix.
 */
function reduce(project: Project, per: number): Project {
  const reduced = structuredClone(project);
  let start = 0;
  for (let i = 0; i < reduced.sources.length; i++) {
    const source = codeSource(reduced, i);
    source.frames = per;
    source.params.segmentFrames = per;
    source.params.globalStartFrame = start;
    reduced.composition!.shots[i].targetFrames = per;
    reduced.composition!.placements[i].outFrame = per;
    reduced.composition!.placements[i].startFrame = start;
    start += per;
  }
  reduced.composition!.output = {
    width: 64,
    height: 64,
    fps: reduced.composition!.output.fps,
    sampleRate: 48000,
    channels: 2,
  };
  return reduced;
}

test('orbital: real reference timing is re-authored into a code-only Project that builds and reuses selectively', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-orbital-e2e-'));
  try {
    // 1. Real analysis of a real 3-segment reference.
    await writeProject(root, analysisHostProject(REFERENCE_FPS));
    await makeThreeSegmentReference(join(root, 'refs'));
    const report = await analyzeReference(root, 'refs/tri.mp4');
    ReferenceReportSchema.parse(report); // the report must be schema-valid
    assert.equal(report.source.origin, 'material');
    assert.equal(report.source.simulated, false);
    assert.equal(report.segments.length, 3, 'three colour segments produce exactly three segments');
    assert.equal(report.cuts.length, 2, 'two hard cuts');
    const referenceTotal = report.segments[report.segments.length - 1].endFrame;
    assert.equal(referenceTotal, report.media.frames);

    // 2. Author the new Project from the report's timing.
    const dir = join(root, 'orbital');
    const reportFile = join(root, report.reportPath);
    await runCommand('node', [CREATE_ORBITAL, reportFile, dir]);
    assert.ok(existsSync(join(dir, 'project.json')), 'create-orbital must write project.json');
    assert.ok(existsSync(join(dir, 'orbital.html')), 'create-orbital must copy the CodeScene');
    assert.ok(!existsSync(join(dir, 'refs')), 'the reference material must not be copied into the project');
    await assert.rejects(runCommand('node', [CREATE_ORBITAL, reportFile, dir]), /refusing to overwrite/);

    // A report that fails the canonical schema is rejected outright — no fallback.
    const tampered = structuredClone(report);
    tampered.cuts[0].pts = '999999999';
    const tamperedPath = join(root, 'tampered-report.json');
    await writeFile(tamperedPath, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');
    await assert.rejects(
      runCommand('node', [CREATE_ORBITAL, tamperedPath, join(root, 'tampered')]),
      /not a valid ReferenceReport/,
    );

    const project = await loadProject(dir);

    // Code-only picture, plus real PCM audio Assets: every asset is a signal
    // with a real byte hash and CC0 rights, and every clip points at one.
    assert.ok(project.sources.length >= 3);
    assert.ok(
      project.sources.every(source => source.kind === 'browser'),
      'every new Source must be code',
    );
    assert.ok(project.assets.length > 0, 'the piece schedules real PCM assets');
    for (const entry of project.assets) {
      assert.equal(entry.type, 'audio', `asset ${entry.id} must be an audio Asset`);
      assert.equal(entry.simulated, false, `asset ${entry.id} is real media`);
      assert.equal(entry.sha256, await hashFile(join(dir, entry.path)), `${entry.path} hash is real`);
      assert.equal(entry.rights.license, 'CC0-1.0');
      assert.equal(entry.rights.redistributable, true);
      assert.match(entry.rights.origin, /generated test signal/);
    }
    const audioClips = project.composition!.audio;
    assert.equal(audioClips.length, project.assets.length, 'each clip has its own signal Asset');
    for (const clip of audioClips) {
      if (clip.kind !== 'asset') assert.fail(`clip ${clip.id} must be an asset clip, got ${clip.kind}`);
      const entry = project.assets.find(candidate => candidate.id === clip.asset);
      assert.ok(entry, `clip ${clip.id} points at a registered Asset`);
      assert.equal(clip.inSample, 0, `clip ${clip.id} reads its Asset from the start`);
      assert.ok(clip.durationSamples > 0, `clip ${clip.id} has a positive duration`);
    }
    assert.equal(
      new Set(audioClips.map(clip => (clip.kind === 'asset' ? clip.asset : ''))).size,
      project.assets.length,
      'every Asset is placed by a clip',
    );
    assert.deepEqual(project.bindings, {}, 'no asset bindings');
    assert.ok(!Object.hasOwn(project as object, 'world'), 'no World state is introduced');
    assert.equal(
      project.composition!.scenes.length,
      Math.min(3, project.sources.length),
      'montage parts = min(3, segments), with no phantom scenes',
    );
    assert.ok(
      project.composition!.scenes.every(scene => project.composition!.shots.some(shot => shot.scene === scene.id)),
      'every declared scene must contain at least one shot',
    );

    // Timing retained: integer, contiguous from 0, matching the reference segments.
    assert.equal(compositionFrames(project), referenceTotal, 'total length equals the reference timeline');
    let cursor = 0;
    for (let i = 0; i < project.composition!.placements.length; i++) {
      const placement = project.composition!.placements[i];
      const source = codeSource(project, i);
      assert.ok(Number.isInteger(placement.startFrame), 'placement start must be an integer');
      assert.ok(Number.isInteger(placement.outFrame), 'placement out must be an integer');
      assert.equal(placement.startFrame, cursor, 'placements must tile the timeline from 0');
      assert.equal(
        placement.startFrame,
        report.segments[i].startFrame,
        'placement start retains the reference cut boundary',
      );
      assert.equal(
        placement.outFrame - placement.inFrame,
        report.segments[i].endFrame - report.segments[i].startFrame,
        'placement length retains the reference segment length',
      );
      assert.equal(
        source.frames,
        report.segments[i].endFrame - report.segments[i].startFrame,
        'source frame count equals the segment length',
      );
      assert.equal(
        source.params.globalStartFrame,
        report.segments[i].startFrame,
        'globalStartFrame retains the reference boundary',
      );
      assert.equal(source.params.segmentFrames, source.frames, 'segmentFrames matches the source length');
      // Only non-secret provenance is retained — never the reference path.
      assert.equal(source.params.referenceSha, report.source.sha256, 'source params retain the reference content hash');
      cursor = placement.startFrame + placement.outFrame - placement.inFrame;
    }
    assert.equal(cursor, referenceTotal);
    assert.ok(
      !JSON.stringify(project).includes(report.source.path),
      'the reference path must not leak into the project',
    );

    // Direction is honest about the simulated-taint rule and makes no model claim.
    assert.match(project.direction.intent, /timing/i);
    assert.doesNotMatch(project.direction.intent, /generat(?:ive|ed) (?:a|the) (?:model|video)/i);

    // 3. Build a real, reduced 64x64 fixture.
    const per = 3;
    const reduced = reduce(project, per);
    await writeProject(dir, reduced);
    const reducedTotal = per * reduced.sources.length;

    const build1 = await buildProject(dir);
    assert.equal(build1.status, 'succeeded');
    const final1 = build1.artifacts.find(artifact => artifact.id === build1.result!.artifact)!;
    assert.equal(final1.simulated, false, 'a pure code build is not simulated');
    assert.equal(final1.media!.frames, reducedTotal, 'the final length equals the reduced timeline');
    assert.ok(final1.media!.width === 64 && final1.media!.height === 64);
    assert.ok(final1.media!.audio, 'the final carries a mixed audio stream');
    const frameDuration = reduced.composition!.output.fps.denominator / reduced.composition!.output.fps.numerator;
    assert.ok(
      Math.abs(final1.media!.audio!.duration - reducedTotal * frameDuration) <= frameDuration,
      'the audio length must match the (clipped) timeline, not the original longer one',
    );

    // An unchanged rebuild reuses every operation and artifact.
    const build2 = await buildProject(dir);
    assert.ok(build2.operations.length > 0);
    assert.ok(
      build2.operations.every(operation => operation.reused),
      'unchanged rebuild must reuse every operation',
    );

    // Editing one Source re-renders only that Source.
    const current = await loadProject(dir);
    const edited = structuredClone(current);
    const first = codeSource(edited, 0);
    first.params = { ...first.params, intensity: 1.2 };
    await saveProject(dir, edited, current.revision);
    const build3 = await buildProject(dir);
    const codeOps = build3.operations.filter(operation => operation.kind === 'browser');
    assert.equal(codeOps.length, reduced.sources.length);
    assert.equal(codeOps.filter(operation => !operation.reused).length, 1, 'exactly one Source re-renders');
    assert.equal(
      codeOps.filter(operation => operation.reused).length,
      reduced.sources.length - 1,
      'the other Sources are reused',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('orbital: a mixed-FPS reference keeps segments in output frames (no double mapping)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-orbital-mixedfps-'));
  try {
    // Reference decodes at 10 fps (20 source frames per 2 s), but the target
    // composition runs at 30 fps: segment boundaries must come back as OUTPUT
    // frames (60 per 2 s), never re-mapped a second time by the generator.
    await writeProject(root, analysisHostProject({ numerator: 30, denominator: 1 }));
    await makeThreeSegmentReference(join(root, 'refs'), 10, 2);
    const report = await analyzeReference(root, 'refs/tri.mp4', { fps: { numerator: 30, denominator: 1 } });
    ReferenceReportSchema.parse(report);

    assert.deepEqual(report.fps, { numerator: 30, denominator: 1 });
    assert.equal(report.media.frames, 60, 'source decodes at 10 fps');
    assert.deepEqual(report.segments, [
      { startFrame: 0, endFrame: 60 },
      { startFrame: 60, endFrame: 120 },
      { startFrame: 120, endFrame: 180 },
    ]);

    const dir = join(root, 'orbital');
    await runCommand('node', [CREATE_ORBITAL, join(root, report.reportPath), dir]);
    const project = await loadProject(dir);
    assert.equal(project.composition!.output.fps.numerator, 30);
    assert.equal(compositionFrames(project), 180, 'output length is 6 s at 30 fps, not 6 s of source frames');
    assert.deepEqual(
      project.composition!.placements.map(placement => [placement.startFrame, placement.outFrame - placement.inFrame]),
      [
        [0, 60],
        [60, 60],
        [120, 60],
      ],
      'segments are used directly as output-frame intervals',
    );
    for (const source of project.sources)
      assert.equal(source.kind === 'browser' && source.output === 'picture' ? source.frames : 0, 60);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
