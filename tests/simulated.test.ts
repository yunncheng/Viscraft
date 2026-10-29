import { createSymlinkFixture } from './fs-fixtures.js';
/**
 * Simulated Provider contract tests.
 *
 * These tests exercise the real control chain: they drive the provider through
 * its four deterministic behaviours and assert on the persisted job records
 * under `.viscraft/jobs/` with Source-scoped attempt names. Media assertions use a real FFmpeg
 * render and a real probe, so a passing run means actual H.264 files were
 * produced — not just type-checked stubs.
 *
 * They also assert the two high-risk submission and recovery invariants:
 *  - an unknown submit is never auto-resubmitted (recovered by idempotency key);
 *  - a failed download resumes without regenerating.
 */

import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { OutputSettings, SimulatedSource } from '../src/core/schema.js';
import {
  generateSimulated,
  simulatedStatus,
  simulationCapabilities,
  simulatedJobPath,
} from '../src/backends/providers/simulated.js';
import { probeMedia } from '../src/backends/media/probe.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';

const OUTPUT: OutputSettings = {
  width: 160,
  height: 90,
  fps: { numerator: 30, denominator: 1 },
  sampleRate: 48000,
  channels: 1,
};

function source(
  attempt: string,
  behavior: SimulatedSource['behavior'],
  frames = 60,
  prompt = 'a red rally car drifting through a mountain pass',
): SimulatedSource {
  return { id: `s_${attempt}`, kind: 'simulated', prompt, frames, seed: 7, attempt, behavior };
}

async function readJob(root: string, attempt: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(simulatedJobPath(root, `s_${attempt}`, attempt), 'utf8')) as Record<string, unknown>;
}

/** Deterministic fingerprint of a media file's first decoded frame, for pixel comparison. */
async function firstFrameFingerprint(file: string): Promise<string> {
  return runCommand('ffmpeg', ['-v', 'error', '-threads', '2', '-i', file, '-frames:v', '1', '-f', 'framemd5', '-']);
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-provider-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('capabilities mark the provider as simulated / test-only', () => {
  assert.equal(simulationCapabilities.simulated, true);
  assert.equal(simulationCapabilities.testOnly, true);
  assert.equal(simulationCapabilities.generativeModel, false);
  assert.deepEqual([...simulationCapabilities.durationsSeconds], [2, 4, 6]);
});

test('absolute destinations accept a project directory alias but reject links inside it', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-provider-alias-'));
  try {
    const physical = join(parent, 'physical');
    const alias = join(parent, 'alias');
    await mkdir(physical);
    if (!(await createSymlinkFixture(t, physical, alias))) return;
    const destination = join(alias, 'build', 'take.mp4');
    await generateSimulated(alias, source('alias', 'success'), OUTPUT, destination);
    assert.equal((await probeMedia(destination)).frames, 60);
    if (!(await createSymlinkFixture(t, join(physical, 'build'), join(physical, 'linked')))) return;
    await assert.rejects(
      generateSimulated(alias, source('linked', 'success'), OUTPUT, join(alias, 'linked', 'take.mp4')),
      /Symbolic links/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('success produces probeable H.264 media and freezes the job record', async () => {
  await withRoot(async root => {
    const result = await generateSimulated(root, source('att_ok', 'success', 60), OUTPUT, 'build/take.mp4');
    assert.equal(result.backend, 'ffmpeg-simulated');

    const dest = join(root, 'build', 'take.mp4');
    assert.ok(existsSync(dest), 'destination media should exist');
    const info = await probeMedia(dest);
    assert.match(info.videoCodec, /h264/i);
    assert.equal(info.width, OUTPUT.width);
    assert.equal(info.height, OUTPUT.height);
    assert.equal(info.frames, 60, '2s @ 30fps -> 60 frames');

    const job = await readJob(root, 'att_ok');
    assert.equal(job.state, 'succeeded');
    assert.equal(job.submitted, 1);
    assert.equal(job.simulated, true);
    assert.equal(job.tierSeconds, 2);
    assert.equal(job.generatedFrames, 60);
    assert.equal(job.artifactPath, 'build/take.mp4', 'artifactPath must be stored project-relative');
    assert.equal(typeof job.artifactSha256, 'string');
  });
});

test('requested frame count is mapped onto the fixed 2/4/6s tiers via fps', async () => {
  await withRoot(async root => {
    // 3s requested -> next tier is 4s -> 120 frames @ 30fps.
    await generateSimulated(root, source('att_tier3', 'success', 90), OUTPUT, 'build/t3.mp4');
    const info3 = await probeMedia(join(root, 'build', 't3.mp4'));
    assert.equal(info3.frames, 120);
    assert.equal((await readJob(root, 'att_tier3')).tierSeconds, 4);

    // 5s requested -> capped tier 6s -> 180 frames @ 30fps.
    await generateSimulated(root, source('att_tier5', 'success', 150), OUTPUT, 'build/t5.mp4');
    const info5 = await probeMedia(join(root, 'build', 't5.mp4'));
    assert.equal(info5.frames, 180);
    assert.equal((await readJob(root, 'att_tier5')).tierSeconds, 6);

    // 1s requested -> minimum tier 2s -> 60 frames @ 30fps.
    await generateSimulated(root, source('att_tier1', 'success', 30), OUTPUT, 'build/t1.mp4');
    assert.equal((await probeMedia(join(root, 'build', 't1.mp4'))).frames, 60);
    assert.equal((await readJob(root, 'att_tier1')).tierSeconds, 2);
  });
});

test('raw prompt and secret-like tokens are never persisted; only a hash is', async () => {
  await withRoot(async root => {
    const secret = 'sk-live-DEADBEEF-not-a-real-key';
    const prompt = `cinematic chase, Authorization: Bearer ${secret}`;
    await generateSimulated(root, source('att_secret', 'success', 60, prompt), OUTPUT, 'build/secret.mp4');

    const raw = await readFile(simulatedJobPath(root, 's_att_secret', 'att_secret'), 'utf8');
    assert.ok(!raw.includes(secret), 'job record must not contain the secret token');
    assert.ok(!raw.includes(prompt), 'job record must not contain the raw prompt');
    const job = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(typeof job.promptHash, 'string');
    assert.equal(typeof job.requestHash, 'string');
  });
});

test('fail reaches a permanent failed state without auto-resubmitting', async () => {
  await withRoot(async root => {
    await assert.rejects(
      () => generateSimulated(root, source('att_fail', 'fail'), OUTPUT, 'build/fail.mp4'),
      /failed/i,
    );
    const first = await readJob(root, 'att_fail');
    assert.equal(first.state, 'failed');
    assert.equal(first.submitted, 1);
    assert.ok(!existsSync(join(root, 'build', 'fail.mp4')), 'no media should be produced on failure');

    await assert.rejects(
      () => generateSimulated(root, source('att_fail', 'fail'), OUTPUT, 'build/fail.mp4'),
      /not resubmitting|previously reached/i,
    );
    const second = await readJob(root, 'att_fail');
    assert.equal(second.submitted, 1, 'a known failure must not trigger another submit');
  });
});

test('submit-unknown is never auto-resubmitted and is recovered by idempotency key', async () => {
  await withRoot(async root => {
    await assert.rejects(
      () => generateSimulated(root, source('att_unknown', 'submit-unknown'), OUTPUT, 'build/u.mp4'),
      /unknown/i,
    );
    const unknown = await readJob(root, 'att_unknown');
    assert.equal(unknown.state, 'submit-unknown');
    assert.equal(unknown.submitted, 1, 'the remote submit happened exactly once');

    // Second call reconciles via the idempotency key: no new submit, media is produced.
    const result = await generateSimulated(root, source('att_unknown', 'submit-unknown'), OUTPUT, 'build/u.mp4');
    assert.equal(result.backend, 'ffmpeg-simulated');
    const recovered = await readJob(root, 'att_unknown');
    assert.equal(recovered.state, 'succeeded');
    assert.equal(recovered.submitted, 1, 'recovery must not submit again');
    assert.equal(recovered.reconciled, true);
    assert.ok(existsSync(join(root, 'build', 'u.mp4')));
    assert.equal((await probeMedia(join(root, 'build', 'u.mp4'))).frames, 60);
  });
});

test('download-fail-once throws after remote completion, then resumes without resubmitting', async () => {
  await withRoot(async root => {
    await assert.rejects(
      () => generateSimulated(root, source('att_dl', 'download-fail-once'), OUTPUT, 'build/dl.mp4'),
      /download failed/i,
    );
    const afterFirst = await readJob(root, 'att_dl');
    assert.equal(afterFirst.state, 'download-failed');
    assert.equal(afterFirst.submitted, 1);
    assert.equal(typeof afterFirst.jobId, 'string', 'remote job id was recorded before the download failure');
    assert.ok(!existsSync(join(root, 'build', 'dl.mp4')));

    await generateSimulated(root, source('att_dl', 'download-fail-once'), OUTPUT, 'build/dl.mp4');
    const afterSecond = await readJob(root, 'att_dl');
    assert.equal(afterSecond.state, 'succeeded');
    assert.equal(afterSecond.submitted, 1, 'resuming the download must not submit again');
    assert.equal((await probeMedia(join(root, 'build', 'dl.mp4'))).frames, 60);
  });
});

test('a succeeded job restores its real media to a different destination without resubmitting', async () => {
  await withRoot(async root => {
    await generateSimulated(root, source('att_restore', 'success', 60), OUTPUT, 'build/a.mp4');
    const a = await readFile(join(root, 'build', 'a.mp4'));

    const result = await generateSimulated(root, source('att_restore', 'success', 60), OUTPUT, 'exports/b.mp4');
    assert.equal(result.backend, 'ffmpeg-simulated');
    assert.ok(existsSync(join(root, 'exports', 'b.mp4')));
    const b = await readFile(join(root, 'exports', 'b.mp4'));
    assert.deepEqual(b, a, 'restored media must be byte-identical to the original artifact');

    const job = await readJob(root, 'att_restore');
    assert.equal(job.submitted, 1, 'restoring to a new destination must not resubmit');
    assert.equal(job.artifactPath, 'build/a.mp4', 'restoring must not rewrite the registered artifact identity');
  });
});

test('reusing an attempt id with changed parameters is rejected instead of overwriting', async () => {
  await withRoot(async root => {
    await generateSimulated(root, source('att_conflict', 'success', 60), OUTPUT, 'build/c.mp4');
    await assert.rejects(
      () => generateSimulated(root, source('att_conflict', 'success', 120), OUTPUT, 'build/c2.mp4'),
      /different frozen request|new attempt/i,
    );
    // Frozen record is untouched.
    const job = await readJob(root, 'att_conflict');
    assert.equal(job.generatedFrames, 60);
    assert.equal(job.submitted, 1);
  });
});

test('rendered media is visibly labelled, not a bare test pattern', async () => {
  await withRoot(async root => {
    await generateSimulated(root, source('att_label', 'success', 60), OUTPUT, 'build/label.mp4');
    const labelled = await firstFrameFingerprint(join(root, 'build', 'label.mp4'));

    const bare = join(root, 'bare.mp4');
    await runCommand('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-threads',
      '2',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x90:rate=30/1:duration=2',
      '-frames:v',
      '60',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      bare,
    ]);
    assert.notEqual(
      labelled,
      await firstFrameFingerprint(bare),
      'provider media must differ from a bare test pattern (overlay is baked in)',
    );
  });
});

test('simulatedStatus reports persisted jobs and no secrets', async () => {
  await withRoot(async root => {
    assert.deepEqual(await simulatedStatus(root), []);
    await generateSimulated(
      root,
      source('att_a', 'success', 60, 'prompt with token ghp_FAKE123456'),
      OUTPUT,
      'build/a.mp4',
    );
    await generateSimulated(root, source('att_b', 'success', 60), OUTPUT, 'build/b.mp4');
    const jobs = (await simulatedStatus(root)) as Array<Record<string, unknown>>;
    assert.equal(jobs.length, 2);
    assert.deepEqual(
      jobs.map(j => j.attempt),
      ['att_a', 'att_b'],
    );
    assert.ok(!JSON.stringify(jobs).includes('ghp_FAKE123456'));
  });
});

test('rejects destinations that escape the project root, allows absolute paths inside it', async () => {
  await withRoot(async root => {
    await assert.rejects(
      () => generateSimulated(root, source('att_esc1', 'success'), OUTPUT, '../escape.mp4'),
      /escapes|safe project-relative/i,
    );
    await assert.rejects(
      () => generateSimulated(root, source('att_esc2', 'success'), OUTPUT, join(root, '..', 'escape.mp4')),
      /escapes|safe project-relative/i,
    );
    assert.ok(!existsSync(join(root, '..', 'escape.mp4')));

    const inside = join(root, 'abs', 'take.mp4');
    const result = await generateSimulated(root, source('att_abs', 'success'), OUTPUT, inside);
    assert.equal(result.backend, 'ffmpeg-simulated');
    assert.ok(existsSync(inside));
    assert.equal(
      (await readJob(root, 'att_abs')).artifactPath,
      'abs/take.mp4',
      'absolute destination is stored project-relative',
    );
  });
});

test('a tampered artifactPath cannot read outside the root; media is re-materialized', async () => {
  await withRoot(async root => {
    await generateSimulated(root, source('att_tamper', 'success', 60), OUTPUT, 'build/x.mp4');

    const jobFile = simulatedJobPath(root, 's_att_tamper', 'att_tamper');
    const tampered = JSON.parse(await readFile(jobFile, 'utf8')) as Record<string, unknown>;
    tampered.artifactPath = '../../etc/passwd';
    await writeFile(jobFile, JSON.stringify(tampered, null, 2));
    await rm(join(root, '.viscraft', 'remote'), { recursive: true, force: true }); // force the recovery path

    await generateSimulated(root, source('att_tamper', 'success', 60), OUTPUT, 'build/x.mp4');
    const after = await readJob(root, 'att_tamper');
    assert.equal(after.state, 'succeeded');
    assert.equal(after.submitted, 1, 're-materializing must not submit again');
    assert.equal(after.artifactPath, 'build/x.mp4', 'unsafe path is rewritten to a safe relative path');
    assert.equal((await probeMedia(join(root, 'build', 'x.mp4'))).frames, 60);
  });
});

test('corrupt or mismatched media is not accepted as success', async () => {
  await withRoot(async root => {
    await generateSimulated(root, source('att_corrupt', 'success', 60), OUTPUT, 'build/y.mp4');

    const dest = join(root, 'build', 'y.mp4');
    // Replace the artifact with a valid-but-wrong-length video and make its hash match the record,
    // so only the strict frames/fps check can catch it.
    await runCommand('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-threads',
      '2',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x90:rate=30/1:duration=2',
      '-frames:v',
      '10',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      dest,
    ]);
    const jobFile = simulatedJobPath(root, 's_att_corrupt', 'att_corrupt');
    const job = JSON.parse(await readFile(jobFile, 'utf8')) as Record<string, unknown>;
    job.artifactSha256 = await hashFile(dest);
    await writeFile(jobFile, JSON.stringify(job, null, 2));
    await rm(join(root, '.viscraft', 'remote'), { recursive: true, force: true });

    await generateSimulated(root, source('att_corrupt', 'success', 60), OUTPUT, 'build/y.mp4');
    assert.equal((await probeMedia(dest)).frames, 60, 'the corrupt artifact must be replaced with correct media');
    const after = await readJob(root, 'att_corrupt');
    assert.equal(after.submitted, 1);
    assert.equal(after.state, 'succeeded');
  });
});

test('a lost artifact is re-materialized from the same remote job id without a new submit', async () => {
  await withRoot(async root => {
    await generateSimulated(root, source('att_relost', 'success', 60), OUTPUT, 'build/z.mp4');
    const before = await readJob(root, 'att_relost');
    const jobId = before.jobId;

    await rm(join(root, 'build', 'z.mp4'), { force: true });
    await rm(join(root, '.viscraft', 'remote'), { recursive: true, force: true });

    await generateSimulated(root, source('att_relost', 'success', 60), OUTPUT, 'build/z.mp4');
    const after = await readJob(root, 'att_relost');
    assert.equal(after.jobId, jobId, 'the same remote job id is reused');
    assert.equal(after.submitted, 1, 'no new submit');
    assert.equal(after.state, 'succeeded');
    assert.equal((await probeMedia(join(root, 'build', 'z.mp4'))).frames, 60);
  });
});

test('simulatedStatus refuses symlinked job records', async t => {
  await withRoot(async root => {
    await generateSimulated(root, source('att_real', 'success', 60), OUTPUT, 'build/real.mp4');
    await writeFile(join(root, 'decoy.json'), JSON.stringify({ attempt: 'att_real' }));
    if (!(await createSymlinkFixture(t, join(root, 'decoy.json'), join(root, '.viscraft', 'jobs', 'evil.json'))))
      return;

    const jobs = (await simulatedStatus(root)) as Array<Record<string, unknown>>;
    assert.deepEqual(
      jobs.map(j => j.attempt),
      ['att_real'],
      'a symlinked job record must be skipped, not followed',
    );
  });
});
