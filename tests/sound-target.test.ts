/**
 * Standalone sound targets on their own sample clock.
 *
 * The contract these tests pin:
 *  - a sound Source states `durationSamples` at its NATIVE `sampleRate`; the old
 *    picture `frames` field is a strict-schema error;
 *  - a Take carries ONE clock: a sound Take has samples/sampleRate/channels and a
 *    picture Take has frames/fps, never both;
 *  - `build --target <sound-id>` produces exactly `outputSamples` samples, records
 *    `medium: 'sound'`, and never takes over the active movie result;
 *  - a sound Source's operation identity does not depend on the picture output, so
 *    editing a film's FPS or raster cannot re-key (or re-render) the soundtrack.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildProject, resolveBuildSelection } from '../src/build/build.js';
import { sourceOperationIdentity } from '../src/build/identity.js';
import { planBuild } from '../src/build/plan.js';
import { probeAudio } from '../src/backends/media/probe.js';
import { ProjectSchema, TakeSchema } from '../src/core/schema.js';
import { validateProject } from '../src/project/project.js';
import { stableHash } from '../src/shared/hash.js';
import { findBrowser } from '../src/backends/browser/capture.js';
import { writeSignalAsset } from './audio-fixtures.js';
import { runCommand } from '../src/shared/process.js';

const SAMPLE_RATE = 44100 as const;
const OUTPUT_SAMPLES = 24000;

const RIGHTS = { origin: 'test signal', license: 'CC0-1.0', redistributable: true };

function baseProject(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: 'sound-target',
    revision: 1,
    title: 'Sound target',
    direction: { intent: 'one soundtrack', looks: [{ id: 'only', description: 'plain' }] },
    sources: [],
    ...overrides,
  };
}

function soundSource(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pad',
    kind: 'browser',
    output: 'sound',
    entry: 'pad.html',
    resources: [],
    bindings: [],
    params: {},
    seed: 1,
    durationSamples: OUTPUT_SAMPLES,
    sampleRate: SAMPLE_RATE,
    ...overrides,
  };
}

const COMPOSITION = {
  output: {
    width: 320,
    height: 180,
    fps: { numerator: 24, denominator: 1 },
    sampleRate: 48000 as const,
    channels: 2 as const,
  },
  scenes: [{ id: 'scene', description: 'scene' }],
  shots: [{ id: 'shot', scene: 'scene', look: 'only', intent: 'shot', targetFrames: 24 }],
  placements: [
    {
      id: 'p1',
      shot: 'shot',
      source: 'still',
      inFrame: 0,
      outFrame: 24,
      startFrame: 0,
      audio: 'mute',
    },
  ],
  audio: [],
  transitions: [],
};

test('a sound Source uses durationSamples and a native rate; frames is rejected', () => {
  const accepted = ProjectSchema.parse(baseProject({ sources: [soundSource()], soundTargets: [] }));
  assert.equal(accepted.sources.length, 1);

  assert.throws(
    () => ProjectSchema.parse(baseProject({ sources: [soundSource({ durationSamples: undefined, frames: 96 })] })),
    /frames|durationSamples/i,
    'the removed picture-clock field must not be accepted on a sound Source',
  );
  assert.throws(
    () => ProjectSchema.parse(baseProject({ sources: [soundSource({ sampleRate: 32000 })] })),
    /sampleRate/i,
  );
});

test('Take is discriminated by medium and never mixes the two clocks', () => {
  const sound = TakeSchema.parse({
    id: 'take-s',
    artifact: 'artifact-s',
    source: 'pad',
    sourceKey: 'key',
    medium: 'sound',
    samples: OUTPUT_SAMPLES,
    sampleRate: SAMPLE_RATE,
    channels: 2,
    simulated: false,
  });
  assert.equal(sound.medium, 'sound');

  assert.throws(
    () =>
      TakeSchema.parse({
        id: 'take-x',
        artifact: 'artifact-x',
        source: 'pad',
        sourceKey: 'key',
        medium: 'sound',
        frames: 24,
        fps: { numerator: 24, denominator: 1 },
        simulated: false,
      }),
    /medium|samples/i,
  );
  assert.throws(
    () =>
      TakeSchema.parse({
        id: 'take-y',
        artifact: 'artifact-y',
        source: 'pad',
        sourceKey: 'key',
        medium: 'picture',
        samples: OUTPUT_SAMPLES,
        sampleRate: SAMPLE_RATE,
        channels: 2,
        simulated: false,
      }),
    /medium|frames/i,
  );
});

test('target selection refuses an image target and a composition-less project without --target', () => {
  const project = validateProject(
    baseProject({
      sources: [soundSource()],
      soundTargets: [{ id: 'mix', sampleRate: SAMPLE_RATE, channels: 2, outputSamples: OUTPUT_SAMPLES, audio: [] }],
      imageTargets: [],
    }),
  );
  assert.deepEqual(resolveBuildSelection(project, 'mix'), {
    medium: 'sound',
    target: project.soundTargets[0],
  });
  assert.throws(() => resolveBuildSelection(project), /no timeline composition/i);
  assert.throws(() => resolveBuildSelection(project, 'nope'), /unknown target/i);
});

test('image and sound targets share one id namespace', () => {
  assert.throws(
    () =>
      ProjectSchema.parse(
        baseProject({
          sources: [],
          imageDocuments: [{ id: 'doc', path: 'poster.html', resources: [], revision: 1 }],
          imageTargets: [{ id: 'shared', document: 'doc', width: 64, height: 64 }],
          soundTargets: [{ id: 'shared', sampleRate: SAMPLE_RATE, channels: 1, outputSamples: 1000, audio: [] }],
        }),
      ),
    /Duplicate target/,
  );
});

test('a sound Source operation key ignores the picture output', async () => {
  const project = validateProject(
    baseProject({
      sources: [
        soundSource({ entry: 'pad.html' }),
        {
          id: 'still',
          kind: 'browser',
          output: 'picture',
          entry: 'still.html',
          resources: [],
          bindings: [],
          params: {},
          seed: 0,
          frames: 24,
        },
      ],
      composition: COMPOSITION,
      soundTargets: [{ id: 'mix', sampleRate: SAMPLE_RATE, channels: 2, outputSamples: OUTPUT_SAMPLES, audio: [] }],
    }),
  );
  const source = project.sources.find(candidate => candidate.id === 'pad')!;
  const files = new Map([['pad.html', 'f'.repeat(64)]]);
  const sound = { sampleRate: SAMPLE_RATE, channels: 2 as const, samples: OUTPUT_SAMPLES };
  const at24 = await sourceOperationIdentity(
    project,
    source,
    {},
    files,
    { ...COMPOSITION.output, fps: { numerator: 24 as const, denominator: 1 as const } },
    '',
    sound,
  );
  const at30 = await sourceOperationIdentity(
    project,
    source,
    {},
    files,
    {
      ...COMPOSITION.output,
      fps: { numerator: 30 as const, denominator: 1 as const },
      width: 1920,
      height: 1080,
    },
    '',
    sound,
  );
  const key = (identity: { kind: string; inputs: string[]; parameters: unknown }) =>
    stableHash({ kind: identity.kind, inputs: identity.inputs, parameters: identity.parameters });
  assert.equal(key(at24), key(at30), 'a picture raster/FPS edit must not re-key the soundtrack');
});

test('build --target produces exactly outputSamples and never owns the movie result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-sound-target-'));
  try {
    const signal = await writeSignalAsset(root, {
      id: 'bed',
      path: 'bed.wav',
      sampleRate: SAMPLE_RATE,
      channels: 2,
      samples: SAMPLE_RATE * 2,
      frequency: 220,
      amplitude: 0.2,
    });
    const project = validateProject(
      baseProject({
        sources: [soundSource({ entry: 'pad.html' })],
        assets: [signal],
        soundTargets: [
          {
            id: 'mix',
            sampleRate: SAMPLE_RATE,
            channels: 2,
            outputSamples: OUTPUT_SAMPLES,
            audio: [
              {
                id: 'bed-clip',
                kind: 'asset',
                asset: 'bed',
                inSample: OUTPUT_SAMPLES + 1,
                startSample: 0,
                durationSamples: OUTPUT_SAMPLES,
                gain: 1,
                fadeInSamples: 0,
                fadeOutSamples: 0,
              },
            ],
          },
        ],
      }),
    );
    await writeFile(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
    await writeFile(join(root, 'pad.html'), '<!doctype html><html><body></body></html>');

    const plan = await planBuild(root, { target: 'mix' });
    assert.equal(plan.medium, 'sound');
    assert.equal(plan.target, 'mix');
    assert.equal(plan.outputSamples, OUTPUT_SAMPLES);
    assert.equal(plan.sampleRate, SAMPLE_RATE);
    assert.equal(plan.buildable, true);

    const record = await buildProject(root, { target: 'mix' });
    assert.equal(record.medium, 'sound');
    assert.equal(record.target, 'mix');
    assert.ok(record.result, 'a sound Build records its own result');
    const artifact = record.artifacts.find(candidate => candidate.id === record.result!.artifact)!;
    const media = await probeAudio(join(root, artifact.path));
    assert.equal(media.sampleRate, SAMPLE_RATE);
    assert.equal(media.channels, 2);
    // Ceil/exact span: the delivered WAV holds exactly the authored samples.
    assert.ok(
      Math.abs(media.duration * SAMPLE_RATE - OUTPUT_SAMPLES) < 1,
      `expected ~${OUTPUT_SAMPLES} samples, got ${media.duration * SAMPLE_RATE}`,
    );
    const decoded = join(root, 'decoded.f32');
    await runCommand('ffmpeg', [
      '-v',
      'error',
      '-nostdin',
      '-y',
      '-i',
      join(root, artifact.path),
      '-f',
      'f32le',
      '-c:a',
      'pcm_f32le',
      decoded,
    ]);
    const rendered = await readFile(decoded);
    const original = await readFile(join(root, 'bed.wav'));
    for (let i = 0; i < 64; i++) {
      const expected = original.readInt16LE(44 + (OUTPUT_SAMPLES + 1) * 4 + i * 2) / 32768;
      assert.ok(
        Math.abs(rendered.readFloatLE(i * 4) - expected) < 0.0001,
        'the output starts at the authored source sample, independent of target length',
      );
    }
    await assert.rejects(stat(join(root, '.viscraft/result.json')), /ENOENT/);

    // Rebuilding the same target reuses the exact mix operation instead of
    // re-encoding bytes.
    const again = await buildProject(root, { target: 'mix' });
    const mix = again.operations.find(operation => operation.kind === 'mix-audio')!;
    assert.equal(mix.reused, true);
    assert.equal(
      JSON.parse(await readFile(join(root, '.viscraft/snapshots', `${again.id}.inputs.json`), 'utf8')).files['bed.wav'],
      signal.sha256,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a sound build reports its gaps and still refuses a consumed damaged Asset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-sound-gap-'));
  try {
    const signal = await writeSignalAsset(root, {
      id: 'bed',
      path: 'bed.wav',
      sampleRate: SAMPLE_RATE,
      channels: 1,
      samples: 4000,
      amplitude: 0.1,
    });
    // Unrelated declared Asset whose bytes are absent: a gap, never a blocker.
    const unused = {
      id: 'unused',
      revision: 1,
      path: 'unused.wav',
      sha256: 'a'.repeat(64),
      type: 'audio' as const,
      rights: RIGHTS,
      simulated: false,
    };
    const project = validateProject(
      baseProject({
        sources: [],
        assets: [signal, unused],
        soundTargets: [
          {
            id: 'mix',
            sampleRate: SAMPLE_RATE,
            channels: 1,
            outputSamples: 4000,
            audio: [
              {
                id: 'clip',
                kind: 'asset',
                asset: 'bed',
                inSample: 0,
                startSample: 0,
                durationSamples: 4000,
                gain: 1,
                fadeInSamples: 0,
                fadeOutSamples: 0,
              },
            ],
          },
        ],
      }),
    );
    await writeFile(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
    const record = await buildProject(root, { target: 'mix' });
    const inputs = JSON.parse(await readFile(join(root, '.viscraft/snapshots', `${record.id}.inputs.json`), 'utf8'));
    assert.deepEqual(
      inputs.unavailable.map((gap: { path: string }) => gap.path),
      ['unused.wav'],
    );
    assert.equal(inputs.unavailable[0].reason, 'path-missing');

    // Consumed, damaged: the declared digest no longer matches the bytes.
    await writeFile(join(root, 'bed.wav'), Buffer.alloc(64, 1));
    await assert.rejects(buildProject(root, { target: 'mix' }), /consume|do not match|not available/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a 48 kHz sound Source is produced natively, then resampled into a 44.1 kHz target at the exact span', async () => {
  const browser = await findBrowser().catch(() => undefined);
  if (!browser) return; // real-browser evidence only when Chrome is installed
  const root = await mkdtemp(join(tmpdir(), 'viscraft-sound-resample-'));
  try {
    const sourceRate = 48000 as const;
    const sourceSamples = 9600; // 0.2 s
    const targetRate = 44100 as const;
    const targetSamples = 8820; // the SAME 0.2 s at the target rate
    const page = `<!doctype html><html><body><script>
window.viscraftSound = {
  ready: function () { return Promise.resolve(); },
  render: function (ctx) {
    var out = new Float32Array(ctx.samples * ctx.channels);
    for (var i = 0; i < ctx.samples; i++) {
      var v = Math.sin(2 * Math.PI * 220 * (i / ctx.sampleRate)) * 0.25;
      for (var c = 0; c < ctx.channels; c++) out[i * ctx.channels + c] = v;
    }
    return out;
  }
};
</script></body></html>`;
    const project = validateProject(
      baseProject({
        sources: [soundSource({ entry: 'resample.html', durationSamples: sourceSamples, sampleRate: sourceRate })],
        soundTargets: [
          {
            id: 'mix',
            sampleRate: targetRate,
            channels: 2,
            outputSamples: targetSamples,
            audio: [
              {
                id: 'clip',
                kind: 'source',
                source: 'pad',
                startSample: 0,
                gain: 1,
                fadeInSamples: 0,
                fadeOutSamples: 0,
              },
            ],
          },
        ],
      }),
    );
    await writeFile(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
    await writeFile(join(root, 'resample.html'), page);

    const record = await buildProject(root, { target: 'mix' });
    const take = record.takes.find(candidate => candidate.medium === 'sound')!;
    assert.equal(take.medium, 'sound');
    assert.equal(take.samples, sourceSamples, 'the Take keeps the Source native span');
    assert.equal(take.sampleRate, sourceRate, 'the Take keeps the Source native rate');

    const artifact = record.artifacts.find(candidate => candidate.id === record.result!.artifact)!;
    const media = await probeAudio(join(root, artifact.path));
    assert.equal(media.sampleRate, targetRate, 'the delivered programme is at the target rate');
    assert.equal(media.channels, 2);
    assert.equal(media.samples, targetSamples, 'seconds are preserved, not stretched');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
