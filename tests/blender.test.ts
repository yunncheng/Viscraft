/**
 * Blender Build backend. Rendering checks require a real configured Blender
 * binary or bpy interpreter and use a tiny CPU-rendered cube. File-discovery
 * checks use the host Node binary only as an executable-file fixture; they
 * do not count as Blender rendering validation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildProject } from '../src/build/build.js';
import { captureBlender, findBlender } from '../src/backends/blender/render.js';
import { validateProject } from '../src/index.js';
import { hashFile } from '../src/shared/hash.js';
import { configuredBlenderForTests } from './blender-fixtures.js';

const blenderOptions = await configuredBlenderForTests();
const skip = blenderOptions ? false : 'no configured Blender runtime (binary or bpy Python) found';

/**
 * A minimal, deterministic Blender author script implementing the Viscraft
 * contract: read `--out/--width/--height/--fps/--frames`, write exactly `frames`
 * PNG frames named `frame-%06d.png`, print one VISCRAFT_REPORT line. It imports
 * `lib.palette` so the dependency-closure freeze is genuinely exercised.
 */
const AUTHOR_ENTRY = `import bpy, sys, os, json, math
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from lib.palette import COLOR

def _parse():
    argv = sys.argv
    argv = argv[argv.index('--') + 1:] if '--' in argv else []
    opts = {'out': '.', 'width': 32, 'height': 32, 'fps': 24, 'frames': 1}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == '--out': opts['out'] = argv[i + 1]; i += 2
        elif a == '--width': opts['width'] = int(float(argv[i + 1])); i += 2
        elif a == '--height': opts['height'] = int(float(argv[i + 1])); i += 2
        elif a == '--fps': opts['fps'] = int(float(argv[i + 1])); i += 2
        elif a == '--frames': opts['frames'] = int(argv[i + 1]); i += 2
        else: i += 1
    return opts

o = _parse()
count = o['frames'] - 1 if '--underfill' in sys.argv else o['frames']
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = o['fps']
bpy.ops.mesh.primitive_cube_add(size=2.0)
mesh = bpy.context.active_object
material = bpy.data.materials.new('tint')
material.use_nodes = True
material.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = COLOR
mesh.data.materials.append(material)
cam_data = bpy.data.cameras.new('cam')
cam = bpy.data.objects.new('cam', cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
cam.location = (4.0, -4.0, 3.0)
cam.rotation_euler = (math.radians(63), 0.0, math.radians(45))
world = bpy.data.worlds.new('w')
scene.world = world
world.use_nodes = True
world.node_tree.nodes['Background'].inputs[1].default_value = 1.0
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 1
scene.render.resolution_x = o['width']
scene.render.resolution_y = o['height']
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
os.makedirs(o['out'], exist_ok=True)
for frame in range(count):
    scene.frame_set(frame)
    cam.location = (4.0 + 0.05 * frame, -4.0, 3.0)
    scene.render.filepath = os.path.join(o['out'], 'frame-%06d' % frame)
    bpy.ops.render.render(write_still=True)
print('VISCRAFT_REPORT ' + json.dumps({'frames': count, 'rendered': count}))
`;

interface FixtureOptions {
  frames: number;
  underfill?: boolean;
  fail?: boolean;
}

/** A tiny real Blender project: author script + closure, project.json, one Source. */
async function makeBlenderProject(options: FixtureOptions): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-blender-'));
  const authorDir = path.join(root, 'author');
  const libDir = path.join(authorDir, 'lib');
  await fs.mkdir(libDir, { recursive: true });
  await fs.writeFile(
    path.join(authorDir, 'render.py'),
    options.fail ? "raise RuntimeError('intentional author failure')\n" : AUTHOR_ENTRY,
  );
  await fs.writeFile(path.join(libDir, '__init__.py'), '');
  await fs.writeFile(path.join(libDir, 'palette.py'), 'COLOR = (0.9, 0.25, 0.1, 1.0)\n');
  const project = validateProject({
    schemaVersion: 1,
    id: 'blender-fixture',
    revision: 1,
    title: 'Blender backend fixture',
    direction: {
      intent: 'A Blender-authored fixture used to prove the Blender Build backend.',
      looks: [{ id: 'plain', description: 'A single procedural cube under Cycles.' }],
      transitions: [],
    },
    assets: [],
    bindings: {},
    sources: [
      {
        id: 'shot-src',
        kind: 'blender',
        output: 'picture',
        entry: 'author/render.py',
        resources: ['author/lib/__init__.py', 'author/lib/palette.py'],
        args: options.underfill ? ['--underfill'] : [],
        frames: options.frames,
      },
    ],
    composition: {
      output: { width: 64, height: 64, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene', description: 'One scene.' }],
      shots: [
        { id: 'shot', scene: 'scene', look: 'plain', intent: 'Render the fixture.', targetFrames: options.frames },
      ],
      placements: [
        {
          id: 'place',
          shot: 'shot',
          source: 'shot-src',
          inFrame: 0,
          outFrame: options.frames,
          startFrame: 0,
          audio: 'mute',
        },
      ],
      transitions: [],
      audio: [],
    },
  });
  await fs.writeFile(path.join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  return root;
}

test(
  'a real Blender render flows through the normal Build into a Take/Artifact with provenance',
  { skip },
  async () => {
    const root = await makeBlenderProject({ frames: 2 });
    const record = await buildProject(root, { blender: blenderOptions });
    assert.equal(record.status, 'succeeded');

    const artifact = record.artifacts.find(a => a.operation === 'blender');
    assert.ok(artifact, 'the Build produced a blender artifact');
    assert.equal(artifact.kind, 'video');
    assert.equal(artifact.media?.frames, 2);
    assert.equal(artifact.media?.width, 64);
    assert.equal(artifact.media?.height, 64);
    assert.equal(artifact.simulated, false);
    // The backend records the real Blender version that ran, and the inputs are
    // the frozen author-file hashes (entry + dependency closure).
    assert.match(artifact.backend, /Blender/);
    assert.equal(artifact.backend, record.environment?.blender);
    const entrySha = await hashFile(path.join(root, 'author', 'render.py'));
    const libSha = await hashFile(path.join(root, 'author', 'lib', 'palette.py'));
    assert.ok(artifact.inputs.includes(entrySha), 'entry hash is a recorded input');
    assert.ok(artifact.inputs.includes(libSha), 'dependency-closure hash is a recorded input');
    // The artifact bytes exist and match the recorded hash.
    assert.equal(await hashFile(path.join(root, artifact.path)), artifact.sha256);
    // A normal Take is registered for this Source.
    assert.ok(record.takes.some(t => t.source === 'shot-src'));
    // The Build environment records the Blender tool version.
    assert.match(record.environment!.blender!, /Blender/);
    // Re-renderable author state: the frozen snapshot carries the entry AND closure.
    const snapshot = path.join(root, '.viscraft', 'snapshots', record.id);
    assert.equal(await hashFile(path.join(snapshot, 'author', 'render.py')), entrySha);
    assert.equal(await hashFile(path.join(snapshot, 'author', 'lib', 'palette.py')), libSha);
  },
);

test('Blender discovery uses platform executable names on PATH and in version roots', async () => {
  const previous = {
    blender: process.env.VISCRAFT_BLENDER,
    root: process.env.VISCRAFT_BLENDER_ROOT,
    path: process.env.PATH,
  };
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-blender-discovery-'));
  const filename = process.platform === 'win32' ? 'blender.exe' : 'blender';
  try {
    delete process.env.VISCRAFT_BLENDER;
    delete process.env.VISCRAFT_BLENDER_ROOT;
    process.env.PATH = fixture;
    const executable = path.join(fixture, filename);
    await fs.copyFile(process.execPath, executable);
    await fs.chmod(executable, 0o755);
    assert.equal(await findBlender(), executable);
    const version = path.join(fixture, '4.3.0');
    await fs.mkdir(version);
    const versionedExecutable = path.join(version, filename);
    await fs.rename(executable, versionedExecutable);
    process.env.VISCRAFT_BLENDER_ROOT = fixture;
    assert.equal(await findBlender(), versionedExecutable);
    await assert.rejects(() => findBlender(path.join(fixture, 'missing')), /not an executable file/);
  } finally {
    if (previous.path === undefined) delete process.env.PATH;
    else process.env.PATH = previous.path;
    if (previous.blender === undefined) delete process.env.VISCRAFT_BLENDER;
    else process.env.VISCRAFT_BLENDER = previous.blender;
    if (previous.root === undefined) delete process.env.VISCRAFT_BLENDER_ROOT;
    else process.env.VISCRAFT_BLENDER_ROOT = previous.root;
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('a blender Source fails loudly when no Blender is configured', async () => {
  const previous = {
    blender: process.env.VISCRAFT_BLENDER,
    root: process.env.VISCRAFT_BLENDER_ROOT,
    path: process.env.PATH,
  };
  delete process.env.VISCRAFT_BLENDER;
  delete process.env.VISCRAFT_BLENDER_ROOT;
  // A PATH with no Blender proves `findBlender` reports absence rather than
  // silently doing nothing. (An empty temp dir, so ffmpeg is unaffected below.)
  const emptyPath = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-empty-path-'));
  try {
    process.env.PATH = emptyPath;
    await assert.rejects(findBlender(), /No Blender executable found/);
    await assert.rejects(findBlender('/nonexistent/denied-blender'), /not an executable file/);
  } finally {
    if (previous.path === undefined) delete process.env.PATH;
    else process.env.PATH = previous.path;
    if (previous.blender === undefined) delete process.env.VISCRAFT_BLENDER;
    else process.env.VISCRAFT_BLENDER = previous.blender;
    if (previous.root === undefined) delete process.env.VISCRAFT_BLENDER_ROOT;
    else process.env.VISCRAFT_BLENDER_ROOT = previous.root;
  }
  // Through the whole Build, an explicitly configured but unusable Blender is a
  // loud failure (not a silent skip, not a fabricated Take).
  const root = await makeBlenderProject({ frames: 1 });
  await assert.rejects(
    buildProject(root, { blender: { executable: '/nonexistent/denied-blender' } }),
    /not an executable file/,
  );
});

test('a failing Blender render preserves the previously accepted Result', { skip }, async () => {
  const root = await makeBlenderProject({ frames: 2 });
  const first = await buildProject(root, { blender: blenderOptions });
  assert.equal(first.status, 'succeeded');
  const resultPath = path.join(root, '.viscraft', 'result.json');
  const resultBefore = JSON.parse(await fs.readFile(resultPath, 'utf8'));
  const artifactBefore = first.artifacts.find(a => a.operation === 'blender')!;

  // Break the author script (its hash changes, so the Build must re-render) and
  // bump the project revision, then rebuild.
  await fs.writeFile(path.join(root, 'author', 'render.py'), "raise RuntimeError('intentional author failure')\n");
  const project = JSON.parse(await fs.readFile(path.join(root, 'project.json'), 'utf8'));
  project.revision += 1;
  await fs.writeFile(path.join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);

  await assert.rejects(buildProject(root, { blender: blenderOptions }), /Build .* failed/);

  // The accepted Result pointer is untouched and the previous good artifact
  // bytes are intact (a failed render never overwrites a good Take).
  assert.deepEqual(JSON.parse(await fs.readFile(resultPath, 'utf8')), resultBefore);
  assert.equal(await hashFile(path.join(root, artifactBefore.path)), artifactBefore.sha256);
});

test('a copied project re-renders from the frozen author state', { skip }, async () => {
  const root = await makeBlenderProject({ frames: 2 });
  const first = await buildProject(root, { blender: blenderOptions });
  assert.equal(first.status, 'succeeded');

  // Carry ONLY the author state a moved project would carry — project.json and
  // the author closure — into a fresh directory, with no .viscraft history.
  const moved = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-blender-moved-'));
  await fs.copyFile(path.join(root, 'project.json'), path.join(moved, 'project.json'));
  await fs.cp(path.join(root, 'author'), path.join(moved, 'author'), { recursive: true });

  const second = await buildProject(moved, { blender: blenderOptions });
  assert.equal(second.status, 'succeeded');
  const operation = second.operations.find(o => o.kind === 'blender')!;
  assert.equal(operation.reused, false, 'a fresh directory has nothing to reuse, so it re-rendered');
  const artifact = second.artifacts.find(a => a.operation === 'blender')!;
  assert.equal(artifact.media?.frames, 2);
  assert.equal(await hashFile(path.join(moved, artifact.path)), artifact.sha256);
});

test(
  'non-vacuity: a render producing the wrong frame set is refused and its temp output cleaned up',
  { skip },
  async () => {
    // The author declares 3 frames but the script writes 2. The executor must
    // detect the exact frame set, not merely "some frames", and remove its temp
    // directory on failure.
    const declared = 3;
    const root = await makeBlenderProject({ frames: declared, underfill: true });
    const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-blender-dest-'));
    const source = {
      id: 'shot-src',
      kind: 'blender' as const,
      output: 'picture' as const,
      entry: 'author/render.py',
      resources: ['author/lib/__init__.py', 'author/lib/palette.py'],
      args: ['--underfill'],
      frames: declared,
      bindings: [],
    };
    await assert.rejects(
      captureBlender(
        root,
        source,
        { width: 64, height: 64, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 2 },
        destination,
        blenderOptions,
      ),
      /did not produce exactly 3 frames/,
    );
    // Failure hygiene: the run's temporary frame directory is gone.
    await assert.rejects(fs.access(path.join(destination, 'frame-000000.png')), /ENOENT/);
    // And the same defect, through the whole Build, never becomes a Take.
    await assert.rejects(buildProject(root, { blender: blenderOptions }), /did not produce exactly 3 frames/);
  },
);
