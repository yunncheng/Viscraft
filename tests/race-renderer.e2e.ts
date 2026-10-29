import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { captureCode } from '../src/backends/browser/capture.js';
import { applyWorldFrame } from '../src/backends/world/world.js';
import { loadProject, resolveSourceBindings, saveProject } from '../src/project/project.js';
import { buildProject } from '../src/build/build.js';
import { runCommand } from '../src/shared/process.js';
import type { BrowserPictureSource } from '../src/core/schema.js';

test('the race wheel Source executes real WebGL, loads its assets and rebuilds only its changed Source', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-race-renderer-'));
  const root = join(parent, 'project');
  try {
    // Use the locked dependency by default; an already-acquired distribution
    // can override it. The creator verifies all three exact file hashes.
    const donor = process.env.VISCRAFT_TEST_THREE || resolve('node_modules/three');
    await runCommand(process.execPath, [resolve('tests/fixtures/authoring/create-race.mjs'), root, donor]);
    const project = await loadProject(root);
    const base = structuredClone(project.sources.find(source => source.id === 'src_wheel')) as BrowserPictureSource;
    assert(base?.kind === 'browser');
    const world = project.worlds!.find(world => world.id === base.world!.id)!;
    const output = { ...project.composition!.output, width: 192, height: 108 };
    const bindings = Object.fromEntries(
      resolveSourceBindings(project, base).map(({ binding, asset }) => [
        binding,
        { id: asset.id, path: asset.path, sha256: asset.sha256 },
      ]),
    );
    const source: BrowserPictureSource = { ...base, kind: 'browser', output: 'picture', frames: 2 };
    delete (source as unknown as Record<string, unknown>).world;
    delete (source as unknown as Record<string, unknown>).camera;
    delete (source as unknown as Record<string, unknown>).startFrame;
    const frameHook = {
      beforeFrame: (page: Parameters<typeof applyWorldFrame>[0], frame: number) =>
        applyWorldFrame(page, world, base.world!.camera, 160 + frame),
    };

    // Real WebGL: drive the authored renderer through the browser capture path
    // and require it to emit one non-empty PNG per requested frame, with the
    // wheel actually moving between frames.
    const framesDir = join(parent, 'frames');
    await captureCode(root, source, output, framesDir, bindings, frameHook);
    const rendered = (await readdir(framesDir)).filter(name => name.endsWith('.png')).sort();
    assert.equal(rendered.length, 2, 'the renderer must emit one PNG per requested frame');
    const [firstFrame, secondFrame] = await Promise.all(rendered.map(name => readFile(join(framesDir, name))));
    assert.ok(firstFrame.length > 0 && secondFrame.length > 0, 'rendered frames must not be empty');
    assert.notDeepEqual(firstFrame, secondFrame, 'a moving wheel must render different pixels across frames');

    // Asset loading: the authored renderer document loads the verified three
    // build and composes the wheel from its own geometry.
    const html = await readFile(join(root, 'race.html'), 'utf8');
    assert.match(html, /wheel\.add\(disc\)/);
    assert.match(html, /model\.add\(caliper\)/);

    // Scoped rebuild: two Sources over the same World; editing one Source's
    // params rebuilds only that Source and preserves the other Take.
    const photo = structuredClone(base);
    photo.id = 'physical';
    photo.frames = 2;
    photo.world = { ...photo.world!, startFrame: 160 };
    photo.params = { ...photo.params, film: true, photographic: true, look: 'tech_study' };
    project.sources = [photo, { ...base, id: 'base', frames: 2, world: { ...base.world!, startFrame: 160 } }];
    project.composition!.output = output;
    project.composition!.shots = [
      {
        id: 'wheel',
        scene: project.composition!.scenes[0].id,
        look: project.direction.looks[0].id,
        intent: 'Observed physical wheel',
        targetFrames: 4,
      },
    ];
    project.composition!.placements = project.sources.map((source, index) => ({
      id: source.id,
      shot: 'wheel',
      source: source.id,
      inFrame: 0,
      outFrame: 2,
      startFrame: index * 2,
      audio: 'mute',
    }));
    project.composition!.subtitles = [];
    project.composition!.audio = [];
    await writeFile(join(root, 'project.json'), JSON.stringify(project));
    const first = await buildProject(root);
    assert.equal(first.artifacts.find(artifact => artifact.id === first.result!.artifact)!.media!.frames, 4);
    assert.notEqual(first.takes[0].artifact, first.takes[1].artifact);
    const current = await loadProject(root);
    (current.sources[0] as BrowserPictureSource).params.photographic = false;
    await saveProject(root, current, current.revision);
    const edited = await buildProject(root);
    assert.equal(edited.operations.filter(operation => operation.kind === 'browser' && !operation.reused).length, 1);
    assert.equal(
      edited.takes.find(take => take.source === 'base')!.id,
      first.takes.find(take => take.source === 'base')!.id,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
