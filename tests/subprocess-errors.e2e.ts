// finite child termination, and the kept-audio side-effect
// is covered by `detectRepeatedFrames` exercising the specialized runner.
//
// A command we spawn must *always* settle: a timeout (or a stdout overflow)
// sends SIGTERM, then SIGKILL after a FINITE grace, closes stdio, and is
// reported as a FAILURE — never a false success, even if the process later
// exits 0. Crucially, an ffmpeg-like child that ignores SIGTERM and never exits
// must still settle within grace + epsilon instead of hanging forever.
//
// Fixtures are tiny inline Node scripts (no third-party media); the analysis
// entrypoint fixture is a locally encoded lavfi clip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { runCommand } from '../src/shared/process.js';
import { detectRepeatedFrames, reviewBuild } from '../src/operations/analysis/review.js';
import { buildProject } from '../src/build/build.js';
import { hashFile } from '../src/shared/hash.js';
import { ProjectSchema } from '../src/core/schema.js';
import type { Project } from '../src/core/schema.js';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-fixture-process-'));
}

/** Run an inline Node child script as if it were the spawned command. */
function runChild(script: string, extraArgs: string[], timeoutMs: number, killGraceMs: number): Promise<string> {
  return runCommand(process.execPath, ['-e', script, ...extraArgs], { timeoutMs, killGraceMs });
}

/** Poll until `pid` is gone (kill(pid, 0) throws), or give up after ~2 s. */
async function waitForDeath(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return false;
}

test('a normal child exits 0 and resolves with its stdout', async () => {
  const out = await runChild('process.stdout.write("hello")', [], 5_000, 200);
  assert.equal(out, 'hello');
});

test('a responsive timeout fails fast (SIGTERM handler exits 0 → still a failure)', async () => {
  // The child exits 0 when it sees SIGTERM. The elapsed deadline still makes
  // the operation a timeout failure, regardless of that exit code.
  const script = 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);';
  const started = Date.now();
  await assert.rejects(runChild(script, [], 200, 400), /timed out after 200ms/);
  assert.ok(Date.now() - started < 1_500, 'a responsive child must fail fast, not wait out the grace');
});

test('an ignoring child that later exits 0 must FAIL, not succeed', async () => {
  // Ignores SIGTERM, then would exit 0 after 1.5 s. SIGKILL after the finite
  // grace kills it first; even if it somehow reached its own exit 0, the
  // `timedOut` guard forbids reporting success.
  const script = 'process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), 1500);';
  const started = Date.now();
  await assert.rejects(runChild(script, [], 200, 300), /timed out after 200ms/);
  assert.ok(Date.now() - started < 1_450, "SIGKILL must beat the child's own delayed exit 0");
});

test('a child that ignores SIGTERM and never exits still settles (grace + ε) and is reclaimed', async t => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const pidFile = nodePath.join(dir, 'pid');
  const script =
    'require("fs").writeFileSync(process.argv[1], String(process.pid));' +
    'process.on("SIGTERM", () => {});' +
    'setInterval(() => {}, 1000);';
  const started = Date.now();
  await assert.rejects(runChild(script, [pidFile], 200, 300), /timed out after 200ms/);
  // 200 ms timeout + 300 ms grace + a generous epsilon: it never hangs.
  assert.ok(Date.now() - started < 2_000, 'a signal-ignoring child must settle within grace + ε');
  const pid = Number((await fs.readFile(pidFile, 'utf8')).trim());
  assert.ok(await waitForDeath(pid), `child pid ${pid} must be reclaimed (SIGKILL), not left running`);
});

test('a stdout-overflow child fails, is reclaimed, and is never a success', async t => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const pidFile = nodePath.join(dir, 'pid');
  // Floods stdout past the 16 MB cap, ignores SIGTERM, and would exit 0 after
  // 5 s. The overflow must terminate + fail well before that.
  const script =
    'require("fs").writeFileSync(process.argv[1], String(process.pid));' +
    'process.on("SIGTERM", () => {});' +
    'const chunk = Buffer.alloc(1024 * 1024, 97);' +
    'for (let i = 0; i < 40; i++) process.stdout.write(chunk);' +
    'setTimeout(() => process.exit(0), 5000);';
  const started = Date.now();
  await assert.rejects(runChild(script, [pidFile], 30_000, 400), /produced more than 16000000 bytes of stdout/);
  assert.ok(Date.now() - started < 4_000, 'the overflow child must be killed, not waited out');
  const pid = Number((await fs.readFile(pidFile, 'utf8')).trim());
  assert.ok(await waitForDeath(pid), `overflow child pid ${pid} must be reclaimed`);
});

test('the real repeated-frame analysis entrypoint still runs on a decoded clip', async t => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const encode = async (name: string, source: string): Promise<{ file: string; frames: number }> => {
    const file = nodePath.join(dir, name);
    await runCommand('ffmpeg', [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      source,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      file,
    ]);
    const counted = await runCommand('ffprobe', [
      '-v',
      'error',
      '-count_frames',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=nb_read_frames',
      '-of',
      'default=nokey=1:noprint_wrappers=1',
      file,
    ]);
    return { file, frames: Number(counted.trim()) };
  };

  // A fully static picture is one held span; a moving testsrc has none. Both
  // decode every frame (the runner throws on a frame-count mismatch).
  const still = await encode('still.mp4', 'color=c=black:s=64x48:r=5:d=2');
  assert.ok(still.frames >= 2, 'fixture must carry several frames');
  const held = await detectRepeatedFrames(still.file, still.frames);
  assert.equal(held.analysedFrames, still.frames);
  assert.equal(held.spanCount, 1);
  assert.equal(held.repeatedFrames, still.frames - 1);

  const moving = await encode('moving.mp4', 'testsrc=size=64x48:rate=5:duration=2');
  const fresh = await detectRepeatedFrames(moving.file, moving.frames);
  assert.equal(fresh.analysedFrames, moving.frames);
  assert.equal(fresh.spanCount, 0);
});

test('kept-audio J/L-cut handles use the ORIGINAL Take artifact + inFrame, not the retimed picture length', async () => {
  const dir = await tempDir();
  try {
    // A one-second Take carrying real picture + audio (25 frames @ 25 fps / 48 kHz).
    const video = nodePath.join(dir, 'clip.mp4');
    await runCommand('ffmpeg', [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-loglevel',
      'error',
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
    const project: Project = ProjectSchema.parse({
      schemaVersion: 1,
      id: 'retime_keep_review',
      revision: 1,
      title: 'Retime keep review',
      direction: { intent: 'retime keep', looks: [{ id: 'look', description: 'as captured' }], transitions: [] },
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
        shots: [
          { id: 'shot_head', scene: 'scene', look: 'look', intent: 'programme head', targetFrames: 5 },
          { id: 'shot', scene: 'scene', look: 'look', intent: 'retime', targetFrames: 30 },
          { id: 'tail_shot', scene: 'scene', look: 'look', intent: 'programme tail', targetFrames: 5 },
        ],
        placements: [
          // A mute head so the timeline starts at 0.
          {
            id: 'pl_head',
            shot: 'shot_head',
            asset: 'asset_clip',
            inFrame: 0,
            outFrame: 5,
            startFrame: 0,
            audio: 'mute',
          },
          // Source range 5..20 (15 frames) is retimed to a 30-frame picture body,
          // with a J-cut lead of 4800 samples and an L-cut tail of 4800. The kept
          // audio handles are the ORIGINAL Take over 5..20; the handle clock must
          // ignore `durationFrames` (the retimed PICTURE length).
          {
            id: 'pl_retimed',
            shot: 'shot',
            asset: 'asset_clip',
            inFrame: 5,
            outFrame: 20,
            durationFrames: 30,
            startFrame: 5,
            audio: 'keep',
            audioLeadSamples: 4800,
            audioTailSamples: 4800,
          },
          // A silent trailing placement only lengthens the programme so the
          // declared tail has room under either build-trim shape.
          {
            id: 'pl_tail',
            shot: 'tail_shot',
            asset: 'asset_clip',
            inFrame: 0,
            outFrame: 5,
            startFrame: 35,
            audio: 'mute',
          },
        ],
        transitions: [],
        audio: [],
      },
    });
    await fs.writeFile(nodePath.join(dir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');

    const build = await buildProject(dir);
    assert.equal(build.status, 'succeeded', 'the retimed keep fixture must build');
    const review = await reviewBuild(dir);
    const report = JSON.parse(await fs.readFile(nodePath.join(dir, review.report), 'utf8')) as {
      keptAudio: Array<Record<string, number | boolean>>;
    };
    assert.equal(report.keptAudio.length, 1, 'one kept placement declares handles');
    const fact = report.keptAudio[0]!;

    // 25 fps / 48 kHz -> 1920 samples per frame.
    assert.equal(fact.takeInSample, 5 * 1920, 'the handle origin is the placement ORIGINAL inFrame');
    assert.equal(fact.requestedStartSample, 5 * 1920 - 4800, 'the J-cut leads the original inFrame by the lead');
    // Body = ORIGINAL source range 20-5 = 15 frames (28800 samples), NOT the
    // retimed 30-frame picture length (which would give 9600 + 57600 + 4800).
    assert.equal(
      fact.requestedEndSample,
      5 * 1920 + (20 - 5) * 1920 + 4800,
      'the body span must come from the original range, regardless of the retime',
    );
    assert.equal(
      fact.tailOverrunSamples,
      Math.max(0, (fact.requestedEndSample as number) - (fact.takeAudioSamples as number)),
      'the reported shortfall must be measured against the real Take audio',
    );
    assert.ok((fact.takeAudioSamples as number) > 40_000, 'the Take really carries ~1 s of audio');
    assert.equal(fact.beyondTakeAudio, false, 'a 4800-sample tail stays inside the real Take audio');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
