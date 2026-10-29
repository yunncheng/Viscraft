/**
 * Direct still-image production.
 *
 * An image target names a real editable HTML document and the logical canvas /
 * output density to rasterize it at. This path:
 *  - freezes the document and every declared resource into the Build snapshot
 *    (so a recorded hash can never describe bytes that were later rewritten),
 *  - captures ONE still through the shared Browser (no `window.viscraft`
 *    contract, no ffmpeg, no fictitious fps/duration),
 *  - records a normal Build/Operation/Artifact with `target`, so a still result
 *    never overwrites the film result and vice versa,
 *  - reuses a previous result when the frozen document bytes, resources and
 *    output settings are unchanged, and only then.
 *
 * It does not invent a Scene, Shot, audio clip or timeline for the picture.
 */
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  BuildRecordSchema,
  type BuildDiagnostic,
  type BuildRecord,
  type ImageDocument,
  type ImageTarget,
  type Project,
} from '../core/schema.js';
import { captureStill } from '../backends/browser/capture.js';
import { freezeFile } from '../project/content-store.js';
import { readBuilds } from '../project/build-records.js';
import { acquireLock, loadProject } from '../project/project.js';
import { assertNoIncompleteRevert } from '../project/revert-journal.js';
import { authorState, snapshotHashOf } from '../project/state.js';
import { atomicJson, resolveProjectPath } from '../shared/fs.js';
import { hashFile, stableHash } from '../shared/hash.js';
import { compareImageEnvironment, imageEnvironment, type ImageEnvironment } from './image-identity.js';

/**
 * Identity of the still-production ALGORITHM, not a data-format version. The
 * saved workbench layout record is applied before rasterizing, so a key only
 * matches a Build that ran this same algorithm on the same author bytes.
 */
const IMPLEMENTATION = 'render-image-layout1';

export interface RenderImageOptions {
  /** Image target id; required when the Project declares more than one. */
  target?: string;
  /** Non-blocking goal recorded on the Build. */
  goal?: string;
}

export interface ImageRenderResult {
  build: string;
  target: string;
  artifact: string;
  /** Project-relative path of the rendered image. */
  path: string;
  /** Real output pixels. */
  width: number;
  height: number;
  format: ImageTarget['format'];
  background: ImageTarget['background'];
  simulated: boolean;
  /** True when an identical previous result was reused (no capture). */
  reused: boolean;
}

/** Resolve the target, refusing an ambiguous or unknown selection. */
function resolveTarget(project: Project, requested: string | undefined): ImageTarget {
  if (project.imageTargets.length === 0)
    throw new Error('render-image: this Project declares no image targets; add one to project.json');
  if (requested !== undefined) {
    const target = project.imageTargets.find(candidate => candidate.id === requested);
    if (!target) throw new Error(`render-image: unknown image target "${requested}"`);
    return target;
  }
  if (project.imageTargets.length > 1)
    throw new Error(
      `render-image: this Project declares ${project.imageTargets.length} image targets (${project.imageTargets
        .map(target => target.id)
        .join(', ')}); name one with --target`,
    );
  return project.imageTargets[0];
}

function documentOf(project: Project, target: ImageTarget): ImageDocument {
  const document = project.imageDocuments.find(candidate => candidate.id === target.document);
  if (!document)
    throw new Error(`render-image: target ${target.id} references unknown image document "${target.document}"`);
  return document;
}

/**
 * The numeric version shared by `<browser> --version` and the launched browser's
 * own `version()`. Comparing this ties the recorded probe to the binary that
 * actually painted the still; if either side does not report one, no comparison
 * is invented.
 */
function versionToken(value: string): string | null {
  return /(\d+\.\d+\.\d+(?:\.\d+)?)/.exec(value)?.[1] ?? null;
}

/** Identity of a still's AUTHORED inputs: the frozen bytes, their declared roles
 * and the output settings. The machine that painted it is a separate fact
 * (`ImageRenderIdentity.environment`), so an unprobeable browser can never make
 * intact recorded pixels look like edited author bytes. */
export interface ImageRenderKeyInput {
  document: ImageDocument;
  documentSha256: string;
  resources: Array<{ path: string; sha256: string }>;
  target: ImageTarget;
  /** Simulation provenance of the Assets consumed by this document. */
  simulated: boolean;
}

export function imageRenderKeyFrom(input: ImageRenderKeyInput): string {
  return stableHash({
    implementation: IMPLEMENTATION,
    document: input.document.id,
    documentSha256: input.documentSha256,
    resources: input.resources,
    simulated: input.simulated,
    output: {
      width: input.target.width,
      height: input.target.height,
      scale: input.target.scale,
      format: input.target.format,
      background: input.target.background,
    },
  });
}

/** What a still result claims: the author identity plus the machine observed now. */
export interface ImageRenderIdentity {
  /** Hash recorded on every `render-image` operation: document + resources + output. */
  key: string;
  /** `runtime/node/platform/browser/capture/layout/transpile` observed now. */
  environment: Record<string, string>;
  /** False when a fact is `unknown`: usable for copy/verify, never "current". */
  environmentVerified: boolean;
}

/** The public identity plus the exact hashed inputs it was computed from. */
interface StillIdentity extends ImageRenderIdentity {
  simulated: boolean;
  documentSha256: string;
  resources: Array<{ path: string; sha256: string }>;
  machine: ImageEnvironment;
}

async function identityFor(root: string, project: Project, target: ImageTarget): Promise<StillIdentity> {
  const document = documentOf(project, target);
  const consumed = new Set([document.path, ...document.resources]);
  const simulated = project.assets.some(asset => consumed.has(asset.path) && asset.simulated);
  const documentSha256 = await hashFile(await resolveProjectPath(root, document.path));
  const resources: Array<{ path: string; sha256: string }> = [];
  for (const relative of document.resources)
    resources.push({ path: relative, sha256: await hashFile(await resolveProjectPath(root, relative)) });
  const machine = await imageEnvironment();
  return {
    key: imageRenderKeyFrom({ document, documentSha256, resources, target, simulated }),
    simulated,
    environment: machine.facts,
    environmentVerified: machine.verified,
    documentSha256,
    resources,
    machine,
  };
}

/**
 * The identity `renderImage` would compute for this target from the CURRENT
 * author bytes: the operation key plus the environment observed now. Read-only;
 * it never renders, never launches the browser and never writes. A browser that
 * cannot be probed yields `environmentVerified: false` rather than an error or a
 * silent "same as recorded" claim.
 */
export async function imageRenderIdentity(root: string, targetId?: string): Promise<ImageRenderIdentity> {
  const project = await loadProject(root);
  return identityFor(root, project, resolveTarget(project, targetId));
}

/**
 * The author identity `renderImage` would compute for this target. A recorded
 * result whose key differs is stale: its pixels describe an older document,
 * resources or output setting, even though the bytes on disk are intact.
 */
export async function imageRenderKey(root: string, targetId?: string): Promise<string> {
  return (await imageRenderIdentity(root, targetId)).key;
}

export async function renderImage(root: string, options: RenderImageOptions = {}): Promise<ImageRenderResult> {
  const release = await acquireLock(root, 'build');
  try {
    await assertNoIncompleteRevert(root);
    const project = await loadProject(root);
    const target = resolveTarget(project, options.target);
    const document = documentOf(project, target);

    // --- 1. The author identity and the machine observed BEFORE rendering ---
    const identity = await identityFor(root, project, target);
    const { key, environment, environmentVerified, documentSha256, resources, simulated } = identity;

    // --- 2. Reuse an identical succeeded result ---------------------------
    // Reuse needs BOTH the author identity and a VERIFIED, equal environment: an
    // unverifiable machine must never be served as if it were the recorded one,
    // and neither must a different browser/runtime.
    const history = await readBuilds(root);
    if (environmentVerified) {
      for (const previous of history) {
        if (previous.status !== 'succeeded' || previous.target !== target.id) continue;
        const operation = previous.operations.find(candidate => candidate.kind === 'render-image');
        if (!operation || operation.key !== key || operation.reused) continue;
        // Reuse is exact: the recorded machine facts must equal the observed
        // ones. `compareImageEnvironment` is the one verdict every consumer uses.
        if (compareImageEnvironment(previous.environment, identity.machine) !== 'match') continue;
        const artifact = previous.artifacts.find(candidate => candidate.id === operation.artifact);
        if (!artifact || artifact.kind !== 'image' || !artifact.image) continue;
        const absolute = await resolveProjectPath(root, artifact.path);
        try {
          if ((await hashFile(absolute)) !== artifact.sha256) continue;
        } catch {
          continue;
        }
        return {
          build: previous.id,
          target: target.id,
          artifact: artifact.id,
          path: artifact.path,
          width: artifact.image.width,
          height: artifact.image.height,
          format: artifact.image.format,
          background: artifact.image.background,
          simulated: artifact.simulated,
          reused: true,
        };
      }
    }

    // --- 3. Freeze the author state the still is made from -----------------
    // The snapshot is a NORMAL Build snapshot (whole authored closure, flat
    // `.project.json`/`.inputs.json`, `snapshotHashOf`): versions/revert, the
    // production closure and a Portable export read the same metadata a film
    // Build writes, so an image version is a first-class version rather than a
    // second history with its own format. Declared files that are not readable
    // are explicit GAPS: an unrelated missing recording/Asset must not block a
    // still whose own document and resources are intact.
    const id = `build-${randomUUID()}`;
    const operationId = `operation-${randomUUID()}`;
    const snapshot = await resolveProjectPath(root, `.viscraft/snapshots/${id}`);
    // `freezeFile` resolves its snapshot root, so the directory must exist first.
    await mkdir(snapshot, { recursive: true });
    const verified = new Set<string>();
    const frozen = new Map<string, string>();
    const current = await authorState(root, project);
    for (const [relative, expected] of current.files) {
      const digest = await freezeFile(root, snapshot, relative, verified);
      // The frozen bytes ARE the capture input: an edit between hashing and
      // freezing would make the operation key describe different bytes.
      if (digest !== expected)
        throw new Error('render-image: an authored file changed while it was being frozen; retry');
      frozen.set(relative, digest);
    }
    if (frozen.get(document.path) !== documentSha256)
      throw new Error('render-image: the document changed while it was being frozen; retry');
    for (const resource of resources)
      if (frozen.get(resource.path) !== resource.sha256)
        throw new Error(`render-image: ${resource.path} changed while it was being frozen; retry`);
    // An Asset the still actually consumes must match its recorded bytes; an
    // unrelated Asset's state is carried by the shared snapshot facts instead.
    const consumed = new Set([document.path, ...document.resources]);
    for (const asset of project.assets)
      if (consumed.has(asset.path) && frozen.get(asset.path) !== asset.sha256)
        throw new Error(`render-image: consumed Asset ${asset.id} does not match its recorded sha256`);
    const unavailable = current.unavailable;

    const record: BuildRecord = {
      schemaVersion: 1,
      id,
      run: { id: `run-${randomUUID()}`, goal: options.goal ?? `Render image target ${target.id}` },
      plan: { operations: ['render-image'] },
      revision: project.revision,
      snapshotHash: snapshotHashOf(project, Object.fromEntries(frozen), unavailable),
      environment: { ...environment },
      status: 'running',
      startedAt: new Date().toISOString(),
      operations: [],
      artifacts: [],
      takes: [],
      target: target.id,
      // A still is the picture medium. The image TARGET distinguishes it from
      // the film composition; the medium distinguishes it from a sound programme.
      medium: 'picture',
    };
    const recordPath = await resolveProjectPath(root, `.viscraft/builds/${id}.json`);
    const persist = async (): Promise<void> => {
      await atomicJson(recordPath, BuildRecordSchema.parse(record));
    };
    await atomicJson(await resolveProjectPath(root, `.viscraft/snapshots/${id}.project.json`), project);
    await atomicJson(await resolveProjectPath(root, `.viscraft/snapshots/${id}.inputs.json`), {
      files: Object.fromEntries(frozen),
      unavailable,
    });
    await persist();

    let scratch: string | undefined;
    try {
      const still = await captureStill(
        snapshot,
        { entry: document.path, resources: document.resources },
        {
          width: target.width,
          height: target.height,
          scale: target.scale,
          format: target.format,
          background: target.background,
        },
      );
      // The identity was computed from the probed environment; if the browser or
      // a capture-side implementation changed while the still was being painted,
      // the pixels do not describe that identity. Refuse rather than publish it.
      const postEnvironment = await imageEnvironment();
      if (
        postEnvironment.verified !== environmentVerified ||
        stableHash(postEnvironment.facts) !== stableHash(environment)
      )
        throw new Error('render-image: the capture environment changed during the render; retry');
      const probedBrowser = versionToken(environment.browser);
      const launchedBrowser = versionToken(still.browserVersion);
      if (probedBrowser !== null && launchedBrowser !== null && probedBrowser !== launchedBrowser)
        throw new Error('render-image: the browser that painted the still is not the probed browser; retry');
      const extension = target.format === 'jpeg' ? 'jpg' : target.format;
      scratch = await resolveProjectPath(root, `.viscraft/scratch/${id}`);
      await mkdir(scratch, { recursive: true });
      const temporary = path.join(scratch, `${operationId}.${extension}`);
      await writeFile(temporary, still.bytes);
      const sha256 = await hashFile(temporary);
      const artifactId = `artifact-${stableHash({ key, sha256 }).slice(0, 40)}`;
      const relative = `.viscraft/artifacts/${artifactId}.${extension}`;
      const destination = await resolveProjectPath(root, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      let destinationExists = true;
      try {
        await hashFile(destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        destinationExists = false;
      }
      if (destinationExists) {
        if ((await hashFile(destination)) !== sha256)
          throw new Error(`render-image: artifact collision for ${artifactId}`);
        await rm(temporary, { force: true });
      } else {
        try {
          await rename(temporary, destination);
        } catch {
          await copyFile(temporary, destination);
          await rm(temporary, { force: true });
        }
      }

      const diagnostics: BuildDiagnostic[] = still.diagnostics.map(diagnostic => ({
        operation: operationId,
        code: diagnostic.code,
        message: diagnostic.message,
        detail: diagnostic.detail,
      }));
      record.diagnostics = diagnostics.length > 0 ? diagnostics : undefined;
      record.operations.push({
        id: operationId,
        kind: 'render-image',
        key,
        inputs: [document.path, ...document.resources],
        artifact: artifactId,
        reused: false,
      });
      record.artifacts.push({
        id: artifactId,
        path: relative,
        sha256,
        kind: 'image',
        simulated,
        operation: 'render-image',
        inputs: [document.path, ...document.resources],
        backend: `browser (${still.browserVersion})`,
        image: {
          width: still.width,
          height: still.height,
          format: target.format,
          background: target.background,
        },
      });
      record.result = { artifact: artifactId, simulated };
      record.status = 'succeeded';
      record.finishedAt = new Date().toISOString();
      await persist();
      return {
        build: id,
        target: target.id,
        artifact: artifactId,
        path: relative,
        width: still.width,
        height: still.height,
        format: target.format,
        background: target.background,
        simulated,
        reused: false,
      };
    } catch (error) {
      record.status = 'failed';
      record.error = error instanceof Error ? error.message : String(error);
      record.finishedAt = new Date().toISOString();
      await persist();
      throw error;
    } finally {
      if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  } finally {
    await release();
  }
}
