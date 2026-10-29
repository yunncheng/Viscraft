/**
 * Poster-and-film — the picture half of the example.
 *
 * This is an ORDINARY CodeScene: `render(ctx)` is called once per frame, in
 * ascending order, and must be a pure function of `ctx.frame` (no clock, no
 * `Math.random`, no rAF). It reuses the SAME photograph and the SAME two faces
 * as the poster documents, so the still and the film are one design rather than
 * two unrelated pieces.
 *
 * The scene: a slit of light opens across a plaster wall, the exhibition title
 * rises into the opening, and a hairline of accent colour keeps the frame's
 * beat. Frame count and size come from the composition, never from here.
 */

const INK = '#14110f';
const PAPER = '#f4efe6';
const ACCENT = '#b4472a';

let image;

export async function prepare(entry) {
  image = new Image();
  image.src = new URL('./assets/light.png', entry).href;
  await image.decode();
  // Load EVERY face the scene draws with, not just one weight: `fonts.ready`
  // only waits for requests already made, so an unrequested face would still be
  // loading on frame 0 and the first frames would rasterize a fallback.
  await Promise.all([
    document.fonts.load('400 12px "Archive CJK"'),
    document.fonts.load('700 52px "Archive CJK"'),
    document.fonts.load('400 11px "Archive Latin"'),
    document.fonts.load('700 15px "Archive Latin"'),
  ]);
  await document.fonts.ready;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}
function easeOut(value) {
  const t = clamp01(value);
  return 1 - Math.pow(1 - t, 3);
}

export function renderFilm(canvas, ctx) {
  const width = canvas.width;
  const height = canvas.height;
  const g = canvas.getContext('2d');
  const frame = ctx.frame;
  const totalFrames = Number(ctx.params?.frames);
  const total = Number.isFinite(totalFrames) && totalFrames > 1 ? totalFrames - 1 : Math.max(1, ctx.frame);
  const t = frame / total;

  g.save();
  g.fillStyle = INK;
  g.fillRect(0, 0, width, height);

  // The photograph sits in a horizontal band; a moving slit reveals it.
  const bandY = 34;
  const bandH = height - 88;
  const bandX = 64;
  const bandW = width - 128;
  const reveal = easeOut(frame / 22);
  const slitW = Math.max(2, bandW * reveal);

  g.save();
  g.beginPath();
  g.rect(bandX, bandY, slitW, bandH);
  g.clip();
  if (image && image.complete) {
    const scale = Math.max(bandW / image.naturalWidth, bandH / image.naturalHeight);
    const dw = image.naturalWidth * scale;
    const dh = image.naturalHeight * scale;
    // A slow push-in, still a pure function of the frame.
    const push = 1 + 0.06 * t;
    g.globalAlpha = 0.92;
    g.drawImage(
      image,
      bandX + (bandW - dw * push) / 2,
      bandY + (bandH - dh * push) / 2,
      dw * push,
      dh * push,
    );
    g.globalAlpha = 1;
  }
  // Darken the lower third so the title keeps its contrast.
  const shade = g.createLinearGradient(0, bandY + bandH * 0.35, 0, bandY + bandH);
  shade.addColorStop(0, 'rgba(20,17,15,0)');
  shade.addColorStop(1, 'rgba(20,17,15,0.82)');
  g.fillStyle = shade;
  g.fillRect(bandX, bandY, bandW, bandH);
  g.restore();

  // The slit's edge is the frame's beat: a hairline that continues past the band.
  const edgeX = bandX + slitW;
  g.fillStyle = ACCENT;
  g.fillRect(Math.min(width - 40, edgeX) - 1, bandY, 2, bandH);

  // Title: rises 14px and fades in between frames 6 and 20.
  const titleT = easeOut((frame - 6) / 14);
  if (titleT > 0) {
    g.globalAlpha = titleT;
    g.fillStyle = PAPER;
    g.font = '700 52px "Archive CJK", sans-serif';
    g.textBaseline = 'alphabetic';
    g.fillText('光的量度', bandX + 22, bandY + bandH - 52 + (1 - titleT) * 14);
    g.globalAlpha = 1;
  }

  // Latin line and caption arrive after the title has settled.
  const subT = easeOut((frame - 16) / 12);
  if (subT > 0) {
    g.globalAlpha = subT;
    g.fillStyle = '#e8b79c';
    g.font = '700 15px "Archive Latin", sans-serif';
    g.letterSpacing = '7px';
    g.fillText('MEASURING LIGHT', bandX + 24, bandY + bandH - 26);
    g.letterSpacing = '0px';
    g.globalAlpha = 1;
  }

  // Header rule + small edition mark, constant from the first frame.
  g.fillStyle = 'rgba(244,239,230,0.55)';
  g.fillRect(bandX, bandY - 16, bandW, 1);
  g.font = '400 11px "Archive Latin", sans-serif';
  g.fillStyle = 'rgba(244,239,230,0.62)';
  g.fillText('VISUAL ARCHIVE / NO. 01', bandX, bandY - 24);

  // Footer: the same venue line as the poster.
  g.font = '400 12px "Archive CJK", sans-serif';
  g.fillStyle = 'rgba(244,239,230,0.5)';
  g.fillText('城市场域光档案 · 2026 秋季展', bandX, height - 26);
  g.textAlign = 'right';
  g.font = '400 11px "Archive Latin", sans-serif';
  g.fillText('10.12 — 11.30', bandX + bandW, height - 26);
  g.textAlign = 'left';

  g.restore();
}
