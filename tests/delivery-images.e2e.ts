/**
 * End-to-end: the CLI selects the products of THIS delivery from a real Project
 * that holds both a still and a film.
 *
 * The still is a real Browser capture and the film is a real FFmpeg build, so the
 * bundle layout, the JSON result and `verify` are checked against actual media,
 * not fixture bytes. The two CLI invocations prove the selection rule a host
 * agent relies on: naming `--image` ships no movie, and naming both ships both.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildProject } from '../src/build/build.js';
import { renderImage } from '../src/build/image.js';
import { verifyDelivery } from '../src/operations/delivery/delivery-verification.js';
import { validateProject } from '../src/project/project.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

const POSTER_HTML = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="poster.css"></head>
<body><div id="card"><h1>OPENING NIGHT</h1><p>One-sheet</p></div></body></html>`;
const POSTER_CSS = `html,body{margin:0;width:120px;height:80px;overflow:hidden;background:#20242c}
#card{padding:10px;font-family:sans-serif;color:#f4e7cf}h1{font-size:15px;margin:0}p{margin:0;font-size:8px}`;

function project() {
  return validateProject({
    schemaVersion: 1,
    id: 'delivery_images_e2e',
    revision: 1,
    title: 'Delivery images end to end',
    direction: {
      intent: 'One poster and one very short film.',
      looks: [{ id: 'plain', description: 'plain' }],
      transitions: [],
    },
    assets: [],
    bindings: {},
    sources: [
      {
        id: 'src_film',
        kind: 'simulated' as const,
        prompt: 'six-frame film',
        frames: 6,
        seed: 3,
        attempt: 'attempt_film',
        behavior: 'success' as const,
      },
    ],
    composition: {
      output: { width: 160, height: 90, fps: { numerator: 25, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene_1', description: 'scene' }],
      shots: [{ id: 'shot_1', scene: 'scene_1', look: 'plain', intent: 'one shot', targetFrames: 6 }],
      placements: [
        {
          id: 'pl_1',
          shot: 'shot_1',
          source: 'src_film',
          inFrame: 0,
          outFrame: 6,
          startFrame: 0,
          audio: 'mute' as const,
        },
      ],
      transitions: [],
      audio: [],
    },
    imageDocuments: [{ id: 'poster', path: 'poster.html', resources: ['poster.css'], revision: 1 }],
    imageTargets: [
      {
        id: 'poster',
        document: 'poster',
        width: 120,
        height: 80,
        scale: 2,
        format: 'png' as const,
        background: 'opaque' as const,
      },
    ],
  });
}

function pngSize(bytes: Buffer): { width: number; height: number } {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'expected a real PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(
    () => true,
    () => false,
  );
}

test('the CLI delivers a still-only set, a combined set, and the default set from real media', async () => {
  const parent = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-delivery-images-e2e-'));
  const root = nodePath.join(parent, 'project');
  try {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(nodePath.join(root, 'poster.html'), POSTER_HTML);
    await fs.writeFile(nodePath.join(root, 'poster.css'), POSTER_CSS);
    await fs.writeFile(nodePath.join(root, 'project.json'), `${JSON.stringify(project(), null, 2)}\n`);

    const still = await renderImage(root, { target: 'poster' });
    const film = await buildProject(root);
    assert.equal(film.status, 'succeeded');
    const active = JSON.parse(await fs.readFile(nodePath.join(root, '.viscraft', 'result.json'), 'utf8')) as {
      sha256: string;
    };

    // --- 1. An explicit still-only deliver ships no movie --------------------
    const stillDir = nodePath.join(parent, 'still');
    const stillOut = JSON.parse(
      await runCommand(process.execPath, [CLI, 'deliver', root, stillDir, '--image', 'poster']),
    ) as { movie: unknown; images: { target: string; path: string; sha256: string }[] };
    assert.equal(stillOut.movie, null);
    assert.deepEqual(
      stillOut.images.map(image => image.target),
      ['poster'],
    );
    assert.equal(stillOut.images[0]!.path, 'image/poster.png');
    assert.equal(await exists(nodePath.join(stillDir, 'movie')), false);
    assert.deepEqual(pngSize(await fs.readFile(nodePath.join(stillDir, 'image', 'poster.png'))), {
      width: 240,
      height: 160,
    });
    assert.equal((await verifyDelivery(stillDir)).ok, true);

    // --- 2. Naming both ships both, with real bytes --------------------------
    const bothDir = nodePath.join(parent, 'both');
    const bothOut = JSON.parse(
      await runCommand(process.execPath, [CLI, 'deliver', root, bothDir, '--movie', '--image', 'poster']),
    ) as {
      movie: { sha256: string; bytes: number };
      images: { sha256: string; build: string }[];
      project: { path: string } | null;
    };
    assert.equal(bothOut.movie!.sha256, active.sha256);
    assert.equal(bothOut.images[0]!.build, still.build);
    assert.equal(bothOut.images[0]!.sha256, await hashFile(nodePath.join(root, ...still.path.split('/'))));
    assert.equal(bothOut.project?.path, 'project');
    assert.equal(await exists(nodePath.join(bothDir, 'project', 'poster.html')), true);
    assert.equal(await hashFile(nodePath.join(bothDir, 'movie', 'final.mp4')), active.sha256);
    assert.equal((await verifyDelivery(bothDir)).ok, true);

    // The delivered movie is a real, openable six-frame 160x90 video.
    const probe = JSON.parse(
      await runCommand('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height,nb_frames',
        '-of',
        'json',
        nodePath.join(bothDir, 'movie', 'final.mp4'),
      ]),
    ) as { streams: Array<{ width: number; height: number; nb_frames: string }> };
    assert.equal(probe.streams[0]!.width, 160);
    assert.equal(probe.streams[0]!.height, 90);
    assert.equal(Number(probe.streams[0]!.nb_frames), 6);

    // --- 3. With no selector the declared outputs are both selected ----------
    const defaultDir = nodePath.join(parent, 'default');
    const defaultOut = JSON.parse(await runCommand(process.execPath, [CLI, 'deliver', root, defaultDir])) as {
      movie: unknown;
      images: unknown[];
    };
    assert.ok(defaultOut.movie, 'the no-selector default includes the declared film');
    assert.equal(defaultOut.images.length, 1);
    assert.equal((await verifyDelivery(defaultDir)).ok, true);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
