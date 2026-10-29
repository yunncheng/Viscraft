import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Locate the repository root from the compiled test location (<root>/dist/tests),
// falling back to the process cwd. Installation metadata and reference
// reachability are structural requirements of the independently installed Skill.
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
