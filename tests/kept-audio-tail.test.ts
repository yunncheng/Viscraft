// kept-audio L-cut tail clock.
//
// For a `keep` placement with a declared `tailSamples` (an L-cut) the mixer must
// read the tail from the ORIGINAL Take on the Take's OWN source clock, starting
// where the body's source interval ended (`takeInSample + takeBodySamples`), NOT
// at the body's OUTPUT-clock length. Under a slowdown
// (`durationFrames > outFrame - inFrame`) the output-clock length is larger than
// the source interval, so the old code indexed the Take past the intended source
// position — often past the Take's audio — and the declared tail came out SILENT
// while `review` reported `tailOverrunSamples: 0` (it measured the original
// interval). These tests build a real Take with real audio and prove the mix and
// the review now agree on one clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildProject } from '../src/build/build.js';
import { reviewBuild } from '../src/operations/analysis/review.js';
import { ProjectSchema } from '../src/core/schema.js';
import type { Project } from '../src/core/schema.js';
import { hashFile } from '../src/shared/hash.js';
import { mixAudio } from '../src/backends/media/audio-mix.js';
import { runCommand } from '../src/shared/process.js';

const FPS = 25;
const FRAME_SAMPLES = 1920; // 48000 / 25
const OUT = { width: 64, height: 48, fps: { numerator: FPS, denominator: 1 }, sampleRate: 48000, channels: 2 };

const IN_FRAME = 5;
const OUT_FRAME = 15; // source interval = 10 frames
const DURATION_FRAMES = 40; // SLOWDOWN: 40 output frames > 10 source frames
const TAIL_SAMPLES = 9600; // 5 output frames of L-cut at 48 kHz
const TAIL_PLACEMENT_FRAMES = 10; // a silent placement that lengthens the programme

const BODY_SOURCE_FRAMES = OUT_FRAME - IN_FRAME; // 10
const TAKE_IN_SAMPLE = IN_FRAME * FRAME_SAMPLES; // 9600
const TAKE_BODY_SAMPLES = BODY_SOURCE_FRAMES * FRAME_SAMPLES; // 19200
const BODY_OUTPUT_SAMPLES = DURATION_FRAMES * FRAME_SAMPLES; // 76800

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'viscraft-fixture-kept-tail-'));
}

/** A real 64x48 @25fps clip of `frames` frames carrying a full-band 440 Hz tone. */
async function encodeTake(root: string, frames: number): Promise<string> {
  const file = join(root, 'take.mp4');
  await runCommand('ffmpeg', [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-loglevel',
    'error',
    '-filter_threads',
    '1',
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=64x48:rate=${FPS}:duration=${frames / FPS}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=48000:duration=${frames / FPS}`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(FPS),
    '-c:a',
    'aac',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-shortest',
    '-threads',
    '2',
    file,
  ]);
  return file;
}

/** A real project: a SLOWED `keep` body with an L-cut tail, plus a silent tail. */
async function writeSlowedKeepProject(root: string, take: string): Promise<Project> {
  const project: Project = ProjectSchema.parse({
    schemaVersion: 1,
    id: 'p1_kept_tail',
    revision: 1,
    title: 'kept tail',
    direction: {
      intent: 'slowed keep with an L-cut tail',
      looks: [{ id: 'look', description: 'as captured' }],
      transitions: [],
    },
    assets: [
      {
        id: 'asset_take',
        revision: 1,
        type: 'video',
        path: 'take.mp4',
        sha256: await hashFile(take),
        rights: { origin: 'original test pattern and tone', license: 'original test media', redistributable: true },
        simulated: false,
      },
    ],
    bindings: {},
    sources: [],
    composition: {
      output: OUT,
      scenes: [{ id: 'scene', description: 'scene' }],
      shots: [
        { id: 'shot_body', scene: 'scene', look: 'look', intent: 'slowed body', targetFrames: DURATION_FRAMES },
        {
          id: 'shot_tail',
          scene: 'scene',
          look: 'look',
          intent: 'lengthen the programme',
          targetFrames: TAIL_PLACEMENT_FRAMES,
        },
      ],
      placements: [
        {
          id: 'pl_body',
          shot: 'shot_body',
          asset: 'asset_take',
          inFrame: IN_FRAME,
          outFrame: OUT_FRAME,
          durationFrames: DURATION_FRAMES,
          startFrame: 0,
          audio: 'keep',
          audioGain: 0.6,
          audioTailSamples: TAIL_SAMPLES,
        },
        {
          id: 'pl_tail',
          shot: 'shot_tail',
          asset: 'asset_take',
          inFrame: 0,
          outFrame: TAIL_PLACEMENT_FRAMES,
          startFrame: DURATION_FRAMES,
          audio: 'mute',
        },
      ],
      transitions: [],
      audio: [],
    },
  });
  await writeFile(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
  return project;
}

/** Decode a media file's first audio stream to mono f32 PCM at 48 kHz. */
async function decodeMono(file: string, dir: string): Promise<Float32Array> {
  const raw = join(dir, `pcm-${Date.now()}-${Math.random().toString(36).slice(2)}.f32le`);
  await runCommand('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-i',
    file,
    '-map',
    '0:a:0',
    '-f',
    'f32le',
    '-ac',
    '1',
    '-ar',
    '48000',
    raw,
  ]);
  const buf = await readFile(raw);
  const out = new Float32Array(Math.floor(buf.length / 4));
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  await rm(raw, { force: true });
  return out;
}

function rms(pcm: Float32Array, from: number, to: number): number {
  const end = Math.max(from, Math.min(to, pcm.length));
  let sum = 0;
  for (let i = from; i < end; i++) sum += pcm[i]! * pcm[i]!;
  return end > from ? Math.sqrt(sum / (end - from)) : 0;
}

async function finalArtifactPath(root: string, build: Awaited<ReturnType<typeof buildProject>>): Promise<string> {
  const final = build.artifacts.find(artifact => artifact.id === build.result!.artifact)!;
  return join(root, final.path);
}

test('a slowed keep placement hears its L-cut tail from the Take (not read past the source)', async () => {
  const root = await tempDir();
  try {
    // A 30-frame (1.2 s) Take: its audio runs well BEYOND `outFrame` (frame 15).
    const take = await encodeTake(root, 30);
    await writeSlowedKeepProject(root, take);

    const build = await buildProject(root);
    assert.equal(build.status, 'succeeded', 'the slowed keep fixture must build');

    const pcm = await decodeMono(await finalArtifactPath(root, build), root);
    const bodyRms = rms(pcm, 0, BODY_OUTPUT_SAMPLES);
    const tailRms = rms(pcm, BODY_OUTPUT_SAMPLES, BODY_OUTPUT_SAMPLES + TAIL_SAMPLES);
    // The retimed body itself carries the stretched tone.
    assert.ok(bodyRms > 0.01, `the retimed body must carry audio (RMS ${bodyRms})`);
    // The tail sits after the OUTPUT-clock body and must be the Take's own audio.
    // On the buggy code the tail read at `takeInSample + clipFrames` (past the
    // Take) and this region was silent (RMS 0).
    assert.ok(tailRms > 0.01, `the L-cut tail after the slowed body must carry the Take's audio (RMS ${tailRms})`);

    // The mixer and review must agree: for a tail inside the Take's audio the
    // report is 0 overrun and inside the Take.
    const review = await reviewBuild(root);
    const report = JSON.parse(await readFile(join(root, review.report), 'utf8')) as {
      keptAudio: Array<Record<string, number | boolean>>;
    };
    assert.equal(report.keptAudio.length, 1, 'one kept placement declares an L-cut');
    const fact = report.keptAudio[0]!;
    assert.equal(fact.takeInSample, TAKE_IN_SAMPLE, 'the handle origin is the placement ORIGINAL inFrame');
    assert.equal(
      fact.requestedEndSample,
      TAKE_IN_SAMPLE + TAKE_BODY_SAMPLES + TAIL_SAMPLES,
      'the tail is measured from the end of the SOURCE interval, not the retimed output length',
    );
    assert.equal(fact.tailOverrunSamples, 0, 'a 9600-sample tail inside the Take must not overrun');
    assert.equal(fact.beyondTakeAudio, false, 'the declared tail stays inside the real Take audio');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a declared tail that genuinely exceeds the Take audio reports a non-zero overrun', async () => {
  const root = await tempDir();
  try {
    // A 15-frame (0.6 s) Take: its audio ends exactly where the source interval
    // ends (frame 15 = 28800 samples), so the same 9600-sample tail runs past it.
    const take = await encodeTake(root, 15);
    await writeSlowedKeepProject(root, take);

    const build = await buildProject(root);
    assert.equal(build.status, 'succeeded', 'a tail past the Take audio is a fact, not a build failure');

    const review = await reviewBuild(root);
    const report = JSON.parse(await readFile(join(root, review.report), 'utf8')) as {
      keptAudio: Array<Record<string, number | boolean>>;
    };
    assert.equal(report.keptAudio.length, 1);
    const fact = report.keptAudio[0]!;
    assert.ok(
      (fact.tailOverrunSamples as number) > 0,
      `a tail past the Take's audio must report a non-zero overrun (got ${fact.tailOverrunSamples})`,
    );
    assert.equal(
      fact.beyondTakeAudio,
      true,
      'the report must flag the shortfall rather than implying silence was heard',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a declared tail without a source-clock body length is refused loudly (no silent fallback)', async () => {
  const root = await tempDir();
  try {
    const take = await encodeTake(root, 15);
    const project = await writeSlowedKeepProject(root, take);
    const destination = join(root, 'direct.wav');
    const entry = { path: take, startFrame: 0, tailSamples: 4800, takePath: take, takeInSample: 0 };
    // Without the source-clock body length the mixer cannot place the tail, so it
    // must refuse rather than silently falling back to the body's OUTPUT length
    // (which is exactly the bug this contract removes).
    await assert.rejects(
      () => mixAudio(root, project, [entry], DURATION_FRAMES, destination),
      /must declare takeBodySamples/,
    );
    // With it, the same call mixes.
    await mixAudio(root, project, [{ ...entry, takeBodySamples: TAKE_BODY_SAMPLES }], DURATION_FRAMES, destination);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
