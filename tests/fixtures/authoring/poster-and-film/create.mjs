#!/usr/bin/env node
/*
 * Viscraft author recipe: instantiate the "Poster and film" teaching work into
 * a NEW Project.
 *
 *   viscraft author create.mjs <new-project-directory> [--options <json-file>]
 *
 * Options (JSON object; the CLI resolves the file against the invocation cwd):
 *
 *   { "frames": 48 }
 *
 * ONE Project holds
 *   - two editable fixed-canvas design documents (a 4:5 poster and a 1:1 social
 *     card) that share one photograph and one type pairing, with THREE still
 *     targets (print, print at 2x, social) that produce independently
 *     addressable results; and
 *   - a short code film (2 s, 640x360, 24 fps) that reuses the SAME photograph
 *     and the SAME faces, so the still and the moving piece are one design.
 *
 * The recipe generates the photograph as a real PNG (deterministic, no network,
 * no image model) and returns its bytes; the Runtime writes and hashes it. The
 * HTML/CSS design documents stay ordinary `imageDocuments`: the workbench edits
 * those files in place and each render freezes their current bytes. The four
 * real subset fonts and the two verbatim OFL texts ship beside this recipe in
 * `fonts/` and are declared here as local files with their rights.
 * No absolute host path is written, and authoring does no provider work.
 */
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = join(HERE, 'fonts');
const IMAGE = 'assets/light.png';
const IMAGE_WIDTH = 1200;
const IMAGE_HEIGHT = 800;

const ORIGINAL = {
  origin: 'original: authored for the Viscraft poster-and-film example; no third-party source or asset',
  license: 'MIT',
  redistributable: true,
};

/** Deterministic 32-bit PRNG — the photograph must be identical on every run. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** CRC32 for PNG chunks. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * A small 8-bit RGB PNG encoder: IHDR + one IDAT (filter 0 per row) + IEND.
 * Enough to produce a real, decodable photograph without a native dependency.
 */
function encodePng(width, height, rgb) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A shaft of afternoon light across a plaster wall: a warm ground, one soft
 * diagonal band, a slower falloff and fine grain. Authored values, not a
 * photograph of a real place — the rights record says so.
 */
function lightStudy(width, height) {
  const random = mulberry32(0x5eed01);
  const rgb = Buffer.alloc(width * height * 3);
  // The band's axis: a diagonal from the upper left, 24 degrees off vertical.
  const angle = (24 * Math.PI) / 180;
  const nx = Math.cos(angle);
  const ny = Math.sin(angle);
  const centre = width * 0.46;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - centre;
      const dy = y - height * 0.5;
      const across = dx * nx + dy * ny;
      // Soft-edged band plus a broader spill.
      const band = Math.exp(-Math.pow(across / (width * 0.16), 2));
      const spill = Math.exp(-Math.pow(across / (width * 0.52), 2));
      const vertical = 0.9 - 0.25 * (y / height);
      const grain = (random() - 0.5) * 9;
      const lum = 0.52 + 0.3 * band + 0.12 * spill;
      const warm = vertical;
      const r = 176 * lum * warm + 40 * band + grain + 30;
      const g = 166 * lum * warm + 30 * band + grain + 22;
      const b = 150 * lum * warm + 14 * band + grain + 16;
      const offset = (y * width + x) * 3;
      rgb[offset] = Math.max(0, Math.min(255, Math.round(r)));
      rgb[offset + 1] = Math.max(0, Math.min(255, Math.round(g)));
      rgb[offset + 2] = Math.max(0, Math.min(255, Math.round(b)));
    }
  }
  return encodePng(width, height, rgb);
}

const FPS = 24;
const WIDTH = 640;
const HEIGHT = 360;

const FONT_FILES = [
  'NotoSansSC-400-subset.woff2',
  'NotoSansSC-700-subset.woff2',
  'SpaceGrotesk-400-subset.woff2',
  'SpaceGrotesk-700-subset.woff2',
];
// The real files beside this recipe, their licence grouping and their rights.
// The two OFL texts are the verbatim licence of the fonts; they travel as
// UNREGISTERED `license` handoff files (they are not font bytes).
const NOTO_MODIFICATIONS =
  'Subset to GB2312 level-1 (3751 hanzi) plus ASCII, Latin-1, general punctuation, CJK punctuation and full-width forms; no other change.';
const NOTO_NOTICE =
  'SIL Open Font License 1.1; the verbatim text ships as OFL-NotoSansSC.txt. The subset is not the full CJK block.';
const SPACE_MODIFICATIONS = 'Fontsource latin range kept as published; no glyph changes.';
const SPACE_NOTICE = 'SIL Open Font License 1.1; the verbatim text ships as OFL-SpaceGrotesk.txt.';

const FONTS = {
  'NotoSansSC-400-subset.woff2': {
    license: 'OFL-NotoSansSC.txt',
    rights: {
      origin:
        'Noto Sans SC 400, subset from @fontsource/noto-sans-sc@5.2.8 (noto-sans-sc-chinese-simplified-400-normal.woff2)',
      license: 'OFL-1.1',
      redistributable: true,
      attributionRequired: true,
      modifications: NOTO_MODIFICATIONS,
      notice: NOTO_NOTICE,
    },
  },
  'NotoSansSC-700-subset.woff2': {
    license: 'OFL-NotoSansSC.txt',
    rights: {
      origin:
        'Noto Sans SC 700, subset from @fontsource/noto-sans-sc@5.2.8 (noto-sans-sc-chinese-simplified-700-normal.woff2)',
      license: 'OFL-1.1',
      redistributable: true,
      attributionRequired: true,
      modifications: NOTO_MODIFICATIONS,
      notice: NOTO_NOTICE,
    },
  },
  'SpaceGrotesk-400-subset.woff2': {
    license: 'OFL-SpaceGrotesk.txt',
    rights: {
      origin: 'Space Grotesk 400, from @fontsource/space-grotesk@5.2.8 (space-grotesk-latin-400-normal.woff2)',
      license: 'OFL-1.1',
      redistributable: true,
      attributionRequired: true,
      modifications: SPACE_MODIFICATIONS,
      notice: SPACE_NOTICE,
    },
  },
  'SpaceGrotesk-700-subset.woff2': {
    license: 'OFL-SpaceGrotesk.txt',
    rights: {
      origin: 'Space Grotesk 700, from @fontsource/space-grotesk@5.2.8 (space-grotesk-latin-700-normal.woff2)',
      license: 'OFL-1.1',
      redistributable: true,
      attributionRequired: true,
      modifications: SPACE_MODIFICATIONS,
      notice: SPACE_NOTICE,
    },
  },
};
const FONT_LICENSES = ['OFL-NotoSansSC.txt', 'OFL-SpaceGrotesk.txt'];
const DOCUMENT_FILES = ['poster.html', 'poster.css', 'social.html', 'social.css'];
const FILM_FILES = ['film.html', 'film.mjs'];

/** The same id the original copier derived from the Project-relative path. */
function pathToAssetId(relative) {
  return relative.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').toLowerCase();
}

function readmeText({ totalFrames }) {
  const seconds = totalFrames % FPS === 0 ? String(totalFrames / FPS) : (totalFrames / FPS).toFixed(3);
  return `# Poster and film — an image + video Project

One Project, two design documents and one short film that share a photograph and a
type pairing.

| What | Where |
| --- | --- |
| Poster document (1200×1500) | \`poster.html\` + \`poster.css\` |
| Social document (1080×1080) | \`social.html\` + \`social.css\` |
| Still targets | \`print\` (1200×1500), \`print-2x\` (2400×3000), \`social\` (1080×1080) |
| Short film (${seconds} s, 640×360, 24 fps) | \`film.html\` + \`film.mjs\` |
| Photograph | \`assets/light.png\` (generated; see its Asset rights) |
| Fonts | \`fonts/\` (OFL 1.1; texts beside them) |

## Work on it

\`\`\`bash
viscraft image .            # render the default still target
viscraft image . --target social
viscraft workbench . --target print   # edit in a browser
viscraft build .            # render the film
viscraft status .
\`\`\`

The workbench writes \`poster.html\` (or \`social.html\`) in place, so an Agent and a
human edit the same author source. The film reads the same \`assets/light.png\` and
the same fonts; changing either invalidates the still and the film.

## Hand it over

\`viscraft export . <destination>\` writes a portable
Project (author sources, resources, licences) that opens in another directory
without this one.
`;
}

const LICENSES_TEXT = `# Licences

The two font families in \`fonts/\` are licensed under the SIL Open Font License 1.1.
The verbatim texts are \`fonts/OFL-NotoSansSC.txt\` and \`fonts/OFL-SpaceGrotesk.txt\`.

Everything else in this Project was authored for the example and is MIT: the two
design documents, the film, the fonts' pairing, and the generated photograph.
`;

export default async function create({ options: rawOptions }) {
  if (rawOptions === null || typeof rawOptions !== 'object' || Array.isArray(rawOptions))
    throw new Error('poster-and-film options must be a JSON object');
  for (const key of Object.keys(rawOptions))
    if (key !== 'frames')
      throw new Error(`poster-and-film does not take the option "${key}"; use frames`);
  const frames = rawOptions.frames ?? 48;
  if (!Number.isInteger(frames) || frames < 8) throw new Error('frames must be an integer >= 8');
  const totalFrames = frames;

  const fontDeclarations = FONT_FILES.map(name => ({
    path: `fonts/${name}`,
    sourcePath: join(FONTS_DIR, name),
  }));
  const licenseDeclarations = FONT_LICENSES.map(name => ({
    path: `fonts/${name}`,
    sourcePath: join(FONTS_DIR, name),
  }));

  const files = [
    // The design DOCUMENTS are `imageDocuments`: they are edited in place (by the
    // workbench or by hand) and their bytes are frozen per render. They are not
    // code Assets, which is a role distinction, not a workbench limitation.
    ...DOCUMENT_FILES.map(name => ({ path: name, sourcePath: join(HERE, name) })),
    ...FILM_FILES.map(name => ({ path: name, sourcePath: join(HERE, name) })),
    ...fontDeclarations,
    ...licenseDeclarations,
    { path: IMAGE, bytes: lightStudy(IMAGE_WIDTH, IMAGE_HEIGHT) },
    { path: 'LICENSES.md', bytes: LICENSES_TEXT },
    { path: 'README.md', bytes: readmeText({ totalFrames }) },
  ];

  const assets = [
    ...FILM_FILES.map(name => ({
      id: pathToAssetId(name),
      path: name,
      type: 'code',
      simulated: false,
      rights: ORIGINAL,
    })),
    ...FONT_FILES.map(name => ({
      id: pathToAssetId(`fonts/${name}`),
      path: `fonts/${name}`,
      type: 'font',
      simulated: false,
      rights: FONTS[name].rights,
    })),
    {
      id: 'light_study',
      path: IMAGE,
      type: 'image',
      simulated: false,
      rights: {
        ...ORIGINAL,
        origin:
          'original: a procedural light study generated by poster-and-film/create.mjs (deterministic; not a photograph of a real place)',
      },
    },
  ];

  return {
    files,
    project: {
      schemaVersion: 1,
      id: 'poster-and-film',
      revision: 1,
      title: '光的量度 / MEASURING LIGHT — one design, a still and a film',
      direction: {
        intent:
          'An exhibition identity built on one photograph of afternoon light: a 4:5 poster, a 1:1 social card and a 2-second title film share the same image and the same two faces. The picture is an authored light study, not a photograph of a real place.',
        looks: [
          {
            id: 'archive',
            description:
              'Warm paper, dark plaster, one accent rust hairline; heavy CJK display type over the image, quiet Latin caps beneath.',
          },
        ],
        transitions: [],
      },
      assets,
      bindings: {},
      sources: [
        {
          id: 'film_scene',
          kind: 'browser',
          output: 'picture',
          entry: 'film.html',
          resources: ['film.mjs', IMAGE, ...FONT_FILES.map(name => `fonts/${name}`)],
          bindings: [],
          params: { frames: totalFrames },
          seed: 1201,
          frames: totalFrames,
        },
      ],
      imageDocuments: [
        {
          id: 'poster',
          path: 'poster.html',
          resources: ['poster.css', IMAGE, ...FONT_FILES.map(name => `fonts/${name}`)],
          revision: 1,
        },
        {
          id: 'social',
          path: 'social.html',
          resources: ['social.css', IMAGE, ...FONT_FILES.map(name => `fonts/${name}`)],
          revision: 1,
        },
      ],
      imageTargets: [
        { id: 'print', document: 'poster', width: 1200, height: 1500, scale: 1, format: 'png', background: 'opaque' },
        { id: 'print-2x', document: 'poster', width: 1200, height: 1500, scale: 2, format: 'png', background: 'opaque' },
        { id: 'social', document: 'social', width: 1080, height: 1080, scale: 1, format: 'png', background: 'opaque' },
      ],
      composition: {
        output: {
          width: WIDTH,
          height: HEIGHT,
          fps: { numerator: FPS, denominator: 1 },
          sampleRate: 48000,
          channels: 2,
        },
        scenes: [{ id: 'scene_main', description: 'One title scene: a slit of light opens on the poster photograph.' }],
        shots: [
          {
            id: 'shot_title',
            scene: 'scene_main',
            look: 'archive',
            intent: 'The photograph is revealed by an opening slit; the exhibition title rises into it.',
            targetFrames: totalFrames,
          },
        ],
        placements: [
          {
            id: 'pl_title',
            shot: 'shot_title',
            source: 'film_scene',
            inFrame: 0,
            outFrame: totalFrames,
            startFrame: 0,
            audio: 'mute',
          },
        ],
        transitions: [],
        // Deliberately silent: scored sound is a separate authoring decision
        // (see the sound-arrange module). No placeholder tone is passed off as a score.
        audio: [],
      },
      handoff: [
        ...FONT_LICENSES.map(name => ({ path: `fonts/${name}`, role: 'license' })),
        { path: 'LICENSES.md', role: 'license' },
        { path: 'README.md', role: 'readme' },
      ],
    },
  };
}
