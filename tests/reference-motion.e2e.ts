import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { trackReferenceMarker } from '../src/operations/analysis/reference-motion.js';
import { buildProject } from '../src/build/build.js';
import { loadProject, saveProject } from '../src/project/project.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';

test('real marker observation re-authors new pixels, preserves missing frames, and supports edit/delivery', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-track-re-author-'));
  const source = join(parent, 'source'),
    output = join(parent, 'output'),
    delivery = join(parent, 'delivery');
  try {
    await runCommand(process.execPath, [resolve('tests/fixtures/authoring/create-motion.mjs'), source]);
    const width = 64,
      height = 48,
      frames = 12,
      raw = Buffer.alloc(width * height * frames * 3);
    for (let frame = 0; frame < frames; frame++) {
      if (frame === 5) continue;
      for (let y = 20; y < 24; y++)
        for (let x = 6 + frame * 3; x < 10 + frame * 3; x++) {
          const at = ((frame * height + y) * width + x) * 3;
          raw[at] = 255;
        }
    }
    await writeFile(join(source, 'marker.rgb'), raw);
    await runCommand('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'rawvideo',
      '-pixel_format',
      'rgb24',
      '-video_size',
      `${width}x${height}`,
      '-framerate',
      '12',
      '-i',
      join(source, 'marker.rgb'),
      '-c:v',
      'ffv1',
      '-pix_fmt',
      'bgr0',
      '-threads',
      '2',
      join(source, 'marker.mkv'),
    ]);
    const before = await hashFile(join(source, 'project.json'));
    const report = await trackReferenceMarker(source, 'marker.mkv', {
      color: [255, 0, 0],
      tolerance: 10,
      fps: { numerator: 12, denominator: 1 },
    });
    assert.equal(await hashFile(join(source, 'project.json')), before);
    assert.equal(report.frames.length, 12);
    assert.equal(report.frames[5].present, false);
    assert.equal(report.frames[5].x, null);
    assert.equal(report.frames[3].matchedPixels, 16);
    assert.ok(Math.abs(report.frames[3].x! - 17 / 64) < 0.001);
    await runCommand(process.execPath, [
      resolve('tests/fixtures/authoring/create-tracked-motion.mjs'),
      join(source, report.reportPath),
      output,
    ]);
    const generated = await loadProject(output);
    generated.composition!.output.width = 96;
    generated.composition!.output.height = 64;
    await saveProject(output, generated, generated.revision);
    const built = await buildProject(output);
    assert.equal(built.result!.simulated, false);
    const artifact = built.artifacts.find(artifact => artifact.id === built.result!.artifact)!;
    assert.equal(artifact.media!.frames, 12);
    assert.equal(artifact.media!.audio!.duration, 1);
    assert.equal(
      await readFile(join(output, 'motion.json'), 'utf8')
        .then(JSON.parse)
        .then(data => data.observations[5].present),
      false,
    );
    const picture = join(output, 'pixels.raw');
    await runCommand('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-i',
      join(output, artifact.path),
      '-an',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      picture,
    ]);
    const pixels = await readFile(picture);
    const foregroundCount = (frame: number) => {
      let count = 0;
      for (let at = frame * 96 * 64 * 3; at < (frame + 1) * 96 * 64 * 3; at += 3)
        if (pixels[at + 1] > 180 && pixels[at + 2] > 180 && pixels[at] < 130) count++;
      return count;
    };
    assert.ok(
      foregroundCount(4) > foregroundCount(5) + 25,
      'missing marker hides the newly authored kite rather than inventing a tracked position',
    );
    const edit = await loadProject(output);
    edit.composition!.audio[0].gain = 0.15;
    await saveProject(output, edit, edit.revision);
    const changed = await buildProject(output);
    assert.equal(changed.operations.find(operation => operation.kind === 'browser')!.reused, true);
    assert.equal(changed.operations.find(operation => operation.kind === 'compose-video')!.reused, true);
    await exportProject(output, delivery);
    assert.ok((await buildProject(delivery)).operations.every(operation => operation.reused));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
