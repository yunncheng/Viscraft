import { createSymlinkFixture } from './fs-fixtures.js';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { analyzeAudioReference } from '../src/operations/analysis/audio-reference.js';
import { AudioReferenceSchema, ProjectSchema } from '../src/core/schema.js';
import type { Asset, Fps, Project } from '../src/core/schema.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { loadProject } from '../src/project/project.js';

const SAMPLE_RATE = 48000;
const FPS: Fps = { numerator: 30, denominator: 1 };
const PULSE_STARTS = [24000, 72000, 120000, 168000];

async function tempDir(): Promise<string> {
  return fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-audio-reference-test-'));
}

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

function makeProject(fps: Fps, sampleRate: 44100 | 48000, assets: Asset[] = []): Project {
  const frames = 30;
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'audio_ref_project',
    revision: 1,
    title: 'Audio reference test',
    direction: { intent: 'test', looks: [{ id: 'look_main', description: 'main' }], transitions: [] },
    assets,
    bindings: {},
    sources: [
      { id: 'src_sim', kind: 'simulated', prompt: 'test', frames, seed: 0, attempt: 'attempt_1', behavior: 'success' },
    ],
    composition: {
      output: { width: 160, height: 120, fps, sampleRate, channels: 2 },
      scenes: [{ id: 'scene_1', description: 'scene' }],
      shots: [{ id: 'shot_1', scene: 'scene_1', look: 'look_main', intent: 'shot', targetFrames: frames }],
      placements: [
        {
          id: 'place_1',
          shot: 'shot_1',
          source: 'src_sim',
          inFrame: 0,
          outFrame: frames,
          startFrame: 0,
          audio: 'mute',
        },
      ],
      transitions: [],
      audio: [],
    },
  });
}

async function writeProject(root: string, project: Project): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(nodePath.join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
}

/** Build a real mono 16-bit PCM WAV from a per-sample generator. */
function wavPcm16Mono(sampleRate: number, totalSamples: number, fill: (index: number) => number): Buffer {
  const data = Buffer.alloc(totalSamples * 2);
  for (let i = 0; i < totalSamples; i++) {
    const value = Math.max(-1, Math.min(1, fill(i)));
    data.writeInt16LE(Math.round(value * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

interface Pulse {
  startSample: number;
  lengthSamples: number;
  frequency: number;
  amplitude: number;
}

async function writePulsesWav(path: string, sampleRate: number, totalSamples: number, pulses: Pulse[]): Promise<void> {
  const buffer = wavPcm16Mono(sampleRate, totalSamples, i => {
    for (const pulse of pulses) {
      if (i >= pulse.startSample && i < pulse.startSample + pulse.lengthSamples) {
        return Math.sin((2 * Math.PI * pulse.frequency * (i - pulse.startSample)) / sampleRate) * pulse.amplitude;
      }
    }
    return 0;
  });
  await fs.writeFile(path, buffer);
}

/** The canonical 4-pulse, 4-second source used across tests. */
function fourPulses(): Pulse[] {
  return PULSE_STARTS.map(startSample => ({ startSample, lengthSamples: 2400, frequency: 440, amplitude: 0.8 }));
}

test('analyzeAudioReference detects four known synthetic pulse onsets on an exact sample grid', async () => {
  const root = await tempDir();
  try {
    await writeProject(root, makeProject(FPS, SAMPLE_RATE));
    const refs = nodePath.join(root, 'refs');
    await fs.mkdir(refs, { recursive: true });
    const audio = nodePath.join(refs, 'pulses.wav');
    await writePulsesWav(audio, SAMPLE_RATE, 192000, fourPulses());
    const projectBefore = await fs.readFile(nodePath.join(root, 'project.json'));
    const audioHash = await hashFile(audio);

    const report = await analyzeAudioReference(root, 'refs/pulses.wav');

    assert.equal(report.kind, 'audio-reference');
    assert.equal(report.schemaVersion, 1);
    assert.deepEqual(AudioReferenceSchema.parse(report), report, 'report must satisfy the canonical schema');

    assert.equal(report.source.path, 'refs/pulses.wav');
    assert.equal(report.source.sha256, audioHash);
    assert.equal(report.source.origin, 'material');
    assert.equal(report.source.simulated, false);
    assert.deepEqual(report.fps, FPS);
    assert.equal(report.sampleRate, SAMPLE_RATE);
    assert.equal(report.samples, 192000);
    assert.equal(report.windowSamples, 480);
    assert.equal(report.windowSeconds, 60, 'the default analysis window is 60 s');
    assert.deepEqual(
      report.analysedSpan,
      { startSample: 0, endSample: 192000, truncatedToWindow: false },
      'the analysed span is stated explicitly',
    );
    assert.equal(report.energy.length, 400);
    assert.ok(report.energy.every(row => row.rms >= 0));

    // The four pulses are detected at their exact known sample positions.
    assert.equal(report.onsets.length, 4);
    assert.deepEqual(
      report.onsets.map(onset => onset.sample),
      PULSE_STARTS,
    );
    // outputFrame = round(sample * 30 / 48000) = sample / 1600.
    assert.deepEqual(
      report.onsets.map(onset => onset.outputFrame),
      [15, 45, 75, 105],
    );
    for (const onset of report.onsets)
      assert.ok(onset.strength > 0.4, `strength ${onset.strength} should reflect a real pulse`);

    assert.ok(report.reportPath.startsWith('.viscraft/audio-references/'));
    assert.ok(report.reportPath.endsWith('/report.json'));
    assert.deepEqual(JSON.parse(await fs.readFile(nodePath.join(root, report.reportPath), 'utf8')), report);

    // Nothing was registered and no authoring file changed.
    assert.deepEqual(await fs.readFile(nodePath.join(root, 'project.json')), projectBefore);
    assert.equal(await hashFile(audio), audioHash);
    assert.equal((await loadProject(root)).assets.length, 0);
    assert.equal((await loadProject(root)).revision, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('analyzeAudioReference reports no onsets for genuinely silent audio', async () => {
  const root = await tempDir();
  try {
    await writeProject(root, makeProject(FPS, SAMPLE_RATE));
    const refs = nodePath.join(root, 'refs');
    await fs.mkdir(refs, { recursive: true });
    const audio = nodePath.join(refs, 'silence.wav');
    await writePulsesWav(audio, SAMPLE_RATE, 48000, []);

    const report = await analyzeAudioReference(root, 'refs/silence.wav');

    assert.equal(report.samples, 48000);
    assert.equal(report.onsets.length, 0);
    assert.ok(report.energy.length > 0);
    assert.ok(report.energy.every(row => row.rms === 0));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('analyzeAudioReference caps analysis at 60 seconds and records the truncation', async () => {
  const root = await tempDir();
  try {
    await writeProject(root, makeProject(FPS, SAMPLE_RATE));
    const refs = nodePath.join(root, 'refs');
    await fs.mkdir(refs, { recursive: true });
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=61',
      '-ac',
      '1',
      nodePath.join(refs, 'long.wav'),
    ]);

    const report = await analyzeAudioReference(root, 'refs/long.wav');

    assert.equal(report.samples, 60 * SAMPLE_RATE, 'analysis must be bounded to exactly 60 seconds');
    assert.equal(report.windowSeconds, 60);
    assert.deepEqual(
      report.analysedSpan,
      { startSample: 0, endSample: 60 * SAMPLE_RATE, truncatedToWindow: true },
      'the truncated analysed span is stated explicitly',
    );
    assert.equal(report.energy.length, 6000);
    assert.ok(report.onsets.every(onset => onset.sample < report.samples));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('analyzeAudioReference honours a configurable windowSeconds and still reports the exact span', async () => {
  const root = await tempDir();
  try {
    await writeProject(root, makeProject(FPS, SAMPLE_RATE));
    const refs = nodePath.join(root, 'refs');
    await fs.mkdir(refs, { recursive: true });
    await writePulsesWav(nodePath.join(refs, 'four.wav'), SAMPLE_RATE, 4 * SAMPLE_RATE, fourPulses());

    // A 2 s window over a 4 s source: the span is explicit and marked truncated.
    const short = await analyzeAudioReference(root, 'refs/four.wav', { windowSeconds: 2 });
    assert.equal(short.windowSeconds, 2);
    assert.equal(short.samples, 2 * SAMPLE_RATE);
    assert.deepEqual(short.analysedSpan, { startSample: 0, endSample: 2 * SAMPLE_RATE, truncatedToWindow: true });
    assert.equal(short.energy.length, 200);
    assert.ok(
      short.onsets.every(onset => onset.sample < 2 * SAMPLE_RATE),
      'no onset may lie outside the analysed window',
    );

    // A window wider than the source analyses the whole file and is not truncated.
    const wide = await analyzeAudioReference(root, 'refs/four.wav', { windowSeconds: 30 });
    assert.equal(wide.samples, 4 * SAMPLE_RATE);
    assert.deepEqual(wide.analysedSpan, { startSample: 0, endSample: 4 * SAMPLE_RATE, truncatedToWindow: false });

    // The window participates in the run key, so distinct windows never collide.
    assert.notEqual(short.reportPath, wide.reportPath);

    // Out-of-range windows are refused before any work.
    for (const bad of [0, -1, 3601, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        () => analyzeAudioReference(root, 'refs/four.wav', { windowSeconds: bad }),
        /windowSeconds must be a finite number in \(0, 3600\]/i,
      );
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('analyzeAudioReference rejects unsafe paths, missing files, symlinks, and audio-less media', async t => {
  const root = await tempDir();
  try {
    await writeProject(root, makeProject(FPS, SAMPLE_RATE));
    const refs = nodePath.join(root, 'refs');
    await fs.mkdir(refs, { recursive: true });
    const audio = nodePath.join(refs, 'pulses.wav');
    await writePulsesWav(audio, SAMPLE_RATE, 48000, [
      { startSample: 0, lengthSamples: 2400, frequency: 440, amplitude: 0.8 },
    ]);

    await assert.rejects(() => analyzeAudioReference(root, '../escape.wav'), /safe project-relative path/i);
    await assert.rejects(() => analyzeAudioReference(root, '/etc/passwd'), /safe project-relative path/i);
    await assert.rejects(() => analyzeAudioReference(root, 'refs/missing.wav'), /not readable/i);
    await assert.rejects(() => analyzeAudioReference(root, 'C:\\windows\\evil.wav'));

    const link = nodePath.join(refs, 'link.wav');
    await t.test('file symlink is refused', async t => {
      if (!(await createSymlinkFixture(t, audio, link))) return;
      await assert.rejects(() => analyzeAudioReference(root, 'refs/link.wav'), /Symbolic links are not allowed/i);
    });

    // A real file whose audio stream is absent must error, never read as silence.
    const videoOnly = nodePath.join(refs, 'video-only.mp4');
    await ffmpeg([
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=32x32:r=10:d=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      videoOnly,
    ]);
    await assert.rejects(() => analyzeAudioReference(root, 'refs/video-only.mp4'), /no decodable audio stream/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('analyzeAudioReference honors explicit clocks without a composition and validates options', async () => {
  const root = await tempDir();
  try {
    await writeProject(root, makeProject(FPS, SAMPLE_RATE));
    const refs = nodePath.join(root, 'refs');
    await fs.mkdir(refs, { recursive: true });
    await writePulsesWav(nodePath.join(refs, 'pulses.wav'), SAMPLE_RATE, 192000, fourPulses());

    const lowFps = await analyzeAudioReference(root, 'refs/pulses.wav', { fps: { numerator: 10, denominator: 1 } });
    assert.deepEqual(lowFps.fps, { numerator: 10, denominator: 1 });
    assert.deepEqual(
      lowFps.onsets.map(onset => onset.outputFrame),
      [5, 15, 25, 35],
    );

    const resampled = await analyzeAudioReference(root, 'refs/pulses.wav', { sampleRate: 44100 });
    assert.equal(resampled.sampleRate, 44100);
    assert.equal(resampled.windowSamples, 441);
    assert.equal(resampled.samples, 176400);
    assert.deepEqual(
      resampled.onsets.map(onset => onset.sample),
      [22050, 66150, 110250, 154350],
    );

    await assert.rejects(
      () => analyzeAudioReference(root, 'refs/pulses.wav', { sampleRate: 22050 as unknown as 44100 }),
      /sampleRate must be 44100 or 48000/i,
    );
    await assert.rejects(
      () => analyzeAudioReference(root, 'refs/pulses.wav', { threshold: 1.5 }),
      /threshold must be a finite number in \[0, 1\]/i,
    );
    await assert.rejects(
      () => analyzeAudioReference(root, 'refs/pulses.wav', { threshold: -0.1 }),
      /threshold must be a finite number in \[0, 1\]/i,
    );

    const draft = makeProject(FPS, SAMPLE_RATE);
    delete draft.composition;
    await writeProject(root, draft);
    const authorState = await fs.readFile(nodePath.join(root, 'project.json'));
    const referenceHash = await hashFile(nodePath.join(refs, 'pulses.wav'));
    const standalone = await analyzeAudioReference(root, 'refs/pulses.wav', {
      fps: FPS,
      sampleRate: SAMPLE_RATE,
    });
    assert.deepEqual(standalone.fps, FPS);
    assert.equal(standalone.sampleRate, SAMPLE_RATE);
    assert.equal(standalone.samples, 192000);
    assert.deepEqual(
      standalone.onsets.map(onset => onset.sample),
      PULSE_STARTS,
    );
    for (const options of [{ fps: FPS }, { sampleRate: SAMPLE_RATE }] as const) {
      await assert.rejects(() => analyzeAudioReference(root, 'refs/pulses.wav', options), /no timeline composition/i);
    }
    assert.deepEqual(await fs.readFile(nodePath.join(root, 'project.json')), authorState);
    assert.equal(await hashFile(nodePath.join(refs, 'pulses.wav')), referenceHash);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('analyzeAudioReference publishes each run to a unique directory and never deletes prior reports', async () => {
  const root = await tempDir();
  try {
    await writeProject(root, makeProject(FPS, SAMPLE_RATE));
    const refs = nodePath.join(root, 'refs');
    await fs.mkdir(refs, { recursive: true });
    await writePulsesWav(nodePath.join(refs, 'pulses.wav'), SAMPLE_RATE, 192000, fourPulses());

    const first = await analyzeAudioReference(root, 'refs/pulses.wav');
    const second = await analyzeAudioReference(root, 'refs/pulses.wav');

    assert.notEqual(first.reportPath, second.reportPath, 'each run must publish to a unique directory');
    assert.deepEqual(JSON.parse(await fs.readFile(nodePath.join(root, first.reportPath), 'utf8')), first);
    assert.deepEqual(JSON.parse(await fs.readFile(nodePath.join(root, second.reportPath), 'utf8')), second);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('analyzeAudioReference taints provenance from a simulated audio Asset', async () => {
  const root = await tempDir();
  try {
    const refs = nodePath.join(root, 'refs');
    await fs.mkdir(refs, { recursive: true });
    const audio = nodePath.join(refs, 'pulses.wav');
    await writePulsesWav(audio, SAMPLE_RATE, 48000, []);
    const sha256 = await hashFile(audio);
    const asset: Asset = {
      id: 'asset_audio',
      revision: 1,
      path: 'refs/pulses.wav',
      sha256,
      type: 'audio',
      rights: { origin: 'test-only', license: 'test-only', redistributable: false },
      simulated: true,
    };
    await writeProject(root, makeProject(FPS, SAMPLE_RATE, [asset]));

    const report = await analyzeAudioReference(root, 'refs/pulses.wav');

    assert.equal(report.source.origin, 'asset');
    assert.equal(report.source.simulated, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('analyzeAudioReference refuses to guess identity from a path whose recorded hash differs', async () => {
  const root = await tempDir();
  try {
    const refs = nodePath.join(root, 'refs');
    await fs.mkdir(refs, { recursive: true });
    const audio = nodePath.join(refs, 'pulses.wav');
    await writePulsesWav(audio, SAMPLE_RATE, 48000, []);
    const asset: Asset = {
      id: 'asset_audio',
      revision: 1,
      path: 'refs/pulses.wav',
      sha256: '0'.repeat(64),
      type: 'audio',
      rights: { origin: 'test-only', license: 'test-only', redistributable: false },
      simulated: true,
    };
    await writeProject(root, makeProject(FPS, SAMPLE_RATE, [asset]));

    const report = await analyzeAudioReference(root, 'refs/pulses.wav');

    assert.equal(report.source.origin, 'material', 'a stale recorded hash must not establish identity');
    assert.equal(report.source.simulated, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
