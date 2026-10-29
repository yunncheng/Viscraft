/**
 * Final image delivery, inspected and updated in place.
 *
 * A delivered still is a PRODUCT at `image/<target>.<ext>`, not the Artifact it
 * was copied from. This suite proves, through real Browser captures and a real
 * FFmpeg film where relevant:
 *
 *  - target ids are arbitrary (`diagram`, `cover`), two targets keep distinct
 *    final files and never cross-write;
 *  - a flat, already-generated image is an ordinary single image layer in a
 *    fixed author canvas: rendering/delivering it copies the product, it never
 *    rewrites or embeds a second copy of the original Asset;
 *  - `inspectImageDelivery(root, { delivery, target })` binds only a recorded
 *    Runtime delivery whose manifest, members and delivered bytes still agree
 *    with the author Project; a parseable bundle whose members were changed is
 *    reported as `verified: false` with a `blocked` reason (so an author page
 *    can open in a blocked state), while a missing/foreign/wrong-target/
 *    malformed/path-shaped request throws;
 *  - `updateImageDelivery(root, { delivery, target, build? })` replaces only the
 *    bound target's product, keeps the old Build/Artifact readable, updates
 *    manifest/index/material/record hashes, leaves every other delivered
 *    product byte-identical, calls no provider and keeps the single editable
 *    Project export; `verifyDelivery` still passes;
 *  - no `build` never renders and never creates a Build: it republishes the
 *    newest already-succeeded current render, or refuses when none exists;
 *  - the one result contract is `image` (single still bytes), `bytes` (physical
 *    payload of the whole bundle, manifest excluded), `logicalBytes` (sum of
 *    listed files) and the real `project` export scope — no `reused` or
 *    `physicalBytes` aliases;
 *  - a hand-edited bundle, a stale/missing bundle/required original, a render
 *    failure, a source that changes during staging and a publish failure all
 *    leave the previous product intact and never present it as current;
 *  - the author Project is never nested in, or replaced by, the delivery.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { test } from 'node:test';

import { buildProject } from '../src/build/build.js';
import { renderImage } from '../src/build/image.js';
import { deliverProject } from '../src/operations/delivery/delivery.js';
import { inspectImageDelivery, updateImageDelivery } from '../src/operations/delivery/image-delivery.js';
import { verifyDelivery } from '../src/operations/delivery/delivery-verification.js';
import { type DeliveryResult } from '../src/operations/delivery/delivery-contract.js';
import { validateProject } from '../src/project/project.js';
import { acquireDeliveryLock } from '../src/project/output.js';
import { hashFile } from '../src/shared/hash.js';
import { writeSignalAsset } from './audio-fixtures.js';
import type { DeliveryReview } from '../src/operations/delivery/delivery-contract.js';

const DIAGRAM_HTML = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="diagram.css"></head>
<body><div class="canvas" data-canvas-width="200" data-canvas-height="120">
<div class="box" data-layer-id="flow">A → B → C</div>
</div></body></html>`;
const DIAGRAM_CSS = `html,body{margin:0;width:200px;height:120px;overflow:hidden;background:#f7f4ec}
.canvas{position:relative;width:200px;height:120px;overflow:hidden}
.box{position:absolute;left:16px;top:40px;width:168px;height:36px;background:#e4dcc8;font:14px sans-serif;color:#24211c;text-align:center;line-height:36px}`;

const COVER_HTML = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="cover.css"></head>
<body><div class="canvas" data-canvas-width="120" data-canvas-height="120">
<div class="title" data-layer-id="title">ISSUE 04</div>
</div></body></html>`;
const COVER_CSS = `html,body{margin:0;width:120px;height:120px;overflow:hidden;background:#20242c}
.canvas{position:relative;width:120px;height:120px;overflow:hidden}
.title{position:absolute;left:10px;top:50px;width:100px;height:24px;color:#f4e7cf;font:16px sans-serif;text-align:center}`;

/** A private plate that a still document really embeds. */
const PLATE_HTML = DIAGRAM_HTML.replace(
  '</div></body>',
  '<img class="plate" data-layer-id="plate" src="plate.png" alt=""></div></body>',
);

/**
 * A generated/imported flat image is ONE fixed canvas with ONE image layer, the
 * upstream Editable-Design shape. The editor may move/resize that layer; it does
 * not pretend to recover internal text or structure that the flat file never had.
 */
const FLAT_HTML = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="flat.css"></head>
<body><div class="canvas" data-canvas-width="240" data-canvas-height="180">
<img class="art" data-layer-id="art" src="art.png" alt="">
</div></body></html>`;
const FLAT_CSS = `html,body{margin:0;width:240px;height:180px;overflow:hidden;background:#ffffff}
.canvas{position:relative;width:240px;height:180px;overflow:hidden}
.art{position:absolute;left:0;top:0;width:240px;height:180px;object-fit:cover}`;

/** A real 1x1 opaque PNG; the author's original bytes must never be rewritten. */
const ART_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const RIGHTS = { origin: 'author-owned generated plate', license: 'CC0-1.0', redistributable: true } as const;
const PRIVATE_RIGHTS = { origin: 'author-owned private plate', license: 'CC0-1.0', redistributable: false } as const;

function baseProject() {
  return {
    schemaVersion: 1 as const,
    id: 'image_delivery_update',
    revision: 1,
    title: 'Image delivery update',
    direction: {
      intent: 'final stills delivered as products',
      looks: [{ id: 'plain', description: 'plain' }],
      transitions: [],
    },
    assets: [],
    bindings: {},
    sources: [],
  };
}

/** Two independently named still products from two documents. */
function twoTargetProject() {
  return validateProject({
    ...baseProject(),
    imageDocuments: [
      { id: 'flow', path: 'diagram.html', resources: ['diagram.css'], revision: 1 },
      { id: 'cover_src', path: 'cover.html', resources: ['cover.css'], revision: 1 },
    ],
    imageTargets: [
      {
        id: 'diagram',
        document: 'flow',
        width: 200,
        height: 120,
        scale: 2,
        format: 'png' as const,
        background: 'opaque' as const,
      },
      {
        id: 'cover',
        document: 'cover_src',
        width: 120,
        height: 120,
        scale: 1,
        format: 'jpeg' as const,
        background: 'opaque' as const,
      },
    ],
  });
}

/** The same still products plus a real (very short) simulated film. */
function mixedProject(revision = 2, options: { privatePlate?: boolean; pad?: boolean } = {}) {
  const stills = twoTargetProject();
  const flow = stills.imageDocuments.find(document => document.id === 'flow')!;
  const resources = [...flow.resources];
  if (options.privatePlate) resources.push('plate.png');
  if (options.pad) resources.push('pad.css');
  return validateProject({
    ...stills,
    revision,
    assets: options.privatePlate
      ? [
          {
            id: 'plate',
            revision: 1,
            type: 'image' as const,
            path: 'plate.png',
            sha256: sha256(ART_PNG),
            rights: PRIVATE_RIGHTS,
            simulated: false,
          },
        ]
      : [],
    imageDocuments: stills.imageDocuments.map(document =>
      document.id === 'flow' ? { ...document, resources } : document,
    ),
    sources: [
      {
        id: 'src_film',
        kind: 'simulated' as const,
        prompt: 'eight-frame film beside delivered stills',
        frames: 8,
        seed: 11,
        attempt: 'attempt_film',
        behavior: 'success' as const,
      },
    ],
    composition: {
      output: { width: 160, height: 90, fps: { numerator: 25, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene_1', description: 'one scene' }],
      shots: [{ id: 'shot_1', scene: 'scene_1', look: 'plain', intent: 'one shot', targetFrames: 8 }],
      placements: [
        {
          id: 'pl_1',
          shot: 'shot_1',
          source: 'src_film',
          inFrame: 0,
          outFrame: 8,
          startFrame: 0,
          audio: 'mute' as const,
        },
      ],
      transitions: [],
      audio: [],
    },
  });
}

function flatProject() {
  return validateProject({
    ...baseProject(),
    assets: [
      {
        id: 'art',
        revision: 1,
        type: 'image' as const,
        path: 'art.png',
        sha256: sha256(ART_PNG),
        rights: RIGHTS,
        simulated: false,
      },
    ],
    imageDocuments: [{ id: 'flat', path: 'flat.html', resources: ['flat.css', 'art.png'], revision: 1 }],
    imageTargets: [
      {
        id: 'cover',
        document: 'flat',
        width: 240,
        height: 180,
        scale: 1,
        format: 'png' as const,
        background: 'opaque' as const,
      },
    ],
  });
}

/**
 * A flat still whose registered image was GENERATED by a provider: the Asset
 * records `imageGeneration.outputSha256` and the real raw provider bytes sit under
 * `.viscraft/provider-media/`. That original is a REQUIRED part of an editable
 * hand-off, so an update must fail loudly when it is absent locally instead of
 * substituting the normalized copy.
 */
function generatedStillProject() {
  const digest = sha256(ART_PNG);
  return validateProject({
    ...baseProject(),
    assets: [
      {
        id: 'plate',
        revision: 1,
        type: 'image' as const,
        path: 'plate.png',
        sha256: digest,
        rights: RIGHTS,
        simulated: false,
        imageGeneration: {
          provider: 'vllm-omni-image',
          model: 'test-image',
          operation: 'generate' as const,
          promptHash: 'a'.repeat(64),
          requestHash: 'b'.repeat(64),
          inputSha256: [],
          references: [],
          outputSha256: digest,
          simulated: false,
        },
      },
    ],
    imageDocuments: [{ id: 'flat', path: 'flat.html', resources: ['flat.css', 'plate.png'], revision: 1 }],
    imageTargets: [
      {
        id: 'cover',
        document: 'flat',
        width: 240,
        height: 180,
        scale: 1,
        format: 'png' as const,
        background: 'opaque' as const,
      },
    ],
  });
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function tempDir(label: string): Promise<string> {
  return fs.mkdtemp(nodePath.join(os.tmpdir(), `viscraft-${label}-`));
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(
    () => true,
    () => false,
  );
}

async function writeProject(root: string, project: unknown): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(nodePath.join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
}

async function writeTwoTargets(root: string): Promise<void> {
  await fs.writeFile(nodePath.join(root, 'diagram.html'), DIAGRAM_HTML);
  await fs.writeFile(nodePath.join(root, 'diagram.css'), DIAGRAM_CSS);
  await fs.writeFile(nodePath.join(root, 'cover.html'), COVER_HTML);
  await fs.writeFile(nodePath.join(root, 'cover.css'), COVER_CSS);
}

function pngSize(bytes: Buffer): { width: number; height: number } {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'expected a real PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function jpegSize(bytes: Buffer): { width: number; height: number } {
  assert.equal(bytes.subarray(0, 2).toString('hex'), 'ffd8', 'expected a real JPEG');
  // Walk the JPEG markers to the SOF frame header.
  let offset = 2;
  for (;;) {
    if (bytes[offset] !== 0xff) throw new Error('malformed JPEG marker stream');
    const marker = bytes[offset + 1]!;
    const length = bytes.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    offset += 2 + length;
  }
}

interface ManifestFile {
  path: string;
  sha256: string;
  bytes: number;
  role: string;
}

interface ManifestImage {
  target: string;
  build: string;
  artifact: string;
  path: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  format: string;
  simulated: boolean;
  workbench?: { target: string; document: string; documentPath: string; command: string; editableProject: boolean };
}

interface ManifestImageMaterial {
  target: string;
  build: string;
  document: string;
  assets: Array<{ asset: string; path: string; rights: Record<string, unknown> }>;
}

interface DeliveryManifest {
  project: { id: string; revision: number };
  build: { id: string } | null;
  selection: { movie: boolean; images: string[] };
  movie: { path: string; sha256: string } | null;
  images: ManifestImage[];
  review: DeliveryReview | null;
  imageMaterials?: ManifestImageMaterial[];
  files: ManifestFile[];
  logicalBytes: number;
  notes: string[];
  containsNonRedistributableAssets?: boolean;
  nonRedistributableAssets?: Array<{ asset: string; path: string }>;
}

async function manifestOf(bundle: string): Promise<DeliveryManifest> {
  return JSON.parse(await fs.readFile(nodePath.join(bundle, 'delivery-manifest.json'), 'utf8')) as DeliveryManifest;
}

async function readDeliveryRecord(root: string, entry: string): Promise<{ manifestSha256: string; build?: string }> {
  return JSON.parse(await fs.readFile(nodePath.join(root, '.viscraft', 'deliveries', `${entry}.json`), 'utf8')) as {
    manifestSha256: string;
    build?: string;
  };
}

async function digestOf(file: string): Promise<string> {
  return hashFile(file);
}

async function deliveredStillBytes(root: string, target = 'diagram'): Promise<Buffer> {
  return fs.readFile(nodePath.join(root, 'output', 'handoff', 'image', `${target}.png`));
}

async function outputEntries(root: string): Promise<string[]> {
  return (await fs.readdir(nodePath.join(root, 'output'))).filter(name => name !== '.gitignore').sort();
}

async function walk(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = nodePath.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    else out.push(nodePath.relative(base, full).split(nodePath.sep).join('/'));
  }
  return out.sort();
}

/**
 * Physical payload bytes of a bundle exactly as the Runtime accounts them: each
 * distinct (dev, inode) counts once and the manifest is excluded. 64-bit inode
 * identity requires BigInt stats (a plain Number can collide on some filesystems).
 */
async function physicalPayloadBytes(bundle: string): Promise<number> {
  const inodes = new Map<string, number>();
  for (const relative of await walk(bundle)) {
    if (relative === 'delivery-manifest.json') continue;
    const info = await fs.stat(nodePath.join(bundle, ...relative.split('/')), { bigint: true });
    inodes.set(`${info.dev}:${info.ino}`, Number(info.size));
  }
  return [...inodes.values()].reduce((sum, size) => sum + size, 0);
}

interface BuildFile {
  medium: string;
  operations: Array<{ kind: string }>;
  artifacts: Array<{ id: string; path: string; sha256: string }>;
}

async function buildRecord(root: string, build: string): Promise<BuildFile> {
  return JSON.parse(
    await fs.readFile(nodePath.join(root, '.viscraft', 'builds', `${build}.json`), 'utf8'),
  ) as BuildFile;
}

/** Frozen author inputs of one Build: available files plus explicit gaps. */
async function snapshotInputs(
  root: string,
  build: string,
): Promise<{ files: Record<string, string>; unavailable: unknown[] }> {
  return JSON.parse(
    await fs.readFile(nodePath.join(root, '.viscraft', 'snapshots', `${build}.inputs.json`), 'utf8'),
  ) as { files: Record<string, string>; unavailable: unknown[] };
}

/** Every build operation kind recorded for a still Build. */
async function operationKinds(root: string, build: string): Promise<string[]> {
  return (await buildRecord(root, build)).operations.map(operation => operation.kind);
}

/** The project-relative path of one Artifact in a Build record. */
async function artifactPathOf(root: string, build: string, artifact: string): Promise<string> {
  const found = (await buildRecord(root, build)).artifacts.find(candidate => candidate.id === artifact);
  assert.ok(found, `Build ${build} records Artifact ${artifact}`);
  return found.path;
}

/** Stable ids of every succeeded Build in the author root. */
async function buildIds(root: string): Promise<string[]> {
  return (await fs.readdir(nodePath.join(root, '.viscraft', 'builds')))
    .filter(file => file.endsWith('.json'))
    .map(file => file.slice(0, -'.json'.length))
    .sort();
}

async function waitUntil(predicate: () => Promise<boolean>, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

test('non-poster targets deliver two distinct final files and never cross targets', async () => {
  const parent = await tempDir('image-delivery-names');
  const root = nodePath.join(parent, 'project');
  const bundle = nodePath.join(parent, 'bundle');
  try {
    await writeProject(root, twoTargetProject());
    await writeTwoTargets(root);

    const diagram = await renderImage(root, { target: 'diagram' });
    const cover = await renderImage(root, { target: 'cover' });
    assert.notEqual(diagram.artifact, cover.artifact);

    const delivery = await deliverProject(root, bundle, {
      outputs: { images: ['cover', 'diagram'] },
    });
    assert.equal(delivery.movie, null);
    assert.deepEqual(
      delivery.images.map(image => image.target),
      ['cover', 'diagram'],
      'products are listed in stable target order',
    );
    const delivered = new Map(delivery.images.map(image => [image.target, image]));
    assert.equal(delivered.get('diagram')!.path, 'image/diagram.png');
    assert.equal(delivered.get('cover')!.path, 'image/cover.jpg');

    // Each FINAL still records how to reopen its own editor; it names the target
    // and document, and it carries no live URL/token (a session is not durable).
    const reopen = delivered.get('diagram')!.workbench;
    assert.ok(reopen, 'the final still records a workbench entry');
    assert.deepEqual(
      { target: reopen.target, document: reopen.document, documentPath: reopen.documentPath },
      { target: 'diagram', document: 'flow', documentPath: 'diagram.html' },
    );
    assert.match(reopen.command, /^viscraft workbench <project-directory> --document flow --target diagram/);
    assert.doesNotMatch(reopen.command, /https?:|token=|127\.0\.0\.1/);
    assert.equal(reopen.editableProject, true, 'the handoff carries the editable project');
    assert.match(reopen.note, /editable project|URL|token/i);

    const diagramBytes = await fs.readFile(nodePath.join(bundle, 'image', 'diagram.png'));
    const coverBytes = await fs.readFile(nodePath.join(bundle, 'image', 'cover.jpg'));
    assert.deepEqual(pngSize(diagramBytes), { width: 400, height: 240 });
    assert.deepEqual(jpegSize(coverBytes), { width: 120, height: 120 });
    assert.equal(sha256(diagramBytes), await digestOf(nodePath.join(root, ...diagram.path.split('/'))));
    assert.equal(sha256(coverBytes), await digestOf(nodePath.join(root, ...cover.path.split('/'))));
    assert.notEqual(sha256(diagramBytes), sha256(coverBytes));

    // Each delivered target maps back to ITS document, not merely to a target id.
    const manifest = await manifestOf(bundle);
    assert.deepEqual(manifest.selection.images, ['cover', 'diagram']);
    assert.deepEqual(manifest.imageMaterials!.map(material => [material.target, material.document]).sort(), [
      ['cover', 'cover.html'],
      ['diagram', 'diagram.html'],
    ]);

    const index = await fs.readFile(nodePath.join(bundle, 'index.html'), 'utf8');
    assert.match(index, /image\/diagram\.png/);
    assert.match(index, /image\/cover\.jpg/);
    assert.match(index, /viscraft workbench <project-directory> --document flow --target diagram/);
    assert.match(index, /viscraft workbench <project-directory> --document cover_src --target cover/);
    assert.equal(manifest.images.find(image => image.target === 'diagram')!.workbench?.document, 'flow');
    assert.equal((await verifyDelivery(bundle)).ok, true);

    // Editing ONE document and delivering again changes only that product.
    await fs.writeFile(nodePath.join(root, 'diagram.html'), DIAGRAM_HTML.replace('A → B → C', 'A → B → D'));
    const reRendered = await renderImage(root, { target: 'diagram' });
    assert.notEqual(reRendered.artifact, diagram.artifact);
    const second = nodePath.join(parent, 'bundle-2');
    const secondDelivery = await deliverProject(root, second, {
      outputs: { images: ['cover', 'diagram'] },
    });
    const secondCover = secondDelivery.images.find(image => image.target === 'cover')!;
    assert.equal(secondCover.sha256, sha256(coverBytes), 'the untouched target keeps identical bytes');
    assert.equal(
      await digestOf(nodePath.join(second, 'image', 'cover.jpg')),
      sha256(coverBytes),
      'the untouched target is not re-rendered',
    );
    assert.notEqual(
      await digestOf(nodePath.join(second, 'image', 'diagram.png')),
      sha256(diagramBytes),
      'the edited target really changed',
    );
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('a flat generated image is delivered as one layer and its original Asset is untouched', async () => {
  const parent = await tempDir('image-flat');
  const root = nodePath.join(parent, 'project');
  const bundle = nodePath.join(parent, 'bundle');
  try {
    await writeProject(root, flatProject());
    await fs.writeFile(nodePath.join(root, 'flat.html'), FLAT_HTML);
    await fs.writeFile(nodePath.join(root, 'flat.css'), FLAT_CSS);
    await fs.writeFile(nodePath.join(root, 'art.png'), ART_PNG);

    const originalDigest = sha256(ART_PNG);
    const still = await renderImage(root, { target: 'cover' });
    assert.deepEqual(pngSize(await fs.readFile(nodePath.join(root, ...still.path.split('/')))), {
      width: 240,
      height: 180,
    });
    // Rendering reads the registered original; it never rewrites or duplicates it.
    assert.equal(await digestOf(nodePath.join(root, 'art.png')), originalDigest, 'the original bytes are unchanged');
    assert.equal(
      (await fs.readFile(nodePath.join(root, 'flat.html'), 'utf8')).match(/data-layer-id=/g)?.length,
      1,
      'the flat product stays a single image layer',
    );
    assert.doesNotMatch(await fs.readFile(nodePath.join(root, 'flat.html'), 'utf8'), /<h[1-6]|<p\b/);

    const delivery = await deliverProject(root, bundle, { outputs: { images: ['cover'] } });
    assert.equal(delivery.images[0]!.path, 'image/cover.png');
    const stillDigest = await digestOf(nodePath.join(root, ...still.path.split('/')));
    assert.equal(
      await digestOf(nodePath.join(bundle, 'image', 'cover.png')),
      stillDigest,
      'the product is the rendered still, not a copy of the flat source',
    );
    assert.notEqual(stillDigest, originalDigest);
    assert.equal(await digestOf(nodePath.join(root, 'art.png')), originalDigest);
    // The bundle carries the single Project document and the Asset bytes, but the
    // delivered product is a separate file.
    const manifest = await manifestOf(bundle);
    assert.deepEqual(
      manifest.imageMaterials![0]!.assets.map(asset => asset.path),
      ['art.png'],
      'the registered original is recorded as the still material',
    );
    assert.equal((await verifyDelivery(bundle)).ok, true);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('inspect binds a recorded delivery and reports a modified bundle as blocked, not healthy', async () => {
  const parent = await tempDir('image-bind');
  const root = nodePath.join(parent, 'project');
  try {
    await writeProject(root, twoTargetProject());
    await writeTwoTargets(root);
    await renderImage(root, { target: 'diagram' });
    const delivered = await deliverProject(root, undefined, {
      outputs: { images: ['diagram'] },
    });
    assert.equal(delivered.path, nodePath.join(root, 'output', 'handoff'));
    assert.deepEqual(await outputEntries(root), ['handoff']);
    const still = delivered.images.find(image => image.target === 'diagram')!;

    const binding = await inspectImageDelivery(root, { delivery: 'handoff', target: 'diagram' });
    assert.equal(binding.entry, 'handoff');
    assert.equal(binding.path, delivered.path, 'path is the absolute bundle directory');
    assert.equal(binding.productPath, 'image/diagram.png');
    assert.equal(binding.projectPath, 'output/handoff/image/diagram.png');
    assert.equal(binding.document, 'flow');
    assert.equal(binding.documentPath, 'diagram.html');
    assert.equal(binding.build, still.build);
    assert.equal(binding.artifact, still.artifact);
    assert.equal(binding.format, 'png');
    assert.equal(binding.sha256, still.sha256);
    assert.equal(binding.bytes, still.bytes);
    assert.equal(binding.movie, false);
    assert.equal(binding.project, true, 'a handoff carries the editable project');
    assert.equal(binding.verified, true);
    assert.equal(binding.blocked, null);
    assert.equal(binding.stale, false);

    // A target this bundle does not carry is refused rather than mapped to
    // another product.
    await assert.rejects(
      inspectImageDelivery(root, { delivery: 'handoff', target: 'cover' }),
      /does not carry image target|deliver the new target/i,
    );
    // Unrecorded and foreign entries never bind.
    await assert.rejects(
      inspectImageDelivery(root, { delivery: 'not-a-delivery', target: 'diagram' }),
      /record|delivery|exist|output/i,
    );
    await fs.mkdir(nodePath.join(root, 'output', 'foreign'), { recursive: true });
    await assert.rejects(
      inspectImageDelivery(root, { delivery: 'foreign', target: 'diagram' }),
      /record|delivery|manifest|exist/i,
    );
    // A path is not an entry name.
    await assert.rejects(
      inspectImageDelivery(root, { delivery: delivered.path, target: 'diagram' }),
      /entry|name|record|delivery/i,
    );

    // A saved edit makes the delivered pixels stale, while the binding itself is
    // still real: staleness is reported, not disguised as a broken bundle.
    await fs.writeFile(nodePath.join(root, 'diagram.html'), DIAGRAM_HTML.replace('A → B → C', 'A → B → S'));
    const stale = await inspectImageDelivery(root, { delivery: 'handoff', target: 'diagram' });
    assert.equal(stale.verified, true);
    assert.equal(stale.stale, true);
    assert.equal(stale.build, still.build, 'inspection reports the delivered Build, not a newer one');
    await fs.writeFile(nodePath.join(root, 'diagram.html'), DIAGRAM_HTML);

    // A hand edit to a delivered member blocks the binding WITHOUT throwing, so
    // an author page can still show the actual bundle and the real reason.
    const product = nodePath.join(root, 'output', 'handoff', 'image', 'diagram.png');
    const original = await fs.readFile(product);
    // Replace the directory entry: frozen products may be read-only hard links.
    await fs.unlink(product);
    await fs.writeFile(product, Buffer.concat([original, Buffer.from([0])]), { flag: 'wx' });
    const blocked = await inspectImageDelivery(root, { delivery: 'handoff', target: 'diagram' });
    assert.equal(blocked.verified, false);
    assert.match(blocked.blocked ?? '', /modified|hash|verify|tamper|match/i);
    assert.equal(blocked.target, 'diagram', 'the manifest identity is still reported');
    assert.equal(blocked.sha256, still.sha256);
    // The tampered file is NOT silently repaired or overwritten.
    assert.equal((await fs.readFile(product)).length, original.length + 1);

    // A tampered manifest is reported as blocked as well (record hash mismatch).
    await fs.writeFile(product, original);
    const manifestPath = nodePath.join(root, 'output', 'handoff', 'delivery-manifest.json');
    await fs.appendFile(manifestPath, '   \n');
    const blockedManifest = await inspectImageDelivery(root, { delivery: 'handoff', target: 'diagram' });
    assert.equal(blockedManifest.verified, false);
    assert.match(blockedManifest.blocked ?? '', /modified|hash|verify|manifest|match|record/i);

    // A manifest that no longer parses has no identity to report: it throws.
    await fs.writeFile(manifestPath, '{\n');
    await assert.rejects(
      inspectImageDelivery(root, { delivery: 'handoff', target: 'diagram' }),
      /not valid JSON|malformed/i,
    );
    await fs.rm(manifestPath);
    await assert.rejects(
      inspectImageDelivery(root, { delivery: 'handoff', target: 'diagram' }),
      /no delivery-manifest|not a delivery bundle/i,
    );
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

async function mixedDelivered(
  parent: string,
  options: { privatePlate?: boolean; review?: boolean } = {},
): Promise<{
  root: string;
  delivery: DeliveryResult;
  old: {
    movie: string;
    cover: string;
    record: { manifestSha256: string; build?: string };
    projectBuilds: string[];
  };
}> {
  const root = nodePath.join(parent, 'project');
  await writeProject(root, mixedProject(2, options));
  await writeTwoTargets(root);
  if (options.privatePlate) {
    await fs.writeFile(nodePath.join(root, 'diagram.html'), PLATE_HTML);
    await fs.writeFile(nodePath.join(root, 'plate.png'), ART_PNG);
  }
  await renderImage(root, { target: 'diagram' });
  await renderImage(root, { target: 'cover' });
  const film = await buildProject(root);
  assert.equal(film.status, 'succeeded');
  const delivery = await deliverProject(root, undefined, {
    outputs: { movie: true, images: ['diagram', 'cover'] },
    review: options.review === true,
    allowNonRedistributable: options.privatePlate === true,
  });
  assert.equal(delivery.path, nodePath.join(root, 'output', 'handoff'));
  const bundle = delivery.path;
  return {
    root,
    delivery,
    old: {
      movie: await digestOf(nodePath.join(bundle, 'movie', 'final.mp4')),
      cover: await digestOf(nodePath.join(bundle, 'image', 'cover.jpg')),
      record: await readDeliveryRecord(root, 'handoff'),
      projectBuilds: (await fs.readdir(nodePath.join(bundle, 'project', '.viscraft', 'builds')))
        .filter(file => file.endsWith('.json'))
        .sort(),
    },
  };
}

test('updating a still preserves the movie and verbatim review through the review path map', async () => {
  const parent = await tempDir('reviewed-image-update');
  try {
    const { root, delivery, old } = await mixedDelivered(parent, { review: true });
    const before = await manifestOf(delivery.path);
    assert.ok(before.review);
    const reviewedFiles = [
      before.review.report,
      before.review.paths,
      before.review.contactSheet,
      ...before.review.seams,
      ...before.review.layers,
      ...before.review.candidates,
    ];
    const reviewedHashes = await Promise.all(reviewedFiles.map(file => digestOf(nodePath.join(delivery.path, file))));
    await fs.writeFile(nodePath.join(root, 'diagram.html'), DIAGRAM_HTML.replace('A → B → C', 'A → C'));
    const rendered = await renderImage(root, { target: 'diagram' });
    await updateImageDelivery(root, { delivery: 'handoff', target: 'diagram', build: rendered.build });
    const after = await manifestOf(delivery.path);
    assert.deepEqual(after.review, before.review);
    assert.deepEqual(
      await Promise.all(reviewedFiles.map(file => digestOf(nodePath.join(delivery.path, file)))),
      reviewedHashes,
    );
    assert.equal(await digestOf(nodePath.join(delivery.path, 'movie/final.mp4')), old.movie);
    assert.equal(await digestOf(nodePath.join(delivery.path, 'image/cover.jpg')), old.cover);
    assert.notEqual(
      after.images.find(image => image.target === 'diagram')!.sha256,
      before.images.find(image => image.target === 'diagram')!.sha256,
    );
    assert.equal((await verifyDelivery(delivery.path)).ok, true);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('updating an image preserves a selected sound programme, its Build and the movie', async () => {
  const parent = await tempDir('image-sound-update');
  try {
    const { root, old } = await mixedDelivered(parent);
    const project = validateProject(JSON.parse(await fs.readFile(nodePath.join(root, 'project.json'), 'utf8')));
    const asset = await writeSignalAsset(root, {
      id: 'score',
      path: 'score.wav',
      sampleRate: 48000,
      channels: 1,
      samples: 24000,
      frequency: 440,
    });
    project.assets.push(asset, {
      id: 'unused',
      revision: 1,
      path: 'unused.txt',
      sha256: 'a'.repeat(64),
      type: 'code',
      rights: RIGHTS,
      simulated: false,
    });
    project.soundTargets.push({
      id: 'music',
      sampleRate: 48000,
      channels: 1,
      outputSamples: 24000,
      audio: [
        {
          id: 'score',
          kind: 'asset',
          asset: 'score',
          inSample: 0,
          startSample: 0,
          durationSamples: 24000,
          gain: 1,
          fadeInSamples: 0,
          fadeOutSamples: 0,
        },
      ],
    });
    await writeProject(root, project);
    const soundBuild = await buildProject(root, { target: 'music' });
    const outputs = { movie: true, images: ['diagram', 'cover'], sounds: ['music'] };
    await assert.rejects(
      deliverProject(root, undefined, { outputs }),
      /authored.*unavailable|authored.*missing|authored.*gap/i,
    );
    const delivered = await deliverProject(root, undefined, { outputs, allowIncompleteAuthored: true });
    assert.equal(delivered.project.scope.authorComplete, false);
    assert.equal(delivered.project.scope.selectedProductionComplete, true);
    const sound = delivered.sounds[0];
    const soundBytes = await fs.readFile(nodePath.join(delivered.path, sound.path));
    await fs.writeFile(nodePath.join(root, 'diagram.html'), DIAGRAM_HTML.replace('A → B → C', 'A → B → E'));
    const render = await renderImage(root, { target: 'diagram' });
    const updated = await updateImageDelivery(root, { delivery: 'handoff', target: 'diagram', build: render.build });
    assert.deepEqual(updated.sounds, delivered.sounds);
    assert.equal(updated.project.scope.authoredScope, 'allow-incomplete');
    assert.equal(updated.project.scope.authorComplete, false);
    assert.deepEqual(await fs.readFile(nodePath.join(delivered.path, sound.path)), soundBytes);
    assert.equal(await digestOf(nodePath.join(delivered.path, 'movie/final.mp4')), old.movie);
    assert.equal(await digestOf(nodePath.join(delivered.path, 'image/cover.jpg')), old.cover);
    assert.ok(
      updated.project.builds.includes(soundBuild.id),
      'the sound production closure travels with the refreshed Project',
    );
    assert.equal((await verifyDelivery(delivered.path)).ok, true);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('in-place update replaces only the bound still and reports the one frozen result contract', async () => {
  const parent = await tempDir('image-update');
  try {
    const { root, delivery, old } = await mixedDelivered(parent);
    const bundle = delivery.path;
    const oldManifest = await manifestOf(bundle);
    const oldDiagram = oldManifest.images.find(image => image.target === 'diagram')!;
    const oldCover = oldManifest.images.find(image => image.target === 'cover')!;
    const oldMovie = oldManifest.movie!;
    // A handoff carries the editable project, so its reopen entry says
    // so and points at the recorded entry; still no live URL/token.
    const reopen = oldManifest.images.find(image => image.target === 'diagram')!.workbench!;
    assert.equal(reopen.editableProject, true);
    assert.match(reopen.command, /--delivery handoff$/);
    assert.doesNotMatch(reopen.command, /https?:|token=/);
    const oldDiagramBytes = await fs.readFile(nodePath.join(bundle, ...oldDiagram.path.split('/')));
    const oldArtifactPath = nodePath.join(
      root,
      ...(await artifactPathOf(root, oldDiagram.build, oldDiagram.artifact)).split('/'),
    );
    assert.equal((await buildRecord(root, oldDiagram.build)).medium, 'picture');
    const buildsBefore = await buildIds(root);

    // Two cover renders that are NOT delivered: the first is no longer the
    // current image result once the second is written. The update must carry the
    // delivered still Builds (plus the film and the new one) and must not drag
    // the older, unrelated still history into the hand-off.
    await fs.writeFile(nodePath.join(root, 'cover.html'), COVER_HTML.replace('ISSUE 04', 'ISSUE 05'));
    const olderCover = await renderImage(root, { target: 'cover' });
    assert.equal(olderCover.reused, false);
    await fs.writeFile(nodePath.join(root, 'cover.html'), COVER_HTML.replace('ISSUE 04', 'ISSUE 06'));
    const currentCover = await renderImage(root, { target: 'cover' });
    assert.notEqual(currentCover.build, olderCover.build);

    // A real author edit, saved before the render/publish click.
    const edited = DIAGRAM_HTML.replace('A → B → C', 'A → B → E');
    await fs.writeFile(nodePath.join(root, 'diagram.html'), edited);

    const render = await renderImage(root, { target: 'diagram' });
    const updated = await updateImageDelivery(root, {
      delivery: 'handoff',
      target: 'diagram',
      build: render.build,
    });
    assert.equal(updated.entry, 'handoff');
    assert.equal(updated.productPath, 'image/diagram.png');
    assert.equal(updated.projectPath, 'output/handoff/image/diagram.png');
    assert.equal(updated.format, 'png');
    assert.equal(updated.build, render.build);
    assert.equal(updated.artifact, render.artifact);
    assert.notEqual(updated.build, oldDiagram.build);
    assert.notEqual(updated.artifact, oldDiagram.artifact);
    // The frozen result contract: no `reused`, no `physicalBytes` alias.
    assert.equal('reused' in updated, false);
    assert.equal('physicalBytes' in updated, false);
    assert.equal(
      updated.previous?.sha256,
      sha256(oldDiagramBytes),
      'the previous product is reported, not claimed current',
    );
    assert.deepEqual(
      {
        path: updated.previous?.path,
        build: updated.previous?.build,
        artifact: updated.previous?.artifact,
        bytes: updated.previous?.bytes,
      },
      {
        path: oldDiagram.path,
        build: oldDiagram.build,
        artifact: oldDiagram.artifact,
        bytes: oldDiagram.bytes,
      },
    );

    // The delivered product is the NEW render at the same stable path.
    const newBytes = await fs.readFile(nodePath.join(bundle, 'image', 'diagram.png'));
    assert.notEqual(sha256(newBytes), sha256(oldDiagramBytes), 'the delivered pixels really changed');
    assert.equal(updated.sha256, sha256(newBytes));
    assert.equal(updated.image.sha256, sha256(newBytes));
    assert.equal(updated.image.bytes, newBytes.length, 'image.bytes is THIS still only');
    assert.equal(updated.image.path, 'image/diagram.png');
    assert.equal(updated.image.build, render.build);
    assert.equal(updated.width, updated.image.width);
    assert.equal(updated.height, updated.image.height);
    assert.equal(
      await digestOf(nodePath.join(root, ...(await artifactPathOf(root, updated.build, updated.artifact)).split('/'))),
      sha256(newBytes),
      'the new Artifact is the delivered bytes',
    );

    // The bundle-wide counters are distinct facts: `bytes` is the physical
    // payload (deduplicated distinct inodes, manifest excluded), `logicalBytes`
    // is the sum of every listed file, `files` is the listed count.
    const newManifest = await manifestOf(bundle);
    assert.equal(updated.manifest, 'delivery-manifest.json');
    assert.equal(updated.manifestSha256, await digestOf(nodePath.join(bundle, updated.manifest)));
    assert.equal(updated.files, newManifest.files.length);
    assert.equal(
      updated.logicalBytes,
      newManifest.files.reduce((sum, file) => sum + file.bytes, 0),
    );
    assert.equal(updated.bytes, await physicalPayloadBytes(bundle));
    assert.ok(updated.bytes > updated.image.bytes, 'the whole bundle is larger than one still');

    // The edited project is re-exported with its REAL scope facts, not a summary.
    assert.ok(updated.project, 'a handoff keeps its editable project');
    assert.equal(updated.project!.path, 'project');
    assert.equal(updated.project!.files, updated.project!.scope.counts.files);
    // A local, fully-readable author state projects an explicit empty gap list.
    assert.equal(updated.project!.scope.authoredScope, 'complete');
    assert.equal(updated.project!.scope.authorComplete, true);
    assert.equal(updated.project!.scope.wholeAuthorRestorable, true);
    assert.deepEqual(updated.project!.scope.authoredGaps, []);
    const authorInputs = await snapshotInputs(root, updated.build);
    assert.deepEqual(authorInputs.unavailable, [], 'the author projection has no hidden gaps');
    assert.equal(authorInputs.files['diagram.html'], sha256(edited));
    const exportedInputs = await snapshotInputs(nodePath.join(bundle, 'project'), updated.build);
    assert.deepEqual(exportedInputs.unavailable, [], 'the exported projection preserves the empty gap list');
    assert.equal(exportedInputs.files['diagram.html'], sha256(edited));
    assert.equal(updated.project!.originals, updated.project!.scope.counts.originals);
    assert.equal(updated.project!.scope.requested, 'default');
    assert.deepEqual(updated.project!.warnings, []);
    assert.equal(typeof updated.project!.scope.originalsComplete, 'boolean');

    // The OLD Build/Artifact is immutable and still readable.
    assert.equal(await exists(oldArtifactPath), true, 'the replaced Artifact is not deleted');
    assert.equal(await digestOf(oldArtifactPath), sha256(oldDiagramBytes), 'the old Artifact keeps its pixels');
    assert.equal(await exists(nodePath.join(root, '.viscraft', 'builds', `${oldDiagram.build}.json`)), true);
    assert.equal(await exists(nodePath.join(root, '.viscraft', 'builds', `${olderCover.build}.json`)), true);

    // No provider ran: updating a saved still is a render-image Build only.
    assert.deepEqual(await operationKinds(root, updated.build), ['render-image']);
    assert.equal((await buildRecord(root, updated.build)).medium, 'picture');
    assert.equal(oldDiagram.simulated, false);
    assert.deepEqual(
      await buildIds(root),
      [...buildsBefore, olderCover.build, currentCover.build, render.build].sort(),
      'the update itself creates no Build',
    );

    // Other delivered products are BIT-IDENTICAL, not re-encoded.
    assert.equal(await digestOf(nodePath.join(bundle, 'movie', 'final.mp4')), old.movie);
    assert.equal(await digestOf(nodePath.join(bundle, 'image', 'cover.jpg')), old.cover);
    assert.equal(newManifest.movie!.sha256, oldMovie.sha256);
    assert.deepEqual(
      newManifest.images.find(image => image.target === 'cover'),
      oldCover,
      'the other still entry is unchanged in the manifest',
    );
    assert.deepEqual(newManifest.selection, oldManifest.selection);
    assert.equal(newManifest.build!.id, oldManifest.build!.id, 'the film Build is still the delivered film');
    assert.deepEqual(updated.retained, {
      movie: true,
      images: ['cover'],
      files: updated.preserved.length,
    });
    assert.ok(updated.preserved.includes('movie/final.mp4'));
    assert.ok(updated.preserved.includes('image/cover.jpg'));
    assert.equal(
      updated.preserved.some(file => file.startsWith('project/')),
      false,
      'project/ is re-exported whole, never reported as preserved bytes',
    );

    // The diagram entry + its material now describe the NEW Build.
    const newDiagram = newManifest.images.find(image => image.target === 'diagram')!;
    assert.equal(newDiagram.build, updated.build);
    assert.equal(newDiagram.artifact, updated.artifact);
    assert.equal(newDiagram.sha256, updated.sha256);
    assert.equal(newDiagram.bytes, updated.image.bytes);
    assert.equal(newManifest.imageMaterials!.find(material => material.target === 'diagram')!.build, updated.build);
    assert.equal(newManifest.imageMaterials!.find(material => material.target === 'cover')!.build, oldCover.build);

    // The index and the hashed allowlist describe the new file as well.
    const index = await fs.readFile(nodePath.join(bundle, 'index.html'), 'utf8');
    assert.match(index, /image\/diagram\.png/);
    const listed = newManifest.files.find(file => file.path === 'image/diagram.png')!;
    assert.equal(listed.sha256, updated.sha256);
    assert.equal(listed.bytes, updated.image.bytes);
    const coverListed = newManifest.files.find(file => file.path === 'image/cover.jpg')!;
    assert.equal(coverListed.sha256, oldCover.sha256);

    // The record describes the same bundle identity; verify passes.
    const record = await readDeliveryRecord(root, 'handoff');
    const manifestSha256 = await digestOf(nodePath.join(bundle, 'delivery-manifest.json'));
    assert.equal(record.manifestSha256, manifestSha256);
    assert.equal(record.build, old.record.build, 'the film Build recorded for this handoff did not change');
    assert.equal((await verifyDelivery(bundle)).ok, true);

    // The bundle still carries exactly ONE editable Project; the new Build and
    // the still Builds actually delivered are in its lineage, while an unrelated
    // new render is not smuggled in by the update.
    const projectBuilds = (await fs.readdir(nodePath.join(bundle, 'project', '.viscraft', 'builds')))
      .filter(file => file.endsWith('.json'))
      .sort();
    assert.ok(projectBuilds.includes(`${updated.build}.json`), 'the new still Build is in the exported lineage');
    assert.ok(projectBuilds.includes(`${oldDiagram.build}.json`), 'the replaced but still-delivered Build stays');
    assert.ok(projectBuilds.includes(`${oldCover.build}.json`), 'the other delivered still Build stays');
    for (const file of old.projectBuilds) assert.ok(projectBuilds.includes(file), `the previous closure keeps ${file}`);
    assert.equal(
      projectBuilds.includes(`${olderCover.build}.json`),
      false,
      'an unrelated old render is not added to the delivered lineage',
    );
    assert.equal(
      await fs.readFile(nodePath.join(bundle, 'project', 'diagram.html'), 'utf8'),
      edited,
      'the editable project carries the saved edit',
    );
    assert.deepEqual(await outputEntries(root), ['handoff'], 'no second delivery directory appeared');

    // Inspection after the update reports the new still and no stale binding.
    const inspected = await inspectImageDelivery(root, { delivery: 'handoff', target: 'diagram' });
    assert.equal(inspected.verified, true);
    assert.equal(inspected.build, updated.build);
    assert.equal(inspected.sha256, updated.sha256);
    assert.equal(inspected.stale, false);

    // A receiver can take the single carried project and produce the still
    // again in its own working directory (nothing points back at the sender).
    const receiver = nodePath.join(parent, 'receiver');
    await fs.cp(nodePath.join(bundle, 'project'), receiver, { recursive: true });
    const rebuilt = await renderImage(receiver, { target: 'diagram' });
    assert.deepEqual(
      { width: rebuilt.width, height: rebuilt.height },
      { width: 400, height: 240 },
      'the received project renders the same real output pixels',
    );
    assert.ok(await exists(nodePath.join(receiver, ...rebuilt.path.split('/'))));
    assert.equal(
      (await buildRecord(receiver, rebuilt.build)).operations.some(operation => operation.kind === 'render-image'),
      true,
    );

    // Source/output separation: the author source and original media survive.
    assert.equal(await fs.readFile(nodePath.join(root, 'diagram.html'), 'utf8'), edited);
    assert.equal(await exists(oldArtifactPath), true);
    assert.equal(await exists(nodePath.join(bundle, 'project', 'project.json')), true);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('changing a target format updates the managed product extension instead of leaving a stale one', async () => {
  const parent = await tempDir('image-update-format');
  try {
    const root = nodePath.join(parent, 'project');
    const bundle = nodePath.join(root, 'output', 'handoff');
    await writeProject(root, twoTargetProject());
    await writeTwoTargets(root);
    await renderImage(root, { target: 'diagram' });
    await renderImage(root, { target: 'cover' });
    await deliverProject(root, undefined, { outputs: { images: ['diagram', 'cover'] } });
    const oldCover = await digestOf(nodePath.join(bundle, 'image', 'cover.jpg'));
    const oldPng = await digestOf(nodePath.join(bundle, 'image', 'diagram.png'));

    // The author changes the declared format; the runtime records a new Build.
    const project = JSON.parse(await fs.readFile(nodePath.join(root, 'project.json'), 'utf8')) as {
      imageTargets: Array<{ id: string; format: string }>;
    };
    project.imageTargets.find(target => target.id === 'diagram')!.format = 'jpeg';
    await fs.writeFile(nodePath.join(root, 'project.json'), `${JSON.stringify(validateProject(project), null, 2)}\n`);
    const render = await renderImage(root, { target: 'diagram' });
    const updated = await updateImageDelivery(root, {
      delivery: 'handoff',
      target: 'diagram',
      build: render.build,
    });

    assert.equal(updated.format, 'jpeg');
    assert.equal(updated.productPath, 'image/diagram.jpg', 'the managed entry uses the real extension');
    assert.equal(updated.projectPath, 'output/handoff/image/diagram.jpg');
    assert.equal(await exists(nodePath.join(bundle, 'image', 'diagram.png')), false, 'no fake current .png remains');
    assert.equal(await digestOf(nodePath.join(bundle, 'image', 'diagram.jpg')), updated.sha256);
    assert.notEqual(updated.sha256, oldPng);
    // The old Artifact bytes are still available; only the PRODUCT moved.
    assert.equal(await digestOf(nodePath.join(root, ...render.path.split('/'))), updated.sha256);

    const manifest = await manifestOf(bundle);
    assert.equal(manifest.images.find(image => image.target === 'diagram')!.path, 'image/diagram.jpg');
    assert.equal(
      manifest.files.some(file => file.path === 'image/diagram.png'),
      false,
    );
    assert.equal(
      manifest.files.some(file => file.path === 'image/diagram.jpg'),
      true,
    );
    assert.equal(await digestOf(nodePath.join(bundle, 'image', 'cover.jpg')), oldCover);
    assert.equal((await verifyDelivery(bundle)).ok, true);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('an update without a build never renders: no current result is refused, a current one is reused', async () => {
  const parent = await tempDir('image-update-nobuild');
  try {
    const { root, delivery } = await mixedDelivered(parent);
    const bundle = delivery.path;
    const before = await fs.readFile(nodePath.join(bundle, 'image', 'diagram.png'));
    const manifestBefore = await fs.readFile(nodePath.join(bundle, 'delivery-manifest.json'));
    const buildsBefore = await buildIds(root);

    // The saved design no longer matches the delivered Build, and there is no
    // succeeded render for the NEW bytes yet. An update must refuse, not render
    // a replacement behind the author's back.
    await fs.writeFile(nodePath.join(root, 'diagram.html'), DIAGRAM_HTML.replace('A → B → C', 'A → B → N'));
    await assert.rejects(
      updateImageDelivery(root, { delivery: 'handoff', target: 'diagram' }),
      /no succeeded render|never renders|current saved source/i,
    );
    assert.deepEqual(await buildIds(root), buildsBefore, 'the refused update created no Build');
    assert.equal(sha256(await fs.readFile(nodePath.join(bundle, 'image', 'diagram.png'))), sha256(before));
    assert.equal(sha256(await fs.readFile(nodePath.join(bundle, 'delivery-manifest.json'))), sha256(manifestBefore));
    assert.equal((await verifyDelivery(bundle)).ok, true);

    // Render the saved design once. The subsequent no-build update publishes
    // exactly that result and still creates no further Build.
    const render = await renderImage(root, { target: 'diagram' });
    assert.equal(render.reused, false);
    const updated = await updateImageDelivery(root, { delivery: 'handoff', target: 'diagram' });
    assert.equal(updated.build, render.build);
    assert.equal(updated.artifact, render.artifact);
    assert.deepEqual(
      await buildIds(root),
      [...buildsBefore, render.build].sort(),
      'the update published the render instead of making its own Build',
    );
    assert.equal((await verifyDelivery(bundle)).ok, true);
    assert.equal((await readDeliveryRecord(root, 'handoff')).manifestSha256, updated.manifestSha256);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('publication is mutually exclusive for both writers and the record is durable before the lock opens', async () => {
  const parent = await tempDir('image-update-lock');
  try {
    const { root, delivery } = await mixedDelivered(parent);
    const bundle = delivery.path;
    const before = await deliveredStillBytes(root, 'diagram');
    const manifestBefore = await digestOf(nodePath.join(bundle, 'delivery-manifest.json'));
    const recordPath = nodePath.join(root, '.viscraft', 'deliveries', 'handoff.json');
    const pendingPath = nodePath.join(root, '.viscraft', 'deliveries', 'handoff.pending');
    const recordBefore = await fs.readFile(recordPath);

    await fs.writeFile(nodePath.join(root, 'diagram.html'), DIAGRAM_HTML.replace('A → B → C', 'A → B → J'));
    const render = await renderImage(root, { target: 'diagram' });

    const release = await acquireDeliveryLock(root);
    try {
      // A default delivery takes the SAME publication lock as an in-place
      // update. It may stage first, but it may not publish or write the record.
      await assert.rejects(
        deliverProject(root, undefined, {
          outputs: { movie: true, images: ['diagram', 'cover'] },
        }),
        /locked|publication|wait/i,
      );
      await assert.rejects(
        updateImageDelivery(root, { delivery: 'handoff', target: 'diagram', build: render.build }),
        /locked|publication|wait/i,
      );
      // Neither blocked writer changed anything.
      assert.equal(sha256(await fs.readFile(nodePath.join(bundle, 'image', 'diagram.png'))), sha256(before));
      assert.equal(await digestOf(nodePath.join(bundle, 'delivery-manifest.json')), manifestBefore);
      assert.equal(sha256(await fs.readFile(recordPath)), sha256(recordBefore));
      assert.equal(await exists(pendingPath), false);
    } finally {
      await release();
    }
    // A rejected default delivery cleans its staging directory; no partial entry
    // and no recovery marker survive.
    assert.deepEqual(await outputEntries(root), ['handoff']);
    assert.equal(await exists(pendingPath), false);

    // With the lock released the same update lands normally.
    const updated = await updateImageDelivery(root, {
      delivery: 'handoff',
      target: 'diagram',
      build: render.build,
    });
    assert.equal(updated.sha256, await digestOf(nodePath.join(bundle, 'image', 'diagram.png')));
    assert.equal((await verifyDelivery(bundle)).ok, true);

    // A following DEFAULT delivery replaces the entry through the same lock. Its
    // durable outcome is observable atomically from outside: the manifest hash,
    // the record identity and the cleared recovery marker all agree the moment
    // the entry is visible again.
    const redelivered = await deliverProject(root, undefined, {
      outputs: { movie: true, images: ['diagram', 'cover'] },
    });
    assert.equal(redelivered.path, bundle);
    const manifestAfter = await digestOf(nodePath.join(bundle, 'delivery-manifest.json'));
    assert.equal(redelivered.manifestSha256, manifestAfter);
    const recordAfter = await readDeliveryRecord(root, 'handoff');
    assert.equal(recordAfter.manifestSha256, manifestAfter, 'the record and the live manifest agree');
    assert.equal(await exists(pendingPath), false, 'the recovery marker is cleared before the lock opens');
    assert.equal((await verifyDelivery(bundle)).ok, true);
    assert.deepEqual(await outputEntries(root), ['handoff'], 'no staging or aside directory is left behind');
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('an explicit Build whose saved source has since changed is refused, not presented as current', async () => {
  const parent = await tempDir('image-update-stale');
  try {
    const { root, delivery } = await mixedDelivered(parent);
    const bundle = delivery.path;
    const before = await deliveredStillBytes(root, 'diagram');
    const manifestBefore = await digestOf(nodePath.join(bundle, 'delivery-manifest.json'));

    // Render version A, then save version B before the update click. The A
    // Build is real and readable, but it does not describe the saved design.
    await fs.writeFile(nodePath.join(root, 'diagram.html'), DIAGRAM_HTML.replace('A → B → C', 'A → B → K'));
    const staleRender = await renderImage(root, { target: 'diagram' });
    await fs.writeFile(nodePath.join(root, 'diagram.html'), DIAGRAM_HTML.replace('A → B → C', 'A → B → L'));

    await assert.rejects(
      updateImageDelivery(root, { delivery: 'handoff', target: 'diagram', build: staleRender.build }),
      /saved source changed|changed while|stale|current/i,
    );
    // The delivered file still shows the PREVIOUS accepted design; the A Build
    // remains an immutable, readable Artifact.
    assert.equal(sha256(await fs.readFile(nodePath.join(bundle, 'image', 'diagram.png'))), sha256(before));
    assert.equal(await digestOf(nodePath.join(bundle, 'delivery-manifest.json')), manifestBefore);
    assert.equal(
      await exists(
        nodePath.join(root, ...(await artifactPathOf(root, staleRender.build, staleRender.artifact)).split('/')),
      ),
      true,
    );

    // Updating the CURRENT saved source succeeds and is the only way the
    // delivered file becomes current.
    const currentRender = await renderImage(root, { target: 'diagram' });
    const updated = await updateImageDelivery(root, {
      delivery: 'handoff',
      target: 'diagram',
      build: currentRender.build,
    });
    assert.equal(updated.build, currentRender.build);
    assert.notEqual(sha256(await fs.readFile(nodePath.join(bundle, 'image', 'diagram.png'))), sha256(before));
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('a hand-edited bundle is refused and the previous product is left exactly as it was', async () => {
  const parent = await tempDir('image-update-tamper');
  try {
    const { root, delivery } = await mixedDelivered(parent);
    const bundle = delivery.path;
    const product = nodePath.join(bundle, 'image', 'diagram.png');
    const original = await fs.readFile(product);
    const manifestBefore = await fs.readFile(nodePath.join(bundle, 'delivery-manifest.json'));
    const coverBefore = await digestOf(nodePath.join(bundle, 'image', 'cover.jpg'));
    const movieBefore = await digestOf(nodePath.join(bundle, 'movie', 'final.mp4'));

    // Replace this member without changing its read-only deduplicated siblings.
    await fs.unlink(product);
    await fs.writeFile(product, Buffer.concat([original, Buffer.from('hand edit')]), { flag: 'wx' });
    const tampered = await fs.readFile(product);

    await fs.writeFile(nodePath.join(root, 'diagram.html'), DIAGRAM_HTML.replace('A → B → C', 'A → B → F'));
    const render = await renderImage(root, { target: 'diagram' });
    await assert.rejects(
      updateImageDelivery(root, { delivery: 'handoff', target: 'diagram', build: render.build }),
      /modified|hash|verify|tamper|match|delivery/i,
    );
    // The tampered product is NOT overwritten, and the other products are intact.
    assert.equal(sha256(await fs.readFile(product)), sha256(tampered));
    assert.equal(sha256(await fs.readFile(nodePath.join(bundle, 'delivery-manifest.json'))), sha256(manifestBefore));
    assert.equal(await digestOf(nodePath.join(bundle, 'image', 'cover.jpg')), coverBefore);
    assert.equal(await digestOf(nodePath.join(bundle, 'movie', 'final.mp4')), movieBefore);
    assert.deepEqual(await outputEntries(root), ['handoff']);
    // No staging/work directory was left behind beside output/.
    const leftovers = (await fs.readdir(nodePath.join(root, 'output'))).filter(
      name => name.includes('.staging') || name.includes('.work'),
    );
    assert.deepEqual(leftovers, []);

    // A tampered manifest (with restored product bytes) is refused as well.
    await fs.writeFile(product, original);
    await fs.appendFile(nodePath.join(bundle, 'delivery-manifest.json'), '   \n');
    await assert.rejects(
      updateImageDelivery(root, { delivery: 'handoff', target: 'diagram', build: render.build }),
      /modified|hash|verify|manifest|match|record|delivery/i,
    );
    assert.equal(await digestOf(nodePath.join(bundle, 'image', 'cover.jpg')), coverBefore);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('a render or update failure keeps the previously delivered image and never claims it is current', async () => {
  const parent = await tempDir('image-update-failure');
  try {
    const { root, delivery } = await mixedDelivered(parent);
    const bundle = delivery.path;
    const before = await fs.readFile(nodePath.join(bundle, 'image', 'diagram.png'));
    const manifestBefore = await fs.readFile(nodePath.join(bundle, 'delivery-manifest.json'));
    const recordBefore = await readDeliveryRecord(root, 'handoff');

    // A declared resource disappears: the render is a REAL failure.
    await fs.rm(nodePath.join(root, 'diagram.css'));
    await fs.writeFile(nodePath.join(root, 'diagram.html'), DIAGRAM_HTML.replace('A → B → C', 'A → B → G'));
    await assert.rejects(renderImage(root, { target: 'diagram' }), /resource|missing|CSS|failed|ENOENT/i);
    assert.equal(sha256(await fs.readFile(nodePath.join(bundle, 'image', 'diagram.png'))), sha256(before));
    assert.equal(sha256(await fs.readFile(nodePath.join(bundle, 'delivery-manifest.json'))), sha256(manifestBefore));
    assert.equal(
      (await readDeliveryRecord(root, 'handoff')).manifestSha256,
      recordBefore.manifestSha256,
      'the record still describes the unchanged bundle',
    );
    assert.equal((await verifyDelivery(bundle)).ok, true);

    // Restore the resource. A render succeeds, but updating into a bundle whose
    // manifest is gone is refused (and does not fall back to another path).
    await fs.writeFile(nodePath.join(root, 'diagram.css'), DIAGRAM_CSS);
    const render = await renderImage(root, { target: 'diagram' });
    await fs.rm(nodePath.join(bundle, 'delivery-manifest.json'));
    await assert.rejects(
      updateImageDelivery(root, { delivery: 'handoff', target: 'diagram', build: render.build }),
      /manifest|delivery|exist|record|verify/i,
    );
    assert.equal(sha256(await fs.readFile(nodePath.join(bundle, 'image', 'diagram.png'))), sha256(before));
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('only a recorded delivery of THIS Project can be inspected or updated', async () => {
  const parent = await tempDir('image-update-paths');
  try {
    const { root, delivery } = await mixedDelivered(parent);
    const authorDocument = await fs.readFile(nodePath.join(root, 'diagram.html'));
    const render = await renderImage(root, { target: 'diagram' });

    // An explicit destination outside output/ is NOT a Runtime-recorded entry
    // and can never be bound or updated by name.
    const external = nodePath.join(parent, 'external');
    await deliverProject(root, external, { outputs: { images: ['diagram'] } });
    await assert.rejects(
      inspectImageDelivery(root, { delivery: 'external', target: 'diagram' }),
      /entry|record|delivery|output/i,
    );
    await assert.rejects(
      updateImageDelivery(root, { delivery: 'external', target: 'diagram', build: render.build }),
      /entry|record|delivery|output/i,
    );

    // A directory inside the Project but outside output/ is not an entry either.
    await fs.mkdir(nodePath.join(root, 'bundle'), { recursive: true });
    await assert.rejects(
      inspectImageDelivery(root, { delivery: 'bundle', target: 'diagram' }),
      /entry|record|delivery|output/i,
    );
    await assert.rejects(
      updateImageDelivery(root, { delivery: 'bundle', target: 'diagram', build: render.build }),
      /entry|record|delivery|output/i,
    );
    // A path is not an entry name for writers either.
    await assert.rejects(
      updateImageDelivery(root, { delivery: delivery.path, target: 'diagram', build: render.build }),
      /entry|name|record|delivery/i,
    );

    // A bundle recorded by ANOTHER Project is refused even when the record and
    // directory are copied here: the manifest's Project id is the identity, not
    // the folder name. Neither inspection nor the direct writer may bind it.
    const foreignRoot = nodePath.join(parent, 'foreign-project');
    await writeProject(foreignRoot, validateProject({ ...twoTargetProject(), id: 'someone_else' }));
    await fs.cp(delivery.path, nodePath.join(foreignRoot, 'output', 'handoff'), { recursive: true });
    await fs.mkdir(nodePath.join(foreignRoot, '.viscraft', 'deliveries'), { recursive: true });
    await fs.copyFile(
      nodePath.join(root, '.viscraft', 'deliveries', 'handoff.json'),
      nodePath.join(foreignRoot, '.viscraft', 'deliveries', 'handoff.json'),
    );
    const foreignProduct = await fs.readFile(nodePath.join(foreignRoot, 'output', 'handoff', 'image', 'diagram.png'));
    const foreignManifest = await fs.readFile(
      nodePath.join(foreignRoot, 'output', 'handoff', 'delivery-manifest.json'),
    );
    await assert.rejects(
      inspectImageDelivery(foreignRoot, { delivery: 'handoff', target: 'diagram' }),
      /delivered from Project|not .*cannot be bound/i,
    );
    // The writer proves the Project identity before it even reads a Build.
    await assert.rejects(
      updateImageDelivery(foreignRoot, {
        delivery: 'handoff',
        target: 'diagram',
        build: 'build-not-owned-here',
      }),
      /delivered from Project|not .*cannot be (bound|updated)/i,
    );
    assert.equal(
      sha256(await fs.readFile(nodePath.join(foreignRoot, 'output', 'handoff', 'image', 'diagram.png'))),
      sha256(foreignProduct),
      'the foreign bundle is left untouched',
    );
    assert.equal(
      sha256(await fs.readFile(nodePath.join(foreignRoot, 'output', 'handoff', 'delivery-manifest.json'))),
      sha256(foreignManifest),
    );

    // The author source is never nested in the bundle, and updates leave it
    // byte-identical.
    assert.equal(
      await digestOf(nodePath.join(root, 'diagram.html')),
      sha256(authorDocument),
      'the author document is not rewritten by delivery/update',
    );
    assert.equal(await exists(nodePath.join(delivery.path, 'project', 'output')), false);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('a required provider original missing from the author root refuses the update and is carried once', async () => {
  const parent = await tempDir('image-update-original');
  const root = nodePath.join(parent, 'project');
  const bundle = nodePath.join(root, 'output', 'handoff');
  const original = nodePath.join(root, '.viscraft', 'provider-media', 'image-api-plate.1.png');
  try {
    await writeProject(root, generatedStillProject());
    await fs.writeFile(nodePath.join(root, 'flat.html'), FLAT_HTML.replace('src="art.png"', 'src="plate.png"'));
    await fs.writeFile(nodePath.join(root, 'flat.css'), FLAT_CSS);
    await fs.writeFile(nodePath.join(root, 'plate.png'), ART_PNG);
    await fs.mkdir(nodePath.dirname(original), { recursive: true });
    await fs.writeFile(original, ART_PNG);

    const first = await renderImage(root, { target: 'cover' });
    assert.equal(first.reused, false);
    const delivered = await deliverProject(root, undefined, { outputs: { images: ['cover'] } });
    assert.ok(delivered.project, 'a handoff carries the editable project');
    const originalsInBundle = (await walk(nodePath.join(bundle, 'project'))).filter(file =>
      file.startsWith('.viscraft/provider-media/'),
    );
    assert.deepEqual(originalsInBundle, ['.viscraft/provider-media/image-api-plate.1.png']);
    assert.equal(
      await digestOf(nodePath.join(bundle, 'project', ...originalsInBundle[0]!.split('/'))),
      sha256(ART_PNG),
    );

    // The provider original is gone from the author root; only the normalized
    // Asset copy remains. A hand-off that silently dropped the required original
    // would be a false recovery promise, so the update must refuse.
    await fs.rm(original);
    const edited = FLAT_HTML.replace('src="art.png"', 'src="plate.png"').replace('</body>', '<!-- edited --></body>');
    await fs.writeFile(nodePath.join(root, 'flat.html'), edited);
    const render = await renderImage(root, { target: 'cover' });
    const before = await fs.readFile(nodePath.join(bundle, 'image', 'cover.png'));
    const manifestBefore = await fs.readFile(nodePath.join(bundle, 'delivery-manifest.json'));
    await assert.rejects(
      updateImageDelivery(root, { delivery: 'handoff', target: 'cover', build: render.build }),
      /required local provider original|provider-media|normalized/i,
    );
    assert.equal(sha256(await fs.readFile(nodePath.join(bundle, 'image', 'cover.png'))), sha256(before));
    assert.equal(sha256(await fs.readFile(nodePath.join(bundle, 'delivery-manifest.json'))), sha256(manifestBefore));
    assert.equal((await verifyDelivery(bundle)).ok, true);

    // Restoring the unique original lets the update succeed, and the refreshed
    // project carries exactly one physical copy with the recorded scope count.
    await fs.writeFile(original, ART_PNG);
    const updated = await updateImageDelivery(root, { delivery: 'handoff', target: 'cover', build: render.build });
    assert.ok(updated.project);
    assert.equal(updated.project!.originals, 1);
    assert.equal(updated.project!.scope.counts.originals, 1);
    assert.equal(updated.project!.scope.originalsComplete, true);
    const carried = (await walk(nodePath.join(bundle, 'project'))).filter(file =>
      file.startsWith('.viscraft/provider-media/'),
    );
    assert.equal(carried.length, 1, 'the one original is carried once, never duplicated per owner');
    assert.equal(await digestOf(nodePath.join(bundle, 'project', ...carried[0]!.split('/'))), sha256(ART_PNG));
    assert.equal((await verifyDelivery(bundle)).ok, true);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('a save that lands after staging starts refuses the publish and leaves the old bundle intact', async () => {
  const parent = await tempDir('image-update-stage-race');
  try {
    const root = nodePath.join(parent, 'project');
    await writeProject(root, mixedProject(2, { pad: true }));
    await writeTwoTargets(root);
    // A real, sizeable CSS resource keeps the staging copy/hash window open long
    // enough for a filesystem-level save; this is the test's own observation of
    // the existing staging directory, not a product testing hook.
    await fs.writeFile(nodePath.join(root, 'pad.css'), `/* padding */\n${' '.repeat(4 * 1024 * 1024)}`);
    await renderImage(root, { target: 'diagram' });
    await renderImage(root, { target: 'cover' });
    assert.equal((await buildProject(root)).status, 'succeeded');
    await deliverProject(root, undefined, {
      outputs: { movie: true, images: ['diagram', 'cover'] },
    });
    const bundle = nodePath.join(root, 'output', 'handoff');
    const before = await fs.readFile(nodePath.join(bundle, 'image', 'diagram.png'));
    const manifestBefore = await fs.readFile(nodePath.join(bundle, 'delivery-manifest.json'));

    const edited = DIAGRAM_HTML.replace('A → B → C', 'A → B → R');
    await fs.writeFile(nodePath.join(root, 'diagram.html'), edited);
    const render = await renderImage(root, { target: 'diagram' });

    const publishing = updateImageDelivery(root, {
      delivery: 'handoff',
      target: 'diagram',
      build: render.build,
    });
    // Wait for the independent staging directory to appear, then save again:
    // the final live-source check must reject instead of mislabelling pixels.
    const saving = waitUntil(async () => {
      const names = await fs.readdir(nodePath.join(root, 'output')).catch(() => []);
      return names.some(name => name.startsWith('.handoff.') && name.endsWith('.staging'));
    }, 'the update staging directory').then(async () => {
      await fs.writeFile(nodePath.join(root, 'diagram.html'), DIAGRAM_HTML.replace('A → B → C', 'A → B → T'));
    });

    await assert.rejects(publishing, /changed while|saved source changed|stale|current/i);
    await saving;

    // Nothing was published: the previous product, manifest and record still
    // describe the same old bundle, and no staging work is left behind.
    assert.equal(sha256(await fs.readFile(nodePath.join(bundle, 'image', 'diagram.png'))), sha256(before));
    assert.equal(sha256(await fs.readFile(nodePath.join(bundle, 'delivery-manifest.json'))), sha256(manifestBefore));
    assert.equal((await verifyDelivery(bundle)).ok, true);
    const leftovers = (await fs.readdir(nodePath.join(root, 'output'))).filter(
      name => name.includes('.staging') || name.includes('.work'),
    );
    assert.deepEqual(leftovers, []);

    // Saving and rendering the final design converges normally.
    const finalRender = await renderImage(root, { target: 'diagram' });
    const updated = await updateImageDelivery(root, {
      delivery: 'handoff',
      target: 'diagram',
      build: finalRender.build,
    });
    assert.equal(updated.build, finalRender.build);
    assert.equal((await verifyDelivery(bundle)).ok, true);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('replacing a still keeps the retained film and its old private fact', async () => {
  const parent = await tempDir('image-update-private');
  try {
    const { root, delivery, old } = await mixedDelivered(parent, { privatePlate: true });
    const bundle = delivery.path;
    const oldManifest = await manifestOf(bundle);
    assert.equal(oldManifest.containsNonRedistributableAssets, true);
    assert.deepEqual(
      oldManifest.nonRedistributableAssets?.map(asset => asset.asset),
      ['plate'],
      'the private plate is recorded for the delivered still',
    );

    // The author stops using the private plate and republishes the still. The
    // retained movie may still depend on that Asset, so the bundle-wide private
    // fact must not be dropped just because the replaced still stopped naming it.
    const project = JSON.parse(await fs.readFile(nodePath.join(root, 'project.json'), 'utf8')) as {
      assets: unknown[];
      imageDocuments: Array<{ id: string; resources: string[] }>;
    };
    project.assets = [];
    project.imageDocuments.find(document => document.id === 'flow')!.resources = ['diagram.css'];
    await fs.writeFile(nodePath.join(root, 'project.json'), `${JSON.stringify(validateProject(project), null, 2)}\n`);
    await fs.writeFile(nodePath.join(root, 'diagram.html'), DIAGRAM_HTML.replace('A → B → C', 'A → B → P'));
    const render = await renderImage(root, { target: 'diagram' });
    const updated = await updateImageDelivery(root, {
      delivery: 'handoff',
      target: 'diagram',
      build: render.build,
    });

    assert.equal(updated.retained.movie, true);
    assert.equal(await digestOf(nodePath.join(bundle, 'movie', 'final.mp4')), old.movie, 'the film is untouched');
    const manifest = await manifestOf(bundle);
    assert.equal(manifest.containsNonRedistributableAssets, true);
    assert.deepEqual(
      manifest.nonRedistributableAssets?.map(asset => asset.asset),
      ['plate'],
      'the retained movie keeps the bundle-wide private fact',
    );
    assert.deepEqual(
      manifest.imageMaterials!.find(material => material.target === 'diagram')!.assets,
      [],
      'the NEW still no longer declares the private plate',
    );
    assert.equal((await verifyDelivery(bundle)).ok, true);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
