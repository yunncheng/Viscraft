/**
 * Real PCM signals for tests that need authored audio.
 *
 * A signal is plain authored audio: an actual mono/stereo WAV Asset written at
 * the output's own sample rate and channel count. It is not a Runtime tone
 * clip, an oscillator service, a voice registry or a compatibility wrapper:
 * tests register the returned Asset and point a `kind: 'asset'` clip at it,
 * exactly as an author would after importing a recording.
 *
 * The generator is deterministic and writes 16-bit PCM through the same
 * `encodeWav` the media backend uses. Samples are never clamped here: the
 * requested amplitude must already be representable, so an overload test can
 * only reach full scale by summing real clips, not by hiding a hot fixture.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { encodeWav } from '../src/backends/media/pcm.js';
import type { Asset } from '../src/core/schema.js';

export interface SignalAssetSpec {
  id: string;
  /** Project-relative destination path; `writeSignalAsset` writes under `root`. */
  path: string;
  /** The real output sample rate (44100 or 48000). */
  sampleRate: number;
  /** The real output channel count (1 or 2). */
  channels: number;
  /** Sample frames per channel, not interleaved values. */
  samples: number;
  frequency?: number;
  waveform?: 'sine' | 'triangle';
  /** Peak amplitude in [0, 1]; default 1. Never clamped. */
  amplitude?: number;
}

interface ResolvedSignalSpec {
  id: string;
  path: string;
  sampleRate: number;
  channels: number;
  samples: number;
  frequency: number;
  waveform: 'sine' | 'triangle';
  amplitude: number;
}

function resolveSpec(spec: SignalAssetSpec): ResolvedSignalSpec {
  const { id, path, sampleRate, channels, samples, frequency = 440, waveform = 'sine', amplitude = 1 } = spec;
  if (typeof id !== 'string' || id.length === 0) throw new Error('makeSignalAsset: id must be a non-empty string');
  if (typeof path !== 'string' || path.length === 0)
    throw new Error('makeSignalAsset: path must be a non-empty project-relative string');
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some(part => part === '' || part === '.' || part === '..')
  )
    throw new Error(`makeSignalAsset: ${JSON.stringify(path)} is not a safe project-relative path`);
  if (sampleRate !== 44100 && sampleRate !== 48000)
    throw new Error(`makeSignalAsset: sampleRate must be the real output rate (44100 or 48000), got ${sampleRate}`);
  if (channels !== 1 && channels !== 2) throw new Error(`makeSignalAsset: channels must be 1 or 2, got ${channels}`);
  if (!Number.isSafeInteger(samples) || samples <= 0)
    throw new Error(`makeSignalAsset: samples must be a positive safe integer, got ${samples}`);
  if (!Number.isFinite(frequency) || frequency <= 0)
    throw new Error(`makeSignalAsset: frequency must be finite and positive, got ${frequency}`);
  if (waveform !== 'sine' && waveform !== 'triangle')
    throw new Error(`makeSignalAsset: waveform must be "sine" or "triangle", got ${String(waveform)}`);
  if (!Number.isFinite(amplitude) || amplitude < 0 || amplitude > 1)
    throw new Error(`makeSignalAsset: amplitude must be finite in [0, 1], got ${amplitude}; never clamp a hot signal`);
  return { id, path, sampleRate, channels, samples, frequency, waveform, amplitude };
}

/**
 * Build a full-scale-by-default PCM WAV byte image and the Asset that describes
 * it. Nothing is written; the caller may inspect `bytes` (for a hash check) or
 * use `writeSignalAsset` to materialize it under a project root.
 */
export function makeSignalAsset(spec: SignalAssetSpec): { asset: Asset; bytes: Buffer } {
  const resolved = resolveSpec(spec);
  const { sampleRate, channels, samples, frequency, waveform, amplitude } = resolved;
  const pcm = new Float32Array(samples * channels);
  const omega = (2 * Math.PI * frequency) / sampleRate;
  for (let i = 0; i < samples; i++) {
    const phase = omega * i;
    const value = (waveform === 'triangle' ? (2 / Math.PI) * Math.asin(Math.sin(phase)) : Math.sin(phase)) * amplitude;
    for (let channel = 0; channel < channels; channel++) pcm[i * channels + channel] = value;
  }
  const bytes = encodeWav(pcm, sampleRate, channels);
  const asset: Asset = {
    id: resolved.id,
    revision: 1,
    path: resolved.path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    type: 'audio',
    rights: {
      origin: 'generated test signal',
      license: 'CC0-1.0',
      redistributable: true,
    },
    simulated: false,
  };
  return { asset, bytes };
}

/**
 * Materialize a signal under `root` at its project-relative path and return the
 * Asset to register. The parent directory is created; only the requested file
 * is written.
 */
export async function writeSignalAsset(root: string, spec: SignalAssetSpec): Promise<Asset> {
  const { asset, bytes } = makeSignalAsset(spec);
  const absolute = join(root, asset.path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes);
  return asset;
}
