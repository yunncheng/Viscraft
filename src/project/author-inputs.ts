import { type Project, type Source, RelativePath } from '../core/schema.js';
import { staticSourceFiles, sourceFilePaths } from './source-files.js';

import { hashFile } from '../shared/hash.js';
import { resolveProjectPath } from '../shared/fs.js';
import { z } from 'zod';

/**
 * The authored files a Build freezes (and hashes into its snapshot / operation
 * inputs): every Asset, plus each Source's own authored-file closure as declared
 * by the shared author-input query (a code-like Source's entry + resources, a playable recording's
 * session/media/source files, …). Returned as unique project-relative paths; the
 * caller decides whether to copy (Build) or hash in place (preflight). Order is
 * irrelevant — the snapshot hash sorts keys.
 */
export async function authoredFilePathClosure(project: Project, loadRoot: string): Promise<string[]> {
  const paths = new Set<string>();
  for (const asset of project.assets) paths.add(asset.path);
  for (const source of project.sources)
    for (const file of (await sourceAuthoredFiles(source, loadRoot)).files) paths.add(file);
  for (const document of project.imageDocuments) {
    paths.add(document.path);
    for (const resource of document.resources) paths.add(resource);
  }
  return [...paths];
}

/**
 * Expand ONE Source's authored closure without letting its failure erase every
 * other author fact. A browser recording is the only Source expansion that
 * reads the filesystem; when it fails we still know the page's own files and the
 * declared recording path, and the failure is reported at that recording path
 * instead of aborting the whole inventory. A different query failure is a
 * programming error and propagates.
 */
async function sourceAuthoredFiles(
  source: Source,
  loadRoot: string,
): Promise<{ files: string[]; failed: string | null }> {
  try {
    return { files: await sourceFilePaths(source, loadRoot), failed: null };
  } catch (error) {
    const recording = source.kind === 'browser' && source.output === 'picture' ? source.recording : undefined;
    if (!recording) throw error;
    return { files: [...staticSourceFiles(source), recording], failed: recording };
  }
}

/** Every authored path with the owners that declare it and any declared digest. */
function declaredAuthorFacts(project: Project): Map<string, { owners: Set<string>; sha256?: string }> {
  const facts = new Map<string, { owners: Set<string>; sha256?: string }>();
  const add = (relative: string, owner: string, sha256?: string): void => {
    const current = facts.get(relative) ?? { owners: new Set<string>() };
    current.owners.add(owner);
    if (sha256 !== undefined) current.sha256 = sha256;
    facts.set(relative, current);
  };
  for (const asset of project.assets) add(asset.path, `asset:${asset.id}`, asset.sha256);
  for (const document of project.imageDocuments) {
    add(document.path, `image-document:${document.id}`);
    for (const resource of document.resources) add(resource, `image-document:${document.id}`);
  }
  for (const source of project.sources) for (const file of staticSourceFiles(source)) add(file, `source:${source.id}`);
  for (const file of project.handoff ?? []) add(file.path, `handoff:${file.role}`);
  return facts;
}

export interface AuthoredFileFacts {
  /** Every READABLE declared author file → the digest of its ACTUAL bytes. */
  files: Record<string, string>;
  /** Declared facts whose bytes are absent, unreadable or do not match the declaration. */
  unavailable: AuthoredGap[];
}

export interface AuthoredFileFactsOptions {
  /**
   * Resolve a MISSING path from the verified content store. Only a digest that
   * matches the declared Asset `sha256` is accepted; `null` keeps it a gap.
   */
  recover?: (path: string, declaredSha256: string) => Promise<string | null>;
}

/**
 * The complete authoring inventory: every declared authored file, the digest of
 * the bytes that are actually there, and an explicit record of every declared
 * fact whose bytes are not usable. Nothing is silently omitted and nothing is
 * fabricated:
 *
 *  - one unreadable path (or one Source whose recording closure cannot be
 *    expanded) never hides the rest;
 *  - a readable file whose bytes disagree with a declared Asset digest is kept as
 *    the ACTUAL bytes AND reported as a `mismatch` gap, so an unconsumed damaged
 *    Asset cannot be mistaken for a valid identity;
 *  - a missing Asset may be recovered from the content store when the caller
 *    supplies a verifier; that is reuse of verified bytes, not a new truth.
 */
export async function authoredFileFacts(
  project: Project,
  loadRoot: string,
  options: AuthoredFileFactsOptions = {},
): Promise<AuthoredFileFacts> {
  const declared = declaredAuthorFacts(project);
  const expansionFailures = new Set<string>();
  for (const source of project.sources) {
    const expanded = await sourceAuthoredFiles(source, loadRoot);
    if (expanded.failed) expansionFailures.add(expanded.failed);
    const entry = declared.get(expanded.failed ?? '');
    for (const file of expanded.files) {
      const fact = declared.get(file) ?? { owners: new Set<string>() };
      fact.owners.add(`source:${source.id}`);
      declared.set(file, fact);
    }
    if (expanded.failed && !entry) declared.set(expanded.failed, { owners: new Set([`source:${source.id}`]) });
  }
  const files: Record<string, string> = {};
  const unavailable: AuthoredGap[] = [];
  const ownersOf = (relative: string): string[] => [...(declared.get(relative)?.owners ?? [])];
  for (const relative of [...declared.keys()].sort()) {
    const fact = declared.get(relative)!;
    if (expansionFailures.has(relative)) {
      unavailable.push({
        path: relative,
        reason: 'expansion-unavailable',
        ...(fact.sha256 !== undefined ? { expectedSha256: fact.sha256 } : {}),
        actualSha256: null,
        owners: ownersOf(relative),
      });
      continue;
    }
    let digest: string;
    try {
      digest = await hashFile(await resolveProjectPath(loadRoot, relative));
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      if (missing && fact.sha256 !== undefined && options.recover) {
        const recovered = await options.recover(relative, fact.sha256);
        if (recovered !== null) {
          files[relative] = recovered;
          continue;
        }
      }
      unavailable.push({
        path: relative,
        reason: missing ? 'path-missing' : 'unreadable',
        ...(fact.sha256 !== undefined ? { expectedSha256: fact.sha256 } : {}),
        actualSha256: null,
        owners: ownersOf(relative),
      });
      continue;
    }
    files[relative] = digest;
    if (fact.sha256 !== undefined && fact.sha256 !== digest)
      // Readable bytes that disagree with the declared digest are a real author
      // fact, not an absence: the actual bytes stay in `files` and the gap says so.
      unavailable.push({
        path: relative,
        reason: 'hash-mismatch',
        expectedSha256: fact.sha256,
        actualSha256: digest,
        owners: ownersOf(relative),
      });
  }
  return { files, unavailable };
}

const HEX = /^[a-f0-9]{64}$/;

/**
 * One declared authored fact whose bytes are not usable at freeze time.
 * A gap is an HONEST record, never a silent omission: it names the path, why it
 * is unavailable, the hash evidence known at the time, and the declared owners
 * that need it. A listed-but-later-lost file is NOT a gap — that is damage and
 * must fail verification instead of being reclassified as a normal gap.
 *
 * The four reasons are the shared contract:
 *  - `path-missing`         — the declared path does not exist;
 *  - `unreadable`           — it exists but its bytes cannot be read;
 *  - `expansion-unavailable`— a Source's authored closure cannot be expanded
 *                             (e.g. a recording closure that cannot be loaded);
 *  - `hash-mismatch`        — readable bytes disagree with the declared digest;
 *                             the ACTUAL digest stays in `files`, never pretending
 *                             the byte is absent.
 */
export const AuthoredGapSchema = z
  .object({
    path: RelativePath,
    reason: z.enum(['path-missing', 'unreadable', 'expansion-unavailable', 'hash-mismatch']),
    /** Recorded/declared digest, when the declaration carries one. */
    expectedSha256: z.string().regex(HEX).optional(),
    /** Digest of readable bytes that did not match the declaration, else null. */
    actualSha256: z.string().regex(HEX).nullable(),
    /** Declared owners (`asset:<id>`, `source:<id>`, `image-document:<id>`, ...). */
    owners: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((gap, context) => {
    if ((gap.reason === 'hash-mismatch') !== (gap.actualSha256 !== null))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'only a hash-mismatch gap carries a readable actualSha256',
      });
  });

export type AuthoredGap = z.infer<typeof AuthoredGapSchema>;

/**
 * The frozen author inputs: available bytes plus the explicit gaps. `environment`
 * deliberately does NOT live here — a Build record owns the single environment
 * authority, so a snapshot has exactly one meaning.
 */
export const SnapshotInputsSchema = z
  .object({
    files: z.record(z.string(), z.string().regex(HEX)),
    unavailable: z.array(AuthoredGapSchema),
  })
  .strict();

export type SnapshotInputs = z.infer<typeof SnapshotInputsSchema>;
