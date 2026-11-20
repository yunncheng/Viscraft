import { createSymlinkFixture } from './fs-fixtures.js';
/**
 * glTF external-image tracking without a file-name/stem convention.
 *
 * A model's own relative URIs decide which image it needs; the Project Asset id
 * is unrelated. These tests cover the real authoring rule:
 *   - any Asset id is accepted when the URI resolves to that Asset's Project path;
 *   - two same-named textures in different directories are told apart;
 *   - percent-encoding, query and fragment are handled as URI syntax;
 *   - `../` is legal while it stays inside the Project and refused when it escapes;
 *   - a remote URL is refused (not fetched, not silently unhashed);
 *   - a model copied to a hash-named path whose textures live elsewhere fails
 *     loudly instead of producing a Project that renders a grey/missing texture;
 *   - a changed declared texture (hash mismatch) is refused.
 *
 * The Browser half covers the real consumer of that relation: bound files are
 * staged at their Project-relative paths, so a model's sibling texture URL
 * resolves in the real page, and the same staging still refuses a symlinked or
 * escaping binding path.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { openCodeScene } from '../src/backends/browser/capture.js';
import { buildProject } from '../src/build/build.js';
import { importAsset } from '../src/operations/assets/import.js';
import { loadProject } from '../src/project/project.js';
import { runCommand } from '../src/shared/process.js';
import type { Project } from '../src/core/schema.js';

const WIDTH = 64;
const HEIGHT = 48;

const RIGHTS = { origin: 'self-authored test fixture', license: 'CC0-1.0', redistributable: true };
// A real 1x1 PNG; ffprobe/ffmpeg decode it during image import.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function bootstrap(): Project {
  return {
    schemaVersion: 1,
    id: 'model-asset',
    revision: 1,
    title: 'glTF external image identity',
    direction: {
      intent: 'Prove the real image relation',
      looks: [{ id: 'main', description: 'model' }],
      transitions: [],
    },
    assets: [],
    bindings: {},
    sources: [],
    composition: {
      output: { width: 64, height: 48, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [],
      shots: [],
      placements: [],
      transitions: [],
      audio: [],
    },
    imageDocuments: [],
    imageTargets: [],
    soundTargets: [],
  };
}

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-gltf-'));
  await writeFile(join(root, 'project.json'), JSON.stringify(bootstrap()));
  return root;
}

async function put(root: string, relative: string, bytes: Buffer): Promise<void> {
  const file = join(root, ...relative.split('/'));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, bytes);
}

/** A glTF document with one external image and one embedded buffer. */
function gltf(imageUri: string): Buffer {
  const document = {
    asset: { version: '2.0', generator: 'viscraft-model-asset-test' },
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }],
    images: [{ uri: imageUri }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [0, 0, 0] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    buffers: [
      { uri: 'data:application/octet-stream;base64,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', byteLength: 36 },
    ],
  };
  return Buffer.from(JSON.stringify(document), 'utf8');
}

async function importImage(root: string, relative: string, id: string, revision: number) {
  return importAsset(root, {
    assetId: id,
    sourcePath: join(root, ...relative.split('/')),
    type: 'image',
    rights: RIGHTS,
    expectedRevision: revision,
  });
}

/** Decode the first frame of a Build video and return a pixel accessor. */
async function firstFramePixels(video: string, workdir: string): Promise<{ at: (x: number, y: number) => number[] }> {
  const raw = join(workdir, 'frame.rgb24');
  await runCommand('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-i',
    video,
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    raw,
  ]);
  const bytes = await readFile(raw);
  assert.equal(bytes.length, WIDTH * HEIGHT * 3, 'the frame is the authored output size');
  return {
    at: (x, y) => {
      const index = (y * WIDTH + x) * 3;
      return [bytes[index], bytes[index + 1], bytes[index + 2]];
    },
  };
}

test('a glTF image is resolved by project path, not by Asset id or file stem', async () => {
  const root = await freshRoot();
  try {
    await put(root, 'models/robot/textures/skin.png', PNG);
    await put(root, 'models/robot/robot.gltf', gltf('textures/skin.png'));
    const skin = await importImage(root, 'models/robot/textures/skin.png', 'robot_skin', 1);
    const model = await importAsset(root, {
      assetId: 'robot_body',
      sourcePath: join(root, 'models/robot/robot.gltf'),
      type: 'model',
      rights: RIGHTS,
      expectedRevision: 2,
      inputs: [{ asset: 'robot_skin', role: 'baseColor texture' }],
    });
    assert.equal(model.path, 'models/robot/robot.gltf', 'an in-Project model keeps its own location');
    assert.deepEqual(model.inputs, [
      { asset: 'robot_skin', revision: skin.revision, sha256: skin.sha256, role: 'baseColor texture' },
    ]);
    const project = await loadProject(root);
    assert.equal(project.assets.find(asset => asset.id === 'robot_skin')!.path, 'models/robot/textures/skin.png');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('two same-named textures in different directories are told apart', async () => {
  const root = await freshRoot();
  try {
    await put(root, 'models/a/tex.png', PNG);
    await mkdir(join(root, 'models/b'), { recursive: true });
    await runCommand('ffmpeg', [
      '-v',
      'error',
      '-nostdin',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=16x16',
      '-frames:v',
      '1',
      '-threads',
      '1',
      join(root, 'models/b/tex.png'),
    ]);
    await put(root, 'models/a/robot.gltf', gltf('../b/tex.png'));
    await importImage(root, 'models/a/tex.png', 'left_tex', 1);
    // The second texture has different bytes, so it is a second import at revision 2.
    const right = await importImage(root, 'models/b/tex.png', 'right_tex', 2);
    const model = await importAsset(root, {
      assetId: 'cross_dir_model',
      sourcePath: join(root, 'models/a/robot.gltf'),
      type: 'model',
      rights: RIGHTS,
      expectedRevision: 3,
      inputs: [{ asset: 'right_tex', role: 'external image' }],
    });
    assert.equal(model.inputs![0].asset, 'right_tex');
    assert.equal(model.inputs![0].sha256, right.sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('percent-encoding, query and fragment are URI syntax, not part of the file name', async () => {
  const root = await freshRoot();
  try {
    await put(root, 'models/robot/textures/a b.png', PNG);
    await put(root, 'models/robot/robot.gltf', gltf('textures/a%20b.png?v=2#frag'));
    await importImage(root, 'models/robot/textures/a b.png', 'texture_with_space', 1);
    const model = await importAsset(root, {
      assetId: 'encoded_model',
      sourcePath: join(root, 'models/robot/robot.gltf'),
      type: 'model',
      rights: RIGHTS,
      expectedRevision: 2,
      inputs: [{ asset: 'texture_with_space', role: 'texture' }],
    });
    assert.equal(model.inputs![0].asset, 'texture_with_space');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a URI that resolves to the wrong path is refused with the expected path', async () => {
  const root = await freshRoot();
  try {
    await put(root, 'models/robot/textures/skin.png', PNG);
    await put(root, 'models/robot/robot.gltf', gltf('textures/missing.png'));
    await importImage(root, 'models/robot/textures/skin.png', 'robot_skin', 1);
    await assert.rejects(
      importAsset(root, {
        assetId: 'bad_model',
        sourcePath: join(root, 'models/robot/robot.gltf'),
        type: 'model',
        rights: RIGHTS,
        expectedRevision: 2,
        inputs: [{ asset: 'robot_skin', role: 'texture' }],
      }),
      /resolves to "models\/robot\/textures\/missing\.png".*Declared production inputs: "models\/robot\/textures\/skin\.png"/s,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a declared image whose bytes changed is refused (hash mismatch, not a silent rebind)', async () => {
  const root = await freshRoot();
  try {
    await put(root, 'models/robot/textures/skin.png', PNG);
    await importImage(root, 'models/robot/textures/skin.png', 'robot_skin', 1);
    await put(root, 'models/robot/textures/skin.png', Buffer.concat([PNG, Buffer.from([1])]));
    await put(root, 'models/robot/robot.gltf', gltf('textures/skin.png'));
    await assert.rejects(
      importAsset(root, {
        assetId: 'changed_texture_model',
        sourcePath: join(root, 'models/robot/robot.gltf'),
        type: 'model',
        rights: RIGHTS,
        expectedRevision: 2,
        inputs: [{ asset: 'robot_skin', role: 'texture' }],
      }),
      /Production input hash mismatch for robot_skin/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an escaping ../ or a remote URL is refused; a ../ that stays inside is legal', async () => {
  const root = await freshRoot();
  try {
    await put(root, 'models/shared/tex.png', PNG);
    await importImage(root, 'models/shared/tex.png', 'shared_tex', 1);
    // Legal: models/scene/robot.gltf -> ../shared/tex.png.
    await put(root, 'models/scene/robot.gltf', gltf('../shared/tex.png'));
    const inside = await importAsset(root, {
      assetId: 'inside_model',
      sourcePath: join(root, 'models/scene/robot.gltf'),
      type: 'model',
      rights: RIGHTS,
      expectedRevision: 2,
      inputs: [{ asset: 'shared_tex', role: 'texture' }],
    });
    assert.equal(inside.path, 'models/scene/robot.gltf');

    // Illegal: a root-level model's ../ leaves the Project.
    await put(root, 'robot.gltf', gltf('../outside.png'));
    await assert.rejects(
      importAsset(root, {
        assetId: 'escaping_model',
        sourcePath: join(root, 'robot.gltf'),
        type: 'model',
        rights: RIGHTS,
        expectedRevision: 3,
        inputs: [{ asset: 'shared_tex', role: 'texture' }],
      }),
      /outside the Project root/,
    );

    await put(root, 'remote.gltf', gltf('https://example.com/tex.png'));
    await assert.rejects(
      importAsset(root, {
        assetId: 'remote_model',
        sourcePath: join(root, 'remote.gltf'),
        type: 'model',
        rights: RIGHTS,
        expectedRevision: 3,
        inputs: [{ asset: 'shared_tex', role: 'texture' }],
      }),
      /remote URL is not part of the Project closure/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a copied-in model whose hash-named destination breaks the texture relation fails loudly', async () => {
  const root = await freshRoot();
  const donor = await mkdtemp(join(tmpdir(), 'viscraft-gltf-donor-'));
  try {
    await put(root, 'textures/skin.png', PNG);
    await importImage(root, 'textures/skin.png', 'project_skin', 1);
    // The donor model lives outside the Project, so it is copied to
    // `assets/<id>-<sha16>.gltf`; its `textures/skin.png` would then resolve to
    // `assets/textures/skin.png`, which is NOT where project_skin lives.
    await writeFile(join(donor, 'robot.gltf'), gltf('textures/skin.png'));
    await assert.rejects(
      importAsset(root, {
        assetId: 'donor_model',
        sourcePath: join(donor, 'robot.gltf'),
        type: 'model',
        rights: RIGHTS,
        expectedRevision: 2,
        inputs: [{ asset: 'project_skin', role: 'texture' }],
      }),
      /resolves to "assets\/textures\/skin\.png"/,
    );
    // Nothing was registered or copied for the refused model.
    const project = await loadProject(root);
    assert.equal(
      project.assets.some(asset => asset.id === 'donor_model'),
      false,
    );
  } finally {
    await rm(donor, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

const TEXTURE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000}canvas{display:block}</style></head><body>
<canvas id="c"></canvas>
<script>
window.viscraft = { async render(ctx) {
  var canvas = document.getElementById('c');
  canvas.width = ctx.width; canvas.height = ctx.height;
  var g = canvas.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, ctx.width, ctx.height);
  var model = ctx.bindings.model;
  if (!model) throw new Error('the model binding was not exposed');
  var response = await fetch(model.url);
  if (!response.ok) throw new Error('model fetch failed: ' + response.status);
  var doc = await response.json();
  var uri = doc.images && doc.images[0] && doc.images[0].uri;
  if (!uri) throw new Error('the fixture model declares no external image');
  // Resolve the texture exactly as a glTF loader does: relative to the model URL.
  var textureUrl = new URL(uri, model.url).href;
  var texture = await fetch(textureUrl);
  if (!texture.ok) throw new Error('texture fetch failed: ' + texture.status + ' ' + textureUrl);
  var bitmap = await createImageBitmap(await texture.blob());
  g.drawImage(bitmap, 0, 0, ctx.width, ctx.height);
}};
</script></body></html>`;

test('Browser: a real .gltf loads its sibling texture through the model binding URL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-gltf-browser-'));
  try {
    // A Project with one browser Source that binds the model (and the texture)
    // by name; the page itself resolves the texture URI from the model bytes.
    const base = bootstrap();
    const project: Project = {
      ...base,
      sources: [
        {
          id: 'shot',
          kind: 'browser',
          output: 'picture',
          entry: 'texture.html',
          resources: [],
          bindings: [],
          params: {},
          seed: 0,
          frames: 1,
        },
      ],
      composition: {
        ...base.composition!,
        scenes: [{ id: 'scene', description: 'one textured model' }],
        shots: [{ id: 'shot', scene: 'scene', look: 'main', intent: 'load the sibling texture', targetFrames: 1 }],
        placements: [{ id: 'p', shot: 'shot', source: 'shot', inFrame: 0, outFrame: 1, startFrame: 0, audio: 'mute' }],
      },
    };
    await writeFile(join(root, 'texture.html'), TEXTURE_PAGE);
    await writeFile(join(root, 'project.json'), JSON.stringify(project));

    await mkdir(join(root, 'models/robot/textures'), { recursive: true });
    await runCommand('ffmpeg', [
      '-hide_banner',
      '-nostdin',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=0x3467aa:s=8x8',
      '-frames:v',
      '1',
      join(root, 'models/robot/textures/albedo.png'),
    ]);
    await put(root, 'models/robot/robot.gltf', gltf('textures/albedo.png'));
    const skin = await importImage(root, 'models/robot/textures/albedo.png', 'robot_skin', 1);
    await importAsset(root, {
      assetId: 'robot_body',
      sourcePath: join(root, 'models/robot/robot.gltf'),
      type: 'model',
      rights: RIGHTS,
      expectedRevision: 2,
      inputs: [{ asset: 'robot_skin', role: 'texture' }],
    });

    const bound = await loadProject(root);
    bound.bindings = { model: 'robot_body', texture: 'robot_skin' };
    const source = bound.sources[0];
    if (source.kind !== 'browser') throw new Error('the fixture Project must hold a browser Source');
    source.bindings = ['model', 'texture'];
    await writeFile(join(root, 'project.json'), JSON.stringify(bound));

    const build = await buildProject(root);
    assert.equal(build.status, 'succeeded', 'the model and its texture must load in a real Browser');
    assert.ok(skin.sha256.length === 64);
    // The page throws when either fetch fails, so a successful capture plus a
    // texture-coloured centre pixel proves the relative URI actually resolved.
    const video = join(root, build.artifacts.find(a => a.id === build.result!.artifact)!.path);
    const pixels = await firstFramePixels(video, root);
    const centre = pixels.at(16, 16);
    assert.ok(
      centre[2] > centre[0] && centre[2] > 60,
      `the texture must be decoded and drawn at the centre, got ${centre}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Browser staging refuses a symlinked or escaping binding path', async t => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-binding-path-'));
  const outside = await mkdtemp(join(tmpdir(), 'viscraft-binding-outside-'));
  try {
    await writeFile(join(root, 'scene.html'), '<!doctype html><canvas id="c"></canvas>');
    await writeFile(join(outside, 'secret.png'), 'bytes outside the Project');
    await mkdir(join(root, 'models'), { recursive: true });
    // A linked file and a linked DIRECTORY: the second is the realistic escape,
    // because the bound file is a regular file reached through a linked parent.
    await createSymlinkFixture(t, outside, join(root, 'models/external'));

    const scene = { entry: 'scene.html', resources: [] };
    const viewport = { width: 16, height: 16 };
    const boundTo = (path: string) => ({ model: { id: 'bound', path, sha256: '0'.repeat(64) } });

    await t.test('file binding symlink is refused', async t => {
      if (!(await createSymlinkFixture(t, join(outside, 'secret.png'), join(root, 'linked.png')))) return;
      await assert.rejects(
        () => openCodeScene(root, scene, viewport, null, {}, boundTo('linked.png')),
        /Symbolic links are not allowed/i,
        'a symlinked binding file must be refused, not copied by content',
      );
    });
    await assert.rejects(
      () => openCodeScene(root, scene, viewport, null, {}, boundTo('models/external/secret.png')),
      /Symbolic links are not allowed/i,
      'a symlinked directory component must be refused too',
    );
    await assert.rejects(
      () => openCodeScene(root, scene, viewport, null, {}, boundTo('../secret.png')),
      /safe project-relative path/i,
      'a binding path that leaves the Project root is refused before staging',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
