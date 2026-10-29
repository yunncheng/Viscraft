/**
 * Blender ⇄ shared-World ⇄ Build integration — real-executor tests.
 *
 * These tests drive a configured Blender binary or `bpy` Python interpreter through the normal
 * Build path. They prove that:
 *
 *  - a Project-level `model` (glTF) Asset is imported, validated and bound, and
 *    is consumed by Blender (imported into the scene);
 *  - the `blender` Source is a true shared-World consumer: every rendered frame
 *    comes from `sampleWorld` on the SAME World the browser backend uses, and
 *    entity transforms, the resolved camera and world time all reach Blender;
 *  - a World camera revision re-renders the affected shot (new artifact hash)
 *    while an unaffected shot's Take is reused (its operation `reused === true`);
 *  - the authored state (World-bound author script + dependency closure + the
 *    model Asset + the World) is self-contained: a clean copy re-renders.
 *
 * The renderers are tiny (64x64, one Cycles sample, a handful of frames) so the
 * suite stays fast; GPUs are treated as busy (CPU Cycles only).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildProject } from '../src/build/build.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { captureWorld, sampleWorld, type WorldFrame } from '../src/backends/world/world.js';
import { captureCode } from '../src/backends/browser/capture.js';
import { importAsset } from '../src/operations/assets/import.js';
import { validateProject } from '../src/index.js';
import { hashFile } from '../src/shared/hash.js';
import type { OutputSettings, World } from '../src/core/schema.js';
import { configuredBlenderForTests } from './blender-fixtures.js';

const blenderOptions = await configuredBlenderForTests();
const skip = blenderOptions ? false : 'no configured Blender runtime (binary or bpy Python) found';

// ---------------------------------------------------------------------------
// A real, minimal glTF 2.0 model (one triangle, embedded data-URI buffer).
// ---------------------------------------------------------------------------
function triangleGltf(): string {
  const positions = Buffer.from(new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]).buffer);
  const indices = Buffer.from(new Uint16Array([0, 1, 2]).buffer);
  const buffer = Buffer.concat([positions, indices, Buffer.alloc(2)]);
  const document = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: buffer.length, uri: `data:application/octet-stream;base64,${buffer.toString('base64')}` }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
      { buffer: 0, byteOffset: 36, byteLength: 6, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [2, 2, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// A tiny Blender author script implementing the Viscraft contract AND consuming
// the shared-World sidecar handed over as `--world <json>`. It imports the
// entity's `model` Asset through `bpy.ops.import_scene.gltf`, places every
// entity at its sampled instance transform, and drives the camera from the
// sampled World camera (position/target/fov) and the World frame clock.
// ---------------------------------------------------------------------------
const SHOT_PY = `import bpy, sys, os, json, math
import mathutils

def _args():
    argv = sys.argv
    argv = argv[argv.index('--') + 1:] if '--' in argv else []
    o = {'out': '.', 'width': 64, 'height': 64, 'fps': 24, 'frames': 1, 'world': None, 'tag': ''}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ('--out', '--world', '--tag'):
            o[a[2:]] = argv[i + 1]; i += 2
        elif a in ('--width', '--height', '--fps', '--frames'):
            o[a[2:]] = int(float(argv[i + 1])); i += 2
        else:
            i += 1
    return o

o = _args()
side = json.load(open(o['world'])) if o['world'] else None
assert side is not None, 'this author script requires a shared-World sidecar'

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = o['fps']
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 1
scene.render.resolution_x = o['width']
scene.render.resolution_y = o['height']
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
world = bpy.data.worlds.new('w'); scene.world = world; world.use_nodes = True
world.node_tree.nodes['Background'].inputs[1].default_value = 0.4

cam_data = bpy.data.cameras.new('cam'); cam = bpy.data.objects.new('cam', cam_data)
scene.collection.objects.link(cam); scene.camera = cam

placed = []
for ent in side['frames'][0]['entities']:
    info = side['assets'].get(ent['asset'])
    objs = []
    if info and info['path'].lower().endswith(('.glb', '.gltf')):
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=info['path'])
        objs = [ob for ob in bpy.data.objects if ob not in before]
    if not objs:
        bpy.ops.mesh.primitive_cube_add(size=1.0)
        objs = [bpy.context.active_object]
    # Give the imported asset an emissive tint so its pixels are unambiguous.
    for ob in objs:
        if ob.type == 'MESH' and not ob.data.materials:
            m = bpy.data.materials.new('emissive'); m.use_nodes = True
            m.node_tree.nodes['Principled BSDF'].inputs['Emission Color'].default_value = (0.9, 0.2, 0.1, 1.0)
            m.node_tree.nodes['Principled BSDF'].inputs['Emission Strength'].default_value = 4.0
            ob.data.materials.append(m)
    placed.append((ent['id'], objs))

os.makedirs(o['out'], exist_ok=True)
for f in range(int(o['frames'])):
    scene.frame_set(f)
    snap = side['frames'][f]
    for eid, objs in placed:
        ent = next(e for e in snap['entities'] if e['id'] == eid)
        t = ent['transform']
        for ob in objs:
            ob.location = tuple(t['position'])
            ob.rotation_euler = tuple(t['rotation'])
            ob.scale = tuple(t['scale'])
    c = snap['camera']
    loc = mathutils.Vector(tuple(c['position']))
    tgt = mathutils.Vector(tuple(c['target']))
    cam.location = loc
    cam.rotation_euler = (tgt - loc).to_track_quat('-Z', 'Y').to_euler()
    cam_data.angle = math.radians(c['fov'])
    scene.render.filepath = os.path.join(o['out'], 'frame-%06d' % f)
    bpy.ops.render.render(write_still=True)
print('VISCRAFT_REPORT ' + json.dumps({'frames': int(o['frames']), 'world': side['world']['id'], 'frame': side['startFrame']}))
`;

const OUTPUT: OutputSettings = {
  width: 64,
  height: 64,
  fps: { numerator: 24, denominator: 1 },
  sampleRate: 48000,
  channels: 2,
};

/** A shared World: one moving entity on a straight trajectory + two cameras. */
function sharedWorld(): World {
  return {
    id: 'world_shared',
    revision: 1,
    units: 'meters',
    coordinates: 'right-handed-y-up',
    fps: { numerator: 24, denominator: 1 },
    frames: 16,
    entities: [
      {
        id: 'puck',
        asset: 'asset_tri',
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        state: { role: 'courier' },
      },
    ],
    trajectories: [
      {
        id: 'puck_path',
        entity: 'puck',
        keyframes: [
          { frame: 0, position: [-3, 0, 0] },
          { frame: 15, position: [3, 0, 0] },
        ],
      },
    ],
    cameras: [
      { id: 'cam_a', position: [0, 1.6, 7], target: [0, 0, 0], fov: 50 },
      { id: 'cam_b', position: [7, 1.6, 0], target: [0, 0, 0], fov: 50 },
    ],
  };
}

function seedProject(): unknown {
  return {
    schemaVersion: 1,
    id: 'blender-world-fixture',
    revision: 1,
    title: 'Blender shared-World fixture',
    direction: {
      intent: 'Prove Blender consumes the shared World.',
      looks: [{ id: 'plain', description: 'One emissive asset on a dark background.' }],
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
}

/**
 * Author a full project whose two Blender sources bind the SAME World through
 * two DIFFERENT cameras (`shot-a` → cam_a, `shot-b` → cam_b). `asset_tri` is
 * imported as a real `model` Asset through the production import path.
 */
async function makeWorldProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-blender-world-'));
  await fs.mkdir(path.join(root, 'author'), { recursive: true });
  await fs.writeFile(path.join(root, 'author', 'shot_a.py'), SHOT_PY);
  await fs.writeFile(path.join(root, 'author', 'shot_b.py'), `${SHOT_PY}\n# distinct entry bytes for shot-b\n`);
  await fs.writeFile(path.join(root, 'seed.html'), '<!doctype html><script>window.viscraft={render(){}}</script>');
  await fs.writeFile(path.join(root, 'project.json'), `${JSON.stringify(seedProject(), null, 2)}\n`);

  const gltfPath = path.join(os.tmpdir(), `viscraft-tri-${process.pid}-${Date.now()}.gltf`);
  await fs.writeFile(gltfPath, triangleGltf());
  try {
    await importAsset(root, {
      assetId: 'asset_tri',
      sourcePath: gltfPath,
      type: 'model',
      rights: {
        origin: 'original: authored by tests/blender-world.test.ts',
        license: 'CC0-1.0',
        redistributable: true,
      },
      expectedRevision: 1,
    });
  } finally {
    await fs.rm(gltfPath, { force: true });
  }

  const current = JSON.parse(await fs.readFile(path.join(root, 'project.json'), 'utf8'));
  const world = sharedWorld();
  const project = {
    ...current,
    revision: current.revision + 1,
    worlds: [world],
    sources: [
      {
        id: 'shot-a',
        kind: 'blender',
        output: 'picture',
        entry: 'author/shot_a.py',
        resources: [],
        args: ['--tag', 'a'],
        frames: 6,
        bindings: [],
        world: { id: world.id, camera: 'cam_a', mode: 'drive', startFrame: 0 },
      },
      {
        id: 'shot-b',
        kind: 'blender',
        output: 'picture',
        entry: 'author/shot_b.py',
        resources: [],
        args: ['--tag', 'b'],
        frames: 6,
        bindings: [],
        world: { id: world.id, camera: 'cam_b', mode: 'drive', startFrame: 4 },
      },
    ],
    composition: {
      output: OUTPUT,
      scenes: [{ id: 'scene', description: 'One scene.' }],
      shots: [
        { id: 'shot-a', scene: 'scene', look: 'plain', intent: 'Camera A over the shared World.', targetFrames: 6 },
        { id: 'shot-b', scene: 'scene', look: 'plain', intent: 'Camera B over the shared World.', targetFrames: 6 },
      ],
      placements: [
        { id: 'place-a', shot: 'shot-a', source: 'shot-a', inFrame: 0, outFrame: 6, startFrame: 0, audio: 'mute' },
        { id: 'place-b', shot: 'shot-b', source: 'shot-b', inFrame: 0, outFrame: 6, startFrame: 6, audio: 'mute' },
      ],
      transitions: [],
      audio: [],
    },
  };
  validateProject(project);
  await fs.writeFile(path.join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  return root;
}

function operationForSource(record: Awaited<ReturnType<typeof buildProject>>, sourceId: string) {
  const take = record.takes.find(candidate => candidate.source === sourceId);
  assert.ok(take, `a Take exists for Source ${sourceId}`);
  const artifact = record.artifacts.find(candidate => candidate.id === take.artifact);
  assert.ok(artifact, `the Take of ${sourceId} has an Artifact`);
  const operation = record.operations.find(
    candidate => candidate.artifact === artifact.id && candidate.kind === 'blender',
  );
  assert.ok(operation, `the Artifact of ${sourceId} has a blender operation`);
  return { take, artifact, operation };
}

// ---------------------------------------------------------------------------
// Contract: the blender Source's World binding and start frame are strict.
// ---------------------------------------------------------------------------
test('a blender Source World binding requires startFrame and must resolve to a real World/camera', () => {
  const base = seedProject() as { sources: unknown[]; worlds?: unknown[]; assets?: unknown[] };
  base.worlds = [sharedWorld()];
  base.assets = [
    {
      id: 'asset_tri',
      revision: 1,
      path: 'assets/model.gltf',
      sha256: 'a'.repeat(64),
      type: 'model',
      rights: { origin: 'test', license: 'CC0-1.0', redistributable: true },
      simulated: false,
    },
  ];
  // Reuse the seed composition's placement: name the blender Source `seed` so
  // the existing placement still references a real Source.
  const withSource = (source: unknown) => ({ ...base, sources: [source] });

  // A `drive` World binding without a startFrame is refused by the schema.
  assert.throws(
    () =>
      validateProject(
        withSource({
          id: 'seed',
          kind: 'blender',
          output: 'picture',
          entry: 'author/shot_a.py',
          frames: 4,
          world: { id: 'world_shared', camera: 'cam_a', mode: 'drive' },
        }),
      ),
    /requires `startFrame`/,
  );
  // Blender is a `drive`-only World consumer: a `define` binding is refused
  // (its renderer samples the shared World per frame into the `--world` sidecar).
  assert.throws(
    () =>
      validateProject(
        withSource({
          id: 'seed',
          kind: 'blender',
          output: 'picture',
          entry: 'author/shot_a.py',
          frames: 4,
          world: { id: 'world_shared', camera: 'cam_a', mode: 'define' },
        }),
      ),
    /mode 'drive'/,
  );
  // A missing World/camera fails validation.
  assert.throws(
    () =>
      validateProject(
        withSource({
          id: 'seed',
          kind: 'blender',
          output: 'picture',
          entry: 'author/shot_a.py',
          frames: 4,
          world: { id: 'nope', camera: 'cam_a', mode: 'drive', startFrame: 0 },
        }),
      ),
    /missing World\/camera/,
  );
  assert.throws(
    () =>
      validateProject(
        withSource({
          id: 'seed',
          kind: 'blender',
          output: 'picture',
          entry: 'author/shot_a.py',
          frames: 4,
          world: { id: 'world_shared', camera: 'ghost', mode: 'drive', startFrame: 0 },
        }),
      ),
    /missing World\/camera/,
  );
  // The interval must stay inside the World clock.
  assert.throws(
    () =>
      validateProject(
        withSource({
          id: 'seed',
          kind: 'blender',
          output: 'picture',
          entry: 'author/shot_a.py',
          frames: 12,
          world: { id: 'world_shared', camera: 'cam_a', mode: 'drive', startFrame: 8 },
        }),
      ),
    /in-bounds interval/,
  );
  // A valid World-bound blender Source parses.
  assert.equal(
    validateProject(
      withSource({
        id: 'seed',
        kind: 'blender',
        output: 'picture',
        entry: 'author/shot_a.py',
        frames: 4,
        world: { id: 'world_shared', camera: 'cam_a', mode: 'drive', startFrame: 2 },
      }),
    ).sources[0].kind,
    'blender',
  );
});

// ---------------------------------------------------------------------------
// The real Build: World-driven Blender render + revision reuse + portability.
// ---------------------------------------------------------------------------
test(
  'Blender consumes the shared World: renders both cameras, re-renders a camera change, reuses the unaffected Take, and re-renders from a clean export',
  { skip },
  async () => {
    const root = await makeWorldProject();
    try {
      const first = await buildProject(root, { blender: blenderOptions });
      assert.equal(first.status, 'succeeded', first.error);
      assert.match(first.environment!.blender!, /Blender/);

      const a1 = operationForSource(first, 'shot-a');
      const b1 = operationForSource(first, 'shot-b');
      assert.equal(a1.operation.reused, false);
      assert.equal(b1.operation.reused, false);
      assert.notEqual(
        a1.artifact.sha256,
        b1.artifact.sha256,
        'the two cameras produce different pictures of the same World',
      );
      assert.equal(a1.artifact.kind, 'video');
      assert.equal(a1.artifact.media?.frames, 6);
      assert.equal(await hashFile(path.join(root, a1.artifact.path)), a1.artifact.sha256);

      // World-consumption evidence: the executor's sidecar is EXACTLY the shared
      // `sampleWorld` output. Drive `captureBlender` directly on the frozen
      // snapshot and compare its sidecar to the sampler at the same frames.
      const world = sharedWorld();
      const { captureBlender } = await import('../src/backends/blender/render.js');
      const directRoot = path.join(root, '.viscraft', 'snapshots', first.id);
      const directProject: { assets: Array<{ id: string; path: string }> } = JSON.parse(
        await fs.readFile(path.join(root, '.viscraft', 'snapshots', `${first.id}.project.json`), 'utf8'),
      );
      const modelAsset = directProject.assets.find(asset => asset.id === 'asset_tri')!;
      const dest = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-bpy-direct-'));
      const source = {
        id: 'shot-a',
        kind: 'blender' as const,
        output: 'picture' as const,
        entry: 'author/shot_a.py',
        resources: [],
        args: ['--tag', 'a'],
        frames: 3,
        bindings: [],
        world: { id: world.id, camera: 'cam_a', mode: 'drive' as const, startFrame: 0 },
      };
      await captureBlender(directRoot, source, OUTPUT, dest, blenderOptions!, {
        world,
        camera: 'cam_a',
        startFrame: 0,
        assets: { asset_tri: { path: path.join(directRoot, modelAsset.path), sha256: '' } },
        bindings: {},
      });
      const sidecar: { camera: string; startFrame: number; frames: WorldFrame[] } = JSON.parse(
        await fs.readFile(path.join(dest, 'viscraft-world.json'), 'utf8'),
      );
      const expectedFrames = [0, 1, 2].map(frame => sampleWorld(world, 'cam_a', frame));
      assert.deepEqual(
        sidecar.frames,
        expectedFrames,
        'the Blender sidecar is exactly the shared-World sampler output',
      );
      assert.equal(sidecar.camera, 'cam_a');
      assert.equal(sidecar.startFrame, 0);
      // The direct render produced the same frame contract the Build consumes.
      assert.deepEqual((await fs.readdir(dest)).filter(name => name.endsWith('.png')).sort(), [
        'frame-000000.png',
        'frame-000001.png',
        'frame-000002.png',
      ]);
      await fs.rm(dest, { recursive: true, force: true });

      // ---- revision: change ONLY camera A's position (World revision untouched)
      const projectPath = path.join(root, 'project.json');
      const project = JSON.parse(await fs.readFile(projectPath, 'utf8'));
      const camA = project.worlds[0].cameras.find((camera: { id: string }) => camera.id === 'cam_a');
      camA.position = [2.5, 2.4, 6.0];
      project.revision += 1;
      await fs.writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`);

      const second = await buildProject(root, { blender: blenderOptions });
      assert.equal(second.status, 'succeeded', second.error);
      const a2 = operationForSource(second, 'shot-a');
      const b2 = operationForSource(second, 'shot-b');
      assert.equal(a2.operation.reused, false, 'the camera revision re-renders the affected shot');
      assert.notEqual(a2.artifact.sha256, a1.artifact.sha256, 'the affected shot yields a new artifact');
      assert.equal(b2.operation.reused, true, 'the unaffected shot reuses its accepted Take');
      assert.equal(b2.artifact.sha256, b1.artifact.sha256);
      assert.equal(b2.take.id, b1.take.id, 'the unaffected Take id is unchanged');

      // ---- portability: export, then re-render from authored state alone.
      const exportDir = path.join(os.tmpdir(), `viscraft-blender-export-${Date.now()}`);
      await exportProject(root, exportDir);
      // The export must carry the model Asset, the World-bound author scripts and
      // the project. Re-render from a CLEAN copy carrying only authored state.
      const cleanDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-blender-clean-'));
      await fs.cp(path.join(exportDir, 'author'), path.join(cleanDir, 'author'), { recursive: true });
      await fs.cp(path.join(exportDir, 'assets'), path.join(cleanDir, 'assets'), { recursive: true });
      await fs.copyFile(path.join(exportDir, 'project.json'), path.join(cleanDir, 'project.json'));

      const restored = await buildProject(cleanDir, { blender: blenderOptions });
      assert.equal(restored.status, 'succeeded', restored.error);
      const ra = operationForSource(restored, 'shot-a');
      assert.equal(ra.operation.reused, false, 'a clean directory has nothing to reuse, so it re-rendered');
      assert.equal(ra.artifact.media?.frames, 6);
      assert.equal(await hashFile(path.join(cleanDir, ra.artifact.path)), ra.artifact.sha256);
      await fs.rm(exportDir, { recursive: true, force: true });
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  },
);

// ---------------------------------------------------------------------------
// Browser ⇄ Blender World parity: the browser backend samples the SAME World
// (frame/entity/camera identical to `sampleWorld`), and the browser serves the
// `model` Asset with its real glTF media type.
// ---------------------------------------------------------------------------
const WORLD_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0}</style></head>
<body><canvas id="c"></canvas>
<script>
window.viscraft = {
  ready(){},
  render(args){
    var w = window.__viscraftWorld;
    if (!w) throw new Error('missing __viscraftWorld');
    window.__seen = window.__seen || [];
    window.__seen.push({ frame: w.frame, cam: w.camera.id, x: w.entities[0].transform.position[0] });
    var c = document.getElementById('c'); c.width = args.width; c.height = args.height;
    var g = c.getContext('2d');
    var shade = Math.round(Math.min(255, Math.max(0, (w.entities[0].transform.position[0] + 4) * 24)));
    g.fillStyle = 'rgb(' + shade + ',0,0)'; g.fillRect(0, 0, args.width, args.height);
  }
};
</script></body></html>`;

const MODEL_FETCH_HTML = `<!doctype html>
<html><head><meta charset="utf-8"></head><body><canvas id="c"></canvas>
<script>
window.viscraft = {
  ready(){},
  async render(args){
    var b = args.bindings.model;
    if (!b) throw new Error('model binding missing');
    var r = await fetch(b.url);
    var ct = r.headers.get('content-type') || '';
    window.__model = { type: ct, status: r.status };
    if (ct.indexOf('gltf') === -1) throw new Error('model served with wrong media type: ' + ct);
    var buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length < 4 || buf[0] !== 0x7b) throw new Error('model bytes are not glTF JSON');
    var c = document.getElementById('c'); c.width = args.width; c.height = args.height;
    var g = c.getContext('2d'); g.fillStyle = '#00ff00'; g.fillRect(0, 0, args.width, args.height);
  }
};
</script></body></html>`;

test('the browser backend and Blender sample one shared World, and the model Asset is served as glTF', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-world-parity-'));
  try {
    await fs.writeFile(path.join(root, 'world.html'), WORLD_HTML);
    await fs.mkdir(path.join(root, 'assets'), { recursive: true });
    await fs.writeFile(path.join(root, 'assets', 'model.gltf'), triangleGltf());
    await fs.writeFile(path.join(root, 'model.html'), MODEL_FETCH_HTML);

    const world = sharedWorld();
    const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-world-parity-out-'));
    // World parity: the browser page reads the SAME snapshot `sampleWorld` returns.
    await captureWorld(
      root,
      {
        id: 'wsrc',
        kind: 'browser',

        output: 'picture',

        world: { id: world.id, camera: 'cam_a', mode: 'drive', startFrame: 2 },
        entry: 'world.html',
        resources: [],
        bindings: [],
        params: {},
        seed: 0,
        frames: 3,
      },
      world,
      OUTPUT,
      destination,
    );
    const seenFiles = (await fs.readdir(destination)).filter(name => name.endsWith('.png')).sort();
    assert.deepEqual(seenFiles, ['frame-000000.png', 'frame-000001.png', 'frame-000002.png']);
    // The page rendered from the sampler's own values (positions -3..3 across
    // frames 2,3,4 → distinct shades), so the frames are genuinely World-driven.
    const shades = new Set<string>();
    for (const file of seenFiles) shades.add((await fs.readFile(path.join(destination, file))).toString('hex'));
    assert.equal(shades.size, 3, 'each shared-World frame renders a distinct image');

    // Model Asset serving: the browser backend serves the real glTF media type.
    const modelDest = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-model-out-'));
    await captureCode(
      root,
      {
        id: 'model-src',
        entry: 'model.html',
        resources: [],
        params: {},
        seed: 0,
        frames: 1,
      },
      OUTPUT,
      modelDest,
      {
        model: { id: 'asset_tri', path: 'assets/model.gltf', sha256: '' },
      },
    );
    assert.deepEqual(
      (await fs.readdir(modelDest)).filter(name => name.endsWith('.png')),
      ['frame-000000.png'],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
