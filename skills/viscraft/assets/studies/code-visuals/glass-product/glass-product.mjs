// glass-product.mjs — a reusable "glass product photography" Look module.
//
// Adapted from LemoLab's `lemo-opuscar` glass-product demo (MIT):
//   styles/glass-product/demo/product.js   (fictional product geometry + materials)
//   styles/glass-product/demo/studio.js    (dark-studio strip lighting + PMREM env + mirror floor)
//   styles/glass-product/demo/story.js     (120 BPM shot list / beats — used as a BEAT IDEA only)
//   styles/glass-product/demo/main.js      (per-shot staging + camera + light-pulse logic)
//   commit e3cb16f63768c68693ff0e15171d6e755457cc32 (LemoLab), MIT.
// It is NOT a copy of that demo's story, arc, name, brand, shots or timings. It keeps
// the *mechanism* — a dark studio, clear/frosted glass, strip lighting, a mirror floor,
// a light-guide that pulses from inside, and an exploded-then-reassembled beat — and
// re-authors it as a compact, deterministic, self-contained Viscraft author module.
//
// WHAT IT IS. A stylized dark-studio glass product Look: a fictional stemless lens-glass
// earbud pair in a pebble glass cradle case. A material/lighting reveal, a close detail
// push, and an exploded → snapped-together assembly beat, driven only by the frame clock.
//
// WHAT IT IS NOT. Not a real product, not a brand, not photoreal, and not physically
// accurate optics. A successful technical run proves deterministic execution, not artistic
// approval.
//
// CONTRACT. The page exposes `window.viscraft = { ready, render }`. `render(ctx)` is a
// PURE function of its arguments (plus state `ready` established): it draws ONE frame for
// `ctx.frame` into a `THREE.WebGLRenderer`, sized to `ctx.width × ctx.height`. There is no
// requestAnimationFrame, no wall clock, no `Date.now`, no unseeded randomness, no network.
// The engine (`three@0.186.1`) and the exact addon closure the scene imports are vendored
// byte-for-byte into the project by `create.mjs`; the page resolves the bare `three`
// specifier through an inline import map (the same mechanism the Runtime's own fixtures use).
//
// The module is plain ESM. Its PURE helpers (param validation, beat mapping, the seeded
// hash) run in Node with no DOM, so a test can import this file directly; `createLook()`
// performs the dynamic `three`/addon imports and only runs in a browser page.

// ---------------------------------------------------------------------------
// Look identity, accents and beats (pure; no engine imports)
// ---------------------------------------------------------------------------

export const PRODUCT = 'LUMEN';
// Neutral ice-blue → soft violet accent, used only for the light-guide pulses.
export const ACCENT = { a: '#62dcff', b: '#a98bff' };

// The beats are FRACTIONS of the Look's total duration, so the same module scales to any
// frame count. `--frames N` (and the Source `frames`) set `duration = N / fps` via params.
export const BEATS = [
  { name: 'reveal', from: 0.0, to: 0.22 },
  { name: 'open', from: 0.22, to: 0.44 },
  { name: 'macro', from: 0.44, to: 0.64 },
  { name: 'explode', from: 0.64, to: 0.88 },
  { name: 'hero', from: 0.88, to: 1.0 },
];

export const DEFAULT_PARAMS = {
  duration: 4, // seconds; create.mjs authors frames / fps here
  product: PRODUCT, // metadata only; not drawn in the scene
  accentA: ACCENT.a,
  accentB: ACCENT.b,
  bloom: 0.28, // UnrealBloom strength
  exposure: 1.1, // tone-mapping exposure
  orbit: 1, // camera-orbit multiplier
  explode: 1, // exploded-beat spread multiplier (0 keeps the product whole)
  pulse: 1, // light-guide pulse intensity (0 = lights off)
};

const TAU = Math.PI * 2;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

export const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const seg = (t, a, b) => clamp((t - a) / (b - a));
export const ss = (t) => { t = clamp(t); return t * t * (3 - 2 * t); };
export const eio = (t) => { t = clamp(t); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
export const eo = (t) => 1 - Math.pow(1 - clamp(t), 3);
export const ei = (t) => Math.pow(clamp(t), 3);

/** Deterministic hash in [0,1) keyed by an integer (no Math.random). */
export const hash01 = (n) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** The beat covering normalized time `x ∈ [0,1]`; returns name + local u ∈ [0,1]. */
export function beatAt(x) {
  const clamped = clamp(x);
  for (const beat of BEATS) {
    if (clamped < beat.to || beat === BEATS[BEATS.length - 1]) {
      const span = Math.max(1e-9, beat.to - beat.from);
      return { name: beat.name, u: clamp((clamped - beat.from) / span), from: beat.from, to: beat.to };
    }
  }
  return { name: BEATS[0].name, u: 0, from: 0, to: 1 };
}

function number(value, fallback, label, { min, max } = {}) {
  const v = value === undefined ? fallback : value;
  if (!finite(v)) throw new Error(`glass-product: ${label} must be a finite number`);
  if (min !== undefined && v < min) throw new Error(`glass-product: ${label} must be >= ${min}`);
  if (max !== undefined && v > max) throw new Error(`glass-product: ${label} must be <= ${max}`);
  return v;
}

function colour(value, fallback, label) {
  const v = value === undefined ? fallback : value;
  if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) throw new Error(`glass-product: ${label} must be a #rrggbb colour`);
  return v;
}

/** Validate and fill a Source's `params`; unknown/invalid values fail loudly. */
export function normalizeParams(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('glass-product: params must be an object');
  return {
    duration: number(raw.duration, DEFAULT_PARAMS.duration, 'duration', { min: 1e-3 }),
    product: typeof raw.product === 'string' ? raw.product : DEFAULT_PARAMS.product,
    accentA: colour(raw.accentA, DEFAULT_PARAMS.accentA, 'accentA'),
    accentB: colour(raw.accentB, DEFAULT_PARAMS.accentB, 'accentB'),
    bloom: number(raw.bloom, DEFAULT_PARAMS.bloom, 'bloom', { min: 0, max: 4 }),
    exposure: number(raw.exposure, DEFAULT_PARAMS.exposure, 'exposure', { min: 0, max: 8 }),
    orbit: number(raw.orbit, DEFAULT_PARAMS.orbit, 'orbit'),
    explode: number(raw.explode, DEFAULT_PARAMS.explode, 'explode', { min: 0, max: 2 }),
    pulse: number(raw.pulse, DEFAULT_PARAMS.pulse, 'pulse', { min: 0, max: 8 }),
  };
}

/**
 * The exploded-view offsets for `count` parts, keyed by part index — the deterministic
 * tilt each part takes as it separates (and returns to zero when assembled). Pure.
 */
export function explodeTilt(index) {
  return { x: Math.sin(index * 1.7 + 0.4) * 0.32, z: Math.cos(index * 2.3 + 0.9) * 0.28 };
}

/** The product's part ladder (local Y offset per part), shared by geometry + explode. */
export const BUD_PARTS = [
  { y: 0, off: 40, rot: [0, 0.35, 0.05] }, // front glass dome
  { y: 2.9, off: 31, rot: [0, -0.5, 0] }, // spiral light-guide channels
  { y: 1.5, off: 23, rot: [0.15, 0, 0.1] }, // light ring
  { y: 0.9, off: 15, rot: [0, 0.8, 0] }, // driver unit
  { y: 0, off: 7, rot: [0, 0, 0] }, // titanium belt
  { y: -0.7, off: 0, rot: [0, 0, 0] }, // magnet
  { y: -2, off: -8, rot: [0, -0.7, 0.05] }, // pcb
  { y: -3.4, off: -15, rot: [0, 0.4, 0] }, // battery
  { y: 0, off: -24, rot: [0, -0.3, 0] }, // frosted rear shell
  { y: 0, off: -34, rot: [0, 0.5, 0] }, // silicone tip
];

export const CASE = { rx: 33, rz: 27, hb: 15, hl: 17, pivot: 30 };
export const BUD_CRADLES = [
  { x: -15.5, y: 1.2, z: 0 },
  { x: 15.5, y: 1.2, z: 0 },
];
export const FLOOR_Y = -15;

// ---------------------------------------------------------------------------
// Browser renderer factory (three + vendored addons; dynamic so this file imports
// cleanly in Node for its pure helpers)
// ---------------------------------------------------------------------------

/**
 * Build the Look against a canvas. Resolves the pinned `three` (bare, via the page's
 * import map) and the exact vendored addon closure the scene imports.
 *
 * @param {{ canvas: HTMLCanvasElement }} options
 * @returns {Promise<{ render: (ctx: object) => void, dispose: () => void }>}
 */
export async function createLook({ canvas } = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') throw new Error('glass-product: createLook needs a canvas element');

  // The bare `three` specifier is resolved by the page's inline import map; the addon
  // specifiers are relative to this module, which `create.mjs` vendors beside it.
  const THREE = await import('three');
  const { Reflector } = await import('./vendor/addons/objects/Reflector.js');
  const { RectAreaLightUniformsLib } = await import('./vendor/addons/lights/RectAreaLightUniformsLib.js');
  const { EffectComposer } = await import('./vendor/addons/postprocessing/EffectComposer.js');
  const { UnrealBloomPass } = await import('./vendor/addons/postprocessing/UnrealBloomPass.js');
  const { OutputPass } = await import('./vendor/addons/postprocessing/OutputPass.js');
  const { ShaderPass } = await import('./vendor/addons/postprocessing/ShaderPass.js');
  const { Pass } = await import('./vendor/addons/postprocessing/Pass.js');

  RectAreaLightUniformsLib.init();

  const WHITE = new THREE.Color('#ffffff');

  // --- geometry helpers ----------------------------------------------------
  const lathe = (pts, seg2 = 128) => new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), seg2);
  const smooth = (pts, n = 96) =>
    new THREE.SplineCurve(pts.map(([x, y]) => new THREE.Vector2(x, y))).getSpacedPoints(n).map((v) => [Math.max(0, v.x), v.y]);
  const ell = (rx, ry, a0, a1, n, sgn = 1) => {
    const out = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      out.push([rx * Math.cos(a), sgn * ry * Math.sin(a)]);
    }
    return out;
  };

  // --- materials -----------------------------------------------------------
  const canvasTex = (w, h, draw, srgb = true) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  };
  const brushed = canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#808080';
    g.fillRect(0, 0, w, h);
    let s = 3;
    const R = () => (s = (s * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 700; i++) {
      const r = R() * w * 0.7;
      g.strokeStyle = `rgba(${R() < 0.5 ? 255 : 0},${R() < 0.5 ? 255 : 0},${R() < 0.5 ? 255 : 0},${0.05 + R() * 0.08})`;
      g.lineWidth = 0.6 + R();
      g.beginPath();
      g.arc(w / 2, h / 2, r, 0, 7);
      g.stroke();
    }
  }, false);
  const pcbTex = canvasTex(1024, 1024, (g, w, h) => {
    g.fillStyle = '#15181c';
    g.fillRect(0, 0, w, h);
    let s = 11;
    const R = () => (s = (s * 16807) % 2147483647) / 2147483647;
    g.strokeStyle = '#c9a25a';
    g.lineCap = 'round';
    for (let i = 0; i < 60; i++) {
      let x = w / 2 + (R() - 0.5) * w * 0.8;
      let y = h / 2 + (R() - 0.5) * h * 0.8;
      g.lineWidth = 3 + R() * 5;
      g.beginPath();
      g.moveTo(x, y);
      for (let k = 0; k < 4; k++) {
        const d = 40 + R() * 160;
        const a = Math.floor(R() * 8) * (Math.PI / 4);
        x += Math.cos(a) * d;
        y += Math.sin(a) * d;
        g.lineTo(x, y);
      }
      g.stroke();
      g.fillStyle = '#d8b46a';
      g.beginPath();
      g.arc(x, y, 7 + R() * 5, 0, 7);
      g.fill();
    }
    g.strokeStyle = 'rgba(201,162,90,.8)';
    g.lineWidth = 6;
    g.beginPath();
    g.arc(w / 2, h / 2, w * 0.46, 0, 7);
    g.stroke();
  });

  const glass = (o = {}) =>
    new THREE.MeshPhysicalMaterial(
      Object.assign(
        {
          color: '#ffffff',
          metalness: 0,
          roughness: 0.015,
          transmission: 1,
          thickness: 3,
          ior: 1.52,
          dispersion: 5,
          attenuationColor: new THREE.Color('#f3f8fb'),
          attenuationDistance: 160,
          specularIntensity: 1,
          envMapIntensity: 1.25,
        },
        o,
      ),
    );
  const frosted = (o = {}) =>
    glass(Object.assign({ color: '#eef2f5', transmission: 0.82, roughness: 0.4, thickness: 7, dispersion: 1.5, envMapIntensity: 1.1 }, o));
  const metal = (color, rough, o = {}) =>
    new THREE.MeshPhysicalMaterial(Object.assign({ color, metalness: 1, roughness: rough, envMapIntensity: 1.2 }, o));

  // Light-guide: dark polished acrylic with a comet-pulse emissive flow along uv.x.
  const WHITE_TEX = canvasTex(2, 2, (g) => { g.fillStyle = '#fff'; g.fillRect(0, 0, 2, 2); });
  function guideMat(wrap, accentA, accentB) {
    const m = new THREE.MeshPhysicalMaterial({
      color: '#15181b',
      roughness: 0.08,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.05,
      emissive: '#ffffff',
      emissiveMap: WHITE_TEX,
      envMapIntensity: 1.4,
    });
    const U = {
      uP: { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, 0.1, 0, 0)) },
      uBase: { value: 0.02 },
      uA: { value: new THREE.Color(accentA) },
      uB: { value: new THREE.Color(accentB) },
      uWrap: { value: wrap ? 1 : 0 },
    };
    m.userData.U = U;
    guideTargets.push(U);
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      sh.fragmentShader = sh.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
      uniform vec4 uP[8]; uniform float uBase, uWrap; uniform vec3 uA, uB;`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `{
        float x = vEmissiveMapUv.x; vec3 acc = uA * uBase;
        for (int i = 0; i < 8; i++) { vec4 P = uP[i]; if (P.z <= 0.) continue;
          float d = x - P.x; if (uWrap > .5) d = fract(d + .5) - .5;
          float w = abs(P.y), s = sign(P.y + 1e-6), a = d * s;
          float head = exp(-a * a / (w * w * .25)), tail = a < 0. ? exp(a / (w * 4.)) * .55 : 0.;
          float k = max(head, tail);
          acc += (mix(uA, uB, P.w + (1. - head) * .25) * k + vec3(head * head * head * .35)) * P.z; }
        totalEmissiveRadiance = acc; }`,
        );
    };
    m.customProgramCacheKey = () => 'gp-guide' + (wrap ? 1 : 0) + accentA + accentB;
    return m;
  }
  function setPulses(mat, list, base = 0.02) {
    const U = mat.userData.U;
    U.uBase.value = base;
    for (let i = 0; i < 8; i++) {
      const p = list[i];
      U.uP.value[i].set(p ? p.p : 0, p ? p.w : 0.1, p ? p.a : 0, p ? p.h : 0);
    }
  }

  // --- product: the lens-glass bud ----------------------------------------
  let GUIDE_A = ACCENT.a;
  const guideTargets = [];
  const glowLights = [];
  let GUIDE_B = ACCENT.b;
  function buildBud(side) {
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    const parts = [];
    const add = (obj, y, off, rot = [0, 0, 0]) => {
      const g = new THREE.Group();
      g.add(obj);
      g.position.y = y;
      body.add(g);
      parts.push({ g, y, off, rot });
      return g;
    };

    // front glass dome
    const front = new THREE.Mesh(lathe([[10, 0], ...ell(10, 5.2, 0, Math.PI / 2, 48).slice(1)]), glass({ thickness: 4.5, side: THREE.DoubleSide }));
    add(front, 0, 40, [0, 0.35, 0.05]);
    // spiral light-guide channels under the dome
    const spiral = new THREE.Group();
    const spMat = guideMat(false, GUIDE_A, GUIDE_B);
    for (let k = 0; k < 6; k++) {
      const pts = [];
      for (let i = 0; i <= 60; i++) {
        const u = i / 60;
        const r = 1.6 + u * 5.6;
        const a = (k * Math.PI) / 3 + u * 2.2 * side;
        pts.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(u * Math.PI) * 0.25, Math.sin(a) * r));
      }
      spiral.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 120, 0.13, 8), spMat));
    }
    const hub = new THREE.Mesh(new THREE.SphereGeometry(1.2, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), metal('#e6e9ec', 0.05));
    hub.scale.y = 0.5;
    spiral.add(hub);
    add(spiral, 2.9, 31, [0, -0.5, 0]);
    // light ring
    const ringMat = guideMat(true, GUIDE_A, GUIDE_B);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(7.5, 0.8, 32, 160), ringMat);
    ring.rotation.x = Math.PI / 2;
    add(ring, 1.5, 23, [0.15, 0, 0.1]);
    // driver: concentric diaphragm + basket
    const drv = new THREE.Group();
    const rip = [];
    for (let i = 0; i <= 60; i++) {
      const r = 5.8 * (1 - i / 60);
      rip.push([r, 0.12 * Math.sin(i * 0.9) * (1 - i / 60) + (i > 44 ? (i - 44) * 0.045 : 0)]);
    }
    const diaph = new THREE.Mesh(lathe(rip.slice().reverse()), metal('#c8c2b8', 0.22, { roughnessMap: brushed, side: THREE.DoubleSide }));
    drv.add(diaph);
    const basket = new THREE.Mesh(new THREE.CylinderGeometry(6.1, 5.4, 1.2, 96, 1, true), metal('#9aa0a6', 0.3, { side: THREE.DoubleSide }));
    basket.position.y = -0.6;
    drv.add(basket);
    add(drv, 0.9, 15, [0, 0.8, 0]);
    // titanium belt
    const band = new THREE.Mesh(new THREE.TorusGeometry(10, 0.42, 24, 180), metal('#d4d7db', 0.16));
    band.rotation.x = Math.PI / 2;
    band.scale.z = 0.75;
    add(band, 0, 7, [0, 0, 0]);
    // magnet
    add(new THREE.Mesh(new THREE.CylinderGeometry(2.8, 2.8, 1.5, 64), metal('#e8eaec', 0.14)), -0.7, 0, [0, 0, 0]);
    // pcb + components
    const pcb = new THREE.Group();
    const board = new THREE.Mesh(
      new THREE.CylinderGeometry(6.9, 6.9, 0.5, 96),
      new THREE.MeshPhysicalMaterial({ color: '#ffffff', map: pcbTex, roughness: 0.45, metalness: 0.35, clearcoat: 0.6, clearcoatRoughness: 0.3 }),
    );
    pcb.add(board);
    let s = 5;
    const R = () => (s = (s * 16807) % 2147483647) / 2147483647;
    const chipM = new THREE.MeshPhysicalMaterial({ color: '#0b0c0e', roughness: 0.35 });
    const capM = metal('#b88b4a', 0.3);
    for (let i = 0; i < 16; i++) {
      const a = R() * 6.28;
      const r = 1.5 + R() * 4.2;
      const big = i < 3;
      const c = new THREE.Mesh(
        new THREE.BoxGeometry(big ? 2.2 : 0.6 + R() * 0.6, big ? 0.5 : 0.35, big ? 2.2 : 0.35 + R() * 0.3),
        big ? chipM : capM,
      );
      c.position.set(Math.cos(a) * r, 0.4, Math.sin(a) * r);
      c.rotation.y = R() * 3;
      pcb.add(c);
    }
    add(pcb, -2, -8, [0, -0.7, 0.05]);
    // battery button
    add(new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.2, 2.2, 96), metal('#b9bec4', 0.28, { roughnessMap: brushed })), -3.4, -15, [0, 0.4, 0]);
    // frosted rear shell + grill
    const rear = [[0, -9.6], [2.3, -9.6], [2.75, -9.2], [2.8, -6.8], [3.1, -5.9], [3.9, -5.15], ...ell(10, 5.2, Math.asin(0.97), 0, 40, -1).slice(1)];
    const back = new THREE.Mesh(lathe(smooth(rear, 120)), frosted({ side: THREE.DoubleSide }));
    const backGroup = add(back, 0, -24, [0, -0.3, 0]);
    const grill = new THREE.Mesh(new THREE.CircleGeometry(2.1, 48), metal('#8d9399', 0.4));
    grill.rotation.x = Math.PI / 2;
    grill.position.y = -9.62;
    backGroup.add(grill);
    // silicone tip
    const tipP = [[2.85, -7.2], [3.05, -7.6], [4.6, -8.6], [5.5, -10.2], [5.4, -11.6], [4.7, -12.6], [3.2, -12.9], [2.3, -12.7], [2.2, -12.2], [2.5, -12.0], [2.7, -8]];
    const tip = new THREE.Mesh(
      lathe(smooth(tipP, 80)),
      new THREE.MeshPhysicalMaterial({ color: '#c9d0d6', roughness: 0.62, sheen: 1, sheenRoughness: 0.45, sheenColor: '#ffffff', envMapIntensity: 1.8 }),
    );
    add(tip, 0, -34, [0, 0.5, 0]);

    // interior light that brightens the metal parts when the guide pulses
    const glow = new THREE.PointLight(ACCENT.a, 0, 40, 2);
    glow.position.y = 1.5;
    body.add(glow);
    glowLights.push(glow);

    root.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
    return { root, body, parts, ring: ringMat, spiral: spMat, glow, side };
  }
  function explodeBud(bud, e, spin = 0) {
    for (let i = 0; i < bud.parts.length; i++) {
      const p = bud.parts[i];
      p.g.position.y = p.y + p.off * e;
      const tilt = explodeTilt(i);
      p.g.rotation.set((p.rot[0] + tilt.x) * e, p.rot[1] * e + spin * p.off * 0.004 * e, (p.rot[2] + tilt.z) * e);
    }
  }

  // --- product: the pebble cradle case ------------------------------------
  function buildCase() {
    const root = new THREE.Group();
    const { rx, rz, hb, hl } = CASE;
    const baseP = [[0, -hb], [rx * 0.55, -hb], ...ell(rx, hb, -Math.acos(0.62), 0, 40).slice(1)];
    const base = new THREE.Mesh(lathe(baseP, 160), frosted({ thickness: 14, side: THREE.DoubleSide, roughness: 0.42, transmission: 0.9 }));
    base.scale.z = rz / rx;
    root.add(base);
    // deck: graphite satin with two plated cradle rings
    const shape = new THREE.Shape();
    shape.absellipse(0, 0, rx - 0.6, rz - 0.6, 0, Math.PI * 2);
    for (const x of [-15.5, 15.5]) {
      const h = new THREE.Path();
      h.absarc(x, 0, 10.6, 0, Math.PI * 2, true);
      shape.holes.push(h);
    }
    const deck = new THREE.Mesh(
      new THREE.ShapeGeometry(shape, 96),
      new THREE.MeshPhysicalMaterial({ color: '#16181b', roughness: 0.38, metalness: 0.6, clearcoat: 0.4, clearcoatRoughness: 0.25, side: THREE.DoubleSide }),
    );
    deck.rotation.x = -Math.PI / 2;
    deck.position.y = -0.05;
    root.add(deck);
    for (const x of [-15.5, 15.5]) {
      const t = new THREE.Mesh(new THREE.TorusGeometry(10.7, 0.35, 16, 128), metal('#dfe2e6', 0.08));
      t.rotation.x = Math.PI / 2;
      t.position.set(x, 0, 0);
      root.add(t);
    }
    // charging light edge (light-guide line along the deck rim)
    const edgeMat = guideMat(true, GUIDE_A, GUIDE_B);
    const ep = [];
    for (let i = 0; i <= 200; i++) {
      const a = (i / 200) * Math.PI * 2;
      ep.push(new THREE.Vector3(Math.cos(a) * (rx - 2.2), 0.1, Math.sin(a) * (rz - 2.2)));
    }
    const edge = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(ep, true), 400, 0.22, 8, true), edgeMat);
    root.add(edge);
    // hinged transparent lid that stands up behind the case
    const lidPivot = new THREE.Group();
    lidPivot.position.set(0, 0, -rz);
    root.add(lidPivot);
    const lid = new THREE.Mesh(lathe(ell(rx, hl, 0, Math.PI / 2, 48), 160), glass({ thickness: 1.6, side: THREE.DoubleSide, dispersion: 4 }));
    lid.scale.z = rz / rx;
    lid.position.z = rz;
    lidPivot.add(lid);
    const lidRim = new THREE.Mesh(new THREE.TorusGeometry(rx, 0.45, 16, 200), metal('#d9dce0', 0.12));
    lidRim.rotation.x = Math.PI / 2;
    lidRim.scale.y = rz / rx;
    lidRim.position.set(0, 0.2, rz);
    lidPivot.add(lidRim);
    const hinge = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 18, 48), metal('#eceef0', 0.08));
    hinge.rotation.z = Math.PI / 2;
    hinge.position.set(0, 0.4, -rz + 0.6);
    root.add(hinge);
    // inner glow disc + fill light (the "charging" soft light through frosted glass)
    const glowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#dff3ff') });
    const glowDisc = new THREE.Mesh(new THREE.CircleGeometry(1, 96), glowMat);
    glowDisc.rotation.x = -Math.PI / 2;
    glowDisc.scale.set(rx * 0.62, rz * 0.62, 1);
    glowDisc.position.y = -hb + 2.2;
    root.add(glowDisc);
    const inner = new THREE.PointLight('#e2f4ff', 0, 60, 2);
    inner.position.set(0, -7, 0);
    root.add(inner);
    root.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
    const setGlow = (I) => {
      glowMat.color.set('#dff3ff').multiplyScalar(I * 1.6);
      inner.intensity = I * 14;
      glowDisc.visible = I > 0.001;
    };
    setGlow(0);
    return { root, lidPivot, setGlow, edge: edgeMat };
  }

  // --- studio --------------------------------------------------------------
  function makeStudio(scene) {
    // strip-light scene used only to bake the per-frame environment map
    const env = new THREE.Scene();
    env.background = new THREE.Color('#000000');
    const strip = (w, h, I, col = '#ffffff') => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(col).multiplyScalar(I), side: THREE.DoubleSide }));
      env.add(m);
      return m;
    };
    const face = (m, p) => { m.position.set(p[0], p[1], p[2]); m.lookAt(0, 0, 0); };
    const L = {
      left: strip(22, 170, 3.2, '#f4f8ff'),
      right: strip(22, 170, 3.2, '#fffaf2'),
      top: strip(160, 70, 1.1, '#ffffff'),
      front: strip(160, 50, 0.18, '#ffffff'),
      back: strip(260, 14, 1.4, '#e8f0ff'),
      sweep: strip(26, 240, 0, '#ffffff'),
      aura: strip(140, 140, 0, GUIDE_A),
      key: strip(150, 60, 2.5, '#ffffff'),
    };
    face(L.left, [-150, 40, -60]);
    face(L.right, [150, 40, -70]);
    face(L.top, [0, 170, 10]);
    face(L.front, [0, 10, 170]);
    face(L.back, [0, 20, -190]);
    face(L.aura, [0, -60, 120]);
    face(L.key, [0, 150, 120]);
    const base = { left: 3.2, right: 3.2, top: 1.1, front: 0.18, back: 1.4, key: 2.5 };
    const cols = {};
    for (const k in L) cols[k] = L[k].material.color.clone().multiplyScalar(1 / Math.max(0.001, base[k] ?? 1));

    // dark radial studio sweep background
    const bgc = document.createElement('canvas');
    bgc.width = 512;
    bgc.height = 288;
    {
      const g = bgc.getContext('2d');
      const gr = g.createRadialGradient(256, 120, 10, 256, 140, 300);
      gr.addColorStop(0, '#34383d');
      gr.addColorStop(0.45, '#16181b');
      gr.addColorStop(1, '#000000');
      g.fillStyle = gr;
      g.fillRect(0, 0, 512, 288);
    }
    const bgTex = new THREE.CanvasTexture(bgc);
    bgTex.colorSpace = THREE.SRGBColorSpace;
    scene.background = bgTex;
    scene.backgroundIntensity = 0;

    const pmrem = new THREE.PMREMGenerator(renderer);
    let envRT = null;
    function updateEnv(o = {}) {
      for (const k in base) {
        const I = (o[k] ?? 1) * base[k];
        L[k].material.color.copy(cols[k]).multiplyScalar(I);
      }
      const sw = o.sweep || { I: 0 };
      L.sweep.visible = sw.I > 0;
      if (sw.I > 0) {
        const a = (sw.az || 0) + sw.x * 1.35;
        const r = 170;
        L.sweep.position.set(Math.sin(a) * r, 30 + (sw.y || 0), Math.cos(a) * r);
        L.sweep.lookAt(0, 0, 0);
        L.sweep.rotateZ(sw.tilt || 0);
        L.sweep.material.color.setRGB(sw.I, sw.I, sw.I);
      }
      const au = o.aura || { I: 0 };
      L.aura.visible = au.I > 0;
      if (au.I > 0) L.aura.material.color.copy(au.col).multiplyScalar(au.I);
      const rt = pmrem.fromScene(env, 0, 1, 1000);
      scene.environment = rt.texture;
      if (envRT) envRT.dispose();
      envRT = rt;
    }

    // mirror floor: blurred reflection + radial fade (no caustics/waves)
    const floorShader = {
      name: 'GlassFloor',
      uniforms: {
        color: { value: null },
        tDiffuse: { value: null },
        textureMatrix: { value: null },
        uRefl: { value: 0.34 },
        uFade: { value: 300 },
        uCenter: { value: new THREE.Vector2(0, 0) },
      },
      vertexShader: `uniform mat4 textureMatrix; varying vec4 vUv; varying vec3 vW;
        void main(){ vUv = textureMatrix * vec4(position, 1.); vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `uniform sampler2D tDiffuse; uniform float uRefl, uFade; uniform vec2 uCenter;
        varying vec4 vUv; varying vec3 vW;
        void main(){
          vec3 refl = vec3(0.); float sum = 0.;
          for (int i = 0; i < 8; i++) { float a = float(i) * 2.39996; float rr = sqrt((float(i) + .5) / 8.) * 3.5;
            vec4 uv = vUv + vec4(cos(a) * rr, sin(a) * rr, 0., 0.) * vUv.w / 700.; refl += texture2DProj(tDiffuse, uv).rgb; sum += 1.; }
          refl /= sum;
          float r0 = length(vW.xz - uCenter);
          float fade = exp(-r0 * r0 / (uFade * uFade));
          vec3 col = refl * uRefl * fade + vec3(.02, .02, .021) * exp(-r0 * r0 / 9000.);
          gl_FragColor = vec4(col, 1.);
        }`,
    };
    const floor = new Reflector(new THREE.PlaneGeometry(2000, 2000), { shader: floorShader, textureWidth: 1024, textureHeight: 576, clipBias: 0.002, multisample: 4 });
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = FLOOR_Y;
    scene.add(floor);
    // update the mirror only once per frame (manual), so the transmission pre-pass does not
    // re-render it and the reflection always uses the CURRENT frame's matrices
    const reflUpdate = floor.onBeforeRender.bind(floor);
    floor.onBeforeRender = () => {};
    const U = floor.material.uniforms;
    return {
      env,
      L,
      updateEnv,
      floor,
      U,
      reflect(camera) {
        reflUpdate(renderer, scene, camera);
      },
    };
  }

  // --- renderer / scene / camera / post -----------------------------------
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = DEFAULT_PARAMS.exposure;
  renderer.setClearColor(0x000000, 1);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#000000');
  const camera = new THREE.PerspectiveCamera(28, 16 / 9, 1, 3000);

  const studio = makeStudio(scene);
  const box = buildCase();
  scene.add(box.root);
  const buds = [buildBud(-1), buildBud(1)];
  buds.forEach((b) => scene.add(b.root));

  const topBox = new THREE.RectAreaLight('#ffffff', 0, 90, 40);
  scene.add(topBox);

  // a small custom Pass that renders the scene+camera into the composer's write buffer
  // (avoids importing RenderPass, keeping the vendored addon closure to the audited set)
  class ScenePass extends Pass {
    constructor(scene2, camera2) {
      super();
      this.scene = scene2;
      this.camera = camera2;
      this.needsSwap = false;
    }
    render(r, writeBuffer, readBuffer) {
      // Render the beauty pass into the READ buffer with no swap, exactly like the
      // built-in RenderPass: the following (bloom) pass then reads it from readBuffer.
      const oldAutoClear = r.autoClear;
      r.autoClear = false;
      r.setRenderTarget(this.renderToScreen ? null : readBuffer);
      r.clear(r.autoClearColor, r.autoClearDepth, r.autoClearStencil);
      r.render(this.scene, this.camera);
      r.autoClear = oldAutoClear;
    }
  }

  const vignetteShader = {
    uniforms: { tDiffuse: { value: null }, amt: { value: 0.32 }, contrast: { value: 0.1 }, sat: { value: 1.02 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
    fragmentShader: `varying vec2 vUv; uniform sampler2D tDiffuse; uniform float amt, contrast, sat;
      void main(){ vec4 c = texture2D(tDiffuse, vUv); vec2 d = vUv - .5; d.x *= 1.25; float v = 1. - amt * smoothstep(.25, .85, length(d));
        c.rgb *= v; float l = dot(c.rgb, vec3(.2126, .7152, .0722)); c.rgb = mix(vec3(l), c.rgb, sat);
        c.rgb = c.rgb * (1. + contrast) / (1. + contrast * c.rgb / (c.rgb + .6));
        gl_FragColor = c; }`,
  };

  const composer = new EffectComposer(renderer);
  const scenePass = new ScenePass(scene, camera);
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.28, 0.5, 1.1);
  const vig = new ShaderPass(vignetteShader);
  const out = new OutputPass();
  composer.addPass(scenePass);
  composer.addPass(bloom);
  composer.addPass(vig);
  composer.addPass(out);

  // --- per-beat state (pure function of t) --------------------------------
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const Y = V(0, 1, 0);
  const pose = (bud, pos, dir, roll = 0) => {
    bud.root.position.copy(pos);
    bud.root.quaternion.setFromUnitVectors(Y, dir.clone().normalize());
    bud.root.rotateY(roll);
  };
  const cradle = (i) => V(BUD_CRADLES[i].x, BUD_CRADLES[i].y, BUD_CRADLES[i].z);
  const LID_OPEN = 1.72;
  const EXPLODE_BEAT = BEATS.find((b) => b.name === 'explode');
  const SNAP_U = 0.78; // within the explode beat: spread → hover → snap at u = SNAP_U
  const SNAP_T = EXPLODE_BEAT.from + SNAP_U * (EXPLODE_BEAT.to - EXPLODE_BEAT.from);

  function budLight(bud, t, mode, snapT, pulse) {
    const ring = [];
    const sp = [];
    let base = 0;
    let flash = 0;
    if (mode === 1) base = 0.008 + 0.012 * (0.5 + 0.5 * Math.sin(t * 2.4));
    if (mode >= 2) {
      const dt = Math.max(0, t - snapT);
      const A = 12 * pulse * Math.exp(-dt / 0.55);
      const off = bud.side > 0 ? 0 : 0.5;
      ring.push({ p: 0.25 + off + dt * 0.6, w: 0.03, a: A, h: clamp(dt * 1.1) }, { p: 0.25 + off - dt * 0.6, w: -0.03, a: A, h: clamp(dt * 1.1) });
      sp.push({ p: (dt / 0.42) % 1, w: 0.05, a: A, h: clamp(dt * 1.4) });
      flash += 1.4 * Math.exp(-dt / 0.12);
      base = 0.015 + flash * 0.05;
    }
    if (mode === 3) {
      const ph = t * 0.22 + (bud.side > 0 ? 0 : 0.5);
      ring.push({ p: ph, w: 0.035, a: 9 * pulse, h: 0.15 }, { p: ph + 0.5, w: 0.035, a: 9 * pulse, h: 0.8 });
      sp.push({ p: (t * 0.7) % 1.3, w: 0.06, a: 6 * pulse, h: 0.4 });
      base = 0.04 + flash * 0.35;
    }
    setPulses(bud.ring, ring, base);
    setPulses(bud.spiral, sp, mode >= 2 ? 0.008 + flash * 0.04 : base * 0.5);
    bud.glow.intensity = mode >= 2 ? 6 + flash * 90 : 0;
    bud.glow.color.copy(new THREE.Color(GUIDE_A)).lerp(new THREE.Color(GUIDE_B), clamp(flash * 0.5)).lerp(WHITE, 0.35);
  }

  /**
   * Advance the whole Look to time `t` (seconds) of a `duration`-second piece. Sets the
   * scene, camera, lights, lid, explode and pulses; it starts from a fixed staging and
   * derives everything from (t, duration), so frame N is independent of sampling order.
   */
  function stage(t, duration, params, seed) {
    const x = duration > 0 ? t / duration : 1;
    const beat = beatAt(x);
    const u = beat.u;
    const orbit = params.orbit;
    const spinPhase = t * orbit;

    let pos = V(0, 30, 160);
    let look = V(0, 10, 0);
    let fov = 28;
    const envO = { left: 1, right: 1, top: 1, front: 1, back: 1, key: 0 };
    let bg = 0;
    let glowI = 0;
    let topI = 0;
    let topAt = null;
    let sweep = null;
    let lid = 0;
    let caseVis = true;
    const modes = [0, 0];
    const vis = [1, 1];
    let bloomStrength = params.bloom;

    // every frame starts from the product docked in its cradles
    pose(buds[0], cradle(0), Y, 0.4);
    pose(buds[1], cradle(1), Y, -0.3);
    explodeBud(buds[0], 0);
    explodeBud(buds[1], 0);

    switch (beat.name) {
      case 'reveal': {
        envO.left = 0.07;
        envO.right = 0.07;
        envO.top = 0.03;
        envO.front = 0;
        envO.back = 0.12;
        const s1 = seg(u, 0, 0.45);
        const s2 = seg(u, 0.5, 0.95);
        if (u < 0.45) sweep = { x: lerp(-1, 1, s1), I: 7 * Math.sin(s1 * Math.PI) };
        else sweep = { x: lerp(1, -1, s2), I: 7 * Math.sin(s2 * Math.PI), tilt: 0.25 };
        pos = V(-68, 5, 116).lerp(V(-60, 3, 104), eio(u));
        look = V(0, 10, 0);
        fov = 30;
        modes[0] = modes[1] = 1;
        break;
      }
      case 'open': {
        lid = eio(u) * LID_OPEN;
        glowI = 0.15 * ss(u);
        bg = 0.25;
        const az = lerp(0.45, 0.8, eio(u));
        const el = 0.42;
        const d = 200;
        pos = V(Math.sin(az) * Math.cos(el) * d, Math.sin(el) * d, Math.cos(az) * Math.cos(el) * d);
        look = V(-2, 10, -8);
        fov = 27;
        modes[0] = modes[1] = 1;
        break;
      }
      case 'macro': {
        lid = LID_OPEN;
        glowI = 0.15;
        const lu = eio(u);
        const p = cradle(1).add(V(0, 18 * lu, 0));
        pose(buds[1], p, V(-0.25 * lu, 1, 0.35 * lu), -0.3 + lu * 0.6);
        const c = p.clone();
        pos = c.clone().add(V(-30, 22, 34).lerp(V(-22, 16, 30), eio(u)));
        look = c.clone().add(V(-1, 2, 1));
        fov = 30;
        modes[0] = modes[1] = 1;
        break;
      }
      case 'explode': {
        caseVis = false;
        vis[0] = 0;
        vis[1] = 1;
        envO.left = 1.4;
        envO.right = 1.4;
        envO.top = 1.5;
        envO.front = 0.6;
        envO.back = 1.6;
        envO.key = 1.3;
        bg = 0.9;
        const p = V(0, 20, 0);
        const A0 = 0.35;
        const toC = V(Math.sin(A0), 0, Math.cos(A0));
        const side = V(Math.cos(A0), 0, -Math.sin(A0));
        const dir = toC.clone().multiplyScalar(Math.cos(0.7)).addScaledVector(side, -Math.sin(0.7)).add(V(0, 0.22, 0)).normalize();
        let e;
        const snapU = SNAP_U; // spread → hover → snap within this beat
        if (u < snapU - 0.12) e = eo(seg(u, 0, snapU - 0.12)) * params.explode;
        else if (u < snapU - 0.03) e = (params.explode) * (1 + 0.03 * seg(u, snapU - 0.12, snapU - 0.03));
        else if (u < snapU) e = params.explode * 1.03 * (1 - ei(seg(u, snapU - 0.03, snapU)));
        else e = 0;
        pose(buds[1], p, dir, 0.3);
        explodeBud(buds[1], e, (t - duration * beat.from) * 1.4);
        const az = lerp(0.26, 0.44, eio(u));
        const d = lerp(94, 86, eio(u));
        const push = eo(seg(u, snapU, snapU + 0.6));
        pos = p.clone().add(V(Math.sin(az) * (d - 40 * push), 12 - 4 * push, Math.cos(az) * (d - 40 * push)));
        look = p.clone().addScaledVector(dir, 3 * e).add(V(0, -1, 0));
        fov = 34;
        topI = 5;
        topAt = p;
        if (u >= snapU) {
          const k = Math.exp(-(u - snapU) / 0.08);
          const fr = Math.floor(t * 24);
          pos.add(V(hash01(fr) - 0.5, hash01(fr + 9) - 0.5, 0).multiplyScalar(k * 2.2));
          modes[1] = 2;
        }
        modes[0] = 0;
        break;
      }
      case 'hero':
      default: {
        lid = LID_OPEN;
        const su = eio(u);
        const w = u;
        const az = lerp(-0.26, -0.06, eio(w));
        const el = lerp(0.2, 0.28, eio(w));
        const d = lerp(228, 244, w) + 26 * su;
        pos = V(Math.sin(az) * Math.cos(el) * d, Math.sin(el) * d, Math.cos(az) * Math.cos(el) * d);
        look = V(0, lerp(31, 26, su), -6);
        fov = 27;
        [0, 1].forEach((i) => {
          const bp = cradle(i);
          const toC = pos.clone().sub(bp).normalize();
          const dir = V(0, 1, 0).multiplyScalar(0.7).addScaledVector(toC, 0.75).add(V(i ? 0.12 : -0.12, 0, 0)).normalize().lerp(Y, su);
          pose(buds[i], bp, dir, i ? -0.3 : 0.4);
        });
        glowI = 0.35 + 0.65 * ss(seg(u, 0.5, 0.9));
        bg = 1.1;
        envO.back = 2.6;
        envO.left = 1.3;
        envO.right = 1.3;
        envO.front = 0;
        envO.top = 1.5;
        const s = seg(u, 0, 0.4);
        if (u < 0.4) sweep = { x: lerp(-1, 1, s), I: 6 * Math.sin(s * Math.PI) };
        modes[0] = modes[1] = 3;
        bloomStrength = params.bloom + 0.06;
        break;
      }
    }

    box.root.visible = caseVis;
    buds.forEach((b, i) => { b.root.visible = !!vis[i]; });
    box.lidPivot.rotation.x = -lid;
    box.setGlow(glowI);
    scene.backgroundIntensity = bg;
    topBox.intensity = topI;
    if (topAt) {
      topBox.position.copy(topAt).add(V(0, 60, 30));
      topBox.lookAt(topAt);
    }

    let fl = 0;
    const snapT = duration * SNAP_T;
    for (let i = 0; i < buds.length; i++) {
      budLight(buds[i], t, modes[i], snapT, params.pulse);
      if (buds[i].root.visible) fl += 1;
    }
    // case edge light: dim charge during open, brighter as the pair settles home
    const caseGlow = beat.name === 'reveal' ? 0 : beat.name === 'open' ? ss(u) * 0.3 : beat.name === 'hero' ? 0.5 + 0.5 * ss(u) : 0.3;
    setPulses(box.edge, [], 0.02 + 0.08 * caseGlow);

    camera.position.copy(pos);
    camera.fov = fov;
    camera.lookAt(look);

    const caz = Math.atan2(camera.position.x, camera.position.z);
    if (sweep) sweep.az = caz + Math.PI;
    studio.updateEnv(Object.assign(envO, { sweep: sweep || { I: 0 }, aura: { I: caseVis ? 0 : fl * 0.9, col: new THREE.Color(GUIDE_A) } }));
    bloom.strength = bloomStrength;
    return beat.name;
  }

  const look = {
    render(ctx = {}) {
      const params = normalizeParams(ctx.params ?? {});
      // `accentA`/`accentB` are authored per Source; the guide materials and
      // interior glow are built once, so their live values are updated here
      // (a changed uniform does not recompile the shader).
      if (params.accentA !== GUIDE_A || params.accentB !== GUIDE_B) {
        GUIDE_A = params.accentA;
        GUIDE_B = params.accentB;
        for (const U of guideTargets) {
          U.uA.value.set(GUIDE_A);
          U.uB.value.set(GUIDE_B);
        }
        for (const light of glowLights) light.color.set(GUIDE_A);
      }
      const w = Math.max(1, Math.floor(ctx.width ?? canvas.width));
      const h = Math.max(1, Math.floor(ctx.height ?? canvas.height));
      const fps = finite(ctx.fps) && ctx.fps > 0 ? ctx.fps : 24;
      const frame = Number.isFinite(ctx.frame) ? ctx.frame : 0;
      const seed = finite(ctx.seed) ? ctx.seed : 0;
      const t = frame / fps;

      renderer.setSize(w, h, false);
      composer.setSize(w, h);
      camera.aspect = w / h;
      renderer.toneMappingExposure = params.exposure;

      stage(t, params.duration, params, seed);

      scene.updateMatrixWorld();
      camera.updateMatrixWorld();
      camera.updateProjectionMatrix();
      studio.reflect(camera);
      composer.render();
    },
    dispose() {
      try {
        composer.dispose?.();
        renderer.dispose();
      } catch {
        /* best effort */
      }
    },
  };
  return look;
}
