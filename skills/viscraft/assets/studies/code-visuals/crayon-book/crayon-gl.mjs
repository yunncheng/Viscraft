/*
 * WebGL2 paper + wax compositor for the crayon-book reference.
 *
 * Adapted from LemoLab's lemo-opuscar crayon-book demo `gl.js` at commit
 * e3cb16f... (MIT). The page is rebuilt every frame:
 *   paper -> background crayon (with a paper knock-out) -> watercolour wash ->
 *   star and girl crayon groups -> paper emboss / warm vignette.
 *
 * The tooth is anchored to page coordinates, so it pans and zooms with the
 * camera. Crayon layers carry RGB = colour and A = pressure; the shader deposits
 * wax only on the peaks of the tooth, watercolour is resisted by wax, and a
 * final emboss makes the grain readable. Everything is sized from the actual
 * canvas backing dimensions; a resize rebuilds the targets instead of upscaling.
 */

const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = p*.5+.5; gl_Position = vec4(p,0,1); }`;

const TOOTH = `
float h21(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),u.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),u.x), u.y); }
uniform float uToothScale;
float toothRaw(vec2 px){
  px /= uToothScale;
  float n = vn(px/1.35)*.34 + vn(px/2.9+17.)*.33 + vn(px/6.3+41.)*.21;
  n += (vn(vec2(px.x/10., px.y/1.9)+7.)-.5)*.22;
  n += (vn(vec2(px.x/2.1, px.y/13.)+71.)-.5)*.08;
  return n;
}
float tooth(vec2 px){ return smoothstep(.16,.86,toothRaw(px)+.06); }
uniform vec3 uPC;
vec2 paperQ(vec2 uv, vec2 res){ vec2 sp = vec2(uv.x*res.x, (1.-uv.y)*res.y); return (sp - res*.5)/uPC.z + uPC.xy; }
float toothRawAt(vec2 uv, vec2 res, vec2 off){
  float L = log2(uPC.z); float k = floor(L), f = L - k;
  vec2 q = paperQ(uv, res);
  float a = toothRaw(q*exp2(k) + off), b = toothRaw(q*exp2(k+1.) + off + 37.1);
  return mix(a, b, smoothstep(0.,1.,f));
}
float toothAt(vec2 uv, vec2 res, vec2 off){ return smoothstep(.16,.86,toothRawAt(uv,res,off)+.06); }
`;

const FS_PAPER = `#version 300 es
precision highp float; in vec2 uv; out vec4 o;
uniform vec3 uPaper; uniform vec2 uRes; uniform vec2 uPoff;
${TOOTH}
void main(){
  vec2 px = paperQ(uv, uRes) + uPoff;
  float m = vn(px/180.)*.6 + vn(px/60.+9.)*.4;
  vec3 c = uPaper * (0.975 + 0.035*m);
  o = vec4(c, 0.);
}`;

const FS_IMG = `#version 300 es
precision highp float; in vec2 uv; out vec4 o; uniform sampler2D uL;
void main(){ o = texture(uL, uv); }`;

const FS_KNOCK = `#version 300 es
precision highp float; in vec2 uv; out vec4 o;
uniform sampler2D uL; uniform vec3 uPaper; uniform vec2 uRes; uniform vec2 uPoff;
${TOOTH}
void main(){
  float m = texture(uL, uv).a;
  if (m < .5) discard;
  vec2 px = paperQ(uv, uRes) + uPoff;
  float n = vn(px/180.)*.6 + vn(px/60.+9.)*.4;
  o = vec4(uPaper*(0.975+0.035*n), 0.);
}`;

const FS_CRAYON = `#version 300 es
precision highp float; in vec2 uv; out vec4 o;
uniform sampler2D uL; uniform vec2 uRes; uniform vec2 uGoff; uniform float uGain; uniform float uSoft;
${TOOTH}
void main(){
  vec4 L = texture(uL, uv);
  if (L.a < .003) { o = vec4(0); return; }
  float t = toothAt(uv, uRes, uGoff);
  float a = clamp(L.a*uGain, 0., 1.);
  float thr = 1.0 - a*1.22;
  float cov = smoothstep(thr - uSoft, thr + uSoft, t);
  cov *= smoothstep(0.0, 0.18, a);
  vec3 c = L.rgb * (1.0 - 0.10*a*a);
  o = vec4(c, cov);
}`;

const FS_WASH = `#version 300 es
precision highp float; in vec2 uv; out vec4 o;
uniform sampler2D uPrev; uniform sampler2D uW; uniform vec2 uRes; uniform vec3 uT; uniform vec2 uGoff;
uniform float uResist; uniform float uEdge; uniform float uGran;
${TOOTH}
void main(){
  vec4 P = texture(uPrev, uv);
  vec4 Wc = texture(uW, uv);
  float d = Wc.a;
  if (d > .002) {
    float blur = textureLod(uW, uv, 4.0).a;
    float blur2 = textureLod(uW, uv, 2.0).a;
    float edge = clamp(d - blur, 0., 1.)*uEdge + clamp(d - blur2, 0., 1.)*uEdge*.6;
    float t = smoothstep(.16,.86, toothRaw(paperQ(uv,uRes)*0.55 + uGoff + 300.) + .06);
    vec2 wq = paperQ(uv, uRes);
    float lo = vn(wq/160.)*.5 + vn(wq/55.+3.)*.3 + vn(wq/19.+8.)*.2;
    float gr = smoothstep(.35, .05, t);
    float dd = d * (0.82 + 0.3*lo) * (1.0 + uGran*.45*gr) + edge;
    float wax = P.a;
    float res = 1.0 - uResist*smoothstep(.12, .55, wax);
    dd = clamp(dd*res, 0., 1.25);
    vec3 tr = mix(vec3(1.), uT, clamp(dd,0.,1.));
    tr *= mix(1.0, 0.82, clamp(dd-1.0,0.,1.)*4.);
    o = vec4(P.rgb*tr, P.a);
  } else o = P;
}`;

const FS_FINAL = `#version 300 es
precision highp float; in vec2 uv; out vec4 o;
uniform sampler2D uS; uniform vec2 uRes; uniform float uVig; uniform float uEmb; uniform vec2 uPoff; uniform float uLift; uniform vec4 uLamp;
${TOOTH}
void main(){
  vec4 S = texture(uS, uv);
  vec2 du = vec2(1./uRes.x, 0.), dv = vec2(0., 1./uRes.y);
  float t0 = toothRawAt(uv, uRes, uPoff), tx = toothRawAt(uv+du, uRes, uPoff), ty = toothRawAt(uv-dv, uRes, uPoff);
  vec2 g = vec2(tx-t0, ty-t0);
  float waxSmooth = 1.0 - .55*S.a;
  float lit = 1.0 + (g.x*-.9 + g.y*.9)*uEmb*waxSmooth - (1.0-t0)*.035*waxSmooth;
  vec3 c = S.rgb*lit;
  c += S.a*.018*uLift;
  vec2 q = uv-.5; q.x *= uRes.x/uRes.y;
  float v = 1.0 - uVig*dot(q,q);
  c *= mix(vec3(1.), vec3(1.0,.965,.9), clamp((1.0-v)*1.4,0.,1.)) * v;
  if (uLamp.w > 0.) {
    vec2 d = (uv - uLamp.xy); d.x *= uRes.x/uRes.y;
    float fall = exp(-dot(d,d)/(uLamp.z*uLamp.z));
    vec3 lamp = mix(vec3(.46,.36,.30), vec3(1.07,1.0,.9), fall);
    c *= mix(vec3(1.), lamp, uLamp.w);
  }
  o = vec4(clamp(c,0.,1.), 1.);
}`;

function shader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s) || 'unknown shader error';
    gl.deleteShader(s);
    throw new Error('crayon-book: WebGL shader failed: ' + log);
  }
  return s;
}

function program(gl, fs) {
  const p = gl.createProgram();
  const vs = shader(gl, gl.VERTEX_SHADER, VS);
  const frag = shader(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, vs);
  gl.attachShader(p, frag);
  gl.bindAttribLocation(p, 0, 'p');
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(frag);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p) || 'unknown link error';
    gl.deleteProgram(p);
    throw new Error('crayon-book: WebGL program failed: ' + log);
  }
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const a = gl.getActiveUniform(p, i);
    u[a.name] = gl.getUniformLocation(p, a.name);
  }
  return { p, u };
}

export function createCompositor(canvas, width, height) {
  const gl = canvas.getContext('webgl2', {
    preserveDrawingBuffer: true,
    premultipliedAlpha: false,
    antialias: false,
    alpha: false,
  });
  if (!gl) {
    throw new Error(
      'crayon-book requires WebGL2 for its paper-tooth and wax compositor; this browser/headless session did not provide a WebGL2 context.',
    );
  }
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const P = {
    img: program(gl, FS_IMG),
    knock: program(gl, FS_KNOCK),
    paper: program(gl, FS_PAPER),
    crayon: program(gl, FS_CRAYON),
    wash: program(gl, FS_WASH),
    final: program(gl, FS_FINAL),
  };

  let w = 0;
  let h = 0;
  let targets = [];
  let cur = 0;
  let layerTex;
  let washTex;
  let toothScale = 1;
  let pc = [0, 0, 1];

  function texture(mip) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  function target() {
    const t = texture(false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return { t, f };
  }

  function disposeTargets() {
    for (const t of targets) {
      gl.deleteFramebuffer(t.f);
      gl.deleteTexture(t.t);
    }
    targets = [];
    if (layerTex) gl.deleteTexture(layerTex);
    if (washTex) gl.deleteTexture(washTex);
    layerTex = texture(false);
    washTex = texture(true);
  }

  function resize(nextW, nextH) {
    if (nextW === w && nextH === h) return;
    w = Math.max(1, Math.floor(nextW));
    h = Math.max(1, Math.floor(nextH));
    canvas.width = w;
    canvas.height = h;
    disposeTargets();
    targets = [target(), target()];
    cur = 0;
    gl.viewport(0, 0, w, h);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  }

  function use(pr, extra = {}) {
    gl.useProgram(pr.p);
    if (pr.u.uRes) gl.uniform2f(pr.u.uRes, w, h);
    if (pr.u.uToothScale) gl.uniform1f(pr.u.uToothScale, toothScale);
    if (pr.u.uPC) gl.uniform3f(pr.u.uPC, pc[0], pc[1], pc[2]);
    for (const k in extra) {
      const l = pr.u[k];
      if (!l) continue;
      const v = extra[k];
      if (Array.isArray(v)) (v.length === 2 ? gl.uniform2f : gl.uniform3f).call(gl, l, ...v);
      else gl.uniform1f(l, v);
    }
  }
  const draw = () => gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  resize(width, height);

  return {
    gl,
    get width() {
      return w;
    },
    get height() {
      return h;
    },
    resize,
    set toothScale(v) {
      toothScale = v;
    },
    paperCam(x, y, z) {
      pc = [x, y, z];
    },
    begin(paper = [0.957, 0.937, 0.89], poff = [0, 0]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, targets[cur].f);
      gl.disable(gl.BLEND);
      use(P.paper, { uPaper: paper, uPoff: poff });
      draw();
    },
    knock(cv, paper = [0.957, 0.937, 0.89], poff = [0, 0]) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, layerTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
      gl.bindFramebuffer(gl.FRAMEBUFFER, targets[cur].f);
      gl.disable(gl.BLEND);
      use(P.knock, { uPaper: paper, uPoff: poff });
      gl.uniform1i(P.knock.u.uL, 0);
      draw();
    },
    group(C, o = {}) {
      this.knock(C.k.c);
      this.crayon(C.f.c, o);
      this.crayon(C.l.c, o);
    },
    crayon(cv, { goff = [0, 0], gain = 1, soft = 0.07 } = {}) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, layerTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
      gl.bindFramebuffer(gl.FRAMEBUFFER, targets[cur].f);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      use(P.crayon, { uGoff: goff, uGain: gain, uSoft: soft });
      gl.uniform1i(P.crayon.u.uL, 0);
      draw();
      gl.disable(gl.BLEND);
    },
    wash(cv, { color = [0.16, 0.2, 0.46], goff = [0, 0], resist = 0.93, edge = 1.6, gran = 0.6 } = {}) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, washTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, targets[cur].t);
      const nx = 1 - cur;
      gl.bindFramebuffer(gl.FRAMEBUFFER, targets[nx].f);
      gl.disable(gl.BLEND);
      use(P.wash, { uT: color, uGoff: goff, uResist: resist, uEdge: edge, uGran: gran });
      gl.uniform1i(P.wash.u.uPrev, 0);
      gl.uniform1i(P.wash.u.uW, 1);
      draw();
      cur = nx;
    },
    image(cv) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, layerTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
      gl.bindFramebuffer(gl.FRAMEBUFFER, targets[cur].f);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
      use(P.img);
      gl.uniform1i(P.img.u.uL, 0);
      draw();
      gl.disable(gl.BLEND);
    },
    finish({ vig = 0.32, emb = 0.55, poff = [0, 0], lift = 1, lamp = [0.5, 0.5, 1, 0] } = {}) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.disable(gl.BLEND);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, targets[cur].t);
      use(P.final, { uVig: vig, uEmb: emb, uPoff: poff, uLift: lift });
      gl.uniform4f(P.final.u.uLamp, ...lamp);
      gl.uniform1i(P.final.u.uS, 0);
      draw();
    },
  };
}
