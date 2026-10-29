/**
 * One authoring boundary (project layer).
 *
 * A recipe produces a Project draft plus the exact bytes of every authored file
 * it wants the new Project to contain. `authorProject` publishes that into a
 * NEW directory: it validates every declaration and explicit byte pin BEFORE
 * writing, copies the bytes with exclusive creates, derives the missing Asset
 * hashes (and the initial revision), verifies the copied bytes and the complete
 * Project, and commits `project.json` last.
 *
 * The draft is ordinary current Project content with one TypeScript input
 * convenience: an Asset may omit `sha256` (derived from its authored bytes) and
 * `revision` (always the initial 1 here). Supplied values are ASSERTIONS: they
 * are checked, never silently rewritten. In particular the frozen parent
 * identities in `Asset.inputs` are preserved verbatim and must agree with the
 * authored parent identities, so a caller cannot register a child against a
 * parent version it did not author.
 *
 * Creation performs no Build, image render, provider submission or network
 * access. It never registers an authored file implicitly: a file that is not
 * declared as an Asset stays an editable, unregistered author file.
 */
import { link, lstat, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { RelativePath, type Asset, type Project } from '../core/schema.js';
import { acquireLock, assertAuthoredProjectPaths, validateProject } from './project.js';
import { assertAuthoredPath } from './authored-path.js';
import { resolveProjectPath } from '../shared/fs.js';
import { hashFile } from '../shared/hash.js';

/** An Asset draft: the Runtime derives the bytes hash and the initial revision. */
export type AuthorAsset = Omit<Asset, 'sha256' | 'revision'> & { sha256?: string; revision?: number };

/** A Project draft whose Asset identities may still be incomplete. */
export type AuthorProject = Omit<Project, 'assets'> & { assets: AuthorAsset[] };

/**
 * One authored file: its exact Project-relative destination plus EXACTLY one
 * input representation — an absolute `sourcePath` for an existing local file, or
 * generated `bytes` — and an optional pin on the bytes actually published.
 */
export interface AuthorFile {
  path: string;
  sourcePath?: string;
  bytes?: Uint8Array | string;
  expectedSha256?: string;
}

interface PreparedFile {
  path: string;
  bytes: Buffer;
  sha256: string;
}

const FILE_KEYS = new Set(['path', 'sourcePath', 'bytes', 'expectedSha256']);
const SHA256 = /^[a-f0-9]{64}$/;

function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Read every declaration ONCE into an independent byte copy, validating the
 * destination path, the single-source shape, duplicate/prefix collisions and
 * the explicit byte pin. Nothing has been written yet, so a bad declaration or
 * a tampered pin cannot leave a partial Project behind.
 */
async function prepareFiles(files: readonly AuthorFile[]): Promise<PreparedFile[]> {
  if (!Array.isArray(files)) throw new Error('authorProject requires a files array');
  const prepared: PreparedFile[] = [];
  const seen = new Set<string>();
  for (const [index, file] of files.entries()) {
    if (!file || typeof file !== 'object' || Array.isArray(file))
      throw new Error(`Author file ${index} must be an object`);
    for (const key of Object.keys(file))
      if (!FILE_KEYS.has(key)) throw new Error(`Author file ${index} has an unknown field "${key}"`);
    if (typeof file.path !== 'string') throw new Error(`Author file ${index} requires a string path`);
    const relative = RelativePath.parse(file.path);
    assertAuthoredPath(relative, `Author file ${relative}`);
    if (relative.toLowerCase() === 'project.json' || relative.toLowerCase().startsWith('project.json/'))
      throw new Error('project.json is written by the Runtime, not declared as an authored file');
    if (seen.has(relative)) throw new Error(`Duplicate authored file path ${relative}`);
    // A declared file that is also a directory of another declaration cannot be
    // written as both; reject it before touching the destination.
    for (const other of seen)
      if (other.startsWith(`${relative}/`) || relative.startsWith(`${other}/`))
        throw new Error(`Authored file path ${relative} collides with ${other}`);
    seen.add(relative);

    const hasSource = file.sourcePath !== undefined;
    const hasBytes = file.bytes !== undefined;
    if (hasSource === hasBytes) throw new Error(`Author file ${relative} must give exactly one of sourcePath or bytes`);
    let bytes: Buffer;
    if (hasSource) {
      const sourcePath = file.sourcePath!;
      if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath) || sourcePath.includes('\0'))
        throw new Error(`Author file ${relative} sourcePath must be an absolute local file path`);
      const info = await stat(sourcePath).catch(() => undefined);
      if (!info?.isFile()) throw new Error(`Author file ${relative} sourcePath is not a regular file: ${sourcePath}`);
      bytes = await readFile(sourcePath);
    } else if (typeof file.bytes === 'string') {
      bytes = Buffer.from(file.bytes, 'utf8');
    } else if (file.bytes instanceof Uint8Array) {
      bytes = Buffer.from(file.bytes);
    } else {
      throw new Error(`Author file ${relative} bytes must be a Uint8Array or a string`);
    }
    const sha256 = sha256Of(bytes);
    if (file.expectedSha256 !== undefined) {
      if (typeof file.expectedSha256 !== 'string' || !SHA256.test(file.expectedSha256))
        throw new Error(`Author file ${relative} expectedSha256 must be a lowercase sha256 digest`);
      if (sha256 !== file.expectedSha256) throw new Error(`Author file ${relative} does not match its expectedSha256`);
    }
    prepared.push({ path: relative, bytes, sha256 });
  }
  return prepared;
}

/**
 * Assemble the current Asset records from the draft and the bytes actually
 * prepared. Missing hashes/revisions are derived; supplied ones are assertions.
 * Frozen parent identities in `inputs` are checked against the assembled
 * identities and left exactly as declared.
 */
function assembleAssets(draft: readonly AuthorAsset[], files: Map<string, PreparedFile>): Asset[] {
  const assets: Asset[] = [];
  const ids = new Set<string>();
  for (const asset of draft) {
    if (!asset || typeof asset !== 'object') throw new Error('Every authored Asset must be an object');
    if (typeof asset.id !== 'string' || asset.id.length === 0) throw new Error('Every authored Asset requires an id');
    if (ids.has(asset.id)) throw new Error(`Duplicate authored Asset id ${asset.id}`);
    ids.add(asset.id);
    if (typeof asset.path !== 'string')
      throw new Error(`Authored Asset ${asset.id} requires a declarative Project-relative path`);
    const file = files.get(asset.path);
    if (!file)
      throw new Error(
        `Authored Asset ${asset.id} path ${asset.path} is not declared in files; declare its bytes instead of referencing an unwritten file`,
      );
    if (asset.sha256 !== undefined && asset.sha256 !== file.sha256)
      throw new Error(`Authored Asset ${asset.id} sha256 does not match its authored bytes`);
    if (asset.revision !== undefined && asset.revision !== 1)
      throw new Error(`Authored Asset ${asset.id} must start at revision 1; got ${asset.revision}`);
    assets.push({ ...asset, sha256: file.sha256, revision: 1 });
  }
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  for (const asset of assets)
    for (const input of asset.inputs ?? []) {
      const parent = byId.get(input.asset);
      if (!parent)
        throw new Error(`Authored Asset ${asset.id} requires a production input that is not part of this Project`);
      if (parent.revision !== input.revision || parent.sha256 !== input.sha256)
        throw new Error(
          `Authored Asset ${asset.id} freezes parent ${parent.id} at revision ${input.revision}/${input.sha256.slice(
            0,
            12,
          )}… but the authored parent is revision ${parent.revision}/${parent.sha256.slice(
            0,
            12,
          )}…; refusing to rewrite a frozen parent identity`,
        );
    }
  return assets;
}

/** Every project-relative path the current Project expects to find authored. */
function referencedPaths(project: Project): Set<string> {
  const paths = new Set<string>();
  for (const asset of project.assets) paths.add(asset.path);
  for (const source of project.sources) {
    if ('entry' in source && typeof source.entry === 'string') paths.add(source.entry);
    if ('resources' in source && Array.isArray(source.resources))
      for (const resource of source.resources) paths.add(resource);
    if ('recording' in source && typeof source.recording === 'string') paths.add(source.recording);
  }
  for (const document of project.imageDocuments) {
    paths.add(document.path);
    for (const resource of document.resources) paths.add(resource);
  }
  for (const file of project.handoff ?? []) paths.add(file.path);
  return paths;
}

/** Create the destination, refusing anything that already exists (including a symlink). */
async function createDestination(root: string): Promise<string> {
  if (typeof root !== 'string' || root.length === 0 || root.includes('\0'))
    throw new Error('authorProject requires a non-empty destination directory');
  const absolute = path.resolve(root);
  const existing = await lstat(absolute).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing)
    throw new Error(`Refusing to author into existing ${absolute}; authorProject creates a new directory only`);
  await mkdir(absolute);
  return absolute;
}

/**
 * Commit `project.json` with an EXCLUSIVE create. The Runtime writes a private
 * temporary file beside it and hard-links that inode into place: `link(2)`
 * fails with EEXIST when anything (file or directory) already exists at the
 * destination, so a concurrent/unexpected `project.json` is never replaced.
 * This mirrors the lock's create-if-absent pattern; it is not content-addressed
 * hardlink deduplication.
 */
async function commitProjectJson(file: string, project: Project): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(project, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    try {
      await link(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error(`Refusing to overwrite an unexpected project.json that appeared during publication: ${file}`);
      throw error;
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

/**
 * Publish a new Project from a recipe's draft and file declarations.
 *
 * The destination must not exist yet. One author lock is held for the whole
 * publication; every file is written exclusively, verified byte-for-byte, and
 * `project.json` is committed atomically LAST. A failure after the destination
 * was created is reported and leaves the incomplete directory in place — this
 * function never recursively deletes content it is not certain about and never
 * reports a Project that was not committed.
 */
export async function authorProject(
  root: string,
  input: { project: AuthorProject; files: AuthorFile[] },
): Promise<Project> {
  if (!input || typeof input !== 'object') throw new Error('authorProject requires { project, files }');
  if (!input.project || typeof input.project !== 'object' || Array.isArray(input.project))
    throw new Error('authorProject requires a Project draft object');
  if (!Array.isArray(input.project.assets))
    throw new Error('authorProject requires the Project draft to declare an assets array');
  const prepared = await prepareFiles(input.files);
  const files = new Map(prepared.map(file => [file.path, file]));
  const project = validateProject({ ...input.project, assets: assembleAssets(input.project.assets, files) });
  assertAuthoredProjectPaths(project);
  for (const relative of referencedPaths(project))
    if (!files.has(relative))
      throw new Error(
        `Project content references ${relative}, which is not declared in files; declare every authored path before publishing`,
      );

  const destination = await createDestination(root);
  const release = await acquireLock(destination, 'author');
  try {
    for (const file of prepared) {
      const target = await resolveProjectPath(destination, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.bytes, { flag: 'wx', mode: 0o644 });
    }
    // Verify the complete authored byte closure before the Project is committed;
    // a missing or altered file must not become a "successful" Project.
    for (const file of prepared) {
      const target = await resolveProjectPath(destination, file.path);
      if ((await hashFile(target)) !== file.sha256)
        throw new Error(`Authored file ${file.path} did not keep its declared bytes before commit`);
    }
    await commitProjectJson(await resolveProjectPath(destination, 'project.json'), project);
    return project;
  } finally {
    await release();
  }
}
