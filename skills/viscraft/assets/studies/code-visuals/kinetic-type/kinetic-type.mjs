// kinetic-type.mjs — a short kinetic-typography reading segment for a browser Source.
//
// The visual language is a Swiss-grid poster that is READ, not merely animated:
//
//   grid      a 12-column / 8-row grid builds in
//   reveal    kicker, mixed CJK/Latin title lines and subtitle rise through masks
//   hold      the page is still so the sentence can actually be read
//   emphasis  a chosen word is weighted in red and underlined; a number counts
//   transition a mask wipe moves the poster into a compact index layout
//   settle    the index holds as the final frame
//
// The implementation is an original canvas-2D adaptation of mechanisms observed
// in LemoLab's swiss-motion `film.js`/`ease.js` (grid build, clipped line rise,
// staged line entry, easing) and huashu-art-motion's y5 kinetic-type clip
// (method study only: hierarchy and page progression, no source copied).
// It is DELIBERATELY NOT the upstream 44-second film: there is no story, score,
// voice, poster wall, rotating camera or fixed 120 BPM rule here.
//
// Time is a pure function of the capture frame. There is no wall clock, no
// Math.random, and no requestAnimationFrame. The browser source calls
// `renderKineticType(canvas, ctx)` once per frame; `readyKineticType()` loads the
// complete Noto Sans SC variable font before the first frame.
//
// Text policy:
//   - the authored font stack names only the delivered Noto Sans SC WOFF2; the
//     default text is covered by its cmap, and a code point outside that cmap
//     is not promised (the browser may apply its own last-resort fallback),
//   - long titles are rewrapped at a readable minimum size; if a title still
//     needs more than `titleMaxLines` at that floor, render throws instead of
//     shrinking it forever,
//   - mixed CJK/Latin text breaks between CJK characters and at Latin word
//     boundaries while the word fits; a Latin word wider than the column is
//     broken by character, and closing punctuation does not start a line.

export const FONT_FAMILY = 'Noto Sans SC Kinetic';
export const FONT_FILE = 'fonts/NotoSansSC-VF.woff2';
export const VARIANTS = ['poster', 'ledger'];

export const DEFAULT_PARAMS = Object.freeze({
  title: '\u6570\u636e\u4e4b\u540e\uff0c\u57ce\u5e02\u9192\u6765',
  subtitle: '\u9605\u8bfb\u8282\u594f / A study in reading rhythm',
  number: '24',
  emphasis: '\u57ce\u5e02',
  variant: 'poster',
  frames: 192,
  titleMinSize: 44,
  titleMaxLines: 4,
});

const DESIGN_W = 960;
const DESIGN_H = 540;
const COLUMNS = 12;
const ROWS = 8;
const MARGIN = 40;
const COL = (DESIGN_W - MARGIN * 2) / COLUMNS;
const ROW = (DESIGN_H - MARGIN * 2) / ROWS;

const PAPER = '#EAE9E5';
const INK = '#111111';
const MUTED = '#77766F';
const GRID = '#CFCEC9';
const RED = '#E30613';

const KICKER = 'KINETIC TYPE / READING RHYTHM';
const INDEX_LABEL = 'READING INDEX';
const FOOTER = 'TYPE / MOTION';

const FONT_STACK = `"${FONT_FAMILY}"`;
const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u;
const BREAKABLE_PUNCT = /[\u3000-\u303f\uff00-\uffef]/u;
const NO_LINE_START = new Set(
  Array.from('\u3001\u3002\uff0c\uff0e\uff1b\uff1a\uff01\uff1f\u2026\u2014\u00b7,.;:!?)]}\u300d\u300f\u3011\u300b\u2019\u201d'),
);

let fontPromise;

/** Load the complete font and prove the face is available for the authored sample. */
export async function readyKineticType() {
  fontPromise ??= (async () => {
    if (typeof document === 'undefined' || typeof FontFace === 'undefined')
      throw new Error('kinetic-type: a browser with FontFace support is required');
    const url = new URL(`./${FONT_FILE}`, document.baseURI).href;
    const face = new FontFace(FONT_FAMILY, `url("${url}")`, { weight: '100 900', style: 'normal' });
    try {
      await face.load();
    } catch (error) {
      throw new Error(
        `kinetic-type: the Noto Sans SC font failed to load from ${url}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    document.fonts.add(face);
    const sample = '\u6570\u636e Aa 09\uff0c\u3002';
    if (!document.fonts.check(`700 64px "${FONT_FAMILY}"`, sample))
      throw new Error('kinetic-type: the loaded font is not available for the required CJK/Latin sample');
  })();
  return fontPromise;
}

const clamp01 = value => Math.max(0, Math.min(1, value));
const lerp = (a, b, t) => a + (b - a) * t;
const seg = (value, start, end) => clamp01((value - start) / Math.max(1e-9, end - start));
const easeOut = value => 1 - Math.pow(1 - clamp01(value), 3);
const easeInOut = value =>
  value < 0.5 ? 2 * value * value : 1 - Math.pow(-2 * value + 2, 2) / 2;

function integer(value, fallback, min, max) {
  return Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function normalize(params) {
  const source = params && typeof params === 'object' ? params : {};
  const p = { ...DEFAULT_PARAMS, ...source };
  const title = typeof p.title === 'string' ? p.title.trim() : '';
  const subtitle = typeof p.subtitle === 'string' ? p.subtitle.trim() : '';
  const number = typeof p.number === 'string' ? p.number.trim() : String(p.number ?? '');
  const emphasis = typeof p.emphasis === 'string' ? p.emphasis : '';
  if (!title) throw new Error('kinetic-type: title must be a non-empty string');
  return {
    title,
    subtitle,
    number,
    emphasis,
    variant: VARIANTS.includes(p.variant) ? p.variant : 'poster',
    frames: integer(p.frames, DEFAULT_PARAMS.frames, 2, 1200),
    titleMinSize: integer(p.titleMinSize, DEFAULT_PARAMS.titleMinSize, 32, 96),
    titleMaxLines: integer(p.titleMaxLines, DEFAULT_PARAMS.titleMaxLines, 2, 6),
  };
}

function setFont(g, size, weight = 700, spacing = 0) {
  g.font = `${weight} ${size}px ${FONT_STACK}`;
  g.letterSpacing = `${spacing}px`;
}

function widthOf(g, text, size, weight = 700, spacing = 0) {
  setFont(g, size, weight, spacing);
  return g.measureText(text).width;
}

/**
 * Split mixed text into break opportunities: each CJK/wide punctuation character
 * is its own token; a Latin run stays a word while it fits; a closing
 * punctuation token is absorbed by the previous token so it cannot start a
 * line. `wrapText` breaks an over-wide Latin token by character.
 */
function tokensOf(text) {
  const tokens = [];
  let space = false;
  for (const part of text.split(/(\s+)/)) {
    if (!part) continue;
    if (/^\s+$/.test(part)) {
      space = true;
      continue;
    }
    let latin = '';
    let first = true;
    const flush = () => {
      if (!latin) return;
      tokens.push({ text: latin, space: space && first });
      first = false;
      latin = '';
      space = false;
    };
    for (const ch of Array.from(part)) {
      if (CJK.test(ch) || BREAKABLE_PUNCT.test(ch)) {
        flush();
        if (NO_LINE_START.has(ch) && tokens.length > 0) tokens[tokens.length - 1].text += ch;
        else tokens.push({ text: ch, space: space && first });
        first = false;
        space = false;
      } else {
        latin += ch;
      }
    }
    flush();
  }
  return tokens;
}

/** Balanced line wrapper for mixed CJK/Latin text. */
function wrapText(g, text, maxWidth, size, weight = 700) {
  const expanded = [];
  for (const token of tokensOf(text)) {
    setFont(g, size, weight);
    if (g.measureText(token.text).width <= maxWidth || Array.from(token.text).length <= 1) {
      expanded.push(token);
      continue;
    }
    let first = true;
    for (const ch of Array.from(token.text)) {
      expanded.push({ text: ch, space: first && token.space });
      first = false;
    }
  }
  if (expanded.length === 0) return [];
  setFont(g, size, weight);
  const tokenWidth = expanded.map(token => g.measureText(token.text).width);
  const spaceWidth = g.measureText(' ').width;
  const prefix = [0];
  for (let i = 0; i < expanded.length; i++)
    prefix.push(prefix[i] + tokenWidth[i] + (i > 0 && expanded[i].space ? spaceWidth : 0));
  const lineWidth = (start, end) =>
    prefix[end] - prefix[start] - (start > 0 && expanded[start].space ? spaceWidth : 0);
  const lineText = (start, end) => {
    let line = '';
    for (let i = start; i < end; i++) line += `${i > start && expanded[i].space ? ' ' : ''}${expanded[i].text}`;
    return line;
  };

  // A small DP balances the ragged edge instead of leaving a one-character
  // widow. Slack is squared, with a mild per-line penalty so fewer lines win
  // when the balance is comparable.
  const n = expanded.length;
  const maxLines = Math.min(8, n);
  const penalty = maxWidth * maxWidth * 0.05;
  const best = Array.from({ length: n + 1 }, () => Array(maxLines + 1).fill(Infinity));
  const previous = Array.from({ length: n + 1 }, () => Array(maxLines + 1).fill(-1));
  best[0][0] = 0;
  for (let lines = 1; lines <= maxLines; lines++) {
    for (let end = 1; end <= n; end++) {
      for (let start = end - 1; start >= 0; start--) {
        if (best[start][lines - 1] === Infinity) continue;
        const width = lineWidth(start, end);
        if (width > maxWidth) break;
        const slack = maxWidth - width;
        const cost = best[start][lines - 1] + slack * slack + penalty;
        if (cost < best[end][lines]) {
          best[end][lines] = cost;
          previous[end][lines] = start;
        }
      }
    }
  }
  let chosen = 0;
  for (let lines = 1; lines <= maxLines; lines++)
    if (best[n][lines] < (chosen === 0 ? Infinity : best[n][chosen])) chosen = lines;
  if (chosen === 0) {
    // No fit at this width: return one token per line so the caller can apply
    // its readable-minimum/line-budget policy and fail loudly.
    return expanded.map((token, index) => lineText(index, index + 1));
  }
  const lines = [];
  let end = n;
  for (let count = chosen; count > 0; count--) {
    const start = previous[end][count];
    lines.push(lineText(start, end));
    end = start;
  }
  return lines.reverse();
}

function layoutTitle(g, text, maxWidth, baseSize, minSize, maxLines, maxHeight) {
  let size = baseSize;
  let lines = [];
  for (;;) {
    lines = wrapText(g, text, maxWidth, size);
    const fitsLines = lines.length <= maxLines;
    const fitsHeight = lines.length * size * 1.06 <= maxHeight;
    if ((fitsLines && fitsHeight) || size <= minSize) break;
    size = Math.max(minSize, size - 4);
  }
  return { lines, size, maxWidth, maxHeight };
}

function reveal(g, text, x, y, size, weight, progress, color, align = 'left', spacing = 0) {
  if (progress <= 0 || !text) return;
  setFont(g, size, weight, spacing);
  g.fillStyle = color;
  g.textAlign = align;
  const width = g.measureText(text).width;
  const left = align === 'right' ? x - width : align === 'center' ? x - width / 2 : x;
  const top = y - size * 1.12;
  const height = size * 1.36;
  const rise = (1 - easeOut(progress)) * size * 1.12;
  g.save();
  g.beginPath();
  g.rect(left - 8, top, width + 16, height);
  g.clip();
  g.fillText(text, x, y + rise);
  g.restore();
  g.textAlign = 'left';
}

function drawGrid(g, progress, seed) {
  if (progress <= 0) return;
  g.save();
  g.strokeStyle = GRID;
  g.lineWidth = 1;
  g.globalAlpha = lerp(0.95, 0.45, progress);
  for (let i = 0; i <= COLUMNS; i++) {
    const p = easeOut(seg(progress, i * 0.012, 0.72 + i * 0.012));
    if (p <= 0) continue;
    const x = MARGIN + i * COL + 0.5;
    g.beginPath();
    g.moveTo(x, MARGIN);
    g.lineTo(x, MARGIN + (DESIGN_H - MARGIN * 2) * p);
    g.stroke();
  }
  for (let j = 0; j <= ROWS; j++) {
    const p = easeOut(seg(progress, 0.08 + j * 0.012, 0.8 + j * 0.012));
    if (p <= 0) continue;
    const y = MARGIN + j * ROW + 0.5;
    g.beginPath();
    g.moveTo(MARGIN, y);
    g.lineTo(MARGIN + (DESIGN_W - MARGIN * 2) * p, y);
    g.stroke();
  }
  // A deterministic registration mark, keyed by the Source seed.
  const r = easeOut(seg(progress, 0.55, 0.9));
  if (r > 0) {
    const x = MARGIN + (seed % COLUMNS) * COL;
    const y = MARGIN + (seed % ROWS) * ROW;
    g.globalAlpha = 0.9 * r;
    g.fillStyle = RED;
    g.fillRect(x - 3, y - 3, 6, 6);
  }
  g.restore();
}

function drawKicker(g, progress) {
  reveal(g, KICKER, MARGIN, 164, 15, 700, progress, MUTED, 'left', 2.2);
}

function drawRule(g, progress, y, from = MARGIN, to = DESIGN_W - MARGIN, color = INK) {
  if (progress <= 0) return;
  g.save();
  g.fillStyle = color;
  g.fillRect(from, y, (to - from) * easeOut(progress), 1);
  g.restore();
}

function drawTitleLines(g, lines, xFor, y, lineHeight, size, revealProgress, emphasis, emphasisProgress) {
  setFont(g, size, 700);
  for (const [index, line] of lines.entries()) {
    const p = seg(revealProgress, index * 0.16, 0.62 + index * 0.16);
    if (p <= 0) continue;
    const x = xFor(line);
    const lineY = y + index * lineHeight;
    const at = emphasis ? line.indexOf(emphasis) : -1;
    if (at < 0 || emphasisProgress <= 0) {
      reveal(g, line, x, lineY, size, 700, p, INK);
      continue;
    }
    const before = line.slice(0, at);
    const part = line.slice(at, at + emphasis.length);
    const after = line.slice(at + emphasis.length);
    const beforeW = widthOf(g, before, size);
    const partW = widthOf(g, part, size);
    const rise = (1 - easeOut(p)) * size * 1.12;
    g.save();
    g.beginPath();
    g.rect(x - 8, lineY - size * 1.12, widthOf(g, line, size) + 16, size * 1.36);
    g.clip();
    g.textAlign = 'left';
    g.fillStyle = INK;
    setFont(g, size, 700);
    g.fillText(before, x, lineY + rise);
    g.fillStyle = emphasisProgress > 0 ? RED : INK;
    g.fillText(part, x + beforeW, lineY + rise);
    g.fillStyle = INK;
    g.fillText(after, x + beforeW + partW, lineY + rise);
    g.restore();
    if (emphasisProgress > 0) {
      g.fillStyle = RED;
      g.fillRect(x + beforeW, lineY + size * 0.14, partW * easeOut(emphasisProgress), 3);
    }
  }
}

function drawNumber(g, value, target, size, x, y, labelY, progress) {
  const numeric = /^\d+$/.test(target);
  const shown = numeric
    ? String(Math.round(Number(target) * easeOut(seg(progress, 0.15, 0.9)))).padStart(target.length, '0')
    : value;
  reveal(g, shown, x, y, size, 700, progress, INK, 'right');
  reveal(g, INDEX_LABEL, x, labelY, 13, 700, seg(progress, 0.5, 1), MUTED, 'right', 1.4);
}

/**
 * A one-character CJK head followed by a space-separated run (for example
 * `习 / Reading ...`) is a typographic orphan. Move the character up when the
 * previous line can still hold it; the next line then begins with the slash or
 * the Latin run instead of an orphan.
 */
function avoidLoneCjkHead(g, lines, size, weight, maxWidth) {
  for (let i = 1; i < lines.length; i++) {
    const chars = Array.from(lines[i]);
    if (chars.length < 2 || !CJK.test(chars[0])) continue;
    if (!/^\s/.test(chars.slice(1).join(''))) continue;
    const joined = lines[i - 1] + chars[0];
    if (widthOf(g, joined, size, weight) > maxWidth) continue;
    lines[i - 1] = joined;
    lines[i] = chars.slice(1).join('').replace(/^\s+/, '');
  }
  return lines;
}

function layoutSubtitle(g, text, maxWidth) {
  let size = 25;
  let lines = wrapText(g, text, maxWidth, size, 400);
  lines = avoidLoneCjkHead(g, lines, size, 400, maxWidth);
  while (lines.length > 2 && size > 19) {
    size -= 1;
    lines = wrapText(g, text, maxWidth, size, 400);
    lines = avoidLoneCjkHead(g, lines, size, 400, maxWidth);
  }
  if (lines.length > 2)
    throw new Error(`kinetic-type: the subtitle needs ${lines.length} lines at the readable minimum; shorten it`);
  return { lines, size, lineHeight: size * 1.22 };
}

function drawActA(g, p, u, layout) {
  const gridProgress = seg(u, 0, 0.28);
  drawGrid(g, gridProgress, p.seed);
  drawKicker(g, seg(u, 0.06, 0.2));
  drawRule(g, seg(u, 0.1, 0.28), 198, MARGIN, DESIGN_W - MARGIN, GRID);

  const titleTop = 234;
  const lineHeight = layout.size * 1.06;
  const xFor = line => (p.variant === 'ledger' ? (DESIGN_W - widthOf(g, line, layout.size)) / 2 : MARGIN);
  const revealProgress = seg(u, 0.12, 0.4);
  const emphasisProgress = seg(u, 0.56, 0.68);
  drawTitleLines(g, layout.lines, xFor, titleTop, lineHeight, layout.size, revealProgress, p.emphasis, emphasisProgress);

  const subtitleMaxWidth = p.variant === 'ledger' ? 780 : 600;
  const subtitle = layoutSubtitle(g, p.subtitle, subtitleMaxWidth);
  const subtitleY = titleTop + layout.lines.length * lineHeight + 24;
  for (const [index, line] of subtitle.lines.entries()) {
    const subtitleX =
      p.variant === 'ledger' ? (DESIGN_W - widthOf(g, line, subtitle.size, 400)) / 2 : MARGIN;
    reveal(
      g,
      line,
      subtitleX,
      subtitleY + index * subtitle.lineHeight,
      subtitle.size,
      400,
      seg(u, 0.22 + index * 0.02, 0.38 + index * 0.02),
      MUTED,
    );
  }

  const numberProgress = seg(u, 0.24, 0.44);
  drawNumber(g, p.number, p.number, 148, DESIGN_W - MARGIN, 152, 178, numberProgress);

  drawRule(g, seg(u, 0.24, 0.36), 506, MARGIN, DESIGN_W - MARGIN, INK);
  reveal(g, FOOTER, MARGIN, 528, 12, 500, seg(u, 0.26, 0.38), MUTED, 'left', 1.6);
}

function drawActB(g, p, u, layoutA) {
  const size = Math.max(36, Math.round(layoutA.size * 0.72));
  const lines = wrapText(g, p.title, 560, size);
  if (lines.length > p.titleMaxLines + 1)
    throw new Error(
      `kinetic-type: the title needs ${lines.length} lines in the index layout; shorten it or raise titleMaxLines`,
    );
  const lineHeight = size * 1.05;
  const top = 116;
  for (const [index, line] of lines.entries()) {
    reveal(g, line, MARGIN, top + index * lineHeight, size, 700, seg(u, 0.72, 0.88), INK);
  }
  const subtitle = layoutSubtitle(g, p.subtitle, 560);
  const subtitleY = top + lines.length * lineHeight + 24;
  for (const [index, line] of subtitle.lines.entries())
    reveal(g, line, MARGIN, subtitleY + index * subtitle.lineHeight, subtitle.size, 400, seg(u, 0.76 + index * 0.02, 0.88 + index * 0.02), MUTED);

  const numberProgress = seg(u, 0.74, 0.9);
  const numberSize = p.number.length <= 3 ? 208 : 150;
  reveal(g, p.number, DESIGN_W - MARGIN, 474, numberSize, 700, numberProgress, INK, 'right');
  reveal(g, INDEX_LABEL, DESIGN_W - MARGIN, 502, 13, 700, numberProgress, MUTED, 'right', 1.4);

  const rule = easeOut(seg(u, 0.72, 0.9));
  g.fillStyle = RED;
  g.fillRect(932, 92, 3, 356 * rule);
  g.fillStyle = INK;
  g.fillRect(MARGIN, 506, (DESIGN_W - MARGIN * 2) * rule, 1);
  reveal(g, FOOTER, MARGIN, 528, 12, 500, seg(u, 0.8, 0.9), MUTED, 'left', 1.6);
}

export function renderKineticType(canvas, ctx) {
  if (!canvas) throw new Error('kinetic-type: canvas is required');
  const params = normalize(ctx?.params);
  const seed = Number.isInteger(ctx?.seed) ? ctx.seed : 0;
  const width = Math.max(2, Math.round(Number(ctx?.width) || DESIGN_W));
  const height = Math.max(2, Math.round(Number(ctx?.height) || DESIGN_H));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('kinetic-type: a 2D canvas context is required');

  const frames = params.frames;
  const u = frames > 1 ? clamp01((Number(ctx?.frame) || 0) / (frames - 1)) : 0;
  const scale = Math.min(width / DESIGN_W, height / DESIGN_H);
  const ox = (width - DESIGN_W * scale) / 2;
  const oy = (height - DESIGN_H * scale) / 2;

  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = PAPER;
  g.fillRect(0, 0, width, height);
  g.save();
  g.translate(ox, oy);
  g.scale(scale, scale);
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  g.letterSpacing = '0px';

  // Layout is measured once per frame; the browser and capture use the same
  // deterministic width for the delivered font.
  const maxWidthA = params.variant === 'ledger' ? 780 : 600;
  const baseSizeA = params.variant === 'ledger' ? 78 : 74;
  const layoutA = layoutTitle(g, params.title, maxWidthA, baseSizeA, params.titleMinSize, params.titleMaxLines, 210);
  if (
    layoutA.lines.length > params.titleMaxLines ||
    layoutA.lines.length * layoutA.size * 1.06 > layoutA.maxHeight
  )
    throw new Error(
      `kinetic-type: the title needs ${layoutA.lines.length} lines / ${Math.round(
        layoutA.lines.length * layoutA.size * 1.06,
      )}px at the ${params.titleMinSize}px readable minimum; shorten it, widen the layout or raise titleMaxLines`,
    );
  if (params.emphasis && !layoutA.lines.some(line => line.includes(params.emphasis)))
    throw new Error(
      `kinetic-type: the emphasis "${params.emphasis}" is split across a line break in the title; choose a word that stays on one line`,
    );

  const p = { ...params, seed };
  drawActA(g, p, u, layoutA);

  const wipe = easeInOut(seg(u, 0.72, 0.9));
  if (wipe > 0) {
    // Clear the outgoing page quickly as the new page advances. A sliced old
    // line otherwise leaves a stray glyph fragment right of the wipe edge.
    g.save();
    g.globalAlpha = Math.min(1, wipe * 3);
    g.fillStyle = PAPER;
    g.fillRect(0, 0, DESIGN_W, DESIGN_H);
    g.restore();

    // Paper for the new page's left panel, then one grid across the whole
    // frame so the outgoing side does not become a blank rectangle.
    g.save();
    g.beginPath();
    g.rect(0, 0, DESIGN_W * wipe, DESIGN_H);
    g.clip();
    g.fillStyle = PAPER;
    g.fillRect(0, 0, DESIGN_W, DESIGN_H);
    g.restore();
    drawGrid(g, 1, seed);

    g.save();
    g.beginPath();
    g.rect(0, 0, DESIGN_W * wipe, DESIGN_H);
    g.clip();
    drawActB(g, p, u, layoutA);
    g.restore();

    if (wipe < 0.999) {
      g.fillStyle = RED;
      g.fillRect(DESIGN_W * wipe - 1.5, 0, 3, DESIGN_H);
    }
  }

  g.restore();
}
