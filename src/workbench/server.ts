/**
 * On-demand local workbench service.
 *
 * The workbench is an editing surface for ONE registered image document. This
 * server is started only while someone is editing; it is not a permanent
 * studio, and it never becomes a second authority:
 *
 *  - the document, its resources and its targets are resolved FROM `project.json`
 *    (an id, never a path or command from the page);
 *  - reads/writes are bound to loopback and require a per-session token (plus a
 *    same-origin check), so an unrelated page cannot drive the Project;
 *  - a save checks the base content hash AND the document revision while holding
 *    the Project's `author` lock, writes the source, and commits the Project
 *    revision in that same boundary; a mismatch is a 409 conflict and never
 *    overwrites newer bytes, and a failed commit restores the original bytes;
 *  - a render calls the SAME `renderImage` production path the CLI/SDK use, after
 *    requiring a saved source; it never screenshots the editor page.
 *  - an OPTIONAL Runtime delivery binding (`--delivery <output-entry>`) makes the
 *    edited Project's already-delivered still update in place: the binding is
 *    verified at startup (record + manifest + bundle identity + the delivered
 *    bytes), each render publishes the EXACT Build it produced back into that
 *    same bundle, and the output/download URL serves the delivered file —
 *    verified again — instead of a second "current" copy. Only the entry name is
 *    retained; every request re-reads the currently published facts, and a bundle
 *    that stops verifying is reported BLOCKED (with the real reason) rather than
 *    served or silently replaced. Without a binding this server stays a pure
 *    authoring surface over immutable artifacts.
 *
 * The page assets ship with the Runtime (`src/workbench/ui/`), copied beside
 * this module during build. The service does not read the host Skill tree.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImageDocument, ImageTarget, Project } from '../core/schema.js';
import { imageRenderKey, renderImage, type ImageRenderResult } from '../build/image.js';
import { inspectImageDelivery, updateImageDelivery } from '../operations/delivery/image-delivery.js';
import {
  type ImageDeliveryInspection,
  type ImageDeliveryUpdateResult,
} from '../operations/delivery/delivery-contract.js';
import { readBuild, readBuilds } from '../project/build-records.js';
import { updateCodeAssetsForPath } from '../project/code-assets.js';
import { loadProject, withAuthorLock } from '../project/project.js';
import { OUTPUT_DIR, readDeliveryRecord } from '../project/output.js';
import { resolveProjectPath } from '../shared/fs.js';
import { hashFile } from '../shared/hash.js';

/** The one manifest file a delivery bundle publishes (a stable Runtime name). */
const DELIVERY_MANIFEST = 'delivery-manifest.json';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Runtime-owned static UI, adjacent to the compiled server. */
const ASSETS = path.join(HERE, 'ui');
const MAX_SAVE_BYTES = 10 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

export interface WorkbenchOptions {
  /** Document id; required when the Project has more than one. */
  document?: string;
  /** Target id; required when the document has more than one target. */
  target?: string;
  /** 0 (default) picks an ephemeral port. */
  port?: number;
  /**
   * Name of a recorded Runtime delivery under `<root>/output/` (the same entry
   * the CLI/`deliver` created). When set, renders publish this target's still
   * back into that existing bundle instead of only producing an Artifact.
   * Only a record name is accepted — never a filesystem path.
   */
  delivery?: string;
}

/**
 * The delivered still this workbench is bound to. `path` is the stable
 * project-relative product (`output/<entry>/image/<target>.<ext>`): it is what
 * the page and the download show, and it does not move when the same target is
 * re-rendered in the same format.
 */
export interface WorkbenchDelivery {
  entry: string;
  path: string;
  /** The Build whose pixels the bundle currently carries. */
  build: string;
  artifact: string;
  format: ImageTarget['format'];
  width: number;
  height: number;
  sha256: string;
  bytes: number;
  simulated: boolean;
  /** The delivered pixels no longer match the CURRENT saved author source. */
  stale: boolean;
  /**
   * False when the delivered bundle could be read at startup but no longer
   * verifies (edited product, replaced/removed record, failed re-inspection).
   * `blocked` then carries the real reason; the page may keep authoring but
   * must not present those bytes as the current delivered product.
   */
  verified: boolean;
  blocked: string | null;
}

export interface WorkbenchServer {
  /** The URL to open, including the session token. */
  url: string;
  token: string;
  port: number;
  document: string;
  target: string;
  /** Present only when the server was started with a verified `delivery`. */
  delivery?: WorkbenchDelivery;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A save whose base bytes/revision no longer match the saved document. */
class SourceConflict extends Error {
  constructor(readonly current: { revision: number; contentHash: string }) {
    super('the saved source changed since this page read it');
    this.name = 'SourceConflict';
  }
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Replace a file through one rename, leaving no temporary file behind. */
async function replaceFile(absolute: string, bytes: Buffer): Promise<void> {
  const temporary = `${absolute}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o644 });
    await rename(temporary, absolute);
  } finally {
    // `force` ignores only a missing temp; a real cleanup failure is reported.
    await rm(temporary, { force: true });
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_SAVE_BYTES) throw new HttpError(413, `request body exceeds ${MAX_SAVE_BYTES} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function resolveDocument(project: Project, requested: string | undefined): ImageDocument {
  if (project.imageDocuments.length === 0) throw new HttpError(404, 'this Project declares no image documents');
  if (requested !== undefined) {
    const document = project.imageDocuments.find(candidate => candidate.id === requested);
    if (!document) throw new HttpError(404, `unknown image document "${requested}"`);
    return document;
  }
  if (project.imageDocuments.length > 1)
    throw new HttpError(
      400,
      `this Project declares several image documents (${project.imageDocuments.map(item => item.id).join(', ')}); pass --document`,
    );
  return project.imageDocuments[0];
}

function resolveTarget(project: Project, document: ImageDocument, requested: string | undefined): ImageTarget {
  const targets = project.imageTargets.filter(target => target.document === document.id);
  if (targets.length === 0) throw new HttpError(404, `image document "${document.id}" has no target`);
  if (requested !== undefined) {
    const target = targets.find(candidate => candidate.id === requested);
    if (!target) throw new HttpError(404, `unknown image target "${requested}" for document "${document.id}"`);
    return target;
  }
  if (targets.length > 1)
    throw new HttpError(
      400,
      `document "${document.id}" declares several targets (${targets.map(item => item.id).join(', ')}); pass --target`,
    );
  return targets[0];
}

/** The current document bytes + the Project it belongs to. One read of the
 * file supplies both the HTML and its hash, so a concurrent writer can never
 * make the reported hash describe bytes other than the ones served. */
async function readDocument(
  root: string,
  document: ImageDocument,
): Promise<{ project: Project; html: string; contentHash: string; revision: number }> {
  const project = await loadProject(root);
  const current = project.imageDocuments.find(candidate => candidate.id === document.id);
  if (!current) throw new HttpError(404, `image document "${document.id}" no longer exists`);
  const bytes = await readFile(await resolveProjectPath(root, current.path));
  return {
    project,
    html: bytes.toString('utf8'),
    contentHash: sha256(bytes),
    revision: current.revision,
  };
}

/** Whether a recorded render still describes the CURRENT saved bytes. */
async function renderIsStale(root: string, targetId: string, buildId: string): Promise<boolean> {
  try {
    const currentKey = await imageRenderKey(root, targetId);
    const build = await readBuild(root, buildId);
    const operation = build.operations.find(candidate => candidate.kind === 'render-image');
    return operation?.key !== currentKey;
  } catch {
    // The current bytes cannot be read (a missing resource): this result is
    // certainly not reproducible from them, so it is not current.
    return true;
  }
}

/**
 * The succeeded still recorded by ONE Build, or null when the record is gone,
 * does not describe this target, or its Artifact no longer matches its hash.
 * `stale` compares that Build's render key with the CURRENT saved bytes.
 */
async function resultOfBuild(
  root: string,
  target: ImageTarget,
  buildId: string,
): Promise<(ImageRenderResult & { url: string; stale: boolean }) | null> {
  let build;
  try {
    build = await readBuild(root, buildId);
  } catch {
    return null;
  }
  if (build.status !== 'succeeded' || build.target !== target.id) return null;
  const artifact = build.artifacts.find(candidate => candidate.id === build.result?.artifact);
  if (!artifact?.image) return null;
  try {
    if ((await hashFile(await resolveProjectPath(root, artifact.path))) !== artifact.sha256) return null;
  } catch {
    return null;
  }
  const operation = build.operations.find(candidate => candidate.kind === 'render-image');
  let currentKey: string | null = null;
  try {
    currentKey = await imageRenderKey(root, target.id);
  } catch {
    currentKey = null;
  }
  return {
    build: build.id,
    target: target.id,
    artifact: artifact.id,
    path: artifact.path,
    width: artifact.image.width,
    height: artifact.image.height,
    format: artifact.image.format,
    background: artifact.image.background,
    simulated: artifact.simulated,
    reused: false,
    stale: currentKey === null || operation?.key !== currentKey,
    url: `/api/output?target=${encodeURIComponent(target.id)}`,
  };
}

/**
 * The newest succeeded still that matches the CURRENT author bytes, else the
 * newest succeeded still from older bytes (still intact and downloadable, but
 * marked stale). Nothing here renders. Preferring the current one keeps this
 * view consistent with what `renderImage` would reuse after a source revert.
 *
 * When a delivery is bound, `preferredBuild` names the Build whose pixels the
 * delivered file carries: that is the user's actual product, so it is shown
 * even if a newer (unpublished) Artifact exists. `delivery.stale` reports the
 * divergence separately.
 */
async function latestResult(
  root: string,
  target: ImageTarget,
  preferredBuild?: string,
): Promise<(ImageRenderResult & { url: string; stale: boolean }) | null> {
  if (preferredBuild !== undefined) {
    const preferred = await resultOfBuild(root, target, preferredBuild);
    if (preferred) return preferred;
  }
  // What the CURRENT author bytes would produce. A recorded result made from
  // different bytes is STALE — the page must not present it as the current design.
  let currentKey: string | null = null;
  try {
    currentKey = await imageRenderKey(root, target.id);
  } catch {
    currentKey = null;
  }
  let newestStale: (ImageRenderResult & { url: string; stale: boolean }) | null = null;
  for (const build of await readBuilds(root)) {
    if (build.status !== 'succeeded' || build.target !== target.id) continue;
    const operation = build.operations.find(candidate => candidate.kind === 'render-image');
    const artifact = build.artifacts.find(candidate => candidate.id === build.result?.artifact);
    if (!artifact?.image) continue;
    const absolute = await resolveProjectPath(root, artifact.path);
    try {
      if ((await hashFile(absolute)) !== artifact.sha256) continue;
    } catch {
      continue;
    }
    // `readBuilds` is newest-first, so the first current result is the newest one.
    const result = {
      build: build.id,
      target: target.id,
      artifact: artifact.id,
      path: artifact.path,
      width: artifact.image.width,
      height: artifact.image.height,
      format: artifact.image.format,
      background: artifact.image.background,
      simulated: artifact.simulated,
      reused: false,
      stale: currentKey === null || operation?.key !== currentKey,
      url: `/api/output?target=${encodeURIComponent(target.id)}`,
    };
    if (!result.stale) return result;
    newestStale ??= result;
  }
  return newestStale;
}

/**
 * What this server retains about a verified delivery between requests. The
 * binding/result objects returned by the delivery module carry more (manifest,
 * materials, previous product…); the server only needs the identity and size of
 * the CURRENT delivered still plus its stable project path.
 */
interface DeliveryState {
  entry: string;
  /** Project-relative product path (`output/<entry>/image/<target>.<ext>`). */
  projectPath: string;
  build: string;
  artifact: string;
  format: ImageTarget['format'];
  width: number;
  height: number;
  sha256: string;
  bytes: number;
  simulated: boolean;
  stale: boolean;
  verified: boolean;
  blocked: string | null;
}

function deliveryStateOf(inspection: ImageDeliveryInspection): DeliveryState {
  return {
    entry: inspection.entry,
    projectPath: inspection.projectPath,
    build: inspection.build,
    artifact: inspection.artifact,
    format: inspection.format,
    width: inspection.width,
    height: inspection.height,
    sha256: inspection.sha256,
    bytes: inspection.bytes,
    simulated: Boolean(inspection.simulated),
    stale: inspection.stale,
    verified: inspection.verified,
    blocked: inspection.blocked ?? null,
  };
}

function deliveryStateOfUpdate(published: ImageDeliveryUpdateResult, stale: boolean): DeliveryState {
  // `published.bytes` is the whole bundle's physical size; `published.image` is
  // the updated still (top-level sha/format/width/height also describe it).
  return {
    entry: published.entry,
    projectPath: published.projectPath,
    build: published.build,
    artifact: published.artifact,
    format: published.format,
    width: published.width,
    height: published.height,
    sha256: published.sha256,
    bytes: published.image.bytes,
    simulated: Boolean(published.simulated),
    stale,
    verified: true,
    blocked: null,
  };
}

export async function serveWorkbench(root: string, options: WorkbenchOptions = {}): Promise<WorkbenchServer> {
  const project = await loadProject(root);
  const document = resolveDocument(project, options.document);
  const target = resolveTarget(project, document, options.target);
  // Verify the optional delivery binding BEFORE anything is served: the entry
  // must be a recorded Runtime delivery whose manifest, members, Project/target
  // identity and delivered bytes all agree with this authoring Project. A
  // failure to identify it is a real startup error. A PARSEABLE bundle that no
  // longer verifies still opens the page in a BLOCKED state, so pending author
  // edits are never lost and the reason is shown instead of a false binding.
  const deliveryEntry = options.delivery ?? null;
  let deliveryCache: { state: DeliveryState; manifestSha256: string } | null = null;
  if (deliveryEntry !== null) {
    const inspection = await inspectImageDelivery(root, { delivery: deliveryEntry, target: target.id });
    deliveryCache = { state: deliveryStateOf(inspection), manifestSha256: inspection.manifestSha256 };
  }
  // Monotonic version of the verified facts. A slow status refresh must never
  // overwrite the state a later publish just recorded.
  let deliveryVersion = 0;
  const token = randomBytes(24).toString('hex');
  let origin = '';

  const assertToken = (req: IncomingMessage, url: URL): void => {
    const header = req.headers['x-viscraft-token'];
    const provided = (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get('token') ?? '';
    if (provided !== token) throw new HttpError(401, 'missing or invalid session token');
  };
  const assertOrigin = (req: IncomingMessage): void => {
    const originHeader = req.headers.origin;
    if (originHeader !== undefined && originHeader !== origin)
      throw new HttpError(403, `cross-origin request from ${originHeader}`);
  };

  /** Report the last known delivered facts as untrustworthy, with the real reason. */
  const blockDelivery = (message: string): DeliveryState | null => {
    if (deliveryCache === null) return null;
    deliveryCache = { ...deliveryCache, state: { ...deliveryCache.state, verified: false, blocked: message } };
    return deliveryCache.state;
  };

  /**
   * Cheap check on every document/status request: the delivered still is not
   * frozen at startup, but a movie-bearing bundle is NOT fully re-hashed every
   * few seconds either. The Runtime record and the manifest's own representative
   * hash are read; while both are unchanged the last verified facts are reused
   * (only the delivered Build's staleness vs the current saved source is
   * recomputed). A changed manifest is a real re-delivery and triggers exactly
   * one full inspection. A record/manifest disagreement is reported as blocked.
   *
   * The manifest is read ONCE into bytes and hashed from those bytes. If the
   * full inspection then reports a different manifest hash, another writer
   * replaced the bundle during this request: the facts are not cached as a
   * pair (the old digest and new manifest would describe different files).
   */
  const refreshDelivery = async (): Promise<DeliveryState | null> => {
    if (deliveryEntry === null || deliveryCache === null) return null;
    const version = deliveryVersion;
    const record = await readDeliveryRecord(root, deliveryEntry);
    if (!record) return blockDelivery(`the Runtime no longer records ${OUTPUT_DIR}/${deliveryEntry}`);
    if (record.kind !== 'deliver')
      return blockDelivery(`${OUTPUT_DIR}/${deliveryEntry} is recorded as ${record.kind}, not a delivery bundle`);
    let manifestSha256: string;
    try {
      const bytes = await readFile(
        await resolveProjectPath(root, `${OUTPUT_DIR}/${deliveryEntry}/${DELIVERY_MANIFEST}`),
      );
      manifestSha256 = sha256(bytes);
    } catch {
      return blockDelivery(`the manifest of ${OUTPUT_DIR}/${deliveryEntry} is missing or unreadable`);
    }
    if (record.manifestSha256 === undefined || record.manifestSha256 !== manifestSha256)
      return blockDelivery(
        `the manifest of ${OUTPUT_DIR}/${deliveryEntry} no longer matches its Runtime record; it is left untouched`,
      );
    if (manifestSha256 === deliveryCache.manifestSha256) {
      // The bundle has not changed since it was verified. Do not claim a fresh
      // full verify: reuse the facts and refresh only source staleness.
      if (!deliveryCache.state.verified) return deliveryCache.state;
      const state: DeliveryState = {
        ...deliveryCache.state,
        stale: await renderIsStale(root, target.id, deliveryCache.state.build),
      };
      if (version === deliveryVersion) deliveryCache = { ...deliveryCache, state };
      return deliveryCache.state;
    }
    // The representative manifest changed: a real re-delivery. Verify once.
    try {
      const inspection = await inspectImageDelivery(root, { delivery: deliveryEntry, target: target.id });
      if (version !== deliveryVersion) return deliveryCache.state;
      if (inspection.manifestSha256 !== manifestSha256)
        return blockDelivery(
          `the manifest of ${OUTPUT_DIR}/${deliveryEntry} changed while it was being inspected; retry`,
        );
      deliveryCache = { state: deliveryStateOf(inspection), manifestSha256 };
      return deliveryCache.state;
    } catch (error) {
      if (version !== deliveryVersion) return deliveryCache.state;
      return blockDelivery(error instanceof Error ? error.message : String(error));
    }
  };

  /** Full verification: used at download, where the actual bytes are handed out. */
  const verifyDeliveryFully = async (): Promise<DeliveryState | null> => {
    if (deliveryEntry === null) return null;
    const inspection = await inspectImageDelivery(root, { delivery: deliveryEntry, target: target.id });
    deliveryVersion += 1;
    deliveryCache = { state: deliveryStateOf(inspection), manifestSha256: inspection.manifestSha256 };
    return deliveryCache.state;
  };

  const deliveryView = (state: DeliveryState): WorkbenchDelivery => ({
    entry: state.entry,
    path: state.projectPath,
    build: state.build,
    artifact: state.artifact,
    format: state.format,
    width: state.width,
    height: state.height,
    sha256: state.sha256,
    bytes: state.bytes,
    simulated: state.simulated,
    stale: state.stale,
    verified: state.verified,
    blocked: state.blocked,
  });

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', origin || 'http://127.0.0.1');
        // Both `/workbench` and `/workbench/` serve the same shell. A page at
        // `/workbench` would resolve `./workbench.js` against `/`, so state the
        // asset mount explicitly instead of relying on the requested spelling.
        if (req.method === 'GET' && (url.pathname === '/workbench' || url.pathname === '/workbench/')) {
          const html = Buffer.from(
            (await readFile(path.join(ASSETS, 'workbench.html'), 'utf8')).replace(
              /<head>/i,
              '<head>\n<base href="/workbench/">',
            ),
            'utf8',
          );
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'content-length': String(html.length),
            'cache-control': 'no-store',
            'x-frame-options': 'DENY',
            // The author document is mounted in a same-origin `srcdoc` frame,
            // which INHERITS this policy. The production rasterizer executes the
            // document's own inline scripts, and an author layout script is how a
            // fixed canvas is usually built, so refusing inline scripts here would
            // preview (and save) a different design than `renderImage` produces.
            // The source is trusted Project content, already mounted same-origin.
            'content-security-policy':
              "default-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; " +
              "style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
          });
          res.end(html);
          return;
        }
        if (req.method === 'GET' && url.pathname.startsWith('/workbench/')) {
          const relative = decodeURIComponent(url.pathname.slice('/workbench/'.length));
          const absolute = path.resolve(ASSETS, relative);
          if (!absolute.startsWith(ASSETS + path.sep)) throw new HttpError(403, 'path escapes the workbench assets');
          const info = await lstat(absolute);
          if (!info.isFile() || info.isSymbolicLink()) throw new HttpError(404, 'not a file');
          const bytes = await readFile(absolute);
          res.writeHead(200, {
            'content-type': CONTENT_TYPES[path.extname(absolute).toLowerCase()] ?? 'application/octet-stream',
            'content-length': String(bytes.length),
            'cache-control': 'no-store',
          });
          res.end(bytes);
          return;
        }

        // Declared resources of the bound document only.
        if (req.method === 'GET' && url.pathname.startsWith('/resource/')) {
          assertToken(req, url);
          const [, , documentId, ...rest] = url.pathname.split('/');
          if (documentId !== document.id) throw new HttpError(403, 'resource request for another document');
          const relative = decodeURIComponent(rest.join('/'));
          const current = await loadProject(root);
          const bound = current.imageDocuments.find(candidate => candidate.id === document.id);
          if (!bound || !bound.resources.includes(relative))
            throw new HttpError(403, `resource "${relative}" is not declared by document "${document.id}"`);
          const absolute = await resolveProjectPath(root, relative);
          let bytes = await readFile(absolute);
          if (path.extname(absolute).toLowerCase() === '.css') {
            // Browser-relative requests from an external stylesheet do not
            // inherit its query token. Authorize declared dependencies in the
            // served CSS only; never rewrite the author's files on disk.
            const base = new URL('/' + relative.split('/').map(encodeURIComponent).join('/'), origin);
            const resourceUrl = (reference: string): string => {
              if (!reference || reference.startsWith('#') || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(reference))
                return reference;
              try {
                const resolved = new URL(reference, base);
                const dependency = decodeURIComponent(resolved.pathname.slice(1));
                if (!bound.resources.includes(dependency)) return reference;
                const served = new URL(
                  `/resource/${encodeURIComponent(document.id)}/${dependency.split('/').map(encodeURIComponent).join('/')}`,
                  origin,
                );
                served.search = resolved.search;
                served.searchParams.set('token', token);
                served.hash = resolved.hash;
                return `${served.pathname}${served.search}${served.hash}`;
              } catch {
                return reference;
              }
            };
            const css = bytes
              .toString('utf8')
              .replace(
                /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
                (_match, quote: string, ref: string) => `url(${quote}${resourceUrl(ref.trim())}${quote})`,
              )
              .replace(
                /(@import\s+)(['"])([^'"]+)\2/gi,
                (_match, prefix: string, quote: string, ref: string) => `${prefix}${quote}${resourceUrl(ref)}${quote}`,
              );
            bytes = Buffer.from(css);
          }
          res.writeHead(200, {
            'content-type': CONTENT_TYPES[path.extname(absolute).toLowerCase()] ?? 'application/octet-stream',
            'content-length': String(bytes.length),
            'cache-control': 'no-store',
          });
          res.end(bytes);
          return;
        }

        if (url.pathname === '/api/document' && req.method === 'GET') {
          assertToken(req, url);
          const { project: current, html, contentHash, revision } = await readDocument(root, document);
          const bound = current.imageDocuments.find(candidate => candidate.id === document.id)!;
          const delivery = await refreshDelivery();
          json(res, 200, {
            document: { id: bound.id, path: bound.path, revision, contentHash },
            html,
            resources: bound.resources.map(relative => ({
              path: relative,
              url: `/resource/${encodeURIComponent(document.id)}/${relative.split('/').map(encodeURIComponent).join('/')}`,
            })),
            target: {
              id: target.id,
              logicalWidth: target.width,
              logicalHeight: target.height,
              width: Math.round(target.width * target.scale),
              height: Math.round(target.height * target.scale),
              scale: target.scale,
              format: target.format,
              background: target.background,
            },
            result: await latestResult(root, target, delivery?.build),
            delivery: delivery === null ? null : deliveryView(delivery),
          });
          return;
        }

        if (url.pathname === '/api/document' && req.method === 'PUT') {
          assertToken(req, url);
          assertOrigin(req);
          const body = JSON.parse(await readBody(req)) as {
            document?: string;
            baseRevision?: number;
            baseContentHash?: string;
            html?: string;
          };
          if (body.document !== document.id)
            throw new HttpError(400, 'body.document does not match the bound document');
          if (typeof body.html !== 'string') throw new HttpError(400, 'body.html must be a string');
          if (typeof body.baseRevision !== 'number') throw new HttpError(400, 'body.baseRevision is required');
          if (typeof body.baseContentHash !== 'string') throw new HttpError(400, 'body.baseContentHash is required');
          const bytes = Buffer.from(body.html, 'utf8');
          const contentHash = sha256(bytes);
          let revision: number;
          try {
            const result = await withAuthorLock(root, async (current, commit) => {
              const bound = current.imageDocuments.find(candidate => candidate.id === document.id);
              if (!bound) throw new HttpError(404, `image document "${document.id}" no longer exists`);
              const absolute = await resolveProjectPath(root, bound.path);
              // The base is re-read UNDER the author lock: nothing can write the
              // source or the Project between this check and our own writes.
              const original = await readFile(absolute);
              const actual = sha256(original);
              if (bound.revision !== body.baseRevision || actual !== body.baseContentHash)
                throw new SourceConflict({ revision: bound.revision, contentHash: actual });
              const next = structuredClone(current);
              const nextDocument = next.imageDocuments.find(candidate => candidate.id === document.id)!;
              nextDocument.revision = bound.revision + 1;
              // A registered `code` Asset that names this same authored file
              // records its bytes. Keep that CURRENT registration truthful; Builds
              // and Artifacts already recorded keep their historical hashes.
              // Same rule as the explicit `refresh-code` operation.
              updateCodeAssetsForPath(next, bound.path, contentHash);
              await replaceFile(absolute, bytes);
              let saved: Project;
              try {
                saved = await commit(next);
              } catch (error) {
                // The source is already replaced: put the original bytes back so
                // the Project and the document never disagree about what exists.
                await replaceFile(absolute, original);
                throw error;
              }
              return {
                revision: saved.imageDocuments.find(candidate => candidate.id === document.id)!.revision,
              };
            });
            revision = result.revision;
          } catch (error) {
            if (error instanceof SourceConflict) {
              json(res, 409, { error: 'conflict', current: error.current });
              return;
            }
            const message = error instanceof Error ? error.message : String(error);
            // Another writer holds the author lock (e.g. the other of two
            // same-base saves). This is not a source conflict — we never read a
            // base while that writer is mid-write — so do not invent `current`.
            if (/is locked by PID/.test(message)) {
              json(res, 409, { error: 'busy', message });
              return;
            }
            throw error;
          }
          json(res, 200, { revision, contentHash, savedAt: new Date().toISOString() });
          return;
        }

        if (url.pathname === '/api/status' && req.method === 'GET') {
          assertToken(req, url);
          const { contentHash, revision } = await readDocument(root, document);
          const delivery = await refreshDelivery();
          json(res, 200, {
            dirty: false,
            document: { revision, contentHash },
            savedAt: null,
            result: await latestResult(root, target, delivery?.build),
            delivery: delivery === null ? null : deliveryView(delivery),
          });
          return;
        }

        if (url.pathname === '/api/render' && req.method === 'POST') {
          assertToken(req, url);
          assertOrigin(req);
          const body = JSON.parse(await readBody(req)) as { target?: string };
          if (body.target !== target.id) throw new HttpError(400, `body.target must be "${target.id}"`);
          try {
            const result = await renderImage(root, { target: target.id });
            // Publish the EXACT Build this render produced. Re-resolving "the
            // newest build" after a concurrent save could publish pixels that
            // do not belong to the returned result.
            let published: ImageDeliveryUpdateResult | null = null;
            let publishError: string | null = null;
            if (deliveryEntry !== null) {
              try {
                published = await updateImageDelivery(root, {
                  delivery: deliveryEntry,
                  target: target.id,
                  build: result.build,
                });
              } catch (error) {
                publishError = error instanceof Error ? error.message : String(error);
              }
            }
            // The page may have saved again while this render/publish was
            // running: the output exists, but compare ITS recording key with
            // the current saved bytes instead of presenting it as current
            // unconditionally.
            const stale = await renderIsStale(root, target.id, result.build);
            const output = {
              ...result,
              stale,
              url: `/api/output?target=${encodeURIComponent(target.id)}`,
            };
            if (deliveryEntry === null) {
              json(res, 200, output);
              return;
            }
            if (published === null) {
              // The render succeeded and stays usable; only the delivered copy
              // was not updated. This is a rare path, so pay for a FULL verify:
              // it either confirms the old delivered facts (a stale-source or
              // disk refusal) or reveals that the bundle itself stopped
              // verifying. Never claim the old file is current when it is not.
              let delivery: DeliveryState | null = null;
              try {
                delivery = await verifyDeliveryFully();
              } catch (error) {
                delivery = blockDelivery(error instanceof Error ? error.message : String(error));
              }
              json(res, 500, {
                error: 'publish-failed',
                message: publishError ?? 'the delivered file was not updated',
                result: output,
                delivery: delivery === null ? null : deliveryView(delivery),
              });
              return;
            }
            // ONE complete view for this request, reused by the response and the
            // cached facts; a slow status refresh from before this publish can
            // no longer overwrite it (deliveryVersion).
            deliveryVersion += 1;
            deliveryCache = {
              state: deliveryStateOfUpdate(published, stale),
              manifestSha256: published.manifestSha256,
            };
            json(res, 200, { ...output, delivery: deliveryView(deliveryCache.state) });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // Only a source that changed under the render is a conflict. Any other
            // failure (a missing resource, capture, disk) is a REAL error and is
            // reported as itself, not as "the source is not saved".
            if (/conflict|changed while it was being frozen/i.test(message)) {
              json(res, 409, { error: 'conflict', message });
              return;
            }
            throw error;
          }
          return;
        }

        if (url.pathname === '/api/output' && req.method === 'GET') {
          assertToken(req, url);
          const requested = url.searchParams.get('target');
          if (requested !== target.id) throw new HttpError(400, `target must be "${target.id}"`);
          if (deliveryEntry !== null) {
            // A download pays for ONE full verification immediately before the
            // bytes leave: record+manifest+members+this product's hash. Never
            // serve an unverified file and never fall back to the Artifact.
            let current: DeliveryState | null = null;
            let failure = '';
            try {
              current = await verifyDeliveryFully();
            } catch (error) {
              failure = error instanceof Error ? error.message : String(error);
              current = blockDelivery(failure);
            }
            if (current === null || !current.verified)
              throw new HttpError(
                409,
                current?.blocked ?? failure ?? `the delivered file for ${deliveryEntry} could not be verified`,
              );
            const absolute = await resolveProjectPath(root, current.projectPath);
            const bytes = await readFile(absolute);
            if (sha256(bytes) !== current.sha256)
              throw new HttpError(409, `the delivered file ${current.projectPath} changed after it was inspected`);
            const extension = current.format === 'jpeg' ? 'jpg' : current.format;
            res.writeHead(200, {
              'content-type': CONTENT_TYPES[`.${extension}`] ?? 'application/octet-stream',
              'content-length': String(bytes.length),
              'content-disposition': `attachment; filename="${path.basename(current.projectPath)}"`,
              'cache-control': 'no-store',
            });
            res.end(bytes);
            return;
          }
          const result = await latestResult(root, target);
          if (!result) throw new HttpError(404, 'no rendered result for this target yet');
          const bytes = await readFile(await resolveProjectPath(root, result.path));
          const extension = result.format === 'jpeg' ? 'jpg' : result.format;
          res.writeHead(200, {
            'content-type': CONTENT_TYPES[`.${extension}`] ?? 'application/octet-stream',
            'content-length': String(bytes.length),
            'content-disposition': `attachment; filename="${target.id}.${extension}"`,
            'cache-control': 'no-store',
          });
          res.end(bytes);
          return;
        }

        throw new HttpError(404, `unknown route ${req.method} ${url.pathname}`);
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        const message = error instanceof Error ? error.message : String(error);
        if (!res.headersSent) json(res, status, { error: message });
        else res.end();
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('serveWorkbench: could not determine the listening port');
  }
  const port = address.port;
  origin = `http://127.0.0.1:${port}`;
  const url = `${origin}/workbench?document=${encodeURIComponent(document.id)}&target=${encodeURIComponent(
    target.id,
  )}&token=${token}`;

  return {
    url,
    token,
    port,
    document: document.id,
    target: target.id,
    ...(deliveryCache === null ? {} : { delivery: deliveryView(deliveryCache.state) }),
    close: () => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
  };
}
