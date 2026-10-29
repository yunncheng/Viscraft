/*
 * tests/fixtures/authoring/mesh/lib.mjs
 *
 * Shared fixtures for the browser GLB mesh-render proof: the REAL binary glTF
 * (`.glb`) that a World entity references, the ONE shared World sampled by both
 * backends, and the vendored three.js file list the page loads.
 *
 * Imported by `tests/fixtures/authoring/mesh/render.mjs` (evidence) and
 * `tests/browser-mesh.test.ts` (contract), so the Asset bytes, the World and the
 * expected mesh facts have a single definition.
 */

/** Project-relative binding name the page reads the model Asset from. */
export const MODEL_BINDING = 'model';

/** World entity Asset id. */
export const MODEL_ASSET_ID = 'asset_slab';

/**
 * The vendored engine closure the page needs: the three build plus the
 * GLTFLoader addon and its two utils. Paths are relative to the Project root.
 */
export const VENDOR_RESOURCES = [
  'vendor/three.module.js',
  'vendor/three.core.js',
  'vendor/LICENSE',
  'vendor/addons/loaders/GLTFLoader.js',
  'vendor/addons/utils/BufferGeometryUtils.js',
  'vendor/addons/utils/SkeletonUtils.js',
];

// A rectangular slab, half extents [1.5, 0.35, 0.55] — deliberately non-cubic
// so its rendered silhouette is recognisable and its bounding box is a
// distinctive fingerprint of THIS Asset (not a generic cube placeholder).
const HALF = [1.5, 0.35, 0.55];

/** Ground-truth geometry facts a GLTFLoader parse of {@link slabGlb} must report. */
export const SLAB_FACTS = {
  vertexCount: 8,
  triangleCount: 12,
  meshCount: 1,
  bboxMin: [-HALF[0], -HALF[1], -HALF[2]],
  bboxMax: [HALF[0], HALF[1], HALF[2]],
};

function corners() {
  const [hx, hy, hz] = HALF;
  const pts = [];
  for (const z of [-hz, hz]) for (const y of [-hy, hy]) for (const x of [-hx, hx]) pts.push([x, y, z]);
  return pts;
}

// 12 triangles (2 per face) over the 8 corners, wound outward.
const BOX_INDICES = [
  0,
  2,
  1,
  0,
  3,
  2, // -z
  4,
  5,
  6,
  4,
  6,
  7, // +z
  0,
  1,
  5,
  0,
  5,
  4, // -y
  3,
  7,
  6,
  3,
  6,
  2, // +y
  0,
  4,
  7,
  0,
  7,
  3, // -x
  1,
  2,
  6,
  1,
  6,
  5, // +x
];

/**
 * Build a real glTF 2.0 binary container (`.glb`): header + JSON chunk + BIN
 * chunk, with the geometry in one embedded buffer. No external `.bin`, no data
 * URI — the Asset is a self-contained GLB.
 */
export function slabGlb() {
  const positions = Buffer.alloc(HALF.length * 8 * 4);
  corners().forEach((p, i) => {
    positions.writeFloatLE(p[0], i * 12);
    positions.writeFloatLE(p[1], i * 12 + 4);
    positions.writeFloatLE(p[2], i * 12 + 8);
  });
  const indices = Buffer.alloc(BOX_INDICES.length * 2);
  BOX_INDICES.forEach((v, i) => indices.writeUInt16LE(v, i * 2));

  // Positions then indices, each already 4-byte aligned (96 + 72 = 168).
  const bin = Buffer.concat([positions, indices]);
  const min = [-HALF[0], -HALF[1], -HALF[2]];
  const max = [HALF[0], HALF[1], HALF[2]];
  const json = {
    asset: { version: '2.0', generator: 'viscraft tests/fixtures/authoring/mesh' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [
      { pbrMetallicRoughness: { baseColorFactor: [0.16, 0.78, 0.36, 1], metallicFactor: 0, roughnessFactor: 1 } },
    ],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.length, target: 34962 },
      { buffer: 0, byteOffset: positions.length, byteLength: indices.length, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5123, count: BOX_INDICES.length, type: 'SCALAR' },
    ],
  };
  return packGlb(json, bin);
}

function pad(buffer, fill) {
  const remainder = buffer.length % 4;
  if (remainder === 0) return buffer;
  return Buffer.concat([buffer, Buffer.alloc(4 - remainder, fill)]);
}

function packGlb(json, bin) {
  const jsonChunk = pad(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const binChunk = pad(bin, 0x00);
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // 'glTF'
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4); // 'JSON'
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binChunk.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4); // 'BIN\0'
  return Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]);
}

/**
 * The ONE shared World: a single slab entity on a straight path that also turns
 * in yaw, plus two cameras (a front camera and a side camera). 16 frames at
 * 24 fps. Both backends sample this exact World.
 */
export function makeWorld() {
  return {
    id: 'world_mesh',
    revision: 1,
    units: 'meters',
    coordinates: 'right-handed-y-up',
    fps: { numerator: 24, denominator: 1 },
    frames: 16,
    entities: [
      {
        id: 'slab',
        asset: MODEL_ASSET_ID,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        state: { role: 'hero' },
      },
    ],
    trajectories: [
      {
        id: 'slab_path',
        entity: 'slab',
        keyframes: [
          { frame: 0, position: [-3, 0, 0], rotation: [0, 0, 0] },
          { frame: 15, position: [3, 0, 0], rotation: [0, 1.2, 0] },
        ],
      },
    ],
    cameras: [
      { id: 'cam_a', position: [0, 1.6, 6.5], target: [0, 0, 0], fov: 50 },
      { id: 'cam_b', position: [6.5, 1.2, 0], target: [0, 0, 0], fov: 45 },
    ],
  };
}
