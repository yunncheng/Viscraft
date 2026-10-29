import { createSymlinkFixture } from './fs-fixtures.js';
/**
 * one fixed default destination, recorded replace semantics, and
 * the report-only delivery-copy scan.
 *
 * Each test builds a real simulated project (so `deliverProject` runs the exact
 * production path) and exercises the DEFAULT destination under `output/`:
 * a repeat delivery replaces the previous one only when it is a recorded,
 * unmodified Runtime delivery, and a modified or foreign entry is refused.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { cpSync, existsSync, renameSync, unwatchFile, watchFile } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { buildProject } from '../src/build/build.js';
import { deliverProject } from '../src/operations/delivery/delivery.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { archiveProject } from '../src/operations/delivery/archive.js';
import { inspectOutputs } from '../src/project/output.js';
import { projectStatus } from '../src/project/status.js';
import { ProjectSchema, type Project } from '../src/core/schema.js';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-delivery-replace-'));
}

/** A minimal one-shot simulated project that produces a real, openable movie. */
function makeProject(handoff?: { path: string; role: 'readme' }, frames = 12): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'replace_test',
    revision: 1,
    title: 'Replace Test',
    direction: { intent: 'fixed-name delivery fixture', looks: [{ id: 'look', description: 'look' }], transitions: [] },
    assets: [],
    bindings: {},
    sources: [{ id: 'src', kind: 'simulated', prompt: 'a', frames, seed: 1, attempt: 'a1', behavior: 'success' }],
    composition: {
      output: { width: 64, height: 48, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene', description: 'scene' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: 'a', targetFrames: frames }],
      placements: [
        { id: 'pl', shot: 'shot', source: 'src', inFrame: 0, outFrame: frames, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio: [],
    },
    ...(handoff ? { handoff: [handoff] } : {}),
  });
}

async function writeAndBuild(root: string, project: Project): Promise<string> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(nodePath.join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  const record = await buildProject(root);
  assert.equal(record.status, 'succeeded');
  return record.id;
}

/** Top-level `output/` entries, excluding the Runtime-owned `.gitignore`. */
async function outputEntries(root: string): Promise<string[]> {
  const names = await fs.readdir(nodePath.join(root, 'output'));
  return names.filter(name => name !== '.gitignore').sort();
}

function manifest(absolute: string): Promise<{ build: { id: string }; diagnostics?: string[] }> {
  return fs.readFile(absolute, 'utf8').then(text => JSON.parse(text));
}

test('a repeat default delivery replaces the previous default, leaving exactly one entry', async () => {
  const parent = await tempDir();
  const root = nodePath.join(parent, 'work');
  try {
    const firstBuild = await writeAndBuild(root, makeProject());

    const first = await deliverProject(root, undefined, {});
    assert.equal(first.path, nodePath.join(root, 'output', 'handoff'), 'the default name is handoff');
    assert.equal((await manifest(first.path + '/delivery-manifest.json')).build.id, firstBuild);
    assert.deepEqual(await outputEntries(root), ['handoff']);

    // A new Build makes the previous delivery stale; the next delivery replaces it.
    const secondBuild = await writeAndBuild(root, makeProject());
    const second = await deliverProject(root, undefined, {});

    assert.equal(second.path, first.path, 'the same fixed name is reused');
    assert.notEqual(secondBuild, firstBuild, 'the fixture built a genuinely new Build');
    assert.equal(
      (await manifest(second.path + '/delivery-manifest.json')).build.id,
      secondBuild,
      'output/ holds the NEW version',
    );
    assert.deepEqual(await outputEntries(root), ['handoff'], 'only one delivery remains');

    // The delivery was recorded under .viscraft/deliveries/.
    const record = JSON.parse(
      await fs.readFile(nodePath.join(root, '.viscraft', 'deliveries', 'handoff.json'), 'utf8'),
    );
    assert.deepEqual(
      { name: record.name, kind: record.kind, build: record.build },
      { name: 'handoff', kind: 'deliver', build: secondBuild },
    );
    assert.match(record.deliveredAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(record.manifestSha256, /^[a-f0-9]{64}$/);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('a hand-modified delivery is refused for replacement and left intact', async () => {
  const parent = await tempDir();
  const root = nodePath.join(parent, 'work');
  try {
    await writeAndBuild(root, makeProject());
    await deliverProject(root, undefined, {});

    // A hand edit to the delivered manifest makes the record's hash stale.
    const deliveryManifest = nodePath.join(root, 'output', 'handoff', 'delivery-manifest.json');
    const edited = `${await fs.readFile(deliveryManifest, 'utf8')}   \n`;
    await fs.writeFile(deliveryManifest, edited);

    await writeAndBuild(root, makeProject());
    await assert.rejects(
      () => deliverProject(root, undefined, {}),
      (error: Error) => {
        assert.match(error.message, /already exists and has been modified/i);
        assert.match(
          error.message,
          /clean <project> --include output\/handoff/,
          'the refusal offers `clean --include`',
        );
        return true;
      },
    );
    // The author's modified copy is never destroyed.
    assert.equal(await fs.readFile(deliveryManifest, 'utf8'), edited);
    assert.deepEqual(await outputEntries(root), ['handoff']);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('a non-Runtime entry under a default name is refused, never deleted', async () => {
  const parent = await tempDir();
  const root = nodePath.join(parent, 'work');
  try {
    await writeAndBuild(root, makeProject());
    // An author-made directory occupies the fixed default name.
    const foreign = nodePath.join(root, 'output', 'handoff');
    await fs.mkdir(foreign, { recursive: true });
    await fs.writeFile(nodePath.join(foreign, 'keep.txt'), 'mine');

    await assert.rejects(
      () => deliverProject(root, undefined, {}),
      /already exists and is not a recorded Runtime delivery/,
    );
    assert.equal(await fs.readFile(nodePath.join(foreign, 'keep.txt'), 'utf8'), 'mine');
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('inspectOutputs and status report stale deliveries and unrecorded output entries', async () => {
  const parent = await tempDir();
  const root = nodePath.join(parent, 'work');
  try {
    const oldBuild = await writeAndBuild(root, makeProject());
    await deliverProject(root, undefined, {});

    // A newer Build supersedes the delivered one, and a manual copy appears.
    await writeAndBuild(root, makeProject());
    await fs.mkdir(nodePath.join(root, 'output', 'manual-copy'), { recursive: true });
    await fs.writeFile(nodePath.join(root, 'output', 'manual-copy', 'movie.mp4'), 'not from the Runtime');

    const { stale, unrecorded } = await inspectOutputs(root);
    assert.deepEqual(stale, [{ name: 'handoff', build: oldBuild, kind: 'deliver' }]);
    assert.deepEqual(unrecorded, ['manual-copy']);

    // A real status consumer surfaces the same report-only facts.
    const status = await projectStatus(root);
    assert.deepEqual(status.outputs, { stale, unrecorded });
    assert.ok(
      status.attention.some(item => /stale deliver/i.test(item.message)),
      'status calls out the stale delivery',
    );
    assert.ok(
      status.attention.some(item => /unrecorded output/i.test(item.message)),
      'status calls out the unrecorded entry',
    );
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('an interrupted default delivery leaves no entry, no record and no staging', async () => {
  const parent = await tempDir();
  const root = nodePath.join(parent, 'work');
  try {
    await writeAndBuild(root, makeProject());

    await assert.rejects(
      () => deliverProject(root, undefined, { playableSource: 'no-such-source' }),
      /unknown source/i,
    );

    assert.deepEqual(await outputEntries(root), [], 'no destination is created on failure');
    const leftovers = (await fs.readdir(nodePath.join(root, 'output'))).filter(name => name.startsWith('.handoff.'));
    assert.deepEqual(leftovers, [], 'private staging directories are removed on failure');
    assert.equal(
      await fs
        .stat(nodePath.join(root, '.viscraft', 'deliveries', 'handoff.json'))
        .then(() => true)
        .catch(() => false),
      false,
      'no delivery record is written for a failed delivery',
    );
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('the default handoff and its delivery record share one name', async () => {
  const parent = await tempDir();
  const root = nodePath.join(parent, 'work');
  try {
    await writeAndBuild(root, makeProject());
    const delivery = await deliverProject(root, undefined, {});
    assert.equal(delivery.path, nodePath.join(root, 'output', 'handoff'), 'delivery uses the handoff directory');
    assert.deepEqual(await outputEntries(root), ['handoff']);
    const record = JSON.parse(
      await fs.readFile(nodePath.join(root, '.viscraft', 'deliveries', 'handoff.json'), 'utf8'),
    );
    assert.deepEqual(
      { name: record.name, kind: record.kind },
      { name: 'handoff', kind: 'deliver' },
      'the record names the single handoff',
    );
    // The same repeat delivery still replaces in place.
    await writeAndBuild(root, makeProject());
    const again = await deliverProject(root, undefined, {});
    assert.equal(again.path, delivery.path);
    assert.deepEqual(await outputEntries(root), ['handoff']);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('an edited editable member is refused even when the recorded manifest is unchanged', async () => {
  const parent = await tempDir();
  const root = nodePath.join(parent, 'work');
  try {
    await writeAndBuild(root, makeProject());
    const first = await deliverProject(root, undefined, {});
    // Edit the bundled EDITABLE current project; its delivery-manifest hash is untouched.
    const bundledProject = nodePath.join(first.path, 'project', 'project.json');
    const edited = `${await fs.readFile(bundledProject, 'utf8')} `;
    await fs.writeFile(bundledProject, edited);

    await writeAndBuild(root, makeProject());
    await assert.rejects(() => deliverProject(root, undefined, {}), /already exists and has been modified/i);
    assert.equal(await fs.readFile(bundledProject, 'utf8'), edited, 'the edited copy is preserved');
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('a package swapped DURING production for another self-consistent one is refused at the final check', async () => {
  const parent = await tempDir();
  const root = nodePath.join(parent, 'work');
  const other = nodePath.join(parent, 'other');
  const watched = nodePath.join(root, 'output');
  let swapped = false;
  const swap = (): void => {
    if (swapped) return;
    const target = nodePath.join(root, 'output', 'handoff');
    if (!existsSync(target)) return;
    swapped = true;
    const aside = `${target}.swapped-aside`;
    renameSync(target, aside);
    cpSync(otherDeliveryPath, target, { recursive: true });
  };
  let otherDeliveryPath = '';
  try {
    // A larger package widens the staging window so the mid-production swap
    // reliably lands after the INITIAL check but before the final one.
    await writeAndBuild(root, makeProject(undefined, 144));
    await deliverProject(root, undefined, {});

    // A genuinely DIFFERENT, self-consistent delivery package (its own project and
    // record). It passes `verifyDelivery`, so only a re-comparison against the
    // ORIGINAL recorded hash can tell it apart from the recorded delivery.
    await writeAndBuild(other, makeProject(undefined, 144));
    otherDeliveryPath = (await deliverProject(other, undefined, {})).path;

    // Supersede the delivered Build so the next delivery is replaceable, then swap
    // the existing default for the other valid package the instant the new
    // delivery begins staging — i.e. after its INITIAL check has already passed.
    // Polling (not a native watch) is used so a low inotify limit cannot fail it.
    await writeAndBuild(root, makeProject(undefined, 144));
    watchFile(watched, { interval: 5 }, swap);

    await assert.rejects(
      () => deliverProject(root, undefined, {}),
      /already exists and has been modified/i,
      'the final pre-swap check must re-compare against the recorded hash, not merely re-verify the package',
    );
    assert.ok(swapped, 'the swap happened during production, so the FINAL check (not the initial one) refused');
    // The swapped-in package is preserved, never overwritten.
    assert.ok(existsSync(nodePath.join(root, 'output', 'handoff', 'delivery-manifest.json')));
  } finally {
    unwatchFile(watched, swap);
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('a default export is refused when a member is edited, added, removed or replaced by a symlink', async t => {
  const parent = await tempDir();
  try {
    const mutate = async (label: string, action: (dir: string) => Promise<void>): Promise<void> => {
      const root = nodePath.join(parent, label);
      await writeAndBuild(root, makeProject());
      await exportProject(root);
      await action(nodePath.join(root, 'output', 'project'));
      await assert.rejects(
        () => exportProject(root),
        /already exists and has been modified/i,
        `${label}: unmodified manifest must not excuse member ${label}`,
      );
    };
    await mutate('edited', dir => fs.writeFile(nodePath.join(dir, 'project.json'), '{ "edited": true }\n'));
    await mutate('added', dir => fs.writeFile(nodePath.join(dir, 'extra.txt'), 'not in the manifest\n'));
    await mutate('removed', async dir => fs.rm(nodePath.join(dir, '.viscraft', 'pages', 'VISCRAFT.md')));
    await t.test('symlinked member is refused', async t => {
      await mutate('symlinked', async dir => {
        const target = nodePath.join(dir, 'project.json');
        const swapped = `${target}.swapped`;
        await fs.rename(target, swapped);
        if (!(await createSymlinkFixture(t, swapped, target))) return;
      });
    });
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('a dev-machine absolute path in handoff text is reported; a clean delivery has none', async () => {
  const parent = await tempDir();
  const dirtyRoot = nodePath.join(parent, 'dirty');
  const cleanRoot = nodePath.join(parent, 'clean');
  try {
    // The README is real handoff text and mentions this machine's Project root.
    await fs.mkdir(dirtyRoot, { recursive: true });
    const dirtyRootReal = await fs.realpath(dirtyRoot);
    await fs.writeFile(
      nodePath.join(dirtyRoot, 'README.md'),
      `Run the local CLI at ${dirtyRootReal}/dist/src/cli.js\n`,
    );
    await writeAndBuild(dirtyRoot, makeProject({ path: 'README.md', role: 'readme' }));

    const dirty = await deliverProject(dirtyRoot, undefined, {});
    assert.ok(dirty.diagnostics.length > 0, 'the local absolute path is reported');
    assert.ok(
      dirty.diagnostics.some(item => item.includes('project/README.md') && item.includes(dirtyRootReal)),
      dirty.diagnostics.join('\n'),
    );
    const dirtyManifest = await manifest(nodePath.join(dirty.path, 'delivery-manifest.json'));
    assert.deepEqual(dirtyManifest.diagnostics, dirty.diagnostics, 'findings are written into the manifest');
    // The delivery still completed with the handoff file present.
    assert.ok(
      await fs
        .stat(nodePath.join(dirty.path, 'project', 'README.md'))
        .then(() => true)
        .catch(() => false),
    );

    await fs.mkdir(cleanRoot, { recursive: true });
    await fs.writeFile(
      nodePath.join(cleanRoot, 'README.md'),
      'License: https://opensource.org/license/mit/\nSource: https://example.org/art\n',
    );
    await writeAndBuild(cleanRoot, makeProject({ path: 'README.md', role: 'readme' }));
    const clean = await deliverProject(cleanRoot, undefined, {});
    assert.deepEqual(clean.diagnostics, [], 'a clean delivery reports no diagnostics');
    assert.deepEqual((await manifest(nodePath.join(clean.path, 'delivery-manifest.json'))).diagnostics, []);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('a malformed result.json never makes inspectOutputs or status throw', async () => {
  const parent = await tempDir();
  const root = nodePath.join(parent, 'work');
  try {
    const build = await writeAndBuild(root, makeProject());
    await deliverProject(root, undefined, {});

    // A corrupt active result must be a reported fact, not a crash: with no
    // readable current result, the delivered Build is reported as stale.
    await fs.writeFile(nodePath.join(root, '.viscraft', 'result.json'), '{ not valid json');
    const { stale, unrecorded } = await inspectOutputs(root);
    assert.deepEqual(stale, [{ name: 'handoff', build, kind: 'deliver' }]);
    assert.deepEqual(unrecorded, []);
    await projectStatus(root); // must not throw
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('default export and archive replace in place, including a split archive', async () => {
  const parent = await tempDir();
  const root = nodePath.join(parent, 'work');
  const splitRoot = nodePath.join(parent, 'split');
  try {
    await writeAndBuild(root, makeProject());

    const export1 = await exportProject(root);
    assert.equal(export1.path, nodePath.join(root, 'output', 'project'));
    const export2 = await exportProject(root);
    assert.equal(export2.path, export1.path, 'the same fixed export name is reused');
    assert.ok((await outputEntries(root)).includes('project'));

    const archive1 = await archiveProject(root);
    assert.equal(archive1.path, nodePath.join(root, 'output', 'replace_test.tar.gz'));
    const archive2 = await archiveProject(root);
    assert.equal(archive2.path, archive1.path, 'the same fixed archive name is reused');
    assert.deepEqual(
      (await outputEntries(root)).filter(name => name.startsWith('replace_test.tar.gz')),
      ['replace_test.tar.gz'],
      'exactly one single-file archive remains',
    );

    // A split archive uses the same stem with `.part-NNN` + `.parts.json`.
    await writeAndBuild(splitRoot, makeProject());
    const split1 = await archiveProject(splitRoot, undefined, { partSize: 4096 });
    assert.equal(split1.path, nodePath.join(splitRoot, 'output', 'replace_test.tar.gz.parts.json'));
    const split2 = await archiveProject(splitRoot, undefined, { partSize: 4096 });
    assert.equal(split2.path, split1.path, 'the split archive replaces in place');
    assert.deepEqual(
      await outputEntries(splitRoot),
      split2.parts!.map(part => part.name).concat('replace_test.tar.gz.parts.json'),
    );

    const { stale, unrecorded } = await inspectOutputs(splitRoot);
    assert.deepEqual(stale, [], 'these kinds carry no Build, so nothing is stale');
    assert.deepEqual(unrecorded, [], 'every output/ entry is accounted for');

    // An archive writes a live-queryable record (kind archive, sha256, produced path).
    const nonSplitRecord = JSON.parse(
      await fs.readFile(nodePath.join(root, '.viscraft', 'deliveries', 'replace_test.tar.gz.json'), 'utf8'),
    );
    assert.deepEqual(
      { kind: nonSplitRecord.kind, path: nonSplitRecord.path },
      { kind: 'archive', path: undefined },
      'a single-file archive records the stem name, no separate path',
    );
    assert.match(nonSplitRecord.manifestSha256, /^[a-f0-9]{64}$/);
    const splitRecord = JSON.parse(
      await fs.readFile(nodePath.join(splitRoot, '.viscraft', 'deliveries', 'replace_test.tar.gz.json'), 'utf8'),
    );
    assert.deepEqual(
      { kind: splitRecord.kind, path: splitRecord.path, sha: splitRecord.manifestSha256 },
      { kind: 'archive', path: 'replace_test.tar.gz.parts.json', sha: split2.sha256 },
    );
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
