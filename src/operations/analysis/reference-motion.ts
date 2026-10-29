// Reference marker-tracking control plane.
//
// `trackReferenceMarker` tracks a single flat-colour marker through a local,
// project-relative reference video and derives a timestamp-truthful, heuristic
// trajectory a host Agent can use to drive a *new* Code-authored subject: where
// the marker sits in the full source frame on each decoded frame, and how that
// position maps onto the target composition frame rate.
//
// Spaces (deliberately distinct):
//  - `frames[].index` and `frames[].pts` are source *decoded frame* identity and
//    the original integer tick in the stream time base (ffprobe authority).
//  - `frames[].outputFrame` is the exact mapping onto the target composition
//    timeline (shared `ptsToFrames`, half-up); no clock arithmetic is duplicated.
//  - `frames[].x`/`frames[].y` are centroids normalised to the *full source
//    frame* (0..1 over the source width/height), never to the ROI sub-rectangle.
//  - `frames[].matchedPixels`/`confidence` describe marker coverage only.
//
// Boundaries enforced here:
//  - The reference stays *unregistered material*. Tracking never registers an
//    Asset, mutates the Project, uploads anything, copies secrets, or writes
//    outside a fresh `.viscraft/reference-tracks/` run directory (published
//    reports are never overwritten).
//  - The report is a *derived artifact*, not a reconstruction of the original
//    project or edit.
//  - Matching is a per-channel RGB tolerance over the decoded image plane. It is
//    colour-matching, not semantic detection: no occlusion model, no identity
//    recognition, no pose estimation, and no 3D reconstruction are claimed.
//  - Decoded PTS is the authority and frames are mapped through the shared
//    `ptsToFrames` rational conversion, never through floating-point seconds.
//
// Verified ffmpeg/ffprobe behaviour this module relies on (ffmpeg 6.1.x):
//  - `ffmpeg -i <file> -map 0:v:0 -an -vf crop=w:h:x:y:exact=1,format=rgb24
//    -fps_mode passthrough -frames:v <n+1> -f rawvideo -pix_fmt rgb24 <out>`
//    decodes every frame to a packed, unscaled RGB24 buffer of exactly
//    `width*height*3` bytes per frame. Raw bytes cannot travel through
//    `runCommand`'s string stdout, so the decode is written to a temporary
//    *file* first, and `-frames:v <n+1>` bounds its growth.
//  - `crop=...:exact=1` does not reliably reject an out-of-bounds rectangle, so
//    the ROI is validated against the probed source dimensions before decoding.

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { FpsSchema, ReferenceTrackOptionsSchema, ReferenceTrackSchema, requireComposition } from '../../core/schema.js';
import type { ReferenceTrack, ReferenceTrackOptions } from '../../core/schema.js';
import { atomicJson, resolveProjectPath } from '../../shared/fs.js';
import { hashFile, stableHash } from '../../shared/hash.js';
import { runCommand } from '../../shared/process.js';
import { loadProject } from '../../project/project.js';
import { readBuilds } from '../../project/build-records.js';
import { probeMedia } from '../../backends/media/probe.js';
import { provenance, readSourceClock } from './reference.js';
import { summarizeReferenceTrack } from './track-coverage.js';
import { ptsToFrames } from '../../core/time.js';

/** Hard bound on decoded frames: tracking must never buffer a whole long movie. */
const MAX_FRAMES = 600;
/** Hard bound on the raw native-ROI decode buffer: 64 MiB. */
const MAX_DECODE_BYTES = 64 * 1024 * 1024;
const FFMPEG_GLOBAL = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-threads', '2', '-filter_threads', '1'];

interface Roi {
  x: number;
  y: number;
  width: number;
  height: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve the ROI against the probed source dimensions. A missing ROI means the
 * whole actual image; an explicit ROI that leaves the frame is rejected rather
 * than silently clamped.
 */
function resolveRoi(raw: Roi | undefined, width: number, height: number): Roi {
  const roi = raw ?? { x: 0, y: 0, width, height };
  if (roi.x + roi.width > width || roi.y + roi.height > height) {
    throw new Error(
      `Tracking ROI ${roi.width}x${roi.height} at (${roi.x},${roi.y}) exceeds the ${width}x${height} source frame`,
    );
  }
  return roi;
}

/**
 * Decode every frame's native-resolution ROI to a packed RGB24 buffer file.
 * Raw bytes cannot travel through `runCommand`'s string stdout, so the output is
 * a temporary file. No scaling is applied: the pixel contract is exact.
 */
async function decodeRoiNative(input: string, roi: Roi, frames: number, destination: string): Promise<void> {
  const filter = `crop=${roi.width}:${roi.height}:${roi.x}:${roi.y}:exact=1,format=rgb24`;
  try {
    await runCommand('ffmpeg', [
      ...FFMPEG_GLOBAL,
      '-i',
      input,
      '-map',
      '0:v:0',
      '-an',
      '-vf',
      filter,
      '-fps_mode',
      'passthrough',
      // Decode at most one frame past the probed count: a source that changes
      // underneath us cannot make the raw file grow without bound, and the
      // exact byte-length assert below rejects any short or long decode.
      '-frames:v',
      String(frames + 1),
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      destination,
    ]);
  } catch (error) {
    throw new Error(`ROI decode failed for ${input}: ${messageOf(error)}`);
  }
}

/**
 * Track a single flat-colour marker through a local, project-relative reference
 * video.
 *
 * Reads and validates the Project (never mutating or registering anything),
 * resolves the input safely, decodes the requested ROI at native resolution,
 * and returns a validated `ReferenceTrack` written atomically into a fresh
 * `.viscraft/reference-tracks/<paramHash>-<uuid>/` run directory.
 */
export async function trackReferenceMarker(
  root: string,
  relativePath: string,
  options: ReferenceTrackOptions,
): Promise<ReferenceTrack> {
  const parsed = ReferenceTrackOptionsSchema.parse(options);
  const color = parsed.color as [number, number, number];
  // The schema supplies the documented defaults (tolerance 40, minPixels 4).
  const tolerance = parsed.tolerance;
  const minPixels = parsed.minPixels;

  const project = await loadProject(root);
  const fps = parsed.fps ? FpsSchema.parse(parsed.fps) : requireComposition(project).output.fps;

  // Safe, symlink-rejecting resolution; the report never touches authoring files.
  const absolute = await resolveProjectPath(root, relativePath);
  let sha256: string;
  try {
    sha256 = await hashFile(absolute);
  } catch (error) {
    throw new Error(`Reference material is not readable: ${relativePath} (${messageOf(error)})`);
  }

  const media = await probeMedia(absolute);
  if (media.frames > MAX_FRAMES) {
    throw new Error(
      `Reference has ${media.frames} frames; marker tracking is capped at ${MAX_FRAMES} frames to bound decode memory`,
    );
  }

  const roi = resolveRoi(parsed.roi, media.width, media.height);
  const stride = roi.width * roi.height * 3;
  const decodeBytes = stride * media.frames;
  if (decodeBytes > MAX_DECODE_BYTES) {
    throw new Error(
      `Native ROI decode would need ${decodeBytes} bytes (${roi.width}x${roi.height} x ${media.frames} frames); capped at ${MAX_DECODE_BYTES} bytes to bound memory`,
    );
  }

  // Original integer PTS is the authority; mapping reuses the shared clock.
  const clock = await readSourceClock(absolute, media.frames);

  // Resolve the publish directory *before* creating any scratch, so a path or
  // symlink failure cannot leak a temporary work directory.
  const tracksDir = await resolveProjectPath(root, '.viscraft/reference-tracks');
  const workDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-reference-track-'));
  // Unique, option-sensitive run key so distinct tracks never collide or
  // overwrite a previously published report.
  const paramsHash = stableHash({ sha256, fps, roi, color, tolerance, minPixels });
  const runKey = `${paramsHash.slice(0, 24)}-${randomUUID().slice(0, 8)}`;
  const relativeDir = `.viscraft/reference-tracks/${runKey}`;
  const reportRelative = `${relativeDir}/report.json`;

  let staging: string | undefined;
  try {
    const rawPath = nodePath.join(workDir, `decode-${randomUUID()}.rgb24`);
    await decodeRoiNative(absolute, roi, media.frames, rawPath);
    const raw = await fs.readFile(rawPath);
    if (raw.length !== decodeBytes) {
      throw new Error(
        `Decoded ROI is ${raw.length} bytes but ${media.frames} frames of ${stride} bytes were expected (${decodeBytes}); refusing a partial or mismatched decode`,
      );
    }

    const area = roi.width * roi.height;
    const rowBytes = roi.width * 3;
    const frames: ReferenceTrack['frames'] = new Array(media.frames);
    for (let index = 0; index < media.frames; index++) {
      const base = index * stride;
      let count = 0;
      let sumX = 0;
      let sumY = 0;
      for (let ry = 0; ry < roi.height; ry++) {
        let offset = base + ry * rowBytes;
        for (let rx = 0; rx < roi.width; rx++, offset += 3) {
          if (
            Math.abs(raw[offset] - color[0]) <= tolerance &&
            Math.abs(raw[offset + 1] - color[1]) <= tolerance &&
            Math.abs(raw[offset + 2] - color[2]) <= tolerance
          ) {
            count++;
            sumX += rx;
            sumY += ry;
          }
        }
      }

      const present = count >= minPixels;
      // Centroid of matched pixel *centres* in full-source coordinates: the
      // ROI offset is added back and the pixel-centre half offset is included.
      const x = present ? (roi.x + sumX / count + 0.5) / media.width : null;
      const y = present ? (roi.y + sumY / count + 0.5) / media.height : null;
      frames[index] = {
        index,
        pts: clock.frames[index].pts,
        outputFrame: ptsToFrames(clock.frames[index].pts, clock.originPts, clock.timeBase, fps),
        present,
        x,
        y,
        matchedPixels: count,
        confidence: count / area,
      };
    }

    // Reject a reference that changed underneath the tracking.
    if ((await hashFile(absolute)) !== sha256) {
      throw new Error(`Reference input ${relativePath} changed during tracking; discard this report and retry`);
    }

    const limitations = [
      'Marker matching is a per-channel RGB tolerance over the decoded image plane; FFmpeg decode converts the source to packed RGB24, so the requested colour and matched coverage are quantised by that conversion and by the source colour precision.',
      'Coverage confidence is the matched-pixel fraction (matched pixels / ROI pixels), not a semantic detection probability: occlusion, motion blur, compression, and similarly coloured backgrounds can cause missed or spurious matches.',
      'Tracking covers one flat-colour marker in the source image plane only: no 3D reconstruction, no identity recognition, and no pose estimation are performed.',
      'Tracking is bounded to the requested colour (minPixels >= threshold) inside the optional user ROI at native resolution; other colours, subjects, and frame regions are neither searched nor claimed.',
      'Frames where fewer than minPixels match report a null position with their raw coverage fraction; positions are never interpolated across gaps.',
      'Coverage/occlusion facts are also persisted beside the report as coverage.json: contiguous missing-frame (gap) spans, partial-visibility spans and confidence statistics, so a consumer reads missing/occluded data instead of a silent centroid.',
      'The reference stays unregistered material: this report is a derived trajectory, not a reconstruction of the original project or edit.',
    ];
    if (!options.roi) limitations.push('Tracking ROI defaulted to the whole source frame.');
    if (!options.fps) limitations.push('Output fps defaulted to the current Project composition fps.');
    if (clock.variableFrameRate)
      limitations.push(
        'The source has variable frame-rate timestamps (unequal PTS deltas); output frames are nearest-frame resamples.',
      );
    if (clock.durationMethod === 'frame-rate-fallback')
      limitations.push(
        'The final frame reported no duration; the source end time was derived from the average frame rate and is approximate.',
      );
    const source = provenance(project, await readBuilds(root), relativePath, sha256);
    if (source.origin === 'material')
      limitations.push(
        'Origin "material" with simulated=false means provenance is unknown; it is not evidence that the media came from a real generation provider.',
      );
    if (source.hashMismatch)
      limitations.push(
        "A registered record shares this material's path but its recorded sha256 differs; identity was not assumed and the source is treated as unregistered material.",
      );

    const report = ReferenceTrackSchema.parse({
      schemaVersion: 1,
      kind: 'reference-track',
      source: { path: relativePath, sha256, simulated: source.simulated, origin: source.origin },
      media,
      fps,
      clock: {
        timeBase: clock.timeBase,
        originPts: clock.originPts,
        endPts: clock.endPts,
        durationMethod: clock.durationMethod,
        variableFrameRate: clock.variableFrameRate,
      },
      marker: { color, tolerance, minPixels },
      roi,
      frames,
      paramsHash,
      reportPath: reportRelative,
      limitations,
    });

    // Commit the report inside staging, then publish the whole run directory
    // atomically. Published reports are never deleted.
    await fs.mkdir(tracksDir, { recursive: true });
    const finalDir = await resolveProjectPath(root, relativeDir);
    try {
      await fs.access(finalDir);
      throw new Error(
        `Reference-track run directory ${relativeDir} already exists; refusing to overwrite published reports`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    staging = await fs.mkdtemp(nodePath.join(tracksDir, '.tmp-'));
    await atomicJson(nodePath.join(staging, 'report.json'), report);
    // Persist the derived coverage/occlusion facts beside the report. These are
    // a *summary of measured per-frame coverage*, not a new measurement: the
    // spans are the contiguous unobserved / partial-visibility runs the consumer
    // must not paper over with an interpolated centre.
    await atomicJson(nodePath.join(staging, 'coverage.json'), summarizeReferenceTrack(report));
    await fs.rename(staging, finalDir);
    staging = undefined;

    return report;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}
