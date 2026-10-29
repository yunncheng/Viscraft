#!/usr/bin/env node
// Author a new audio-reference-directed visual work from a canonical
// `AudioReference` report plus the real approved audio it was measured from.
//
// This is a *generic* authoring entry point. The caller supplies:
//   - a canonical `AudioReference` report (see src/audio-reference.ts),
//   - the real PCM16 WAV that report's sha256 identifies,
//   - explicit rights for that audio,
//   - the output settings, an explicit trimmed interval [inFrame, outFrame),
//   - the cut boundaries the host wants between shots,
//   - the subset of measured onsets the host chooses to drive the visuals.
//
// The script never analyzes audio, never detects a beat/BPM, never calls a
// generation Provider, never transcodes, and never invents rights. It copies
// the approved bytes verbatim, maps each caller-chosen onset onto its
// shot-local integer frame with the report's *own* sample->frame mapping, and
// writes project.json plus a copy of audio-visual.html.
//
// Usage:
//   node tests/fixtures/authoring/create-audio-visual.mjs <new-project-directory> <config.json>
//
// config.json (strictly validated, unknown keys rejected; report/audio paths
// are resolved relative to the config file's directory, never the cwd):
//   {
//     "title": "optional display title",
//     "report": "analysis/report.json",          // canonical AudioReference report
//     "audio":  "analysis/track.wav",            // real PCM16 WAV; sha256 must equal report.source.sha256
//     "rights": { "origin": "...", "license": "...", "redistributable": true },
//     "output": { "width": 1280, "height": 720,
//                 "fps": { "numerator": 30, "denominator": 1 },
//                 "sampleRate": 48000, "channels": 2 },
//     "inFrame": 0,                              // inclusive trim start (report frame grid)
//     "outFrame": 240,                           // exclusive trim end
//     "cuts": [80, 160],                         // absolute interior boundaries, strictly inside (inFrame,outFrame), increasing, <= 11
//     "selectedOnsetSamples": [0, 24000, 48000], // caller subset of real report.onsets[].sample, unique, <= 500
//     "gain": 0.6,                               // optional clip gain in [0,1]
//     "palette": { "background": "#05060f", "foreground": "#e8f0ff", "accent": "#00e5ff" }
//   }
//
// Boundaries enforced here:
//   - output.fps must equal report.fps and output.sampleRate must equal
//     report.sampleRate; the report's frame/sample clock is reused as-is.
//   - The audio must already be PCM16 WAV at the report sample rate (RIFF/WAVE
//     signature + ffprobe codec pcm_s16le + a parsed 16-bit PCM data chunk).
//     Anything else is refused with a normalization/re-analysis hint; this
//     script never implicitly transcodes.
//   - inSample + durationSamples must fit inside report.samples, so the visuals
//     can never run past what the analysis actually measured.
//   - Every selected onset must exist in the report and lie inside the trimmed
//     interval; nothing is silently dropped or fabricated.
import { constants } from 'node:fs';
import { copyFile, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  AudioReferenceSchema,
  OutputSchema,
  RightsSchema,
  framesToSamples,
  validateProject,
} from '../../../dist/src/index.js';
import { hashFile } from '../../../dist/src/shared/hash.js';
import { runCommand } from '../../../dist/src/shared/process.js';

const [directory, configFile] = process.argv.slice(2);
if (!directory || !configFile) {
  throw new Error('Usage: node tests/fixtures/authoring/create-audio-visual.mjs <new-project-directory> <config.json>');
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_HTML = join(HERE, 'audio-visual.html');

// The rotating visual modes: consecutive shots read differently from the same
// palette so the cut structure stays legible without extra art direction.
const MODES = ['ripples', 'spokes', 'tiles'];

// --- Strict local config schema (only the documented keys are accepted). ----
const hexColor = z.string().regex(/^#[a-fA-F0-9]{6}$/);
const paletteSchema = z.object({ background: hexColor, foreground: hexColor, accent: hexColor }).strict();
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const configSchema = z
  .object({
    title: z.string().min(1).optional(),
    report: z.string().min(1),
    audio: z.string().min(1),
    rights: RightsSchema,
    output: OutputSchema,
    inFrame: integer,
    outFrame: integer.min(1),
    cuts: z.array(integer).max(11),
    selectedOnsetSamples: z.array(integer).max(500),
    gain: z.number().finite().min(0).max(1).optional(),
    palette: paletteSchema.optional(),
  })
  .strict();

const configPath = resolve(configFile);
const configDir = dirname(configPath);
const config = configSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));

// --- Canonical report, parsed and validated BEFORE any directory is made. ---
const report = AudioReferenceSchema.parse(JSON.parse(await readFile(resolve(configDir, config.report), 'utf8')));
if (
  BigInt(report.fps.numerator) * BigInt(config.output.fps.denominator) !==
  BigInt(config.output.fps.numerator) * BigInt(report.fps.denominator)
) {
  throw new Error(
    'output.fps must equal the report fps; re-analyze the audio reference at the intended output frame rate',
  );
}
if (report.sampleRate !== config.output.sampleRate) {
  throw new Error(
    `output.sampleRate ${config.output.sampleRate} must equal the report sampleRate ${report.sampleRate}`,
  );
}
if (config.outFrame <= config.inFrame)
  throw new Error(`outFrame ${config.outFrame} must be greater than inFrame ${config.inFrame}`);

// --- Caller cut boundaries: strictly inside the trim, increasing, unique. ----
let previous = config.inFrame;
for (const cut of config.cuts) {
  if (cut <= previous)
    throw new Error(
      `cuts must strictly increase inside (${config.inFrame}, ${config.outFrame}); got ${cut} after ${previous}`,
    );
  if (cut >= config.outFrame)
    throw new Error(`cut ${cut} must be strictly inside (${config.inFrame}, ${config.outFrame})`);
  previous = cut;
}

// --- Selected onsets: unique, real, and inside the full chosen interval. ----
const selectedSamples = [...config.selectedOnsetSamples];
if (new Set(selectedSamples).size !== selectedSamples.length) throw new Error('selectedOnsetSamples must be unique');
selectedSamples.sort((a, b) => a - b);
const onsetBySample = new Map(report.onsets.map(onset => [onset.sample, onset]));
const selectedOnsets = [];
for (const sample of selectedSamples) {
  const onset = onsetBySample.get(sample);
  if (!onset) throw new Error(`selected onset sample ${sample} is not present in the report's onsets`);
  if (onset.outputFrame < config.inFrame || onset.outputFrame >= config.outFrame) {
    throw new Error(
      `selected onset sample ${sample} maps to frame ${onset.outputFrame}, outside the trimmed interval [${config.inFrame}, ${config.outFrame})`,
    );
  }
  selectedOnsets.push(onset);
}

// --- The real audio must be an already-PCM16 WAV the report measured. -------
const absoluteAudio = resolve(configDir, config.audio);
const audioHead = Buffer.alloc(12);
{
  const handle = await open(absoluteAudio, 'r');
  try {
    const { bytesRead } = await handle.read(audioHead, 0, 12, 0);
    if (
      bytesRead < 12 ||
      audioHead.toString('ascii', 0, 4) !== 'RIFF' ||
      audioHead.toString('ascii', 8, 12) !== 'WAVE'
    ) {
      throw new Error(
        `Audio ${config.audio} is not a RIFF/WAVE file; supply an already-PCM16 WAV reference (normalize/transcode and re-analyze first)`,
      );
    }
  } finally {
    await handle.close();
  }
}

/** Parse the canonical WAV chunks: exact fmt (PCM16 + rate + channels) and data size. */
async function readWavHeader(file) {
  const handle = await open(file, 'r');
  try {
    const length = (await handle.stat()).size;
    let offset = 12;
    let fmt = null;
    let dataBytes = null;
    for (let guard = 0; guard < 64 && (fmt === null || dataBytes === null); guard++) {
      const header = Buffer.alloc(8);
      const { bytesRead } = await handle.read(header, 0, 8, offset);
      if (bytesRead < 8) break;
      const id = header.toString('ascii', 0, 4);
      const size = header.readUInt32LE(4);
      if (offset + 8 + size > length) throw new Error(`Truncated WAV chunk in ${file}`);
      if (id === 'fmt ') {
        const body = Buffer.alloc(Math.min(size, 40));
        const read = await handle.read(body, 0, body.length, offset + 8);
        if (read.bytesRead !== body.length || body.length < 16)
          throw new Error(`WAV fmt chunk is truncated in ${file}`);
        fmt = {
          audioFormat: body.readUInt16LE(0),
          channels: body.readUInt16LE(2),
          sampleRate: body.readUInt32LE(4),
          bitsPerSample: body.readUInt16LE(14),
        };
      } else if (id === 'data') {
        dataBytes = size;
      }
      offset += 8 + size + (size % 2);
    }
    return { fmt, dataBytes };
  } finally {
    await handle.close();
  }
}

const wav = await readWavHeader(absoluteAudio);
if (!wav.fmt || wav.dataBytes === null)
  throw new Error(`Audio ${config.audio} has no readable fmt/data WAV chunk; supply an already-PCM16 WAV reference`);
if (
  wav.fmt.audioFormat !== 1 ||
  wav.fmt.bitsPerSample !== 16 ||
  ![1, 2].includes(wav.fmt.channels) ||
  wav.dataBytes % (wav.fmt.channels * 2) !== 0
) {
  throw new Error(
    `Audio ${config.audio} is not 16-bit PCM WAV (audioFormat=${wav.fmt.audioFormat}, bits=${wav.fmt.bitsPerSample}); normalize/transcode to PCM16 WAV and re-analyze before authoring`,
  );
}
if (wav.fmt.sampleRate !== report.sampleRate) {
  throw new Error(
    `Audio ${config.audio} sample rate ${wav.fmt.sampleRate} does not match the report sampleRate ${report.sampleRate}; normalize/re-analyze first`,
  );
}
const fileSamples = Math.floor(wav.dataBytes / (wav.fmt.channels * 2));

// ffprobe confirms the container/codec identity the report claims.
const probe = JSON.parse(
  await runCommand('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-show_entries',
    'stream=codec_name,sample_rate,channels,duration:format=duration',
    '-of',
    'json',
    absoluteAudio,
  ]),
);
const stream = Array.isArray(probe.streams) ? probe.streams[0] : undefined;
if (!stream || stream.codec_name !== 'pcm_s16le') {
  throw new Error(
    `Audio ${config.audio} codec is ${stream ? stream.codec_name : 'absent'}, not pcm_s16le; this example only accepts an already-PCM16 WAV reference (normalize/transcode and re-analyze)`,
  );
}
if (Number(stream.sample_rate) !== report.sampleRate) {
  throw new Error(
    `Audio ${config.audio} probe sample rate ${stream.sample_rate} does not match the report sampleRate ${report.sampleRate}`,
  );
}
if ((await hashFile(absoluteAudio)) !== report.source.sha256) {
  throw new Error(
    `Audio ${config.audio} sha256 does not match report.source.sha256; the report was not measured from these bytes`,
  );
}

// --- Exact sample window: the caller's trim, on the report's own clock. ------
const fps = report.fps;
const sampleRate = report.sampleRate;
const totalFrames = config.outFrame - config.inFrame;
if (totalFrames > 1800) throw new Error('This example supports at most 1800 output frames');
const inSample = framesToSamples(config.inFrame, fps, sampleRate);
const durationSamples = framesToSamples(totalFrames, fps, sampleRate, 'ceil');
if (inSample + durationSamples > report.samples) {
  throw new Error(
    `trim [${config.inFrame}, ${config.outFrame}) needs samples [${inSample}, ${inSample + durationSamples}) but the report only measured ${report.samples}`,
  );
}
if (inSample + durationSamples > fileSamples) {
  throw new Error(
    `trim [${config.inFrame}, ${config.outFrame}) needs samples [${inSample}, ${inSample + durationSamples}) but ${config.audio} only holds ${fileSamples}`,
  );
}

for (const onset of selectedOnsets) {
  if (onset.sample < inSample || onset.sample >= inSample + durationSamples)
    throw new Error(`Selected onset ${onset.sample} is outside the actual audio trim`);
}

// --- Resolve the entry template before touching the filesystem. -------------
if (
  !(await hashFile(SOURCE_HTML).then(
    () => true,
    () => false,
  ))
)
  throw new Error(`Missing CodeScene entry ${SOURCE_HTML}`);

// --- Create the new Project only now; refuse to overwrite existing work. ----
const root = resolve(directory);
try {
  await mkdir(root);
} catch (error) {
  if (error.code === 'EEXIST')
    throw new Error(`Refusing to overwrite existing path ${root}; choose a new project directory`);
  throw error;
}
await mkdir(join(root, 'assets'));
const trackRelative = 'assets/track.wav';
await copyFile(absoluteAudio, join(root, trackRelative), constants.COPYFILE_EXCL);
if ((await hashFile(join(root, trackRelative))) !== report.source.sha256) {
  throw new Error(
    'Copied track.wav bytes do not match report.source.sha256; aborting instead of authoring a mismatched Project',
  );
}

// The evidence asset is the exact canonical JSON record of the measured
// report, hashed from the bytes actually written, so its record hash is real.
const evidenceRelative = 'assets/audio-evidence.json';
const evidenceBytes = Buffer.from(JSON.stringify(report, null, 2) + '\n', 'utf8');
await writeFile(join(root, evidenceRelative), evidenceBytes, { flag: 'wx' });
const evidenceSha256 = await hashFile(join(root, evidenceRelative));

await copyFile(SOURCE_HTML, join(root, 'audio-visual.html'), constants.COPYFILE_EXCL);

// --- One independent code Source per caller cut, contiguous on the timeline. -
const scene = 'audio-visual-scene';
const look = 'audio-visual-look';
const palette = config.palette ?? { background: '#05060f', foreground: '#e8f0ff', accent: '#00e5ff' };
const boundaries = [config.inFrame, ...config.cuts, config.outFrame];
const sources = [];
const shots = [];
const placements = [];
const selectedEvents = [];
const shotReports = [];
for (let index = 0; index < boundaries.length - 1; index++) {
  const absoluteShotStart = boundaries[index];
  const absoluteShotEnd = boundaries[index + 1];
  const sourceFrames = absoluteShotEnd - absoluteShotStart;
  const sourceId = `shot-${index + 1}`;
  const mode = MODES[index % MODES.length];
  // Each onset keeps the report's own outputFrame; the shot-local frame is a
  // single explicit subtraction of the shot start. No second time conversion.
  const events = selectedOnsets
    .filter(onset => onset.outputFrame >= absoluteShotStart && onset.outputFrame < absoluteShotEnd)
    .map(onset => ({ frame: onset.outputFrame - absoluteShotStart, sample: onset.sample, strength: onset.strength }));
  for (const event of events)
    selectedEvents.push({
      shot: sourceId,
      localFrame: event.frame,
      sample: event.sample,
      outputFrame: event.frame + absoluteShotStart,
      strength: event.strength,
    });
  sources.push({
    id: sourceId,
    kind: 'browser', output: 'picture',
    entry: 'audio-visual.html',
    resources: [],
    bindings: ['evidence'],
    params: {
      frames: sourceFrames,
      globalStartFrame: absoluteShotStart,
      inFrame: config.inFrame,
      sourceHash: report.source.sha256,
      events,
      palette,
      mode,
    },
    seed: 0,
    frames: sourceFrames,
  });
  shots.push({
    id: sourceId,
    scene,
    look,
    targetFrames: sourceFrames,
    intent: `Shot ${index + 1} (${mode}): draw ${events.length} caller-selected measured onset(s) on this cut's own integer frames from the shared source hash; no BPM, lip-sync or generation claim is made.`,
  });
  placements.push({
    id: `cut-${index + 1}`,
    shot: sourceId,
    source: sourceId,
    inFrame: 0,
    outFrame: sourceFrames,
    startFrame: absoluteShotStart - config.inFrame,
    audio: 'mute',
  });
  shotReports.push({
    id: sourceId,
    mode,
    globalStartFrame: absoluteShotStart,
    sourceFrames,
    startFrame: absoluteShotStart - config.inFrame,
    events: events.length,
  });
}

const project = validateProject({
  schemaVersion: 1,
  id: `audio-visual-${randomUUID()}`,
  revision: 1,
  title: config.title ?? 'AUDIO-VISUAL — measured-onset events',
  direction: {
    intent:
      "Re-author a new work from a private audio reference. The caller trims an interval, chooses the cut boundaries and picks which measured 10 ms RMS energy-rise onsets drive the visuals. Each chosen onset is placed on its shot-local integer frame using the report's own exact sample-to-frame map (report.outputFrame minus the shot start) and drives a local pulse that decays over about eight frames; the base visual reads even before the first onset. This is NOT a beat/BPM detector, NOT lip-sync, NOT subjective listening, and NOT proof that any generative model heard or understood the audio: the report is a fixed energy heuristic over decoded PCM. The approved track bytes remain unchanged as an Asset; Composition explicitly trims at inSample, applies gain and encodes the soundtrack without synthesized replacement or fake playback. Review the actual Build frames and the mixed audio before accepting.",
    looks: [
      {
        id: look,
        description:
          'One shared palette; consecutive cuts rotate ripples, spokes and tiles so the structure reads without extra art direction.',
      },
    ],
    transitions: [],
  },
  assets: [
    {
      id: 'track',
      revision: 1,
      path: trackRelative,
      sha256: report.source.sha256,
      type: 'audio',
      rights: config.rights,
      simulated: report.source.simulated,
    },
    {
      id: 'audio-evidence',
      revision: 1,
      path: evidenceRelative,
      sha256: evidenceSha256,
      type: 'code',
      rights: config.rights,
      simulated: report.source.simulated,
    },
  ],
  bindings: { evidence: 'audio-evidence' },
  sources,
  composition: {
    output: config.output,
    scenes: [{ id: scene, description: 'Caller-cut sequence of measured-onset event shots' }],
    shots,
    placements,
    transitions: [], // Hard, explicit cuts only.
    audio: [
      {
        id: 'track',
        kind: 'asset',
        asset: 'track',
        inSample,
        startSample: 0,
        durationSamples,
        gain: config.gain ?? 0.6,
        fadeInSamples: 0,
        fadeOutSamples: 0,
      },
    ],
  },
});
await writeFile(join(root, 'project.json'), JSON.stringify(project, null, 2) + '\n', { flag: 'wx' });

console.log(
  JSON.stringify(
    {
      project: root,
      authored: true,
      built: false,
      provider: null,
      title: project.title,
      output: config.output,
      sourceHash: report.source.sha256,
      reference: {
        report: config.report,
        origin: report.source.origin,
        simulated: report.source.simulated,
        fps: report.fps,
        sampleRate: report.sampleRate,
        samples: report.samples,
        onsets: report.onsets.length,
        selectedOnsets: selectedOnsets.length,
        limitations: report.limitations.length,
      },
      clock: {
        fps,
        sampleRate,
        inFrame: config.inFrame,
        outFrame: config.outFrame,
        frames: totalFrames,
        inSample,
        durationSamples,
        totalSamples: durationSamples,
        mapping: {
          inSample: 'framesToSamples(inFrame,fps,sampleRate)',
          durationSamples: 'framesToSamples(outFrame-inFrame,fps,sampleRate,ceil)',
          event: 'localFrame = report.outputFrame - absoluteShotStart (single subtraction)',
        },
      },
      trimOffset: {
        inFrame: config.inFrame,
        inSample,
        note: 'report onset outputFrame is offset by the explicit inFrame subtraction, never re-derived from seconds',
      },
      cuts: config.cuts,
      shots: shotReports,
      selectedEvents,
      audio: {
        asset: 'track',
        path: trackRelative,
        inSample,
        startSample: 0,
        durationSamples,
        gain: config.gain ?? 0.6,
        fadeInSamples: 0,
        fadeOutSamples: 0,
      },
      assets: [
        {
          id: 'track',
          path: trackRelative,
          type: 'audio',
          sha256: report.source.sha256,
          simulated: report.source.simulated,
        },
        {
          id: 'audio-evidence',
          path: evidenceRelative,
          type: 'code',
          sha256: evidenceSha256,
          simulated: report.source.simulated,
        },
      ],
      disclaimer: [
        'Onsets are a fixed 10 ms RMS energy-rise heuristic from the canonical report; this is not a musical beat/BPM/tempo claim and not subjective listening.',
        'The host selects events and cuts from a measured report; this authoring script performs no additional detection, auto-cutting or Provider generation.',
        'The approved track is copied unchanged; Composition explicitly trims, gains, resamples/mixes and encodes it. The example never transposes timing or replaces it with synthesized sound.',
        'Selection is a caller subset that must exist in the report and lie inside the trim; no onset is fabricated or silently dropped.',
        'This work is authored only: no Build ran and no frames or audio were rendered.',
      ],
      next: 'Review this authored audio-visual work; then run the canonical Build (buildProject) to render the event shots and mix the approved track, inspect the actual frames and audio, and adjust cuts, selected onsets, palette or gain. This script never called a Build or Provider.',
    },
    null,
    2,
  ),
);
