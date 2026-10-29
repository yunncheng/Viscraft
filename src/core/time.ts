import { type Fps } from './schema.js';

export function framesToSamples(
  frames: number,
  fps: Fps,
  sampleRate: number,
  rounding: 'nearest' | 'floor' | 'ceil' = 'nearest',
): number {
  for (const value of [frames, fps.numerator, fps.denominator, sampleRate])
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Clock values must be nonnegative safe integers');
  if (!fps.numerator || !fps.denominator || !sampleRate) throw new Error('Clock rates must be positive');
  const numerator = BigInt(frames) * BigInt(fps.denominator) * BigInt(sampleRate),
    denominator = BigInt(fps.numerator);
  const quotient = numerator / denominator,
    remainder = numerator % denominator;
  const result =
    quotient +
    (rounding === 'ceil'
      ? remainder > 0n
        ? 1n
        : 0n
      : rounding === 'nearest'
        ? 2n * remainder >= denominator
          ? 1n
          : 0n
        : 0n);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Sample position exceeds safe integer range');
  return Number(result);
}

export function ptsToFrames(pts: string, originPts: string, timeBase: Fps, fps: Fps): number {
  if (!/^-?\d{1,24}$/.test(pts) || !/^-?\d{1,24}$/.test(originPts))
    throw new Error('Source PTS must be signed decimal integer ticks');
  for (const value of [timeBase.numerator, timeBase.denominator, fps.numerator, fps.denominator]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Clock rates must be positive safe integers');
  }
  const ticks = BigInt(pts) - BigInt(originPts);
  if (ticks < 0n) throw new Error('Source PTS precedes the chosen origin');
  const numerator = ticks * BigInt(timeBase.numerator) * BigInt(fps.numerator);
  const denominator = BigInt(timeBase.denominator) * BigInt(fps.denominator);
  const result = numerator / denominator + (2n * (numerator % denominator) >= denominator ? 1n : 0n);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Mapped frame index exceeds safe integer range');
  return Number(result);
}

export function frameSeconds(frames: number, fps: Fps): string {
  return ((frames * fps.denominator) / fps.numerator).toFixed(12);
}
