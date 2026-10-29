/**
 * Frame promotion: approve one real frame of an existing Take/Artifact as a
 * reusable Project Asset.
 *
 * This is the honest bridge from build output to authoring state: a generated
 * still is an Artifact until the author promotes it, at which point it gains a
 * stable Asset identity and an
 * explicit, caller-supplied rights record. The binary it is cut from is never
 * touched, and no Build/Operation record is fabricated — promotion is its own
 * API, not a second Build.
 *
 * Guarantees:
 *  - the parent Artifact is read-only: its bytes are hashed before and after
 *    extraction and must stay identical;
 *  - the frame index is a real source frame of the probed media (0..N-1), not a
 *    timeline position;
 *  - the extracted still must carry a structurally valid PNG header (signature
 *    + IHDR with nonzero dimensions). The bytes come from real FFmpeg and are
 *    trusted as decoded output; the header check is a structural guard, not a
 *    pixel-level decode, and never passes an empty/failed encode;
 *  - rights are taken verbatim from the caller and never inferred from the
 *    parent (a non-redistributable Asset is legal to approve privately);
 *  - `simulated` is tainted along the lineage: the parent Artifact/Take, any
 *    history Artifact (including Artifacts left by failed Builds) sharing the
 *    parent hash, or a matching Project Asset, taints the new Asset;
 *  - `derivedFrom` records the actual parent provenance and never rewrites the
 *    caller's `rights.origin`;
 *  - the whole operation runs under the `author` lock and bumps the Project
 *    revision atomically, refusing an existing Asset id instead of overwriting.
 */

import { constants as fsConstants } from 'node:fs';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import {
  Id,
  RightsSchema,
  PromoteFrameOptionsSchema,
  type Asset,
  type Artifact,
  type BuildRecord,
  type PromoteFrameOptions,
  type Take,
} from '../../core/schema.js';
import { atomicJson, resolveProjectPath } from '../../shared/fs.js';
import { hashFile } from '../../shared/hash.js';
import { runCommand } from '../../shared/process.js';
import { acquireLock, loadProject, validateProject } from '../../project/project.js';
import { readBuilds } from '../../project/build-records.js';
import { probeMedia } from '../../backends/media/probe.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

export interface Located<T> {
  value: T;
  build: BuildRecord;
}

/** Index succeeded builds newest-first: `readBuilds` already sorts by startedAt desc. */
export function succeededIndex(builds: BuildRecord[]): {
  artifacts: Map<string, Located<Artifact>>;
  takes: Map<string, Located<Take>>;
} {
  const artifacts = new Map<string, Located<Artifact>>();
  const takes = new Map<string, Located<Take>>();
  for (const build of builds.filter(build => build.status === 'succeeded')) {
    for (const artifact of build.artifacts)
      if (!artifacts.has(artifact.id)) artifacts.set(artifact.id, { value: artifact, build });
    for (const take of build.takes) if (!takes.has(take.id)) takes.set(take.id, { value: take, build });
  }
  return { artifacts, takes };
}

/**
 * Structurally validate an extracted PNG: 8-byte signature, an IHDR chunk and
 * nonzero declared dimensions. This does not re-decode pixels; FFmpeg produced
 * the bytes, and the header check rejects empty/truncated/failed encodes.
 */
function assertPngHeader(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24 || !PNG_SIGNATURE.every((byte, index) => buffer[index] === byte)) {
    throw new Error('Frame extraction did not produce a valid PNG image');
  }
  if (buffer.toString('latin1', 12, 16) !== 'IHDR') throw new Error('Extracted PNG is missing its IHDR header');
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width <= 0 || height <= 0) throw new Error('Extracted PNG IHDR declares zero dimensions');
  return { width, height };
}

/** Extract one exact decoded source frame as a real PNG (no timeline mapping). */
async function extractFrame(source: string, frame: number, destination: string): Promise<void> {
  await runCommand('ffmpeg', [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-loglevel',
    'error',
    '-threads',
    '2',
    '-filter_threads',
    '1',
    '-i',
    source,
    '-vf',
    `select=eq(n\\,${frame})`,
    '-frames:v',
    '1',
    '-an',
    '-pix_fmt',
    'rgb24',
    destination,
  ]);
}

/**
 * Approve one frame of a succeeded Build's Take/Artifact as a reusable Project
 * Asset. See the module header for the exact guarantees.
 */
export async function promoteFrame(root: string, options: PromoteFrameOptions): Promise<Asset> {
  const parsed = PromoteFrameOptionsSchema.parse(options);
  const release = await acquireLock(root, 'author');
  let scratch: string | undefined;
  let createdDestination: string | undefined;
  try {
    const project = await loadProject(root);
    if (project.revision !== parsed.expectedRevision) {
      throw new Error(`Source revision conflict: expected ${parsed.expectedRevision}, found ${project.revision}`);
    }
    if (project.assets.some(asset => asset.id === parsed.assetId)) {
      throw new Error(
        `Asset ${parsed.assetId} already exists in this Project; refusing to overwrite an established Asset id`,
      );
    }

    const history = await readBuilds(root);
    const { artifacts, takes } = succeededIndex(history);

    let parentArtifact: Artifact;
    let parentBuildId: string;
    let parentTake: Take | undefined;
    if (parsed.take !== undefined) {
      const locatedTake = takes.get(parsed.take);
      if (!locatedTake) throw new Error(`Unknown Take ${parsed.take} in succeeded Builds`);
      parentTake = locatedTake.value;
      // Prefer the Artifact declared by the same Build that declares the Take;
      // otherwise fall back to the actual valid owner of that Artifact.
      const declared = locatedTake.build.artifacts.find(artifact => artifact.id === parentTake!.artifact);
      if (declared) {
        parentArtifact = declared;
        parentBuildId = locatedTake.build.id;
      } else {
        const owner = artifacts.get(parentTake.artifact);
        if (!owner) throw new Error(`Take ${parentTake.id} references a missing Artifact ${parentTake.artifact}`);
        parentArtifact = owner.value;
        parentBuildId = owner.build.id;
      }
    } else {
      const locatedArtifact = artifacts.get(parsed.artifact!);
      if (!locatedArtifact) throw new Error(`Unknown Artifact ${parsed.artifact} in succeeded Builds`);
      parentArtifact = locatedArtifact.value;
      parentBuildId = locatedArtifact.build.id;
    }

    if (parentArtifact.kind !== 'video')
      throw new Error(
        `Artifact ${parentArtifact.id} is ${parentArtifact.kind}, not a video; only video frames can be promoted`,
      );

    const sourcePath = await resolveProjectPath(root, parentArtifact.path);
    if ((await hashFile(sourcePath)) !== parentArtifact.sha256)
      throw new Error(`Artifact hash mismatch: ${parentArtifact.id} on disk does not match its recorded sha256`);
    const info = await probeMedia(sourcePath);
    if (
      !parentArtifact.media ||
      info.frames !== parentArtifact.media.frames ||
      info.width !== parentArtifact.media.width ||
      info.height !== parentArtifact.media.height ||
      info.fps.numerator * parentArtifact.media.fps.denominator !==
        parentArtifact.media.fps.numerator * info.fps.denominator
    )
      throw new Error(`Artifact ${parentArtifact.id} probe does not match its recorded media`);
    // Only a PICTURE Take has a frame span. A sound Take naming a video
    // Artifact is an inconsistent record, never a frame count to compare.
    if (parentTake && parentTake.medium !== 'picture')
      throw new Error(`Take ${parentTake.id} is a sound Take but Artifact ${parentArtifact.id} is video`);
    if (parentTake && parentTake.frames !== info.frames)
      throw new Error(`Take ${parentTake.id} frame span does not match its Artifact`);
    if (parsed.frame >= info.frames) {
      throw new Error(
        `Frame ${parsed.frame} is out of range for Artifact ${parentArtifact.id} (${info.frames} frames)`,
      );
    }

    // Taint propagates along the lineage: the selected record, the Take that
    // pointed at it, any history Artifact (including failed Builds) sharing
    // this exact bytes hash, or a matching Project Asset.
    const simulated =
      parentArtifact.simulated ||
      Boolean(parentTake?.simulated) ||
      history
        .flatMap(build => build.artifacts)
        .some(artifact => artifact.sha256 === parentArtifact.sha256 && artifact.simulated) ||
      project.assets.some(asset => asset.sha256 === parentArtifact.sha256 && asset.simulated);

    scratch = await resolveProjectPath(root, `.viscraft/scratch/promote-${randomUUID()}`);
    await mkdir(scratch, { recursive: true });
    const staged = path.join(scratch, 'frame.png');
    await extractFrame(sourcePath, parsed.frame, staged);

    const buffer = await readFile(staged);
    assertPngHeader(buffer);
    const sha256 = await hashFile(staged);
    if ((await hashFile(sourcePath)) !== parentArtifact.sha256) {
      throw new Error(
        `Artifact ${parentArtifact.id} changed while its frame was extracted; retry after the build stops writing`,
      );
    }

    const relative = `assets/${parsed.assetId}-${sha256.slice(0, 16)}.png`;
    const destination = await resolveProjectPath(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      await copyFile(staged, destination, fsConstants.COPYFILE_EXCL);
      createdDestination = destination;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A content-addressed file may already exist from an earlier promotion of
      // the same frame; reuse it only if the bytes are identical.
      if ((await hashFile(destination)) !== sha256)
        throw new Error(`Refusing to overwrite existing file ${relative} with different content`);
    }

    const asset: Asset = {
      id: parsed.assetId,
      revision: 1,
      path: relative,
      sha256,
      type: 'image',
      rights: parsed.rights,
      simulated,
      derivedFrom: {
        kind: 'frame',
        build: parentBuildId,
        artifact: parentArtifact.id,
        sha256: parentArtifact.sha256,
        frame: parsed.frame,
        ...(parentTake ? { take: parentTake.id } : {}),
      },
    };
    const next = validateProject({ ...project, revision: project.revision + 1, assets: [...project.assets, asset] });
    await atomicJson(await resolveProjectPath(root, 'project.json'), next);
    createdDestination = undefined;
    return asset;
  } finally {
    // Only a freshly written destination is cleaned up on failure; a reused
    // content-addressed file must survive. The Project itself is untouched
    // until the very last atomic write, so any earlier failure is a no-op.
    if (createdDestination) await rm(createdDestination, { force: true }).catch(() => {});
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
    await release();
  }
}

const rangeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const rangePositive = rangeInteger.refine(n => n > 0, 'Expected a positive integer');

export const PromoteRangeOptionsSchema = z
  .object({
    take: Id.optional(),
    artifact: Id.optional(),
    inFrame: rangeInteger,
    outFrame: rangePositive,
    every: rangePositive.default(1),
    idPrefix: Id.optional(),
    rights: RightsSchema,
    expectedRevision: rangePositive,
  })
  .strict()
  .refine(
    options => Boolean(options.take) !== Boolean(options.artifact),
    'Range promotion requires exactly one Take or Artifact',
  )
  .refine(
    options => options.outFrame > options.inFrame,
    'Range promotion requires a nonempty half-open interval (inFrame < outFrame)',
  );
export type PromoteRangeOptions = z.input<typeof PromoteRangeOptionsSchema>;

/**
 * Approve a strided, half-open range of a succeeded Build's Take/Artifact as
 * reusable image Assets (a storyboard set), in one author lock and one atomic
 * Project write. It shares promoteFrame's guarantees per frame — real decoded
 * source frames with a structural PNG header check, caller-supplied rights taken
 * verbatim, taint propagation, content-addressed staging and `derivedFrom`
 * provenance — and adds batch discipline:
 *
 *  - exactly the frames `inFrame, inFrame + every, ... while < outFrame` are
 *    decoded, in ascending order (deterministic for fixed inputs);
 *  - the whole selection is validated and staged before any destination file or
 *    the Project is written, so a rejected call leaves no partial Asset behind;
 *  - every frame is written under the single `author` lock as one atomic
 *    revision bump, refusing existing Asset ids and differing existing files;
 *  - an existing content-addressed file with identical bytes is reused, which
 *    makes a repeat call over unregistered output idempotent.
 */
export async function promoteRange(root: string, options: PromoteRangeOptions): Promise<Asset[]> {
  const parsed = PromoteRangeOptionsSchema.parse(options);
  const release = await acquireLock(root, 'author');
  let scratch: string | undefined;
  const created: string[] = [];
  try {
    const project = await loadProject(root);
    if (project.revision !== parsed.expectedRevision) {
      throw new Error(`Source revision conflict: expected ${parsed.expectedRevision}, found ${project.revision}`);
    }

    const history = await readBuilds(root);
    const { artifacts, takes } = succeededIndex(history);

    let parentArtifact: Artifact;
    let parentBuildId: string;
    let parentTake: Take | undefined;
    if (parsed.take !== undefined) {
      const locatedTake = takes.get(parsed.take);
      if (!locatedTake) throw new Error(`Unknown Take ${parsed.take} in succeeded Builds`);
      parentTake = locatedTake.value;
      const declared = locatedTake.build.artifacts.find(artifact => artifact.id === parentTake!.artifact);
      if (declared) {
        parentArtifact = declared;
        parentBuildId = locatedTake.build.id;
      } else {
        const owner = artifacts.get(parentTake.artifact);
        if (!owner) throw new Error(`Take ${parentTake.id} references a missing Artifact ${parentTake.artifact}`);
        parentArtifact = owner.value;
        parentBuildId = owner.build.id;
      }
    } else {
      const locatedArtifact = artifacts.get(parsed.artifact!);
      if (!locatedArtifact) throw new Error(`Unknown Artifact ${parsed.artifact} in succeeded Builds`);
      parentArtifact = locatedArtifact.value;
      parentBuildId = locatedArtifact.build.id;
    }

    if (parentArtifact.kind !== 'video')
      throw new Error(
        `Artifact ${parentArtifact.id} is ${parentArtifact.kind}, not a video; only video frames can be promoted`,
      );

    const sourcePath = await resolveProjectPath(root, parentArtifact.path);
    if ((await hashFile(sourcePath)) !== parentArtifact.sha256)
      throw new Error(`Artifact hash mismatch: ${parentArtifact.id} on disk does not match its recorded sha256`);
    const info = await probeMedia(sourcePath);
    if (
      !parentArtifact.media ||
      info.frames !== parentArtifact.media.frames ||
      info.width !== parentArtifact.media.width ||
      info.height !== parentArtifact.media.height ||
      info.fps.numerator * parentArtifact.media.fps.denominator !==
        parentArtifact.media.fps.numerator * info.fps.denominator
    )
      throw new Error(`Artifact ${parentArtifact.id} probe does not match its recorded media`);
    // Only a PICTURE Take has a frame span. A sound Take naming a video
    // Artifact is an inconsistent record, never a frame count to compare.
    if (parentTake && parentTake.medium !== 'picture')
      throw new Error(`Take ${parentTake.id} is a sound Take but Artifact ${parentArtifact.id} is video`);
    if (parentTake && parentTake.frames !== info.frames)
      throw new Error(`Take ${parentTake.id} frame span does not match its Artifact`);
    if (parsed.outFrame > info.frames) {
      throw new Error(
        `Range end ${parsed.outFrame} is out of range for Artifact ${parentArtifact.id} (${info.frames} frames); frames are 0..${info.frames - 1}`,
      );
    }

    const frames: number[] = [];
    for (let frame = parsed.inFrame; frame < parsed.outFrame; frame += parsed.every) frames.push(frame);

    const idPrefix =
      parsed.idPrefix ??
      (parentTake ? (parentTake.source ?? parentTake.asset ?? parentArtifact.id) : parentArtifact.id);
    const ids = frames.map(frame => `${idPrefix}-f${frame}`);
    for (const id of ids) {
      if (!Id.safeParse(id).success)
        throw new Error(`Generated Asset id ${id} is not a valid Viscraft Id; pass a shorter idPrefix`);
    }
    const registered = new Set(project.assets.map(asset => asset.id));
    const collision = ids.find(id => registered.has(id));
    if (collision)
      throw new Error(
        `Asset ${collision} already exists in this Project; refusing to overwrite an established Asset id`,
      );

    // Taint propagates along the lineage exactly as for a single frame.
    const simulated =
      parentArtifact.simulated ||
      Boolean(parentTake?.simulated) ||
      history
        .flatMap(build => build.artifacts)
        .some(artifact => artifact.sha256 === parentArtifact.sha256 && artifact.simulated) ||
      project.assets.some(asset => asset.sha256 === parentArtifact.sha256 && asset.simulated);

    scratch = await resolveProjectPath(root, `.viscraft/scratch/promote-${randomUUID()}`);
    await mkdir(scratch, { recursive: true });

    const staged: { id: string; frame: number; sha256: string; stage: string }[] = [];
    for (let index = 0; index < frames.length; index++) {
      const stage = path.join(scratch, `frame-${index}.png`);
      await extractFrame(sourcePath, frames[index], stage);
      assertPngHeader(await readFile(stage));
      staged.push({ id: ids[index], frame: frames[index], sha256: await hashFile(stage), stage });
    }
    if ((await hashFile(sourcePath)) !== parentArtifact.sha256) {
      throw new Error(
        `Artifact ${parentArtifact.id} changed while its frames were extracted; retry after the build stops writing`,
      );
    }

    const assets: Asset[] = [];
    for (const item of staged) {
      const relative = `assets/${item.id}-${item.sha256.slice(0, 16)}.png`;
      const destination = await resolveProjectPath(root, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      try {
        await copyFile(item.stage, destination, fsConstants.COPYFILE_EXCL);
        created.push(destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // A content-addressed file may already exist from an earlier promotion
        // of the same frame; reuse it only if the bytes are identical.
        if ((await hashFile(destination)) !== item.sha256)
          throw new Error(`Refusing to overwrite existing file ${relative} with different content`);
      }
      assets.push({
        id: item.id,
        revision: 1,
        path: relative,
        sha256: item.sha256,
        type: 'image',
        rights: parsed.rights,
        simulated,
        derivedFrom: {
          kind: 'frame',
          build: parentBuildId,
          artifact: parentArtifact.id,
          sha256: parentArtifact.sha256,
          frame: item.frame,
          ...(parentTake ? { take: parentTake.id } : {}),
        },
      });
    }

    const next = validateProject({
      ...project,
      revision: project.revision + 1,
      assets: [...project.assets, ...assets],
    });
    await atomicJson(await resolveProjectPath(root, 'project.json'), next);
    created.length = 0;
    return assets;
  } finally {
    // Only freshly written destinations are cleaned up on failure; files reused
    // from an earlier promotion must survive. Since every destination is written
    // before the single atomic Project write, an earlier failure leaves the
    // Project byte-identical and removes all partial images.
    for (const destination of created) await rm(destination, { force: true }).catch(() => {});
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
    await release();
  }
}
