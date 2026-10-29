/**
 * Riso print compositor (WebGL2).
 *
 * Input: ONE packed RGB separation canvas — R = blue plate density,
 * G = yellow plate density, B = pink plate density (0 = no ink, 255 = solid).
 * Output: three spot inks multiplied onto a warm paper, each plate with its own
 * registration offset and micro-rotation, halftone screen angle, ink grain,
 * roller-sweep reveal, and plate gate (a plate can be absent or only partly
 * inked). Paper fibre and per-sheet ink variation are generated here.
 *
 * The drawing side in draw.mjs owns knockout (`source-over`) and overprint
 * (`lighter` into selected channels); this shader only separates and prints the
 * three channels. Adapted from lemo-opuscar
 * styles/risograph/demo/riso.js@e3cb16f63768c68693ff0e15171d6e755457cc32
 * (LemoLab, MIT).
 */
export const INK = {
  blue: [0, 120, 191],
  yellow: [255, 232, 0],
  pink: [255, 72, 176],
};
export const PAPER = [246, 241, 230];

const VERTEX = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0., 1.); }`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uRes;
uniform vec2 uOff[3];      // per-plate registration offset (px)
uniform float uRot[3];     // per-plate micro-rotation (rad, about the centre)
uniform float uAng[3];     // halftone screen angle
uniform vec3 uInk[3];
uniform vec3 uPaper;
uniform float uSeed;       // ink-grain seed; advances on twos (12 fps boil)
uniform float uBoil;       // fraction of grain that re-rolls with the seed
uniform float uSheet;      // per-sheet ink variation (streaks/tone); changes per shot
uniform float uPeriod;     // halftone period in px
uniform float uGate[3];    // is the plate on press? 0..1
uniform float uSweep[3];   // roller reveal: ink has reached this x (px)
uniform float uGrain;
uniform float uWaterY;     // river surface (px, canvas coordinates); < 0 = no water
uniform float uWaterAmp;
uniform float uWaterT;
uniform float uWaterSep;
uniform float uRefl;
uniform float uWaterB;
out vec4 o;

float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float h21s(vec2 p, float s) { return h21(p + s * 17.13); }
float vn(vec2 p, float s) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3. - 2. * f);
  float a = h21s(i, s), b = h21s(i + vec2(1, 0), s), c = h21s(i + vec2(0, 1), s), d = h21s(i + vec2(1, 1), s);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
vec2 rot(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }

float dens(int i, vec2 px) {
  vec2 q = rot(px - uRes * .5, uRot[i]) + uRes * .5 - uOff[i];
  float d = texture(uTex, q / uRes)[i];
  if (uWaterY > 0. && q.y > uWaterY && q.y < uWaterB) {
    // River reflection: mirror about the surface; a per-plate phase separates the inks.
    float fi = float(i);
    float yy = 2. * uWaterY - q.y;
    float depth = (q.y - uWaterY);
    float w = sin(q.y * .09 + uWaterT * 2.3 + fi * 2.1) * (1. + depth * .012)
            + sin(q.y * .031 - uWaterT * 1.3 + fi) * .6;
    float sep = uWaterSep * (fi - 1.) * 14.;
    vec2 rq = vec2(q.x + w * uWaterAmp + sep, yy);
    float r = rq.y > 0. ? texture(uTex, rq / uRes)[i] : 0.;
    float gap = step(.72, vn(vec2(q.x * .012, q.y * .35) + uWaterT * vec2(.8, 0), 3.));
    r *= uRefl * (1. - gap * .85);
    d = 1. - (1. - d) * (1. - r);
  }
  return d;
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  // Paper: warm white plus fibre.
  float fibre = vn(px * vec2(.9, .25), 7.) * .5 + vn(px * .05, 9.) * .5;
  vec3 col = uPaper * (.975 + .03 * fibre);
  for (int i = 0; i < 3; i++) {
    if (uGate[i] <= 0.001) continue;
    vec2 q = rot(px - uRes * .5, uRot[i]) + uRes * .5 - uOff[i];
    float d = dens(i, px);
    // Roller reveal: ink reaches x < uSweep, with a denser band at the roller edge.
    float reveal = 1. - smoothstep(-5., 5., px.x - uSweep[i]);
    float band = exp(-pow((px.x - uSweep[i]) / 22., 2.));
    if (d < .002 && band < .01) continue;
    // Halftone screen in the plate's own (registered) coordinates.
    vec2 grid = rot(q, uAng[i]) / uPeriod;
    float spot = 1. - (cos(6.2831853 * grid.x) + cos(6.2831853 * grid.y) + 2.) * .25;
    // Ink grain: the static part follows the sheet; the boiling part re-rolls on twos.
    float n1 = mix(h21s(floor(q * .9), uSheet + float(i) * 3.1), h21s(floor(q * .9), uSeed + float(i) * 3.1), uBoil);
    float n2 = vn(q * .33, uSheet * .7 + float(i));
    float threshold = spot + (n1 - .5) * .16 * uGrain + (n2 - .5) * .12;
    float dd = d * 1.06;
    float coverage = smoothstep(threshold - .07, threshold + .07, dd);
    coverage = max(coverage, smoothstep(.9, 1., d) * .96);   // solid ink
    // Paper pinholes inside solids.
    float hole = h21s(floor(q * .55), uSheet * 1.3 + float(i) * 7.7);
    coverage *= 1. - step(.955 - .03 * uGrain, hole) * .75 * smoothstep(.4, 1., d);
    // Ink unevenness: streaks along the paper feed plus slow blotches.
    float streak = vn(vec2(q.x * .025, q.y * .0022), 11. + float(i) + uSheet * .37);
    float blot = vn(q * .004, 5. + float(i) * 2. + uSheet * .13);
    float k = clamp(.80 + .14 * streak + .08 * blot, 0., 1.);
    float c = clamp(coverage * k * reveal + band * .45 * smoothstep(0., .25, d), 0., 1.) * uGate[i];
    col *= mix(vec3(1.), uInk[i], c);
  }
  o = vec4(col, 1.);
}`;

function shader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'shader');
  return shader;
}

/**
 * Build the printer for one output canvas. `print(plate, options)` uploads the
 * packed RGB plate and draws one frame with preserveDrawingBuffer for capture.
 */
export function makeRiso(out, width, height) {
  const gl = out.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, alpha: false });
  if (!gl) throw new Error('risograph needs a WebGL2 context');
  const program = gl.createProgram();
  gl.attachShader(program, shader(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, shader(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'link');
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const location = gl.getAttribLocation(program, 'p');
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

  const uniform = (name) => gl.getUniformLocation(program, name);
  const u = {};
  for (const name of [
    'uTex', 'uRes', 'uOff', 'uRot', 'uAng', 'uInk', 'uPaper', 'uSeed', 'uBoil', 'uSheet',
    'uPeriod', 'uGate', 'uSweep', 'uGrain', 'uWaterY', 'uWaterAmp', 'uWaterT', 'uWaterSep',
    'uRefl', 'uWaterB',
  ]) u[name] = uniform(name);

  gl.viewport(0, 0, width, height);

  return function print(plateCanvas, options = {}) {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, plateCanvas);
    const inks = options.inks || [INK.blue, INK.yellow, INK.pink];
    gl.uniform1i(u.uTex, 0);
    gl.uniform2f(u.uRes, width, height);
    gl.uniform2fv(u.uOff, (options.off || [[0, 0], [0, 0], [0, 0]]).flat());
    gl.uniform1fv(u.uRot, options.rot || [0, 0, 0]);
    gl.uniform1fv(u.uAng, options.ang || [0.2618, 0, 1.309]); // 15° / 0° / 75°
    gl.uniform3fv(u.uInk, inks.map((c) => c.map((v) => v / 255)).flat());
    gl.uniform3fv(u.uPaper, (options.paper || PAPER).map((v) => v / 255));
    gl.uniform1f(u.uSeed, options.seed ?? 0);
    gl.uniform1f(u.uSheet, options.sheet ?? 0);
    gl.uniform1f(u.uBoil, options.boil ?? 0.35);
    gl.uniform1f(u.uPeriod, options.period ?? 7);
    gl.uniform1fv(u.uGate, options.gate || [1, 1, 1]);
    gl.uniform1fv(u.uSweep, options.sweep || [1e5, 1e5, 1e5]);
    gl.uniform1f(u.uGrain, options.grain ?? 1);
    const water = options.water || null;
    gl.uniform1f(u.uWaterY, water ? water.y : -1);
    gl.uniform1f(u.uWaterAmp, water ? water.amp : 0);
    gl.uniform1f(u.uWaterT, water ? water.t : 0);
    gl.uniform1f(u.uWaterSep, water ? water.sep : 0);
    gl.uniform1f(u.uRefl, water ? water.refl : 0);
    gl.uniform1f(u.uWaterB, water ? (water.b ?? 1e5) : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
}
