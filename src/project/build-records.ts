/**
 * Build/Artifact record persistence boundary (project layer).
 *
 * Reading Build records is a Project-facing query, not execution scheduling, so
 * it lives here rather than in `build/`. Analysis and delivery operations read
 * history through this module and never depend on the build scheduler.
 */
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BuildRecordSchema, type BuildRecord, type Project } from '../core/schema.js';
import { resolveProjectPath } from '../shared/fs.js';
import { redact } from '../shared/process.js';
import { loadProject } from './project.js';
import { listDeliveryRecords, type DeliveryRecord } from './output.js';

const BUILD_ID = /^build-[a-zA-Z0-9_-]+$/;

export async function readBuilds(root: string): Promise<BuildRecord[]> {
  const directory = await resolveProjectPath(root, '.viscraft/builds');
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const builds: BuildRecord[] = [];
  for (const name of names.filter(n => /^build-[a-zA-Z0-9_-]+\.json$/.test(n))) {
    const file = await resolveProjectPath(root, `.viscraft/builds/${name}`);
    try {
      builds.push(BuildRecordSchema.parse(JSON.parse(await readFile(file, 'utf8'))));
    } catch (error) {
      console.warn(`Ignoring invalid Build record ${name}: ${redact(String(error))}`);
    }
  }
  return builds.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function inspectProject(root: string): Promise<{ project: Project; builds: BuildRecord[] }> {
  return { project: await loadProject(root), builds: await readBuilds(root) };
}

/**
 * Read ONE Build record by id — the by-id query `inspect <project> <build-id>`
 * uses, so an agent can look a run up live instead of exporting a JSON copy.
 * The returned record is the same bytes `.viscraft/builds/<id>.json` holds (the
 * schema-parsed record already carries its Plan summary, diagnostics and
 * artifact list), and an unknown or malformed id fails loudly.
 */
export async function readBuild(root: string, buildId: string): Promise<BuildRecord> {
  if (!BUILD_ID.test(buildId)) throw new Error(`Not a Build id: ${buildId}`);
  const file = await resolveProjectPath(root, `.viscraft/builds/${buildId}.json`);
  try {
    return BuildRecordSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`No Build record ${buildId} in this project`);
    throw error;
  }
}

/** A compact one-line-per-Build view; never the full record. */
export interface BuildSummary {
  id: string;
  run: string;
  goal: string;
  status: BuildRecord['status'];
  startedAt: string;
  finishedAt: string | null;
  revision: number;
  preview: boolean;
  stale: boolean;
  retained: boolean;
  error: string | null;
  /** Number of Artifacts / Takes the record lists (not their full bodies). */
  artifacts: number;
  takes: number;
  /** The result artifact identity, when the Build produced one. */
  result: { artifact: string; path: string | null; simulated: boolean } | null;
  /** Whether this Build is the active result in `.viscraft/result.json`. */
  current: boolean;
}

export interface ProjectInspection {
  project: { id: string; title: string; revision: number; root: string };
  /** The active result Build id when `.viscraft/result.json` resolves to a record. */
  current: string | null;
  builds: BuildSummary[];
  /**
   * Recorded deliveries from `.viscraft/deliveries/` (bundle, export, archive,
   * playable), newest first. This is how a completed archive or export is
   * re-queried live instead of from an exported JSON copy.
   */
  deliveries: DeliverySummary[];
}

/** A compact one-line-per-delivery view; never the full record. */
export interface DeliverySummary {
  name: string;
  kind: DeliveryRecord['kind'];

  build: string | null;
  revision: number;
  deliveredAt: string;
  manifestSha256: string | null;
}

async function readActiveBuildId(root: string): Promise<string | null> {
  try {
    const value = JSON.parse(await readFile(await resolveProjectPath(root, '.viscraft/result.json'), 'utf8')) as {
      build?: unknown;
    };
    return typeof value.build === 'string' ? value.build : null;
  } catch {
    return null;
  }
}

function summarizeBuild(build: BuildRecord, current: boolean): BuildSummary {
  const resultArtifact = build.result
    ? build.artifacts.find(artifact => artifact.id === build.result!.artifact)
    : undefined;
  return {
    id: build.id,
    run: build.run.id,
    goal: build.run.goal,
    status: build.status,
    startedAt: build.startedAt,
    finishedAt: build.finishedAt ?? null,
    revision: build.revision,
    preview: Boolean(build.preview),
    stale: Boolean(build.stale),
    retained: Boolean(build.retained),
    error: build.error ?? null,
    artifacts: build.artifacts.length,
    takes: build.takes.length,
    result: build.result
      ? { artifact: build.result.artifact, path: resultArtifact?.path ?? null, simulated: build.result.simulated }
      : null,
    current,
  };
}

/**
 * The no-id `inspect <project>` view: a Project summary plus a LIST of Build
 * summaries. It deliberately never dumps the full records (the old behaviour
 * that pushed agents to export copies into `review/`).
 */
export async function inspectProjectSummary(root: string): Promise<ProjectInspection> {
  const project = await loadProject(root);
  const builds = await readBuilds(root);
  const active = await readActiveBuildId(root);
  const current = active && builds.some(build => build.id === active) ? active : null;
  const records = await listDeliveryRecords(root);
  return {
    project: { id: project.id, title: project.title, revision: project.revision, root: resolve(root) },
    current,
    builds: builds.map(build => summarizeBuild(build, build.id === active)),
    deliveries: records.map(record => ({
      name: record.name,
      kind: record.kind,

      build: record.build ?? null,
      revision: record.revision,
      deliveredAt: record.deliveredAt,
      manifestSha256: record.manifestSha256 ?? null,
    })),
  };
}
