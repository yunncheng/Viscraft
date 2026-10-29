/*
 * Viscraft recipe: instantiate the "Atlas reveal" lightweight end-to-end work
 * into a NEW Project.
 *
 *   viscraft author create.mjs <new-project-directory> [--options <options.json>]
 *
 * The executable mechanics (loading, hashing, copying, licence carriage, Project
 * writing) belong to the Runtime. This file is the editable
 * creative declaration: the two atlas sheets, their terrain/legend parameters,
 * palettes, panel geometry, Project ids and the explicit mix-test signal. The two
 * module implementations live in their respective reference/fixture directories; their provenance is shared
 * through those studies' `rights.mjs`, so the recipe and the fixture record the
 * same origin.
 *
 * This example COMPOSES two reusable author modules into one Look, to prove the
 * modules compose a real work end to end (create → build → modify → deliver):
 *
 *   - the example's own scene (atlas-scene.html + atlas-scene.mjs) draws, every
 *     frame, a cel + watercolour terrain plate (cel-watercolor) with an editorial
 *     data legend (type-chart) composited into a panel; and
 *   - it authors TWO `browser` picture Sources over that one entry that share the
 *     modules but differ in `params` + `seed` (two "atlas sheets").
 *
 * The two module files are local reads from their studies, declared here as
 * `code` Asset drafts with the studies' rights. The fixture's own scene files
 * beside this recipe are editable template files, also declared here. The
 * Project carries the Runtime's verbatim THIRD_PARTY_NOTICES.md (the MIT and
 * Manim-derived notices). Hashes and revisions are filled by the Runtime from
 * the copied bytes.
 *
 * No absolute host paths are written into the project, and authoring performs no
 * provider work. Build with the separate command:
 *   viscraft build <project-directory>
 */
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CEL_WATERCOLOR_DIR, CEL_WATERCOLOR_MODULE, CEL_WATERCOLOR_RIGHTS } from '../../../../skills/viscraft/assets/studies/code-visuals/cel-watercolor/rights.mjs';
import { TYPE_CHART_DIR, TYPE_CHART_MODULE, TYPE_CHART_RIGHTS } from '../type-chart/rights.mjs';
import { makeSignalAsset } from '../lib/audio-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENE_HTML = 'atlas-scene.html';
const SCENE_MJS = 'atlas-scene.mjs';
const CW_MJS = CEL_WATERCOLOR_MODULE;
const TC_MJS = TYPE_CHART_MODULE;
const CW_SOURCE = join(CEL_WATERCOLOR_DIR, CW_MJS);
const TC_SOURCE = join(TYPE_CHART_DIR, TC_MJS);
const NOTICE = 'THIRD_PARTY_NOTICES.md';

// Rights for the example's OWN scene. It is original Viscraft code that composes
// the two MIT modules, so it carries MIT (never a CC0 claim that would misstate
// the licence of the combined work).
const SCENE_RIGHTS = {
  origin:
    'original: the atlas-reveal example scene, authored for Viscraft; composes the MIT cel-watercolor and type-chart author modules',
  license: 'MIT',
  redistributable: true,
};

function slugToId(name) {
  const cleaned = String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'study';
  return ('atlas-' + (/^[a-z0-9]/.test(cleaned) ? cleaned : 'p-' + cleaned)).slice(0, 96);
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
  // Both modules are told to complete their reveal on the last authored frame.
  const revealFrames = Math.max(1, perSourceFrames - 1);

  // ---- palettes (full, #rrggbb) so both modules render with valid colours ---
  const GROVE_PALETTE = {
    paper: '#f2ead9',
    sky: '#cdd7d8',
    skyDeep: '#aabcc2',
    hillFar: '#a9b79b',
    hillMid: '#829677',
    hillNear: '#6f8468',
    ground: '#cdbf94',
    trunk: '#7a6a57',
    leaf: '#5f8a52',
    leafDeep: '#3f6a3e',
    ink: '#2b2520',
    accent: '#c06a45',
  };
  const MEADOW_PALETTE = {
    paper: '#eee8dc',
    sky: '#c6d2d6',
    skyDeep: '#9db3bd',
    hillFar: '#9fb294',
    hillMid: '#7b9070',
    hillNear: '#65805f',
    ground: '#c8bb92',
    trunk: '#75685a',
    leaf: '#5a8a54',
    leafDeep: '#3b6a40',
    ink: '#282320',
    accent: '#b96448',
  };
  const CHART_PALETTE = {
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
  };

  // ---- two parameterized "atlas sheets" over one entry ----------------------
  const OPEN_PARAMS = {
    terrain: {
      subject: 'grove',
      layout: 'wide',
      revealFrames,
      celEdge: 0.85,
      azimuth: 2.25,
      bleed: 0.6,
      wetEdge: 0.6,
      pooling: 0.5,
      grain: 0.35,
      inkWeight: 2.6,
      misregistration: { dx: 0.8, dy: -0.6 },
      density: 1,
      palette: GROVE_PALETTE,
    },
    legend: {
      text: 'FIELD ATLAS - SHEET I',
      subtitle: 'Index, 2020 = 100 (illustrative)',
      source: 'Source: illustrative figures',
      badge: 'illustrative',
      fontFamily: 'sans-serif',
      fontWeight: 700,
      layout: 'chart',
      revealFrames,
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
      palette: CHART_PALETTE,
    },
    panel: { x: 0.52, y: 0.14, w: 0.42, h: 0.68, opacity: 0.97, border: 0.55 },
  };
  const CLOSE_PARAMS = {
    terrain: {
      subject: 'meadow',
      layout: 'wide',
      revealFrames,
      celEdge: 0.75,
      azimuth: 2.55,
      bleed: 0.5,
      wetEdge: 0.5,
      pooling: 0.45,
      grain: 0.4,
      inkWeight: 2.2,
      misregistration: { dx: -0.7, dy: 0.5 },
      density: 1.25,
      palette: MEADOW_PALETTE,
    },
    legend: {
      text: 'FIELD ATLAS - SHEET II',
      subtitle: 'Percent change, illustrative',
      source: 'Source: illustrative figures',
      badge: 'illustrative',
      fontFamily: 'sans-serif',
      fontWeight: 700,
      layout: 'chart',
      revealFrames,
      startFrame: 0,
      chart: {
        values: [62, 48, 55, 41, 66, 58, 74],
        labels: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
        unit: 'percent',
        yMin: 0,
        yMax: 90,
        tickCount: 5,
        highlight: 6,
      },
      palette: CHART_PALETTE,
    },
    panel: { x: 0.08, y: 0.18, w: 0.44, h: 0.66, opacity: 0.97, border: 0.55 },
  };

  const resources = [SCENE_MJS, CW_MJS, TC_MJS];
  const specs = [
    { id: 'atlas_open', seed: 6101, params: OPEN_PARAMS },
    { id: 'atlas_close', seed: 6102, params: CLOSE_PARAMS },
  ];
  const sources = specs.map(spec => ({
    id: spec.id,
    kind: 'browser',
    output: 'picture',
    entry: SCENE_HTML,
    resources,
    bindings: [],
    params: spec.params,
    seed: spec.seed,
    frames: perSourceFrames,
  }));

  const look = {
    id: 'atlas',
    description:
      'A cel + watercolour terrain plate with an editorial data legend composited into a panel; both the paint and the legend reveal over the shot as a pure function of the frame.',
  };
  const sceneId = 'scene_main';
  let cursor = 0;
  const shots = [];
  const placements = [];
  for (const spec of specs) {
    shots.push({
      id: `shot_${spec.id}`,
      scene: sceneId,
      look: look.id,
      intent: `An atlas sheet: a cel + watercolour ${spec.params.terrain.subject} plate with an overlaid illustrative data legend.`,
      targetFrames: perSourceFrames,
    });
    placements.push({
      id: `pl_${spec.id}`,
      shot: `shot_${spec.id}`,
      source: spec.id,
      inFrame: 0,
      outFrame: perSourceFrames,
      startFrame: cursor,
      audio: 'mute',
    });
    cursor += perSourceFrames;
  }
  const totalFrames = cursor;
  const totalSamples = Math.ceil((totalFrames / fps) * sampleRate);
  // Two real PCM beds; the authored clip timing and gain are unchanged.
  const bedLow = makeSignalAsset({
    id: 'bed_low',
    path: 'bed-low.wav',
    sampleRate,
    channels,
    samples: totalSamples,
    frequency: 110,
    waveform: 'sine',
  });
  const bedHigh = makeSignalAsset({
    id: 'bed_high',
    path: 'bed-high.wav',
    sampleRate,
    channels,
    samples: totalSamples,
    frequency: 330,
    waveform: 'triangle',
  });
  const audio = [
    {
      id: 'bed_low',
      kind: 'asset',
      asset: 'bed_low',
      inSample: 0,
      startSample: 0,
      durationSamples: totalSamples,
      gain: 0.07,
      fadeInSamples: Math.min(4800, Math.floor(totalSamples / 4)),
      fadeOutSamples: Math.min(9600, Math.floor(totalSamples / 2)),
    },
    {
      id: 'bed_high',
      kind: 'asset',
      asset: 'bed_high',
      inSample: 0,
      startSample: 0,
      durationSamples: totalSamples,
      gain: 0.025,
      fadeInSamples: Math.min(4800, Math.floor(totalSamples / 4)),
      fadeOutSamples: Math.min(9600, Math.floor(totalSamples / 2)),
    },
  ];

  // ---- the two reference modules + this fixture's template scene -----------
  const files = [
    { path: SCENE_HTML, sourcePath: join(HERE, SCENE_HTML) },
    { path: SCENE_MJS, sourcePath: join(HERE, SCENE_MJS) },
    { path: CW_MJS, sourcePath: CW_SOURCE },
    { path: TC_MJS, sourcePath: TC_SOURCE },
    { path: NOTICE, sourcePath: join((await runtime.runtimeLocation(root)).path, NOTICE) },
    { path: bedLow.asset.path, bytes: bedLow.bytes },
    { path: bedHigh.asset.path, bytes: bedHigh.bytes },
  ];
  const assets = [
    { id: 'atlas_scene', path: SCENE_HTML, type: 'code', simulated: false, rights: SCENE_RIGHTS },
    { id: 'atlas_module', path: SCENE_MJS, type: 'code', simulated: false, rights: SCENE_RIGHTS },
    { id: 'cw_module', path: CW_MJS, type: 'code', simulated: false, rights: CEL_WATERCOLOR_RIGHTS },
    { id: 'tc_module', path: TC_MJS, type: 'code', simulated: false, rights: TYPE_CHART_RIGHTS },
    bedLow.asset,
    bedHigh.asset,
  ];

  const project = {
    schemaVersion: 1,
    id: slugToId(basename(root)),
    revision: 1,
    title: 'ATLAS REVEAL — two author modules composed into one work',
    direction: {
      intent:
        'A lightweight end-to-end example that composes two reusable author modules into one Look: a cel + watercolour terrain plate (cel-watercolor) with an editorial data legend (type-chart) overlaid in a panel. Two parameterized sheets share one scene; each reveals as a pure function of the frame. The data is illustrative and the paint is procedural - a mechanical composition proof, not a finished artwork.',
      looks: [look],
      transitions: [],
    },
    assets,
    bindings: {},
    handoff: [{ path: NOTICE, role: 'license' }],
    sources,
    composition: {
      output: { width, height, fps: { numerator: fps, denominator: 1 }, sampleRate, channels },
      scenes: [{ id: sceneId, description: 'Two atlas sheets composed from the cel-watercolor and type-chart modules.' }],
      shots,
      placements,
      transitions: [],
      audio,
    },
  };

  return { project, files };
}
