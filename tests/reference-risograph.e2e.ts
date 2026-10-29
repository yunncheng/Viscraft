/**
 * E2E: the risograph reference — three inks, one ride, local music and Foley.
 *
 * Proves, with the REAL author/Browser/Build path, that:
 *  - `create.mjs` authors two picture Sources plus one music and one Foley
 *    `output: 'sound'` Source per ride; the pictures share one entry/four-module
 *    closure and the shared `action-facts.mjs`, the music and Foley have their
 *    own entries/resources, and the four `kind: 'source'` clips route to the
 *    music/foley buses while the picture placements stay mute;
 *  - the printed picture still comes on press one plate at a time: frame 0 is a
 *    single-blue print, the yellow plate is partially swept at frame 20 and
 *    fully on by frame 30, the pink plate is partially swept at frame 40 and on
 *    by frame 47; the encoded frames are classified by their actual ink, not by
 *    container bytes;
 *  - overprint is visible: dual-ink pixels appear only once the second plate is
 *    gated on, and triple-ink pixels only once the third plate is on; the
 *    halftone screen is a real dot screen;
 *  - the FULL 96-frame arc (~4 s) really decodes for both rides; the 12 Hz
 *    action frames are 56 (riverside bell strike 2.3333 s), 66 (bakery contact
 *    2.75 s = the first 12 Hz step at/after the 2.7 s catch) and 76 (basket stow
 *    3.1667 s = the first step at/after 3.15 s). Those frames are decoded and
 *    handed to the review; the sound attacks at the same times are asserted
 *    with real PCM in reference-risograph-audio.test.ts (pure Node) and
 *    reference-risograph-audio.e2e.ts (real author/Build path);
 *  - rendering is a stateless pure function of the frame (repeat and
 *    shuffled-order samples agree);
 *  - the exported Project accepts a real SCORE-ONLY edit (music changes, the
 *    picture frames and the Foley stem are reused byte-for-byte) and a real
 *    SHARED-FACTS edit that moves the bell target to 2.5 s AND the riverside
 *    yellow gate from 0.75 s to 1.0 s: the picture action frame, the yellow
 *    plate onset, the music stem and the Foley bell onset all move together;
 *    `refreshCodeAsset` records each edit, the original Project/code/earlier
 *    Artifact bytes stay untouched.
 *
 * Engineering samples are 640x360 at 24 fps, 96 frames per ride. They prove the
 * plate/gate/action/audio mechanism, not a listening verdict or the final
 * presentation; the lead opens the actual action-neighbour frames for the look.
 * A failure keeps its temporary directory for diagnosis; success removes it.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { openCodeScene } from '../src/backends/browser/capture.js';
import { buildProject } from '../src/build/build.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { refreshCodeAsset } from '../src/project/code-assets.js';
import { loadProject } from '../src/project/project.js';
import { authorRecipe, sha256 } from './authoring-helpers.js';

const STUDY_DIR = resolve('skills/viscraft/assets/studies/code-visuals/risograph');
const RECIPE = join(STUDY_DIR, 'create.mjs');
const ENTRY = 'risograph-scene.html';
const RESOURCES = ['scene.mjs', 'draw.mjs', 'rider.mjs', 'riso.mjs', 'action-facts.mjs'];
const WIDTH = 640;
const HEIGHT = 360;
const FRAMES = 96;
const FPS = 24;
const SOUND_SAMPLES = (FRAMES / FPS) * 48000;
const FRAME_BYTES = WIDTH * HEIGHT * 3;

function decodeFrames(file: string, count: number): Buffer {
  const result = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostdin', '-i', file, '-frames:v', String(count), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 1 << 27 },
  );
  assert.equal(result.status, 0, `ffmpeg decode failed for ${file}: ${result.stderr?.toString() ?? ''}`);
  return result.stdout;
}

function changedFraction(a: Buffer, b: Buffer): number {
  assert.equal(a.length, b.length, 'compared frames must have the same size');
  let changed = 0;
  for (let i = 0; i < a.length; i += 3) {
    const distance = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (distance > 60) changed++;
  }
  return changed / (a.length / 3);
}

interface InkStats {
  paper: number;
  blue: number;
  yellow: number;
  pink: number;
  dual: number;
  triple: number;
  yellowTransitions: number;
}

/**
 * Classify encoded RGB pixels by the printed ink they actually show.
 *
 * Single inks are the paper multiplied by one spot colour, so yellow-only
 * pixels stay bright red+green with no blue, pink-only pixels keep a strong
 * red-over-green with blue present, and blue-only pixels keep blue above red.
 * Two/three ink overprints multiply down to near-zero channels, which is what
 * `dual`/`triple` count.
 */
function inkStats(pixels: Buffer): InkStats {
  const stats: InkStats = { paper: 0, blue: 0, yellow: 0, pink: 0, dual: 0, triple: 0, yellowTransitions: 0 };
  const mask = new Uint8Array(WIDTH * HEIGHT);
  for (let index = 0; index < WIDTH * HEIGHT; index++) {
    const offset = index * 3;
    const r = pixels[offset];
    const g = pixels[offset + 1];
    const b = pixels[offset + 2];
    if (r > 195 && g > 185 && b > 175) stats.paper++;
    else if (r > 150 && g > 150 && b < 95 && r - b > 80) {
      stats.yellow++;
      mask[index] = 1;
    } else if (r > 150 && g < 130 && b > 95 && r - g > 80) stats.pink++;
    else if (b > 135 && b - r > 60) stats.blue++;
    else if (r < 55 && b < 55 && g > 55) stats.dual++;
    else if (r < 55 && g < 65 && b < 85) stats.triple++;
  }
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH - 1; x++) {
      if (mask[y * WIDTH + x] !== mask[y * WIDTH + x + 1]) stats.yellowTransitions++;
    }
  }
  return stats;
}

function frameOf(decoded: Buffer, index: number): Buffer {
  return decoded.subarray(index * FRAME_BYTES, (index + 1) * FRAME_BYTES);
}

async function renderToBuffer(
  scene: Awaited<ReturnType<typeof openCodeScene>>,
  frame: number,
  variant: 'riverside' | 'bakery',
  destination: string,
  size: { width: number; height: number } = { width: WIDTH, height: HEIGHT },
): Promise<Buffer> {
  await scene.page.evaluate(
    async payload => {
      const v = (globalThis as unknown as Record<string, { render: (a: unknown) => void }>)['viscraft'];
      v.render(payload);
    },
    {
      frame,
      time: frame / FPS,
      fps: FPS,
      width: size.width,
      height: size.height,
      seed: variant === 'riverside' ? 9241 : 9242,
      params: { variant, frames: FRAMES },
      bindings: scene.bindings,
    },
  );
  const file = join(destination, `${variant}-${frame}.png`);
  await scene.page.screenshot({ path: file, type: 'png', captureBeyondViewport: false });
  return Buffer.from(await readFile(file));
}

function pngPixels(file: string): Buffer {
  const result = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostdin', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 1 << 25 },
  );
  assert.equal(result.status, 0, `ffmpeg PNG decode failed for ${file}: ${result.stderr?.toString() ?? ''}`);
  return result.stdout;
}

interface DecodedWav {
  sampleRate: number;
  channels: number;
  frames: number;
  data: Float32Array[];
}

function decodeWav(buffer: Buffer): DecodedWav {
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buffer.toString('ascii', 8, 12), 'WAVE');
  let offset = 12;
  let fmt: { sampleRate: number; channels: number; bits: number } | undefined;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ')
      fmt = {
        sampleRate: buffer.readUInt32LE(body + 4),
        channels: buffer.readUInt16LE(body + 2),
        bits: buffer.readUInt16LE(body + 14),
      };
    else if (id === 'data') {
      assert.equal(dataOffset, -1, 'the stem WAV has exactly one data chunk');
      assert.ok(body + size <= buffer.length, `the stem data chunk (${size} bytes) fits inside ${buffer.length} bytes`);
      dataOffset = body;
      dataLength = size;
    }
    offset = body + size + (size % 2);
  }
  assert.ok(fmt && dataOffset >= 0, 'the stem WAV exposes fmt and data');
  assert.equal(dataLength % (fmt.channels * 2), 0, 'the stem data payload is a whole number of frames');
  assert.equal(dataOffset + dataLength, buffer.length, 'the stem WAV carries exactly its declared data payload');
  const frames = dataLength / (fmt.channels * 2);
  const data = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let channel = 0; channel < fmt.channels; channel++) {
      data[channel][i] = buffer.readInt16LE(dataOffset + (i * fmt.channels + channel) * 2) / 32768;
    }
  }
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, frames, data };
}

function peakBetween(wav: DecodedWav, start: number, end: number): number {
  const from = Math.max(0, Math.floor(start * wav.sampleRate));
  const to = Math.min(wav.frames, Math.ceil(end * wav.sampleRate));
  let peak = 0;
  for (const channel of wav.data) for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(channel[i]));
  return peak;
}

// ---------------------------------------------------------------------------
// Author + real Build: the two rides and the printed press stages.
// ---------------------------------------------------------------------------
test('risograph: author/build prints blue, then yellow, then pink from one plate', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-riso-build-'));
  const root = join(parent, 'riso');
  let succeeded = false;
  try {
    await authorRecipe({
      recipe: RECIPE,
      root,
      cwd: parent,
      options: { width: WIDTH, height: HEIGHT, frames: FRAMES },
    });

    const project = await loadProject(root);
    const composition = project.composition;
    assert.ok(composition, 'the authored project has a composition');
    assert.equal(project.sources.length, 6, 'two picture Sources plus music/Foley per ride');
    const pictures = project.sources.filter(source => source.kind === 'browser' && source.output === 'picture');
    const sounds = project.sources.filter(source => source.kind === 'browser' && source.output === 'sound');
    assert.equal(pictures.length, 2);
    assert.equal(sounds.length, 4);
    assert.deepEqual(
      pictures.map(source => [source.id, source.seed, source.params]),
      [
        ['river-ride', 9241, { variant: 'riverside', frames: FRAMES }],
        ['bakery-catch', 9242, { variant: 'bakery', frames: FRAMES }],
      ],
      'the two rides are the meaningful picture variants',
    );
    for (const source of pictures) {
      assert.equal(source.entry, ENTRY);
      assert.deepEqual(source.resources, RESOURCES, 'both rides share one picture closure');
      assert.equal(source.frames, FRAMES);
    }
    assert.deepEqual(
      sounds.map(source => [source.id, (source as { entry: string }).entry, source.durationSamples]),
      [
        ['river-music', 'risograph-music.html', SOUND_SAMPLES],
        ['bakery-music', 'risograph-music.html', SOUND_SAMPLES],
        ['river-foley', 'risograph-foley.html', SOUND_SAMPLES],
        ['bakery-foley', 'risograph-foley.html', SOUND_SAMPLES],
      ],
      'music and Foley are separate Sources with their own entries',
    );
    assert.deepEqual(
      composition.audio.map(clip => [clip.id, clip.kind, clip.bus, clip.startSample, clip.gain]),
      [
        ['clip-river-music', 'source', 'music', 0, 0.9],
        ['clip-river-foley', 'source', 'foley', 0, 0.55],
        ['clip-bakery-music', 'source', 'music', 192000, 0.9],
        ['clip-bakery-foley', 'source', 'foley', 192000, 0.55],
      ],
      'the four cues are routed to the two buses at the two ride starts',
    );
    assert.deepEqual(composition.mastering, { targetLufs: -16, truePeakDbfs: -1.5 });
    assert.deepEqual(
      project.assets.map(asset => [asset.id, asset.path, asset.type, asset.rights.license]).sort(),
      [
        ['riso_draw', 'draw.mjs', 'code', 'Apache-2.0 AND MIT'],
        ['riso_entry', ENTRY, 'code', 'Apache-2.0'],
        ['riso_facts', 'action-facts.mjs', 'code', 'Apache-2.0'],
        ['riso_foley', 'foley.mjs', 'code', 'Apache-2.0'],
        ['riso_foley_entry', 'risograph-foley.html', 'code', 'Apache-2.0'],
        ['riso_music_entry', 'risograph-music.html', 'code', 'Apache-2.0'],
        ['riso_printer', 'riso.mjs', 'code', 'Apache-2.0 AND MIT'],
        ['riso_rider', 'rider.mjs', 'code', 'Apache-2.0 AND MIT'],
        ['riso_scene', 'scene.mjs', 'code', 'Apache-2.0'],
        ['riso_score', 'score.mjs', 'code', 'Apache-2.0'],
        ['riso_synth', 'synth.mjs', 'code', 'Apache-2.0 AND MIT'],
      ],
      'five picture modules, facts/score/Foley/synth and three entries are registered',
    );
    for (const asset of project.assets) {
      assert.equal(asset.sha256, sha256(await readFile(join(root, asset.path))), `${asset.path} hash is real`);
    }
    assert.match(
      String(project.assets.find(asset => asset.id === 'riso_rider')!.rights.origin),
      /lemo-opuscar/i,
      'the adapted module origin is recorded',
    );
    assert.match(
      String(project.assets.find(asset => asset.id === 'riso_synth')!.rights.origin),
      /lemo-opuscar/i,
      'the copied synth records its upstream origin',
    );
    assert.deepEqual((project.handoff ?? []).map(file => [file.path, file.role]).sort(), [
      ['LICENSES.md', 'license'],
      ['README.md', 'readme'],
      ['THIRD_PARTY_NOTICES.md', 'license'],
    ]);
    assert.match(await readFile(join(root, 'LICENSES.md'), 'utf8'), /MIT License[\s\S]*LemoLab/);
    assert.doesNotMatch(JSON.stringify(project), /\/lustre-data\/|\/root\/|\/tmp\//);

    const built = await buildProject(root);
    assert.equal(built.status, 'succeeded', `the real mixed build must succeed: ${built.error ?? ''}`);
    const final = built.artifacts.find(artifact => artifact.id === built.result!.artifact)!;
    assert.equal(final.media?.frames, FRAMES * 2, 'the programme holds both rides');
    assert.equal(
      built.operations.filter(operation => operation.kind === 'browser').length,
      6,
      'two picture and four sound renders',
    );
    assert.equal(built.operations.filter(operation => operation.kind === 'mix-stem').length, 2, 'music/foley buses');
    assert.equal(built.operations.filter(operation => operation.kind === 'mux-final').length, 1);

    const decoded = decodeFrames(join(root, final.path), FRAMES * 2);
    assert.equal(decoded.length, FRAME_BYTES * FRAMES * 2, 'every authored frame decodes');

    const singleBlue = inkStats(frameOf(decoded, 0));
    const yellowSweeping = inkStats(frameOf(decoded, 20));
    const yellowOn = inkStats(frameOf(decoded, 30));
    const pinkSweeping = inkStats(frameOf(decoded, 40));
    const allOn = inkStats(frameOf(decoded, 47));

    // Frame 0 is a complete single-blue print: the other plates are gated off.
    assert.ok(singleBlue.blue > 200, `blue ink is really printed at frame 0 (${singleBlue.blue} px)`);
    assert.ok(singleBlue.yellow < 40, `yellow is not on press at frame 0 (${singleBlue.yellow} px)`);
    assert.ok(singleBlue.pink < 40, `pink is not on press at frame 0 (${singleBlue.pink} px)`);
    assert.ok(singleBlue.dual < 40 && singleBlue.triple < 40, 'no overprint before the second plate is gated on');

    // Yellow gate at 0.75 s (frame 18), roller sweep completes ~1.2 s (frame 29).
    assert.ok(yellowSweeping.yellow > 100, `yellow is partially swept at frame 20 (${yellowSweeping.yellow} px)`);
    assert.ok(
      yellowOn.yellow > yellowSweeping.yellow * 1.5,
      `the yellow sweep keeps inking the sheet (${yellowSweeping.yellow} → ${yellowOn.yellow} px)`,
    );
    assert.ok(yellowOn.dual > 100, `blue+yellow overprint appears once both plates are on (${yellowOn.dual} px)`);
    assert.ok(yellowOn.pink < 60, `pink is still off at frame 30 (${yellowOn.pink} px)`);
    assert.ok(yellowOn.triple < 40, 'there is no triple overprint before the pink plate');

    // Pink gate at 1.5 s (frame 36), fully inked ~1.95 s (frame 47).
    assert.ok(
      pinkSweeping.pink > singleBlue.pink + 20,
      `pink is partially swept at frame 40 (${pinkSweeping.pink} px, gate-off ${singleBlue.pink})`,
    );
    assert.ok(
      allOn.pink > pinkSweeping.pink * 1.3,
      `the pink sweep keeps inking the sheet (${pinkSweeping.pink} → ${allOn.pink} px)`,
    );
    assert.ok(allOn.triple > 60, `three-ink overprint appears once all plates are on (${allOn.triple} px)`);
    assert.ok(allOn.yellow > yellowOn.yellow * 0.6, 'the yellow plate stays on after the pink gate');

    // The screen is a real halftone dot screen, not a flat fill: many ink/paper
    // transitions along rows inside the inked areas.
    assert.ok(
      allOn.yellowTransitions > 800,
      `the yellow plate prints a dot screen, not a flat field (${allOn.yellowTransitions} transitions)`,
    );

    // The alternate ride is a different place/route/action picture.
    const bakery47 = inkStats(frameOf(decoded, FRAMES + 47));
    assert.ok(bakery47.paper > 1000 && bakery47.pink > 60, 'the bakery ride also prints the full three inks');
    assert.ok(
      changedFraction(frameOf(decoded, 47), frameOf(decoded, FRAMES + 47)) > 0.15,
      'riverside and bakery are different compositions at the same gate-stage beat',
    );

    // The full 96-frame arc: the action frames are derived from the authored
    // shared facts, then really decoded from the built movie. The sound attacks
    // at the same times are asserted from the real PCM in the audio test.
    const facts = (await import(`${pathToFileURL(join(root, 'action-facts.mjs')).href}?t=${Date.now()}`)) as {
      RIDES: {
        riverside: { bell: { strike: number } };
        bakery: { bakery: { catchContact: number; stowContact: number } };
      };
      actionAt: (
        variant: 'riverside' | 'bakery',
        seconds: number,
      ) => { stepped: number; bell: number; caught: number; stowed: number; inBasket: boolean; contact: number };
    };
    const bellFrame = Math.round(facts.RIDES.riverside.bell.strike * FPS);
    const catchFrame = Math.round(facts.RIDES.bakery.bakery.catchContact * FPS);
    const stowFrame = Math.round(facts.RIDES.bakery.bakery.stowContact * FPS);
    assert.deepEqual([bellFrame, catchFrame, stowFrame], [56, 66, 76], 'the authored 12 Hz action frames');
    for (const [index, label] of [
      [bellFrame, 'riverside bell strike'],
      [FRAMES + catchFrame, 'bakery contact'],
      [FRAMES + stowFrame, 'bakery basket stow'],
    ] as const) {
      assert.ok(contentsFor(frameOf(decoded, index)).ink > 2000, `${label} frame is a real printed frame`);
    }
    // The same stepped observer the picture uses: the hand reaches the bell at
    // frame 56, the bread is fully caught at 66, and it is in the basket at 76;
    // the immediate previous drawing is short of each contact.
    assert.ok(facts.actionAt('riverside', bellFrame / FPS).bell > 0.999, 'the hand is at the bell at frame 56');
    assert.ok(
      facts.actionAt('riverside', (bellFrame - 1) / FPS).bell < 0.999,
      'the previous drawing is short of the bell',
    );
    assert.ok(facts.actionAt('bakery', catchFrame / FPS).caught === 1, 'the bread is caught at frame 66');
    assert.ok(
      facts.actionAt('bakery', (catchFrame - 1) / FPS).caught < 1,
      'the previous drawing has not caught the bread',
    );
    assert.ok(facts.actionAt('bakery', stowFrame / FPS).inBasket, 'the bread is in the basket at frame 76');
    assert.ok(!facts.actionAt('bakery', (stowFrame - 1) / FPS).inBasket, 'the previous drawing is not yet stowed');
    succeeded = true;
  } finally {
    if (succeeded) await rm(parent, { recursive: true, force: true });
    else console.error(`kept the risograph build fixture for inspection: ${parent}`);
  }
});

// ---------------------------------------------------------------------------
// Direct Browser capture: stateless per-frame determinism and the two sizes.
// ---------------------------------------------------------------------------
test('risograph: rendering is a stateless pure frame function and resizes cleanly', async () => {
  const sceneRoot = await mkdtemp(join(tmpdir(), 'viscraft-riso-scene-'));
  const destination = await mkdtemp(join(tmpdir(), 'viscraft-riso-frames-'));
  let succeeded = false;
  try {
    await cp(STUDY_DIR, sceneRoot, { recursive: true });
    const scene = await openCodeScene(
      sceneRoot,
      { entry: ENTRY, resources: RESOURCES },
      { width: WIDTH, height: HEIGHT },
      { label: 'captureCode', globalName: 'viscraft' },
    );
    try {
      // Repeat and shuffled-order sampling: the renderer has no accumulated
      // state and re-evaluates the whole plate from {frame, seed, params}.
      const ordered: Record<number, Buffer> = {};
      for (const frame of [0, 30, 47]) ordered[frame] = await renderToBuffer(scene, frame, 'riverside', destination);
      for (const frame of Object.keys(ordered).map(Number)) {
        const pixels = pngPixels(join(destination, `riverside-${frame}.png`));
        assert.equal(pixels.length, FRAME_BYTES, `frame ${frame} is a complete ${WIDTH}x${HEIGHT} picture`);
        assert.ok(contentsFor(pixels).paper < WIDTH * HEIGHT, `frame ${frame} is not a blank sheet`);
      }
      const repeat = await renderToBuffer(scene, 30, 'riverside', destination);
      assert.ok(repeat.equals(ordered[30]), 'the same frame is byte-identical on repeat');
      for (const frame of [47, 0, 30]) {
        const buffer = await renderToBuffer(scene, frame, 'riverside', destination);
        assert.ok(buffer.equals(ordered[frame]), `frame ${frame} is independent of sampling order`);
      }

      // The printer is reused until the size changes; a resize repaints the
      // packed plate at the new backing size rather than stretching old bytes.
      await scene.page.setViewport({ width: 320, height: 180, deviceScaleFactor: 1 });
      const resized = await renderToBuffer(scene, 47, 'riverside', destination, { width: 320, height: 180 });
      const resizedPixels = pngPixels(join(destination, 'riverside-47.png'));
      assert.equal(resizedPixels.length, 320 * 180 * 3, 'the resized frame has its own backing size');
      assert.ok(resized.length > 100, 'the resized frame is a real PNG');
      assert.ok(contentsFor(resizedPixels).ink > 2000, 'the resized frame repaints real ink, not a blank buffer');
    } finally {
      await scene.close();
    }
    succeeded = true;
  } finally {
    if (succeeded) {
      await rm(destination, { recursive: true, force: true });
      await rm(sceneRoot, { recursive: true, force: true });
    } else console.error(`kept the risograph capture probe for inspection: ${sceneRoot}, ${destination}`);
  }
});

/** Minimal paper/content split used by the direct-capture test. */
function contentsFor(pixels: Buffer): { paper: number; ink: number } {
  let paper = 0;
  for (let i = 0; i < pixels.length; i += 3) {
    if (pixels[i] > 195 && pixels[i + 1] > 185 && pixels[i + 2] > 175) paper++;
  }
  return { paper, ink: pixels.length / 3 - paper };
}

// ---------------------------------------------------------------------------
// Score-only handoff: music changes; the picture and the Foley are reused.
// ---------------------------------------------------------------------------
test('risograph: a score-only edit changes music and reuses the picture/Foley', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-riso-score-edit-'));
  const root = join(parent, 'riso');
  let succeeded = false;
  try {
    await authorRecipe({
      recipe: RECIPE,
      root,
      cwd: parent,
      options: { width: WIDTH, height: HEIGHT, frames: FRAMES },
    });
    const originalProject = await readFile(join(root, 'project.json'), 'utf8');
    const originalScene = await readFile(join(root, 'scene.mjs'));
    const originalScore = await readFile(join(root, 'score.mjs'));
    const originalFoley = await readFile(join(root, 'foley.mjs'));
    const originalFacts = await readFile(join(root, 'action-facts.mjs'));

    const before = await buildProject(root);
    assert.equal(before.status, 'succeeded', `the authored Project must build: ${before.error ?? ''}`);
    const beforeArtifact = before.artifacts.find(artifact => artifact.id === before.result!.artifact)!;
    const beforePath = join(root, beforeArtifact.path);
    const beforeHash = sha256(await readFile(beforePath));
    const beforeVideo = decodeFrames(beforePath, FRAMES * 2);
    const stem = (build: typeof before, bus: string) => {
      const operation = build.operations.find(
        item =>
          item.kind === 'mix-stem' && build.artifacts.find(artifact => artifact.id === item.artifact)!.bus === bus,
      )!;
      return build.artifacts.find(artifact => artifact.id === operation.artifact)!;
    };
    const beforeMusicHash = sha256(await readFile(join(root, stem(before, 'music').path)));
    const beforeFoleyHash = sha256(await readFile(join(root, stem(before, 'foley').path)));

    const exportedPath = join(parent, 'exported');
    await exportProject(root, exportedPath);
    const asideRoot = join(parent, 'riso-aside');
    await rename(root, asideRoot);

    const exported = await loadProject(exportedPath);
    const scorePath = join(exportedPath, 'score.mjs');
    const scoreText = await readFile(scorePath, 'utf8');
    const edited = scoreText.replace(
      "const D_MAJ9_FINAL = ['D3', 'F#3', 'A3', 'C#4', 'E4'];",
      "const D_MAJ9_FINAL = ['D3', 'F#3', 'A3', 'C#4', 'F4'];",
    );
    assert.notEqual(edited, scoreText, 'the score-only edit changes the final chord tone');
    await writeFile(scorePath, edited);
    const refreshed = await refreshCodeAsset(exportedPath, {
      assetId: 'riso_score',
      expectedRevision: exported.revision,
    });
    assert.equal(refreshed.sha256, sha256(Buffer.from(edited)));

    const after = await buildProject(exportedPath);
    assert.equal(after.status, 'succeeded', `the score-only export must rebuild: ${after.error ?? ''}`);
    const afterArtifact = after.artifacts.find(artifact => artifact.id === after.result!.artifact)!;
    const afterVideo = decodeFrames(join(exportedPath, afterArtifact.path), FRAMES * 2);
    const afterMusicHash = sha256(await readFile(join(exportedPath, stem(after, 'music').path)));
    const afterFoleyHash = sha256(await readFile(join(exportedPath, stem(after, 'foley').path)));

    for (const frame of [0, 20, 47, 56, 66, 76, FRAMES + 47, FRAMES + 66, FRAMES + 76]) {
      assert.ok(
        frameOf(beforeVideo, frame).equals(frameOf(afterVideo, frame)),
        `the score-only edit reuses picture frame ${frame}`,
      );
    }
    assert.notEqual(afterMusicHash, beforeMusicHash, 'the edited music stem is a different signal');
    assert.equal(afterFoleyHash, beforeFoleyHash, 'the Foley stem is reused byte-for-byte');
    // `beforePath` lives under the renamed-aside root; compare the hash captured
    // before the rename with the new artifact instead of reading the old path.
    assert.notEqual(
      beforeHash,
      sha256(await readFile(join(exportedPath, afterArtifact.path))),
      'the rebuilt movie is a different artifact',
    );

    assert.equal(await readFile(join(asideRoot, 'project.json'), 'utf8'), originalProject);
    assert.equal(sha256(await readFile(join(asideRoot, 'scene.mjs'))), sha256(originalScene));
    assert.equal(sha256(await readFile(join(asideRoot, 'score.mjs'))), sha256(originalScore));
    assert.equal(sha256(await readFile(join(asideRoot, 'foley.mjs'))), sha256(originalFoley));
    assert.equal(sha256(await readFile(join(asideRoot, 'action-facts.mjs'))), sha256(originalFacts));
    assert.equal(sha256(await readFile(join(asideRoot, beforeArtifact.path))), beforeHash);
    succeeded = true;
  } finally {
    if (succeeded) await rm(parent, { recursive: true, force: true });
    else console.error(`kept the risograph score-edit fixture for inspection: ${parent}`);
  }
});

// ---------------------------------------------------------------------------
// Shared-facts handoff: the picture action frame and the Foley onset both move.
// ---------------------------------------------------------------------------
test('risograph: the shared action facts move the picture plate, music and Foley bell', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-riso-facts-edit-'));
  const root = join(parent, 'riso');
  let succeeded = false;
  try {
    await authorRecipe({
      recipe: RECIPE,
      root,
      cwd: parent,
      options: { width: WIDTH, height: HEIGHT, frames: FRAMES },
    });
    const originalProject = await readFile(join(root, 'project.json'), 'utf8');
    const originalScene = await readFile(join(root, 'scene.mjs'));
    const originalFacts = await readFile(join(root, 'action-facts.mjs'));

    const before = await buildProject(root);
    assert.equal(before.status, 'succeeded', `the authored Project must build: ${before.error ?? ''}`);
    const beforeArtifact = before.artifacts.find(artifact => artifact.id === before.result!.artifact)!;
    const beforePath = join(root, beforeArtifact.path);
    const beforeHash = sha256(await readFile(beforePath));
    const beforeVideo = decodeFrames(beforePath, FRAMES * 2);
    const beforeStem = (() => {
      const operation = before.operations.find(
        item =>
          item.kind === 'mix-stem' && before.artifacts.find(artifact => artifact.id === item.artifact)!.bus === 'foley',
      )!;
      return before.artifacts.find(artifact => artifact.id === operation.artifact)!;
    })();
    const beforeFoley = decodeWav(await readFile(join(root, beforeStem.path)));
    const beforeMusicStem = (() => {
      const operation = before.operations.find(
        item =>
          item.kind === 'mix-stem' && before.artifacts.find(artifact => artifact.id === item.artifact)!.bus === 'music',
      )!;
      return before.artifacts.find(artifact => artifact.id === operation.artifact)!;
    })();
    const beforeMusicHash = sha256(await readFile(join(root, beforeMusicStem.path)));

    const exportedPath = join(parent, 'exported');
    await exportProject(root, exportedPath);
    const asideRoot = join(parent, 'riso-aside');
    await rename(root, asideRoot);

    const exported = await loadProject(exportedPath);
    const factsPath = join(exportedPath, 'action-facts.mjs');
    const factsText = await readFile(factsPath, 'utf8');
    const bellEdited = factsText.replace('target: 2.3,', 'target: 2.5,');
    assert.ok(bellEdited.includes('target: 2.5,'), 'the edit changes the bell target');
    assert.equal(bellEdited.match(/target: 2\.3,/g), null, 'the old bell target is gone');
    const riversideGate = '  riverside: Object.freeze({\n    gates: Object.freeze([-0.5, 0.75, 1.5]),';
    assert.ok(bellEdited.includes(riversideGate), 'the riverside yellow gate literal is present');
    const edited = bellEdited.replace(
      riversideGate,
      '  riverside: Object.freeze({\n    gates: Object.freeze([-0.5, 1.0, 1.5]),',
    );
    assert.notEqual(edited, bellEdited, 'the same facts edit also moves the riverside yellow gate');
    assert.ok(
      edited.includes('gates: Object.freeze([-0.5, 1.0, 1.5])'),
      'the riverside yellow gate now enters at 1.0 s',
    );
    assert.ok(
      edited.includes('  bakery: Object.freeze({\n    gates: Object.freeze([-0.5, 0.75, 1.5]),'),
      'the bakery gate keeps its 0.75 s entry',
    );
    await writeFile(factsPath, edited);
    const refreshed = await refreshCodeAsset(exportedPath, {
      assetId: 'riso_facts',
      expectedRevision: exported.revision,
    });
    assert.equal(refreshed.sha256, sha256(Buffer.from(edited)));

    const after = await buildProject(exportedPath);
    assert.equal(after.status, 'succeeded', `the shared-facts export must rebuild: ${after.error ?? ''}`);
    const afterArtifact = after.artifacts.find(artifact => artifact.id === after.result!.artifact)!;
    const afterVideo = decodeFrames(join(exportedPath, afterArtifact.path), FRAMES * 2);
    const afterStem = (() => {
      const operation = after.operations.find(
        item =>
          item.kind === 'mix-stem' && after.artifacts.find(artifact => artifact.id === item.artifact)!.bus === 'foley',
      )!;
      return after.artifacts.find(artifact => artifact.id === operation.artifact)!;
    })();
    const afterFoley = decodeWav(await readFile(join(exportedPath, afterStem.path)));
    const afterMusicStem = (() => {
      const operation = after.operations.find(
        item =>
          item.kind === 'mix-stem' && after.artifacts.find(artifact => artifact.id === item.artifact)!.bus === 'music',
      )!;
      return after.artifacts.find(artifact => artifact.id === operation.artifact)!;
    })();
    const afterMusicHash = sha256(await readFile(join(exportedPath, afterMusicStem.path)));

    const firstBell = (wav: DecodedWav) => {
      const from = Math.floor(2.2 * wav.sampleRate);
      const to = Math.min(wav.frames, Math.ceil(3 * wav.sampleRate));
      for (let i = from; i < to; i++) {
        const level = Math.max(Math.abs(wav.data[0][i]), Math.abs(wav.data[1][i]));
        if (level > 0.3) return i / wav.sampleRate;
      }
      return null;
    };
    assert.ok(Math.abs((firstBell(beforeFoley) ?? 0) - 2.3333) < 0.01, 'the default bell strikes at 2.3333 s');
    assert.ok(Math.abs((firstBell(afterFoley) ?? 0) - 2.5) < 0.01, 'the edited bell strikes at the new 2.5 s target');
    assert.ok(peakBetween(beforeFoley, 2.32, 2.35) > 0.3, 'the default bell attack is in the Foley stem');
    assert.ok(peakBetween(afterFoley, 2.49, 2.52) > 0.3, 'the edited bell attack is in the Foley stem');

    // The same facts edit moves the yellow plate gate. The original 0.75 s gate
    // has swept some yellow by frame 20; the 1.0 s gate has not started there.
    // By frame 30 the new gate is an onset (1.0 s + 0.45 s sweep completes at
    // frame ~34.8), so it is present but still below the original fully-on plate.
    const beforeYellow20 = inkStats(frameOf(beforeVideo, 20));
    const afterYellow20 = inkStats(frameOf(afterVideo, 20));
    const beforeYellow30 = inkStats(frameOf(beforeVideo, 30));
    const afterYellow30 = inkStats(frameOf(afterVideo, 30));
    assert.ok(beforeYellow20.yellow > 100, `the default gate inks yellow at frame 20 (${beforeYellow20.yellow} px)`);
    assert.ok(afterYellow20.yellow < 40, `the moved gate has no yellow at frame 20 (${afterYellow20.yellow} px)`);
    assert.ok(afterYellow30.yellow > 100, `the moved gate inks yellow again by frame 30 (${afterYellow30.yellow} px)`);
    assert.ok(
      afterYellow30.yellow < beforeYellow30.yellow,
      `frame 30 is an onset, not the fully on plate (${afterYellow30.yellow} vs ${beforeYellow30.yellow} px)`,
    );
    assert.ok(
      changedFraction(frameOf(beforeVideo, 20), frameOf(afterVideo, 20)) > 0.005,
      'frame 20 genuinely changes with the yellow gate',
    );
    assert.notEqual(afterMusicHash, beforeMusicHash, 'the same facts edit changes the music stem');

    const changed = changedFraction(frameOf(beforeVideo, 56), frameOf(afterVideo, 56));
    assert.ok(changed > 0.0001, `the edited bell target changes the frame-56 hand action (${changed})`);
    // The original movie is now under `asideRoot`; the hash captured before the
    // rename is the protection evidence, not a read of the vanished path.
    assert.notEqual(
      beforeHash,
      sha256(await readFile(join(exportedPath, afterArtifact.path))),
      'the rebuilt movie is a different artifact',
    );

    assert.equal(await readFile(join(asideRoot, 'project.json'), 'utf8'), originalProject);
    assert.equal(sha256(await readFile(join(asideRoot, 'scene.mjs'))), sha256(originalScene));
    assert.equal(sha256(await readFile(join(asideRoot, 'action-facts.mjs'))), sha256(originalFacts));
    assert.equal(sha256(await readFile(join(asideRoot, beforeArtifact.path))), beforeHash);
    succeeded = true;
  } finally {
    if (succeeded) await rm(parent, { recursive: true, force: true });
    else console.error(`kept the risograph facts-edit fixture for inspection: ${parent}`);
  }
});
