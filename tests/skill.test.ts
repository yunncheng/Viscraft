import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../src/shared/process.js';

// Locate the repository root from the compiled test location (<root>/dist/tests),
// falling back to the process cwd. The tests assert properties of the Skill
// documents, not of any Runtime behaviour.
function findRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.resolve(here, '..', '..'), process.cwd()]) {
    if (existsSync(path.join(candidate, 'skills', 'viscraft', 'SKILL.md'))) return candidate;
  }
  throw new Error('could not locate the Viscraft repository root');
}

const ROOT = findRepoRoot();
const SKILL_DIR = path.join(ROOT, 'skills', 'viscraft');
const SKILL = path.join(SKILL_DIR, 'SKILL.md');
const REFERENCES_DIR = path.join(SKILL_DIR, 'references');
const README = path.join(ROOT, 'README.md');

/** Markdown files, as POSIX-relative paths from the supplied documentation root. */
async function referenceFiles(dir = REFERENCES_DIR, prefix = ''): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await referenceFiles(path.join(dir, entry.name), rel)));
    else if (entry.name.endsWith('.md')) found.push(rel);
  }
  return found;
}

/** Local (non-URL, non-anchor) markdown link targets found in a document. */
function localLinks(markdown: string): string[] {
  const targets: string[] = [];
  for (const match of markdown.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].trim();
    if (/^(https?:|mailto:|#)/i.test(target)) continue;
    targets.push(target.split('#')[0]);
  }
  return targets;
}

test('SKILL.md has installation metadata and reaches its on-demand references', async () => {
  const skill = await readFile(SKILL, 'utf8');
  const metadata = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skill)?.[1];
  assert.ok(metadata, 'SKILL.md must carry frontmatter');
  assert.match(metadata, /^name:\s*['"]?viscraft['"]?\s*$/m, 'frontmatter must name the skill');
  assert.match(metadata, /^description:\s*\S/m, 'frontmatter must carry a description');

  const present = (await referenceFiles()).sort();

  // Reachability: every reference must be reachable by following links from the
  // SKILL.md root, not merely have some inbound link somewhere in the set. This
  // catches a page reachable only through an orphaned cluster (e.g. a mutually
  // linked pair nothing points into).
  const docs = [SKILL, ...present.map(rel => path.join(REFERENCES_DIR, rel))];
  const outgoing = new Map<string, Set<string>>();
  for (const doc of docs) {
    const text = await readFile(doc, 'utf8');
    const targets = new Set<string>();
    for (const target of localLinks(text)) targets.add(path.resolve(path.dirname(doc), target));
    outgoing.set(path.resolve(doc), targets);
  }
  const reachable = new Set<string>();
  const queue = [path.resolve(SKILL)];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const next of outgoing.get(current) ?? []) if (!reachable.has(next)) queue.push(next);
  }
  for (const rel of present) {
    const abs = path.join(REFERENCES_DIR, rel);
    assert.ok(reachable.has(abs), `references/${rel} is not reachable by links from SKILL.md`);
  }
});

test('public entry points use usable sources and select delivery targets', async () => {
  const docs = [
    ['README.md', await readFile(README, 'utf8')],
    ['skills/viscraft/SKILL.md', await readFile(SKILL, 'utf8')],
  ] as const;
  for (const [name, text] of docs) {
    assert.doesNotMatch(text, /YOUR_ORG|YOUR_REPO/, `${name} exposes an unusable install placeholder`);
    assert.ok(!/git\s+clone\s+https?:/i.test(text), `${name} presents a source clone as the ordinary entry`);
  }
  // Delivery selects products by target id for both media, so a still-only or
  // sound-only work is handed over without fabricating a film.
  const skill = docs[1][1];
  assert.match(skill, /--image\s+<target>/, 'SKILL.md must select stills by target id');
  assert.match(skill, /--sound\s+<id>/, 'SKILL.md must select a sound target for delivery');
  assert.match(skill, /\bsoundTargets\b/, 'SKILL.md must name the sound target declaration');
});

test('the Skill does not assume a bundled Runtime or docs, and warns against the unrelated npx viscraft package', async () => {
  const skill = await readFile(SKILL, 'utf8');
  assert.match(skill, /separately/i, 'SKILL.md must state that the Skill and Runtime install separately');
  assert.ok(
    !/skill\s+(?:directory\s+)?(?:includes|bundles|contains)\s+the\s+runtime/i.test(skill),
    'SKILL.md must not claim the Skill directory bundles the Runtime',
  );
  for (const doc of [SKILL, README]) {
    const text = await readFile(doc, 'utf8');
    for (const line of text.split('\n')) {
      if (/\bnpx(?:\s+--yes|\s+-y)?\s+viscraft\b/.test(line)) {
        assert.match(
          line,
          /not|never|avoid/i,
          `${path.relative(ROOT, doc)} invokes the unrelated npx viscraft package without a warning: ${line.trim()}`,
        );
      }
    }
  }
});

// Spend consent is a product rule, not advice: a committed file must never
// preauthorize a submission. A key is not consent and a redistributable
// license is not upload consent, so the engine requires an explicit
// `authorization.submit === true` — and the Skill must require the *user* to be the
// one who grants it. This test keeps that rule from silently decaying into prose.
test('a committed example cannot preauthorize an API submission', async () => {
  const skill = await readFile(SKILL, 'utf8');
  assert.match(skill, /## Spend and upload consent/, 'SKILL.md must carry an explicit spend/upload consent section');
  assert.match(
    skill,
    /Never hardcode `authorization\.submit: true`/,
    'SKILL.md must forbid hardcoding billable authorization in a committed example',
  );

  // Check both technical authoring fixtures and shipped creative recipes.
  const dirs = [
    path.join(ROOT, 'tests', 'fixtures', 'authoring'),
    path.join(SKILL_DIR, 'assets', 'studies', 'code-visuals'),
    path.join(SKILL_DIR, 'assets', 'studies', 'audio'),
    path.join(SKILL_DIR, 'assets', 'projects'),
  ];
  const wiresVideoApi = (text: string): boolean => /providers\s*:\s*\{[^}]*\bvideoApi\s*:/.test(text);
  const wiresVendorProtocol = (text: string): boolean => /protocol\s*:\s*['"](?:runway-v1|fal-queue)['"]/.test(text);
  for (const dir of dirs) {
    const names = (await readdir(dir, { recursive: true, withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.mjs'))
      .map(entry => path.join(entry.parentPath ?? entry.path, entry.name));
    assert.ok(names.length > 0, `no scripts found to check under ${path.relative(ROOT, dir)}`);
    for (const script of names) {
      const text = await readFile(script, 'utf8');
      const name = path.relative(ROOT, script);
      // A provider Source can select a vendor endpoint through the SDK's
      // `providers.videoApi` options. A committed recipe must not pair that
      // billable route with hardcoded submission authorization.
      assert.ok(
        !(wiresVideoApi(text) && wiresVendorProtocol(text) && text.includes('submit: true')),
        `${name} wires a billable vendor endpoint (runway-v1/fal-queue) with authorization.submit: true; a committed script must not preauthorize generation`,
      );
      if (text.includes('submit: true')) {
        assert.match(
          text,
          /flag\s*!==\s*['"]--authorize['"]/,
          `${name} must require an explicit user-authorized invocation before constructing submission consent`,
        );
        // Exercise the actual entrypoint: absent consent must stop before project
        // loading or an API request, regardless of whether the service is local.
        await assert.rejects(
          () => runCommand(process.execPath, [script, 'unused-project', 'unused-source', 'unused-shot']),
          /Usage:.*--authorize/,
          `${name} must refuse a submission without the explicit authorization flag`,
        );
      }
    }
  }
});
