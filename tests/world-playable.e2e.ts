import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { buildProject } from '../src/build/build.js';
import { loadProject, saveProject } from '../src/project/project.js';
import { recordPlayable } from '../src/backends/playable/playable.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { runCommand } from '../src/shared/process.js';
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { findBrowser } from '../src/backends/browser/capture.js';
import type { BrowserPictureSource } from '../src/core/schema.js';

const ROOT = resolve('tests/fixtures/authoring/create-world-playable.mjs');

test('shared World real controls record/replay, reject changed spatial facts, and feed a portable trailer', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-world-play-'));
  const root = join(parent, 'project');
  const delivery = join(parent, 'delivery');
  try {
    await runCommand(process.execPath, [ROOT, root]);
    // Exercise the actual live branch: it reads the authoritative Project over
    // loopback and accepts real keyboard input without offline injected state.
    const server = http.createServer((request, response) => {
      const relative = request.url?.slice(1) || 'world-playable.html';
      if (
        ![
          'world-playable.html',
          'world.html',
          'world-state.js',
          'project.json',
          'assets/courier.svg',
          'assets/gate.svg',
          'assets/drone.svg',
        ].includes(relative)
      ) {
        response.writeHead(404);
        response.end();
        return;
      }
      void readFile(join(root, relative))
        .then(bytes => {
          response.setHeader(
            'Content-Type',
            relative.endsWith('.js')
              ? 'text/javascript'
              : relative.endsWith('.json')
                ? 'application/json'
                : relative.endsWith('.svg')
                  ? 'image/svg+xml'
                  : 'text/html',
          );
          response.end(bytes);
        })
        .catch(() => {
          response.writeHead(404);
          response.end();
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await puppeteer.launch({
      executablePath: await findBrowser(),
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browser.newPage();
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing live test port');
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(String(error)));
      await page.goto(`http://127.0.0.1:${address.port}/world-playable.html`);
      await page
        .waitForFunction(() => Boolean((window as unknown as { viscraft?: { state(): unknown } }).viscraft?.state()), {
          timeout: 5000,
        })
        .catch(error => {
          throw new Error(`Live World did not produce state: ${errors.join('; ')}; ${String(error)}`);
        });
      const initial = await page.evaluate(
        () => (window as unknown as { viscraft: { state(): { offset: number[] } } }).viscraft.state().offset[0],
      );
      await page.keyboard.down('ArrowRight');
      await page.waitForFunction(
        (before: number) =>
          (window as unknown as { viscraft: { state(): { offset: number[] } } }).viscraft.state().offset[0] >
          before + 0.1,
        {},
        initial,
      );
      await page.keyboard.up('ArrowRight');
      assert.deepEqual(errors, [], 'live World interaction must not hide page errors');
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    }
    const project = await loadProject(root);
    const source = project.sources.find(source => source.id === 'interactive')!;
    if (source.kind !== 'browser' || source.output !== 'picture') throw new Error('Expected interactive code Source');
    source.frames = 8;
    project.composition!.output.width = 96;
    project.composition!.output.height = 64;
    await saveProject(root, project, project.revision);
    const schedule = [
      { frame: 0, type: 'down' as const, key: 'ArrowRight' as const },
      { frame: 3, type: 'up' as const, key: 'ArrowRight' as const },
    ];
    const recorded = await recordPlayable(root, source.id, schedule);
    const control = await recordPlayable(root, source.id, []);
    assert.deepEqual(recorded.events, schedule);
    assert.equal(recorded.source.world!.id, project.worlds![0].id);
    assert.equal(recorded.source.world!.cameras.length, 1);
    assert.notDeepEqual(
      recorded.states[2].state,
      control.states[2].state,
      'real keyboard input must change observed shared-World play state',
    );
    assert.notEqual(recorded.media.sha256, control.media.sha256, 'real steering must change captured pixels');
    const selected = await loadProject(root);
    const index = selected.sources.findIndex(source => source.id === 'interactive');
    const playable: BrowserPictureSource = {
      ...source,
      kind: 'browser',
      output: 'picture',
      recording: `recordings/${recorded.id}/session.json`,
    };
    selected.sources[index] = playable;
    selected.composition!.placements = [
      {
        id: 'recorded',
        shot: selected.composition!.shots[0].id,
        source: playable.id,
        inFrame: 0,
        outFrame: 8,
        startFrame: 0,
        audio: 'mute',
      },
    ];
    selected.composition!.subtitles = [];
    await saveProject(root, selected, selected.revision);
    const replayed = await buildProject(root);
    assert.equal(replayed.status, 'succeeded');
    assert.equal(replayed.takes.length, 1);
    assert.equal(replayed.takes[0].simulated, false);
    const before = await readFile(join(root, '.viscraft/result.json'), 'utf8');
    const original = await loadProject(root);
    const changed = structuredClone(original);
    changed.worlds![0].revision++;
    changed.worlds![0].entities[0].transform.scale[0] = 2;
    await saveProject(root, changed, original.revision);
    await assert.rejects(buildProject(root), /World changed since recording/);
    assert.equal(await readFile(join(root, '.viscraft/result.json'), 'utf8'), before);
    const current = await loadProject(root);
    await saveProject(root, original, current.revision);
    const trailer = await loadProject(root);
    trailer.composition!.placements = [
      {
        id: 'trailer',
        shot: trailer.composition!.shots[0].id,
        take: replayed.takes[0].id,
        inFrame: 2,
        outFrame: 6,
        startFrame: 0,
        audio: 'mute',
      },
    ];
    await saveProject(root, trailer, trailer.revision);
    const edit = await buildProject(root);
    assert.ok(
      !edit.operations.some(operation => operation.kind === 'browser'),
      'recorded Take trailer must not replay the game',
    );
    assert.equal(edit.artifacts.find(artifact => artifact.id === edit.result!.artifact)!.media!.frames, 4);
    await exportProject(root, delivery);
    const reopened = await buildProject(delivery);
    assert.ok(reopened.operations.every(operation => operation.reused));
    assert.deepEqual((await loadProject(delivery)).worlds, trailer.worlds);
    // A mismatched World cannot be disguised as the current recording on export.
    const invalid = await loadProject(root);
    invalid.worlds![0].revision++;
    await writeFile(join(root, 'project.json'), JSON.stringify(invalid));
    await assert.rejects(exportProject(root, join(parent, 'invalid')), /recording World does not match/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
