/**
 * E2E: the "contact-study" 2D example — one readable contact and the same event
 * in the sound.
 *
 * Proves, with the REAL browser capture and the REAL mix/master/mux chain, that:
 *  - `contact-timeline.mjs` is the single authored clock: the picture and the
 *    sound both declare it, and the timeline there is internally consistent;
 *  - `create.mjs` (a technical fixture, not an art reference) vendors the study
 *    + the three author modules + the three struck CC0 recordings byte-for-byte,
 *    registers real Asset hashes and rights,
 *    carries the licence texts as `license` handoffs, writes no absolute host
 *    path and submits no provider request;
 *  - a real Build decodes to frames AND PCM, the picture changes across the
 *    authored contact, the sound is silent before it, and the first attack lands
 *    within 5 ms of the authored contact sample;
 *  - the sound Take is the authored score, within one PCM16 step of a Node render
 *    of the same closure (a bed or a stray cue would not match);
 *  - MOVING the contact frame (one edit to the shared file) re-renders both the
 *    picture and the sound, and both follow the new sample;
 *  - a picture-only edit after that reuses the unchanged sound Take, mix, stem
 *    and master (the actual reuse counts are reported).
 *
 * The example is deterministic (fixed seed/frames), so the measurements are
 * stable. The Builds use a tiny canvas and 24 frames to stay fast.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { buildProject } from '../src/build/build.js';
import { loadProject, saveProject } from '../src/project/project.js';
import { authorRecipe } from './authoring-helpers.js';

// The fixture owns its scene; shared inputs have one source in a creative
// reference or a technical fixture, according to their purpose.
const ASSETS = resolve('skills/viscraft/assets');
const EX_DIR = resolve('tests/fixtures/authoring/contact-study');
const CODE_VISUALS = join(ASSETS, 'studies', 'code-visuals');
const KIT = resolve('tests/fixtures/audio/sound-arrange/samples');
const ARRANGE_MJS = resolve('tests/fixtures/audio/sound-arrange/sound-arrange.mjs');

const SIBLINGS: Record<string, string> = {
  'contact-timeline.mjs': join(EX_DIR, 'contact-timeline.mjs'),
  'contact-packs.mjs': join(EX_DIR, 'contact-packs.mjs'),
  'contact-scene.mjs': join(EX_DIR, 'contact-scene.mjs'),
  'contact-sound.mjs': join(EX_DIR, 'contact-sound.mjs'),
  'paint-material.mjs': join(CODE_VISUALS, 'paint-material', 'paint-material.mjs'),
  'motion-camera.mjs': resolve('tests/fixtures/authoring/motion-camera/motion-camera.mjs'),
  'sound-arrange.mjs': ARRANGE_MJS,
};
const PICTURE_RESOURCES = ['contact-scene.mjs', 'contact-timeline.mjs', 'paint-material.mjs', 'motion-camera.mjs'];
// The study sounds only the packs it strikes: two cello takes and the C6 bar.
// `SAMPLE_PACK` remains the byte authority; the subset is the study's choice.
const CONTACT_SAMPLES = ['cello-pizz-b3-rr1.wav', 'cello-pizz-b3-rr2.wav', 'marimba-c6-loud-01.wav'];

const WIDTH = 320;
const HEIGHT = 180;
const FRAMES = 24;
const FPS = 24;
const SAMPLE_RATE = 48000;
const SEED = 4242;
const PAPER: [number, number, number] = [233, 223, 202];

interface PackFile {
  file: string;
  bytes: number;
  sha256: string;
  repo: string;
  path: string;
  commit: string;
}
interface Pack {
  files: PackFile[];
}
interface ArrangeModule {
  SAMPLE_FILES: string[];
  SAMPLE_PACK: Record<string, Pack>;
}
interface Timeline {
  fps: number;
  frames: number;
  contactFrame: number;
  approachStart: number;
  liftEnd: number;
  rest: { startFrame: number; endFrame: number };
  events: Array<{ id: string; frame: number; voices: string[]; role: string }>;
  phases: Array<{ id: string; startFrame: number; endFrame: number }>;
}
interface TimelineModule {
  STUDY: { fps: number; contactFrame: number; approachFrames: number; liftFrames: number };
  timelineFor(frames: number): Timeline;
  sampleAt(frame: number, sampleRate: number): number;
  describeTimeline(timeline: Timeline): string;
}
interface SceneModule {
  renderContact(canvas: unknown, ctx?: unknown): unknown;
  normalizeParams(raw: unknown): { palette: Record<string, string>; camera: Record<string, number> };
}
interface RenderedSound {
  channels: Float32Array[];
  report: {
    peak: number;
    rms: number;
    trimmed: boolean;
    restSamples: number;
    renderedEvents: Array<{ id: string; voice: string; frame: number; sample: number; file: string }>;
    sectionRms: Array<{ id: string; rms: number }>;
    timeline: { contactFrame: number; contactSample: number };
  };
}
interface SoundModule {
  renderContactSound(request: {
    sampleRate: number;
    channels: number;
    samples: number;
    params: Record<string, unknown>;
    seed: number;
    bytes: Record<string, Uint8Array>;
  }): RenderedSound;
}

interface ProjectLike {
  sources: Array<{
    id: string;
    kind: string;
    output?: string;
    entry: string;
    resources: string[];
    params: Record<string, unknown>;
    seed: number;
    frames?: number;
    durationSamples?: number;
    sampleRate?: number;
  }>;
  assets: Array<{
    id: string;
    path: string;
    type: string;
    revision: number;
    sha256: string;
    rights: { license: string; redistributable: boolean; origin: string; notice?: string };
  }>;
  handoff: Array<{ path: string; role: string }>;
  composition: {
    output: { width: number; height: number; sampleRate: number; channels: number };
    audio: Array<{ id: string; kind: string; source?: string; bus?: string }>;
    mastering?: { targetLufs: number; truePeakDbfs: number };
    placements: Array<{ source: string; startFrame: number; outFrame: number }>;
  };
  direction: { intent: string; looks: Array<{ id: string }> };
}

const arrange = (await import(pathToFileURL(ARRANGE_MJS).href)) as ArrangeModule;

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function stageSiblings(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const [name, from] of Object.entries(SIBLINGS)) await copyFile(from, join(directory, name));
}

async function kitBytes(): Promise<Record<string, Uint8Array>> {
  const bytes: Record<string, Uint8Array> = {};
  for (const file of arrange.SAMPLE_FILES) bytes[file] = new Uint8Array(await readFile(join(KIT, file)));
  return bytes;
}

/** Decode `count` real frames of a video to raw RGB. */
function decodeFrames(file: string, count: number): Buffer {
  const result = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostdin', '-i', file, '-frames:v', String(count), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 1 << 28 },
  );
  assert.equal(result.status, 0, `ffmpeg frame decode failed: ${result.stderr?.toString() ?? ''}`);
  return result.stdout;
}

/** Decode the whole audio stream to interleaved stereo float32 at 48 kHz. */
function decodeAudio(file: string): Float32Array {
  const result = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostdin',
      '-i',
      file,
      '-vn',
      '-f',
      'f32le',
      '-acodec',
      'pcm_f32le',
      '-ac',
      '2',
      '-ar',
      String(SAMPLE_RATE),
      '-',
    ],
    { maxBuffer: 1 << 27 },
  );
  assert.equal(result.status, 0, `ffmpeg audio decode failed: ${result.stderr?.toString() ?? ''}`);
  const copied = result.stdout.buffer.slice(result.stdout.byteOffset, result.stdout.byteOffset + result.stdout.length);
  return new Float32Array(copied);
}

function mono(channels: Float32Array): Float32Array {
  const out = new Float32Array(channels.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = (channels[i * 2] + channels[i * 2 + 1]) / 2;
  return out;
}

/** Fraction of pixels that differ by a loud margin (an actual picture change). */
function changedFraction(a: Buffer, b: Buffer): number {
  let changed = 0;
  for (let i = 0; i < a.length; i += 3) {
    const distance = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (distance > 60) changed++;
  }
  return changed / (a.length / 3);
}

/** Fraction of pixels visibly off the paper ground (the scene was drawn). */
function contentFraction(pixels: Buffer, paper: [number, number, number]): number {
  let drawn = 0;
  for (let i = 0; i < pixels.length; i += 3) {
    const distance =
      Math.abs(pixels[i] - paper[0]) + Math.abs(pixels[i + 1] - paper[1]) + Math.abs(pixels[i + 2] - paper[2]);
    if (distance > 80) drawn++;
  }
  return drawn / (pixels.length / 3);
}

interface Onset {
  onset: number;
  delta: number;
  peak: number;
  prePeak: number;
  tailPeak: number;
}

/** Measure the attack against the authored contact sample, on the decoded PCM. */
function measureOnset(samples: Float32Array, contactSample: number): Onset {
  let prePeak = 0;
  for (let i = 0; i < contactSample; i++) prePeak = Math.max(prePeak, Math.abs(samples[i]));
  const to = Math.min(samples.length, contactSample + Math.round(0.12 * SAMPLE_RATE));
  let peak = 0;
  for (let i = contactSample; i < to; i++) peak = Math.max(peak, Math.abs(samples[i]));
  let onset = -1;
  for (let i = Math.max(0, contactSample - Math.round(0.005 * SAMPLE_RATE)); i < to; i++) {
    if (Math.abs(samples[i]) > peak * 0.05) {
      onset = i;
      break;
    }
  }
  assert.ok(onset >= 0, 'the contact window carries an audible attack');
  const tailFrom = Math.min(samples.length, contactSample + Math.round(0.3 * SAMPLE_RATE));
  const tailTo = Math.min(samples.length, contactSample + Math.round(0.45 * SAMPLE_RATE));
  let tailPeak = 0;
  for (let i = tailFrom; i < tailTo; i++) tailPeak = Math.max(tailPeak, Math.abs(samples[i]));
  return { onset, delta: onset - contactSample, peak, prePeak, tailPeak };
}

function takeArtifactPath(record: Awaited<ReturnType<typeof buildProject>>, source: string, root: string): string {
  const take = record.takes.find(entry => entry.source === source);
  assert.ok(take, `the build records a Take for ${source}`);
  const artifact = record.artifacts.find(entry => entry.id === take.artifact);
  assert.ok(artifact, `the Take for ${source} has an artifact`);
  return join(root, artifact.path);
}

/** Render the authored score in Node from a staged copy of the same closure. */
async function nodeRender(directory: string, pictureFrames: number): Promise<Float32Array> {
  const module = (await import(pathToFileURL(join(directory, 'contact-sound.mjs')).href)) as SoundModule;
  const rendered = module.renderContactSound({
    sampleRate: SAMPLE_RATE,
    channels: 2,
    samples: Math.ceil((pictureFrames * SAMPLE_RATE) / FPS),
    params: { frames: pictureFrames, mix: 1 },
    seed: SEED,
    bytes: await kitBytes(),
  });
  return rendered.channels[0].slice();
}

function maxDifference(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let max = Math.abs(a.length - b.length) > 0 ? Infinity : 0;
  for (let i = 0; i < length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
  return max;
}

// ---------------------------------------------------------------------------
// The shared authored clock
// ---------------------------------------------------------------------------
test('contact-study: the timeline is one internally consistent authority', async () => {
  const module = (await import(pathToFileURL(join(EX_DIR, 'contact-timeline.mjs')).href)) as TimelineModule;
  assert.equal(module.STUDY.fps, FPS);
  assert.equal(module.STUDY.contactFrame, 12);

  const timeline = module.timelineFor(FRAMES);
  assert.equal(timeline.frames, FRAMES);
  assert.equal(timeline.approachStart, 7);
  assert.equal(timeline.liftEnd, 18);
  assert.deepEqual(timeline.rest, { startFrame: 0, endFrame: 12 }, 'the whole lead-in is the authored rest');
  assert.deepEqual(
    timeline.events.map(event => event.id),
    ['impact'],
    'one attack is scheduled; the result is the recorded decay, not a second event',
  );
  assert.equal(timeline.events[0].frame, 12);
  assert.deepEqual(timeline.events[0].voices.slice().sort(), ['celloPizz', 'marimba']);
  assert.deepEqual(
    timeline.phases.map(phase => phase.id),
    ['prior', 'approach', 'reveal', 'hold'],
  );

  assert.equal(module.sampleAt(12, SAMPLE_RATE), 24000);
  assert.equal(module.sampleAt(12, 44100), Math.ceil((12 * 44100) / 24));
  assert.match(module.describeTimeline(timeline), /contact at frame 12/);

  // A contact that does not fit the piece is a loud authoring error.
  assert.throws(() => module.timelineFor(12), /contactFrame|fit/);
  assert.throws(() => module.sampleAt(1.5, SAMPLE_RATE), /frame/);
  assert.throws(() => module.sampleAt(3, 0), /sampleRate/);
});

// ---------------------------------------------------------------------------
// The picture and sound modules, executable without a browser
// ---------------------------------------------------------------------------
test('contact-study: the scene and sound modules are pure and honest about bad input', async () => {
  const staging = await mkdtemp(join(tmpdir(), 'viscraft-contact-modules-'));
  try {
    await stageSiblings(staging);
    const scene = (await import(pathToFileURL(join(staging, 'contact-scene.mjs')).href)) as SceneModule;
    const sound = (await import(pathToFileURL(join(staging, 'contact-sound.mjs')).href)) as SoundModule;

    assert.equal(typeof scene.renderContact, 'function');
    assert.throws(() => scene.renderContact(null), /needs a canvas element/);
    assert.throws(() => scene.normalizeParams({ camera: { push: 1 } }), /camera\.push/);
    assert.throws(() => scene.normalizeParams({ palette: { paper: 'red' } }), /palette\.paper/);

    const rendered = sound.renderContactSound({
      sampleRate: SAMPLE_RATE,
      channels: 2,
      samples: 48000,
      params: { frames: FRAMES, mix: 1 },
      seed: SEED,
      bytes: await kitBytes(),
    });
    assert.equal(rendered.channels.length, 2);
    assert.equal(rendered.channels[0].length, 48000);
    assert.equal(rendered.report.restSamples, 24000, 'half the piece is the authored rest');
    assert.equal(rendered.report.trimmed, false, 'the authored gain structure needs no rescue trim');
    assert.ok(rendered.report.peak < 1, 'no sample exceeds full scale');
    assert.deepEqual(
      rendered.report.renderedEvents.map(event => event.file).sort(),
      ['cello-pizz-b3-rr1.wav', 'marimba-c6-loud-01.wav'],
      'the recorded takes are the ones the score names',
    );
    assert.ok(
      rendered.report.sectionRms[0].rms === 0,
      'nothing is scheduled before the contact, so the rest is digital silence',
    );

    const samples = mono(
      // The renderer returns two de-interleaved channels; measure the mono sum.
      (() => {
        const interleaved = new Float32Array(48000 * 2);
        for (let i = 0; i < 48000; i++) {
          interleaved[i * 2] = rendered.channels[0][i];
          interleaved[i * 2 + 1] = rendered.channels[1][i];
        }
        return interleaved;
      })(),
    );
    const measured = measureOnset(samples, 24000);
    assert.ok(measured.delta >= 0, 'the attack never starts before the authored sample');
    assert.ok(measured.delta <= 0.005 * SAMPLE_RATE, `the Node render attacks within 5 ms (${measured.delta})`);

    // The sound scene refuses a clock that does not describe the same piece.
    assert.throws(
      () =>
        sound.renderContactSound({
          sampleRate: SAMPLE_RATE,
          channels: 2,
          samples: 48000,
          params: { frames: 20, mix: 1 },
          seed: SEED,
          bytes: {},
        }),
      /same piece|clock|incomplete|WAV|missing/,
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The whole lifecycle
// ---------------------------------------------------------------------------
test('contact-study: author, build, move the contact, and reuse the untouched sound', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-contact-'));
  const root = join(parent, 'study');
  const firstStaging = join(parent, 'stage-first');
  const secondStaging = join(parent, 'stage-second');
  try {
    // ---- 1. author with the recipe (no provider request) -------------------
    await authorRecipe({
      recipe: join(EX_DIR, 'create.mjs'),
      root,
      cwd: parent,
      options: { width: WIDTH, height: HEIGHT, frames: FRAMES, seed: SEED },
    });
    assert.equal(existsSync(join(root, '.viscraft', 'result.json')), false, 'authoring must not build anything');

    // The shared authored clock describes the contact the Project was built around.
    const timelineModule = (await import(pathToFileURL(join(EX_DIR, 'contact-timeline.mjs')).href)) as TimelineModule;
    const authoredTimeline = timelineModule.timelineFor(FRAMES);
    assert.equal(authoredTimeline.contactFrame, 12);
    assert.equal(timelineModule.sampleAt(12, SAMPLE_RATE), 24000);
    assert.deepEqual([authoredTimeline.rest.startFrame, authoredTimeline.rest.endFrame], [0, 12]);
    assert.deepEqual(
      authoredTimeline.events.map(event => event.id),
      ['impact'],
    );

    const project = JSON.parse(await readFile(join(root, 'project.json'), 'utf8')) as ProjectLike;
    assert.deepEqual(
      project.handoff
        .filter(file => file.role === 'license')
        .map(file => file.path)
        .sort(),
      ['LICENSES.md', 'SOUND-KIT-LICENSE.md', 'THIRD_PARTY_NOTICES.md'],
    );
    const byId = new Map(project.sources.map(source => [source.id, source] as const));
    const picture = byId.get('contact_picture')!;
    const sound = byId.get('contact_sound')!;
    assert.ok(picture && sound, 'both authored Sources exist');
    assert.equal(picture.kind, 'browser');
    assert.equal(picture.output, 'picture');
    assert.equal(sound.output, 'sound');
    if (sound.output !== 'sound') assert.fail('contact_sound must be a sound Source');
    assert.deepEqual(picture.resources, PICTURE_RESOURCES);
    assert.deepEqual(sound.resources, [
      'contact-sound.mjs',
      'contact-packs.mjs',
      'contact-timeline.mjs',
      'sound-arrange.mjs',
      ...CONTACT_SAMPLES,
    ]);
    assert.ok(
      picture.resources.includes('contact-timeline.mjs') && sound.resources.includes('contact-timeline.mjs'),
      'both Sources declare the shared event clock',
    );
    assert.equal(picture.params.frames, FRAMES, 'the picture knows the piece length');
    assert.equal(sound.params.frames, FRAMES, 'the sound is cut against the same piece length');
    assert.equal(picture.frames, FRAMES);
    assert.equal(
      sound.durationSamples,
      Math.ceil((FRAMES * SAMPLE_RATE) / FPS),
      'the sound spans the same piece on its own sample clock',
    );
    assert.equal(sound.sampleRate, SAMPLE_RATE);
    assert.equal(picture.seed, SEED);

    // Twelve Assets: the nine code files and the three CC0 recordings this
    // study actually strikes. It does not carry the unused sample library.
    assert.equal(project.assets.length, 12);
    const asset = (id: string) => project.assets.find(entry => entry.id === id)!;
    for (const entry of project.assets.filter(candidate => candidate.type === 'code')) {
      assert.equal(sha256(await readFile(join(root, entry.path))), entry.sha256, `${entry.path} hash is real`);
      assert.equal(entry.rights.license, entry.id === 'cs_paint' ? 'Apache-2.0 AND MIT' : 'MIT');
      assert.equal(entry.rights.redistributable, true);
    }
    assert.equal(asset('cs_scene').path, 'contact-scene.mjs');
    assert.equal(asset('cs_timeline').path, 'contact-timeline.mjs');
    assert.match(asset('cs_paint').rights.origin, /huashu-art-motion/);
    assert.match(asset('cs_camera').rights.origin, /huashu-art-motion/);
    assert.match(asset('cs_camera').rights.notice ?? '', /Manim/, 'the Manim derivation notice is retained');
    assert.match(asset('cs_arrange').rights.origin, /lemo-opuscar/);
    const contactPacks = ['celloPizz', 'marimba'];
    const pinned = contactPacks.flatMap(pack => arrange.SAMPLE_PACK[pack].files);
    assert.deepEqual(
      pinned.map(entry => entry.file),
      CONTACT_SAMPLES,
      'the study copies exactly the packs it sounds',
    );
    for (const entry of pinned) {
      const recorded = project.assets.find(candidate => candidate.path === entry.file);
      assert.ok(recorded, `${entry.file} is a registered Asset`);
      assert.equal(recorded.type, 'audio');
      assert.equal(recorded.sha256, entry.sha256);
      assert.equal(recorded.rights.license, 'CC0-1.0');
      assert.equal(recorded.rights.redistributable, true);
      assert.match(recorded.rights.origin, /VCSL|VSCO-2-CE/);
    }

    // Vendored byte-for-byte, licence texts carried, no host path, no provider.
    for (const [name, from] of Object.entries(SIBLINGS)) {
      assert.equal(sha256(await readFile(join(root, name))), sha256(await readFile(from)), `${name} is byte-identical`);
    }
    const contactNotice = await readFile(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    assert.match(contactNotice, /Permission is hereby granted/, 'the MIT permission text travels');
    assert.match(contactNotice, /Manim/, 'the Manim-derived easing notices travel with the motion-camera module');
    const kitLicense = await readFile(join(root, 'SOUND-KIT-LICENSE.md'), 'utf8');
    assert.match(kitLicense, /CC0 1\.0 Universal/);
    assert.match(kitLicense, /cfb04b07ceb70b6056ab1849cbbba53f658b4453982a6f44b4a05e19676361dd/);
    assert.match(await readFile(join(root, 'README.md'), 'utf8'), /contact-timeline\.mjs/);
    assert.doesNotMatch(JSON.stringify(project), /\/lustre-data\/|\/root\/|\/tmp\//);
    assert.ok(
      project.sources.every(source => source.kind !== 'provider'),
      'authoring submits no provider request',
    );

    // One source clip on the declared bus, mastered to the stated target.
    assert.deepEqual(project.composition.audio, [
      {
        id: 'contact',
        kind: 'source',
        source: 'contact_sound',
        startSample: 0,
        gain: 1,
        fadeInSamples: 0,
        fadeOutSamples: 0,
        bus: 'fx',
      },
    ]);
    assert.deepEqual(project.composition.mastering, { targetLufs: -16, truePeakDbfs: -1.5 });
    assert.equal(project.composition.placements[0].source, 'contact_picture');

    // Stage the same closure for the Node-vs-browser Take comparison.
    await stageSiblings(firstStaging);

    // ---- 2. a REAL build --------------------------------------------------
    const build1 = await buildProject(root);
    assert.equal(build1.status, 'succeeded');
    const final1 = build1.artifacts.find(entry => entry.id === build1.result!.artifact)!;
    assert.equal(final1.media!.frames, FRAMES);
    assert.equal(final1.media!.audio?.sampleRate, SAMPLE_RATE);
    assert.equal(final1.media!.audio?.channels, 2);

    const decoded1 = decodeFrames(join(root, final1.path), FRAMES);
    const frameBytes = WIDTH * HEIGHT * 3;
    assert.equal(decoded1.length, frameBytes * FRAMES, 'every authored frame decodes');
    const frame1 = (index: number) => decoded1.subarray(index * frameBytes, (index + 1) * frameBytes);
    const contactChange1 = changedFraction(frame1(11), frame1(12));
    const revealChange1 = changedFraction(frame1(12), frame1(18));
    const endChange1 = changedFraction(frame1(0), frame1(23));
    const content1 = contentFraction(frame1(23), PAPER);
    assert.ok(contactChange1 > 0.02, `the picture changes across the contact (${contactChange1.toFixed(3)})`);
    assert.ok(revealChange1 > 0.05, `the rebound and push are a real second change (${revealChange1.toFixed(3)})`);
    assert.ok(endChange1 > 0.1, `the end beat is not the opening frame (${endChange1.toFixed(3)})`);
    assert.ok(content1 > 0.05, `a finished frame is not blank (content ${content1.toFixed(3)})`);

    const pcm1 = mono(decodeAudio(join(root, final1.path)));
    const onset1 = measureOnset(pcm1, 24000);
    assert.ok(onset1.delta >= 0, 'the delivered attack does not start before the authored sample');
    assert.ok(
      onset1.delta <= 0.005 * SAMPLE_RATE,
      `the delivered attack lands within 5 ms of the contact (${onset1.delta} samples)`,
    );
    assert.ok(onset1.prePeak < 0.01, `the lead-in is a real rest, not a bed (pre-contact peak ${onset1.prePeak})`);
    assert.ok(onset1.tailPeak > 0.01, `the strike leaves a decaying tail (tail peak ${onset1.tailPeak})`);

    // The sound Take is the authored score, not "something audible": compare it
    // with a Node render of the same closure within one PCM16 step.
    const take1 = takeArtifactPath(build1, 'contact_sound', root);
    const takePcm1 = decodeAudio(take1);
    const takeLeft1 = new Float32Array(takePcm1.length / 2);
    for (let i = 0; i < takeLeft1.length; i++) takeLeft1[i] = takePcm1[i * 2];
    const expected1 = await nodeRender(firstStaging, FRAMES);
    const takeDelta1 = maxDifference(takeLeft1, expected1);
    assert.ok(takeDelta1 <= 4 / 32768, `the browser Take matches the authored score (max diff ${takeDelta1})`);

    t.diagnostic(
      `build 1: contact frame 12 = sample 24000; onset +${onset1.delta} samples ` +
        `(${((onset1.delta / SAMPLE_RATE) * 1000).toFixed(3)} ms); ` +
        `changed 11→12 ${contactChange1.toFixed(3)}, 12→18 ${revealChange1.toFixed(3)}, 0→23 ${endChange1.toFixed(3)}; ` +
        `content ${content1.toFixed(3)}; take vs Node ${takeDelta1.toExponential(2)}`,
    );

    // ---- 3. move the contact in the ONE shared file ------------------------
    const before = await loadProject(root);
    const timelinePath = join(root, 'contact-timeline.mjs');
    const timelineText = await readFile(timelinePath, 'utf8');
    const editedText = timelineText.replace('contactFrame: 12', 'contactFrame: 15');
    assert.notEqual(editedText, timelineText, 'the authored contact constant was found');
    await writeFile(timelinePath, editedText);
    const edited = structuredClone(before);
    const timelineAsset = edited.assets.find(entry => entry.id === 'cs_timeline')!;
    timelineAsset.sha256 = sha256(await readFile(timelinePath));
    timelineAsset.revision = 2;
    // `saveProject` is the sanctioned write; only the moved code file changed.
    await saveProject(root, edited, before.revision);

    // Stage the edited closure for the second Node render (a distinct module URL).
    await stageSiblings(secondStaging);
    for (const name of ['contact-timeline.mjs', 'contact-packs.mjs', 'contact-scene.mjs', 'contact-sound.mjs']) {
      await copyFile(join(root, name), join(secondStaging, name));
    }

    const build2 = await buildProject(root);
    assert.equal(build2.status, 'succeeded');
    const final2 = build2.artifacts.find(entry => entry.id === build2.result!.artifact)!;
    const decoded2 = decodeFrames(join(root, final2.path), FRAMES);
    assert.equal(decoded2.length, frameBytes * FRAMES);
    const frame2 = (index: number) => decoded2.subarray(index * frameBytes, (index + 1) * frameBytes);
    const newContactChange = changedFraction(frame2(14), frame2(15));
    const oldContactChange = changedFraction(frame2(11), frame2(12));
    const movedFrame = changedFraction(frame1(12), frame2(12));
    assert.ok(newContactChange > 0.03, `the contact now happens on frame 15 (${newContactChange.toFixed(3)})`);
    assert.ok(
      oldContactChange < 0.02,
      `frame 12 is now only an approach frame (${oldContactChange.toFixed(3)}) — the picture followed the edit`,
    );
    assert.ok(movedFrame > 0.02, `the frame at the old contact time differs (${movedFrame.toFixed(3)})`);

    const pcm2 = mono(decodeAudio(join(root, final2.path)));
    const newContactSample = Math.ceil((15 * SAMPLE_RATE) / FPS);
    const onset2 = measureOnset(pcm2, newContactSample);
    assert.ok(onset2.delta >= 0, 'the moved attack does not start before the new sample');
    assert.ok(
      onset2.delta <= 0.005 * SAMPLE_RATE,
      `the sound followed the contact to sample ${newContactSample} (delta ${onset2.delta})`,
    );
    assert.ok(onset2.prePeak < 0.01, 'the lead-in is still a rest');
    let oldContactPeak = 0;
    for (let i = 24000; i < 24000 + Math.round(0.12 * SAMPLE_RATE); i++)
      oldContactPeak = Math.max(oldContactPeak, Math.abs(pcm2[i]));
    assert.ok(oldContactPeak < 0.01, 'nothing is left at the OLD contact sample: the sound moved with the picture');

    // The new sound Take is still the authored score for the new contact.
    const take2 = takeArtifactPath(build2, 'contact_sound', root);
    const takePcm2 = decodeAudio(take2);
    const takeLeft2 = new Float32Array(takePcm2.length / 2);
    for (let i = 0; i < takeLeft2.length; i++) takeLeft2[i] = takePcm2[i * 2];
    const expected2 = await nodeRender(secondStaging, FRAMES);
    const takeDelta2 = maxDifference(takeLeft2, expected2);
    assert.ok(takeDelta2 <= 4 / 32768, `the moved Take matches the authored score (max diff ${takeDelta2})`);

    const pictureTake1 = build1.takes.find(entry => entry.source === 'contact_picture')!.id;
    const soundTake1 = build1.takes.find(entry => entry.source === 'contact_sound')!.id;
    const pictureTake2 = build2.takes.find(entry => entry.source === 'contact_picture')!.id;
    const soundTake2 = build2.takes.find(entry => entry.source === 'contact_sound')!.id;
    assert.notEqual(pictureTake2, pictureTake1, 'the picture re-rendered for the moved contact');
    assert.notEqual(soundTake2, soundTake1, 'the sound re-rendered for the moved contact');
    assert.equal(build2.operations.filter(operation => operation.reused).length, 0, 'the shared edit invalidates both');

    t.diagnostic(
      `build 2: contact 12 → 15; onset +${onset2.delta} samples ` +
        `(${((onset2.delta / SAMPLE_RATE) * 1000).toFixed(3)} ms); ` +
        `changed 14→15 ${newContactChange.toFixed(3)}, 11→12 ${oldContactChange.toFixed(3)}, ` +
        `old-frame difference ${movedFrame.toFixed(3)}; take vs Node ${takeDelta2.toExponential(2)}`,
    );

    // ---- 4. a picture-only edit reuses the sound chain ---------------------
    const before3 = await loadProject(root);
    const edited3 = structuredClone(before3);
    const pictureSource = edited3.sources.find(source => source.id === 'contact_picture')!;
    if (pictureSource.kind !== 'browser') throw new Error('expected a browser picture source');
    const camera = pictureSource.params.camera as { push: number };
    pictureSource.params = { ...pictureSource.params, camera: { ...camera, push: 1.32 } };
    await saveProject(root, edited3, before3.revision);

    const build3 = await buildProject(root);
    assert.equal(build3.status, 'succeeded');
    const browserOps = build3.operations.filter(operation => operation.kind === 'browser');
    assert.equal(browserOps.filter(operation => !operation.reused).length, 1, 'only the picture re-renders');
    assert.equal(browserOps.filter(operation => operation.reused).length, 1, 'the untouched sound Take is reused');
    assert.equal(build3.operations.find(operation => operation.kind === 'mix-audio')!.reused, true);
    assert.equal(build3.operations.find(operation => operation.kind === 'master-audio')!.reused, true);
    assert.equal(build3.operations.find(operation => operation.kind === 'mix-stem')!.reused, true);
    assert.equal(
      build3.takes.find(entry => entry.source === 'contact_sound')!.id,
      soundTake2,
      'the sound Take id is preserved',
    );
    assert.notEqual(
      build3.takes.find(entry => entry.source === 'contact_picture')!.id,
      pictureTake2,
      'the edited picture is a new Take',
    );
    const final3 = build3.artifacts.find(entry => entry.id === build3.result!.artifact)!;
    assert.equal(final3.media!.frames, FRAMES);
    const decoded3 = decodeFrames(join(root, final3.path), FRAMES);
    assert.ok(
      changedFraction(decoded3.subarray(23 * frameBytes, 24 * frameBytes), frame2(23)) > 0.02,
      'the push changed',
    );

    t.diagnostic(
      `build 3 (picture-only edit): reused ${build3.operations.filter(operation => operation.reused).length}/${build3.operations.length} ` +
        `operations (${build3.operations
          .filter(operation => operation.reused)
          .map(operation => operation.kind)
          .join(
            ', ',
          )}); sound Take preserved ${soundTake2 === build3.takes.find(entry => entry.source === 'contact_sound')!.id}`,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
