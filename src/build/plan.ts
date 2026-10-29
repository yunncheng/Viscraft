/**
 * Production feasibility preflight (dry-run).
 *
 * A Build spends money and time (provider submissions, browser captures, Blender
 * renders, encodes). This module answers, WITHOUT producing anything, what a
 * Build of the current Project would do and what is already knowably wrong:
 *
 *  - the exact edit-timeline arithmetic (placement ends, overlaps, transition
 *    adjacency/range, final frame count) that `composeVideo` would enforce — so a
 *    gap, an unauthorized overlap, a transition that covers no overlap or an
 *    out-of-range interval is reported BEFORE any Take is produced;
 *  - placement source intervals checked against the frames a Source is expected to
 *    yield — deterministically for code/sound/blender/image/playable/world/media
 *    (media is probed locally, read-only), and marked `pending` for real
 *    generation whose returned frame count the runtime cannot pre-guarantee;
 *  - `audio: "keep"` placements whose deterministic Source cannot carry audio;
 *  - each generation Source classified as reusable / would-run / blocked /
 *    requires_approval / unsupported / pending, from the caller-supplied provider
 *    configuration and credential references (never by contacting a service).
 *
 * HARD INVARIANTS: this is a pure read. It performs NO provider submission, NO
 * asset upload, NO media write, and acquires no lock. A local `ffprobe` read of
 * an existing media Asset is permitted; everything else is arithmetic and
 * schema-validated project state. It is NOT a second Build graph: the structural
 * timeline checks mirror the exact rules `composeVideo` enforces, and the real
 * Build remains the authority that re-verifies every fact it acts on.
 */
import { proxyOutput, rendersAtProxy, resolvePreview, type PreviewRequest, type ResolvedPreview } from './preview.js';
import { CandidatePlanSchema } from '../core/schema.js';
import {
  type BuildRecord,
  type FilmProject,
  type Fps,
  type Placement,
  type Project,
  type SoundTarget,
  type Source,
  type Take,
  type Transition,
} from '../core/schema.js';
import { compositionFrames } from '../core/composition.js';
import { framesToSamples } from '../core/time.js';
import { readFile } from 'node:fs/promises';
import { resolveProjectPath } from '../shared/fs.js';
import { hashFile, stableHash } from '../shared/hash.js';
import { contentPath } from '../project/content-store.js';
import { loadProject } from '../project/project.js';
import { readBuilds } from '../project/build-records.js';
import { compareAuthoring } from '../project/state.js';
import { diffProjects, identityHints, type ProjectDiff } from '../project/diff.js';
import { probeAudio, probeMedia, type AudioMediaInfo } from '../backends/media/probe.js';
import { findSubtitleFont, type SubtitleFont } from '../backends/media/subtitles.js';
import { authoredFileFacts } from '../project/author-inputs.js';
import {
  backendEntries,
  operationEnvironmentProbe,
  operationImplementation,
  occluderInputAssets,
  runtimeRoot,
  sourceOperationIdentity,
  soundContextForSource,
  type KeyTools,
  type OperationEnvironmentProbe,
  type VideoOperationScope,
} from './identity.js';
import { sourceExecutor, type SourceContext } from './executors/index.js';
import { SourceInputError } from './executors/shared.js';
import type { VideoApiOptions } from '../backends/providers/services/video-tasks.js';
import type { ImageApiOptions } from '../backends/providers/services/vllm-omni/image-api.js';
import type { BlenderOptions } from '../backends/blender/render.js';
import { withUserEndpoints } from '../config/endpoints.js';

export type PlanLevel = 'blocked' | 'needs_configuration' | 'requires_approval' | 'unsupported' | 'pending';

export interface PlanIssue {
  level: PlanLevel;
  /** A stable, machine-readable reason code (never localized text). */
  code: string;
  message: string;
  /** The Placement / Source / Take / Shot id this issue concerns, when any. */
  subject?: string;
}

export interface PlanSource {
  id: string;
  kind: Source['kind'];
  simulated: boolean;
  /** True when the Build would talk to a real external service (not a loopback fixture). */
  external: boolean;
  /** Picture Take frames, or 'unknown' when only known after the run; absent for sound. */
  expectedFrames?: number | 'unknown';
  /** Samples a SOUND Take is expected to contain (native rate), or 'unknown'. */
  expectedSamples?: number | 'unknown';
  /** The native sample rate of a sound Take. */
  sampleRate?: number;
  /** Whether the Take is known to carry an audio stream; 'unknown' for real generation. */
  carriesAudio: boolean | 'unknown';
}

export interface PlanWork {
  subject: string;
  kind: Source['kind'];
  simulated: boolean;
  external: boolean;
  reason: string;
}

export interface PlanReuse {
  subject: string;
  take: string;
  artifact: string;
  note: string;
}

export interface PlanOverlap {
  from: string;
  to: string;
  startFrame: number;
  endFrame: number;
  overlap: number;
  transition?: string;
}

export interface BuildPlan {
  schemaVersion: 1;
  kind: 'build-plan';
  goal: string;
  project: { id: string; revision: number; title: string };
  buildable: boolean;
  simulatedOnly: boolean;
  /** What this plan produces; `target` names the sound/image target, when any. */
  medium?: 'picture' | 'sound';
  target?: string;
  /** The exact delivered sample span of a sound target plan. */
  outputSamples?: number;
  sampleRate?: number;
  channels?: number;
  timeline: {
    contentFrames: number;
    totalFrames: number;
    outputFrames?: number;
    placements: number;
    overlaps: PlanOverlap[];
  };
  sources: PlanSource[];
  reuse: PlanReuse[];
  work: PlanWork[];
  /** Structural/file diff against the ACTIVE result Build; null when there is no active result. */
  changes: ProjectDiff | null;
  /** Non-blocking hints that a stable identity was replaced (Takes will not be reused). */
  identity: string[];
  blockers: PlanIssue[];
  /** Missing Endpoint or credential setup the user must provide (not consent). */
  needsConfiguration: PlanIssue[];
  requiresApproval: PlanIssue[];
  unsupported: PlanIssue[];
  pending: PlanIssue[];
  notes: string[];
  /** Present for a preview plan: the range, scale and substituted Placements. */
  preview?: { frames: [number, number]; scale: number; substituted: string[] };
}

export interface PlanOptions {
  goal?: string;
  providers?: { videoApi?: Record<string, VideoApiOptions>; imageApi?: Record<string, ImageApiOptions> };
  /** Explicit Blender configuration for `blender` Sources (executable, timeout). */
  blender?: BlenderOptions;
  /** Candidate plan (shot -> sources) that a Build would render without placing. */
  candidates?: Array<{ shot: string; sources: string[] }>;
  /** Plan a preview Build instead of a full Build. */
  preview?: PreviewRequest;
  /** An `imageTargets`/`soundTargets` id; absent means the timeline composition. */
  target?: string;
}

const endOf = (placement: Placement): number =>
  placement.startFrame + (placement.durationFrames ?? placement.outFrame - placement.inFrame);

/**
 * The exact structural timeline rules `composeVideo` enforces, evaluated without
 * producing any media: the first placement must start at 0, placements must not
 * leave gaps, a positive overlap must be authorized by exactly one transition
 * whose declared range is that overlap and is shorter than both placements, and
 * every declared transition must be consumed. Returns the facts and any
 * structural blockers (with the same intent as the render-time errors).
 */
export function analyzeTimeline(
  placements: readonly Placement[],
  transitions: readonly Transition[],
): { overlaps: PlanOverlap[]; blockers: PlanIssue[]; contentFrames: number } {
  const blockers: PlanIssue[] = [];
  const overlaps: PlanOverlap[] = [];
  if (placements.length === 0) return { overlaps, blockers, contentFrames: 0 };
  const ordered = [...placements].sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id));
  if (ordered[0].startFrame !== 0)
    blockers.push({
      level: 'blocked',
      code: 'timeline-does-not-start-at-zero',
      subject: ordered[0].id,
      message: `The first placement starts at frame ${ordered[0].startFrame}; the timeline must start at 0.`,
    });
  const byPair = new Map<string, Transition>();
  for (const transition of transitions) {
    const pair = `${transition.from}\u0000${transition.to}`;
    if (byPair.has(pair))
      blockers.push({
        level: 'blocked',
        code: 'duplicate-transition',
        subject: `${transition.from}->${transition.to}`,
        message: `Duplicate transition declarations for ${transition.from}->${transition.to}.`,
      });
    byPair.set(pair, transition);
  }
  const consumed = new Set<string>();
  let currentEnd = endOf(ordered[0]);
  for (let index = 1; index < ordered.length; index++) {
    const prev = ordered[index - 1],
      cur = ordered[index];
    const start = cur.startFrame;
    const overlap = currentEnd - start;
    const pair = `${prev.id}\u0000${cur.id}`;
    if (overlap < 0)
      blockers.push({
        level: 'blocked',
        code: 'timeline-gap',
        subject: cur.id,
        message: `A gap of ${-overlap} frames precedes placement ${cur.id} (expected start ${currentEnd}, got ${start}).`,
      });
    else if (overlap === 0)
      overlaps.push({ from: prev.id, to: cur.id, startFrame: start, endFrame: start, overlap: 0 });
    else {
      const transition = byPair.get(pair);
      // The overlap is an OUTPUT-timeline fact: it is judged against each
      // placement's EFFECTIVE (post-retime) duration — `durationFrames ?? out -
      // in` — exactly as `composeVideo` does with its materialized clips. Using
      // the raw source length would reject a legal slow-motion transition whose
      // materialized duration is longer. The source interval itself
      // (`[inFrame, outFrame)`) is still validated on the source clock against
      // the Take's frames.
      const durPrev = prev.durationFrames ?? prev.outFrame - prev.inFrame,
        durCur = cur.durationFrames ?? cur.outFrame - cur.inFrame;
      // The overlap is a real edit fact whether or not it is authorized, so it is
      // always recorded; the blockers below state what is wrong with it.
      overlaps.push({
        from: prev.id,
        to: cur.id,
        startFrame: start,
        endFrame: currentEnd,
        overlap,
        ...(transition ? { transition: transition.kind } : {}),
      });
      if (!transition)
        blockers.push({
          level: 'blocked',
          code: 'unauthorized-overlap',
          subject: `${prev.id}->${cur.id}`,
          message: `Placements ${prev.id} and ${cur.id} overlap by ${overlap} frames with no declared transition; add a transition or move the cut.`,
        });
      else {
        if (transition.startFrame !== start || transition.endFrame !== currentEnd)
          blockers.push({
            level: 'blocked',
            code: 'transition-range-mismatch',
            subject: `${transition.from}->${transition.to}`,
            message: `Transition ${transition.from}->${transition.to} range [${transition.startFrame}, ${transition.endFrame}) does not match the real overlap [${start}, ${currentEnd}).`,
          });
        if (overlap >= durPrev || overlap >= durCur)
          blockers.push({
            level: 'blocked',
            code: 'transition-overlap-too-long',
            subject: `${transition.from}->${transition.to}`,
            message: `Transition ${transition.from}->${transition.to} overlap ${overlap} must be shorter than both placements (${durPrev} and ${durCur}).`,
          });
        if (transition.kind === 'occlude' && overlap < 3)
          blockers.push({
            level: 'blocked',
            code: 'occlude-overlap-too-short',
            subject: `${transition.from}->${transition.to}`,
            message: `Occlusion transition ${transition.from}->${transition.to} needs an overlap of at least 3 frames so the occluder can sweep in and out around the cut (got ${overlap}).`,
          });
        consumed.add(pair);
      }
    }
    // Match `composeVideo` exactly: the running end is the current placement's own
    // end (`start + effective duration`), not a running maximum.
    currentEnd = endOf(cur);
  }
  for (const transition of transitions) {
    if (!consumed.has(`${transition.from}\u0000${transition.to}`))
      blockers.push({
        level: 'blocked',
        code: 'transition-not-consumed',
        subject: `${transition.from}->${transition.to}`,
        message: `Transition ${transition.from}->${transition.to} is not consumed by any overlap; the two placements do not overlap and a transition cannot apply to a hard cut.`,
      });
  }
  return { overlaps, blockers, contentFrames: currentEnd };
}

/**
 * Why a Project is not yet buildable. `placements` is the only structural
 * requirement the schema cannot express for a legal unedited draft: a Build must
 * produce a target picture, so a composition with zero placements is refused
 * loudly (never silently padded into a placeholder video).
 */
export function buildabilityGaps(project: FilmProject): string[] {
  const gaps: string[] = [];
  if (project.composition.placements.length === 0)
    gaps.push('the composition has no placements; add at least one placement (with a Shot) before building');
  return gaps;
}

/**
 * The historical Build records that may contribute REUSABLE work: their
 * completed operations (reused only when the operation key matches AND the
 * artifact hash verifies) and their Takes. A `succeeded` build qualifies, and
 * so does a `failed` one — a failure after some operations completed still
 * leaves those completed, hash-verified artifacts reusable, so a retry must not
 * re-submit/re-encode them. Only an in-flight `running` record is excluded (it
 * may be live or incomplete). The preflight and the Build both use this one
 * predicate so they never disagree about what counts as valid history.
 */
export function reusableHistory(history: readonly BuildRecord[]): BuildRecord[] {
  return history.filter(build => build.status !== 'running');
}

/**
 * Frames a Source yields when that is knowable WITHOUT reading any media, else
 * `undefined`. Delegates to the Source's registered executor, so the knowledge
 * lives with the executor rather than as a kind switch in the preflight.
 */
export function staticSourceFrames(project: Project, source: Source): number | undefined {
  return sourceExecutor(source).staticFrames(project, source);
}

/**
 * Whether a Source's Take is known to carry an audio stream, without reading
 * media. Delegates to the Source's registered executor.
 */
export function staticSourceAudio(source: Source): boolean | undefined {
  return sourceExecutor(source).staticAudio(source);
}

/**
 * Placement errors that are knowable BEFORE any capture/generation work: a
 * `source` placement whose interval exceeds the frames the Source will yield,
 * and a `keep`-audio placement over a Source that cannot carry audio. Both
 * categories are deterministic for the Source kinds listed in
 * `staticSourceFrames`/`staticSourceAudio`; media and real generation stay
 * `undefined` here and are verified later in the normal Build path.
 */
export function earlyPlacementIssues(project: FilmProject, substituted?: ReadonlySet<string>): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (const placement of project.composition.placements) {
    // A preview replaces placements wholly outside its range with a silent gap
    // and does NOT produce their Source, so a bad interval/audio declaration on
    // such a placement must not block the preview.
    if (substituted?.has(placement.id)) continue;
    if (!placement.source) continue;
    const source = project.sources.find(candidate => candidate.id === placement.source);
    if (!source) continue;
    const frames = staticSourceFrames(project, source);
    if (frames !== undefined && placement.outFrame > frames)
      issues.push({
        level: 'blocked',
        code: 'placement-reads-beyond-source',
        subject: placement.id,
        message: `Placement ${placement.id} reads frames [${placement.inFrame}, ${placement.outFrame}) beyond Source ${source.id} (${frames} frames); handles unavailable.`,
      });
    if (placement.audio === 'keep' && staticSourceAudio(source) === false)
      issues.push({
        level: 'blocked',
        code: 'keep-audio-on-silent-source',
        subject: placement.id,
        message: `Placement ${placement.id} has audio "keep" but Source ${source.id} (${source.kind}) produces no audio stream; use audio "mute" or a Take that carries audio.`,
      });
  }
  return issues;
}

/**
 * A read-only metadata probe of a video Asset file (ffprobe, never a decode).
 * `missing` marks an UNKNOWN length — the file is absent or undecodable — so it
 * is NEVER treated as a known error; a failed probe is a non-blocking `pending`
 * fact (see `pictureLayerIssues`/`placementAssetIssues`). A successful probe
 * always yields the real frames/duration (and whether it carries audio).
 */
interface VideoAssetProbe {
  frames?: number;
  duration?: number;
  audio?: boolean;
  missing: boolean;
}

/**
 * The ONE metadata-probe cache for video Asset files, memoized per asset path.
 * Both the layer and the placement checks build one of these over the same root,
 * so a shared Asset is probed once within a preflight. `root === undefined`
 * yields `missing` (the caller skips the interval check entirely instead).
 */
function videoAssetProber(root: string | undefined): (assetPath: string) => Promise<VideoAssetProbe> {
  const probes = new Map<string, Promise<VideoAssetProbe>>();
  return (assetPath: string): Promise<VideoAssetProbe> => {
    const cached = probes.get(assetPath);
    if (cached) return cached;
    const task = (async (): Promise<VideoAssetProbe> => {
      if (root === undefined) return { missing: true };
      try {
        const info = await probeMedia(await resolveProjectPath(root, assetPath));
        return { frames: info.frames, duration: info.duration, audio: Boolean(info.audio), missing: false };
      } catch {
        return { missing: true };
      }
    })();
    probes.set(assetPath, task);
    return task;
  };
}

/**
 * The NORMALIZED output-grid frame count of a probed video Asset: `normalizeMedia`
 * resamples to the output fps preserving duration, so the bound is derived from
 * the probed duration at the output fps (falling back to the probed frame count
 * when no duration was reported). `undefined` means the length is unknown.
 */
function normalizedAssetFrames(probed: VideoAssetProbe, fps: Fps): number | undefined {
  return probed.duration !== undefined
    ? Math.max(1, Math.round((probed.duration * fps.numerator) / fps.denominator))
    : probed.frames;
}

/**
 * The recorded Artifact facts a `take` reference resolves against: its path, the
 * hash the bytes must still match, its medium, and — when the media was released
 * — the archive it went to. Structurally the subset of `Artifact` both callers
 * carry; the medium lets a picture reference refuse an AUDIO Take before it
 * reaches the compositor.
 */
export interface TakeArtifactRecord {
  path: string;
  sha256: string;
  kind: 'video' | 'audio' | 'image';
  archived?: { archive: string };
}

/** Whether the artifact record's bytes are still present and hash to its record. */
async function verifyTakeArtifact(artifact: TakeArtifactRecord | undefined, root: string): Promise<boolean> {
  if (!artifact) return false;
  try {
    return (await hashFile(await resolveProjectPath(root, artifact.path))) === artifact.sha256;
  } catch {
    return false;
  }
}

/**
 * The ONE usability check for a Take selected by a placement OR a picture layer:
 * its recorded Artifact must exist, its bytes must still hash to the recorded
 * `sha256`, and a released (archived) Artifact must have been restored. Shared so
 * a layer cannot reach execution with a Take the placement path would already
 * refuse, and so both report the same fact with the same message. Returns the
 * `PlanIssue` to raise, or `undefined` when the Artifact is verifiably present.
 * A missing/absent record is a known error (the Build's own `selectedTake` would
 * reject it), never an UNKNOWN length.
 */
async function takeArtifactIssue(
  subjectKind: 'Placement' | 'Picture layer',
  subject: string,
  take: Take,
  artifact: TakeArtifactRecord | undefined,
  root: string,
): Promise<PlanIssue | undefined> {
  if (await verifyTakeArtifact(artifact, root)) return undefined;
  if (artifact?.archived)
    return {
      level: 'blocked',
      code: 'archived-media',
      subject,
      message: `${subjectKind} ${subject} selects Take ${take.id}, whose media was released to archive ${artifact.archived.archive}; run \`viscraft restore-media <project> <archive>\` first (nothing is re-downloaded or re-submitted).`,
    };
  return {
    level: 'blocked',
    code: 'selected-take-missing',
    subject,
    message: `${subjectKind} ${subject} selects Take ${take.id}, but its artifact ${take.artifact} is missing or its hash no longer matches.`,
  };
}

/**
 * A picture reference (a placement or a picture layer) may only select a PICTURE
 * Take. A sound Source records an `audio` Artifact, so selecting it as picture
 * would reach the compositor with no `media.frames`; this is knowable from the
 * Take's recorded Artifact medium, so it is refused before any work.
 */
function takeMediumIssue(
  subjectKind: 'Placement' | 'Picture layer',
  subject: string,
  take: Take,
  artifact: TakeArtifactRecord | undefined,
): PlanIssue | undefined {
  if (!artifact || artifact.kind === 'video') return undefined;
  return {
    level: 'blocked',
    code: 'take-not-picture',
    subject,
    message: `${subjectKind} ${subject} selects Take ${take.id}, whose medium is ${artifact.kind}, not picture; a picture reference needs a video Take.`,
  };
}

/** Frame-rate equality by cross-multiplication, so `24/1` equals `48/2`. */
function sameFps(a: Fps, b: Fps): boolean {
  return a.numerator * b.denominator === b.numerator * a.denominator;
}

/**
 * A placement retimes explicitly when it declares a `durationFrames` different
 * from its natural `outFrame - inFrame`. The Build then materializes a NORMALIZED
 * clip at the output fps (see `retimeClip`), so a reused Take's own frame rate no
 * longer has to match; the exact predicate mirrors `composeVideo`'s
 * "retime must be materialized" check.
 */
function placementRetimes(placement: Pick<Placement, 'durationFrames' | 'inFrame' | 'outFrame'>): boolean {
  return placement.durationFrames !== undefined && placement.durationFrames !== placement.outFrame - placement.inFrame;
}

/**
 * A reused `take:` is composited AS-IS — the runtime never silently normalizes
 * or re-speeds it — so its recorded frame rate must equal the composition output
 * unless the placement retimes it explicitly. This is the SAME fact
 * `composeVideo`/`overlayPictureLayers` reject LATE ("source fps … is not
 * normalized to composition fps …"), raised here so an EARLIER placement's
 * Provider Source is not submitted first. The fix is the author's: produce the
 * Take at the output frame rate, or (a placement only) declare an explicit retime.
 */
function takeFpsIssue(
  subjectKind: 'Placement' | 'Picture layer',
  subject: string,
  take: Take,
  outputFps: Fps,
  retimed: boolean,
): PlanIssue | undefined {
  if (take.medium !== 'picture') return undefined;
  if (retimed || sameFps(take.fps, outputFps)) return undefined;
  const recording = `Take ${take.id} recorded at ${take.fps.numerator}/${take.fps.denominator} fps`;
  const output = `the composition output is ${outputFps.numerator}/${outputFps.denominator} fps`;
  const guidance =
    subjectKind === 'Placement'
      ? 'a reused Take is composited as-is, so produce the Take at the output frame rate or give this placement an explicit `durationFrames` retime (its output length then changes).'
      : 'a layer is composited as-is, so produce the Take at the output frame rate.';
  return {
    level: 'blocked',
    code: subjectKind === 'Placement' ? 'take-fps-mismatch' : 'layer-fps-mismatch',
    subject,
    message: `${subjectKind} ${subject} selects ${recording}, but ${output}; ${guidance}`,
  };
}

/**
 * Placement-level `take:` dependency errors knowable BEFORE any capture or
 * provider submission: the referenced Take must exist in a reusable Build
 * history, its requested `[inFrame, outFrame)` must fit the Take's recorded
 * `frames`, its Artifact must still be usable (bytes/hash/archive), it must be a
 * PICTURE Take, and — for `audio: "keep"` — the Take's FILE must actually carry
 * an audio stream. This is the ONE shared check both the production preflight and
 * the Build call, so an ordinary timeline placement cannot pass the Plan and then
 * spend a Provider POST on an EARLIER placement before failing on the later Take.
 * `substituted` excludes a preview's replaced placements.
 *
 * A silent Take whose `keep` is requested is refused with the SAME actionable
 * message the Build's own late guard gives (`its source Take … declares no audio
 * stream, so nothing was kept`), so the fact is raised earlier without changing
 * its meaning. Facts that are only knowable AFTER a run keep their final guard in
 * the Build; an unreadable Take file is an UNKNOWN fact (non-blocking `pending`),
 * never a fabricated "silent" claim, and the late guard still decides.
 */
export interface PlacementTakeIssueOptions {
  takes?: ReadonlyMap<string, Take>;
  artifacts?: ReadonlyMap<string, TakeArtifactRecord>;
  /** Placements a preview replaces with a silent gap; their Take is not consumed. */
  substituted?: ReadonlySet<string>;
  /** The project root, so a Take's FILE can be probed and its bytes verified. */
  root?: string;
}

export async function placementTakeIssues(
  project: FilmProject,
  options: PlacementTakeIssueOptions = {},
): Promise<PlanIssue[]> {
  const issues: PlanIssue[] = [];
  const root = options.root;
  // One metadata probe per Take artifact path, memoized across placements.
  const audioProbes = new Map<string, Promise<boolean | undefined>>();
  const takeHasAudio = (artifact: TakeArtifactRecord): Promise<boolean | undefined> => {
    if (root === undefined) return Promise.resolve(undefined);
    const cached = audioProbes.get(artifact.path);
    if (cached) return cached;
    const task = (async () => {
      try {
        return Boolean((await probeMedia(await resolveProjectPath(root, artifact.path))).audio);
      } catch {
        return undefined;
      }
    })();
    audioProbes.set(artifact.path, task);
    return task;
  };
  for (const placement of project.composition.placements) {
    if (!placement.take || options.substituted?.has(placement.id)) continue;
    const take = options.takes?.get(placement.take);
    if (!take) {
      issues.push({
        level: 'blocked',
        code: 'unknown-selected-take',
        subject: placement.id,
        message: `Placement ${placement.id} selects Take ${placement.take}, which no completed Build records.`,
      });
      continue;
    }
    if (take.medium === 'picture' && placement.outFrame > take.frames)
      issues.push({
        level: 'blocked',
        code: 'placement-reads-beyond-take',
        subject: placement.id,
        message: `Placement ${placement.id} reads frames [${placement.inFrame}, ${placement.outFrame}) beyond Take ${take.id} (${take.frames} frames); handles unavailable.`,
      });
    if (root === undefined) continue;
    const artifact = options.artifacts?.get(take.artifact);
    const artifactIssue = await takeArtifactIssue('Placement', placement.id, take, artifact, root);
    if (artifactIssue) {
      issues.push(artifactIssue);
      continue;
    }
    const mediumIssue = takeMediumIssue('Placement', placement.id, take, artifact);
    if (mediumIssue) {
      issues.push(mediumIssue);
      continue;
    }
    const fpsIssue = takeFpsIssue(
      'Placement',
      placement.id,
      take,
      project.composition.output.fps,
      placementRetimes(placement),
    );
    if (fpsIssue) {
      issues.push(fpsIssue);
      continue;
    }
    if (placement.audio !== 'keep' || !artifact) continue;
    const carries = await takeHasAudio(artifact);
    if (carries === undefined)
      issues.push({
        level: 'pending',
        code: 'take-audio-unknown',
        subject: placement.id,
        message: `Placement ${placement.id} keeps audio from Take ${take.id}, whose file could not be read; whether it carries audio is only verified at the build.`,
      });
    else if (!carries)
      issues.push({
        level: 'blocked',
        code: 'keep-audio-on-silent-take',
        subject: placement.id,
        message: `Placement ${placement.id} has audio "keep" but its source Take ${take.id}${take.source ? ` (Source ${take.source})` : take.asset ? ` (Asset ${take.asset})` : ''} declares no audio stream, so nothing was kept; use audio "mute" if the silence is intended, or select or produce a Take that carries audio`,
      });
  }
  return issues;
}

/**
 * The Takes a layer's `take` reference may select, by id — the reusable Build
 * history (`reusableHistory`). Absent means no completed history is known, so a
 * `take` reference resolves to nothing. `artifacts` is the matching Artifact
 * record, so the layer check verifies the selected Take's real bytes/archive
 * state (the SAME shared check the placement path uses), and `root` is the
 * project root the bytes are read from.
 */
export interface PictureLayerIssueOptions {
  takes?: ReadonlyMap<string, Take>;
  /** The Artifact records a `take` reference resolves against (reusable history). */
  artifacts?: ReadonlyMap<string, TakeArtifactRecord>;
  /** Layers a preview drops wholly outside its range; their dependency is not consumed. */
  droppedLayers?: ReadonlySet<string>;
  /**
   * The project root, so a VIDEO Asset layer's real normalized length can be
   * probed (metadata only, never a decode) and a selected Take's bytes can be
   * verified. Both the Plan and the Build pass it; omitting it skips only the
   * media-dependent checks.
   */
  root?: string;
}

/**
 * Picture-layer dependency errors that are knowable BEFORE any capture or
 * provider submission: a layer's `source` / `take` / `asset` origin and the
 * layer's requested `[inFrame, outFrame)` are checked against the frames that
 * origin is KNOWN to yield — a Source's static frame count
 * (`staticSourceFrames`), an existing Take's recorded `frames` AND its Artifact
 * bytes/archive state (the SAME shared `takeArtifactIssue` the placement path
 * uses), and a VIDEO Asset's real normalized length (a metadata probe of the
 * Asset file with `probeMedia` — never a decode; an Asset records no static
 * media length in the schema). This is the ONE shared check both the production
 * preflight and the Build call (so a layer the Build would reject cannot first
 * spend a browser capture or a provider POST), with `droppedLayers` excluding a
 * preview's dropped layers. The media probes run only when `root` is supplied
 * (both callers do) — only for a video Asset layer and a `take` layer; an image
 * Asset is held for exactly the layer's own interval (`normalize-still`), so any
 * stay fits.
 *
 * Facts only knowable AFTER a run keep their final guard in the Build: a real
 * generation's decoded length. A failed metadata probe is an UNKNOWN fact, not a
 * known error — the file may be absent while a hash-verified `normalize-media`
 * artifact remains reusable — so it is reported as a non-blocking `pending`
 * issue and the Build validates the interval against the actual resolved/reused
 * artifact. A probe that SUCCEEDS and shows the interval exceeds the real length
 * stays a `blocked` issue. The layer's OWN interval shape (`inFrame >= 0`,
 * `outFrame > inFrame`, and a stay that fits the programme) is already
 * guaranteed by `validateProject`, so it is not re-derived here. A missing
 * Source/Asset is likewise refused at load.
 */
export async function pictureLayerIssues(
  project: FilmProject,
  options: PictureLayerIssueOptions = {},
): Promise<PlanIssue[]> {
  const issues: PlanIssue[] = [];
  const root = options.root;
  const probeVideo = videoAssetProber(root);
  for (const layer of project.composition.layers ?? []) {
    if (options.droppedLayers?.has(layer.id)) continue;
    if (layer.source) {
      const source = project.sources.find(candidate => candidate.id === layer.source);
      if (!source) continue;
      const frames = staticSourceFrames(project, source);
      if (frames !== undefined && layer.outFrame > frames)
        issues.push({
          level: 'blocked',
          code: 'layer-reads-beyond-source',
          subject: layer.id,
          message: `Picture layer ${layer.id} reads frames [${layer.inFrame}, ${layer.outFrame}) beyond Source ${source.id} (${frames} frames); handles unavailable.`,
        });
    } else if (layer.take) {
      const take = options.takes?.get(layer.take);
      if (!take)
        issues.push({
          level: 'blocked',
          code: 'unknown-selected-take',
          subject: layer.id,
          message: `Picture layer ${layer.id} selects Take ${layer.take}, which no completed Build records.`,
        });
      else {
        if (take.medium === 'picture' && layer.outFrame > take.frames)
          issues.push({
            level: 'blocked',
            code: 'layer-reads-beyond-take',
            subject: layer.id,
            message: `Picture layer ${layer.id} reads frames [${layer.inFrame}, ${layer.outFrame}) beyond Take ${take.id} (${take.frames} frames); handles unavailable.`,
          });
        // The selected Take's Artifact bytes must still be usable, be a picture
        // Take, and be recorded at the composition frame rate — the SAME shared
        // checks the placement path uses, so a layer cannot pass the preflight
        // and then fail only after the picture has been produced. A layer has no
        // retime, so its reused Take must match the output fps outright.
        if (root !== undefined) {
          const artifact = options.artifacts?.get(take.artifact);
          const artifactIssue = await takeArtifactIssue('Picture layer', layer.id, take, artifact, root);
          if (artifactIssue) issues.push(artifactIssue);
          else {
            const mediumIssue = takeMediumIssue('Picture layer', layer.id, take, artifact);
            if (mediumIssue) issues.push(mediumIssue);
            else {
              const fpsIssue = takeFpsIssue('Picture layer', layer.id, take, project.composition.output.fps, false);
              if (fpsIssue) issues.push(fpsIssue);
            }
          }
        }
      }
    } else if (layer.asset) {
      const asset = project.assets.find(candidate => candidate.id === layer.asset);
      if (!asset)
        issues.push({
          level: 'blocked',
          code: 'missing-asset',
          subject: layer.id,
          message: `Picture layer ${layer.id} references Asset ${layer.asset}, which does not exist.`,
        });
      else if (asset.type !== 'video' && asset.type !== 'image')
        issues.push({
          level: 'blocked',
          code: 'layer-asset-not-picture',
          subject: layer.id,
          message: `Picture layer ${layer.id} references Asset ${asset.id}, which is not a video or image Asset.`,
        });
      else if (asset.type === 'video' && root !== undefined) {
        // An image Asset is held for exactly the layer's own interval
        // (`normalize-still`), so any stay fits; only a VIDEO Asset has a real
        // length that can be too short. Probe the file's metadata (ffprobe, never
        // a decode) and compare the requested interval against the NORMALIZED
        // frame count — the layer's `[inFrame, outFrame)` selects frames on the
        // normalized output grid (`normalizeMedia` resamples to the output fps,
        // preserving duration), the same bound the placement check uses.
        const probed = await probeVideo(asset.path);
        if (probed.missing)
          // UNKNOWN, not a known error: the file may be absent while a
          // hash-verified `normalize-media` artifact remains reusable (the
          // operation is keyed on the recorded `asset.sha256`), so the Build is
          // allowed to proceed and validate the interval against the actual
          // resolved/reused artifact. Blocking here would regress a legal reuse.
          issues.push({
            level: 'pending',
            code: 'layer-asset-media-unknown',
            subject: layer.id,
            message: `Picture layer ${layer.id} references video Asset ${asset.id}, whose media could not be read; its length and this interval are only verified against the reused or produced artifact.`,
          });
        else {
          const normalized = normalizedAssetFrames(probed, project.composition.output.fps);
          if (normalized !== undefined && layer.outFrame > normalized)
            issues.push({
              level: 'blocked',
              code: 'layer-reads-beyond-asset',
              subject: layer.id,
              message: `Picture layer ${layer.id} reads frames [${layer.inFrame}, ${layer.outFrame}) beyond the normalized video Asset ${asset.id} (~${normalized} frames on the output grid); handles unavailable.`,
            });
        }
      }
    }
  }
  return issues;
}

/**
 * Placement errors a video Asset can make KNOWABLE before any capture or
 * provider submission, through the SAME metadata probe the layer check uses: a
 * `source` placement is covered by `earlyPlacementIssues` (static frames) and a
 * `take` placement by the preflight's history check, but a placement that reads
 * a VIDEO Asset directly has a real length that only a probe reveals. This is
 * the ONE shared check both the production preflight and the Build call, so an
 * out-of-range video-Asset placement cannot first spend a provider POST and a
 * compose and only then fail at the placement guard.
 *
 * Semantics match the layer check exactly: a SUCCESSFUL probe with a real
 * overrun is `blocked`; a FAILED probe is an UNKNOWN length and therefore a
 * non-blocking `pending` issue — the Build validates the interval against the
 * actual resolved/reused artifact. An image Asset has no source clock
 * (`validateProject` fixes its whole stay and a muted audio), so only a video
 * Asset is probed. A missing Asset is refused at load. `substituted` excludes a
 * preview's replaced placements.
 *
 * `keep-audio-on-silent-asset` is NOT part of the shared (Build-fatal) check.
 * Raising it in the Build's early preflight would pre-empt the documented late
 * `keptAudioMessage` and memberless-bus diagnostics for the same authored
 * mistake (`tests/kept-audio-missing.test.ts`), i.e. change their meaning; that
 * guard therefore stays a late, defence-in-depth check in the Build. The
 * pre-existing PLAN-only diagnostic is preserved behind `keepAudioDiagnostic`,
 * which only the preflight requests — the Build leaves it to the late guard.
 */
export interface PlacementAssetIssueOptions {
  /** Placements a preview replaces with a silent gap; their Asset is not consumed. */
  substituted?: ReadonlySet<string>;
  /** The project root, so a video Asset's real normalized length can be probed. */
  root?: string;
  /**
   * Also emit the Plan-only `keep-audio-on-silent-asset` diagnostic (a `keep`
   * placement over a video Asset with no audio stream). The Build omits it so its
   * late guard keeps reporting the documented Take/stem message.
   */
  keepAudioDiagnostic?: boolean;
}

export async function placementAssetIssues(
  project: FilmProject,
  options: PlacementAssetIssueOptions = {},
): Promise<PlanIssue[]> {
  const issues: PlanIssue[] = [];
  const root = options.root;
  if (root === undefined) return issues;
  const probeVideo = videoAssetProber(root);
  for (const placement of project.composition.placements) {
    if (options.substituted?.has(placement.id)) continue;
    if (!placement.asset) continue;
    const asset = project.assets.find(candidate => candidate.id === placement.asset);
    if (!asset || asset.type !== 'video') continue;
    const probed = await probeVideo(asset.path);
    if (probed.missing) {
      // UNKNOWN, never a known error: a hash-verified normalized artifact may
      // still be reusable, so the Build proceeds and its placement guard
      // validates the interval against the real resolved/reused Take.
      issues.push({
        level: 'pending',
        code: 'placement-asset-media-unknown',
        subject: placement.id,
        message: `Placement ${placement.id} references video Asset ${asset.id}, whose media could not be read; its length and this interval are only verified against the reused or produced artifact.`,
      });
      continue;
    }
    const normalized = normalizedAssetFrames(probed, project.composition.output.fps);
    if (normalized !== undefined && placement.outFrame > normalized)
      issues.push({
        level: 'blocked',
        code: 'placement-reads-beyond-asset',
        subject: placement.id,
        message: `Placement ${placement.id} reads frames [${placement.inFrame}, ${placement.outFrame}) beyond the normalized video Asset ${asset.id} (~${normalized} frames on the output grid); handles unavailable.`,
      });
    if (placement.audio === 'keep' && options.keepAudioDiagnostic && probed.audio === false)
      issues.push({
        level: 'blocked',
        code: 'keep-audio-on-silent-asset',
        subject: placement.id,
        message: `Placement ${placement.id} has audio "keep" but its video Asset ${asset.id} has no audio stream; use audio "mute" or an Asset that carries audio.`,
      });
  }
  return issues;
}

/**
 * Interval errors for an `asset` audio clip, knowable BEFORE any
 * capture/compose: an `asset` clip reads `[inSample, inSample + durationSamples)`
 * of its audio Asset on the OUTPUT sample clock (that is the clock `mixAudio`
 * decodes it on — it resamples the Asset to the output rate/channels). The clip's
 * end must not exceed the Asset's real length. The length is read by METADATA
 * PROBE (`probeAudio` — never a full decode), converted to the output clock by
 * the Asset's real duration; the Asset's own sample rate is irrelevant because
 * resampling preserves duration.
 *
 * This is the ONE shared check both the production preflight and the Build call,
 * so a clip that reads past its Asset cannot first be produced into picture and
 * only then fail inside `mixAudio`. A `source` clip is the rendered sound Take's
 * own length, so it is not bounded by an Asset; `asset` clips are.
 *
 * HONESTY ABOUT THE ESTIMATE: a compressed stream's probed duration can be
 * bitrate-derived, so the derived sample count is not guaranteed exact. The check
 * therefore NEVER blocks a clip whose declared end is within the Asset
 * (`declaredEnd <= available`), and only blocks an overrun that is CLEARLY beyond
 * any plausible metadata error (at least half a second, or 5% of the length,
 * whichever is larger). A small overrun — which only the exact decoded length at
 * the mix can decide — and a probe that cannot read the length are both
 * non-blocking `pending` facts, with the real `mixAudio` guard kept as the final
 * authority. No full decode is performed here. A missing Asset is refused at load.
 */
export async function audioAssetClipIssues(
  project: FilmProject,
  options: { root?: string } = {},
): Promise<PlanIssue[]> {
  const issues: PlanIssue[] = [];
  const root = options.root;
  if (root === undefined) return issues;
  const output = project.composition.output;
  const probes = new Map<string, Promise<AudioMediaInfo | undefined>>();
  const probe = (assetPath: string): Promise<AudioMediaInfo | undefined> => {
    const cached = probes.get(assetPath);
    if (cached) return cached;
    const task = (async () => {
      try {
        return await probeAudio(await resolveProjectPath(root, assetPath));
      } catch {
        return undefined;
      }
    })();
    probes.set(assetPath, task);
    return task;
  };
  for (const clip of project.composition.audio) {
    if (clip.kind !== 'asset') continue;
    const asset = project.assets.find(candidate => candidate.id === clip.asset);
    if (!asset) continue;
    const info = await probe(asset.path);
    if (!info) {
      issues.push({
        level: 'pending',
        code: 'audio-asset-media-unknown',
        subject: clip.id,
        message: `Audio clip ${clip.id} references Asset ${asset.id}, whose audio length could not be read; its interval is only verified against the real media at the mix.`,
      });
      continue;
    }
    const available = Math.round(info.duration * output.sampleRate);
    const declaredEnd = clip.inSample + clip.durationSamples;
    const overrun = declaredEnd - available;
    // `declaredEnd <= available` is unambiguously fine; only a large overrun is a
    // known error, and a small one stays a `pending` fact for the exact mix guard.
    if (overrun <= 0) continue;
    if (overrun > Math.max(Math.ceil(output.sampleRate / 2), Math.ceil(available * 0.05)))
      issues.push({
        level: 'blocked',
        code: 'audio-clip-reads-beyond-asset',
        subject: clip.id,
        message: `Audio clip ${clip.id} reads samples [${clip.inSample}, ${declaredEnd}) beyond Asset ${asset.id} (~${available} samples at the output rate); handles unavailable.`,
      });
    else
      issues.push({
        level: 'pending',
        code: 'audio-clip-length-approximate',
        subject: clip.id,
        message: `Audio clip ${clip.id} reads samples [${clip.inSample}, ${declaredEnd}), near Asset ${asset.id}'s probed length (~${available} samples at the output rate); the exact overrun is verified against the real decoded media at the mix.`,
      });
  }
  return issues;
}

/**
 * Pure-state audio/finishing issues knowable from the Project alone, BEFORE any
 * capture/generation/encode: a programme fade longer than the programme, a
 * ducking bus with no members, stereo pan on a mono output, and a kept-audio
 * lead/offset that leaves the programme. Each mirrors a runtime guard in
 * `backends/media/picture.ts`, so the same authored mistake is caught here rather
 * than only after expensive picture/audio work has already been produced. Both
 * the production preflight and the Build call this, so they cannot drift.
 *
 * `substituted` (a preview) excludes placements the preview replaces with a
 * silent gap. `preview` additionally relaxes the ducking-membership rule, which
 * a preview is allowed to DROP (its substituted placements may have been a
 * bus's only members); a full Build enforces it.
 */
export function compositionStateIssues(
  project: FilmProject,
  options: { substituted?: ReadonlySet<string>; preview?: boolean } = {},
): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const composition = project.composition;
  const { fps, sampleRate, channels } = composition.output;
  let totalFrames = 0;
  try {
    totalFrames = compositionFrames(project);
  } catch {
    // A broken timeline is reported by the caller; do not duplicate it here.
    return issues;
  }
  const totalSamples = framesToSamples(totalFrames, fps, sampleRate, 'ceil');
  const fade = composition.fade;
  if (fade && fade.inFrames + fade.outFrames > totalFrames)
    issues.push({
      level: 'blocked',
      code: 'programme-fade-too-long',
      subject: 'composition.fade',
      message: `The programme fade (inFrames ${fade.inFrames} + outFrames ${fade.outFrames}) exceeds the ${totalFrames}-frame programme.`,
    });
  for (const clip of composition.audio) {
    if ((clip.pan !== undefined || clip.panAutomation !== undefined) && channels !== 2)
      issues.push({
        level: 'blocked',
        code: 'pan-requires-stereo',
        subject: clip.id,
        message: `Audio clip ${clip.id} declares a stereo pan but the output has ${channels} channel(s); pan requires a 2-channel output.`,
      });
  }
  const activePlacements = composition.placements.filter(placement => !options.substituted?.has(placement.id));
  // A ducking target/control bus must have at least one member (a clip or a
  // kept placement declaring that bus), else the rule would be silently inert.
  if (!options.preview) {
    const memberBuses = new Set<string>();
    for (const clip of composition.audio) if (clip.bus !== undefined) memberBuses.add(clip.bus);
    for (const placement of activePlacements)
      if (placement.audio === 'keep' && placement.bus !== undefined) memberBuses.add(placement.bus);
    for (const entry of composition.ducking ?? []) {
      if (!memberBuses.has(entry.target))
        issues.push({
          level: 'blocked',
          code: 'ducking-target-empty',
          subject: entry.target,
          message: `Composition ducking target bus "${entry.target}" has no members; add an audio clip or kept placement on that bus.`,
        });
      if (!memberBuses.has(entry.control))
        issues.push({
          level: 'blocked',
          code: 'ducking-control-empty',
          subject: entry.control,
          message: `Composition ducking control bus "${entry.control}" has no members; add an audio clip or kept placement on that bus.`,
        });
    }
  }
  // Kept-audio lead/offset placement on the programme sample clock. The bounds
  // mirror `mixAudio`: a lead never moves the body, and an explicit
  // offset/tail/lead asserts an exact placement that must stay inside the mix.
  for (const placement of activePlacements) {
    if (placement.audio !== 'keep') continue;
    const offset = placement.audioOffsetSamples ?? 0;
    const lead = placement.audioLeadSamples ?? 0;
    const tail = placement.audioTailSamples ?? 0;
    if (offset === 0 && lead === 0 && tail === 0) continue;
    const startSample = framesToSamples(placement.startFrame, fps, sampleRate, 'nearest') + offset;
    const leadStart = startSample - lead;
    if (leadStart < 0)
      issues.push({
        level: 'blocked',
        code: 'kept-audio-before-programme',
        subject: placement.id,
        message: `Placement ${placement.id} kept audio starts before the programme (sample ${leadStart}); reduce the lead or the negative offset.`,
      });
    else if (startSample >= totalSamples)
      issues.push({
        level: 'blocked',
        code: 'kept-audio-past-programme',
        subject: placement.id,
        message: `Placement ${placement.id} kept audio starts past the programme end (sample ${startSample} >= ${totalSamples}); reduce the offset.`,
      });
    else {
      const bodyFrames = placement.durationFrames ?? placement.outFrame - placement.inFrame;
      const extentEnd = startSample + framesToSamples(bodyFrames, fps, sampleRate, 'ceil') + tail;
      if (extentEnd > totalSamples)
        issues.push({
          level: 'blocked',
          code: 'kept-audio-extent-past-programme',
          subject: placement.id,
          message: `Placement ${placement.id} kept audio with an explicit offset/tail/lead extends past the programme end (${extentEnd} > ${totalSamples}); reduce the offset, tail or lead.`,
        });
    }
  }
  return issues;
}

/**
 * The result of the shared subtitle-font preflight: the resolved, hashed font
 * when the composition authors subtitles and it is available, plus a `blocked`
 * issue when subtitles are authored but no usable font could be resolved.
 */
export interface SubtitleFontPreflight {
  font?: SubtitleFont;
  issues: PlanIssue[];
}

/**
 * The locally-knowable SUBTITLE dependency, resolved once before any picture
 * work. A composition that authors subtitles needs a usable font (an explicit
 * `VISCRAFT_SUBTITLE_FONT` or a system DejaVu Sans); its absence must fail the
 * preflight and the Build BEFORE any capture/compose, never only AFTER the most
 * expensive render. This is the ONE shared check both Plan and Build call (so
 * they cannot drift), and it returns the resolved font so the Build reuses the
 * SAME resolved font for `renderSubtitles` rather than resolving it twice. A
 * composition with no subtitles requires no font and reports no issue.
 */
export async function subtitleFontPreflight(project: FilmProject): Promise<SubtitleFontPreflight> {
  const subtitles = project.composition.subtitles ?? [];
  if (subtitles.length === 0) return { issues: [] };
  try {
    return { font: await findSubtitleFont(), issues: [] };
  } catch (error) {
    return {
      issues: [
        {
          level: 'blocked',
          code: 'subtitle-font-unavailable',
          subject: 'composition.subtitles',
          message: `The composition authors ${subtitles.length} subtitle(s) but no usable subtitle font could be resolved: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}

/**
 * Validate a candidate plan (shot -> sources) EXACTLY as the Build does, so the
 * preflight cannot pass a plan the Build then rejects: the schema shape, an
 * existing Shot, unique existing Sources, and no duplicate Shot. Shared by the
 * preflight and the Build (both import it), with "Candidate plan" in every
 * message so the two report the same failure.
 */
export function candidatePlanIssues(
  project: FilmProject,
  candidates: readonly { shot: string; sources: string[] }[],
): PlanIssue[] {
  let parsed: Array<{ shot: string; sources: string[] }>;
  try {
    parsed = CandidatePlanSchema.parse(candidates);
  } catch (error) {
    return [
      {
        level: 'blocked',
        code: 'invalid-candidates',
        message: `Candidate plan is invalid: ${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  }
  const issues: PlanIssue[] = [];
  const sourceIds = new Set(project.sources.map(source => source.id));
  const shotIds = new Set(project.composition.shots.map(shot => shot.id));
  for (const candidate of parsed) {
    if (
      !shotIds.has(candidate.shot) ||
      candidate.sources.some(id => !sourceIds.has(id)) ||
      new Set(candidate.sources).size !== candidate.sources.length
    )
      issues.push({
        level: 'blocked',
        code: 'candidate-plan-invalid',
        subject: candidate.shot,
        message: 'Candidate plan must reference an existing Shot and unique existing Sources',
      });
  }
  if (new Set(parsed.map(candidate => candidate.shot)).size !== parsed.length)
    issues.push({
      level: 'blocked',
      code: 'candidate-plan-duplicate-shot',
      message: 'Candidate plan contains a duplicate Shot',
    });
  return issues;
}

/**
 * The Source ids a Build of the current Project (or a preview of it) actually
 * CONSUMES and executes: placement Sources (minus preview-substituted
 * placements), picture-layer Sources (minus preview-dropped layers), code-authored
 * sound-clip Sources, and candidate-plan Sources. Shared so the Build's
 * environment/tool probing and the preflight's work/reuse prediction look at the
 * SAME scope — an unused bad Source or a substituted placement never blocks.
 */
export function consumedSourceIds(
  project: FilmProject,
  options: {
    substituted?: ReadonlySet<string>;
    droppedLayers?: ReadonlySet<string>;
    candidates?: readonly { sources: string[] }[];
  } = {},
): Set<string> {
  const ids = new Set<string>();
  for (const placement of project.composition.placements)
    if (placement.source && !options.substituted?.has(placement.id)) ids.add(placement.source);
  for (const layer of project.composition.layers ?? [])
    if (layer.source && !options.droppedLayers?.has(layer.id)) ids.add(layer.source);
  for (const clip of project.composition.audio) if (clip.kind === 'source') ids.add(clip.source);
  for (const candidate of options.candidates ?? []) for (const id of candidate.sources) ids.add(id);
  return ids;
}

/** Frames a Source is expected to yield, or `undefined` when only known after the run. */
async function expectedSourceFrames(
  project: Project,
  source: Source,
  probe: (asset: string) => Promise<number | undefined>,
): Promise<number | 'unknown'> {
  const known = staticSourceFrames(project, source);
  if (known !== undefined) return known;
  const assetId = sourceExecutor(source).probeAsset(source);
  if (assetId !== undefined) return (await probe(assetId)) ?? 'unknown';
  return 'unknown';
}

function sourceCarriesAudio(source: Source): boolean | 'unknown' {
  const known = staticSourceAudio(source);
  return known === undefined ? 'unknown' : known;
}

/** What a plan describes; mirrors the Build's target selection. */
type PlanSelection = { medium: 'picture' } | { medium: 'sound'; target: SoundTarget };

function resolvePlanSelection(project: Project, requested?: string): PlanSelection {
  if (requested !== undefined) {
    const target = project.soundTargets.find(candidate => candidate.id === requested);
    if (target) return { medium: 'sound', target };
    if (project.imageTargets.some(candidate => candidate.id === requested))
      throw new Error(`plan: "${requested}" is an image target; plan the still-image path, not a timeline Build`);
    throw new Error(`plan: unknown target "${requested}"`);
  }
  if (project.composition) return { medium: 'picture' };
  throw new Error('plan: this Project declares no timeline composition; name a sound target with --target');
}

export async function planBuild(root: string, options: PlanOptions = {}): Promise<BuildPlan> {
  options = withUserEndpoints(options);
  const project = await loadProject(root);
  const selection = resolvePlanSelection(project, options.target);
  const film = project as FilmProject;
  const pictureOutput =
    selection.medium === 'sound'
      ? {
          width: 960,
          height: 540,
          fps: { numerator: 24, denominator: 1 },
          sampleRate: selection.target.sampleRate,
          channels: selection.target.channels,
        }
      : film.composition.output;
  const history = await readBuilds(root);
  const blockers: PlanIssue[] = [];
  const needsConfiguration: PlanIssue[] = [];
  const requiresApproval: PlanIssue[] = [];
  const unsupported: PlanIssue[] = [];
  const pending: PlanIssue[] = [];
  const reuse: PlanReuse[] = [];
  const work: PlanWork[] = [];
  const sources: PlanSource[] = [];
  const notes: string[] = [];

  if (selection.medium === 'sound' && options.preview)
    throw new Error('A preview renders a film interval; a sound target has no picture interval to preview');
  let preview: ResolvedPreview | undefined;
  if (options.preview) {
    try {
      preview = resolvePreview(film, options.preview);
    } catch (error) {
      blockers.push({
        level: 'blocked',
        code: 'invalid-preview',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const timeline =
    selection.medium === 'picture'
      ? analyzeTimeline(film.composition.placements, film.composition.transitions)
      : { overlaps: [] as PlanOverlap[], blockers: [] as PlanIssue[], contentFrames: 0 };
  if (selection.medium === 'picture') {
    for (const gap of buildabilityGaps(film))
      blockers.push({ level: 'blocked', code: 'not-buildable', message: `Build cannot produce a target: ${gap}.` });

    for (const issue of timeline.blockers) blockers.push(issue);
    // Pure-state audio/finishing issues (fade length, ducking bus membership, pan
    // on mono, kept-audio lead/offset range) — the SAME shared preflight the Build
    // runs, so a full Build and its preflight agree. A preview relaxes the ducking
    // rule, which it is allowed to drop.
    for (const issue of compositionStateIssues(film, {
      substituted: preview?.substituted,
      preview: preview !== undefined,
    }))
      blockers.push(issue);
    // The locally-knowable subtitle dependency: a composition that authors
    // subtitles needs an available font, and this is the SAME shared check the
    // Build runs before any capture/compose (so Plan and Build cannot drift).
    for (const issue of (await subtitleFontPreflight(film)).issues) blockers.push(issue);
    // An `asset` audio clip's interval against its Asset's real length — the SAME
    // shared check the Build runs before any capture/compose, so a clip that reads
    // past its Asset is caught here rather than only inside `mixAudio` after the
    // picture has been produced.
    for (const issue of await audioAssetClipIssues(film, { root })) {
      if (issue.level === 'pending') pending.push(issue);
      else blockers.push(issue);
    }
  }
  // Read-only local probe of media Assets, memoized.
  const probeCache = new Map<
    string,
    Promise<{ frames?: number; fps?: Fps; duration?: number; audio?: boolean; missing?: boolean }>
  >();
  const probeAsset = (
    assetId: string,
  ): Promise<{ frames?: number; fps?: Fps; duration?: number; audio?: boolean; missing?: boolean }> => {
    const cached = probeCache.get(assetId);
    if (cached) return cached;
    const task = (async () => {
      const asset = project.assets.find(candidate => candidate.id === assetId);
      if (!asset) return { missing: true };
      try {
        const info = await probeMedia(await resolveProjectPath(root, asset.path));
        return { frames: info.frames, fps: info.fps, duration: info.duration, audio: Boolean(info.audio) };
      } catch {
        return { missing: true };
      }
    })();
    probeCache.set(assetId, task);
    return task;
  };

  const reusable = reusableHistory(history);
  const historyTakes: Take[] = reusable.flatMap(build => build.takes);
  const takeById = new Map<string, Take>();
  for (const take of historyTakes) if (!takeById.has(take.id)) takeById.set(take.id, take);
  const artifactById = new Map<string, TakeArtifactRecord & { simulated: boolean }>();
  for (const build of reusable)
    for (const artifact of build.artifacts) if (!artifactById.has(artifact.id)) artifactById.set(artifact.id, artifact);

  // EXACT reuse: a REUSABLE history Build's operation key maps to its artifact
  // (the same set the Build reuses — a failed build's completed, hash-verified
  // operation counts too). The preflight recomputes the CURRENT key with the
  // SAME identity function the Build uses (`build/identity.ts`), so an edited
  // authored file, binding, world or provider configuration produces a different
  // key and therefore a work item rather than a false "reuse".
  const artifactByKey = new Map<string, { id: string; path: string; sha256: string }>();
  for (const build of reusable)
    for (const operation of build.operations) {
      const artifact = build.artifacts.find(candidate => candidate.id === operation.artifact);
      if (artifact && !artifactByKey.has(operation.key)) artifactByKey.set(operation.key, artifact);
    }
  // Exactly the Sources this run consumes/executes (shared with the Build's
  // environment/tool probing), so an unused Source or a preview-substituted
  // placement is neither probed nor allowed to block.
  const placementSourceIds =
    selection.medium === 'sound'
      ? new Set(selection.target.audio.flatMap(clip => (clip.kind === 'source' ? [clip.source] : [])))
      : consumedSourceIds(film, {
          substituted: preview?.substituted,
          droppedLayers: preview?.droppedLayers,
          candidates: preview ? [] : (options.candidates ?? []),
        });
  let files: Map<string, string> | undefined;
  let probe: OperationEnvironmentProbe | undefined;
  let implementationFor: ((kind: string, scope?: VideoOperationScope) => Promise<string>) | undefined;
  try {
    // The SAME complete author inventory and content-store recovery the Build
    // freezes. A declared fact whose bytes are absent/unreadable/damaged is now a
    // recorded GAP, not a thrown error: it only blocks the Sources that actually
    // consume it, so an unrelated missing recording cannot erase every reuse
    // prediction.
    const facts = await authoredFileFacts(project, root, {
      recover: async (_relative, declaredSha256) => {
        const entry = await resolveProjectPath(root, contentPath(declaredSha256));
        try {
          return (await hashFile(entry)) === declaredSha256 ? declaredSha256 : null;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        }
      },
    });
    files = new Map(Object.entries(facts.files));
    if (selection.medium === 'picture') occluderInputAssets(film, files);
    // Tool/runtime facts are probed only for the Sources this run actually
    // executes: an unused Blender/browser Source must not require its tool. The
    // probe memoizes each tool once; a Source's per-operation environment is
    // built from only that Source's own tools, exactly as the Build does.
    probe = operationEnvironmentProbe(options);
    const consumedTools: KeyTools = { browser: false, blender: false };
    for (const source of project.sources)
      if (placementSourceIds.has(source.id)) {
        const tools = sourceExecutor(source).tools;
        if (tools.browser) consumedTools.browser = true;
        if (tools.blender) consumedTools.blender = true;
      }
    await probe.base();
    await probe.environment(consumedTools);
    const implementationRoot = await runtimeRoot();
    const backendFallback = await backendEntries(implementationRoot);
    const cache = new Map<string, string>();
    implementationFor = async (kind: string, scope?: VideoOperationScope): Promise<string> => {
      const cacheKey = `${kind}\u0000${scope?.protocol ?? ''}\u0000${(scope?.implementationFiles ?? []).join('\u0001')}`;
      const hit = cache.get(cacheKey);
      if (hit) return hit;
      const fingerprint = await operationImplementation(implementationRoot, kind, backendFallback, scope);
      cache.set(cacheKey, fingerprint);
      return fingerprint;
    };
  } catch (error) {
    // Reuse cannot be evaluated (a missing authored input, or an absent
    // tool/runtime the Build would also need). Report it and mark every Source as
    // work rather than mislabeling it reusable.
    blockers.push({
      level: 'blocked',
      code: 'identity-unavailable',
      message: `Cannot evaluate operation identity for reuse: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  const reuseForSource = async (source: Source): Promise<PlanReuse | undefined> => {
    if (!files || !probe || !implementationFor) return undefined;
    let identity;
    try {
      const output = preview && rendersAtProxy(source) ? proxyOutput(pictureOutput, preview.scale) : pictureOutput;
      const sound = soundContextForSource(project, source, selection.medium === 'sound' ? selection.target : undefined);
      identity = await sourceOperationIdentity(project, source, options, files, output, root, sound);
    } catch (error) {
      if (error instanceof SourceInputError)
        blockers.push({
          level: 'blocked',
          code: 'source-input-unavailable',
          subject: error.sourceId,
          message: error.message,
        });
      return undefined;
    }
    const key = stableHash({
      kind: identity.kind,
      inputs: identity.inputs,
      parameters: identity.parameters,
      simulated: identity.simulated,
      // The SAME per-operation environment the Build computes for this Source:
      // only the tools its executor declares, over the shared base.
      environment: await probe.environment(sourceExecutor(source).tools),
      implementation: await implementationFor(
        identity.kind,
        identity.protocol
          ? { protocol: identity.protocol, implementationFiles: identity.implementationFiles }
          : undefined,
      ),
    });
    const artifact = artifactByKey.get(key);
    if (!artifact) return undefined;
    try {
      if ((await hashFile(await resolveProjectPath(root, artifact.path))) !== artifact.sha256) return undefined;
    } catch {
      return undefined;
    }
    return {
      subject: source.id,
      take: `take-${stableHash({ sourceKey: key, artifact: artifact.id }).slice(0, 40)}`,
      artifact: artifact.id,
      note: 'The current Source identity matches a reusable completed Build operation (identical operation key) and its artifact hash is verified; the Build will reuse it unless an input changes before it runs.',
    };
  };

  if (selection.medium === 'sound') {
    const target = selection.target;
    // Static clip/target checks: every reference resolves to a real sound Source
    // or an audio Asset, and every ducking label names a member bus. No media is
    // read and nothing is submitted.
    for (const clip of target.audio) {
      if (clip.kind === 'source') {
        const source = project.sources.find(candidate => candidate.id === clip.source);
        if (!source)
          blockers.push({
            level: 'blocked',
            code: 'missing-source',
            subject: clip.id,
            message: `Audio clip ${clip.id} references missing sound Source ${clip.source}.`,
          });
        else if (source.kind !== 'browser' || source.output !== 'sound')
          blockers.push({
            level: 'blocked',
            code: 'clip-source-medium',
            subject: clip.id,
            message: `Audio clip ${clip.id} references Source ${source.id}, which is not a sound Source.`,
          });
      } else if (!project.assets.some(asset => asset.id === clip.asset)) {
        blockers.push({
          level: 'blocked',
          code: 'missing-asset',
          subject: clip.id,
          message: `Audio clip ${clip.id} references missing Asset ${clip.asset}.`,
        });
      }
    }
    const memberBuses = new Set(target.audio.flatMap(clip => (clip.bus !== undefined ? [clip.bus] : [])));
    for (const entry of target.ducking ?? []) {
      if (!memberBuses.has(entry.target))
        blockers.push({
          level: 'blocked',
          code: 'ducking-bus-empty',
          subject: entry.target,
          message: `Sound target ${target.id} ducking target bus "${entry.target}" has no members.`,
        });
      if (!memberBuses.has(entry.control))
        blockers.push({
          level: 'blocked',
          code: 'ducking-bus-empty',
          subject: entry.control,
          message: `Sound target ${target.id} ducking control bus "${entry.control}" has no members.`,
        });
    }
    for (const sourceId of placementSourceIds) {
      const source = project.sources.find(candidate => candidate.id === sourceId);
      if (!source) continue;
      const executor = sourceExecutor(source);
      const expectedSamples = executor.staticSamples?.(project, source) ?? 'unknown';
      const sampleRate = source.kind === 'browser' && source.output === 'sound' ? source.sampleRate : undefined;
      sources.push({
        id: source.id,
        kind: source.kind,
        simulated: false,
        external: false,
        expectedSamples,
        sampleRate,
        carriesAudio: true,
      });
      const reused = await reuseForSource(source);
      if (reused) {
        reuse.push(reused);
        continue;
      }
      work.push({
        subject: source.id,
        kind: source.kind,
        simulated: false,
        external: false,
        reason:
          expectedSamples === 'unknown'
            ? 'no matching reusable operation; the rendered sample count is only known after the run'
            : `no matching reusable operation; would render ${expectedSamples} samples at ${sampleRate} Hz`,
      });
    }
    notes.push(
      `Sound target ${target.id} mixes exactly ${target.outputSamples} samples at ${target.sampleRate} Hz, ${target.channels} channel(s)${target.mastering ? ', then masters the programme' : ''}; a sound Build never writes the active movie result.`,
    );
    // No authoring change is claimed here: a sound result is not compared with the
    // active movie result, which it cannot replace.
    return {
      schemaVersion: 1,
      kind: 'build-plan',
      goal: options.goal ?? `Build sound target ${target.id}`,
      project: { id: project.id, revision: project.revision, title: project.title },
      medium: 'sound',
      target: target.id,
      outputSamples: target.outputSamples,
      sampleRate: target.sampleRate,
      channels: target.channels,
      buildable: blockers.length === 0,
      simulatedOnly: false,
      timeline: { contentFrames: 0, totalFrames: 0, placements: 0, overlaps: [] },
      sources,
      reuse,
      work,
      changes: null,
      identity: [],
      blockers,
      needsConfiguration,
      requiresApproval,
      unsupported,
      pending,
      notes,
    };
  }

  if (preview && options.candidates !== undefined)
    blockers.push({ level: 'blocked', code: 'invalid-preview', message: 'A preview does not take a candidate plan.' });
  // A candidate plan is validated with the SAME helper the Build uses, so the
  // preflight cannot pass a plan (missing Shot, duplicate/unknown Source) that
  // the Build would then reject.
  if (options.candidates !== undefined && !preview)
    for (const issue of candidatePlanIssues(film, options.candidates)) blockers.push(issue);

  // The context an executor's `classify`/`requestIssues` hooks read: the config
  // and root only (they never touch the frozen inputs or write anything).
  const providerContext: SourceContext = {
    project,
    providers: options.providers,
    files: new Map(),
    output: film.composition.output,
    loadRoot: root,
  };

  for (const sourceId of placementSourceIds) {
    const source = project.sources.find(candidate => candidate.id === sourceId);
    if (!source) {
      blockers.push({
        level: 'blocked',
        code: 'missing-source',
        subject: sourceId,
        message: `Referenced Source ${sourceId} does not exist.`,
      });
      continue;
    }
    const executor = sourceExecutor(source);
    const testOnly = executor.testOnly(source, options.providers);
    const simulated = executor.simulated(source, project, testOnly);
    const external = executor.external(source, testOnly, options.providers);
    const soundSource = executor.outputOf(source) === 'sound';
    const expectedSamples = soundSource ? (executor.staticSamples?.(project, source) ?? 'unknown') : undefined;
    const sampleRate = source.kind === 'browser' && source.output === 'sound' ? source.sampleRate : undefined;
    const frames = soundSource
      ? 'unknown'
      : await expectedSourceFrames(film, source, async id => (await probeAsset(id)).frames);
    const carriesAudio = sourceCarriesAudio(source);
    sources.push({
      id: source.id,
      kind: source.kind,
      simulated,
      external,
      ...(soundSource ? { expectedSamples, sampleRate } : { expectedFrames: frames }),
      carriesAudio,
    });
    // Reuse is evaluated FIRST. A Source whose exact operation key matches a
    // succeeded Build is NOT re-run, so it must not be asked to authorize spend
    // or transmit references, and its request need not be re-encoded here.
    const reused = await reuseForSource(source);
    if (reused) {
      reuse.push(reused);
      continue;
    }
    await executor.classify?.(source, providerContext, {
      blockers,
      needsConfiguration,
      requiresApproval,
      unsupported,
      pending,
    });
    for (const issue of (await executor.requestIssues?.(source, providerContext)) ?? []) blockers.push(issue);
    work.push({
      subject: source.id,
      kind: source.kind,
      simulated,
      external,
      reason: soundSource
        ? expectedSamples === 'unknown'
          ? 'no matching reusable operation; the rendered sample count is only known after the run'
          : `no matching reusable operation; would render ${expectedSamples} samples${sampleRate === undefined ? '' : ` at ${sampleRate} Hz`}`
        : frames === 'unknown'
          ? 'no matching reusable operation; would run and the returned frame count is only known after the run'
          : `no matching reusable operation; would produce ${frames} frames`,
    });
  }

  // Placement-level static checks against the expected Take length / audio.
  // A preview replaces placements outside its range with a silent gap and does
  // NOT produce their Source, so a substituted placement is not checked.
  for (const placement of film.composition.placements) {
    if (preview?.substituted.has(placement.id)) continue;
    if (placement.source) {
      const source = project.sources.find(candidate => candidate.id === placement.source)!;
      const frames = await expectedSourceFrames(film, source, async id => (await probeAsset(id)).frames);
      if (frames !== 'unknown' && placement.outFrame > frames)
        blockers.push({
          level: 'blocked',
          code: 'placement-reads-beyond-source',
          subject: placement.id,
          message: `Placement ${placement.id} reads frames [${placement.inFrame}, ${placement.outFrame}) beyond Source ${source.id} (${frames} frames); handles unavailable.`,
        });
      const placementExecutor = sourceExecutor(source);
      if (
        frames === 'unknown' &&
        placementExecutor.external(source, placementExecutor.testOnly(source, options.providers), options.providers)
      )
        pending.push({
          level: 'pending',
          code: 'take-length-unknown',
          subject: placement.id,
          message: `Placement ${placement.id} reads frames [${placement.inFrame}, ${placement.outFrame}) from generated Source ${source.id}; the Take length and therefore this interval are only verified after the run.`,
        });
      if (placement.audio === 'keep' && sourceCarriesAudio(source) === false)
        blockers.push({
          level: 'blocked',
          code: 'keep-audio-on-silent-source',
          subject: placement.id,
          message: `Placement ${placement.id} has audio "keep" but Source ${source.id} (${source.kind}) produces no audio stream; use audio "mute" or a Take that carries audio.`,
        });
    } else if (placement.take) {
      // The `take:` DEPENDENCY issues are reported by the ONE shared
      // `placementTakeIssues` call below (the SAME helper the Build runs before
      // any capture/POST). Here we only add the reuse prediction and the
      // simulated-provenance note, which are Plan-only descriptions.
      const take = takeById.get(placement.take);
      if (take && placement.audio === 'keep' && take.simulated)
        notes.push(
          `Placement ${placement.id} keeps audio from simulated Take ${take.id}; simulated provenance propagates to the result.`,
        );
      const artifact = take ? artifactById.get(take.artifact) : undefined;
      if (take && (await verifyTakeArtifact(artifact, root)))
        reuse.push({
          subject: placement.id,
          take: take.id,
          artifact: take.artifact,
          note: 'The selected Take exists in a completed Build and its artifact hash is verified; the Build reuses it directly.',
        });
    }
  }

  // Ordinary `take:` placement dependencies (missing Take, out-of-range
  // interval, unusable/archived Artifact, a non-picture Take, or a `keep` over a
  // silent Take). This is the SAME shared check the Build runs before any
  // capture/POST, so an ordinary later Take cannot pass the preflight and then
  // let an EARLIER Provider Source be submitted first. A failed Take-file probe
  // is an UNKNOWN fact (`pending`), never a fabricated "silent" claim.
  for (const issue of await placementTakeIssues(film, {
    takes: takeById,
    artifacts: artifactById,
    substituted: preview?.substituted,
    root,
  })) {
    if (issue.level === 'pending') pending.push(issue);
    else blockers.push(issue);
  }

  // Placement-level video-Asset dependencies (an out-of-range interval or a
  // `keep` over a silent Asset). This is the SAME shared metadata-probe check the
  // Build runs before any capture/submission, so an out-of-range video-Asset
  // placement cannot pass the preflight and then spend a POST/compose. A failed
  // probe is an UNKNOWN length (`pending`), never a blocker; a `source`/`take`
  // placement's own checks stay in the loop above. `keepAudioDiagnostic` keeps the
  // pre-existing Plan-only `keep-audio-on-silent-asset` fact (the Build leaves it
  // to its late guard, preserving the documented message precedence).
  for (const issue of await placementAssetIssues(film, {
    substituted: preview?.substituted,
    root,
    keepAudioDiagnostic: true,
  })) {
    if (issue.level === 'pending') pending.push(issue);
    else blockers.push(issue);
  }

  // Picture-layer dependencies. A layer consumes the same Source/Take/Asset
  // origins as a placement; the Sources were already added to the consumed set
  // above (and any missing Source is refused by `validateProject`). This is the
  // SAME shared check the Build runs before any capture/submission, so a layer
  // the Build would reject cannot pass the preflight. A preview drops
  // out-of-range layers, so those are skipped (their dependency is not consumed).
  // A failed video-Asset probe is an UNKNOWN length (`pending`), never a blocker.
  for (const issue of await pictureLayerIssues(film, {
    takes: takeById,
    artifacts: artifactById,
    droppedLayers: preview?.droppedLayers,
    root,
  })) {
    if (issue.level === 'pending') pending.push(issue);
    else blockers.push(issue);
  }

  // `contentFrames` is the real CONTENT end (the last placement's end), while
  // `totalFrames` is the programme length `compositionFrames` derives — which an
  // explicit `outputFrames` may pad with a black/silent tail. Reporting them
  // separately stops a padded tail from being reported as real content.
  let contentFrames = 0,
    totalFrames = 0;
  try {
    contentFrames = timeline.contentFrames;
    totalFrames = compositionFrames(project);
  } catch (error) {
    blockers.push({
      level: 'blocked',
      code: 'invalid-timeline',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const simulatedOnly = sources.every(source => source.simulated) && sources.length > 0;
  if (needsConfiguration.length > 0)
    notes.push(
      'needsConfiguration lists provider setup the USER must supply (an Endpoint or a credential); `viscraft auth status` shows what is configured. Never ask for a key in the conversation.',
    );
  if (requiresApproval.length > 0)
    notes.push(
      'This preflight performed no provider submission, upload or media write; the flagged items need the user to authorize spend/transmission.',
    );
  // compare the current author state to the ACTIVE result Build through the
  // same contentHash + diff Status uses, and surface identity-change hints.
  // Zero writes; no active result -> `changes: null`.
  let changes: ProjectDiff | null = null;
  let identity: string[] = [];
  try {
    const active = JSON.parse(await readFile(await resolveProjectPath(root, '.viscraft/result.json'), 'utf8')) as {
      build?: string;
    };
    const activeBuild = active.build ? history.find(build => build.id === active.build) : undefined;
    if (activeBuild) {
      const comparison = await compareAuthoring(root, project, activeBuild);
      if (comparison.frozenProject && comparison.frozenFiles && comparison.currentFiles) {
        if (comparison.status === 'changed')
          changes = diffProjects(comparison.frozenProject, project, comparison.frozenFiles, comparison.currentFiles);
        identity = identityHints(comparison.frozenProject, project);
      }
    }
  } catch {
    changes = null;
  }

  return {
    schemaVersion: 1,
    kind: 'build-plan',
    goal: options.goal ?? (preview ? `Preview frames ${preview.frames[0]}:${preview.frames[1]}` : 'Build composition'),
    project: { id: project.id, revision: project.revision, title: project.title },
    // `buildable` means a Build could actually run to completion under the
    // supplied configuration: no structural/authoring blocker, and nothing that
    // still needs provider setup, the user's spend authorization, or a fix to an
    // unsupported request. `pending` items do NOT block — they are facts only
    // known after the run.
    buildable:
      blockers.length === 0 &&
      needsConfiguration.length === 0 &&
      requiresApproval.length === 0 &&
      unsupported.length === 0,
    simulatedOnly,
    timeline: {
      contentFrames,
      totalFrames,
      outputFrames: film.composition.outputFrames,
      placements: film.composition.placements.length,
      overlaps: timeline.overlaps,
    },
    sources,
    reuse,
    work,
    changes,
    identity,
    blockers,
    needsConfiguration,
    requiresApproval,
    unsupported,
    pending,
    notes,
    ...(preview
      ? { preview: { frames: preview.frames, scale: preview.scale, substituted: [...preview.substituted] } }
      : {}),
  };
}
