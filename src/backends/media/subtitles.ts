// Viscraft subtitle overlay control plane.
//
// Deterministic FFmpeg-backed subtitle rendering. This module owns exactly one
// pass: burning Composition subtitles onto an already composed picture track,
// then re-encoding to the exact output frame count / frame rate. It is a
// "picture-only" transform — audio is always stripped — so a subtitle-only
// revision reuses every accepted Take, the composed picture and the mixed audio
// and only re-runs overlay + remux.
//
// Safety conventions enforced here:
//  - Subtitle text never enters the filtergraph. Each caption is written to a
//    private temp file and referenced through `textfile=` with `expansion=none`,
//    so quotes, colons, percent signs, backslashes, dollar signs and newlines
//    stay literal and cannot inject filters or expressions.
//  - Filesystem paths are escaped and intervals are numeric, so no caption text
//    is ever interpolated into the filter string.
//  - The resolved font is validated by sha256 immediately before and after the
//    FFmpeg run, so a font swapped mid-render is detected rather than silently
//    used.
//  - Frame intervals are half-open [startFrame, endFrame) evaluated with
//    `enable='gte(n,start)*lt(n,end)'` against the exact rational frame rate.

import { constants, promises as fs } from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';

import { SubtitleSchema, type OutputSettings, type Subtitle } from '../../core/schema.js';
import { hashFile } from '../../shared/hash.js';
import { runCommand } from '../../shared/process.js';
import { probeMedia } from './probe.js';
import { escapeFilterValue } from './filter-escape.js';

/** A resolved, hashed font available for burning subtitles. */
export interface SubtitleFont {
  path: string;
  sha256: string;
}

// Mirror media.ts: polite, reproducible thread limits on every invocation.
const FFMPEG_GLOBAL_ARGS = ['-hide_banner', '-nostdin', '-y', '-filter_threads', '1', '-filter_complex_threads', '1'];
const FFMPEG_OUTPUT_THREADS = ['-threads', '2'];

// Local system fonts are candidates only; nothing is installed or distributed here.
export function systemFontCandidates(
  platform: NodeJS.Platform = process.platform,
  systemRoot = process.env.SystemRoot ?? 'C:/Windows',
): string[] {
  if (platform === 'win32') return [nodePath.win32.join(systemRoot, 'Fonts', 'arial.ttf')];
  if (platform === 'darwin')
    return [
      '/System/Library/Fonts/Supplemental/Arial.ttf',
      '/Library/Fonts/Arial.ttf',
      '/System/Library/Fonts/Helvetica.ttc',
    ];
  return [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
    '/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf',
  ];
}

interface StatLike {
  isFile(): boolean;
}

async function statFile(file: string): Promise<StatLike | undefined> {
  try {
    return await fs.stat(file);
  } catch {
    return undefined;
  }
}

/**
 * Assert that `file` is an absolute, readable, regular file. Errors never echo
 * the path itself: an operator may point VISCRAFT_SUBTITLE_FONT at a private
 * location that must not leak into build logs.
 */
async function assertReadableFile(file: string): Promise<void> {
  if (!nodePath.isAbsolute(file)) throw new Error('Subtitle font path must be absolute');
  const info = await statFile(file);
  if (!info || !info.isFile()) throw new Error('Subtitle font is missing or not a regular file');
  try {
    await fs.access(file, constants.R_OK);
  } catch {
    throw new Error('Subtitle font is not readable');
  }
}

/**
 * Resolve the subtitle font without installing anything.
 *
 * Priority:
 *  1. `VISCRAFT_SUBTITLE_FONT` when set (must be an absolute, readable file —
 *     an invalid override is a hard error, never a silent fallback);
 *  2. a known local system font.
 *
 * The returned sha256 lets the caller freeze the exact font into the build.
 */
export async function findSubtitleFont(): Promise<SubtitleFont> {
  const configured = process.env.VISCRAFT_SUBTITLE_FONT;
  if (configured !== undefined && configured.length > 0) {
    await assertReadableFile(configured);
    return { path: configured, sha256: await hashFile(configured) };
  }
  for (const candidate of systemFontCandidates()) {
    if (await statFile(candidate).then(info => Boolean(info?.isFile()))) {
      await assertReadableFile(candidate);
      return { path: candidate, sha256: await hashFile(candidate) };
    }
  }
  throw new Error('No usable system subtitle font found; set VISCRAFT_SUBTITLE_FONT to an absolute font file path');
}

let drawtextSupport: Promise<boolean> | undefined;

/** Detect a real `drawtext` filter once per process; never assume it exists. */
async function hasDrawtextFilter(): Promise<boolean> {
  drawtextSupport ??= runCommand('ffmpeg', ['-hide_banner', '-filters'])
    .then(output => /\bdrawtext\b/.test(output))
    .catch(() => false);
  return drawtextSupport;
}

function sameFps(a: OutputSettings['fps'], b: OutputSettings['fps']): boolean {
  return a.numerator * b.denominator === b.numerator * a.denominator;
}

async function writeCaptionText(tmpDir: string, index: number, text: string): Promise<string> {
  const file = nodePath.join(tmpDir, `text-${index}.txt`);
  await fs.writeFile(file, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return file;
}

/**
 * Build the filterchain that draws each caption, in array order, so later
 * captions layer over earlier ones and overlaps are intentional.
 *
 * Text is never inlined: each caption goes to a private file referenced with
 * `textfile=` and `expansion=none`.
 */
async function buildFilterChain(
  subtitles: Subtitle[],
  output: OutputSettings,
  font: SubtitleFont,
  tmpDir: string,
): Promise<string> {
  const fontfile = escapeFilterValue(font.path);
  const parts: string[] = [];
  let previous = '0:v';

  for (let index = 0; index < subtitles.length; index++) {
    const subtitle = subtitles[index];
    const textfile = escapeFilterValue(await writeCaptionText(tmpDir, index, subtitle.text));
    const label = index === subtitles.length - 1 ? 'vout' : `caption${index}`;
    const color = `0x${subtitle.color.slice(1).toLowerCase()}`;
    const x = subtitle.x === undefined ? '(w-text_w)/2' : String(subtitle.x);
    // Default baseline is a static value clamped to the top edge so a font
    // taller than the output never yields a negative y. Computing it here keeps
    // the filter option a plain integer with no expression or comma.
    const y =
      subtitle.y === undefined ? String(Math.max(0, output.height - subtitle.fontSize - 24)) : String(subtitle.y);
    const enable = `'gte(n,${subtitle.startFrame})*lt(n,${subtitle.endFrame})'`;
    const drawtext = [
      `fontfile=${fontfile}`,
      `textfile=${textfile}`,
      'expansion=none',
      `fontsize=${subtitle.fontSize}`,
      `fontcolor=${color}`,
      `x=${x}`,
      `y=${y}`,
      `enable=${enable}`,
    ].join(':');
    parts.push(`[${previous}]drawtext=${drawtext}[${label}]`);
    previous = label;
  }

  if (subtitles.length === 0) parts.push('[0:v]null[vout]');
  return parts.join(';');
}

/**
 * Burn subtitles onto `input`, writing an H.264 picture track to `destination`
 * with the exact input frame count and the requested rational frame rate.
 *
 * The input picture must already be normalized to `output.fps`; a mismatch is a
 * hard error rather than a silent resample. Audio is always stripped — the
 * caller remuxes the mixed audio.
 *
 * Every caption interval is half-open: a caption is visible on frame `n` iff
 * `startFrame <= n < endFrame`. A caption that ends beyond the input picture is
 * rejected instead of silently rendering nothing. The default baseline clamps to
 * the top edge so a font taller than the output never produces a negative y.
 */
export async function renderSubtitles(
  input: string,
  subtitles: Subtitle[],
  output: OutputSettings,
  destination: string,
  font: SubtitleFont,
): Promise<void> {
  // Validate against the shared schema, then enforce the authoring bounds the
  // schema cannot express: static x/y must sit inside the output window.
  const validated = subtitles.map((subtitle, index) => {
    const parsed = SubtitleSchema.parse(subtitle);
    if (parsed.x !== undefined && parsed.x >= output.width) {
      throw new Error(`renderSubtitles: subtitle ${index} x=${parsed.x} is outside the ${output.width}px output width`);
    }
    if (parsed.y !== undefined && parsed.y >= output.height) {
      throw new Error(
        `renderSubtitles: subtitle ${index} y=${parsed.y} is outside the ${output.height}px output height`,
      );
    }
    if (parsed.fontSize > output.height) {
      throw new Error(
        `renderSubtitles: subtitle ${index} fontSize=${parsed.fontSize} is taller than the ${output.height}px output height`,
      );
    }
    return parsed;
  });

  // Freeze the font: it must be readable and match the supplied digest before
  // and after the render.
  await assertReadableFile(font.path);
  const before = await hashFile(font.path);
  if (before !== font.sha256) throw new Error('Subtitle font hash does not match the supplied digest');

  if (!(await hasDrawtextFilter())) {
    throw new Error('Subtitle rendering requires an FFmpeg build with the drawtext filter');
  }

  const source = await probeMedia(input);
  if (!sameFps(source.fps, output.fps)) {
    throw new Error('renderSubtitles: input frame rate does not match the output frame rate');
  }
  const expectedFrames = source.frames;

  // A caption ending after the picture would silently never be shown; reject at
  // the public boundary rather than emit an empty caption.
  for (let index = 0; index < validated.length; index++) {
    if (validated[index].endFrame > expectedFrames) {
      throw new Error(
        `renderSubtitles: caption ${index} ends at frame ${validated[index].endFrame} but the picture has only ${expectedFrames} frames`,
      );
    }
  }

  const tmpDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-subtitle-'));
  try {
    const chain = await buildFilterChain(validated, output, font, tmpDir);
    const fps = `${output.fps.numerator}/${output.fps.denominator}`;
    await runCommand('ffmpeg', [
      ...FFMPEG_GLOBAL_ARGS,
      '-i',
      input,
      '-filter_complex',
      chain,
      '-map',
      '[vout]',
      '-frames:v',
      String(expectedFrames),
      '-r',
      fps,
      '-fps_mode',
      'cfr',
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-an',
      ...FFMPEG_OUTPUT_THREADS,
      destination,
    ]);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  const after = await hashFile(font.path);
  if (after !== before) throw new Error('Subtitle font changed while rendering; refusing the result');

  const probed = await probeMedia(destination);
  if (probed.frames !== expectedFrames) {
    throw new Error(`renderSubtitles: expected ${expectedFrames} output frames, got ${probed.frames}`);
  }
  if (!sameFps(probed.fps, output.fps)) {
    throw new Error('renderSubtitles: output frame rate is not the requested rational rate');
  }
  if (probed.audio) {
    throw new Error('renderSubtitles: subtitle pass must strip audio for downstream muxing');
  }
}
