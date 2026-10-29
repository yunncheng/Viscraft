import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PlayableLiveProjectSchema, PlayablePackageManifestSchema } from '../../core/schema.js';
import { resolveProjectPath } from '../../shared/fs.js';
import { assertAuthoredPath } from '../../project/authored-path.js';

export interface PlayableServer {
  url: string;
  close(): Promise<void>;
}

/** Serve only verified package files on loopback; this is not an executable-code sandbox. */
export async function servePlayable(root: string, port = 0): Promise<PlayableServer> {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('Playable port must be an integer in [0,65535]');
  const manifest = PlayablePackageManifestSchema.parse(
    JSON.parse(await readFile(await resolveProjectPath(root, 'playable-manifest.json'), 'utf8')),
  );
  const files = new Map(manifest.files.map(file => [file.path, file.sha256]));
  if (files.size !== manifest.files.length || !files.has(manifest.source.entry))
    throw new Error('Playable manifest has duplicate files or no declared entry');
  const readVerified = async (relative: string): Promise<Buffer> => {
    const expected = files.get(relative);
    if (!expected) throw new Error('File is not declared by the playable package');
    const bytes = await readFile(await resolveProjectPath(root, relative));
    if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Playable file hash mismatch');
    return bytes;
  };
  for (const relative of files.keys()) {
    assertAuthoredPath(relative, 'Playable server file');
    await readVerified(relative);
  }
  const configuration = PlayableLiveProjectSchema.parse(
    JSON.parse((await readVerified('project.json')).toString('utf8')),
  );
  const source = configuration.sources[0];
  if (
    source.kind !== 'browser' ||
    source.output !== 'picture' ||
    source.id !== manifest.source.id ||
    source.entry !== manifest.source.entry
  )
    throw new Error('Playable configuration does not match the package entry');
  for (const asset of configuration.assets)
    if (files.get(asset.path) !== asset.sha256 || !asset.rights.redistributable)
      throw new Error('Playable Asset hash/rights do not match its package');
  if (source.resources.some(resource => !files.has(resource)))
    throw new Error('Playable Source resources are missing from the package');
  const mime: Record<string, string> = {
    html: 'text/html; charset=utf-8',
    htm: 'text/html; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    wasm: 'application/wasm',
    json: 'application/json',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    svg: 'image/svg+xml',
    css: 'text/css',
    wav: 'audio/wav',
    mp4: 'video/mp4',
    woff: 'font/woff',
    woff2: 'font/woff2',
  };
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405);
        response.end();
        return;
      }
      const raw = (request.url ?? '/').split('?')[0];
      let relative: string;
      try {
        relative = decodeURIComponent(raw === '/' ? `/${manifest.source.entry}` : raw).slice(1);
      } catch {
        response.writeHead(400);
        response.end();
        return;
      }
      if (!files.has(relative)) {
        response.writeHead(404);
        response.end();
        return;
      }
      try {
        const bytes = await readVerified(relative);
        const extension = relative.split('.').at(-1)!.toLowerCase();
        response.writeHead(200, {
          'Content-Type': mime[extension] ?? 'application/octet-stream',
          'Content-Length': bytes.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(request.method === 'HEAD' ? undefined : bytes);
      } catch {
        response.writeHead(409);
        response.end('Playable file integrity check failed');
      }
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => reject(error);
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', fail);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Playable server has no loopback address');
  }
  return {
    url: `http://127.0.0.1:${address.port}/${manifest.source.entry.split('/').map(encodeURIComponent).join('/')}`,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
    server.closeIdleConnections();
  });
}
