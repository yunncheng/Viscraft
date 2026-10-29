/*
 * A detached, Runtime-only author recipe fixture (tests only).
 *
 * It uses ONLY the running Runtime SDK — no Skill paths, no Runtime creative
 * resource catalogue — and generates every byte it adopts itself. After this
 * recipe directory is removed, the Project must still build, export, reopen and
 * serve the fixed Runtime workbench from its own bytes.
 */
import { basename } from 'node:path';

const ENTRY = 'scene.html';
const MODULE = 'adopted.mjs';
const DOCUMENT = 'still.html';
const RIGHTS = {
  origin: 'original: tests/fixtures/authoring/recipes/runtime-only.mjs',
  license: 'CC0-1.0',
  redistributable: true,
};

// The recipe generates its own scene and its own adopted module: no Skill
// template, no Runtime module table. The scene imports the module by relative
// path, so the Project owns a real executable closure.
const SCENE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Runtime-only fixture</title></head>
<body style="margin:0">
<canvas id="stage" width="160" height="90"></canvas>
<script type="module">
  import { COLOR, label } from './adopted.mjs';
  window.viscraft = {
    render() {
      const canvas = document.getElementById('stage');
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#101418';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = COLOR;
      ctx.fillRect(8, 20, 40, 50);
      void label();
    },
  };
</script>
</body>
</html>
`;

const ADOPTED = `// Adopted author module. The Project owns these bytes.
export const COLOR = '#e8b04b';
export function label() {
  return 'runtime-only v1';
}
`;

const STILL = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Runtime-only still</title></head>
<body style="margin:0;background:#101418">
<div style="width:64px;height:36px;background:#e8b04b"></div>
</body>
</html>
`;

export default async function ({ root, options }) {
  const { width = 160, height = 90, frames = 2 } = options ?? {};
  for (const [name, value] of Object.entries({ width, height, frames })) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`"${name}" must be a positive integer`);
  }
  if (width % 2 !== 0 || height % 2 !== 0) throw new Error('"width" and "height" must be even');

  const files = [
    { path: ENTRY, bytes: SCENE },
    { path: MODULE, bytes: ADOPTED },
    { path: DOCUMENT, bytes: STILL },
    { path: 'README.md', bytes: '# Runtime-only fixture\n' },
    { path: 'LICENSES.md', bytes: 'This fixture is original work released as CC0-1.0.\n' },
  ];
  const assets = [
    { id: 'ro_scene', path: ENTRY, type: 'code', simulated: false, rights: RIGHTS },
    { id: 'ro_module', path: MODULE, type: 'code', simulated: false, rights: RIGHTS },
  ];
  const project = {
    schemaVersion: 1,
    id: `runtime-only-${basename(root).replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}`.slice(0, 96),
    revision: 1,
    title: 'Runtime-only author fixture',
    direction: {
      intent: 'A self-contained recipe with no Skill and no Runtime creative resource catalogue.',
      looks: [{ id: 'look', description: 'One look' }],
      transitions: [],
    },
    assets,
    bindings: {},
    handoff: [
      { path: 'README.md', role: 'readme' },
      { path: 'LICENSES.md', role: 'license' },
    ],
    sources: [
      {
        id: 'ro_src',
        kind: 'browser',
        output: 'picture',
        entry: ENTRY,
        resources: [MODULE],
        bindings: [],
        params: {},
        seed: 5,
        frames,
      },
    ],
    imageDocuments: [{ id: 'still', path: DOCUMENT, resources: [], revision: 1 }],
    imageTargets: [
      { id: 'still', document: 'still', width: 64, height: 36, scale: 1, format: 'png', background: 'opaque' },
    ],
    composition: {
      output: { width, height, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene_main', description: 'Runtime-only fixture scene' }],
      shots: [{ id: 'shot_main', scene: 'scene_main', look: 'look', intent: 'Two frames', targetFrames: frames }],
      placements: [
        {
          id: 'pl_main',
          shot: 'shot_main',
          source: 'ro_src',
          inFrame: 0,
          outFrame: frames,
          startFrame: 0,
          audio: 'mute',
        },
      ],
      transitions: [],
      audio: [],
    },
  };
  return { project, files };
}
