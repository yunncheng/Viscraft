/**
 * An existing MP4 PLUS a separately imported external side asset.
 *
 * `reframe.e2e.ts` edits a flat clip that carries its OWN container audio. This
 * suite covers the untested path: a video Asset and a separate sidecar audio
 * file are each imported from disk as their own Asset, edited together, and
 * delivered. It proves the sidecar is a real imported product whose rights and
 * provenance reach the receiver:
 *
 *  - both the MP4 (video) and the .wav (audio sidecar) are `importAsset`ed from
 *    host paths into content-addressed Assets with their own rights records;
 *  - the built movie carries the sidecar's audio, and the build is NOT simulated;
 *  - a gain edit on the sidecar clip re-runs only `mix-audio` + `mux-final` and
 *    reuses the video normalization, yielding genuinely different output bytes;
 *  - `deliverProject` renders both Assets' rights into the facts page and
 *    `ATTRIBUTION.md`, ships both byte-for-byte, and `verifyDelivery` confirms
 *    the bundle;
 *  - re-delivering an exported copy reproduces the same movie.
 *
 * Requires real FFmpeg only (no browser, no provider).
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { createProject } from '../src/project/create.js';
import { loadProject, saveProject } from '../src/project/project.js';
import { importAsset } from '../src/operations/assets/import.js';
import { buildProject } from '../src/build/build.js';
import { deliverProject } from '../src/operations/delivery/delivery.js';
import { verifyDelivery } from '../src/operations/delivery/delivery-verification.js';
import { probeMedia } from '../src/backends/media/probe.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { ProjectSchema, type Fps, type Project } from '../src/core/schema.js';

const FPS: Fps = { numerator: 25, denominator: 1 };
const FRAMES = 25;
const RATE = 48000;

const CLIP_RIGHTS = {
  origin: 'original test clip (ffmpeg testsrc2)',
  license: 'CC0-1.0',
  redistributable: true,
};
// The sidecar is a distinct recording with its own attribution facts.
const SIDECAR_RIGHTS = {
  origin: 'exported score bed from the music tool',
  license: 'all-rights-reserved',
  author: 'the composer',
  notice: 'cleared for this cut only',
  redistributable: true,
};

/** A real video-only MP4 host file. */
async function makeHostMp4(directory: string): Promise<string> {
  const out = nodePath.join(directory, 'clip.mp4');
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
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=96x54:rate=25:duration=1',
    '-frames:v',
    String(FRAMES),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-an',
    out,
  ]);
  return out;
}

/** A real stereo PCM16 WAV sidecar host file. */
async function makeHostWav(directory: string): Promise<string> {
  const out = nodePath.join(directory, 'score.wav');
  await runCommand('ffmpeg', [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-loglevel',
    'error',
    '-threads',
    '1',
    '-filter_threads',
    '1',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=330:sample_rate=${RATE}:duration=1`,
    '-ac',
    '2',
    '-c:a',
    'pcm_s16le',
    out,
  ]);
  return out;
}

/** Walk the RIFF chunks of a WAV (ffmpeg may insert LIST/INFO before `data`). */
function readWav(bytes: Buffer): { channels: number; sampleRate: number; samples: number } {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  let offset = 12;
  let fmt: Buffer | undefined;
  let dataBytes: number | undefined;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === 'fmt ') fmt = bytes.subarray(offset + 8, offset + 8 + size);
    if (id === 'data') {
      dataBytes = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  assert.ok(fmt, 'the sidecar must carry a fmt chunk');
  assert.ok(dataBytes !== undefined, 'the sidecar must carry a data chunk');
  const format = fmt!.readUInt16LE(0);
  assert.ok(format === 1 || format === 0xfffe, `the sidecar must be linear PCM (format ${format})`);
  const channels = fmt!.readUInt16LE(2);
  const sampleRate = fmt!.readUInt32LE(4);
  assert.equal(fmt!.readUInt16LE(14), 16, 'the sidecar must be 16-bit PCM');
  return { channels, sampleRate, samples: Math.floor(dataBytes! / 2 / channels) };
}

/** Author the film: the imported MP4 cut under the imported sidecar score. */
async function authorTimeline(root: string, gain: number): Promise<void> {
  const project = await loadProject(root);
  const authored: Project = ProjectSchema.parse({
    ...project,
    sources: [],
    composition: {
      output: project.composition!.output,
      scenes: [{ id: 'scene', description: 'imported media' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'default', intent: 'cut the imported clip', targetFrames: FRAMES }],
      placements: [
        { id: 'cut', shot: 'shot', asset: 'clip', inFrame: 0, outFrame: FRAMES, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio: [
        {
          id: 'bed_clip',
          kind: 'asset',
          asset: 'bed',
          inSample: 0,
          startSample: 0,
          durationSamples: RATE,
          gain,
          fadeInSamples: 0,
          fadeOutSamples: 0,
        },
      ],
    },
  });
  await saveProject(root, authored, project.revision);
}

const ffmpegAvailable = await runCommand('ffmpeg', ['-version']).then(
  () => true,
  () => false,
);
const skip = ffmpegAvailable ? false : 'needs FFmpeg';

test(
  'an imported MP4 and an external sidecar are edited together and delivered with provenance',
  { skip },
  async () => {
    const parent = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-sidecar-e2e-'));
    const root = nodePath.join(parent, 'authoring');
    try {
      await createProject(root, { title: 'MP4 + sidecar', output: { width: 96, height: 54, fps: FPS } });

      // 1. Import BOTH host files, each as its own Asset with its own rights.
      const hostMp4 = await makeHostMp4(parent);
      const clip = await importAsset(root, {
        assetId: 'clip',
        sourcePath: hostMp4,
        type: 'video',
        rights: CLIP_RIGHTS,
        expectedRevision: (await loadProject(root)).revision,
      });
      const hostWav = await makeHostWav(parent);
      const bed = await importAsset(root, {
        assetId: 'bed',
        sourcePath: hostWav,
        type: 'audio',
        rights: SIDECAR_RIGHTS,
        expectedRevision: (await loadProject(root)).revision,
      });

      assert.equal(clip.type, 'video');
      assert.equal(bed.type, 'audio');
      assert.equal(
        await hashFile(nodePath.join(root, bed.path)),
        bed.sha256,
        'the sidecar bytes must be the imported host bytes',
      );
      assert.deepEqual(bed.rights, SIDECAR_RIGHTS, 'the sidecar keeps its own rights');
      const wav = readWav(await fs.readFile(nodePath.join(root, bed.path)));
      assert.equal(wav.channels, 2);
      assert.equal(wav.sampleRate, RATE);
      assert.equal(wav.samples, RATE, 'the sidecar must be exactly one second');

      // 2. First build: the imported clip's cut scored by the imported sidecar.
      await authorTimeline(root, 0.6);
      const first = await buildProject(root);
      assert.equal(first.status, 'succeeded', JSON.stringify(first.error));
      assert.equal(first.result!.simulated, false, 'imported real media is not simulated');
      const final1 = first.artifacts.find(artifact => artifact.id === first.result!.artifact)!;
      const info1 = await probeMedia(nodePath.join(root, final1.path));
      assert.match(info1.videoCodec, /h264|avc/i);
      assert.equal(info1.frames, FRAMES);
      assert.ok(info1.audio, 'the sidecar must give the delivered movie audio');
      assert.equal(info1.audio!.channels, 2);
      assert.equal(info1.audio!.sampleRate, RATE);
      assert.equal(
        first.operations.find(operation => operation.kind === 'normalize-media')!.reused,
        false,
        'a fresh build must normalize the imported media',
      );

      // 3. Edit the sidecar clip gain: only mixing + muxing re-run; the video reuses.
      const before = await loadProject(root);
      const edited = structuredClone(before);
      edited.composition!.audio = edited.composition!.audio.map(item =>
        item.id === 'bed_clip' ? { ...item, gain: 0.25 } : item,
      );
      await saveProject(root, edited, before.revision);
      const second = await buildProject(root);
      assert.equal(second.status, 'succeeded');
      assert.equal(
        second.operations.find(operation => operation.kind === 'normalize-media')!.reused,
        true,
        'a sidecar gain edit must reuse the imported video normalization',
      );
      assert.equal(second.operations.find(operation => operation.kind === 'mix-audio')!.reused, false);
      assert.equal(second.operations.find(operation => operation.kind === 'mux-final')!.reused, false);
      const final2 = second.artifacts.find(artifact => artifact.id === second.result!.artifact)!;
      assert.notEqual(final2.sha256, final1.sha256, 'a real gain change must produce different output bytes');

      // 4. Deliver: both imported Assets' rights reach the receiver.
      const bundle = nodePath.join(parent, 'bundle');
      const delivery = await deliverProject(root, bundle, { review: true, stems: true });
      assert.equal(delivery.movie!.sha256, await hashFile(nodePath.join(bundle, 'movie', 'final.mp4')));

      const facts = await fs.readFile(nodePath.join(bundle, 'index.html'), 'utf8');
      for (const rights of [CLIP_RIGHTS, SIDECAR_RIGHTS]) {
        assert.ok(facts.includes(rights.origin), `the facts page must record the origin "${rights.origin}"`);
        assert.ok(facts.includes(rights.license), `the facts page must record the license "${rights.license}"`);
      }
      assert.ok(facts.includes(bed.sha256), 'the facts page must record the sidecar sha256');

      const attribution = await fs.readFile(
        nodePath.join(bundle, 'project', '.viscraft', 'pages', 'ATTRIBUTION.md'),
        'utf8',
      );
      assert.ok(attribution.includes('| bed |'), 'ATTRIBUTION.md must carry the sidecar row');
      assert.ok(attribution.includes(SIDECAR_RIGHTS.license), 'ATTRIBUTION.md must carry the sidecar license');
      assert.ok(attribution.includes(SIDECAR_RIGHTS.author!), 'ATTRIBUTION.md must carry the sidecar author');

      // Both imported bytes really ship and are hashed in the manifest.
      for (const asset of [clip, bed]) {
        const bundled = nodePath.join(bundle, 'project', asset.path);
        assert.equal(await hashFile(bundled), asset.sha256, `the bundled ${asset.type} bytes must match the asset`);
      }
      const verification = await verifyDelivery(bundle);
      assert.equal(verification.ok, true, JSON.stringify(verification));

      // 5. The exported copy reopens and re-delivers the same movie.
      const disposable = nodePath.join(parent, 'disposable');
      await fs.cp(nodePath.join(bundle, 'project'), disposable, { recursive: true });
      const reopened = await loadProject(disposable);
      assert.deepEqual(
        reopened.assets.find(asset => asset.id === 'bed')!.rights,
        SIDECAR_RIGHTS,
        'the exported sidecar keeps its rights',
      );

      const rebuilt = await buildProject(disposable);
      assert.ok(
        rebuilt.operations.every(operation => operation.reused),
        'the exported media programme must rebuild with full reuse',
      );
      const bundle2 = nodePath.join(parent, 'bundle2');
      await deliverProject(disposable, bundle2, { review: true, stems: true });
      assert.equal(
        await hashFile(nodePath.join(bundle2, 'movie', 'final.mp4')),
        delivery.movie!.sha256,
        'redelivery must reproduce the same movie',
      );
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  },
);
