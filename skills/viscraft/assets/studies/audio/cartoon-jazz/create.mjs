#!/usr/bin/env node
/*
 * Viscraft author recipe: instantiate the cartoon-jazz reference into a NEW
 * Project.
 *
 *   viscraft author create.mjs <new-project-directory> [--options <json-file>]
 *
 * Options (a JSON object; the CLI resolves the file against the invocation cwd):
 *
 *   { "variant": "base" | "alternate", "transpose": 0, "gain": 1 }
 *
 * The recipe is creative code only. It declares the sound-only Source on its
 * native sample clock, its code files, one sound target that delivers the cue,
 * and the licence/README handoff, then returns the Project draft plus the exact
 * bytes to publish. The Runtime validates, copies, hashes and publishes; this
 * recipe performs no Build, no render, no provider request and no network
 * access. The sound has no picture Source, no composition and no fabricated
 * raster/FPS: authoring and portable export are both valid without a Build, and
 * the WAV is produced by `viscraft build <project> --target master`.
 *
 * Adapted from lemo-opuscar styles/rubber-hose/demo/music/score.py plus
 * core/audio/pluck.py and core/audio/sfx.py at commit
 * e3cb16f63768c68693ff0e15171d6e755457cc32 (LemoLab, MIT). The arrangement and
 * synthesis are re-authored for the current Viscraft contract; the full MIT text
 * and the modification note travel in LICENSES.md. The Runtime's verbatim
 * THIRD_PARTY_NOTICES.md is located from the running Runtime and carried as an
 * unregistered `license` handoff file, not as an Asset.
 */
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DURATION_SECONDS } from './score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = 'sound.html';
const SCORE = 'score.mjs';
const SYNTH = 'synth.mjs';
const LICENSES = 'LICENSES.md';
const NOTICE = 'THIRD_PARTY_NOTICES.md';
const README = 'README.md';

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
// The score module is the single authority for the authored length; the Source
// declares that length as a native sample span, never a picture frame count.
const DURATION_SAMPLES = Math.round(DURATION_SECONDS * SAMPLE_RATE);

const OPTION_KEYS = new Set(['variant', 'transpose', 'gain']);

const SCORE_RIGHTS = {
  origin:
    'adapted from lemo-opuscar styles/rubber-hose/demo/music/score.py ' +
    '@e3cb16f63768c68693ff0e15171d6e755457cc32 (LemoLab), MIT',
  license: 'Apache-2.0 AND MIT',
  redistributable: true,
  author: 'LemoLab',
  attributionRequired: true,
  notice: 'MIT (c) 2026 LemoLab, lemo-opuscar e3cb16f63768c68693ff0e15171d6e755457cc32; Viscraft-original implementation and arrangement (c) 2026 The Viscraft Authors. See LICENSES.md.',
  modifications:
    'Re-authored as a 32-second, 120 BPM event score for the current Viscraft sound contract: the syncopated theme, ' +
    'stride/oompah accompaniment, band stop and cadence are ported as musical data; section plan, variant cues, ' +
    'phrase choices, orchestration and gains are authored for this reference. No Python, no NumPy/SciPy, no ' +
    'recorded instrument, no sample pack, no TTS and no upstream scenes or film.',
};

const SYNTH_RIGHTS = {
  origin:
    'adapted from lemo-opuscar core/audio/pluck.py (Karplus-Strong waveguide, body resonance) and ' +
    'core/audio/sfx.py (equal-power pan, one-pole filtering, band-limited noise, limiting practice) ' +
    '@e3cb16f63768c68693ff0e15171d6e755457cc32 (LemoLab), MIT',
  license: 'Apache-2.0 AND MIT',
  redistributable: true,
  author: 'LemoLab',
  attributionRequired: true,
  notice: 'MIT (c) 2026 LemoLab, lemo-opuscar e3cb16f63768c68693ff0e15171d6e755457cc32; Viscraft-original implementation and arrangement (c) 2026 The Viscraft Authors. See LICENSES.md.',
  modifications:
    'Rewritten as dependency-free JavaScript oscillators and deterministic filters for the browser sound contract; ' +
    'every voice is synthesis, not a recording. No NumPy/SciPy/numba, no recorded samples, no drum library, no TTS.',
};

const ENTRY_RIGHTS = {
  origin:
    'original: the window.viscraftSound entry page and its parameter/length diagnostics authored for this reference',
  license: 'Apache-2.0',
  redistributable: true,
  author: 'The Viscraft Authors',
};

function slugToId(name) {
  const cleaned =
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'score';
  return ('cartoon-' + (/^[a-z0-9]/.test(cleaned) ? cleaned : 'p-' + cleaned)).slice(0, 96);
}

function normalizeOptions(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  for (const key of Object.keys(input)) {
    if (!OPTION_KEYS.has(key)) {
      throw new Error(
        `cartoon-jazz does not take the option "${key}"; use ${[...OPTION_KEYS].join(', ')}`,
      );
    }
  }
  const options = { variant: 'base', transpose: 0, gain: 1, ...input };
  if (!['base', 'alternate'].includes(options.variant)) {
    throw new Error('"variant" must be "base" or "alternate"');
  }
  if (!Number.isInteger(options.transpose) || Math.abs(options.transpose) > 24) {
    throw new Error('"transpose" must be an integer between -24 and 24 semitones');
  }
  if (!Number.isFinite(options.gain) || options.gain < 0 || options.gain > 2) {
    throw new Error('"gain" must be a finite number between 0 and 2');
  }
  return options;
}

export default async function create({ root, options: rawOptions, runtime }) {
  const options = normalizeOptions(rawOptions ?? {});
  const params = {
    variant: options.variant,
    transpose: options.transpose,
    gain: options.gain,
  };

  const assets = [
    { id: 'cs_score', path: SCORE, type: 'code', simulated: false, rights: SCORE_RIGHTS },
    { id: 'cs_synth', path: SYNTH, type: 'code', simulated: false, rights: SYNTH_RIGHTS },
    { id: 'cs_sound', path: ENTRY, type: 'code', simulated: false, rights: ENTRY_RIGHTS },
  ];

  const sources = [
    {
      id: 'cartoon_score',
      kind: 'browser',
      output: 'sound',
      entry: ENTRY,
      resources: [SCORE, SYNTH],
      bindings: [],
      params,
      seed: options.variant === 'base' ? 1201 : 1202,
      durationSamples: DURATION_SAMPLES,
      sampleRate: SAMPLE_RATE,
    },
  ];

  const soundTargets = [
    {
      id: 'master',
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      outputSamples: DURATION_SAMPLES,
      audio: [
        {
          id: 'cue',
          kind: 'source',
          source: 'cartoon_score',
          startSample: 0,
          gain: 1,
          fadeInSamples: 0,
          fadeOutSamples: 0,
        },
      ],
    },
  ];

  const files = [
    { path: ENTRY, sourcePath: join(HERE, ENTRY) },
    { path: SCORE, sourcePath: join(HERE, SCORE) },
    { path: SYNTH, sourcePath: join(HERE, SYNTH) },
    { path: LICENSES, sourcePath: join(HERE, LICENSES) },
    { path: NOTICE, sourcePath: join((await runtime.runtimeLocation(root)).path, NOTICE) },
    { path: README, sourcePath: join(HERE, README) },
  ];

  return {
    files,
    project: {
      schemaVersion: 1,
      id: slugToId(basename(root)),
      revision: 1,
      title: 'CARTOON SCORE — one theme, three paces',
      direction: {
        intent:
          'A 32-second cartoon cue with one syncopated theme kept recognisable at three paces: stated by the band, ' +
          'augmented through a comic inspection, then compressed into a chase. The band stops dead and only the ' +
          'physical cue (tick/spring, or woodblock/slide whistle) remains before a call-and-response restart, a ' +
          'slow resolution and a final F cadence. Every voice is synthesised, not recorded; the band stop gates ' +
          'the music and its room tail while the dry foley stays audible.',
        looks: [
          {
            id: 'cartoon-band',
            description:
              'A sound-only cartoon cue: stride piano, tuba/banjo oompah, brass and reed call-response, ' +
              'programmatic percussion and close comedy foley. No picture Source is required.',
          },
        ],
        transitions: [],
      },
      assets,
      bindings: {},
      handoff: [
        { path: LICENSES, role: 'license' },
        { path: NOTICE, role: 'license' },
        { path: README, role: 'readme' },
      ],
      sources,
      soundTargets,
    },
  };
}
