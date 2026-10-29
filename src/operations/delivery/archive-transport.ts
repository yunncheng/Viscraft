/**
 * Bounded, dependency-free transport for a movable single-file project archive.
 *
 * This module is deliberately **not** a general-purpose archive library. It
 * implements exactly one decoded framing — a strict USTAR regular-file subset
 * carried over gzip — that round-trips the files a portable v1 project export
 * stages, and nothing else. The writer emits one gzip member; the reader
 * validates the decoded USTAR framing and does not claim a strict gzip envelope
 * (concatenated members are tolerated only while they add no decoded bytes past
 * the end-of-archive marker):
 *
 *  - zero new dependencies (Node `zlib` / `stream` / `fs` only);
 *  - every member is a regular file (typeflag `'0'` or NUL, `ustar` magic,
 *    version `00`, empty link name, no PAX/GNU extensions, no base-256 numbers,
 *    no directories, links or special files);
 *  - the portable manifest (`.viscraft/portable-manifest.json`) is always the
 *    first member and is capped at `manifestBytes`; the archive parser hands its
 *    exact bytes to the caller before any other member is created;
 *  - the caller supplies the physical file allowlist (from the trusted manifest)
 *    and rejects unknown paths / hash mismatches in the `accept` callback, which
 *    runs only after each extracted file has been closed and hashed;
 *  - fixed limits bound member count and JSON members; content, decoded and
 *    compressed bytes are bounded by an absolute cap (`maxContentBytes`) and,
 *    once the manifest is read, by its own declaration: every later member must
 *    be listed with its exact size, so oversize input stops before the
 *    offending file is created.
 *
 * The transport is intentionally low-level: `src/operations/delivery/archive.ts` owns publication,
 * directory staging, the export-authority comparison and the CLI. This file only
 * validates paths, encodes/decodes the strict container and verifies bytes.
 */

import { createHash, type Hash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { RelativePath } from '../../core/schema.js';

/** Canonical manifest path; must be the first archive member. */
export const ARCHIVE_MANIFEST = '.viscraft/portable-manifest.json';

/**
 * Fixed transport limits that do not grow with media size. The writer enforces
 * them as a precondition and the reader enforces them live so a hostile archive
 * cannot force unbounded memory, disk or CPU work.
 */
export const ARCHIVE_LIMITS = {
  /** Maximum number of regular-file members. */
  entries: 10_000,
  /** Portable manifest cap. */
  manifestBytes: 8 * 1024 * 1024,
  /** project.json / Build record / frozen snapshot metadata cap. */
  metadataBytes: 8 * 1024 * 1024,
  /** Any other `*.json` member (e.g. a playable recording) cap. */
  recordingBytes: 64 * 1024 * 1024,
} as const;

/** Default absolute cap on total content bytes; raise it explicitly with `--max-content`. */
export const DEFAULT_MAX_CONTENT_BYTES = 4 * 1024 * 1024 * 1024;

/** Exact decoded USTAR size: content + one header per member + padding + end blocks. */
export function decodedBytesFor(sizes: readonly number[]): number {
  return sizes.reduce((sum, size) => sum + BLOCK_SIZE + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE, END_MARKER.length);
}

/** Absolute decoded cap for a content cap: worst-case framing for the maximum member count. */
export function decodedCapFor(maxContentBytes: number): number {
  return maxContentBytes + ARCHIVE_LIMITS.entries * 2 * BLOCK_SIZE + END_MARKER.length;
}

/** Compressed-input bound for a decoded size: gzip never expands input by more than this. */
export function compressedCapFor(decodedBytes: number): number {
  return Math.ceil(decodedBytes * 1.01) + 1024;
}

/** Validate a caller-supplied content cap. */
export function assertMaxContent(maxContentBytes: number): void {
  if (!Number.isSafeInteger(maxContentBytes) || maxContentBytes <= 0)
    throw new Error('Archive content cap must be a positive whole number of bytes');
}

/** What the manifest declares about the members that follow it. */
export interface ArchiveDeclaration {
  /** Total content bytes including the manifest itself. */
  contentBytes: number;
  /** Exact decoded USTAR bytes. */
  decodedBytes: number;
  /** Every later member and its exact size. */
  members: ReadonlyMap<string, number>;
}

/** One physical file carried by the archive; `bytes` and `sha256` are the record. */
export interface ArchiveEntry {
  path: string;
  bytes: number;
  sha256: string;
}

const BLOCK_SIZE = 512;
const ZERO_BLOCK = Buffer.alloc(BLOCK_SIZE, 0);
const END_MARKER = Buffer.alloc(2 * BLOCK_SIZE, 0);
const HEX = /^[a-f0-9]{64}$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const RESERVED_CHARS = /[*?<>|":]/;
const BUILD_RECORD = /^\.viscraft\/builds\/[^/]+\.json$/;
const SNAPSHOT_METADATA = /^\.viscraft\/snapshots\/[^/]+\.(?:project|inputs)\.json$/;

/**
 * Split a logical path into a strict-USTAR `name` (<= 100 bytes) plus optional
 * `prefix` (<= 155 bytes) at a `/` boundary. Paths that cannot be expressed are
 * rejected explicitly rather than truncated or silently renamed.
 */
function splitUstarPath(logical: string): { name: string; prefix: string } {
  if (Buffer.byteLength(logical, 'utf8') <= 100) return { name: logical, prefix: '' };
  const parts = logical.split('/');
  for (let index = parts.length - 1; index >= 1; index--) {
    const prefix = parts.slice(0, index).join('/');
    const name = parts.slice(index).join('/');
    if (Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(name, 'utf8') <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(
    `Archive path cannot be represented in a strict USTAR header (name > 100 / prefix > 155 bytes): ${logical}`,
  );
}

function assertArchiveSegment(segment: string, full: string): void {
  if (segment.length === 0) throw new Error(`Archive path has an empty segment: ${full}`);
  if (segment === '.' || segment === '..') throw new Error(`Archive path has a traversal segment: ${full}`);
  if (segment.endsWith('.') || segment.endsWith(' '))
    throw new Error(`Archive path segment must not end with a dot or space: ${full}`);
  for (const character of segment) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || code === 0x7f) throw new Error(`Archive path contains a control character: ${full}`);
  }
  if (RESERVED_CHARS.test(segment) || segment.includes('\\'))
    throw new Error(`Archive path contains a reserved character: ${full}`);
  const base = segment.split('.')[0] ?? '';
  if (WINDOWS_RESERVED.test(segment) || WINDOWS_RESERVED.test(base))
    throw new Error(`Archive path uses a Windows-reserved name: ${full}`);
}

/**
 * Validate one archive member path: a safe project-relative path, valid UTF-8
 * (lone surrogates rejected), free of control / reserved characters, Windows
 * reserved names and trailing dots/spaces, and representable in a strict USTAR
 * header. The physical file name is preserved; nothing is normalized or renamed.
 */
export function assertArchivePath(logical: string): void {
  RelativePath.parse(logical);
  if (Buffer.from(logical, 'utf8').toString('utf8') !== logical) {
    throw new Error(`Archive path is not valid UTF-8 (lone surrogate): ${JSON.stringify(logical)}`);
  }
  for (const segment of logical.split('/')) assertArchiveSegment(segment, logical);
  splitUstarPath(logical);
}

/**
 * Tracks exact, case-folded and NFC-normalized collisions plus file/parent
 * (file-vs-directory) collisions. Duplicate detection is order-independent and
 * completes before any member file is created.
 */
class EntryCollisions {
  readonly #exact = new Set<string>();
  /**
   * Maps a normalized-folded prefix (`NFC(prefix).toLowerCase()`) to the exact
   * spelling and kind first seen for it. Prefixes cover both file entries and
   * every ancestor directory, so a case-folded/denormalized alias of a *file*
   * or of a *directory component* is rejected even when the full paths differ
   * (e.g. `A` + `a/x`, or `A/x` + `a/y`), which is required for cross-filesystem
   * identity when one side is case-insensitive or normalization-insensitive.
   */
  readonly #prefixes = new Map<string, { spelling: string; kind: 'file' | 'dir' }>();

  #claim(prefix: string, kind: 'file' | 'dir'): void {
    const key = prefix.normalize('NFC').toLowerCase();
    const existing = this.#prefixes.get(key);
    if (existing === undefined) {
      this.#prefixes.set(key, { spelling: prefix, kind });
      return;
    }
    if (existing.spelling !== prefix) {
      throw new Error(
        `Archive path ${prefix} collides under case folding / Unicode NFC normalization with ${existing.spelling}`,
      );
    }
    if (existing.kind !== kind) {
      throw new Error(`Archive path ${prefix} collides as both a file and a directory`);
    }
  }

  add(logical: string): void {
    if (this.#exact.has(logical)) throw new Error(`Archive lists a duplicate path: ${logical}`);
    const segments = logical.split('/');
    let prefix = '';
    for (let index = 0; index < segments.length - 1; index++) {
      prefix = prefix.length === 0 ? segments[index] : `${prefix}/${segments[index]}`;
      this.#claim(prefix, 'dir');
    }
    this.#claim(logical, 'file');
    this.#exact.add(logical);
  }
}

/**
 * Validate a complete archive file set: every path individually, then all
 * physical/logical (exact, case-fold, NFC, parent/file) collisions together.
 */
export function assertArchivePaths(paths: readonly string[]): void {
  if (!Array.isArray(paths)) throw new Error('Archive paths must be an array');
  const collisions = new EntryCollisions();
  for (const logical of paths) {
    assertArchivePath(logical);
    collisions.add(logical);
  }
}

/**
 * The maximum byte length allowed for one member, chosen from its path:
 * the manifest and JSON metadata (project / Build / frozen snapshot records) are
 * small; any other JSON (e.g. a playable recording) is bounded separately; every
 * other physical file may use the full content budget.
 */
export function archiveEntryLimit(logical: string, maxContentBytes: number): number {
  if (logical === ARCHIVE_MANIFEST) return ARCHIVE_LIMITS.manifestBytes;
  if (logical === 'project.json') return ARCHIVE_LIMITS.metadataBytes;
  if (BUILD_RECORD.test(logical)) return ARCHIVE_LIMITS.metadataBytes;
  if (SNAPSHOT_METADATA.test(logical)) return ARCHIVE_LIMITS.metadataBytes;
  if (logical.endsWith('.json')) return ARCHIVE_LIMITS.recordingBytes;
  return maxContentBytes;
}

/** Streaming SHA-256 of a file; the whole file is never buffered in memory. */
export async function hashArchiveFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  const source = createReadStream(file);
  try {
    for await (const chunk of source) hash.update(chunk as Buffer);
  } finally {
    source.destroy();
  }
  return hash.digest('hex');
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  const digits = value.toString(8);
  if (digits.length > length - 1) throw new Error(`Archive header value does not fit in ${length} bytes: ${value}`);
  target.write(digits.padStart(length - 1, '0'), offset, length - 1, 'latin1');
  target[offset + length - 1] = 0;
}

function writeHeaderString(target: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) throw new Error(`Archive header field is too long: ${value}`);
  bytes.copy(target, offset);
}

/** Deterministic strict-USTAR header: mode 0600, uid/gid/mtime 0, typeflag '0'. */
function buildUstarHeader(logical: string, size: number): Buffer {
  const { name, prefix } = splitUstarPath(logical);
  const header = Buffer.alloc(BLOCK_SIZE, 0);
  writeHeaderString(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o600);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header[156] = 0x30; // '0' regular file
  writeHeaderString(header, 257, 5, 'ustar');
  header[262] = 0; // magic NUL
  header[263] = 0x30; // '0'
  header[264] = 0x30; // '0'
  writeOctal(header, 329, 8, 0); // devmajor
  writeOctal(header, 337, 8, 0); // devminor
  writeHeaderString(header, 345, 155, prefix);
  header.fill(0x20, 148, 156); // checksum field counts as spaces
  let sum = 0;
  for (const byte of header) sum += byte;
  const checksum = sum.toString(8).padStart(6, '0');
  header.write(checksum, 148, 6, 'latin1');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

/** Strict octal field: reject base-256, non-octal digits and stray suffixes. */
function parseOctal(field: Buffer): number {
  if (field.length > 0 && (field[0] & 0x80) !== 0)
    throw new Error('Archive header uses an unsupported base-256 number');
  let index = 0;
  while (index < field.length && field[index] === 0x20) index++;
  let digits = '';
  while (index < field.length && field[index] >= 0x30 && field[index] <= 0x37) {
    digits += String.fromCharCode(field[index]);
    index++;
  }
  for (; index < field.length; index++) {
    if (field[index] !== 0 && field[index] !== 0x20) throw new Error('Archive header has an invalid numeric field');
  }
  if (digits.length === 0) return 0;
  const value = Number.parseInt(digits, 8);
  if (!Number.isSafeInteger(value)) throw new Error('Archive header numeric field is out of range');
  return value;
}

/** Strict NUL-terminated UTF-8 header string; trailing garbage and lone surrogates rejected. */
function parseHeaderString(header: Buffer, offset: number, length: number): string {
  const limit = offset + length;
  let end = offset;
  while (end < limit && header[end] !== 0) end++;
  for (let index = end; index < limit; index++) {
    if (header[index] !== 0) throw new Error('Archive header has bytes after a NUL terminator');
  }
  const bytes = header.subarray(offset, end);
  const value = bytes.toString('utf8');
  if (Buffer.from(value, 'utf8').compare(bytes) !== 0) throw new Error('Archive header path is not valid UTF-8');
  return value;
}

interface UstarMember {
  path: string;
  size: number;
}

/** Parse and strictly validate one 512-byte USTAR header. */
function parseUstarHeader(header: Buffer): UstarMember {
  let sum = 0;
  for (let index = 0; index < BLOCK_SIZE; index++) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (parseOctal(header.subarray(148, 156)) !== sum) throw new Error('Archive member header checksum mismatch');
  if (
    header[257] !== 0x75 ||
    header[258] !== 0x73 ||
    header[259] !== 0x74 ||
    header[260] !== 0x61 ||
    header[261] !== 0x72 ||
    header[262] !== 0
  ) {
    throw new Error('Archive member is not a strict USTAR entry');
  }
  if (header[263] !== 0x30 || header[264] !== 0x30) throw new Error('Archive member has an unsupported USTAR version');
  if (header[156] !== 0x30 && header[156] !== 0x00) throw new Error('Archive member is not a regular file');
  for (let index = 157; index < 257; index++) {
    if (header[index] !== 0) throw new Error('Archive member unexpectedly carries a link name');
  }
  parseOctal(header.subarray(100, 108));
  parseOctal(header.subarray(108, 116));
  parseOctal(header.subarray(116, 124));
  const size = parseOctal(header.subarray(124, 136));
  parseOctal(header.subarray(136, 148));
  parseOctal(header.subarray(329, 337));
  parseOctal(header.subarray(337, 345));
  const name = parseHeaderString(header, 0, 100);
  const prefix = parseHeaderString(header, 345, 155);
  const combined = prefix.length > 0 ? `${prefix}/${name}` : name;
  if (combined.length === 0) throw new Error('Archive member has an empty path');
  return { path: combined, size };
}

/**
 * Sequential reader over the decoded USTAR byte stream. Counts every decoded
 * byte (headers, payload, padding, end markers) against `decodedBytes` so the
 * cap is enforced live and streaming stays bounded.
 */
class ChunkReader {
  readonly #iterator: AsyncIterator<Buffer>;
  #chunk: Buffer | null = null;
  #offset = 0;
  #done = false;
  #decoded = 0;
  /** Live decoded cap; tightened to the manifest declaration once it is read. */
  decodedLimit: number;

  constructor(iterator: AsyncIterator<Buffer>, decodedLimit: number) {
    this.#iterator = iterator;
    this.decodedLimit = decodedLimit;
  }

  get decoded(): number {
    return this.#decoded;
  }

  async #next(): Promise<Buffer | null> {
    if (this.#done) return null;
    const result = await this.#iterator.next();
    if (result.done) {
      this.#done = true;
      this.#chunk = null;
      return null;
    }
    const value = result.value as Buffer;
    this.#chunk = value;
    this.#offset = 0;
    if (value.length === 0) return this.#next();
    return value;
  }

  #available(): boolean {
    return this.#chunk !== null && this.#offset < this.#chunk.length;
  }

  async #fill(): Promise<boolean> {
    while (!this.#available()) {
      if ((await this.#next()) === null) return false;
    }
    return true;
  }

  #account(read: number): void {
    this.#decoded += read;
    if (this.#decoded > this.decodedLimit) throw new Error('Archive decoded content exceeds the limit');
  }

  async readExactly(length: number): Promise<Buffer> {
    const out = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      if (!(await this.#fill())) throw new Error('Archive is truncated');
      const chunk = this.#chunk!;
      const take = Math.min(length - filled, chunk.length - this.#offset);
      chunk.copy(out, filled, this.#offset, this.#offset + take);
      this.#offset += take;
      filled += take;
      this.#account(take);
    }
    return out;
  }

  /** Read up to `target.length` bytes; fewer only at a clean EOF boundary. */
  async readInto(target: Buffer): Promise<number> {
    const want = target.length;
    let filled = 0;
    while (filled < want) {
      if (!this.#available() && (await this.#next()) === null) break;
      const chunk = this.#chunk!;
      const take = Math.min(want - filled, chunk.length - this.#offset);
      chunk.copy(target, filled, this.#offset, this.#offset + take);
      this.#offset += take;
      filled += take;
      this.#account(take);
    }
    return filled;
  }

  async atEof(): Promise<boolean> {
    if (this.#available()) return false;
    return (await this.#next()) === null;
  }
}

/** Pull exactly `size` payload bytes, hashing and (for the manifest) capturing them. */
async function* memberPayload(
  reader: ChunkReader,
  size: number,
  hash: Hash,
  captured: Buffer[] | null,
): AsyncGenerator<Buffer> {
  let remaining = size;
  while (remaining > 0) {
    const want = Math.min(remaining, 64 * 1024);
    const chunk = Buffer.allocUnsafe(want);
    if ((await reader.readInto(chunk)) !== want) throw new Error('Archive is truncated inside a member');
    hash.update(chunk);
    if (captured) captured.push(chunk);
    remaining -= want;
    yield chunk;
  }
}

/**
 * Extract one member into the caller's private staging directory, verify its
 * zero padding, and return the computed entry (and, for the manifest only, its
 * exact bytes). The file is fully closed before the caller's `accept` runs.
 */
async function extractMember(
  reader: ChunkReader,
  staging: string,
  member: UstarMember,
  isManifest: boolean,
): Promise<{ entry: ArchiveEntry; data: Buffer | null }> {
  const target = path.join(staging, ...member.path.split('/'));
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const out = createWriteStream(target, { flags: 'wx', mode: 0o600 });
  const closed = new Promise<void>((resolve, reject) => {
    out.once('error', reject);
    out.once('close', resolve);
  });
  closed.catch(() => {});
  const hash = createHash('sha256');
  const captured: Buffer[] = [];
  const source = Readable.from(memberPayload(reader, member.size, hash, isManifest ? captured : null), {
    objectMode: false,
  });
  try {
    await pipeline(source, out);
    await closed;
  } catch (error) {
    source.destroy();
    out.destroy();
    throw error;
  }
  const padding = (BLOCK_SIZE - (member.size % BLOCK_SIZE)) % BLOCK_SIZE;
  if (padding > 0) {
    const tail = await reader.readExactly(padding);
    if (!isZeroBlock(tail)) throw new Error(`Archive member has non-zero padding: ${member.path}`);
  }
  return {
    entry: { path: member.path, bytes: member.size, sha256: hash.digest('hex') },
    data: isManifest ? Buffer.concat(captured) : null,
  };
}

/**
 * Write an archive of `entries` read from `root` into `destination`.
 *
 * `root` is the staged portable export directory; `destination` must not exist
 * (created `wx`, mode 0600) — `src/operations/delivery/archive.ts` creates it as a private temp file
 * and publishes it atomically. The manifest entry is written first, remaining
 * entries follow in deterministic UTF-8 byte order, and every input is verified
 * as a regular, non-symlinked file against its recorded length and hash while it
 * is streamed. Up to and including the failure path, no whole payload is
 * buffered. The partially written destination is removed on error.
 */
export async function writeArchiveTransport(
  root: string,
  destination: string,
  entries: readonly ArchiveEntry[],
  maxContentBytes: number = DEFAULT_MAX_CONTENT_BYTES,
): Promise<{ compressedBytes: number; contentBytes: number; decodedBytes: number }> {
  assertMaxContent(maxContentBytes);
  if (typeof root !== 'string' || root.length === 0) throw new Error('Archive root must be a non-empty string');
  if (typeof destination !== 'string' || destination.length === 0)
    throw new Error('Archive destination must be a non-empty string');
  if (!Array.isArray(entries) || entries.length === 0)
    throw new Error('Archive requires at least the portable manifest entry');
  assertArchivePaths(entries.map(entry => entry.path));
  if (entries[0].path !== ARCHIVE_MANIFEST) throw new Error('Portable manifest must be the first archive entry');

  let contentBytes = 0;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0)
      throw new Error(`Archive entry has an invalid byte length: ${entry.path}`);
    if (typeof entry.sha256 !== 'string' || !HEX.test(entry.sha256))
      throw new Error(`Archive entry has an invalid hash: ${entry.path}`);
    const limit = archiveEntryLimit(entry.path, maxContentBytes);
    if (entry.bytes > limit) throw new Error(`Archive entry exceeds its size limit (${limit} bytes): ${entry.path}`);
    contentBytes += entry.bytes;
  }
  if (entries.length > ARCHIVE_LIMITS.entries) throw new Error('Archive has too many entries');
  if (contentBytes > maxContentBytes)
    throw new Error(
      `Archive content (${contentBytes} bytes) exceeds the ${maxContentBytes}-byte cap; raise it explicitly with --max-content`,
    );
  // The exact decoded size the reader will count live and hold the archive to.
  const decodedBytes = decodedBytesFor(entries.map(entry => entry.bytes));
  const compressedLimit = compressedCapFor(decodedBytes);

  const rootReal = await realpath(root);
  if (!(await lstat(rootReal)).isDirectory()) throw new Error('Archive root must be a directory');

  let destinationExists = true;
  try {
    await lstat(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') destinationExists = false;
    else throw error;
  }
  if (destinationExists) throw new Error(`Archive destination already exists: ${destination}`);

  const ordered = [
    entries[0],
    ...entries.slice(1).sort((a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8'))),
  ];

  const gzip = createGzip({ level: 9 });
  let compressedBytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      compressedBytes += chunk.length;
      if (compressedBytes > compressedLimit) {
        callback(new Error('Archive exceeds the compressed input limit'));
        return;
      }
      callback(null, chunk);
    },
  });
  const out = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  let created = false;
  out.once('open', () => {
    created = true;
  });
  let pipeFailure: unknown = null;
  const sink = pipeline(gzip, meter, out).catch(error => {
    pipeFailure = error;
  });

  try {
    for (const entry of ordered) {
      const file = await resolveArchiveInput(rootReal, entry.path);
      await writeChunk(gzip, buildUstarHeader(entry.path, entry.bytes));
      await streamEntry(gzip, file, entry);
      if (pipeFailure) throw pipeFailure;
      const padding = (BLOCK_SIZE - (entry.bytes % BLOCK_SIZE)) % BLOCK_SIZE;
      if (padding > 0) await writeChunk(gzip, ZERO_BLOCK.subarray(0, padding));
    }
    await writeChunk(gzip, END_MARKER);
    gzip.end();
    await sink;
    if (pipeFailure) throw pipeFailure;
  } catch (error) {
    gzip.destroy();
    out.destroy();
    await sink;
    if (created) await unlink(destination).catch(() => {});
    throw error;
  }

  return { compressedBytes, contentBytes, decodedBytes };
}

/** Options for {@link readArchiveTransport}. */
export interface ArchiveReadOptions {
  /** Absolute content cap; the manifest declaration may only be tighter. */
  maxContentBytes?: number;
  /** Declared compressed size (from a parts list); the input must match it exactly. */
  compressedBytes?: number;
}

/** Concatenate the input files in order as one byte stream. */
async function* concatenated(files: readonly string[]): AsyncGenerator<Buffer> {
  for (const file of files) {
    const stream = createReadStream(file);
    try {
      for await (const chunk of stream) yield chunk as Buffer;
    } finally {
      stream.destroy();
    }
  }
}

/**
 * Read a strict archive back into `staging`, invoking `accept` for each verified
 * member after its file has been closed and hashed. `input` is one archive file
 * or its ordered parts. `accept` receives the manifest bytes exactly once (for
 * the first member) and must return the manifest's {@link ArchiveDeclaration};
 * from then on every member must be declared with its exact size (checked before
 * the file is created), and content, decoded and compressed bytes are held to
 * the declaration as well as to the absolute cap. For later members `accept`
 * receives `null` and rejects hash mismatches by throwing (which aborts the read).
 *
 * The manifest must be first and no larger than `manifestBytes`; duplicate,
 * colliding, oversized or malformed members are rejected before creation.
 */
export async function readArchiveTransport(
  input: string | readonly string[],
  staging: string,
  accept: (entry: ArchiveEntry, data: Buffer | null) => Promise<ArchiveDeclaration | void>,
  options: ArchiveReadOptions = {},
): Promise<{ compressedBytes: number; contentBytes: number; decodedBytes: number; entries: ArchiveEntry[] }> {
  const files = typeof input === 'string' ? [input] : [...input];
  if (files.length === 0 || files.some(file => typeof file !== 'string' || file.length === 0))
    throw new Error('Archive path must be a non-empty string');
  if (typeof staging !== 'string' || staging.length === 0)
    throw new Error('Staging directory must be a non-empty string');
  if (typeof accept !== 'function') throw new Error('An accept callback is required');
  const maxContentBytes = options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES;
  assertMaxContent(maxContentBytes);
  let inputBytes = 0;
  for (const file of files) {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('Archive must be a regular file');
    inputBytes += info.size;
  }
  let compressedLimit = compressedCapFor(decodedCapFor(maxContentBytes));
  if (options.compressedBytes !== undefined) {
    if (options.compressedBytes !== inputBytes)
      throw new Error(`Archive input is ${inputBytes} bytes but its parts list declares ${options.compressedBytes}`);
    compressedLimit = Math.min(compressedLimit, options.compressedBytes);
  }
  if (inputBytes > compressedLimit) throw new Error('Archive exceeds the compressed input limit');
  const stagingInfo = await lstat(staging);
  if (stagingInfo.isSymbolicLink() || !stagingInfo.isDirectory())
    throw new Error('Staging must be an existing directory');

  let compressedBytes = 0;
  const fileStream = Readable.from(concatenated(files), { objectMode: false });
  const gunzip = createGunzip();
  fileStream.on('data', (chunk: Buffer) => {
    compressedBytes += chunk.length;
    if (compressedBytes > compressedLimit) fileStream.destroy(new Error('Archive exceeds the compressed input limit'));
  });
  fileStream.once('error', error => gunzip.destroy(error));
  gunzip.on('error', () => {});
  fileStream.pipe(gunzip);
  const iterator = gunzip[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const reader = new ChunkReader(iterator, decodedCapFor(maxContentBytes));

  const collisions = new EntryCollisions();
  const entries: ArchiveEntry[] = [];
  let contentBytes = 0;
  let contentLimit = maxContentBytes;
  let declared: ReadonlyMap<string, number> | null = null;

  try {
    const firstBlock = await reader.readExactly(BLOCK_SIZE);
    if (isZeroBlock(firstBlock)) throw new Error('Archive contains no members');
    let member = parseUstarHeader(firstBlock);
    if (member.path !== ARCHIVE_MANIFEST) throw new Error('Portable manifest must be the first archive member');

    while (true) {
      if (entries.length >= ARCHIVE_LIMITS.entries) throw new Error('Archive has too many members');
      assertArchivePath(member.path);
      collisions.add(member.path);
      const limit = archiveEntryLimit(member.path, maxContentBytes);
      if (member.size > limit)
        throw new Error(`Archive member exceeds its size limit (${limit} bytes): ${member.path}`);
      if (declared) {
        const size = declared.get(member.path);
        if (size === undefined) throw new Error(`Archive member is not declared by the manifest: ${member.path}`);
        if (size !== member.size)
          throw new Error(
            `Archive member size ${member.size} differs from the manifest declaration ${size}: ${member.path}`,
          );
      }
      contentBytes += member.size;
      if (contentBytes > contentLimit) throw new Error('Archive content exceeds the declared or absolute limit');

      const isManifest = member.path === ARCHIVE_MANIFEST;
      const { entry, data } = await extractMember(reader, staging, member, isManifest);
      entries.push(entry);
      const declaration = await accept(entry, data);
      if (isManifest) {
        if (!declaration) throw new Error('Archive manifest must declare its members');
        if (declaration.contentBytes > maxContentBytes)
          throw new Error(
            `Archive declares ${declaration.contentBytes} content bytes, above the ${maxContentBytes}-byte cap; raise it explicitly with --max-content`,
          );
        declared = declaration.members;
        contentLimit = declaration.contentBytes;
        reader.decodedLimit = Math.min(reader.decodedLimit, declaration.decodedBytes);
        if (options.compressedBytes === undefined)
          compressedLimit = Math.min(compressedLimit, compressedCapFor(declaration.decodedBytes));
        if (compressedBytes > compressedLimit) throw new Error('Archive exceeds the compressed input limit');
      }

      const nextBlock = await reader.readExactly(BLOCK_SIZE);
      if (isZeroBlock(nextBlock)) {
        const secondBlock = await reader.readExactly(BLOCK_SIZE);
        if (!isZeroBlock(secondBlock)) throw new Error('Archive end-of-archive marker is malformed');
        if (!(await reader.atEof())) throw new Error('Archive has decoded content after the end-of-archive marker');
        break;
      }
      member = parseUstarHeader(nextBlock);
    }
  } finally {
    fileStream.destroy();
    gunzip.destroy();
    try {
      await iterator.return?.();
    } catch {
      /* iterator teardown is best-effort */
    }
  }

  return { compressedBytes, contentBytes, decodedBytes: reader.decoded, entries };
}

/** Resolve a member path under `rootReal`, rejecting missing/symlinked/non-regular inputs. */
async function resolveArchiveInput(rootReal: string, logical: string): Promise<string> {
  const segments = logical.split('/');
  let current = rootReal;
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Archive input is missing: ${logical}`);
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`Archive input must not use symbolic links: ${logical}`);
    const last = index === segments.length - 1;
    if (last ? !info.isFile() : !info.isDirectory())
      throw new Error(`Archive input is not a regular ${last ? 'file' : 'directory'}: ${logical}`);
  }
  return current;
}

/** Write a chunk, waiting for `drain` (or a destination error/close) when backpressured. */
function writeChunk(destination: Writable, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (
      destination.destroyed ||
      destination.errored !== null ||
      destination.writableEnded ||
      destination.writableFinished
    ) {
      reject(new Error('Archive destination is no longer writable'));
      return;
    }
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Archive destination closed before the write completed'));
    };
    const cleanup = () => {
      destination.removeListener('drain', onDrain);
      destination.removeListener('error', onError);
      destination.removeListener('close', onClose);
    };
    destination.once('drain', onDrain);
    destination.once('error', onError);
    destination.once('close', onClose);
    let writable: boolean;
    try {
      writable = destination.write(chunk);
    } catch (error) {
      cleanup();
      reject(error);
      return;
    }
    if (writable) {
      cleanup();
      resolve();
    }
  });
}

/** Stream one input file into `destination`, verifying its recorded length and hash. */
async function streamEntry(destination: Writable, file: string, entry: ArchiveEntry): Promise<void> {
  const hash = createHash('sha256');
  let bytes = 0;
  const source = createReadStream(file);
  try {
    for await (const chunk of source) {
      const buffer = chunk as Buffer;
      bytes += buffer.length;
      if (bytes > entry.bytes) throw new Error(`Archive input grew beyond its recorded length: ${entry.path}`);
      hash.update(buffer);
      await writeChunk(destination, buffer);
    }
  } finally {
    source.destroy();
  }
  if (bytes !== entry.bytes) throw new Error(`Archive input length does not match its record: ${entry.path}`);
  if (hash.digest('hex') !== entry.sha256)
    throw new Error(`Archive input hash does not match its record: ${entry.path}`);
}
