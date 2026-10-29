import {
  type Composition,
  type Ducking,
  type Project,
  requireComposition,
  type OutputSettings,
  type AudioClip,
} from '../../core/schema.js';
import { framesToSamples } from '../../core/time.js';
import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import { decodePcm, encodeWav } from './pcm.js';
import { resolveProjectPath } from '../../shared/fs.js';
import { hasAudioStream } from './probe.js';

/**
 * A source media file whose embedded audio is kept, placed at a timeline frame.
 * `gain`, `fadeInSamples`, `fadeOutSamples`, `offsetSamples`, `tailSamples` and
 * `leadSamples` shape the kept clip; absent/omitted values use the default
 * placement (unit gain, no fades, zero offset/tail/lead).
 *
 * Cut semantics on the provider Take's own audio:
 *  - `leadSamples > 0` is a J-cut: the audio leads the picture, starting before
 *    `startFrame` by reading the Take's OWN pre-roll from `takePath` at
 *    `takeInSample - leadSamples .. takeInSample`. `startFrame` itself is NOT
 *    moved, so the body stays sample-aligned to the picture.
 *  - `tailSamples > 0` is an L-cut: the audio trails past the picture cut, so
 *    the clip's audio extent becomes `clipFrames + tailSamples` on the OUTPUT
 *    timeline, but the extra span is read from the Take at `takePath` on the
 *    Take's own SOURCE clock, starting at `takeInSample + takeBodySamples` (the
 *    end of the source interval the body was trimmed/retimed from) — NOT at the
 *    body's output-clock length `clipFrames`, which a retime inflates and which
 *    would index past the intended source position (silently reading past the
 *    Take's audio). A negative value shortens the extent; a non-positive extent
 *    is rejected.
 *  - Fades stay sample-exact over the (possibly extended) extent.
 *  - `offsetSamples` is a DIFFERENT, deliberate primitive: it shifts the ENTIRE
 *    kept clip — body included — earlier (negative) or later (positive) in time.
 *    It is a global time-shift, NOT a J-cut: because it moves the whole clip it
 *    desynchronises lip-/action-sync inside that clip. Prefer `leadSamples` for a
 *    true cross-cut audio lead.
 *
 * `bus` also routes the kept audio into a named grouped stem while it stays part
 * of the full programme mix.
 */
export interface KeptAudio {
  path: string;
  startFrame: number;
  gain?: number;
  fadeInSamples?: number;
  fadeOutSamples?: number;
  offsetSamples?: number;
  tailSamples?: number;
  leadSamples?: number;
  takePath?: string;
  takeInSample?: number;
  /**
   * The body's SOURCE length on the Take's own frame clock: the sample span
   * between the source interval's start and end (`outFrame - inFrame` mapped
   * through the Take fps). The L-cut reads its tail from the Take at
   * `takeInSample + takeBodySamples` (the end of the body's SOURCE interval),
   * NOT at the body's output-clock length — under a retime those differ and the
   * output-clock length indexes past the source the body was taken from. It is
   * only consulted when an L-cut tail is present (`tailSamples > 0`), and a
   * declared tail without it is REFUSED loudly: the source interval end cannot
   * be inferred from the (possibly retimed) body, so there is no silent fallback.
   */
  takeBodySamples?: number;
  bus?: string;
}

/** Linear fade envelope over a half-open clip of `duration` samples. */
function fadeFactor(index: number, duration: number, fadeIn: number, fadeOut: number): number {
  let factor = 1;
  if (fadeIn > 0 && index < fadeIn) factor = Math.min(factor, index / fadeIn);
  if (fadeOut > 0 && index >= duration - fadeOut) factor = Math.min(factor, (duration - index) / fadeOut);
  return factor;
}

function automatedGain(clip: Composition['audio'][number], sample: number): number {
  const points = clip.automation;
  if (!points) return 1;
  if (sample <= points[0].sample) return points[0].gain;
  for (let i = 1; i < points.length; i++) {
    if (sample <= points[i].sample) {
      const a = points[i - 1],
        b = points[i];
      return a.gain + ((b.gain - a.gain) * (sample - a.sample)) / (b.sample - a.sample);
    }
  }
  return points.at(-1)!.gain;
}

/**
 * Authored stereo position at a local clip sample: an explicit `panAutomation`
 * curve (held at the endpoints, linearly interpolated between points) wins over
 * a constant `pan`. `undefined` means the clip is not spatially placed and keeps
 * the default centred position (no pan).
 */
function automatedPan(clip: Composition['audio'][number], sample: number): number | undefined {
  const points = clip.panAutomation;
  if (!points) return clip.pan;
  if (sample <= points[0].sample) return points[0].pan;
  for (let i = 1; i < points.length; i++) {
    if (sample <= points[i].sample) {
      const a = points[i - 1],
        b = points[i];
      return a.pan + ((b.pan - a.pan) * (sample - a.sample)) / (b.sample - a.sample);
    }
  }
  return points.at(-1)!.pan;
}

/**
 * Place a rendered code-authored sound Take (already decoded to the output clock)
 * on the timeline. Unlike an `asset` clip there is no `inSample`: the Source owns
 * the whole extent, so the clip starts the Take at local sample 0 and the fade
 * envelope spans the Take's own length.
 */
function mixSoundClip(
  acc: Float32Array,
  totalSamples: number,
  channels: number,
  pcm: Float32Array,
  clip: Extract<Composition['audio'][number], { kind: 'source' }>,
): void {
  const startSample = clip.startSample;
  const gain = clip.gain;
  const fadeIn = clip.fadeInSamples;
  const fadeOut = clip.fadeOutSamples;
  const clipFrames = Math.floor(pcm.length / channels);
  const end = Math.min(startSample + clipFrames, totalSamples);
  const spatial = clip.pan !== undefined || clip.panAutomation !== undefined;

  for (let s = startSample; s < end; s++) {
    const i = s - startSample;
    const gainHere = gain * fadeFactor(i, clipFrames, fadeIn, fadeOut) * automatedGain(clip, i);
    if (spatial) {
      const [left, right] = channelGains(automatedPan(clip, i)!, channels);
      acc[s * channels] += pcm[i * channels] * gainHere * left;
      acc[s * channels + 1] += pcm[i * channels + 1] * gainHere * right;
    } else {
      for (let c = 0; c < channels; c++) acc[s * channels + c] += pcm[i * channels + c] * gainHere;
    }
  }
}

/**
 * Constant-power stereo gains for an authored position `pan` in [-1, 1]
 * (-1 hard left, 0 centre, +1 hard right): gL = cos φ, gR = sin φ with
 * φ = (pan + 1)·π/4, so gL² + gR² = 1 and neither channel ever exceeds unity.
 * A centred spatial clip is therefore −3.01 dB per channel by design (raise clip
 * gain if needed). Panning is amplitude-only; it adds no HRTF, room or Doppler.
 */
function channelGains(pan: number, channels: number): [number, number] {
  if (channels !== 2)
    throw new Error('mixAudio: authored stereo pan requires a 2-channel output; a mono output has no left/right field');
  const phi = ((pan + 1) * Math.PI) / 4;
  return [Math.cos(phi), Math.sin(phi)];
}

function mixAssetClip(
  acc: Float32Array,
  totalSamples: number,
  channels: number,
  pcm: Float32Array,
  clip: Extract<Composition['audio'][number], { kind: 'asset' }>,
): void {
  const startSample = clip.startSample;
  const duration = clip.durationSamples;
  const gain = clip.gain;
  const fadeIn = clip.fadeInSamples;
  const fadeOut = clip.fadeOutSamples;
  const sourceFrames = Math.floor(pcm.length / channels);
  const end = Math.min(startSample + duration, totalSamples);
  const spatial = clip.pan !== undefined || clip.panAutomation !== undefined;

  for (let s = startSample; s < end; s++) {
    const i = s - startSample;
    const sourceFrame = clip.inSample + i;
    if (sourceFrame < 0 || sourceFrame >= sourceFrames) continue;
    const gainHere = gain * fadeFactor(i, duration, fadeIn, fadeOut) * automatedGain(clip, i);
    if (spatial) {
      // Constant-power placement of channel 0/1. For a mono source (or any
      // source decoded to two identical channels) this is a true pan; for a
      // genuinely stereo source it acts as a balance law.
      const [left, right] = channelGains(automatedPan(clip, i)!, channels);
      acc[s * channels] += pcm[sourceFrame * channels] * gainHere * left;
      acc[s * channels + 1] += pcm[sourceFrame * channels + 1] * gainHere * right;
    } else {
      for (let c = 0; c < channels; c++) acc[s * channels + c] += pcm[sourceFrame * channels + c] * gainHere;
    }
  }
}

/**
 * Fail loudly instead of silently clipping. A mix that exceeds full scale is an
 * authoring error; the caller must lower clip gains (no limiter is applied).
 */
function assertWithinRange(samples: Float32Array): void {
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    if (!Number.isFinite(v)) {
      throw new Error(`mixAudio: non-finite sample at index ${i}; check clip sample ranges`);
    }
    if (Math.abs(v) > 1) {
      throw new Error(`mixAudio: output overloaded (index ${i} = ${v.toFixed(6)}, |v| > 1); lower clip gains`);
    }
  }
}

/**
 * Deterministic envelope-following ducking curve for one `Ducking` rule.
 *
 * The already-mixed control bus is decoded to a mono signal. A squared-signal
 * one-pole detector (10 ms time constant) yields a level track. Above
 * `thresholdDb` the level requests `(levelDb - thresholdDb) * (1/ratio - 1)` dB
 * (always <= 0), floored at `maxAttenuationDb`. The gain lives in the dB domain
 * and moves with a one-pole attack when it attenuates further, or release when
 * it recovers. The returned per-sample multiplier is `10^(g/20)` and always lies
 * in (0, 1].
 *
 * This is an envelope-following, bus-keyed rule with a gain floor — not
 * dialogue detection, a full compressor, a lookahead limiter or a
 * broadcast-standard sidechain.
 */
function duckingGainCurve(
  controlPcm: Float32Array,
  sampleRate: number,
  channels: number,
  totalSamples: number,
  entry: Ducking,
): Float32Array {
  const thresholdDb = entry.thresholdDb ?? -30;
  const ratio = entry.ratio ?? 4;
  const maxAttenuationDb = entry.maxAttenuationDb ?? -18;
  const attackSamples = Math.max(1, entry.attackSamples ?? Math.round(sampleRate * 0.005));
  const releaseSamples = Math.max(1, entry.releaseSamples ?? Math.round(sampleRate * 0.2));
  const detectorA = 1 / Math.max(1, Math.round(sampleRate * 0.01));
  const slope = 1 / ratio - 1; // negative: louder control => more reduction
  const controlFrames = Math.floor(controlPcm.length / channels);
  const curve = new Float32Array(totalSamples);
  let meanSquare = 0;
  let gainDb = 0;
  for (let i = 0; i < totalSamples; i++) {
    let x = 0;
    if (i < controlFrames) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += controlPcm[i * channels + c];
      x = sum / channels;
    }
    meanSquare += detectorA * (x * x - meanSquare);
    const level = Math.sqrt(meanSquare);
    const levelDb = 20 * Math.log10(Math.max(level, 1e-6));
    let targetDb = levelDb > thresholdDb ? (levelDb - thresholdDb) * slope : 0;
    if (targetDb < maxAttenuationDb) targetDb = maxAttenuationDb;
    const coefficient = targetDb < gainDb ? attackSamples : releaseSamples;
    gainDb += (targetDb - gainDb) / coefficient;
    curve[i] = 10 ** (gainDb / 20);
  }
  return curve;
}

/**
 * Mix the audio timeline into a single WAV at the composition sample rate.
 *
 * Sources mixed (all half-open sample intervals):
 *  - explicit `asset` audio clips (decoded, offset by `inSample`),
 *  - rendered `source` sound clips (decoded from their built Take),
 *  - `kept` embedded audio from placements (placed at `startFrame`).
 *
 * Each source may span across video cuts; audio is independent of the edit.
 *
 * `bus` selects one grouped stem: only clips/kept entries whose own `bus`
 * equals it are summed. When `bus` is undefined the FULL programme mix is
 * summed (every member, routed or not) — a stem is an additional grouped
 * export and never subtracts audio from the programme. A `bus` with no
 * matching member is a loud error, never a silent empty stem.
 *
 * `ducking` applies bus-keyed automatic sidechain ducking. In the full
 * programme pass (bus undefined) an entry attenuates members whose own `bus`
 * equals `entry.target`; in a grouped stem pass (bus `x`) only entries whose
 * `target` equals `x` apply. For each applicable entry the control bus is
 * mixed to a temporary WAV by re-invoking this function with `bus = control`
 * and no ducking (recursion depth 1), then a per-sample gain curve is applied
 * to its target members. A `target` or `control` bus with no members is a loud
 * error. Absent or empty `ducking` applies no sidechain reduction.
 */
export async function mixAudio(
  root: string,
  project: Project,
  kept: KeptAudio[],
  totalFrames: number,
  destination: string,
  soundTakes?: ReadonlyMap<string, string>,
  bus?: string,
  ducking?: readonly Ducking[],
): Promise<void> {
  const composition = requireComposition(project);
  if (!Number.isInteger(totalFrames) || totalFrames <= 0) {
    throw new Error(`mixAudio: totalFrames must be a positive integer, got ${totalFrames}`);
  }
  // The FILM caller is the only one that converts a frame count into a sample
  // span; the mixer core itself runs on exact samples (Ceil so the audio always
  // fully covers the final frame's time span).
  const totalSamples = framesToSamples(totalFrames, composition.output.fps, composition.output.sampleRate, 'ceil');
  return mixAudioSamples(
    root,
    project,
    kept,
    { output: composition.output, totalSamples, clips: composition.audio },
    destination,
    soundTakes,
    bus,
    ducking,
  );
}

/** What the mixer core needs: an exact sample span, its output facts and the clips on it. */
export interface MixClock {
  output: OutputSettings;
  /** The EXACT delivered per-channel span. Never re-derived from frames here. */
  totalSamples: number;
  clips: readonly AudioClip[];
}

/**
 * Mix exactly `clock.totalSamples` samples at `clock.output`'s rate/channels.
 * A film converts its frame count at the call site; a sound target passes its
 * authored `outputSamples` directly, so a sound programme's length is never
 * subject to a picture FPS.
 */
export async function mixAudioSamples(
  root: string,
  project: Project,
  kept: KeptAudio[],
  clock: MixClock,
  destination: string,
  soundTakes?: ReadonlyMap<string, string>,
  bus?: string,
  ducking?: readonly Ducking[],
): Promise<void> {
  const { output, totalSamples, clips } = clock;
  const sampleRate = output.sampleRate;
  const channels = output.channels;
  if (!Number.isSafeInteger(totalSamples) || totalSamples <= 0) {
    throw new Error(`mixAudioSamples: totalSamples must be a positive safe integer, got ${totalSamples}`);
  }

  const acc = new Float32Array(totalSamples * channels);
  const tmpDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-audio-'));

  try {
    // Build one ducking curve per applicable target bus. The control bus signal
    // is produced by mixing it as its own grouped stem (recursion depth 1: that
    // call is made with no ducking), so the detector always sees the real mixed
    // control audio, not raw clip parameters.
    const duckingEntries = ducking ?? [];
    const applicableDucking = bus === undefined ? duckingEntries : duckingEntries.filter(entry => entry.target === bus);
    const curves = new Map<string, Float32Array>();
    if (applicableDucking.length > 0) {
      const memberBuses = new Set<string>();
      for (const clip of clips) {
        if (bus !== undefined && clip.bus !== bus) continue;
        if (clip.bus !== undefined) memberBuses.add(clip.bus);
      }
      for (const entry of kept) {
        if (bus !== undefined && entry.bus !== bus) continue;
        if (entry.bus !== undefined) memberBuses.add(entry.bus);
      }
      let controlCounter = 0;
      for (const entry of applicableDucking) {
        if (!memberBuses.has(entry.target)) {
          throw new Error(
            `mixAudio: ducking target bus "${entry.target}" has no members; refusing an inert ducking rule`,
          );
        }
        const controlPath = nodePath.join(tmpDir, `duck-control-${controlCounter++}.wav`);
        await mixAudioSamples(root, project, kept, clock, controlPath, soundTakes, entry.control);
        const controlPcm = await decodePcm(controlPath, sampleRate, channels, tmpDir, false);
        const curve = duckingGainCurve(controlPcm, sampleRate, channels, totalSamples, entry);
        const previous = curves.get(entry.target);
        // Two rules on the same target compose multiplicatively.
        if (previous) for (let i = 0; i < curve.length; i++) curve[i] *= previous[i];
        curves.set(entry.target, curve);
      }
    }
    // A ducked member is mixed into a reused zeroed scratch buffer and then
    // scaled by its curve, so the three mixing helpers keep their straight `+=`
    // form and un-ducked members mix exactly as without ducking.
    const scratch = curves.size > 0 ? new Float32Array(totalSamples * channels) : undefined;
    let members = 0;
    for (const clip of clips) {
      if (bus !== undefined && clip.bus !== bus) continue;
      members++;
      // A sound clip's envelope spans its Source's rendered length; other kinds
      // declare their own `durationSamples`.
      const bound =
        clip.kind === 'source'
          ? (() => {
              const source = project.sources.find(candidate => candidate.id === clip.source);
              if (!source || source.kind !== 'browser' || source.output !== 'sound')
                throw new Error(`mixAudio: sound clip ${clip.id} references unknown sound Source ${clip.source}`);
              // The clip occupies the Source's native DURATION on the target
              // clock: seconds are preserved, so a rate mismatch resamples
              // instead of stretching.
              return Math.ceil((source.durationSamples * sampleRate) / source.sampleRate);
            })()
          : clip.durationSamples;
      for (let i = 0; i < (clip.automation?.length ?? 0); i++) {
        const point = clip.automation![i];
        if (point.sample >= bound || (i > 0 && point.sample <= clip.automation![i - 1].sample))
          throw new Error(`mixAudio: invalid local gain automation for ${clip.id}`);
      }
      for (let i = 0; i < (clip.panAutomation?.length ?? 0); i++) {
        const point = clip.panAutomation![i];
        if (point.sample >= bound || (i > 0 && point.sample <= clip.panAutomation![i - 1].sample))
          throw new Error(`mixAudio: invalid local pan automation for ${clip.id}`);
      }
      if ((clip.pan !== undefined || clip.panAutomation !== undefined) && channels !== 2)
        throw new Error(
          `mixAudio: audio clip ${clip.id} authors a stereo pan but the output has ${channels} channel(s); use a 2-channel output or remove the pan`,
        );
      const clipCurve = clip.bus !== undefined ? curves.get(clip.bus) : undefined;
      const clipSink = clipCurve ? scratch! : acc;
      if (clipCurve) clipSink.fill(0);
      if (clip.kind === 'source') {
        const file = soundTakes?.get(clip.source);
        if (!file)
          throw new Error(
            `mixAudio: sound clip ${clip.id} has no rendered Take for Source ${clip.source}; build the sound Source before mixing`,
          );
        const pcm = await decodePcm(file, sampleRate, channels, tmpDir);
        if (pcm.length === 0) throw new Error(`mixAudio: sound clip ${clip.id} rendered no samples`);
        mixSoundClip(clipSink, totalSamples, channels, pcm, clip);
      } else {
        const asset = project.assets.find(a => a.id === clip.asset);
        if (!asset) throw new Error(`mixAudio: audio clip ${clip.id} references unknown asset ${clip.asset}`);
        const absolute = await resolveProjectPath(root, asset.path);
        const pcm = await decodePcm(absolute, sampleRate, channels, tmpDir);
        const sourceFrames = Math.floor(pcm.length / channels);
        if (clip.inSample + clip.durationSamples > sourceFrames) {
          throw new Error(
            `mixAudio: audio clip ${clip.id} reads samples [${clip.inSample}, ${clip.inSample + clip.durationSamples}) ` +
              `but asset only has ${sourceFrames}`,
          );
        }
        mixAssetClip(clipSink, totalSamples, channels, pcm, clip);
      }
      if (clipCurve)
        for (let k = 0; k < clipSink.length; k++) acc[k] += clipSink[k] * clipCurve[Math.floor(k / channels)];
    }

    for (const entry of kept) {
      if (bus !== undefined && entry.bus !== bus) continue;
      members++;
      const gain = entry.gain ?? 1;
      const fadeInSamples = entry.fadeInSamples ?? 0;
      const fadeOutSamples = entry.fadeOutSamples ?? 0;
      const offsetSamples = entry.offsetSamples ?? 0;
      const tailSamples = entry.tailSamples ?? 0;
      const leadSamples = entry.leadSamples ?? 0;
      if (!Number.isFinite(gain) || gain < 0 || gain > 2) {
        throw new Error(`mixAudio: kept entry has invalid gain ${gain}; expected a finite value in [0, 2]`);
      }
      if (
        !Number.isInteger(fadeInSamples) ||
        fadeInSamples < 0 ||
        !Number.isInteger(fadeOutSamples) ||
        fadeOutSamples < 0
      ) {
        throw new Error(`mixAudio: kept entry has invalid fade length (in ${fadeInSamples}, out ${fadeOutSamples})`);
      }
      if (!Number.isInteger(offsetSamples)) {
        throw new Error(`mixAudio: kept entry has invalid offsetSamples ${offsetSamples}`);
      }
      if (!Number.isInteger(tailSamples)) {
        throw new Error(`mixAudio: kept entry has invalid tailSamples ${tailSamples}`);
      }
      if (
        entry.takeBodySamples !== undefined &&
        (!Number.isSafeInteger(entry.takeBodySamples) || entry.takeBodySamples < 0)
      ) {
        throw new Error(
          `mixAudio: kept entry has invalid takeBodySamples ${entry.takeBodySamples}; expected a nonnegative safe integer`,
        );
      }
      // A lead is a nonnegative pre-roll length: it never moves the body.
      if (!Number.isInteger(leadSamples) || leadSamples < 0) {
        throw new Error(`mixAudio: kept entry has invalid leadSamples ${leadSamples}; expected a nonnegative integer`);
      }
      if (!Number.isInteger(entry.startFrame) || entry.startFrame < 0) {
        throw new Error(`mixAudio: kept entry has invalid startFrame ${entry.startFrame}`);
      }
      const startSample = framesToSamples(entry.startFrame, output.fps, sampleRate, 'nearest') + offsetSamples;
      // The body begins at `startSample`; a J-cut adds `leadSamples` of Take
      // pre-roll BEFORE it, so the leading edge is `startSample - leadSamples`.
      const leadStart = startSample - leadSamples;
      if (leadStart < 0) {
        throw new Error(
          `mixAudio: kept entry starts before the programme (sample ${leadStart}); reduce the negative offset or lead`,
        );
      }
      if (startSample >= totalSamples) {
        throw new Error(
          `mixAudio: kept entry starts past the programme end (sample ${startSample} >= ${totalSamples}); reduce the offset`,
        );
      }
      // Only a genuinely absent audio stream is skipped. If the source declares
      // an audio stream, a decode failure is a real error and must surface.
      if (!(await hasAudioStream(entry.path))) continue;
      const pcm = await decodePcm(entry.path, sampleRate, channels, tmpDir);
      if (pcm.length === 0) {
        throw new Error(`mixAudio: kept source ${entry.path} declares audio but decoded no samples`);
      }
      const entryCurve = entry.bus !== undefined ? curves.get(entry.bus) : undefined;
      const entrySink = entryCurve ? scratch! : acc;
      if (entryCurve) entrySink.fill(0);
      // The decoded clip body spans the picture interval; a J-cut (`leadSamples`
      // > 0) leads it with the Take's own pre-roll and an L-cut (`tailSamples` >
      // 0) trails it, both read from the Take's own audio. A negative tail
      // shortens the extent; a non-positive extent is meaningless. The fade
      // envelope spans the full extent from the leading edge.
      const clipFrames = Math.floor(pcm.length / channels);
      const extentFromStart = clipFrames + tailSamples;
      const totalExtent = leadSamples + extentFromStart;
      if (extentFromStart <= 0) {
        throw new Error(
          `mixAudio: kept entry has a non-positive audio extent (${extentFromStart} frames); reduce the tail`,
        );
      }
      // An explicit offset, tail or lead asserts an exact placement, so running
      // off the programme end is a loud error; a plain clip still tail-trims as
      // before. (A lead only moves the leading edge, so the trailing edge here is
      // still `startSample + extentFromStart`.)
      if (
        (offsetSamples !== 0 || tailSamples !== 0 || leadSamples !== 0) &&
        startSample + extentFromStart > totalSamples
      ) {
        throw new Error(
          `mixAudio: kept entry with offset/tail/lead extends past the programme end (${startSample + extentFromStart} > ${totalSamples} samples); reduce the offset, tail or lead`,
        );
      }
      // Fades span the full (possibly extended) extent and stay sample-exact
      // regardless of where the programme edges trim it.
      const fadeIn = Math.min(fadeInSamples, totalExtent);
      const fadeOut = Math.min(fadeOutSamples, totalExtent);
      const base = startSample * channels;
      const playFrames = Math.max(0, Math.min(extentFromStart, totalSamples - startSample));
      // J-cut: a nonnegative pre-roll read from the Take BEFORE `takeInSample`.
      // A declared lead that reaches past the Take's own start contributes
      // nothing here (no synthesized silence); its size is reported as a review
      // fact (see review.ts) rather than silently padded.
      if (leadSamples > 0) {
        if (!entry.takePath)
          throw new Error(`mixAudio: kept entry declares a lead but has no Take audio source to read it from`);
        const take = await decodePcm(entry.takePath, sampleRate, channels, tmpDir);
        const takeFrames = Math.floor(take.length / channels);
        const takeIn = entry.takeInSample ?? 0;
        for (let k = 0; k < leadSamples; k++) {
          const frame = takeIn + (k - leadSamples); // negative: before takeInSample
          if (frame < 0 || frame >= takeFrames) continue;
          const factor = fadeFactor(k, totalExtent, fadeIn, fadeOut);
          const destFrame = leadStart + k;
          for (let c = 0; c < channels; c++)
            entrySink[destFrame * channels + c] += take[frame * channels + c] * gain * factor;
        }
      }
      const bodySamples = Math.min(pcm.length, playFrames * channels);
      for (let j = 0; j < bodySamples; j++) {
        const factor = fadeFactor(leadSamples + Math.floor(j / channels), totalExtent, fadeIn, fadeOut);
        entrySink[base + j] += pcm[j] * gain * factor;
      }
      // L-cut: a positive tail continues the Take's own audio past the body end.
      // As with the lead, a declared tail past the Take's own audio contributes
      // nothing (never synthesized silence) and is reported as a review fact.
      const tailFrames = Math.max(0, playFrames - clipFrames);
      if (tailFrames > 0) {
        if (!entry.takePath)
          throw new Error(`mixAudio: kept entry declares a tail but has no Take audio source to read it from`);
        if (entry.takeBodySamples === undefined)
          throw new Error(
            `mixAudio: kept entry declares a tail but no source-clock body length; a body that is not 1:1 with its ` +
              `source (a retimed body) must declare takeBodySamples — the source interval end cannot be inferred from the body`,
          );
        const take = await decodePcm(entry.takePath, sampleRate, channels, tmpDir);
        const takeIn = entry.takeInSample ?? 0;
        // The tail is read on the Take's own SOURCE clock: it starts where the
        // body's source interval ended, `takeIn + takeBodySamples`. `clipFrames`
        // is the body's OUTPUT-clock length (a retime inflates it), so using it
        // as the source base would read past the intended source position.
        const takeBodySamples = entry.takeBodySamples;
        for (let k = 0; k < tailFrames; k++) {
          const frame = clipFrames + k;
          const factor = fadeFactor(leadSamples + frame, totalExtent, fadeIn, fadeOut);
          for (let c = 0; c < channels; c++) {
            const source = (takeIn + takeBodySamples + k) * channels + c;
            if (source < take.length) entrySink[base + frame * channels + c] += take[source] * gain * factor;
          }
        }
      }
      if (entryCurve)
        for (let k = 0; k < entrySink.length; k++) acc[k] += entrySink[k] * entryCurve[Math.floor(k / channels)];
    }

    if (bus !== undefined && members === 0) {
      throw new Error(`mixAudio: bus "${bus}" has no members; refusing to write an empty stem`);
    }

    assertWithinRange(acc);
    await fs.writeFile(destination, encodeWav(acc, sampleRate, channels));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
