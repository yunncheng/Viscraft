/**
 * Delivery publication, archive ownership and media-release recovery. Durable
 * recovery relations precede deletion; exported files retain roles and rights.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildProject } from '../src/build/build.js';
import { archiveProject, restoreProject, setArchiveStepHookForTest } from '../src/operations/delivery/archive.js';
import { deliverProject } from '../src/operations/delivery/delivery.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { exportPlayable } from '../src/operations/delivery/playable-export.js';
import { servePlayable } from '../src/backends/playable/playable-server.js';
import { markDeliveryPending } from '../src/project/output.js';
import { releaseArchived, restoreMedia, setReleaseStepHookForTest } from '../src/project/release.js';
import { readBuilds } from '../src/project/build-records.js';
import { planClean } from '../src/project/clean.js';
import { hashFile } from '../src/shared/hash.js';
import { validateProject } from '../src/project/project.js';
import { framesToSamples } from '../src/core/time.js';
import type { Asset, BuildRecord, Project } from '../src/core/schema.js';
import { writeSignalAsset } from './audio-fixtures.js';

const FPS30 = { numerator: 30, denominator: 1 };
const OUTPUT = { width: 64, height: 48, fps: FPS30, sampleRate: 48000, channels: 2 } as const;
const TOTAL_FRAMES = 30; // 1 s at 30 fps
const TOTAL_SAMPLES = framesToSamples(TOTAL_FRAMES, FPS30, 48000, 'ceil');
const PRIVATE = { origin: 'test', license: 'UNKNOWN', redistributable: false } as const;

async function tmp(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'viscraft-p0deliv-'));
}
async function exists(file: string): Promise<boolean> {
  return lstat(file)
    .then(() => true)
    .catch(() => false);
}
async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** A minimal one-shot simulated-source project (FFmpeg only, no browser/provider). */
function simProject(overrides: Partial<Project> = {}): Project {
  return validateProject({
    schemaVersion: 1,
    id: 'fixture-delivery-sim',
    revision: 1,
    title: 'delivery (simulated)',
    direction: { intent: '', looks: [{ id: 'look', description: '' }], transitions: [] },
    assets: [],
    bindings: {},
    sources: [
      {
        id: 'sim',
        kind: 'simulated',
        prompt: 'SIMULATED flat picture',
        frames: TOTAL_FRAMES,
        seed: 1,
        attempt: 'attempt-shot',
        behavior: 'success',
      },
    ],
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: '' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: '', targetFrames: TOTAL_FRAMES }],
      placements: [
        { id: 'edit', shot: 'shot', source: 'sim', inFrame: 0, outFrame: TOTAL_FRAMES, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio: [],
    },
    ...overrides,
  });
}

/** A minimal browser picture Source project (no build required). */
function codeProject(options: {
  entry: string;
  resources: string[];
  assets?: Asset[];
  handoff?: Project['handoff'];
}): Project {
  return validateProject({
    schemaVersion: 1,
    id: 'fixture-delivery-code',
    revision: 1,
    title: 'delivery (code)',
    direction: { intent: '', looks: [{ id: 'look', description: '' }], transitions: [] },
    assets: options.assets ?? [],
    bindings: {},
    sources: [
      {
        id: 'src',
        kind: 'browser',
        output: 'picture',
        entry: options.entry,
        resources: options.resources,
        bindings: [],
        params: {},
        seed: 0,
        frames: 1,
      },
    ],
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: '' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: '', targetFrames: 1 }],
      placements: [{ id: 'edit', shot: 'shot', source: 'src', inFrame: 0, outFrame: 1, startFrame: 0, audio: 'mute' }],
      transitions: [],
      audio: [],
    },
    ...(options.handoff ? { handoff: options.handoff } : {}),
  });
}

async function simRoot(): Promise<{ root: string; build: BuildRecord }> {
  const root = await tmp();
  await writeJson(path.join(root, 'project.json'), simProject());
  const build = await buildProject(root);
  assert.equal(build.status, 'succeeded', 'simulated build must succeed');
  return { root, build };
}

function resultArtifact(build: BuildRecord): BuildRecord['artifacts'][number] {
  const id = build.result?.artifact;
  assert.ok(id, 'build must record a result artifact');
  const artifact = build.artifacts.find(candidate => candidate.id === id);
  assert.ok(artifact, 'result artifact must be present');
  return artifact;
}

// ---------------------------------------------------------------------------
// releaseArchived: the archived mark is durable before any unlink
// ---------------------------------------------------------------------------

test('release-archived persists the recovery mark before freeing bytes, so a crash leaves the media restorable', async () => {
  const { root, build } = await simRoot();
  const parent = path.dirname(root);
  const archive = path.join(parent, 'release.tar.gz');
  try {
    const artifact = resultArtifact(build);
    const artifactFile = path.join(root, ...artifact.path.split('/'));
    assert.equal(await hashFile(artifactFile), artifact.sha256, 'the artifact bytes are present before release');
    await archiveProject(root, archive);

    // Crash EXACTLY after the marks are durable and before the first unlink.
    setReleaseStepHookForTest(step => {
      if (step === 'marks-persisted') throw new Error('simulated crash after marks-persisted');
    });
    await assert.rejects(releaseArchived(root, archive, [artifact.id]), /simulated crash after marks-persisted/);
    setReleaseStepHookForTest(undefined);

    // The bytes were NOT freed: the recovery relation is durable and truthful.
    assert.ok(await exists(artifactFile), 'the media must not be deleted before the archived mark is durable');
    assert.equal(await hashFile(artifactFile), artifact.sha256, 'the media bytes are untouched');
    const marked = (await readBuilds(root))
      .flatMap(record => record.artifacts)
      .find(candidate => candidate.id === artifact.id)!;
    assert.ok(marked.archived, 'the archived recovery mark must be persisted before the unlink');

    // restoreMedia still restores it and clears the mark.
    await restoreMedia(root, archive, [artifact.id]);
    assert.equal(await hashFile(artifactFile), artifact.sha256, 'restore-media writes the bytes back');
    const cleared = (await readBuilds(root))
      .flatMap(record => record.artifacts)
      .find(candidate => candidate.id === artifact.id)!;
    assert.equal(cleared.archived, undefined, 'restore-media clears the archived mark');

    // A normal release frees the bytes and is restartable.
    const released = await releaseArchived(root, archive, [artifact.id]);
    assert.equal(released.released.length, 1, 'the selected artifact is released once');
    assert.equal(await exists(artifactFile), false, 'the released bytes are removed');
  } finally {
    setReleaseStepHookForTest(undefined);
    await rm(root, { recursive: true, force: true });
    await rm(archive, { force: true });
  }
});

// ---------------------------------------------------------------------------
// a published-but-unrecorded delivery is recoverable by re-delivery
// ---------------------------------------------------------------------------

test('re-delivering to the same default succeeds after a crash between publish and record', async () => {
  const { root, build } = await simRoot();
  try {
    // --- deliver ------------------------------------------------------------
    await deliverProject(root, undefined);
    const deliverRecord = path.join(root, '.viscraft', 'deliveries', 'handoff.json');
    const bundleManifest = path.join(root, 'output', 'handoff', 'delivery-manifest.json');
    assert.ok(await exists(deliverRecord), 'the first delivery is recorded');
    const manifestSha = await hashFile(bundleManifest);
    // Simulate the crash: the bundle is published, the record was never written.
    await rm(deliverRecord);
    await assert.rejects(
      deliverProject(root, undefined),
      /recorded Runtime delivery/,
      'an unrecognized existing bundle is refused (protection intact)',
    );
    // The interrupted delivery's own recovery marker authorizes replacing it.
    await markDeliveryPending(root, {
      name: 'handoff',

      kind: 'deliver',
      build: build.id,
      revision: 1,
      deliveredAt: new Date().toISOString(),
      manifestSha256: manifestSha,
    });
    await deliverProject(root, undefined);
    assert.ok(await exists(deliverRecord), 're-delivery records the bundle again');
    assert.equal(
      await exists(path.join(root, '.viscraft', 'deliveries', 'watch.pending')),
      false,
      'the marker is cleared',
    );

    // --- export -------------------------------------------------------------
    await exportProject(root, undefined);
    const exportRecord = path.join(root, '.viscraft', 'deliveries', 'project.json');
    const exportManifest = path.join(root, 'output', 'project', '.viscraft', 'portable-manifest.json');
    assert.ok(await exists(exportRecord), 'the first export is recorded');
    const exportSha = await hashFile(exportManifest);
    await rm(exportRecord);
    await assert.rejects(exportProject(root, undefined), /recorded Runtime delivery/);
    await markDeliveryPending(root, {
      name: 'project',

      kind: 'export',
      revision: 1,
      deliveredAt: new Date().toISOString(),
      manifestSha256: exportSha,
    });
    await exportProject(root, undefined);
    assert.ok(await exists(exportRecord), 're-export records the package again');

    // --- archive ------------------------------------------------------------
    await archiveProject(root);
    const archiveRecord = path.join(root, '.viscraft', 'deliveries', 'fixture-delivery-sim.tar.gz.json');
    const publishedArchive = path.join(root, 'output', 'fixture-delivery-sim.tar.gz');
    assert.ok(await exists(archiveRecord), 'the first archive is recorded');
    const archiveSha = await hashFile(publishedArchive);
    await rm(archiveRecord);
    await assert.rejects(archiveProject(root), /recorded Runtime delivery/);
    await markDeliveryPending(root, {
      name: 'fixture-delivery-sim.tar.gz',

      kind: 'archive',
      revision: 1,
      deliveredAt: new Date().toISOString(),
      manifestSha256: archiveSha,
    });
    await archiveProject(root);
    assert.ok(await exists(archiveRecord), 're-archiving records the archive again');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('re-exporting a playable to the same default succeeds after a crash between publish and record', async () => {
  const root = await tmp();
  try {
    await writeJson(path.join(root, 'project.json'), codeProject({ entry: 'scene.html', resources: [] }));
    await writeFile(path.join(root, 'scene.html'), '<html>scene</html>');
    await exportPlayable(root, 'src');
    const record = path.join(root, '.viscraft', 'deliveries', 'playable-src.json');
    const published = path.join(root, 'output', 'playable-src');
    assert.ok(await exists(record), 'the first playable export is recorded');
    const manifestSha = await hashFile(path.join(published, 'playable-manifest.json'));
    await rm(record);
    await assert.rejects(exportPlayable(root, 'src'), /recorded Runtime delivery/);
    await markDeliveryPending(root, {
      name: 'playable-src',

      kind: 'playable',
      revision: 1,
      deliveredAt: new Date().toISOString(),
      manifestSha256: manifestSha,
    });
    await exportPlayable(root, 'src');
    assert.ok(await exists(record), 're-export records the playable again');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// archive restore must not recursively delete a replaced directory
// ---------------------------------------------------------------------------

test('a restore whose destination is replaced mid-publication never recursively deletes the replacement', async () => {
  const root = await tmp();
  const parent = await mkdtemp(path.join(os.tmpdir(), 'viscraft-p0restore-'));
  const archive = path.join(parent, 'restore.tar.gz');
  const destination = path.join(parent, 'restored');
  const stolen = path.join(parent, 'restored.stolen');
  const sentinel = path.join(destination, 'SENTINEL');
  try {
    const resources = Array.from({ length: 3 }, (_, index) => `res/file-${String(index).padStart(4, '0')}.bin`);
    await writeJson(path.join(root, 'project.json'), codeProject({ entry: 'scene.html', resources }));
    await writeFile(path.join(root, 'scene.html'), '<html>scene</html>');
    for (const relative of resources) {
      const file = path.join(root, ...relative.split('/'));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `bytes:${relative}`);
    }
    await archiveProject(root, archive);

    // Deterministic seam: after the very first member is copied, and before the
    // next ownership check, swap the destination for a replacement carrying a
    // sentinel. The failed ownership check must not recursively delete it.
    let replaced = false;
    setArchiveStepHookForTest(async step => {
      if (step !== 'restore-member' || replaced) return;
      await rename(destination, stolen);
      await mkdir(destination, { recursive: true });
      await writeFile(sentinel, 'not ours');
      replaced = true;
    });
    try {
      await assert.rejects(restoreProject(archive, destination), /replaced during publication/);
    } finally {
      setArchiveStepHookForTest(undefined);
    }
    assert.ok(replaced, 'the destination must have been replaced during the restore');
    assert.ok(await exists(sentinel), 'the failed ownership check must NOT recursively delete the replacement');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// a rights-bearing Asset that is also another role keeps its rights
// ---------------------------------------------------------------------------

test('a non-redistributable Asset that is also a handoff helper keeps its rights in the manifest', async () => {
  const root = await tmp();
  try {
    await writeFile(path.join(root, 'helper.bin'), 'helper bytes that are NOT redistributable');
    const helperSha = await hashFile(path.join(root, 'helper.bin'));
    const asset: Asset = {
      id: 'asset-helper',
      revision: 1,
      path: 'helper.bin',
      sha256: helperSha,
      type: 'code',
      rights: { ...PRIVATE, author: 'test' },
      simulated: false,
    };
    await writeJson(
      path.join(root, 'project.json'),
      codeProject({
        entry: 'scene.html',
        resources: [],
        assets: [asset],
        handoff: [{ path: 'helper.bin', role: 'helper' }],
      }),
    );
    await writeFile(path.join(root, 'scene.html'), '<html>scene</html>');
    const result = await exportProject(root, path.join(root, 'output', 'private'), { allowNonRedistributable: true });
    assert.ok(result.files > 0);
    const manifestPath = path.join(root, 'output', 'private', '.viscraft', 'portable-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      files: Array<{ path: string; provenance: { kind?: string; rights?: { redistributable?: boolean } } }>;
    };
    const entry = manifest.files.find(file => file.path === 'helper.bin')!;
    assert.ok(entry, 'the dual-role file is packaged');
    assert.equal(
      entry.provenance.kind,
      'asset',
      'a rights-bearing Asset that is also a handoff helper must keep its Asset provenance',
    );
    assert.equal(entry.provenance.rights?.redistributable, false, 'the non-redistributable rights must survive');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// a bus literally named `programme` must not collide with the mix
// ---------------------------------------------------------------------------

test('a handoff with stems and a bus named `programme` succeeds without a duplicate bundle path', async () => {
  const root = await tmp();
  try {
    const signal = await writeSignalAsset(root, {
      id: 'bus_bed',
      path: 'bus-bed.wav',
      sampleRate: 48000,
      channels: 2,
      samples: TOTAL_SAMPLES,
      frequency: 120,
    });
    const clip = (id: string, gain: number, bus?: string) => ({
      id,
      kind: 'asset' as const,
      asset: signal.id,
      inSample: 0,
      startSample: 0,
      durationSamples: TOTAL_SAMPLES,
      gain,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      ...(bus === undefined ? {} : { bus }),
    });
    const base = simProject();
    const withAudio: Project = validateProject({
      ...base,
      assets: [signal],
      composition: {
        ...base.composition,
        audio: [clip('a', 0.15, 'programme'), clip('b', 0.12, 'music')],
      },
    });
    await writeJson(path.join(root, 'project.json'), withAudio);
    await buildProject(root);

    const delivery = await deliverProject(root, undefined, { review: true, stems: true });
    assert.equal(delivery.audio.programme, 'audio/programme.wav', 'the programme mix keeps its path');
    const stemPaths = delivery.audio.stems.map(stem => stem.path).sort();
    assert.deepEqual(stemPaths, ['audio/stems/music.wav', 'audio/stems/programme.wav']);
    // Both files actually exist, distinct from the programme mix.
    assert.ok(await exists(path.join(root, 'output', 'handoff', 'audio', 'programme.wav')));
    assert.ok(await exists(path.join(root, 'output', 'handoff', 'audio', 'stems', 'programme.wav')));
    assert.notEqual(
      await hashFile(path.join(root, 'output', 'handoff', 'audio', 'programme.wav')),
      await hashFile(path.join(root, 'output', 'handoff', 'audio', 'stems', 'programme.wav')),
      'the bus stem is its own file, not the programme mix',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// a TS/TSX Playable entry/resource exports as executable `.js`
// ---------------------------------------------------------------------------

test('a TypeScript Playable is exported with executable .js members the live server serves', async () => {
  const root = await tmp();
  try {
    await writeJson(path.join(root, 'project.json'), codeProject({ entry: 'main.ts', resources: ['helper.ts'] }));
    await writeFile(
      path.join(root, 'main.ts'),
      `import { value } from './helper.js';\n(window as any).viscraft = { render() { return value; } };\n`,
    );
    await writeFile(path.join(root, 'helper.ts'), 'export const value: number = 1;\n');

    const result = await exportPlayable(root, 'src');
    const pkg = path.join(root, 'output', 'playable-src');
    assert.equal(result.entry, 'main.js', 'the live Source entry points at the emitted .js');

    // Author source is kept AND the executable member is emitted.
    assert.ok(await exists(path.join(pkg, 'main.ts')), 'the authored TS source is carried');
    assert.ok(await exists(path.join(pkg, 'main.js')), 'the executable main.js is emitted');
    assert.ok(await exists(path.join(pkg, 'helper.js')), 'the resource helper.js is emitted');

    const manifest = JSON.parse(await readFile(path.join(pkg, 'playable-manifest.json'), 'utf8')) as {
      source: { entry: string };
      files: Array<{ path: string; sha256: string }>;
    };
    assert.equal(manifest.source.entry, 'main.js', 'the manifest names the executable entry');
    const jsEntry = manifest.files.find(file => file.path === 'main.js')!;
    assert.ok(jsEntry, 'main.js is a hashed manifest member');
    assert.equal(await hashFile(path.join(pkg, 'main.js')), jsEntry.sha256, 'the manifest hash matches the .js bytes');
    const config = JSON.parse(await readFile(path.join(pkg, 'project.json'), 'utf8')) as {
      sources: Array<{ entry: string; resources: string[] }>;
    };
    assert.equal(config.sources[0].entry, 'main.js', 'the live configuration entry is executable');
    assert.ok(config.sources[0].resources.includes('helper.js'), 'the live configuration exposes helper.js');

    // The live server serves the emitted JS with an executable content type.
    const server = await servePlayable(pkg);
    try {
      const response = await fetch(server.url);
      assert.equal(response.status, 200, 'the entry is served');
      assert.match(response.headers.get('content-type') ?? '', /javascript/, 'the entry is served as JavaScript');
    } finally {
      await server.close();
    }

    // A TypeScript type error aborts the export before anything is published.
    await writeFile(path.join(root, 'main.ts'), `const n: number = "not a number";\nvoid n;\n`);
    await rm(path.join(root, 'output', 'playable-src'), { recursive: true, force: true });
    await rm(path.join(root, '.viscraft', 'deliveries', 'playable-src.json'), { force: true });
    await assert.rejects(exportPlayable(root, 'src'), /failed to compile/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// a sharded archive record resolves the whole verified group
// ---------------------------------------------------------------------------

test('a sharded archive records a coherent group and clean touches only its own parts', async () => {
  const root = await tmp();
  try {
    await writeJson(path.join(root, 'project.json'), codeProject({ entry: 'scene.html', resources: [] }));
    await writeFile(path.join(root, 'scene.html'), '<html>scene</html>');
    const result = await archiveProject(root, undefined, { partSize: 400 });
    assert.ok(result.parts && result.parts.length > 1, 'the archive is sharded');

    const record = JSON.parse(
      await readFile(path.join(root, '.viscraft', 'deliveries', 'fixture-delivery-code.tar.gz.json'), 'utf8'),
    ) as { name: string; path?: string; kind: string };
    assert.equal(record.kind, 'archive');
    assert.equal(record.name, 'fixture-delivery-code.tar.gz', 'the record names the stem');
    assert.equal(
      record.path,
      'fixture-delivery-code.tar.gz.parts.json',
      'the record points at the verified parts list',
    );

    // A same-prefix non-member must be preserved by the group resolution.
    const stranger = path.join(root, 'output', 'fixture-delivery-code.tar.gz.part-999-stranger');
    await writeFile(stranger, 'not a member');

    const plan = await planClean(root, { include: ['output/fixture-delivery-code.tar.gz'] });
    const touched = plan.items.map(item => path.basename(item.path)).sort();
    for (const part of result.parts!) assert.ok(touched.includes(part.name), `${part.name} must be in the group`);
    assert.ok(touched.includes('fixture-delivery-code.tar.gz.parts.json'), 'the parts list is in the group');
    assert.equal(
      plan.items.some(item => item.path.endsWith('part-999-stranger')),
      false,
      'a same-prefix non-member is never selected',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// a split-archive replacement that fails during the aside move leaves the
// previous archive fully intact and replaceable
// ---------------------------------------------------------------------------

test('a split-archive replacement failure during the aside move leaves the previous archive intact', async () => {
  const root = await tmp();
  try {
    await writeJson(path.join(root, 'project.json'), codeProject({ entry: 'scene.html', resources: [] }));
    await writeFile(path.join(root, 'scene.html'), '<html>scene</html>');
    const first = await archiveProject(root, undefined, { partSize: 400 });
    assert.ok(first.parts && first.parts.length > 1, 'the archive is sharded');

    const output = path.join(root, 'output');
    const listPath = path.join(output, 'fixture-delivery-code.tar.gz.parts.json');
    const listBytes = await readFile(listPath);
    const partBytes = new Map<string, Buffer>();
    for (const part of first.parts!) partBytes.set(part.name, await readFile(path.join(output, part.name)));

    // Fail exactly after the previous members are moved aside.
    let fired = false;
    setArchiveStepHookForTest(step => {
      if (step === 'aside-moved') {
        fired = true;
        throw new Error('simulated failure after the aside move');
      }
    });
    try {
      await assert.rejects(
        archiveProject(root, undefined, { partSize: 400 }),
        /simulated failure after the aside move/,
      );
    } finally {
      setArchiveStepHookForTest(undefined);
    }
    assert.ok(fired, 'the injected failure must occur exactly at the aside move');

    // The previous archive is intact: the list and every part are restored with
    // their original bytes, nothing is left renamed aside, and the recovery
    // marker written before the move has been cleared.
    assert.deepEqual(await readFile(listPath), listBytes, 'the previous parts list is restored byte-for-byte');
    for (const part of first.parts!) {
      assert.deepEqual(
        await readFile(path.join(output, part.name)),
        partBytes.get(part.name),
        `${part.name} is restored`,
      );
    }
    const leftovers = (await readdir(output)).filter(name => name.endsWith('.old'));
    assert.deepEqual(leftovers, [], 'no previous member is left renamed aside');
    assert.equal(
      await exists(path.join(root, '.viscraft', 'deliveries', 'fixture-delivery-code.tar.gz.pending')),
      false,
      'the pending marker is cleared on the failed replacement',
    );

    // A subsequent archive to the same default succeeds and publishes its own
    // verified parts list (the recompressed archive need not be byte-identical).
    const second = await archiveProject(root, undefined, { partSize: 400 });
    assert.ok(second.parts && second.parts.length > 1, 'the re-archive succeeds');
    const secondList = JSON.parse(await readFile(listPath, 'utf8')) as { parts: Array<{ name: string }> };
    assert.deepEqual(
      secondList.parts.map(part => part.name),
      second.parts!.map(part => part.name),
      'the re-archive publishes its own verified parts list',
    );
  } finally {
    setArchiveStepHookForTest(undefined);
    await rm(root, { recursive: true, force: true });
  }
});
