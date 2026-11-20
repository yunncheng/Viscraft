/**
 * Known picture-layer dependency and range errors are refused before capture
 * or provider submission. Plan and Build must report the same facts.
 */
import { strict as assert } from 'node:assert';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildProject, loadProject, planBuild, previewProject, saveProject, validateProject } from '../src/index.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import type { Composition, Project } from '../src/core/schema.js';

const OUTPUT = { width: 96, height: 64, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 2 };
const RIGHTS = { origin: 'original FFmpeg fixture', license: 'CC0-1.0', redistributable: true };

// ---------------------------------------------------------------------------
// Tiny real FFmpeg fixtures (cached)
// ---------------------------------------------------------------------------

let cachedVideo: Promise<Buffer> | undefined;
/** A 24-frame 96x64@24 H.264 fixture the loopback provider serves as its result. */
function providerVideo(): Promise<Buffer> {
  cachedVideo ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'viscraft-layer-media-'));
    try {
      const file = join(dir, 'provider.mp4');
      await runCommand('ffmpeg', [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-threads',
        '1',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=96x64:rate=24:duration=1',
        '-frames:v',
        '24',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-an',
        file,
      ]);
      return await readFile(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })();
  return cachedVideo;
}

let cachedPng: Promise<Buffer> | undefined;
function panelPng(): Promise<Buffer> {
  cachedPng ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'viscraft-layer-png-'));
    try {
      const file = join(dir, 'panel.png');
      await runCommand('ffmpeg', [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-threads',
        '1',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=16x16:rate=1:duration=1',
        '-frames:v',
        '1',
        '-pix_fmt',
        'rgb24',
        file,
      ]);
      return await readFile(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })();
  return cachedPng;
}

// ---------------------------------------------------------------------------
// Loopback provider (vllm-omni-video) whose POSTs are counted
// ---------------------------------------------------------------------------

interface Loopback {
  baseUrl: string;
  posts: number;
}

async function withLoopback(fn: (loop: Loopback) => Promise<void>): Promise<void> {
  const media = await providerVideo();
  const loop: Loopback = { baseUrl: '', posts: 0 };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
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

/** The provider options Build/Plan need to reach the loopback transport. */
const providerOptions = (baseUrl: string) => ({ providers: { videoApi: { default: { testOnly: { baseUrl } } } } });

// ---------------------------------------------------------------------------
// Project + record helpers
// ---------------------------------------------------------------------------

function providerSource(id: string, attempt: string): Record<string, unknown> {
  return {
    id,
    kind: 'provider',
    output: 'picture',
    endpoint: 'default',
    model: 'fixture-video',
    prompt: 'a slow pan across a quiet harbour',
    mode: 'text',
    references: [],
    requestedFrames: 12,
    size: '96:64',
    fps: 12,
    attempt,
  };
}

function browserSource(id: string, entry: string, frames: number): Record<string, unknown> {
  return { id, kind: 'browser', output: 'picture', entry, resources: [], bindings: [], params: {}, seed: 0, frames };
}

function simulatedSource(id: string, frames: number, attempt: string): Record<string, unknown> {
  return { id, kind: 'simulated', prompt: `fixture ${id}`, frames, attempt, behavior: 'success' };
}

function projectWith(
  sources: unknown[],
  placements: unknown[],
  layers: unknown[],
  assets: unknown[] = [],
  output: typeof OUTPUT = OUTPUT,
): Project {
  return validateProject({
    schemaVersion: 1,
    id: 'layer-preflight',
    revision: 1,
    title: 'Layer preflight',
    direction: { intent: 'layer preflight', looks: [{ id: 'look', description: 'look' }], transitions: [] },
    assets,
    bindings: {},
    sources,
    composition: {
      output,
      scenes: [{ id: 'scene', description: 'scene' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: 'shot', targetFrames: 48 }],
      placements,
      transitions: [],
      layers,
      audio: [],
    },
  });
}

const PANEL_LAYER = {
  id: 'ov',
  asset: 'panel',
  framing: { fit: 'contain', background: '#000000' },
  inFrame: 0,
  outFrame: 4,
  startFrame: 2,
  x: 16,
  y: 8,
  width: 32,
  height: 24,
  opacity: 1,
};

async function writeProject(root: string, project: Project): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
}

const FREEZE_PAGE = `<!doctype html><html><body style="margin:0"><canvas id="c"></canvas><script>window.viscraft={render(ctx){const c=document.getElementById('c');c.width=ctx.width;c.height=ctx.height;c.getContext('2d').fillRect(0,0,ctx.width,ctx.height);}};</script></body></html>`;

interface StoredBuild {
  status: string;
  operations: Array<{ kind: string }>;
  artifacts: Array<{ id: string }>;
  takes: Array<{
    id: string;
    asset?: string;
    source?: string;
    frames: number;
    fps: { numerator: number; denominator: number };
  }>;
}

async function readBuildRecords(root: string): Promise<StoredBuild[]> {
  const dir = join(root, '.viscraft', 'builds');
  const names = (await readdir(dir)).filter(name => name.endsWith('.json')).sort();
  return Promise.all(names.map(async name => JSON.parse(await readFile(join(dir, name), 'utf8')) as StoredBuild));
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-layer-preflight-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// A layer selecting a non-existent Take
// ---------------------------------------------------------------------------

test('a layer selecting a non-existent Take is refused with zero POSTs and zero captures', async () => {
  await withRoot(async root => {
    await withLoopback(async loop => {
      await writeProject(
        root,
        projectWith(
          [providerSource('gen', 'attempt_gen')],
          [{ id: 'main', shot: 'shot', source: 'gen', inFrame: 0, outFrame: 12, startFrame: 0, audio: 'mute' }],
          [
            {
              id: 'ov',
              take: 'take-does-not-exist',
              inFrame: 0,
              outFrame: 4,
              startFrame: 0,
              x: 0,
              y: 0,
              width: 96,
              height: 64,
              opacity: 1,
            },
          ],
        ),
      );

      // Plan reports the layer as blocked, and ONLY the layer gates it (the
      // provider endpoint is configured through the loopback options).
      const plan = await planBuild(root, providerOptions(loop.baseUrl));
      assert.equal(plan.buildable, false);
      assert.equal(plan.needsConfiguration.length, 0);
      assert.ok(
        plan.blockers.some(issue => issue.code === 'unknown-selected-take' && issue.subject === 'ov'),
        `expected an unknown-selected-take layer blocker, got ${JSON.stringify(plan.blockers)}`,
      );

      // The Build refuses the SAME error BEFORE it resolves the base placement:
      // zero provider POSTs, zero capture/compose operations, zero artifacts.
      await assert.rejects(
        () => buildProject(root, providerOptions(loop.baseUrl)),
        /Picture layer ov selects Take take-does-not-exist/,
      );
      assert.equal(loop.posts, 0, 'no provider POST may precede the layer preflight');
      const records = await readBuildRecords(root);
      assert.equal(records.length, 1);
      assert.equal(records[0].status, 'failed');
      assert.equal(records[0].operations.length, 0, 'no capture/compose may precede the layer preflight');
      assert.equal(records[0].artifacts.length, 0, 'no artifact may be produced before the layer preflight');
    });
  });
});

// ---------------------------------------------------------------------------
// A layer reading past a Source's static frames
// ---------------------------------------------------------------------------

test('a layer reading beyond a 2-frame Browser Source is refused with zero POSTs and zero captures', async () => {
  await withRoot(async root => {
    await writeFile(join(root, 'freeze.html'), FREEZE_PAGE);
    await withLoopback(async loop => {
      await writeProject(
        root,
        projectWith(
          [providerSource('gen', 'attempt_gen'), browserSource('freeze', 'freeze.html', 2)],
          [{ id: 'main', shot: 'shot', source: 'gen', inFrame: 0, outFrame: 12, startFrame: 0, audio: 'mute' }],
          [
            {
              id: 'ov',
              source: 'freeze',
              inFrame: 0,
              outFrame: 12,
              startFrame: 0,
              x: 0,
              y: 0,
              width: 96,
              height: 64,
              opacity: 1,
            },
          ],
        ),
      );

      const plan = await planBuild(root, providerOptions(loop.baseUrl));
      assert.equal(plan.buildable, false);
      assert.ok(
        plan.blockers.some(issue => issue.code === 'layer-reads-beyond-source' && issue.subject === 'ov'),
        `expected a layer-reads-beyond-source blocker, got ${JSON.stringify(plan.blockers)}`,
      );

      await assert.rejects(
        () => buildProject(root, providerOptions(loop.baseUrl)),
        /Picture layer ov reads frames \[0, 12\) beyond Source freeze \(2 frames\)/,
      );
      assert.equal(loop.posts, 0, 'no provider POST may precede the layer preflight');
      const records = await readBuildRecords(root);
      assert.equal(records.length, 1);
      assert.equal(records[0].status, 'failed');
      assert.equal(records[0].operations.length, 0, 'no browser capture/compose may precede the layer preflight');
      assert.equal(records[0].artifacts.length, 0, 'no artifact may be produced before the layer preflight');
    });
  });
});

// ---------------------------------------------------------------------------
// No regression — legal layers, reuse, and a preview that drops a bad layer
// ---------------------------------------------------------------------------

test('a legal image-Asset layer builds, is reusable, and is selectable by Take without regressing', async () => {
  await withRoot(async root => {
    await writeFile(join(root, 'panel.png'), await panelPng());
    const panel = {
      id: 'panel',
      revision: 1,
      path: 'panel.png',
      sha256: await hashFile(join(root, 'panel.png')),
      type: 'image',
      rights: RIGHTS,
      simulated: false,
    };
    await writeProject(
      root,
      projectWith(
        [simulatedSource('base', 24, 'attempt_base')],
        [{ id: 'main', shot: 'shot', source: 'base', inFrame: 0, outFrame: 24, startFrame: 0, audio: 'mute' }],
        [PANEL_LAYER],
        [panel],
      ),
    );

    // A directly referenced image Asset layer is legal: the layer-only Take is
    // produced and the layer overlay runs.
    const first = await buildProject(root);
    assert.equal(first.status, 'succeeded');
    assert.ok(
      first.operations.some(op => op.kind === 'normalize-still'),
      'the image layer is normalized',
    );
    assert.ok(
      first.operations.some(op => op.kind === 'overlay-picture-layers'),
      'the layer overlay runs',
    );
    const panelTake = first.takes.find(take => take.asset === 'panel');
    assert.ok(panelTake, 'the image layer produced its own Take');
    if (panelTake.medium !== 'picture') assert.fail('the image layer Take must be a picture Take');
    assert.ok(panelTake.frames >= PANEL_LAYER.outFrame, 'the layer interval fits its Take');

    // Rebuilt unchanged: every operation is reused (no regression in reuse).
    const second = await buildProject(root);
    assert.equal(second.status, 'succeeded');
    assert.ok(
      second.operations.every(op => op.reused),
      'a normal reused Build re-encodes nothing',
    );

    // Selecting the produced Take (instead of the Asset) is a legal layer too.
    const edited = await loadProject(root);
    edited.composition!.layers = [
      {
        ...PANEL_LAYER,
        asset: undefined,
        framing: undefined,
        take: panelTake!.id,
      } as NonNullable<Composition['layers']>[number],
    ];
    await saveProject(root, edited, edited.revision);
    const third = await buildProject(root);
    assert.equal(third.status, 'succeeded');
    assert.equal(
      third.operations.find(op => op.kind === 'normalize-still'),
      undefined,
      'a selected layer-only Take is not re-normalized',
    );
  });
});

test('a preview drops an out-of-range layer, so its bad interval does not block the preview', async () => {
  await withRoot(async root => {
    await writeFile(join(root, 'freeze.html'), FREEZE_PAGE);
    // A 48-frame programme; the layer's span [24, 36) reads 12 frames from a
    // 2-frame Source (bad for a full Build) but lies wholly outside [0, 12).
    await writeProject(
      root,
      projectWith(
        [simulatedSource('base', 48, 'attempt_base'), browserSource('freeze', 'freeze.html', 2)],
        [{ id: 'main', shot: 'shot', source: 'base', inFrame: 0, outFrame: 48, startFrame: 0, audio: 'mute' }],
        [
          {
            id: 'ov',
            source: 'freeze',
            inFrame: 0,
            outFrame: 12,
            startFrame: 24,
            x: 0,
            y: 0,
            width: 96,
            height: 64,
            opacity: 1,
          },
        ],
      ),
    );

    // A full Build refuses the layer (it is consumed).
    await assert.rejects(() => buildProject(root), /Picture layer ov reads frames \[0, 12\) beyond Source freeze/);

    // The preview [0, 12) drops that layer, so it neither blocks nor consumes it.
    const plan = await planBuild(root, { preview: { frames: [0, 12] } });
    assert.equal(plan.buildable, true, `the preview must not be blocked: ${JSON.stringify(plan.blockers)}`);
    assert.deepEqual(plan.preview?.substituted, [], 'no placement is wholly outside the range');
    const preview = await previewProject(root, { frames: [0, 12] });
    assert.equal(preview.status, 'succeeded');
    assert.ok(!preview.operations.some(op => op.kind === 'browser'), 'the dropped layer Source is never captured');
  });
});

// ---------------------------------------------------------------------------
// A layer reading past a video Asset's real frames
// ---------------------------------------------------------------------------

test('a layer reading beyond a video Asset’s real frames is refused with zero POSTs and zero captures', async () => {
  await withRoot(async root => {
    // A real 24-frame 96x64@24 H.264 file on disk (the loopback's own fixture
    // bytes), registered as a VIDEO Asset. Its length is knowable only by a
    // metadata probe — the Asset schema records no media length.
    await writeFile(join(root, 'clip.mp4'), await providerVideo());
    const clip = {
      id: 'clip',
      revision: 1,
      path: 'clip.mp4',
      sha256: await hashFile(join(root, 'clip.mp4')),
      type: 'video',
      rights: RIGHTS,
      simulated: false,
    };
    await withLoopback(async loop => {
      await writeProject(
        root,
        projectWith(
          [providerSource('gen', 'attempt_gen')],
          [{ id: 'main', shot: 'shot', source: 'gen', inFrame: 0, outFrame: 24, startFrame: 0, audio: 'mute' }],
          [
            {
              id: 'ov',
              asset: 'clip',
              framing: { fit: 'contain', background: '#000000' },
              // The Asset really has ~24 frames; this requests [24, 48), which
              // exceeds them. The layer's stay (48 - 24 = 24) still fits the
              // 24-frame programme, so the Asset bound is the only mistake.
              inFrame: 24,
              outFrame: 48,
              startFrame: 0,
              x: 0,
              y: 0,
              width: 96,
              height: 64,
              opacity: 1,
            },
          ],
          [clip],
        ),
      );

      const plan = await planBuild(root, providerOptions(loop.baseUrl));
      assert.equal(plan.buildable, false);
      assert.equal(plan.needsConfiguration.length, 0);
      assert.ok(
        plan.blockers.some(issue => issue.code === 'layer-reads-beyond-asset' && issue.subject === 'ov'),
        `expected a layer-reads-beyond-asset blocker, got ${JSON.stringify(plan.blockers)}`,
      );

      // Layer preflight, including the metadata probe, must reject the invalid
      // range before the provider Source can submit any work.
      await assert.rejects(
        () => buildProject(root, providerOptions(loop.baseUrl)),
        /Picture layer ov reads frames \[24, 48\) beyond the normalized video Asset clip/,
      );
      assert.equal(loop.posts, 0, 'no provider POST may precede the layer preflight');
      const records = await readBuildRecords(root);
      assert.equal(records.length, 1);
      assert.equal(records[0].status, 'failed');
      assert.equal(records[0].operations.length, 0, 'no compose/capture may precede the layer preflight');
      assert.equal(records[0].artifacts.length, 0, 'no artifact may be produced before the layer preflight');
    });
  });
});

// ---------------------------------------------------------------------------
// A video-Asset dependency whose file is
// renamed away but whose artifact is reusable must NOT be blocked
// during preflight. A failed metadata probe is an UNKNOWN
// length (`pending`), never a `blocked` known error; the Build proceeds and
// reuses the hash-verified normalized artifact without reading the Asset file.
// ---------------------------------------------------------------------------

/** Write the loopback's real 24-frame 96x64@24 H.264 fixture as a VIDEO Asset. */
async function writeClipAsset(root: string): Promise<Record<string, unknown>> {
  await writeFile(join(root, 'clip.mp4'), await providerVideo());
  return {
    id: 'clip',
    revision: 1,
    path: 'clip.mp4',
    sha256: await hashFile(join(root, 'clip.mp4')),
    type: 'video',
    rights: RIGHTS,
    simulated: false,
  };
}

test('regression: a video-Asset LAYER whose file is renamed away still builds by reusing its artifact', async () => {
  await withRoot(async root => {
    const clip = await writeClipAsset(root);
    // A legal 24-frame video-Asset layer held over the whole 24-frame programme.
    await writeProject(
      root,
      projectWith(
        [simulatedSource('base', 24, 'attempt_base')],
        [{ id: 'main', shot: 'shot', source: 'base', inFrame: 0, outFrame: 24, startFrame: 0, audio: 'mute' }],
        [
          {
            id: 'ov',
            asset: 'clip',
            framing: { fit: 'contain', background: '#000000' },
            inFrame: 0,
            outFrame: 24,
            startFrame: 0,
            x: 0,
            y: 0,
            width: 96,
            height: 64,
            opacity: 1,
          },
        ],
        [clip],
      ),
    );

    const first = await buildProject(root);
    assert.equal(first.status, 'succeeded');
    assert.ok(
      first.operations.some(op => op.kind === 'normalize-media'),
      'the video Asset is normalized once',
    );

    // The Asset's authored file is MOVED AWAY; its bytes remain in the content
    // store from the first Build, so the normalize operation is still reusable.
    await rename(join(root, 'clip.mp4'), join(root, 'clip.mp4.bak'));

    // Plan reports the unknown length as a non-blocking `pending` fact and stays
    // buildable — it agrees with what the Build can actually do.
    const plan = await planBuild(root);
    assert.equal(plan.buildable, true, `Plan must not hard-block a reusable layer: ${JSON.stringify(plan.blockers)}`);
    assert.equal(
      plan.blockers.some(issue => issue.code === 'layer-asset-media-unknown'),
      false,
      'an unreadable Asset media length is never a blocked issue',
    );
    assert.ok(
      plan.pending.some(issue => issue.code === 'layer-asset-media-unknown' && issue.subject === 'ov'),
      `expected a pending layer-asset-media-unknown fact, got ${JSON.stringify(plan.pending)}`,
    );

    // Frozen media facts allow the Build to reuse this layer without reading
    // the unavailable original or re-encoding its normalized artifact.
    const second = await buildProject(root);
    assert.equal(second.status, 'succeeded');
    assert.ok(
      second.operations.some(op => op.kind === 'normalize-media' && op.reused),
      'the normalize is reused',
    );
    assert.ok(
      second.operations.every(op => op.reused),
      'a normal reused rebuild re-encodes nothing',
    );
  });
});

test('regression: a video-Asset PLACEMENT whose file is renamed away still builds by reusing its artifact', async () => {
  await withRoot(async root => {
    const clip = await writeClipAsset(root);
    await writeProject(
      root,
      projectWith(
        [],
        [
          {
            id: 'main',
            shot: 'shot',
            asset: 'clip',
            framing: { fit: 'contain', background: '#000000' },
            inFrame: 0,
            outFrame: 24,
            startFrame: 0,
            audio: 'mute',
          },
        ],
        [],
        [clip],
      ),
    );

    const first = await buildProject(root);
    assert.equal(first.status, 'succeeded');
    assert.ok(
      first.operations.some(op => op.kind === 'normalize-media'),
      'the video Asset is normalized once',
    );

    await rename(join(root, 'clip.mp4'), join(root, 'clip.mp4.bak'));

    const plan = await planBuild(root);
    assert.equal(
      plan.buildable,
      true,
      `Plan must not hard-block a reusable placement: ${JSON.stringify(plan.blockers)}`,
    );
    assert.equal(
      plan.blockers.some(issue => issue.code === 'placement-asset-media-unknown'),
      false,
      'an unreadable Asset media length is never a blocked issue',
    );
    assert.ok(
      plan.pending.some(issue => issue.code === 'placement-asset-media-unknown' && issue.subject === 'main'),
      `expected a pending placement-asset-media-unknown fact, got ${JSON.stringify(plan.pending)}`,
    );

    const second = await buildProject(root);
    assert.equal(second.status, 'succeeded');
    assert.ok(
      second.operations.every(op => op.reused),
      'a normal reused rebuild re-encodes nothing',
    );
  });
});

// ---------------------------------------------------------------------------
// A placement reading past a video Asset's measured frames must fail preflight
// before any capture, provider submission or composition, just like a layer.
// ---------------------------------------------------------------------------

test('a placement reading beyond a video Asset’s real frames is refused with zero POSTs and zero captures', async () => {
  await withRoot(async root => {
    const clip = await writeClipAsset(root);
    await withLoopback(async loop => {
      await writeProject(
        root,
        projectWith(
          [providerSource('gen', 'attempt_gen')],
          [
            // A provider placement the Build WOULD submit if the Asset placement
            // were not refused first: [0, 12) then the Asset placement [12, 36).
            { id: 'genmain', shot: 'shot', source: 'gen', inFrame: 0, outFrame: 12, startFrame: 0, audio: 'mute' },
            {
              id: 'over',
              shot: 'shot',
              asset: 'clip',
              framing: { fit: 'contain', background: '#000000' },
              // The Asset really has ~24 frames; this requests [24, 48).
              inFrame: 24,
              outFrame: 48,
              startFrame: 12,
              audio: 'mute',
            },
          ],
          [],
          [clip],
        ),
      );

      const plan = await planBuild(root, providerOptions(loop.baseUrl));
      assert.equal(plan.buildable, false);
      assert.ok(
        plan.blockers.some(issue => issue.code === 'placement-reads-beyond-asset' && issue.subject === 'over'),
        `expected a placement-reads-beyond-asset blocker, got ${JSON.stringify(plan.blockers)}`,
      );

      await assert.rejects(
        () => buildProject(root, providerOptions(loop.baseUrl)),
        /Placement over reads frames \[24, 48\) beyond the normalized video Asset clip/,
      );
      assert.equal(loop.posts, 0, 'no provider POST may precede the placement preflight');
      const records = await readBuildRecords(root);
      assert.equal(records.length, 1);
      assert.equal(records[0].status, 'failed');
      assert.equal(records[0].operations.length, 0, 'no compose/capture may precede the placement preflight');
      assert.equal(records[0].artifacts.length, 0, 'no artifact may be produced before the placement preflight');
    });
  });
});

// ---------------------------------------------------------------------------
// a layer reusing a Take recorded at another output fps
// ---------------------------------------------------------------------------

test('a layer reusing a Take recorded at another output fps is refused with zero POSTs', async () => {
  await withRoot(async root => {
    const clip = await writeClipAsset(root);
    // Seed a 24 fps Build so a normalized Take for the video Asset exists.
    await writeProject(
      root,
      projectWith(
        [],
        [
          {
            id: 'main',
            shot: 'shot',
            asset: 'clip',
            framing: { fit: 'contain', background: '#000000' },
            inFrame: 0,
            outFrame: 24,
            startFrame: 0,
            audio: 'mute',
          },
        ],
        [],
        [clip],
      ),
    );
    const seed = await buildProject(root);
    assert.equal(seed.status, 'succeeded');
    const seedRecord = (await readBuildRecords(root)).find(record => record.status === 'succeeded')!;
    const assetTake = seedRecord.takes.find(take => take.asset === 'clip')!;
    assert.equal(assetTake.fps.numerator, 24, 'the seed Take is on the 24 fps clock');

    await withLoopback(async loop => {
      // The composition is now 30 fps. An earlier Provider Source would be
      // submitted first, then the `take:` LAYER would fail inside
      // `overlayPictureLayers`; the shared layer preflight must refuse first.
      await writeProject(
        root,
        projectWith(
          [providerSource('gen', 'attempt_gen')],
          [{ id: 'main', shot: 'shot', source: 'gen', inFrame: 0, outFrame: 12, startFrame: 0, audio: 'mute' }],
          [
            {
              id: 'ov',
              take: assetTake.id,
              inFrame: 0,
              outFrame: 12,
              startFrame: 0,
              x: 0,
              y: 0,
              width: 96,
              height: 64,
              opacity: 1,
            },
          ],
          [clip],
          { ...OUTPUT, fps: { numerator: 30, denominator: 1 } },
        ),
      );
      const plan = await planBuild(root, providerOptions(loop.baseUrl));
      assert.equal(plan.buildable, false);
      assert.ok(
        plan.blockers.some(issue => issue.code === 'layer-fps-mismatch' && issue.subject === 'ov'),
        `expected a layer-fps-mismatch blocker, got ${JSON.stringify(plan.blockers)}`,
      );
      await assert.rejects(
        () => buildProject(root, providerOptions(loop.baseUrl)),
        /Picture layer ov selects Take take-[0-9a-f]+ recorded at 24\/1 fps, but the composition output is 30\/1 fps/,
      );
      assert.equal(loop.posts, 0, 'no provider POST may precede the layer fps preflight');
    });
  });
});
