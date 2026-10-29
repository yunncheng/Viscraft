/**
 * The public-SDK standalone audio product: `renderSoundScene`, imported from the
 * package root (`src/index.ts`), renders a code-authored sound scene to a real
 * PCM16LE WAV with no picture, no Take registry and no Build.
 *
 * What is proved from measured bytes, not symbol existence:
 *  - the WAV is genuine RIFF/WAVE linear PCM with the exact channel count and
 *    sample rate requested;
 *  - the written sample span is the Source's exact native sample count, without
 *    requiring a picture clock or raster in the standalone renderer;
 *  - a non-finite sample and an over-full-scale sample are both REJECTED loudly
 *    and the destination is never written (no silent clamp, no limiter);
 *  - the same Source re-run through a Build reuses its recorded audio Take
 *    (operation `reused`, identical Take/Artifact identity) instead of
 *    re-rendering.
 *
 * Gated like the other real-browser suites: it skips cleanly when no
 * Chrome/Chromium is installed (the reuse half also needs FFmpeg).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The audio product MUST come from the public entry, not an internal module path.
import { renderSoundScene } from '../src/index.js';
import { buildProject } from '../src/build/build.js';
import { hashFile } from '../src/shared/hash.js';
import { findBrowser } from '../src/backends/browser/capture.js';
import { runCommand } from '../src/shared/process.js';
import { ProjectSchema, type BuildRecord, type Fps, type Project } from '../src/core/schema.js';

const FPS: Fps = { numerator: 24, denominator: 1 };
const RATE = 44100;
const CHANNELS = 2;
const FRAMES = 5;
// An explicit native sample count; it also covers the five-frame film below.
const SAMPLES = 9188;

const SOUND_OUTPUT = { channels: CHANNELS };
const FILM_OUTPUT = { width: 64, height: 48, fps: FPS, sampleRate: RATE, channels: CHANNELS };

/**
 * A deterministic, dependency-free sound scene. `params.mode` selects normal,
 * non-finite (`nan`) and over-full-scale (`over`) output so the renderer's
 * rejection paths can be exercised from the same entry.
 */
const SOUND_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
window.viscraftSound = {
  ready: function () { return Promise.resolve(); },
  dispose: function () {},
  render: function (ctx) {
    var rate = ctx.sampleRate, channels = ctx.channels, samples = ctx.samples;
    var params = ctx.params || {};
    var mode = params.mode || 'ok';
    var freq = Number(params.frequency != null ? params.frequency : 220);
    var peak = Number(params.peak != null ? params.peak : 0.5);
    var out = new Float32Array(samples * channels);
    for (var i = 0; i < samples; i++) {
      var t = i / rate;
      var attack = Math.min(1, i / (rate * 0.01));
      var release = Math.min(1, (samples - i) / (rate * 0.02));
      var v = Math.sin(2 * Math.PI * freq * t) * peak * attack * release;
      for (var c = 0; c < channels; c++) out[i * channels + c] = v;
    }
    if (mode === 'over') { for (var k = 0; k < out.length; k++) out[k] = out[k] * 3; }
    if (mode === 'nan') { out[Math.floor(out.length / 2)] = NaN; }
    return out;
  }
};
</script></body></html>
`;

type SoundSource = Extract<Project['sources'][number], { kind: 'browser'; output: 'sound' }>;

function soundSource(params: Record<string, unknown> = {}): SoundSource {
  return {
    id: 'score',
    kind: 'browser',
    output: 'sound',
    entry: 'sound.html',
    resources: [],
    bindings: [],
    params,
    seed: 7,
    durationSamples: SAMPLES,
    sampleRate: RATE,
  };
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'viscraft-sound-sdk-'));
}

interface Wav16 {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  samples: Int16Array;
}

/** Parse a canonical 44-byte-header PCM16LE WAV and assert its declared payload. */
function readWav16(bytes: Buffer): Wav16 {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.readUInt32LE(4), bytes.length - 8, 'RIFF size must cover the whole file');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  assert.equal(bytes.toString('ascii', 12, 16), 'fmt ');
  assert.equal(bytes.readUInt32LE(16), 16, 'fmt chunk must be 16 bytes');
  assert.equal(bytes.readUInt16LE(20), 1, 'the WAV must be linear PCM');
  const channels = bytes.readUInt16LE(22);
  const sampleRate = bytes.readUInt32LE(24);
  const byteRate = bytes.readUInt32LE(28);
  const blockAlign = bytes.readUInt16LE(32);
  const bitsPerSample = bytes.readUInt16LE(34);
  assert.equal(bytes.toString('ascii', 36, 40), 'data');
  const dataBytes = bytes.readUInt32LE(40);
  assert.equal(bytes.length, 44 + dataBytes, 'the WAV must carry exactly its declared PCM payload');
  assert.equal(byteRate, sampleRate * channels * 2, 'byte rate must match rate * channels * 2');
  assert.equal(blockAlign, channels * 2, 'block align must match channels * 2');
  const count = Math.floor(dataBytes / 2);
  const samples = new Int16Array(count);
  for (let i = 0; i < count; i++) samples[i] = bytes.readInt16LE(44 + i * 2);
  return { sampleRate, channels, bitsPerSample, samples };
}

const browserAvailable = await findBrowser().then(
  () => true,
  () => false,
);
const ffmpegAvailable = await runCommand('ffmpeg', ['-version']).then(
  () => true,
  () => false,
);
const sdkSkip = browserAvailable ? false : 'needs a Chrome/Chromium browser';
const buildSkip =
  browserAvailable && ffmpegAvailable
    ? false
    : `needs a Chrome/Chromium browser and FFmpeg (browser=${browserAvailable}, ffmpeg=${ffmpegAvailable})`;

// ---------------------------------------------------------------------------
// 1. The standalone audio product: real WAV, exact clock, recorded hash
// ---------------------------------------------------------------------------

test(
  'renderSoundScene (public SDK) writes the declared native sample span without picture output settings',
  { skip: sdkSkip },
  async () => {
    const root = await tempDir();
    try {
      await writeFile(join(root, 'sound.html'), SOUND_HTML);
      const destination = join(root, 'score.wav');

      const result = await renderSoundScene(
        root,
        soundSource({ frequency: 220, peak: 0.5 }),
        SOUND_OUTPUT,
        destination,
      );

      assert.ok(result.browserVersion.length > 0, 'the renderer must report the real browser version');
      assert.equal(result.samples, SAMPLES, 'the reported span must match the Source durationSamples');
      assert.equal(result.channels, CHANNELS);
      assert.equal(result.sampleRate, RATE);

      const bytes = await readFile(destination);
      const wav = readWav16(bytes);
      assert.equal(wav.channels, CHANNELS, 'the WAV must be the requested channel count');
      assert.equal(wav.sampleRate, RATE, 'the WAV must be the requested sample rate');
      assert.equal(wav.bitsPerSample, 16, 'the WAV must be 16-bit PCM');
      assert.equal(wav.samples.length, SAMPLES * CHANNELS, 'the PCM payload must span channels * durationSamples');

      // Measure real PCM energy and preserve the authored half-scale amplitude.
      let peak = 0;
      for (let i = 0; i < wav.samples.length; i++) peak = Math.max(peak, Math.abs(wav.samples[i]));
      assert.ok(peak > 1000, `the rendered audio must carry real energy (peak ${peak}/32767)`);
      assert.ok(peak <= 16384, 'the half-scale author signal must not be normalized to full scale');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// 2. Loud rejection: non-finite and over-full-scale output, nothing written
// ---------------------------------------------------------------------------

test(
  'renderSoundScene rejects non-finite and over-full-scale output loudly and writes nothing',
  { skip: sdkSkip },
  async () => {
    const root = await tempDir();
    try {
      await writeFile(join(root, 'sound.html'), SOUND_HTML);

      const nanDestination = join(root, 'nan.wav');
      await assert.rejects(
        renderSoundScene(root, soundSource({ mode: 'nan' }), SOUND_OUTPUT, nanDestination),
        /non-finite sample|finite samples/,
        'a non-finite sample must be a loud error',
      );
      await assert.rejects(readFile(nanDestination), /ENOENT/, 'a rejected render must not write a destination');

      const overDestination = join(root, 'over.wav');
      await assert.rejects(
        renderSoundScene(root, soundSource({ mode: 'over' }), SOUND_OUTPUT, overDestination),
        /exceeds full scale|no limiter/,
        'an over-full-scale sample must be a loud error, never silently clamped',
      );
      await assert.rejects(readFile(overDestination), /ENOENT/, 'a rejected render must not write a destination');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// 3. Reuse: re-running the same Source reuses its Take without re-rendering
// ---------------------------------------------------------------------------

/** A buildable work: a simulated picture bed under the code-authored score. */
function soundWork(): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'sound_render_sdk',
    revision: 1,
    title: 'Standalone sound SDK',
    direction: {
      intent: 'a code-authored score over a simulated picture bed',
      looks: [{ id: 'look', description: 'identity' }],
      transitions: [],
    },
    assets: [],
    bindings: {},
    sources: [
      {
        id: 'bed',
        kind: 'simulated',
        prompt: 'picture bed',
        frames: FRAMES,
        seed: 0,
        attempt: 'bed',
        behavior: 'success',
      },
      {
        id: 'score',
        kind: 'browser',
        output: 'sound',
        entry: 'sound.html',
        resources: [],
        params: { frequency: 220, peak: 0.5 },
        seed: 7,
        durationSamples: SAMPLES,
        sampleRate: RATE,
      },
    ],
    composition: {
      output: FILM_OUTPUT,
      scenes: [{ id: 'scene', description: 'sound product' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: 'score', targetFrames: FRAMES }],
      placements: [
        { id: 'edit', shot: 'shot', source: 'bed', inFrame: 0, outFrame: FRAMES, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio: [
        { id: 'clip', kind: 'source', source: 'score', startSample: 0, gain: 1, fadeInSamples: 0, fadeOutSamples: 0 },
      ],
    },
  });
}

/** The audio Take artifacts a build produced from a `browser` sound Source. */
function soundTakeArtifacts(build: BuildRecord) {
  return build.artifacts.filter(artifact => artifact.operation === 'browser' && artifact.kind === 'audio');
}

test(
  're-running an unchanged sound Source reuses its recorded Take instead of re-rendering',
  { skip: buildSkip },
  async () => {
    const root = await tempDir();
    try {
      await writeFile(join(root, 'project.json'), `${JSON.stringify(soundWork(), null, 2)}\n`);
      await writeFile(join(root, 'sound.html'), SOUND_HTML);

      const first = await buildProject(root);
      assert.equal(first.status, 'succeeded', JSON.stringify(first.error));
      const audioArtifacts = soundTakeArtifacts(first);
      assert.equal(audioArtifacts.length, 1, 'exactly one audio Take must be produced for the one sound Source');
      const soundOp = first.operations.find(operation => operation.artifact === audioArtifacts[0].id)!;
      assert.ok(soundOp, 'the audio Take must have a recorded operation');
      assert.equal(soundOp.reused, false, 'a fresh root must really render the sound Take');
      const take = first.takes.find(candidate => candidate.artifact === audioArtifacts[0].id)!;
      assert.ok(take, 'the audio Take must be recorded');
      assert.equal(take.source, 'score');

      // The sound Source's own rendered Take is a real, exactly-spanned WAV on disk.
      const wav = readWav16(await readFile(join(root, audioArtifacts[0].path)));
      assert.equal(wav.channels, CHANNELS);
      assert.equal(wav.sampleRate, RATE);
      assert.equal(wav.samples.length, SAMPLES * CHANNELS, 'the Build Take must span the canonical ceil clock');
      const artifactSha = audioArtifacts[0].sha256;
      assert.equal(
        await hashFile(join(root, audioArtifacts[0].path)),
        artifactSha,
        'the recorded sha256 must match the bytes',
      );

      // Re-running the SAME Source must reuse the Take, not re-render it.
      const second = await buildProject(root);
      assert.equal(second.status, 'succeeded');
      const soundOp2 = second.operations.find(operation => operation.artifact === audioArtifacts[0].id)!;
      assert.equal(soundOp2.reused, true, 'an unchanged rebuild must reuse the sound operation');
      assert.equal(
        second.takes.find(candidate => candidate.source === 'score')!.id,
        take.id,
        'the Take identity must be preserved',
      );
      assert.deepEqual(
        soundTakeArtifacts(second)
          .map(artifact => artifact.sha256)
          .sort(),
        audioArtifacts.map(artifact => artifact.sha256).sort(),
        'the recorded audio bytes must be identical on reuse',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
