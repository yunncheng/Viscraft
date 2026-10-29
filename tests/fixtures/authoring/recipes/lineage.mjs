/*
 * A small Asset-lineage fixture (tests only).
 *
 * One Asset is a derivative of another and freezes the parent identity in
 * `inputs`. Authoring and export must preserve the relation and both originals.
 */
import { createHash } from 'node:crypto';

const PARENT = 'lineage parent v1\n';
const CHILD = 'lineage child derived from the parent\n';
const SCENE = `<!doctype html><html><body style="margin:0;background:#151a20"></body></html>\n`;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const RIGHTS = {
  origin: 'original: tests/fixtures/authoring/recipes/lineage.mjs',
  license: 'CC0-1.0',
  redistributable: true,
};

export default async function ({ root }) {
  const parentSha = sha256(PARENT);
  const assets = [
    { id: 'lineage_parent', path: 'src/parent.txt', type: 'code', simulated: false, rights: RIGHTS },
    {
      id: 'lineage_child',
      path: 'src/child.txt',
      type: 'code',
      simulated: false,
      rights: RIGHTS,
      inputs: [{ asset: 'lineage_parent', revision: 1, sha256: parentSha, role: 'source' }],
    },
    { id: 'lineage_scene', path: 'scene.html', type: 'code', simulated: false, rights: RIGHTS },
  ];
  const files = [
    { path: 'src/parent.txt', bytes: PARENT },
    { path: 'src/child.txt', bytes: CHILD },
    { path: 'scene.html', bytes: SCENE },
    { path: 'README.md', bytes: '# Lineage fixture\n' },
  ];
  const project = {
    schemaVersion: 1,
    id: 'lineage-fixture',
    revision: 1,
    title: 'Lineage fixture',
    direction: { intent: 'Parent/derivative provenance.', looks: [{ id: 'look', description: 'One look' }], transitions: [] },
    assets,
    bindings: {},
    handoff: [{ path: 'README.md', role: 'readme' }],
    sources: [
      {
        id: 'lineage_src',
        kind: 'browser',
        output: 'picture',
        entry: 'scene.html',
        resources: [],
        bindings: [],
        params: {},
        seed: 0,
        frames: 1,
      },
    ],
    composition: {
      output: { width: 64, height: 36, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene_main', description: 'Lineage scene' }],
      shots: [{ id: 'shot_main', scene: 'scene_main', look: 'look', intent: 'One frame', targetFrames: 1 }],
      placements: [
        { id: 'pl_main', shot: 'shot_main', source: 'lineage_src', inFrame: 0, outFrame: 1, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio: [],
    },
  };
  return { project, files };
}
