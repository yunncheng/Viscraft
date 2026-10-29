#!/usr/bin/env node
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../../../dist/src/shared/process.js';
import { validateProject } from '../../../dist/src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 1)
  throw new Error('Usage: node tests/fixtures/authoring/create-world-playable.mjs <new-project-directory>');
const root = resolve(args[0]);
await runCommand(process.execPath, [join(here, 'create-world.mjs'), root]);
await copyFile(join(here, 'world-playable.html'), join(root, 'world-playable.html'), constants.COPYFILE_EXCL);
await copyFile(
  join(here, '../../../dist/src/core/world-state.js'),
  join(root, 'world-state.js'),
  constants.COPYFILE_EXCL,
);
const project = JSON.parse(await readFile(join(root, 'project.json'), 'utf8'));
const renderer = project.sources[0];
project.sources.push({
  id: 'interactive',
  kind: 'browser', output: 'picture',
  entry: 'world-playable.html',
  resources: ['world.html', 'world-state.js'],
  bindings: renderer.bindings,
  params: renderer.params,
  seed: renderer.seed,
  frames: 180,
  world: { id: 'world_signal', camera: 'cam_chase', mode: 'define' },
});
project.title = 'SIGNAL RUN — interactive shared World';
project.direction.intent =
  'The same authored World/entities/Project SVG Assets and browser-safe sampler drive both camera film coverage and real arrow/Space controls. Session offsets, progress, score and gate events are recorded input-driven play state, not a second persisted World. The initial film composition remains editable; choose a fresh actual recording Take for a trailer.';
await writeFile(join(root, 'project.json'), JSON.stringify(validateProject(project), null, 2) + '\n');
console.log(
  JSON.stringify(
    {
      project: root,
      entry: 'world-playable.html',
      source: 'interactive',
      controls: 'Arrow keys steer, Space boost, R restart',
      next: 'Serve this trusted Project locally to play, or record an actual keyboard schedule with viscraft record.',
    },
    null,
    2,
  ),
);
