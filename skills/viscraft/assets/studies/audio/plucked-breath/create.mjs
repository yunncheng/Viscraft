#!/usr/bin/env node
/*
 * Viscraft author recipe: instantiate the plucked-breath passage into a NEW Project.
 *
 *   viscraft author create.mjs <new-project-directory> [--options <json-file>]
 *
 * Options:
 *
 *   { "variant": "base", "transpose": 0, "gain": 1, "seed": 7 }
 *
 * This is a SOUND-ONLY study. It authors one `browser` Source with
 * `output: "sound"` on its native 48 kHz sample clock, and one sound target at
 * 44.1 kHz that delivers the passage. There is no picture Source, slate or
 * video, no composition and no fabricated raster/FPS; the mixer resamples the
 * native Take to the target rate while preserving the authored seconds. The
 * Project remains a complete current author closure: its code files, README and
 * licences are all declared, hashed and copied by `authorProject`.
 *
 * Produce the WAV with `viscraft build <project> --target master`. Authoring
 * performs no Build, provider request or network access.
 *
 * The module and entry are imported/copied from this directory by relative path;
 * the Runtime's verbatim THIRD_PARTY_NOTICES.md is located through
 * `runtime.runtimeLocation(root)` and travels as a `license` handoff file.
 */
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScore, DEFAULT_PARAMS, SECONDS, normalizeParams } from './score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = 'score.mjs';
const SOUND = 'sound.html';
const README = 'README.md';
const LICENSES = 'LICENSES.md';
const NOTICE = 'THIRD_PARTY_NOTICES.md';

// Native page rate, and a deliberately different delivery rate: the target
// proves that resampling 48 kHz -> 44.1 kHz preserves the authored seconds.
const SOURCE_RATE = 48000;
const TARGET_RATE = 44100;
const SOURCE_SAMPLES = Math.round(SECONDS * SOURCE_RATE);
const TARGET_SAMPLES = Math.round(SECONDS * TARGET_RATE);

const OPTION_KEYS = new Set(['variant', 'transpose', 'gain', 'seed']);

const ENTRY_RIGHTS = Object.freeze({
  origin: 'original: the window.viscraftSound entry page authored for Viscraft',
  license: 'Apache-2.0',
  redistributable: true,
  author: 'The Viscraft Authors',
});

const RIGHTS = Object.freeze({
  origin:
    'adapted from lemo-opuscar core/audio/pluck.py@e3cb16f63768c68693ff0e15171d6e755457cc32 ' +
    '(lines 39-60 variable fractional delay/waveguide loop, 75-83 body-resonance bank, 91 guqin preset, ' +
    '121-132 pitch curves, 135-160 harmonics/bends/slide, 173-180 body application) and styles/ink-wash/demo/music/score.py@e3cb16f63768c68693ff0e15171d6e755457cc32 ' +
    '(lines 20-24 guqin/harmonic helpers, 27-34 xiao build, 44-63 sparse opening, 65-84 90 BPM ostinato, ' +
    '86-98 drum crescendo, 100-114 separate pre-reverb/hard cut, 133 cadence, 154-159 gate_zero) ' +
    '(LemoLab, MIT)',
  license: 'Apache-2.0 AND MIT',
  redistributable: true,
  author: 'LemoLab',
  sourceUrl:
    'https://github.com/lemomo-ai/lemo-opuscar/tree/e3cb16f63768c68693ff0e15171d6e755457cc32',
  licenseUrl: 'https://github.com/lemomo-ai/lemo-opuscar/blob/e3cb16f63768c68693ff0e15171d6e755457cc32/LICENSE',
  attributionRequired: true,
  notice: 'MIT (c) 2026 LemoLab, lemo-opuscar e3cb16f63768c68693ff0e15171d6e755457cc32; Viscraft-original implementation and passage (c) 2026 The Viscraft Authors. See LICENSES.md.',
  modifications:
    'Rewritten as dependency-free JavaScript for window.viscraftSound; no Python/NumPy/SciPy/numba, no ' +
    'sampler, no recordings, no TTS, no mux and no second timeline. A new 32 s non-combat passage, section ' +
    'plan, motifs, gains, cue list and a seeded PRNG; the xiao is a synthetic breath/flute, not a recording; ' +
    'drums are procedural; the hard cut removes the authored reverb as well as the dry signal.',
});

function slugToId(name) {
  const cleaned =
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'score';
  return ('plucked-breath-' + (/^[a-z0-9]/.test(cleaned) ? cleaned : 'p-' + cleaned)).slice(0, 96);
}

function normalizeOptions(raw = {}, defaults) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('plucked-breath options must be a JSON object');
  for (const key of Object.keys(raw))
    if (!OPTION_KEYS.has(key))
      throw new Error(`plucked-breath does not take the option "${key}"; use ${[...OPTION_KEYS].join(', ')}`);
  const options = {
    variant: defaults.variant,
    transpose: defaults.transpose,
    gain: defaults.gain,
    seed: 7,
    ...raw,
  };
  const params = normalizeParams({
    variant: options.variant,
    transpose: options.transpose,
    gain: options.gain,
  });
  if (!Number.isInteger(options.seed)) throw new Error('seed must be an integer');
  return { options: { ...options, ...params }, params };
}

export default async function create({ root, options: rawOptions, runtime }) {
  const { options, params } = normalizeOptions(rawOptions ?? {}, DEFAULT_PARAMS);
  const score = buildScore(params);
  // Preflight the score before the Runtime publishes anything.
  if (score.seconds !== SECONDS)
    throw new Error('plucked-breath plan changed length unexpectedly');

  const runtimePath = (await runtime.runtimeLocation(root)).path;
  const files = [
    { path: MODULE, sourcePath: join(HERE, MODULE) },
    { path: SOUND, sourcePath: join(HERE, SOUND) },
    { path: LICENSES, sourcePath: join(HERE, LICENSES) },
    { path: NOTICE, sourcePath: join(runtimePath, NOTICE) },
    { path: README, sourcePath: join(HERE, README) },
  ];

  const assets = [
    { id: 'ink_score_module', path: MODULE, type: 'code', simulated: false, rights: RIGHTS },
    { id: 'ink_score_sound', path: SOUND, type: 'code', simulated: false, rights: ENTRY_RIGHTS },
  ];

  const look = {
    id: 'ink-monochrome',
    description:
      'Sound-only: the look records the ink-wash register the passage is written for (dark wood, breath, ' +
      'a hard cut, empty white, a restrained cadence); it is not a rendered picture.',
  };

  const sources = [
    {
      id: 'ink_score',
      kind: 'browser',
      output: 'sound',
      entry: SOUND,
      resources: [MODULE],
      bindings: [],
      params: { variant: params.variant, transpose: params.transpose, gain: params.gain },
      seed: options.seed,
      durationSamples: SOURCE_SAMPLES,
      sampleRate: SOURCE_RATE,
    },
  ];

  // The Source renders natively at 48 kHz; this target delivers 44.1 kHz, so the
  // mixer must resample without changing the authored seconds.
  const soundTargets = [
    {
      id: 'master',
      sampleRate: TARGET_RATE,
      channels: 2,
      outputSamples: TARGET_SAMPLES,
      audio: [
        {
          id: 'cue',
          kind: 'source',
          source: 'ink_score',
          startSample: 0,
          gain: 1,
          fadeInSamples: 0,
          fadeOutSamples: 0,
        },
      ],
    },
  ];

  return {
    files,
    project: {
      schemaVersion: 1,
      id: slugToId(basename(root)),
      revision: 1,
      title: 'INK SCORE — a quiet crossing',
      direction: {
        intent:
          'A new, non-combat ink-wash passage in sound only: sparse open strings and a synthetic breath ' +
          'open the scroll; harmonic answers give way to a low 90 BPM ostinato and steps; a deep drum ' +
          'crescendo ends in a hard cut that removes both the dry audio and its reverb; a true silent gap ' +
          'is followed by a few isolated harmonics and a restrained F cadence. The guqin-like voice uses a ' +
          'variable fractional delay for slides and vibrato, a dark body bank and touched-node harmonics. ' +
          'The xiao is a synthetic breath/flute, and the drums are procedural: nothing is presented as a ' +
          'recording. The alternate variant changes the harmonic register and phrase, the crescendo and ' +
          'cut cue, the isolated harmonics and the cadence — not only a seed.',
        looks: [look],
        transitions: [],
      },
      assets,
      bindings: {},
      handoff: [
        { path: README, role: 'readme' },
        { path: LICENSES, role: 'license' },
        { path: NOTICE, role: 'license' },
      ],
      sources,
      soundTargets,
    },
  };
}
