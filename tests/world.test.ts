import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sampleWorld, captureWorld } from '../src/backends/world/world.js';
import type { OutputSettings, World, BrowserPictureSource } from '../src/core/schema.js';
import { WorldSchema } from '../src/core/schema.js';

const OUTPUT: OutputSettings = {
  width: 32,
  height: 32,
  fps: { numerator: 5, denominator: 1 },
  sampleRate: 48000,
  channels: 1,
};

/**
 * Fixture World covering every sampling rule:
 * - `car` has a trajectory with an optional rotation on one keyframe only.
 * - `drone` has a trajectory whose first keyframe is not frame 0 (endpoint hold),
 *   and a base transform far from the trajectory (proving trajectory override).
 * - `rock` has no trajectory (base transform).
 * - three cameras: two plain (cross-camera invariance) and one following `car`.
 */
function baseWorld(overrides: Partial<World> = {}): World {
  return {
    id: 'world_a',
    revision: 3,
    units: 'meters',
    coordinates: 'right-handed-y-up',
    fps: { numerator: 5, denominator: 1 },
    frames: 10,
    entities: [
      {
        id: 'car',
        asset: 'asset_car',
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        state: { health: 1 },
      },
      {
        id: 'rock',
        asset: 'asset_rock',
        transform: { position: [5, 1, 0], rotation: [0, 0, 0], scale: [2, 2, 2] },
        state: {},
      },
      {
        id: 'drone',
        asset: 'asset_drone',
        transform: { position: [100, 100, 100], rotation: [0.25, 0.5, 0.75], scale: [1, 1, 1] },
        state: { battery: 0.5 },
      },
    ],
    trajectories: [
      {
        id: 'car_path',
        entity: 'car',
        keyframes: [
          { frame: 0, position: [0, 0, 0] },
          { frame: 4, position: [10, 0, 0], rotation: [0, Math.PI / 2, 0] },
          { frame: 8, position: [10, 0, 10] },
        ],
      },
      {
        id: 'drone_path',
        entity: 'drone',
        keyframes: [
          { frame: 3, position: [1, 1, 1] },
          { frame: 6, position: [2, 2, 2] },
        ],
      },
    ],
    cameras: [
      { id: 'cam_main', position: [0, 2, -5], target: [0, 0, 0], fov: 50 },
      { id: 'cam_top', position: [0, 10, 0], target: [0, 0, 0], fov: 30 },
      { id: 'cam_follow', position: [0, 0, -8], target: [0, 0, 0], fov: 60, follow: 'car' },
    ],
    ...overrides,
  };
}

function worldSource(overrides: Partial<BrowserPictureSource> = {}): BrowserPictureSource {
  return {
    id: 'wsrc',
    kind: 'browser',

    output: 'picture',

    world: { id: 'world_a', camera: 'cam_main', mode: 'drive', startFrame: 0 },
    entry: 'index.html',
    resources: [],
    bindings: [],
    params: {},
    seed: 0,
    frames: 3,
    ...overrides,
  };
}

function entity(world: World, cameraId: string, frame: number, id: string) {
  const sample = sampleWorld(world, cameraId, frame);
  const found = sample.entities.find(candidate => candidate.id === id);
  assert.ok(found, `entity ${id} should be sampled`);
  return found;
}

function closeVec(actual: number[], expected: number[], message: string): void {
  assert.equal(actual.length, expected.length, message);
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Math.abs(actual[i] - expected[i]) < 1e-9, `${message}: index ${i} got ${actual[i]}, want ${expected[i]}`);
  }
}

test('sampleWorld carries world identity/clock and uses base transforms without trajectories', () => {
  const frame = sampleWorld(baseWorld(), 'cam_main', 2);
  assert.equal(frame.id, 'world_a');
  assert.equal(frame.revision, 3);
  assert.equal(frame.frame, 2);
  assert.deepEqual(frame.fps, { numerator: 5, denominator: 1 });
  assert.equal(frame.units, 'meters');
  assert.equal(frame.coordinates, 'right-handed-y-up');

  assert.equal(frame.camera.id, 'cam_main');
  assert.deepEqual(frame.camera.position, [0, 2, -5]);
  assert.deepEqual(frame.camera.target, [0, 0, 0]);
  assert.equal(frame.camera.fov, 50);
  assert.equal(frame.camera.follow, undefined);

  const rock = entity(baseWorld(), 'cam_main', 2, 'rock');
  assert.deepEqual(rock.transform.position, [5, 1, 0]);
  assert.deepEqual(rock.transform.rotation, [0, 0, 0]);
  assert.deepEqual(rock.transform.scale, [2, 2, 2]);

  const car = entity(baseWorld(), 'cam_main', 2, 'car');
  assert.deepEqual(car.state, { health: 1 });
  assert.deepEqual(car.transform.scale, [1, 1, 1]);
});

test('sampleWorld linearly interpolates position and holds keyframe endpoints', () => {
  // Midpoint between k0([0,0,0]) and k1([10,0,0]).
  const car2 = entity(baseWorld(), 'cam_main', 2, 'car');
  assert.deepEqual(car2.transform.position, [5, 0, 0]);

  // Midpoint between k1 and k2([10,0,10]).
  const car6 = entity(baseWorld(), 'cam_main', 6, 'car');
  assert.deepEqual(car6.transform.position, [10, 0, 5]);

  // At and past the final keyframe the last value is held.
  const car9 = entity(baseWorld(), 'cam_main', 9, 'car');
  assert.deepEqual(car9.transform.position, [10, 0, 10]);

  // Before the first keyframe (drone starts at frame 3) the first value is held,
  // and the trajectory overrides the far-away base position.
  const drone0 = entity(baseWorld(), 'cam_main', 0, 'drone');
  assert.deepEqual(drone0.transform.position, [1, 1, 1]);
  const drone9 = entity(baseWorld(), 'cam_main', 9, 'drone');
  assert.deepEqual(drone9.transform.position, [2, 2, 2]);
  const drone4 = entity(baseWorld(), 'cam_main', 4, 'drone');
  closeVec(drone4.transform.position, [4 / 3, 4 / 3, 4 / 3], 'drone interpolates between frames 3 and 6');
});

test('sampleWorld interpolates optional rotation with base-transform fallback', () => {
  // k0 has no rotation (falls back to base [0,0,0]); k1 defines [0, PI/2, 0].
  const car2 = entity(baseWorld(), 'cam_main', 2, 'car');
  closeVec(car2.transform.rotation, [0, Math.PI / 4, 0], 'rotation between k0 and k1');

  // k1 defines [0, PI/2, 0]; k2 has no rotation (base [0,0,0]).
  const car6 = entity(baseWorld(), 'cam_main', 6, 'car');
  closeVec(car6.transform.rotation, [0, Math.PI / 4, 0], 'rotation between k1 and k2');

  // Held final keyframe returns the base rotation, not the previous segment value.
  const car9 = entity(baseWorld(), 'cam_main', 9, 'car');
  closeVec(car9.transform.rotation, [0, 0, 0], 'held rotation at final keyframe');

  // Drone keyframes define no rotation, so the base rotation is preserved.
  const drone4 = entity(baseWorld(), 'cam_main', 4, 'drone');
  closeVec(drone4.transform.rotation, [0.25, 0.5, 0.75], 'drone base rotation preserved');
});

test('sampleWorld is deterministic and entity sampling is independent of camera', () => {
  const world = baseWorld();
  const first = sampleWorld(world, 'cam_main', 4);
  const second = sampleWorld(world, 'cam_main', 4);
  assert.deepEqual(first, second);

  const other = sampleWorld(world, 'cam_top', 4);
  assert.deepEqual(other.entities, first.entities);
  assert.notDeepEqual(other.camera, first.camera);
  assert.deepEqual(other.camera.position, [0, 10, 0]);
});

test('sampleWorld resolves a follow camera from the entity local frame', () => {
  const world = baseWorld();

  // Frame 0: car at origin with no rotation -> offsets applied as authored.
  const at0 = sampleWorld(world, 'cam_follow', 0);
  closeVec(at0.camera.position, [0, 0, -8], 'follow camera offset at rest');
  closeVec(at0.camera.target, [0, 0, 0], 'follow camera target at rest');
  assert.equal(at0.camera.follow, 'car');

  // Frame 4: car at [10,0,0] rotated +90deg about Y -> trailing offset rotates to [-8,0,0].
  const at4 = sampleWorld(world, 'cam_follow', 4);
  closeVec(at4.camera.position, [2, 0, 0], 'follow camera offset after turn');
  closeVec(at4.camera.target, [10, 0, 0], 'follow camera target tracks entity');
});

test('sampleWorld rejects out-of-bounds frames and unknown cameras', () => {
  const world = baseWorld();
  assert.throws(() => sampleWorld(world, 'cam_main', 10), /outside World "world_a" clock \[0, 10\)/);
  assert.throws(() => sampleWorld(world, 'cam_main', -1), /outside World/);
  assert.throws(() => sampleWorld(world, 'cam_main', 1.5), /outside World/);
  assert.throws(() => sampleWorld(world, 'nope', 1), /has no camera "nope"/);
});

function splineWorld(keys: World['trajectories'][number]['keyframes'], closed = false): World {
  return WorldSchema.parse(
    baseWorld({
      frames: keys[keys.length - 1].frame + 2,
      trajectories: [
        { id: 'car_path', entity: 'car', path: 'catmull-rom', heading: 'tangent', closed, keyframes: keys },
      ],
    }),
  );
}

test('World spline preserves time velocity across unevenly spaced keys and follow camera', () => {
  // Same intended 1 m/frame speed on either side of the middle keys. Index-space
  // interpolation makes it jump 8x at frame 100 despite the straight path.
  const world = splineWorld([
    { frame: 0, position: [0, 0, 0] },
    { frame: 100, position: [100, 0, 0] },
    { frame: 900, position: [900, 0, 0] },
    { frame: 1000, position: [1000, 0, 0] },
  ]);
  for (const key of [100, 900]) {
    const left = sampleWorld(world, 'cam_follow', key - 1);
    const mid = sampleWorld(world, 'cam_follow', key);
    const right = sampleWorld(world, 'cam_follow', key + 1);
    assert.equal(mid.entities[0].transform.position[0], key);
    for (const side of [
      mid.entities[0].transform.position[0] - left.entities[0].transform.position[0],
      right.entities[0].transform.position[0] - mid.entities[0].transform.position[0],
      mid.camera.position[0] - left.camera.position[0],
      right.camera.position[0] - mid.camera.position[0],
    ]) {
      assert.ok(Math.abs(side - 1) < 0.011, `velocity around frame ${key}: ${side}`);
    }
  }
  const expected = sampleWorld(world, 'cam_follow', 901);
  for (const frame of [1, 900, 999, 100, 901, 0]) sampleWorld(world, 'cam_top', frame);
  assert.deepEqual(
    sampleWorld(world, 'cam_follow', 901),
    expected,
    'seeking order and camera selection cannot affect motion',
  );
});

test('World closed spline uses loop-time neighbours at an uneven seam', () => {
  const world = splineWorld(
    [
      { frame: 0, position: [0, 0, 0] },
      { frame: 1000, position: [10, 0, 0] },
      { frame: 3000, position: [10, 0, 10] },
      { frame: 6000, position: [0, 0, 10] },
      { frame: 10000, position: [0, 0, 0] },
    ],
    true,
  );
  const a = entity(world, 'cam_main', 1, 'car').transform;
  const b = entity(world, 'cam_main', 9999, 'car').transform;
  // Dense frame spacing makes one-frame differences a useful velocity estimate.
  for (const axis of [0, 2])
    assert.ok(Math.abs(a.position[axis] + b.position[axis]) < 0.00003, 'seam velocity must agree from both sides');
  const r0 = entity(world, 'cam_main', 0, 'car').transform.rotation[1];
  const r1 = entity(world, 'cam_main', 10000, 'car').transform.rotation[1];
  assert.ok(Math.abs(Math.sin(r0) - Math.sin(r1)) < 1e-9);
  assert.ok(Math.abs(Math.cos(r0) - Math.cos(r1)) < 1e-9);
  let previous = r0;
  for (let f = 1; f <= 10000; f++) {
    const yaw = entity(world, 'cam_main', f, 'car').transform.rotation[1];
    assert.ok(Math.abs(yaw - previous) < 0.02, `derived yaw wraps or jumps at ${f}`);
    previous = yaw;
  }
});

test('World spline closure is rejected by the schema before capture', () => {
  const invalidKeys: World['trajectories'][number]['keyframes'][] = [
    [{ frame: 0, position: [0, 0, 0] }],
    [
      { frame: 0, position: [0, 0, 0] },
      { frame: 3, position: [1, 0, 0] },
      { frame: 6, position: [2, 0, 0] },
    ],
  ];
  for (const keys of invalidKeys) {
    assert.throws(
      () =>
        WorldSchema.parse(
          baseWorld({
            trajectories: [{ id: 'car_path', entity: 'car', path: 'catmull-rom', closed: true, keyframes: keys }],
          }),
        ),
      /closed spline/,
    );
  }
});

test('World linear tangent heading retains authored corners instead of silently smoothing', () => {
  const world = baseWorld({ trajectories: [{ ...baseWorld().trajectories[0], heading: 'tangent' }] });
  assert.ok(
    Math.abs(
      entity(world, 'cam_main', 5, 'car').transform.rotation[1] -
        entity(world, 'cam_main', 3, 'car').transform.rotation[1],
    ) > 1,
    'a linear corner is intentional path geometry',
  );
});

test('captureWorld fails fast on an inconsistent source/world before launching a browser', async () => {
  const world = baseWorld();
  const destination = path.join(os.tmpdir(), 'viscraft-world-unused');
  await assert.rejects(
    captureWorld(
      '/tmp/does-not-matter',
      worldSource({ world: { id: 'other', camera: 'cam_main', mode: 'drive', startFrame: 0 } }),
      world,
      OUTPUT,
      destination,
    ),
    /references World "other"/,
  );
  await assert.rejects(
    captureWorld(
      '/tmp/does-not-matter',
      worldSource({ world: { id: 'world_a', camera: 'ghost', mode: 'drive', startFrame: 0 } }),
      world,
      OUTPUT,
      destination,
    ),
    /has no camera "ghost"/,
  );
  await assert.rejects(
    captureWorld(
      '/tmp/does-not-matter',
      worldSource(),
      world,
      { ...OUTPUT, fps: { numerator: 2, denominator: 1 } },
      destination,
    ),
    /does not match World "world_a" frame grid/,
  );
  await assert.rejects(
    captureWorld(
      '/tmp/does-not-matter',
      worldSource({ world: { id: 'world_a', camera: 'cam_main', mode: 'drive', startFrame: 8 } }),
      world,
      OUTPUT,
      destination,
    ),
    /exceeds World "world_a" clock/,
  );
});

// ---------------------------------------------------------------------------
// Real browser realization
// ---------------------------------------------------------------------------

function worldAuthorHtml(startFrame: number): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0}</style></head>
<body><canvas id="c"></canvas>
<script>
window.viscraft = {
  ready(){},
  render(args){
    var w = window.__viscraftWorld;
    if (!w) throw new Error('missing __viscraftWorld');
    if (w.id !== 'world_browser' || w.revision !== 1) throw new Error('bad world identity');
    if (w.frame !== ${startFrame} + args.frame) throw new Error('bad world frame ' + w.frame);
    if (w.camera.id !== 'cam_main') throw new Error('bad camera');
    if (args.params.marker !== 'world') throw new Error('params changed');
    var e = w.entities[0];
    if (!e || e.id !== 'puck') throw new Error('bad entity');
    var x = e.transform.position[0];
    window.__worldSeen = window.__worldSeen || [];
    window.__worldSeen.push(w.frame + ':' + x);
    var c = document.getElementById('c'); c.width = args.width; c.height = args.height;
    var g = c.getContext('2d');
    var shade = Math.round(Math.min(255, Math.max(0, x * 10)));
    g.fillStyle = 'rgb(' + shade + ',0,0)';
    g.fillRect(0, 0, args.width, args.height);
  }
};
</script></body></html>`;
}

function browserWorld(): World {
  return {
    id: 'world_browser',
    revision: 1,
    units: 'meters',
    coordinates: 'right-handed-y-up',
    fps: { numerator: 5, denominator: 1 },
    frames: 5,
    entities: [
      {
        id: 'puck',
        asset: 'asset_puck',
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        state: {},
      },
    ],
    trajectories: [
      {
        id: 'puck_path',
        entity: 'puck',
        keyframes: [
          { frame: 0, position: [0, 0, 0] },
          { frame: 4, position: [40, 0, 0] },
        ],
      },
    ],
    cameras: [{ id: 'cam_main', position: [0, 0, -5], target: [0, 0, 0], fov: 50 }],
  };
}

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-world-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return root;
}

async function frameFiles(dir: string): Promise<string[]> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  return names.filter(name => name.endsWith('.png')).sort();
}

test('captureWorld renders real frames from the per-frame window.__viscraftWorld snapshot', async () => {
  const startFrame = 1;
  const root = await makeProject({ 'index.html': worldAuthorHtml(startFrame) });
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-world-out-'));
  try {
    const source = worldSource({
      id: 'wsrc_browser',
      world: { id: 'world_browser', camera: 'cam_main', mode: 'drive', startFrame },
      frames: 3,
      params: { marker: 'world' },
    });
    const result = await captureWorld(root, source, browserWorld(), OUTPUT, destination);
    assert.equal(typeof result.browserVersion, 'string');

    // The author page validated each frame's world snapshot and rendered from the
    // sampled entity position; three global frames (1,2,3) give three shades.
    const files = await frameFiles(destination);
    assert.deepEqual(files, ['frame-000000.png', 'frame-000001.png', 'frame-000002.png']);
    const buffers = await Promise.all(files.map(file => fs.readFile(path.join(destination, file))));
    const hexes = buffers.map(buffer => buffer.toString('hex'));
    assert.equal(new Set(hexes).size, 3, 'each World frame should render a distinct image');
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(destination, { recursive: true, force: true }).catch(() => undefined);
  }
});
