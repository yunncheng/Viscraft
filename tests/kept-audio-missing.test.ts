// Kept-native-audio loudness and the per-Take audio review fact.
//
// A placement declaring `audio: 'keep'` requires an actual audio stream in
// the selected Take's file. The review and Build must expose that fact:
//
//  - a `keep` placement over a silent video Asset is refused by the Build BEFORE
//    any capture/POST, with the SAME `keep-audio-on-silent-asset` message the
//    Plan gives, and produces no result artifact;
//  - a `keep` placement whose existing Take's file has no audio stream fails the
//    Build with a loud, actionable message and produces no result artifact;
//  - the audio fact is probed from the file, not read from the recorded
//    `artifact.media`, which can be stale or forged in EITHER direction;
//  - a `keep` placement whose Take really carries audio still builds and still
//    emits exactly one `source-audio-trim` operation;
//  - `audio: 'mute'` on an audio-less source still builds (no regression);
//  - the review report states, per Take, whether its FILE carries audio
//    (`hasAudio`) as a plain fact, even when the record disagrees.

import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildProject } from '../src/build/build.js';
import { reviewBuild } from '../src/operations/analysis/review.js';
import { readBuilds } from '../src/project/build-records.js';
import { ProjectSchema, type Composition, type Placement, type Project } from '../src/core/schema.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { writeSignalAsset } from './audio-fixtures.js';

const OUT = { width: 64, height: 48, fps: { numerator: 25, denominator: 1 }, sampleRate: 48000, channels: 2 };
const FRAMES = 25; // one second at 25 fps

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'viscraft-kept-missing-'));
}

/** A 64x48, 25 fps, ~1s H.264 fixture; `withAudio` also muxes an AAC stereo tone. */
async function makeClip(dir: string, name: string, withAudio: boolean): Promise<string> {
  const out = join(dir, name);
  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-filter_threads',
    '1',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=64x48:rate=25:duration=1',
  ];
  if (withAudio)
    args.push(
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=1',
      '-c:a',
      'aac',
      '-ac',
      '2',
      '-shortest',
    );
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '2', out);
  await runCommand('ffmpeg', args);
  return out;
}

/** A validated Project with an audio-less and an audio-bearing media Source. */
function makeProject(
  silentSha: string,
  soundedSha: string,
  placements: Placement[],
  audio: Composition['audio'] = [],
  extraAssets: Project['assets'] = [],
): Project {
  const rights = { origin: 'original test fixture', license: 'original test media', redistributable: true };
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'kept_missing',
    revision: 1,
    title: 'Kept audio presence',
    direction: {
      intent: 'loud kept-audio handling',
      looks: [{ id: 'look', description: 'identity' }],
      transitions: [],
    },
    assets: [
      { id: 'silent', revision: 1, type: 'video', path: 'silent.mp4', sha256: silentSha, rights, simulated: false },
      { id: 'sounded', revision: 1, type: 'video', path: 'sounded.mp4', sha256: soundedSha, rights, simulated: false },
      ...extraAssets,
    ],
    bindings: {},
    sources: [],
    composition: {
      output: OUT,
      scenes: [{ id: 'scene', description: 'scene' }],
      shots: [
        { id: 'shot_silent', scene: 'scene', look: 'look', intent: 'silent', targetFrames: FRAMES },
        { id: 'shot_sounded', scene: 'scene', look: 'look', intent: 'sounded', targetFrames: FRAMES },
      ],
      placements,
      transitions: [],
      audio,
    },
  });
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await tempDir();
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function setup(root: string, placements: Placement[], audio: Composition['audio'] = []): Promise<void> {
  await makeClip(root, 'silent.mp4', false);
  await makeClip(root, 'sounded.mp4', true);
  await writeProject(root, placements, audio);
}

/** Rewrite `project.json` in place (revision stays 1) with a fresh placement set. */
async function writeProject(root: string, placements: Placement[], audio: Composition['audio'] = []): Promise<void> {
  const silentSha = await hashFile(join(root, 'silent.mp4'));
  const soundedSha = await hashFile(join(root, 'sounded.mp4'));
  const extraAssets: Project['assets'] = [];
  if (audio.some(clip => clip.kind === 'asset' && clip.asset === 'bedSignal'))
    extraAssets.push(
      await writeSignalAsset(root, {
        id: 'bedSignal',
        path: 'bed.wav',
        sampleRate: 48000,
        channels: 2,
        samples: 48000,
        frequency: 220,
      }),
    );
  await writeFile(
    join(root, 'project.json'),
    JSON.stringify(makeProject(silentSha, soundedSha, placements, audio, extraAssets), null, 2) + '\n',
    'utf8',
  );
}

/**
 * Forge the recorded media info of the artifact behind `takeId` in the build
 * record that contains it, so the record disagrees with the file bytes in a
 * chosen direction. This reproduces the independently-verified stale/forged
 * record scenario without touching the file itself.
 */
async function forgeTakeMedia(root: string, takeId: string, mode: 'remove-audio' | 'add-audio'): Promise<void> {
  const buildsDir = join(root, '.viscraft', 'builds');
  for (const file of (await readdir(buildsDir)).filter(name => name.endsWith('.json'))) {
    const path = join(buildsDir, file);
    const record = JSON.parse(await readFile(path, 'utf8')) as {
      takes?: Array<{ id: string; artifact: string }>;
      artifacts?: Array<{ id: string; media?: { duration: number; audio?: unknown } }>;
    };
    const take = record.takes?.find(entry => entry.id === takeId);
    if (!take) continue;
    const artifact = record.artifacts?.find(entry => entry.id === take.artifact);
    if (!artifact?.media) continue;
    if (mode === 'remove-audio') delete artifact.media.audio;
    else artifact.media.audio = { sampleRate: 48000, channels: 2, duration: artifact.media.duration };
    await writeFile(path, JSON.stringify(record, null, 2) + '\n', 'utf8');
    return;
  }
  throw new Error(`forgeTakeMedia: no build record contains Take ${takeId}`);
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

test('a keep placement over a silent video Asset is refused before any production and writes no result', async () => {
  await withRoot(async root => {
    await setup(root, [
      {
        id: 'pl_keep',
        shot: 'shot_silent',
        asset: 'silent',
        inFrame: 0,
        outFrame: 20,
        startFrame: 0,
        audio: 'keep',
      },
    ]);

    await assert.rejects(
      buildProject(root),
      /Placement pl_keep has audio "keep" but its video Asset silent has no audio stream; use audio "mute" or an Asset that carries audio\.$/,
      'a keep placement over a silent video Asset must fail with the shared, actionable message',
    );

    const failed = (await readBuilds(root)).find(build => build.status === 'failed');
    assert.ok(failed, 'the silent-keep build is recorded as failed');
    assert.equal(failed!.result, undefined, 'a failed build must not record a result artifact');
    assert.equal(
      await fileExists(join(root, '.viscraft', 'result.json')),
      false,
      'no active result is published for a failed build',
    );
    assert.equal(
      failed!.operations.length,
      0,
      'the silent-Asset keep is refused before any capture/encode operation is recorded',
    );
  });
});

test('a keep placement whose Take carries audio still builds and emits exactly one source-audio-trim', async () => {
  await withRoot(async root => {
    await setup(root, [
      {
        id: 'pl_keep',
        shot: 'shot_sounded',
        asset: 'sounded',
        inFrame: 0,
        outFrame: 20,
        startFrame: 0,
        audio: 'keep',
      },
    ]);

    const build = await buildProject(root);
    assert.equal(build.status, 'succeeded');
    assert.equal(
      build.operations.filter(operation => operation.kind === 'source-audio-trim').length,
      1,
      'exactly one kept-audio trim for one keep placement',
    );
    assert.ok(build.result, 'a succeeded build records its result');
  });
});

test('audio: "mute" on an audio-less source still builds', async () => {
  await withRoot(async root => {
    await setup(root, [
      {
        id: 'pl_mute',
        shot: 'shot_silent',
        asset: 'silent',
        inFrame: 0,
        outFrame: 20,
        startFrame: 0,
        audio: 'mute',
      },
    ]);

    const build = await buildProject(root);
    assert.equal(build.status, 'succeeded', 'a muted placement over a silent source must not regress');
    assert.equal(build.operations.filter(operation => operation.kind === 'source-audio-trim').length, 0);
  });
});

test('a keep over a silent video Asset is refused before the stem stage, even with a declared bus', async () => {
  await withRoot(async root => {
    await setup(root, [
      {
        id: 'pl_keep',
        shot: 'shot_silent',
        asset: 'silent',
        inFrame: 0,
        outFrame: 20,
        startFrame: 0,
        audio: 'keep',
        bus: 'dialogue',
      },
    ]);

    await assert.rejects(
      buildProject(root),
      /Placement pl_keep has audio "keep" but its video Asset silent has no audio stream; use audio "mute" or an Asset that carries audio\.$/,
      'the silent-Asset keep is refused with the shared message before any capture, not deferred to the stem stage',
    );

    const failed = (await readBuilds(root)).find(build => build.status === 'failed');
    assert.ok(failed, 'the silent-keep build is recorded as failed');
    assert.equal(failed!.operations.length, 0, 'nothing was produced before the refusal');
  });
});

test('a keep over a silent Take whose declared bus has another member is caught as a silent drop', async () => {
  await withRoot(async root => {
    // Produce a real, audio-less Take from the silent Asset. A `take:` origin is
    // used (not the Asset directly) so the silent-Asset early guard does not fire
    // and the LATE silent-drop guard is the one under test.
    await setup(root, [
      {
        id: 'pl_mute',
        shot: 'shot_silent',
        asset: 'silent',
        inFrame: 0,
        outFrame: 20,
        startFrame: 0,
        audio: 'mute',
      },
    ]);
    const first = await buildProject(root);
    const take = first.takes.find(entry => entry.asset === 'silent')!;

    // `keep` over the silent Take, routed to a bus that is NOT memberless because
    // a signal clip sits on the same bus. Without this guard the kept audio
    // vanishes with zero trims and the build "succeeds".
    await writeProject(
      root,
      [
        {
          id: 'pl_keep',
          shot: 'shot_silent',
          take: take.id,
          inFrame: 0,
          outFrame: 20,
          startFrame: 0,
          audio: 'keep',
          bus: 'dialogue',
        },
      ],
      [
        {
          id: 'bed',
          kind: 'asset',
          asset: 'bedSignal',
          inSample: 0,
          startSample: 0,
          durationSamples: 48000,
          gain: 0.2,
          fadeInSamples: 0,
          fadeOutSamples: 0,
          bus: 'dialogue',
        },
      ],
    );

    await assert.rejects(
      buildProject(root),
      /Placement pl_keep has audio "keep" but its source Take take-[0-9a-f]+ \(Asset silent\) declares no audio stream, so nothing was kept; use audio "mute" if the silence is intended, or select or produce a Take that carries audio$/,
      'a keep over an audio-less Take must fail even when its bus has another member',
    );

    const failed = (await readBuilds(root)).find(build => build.status === 'failed');
    assert.ok(failed, 'the silent-keep build is recorded as failed');
    assert.equal(failed!.result, undefined, 'a failed build must not record a result artifact');
    assert.equal(
      failed!.operations.filter(operation => operation.kind === 'source-audio-trim').length,
      0,
      'the silent kept audio must not be dropped with zero trims',
    );
  });
});

test('the keep guard probes the file, not a stale/forged recorded media fact (H1: file has audio, record claims none)', async () => {
  await withRoot(async root => {
    // Produce a real audio-bearing Take, then forge the record to claim it has no
    // audio. A record-trusting guard would WRONGLY BLOCK the author here.
    await setup(root, [
      {
        id: 'pl_mute',
        shot: 'shot_sounded',
        asset: 'sounded',
        inFrame: 0,
        outFrame: 20,
        startFrame: 0,
        audio: 'mute',
      },
    ]);
    const first = await buildProject(root);
    const take = first.takes.find(entry => entry.asset === 'sounded')!;
    await forgeTakeMedia(root, take.id, 'remove-audio');

    await writeProject(root, [
      { id: 'pl_keep', shot: 'shot_sounded', take: take.id, inFrame: 0, outFrame: 20, startFrame: 0, audio: 'keep' },
    ]);
    const build = await buildProject(root);
    assert.equal(build.status, 'succeeded', 'a real audio stream must not be blocked by a stale record');
    assert.equal(
      build.operations.filter(operation => operation.kind === 'source-audio-trim').length,
      1,
      'the real kept audio is trimmed exactly once',
    );
  });
});

test('the keep guard probes the file, not a stale/forged recorded media fact (H2: file is silent, record claims audio)', async () => {
  await withRoot(async root => {
    // Produce a video-only Take, then forge the record to CLAIM audio. A
    // record-trusting guard would let the build die later inside ffmpeg.
    await setup(root, [
      {
        id: 'pl_mute',
        shot: 'shot_silent',
        asset: 'silent',
        inFrame: 0,
        outFrame: 20,
        startFrame: 0,
        audio: 'mute',
      },
    ]);
    const first = await buildProject(root);
    const take = first.takes.find(entry => entry.asset === 'silent')!;
    await forgeTakeMedia(root, take.id, 'add-audio');

    await writeProject(root, [
      { id: 'pl_keep', shot: 'shot_silent', take: take.id, inFrame: 0, outFrame: 20, startFrame: 0, audio: 'keep' },
    ]);
    await assert.rejects(buildProject(root), (error: Error) => {
      assert.match(
        error.message,
        /declares no audio stream, so nothing was kept/,
        'the guard must fire from the probed file fact',
      );
      assert.doesNotMatch(
        error.message,
        /does not contain any stream/i,
        'the failure must not be an ffmpeg stream error',
      );
      return true;
    });
  });
});

test('the review report states hasAudio from the file, not from a stale/forged record', async () => {
  await withRoot(async root => {
    await setup(root, [
      {
        id: 'pl_silent',
        shot: 'shot_silent',
        asset: 'silent',
        inFrame: 0,
        outFrame: 20,
        startFrame: 0,
        audio: 'mute',
      },
      {
        id: 'pl_sounded',
        shot: 'shot_sounded',
        asset: 'sounded',
        inFrame: 0,
        outFrame: 5,
        startFrame: 20,
        audio: 'mute',
      },
    ]);
    const build = await buildProject(root);
    assert.equal(build.status, 'succeeded');
    const silentTake = build.takes.find(take => take.asset === 'silent')!;
    const soundedTake = build.takes.find(take => take.asset === 'sounded')!;

    // Forge BOTH directions: the sounded Take's record claims no audio, the silent
    // Take's record claims audio. The review must still report the file truth.
    await forgeTakeMedia(root, soundedTake.id, 'remove-audio');
    await forgeTakeMedia(root, silentTake.id, 'add-audio');

    const review = await reviewBuild(root, build.id);
    const report = JSON.parse(await readFile(join(root, review.report), 'utf8')) as {
      takes: Array<{
        id: string;
        source?: string;
        asset?: string;
        artifact: string;
        hasAudio: boolean;
        recorded: boolean;
      }>;
    };
    const byId = new Map(report.takes.map(take => [take.id, take]));
    assert.equal(
      byId.get(silentTake.id)!.hasAudio,
      false,
      'a video-only file reports hasAudio false despite a record that claims audio',
    );
    assert.equal(
      byId.get(soundedTake.id)!.hasAudio,
      true,
      'an audio-bearing file reports hasAudio true despite a record that claims none',
    );
    assert.equal(byId.get(silentTake.id)!.recorded, true, 'the artifact still carries recorded media info');
    assert.equal(byId.get(soundedTake.id)!.asset, 'sounded');
  });
});

test('review reports per-clip truncation and kept-audio extension facts without changing the render', async () => {
  await withRoot(async root => {
    await makeClip(root, 'sounded.mp4', true);
    // A real 5 s music asset, longer than the programme the project declares.
    await runCommand('ffmpeg', [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-loglevel',
      'error',
      '-threads',
      '2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=220:sample_rate=48000:duration=5',
      '-ac',
      '2',
      '-ar',
      '48000',
      '-c:a',
      'pcm_s16le',
      join(root, 'bed.wav'),
    ]);
    const soundedSha = await hashFile(join(root, 'sounded.mp4'));
    const bedSha = await hashFile(join(root, 'bed.wav'));
    const rights = { origin: 'original test fixture', license: 'original test media', redistributable: true };
    const project = ProjectSchema.parse({
      schemaVersion: 1,
      id: 'audio_facts',
      revision: 1,
      title: 'Audio facts',
      direction: { intent: 'facts', looks: [{ id: 'look', description: 'identity' }], transitions: [] },
      assets: [
        {
          id: 'sounded',
          revision: 1,
          type: 'video',
          path: 'sounded.mp4',
          sha256: soundedSha,
          rights,
          simulated: false,
        },
        { id: 'bed', revision: 1, type: 'audio', path: 'bed.wav', sha256: bedSha, rights, simulated: false },
      ],
      bindings: {},
      sources: [],
      composition: {
        output: OUT,
        scenes: [{ id: 'scene', description: 'scene' }],
        shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: 'facts', targetFrames: 20 }],
        // A keep placement whose declared L-cut tail runs well past the Take's own
        // 1 s of audio, plus a 5 s music clip in a 2.4 s programme.
        placements: [
          {
            id: 'pl_keep',
            shot: 'shot',
            asset: 'sounded',
            inFrame: 0,
            outFrame: 20,
            startFrame: 0,
            audio: 'keep',
            audioTailSamples: 48000,
          },
        ],
        transitions: [],
        audio: [
          {
            id: 'music',
            kind: 'asset',
            asset: 'bed',
            inSample: 0,
            startSample: 0,
            durationSamples: 240000,
            gain: 0.2,
            fadeInSamples: 0,
            fadeOutSamples: 0,
          },
        ],
        outputFrames: 60,
      },
    });
    await writeFile(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');

    const build = await buildProject(root);
    assert.equal(build.status, 'succeeded');

    const review = await reviewBuild(root, build.id);
    const report = JSON.parse(await readFile(join(root, review.report), 'utf8')) as {
      audio: {
        clips: Array<{
          id: string;
          kind: string;
          asset: string | null;
          assetSamples: number | null;
          usedSamples: number;
          truncatedByProgrammeEnd: boolean;
        }>;
      };
      keptAudio: Array<{
        placement: string;
        declaredTailSamples: number;
        tailOverrunSamples: number;
        takeAudioSamples: number;
        beyondTakeAudio: boolean;
      }>;
      limitations: string[];
    };

    const music = report.audio.clips.find(clip => clip.id === 'music')!;
    assert.equal(music.kind, 'asset');
    assert.equal(music.asset, 'bed');
    assert.ok(
      Math.abs(music.assetSamples! - 240000) <= 2400,
      `the asset's real duration is reported (got ${music.assetSamples})`,
    );
    assert.equal(music.usedSamples, 240000);
    assert.equal(
      music.truncatedByProgrammeEnd,
      true,
      'a 5 s music clip inside a 2.4 s programme is reported as truncated',
    );

    const kept = report.keptAudio.find(fact => fact.placement === 'pl_keep')!;
    assert.equal(kept.declaredTailSamples, 48000);
    assert.ok(kept.takeAudioSamples > 0, 'the Take audio duration is measured');
    assert.equal(kept.beyondTakeAudio, true, 'the declared tail reaches past the Take audio');
    assert.ok(kept.tailOverrunSamples > 0, `the shortfall is reported (got ${kept.tailOverrunSamples})`);
    assert.ok(report.limitations.some(line => /NO synthesized silence/i.test(line)));
  });
});
