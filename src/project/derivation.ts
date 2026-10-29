/**
 * Re-derive an audio derivation's recorded facts against the REAL parent medium
 * and the produced Asset file.
 *
 * Shared by the Build (the execution stage) and `productionClosure` (the
 * delivery/handoff boundary that export, archive and `deliver`
 * walk), so a hand-edited derivation record cannot be carried by a package that
 * never rebuilds. `MediaInfo` stores only the parent's FIRST audio stream, so the
 * selected stream is re-enumerated (`probeAudioStreams`) to check `streamIndex`,
 * the timebase, the start PTS and the interval bound; the produced file is
 * re-probed (`probeAudio`) to check the recorded output rate and sample count. No
 * PCM is reproduced.
 *
 * When a file's bytes are not present (a released/archived medium, or a
 * hand-authored fixture), that part of the faithful re-derivation is unavailable
 * and is skipped: the record's own internal checks (`assertAssetAudioDerivation`)
 * still apply, but the media cross-check is simply not claimable.
 */
import { existsSync } from 'node:fs';
import type { Artifact, AssetDerivation } from '../core/schema.js';
import { probeAudio, probeAudioStreams } from '../backends/media/probe.js';

export async function assertAudioDerivationMatchesMedia(
  parentFile: string,
  producedFile: string | undefined,
  artifact: Artifact,
  parent: Extract<AssetDerivation, { kind: 'audio' }>,
  assetId: string,
): Promise<void> {
  if (existsSync(parentFile)) {
    const streams = await probeAudioStreams(parentFile);
    const stream = streams[parent.streamIndex];
    if (!stream)
      throw new Error(
        `Asset ${assetId} audio derivation streamIndex ${parent.streamIndex} does not exist in parent Artifact ${artifact.id} (which has ${streams.length} audio stream${streams.length === 1 ? '' : 's'})`,
      );
    if (
      stream.timebase.numerator !== parent.timebase.numerator ||
      stream.timebase.denominator !== parent.timebase.denominator
    )
      throw new Error(`Asset ${assetId} audio derivation timebase disagrees with the parent stream`);
    if (stream.startPts !== undefined && stream.startPts !== parent.startPts)
      throw new Error(`Asset ${assetId} audio derivation startPts disagrees with the parent stream`);
    if (
      stream.startPts !== undefined &&
      stream.durationTicks !== undefined &&
      parent.outPts > stream.startPts + stream.durationTicks
    )
      throw new Error(`Asset ${assetId} audio derivation interval exceeds the parent audio stream end`);
  }
  if (producedFile !== undefined && existsSync(producedFile)) {
    const produced = await probeAudio(producedFile);
    if (produced.sampleRate !== parent.sampleRate || produced.samples !== parent.sampleCount)
      throw new Error(`Asset ${assetId} audio derivation output facts disagree with its own bytes`);
  }
}
