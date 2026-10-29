import { existsSync } from 'node:fs';
import { copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { MediaInfo, OutputSettings } from '../../core/schema.js';
import { resolveProjectPath } from '../../shared/fs.js';
import { hashFile, stableHash } from '../../shared/hash.js';
import { normalizeMedia } from '../media/picture.js';
import { probeMedia } from '../media/probe.js';
interface LocalVideoMedia {
  output: OutputSettings;
  artifactOutput?: OutputSettings;
  artifactSha256?: string;
  artifactPath?: string;
  originalMediaSha256?: string;
  originalMediaPath?: string;
}

export async function installFile(srcPath: string, destAbs: string): Promise<void> {
  await mkdir(dirname(destAbs), { recursive: true });
  const tmp = `${destAbs}.viscraft-tmp-${process.pid}-${Date.now().toString(36)}`;
  await copyFile(srcPath, tmp);
  try {
    await rename(tmp, destAbs);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export function pickMedia(info: MediaInfo): MediaInfo {
  return {
    frames: info.frames,
    fps: info.fps,
    width: info.width,
    height: info.height,
    duration: info.duration,
    videoCodec: info.videoCodec,
    ...(info.audio ? { audio: info.audio } : {}),
  };
}

export async function normalizeAtomic(input: string, output: OutputSettings, destAbs: string): Promise<void> {
  await mkdir(dirname(destAbs), { recursive: true });
  const tmp = `${destAbs}.viscraft-norm-${process.pid}-${Date.now().toString(36)}.mp4`;
  try {
    await normalizeMedia(input, output, tmp);
    await rename(tmp, destAbs);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

export async function materializeFromLocal(
  job: LocalVideoMedia,
  rootAbs: string,
  destAbs: string,
): Promise<{ sha256: string; media: MediaInfo } | null> {
  const artifactMatchesOutput =
    job.artifactOutput !== undefined && stableHash(job.artifactOutput) === stableHash(job.output);
  if (artifactMatchesOutput && job.artifactSha256 && job.artifactPath) {
    try {
      const abs = await resolveProjectPath(rootAbs, job.artifactPath);
      if (existsSync(abs) && (await hashFile(abs)) === job.artifactSha256) {
        const info = await probeMedia(abs);
        if (info.frames > 0) {
          await installFile(abs, destAbs);
          return { sha256: job.artifactSha256, media: pickMedia(info) };
        }
      }
    } catch {
      // fall through to the original-media path
    }
  }
  if (job.originalMediaSha256 && job.originalMediaPath) {
    try {
      const abs = await resolveProjectPath(rootAbs, job.originalMediaPath);
      if (existsSync(abs) && (await hashFile(abs)) === job.originalMediaSha256) {
        await normalizeAtomic(abs, job.output, destAbs);
        const info = await probeMedia(destAbs);
        if (info.frames > 0) return { sha256: await hashFile(destAbs), media: pickMedia(info) };
      }
    } catch {
      // fall through to the remote resume
    }
  }
  return null;
}
