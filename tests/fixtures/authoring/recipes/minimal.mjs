/*
 * A minimal detached author recipe fixture (tests only).
 *
 * It proves the CLI imports an explicitly selected local recipe, passes the
 * running Runtime SDK and the parsed options once, and publishes generated
 * bytes + an absolute source file with no Skill involvement. The recipe writes
 * nothing itself: `authorProject` owns publication.
 */
import { basename, isAbsolute, resolve } from 'node:path';

const RIGHTS = {
  origin: 'original: tests/fixtures/authoring/recipes/minimal.mjs',
  license: 'CC0-1.0',
  redistributable: true,
};

const SCENE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Detached author fixture</title></head>
<body style="margin:0;background:#101418">
<canvas id="stage" width="64" height="36"></canvas>
<script>
  window.viscraft = {
    render({ frame }) {
      const canvas = document.getElementById('stage');
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#101418';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#e8b04b';
      ctx.fillRect(4 + frame, 10, 12, 12);
    },
  };
</script>
</body>
</html>
`;

export default async function ({ root, options, runtime }) {
  for (const name of ['authorProject', 'validateProject']) {
    if (typeof runtime[name] !== 'function') throw new Error(`runtime.${name} must be exported by the running Runtime`);
  }
  const settings = options ?? {};
  const title = typeof settings.title === 'string' ? settings.title : 'Detached author fixture';
  const frames = Number.isInteger(settings.frames) ? settings.frames : 2;
  const files = [
    { path: 'scene.html', bytes: SCENE },
    { path: 'notes/README.md', bytes: '# Detached author fixture\n' },
  ];
  if (typeof settings.source === 'string') {
    const sourcePath = isAbsolute(settings.source) ? settings.source : resolve(process.cwd(), settings.source);
    files.push({ path: 'assets/from-option.txt', sourcePath });
  }
  const assets = [
    { id: 'detached_scene', path: 'scene.html', type: 'code', simulated: false, rights: RIGHTS },
  ];
  if (settings.source) {
    assets.push({ id: 'detached_source', path: 'assets/from-option.txt', type: 'code', simulated: false, rights: RIGHTS });
  }
  const project = {
    schemaVersion: 1,
    id: `detached-${basename(root).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'project'}`,
    revision: 1,
    title,
    direction: { intent: 'Runtime-only detached authoring fixture.', looks: [{ id: 'look', description: 'One look' }], transitions: [] },
    assets,
    bindings: {},
    sources: [
      {
        id: 'detached_src',
        kind: 'browser',
        output: 'picture',
        entry: 'scene.html',
        resources: [],
        bindings: [],
        params: { fixture: true },
        seed: 0,
        frames,
      },
    ],
    composition: {
      output: { width: 64, height: 36, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene_main', description: 'Fixture scene' }],
      shots: [{ id: 'shot_main', scene: 'scene_main', look: 'look', intent: 'One frame', targetFrames: frames }],
      placements: [
        { id: 'pl_main', shot: 'shot_main', source: 'detached_src', inFrame: 0, outFrame: frames, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio: [],
    },
  };
  return { project, files };
}
