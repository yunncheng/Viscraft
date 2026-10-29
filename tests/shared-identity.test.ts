/**
 * Contract for `tests/fixtures/authoring/create-shared-identity.mjs`: it authors a multi-shot
 * plan in which every generated shot is conditioned on the SAME approved still,
 * performs NO provider work, and refuses to overwrite an existing project.
 *
 * The script is a shipped capability, so this pins the parts a host agent relies
 * on: one reference Asset, one animatic placement (no unselected Source placed),
 * one `provider` Source per shot sharing `promptImage`, and a valid Project.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateProject } from '../src/index.js';
import { runCommand } from '../src/shared/process.js';

const SCRIPT = fileURLToPath(new URL('../../tests/fixtures/authoring/create-shared-identity.mjs', import.meta.url));
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

test('create-shared-identity authors one shared reference for every shot without provider work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'viscraft-shared-identity-'));
  try {
    const reference = join(dir, 'reference.png');
    const rights = join(dir, 'rights.json');
    const prompts = join(dir, 'prompts.json');
    const project = join(dir, 'project');
    await writeFile(reference, ONE_PIXEL_PNG);
    await writeFile(
      rights,
      JSON.stringify({ origin: 'original test fixture', license: 'CC0-1.0', redistributable: true }),
    );
    await writeFile(
      prompts,
      JSON.stringify({
        title: 'two shots',
        model: 'custom-video-model',
        endpoint: 'studio',
        fps: 30,
        requestedFrames: 60,
        size: '640:360',
        steps: 10,
        shots: [
          { id: 'shot_a', prompt: 'first' },
          { id: 'shot_b', prompt: 'second', seed: 7 },
        ],
      }),
    );

    await runCommand(process.execPath, [SCRIPT, project, reference, rights, prompts]);
    const parsed = validateProject(JSON.parse(await readFile(join(project, 'project.json'), 'utf8')));

    const stills = parsed.assets.filter(asset => asset.type === 'image');
    assert.equal(stills.length, 1, 'exactly one approved image Asset');
    const generated = parsed.sources.filter(source => source.kind === 'provider');
    assert.equal(generated.length, 2, 'one generated Source per shot');
    for (const source of generated) {
      assert.ok(
        source.references.some(reference => reference.asset === stills[0].id),
        'every generated shot shares the same reference Asset',
      );
      assert.equal(source.model, 'custom-video-model');
      assert.equal(source.endpoint, 'studio', 'only a binding key is persisted');
      assert.equal(source.fps, 30);
      assert.equal(source.requestedFrames, 60, 'other models do not inherit H3 frame limits');
      assert.equal(source.size, '640:360', 'other models do not inherit H3 dimensions');
    }

    // Only the animatic board is placed, so a plain build must not require a provider.
    assert.equal(parsed.composition!.placements.length, 1, 'only the animatic board is placed');
    assert.equal(parsed.composition!.placements[0].asset, 'reference');
    assert.equal(parsed.composition!.placements[0].audio, 'mute');
    assert.equal(parsed.composition!.shots.length, 3, 'the board plus one Shot per generated Source');

    // Refuses to overwrite an existing project.
    await assert.rejects(
      () => runCommand(process.execPath, [SCRIPT, project, reference, rights, prompts]),
      /refusing to overwrite|EEXIST|ENOTEMPTY|create-shared-identity/i,
    );

    // Rejects a single-shot plan (defensive: the point is multiple shots).
    const single = join(dir, 'single.json');
    await writeFile(single, JSON.stringify({ shots: [{ id: 'only', prompt: 'one' }] }));
    await assert.rejects(
      () => runCommand(process.execPath, [SCRIPT, join(dir, 'p2'), reference, rights, single]),
      /2\.\.8 shots/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
