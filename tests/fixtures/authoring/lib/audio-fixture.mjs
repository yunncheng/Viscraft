/*
 * Test-only signal assets for the authoring fixtures.
 *
 * These fixtures generate small deterministic WAV files and register their
 * real bytes as `audio` Assets. Composition `asset` clips then exercise timing,
 * gain and mixing through the normal media path.
 *
 * This helper is deliberately small: pure Node, no Runtime/Skill lookup, no
 * file writes and no envelope beyond the clip's own fades.
 */
import { createHash } from 'node:crypto';

// Kept semantically identical to `tests/audio-fixtures.ts` (the TS helper owns
// the same contract for test code); this copy exists because the .mjs fixtures
// run before/without the compiled test tree.
export const SIGNAL_RIGHTS = {
  origin: 'generated test signal',
  license: 'CC0-1.0',
  redistributable: true,
};

const WAVEFORMS = new Set(['sine', 'triangle']);

function sampleAt(waveform, phase) {
  switch (waveform) {
    case 'sine':
      return Math.sin(2 * Math.PI * phase);
    case 'triangle':
      return (2 / Math.PI) * Math.asin(Math.sin(2 * Math.PI * phase));
    default:
      throw new Error(`unknown waveform "${waveform}"`);
  }
}

/** Canonical 16-bit little-endian RIFF/WAVE bytes for an interleaved signal. */
function encodeWav({ sampleRate, channels, samples, frequency, waveform, amplitude }) {
  const dataBytes = samples * channels * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);

  let offset = 44;
  for (let frame = 0; frame < samples; frame++) {
    const phase = (frequency * frame) / sampleRate;
    // Match the TS helper's Float32 path exactly: store the generated value as
    // float32, then round. amplitude is validated to [0, 1], so the product is
    // representable and is never clamped.
    const value = Math.fround(sampleAt(waveform, phase) * amplitude);
    const pcm = Math.round(value * 32767);
    for (let channel = 0; channel < channels; channel++) {
      buffer.writeInt16LE(pcm, offset);
      offset += 2;
    }
  }
  return new Uint8Array(buffer);
}

/**
 * Build one audio Asset draft plus the exact bytes it describes.
 *
 * `samples` is the number of sample frames (per channel) to encode; a clip that
 * uses the asset with `inSample: 0` and the same `durationSamples` consumes the
 * whole signal.
 */
export function makeSignalAsset({
  id,
  path,
  sampleRate,
  channels,
  samples,
  frequency = 440,
  waveform = 'sine',
  amplitude = 1,
}) {
  if (typeof id !== 'string' || id.length === 0) throw new Error('makeSignalAsset: id must be a non-empty string');
  if (typeof path !== 'string' || path.length === 0) throw new Error('makeSignalAsset: path must be a non-empty string');
  if (path.startsWith('/') || path.includes('\\') || path.split('/').some(part => part === '' || part === '.' || part === '..'))
    throw new Error(`makeSignalAsset: ${JSON.stringify(path)} is not a safe project-relative path`);
  if (!Number.isInteger(sampleRate) || (sampleRate !== 44100 && sampleRate !== 48000))
    throw new Error(`makeSignalAsset: sampleRate is required and must be the real output rate (44100 or 48000), got ${sampleRate}`);
  if (!Number.isInteger(channels) || (channels !== 1 && channels !== 2))
    throw new Error(`makeSignalAsset: channels is required and must be the real output count (1 or 2), got ${channels}`);
  if (!Number.isSafeInteger(samples) || samples <= 0)
    throw new Error(`makeSignalAsset: samples must be a positive safe integer, got ${samples}`);
  if (!Number.isFinite(frequency) || frequency <= 0)
    throw new Error(`makeSignalAsset: frequency must be finite and positive, got ${frequency}`);
  if (!WAVEFORMS.has(waveform)) throw new Error(`makeSignalAsset: waveform must be "sine" or "triangle", got ${String(waveform)}`);
  if (!Number.isFinite(amplitude) || amplitude < 0 || amplitude > 1)
    throw new Error(`makeSignalAsset: amplitude must be finite in [0, 1], got ${amplitude}`);

  const bytes = encodeWav({ sampleRate, channels, samples, frequency, waveform, amplitude });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    asset: { id, revision: 1, path, type: 'audio', simulated: false, sha256, rights: { ...SIGNAL_RIGHTS } },
    bytes,
  };
}
