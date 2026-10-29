/*
 * Viscraft recipe: instantiate the reusable TYPE + CHART Look into a NEW Project.
 *
 *   viscraft author create.mjs <new-project-directory> [--options <options.json>]
 *
 * The executable mechanics (loading, hashing, copying, licence carriage, Project
 * writing) belong to the Runtime. This file is the editable
 * creative declaration: the Look's intent, its per-Source parameters, palette
 * and timing. The module implementation (`type-chart.mjs`) and the editable
 * template scene live beside this recipe and are copied from here by
 * `authorProject`; this file declares their paths, rights and handoff.
 *
 * RIGHTS: the module is adapted from huashu-art-motion @ f178bd77 (alchaincyf),
 * MIT. That origin and `redistributable: true` live in `rights.mjs`, shared with
 * the atlas-reveal fixture that composes this module; the template scene carries
 * the same attribution because it is part of the same adapted Look — not CC0,
 * which would misstate the upstream licence.
 *
 * The Project carries the Runtime's verbatim THIRD_PARTY_NOTICES.md located from
 * the running Runtime. Hashes and revisions are filled by the Runtime from the
 * copied bytes; this recipe never computes them.
 *
 * Authoring performs no provider work. Build with the separate command:
 *   viscraft build <project-directory>
 */
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TYPE_CHART_MODULE, TYPE_CHART_RIGHTS } from './rights.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = 'type-scene.html';
const MODULE = TYPE_CHART_MODULE;
const NOTICE = 'THIRD_PARTY_NOTICES.md';
const SCENE_RIGHTS = {
  origin:
    'adapted from huashu-art-motion scripts/engine/lib/typo.js, scripts/engine/lib/chart.js, scripts/engine/lib/util.js @ f178bd7754a71d6d399473af1501634548efa6cb (alchaincyf), MIT',
  license: 'MIT',
  redistributable: true,
};

function slugToId(name) {
  const cleaned = String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'study';
  return ('tc-' + (/^[a-z0-9]/.test(cleaned) ? cleaned : 'p-' + cleaned)).slice(0, 96);
}

export default async function ({ root, options, runtime }) {
  const { width = 640, height = 360, frames: perSourceFrames = 24 } = options ?? {};
  for (const [name, value] of Object.entries({ width, height, frames: perSourceFrames })) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`"${name}" must be a positive integer`);
  }
  if (width % 2 !== 0 || height % 2 !== 0) throw new Error('"width" and "height" must be even');

  const fps = 24;
  const sampleRate = 48000;
  const channels = 2;

  // ---- one Look, fully parameterized from the Source's `params` -----------
  const SOURCE_PARAMS = {
    text: '数据叙事 Data Story',
    subtitle: 'Index, 2020 = 100 · 示意数据 (illustrative)',
    source: 'Source: illustrative figures',
    badge: '示意数据',
    fontFamily: 'sans-serif',
    fontWeight: 700,
    layout: 'chart',
    revealFrames: perSourceFrames,
    startFrame: 0,
    chart: {
      values: [38, 52, 44, 61, 55, 72, 80],
      labels: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7'],
      unit: 'index',
      yMin: 0,
      yMax: 90,
      tickCount: 5,
      highlight: 6,
    },
    palette: {
      bg: '#f7f6f2',
      panel: '#ffffff',
      ink: '#141414',
      sub: '#4f5b61',
      rule: '#e3120b',
      grid: 'rgba(0,0,0,0.12)',
      zero: '#141414',
      axis: '#5b5b5b',
      bar: '#1f5c99',
      barDim: '#b9c3cc',
      line: '#e3120b',
      accent: '#ffd166',
      source: '#7c868b',
    },
  };

  const sourceId = 'ledger';
  const sources = [{
    id: sourceId,
    kind: 'browser',
    output: 'picture',
    entry: ENTRY,
    resources: [MODULE],
    bindings: [],
    params: SOURCE_PARAMS,
    seed: 5077,
    frames: perSourceFrames,
  }];

  const look = { id: 'type-chart', description: 'CJK-aware type layout + staged data-chart reveal (grid → bars → line → annotation), driven by frame.' };
  const sceneId = 'scene_main';
  const shots = [{
    id: `shot_${sourceId}`,
    scene: sceneId,
    look: look.id,
    intent: 'Type + chart Look authored from params: a mixed CJK+Latin headline over a bar/line chart revealed as a pure function of the frame.',
    targetFrames: perSourceFrames,
  }];
  const placements = [{ id: `pl_${sourceId}`, shot: `shot_${sourceId}`, source: sourceId, inFrame: 0, outFrame: perSourceFrames, startFrame: 0, audio: 'mute' }];

  // ---- the module + template scene beside this recipe + the Runtime notice --
  const files = [
    { path: ENTRY, sourcePath: join(HERE, ENTRY) },
    { path: MODULE, sourcePath: join(HERE, MODULE) },
    { path: NOTICE, sourcePath: join((await runtime.runtimeLocation(root)).path, NOTICE) },
  ];
  const assets = [
    { id: 'type_chart_scene', path: ENTRY, type: 'code', simulated: false, rights: SCENE_RIGHTS },
    { id: 'type_chart_module', path: MODULE, type: 'code', simulated: false, rights: TYPE_CHART_RIGHTS },
  ];

  const project = {
    schemaVersion: 1,
    id: slugToId(basename(root)),
    revision: 1,
    title: 'TYPE + CHART — reusable type/chart Look',
    direction: {
      intent:
        'One reusable type+chart module: a CJK-aware headline layout (measure, break by width, align, reveal per line/glyph) over a small data chart whose scaling, ticks, bar/line geometry and staged reveal are pure functions of the frame. Illustrative data, editorial chart styling — not photorealistic or a live-data dashboard.',
      looks: [look],
      transitions: [],
    },
    assets,
    bindings: {},
    handoff: [{ path: NOTICE, role: 'license' }],
    sources,
    composition: {
      output: { width, height, fps: { numerator: fps, denominator: 1 }, sampleRate, channels },
      scenes: [{ id: sceneId, description: 'A single editorial type+chart shot from one Look module.' }],
      shots,
      placements,
      transitions: [],
      audio: [],
    },
  };

  return { project, files };
}
