import { runCommand } from '../../shared/process.js';

// ---------------------------------------------------------------------------
// FFmpeg / ffprobe invocation
// ---------------------------------------------------------------------------

// The host has many CPUs, but media work should stay polite and reproducible.
// Limit encoder threads and filter-graph threads on every invocation.
export const FFMPEG_GLOBAL_ARGS = [
  '-hide_banner',
  '-nostdin',
  '-y',
  '-filter_threads',
  '1',
  '-filter_complex_threads',
  '1',
];

export const FFMPEG_OUTPUT_THREADS = ['-threads', '2'];

export async function ffmpeg(args: string[]): Promise<string> {
  try {
    return await runCommand('ffmpeg', [...FFMPEG_GLOBAL_ARGS, ...args]);
  } catch (err) {
    throw new Error(`ffmpeg failed: ${messageOf(err)}`);
  }
}

export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
