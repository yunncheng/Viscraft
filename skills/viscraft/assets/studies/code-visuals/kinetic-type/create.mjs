/*
 * Viscraft recipe: instantiate the kinetic-type reading segment into a NEW Project.
 *
 *   viscraft author create.mjs <new-project-directory> [--options <options.json>]
 *
 * This is a declaration, not a second Runtime: it validates the creative
 * parameters, names the authored files (scene, module, complete font, licences)
 * and lets `authorProject` read/hash/copy/publish them. No Build, provider or
 * network work happens here.
 *
 * The default title/subtitle are real Chinese + Latin + digits, so a successful
 * render exercises real CJK/Latin layout; the bundled font's complete cmap and
 * the default text's code-point coverage are verified separately. Replace the
 * title and update or clear `emphasis` at the same time; if non-empty it must
 * occur in the chosen title.
 */
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KINETIC_CODE_RIGHTS,
  KINETIC_FONT_FILE,
  KINETIC_FONT_LICENSE,
  KINETIC_FONT_RIGHTS,
} from './rights.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = 'kinetic-type-scene.html';
const MODULE = 'kinetic-type.mjs';
const LICENSES = 'LICENSES.md';
const NOTICE = 'THIRD_PARTY_NOTICES.md';
const VARIANTS = ['poster', 'ledger'];
const OPTIONS = new Set([
  'width',
  'height',
  'frames',
  'title',
  'subtitle',
  'number',
  'emphasis',
  'variant',
  'titleMinSize',
  'titleMaxLines',
  'seed',
]);

function fail(message) {
  throw new Error(`kinetic-type/create: ${message}`);
}

function textOption(name, value, { max = 180, allowEmpty = false } = {}) {
  if (typeof value !== 'string') fail(`"${name}" must be a string`);
  const text = value.trim();
  if (!allowEmpty && text.length === 0) fail(`"${name}" must not be empty`);
  if (text.length > max) fail(`"${name}" is longer than ${max} characters`);
  if (/[\u0000-\u001f\u007f]/.test(text)) fail(`"${name}" must not contain control characters or newlines`);
  return text;
}

function integerOption(name, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max)
    fail(`"${name}" must be an integer from ${min} to ${max}`);
  return value;
}

function slugToId(name) {
  const cleaned = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (`kt-${/^[a-z0-9]/.test(cleaned) ? cleaned : `p-${cleaned || 'study'}`}`).slice(0, 96);
}

export default async function createKineticType({ root, options, runtime }) {
  const opts = options ?? {};
  if (typeof opts !== 'object' || Array.isArray(opts)) fail('options must be a JSON object');
  for (const key of Object.keys(opts)) if (!OPTIONS.has(key)) fail(`unknown option "${key}"`);

  const width = integerOption('width', opts.width ?? 1920, 480, 3840);
  const height = integerOption('height', opts.height ?? 1080, 270, 2160);
  if (width % 2 !== 0 || height % 2 !== 0) fail('"width" and "height" must be even');
  const frames = integerOption('frames', opts.frames ?? 192, 96, 1200);
  const title = textOption('title', opts.title ?? '\u6570\u636e\u4e4b\u540e\uff0c\u57ce\u5e02\u9192\u6765');
  const subtitle = textOption(
    'subtitle',
    opts.subtitle ?? '\u9605\u8bfb\u8282\u594f / A study in reading rhythm',
  );
  const number = textOption('number', opts.number ?? '24', { max: 4 });
  const emphasis = textOption('emphasis', opts.emphasis ?? '\u57ce\u5e02', { max: 60, allowEmpty: true });
  const variant = opts.variant ?? 'poster';
  if (!VARIANTS.includes(variant)) fail(`"variant" must be one of ${VARIANTS.join(', ')}`);
  const titleMinSize = integerOption('titleMinSize', opts.titleMinSize ?? 44, 32, 96);
  const titleMaxLines = integerOption('titleMaxLines', opts.titleMaxLines ?? 4, 2, 6);
  const seed = integerOption('seed', opts.seed ?? 4177, 0, 2 ** 31 - 1);
  if (emphasis && !title.includes(emphasis))
    fail('"emphasis" must occur in "title" (or clear it when you replace the title)');

  const fps = 24;
  const params = {
    title,
    subtitle,
    number,
    emphasis,
    variant,
    frames,
    titleMinSize,
    titleMaxLines,
  };

  const source = {
    id: 'kinetic_reading',
    kind: 'browser',
    output: 'picture',
    entry: ENTRY,
    resources: [MODULE, KINETIC_FONT_FILE],
    bindings: [],
    params,
    seed,
    frames,
  };

  const look = {
    id: 'kinetic-type',
    description:
      'A Swiss-grid reading poster: masked line reveals, a still reading hold, a weighted word and counting number, then a mask wipe into a compact index.',
  };
  const sceneId = 'scene_reading';

  const files = [
    { path: ENTRY, sourcePath: join(HERE, ENTRY) },
    { path: MODULE, sourcePath: join(HERE, MODULE) },
    { path: KINETIC_FONT_FILE, sourcePath: join(HERE, KINETIC_FONT_FILE) },
    { path: LICENSES, sourcePath: join(HERE, LICENSES) },
    { path: KINETIC_FONT_LICENSE, sourcePath: join(HERE, KINETIC_FONT_LICENSE) },
    { path: NOTICE, sourcePath: join((await runtime.runtimeLocation(root)).path, NOTICE) },
  ];

  const assets = [
    { id: 'kt_scene', path: ENTRY, type: 'code', simulated: false, rights: KINETIC_CODE_RIGHTS },
    { id: 'kt_module', path: MODULE, type: 'code', simulated: false, rights: KINETIC_CODE_RIGHTS },
    { id: 'kt_font', path: KINETIC_FONT_FILE, type: 'font', simulated: false, rights: KINETIC_FONT_RIGHTS },
  ];

  const project = {
    schemaVersion: 1,
    id: slugToId(basename(root)),
    revision: 1,
    title: 'KINETIC TYPE \u2014 reading rhythm',
    direction: {
      intent:
        'A short kinetic-type reading segment on a Swiss grid: build the grid, reveal mixed Chinese/Latin title lines through masks, hold still for reading, weight one word and count a number, then wipe into a compact index. A local typographic mechanism, not the upstream 44-second story or score.',
      looks: [look],
      transitions: [],
    },
    assets,
    bindings: {},
    handoff: [
      { path: LICENSES, role: 'license' },
      { path: KINETIC_FONT_LICENSE, role: 'license' },
      { path: NOTICE, role: 'license' },
    ],
    sources: [source],
    composition: {
      output: { width, height, fps: { numerator: fps, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: sceneId, description: 'One reading poster that resolves into an index.' }],
      shots: [
        {
          id: 'shot_reading',
          scene: sceneId,
          look: look.id,
          intent: `Read the title, dwell, emphasise "${emphasis || title}", and settle into the index.`,
          targetFrames: frames,
        },
      ],
      placements: [
        {
          id: 'pl_reading',
          shot: 'shot_reading',
          source: source.id,
          inFrame: 0,
          outFrame: frames,
          startFrame: 0,
          audio: 'mute',
        },
      ],
      transitions: [],
      audio: [],
    },
  };

  return { project, files };
}
