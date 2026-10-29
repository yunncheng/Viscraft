import { type Project, requireComposition } from './schema.js';

export function compositionFrames(project: Project): number {
  const composition = requireComposition(project);
  const ends = composition.placements.map(p => p.startFrame + (p.durationFrames ?? p.outFrame - p.inFrame));
  if (ends.some(n => !Number.isSafeInteger(n))) throw new Error('Timeline exceeds safe integer range');
  // An unedited draft legitimately carries zero placements. Its picture content
  // is a finite 0 — never `Math.max()` over an empty list (`-Infinity`), which
  // would leak a non-finite duration into Inspect/Save/Review. A declared
  // `outputFrames` is still the explicit programme length (a padded black/silent
  // programme is legal); Build separately refuses a draft with no picture.
  const contentFrames = ends.length > 0 ? Math.max(...ends) : 0;
  const outputFrames = composition.outputFrames;
  if (outputFrames === undefined) return contentFrames;
  // An explicit programme length pads a black/silent tail; it must never be
  // shorter than the content, and a shorter value is a loud authoring error
  // rather than a silent truncation.
  if (!Number.isSafeInteger(outputFrames) || outputFrames <= 0)
    throw new Error('composition.outputFrames must be a positive safe integer');
  if (outputFrames < contentFrames)
    throw new Error(
      `composition.outputFrames (${outputFrames}) is shorter than the content end (${contentFrames}); shorten placements instead of truncating content`,
    );
  return outputFrames;
}
