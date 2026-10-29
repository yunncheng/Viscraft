import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';
import { ffmpeg, FFMPEG_OUTPUT_THREADS } from './ffmpeg.js';
import * as os from 'node:os';

// ---------------------------------------------------------------------------
// PCM decoding, bounded memoization and WAV encoding
// ---------------------------------------------------------------------------

let decodeCounter = 0;

/**
 * Process-wide decoded-PCM memo, keyed by resolved path + target rate/channels
 * + file size + mtime. A programme mix and each of its grouped stem exports
 * route the SAME source files through `decodePcm` again; without a memo a
 * multi-minute bed is decoded once per clip and once per bus, and a kept take is
 * decoded for its body plus once more for each of its J/L-cut pre-roll/outro
 * reads. The key includes size+mtime so an in-place rewrite that changes the
 * bytes is a cache miss, never stale audio. Bounded by total PCM bytes with
 * LRU eviction; the returned array is shared and must be treated as read-only
 * (every mixer here reads it and never writes it).
 */
interface DecodedPcm {
  samples: Float32Array;
  bytes: number;
}

const DECODE_CACHE = new Map<string, DecodedPcm>();

const DECODE_CACHE_LIMIT_BYTES = 512 * 1024 * 1024;

let decodeCacheBytes = 0;

function decodeCacheKey(absolute: string, sampleRate: number, channels: number, size: number, mtimeMs: number): string {
  return `${absolute}\u0000${sampleRate}\u0000${channels}\u0000${size}\u0000${mtimeMs}`;
}

function decodeCacheStore(key: string, entry: DecodedPcm): void {
  const previous = DECODE_CACHE.get(key);
  if (previous) decodeCacheBytes -= previous.bytes;
  DECODE_CACHE.delete(key);
  DECODE_CACHE.set(key, entry);
  decodeCacheBytes += entry.bytes;
  while (decodeCacheBytes > DECODE_CACHE_LIMIT_BYTES) {
    const oldest = DECODE_CACHE.keys().next();
    if (oldest.done) break;
    decodeCacheBytes -= DECODE_CACHE.get(oldest.value)!.bytes;
    DECODE_CACHE.delete(oldest.value);
  }
}

/**
 * Decode any media file to interleaved 32-bit float PCM at the target rate and
 * channel count. Raw PCM cannot travel through `runCommand`'s string stdout, so
 * it is written to a temporary file first. Results for stable on-disk inputs are
 * memoized (see `DECODE_CACHE`); pass `cache = false` for a transient file whose
 * path is unique per call (e.g. a ducking control-bus scratch mix).
 */
export async function decodePcm(
  input: string,
  sampleRate: number,
  channels: number,
  tmpDir: string,
  cache = true,
): Promise<Float32Array> {
  let key: string | undefined;
  if (cache) {
    try {
      const stat = await fs.stat(input);
      key = decodeCacheKey(nodePath.resolve(input), sampleRate, channels, stat.size, stat.mtimeMs);
      const hit = DECODE_CACHE.get(key);
      if (hit) {
        decodeCacheStore(key, hit);
        return hit.samples;
      }
    } catch {
      key = undefined;
    }
  }
  const rawPath = nodePath.join(tmpDir, `decode-${decodeCounter++}.f32le`);
  await ffmpeg([
    '-i',
    input,
    '-vn',
    '-f',
    'f32le',
    '-acodec',
    'pcm_f32le',
    '-ar',
    String(sampleRate),
    '-ac',
    String(channels),
    ...FFMPEG_OUTPUT_THREADS,
    rawPath,
  ]);
  const buf = await fs.readFile(rawPath);
  const total = Math.floor(buf.length / 4);
  // `pcm_f32le` output is little-endian by definition; on a little-endian host a
  // Float32Array over the same bytes is the identical sample sequence, so skip
  // the per-element conversion. Fall back to an explicit read when unaligned or
  // on a big-endian host.
  const samples =
    os.endianness() === 'LE' && buf.byteOffset % 4 === 0
      ? new Float32Array(buf.buffer, buf.byteOffset, total)
      : copyFloat32(buf, total);
  // Guard against a truncated final frame.
  const usable = total - (total % channels);
  const result = usable === total ? samples : samples.subarray(0, usable);
  if (key) decodeCacheStore(key, { samples: result, bytes: result.byteLength });
  return result;
}

function copyFloat32(buf: Buffer, total: number): Float32Array {
  const out = new Float32Array(total);
  for (let i = 0; i < total; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

export function encodeWav(samples: Float32Array, sampleRate: number, channels: number): Buffer {
  const frames = Math.floor(samples.length / channels);
  const dataBytes = frames * channels * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28); // byte rate
  buf.writeUInt16LE(channels * 2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);

  let offset = 44;
  for (let i = 0; i < frames * channels; i++) {
    // Range already validated by assertWithinRange; convert without clamping.
    buf.writeInt16LE(Math.round(samples[i] * 32767), offset);
    offset += 2;
  }
  return buf;
}
