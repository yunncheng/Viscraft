/**
 * E2E: the three independent sound references through the REAL author -> sound
 * target Build -> reuse -> edit -> revert -> export path.
 *
 * For each study this proves:
 *
 *  - `create.mjs` publishes a current sound-only Project: one `browser`
 *    `output: 'sound'` Source with a native `durationSamples`/`sampleRate`, NO
 *    fabricated composition (raster/FPS/placement/audio clip), and exactly one
 *    `soundTargets` entry that places that Source;
 *  - a real `buildProject(root, { target: 'master' })` renders the Source on its
 *    own sample clock, records a `medium: 'sound'` Build and a sound Take with
 *    `samples`/`sampleRate`/`channels`, and produces a decodable WAV of exactly
 *    `outputSamples`;
 *  - rebuilding the same target reuses the render and the resulting mix;
 *  - a clip-gain edit reuses the rendered Take and re-runs only the mix;
 *  - restoring the gain reproduces the earlier Result identity with full reuse;
 *  - an independent `exportProject` copy carries the authored closure and can
 *    build the same target itself, with a WAV whose bytes hash to the recorded
 *    artifact (sender hash protection);
 *  - a real edit of the exported score module, recorded with `refreshCodeAsset`,
 *    reaches the rendered samples; restoring the bytes makes the Build reuse the
 *    earlier Take again;
 *  - the original Project and its WAV bytes stay unchanged.
 *
 * These are engineering facts about structure and samples, not a listening
 * verdict on the music. Temporary directories are removed only on success; a
 * failure keeps its directory for diagnosis.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { buildProject } from '../src/build/build.js';
import { probeAudio } from '../src/backends/media/probe.js';
import { deliverProject } from '../src/operations/delivery/delivery.js';
import { verifyDelivery } from '../src/operations/delivery/delivery-verification.js';
import { refreshCodeAsset } from '../src/project/code-assets.js';
import { loadProject, saveProject } from '../src/project/project.js';
import { keepVersion } from '../src/project/versions.js';
import { authorRecipe, sha256 } from './authoring-helpers.js';

const AUDIO_STUDIES = resolve('skills/viscraft/assets/studies/audio');
const RUNTIME_NOTICE = resolve('THIRD_PARTY_NOTICES.md');

interface DecodedWav {
  sampleRate: number;
  channels: number;
  frames: number;
  data: Float32Array[];
}

interface StudySpec {
  dir: string;
  moduleFile: string;
  /** Target rate; at least one study deliberately differs from the native rate. */
  targetRate: number;
  edit: { from: string; to: string; label: string };
  editedCheck: (before: DecodedWav, after: DecodedWav) => void;
}

const STUDIES: StudySpec[] = [
  {
    dir: 'storybook-score',
    moduleFile: 'score.mjs',
    targetRate: 48000,
    edit: {
      from: 'const rest = { start: 12.5, end: 15,',
      to: 'const rest = { start: 12.5, end: 16,',
      label: 'rest end',
    },
    editedCheck: (before, after) => {
      assert.ok(peakBetween(before, 15.2, 15.8) > 0.01, 'the default theme is audible after the rest');
      assert.equal(maxBetween(after, 15.2, 15.8), 0, 'the edited rest gates the theme start exactly');
      assert.ok(maxBetween(after, 16.2, 16.8) > 0.01, 'the theme becomes audible when the edited rest ends');
    },
  },
  {
    dir: 'cartoon-jazz',
    moduleFile: 'score.mjs',
    targetRate: 48000,
    edit: { from: 'end: 19.96', to: 'end: 20.96', label: 'band-stop end' },
    editedCheck: (before, after) => {
      assert.ok(peakBetween(before, 20.1, 20.9) > 0.01, 'the default answer is audible after the band stop');
      assert.equal(maxBetween(after, 20.1, 20.9), 0, 'the edited music rest gates the answer exactly');
      assert.ok(maxBetween(after, 21.0, 21.8) > 0.01, 'the answer returns after the edited rest');
    },
  },
  {
    // Native 48 kHz source, 44.1 kHz target: this study proves the mixer
    // resamples without changing the authored seconds.
    dir: 'plucked-breath',
    moduleFile: 'score.mjs',
    targetRate: 44100,
    edit: { from: 'HARD_CUT_FRAME = 584', to: 'HARD_CUT_FRAME = 600', label: 'hard-cut point' },
    editedCheck: (before, after) => {
      assert.ok(peakBetween(before, 24.2, 24.4) > 0.01, 'the default crescendo rings before the cut');
      assert.equal(maxBetween(before, 24.46, 24.9), 0, 'the default cut is exact');
      assert.ok(maxBetween(after, 24.46, 24.9) > 0.001, 'the old cut point is no longer cut');
    },
  },
];

// ---------------------------------------------------------------------------
// WAV decoding and sample measurements (PCM16, as the Runtime writes it)
// ---------------------------------------------------------------------------
function decodeWav(bytes: Buffer): DecodedWav {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let audioFormat = 0;
  let data: Buffer | undefined;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      audioFormat = bytes.readUInt16LE(body);
      channels = bytes.readUInt16LE(body + 2);
      sampleRate = bytes.readUInt32LE(body + 4);
      bits = bytes.readUInt16LE(body + 14);
    } else if (id === 'data') {
      data = bytes.subarray(body, body + size);
    }
    offset = body + size + (size % 2);
  }
  assert.equal(audioFormat, 1, 'the WAV is PCM');
  assert.equal(bits, 16, 'the WAV is PCM16');
  assert.ok(data, 'the WAV has a data chunk');
  assert.ok(channels > 0 && sampleRate > 0);
  assert.equal(data.length % (channels * 2), 0, 'the data chunk is whole sample frames');
  const frames = data.length / (channels * 2);
  const decoded: Float32Array[] = [];
  for (let channel = 0; channel < channels; channel++) decoded.push(new Float32Array(frames));
  for (let frame = 0; frame < frames; frame++)
    for (let channel = 0; channel < channels; channel++)
      decoded[channel][frame] = data.readInt16LE((frame * channels + channel) * 2) / 32767;
  return { sampleRate, channels, frames, data: decoded };
}

function peakBetween(wav: DecodedWav, startSeconds: number, endSeconds: number): number {
  let peak = 0;
  const from = Math.max(0, Math.floor(startSeconds * wav.sampleRate));
  const to = Math.min(wav.frames, Math.ceil(endSeconds * wav.sampleRate));
  for (const channel of wav.data) for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(channel[i]));
  return peak;
}

function maxBetween(wav: DecodedWav, startSeconds: number, endSeconds: number): number {
  return peakBetween(wav, startSeconds, endSeconds);
}

function peakOf(wav: DecodedWav): number {
  let peak = 0;
  for (const channel of wav.data) for (let i = 0; i < channel.length; i++) peak = Math.max(peak, Math.abs(channel[i]));
  return peak;
}

function maxDifference(a: DecodedWav, b: DecodedWav): number {
  assert.equal(a.channels, b.channels);
  assert.equal(a.frames, b.frames);
  let max = 0;
  for (let channel = 0; channel < a.channels; channel++)
    for (let i = 0; i < a.frames; i++) max = Math.max(max, Math.abs(a.data[channel][i] - b.data[channel][i]));
  return max;
}

// ---------------------------------------------------------------------------
// Per-study real path
// ---------------------------------------------------------------------------
for (const study of STUDIES) {
  test(`${study.dir}: target Build, reuse, gain/source edit, revert and export`, async () => {
    const parent = await mkdtemp(join(tmpdir(), `viscraft-${study.dir}-`));
    let keep = false;
    try {
      const root = join(parent, 'default');
      const recipe = join(AUDIO_STUDIES, study.dir, 'create.mjs');
      await authorRecipe({ recipe, root, cwd: parent, options: {} });

      // --- 1. The authored contract: a native sample Source and one target --
      const project = await loadProject(root);
      assert.equal(project.composition, undefined, 'a sound-only Project declares no composition');
      assert.equal(project.sources.length, 1, 'exactly one authored Source');
      const source = project.sources[0];
      if (source.kind !== 'browser' || source.output !== 'sound')
        throw new Error(`${study.dir}: expected one browser sound Source`);
      assert.equal(project.soundTargets.length, 1, 'exactly one standalone sound target');
      const target = project.soundTargets[0];
      assert.equal(target.id, 'master');
      assert.equal(target.channels, 2);
      assert.equal(target.sampleRate, study.targetRate, 'the target states its own delivery rate');
      assert.equal(target.audio.length, 1, 'one source clip carries the whole programme');
      const clip = target.audio[0];
      assert.equal(clip.kind, 'source');
      if (clip.kind !== 'source') throw new Error('unreachable');
      assert.equal(clip.source, source.id);
      assert.equal(clip.startSample, 0);
      assert.ok(Number.isInteger(source.durationSamples) && source.durationSamples > 0, 'a native sample span');
      assert.ok([44100, 48000].includes(source.sampleRate), 'a native sample rate');
      assert.ok(
        Math.abs(target.outputSamples / target.sampleRate - source.durationSamples / source.sampleRate) <
          1 / target.sampleRate,
        'the target preserves the authored seconds',
      );
      const entryBytes = await readFile(join(root, source.entry), 'utf8');
      assert.match(entryBytes, /viscraftSound/, 'the entry wires window.viscraftSound');
      assert.match(entryBytes, /samples/, 'the entry reads the native sample span');

      // --- 2. Real standard Build of the sound target ----------------------
      const built = await buildProject(root, { target: 'master' });
      assert.equal(built.status, 'succeeded', built.error ?? 'the sound Build succeeds');
      assert.equal(built.medium, 'sound');
      assert.equal(built.target, 'master');
      assert.ok(built.result, 'a sound Build records its own Result');
      const artifact = built.artifacts.find(candidate => candidate.id === built.result!.artifact);
      assert.ok(artifact, 'the Result points at a real artifact');
      assert.equal(artifact.kind, 'audio');
      assert.ok(artifact.path.endsWith('.wav'), 'a sound target delivers a WAV');
      const take = built.takes.find(candidate => candidate.source === source.id);
      assert.ok(take, 'the Build records the Source Take');
      assert.equal(take.medium, 'sound');
      if (take.medium !== 'sound') throw new Error('unreachable');
      assert.equal(take.samples, source.durationSamples, 'the Take records the native sample span');
      assert.equal(take.sampleRate, source.sampleRate, 'the Take records the native rate');
      assert.equal(take.channels, 2, 'the Take records the delivered channel count');

      // A sound target never takes over the film result pointer.
      await assert.rejects(stat(join(root, '.viscraft', 'result.json')), /ENOENT/);
      const wavPath = join(root, artifact.path);
      const wavBytes = await readFile(wavPath);
      const wavHash = sha256(wavBytes);
      assert.equal(wavHash, artifact.sha256, 'the recorded artifact hash matches the WAV bytes');
      const wav = decodeWav(wavBytes);
      assert.equal(wav.sampleRate, target.sampleRate, 'the delivered WAV uses the target rate');
      assert.equal(wav.channels, 2);
      assert.equal(wav.frames, target.outputSamples, 'the WAV holds exactly outputSamples');
      const peak = peakOf(wav);
      assert.ok(peak > 0.01, `the programme is audible (peak ${peak})`);
      assert.ok(peak <= 1, `the programme is within full scale (peak ${peak})`);
      const probed = await probeAudio(wavPath);
      assert.equal(probed.sampleRate, target.sampleRate);
      assert.equal(probed.channels, 2);

      // --- 3. Rebuild reuses the render and the mix ------------------------
      const again = await buildProject(root, { target: 'master' });
      assert.equal(again.status, 'succeeded');
      assert.equal(again.result!.artifact, built.result!.artifact, 'the same Result artifact is reused');
      assert.ok(
        again.operations.every(operation => operation.reused),
        'an unchanged target reuses every operation (render and mix)',
      );
      assert.equal(sha256(await readFile(wavPath)), wavHash, 'reuse did not rewrite the WAV bytes');

      // --- 2b. Keep the sound version, then rebuild: the retained Take stays -
      const kept = await keepVersion(root, built.id, 'sound target check');
      assert.equal(kept.retained?.at !== undefined, true, 'keep marks the sound Build retained');
      const afterKeep = await buildProject(root, { target: 'master' });
      assert.equal(afterKeep.result!.artifact, built.result!.artifact, 'a retained version rebuilds identically');
      assert.ok(afterKeep.operations.every(operation => operation.reused));

      // --- 4. Clip gain edit: Take reused, only the mix reruns ------------
      const beforeGain = await loadProject(root);
      const gained = structuredClone(beforeGain);
      const gainedClip = gained.soundTargets[0].audio[0];
      if (gainedClip.kind !== 'source') throw new Error('unreachable');
      gainedClip.gain = 0.5;
      await saveProject(root, gained, beforeGain.revision);
      const gainedSaved = await loadProject(root);
      const gainBuild = await buildProject(root, { target: 'master' });
      assert.equal(gainBuild.status, 'succeeded');
      const renderOps = gainBuild.operations.filter(operation => operation.kind === 'browser');
      assert.equal(renderOps.length, 1);
      assert.equal(renderOps[0].reused, true, 'a gain edit reuses the rendered Take');
      const mixOp = gainBuild.operations.find(operation => operation.kind === 'mix-audio');
      assert.ok(mixOp && !mixOp.reused, 'a gain edit re-runs the mix');
      const gainArtifact = gainBuild.artifacts.find(candidate => candidate.id === gainBuild.result!.artifact)!;
      assert.notEqual(gainArtifact.sha256, artifact.sha256, 'the mix bytes change');
      const gainWav = decodeWav(await readFile(join(root, gainArtifact.path)));
      assert.equal(gainWav.frames, target.outputSamples, 'the edited mix keeps the target span');
      const ratio = peakOf(gainWav) / peak;
      assert.ok(ratio > 0.45 && ratio < 0.55, `a 0.5 clip gain halves the programme peak (ratio ${ratio.toFixed(3)})`);

      // --- 5. Revert the gain: every operation is reused again ------------
      const reverted = structuredClone(gained);
      const revertedClip = reverted.soundTargets[0].audio[0];
      if (revertedClip.kind !== 'source') throw new Error('unreachable');
      revertedClip.gain = 1;
      await saveProject(root, reverted, gainedSaved.revision);
      const revertBuild = await buildProject(root, { target: 'master' });
      assert.equal(revertBuild.status, 'succeeded');
      assert.ok(
        revertBuild.operations.every(operation => operation.reused),
        'reverting reuses the earlier work',
      );
      assert.equal(revertBuild.result!.artifact, built.result!.artifact, 'reverting reproduces the original Result');
      assert.equal(sha256(await readFile(wavPath)), wavHash, 'the original WAV is unchanged');

      // --- 6. Independent export and its own WAV --------------------------
      const currentProject = await readFile(join(root, 'project.json'));
      const delivered = await deliverProject(root, join(parent, 'delivered'), {
        outputs: { sounds: ['master', 'master'] },
      });
      assert.equal(delivered.movie, null);
      assert.deepEqual(delivered.images, []);
      assert.equal(delivered.sounds.length, 1, 'duplicate target selections collapse');
      const programme = delivered.sounds[0];
      assert.equal(programme.path, 'sound/master.wav');
      assert.equal(programme.samples, target.outputSamples);
      assert.equal(programme.sampleRate, target.sampleRate);
      assert.equal(programme.sha256, wavHash);
      assert.equal((await verifyDelivery(delivered.path)).ok, true);
      const product = join(delivered.path, programme.path);
      const productBytes = await readFile(product);
      // Frozen products may share read-only inodes within the bundle. Replace
      // this path to test hash verification without modifying another alias.
      await unlink(product);
      await writeFile(product, 'tampered');
      assert.equal((await verifyDelivery(delivered.path)).ok, false);
      await writeFile(product, productBytes);
      assert.equal((await verifyDelivery(delivered.path)).ok, true);
      const html = await readFile(join(delivered.path, 'index.html'), 'utf8');
      assert.match(html, /<audio controls/);
      assert.ok(html.includes(programme.path));
      const exportedPath = join(delivered.path, 'project');
      assert.equal(delivered.project.simulated, false);
      assert.ok(delivered.project.files >= 5, 'the delivery carries the authored closure');
      const exportedProject = await loadProject(exportedPath);
      assert.equal(exportedProject.composition, undefined, 'export keeps the sound-only shape');
      assert.equal(exportedProject.soundTargets[0].outputSamples, target.outputSamples);
      assert.deepEqual(
        await readFile(join(exportedPath, 'project.json')),
        currentProject,
        'the exported project.json is the authored bytes',
      );
      for (const asset of exportedProject.assets)
        assert.equal(
          sha256(await readFile(join(exportedPath, asset.path))),
          asset.sha256,
          `exported ${asset.path} is byte-identical`,
        );
      assert.deepEqual(
        await readFile(join(exportedPath, 'THIRD_PARTY_NOTICES.md')),
        await readFile(RUNTIME_NOTICE),
        'the exported NOTICE is the Runtime copy',
      );

      const exportedBuild = await buildProject(exportedPath, { target: 'master' });
      assert.equal(exportedBuild.status, 'succeeded', 'the exported copy builds its own WAV');
      const exportedArtifact = exportedBuild.artifacts.find(
        candidate => candidate.id === exportedBuild.result!.artifact,
      )!;
      // "Sender hash protection": the WAV the receiver builds is exactly the
      // artifact the record names, and its hash is stable when re-read.
      const exportedWavPath = join(exportedPath, exportedArtifact.path);
      const exportedBytes = await readFile(exportedWavPath);
      assert.equal(sha256(exportedBytes), exportedArtifact.sha256, 'the exported WAV matches its recorded hash');
      const exportedDecoded = decodeWav(exportedBytes);
      assert.equal(exportedDecoded.frames, target.outputSamples, 'the exported WAV keeps the target span');
      assert.equal(exportedDecoded.sampleRate, target.sampleRate);
      assert.equal(sha256(await readFile(exportedWavPath)), exportedArtifact.sha256, 'reading does not alter it');
      assert.equal(sha256(await readFile(product)), programme.sha256, 'the real delivered programme remains unchanged');

      // --- 7. A real code edit in the exported copy ----------------------
      const moduleAsset = exportedProject.assets.find(asset => asset.path === study.moduleFile);
      assert.ok(moduleAsset, 'the score module is a registered code Asset');
      const modulePath = join(exportedPath, study.moduleFile);
      const moduleText = await readFile(modulePath, 'utf8');
      assert.ok(moduleText.includes(study.edit.from), `the edit targets the authored ${study.edit.label}`);
      const editedText = moduleText.replace(study.edit.from, study.edit.to);
      await writeFile(modulePath, editedText);
      const refreshed = await refreshCodeAsset(exportedPath, {
        assetId: moduleAsset.id,
        expectedRevision: exportedProject.revision,
      });
      assert.equal(refreshed.sha256, sha256(Buffer.from(editedText)), 'the refresh records the edited bytes');
      const editBuild = await buildProject(exportedPath, { target: 'master' });
      assert.equal(editBuild.status, 'succeeded');
      const editArtifact = editBuild.artifacts.find(candidate => candidate.id === editBuild.result!.artifact)!;
      assert.notEqual(editArtifact.sha256, exportedArtifact.sha256, 'the code edit reaches the rendered WAV');
      const editedWav = decodeWav(await readFile(join(exportedPath, editArtifact.path)));
      study.editedCheck(exportedDecoded, editedWav);
      const editDelta = maxDifference(exportedDecoded, editedWav);
      assert.ok(editDelta > 0.001, `the code edit changes samples (max delta ${editDelta.toFixed(4)})`);

      // --- 8. Restore the code bytes: the earlier Take is reused ---------
      await writeFile(modulePath, moduleText);
      const beforeRestore = await loadProject(exportedPath);
      await refreshCodeAsset(exportedPath, {
        assetId: moduleAsset.id,
        expectedRevision: beforeRestore.revision,
      });
      const restoreBuild = await buildProject(exportedPath, { target: 'master' });
      assert.equal(restoreBuild.status, 'succeeded');
      assert.equal(
        restoreBuild.result!.artifact,
        exportedBuild.result!.artifact,
        'restoring the bytes reproduces the earlier Result',
      );
      assert.ok(
        restoreBuild.operations.every(operation => operation.reused),
        'the restored render is reused',
      );

      // Nothing in the original Project moved.
      assert.deepEqual(await readFile(join(root, 'project.json')), currentProject, 'the original Project is untouched');
      assert.equal(sha256(await readFile(wavPath)), wavHash, 'the original WAV is untouched');
      console.log(
        `[${study.dir}] native=${source.durationSamples}@${source.sampleRate} target=${wav.frames}@${wav.sampleRate} ` +
          `peak=${peak.toFixed(6)} gainRatio=${ratio.toFixed(3)} editDelta=${editDelta.toFixed(4)}`,
      );
    } catch (error) {
      keep = true;
      throw error;
    } finally {
      if (keep) console.error(`kept failing sound study at ${parent}`);
      else await rm(parent, { recursive: true, force: true });
    }
  });
}
