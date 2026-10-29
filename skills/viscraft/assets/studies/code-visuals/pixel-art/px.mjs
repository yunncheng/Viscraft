// px.mjs — indexed-colour pixel framebuffer (320x180), palette lookup tables and
// an integer-nearest-neighbour presenter with letterboxing.
//
// Adapted from lemo-opuscar styles/pixel-rpg/demo/px.js @ e3cb16f (LemoLab, MIT):
// the palette-index framebuffer, the ENDESGA-32 colour list with protected
// duplicates, the faded lookup table, Bayer dithering and the index→RGBA
// presentation. The fixed ×6 scale is replaced by an integer scale chosen from
// the real capture size; the unused depth tables, mosaic and palette-step
// helpers are not carried.
export const W = 320;
export const H = 180;
export const T = 255; // transparent index

// Master palette: ENDESGA-32 (0-31) plus protected duplicates (32-38).
// The upstream CREDITS calls ENDESGA-32 a public palette used as a colour list;
// this file records the same attribution and makes no separate licence claim.
const HEX = [
  '#be4a2f', '#d77643', '#ead4aa', '#e4a672', '#b86f50', '#733e39', '#3e2731', '#a22633',
  '#e43b44', '#f77622', '#feae34', '#fee761', '#63c74d', '#3e8948', '#265c42', '#193c3e',
  '#124e89', '#0099db', '#2ce8f5', '#ffffff', '#c0cbdc', '#8b9bb4', '#5a6988', '#3a4466',
  '#262b44', '#181425', '#ff0044', '#68386c', '#b55088', '#f6757a', '#e8b796', '#c28569',
  // 32 scarf red, 33 scarf dark, 34 scarf highlight
  // 35 crystal cyan, 36 crystal blue, 37 crystal white, 38 crystal deep
  '#e43b44', '#a22633', '#f6757a', '#2ce8f5', '#0099db', '#ffffff', '#124e89',
];
export const C = {
  rust: 0, clay: 1, sand: 2, tan: 3, brown: 4, dbrown: 5, umber: 6, crimson: 7, red: 8, orange: 9, amber: 10, yellow: 11,
  lime: 12, green: 13, dgreen: 14, teal: 15, navy: 16, blue: 17, cyan: 18, white: 19, silver: 20, steel: 21, slate: 22,
  dslate: 23, night: 24, ink: 25, hot: 26, plum: 27, rose: 28, pink: 29, skin: 30, skinS: 31,
  scarf: 32, scarfD: 33, scarfL: 34, xc: 35, xb: 36, xw: 37, xd: 38,
};
export const NPAL = HEX.length;
export const PROTECT = new Set([32, 33, 34, 35, 36, 37, 38]);
const rgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
export const RGB = HEX.map(rgb);
const lum = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
const pack = ([r, g, b]) => (255 << 24) | (b << 16) | (g << 8) | r;
function lutFrom(fn) {
  const L = new Uint32Array(256);
  for (let i = 0; i < NPAL; i++) L[i] = pack(fn(i));
  return L;
}

export const LUT = {};
LUT.full = lutFrom(i => RGB[i]);
// Loss: a seven-step blue-grey ramp. Protected scarf/crystal indices survive.
export const FADED_RAMP = ['#0e0d17', '#1d2031', '#2d3349', '#434c66', '#646e8a', '#8f99b0', '#c3c9d6'];
const fadedIdx = i => Math.min(6, Math.floor(Math.pow(lum(RGB[i]) / 255, 0.8) * 7.2));
LUT.faded = lutFrom(i => (PROTECT.has(i) ? RGB[i] : rgb(FADED_RAMP[fadedIdx(i)])));

// 4x4 Bayer threshold, used for ordered-dither gradients and the response edge.
const B4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
export const bayer = (x, y) => (B4[(y & 3) * 4 + (x & 3)] + 0.5) / 16;

export function hash(x, y = 0, z = 0) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function vnoise(x) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i) * (1 - u) + hash(i + 1) * u;
}
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const ss = (a, b, x) => {
  if (a === b) return x >= b ? 1 : 0;
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const eio = t => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t));

// 320x180 index framebuffer. Every draw call stamps palette indices; index 255
// is transparent.
export class FB {
  constructor(w = W, h = H) {
    this.w = w;
    this.h = h;
    this.d = new Uint8Array(w * h);
    // clip = [x0, y0, x1, y1] with x1/y1 as EXCLUSIVE end bounds, not width/height.
    this.clip = [0, 0, w, h];
  }
  clear(c = 0) {
    this.d.fill(c);
  }
  px(x, y, c) {
    x |= 0;
    y |= 0;
    const [cx, cy, cw, ch] = this.clip;
    if (x < cx || y < cy || x >= cw || y >= ch || c === T) return;
    this.d[y * this.w + x] = c;
  }
  get(x, y) {
    x |= 0;
    y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return T;
    return this.d[y * this.w + x];
  }
  rect(x, y, w, h, c) {
    x = Math.round(x);
    y = Math.round(y);
    w = Math.round(w);
    h = Math.round(h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x + i, y + j, c);
  }
  hline(x0, x1, y, c) {
    for (let x = Math.round(x0); x <= Math.round(x1); x++) this.px(x, y, c);
  }
  vline(x, y0, y1, c) {
    for (let y = Math.round(y0); y <= Math.round(y1); y++) this.px(x, y, c);
  }
  line(x0, y0, x1, y1, c) {
    x0 = Math.round(x0);
    y0 = Math.round(y0);
    x1 = Math.round(x1);
    y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let e = dx + dy;
    for (;;) {
      this.px(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * e;
      if (e2 >= dy) {
        e += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        e += dx;
        y0 += sy;
      }
    }
  }
  disc(cx, cy, r, c) {
    for (let y = Math.floor(-r); y <= r; y++)
      for (let x = Math.floor(-r); x <= r; x++) if (x * x + y * y <= r * r + r * 0.8) this.px(cx + x, cy + y, c);
  }
  // Ordered-dither fill: f(x,y) returns 0..1 and picks b above the Bayer value.
  dither(x0, y0, w, h, f, a, b) {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const X = x0 + x;
        const Y = y0 + y;
        this.px(X, Y, bayer(X, Y) < f(X, Y) ? b : a);
      }
  }
  // Vertical dithered gradient through a list of palette indices.
  gradV(x0, y0, w, h, cols) {
    const n = cols.length - 1;
    for (let y = 0; y < h; y++) {
      const v = (y / Math.max(1, h - 1)) * n;
      const b = Math.min(n - 1, Math.floor(v));
      const f = v - b;
      for (let x = 0; x < w; x++) this.px(x0 + x, y0 + y, cols[bayer(x0 + x, y0 + y) < f ? b + 1 : b]);
    }
  }
  blit(src, dx, dy, flip = false, map = null) {
    for (let y = 0; y < src.h; y++)
      for (let x = 0; x < src.w; x++) {
        let c = src.d[y * src.w + (flip ? src.w - 1 - x : x)];
        if (c === T) continue;
        if (map) {
          c = map[c];
          if (c === undefined || c === T) continue;
        }
        this.px(dx + x, dy + y, c);
      }
  }
  copy(src, sx, sy, sw, sh, dx, dy) {
    for (let y = 0; y < sh; y++)
      for (let x = 0; x < sw; x++) {
        const c = src.get(sx + x, sy + y);
        if (c !== T) this.px(dx + x, dy + y, c);
      }
  }
}

export function sprFromRows(rows, map) {
  const h = rows.length;
  const w = Math.max(...rows.map(r => r.length));
  const d = new Uint8Array(w * h).fill(T);
  rows.forEach((r, y) => {
    for (let x = 0; x < r.length; x++) {
      const ch = r[x];
      if (ch === '.' || ch === ' ') continue;
      const c = map[ch];
      if (c === undefined) throw new Error(`sprite char ${ch}`);
      d[y * w + x] = c;
    }
  });
  return { w, h, d };
}

/**
 * Present the 320x180 index buffer at the largest INTEGER scale that fits the
 * real capture canvas, centred with a black letterbox. Never interpolates.
 *
 * The caller may use any canvas at least 320x180. 1920x1080 gives ×6,
 * 640x360 gives ×2, and a size such as 1366x768 gives ×4 with bars.
 */
export function makeOut(canvas, viewport) {
  const width = Math.max(1, Math.round(Number(viewport?.width ?? canvas.width)));
  const height = Math.max(1, Math.round(Number(viewport?.height ?? canvas.height)));
  if (width < W || height < H)
    throw new Error(
      `pixel-art needs a canvas of at least ${W}x${H} logical pixels to present an integer scale; got ${width}x${height}`,
    );
  canvas.width = width;
  canvas.height = height;
  const scale = Math.max(1, Math.floor(Math.min(width / W, height / H)));
  const dw = W * scale;
  const dh = H * scale;
  const ox = Math.floor((width - dw) / 2);
  const oy = Math.floor((height - dh) / 2);

  const lo = document.createElement('canvas');
  lo.width = W;
  lo.height = H;
  const g = lo.getContext('2d');
  const img = g.createImageData(W, H);
  const u32 = new Uint32Array(img.data.buffer);
  const o = canvas.getContext('2d');
  if (!o) throw new Error('pixel-art could not acquire a 2D canvas context');
  o.imageSmoothingEnabled = false;

  return {
    width,
    height,
    scale,
    present(fb, lut, lutB = null, pick = null) {
      const d = fb.d;
      if (!lutB) for (let i = 0; i < d.length; i++) u32[i] = lut[d[i]];
      else
        for (let y = 0, i = 0; y < H; y++)
          for (let x = 0; x < W; x++, i++) u32[i] = (pick(x, y) ? lutB : lut)[d[i]];
      g.putImageData(img, 0, 0);
    },
    show() {
      o.fillStyle = '#000000';
      o.fillRect(0, 0, width, height);
      o.imageSmoothingEnabled = false;
      o.drawImage(lo, ox, oy, dw, dh);
    },
  };
}
