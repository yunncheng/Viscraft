/**
 * Real Browser + FFmpeg verification that an authored stereo pan actually
 * follows the picture, that a pan-only edit preserves every picture identity,
 * and that the spatial field survives export/reopen.
 *
 * Authoring: this test ships its OWN tiny inline Canvas CodeScene (it does not
 * depend on any preset example). The scene paints a pure #ff0000 marker that
 * sweeps a known horizontal path; a single signal Asset clip carries a
 * `panAutomation` curve derived from exactly that path (pan = 2*(x - 0.5), so a
 * left marker is hard left, a centred marker is centred, a right marker is hard
 * right).
 *
 * Independent measurement (no subjective listening claim):
 *  - the marker's per-frame horizontal position is recovered from the RENDERED
 *    movie with the existing `trackReferenceMarker` marker tracker;
 *  - the movie's AAC audio is decoded to stereo f32 and a per-window
 *    inter-channel level difference ILD = 20*log10(rmsR/rmsL) is computed over
 *    the inner 50% of each output frame;
 *  - the marker X and the ILD are shown to share the same sign trend (Pearson
 *    and Spearman), the centred opening is near 0 dB and the extremes are
 *    strongly one-sided.
 *
 * Sign note: the measured ILD is defined here as rmsR/rmsL so that a rightward
 * marker gives a positive value and the trend correlation is clearly positive.
 * With the reciprocal convention (20*log10(rmsL/rmsR)) the same measurement
 * yields the same physical result with an inverted sign.
 *
 * Gated like the other e2e suites: it skips cleanly when no Chrome/Chromium
 * browser or no FFmpeg is installed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildProject } from '../src/build/build.js';
import { readBuilds } from '../src/project/build-records.js';
import { probeMedia } from '../src/backends/media/probe.js';
import { loadProject, saveProject, validateProject } from '../src/project/project.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { trackReferenceMarker } from '../src/operations/analysis/reference-motion.js';
import { findBrowser } from '../src/backends/browser/capture.js';
import { runCommand } from '../src/shared/process.js';
import { framesToSamples } from '../src/core/time.js';
import { ProjectSchema } from '../src/core/schema.js';
import type { Asset, Composition, Project, ReferenceTrack } from '../src/core/schema.js';
import { writeSignalAsset } from './audio-fixtures.js';

const WIDTH = 160;
const HEIGHT = 90;
const FPS = { numerator: 30, denominator: 1 } as const;
const RATE = 48000;
const FRAMES = 90; // 3 s at 30 fps
const SAMPLES = framesToSamples(FRAMES, FPS, RATE, 'ceil'); // 144000 exactly
const SAMPLES_PER_FRAME = (RATE * FPS.denominator) / FPS.numerator; // 1600
const MARKER_HALF = 8; // 16x16 marker: big enough to survive two H.264/yuv420p passes
const MARKER_COLOR: [number, number, number] = [255, 0, 0];
// A wide-but-safe tolerance: H.264/yuv420p shifts pure red slightly, while the
// blue background (#0033aa, b=170 > 100) can never match the b <= 100 requirement.
const MARKER_TOLERANCE = 100;

/** The authored horizontal path (normalised 0=left, 1=right): centred, dip left, sweep right. */
function pathU(frame: number): number {
  const s = frame / (FRAMES - 1);
  if (s < 0.15) return 0.5;
  if (s < 0.3) return 0.5 - (0.4 * (s - 0.15)) / 0.15;
  return 0.1 + (0.8 * (s - 0.3)) / 0.7;
}
/** Constant-power pan derived from the marker position; `scale` shrinks the amplitude. */
function panAt(u: number, scale: number): number {
  return Math.max(-1, Math.min(1, 2 * (u - 0.5) * scale));
}

const SCENE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;overflow:hidden;background:#0033aa}canvas{display:block}</style></head>
<body><canvas id="c"></canvas><script>
const FRAMES=${FRAMES}, HALF=${MARKER_HALF}, SIZE=${MARKER_HALF * 2};
function pathU(frame){const s=frame/(FRAMES-1);if(s<0.15)return 0.5;if(s<0.30)return 0.5-0.4*(s-0.15)/0.15;return 0.1+0.8*(s-0.30)/0.70;}
window.viscraft={render(ctx){const c=document.getElementById('c');c.width=ctx.width;c.height=ctx.height;const g=c.getContext('2d');
g.fillStyle='#0033aa';g.fillRect(0,0,c.width,c.height);
const u=pathU(ctx.frame);const x=Math.round(u*c.width);const y=Math.round(c.height/2);
g.fillStyle='#ff0000';g.fillRect(x-HALF,y-HALF,SIZE,SIZE);}};
</script></body></html>
`;

/** A single asset clip whose panAutomation follows the marker path (scale shrinks it). */
function passbyAudio(scale: number, asset: string): Composition['audio'] {
  const points: Array<{ sample: number; pan: number }> = [];
  for (let frame = 0; frame < FRAMES; frame++) {
    points.push({ sample: Math.round(frame * SAMPLES_PER_FRAME), pan: panAt(pathU(frame), scale) });
  }
  return [
    {
      id: 'passby',
      kind: 'asset',
      asset,
      inSample: 0,
      startSample: 0,
      durationSamples: SAMPLES,
      gain: 0.5,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      panAutomation: points,
    },
  ];
}

function spatialWork(scale: number, asset: Asset): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'spatial-passby',
    revision: 1,
    title: 'Spatial pass-by verification',
    direction: {
      intent: 'stereo pan follows the picture marker',
      looks: [{ id: 'look', description: 'identity' }],
      transitions: [],
    },
    assets: [asset],
    bindings: {},
    sources: [
      {
        id: 'scene',
        kind: 'browser',
        output: 'picture',
        entry: 'scene.html',
        resources: [],
        bindings: [],
        params: {},
        seed: 0,
        frames: FRAMES,
      },
    ],
    composition: {
      output: { width: WIDTH, height: HEIGHT, fps: FPS, sampleRate: RATE, channels: 2 },
      scenes: [{ id: 'scene', description: 'pass-by' }],
      shots: [
        {
          id: 'shot',
          scene: 'scene',
          look: 'look',
          intent: 'marker pass-by over a following stereo pan',
          targetFrames: FRAMES,
        },
      ],
      placements: [
        { id: 'edit', shot: 'shot', source: 'scene', inFrame: 0, outFrame: FRAMES, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio: passbyAudio(scale, asset.id),
    },
  });
}

// --- tiny statistics helpers -------------------------------------------------

function pearson(x: number[], y: number[]): number {
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0,
    sxx = 0,
    syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx,
      dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxy / Math.sqrt(sxx * syy);
}
function ranks(values: number[]): number[] {
  const order = values.map((value, index) => [value, index] as const).sort((a, b) => a[0] - b[0]);
  const result = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const average = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) result[order[k][1]] = average;
    i = j + 1;
  }
  return result;
}
function spearman(x: number[], y: number[]): number {
  return pearson(ranks(x), ranks(y));
}
function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}
function maxAbs(values: number[]): number {
  return values.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
}

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Decode a movie's audio to interleaved stereo f32 at the composition clock. */
async function decodeStereo(path: string, scratch: string): Promise<Float32Array> {
  const out = join(scratch, `pcm-${Math.random().toString(36).slice(2)}.f32`);
  await runCommand('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-i',
    path,
    '-map',
    '0:a:0',
    '-vn',
    '-f',
    'f32le',
    '-acodec',
    'pcm_f32le',
    '-ar',
    String(RATE),
    '-ac',
    '2',
    out,
  ]);
  const bytes = await readFile(out);
  const total = Math.floor(bytes.length / 4);
  const samples = new Float32Array(total);
  for (let i = 0; i < total; i++) samples[i] = bytes.readFloatLE(i * 4);
  return samples;
}

/** Per-frame ILD (dB) over the inner 50% of each output frame, rmsR/rmsL. */
function ildSeries(audio: Float32Array): number[] {
  const series: number[] = [];
  for (let frame = 0; frame < FRAMES; frame++) {
    const start = Math.round(frame * SAMPLES_PER_FRAME);
    const from = start + Math.round(SAMPLES_PER_FRAME * 0.25);
    const to = start + Math.round(SAMPLES_PER_FRAME * 0.75);
    let sumL = 0,
      sumR = 0,
      count = 0;
    for (let s = from; s < to; s++) {
      const left = audio[s * 2],
        right = audio[s * 2 + 1];
      if (!Number.isFinite(left) || !Number.isFinite(right)) continue;
      sumL += left * left;
      sumR += right * right;
      count++;
    }
    const rmsL = Math.sqrt(sumL / count),
      rmsR = Math.sqrt(sumR / count);
    series.push(20 * Math.log10((rmsR + 1e-9) / (rmsL + 1e-9)));
  }
  return series;
}

/** Recover the marker's normalised X per output frame from a reference-track report. */
function markerSeries(track: ReferenceTrack): Array<number | null> {
  const series = new Array<number | null>(FRAMES).fill(null);
  for (const frame of track.frames) {
    if (frame.present && frame.x !== null && frame.outputFrame >= 0 && frame.outputFrame < FRAMES)
      series[frame.outputFrame] = frame.x;
  }
  return series;
}

function paired(marker: Array<number | null>, ild: number[]): { x: number[]; y: number[] } {
  const x: number[] = [],
    y: number[] = [];
  for (let f = 0; f < FRAMES; f++) {
    const m = marker[f];
    if (m !== null && Number.isFinite(ild[f])) {
      x.push(m);
      y.push(ild[f]);
    }
  }
  return { x, y };
}

const browserAvailable = await findBrowser().then(
  () => true,
  () => false,
);
const ffmpegAvailable = await runCommand('ffmpeg', ['-version']).then(
  () => true,
  () => false,
);
const e2eSkip =
  browserAvailable && ffmpegAvailable
    ? false
    : `needs a Chrome/Chromium browser and FFmpeg (browser=${browserAvailable}, ffmpeg=${ffmpegAvailable})`;

test(
  'authored stereo pan follows the rendered picture marker and survives pan-only edits and export',
  { skip: e2eSkip },
  async () => {
    const root = await tempDir('viscraft-spatial-e2e-');
    const exported = `${root}-export`;
    try {
      const signal = await writeSignalAsset(root, {
        id: 'passby_signal',
        path: 'signal.wav',
        sampleRate: RATE,
        channels: 2,
        samples: SAMPLES,
      });
      await writeFile(join(root, 'scene.html'), SCENE_HTML);
      await writeFile(join(root, 'project.json'), JSON.stringify(validateProject(spatialWork(1, signal))));

      // --- 1. Real production build with genuine stereo ---------------------
      const build1 = await buildProject(root);
      assert.equal(build1.status, 'succeeded');
      const final1 = build1.artifacts.find(artifact => artifact.id === build1.result!.artifact)!;
      const delivered1 = await probeMedia(join(root, final1.path));
      assert(/h264|avc/i.test(delivered1.videoCodec), 'the delivery must be a real H.264 movie');
      assert.equal(delivered1.frames, FRAMES);
      assert(delivered1.audio, 'the delivery must carry audio');
      assert.equal(delivered1.audio!.sampleRate, RATE);
      assert.equal(delivered1.audio!.channels, 2, 'the delivery must be real stereo, not dual-mono-downmixed');
      assert(
        Math.abs(delivered1.audio!.duration - SAMPLES / RATE) <= 1 / RATE,
        'the delivered audio must cover the exact authored span',
      );

      // --- 2. Recover the marker's actual X from the rendered movie ---------
      const track = await trackReferenceMarker(root, final1.path, { color: MARKER_COLOR, tolerance: MARKER_TOLERANCE });
      assert.equal(track.frames.length, FRAMES, 'the tracker must decode every output frame');
      const marker = markerSeries(track);
      const present = marker.filter(value => value !== null) as number[];
      assert.ok(
        present.length >= FRAMES * 0.9,
        `the marker must be recovered on most frames (got ${present.length}/${FRAMES})`,
      );
      assert.ok(
        Math.max(...present) - Math.min(...present) > 0.6,
        'the recovered marker must actually sweep across the frame',
      );

      // --- 3. Decode the movie audio and correlate ILD with the marker ------
      const audio1 = await decodeStereo(join(root, final1.path), root);
      const ild1 = ildSeries(audio1);
      const pairs1 = paired(marker, ild1);
      assert.ok(pairs1.x.length >= FRAMES * 0.9, 'enough frames must pair a marker position with decoded stereo');
      const corr1 = pearson(pairs1.x, pairs1.y);
      const rank1 = spearman(pairs1.x, pairs1.y);
      assert.ok(corr1 > 0.7, `marker X and ILD must trend together (Pearson ${corr1})`);
      assert.ok(rank1 > 0.85, `marker X and ILD must be rank-concordant (Spearman ${rank1})`);

      // Centred opening is near 0 dB; the left and right extremes are one-sided.
      const centredOpening = ild1.slice(2, 12);
      const leftExtreme = ild1.slice(24, 29);
      const rightExtreme = ild1.slice(84, 89);
      assert.ok(
        mean(centredOpening.map(Math.abs)) < 3,
        `the centred opening must be near 0 dB ILD (|mean| ${mean(centredOpening.map(Math.abs))})`,
      );
      assert.ok(
        Math.min(...leftExtreme) < -6,
        `the left extreme must be left-dominant (min ${Math.min(...leftExtreme)} dB)`,
      );
      assert.ok(
        Math.max(...rightExtreme) > 6,
        `the right extreme must be right-dominant (max ${Math.max(...rightExtreme)} dB)`,
      );
      console.log(
        `[spatial] baseline: Pearson=${corr1.toFixed(3)} Spearman=${rank1.toFixed(3)} ILD left=${Math.min(...leftExtreme).toFixed(1)}dB centre=${mean(centredOpening.map(Math.abs)).toFixed(2)}dB right=${Math.max(...rightExtreme).toFixed(1)}dB`,
      );

      const code1 = build1.operations.find(op => op.kind === 'browser')!;
      const compose1 = build1.operations.find(op => op.kind === 'compose-video')!;
      const mix1 = build1.operations.find(op => op.kind === 'mix-audio')!;
      const result1 = build1.result!.artifact;
      const takeIds1 = build1.takes.map(take => take.id);

      // --- 4. Pan-only edit: every picture identity reused, only mix/mux rerun
      const edited = await loadProject(root);
      edited.composition!.audio = passbyAudio(0.5, signal.id);
      await saveProject(root, edited, edited.revision);
      const build2 = await buildProject(root);
      assert.equal(build2.status, 'succeeded');
      assert.deepEqual(
        build2.takes.map(take => take.id),
        takeIds1,
        'a pan-only edit must not change any Take identity',
      );
      for (const [label, before] of [
        ['code', code1],
        ['compose-video', compose1],
      ] as const) {
        const after = build2.operations.find(op => op.id === before.id)!;
        assert(after, `${label} must still be present`);
        assert.equal(after.reused, true, `${label} must reuse on a pan-only edit`);
        assert.equal(
          after.artifact,
          before.artifact,
          `${label} artifact identity must be preserved on a pan-only edit`,
        );
      }
      const mix2 = build2.operations.find(op => op.kind === 'mix-audio')!;
      const mux2 = build2.operations.find(op => op.kind === 'mux-final')!;
      assert.equal(mix2.reused, false, 'a pan-only edit must actually re-run mix-audio');
      assert.notEqual(mix2.artifact, mix1.artifact, 'a changed pan must produce a distinct mix artifact');
      assert.equal(mux2.reused, false, 'a pan-only edit must re-run the final mux');
      assert(!build2.operations.some(op => op.kind === 'master-audio'), 'no mastering was authored');
      assert.notEqual(build2.result!.artifact, result1, 'the re-panned movie is a distinct Result');

      const final2 = build2.artifacts.find(artifact => artifact.id === build2.result!.artifact)!;
      const audio2 = await decodeStereo(join(root, final2.path), root);
      const ild2 = ildSeries(audio2);
      const pairs2 = paired(marker, ild2); // the picture is reused, so the marker series is identical
      const corr2 = pearson(pairs2.x, pairs2.y);
      assert.ok(corr2 > 0.6, `the halved pan must still follow the marker (Pearson ${corr2})`);
      assert.ok(
        maxAbs(ild2) < maxAbs(ild1) * 0.6,
        `halving the pan must shrink the ILD range (${maxAbs(ild2)} vs ${maxAbs(ild1)})`,
      );
      assert.ok(maxAbs(ild2) > 2, `the halved pan must remain clearly one-sided (max |ILD| ${maxAbs(ild2)})`);
      console.log(
        `[spatial] pan-only edit: Pearson=${corr2.toFixed(3)} max|ILD| ${maxAbs(ild2).toFixed(1)}dB (baseline ${maxAbs(ild1).toFixed(1)}dB)`,
      );

      // --- 5. A failed build preserves the active Result --------------------
      const activeAfterEdit = await readFile(join(root, '.viscraft/result.json'), 'utf8');
      const broken = await loadProject(root);
      const hot = (id: string): Composition['audio'][number] => ({
        id,
        kind: 'asset',
        asset: signal.id,
        inSample: 0,
        startSample: 0,
        durationSamples: SAMPLES,
        gain: 1,
        fadeInSamples: 0,
        fadeOutSamples: 0,
        pan: -1,
      });
      broken.composition!.audio = [hot('hotA'), hot('hotB')];
      await saveProject(root, broken, broken.revision);
      await assert.rejects(
        buildProject(root),
        /overload|lower clip gains/,
        'two hard-left full-gain clips must overload',
      );
      assert.equal(
        await readFile(join(root, '.viscraft/result.json'), 'utf8'),
        activeAfterEdit,
        'a failed spatial build must not replace the active Result',
      );
      const failed = (await readBuilds(root)).find(build => build.status === 'failed');
      assert(failed, 'the overloaded build must be recorded as failed');
      assert.equal(failed.result, undefined, 'a failed build must not record a Result');

      // --- 6. Restore the valid edit and export/reopen ----------------------
      const restored = await loadProject(root);
      restored.composition!.audio = passbyAudio(0.5, signal.id);
      await saveProject(root, restored, restored.revision);
      const build3 = await buildProject(root);
      assert.equal(build3.status, 'succeeded');
      assert(
        build3.operations.every(op => op.reused),
        'restoring the valid pan must reuse every cached operation',
      );
      assert.equal(
        build3.result!.artifact,
        build2.result!.artifact,
        'restoring the valid pan reproduces the edited Result identity',
      );

      const portable = await exportProject(root, exported);
      assert.equal(portable.simulated, false);
      const reopened = await buildProject(exported);
      assert(
        reopened.operations.every(op => op.reused),
        'the exported spatial work must reuse every operation within this runtime',
      );
      assert.deepEqual(
        reopened.takes.map(take => take.id),
        takeIds1,
        'portable export must preserve Take identities',
      );

      const reopenedFinal = reopened.artifacts.find(artifact => artifact.id === reopened.result!.artifact)!;
      const reopenedMedia = await probeMedia(join(exported, reopenedFinal.path));
      assert.equal(reopenedMedia.audio!.channels, 2, 'the reopened delivery must still be stereo');
      assert.equal(reopenedMedia.audio!.sampleRate, RATE);
      const audio3 = await decodeStereo(join(exported, reopenedFinal.path), exported);
      const ild3 = ildSeries(audio3);
      const pairs3 = paired(marker, ild3);
      assert.ok(
        pearson(pairs3.x, pairs3.y) > 0.6,
        'the reopened delivery must preserve the picture-following pan trend',
      );
      assert.ok(maxAbs(ild3) > 2, 'the reopened delivery must preserve the channel split');
      assert.ok(mean(ild3.slice(2, 12).map(Math.abs)) < 2, 'the reopened centred opening must stay near 0 dB ILD');
      console.log(
        `[spatial] export/reopen: Pearson=${pearson(pairs3.x, pairs3.y).toFixed(3)} max|ILD| ${maxAbs(ild3).toFixed(1)}dB channels=${reopenedMedia.audio!.channels}`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(exported, { recursive: true, force: true });
    }
  },
);
