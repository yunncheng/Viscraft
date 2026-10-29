// Viscraft picture-layer compositing.
//
// Deterministic FFmpeg overlay of timed `PictureLayer` windows on top of an
// already-composed base timeline. The base timeline owns the output clock and
// duration: layers are never allowed to extend it, and the base is never
// rescaled. Each layer maps its source window [inFrame, outFrame) onto the
// exact output frames [startFrame, startFrame + (outFrame - inFrame)), scaled
// into its pixel rect and composited in array order (later layers on top).
//
// Timing is always resolved per frame — never by float approximation:
//  - `settb` pins the layer link to the output frame period.
//  - `setpts` renumbers frames as `N + startFrame`, so frame N of the trimmed
//    source lands on output frame `startFrame + N`.
//  - `overlay`'s `eof_action=pass` / `repeatlast=0` means the layer is drawn
//    only while its shifted frames exist: the base passes through untouched
//    before the layer's first frame and after its last, and no frame is ever
//    repeated or bled into a neighbouring window.
//
// Note on window gating: the exact frame window is realized by the shifted
// timestamps above. An additional `overlay=enable='between(n,start,end-1)'`
// gate is intentionally NOT used: on FFmpeg 6.1.1 it makes overlay's framesync
// desynchronize the secondary input (it drops every other frame), which would
// break the very per-frame determinism this module guarantees. The base
// timeline is still authoritative and layers still never extend it.
//
// Only picture is produced: the output is a picture-only H.264 file. Audio is
// never rewritten or invented here.
//
// The public entry point validates the canonical schemas; the caller supplies
// already-normalized input `MediaInfo` (no probing, path guessing, model, or
// renderer is performed for the layer sources).

import { OutputSchema, PictureLayerSchema } from '../../core/schema.js';
import type { Fps, MediaInfo, OutputSettings, PictureLayer } from '../../core/schema.js';
import { probeMedia } from './probe.js';
import { runCommand } from '../../shared/process.js';

/** A `PictureLayer` paired with the (already normalized) media it renders from. */
export interface PictureLayerClip {
  layer: PictureLayer;
  path: string;
  media: MediaInfo;
}

// Match the media control plane: polite encoder threads, single-threaded filter
// graphs, so overlays stay reproducible on the shared host.
const FFMPEG_GLOBAL_ARGS = ['-hide_banner', '-nostdin', '-y', '-filter_threads', '1', '-filter_complex_threads', '1'];
const FFMPEG_OUTPUT_THREADS = ['-threads', '2'];

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function ffmpeg(args: string[]): Promise<string> {
  try {
    return await runCommand('ffmpeg', [...FFMPEG_GLOBAL_ARGS, ...args]);
  } catch (err) {
    throw new Error(`ffmpeg failed: ${messageOf(err)}`);
  }
}

function sameFps(a: Fps, b: Fps): boolean {
  return a.numerator * b.denominator === b.numerator * a.denominator;
}

/**
 * Composite timed picture layers over `base` and write a picture-only H.264
 * file to `destination`.
 *
 * `frames` is the authoritative base timeline length (as probed from `base`).
 * Every layer's output interval must fit inside it; an over-long layer is
 * rejected rather than clamped or allowed to extend the base. Layer array order
 * is the stacking order (last element is drawn topmost).
 */
export async function overlayPictureLayers(
  base: string,
  layers: PictureLayerClip[],
  output: OutputSettings,
  frames: number,
  destination: string,
): Promise<void> {
  const settings = OutputSchema.parse(output);
  if (!Number.isInteger(frames) || frames <= 0) {
    throw new Error(`overlayPictureLayers: frames must be a positive integer, got ${frames}`);
  }
  if (layers.length === 0) throw new Error('overlayPictureLayers: no layers provided');

  // Validate every layer against the canonical schema before touching FFmpeg.
  const clips: PictureLayerClip[] = layers.map(clip => ({
    path: clip.path,
    media: clip.media,
    layer: PictureLayerSchema.parse(clip.layer),
  }));

  const seen = new Set<string>();
  for (const clip of clips) {
    if (seen.has(clip.layer.id)) throw new Error(`overlayPictureLayers: duplicate layer id ${clip.layer.id}`);
    seen.add(clip.layer.id);
  }

  for (const { layer, media } of clips) {
    const duration = layer.outFrame - layer.inFrame;
    if (!sameFps(media.fps, settings.fps)) {
      throw new Error(
        `overlayPictureLayers: layer ${layer.id} source fps ${media.fps.numerator}/${media.fps.denominator} is not normalized to output fps ${settings.fps.numerator}/${settings.fps.denominator}`,
      );
    }
    if (layer.outFrame > media.frames) {
      throw new Error(
        `overlayPictureLayers: layer ${layer.id} requests source frames [${layer.inFrame}, ${layer.outFrame}) but source only has ${media.frames}`,
      );
    }
    const endFrame = layer.startFrame + duration;
    if (endFrame > frames) {
      throw new Error(
        `overlayPictureLayers: layer ${layer.id} ends at frame ${endFrame} but the base timeline only has ${frames} frames`,
      );
    }
    if (layer.x + layer.width > settings.width || layer.y + layer.height > settings.height) {
      throw new Error(
        `overlayPictureLayers: layer ${layer.id} rect [${layer.x}, ${layer.y}, ${layer.width}x${layer.height}] lies outside the ${settings.width}x${settings.height} viewport`,
      );
    }
  }

  // The base timeline is authoritative: its real frame count, frame rate and
  // resolution define the output clock, and must match the caller's contract.
  const baseInfo = await probeMedia(base);
  if (!sameFps(baseInfo.fps, settings.fps)) {
    throw new Error(
      `overlayPictureLayers: base fps ${baseInfo.fps.numerator}/${baseInfo.fps.denominator} does not match output fps ${settings.fps.numerator}/${settings.fps.denominator}`,
    );
  }
  if (baseInfo.frames !== frames) {
    throw new Error(
      `overlayPictureLayers: base has ${baseInfo.frames} frames but the authoritative count is ${frames}`,
    );
  }
  if (baseInfo.width !== settings.width || baseInfo.height !== settings.height) {
    throw new Error(
      `overlayPictureLayers: base is ${baseInfo.width}x${baseInfo.height} but output is ${settings.width}x${settings.height}`,
    );
  }

  const fps = settings.fps;
  const timebase = `${fps.denominator}/${fps.numerator}`;

  // Per-layer chains: trim the source window, pin the link to the output frame
  // period, renumber frames so frame N lands on `startFrame + N`, scale into the
  // layer rect, and apply opacity through the alpha channel.
  const layerChains = clips.map(({ layer }, i) => {
    const link = `[${i + 1}:v]`;
    return (
      `${link}trim=start_frame=${layer.inFrame}:end_frame=${layer.outFrame},` +
      `settb=expr=${timebase},` +
      `setpts=(N+${layer.startFrame})/(${fps.numerator}*TB/${fps.denominator}),` +
      `scale=${layer.width}:${layer.height}:flags=lanczos,setsar=1,format=rgba,` +
      `colorchannelmixer=aa=${layer.opacity}[l${i}]`
    );
  });

  // Stack in array order: later layers overlay the accumulated result.
  const overlayChains: string[] = ['[0:v]format=rgba[base]'];
  let current = 'base';
  clips.forEach(({ layer }, i) => {
    const next = i === clips.length - 1 ? 'composited' : `v${i}`;
    overlayChains.push(
      `[${current}][l${i}]overlay=x=${layer.x}:y=${layer.y}:shortest=0:eof_action=pass:repeatlast=0[${next}]`,
    );
    current = next;
  });
  overlayChains.push('[composited]format=yuv420p[layered]');

  const filters = [...layerChains, ...overlayChains].join(';');

  const inputArgs: string[] = ['-i', base];
  for (const { path } of clips) inputArgs.push('-i', path);

  await ffmpeg([
    ...inputArgs,
    '-filter_complex',
    filters,
    '-map',
    '[layered]',
    '-frames:v',
    String(frames),
    '-r',
    `${fps.numerator}/${fps.denominator}`,
    '-fps_mode',
    'cfr',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-an',
    ...FFMPEG_OUTPUT_THREADS,
    destination,
  ]);

  const probed = await probeMedia(destination);
  if (probed.frames !== frames) {
    throw new Error(`overlayPictureLayers: expected ${frames} output frames, got ${probed.frames}`);
  }
  if (!sameFps(probed.fps, fps)) {
    throw new Error(
      `overlayPictureLayers: expected output fps ${fps.numerator}/${fps.denominator}, got ${probed.fps.numerator}/${probed.fps.denominator}`,
    );
  }
}
