import { type OutputSettings } from '../../core/schema.js';
import { fpsToString, probeMedia } from './probe.js';
import * as nodePath from 'node:path';
import { ffmpeg, FFMPEG_OUTPUT_THREADS } from './ffmpeg.js';

// ---------------------------------------------------------------------------
// encodeFrames
// ---------------------------------------------------------------------------

/**
 * Encode an image sequence `frame-000000.png, frame-000001.png, ...` (index 0
 * based) from `directory` into an exact-length CFR H.264 video.
 */
export async function encodeFrames(
  directory: string,
  output: OutputSettings,
  frames: number,
  destination: string,
): Promise<void> {
  if (!Number.isInteger(frames) || frames <= 0) {
    throw new Error(`encodeFrames: frames must be a positive integer, got ${frames}`);
  }
  const fps = fpsToString(output.fps);
  const pattern = nodePath.join(directory, 'frame-%06d.png');
  const vf = `scale=${output.width}:${output.height}:flags=lanczos,format=yuv420p`;

  await ffmpeg([
    '-framerate',
    fps,
    '-start_number',
    '0',
    '-i',
    pattern,
    '-frames:v',
    String(frames),
    '-vf',
    vf,
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-r',
    fps,
    '-fps_mode',
    'cfr',
    '-an',
    ...FFMPEG_OUTPUT_THREADS,
    destination,
  ]);

  const probed = await probeMedia(destination);
  if (probed.frames !== frames) {
    throw new Error(`encodeFrames: expected ${frames} output frames, got ${probed.frames}`);
  }
}
