/*
 * Viscraft recipe: author the storybook-score cue into a NEW Project.
 *
 *   viscraft author create.mjs <new-project-directory> [--options <json-file>]
 *
 * Options (all optional):
 *   variant  "base" | "alternate"   orchestration and answer phrase (default "base")
 *   transpose integer semitones -12..12 (default 0)
 *   gain      0..1 (default 1)
 *
 * There is deliberately no `seconds` or `frames` option: this is a complete
 * 40 s, 16-bar, 3/4 form, and a shorter render would cut the coda phrase. Edit
 * the module's constants together if you really want another length.
 *
 * The Runtime owns loading, hashing, copying, licence carriage and the Project
 * write. This file is the editable declaration: it imports the local score and
 * synthesis modules by relative path, preflights the descriptor, and declares a
 * PURE SOUND Project — one `browser` `output: "sound"` Source on its native
 * sample clock plus one sound target that delivers that cue. There is no
 * composition, picture raster, FPS or fabricated look output. It performs no
 * render, no Build, no provider request and no network access. Produce the WAV
 * with the separate `viscraft build <project> --target master` command.
 *
 * Adapted material (LemoLab, MIT, lemo-opuscar@e3cb16f6) is recorded in the
 * local LICENSE file and in the Runtime's verbatim THIRD_PARTY_NOTICES.md.
 */
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SEED, normalizeParams, SECONDS, buildScore } from './score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = 'sound.html';
const SCORE = 'score.mjs';
const SYNTH = 'synth.mjs';
const README = 'README.md';
const LICENSE = 'LICENSES.md';
const NOTICE = 'THIRD_PARTY_NOTICES.md';

// The cue is authored at 48 kHz; the sound target delivers at the same native
// rate, so no resampling is involved here.
const SAMPLE_RATE = 48000;

const ENTRY_RIGHTS = {
  origin: 'original: the window.viscraftSound entry page authored for Viscraft',
  license: 'Apache-2.0',
  redistributable: true,
  author: 'The Viscraft Authors',
};

const STORYBOOK_RIGHTS = {
  origin:
    'adapted from lemo-opuscar@e3cb16f63768c68693ff0e15171d6e755457cc32 (LemoLab), MIT: ' +
    'the four-bar THEME phrase, toy-piano/reed change, breath/wind-down gesture, silent rest and ' +
    'winding-down coda follow styles/crayon-book/demo/music/score.py; the music-box modal partials, ' +
    'mechanical click and body, the harp Karplus-Strong string and the toy-piano inharmonic bar follow ' +
    'core/audio/pluck.py and score.py toy(). The 40 s 3/4 form, flute and reed synthesis, alternate ' +
    'orchestration, answer phrases, counter-lines and variant cues are original for Viscraft.',
  license: 'Apache-2.0 AND MIT',
  redistributable: true,
  author: 'LemoLab (lemo-opuscar); Viscraft original arrangement, flute/reed voices and variants',
  attributionRequired: true,
  modifications:
    'Removed the whole-film picture sync, events.json glints, sampled flute/clarinet/glockenspiel and ' +
    'the external sample library (none is available here); every voice is synthesized in synth.mjs. ' +
    'The cue is re-timed to exactly 40 s (16 bars at 72 BPM, 3/4) with a different opening/toys/rest/' +
    'theme/cadence/coda balance, a measured silent rest, separate section and stem dynamics, and two ' +
    'content variants that change orchestration and answer phrases rather than a seed or gain.',
  notice:
    'MIT (c) 2026 LemoLab (lemo-opuscar, commit e3cb16f63768c68693ff0e15171d6e755457cc32). ' +
    'See THIRD_PARTY_NOTICES.md and LICENSES.md. All five voices are synthesis; ' +
    'no recording or sample library is shipped or referenced.',
};

function slugToId(name) {
  const cleaned =
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'score';
  return ('storybook-' + (/^[a-z0-9]/.test(cleaned) ? cleaned : 'p-' + cleaned)).slice(0, 96);
}

export default async function create({ root, options, runtime }) {
  const params = normalizeParams(options ?? {});
  // Preflight the complete descriptor before the Runtime publishes anything.
  const score = buildScore(params);
  if (score.seconds !== SECONDS)
    throw new Error('storybook-score: the module and the recipe disagree about the default clock');
  // The Source runs on its own sample clock: 40 s at 48 kHz. No picture frame
  // count takes part in the length.
  const durationSamples = Math.round(SECONDS * SAMPLE_RATE);

  const files = [
    { path: SCORE, sourcePath: join(HERE, SCORE) },
    { path: SYNTH, sourcePath: join(HERE, SYNTH) },
    { path: ENTRY, sourcePath: join(HERE, ENTRY) },
    { path: LICENSE, sourcePath: join(HERE, LICENSE) },
    { path: NOTICE, sourcePath: join((await runtime.runtimeLocation(root)).path, NOTICE) },
    { path: README, sourcePath: join(HERE, README) },
  ];

  const assets = [
    { id: 'storybook_score', path: SCORE, type: 'code', simulated: false, rights: STORYBOOK_RIGHTS },
    { id: 'storybook_synth', path: SYNTH, type: 'code', simulated: false, rights: STORYBOOK_RIGHTS },
    { id: 'storybook_sound', path: ENTRY, type: 'code', simulated: false, rights: ENTRY_RIGHTS },
  ];

  const look = {
    id: 'storybook_score',
    description:
      'A sound-only authoring look: no picture is declared. The cue is a complete 3/4 picture-book score with separate section and stem dynamics, meant to be edited or paired with any picture later.',
  };

  const source = {
    id: 'storybook_score',
    kind: 'browser',
    output: 'sound',
    entry: ENTRY,
    resources: [SCORE, SYNTH],
    bindings: [],
    params,
    seed: DEFAULT_SEED,
    durationSamples,
    sampleRate: SAMPLE_RATE,
  };

  // The complete cue is the whole programme: one source clip on its own sample
  // clock. A sound target states rate/channels/span; no composition is faked.
  const soundTargets = [
    {
      id: 'master',
      sampleRate: SAMPLE_RATE,
      channels: 2,
      outputSamples: durationSamples,
      audio: [
        {
          id: 'cue',
          kind: 'source',
          source: 'storybook_score',
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
      title: 'STORYBOOK SCORE — a complete 3/4 picture-book cue',
      direction: {
        intent:
          'A complete, editable picture-book score, not a DSP demonstration: a music-box motif opens in 3/4, the toy piano and reed take over for a playful change, one silent bar holds the story still, the full four-bar theme returns on flute with music-box doubling, a reed counter-line and harp bass, a cadence closes it, and a coda slows its playback rate from 1 to 0.93 so both the onsets and the pitch settle. Every voice is synthesized; no recording is shipped or imitated by relabelling one. The alternate variant changes the orchestration and answer phrases, not only a seed or gain.',
        looks: [look],
        transitions: [],
      },
      assets,
      bindings: {},
      handoff: [
        { path: README, role: 'readme' },
        { path: LICENSE, role: 'license' },
        { path: NOTICE, role: 'license' },
      ],
      sources: [source],
      soundTargets,
    },
  };
}
