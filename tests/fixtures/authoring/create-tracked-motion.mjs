#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ReferenceTrackSchema, validateProject, framesToSamples, ptsToFrames } from '../../../dist/src/index.js';
import { makeSignalAsset } from './lib/audio-fixture.mjs';

const [reportPath, destination, ...extra] = process.argv.slice(2);
if (!reportPath || !destination || extra.length)
  throw Error(
    'Usage: node tests/fixtures/authoring/create-tracked-motion.mjs <actual-track-report.json> <new-project-directory>',
  );
const report = ReferenceTrackSchema.parse(JSON.parse(await readFile(resolve(reportPath), 'utf8')));
const root = resolve(destination);
const frames = ptsToFrames(report.clock.endPts, report.clock.originPts, report.clock.timeBase, report.fps);
if (!frames || frames > 1800)
  throw Error('The tracked-motion example requires a positive output interval of at most 1800 frames');
const data =
  JSON.stringify(
    {
      sourceHash: report.source.sha256,
      paramsHash: report.paramsHash,
      fps: report.fps,
      observations: report.frames.map(({ outputFrame, present, x, y }) => ({ outputFrame, present, x, y })),
    },
    null,
    2,
  ) + '\n';
const page = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Trace Flight — newly authored marker motion</title><body style="margin:0;background:#06121c"><canvas id="canvas"></canvas><script>
let motion;
window.viscraft={async render(ctx){
 if(!motion){const response=await fetch(ctx.bindings.motion.url);if(!response.ok)throw Error('Missing frozen motion evidence');motion=await response.json();}
 const canvas=document.getElementById('canvas');canvas.width=ctx.width;canvas.height=ctx.height;const g=canvas.getContext('2d');
 g.fillStyle='#06121c';g.fillRect(0,0,ctx.width,ctx.height);g.strokeStyle='#12364a';g.lineWidth=1;
 for(let x=0;x<ctx.width;x+=40){g.beginPath();g.moveTo(x,0);g.lineTo(x,ctx.height);g.stroke();}for(let y=0;y<ctx.height;y+=40){g.beginPath();g.moveTo(0,y);g.lineTo(ctx.width,y);g.stroke();}
 const seen=motion.observations.filter(point=>point.outputFrame<=ctx.frame);const point=seen.at(-1);g.strokeStyle='#16a7ba';g.lineWidth=2;g.beginPath();let linked=false;
 for(const p of seen){if(!p.present){linked=false;continue;}const x=p.x*ctx.width,y=p.y*ctx.height;if(linked)g.lineTo(x,y);else g.moveTo(x,y);linked=true;}g.stroke();
 if(point?.present){g.save();g.translate(point.x*ctx.width,point.y*ctx.height);g.fillStyle='#4de8ef';g.beginPath();g.moveTo(0,-13);g.lineTo(19,0);g.lineTo(0,13);g.lineTo(-7,0);g.closePath();g.fill();g.restore();}
 g.fillStyle='#d8eef6';g.font='bold 22px sans-serif';g.fillText('TRACE FLIGHT',20,30);g.font='13px sans-serif';g.fillStyle='#82b8ca';g.fillText(point?.present?'New subject · measured 2D motion':'Marker missing · subject explicitly hidden',20,ctx.height-20);
}};
</script></body></html>`;
const sampleRate = 48000,
  samples = framesToSamples(frames, report.fps, sampleRate, 'ceil');
// A real PCM bed: the Project declares the file, not a Runtime-synthesized clip.
const bed = makeSignalAsset({
  id: 'trace_bed',
  path: 'trace-bed.wav',
  sampleRate,
  channels: 2,
  samples,
  frequency: 220,
  waveform: 'sine',
});
const project = validateProject({
  schemaVersion: 1,
  id: 'trace-flight',
  revision: 1,
  title: 'TRACE FLIGHT — newly authored motion from measured marker evidence',
  direction: {
    intent:
      'Keep the measured screen-space marker timing/position, replace all pixels with an original kite and field. A missing observation explicitly hides the subject; no inferred pose, depth, identity, interpolation or recovered Source.',
    looks: [{ id: 'trace', description: 'Cyan geometric kite on a deep blue coordinate field' }],
    transitions: [],
  },
  assets: [
    {
      id: 'motion_evidence',
      revision: 1,
      type: 'code',
      path: 'motion.json',
      sha256: createHash('sha256').update(data).digest('hex'),
      rights: {
        origin:
          'original authored coordinate selection from an explicitly supplied marker report; no source media pixels included',
        license: 'Original authoring; reference-media rights remain separate',
        redistributable: true,
      },
      simulated: report.source.simulated,
    },
    bed.asset,
  ],
  bindings: { motion: 'motion_evidence' },
  sources: [
    {
      id: 'flight',
      kind: 'browser', output: 'picture',
      entry: 'flight.html',
      resources: [],
      bindings: ['motion'],
      params: {},
      seed: 7,
      frames,
    },
  ],
  composition: {
    output: { width: 640, height: 360, fps: report.fps, sampleRate, channels: 2 },
    scenes: [{ id: 'scene', description: 'New subject from bounded 2D observations' }],
    shots: [
      {
        id: 'shot',
        scene: 'scene',
        look: 'trace',
        intent: 'Measured trajectory, explicitly missing visibility',
        targetFrames: frames,
      },
    ],
    placements: [
      { id: 'edit', shot: 'shot', source: 'flight', inFrame: 0, outFrame: frames, startFrame: 0, audio: 'mute' },
    ],
    transitions: [],
    audio: [
      {
        id: 'bed',
        kind: 'asset',
        asset: 'trace_bed',
        inSample: 0,
        startSample: 0,
        durationSamples: samples,
        gain: 0.1,
        fadeInSamples: Math.min(2400, Math.floor(samples / 4)),
        fadeOutSamples: Math.min(4800, Math.floor(samples / 4)),
      },
    ],
  },
});
for (const name of ['motion.json', 'flight.html', 'trace-bed.wav', 'project.json']) {
  try {
    await access(join(root, name));
  } catch (error) {
    if (error.code === 'ENOENT') continue;
    throw error;
  }
  throw Error(`Refusing to overwrite existing ${join(root, name)}`);
}
await mkdir(root, { recursive: true });
for (const [name, contents] of [
  ['motion.json', data],
  ['flight.html', page],
  ['trace-bed.wav', bed.bytes],
  ['project.json', JSON.stringify(project, null, 2) + '\n'],
])
  await writeFile(join(root, name), contents, { flag: 'wx' });
console.log(
  JSON.stringify(
    {
      project: root,
      frames,
      sourceHash: report.source.sha256,
      observedPoints: report.frames.filter(frame => frame.present).length,
      missingPoints: report.frames.filter(frame => !frame.present).length,
      simulated: report.source.simulated,
      note: 'New original pixels using measured 2D coordinates; no original-media copy or Source/3D recovery.',
    },
    null,
    2,
  ),
);
