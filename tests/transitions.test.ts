import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { composeVideo } from '../src/backends/media/picture.js';
import { probeMedia } from '../src/backends/media/probe.js';
import type { ComposeClip } from '../src/backends/media/picture.js';
import { ProjectSchema, TransitionKindSchema, TransitionSchema } from '../src/core/schema.js';
import type { Composition, OutputSettings, Placement, Project, TransitionKind } from '../src/core/schema.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';

const OUT: OutputSettings = {
  width: 64,
  height: 48,
  fps: { numerator: 25, denominator: 1 },
  sampleRate: 48000,
  channels: 2,
};

// The complete bounded set the schema must accept: dissolve plus directional
// wipes, directional slides, circular reveals, the built-in `hblur` xfade, and
// the two whip kinds (a directional slide with a horizontal motion smear).
// Every non-whip entry is a real ffmpeg `xfade` transition name; the whip kinds
// are handled by a bounded smear subgraph (see media.ts).
const ALL_KINDS: TransitionKind[] = [
  'dissolve',
  'wipeleft',
  'wiperight',
  'wipeup',
  'wipedown',
  'slideleft',
  'slideright',
  'slideup',
  'slidedown',
  'circleopen',
  'circleclose',
  'hblur',
  'whipleft',
  'whipright',
];

const SPATIAL_KINDS: TransitionKind[] = ['wipeleft', 'slideright', 'circleopen'];
const SMEAR_KINDS: TransitionKind[] = ['whipleft', 'whipright'];

// Two 20-frame placements overlapping on [14, 20): the union is [0, 34), so the
// explicit-overlap rule yields exactly 34 frames (never 40 - 6 = 34 re-subtracted
// down to 28).
const LENGTH = 20;
const START = 14;
const OVERLAP_START = 14;
const OVERLAP_END = 20;
const TOTAL = 34;

async function ffmpeg(args: string[]): Promise<void> {
  await runCommand('ffmpeg', [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-loglevel',
    'error',
    '-threads',
    '2',
    '-filter_threads',
    '1',
    '-filter_complex_threads',
    '1',
    ...args,
  ]);
}

async function tempDir(): Promise<string> {
  return fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-transitions-test-'));
}

/** A solid-colour 64x48 clip at the composition rate and an exact frame count. */
async function makeColorClip(dir: string, name: string, color: string, frames: number): Promise<string> {
  const out = nodePath.join(dir, name);
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:size=64x48:rate=25`,
    '-frames:v',
    String(frames),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-r',
    '25',
    '-an',
    out,
  ]);
  return out;
}

/**
 * A 64x48 clip with strong HORIZONTAL structure (vertical bars drawn by
 * `drawgrid`). A horizontal smear collapses these horizontal gradients, so the
 * difference between a plain slide and a whip smear is a large, unambiguous
 * signal rather than a two-pixel seam.
 */
async function makeBarredClip(dir: string, name: string, color: string, frames: number): Promise<string> {
  const out = nodePath.join(dir, name);
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:size=64x48:rate=25`,
    '-vf',
    'drawgrid=w=8:h=48:t=2:c=white@1.0',
    '-frames:v',
    String(frames),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-r',
    '25',
    '-an',
    out,
  ]);
  return out;
}

/** Decode every frame of a 64x48 file to one RGB24 Buffer per frame. */
async function decodeFrames(file: string, dir: string): Promise<Buffer[]> {
  const raw = nodePath.join(dir, `rgb-${Math.random().toString(36).slice(2)}.raw`);
  await ffmpeg(['-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-an', raw]);
  const bytes = await fs.readFile(raw);
  const perFrame = OUT.width * OUT.height * 3;
  assert.equal(bytes.length % perFrame, 0, 'decoded picture must be a whole number of frames');
  const frames: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += perFrame)
    frames.push(bytes.subarray(offset, offset + perFrame));
  await fs.rm(raw, { force: true });
  return frames;
}

/**
 * Mean absolute horizontal difference energy of one RGB24 frame:
 * `mean over (x>0, channel) |I(x,y,c) - I(x-1,y,c)|`. A horizontal smear lowers
 * this because neighbouring columns are averaged together; a plain slide keeps
 * sharp column-to-column edges. This is a directional (horizontal-only) metric,
 * so it cannot be satisfied by a merely different non-horizontal effect.
 */
function horizontalDifferenceEnergy(frame: Buffer): number {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < OUT.height; y++) {
    for (let x = 1; x < OUT.width; x++) {
      const base = (y * OUT.width + x) * 3;
      const prev = (y * OUT.width + x - 1) * 3;
      for (let c = 0; c < 3; c++) {
        sum += Math.abs(frame[base + c] - frame[prev + c]);
        count++;
      }
    }
  }
  return sum / count;
}

/** Mean horizontal-difference energy across the explicit overlap [14, 20). */
function overlapHorizontalEnergy(frames: Buffer[]): number {
  let sum = 0;
  for (let i = OVERLAP_START; i < OVERLAP_END; i++) sum += horizontalDifferenceEnergy(frames[i]);
  return sum / (OVERLAP_END - OVERLAP_START);
}

/** Fraction of pixels that read as (near) pure red / pure blue. */
function splitFractions(frame: Buffer): { red: number; blue: number } {
  let red = 0,
    blue = 0;
  const total = frame.length / 3;
  for (let i = 0; i < frame.length; i += 3) {
    const r = frame[i],
      g = frame[i + 1],
      b = frame[i + 2];
    if (r > 180 && g < 90 && b < 90) red++;
    else if (b > 180 && r < 90) blue++;
  }
  return { red: red / total, blue: blue / total };
}

function makeProject(placements: Placement[], transitions: Composition['transitions']): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'test_project',
    revision: 1,
    title: 'Transitions',
    direction: { intent: 'test', looks: [{ id: 'look_main', description: 'main look' }], transitions: [] },
    assets: [],
    bindings: {},
    sources: [],
    composition: {
      output: OUT,
      scenes: [{ id: 'scene_1', description: 'scene' }],
      shots: [{ id: 'shot_1', scene: 'scene_1', look: 'look_main', intent: 'shot', targetFrames: TOTAL }],
      placements,
      transitions,
      audio: [],
    },
  });
}

function placement(id: string, inFrame: number, outFrame: number, startFrame: number): Placement {
  return { id, shot: 'shot_1', source: 'src_1', inFrame, outFrame, startFrame, audio: 'mute' };
}

async function clipsFor(paths: string[], secondStart: number): Promise<ComposeClip[]> {
  const media = await Promise.all(paths.map(path => probeMedia(path)));
  return [
    { placement: placement('place_a', 0, LENGTH, 0), path: paths[0], media: media[0] },
    { placement: placement('place_b', 0, LENGTH, secondStart), path: paths[1], media: media[1] },
  ];
}

// ---------------------------------------------------------------------------
// Schema: the bounded kind set and the unchanged structural rules
// ---------------------------------------------------------------------------

test('TransitionSchema accepts every bounded kind and rejects unknown kinds and wrong shapes', () => {
  // The generic loops below exercise the 14 xfade/smear kinds. `occlude` is
  // also part of the bounded kind set but needs an occluder Asset, so it is
  // covered by tests/occlude.test.ts instead.
  assert.deepEqual(
    TransitionKindSchema.options,
    [...ALL_KINDS, 'occlude'],
    'the schema set must be exactly the bounded transition kinds',
  );
  for (const kind of ALL_KINDS) {
    const parsed = TransitionSchema.parse({ from: 'a', to: 'b', kind, startFrame: 4, endFrame: 10 });
    assert.equal(parsed.kind, kind);
  }
  // An unchanged dissolve declaration still parses to the exact same shape.
  assert.deepEqual(TransitionSchema.parse({ from: 'a', to: 'b', kind: 'dissolve', startFrame: 4, endFrame: 10 }), {
    from: 'a',
    to: 'b',
    kind: 'dissolve',
    startFrame: 4,
    endFrame: 10,
  });

  for (const bad of [
    { from: 'a', to: 'b', kind: 'warp', startFrame: 4, endFrame: 10 }, // unknown kind
    { from: 'a', to: 'b', kind: 'dissolve', startFrame: 4 }, // missing endFrame
    { from: 'a', to: 'b', kind: 'dissolve', startFrame: 4, endFrame: 0 }, // endFrame must be positive
    { from: 'a', to: 'b', kind: 'dissolve', startFrame: 4, endFrame: 10, extra: 1 }, // non-strict shape
    { from: 'a', to: 'b', kind: 'dissolve', startFrame: 4.5, endFrame: 10 }, // non-integer
  ]) {
    assert.throws(() => TransitionSchema.parse(bad), `must reject ${JSON.stringify(bad)}`);
  }

  // The full Project schema accepts a non-dissolve kind and still rejects unknown ones.
  const withWipe = makeProject(
    [placement('place_a', 0, LENGTH, 0), placement('place_b', 0, LENGTH, START)],
    [{ from: 'place_a', to: 'place_b', kind: 'circleopen', startFrame: OVERLAP_START, endFrame: OVERLAP_END }],
  );
  assert.equal(withWipe.composition!.transitions[0].kind, 'circleopen');
});

// ---------------------------------------------------------------------------
// composeVideo: real ffmpeg mixing over the explicit overlap
// ---------------------------------------------------------------------------

test('composeVideo mixes every bounded kind over the explicit overlap without shortening the programme', async () => {
  const dir = await tempDir();
  try {
    const red = await makeColorClip(dir, 'red.mp4', 'red', LENGTH);
    const blue = await makeColorClip(dir, 'blue.mp4', 'blue', LENGTH);
    const clips = await clipsFor([red, blue], START);
    const hashes = new Map<TransitionKind, string>();
    for (const kind of ALL_KINDS) {
      const project = makeProject(
        [placement('place_a', 0, LENGTH, 0), placement('place_b', 0, LENGTH, START)],
        [{ from: 'place_a', to: 'place_b', kind, startFrame: OVERLAP_START, endFrame: OVERLAP_END }],
      );
      const dest = nodePath.join(dir, `${kind}.mp4`);
      await composeVideo(project, clips, dest);
      const info = await probeMedia(dest);
      assert.equal(
        info.frames,
        TOTAL,
        `${kind}: the programme must be the explicit-overlap union (${TOTAL}), not a re-subtracted 28`,
      );
      hashes.set(kind, await hashFile(dest));
    }
    // Different kinds must actually mix differently.
    assert.notEqual(hashes.get('dissolve'), hashes.get('wipeleft'), 'a wipe must differ from a dissolve');
    assert.notEqual(hashes.get('circleopen'), hashes.get('circleclose'), 'open and close reveals must differ');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a wipe/slide/circle overlap is a spatial composite, distinct from both a hard cut and a dissolve', async () => {
  const dir = await tempDir();
  try {
    const red = await makeColorClip(dir, 'red.mp4', 'red', LENGTH);
    const blue = await makeColorClip(dir, 'blue.mp4', 'blue', LENGTH);
    const hardcutClips = await clipsFor([red, blue], LENGTH);
    const mixClips = await clipsFor([red, blue], START);

    // Hard cut: the two placements tile exactly, no overlap.
    const hardcutProject = makeProject(
      [placement('place_a', 0, LENGTH, 0), placement('place_b', 0, LENGTH, LENGTH)],
      [],
    );
    const hardcutPath = nodePath.join(dir, 'hardcut.mp4');
    await composeVideo(hardcutProject, hardcutClips, hardcutPath);
    assert.equal((await probeMedia(hardcutPath)).frames, 40, 'the hard cut keeps both full placements');

    const mixPath = async (kind: TransitionKind): Promise<string> => {
      const project = makeProject(
        [placement('place_a', 0, LENGTH, 0), placement('place_b', 0, LENGTH, START)],
        [{ from: 'place_a', to: 'place_b', kind, startFrame: OVERLAP_START, endFrame: OVERLAP_END }],
      );
      const dest = nodePath.join(dir, `${kind}.mp4`);
      await composeVideo(project, mixClips, dest);
      return dest;
    };

    const dissolvePath = await mixPath('dissolve');
    const hardcutFrames = await decodeFrames(hardcutPath, dir);
    const dissolveFrames = await decodeFrames(dissolvePath, dir);
    const dissolveHash = await hashFile(dissolvePath);

    // A dissolve is a temporal blend: the overlap frames are near-uniform purple,
    // with almost no frame hosting separate pure-red and pure-blue regions.
    let dissolveSplit = 0;
    for (let i = OVERLAP_START; i < OVERLAP_END; i++) {
      const { red: r, blue: b } = splitFractions(dissolveFrames[i]);
      dissolveSplit = Math.max(dissolveSplit, r * b);
    }
    assert.ok(
      dissolveSplit < 0.03,
      `a dissolve must not form separate red/blue regions (got ${dissolveSplit.toFixed(3)})`,
    );

    for (const kind of SPATIAL_KINDS) {
      const path = await mixPath(kind);
      const frames = await decodeFrames(path, dir);
      assert.notEqual(await hashFile(path), dissolveHash, `${kind} output must differ from a dissolve`);
      assert.notEqual(await hashFile(path), await hashFile(hardcutPath), `${kind} output must differ from a hard cut`);

      // A spatial transition splits the overlap into regions from both shots, so
      // the most-balanced overlap frame must hold substantial areas of both the
      // outgoing (red) and incoming (blue) picture.
      let bestFrame = -1,
        bestSplit = 0,
        bestRed = 0,
        bestBlue = 0;
      for (let i = OVERLAP_START; i < OVERLAP_END; i++) {
        const { red: r, blue: b } = splitFractions(frames[i]);
        if (r * b > bestSplit) {
          bestSplit = r * b;
          bestFrame = i;
          bestRed = r;
          bestBlue = b;
        }
      }
      assert.ok(
        bestSplit > 0.04 && bestRed > 0.15 && bestBlue > 0.15,
        `${kind}: overlap frame ${bestFrame} must be a real spatial composite (red ${bestRed.toFixed(2)}, blue ${bestBlue.toFixed(2)})`,
      );
      assert.notEqual(
        Buffer.compare(frames[bestFrame], dissolveFrames[bestFrame]),
        0,
        `${kind} frame ${bestFrame} must differ from the dissolve blend`,
      );
      assert.notEqual(
        Buffer.compare(frames[bestFrame], hardcutFrames[bestFrame]),
        0,
        `${kind} frame ${bestFrame} must differ from the hard cut`,
      );
    }

    // Sanity: the hard cut is fully red before the cut and fully blue after.
    for (const i of [0, OVERLAP_START, OVERLAP_END - 1]) {
      const { red: r } = splitFractions(hardcutFrames[i]);
      assert.ok(r > 0.9, `hardcut frame ${i} must be red`);
    }
    for (const i of [OVERLAP_END, 39]) {
      const { blue: b } = splitFractions(hardcutFrames[i]);
      assert.ok(b > 0.9, `hardcut frame ${i} must be blue`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('whip transitions are a real horizontal smear, not a plain slide alias, and preserve the frame count', async () => {
  const dir = await tempDir();
  try {
    // Strong horizontal structure so a horizontal smear is unambiguous.
    const red = await makeBarredClip(dir, 'red.mp4', 'red', LENGTH);
    const blue = await makeBarredClip(dir, 'blue.mp4', 'blue', LENGTH);
    const clips = await clipsFor([red, blue], START);

    const mix = async (kind: TransitionKind): Promise<string> => {
      const project = makeProject(
        [placement('place_a', 0, LENGTH, 0), placement('place_b', 0, LENGTH, START)],
        [{ from: 'place_a', to: 'place_b', kind, startFrame: OVERLAP_START, endFrame: OVERLAP_END }],
      );
      const dest = nodePath.join(dir, `${kind}.mp4`);
      await composeVideo(project, clips, dest);
      return dest;
    };

    // 1) Every new kind keeps the exact explicit-overlap union length.
    const hashes = new Map<TransitionKind, string>();
    for (const kind of [...ALL_KINDS]) {
      const path = await mix(kind);
      assert.equal((await probeMedia(path)).frames, TOTAL, `${kind}: the programme must remain ${TOTAL} frames`);
      hashes.set(kind, await hashFile(path));
    }

    // 2) `hblur` is a real built-in xfade distinct from dissolve and a slide.
    assert.notEqual(hashes.get('hblur'), hashes.get('dissolve'), 'hblur must differ from a dissolve');
    assert.notEqual(hashes.get('hblur'), hashes.get('slideleft'), 'hblur must differ from a slide');

    // 3) The whip kinds are a fast directional slide PLUS a horizontal smear.
    //    A plain slide is the smear's own base transition, so if whipleft were
    //    aliased to slideleft (or whipright to slideright) the measured overlap
    //    energy would be identical and this test would fail.
    const energies: Record<string, number> = {};
    const smearTestKinds: TransitionKind[] = ['slideleft', 'slideright', ...SMEAR_KINDS];
    for (const kind of smearTestKinds) {
      energies[kind] = overlapHorizontalEnergy(await decodeFrames(await mix(kind), dir));
    }
    for (const [whip, base] of [
      ['whipleft', 'slideleft'],
      ['whipright', 'slideright'],
    ] as const) {
      assert.ok(
        energies[base] > 0.5,
        `${base}: a plain slide over horizontal bars must keep real horizontal edges (got ${energies[base].toFixed(3)})`,
      );
      assert.ok(
        energies[whip] < energies[base] * 0.5,
        `${whip} must smear the overlap far more than ${base} (whip ${energies[whip].toFixed(3)} vs base ${energies[base].toFixed(3)})`,
      );
      assert.notEqual(hashes.get(whip), hashes.get(base), `${whip} must not be a byte-alias of ${base}`);
    }
    // The two whip directions must not be the same output.
    assert.notEqual(hashes.get('whipleft'), hashes.get('whipright'), 'left and right whips must differ');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a whip fold re-stamps the timeline so a following transition still composes at the exact union length', async () => {
  const dir = await tempDir();
  try {
    const red = await makeBarredClip(dir, 'red.mp4', 'red', LENGTH);
    const blue = await makeBarredClip(dir, 'blue.mp4', 'blue', LENGTH);
    const green = await makeBarredClip(dir, 'green.mp4', 'green', LENGTH);
    const media = await Promise.all([red, blue, green].map(path => probeMedia(path)));
    const clips: ComposeClip[] = [
      { placement: placement('place_a', 0, LENGTH, 0), path: red, media: media[0] },
      { placement: placement('place_b', 0, LENGTH, START), path: blue, media: media[1] },
      { placement: placement('place_c', 0, LENGTH, 28), path: green, media: media[2] },
    ];
    // p_a [0,20) > whipleft over [14,20) > p_b [14,34) > dissolve over [28,34) > p_c [28,48).
    const project = makeProject(
      [placement('place_a', 0, LENGTH, 0), placement('place_b', 0, LENGTH, START), placement('place_c', 0, LENGTH, 28)],
      [
        { from: 'place_a', to: 'place_b', kind: 'whipleft', startFrame: OVERLAP_START, endFrame: OVERLAP_END },
        { from: 'place_b', to: 'place_c', kind: 'dissolve', startFrame: 28, endFrame: 34 },
      ],
    );
    const dest = nodePath.join(dir, 'whip-then-dissolve.mp4');
    await composeVideo(project, clips, dest);
    assert.equal(
      (await probeMedia(dest)).frames,
      48,
      'the union length must survive a whip fold followed by a dissolve',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a dissolve blends the two shots across the cut on a deterministic clock', async () => {
  const dir = await tempDir();
  try {
    const red = await makeColorClip(dir, 'red.mp4', 'red', LENGTH);
    const blue = await makeColorClip(dir, 'blue.mp4', 'blue', LENGTH);
    const clips = await clipsFor([red, blue], START);

    const project = makeProject(
      [placement('place_a', 0, LENGTH, 0), placement('place_b', 0, LENGTH, START)],
      [{ from: 'place_a', to: 'place_b', kind: 'dissolve', startFrame: OVERLAP_START, endFrame: OVERLAP_END }],
    );
    const dest = nodePath.join(dir, 'dissolve.mp4');
    await composeVideo(project, clips, dest);
    const frames = await decodeFrames(dest, dir);

    // Frame count (clock): the programme is the explicit-overlap union, never
    // shortened a second time.
    assert.equal(frames.length, TOTAL, `a dissolve must keep the explicit-overlap union (${TOTAL})`);

    // Before the overlap the outgoing red shot owns the picture; after it the
    // incoming blue shot does. This is the real timeline the cut sits on.
    for (const i of [0, OVERLAP_START - 1]) {
      const { red: r, blue: b } = splitFractions(frames[i]);
      assert.ok(
        r > 0.9 && b < 0.1,
        `frame ${i} (before the overlap) must be the outgoing red shot (r=${r.toFixed(2)}, b=${b.toFixed(2)})`,
      );
    }
    for (const i of [OVERLAP_END, TOTAL - 1]) {
      const { red: r, blue: b } = splitFractions(frames[i]);
      assert.ok(
        b > 0.9 && r < 0.1,
        `frame ${i} (after the overlap) must be the incoming blue shot (r=${r.toFixed(2)}, b=${b.toFixed(2)})`,
      );
    }

    // Blend result and motion across the cut: inside the overlap the picture
    // advances monotonically from the outgoing colour to the incoming one, and
    // the interior frames are genuine blends rather than either pure colour.
    const meanBlueFraction = (frame: Buffer): number => {
      let sum = 0;
      for (let i = 0; i < frame.length; i += 3) sum += frame[i + 2] / (frame[i] + frame[i + 1] + frame[i + 2] + 1);
      return sum / (frame.length / 3);
    };
    let previous = -1;
    let interiorBlend = 0;
    for (let i = OVERLAP_START; i < OVERLAP_END; i++) {
      const blueFraction = meanBlueFraction(frames[i]);
      assert.ok(
        blueFraction >= previous,
        `overlap frame ${i} must not move back toward the outgoing shot (${blueFraction.toFixed(3)} after ${previous.toFixed(3)})`,
      );
      if (blueFraction > 0.2 && blueFraction < 0.8) interiorBlend++;
      previous = blueFraction;
    }
    assert.ok(interiorBlend > 0, 'at least one overlap frame must be a genuine blend of both shots, not a pure colour');
    assert.ok(meanBlueFraction(frames[OVERLAP_START]) < 0.5, 'the blend must start from the outgoing shot');
    assert.ok(meanBlueFraction(frames[OVERLAP_END - 1]) > 0.5, 'the blend must end on the incoming shot');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// composeVideo: the unchanged structural rejections
// ---------------------------------------------------------------------------

test('composeVideo rejects unknown kinds, non-adjacent pairs, empty/negative ranges and duplicate pairs', async () => {
  const dir = await tempDir();
  try {
    const red = await makeColorClip(dir, 'red.mp4', 'red', 40);
    const blue = await makeColorClip(dir, 'blue.mp4', 'blue', 40);
    const green = await makeColorClip(dir, 'green.mp4', 'green', 40);
    const media = await Promise.all([red, blue, green].map(path => probeMedia(path)));
    const clips: ComposeClip[] = [
      { placement: placement('place_a', 0, 20, 0), path: red, media: media[0] },
      { placement: placement('place_b', 0, 20, 14), path: blue, media: media[1] },
      { placement: placement('place_c', 0, 20, 34), path: green, media: media[2] },
    ];
    const base = [placement('place_a', 0, 20, 0), placement('place_b', 0, 20, 14), placement('place_c', 0, 20, 34)];

    const rejects = async (label: string, transitions: Composition['transitions'], pattern: RegExp) => {
      // Authoring may fail synchronously in the schema; composition may fail
      // asynchronously. Either way the declaration must be rejected loudly.
      const attempt = async () => {
        const project = makeProject(base, transitions);
        await composeVideo(project, clips, nodePath.join(dir, `${label}.mp4`));
      };
      await assert.rejects(attempt, pattern, label);
    };

    await rejects(
      'unknown',
      [{ from: 'place_a', to: 'place_b', kind: 'warp', startFrame: 14, endFrame: 20 } as any],
      /invalid|expected|kind/i,
    );
    await rejects(
      'negative',
      [{ from: 'place_a', to: 'place_b', kind: 'dissolve', startFrame: -2, endFrame: -1 } as any],
      /greater than|invalid|positive/i,
    );
    await rejects(
      'empty',
      [{ from: 'place_a', to: 'place_b', kind: 'dissolve', startFrame: 20, endFrame: 20 }],
      /empty range/i,
    );
    await rejects(
      'nonadjacent',
      [{ from: 'place_a', to: 'place_c', kind: 'wipeleft', startFrame: 34, endFrame: 40 }],
      /adjacent/i,
    );
    await rejects(
      'duplicate',
      [
        { from: 'place_a', to: 'place_b', kind: 'dissolve', startFrame: 14, endFrame: 20 },
        { from: 'place_a', to: 'place_b', kind: 'circleopen', startFrame: 14, endFrame: 20 },
      ],
      /duplicate transition/i,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
