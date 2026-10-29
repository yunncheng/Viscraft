import { loadRecording } from '../backends/playable/recording.js';
import { type Source } from '../core/schema.js';

/** The statically declared authored paths of a Source (its entry + resources). */
export function staticSourceFiles(source: Source): string[] {
  if (source.kind === 'browser' || source.kind === 'blender') return [source.entry, ...source.resources];
  return [];
}

/** Complete read-only authored closure for one Source. */
export async function sourceFilePaths(source: Source, root: string): Promise<string[]> {
  const files = staticSourceFiles(source);
  if (source.kind !== 'browser' || source.output !== 'picture' || !source.recording) return files;
  const recording = await loadRecording(root, source.recording);
  return [...files, source.recording, recording.media.path, ...recording.source.files.map(file => file.path)];
}
