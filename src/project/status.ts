/**
 * `viscraft status`: the one command an agent runs FIRST to see the current
 * state of a work without guessing from directory names or history.
 *
 * Read-only and zero-write: it never creates a lock, a build record, a job or a
 * cache entry. It answers, from the real records:
 *  - which Build/result is current and whether its media is actually present;
 *  - whether the author has changed the work since that result (contentHash);
 *  - what changed (the same diff used by Plan and Versions);
 *  - whether the newest Build differs from the current result (a failed/stale
 *    later Build must not hide a still-valid current result);
 *  - which provider jobs are unfinished (an unknown submission must be resolved
 *    before any new submit);
 *  - whether a writer lock is still held.
 *
 * Preview Builds never become the current result and are counted
 * separately, so a failed preview never reads as a failed Build.
 */
import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Artifact, BuildRecord, Project } from '../core/schema.js';
import { resolveProjectPath } from '../shared/fs.js';
import { runCommand } from '../shared/process.js';
import { readBuilds } from './build-records.js';
import { inspectOutputs } from './output.js';
import { runtimeLocation, type RuntimeLocation } from './create.js';
import { artifactAvailable } from './closure.js';
import { authorState, compareAuthoring, soundTargetFacts } from './state.js';
import { type AuthoredGap } from './author-inputs.js';
import { diffProjects, type ProjectDiff } from './diff.js';
import { imageRenderIdentity } from '../build/image.js';
import { compareImageEnvironment } from '../build/image-identity.js';
import { loadProject } from './project.js';
import { providerJobStatus } from '../backends/providers/status.js';
import { incompleteRevert } from './revert-journal.js';
import { incompleteCleanup } from './clean.js';

export interface StatusChangeSummary {
  sources: ProjectDiff['sources'];
  assets: ProjectDiff['assets'];
  composition: ProjectDiff['composition'];
  files: ProjectDiff['files'];
}

export interface StatusCurrent {
  build: string;
  path: string;
  sha256: string;
  available: boolean;
  /** Archive sha256 when the media bytes were released to an archive. */
  archived: string | null;
  simulated: boolean;
  frames: number | null;
  fps: string;
  authoring: 'unchanged' | 'changed' | 'unknown';
  changes: StatusChangeSummary | null;
  /** Declared authored files that are unreadable NOW (explicit gaps, not silence). */
  authoringGaps: AuthoredGap[];
}

export interface StatusAttention {
  code: string;
  message: string;
  next: string;
}

/**
 * A current STILL result, addressable by its target. Stills never become the
 * film's `.viscraft/result.json`: each target keeps its own newest succeeded
 * Build, and `stale` says whether the current author bytes would produce
 * different pixels. Without this, `status` would claim an image-only Project
 * has no output at all after a successful render.
 */
export interface StatusStill {
  target: string;
  document: string;
  build: string;
  artifact: string;
  path: string;
  width: number;
  height: number;
  format: string;
  simulated: boolean;
  /** The artifact file exists and hashes to the recorded sha256. */
  available: boolean;
  stale: boolean;
}

/**
 * A current SOUND programme, addressable by its target. A sound Build never
 * writes the film's `.viscraft/result.json`, so without this `status` would claim
 * a sound-only Project has no output. The real sample clock (samples/rate/
 * channels) is reported, never a picture frame count.
 */
export interface StatusSound {
  target: string;
  build: string;
  artifact: string;
  path: string;
  /** Frozen result clocks; null when its Build snapshot cannot establish them. */
  samples: number | null;
  sampleRate: number | null;
  channels: number | null;
  simulated: boolean;
  /** The artifact file exists and hashes to the recorded sha256. */
  available: boolean;
  /** Inputs changed, bytes are unavailable, or the frozen authoring facts cannot be verified. */
  stale: boolean;
}

/**
 * A read-only summary of the git working tree, when the Project is inside one.
 * Purely informational: an untracked file is a fact about the workspace, never a
 * reason to refuse a Build or a delivery. The
 * Runtime-owned `.viscraft/` (and `output/`) directories git-ignore themselves, so
 * they do not appear here.
 */
export interface GitSummary {
  inRepo: boolean;
  /** Why there is no summary: outside any work tree, or git is not installed. */
  reason?: 'not-a-repo' | 'git-unavailable';
  untracked: number;
  modified: number;
  /** The first few changed paths (untracked first), for context. */
  paths: string[];
  /** True when `paths` omits some of the changed files. */
  truncated: boolean;
}

export interface ProjectStatus {
  project: { id: string; title: string; revision: number; root: string };
  current: StatusCurrent | null;
  /** Newest succeeded still per image target (see {@link StatusStill}). */
  stills: StatusStill[];
  /** Newest succeeded programme per sound target (see {@link StatusSound}). */
  sounds: StatusSound[];
  latestBuild: { id: string; status: string; error: string | null; stale: boolean } | null;
  previews: {
    total: number;
    failed: number;
    latest: { id: string; status: string; frames: [number, number]; scale: number; error: string | null } | null;
  };
  running: { buildLock: boolean; authorLock: boolean };
  /** Declared handoff files and whether each exists. */
  handoff: Array<{ path: string; role: string; present: boolean }>;
  providerJobs: { pending: number; unknownSubmission: number; succeeded: number; failed: number };
  attention: StatusAttention[];
  next: string[];
  /**
   * `status` stays lightweight and never walks the tree, so it does not measure
   * bytes here: `measured` is always `false` and the honest answer points at
   * `viscraft usage`. A fixed `0` would read as "this Project is empty".
   */
  usage: { measured: false; detail: string };
  /** Where the running Runtime actually is, and whether it is this Project's install. */
  runtime: RuntimeLocation;
  /** Read-only git working-tree summary; informational, never blocking. */
  git: GitSummary;
  /** Runtime-owned `output/` facts: stale deliveries and unrecorded entries (report only). */
  outputs: Awaited<ReturnType<typeof inspectOutputs>>;
}

interface ActiveResult {
  build: string;
  artifact: string;
  path: string;
  sha256: string;
  simulated: boolean;
}

interface ActiveRead {
  value: ActiveResult | null;
  /** The file exists but is malformed / not a valid active-result record. */
  invalid: boolean;
}

async function readActiveResult(root: string): Promise<ActiveRead> {
  let raw: string;
  try {
    raw = await readFile(await resolveProjectPath(root, '.viscraft/result.json'), 'utf8');
  } catch {
    return { value: null, invalid: false };
  }
  try {
    const value = JSON.parse(raw) as Partial<ActiveResult>;
    if (
      typeof value.build !== 'string' ||
      typeof value.artifact !== 'string' ||
      typeof value.path !== 'string' ||
      typeof value.sha256 !== 'string' ||
      typeof value.simulated !== 'boolean'
    )
      return { value: null, invalid: true };
    return { value: value as ActiveResult, invalid: false };
  } catch {
    return { value: null, invalid: true };
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** How many changed paths the git summary echoes back (counts are always full). */
const GIT_PATH_LIMIT = 10;

/**
 * Summarize the working tree with `git status --porcelain`, read-only. Returns
 * `inRepo: false` (with a reason) when the Project is outside any work tree or git
 * is not installed — never an error, because this line of status is informational.
 */
async function gitSummary(root: string): Promise<GitSummary> {
  let output: string;
  try {
    output = await runCommand('git', ['-C', resolve(root), 'status', '--porcelain', '--untracked-files=all'], {
      timeoutMs: 30_000,
    });
  } catch (error) {
    return {
      inRepo: false,
      reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'git-unavailable' : 'not-a-repo',
      untracked: 0,
      modified: 0,
      paths: [],
      truncated: false,
    };
  }
  const untracked: string[] = [];
  const modified: string[] = [];
  for (const line of output.split('\n')) {
    if (line.length < 3) continue;
    const code = line.slice(0, 2);
    const raw = line.slice(3);
    // A rename line is `XY old -> new`; the path of interest is the new one.
    const relative = raw.includes(' -> ') ? raw.slice(raw.indexOf(' -> ') + 4) : raw;
    if (code === '??') untracked.push(relative);
    else modified.push(relative);
  }
  const paths = [...untracked, ...modified].slice(0, GIT_PATH_LIMIT);
  return {
    inRepo: true,
    untracked: untracked.length,
    modified: modified.length,
    paths,
    truncated: untracked.length + modified.length > paths.length,
  };
}

/** Group the raw provider job records by lifecycle stage. */
function groupJobs(jobs: unknown[]): ProjectStatus['providerJobs'] {
  let pending = 0;
  let unknownSubmission = 0;
  let succeeded = 0;
  let failed = 0;
  for (const job of jobs) {
    const status = (job as { state?: string } | null)?.state;
    switch (status) {
      case 'submit-unknown':
        unknownSubmission += 1;
        break;
      case 'succeeded':
        succeeded += 1;
        break;
      case 'failed':
        failed += 1;
        break;
      case 'created':
      case 'submitting':
      case 'submitted':
      case 'remote-completed':
      case 'download-failed':
        pending += 1;
        break;
      default:
        break;
    }
  }
  return { pending, unknownSubmission, succeeded, failed };
}

function fpsString(fps: { numerator: number; denominator: number }): string {
  return `${fps.numerator}/${fps.denominator}`;
}

async function buildCurrent(
  root: string,
  project: Project,
  buildsById: Map<string, BuildRecord>,
  active: ActiveResult | null,
): Promise<StatusCurrent | null> {
  if (!active) return null;
  const build = buildsById.get(active.build);
  const artifact = build?.artifacts.find(candidate => candidate.id === active.artifact);
  if (!build || !artifact) return null;

  const available = await artifactAvailable(root, artifact);
  const comparison = await compareAuthoring(root, project, build);
  let changes: StatusChangeSummary | null = null;
  if (
    comparison.status === 'changed' &&
    comparison.frozenProject &&
    comparison.frozenFiles &&
    comparison.currentFiles
  ) {
    const diff = diffProjects(comparison.frozenProject, project, comparison.frozenFiles, comparison.currentFiles);
    changes = { sources: diff.sources, assets: diff.assets, composition: diff.composition, files: diff.files };
  }
  return {
    build: build.id,
    path: artifact.path,
    sha256: artifact.sha256,
    available,
    archived: artifact.archived?.archive ?? null,
    simulated: artifact.simulated,
    frames: artifact.media?.frames ?? null,
    fps: artifact.media
      ? fpsString(artifact.media.fps)
      : project.composition
        ? fpsString(project.composition.output.fps)
        : '',
    authoring: comparison.status,
    changes,
    authoringGaps: comparison.currentUnavailable ?? [],
  };
}

export async function projectStatus(root: string): Promise<ProjectStatus> {
  const project = await loadProject(root);
  const builds = await readBuilds(root);
  const buildsById = new Map(builds.map(build => [build.id, build]));
  const activeRead = await readActiveResult(root);
  const current = await buildCurrent(root, project, buildsById, activeRead.value);
  // A present-but-unresolvable result.json (malformed, or referencing a Build /
  // Artifact that no longer exists) must be visible, not silently treated as
  // "no current result".
  const activeResultInvalid = activeRead.invalid || (activeRead.value !== null && current === null);

  // Current still per image target: the film's result.json stays untouched, so a
  // successful still would otherwise be invisible here. The reported result is
  // the one `renderImage` would REUSE — the newest succeeded Build of the target
  // whose operation key equals the current render key (a revert can make an
  // older Build current again). When no Build matches, the newest still is
  // reported with `stale: true` as the last good result. A Build whose target
  // the Project no longer declares is history, not a current still.
  const stills: StatusStill[] = [];
  for (const imageTarget of project.imageTargets) {
    const candidates = builds.filter(
      build =>
        build.status === 'succeeded' && !build.preview && build.medium === 'picture' && build.target === imageTarget.id,
    );
    if (candidates.length === 0) continue;
    // The identity `renderImage` would compute now: author key PLUS the machine
    // facts. A matching key alone is never "current" — a changed browser/runtime
    // cannot be shown to reproduce the recorded pixels.
    const identity = await imageRenderIdentity(root, imageTarget.id).catch(() => null);
    // Same selection a render performs: the newest Build with intact bytes whose
    // key matches the current author state; else the newest intact older result
    // (stale); else the newest recorded result even if its bytes are gone, so a
    // missing image is reported (`available:false`) instead of hidden.
    type Candidate = { build: BuildRecord; artifact: Artifact; available: boolean; stale: boolean };
    let current: Candidate | undefined;
    let newestAvailable: Candidate | undefined;
    let newest: Candidate | undefined;
    for (const build of candidates) {
      const artifact = build.artifacts.find(
        candidate => candidate.id === build.result?.artifact && candidate.kind === 'image' && candidate.image,
      );
      if (!artifact?.image) continue;
      const operation = build.operations.find(candidate => candidate.kind === 'render-image');
      const available = await artifactAvailable(root, artifact);
      const environmentMatch =
        identity !== null &&
        compareImageEnvironment(build.environment, {
          facts: identity.environment,
          verified: identity.environmentVerified,
        }) === 'match';
      const entry: Candidate = {
        build,
        artifact,
        available,
        stale: identity === null || operation?.key !== identity.key || !environmentMatch,
      };
      newest ??= entry;
      if (!available) continue;
      if (!entry.stale) {
        current = entry;
        break;
      }
      newestAvailable ??= entry;
    }
    const chosen = current ?? newestAvailable ?? newest;
    if (!chosen?.artifact.image) continue;
    stills.push({
      target: imageTarget.id,
      document: imageTarget.document,
      build: chosen.build.id,
      artifact: chosen.artifact.id,
      path: chosen.artifact.path,
      width: chosen.artifact.image.width,
      height: chosen.artifact.image.height,
      format: chosen.artifact.image.format,
      simulated: chosen.artifact.simulated,
      available: chosen.available,
      stale: chosen.stale,
    });
  }

  // Sound targets keep their OWN newest succeeded programme: a sound Build never
  // writes the film pointer, so this is the only current-result fact for them.
  const sounds: StatusSound[] = [];
  // The current author bytes, hashed once: a programme is only current when the
  // facts it was built from still equal them.
  const nowFacts = await (async (): Promise<Record<string, string> | null> => {
    try {
      return Object.fromEntries((await authorState(root, project)).files);
    } catch {
      return null;
    }
  })();
  for (const soundTarget of project.soundTargets) {
    const candidates = builds.filter(
      build =>
        build.status === 'succeeded' && !build.preview && build.medium === 'sound' && build.target === soundTarget.id,
    );
    if (candidates.length === 0) continue;
    const chosen = candidates[0];
    const artifact = chosen.artifacts.find(
      candidate => candidate.id === chosen.result?.artifact && candidate.kind === 'audio',
    );
    if (!artifact) continue;
    const available = await artifactAvailable(root, artifact);
    // The frozen facts come from THIS Build's own snapshot (the same reader the
    // authoring verdict uses), so an edited Source/target makes the old WAV stale
    // instead of silently current. An unreadable snapshot proves nothing.
    const comparison = await compareAuthoring(root, project, chosen);
    const frozenFacts =
      comparison.frozenProject && comparison.frozenFiles
        ? soundTargetFacts(comparison.frozenProject, soundTarget.id, comparison.frozenFiles)
        : null;
    const currentFacts = nowFacts ? soundTargetFacts(project, soundTarget.id, nowFacts) : null;
    const current = frozenFacts !== null && currentFacts !== null && frozenFacts === currentFacts;
    const frozenTarget = comparison.frozenProject?.soundTargets.find(candidate => candidate.id === soundTarget.id);
    sounds.push({
      target: soundTarget.id,
      build: chosen.id,
      artifact: artifact.id,
      path: artifact.path,
      // These are the target clocks frozen for THIS Build, never today's edited
      // target. Without that snapshot the media facts are unknown, not defaults.
      samples: frozenTarget?.outputSamples ?? null,
      sampleRate: frozenTarget?.sampleRate ?? null,
      channels: frozenTarget?.channels ?? null,
      simulated: artifact.simulated,
      available,
      stale: !current || !available,
    });
  }

  const previewRecords = builds.filter(build => build.preview);
  const latestPreview = previewRecords[0];
  const previews: ProjectStatus['previews'] = {
    total: previewRecords.length,
    failed: previewRecords.filter(build => build.status === 'failed').length,
    latest: latestPreview
      ? {
          id: latestPreview.id,
          status: latestPreview.status,
          frames: latestPreview.preview!.frames,
          scale: latestPreview.preview!.scale,
          error: latestPreview.error ?? null,
        }
      : null,
  };
  // `current`/`latestBuild` describe the FILM. An image Build is a target's own
  // result (reported under `stills`), never the newest film Build.
  const newest = builds.find(build => !build.preview && build.target === undefined);
  const latestBuild =
    newest && newest.id !== current?.build
      ? { id: newest.id, status: newest.status, error: newest.error ?? null, stale: newest.stale ?? false }
      : null;

  const runtimeDir = join(resolve(root), '.viscraft');
  const running = {
    buildLock: await fileExists(join(runtimeDir, 'build.lock')),
    authorLock: await fileExists(join(runtimeDir, 'author.lock')),
  };

  const providerJobs = groupJobs(await providerJobStatus(root));
  const handoff: ProjectStatus['handoff'] = [];
  for (const file of project.handoff ?? [])
    handoff.push({
      path: file.path,
      role: file.role,
      present: await fileExists(await resolveProjectPath(root, file.path)),
    });

  // Read-only facts: where the Runtime actually is, what git sees in the working
  // tree, and what the Runtime-owned `output/` holds. All three are informational.
  const runtime = await runtimeLocation(root);
  const git = await gitSummary(root);
  // `status` must always report, so a malformed Runtime record must never make it
  // throw: if the output bookkeeping cannot be read (e.g. a corrupt
  // `.viscraft/result.json`), report no output facts and keep going — the corrupt
  // result is still surfaced below as `active-result-invalid`.
  const outputs = await inspectOutputs(root).catch(() => ({ stale: [], unrecorded: [] }));

  const attention: StatusAttention[] = [];
  const next: string[] = [];
  if (activeResultInvalid)
    attention.push({
      code: 'active-result-invalid',
      message: '.viscraft/result.json is present but does not resolve to a Build result',
      next: 're-run `viscraft build` to refresh the active result (inspect the file if this is unexpected)',
    });
  if (providerJobs.unknownSubmission > 0)
    attention.push({
      code: 'unknown-submission',
      message: `${providerJobs.unknownSubmission} provider job(s) have an unknown submission outcome`,
      next: 'resolve the provider job before submitting again (see `viscraft inspect`); never re-submit automatically',
    });
  if (current && current.authoringGaps.length > 0)
    attention.push({
      code: 'author-gaps',
      message: `${current.authoringGaps.length} declared authored file(s) are unavailable: ${current.authoringGaps
        .map(gap => `${gap.path} (${gap.reason})`)
        .join(', ')}`,
      next: 'restore the file(s) before a whole-author export/deliver or a revert that needs them; a normal build of an unrelated consumed target may still succeed',
    });
  const revert = await incompleteRevert(root);
  if (revert)
    attention.push({
      code: 'revert-incomplete',
      message: `revert ${revert.id} to ${revert.target} was interrupted; other writes are refused until it is finished`,
      next: 'run `viscraft revert <project> --resume` to finish it or `--abort` to restore the checkpoint',
    });
  const cleanup = await incompleteCleanup(root);
  if (cleanup)
    attention.push({
      code: 'cleanup-incomplete',
      message: `cleanup ${cleanup.id} was interrupted with ${cleanup.remaining} item(s) left; new cleanups and reverts are refused`,
      next: 'run `viscraft clean <project> --resume` to finish it or `--abort` to stop it',
    });
  if (current?.archived)
    attention.push({
      code: 'archived-media',
      message: `the current result's media was released to archive ${current.archived}`,
      next: 'run `viscraft restore-media <project> <archive>` before delivering or rebuilding',
    });
  // Non-blocking browser capture diagnostics on the current result's Build.
  // Summarized as one item so the author is pointed at `review` without flooding
  // attention; whether the result is acceptable stays a creative decision.
  const currentBuild = current ? buildsById.get(current.build) : undefined;
  const captureDiagnostics = currentBuild?.diagnostics ?? [];
  if (captureDiagnostics.length > 0) {
    const codes = [...new Set(captureDiagnostics.map(diagnostic => diagnostic.code))];
    attention.push({
      code: 'capture-diagnostics',
      message: `the current result's Build recorded ${captureDiagnostics.length} browser capture diagnostic(s): ${codes.join(', ')}`,
      next: 'run `viscraft review` and read the report diagnostics; fix the canvas sizing/aspect or the unavailable font and re-build if the result is unwanted',
    });
  }
  const missingHandoff = handoff.filter(file => !file.present);
  if (missingHandoff.length > 0)
    attention.push({
      code: 'handoff-missing',
      message: `declared handoff file(s) missing: ${missingHandoff.map(file => file.path).join(', ')}`,
      next: 'restore the file or remove it from project.handoff; export refuses a missing handoff file',
    });
  // Report-only: stale deliveries (a delivery whose Build is no longer the current
  // result) and `output/` entries the Runtime never recorded. Never deleted here.
  if (outputs.stale.length > 0 || outputs.unrecorded.length > 0) {
    const parts: string[] = [];
    if (outputs.stale.length > 0)
      parts.push(
        `${outputs.stale.length} stale deliver${outputs.stale.length === 1 ? 'y' : 'ies'} (${outputs.stale
          .map(item => item.name)
          .join(', ')})`,
      );
    if (outputs.unrecorded.length > 0)
      parts.push(
        `${outputs.unrecorded.length} unrecorded output/ entr${outputs.unrecorded.length === 1 ? 'y' : 'ies'}`,
      );
    attention.push({
      code: 'output-not-current',
      message: `output/ holds ${parts.join(' and ')}`,
      next: 'these are files the Runtime did not record or an older delivery; reclaim them with `viscraft clean <project> --include output/<name>` — nothing under output/ is deleted automatically',
    });
  }
  if (
    !current &&
    project.composition === undefined &&
    (project.imageTargets.length > 0 || project.soundTargets.length > 0)
  ) {
    // Projects without a film timeline use their declared target routes.
    if (project.imageTargets.length > 0) {
      const changed = stills.filter(still => still.stale);
      if (stills.length === 0)
        next.push('no still rendered yet: run `viscraft image . --target <target>` (see the declared targets above)');
      else if (changed.length > 0)
        next.push(
          `image target(s) ${changed
            .map(still => still.target)
            .join(', ')} changed since their result: re-run \`viscraft image . --target <target>\``,
        );
      else
        next.push(
          'rendered stills are up to date: edit a document and re-run `viscraft image . --target <target>`, or export the Project',
        );
    }
    if (project.soundTargets.length > 0) {
      const needsBuild = project.soundTargets.filter(
        target => !sounds.some(sound => sound.target === target.id && !sound.stale),
      );
      if (needsBuild.length > 0)
        next.push(
          `sound target(s) ${needsBuild.map(target => target.id).join(', ')} need a Build: run \`viscraft plan . --target <target>\`, then \`viscraft build . --target <target>\``,
        );
      else
        next.push(
          'sound programmes are up to date: edit and re-plan with `--target <target>`, or run `viscraft deliver`',
        );
    }
  } else if (!current && !newest) next.push('no Build yet: run `viscraft plan`, then `viscraft build`');
  else if (current && current.authoring === 'changed')
    next.push('author changed since the current result: run `viscraft plan`, then `viscraft build`');
  else if (current && current.authoring === 'unchanged')
    next.push('current result is up to date: edit and re-plan, or run `viscraft deliver` to package it under output/');
  else if (current && current.authoring === 'unknown')
    next.push('the current result has no readable frozen snapshot: re-run `viscraft build` to refresh it');
  if (latestBuild && latestBuild.status === 'failed')
    next.push(`the newest Build (${latestBuild.id}) failed: inspect its error before re-building`);

  return {
    project: { id: project.id, title: project.title, revision: project.revision, root: resolve(root) },
    current,
    stills,
    sounds,
    latestBuild,
    previews,
    running,
    handoff,
    providerJobs,
    attention,
    next,
    usage: { measured: false, detail: 'not measured by status; run `viscraft usage` for the byte breakdown' },
    runtime,
    git,
    outputs,
  };
}
