#!/usr/bin/env node
/*
 * Viscraft technical fixture: create a World-backed, multi-camera, code-native ROUGH CUT
 * project from scratch.
 *
 *   node tests/fixtures/authoring/create-world.mjs <new-project-directory>
 *
 * What this creates (and deliberately does NOT do):
 *
 *   - ONE persistent World (`world_signal`) expressed in meters on a
 *     right-handed, y-up frame at 30 fps for 240 frames. The World owns the
 *     spatial truth of the piece: a seven-point route, five entities
 *     (a courier packet, a pursuing drone, three gates), two trajectories and
 *     three genuine perspective cameras.
 *   - Entities reference Project Assets ONLY. The three image assets
 *     (`courier.svg`, `gate.svg`, `drone.svg`) are original, code-authored SVGs
 *     written BY THIS SCRIPT into the new project, each registered with its real
 *     sha256, explicit rights and no simulation flag. The World does not own a
 *     second asset library: it holds entity instances that point at those
 *     Project Assets.
 *   - THREE `browser` picture Sources with World bindings, covering the SAME interval
 *     [0, 240) but bound to a DIFFERENT camera, so the same world range is seen
 *     under three camera positions. Each Source renders `world.html`, a plain
 *     CPU-canvas rasterizer that consumes the runtime's per-frame
 *     `window.__viscraftWorld` snapshot (sampled transforms + resolved camera).
 *   - A first-pass ROUGH CUT: three shots placed at [0,75), [75,150) and
 *     [150,210) reading DIFFERENT source in/out ranges of the shared World
 *     range. Every placement reads a sub-interval of its 240-frame Source, so
 *     real head/tail handles remain for a later trim without regenerating.
 *   - Layered audio (three bed pads, cut accents, per-beat ticks, a final
 *     accent) written as real PCM signal files on rational frame boundaries,
 *     plus three burned-in captions. No captured WebAudio.
 *
 * Authoring state: this writes the ROUGH project only. There is exactly ONE
 * authored state here; a later revision can trim placements / select a Take on
 * the same state (no `rough`/`final` duplicate-project switch). The console
 * brief states the next steps; nothing is orchestrated or auto-approved here.
 *
 * No external media, model, network, weight, API or payment is used. The runtime
 * must be built (`npm run build`); this script imports its canonical
 * `validateProject` and `framesToSamples` rather than duplicating any schema or
 * clock conversion. It refuses to overwrite an existing project.json,
 * world.html or any generated asset path.
 */
import { access, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { makeSignalAsset } from './lib/audio-fixture.mjs';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_HTML = join(HERE, 'world.html');

// --- fixed smoke configuration ----------------------------------------------
const WIDTH = 640;
const HEIGHT = 360;
const FPS = 30;
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const WORLD_FRAMES = 240; // 8 s of persistent World time
const BEAT_FRAMES = 15; // 120 BPM at 30 fps
const SEED = 20261008;

// Shared route (meters, right-handed y-up). The World trajectory, the renderer's
// decorative lane and the gate placement all derive from this single array, so
// every camera is genuinely looking at the same spatial truth.
const ROUTE = [
  [-15.0, 1.1, -4.0],
  [-9.0, 1.3, -1.5],
  [-4.0, 1.5, 1.5],
  [1.0, 1.6, 2.6],
  [6.0, 1.5, 0.6],
  [11.0, 1.7, -2.2],
  [16.0, 1.9, -0.6],
];
const GATE_INDICES = [1, 3, 5];
const GATES = GATE_INDICES.map(i => ROUTE[i]);
const DRONE_OFFSET = [-3.4, 3.0, 2.4];
const KEYFRAME_FRAMES = [0, 40, 80, 120, 160, 200, WORLD_FRAMES - 1]; // strictly increasing, < WORLD_FRAMES

// Two Looks: the intent is a real coverage change between the ground coverage
// (cool neon) and the closing orbit (warm amber) — not an accidental drift.
const COOL = {
  bgTop: '#050a18',
  bgBottom: '#0b1a2e',
  grid: '#12314f',
  route: '#2f6d9c',
  courier: '#7cf0ff',
  gate: '#4dabf7',
  gate2: '#b28dff',
  drone: '#ff6ec7',
  hud: '#8fb6d6',
};
const WARM = {
  bgTop: '#160607',
  bgBottom: '#2a1008',
  grid: '#4a2410',
  route: '#8a4a1e',
  courier: '#ffd166',
  gate: '#ff8f5a',
  gate2: '#ff5a7a',
  drone: '#ff5ad1',
  hud: '#e0b184',
};

// Cut grid of the rough cut. Each shot reads a different sub-interval of the
// shared [0,240) World range, so the same action is re-covered from a new angle
// and every Source keeps real handles outside the placed range.
const SHOTS = [
  {
    id: 'shot_chase',
    source: 'src_chase',
    camera: 'cam_chase',
    look: 'signal_chase',
    startFrame: 0,
    inFrame: 0,
    frames: 75,
  },
  {
    id: 'shot_low',
    source: 'src_low',
    camera: 'cam_low',
    look: 'signal_chase',
    startFrame: 75,
    inFrame: 60,
    frames: 75,
  },
  {
    id: 'shot_orbit',
    source: 'src_orbit',
    camera: 'cam_orbit',
    look: 'signal_orbit',
    startFrame: 150,
    inFrame: 140,
    frames: 60,
  },
];
const TOTAL_FRAMES = SHOTS[SHOTS.length - 1].startFrame + SHOTS[SHOTS.length - 1].frames; // 210 → 7 s

// --- original SVG assets (authored here, not imported) ----------------------
const ASSETS = [
  {
    id: 'asset_courier',
    binding: 'courier',
    path: 'assets/courier.svg',
    svg:
      [
        '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">',
        '  <g fill="none" stroke="#eaf6ff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">',
        '    <path d="M20 18 L44 32 L20 46 Z" fill="#eaf6ff" stroke="none"/>',
        '    <path d="M46 26 H56 M46 32 H58 M46 38 H56"/>',
        '    <path d="M10 22 H20 M8 32 H18 M10 42 H20"/>',
        '  </g>',
        '</svg>',
      ].join('\n') + '\n',
  },
  {
    id: 'asset_gate',
    binding: 'gate',
    path: 'assets/gate.svg',
    svg:
      [
        '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">',
        '  <g fill="none" stroke="#eaf6ff" stroke-width="5">',
        '    <circle cx="32" cy="32" r="19"/>',
        '    <circle cx="32" cy="32" r="9" stroke-width="3"/>',
        '    <path d="M32 3 V13 M32 51 V61 M3 32 H13 M51 32 H61"/>',
        '  </g>',
        '</svg>',
      ].join('\n') + '\n',
  },
  {
    id: 'asset_drone',
    binding: 'drone',
    path: 'assets/drone.svg',
    svg:
      [
        '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">',
        '  <path fill="#eaf6ff" fill-rule="evenodd"',
        '        d="M32 6 L54 32 L32 58 L10 32 Z M32 24 L42 32 L32 40 L22 32 Z"/>',
        '</svg>',
      ].join('\n') + '\n',
  },
];
const RIGHTS = {
  origin: 'original: authored for this example by tests/fixtures/authoring/create-world.mjs',
  license: 'CC0-1.0',
  redistributable: true,
};

function fail(message) {
  console.error('create-world: ' + message);
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
function sha256(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/** Load the single canonical runtime. No fallback schema or clock conversion. */
async function loadRuntime() {
  try {
    return await import(new URL('../../../dist/src/index.js', import.meta.url));
  } catch (error) {
    fail('the Viscraft runtime is not built or not importable; run `npm run build` first (' + messageOf(error) + ')');
  }
}

// --- world ------------------------------------------------------------------
function offsetPoint(p, d) {
  return [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
}
function yawAt(i) {
  const a = ROUTE[Math.max(0, i - 1)];
  const b = ROUTE[Math.min(ROUTE.length - 1, i + 1)];
  return Math.atan2(b[2] - a[2], b[0] - a[0]);
}
function buildWorld(fps) {
  const entities = [
    {
      id: 'entity_courier',
      asset: 'asset_courier',
      transform: { position: ROUTE[0], rotation: [0, yawAt(0), 0], scale: [1, 1, 1] },
      state: { role: 'courier', linked: true, signal: 0.92 },
    },
    {
      id: 'entity_drone',
      asset: 'asset_drone',
      transform: { position: offsetPoint(ROUTE[0], DRONE_OFFSET), rotation: [0, 0, 0], scale: [1, 1, 1] },
      state: { role: 'drone', tracking: 'entity_courier' },
    },
  ].concat(
    GATES.map((g, i) => ({
      id: 'entity_gate_' + String.fromCharCode(97 + i),
      asset: 'asset_gate',
      transform: { position: g, rotation: [0, 0, 0], scale: [1, 1, 1] },
      state: { role: 'gate', index: i, armed: true },
    })),
  );

  const trajectories = [
    {
      id: 'traj_courier',
      entity: 'entity_courier',
      keyframes: ROUTE.map((p, i) => ({ frame: KEYFRAME_FRAMES[i], position: p, rotation: [0, yawAt(i), 0] })),
    },
    {
      id: 'traj_drone',
      entity: 'entity_drone',
      keyframes: ROUTE.map((p, i) => ({ frame: KEYFRAME_FRAMES[i], position: offsetPoint(p, DRONE_OFFSET) })),
    },
  ];

  // Three genuine perspective cameras. `position`/`target` are the follow
  // offsets resolved by the runtime against the followed courier; `fov` is a
  // real vertical field of view in degrees. The renderer only projects.
  const cameras = [
    { id: 'cam_chase', position: [-6.6, 3.4, -6.6], target: [3.0, 0.6, 0.0], fov: 55, follow: 'entity_courier' },
    { id: 'cam_low', position: [-2.2, 0.7, -7.6], target: [2.4, 1.0, 0.0], fov: 66, follow: 'entity_courier' },
    { id: 'cam_orbit', position: [-3.2, 11.0, 11.5], target: [1.6, 0.0, 0.0], fov: 46, follow: 'entity_courier' },
  ];

  return {
    id: 'world_signal',
    revision: 1,
    units: 'meters',
    coordinates: 'right-handed-y-up',
    fps,
    frames: WORLD_FRAMES,
    entities,
    trajectories,
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

  // 1. A cut accent on every shot boundary (same world action, new camera).
  SHOTS.forEach((shot, i) => {
    add(`cut_low_${String(i).padStart(2, '0')}`, 82.41, 'sine', shot.startFrame, BEAT_FRAMES, 0.3, 1, BEAT_FRAMES);
    add(
      `cut_tick_${String(i).padStart(2, '0')}`,
      660 * (i + 1),
      'triangle',
      shot.startFrame,
      Math.max(1, Math.round(BEAT_FRAMES / 2)),
      0.16,
      1,
      Math.round(BEAT_FRAMES / 2),
    );
  });

  // 2. A continuous bed under each shot, so the piece is layered, not just clicks.
  SHOTS.forEach((shot, i) => {
    add(
      `pad_${String(i).padStart(2, '0')}`,
      55 + i * 14,
      'sine',
      shot.startFrame,
      shot.frames,
      0.06,
      Math.round(shot.frames * 0.25),
      Math.round(shot.frames * 0.4),
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
      Math.max(1, Math.round(BEAT_FRAMES * 0.32)),
      0.1,
      1,
      Math.round(BEAT_FRAMES * 0.28),
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

function buildProject(id, framesToSamples) {
  const fps = { numerator: FPS, denominator: 1 };
  const sound = buildAudio(framesToSamples, fps);
  const world = buildWorld(fps);
  const worldParams = (label, palette) => ({
    label,
    palette,
    route: ROUTE,
    gates: GATES,
    worldFrames: WORLD_FRAMES,
    units: 'meters',
    coordinates: 'right-handed-y-up',
  });

  const sources = [
    { id: 'src_chase', camera: 'cam_chase', label: 'CHASE · follow', palette: COOL, seed: SEED },
    { id: 'src_low', camera: 'cam_low', label: 'LOW · follow', palette: COOL, seed: SEED + 1 },
    { id: 'src_orbit', camera: 'cam_orbit', label: 'ORBIT · follow', palette: WARM, seed: SEED + 2 },
  ].map(spec => ({
    id: spec.id,
    kind: 'browser',

    output: 'picture',

    world: { id: world.id, camera: spec.camera, mode: 'drive', startFrame: 0 },
    entry: 'world.html',
    resources: [],
    bindings: ['courier', 'gate', 'drone'],
    params: worldParams(spec.label, spec.palette),
    seed: spec.seed,
    frames: WORLD_FRAMES,
  }));

  const shots = SHOTS.map(shot => ({
    id: shot.id,
    scene: 'scene_run',
    look: shot.look,
    intent:
      shot.id === 'shot_chase'
        ? 'Chase camera threads the lane behind the courier: gates swell and sweep past as the packet drives the route.'
        : shot.id === 'shot_low'
          ? 'Low trackside camera catches the courier and the drone crossing the same World interval from near ground level.'
          : 'High orbit camera closes the run on the same action, framing the full route and the third gate crossing.',
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
    title: 'SIGNAL RUN — World multi-camera rough cut',
    direction: {
      intent:
        'A seven-second, code-native "signal run": one abstract courier packet drives a seven-point route through three gate rings ' +
        'while a tracking drone shadows it. The spatial truth is a single persistent World (meters, right-handed y-up, 30 fps, 240 frames) that owns the ' +
        'route, the five entities, two trajectories and three real perspective cameras; entities reference Project Assets and the World keeps no asset library ' +
        'of its own. Three World Sources all cover the SAME World interval [0,240) but bind to a different camera, so the same action is genuinely seen under ' +
        'three camera positions. This is a first-pass ROUGH CUT: three shots at [0,75), [75,150) and [150,210) read different source in/out ranges of that ' +
        'shared range, each leaving real head/tail handles (the Sources are 240 frames and are only trimmed into the edit) so a later trim or Take selection ' +
        'does not regenerate anything. Ground coverage uses the cool `signal_chase` look (night-run indigo/cyan); the closing orbit uses the warm ' +
        '`signal_orbit` look (amber/gold) as an intentional coverage change. A match-cut transition is declared as the planned edit for the third gate pass; ' +
        'the rough cut itself is hard cuts and has not yet been refined. Every pixel is drawn procedurally on a 2D canvas from the runtime World snapshot — ' +
        'flat vector, no generative model, no reference material and no external media. Audio is generated PCM signal assets on rational frame boundaries.',
      looks: [
        look(
          'signal_chase',
          'Cool night-run coverage: deep indigo corridor, cyan route lane, a bright cyan courier packet, blue/violet gates and a magenta drone.',
        ),
        look(
          'signal_orbit',
          'Warm closing coverage: maroon corridor, amber route lane, a gold courier packet and orange/rose gates as the run resolves from above.',
        ),
      ],
      transitions: [
        {
          from: 'signal_chase',
          to: 'signal_orbit',
          intent:
            'Planned match cut on the third gate pass: the low camera and the high orbit camera both frame the same gate crossing, so the cut lands on the packet threading the ring.',
        },
      ],
    },
    assets: [
      ...ASSETS.map(asset => ({
        id: asset.id,
        revision: 1,
        path: asset.path,
        sha256: sha256(asset.svg),
        type: 'image',
        rights: RIGHTS,
        simulated: false,
      })),
      ...sound.assets,
    ],
    bindings: Object.fromEntries(ASSETS.map(asset => [asset.binding, asset.id])),
    worlds: [world],
    sources,
    composition: {
      output: { width: WIDTH, height: HEIGHT, fps, sampleRate: SAMPLE_RATE, channels: CHANNELS },
      scenes: [
        {
          id: 'scene_run',
          description:
            'One continuous signal run along a seven-point route, covered by three camera positions over the same World interval.',
        },
      ],
      shots,
      placements,
      transitions: [],
      audio: sound.audio,
      subtitles: [
        {
          id: 'sub_01',
          text: 'SIGNAL RUN — courier link established',
          startFrame: 4,
          endFrame: 72,
          fontSize: 22,
          color: '#d8f2ff',
        },
        {
          id: 'sub_02',
          text: 'route locked · three camera positions',
          startFrame: 80,
          endFrame: 148,
          fontSize: 22,
          color: '#d8f2ff',
        },
        { id: 'sub_03', text: 'packet delivered', startFrame: 156, endFrame: 206, fontSize: 22, color: '#ffe6c2' },
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
  return ('world-' + safe).slice(0, 96);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    fail('usage: node tests/fixtures/authoring/create-world.mjs <new-project-directory>');
  }
  if (args.length > 1)
    fail(
      'unexpected extra argument "' +
        args[1] +
        '" (one project directory only; this script authors a single rough state)',
    );
  const dirArg = args[0];

  if (!(await exists(SOURCE_HTML))) fail('world.html is missing next to this script (' + SOURCE_HTML + ')');

  const runtime = await loadRuntime();
  const { validateProject, framesToSamples } = runtime ?? {};
  if (typeof validateProject !== 'function' || typeof framesToSamples !== 'function') {
    fail('the built runtime is missing required exports (validateProject, framesToSamples); run `npm run build`');
  }

  const dir = resolve(dirArg);
  const projectJson = join(dir, 'project.json');
  const htmlDest = join(dir, 'world.html');
  const assetDest = asset => join(dir, ...asset.path.split('/'));
  for (const path of [projectJson, htmlDest, ...ASSETS.map(assetDest)]) {
    if (await exists(path)) fail('refusing to overwrite existing ' + path);
  }

  const id = slugToId(basename(dir));
  const { project, signals } = buildProject(id, framesToSamples);
  try {
    validateProject(project);
  } catch (error) {
    fail('generated project failed validation: ' + messageOf(error));
  }
  for (const signal of signals) {
    if (await exists(join(dir, signal.path))) fail('refusing to overwrite existing ' + join(dir, signal.path));
  }

  await mkdir(dir, { recursive: true });
  await mkdir(join(dir, 'assets'), { recursive: true });
  for (const asset of ASSETS) {
    // Exclusive create: never clobber a file that appeared after the checks above.
    await writeFile(assetDest(asset), asset.svg, { encoding: 'utf8', flag: 'wx' });
  }
  await copyFile(SOURCE_HTML, htmlDest, constants.COPYFILE_EXCL);
  for (const signal of signals) await writeFile(join(dir, signal.path), signal.bytes, { flag: 'wx' });
  await writeFile(projectJson, JSON.stringify(project, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });

  const seconds = TOTAL_FRAMES / FPS;
  const handles = SHOTS.map((shot, i) => {
    const head = shot.inFrame;
    const tail = WORLD_FRAMES - (shot.inFrame + shot.frames);
    return `${shot.id}: in ${shot.inFrame}–${shot.inFrame + shot.frames} of 240 (head ${head}, tail ${tail})`;
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
  console.log(
    '  assets       : ' +
      project.assets.length +
      ' original SVG assets (rights: ' +
      RIGHTS.license +
      ', redistributable) → ' +
      ASSETS.map(a => a.path).join(', '),
  );
  console.log(
    '  sources      : ' +
      project.sources.length +
      ' world sources, entry world.html, each covering World [0,' +
      WORLD_FRAMES +
      ') under a different camera',
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
  console.log('next steps (this is a rough cut; nothing is auto-approved):');
  console.log('  1. build + review the rough cut:');
  console.log('       npm run build');
  console.log('       node dist/src/cli.js doctor');
  console.log('       node dist/src/cli.js build ' + dir);
  console.log('       node dist/src/cli.js status ' + dir);
  console.log(
    '  2. then edit on this same project state — trim placement in/out frames within the existing handles, or select a different Take for a shot — and rebuild only what changed.',
  );
  console.log(
    '  Direction declares a signal_chase → signal_orbit match-cut intent; this fixture Composition uses hard cuts.',
  );
}

main().catch(err => fail(messageOf(err)));
