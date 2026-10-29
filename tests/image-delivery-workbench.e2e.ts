/**
 * E2E: the workbench bound to an ALREADY DELIVERED still.
 *
 * The user has a final product file (`output/<entry>/image/<target>.<ext>`).
 * This suite proves, against a real loopback Runtime and a real Chrome page:
 *
 *  - binding is by recorded output entry only; missing, foreign, wrong-target
 *    and path-shaped bindings are refused at startup, while a parseable bundle
 *    whose bytes were tampered opens in a BLOCKED state with the real reason;
 *  - a save alone does NOT publish (the delivered file stays as delivered);
 *  - clicking Render publishes the exact Build it produced into the SAME
 *    stable product path; the old Build/Artifact stays readable, the other
 *    delivered target and the film stay byte-identical, and `verify` passes;
 *  - the page shows the delivered product path (not just the internal
 *    Artifact), and an external save marks that product stale;
 *  - `/api/output` serves the delivered bytes when bound;
 *  - the live URL/token never enters the static bundle; closing the server
 *    invalidates the old URL and a new server mints a new token;
 *  - without a binding the render response keeps its original shape and no
 *    delivered byte is touched;
 *  - a flat generated image stays ONE image layer: move/scale are saved into
 *    the author source, the original Asset is untouched, double-click does not
 *    invent text, and Render updates the delivered product.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { test } from 'node:test';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';

import { findBrowser } from '../src/backends/browser/capture.js';
import { renderImage } from '../src/build/image.js';
import { deliverProject } from '../src/operations/delivery/delivery.js';
import { verifyDelivery } from '../src/operations/delivery/delivery-verification.js';
import { validateProject } from '../src/project/project.js';
import { serveWorkbench, type WorkbenchServer } from '../src/workbench/server.js';

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

const FLAT_HTML = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="flat.css"></head>
<body><div class="canvas" data-canvas-width="240" data-canvas-height="180">
<img class="art" data-layer-id="art" src="art.png" alt="">
</div></body></html>`;
const FLAT_CSS = `html,body{margin:0;width:240px;height:180px;overflow:hidden;background:#ffffff}
.canvas{position:relative;width:240px;height:180px;overflow:hidden}
.art{position:absolute;left:0;top:0;width:240px;height:180px;object-fit:cover}`;

const ART_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--enable-unsafe-swiftshader',
  '--hide-scrollbars',
  '--mute-audio',
  '--no-first-run',
  '--no-default-browser-check',
  '--force-color-profile=srgb',
  '--font-render-hinting=none',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];

const RIGHTS = { origin: 'author-owned generated plate', license: 'CC0-1.0', redistributable: true } as const;

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function baseProject() {
  return {
    schemaVersion: 1 as const,
    id: 'image_delivery_workbench',
    revision: 1,
    title: 'Image delivery workbench',
    direction: {
      intent: 'delivered stills edited in place',
      looks: [{ id: 'plain', description: 'plain' }],
      transitions: [],
    },
    assets: [],
    bindings: {},
    sources: [],
  };
}

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

async function tempDir(label: string): Promise<string> {
  return fs.mkdtemp(nodePath.join(os.tmpdir(), `viscraft-${label}-`));
}

async function writeTwoTargetProject(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(nodePath.join(root, 'project.json'), `${JSON.stringify(twoTargetProject(), null, 2)}\n`);
  await fs.writeFile(nodePath.join(root, 'diagram.html'), DIAGRAM_HTML);
  await fs.writeFile(nodePath.join(root, 'diagram.css'), DIAGRAM_CSS);
  await fs.writeFile(nodePath.join(root, 'cover.html'), COVER_HTML);
  await fs.writeFile(nodePath.join(root, 'cover.css'), COVER_CSS);
}

async function writeFlatProject(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(nodePath.join(root, 'project.json'), `${JSON.stringify(flatProject(), null, 2)}\n`);
  await fs.writeFile(nodePath.join(root, 'flat.html'), FLAT_HTML);
  await fs.writeFile(nodePath.join(root, 'flat.css'), FLAT_CSS);
  await fs.writeFile(nodePath.join(root, 'art.png'), ART_PNG);
}

async function digestOf(file: string): Promise<string> {
  return sha256(await fs.readFile(file));
}

interface Manifest {
  build: { id: string } | null;
  movie: { sha256: string } | null;
  images: Array<{ target: string; build: string; artifact: string; path: string; sha256: string; bytes: number }>;
}

async function manifestOf(bundle: string): Promise<Manifest> {
  return JSON.parse(await fs.readFile(nodePath.join(bundle, 'delivery-manifest.json'), 'utf8')) as Manifest;
}

/** The project-relative path of an Artifact recorded by a Build. */
async function artifactPathOf(root: string, build: string, artifact: string): Promise<string> {
  const record = JSON.parse(await fs.readFile(nodePath.join(root, '.viscraft', 'builds', `${build}.json`), 'utf8')) as {
    medium: string;
    artifacts: Array<{ id: string; path: string }>;
  };
  assert.equal(record.medium, 'picture', `Build ${build} must record medium picture`);
  const found = record.artifacts.find(candidate => candidate.id === artifact);
  assert.ok(found, `Build ${build} records Artifact ${artifact}`);
  return found.path;
}

async function deliveredStill(root: string, entry: string, target: string) {
  const manifest = await manifestOf(nodePath.join(root, 'output', entry));
  const image = manifest.images.find(candidate => candidate.target === target);
  assert.ok(image, `delivery ${entry} carries ${target}`);
  const path = nodePath.join(root, 'output', entry, ...image.path.split('/'));
  return { image, path, sha256: await digestOf(path), bytes: (await fs.stat(path)).size };
}

/** A mixed delivery holding TWO stills, so cross-target writes are observable. */
async function twoTargetDelivery(parent: string): Promise<{ root: string; bundle: string }> {
  const root = nodePath.join(parent, 'project');
  await writeTwoTargetProject(root);
  await renderImage(root, { target: 'diagram' });
  await renderImage(root, { target: 'cover' });
  const delivery = await deliverProject(root, undefined, {
    outputs: { images: ['diagram', 'cover'] },
  });
  assert.equal(delivery.path, nodePath.join(root, 'output', 'handoff'));
  return { root, bundle: delivery.path };
}

function call(live: WorkbenchServer, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${live.port}${path}`, {
    ...init,
    headers: { 'x-viscraft-token': live.token, ...(init.headers ?? {}) },
  });
}

async function putDocument(live: WorkbenchServer, html: string): Promise<Response> {
  const opened = (await (await call(live, '/api/document')).json()) as {
    document: { revision: number; contentHash: string };
  };
  return call(live, '/api/document', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      document: 'flow',
      baseRevision: opened.document.revision,
      baseContentHash: opened.document.contentHash,
      html,
    }),
  });
}

function renderRequest(live: WorkbenchServer, target: string): Promise<Response> {
  return call(live, '/api/render', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${live.port}` },
    body: JSON.stringify({ target }),
  });
}

test('a receiver edits from the generated unbound entry, then publishes through its own delivery', async () => {
  const parent = await tempDir('image-wb-receiver');
  try {
    const { root, bundle } = await twoTargetDelivery(parent);
    const sourceBefore = await digestOf(nodePath.join(root, 'diagram.html'));
    const deliveredBefore = await digestOf(nodePath.join(bundle, 'image', 'diagram.png'));
    const receiver = nodePath.join(parent, 'receiver');
    await fs.cp(nodePath.join(bundle, 'project'), receiver, { recursive: true });
    const facts = await fs.readFile(nodePath.join(receiver, '.viscraft', 'pages', 'VISCRAFT.md'), 'utf8');
    // The receiver page lives only at the current runtime-pages projection; a
    // package-root generated copy is not part of the contract.
    assert.equal(
      await fs.stat(nodePath.join(receiver, 'VISCRAFT.md')).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.equal(
      await fs.stat(nodePath.join(receiver, 'ATTRIBUTION.md')).then(
        () => true,
        () => false,
      ),
      false,
    );
    // Read the actual, target-specific receiver command generated by export.
    const commands = [...facts.matchAll(/^viscraft workbench \. --document (\w+) --target (\w+)$/gm)];
    const entry = commands.find(command => command[2] === 'diagram');
    assert.ok(entry, 'the receiver page supplies an executable entry for this target');
    const options = { document: entry[1], target: entry[2] };
    assert.equal(
      await fs.stat(nodePath.join(receiver, 'output')).then(
        () => true,
        () => false,
      ),
      false,
    );
    const unbound = await serveWorkbench(receiver, options);
    try {
      const saved = await putDocument(unbound, DIAGRAM_HTML.replace('A → B → C', 'RECEIVER EDIT'));
      assert.equal(saved.status, 200);
      const rendered = await renderRequest(unbound, options.target);
      assert.equal(rendered.status, 200, await rendered.text());
    } finally {
      await unbound.close();
    }
    // No sender-side delivery record is fabricated or imported.
    const local = await deliverProject(receiver, undefined, {
      outputs: { images: [options.target] },
    });
    const firstLocal = await digestOf(nodePath.join(local.path, 'image', 'diagram.png'));
    assert.notEqual(firstLocal, deliveredBefore);
    const bound = await serveWorkbench(receiver, { ...options, delivery: 'handoff' });
    try {
      assert.equal((await putDocument(bound, DIAGRAM_HTML.replace('A → B → C', 'LOCAL REVISION'))).status, 200);
      const rendered = await renderRequest(bound, options.target);
      assert.equal(rendered.status, 200, await rendered.text());
    } finally {
      await bound.close();
    }
    assert.notEqual(await digestOf(nodePath.join(local.path, 'image', 'diagram.png')), firstLocal);
    assert.equal((await verifyDelivery(local.path)).ok, true);
    assert.equal(await digestOf(nodePath.join(root, 'diagram.html')), sourceBefore);
    assert.equal(await digestOf(nodePath.join(bundle, 'image', 'diagram.png')), deliveredBefore);
    assert.equal((await verifyDelivery(bundle)).ok, true);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('binding refuses missing, foreign, tampered, wrong-target and path-shaped deliveries', async () => {
  const parent = await tempDir('image-wb-bind');
  try {
    const { root, bundle } = await twoTargetDelivery(parent);
    await assert.rejects(
      serveWorkbench(root, { document: 'flow', target: 'diagram', delivery: 'missing' }),
      /record|delivery|exist|output/i,
    );
    // A directory the Runtime never recorded (even with a manifest) is foreign.
    await fs.mkdir(nodePath.join(root, 'output', 'foreign'), { recursive: true });
    await assert.rejects(
      serveWorkbench(root, { document: 'flow', target: 'diagram', delivery: 'foreign' }),
      /record|delivery|exist|manifest/i,
    );
    // A recorded bundle that does not carry this target is refused: a binding
    // never silently adds or substitutes another product.
    await deliverProject(root, undefined, { outputs: { images: ['diagram'] } });
    await assert.rejects(
      serveWorkbench(root, { document: 'cover_src', target: 'cover', delivery: 'handoff' }),
      /document|target|not delivered|carry/i,
    );
    // A filesystem path is not an entry name.
    await assert.rejects(
      serveWorkbench(root, { document: 'flow', target: 'diagram', delivery: bundle }),
      /entry|name|record|delivery|output/i,
    );
    // A hand-edited delivered product keeps the author page usable, but the
    // delivery is visibly BLOCKED: download and publication refuse, and the
    // tampered bytes are never overwritten or silently replaced by the Artifact.
    const product = nodePath.join(bundle, 'image', 'diagram.png');
    const bytes = await fs.readFile(product);
    const tampered = Buffer.concat([bytes, Buffer.from([0])]);
    // Replace the member without writing through a read-only frozen hard link.
    await fs.unlink(product);
    await fs.writeFile(product, tampered, { flag: 'wx' });
    const blocked = await serveWorkbench(root, { document: 'flow', target: 'diagram', delivery: 'handoff' });
    try {
      // The page itself still opens for authoring.
      assert.equal((await fetch(`http://127.0.0.1:${blocked.port}/workbench`)).status, 200);
      const opened = (await (await call(blocked, '/api/document')).json()) as {
        delivery: { verified?: boolean; blocked?: string; path: string } | null;
        document: { revision: number; contentHash: string };
      };
      assert.equal(opened.delivery?.verified, false, 'the binding reports it is not verified');
      assert.equal(typeof opened.delivery?.blocked, 'string');
      assert.ok(opened.delivery!.blocked!.length > 0, 'a diagnosable block reason is shown');

      // A real edit still saves to the author source.
      const edited = DIAGRAM_HTML.replace('A → B → C', 'A → B → TAMPER');
      const saved = await putDocument(blocked, edited);
      assert.equal(saved.status, 200);
      assert.match(await fs.readFile(nodePath.join(root, 'diagram.html'), 'utf8'), /A → B → TAMPER/);

      // Download never falls back to the internal Artifact.
      const download = await call(blocked, '/api/output?target=diagram');
      assert.ok(download.status >= 400, `blocked download refused (status ${download.status})`);
      const downloadBody = (await download.json()) as { error?: string };
      assert.ok(downloadBody.error, 'the refusal is explained');

      // Render still produces a usable Artifact, but publication is refused.
      const rendered = await renderRequest(blocked, 'diagram');
      assert.equal(rendered.status, 500);
      const failure = (await rendered.json()) as {
        error: string;
        message: string;
        result: { path: string } | null;
      };
      assert.equal(failure.error, 'publish-failed');
      assert.ok(failure.result?.path, 'the successful render is still usable');
      assert.equal(
        sha256(await fs.readFile(product)),
        sha256(tampered),
        'the tampered delivered file is untouched, never repaired or overwritten',
      );
    } finally {
      await blocked.close();
    }

    // With the bytes restored the same binding opens verified and unblocked.
    await fs.writeFile(product, bytes);
    const live = await serveWorkbench(root, { document: 'flow', target: 'diagram', delivery: 'handoff' });
    try {
      const status = (await (await call(live, '/api/status')).json()) as {
        delivery: { verified?: boolean; blocked?: string } | null;
      };
      assert.equal(status.delivery?.verified, true);
      assert.equal(status.delivery?.blocked ?? '', '');
    } finally {
      await live.close();
    }
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('a bound render updates the same delivered file; without a binding nothing is published', async () => {
  const parent = await tempDir('image-wb-render');
  try {
    const { root, bundle } = await twoTargetDelivery(parent);
    const beforeDiagram = await deliveredStill(root, 'handoff', 'diagram');
    const beforeCover = await deliveredStill(root, 'handoff', 'cover');
    const beforeManifest = await fs.readFile(nodePath.join(bundle, 'delivery-manifest.json'));
    const oldArtifact = nodePath.join(
      root,
      ...(await artifactPathOf(root, beforeDiagram.image.build, beforeDiagram.image.artifact)).split('/'),
    );

    const live = await serveWorkbench(root, { document: 'flow', target: 'diagram', delivery: 'handoff' });
    try {
      assert.ok(live.delivery, 'the server reports the verified binding');
      assert.equal(live.delivery!.entry, 'handoff');
      assert.equal(live.delivery!.path, 'output/handoff/image/diagram.png');
      assert.equal(live.delivery!.sha256, beforeDiagram.sha256);
      assert.equal(live.delivery!.stale, false);

      const opened = (await (await call(live, '/api/document')).json()) as {
        delivery: { path: string; sha256: string } | null;
        result: { path: string } | null;
      };
      assert.equal(opened.delivery?.path, 'output/handoff/image/diagram.png');
      assert.ok(opened.result?.path, 'the internal render result is still reported separately');

      const status = (await (await call(live, '/api/status')).json()) as {
        delivery: { entry: string; path: string; build: string } | null;
        result: { build: string } | null;
      };
      assert.equal(status.delivery?.entry, 'handoff');
      assert.equal(status.delivery?.path, 'output/handoff/image/diagram.png');
      assert.equal(status.delivery?.build, beforeDiagram.image.build);
      assert.equal(status.result?.build, beforeDiagram.image.build);

      // Saving an edit is NOT publishing: the delivered file keeps its bytes.
      const edited = DIAGRAM_HTML.replace('A → B → C', 'A → B → H');
      assert.equal((await putDocument(live, edited)).status, 200);
      assert.match(await fs.readFile(nodePath.join(root, 'diagram.html'), 'utf8'), /A → B → H/);
      assert.equal((await deliveredStill(root, 'handoff', 'diagram')).sha256, beforeDiagram.sha256);
      assert.equal(sha256(await fs.readFile(nodePath.join(bundle, 'delivery-manifest.json'))), sha256(beforeManifest));

      // Render publishes the exact Build it produced into the same product path.
      const rendered = await renderRequest(live, 'diagram');
      assert.equal(rendered.status, 200);
      const payload = (await rendered.json()) as {
        build: string;
        artifact: string;
        path: string;
        reused: boolean;
        stale: boolean;
        delivery: {
          entry: string;
          path: string;
          sha256: string;
          bytes: number;
          build: string;
          artifact: string;
          stale: boolean;
        } | null;
      };
      assert.equal(payload.reused, false);
      assert.equal(payload.stale, false);
      assert.equal(payload.delivery?.entry, 'handoff');
      assert.equal(payload.delivery?.path, 'output/handoff/image/diagram.png', 'the stable product path did not move');
      assert.equal(payload.delivery?.build, payload.build);
      assert.equal(payload.delivery?.artifact, payload.artifact);

      const after = await deliveredStill(root, 'handoff', 'diagram');
      assert.equal(after.path, beforeDiagram.path);
      assert.notEqual(after.sha256, beforeDiagram.sha256, 'the delivered pixels really changed');
      assert.equal(after.sha256, payload.delivery!.sha256);
      assert.equal(after.bytes, payload.delivery!.bytes);
      assert.equal(await digestOf(nodePath.join(root, ...payload.path.split('/'))), after.sha256);
      // The old Artifact remains readable; the new Build is recorded.
      assert.equal((await fs.stat(oldArtifact)).isFile(), true);
      assert.equal(await digestOf(oldArtifact), beforeDiagram.sha256);
      assert.equal((await fs.stat(nodePath.join(root, '.viscraft', 'builds', `${payload.build}.json`))).isFile(), true);

      // Exactly one target changed; the other still and the manifest's other
      // entries keep their bytes. The bundle still verifies.
      assert.equal((await deliveredStill(root, 'handoff', 'cover')).sha256, beforeCover.sha256);
      const afterManifest = await manifestOf(bundle);
      const coverEntry = afterManifest.images.find(image => image.target === 'cover')!;
      assert.equal(coverEntry.sha256, beforeCover.image.sha256);
      assert.equal(afterManifest.images.find(image => image.target === 'diagram')!.build, payload.build);
      assert.equal((await verifyDelivery(bundle)).ok, true);

      // The bound output endpoint serves the delivered bytes, not a second copy.
      const output = await call(live, '/api/output?target=diagram');
      assert.equal(output.status, 200);
      const served = Buffer.from(await output.arrayBuffer());
      assert.equal(sha256(served), after.sha256);
      assert.match(output.headers.get('content-disposition') ?? '', /diagram\.png/);

      // An external author save makes the delivered product honestly stale.
      await fs.writeFile(nodePath.join(root, 'diagram.html'), edited.replace('A → B → H', 'A → B → I'));
      const stale = (await (await call(live, '/api/status')).json()) as {
        delivery: { stale: boolean } | null;
        result: { stale: boolean } | null;
      };
      assert.equal(stale.delivery?.stale, true, 'delivery.stale follows the saved source');
      assert.equal(stale.result?.stale, true);

      // A publication failure is reported as itself: the render succeeded and
      // stays usable, while the delivered file is left exactly as it was.
      const product = nodePath.join(bundle, 'image', 'diagram.png');
      const originalProduct = await fs.readFile(product);
      const untouched = Buffer.concat([originalProduct, Buffer.from('external')]);
      // Replace this member; deduplicated frozen siblings must stay untouched.
      await fs.unlink(product);
      await fs.writeFile(product, untouched, { flag: 'wx' });
      const failed = await renderRequest(live, 'diagram');
      assert.equal(failed.status, 500);
      const failure = (await failed.json()) as {
        error: string;
        message: string;
        result: { path: string; build: string } | null;
        delivery: unknown;
      };
      assert.equal(failure.error, 'publish-failed');
      assert.match(failure.message, /modified|hash|verify|tamper|match|delivery/i);
      assert.ok(failure.result?.path, 'the successful render is still reported');
      assert.equal(sha256(await fs.readFile(product)), sha256(untouched), 'the delivered file is not overwritten');
      await fs.writeFile(product, originalProduct);
    } finally {
      await live.close();
    }

    // --- The same Project WITHOUT a binding: no delivery bytes are touched. ---
    const beforeUnbound = await deliveredStill(root, 'handoff', 'diagram');
    const unbound = await serveWorkbench(root, { document: 'flow', target: 'diagram' });
    try {
      assert.equal(unbound.delivery, undefined, 'no binding is claimed');
      const status = (await (await call(unbound, '/api/status')).json()) as { delivery: unknown };
      assert.equal(status.delivery, null);
      const rendered = await renderRequest(unbound, 'diagram');
      assert.equal(rendered.status, 200);
      const payload = (await rendered.json()) as { reused: boolean; delivery?: unknown; published?: unknown };
      assert.equal(typeof payload.reused, 'boolean');
      assert.equal(
        Object.prototype.hasOwnProperty.call(payload, 'delivery'),
        false,
        'unbound response shape is unchanged',
      );
      assert.equal(Object.prototype.hasOwnProperty.call(payload, 'published'), false);
      assert.equal((await deliveredStill(root, 'handoff', 'diagram')).sha256, beforeUnbound.sha256);
    } finally {
      await unbound.close();
    }
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('the live URL is session-only and never written into the static bundle', async () => {
  const parent = await tempDir('image-wb-token');
  try {
    const { root, bundle } = await twoTargetDelivery(parent);
    const live = await serveWorkbench(root, { document: 'flow', target: 'diagram', delivery: 'handoff' });
    const firstUrl = live.url;
    const firstToken = live.token;
    const page = await fetch(firstUrl);
    assert.equal(page.status, 200);
    assert.equal((await call(live, '/api/document')).status, 200);

    // Neither the static page/manifest nor the runtime-pages fact page carries
    // the live session URL or token.
    for (const relative of [
      ['index.html'],
      ['delivery-manifest.json'],
      ['project', '.viscraft', 'pages', 'VISCRAFT.md'],
      ['project', 'project.json'],
    ]) {
      const file = nodePath.join(bundle, ...relative);
      if (!(await fs.stat(file).catch(() => null))) continue;
      const text = await fs.readFile(file, 'utf8');
      assert.doesNotMatch(text, new RegExp(firstToken), `${relative.join('/')} must not persist the token`);
      assert.doesNotMatch(text, /127\.0\.0\.1:|localhost:/, `${relative.join('/')} must not persist a session URL`);
    }

    await live.close();
    await assert.rejects(
      fetch(firstUrl, { signal: AbortSignal.timeout(2000) }),
      /ECONNREFUSED|fetch failed|conn/i,
      'the old URL dies with the process',
    );

    const reopened = await serveWorkbench(root, { document: 'flow', target: 'diagram', delivery: 'handoff' });
    try {
      assert.notEqual(reopened.token, firstToken, 'a new process mints a new session token');
      assert.equal((await fetch(reopened.url)).status, 200);
      assert.equal((await call(reopened, '/api/document')).status, 200);
    } finally {
      await reopened.close();
    }
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

const browserAvailable = await findBrowser().then(
  () => true,
  () => false,
);
const browserSkip = browserAvailable ? false : 'needs a Chrome/Chromium browser';

async function launchBrowser(): Promise<Browser> {
  return puppeteer.launch({ executablePath: await findBrowser(), headless: true, pipe: true, args: LAUNCH_ARGS });
}

async function openWorkbench(live: WorkbenchServer, browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  await page.goto(live.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => document.getElementById('wb-app')?.getAttribute('data-phase') === 'mounted', {
    timeout: 30000,
  });
  return page;
}

async function waitForRevision(root: string, minimum: number, timeout = 20000): Promise<number> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const project = JSON.parse(await fs.readFile(nodePath.join(root, 'project.json'), 'utf8')) as {
      imageDocuments: Array<{ id: string; revision: number }>;
    };
    const revision =
      project.imageDocuments.find(document => document.id === 'flow' || document.id === 'flat')?.revision ?? 0;
    if (revision >= minimum) return revision;
    if (Date.now() > deadline) throw new Error(`document revision did not reach ${minimum} (last ${revision})`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

/** A decoded pixel from the produced PNG, proving real image content. */
async function centerPixel(browser: Browser, png: Buffer): Promise<[number, number, number, number]> {
  const page = await browser.newPage();
  try {
    return await page.evaluate(
      async ({ base64 }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        const data = context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
        return [data[0]!, data[1]!, data[2]!, data[3]!] as [number, number, number, number];
      },
      { base64: png.toString('base64') },
    );
  } finally {
    await page.close();
  }
}

test(
  'the real page names the delivered product, autosaves, and a Render updates that same file',
  { skip: browserSkip },
  async () => {
    const parent = await tempDir('image-wb-page');
    const browser = await launchBrowser();
    try {
      const { root, bundle } = await twoTargetDelivery(parent);
      const before = await deliveredStill(root, 'handoff', 'diagram');
      const live = await serveWorkbench(root, { document: 'flow', target: 'diagram', delivery: 'handoff' });
      try {
        const page = await openWorkbench(live, browser);
        const footer = await page.evaluate(() => document.getElementById('wb-out-detail')?.textContent ?? '');
        assert.match(
          footer,
          /delivered → output\/handoff\/image\/diagram\.png/,
          'the page names the product the user has',
        );
        assert.match(
          await page.$eval('#wb-target', el => el.textContent ?? ''),
          /400×240/,
          'the output dimensions remain visible once in the footer metadata',
        );

        // A layer move is autosaved into the author source but NOT published.
        await page.evaluate(() => {
          const iframe = document.getElementById('wb-frame') as HTMLIFrameElement;
          const win = iframe.contentWindow as Window & {
            __layerEditor: { layers(): Array<{ el: HTMLElement; id: string }> };
          };
          const layer = win.__layerEditor.layers().find(item => item.id === 'flow');
          if (!layer) throw new Error('flow layer not found');
          layer.el.style.left = '70px';
        });
        await page.waitForFunction(
          () => document.getElementById('wb-save-state')?.getAttribute('data-state') === 'saved',
          {
            timeout: 20000,
          },
        );
        await waitForRevision(root, 2);
        assert.match(
          await fs.readFile(nodePath.join(root, 'diagram.html'), 'utf8'),
          /"id":"flow","dx":54(?:[.,]0*)?[,}]/,
        );
        assert.equal(
          (await deliveredStill(root, 'handoff', 'diagram')).sha256,
          before.sha256,
          'a save does not publish',
        );

        // The page's own Render button publishes the new Build.
        await page.click('#wb-render');
        await page.waitForFunction(
          () => document.getElementById('wb-out-state')?.getAttribute('data-state') === 'success',
          { timeout: 120000 },
        );
        const after = await deliveredStill(root, 'handoff', 'diagram');
        assert.notEqual(after.sha256, before.sha256, 'Render updated the delivered file');
        const afterFooter = await page.evaluate(() => document.getElementById('wb-out-detail')?.textContent ?? '');
        assert.match(afterFooter, /delivered → output\/handoff\/image\/diagram\.png/);
        assert.equal((await verifyDelivery(bundle)).ok, true);

        // The old Artifact is still present next to the new one.
        const builds = await fs.readdir(nodePath.join(root, '.viscraft', 'artifacts'));
        assert.ok(builds.length >= 2);
      } finally {
        await live.close();
      }
    } finally {
      await browser.close();
      await fs.rm(parent, { recursive: true, force: true });
    }
  },
);

test(
  'a flat generated image stays one image layer through move, scale, save and publish',
  { skip: browserSkip },
  async () => {
    const parent = await tempDir('image-wb-flat');
    const browser = await launchBrowser();
    try {
      const root = nodePath.join(parent, 'project');
      await writeFlatProject(root);
      await renderImage(root, { target: 'cover' });
      const delivery = await deliverProject(root, undefined, { outputs: { images: ['cover'] } });
      assert.equal(delivery.path, nodePath.join(root, 'output', 'handoff'));
      const originalAsset = sha256(ART_PNG);
      const before = await deliveredStill(root, 'handoff', 'cover');

      const live = await serveWorkbench(root, { document: 'flat', target: 'cover', delivery: 'handoff' });
      try {
        const page = await openWorkbench(live, browser);
        const layers = await page.evaluate(() => {
          const iframe = document.getElementById('wb-frame') as HTMLIFrameElement;
          const win = iframe.contentWindow as Window & {
            __layerEditor: { layers(): Array<{ el: HTMLElement; id: string }> };
          };
          return win.__layerEditor.layers().map(layer => ({
            id: layer.id,
            tag: layer.el.tagName,
            text: (layer.el.textContent ?? '').trim(),
          }));
        });
        assert.deepEqual(layers, [{ id: 'art', tag: 'IMG', text: '' }], 'one image layer, no invented text');

        // The flat source is really DECODED by the Browser, not an unresolved
        // broken image that a white capture could hide.
        await page.waitForFunction(
          () => {
            const iframe = document.getElementById('wb-frame') as HTMLIFrameElement;
            const image = iframe.contentDocument?.querySelector('[data-layer-id="art"]') as HTMLImageElement | null;
            return image !== null && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
          },
          { timeout: 20000 },
        );
        const decoded = await page.evaluate(() => {
          const iframe = document.getElementById('wb-frame') as HTMLIFrameElement;
          const image = iframe.contentDocument?.querySelector('[data-layer-id="art"]') as HTMLImageElement;
          return { complete: image.complete, width: image.naturalWidth, height: image.naturalHeight };
        });
        assert.deepEqual(decoded, { complete: true, width: 1, height: 1 }, 'the author image decoded for real');

        // The FIRST delivered product already contains the source pixels: a
        // white/blank capture would not be green here.
        const beforePixel = await centerPixel(browser, await fs.readFile(before.path));
        assert.equal(beforePixel[3], 255, 'the opaque product has no transparency');
        assert.ok(
          beforePixel[1] > 200 && beforePixel[1] > beforePixel[0] + 40 && beforePixel[1] > beforePixel[2] + 40,
          `the delivered still contains the flat image, not a blank canvas (pixel ${beforePixel.join(',')})`,
        );

        // Move + scale through the editor's own DOM, then let autosave land.
        await page.evaluate(() => {
          const iframe = document.getElementById('wb-frame') as HTMLIFrameElement;
          const win = iframe.contentWindow as Window & {
            __layerEditor: { layers(): Array<{ el: HTMLElement; id: string }> };
          };
          const layer = win.__layerEditor.layers().find(item => item.id === 'art')!;
          layer.el.style.left = '30px';
          layer.el.style.top = '20px';
          layer.el.style.width = '180px';
          layer.el.style.height = '135px';
        });
        await page.waitForFunction(
          () => document.getElementById('wb-save-state')?.getAttribute('data-state') === 'saved',
          {
            timeout: 20000,
          },
        );
        await waitForRevision(root, 2);
        const saved = await fs.readFile(nodePath.join(root, 'flat.html'), 'utf8');
        assert.match(saved, /data-layer-id="art"/);
        assert.match(saved, /"id":"art","dx":30(?:[.,]0*)?[,}]/);
        assert.match(saved, /"id":"art".*?"width":180(?:[.,]0*)?[,}]/);
        assert.equal(saved.match(/data-layer-id=/g)?.length, 1, 'still exactly one layer');
        assert.equal(await digestOf(nodePath.join(root, 'art.png')), originalAsset, 'the original Asset is untouched');

        // Double-click is not a text session for a flat image.
        const frame = page.frames().find(candidate => candidate !== page.mainFrame());
        assert.ok(frame);
        const box = await frame.evaluate(() => {
          const layer = document.querySelector('[data-layer-id="art"]') as HTMLElement;
          const rect = layer.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        });
        const offset = await page.evaluate(() => {
          const rect = document.getElementById('wb-frame')!.getBoundingClientRect();
          return { x: rect.x, y: rect.y };
        });
        await page.mouse.click(offset.x + box.x, offset.y + box.y, { clickCount: 2 });
        await new Promise(resolve => setTimeout(resolve, 400));
        assert.equal(
          await page.evaluate(() => {
            const iframe = document.getElementById('wb-frame') as HTMLIFrameElement;
            const win = iframe.contentWindow as Window & { __layerEditor?: { isEditing(): boolean } };
            return win.__layerEditor?.isEditing() === true;
          }),
          false,
          'a flat image gains no fake internal text editing',
        );

        await page.click('#wb-render');
        await page.waitForFunction(
          () => document.getElementById('wb-out-state')?.getAttribute('data-state') === 'success',
          { timeout: 120000 },
        );
        const after = await deliveredStill(root, 'handoff', 'cover');
        assert.notEqual(after.sha256, before.sha256, 'the delivered product reflects the moved/scaled layer');
        const afterPixel = await centerPixel(browser, await fs.readFile(after.path));
        assert.ok(
          afterPixel[1] > 200 && afterPixel[1] > afterPixel[0] + 40 && afterPixel[1] > afterPixel[2] + 40,
          `the updated still still contains the real flat image (pixel ${afterPixel.join(',')})`,
        );
        assert.equal(await digestOf(nodePath.join(root, 'art.png')), originalAsset);
        assert.equal((await verifyDelivery(delivery.path)).ok, true);
      } finally {
        await live.close();
      }
    } finally {
      await browser.close();
      await fs.rm(parent, { recursive: true, force: true });
    }
  },
);
