import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { composeVideo } from '../src/backends/media/picture.js';
import { probeMedia } from '../src/backends/media/probe.js';
import type { ComposeClip } from '../src/backends/media/picture.js';
import { ProjectSchema, TransitionKindSchema, TransitionSchema } from '../src/core/schema.js';
import type { Composition, OutputSettings, Placement, Project, Transition } from '../src/core/schema.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';

const OUT: OutputSettings = {
  width: 64,
  height: 48,
  fps: { numerator: 25, denominator: 1 },
  sampleRate: 48000,
  channels: 2,
};

// Two 20-frame placements overlapping on [14, 20): the union is [0, 34), so the
// explicit-overlap rule yields exactly 34 frames (never 40 - 6 = 34 re-subtracted
// down to 28). The occlusion cut lands at the MIDDLE of the overlap, frame 17.
const LENGTH = 20;
const START = 14;
const OVERLAP_START = 14;
const OVERLAP_END = 20;
const OVERLAP = OVERLAP_END - OVERLAP_START; // 6
const TOTAL = 34;
const CUT_FRAME = OVERLAP_START + Math.floor(OVERLAP / 2); // 17

// The occluder is a solid opaque lime plate; the two shots are solid red / blue.
// Those three colours are mutually exclusive under the classifiers below, so a
// "fully covered" frame is measurable rather than merely "a filter ran".
const OCCLUDER_COLOR = 'lime';

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
  return fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-occlude-test-'));
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

/** A solid opaque 64x48 PNG occluder plate. */
async function makeOccluder(dir: string, name: string, color: string): Promise<{ path: string; sha256: string }> {
  const out = nodePath.join(dir, name);
  await ffmpeg(['-f', 'lavfi', '-i', `color=c=${color}:size=64x48:rate=1`, '-frames:v', '1', out]);
  return { path: name, sha256: await hashFile(out) };
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

/** Per-frame fractions of near-pure red / lime / blue pixels. */
function classify(frame: Buffer): { red: number; lime: number; blue: number } {
  let red = 0,
    lime = 0,
    blue = 0;
  const total = frame.length / 3;
  for (let i = 0; i < frame.length; i += 3) {
    const r = frame[i],
      g = frame[i + 1],
      b = frame[i + 2];
    if (r > 150 && g < 100 && b < 100) red++;
    else if (g > 150 && r < 100 && b < 100) lime++;
    else if (b > 150 && r < 100 && g < 100) blue++;
  }
  return { red: red / total, lime: lime / total, blue: blue / total };
}

function assetList(
  red: { path: string; sha256: string },
  blue: { path: string; sha256: string },
  occluder: { path: string; sha256: string },
): Project['assets'] {
  const rights = { origin: 'Original FFmpeg fixture', license: 'CC0-1.0', redistributable: true };
  return [
    { id: 'red_asset', revision: 1, path: red.path, sha256: red.sha256, type: 'video', rights, simulated: false },
    { id: 'blue_asset', revision: 1, path: blue.path, sha256: blue.sha256, type: 'video', rights, simulated: false },
    {
      id: 'occl_asset',
      revision: 1,
      path: occluder.path,
      sha256: occluder.sha256,
      type: 'image',
      rights,
      simulated: false,
    },
  ];
}

function makeProject(
  placements: Placement[],
  transitions: Composition['transitions'],
  assets: Project['assets'],
): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'test_project',
    revision: 1,
    title: 'Occlude',
    direction: { intent: 'test', looks: [{ id: 'look_main', description: 'main look' }], transitions: [] },
    assets,
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

// ---------------------------------------------------------------------------
// Schema: the optional occluder is exactly required for `occlude`
// ---------------------------------------------------------------------------

test('TransitionSchema requires `occluder` iff kind is "occlude" and leaves every other kind unchanged', () => {
  assert.ok(
    (TransitionKindSchema.options as readonly string[]).includes('occlude'),
    'occlude must be a bounded transition kind',
  );

  // An occlude declaration needs an occluder Asset id.
  const occlude = TransitionSchema.parse({
    from: 'a',
    to: 'b',
    kind: 'occlude',
    startFrame: 14,
    endFrame: 20,
    occluder: 'occl_asset',
  });
  assert.equal(occlude.occluder, 'occl_asset');

  // Refused loudly: occlude without an occluder.
  assert.throws(
    () => TransitionSchema.parse({ from: 'a', to: 'b', kind: 'occlude', startFrame: 14, endFrame: 20 }),
    /requires an `occluder`/,
  );
  // Refused loudly: an occluder on any other kind.
  assert.throws(
    () =>
      TransitionSchema.parse({
        from: 'a',
        to: 'b',
        kind: 'dissolve',
        startFrame: 14,
        endFrame: 20,
        occluder: 'occl_asset',
      }),
    /must not declare an occluder/,
  );
});

test('a project with no occlude transition parses with no occluder key', () => {
  // Every non-occlude kind still parses to EXACTLY its input shape: no added
  // `occluder` key, so authored state and its cache key are unaffected.
  for (const kind of TransitionKindSchema.options) {
    if (kind === 'occlude') continue;
    const input = { from: 'a', to: 'b', kind, startFrame: 4, endFrame: 10 };
    assert.deepEqual(TransitionSchema.parse(input), input, `${kind} must parse without an added field`);
    assert.ok(!Object.hasOwn(TransitionSchema.parse(input), 'occluder'), `${kind} must not gain an occluder key`);
  }

  // A whole project declaring only a dissolve carries no `occluder` anywhere in
  // its canonical JSON.
  const project = makeProject(
    [placement('place_a', 0, LENGTH, 0), placement('place_b', 0, LENGTH, START)],
    [{ from: 'place_a', to: 'place_b', kind: 'dissolve', startFrame: OVERLAP_START, endFrame: OVERLAP_END }],
    [],
  );
  assert.ok(!JSON.stringify(project).includes('occluder'), 'a non-occlude project must not gain an occluder key');
});

// ---------------------------------------------------------------------------
// composeVideo: exact-length, real coverage, and the structural refusals
// ---------------------------------------------------------------------------

interface Fixture {
  dir: string;
  red: string;
  blue: string;
  project: (transitions: Composition['transitions']) => Project;
  clips: ComposeClip[];
}

async function fixture(): Promise<Fixture> {
  const dir = await tempDir();
  const red = await makeColorClip(dir, 'red.mp4', 'red', LENGTH);
  const blue = await makeColorClip(dir, 'blue.mp4', 'blue', LENGTH);
  const occluder = await makeOccluder(dir, 'occluder.png', OCCLUDER_COLOR);
  const assets = assetList(
    { path: 'red.mp4', sha256: await hashFile(red) },
    { path: 'blue.mp4', sha256: await hashFile(blue) },
    occluder,
  );
  const media = await Promise.all([red, blue].map(path => probeMedia(path)));
  const clips: ComposeClip[] = [
    { placement: placement('place_a', 0, LENGTH, 0), path: red, media: media[0] },
    { placement: placement('place_b', 0, LENGTH, START), path: blue, media: media[1] },
  ];
  return {
    dir,
    red,
    blue,
    project: transitions =>
      makeProject([placement('place_a', 0, LENGTH, 0), placement('place_b', 0, LENGTH, START)], transitions, assets),
    clips,
  };
}

const occludeTransition = (occluder = 'occl_asset'): Transition => ({
  from: 'place_a',
  to: 'place_b',
  kind: 'occlude',
  startFrame: OVERLAP_START,
  endFrame: OVERLAP_END,
  occluder,
});

test('an occlusion transition keeps the exact union frame count', async () => {
  const f = await fixture();
  try {
    const dest = nodePath.join(f.dir, 'occlude.mp4');
    await composeVideo(f.project([occludeTransition()]), f.clips, dest, f.dir);
    assert.equal(
      (await probeMedia(dest)).frames,
      TOTAL,
      `the programme must remain the explicit-overlap union (${TOTAL})`,
    );
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test('the occluder FULLY covers the frame at the cut, and only there, hiding the splice', async () => {
  const f = await fixture();
  try {
    const dest = nodePath.join(f.dir, 'occlude.mp4');
    await composeVideo(f.project([occludeTransition()]), f.clips, dest, f.dir);
    const frames = await decodeFrames(dest, f.dir);
    assert.equal(frames.length, TOTAL);

    // (b) At the cut frame the picture is dominated by the occluder's colour:
    // neither source frame survives, so the splice is genuinely hidden.
    const atCut = classify(frames[CUT_FRAME]);
    assert.ok(
      atCut.lime > 0.95,
      `the cut frame must be dominated by the occluder colour (lime ${atCut.lime.toFixed(3)})`,
    );
    assert.ok(
      atCut.red + atCut.blue < 0.02,
      `no source picture may survive at the cut (red ${atCut.red.toFixed(3)}, blue ${atCut.blue.toFixed(3)})`,
    );

    // The outgoing shot shows right up to the sweep, the incoming shot is
    // revealed as it clears: a real sweep, not a static overlay or a dissolve.
    assert.ok(classify(frames[OVERLAP_START]).red > 0.95, 'the overlap must open on the outgoing (red) shot');
    assert.ok(classify(frames[OVERLAP_END]).blue > 0.95, 'the overlap must close on the incoming (blue) shot');
    assert.ok(
      classify(frames[OVERLAP_START + 1]).red > 0.1 && classify(frames[OVERLAP_START + 1]).lime > 0.1,
      'the occluder sweeps IN over the outgoing shot',
    );
    assert.ok(
      classify(frames[OVERLAP_END - 2]).blue > 0.1 && classify(frames[OVERLAP_END - 2]).lime > 0.1,
      'the occluder sweeps OUT over the incoming shot',
    );

    // Control that makes the coverage assertion non-vacuous in-process: a plain
    // hard cut at the same frame shows the incoming shot at CUT_FRAME, never the
    // occluder. If the occlusion fold did nothing, it would look like this.
    const hardCut = nodePath.join(f.dir, 'hardcut.mp4');
    const hardClips: ComposeClip[] = [
      { placement: placement('place_a', 0, CUT_FRAME, 0), path: f.red, media: f.clips[0].media },
      { placement: placement('place_b', 0, LENGTH, CUT_FRAME), path: f.blue, media: f.clips[1].media },
    ];
    const hardCutProject = makeProject(
      [placement('place_a', 0, CUT_FRAME, 0), placement('place_b', 0, LENGTH, CUT_FRAME)],
      [],
      f.project([]).assets,
    );
    await composeVideo(hardCutProject, hardClips, hardCut, f.dir);
    const hardFrames = await decodeFrames(hardCut, f.dir);
    const hardAtCut = classify(hardFrames[CUT_FRAME]);
    assert.ok(
      hardAtCut.blue > 0.95 && hardAtCut.lime < 0.02,
      `a hard cut must show the incoming shot at the cut (blue ${hardAtCut.blue.toFixed(3)}, lime ${hardAtCut.lime.toFixed(3)})`,
    );
    assert.notEqual(
      Buffer.compare(frames[CUT_FRAME], hardFrames[CUT_FRAME]),
      0,
      'the occlusion frame must differ from a plain hard cut',
    );
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test('an occlusion fold re-stamps the timeline so a following transition still composes at the exact union length', async () => {
  const dir = await tempDir();
  try {
    const red = await makeColorClip(dir, 'red.mp4', 'red', LENGTH);
    const blue = await makeColorClip(dir, 'blue.mp4', 'blue', LENGTH);
    const green = await makeColorClip(dir, 'green.mp4', 'green', LENGTH);
    const occluder = await makeOccluder(dir, 'occluder.png', OCCLUDER_COLOR);
    const assets = assetList(
      { path: 'red.mp4', sha256: await hashFile(red) },
      { path: 'blue.mp4', sha256: await hashFile(blue) },
      occluder,
    );
    const media = await Promise.all([red, blue, green].map(path => probeMedia(path)));
    const clips: ComposeClip[] = [
      { placement: placement('place_a', 0, LENGTH, 0), path: red, media: media[0] },
      { placement: placement('place_b', 0, LENGTH, START), path: blue, media: media[1] },
      { placement: placement('place_c', 0, LENGTH, 28), path: green, media: media[2] },
    ];
    // p_a [0,20) > occlude over [14,20) > p_b [14,34) > dissolve over [28,34) > p_c [28,48).
    const project = makeProject(
      [placement('place_a', 0, LENGTH, 0), placement('place_b', 0, LENGTH, START), placement('place_c', 0, LENGTH, 28)],
      [occludeTransition(), { from: 'place_b', to: 'place_c', kind: 'dissolve', startFrame: 28, endFrame: 34 }],
      assets,
    );
    const dest = nodePath.join(dir, 'occlude-then-dissolve.mp4');
    await composeVideo(project, clips, dest, dir);
    assert.equal(
      (await probeMedia(dest)).frames,
      48,
      'the union length must survive an occlusion fold followed by a dissolve',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('composeVideo refuses an occlusion transition it cannot honestly render', async () => {
  const f = await fixture();
  try {
    const dest = nodePath.join(f.dir, 'bad.mp4');
    // No project root => the occluder bytes cannot be read.
    await assert.rejects(() => composeVideo(f.project([occludeTransition()]), f.clips, dest), /project root/i);
    // Unknown occluder Asset.
    await assert.rejects(
      () => composeVideo(f.project([occludeTransition('missing_asset')]), f.clips, dest, f.dir),
      /unknown occluder/i,
    );
    // An occluder that is not an image (here, a video Asset).
    await assert.rejects(
      () => composeVideo(f.project([occludeTransition('red_asset')]), f.clips, dest, f.dir),
      /must be an image/i,
    );

    // Too short an overlap to sweep in AND out around the cut (2 frames).
    const shortClips = f.clips.map(clip =>
      clip.placement.id === 'place_b' ? { ...clip, placement: { ...clip.placement, startFrame: 18 } } : clip,
    );
    const shortProject = makeProject(
      [placement('place_a', 0, LENGTH, 0), placement('place_b', 0, LENGTH, 18)],
      [{ from: 'place_a', to: 'place_b', kind: 'occlude', startFrame: 18, endFrame: 20, occluder: 'occl_asset' }],
      f.project([]).assets,
    );
    await assert.rejects(() => composeVideo(shortProject, shortClips, dest, f.dir), /too short/i);
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});

test('a dissolve is unaffected by the occlusion capability and still blends both shots', async () => {
  const f = await fixture();
  try {
    const dissolveProject = f.project([
      { from: 'place_a', to: 'place_b', kind: 'dissolve', startFrame: OVERLAP_START, endFrame: OVERLAP_END },
    ]);
    const dissolve = nodePath.join(f.dir, 'dissolve.mp4');
    await composeVideo(dissolveProject, f.clips, dissolve, f.dir);
    const dissolveFrames = await decodeFrames(dissolve, f.dir);
    assert.equal(dissolveFrames.length, TOTAL, 'a dissolve must keep the explicit-overlap union length');

    // The overlap is a temporal blend of both shots, and the occluder never
    // appears: an occlude-only feature must not leak into a dissolve.
    let blended = 0;
    for (let i = OVERLAP_START; i < OVERLAP_END; i++) {
      const c = classify(dissolveFrames[i]);
      assert.ok(c.lime < 0.02, `a dissolve must not show the occluder at frame ${i} (lime ${c.lime.toFixed(3)})`);
      if (c.red > 0.1 && c.blue > 0.1) blended++;
    }
    assert.ok(blended > 0, 'the dissolve overlap must mix both shots, not a single flat colour');

    // It must differ from the occlusion render (the occluder is not applied here).
    const occlude = nodePath.join(f.dir, 'occlude.mp4');
    await composeVideo(f.project([occludeTransition()]), f.clips, occlude, f.dir);
    assert.notEqual(
      await hashFile(dissolve),
      await hashFile(occlude),
      'a dissolve must differ from the occlusion fold',
    );
  } finally {
    await fs.rm(f.dir, { recursive: true, force: true });
  }
});
