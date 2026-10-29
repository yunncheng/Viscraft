import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../src/shared/process.js';
import { createProject } from '../src/project/create.js';
import { saveProject } from '../src/project/project.js';

// The Skill is documentation the host agent acts on. This test keeps its
// executable claims honest against the Runtime itself:
//
//  1. every `viscraft <command>` in the Skill docs is a real Runtime command and
//     every `--flag` with it is in that command's own usage string;
//  2. every public name the docs import from the Runtime entry actually exists;
//  3. a shipped SDK example is actually executed, and the cost-bearing
//     `generate-image` example is proven to make ZERO POSTs on `--check`
//     (`preflightGenerateImage`) and exactly ONE on an authorized submit — always
//     against a local SIMULATED vllm-omni-image service, never a real one.
//
// It deliberately does NOT treat every placeholder in the prose as an executable
// program, and it does not lock the creative guidance to fixed sentences.

function findRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.resolve(here, '..', '..'), process.cwd()]) {
    if (existsSync(path.join(candidate, 'skills', 'viscraft', 'SKILL.md'))) return candidate;
  }
  throw new Error('could not locate the Viscraft repository root');
}

const ROOT = findRepoRoot();
const SKILL_DIR = path.join(ROOT, 'skills', 'viscraft');
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const RUNTIME_ENTRY = new URL('../src/index.js', import.meta.url).href;

/** `command -> usage`, parsed from the Runtime's own `--help` output. */
async function commandTable(): Promise<Map<string, string>> {
  const help = await runCommand(process.execPath, [CLI, '--help']);
  const table = new Map<string, string>();
  for (const line of help.split('\n')) {
    const match = /^ {2}([a-z][a-z-]*)(?: {2,}(.*))?$/.exec(line);
    if (match) table.set(match[1], match[2] ?? '');
  }
  assert.ok(
    table.has('build') && table.has('revert') && table.has('clean'),
    'could not parse the CLI command table from `--help`',
  );
  return table;
}

/** Every `.md` file under `dir`, recursively. */
async function markdownUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await markdownUnder(full)));
    else if (entry.name.endsWith('.md')) found.push(full);
  }
  return found;
}

/** Public entry README and every Markdown file the Skill ships. */
async function skillDocs(): Promise<string[]> {
  return [path.join(ROOT, 'README.md'), ...(await markdownUnder(SKILL_DIR))];
}

interface Invocation {
  command: string;
  flags: Set<string>;
  line: string;
}

/**
 * Command invocations in a document, each with the `--flags` attributed to it.
 * A `--flag` belongs to the command that most recently preceded it on the same
 * line; a later command on the line starts a fresh region. This keeps
 * `viscraft keep <id>` … `--note` on a following prose line from being charged to
 * an unrelated command while still catching the flags written right after a
 * command in a usage line.
 */
function invocations(markdown: string): Invocation[] {
  const found: Invocation[] = [];
  const command = /(?<!npx )viscraft[ \t]+([a-z][a-z-]*)|cli\.js[ \t]+([a-z][a-z-]*)/g;
  for (const line of markdown.split('\n')) {
    const occurrences: Array<{ command: string; start: number; end: number }> = [];
    command.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = command.exec(line)) !== null) {
      occurrences.push({
        command: match[1] ?? match[2]!,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
    for (let index = 0; index < occurrences.length; index++) {
      const current = occurrences[index]!;
      const regionEnd = index + 1 < occurrences.length ? occurrences[index + 1]!.start : line.length;
      const region = line.slice(current.end, regionEnd);
      const flags = new Set([...region.matchAll(/--[a-z][a-z-]*/g)].map(flag => flag[0]));
      found.push({ command: current.command, flags, line });
    }
  }
  return found;
}

test('every `viscraft <command>` in the Skill docs exists with only real flags', async () => {
  const table = await commandTable();
  const docs = await skillDocs();
  const observed = new Set<string>();
  const problems: string[] = [];
  for (const doc of docs) {
    const text = await readFile(doc, 'utf8');
    for (const { command, flags, line } of invocations(text)) {
      observed.add(command);
      const usage = table.get(command);
      if (usage === undefined) {
        problems.push(`${path.relative(ROOT, doc)}: unknown command \`viscraft ${command}\` — ${line.trim()}`);
        continue;
      }
      for (const flag of flags) {
        if (!usage.includes(flag))
          problems.push(
            `${path.relative(ROOT, doc)}: \`viscraft ${command} ${flag}\` is not in that command's usage (${usage})`,
          );
      }
    }
  }
  assert.deepEqual(problems, [], `Skill documents and the CLI command table disagree:\n${problems.join('\n')}`);
  assert.ok(observed.size > 0, 'the documentation check exercised actual CLI invocations');
});

// --- Public names imported by the docs exist on the Runtime entry ------------

/** Strip `type` markers and comments, keep the local name of each binding. */
function importedNames(clause: string): string[] {
  const body = clause.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  return body
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .filter(part => !part.startsWith('type '))
    .map(part => (part.split(/\s+as\s+/)[0] ?? part).trim())
    .filter(Boolean);
}

test('every Runtime name the Skill docs import is a real export of the entry', async () => {
  const entry = (await import(RUNTIME_ENTRY)) as Record<string, unknown>;
  const named = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gs;
  const destructured = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s+import\s*\(/gs;
  const fromEntry = (specifier: string): boolean =>
    specifier === 'viscraft-runtime' || specifier.endsWith('/index.js') || specifier.endsWith('index.js');

  const seen = new Map<string, string>();
  for (const doc of await skillDocs()) {
    const text = await readFile(doc, 'utf8');
    for (const match of text.matchAll(named)) {
      if (!fromEntry(match[2])) continue;
      for (const name of importedNames(match[1])) seen.set(name, path.relative(ROOT, doc));
    }
    for (const match of text.matchAll(destructured)) {
      for (const name of importedNames(match[1])) seen.set(name, path.relative(ROOT, doc));
    }
  }

  assert.ok(seen.size > 0, 'the documentation import check must exercise at least one actual Runtime import');
  const missing = [...seen].filter(([name]) => !(name in entry)).map(([name, doc]) => `${doc} imports '${name}'`);
  assert.deepEqual(missing, [], `the Skill docs import names the Runtime does not export:\n${missing.join('\n')}`);
});

// --- Execute complete authoring and consent paths ----------------------------

test('a shipped author recipe authors a real Project through the Runtime command', async () => {
  // A shipped creative reference returns a
  // Project draft plus generated/selected files and lets the Runtime write them.
  // Running it through `viscraft author` catches a missing required Project path
  // and a non-existent runtime export at once.
  const recipe = path.join(SKILL_DIR, 'assets', 'studies', 'code-visuals', 'cel-watercolor', 'create.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'viscraft-sdk-example-'));
  const project = path.join(root, 'event-project');
  try {
    const result = spawnSync(process.execPath, [CLI, 'author', recipe, project], { encoding: 'utf8' });
    assert.equal(result.status, 0, `the author recipe failed:\n${result.stderr}${result.stdout}`);
    assert.ok(existsSync(path.join(project, 'project.json')), 'the recipe must author project.json');
    // Its usage contract: a missing project directory must be refused loudly.
    const noPath = spawnSync(process.execPath, [CLI, 'author', recipe], { encoding: 'utf8' });
    assert.notEqual(noPath.status, 0, 'the command must require a project directory');
    assert.match(noPath.stderr, /Usage: viscraft author/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- Layer 3: cost-bearing example vs a local SIMULATED service ----------------

// A genuine 8x8 PNG (produced by FFmpeg): the simulated vllm-omni-image service
// returns these bytes and the Runtime registers them as a real image Asset. A
// hand-made 1x1 stub is NOT used — the Runtime decodes the bytes with FFmpeg and
// would rightly reject a malformed chunk.
const PNG_8X8 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEUlEQVR4nGPQsgrFihiGlgQACBYuQVd0OrIAAAAASUVORK5CYII=',
  'base64',
);

test('the video submission example contacts a service only after explicit invocation consent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'viscraft-example-consent-'));
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.method ?? '');
    request.resume();
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'simulated service rejection' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^VISCRAFT_(?:VIDEO|IMAGE)_/i.test(key))),
    VISCRAFT_VIDEO_API_URL: `http://127.0.0.1:${address.port}`,
  };
  const run = promisify(execFile);
  try {
    const project = await createProject(root, {
      title: 'Consent fixture',
      output: { fps: { numerator: 24, denominator: 1 } },
    });
    project.sources.push({
      id: 'clip',
      kind: 'provider',
      output: 'picture',
      endpoint: 'default',
      model: 'minimax-h3-base-fl2va',
      prompt: 'simulated consent fixture',
      mode: 'text',
      references: [],
      requestedFrames: 48,
      fps: 24,
      size: '1280:720',
      attempt: 'consent-fixture',
    });
    project.composition!.scenes.push({ id: 'scene', description: 'fixture' });
    project.composition!.shots.push({
      id: 'shot',
      scene: 'scene',
      look: 'default',
      intent: 'fixture',
      targetFrames: 48,
    });
    await saveProject(root, project, project.revision);
    const args = [path.join(ROOT, 'tests/fixtures/authoring/produce-video-api.mjs'), root, 'clip', 'shot'];
    await assert.rejects(run(process.execPath, args, { env, timeout: 15000, windowsHide: true }));
    assert.equal(requests.length, 0, 'without consent the example sends no HTTP request');

    // The same valid input with consent reaches the rejecting local service.
    await assert.rejects(run(process.execPath, [...args, '--authorize'], { env, timeout: 15000, windowsHide: true }));
    assert.equal(requests.filter(method => method === 'POST').length, 1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('the cost-bearing generate-image example POSTs zero on --check and one on submit (simulated service)', async () => {
  const { createProject, preflightGenerateImage, generateImage } = (await import(RUNTIME_ENTRY)) as {
    createProject: (root: string, options: { title: string }) => Promise<unknown>;
    preflightGenerateImage: (
      root: string,
      request: unknown,
      options: unknown,
    ) => Promise<{ action: string; ok: boolean }>;
    generateImage: (root: string, request: unknown, options: unknown) => Promise<{ asset: { id: string } }>;
  };

  const requests: Array<{ method: string; path: string }> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    req.resume();
    req.on('end', () => {
      requests.push({ method: req.method ?? '', path: url.pathname });
      if (req.method === 'POST' && url.pathname === '/v1/images/generations') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ created: 1728000000, data: [{ b64_json: PNG_8X8.toString('base64') }] }));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  const root = await mkdtemp(path.join(tmpdir(), 'viscraft-skill-image-'));
  try {
    await createProject(root, { title: 'Skill image smoke' });
    const request = {
      id: 'hero_still',
      attempt: 1,
      asset: 'hero_still',
      rights: { origin: 'simulated vllm-omni-image fixture', license: 'CC0-1.0', redistributable: true },
      operation: 'generate',
      endpoint: 'local-test',
      model: 'Qwen-Image',
      prompt: 'a lone lighthouse on a stormy basalt cliff at dusk',
      references: [],
      size: '64x64',
    };
    const options = {
      providers: {
        imageApi: {
          'local-test': { endpoint: { protocol: 'vllm-omni-image', baseUrl }, authorization: { submit: true } },
        },
      },
    };

    const preflight = await preflightGenerateImage(root, request, options);
    assert.equal(preflight.action, 'submit', 'a fresh request with authorization is submittable');
    assert.equal(requests.length, 0, '`--check` (preflightGenerateImage) must send zero requests');

    const result = await generateImage(root, request, options);
    assert.equal(result.asset.id, 'hero_still', 'the image Asset is registered under the requested id');
    const posts = requests.filter(entry => entry.method === 'POST');
    assert.equal(posts.length, 1, `an authorized submit must send exactly one POST; saw ${posts.length}`);
  } finally {
    await rm(root, { recursive: true, force: true });
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
