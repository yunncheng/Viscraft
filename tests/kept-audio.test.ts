import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { createHash } from 'node:crypto';

import { composeVideo } from '../src/backends/media/picture.js';
import { encodeWav } from '../src/backends/media/pcm.js';
import { mixAudio } from '../src/backends/media/audio-mix.js';
import { probeMedia } from '../src/backends/media/probe.js';
import type { ComposeClip } from '../src/backends/media/picture.js';
import { buildProject } from '../src/build/build.js';
import { loadProject, saveProject } from '../src/project/project.js';
import { PlacementSchema, ProjectSchema } from '../src/core/schema.js';
import type { OutputSettings, Placement, Project } from '../src/core/schema.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';

const OUT: OutputSettings = {
  width: 64,
  height: 48,
  fps: { numerator: 25, denominator: 1 },
  sampleRate: 48000,
  channels: 2,
};
const TOTAL_FRAMES = 25; // one second at 25 fps -> 48000 programme samples
const TOTAL_SAMPLES = 48000;
const FPS_25 = '25';
const KEPT_SECONDS = 0.2; // 9600 stereo frames
const KEPT_FRAMES = 9600;
const START_FRAME = 10; // 19200 samples
const START_SAMPLE = 19200;
const DC = 0.5; // every kept sample is exactly this, so RMS/onset are unambiguous

async function ffmpeg(args: string[]): Promise<void> {
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
    ...args,
  ]);
}

async function tempDir(): Promise<string> {
  return fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-kept-audio-test-'));
}

/** A constant-amplitude stereo WAV so gain/fades/onset are directly measurable. */
async function makeConstantWav(dir: string, name: string, seconds: number): Promise<string> {
  const out = nodePath.join(dir, name);
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `aevalsrc=${DC}|${DC}:s=48000:d=${seconds}`,
    '-ac',
    '2',
    '-c:a',
    'pcm_s16le',
    '-ar',
    '48000',
    out,
  ]);
  return out;
}

async function makeColorClip(dir: string, name: string, color: string, frames: number): Promise<string> {
  const out = nodePath.join(dir, name);
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:size=64x48:rate=${FPS_25}`,
    '-frames:v',
    String(frames),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-r',
    FPS_25,
    '-an',
    out,
  ]);
  return out;
}

function readWav16(file: Buffer): { channels: number; samples: Int16Array } {
  assert.equal(file.toString('ascii', 0, 4), 'RIFF');
  assert.equal(file.toString('ascii', 8, 12), 'WAVE');
  const channels = file.readUInt16LE(22);
  const count = (file.length - 44) / 2;
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i++) samples[i] = file.readInt16LE(44 + i * 2);
  return { channels, samples };
}

/** First channel value at a programme frame (channels are interleaved). */
function channel0(wav: { channels: number; samples: Int16Array }, frame: number): number {
  return wav.samples[frame * wav.channels];
}

function firstNonZeroFrame(wav: { channels: number; samples: Int16Array }): number {
  for (let frame = 0; frame * wav.channels < wav.samples.length; frame++) if (channel0(wav, frame) !== 0) return frame;
  return -1;
}

function lastNonZeroFrame(wav: { channels: number; samples: Int16Array }): number {
  for (let frame = Math.floor(wav.samples.length / wav.channels) - 1; frame >= 0; frame--)
    if (channel0(wav, frame) !== 0) return frame;
  return -1;
}

function rms(wav: { channels: number; samples: Int16Array }, fromFrame: number, toFrame: number): number {
  let sum = 0;
  for (let frame = fromFrame; frame < toFrame; frame++) sum += (channel0(wav, frame) / 32767) ** 2;
  return Math.sqrt(sum / (toFrame - fromFrame));
}

function placement(
  id: string,
  inFrame: number,
  outFrame: number,
  startFrame: number,
  audio: 'mute' | 'keep' = 'keep',
  extra: Partial<Placement> = {},
): Placement {
  return { id, shot: 'shot_1', source: 'src_1', inFrame, outFrame, startFrame, audio, ...extra };
}

function makeProject(placements: Placement[]): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'test_project',
    revision: 1,
    title: 'Test',
    direction: { intent: 'test', looks: [{ id: 'look_main', description: 'main look' }], transitions: [] },
    assets: [],
    bindings: {},
    sources: [],
    composition: {
      output: OUT,
      scenes: [{ id: 'scene_1', description: 'scene' }],
      shots: [{ id: 'shot_1', scene: 'scene_1', look: 'look_main', intent: 'shot', targetFrames: 25 }],
      placements,
      transitions: [],
      audio: [],
    },
  });
}

/** Decode any media file to interleaved float PCM, mirroring the mixer's own decode. */
async function decodeF32(file: string, dir: string): Promise<Float32Array> {
  const raw = nodePath.join(dir, `ref-${Math.random().toString(36).slice(2)}.f32le`);
  await ffmpeg(['-i', file, '-vn', '-f', 'f32le', '-acodec', 'pcm_f32le', '-ar', '48000', '-ac', '2', raw]);
  const buf = await fs.readFile(raw);
  const out = new Float32Array(Math.floor(buf.length / 4));
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  await fs.rm(raw, { force: true });
  return out;
}

test('(a) a negative audioOffsetSamples is a deliberate GLOBAL time-shift (not a J-cut): the whole clip moves while the picture is byte-identical', async () => {
  const dir = await tempDir();
  try {
    const keptWav = await makeConstantWav(dir, 'kept.wav', KEPT_SECONDS);
    const project = makeProject([placement('place_a', 0, 25, START_FRAME, 'keep')]);

    const plain = nodePath.join(dir, 'plain.wav');
    await mixAudio(dir, project, [{ path: keptWav, startFrame: START_FRAME }], TOTAL_FRAMES, plain);
    const shifted = nodePath.join(dir, 'shifted.wav');
    await mixAudio(
      dir,
      project,
      [{ path: keptWav, startFrame: START_FRAME, offsetSamples: -KEPT_FRAMES }],
      TOTAL_FRAMES,
      shifted,
    );

    const plainWav = readWav16(await fs.readFile(plain));
    const shiftedWav = readWav16(await fs.readFile(shifted));
    assert.equal(firstNonZeroFrame(plainWav), START_SAMPLE, 'without offset the kept audio begins at startFrame');
    assert.equal(
      firstNonZeroFrame(shiftedWav),
      START_SAMPLE - KEPT_FRAMES,
      'a negative offset moves the WHOLE clip one kept-length earlier (a global time-shift, not a cross-cut audio lead)',
    );
    assert.equal(
      lastNonZeroFrame(shiftedWav),
      lastNonZeroFrame(plainWav) - KEPT_FRAMES,
      'the offset moves the whole clip, body included — it does not lengthen the audio like a true J-cut',
    );
    assert.ok(
      firstNonZeroFrame(shiftedWav) < firstNonZeroFrame(plainWav),
      'the shifted clip truly precedes the picture',
    );

    // Picture bytes must not move: composition ignores the audio-shaping fields.
    const clip = await makeColorClip(dir, 'pic.mp4', 'blue', 25);
    const media = await probeMedia(clip);
    const base = makeProject([placement('place_a', 0, 25, 0, 'keep')]);
    const clips: ComposeClip[] = [{ placement: base.composition!.placements[0], path: clip, media }];
    const outA = nodePath.join(dir, 'pic-a.mp4');
    const outB = nodePath.join(dir, 'pic-b.mp4');
    const variant = makeProject([placement('place_a', 0, 25, 0, 'keep', { audioOffsetSamples: -9600 })]);
    await composeVideo(base, clips, outA);
    await composeVideo(variant, [{ placement: variant.composition!.placements[0], path: clip, media }], outB);
    const hash = async (file: string) =>
      createHash('sha256')
        .update(await fs.readFile(file))
        .digest('hex');
    assert.equal(await hash(outA), await hash(outB), 'the composed picture is unchanged by an audio-only offset');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('(b) audioGain halves the kept window RMS', async () => {
  const dir = await tempDir();
  try {
    const keptWav = await makeConstantWav(dir, 'kept.wav', KEPT_SECONDS);
    const project = makeProject([placement('place_a', 0, 25, START_FRAME, 'keep')]);

    const full = nodePath.join(dir, 'full.wav');
    await mixAudio(dir, project, [{ path: keptWav, startFrame: START_FRAME }], TOTAL_FRAMES, full);
    const half = nodePath.join(dir, 'half.wav');
    await mixAudio(dir, project, [{ path: keptWav, startFrame: START_FRAME, gain: 0.5 }], TOTAL_FRAMES, half);

    const fullWav = readWav16(await fs.readFile(full));
    const halfWav = readWav16(await fs.readFile(half));
    const fullRms = rms(fullWav, START_SAMPLE + 100, START_SAMPLE + KEPT_FRAMES - 100);
    const halfRms = rms(halfWav, START_SAMPLE + 100, START_SAMPLE + KEPT_FRAMES - 100);
    assert.ok(Math.abs(fullRms - DC) < 0.01, `gain 1 must keep the source amplitude (got ${fullRms.toFixed(4)})`);
    assert.ok(
      Math.abs(halfRms / fullRms - 0.5) < 0.02,
      `gain 0.5 must halve the RMS (got ratio ${(halfRms / fullRms).toFixed(4)})`,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('(c) a fade removes the edge discontinuity without shortening the kept clip', async () => {
  const dir = await tempDir();
  try {
    const keptWav = await makeConstantWav(dir, 'kept.wav', KEPT_SECONDS);
    const project = makeProject([placement('place_a', 0, 25, START_FRAME, 'keep')]);

    const dry = nodePath.join(dir, 'dry.wav');
    await mixAudio(dir, project, [{ path: keptWav, startFrame: START_FRAME }], TOTAL_FRAMES, dry);
    const faded = nodePath.join(dir, 'faded.wav');
    await mixAudio(
      dir,
      project,
      [{ path: keptWav, startFrame: START_FRAME, fadeInSamples: 2400, fadeOutSamples: 2400 }],
      TOTAL_FRAMES,
      faded,
    );

    const dryWav = readWav16(await fs.readFile(dry));
    const fadedWav = readWav16(await fs.readFile(faded));
    const start = START_SAMPLE;
    const end = START_SAMPLE + KEPT_FRAMES - 1;

    assert.equal(channel0(dryWav, start), 16384, 'without a fade the first sample is the full-amplitude discontinuity');
    assert.ok(
      Math.abs(channel0(fadedWav, start)) < 10,
      `faded first sample must be near zero (got ${channel0(fadedWav, start)})`,
    );
    assert.ok(
      Math.abs(channel0(fadedWav, end)) < 10,
      `faded last sample must be near zero (got ${channel0(fadedWav, end)})`,
    );
    assert.ok(channel0(fadedWav, start + 4800) > 16000, 'the fade body must reach full amplitude mid-clip');
    // Not shortened: the last kept frame still carries signal and the frame after it is silent.
    assert.notEqual(channel0(fadedWav, end), 0, 'the clip tail must survive the fade (no shortening)');
    assert.equal(lastNonZeroFrame(fadedWav), end, 'the faded clip must end at the same frame as the dry clip');
    assert.equal(channel0(fadedWav, START_SAMPLE + KEPT_FRAMES), 0, 'nothing leaks past the kept clip extent');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('(d) out-of-range gain and offsets that run off the programme are rejected', async () => {
  const dir = await tempDir();
  try {
    const keptWav = await makeConstantWav(dir, 'kept.wav', KEPT_SECONDS);
    const project = makeProject([placement('place_a', 0, 25, START_FRAME, 'keep')]);
    const dest = nodePath.join(dir, 'out.wav');

    await assert.rejects(
      () => mixAudio(dir, project, [{ path: keptWav, startFrame: 0, gain: 3 }], TOTAL_FRAMES, dest),
      /invalid gain/,
    );
    await assert.rejects(
      () => mixAudio(dir, project, [{ path: keptWav, startFrame: 0, offsetSamples: -1 }], TOTAL_FRAMES, dest),
      /before the programme/,
    );
    await assert.rejects(
      () => mixAudio(dir, project, [{ path: keptWav, startFrame: 20, offsetSamples: 9600 }], TOTAL_FRAMES, dest),
      /start(s| )?past the programme end|past the programme end/,
    );
    await assert.rejects(
      () => mixAudio(dir, project, [{ path: keptWav, startFrame: 20, offsetSamples: 1 }], TOTAL_FRAMES, dest),
      /extends past the programme end/,
    );
    await assert.rejects(
      () => mixAudio(dir, project, [{ path: keptWav, startFrame: 24, offsetSamples: 0.5 }], TOTAL_FRAMES, dest),
      /invalid offsetSamples/,
    );

    // With no explicit offset, a tail past the programme is truncated (not
    // rejected): omitting the optional field keeps the default placement.
    const truncated = nodePath.join(dir, 'truncated.wav');
    await mixAudio(dir, project, [{ path: keptWav, startFrame: 24 }], TOTAL_FRAMES, truncated);
    const wav = readWav16(await fs.readFile(truncated));
    assert.equal(channel0(wav, TOTAL_SAMPLES - 1), 16384, 'the in-range tail sample is mixed');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('(e) a mute placement that sets a kept-audio field fails schema validation', async () => {
  const base = { id: 'place_a', shot: 'shot_1', source: 'src_1', inFrame: 0, outFrame: 25, startFrame: 0 } as const;

  assert.ok(
    PlacementSchema.safeParse({ ...base, audio: 'mute' }).success,
    'a mute placement that omits the fields is valid',
  );
  assert.ok(
    PlacementSchema.safeParse({
      ...base,
      audio: 'keep',
      audioGain: 0.5,
      audioFadeInSamples: 10,
      audioFadeOutSamples: 10,
      audioOffsetSamples: -5,
      audioTailSamples: 4800,
      audioLeadSamples: 4800,
    }).success,
    'a keep placement may set the fields',
  );

  for (const bad of [
    { audioGain: 0.5 },
    { audioFadeInSamples: 10 },
    { audioFadeOutSamples: 10 },
    { audioOffsetSamples: -5 },
    { audioTailSamples: 4800 },
    { audioTailSamples: -4800 },
    { audioLeadSamples: 4800 },
  ]) {
    const result = PlacementSchema.safeParse({ ...base, audio: 'mute', ...bad });
    assert.equal(result.success, false, `mute placement must reject ${Object.keys(bad)[0]}`);
  }
  // A lead is a nonnegative pre-roll length; a negative value has no meaning.
  assert.equal(
    PlacementSchema.safeParse({ ...base, audio: 'keep', audioLeadSamples: -1 }).success,
    false,
    'a negative audioLeadSamples is rejected',
  );
  // The same mistake is caught through the full Project schema.
  assert.equal(
    ProjectSchema.safeParse({
      ...makeProject([placement('place_a', 0, 25, 0, 'mute')]),
    }).success,
    true,
  );
  const projectShape = JSON.parse(JSON.stringify(makeProject([placement('place_a', 0, 25, 0, 'mute')])));
  projectShape.composition.placements[0].audioGain = 0.5;
  assert.equal(
    ProjectSchema.safeParse(projectShape).success,
    false,
    'ProjectSchema rejects a muted placement carrying kept-audio shaping',
  );
});

test('(f) omitting the five kept-audio fields reproduces the default additive mix exactly', async () => {
  const dir = await tempDir();
  try {
    const keptWav = await makeConstantWav(dir, 'kept.wav', KEPT_SECONDS);
    const project = makeProject([placement('place_a', 0, 25, START_FRAME, 'keep')]);

    const omitted = nodePath.join(dir, 'omitted.wav');
    await mixAudio(dir, project, [{ path: keptWav, startFrame: START_FRAME }], TOTAL_FRAMES, omitted);
    const explicit = nodePath.join(dir, 'explicit.wav');
    await mixAudio(
      dir,
      project,
      [
        {
          path: keptWav,
          startFrame: START_FRAME,
          gain: 1,
          fadeInSamples: 0,
          fadeOutSamples: 0,
          offsetSamples: 0,
          tailSamples: 0,
        },
      ],
      TOTAL_FRAMES,
      explicit,
    );

    // Reference: the default mix — decode the kept source and add it at
    // startFrame with unit gain, no fades, offset or tail, then encode identically.
    const pcm = await decodeF32(keptWav, dir);
    const reference = new Float32Array(TOTAL_SAMPLES * 2);
    const base = START_SAMPLE * 2;
    for (let j = 0; j < Math.min(pcm.length, reference.length - base); j++) reference[base + j] += pcm[j];
    const referenceBytes = encodeWav(reference, 48000, 2);

    const omittedBytes = await fs.readFile(omitted);
    assert.ok(omittedBytes.equals(referenceBytes), 'omitted fields must reproduce the default mix byte-for-byte');
    assert.ok((await fs.readFile(explicit)).equals(omittedBytes), 'explicit defaults must equal omitted fields');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('(g) an L-cut tailSamples carries the Take audio past the picture cut', async () => {
  const dir = await tempDir();
  try {
    const keptWav = await makeConstantWav(dir, 'kept.wav', KEPT_SECONDS); // picture-length body (9600 frames)
    const takeWav = await makeConstantWav(dir, 'take.wav', 0.5); // the Take's own audio (24000 frames)
    const project = makeProject([placement('place_a', 0, 25, START_FRAME, 'keep')]);
    const TAIL = 4800; // 0.1 s of audio past the picture cut
    const pictureEnd = START_SAMPLE + KEPT_FRAMES; // 28800

    const dry = nodePath.join(dir, 'dry.wav');
    await mixAudio(dir, project, [{ path: keptWav, startFrame: START_FRAME }], TOTAL_FRAMES, dry);
    const lcut = nodePath.join(dir, 'lcut.wav');
    await mixAudio(
      dir,
      project,
      [
        {
          path: keptWav,
          startFrame: START_FRAME,
          tailSamples: TAIL,
          takePath: takeWav,
          takeInSample: 0,
          takeBodySamples: KEPT_FRAMES,
        },
      ],
      TOTAL_FRAMES,
      lcut,
    );

    const dryWav = readWav16(await fs.readFile(dry));
    const lcutWav = readWav16(await fs.readFile(lcut));
    assert.equal(channel0(dryWav, pictureEnd), 0, 'without a tail the audio stops at the picture cut');
    assert.equal(channel0(lcutWav, pictureEnd), 16384, 'the L-cut continues the Take audio after the picture cut');
    assert.equal(lastNonZeroFrame(lcutWav), pictureEnd + TAIL - 1, 'the audio extent is clipFrames + tailSamples');
    assert.equal(channel0(lcutWav, pictureEnd + TAIL), 0, 'the tail stops exactly at the extended extent');
    assert.equal(firstNonZeroFrame(lcutWav), START_SAMPLE, 'the picture-positioned onset is unchanged by the tail');

    // Picture bytes must not move: composition ignores the audio tail field.
    const clip = await makeColorClip(dir, 'pic.mp4', 'blue', 25);
    const media = await probeMedia(clip);
    const base = makeProject([placement('place_a', 0, 25, 0, 'keep')]);
    const variant = makeProject([placement('place_a', 0, 25, 0, 'keep', { audioTailSamples: TAIL })]);
    const outA = nodePath.join(dir, 'pic-a.mp4');
    const outB = nodePath.join(dir, 'pic-b.mp4');
    const hash = async (file: string) =>
      createHash('sha256')
        .update(await fs.readFile(file))
        .digest('hex');
    await composeVideo(base, [{ placement: base.composition!.placements[0], path: clip, media }], outA);
    await composeVideo(variant, [{ placement: variant.composition!.placements[0], path: clip, media }], outB);
    assert.equal(await hash(outA), await hash(outB), 'the composed picture is unchanged by an audio-only tail');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('(h) a combined global offset and L-cut spans [start+offset, start+offset+len+tail)', async () => {
  const dir = await tempDir();
  try {
    const keptWav = await makeConstantWav(dir, 'kept.wav', KEPT_SECONDS);
    const takeWav = await makeConstantWav(dir, 'take.wav', 0.5);
    const project = makeProject([placement('place_a', 0, 25, START_FRAME, 'keep')]);
    const J = 4800; // here a negative OFFSET: a deliberate global shift, not a cross-cut lead
    const L = 4800;
    const start = START_SAMPLE - J; // picture leads: the whole clip is shifted early
    const end = start + KEPT_FRAMES + L;

    const destination = nodePath.join(dir, 'jl.wav');
    await mixAudio(
      dir,
      project,
      [
        {
          path: keptWav,
          startFrame: START_FRAME,
          offsetSamples: -J,
          tailSamples: L,
          takePath: takeWav,
          takeInSample: 0,
          takeBodySamples: KEPT_FRAMES,
        },
      ],
      TOTAL_FRAMES,
      destination,
    );
    const wav = readWav16(await fs.readFile(destination));
    assert.equal(firstNonZeroFrame(wav), start, 'a negative offset shifts the whole clip before the picture');
    assert.equal(lastNonZeroFrame(wav), end - 1, 'an L-cut trails the audio past the picture cut');
    assert.equal(channel0(wav, start - 1), 0, 'nothing before the leading edge');
    assert.equal(channel0(wav, end), 0, 'nothing after the trailing edge');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('(i) a tail past the programme end or a non-positive extent is rejected', async () => {
  const dir = await tempDir();
  try {
    const keptWav = await makeConstantWav(dir, 'kept.wav', KEPT_SECONDS);
    const takeWav = await makeConstantWav(dir, 'take.wav', 0.5);
    const project = makeProject([placement('place_a', 0, 25, START_FRAME, 'keep')]);
    const dest = nodePath.join(dir, 'out.wav');

    // startFrame 20 -> start 38400; extent 9600 + 4800 = 14400 -> 52800 > 48000.
    await assert.rejects(
      () =>
        mixAudio(
          dir,
          project,
          [{ path: keptWav, startFrame: 20, tailSamples: 4800, takePath: takeWav, takeInSample: 0 }],
          TOTAL_FRAMES,
          dest,
        ),
      /extends past the programme end/,
    );
    // tail equal to the negative of the clip length -> extent 0.
    await assert.rejects(
      () => mixAudio(dir, project, [{ path: keptWav, startFrame: 0, tailSamples: -KEPT_FRAMES }], TOTAL_FRAMES, dest),
      /non-positive audio extent/,
    );
    // tail beyond the clip -> negative extent.
    await assert.rejects(
      () =>
        mixAudio(dir, project, [{ path: keptWav, startFrame: 0, tailSamples: -KEPT_FRAMES - 100 }], TOTAL_FRAMES, dest),
      /non-positive audio extent/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('(j) an audio-only placement edit reuses the composited picture but re-mixes the kept audio', async () => {
  // `compose-video` is keyed only on picture-affecting placement fields, so
  // editing `audioGain` (or
  // any other audio-only field) reuses the composited picture while `mix-audio`
  // re-runs. Exercised through a real Build so the artifact identity is real.
  const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-kept-audio-reuse-'));
  try {
    const video = nodePath.join(dir, 'flat.mp4');
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=96x54:rate=25:duration=1',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-r',
      '25',
      '-c:a',
      'aac',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-shortest',
      video,
    ]);
    const sha = await hashFile(video);
    const template: Project = ProjectSchema.parse({
      schemaVersion: 1,
      id: 'kept_reuse',
      revision: 1,
      title: 'Kept reuse',
      direction: { intent: 'reuse', looks: [{ id: 'look_main', description: 'as captured' }], transitions: [] },
      assets: [
        {
          id: 'asset_flat',
          revision: 1,
          type: 'video',
          path: 'flat.mp4',
          sha256: sha,
          rights: { origin: 'original test fixture', license: 'original test media', redistributable: true },
          simulated: false,
        },
      ],
      bindings: {},
      sources: [],
      composition: {
        output: { width: 96, height: 54, fps: { numerator: 25, denominator: 1 }, sampleRate: 48000, channels: 2 },
        scenes: [{ id: 'scene_1', description: 'flat' }],
        shots: [{ id: 'shot_1', scene: 'scene_1', look: 'look_main', intent: 'kept audio', targetFrames: 45 }],
        placements: [
          { id: 'pl_head', shot: 'shot_1', asset: 'asset_flat', inFrame: 0, outFrame: 5, startFrame: 0, audio: 'mute' },
          {
            id: 'pl_keep',
            shot: 'shot_1',
            asset: 'asset_flat',
            inFrame: 0,
            outFrame: 20,
            startFrame: 5,
            audio: 'keep',
          },
          {
            id: 'pl_mute',
            shot: 'shot_1',
            asset: 'asset_flat',
            inFrame: 0,
            outFrame: 20,
            startFrame: 25,
            audio: 'mute',
          },
        ],
        transitions: [],
        audio: [],
      },
    });
    await fs.writeFile(nodePath.join(dir, 'project.json'), JSON.stringify(template, null, 2) + '\n', 'utf8');

    const baseline = await buildProject(dir);
    assert.equal(baseline.status, 'succeeded');
    const composeId = baseline.operations.find(operation => operation.kind === 'compose-video')!.artifact;
    assert.equal(
      baseline.operations.find(operation => operation.kind === 'mix-audio')!.reused,
      false,
      'the baseline mixes fresh',
    );

    const unchanged = await buildProject(dir);
    assert.ok(
      unchanged.operations.every(operation => operation.reused),
      'an unchanged rebuild reuses everything',
    );

    // Every audio-only placement key must leave the picture operation untouched.
    // gain/fades/offset/tail/lead (and `audio` itself) re-run the mix; `bus` routes
    // a stem only and leaves the full programme mix reused. Edits target the keep
    // placement by id so a head placement can anchor the timeline at frame 0.
    const keepOf = (project: Project) => project.composition!.placements.find(placement => placement.id === 'pl_keep')!;
    const edits: Array<{ label: string; apply: (project: Project) => void; remixes: boolean }> = [
      {
        label: 'audioGain',
        apply: project => {
          keepOf(project).audioGain = 0.5;
        },
        remixes: true,
      },
      {
        label: 'audioOffsetSamples',
        apply: project => {
          keepOf(project).audioOffsetSamples = 2400;
        },
        remixes: true,
      },
      {
        label: 'audioLeadSamples',
        apply: project => {
          keepOf(project).audioLeadSamples = 2400;
        },
        remixes: true,
      },
      {
        label: 'audioFadeInSamples',
        apply: project => {
          keepOf(project).audioFadeInSamples = 1200;
        },
        remixes: true,
      },
      {
        label: 'audioTailSamples',
        apply: project => {
          keepOf(project).audioTailSamples = 2400;
        },
        remixes: true,
      },
      {
        label: 'bus',
        apply: project => {
          keepOf(project).bus = 'dialogue';
        },
        remixes: false,
      },
      {
        label: 'audio',
        apply: project => {
          keepOf(project).audio = 'mute';
        },
        remixes: true,
      },
    ];
    for (const { label, apply, remixes } of edits) {
      const current = await loadProject(dir);
      const edited = structuredClone(current);
      apply(edited);
      await saveProject(dir, edited, current.revision);

      const build = await buildProject(dir);
      assert.equal(build.status, 'succeeded', `${label}: the edit builds`);
      const compose = build.operations.find(operation => operation.kind === 'compose-video')!;
      assert.equal(compose.reused, true, `${label}: an audio-only edit must reuse the composited picture`);
      assert.equal(compose.artifact, composeId, `${label}: the composed pixel artifact id must be unchanged`);
      assert.equal(
        build.operations.find(operation => operation.kind === 'mix-audio')!.reused,
        !remixes,
        `${label}: mix-audio reuse`,
      );

      const reverted = structuredClone(await loadProject(dir));
      reverted.composition!.placements = structuredClone(template.composition!.placements);
      await saveProject(dir, reverted, reverted.revision);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** A stereo PCM16 WAV whose samples step from `low` to `high` at `split`. */
function steppedStereoWav(sampleRate: number, totalFrames: number, split: number, low: number, high: number): Buffer {
  const channels = 2;
  const data = Buffer.alloc(totalFrames * channels * 2);
  for (let i = 0; i < totalFrames; i++) {
    const s = Math.max(-32768, Math.min(32767, Math.round((i < split ? low : high) * 32767)));
    data.writeInt16LE(s, i * channels * 2);
    data.writeInt16LE(s, (i * channels + 1) * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test("(k) a true J-cut (audioLeadSamples) plays the Take's own pre-roll before the clip and keeps the body sample-aligned", async () => {
  const dir = await tempDir();
  try {
    // The Take's own audio steps 0.25 -> 0.75 at sample 12000; the kept body WAV
    // is a distinct constant 0.5, so pre-roll and body are unambiguously separable.
    const takeWav = nodePath.join(dir, 'take.wav');
    await fs.writeFile(takeWav, steppedStereoWav(48000, 24000, 12000, 0.25, 0.75));
    const keptWav = await makeConstantWav(dir, 'kept.wav', KEPT_SECONDS); // body 0.5, 9600 frames
    const project = makeProject([placement('place_a', 0, 25, START_FRAME, 'keep')]);
    const LEAD = 4800;
    const takeInSample = 12000; // the body begins at take sample 12000
    const leadStart = START_SAMPLE - LEAD; // 14400

    const destination = nodePath.join(dir, 'lead.wav');
    await mixAudio(
      dir,
      project,
      [{ path: keptWav, startFrame: START_FRAME, leadSamples: LEAD, takePath: takeWav, takeInSample }],
      TOTAL_FRAMES,
      destination,
    );
    const wav = readWav16(await fs.readFile(destination));

    // The leading region is the Take's OWN pre-roll (0.25), read from before takeInSample.
    assert.equal(firstNonZeroFrame(wav), leadStart, 'a J-cut starts the audio LEAD samples before the picture');
    assert.ok(
      Math.abs(channel0(wav, leadStart) - Math.round(0.25 * 32767)) <= 1,
      `the leading edge is the Take pre-roll, not silence or the body (got ${channel0(wav, leadStart)})`,
    );
    assert.equal(channel0(wav, leadStart - 1), 0, 'nothing before the pre-roll');
    // The body is NOT shifted: it still starts exactly at startFrame with the body signal.
    assert.equal(
      channel0(wav, START_SAMPLE),
      16384,
      'the body starts sample-aligned at startFrame with the body amplitude (0.5)',
    );
    assert.ok(
      Math.abs(channel0(wav, START_SAMPLE - 1) - Math.round(0.25 * 32767)) <= 1,
      'the sample before the body is still pre-roll, so the body did not move',
    );
    assert.equal(lastNonZeroFrame(wav), START_SAMPLE + KEPT_FRAMES - 1, 'the J-cut does not move the clip tail');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('(l) a real Build with audioLeadSamples: decoded PCM shows the Take pre-roll leads and the body stays sample-aligned', async () => {
  const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-lead-build-'));
  try {
    const video = nodePath.join(dir, 'clip.mp4');
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=64x48:rate=25:duration=1',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-r',
      '25',
      '-c:a',
      'aac',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-shortest',
      video,
    ]);
    const sha = await hashFile(video);
    const template: Project = ProjectSchema.parse({
      schemaVersion: 1,
      id: 'lead_build',
      revision: 1,
      title: 'Lead build',
      direction: { intent: 'lead', looks: [{ id: 'look', description: 'as captured' }], transitions: [] },
      assets: [
        {
          id: 'asset_clip',
          revision: 1,
          type: 'video',
          path: 'clip.mp4',
          sha256: sha,
          rights: { origin: 'original test fixture', license: 'original test media', redistributable: true },
          simulated: false,
        },
      ],
      bindings: {},
      sources: [],
      composition: {
        output: { width: 64, height: 48, fps: { numerator: 25, denominator: 1 }, sampleRate: 48000, channels: 2 },
        scenes: [{ id: 'scene', description: 'scene' }],
        shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: 'lead', targetFrames: 20 }],
        placements: [
          { id: 'pl_head', shot: 'shot', asset: 'asset_clip', inFrame: 0, outFrame: 5, startFrame: 0, audio: 'mute' },
          {
            id: 'pl_lead',
            shot: 'shot',
            asset: 'asset_clip',
            inFrame: 10,
            outFrame: 20,
            startFrame: 5,
            audio: 'keep',
            audioLeadSamples: 4800,
          },
        ],
        transitions: [],
        audio: [],
      },
    });
    await fs.writeFile(nodePath.join(dir, 'project.json'), `${JSON.stringify(template, null, 2)}\n`, 'utf8');

    const build = await buildProject(dir);
    assert.equal(build.status, 'succeeded');
    const mixArtifact = build.artifacts.find(
      artifact => artifact.id === build.operations.find(operation => operation.kind === 'mix-audio')!.artifact,
    )!;
    const takeArtifact = build.artifacts.find(
      artifact => artifact.id === build.takes.find(take => take.asset === 'asset_clip')!.artifact,
    )!;
    const mix = readWav16(await fs.readFile(nodePath.join(dir, mixArtifact.path)));
    const takeRef = await decodeF32(nodePath.join(dir, takeArtifact.path), dir);

    const takeInSample = 10 * 1920; // framesToSamples(10) at 25 fps / 48 kHz
    const startSample = 5 * 1920; // framesToSamples(5)
    const LEAD = 4800;
    const leadStart = startSample - LEAD;

    // The programme starts with non-silent Take pre-roll, strictly before the body.
    assert.ok(
      firstNonZeroFrame(mix) >= leadStart && firstNonZeroFrame(mix) < startSample,
      `the leading audio must begin at the pre-roll edge (got ${firstNonZeroFrame(mix)}, expected in [${leadStart}, ${startSample}))`,
    );
    assert.equal(channel0(mix, leadStart - 1), 0, 'nothing before the leading edge');
    assert.ok(rms(mix, leadStart, startSample) > 0.02, 'the leading region carries real Take audio, not silence');
    assert.ok(rms(mix, startSample, startSample + 19200) > 0.02, 'the body carries real audio');

    // Sample-by-sample: the lead is the Take's own pre-roll and the body stays aligned.
    for (let j = 0; j < LEAD; j += 97) {
      const expected = takeRef[(takeInSample - LEAD + j) * 2];
      const actual = channel0(mix, leadStart + j) / 32768;
      assert.ok(
        Math.abs(actual - expected) < 2e-3,
        `lead sample ${j} must be the Take pre-roll (got ${actual}, expected ${expected})`,
      );
    }
    for (let j = 0; j < 19200; j += 601) {
      const expected = takeRef[(takeInSample + j) * 2];
      const actual = channel0(mix, startSample + j) / 32768;
      assert.ok(
        Math.abs(actual - expected) < 2e-3,
        `body sample ${j} must stay aligned to the Take (got ${actual}, expected ${expected})`,
      );
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("(m) a declared tail past the Take's own audio adds NO synthesized silence and does not error", async () => {
  const dir = await tempDir();
  try {
    const keptWav = await makeConstantWav(dir, 'kept.wav', KEPT_SECONDS); // body 0.5, 9600 frames
    const takeWav = await makeConstantWav(dir, 'take.wav', 0.05); // the Take only has 2400 frames of audio
    const project = makeProject([placement('place_a', 0, 25, START_FRAME, 'keep')]);
    const destination = nodePath.join(dir, 'overrun.wav');
    await mixAudio(
      dir,
      project,
      [
        {
          path: keptWav,
          startFrame: START_FRAME,
          tailSamples: 4800,
          takePath: takeWav,
          takeInSample: 0,
          takeBodySamples: KEPT_FRAMES,
        },
      ],
      TOTAL_FRAMES,
      destination,
    );
    const wav = readWav16(await fs.readFile(destination));
    assert.equal(channel0(wav, START_SAMPLE), 16384, 'the body is mixed');
    assert.equal(
      channel0(wav, START_SAMPLE + KEPT_FRAMES),
      0,
      'a tail past the Take audio contributes nothing (no synthesized silence)',
    );
    assert.equal(channel0(wav, START_SAMPLE + KEPT_FRAMES + 4799), 0, 'the whole overrun region is empty');
    assert.equal(
      lastNonZeroFrame(wav),
      START_SAMPLE + KEPT_FRAMES - 1,
      'nothing is fabricated after the available audio',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('(n) a negative audioLeadSamples is rejected by mixAudio', async () => {
  const dir = await tempDir();
  try {
    const keptWav = await makeConstantWav(dir, 'kept.wav', KEPT_SECONDS);
    const takeWav = await makeConstantWav(dir, 'take.wav', 0.5);
    const project = makeProject([placement('place_a', 0, 25, START_FRAME, 'keep')]);
    const dest = nodePath.join(dir, 'out.wav');
    await assert.rejects(
      () =>
        mixAudio(
          dir,
          project,
          [{ path: keptWav, startFrame: START_FRAME, leadSamples: -1, takePath: takeWav, takeInSample: 4800 }],
          TOTAL_FRAMES,
          dest,
        ),
      /invalid leadSamples/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
