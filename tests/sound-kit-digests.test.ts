/**
 * The sound kit's licence/provenance records must describe the REAL bytes.
 *
 * The sample fixture requires the eight pinned CC0 recordings to be checked by size and
 * SHA-256, and the two shipped records to agree with them. A malformed or
 * mistyped digest (62 hex characters, or a stale one) would ship a provenance
 * record that cannot be verified by the receiver, so it is a test, not a note.
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const KIT = 'tests/fixtures/audio/sound-arrange/samples';
const RECORDS = [join(KIT, 'LICENSE.md'), 'tests/fixtures/audio/sound-arrange/LICENSES.md'];
const MODULE = pathToFileURL('tests/fixtures/audio/sound-arrange/sound-arrange.mjs').href;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** `| \`file.wav\` | ... | 12345 | \`<64 hex>\` |` */
function recordedRows(markdown: string): Array<{ file: string; bytes: number; sha256: string }> {
  const rows: Array<{ file: string; bytes: number; sha256: string }> = [];
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^\|\s*`([^`]+\.wav)`\s*\|.*\|\s*(\d+)\s*\|\s*`([a-f0-9]{64})`\s*\|$/.exec(line);
    if (match) rows.push({ file: match[1], bytes: Number(match[2]), sha256: match[3] });
  }
  return rows;
}

test('every shipped recording matches both provenance tables byte-for-byte', async () => {
  const files = (await readdir(KIT)).filter(name => name.endsWith('.wav')).sort();
  assert.equal(files.length, 8, 'the kit ships exactly the eight pinned recordings');
  const actual = new Map<string, { bytes: number; sha256: string }>();
  for (const name of files) {
    const bytes = await readFile(join(KIT, name));
    actual.set(name, { bytes: bytes.length, sha256: sha256(bytes) });
  }
  for (const record of RECORDS) {
    const rows = recordedRows(await readFile(record, 'utf8'));
    assert.equal(rows.length, 8, `${record} lists eight recordings`);
    assert.deepEqual(rows.map(row => row.file).sort(), files, `${record} names exactly the shipped files`);
    for (const row of rows) {
      const real = actual.get(row.file)!;
      assert.equal(row.bytes, real.bytes, `${record}: ${row.file} size`);
      assert.equal(row.sha256, real.sha256, `${record}: ${row.file} SHA-256`);
    }
  }
});

test('the module verifies the same digests before it will vendor them', async () => {
  // `SAMPLE_FILES` is the stable file ORDER; the digest facts live on SAMPLE_PACK.
  const { SAMPLE_PACK } = (await import(MODULE)) as {
    SAMPLE_PACK: Record<string, { files: ReadonlyArray<{ file: string; bytes: number; sha256: string }> }>;
  };
  const pinned = Object.values(SAMPLE_PACK).flatMap(pack => pack.files);
  assert.equal(pinned.length, 8);
  for (const entry of pinned) {
    const bytes = await readFile(join(KIT, entry.file));
    assert.equal(entry.bytes, bytes.length, `module size for ${entry.file}`);
    assert.equal(entry.sha256, sha256(bytes), `module SHA-256 for ${entry.file}`);
  }
});
