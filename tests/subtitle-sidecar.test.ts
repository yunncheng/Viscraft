import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import {
  SRT_LINE_ENDING,
  frameToMilliseconds,
  formatSrtTimecode,
  renderSubtitleSidecar,
} from '../src/operations/delivery/subtitle-sidecar.js';
import { buildProject } from '../src/build/build.js';
import { deliverProject } from '../src/operations/delivery/delivery.js';
import { hashFile } from '../src/shared/hash.js';
import { ProjectSchema, SubtitleSchema } from '../src/core/schema.js';
import type { Fps, Project, Subtitle } from '../src/core/schema.js';
import { makeSignalAsset } from './audio-fixtures.js';

const SIGNAL = makeSignalAsset({
  id: 'bed',
  path: 'signal.wav',
  sampleRate: 48000,
  channels: 2,
  samples: 24000,
  frequency: 440,
});

const FPS_25: Fps = { numerator: 25, denominator: 1 };
const FPS_NTSC: Fps = { numerator: 30000, denominator: 1001 };

function subtitle(overrides: Partial<Subtitle> = {}): Subtitle {
  return { id: 'sub_1', text: 'HELLO', startFrame: 25, endFrame: 50, fontSize: 24, color: '#ffffff', ...overrides };
}

async function tempDir(): Promise<string> {
  return fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-subtitle-sidecar-test-'));
}

/** Every regular file under `dir`, as sorted `/`-separated relative paths. */
async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = nodePath.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(absolute, relative)));
    else if (entry.isFile()) out.push(relative);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

// --- Pure frame -> timecode mapping -----------------------------------------

test('frameToMilliseconds maps frames exactly at an integer rate', () => {
  assert.equal(frameToMilliseconds(0, FPS_25), 0);
  assert.equal(frameToMilliseconds(1, FPS_25), 40);
  assert.equal(frameToMilliseconds(25, FPS_25), 1000);
  assert.equal(frameToMilliseconds(50, FPS_25), 2000);
  assert.equal(frameToMilliseconds(3750, FPS_25), 150_000);
});

test('frameToMilliseconds maps frames exactly at 30000/1001 with round-half-up', () => {
  // 30 * 1001 * 1000 / 30000 = 1001 ms exactly; 60 -> 2002 ms exactly.
  assert.equal(frameToMilliseconds(30, FPS_NTSC), 1001);
  assert.equal(frameToMilliseconds(60, FPS_NTSC), 2002);
  // 1 * 1001000 / 30000 = 33.3666... -> 33; 29 -> 967.6333... -> 968.
  assert.equal(frameToMilliseconds(1, FPS_NTSC), 33);
  assert.equal(frameToMilliseconds(29, FPS_NTSC), 968);
});

test('formatSrtTimecode emits HH:MM:SS,mmm with zero padding', () => {
  assert.equal(formatSrtTimecode(0), '00:00:00,000');
  assert.equal(formatSrtTimecode(1001), '00:00:01,001');
  assert.equal(formatSrtTimecode(3_661_001), '01:01:01,001');
});

// --- SRT text generation -----------------------------------------------------

test('renderSubtitleSidecar writes sequential 1-based cues with CRLF and half-open intervals', () => {
  const srt = renderSubtitleSidecar(
    [
      subtitle({ id: 'sub_a', text: 'first', startFrame: 25, endFrame: 50 }),
      subtitle({ id: 'sub_b', text: 'second', startFrame: 50, endFrame: 75 }),
    ],
    FPS_25,
  );
  assert.equal(
    srt,
    '1\r\n00:00:01,000 --> 00:00:02,000\r\nfirst\r\n\r\n' + '2\r\n00:00:02,000 --> 00:00:03,000\r\nsecond\r\n\r\n',
  );
  // Structural line endings are CRLF only: every LF is preceded by CR.
  assert.equal(/(?<!\r)\n/.test(srt), false, 'SRT must not contain a bare LF');
  assert.equal(srt.endsWith(SRT_LINE_ENDING.repeat(2)), true, 'file ends with a blank CRLF line');
});

test('renderSubtitleSidecar uses exact rational timecodes at a non-integer rate', () => {
  const srt = renderSubtitleSidecar([subtitle({ startFrame: 30, endFrame: 60 })], FPS_NTSC);
  assert.equal(srt, '1\r\n00:00:01,001 --> 00:00:02,002\r\nHELLO\r\n\r\n');
});

test('renderSubtitleSidecar keeps caption text verbatim (no HTML/markup escaping)', () => {
  const hostile = '<b>bold</b> & "quoted" a\\b:c,d';
  const srt = renderSubtitleSidecar([subtitle({ text: hostile })], FPS_25);
  assert.ok(srt.includes(hostile), 'text is emitted verbatim');
  assert.equal(srt.includes('&lt;'), false, 'subtitle text is not HTML-escaped');
  assert.equal(srt.includes('&amp;'), false, 'ampersands are not HTML-escaped');
});

test('renderSubtitleSidecar returns an empty string for no captions', () => {
  assert.equal(renderSubtitleSidecar([], FPS_25), '');
});

/** Count SRT cues the way a reader does: a 1-based index line followed by a timing line. */
function countCues(srt: string): number {
  const lines = srt.split(/\r?\n/);
  let cues = 0;
  for (let i = 0; i + 1 < lines.length; i++) {
    if (/^\d+$/.test(lines[i]) && /-->/.test(lines[i + 1])) cues++;
  }
  return cues;
}

test('renderSubtitleSidecar rejects captions with blank lines (schema and renderer)', () => {
  const blank = ['line1\n\nline2', 'line1\r\n\r\nline2', 'line1\n\r\nline2', '\nline1', 'line1\n', '\r'];
  for (const text of blank) {
    const caption = subtitle({ text });
    assert.equal(SubtitleSchema.safeParse(caption).success, false, `schema rejects ${JSON.stringify(text)}`);
    assert.throws(() => renderSubtitleSidecar([caption], FPS_25), `renderer rejects ${JSON.stringify(text)}`);
  }
  // A single internal break is not a blank line and stays valid.
  assert.equal(SubtitleSchema.safeParse(subtitle({ text: 'line1\nline2' })).success, true);
});

test('renderSubtitleSidecar preserves a single internal line break as CRLF', () => {
  for (const text of ['line1\nline2', 'line1\r\nline2', 'line1\rline2']) {
    const srt = renderSubtitleSidecar([subtitle({ text })], FPS_25);
    assert.equal(srt, '1\r\n00:00:01,000 --> 00:00:02,000\r\nline1\r\nline2\r\n\r\n');
    assert.equal(/(?<!\r)\n/.test(srt), false, 'no bare LF may remain');
    assert.equal(/\r(?!\n)/.test(srt), false, 'no bare CR may remain');
  }
});

test('no accepted caption can inject an extra SRT cue (cue count equals subtitle count)', () => {
  // The verifier's payload is rejected outright by the shared schema, so it can
  // never reach the sidecar as a second cue.
  const injected = 'line1\n\n1\n00:00:00,000 --> 00:00:00,001\ninjected';
  assert.equal(SubtitleSchema.safeParse(subtitle({ text: injected })).success, false);
  assert.throws(() => renderSubtitleSidecar([subtitle({ text: injected })], FPS_25));

  // Every accepted caption (including multi-line ones) yields exactly one cue.
  const accepted = [
    subtitle({ id: 'sub_single', text: 'single', startFrame: 0, endFrame: 25 }),
    subtitle({ id: 'sub_multi', text: 'line1\nline2', startFrame: 25, endFrame: 50 }),
    subtitle({ id: 'sub_multi_crlf', text: 'a\r\nb', startFrame: 50, endFrame: 75 }),
  ];
  const srt = renderSubtitleSidecar(accepted, FPS_25);
  assert.equal(countCues(srt), accepted.length);
  assert.equal(/(?<!\r)\n/.test(srt), false, 'no bare LF may remain');
  assert.equal(/\r(?!\n)/.test(srt), false, 'no bare CR may remain');
});

// --- Validation reuses the shared SubtitleSchema ----------------------------

test('renderSubtitleSidecar rejects exactly what SubtitleSchema rejects', () => {
  const invalid: Array<Partial<Subtitle>> = [
    { color: 'red' },
    { color: '#fff' },
    { startFrame: 5, endFrame: 5 },
    { startFrame: 5, endFrame: 4 },
    { text: '' },
    { text: 'a\u0000b' },
    { fontSize: 0 },
    { fontSize: 513 },
  ];
  for (const overrides of invalid) {
    const caption = subtitle(overrides);
    assert.equal(SubtitleSchema.safeParse(caption).success, false, `schema rejects ${JSON.stringify(overrides)}`);
    assert.throws(() => renderSubtitleSidecar([caption], FPS_25), `sidecar rejects ${JSON.stringify(overrides)}`);
  }
  // A valid caption is accepted.
  assert.equal(SubtitleSchema.safeParse(subtitle()).success, true);
  assert.doesNotThrow(() => renderSubtitleSidecar([subtitle()], FPS_25));
});

// --- Delivery integration ----------------------------------------------------

/**
 * A buildable project over three simulated sources (two cuts), one registered
 * audio signal Asset and, when requested, one subtitle. Mirrors
 * tests/delivery.test.ts so the Build produces a real openable movie through the
 * normal FFmpeg path.
 */
function makeProject(withSubtitles: boolean): Project {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'subtitle_sidecar_test',
    revision: 1,
    title: 'Subtitle Sidecar Test',
    direction: {
      intent: 'Delivery with a subtitle sidecar.',
      looks: [{ id: 'look_main', description: 'main look' }],
      transitions: [],
    },
    assets: [SIGNAL.asset],
    bindings: {},
    sources: [
      {
        id: 'src_a',
        kind: 'simulated',
        prompt: 'shot a',
        frames: 20,
        seed: 1,
        attempt: 'attempt_a',
        behavior: 'success',
      },
      {
        id: 'src_b',
        kind: 'simulated',
        prompt: 'shot b',
        frames: 20,
        seed: 2,
        attempt: 'attempt_b',
        behavior: 'success',
      },
      {
        id: 'src_c',
        kind: 'simulated',
        prompt: 'shot c',
        frames: 20,
        seed: 3,
        attempt: 'attempt_c',
        behavior: 'success',
      },
    ],
    composition: {
      output: { width: 160, height: 120, fps: { numerator: 25, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene_1', description: 'scene' }],
      shots: [
        { id: 'shot_a', scene: 'scene_1', look: 'look_main', intent: 'a', targetFrames: 20 },
        { id: 'shot_b', scene: 'scene_1', look: 'look_main', intent: 'b', targetFrames: 20 },
        { id: 'shot_c', scene: 'scene_1', look: 'look_main', intent: 'c', targetFrames: 20 },
      ],
      placements: [
        { id: 'pl_a', shot: 'shot_a', source: 'src_a', inFrame: 0, outFrame: 20, startFrame: 0, audio: 'mute' },
        { id: 'pl_b', shot: 'shot_b', source: 'src_b', inFrame: 0, outFrame: 20, startFrame: 20, audio: 'mute' },
        { id: 'pl_c', shot: 'shot_c', source: 'src_c', inFrame: 0, outFrame: 20, startFrame: 40, audio: 'mute' },
      ],
      transitions: [],
      audio: [
        {
          id: 'bed',
          kind: 'asset',
          asset: 'bed',
          inSample: 0,
          startSample: 0,
          durationSamples: 24000,
          gain: 0.3,
          fadeInSamples: 480,
          fadeOutSamples: 480,
        },
      ],
      ...(withSubtitles
        ? {
            subtitles: [
              { id: 'sub_1', text: 'Hello world', startFrame: 20, endFrame: 40, fontSize: 32, color: '#ffffff' },
            ],
          }
        : {}),
    },
  });
}

async function buildAt(root: string, project: Project): Promise<string> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(nodePath.join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  await fs.writeFile(nodePath.join(root, SIGNAL.asset.path), SIGNAL.bytes);
  const record = await buildProject(root);
  assert.equal(record.status, 'succeeded');
  return record.id;
}

test('deliverProject emits and hashes movie/final.srt when subtitles are declared', async () => {
  const parent = await tempDir();
  const root = nodePath.join(parent, 'authoring');
  const destination = nodePath.join(parent, 'bundle');
  try {
    const project = makeProject(true);
    await buildAt(root, project);
    const expected = renderSubtitleSidecar(project.composition!.subtitles ?? [], project.composition!.output.fps);
    assert.equal(expected, '1\r\n00:00:00,800 --> 00:00:01,600\r\nHello world\r\n\r\n');

    const delivery = await deliverProject(root, destination, { review: true, stems: true });

    // The sidecar exists, is byte-identical to the deterministic renderer and is
    // reported in the typed result.
    const sidecarPath = nodePath.join(destination, 'movie', 'final.srt');
    assert.equal(await fs.readFile(sidecarPath, 'utf8'), expected, 'sidecar bytes equal the deterministic SRT');
    assert.ok(delivery.subtitles, 'delivery reports the sidecar');
    assert.equal(delivery.subtitles!.path, 'movie/final.srt');
    assert.equal(delivery.subtitles!.captions, 1);
    assert.equal(delivery.subtitles!.bytes, Buffer.byteLength(expected, 'utf8'));
    assert.equal(delivery.subtitles!.sha256, await hashFile(sidecarPath));

    // The manifest registers it with sha256 and byte size in the same files[] shape.
    const manifest = JSON.parse(await fs.readFile(nodePath.join(destination, 'delivery-manifest.json'), 'utf8')) as {
      subtitles: { path: string; sha256: string; bytes: number; captions: number } | null;
      files: Array<{ path: string; sha256: string; bytes: number; role: string }>;
    };
    const entry = manifest.files.find(file => file.path === 'movie/final.srt');
    assert.ok(entry, 'the manifest lists the sidecar');
    assert.equal(entry!.role, 'subtitle');
    assert.equal(entry!.sha256, delivery.subtitles!.sha256);
    assert.equal(entry!.bytes, Buffer.byteLength(expected, 'utf8'));
    assert.equal(entry!.sha256, await hashFile(sidecarPath), 'manifest hash matches the written file');
    assert.deepEqual(manifest.subtitles, {
      path: 'movie/final.srt',
      sha256: delivery.subtitles!.sha256,
      bytes: delivery.subtitles!.bytes,
      captions: 1,
    });

    // The bundle hash-verify path covers the sidecar: the manifest allowlist is
    // exactly the staged file set (including movie/final.srt).
    const listed = new Set(manifest.files.map(file => file.path));
    const actual = (await listFiles(destination)).filter(file => file !== 'delivery-manifest.json');
    assert.deepEqual([...listed].sort(), actual.sort(), 'manifest allowlists exactly the bundled files');
    assert.ok(actual.includes('movie/final.srt'));

    // index.html links the sidecar for discoverability.
    const index = await fs.readFile(nodePath.join(destination, 'index.html'), 'utf8');
    assert.ok(index.includes('movie/final.srt'), 'index links the sidecar');
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('deliverProject writes no sidecar and no manifest entry when there are no subtitles', async () => {
  const parent = await tempDir();
  const root = nodePath.join(parent, 'authoring');
  const destination = nodePath.join(parent, 'bundle');
  try {
    await buildAt(root, makeProject(false));
    const delivery = await deliverProject(root, destination, { review: true, stems: true });

    assert.equal(delivery.subtitles, null, 'no sidecar is reported');
    assert.equal(
      await fs.stat(nodePath.join(destination, 'movie', 'final.srt')).then(
        () => true,
        () => false,
      ),
      false,
      'no sidecar file is written',
    );

    const manifest = JSON.parse(await fs.readFile(nodePath.join(destination, 'delivery-manifest.json'), 'utf8')) as {
      subtitles: unknown;
      files: Array<{ path: string }>;
    };
    assert.equal(manifest.subtitles, null);
    assert.equal(
      manifest.files.some(file => file.path === 'movie/final.srt'),
      false,
      'no manifest entry for the sidecar',
    );
    const actual = (await listFiles(destination)).filter(file => file !== 'delivery-manifest.json');
    assert.deepEqual([...new Set(manifest.files.map(file => file.path))].sort(), actual.sort());
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
