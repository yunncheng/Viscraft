import {
  type Placement,
  type MediaInfo,
  type OutputSettings,
  type LookGrade,
  OutputSchema,
  LookGradeSchema,
  type MediaFraming,
  MediaFramingSchema,
  type Transition,
  type Project,
  requireComposition,
  TransitionSchema,
} from '../../core/schema.js';
import { probeMedia, fpsToString, sameFps } from './probe.js';
import { ffmpeg, FFMPEG_OUTPUT_THREADS } from './ffmpeg.js';
import { frameSeconds } from '../../core/time.js';
import { resolveProjectPath } from '../../shared/fs.js';
import { compositionFrames } from '../../core/composition.js';

/** A placement paired with the (already normalized) media file it renders from. */
export interface ComposeClip {
  placement: Placement;
  path: string;
  media: MediaInfo;
}

/** Grade a selected normalized picture interval; audio remains a separate input. */
export async function gradeMedia(
  input: string,
  output: OutputSettings,
  inFrame: number,
  outFrame: number,
  grade: LookGrade,
  destination: string,
): Promise<void> {
  output = OutputSchema.parse(output);
  grade = LookGradeSchema.parse(grade);
  if (!Number.isSafeInteger(inFrame) || inFrame < 0 || !Number.isSafeInteger(outFrame) || outFrame <= inFrame)
    throw new Error('gradeMedia: expected a nonempty half-open frame interval');
  const source = await probeMedia(input);
  if (outFrame > source.frames) throw new Error('gradeMedia: selected interval exceeds actual media frames');
  if (
    source.width !== output.width ||
    source.height !== output.height ||
    source.fps.numerator * output.fps.denominator !== source.fps.denominator * output.fps.numerator
  )
    throw new Error('gradeMedia: input must already match the normalized output raster and clock');
  const count = outFrame - inFrame;
  await ffmpeg([
    '-i',
    input,
    '-an',
    '-vf',
    `trim=start_frame=${inFrame}:end_frame=${outFrame},setpts=PTS-STARTPTS,eq=brightness=${grade.brightness ?? 0}:contrast=${grade.contrast ?? 1}:saturation=${grade.saturation ?? 1}:gamma=${grade.gamma ?? 1}`,
    '-frames:v',
    String(count),
    '-r',
    `${output.fps.numerator}/${output.fps.denominator}`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    ...FFMPEG_OUTPUT_THREADS,
    destination,
  ]);
  const actual = await probeMedia(destination);
  if (actual.frames !== count || actual.audio)
    throw new Error('gradeMedia: graded picture failed its frame/audio contract');
}

/** Stable key for a directed placement pair (NUL cannot appear in an Id). */
function pairKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

// ---------------------------------------------------------------------------
// normalizeMedia
// ---------------------------------------------------------------------------

/**
 * The scale + viewport filter segments that fit an input of arbitrary DAR into
 * the output raster under a {@link MediaFraming}. Shared by `normalizeMedia`
 * (video) and `renderStill` (a held still Asset) so a directly referenced Asset
 * is framed identically whether it is a video or an image. Defaults are contain
 * on black.
 */
function framingFilters(output: OutputSettings, framing?: MediaFraming): { scale: string; viewport: string } {
  const {
    fit = 'contain',
    background = '#000000',
    position = { x: 0.5, y: 0.5 },
  } = MediaFramingSchema.parse(framing ?? {});
  const { width, height } = output;
  // DAR includes input sample aspect ratio. Round the scaled raster outward for
  // cover and inward for contain, on the even chroma grid used by yuv420p.
  const round = fit === 'cover' ? 'ceil' : 'trunc';
  const wide = fit === 'contain' ? 'gt' : 'lt';
  const scale = `scale=w='if(${wide}(dar,${width}/${height}),${width},max(2,${round}(${height}*dar/2)*2))':h='if(${wide}(dar,${width}/${height}),max(2,${round}(${width}/dar/2)*2),${height})':flags=lanczos,setsar=1`;
  const viewport =
    fit === 'cover'
      ? `crop=${width}:${height}:x='trunc((iw-ow)*${position.x}/2)*2':y='trunc((ih-oh)*${position.y}/2)*2'`
      : `pad=${width}:${height}:x='trunc((ow-iw)*${position.x}/2)*2':y='trunc((oh-ih)*${position.y}/2)*2':color=0x${background.slice(1)}`;
  return { scale, viewport };
}

/**
 * Normalize any input into CFR at the output resolution / frame rate without
 * changing timing or motion. The `fps` filter resamples by timestamp (dropping
 * or duplicating frames as needed); duration is preserved and playback speed is
 * never altered. Framing defaults to contain (black bars); explicit cover crops
 * the image. Position is a constant fraction of available padding/crop travel,
 * not a tracked subject coordinate. Input DAR is preserved to an even raster.
 *
 * If the input carries an audio track it is preserved (re-encoded to AAC at the
 * output sample rate / channel count) so placement `audio: keep` can be honored
 * later; the caller trims this normalized audio per placement before mixing.
 *
 * A/V offset is preserved relative to a *shared* origin, not rebased per stream.
 * `-copyts -start_at_zero` keeps the input clock (shifted so the shared start is
 * 0); the audio `aresample=...,first_pts=0` then materializes any real audio
 * delay (e.g. sound entering 0.2s after picture) as leading silence inside the
 * PCM, with the audio stream itself starting at 0. This matters downstream:
 * `mixAudio` decodes PCM from sample 0 and ignores container start offsets, so
 * the delay must live in the samples. Video-only inputs remain valid (audio is
 * mapped optionally).
 */
export async function normalizeMedia(
  input: string,
  output: OutputSettings,
  destination: string,
  framing?: MediaFraming,
): Promise<void> {
  const fps = fpsToString(output.fps);
  const { scale, viewport } = framingFilters(output, framing);
  const vf = `fps=${fps},${scale},${viewport},format=yuv420p`;
  const af = `aresample=${output.sampleRate}:async=1:first_pts=0`;

  await ffmpeg([
    '-copyts',
    '-start_at_zero',
    '-i',
    input,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-vf',
    vf,
    '-af',
    af,
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-r',
    fps,
    '-fps_mode',
    'cfr',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    String(output.sampleRate),
    '-ac',
    String(output.channels),
    '-movflags',
    '+faststart',
    ...FFMPEG_OUTPUT_THREADS,
    destination,
  ]);
}

/**
 * Encode a still image Asset as a picture Take: the same decoded still held for
 * exactly `frames` output-grid frames at the output raster/fps. A still has no
 * intrinsic clock, so the held length is the author's declared stay on the
 * output grid (a Placement `durationFrames`, a layer's `outFrame`). Framing uses
 * the SAME contain-on-black default (and explicit cover/position) as
 * `normalizeMedia`, so image and video Assets use consistent framing.
 * Video-only: no audio stream is produced.
 */
export async function renderStill(
  input: string,
  output: OutputSettings,
  frames: number,
  destination: string,
  framing?: MediaFraming,
): Promise<void> {
  if (!Number.isInteger(frames) || frames <= 0)
    throw new Error(`renderStill: frames must be a positive integer, got ${frames}`);
  const fps = fpsToString(output.fps);
  const { scale, viewport } = framingFilters(output, framing);
  const vf = `${scale},${viewport},format=yuv420p`;
  await ffmpeg([
    '-loop',
    '1',
    '-i',
    input,
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
    '-pix_fmt',
    'yuv420p',
    '-r',
    fps,
    '-fps_mode',
    'cfr',
    '-an',
    ...FFMPEG_OUTPUT_THREADS,
    destination,
  ]);
  const probed = await probeMedia(destination);
  if (probed.frames !== frames) throw new Error(`renderStill: expected ${frames} output frames, got ${probed.frames}`);
  if (probed.audio) throw new Error('renderStill: a still Take must not carry an audio stream');
}

// ---------------------------------------------------------------------------
// composeVideo
// ---------------------------------------------------------------------------

// Every schema transition kind maps either to its ffmpeg `xfade` transition
// name, or to `null` when it is realized by a bounded smear subgraph. The record
// is exhaustively typed so widening the schema without adding a mapping fails at
// compile time. All entries share the same explicit-overlap semantics; only the
// mixing pattern differs.
const XFADE_TRANSITION: Record<Transition['kind'], string | null> = {
  dissolve: 'dissolve',
  wipeleft: 'wipeleft',
  wiperight: 'wiperight',
  wipeup: 'wipeup',
  wipedown: 'wipedown',
  slideleft: 'slideleft',
  slideright: 'slideright',
  slideup: 'slideup',
  slidedown: 'slidedown',
  circleopen: 'circleopen',
  circleclose: 'circleclose',
  hblur: 'hblur',
  // `whipleft`/`whipright` are NOT plain xfade aliases. They are a fast
  // directional slide (the base `xfade` below) whose overlap region is then
  // smeared by a directional horizontal blur — a motion smear, NOT a true
  // motion-blurred camera whip-pan. `null` routes them to that subgraph while
  // keeping this record exhaustive.
  whipleft: null,
  whipright: null,
  // `occlude` is NOT an xfade alias either: the two shots HARD-cut at the middle
  // of the overlap and an occluder Asset sweeps across the overlap so the frame
  // is fully covered at that cut. `null` routes it to that subgraph.
  occlude: null,
};

/** The directional slide `xfade` a whip kind is built on: left whips slide left. */
const WHIP_BASE: Partial<Record<Transition['kind'], string>> = { whipleft: 'slideleft', whipright: 'slideright' };

/**
 * Horizontal directional-blur radius for the whip smear, in pixels. Half the
 * raster width gives a smear on the scale of a real whip pan; the result is a
 * pure function of the output width, so it is deterministic. Clamped to
 * `avgblur`'s 1..1024 range (and >= 3 so the smear is always visible).
 */
function whipSmearRadius(width: number): number {
  return Math.max(3, Math.min(1024, Math.round(width / 2)));
}

/**
 * Compose the video timeline from explicit placements.
 *
 * Geometry rules (validated, never silently repaired):
 *  - Every placement renders `outFrame - inFrame` frames from its source.
 *  - Timeline intervals must tile from 0 with no gaps.
 *  - An overlap between two consecutive placements is only allowed when a
 *    matching transition covers exactly `[overlapStart, overlapEnd)`.
 *  - The total frame count is the union end (overlaps are NOT subtracted again).
 *  - Trim windows must fit inside the probed source frame count.
 *
 * `root` is the project root, needed only to read an `occlude` transition's
 * occluder Asset bytes (asset paths in the Project are project-relative). It is
 * optional so every existing caller and every non-occlude project is unaffected;
 * an `occlude` transition without a root is a loud error rather than a silently
 * missing occluder.
 */
export async function composeVideo(
  project: Project,
  clips: ComposeClip[],
  destination: string,
  root?: string,
): Promise<void> {
  if (clips.length === 0) throw new Error('composeVideo: no clips provided');

  const composition = requireComposition(project);
  const output = composition.output;
  const fps = output.fps;

  const byId = new Map<string, ComposeClip>();
  for (const clip of clips) {
    if (byId.has(clip.placement.id)) throw new Error(`composeVideo: duplicate placement id ${clip.placement.id}`);
    byId.set(clip.placement.id, clip);
  }
  for (const placement of composition.placements) {
    if (!byId.has(placement.id)) throw new Error(`composeVideo: missing clip for placement ${placement.id}`);
  }
  for (const clip of clips) {
    if (!composition.placements.some(p => p.id === clip.placement.id)) {
      throw new Error(`composeVideo: clip references unknown placement ${clip.placement.id}`);
    }
  }

  const ordered = [...clips].sort(
    (a, b) => a.placement.startFrame - b.placement.startFrame || a.placement.id.localeCompare(b.placement.id),
  );

  // Validate each clip's trim window and normalization.
  for (const clip of ordered) {
    const p = clip.placement;
    if (p.durationFrames !== undefined && p.durationFrames !== p.outFrame - p.inFrame)
      throw new Error(`composeVideo: placement ${p.id} retime must be materialized before composition`);
    if (!Number.isInteger(p.inFrame) || !Number.isInteger(p.outFrame) || !Number.isInteger(p.startFrame)) {
      throw new Error(`composeVideo: placement ${p.id} has non-integer frame bounds`);
    }
    if (p.inFrame < 0 || p.outFrame <= p.inFrame) {
      throw new Error(`composeVideo: placement ${p.id} has invalid interval [${p.inFrame}, ${p.outFrame})`);
    }
    if (clip.media.frames <= 0) {
      throw new Error(`composeVideo: placement ${p.id} source has no measurable frames`);
    }
    if (p.outFrame > clip.media.frames) {
      throw new Error(
        `composeVideo: placement ${p.id} requests frames [${p.inFrame}, ${p.outFrame}) but source only has ${clip.media.frames}`,
      );
    }
    if (!sameFps(clip.media.fps, fps)) {
      throw new Error(
        `composeVideo: placement ${p.id} source fps ${fpsToString(clip.media.fps)} is not normalized to composition fps ${fpsToString(fps)}`,
      );
    }
  }

  // Reconcile every transition declaration against the edit before emitting any
  // filter. A transition is authoritative: it must reference existing, adjacent
  // placements, be unique per directed pair, and cover a non-empty range.
  // Whether each one is actually consumed by an overlap is checked after
  // folding, so a stale or zero-lap declaration can never be silently ignored.
  const transitions = composition.transitions;
  const transitionByPair = new Map<string, Transition>();
  for (const declared of transitions) {
    const transition = TransitionSchema.parse(declared);
    const pair = pairKey(transition.from, transition.to);
    if (transitionByPair.has(pair)) {
      throw new Error(`composeVideo: duplicate transition declarations for ${transition.from}->${transition.to}`);
    }
    if (transition.endFrame <= transition.startFrame) {
      throw new Error(
        `composeVideo: transition ${transition.from}->${transition.to} has empty range [${transition.startFrame}, ${transition.endFrame})`,
      );
    }
    const fromIndex = ordered.findIndex(clip => clip.placement.id === transition.from);
    const toIndex = ordered.findIndex(clip => clip.placement.id === transition.to);
    if (fromIndex === -1 || toIndex === -1) {
      throw new Error(`composeVideo: transition ${transition.from}->${transition.to} references an unknown placement`);
    }
    if (toIndex !== fromIndex + 1) {
      throw new Error(
        `composeVideo: transition ${transition.from}->${transition.to} does not bind adjacent placements`,
      );
    }
    transitionByPair.set(pair, transition);
  }

  // Build the per-segment filter chains.
  const segmentFilters: string[] = ordered.map((clip, i) => {
    const p = clip.placement;
    return (
      `[${i}:v]trim=start_frame=${p.inFrame}:end_frame=${p.outFrame},setpts=PTS-STARTPTS,` +
      `fps=${fpsToString(fps)},scale=${output.width}:${output.height}:flags=lanczos,setsar=1,format=yuv420p[s${i}]`
    );
  });

  let current = 's0';
  let currentEnd = ordered[0].placement.startFrame + (ordered[0].placement.outFrame - ordered[0].placement.inFrame);

  if (ordered[0].placement.startFrame !== 0) {
    throw new Error(
      `composeVideo: timeline starts at frame ${ordered[0].placement.startFrame}; first placement must start at 0`,
    );
  }

  // Every concat output is re-stamped onto the exact output frame period. The
  // concat filter emits its own (microsecond) timebase, which xfade refuses to
  // mix with the fps-filter link timebase; settb fixes the period and setpts=N
  // renumbers the frames so duration and geometry are unchanged.
  const settleTimebase = `settb=expr=${fps.denominator}/${fps.numerator},setpts=N`;
  const consumedTransitions = new Set<string>();
  // Occluder images are extra ffmpeg inputs appended after the placement clips.
  // Each `occlude` transition opens its own input so a reused Asset never needs
  // a `split` and no input pad is consumed twice.
  const occluderInputs: string[] = [];

  const foldFilters: string[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1].placement;
    const cur = ordered[i].placement;
    const dur = cur.outFrame - cur.inFrame;
    const start = cur.startFrame;
    const overlap = currentEnd - start;

    if (overlap < 0) {
      throw new Error(
        `composeVideo: gap of ${-overlap} frames before placement ${cur.id} (expected start ${currentEnd}, got ${start})`,
      );
    }

    const label = `f${i}`;
    if (overlap === 0) {
      foldFilters.push(`[${current}][s${i}]concat=n=2:v=1:a=0,${settleTimebase}[${label}]`);
    } else {
      const pair = pairKey(prev.id, cur.id);
      const transition = transitionByPair.get(pair);
      if (!transition) {
        throw new Error(
          `composeVideo: unauthorized overlap of ${overlap} frames between placements ${prev.id} and ${cur.id}`,
        );
      }
      const xfade = XFADE_TRANSITION[transition.kind];
      if (transition.startFrame !== start || transition.endFrame !== currentEnd) {
        throw new Error(
          `composeVideo: transition ${transition.from}->${transition.to} range [${transition.startFrame}, ${transition.endFrame}) ` +
            `does not match overlap [${start}, ${currentEnd})`,
        );
      }
      const prevDuration = prev.outFrame - prev.inFrame;
      if (overlap >= prevDuration || overlap >= dur) {
        throw new Error(
          `composeVideo: ${transition.kind} overlap ${overlap} must be shorter than both placements (${prevDuration} and ${dur})`,
        );
      }
      consumedTransitions.add(pair);
      const duration = frameSeconds(overlap, fps);
      const offset = frameSeconds(currentEnd - overlap, fps);
      if (xfade === null) {
        if (transition.kind === 'occlude') {
          // Occlusion transition: the two shots HARD-cut at the MIDDLE
          // of the overlap, an occluder Asset sweeps across the overlap so the
          // frame is FULLY covered exactly at that cut, then it clears to reveal
          // the incoming shot — the splice happens under the cover. Because the
          // fold accumulates, the cover cannot simply run after the mix: the
          // hard-cut base is split into [pre | overlap | post], only the overlap
          // is covered, and the three parts are re-concatenated with the SAME
          // offset/duration arithmetic as every other kind, so the frame count
          // is exactly unchanged (pre + overlap + post == the union length).
          //
          // HONEST SCOPE: this is a deterministic 2-D sweep of ONE authored
          // occluder image, positioned so the cover lands on the cut. It does NO
          // automatic foreground matting, NO depth estimation and NO motion
          // tracking, and it never reads the incoming shot's pixels. An
          // occluder that is transparent or perforated in the raster will NOT
          // fully hide the cut; the author must supply an opaque image that
          // reads as something passing the lens.
          const occluderId = transition.occluder;
          if (occluderId === undefined) {
            throw new Error(
              `composeVideo: occlusion transition ${transition.from}->${transition.to} has no occluder Asset`,
            );
          }
          if (!root) {
            throw new Error(
              `composeVideo: transition ${transition.from}->${transition.to} is an occlusion transition but composeVideo was not given the project root to read occluder Asset '${occluderId}'`,
            );
          }
          const occluderAsset = project.assets.find(asset => asset.id === occluderId);
          if (!occluderAsset) {
            throw new Error(
              `composeVideo: transition ${transition.from}->${transition.to} names unknown occluder Asset '${occluderId}'`,
            );
          }
          if (occluderAsset.type !== 'image') {
            throw new Error(
              `composeVideo: occluder Asset '${occluderId}' must be an image (type "image"), got "${occluderAsset.type}"`,
            );
          }
          // A single-frame occluder cannot both sweep in and out around the cut
          // in fewer than three frames.
          if (overlap < 3) {
            throw new Error(
              `composeVideo: ${transition.kind} overlap ${overlap} is too short; an occlusion transition needs at least 3 frames so the occluder can sweep in and out around the cut`,
            );
          }
          const occluderIndex = ordered.length + occluderInputs.length;
          occluderInputs.push(await resolveProjectPath(root, occluderAsset.path));
          const width = output.width;
          const height = output.height;
          const cut = Math.floor(overlap / 2); // frames into the overlap where the hard cut lands
          const cutOutput = start + cut; // the output frame the cut lands on
          const cutSeconds = frameSeconds(cut, fps);
          const lastSeconds = frameSeconds(overlap - 1, fps);
          // The occluder is scaled to COVER the raster, then swept from fully
          // off-left to fully off-right across the overlap. At t == cutSeconds
          // the left branch evaluates to exactly 0, so an opaque WxH occluder
          // covers the frame at the cut; before it the outgoing shot shows and
          // after it the incoming shot is revealed. See the frame-evidence test.
          const sweep = `if(lte(t,${cutSeconds}),-${width}+${width}*(t/${cutSeconds}),${width}*(t-${cutSeconds})/(${lastSeconds}-${cutSeconds}))`;
          foldFilters.push(
            `[${current}]trim=start_frame=0:end_frame=${cutOutput},setpts=PTS-STARTPTS[ca${i}]`,
            `[s${i}]trim=start_frame=${cut}:end_frame=${dur},setpts=PTS-STARTPTS[cb${i}]`,
            `[ca${i}][cb${i}]concat=n=2:v=1:a=0,${settleTimebase}[cbase${i}]`,
            `[cbase${i}]split=3[cp${i}][cm${i}][cq${i}]`,
            `[cp${i}]trim=start_frame=0:end_frame=${start},setpts=PTS-STARTPTS[cpre${i}]`,
            `[cm${i}]trim=start_frame=${start}:end_frame=${currentEnd},setpts=PTS-STARTPTS[cmid${i}]`,
            `[cq${i}]trim=start_frame=${currentEnd},setpts=PTS-STARTPTS[cpost${i}]`,
            `[${occluderIndex}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}:(iw-ow)/2:(ih-oh)/2,setsar=1,format=rgba,trim=end_frame=${overlap},setpts=PTS-STARTPTS[occ${i}]`,
            `[cmid${i}][occ${i}]overlay=x='${sweep}':y=0:eval=frame[cov${i}]`,
            `[cpre${i}][cov${i}][cpost${i}]concat=n=3:v=1:a=0,${settleTimebase}[${label}]`,
          );
        } else {
          // Whip smear: a fast directional slide PLUS a directional horizontal
          // blur applied to the overlap region only. HONEST SCOPE: this is a
          // motion SMEAR, not a true motion-blurred camera whip-pan. Because the
          // fold accumulates, the blur cannot simply run after the mix; instead
          // the xfade result is split into [pre | overlap | post], only the
          // overlap is smeared, and the three parts are re-concatenated with the
          // SAME offset/duration arithmetic as every other kind. The frame count
          // is therefore exactly unchanged (pre + overlap + post == the plain
          // xfade length). `start >= 1` and `post >= 1` are guaranteed by the
          // overlap < both placements rule, so no segment is ever empty.
          const base = WHIP_BASE[transition.kind];
          if (!base) throw new Error(`composeVideo: whips have no base transition for kind ${transition.kind}`);
          const radius = whipSmearRadius(output.width);
          foldFilters.push(
            `[${current}][s${i}]xfade=transition=${base}:duration=${duration}:offset=${offset}[mx${i}]`,
            `[mx${i}]split=3[wa${i}][wb${i}][wc${i}]`,
            `[wa${i}]trim=start_frame=0:end_frame=${start},setpts=PTS-STARTPTS[wp${i}]`,
            `[wb${i}]trim=start_frame=${start}:end_frame=${currentEnd},setpts=PTS-STARTPTS,avgblur=sizeX=${radius}:sizeY=1[ws${i}]`,
            `[wc${i}]trim=start_frame=${currentEnd},setpts=PTS-STARTPTS[wq${i}]`,
            `[wp${i}][ws${i}][wq${i}]concat=n=3:v=1:a=0,${settleTimebase}[${label}]`,
          );
        }
      } else {
        foldFilters.push(
          `[${current}][s${i}]xfade=transition=${xfade}:duration=${duration}:offset=${offset}[${label}]`,
        );
      }
    }
    current = label;
    currentEnd = start + dur;
  }

  // A transition declaration must be realized by exactly one overlap; anything
  // left over (stale reference, zero-overlap dissolve, moved cut) fails here
  // instead of being silently dropped.
  const unconsumed = [...transitionByPair.keys()].filter(pair => !consumedTransitions.has(pair));
  if (unconsumed.length > 0) {
    throw new Error(
      `composeVideo: transition(s) not consumed by any overlap: ${unconsumed.map(pair => pair.replace('\u0000', '->')).join(', ')}`,
    );
  }

  const contentFrames = currentEnd;
  const totalFrames = compositionFrames(project);
  if (contentFrames > totalFrames) {
    throw new Error(
      `composeVideo: content ends at ${contentFrames} frames but the composition interval is only ${totalFrames} frames`,
    );
  }
  if (totalFrames <= 0) throw new Error('composeVideo: total frame count must be positive');

  // An explicit programme length longer than the content pads a black tail so
  // the picture is exactly the declared length. When no extra length is
  // declared the pad is skipped entirely, so the filter graph and the encoded
  // bytes are exactly the max placement end.
  const filters = [...segmentFilters, ...foldFilters];
  let outputLabel = current;
  if (totalFrames > contentFrames) {
    // Overshoot the pad by one frame and cap with `-frames:v`: this keeps the
    // exact declared length even where a frame period is not a finite decimal.
    const stopSeconds = frameSeconds(totalFrames - contentFrames + 1, fps);
    filters.push(`[${current}]tpad=stop_mode=add:stop_duration=${stopSeconds}:color=black[padout]`);
    outputLabel = 'padout';
  }
  const filterGraph = filters.join(';');
  const inputArgs: string[] = [];
  for (const clip of ordered) inputArgs.push('-i', clip.path);
  // Occluder stills are appended after the placement clips, exactly matching the
  // `occluderIndex` assigned above. `-loop 1` repeats the single image; the graph
  // trims it to the overlap, so it never adds output frames.
  for (const occluder of occluderInputs) inputArgs.push('-loop', '1', '-framerate', fpsToString(fps), '-i', occluder);

  await ffmpeg([
    ...inputArgs,
    '-filter_complex',
    filterGraph,
    '-map',
    `[${outputLabel}]`,
    '-frames:v',
    String(totalFrames),
    '-r',
    fpsToString(fps),
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
  if (probed.frames !== totalFrames) {
    throw new Error(`composeVideo: expected ${totalFrames} output frames, got ${probed.frames}`);
  }
}

// ---------------------------------------------------------------------------
// Preview helpers
// ---------------------------------------------------------------------------

/**
 * A black, silent stand-in clip for a Placement that lies wholly outside a
 * preview range: the timeline keeps its exact length so every in-range frame is
 * composed exactly as in the full Build, but the Placement's Source is never
 * produced for the preview.
 */
export async function renderGap(output: OutputSettings, frames: number, destination: string): Promise<void> {
  if (!Number.isInteger(frames) || frames <= 0) throw new Error(`renderGap: frames must be positive, got ${frames}`);
  const fps = fpsToString(output.fps);
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=${output.width}x${output.height}:r=${fps}`,
    '-frames:v',
    String(frames),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-r',
    fps,
    '-an',
    ...FFMPEG_OUTPUT_THREADS,
    destination,
  ]);
  const probed = await probeMedia(destination);
  if (probed.frames !== frames) throw new Error(`renderGap: expected ${frames} frames, got ${probed.frames}`);
}

/**
 * Cut the output-frame range `[start, end)` from a composed programme and scale
 * it to `size` (the even proxy raster). Picture and audio are cut on the same frame
 * clock, so the preview carries exactly the programme audio of that range.
 */
export async function trimPreview(
  input: string,
  output: OutputSettings,
  start: number,
  end: number,
  size: { width: number; height: number },
  destination: string,
): Promise<void> {
  const frames = end - start;
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(end) || frames <= 0)
    throw new Error(`trimPreview: invalid range ${start}:${end}`);
  const { width, height } = size;
  const fps = fpsToString(output.fps);
  const from = frameSeconds(start, output.fps);
  const to = frameSeconds(end, output.fps);
  const info = await probeMedia(input);
  await ffmpeg([
    '-i',
    input,
    '-vf',
    `trim=start_frame=${start}:end_frame=${end},setpts=PTS-STARTPTS,scale=${width}:${height}:flags=lanczos,setsar=1,format=yuv420p`,
    ...(info.audio ? ['-af', `atrim=start=${from}:end=${to},asetpts=PTS-STARTPTS`] : ['-an']),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-r',
    fps,
    '-fps_mode',
    'cfr',
    ...(info.audio
      ? ['-c:a', 'aac', '-b:a', '192k', '-ar', String(output.sampleRate), '-ac', String(output.channels)]
      : []),
    ...FFMPEG_OUTPUT_THREADS,
    destination,
  ]);
  const probed = await probeMedia(destination);
  if (probed.frames !== frames) throw new Error(`trimPreview: expected ${frames} frames, got ${probed.frames}`);
}

/** Extract the first frame of `input` as a PNG. */
export async function extractStill(input: string, destination: string): Promise<void> {
  await ffmpeg(['-i', input, '-frames:v', '1', '-update', '1', ...FFMPEG_OUTPUT_THREADS, destination]);
}
