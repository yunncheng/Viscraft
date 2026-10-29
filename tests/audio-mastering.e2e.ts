/**
 * Real, behaviour-level verification of optional measured audio mastering.
 *
 * These tests prove the *production* behaviour of the new capability, not the
 * mere existence of a symbol:
 *  - an absent `composition.mastering` is never defaulted and produces no
 *    `master-audio` operation (the original valid mix is muxed unchanged);
 *  - an enabled `composition.mastering` produces real mastered PCM16 whose
 *    actual integrated loudness / true peak are verified by an independent
 *    FFmpeg ebur128 pass, at the exact canonical ceil sample span;
 *  - a change to only `targetLufs` reruns `master-audio` + `mux-final` while
 *    every Source/Take/compose/mix identity is reused **within this fixed
 *    runtime** (this is a same-environment command cache, never a claim of
 *    cross-version artifact portability);
 *  - deleting `mastering` restores the original unmastered Result/mux identity;
 *  - an overloaded mix still fails before mastering and preserves the previous
 *    active Result;
 *  - silent / too-short / wrong-span PCM is rejected explicitly and the input
 *    mix is never overwritten;
 *  - NTSC 30000/1001 at 44.1 kHz mono masters to the canonical ceil span and is
 *    resampled back from loudnorm's native rate;
 *  - a mastered work survives a portable export and reopens with all identity
 *    reuse plus the persisted mastering report and dependency bytes.
 *
 * Independence notes: loudness is re-measured here with a separate ebur128
 * invocation and PCM is decoded/counted directly; the delivered AAC is probed
 * separately from the intermediate destination PCM. No subjective listening
 * claim is made.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildProject } from '../src/build/build.js';
import { readBuilds } from '../src/project/build-records.js';
import { masterAudio } from '../src/backends/media/audio-master.js';
import { probeMedia } from '../src/backends/media/probe.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { loadProject, saveProject, validateProject } from '../src/project/project.js';
import {
  AudioMasteringReportSchema,
  AudioMasteringSchema,
  type AudioMastering,
  type Project,
} from '../src/core/schema.js';
import { framesToSamples } from '../src/core/time.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { makeSignalAsset, writeSignalAsset } from './audio-fixtures.js';

const PAGE =
  '<!doctype html><body style="margin:0"><canvas id="c"></canvas><script>window.viscraft={render(ctx){const c=document.getElementById("c");c.width=ctx.width;c.height=ctx.height;const g=c.getContext("2d");g.fillStyle="#286eb0";g.fillRect(0,0,c.width,c.height);g.fillStyle="#ffffff";g.fillRect(ctx.frame*2,4,4,4);}};</script>';

/** Run FFmpeg and resolve with full stderr (which carries the ebur128 summary). */
function ffmpegStderr(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-nostdin', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', data => {
      stderr = (stderr + String(data)).slice(-64_000);
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`ffmpeg analysis exited ${code}: ${stderr.slice(-800)}`));
    });
  });
}

/** Independently re-measure a WAV's integrated loudness and true peak via ebur128. */
async function measureLoudness(path: string): Promise<{ integratedLufs: number; truePeakDbfs: number }> {
  const log = await ffmpegStderr([
    '-i',
    path,
    '-map',
    '0:a:0',
    '-vn',
    '-af',
    'ebur128=peak=true:framelog=quiet',
    '-f',
    'null',
    '-',
  ]);
  const integrated = /^\s*I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/m.exec(log);
  const peak = /Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/.exec(log);
  assert(integrated && peak, `independent ebur128 summary must be readable (${log.slice(-400)})`);
  return { integratedLufs: Number(integrated[1]), truePeakDbfs: Number(peak[1]) };
}

/** Decode a WAV to raw f32le and report the exact sample count and peak amplitude. */
async function decodePcm(
  path: string,
  channels: number,
  sampleRate: number,
  scratch: string,
): Promise<{ samples: number; peak: number }> {
  const out = join(scratch, `probe-${Math.random().toString(36).slice(2)}.f32`);
  await runCommand('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-i',
    path,
    '-f',
    'f32le',
    '-ac',
    String(channels),
    '-ar',
    String(sampleRate),
    out,
  ]);
  const bytes = await readFile(out);
  const total = Math.floor(bytes.length / 4);
  assert.equal(total % channels, 0, 'decoded PCM must contain whole sample frames');
  let peak = 0;
  for (let i = 0; i < total; i++) {
    const value = bytes.readFloatLE(i * 4);
    assert(Number.isFinite(value), 'decoded PCM must be finite');
    assert(Math.abs(value) <= 1.0001, 'decoded PCM must stay within full scale');
    peak = Math.max(peak, Math.abs(value));
  }
  return { samples: total / channels, peak };
}

async function probeAudioStream(path: string): Promise<{ codec: string; sampleRate: number; channels: number }> {
  const probe = JSON.parse(
    await runCommand('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=codec_name,sample_rate,channels',
      '-of',
      'json',
      path,
    ]),
  ) as { streams?: Array<{ codec_name?: string; sample_rate?: string; channels?: number }> };
  const stream = probe.streams?.[0];
  assert(stream, `expected an audio stream in ${path}`);
  return {
    codec: String(stream.codec_name),
    sampleRate: Number(stream.sample_rate),
    channels: Number(stream.channels),
  };
}

const FPS30 = { numerator: 30, denominator: 1 };

function audioProject(
  totalFrames: number,
  totalSamples: number,
  mastering?: AudioMastering,
  assets: Project['assets'] = [],
): Project {
  return {
    schemaVersion: 1,
    id: 'audio-mastering-work',
    revision: 1,
    title: 'Measured audio mastering',
    soundTargets: [],
    direction: {
      intent: 'Two measured signals under a real Browser picture',
      looks: [{ id: 'look', description: 'identity' }],
      transitions: [],
    },
    assets,
    bindings: {},
    sources: [
      {
        id: 'scene',
        kind: 'browser',
        output: 'picture',
        entry: 'scene.html',
        resources: [],
        bindings: [],
        params: {},
        seed: 0,
        frames: totalFrames,
      },
    ],
    composition: {
      output: { width: 64, height: 48, fps: FPS30, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene', description: 'Measured signals' }],
      shots: [
        {
          id: 'shot',
          scene: 'scene',
          look: 'look',
          intent: 'Browser picture with measured signal bed',
          targetFrames: totalFrames,
        },
      ],
      placements: [
        { id: 'edit', shot: 'shot', source: 'scene', inFrame: 0, outFrame: totalFrames, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio: [
        {
          id: 'signalA',
          kind: 'asset',
          asset: 'signalA',
          inSample: 0,
          startSample: 0,
          durationSamples: totalSamples,
          gain: 0.2,
          fadeInSamples: 4800,
          fadeOutSamples: 4800,
        },
        {
          id: 'signalB',
          kind: 'asset',
          asset: 'signalB',
          inSample: 0,
          startSample: 0,
          durationSamples: totalSamples,
          gain: 0.1,
          fadeInSamples: 4800,
          fadeOutSamples: 4800,
        },
      ],
      ...(mastering ? { mastering } : {}),
    },
    imageDocuments: [],
    imageTargets: [],
  };
}

/** Write the two-signal score for a build root at the real 48 kHz stereo output. */
async function writeScore(root: string, totalSamples: number): Promise<Project['assets']> {
  const a = await writeSignalAsset(root, {
    id: 'signalA',
    path: 'signalA.wav',
    sampleRate: 48000,
    channels: 2,
    samples: totalSamples,
    frequency: 220,
  });
  const b = await writeSignalAsset(root, {
    id: 'signalB',
    path: 'signalB.wav',
    sampleRate: 48000,
    channels: 2,
    samples: totalSamples,
    frequency: 440,
  });
  return [a, b];
}

// ---------------------------------------------------------------------------
// 1. Schema contract
// ---------------------------------------------------------------------------

test('audio mastering schema requires two finite bounded settings and rejects extra fields', async () => {
  const parsed = AudioMasteringSchema.parse({ targetLufs: -18, truePeakDbfs: -1 });
  assert.deepEqual(
    Object.keys(parsed).sort(),
    ['targetLufs', 'truePeakDbfs'],
    'mastering must not gain default-injected fields',
  );

  assert.throws(() => AudioMasteringSchema.parse({}), 'both settings are required');
  assert.throws(() => AudioMasteringSchema.parse({ targetLufs: -18 }), 'truePeakDbfs is required');
  assert.throws(() => AudioMasteringSchema.parse({ truePeakDbfs: -1 }), 'targetLufs is required');
  assert.throws(
    () => AudioMasteringSchema.parse({ targetLufs: Infinity, truePeakDbfs: -1 }),
    'non-finite target is rejected',
  );
  assert.throws(
    () => AudioMasteringSchema.parse({ targetLufs: -18, truePeakDbfs: -Infinity }),
    'non-finite peak is rejected',
  );
  assert.throws(() => AudioMasteringSchema.parse({ targetLufs: NaN, truePeakDbfs: -1 }), 'NaN target is rejected');
  assert.throws(
    () => AudioMasteringSchema.parse({ targetLufs: -70.5, truePeakDbfs: -1 }),
    'target below -70 is rejected',
  );
  assert.throws(
    () => AudioMasteringSchema.parse({ targetLufs: -4.9, truePeakDbfs: -1 }),
    'target above -5 is rejected',
  );
  assert.throws(() => AudioMasteringSchema.parse({ targetLufs: -18, truePeakDbfs: -9.5 }), 'peak below -9 is rejected');
  assert.throws(() => AudioMasteringSchema.parse({ targetLufs: -18, truePeakDbfs: 0.5 }), 'positive peak is rejected');
  assert.throws(
    () => AudioMasteringSchema.parse({ targetLufs: -18, truePeakDbfs: -1, mode: 'two-pass-loudnorm' }),
    'an extra mode field is rejected',
  );
  assert.throws(
    () => AudioMasteringSchema.parse({ targetLufs: -18, truePeakDbfs: -1, lra: 50 }),
    'an extra LRA field is rejected',
  );
  // Boundary values are accepted.
  assert.doesNotThrow(() => AudioMasteringSchema.parse({ targetLufs: -70, truePeakDbfs: -9 }));
  assert.doesNotThrow(() => AudioMasteringSchema.parse({ targetLufs: -5, truePeakDbfs: 0 }));

  // The project surface rejects invalid mastering and the report surface rejects
  // a dishonest dual-mono / LRA / normalization mode.
  const schemaAssets = [
    makeSignalAsset({
      id: 'signalA',
      path: 'signalA.wav',
      sampleRate: 48000,
      channels: 2,
      samples: 192000,
      frequency: 220,
    }).asset,
    makeSignalAsset({
      id: 'signalB',
      path: 'signalB.wav',
      sampleRate: 48000,
      channels: 2,
      samples: 192000,
      frequency: 440,
    }).asset,
  ];
  const project = audioProject(120, 192000, { targetLufs: -18, truePeakDbfs: -1 }, schemaAssets);
  assert.doesNotThrow(() => validateProject(project));
  assert.throws(
    () =>
      validateProject({
        ...project,
        composition: { ...project.composition, mastering: { targetLufs: Infinity, truePeakDbfs: -1 } },
      }),
    'project rejects non-finite mastering',
  );
  const report = {
    method: 'two-pass-loudnorm',
    settings: { targetLufs: -18, truePeakDbfs: -1 },
    normalizationType: 'linear',
    dualMono: false,
    loudnessRangeTarget: 50,
    input: { integratedLufs: -13, truePeakDbfs: -10, loudnessRange: 0, thresholdLufs: -23, targetOffset: 1 },
    output: { integratedLufs: -18, truePeakDbfs: -10, sampleRate: 48000, channels: 2, samples: 192000 },
  };
  assert.doesNotThrow(() => AudioMasteringReportSchema.parse(report));
  assert.throws(() => AudioMasteringReportSchema.parse({ ...report, dualMono: true }));
  assert.throws(() => AudioMasteringReportSchema.parse({ ...report, loudnessRangeTarget: 7 }));
  assert.throws(() => AudioMasteringReportSchema.parse({ ...report, normalizationType: 'peak' }));
  assert.throws(() => AudioMasteringReportSchema.parse({ ...report, method: 'single-pass' }));
});

// ---------------------------------------------------------------------------
// 2. Direct masterAudio contract (silence / short / span / overwrite)
// ---------------------------------------------------------------------------

test('masterAudio rejects silent, too-short and wrong-span PCM and never overwrites its input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-master-direct-'));
  try {
    const output = { width: 64, height: 48, fps: FPS30, sampleRate: 48000, channels: 2 } as const;
    const settings: AudioMastering = { targetLufs: -20, truePeakDbfs: -1 };
    const tone4 = join(root, 'tone4.wav');
    const silence4 = join(root, 'silence4.wav');
    const short = join(root, 'short.wav');
    // 4 s measurable tone, 4 s digital silence and a 0.1 s tone.
    await runCommand('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-af',
      'volume=0.2',
      '-t',
      '4',
      '-ac',
      '2',
      '-c:a',
      'pcm_s16le',
      tone4,
    ]);
    await runCommand('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-t',
      '4',
      '-c:a',
      'pcm_s16le',
      silence4,
    ]);
    await runCommand('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-af',
      'volume=0.2',
      '-t',
      '0.1',
      '-ac',
      '2',
      '-c:a',
      'pcm_s16le',
      short,
    ]);

    const toneHash = await hashFile(tone4);

    // Valid direct master: the report matches the exact canonical span.
    const validDest = join(root, 'valid.wav');
    const validReport = await masterAudio(tone4, output, 120, settings, validDest);
    assert.equal(validReport.output.samples, framesToSamples(120, FPS30, 48000, 'ceil'));
    assert.equal(validReport.output.sampleRate, 48000);
    assert.equal(validReport.output.channels, 2);
    const validStream = await probeAudioStream(validDest);
    assert.deepEqual(validStream, { codec: 'pcm_s16le', sampleRate: 48000, channels: 2 });
    assert.equal(await hashFile(tone4), toneHash, 'a valid master must not modify its input mix');

    // Overwriting the input is refused outright.
    await assert.rejects(masterAudio(tone4, output, 120, settings, tone4), /must not overwrite/);

    // Silence with a matching span fails explicitly instead of pretending a target.
    const silentDest = join(root, 'silent-out.wav');
    await assert.rejects(
      masterAudio(silence4, output, 120, settings, silentDest),
      /too-short|loudness-mastered|no loudnorm measurement|non-finite/,
    );
    await assert.rejects(readFile(silentDest), /ENOENT/, 'silent input must not produce a destination');

    // A 0.1 s (3 frame) program is too short to measure.
    const shortDest = join(root, 'short-out.wav');
    await assert.rejects(
      masterAudio(short, output, 3, settings, shortDest),
      /too-short|loudness-mastered|no loudnorm measurement|non-finite/,
    );
    await assert.rejects(readFile(shortDest), /ENOENT/, 'too-short input must not produce a destination');

    // A span that does not match the declared frames is rejected before any work.
    const mismatchDest = join(root, 'mismatch-out.wav');
    await assert.rejects(masterAudio(tone4, output, 60, settings, mismatchDest), /expected exact .* span/);
    await assert.rejects(readFile(mismatchDest), /ENOENT/, 'mismatch-span input must not produce a destination');

    // The input mix bytes survive every failure path.
    assert.equal(await hashFile(tone4), toneHash, 'failed mastering must never alter the input mix');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Normal production integration: enable, edit, revert, failure, portable
// ---------------------------------------------------------------------------

test('optional mastering integrates into production, edits selectively, reverts and survives portable reuse', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-audio-master-'));
  const exported = root + '-export';
  try {
    await writeFile(join(root, 'scene.html'), PAGE);
    const totalFrames = 132; // 4.4 s at 30 fps
    const canonical = framesToSamples(totalFrames, FPS30, 48000, 'ceil');
    assert.equal(canonical, 211200, 'canonical span for 132 frames at 30 fps / 48 kHz is exact');
    const assets = await writeScore(root, canonical);
    await writeFile(
      join(root, 'project.json'),
      JSON.stringify(validateProject(audioProject(totalFrames, canonical, undefined, assets))),
    );

    // --- Absent mastery: no default injection, no master-audio op ---
    const rawAuthored = JSON.parse(await readFile(join(root, 'project.json'), 'utf8')) as {
      composition: Record<string, unknown>;
    };
    assert(
      !('mastering' in rawAuthored.composition),
      'an absent mastering block must not be default-injected into authored state',
    );
    const b0 = await buildProject(root);
    assert.equal(b0.status, 'succeeded');
    assert(
      !b0.operations.some(operation => operation.kind === 'master-audio'),
      'absent mastery must be a genuine no-op',
    );
    assert(!b0.artifacts.some(artifact => artifact.mastering), 'absent mastery must not stamp a mastering report');
    assert(!(await loadProject(root)).composition!.mastering, 'loading must not invent mastering defaults');
    const code0 = b0.operations.find(operation => operation.kind === 'browser')!;
    const compose0 = b0.operations.find(operation => operation.kind === 'compose-video')!;
    const mix0 = b0.operations.find(operation => operation.kind === 'mix-audio')!;
    const mixArtifact0 = b0.artifacts.find(artifact => artifact.id === mix0.artifact)!;
    const result0 = b0.result!.artifact;
    const take0 = b0.takes[0].id;
    const unmasteredResult = await readFile(join(root, '.viscraft/result.json'), 'utf8');
    assert.deepEqual(JSON.parse(unmasteredResult).artifact, result0);

    // --- Enable mastery: real mastered PCM ---
    const withMaster = await loadProject(root);
    withMaster.composition!.mastering = { targetLufs: -18, truePeakDbfs: -1 };
    await saveProject(root, withMaster, withMaster.revision);
    const b1 = await buildProject(root);
    const masterOp1 = b1.operations.find(operation => operation.kind === 'master-audio')!;
    assert.equal(masterOp1.reused, false, 'enabling mastery must actually run the master operation');
    assert.equal(
      b1.operations.find(operation => operation.kind === 'mux-final')!.reused,
      false,
      'the final mux must re-run on the new master',
    );
    for (const operation of [code0, compose0, mix0]) {
      const again = b1.operations.find(operation2 => operation2.id === operation.id)!;
      assert.equal(again.reused, true, `${operation.kind} must reuse when only mastering is added`);
    }
    assert.deepEqual(
      b1.takes.map(take => take.id),
      [take0],
      'Source/Take identities are unchanged by mastering',
    );
    const mixId1 = b1.operations.find(operation => operation.kind === 'mix-audio')!.artifact;
    assert.equal(mixId1, mix0.artifact, 'the original mix artifact identity is reused');

    const masterArtifact1 = b1.artifacts.find(artifact => artifact.id === masterOp1.artifact)!;
    assert.equal(masterArtifact1.kind, 'audio');
    assert.equal(masterArtifact1.simulated, false);
    const report1 = AudioMasteringReportSchema.parse(masterArtifact1.mastering);
    assert.equal(report1.method, 'two-pass-loudnorm');
    assert.deepEqual(report1.settings, { targetLufs: -18, truePeakDbfs: -1 });
    assert.equal(report1.dualMono, false);
    assert.equal(report1.loudnessRangeTarget, 50);
    assert(['linear', 'dynamic'].includes(report1.normalizationType));
    assert.equal(report1.output.samples, canonical, 'report records the exact canonical ceil span');
    assert.equal(report1.output.sampleRate, 48000);
    assert.equal(report1.output.channels, 2);
    assert(Math.abs(report1.output.integratedLufs - -18) <= 1, 'reported output loudness is near target');
    assert(report1.output.truePeakDbfs <= -1 + 0.2, 'reported output true peak respects the ceiling');

    const masterPath1 = join(root, masterArtifact1.path);
    const masterStream1 = await probeAudioStream(masterPath1);
    assert.deepEqual(
      masterStream1,
      { codec: 'pcm_s16le', sampleRate: 48000, channels: 2 },
      'mastered destination is real PCM16 at the target clock',
    );
    const decoded1 = await decodePcm(masterPath1, 2, 48000, root);
    assert.equal(decoded1.samples, canonical, 'mastered PCM contains exactly the canonical sample span');
    assert(decoded1.peak > 0.01, 'mastered PCM is non-silent');
    const measured1 = await measureLoudness(masterPath1);
    assert(
      Math.abs(measured1.integratedLufs - -18) <= 1.01,
      `independent loudness ${measured1.integratedLufs} must be near -18 LUFS`,
    );
    assert(
      measured1.truePeakDbfs <= -1 + 0.2,
      `independent true peak ${measured1.truePeakDbfs} must respect the ceiling`,
    );
    assert(
      Math.abs(measured1.integratedLufs - report1.output.integratedLufs) <= 0.5,
      'report and independent loudness agree',
    );
    assert(
      Math.abs(measured1.truePeakDbfs - report1.output.truePeakDbfs) <= 0.5,
      'report and independent true peak agree',
    );
    console.log(
      `[mastering] 48k/stereo target=${report1.settings.targetLufs} -> measured ${measured1.integratedLufs} LUFS / ${measured1.truePeakDbfs} dBTP; report ${report1.output.integratedLufs} LUFS / ${report1.output.truePeakDbfs} dBTP; ${report1.normalizationType}; samples ${report1.output.samples}`,
    );

    // The delivered intermediate is the mastered PCM; the delivered AAC is probed
    // separately as a real delivery container.
    const final1 = b1.artifacts.find(artifact => artifact.id === b1.result!.artifact)!;
    assert(!final1.mastering, 'the final muxed movie does not carry the intermediate mastering report');
    const delivered1 = await probeMedia(join(root, final1.path));
    assert(/h264|avc/i.test(delivered1.videoCodec), 'final delivery is H.264');
    assert.equal(delivered1.frames, totalFrames);
    assert(delivered1.audio, 'final delivery contains audio');
    assert.equal(delivered1.audio!.sampleRate, 48000);
    assert.equal(delivered1.audio!.channels, 2);
    assert(
      Math.abs(delivered1.audio!.duration - canonical / 48000) <= 1 / 48000,
      'delivered AAC covers the exact sample span',
    );

    // --- Change ONLY targetLufs: master + mux re-run, everything else reuses ---
    const retarget = await loadProject(root);
    retarget.composition!.mastering!.targetLufs = -22;
    await saveProject(root, retarget, retarget.revision);
    const b2 = await buildProject(root);
    const masterOp2 = b2.operations.find(operation => operation.kind === 'master-audio')!;
    assert.equal(masterOp2.reused, false, 'a target change must rerun mastering');
    assert.equal(
      b2.operations.find(operation => operation.kind === 'mux-final')!.reused,
      false,
      'a target change must rerun the final mux',
    );
    assert.notEqual(masterOp2.artifact, masterOp1.artifact, 'a new target produces a distinct master artifact');
    for (const kind of ['browser', 'compose-video', 'mix-audio']) {
      assert.equal(
        b2.operations.find(operation => operation.kind === kind)!.reused,
        true,
        `${kind} must reuse on a target-only change`,
      );
    }
    assert.equal(b2.operations.find(operation => operation.kind === 'mix-audio')!.artifact, mix0.artifact);
    assert.deepEqual(
      b2.takes.map(take => take.id),
      [take0],
    );
    const report2 = AudioMasteringReportSchema.parse(
      b2.artifacts.find(artifact => artifact.id === masterOp2.artifact)!.mastering,
    );
    assert.deepEqual(report2.settings, { targetLufs: -22, truePeakDbfs: -1 });
    assert.equal(report2.output.samples, canonical);
    const measured2 = await measureLoudness(
      join(root, b2.artifacts.find(artifact => artifact.id === masterOp2.artifact)!.path),
    );
    assert(
      Math.abs(measured2.integratedLufs - -22) <= 1.01,
      `retargeted loudness ${measured2.integratedLufs} must be near -22 LUFS`,
    );
    assert(Math.abs(measured2.integratedLufs - report2.output.integratedLufs) <= 0.5);
    console.log(
      `[mastering] target-only edit target=-22 -> measured ${measured2.integratedLufs} LUFS / ${measured2.truePeakDbfs} dBTP (report ${report2.output.integratedLufs})`,
    );

    // --- Delete mastery: the original unmastered Result/mux identity returns ---
    const deleted = await loadProject(root);
    delete deleted.composition!.mastering;
    await saveProject(root, deleted, deleted.revision);
    const b3 = await buildProject(root);
    assert(
      !b3.operations.some(operation => operation.kind === 'master-audio'),
      'deleting mastery must drop the master operation',
    );
    assert.equal(
      b3.operations.find(operation => operation.kind === 'mux-final')!.reused,
      true,
      'the original final mux must be reused',
    );
    assert.equal(b3.operations.find(operation => operation.kind === 'mix-audio')!.artifact, mix0.artifact);
    assert.equal(b3.result!.artifact, result0, 'deleting mastery restores the original unmastered Result identity');
    assert.equal(b3.result!.simulated, false);
    const restoredActive = JSON.parse(await readFile(join(root, '.viscraft/result.json'), 'utf8')) as {
      artifact: string;
      path: string;
      sha256: string;
      simulated: boolean;
    };
    const originalActive = JSON.parse(unmasteredResult) as {
      artifact: string;
      path: string;
      sha256: string;
      simulated: boolean;
    };
    assert.deepEqual(
      {
        artifact: restoredActive.artifact,
        path: restoredActive.path,
        sha256: restoredActive.sha256,
        simulated: restoredActive.simulated,
      },
      {
        artifact: originalActive.artifact,
        path: originalActive.path,
        sha256: originalActive.sha256,
        simulated: originalActive.simulated,
      },
      'the active Result returns to the exact unmastered artifact/path/hash',
    );

    // --- Re-enable the same target: the earlier mastered identity is reused ---
    const again = await loadProject(root);
    again.composition!.mastering = { targetLufs: -18, truePeakDbfs: -1 };
    await saveProject(root, again, again.revision);
    const b4 = await buildProject(root);
    assert.equal(
      b4.operations.find(operation => operation.kind === 'master-audio')!.reused,
      true,
      'a previously measured target reuses its master',
    );
    assert.equal(b4.operations.find(operation => operation.kind === 'master-audio')!.artifact, masterOp1.artifact);
    assert.equal(b4.operations.find(operation => operation.kind === 'mux-final')!.reused, true);
    assert.equal(
      b4.result!.artifact,
      b1.result!.artifact,
      're-enabling the same target reproduces the mastered Result identity',
    );

    // --- Portable export reopens with all reuse + persisted report/bytes ---
    const portable = await exportProject(root, exported);
    const manifest = JSON.parse(await readFile(join(exported, '.viscraft', 'portable-manifest.json'), 'utf8')) as {
      artifacts: string[];
      files: Array<{ path: string; sha256: string }>;
    };
    assert.equal(portable.simulated, false);
    for (const artifact of [final1.id, masterOp1.artifact, mix0.artifact, compose0.artifact, code0.artifact]) {
      assert(manifest.artifacts.includes(artifact), `portable package must carry dependency artifact ${artifact}`);
    }
    const manifestPaths = new Map(manifest.files.map(file => [file.path, file.sha256] as const));
    for (const artifact of [masterArtifact1, mixArtifact0, final1]) {
      assert.equal(
        manifestPaths.get(artifact.path),
        artifact.sha256,
        `packaged bytes for ${artifact.id} are hash-pinned`,
      );
      assert.equal(
        await hashFile(join(exported, artifact.path)),
        artifact.sha256,
        `exported ${artifact.id} bytes match the recorded hash`,
      );
    }
    const reopened = await buildProject(exported);
    assert(
      reopened.operations.every(operation => operation.reused),
      'the exported project must reuse every operation within this runtime',
    );
    const reopenedMaster = reopened.operations.find(operation => operation.kind === 'master-audio')!;
    assert.equal(reopenedMaster.reused, true);
    const reopenedArtifact = reopened.artifacts.find(artifact => artifact.id === reopenedMaster.artifact)!;
    const reopenedReport = AudioMasteringReportSchema.parse(reopenedArtifact.mastering);
    assert.deepEqual(
      reopenedReport.settings,
      { targetLufs: -18, truePeakDbfs: -1 },
      'the persisted mastering settings survive portability',
    );
    assert.equal(reopenedReport.output.samples, canonical, 'the persisted mastering measurement survives portability');
    assert.equal(
      await hashFile(join(exported, reopenedArtifact.path)),
      reopenedArtifact.sha256,
      'the reopened master bytes are intact',
    );
    assert.deepEqual(
      (await loadProject(exported)).composition!.mastering,
      { targetLufs: -18, truePeakDbfs: -1 },
      'authored mastering state survives portability',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(exported, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Failure before mastery preserves the active Result
// ---------------------------------------------------------------------------

test('an overloaded mix fails before mastering and preserves the previous active Result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-master-overload-'));
  try {
    await writeFile(join(root, 'scene.html'), PAGE);
    const totalFrames = 132;
    const canonical = framesToSamples(totalFrames, FPS30, 48000, 'ceil');
    const assets = await writeScore(root, canonical);
    await writeFile(
      join(root, 'project.json'),
      JSON.stringify(validateProject(audioProject(totalFrames, canonical, undefined, assets))),
    );
    const clean = await buildProject(root);
    assert.equal(clean.status, 'succeeded');
    const active = await readFile(join(root, '.viscraft/result.json'), 'utf8');

    // Add a second pair of full-gain identical signal clips while enabling
    // mastery: the mix itself overloads, so mastering must never be reached.
    const overloaded = await loadProject(root);
    overloaded.composition!.mastering = { targetLufs: -18, truePeakDbfs: -1 };
    overloaded.composition!.audio = [
      {
        id: 'hotA',
        kind: 'asset',
        asset: 'signalA',
        inSample: 0,
        startSample: 0,
        durationSamples: canonical,
        gain: 1,
        fadeInSamples: 0,
        fadeOutSamples: 0,
      },
      {
        id: 'hotB',
        kind: 'asset',
        asset: 'signalA',
        inSample: 0,
        startSample: 0,
        durationSamples: canonical,
        gain: 1,
        fadeInSamples: 0,
        fadeOutSamples: 0,
      },
    ];
    await saveProject(root, overloaded, overloaded.revision);

    await assert.rejects(buildProject(root), /overloaded|lower clip gains/);
    assert.equal(
      await readFile(join(root, '.viscraft/result.json'), 'utf8'),
      active,
      'a failed build must not replace the active Result',
    );

    const history = await readBuilds(root);
    const last = history.find(build => build.status === 'failed');
    assert(last, 'the overloaded build must be recorded as failed');
    assert(
      !last.operations.some(operation => operation.kind === 'master-audio'),
      'mastering must not run when the mix overloads',
    );
    assert(
      !last.artifacts.some(artifact => artifact.mastering),
      'no mastered artifact may be produced for an overloaded mix',
    );
    assert.equal(last.result, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. NTSC 30000/1001 at 44.1 kHz mono uses the canonical ceil span
// ---------------------------------------------------------------------------

test('NTSC 30000/1001 44.1 kHz mono mastering uses the exact canonical ceil sample span', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-master-ntsc-'));
  try {
    const fps = { numerator: 30000, denominator: 1001 };
    const totalFrames = 120;
    const canonical = framesToSamples(totalFrames, fps, 44100, 'ceil');
    assert.equal(canonical, 176577, 'NTSC 44.1 kHz canonical span requires ceil, not floor/nearest');
    assert.equal(framesToSamples(totalFrames, fps, 44100, 'floor'), 176576);
    assert.equal(framesToSamples(totalFrames, fps, 44100, 'nearest'), 176576);

    await runCommand('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-filter_threads',
      '1',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=64x48:rate=30000/1001:duration=4.2`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-threads',
      '2',
      join(root, 'flat.mp4'),
    ]);
    const signal = await writeSignalAsset(root, {
      id: 'signal',
      path: 'signal.wav',
      sampleRate: 44100,
      channels: 1,
      samples: canonical,
      frequency: 330,
    });
    const project: Project = {
      schemaVersion: 1,
      id: 'ntsc-master',
      revision: 1,
      title: 'NTSC mono mastering',
      soundTargets: [],
      direction: {
        intent: '44.1 kHz mono finishing at NTSC rate',
        looks: [{ id: 'look', description: 'identity' }],
        transitions: [],
      },
      assets: [
        {
          id: 'flat',
          revision: 1,
          path: 'flat.mp4',
          sha256: await hashFile(join(root, 'flat.mp4')),
          type: 'video',
          rights: { origin: 'Original FFmpeg fixture', license: 'CC0-1.0', redistributable: true },
          simulated: false,
        },
        signal,
      ],
      bindings: {},
      sources: [],
      composition: {
        output: { width: 64, height: 48, fps, sampleRate: 44100, channels: 1 },
        scenes: [{ id: 'scene', description: 'NTSC mono' }],
        shots: [
          { id: 'shot', scene: 'scene', look: 'look', intent: 'Flat media at NTSC rate', targetFrames: totalFrames },
        ],
        placements: [
          {
            id: 'edit',
            shot: 'shot',
            asset: 'flat',
            inFrame: 0,
            outFrame: totalFrames,
            startFrame: 0,
            audio: 'mute',
          },
        ],
        transitions: [],
        audio: [
          {
            id: 'signal',
            kind: 'asset',
            asset: 'signal',
            inSample: 0,
            startSample: 0,
            durationSamples: canonical,
            gain: 0.25,
            fadeInSamples: 1000,
            fadeOutSamples: 1000,
          },
        ],
        mastering: { targetLufs: -20, truePeakDbfs: -1 },
      },
      imageDocuments: [],
      imageTargets: [],
    };
    await writeFile(join(root, 'project.json'), JSON.stringify(validateProject(project)));

    const build = await buildProject(root);
    assert.equal(build.status, 'succeeded');
    const masterOp = build.operations.find(operation => operation.kind === 'master-audio')!;
    const masterArtifact = build.artifacts.find(artifact => artifact.id === masterOp.artifact)!;
    const report = AudioMasteringReportSchema.parse(masterArtifact.mastering);
    assert.equal(report.output.samples, canonical, 'mastering records the exact NTSC ceil span');
    assert.equal(report.output.sampleRate, 44100);
    assert.equal(report.output.channels, 1);
    const stream = await probeAudioStream(join(root, masterArtifact.path));
    assert.deepEqual(
      stream,
      { codec: 'pcm_s16le', sampleRate: 44100, channels: 1 },
      'loudnorm output is resampled back to 44.1 kHz mono PCM16',
    );
    const decoded = await decodePcm(join(root, masterArtifact.path), 1, 44100, root);
    assert.equal(decoded.samples, canonical, 'resampled back PCM has exactly the canonical sample count');
    assert(decoded.peak > 0.01, 'resampled back PCM is non-silent');
    const measured = await measureLoudness(join(root, masterArtifact.path));
    assert(
      Math.abs(measured.integratedLufs - -20) <= 1.01,
      `NTSC mono loudness ${measured.integratedLufs} must be near -20 LUFS`,
    );
    assert(measured.truePeakDbfs <= -1 + 0.2);
    assert(Math.abs(measured.integratedLufs - report.output.integratedLufs) <= 0.5);
    console.log(
      `[mastering] NTSC 30000/1001 44.1k mono target=-20 -> measured ${measured.integratedLufs} LUFS / ${measured.truePeakDbfs} dBTP; canonical samples ${canonical}`,
    );

    const final = build.artifacts.find(artifact => artifact.id === build.result!.artifact)!;
    const delivered = await probeMedia(join(root, final.path));
    assert.equal(delivered.frames, totalFrames);
    assert.equal(delivered.audio!.sampleRate, 44100);
    assert.equal(delivered.audio!.channels, 1);
    assert(Math.abs(delivered.audio!.duration - canonical / 44100) <= 1 / 44100);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. Simulated work: mastering depends on sound only and propagates simulated
// ---------------------------------------------------------------------------

test('mastering a simulated work depends on the sound artifact only and propagates simulated provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-master-sim-'));
  try {
    const totalFrames = 132;
    const canonical = framesToSamples(totalFrames, FPS30, 48000, 'ceil');
    const signalA = await writeSignalAsset(root, {
      id: 'signalA',
      path: 'signalA.wav',
      sampleRate: 48000,
      channels: 2,
      samples: canonical,
      frequency: 180,
    });
    const signalB = await writeSignalAsset(root, {
      id: 'signalB',
      path: 'signalB.wav',
      sampleRate: 48000,
      channels: 2,
      samples: canonical,
      frequency: 360,
    });
    const project: Project = {
      schemaVersion: 1,
      id: 'sim-master',
      revision: 1,
      title: 'Simulated picture, real measured sound',
      soundTargets: [],
      direction: {
        intent: 'Test-only picture with original measured signal score',
        looks: [{ id: 'look', description: 'identity' }],
        transitions: [],
      },
      assets: [signalA, signalB],
      bindings: {},
      sources: [
        {
          id: 'gen',
          kind: 'simulated',
          prompt: 'test-only picture for measured mastering',
          frames: totalFrames,
          seed: 5,
          attempt: 'attempt-audio-master',
          behavior: 'success',
        },
      ],
      composition: {
        output: { width: 64, height: 48, fps: FPS30, sampleRate: 48000, channels: 2 },
        scenes: [{ id: 'scene', description: 'Simulated' }],
        shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: 'Simulated picture', targetFrames: totalFrames }],
        placements: [
          { id: 'edit', shot: 'shot', source: 'gen', inFrame: 0, outFrame: totalFrames, startFrame: 0, audio: 'mute' },
        ],
        transitions: [],
        audio: [
          {
            id: 'signalA',
            kind: 'asset',
            asset: 'signalA',
            inSample: 0,
            startSample: 0,
            durationSamples: canonical,
            gain: 0.22,
            fadeInSamples: 4800,
            fadeOutSamples: 4800,
          },
          {
            id: 'signalB',
            kind: 'asset',
            asset: 'signalB',
            inSample: 0,
            startSample: 0,
            durationSamples: canonical,
            gain: 0.12,
            fadeInSamples: 4800,
            fadeOutSamples: 4800,
          },
        ],
        mastering: { targetLufs: -18, truePeakDbfs: -1 },
      },
      imageDocuments: [],
      imageTargets: [],
    };
    await writeFile(join(root, 'project.json'), JSON.stringify(validateProject(project)));

    const build = await buildProject(root);
    assert.equal(build.status, 'succeeded');
    for (const kind of ['simulated', 'mix-audio', 'master-audio', 'mux-final']) {
      assert(
        build.operations.some(operation => operation.kind === kind),
        `expected a ${kind} operation`,
      );
    }
    const mixOp = build.operations.find(operation => operation.kind === 'mix-audio')!;
    const masterOp = build.operations.find(operation => operation.kind === 'master-audio')!;
    const mixArtifact = build.artifacts.find(artifact => artifact.id === mixOp.artifact)!;
    const masterArtifact = build.artifacts.find(artifact => artifact.id === masterOp.artifact)!;
    assert.equal(mixArtifact.simulated, false, 'the original signal score is real, not simulated');
    // The master's simulated provenance is derived from its *sound* dependency
    // only — never from the test-only picture — so a real score stays real.
    assert.equal(
      masterArtifact.simulated,
      mixArtifact.simulated,
      'master simulated provenance must follow the sound dependency only',
    );
    assert.deepEqual(masterArtifact.inputs, [mixOp.artifact], 'the master depends on the sound artifact only');
    assert.equal(masterArtifact.generation, undefined, 'mastering must not fabricate provider generation provenance');
    assert(!masterArtifact.path.endsWith('.mp4'), 'the master is a sound artifact');
    // No network: the test-only picture is rendered locally and mastering is a
    // local FFmpeg measurement.
    const generated = build.artifacts.find(artifact => artifact.operation === 'simulated')!;
    assert.equal(
      generated.backend,
      'ffmpeg-simulated/test-only',
      'the simulated picture is rendered locally by FFmpeg, not a network provider',
    );
    assert.equal(masterArtifact.backend, build.environment!.ffmpeg, 'mastering is a local FFmpeg measurement');
    const report = AudioMasteringReportSchema.parse(masterArtifact.mastering);
    assert.equal(report.output.samples, canonical);
    const measured = await measureLoudness(join(root, masterArtifact.path));
    assert(
      Math.abs(measured.integratedLufs - -18) <= 1.01,
      'simulated work is mastered on its real score, not a placeholder',
    );
    assert(Math.abs(measured.integratedLufs - report.output.integratedLufs) <= 0.5);
    console.log(
      `[mastering] simulated picture + real signal target=-18 -> measured ${measured.integratedLufs} LUFS; master.simulated=${masterArtifact.simulated}, final.simulated=true`,
    );

    const final = build.artifacts.find(artifact => artifact.id === build.result!.artifact)!;
    assert.equal(final.simulated, true, 'simulated provenance propagates to the final movie');
    assert.equal(build.result!.simulated, true);
    const delivered = await probeMedia(join(root, final.path));
    assert(delivered.audio, 'the simulated delivery carries the mastered score');
    assert.equal(delivered.audio!.sampleRate, 48000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
