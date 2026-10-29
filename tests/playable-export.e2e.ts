import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import puppeteer from 'puppeteer-core';
import { exportPlayable } from '../src/operations/delivery/playable-export.js';
import { servePlayable } from '../src/backends/playable/playable-server.js';
import { findBrowser } from '../src/backends/browser/capture.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { loadProject, saveProject } from '../src/project/project.js';

test('standalone World playable package runs real controls without film/recording or unrelated private assets', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-playable-delivery-'));
  const root = join(parent, 'authoring'),
    destination = join(parent, 'playable');
  let server: Awaited<ReturnType<typeof servePlayable>> | undefined;
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await runCommand(process.execPath, [resolve('tests/fixtures/authoring/create-world-playable.mjs'), root]);
    await writeFile(join(root, 'private.txt'), 'private unrelated reference');
    const project = await loadProject(root);
    project.assets.push({
      id: 'private',
      revision: 1,
      path: 'private.txt',
      sha256: await hashFile(join(root, 'private.txt')),
      type: 'code',
      rights: { origin: 'private test input', license: 'no redistribution', redistributable: false },
      simulated: false,
    });
    await saveProject(root, project, project.revision);
    const before = await hashFile(join(root, 'project.json'));
    const result = await exportPlayable(root, 'interactive', destination);
    assert.equal(result.simulated, false);
    assert.equal(await hashFile(join(root, 'project.json')), before);
    const files = JSON.parse(await readFile(join(destination, 'playable-manifest.json'), 'utf8')).files as Array<{
      path: string;
    }>;
    assert.ok(
      !files.some(
        file =>
          file.path === 'private.txt' || file.path.startsWith('recordings/') || file.path.startsWith('.viscraft/'),
      ),
    );
    server = await servePlayable(destination);
    browser = await puppeteer.launch({
      executablePath: await findBrowser(),
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    const errors: string[] = [],
      external: string[] = [];
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
      { timeout: 10000 },
    );
    const initial = await page.evaluate(
      () => (window as unknown as { viscraft: { state(): { offset: number[] } } }).viscraft.state().offset[0],
    );
    await page.keyboard.down('ArrowRight');
    await page.waitForFunction(
      before =>
        (window as unknown as { viscraft: { state(): { offset: number[] } } }).viscraft.state().offset[0] >
        before + 0.1,
      { timeout: 5000 },
      initial,
    );
    await page.keyboard.up('ArrowRight');
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    assert.equal((await fetch(new URL('private.txt', server.url))).status, 404);
    assert.equal((await fetch(new URL('.viscraft/result.json', server.url))).status, 404);
    const integrityPath = files.find(file => file.path.endsWith('.svg'))!.path;
    await writeFile(join(destination, integrityPath), 'damaged');
    assert.equal((await fetch(new URL(integrityPath, server.url))).status, 409);
  } finally {
    await browser?.close();
    await server?.close();
    await rm(parent, { recursive: true, force: true });
  }
});
