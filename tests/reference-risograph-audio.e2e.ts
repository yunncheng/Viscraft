/**
 * E2E audio: the risograph reference's two local four-second cues.
 *
 * Proves, through the REAL author/Build/SDK path, that:
 *  - create.mjs publishes two picture Sources plus one music and one Foley
 *    `browser`/`output: 'sound'` Source per ride, with separate entries and
 *    resources, four `kind: 'source'` clips on the music/foley buses, and the
 *    existing mute picture placements;
 *  - each music/Foley Source renders exactly 192000 samples at 48 kHz stereo;
 *    the cue descriptor's entries are real (bass at 0, the brush stroke at 0.5,
 *    guitar at 0.75, vibes at 1.5) and the stem's guitar/vibes band energy rises
 *    at those times, not merely its RMS;
 *  - the Foley map follows the shared action facts: the riverside bell strikes
 *    at the first 12 Hz step that reaches the 2.3 s target (2.3333 s) and five
 *    real pigeon flaps follow; the bakery has the 2.1 s fabric, the 2.75 s
 *    stepped catch, the 2.85 s wing and the 3.1667 s stepped basket stow.
 *    Registration kicks are not Foley onsets;
 *  - the Build groups the two buses, keeps each stem's own span/signal, and the
 *    final MP4 carries 192 picture frames and the full 8 s programme;
 *  - the original authored Project and files are untouched.
 *
 * The pure descriptor/PCM truth (no author/Browser/Build) is proved separately
 * in reference-risograph-audio.test.ts. These are engineering samples, not a
 * listening verdict. A failure keeps its temporary directory for diagnosis.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { renderSoundScene } from '../src/backends/browser/sound.js';
import { buildProject } from '../src/build/build.js';
import { deliverProject } from '../src/operations/delivery/delivery.js';
import { verifyDelivery } from '../src/operations/delivery/delivery-verification.js';
import { loadProject } from '../src/project/project.js';
import type { Composition } from '../src/core/schema.js';
import { authorRecipe, sha256 } from './authoring-helpers.js';

const STUDY_DIR = resolve('skills/viscraft/assets/studies/code-visuals/risograph');
const RECIPE = join(STUDY_DIR, 'create.mjs');
const WIDTH = 320;
const HEIGHT = 180;
const FRAMES = 96;
const FPS = 24;
const SAMPLE_RATE = 48000;
const SAMPLES = (FRAMES / FPS) * SAMPLE_RATE;

interface DecodedWav {
  sampleRate: number;
  channels: number;
  frames: number;
  data: Float32Array[];
}

interface MusicScore {
  seconds: number;
  bpm: number;
  variant: string;
  events: Array<{ time: number; voice: string; midi?: number; gain: number }>;
  sections: Array<{ id: string; start: number; end: number }>;
}

interface FoleyScore {
  seconds: number;
  variant: string;
  events: Array<{ time: number; kind: string; gain: number }>;
  cues: Array<{ id: string; time: number }>;
  rests: unknown[];
}

function decodeWav(buffer: Buffer): DecodedWav {
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buffer.toString('ascii', 8, 12), 'WAVE');
  let offset = 12;
  let fmt: { sampleRate: number; channels: number; bits: number } | undefined;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ')
      fmt = {
        sampleRate: buffer.readUInt32LE(body + 4),
        channels: buffer.readUInt16LE(body + 2),
        bits: buffer.readUInt16LE(body + 14),
      };
    else if (id === 'data') {
      assert.equal(dataOffset, -1, 'the WAV has exactly one data chunk');
      assert.ok(body + size <= buffer.length, `the WAV data chunk (${size} bytes) fits inside ${buffer.length} bytes`);
      dataOffset = body;
      dataLength = size;
    }
    offset = body + size + (size % 2);
  }
  assert.ok(fmt && dataOffset >= 0, 'the WAV exposes fmt and data');
  assert.equal(fmt.bits, 16, 'the sound products are PCM16');
  assert.equal(dataLength % (fmt.channels * 2), 0, 'the data payload is a whole number of frames');
  assert.equal(dataOffset + dataLength, buffer.length, 'the WAV carries exactly its declared data payload');
  const frames = dataLength / (fmt.channels * 2);
  const data = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let channel = 0; channel < fmt.channels; channel++) {
      data[channel][i] = buffer.readInt16LE(dataOffset + (i * fmt.channels + channel) * 2) / 32768;
    }
  }
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, frames, data };
}

function window(wav: DecodedWav, start: number, end: number): [number, number] {
  return [Math.max(0, Math.floor(start * wav.sampleRate)), Math.min(wav.frames, Math.ceil(end * wav.sampleRate))];
}

function peakBetween(wav: DecodedWav, start: number, end: number): number {
  const [from, to] = window(wav, start, end);
  let peak = 0;
  for (const channel of wav.data) for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(channel[i]));
  return peak;
}

function rmsBetween(wav: DecodedWav, start: number, end: number): number {
  const [from, to] = window(wav, start, end);
  let sum = 0;
  let count = 0;
  for (const channel of wav.data) {
    for (let i = from; i < to; i++) {
      sum += channel[i] * channel[i];
      count++;
    }
  }
  return Math.sqrt(sum / Math.max(1, count));
}

/** Single-bin Goertzel magnitude at `frequency` in a window (mono average). */
function bandMagnitude(wav: DecodedWav, start: number, end: number, frequency: number): number {
  const [from, to] = window(wav, start, end);
  const step = (2 * Math.PI * frequency) / wav.sampleRate;
  let real = 0;
  let imag = 0;
  for (let i = from; i < to; i++) {
    const value = (wav.data[0][i] + wav.data[1][i]) / 2;
    real += value * Math.cos(step * i);
    imag += value * Math.sin(step * i);
  }
  return Math.hypot(real, imag) / Math.max(1, to - from);
}

function samplesEqual(a: DecodedWav, b: DecodedWav): boolean {
  if (a.frames !== b.frames || a.channels !== b.channels) return false;
  for (let channel = 0; channel < a.channels; channel++) {
    for (let i = 0; i < a.frames; i++) if (a.data[channel][i] !== b.data[channel][i]) return false;
  }
  return true;
}

async function loadModule<T>(path: string): Promise<T> {
  return (await import(`${pathToFileURL(path).href}?t=${Date.now()}`)) as T;
}

type ProjectSource = Awaited<ReturnType<typeof loadProject>>['sources'][number];
type BrowserPicture = Extract<ProjectSource, { kind: 'browser'; output: 'picture' }>;
type BrowserSound = Extract<ProjectSource, { kind: 'browser'; output: 'sound' }>;

const isPicture = (source: ProjectSource): source is BrowserPicture =>
  source.kind === 'browser' && source.output === 'picture';
const isSound = (source: ProjectSource): source is BrowserSound =>
  source.kind === 'browser' && source.output === 'sound';

function sourceClips(composition: Composition): Array<Extract<Composition['audio'][number], { kind: 'source' }>> {
  const clips = composition.audio.filter(
    (clip): clip is Extract<Composition['audio'][number], { kind: 'source' }> => clip.kind === 'source',
  );
  assert.equal(clips.length, composition.audio.length, 'every authored audio member is a sound Source clip');
  return clips;
}

function ffprobe(
  file: string,
): Array<{ codec_type?: string; sample_rate?: string; channels?: number; duration?: string }> {
  const result = spawnSync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type,sample_rate,channels,duration',
    '-of',
    'json',
    file,
  ]);
  assert.equal(result.status, 0, `ffprobe failed for ${file}: ${result.stderr?.toString() ?? ''}`);
  return (
    (JSON.parse(result.stdout.toString()) as { streams?: Array<Record<string, unknown>> }).streams?.map(stream => ({
      codec_type: stream.codec_type as string | undefined,
      sample_rate: stream.sample_rate as string | undefined,
      channels: stream.channels as number | undefined,
      duration: stream.duration as string | undefined,
    })) ?? []
  );
}

test('risograph: the authored music and Foley sources carry the real action events', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-riso-audio-'));
  let succeeded = false;
  try {
    const root = join(parent, 'riso');
    await authorRecipe({
      recipe: RECIPE,
      root,
      cwd: parent,
      options: { width: WIDTH, height: HEIGHT, frames: FRAMES },
    });
    const project = await loadProject(root);
    const composition = project.composition;
    assert.ok(composition, 'the authored project has a composition');
    const pictures = project.sources.filter(isPicture);
    const sounds = project.sources.filter(isSound);
    assert.deepEqual(
      project.sources.map(source => source.id),
      ['river-ride', 'bakery-catch', 'river-music', 'bakery-music', 'river-foley', 'bakery-foley'],
      'six Sources: two pictures plus music/Foley per ride',
    );
    assert.equal(pictures.length, 2);
    assert.equal(sounds.length, 4);
    for (const picture of pictures) {
      assert.deepEqual(picture.resources, ['scene.mjs', 'draw.mjs', 'rider.mjs', 'riso.mjs', 'action-facts.mjs']);
      assert.deepEqual(picture.params, {
        variant: picture.id === 'river-ride' ? 'riverside' : 'bakery',
        frames: FRAMES,
      });
      assert.equal(picture.frames, FRAMES);
    }
    const music = sounds.filter(source => source.id.endsWith('-music'));
    const foley = sounds.filter(source => source.id.endsWith('-foley'));
    assert.deepEqual(
      music.map(source => source.id),
      ['river-music', 'bakery-music'],
    );
    assert.deepEqual(
      foley.map(source => source.id),
      ['river-foley', 'bakery-foley'],
    );
    for (const source of music) {
      assert.equal(source.entry, 'risograph-music.html');
      assert.deepEqual(source.resources, ['action-facts.mjs', 'score.mjs', 'synth.mjs']);
      assert.deepEqual(source.params, {
        role: 'music',
        variant: source.id.startsWith('river') ? 'riverside' : 'bakery',
        duration: 4,
      });
      assert.equal(source.durationSamples, SAMPLES);
      assert.equal(source.sampleRate, SAMPLE_RATE);
    }
    for (const source of foley) {
      assert.equal(source.entry, 'risograph-foley.html');
      assert.deepEqual(source.resources, ['action-facts.mjs', 'foley.mjs', 'synth.mjs']);
      assert.deepEqual(source.params, {
        role: 'foley',
        variant: source.id.startsWith('river') ? 'riverside' : 'bakery',
        duration: 4,
      });
      assert.equal(source.durationSamples, SAMPLES);
      assert.equal(source.sampleRate, SAMPLE_RATE);
    }
    const clips = sourceClips(composition);
    assert.deepEqual(
      clips.map(clip => [clip.id, clip.kind, clip.source, clip.bus, clip.startSample, clip.gain]),
      [
        ['clip-river-music', 'source', 'river-music', 'music', 0, 0.9],
        ['clip-river-foley', 'source', 'river-foley', 'foley', 0, 0.55],
        ['clip-bakery-music', 'source', 'bakery-music', 'music', 192000, 0.9],
        ['clip-bakery-foley', 'source', 'bakery-foley', 'foley', 192000, 0.55],
      ],
      'four clips route the four cues to the two buses at the two ride starts',
    );
    assert.deepEqual(composition.mastering, { targetLufs: -16, truePeakDbfs: -1.5 });
    assert.equal(project.assets.length, 11, 'five picture modules, facts/score/Foley/synth and three entries');
    assert.deepEqual(
      (project.handoff ?? []).map(file => [file.path, file.role]),
      [
        ['THIRD_PARTY_NOTICES.md', 'license'],
        ['LICENSES.md', 'license'],
        ['README.md', 'readme'],
      ],
    );
    assert.match(await readFile(join(root, 'LICENSES.md'), 'utf8'), /MIT License[\s\S]*LemoLab/);
    assert.doesNotMatch(JSON.stringify(project), /\/lustre-data\/|\/root\/|\/tmp\//);

    // Every sound Source renders the exact authored span from its own entry.
    for (const source of sounds) {
      const destination = join(parent, `${source.id}.wav`);
      const result = await renderSoundScene(root, source, composition.output, destination);
      assert.equal(result.samples, SAMPLES);
      assert.equal(result.channels, 2);
      assert.equal(result.sampleRate, SAMPLE_RATE);
      const wav = decodeWav(await readFile(destination));
      assert.equal(wav.frames, SAMPLES, 'the WAV has the exact four-second span');
      assert.equal(wav.channels, 2);
      assert.equal(wav.sampleRate, SAMPLE_RATE);
      const peak = peakBetween(wav, 0, 4);
      assert.ok(peak > 0.1 && peak <= 1, `${source.id} is audible and below full scale (${peak})`);
    }

    // Repeatability: the same Source bytes decode to the same PCM.
    const repeat = join(parent, 'river-music-repeat.wav');
    await renderSoundScene(root, music[0], composition.output, repeat);
    assert.ok(
      samplesEqual(decodeWav(await readFile(join(parent, 'river-music.wav'))), decodeWav(await readFile(repeat))),
    );

    const scoreModule = await loadModule<{ buildMusic: (params: Record<string, unknown>) => MusicScore }>(
      join(root, 'score.mjs'),
    );
    const foleyModule = await loadModule<{ buildFoley: (params: Record<string, unknown>) => FoleyScore }>(
      join(root, 'foley.mjs'),
    );

    for (const variant of ['riverside', 'bakery']) {
      const score = scoreModule.buildMusic({ variant, duration: 4 });
      assert.equal(score.seconds, 4);
      assert.deepEqual(
        score.sections.map(section => section.id),
        ['blue', 'yellow', 'pink', 'action-space', 'answer', 'close'],
      );
      const voicesAt = (time: number) =>
        [
          ...new Set(
            score.events.filter(event => event.time >= time && event.time < time + 0.002).map(event => event.voice),
          ),
        ].sort();
      assert.deepEqual(voicesAt(0), ['bass'], 'the blue opening starts with the bass pulse');
      assert.ok(voicesAt(0.75).includes('guitar'), 'the guitar enters with the yellow plate');
      assert.ok(voicesAt(1.5).includes('vibes'), 'the vibes enter with the pink plate');
      assert.ok(
        score.events.some(event => event.voice === 'brush' && event.time === 0.5),
        'the brush is a real stroke, not a bed',
      );

      const foleyScore = foleyModule.buildFoley({ variant, duration: 4 });
      assert.equal(foleyScore.seconds, 4);
      if (variant === 'riverside') {
        assert.deepEqual(
          foleyScore.events.map(event => [event.kind, Number(event.time.toFixed(4))]),
          [
            ['bell', 2.3333],
            ['wing', 2.35],
            ['wing', 2.4],
            ['wing', 2.45],
            ['wing', 2.5],
            ['wing', 2.55],
          ],
        );
      } else {
        assert.deepEqual(
          foleyScore.events.map(event => [event.kind, Number(event.time.toFixed(4))]),
          [
            ['fabric', 2.1],
            ['catch', 2.75],
            ['wing', 2.85],
            ['stow', 3.1667],
          ],
        );
        assert.ok(!foleyScore.events.some(event => event.kind === 'bell'), 'the bakery ride has no bell cue');
      }
      assert.ok(
        !foleyScore.cues.some(cue => [0.75, 1.5, 3.3].includes(Number(cue.time.toFixed(4)))),
        'the plate gates at 0.75/1.5 s and the late registration kick are not Foley cues',
      );
    }

    // The music stem follows the descriptors in the signal: the guitar and vibes
    // fundamentals rise at their real entries; the bass is present from the top.
    for (const source of music) {
      const name = source.id.startsWith('river') ? 'riverside' : 'bakery';
      const wav = decodeWav(await readFile(join(parent, `${source.id}.wav`)));
      const guitarBefore = bandMagnitude(wav, 0.6, 0.74, 185);
      const guitarAfter = bandMagnitude(wav, 0.76, 0.9, 185);
      assert.ok(
        guitarAfter > guitarBefore * 5,
        `${name}: the guitar fundamental enters at 0.75 (${guitarBefore} → ${guitarAfter})`,
      );
      const vibeBefore = bandMagnitude(wav, 1.35, 1.49, 440);
      const vibeAfter = bandMagnitude(wav, 1.51, 1.65, 440);
      assert.ok(
        vibeAfter > vibeBefore * 5,
        `${name}: the vibes fundamental enters at 1.5 (${vibeBefore} → ${vibeAfter})`,
      );
      assert.ok(bandMagnitude(wav, 0.05, 0.25, 73.4) > 0.0005, `${name}: the bass is present at the blue opening`);
      assert.ok(rmsBetween(wav, 0, 0.7) > 0.01, `${name}: the opening is a real cue, not silence`);
      assert.ok(rmsBetween(wav, 2.7, 3.5) > 0.01, `${name}: the answer after the action remains music`);
      assert.ok(
        rmsBetween(wav, 2.35, 2.55) < rmsBetween(wav, 2.0, 2.3) * 0.6,
        `${name}: the action window is quieter than the preceding passage (observation only; ` +
          'the causal duck ablation is the independent-copy unit test)',
      );
    }

    // The Foley stems are silent before the action and carry the real attacks.
    const riverFoley = decodeWav(await readFile(join(parent, 'river-foley.wav')));
    assert.ok(peakBetween(riverFoley, 0, 2.1) < 0.001, 'riverside Foley is silent before the bell');
    assert.ok(peakBetween(riverFoley, 2.32, 2.36) > 0.1, 'the bell attack is at the 2.3333 s stepped strike');
    assert.ok(peakBetween(riverFoley, 2.35, 2.6) > 0.05, 'the five pigeon flaps follow the bell');

    const bakeryFoley = decodeWav(await readFile(join(parent, 'bakery-foley.wav')));
    assert.ok(peakBetween(bakeryFoley, 0, 2) < 0.001, 'bakery Foley is silent before the reach');
    assert.ok(peakBetween(bakeryFoley, 2.08, 2.12) > 0.01, 'the sleeve/fabric attack is at the 2.1 s reach');
    assert.ok(peakBetween(bakeryFoley, 2.73, 2.77) > 0.1, 'the bread/hand contact is at the 2.75 s stepped catch');
    assert.ok(peakBetween(bakeryFoley, 3.15, 3.18) > 0.01, 'the basket stow is at the 3.1667 s stepped frame');
    assert.ok(
      peakBetween(bakeryFoley, 0.7, 0.8) < 0.001 && peakBetween(bakeryFoley, 1.45, 1.55) < 0.001,
      'the yellow/pink plate gates are not Foley',
    );
    succeeded = true;
  } finally {
    if (succeeded) await rm(parent, { recursive: true, force: true });
    else console.error(`kept the risograph audio fixture for inspection: ${parent}`);
  }
});

test('risograph: the build groups music and Foley buses and the movie spans both rides', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-riso-mix-'));
  let succeeded = false;
  try {
    const root = join(parent, 'riso');
    await authorRecipe({
      recipe: RECIPE,
      root,
      cwd: parent,
      options: { width: WIDTH, height: HEIGHT, frames: FRAMES },
    });
    const project = await loadProject(root);
    const originalProject = await readFile(join(root, 'project.json'), 'utf8');
    const built = await buildProject(root);
    assert.equal(built.status, 'succeeded', `the real mixed build must succeed: ${built.error ?? ''}`);
    assert.equal(
      built.operations.filter(operation => operation.kind === 'browser').length,
      6,
      'two picture and four sound renders',
    );
    assert.equal(
      built.operations.filter(operation => operation.kind === 'mix-stem').length,
      2,
      'one grouped stem per bus',
    );
    assert.equal(built.operations.filter(operation => operation.kind === 'mix-audio').length, 1, 'the programme mix');
    assert.equal(built.operations.filter(operation => operation.kind === 'mux-final').length, 1, 'the final movie');
    const stems = built.operations
      .filter(operation => operation.kind === 'mix-stem')
      .map(operation => built.artifacts.find(artifact => artifact.id === operation.artifact)!);
    assert.deepEqual(stems.map(stem => stem.bus).sort(), ['foley', 'music'], 'the two authored buses are grouped');
    for (const stem of stems) {
      const wav = decodeWav(await readFile(join(root, stem.path)));
      assert.equal(wav.frames, 384000, `${stem.bus} stem is the full 8 s programme span`);
      assert.equal(wav.channels, 2);
      assert.equal(wav.sampleRate, SAMPLE_RATE);
      assert.ok(peakBetween(wav, 0, 8) > 0.1, `${stem.bus} stem is audible`);
      if (stem.bus === 'music') {
        assert.ok(rmsBetween(wav, 0, 4) > 0.01, 'the riverside cue is inside the music bus');
        assert.ok(rmsBetween(wav, 4, 8) > 0.01, 'the bakery cue is inside the same music bus');
      } else {
        assert.ok(peakBetween(wav, 0, 2) < 0.001, 'the foley bus is silent before the riverside bell');
        assert.ok(peakBetween(wav, 2.32, 2.6) > 0.1, 'the riverside bell is inside the foley bus');
        assert.ok(peakBetween(wav, 6.68, 7.2) > 0.1, 'the bakery catch is inside the same foley bus');
        assert.ok(peakBetween(wav, 0.7, 0.8) < 0.001, 'the yellow plate gate is not a foley event');
      }
    }
    const musicStem = stems.find(stem => stem.bus === 'music')!;
    const foleyStem = stems.find(stem => stem.bus === 'foley')!;
    assert.notEqual(
      sha256(await readFile(join(root, musicStem.path))),
      sha256(await readFile(join(root, foleyStem.path))),
      'the two grouped stems are distinct signals',
    );

    const final = built.artifacts.find(artifact => artifact.id === built.result!.artifact)!;
    assert.equal(final.media?.frames, FRAMES * 2, 'the programme holds both 96-frame rides');
    const streams = ffprobe(join(root, final.path));
    const audio = streams.find(stream => stream.codec_type === 'audio');
    assert.ok(audio, 'the final MP4 carries an audio stream');
    assert.equal(Number(audio!.sample_rate), SAMPLE_RATE);
    assert.equal(audio!.channels, 2);
    assert.ok(Math.abs(Number(audio!.duration) - 8) < 0.05, 'the muxed programme audio is eight seconds');

    const delivery = await deliverProject(root, join(parent, 'delivered'));
    assert.equal((await verifyDelivery(delivery.path)).ok, true);
    assert.match(
      await readFile(join(delivery.path, 'project', '.viscraft', 'pages', 'ATTRIBUTION.md'), 'utf8'),
      /MIT \(c\) 2026 LemoLab/,
    );
    assert.equal(
      sha256(await readFile(join(delivery.path, 'movie', 'final.mp4'))),
      sha256(await readFile(join(root, final.path))),
    );

    // The raw authored files are not rewritten by the Build; the asset hashes
    // are the authority, not a possibly-newer study copy.
    assert.equal(await readFile(join(root, 'project.json'), 'utf8'), originalProject);
    for (const id of ['riso_facts', 'riso_score', 'riso_foley']) {
      const asset = project.assets.find(candidate => candidate.id === id)!;
      assert.equal(asset.sha256, sha256(await readFile(join(root, asset.path))), `${id} is unchanged`);
    }
    succeeded = true;
  } finally {
    if (succeeded) await rm(parent, { recursive: true, force: true });
    else console.error(`kept the risograph mix fixture for inspection: ${parent}`);
  }
});
