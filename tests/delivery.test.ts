import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { buildProject } from '../src/build/build.js';
import { readBuilds } from '../src/project/build-records.js';
import { deliverProject } from '../src/operations/delivery/delivery.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { loadProject } from '../src/project/project.js';
import { ProjectSchema } from '../src/core/schema.js';
import type { Project } from '../src/core/schema.js';
import { writeSignalAsset } from './audio-fixtures.js';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-delivery-test-'));
}

/**
 * Three placements over three simulated sources (two cuts), one registered
 * audio signal Asset and one subtitle. A simulated source still produces a real,
 * openable movie through the normal `buildProject` path.
 */
async function makeProject(
  root: string,
  overrides: { title?: string; lookDescription?: string; subtitleText?: string } = {},
): Promise<Project> {
  const signal = await writeSignalAsset(root, {
    id: 'bed',
    path: 'signal.wav',
    sampleRate: 48000,
    channels: 2,
    samples: 24000,
    frequency: 440,
  });
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'delivery_test',
    revision: 1,
    title: overrides.title ?? 'Delivery Test',
    direction: {
      intent: 'Three-shot simulated build for delivery coverage.',
      looks: [{ id: 'look_main', description: overrides.lookDescription ?? 'main look' }],
      transitions: [],
    },
    assets: [signal],
    bindings: {},
    sources: [
      {
        id: 'src_a',
        kind: 'simulated',
        prompt: 'shot a',
        frames: 20,
        seed: 1,
        attempt: 'attempt_a',
        behavior: 'success',
      },
      {
        id: 'src_b',
        kind: 'simulated',
        prompt: 'shot b',
        frames: 20,
        seed: 2,
        attempt: 'attempt_b',
        behavior: 'success',
      },
      {
        id: 'src_c',
        kind: 'simulated',
        prompt: 'shot c',
        frames: 20,
        seed: 3,
        attempt: 'attempt_c',
        behavior: 'success',
      },
    ],
    composition: {
      output: { width: 160, height: 120, fps: { numerator: 25, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene_1', description: 'scene' }],
      shots: [
        { id: 'shot_a', scene: 'scene_1', look: 'look_main', intent: 'a', targetFrames: 20 },
        { id: 'shot_b', scene: 'scene_1', look: 'look_main', intent: 'b', targetFrames: 20 },
        { id: 'shot_c', scene: 'scene_1', look: 'look_main', intent: 'c', targetFrames: 20 },
      ],
      placements: [
        { id: 'pl_a', shot: 'shot_a', source: 'src_a', inFrame: 0, outFrame: 20, startFrame: 0, audio: 'mute' },
        { id: 'pl_b', shot: 'shot_b', source: 'src_b', inFrame: 0, outFrame: 20, startFrame: 20, audio: 'mute' },
        { id: 'pl_c', shot: 'shot_c', source: 'src_c', inFrame: 0, outFrame: 20, startFrame: 40, audio: 'mute' },
      ],
      transitions: [],
      audio: [
        {
          id: 'bed',
          kind: 'asset',
          asset: 'bed',
          inSample: 0,
          startSample: 0,
          durationSamples: 24000,
          gain: 0.3,
          fadeInSamples: 480,
          fadeOutSamples: 480,
        },
      ],
      subtitles: [
        {
          id: 'sub_1',
          text: overrides.subtitleText ?? 'Hello world',
          startFrame: 20,
          endFrame: 40,
          fontSize: 32,
          color: '#ffffff',
        },
      ],
    },
  });
}

async function buildAt(root: string, project: Project): Promise<string> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(nodePath.join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  const record = await buildProject(root);
  assert.equal(record.status, 'succeeded');
  assert.ok(record.result, 'a succeeded build has a result');
  return record.id;
}

function pngSize(buffer: Buffer): { width: number; height: number } {
  assert.ok(buffer.length >= 24, 'PNG header is truncated');
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'expected a real PNG signature');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Every regular file under `dir`, as sorted `/`-separated relative paths. */
async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = nodePath.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(absolute, relative)));
    else if (entry.isFile()) out.push(relative);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

async function activeBuildId(root: string): Promise<string> {
  return (JSON.parse(await fs.readFile(nodePath.join(root, '.viscraft', 'result.json'), 'utf8')) as { build: string })
    .build;
}

test('deliverProject delivers the active result movie, a fresh review and the editable project from a real build', async () => {
  const parent = await tempDir();
  const root = nodePath.join(parent, 'authoring');
  const destination = nodePath.join(parent, 'bundle');
  try {
    const buildId = await buildAt(root, await makeProject(root));

    const projectBefore = await fs.readFile(nodePath.join(root, 'project.json'), 'utf8');
    const resultBefore = await fs.readFile(nodePath.join(root, '.viscraft', 'result.json'), 'utf8');
    const result = JSON.parse(resultBefore) as { artifact: string; path: string; sha256: string };
    const artifactPaths = (await readBuilds(root)).flatMap(build => build.artifacts.map(artifact => artifact.path));
    const artifactHashes = await Promise.all(artifactPaths.map(relative => hashFile(nodePath.join(root, relative))));

    const delivery = await deliverProject(root, destination, { review: true, stems: true });

    assert.equal(delivery.build, buildId, 'the active result Build is delivered');
    assert.equal(delivery.revision, 1);
    assert.equal(delivery.simulated, true, 'simulated sources taint the bundle');
    assert.equal(delivery.movie!.path, 'movie/final.mp4');
    assert.equal(delivery.movie!.sha256, result.sha256, 'the movie is the active result artifact');
    assert.equal(delivery.movie!.artifact, result.artifact);
    assert.equal(delivery.review!.build, buildId);
    assert.equal(delivery.review!.seams.length, 2, 'three placements produce two cuts');
    assert.equal(delivery.playable, null);
    assert.equal(delivery.manifest, 'delivery-manifest.json');
    assert.ok(delivery.files > 0 && delivery.bytes > 0);

    // Bundle shape.
    for (const relative of [
      'index.html',
      'delivery-manifest.json',
      'movie/final.mp4',
      delivery.review!.contactSheet,
      delivery.review!.report,
      'project/project.json',
      'project/.viscraft/portable-manifest.json',
    ]) {
      assert.ok(
        await fs.stat(nodePath.join(destination, relative)).then(
          () => true,
          () => false,
        ),
        `bundle contains ${relative}`,
      );
    }
    // Derived review output is not duplicated inside the editable project export.
    for (const forbidden of [
      '.viscraft/reviews',
      '.viscraft/scratch',
      '.viscraft/author.lock',
      '.viscraft/build.lock',
    ]) {
      assert.equal(
        await fs.stat(nodePath.join(destination, 'project', forbidden)).then(
          () => true,
          () => false,
        ),
        false,
        `project export must not contain ${forbidden}`,
      );
    }

    // The movie bytes equal the active artifact exactly.
    assert.equal(await hashFile(nodePath.join(destination, 'movie', 'final.mp4')), result.sha256);

    // Review products are real PNGs of the expected geometry.
    const contact = pngSize(await fs.readFile(nodePath.join(destination, delivery.review!.contactSheet)));
    assert.equal(contact.width, 3 * 320);
    assert.equal(contact.height, 3 * 240, 'one contact row per placement');
    for (const seam of delivery.review!.seams) pngSize(await fs.readFile(nodePath.join(destination, seam)));
    const report = JSON.parse(await fs.readFile(nodePath.join(destination, delivery.review!.report), 'utf8')) as {
      build: string;
      observation: string;
    };
    assert.equal(report.build, buildId);
    assert.match(report.observation, /subjective audio review not performed/i);

    // delivery-manifest.json hashes every bundled file except itself.
    const manifest = JSON.parse(await fs.readFile(nodePath.join(destination, 'delivery-manifest.json'), 'utf8')) as {
      format: string;
      simulated: boolean;
      build: { id: string };
      files: Array<{ path: string; sha256: string; bytes: number; role: string }>;
      movie: { sha256: string };
      review: { seamsSha256: string[] };
      notes: string[];
      limitations: string[];
    };
    assert.equal(manifest.format, 'viscraft-delivery-bundle');
    assert.equal(manifest.simulated, true);
    assert.equal(manifest.build.id, buildId);
    assert.ok(
      manifest.notes.some(note => /simulated/i.test(note)),
      'simulated provenance is stated',
    );
    assert.ok(manifest.limitations.some(limitation => /subjective|aesthetic/i.test(limitation)));

    const listed = new Set(manifest.files.map(file => file.path));
    assert.equal(listed.has('delivery-manifest.json'), false, 'the manifest never lists itself');
    const actual = await listFiles(destination);
    const actualWithoutManifest = actual.filter(file => file !== 'delivery-manifest.json');
    assert.deepEqual([...listed].sort(), actualWithoutManifest.sort(), 'manifest allowlists exactly the bundled files');
    for (const file of manifest.files) {
      assert.equal(await hashFile(nodePath.join(destination, file.path)), file.sha256, `hash matches for ${file.path}`);
      if (file.path === 'movie/final.mp4') assert.equal(file.sha256, result.sha256);
    }
    for (const role of ['project', 'movie', 'review', 'index'])
      assert.ok(
        manifest.files.some(file => file.role === role),
        `role ${role} is present`,
      );
    assert.deepEqual(manifest.review!.seamsSha256, delivery.review!.seamsSha256);

    // The bundled project reopens and its lineage is reusable.
    const reopened = await loadProject(nodePath.join(destination, 'project'));
    assert.equal(reopened.id, 'delivery_test');
    assert.equal(reopened.revision, 1);
    const exportedBuilds = await readBuilds(nodePath.join(destination, 'project'));
    const exportedActive = exportedBuilds.find(build => build.id === buildId);
    assert.ok(
      exportedActive && exportedActive.status === 'succeeded' && exportedActive.result,
      'the delivered Build is reusable from the export',
    );

    // index.html is escaped, JavaScript-free and links only to local files.
    const index = await fs.readFile(nodePath.join(destination, 'index.html'), 'utf8');
    assert.ok(index.includes(buildId), 'index names the delivered Build');
    assert.ok(index.includes('movie/final.mp4') && index.includes(delivery.review!.contactSheet.replace(/\\/g, '/')));
    assert.ok(index.includes('simulated'), 'index states simulation provenance');
    // The fixture declares an audio member, so the bundle ships programme audio and the
    // page must warn that a silent editor/IDE preview is not evidence of a missing track.
    assert.match(index, /VS Code/, 'index warns that a silent editor/IDE preview is not evidence of missing audio');
    assert.equal(/<script/i.test(index), false, 'index carries no JavaScript');
    assert.equal(/(?:src|href)\s*=\s*["']https?:/i.test(index), false, 'index loads no external resources');

    // Delivery never mutates the authored project, the active result or artifacts.
    assert.equal(await fs.readFile(nodePath.join(root, 'project.json'), 'utf8'), projectBefore);
    assert.equal(await fs.readFile(nodePath.join(root, '.viscraft', 'result.json'), 'utf8'), resultBefore);
    assert.deepEqual(
      await Promise.all(artifactPaths.map(relative => hashFile(nodePath.join(root, relative)))),
      artifactHashes,
    );
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('deliverProject delivers the ACTIVE result build, not the newest succeeded build', async () => {
  const parent = await tempDir();
  const root = nodePath.join(parent, 'authoring');
  const destination = nodePath.join(parent, 'bundle');
  try {
    const active = await buildAt(root, await makeProject(root));

    // Craft a newer, succeeded Build that is NOT the active result: it reuses
    // the active Build's artifacts/takes but has a later start time, so a
    // "newest succeeded build wins" rule would pick it.
    const buildsDir = nodePath.join(root, '.viscraft', 'builds');
    const activeRecord = JSON.parse(await fs.readFile(nodePath.join(buildsDir, `${active}.json`), 'utf8')) as Record<
      string,
      unknown
    >;
    const newer = {
      ...activeRecord,
      id: 'build-newer-than-active',
      startedAt: '2999-01-01T00:00:00.000Z',
      finishedAt: '2999-01-01T00:00:01.000Z',
    };
    await fs.writeFile(nodePath.join(buildsDir, 'build-newer-than-active.json'), JSON.stringify(newer, null, 2));

    const newest = (await readBuilds(root))[0];
    assert.equal(newest.id, 'build-newer-than-active', 'the crafted Build is the newest succeeded build');

    const delivery = await deliverProject(root, destination, { review: true, stems: true });
    assert.equal(delivery.build, active, 'delivery follows .viscraft/result.json');
    const manifest = JSON.parse(await fs.readFile(nodePath.join(destination, 'delivery-manifest.json'), 'utf8')) as {
      build: { id: string };
      movie: { artifact: string };
    };
    assert.equal(manifest.build.id, active);
    assert.equal(await activeBuildId(root), active, 'the active result is untouched');
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('deliverProject escapes malicious authored text in index.html', async () => {
  const parent = await tempDir();
  const root = nodePath.join(parent, 'authoring');
  const destination = nodePath.join(parent, 'bundle');
  try {
    await buildAt(
      root,
      await makeProject(root, {
        title: '<script>alert(1)</script>',
        lookDescription: '"><img src=x onerror=alert(2)>',
        subtitleText: '<b>bold</b> & <i>italic</i>',
      }),
    );

    await deliverProject(root, destination, { review: true, stems: true });
    const index = await fs.readFile(nodePath.join(destination, 'index.html'), 'utf8');

    assert.equal(/<script/i.test(index), false, 'no script tag from the malicious title');
    assert.ok(index.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'the title is HTML-escaped');
    assert.ok(index.includes('&lt;img src=x onerror=alert(2)&gt;'), 'the look description is escaped');
    assert.ok(index.includes('&lt;b&gt;bold&lt;/b&gt;'), 'subtitle text is escaped');
    assert.equal(/<img\s+src=x/i.test(index), false, 'no injected image tag');
    assert.equal(/(?:src|href)\s*=\s*["']https?:/i.test(index), false, 'no external resource attributes');
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('deliverProject refuses unsafe destinations and never overwrites an existing bundle', async () => {
  const parent = await tempDir();
  const root = nodePath.join(parent, 'authoring');
  try {
    await buildAt(root, await makeProject(root));

    await assert.rejects(() => deliverProject(root, nodePath.join(root, 'inside')), /outside the project root/i);
    await assert.rejects(() => deliverProject(root, root, { review: true, stems: true }), /outside the project root/i);
    await assert.rejects(() => deliverProject(root, parent, { review: true, stems: true }), /ancestor/i);
    await assert.rejects(() => deliverProject(root, nodePath.join(root, 'project.json')), /outside the project root/i);

    const existing = nodePath.join(parent, 'existing-bundle');
    await fs.mkdir(existing, { recursive: true });
    const sentinel = nodePath.join(existing, 'keep.txt');
    await fs.writeFile(sentinel, 'pre-existing');
    await assert.rejects(() => deliverProject(root, existing, { review: true, stems: true }), /already exists/i);
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'pre-existing', 'an existing destination is never overwritten');
    assert.deepEqual(await fs.readdir(existing), ['keep.txt']);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('deliverProject cleans up and creates no destination when delivery fails mid-bundle', async () => {
  const parent = await tempDir();
  const root = nodePath.join(parent, 'authoring');
  const destination = nodePath.join(parent, 'bundle');
  try {
    await buildAt(root, await makeProject(root));
    const projectBefore = await fs.readFile(nodePath.join(root, 'project.json'), 'utf8');
    const resultBefore = await fs.readFile(nodePath.join(root, '.viscraft', 'result.json'), 'utf8');

    // The playable export runs after the project export, movie and review have
    // been staged; a missing Source must abort the whole delivery.
    await assert.rejects(
      () => deliverProject(root, destination, { review: true, stems: true, playableSource: 'no-such-source' }),
      /unknown source/i,
    );

    assert.equal(
      await fs.stat(destination).then(
        () => true,
        () => false,
      ),
      false,
      'no destination is created on failure',
    );
    const leftovers = (await fs.readdir(parent)).filter(entry => entry.includes('.staging'));
    assert.deepEqual(leftovers, [], 'private staging directories are removed on failure');
    assert.equal(await fs.readFile(nodePath.join(root, 'project.json'), 'utf8'), projectBefore);
    assert.equal(await fs.readFile(nodePath.join(root, '.viscraft', 'result.json'), 'utf8'), resultBefore);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('deliverProject refuses to deliver a project with no active result', async () => {
  const parent = await tempDir();
  const root = nodePath.join(parent, 'authoring');
  const destination = nodePath.join(parent, 'bundle');
  try {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(nodePath.join(root, 'project.json'), `${JSON.stringify(await makeProject(root), null, 2)}\n`);
    await assert.rejects(
      () => deliverProject(root, destination, { review: true, stems: true }),
      /no active .viscraft\/result\.json/i,
    );
    assert.equal(
      await fs.stat(destination).then(
        () => true,
        () => false,
      ),
      false,
    );
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('deliverProject copies reported picture-layer strips and a non-dangling review path map', async () => {
  const parent = await tempDir();
  const root = nodePath.join(parent, 'authoring');
  const destination = nodePath.join(parent, 'bundle');
  try {
    // Base placement plus one picture layer, so reviewBuild reports a layer strip.
    const project = ProjectSchema.parse({
      schemaVersion: 1,
      id: 'delivery_layers',
      revision: 1,
      title: 'Delivery Layers Test',
      direction: {
        intent: 'A base shot with a full-frame overlay layer.',
        looks: [{ id: 'look_main', description: 'main look' }],
        transitions: [],
      },
      assets: [],
      bindings: {},
      sources: [
        {
          id: 'src_base',
          kind: 'simulated',
          prompt: 'base',
          frames: 40,
          seed: 1,
          attempt: 'attempt_base',
          behavior: 'success',
        },
        {
          id: 'src_over',
          kind: 'simulated',
          prompt: 'overlay',
          frames: 40,
          seed: 2,
          attempt: 'attempt_over',
          behavior: 'success',
        },
      ],
      composition: {
        output: { width: 160, height: 120, fps: { numerator: 25, denominator: 1 }, sampleRate: 48000, channels: 2 },
        scenes: [{ id: 'scene_1', description: 'scene' }],
        shots: [{ id: 'shot_a', scene: 'scene_1', look: 'look_main', intent: 'a', targetFrames: 40 }],
        placements: [
          { id: 'pl_a', shot: 'shot_a', source: 'src_base', inFrame: 0, outFrame: 40, startFrame: 0, audio: 'mute' },
        ],
        transitions: [],
        audio: [],
        layers: [
          {
            id: 'layer_a',
            source: 'src_over',
            inFrame: 0,
            outFrame: 20,
            startFrame: 0,
            x: 0,
            y: 0,
            width: 160,
            height: 120,
            opacity: 0.5,
          },
        ],
      },
    });
    const buildId = await buildAt(root, project);

    const delivery = await deliverProject(root, destination, { review: true, stems: true });

    assert.equal(delivery.review!.layers.length, 1, 'the reported picture-layer strip is bundled');
    assert.equal(delivery.review!.layers[0], 'review/layers/layer-00.png');
    assert.equal(
      await fs.stat(nodePath.join(destination, delivery.review!.layers[0])).then(
        () => true,
        () => false,
      ),
      true,
    );

    // The verbatim report still names the exported project's generated review path...
    const reportBytes = await fs.readFile(nodePath.join(destination, delivery.review!.report), 'utf8');
    const report = JSON.parse(reportBytes) as { timeline: { layers: Array<{ strip: string }> } };
    const reportLayerStrip = report.timeline.layers[0].strip;
    assert.equal(
      reportLayerStrip,
      `.viscraft/reviews/${buildId}/layer-00.png`,
      'the report keeps its exact original bytes',
    );
    assert.ok(reportBytes.includes(reportLayerStrip), 'the report is copied verbatim, not rewritten');

    // ...and review/paths.json maps that original path to the bundled file, so it is not dangling.
    const paths = JSON.parse(await fs.readFile(nodePath.join(destination, delivery.review!.paths), 'utf8')) as {
      format: string;
      build: string;
      paths: Array<{ original: string; bundle: string; kind: string }>;
    };
    assert.equal(paths.format, 'viscraft-delivery-review-paths');
    assert.equal(paths.build, buildId);
    const layerEntry = paths.paths.find(entry => entry.kind === 'layer');
    assert.ok(layerEntry, 'the map has a layer entry');
    assert.equal(layerEntry!.original, reportLayerStrip);
    assert.equal(layerEntry!.bundle, delivery.review!.layers[0]);
    assert.equal(
      await fs.stat(nodePath.join(destination, layerEntry!.bundle)).then(
        () => true,
        () => false,
      ),
      true,
      'the mapped bundle path exists (non-dangling)',
    );
    for (const entry of paths.paths) {
      assert.ok(
        entry.original.startsWith(`.viscraft/reviews/${buildId}/`),
        `original path is a known review path: ${entry.original}`,
      );
      assert.equal(
        await fs.stat(nodePath.join(destination, entry.bundle)).then(
          () => true,
          () => false,
        ),
        true,
        `mapped bundle path exists: ${entry.bundle}`,
      );
    }

    // Both the layer strip and the map are part of the hashed allowlist.
    const manifest = JSON.parse(await fs.readFile(nodePath.join(destination, 'delivery-manifest.json'), 'utf8')) as {
      review: { layers: string[]; pathsSha256: string };
      files: Array<{ path: string; sha256: string }>;
    };
    assert.deepEqual(manifest.review!.layers, delivery.review!.layers);
    for (const relative of ['review/layers/layer-00.png', 'review/paths.json']) {
      const listed = manifest.files.find(file => file.path === relative);
      assert.ok(listed, `manifest lists ${relative}`);
      assert.equal(await hashFile(nodePath.join(destination, relative)), listed!.sha256);
    }

    // A Source-referenced placement selects the Take produced for that Source.
    const index = await fs.readFile(nodePath.join(destination, 'index.html'), 'utf8');
    const takesSection = index.slice(index.indexOf('<section id="takes">'), index.indexOf('<section id="artifacts">'));
    assert.match(takesSection, /<td>true<\/td><\/tr>/, 'a Take built from a source placement is marked selected');
    assert.equal(/<td>false<\/td><\/tr>/.test(takesSection), false, 'no Take is wrongly marked unselected');
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('deliverProject delivers a non-simulated FFmpeg fixture movie without any simulated taint', async () => {
  const parent = await tempDir();
  const root = nodePath.join(parent, 'authoring');
  const destination = nodePath.join(parent, 'bundle');
  try {
    // A known FFmpeg-generated fixture registered as a normal media Asset.
    await fs.mkdir(root, { recursive: true });
    const fixture = nodePath.join(root, 'clip.mp4');
    await runCommand('ffmpeg', [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-filter_threads',
      '1',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=160x120:rate=25:duration=1',
      '-pix_fmt',
      'yuv420p',
      '-threads',
      '2',
      fixture,
    ]);
    const project = ProjectSchema.parse({
      schemaVersion: 1,
      id: 'delivery_media',
      revision: 1,
      title: 'Delivery Media Test',
      direction: { intent: 'One media shot.', looks: [{ id: 'look_main', description: 'main look' }], transitions: [] },
      assets: [
        {
          id: 'clip',
          revision: 1,
          path: 'clip.mp4',
          sha256: await hashFile(fixture),
          type: 'video',
          rights: { origin: 'ffmpeg testsrc fixture', license: 'test fixture', redistributable: true },
          simulated: false,
        },
      ],
      bindings: {},
      sources: [],
      composition: {
        output: { width: 160, height: 120, fps: { numerator: 25, denominator: 1 }, sampleRate: 48000, channels: 2 },
        scenes: [{ id: 'scene_1', description: 'scene' }],
        shots: [{ id: 'shot_a', scene: 'scene_1', look: 'look_main', intent: 'a', targetFrames: 25 }],
        placements: [
          { id: 'pl_a', shot: 'shot_a', asset: 'clip', inFrame: 0, outFrame: 25, startFrame: 0, audio: 'mute' },
        ],
        transitions: [],
        audio: [],
      },
    });
    const buildId = await buildAt(root, project);

    const delivery = await deliverProject(root, destination, { review: true, stems: true });
    assert.equal(delivery.build, buildId);
    assert.equal(delivery.simulated, false, 'a real media fixture is not simulated');
    assert.equal(delivery.review!.seams.length, 0, 'a single placement has no cuts');

    const manifest = JSON.parse(await fs.readFile(nodePath.join(destination, 'delivery-manifest.json'), 'utf8')) as {
      simulated: boolean;
      build: { simulated: boolean };
      movie: { simulated: boolean };
      files: Array<{ path: string; sha256: string }>;
    };
    assert.equal(manifest.simulated, false);
    assert.equal(manifest.build.simulated, false);
    assert.equal(manifest.movie.simulated, false);
    assert.equal(
      manifest.files.some(file => file.path === 'movie/final.mp4'),
      true,
    );

    const index = await fs.readFile(nodePath.join(destination, 'index.html'), 'utf8');
    assert.match(index, /Simulated \/ test-only provenance: <strong>none<\/strong>/);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

// --- Private (non-redistributable) delivery opt-in -------------------------
// A real media fixture is registered as an ordinary Asset so the strict path
// genuinely refuses it (the same real rule that blocked output-host-image) and
// the explicit opt-in genuinely packages it.

interface MediaFixture {
  id: string;
  path: string;
  sha256: string;
}

interface MediaSpec extends MediaFixture {
  rights: { origin: string; license: string; redistributable: boolean };
}

const PUBLIC_RIGHTS = { origin: 'original FFmpeg fixture', license: 'CC0-1.0', redistributable: true } as const;
const PRIVATE_RIGHTS = {
  origin: 'host-tool output; no license established',
  license: 'not established; redistribution rights unverified',
  redistributable: false,
} as const;

/** Generate a deterministic FFmpeg fixture under `root` and return its identity. */
async function mediaFixture(root: string, id: string, size: string): Promise<MediaFixture> {
  await fs.mkdir(root, { recursive: true });
  const relative = `${id}.mp4`;
  const file = nodePath.join(root, relative);
  await runCommand('ffmpeg', [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-filter_threads',
    '1',
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=${size}:rate=25:duration=1`,
    '-pix_fmt',
    'yuv420p',
    '-threads',
    '2',
    file,
  ]);
  return { id, path: relative, sha256: await hashFile(file) };
}

/** One media Source + placement + shot per declared media spec. */
function mediaProject(specs: MediaSpec[]): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'delivery_private_media',
    revision: 1,
    title: 'Delivery Private Media Test',
    direction: {
      intent: 'Sequential media shots for private-delivery coverage.',
      looks: [{ id: 'look_main', description: 'main look' }],
      transitions: [],
    },
    assets: specs.map(spec => ({
      id: spec.id,
      revision: 1,
      path: spec.path,
      sha256: spec.sha256,
      type: 'video',
      rights: spec.rights,
      simulated: false,
    })),
    bindings: {},
    sources: [],
    composition: {
      output: { width: 160, height: 120, fps: { numerator: 25, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene_1', description: 'scene' }],
      shots: specs.map((spec, index) => ({
        id: `shot_${index}`,
        scene: 'scene_1',
        look: 'look_main',
        intent: spec.id,
        targetFrames: 25,
      })),
      placements: specs.map((spec, index) => ({
        id: `pl_${index}`,
        shot: `shot_${index}`,
        asset: spec.id,
        inFrame: 0,
        outFrame: 25,
        startFrame: index * 25,
        audio: 'mute',
      })),
      transitions: [],
      audio: [],
    },
  });
}

test('deliverProject refuses a non-redistributable asset by default and produces no destination', async () => {
  const parent = await tempDir();
  const root = nodePath.join(parent, 'authoring');
  const destination = nodePath.join(parent, 'bundle');
  try {
    const privateSpec = await mediaFixture(root, 'private_clip', '160x120');
    await buildAt(root, mediaProject([{ ...privateSpec, rights: PRIVATE_RIGHTS }]));

    await assert.rejects(
      () => deliverProject(root, destination, { review: true, stems: true }),
      (error: Error) => {
        assert.match(error.message, /not redistributable/, 'default path keeps the redistribution refusal');
        assert.match(error.message, /allowNonRedistributable/, 'the refusal tells the author the explicit opt-in name');
        assert.match(
          error.message,
          /not cleared for redistribution/i,
          'the refusal states the resulting package is private',
        );
        return true;
      },
    );
    assert.equal(
      await fs.stat(destination).then(
        () => true,
        () => false,
      ),
      false,
      'the strict path creates no destination',
    );
    const leftovers = (await fs.readdir(parent)).filter(entry => entry.includes('.staging'));
    assert.deepEqual(leftovers, [], 'no staging directory is left behind');
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('deliverProject packages a non-redistributable asset only with the explicit opt-in, includes the bytes and marks the bundle', async () => {
  const parent = await tempDir();
  const root = nodePath.join(parent, 'authoring');
  const destination = nodePath.join(parent, 'bundle');
  try {
    const privateSpec = await mediaFixture(root, 'private_clip', '160x120');
    await buildAt(root, mediaProject([{ ...privateSpec, rights: PRIVATE_RIGHTS }]));
    const sourceHash = await hashFile(nodePath.join(root, privateSpec.path));

    const delivery = await deliverProject(root, destination, {
      review: true,
      stems: true,
      allowNonRedistributable: true,
    });
    assert.equal(delivery.containsNonRedistributableAssets, true, 'the result declares the private content');
    assert.deepEqual(
      delivery.nonRedistributableAssets.map(asset => asset.asset),
      ['private_clip'],
    );

    // The private bytes are actually present and hash-match both the source and
    // the Asset's declared sha256.
    const bundledAsset = nodePath.join(destination, 'project', privateSpec.path);
    assert.equal(await hashFile(bundledAsset), sourceHash);
    assert.equal(await hashFile(bundledAsset), privateSpec.sha256);

    const manifest = JSON.parse(await fs.readFile(nodePath.join(destination, 'delivery-manifest.json'), 'utf8')) as {
      containsNonRedistributableAssets: boolean;
      nonRedistributableAssets: Array<{ asset: string; path: string; origin: string; license: string }>;
      files: Array<{ path: string; sha256: string }>;
      notes: string[];
    };
    assert.equal(manifest.containsNonRedistributableAssets, true);
    assert.deepEqual(
      manifest.nonRedistributableAssets.map(asset => asset.asset),
      ['private_clip'],
    );
    assert.equal(
      manifest.nonRedistributableAssets[0].license,
      PRIVATE_RIGHTS.license,
      'the private Asset keeps its recorded rights',
    );
    assert.ok(
      manifest.notes.some(note => /not cleared for redistribution/i.test(note)),
      'the note states the bundle is not cleared for redistribution',
    );
    assert.ok(
      manifest.files.some(file => file.path === `project/${privateSpec.path}`),
      'the private asset is in the hashed allowlist',
    );

    const index = await fs.readFile(nodePath.join(destination, 'index.html'), 'utf8');
    assert.match(
      index,
      /not cleared for redistribution/i,
      'index.html states the bundle is not cleared for redistribution',
    );
    assert.ok(index.includes('private_clip'), 'index.html names the private Asset');
    assert.equal(/<script/i.test(index), false, 'index stays JavaScript-free');

    for (const file of manifest.files) {
      assert.equal(await hashFile(nodePath.join(destination, file.path)), file.sha256, `hash matches for ${file.path}`);
    }
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('the opt-in is a no-op for an all-redistributable project (no marker, same files as a normal delivery)', async () => {
  const parent = await tempDir();
  const root = nodePath.join(parent, 'authoring');
  const strict = nodePath.join(parent, 'strict-bundle');
  const optIn = nodePath.join(parent, 'opt-in-bundle');
  try {
    const publicSpec = await mediaFixture(root, 'public_clip', '160x120');
    await buildAt(root, mediaProject([{ ...publicSpec, rights: PUBLIC_RIGHTS }]));

    const strictDelivery = await deliverProject(root, strict, { review: true, stems: true });
    const optInDelivery = await deliverProject(root, optIn, {
      review: true,
      stems: true,
      allowNonRedistributable: true,
    });

    assert.equal(strictDelivery.containsNonRedistributableAssets, false);
    assert.equal(optInDelivery.containsNonRedistributableAssets, false, 'the flag must not pollute a normal delivery');
    assert.deepEqual(await listFiles(strict), await listFiles(optIn), 'the opt-in produces the same file set');

    const strictManifest = JSON.parse(
      await fs.readFile(nodePath.join(strict, 'delivery-manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
    const optInManifest = JSON.parse(
      await fs.readFile(nodePath.join(optIn, 'delivery-manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
    assert.equal('containsNonRedistributableAssets' in strictManifest, false);
    assert.equal(
      'containsNonRedistributableAssets' in optInManifest,
      false,
      'no marker is added when nothing is private',
    );
    assert.equal('nonRedistributableAssets' in optInManifest, false);

    const strictIndex = await fs.readFile(nodePath.join(strict, 'index.html'), 'utf8');
    const optInIndex = await fs.readFile(nodePath.join(optIn, 'index.html'), 'utf8');
    assert.equal(optInIndex, strictIndex, 'index.html is byte-identical to a normal delivery');
    assert.equal(/not cleared for redistribution/i.test(optInIndex), false);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('a mixed project marks the bundle and still includes both the private and the redistributable asset', async () => {
  const parent = await tempDir();
  const root = nodePath.join(parent, 'authoring');
  const destination = nodePath.join(parent, 'bundle');
  try {
    const publicSpec = await mediaFixture(root, 'public_clip', '160x120');
    const privateSpec = await mediaFixture(root, 'private_clip', '176x120');
    await buildAt(
      root,
      mediaProject([
        { ...publicSpec, rights: PUBLIC_RIGHTS },
        { ...privateSpec, rights: PRIVATE_RIGHTS },
      ]),
    );

    const delivery = await deliverProject(root, destination, {
      review: true,
      stems: true,
      allowNonRedistributable: true,
    });
    assert.equal(delivery.containsNonRedistributableAssets, true);
    assert.deepEqual(
      delivery.nonRedistributableAssets.map(asset => asset.asset),
      ['private_clip'],
      'only the private asset is flagged',
    );

    for (const spec of [publicSpec, privateSpec]) {
      const bundled = nodePath.join(destination, 'project', spec.path);
      assert.equal(await hashFile(bundled), spec.sha256, `both asset bytes are present and hash-match (${spec.id})`);
    }
    assert.equal(delivery.review!.seams.length, 1, 'two placements produce one cut');

    const manifest = JSON.parse(await fs.readFile(nodePath.join(destination, 'delivery-manifest.json'), 'utf8')) as {
      containsNonRedistributableAssets: boolean;
      nonRedistributableAssets: Array<{ asset: string }>;
      files: Array<{ path: string }>;
    };
    assert.equal(manifest.containsNonRedistributableAssets, true);
    assert.deepEqual(
      manifest.nonRedistributableAssets.map(asset => asset.asset),
      ['private_clip'],
    );
    assert.ok(manifest.files.some(file => file.path === `project/${publicSpec.path}`));
    assert.ok(manifest.files.some(file => file.path === `project/${privateSpec.path}`));
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('the destination safety rules still hold under the opt-in', async () => {
  const parent = await tempDir();
  const root = nodePath.join(parent, 'authoring');
  try {
    const privateSpec = await mediaFixture(root, 'private_clip', '160x120');
    await buildAt(root, mediaProject([{ ...privateSpec, rights: PRIVATE_RIGHTS }]));

    const optIn = { allowNonRedistributable: true } as const;
    await assert.rejects(() => deliverProject(root, nodePath.join(root, 'inside'), optIn), /outside the project root/i);
    await assert.rejects(() => deliverProject(root, root, optIn), /outside the project root/i);
    await assert.rejects(() => deliverProject(root, parent, optIn), /ancestor/i);

    const existing = nodePath.join(parent, 'existing-bundle');
    await fs.mkdir(existing, { recursive: true });
    const sentinel = nodePath.join(existing, 'keep.txt');
    await fs.writeFile(sentinel, 'pre-existing');
    await assert.rejects(() => deliverProject(root, existing, optIn), /already exists/i);
    assert.equal(
      await fs.readFile(sentinel, 'utf8'),
      'pre-existing',
      'the opt-in never overwrites an existing destination',
    );
    assert.deepEqual(await fs.readdir(existing), ['keep.txt']);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

/**
 * A synthetic, decodable 252 MiB PCM WAV with a sparse zero data chunk.
 * This tests the distinct-inode file-size accounting used by delivery, not
 * allocated disk blocks or transport throughput. The editable Asset and frozen
 * content copy remain independent and together exceed the former 500 MiB cap.
 */
async function writeLargeSilentWav(file: string, bytes: number): Promise<void> {
  await fs.mkdir(nodePath.dirname(file), { recursive: true });
  const handle = await fs.open(file, 'w');
  try {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(bytes - 8, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(8000, 24); // sample rate
    header.writeUInt32LE(16000, 28); // byte rate
    header.writeUInt16LE(2, 32); // block align
    header.writeUInt16LE(16, 34); // bits per sample
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(bytes - 44, 40);
    await handle.write(header);
    await handle.truncate(bytes);
  } finally {
    await handle.close();
  }
}

const LARGE_ASSET_BYTES = 252 * 1024 * 1024;

/** Register one large, unused-but-authored Asset so it is exported twice (editable + frozen). */
async function withLargeAsset(root: string, project: Project): Promise<{ project: Project; sha256: string }> {
  const relative = 'assets/large-silence.wav';
  const absolute = nodePath.join(root, relative);
  await writeLargeSilentWav(absolute, LARGE_ASSET_BYTES);
  const sha256 = await hashFile(absolute);
  project.assets.push({
    id: 'large_silence',
    revision: 1,
    path: relative,
    sha256,
    type: 'audio',
    rights: PUBLIC_RIGHTS,
    simulated: false,
  });
  return { project, sha256 };
}

test('deliverProject delivers a bundle larger than 500 MiB and reports its real bytes without touching the authored inputs', async () => {
  const parent = await tempDir();
  const root = nodePath.join(parent, 'authoring');
  const destination = nodePath.join(parent, 'bundle');
  try {
    const { project, sha256: largeSha } = await withLargeAsset(root, await makeProject(root));
    const buildId = await buildAt(root, project);
    const projectBefore = await fs.readFile(nodePath.join(root, 'project.json'), 'utf8');
    const resultBefore = await fs.readFile(nodePath.join(root, '.viscraft', 'result.json'), 'utf8');
    const result = JSON.parse(resultBefore) as { artifact: string; path: string; sha256: string };

    const delivery = await deliverProject(root, destination);

    assert.equal(delivery.build, buildId);
    assert.equal(delivery.movie!.sha256, result.sha256, 'the small movie is still the active result artifact');
    // The former fixed 500 MiB package ceiling would have refused this bundle.
    assert.ok(
      delivery.bytes > 500 * 1024 * 1024,
      `the delivered payload must exceed the former 500 MiB cap, got ${delivery.bytes}`,
    );
    assert.ok(delivery.logicalBytes >= delivery.bytes, 'logical bytes count every listed path');

    const manifest = JSON.parse(await fs.readFile(nodePath.join(destination, 'delivery-manifest.json'), 'utf8')) as {
      bytes: number;
      logicalBytes: number;
      files: Array<{ path: string; sha256: string; bytes: number; role: string }>;
    };
    assert.ok(manifest.bytes > 500 * 1024 * 1024, 'the manifest reports the real oversized payload');
    assert.equal(manifest.bytes, delivery.bytes);

    // Exact allowlist + hash verification, exactly like a small delivery.
    const listed = new Set(manifest.files.map(file => file.path));
    assert.equal(listed.has('delivery-manifest.json'), false, 'the manifest never lists itself');
    const actual = (await listFiles(destination)).filter(file => file !== 'delivery-manifest.json');
    assert.deepEqual([...listed].sort(), actual.sort(), 'manifest allowlists exactly the bundled files');
    for (const file of manifest.files)
      assert.equal(await hashFile(nodePath.join(destination, file.path)), file.sha256, `hash matches for ${file.path}`);

    // Physical accounting is the distinct-inode sum: the editable asset copy and
    // the frozen snapshot copy are independent, and both count.
    const inodes = new Map<string, number>();
    for (const file of manifest.files) {
      const info = await fs.stat(nodePath.join(destination, file.path), { bigint: true });
      const key = `${info.dev}:${info.ino}`;
      if (!inodes.has(key)) inodes.set(key, Number(info.size));
    }
    assert.equal(
      [...inodes.values()].reduce((sum, size) => sum + size, 0),
      delivery.bytes,
      'reported bytes equal the distinct-inode total',
    );
    const largeCopies = [...inodes.values()].filter(size => size === LARGE_ASSET_BYTES).length;
    assert.ok(largeCopies >= 2, `the large asset is carried as >= 2 independent physical copies, got ${largeCopies}`);
    assert.ok(
      manifest.files.some(file => file.path === 'project/assets/large-silence.wav' && file.sha256 === largeSha),
      'the editable project export carries the large asset bytes',
    );
    assert.ok(
      manifest.files.some(
        file => file.path === `project/.viscraft/content/${largeSha}` && file.bytes === LARGE_ASSET_BYTES,
      ),
      'the frozen content store carries the large asset bytes as an independent copy',
    );

    // Nothing about the authored project, the active result or the movie changed.
    assert.equal(await fs.readFile(nodePath.join(root, 'project.json'), 'utf8'), projectBefore);
    assert.equal(await fs.readFile(nodePath.join(root, '.viscraft', 'result.json'), 'utf8'), resultBefore);
    assert.equal(await hashFile(nodePath.join(destination, 'movie', 'final.mp4')), result.sha256);
    assert.equal(await hashFile(nodePath.join(destination, 'project', 'assets', 'large-silence.wav')), largeSha);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
