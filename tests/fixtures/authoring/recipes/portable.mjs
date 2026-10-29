/*
 * A portable adopted-source fixture (tests only).
 *
 * The Project keeps a small adopted ES module AND the browser scene that imports
 * it by relative path. The scene paints the module's COLOR, so modifying the
 * adopted bytes in an exported copy measurably changes the rendered output with
 * the authoring recipe/workspace unavailable.
 */
import { basename } from 'node:path';

const RIGHTS = {
  origin: 'original: tests/fixtures/authoring/recipes/portable.mjs',
  license: 'CC0-1.0',
  redistributable: true,
};

const SCENE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Portable fixture</title></head>
<body style="margin:0">
<canvas id="stage" width="64" height="36"></canvas>
<script type="module">
  import { COLOR } from './adopted.mjs';
  window.viscraft = {
    render() {
      const canvas = document.getElementById('stage');
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = COLOR;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    },
  };
</script>
</body>
</html>
`;

const ADOPTED = `// Adopted author module. The exported Project owns these bytes.
export const COLOR = '#3a7bd5';
export const LABEL = 'adopted v1';
`;

export default async function ({ root, options }) {
  const { width = 64, height = 36, frames = 2 } = options ?? {};
  const files = [
    { path: 'scene.html', bytes: SCENE },
    { path: 'adopted.mjs', bytes: ADOPTED },
    { path: 'README.md', bytes: '# Portable fixture\n\nEdit `adopted.mjs` to change the scene.\n' },
    { path: 'LICENSES.md', bytes: 'This fixture is original work released as CC0-1.0.\n' },
  ];
  const assets = [
    { id: 'portable_scene', path: 'scene.html', type: 'code', simulated: false, rights: RIGHTS },
    { id: 'portable_module', path: 'adopted.mjs', type: 'code', simulated: false, rights: RIGHTS },
  ];
  const project = {
    schemaVersion: 1,
    id: `portable-${basename(root).replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}`.slice(0, 96),
    revision: 1,
    title: 'Portable adopted-source fixture',
    direction: { intent: 'One adopted module imported by relative path.', looks: [{ id: 'look', description: 'One look' }], transitions: [] },
    assets,
    bindings: {},
    handoff: [
      { path: 'README.md', role: 'readme' },
      { path: 'LICENSES.md', role: 'license' },
    ],
    sources: [
      {
        id: 'portable_src',
        kind: 'browser',
        output: 'picture',
        entry: 'scene.html',
        resources: ['adopted.mjs'],
        bindings: [],
        params: {},
        seed: 0,
        frames,
      },
    ],
    composition: {
      output: { width, height, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene_main', description: 'Portable fixture scene' }],
      shots: [{ id: 'shot_main', scene: 'scene_main', look: 'look', intent: 'Two frames', targetFrames: frames }],
      placements: [
        { id: 'pl_main', shot: 'shot_main', source: 'portable_src', inFrame: 0, outFrame: frames, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio: [],
    },
  };
  return { project, files };
}
