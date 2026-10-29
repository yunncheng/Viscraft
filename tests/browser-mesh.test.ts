/**
 * Browser ⇄ shared-World ⇄ Blender: REAL glTF mesh rendering.
 *
 * With real headless Chrome, these tests verify:
 *
 *  - a Project `model` Asset that is a REAL binary glTF (`.glb`) is imported
 *    through the production import path and fetched by the browser page;
 *  - the page renders that GLB MESH with `THREE.GLTFLoader` + a real
 *    `THREE.WebGLRenderer` (the addon is vendored and sha256-pinned; the bare
 *    `three` specifier is resolved by an inline import map);
 *  - the loaded object's transform AND the camera come from the SAME shared
 *    `sampleWorld` snapshot the Blender backend consumes — so different World
 *    frames render different pixels, and the introspected geometry is the GLB's;
 *  - Blender's per-frame sidecar is exactly `sampleWorld` on the same World, and
 *    its asset map points at the SAME `.glb` Asset;
 *  - a single World-camera change re-renders the affected browser shot and
 *    reuses the unaffected one (`operation.reused === true`, identical hash).
 *
 * Renders are tiny (64x64 / 96x54, a handful of frames) so the suite stays fast.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureWorld, sampleWorld, type WorldFrame } from '../src/backends/world/world.js';
import { openCodeScene } from '../src/backends/browser/capture.js';
import { importAsset } from '../src/operations/assets/import.js';
import { buildProject } from '../src/build/build.js';
import { validateProject } from '../src/index.js';
import { hashFile } from '../src/shared/hash.js';
import type { OutputSettings, World } from '../src/core/schema.js';
import { configuredBlenderForTests } from './blender-fixtures.js';

// ---------------------------------------------------------------------------
// Fixtures live in tests/fixtures/authoring/mesh so the page, the World and the GLB bytes have
// a single definition shared with the evidence render script.
// ---------------------------------------------------------------------------
const PAGE = fileURLToPath(new URL('../../tests/fixtures/authoring/mesh/mesh-world.html', import.meta.url));
const LIB_URL = new URL('../../tests/fixtures/authoring/mesh/lib.mjs', import.meta.url).href;
const VENDOR_URL = new URL('../../tests/fixtures/authoring/lib/three-vendor.mjs', import.meta.url).href;

interface MeshLib {
  MODEL_BINDING: string;
  MODEL_ASSET_ID: string;
  VENDOR_RESOURCES: string[];
  SLAB_FACTS: { vertexCount: number; triangleCount: number; meshCount: number; bboxMin: number[]; bboxMax: number[] };
  slabGlb: () => Buffer;
  makeWorld: () => World;
}
interface VendorLib {
  loadVerifiedThree: () => Promise<Array<{ dest: string; sha256: string; bytes: Buffer }>>;
  loadVerifiedThreeAddons: () => Promise<Array<{ dest: string; sha256: string; bytes: Buffer }>>;
  verifyFileSet: (
    dir: string,
    keys: string[],
    files: Record<string, { source: string; dest: string; sha256: string }>,
  ) => Promise<Array<{ dest: string; actual: string }>>;
  resolveThreeDirectory: (explicit?: string) => string;
  THREE_ADDON_FILES: Record<string, { source: string; dest: string; sha256: string }>;
  THREE_ADDON_KEYS: string[];
}

const lib = (await import(LIB_URL)) as MeshLib;
const vendor = (await import(VENDOR_URL)) as VendorLib;

const MODEL_BINDING = lib.MODEL_BINDING;
const MODEL_ASSET_ID = lib.MODEL_ASSET_ID;
const VENDOR_RESOURCES = lib.VENDOR_RESOURCES;
const MODEL_RIGHTS = {
  origin: 'original: authored by tests/browser-mesh.test.ts',
  license: 'CC0-1.0',
  redistributable: true,
};

/** A Project root carrying the authored page, the vendored engine closure and the GLB Asset. */
async function browserFixture(): Promise<{ root: string; glb: Buffer }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-browser-mesh-'));
  await fs.copyFile(PAGE, path.join(root, 'mesh-world.html'));
  await fs.mkdir(path.join(root, 'assets'), { recursive: true });
  const glb = lib.slabGlb();
  await fs.writeFile(path.join(root, 'assets', 'asset_slab.glb'), glb);
  for (const file of [...(await vendor.loadVerifiedThree()), ...(await vendor.loadVerifiedThreeAddons())]) {
    const destination = path.join(root, ...file.dest.split('/'));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, file.bytes);
  }
  // A seed Project so the production `importAsset` path has a project to admit
  // the GLB into (the World-bound sources replace it later).
  await fs.writeFile(path.join(root, 'seed.html'), '<!doctype html><script>window.viscraft={render(){}}</script>');
  const seed = {
    schemaVersion: 1,
    id: 'browser-mesh-fixture',
    revision: 1,
    title: 'Browser shared-World mesh fixture',
    direction: {
      intent: 'Seed.',
      looks: [{ id: 'plain', description: 'One lit GLB slab on a dark field.' }],
      transitions: [],
    },
    assets: [],
    bindings: {},
    sources: [
      {
        id: 'seed',
        kind: 'browser',
        output: 'picture',
        entry: 'seed.html',
        resources: [],
        bindings: [],
        params: {},
        seed: 0,
        frames: 1,
      },
    ],
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: 'One scene.' }],
      shots: [{ id: 'seed-shot', scene: 'scene', look: 'plain', intent: 'Seed.', targetFrames: 1 }],
      placements: [
        { id: 'seed-place', shot: 'seed-shot', source: 'seed', inFrame: 0, outFrame: 1, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio: [],
    },
  };
  validateProject(seed);
  await fs.writeFile(path.join(root, 'project.json'), `${JSON.stringify(seed, null, 2)}\n`);
  return { root, glb };
}

const OUTPUT: OutputSettings = {
  width: 96,
  height: 54,
  fps: { numerator: 24, denominator: 1 },
  sampleRate: 48000,
  channels: 2,
};
const TINY: OutputSettings = {
  width: 64,
  height: 64,
  fps: { numerator: 24, denominator: 1 },
  sampleRate: 48000,
  channels: 2,
};

/** Decode a PNG to raw RGB via ffmpeg (no PNG decoder dependency in Node). */
function rgbPixels(file: string): Buffer {
  const result = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostdin', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 1 << 24 },
  );
  assert.equal(result.status, 0, `ffmpeg decode failed for ${file}: ${result.stderr?.toString() ?? ''}`);
  return result.stdout;
}

const BACKGROUND = [16, 19, 25]; // matches the page's clear colour 0x101319

function countNonBackground(pixels: Buffer): number {
  let count = 0;
  for (let i = 0; i < pixels.length; i += 3) {
    const distance =
      Math.abs(pixels[i] - BACKGROUND[0]) +
      Math.abs(pixels[i + 1] - BACKGROUND[1]) +
      Math.abs(pixels[i + 2] - BACKGROUND[2]);
    if (distance > 30) count++;
  }
  return count;
}

const BLENDER = await configuredBlenderForTests();

// ---------------------------------------------------------------------------
// The addon vendoring surface: pinned + verified, and the existing build API is
// untouched.
// ---------------------------------------------------------------------------
test('three-vendor pins and verifies the GLTFLoader addon closure without changing the core API', async () => {
  const core = await vendor.loadVerifiedThree();
  assert.deepEqual(
    core.map(file => file.dest),
    ['vendor/three.module.js', 'vendor/three.core.js', 'vendor/LICENSE'],
  );

  const addons = await vendor.loadVerifiedThreeAddons();
  assert.deepEqual(
    addons.map(file => file.dest),
    [
      'vendor/addons/loaders/GLTFLoader.js',
      'vendor/addons/utils/BufferGeometryUtils.js',
      'vendor/addons/utils/SkeletonUtils.js',
    ],
  );
  for (const file of addons) assert.ok(file.bytes.length > 0);
  // The loader really does import the BARE specifier `three` (so the page's
  // import map is load-bearing, not decorative) and its relative utils.
  const loaderSource = addons[0].bytes.toString('utf8');
  assert.match(loaderSource, /from 'three'/);
  assert.match(loaderSource, /from '\.\.\/utils\/BufferGeometryUtils\.js'/);
  assert.match(loaderSource, /from '\.\.\/utils\/SkeletonUtils\.js'/);

  // A tampered expected hash is refused BEFORE any bytes are adopted.
  const threeDir = vendor.resolveThreeDirectory();
  await assert.rejects(
    vendor.verifyFileSet(threeDir, ['gltfLoader'], {
      gltfLoader: { ...vendor.THREE_ADDON_FILES.gltfLoader, sha256: '0'.repeat(64) },
    }),
    /refusing to adopt unverified three\.js bytes/,
  );
});

// ---------------------------------------------------------------------------
// The real browser GLB mesh render, driven by the shared World.
// ---------------------------------------------------------------------------
test('the browser renders the real GLB mesh via GLTFLoader, placed and filmed by the shared World', async () => {
  const { root, glb } = await browserFixture();
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-browser-mesh-out-'));
  try {
    const world = lib.makeWorld();
    const source = {
      id: 'mesh',
      kind: 'browser' as const,
      output: 'picture' as const,
      world: { id: world.id, camera: 'cam_a', mode: 'drive' as const, startFrame: 0 },
      entry: 'mesh-world.html',
      resources: VENDOR_RESOURCES,
      bindings: [MODEL_BINDING],
      params: {},
      seed: 0,
      frames: 4,
    };
    const bindings = { [MODEL_BINDING]: { id: MODEL_ASSET_ID, path: 'assets/asset_slab.glb', sha256: '' } };
    const result = await captureWorld(root, source, world, OUTPUT, destination, bindings);
    assert.match(result.browserVersion, /Chrome|Chromium/);

    const frames = (await fs.readdir(destination)).filter(name => name.endsWith('.png')).sort();
    assert.deepEqual(frames, ['frame-000000.png', 'frame-000001.png', 'frame-000002.png', 'frame-000003.png']);

    // (a) The mesh is actually drawn: every frame has a non-trivial slab silhouette.
    const silhouettes: number[] = [];
    for (const name of frames) silhouettes.push(countNonBackground(rgbPixels(path.join(destination, name))));
    for (const count of silhouettes)
      assert.ok(count > 120, `the GLB mesh silhouette is visible (got ${count} non-background pixels)`);
    // (b) The World drives the picture: different frames -> different bytes.
    const hashes = new Set<string>();
    for (const name of frames) hashes.add((await fs.readFile(path.join(destination, name))).toString('hex'));
    assert.equal(hashes.size, frames.length, 'each shared-World frame renders a distinct image');

    // (c) The rendered object IS the GLB, and its placement came from sampleWorld.
    const scene = await openCodeScene(
      root,
      { entry: 'mesh-world.html', resources: VENDOR_RESOURCES },
      { width: OUTPUT.width, height: OUTPUT.height },
      { label: 'browser-mesh', globalName: 'viscraft' },
      {},
      bindings,
    );
    try {
      const frame = 3;
      const snapshot = sampleWorld(world, 'cam_a', frame);
      await scene.page.evaluate(value => {
        (globalThis as unknown as { __viscraftWorld: unknown }).__viscraftWorld = value;
      }, snapshot);
      await scene.page.evaluate(
        async args => {
          const v = (globalThis as unknown as { viscraft: { render: (a: unknown) => Promise<void> } }).viscraft;
          await v.render(args);
        },
        {
          frame,
          time: frame / 24,
          fps: 24,
          width: OUTPUT.width,
          height: OUTPUT.height,
          seed: 0,
          params: {},
          bindings: scene.bindings,
        },
      );
      const report = (await scene.page.evaluate(
        () => (globalThis as unknown as { __meshReport: unknown }).__meshReport,
      )) as {
        assetId: string;
        sourceUrl: string;
        vertexCount: number;
        triangleCount: number;
        meshCount: number;
        bboxMin: number[];
        bboxMax: number[];
        frames: Array<{ frame: number; entity: string; position: number[] }>;
      };
      assert.equal(report.assetId, MODEL_ASSET_ID);
      assert.match(report.sourceUrl, /asset_slab\.glb$/);
      assert.equal(report.vertexCount, lib.SLAB_FACTS.vertexCount);
      assert.equal(report.triangleCount, lib.SLAB_FACTS.triangleCount);
      assert.equal(report.meshCount, lib.SLAB_FACTS.meshCount);
      for (let i = 0; i < 3; i++) {
        assert.ok(Math.abs(report.bboxMin[i] - lib.SLAB_FACTS.bboxMin[i]) < 1e-5, `bboxMin[${i}]`);
        assert.ok(Math.abs(report.bboxMax[i] - lib.SLAB_FACTS.bboxMax[i]) < 1e-5, `bboxMax[${i}]`);
      }
      assert.equal(report.frames.length, 1);
      assert.equal(report.frames[0].frame, frame);
      assert.equal(report.frames[0].entity, 'slab');
      const expected = snapshot.entities[0].transform.position;
      for (let i = 0; i < 3; i++)
        assert.ok(
          Math.abs(report.frames[0].position[i] - expected[i]) < 1e-9,
          'the placed transform is the sampled World transform',
        );
    } finally {
      await scene.close();
    }
    assert.ok(glb.length > 100);
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(destination, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// Cross-backend parity: Blender's sidecar is the same `sampleWorld`, over the
// same GLB Asset.
// ---------------------------------------------------------------------------
const SHOT_PY = `import bpy, sys, os, json, math
import mathutils

def _args():
    argv = sys.argv
    argv = argv[argv.index('--') + 1:] if '--' in argv else []
    o = {'out': '.', 'width': 64, 'height': 64, 'fps': 24, 'frames': 1, 'world': None}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ('--out', '--world'):
            o[a[2:]] = argv[i + 1]; i += 2
        elif a in ('--width', '--height', '--fps', '--frames'):
            o[a[2:]] = int(float(argv[i + 1])); i += 2
        else:
            i += 1
    return o

o = _args()
side = json.load(open(o['world']))

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'; scene.cycles.device = 'CPU'; scene.cycles.samples = 1
scene.render.resolution_x = o['width']; scene.render.resolution_y = o['height']; scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
w = bpy.data.worlds.new('w'); scene.world = w; w.use_nodes = True
w.node_tree.nodes['Background'].inputs[1].default_value = 0.4
cam_data = bpy.data.cameras.new('cam'); cam = bpy.data.objects.new('cam', cam_data)
scene.collection.objects.link(cam); scene.camera = cam

placed = []
for ent in side['frames'][0]['entities']:
    info = side['assets'].get(ent['asset'])
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=info['path'])
    placed.append((ent['id'], [ob for ob in bpy.data.objects if ob not in before]))

os.makedirs(o['out'], exist_ok=True)
for f in range(int(o['frames'])):
    snap = side['frames'][f]
    for eid, objs in placed:
        t = next(e for e in snap['entities'] if e['id'] == eid)['transform']
        for ob in objs:
            ob.location = tuple(t['position']); ob.rotation_euler = tuple(t['rotation']); ob.scale = tuple(t['scale'])
    c = snap['camera']
    loc = mathutils.Vector(tuple(c['position'])); tgt = mathutils.Vector(tuple(c['target']))
    cam.location = loc; cam.rotation_euler = (tgt - loc).to_track_quat('-Z', 'Y').to_euler(); cam_data.angle = math.radians(c['fov'])
    scene.render.filepath = os.path.join(o['out'], 'frame-%06d' % f)
    bpy.ops.render.render(write_still=True)
print('VISCRAFT_REPORT ' + json.dumps({'frames': int(o['frames'])}))
`;

test(
  'Blender and the browser consume one shared World and the same GLB Asset',
  { skip: BLENDER ? false : 'no Blender or bpy runtime configured' },
  async () => {
    const { root } = await browserFixture();
    try {
      await fs.mkdir(path.join(root, 'author'), { recursive: true });
      await fs.writeFile(path.join(root, 'author', 'shot.py'), SHOT_PY);
      const world = lib.makeWorld();
      const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-mesh-bpy-'));
      const { captureBlender } = await import('../src/backends/blender/render.js');
      const source = {
        id: 'mesh-bpy',
        kind: 'blender' as const,
        output: 'picture' as const,
        entry: 'author/shot.py',
        resources: [],
        args: [],
        frames: 3,
        bindings: [],
        world: { id: world.id, camera: 'cam_a', mode: 'drive' as const, startFrame: 0 },
      };
      const modelPath = path.join(root, 'assets', 'asset_slab.glb');
      await captureBlender(root, source, TINY, destination, BLENDER!, {
        world,
        camera: 'cam_a',
        startFrame: 0,
        assets: { [MODEL_ASSET_ID]: { path: modelPath, sha256: '' } },
        bindings: {},
      });
      const sidecar = JSON.parse(await fs.readFile(path.join(destination, 'viscraft-world.json'), 'utf8')) as {
        camera: string;
        startFrame: number;
        assets: Record<string, { path: string }>;
        frames: WorldFrame[];
      };
      const expected = [0, 1, 2].map(frame => sampleWorld(world, 'cam_a', frame));
      assert.deepEqual(sidecar.frames, expected, 'the Blender sidecar is exactly the shared-World sampler output');
      assert.equal(sidecar.camera, 'cam_a');
      assert.equal(
        sidecar.assets[MODEL_ASSET_ID].path,
        modelPath,
        'Blender imports the SAME GLB Asset the browser loads',
      );
      assert.deepEqual((await fs.readdir(destination)).filter(name => name.endsWith('.png')).sort(), [
        'frame-000000.png',
        'frame-000001.png',
        'frame-000002.png',
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  },
);

// ---------------------------------------------------------------------------
// A World camera change re-renders the affected browser shot; the unaffected
// shot reuses its accepted Take.
// ---------------------------------------------------------------------------
async function makeWorldProject(): Promise<{ root: string; world: World }> {
  const { root } = await browserFixture();
  const glbPath = path.join(os.tmpdir(), `viscraft-slab-${process.pid}-${Date.now()}.glb`);
  await fs.writeFile(glbPath, lib.slabGlb());
  try {
    await importAsset(root, {
      assetId: MODEL_ASSET_ID,
      sourcePath: glbPath,
      type: 'model',
      rights: MODEL_RIGHTS,
      expectedRevision: 1,
    });
  } finally {
    await fs.rm(glbPath, { force: true });
  }
  const world = lib.makeWorld();
  const project = {
    schemaVersion: 1,
    id: 'browser-mesh-fixture',
    revision: 2,
    title: 'Browser shared-World mesh fixture',
    direction: {
      intent: 'Prove the browser renders a shared-World GLB mesh.',
      looks: [{ id: 'plain', description: 'One lit GLB slab on a dark field.' }],
      transitions: [],
    },
    assets: JSON.parse(await fs.readFile(path.join(root, 'project.json'), 'utf8')).assets,
    bindings: { [MODEL_BINDING]: MODEL_ASSET_ID },
    worlds: [world],
    sources: [
      {
        id: 'shot-a',
        kind: 'browser',

        output: 'picture',

        world: { id: world.id, camera: 'cam_a', mode: 'drive', startFrame: 0 },
        entry: 'mesh-world.html',
        resources: VENDOR_RESOURCES,
        bindings: [MODEL_BINDING],
        params: {},
        seed: 0,
        frames: 3,
      },
      {
        id: 'shot-b',
        kind: 'browser',

        output: 'picture',

        world: { id: world.id, camera: 'cam_b', mode: 'drive', startFrame: 4 },
        entry: 'mesh-world.html',
        resources: VENDOR_RESOURCES,
        bindings: [MODEL_BINDING],
        params: {},
        seed: 0,
        frames: 3,
      },
    ],
    composition: {
      output: TINY,
      scenes: [{ id: 'scene', description: 'One scene.' }],
      shots: [
        { id: 'shot-a', scene: 'scene', look: 'plain', intent: 'Camera A over the shared World.', targetFrames: 3 },
        { id: 'shot-b', scene: 'scene', look: 'plain', intent: 'Camera B over the shared World.', targetFrames: 3 },
      ],
      placements: [
        { id: 'place-a', shot: 'shot-a', source: 'shot-a', inFrame: 0, outFrame: 3, startFrame: 0, audio: 'mute' },
        { id: 'place-b', shot: 'shot-b', source: 'shot-b', inFrame: 0, outFrame: 3, startFrame: 3, audio: 'mute' },
      ],
      transitions: [],
      audio: [],
    },
  };
  validateProject(project);
  await fs.writeFile(path.join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  return { root, world };
}

test('a World camera change re-renders the affected browser shot and reuses the unaffected one', async () => {
  const { root } = await makeWorldProject();
  try {
    const operationFor = (record: Awaited<ReturnType<typeof buildProject>>, sourceId: string) => {
      const take = record.takes.find(candidate => candidate.source === sourceId);
      assert.ok(take, `a Take exists for ${sourceId}`);
      const artifact = record.artifacts.find(candidate => candidate.id === take.artifact);
      assert.ok(artifact);
      const operation = record.operations.find(
        candidate => candidate.artifact === artifact.id && candidate.kind === 'browser',
      );
      assert.ok(operation, `a world operation exists for ${sourceId}`);
      return { take, artifact, operation };
    };

    const first = await buildProject(root);
    assert.equal(first.status, 'succeeded', first.error);
    const a1 = operationFor(first, 'shot-a');
    const b1 = operationFor(first, 'shot-b');
    assert.equal(a1.operation.reused, false);
    assert.equal(b1.operation.reused, false);
    assert.notEqual(
      a1.artifact.sha256,
      b1.artifact.sha256,
      'the two cameras render different pictures of the same World',
    );
    assert.equal(await hashFile(path.join(root, a1.artifact.path)), a1.artifact.sha256);

    // Change ONLY camera A's position (World revision untouched, project +1).
    const projectPath = path.join(root, 'project.json');
    const project = JSON.parse(await fs.readFile(projectPath, 'utf8'));
    project.worlds[0].cameras.find((camera: { id: string }) => camera.id === 'cam_a').position = [2.4, 2.2, 5.6];
    project.revision += 1;
    await fs.writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`);

    const second = await buildProject(root);
    assert.equal(second.status, 'succeeded', second.error);
    const a2 = operationFor(second, 'shot-a');
    const b2 = operationFor(second, 'shot-b');
    assert.equal(a2.operation.reused, false, 'the camera revision re-renders the affected shot');
    assert.notEqual(a2.artifact.sha256, a1.artifact.sha256, 'the affected shot yields a new artifact');
    assert.equal(b2.operation.reused, true, 'the unaffected shot reuses its accepted Take');
    assert.equal(b2.artifact.sha256, b1.artifact.sha256);
    assert.equal(b2.take.id, b1.take.id, 'the unaffected Take id is unchanged');
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
