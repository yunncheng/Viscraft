// Two DIFFERENT Sources that both use the same `attempt` id must each complete
// independently. The job record, per-attempt lock and retained provider media are
// keyed by the Source-scoped `attemptStem` (`<sourceId>.<attempt>`), so the second
// Source cannot collide with the first Source's frozen request.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateSimulated, simulatedStatus, simulatedJobPath } from '../src/backends/providers/simulated.js';
import type { OutputSettings } from '../src/core/schema.js';

const OUTPUT: OutputSettings = {
  width: 64,
  height: 48,
  fps: { numerator: 24, denominator: 1 },
  sampleRate: 48000,
  channels: 2,
};
const source = (id: string, attempt: string) => ({
  id,
  kind: 'simulated' as const,
  prompt: `prompt for ${id}`,
  frames: 24,
  seed: 0,
  attempt,
  behavior: 'success' as const,
});

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-attempt-namespace-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('two simulated Sources sharing attempt "33" both complete with distinct, Source-scoped job records', async () => {
  await withRoot(async root => {
    await generateSimulated(root, source('shot_a', '33'), OUTPUT, 'build/a.mp4');
    await generateSimulated(root, source('shot_b', '33'), OUTPUT, 'build/b.mp4');

    assert.ok(existsSync(simulatedJobPath(root, 'shot_a', '33')), 'shot_a has its own Source-scoped job record');
    assert.ok(existsSync(simulatedJobPath(root, 'shot_b', '33')), 'shot_b has its own Source-scoped job record');
    assert.ok(
      existsSync(join(root, 'build', 'a.mp4')) && existsSync(join(root, 'build', 'b.mp4')),
      'both artifacts were produced',
    );

    const jobs = (await simulatedStatus(root)) as Array<{ sourceId: string; attempt: string; state: string }>;
    assert.equal(jobs.length, 2, 'both jobs are persisted independently');
    assert.deepEqual(
      jobs.map(job => job.attempt),
      ['33', '33'],
    );
    assert.deepEqual([...new Set(jobs.map(job => job.sourceId))].sort(), ['shot_a', 'shot_b']);
    assert.ok(jobs.every(job => job.state === 'succeeded'));
  });
});

test('re-running the SAME Source/attempt is idempotent (no second job, no new remote submit)', async () => {
  await withRoot(async root => {
    await generateSimulated(root, source('shot_a', '33'), OUTPUT, 'build/a.mp4');
    const before = (await simulatedStatus(root)) as Array<{ submitted: number }>;
    await generateSimulated(root, source('shot_a', '33'), OUTPUT, 'build/a.mp4');
    const after = (await simulatedStatus(root)) as Array<{ submitted: number }>;
    assert.equal(after.length, 1, 'the same Source/attempt keeps one job record');
    assert.deepEqual(
      after.map(job => job.submitted),
      before.map(job => job.submitted),
      'a re-run does not resubmit',
    );
  });
});
