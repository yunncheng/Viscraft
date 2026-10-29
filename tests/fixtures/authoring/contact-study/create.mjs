#!/usr/bin/env node
/*
 * Viscraft author recipe: instantiate the contact-study TECHNICAL FIXTURE into
 * a NEW Project. It proves the picture/sound/timeline closure end to end; it is
 * not an art reference and not a finished film.
 *
 *   viscraft author create.mjs <new-project-directory> [--options <json-file>]
 *
 * Options (JSON object; the CLI resolves the file against the invocation cwd):
 *
 *   { "width": 640, "height": 360, "frames": 24, "seed": 4242 }
 *
 * This recipe authors ONE operation with a cause and a result:
 *
 *  - a counterweighted striker swings down onto a C6 marimba bar; the head meets
 *    the bar on the authored contact frame, the bar dips and rings, and the arm
 *    rebounds while the camera pushes in on the struck bar;
 *  - the sound is the same event on the same sample: the recorded marimba C6
 *    (the pitch printed on the bar) plus a low cello pizzicato for body, after
 *    an authored rest, with the recording's own decay as the tail.
 *
 * The study's own files are `contact-scene.{html,mjs}`, `contact-sound.{html,mjs}`
 * and `contact-timeline.mjs` (kept beside this recipe); `contact-timeline.mjs`
 * is the single authority for the contact frame and is declared by BOTH
 * Sources, so editing it re-renders both. The recipe imports the composed
 * `paint-material` and `motion-camera` study modules and the `sound-arrange`
 * test module by relative path, copies them into the Project, and copies only
 * the recordings this study actually strikes (the marimba C6 and the two cello
 * pizzicato takes), with their rights and licence texts, plus the Runtime's
 * verbatim `THIRD_PARTY_NOTICES.md` for the Manim-derived easing notices the
 * composed motion-camera module requires.
 *
 * The Runtime validates, copies, hashes and publishes the Project; this recipe
 * writes nothing, Builds nothing, and performs no provider work or network
 * access.
 */
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PAINT_MATERIAL_DIR,
  PAINT_MATERIAL_MODULE,
  PAINT_MATERIAL_RIGHTS,
} from '../../../../skills/viscraft/assets/studies/code-visuals/paint-material/rights.mjs';
import {
  MOTION_CAMERA_DIR,
  MOTION_CAMERA_MODULE,
  MOTION_CAMERA_RIGHTS,
} from '../motion-camera/rights.mjs';
import {
  SOUND_ARRANGE_RIGHTS,
  SOUND_KIT_LICENSE as KIT_LICENSE,
  sampleRights,
} from '../../audio/sound-arrange/provenance.mjs';
import { SAMPLE_PACK } from '../../audio/sound-arrange/sound-arrange.mjs';
import { CONTACT_PACKS } from './contact-packs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const SCENE_HTML = 'contact-scene.html';
const SCENE_MJS = 'contact-scene.mjs';
const TIMELINE_MJS = 'contact-timeline.mjs';
const SOUND_HTML = 'contact-sound.html';
const SOUND_MJS = 'contact-sound.mjs';
const PACKS_MJS = 'contact-packs.mjs';
const PAINT_MJS = PAINT_MATERIAL_MODULE;
const CAMERA_MJS = MOTION_CAMERA_MODULE;
const ARRANGE_MJS = 'sound-arrange.mjs';
const LICENSES = 'LICENSES.md';
const SOUND_KIT_LICENSE = KIT_LICENSE.path;
const NOTICE = 'THIRD_PARTY_NOTICES.md';
const README = 'README.md';

// The single study copy of each composed implementation, and the one kit copy.
const PAINT_SOURCE = join(PAINT_MATERIAL_DIR, PAINT_MJS);
const CAMERA_SOURCE = join(MOTION_CAMERA_DIR, CAMERA_MJS);
const ARRANGE_DIR = join(HERE, '..', '..', 'audio', 'sound-arrange');
const ARRANGE_SOURCE = join(ARRANGE_DIR, ARRANGE_MJS);
const SAMPLE_DIR = join(ARRANGE_DIR, 'samples');

/**
 * The packs this study sounds, from the shared `contact-packs.mjs`, so the
 * copied closure and the sound scene's validation cannot drift.
 * `SAMPLE_PACK` remains the authority for bytes, digests and upstream paths.
 */
const SAMPLE_ENTRIES = CONTACT_PACKS.flatMap(pack => SAMPLE_PACK[pack].files);

const OPTION_KEYS = new Set(['width', 'height', 'frames', 'seed']);

// The study's own files. It composes MIT modules, so the combined scene is
// recorded as MIT — never a CC0 claim that would misstate the file's licence.
const OWNED_RIGHTS = {
  origin:
    'original: the contact-study example, authored for Viscraft; composes the MIT paint-material, ' +
    'motion-camera and sound-arrange author modules and CC0 recordings',
  license: 'MIT',
  redistributable: true,
};

const PALETTE = {
  paper: '#e9dfca',
  paperDeep: '#d6c8ad',
  desk: '#cdbb9c',
  ink: '#2a2420',
  wood: '#b5763a',
  woodLight: '#cf9557',
  woodDark: '#7d4a20',
  metal: '#3d4a52',
  metalLight: '#66767f',
  metalDark: '#20272c',
  yarn: '#e6d0a3',
  yarnDark: '#b08c55',
  strike: '#fff3d8',
};

function slugToId(name) {
  const cleaned =
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'study';
  return ('contact-' + (/^[a-z0-9]/.test(cleaned) ? cleaned : 'p-' + cleaned)).slice(0, 96);
}

function sampleIds(files) {
  return new Map(
    files.map(file => [
      file,
      'cs_' +
        file
          .replace(/\.wav$/, '')
          .replace(/[^a-zA-Z0-9]+/g, '_')
          .toLowerCase(),
    ]),
  );
}

/** The shared event clock stays local to this study: it is its own timing. */
async function loadTimeline() {
  return import(pathToFileURL(join(HERE, TIMELINE_MJS)).href);
}

function normalizeOptions(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('contact-study options must be a JSON object');
  for (const key of Object.keys(raw))
    if (!OPTION_KEYS.has(key))
      throw new Error(`contact-study does not take the option "${key}"; use ${[...OPTION_KEYS].join(', ')}`);
  const options = { width: 640, height: 360, frames: 24, seed: 4242, ...raw };
  for (const key of ['width', 'height', 'frames', 'seed'])
    if (!Number.isInteger(options[key])) throw new Error(`${key} must be an integer`);
  if (options.width < 2 || options.height < 2) throw new Error('width and height must be >= 2');
  if (options.width % 2 !== 0 || options.height % 2 !== 0) throw new Error('width and height must be even');
  if (options.seed < 0) throw new Error('seed must be a non-negative integer');
  return options;
}

function readmeText({ totalFrames, fps, timeline, contactSample, sampleRate }) {
  return `# CONTACT STUDY 01 — one strike, one sound

A ${totalFrames}-frame (${(totalFrames / fps).toFixed(3)} s @ ${fps} fps) canvas study of ONE
operation, authored by the Viscraft \`contact-study\` example.

- **Prior state** — the striker is held above a marimba; the camera is still.
- **Trigger** — the arm accelerates down over ${timeline.contactFrame - timeline.approachStart} frames.
- **Contact** — the mallet head meets the C6 bar on **frame ${timeline.contactFrame}**
  (sample ${contactSample} at ${sampleRate} Hz). The bar dips, a ring of vibration and
  wood dust appear, and the printed registration notch is consumed.
- **Result** — the arm rebounds past its resting angle while the bar keeps
  ringing; the camera pushes onto the struck bar and holds.

The sound is the same event: the recorded **marimba C6** (the pitch printed on
the bar, so it is not a transposition) plus a low cello pizzicato at the same
sample, after ${timeline.contactFrame} frames of authored silence. The tail is the
recording's own decay, closed by the module's end fade. There is no tone bed.

## What to edit

| Change | File | What to do |
| --- | --- | --- |
| The contact frame | \`contact-timeline.mjs\` | Edit \`STUDY.contactFrame\`. Both Sources declare this file, so both re-render from the new number. The contact must fit: \`approachFrames + 1 <= contactFrame\` and \`contactFrame + liftFrames <= frames - 1\`, or the module throws. |
| The subject / framing | \`contact-scene.mjs\` | The striker geometry, the palette and the camera push are in this file; \`params.palette\` and \`params.camera\` override the defaults per Source. |
| The sound | \`contact-sound.mjs\` | The two voices, their velocity, pan, pitch and hold are in \`buildContactScore\`. Do not add a second copy of the contact time — read it from the timeline. |
| The piece length | \`project.json\` \`sources[].frames\` + \`params.frames\` | Both Sources must agree. The sound scene throws when \`params.frames\` and the sample span disagree. |

After editing a registered code file, re-record its bytes with
\`viscraft refresh-code <this-directory> <asset-id>\` so the declared hash and
revision stay true to the bytes; the Build itself always freezes the bytes it
actually runs.

## Build

\`viscraft build <this-directory>\`

The Build captures the picture Source, renders the sound Source once, mixes it as
a normal \`source\` clip on the \`fx\` bus, masters to the declared target (-16 LUFS /
-1.5 dBTP) and muxes the programme. Rebuilding after a sound-free edit reuses
the unchanged sound Take and the mix/master chain.

## Rights

- Recordings: CC0 1.0 (see \`${KIT_LICENSE.path}\` for repository, commit and digest).
- Adapted module code: MIT (LemoLab, alchaincyf); full texts in \`LICENSES.md\`;
  the Manim-derived easing notices are in \`THIRD_PARTY_NOTICES.md\`.
- The example's own scene, sound and timeline: MIT (they compose MIT modules).

## Honest limits

- This is a mechanical study, not character performance and not a rig: the
  striker is one rigid arm on a pivot, and there is no acting to evaluate.
- The material is stylised (flat cel fills, painted grain, a paper overlay). It
  is not photorealism and the bar's ring is a damped cosine, not a simulation.
- The sound is two sampled attacks; whether the strike *reads* as the bar being
  struck needs a human listening/observation pass. This Project proves the
  timing and material chain, not aesthetic approval.
`;
}

export default async function create({ root, options: rawOptions, runtime }) {
  const options = normalizeOptions(rawOptions ?? {});
  const { width, height, frames: totalFrames, seed } = options;

  const { timelineFor, sampleAt, STUDY } = await loadTimeline();
  const fps = STUDY.fps;
  const sampleRate = 48000;
  const channels = 2;

  // Preflight the shared event clock before the Runtime publishes anything: a
  // contact that does not fit the piece is an authoring error, not a Build
  // surprise.
  const timeline = timelineFor(totalFrames);
  const contactSample = sampleAt(timeline.contactFrame, sampleRate);

  const sampleFiles = SAMPLE_ENTRIES.map(entry => entry.file);
  const ids = sampleIds(sampleFiles);

  const localFiles = [
    { path: SCENE_HTML, sourcePath: join(HERE, SCENE_HTML), assetId: 'cs_scene_html' },
    { path: SCENE_MJS, sourcePath: join(HERE, SCENE_MJS), assetId: 'cs_scene' },
    { path: TIMELINE_MJS, sourcePath: join(HERE, TIMELINE_MJS), assetId: 'cs_timeline' },
    { path: SOUND_HTML, sourcePath: join(HERE, SOUND_HTML), assetId: 'cs_sound_html' },
    { path: SOUND_MJS, sourcePath: join(HERE, SOUND_MJS), assetId: 'cs_sound' },
    { path: PACKS_MJS, sourcePath: join(HERE, PACKS_MJS), assetId: 'cs_packs' },
  ];

  const moduleFiles = [
    { path: PAINT_MJS, sourcePath: PAINT_SOURCE, assetId: 'cs_paint', rights: PAINT_MATERIAL_RIGHTS },
    { path: CAMERA_MJS, sourcePath: CAMERA_SOURCE, assetId: 'cs_camera', rights: MOTION_CAMERA_RIGHTS },
    { path: ARRANGE_MJS, sourcePath: ARRANGE_SOURCE, assetId: 'cs_arrange', rights: SOUND_ARRANGE_RIGHTS },
  ];

  const files = [
    ...localFiles.map(({ path, sourcePath }) => ({ path, sourcePath })),
    ...moduleFiles.map(({ path, sourcePath }) => ({ path, sourcePath })),
    ...SAMPLE_ENTRIES.map(entry => ({
      path: entry.file,
      sourcePath: join(SAMPLE_DIR, entry.file),
      expectedSha256: entry.sha256,
    })),
    { path: LICENSES, sourcePath: join(ARRANGE_DIR, LICENSES) },
    { path: SOUND_KIT_LICENSE, sourcePath: join(ARRANGE_DIR, ...KIT_LICENSE.source.split('/')) },
    { path: NOTICE, sourcePath: join((await runtime.runtimeLocation(root)).path, NOTICE) },
    { path: README, bytes: readmeText({ totalFrames, fps, timeline, contactSample, sampleRate }) },
  ];

  const look = {
    id: 'contact',
    description:
      'A cel-shaded mechanism study: one striker, one bar, one contact. Flat bases, hard terminators, ink contours, ' +
      'painted wood grain on paper; the camera pushes in on the struck bar after the contact.',
  };

  const pictureParams = {
    frames: totalFrames,
    palette: PALETTE,
    camera: { push: 1.2, focusX: 240, focusY: 172 },
  };
  const soundParams = { frames: totalFrames, mix: 1 };
  const soundSamples = Math.ceil((totalFrames * sampleRate) / fps);

  const sources = [
    {
      id: 'contact_picture',
      kind: 'browser',
      output: 'picture',
      entry: SCENE_HTML,
      resources: [SCENE_MJS, TIMELINE_MJS, PAINT_MJS, CAMERA_MJS],
      bindings: [],
      params: pictureParams,
      seed,
      frames: totalFrames,
    },
    {
      id: 'contact_sound',
      kind: 'browser',
      output: 'sound',
      entry: SOUND_HTML,
      resources: [SOUND_MJS, PACKS_MJS, TIMELINE_MJS, ARRANGE_MJS, ...sampleFiles],
      bindings: [],
      params: soundParams,
      seed,
      durationSamples: soundSamples,
      sampleRate,
    },
  ];

  const audio = [
    {
      id: 'contact',
      kind: 'source',
      source: 'contact_sound',
      startSample: 0,
      gain: 1,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      bus: 'fx',
    },
  ];

  return {
    files,
    project: {
      schemaVersion: 1,
      revision: 1,
      id: slugToId(basename(root)),
      title: 'CONTACT STUDY 01 — one strike, one sound',
      direction: {
        intent:
          'A short canvas study of one readable operation: a counterweighted striker swings down onto a C6 marimba bar, ' +
          'meets it on the authored contact frame, and rebounds while the bar rings. The sound is the same event on the ' +
          'same sample - the recorded marimba C6 plus a low cello pizzicato, after an authored rest, with the recording ' +
          'decay as the tail. The contact frame lives in one shared timeline module declared by both Sources. The look is ' +
          'a stylised cel/paper study, not photorealism and not a character rig.',
        looks: [look],
        transitions: [],
      },
      assets: [
        ...localFiles.map(({ path, assetId }) => ({
          id: assetId,
          path,
          type: 'code',
          simulated: false,
          rights: OWNED_RIGHTS,
        })),
        ...moduleFiles.map(({ path, assetId, rights }) => ({
          id: assetId,
          path,
          type: 'code',
          simulated: false,
          rights,
        })),
        ...SAMPLE_ENTRIES.map(entry => ({
          id: ids.get(entry.file),
          path: entry.file,
          type: 'audio',
          simulated: false,
          rights: sampleRights(entry),
        })),
      ],
      bindings: {},
      handoff: [
        { path: LICENSES, role: 'license' },
        { path: SOUND_KIT_LICENSE, role: 'license' },
        { path: NOTICE, role: 'license' },
        { path: README, role: 'readme' },
      ],
      sources,
      composition: {
        output: { width, height, fps: { numerator: fps, denominator: 1 }, sampleRate, channels },
        scenes: [
          {
            id: 'scene_contact',
            description: 'One striker, one bar, one contact; picture and sound read the same authored event clock.',
          },
        ],
        shots: [
          {
            id: 'shot_contact',
            scene: 'scene_contact',
            look: look.id,
            intent: `One strike on frame ${timeline.contactFrame} and its ring, with a push-in on the struck bar.`,
            targetFrames: totalFrames,
          },
        ],
        placements: [
          {
            id: 'pl_contact',
            shot: 'shot_contact',
            source: 'contact_picture',
            inFrame: 0,
            outFrame: totalFrames,
            startFrame: 0,
            audio: 'mute',
          },
        ],
        transitions: [],
        audio,
        mastering: { targetLufs: -16, truePeakDbfs: -1.5 },
      },
    },
  };
}
