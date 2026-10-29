// Deterministic SRT subtitle sidecar.
//
// The burned-in `overlay-subtitles` pass makes captions part of the picture and
// is therefore not editable or text-searchable. This module produces the
// companion editable caption source as a plain SRT file so a delivery bundle
// carries both. It is deliberately picture-independent: it reuses the shared
// `SubtitleSchema` and the same half-open frame interval contract as
// `renderSubtitles` (`src/backends/media/subtitles.ts`) — a caption is visible on
// frame n iff `startFrame <= n < endFrame` — so the sidecar can never disagree
// with what was burned in.
//
// Determinism: the frame -> time mapping is exact rational arithmetic on the
// composition's `{numerator, denominator}` output rate (BigInt, round half up to
// the nearest millisecond). Caption text is emitted verbatim (no HTML/markup, no
// escaping) except that internal line breaks are normalised to CRLF so the whole
// file uses the conventional SRT line ending. A blank line is impossible by schema
// and would otherwise terminate the cue as a bogus extra cue. The same project
// therefore yields byte-identical output.

import { SubtitleSchema, type Fps, type Subtitle } from '../../core/schema.js';

/** SRT conventionally separates lines with CRLF; kept constant for byte-stable output. */
export const SRT_LINE_ENDING = '\r\n';

/**
 * Exact start instant of `frame` in milliseconds at a rational frame rate.
 *
 * A frame index `f` begins at `f * denominator / numerator` seconds, so its
 * millisecond value is `f * denominator * 1000 / numerator`. BigInt keeps the
 * ratio exact for non-integer rates such as 30000/1001; the single rounding step
 * is round-half-up to the nearest millisecond.
 */
export function frameToMilliseconds(frame: number, fps: Fps): number {
  if (!Number.isSafeInteger(frame) || frame < 0) throw new Error('Subtitle frame must be a nonnegative safe integer');
  for (const value of [fps.numerator, fps.denominator]) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error('Subtitle frame rate must be positive safe integers');
  }
  const numerator = BigInt(frame) * BigInt(fps.denominator) * 1000n;
  const denominator = BigInt(fps.numerator);
  const rounded = numerator / denominator + (2n * (numerator % denominator) >= denominator ? 1n : 0n);
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Subtitle timecode exceeds the safe integer range');
  return Number(rounded);
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** Format a nonnegative millisecond count as `HH:MM:SS,mmm` (SRT timecode). */
export function formatSrtTimecode(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
    throw new Error('Subtitle timecode must be a nonnegative safe integer');
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  const millis = milliseconds % 1_000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(millis, 3)}`;
}

/**
 * Render declared Composition subtitles to deterministic SRT text.
 *
 * Captions keep array order and receive a sequential 1-based index. Start and
 * end timecodes come from the half-open interval `[startFrame, endFrame)` on the
 * composition output clock. Each caption is validated through the shared
 * `SubtitleSchema` first, so the same malformed input the burned-in renderer
 * rejects is rejected here rather than silently exported. An empty list yields
 * an empty string (the caller writes no sidecar at all).
 */
export function renderSubtitleSidecar(subtitles: Subtitle[], fps: Fps): string {
  const blocks = subtitles.map((subtitle, index) => {
    const parsed = SubtitleSchema.parse(subtitle);
    const start = formatSrtTimecode(frameToMilliseconds(parsed.startFrame, fps));
    const end = formatSrtTimecode(frameToMilliseconds(parsed.endFrame, fps));
    // Multi-line captions are legitimate (a cue's text may span several lines), so
    // internal breaks are preserved and normalised to CRLF so the whole file uses
    // one line ending. A blank line cannot occur: SubtitleSchema forbids leading,
    // trailing and consecutive newlines, because a blank line is the SRT cue
    // separator and would split this cue into a bogus extra cue.
    const text = parsed.text.replace(/\r\n|\r|\n/g, SRT_LINE_ENDING);
    return `${index + 1}${SRT_LINE_ENDING}${start} --> ${end}${SRT_LINE_ENDING}${text}${SRT_LINE_ENDING}`;
  });
  return blocks.length === 0 ? '' : `${blocks.join(SRT_LINE_ENDING)}${SRT_LINE_ENDING}`;
}
