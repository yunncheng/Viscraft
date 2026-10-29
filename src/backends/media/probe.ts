import { type Fps, type MediaInfo } from '../../core/schema.js';
import { runCommand } from '../../shared/process.js';
import { messageOf } from './ffmpeg.js';
import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import { decodePcm } from './pcm.js';

// ---------------------------------------------------------------------------
// Rational frame-rate helpers
// ---------------------------------------------------------------------------

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

/** Parse an ffprobe rational ("30000/1001" or "25") into a reduced Fps. */
function parseFpsField(value: unknown): Fps | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const parts = value.split('/');
  const numerator = Number(parts[0]);
  const denominator = parts.length > 1 ? Number(parts[1]) : 1;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return undefined;
  if (denominator === 0 || numerator <= 0) return undefined;
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) return undefined;
  const g = gcd(numerator, denominator);
  return { numerator: numerator / g, denominator: denominator / g };
}

function fpsToNumber(fps: Fps): number {
  return fps.numerator / fps.denominator;
}

/** FFmpeg wants rational rates as "num/den"; this is exact, not decimal. */
export function fpsToString(fps: Fps): string {
  return `${fps.numerator}/${fps.denominator}`;
}

export function sameFps(a: Fps, b: Fps): boolean {
  return a.numerator * b.denominator === b.numerator * a.denominator;
}

/** Parse an ffprobe time_base ("1/48000") into a number of seconds per tick. */
function parseTimeBase(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parts = value.split('/');
  const numerator = Number(parts[0]);
  const denominator = parts.length > 1 ? Number(parts[1]) : 1;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator <= 0 || denominator <= 0)
    return undefined;
  return numerator / denominator;
}

/** Parse an ffprobe rational ("1/48000" or "48000") into a reduced integer pair. */
function parseRational(value: unknown): { numerator: number; denominator: number } | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const parts = value.split('/');
  const numerator = Number(parts[0]);
  const denominator = parts.length > 1 ? Number(parts[1]) : 1;
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || numerator <= 0 || denominator <= 0)
    return undefined;
  const g = gcd(numerator, denominator);
  return { numerator: numerator / g, denominator: denominator / g };
}

function toInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.length > 0) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// probeMedia
// ---------------------------------------------------------------------------

interface ProbeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  nb_read_frames?: string;
  nb_frames?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
  duration_ts?: string;
  time_base?: string;
  start_pts?: string;
  start_time?: string;
}

interface ProbeResult {
  streams?: ProbeStream[];
  format?: { duration?: string };
}

async function ffprobe(
  entries: string,
  file: string,
  countFrames: boolean,
  streamSelector?: string,
): Promise<ProbeResult> {
  const args = ['-v', 'error'];
  if (countFrames) args.push('-count_frames');
  if (streamSelector) args.push('-select_streams', streamSelector);
  args.push('-show_entries', entries, '-of', 'json', file);
  try {
    const raw = await runCommand('ffprobe', args);
    return JSON.parse(raw) as ProbeResult;
  } catch (err) {
    throw new Error(`ffprobe failed for ${file}: ${messageOf(err)}`);
  }
}

/**
 * Real facts read from a file's own audio stream, or `undefined` when the file
 * carries no audio stream. Shared by `probeMedia` and `probeAudio` so both
 * report the same audio truth from the same probe.
 */
interface ProbedAudioFacts {
  sampleRate: number;
  channels: number;
  /** Real audio-stream duration in seconds (never the video/container clock). */
  duration: number;
}

/**
 * `-select_streams a:0` with no audio stream yields an empty list (exit 0), so
 * it is the only "no audio" signal. Any ffprobe/decode failure propagates: we
 * never mask real errors as "silent media".
 */
async function probeAudioStream(file: string): Promise<ProbedAudioFacts | undefined> {
  const probe = await ffprobe('stream=sample_rate,channels,duration,duration_ts,time_base', file, false, 'a:0');
  const stream = (probe.streams ?? [])[0];
  if (!stream) return undefined;
  const sampleRate = toInt(stream.sample_rate);
  const channels = toInt(stream.channels);
  if (sampleRate === undefined || channels === undefined) return undefined;
  // Real audio duration only. Never substitute the video/container duration:
  // that would make any A/V sync check pass trivially.
  let duration = Number(stream.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    const ticks = toInt(stream.duration_ts);
    const tickSeconds = parseTimeBase(stream.time_base);
    if (ticks !== undefined && ticks > 0 && tickSeconds !== undefined) duration = ticks * tickSeconds;
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    // Last resort: decode the audio and count real PCM samples.
    duration = await measureAudioDuration(file, sampleRate, channels);
  }
  return { sampleRate, channels, duration };
}

/**
 * Probe a media file with real frame counting (`-count_frames`) and rational
 * frame rate. Video is required; audio is reported when present.
 */
export async function probeMedia(file: string): Promise<MediaInfo> {
  const videoProbe = await ffprobe(
    'stream=codec_name,width,height,r_frame_rate,avg_frame_rate,nb_read_frames,nb_frames,duration:format=duration',
    file,
    true,
    'v:0',
  );
  const stream = (videoProbe.streams ?? [])[0];
  if (!stream) throw new Error(`probeMedia: no video stream found in ${file}`);

  const declared = stream.r_frame_rate && stream.r_frame_rate !== '0/0' ? stream.r_frame_rate : undefined;
  const fps = parseFpsField(declared) ?? parseFpsField(stream.avg_frame_rate);
  if (!fps) throw new Error(`probeMedia: could not determine frame rate of ${file}`);

  const frames = toInt(stream.nb_read_frames) ?? toInt(stream.nb_frames);
  if (frames === undefined || frames <= 0) {
    throw new Error(`probeMedia: could not determine frame count of ${file}`);
  }

  // Prefer the video stream's own duration; fall back to the container only if
  // the stream omits it, and finally derive it from the counted frame rate.
  // (Never borrow another stream's duration.)
  let duration = Number(stream.duration);
  if (!Number.isFinite(duration) || duration <= 0) duration = Number(videoProbe.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) duration = frames / fpsToNumber(fps);

  const width = toInt(stream.width) ?? 0;
  const height = toInt(stream.height) ?? 0;
  const videoCodec = typeof stream.codec_name === 'string' ? stream.codec_name : 'unknown';

  const info: MediaInfo = { frames, fps, width, height, duration, videoCodec };

  // `-select_streams a:0` with no audio stream yields an empty list (exit 0),
  // so it is the only "no audio" signal. Any ffprobe/decode failure propagates:
  // we never mask real errors as "silent media".
  const audioFacts = await probeAudioStream(file);
  if (audioFacts)
    info.audio = { sampleRate: audioFacts.sampleRate, channels: audioFacts.channels, duration: audioFacts.duration };

  return info;
}

/** Real audio-only facts of a file: its own sample rate, channel count, duration and sample count. */
export interface AudioMediaInfo {
  sampleRate: number;
  channels: number;
  /** Real audio-stream duration in seconds (never a video/container clock). */
  duration: number;
  /** The audio stream's own sample-frame count. */
  samples: number;
}

/**
 * Probe a file as **audio only**, never requiring a video stream.
 *
 * `probeMedia` requires a video stream (it measures picture frames), so an
 * audio-only artifact — for example a code-authored `sound` Source rendered to
 * a WAV — cannot be described by it. `probeAudio` reports the stream's real
 * sample rate, channel count, duration and sample count instead of pretending
 * the file has picture. A file with no audio stream is a loud error, never a
 * fabricated empty result.
 */
export async function probeAudio(file: string): Promise<AudioMediaInfo> {
  const facts = await probeAudioStream(file);
  if (!facts) throw new Error(`probeAudio: no audio stream found in ${file}`);
  const samples = Math.round(facts.duration * facts.sampleRate);
  if (!Number.isSafeInteger(samples) || samples <= 0) {
    throw new Error(`probeAudio: could not determine a positive sample count of ${file}`);
  }
  return { sampleRate: facts.sampleRate, channels: facts.channels, duration: facts.duration, samples };
}

/** One real audio stream of a file, as enumerated by `probeAudioStreams`. */
export interface AudioStreamFacts {
  /**
   * Audio-relative index (0-based among the file's audio streams) — exactly the
   * `<n>` FFmpeg's `-map 0:a:<n>` selects. Never the absolute container index,
   * which would silently pick the wrong stream when a video stream precedes it.
   */
  index: number;
  codec: string;
  sampleRate: number;
  channels: number;
  /** The stream's rational timebase: one PTS tick is numerator/denominator seconds. */
  timebase: { numerator: number; denominator: number };
  /** The stream's first PTS, in its own timebase; undefined when the container reports none. */
  startPts?: number;
  /** The stream duration in its own timebase ticks; undefined when unreported. */
  durationTicks?: number;
}

/**
 * Enumerate EVERY audio stream of a file with its own real facts, via
 * `-select_streams a`. `probeMedia`'s `MediaInfo` only describes the FIRST audio
 * stream, so multi-stream selection and any per-stream PTS/timebase mapping need
 * this real enumeration.
 *
 * The returned array is in FFprobe order (container index ascending), so an
 * entry's `index` is its AUDIO-RELATIVE position — the value FFmpeg's
 * `-map 0:a:<index>` accepts, and the value an audio Asset's `derivedFrom`
 * records. An empty array is the only "no audio stream" signal (ffprobe exits 0
 * with no streams). A stream that lacks a usable sample rate, channel count,
 * timebase or index cannot be described or selected, so it is refused loudly
 * rather than reported as partial facts. Any ffprobe failure propagates: we
 * never mask a real error as "silent media".
 */
export async function probeAudioStreams(file: string): Promise<AudioStreamFacts[]> {
  const probe = await ffprobe(
    'stream=index,codec_name,sample_rate,channels,time_base,start_pts,duration_ts',
    file,
    false,
    'a',
  );
  const ordered = (probe.streams ?? []).slice().sort((a, b) => (toInt(a.index) ?? 0) - (toInt(b.index) ?? 0));
  return ordered.map((stream, ordinal) => {
    const sampleRate = toInt(stream.sample_rate);
    const channels = toInt(stream.channels);
    const timebase = parseRational(stream.time_base);
    if (sampleRate === undefined || channels === undefined || !timebase)
      throw new Error(
        `probeAudioStreams: audio stream ${ordinal} of ${file} lacks a usable sample rate, channel count or timebase`,
      );
    return {
      index: ordinal,
      codec: typeof stream.codec_name === 'string' ? stream.codec_name : 'unknown',
      sampleRate,
      channels,
      timebase,
      startPts: toInt(stream.start_pts),
      durationTicks: toInt(stream.duration_ts),
    };
  });
}

/** Decode the audio stream and derive its duration from the PCM sample count. */
async function measureAudioDuration(file: string, sampleRate: number, channels: number): Promise<number> {
  const tmpDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-probe-'));
  try {
    const pcm = await decodePcm(file, sampleRate, channels, tmpDir);
    return pcm.length / channels / sampleRate;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

/** Whether a file declares an audio stream. ffprobe failures propagate. */
export async function hasAudioStream(file: string): Promise<boolean> {
  const probe = await ffprobe('stream=codec_type', file, false, 'a:0');
  return (probe.streams ?? []).length > 0;
}
