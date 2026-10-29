/**
 * Standard 3D model Asset end-to-end.
 *
 * Proves one real model format (glTF 2.x) through the whole current path:
 *   import (signature + structure + resource tracking) -> frozen snapshot ->
 *   World entity rendered through a frozen binding -> real pixels ->
 *   portable export -> reopen/render on a moved copy.
 *
 * The world page is deliberately self-contained: it draws the imported `.glb`
 * with raw WebGL (no vendored engine, no external host), so the ONLY model bytes
 * it can render are the ones the runtime served through the binding. That keeps
 * the pixel assertion honest — a placeholder or a missing binding cannot paint.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildProject } from '../src/build/build.js';
import { importAsset } from '../src/operations/assets/import.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { loadProject, saveProject, validateProject } from '../src/project/project.js';
import type { Asset, Project } from '../src/core/schema.js';
import { writeSignalAsset } from './audio-fixtures.js';

const WIDTH = 64,
  HEIGHT = 48,
  FRAMES = 4;

// ---------------------------------------------------------------------------
// Authoring a real, minimal glTF 2.x binary (`.glb`) fixture.
// A single triangle in the XY plane with an unlit base colour.
// ---------------------------------------------------------------------------
function authorGlb(color: readonly [number, number, number]): Buffer {
  const positions = new Float32Array([-0.4, -0.4, 0, 0.4, -0.4, 0, 0, 0.4, 0]);
  const indices = new Uint16Array([0, 1, 2]);
  const bin = Buffer.concat([
    Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength),
    Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength),
  ]);
  const document = {
    asset: { version: '2.0', generator: 'viscraft-model-asset-e2e' },
    extensionsUsed: ['KHR_materials_unlit'],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [
      {
        pbrMetallicRoughness: { baseColorFactor: [color[0], color[1], color[2], 1] },
        extensions: { KHR_materials_unlit: {} },
      },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-0.4, -0.4, 0], max: [0.4, 0.4, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
      { buffer: 0, byteOffset: 36, byteLength: 6, target: 34963 },
    ],
    buffers: [{ byteLength: bin.length }],
  };
  let json = Buffer.from(JSON.stringify(document), 'utf8');
  while (json.length % 4 !== 0) json = Buffer.concat([json, Buffer.from(' ')]);
  let binPadded = bin;
  while (binPadded.length % 4 !== 0) binPadded = Buffer.concat([binPadded, Buffer.from([0])]);
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + binPadded.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(json.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4); // 'JSON'
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binPadded.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4); // 'BIN\0'
  return Buffer.concat([header, jsonHeader, json, binHeader, binPadded]);
}

/** A `.gltf` document with an embedded buffer; `image` toggles an external texture. */
function gltfDocument(externalImage: string | null, externalBuffer: string | null): Buffer {
  const document = {
    asset: { version: '2.0', generator: 'viscraft-model-asset-e2e' },
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [
      {
        pbrMetallicRoughness: externalImage
          ? { baseColorTexture: { index: 0 } }
          : { baseColorFactor: [0.6, 0.3, 0.1, 1] },
      },
    ],
    ...(externalImage ? { textures: [{ source: 0 }], images: [{ uri: externalImage }] } : {}),
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [0, 0, 0] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    buffers: [
      {
        uri: externalBuffer ?? 'data:application/octet-stream;base64,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        byteLength: 36,
      },
    ],
  };
  return Buffer.from(JSON.stringify(document), 'utf8');
}

// ---------------------------------------------------------------------------
// A self-contained WebGL World page: parse the served `.glb`, draw its triangle.
// ---------------------------------------------------------------------------
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000}canvas{display:block}</style></head><body>
<canvas id="c"></canvas>
<script>
(function(){
  var vs='attribute vec3 aPos;uniform mat4 uMvp;void main(){gl_Position=uMvp*vec4(aPos,1.0);}';
  var fs='precision mediump float;uniform vec3 uColor;void main(){gl_FragColor=vec4(uColor,1.0);}';
  var gl=null,prog=null,loc={},model=null,bufPos=null,bufIdx=null;
  function mul(a,b){var o=new Float32Array(16);for(var i=0;i<4;i++)for(var j=0;j<4;j++){var s=0;for(var k=0;k<4;k++)s+=a[k*4+j]*b[i*4+k];o[i*4+j]=s;}return o;}
  function perspective(fovy,aspect,near,far){var f=1/Math.tan(fovy/2),nf=1/(near-far);return new Float32Array([f/aspect,0,0,0,0,f,0,0,0,0,(far+near)*nf,-1,0,0,2*far*near*nf,0]);}
  function lookAt(e,t,u){var zx=e[0]-t[0],zy=e[1]-t[1],zz=e[2]-t[2],zl=Math.hypot(zx,zy,zz)||1;zx/=zl;zy/=zl;zz/=zl;
    var xx=u[1]*zz-u[2]*zy,xy=u[2]*zx-u[0]*zz,xz=u[0]*zy-u[1]*zx,xl=Math.hypot(xx,xy,xz)||1;xx/=xl;xy/=xl;xz/=xl;
    var yx=zy*xz-zz*xy,yy=zz*xx-zx*xz,yz=zx*xy-zy*xx;
    return new Float32Array([xx,yx,zx,0,xy,yy,zy,0,xz,yz,zz,0,-(xx*e[0]+xy*e[1]+xz*e[2]),-(yx*e[0]+yy*e[1]+yz*e[2]),-(zx*e[0]+zy*e[1]+zz*e[2]),1]);}
  function trs(p,r,s){var cx=Math.cos(r[0]),sx=Math.sin(r[0]),cy=Math.cos(r[1]),sy=Math.sin(r[1]),cz=Math.cos(r[2]),sz=Math.sin(r[2]);var m=new Float32Array(16);
    m[0]=s[0]*cy*cz;m[1]=s[0]*(sx*sy*cz-cx*sz);m[2]=s[0]*(cx*sy*cz+sx*sz);m[3]=0;
    m[4]=s[1]*cy*sz;m[5]=s[1]*(sx*sy*sz+cx*cz);m[6]=s[1]*(cx*sy*sz-sx*cz);m[7]=0;
    m[8]=s[2]*-sy;m[9]=s[2]*sx*cy;m[10]=s[2]*cx*cy;m[11]=0;m[12]=p[0];m[13]=p[1];m[14]=p[2];m[15]=1;return m;}
  function compile(){var c=document.getElementById('c');
    var attrs={preserveDrawingBuffer:true};
    gl=c.getContext('webgl2',attrs)||c.getContext('webgl',attrs);
    if(!gl)throw new Error('no WebGL context');
    function sh(type,src){var s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error('shader: '+gl.getShaderInfoLog(s));return s;}
    prog=gl.createProgram();gl.attachShader(prog,sh(gl.VERTEX_SHADER,vs));gl.attachShader(prog,sh(gl.FRAGMENT_SHADER,fs));gl.linkProgram(prog);
    if(!gl.getProgramParameter(prog,gl.LINK_STATUS))throw new Error('link: '+gl.getProgramInfoLog(prog));
    loc.aPos=gl.getAttribLocation(prog,'aPos');loc.uMvp=gl.getUniformLocation(prog,'uMvp');loc.uColor=gl.getUniformLocation(prog,'uColor');}
  function parseGlb(bytes){var dv=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    if(String.fromCharCode(bytes[0],bytes[1],bytes[2],bytes[3])!=='glTF')throw new Error('bad glb magic');
    if(dv.getUint32(4,true)!==2)throw new Error('bad glb version');
    var json=null,binOff=-1,off=12;
    while(off+8<=bytes.byteLength){var clen=dv.getUint32(off,true),ctype=dv.getUint32(off+4,true),start=off+8;
      if(ctype===0x4E4F534A){json=JSON.parse(new TextDecoder().decode(bytes.subarray(start,start+clen)));}
      else if(ctype===0x004E4942){binOff=start;}
      off=start+clen;}
    if(!json)throw new Error('no glb json chunk');
    var prim=json.meshes[0].primitives[0],pa=json.accessors[prim.attributes.POSITION],pv=json.bufferViews[pa.bufferView];
    if(pa.componentType!==5126||pa.type!=='VEC3')throw new Error('unsupported POSITION accessor');
    var base=binOff+(pv.byteOffset||0)+(pa.byteOffset||0),positions=new Float32Array(pa.count*3);
    for(var i=0;i<pa.count*3;i++)positions[i]=dv.getFloat32(base+i*4,true);
    var indices=null,indexType=null;
    if(prim.indices!==undefined){var ia=json.accessors[prim.indices],iv=json.bufferViews[ia.bufferView],ib=binOff+(iv.byteOffset||0)+(ia.byteOffset||0);
      if(ia.componentType===5123){indices=new Uint16Array(ia.count);for(var j=0;j<ia.count;j++)indices[j]=dv.getUint16(ib+j*2,true);indexType=gl.UNSIGNED_SHORT;}
      else if(ia.componentType===5125){indices=new Uint32Array(ia.count);for(var j2=0;j2<ia.count;j2++)indices[j2]=dv.getUint32(ib+j2*4,true);indexType=gl.UNSIGNED_INT;}
      else throw new Error('unsupported index accessor');}
    var color=[1,1,1],mat=json.materials&&json.materials[prim.material||0];
    if(mat&&mat.pbrMetallicRoughness&&mat.pbrMetallicRoughness.baseColorFactor){color=mat.pbrMetallicRoughness.baseColorFactor.slice(0,3);}
    return {positions:positions,indices:indices,indexType:indexType,count:indices?indices.length:pa.count,color:color};}
  window.viscraft={async render(ctx){
    var w=window.__viscraftWorld;if(!w)throw new Error('missing __viscraftWorld');
    var entity=w.entities[0],binding=null,vals=Object.keys(ctx.bindings).map(function(k){return ctx.bindings[k];});
    for(var i=0;i<vals.length;i++)if(vals[i].id===entity.asset)binding=vals[i];
    if(!binding)throw new Error('entity asset '+entity.asset+' is not exposed as a binding');
    var c=document.getElementById('c');c.width=ctx.width;c.height=ctx.height;
    if(!gl)compile();
    if(!model){var bytes=new Uint8Array(await fetch(binding.url).then(function(r){return r.arrayBuffer();}));model=parseGlb(bytes);
      bufPos=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,bufPos);gl.bufferData(gl.ARRAY_BUFFER,model.positions,gl.STATIC_DRAW);
      if(model.indices){bufIdx=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,bufIdx);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,model.indices,gl.STATIC_DRAW);}}
    gl.viewport(0,0,ctx.width,ctx.height);gl.clearColor(0,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER,bufPos);gl.enableVertexAttribArray(loc.aPos);gl.vertexAttribPointer(loc.aPos,3,gl.FLOAT,false,0,0);
    if(model.indices)gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,bufIdx);
    var cam=w.camera,view=lookAt(cam.position,cam.target,[0,1,0]);
    var proj=perspective(cam.fov*Math.PI/180,ctx.width/ctx.height,0.1,100);
    var m=trs(entity.transform.position,entity.transform.rotation,entity.transform.scale);
    gl.uniformMatrix4fv(loc.uMvp,false,mul(proj,mul(view,m)));
    gl.uniform3fv(loc.uColor,new Float32Array(model.color));
    if(model.indices)gl.drawElements(gl.TRIANGLES,model.count,model.indexType,0);else gl.drawArrays(gl.TRIANGLES,0,model.count);
    gl.finish();
  }};
})();
</script></body></html>`;

function bootstrapProject(): Project {
  return {
    schemaVersion: 1,
    id: 'model-asset-e2e',
    revision: 1,
    title: 'Standard model Asset',
    direction: {
      intent: 'Render one approved 3D model through a World binding',
      looks: [{ id: 'main', description: 'model' }],
      transitions: [],
    },
    assets: [],
    bindings: {},
    sources: [
      {
        id: 'shot',
        kind: 'browser',
        output: 'picture',
        entry: 'model.html',
        resources: [],
        bindings: [],
        params: {},
        seed: 0,
        frames: FRAMES,
      },
    ],
    composition: {
      output: { width: WIDTH, height: HEIGHT, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene', description: 'one model shot' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'main', intent: 'model render', targetFrames: FRAMES }],
      placements: [
        { id: 'p', shot: 'shot', source: 'shot', inFrame: 0, outFrame: FRAMES, startFrame: 0, audio: 'mute' },
      ],
      transitions: [],
      audio: [],
    },
    imageDocuments: [],
    imageTargets: [],
    soundTargets: [],
  };
}

function modelProject(modelSha: string, modelPath: string, bed: Asset): Project {
  return {
    ...bootstrapProject(),
    assets: [
      {
        id: 'car_model',
        revision: 1,
        path: modelPath,
        sha256: modelSha,
        type: 'model',
        rights: {
          origin: 'self-authored test fixture (a real glTF triangle)',
          license: 'CC0-1.0',
          redistributable: true,
        },
        simulated: false,
      },
      bed,
    ],
    bindings: { car: 'car_model' },
    worlds: [
      {
        id: 'stage',
        revision: 1,
        units: 'meters',
        coordinates: 'right-handed-y-up',
        fps: { numerator: 30, denominator: 1 },
        frames: FRAMES,
        entities: [
          {
            id: 'shell',
            asset: 'car_model',
            transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
            state: {},
          },
        ],
        trajectories: [],
        cameras: [{ id: 'cam', position: [0, 0, 2], target: [0, 0, 0], fov: 45 }],
      },
    ],
    sources: [
      {
        id: 'shot',
        kind: 'browser',

        output: 'picture',

        world: { id: 'stage', camera: 'cam', mode: 'drive', startFrame: 0 },
        entry: 'model.html',
        resources: [],
        bindings: ['car'],
        params: {},
        seed: 0,
        frames: FRAMES,
      },
    ],
    composition: {
      ...bootstrapProject().composition!,
      audio: [
        {
          id: 'bed',
          kind: 'asset',
          asset: 'bed_signal',
          inSample: 0,
          startSample: 0,
          durationSamples: 6400,
          gain: 0.2,
          fadeInSamples: 0,
          fadeOutSamples: 0,
        },
      ],
    },
  };
}

/** Decode one frame of `video` to rgb24 and return the pixel accessor. */
async function firstFramePixels(
  video: string,
  workdir: string,
): Promise<{ at: (x: number, y: number) => [number, number, number] }> {
  const raw = join(workdir, 'frame.rgb24');
  await runCommand('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-i',
    video,
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    raw,
  ]);
  const bytes = await readFile(raw);
  assert.equal(bytes.length, WIDTH * HEIGHT * 3, 'decoded frame must be the authored output size');
  return {
    at: (x, y) => {
      const i = (y * WIDTH + x) * 3;
      return [bytes[i], bytes[i + 1], bytes[i + 2]];
    },
  };
}

async function finalArtifact(root: string, build: Awaited<ReturnType<typeof buildProject>>): Promise<string> {
  const artifact = build.artifacts.find(a => a.id === build.result!.artifact)!;
  return join(root, artifact.path);
}

test('a real .glb model imports, renders through a World binding, survives portable move and invalidates on byte change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-model-e2e-'));
  const delivery = root + '-delivery';
  try {
    await writeFile(join(root, 'model.html'), PAGE);
    await writeFile(join(root, 'car.glb'), authorGlb([0.9, 0.1, 0.12]));
    await writeFile(join(root, 'project.json'), JSON.stringify(bootstrapProject()));
    const source = join(root, 'car.glb');
    const model = await importAsset(root, {
      assetId: 'car_model',
      sourcePath: source,
      type: 'model',
      rights: {
        origin: 'self-authored test fixture (a real glTF triangle)',
        license: 'CC0-1.0',
        redistributable: true,
      },
      expectedRevision: 1,
    });
    assert.equal(model.type, 'model');
    assert.equal(model.sha256, await hashFile(source));
    assert.equal(model.inputs, undefined, 'a self-contained .glb carries no external inputs');

    const bed = await writeSignalAsset(root, {
      id: 'bed_signal',
      path: 'audio/bed.wav',
      sampleRate: 48000,
      channels: 2,
      samples: 6400,
      frequency: 440,
      waveform: 'sine',
    });
    assert.equal(bed.type, 'audio');
    assert.equal(bed.sha256, await hashFile(join(root, bed.path)));
    assert.ok(bed.rights.license.length > 0, 'the audio Asset carries explicit test rights');

    const initial = modelProject(model.sha256, model.path, bed);
    validateProject(initial);
    await writeFile(join(root, 'project.json'), JSON.stringify(initial));

    const first = await buildProject(root);
    assert.equal(first.status, 'succeeded');
    assert.equal(first.result!.simulated, false);
    const frozen = JSON.parse(await readFile(join(root, `.viscraft/snapshots/${first.id}.project.json`), 'utf8'));
    assert.equal(
      frozen.assets.find((a: Asset) => a.id === 'car_model').sha256,
      model.sha256,
      'the model participates in the frozen snapshot',
    );

    // The world op actually rendered: assert real non-background pixels.
    const pixels = await firstFramePixels(await finalArtifact(root, first), root);
    const center = pixels.at(WIDTH / 2, HEIGHT / 2);
    assert.ok(
      center[0] > 120 && center[1] < 90 && center[2] < 90,
      `the model triangle must paint a red centre pixel, got ${center}`,
    );
    const corner = pixels.at(1, 1);
    assert.ok(corner[0] < 40 && corner[1] < 40 && corner[2] < 40, `the background must stay black, got ${corner}`);

    const unchanged = await buildProject(root);
    assert.ok(
      unchanged.operations.every(op => op.reused),
      'a repeat build reuses every operation',
    );

    // The model bytes are a real operation dependency: changing them alone (same
    // World, same entity) must re-run the world op and leave the audio bed reused.
    await writeFile(join(root, 'car_model-v2.glb'), authorGlb([0.1, 0.85, 0.2]));
    const edited = await loadProject(root);
    const asset = edited.assets.find(a => a.id === 'car_model')!;
    asset.path = 'car_model-v2.glb';
    asset.sha256 = await hashFile(join(root, 'car_model-v2.glb'));
    asset.revision += 1;
    await saveProject(root, edited, edited.revision);
    const changed = await buildProject(root);
    assert.equal(
      changed.operations.filter(op => op.kind === 'browser' && !op.reused).length,
      1,
      'changed model bytes re-run exactly the world op',
    );
    assert.equal(
      changed.operations.find(op => op.kind === 'mix-audio')!.reused,
      true,
      'the audio bed is untouched by a model change',
    );
    const green = (await firstFramePixels(await finalArtifact(root, changed), root)).at(WIDTH / 2, HEIGHT / 2);
    assert.ok(green[1] > 120 && green[0] < 90 && green[2] < 90, `the new model bytes must render, got ${green}`);

    // Portable export carries the model; a moved copy still renders it.
    await exportProject(root, delivery);
    const moved = await loadProject(delivery);
    assert.equal(
      moved.assets.find(a => a.id === 'car_model')!.sha256,
      asset.sha256,
      'portable export carries the model Asset bytes',
    );
    moved.worlds![0].revision += 1; // force a genuine re-render of the moved copy
    await saveProject(delivery, moved, moved.revision);
    const rebuilt = await buildProject(delivery);
    const movedPixels = (await firstFramePixels(await finalArtifact(delivery, rebuilt), delivery)).at(
      WIDTH / 2,
      HEIGHT / 2,
    );
    assert.ok(
      movedPixels[1] > 120 && movedPixels[0] < 90,
      `the moved project must render the carried model, got ${movedPixels}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(delivery, { recursive: true, force: true });
  }
});

test('glTF resource tracking: an undeclared external texture/buffer fails loudly, a declared texture is tracked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-model-gltf-'));
  const delivery = root + '-delivery';
  try {
    const rights = { origin: 'self-authored test fixture', license: 'CC0-1.0', redistributable: true };
    await writeFile(join(root, 'project.json'), JSON.stringify(bootstrapProject()));
    await writeFile(join(root, 'model.html'), '<!doctype html><title>not rendered here</title>');

    // An undeclared external texture is refused (mutation: removing the check makes this import succeed).
    await writeFile(join(root, 'textured.gltf'), gltfDocument('texture.png', null));
    await assert.rejects(
      importAsset(root, {
        assetId: 'textured_model',
        sourcePath: join(root, 'textured.gltf'),
        type: 'model',
        rights,
        expectedRevision: 1,
      }),
      /external image "texture\.png"/,
      'an undeclared glTF texture must fail loudly',
    );

    // An external buffer is refused too (buffers must be embedded).
    await writeFile(join(root, 'buffer.gltf'), gltfDocument(null, 'mesh.bin'));
    await assert.rejects(
      importAsset(root, {
        assetId: 'buffered_model',
        sourcePath: join(root, 'buffer.gltf'),
        type: 'model',
        rights,
        expectedRevision: 1,
      }),
      /external buffer "mesh\.bin"/,
    );

    // A malformed `.glb` is refused by the container check.
    await writeFile(join(root, 'broken.glb'), Buffer.concat([Buffer.from('nope'), Buffer.alloc(16)]));
    await assert.rejects(
      importAsset(root, {
        assetId: 'broken_model',
        sourcePath: join(root, 'broken.glb'),
        type: 'model',
        rights,
        expectedRevision: 1,
      }),
      /"glTF" magic/,
    );

    // Declare the texture as a real image Asset, then the model import succeeds
    // and records the texture's identity, hash and role.
    await runCommand('ffmpeg', [
      '-hide_banner',
      '-nostdin',
      '-v',
      'error',
      '-threads',
      '2',
      '-filter_threads',
      '1',
      '-f',
      'lavfi',
      '-i',
      'color=c=0x3467aa:s=8x8',
      '-frames:v',
      '1',
      join(root, 'texture.png'),
    ]);
    const texture = await importAsset(root, {
      assetId: 'texture',
      sourcePath: join(root, 'texture.png'),
      type: 'image',
      rights,
      expectedRevision: 1,
    });
    const model = await importAsset(root, {
      assetId: 'textured_model',
      sourcePath: join(root, 'textured.gltf'),
      type: 'model',
      rights,
      expectedRevision: 2,
      inputs: [{ asset: 'texture', role: 'texture' }],
    });
    assert.deepEqual(model.inputs, [
      { asset: 'texture', revision: texture.revision, sha256: texture.sha256, role: 'texture' },
    ]);
    const project = await loadProject(root);
    assert.equal(
      project.assets.find(a => a.id === 'texture')!.rights.redistributable,
      true,
      'the texture input keeps its own rights',
    );

    // The model and its declared texture input both participate in portable export.
    await exportProject(root, delivery);
    const carried = await loadProject(delivery);
    const modelCopy = carried.assets.find(a => a.id === 'textured_model')!;
    const textureCopy = carried.assets.find(a => a.id === 'texture')!;
    assert.equal(
      await hashFile(join(delivery, modelCopy.path)),
      model.sha256,
      'portable export carries the model bytes',
    );
    assert.equal(
      await hashFile(join(delivery, textureCopy.path)),
      texture.sha256,
      'portable export carries the declared texture input bytes',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(delivery, { recursive: true, force: true });
  }
});
