import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Check local Markdown links and heading fragments in the current checkout,
// including untracked files. Contributor-only docs are checked when present;
// they are not required in an exported product checkout. Ignore research and
// snapshot trees so optional local material cannot gate a clean checkout.

function findRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.resolve(here, '..', '..'), process.cwd()]) {
    if (existsSync(path.join(candidate, 'skills', 'viscraft', 'SKILL.md'))) return candidate;
  }
  throw new Error('could not locate the Viscraft repository root');
}

const ROOT = findRepoRoot();

/**
 * Exclude upstream research and snapshot trees. `git ls-files` already applies
 * the checkout's ignore rules when enumerating untracked files.
 */
function isExcluded(target: string): boolean {
  const rel = path.relative(ROOT, target).split(path.sep).join('/');
  return (
    rel === 'references/upstream' || rel.startsWith('references/upstream/') || rel.split('/').includes('snapshots')
  );
}

/** Every `.md` file under `dir`, recursively (fallback when git is unavailable). */
async function markdownUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await markdownUnder(full)));
    else if (entry.name.endsWith('.md')) found.push(full);
  }
  return found;
}

/**
 * The default set: every current Markdown file in the product docs. `git ls-files
 * --cached --others --exclude-standard` is authoritative: it covers tracked files
 * AND newly authored (untracked) docs while still honouring the rooted ignore
 * rules; `existsSync` below drops a tracked file that was deleted from the working
 * tree. New docs therefore appear without editing this file.
 */
async function shippedDocs(): Promise<string[]> {
  const result = spawnSync(
    'git',
    [
      '-C',
      ROOT,
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      'README.md',
      'CONTRIBUTING.md',
      'THIRD_PARTY_NOTICES.md',
      'AGENTS.md',
      'docs',
      'src/workbench/ui/README.md',
      'tests/fixtures',
      'skills/viscraft',
    ],
    { encoding: 'utf8' },
  );
  let files: string[];
  if (result.status === 0 && result.stdout) {
    files = result.stdout
      .split('\0')
      .filter(Boolean)
      .map(rel => path.resolve(ROOT, rel));
  } else {
    // No usable git (e.g. an extracted copy): enumerate the same roots directly.
    const roots = [
      path.join(ROOT, 'README.md'),
      path.join(ROOT, 'CONTRIBUTING.md'),
      path.join(ROOT, 'THIRD_PARTY_NOTICES.md'),
      path.join(ROOT, 'AGENTS.md'),
      path.join(ROOT, 'src/workbench/ui/README.md'),
      ...(await markdownUnder(path.join(ROOT, 'tests/fixtures'))),
      ...(existsSync(path.join(ROOT, 'docs')) ? await markdownUnder(path.join(ROOT, 'docs')) : []),
      ...(await markdownUnder(path.join(ROOT, 'skills', 'viscraft'))),
    ];
    files = roots;
  }
  return files.filter(file => file.endsWith('.md') && existsSync(file) && !isExcluded(file)).sort();
}

/**
 * Heading slugs for `#fragment` matching. Two real renderers are in play and they
 * disagree on punctuation-adjacent whitespace: GitHub replaces EACH space with a
 * hyphen (so `shots — and` → `shots--and`, used by `finishing-recipes.md`), while
 * the collapse convention this repository's earlier verification recorded maps a
 * run of spaces to ONE hyphen (`shots-and`). We
 * accept either form so a doc authored against either renderer is never a false
 * positive — while a genuinely renamed heading still resolves to neither.
 */
function slugForms(heading: string): string[] {
  const stripped = heading
    .toLowerCase()
    .trim()
    .replace(/[^\w\u4e00-\u9fa5 -]/g, '');
  return [stripped.replace(/ /g, '-'), stripped.replace(/\s+/g, '-')];
}

interface ParsedDoc {
  anchors: Set<string>;
  links: { file?: string; fragment?: string }[];
}

/**
 * Parse one Markdown document with enough real semantics to be trustworthy:
 *  - headings and links inside fenced code blocks (``` / ~~~) are ignored, as is
 *    any link syntax inside an inline code span;
 *  - repeated headings get GitHub's `-1`, `-2` disambiguation.
 */
function parseDoc(text: string): ParsedDoc {
  const anchors = new Set<string>();
  const slugCounts = new Map<string, number>();
  const links: { file?: string; fragment?: string }[] = [];
  let fence: string | null = null;
  for (const raw of text.split('\n')) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(raw);
    if (fence !== null) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (heading) {
      const forms = slugForms(heading[2]);
      const seen = slugCounts.get(forms[0]) ?? 0;
      slugCounts.set(forms[0], seen + 1);
      for (const form of forms) anchors.add(seen === 0 ? form : `${form}-${seen}`);
    }
    // Ignore link-like text inside an inline code span.
    const withoutCode = raw.replace(/`[^`]*`/g, '');
    for (const match of withoutCode.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1].trim().split(/\s+/)[0];
      if (/^(https?:|mailto:)/i.test(target)) continue;
      if (target.startsWith('#')) {
        const fragment = target.slice(1);
        if (fragment) links.push({ fragment });
        continue;
      }
      const hash = target.indexOf('#');
      if (hash === -1) links.push({ file: target });
      else links.push({ file: target.slice(0, hash), fragment: target.slice(hash + 1) || undefined });
    }
  }
  return { anchors, links };
}

interface LinkProblem {
  doc: string;
  target: string;
  kind: 'missing file' | 'missing anchor';
}

interface LinkReport {
  problems: LinkProblem[];
  linksChecked: number;
  anchorsChecked: number;
}

/**
 * Resolve every local link and `#anchor` across `docs`, returning the problems
 * plus the counts actually checked. Excluded targets (research/upstream,
 * snapshots) are skipped entirely rather than reported missing.
 */
async function checkLinks(docs: string[], excluded: (absolute: string) => boolean = () => false): Promise<LinkReport> {
  const parsed = new Map<string, ParsedDoc>();
  const parsedFor = async (file: string): Promise<ParsedDoc> => {
    let doc = parsed.get(file);
    if (!doc) {
      doc = parseDoc(await readFile(file, 'utf8'));
      parsed.set(file, doc);
    }
    return doc;
  };

  const problems: LinkProblem[] = [];
  let linksChecked = 0;
  let anchorsChecked = 0;
  for (const doc of docs) {
    const relative = path.relative(ROOT, doc) || doc;
    for (const { file, fragment } of (await parsedFor(doc)).links) {
      linksChecked++;
      const target = file === undefined ? doc : path.resolve(path.dirname(doc), file);
      if (excluded(target)) continue;
      if (file !== undefined && !existsSync(target)) {
        problems.push({ doc: relative, target: file, kind: 'missing file' });
        continue;
      }
      if (fragment !== undefined) {
        anchorsChecked++;
        if (!(await parsedFor(target)).anchors.has(fragment)) {
          const label = file === undefined ? `#${fragment}` : `${file}#${fragment}`;
          problems.push({ doc: relative, target: label, kind: 'missing anchor' });
        }
      }
    }
  }
  return { problems, linksChecked, anchorsChecked };
}

function describe(problems: LinkProblem[]): string {
  return problems.map(problem => `${problem.doc} -> ${problem.target} (${problem.kind})`).join('\n');
}

test('every local link and #anchor in the shipped docs resolves', async () => {
  const docs = await shippedDocs();
  // Guard the enumeration itself: a silently-empty set must not pass trivially.
  for (const required of ['README.md', 'CONTRIBUTING.md', 'skills/viscraft/SKILL.md'])
    assert.ok(
      docs.some(file => path.relative(ROOT, file).split(path.sep).join('/') === required),
      `the shipped-docs enumeration never found ${required}`,
    );

  const { problems, linksChecked, anchorsChecked } = await checkLinks(docs, isExcluded);
  assert.deepEqual(
    problems,
    [],
    `unresolved local links/anchors:\n${describe(problems)}\n(checked ${linksChecked} links, ${anchorsChecked} anchors)`,
  );
  assert.ok(linksChecked > 300, `expected a non-trivial link count; saw ${linksChecked}`);
  assert.ok(anchorsChecked > 100, `expected a non-trivial anchor count; saw ${anchorsChecked}`);
});

test('the checker actually reports a deliberately broken link and anchor', async () => {
  // Negative case lives in a TEMP fixture — never a real docs directory.
  const root = await mkdtemp(path.join(tmpdir(), 'viscraft-docs-links-'));
  try {
    await mkdir(path.join(root, 'nested'), { recursive: true });
    const good = path.join(root, 'good.md');
    await writeFile(
      good,
      '# Real heading\n\n## Repeated\n\n## Repeated\n\nSee [ok](./nested) and [self](#real-heading).\n',
    );
    const bad = path.join(root, 'bad.md');
    await writeFile(
      bad,
      [
        '# Bad',
        '',
        '[missing file](./does-not-exist.md)',
        '[missing cross-page anchor](./good.md#no-such-heading)',
        '[missing same-page anchor](#also-missing)',
        '[good file, good anchor](./good.md#repeated-1)',
        '',
        '```',
        '## Fenced heading must not become an anchor',
        '[fenced](./also-does-not-exist.md)',
        '```',
        '',
        'An inline `[code link](./nope.md)` span must be ignored.',
        '',
      ].join('\n'),
    );

    const { problems, linksChecked, anchorsChecked } = await checkLinks([good, bad]);
    // The fixture lives outside the repo, so compare by basename.
    const kinds = problems.map(problem => `${path.basename(problem.doc)} -> ${problem.target} (${problem.kind})`);
    assert.deepEqual(
      kinds.sort(),
      [
        'bad.md -> ./does-not-exist.md (missing file)',
        'bad.md -> #also-missing (missing anchor)',
        'bad.md -> ./good.md#no-such-heading (missing anchor)',
      ].sort(),
      `the checker must report exactly the deliberate breakages (checked ${linksChecked} links, ${anchorsChecked} anchors)`,
    );
    // GitHub-style duplicate disambiguation: the second `## Repeated` is
    // reachable as `#repeated-1` and is therefore NOT reported.
    assert.ok(
      !problems.some(problem => problem.target.includes('repeated-1')),
      'duplicate heading anchor must resolve',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('development docs and research trees never enter the npm package', async () => {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')) as { files?: string[] };
  const whitelist = pkg.files ?? [];
  for (const entry of whitelist) {
    const cleaned = entry.replace(/^\.?\//, '').replace(/\/+$/, '');
    assert.ok(
      cleaned !== 'docs' && !cleaned.startsWith('docs/') && cleaned !== 'AGENTS.md',
      `package.json "files" must not publish development docs: ${entry}`,
    );
  }
  assert.ok(
    !whitelist.some(entry => entry === 'references' || entry.startsWith('references/')),
    'package.json "files" must not publish the isolated research tree',
  );
});
