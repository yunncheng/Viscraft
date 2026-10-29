import { fileURLToPath } from 'node:url';
/**
 * `viscraft inspect` query contract.
 *
 * The by-id form returns
 * ONLY that Build record (the same bytes `.viscraft/builds/<id>.json` holds, which
 * already carry its Plan summary, diagnostics and artifact list); the no-id form
 * must return a Project summary plus a Build LIST, never the full records.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createProject } from '../src/project/create.js';
import { inspectProjectSummary, readBuild } from '../src/project/build-records.js';
import { runCommand } from '../src/shared/process.js';
import type { BuildRecord } from '../src/core/schema.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function buildRecord(id: string, startedAt: string): BuildRecord {
  return {
    schemaVersion: 1,
    id,
    run: { id: `run-${id}`, goal: `goal for ${id}` },
    plan: { operations: [`op-${id}-1`, `op-${id}-2`] },
    revision: 1,
    snapshotHash: 'a'.repeat(64),
    status: 'succeeded',
    medium: 'picture',
    startedAt,
    finishedAt: startedAt,
    operations: [],
    diagnostics: [{ operation: `op-${id}-1`, code: 'font-fallback', message: 'declared font unavailable', detail: {} }],
    artifacts: [],
    takes: [],
    result: { artifact: `artifact-${id}`, simulated: false },
  };
}

/** A minimal Project with two Build records and an active result. */
async function fixture(): Promise<{ root: string; first: BuildRecord; second: BuildRecord }> {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-inspect-'));
  await createProject(root, { title: 'Inspect fixture' });
  await mkdir(join(root, '.viscraft', 'builds'), { recursive: true });
  const first = buildRecord('build-inspect-1', '2026-02-01T00:00:00.000Z');
  const second = buildRecord('build-inspect-2', '2026-02-02T00:00:00.000Z');
  await writeFile(join(root, '.viscraft', 'builds', `${first.id}.json`), `${JSON.stringify(first, null, 2)}\n`);
  await writeFile(join(root, '.viscraft', 'builds', `${second.id}.json`), `${JSON.stringify(second, null, 2)}\n`);
  await writeFile(
    join(root, '.viscraft', 'result.json'),
    JSON.stringify({
      build: second.id,
      artifact: second.result!.artifact,
      path: '.viscraft/artifacts/x.mp4',
      sha256: 'b'.repeat(64),
      simulated: false,
    }),
  );
  return { root, first, second };
}

test('readBuild returns exactly the record `.viscraft/builds/<id>.json` holds', async () => {
  const { root, first } = await fixture();
  try {
    const record = await readBuild(root, first.id);
    const onDisk = JSON.parse(await readFile(join(root, '.viscraft', 'builds', `${first.id}.json`), 'utf8'));
    assert.deepEqual(record, onDisk);
    assert.deepEqual(record, first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readBuild fails loudly on an unknown or malformed build id', async () => {
  const { root } = await fixture();
  try {
    await assert.rejects(readBuild(root, 'build-missing'), /No Build record/);
    await assert.rejects(readBuild(root, 'nope'), /Not a Build id/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('inspectProjectSummary lists Builds WITHOUT dumping full records', async () => {
  const { root, second } = await fixture();
  try {
    const summary = await inspectProjectSummary(root);
    assert.equal(summary.project.title, 'Inspect fixture');
    assert.equal(summary.current, second.id, 'the active result Build is marked as current');
    assert.equal(summary.builds.length, 2);
    // Newest first.
    assert.equal(summary.builds[0].id, second.id);
    for (const build of summary.builds) {
      assert.equal(typeof build.artifacts, 'number', 'artifacts is a count, not the full list');
      assert.equal(typeof build.takes, 'number');
      assert.ok(!('operations' in build), 'no operation bodies are listed');
      assert.ok(!('plan' in build), 'no full Plan is listed');
      assert.ok(!('diagnostics' in build), 'no diagnostic bodies are listed');
    }
    assert.equal(summary.builds[0].current, true);
    assert.equal(summary.builds[1].current, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('inspectProjectSummary lists recorded deliveries (incl. an archive) without full bodies', async () => {
  const { root, second } = await fixture();
  try {
    await mkdir(join(root, '.viscraft', 'deliveries'), { recursive: true });
    await writeFile(
      join(root, '.viscraft', 'deliveries', 'handoff.json'),
      `${JSON.stringify({
        name: 'handoff',

        kind: 'deliver',
        build: second.id,
        revision: 1,
        deliveredAt: '2026-02-03T00:00:00.000Z',
        manifestSha256: 'c'.repeat(64),
      })}\n`,
    );
    await writeFile(
      join(root, '.viscraft', 'deliveries', 'project-x.tar.gz.json'),
      `${JSON.stringify({
        name: 'project-x.tar.gz',

        kind: 'archive',
        revision: 1,
        deliveredAt: '2026-02-04T00:00:00.000Z',
        manifestSha256: 'd'.repeat(64),
      })}\n`,
    );
    const summary = await inspectProjectSummary(root);
    // Newest first, and an archive is queryable here instead of from an exported copy.
    assert.deepEqual(
      summary.deliveries.map(delivery => [delivery.name, delivery.kind]),
      [
        ['project-x.tar.gz', 'archive'],
        ['handoff', 'deliver'],
      ],
    );
    const watch = summary.deliveries.find(delivery => delivery.name === 'handoff')!;
    assert.equal(watch.build, second.id);
    assert.equal(watch.manifestSha256, 'c'.repeat(64));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the CLI `inspect <project> <build-id>` prints only that record, matching the file', async () => {
  const { root, first } = await fixture();
  try {
    const stdout = await runCommand(process.execPath, [CLI, 'inspect', root, first.id]);
    const printed = JSON.parse(stdout);
    const onDisk = JSON.parse(await readFile(join(root, '.viscraft', 'builds', `${first.id}.json`), 'utf8'));
    assert.deepEqual(printed, onDisk, 'the by-id output matches .viscraft/builds/<id>.json');
    assert.deepEqual(printed.plan, first.plan, 'the Plan summary is included');
    assert.deepEqual(printed.diagnostics, first.diagnostics, 'diagnostics are included');
    assert.ok(Array.isArray(printed.artifacts), 'the artifact list is included');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the CLI `inspect <project>` prints a summary list without full records', async () => {
  const { root, second } = await fixture();
  try {
    const stdout = await runCommand(process.execPath, [CLI, 'inspect', root]);
    const printed = JSON.parse(stdout);
    assert.equal(printed.project.title, 'Inspect fixture');
    assert.equal(printed.current, second.id);
    assert.equal(printed.builds.length, 2);
    assert.ok(!('versions' in printed));
    for (const build of printed.builds) {
      // Counts, not the full arrays/bodies.
      assert.equal(typeof build.takes, 'number');
      assert.equal(typeof build.artifacts, 'number');
      assert.ok(!('plan' in build) && !('operations' in build) && !('diagnostics' in build));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the CLI `inspect` refuses an unknown build id', async () => {
  const { root } = await fixture();
  try {
    await assert.rejects(runCommand(process.execPath, [CLI, 'inspect', root, 'build-missing']), /No Build record/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
