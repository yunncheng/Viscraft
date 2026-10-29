/**
 * A project whose content exceeds the former fixed 500 MiB / 520 MiB archive
 * limits archives, splits and restores: the limits now come from the manifest's
 * own declaration under a 4 GiB absolute cap. The media is incompressible random
 * bytes, so the compressed archive is larger than 520 MiB as well.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { archiveProject, restoreProject } from '../src/operations/delivery/archive.js';
import { hashFile } from '../src/shared/hash.js';

const MIB = 1024 * 1024;

async function writeRandom(file: string, bytes: number): Promise<void> {
  const out = createWriteStream(file);
  for (let written = 0; written < bytes; written += 4 * MIB) {
    if (!out.write(randomBytes(Math.min(4 * MIB, bytes - written))))
      await new Promise<void>(resolve => out.once('drain', () => resolve()));
  }
  await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
}

test('a project with more than 520 MiB of incompressible content archives in parts and restores exactly', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'viscraft-archive-large-'));
  try {
    const root = path.join(parent, 'project');
    await mkdir(path.join(root, 'lib'), { recursive: true });
    await writeFile(path.join(root, 'scene.html'), '<html>large</html>');
    await writeRandom(path.join(root, 'lib', 'noise.bin'), 530 * MIB);
    const project = {
      schemaVersion: 1,
      id: 'archive-large',
      revision: 1,
      title: 'Large',
      direction: { intent: '', looks: [{ id: 'look', description: '' }], transitions: [] },
      assets: [],
      bindings: {},
      sources: [
        {
          id: 'src',
          kind: 'browser',
          output: 'picture',
          entry: 'scene.html',
          resources: ['lib/noise.bin'],
          bindings: [],
          params: {},
          seed: 0,
          frames: 1,
        },
      ],
      composition: {
        output: { width: 32, height: 32, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 },
        scenes: [{ id: 'scene', description: '' }],
        shots: [{ id: 'shot', scene: 'scene', look: 'look', intent: '', targetFrames: 1 }],
        placements: [
          { id: 'edit', shot: 'shot', source: 'src', inFrame: 0, outFrame: 1, startFrame: 0, audio: 'mute' },
        ],
        transitions: [],
        audio: [],
      },
    };
    await writeFile(path.join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);

    const archived = await archiveProject(root, path.join(parent, 'large.tar.gz'), { partSize: 200 * MIB });
    assert.ok(archived.contentBytes > 520 * MIB, 'content exceeds the former fixed limit');
    assert.ok(archived.compressedBytes > 520 * MIB, 'the compressed archive exceeds the former fixed limit');
    assert.equal(archived.parts!.length, 3);

    const restored = await restoreProject(archived.path, path.join(parent, 'restored'));
    assert.equal(restored.sha256, archived.sha256);
    for (const relative of ['project.json', 'scene.html', 'lib/noise.bin'])
      assert.equal(
        await hashFile(path.join(restored.path, ...relative.split('/'))),
        await hashFile(path.join(root, ...relative.split('/'))),
        `${relative} restores byte-identically`,
      );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
