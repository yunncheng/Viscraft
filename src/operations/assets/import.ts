/** Admit approved local material from host tools without adding a model runner. */
import { constants } from 'node:fs';
import { copyFile, mkdir, open, readFile, realpath, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { AssetSchema, Id, ImageGenerationSchema, RightsSchema, type Asset, type Project } from '../../core/schema.js';
import { acquireLock, loadProject, validateProject } from '../../project/project.js';
import { readBuilds } from '../../project/build-records.js';
import { assertAuthoredPath } from '../../project/authored-path.js';
import { atomicJson, resolveProjectPath } from '../../shared/fs.js';
import { hashFile } from '../../shared/hash.js';
import { runCommand } from '../../shared/process.js';

const OptionsSchema = z
  .object({
    assetId: Id,
    sourcePath: z
      .string()
      .min(1)
      .refine(
        value => path.isAbsolute(value) && !value.includes('\0'),
        'sourcePath must be an absolute local file path',
      ),
    type: AssetSchema.shape.type,
    rights: RightsSchema,
    expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    expectedSha256: AssetSchema.shape.sha256.optional(),
    simulated: z.boolean().default(false),
    inputs: z
      .array(
        z
          .object({
            asset: Id,
            role: z.string().trim().min(1).max(1000),
            // The FROZEN parent identity read and transmitted at production time.
            // When given, the current parent must still hold exactly this
            // revision and these bytes; a concurrent edit or a recovery must not
            // silently rebind the child to a new parent. Both must be present or
            // both absent — a half identity cannot prove anything.
            revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
            sha256: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
          })
          .strict()
          .refine(
            value => (value.revision === undefined) === (value.sha256 === undefined),
            'A frozen production input must give both revision and sha256, or neither',
          ),
      )
      .min(1)
      .optional(),
    // Hash-only generated-image provenance to persist on the registered Asset
    // (see `schema.ts` `ImageGenerationSchema`/`assertAssetImageGeneration`).
    // It must be internally consistent with the imported bytes and the recorded
    // production inputs; `validateProject` re-verifies it on every load.
    imageGeneration: ImageGenerationSchema.optional(),
  })
  .strict();
export type ImportAssetOptions = z.input<typeof OptionsSchema>;

export interface AssetInputStatus {
  asset: string;
  input: string;
  role: string;
  status: 'current' | 'changed' | 'missing';
  expected: { revision: number; sha256: string };
  current?: { revision: number; sha256: string };
}

/** Report changed production inputs; never regenerate or invalidate accepted media. */
export function inspectAssetInputs(project: Project): AssetInputStatus[] {
  const assets = new Map(project.assets.map(asset => [asset.id, asset]));
  return project.assets.flatMap(asset =>
    (asset.inputs ?? []).map(input => {
      const parent = assets.get(input.asset);
      return {
        asset: asset.id,
        input: input.asset,
        role: input.role,
        status: !parent
          ? 'missing'
          : parent.revision === input.revision && parent.sha256 === input.sha256
            ? 'current'
            : 'changed',
        expected: { revision: input.revision, sha256: input.sha256 },
        ...(parent ? { current: { revision: parent.revision, sha256: parent.sha256 } } : {}),
      };
    }),
  );
}

const EXTENSIONS: Record<Asset['type'], readonly string[]> = {
  image: ['.png', '.jpg', '.jpeg', '.webp'],
  video: ['.mp4', '.mov', '.webm', '.mkv'],
  audio: ['.wav', '.mp3', '.aac', '.m4a', '.flac', '.ogg'],
  font: ['.ttf', '.otf', '.woff', '.woff2'],
  code: ['.html', '.js', '.mjs', '.ts', '.svg', '.json'],
  // The one real 3D model format family (glTF 2.x). `.glb` is a self-contained
  // binary container; `.gltf` is JSON whose external resources must be declared.
  // No placeholders for other 3D formats.
  model: ['.glb', '.gltf'],
};

async function validateMedia(file: string, type: Asset['type']): Promise<void> {
  if (type === 'font' || type === 'code') return; // Copy only; no execution or validity claim.
  if (type === 'image') {
    const handle = await open(file, 'r');
    try {
      const prefix = Buffer.alloc(12);
      const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
      const png = bytesRead >= 8 && prefix.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
      const jpeg = bytesRead >= 3 && prefix.subarray(0, 3).toString('hex') === 'ffd8ff';
      const webp =
        bytesRead === 12 && prefix.toString('ascii', 0, 4) === 'RIFF' && prefix.toString('ascii', 8, 12) === 'WEBP';
      const extension = path.extname(file);
      if (!(extension === '.png' ? png : extension === '.webp' ? webp : jpeg))
        throw new Error('Image extension does not match PNG/JPEG/WebP bytes');
    } finally {
      await handle.close();
    }
  }
  const streams = JSON.parse(
    await runCommand('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,width,height',
      '-of',
      'json',
      file,
    ]),
  ) as { streams?: Array<{ codec_type: string; width?: number; height?: number }> };
  const video = streams.streams?.find(stream => stream.codec_type === 'video');
  if (
    type === 'audio' ? !streams.streams?.some(stream => stream.codec_type === 'audio') : !video?.width || !video.height
  ) {
    throw new Error(`Imported ${type} has no usable ${type === 'audio' ? 'audio' : 'picture'} stream`);
  }
  // A header/probe alone does not establish decoding. Inspect an actual bounded
  // sample; full-duration decode and artistic suitability remain production QA.
  await runCommand('ffmpeg', [
    '-hide_banner',
    '-nostdin',
    '-v',
    'error',
    '-xerror',
    '-threads',
    '2',
    '-filter_threads',
    '1',
    '-i',
    file,
    ...(type === 'audio' ? ['-map', '0:a:0', '-t', '0.1'] : ['-map', '0:v:0', '-frames:v', '1', '-an']),
    '-f',
    'null',
    '-',
  ]);
}

/**
 * The Project-relative path one external glTF image URI refers to, or a loud
 * failure when the URI cannot name a portable in-Project file.
 *
 * glTF URIs are URI references, not host paths: the path part is percent-decoded
 * and a `?query`/`#fragment` suffix is not part of the file name. An absolute
 * or protocol-relative URL is a remote resource — it is not part of the author
 * closure, cannot be hashed, and would silently change under the Project — so it
 * is refused rather than fetched. A `..` segment is legal when it stays inside
 * the Project (`textures/../shared/a.png`), and refused when it climbs above the
 * Project root. Nothing here rewrites the URI or the author's directory layout:
 * the resolved path must simply be where the declared image Asset actually lives.
 */
function resolveGltfImageUri(uri: string, modelPath: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(uri) || uri.startsWith('//'))
    throw new Error(
      `glTF model references external image "${uri}"; a remote URL is not part of the Project closure — embed the image (or a data URI), or import it and reference it by a relative path`,
    );
  const pathPart = uri.split('#')[0].split('?')[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    throw new Error(`glTF model references external image "${uri}" with invalid percent-encoding`);
  }
  if (decoded.length === 0) throw new Error(`glTF model references external image "${uri}" that names no file`);
  if (decoded.includes('\\') || decoded.startsWith('/'))
    throw new Error(
      `glTF model references external image "${uri}"; use a relative URI with "/" separators inside the Project`,
    );
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(modelPath), decoded));
  if (resolved === '.' || resolved === '..' || resolved.startsWith('../'))
    throw new Error(
      `glTF model references external image "${uri}" which resolves to "${resolved}", outside the Project root; import the image inside the Project and keep the model's own relative layout`,
    );
  return resolved;
}

/**
 * Structural validation for a glTF 2.x model. There is no ffmpeg decode for 3D
 * content, so this reads and parses the whole document and refuses an empty or
 * foreign model. A `.glb` binary container (magic / version / declared length /
 * JSON chunk) is checked before its JSON is trusted.
 *
 * Resources: a `.glb` normally embeds everything. Buffers must always be
 * embedded (there is no raw `.bin` Asset type), so an external glTF buffer is a
 * loud failure. External IMAGES are allowed only when the URI resolves (against
 * the model's own Project-relative location) to a declared production input
 * Asset's `path`. That keeps the texture's bytes, hash and rights tracked like
 * any other Asset and turns a missing/undeclared texture into a loud failure
 * instead of a grey render. The Asset id is unrelated to the file name: two
 * same-named textures in different directories are told apart by their resolved
 * paths, and any id is accepted.
 */
function validateModelDocument(
  bytes: Buffer,
  extension: string,
  modelPath: string,
  inputs: readonly { asset: string; path: string }[],
): void {
  const document = readGltfJson(bytes, extension);
  const asset = document.asset;
  const version = asset && typeof asset === 'object' ? (asset as { version?: unknown }).version : undefined;
  if (typeof version !== 'string' || !/^2\./.test(version))
    throw new Error(`glTF model must declare asset.version "2.x", found ${JSON.stringify(version)}`);
  const meshes = document.meshes;
  if (!Array.isArray(meshes) || meshes.length === 0)
    throw new Error('glTF model declares no meshes; refusing an empty or non-model file');
  const externalBuffers = externalResourceUris(document, 'buffers');
  if (externalBuffers.length > 0)
    throw new Error(
      `glTF model references an external buffer "${externalBuffers[0]}"; embed buffers as data URIs (or use a self-contained .glb) so the model is portable`,
    );
  const byPath = new Map(inputs.map(input => [input.path, input.asset] as const));
  for (const uri of externalResourceUris(document, 'images')) {
    const target = resolveGltfImageUri(uri, modelPath);
    if (byPath.has(target)) continue;
    const declared = inputs.length
      ? ` Declared production inputs: ${inputs.map(input => `"${input.path}" (${input.asset})`).join(', ')}.`
      : ' No production inputs were declared.';
    throw new Error(
      `glTF model references external image "${uri}" which resolves to "${target}" inside the Project, ` +
        `but no production input Asset lives at that path. Declare the image Asset at "${target}" (any id) ` +
        `so its bytes, hash and rights are tracked.${declared}`,
    );
  }
}

/** Parse the JSON chunk of a `.glb` container, or the JSON text of a `.gltf`. */
function readGltfJson(bytes: Buffer, extension: string): Record<string, unknown> {
  if (extension === '.glb') {
    if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'glTF')
      throw new Error('glTF binary (.glb) must start with the "glTF" magic');
    if (bytes.readUInt32LE(4) !== 2)
      throw new Error(`glTF binary (.glb) version must be 2, found ${bytes.readUInt32LE(4)}`);
    const declared = bytes.readUInt32LE(8);
    if (declared !== bytes.length)
      throw new Error(`glTF binary (.glb) declares ${declared} bytes but the file is ${bytes.length} bytes`);
    if (bytes.readUInt32LE(16) !== 0x4e4f534a) throw new Error('glTF binary (.glb) first chunk must be the JSON chunk');
    const chunkLength = bytes.readUInt32LE(12);
    if (20 + chunkLength > bytes.length)
      throw new Error('glTF binary (.glb) JSON chunk length runs past the end of the file');
    try {
      return JSON.parse(bytes.toString('utf8', 20, 20 + chunkLength)) as Record<string, unknown>;
    } catch {
      throw new Error('glTF binary (.glb) JSON chunk is not valid JSON');
    }
  }
  try {
    return JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('glTF (.gltf) is not valid JSON');
  }
}

function externalResourceUris(document: Record<string, unknown>, key: 'images' | 'buffers'): string[] {
  const list = document[key];
  if (!Array.isArray(list)) return [];
  const uris: string[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const uri = (entry as { uri?: unknown }).uri;
    if (typeof uri === 'string' && uri.length > 0 && !uri.startsWith('data:')) uris.push(uri);
  }
  return uris;
}

/**
 * The project-relative path of an existing local file, or `undefined` when the
 * file is outside the Project root. `realpath` resolves every symlink in both
 * paths, so a link (or a parent directory link) that escapes the root reports
 * `undefined` and is treated as an external host file rather than registered in
 * place.
 */
async function projectRelativePath(root: string, sourcePath: string): Promise<string | undefined> {
  let rootReal: string;
  let sourceReal: string;
  try {
    [rootReal, sourceReal] = await Promise.all([realpath(root), realpath(sourcePath)]);
  } catch {
    return undefined;
  }
  const relative = path.relative(rootReal, sourceReal);
  if (relative === '' || path.isAbsolute(relative) || relative.split(path.sep)[0] === '..') return undefined;
  return relative.split(path.sep).join('/');
}

/**
 * Where the new Asset's bytes should live, without copying when the bytes are
 * already inside the Project:
 *
 *  - the same `sha256` already registered by another Asset reuses that physical
 *    copy, so a second identity for identical bytes never duplicates media;
 *  - a regular file already inside the root (a host tool writing into the
 *    author area) is registered at its own project-relative path;
 *  - a file outside the root (tool cache, download dir) is copied to the
 *    content-addressed `assets/` path exactly as before.
 *
 * `output/`, `.viscraft/` and credential files are refused in place rather than
 * silently promoted into the author closure (see `assertAuthoredPath`); importing
 * such a file means copying it to an authored path.
 */
async function assetPathFor(
  root: string,
  project: Project,
  assetId: string,
  sourcePath: string,
  sha256: string,
  extension: string,
): Promise<string> {
  const previous = project.assets.find(asset => asset.sha256 === sha256);
  if (previous) {
    try {
      if ((await hashFile(await resolveProjectPath(root, previous.path))) === sha256) return previous.path;
    } catch {
      // A missing, moved or symlinked registered copy is not reusable; fall
      // through to a fresh path instead of aborting on an unrelated file.
    }
  }
  const relative =
    (await projectRelativePath(root, sourcePath)) ?? `assets/${assetId}-${sha256.slice(0, 16)}${extension}`;
  // One authored-path policy shared with delivery/export: reject a runtime
  // `.viscraft/` path, an `output/` path or a credential filename here, at
  // registration, instead of letting a later export refuse the Asset.
  assertAuthoredPath(relative, `Asset ${assetId}`);
  return relative;
}

/**
 * Atomic authoring operation: import a new immutable Asset identity and freeze
 * the supplied Project input versions. Source files and existing Assets stay
 * untouched. Calling this asserts approval to use these bytes and stated rights;
 * it does not authorize generation, uploading, or approval of their appearance.
 */
export async function importAsset(root: string, options: ImportAssetOptions): Promise<Asset> {
  const parsed = OptionsSchema.parse(options);
  const extension = path.extname(parsed.sourcePath).toLowerCase();
  if (!EXTENSIONS[parsed.type].includes(extension))
    throw new Error(`Unsupported ${parsed.type} file extension ${extension}`);
  const release = await acquireLock(root, 'author');
  let scratch: string | undefined, created: string | undefined;
  try {
    const project = await loadProject(root);
    if (project.revision !== parsed.expectedRevision)
      throw new Error(`Source revision conflict: expected ${parsed.expectedRevision}, found ${project.revision}`);
    if (project.revision === Number.MAX_SAFE_INTEGER) throw new Error('Project revision exceeds safe integer range');
    if (project.assets.some(asset => asset.id === parsed.assetId))
      throw new Error(`Asset ${parsed.assetId} already exists; import a new variant id`);
    const parents = new Set<string>();
    const inputs: NonNullable<Asset['inputs']> = [];
    for (const input of parsed.inputs ?? []) {
      const parent = project.assets.find(asset => asset.id === input.asset);
      if (!parent || parents.has(input.asset))
        throw new Error(`Import requires unique existing production inputs (${input.asset})`);
      const parentAbs = await resolveProjectPath(root, parent.path);
      if ((await hashFile(parentAbs)) !== parent.sha256)
        throw new Error(`Production input hash mismatch for ${parent.id}`);
      // A frozen (generation-time) identity must match the parent EXACTLY: the
      // same revision and the same bytes actually read. A concurrent edit that
      // changed either is a refusal, not a silent rebind to the new parent.
      if (input.revision !== undefined && (parent.revision !== input.revision || parent.sha256 !== input.sha256))
        throw new Error(
          `Production input ${parent.id} is revision ${parent.revision}/${parent.sha256.slice(0, 12)}… but the child was produced from revision ${input.revision}/${input.sha256!.slice(0, 12)}…; refusing to rebind the child to a changed parent`,
        );
      parents.add(parent.id);
      inputs.push({ asset: parent.id, revision: parent.revision, sha256: parent.sha256, role: input.role });
    }
    const info = await stat(parsed.sourcePath);
    if (!info.isFile() || !info.size) throw new Error('Import requires a nonempty regular file');
    const before = await hashFile(parsed.sourcePath);
    if (parsed.expectedSha256 && before !== parsed.expectedSha256)
      throw new Error('Imported material does not match expectedSha256');
    scratch = await resolveProjectPath(root, `.viscraft/scratch/import-${randomUUID()}`);
    await mkdir(scratch, { recursive: true });
    const staged = path.join(scratch, `material${extension}`);
    await copyFile(parsed.sourcePath, staged, constants.COPYFILE_EXCL);
    if ((await stat(staged)).size !== info.size) throw new Error('Imported material size changed during staging');
    const sha256 = await hashFile(staged);
    if (sha256 !== before || (await hashFile(parsed.sourcePath)) !== before)
      throw new Error('Imported material changed during staging');
    const relative = await assetPathFor(root, project, parsed.assetId, parsed.sourcePath, sha256, extension);
    if (parsed.type === 'model')
      validateModelDocument(
        await readFile(staged),
        extension,
        relative,
        inputs.map(input => ({
          asset: input.asset,
          path: project.assets.find(asset => asset.id === input.asset)!.path,
        })),
      );
    else await validateMedia(staged, parsed.type);
    const history = await readBuilds(root);
    const lineageHashes = new Set([sha256, ...inputs.map(input => input.sha256)]);
    const simulated =
      parsed.simulated ||
      project.assets.some(asset => asset.simulated && (asset.sha256 === sha256 || parents.has(asset.id))) ||
      history.some(build => build.artifacts.some(artifact => artifact.simulated && lineageHashes.has(artifact.sha256)));
    const destination = await resolveProjectPath(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      await copyFile(staged, destination, constants.COPYFILE_EXCL);
      created = destination;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if ((await hashFile(destination)) !== sha256) throw new Error(`Refusing to overwrite ${relative}`);
    }
    if ((await hashFile(destination)) !== sha256) throw new Error('Imported Asset changed before commit');
    for (const input of inputs) {
      const parent = project.assets.find(asset => asset.id === input.asset)!;
      if ((await hashFile(await resolveProjectPath(root, parent.path))) !== input.sha256)
        throw new Error(`Production input ${parent.id} changed before commit`);
    }
    const asset = AssetSchema.parse({
      id: parsed.assetId,
      revision: 1,
      path: relative,
      sha256,
      type: parsed.type,
      rights: parsed.rights,
      simulated,
      ...(inputs.length ? { inputs } : {}),
      ...(parsed.imageGeneration ? { imageGeneration: parsed.imageGeneration } : {}),
    });
    await atomicJson(
      await resolveProjectPath(root, 'project.json'),
      validateProject({ ...project, revision: project.revision + 1, assets: [...project.assets, asset] }),
    );
    created = undefined;
    return asset;
  } finally {
    if (created) await rm(created, { force: true }).catch(() => {});
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
    await release();
  }
}
