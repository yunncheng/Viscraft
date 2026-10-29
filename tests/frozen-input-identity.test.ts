/**
 * Frozen media identity, stable operation keys, authored-path validation,
 * audio pre-roll and dependency preflight, with real local media.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { buildProject } from '../src/build/build.js';
import { analyzeTimeline, candidatePlanIssues, compositionStateIssues, reusableHistory } from '../src/build/plan.js';
import { loadProject, validateProject } from '../src/project/project.js';
import { setContentLinkForTest } from '../src/project/content-store.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { ProjectSchema } from '../src/core/schema.js';
import type { BuildRecord, FilmProject, OutputSettings, Placement, Project, Transition } from '../src/core/schema.js';
import { makeSignalAsset } from './audio-fixtures.js';

const OUT: OutputSettings = {
  width: 64,
  height: 48,
  fps: { numerator: 25, denominator: 1 },
  sampleRate: 48000,
  channels: 2,
};
const FPS = '25';
const RIGHTS = { origin: 'Original FFmpeg fixture', license: 'CC0-1.0', redistributable: true } as const;

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
    ...args,
  ]);
}

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(nodePath.join(os.tmpdir(), `viscraft-fixture-id-${prefix}-`));
}

async function makeColorClip(dir: string, name: string, color: string, frames: number): Promise<string> {
  const out = nodePath.join(dir, name);
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:size=64x48:rate=${FPS}`,
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
    FPS,
    '-an',
    out,
  ]);
  return out;
}

/** A 64x48 still of a solid colour (a single PNG). */
async function makeStill(dir: string, name: string, color: string): Promise<string> {
  const out = nodePath.join(dir, name);
  await ffmpeg(['-f', 'lavfi', '-i', `color=c=${color}:size=64x48:rate=1`, '-frames:v', '1', out]);
  return out;
}

async function writeProject(root: string, project: unknown): Promise<void> {
  await fs.writeFile(nodePath.join(root, 'project.json'), JSON.stringify(project, null, 2));
}

async function asset(root: string, rel: string, id: string, type: 'video' | 'image'): Promise<Record<string, unknown>> {
  return {
    id,
    revision: 1,
    path: rel,
    sha256: await hashFile(nodePath.join(root, rel)),
    type,
    rights: RIGHTS,
    simulated: false,
  };
}

function hash(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// the occlusion transition consumes the FROZEN occluder bytes
// ---------------------------------------------------------------------------

function classifyOcclude(frame: Buffer): { red: number; blue: number; lime: number; magenta: number } {
  let red = 0,
    blue = 0,
    lime = 0,
    magenta = 0;
  const total = frame.length / 3;
  for (let i = 0; i < frame.length; i += 3) {
    const r = frame[i],
      g = frame[i + 1],
      b = frame[i + 2];
    if (r > 150 && g < 100 && b < 100) red++;
    else if (b > 150 && r < 100 && g < 100) blue++;
    else if (g > 150 && r < 100 && b < 100) lime++;
    else if (r > 150 && b > 150 && g < 100) magenta++;
  }
  return { red: red / total, blue: blue / total, lime: lime / total, magenta: magenta / total };
}

async function decodeFrame(file: string, frame: number, dir: string): Promise<Buffer> {
  const raw = nodePath.join(dir, `frame-${frame}-${Math.random().toString(36).slice(2)}.raw`);
  await ffmpeg([
    '-i',
    file,
    '-vf',
    `select=eq(n\\,${frame})`,
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-an',
    raw,
  ]);
  const bytes = await fs.readFile(raw);
  await fs.rm(raw, { force: true });
  assert.equal(bytes.length, OUT.width * OUT.height * 3, 'exactly one 64x48 RGB frame must decode');
  return bytes;
}

/** Two 20-frame shots overlapping on [14,20); the occlusion cut lands on frame 17. */
const OCC_LEN = 20;
const OCC_START = 14;
const OCC_TOTAL = 34;
const OCC_CUT = OCC_START + 3; // 17

async function occludeProject(root: string, dir: string): Promise<void> {
  const red = await makeColorClip(dir, 'red.mp4', 'red', OCC_LEN);
  const blue = await makeColorClip(dir, 'blue.mp4', 'blue', OCC_LEN);
  const occluder = await makeStill(dir, 'occluder.png', 'lime');
  await fs.mkdir(nodePath.join(root, 'assets'), { recursive: true });
  await fs.copyFile(red, nodePath.join(root, 'assets/red.mp4'));
  await fs.copyFile(blue, nodePath.join(root, 'assets/blue.mp4'));
  await fs.copyFile(occluder, nodePath.join(root, 'assets/occluder.png'));
  const assets = [
    await asset(root, 'assets/red.mp4', 'pl_a', 'video'),
    await asset(root, 'assets/blue.mp4', 'pl_b', 'video'),
    await asset(root, 'assets/occluder.png', 'occl', 'image'),
  ];
  const placements: Placement[] = [
    { id: 'place_a', shot: 'shot', asset: 'pl_a', inFrame: 0, outFrame: OCC_LEN, startFrame: 0, audio: 'mute' },
    { id: 'place_b', shot: 'shot', asset: 'pl_b', inFrame: 0, outFrame: OCC_LEN, startFrame: OCC_START, audio: 'mute' },
  ];
  const transitions: Transition[] = [
    { from: 'place_a', to: 'place_b', kind: 'occlude', startFrame: OCC_START, endFrame: OCC_LEN, occluder: 'occl' },
  ];
  await writeProject(root, {
    schemaVersion: 1,
    id: 'occlude-frozen',
    revision: 1,
    title: 'Occlude frozen occluder',
    direction: { intent: 'test', looks: [{ id: 'look', description: 'look' }], transitions: [] },
    assets,
    bindings: {},
    sources: [],
    composition: {
      output: OUT,
      scenes: [{ id: 'scene', description: 'scene' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: 'shot', targetFrames: OCC_TOTAL }],
      placements,
      transitions,
      audio: [],
    },
  });
}

function finalPath(root: string, record: BuildRecord): string {
  const artifact = record.artifacts.find(a => a.id === record.result!.artifact)!;
  return nodePath.join(root, artifact.path);
}

test('the cut frame decodes the FROZEN occluder even when the author file is swapped mid-build', async () => {
  const work = await tempDir('occlude');
  const control = nodePath.join(work, 'control');
  const swapped = nodePath.join(work, 'swapped');
  await fs.mkdir(control, { recursive: true });
  await fs.mkdir(swapped, { recursive: true });
  try {
    await occludeProject(control, work);
    await occludeProject(swapped, work);

    // Control: no author change; the cut frame is the frozen lime occluder.
    const controlBuild = await buildProject(control);
    const controlFrame = classifyOcclude(await decodeFrame(finalPath(control, controlBuild), OCC_CUT, work));
    assert.ok(
      controlFrame.lime > 0.6,
      `control cut frame must be the lime occluder (got ${JSON.stringify(controlFrame)})`,
    );

    // Swap the LIVE author occluder to magenta DURING the freeze step (the test
    // seam fires while the snapshot path is linked), i.e. after the bytes were
    // frozen and before compose-video runs. A correct Build reads the snapshot.
    const magenta = nodePath.join(work, 'magenta.png');
    await makeStill(work, 'magenta.png', 'magenta');
    const liveOccluder = nodePath.join(swapped, 'assets/occluder.png');
    let swappedOnce = false;
    setContentLinkForTest(async (existing, target) => {
      if (!swappedOnce && target.endsWith(nodePath.sep + nodePath.join('assets', 'occluder.png'))) {
        swappedOnce = true;
        await fs.copyFile(magenta, liveOccluder);
      }
      await fs.link(existing, target);
    });
    let swappedBuild: BuildRecord;
    try {
      swappedBuild = await buildProject(swapped);
    } finally {
      setContentLinkForTest(undefined);
    }
    assert.ok(swappedOnce, 'the seam must have swapped the author occluder');
    const swappedFrame = classifyOcclude(await decodeFrame(finalPath(swapped, swappedBuild), OCC_CUT, work));
    assert.ok(
      swappedFrame.magenta < 0.1 && swappedFrame.lime > 0.6,
      `the cut frame must decode the FROZEN lime occluder, not the live magenta file (got ${JSON.stringify(swappedFrame)})`,
    );
    // The swap is still diagnosed (stale = diagnosis only), but the bytes are
    // NOT the live author file.
    assert.equal(swappedBuild.stale, true, 'the mid-build author swap is reported as stale');
    assert.equal(
      swappedBuild.result!.artifact === controlBuild.result!.artifact,
      true,
      'identical frozen inputs reuse the same compose artifact across projects',
    );
    // Restoring the author file rebuilds to the control bytes.
    await fs.copyFile(nodePath.join(control, 'assets/occluder.png'), liveOccluder);
    const restored = await buildProject(swapped);
    assert.equal(
      restored.artifacts.find(a => a.id === restored.result!.artifact)!.sha256,
      controlBuild.artifacts.find(a => a.id === controlBuild.result!.artifact)!.sha256,
      'after restoring the author file, a rebuild byte-equals the unmodified control',
    );
  } finally {
    setContentLinkForTest(undefined);
    await fs.rm(work, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// deterministic key order
// ---------------------------------------------------------------------------

const LOCALE_OBJECT = { z: 1, ä: 2, A: 3 };

function childStableHash(lang: string): string {
  const moduleUrl = new URL('../src/shared/hash.js', import.meta.url).href;
  const script = `import(${JSON.stringify(moduleUrl)}).then(m => process.stdout.write(m.stableHash(${JSON.stringify(LOCALE_OBJECT)})));`;
  return execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, LANG: lang, LC_ALL: lang },
  }).toString();
}

test('stableHash key order is locale-independent and code-unit ordered', () => {
  const en = childStableHash('en_US.UTF-8');
  const sv = childStableHash('sv_SE.UTF-8');
  assert.equal(en, sv, 'the same object must hash identically under different locales');
  // And it is a plain code-unit order, so the digest is a pure function of value.
  const expected = hash(JSON.stringify({ A: 3, z: 1, ä: 2 }));
  assert.equal(en, expected, 'keys must be ordered by code unit for a locale-free digest');
});

// ---------------------------------------------------------------------------
// validateProject reuses the authored-path policy
// ---------------------------------------------------------------------------

function baseProject(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'path-policy',
    revision: 1,
    title: 'Path policy',
    direction: { intent: 'test', looks: [{ id: 'look', description: 'look' }], transitions: [] },
    assets: [],
    bindings: {},
    sources: [],
    composition: {
      output: OUT,
      scenes: [{ id: 'scene', description: 'scene' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: 'shot', targetFrames: 2 }],
      placements: [{ id: 'edit', shot: 'shot', source: 'src', inFrame: 0, outFrame: 2, startFrame: 0, audio: 'mute' }],
      transitions: [],
      audio: [],
    },
    ...overrides,
  };
}

function pictureSource(entry: string, resources: string[] = []): Record<string, unknown> {
  return { id: 'src', kind: 'browser', output: 'picture', entry, resources, frames: 2 };
}

test('a Source entry under .viscraft/ or a credential file is refused at load', async () => {
  const dir = await tempDir('paths');
  try {
    const load = async (project: unknown): Promise<Project> => {
      await writeProject(dir, project);
      return loadProject(dir);
    };
    // A normal relative name still loads.
    await assert.doesNotReject(() => load(baseProject({ sources: [pictureSource('scene.html', ['assets/a.png'])] })));
    await assert.rejects(
      () => load(baseProject({ sources: [pictureSource('.viscraft/x.js')] })),
      /must not be stored under \.viscraft\//,
    );
    await assert.rejects(
      () => load(baseProject({ sources: [pictureSource('scene.html', ['.env'])] })),
      /must not package a credential file/,
    );
    // A handoff file is subject to the same policy.
    await assert.rejects(
      () =>
        load(
          baseProject({
            sources: [pictureSource('scene.html')],
            handoff: [{ path: '.viscraft/notes.md', role: 'notes' }],
          }),
        ),
      /must not (?:be stored under|live under) \.viscraft\//,
    );
    await assert.rejects(
      () =>
        load(baseProject({ sources: [pictureSource('scene.html')], handoff: [{ path: '.netrc', role: 'helper' }] })),
      /must not package a credential file/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// picture-role Source and occluder Asset
// ---------------------------------------------------------------------------

test('refuses a sound Source in a picture role and a bad occluder Asset', () => {
  const soundSource = {
    id: 'src',
    kind: 'browser',
    output: 'sound',
    entry: 'beep.js',
    durationSamples: 2,
    sampleRate: 48000,
  };
  assert.throws(
    () => validateProject(baseProject({ sources: [soundSource] })),
    /Placement edit references Source src, which produces sound, not picture/,
  );

  const occluderProject = (occluder: string, assets: unknown[]): Record<string, unknown> => ({
    ...baseProject(),
    assets,
    composition: {
      ...(baseProject().composition as Record<string, unknown>),
      placements: [
        { id: 'a', shot: 'shot', source: 'src', inFrame: 0, outFrame: 2, startFrame: 0, audio: 'mute' },
        { id: 'b', shot: 'shot', source: 'src', inFrame: 0, outFrame: 2, startFrame: 1, audio: 'mute' },
      ],
      transitions: [{ from: 'a', to: 'b', kind: 'occlude', startFrame: 1, endFrame: 2, occluder }],
    },
    sources: [pictureSource('scene.html')],
  });
  // Missing occluder Asset.
  assert.throws(
    () => validateProject(occluderProject('missing', [])),
    /names occluder Asset missing, which does not exist/,
  );
  // The occluder resolves but is not an image.
  assert.throws(
    () =>
      validateProject(
        occluderProject('v', [
          {
            id: 'v',
            revision: 1,
            path: 'assets/v.mp4',
            sha256: 'a'.repeat(64),
            type: 'video',
            rights: RIGHTS,
            simulated: false,
          },
        ]),
      ),
    /must be an image \(type "image"\)/,
  );
});

// ---------------------------------------------------------------------------
// slow-motion transition is legal
// ---------------------------------------------------------------------------

test('a slow-motion transition is judged on the effective duration, not the raw source length', () => {
  const prev = {
    id: 'a',
    shot: 'shot',
    asset: 'x',
    inFrame: 0,
    outFrame: 10,
    startFrame: 0,
    audio: 'mute',
    durationFrames: 24,
  } as unknown as Placement;
  const cur = {
    id: 'b',
    shot: 'shot',
    asset: 'y',
    inFrame: 0,
    outFrame: 20,
    startFrame: 12,
    audio: 'mute',
  } as unknown as Placement;
  // endOf(a)=24, b starts at 12 -> overlap 12. Raw `a` length is 10 (would block),
  // effective is 24 (legal, and 12 < 20 < 24).
  const transition = { from: 'a', to: 'b', kind: 'dissolve', startFrame: 12, endFrame: 24 } as Transition;
  const { blockers, contentFrames } = analyzeTimeline([prev, cur], [transition]);
  assert.equal(
    blockers.some(b => b.code === 'transition-overlap-too-long'),
    false,
    `a slow-motion transition must not be rejected (got ${JSON.stringify(blockers)})`,
  );
  assert.equal(contentFrames, 32, 'the content end uses the effective duration of the LAST placement');
});

// ---------------------------------------------------------------------------
// pure-state audio preflight
// ---------------------------------------------------------------------------

function audioProject(patch: Record<string, unknown>): FilmProject {
  return ProjectSchema.parse({
    ...baseProject({ sources: [pictureSource('scene.html')] }),
    composition: {
      ...(baseProject().composition as Record<string, unknown>),
      ...patch,
    },
  }) as FilmProject;
}

test('programme fade, empty ducking bus, mono pan and kept-audio range fail before production', () => {
  // Fade longer than the programme.
  assert.ok(
    compositionStateIssues(audioProject({ fade: { inFrames: 2, outFrames: 2 } })).some(
      i => i.code === 'programme-fade-too-long',
    ),
    'a fade longer than the programme (2 frames) must be flagged',
  );
  // Ducking bus with no members.
  assert.ok(
    compositionStateIssues(audioProject({ ducking: [{ target: 'music', control: 'vo' }] })).some(
      i => i.code === 'ducking-target-empty',
    ),
    'a ducking bus with no members must be flagged',
  );
  // Pan on a mono output.
  const mono = { ...OUT, channels: 1 };
  const { asset: signal } = makeSignalAsset({
    id: 'signal',
    path: 'audio/signal.wav',
    sampleRate: 48000,
    channels: 2,
    samples: 48000,
  });
  const monoProject = ProjectSchema.parse({
    ...baseProject({ sources: [pictureSource('scene.html')] }),
    assets: [signal],
    composition: {
      ...(baseProject().composition as Record<string, unknown>),
      output: mono,
      audio: [
        {
          id: 'clip',
          kind: 'asset',
          asset: signal.id,
          inSample: 0,
          startSample: 0,
          durationSamples: 48000,
          gain: 0.5,
          pan: -0.5,
        },
      ],
    },
  }) as FilmProject;
  assert.ok(compositionStateIssues(monoProject).some(i => i.code === 'pan-requires-stereo'));
  // A kept-audio lead that leaves the programme.
  assert.ok(
    compositionStateIssues(
      audioProject({
        placements: [
          {
            id: 'edit',
            shot: 'shot',
            source: 'src',
            inFrame: 0,
            outFrame: 2,
            startFrame: 0,
            audio: 'keep',
            audioLeadSamples: 4800,
          },
        ],
      }),
    ).some(i => i.code === 'kept-audio-before-programme'),
  );
});

// ---------------------------------------------------------------------------
// shared reusable-history predicate
// ---------------------------------------------------------------------------

function fakeBuild(status: BuildRecord['status'], id: string): BuildRecord {
  return {
    schemaVersion: 1,
    id,
    run: { id: 'r', goal: '' },
    plan: { operations: [] },
    revision: 1,
    snapshotHash: '',
    status,
    medium: 'picture',
    startedAt: '',
    operations: [],
    artifacts: [],
    takes: [],
  };
}

test('reusableHistory keeps completed builds (including failed) and drops running ones', () => {
  const builds = [fakeBuild('succeeded', 's'), fakeBuild('failed', 'f'), fakeBuild('running', 'r')];
  assert.deepEqual(
    reusableHistory(builds).map(b => b.id),
    ['s', 'f'],
    'a failed build with completed operations and a succeeded build are both reusable; a running one is not',
  );
});

// ---------------------------------------------------------------------------
// candidate validation and content reporting
// ---------------------------------------------------------------------------

test('candidate plans are validated by the shared helper', () => {
  const project = ProjectSchema.parse(baseProject({ sources: [pictureSource('scene.html')] })) as FilmProject;
  assert.equal(candidatePlanIssues(project, [{ shot: 'shot', sources: ['src'] }]).length, 0);
  assert.ok(
    candidatePlanIssues(project, [{ shot: 'missing', sources: ['src'] }]).some(i => /existing Shot/.test(i.message)),
  );
  assert.ok(
    candidatePlanIssues(project, [{ shot: 'shot', sources: ['src', 'src'] }]).some(i =>
      /unique existing/.test(i.message),
    ),
  );
  assert.ok(
    candidatePlanIssues(project, [
      { shot: 'shot', sources: ['src'] },
      { shot: 'shot', sources: ['src'] },
    ]).some(i => /duplicate Shot/.test(i.message)),
  );
});

// ---------------------------------------------------------------------------
// kept-audio pre-roll survives a speed change
// ---------------------------------------------------------------------------

/** A 64x48 clip whose audio is a 440 Hz tone over [0, 0.2s) and silence after. */
async function makeToneThenSilence(dir: string, name: string, frames: number): Promise<string> {
  const out = nodePath.join(dir, name);
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `color=c=black:size=64x48:rate=${FPS}`,
    '-f',
    'lavfi',
    '-i',
    `aevalsrc=0.8*sin(2*PI*440*t)*lt(t\\,0.2):s=48000:d=${(frames / 25).toFixed(3)}`,
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
    FPS,
    '-c:a',
    'aac',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-shortest',
    out,
  ]);
  return out;
}

async function decodeMono(file: string, dir: string): Promise<Float32Array> {
  const raw = nodePath.join(dir, `mono-${Math.random().toString(36).slice(2)}.f32`);
  await ffmpeg(['-i', file, '-vn', '-f', 'f32le', '-acodec', 'pcm_f32le', '-ar', '48000', '-ac', '1', raw]);
  const buf = await fs.readFile(raw);
  const out = new Float32Array(Math.floor(buf.length / 4));
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  await fs.rm(raw, { force: true });
  return out;
}

function rms(samples: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < Math.min(to, samples.length); i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, to - from));
}

test('a slow-motion placement keeps pre-roll audio from the original Take', async () => {
  const root = await tempDir('kept');
  const work = await tempDir('kept-assets');
  try {
    const src = await makeToneThenSilence(work, 'src.mp4', 20); // tone [0,0.2s), then silence
    await fs.mkdir(nodePath.join(root, 'assets'), { recursive: true });
    await fs.copyFile(src, nodePath.join(root, 'assets/src.mp4'));
    const placements: Placement[] = [
      // Filler at frame 0 so the slow placement can start at frame 10 (a gap is illegal).
      { id: 'fill', shot: 'shot', asset: 'src', inFrame: 0, outFrame: 10, startFrame: 0, audio: 'mute' },
      // Slow-mo: source [5,10) (silent), stretched to 15 frames, starting at frame 10.
      // A J-cut reads 4800 samples of pre-roll from the ORIGINAL Take at inFrame 5.
      {
        id: 'slow',
        shot: 'shot',
        asset: 'src',
        inFrame: 5,
        outFrame: 10,
        startFrame: 10,
        durationFrames: 15,
        audio: 'keep',
        audioLeadSamples: 4800,
      },
    ];
    await writeProject(root, {
      schemaVersion: 1,
      id: 'kept-lead',
      revision: 1,
      title: 'Kept lead after retime',
      direction: { intent: 'test', looks: [{ id: 'look', description: 'look' }], transitions: [] },
      assets: [await asset(root, 'assets/src.mp4', 'src', 'video')],
      bindings: {},
      sources: [],
      composition: {
        output: OUT,
        scenes: [{ id: 'scene', description: 'scene' }],
        shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: 'shot', targetFrames: 25 }],
        placements,
        transitions: [],
        audio: [],
      },
    });
    const record = await buildProject(root);
    const pcm = await decodeMono(finalPath(root, record), work);
    // startFrame 10 -> sample 19200; a 4800-sample lead -> pre-roll at [14400,19200).
    const leadEnergy = rms(pcm, 14400 + 200, 19200 - 200);
    const bodyEnergy = rms(pcm, 19200 + 2000, 19200 + 8000);
    assert.ok(
      leadEnergy > 0.05,
      `the J-cut pre-roll must be audible after a speed change (lead RMS ${leadEnergy.toFixed(4)}); a silent lead means the retimed body-only artifact was read`,
    );
    assert.ok(bodyEnergy < 0.02, `the slow-motion body is silent by construction (body RMS ${bodyEnergy.toFixed(4)})`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(work, { recursive: true, force: true });
  }
});
