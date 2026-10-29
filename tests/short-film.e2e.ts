/**
 * ONE end-to-end short film from a text brief, code-only (no provider).
 *
 * This run goes from a brief to a two-shot, two-score programme and then to
 * a delivered movie, and observes reuse and provenance:
 *
 *  - the brief names two shots; both pictures and both scores are authored
 *    `browser` CodeScenes, and the project declares NO provider and NO simulated
 *    Source — the film is real without any external service;
 *  - `buildProject` succeeds with real H.264 + stereo AAC covering both shots;
 *  - each shot contributes its own score Take (two browser audio Takes), and an
 *    unchanged rebuild reuses every operation with byte-identical audio Takes;
 *  - `deliverProject` ships the movie and an editable project export, whose facts
 *    page and VISCRAFT.md name every authored Source as provenance;
 *  - the exported copy reopens and re-delivers the same movie.
 *
 * Gated like the other real-browser suites: it skips cleanly when no
 * Chrome/Chromium or no FFmpeg is installed.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { buildProject } from '../src/build/build.js';
import { deliverProject } from '../src/operations/delivery/delivery.js';
import { loadProject } from '../src/project/project.js';
import { probeMedia } from '../src/backends/media/probe.js';
import { findBrowser } from '../src/backends/browser/capture.js';
import { runCommand } from '../src/shared/process.js';
import { hashFile } from '../src/shared/hash.js';
import { framesToSamples } from '../src/core/time.js';
import { ProjectSchema, type BuildRecord, type Fps, type Project } from '../src/core/schema.js';

const WIDTH = 160;
const HEIGHT = 90;
const FPS: Fps = { numerator: 24, denominator: 1 };
const RATE = 48000;
const SHOT_FRAMES = 12;
const TOTAL_FRAMES = SHOT_FRAMES * 2;
const SHOT_SAMPLES = framesToSamples(SHOT_FRAMES, FPS, RATE, 'ceil'); // 24000

/** A deterministic Canvas CodeScene; `params.tint`/`params.shape` vary the shot. */
function sceneHtml(tint: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;overflow:hidden;background:${tint}}canvas{display:block}</style></head>
<body><canvas id="c"></canvas><script>
window.viscraft = { render(ctx) {
  var c = document.getElementById('c'); c.width = ctx.width; c.height = ctx.height;
  var g = c.getContext('2d');
  g.fillStyle = '${tint}'; g.fillRect(0, 0, c.width, c.height);
  var p = ctx.params || {};
  g.fillStyle = p.color || '#ffffff';
  if (p.shape === 'circle') {
    g.beginPath();
    g.arc(8 + ((ctx.frame * 6) % (c.width - 16)), c.height / 2, 7, 0, Math.PI * 2);
    g.fill();
  } else {
    g.fillRect(4 + ((ctx.frame * 4) % (c.width - 16)), 4, 12, 12);
  }
} };
</script></body></html>
`;
}

/** A deterministic, dependency-free score; `params.frequency` sets the pitch. */
function scoreHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
window.viscraftSound = {
  ready: function () { return Promise.resolve(); },
  dispose: function () {},
  render: function (ctx) {
    var rate = ctx.sampleRate, channels = ctx.channels, samples = ctx.samples;
    var params = ctx.params || {};
    var freq = Number(params.frequency != null ? params.frequency : 220);
    var peak = Number(params.peak != null ? params.peak : 0.4);
    var out = new Float32Array(samples * channels);
    for (var i = 0; i < samples; i++) {
      var t = i / rate;
      var attack = Math.min(1, i / (rate * 0.02));
      var release = Math.min(1, (samples - i) / (rate * 0.03));
      var v = Math.sin(2 * Math.PI * freq * t) * peak * attack * release;
      for (var c = 0; c < channels; c++) out[i * channels + c] = v;
    }
    return out;
  }
};
</script></body></html>
`;
}

const ENTRIES: Record<string, string> = {
  'scene_a.html': sceneHtml('#0b1f4d'),
  'scene_b.html': sceneHtml('#4d0b1f'),
  'score_a.html': scoreHtml(),
  'score_b.html': scoreHtml(),
};

/** The brief a creator would give: two shots, a score under each, one cut. */
const BRIEF = {
  title: 'Two-shot code film',
  intent: 'a two-shot code film: an opening blue field then a red field, each with its own score',
};

function shortFilmWork(): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'short_film_code',
    revision: 1,
    title: BRIEF.title,
    direction: { intent: BRIEF.intent, looks: [{ id: 'look', description: 'flat code' }], transitions: [] },
    assets: [],
    bindings: {},
    sources: [
      {
        id: 'scene_a',
        kind: 'browser',
        output: 'picture',
        entry: 'scene_a.html',
        frames: SHOT_FRAMES,
        params: { shape: 'block' },
      },
      {
        id: 'scene_b',
        kind: 'browser',
        output: 'picture',
        entry: 'scene_b.html',
        frames: SHOT_FRAMES,
        params: { shape: 'circle' },
      },
      {
        id: 'score_a',
        kind: 'browser',
        output: 'sound',
        entry: 'score_a.html',
        params: { frequency: 220 },
        seed: 3,
        durationSamples: SHOT_SAMPLES,
        sampleRate: RATE,
      },
      {
        id: 'score_b',
        kind: 'browser',
        output: 'sound',
        entry: 'score_b.html',
        params: { frequency: 330 },
        seed: 5,
        durationSamples: SHOT_SAMPLES,
        sampleRate: RATE,
      },
    ],
    composition: {
      output: { width: WIDTH, height: HEIGHT, fps: FPS, sampleRate: RATE, channels: 2 },
      scenes: [{ id: 'scene', description: 'two-shot code film' }],
      shots: [
        { id: 'shot_a', scene: 'scene', look: 'look', intent: 'opening field', targetFrames: SHOT_FRAMES },
        { id: 'shot_b', scene: 'scene', look: 'look', intent: 'second field', targetFrames: SHOT_FRAMES },
      ],
      placements: [
        {
          id: 'cut_a',
          shot: 'shot_a',
          source: 'scene_a',
          inFrame: 0,
          outFrame: SHOT_FRAMES,
          startFrame: 0,
          audio: 'mute',
        },
        {
          id: 'cut_b',
          shot: 'shot_b',
          source: 'scene_b',
          inFrame: 0,
          outFrame: SHOT_FRAMES,
          startFrame: SHOT_FRAMES,
          audio: 'mute',
        },
      ],
      transitions: [],
      audio: [
        {
          id: 'score_a_clip',
          kind: 'source',
          source: 'score_a',
          startSample: 0,
          gain: 0.7,
          fadeInSamples: 0,
          fadeOutSamples: 0,
          pan: -0.5,
        },
        {
          id: 'score_b_clip',
          kind: 'source',
          source: 'score_b',
          startSample: SHOT_SAMPLES,
          gain: 0.7,
          fadeInSamples: 0,
          fadeOutSamples: 0,
          pan: 0.5,
        },
      ],
    },
  });
}

/** The audio Take artifacts a build produced from a `browser` sound Source. */
function soundTakeArtifacts(build: BuildRecord) {
  return build.artifacts.filter(artifact => artifact.operation === 'browser' && artifact.kind === 'audio');
}

async function writeWork(root: string, project: Project): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(nodePath.join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  for (const [name, body] of Object.entries(ENTRIES)) await fs.writeFile(nodePath.join(root, name), body);
}

const browserAvailable = await findBrowser().then(
  () => true,
  () => false,
);
const ffmpegAvailable = await runCommand('ffmpeg', ['-version']).then(
  () => true,
  () => false,
);
const skip =
  browserAvailable && ffmpegAvailable
    ? false
    : `needs a Chrome/Chromium browser and FFmpeg (browser=${browserAvailable}, ffmpeg=${ffmpegAvailable})`;

test('a brief becomes a two-shot code film with sound, is delivered, and reuses on rebuild', { skip }, async () => {
  const parent = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-short-film-'));
  const root = nodePath.join(parent, 'authoring');
  const bundle = nodePath.join(parent, 'bundle');
  try {
    const work = shortFilmWork();
    // The film is code-only: no provider, no simulated Source anywhere.
    assert.equal(work.sources.length, 4, 'the brief names four code Sources');
    assert.ok(
      work.sources.every(source => source.kind === 'browser'),
      'every Source must be a code Source',
    );
    assert.equal(work.composition!.shots.length, 2, 'the brief has two shots');
    assert.equal(work.sources.filter(source => source.output === 'sound').length, 2, 'each shot carries a score');
    await writeWork(root, work);

    // 1. Real production build: two shots, one cut, two scores, a sounded movie.
    const first = await buildProject(root);
    assert.equal(first.status, 'succeeded', JSON.stringify(first.error));
    assert.equal(first.result!.simulated, false, 'a code-only film is not simulated');
    const final = first.artifacts.find(artifact => artifact.id === first.result!.artifact)!;
    const info = await probeMedia(nodePath.join(root, final.path));
    assert.match(info.videoCodec, /h264|avc/i, `the film must be real H.264 (got ${info.videoCodec})`);
    assert.equal(info.frames, TOTAL_FRAMES, 'the film must cover both shots');
    assert.ok(info.audio, 'the film must carry audio');
    assert.equal(info.audio!.channels, 2, 'the film must be real stereo');
    assert.equal(info.audio!.sampleRate, RATE);
    assert.ok(
      Math.abs(info.audio!.duration - TOTAL_FRAMES / (FPS.numerator / FPS.denominator)) <= 1 / RATE,
      'the audio must cover the authored span',
    );

    // Two distinct shot scores, each rendered as its own Take.
    const soundTakes = soundTakeArtifacts(first);
    assert.equal(soundTakes.length, 2, 'each score Source renders its own audio Take');
    assert.equal(new Set(soundTakes.map(artifact => artifact.sha256)).size, 2, 'the two scores must differ');
    for (const artifact of soundTakes)
      assert.equal(
        await hashFile(nodePath.join(root, artifact.path)),
        artifact.sha256,
        'the recorded audio sha256 must match the bytes',
      );

    // 2. Rebuilding the same brief reuses everything, including both scores.
    const second = await buildProject(root);
    assert.equal(second.status, 'succeeded');
    assert.ok(
      second.operations.every(operation => operation.reused),
      'an unchanged rebuild must reuse every operation',
    );
    assert.equal(second.result!.artifact, first.result!.artifact, 'the result identity must be preserved');
    assert.deepEqual(
      soundTakeArtifacts(second)
        .map(artifact => artifact.sha256)
        .sort(),
      soundTakes.map(artifact => artifact.sha256).sort(),
      'both score Takes must be reused byte-for-byte, never re-rendered',
    );

    // 3. Deliver: the movie plus an editable project export that names the brief.
    const delivery = await deliverProject(root, bundle, { review: true, stems: true });
    assert.equal(delivery.movie!.sha256, await hashFile(nodePath.join(bundle, 'movie', 'final.mp4')));
    const manifest = JSON.parse(await fs.readFile(nodePath.join(bundle, 'delivery-manifest.json'), 'utf8')) as {
      files: Array<{ path: string; sha256: string }>;
    };
    for (const file of manifest.files)
      assert.equal(await hashFile(nodePath.join(bundle, file.path)), file.sha256, `hash matches for ${file.path}`);

    // Provenance: the facts page and VISCRAFT.md name every authored Source.
    const facts = await fs.readFile(nodePath.join(bundle, 'index.html'), 'utf8');
    for (const id of ['scene_a', 'scene_b', 'score_a', 'score_b']) {
      assert.ok(facts.includes(id), `the facts page must name Source ${id}`);
      assert.ok(
        (await fs.readFile(nodePath.join(bundle, 'project', '.viscraft', 'pages', 'VISCRAFT.md'), 'utf8')).includes(id),
        `VISCRAFT.md must name Source ${id}`,
      );
    }

    // 4. The export reopens with both shots + scores and re-delivers the same movie.
    const reopened = await loadProject(nodePath.join(bundle, 'project'));
    assert.equal(reopened.composition!.shots.length, 2);
    assert.equal(reopened.composition!.audio.length, 2);
    assert.equal(reopened.sources.length, 4);

    const rebuilt = await buildProject(nodePath.join(bundle, 'project'));
    assert.ok(
      rebuilt.operations.every(operation => operation.reused),
      'the exported film must rebuild with full reuse',
    );
    const bundle2 = nodePath.join(parent, 'bundle2');
    await deliverProject(nodePath.join(bundle, 'project'), bundle2, { review: true, stems: true });
    assert.equal(
      await hashFile(nodePath.join(bundle2, 'movie', 'final.mp4')),
      delivery.movie!.sha256,
      'redelivery must reproduce the same movie',
    );
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
