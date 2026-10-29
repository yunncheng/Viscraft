/**
 * The sample-pack input declarations must match the recordings the authoring
 * module vendors: the complete file set, byte sizes and SHA-256 digests.
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const KIT = 'tests/fixtures/audio/sound-arrange/samples';

const MODULE = pathToFileURL('tests/fixtures/audio/sound-arrange/sound-arrange.mjs').href;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

test('the sample-pack declarations match the shipped recordings and their bytes', async () => {
  // `SAMPLE_FILES` is the stable file ORDER; the digest facts live on SAMPLE_PACK.
  const { SAMPLE_PACK } = (await import(MODULE)) as {
    SAMPLE_PACK: Record<string, { files: ReadonlyArray<{ file: string; bytes: number; sha256: string }> }>;
  };
  const pinned = Object.values(SAMPLE_PACK).flatMap(pack => pack.files);
  const files = (await readdir(KIT)).filter(name => name.endsWith('.wav')).sort();
  assert.deepEqual(pinned.map(entry => entry.file).sort(), files, 'module pins match the shipped recordings');
  for (const entry of pinned) {
    const bytes = await readFile(join(KIT, entry.file));
    assert.equal(entry.bytes, bytes.length, `module size for ${entry.file}`);
    assert.equal(entry.sha256, sha256(bytes), `module SHA-256 for ${entry.file}`);
  }
});
