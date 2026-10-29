#!/usr/bin/env node
/*
 * Viscraft technical fixture: author an ORIGINAL, deterministic soundtrack for a recorded
 * race session, driven by what the recording actually observed.
 *
 *   node tests/fixtures/authoring/score-race-recording.mjs <project-directory> <recording-id>
 *
 * The Project must already contain a `browser` picture Source whose recording is
 * `recordings/<recording-id>/session.json`, and a Composition whose placements
 * select accepted Takes built from that Source. This script does NOT run a
 * browser and does NOT execute any Source: it only reads
 *
 *   - the recorded session (observed per-frame state + real input events), and
 *   - the selected Takes' verified video Artifacts (hash re-checked from disk),
 *
 * then re-times the recorded telemetry onto the Composition timeline with the
 * canonical sample clock and synthesizes one stereo PCM16 WAV from scratch with
 * a plain JS Buffer. No external audio, no FFmpeg, no copied source, no
 * generative Provider, no network.
 *
 * Take provenance: a placement must select a Take of the SAME Source, and that
 * Take's Build must have frozen this exact session (frozen project binds the
 * Source to this recording path, and the frozen recording bytes hash-match the
 * current session) — so a Take from a different session of the same Source is
 * refused even if it is the newest Build.
 *
 * Synthesis roles (all original procedural code):
 *   engine   - phase-continuous harmonic stack; frequency AND gain track the
 *              OBSERVED speed across cuts (controls interpolated over one frame
 *              at a cut, so the phase never restarts), lifted by boost / dipped
 *              by brake,
 *   tire     - seeded-noise tire scrub, low-pass cutoff/level from the observed
 *              lateral offset delta,
 *   brake    - seeded high-passed noise keyed by the real ArrowDown input
 *              events mapped to source frames,
 *   chime    - a short bell struck ONLY by real checkpoint events inside a
 *              selected half-open source interval; its tail may ring past the
 *              cut while still inside the output timeline,
 *   ambience - continuous seeded road wash spanning the whole output,
 *   music    - a continuous original pulse pattern spanning the whole output,
 *
 * Only slots covered by a scored Take carry telemetry; a timeline that is not
 * fully covered (mixed live Sources, gaps or unrelated Takes) is rejected
 * rather than filled with invented observed state. Checkpoint crossing uses the
 * first output frame reaching the event, k = ceil((i - inFrame) * D / N); an
 * event past the placement's output span at that ratio is dropped and reported.
 *
 * The mix keeps headroom and is rejected if it would clip. The result is one
 * audio Asset (`assets/race-score-<contenthash>.wav`) referenced by a single
 * `asset` audio clip that replaces the baseline tone grid, so the score is an
 * explicit, editable part of the Composition. Nothing else is touched.
 *
 * Honesty: this is stylized procedural synthesis driven by kinematic telemetry.
 * It is not a recording of a real engine, not physically accurate Foley, and
 * makes no photorealism or audio-realism claim.
 *
 * License basis: 100% authored here from scratch; no third-party code, audio or
 * models are introduced, so the new Asset is CC0-1.0 and freely redistributable.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  loadProject,
  saveProject,
  loadRecording,
  readBuilds,
  framesToSamples,
  compositionFrames,
} from '../../../dist/src/index.js';
import { Id } from '../../../dist/src/core/schema.js';
import { resolveProjectPath } from '../../../dist/src/shared/fs.js';
import { hashFile, stableHash } from '../../../dist/src/shared/hash.js';

const args = process.argv.slice(2);
if (args.length !== 2) {
  throw new Error('Usage: node tests/fixtures/authoring/score-race-recording.mjs <project-directory> <recording-id>');
}
const root = resolve(args[0]);
let recordingId;
try {
  recordingId = Id.parse(args[1]); // rejects separators / dot segments before any path is built
} catch {
  throw new Error(
    `Invalid recording id ${JSON.stringify(args[1])}: expected an Id of letters/digits/_/- with no path separators`,
  );
}
const relativeRecording = `recordings/${recordingId}/session.json`;

// Tunable role gains (kept well under full scale; a single global safety scale
// is applied afterwards only if the summed mix would ever approach clipping).
const ENGINE_GAIN = 0.24;
const TIRE_GAIN = 0.1;
const BRAKE_GAIN = 0.11;
const AMBIENCE_GAIN = 0.028;
const MUSIC_BASS_GAIN = 0.15;
const MUSIC_LEAD_GAIN = 0.055;
const CHIME_GAIN = 0.085;
const HARMONICS = 6;
const HEADROOM_CEILING = 0.94; // global safety target; hard reject above 0.99

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const roleState = (role, gain, count, peak, note) => ({ role, gain, count, measuredPeak: peak, note });

/** Deterministic, seedable PRNG (no Math.random anywhere in this file). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Encode interleaved float samples as a canonical 44-byte-header PCM16LE WAV. */
function encodeWav(samples, sampleRate, channels) {
  const frames = Math.floor(samples.length / channels);
  const dataBytes = frames * channels * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  let offset = 44;
  for (let i = 0; i < frames * channels; i++) {
    buffer.writeInt16LE(Math.round(samples[i] * 32767), offset);
    offset += 2;
  }
  return buffer;
}

/** Add a decaying harmonic note into an interleaved mix, clamped to the timeline; returns its peak contribution. */
function addNote(mix, channels, sampleRate, startSample, frequency, seconds, gain, partials, panL, panR, totalSamples) {
  const length = Math.round(seconds * sampleRate);
  const attack = Math.max(1, Math.round(0.004 * sampleRate));
  const tau = (seconds / 4.5) * sampleRate;
  let peak = 0;
  for (let i = 0; i < length; i++) {
    const s = startSample + i;
    if (s < 0 || s >= totalSamples) continue;
    const env = i < attack ? i / attack : Math.exp(-(i - attack) / tau);
    let value = 0;
    for (const [mult, amp] of partials) value += amp * Math.sin(2 * Math.PI * frequency * mult * (i / sampleRate));
    const g = gain * env * value;
    const base = s * channels;
    mix[base] += g * panL;
    if (channels > 1) mix[base + 1] += g * panR;
    if (Math.abs(g) > peak) peak = Math.abs(g);
  }
  return peak;
}

async function main() {
  // ---- 1. Load the recorded session and the Project that owns it ------------
  const recording = await loadRecording(root, relativeRecording);
  const project = await loadProject(root);
  const output = project.composition.output;

  const playable = project.sources.find(source => source.kind === 'browser' && source.recording === relativeRecording);
  if (!playable) throw new Error(`No playable Source in this Project references ${relativeRecording}`);
  if (playable.id !== recording.source.id) {
    throw new Error(`Recording source ${recording.source.id} does not match playable Source ${playable.id}`);
  }

  // The score is rendered on the Composition's own clock, so the recording and
  // the output must share frame rate, sample rate and channel count exactly.
  const clockOk =
    stableHash(recording.output.fps) === stableHash(output.fps) &&
    recording.output.sampleRate === output.sampleRate &&
    recording.output.channels === output.channels;
  if (!clockOk) {
    throw new Error(
      'Recording clock (fps/sampleRate/channels) does not match the Composition output; refusing to guess a mapping',
    );
  }

  // ---- 2. Resolve the accepted Takes the Composition actually selected ------
  const builds = await readBuilds(root);
  const takeIndex = new Map();
  const artifactIndex = new Map();
  for (const build of builds) {
    if (build.status !== 'succeeded') continue;
    for (const take of build.takes) if (!takeIndex.has(take.id)) takeIndex.set(take.id, { take, buildId: build.id });
    for (const artifact of build.artifacts)
      if (!artifactIndex.has(artifact.id)) artifactIndex.set(artifact.id, { artifact, buildId: build.id });
  }

  const sessionSha = await hashFile(await resolveProjectPath(root, relativeRecording));
  const scored = [];
  for (const placement of project.composition.placements) {
    if (placement.source === playable.id) {
      throw new Error(
        `Placement ${placement.id} selects the live Source ${playable.id}; a recorded, accepted Take is required`,
      );
    }
    if (!placement.take) continue;
    const entry = takeIndex.get(placement.take);
    if (!entry || entry.take.source !== recording.source.id) continue;
    const artifactEntry = artifactIndex.get(entry.take.artifact);
    if (!artifactEntry)
      throw new Error(
        `Take ${entry.take.id} references Artifact ${entry.take.artifact} that no succeeded Build declares`,
      );
    const { take } = entry;
    const { artifact } = artifactEntry;
    const production = builds.find(
      build =>
        build.status === 'succeeded' &&
        build.operations.some(operation => operation.kind === 'browser' && operation.artifact === artifact.id),
    );
    if (!production) throw new Error(`Take ${take.id} has no recorded-playback production provenance`);
    const buildId = production.id;
    if (take.frames !== recording.frames)
      throw new Error(`Take ${take.id} holds ${take.frames} frames but the recording holds ${recording.frames}`);
    if (stableHash(take.fps) !== stableHash(output.fps))
      throw new Error(`Take ${take.id} frame rate does not match the Composition output`);
    if (placement.inFrame < 0 || placement.outFrame <= placement.inFrame || placement.outFrame > recording.frames) {
      throw new Error(
        `Placement ${placement.id} reads source frames [${placement.inFrame}, ${placement.outFrame}) outside the recorded [0, ${recording.frames})`,
      );
    }
    // Verify the selected Take's artifact really is the bytes on disk.
    const artifactHash = await hashFile(await resolveProjectPath(root, artifact.path));
    if (artifactHash !== artifact.sha256)
      throw new Error(
        `Artifact ${artifact.id} hash mismatch: on-disk ${artifactHash.slice(0, 12)} != declared ${artifact.sha256.slice(0, 12)}`,
      );
    // Prove the Take genuinely belongs to THIS session: the Build's frozen
    // project must bind the same playable Source to the same recording path, and
    // (when frozen) the frozen recording bytes must match the current session.
    const frozenProjectRel = `.viscraft/snapshots/${buildId}.project.json`;
    let frozenProject;
    try {
      frozenProject = JSON.parse(await readFile(await resolveProjectPath(root, frozenProjectRel), 'utf8'));
    } catch (error) {
      throw new Error(
        `Build ${buildId} has no readable frozen project snapshot; cannot verify Take ${take.id} provenance (${error.code ?? error.message})`,
      );
    }
    const frozenSource = frozenProject.sources?.find(source => source.id === recording.source.id);
    if (!frozenSource || frozenSource.kind !== 'browser' || frozenSource.recording !== relativeRecording) {
      throw new Error(
        `Build ${buildId} was not built from session ${recordingId} for source ${recording.source.id}; refusing a Take from another session`,
      );
    }
    try {
      const frozenRecordingHash = await hashFile(
        await resolveProjectPath(root, `.viscraft/snapshots/${buildId}/${relativeRecording}`),
      );
      if (frozenRecordingHash !== sessionSha)
        throw new Error(`Build ${buildId} frozen recording bytes differ from the current session ${recordingId}`);
    } catch (error) {
      throw new Error(`Build ${buildId} cannot verify frozen recording bytes: ${error.message}`);
    }
    scored.push({ placement, take, artifact, buildId });
  }
  if (scored.length === 0) {
    throw new Error(`No Composition placement selects a Take from recording source ${recording.source.id}`);
  }
  // The score asset inherits the taint of its inputs; it is never claimed cleaner.
  const simulated =
    Boolean(recording.simulated) ||
    scored.some(({ take, artifact }) => Boolean(take.simulated) || Boolean(artifact.simulated));

  // ---- 3. Re-time recorded telemetry onto the Composition timeline ----------
  // Half-open source interval [inFrame,outFrame) is spread over the target
  // duration D (= durationFrames when a retime is set, else the source span N):
  // for output frame k, source frame = inFrame + floor(k*N/D).
  const totalFrames = compositionFrames(project);
  const sampleRate = output.sampleRate;
  const channels = output.channels;
  const totalSamples = framesToSamples(totalFrames, output.fps, sampleRate, 'ceil');

  const states = new Array(totalFrames).fill(null);
  const mapping = [];
  for (const { placement } of scored) {
    const n = placement.outFrame - placement.inFrame;
    const d = placement.durationFrames ?? n;
    for (let k = 0; k < d; k++) {
      const outFrame = placement.startFrame + k;
      if (outFrame >= totalFrames) break;
      const srcFrame = placement.inFrame + Math.floor((k * n) / d);
      if (srcFrame < placement.inFrame || srcFrame >= placement.outFrame || srcFrame >= recording.frames) {
        throw new Error(
          `Placement ${placement.id} mapped output frame ${outFrame} to out-of-bounds source frame ${srcFrame}`,
        );
      }
      states[outFrame] = { srcFrame, state: recording.states[srcFrame].state, placement: placement.id };
    }
    mapping.push({
      placement: placement.id,
      take: placement.take,
      inFrame: placement.inFrame,
      outFrame: placement.outFrame,
      sourceFrames: n,
      durationFrames: d,
      startFrame: placement.startFrame,
      retimed: d !== n,
    });
  }
  if (states.some(state => state === null)) {
    throw new Error(
      'This score requires recorded-Take coverage of the entire timeline; mixed live Sources, gaps or unrelated Takes are unsupported',
    );
  }

  // Real input events, mapped to source frames, then to output frames per placement.
  const intervals = new Map();
  for (const event of recording.events) {
    if (!intervals.has(event.key)) intervals.set(event.key, []);
    const list = intervals.get(event.key);
    if (event.type === 'down') list.push({ down: event.frame, up: recording.frames });
    else {
      const open = list.findLast(i => i.up === recording.frames);
      if (open) open.up = event.frame;
    }
  }
  const keyAt = (key, srcFrame) => (intervals.get(key) ?? []).some(i => srcFrame >= i.down && srcFrame < i.up);

  // Every frame is a real observed slot (full coverage is required above). A
  // missing or non-finite speed/offset is a real defect and is rejected rather
  // than silently defaulted; telemetry is never invented.
  const speedF = new Array(totalFrames).fill(0);
  const offsetF = new Array(totalFrames).fill(0);
  const brakeF = new Array(totalFrames).fill(0);
  const boostF = new Array(totalFrames).fill(0);
  for (let f = 0; f < totalFrames; f++) {
    const { srcFrame, state } = states[f];
    const speed = state?.speed;
    const offset = state?.offset;
    if (!Number.isFinite(speed) || !Number.isFinite(offset)) {
      throw new Error(
        `Scored output frame ${f} (source frame ${srcFrame}) must provide a finite observed speed/offset`,
      );
    }
    speedF[f] = speed;
    offsetF[f] = offset;
    brakeF[f] = keyAt('ArrowDown', srcFrame) ? 1 : 0;
    boostF[f] = keyAt('Space', srcFrame) ? 1 : 0;
  }
  const deltaF = new Array(totalFrames).fill(0);
  for (let f = 1; f < totalFrames; f++) deltaF[f] = Math.abs(offsetF[f] - offsetF[f - 1]);
  const STEER_REF = 0.06;
  const steerF = deltaF.map(d => clamp(d / STEER_REF, 0, 1));
  const SPEED_REF = Math.max(1, ...speedF);
  const loadF = speedF.map((v, f) =>
    clamp((0.4 + 0.55 * (v / SPEED_REF)) * (1 + 0.3 * boostF[f]) * (1 - 0.35 * brakeF[f]), 0.15, 1.2),
  );

  // Chimes ONLY from real checkpoint events inside a selected half-open source
  // interval [inFrame,outFrame). Crossing rule: the first output frame whose
  // mapped source reaches the event, k = ceil((i - inFrame) * D / N); if k
  // reaches D the event lies past this placement's output span at that ratio and
  // is DROPPED (reported, never faked).
  const checkpoints = [];
  const droppedCheckpoints = [];
  const seen = new Set();
  for (const { placement } of scored) {
    const n = placement.outFrame - placement.inFrame;
    const d = placement.durationFrames ?? n;
    for (let i = placement.inFrame; i < placement.outFrame; i++) {
      const events = recording.states[i]?.state?.checkpointEvents;
      if (!Array.isArray(events) || events.length === 0) continue;
      const offset = Math.ceil(((i - placement.inFrame) * d) / n);
      if (offset >= d) {
        for (const name of events)
          droppedCheckpoints.push({
            name: String(name),
            sourceFrame: i,
            placement: placement.id,
            reason: 'past the placement output span at this downsample ratio',
          });
        continue;
      }
      const outFrame = placement.startFrame + offset;
      for (const name of events) {
        const key = `${placement.id}:${i}:${String(name)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        checkpoints.push({ name: String(name), sourceFrame: i, outputFrame: outFrame, placement: placement.id });
      }
    }
  }

  // ---- 4. Synthesize the original score on the canonical sample clock ------
  // Seed from the recorded content (Source key + real events + states + the edit
  // mapping), NOT the random session UUID, so identical observed play yields the
  // identical score.
  const seed =
    parseInt(
      stableHash({
        sourceKey: recording.source.key,
        events: recording.events,
        states: recording.states,
        mapping,
      }).slice(0, 8),
      16,
    ) >>> 0;
  const rng = [mulberry32(seed ^ 0x9e3779b9), mulberry32((seed ^ 0x85ebca6b) + 1)];
  const mix = new Float32Array(totalSamples * channels);
  const rolePeak = { engine: 0, tire: 0, brake: 0, ambience: 0, music: 0, chime: 0 };

  const weights = [];
  let weightSum = 0;
  for (let h = 1; h <= HARMONICS; h++) {
    const w = 1 / Math.pow(h, 1.25);
    weights.push(w);
    weightSum += w;
  }
  for (let h = 0; h < HARMONICS; h++) weights[h] /= weightSum;

  let phase = [0, 0];
  let tireLp = [0, 0];
  let brakeLp = [0, 0];
  let ambLp = [0, 0];
  const frameSpan = output.fps.denominator * sampleRate; // samples per numerator-of-frame
  for (let s = 0; s < totalSamples; s++) {
    const ff = (s * output.fps.numerator) / frameSpan;
    const f0 = Math.min(totalFrames - 1, Math.floor(ff));
    const f1 = Math.min(totalFrames - 1, f0 + 1);
    const a = ff - f0;
    const lerp = arr => arr[f0] + (arr[f1] - arr[f0]) * a;
    const speed = lerp(speedF);
    const load = lerp(loadF);
    const steer = lerp(steerF);
    const brake = lerp(brakeF);

    // engine: phase-continuous harmonics, frequency + gain from observed speed.
    const fundamental = 46 + 24 * speed;
    const step = (2 * Math.PI * fundamental) / sampleRate;
    phase[0] += step;
    phase[1] += step * 1.0035;
    const engineAmp = ENGINE_GAIN * load;
    let eL = 0,
      eR = 0;
    for (let h = 1; h <= HARMONICS; h++) {
      eL += weights[h - 1] * Math.sin(h * phase[0]);
      eR += weights[h - 1] * Math.sin(h * phase[1]);
    }
    eL *= engineAmp;
    eR *= engineAmp;
    rolePeak.engine = Math.max(rolePeak.engine, Math.abs(eL), Math.abs(eR));

    const white = [rng[0]() * 2 - 1, rng[1]() * 2 - 1];
    const tire = [0, 0],
      brakeBand = [0, 0],
      amb = [0, 0];
    const tireCut = clamp(0.015 + 0.55 * steer, 0.01, 0.6);
    const tireAmp = TIRE_GAIN * (0.06 * speed + 1.15 * steer);
    const brakeAmp = BRAKE_GAIN * brake * (0.35 + 0.22 * speed);
    const trem = AMBIENCE_GAIN * (0.7 + 0.3 * Math.sin(2 * Math.PI * 0.13 * (s / sampleRate)));
    for (let c = 0; c < channels; c++) {
      tireLp[c] += (white[c] - tireLp[c]) * tireCut;
      brakeLp[c] += (white[c] - brakeLp[c]) * 0.25;
      ambLp[c] += (white[c] - ambLp[c]) * 0.03;
      tire[c] = tireLp[c] * tireAmp;
      brakeBand[c] = (white[c] - brakeLp[c]) * brakeAmp;
      amb[c] = ambLp[c] * trem;
    }
    rolePeak.tire = Math.max(rolePeak.tire, Math.abs(tire[0]), Math.abs(tire[1]));
    rolePeak.brake = Math.max(rolePeak.brake, Math.abs(brakeBand[0]), Math.abs(brakeBand[1]));
    rolePeak.ambience = Math.max(rolePeak.ambience, Math.abs(amb[0]), Math.abs(amb[1]));

    if (channels === 1) {
      mix[s] = eL + tire[0] + brakeBand[0] + amb[0];
      continue;
    }
    mix[s * 2] = eL + tire[0] + brakeBand[0] + amb[0];
    mix[s * 2 + 1] = eR + tire[1] + brakeBand[1] + amb[1];
  }

  // music: an original 120 BPM pulse, continuous across the whole output.
  const beatFrames = Math.max(1, Math.round((output.fps.numerator / output.fps.denominator) * 0.5));
  const bassNotes = [55.0, 55.0, 73.42, 65.41];
  const leadNotes = [440.0, 466.16, 523.25, 587.33, 440.0, 523.25, 659.25, 587.33];
  const beats = Math.ceil(totalFrames / beatFrames);
  let musicVoices = 0;
  for (let b = 0; b < beats; b++) {
    const startFrame = b * beatFrames;
    if (startFrame >= totalFrames) break;
    const sample = framesToSamples(startFrame, output.fps, sampleRate, 'floor');
    const drive = 0.7 + 0.3 * clamp(speedF[startFrame] / SPEED_REF, 0, 1);
    rolePeak.music = Math.max(
      rolePeak.music,
      addNote(
        mix,
        channels,
        sampleRate,
        sample,
        bassNotes[b % bassNotes.length],
        0.42,
        MUSIC_BASS_GAIN * drive,
        [
          [1, 1],
          [2, 0.4],
          [3, 0.18],
        ],
        1,
        1,
        totalSamples,
      ),
    );
    const pan = b % 2 === 0 ? 0.85 : 0.55;
    rolePeak.music = Math.max(
      rolePeak.music,
      addNote(
        mix,
        channels,
        sampleRate,
        sample,
        leadNotes[b % leadNotes.length],
        0.16,
        MUSIC_LEAD_GAIN * drive,
        [
          [1, 1],
          [2, 0.25],
        ],
        pan,
        1 - pan * 0.35,
        totalSamples,
      ),
    );
    musicVoices += 2;
  }

  // chime: only real checkpoint events; tail may ring past a cut within the timeline.
  for (const checkpoint of checkpoints) {
    const sample = framesToSamples(checkpoint.outputFrame, output.fps, sampleRate, 'floor');
    rolePeak.chime = Math.max(
      rolePeak.chime,
      addNote(
        mix,
        channels,
        sampleRate,
        sample,
        1046.5,
        0.5,
        CHIME_GAIN,
        [
          [1, 1],
          [1.5, 0.55],
          [2.76, 0.2],
        ],
        1,
        1,
        totalSamples,
      ),
    );
  }

  // ---- 5. Headroom, click-free edges, and clip rejection --------------------
  const fade = Math.min(300, Math.floor(totalSamples / 4));
  for (let c = 0; c < channels; c++) {
    for (let i = 0; i < fade; i++) {
      mix[i * channels + c] *= i / fade;
      mix[(totalSamples - 1 - i) * channels + c] *= i / fade;
    }
  }
  let samplePeak = 0;
  for (let i = 0; i < mix.length; i++) {
    const v = mix[i];
    if (!Number.isFinite(v)) throw new Error(`Non-finite sample at index ${i}; synthesis is broken`);
    samplePeak = Math.max(samplePeak, Math.abs(v));
  }
  let headroomScale = 1;
  if (samplePeak > HEADROOM_CEILING) {
    headroomScale = HEADROOM_CEILING / samplePeak;
    for (let i = 0; i < mix.length; i++) mix[i] *= headroomScale;
    samplePeak *= headroomScale;
  }
  if (samplePeak > 0.99)
    throw new Error(`Synthetic score would clip (sample peak ${samplePeak.toFixed(4)}); lower role gains`);

  const channelPeak = [0, 0];
  for (let i = 0; i < mix.length; i++)
    channelPeak[i % channels] = Math.max(channelPeak[i % channels], Math.abs(mix[i]));

  const wav = encodeWav(mix, sampleRate, channels);
  const sha256 = createHash('sha256').update(wav).digest('hex');
  const relativeWav = `assets/race-score-${sha256.slice(0, 16)}.wav`;
  const absoluteWav = await resolveProjectPath(root, relativeWav);
  await mkdir(dirname(absoluteWav), { recursive: true });
  try {
    await writeFile(absoluteWav, wav, { flag: 'wx', mode: 0o644 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if ((await hashFile(absoluteWav)) !== sha256)
      throw new Error(`Refusing to overwrite existing asset ${relativeWav}: content hash differs`);
  }

  // ---- 6. Publish the score as one audio Asset + one asset clip ------------
  const ASSET_ID = 'asset_race_score';
  const ORIGIN = `original: recorded-telemetry-driven procedural synthesis from real Playable session ${recording.id} (source ${recording.source.id}); synthesized in-score from the recorded state and input events; no external audio`;
  const existing = project.assets.find(asset => asset.id === ASSET_ID);
  if (
    existing &&
    !String(existing.rights?.origin ?? '').startsWith('original: recorded-telemetry-driven procedural synthesis')
  ) {
    throw new Error(`Asset ${ASSET_ID} already exists but is not this script's score; refusing to replace it`);
  }
  const unchanged = existing && existing.path === relativeWav && existing.sha256 === sha256;
  const assetRevision = existing ? (unchanged ? existing.revision : existing.revision + 1) : 1;
  const clipId = 'score_race_recording';

  const next = structuredClone(project);
  const assetRecord = {
    id: ASSET_ID,
    revision: assetRevision,
    path: relativeWav,
    sha256,
    type: 'audio',
    rights: { origin: ORIGIN, license: 'CC0-1.0', redistributable: true },
    simulated,
  };
  const assetAt = next.assets.findIndex(asset => asset.id === ASSET_ID);
  if (assetAt >= 0) next.assets[assetAt] = assetRecord;
  else next.assets.push(assetRecord);
  next.composition.audio = [
    {
      id: clipId,
      kind: 'asset',
      asset: ASSET_ID,
      inSample: 0,
      startSample: 0,
      durationSamples: totalSamples,
      gain: 1,
      fadeInSamples: 0,
      fadeOutSamples: 0,
    },
  ];

  const changed = stableHash(next) !== stableHash(project);
  let revision = project.revision;
  if (changed) revision = (await saveProject(root, next, project.revision)).revision;

  const roles = [
    roleState(
      'engine',
      ENGINE_GAIN,
      HARMONICS,
      rolePeak.engine,
      'phase-continuous harmonic stack; frequency and gain from observed speed, boost/brake weighted; controls interpolated across cuts so phase never restarts',
    ),
    roleState(
      'tire',
      TIRE_GAIN,
      2,
      rolePeak.tire,
      'two seeded-noise streams through a one-pole filter driven by the observed lateral offset delta',
    ),
    roleState(
      'brake',
      BRAKE_GAIN,
      2,
      rolePeak.brake,
      'seeded high-passed noise keyed by real ArrowDown input events mapped to source frames',
    ),
    roleState(
      'chime',
      CHIME_GAIN,
      checkpoints.length,
      rolePeak.chime,
      'short bell struck only by real checkpoint events inside a selected source interval; tail may ring past a cut',
    ),
    roleState('ambience', AMBIENCE_GAIN, 2, rolePeak.ambience, 'continuous seeded road wash spanning the whole output'),
    roleState(
      'music',
      MUSIC_BASS_GAIN + MUSIC_LEAD_GAIN,
      musicVoices,
      rolePeak.music,
      'original 120 BPM bass + lead pulse pattern spanning the whole output',
    ),
  ];

  const report = {
    project: root,
    recording: {
      id: recording.id,
      frames: recording.frames,
      simulated: recording.simulated,
      source: recording.source.id,
      sourceKey: recording.source.key,
    },
    clock: {
      fps: output.fps,
      sampleRate,
      channels,
      frames: totalFrames,
      samples: totalSamples,
      durationSeconds: totalSamples / sampleRate,
      perFrameMapping: 'source = inFrame + floor(k*N/D)',
      spanMapping: 'framesToSamples(frames,fps,sampleRate,ceil)',
    },
    coverage:
      'every output frame is covered by a scored Take of this recording; mixed live Sources / gaps / unrelated Takes are rejected',
    placements: mapping,
    takes: [
      ...new Map(
        scored.map(entry => [
          entry.take.id,
          {
            take: entry.take.id,
            artifact: entry.artifact.id,
            build: entry.buildId,
            artifactSha256: entry.artifact.sha256,
            artifactVerified: true,
          },
        ]),
      ).values(),
    ],
    events: {
      checkpoints,
      droppedCheckpoints,
      crossingRule: 'ceil((sourceFrame - inFrame) * D / N) = first output frame whose mapped source reaches the event',
      input: {
        brakeOutputFrames: brakeF.flatMap((v, f) => (v ? [f] : [])),
        boostOutputFrames: boostF.flatMap((v, f) => (v ? [f] : [])),
      },
      note: 'only real observed checkpoint events and real ArrowDown/Space inputs are used; no telemetry is invented',
    },
    roles,
    wav: {
      path: relativeWav,
      sha256,
      bytes: wav.length,
      frames: totalSamples,
      samplePeakL: channelPeak[0],
      samplePeakR: channelPeak[1] ?? channelPeak[0],
      samplePeak,
      headroomScale,
      ceiling: HEADROOM_CEILING,
      sumOfRolePeaks: Object.values(rolePeak).reduce((a, b) => a + b, 0),
      format: 'PCM16LE / 44-byte header',
    },
    asset: {
      id: ASSET_ID,
      revision: assetRevision,
      license: 'CC0-1.0',
      redistributable: true,
      simulated,
      origin: ORIGIN,
    },
    composition: { audioClips: [clipId], replacedBaselineTones: true, projectRevision: revision, saved: changed },
    engine: { harnessNote: 'no browser, no Source execution, no buildProject call, no FFmpeg, no network' },
    limits: [
      'stylized procedural synthesis driven by kinematic telemetry; NOT a real recorded engine and NOT physically accurate Foley',
      'the recording is real observed play state, but the driving model is deliberately kinematic (no vehicle physics is claimed)',
      'music and ambience are original fixed patterns (music bus lightly scaled by observed speed); engine/tire/brake/chime are the telemetry/event-driven voices',
      'samplePeak is a digital sample peak, not an oversampled true-peak; true-peak acceptance is measured downstream by the Build/Mux FFmpeg stage',
    ],
  };
  console.log(JSON.stringify(report, null, 2));
}

await main();
