import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { resolve } from 'node:path';

import puppeteer from 'puppeteer-core';
import { buildProject } from '../src/build/build.js';
import { deliverProject } from '../src/operations/delivery/delivery.js';
import { servePlayable } from '../src/backends/playable/playable-server.js';
import { findBrowser } from '../src/backends/browser/capture.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { PortableManifestSchema } from '../src/operations/delivery/portable-contract.js';
import { saveProject, loadProject } from '../src/project/project.js';

test('deliverProject bundles a real code build and an optional standalone playable that runs', async () => {
  const parent = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-delivery-e2e-'));
  const root = nodePath.join(parent, 'authoring');
  const destination = nodePath.join(parent, 'bundle');
  let server: Awaited<ReturnType<typeof servePlayable>> | undefined;
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await runCommand(process.execPath, [resolve('tests/fixtures/authoring/create-playable.mjs'), root]);
    const authored = await loadProject(root);
    await fs.mkdir(nodePath.join(root, 'assets'));
    await fs.writeFile(nodePath.join(root, 'assets', 'approved.bin'), Buffer.alloc(8192, 41));
    authored.assets.push({
      id: 'approved-material',
      revision: 1,
      type: 'code',
      path: 'assets/approved.bin',
      sha256: await hashFile(nodePath.join(root, 'assets/approved.bin')),
      rights: { origin: 'Original fixture material', license: 'CC0-1.0', redistributable: true },
      simulated: false,
    });
    await saveProject(root, authored, authored.revision);
    const record = await buildProject(root);
    assert.equal(record.status, 'succeeded');
    assert.ok(record.result);

    const delivery = await deliverProject(root, destination, {
      review: true,
      stems: true,
      playableSource: 'src_playable',
    });
    assert.equal(delivery.build, record.id);
    assert.equal(delivery.playable?.id.startsWith('playable-'), true, 'a standalone playable package is bundled');
    assert.equal(await hashFile(nodePath.join(destination, 'movie', 'final.mp4')), delivery.movie!.sha256);

    // Bundle shape, including the optional playable package.
    for (const relative of [
      'index.html',
      'delivery-manifest.json',
      'movie/final.mp4',
      'project/project.json',
      'playable/playable-manifest.json',
      'playable/project.json',
      delivery.review!.contactSheet,
      delivery.review!.report,
    ]) {
      assert.equal(
        await fs.stat(nodePath.join(destination, relative)).then(
          () => true,
          () => false,
        ),
        true,
        `bundle contains ${relative}`,
      );
    }

    // The manifest allowlists exactly the bundled files and verifies their hashes.
    const manifest = JSON.parse(await fs.readFile(nodePath.join(destination, 'delivery-manifest.json'), 'utf8')) as {
      files: Array<{ path: string; sha256: string }>;
      playable: { id: string } | null;
    };
    assert.equal(manifest.playable?.id, delivery.playable?.id);
    for (const file of manifest.files)
      assert.equal(await hashFile(nodePath.join(destination, file.path)), file.sha256, `hash matches for ${file.path}`);
    assert.ok(manifest.files.some(file => file.path === 'playable/playable-manifest.json'));

    // The editable project export reopens.
    const reopened = await loadProject(nodePath.join(destination, 'project'));
    assert.equal(reopened.sources[0].id, 'src_playable');
    const portable = PortableManifestSchema.parse(
      JSON.parse(await fs.readFile(nodePath.join(destination, 'project/.viscraft/portable-manifest.json'), 'utf8')),
    );
    assert.equal(portable.version, 1);
    if (portable.version !== 1) throw new Error('Expected the current portable v1 manifest');
    const frozen = portable.snapshotAssets.find(asset => asset.provenance.assetId === 'approved-material');
    assert.ok(frozen, 'eligible frozen material must have an explicit logical mapping');
    assert.ok(portable.files.some(file => file.path === frozen.content && file.sha256 === frozen.sha256));
    await assert.rejects(fs.stat(nodePath.join(destination, 'project', frozen.path)), /ENOENT/);
    const secondExport = nodePath.join(parent, 'second-export');
    await exportProject(nodePath.join(destination, 'project'), secondExport);
    assert.ok((await buildProject(secondExport)).operations.every(operation => operation.reused));

    // The bundled live package is served by the runtime and really runs.
    server = await servePlayable(nodePath.join(destination, 'playable'));
    browser = await puppeteer.launch({
      executablePath: await findBrowser(),
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    const errors: string[] = [];
    const external: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    const origin = new URL(server.url).origin;
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (
        request.url().startsWith(origin + '/') ||
        request.url().startsWith('data:') ||
        request.url().startsWith('about:')
      )
        void request.continue();
      else {
        external.push(request.url());
        void request.abort();
      }
    });
    await page.goto(server.url);
    await page.waitForFunction(
      () => Boolean((window as unknown as { viscraft?: { state(): unknown } }).viscraft?.state()),
      { timeout: 15000 },
    );
    const initial = await page.evaluate(
      () => (window as unknown as { viscraft: { state(): { x: number } } }).viscraft.state().x,
    );
    await page.keyboard.down('ArrowRight');
    await page.waitForFunction(
      before => (window as unknown as { viscraft: { state(): { x: number } } }).viscraft.state().x !== before,
      { timeout: 5000 },
      initial,
    );
    await page.keyboard.up('ArrowRight');
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
  } finally {
    await browser?.close();
    await server?.close();
    await fs.rm(parent, { recursive: true, force: true });
  }
});
