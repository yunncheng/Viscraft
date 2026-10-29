/**
 * Audio extraction: register one real audio stream interval of an existing
 * Take/video Artifact as a reusable audio Project Asset.
 *
 * This is the honest bridge from a video Build medium to a standalone audio
 * Asset. It reads a stream that really exists, decodes exactly the requested
 * half-open interval to PCM, and records the REAL stream facts (its audio-
 * relative selection index, rational timebase, source start PTS, the extracted
 * `[inPts, outPts)` interval, and the produced file's own sample rate / sample
 * count) so the picture↔audio start mapping is stated, never guessed. It does
 * NOT update the timeline: no Placement is touched and no audio clip is created —
 * it is SOURCE registration.
 *
 * Guarantees:
 *  - the parent Artifact is read-only: its bytes are hashed before and after
 *    extraction and must stay identical;
 *  - a missing audio stream, or a `streamIndex` that does not exist, FAILS
 *    loudly — silence is never assumed;
 *  - the selected stream is mapped EXPLICITLY (`-map 0:a:<index>`); the default
 *    is never relied on (FFmpeg's default audio selection picks the stream with
 *    the MOST channels, not the first);
 *  - unsupported inputs are REFUSED, not fabricated into a linear mapping: a
 *    negative start PTS, `inPts < startPts`, `outPts <= inPts`, an `outPts` past
 *    the stream duration, or a stream with no usable timebase/start PTS/duration
 *    all throw, leaving the Project and the source untouched;
 *  - rights are taken verbatim from the caller and never inferred from the
 *    parent; `simulated` is tainted along the lineage (the parent Artifact/Take,
 *    any history Artifact sharing the parent hash, or a matching Project Asset);
 *  - the registered Asset path is authored content: a runtime `.viscraft/` path,
 *    an `output/` path or a credential filename is REFUSED before writing;
 *  - the requested interval is decoded by decoding the WHOLE selected stream to a
 *    zero-based PCM WAV and trimming it RELATIVE to the stream start, so a stream
 *    with a non-zero start PTS is not trimmed by that PTS and the result is
 *    byte-exact (a single-pass seek is measured from the container start and is
 *    not byte-exact on a compressed source);
 *  - the output fact `startSample` is the source-stream position that output
 *    sample 0 corresponds to, computed from `(inPts - startPts)` in the stream
 *    timebase scaled to the produced sample rate (integer, round-half-up), so a
 *    consumer can line the audio up against the picture without inventing one;
 *  - the whole operation runs under the `author` lock and bumps the Project
 *    revision atomically, refusing an existing Asset id instead of overwriting.
 */

import { constants as fsConstants } from 'node:fs';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import {
  Id,
  ProjectSchema,
  RelativePath,
  RightsSchema,
  requireComposition,
  type Asset,
  type Artifact,
  type BuildRecord,
  type Take,
} from '../../core/schema.js';
import { atomicJson, resolveProjectPath } from '../../shared/fs.js';
import { hashFile } from '../../shared/hash.js';
import { runCommand } from '../../shared/process.js';
import { acquireLock, loadProject, validateProject } from '../../project/project.js';
import { assertAuthoredPath } from '../../project/authored-path.js';
import { readBuilds } from '../../project/build-records.js';
import { probeAudio, probeAudioStreams, probeMedia } from '../../backends/media/probe.js';
import { succeededIndex } from './assets.js';

const int = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveInt = int.refine(n => n > 0, 'Expected a positive integer');
const signedInt = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);

/**
 * Options for `extractAudio`. Exactly one of `take`/`artifact` names the parent
 * video medium; `streamIndex` is REQUIRED and explicit (the audio-relative index
 * `probeAudioStreams` reports and FFmpeg's `-map 0:a:<n>` selects), because
 * silently defaulting to "the first audio stream" would pick the wrong stream on
 * a multi-stream file. `inPts`/`outPts` are PTS ticks in the selected stream's
 * own timebase; omitting both extracts the whole stream.
 */
export const ExtractAudioOptionsSchema = z
  .object({
    take: Id.optional(),
    artifact: Id.optional(),
    assetId: Id,
    rights: RightsSchema,
    expectedRevision: positiveInt,
    streamIndex: int,
    inPts: signedInt.optional(),
    outPts: signedInt.optional(),
    outputSampleRate: positiveInt.optional(),
    processing: z.string().trim().min(1).max(2000).optional(),
    path: RelativePath.optional(),
  })
  .strict()
  .refine(
    options => Boolean(options.take) !== Boolean(options.artifact),
    'Audio extraction requires exactly one Take or Artifact',
  )
  .refine(
    options => options.inPts === undefined || options.outPts === undefined || options.outPts > options.inPts,
    'Audio extraction requires a nonempty half-open interval (inPts < outPts)',
  );
export type ExtractAudioOptions = z.input<typeof ExtractAudioOptionsSchema>;

/** FFmpeg accepts decimal seconds; emit full double precision (no truncation). */
function secondsArgument(seconds: number): string {
  return `${seconds}`;
}

/**
 * Decode exactly `[seekSeconds, seekSeconds + durationSeconds)` — measured from
 * the START of the selected audio stream — to PCM WAV at `sampleRate`.
 *
 * Two passes, because a single-pass seek cannot be both exact and relative:
 *  - FFmpeg's input `-ss` is measured from the input's `start_time` (the minimum
 *    over ALL streams, which is not the audio stream's own start whenever a
 *    container mixes a zero-based video with a delayed audio track), and any
 *    `-ss` on the COMPRESSED source lands on a decoder state that is not
 *    byte-identical to a plain decode.
 *  - So pass 1 decodes the WHOLE selected stream to a zero-based PCM WAV (equal
 *    to a plain `-map 0:a:<streamIndex>` decode), and pass 2 trims that
 *    zero-based file by the RELATIVE offset — an exact sample-boundary operation.
 *
 * `seekSeconds <= 0` with no bounded duration is the whole stream: it is decoded
 * straight to `destination` (no trim), so it equals a plain decode. Pass 1
 * selects the source stream explicitly (`-map 0:a:<streamIndex>`, never the
 * channel-count default); pass 2 maps `0:a:0` because the zero-based WAV has
 * exactly ONE audio stream, so reusing an audio-relative index >= 1 there would
 * fail ("matches no streams").
 */
async function extractInterval(
  source: string,
  destination: string,
  scratch: string,
  streamIndex: number,
  sampleRate: number,
  seekSeconds: number,
  durationSeconds: number | undefined,
): Promise<void> {
  const base = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-threads', '2', '-filter_threads', '1'];
  const encode = ['-vn', '-sn', '-dn', '-ar', String(sampleRate), '-c:a', 'pcm_s16le'];
  if (seekSeconds <= 0 && (durationSeconds === undefined || durationSeconds <= 0)) {
    await runCommand('ffmpeg', [...base, '-i', source, '-map', `0:a:${streamIndex}`, ...encode, destination]);
    return;
  }
  const whole = path.join(scratch, 'whole.wav');
  await runCommand('ffmpeg', [...base, '-i', source, '-map', `0:a:${streamIndex}`, ...encode, whole]);
  const trim = [...base];
  if (seekSeconds > 0) trim.push('-ss', secondsArgument(seekSeconds));
  trim.push('-i', whole);
  if (durationSeconds !== undefined && durationSeconds > 0) trim.push('-t', secondsArgument(durationSeconds));
  // The zero-based WAV holds a single audio stream, so the trim always maps
  // `0:a:0` — the source's audio-relative index does not apply to it.
  await runCommand('ffmpeg', [...trim, '-map', '0:a:0', ...encode, destination]);
}

/**
 * The parent Build's composition output sample rate, read from its frozen
 * snapshot (the output the medium was actually produced on). Falls back to the
 * current Project's output sample rate when the snapshot is unavailable.
 */
async function parentBuildSampleRate(root: string, buildId: string, fallback: number): Promise<number> {
  try {
    const raw = await readFile(await resolveProjectPath(root, `.viscraft/snapshots/${buildId}.project.json`), 'utf8');
    return requireComposition(ProjectSchema.parse(JSON.parse(raw))).output.sampleRate;
  } catch {
    return fallback;
  }
}

/** Locate the parent Artifact (and optional Take) from succeeded Builds, as `promoteRange` does. */
function locateParent(
  parsed: z.infer<typeof ExtractAudioOptionsSchema>,
  artifacts: Map<string, { value: Artifact; build: BuildRecord }>,
  takes: Map<string, { value: Take; build: BuildRecord }>,
): { artifact: Artifact; buildId: string; take?: Take } {
  if (parsed.take !== undefined) {
    const locatedTake = takes.get(parsed.take);
    if (!locatedTake) throw new Error(`Unknown Take ${parsed.take} in succeeded Builds`);
    const take = locatedTake.value;
    const declared = locatedTake.build.artifacts.find(artifact => artifact.id === take.artifact);
    if (declared) return { artifact: declared, buildId: locatedTake.build.id, take };
    const owner = artifacts.get(take.artifact);
    if (!owner) throw new Error(`Take ${take.id} references a missing Artifact ${take.artifact}`);
    return { artifact: owner.value, buildId: owner.build.id, take };
  }
  const locatedArtifact = artifacts.get(parsed.artifact!);
  if (!locatedArtifact) throw new Error(`Unknown Artifact ${parsed.artifact} in succeeded Builds`);
  return { artifact: locatedArtifact.value, buildId: locatedArtifact.build.id };
}

/**
 * Extract and register one real audio stream interval of a succeeded Build's
 * Take/video Artifact as a new audio Asset. See the module header for the exact
 * guarantees. Returns the registered Asset.
 */
export async function extractAudio(root: string, options: ExtractAudioOptions): Promise<Asset> {
  const parsed = ExtractAudioOptionsSchema.parse(options);
  const release = await acquireLock(root, 'author');
  let scratch: string | undefined;
  let createdDestination: string | undefined;
  try {
    const project = await loadProject(root);
    if (project.revision !== parsed.expectedRevision) {
      throw new Error(`Source revision conflict: expected ${parsed.expectedRevision}, found ${project.revision}`);
    }
    if (project.assets.some(asset => asset.id === parsed.assetId)) {
      throw new Error(
        `Asset ${parsed.assetId} already exists in this Project; refusing to overwrite an established Asset id`,
      );
    }

    const history = await readBuilds(root);
    const { artifacts, takes } = succeededIndex(history);
    const {
      artifact: parentArtifact,
      buildId: parentBuildId,
      take: parentTake,
    } = locateParent(parsed, artifacts, takes);

    if (parentArtifact.kind !== 'video')
      throw new Error(
        `Artifact ${parentArtifact.id} is ${parentArtifact.kind}, not a video; only a video Artifact can carry an extractable audio stream`,
      );

    const sourcePath = await resolveProjectPath(root, parentArtifact.path);
    if ((await hashFile(sourcePath)) !== parentArtifact.sha256)
      throw new Error(`Artifact hash mismatch: ${parentArtifact.id} on disk does not match its recorded sha256`);
    const info = await probeMedia(sourcePath);
    if (
      !parentArtifact.media ||
      info.frames !== parentArtifact.media.frames ||
      info.width !== parentArtifact.media.width ||
      info.height !== parentArtifact.media.height ||
      info.fps.numerator * parentArtifact.media.fps.denominator !==
        parentArtifact.media.fps.numerator * info.fps.denominator ||
      (parentArtifact.media.audio !== undefined &&
        (info.audio?.sampleRate !== parentArtifact.media.audio.sampleRate ||
          info.audio?.channels !== parentArtifact.media.audio.channels))
    )
      throw new Error(`Artifact ${parentArtifact.id} probe does not match its recorded media`);
    // The extracted stream is measured on its own audio clock below; the Take's
    // frame span only exists for a picture Take. A sound Take pointing at this
    // video Artifact is an inconsistent record, not a frame count to compare.
    if (parentTake && parentTake.medium !== 'picture')
      throw new Error(`Take ${parentTake.id} is a sound Take but Artifact ${parentArtifact.id} is video`);
    if (parentTake && parentTake.frames !== info.frames)
      throw new Error(`Take ${parentTake.id} frame span does not match its Artifact`);

    // --- Select the real audio stream (never assume silence, never default) ---
    const streams = await probeAudioStreams(sourcePath);
    if (streams.length === 0)
      throw new Error(
        `Artifact ${parentArtifact.id} has no audio stream; refusing to fabricate silent audio (request streamIndex ${parsed.streamIndex})`,
      );
    const stream = streams[parsed.streamIndex];
    if (!stream)
      throw new Error(
        `streamIndex ${parsed.streamIndex} does not exist in Artifact ${parentArtifact.id} (it has ${streams.length} audio stream${streams.length === 1 ? '' : 's'}, indices 0..${streams.length - 1}); pass an explicit existing index`,
      );

    // --- Refuse rather than fabricate a linear source→output mapping ---------
    const { numerator, denominator } = stream.timebase;
    if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || numerator <= 0 || denominator <= 0)
      throw new Error(
        `Audio stream ${parsed.streamIndex} of Artifact ${parentArtifact.id} has no usable rational timebase`,
      );
    if (stream.startPts === undefined)
      throw new Error(
        `Audio stream ${parsed.streamIndex} of Artifact ${parentArtifact.id} reports no start PTS; refusing to invent a source origin`,
      );
    const startPts = stream.startPts;
    if (startPts < 0)
      throw new Error(
        `Audio stream ${parsed.streamIndex} of Artifact ${parentArtifact.id} starts at negative PTS ${startPts}; unsupported (refusing a fabricated mapping)`,
      );
    if (stream.durationTicks === undefined || stream.durationTicks <= 0)
      throw new Error(
        `Audio stream ${parsed.streamIndex} of Artifact ${parentArtifact.id} reports no usable duration; refusing to guess the stream end`,
      );
    const streamEndPts = startPts + stream.durationTicks;
    const inPts = parsed.inPts ?? startPts;
    const outPts = parsed.outPts ?? streamEndPts;
    if (inPts < startPts)
      throw new Error(
        `inPts ${inPts} is before the audio stream start ${startPts} in Artifact ${parentArtifact.id}; refusing a mapping outside the stream`,
      );
    if (outPts <= inPts)
      throw new Error(`Audio extraction interval must be nonempty and half-open (inPts ${inPts} < outPts ${outPts})`);
    if (outPts > streamEndPts)
      throw new Error(
        `outPts ${outPts} exceeds the audio stream end ${streamEndPts} (start ${startPts} + duration ${stream.durationTicks}) in Artifact ${parentArtifact.id}`,
      );
    if (!Number.isInteger(inPts) || !Number.isInteger(outPts) || !Number.isInteger(startPts))
      throw new Error('Audio extraction PTS values must be integers in the stream timebase');

    const outputSampleRate =
      parsed.outputSampleRate ??
      (await parentBuildSampleRate(root, parentBuildId, requireComposition(project).output.sampleRate));

    // Taint propagates along the lineage exactly as for a promoted frame.
    const simulated =
      parentArtifact.simulated ||
      Boolean(parentTake?.simulated) ||
      history
        .flatMap(build => build.artifacts)
        .some(artifact => artifact.sha256 === parentArtifact.sha256 && artifact.simulated) ||
      project.assets.some(asset => asset.sha256 === parentArtifact.sha256 && asset.simulated);

    // Map the PTS interval to the trim the decoder wants. The two-pass decode in
    // `extractInterval` makes the offset RELATIVE to the selected stream's own
    // start (a single-pass input `-ss` is measured from the container's start_time
    // and is not byte-exact on a compressed source), so a non-zero start PTS does
    // not trim real audio off the front. An interval that reaches the declared
    // stream end is decoded to EOF, so a whole-stream extraction equals a plain
    // decode instead of being clipped to the container's declared duration.
    const streamStartSeconds = (startPts * numerator) / denominator;
    const inSeconds = (inPts * numerator) / denominator;
    const outSeconds = (outPts * numerator) / denominator;
    const seekSeconds = inSeconds - streamStartSeconds;
    const durationSeconds = outPts >= streamEndPts ? undefined : outSeconds - inSeconds;
    scratch = await resolveProjectPath(root, `.viscraft/scratch/extract-audio-${randomUUID()}`);
    await mkdir(scratch, { recursive: true });
    const staged = path.join(scratch, 'audio.wav');
    await extractInterval(
      sourcePath,
      staged,
      scratch,
      parsed.streamIndex,
      outputSampleRate,
      seekSeconds,
      durationSeconds,
    );

    // Record the PRODUCED file's real facts — never compute them optimistically.
    const produced = await probeAudio(staged);
    if (!Number.isSafeInteger(produced.samples) || produced.samples <= 0)
      throw new Error('Audio extraction produced an empty WAV; refusing to register it');
    const sha256 = await hashFile(staged);
    // The source-stream position that output sample 0 corresponds to: the
    // `(inPts - startPts)` span of the stream timebase, scaled to the produced
    // sample rate. Rounded to the nearest whole sample (round-half-up for the
    // non-negative span), because output sample 0 sits on a sample grid.
    const startSample = Math.round((((inPts - startPts) * numerator) / denominator) * produced.sampleRate);
    if (!Number.isSafeInteger(startSample) || startSample < 0)
      throw new Error('Audio extraction could not resolve a non-negative output start sample');

    if ((await hashFile(sourcePath)) !== parentArtifact.sha256) {
      throw new Error(
        `Artifact ${parentArtifact.id} changed while its audio was extracted; retry after the build stops writing`,
      );
    }

    const relative = parsed.path ?? `assets/${parsed.assetId}-${sha256.slice(0, 16)}.wav`;
    // The registered Asset is authored content: refuse a runtime/scratch path, an
    // output/ path or a credential filename before anything is written, exactly
    // as the delivery export would later refuse it.
    assertAuthoredPath(relative, `Asset ${parsed.assetId}`);
    const destination = await resolveProjectPath(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      await copyFile(staged, destination, fsConstants.COPYFILE_EXCL);
      createdDestination = destination;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A content-addressed file may already exist from an earlier extraction of
      // the same interval; reuse it only if the bytes are identical.
      if ((await hashFile(destination)) !== sha256)
        throw new Error(`Refusing to overwrite existing file ${relative} with different content`);
    }

    const asset: Asset = {
      id: parsed.assetId,
      revision: 1,
      path: relative,
      sha256,
      type: 'audio',
      rights: parsed.rights,
      simulated,
      derivedFrom: {
        kind: 'audio',
        build: parentBuildId,
        artifact: parentArtifact.id,
        sha256: parentArtifact.sha256,
        ...(parentTake ? { take: parentTake.id } : {}),
        streamIndex: parsed.streamIndex,
        timebase: { numerator, denominator },
        startPts,
        inPts,
        outPts,
        sampleRate: produced.sampleRate,
        startSample,
        sampleCount: produced.samples,
        ...(parsed.processing ? { processing: parsed.processing } : {}),
        outputSha256: sha256,
      },
    };
    const next = validateProject({ ...project, revision: project.revision + 1, assets: [...project.assets, asset] });
    await atomicJson(await resolveProjectPath(root, 'project.json'), next);
    createdDestination = undefined;
    return asset;
  } finally {
    // Only a freshly written destination is cleaned up on failure; a reused
    // content-addressed file must survive. The Project itself is untouched until
    // the very last atomic write, so any earlier failure is a no-op.
    if (createdDestination) await rm(createdDestination, { force: true }).catch(() => {});
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
    await release();
  }
}
