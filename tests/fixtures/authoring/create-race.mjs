#!/usr/bin/env node
/*
 * Viscraft technical fixture: create a code-native WEBGL race-film study from scratch,
 * vendoring a real three.js build as a documented Project dependency.
 *
 *   node tests/fixtures/authoring/create-race.mjs <new-project-directory> [<three-directory>]
 *
 * The three.js build is resolved from the installed `three` dependency
 * (`node_modules/three`, npm `three@0.186.1`, MIT) by default, so a clean
 * install needs a single argument. An explicit `<three-directory>` may be
 * passed as an override; it must contain `build/three.module.js`,
 * `build/three.core.js` and a top-level `LICENSE`. Either way this script
 * copies ONLY those three files into `<new-project-directory>/vendor/`,
 * verifies each against the exact expected sha256 (pinned in
 * tests/fixtures/authoring/lib/three-vendor.mjs), and registers the two ES-module bundles as
 * Project `code` Assets with their real content hash and an explicit MIT rights
 * record. It never copies any other file from that distribution, never copies
 * third-party engine code, and never rewrites the bundle bytes: adoption is by verbatim,
 * hashed vendoring with provenance, so a portable export carries the exact
 * licensed engine it rendered with.
 *
 * What this creates (and deliberately does NOT do):
 *
 *   - ONE persistent World (`world_circuit`) in meters on a right-handed, y-up
 *     frame at 30 fps for 360 frames (12 s). It owns the spatial truth: a closed
 *     circuit route, two car entities (hero + rival, each referencing its own
 *     original vehicle-material JSON Asset), two phase-offset trajectories and
 *     four genuine perspective cameras that follow the hero car with local
 *     offsets.
 *   - FOUR `browser` picture Sources with World bindings, each covering [0,360) but
 *     bound to a DIFFERENT camera, so one action is genuinely re-covered from an
 *     onboard, a chase, a wheel close-up and a high wide position. Every Source
 *     renders `race.html`, a real THREE.WebGLRenderer that draws a sculpted
 *     single-seater, four frame-driven spinning wheels, a road ribbon derived
 *     from the declared `params.route`, kerbs and lighting.
 *   - TWO intentional Looks: a cel-shaded `cel_race` coverage and a metallic
 *     `tech_study` wide, chosen per Source via `params.look`. The `tech_study`
 *     Source additionally declares a scoped `bindingOverrides.car_material`,
 *     swapping only the hero car's vehicle-material Asset for a technical-study
 *     variant — so the material change is a real, targeted bindings change, not
 *     an implicit renderer-only colour change.
 *   - A first-pass ROUGH CUT: four shots reading DIFFERENT sub-intervals of the
 *     shared World range, retaining available head/tail handles on its 360-frame
 *     Source so a later trim needs no regeneration. Layered audio is written as
 *     real PCM signal files scheduled on rational frame boundaries (beds, an
 *     engine drone per shot, cut accents, beat ticks, a final accent), plus four
 *     burned-in captions. No captured WebAudio.
 *
 * No new Runtime Source kind is introduced: every Source here is the existing
 * `browser` kind with a World binding from src/core/schema.ts. No external media, model, network, weight,
 * API or payment is used. The runtime must be built (`npm run build`); this
 * script imports its canonical `validateProject` and `framesToSamples` rather
 * than duplicating any schema or clock conversion. It refuses to overwrite an
 * existing project.json, race.html, material Asset or vendored file.
 */
import { access, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { makeSignalAsset } from './lib/audio-fixture.mjs';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THREE_VERSION, THREE_FILES, loadVerifiedThree } from './lib/three-vendor.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_HTML = join(HERE, 'race.html');

// --- fixed smoke configuration ----------------------------------------------
const WIDTH = 640;
const HEIGHT = 360;
const FPS = 30;
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const WORLD_FRAMES = 360; // 12 s of persistent World time
const BEAT_FRAMES = 15; // 120 BPM at 30 fps
const SEED = 20261008;

// The single closed circuit (meters, right-handed y-up). The World trajectory,
// the renderer's road ribbon/kerbs and the start gantry all derive from this one
// array, so every camera is genuinely looking at the same spatial truth.
const ROUTE = [
  [0, 0.0, 0],
  [26, 0.15, -1.5],
  [46, 0.45, 6],
  [58, 0.75, 22],
  [54, 0.85, 40],
  [38, 0.7, 50],
  [20, 0.45, 48],
  [8, 0.3, 36],
  [2, 0.22, 22],
  [-8, 0.3, 16],
  [-18, 0.42, 6],
  [-16, 0.28, -8],
  [-4, 0.1, -12],
  [6, 0.02, -8],
];
// The closed control polyline the World actually authors: the 14 vertices with
// the start repeated once, so the final keyframe covers the wrap segment. The
// sampler drops the coincident duplicate before wrapping the spline neighbours.
const CONTROL_POINTS = [...ROUTE, ROUTE[0]];

// The authored race line is a smoothed, evenly resampled version of the control
// polyline, built in two steps:
//   1. cutCorners rounds the sharp control kinks (the start/finish here turns
//      ~130 degrees) so the analytic catmull-rom tangent is well conditioned
//      there instead of whipping;
//   2. the cut line is resampled into RACE_LINE_POINTS control points spaced by
//      EQUAL ARC LENGTH, so a control-point index maps to a uniform arc-length
//      fraction. That uniform index->arc mapping is what lets the phase-shifted
//      rival share the hero's smooth heading (a lead of `RIVAL_LEAD` of a lap is
//      a clean arc-length shift).
// The road ribbon still follows the raw control polyline (source params.route);
// the race line stays inside the 7 m road (measured <= 2.3 m from the centreline).
function cutCorners(loop, iterations) {
  let points = loop;
  for (let pass = 0; pass < iterations; pass++) {
    const next = [];
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i],
        b = points[i + 1];
      next.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1], 0.75 * a[2] + 0.25 * b[2]]);
      next.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1], 0.25 * a[2] + 0.75 * b[2]]);
    }
    next.push(next[0].slice());
    points = next;
  }
  return points;
}
const RACE_LINE_POINTS = 25; // arc-length-uniform control points
const RACE_LINE = cutCorners(CONTROL_POINTS, 1); // one rounding pass: close to the road
const RACE_LINE_CONTROLS = (() => {
  const line = routeLength(RACE_LINE);
  const points = [];
  for (let i = 0; i < RACE_LINE_POINTS; i++) points.push(pointAt(line, i / RACE_LINE_POINTS));
  points.push(points[0].slice()); // close the loop (sampler drops the duplicate)
  return points;
})();
const RIVAL_LEAD = 0.03; // rival starts 3% of a lap ahead of the hero
const CAR = { wheelRadius: 0.34, wheelbase: 2.7, track: 1.55 };
const ROAD_WIDTH = 7.0;
const SHOULDER_WIDTH = 0.9;

// Two Looks: the intent is a deliberate coverage change between a stylized
// cel-shaded race and a cold metallic technical study — not an accidental drift,
// and never a claim of photorealism.
const CEL = {
  sky: '#1b0b2e',
  fog: '#241033',
  road: '#141a24',
  ground: '#160b24',
  grid: '#3b1d5c',
  kerbA: '#e11d48',
  kerbB: '#f8fafc',
  line: '#7dd3fc',
  accent: '#22d3ee',
  marker: '#6d28d9',
  hemiSky: '#8ab4ff',
  hemiGround: '#241033',
  keyLight: '#ffe9c2',
  rimLight: '#ff5ea8',
  fillLight: '#7dd3fc',
};
const TECH = {
  sky: '#04070d',
  fog: '#070d15',
  road: '#0a0e14',
  ground: '#070c13',
  grid: '#1e4d70',
  kerbA: '#0ea5e9',
  kerbB: '#e2e8f0',
  line: '#38bdf8',
  accent: '#22d3ee',
  marker: '#24486e',
  hemiSky: '#22405e',
  hemiGround: '#05070a',
  keyLight: '#dbeafe',
  rimLight: '#e0f2fe',
  fillLight: '#38bdf8',
  envTop: '#0a1422',
  envMid: '#173650',
  envBottom: '#04070c',
};

// Original vehicle-material Assets (authored here, not imported). The renderer
// matches an entity to its material by `binding.id === entity.asset`, so these
// JSON files define body/stripe/accent/rim colours and, for the technical
// study, the metalness/roughness used by the metallic Look.
const MATERIALS = [
  {
    id: 'asset_car_material',
    path: 'assets/car-hero.material.json',
    json: {
      livery: 'hero-cel',
      body: '#22d3ee',
      bodyDark: '#0e7490',
      stripe: '#f8fafc',
      accent: '#f43f5e',
      rim: '#e2e8f0',
      tire: '#0b0f14',
      glass: '#0b2230',
      metalness: 0.18,
      roughness: 0.52,
      glow: 0.8,
    },
  },
  {
    id: 'asset_rival_material',
    path: 'assets/car-rival.material.json',
    json: {
      livery: 'rival-cel',
      body: '#f59e0b',
      bodyDark: '#b45309',
      stripe: '#111827',
      accent: '#a855f7',
      rim: '#cbd5e1',
      tire: '#0b0f14',
      glass: '#1b1206',
      metalness: 0.18,
      roughness: 0.52,
      glow: 0.6,
    },
  },
  {
    id: 'asset_car_material_technical',
    path: 'assets/car-hero-technical.material.json',
    json: {
      livery: 'hero-technical',
      body: '#9fb3c8',
      bodyDark: '#334155',
      stripe: '#0ea5e9',
      accent: '#22d3ee',
      rim: '#94a3b8',
      tire: '#05070a',
      glass: '#0c1a24',
      metalness: 0.92,
      roughness: 0.22,
      glow: 0.15,
    },
  },
];

const MATERIAL_RIGHTS = {
  origin: 'original: authored for this example by tests/fixtures/authoring/create-race.mjs',
  license: 'CC0-1.0',
  redistributable: true,
};
const THREE_RIGHTS = {
  origin: `three.js r186 (npm three@${THREE_VERSION}) vendored build output; adopted verbatim with provenance`,
  license: 'MIT',
  redistributable: true,
};

// Cut grid of the rough cut. Each shot reads a different sub-interval of the
// shared [0,360) World range, so the same action is re-covered from a new angle
// and every Source keeps real handles outside the placed range. The wheel
// close-up is cut before the wide, and the wide is the technical-study Look.
const SHOTS = [
  {
    id: 'shot_grid',
    source: 'src_onboard',
    camera: 'cam_onboard',
    look: 'cel_race',
    startFrame: 0,
    inFrame: 0,
    frames: 90,
  },
  {
    id: 'shot_chase',
    source: 'src_chase',
    camera: 'cam_chase',
    look: 'cel_race',
    startFrame: 90,
    inFrame: 90,
    frames: 84,
  },
  {
    id: 'shot_wheel',
    source: 'src_wheel',
    camera: 'cam_wheel',
    look: 'cel_race',
    startFrame: 174,
    inFrame: 174,
    frames: 78,
  },
  {
    id: 'shot_wide',
    source: 'src_wide',
    camera: 'cam_wide',
    look: 'tech_study',
    startFrame: 252,
    inFrame: 252,
    frames: 108,
  },
];
const TOTAL_FRAMES = SHOTS[SHOTS.length - 1].startFrame + SHOTS[SHOTS.length - 1].frames; // 360 -> 12 s

function fail(message) {
  console.error('create-race: ' + message);
  process.exit(1);
}
function messageOf(error) {
  return error && error.message ? error.message : String(error);
}
async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}
function jsonText(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

/** Load the single canonical runtime. No fallback schema or clock conversion. */
async function loadRuntime() {
  try {
    return await import(new URL('../../../dist/src/index.js', import.meta.url));
  } catch (error) {
    fail('the Viscraft runtime is not built or not importable; run `npm run build` first (' + messageOf(error) + ')');
  }
}

// --- route math (meters, right-handed y-up) ---------------------------------
function routeLength(points) {
  const segments = [];
  let total = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const dx = b[0] - a[0],
      dy = b[1] - a[1],
      dz = b[2] - a[2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    segments.push({ a, b, len, start: total });
    total += len;
  }
  return { segments, total };
}
function pointAt(route, t) {
  const wrapped = ((t % 1) + 1) % 1;
  let distance = wrapped * route.total;
  for (const segment of route.segments) {
    if (distance <= segment.len || segment === route.segments[route.segments.length - 1]) {
      const k = segment.len > 1e-9 ? distance / segment.len : 0;
      return [
        segment.a[0] + (segment.b[0] - segment.a[0]) * k,
        segment.a[1] + (segment.b[1] - segment.a[1]) * k,
        segment.a[2] + (segment.b[2] - segment.a[2]) * k,
      ];
    }
    distance -= segment.len;
  }
  return route.segments[0].a.slice();
}
// Heading so that a car authored with local forward = +Z faces the route:
// rotation.y = atan2(dx, dz). This matches world-state.ts's Euler-XYZ follow
// convention and race.html's model orientation.
function headingAt(route, t) {
  const wrapped = ((t % 1) + 1) % 1;
  let distance = wrapped * route.total;
  for (const segment of route.segments) {
    if (distance <= segment.len || segment === route.segments[route.segments.length - 1]) {
      return Math.atan2(segment.b[0] - segment.a[0], segment.b[2] - segment.a[2]);
    }
    distance -= segment.len;
  }
  return 0;
}

// How a car's yaw is authored.
//
// 'tangent' (default): the keyframes are the RACE LINE's evenly resampled
// control points (not one per frame) and the trajectory opts into a smooth,
// continuous path —
//     path:    'catmull-rom'  position from a spline through the points
//     heading: 'tangent'      yaw from the analytic path tangent (forward = +Z)
//     closed:  true            the start is repeated, so the loop seam is smooth
// The sampler therefore cannot produce a per-vertex heading step, and a rigid
// camera that follows the car derives its pose from the continuous tangent. The
// sampler adds no easing of its own — it derives yaw from the real path.
//
// Keyframe FRAMES are spaced uniformly across the control points (equal time per
// segment) rather than by arc length: an uneven time->path-parameter mapping
// re-introduces a yaw-rate spike where a short, sharp segment is compressed into
// too few frames. Uniform frames keep the mapping even. `lead` phases the rival
// by an arc-length fraction of the lap.
//
// 'rigid': the piecewise-linear control — one keyframe per frame on the RAW control polyline
// with rotation.y = the *segment* direction, i.e. a deliberate step at every
// vertex. It is kept for a Look that genuinely wants a locked/stepped mount, and
// it is how a hold is authored (give every keyframe the same rotation). The
// sampler never smooths an authored rotation of its own accord.
const TRAJECTORY_HEADING = 'tangent'; // 'tangent' (continuous, default) | 'rigid'

function buildTrajectory(id, entity, route, lineRoute, lead) {
  if (TRAJECTORY_HEADING === 'rigid') {
    const keyframes = Array.from({ length: WORLD_FRAMES }, (_, frame) => {
      const t = frame / (WORLD_FRAMES - 1) + lead;
      return { frame, position: pointAt(route, t), rotation: [0, headingAt(route, t), 0] };
    });
    return { id, entity, keyframes };
  }
  const n = RACE_LINE_CONTROLS.length;
  const keyframes = RACE_LINE_CONTROLS.map((point, i) => ({
    frame: Math.round((i / (n - 1)) * (WORLD_FRAMES - 1)),
    position: lead === 0 ? point : pointAt(lineRoute, i / (n - 1) + lead),
  }));
  return { id, entity, path: 'catmull-rom', heading: 'tangent', closed: true, keyframes };
}

// --- world ------------------------------------------------------------------
function buildWorld(fps, route) {
  const lineRoute = routeLength(RACE_LINE);
  const heroStart = pointAt(lineRoute, 0);
  const rivalStart = pointAt(lineRoute, RIVAL_LEAD);
  // The entity base rotation is only a fallback: the tangent trajectory derives
  // its own continuous yaw, so this authored start direction is not what the
  // sampler uses. It stays the true start heading for any consumer that reads
  // entity.transform directly.
  const entities = [
    {
      id: 'entity_car',
      asset: 'asset_car_material',
      transform: { position: heroStart, rotation: [0, headingAt(lineRoute, 0), 0], scale: [1, 1, 1] },
      state: { role: 'car', driver: 'hero', wheelRadius: CAR.wheelRadius, wheelbase: CAR.wheelbase, track: CAR.track },
    },
    {
      id: 'entity_rival',
      asset: 'asset_rival_material',
      transform: { position: rivalStart, rotation: [0, headingAt(lineRoute, RIVAL_LEAD), 0], scale: [1, 1, 1] },
      state: { role: 'car', driver: 'rival', wheelRadius: CAR.wheelRadius, wheelbase: CAR.wheelbase, track: CAR.track },
    },
  ];

  // Four genuine perspective cameras. `follow` makes position/target local
  // offsets from the hero car, rotated by its heading (forward = +Z, right = +X),
  // so every camera keeps its relationship to the car through the whole lap.
  const cameras = [
    { id: 'cam_onboard', position: [0, 1.18, 1.15], target: [0, 0.48, 22], fov: 66, follow: 'entity_car' },
    { id: 'cam_chase', position: [0, 2.6, -7.6], target: [0, 0.9, 6], fov: 48, follow: 'entity_car' },
    { id: 'cam_wheel', position: [1.7, 0.6, -2.8], target: [0.85, 0.34, -1.35], fov: 42, follow: 'entity_car' },
    { id: 'cam_wide', position: [-8.5, 5.5, -9.5], target: [0, 0.9, 1.5], fov: 42, follow: 'entity_car' },
  ];

  return {
    id: 'world_circuit',
    revision: 1,
    units: 'meters',
    coordinates: 'right-handed-y-up',
    fps,
    frames: WORLD_FRAMES,
    entities,
    trajectories: [
      buildTrajectory('traj_hero', 'entity_car', route, lineRoute, 0),
      buildTrajectory('traj_rival', 'entity_rival', route, lineRoute, RIVAL_LEAD),
    ],
    cameras,
  };
}

// --- audio ------------------------------------------------------------------
function buildAudio(framesToSamples, fps) {
  const audio = [];
  const assets = [];
  const signals = [];
  const seen = new Set();
  const toSamples = frames => framesToSamples(frames, fps, SAMPLE_RATE, 'nearest');
  const add = (id, frequency, waveform, startFrame, lenFrames, gain, fadeInFrames, fadeOutFrames) => {
    if (seen.has(id)) throw new Error(`duplicate audio id ${id}`);
    let start = toSamples(startFrame);
    let end = toSamples(startFrame + lenFrames);
    if (start >= toSamples(TOTAL_FRAMES)) return;
    if (end > toSamples(TOTAL_FRAMES)) end = toSamples(TOTAL_FRAMES);
    const durationSamples = end - start;
    if (durationSamples <= 0) return;
    let fadeIn = Math.max(0, toSamples(fadeInFrames));
    let fadeOut = Math.max(0, toSamples(fadeOutFrames));
    if (fadeIn + fadeOut > durationSamples) {
      const k = durationSamples / (fadeIn + fadeOut);
      fadeIn = Math.floor(fadeIn * k);
      fadeOut = durationSamples - fadeIn;
    }
    seen.add(id);
    const assetId = `sig_${id}`;
    const signal = makeSignalAsset({
      id: assetId,
      path: `${id}.wav`,
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      samples: durationSamples,
      frequency,
      waveform,
    });
    assets.push(signal.asset);
    signals.push({ path: signal.asset.path, bytes: signal.bytes });
    audio.push({
      id,
      kind: 'asset',
      asset: assetId,
      inSample: 0,
      startSample: start,
      durationSamples,
      gain,
      fadeInSamples: fadeIn,
      fadeOutSamples: fadeOut,
    });
  };

  // 1. A cut accent + tick on every shot boundary (same action, new camera).
  SHOTS.forEach((shot, i) => {
    add(`cut_accent_${String(i).padStart(2, '0')}`, 92.5, 'sine', shot.startFrame, BEAT_FRAMES, 0.3, 1, BEAT_FRAMES);
    add(
      `cut_tick_${String(i).padStart(2, '0')}`,
      700 * (i + 1),
      'triangle',
      shot.startFrame,
      Math.max(1, Math.round(BEAT_FRAMES / 2)),
      0.15,
      1,
      Math.round(BEAT_FRAMES / 2),
    );
  });

  // 2. A continuous bed and a low engine drone under each shot.
  SHOTS.forEach((shot, i) => {
    add(
      `pad_${String(i).padStart(2, '0')}`,
      55 + i * 12,
      'sine',
      shot.startFrame,
      shot.frames,
      0.055,
      Math.round(shot.frames * 0.25),
      Math.round(shot.frames * 0.4),
    );
    add(
      `engine_${String(i).padStart(2, '0')}`,
      66 + i * 5,
      'triangle',
      shot.startFrame,
      shot.frames,
      0.07,
      Math.round(shot.frames * 0.2),
      Math.round(shot.frames * 0.3),
    );
  });

  // 3. One tick per beat across the whole rough cut.
  const beats = Math.floor((TOTAL_FRAMES - 1) / BEAT_FRAMES);
  const PENTA = [523.25, 587.33, 659.25, 783.99, 880.0];
  for (let b = 1; b < beats; b++) {
    add(
      `beat_${String(b).padStart(3, '0')}`,
      PENTA[b % PENTA.length],
      b % 2 === 0 ? 'triangle' : 'sine',
      b * BEAT_FRAMES,
      Math.max(1, Math.round(BEAT_FRAMES * 0.3)),
      0.09,
      1,
      Math.round(BEAT_FRAMES * 0.26),
    );
  }

  // 4. A final accent landing on the last beat.
  add(
    'accent_final',
    PENTA[0] * 2,
    'triangle',
    TOTAL_FRAMES - BEAT_FRAMES,
    BEAT_FRAMES,
    0.2,
    1,
    Math.round(BEAT_FRAMES * 0.8),
  );

  return { audio, assets, signals };
}

// --- project ----------------------------------------------------------------
function look(id, description) {
  return { id, description };
}

function baseParams(lookId, label, palette) {
  return {
    label,
    look: lookId,
    palette,
    route: CONTROL_POINTS,
    roadWidth: ROAD_WIDTH,
    shoulderWidth: SHOULDER_WIDTH,
    worldFrames: WORLD_FRAMES,
    fps: { numerator: FPS, denominator: 1 },
    units: 'meters',
    coordinates: 'right-handed-y-up',
    car: CAR,
    rivalLead: RIVAL_LEAD,
  };
}

// Declared Source order is intentional: the THIRD Source (`src_wide`) is the
// technical-study coverage and is the one that declares a scoped
// `bindingOverrides.car_material`, so exactly the hero car's material Asset is
// swapped for that camera while the rival keeps its own livery.
const SOURCE_SPECS = [
  { id: 'src_onboard', camera: 'cam_onboard', look: 'cel_race', label: 'ONBOARD · cel', palette: CEL, seed: SEED },
  { id: 'src_chase', camera: 'cam_chase', look: 'cel_race', label: 'CHASE · cel', palette: CEL, seed: SEED + 1 },
  {
    id: 'src_wide',
    camera: 'cam_wide',
    look: 'tech_study',
    label: 'WIDE · technical study',
    palette: TECH,
    seed: SEED + 2,
    bindingOverrides: { car_material: 'asset_car_material_technical' },
  },
  {
    id: 'src_wheel',
    camera: 'cam_wheel',
    look: 'cel_race',
    label: 'WHEEL · cel close-up',
    palette: CEL,
    seed: SEED + 3,
  },
];

const SOURCE_RESOURCES = ['vendor/three.module.js', 'vendor/three.core.js', 'vendor/LICENSE'];

function buildProject(id, framesToSamples) {
  const fps = { numerator: FPS, denominator: 1 };
  const sound = buildAudio(framesToSamples, fps);
  const world = buildWorld(fps, routeLength(ROUTE));

  const sources = SOURCE_SPECS.map(spec => ({
    id: spec.id,
    kind: 'browser',

    output: 'picture',

    world: { id: world.id, camera: spec.camera, mode: 'drive', startFrame: 0 },
    entry: 'race.html',
    resources: SOURCE_RESOURCES,
    bindings: ['car_material', 'rival_material'],
    ...(spec.bindingOverrides ? { bindingOverrides: spec.bindingOverrides } : {}),
    params: baseParams(spec.look, spec.label, spec.palette),
    seed: spec.seed,
    frames: WORLD_FRAMES,
  }));

  const shotIntent = {
    shot_grid:
      'Onboard camera sits over the hero cockpit: the road ribbon and the lead rival unspool down the opening straight.',
    shot_chase:
      'Chase camera trails the hero car, reading the sculpted body, spinning wheels and the rival ahead through the first complex.',
    shot_wheel:
      'Close-up camera glues itself just outside the rear-right wheel, so the frame-driven wheel spin dominates the corner.',
    shot_wide:
      'High following camera in the metallic technical study reveals both cars and the returning circuit; the rival keeps its authored lead.',
  };
  const shots = SHOTS.map(shot => ({
    id: shot.id,
    scene: 'scene_race',
    look: shot.look,
    intent: shotIntent[shot.id],
    targetFrames: shot.frames,
  }));

  const placements = SHOTS.map(shot => ({
    id: 'pl_' + shot.id.replace(/^shot_/, ''),
    shot: shot.id,
    source: shot.source,
    inFrame: shot.inFrame,
    outFrame: shot.inFrame + shot.frames,
    startFrame: shot.startFrame,
    audio: 'mute',
  }));

  const project = {
    schemaVersion: 1,
    id,
    revision: 1,
    title: 'CIRCUIT RUN — code-native WebGL race study',
    direction: {
      intent:
        'A twelve-second, code-native racing study: two cars on one closed circuit, covered by four cameras over a single shared World interval. The spatial truth ' +
        'is one persistent World (meters, right-handed y-up, 30 fps, 360 frames) that owns the closed route, the two car entities, two phase-offset trajectories and ' +
        'four real perspective cameras; entities reference Project Assets (each car references its own original vehicle-material JSON) and the World keeps no asset ' +
        'library of its own. Four World Sources all cover the SAME interval [0,360) but bind to a different camera — onboard, chase, a rear-wheel close-up and a high ' +
        'wide — so one action is genuinely re-covered, and every Source renders a real THREE.WebGLRenderer. The piece is deliberately code-native and stylized, not ' +
        'photoreal: the cel_race Look uses toon banding, flat saturated livery and a graphic rim, while the tech_study wide uses a procedural studio environment and ' +
        "metallic materials as an explicit technical study. The third Source declares a scoped bindingOverrides.car_material that swaps only the hero car's " +
        'vehicle-material Asset for a technical variant, so the Look change is a real targeted bindings change and the rival keeps its own livery. This is a ' +
        'first-pass ROUGH CUT: four shots at [0,90), [90,174), [174,252) and [252,360) read different in/out ranges of the shared 360-frame Sources, each leaving ' +
        'the available handles (the opening has no head handle, the ending no tail handle), so in-bounds trim or accepted Take selection requires no capture. Every pixel is drawn procedurally by three.js from the runtime World snapshot ' +
        'and the vendored MIT engine; no generative model, no reference material and no external media is used. Audio is generated PCM signal assets on rational frame ' +
        'boundaries.',
      looks: [
        look(
          'cel_race',
          'Cel-shaded anime race coverage: a deep violet field, graphic toon banding, a saturated cyan hero car and a warm amber rival, lit by a cool key with a hot magenta rim.',
        ),
        look(
          'tech_study',
          'Metallic technical study: a near-black cool studio, a procedural environment reflection, and a desaturated metal hero body — an intentional design read, never a photoreal claim.',
        ),
      ],
      transitions: [
        {
          from: 'cel_race',
          to: 'tech_study',
          intent:
            'Planned look change from wheel detail to high following coverage on consecutive World frames. The technical materials are a deliberate style study, not a photoreal wheel match cut or an overtake.',
        },
      ],
    },
    assets: [
      ...MATERIALS.map(material => ({
        id: material.id,
        revision: 1,
        path: material.path,
        sha256: sha256(jsonText(material.json)),
        type: 'code',
        rights: MATERIAL_RIGHTS,
        simulated: false,
      })),
      ...sound.assets,
      ...[THREE_FILES.module, THREE_FILES.core, THREE_FILES.license].map(file => ({
        id:
          'asset_' +
          basename(file.dest)
            .replace(/[^a-z0-9]+/gi, '_')
            .toLowerCase(),
        revision: 1,
        path: file.dest,
        sha256: file.sha256,
        type: 'code',
        rights: THREE_RIGHTS,
        simulated: false,
      })),
    ],
    bindings: {
      car_material: 'asset_car_material',
      rival_material: 'asset_rival_material',
    },
    worlds: [world],
    sources,
    composition: {
      output: { width: WIDTH, height: HEIGHT, fps, sampleRate: SAMPLE_RATE, channels: CHANNELS },
      scenes: [
        {
          id: 'scene_race',
          description:
            'One continuous circuit run by two cars, covered by four camera positions over the same 360-frame World interval.',
        },
      ],
      shots,
      placements,
      transitions: [],
      audio: sound.audio,
      subtitles: [
        {
          id: 'sub_01',
          text: 'CIRCUIT RUN — onboard, cel coverage',
          startFrame: 4,
          endFrame: 86,
          fontSize: 20,
          color: '#c7b6ff',
        },
        {
          id: 'sub_02',
          text: 'chase camera · shared World interval',
          startFrame: 94,
          endFrame: 170,
          fontSize: 20,
          color: '#c7b6ff',
        },
        {
          id: 'sub_03',
          text: 'rear wheel · frame-driven spin',
          startFrame: 178,
          endFrame: 248,
          fontSize: 20,
          color: '#c7b6ff',
        },
        {
          id: 'sub_04',
          text: 'technical study · wide',
          startFrame: 256,
          endFrame: 354,
          fontSize: 20,
          color: '#cfe9ff',
        },
      ],
    },
  };
  return { project, signals: sound.signals };
}

function slugToId(name) {
  const cleaned =
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'study';
  const safe = /^[a-z0-9]/.test(cleaned) ? cleaned : 'p-' + cleaned;
  return ('race-' + safe).slice(0, 96);
}

/**
 * The three.js distribution is resolved by tests/fixtures/authoring/lib/three-vendor.mjs: the
 * installed `three` dependency by default, or the explicit directory argument as
 * an override. Every adopted byte is verified before anything is written.
 */
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    fail('usage: node tests/fixtures/authoring/create-race.mjs <new-project-directory> [<three-directory>]');
  }
  if (args.length > 2)
    fail(
      'expected one or two arguments (new project directory, optional explicit three.js directory); got ' + args.length,
    );
  const dirArg = args[0];
  const threeArg = args[1]; // optional explicit override; default = installed `three`
  if (!(await exists(SOURCE_HTML))) fail('race.html is missing next to this script (' + SOURCE_HTML + ')');

  const runtime = await loadRuntime();
  const { validateProject, framesToSamples } = runtime ?? {};
  if (typeof validateProject !== 'function' || typeof framesToSamples !== 'function') {
    fail('the built runtime is missing required exports (validateProject, framesToSamples); run `npm run build`');
  }

  let verified;
  try {
    verified = await loadVerifiedThree(threeArg);
  } catch (error) {
    fail(messageOf(error));
  }

  const dir = resolve(dirArg);
  const projectJson = join(dir, 'project.json');
  const htmlDest = join(dir, 'race.html');
  const materialDest = material => join(dir, ...material.path.split('/'));
  const vendorDest = file => join(dir, ...file.dest.split('/'));
  for (const path of [
    projectJson,
    htmlDest,
    ...MATERIALS.map(materialDest),
    ...verified.map(vendorDest),
  ]) {
    if (await exists(path)) fail('refusing to overwrite existing ' + path);
  }

  const id = slugToId(basename(dir));
  const { project, signals } = buildProject(id, framesToSamples);
  try {
    validateProject(project);
  } catch (error) {
    fail('generated project failed validation: ' + messageOf(error));
  }

  await mkdir(dir, { recursive: true });
  await mkdir(join(dir, 'assets'), { recursive: true });
  await mkdir(join(dir, 'vendor'), { recursive: true });

  // Vendor ONLY the two verified ES-module bundles and the license, verbatim.
  for (const file of verified) {
    await writeFile(vendorDest(file), file.bytes, { flag: 'wx' });
  }
  for (const material of MATERIALS) {
    await writeFile(materialDest(material), jsonText(material.json), { encoding: 'utf8', flag: 'wx' });
  }
  await copyFile(SOURCE_HTML, htmlDest, constants.COPYFILE_EXCL);
  for (const signal of signals) await writeFile(join(dir, signal.path), signal.bytes, { flag: 'wx' });
  await writeFile(projectJson, jsonText(project), { encoding: 'utf8', flag: 'wx' });

  const seconds = TOTAL_FRAMES / FPS;
  const handles = SHOTS.map(shot => {
    const head = shot.inFrame;
    const tail = WORLD_FRAMES - (shot.inFrame + shot.frames);
    return `${shot.id}: in ${shot.inFrame}–${shot.inFrame + shot.frames} of ${WORLD_FRAMES} (head ${head}, tail ${tail})`;
  });
  console.log('created project: ' + projectJson);
  console.log('  title        : ' + project.title);
  console.log(
    '  output       : ' +
      WIDTH +
      'x' +
      HEIGHT +
      ' @ ' +
      FPS +
      'fps, ' +
      seconds.toFixed(2) +
      's (' +
      TOTAL_FRAMES +
      ' frames)',
  );
  console.log(
    '  world        : ' +
      project.worlds[0].id +
      ' rev ' +
      project.worlds[0].revision +
      ', ' +
      project.worlds[0].entities.length +
      ' entities, ' +
      project.worlds[0].trajectories.length +
      ' trajectories, ' +
      project.worlds[0].cameras.length +
      ' cameras, ' +
      WORLD_FRAMES +
      ' frames @ ' +
      project.worlds[0].units +
      '/' +
      project.worlds[0].coordinates,
  );
  console.log('  vendored     : three.js r186 (npm three@' + THREE_VERSION + ') MIT — copied verbatim, hash-verified:');
  for (const file of verified) console.log('                 ' + file.dest + '  sha256 ' + file.actual);
  console.log(
    '  assets       : ' +
      project.assets.length +
      ' assets (' +
      MATERIALS.length +
      ' original material JSON @ ' +
      MATERIAL_RIGHTS.license +
      ', ' +
      verified.length +
      ' vendored engine files @ ' +
      THREE_RIGHTS.license +
      ' + real sha)',
  );
  console.log(
    '  bindings     : ' +
      Object.entries(project.bindings)
        .map(([k, v]) => k + ' -> ' + v)
        .join(', '),
  );
  console.log(
    '  sources      : ' +
      project.sources.length +
      ' world sources (all entry race.html, World [0,' +
      WORLD_FRAMES +
      ') under a different camera)',
  );
  const overridden = project.sources.filter(source => source.bindingOverrides);
  overridden.forEach(source =>
    console.log(
      '                 scoped override: ' +
        source.id +
        ' camera ' +
        source.camera +
        ' ' +
        JSON.stringify(source.bindingOverrides),
    ),
  );
  console.log(
    '  scene/shots  : 1 scene, ' +
      project.composition.shots.length +
      ' shots, ' +
      project.composition.placements.length +
      ' placements over frames [0,' +
      TOTAL_FRAMES +
      ')',
  );
  console.log('  handles      :');
  handles.forEach(line => console.log('                 ' + line));
  console.log(
    '  audio        : ' +
      project.composition.audio.length +
      ' PCM signal clips @ ' +
      SAMPLE_RATE +
      'Hz stereo; ' +
      project.composition.subtitles.length +
      ' captions',
  );
  console.log('');
  console.log('notes (this is a rough cut; nothing is auto-approved):');
  console.log(
    '  - Picture Sources use the existing `browser` kind with a World. race.html imports the vendored bundle via a relative path and is a real WebGLRenderer.',
  );
  console.log(
    '  - The three.js build comes from the installed `three` dependency (or an explicit override directory) and is NOT modified; nothing else from it is copied (no addons). Only these three files are adopted, verbatim and hash-verified.',
  );
  console.log('next steps:');
  console.log('  1. build + review the rough cut:');
  console.log('       npm run build');
  console.log('       node dist/src/cli.js doctor');
  console.log('       node dist/src/cli.js build ' + dir);
  console.log('       node dist/src/cli.js status ' + dir);
  console.log(
    '  2. then edit on this same project state — trim placement in/out frames within the existing handles, or select a different Take for a shot — and rebuild only what changed.',
  );
}

main().catch(err => fail(messageOf(err)));
