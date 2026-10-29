import { fileURLToPath } from 'node:url';
/**
 * handoff files, `VISCRAFT.md` fact page and `ATTRIBUTION.md`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildProject } from '../src/build/build.js';
import { planBuild } from '../src/build/plan.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { deliverProject } from '../src/operations/delivery/delivery.js';
import { verifyDelivery } from '../src/operations/delivery/delivery-verification.js';
import { DeliveryManifestSchema } from '../src/operations/delivery/delivery-contract.js';
import { writeSignalAsset } from './audio-fixtures.js';
import { attributionCells, checkHandoff, scanHandoffFile } from '../src/operations/delivery/handoff.js';
import { projectStatus } from '../src/project/status.js';
import { hashFile } from '../src/shared/hash.js';
import { ProjectSchema, type Project } from '../src/core/schema.js';

async function fixture(): Promise<{ parent: string; root: string; project: Project }> {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'viscraft-handoff-'));
  const root = path.join(parent, 'work');
  await mkdir(path.join(root, 'assets'), { recursive: true });
  await writeFile(path.join(root, 'assets', 'logo.txt'), 'logo bytes\n');
  await writeFile(path.join(root, 'NOTES.md'), '# Notes\n\nApproved: the opening. Next: tighten the cut.\n');
  const project = ProjectSchema.parse({
    schemaVersion: 1,
    id: 'handoff_fixture',
    revision: 1,
    title: 'Handoff fixture',
    direction: { intent: 'Handoff files', looks: [{ id: 'look', description: 'look' }], transitions: [] },
    assets: [
      {
        id: 'logo',
        revision: 1,
        path: 'assets/logo.txt',
        sha256: await hashFile(path.join(root, 'assets', 'logo.txt')),
        type: 'code',
        simulated: false,
        rights: {
          origin: 'Studio logo pack',
          license: 'CC-BY-4.0',
          redistributable: true,
          author: 'Jane Doe | Studio',
          licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
          notice: 'Logo by Jane Doe, CC BY 4.0',
          attributionRequired: true,
        },
      },
    ],
    bindings: {},
    sources: [{ id: 'src', kind: 'simulated', prompt: 'a', frames: 12, seed: 1, attempt: 'a1', behavior: 'success' }],
    composition: {
      output: { width: 64, height: 48, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene', description: 'scene' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: 'a', targetFrames: 12 }],
      placements: [{ id: 'pl', shot: 'shot', source: 'src', inFrame: 0, outFrame: 12, startFrame: 0, audio: 'mute' }],
      transitions: [],
      audio: [],
    },
  });
  await writeFile(path.join(root, 'project.json'), JSON.stringify(project));
  return { parent, root, project };
}

const withHandoff = (project: Project): Project => ({ ...project, handoff: [{ path: 'NOTES.md', role: 'notes' }] });

test('large handoff files are fully scanned, including split credentials and invalid trailing UTF-8', async () => {
  const { parent, root, project } = await fixture();
  try {
    const file = path.join(root, 'NOTES.md');
    const large = Buffer.alloc(11 * 1024 * 1024, 0x20);
    Buffer.from('A large author note\n').copy(large);
    await writeFile(file, large);
    const checked = await checkHandoff(root, withHandoff(project));
    assert.equal(checked.files[0].bytes, large.length);
    assert.equal(checked.files[0].sha256, await hashFile(file));
    const split = Buffer.alloc(2 * 65536 + 64, 0x20);
    Buffer.from('api_key = abcdefghijklmnop1234').copy(split, 65536 - 5);
    await writeFile(file, split);
    await assert.rejects(checkHandoff(root, withHandoff(project)), /credential-looking/);
    await writeFile(file, `password${' '.repeat(200000)}=${' '.repeat(200000)}abcdefghijklmnop1234`);
    await assert.rejects(checkHandoff(root, withHandoff(project)), /credential-looking/);
    await writeFile(file, Buffer.concat([large, Buffer.from([0xc3])]));
    await assert.rejects(checkHandoff(root, withHandoff(project)), /UTF-8/);
    await writeFile(file, `hello é ${root}/author\n`);
    const scanned = await scanHandoffFile(file, [root]);
    assert.equal(scanned.utf8, true);
    assert.deepEqual(scanned.localPaths, [root]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('author root page names coexist with Runtime pages in its own namespace', async () => {
  const { parent, root, project } = await fixture();
  try {
    await mkdir(path.join(root, 'VISCRAFT.md'));
    await writeFile(path.join(root, 'VISCRAFT.md', 'note.txt'), 'author directory content');
    await writeFile(path.join(root, 'ATTRIBUTION.md'), 'author attribution content');
    project.handoff = [
      { path: 'VISCRAFT.md/note.txt', role: 'notes' },
      { path: 'ATTRIBUTION.md', role: 'attribution' },
    ];
    await writeFile(path.join(root, 'project.json'), JSON.stringify(project));
    const exported = await exportProject(root, path.join(parent, 'copy'));
    assert.equal(
      await readFile(path.join(exported.path, 'VISCRAFT.md', 'note.txt'), 'utf8'),
      'author directory content',
    );
    assert.equal(await readFile(path.join(exported.path, 'ATTRIBUTION.md'), 'utf8'), 'author attribution content');
    assert.ok((await readFile(path.join(exported.path, '.viscraft', 'pages', 'VISCRAFT.md'))).length > 0);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('removed purpose options are refused before creating a delivery', async () => {
  const { parent, root } = await fixture();
  try {
    await assert.rejects(deliverProject(root, undefined, { purpose: 'watch' } as never), /unrecognized.*purpose/i);
    const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
    const result = spawnSync(process.execPath, [cli, 'deliver', root, '--for', 'continue'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    await assert.rejects(readFile(path.join(root, 'output', 'handoff', 'delivery-manifest.json')), /ENOENT/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('review and audio attachments are independent and preserve the finished movie', async () => {
  const { parent, root, project } = await fixture();
  try {
    const sound = await writeSignalAsset(root, {
      id: 'bed',
      path: 'bed.wav',
      sampleRate: 48000,
      channels: 2,
      samples: 24000,
      frequency: 440,
    });
    project.assets.push(sound);
    project.composition!.audio = [
      {
        id: 'bed',
        kind: 'asset',
        asset: sound.id,
        inSample: 0,
        startSample: 0,
        durationSamples: 24000,
        gain: 1,
        fadeInSamples: 0,
        fadeOutSamples: 0,
        bus: 'music',
      },
    ];
    await writeFile(path.join(root, 'project.json'), JSON.stringify(project));
    await buildProject(root);
    let movie: string | undefined;
    for (const [name, options] of [
      ['default', {}],
      ['review', { review: true }],
      ['audio', { stems: true }],
      ['both', { review: true, stems: true }],
    ] as const) {
      const delivery = await deliverProject(root, path.join(parent, name), options);
      assert.ok(delivery.project);
      assert.equal(delivery.review !== null, 'review' in options);
      assert.equal(delivery.audio.programme !== null, 'stems' in options);
      assert.equal(delivery.audio.stems.length, 'stems' in options ? 1 : 0);
      if (movie === undefined) movie = delivery.movie!.sha256;
      else assert.equal(delivery.movie!.sha256, movie);
      assert.equal((await verifyDelivery(delivery.path)).ok, true);
      const manifest = JSON.parse(await readFile(path.join(delivery.path, 'delivery-manifest.json'), 'utf8'));
      assert.equal(DeliveryManifestSchema.safeParse(manifest).success, true);
      assert.equal(DeliveryManifestSchema.safeParse({ ...manifest, purpose: 'study' }).success, false);
      assert.equal(DeliveryManifestSchema.safeParse({ ...manifest, projectExport: null }).success, false);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('handoff is not a production input; export carries it with VISCRAFT.md and ATTRIBUTION.md', async () => {
  const { parent, root, project } = await fixture();
  try {
    await buildProject(root);
    // Declaring and editing a handoff note never changes the author state.
    await writeFile(path.join(root, 'project.json'), JSON.stringify(withHandoff(project)));
    await writeFile(path.join(root, 'NOTES.md'), '# Notes\n\nApproved: the opening and the close.\n');
    const plan = await planBuild(root);
    assert.equal(plan.work.length, 0, 'a handoff note is never a production input');
    const status = await projectStatus(root);
    // A handoff-only note is not a production input: neither its declaration nor
    // its bytes enter the authoring verdict, so the work reads unchanged. The
    // SNAPSHOT still records the bytes (see the export assertions below), so
    // lineage/revert/export stay whole while status does not cry "changed".
    assert.equal(status.current?.authoring, 'unchanged');
    assert.deepEqual(status.handoff, [{ path: 'NOTES.md', role: 'notes', present: true }]);

    const exported = await exportProject(root, path.join(parent, 'copy'));
    assert.deepEqual(exported.warnings, []);
    assert.equal(
      await readFile(path.join(exported.path, 'NOTES.md'), 'utf8'),
      '# Notes\n\nApproved: the opening and the close.\n',
    );
    const facts = await readFile(path.join(exported.path, '.viscraft', 'pages', 'VISCRAFT.md'), 'utf8');
    assert.match(facts, /`NOTES\.md` \(notes\)/);
    assert.match(facts, /viscraft status \./);
    assert.match(facts, /simulated\/test-only/);
    // The fact page commands work in the copy.
    const copied = await projectStatus(exported.path);
    // The copy reports the same verdict: the note is a handed-off document, not a
    // production input, even though its Build snapshot predates the note.
    assert.equal(copied.current?.authoring, 'unchanged');
    assert.equal((await planBuild(exported.path)).work.length, 0);

    // ATTRIBUTION.md and the Delivery index.html carry the same attribution cells.
    const attribution = await readFile(path.join(exported.path, '.viscraft', 'pages', 'ATTRIBUTION.md'), 'utf8');
    const delivery = await deliverProject(root, path.join(parent, 'bundle'));
    const html = await readFile(path.join(delivery.path, 'index.html'), 'utf8');
    for (const cell of attributionCells(withHandoff(project).assets[0]).filter(Boolean)) {
      assert.ok(attribution.includes(cell.replace(/\|/g, '\\|')), `ATTRIBUTION.md has ${cell}`);
      assert.ok(html.includes(cell.replace(/&/g, '&amp;').replace(/</g, '&lt;')), `index.html has ${cell}`);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('missing, tampered, credential-bearing and path-leaking handoff files', async () => {
  const { parent, root, project } = await fixture();
  try {
    await buildProject(root);
    await writeFile(path.join(root, 'project.json'), JSON.stringify(withHandoff(project)));

    await writeFile(path.join(root, 'NOTES.md'), `Rendered on ${root}/review\n`);
    const warned = await exportProject(root, path.join(parent, 'warned'));
    assert.ok(warned.warnings.length > 0, 'export reports the detected local path leak');

    await writeFile(path.join(root, 'NOTES.md'), 'api_key = abcdefghijklmnop1234\n');
    await assert.rejects(exportProject(root, path.join(parent, 'secret')), /credential-looking/);

    await rm(path.join(root, 'NOTES.md'));
    await assert.rejects(exportProject(root, path.join(parent, 'missing')), /declared but missing/);
    assert.ok((await projectStatus(root)).attention.some(item => item.code === 'handoff-missing'));

    await writeFile(path.join(root, 'NOTES.md'), 'clean note\n');
    const delivery = await deliverProject(root, path.join(parent, 'bundle'), {});
    assert.equal((await verifyDelivery(delivery.path)).ok, true);
    await writeFile(path.join(delivery.path, 'project', 'NOTES.md'), 'tampered\n');
    assert.equal((await verifyDelivery(delivery.path)).ok, false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('one complete handoff with independently selected review and audio attachments', async () => {
  const { parent, root } = await fixture();
  try {
    await buildProject(root);
    const listed = async (dir: string) =>
      JSON.parse(await readFile(path.join(dir, 'delivery-manifest.json'), 'utf8')).files.map(
        (file: { path: string }) => file.path,
      ) as string[];

    const cont = await deliverProject(root, path.join(parent, 'handoff'), {});
    const contFiles = await listed(cont.path);
    assert.ok(contFiles.includes('project/project.json'));
    assert.ok(contFiles.includes('project/.viscraft/pages/VISCRAFT.md'));
    assert.ok(!contFiles.some(file => file.startsWith('review/') || file.startsWith('audio/')));
    assert.equal('purpose' in cont, false);
    assert.equal((await verifyDelivery(cont.path)).ok, true);
    // The movie and its project/ artifact copy are the same bytes: linked, counted once.
    assert.ok(cont.bytes < cont.logicalBytes, `unique ${cont.bytes} < logical ${cont.logicalBytes}`);
    const manifest = JSON.parse(await readFile(path.join(cont.path, 'delivery-manifest.json'), 'utf8'));
    const movieSha = manifest.files.find((file: { path: string }) => file.path === 'movie/final.mp4').sha256;
    const twin = manifest.files.find(
      (file: { path: string; sha256: string }) => file.path.startsWith('project/') && file.sha256 === movieSha,
    );
    const { stat } = await import('node:fs/promises');
    const a = await stat(path.join(cont.path, 'movie', 'final.mp4'), { bigint: true });
    const b = await stat(path.join(cont.path, ...twin.path.split('/')), { bigint: true });
    assert.equal(a.ino, b.ino);
    assert.equal(a.mode & 0o777n, 0o444n);

    const evidence = await deliverProject(root, path.join(parent, 'with-evidence'), { review: true, stems: true });
    const evidenceFiles = await listed(evidence.path);
    assert.ok(evidenceFiles.some(file => file.startsWith('review/')));
    assert.ok(evidenceFiles.includes('project/project.json'));
    assert.equal((await verifyDelivery(evidence.path)).ok, true);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
