/**
 * Maintainer helper: render previews from the current study recipes.
 * Run after `npm run build`:
 *   node scripts/render-study-previews.mjs --work-root <new-work-directory>
 * Optional positional study names render only those entries. Replaces only
 * each selected study's generated preview.mp4 / preview.mp3, never user works.
 * This is not a Runtime creative API or a prescribed production workflow.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const exec = (command, args) => promisify(execFile)(command, args, { timeout: 600000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = await import(pathToFileURL(path.join(root, 'dist/src/index.js')).href);
const base = path.join(root, 'skills/viscraft/assets/studies');
const scriptSha256 = crypto.createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex');
const args = process.argv.slice(2);
const workFlag = args.indexOf('--work-root');
let workRoot;
if (workFlag >= 0) {
  if (!args[workFlag + 1] || args[workFlag + 1].startsWith('--')) throw new Error('--work-root needs a path');
  workRoot = path.resolve(args[workFlag + 1]);
  args.splice(workFlag, 2);
} else workRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-study-previews-'));
if (args.some(arg => arg.startsWith('--'))) throw new Error(`Unknown option in ${args.join(' ')}`);
await fs.mkdir(workRoot, { recursive: true });
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const relative = file => path.relative(root, file).split(path.sep).join('/');
const studies = [];
for (const area of ['audio', 'code-visuals']) {
  for (const entry of await fs.readdir(path.join(base, area), { withFileTypes: true })) {
    if (entry.isDirectory()) studies.push({ area, name: entry.name, directory: path.join(base, area, entry.name) });
  }
}
studies.sort((a, b) => `${a.area}/${a.name}`.localeCompare(`${b.area}/${b.name}`));
for (const name of args) if (!studies.some(s => s.name === name)) throw new Error(`Unknown study ${name}`);
const selected = args.length ? studies.filter(s => args.includes(s.name)) : studies;

async function render(study) {
  const recipePath = path.join(study.directory, 'create.mjs');
  const recipe = await import(pathToFileURL(recipePath).href);
  // Reuse only this generator's scratch Project when every current declared
  // file and the normalized author state still match. Build itself owns Take
  // reuse; no cross-study media catalogue or alternative production cache.
  const options = study.area === 'audio' ? {} : { width: 1920, height: 1080 };
  if (['cel-watercolor', 'paint-material'].includes(study.name)) options.frames = 96;
  let parent, projectRoot, project;
  for (const entry of await fs.readdir(workRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(`${study.name}-`)) continue;
    const candidate = path.join(workRoot, entry.name, study.name);
    try {
      const draft = await recipe.default({ root: candidate, options, runtime });
      const hashes = new Map();
      for (const file of draft.files) {
        const bytes = file.sourcePath ? await fs.readFile(file.sourcePath) : Buffer.from(file.bytes);
        if (file.expectedSha256 && sha(bytes) !== file.expectedSha256) throw new Error('Pinned input changed');
        if (!(await fs.readFile(path.join(candidate, file.path))).equals(bytes)) throw new Error('Author file changed');
        hashes.set(file.path, sha(bytes));
      }
      const expected = runtime.validateProject({ ...draft.project, assets: draft.project.assets.map(a =>
        ({ ...a, sha256: a.sha256 ?? hashes.get(a.path), revision: a.revision ?? 1 })) });
      const existing = await runtime.loadProject(candidate);
      if (JSON.stringify(expected) !== JSON.stringify(existing)) continue;
      parent = path.dirname(candidate); projectRoot = candidate; project = existing;
      console.log(`Reusing verified scratch inputs for ${study.name}`);
      break;
    } catch { /* A changed or incomplete scratch Project is not reused. */ }
  }
  if (!project) {
    parent = await fs.mkdtemp(path.join(workRoot, `${study.name}-`));
    projectRoot = path.join(parent, study.name);
    const authored = await recipe.default({ root: projectRoot, options, runtime });
    project = await runtime.authorProject(projectRoot, authored);
  }
  if (!project.sources.every(source => source.kind === 'browser'))
    throw new Error('Preview generation accepts only browser-authored studies; no provider submission');
  const filename = study.area === 'audio' ? 'preview.mp3' : 'preview.mp4';
  const encoded = path.join(parent, filename);
  const hasAuthoredSound = project.composition
    ? project.composition.audio.length > 0 || project.composition.placements.some(p => p.audio === 'keep')
    : false;
  let native;
  let frames;
  let samples;
  let seconds;
  if (study.area === 'audio') {
    if (project.sources.length !== 1 || project.sources[0].output !== 'sound')
      throw new Error('Expected one independently authored sound source');
    const target = project.soundTargets.find(candidate => candidate.id === 'master');
    if (!target) throw new Error('Expected one standalone sound target "master"');
    const built = await runtime.buildProject(projectRoot, { target: target.id });
    if (built.status !== 'succeeded') throw new Error(built.error ?? 'Sound Build failed');
    const artifact = built.artifacts.find(candidate => candidate.id === built.result.artifact);
    if (!artifact) throw new Error('The sound Build produced no artifact');
    native = path.join(projectRoot, artifact.path);
    samples = target.outputSamples;
    seconds = target.outputSamples / target.sampleRate;
    await exec('ffmpeg', ['-v', 'error', '-nostdin', '-i', native, '-map', '0:a:0', '-c:a', 'libmp3lame', '-q:a', '2', '-map_metadata', '-1', '-y', encoded]);
  } else {
    const built = await runtime.buildProject(projectRoot);
    if (built.status !== 'succeeded') throw new Error(built.error ?? 'Build failed');
    native = path.join(projectRoot, built.artifacts.find(a => a.id === built.result.artifact).path);
    frames = runtime.compositionFrames(project);
    seconds = frames * project.composition.output.fps.denominator / project.composition.output.fps.numerator;
    // Preserve the actual native Build picture without another lossy encode.
    // Keep authored audio; remove only the mixer's empty carrier track.
    const audio = hasAuthoredSound ? ['-map', '0:a:0', '-c:a', 'copy'] : ['-an'];
    await exec('ffmpeg', ['-v', 'error', '-nostdin', '-i', native, '-map', '0:v:0', ...audio,
      '-c:v', 'copy', '-map_metadata', '-1', '-movflags', '+faststart', '-y', encoded]);
  }
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,nb_read_frames,sample_rate,channels', '-of', 'json', encoded]);
  const probe = JSON.parse(stdout);
  if (Math.abs(Number(probe.format.duration) - seconds) > 0.1) throw new Error('Preview duration differs from the complete authored span');
  const picture = probe.streams.find(s => s.codec_type === 'video');
  const sound = probe.streams.find(s => s.codec_type === 'audio');
  if (study.area === 'audio' && (!sound || picture)) throw new Error('Independent music must remain audio only');
  if (study.area !== 'audio' && (!picture || Number(picture.nb_read_frames) !== frames || Boolean(sound) !== hasAuthoredSound))
    throw new Error('Picture frames or authored audio presence differs from the preview');
  const bytes = await fs.readFile(encoded);
  const target = path.join(study.directory, filename);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, bytes);
  await fs.rename(temporary, target);
  const result = { study: `${study.area}/${study.name}`, status: 'succeeded', path: relative(target),
    sha256: sha(bytes), bytes: bytes.length, seconds, frames, samples, options, probe,
    encoding: study.area === 'audio' ? 'MP3 VBR q2' : 'Native Build picture stream copied; authored audio copied',
    recipeSha256: sha(await fs.readFile(recipePath)), projectSha256: sha(await fs.readFile(path.join(projectRoot, 'project.json'))),
    assetInputs: project.assets.map(a => ({ path: a.path, sha256: a.sha256 })),
    masterSha256: sha(await fs.readFile(native)), projectRoot, listened: false, artisticAcceptance: false };
  console.log(`${result.study}: ${filename}, ${seconds}s, ${bytes.length} bytes, audio=${Boolean(sound)}`);
  return result;
}

const results = [];
let next = 0;
async function worker() {
  while (next < selected.length) {
    const study = selected[next++];
    console.log(`Rendering ${study.area}/${study.name}`);
    try { results.push(await render(study)); }
    catch (error) {
      results.push({ study: `${study.area}/${study.name}`, status: 'failed', error: String(error.stack ?? error) });
      console.error(`${study.name}: ${error.message}`);
    }
  }
}
await Promise.all([worker(), worker()]);
results.sort((a, b) => a.study.localeCompare(b.study));
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), scriptSha256, entries: results };
await fs.writeFile(path.join(workRoot, 'preview-report.json'), `${JSON.stringify(report, null, 2)}\n`);
if (results.some(r => r.status === 'failed')) process.exitCode = 1;
console.log(`Preview report: ${path.join(workRoot, 'preview-report.json')}`);
