/**
 * Known timeline Take errors fail before capture or generation. Coverage
 * includes missing media, source range, audio presence, medium and frame rate.
 */
import { strict as assert } from 'node:assert';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildProject, planBuild, previewProject, validateProject } from '../src/index.js';
import { findBrowser } from '../src/backends/browser/capture.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { writeSignalAsset } from './audio-fixtures.js';
import type { Asset, Project } from '../src/core/schema.js';

const OUT = { width: 96, height: 64, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 2 };
/** The SAME raster as `OUT` but on a 30 fps output clock. */
const THIRTY = { ...OUT, fps: { numerator: 30, denominator: 1 } };
const RIGHTS = { origin: 'original FFmpeg fixture', license: 'CC0-1.0', redistributable: true };

const browserAvailable = await findBrowser().then(
  () => true,
  () => false,
);
const browserSkip = browserAvailable ? false : 'needs a Chrome/Chromium browser';

async function ffmpeg(args: string[]): Promise<void> {
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1', ...args]);
}

/** A deterministic code-authored sound scene (one second of a 220 Hz tone). */
const SOUND_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
window.viscraftSound = {
  ready: function () { return Promise.resolve(); },
  dispose: function () {},
  render: function (ctx) {
    var rate = ctx.sampleRate, channels = ctx.channels, samples = ctx.samples;
    var out = new Float32Array(samples * channels);
    for (var i = 0; i < samples; i++) {
      var v = Math.sin(2 * Math.PI * 220 * (i / rate)) * 0.5;
      for (var c = 0; c < channels; c++) out[i * channels + c] = v;
    }
    return out;
  }
};
</script></body></html>
`;

// ---------------------------------------------------------------------------
// Loopback provider (generic vllm-omni-video) whose POSTs are counted
// ---------------------------------------------------------------------------

interface Loopback {
  baseUrl: string;
  posts: number;
}

async function withLoopback(fn: (loop: Loopback) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'viscraft-take-media-'));
  const file = join(dir, 'provider.mp4');
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=96x64:rate=24:duration=1',
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    file,
  ]);
  const media = await readFile(file);
  await rm(dir, { recursive: true, force: true });

  const loop: Loopback = { baseUrl: '', posts: 0 };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '/';
      if (req.method === 'POST' && url === '/v1/videos') {
        loop.posts++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `fixture_${loop.posts}`, status: 'queued' }));
        return;
      }
      if (req.method === 'GET' && /^\/v1\/videos\/fixture_\d+$/.test(url)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: url.split('/').at(-1), status: 'completed', error: null }));
        return;
      }
      if (req.method === 'GET' && /^\/v1\/videos\/fixture_\d+\/content$/.test(url)) {
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': media.length });
        res.end(media);
        return;
      }
      res.writeHead(404);
      res.end('nf');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  loop.baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  try {
    await fn(loop);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

const providerOptions = (baseUrl: string) => ({ providers: { videoApi: { default: { testOnly: { baseUrl } } } } });

// ---------------------------------------------------------------------------
// Project + record helpers
// ---------------------------------------------------------------------------

const providerSource = (id: string) => ({
  id,
  kind: 'provider',
  output: 'picture',
  endpoint: 'default',
  model: 'fixture-video',
  prompt: `fixture ${id}`,
  mode: 'text',
  references: [],
  requestedFrames: 12,
  size: '96:64',
  fps: 24,
  attempt: `attempt_${id}`,
});

/** The code-authored sound Source that renders an AUDIO Take. */
const SOUND_SOURCE = {
  id: 'snd',
  kind: 'browser',
  output: 'sound',
  entry: 'sound.html',
  resources: [],
  bindings: [],
  params: {},
  seed: 0,
  durationSamples: 48000,
  sampleRate: 48000,
};

function makeProject(
  sources: unknown[],
  placements: unknown[],
  audio: unknown[],
  assets: unknown[],
  output: typeof OUT = OUT,
): Project {
  return validateProject({
    schemaVersion: 1,
    id: 'placement-take',
    revision: 1,
    title: 'Placement take preflight',
    direction: { intent: 'placement take', looks: [{ id: 'look', description: 'look' }], transitions: [] },
    assets,
    bindings: {},
    sources,
    composition: {
      output,
      scenes: [{ id: 'scene', description: 'scene' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: 'shot', targetFrames: 240 }],
      placements,
      transitions: [],
      audio,
    },
  });
}

async function writeProject(root: string, project: Project): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
}

interface StoredBuild {
  status: string;
  operations: Array<{ kind: string }>;
  artifacts: Array<{ id: string; path: string }>;
  takes: Array<{ id: string; artifact: string; asset?: string; source?: string }>;
}

async function records(root: string): Promise<StoredBuild[]> {
  const dir = join(root, '.viscraft', 'builds');
  const names = (await readdir(dir)).filter(n => n.endsWith('.json')).sort();
  return Promise.all(names.map(async n => JSON.parse(await readFile(join(dir, n), 'utf8')) as StoredBuild));
}

interface Fixture {
  root: string;
  busSignal: Asset;
  takeSilentA: string;
  takeSilentB: string;
  takeWithAudio: string;
  takeSound: string;
  silentASha: string;
  silentBSha: string;
  withAudioSha: string;
  artifactPathOf: (takeId: string) => string;
}

/** Build a seed project so the real Takes (including an AUDIO Take) exist. */
async function seedFixture(root: string): Promise<Fixture> {
  await mkdir(root, { recursive: true });
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=96x64:rate=24:duration=0.5',
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    join(root, 'silentA.mp4'),
  ]);
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=96x64:rate=24:duration=0.5',
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    join(root, 'silentB.mp4'),
  ]);
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=96x64:rate=24:duration=0.5',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=0.5',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-ac',
    '2',
    '-shortest',
    join(root, 'withAudio.mp4'),
  ]);
  await writeFile(join(root, 'sound.html'), SOUND_HTML, 'utf8');
  const silentASha = await hashFile(join(root, 'silentA.mp4'));
  const silentBSha = await hashFile(join(root, 'silentB.mp4'));
  const withAudioSha = await hashFile(join(root, 'withAudio.mp4'));

  await writeProject(
    root,
    makeProject(
      [SOUND_SOURCE],
      [
        { id: 'pl_a', shot: 'shot', asset: 'silentA', inFrame: 0, outFrame: 12, startFrame: 0, audio: 'mute' },
        { id: 'pl_b', shot: 'shot', asset: 'silentB', inFrame: 0, outFrame: 12, startFrame: 12, audio: 'mute' },
        { id: 'pl_c', shot: 'shot', asset: 'withAudio', inFrame: 0, outFrame: 12, startFrame: 24, audio: 'mute' },
      ],
      [{ id: 'bed', kind: 'source', source: 'snd', startSample: 0, gain: 0.2, fadeInSamples: 0, fadeOutSamples: 0 }],
      [
        {
          id: 'silentA',
          revision: 1,
          type: 'video',
          path: 'silentA.mp4',
          sha256: silentASha,
          rights: RIGHTS,
          simulated: false,
        },
        {
          id: 'silentB',
          revision: 1,
          type: 'video',
          path: 'silentB.mp4',
          sha256: silentBSha,
          rights: RIGHTS,
          simulated: false,
        },
        {
          id: 'withAudio',
          revision: 1,
          type: 'video',
          path: 'withAudio.mp4',
          sha256: withAudioSha,
          rights: RIGHTS,
          simulated: false,
        },
      ],
    ),
  );
  const seed = await buildProject(root);
  assert.equal(seed.status, 'succeeded', 'the seed Build must produce the Takes');
  const take = (predicate: (t: StoredBuild['takes'][number]) => boolean) => seed.takes.find(predicate)!.id;
  const takeSilentA = take(t => t.asset === 'silentA');
  const takeSilentB = take(t => t.asset === 'silentB');
  const takeWithAudio = take(t => t.asset === 'withAudio');
  const takeSound = take(t => t.source === 'snd');
  assert.ok(takeSilentA && takeSilentB && takeWithAudio && takeSound, 'all four Takes exist');
  const stored = (await records(root)).find(r => r.status === 'succeeded')!;
  const artifactPathOf = (takeId: string): string => {
    const t = stored.takes.find(x => x.id === takeId)!;
    return join(root, stored.artifacts.find(a => a.id === t.artifact)!.path);
  };
  const busSignal = await writeSignalAsset(root, {
    id: 'bus_signal',
    path: 'audio/bus-signal.wav',
    sampleRate: 48000,
    channels: 2,
    samples: 24000,
  });
  return {
    root,
    busSignal,
    takeSilentA,
    takeSilentB,
    takeWithAudio,
    takeSound,
    silentASha,
    silentBSha,
    withAudioSha,
    artifactPathOf,
  };
}

/** A project with an earlier Provider placement, then the `take:` placement under test. */
function scenario(
  fx: Fixture,
  takePlacement: Record<string, unknown>,
  audio: unknown[] = [],
  output: typeof OUT = OUT,
): Project {
  return makeProject(
    [providerSource('gen'), SOUND_SOURCE],
    [
      { id: 'pl_gen', shot: 'shot', source: 'gen', inFrame: 0, outFrame: 12, startFrame: 0, audio: 'mute' },
      { id: 'pl_take', shot: 'shot', startFrame: 12, ...takePlacement },
    ],
    audio,
    [
      {
        id: 'silentA',
        revision: 1,
        type: 'video',
        path: 'silentA.mp4',
        sha256: fx.silentASha,
        rights: RIGHTS,
        simulated: false,
      },
      {
        id: 'silentB',
        revision: 1,
        type: 'video',
        path: 'silentB.mp4',
        sha256: fx.silentBSha,
        rights: RIGHTS,
        simulated: false,
      },
      {
        id: 'withAudio',
        revision: 1,
        type: 'video',
        path: 'withAudio.mp4',
        sha256: fx.withAudioSha,
        rights: RIGHTS,
        simulated: false,
      },
      fx.busSignal,
    ],
    output,
  );
}

async function withFixture(fn: (fx: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-placement-take-'));
  try {
    await fn(await seedFixture(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Assert the Plan blocks and the Build refuses before any POST for one case. */
async function expectRefused(fx: Fixture, project: Project, code: string, buildPattern: RegExp): Promise<void> {
  await withLoopback(async loop => {
    await writeProject(fx.root, project);
    const plan = await planBuild(fx.root, providerOptions(loop.baseUrl));
    assert.equal(plan.buildable, false, 'the Plan must not report this project as buildable');
    assert.ok(
      plan.blockers.some(issue => issue.code === code && issue.subject === 'pl_take'),
      `expected a ${code} blocker for pl_take, got ${JSON.stringify(plan.blockers.map(i => i.code))}`,
    );
    await assert.rejects(() => buildProject(fx.root, providerOptions(loop.baseUrl)), buildPattern);
    assert.equal(loop.posts, 0, `no Provider POST may precede the ${code} refusal`);
  });
}

// ---------------------------------------------------------------------------

test('a later Placement.take that does not exist is refused before any POST', async () => {
  await withFixture(fx =>
    expectRefused(
      fx,
      scenario(fx, { take: 'take-does-not-exist', inFrame: 0, outFrame: 12, audio: 'mute' }),
      'unknown-selected-take',
      /selects Take take-does-not-exist, which no completed Build records/,
    ),
  );
});

test('a later Placement.take read beyond its Take is refused before any POST', async () => {
  await withFixture(fx =>
    expectRefused(
      fx,
      scenario(fx, { take: fx.takeSilentA, inFrame: 0, outFrame: 999, audio: 'mute' }),
      'placement-reads-beyond-take',
      /reads frames \[0, 999\) beyond Take take-[0-9a-f]+/,
    ),
  );
});

test('a later Placement.take whose Artifact file is missing is refused before any POST', async () => {
  await withFixture(async fx => {
    await rm(fx.artifactPathOf(fx.takeSilentB), { force: true });
    await assert.rejects(stat(fx.artifactPathOf(fx.takeSilentB)), 'the Take artifact must be gone');
    await expectRefused(
      fx,
      scenario(fx, { take: fx.takeSilentB, inFrame: 0, outFrame: 12, audio: 'mute' }),
      'selected-take-missing',
      /selects Take take-[0-9a-f]+, but its artifact .* is missing or its hash no longer matches/,
    );
  });
});

test('a later Placement.take over a silent Take with audio "keep" is refused before any POST', async () => {
  await withFixture(fx =>
    expectRefused(
      fx,
      scenario(fx, { take: fx.takeSilentA, inFrame: 0, outFrame: 12, audio: 'keep' }),
      'keep-audio-on-silent-take',
      /has audio "keep" but its source Take take-[0-9a-f]+ \(Asset silentA\) declares no audio stream, so nothing was kept/,
    ),
  );
});

test(
  'a later Placement.take that selects an AUDIO Take as picture is refused before any POST',
  {
    skip: browserSkip,
  },
  async () => {
    await withFixture(fx =>
      expectRefused(
        fx,
        scenario(fx, { take: fx.takeSound, inFrame: 0, outFrame: 12, audio: 'mute' }),
        'take-not-picture',
        /selects Take take-[0-9a-f]+, whose medium is audio, not picture/,
      ),
    );
  },
);

// ---------------------------------------------------------------------------
// Positives — the shared check must not false-block a legal Take
// ---------------------------------------------------------------------------

test('a legal picture Take on the timeline still builds after one POST', async () => {
  await withFixture(async fx => {
    await withLoopback(async loop => {
      await writeProject(fx.root, scenario(fx, { take: fx.takeSilentA, inFrame: 0, outFrame: 12, audio: 'mute' }));
      const plan = await planBuild(fx.root, providerOptions(loop.baseUrl));
      assert.equal(plan.buildable, true, `a legal Take plan must be buildable: ${JSON.stringify(plan.blockers)}`);
      const build = await buildProject(fx.root, providerOptions(loop.baseUrl));
      assert.equal(build.status, 'succeeded');
      assert.equal(loop.posts, 1, 'exactly one POST for the one generated Source');
    });
  });
});

test('a legal keep over an audio-bearing Take with a bus still builds', async () => {
  await withFixture(async fx => {
    await withLoopback(async loop => {
      await writeProject(
        fx.root,
        scenario(fx, { take: fx.takeWithAudio, inFrame: 0, outFrame: 12, audio: 'keep', bus: 'dialogue' }, [
          {
            id: 'bus_clip',
            kind: 'asset',
            asset: fx.busSignal.id,
            inSample: 0,
            startSample: 0,
            durationSamples: 24000,
            gain: 0.1,
            fadeInSamples: 0,
            fadeOutSamples: 0,
            bus: 'dialogue',
          },
        ]),
      );
      const plan = await planBuild(fx.root, providerOptions(loop.baseUrl));
      assert.equal(plan.buildable, true, `a legal keep+bus must not be blocked: ${JSON.stringify(plan.blockers)}`);
      const build = await buildProject(fx.root, providerOptions(loop.baseUrl));
      assert.equal(build.status, 'succeeded');
    });
  });
});

test('a preview that replaces the bad take placement does not block on it', async () => {
  await withFixture(async fx => {
    await withLoopback(async loop => {
      // The bad `take:` placement sits at frames [12,24); a preview of [0,12) replaces it.
      await writeProject(
        fx.root,
        scenario(fx, { take: 'take-does-not-exist', inFrame: 0, outFrame: 12, audio: 'mute' }),
      );
      const preview = await previewProject(fx.root, { frames: [0, 12], ...providerOptions(loop.baseUrl) });
      assert.equal(preview.status, 'succeeded', 'a preview must not be blocked by a substituted placement');
    });
  });
});

// ---------------------------------------------------------------------------
// The LATE defensive guard stays alive for the one origin that still needs it
// ---------------------------------------------------------------------------

test('a keep over a provider Source whose Take turns out silent still fails loudly at the stem stage', async () => {
  await withFixture(async fx => {
    await withLoopback(async loop => {
      // A `source:` origin's audio is genuinely UNKNOWN until its Take exists, so
      // it is the one place the late stem/silent-drop guard must still decide: a
      // memberless bus is a loud error, never a silently omitted stem.
      await writeProject(
        fx.root,
        makeProject(
          [providerSource('gen'), SOUND_SOURCE],
          [
            {
              id: 'pl_gen',
              shot: 'shot',
              source: 'gen',
              inFrame: 0,
              outFrame: 12,
              startFrame: 0,
              audio: 'keep',
              bus: 'dialogue',
            },
          ],
          [],
          [],
        ),
      );
      await assert.rejects(
        buildProject(fx.root, providerOptions(loop.baseUrl)),
        /Build cannot emit stem dialogue: the bus has no members/,
      );
      assert.equal(loop.posts, 1, 'the Provider Take must exist before its audio can be known');
    });
  });
});

// ---------------------------------------------------------------------------
// a Take produced at another fps, reused after the output clock changed
// ---------------------------------------------------------------------------

test('a later Placement.take recorded at another fps is refused before any POST', async () => {
  await withFixture(fx =>
    expectRefused(
      fx,
      // The seed Take was produced at 24 fps; the composition is now 30 fps.
      scenario(fx, { take: fx.takeSilentA, inFrame: 0, outFrame: 12, audio: 'mute' }, [], THIRTY),
      'take-fps-mismatch',
      /selects Take take-[0-9a-f]+ recorded at 24\/1 fps, but the composition output is 30\/1 fps/,
    ),
  );
});

test('an explicitly retimed take placement at another output fps still builds', async () => {
  await withFixture(async fx => {
    await withLoopback(async loop => {
      // 12 source frames at 24 fps is 0.5 s; on the 30 fps output clock that is 15
      // frames. Declaring `durationFrames: 15` (≠ the natural 12) is the explicit
      // retime path: the Build materializes a normalized, output-fps clip, so the
      // shared fps guard must NOT false-block it.
      await writeProject(
        fx.root,
        scenario(fx, { take: fx.takeSilentA, inFrame: 0, outFrame: 12, durationFrames: 15, audio: 'mute' }, [], THIRTY),
      );
      const plan = await planBuild(fx.root, providerOptions(loop.baseUrl));
      assert.equal(plan.buildable, true, `a retimed placement must not be blocked: ${JSON.stringify(plan.blockers)}`);
      const build = await buildProject(fx.root, providerOptions(loop.baseUrl));
      assert.equal(build.status, 'succeeded', JSON.stringify(build));
      assert.ok(
        build.operations.some(operation => operation.kind === 'retime-clip'),
        'the retime is materialized',
      );
    });
  });
});
