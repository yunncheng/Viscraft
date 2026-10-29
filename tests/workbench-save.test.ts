/**
 * Workbench saves update authored HTML and Project metadata under one lock.
 * These tests exercise that transaction through a real loopback server:
 *
 *  - a held author lock refuses the save WITHOUT touching the source;
 *  - two saves on the same base produce exactly one success;
 *  - a commit that fails after the source was replaced restores the original
 *    bytes (Project revision unchanged, no `.tmp` left behind);
 *  - an ordinary stale base still returns 409 and reports the current values;
 *  - a registered `code` Asset for the same authored file is kept truthful;
 *  - a real render failure is reported as itself (500 + message), not as the
 *    "source not saved" 409.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireLock, validateProject } from '../src/project/project.js';
import { serveWorkbench, type WorkbenchServer } from '../src/workbench/server.js';

const DOC = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="ink.css"></head>
<body><div class="poster" data-canvas-width="240" data-canvas-height="150">
<div class="title" data-layer-id="title">FIRST CUT</div>
</div></body></html>`;
const CSS = `html,body{margin:0;width:240px;height:150px;overflow:hidden;background:#f2ead9}`;
const RIGHTS = { origin: 'studio', license: 'CC0-1.0', redistributable: true } as const;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface FixtureOptions {
  /** Registers the same authored file as a `code` Asset. */
  codeAsset?: boolean;
  /** Declares a resource that does not exist on disk. */
  missingResource?: boolean;
  documentRevision?: number;
}

async function fixture(options: FixtureOptions = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'viscraft-workbench-save-'));
  const documentRevision = options.documentRevision ?? 1;
  await writeFile(join(root, 'poster.html'), DOC);
  if (!options.missingResource) await writeFile(join(root, 'ink.css'), CSS);
  const project = validateProject({
    schemaVersion: 1,
    id: 'workbench-save',
    revision: 1,
    title: 'Workbench save',
    direction: { intent: 'one still, saved in place', looks: [{ id: 'plain', description: 'plain' }], transitions: [] },
    assets: options.codeAsset
      ? [{ id: 'poster_source', revision: 1, path: 'poster.html', sha256: sha256(DOC), type: 'code', rights: RIGHTS }]
      : [],
    bindings: {},
    sources: [],
    imageDocuments: [
      {
        id: 'poster',
        path: 'poster.html',
        resources: [options.missingResource ? 'missing.css' : 'ink.css'],
        revision: documentRevision,
      },
    ],
    imageTargets: [
      { id: 'wide', document: 'poster', width: 240, height: 150, scale: 2, format: 'png', background: 'opaque' },
    ],
  });
  await writeFile(join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  return root;
}

function call(live: WorkbenchServer, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${live.port}${path}`, {
    ...init,
    headers: { 'x-viscraft-token': live.token, ...(init.headers ?? {}) },
  });
}

function put(live: WorkbenchServer, base: { revision: number; contentHash: string }, html: string): Promise<Response> {
  return call(live, '/api/document', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      document: 'poster',
      baseRevision: base.revision,
      baseContentHash: base.contentHash,
      html,
    }),
  });
}

async function opened(live: WorkbenchServer): Promise<{ revision: number; contentHash: string }> {
  const body = (await (await call(live, '/api/document')).json()) as {
    document: { revision: number; contentHash: string };
  };
  return body.document;
}

async function stored(root: string): Promise<{
  revision: number;
  assets: Array<{ revision: number; sha256: string }>;
  imageDocuments: Array<{ revision: number }>;
}> {
  return JSON.parse(await readFile(join(root, 'project.json'), 'utf8'));
}

async function temporaryFiles(root: string): Promise<string[]> {
  return (await readdir(root)).filter(name => name.endsWith('.tmp'));
}

test('a save advances the document and the Project once, and a stale base still conflicts', async () => {
  const root = await fixture();
  const live = await serveWorkbench(root, { document: 'poster', target: 'wide' });
  try {
    const base = await opened(live);
    const edited = DOC.replace('FIRST CUT', 'SECOND CUT');
    const saved = await put(live, base, edited);
    assert.equal(saved.status, 200);
    const body = (await saved.json()) as { revision: number; contentHash: string };
    assert.equal(body.revision, 2, 'the document revision advances once');
    assert.equal(body.contentHash, sha256(edited));
    assert.equal(await readFile(join(root, 'poster.html'), 'utf8'), edited, 'the author source really changed');
    const project = await stored(root);
    assert.equal(project.revision, 2, 'the Project revision advanced once');
    assert.equal(project.imageDocuments[0].revision, 2);

    const stale = await put(live, base, DOC);
    assert.equal(stale.status, 409);
    const conflict = (await stale.json()) as { error: string; current: { revision: number; contentHash: string } };
    assert.equal(conflict.error, 'conflict');
    assert.deepEqual(conflict.current, { revision: 2, contentHash: sha256(edited) });
    assert.equal(await readFile(join(root, 'poster.html'), 'utf8'), edited, 'the newer bytes survived');
    assert.deepEqual(await temporaryFiles(root), [], 'no temporary file is left behind');
  } finally {
    await live.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a held author lock refuses the save without touching the source or the Project', async () => {
  const root = await fixture();
  const live = await serveWorkbench(root, { document: 'poster', target: 'wide' });
  try {
    const base = await opened(live);
    const release = await acquireLock(root, 'author');
    try {
      const refused = await put(live, base, DOC.replace('FIRST CUT', 'WHILE LOCKED'));
      // Contention is "busy", not a fabricated source conflict: nothing here
      // read a base while the other writer was mid-write.
      assert.equal(refused.status, 409);
      const body = (await refused.json()) as { error: string; message: string; current?: unknown };
      assert.equal(body.error, 'busy');
      assert.equal(body.current, undefined, 'no guessed base is reported');
      assert.match(body.message, /locked by PID/, 'the refusal still names the lock holder');
    } finally {
      await release();
    }
    assert.equal(await readFile(join(root, 'poster.html'), 'utf8'), DOC, 'the source was never written');
    const project = await stored(root);
    assert.equal(project.revision, 1);
    assert.equal(project.imageDocuments[0].revision, 1);
    assert.deepEqual(await temporaryFiles(root), []);

    // The same page can still save once the lock is released.
    assert.equal((await put(live, base, DOC.replace('FIRST CUT', 'AFTER LOCK'))).status, 200);
  } finally {
    await live.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('two saves on the same base produce exactly one success and one consistent source', async () => {
  const root = await fixture();
  const live = await serveWorkbench(root, { document: 'poster', target: 'wide' });
  try {
    const base = await opened(live);
    const candidates = [DOC.replace('FIRST CUT', 'FIRST WRITER'), DOC.replace('FIRST CUT', 'SECOND WRITER')];
    const responses = await Promise.all(candidates.map(html => put(live, base, html)));
    const statuses = responses.map(response => response.status);
    assert.deepEqual(statuses.slice().sort(), [200, 409], 'exactly one save wins and the loser conflicts');
    for (const [index, response] of responses.entries()) {
      if (statuses[index] === 200) continue;
      // Either the lock was held ('busy') or the winner had already committed
      // ('conflict' with the now-current base); both are a clean refusal.
      const body = (await response.json()) as { error: string; current?: unknown };
      assert.ok(['busy', 'conflict'].includes(body.error), `the loser reports busy or conflict, got ${body.error}`);
      assert.equal(body.error === 'conflict', body.current !== undefined, 'only a real conflict reports a base');
    }
    const winner = candidates[statuses.indexOf(200)];
    assert.equal(await readFile(join(root, 'poster.html'), 'utf8'), winner, 'the winner is the whole saved source');
    const project = await stored(root);
    assert.equal(project.revision, 2, 'only one Project revision was committed');
    assert.equal(project.imageDocuments[0].revision, 2, 'only one document revision was committed');
    assert.deepEqual(await temporaryFiles(root), []);
  } finally {
    await live.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed Project commit restores the original author bytes', async () => {
  // The document revision is valid but one past it is not, so the source write
  // succeeds and the Project commit fails afterwards: the rollback path.
  const root = await fixture({ documentRevision: Number.MAX_SAFE_INTEGER });
  const live = await serveWorkbench(root, { document: 'poster', target: 'wide' });
  try {
    const base = await opened(live);
    assert.equal(base.revision, Number.MAX_SAFE_INTEGER);
    const edited = DOC.replace('FIRST CUT', 'UNCOMMITTED');
    const failed = await put(live, base, edited);
    assert.equal(failed.status, 500, 'the commit failure is reported as a failure');
    const body = (await failed.json()) as { error: string };
    assert.match(body.error, /revision|9007199254740991/, 'the real validation failure is reported');
    assert.equal(await readFile(join(root, 'poster.html'), 'utf8'), DOC, 'the original bytes were restored');
    const project = await stored(root);
    assert.equal(project.revision, 1);
    assert.equal(project.imageDocuments[0].revision, Number.MAX_SAFE_INTEGER);
    assert.deepEqual(await temporaryFiles(root), []);
    // The server and the Project still describe the same bytes.
    const reread = await opened(live);
    assert.deepEqual(reread, base);
  } finally {
    await live.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('saving the same bytes still advances the document while a registered code Asset keeps its identity', async () => {
  const root = await fixture({ codeAsset: true });
  const live = await serveWorkbench(root, { document: 'poster', target: 'wide' });
  try {
    const base = await opened(live);
    // Exactly the bytes the document already has: the save is a real save (it
    // still records the author's save in the document/Project revision), but the
    // shared code-Asset leaf only changes when the bytes actually change.
    const saved = await put(live, base, DOC);
    assert.equal(saved.status, 200);
    const body = (await saved.json()) as { revision: number; contentHash: string };
    assert.equal(body.revision, 2, 'the document revision advances once');
    assert.equal(body.contentHash, sha256(DOC));
    const project = await stored(root);
    assert.equal(project.revision, 2, 'the Project records the save');
    assert.equal(project.imageDocuments[0].revision, 2, 'the document revision advanced');
    assert.equal(project.assets[0].revision, 1, 'the code Asset did not invent a change');
    assert.equal(project.assets[0].sha256, sha256(DOC), 'the code Asset still records the same bytes');
    assert.equal(await readFile(join(root, 'poster.html'), 'utf8'), DOC);
    assert.deepEqual(await temporaryFiles(root), []);
  } finally {
    await live.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a registered code Asset for the same authored file is kept truthful, history untouched', async () => {
  const root = await fixture({ codeAsset: true });
  const live = await serveWorkbench(root, { document: 'poster', target: 'wide' });
  try {
    const base = await opened(live);
    const edited = DOC.replace('FIRST CUT', 'TRACKED CUT');
    const saved = await put(live, base, edited);
    assert.equal(saved.status, 200);
    const project = await stored(root);
    assert.equal(project.assets[0].revision, 2, 'the Asset registration advances');
    assert.equal(project.assets[0].sha256, sha256(edited), 'the recorded hash IS the saved bytes');
    assert.equal(await readFile(join(root, 'poster.html'), 'utf8'), edited);
  } finally {
    await live.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a real render failure is reported as itself, not as an unsaved source', async () => {
  const root = await fixture({ missingResource: true });
  const live = await serveWorkbench(root, { document: 'poster', target: 'wide' });
  try {
    const rendered = await call(live, '/api/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'wide' }),
    });
    assert.equal(rendered.status, 500, 'a missing resource is a real failure');
    const body = (await rendered.json()) as { error: string };
    assert.match(body.error, /missing\.css/, 'the message names the missing resource');
    assert.notEqual(body.error, 'unsaved');
  } finally {
    await live.close();
    await rm(root, { recursive: true, force: true });
  }
});
