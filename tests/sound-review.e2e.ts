/**
 * End-to-end review and delivery of a code-authored `sound` Source.
 *
 * A sound Take is an audio-only WAV. Review reports its real audio facts
 * without requiring or fabricating a video stream; delivery preserves them.
 * The checks cover:
 *   1. build a project whose soundtrack is a code-authored `sound` Source;
 *   2. run `reviewBuild` and assert it succeeds and reports the audio Take's real
 *      audio facts (sample rate / channels / duration / sample count) and does
 *      NOT fabricate picture facts for it;
 *   3. run `deliverProject` on the same project and assert the bundle is produced
 *      with the truthful review report;
 *   4. build a project with NO sound Takes and assert the review report's Take
 *      entries carry the required video-Take facts (and no audio-only fields).
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
import { reviewBuild } from '../src/operations/analysis/review.js';
import { deliverProject } from '../src/operations/delivery/delivery.js';
import { probeAudio } from '../src/backends/media/probe.js';
import { findBrowser } from '../src/backends/browser/capture.js';
import { runCommand } from '../src/shared/process.js';
import { framesToSamples } from '../src/core/time.js';
import { ProjectSchema, type Project } from '../src/core/schema.js';
import { makeSignalAsset } from './audio-fixtures.js';

const WIDTH = 160;
const HEIGHT = 90;
const FPS = { numerator: 30, denominator: 1 } as const;
const RATE = 48000;
const FRAMES = 30; // 1 s at 30 fps -> 48000 samples
const SAMPLES = framesToSamples(FRAMES, FPS, RATE, 'ceil');

const SCENE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;overflow:hidden;background:#102040}canvas{display:block}</style></head>
<body><canvas id="c"></canvas><script>
window.viscraft = { render(ctx) {
  const c = document.getElementById('c'); c.width = ctx.width; c.height = ctx.height;
  const g = c.getContext('2d');
  g.fillStyle = '#102040'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#ffcc00'; g.fillRect(4 + ((ctx.frame * 5) % (c.width - 12)), 4, 10, 10);
} };
</script></body></html>
`;

/** Deterministic OfflineAudioContext graph returning `{ channels: Float32Array[] }`. */
const SOUND_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
window.viscraftSound = {
  ready: function () { return Promise.resolve(); },
  dispose: function () {},
  render: function (ctx) {
    var sampleRate = ctx.sampleRate, channels = ctx.channels, samples = ctx.samples;
    var dur = samples / sampleRate;
    var oc = new OfflineAudioContext(channels, samples, sampleRate);
    var osc = oc.createOscillator(); osc.type = 'sine'; osc.frequency.value = 329.63;
    var g = oc.createGain();
    var attack = Math.min(0.01, dur / 4), release = Math.min(0.03, dur / 4);
    g.gain.setValueAtTime(0, 0);
    g.gain.linearRampToValueAtTime(0.4, attack);
    g.gain.setValueAtTime(0.4, Math.max(attack, dur - release));
    g.gain.linearRampToValueAtTime(0, dur);
    osc.connect(g); g.connect(oc.destination); osc.start(0); osc.stop(dur);
    return oc.startRendering().then(function (buffer) {
      var out = [];
      for (var c = 0; c < channels; c++) out.push(Float32Array.from(buffer.getChannelData(c)));
      return { channels: out };
    });
  }
};
</script></body></html>
`;

const ENTRIES: Record<string, string> = { 'scene.html': SCENE_HTML, 'sound.html': SOUND_HTML };

const BASELINE_SIGNAL = makeSignalAsset({
  id: 'bed',
  path: 'signal.wav',
  sampleRate: RATE,
  channels: 2,
  samples: SAMPLES,
  frequency: 440,
});

/** A canvas picture whose soundtrack is a code-authored `sound` Source (or a registered signal Asset when false). */
function work(withSound: boolean): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: withSound ? 'sound-review-e2e' : 'no-sound-review-e2e',
    revision: 1,
    title: withSound ? 'Code-authored sound under review' : 'Signal-only baseline',
    direction: { intent: 'sound review regression', looks: [{ id: 'look', description: 'identity' }], transitions: [] },
    assets: withSound ? [] : [BASELINE_SIGNAL.asset],
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
      ...(withSound
        ? [
            {
              id: 'snd',
              kind: 'browser',
              output: 'sound',
              entry: 'sound.html',
              resources: [],
              params: {},
              seed: 7,
              durationSamples: SAMPLES,
              sampleRate: RATE,
            },
          ]
        : []),
    ],
    composition: {
      output: { width: WIDTH, height: HEIGHT, fps: FPS, sampleRate: RATE, channels: 2 },
      scenes: [{ id: 'scene', description: 'sound review regression' }],
      shots: [
        {
          id: 'shot',
          scene: 'scene',
          look: 'look',
          intent: 'canvas picture under authored sound',
          targetFrames: FRAMES,
        },
      ],
      placements: [
        { id: 'edit', shot: 'shot', source: 'scene', inFrame: 0, outFrame: FRAMES, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio: withSound
        ? [
            {
              id: 'score',
              kind: 'source',
              source: 'snd',
              startSample: 0,
              gain: 0.8,
              fadeInSamples: 0,
              fadeOutSamples: 0,
            },
          ]
        : [
            {
              id: 'score',
              kind: 'asset',
              asset: 'bed',
              inSample: 0,
              startSample: 0,
              durationSamples: SAMPLES,
              gain: 0.3,
              fadeInSamples: 0,
              fadeOutSamples: 0,
            },
          ],
    },
  });
}

async function writeWork(dir: string, project: Project): Promise<void> {
  await writeFile(join(dir, 'project.json'), JSON.stringify(project, null, 2));
  for (const [name, body] of Object.entries(ENTRIES)) await writeFile(join(dir, name), body);
  if (project.assets.some(asset => asset.path === BASELINE_SIGNAL.asset.path))
    await writeFile(join(dir, BASELINE_SIGNAL.asset.path), BASELINE_SIGNAL.bytes);
}

const VIDEO_TAKE_FACTS = ['id', 'source', 'artifact', 'frames', 'fps', 'simulated', 'recorded', 'hasAudio'] as const;

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
  'a code-authored sound Source can be reviewed and delivered, and a no-sound report is unchanged',
  { skip: e2eSkip },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'viscraft-sound-review-'));
    const root2 = await mkdtemp(join(tmpdir(), 'viscraft-nosound-review-'));
    const delivered = `${root}-delivery`;
    try {
      // --- 1. Build the sound-Source project --------------------------------
      await writeWork(root, work(true));
      const build = await buildProject(root);
      assert.equal(build.status, 'succeeded', `build must succeed: ${build.error ?? ''}`);
      const soundArtifact = build.artifacts.find(
        artifact => artifact.operation === 'browser' && artifact.kind === 'audio',
      );
      assert(soundArtifact, 'the build must record a sound operation');
      assert.equal(soundArtifact.kind, 'audio', 'a sound Take must be an audio artifact');
      assert(soundArtifact.path.endsWith('.wav'), 'a sound Take must be a WAV');

      // --- 2. reviewBuild succeeds and reports the truth --------------------
      const review = await reviewBuild(root, build.id);
      const reportText = await readFile(join(root, review.report), 'utf8');
      const report = JSON.parse(reportText) as {
        takes: Array<Record<string, unknown>>;
        video: { blackFrames: unknown[]; repeatedFrameSpans: { analysedFrames: number } };
        final: { probe: { frames: number; audio?: unknown } };
        limitations: string[];
      };
      const entry = report.takes.find(take => take.artifact === soundArtifact.id);
      assert(entry, 'the audio Take must appear in the review report');
      assert.equal(entry.audioOnly, true, 'the audio Take must be marked audio-only');
      assert.equal(entry.hasAudio, true, 'the audio Take really carries audio');
      // Real probed audio facts, and they match an independent probeAudio.
      const probed = await probeAudio(join(root, soundArtifact.path));
      assert.deepEqual(entry.audio, { sampleRate: RATE, channels: 2, duration: SAMPLES / RATE, samples: SAMPLES });
      assert.deepEqual(entry.audio, probed, 'the reported audio facts must equal an independent probe');
      // No picture fact is fabricated for the audio Take.
      for (const key of ['blackFrames', 'repeatedFrameSpans', 'contactSheet', 'seams', 'probe', 'width', 'height']) {
        assert.equal(key in entry, false, `an audio Take must not carry the picture fact "${key}"`);
      }
      assert.match(String(entry.pictureFacts), /audio-only/, 'the audio Take must say why picture facts are omitted');
      assert.ok(
        report.limitations.some(line => /audio-only/.test(line)),
        'the report must state the audio-only limitation',
      );
      // The picture facts that ARE reported describe the final composed movie, not the audio Take.
      assert.equal(report.final.probe.frames, FRAMES, 'the final composed movie must be probed as picture');
      assert(report.final.probe.audio, 'the final composed movie must carry audio');
      assert.equal(
        report.video.repeatedFrameSpans.analysedFrames,
        FRAMES,
        'repeated-frame analysis runs on the final picture',
      );

      // --- 3. deliverProject succeeds and bundles the truthful report -------
      const delivery = await deliverProject(root, delivered, { review: true, stems: true });
      assert.equal(delivery.build, build.id);
      assert.equal(delivery.review!.report, 'review/report.json');
      assert.equal(delivery.movie!.path, 'movie/final.mp4');
      const bundled = JSON.parse(await readFile(join(delivered, delivery.review!.report), 'utf8')) as {
        takes: Array<Record<string, unknown>>;
      };
      const bundledEntry = bundled.takes.find(take => take.artifact === soundArtifact.id);
      assert(bundledEntry, 'the delivered review report must still carry the audio Take');
      assert.equal(bundledEntry.audioOnly, true);
      assert.deepEqual(bundledEntry.audio, entry.audio, 'the bundled review must keep the same real audio facts');

      // --- 4. A project with NO sound Takes keeps only video-Take facts -------
      await writeWork(root2, work(false));
      const build2 = await buildProject(root2);
      assert.equal(build2.status, 'succeeded', `no-sound build must succeed: ${build2.error ?? ''}`);
      const review2 = await reviewBuild(root2, build2.id);
      const report2Text = await readFile(join(root2, review2.report), 'utf8');
      assert.equal(
        report2Text.includes('"audioOnly"'),
        false,
        'a project with no sound Takes must not gain audio-Take fields',
      );
      const report2 = JSON.parse(report2Text) as { takes: Array<Record<string, unknown>> };
      assert.ok(report2.takes.length > 0, 'the no-sound project must still record its picture Take');
      for (const take of report2.takes) {
        for (const fact of VIDEO_TAKE_FACTS)
          assert.ok(fact in take, `a video Take entry must carry the fact "${fact}"`);
        assert.equal('audioOnly' in take, false, 'a video Take must not be marked audio-only');
      }
      // Review of the same build is deterministic.
      const review2b = await reviewBuild(root2, build2.id);
      assert.equal(
        await readFile(join(root2, review2b.report), 'utf8'),
        report2Text,
        're-reviewing the same build must be byte-identical',
      );

      console.log(
        `[sound-review] audio Take ${soundArtifact.id}: ${probed.sampleRate} Hz, ${probed.channels} ch, ${probed.samples} samples; delivery ${delivery.files} files / ${delivery.bytes} bytes`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(root2, { recursive: true, force: true });
      await rm(delivered, { recursive: true, force: true });
    }
  },
);
