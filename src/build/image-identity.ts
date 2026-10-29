/**
 * Observable environment facts for still-image production.
 *
 * A still is painted by `backends/browser/capture` (which stages TypeScript
 * through `backends/browser/transpile`) and applies the workbench's saved-layout
 * interpreter `workbench/ui/layout-record.js` — an ASSET loaded by path, not an
 * import. The environment fact therefore hashes the real transitive import
 * closure of those two modules plus the layout asset, the runtime, the
 * Node/platform pair and the browser binary.
 *
 * It deliberately does NOT use the shared `baseKeyEnvironment`: that probes
 * ffmpeg/ffprobe, and a still never encodes media. A missing ffmpeg must not
 * re-key or block a still.
 *
 * A fact that genuinely cannot be observed is the literal `unknown` and the
 * whole environment is reported `verified: false`. That is a real observation —
 * "this machine cannot be shown to reproduce the recorded result" — never a
 * claim that the recorded environment is still current.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { stableHash } from '../shared/hash.js';
import { RUNTIME_EXTENSION, RUNTIME_VERSION, browserVersion, runtimeRoot } from './identity.js';

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Environment facts that enter a still key, plus whether all of them were observed. */
export interface ImageEnvironment {
  /**
   * `runtime`, `node`, `platform`, `browser`, `capture`, `layout`, `transpile`.
   * A value is `unknown` only when that fact could not be probed.
   */
  facts: Record<string, string>;
  /** False when ANY fact is `unknown`: the environment is unverified, not current. */
  verified: boolean;
}

/** Relative ESM specifiers (`./x.js`, `../y.js`) imported by a compiled module. */
const RELATIVE_IMPORT = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g;

/**
 * Remove comments while KEEPING string literals, so a `import './helper.js'`
 * example in a doc comment is not mistaken for a real dependency. A false
 * positive would make the closure unreadable and the whole implementation fact
 * `unknown`.
 */
function stripComments(source: string): string {
  let out = '';
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];
    if (state === 'code') {
      if (char === '/' && next === '/') {
        state = 'line';
        index++;
      } else if (char === '/' && next === '*') {
        state = 'block';
        index++;
      } else {
        if (char === "'") state = 'single';
        else if (char === '"') state = 'double';
        else if (char === '`') state = 'template';
        out += char;
      }
      continue;
    }
    if (state === 'line') {
      if (char === '\n') {
        state = 'code';
        out += '\n';
      }
      continue;
    }
    if (state === 'block') {
      if (char === '*' && next === '/') {
        state = 'code';
        index++;
      } else if (char === '\n') out += '\n';
      continue;
    }
    // Inside a string, keep every byte: the specifier lives here.
    out += char;
    if (char === '\\') {
      if (next !== undefined) out += next;
      index++;
      continue;
    }
    if (
      (state === 'single' && char === "'") ||
      (state === 'double' && char === '"') ||
      (state === 'template' && char === '`')
    )
      state = 'code';
  }
  return out;
}

/**
 * The modules a capture entry really executes, following only relative in-runtime
 * imports. `null` when part of the closure cannot be read: an install that cannot
 * show its own capture code must not be fingerprinted from a partial set.
 */
async function closureMembers(root: string, entries: readonly string[]): Promise<string[] | null> {
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length > 0) {
    const relative = stack.pop()!;
    if (seen.has(relative) || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    let source: string;
    try {
      source = stripComments(await readFile(path.join(root, relative), 'utf8'));
    } catch {
      return null;
    }
    seen.add(relative);
    for (const match of source.matchAll(RELATIVE_IMPORT))
      stack.push(path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1])));
  }
  return [...seen].sort();
}

/** Content hash of an entry's transitive closure, or `unknown` when unreadable. */
async function closureFact(root: string | null, entries: readonly string[]): Promise<string> {
  if (root === null) return 'unknown';
  const members = await closureMembers(root, entries);
  if (members === null) return 'unknown';
  const hash = createHash('sha256');
  for (const relative of members) {
    try {
      hash
        .update(relative)
        .update('\0')
        .update(await readFile(path.join(root, relative)))
        .update('\0');
    } catch {
      return 'unknown';
    }
  }
  return hash.digest('hex');
}

/** The saved-layout interpreter is a shipped asset, so it is hashed by its bytes. */
async function layoutFact(root: string | null): Promise<string> {
  if (root === null) return 'unknown';
  for (const extension of ['.js', '.ts']) {
    try {
      return sha256(await readFile(path.join(root, 'workbench', 'ui', `layout-record${extension}`)));
    } catch {
      // Try the source form; both absent is reported below.
    }
  }
  return 'unknown';
}

/**
 * The running browser binary's version. Not memoized: a probe answer reused for
 * the rest of the process would hide the binary being replaced at the same path,
 * and would keep an earlier failure cached after the browser was installed.
 */
async function browserFact(): Promise<string> {
  try {
    return (await browserVersion()).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The one environment object shared by `imageRenderKey` (read-only status) and
 * `renderImage` (the operation key). `capture`/`transpile`/`layout` are the
 * implementation the still actually runs; `runtime`/`node`/`platform`/`browser`
 * are the machine.
 */
export async function imageEnvironment(): Promise<ImageEnvironment> {
  let root: string | null = null;
  try {
    root = await runtimeRoot();
  } catch {
    // A runtime that cannot locate its own root cannot prove what it executes.
    root = null;
  }
  const facts = {
    runtime: RUNTIME_VERSION,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    browser: await browserFact(),
    capture: await closureFact(root, [`backends/browser/capture${RUNTIME_EXTENSION}`]),
    layout: await layoutFact(root),
    transpile: await closureFact(root, [`backends/browser/transpile${RUNTIME_EXTENSION}`]),
  };
  return { facts, verified: Object.values(facts).every(value => value !== 'unknown') };
}

/**
 * How a recorded Build's machine facts relate to the machine observed now. The
 * ONE verdict status/versions/closure/delivery/workbench share, so none of them
 * re-derives it from its own hash comparison.
 *
 *  - `match`      — this machine is the recorded one: the still is current.
 *  - `changed`    — same author bytes, different implementation/browser/runtime:
 *                   the recorded result is still the result of those bytes, but
 *                   re-rendering would be a different execution, not "current".
 *  - `unverified` — a fact could not be observed. The recorded bytes stay
 *                   copyable/verifiable; they must NOT be presented as current.
 *  - `unrecorded` — the Build carries no machine facts at all.
 *
 * A caller must compare the AUTHOR key first: this answers only the machine half.
 */
export type ImageEnvironmentAgreement = 'match' | 'changed' | 'unverified' | 'unrecorded';

export function compareImageEnvironment(
  recorded: Readonly<Record<string, string>> | undefined,
  observed: ImageEnvironment,
): ImageEnvironmentAgreement {
  if (recorded === undefined) return 'unrecorded';
  if (!observed.verified) return 'unverified';
  return stableHash(recorded) === stableHash(observed.facts) ? 'match' : 'changed';
}
