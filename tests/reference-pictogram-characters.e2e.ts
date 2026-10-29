/**
 * Directed reference test: pictogram-characters (icon-body hand-off).
 *
 * Engineering scope, not presentation approval: a short 16-frame source per
 * variant proves the declared hand-off clock, that the contact cue reacts to the
 * event timing while the body clock is held, a different icon body/prop,
 * deterministic per-frame rendering and the exported-Project takeover path.
 * Hand-to-prop contact itself is proven by the authored IK/contact frame the
 * lead reviewed, not by this pixel comparison. The authored 48-frame pacing and
 * the final look remain for the author/lead visual review.
 *
 * Implementation facts come from the study itself (`handoffAt`, create.mjs);
 * this test does not add a pose/ownership API or a test-only hook.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { openCodeScene } from '../src/backends/browser/capture.js';
import { buildProject } from '../src/build/build.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { refreshCodeAsset } from '../src/project/code-assets.js';
import { loadProject } from '../src/project/project.js';
import { authorRecipe, sha256 } from './authoring-helpers.js';

const STUDY = resolve('skills/viscraft/assets/studies/code-visuals/pictogram-characters');
const CREATE = join(STUDY, 'create.mjs');
const MODULE = join(STUDY, 'pictogram-characters.mjs');
const ENTRY = 'pictogram-scene.html';
const MODULE_NAME = 'pictogram-characters.mjs';
const WIDTH = 320;
const HEIGHT = 180;
const FRAMES = 16;
const FPS = 24;
const FRAME_BYTES = WIDTH * HEIGHT * 3;
const FIELD: [number, number, number] = [243, 238, 226];

interface Handoff {
  frame: number;
  u: number;
  frames: number;
  lastFrame: number;
  contactFrame: number;
  transferFrame: number;
  phase: string;
  contact: boolean;
  transfer: boolean;
  owner: 'sender' | 'receiver';
  contactPulse: number;
  transferPulse: number;
}

interface PictogramModule {
  DEFAULT_FRAMES: number;
  handoffAt(frame: number, options?: { frames?: number; contactFrame?: number; transferFrame?: number }): Handoff;
}

const pictogram = (await import(pathToFileURL(MODULE).href)) as unknown as PictogramModule;

function decodeFrames(file: string, count: number): Buffer {
  const result = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostdin', '-i', file, '-frames:v', String(count), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 1 << 27 },
  );
  assert.equal(result.status, 0, `ffmpeg frame decode failed: ${result.stderr?.toString() ?? ''}`);
  return result.stdout;
}

/** Fraction of pixels that differ by a loud margin. */
function changedFraction(a: Buffer, b: Buffer): number {
  assert.equal(a.length, b.length, 'compared frames must have the same size');
  let changed = 0;
  for (let i = 0; i < a.length; i += 3) {
    const distance = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (distance > 60) changed++;
  }
  return changed / (a.length / 3);
}

/** Fraction of pixels clearly off the paper field (the actors/ground are drawn). */
function contentFraction(pixels: Buffer): number {
  let drawn = 0;
  for (let i = 0; i < pixels.length; i += 3) {
    const distance =
      Math.abs(pixels[i] - FIELD[0]) + Math.abs(pixels[i + 1] - FIELD[1]) + Math.abs(pixels[i + 2] - FIELD[2]);
    if (distance > 40) drawn++;
  }
  return drawn / (pixels.length / 3);
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Fraction of changed pixels inside one screen rectangle. */
function regionChangedFraction(a: Buffer, b: Buffer, width: number, rect: Rect, threshold = 24): number {
  let changed = 0;
  let total = 0;
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      const offset = (y * width + x) * 3;
      const distance =
        Math.abs(a[offset] - b[offset]) +
        Math.abs(a[offset + 1] - b[offset + 1]) +
        Math.abs(a[offset + 2] - b[offset + 2]);
      if (distance > threshold) changed++;
      total++;
    }
  }
  return changed / total;
}

/** Decode a PNG screenshot buffer to raw RGB via ffmpeg (no PNG decoder in Node). */
function pngPixels(png: Buffer): Buffer {
  const result = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostdin', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { input: png, maxBuffer: 1 << 24 },
  );
  assert.equal(result.status, 0, `ffmpeg PNG decode failed: ${result.stderr?.toString() ?? ''}`);
  return result.stdout;
}

/** Direct lossless capture of one frame from a Project's own scene/module. */
async function captureEventFrame(
  root: string,
  params: Record<string, unknown>,
  seed: number,
  frameIndex: number,
): Promise<Buffer> {
  const scene = await openCodeScene(
    root,
    { entry: ENTRY, resources: [MODULE_NAME] },
    { width: WIDTH, height: HEIGHT },
    null,
  );
  try {
    await scene.page.evaluate(
      async payload => {
        const v = (globalThis as unknown as Record<string, { render: (a: unknown) => void }>)['viscraft'];
        v.render(payload);
      },
      {
        frame: frameIndex,
        time: frameIndex / FPS,
        fps: FPS,
        width: WIDTH,
        height: HEIGHT,
        seed,
        params,
        bindings: scene.bindings,
      },
    );
    return pngPixels(Buffer.from((await scene.page.screenshot({ type: 'png' })) as Uint8Array));
  } finally {
    await scene.close();
  }
}

// ---------------------------------------------------------------------------
// The public hand-off clock: contact, ownership flip, phases.
// ---------------------------------------------------------------------------
test('pictogram-characters: the declared hand-off clock has one contact and one ownership flip', () => {
  const first = pictogram.handoffAt(0, { frames: FRAMES });
  const contact = pictogram.handoffAt(first.contactFrame, { frames: FRAMES });
  const transfer = pictogram.handoffAt(first.transferFrame, { frames: FRAMES });

  assert.equal(first.frames, FRAMES);
  assert.ok(first.contactFrame > 0 && first.contactFrame < first.transferFrame);
  assert.ok(first.transferFrame < FRAMES - 1, 'the result hold stays inside the source');
  assert.equal(contact.contact, true);
  assert.equal(contact.transfer, false);
  assert.equal(contact.phase, 'contact');
  assert.equal(contact.owner, 'sender', 'the sender still owns the prop at contact');
  assert.ok(contact.contactPulse > 0, 'the contact cue exists on its own frame');
  assert.equal(transfer.transfer, true);
  assert.equal(transfer.owner, 'receiver', 'ownership flips exactly at the transfer frame');
  assert.equal(
    pictogram.handoffAt(first.transferFrame - 1, { frames: FRAMES }).owner,
    'sender',
    'ownership has not flipped one frame earlier',
  );
  assert.equal(contact.contactPulse, 1, 'the contact cue starts at full strength on its own frame');
  assert.equal(
    pictogram.handoffAt(first.contactFrame + 8, { frames: FRAMES }).contactPulse,
    0,
    'the contact cue decays over its declared eight frames',
  );
  assert.ok(transfer.transferPulse > 0, 'the transfer cue exists on its own frame');

  // Exactly one contact and one transfer flag across the source.
  const flags = Array.from({ length: FRAMES }, (_, frame) => pictogram.handoffAt(frame, { frames: FRAMES }));
  assert.equal(flags.filter(state => state.contact).length, 1);
  assert.equal(flags.filter(state => state.transfer).length, 1);
  assert.deepEqual(
    flags.filter(state => state.owner === 'sender').map(state => state.frame),
    Array.from({ length: first.transferFrame }, (_, frame) => frame),
  );

  // Explicit overrides are the implementation's own contract, not a test hook.
  const overridden = pictogram.handoffAt(6, { frames: 20, contactFrame: 6, transferFrame: 9 });
  assert.equal(overridden.contactFrame, 6);
  assert.equal(overridden.transferFrame, 9);
  assert.equal(overridden.contact, true);
  assert.equal(pictogram.handoffAt(6, { frames: FRAMES }).contact, false);
  assert.deepEqual(pictogram.handoffAt(7, { frames: FRAMES }), pictogram.handoffAt(7, { frames: FRAMES }));
});

// ---------------------------------------------------------------------------
// Author, build, measure the real contact/transfer/variant, and take over an export.
// ---------------------------------------------------------------------------
test('pictogram-characters: author/build shows the real hand-off, variant, determinism and export takeover', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-pictogram-'));
  const root = join(parent, 'project');
  try {
    await authorRecipe({
      recipe: CREATE,
      root,
      cwd: parent,
      options: { width: WIDTH, height: HEIGHT, frames: FRAMES },
    });

    const project = await loadProject(root);
    assert.equal(project.sources.length, 2);
    assert.deepEqual(
      project.sources.map(source => [
        source.id,
        source.kind === 'browser' ? (source.params as { variant: string }).variant : '',
      ]),
      [
        ['star_disc', 'star-disc'],
        ['cloud_baton', 'cloud-baton'],
      ],
      'the two icon-body variants are the meaningful content change',
    );
    for (const source of project.sources) {
      if (source.kind !== 'browser') throw new Error('pictogram sources must be browser picture sources');
      assert.equal(source.output, 'picture');
      assert.equal(source.entry, ENTRY);
      assert.deepEqual(source.resources, [MODULE_NAME]);
      assert.equal(source.frames, FRAMES);
    }
    assert.deepEqual(project.composition?.audio, [], 'the reference is silent; no placeholder bed');
    assert.deepEqual(
      project.assets.map(asset => [asset.id, asset.path, asset.type, asset.rights.license]).sort(),
      [
        ['pictogram_characters', MODULE_NAME, 'code', 'Apache-2.0 AND MIT'],
        ['pictogram_scene', ENTRY, 'code', 'Apache-2.0 AND MIT'],
      ],
      'both authored files are registered with the current Apache-2.0 and upstream rights',
    );
    for (const asset of project.assets)
      assert.equal(asset.sha256, sha256(await readFile(join(root, asset.path))), `${asset.path} hash is real`);
    assert.match(
      String(project.assets.find(asset => asset.id === 'pictogram_characters')!.rights.origin),
      /lemo-opuscar/,
      'the adapted origin is recorded',
    );
    assert.deepEqual(
      (project.handoff ?? []).map(file => [file.path, file.role]).sort(),
      [
        ['LICENSE-Lemo-Opuscar-MIT.txt', 'license'],
        ['LICENSES.md', 'license'],
        ['THIRD_PARTY_NOTICES.md', 'license'],
      ],
      'the upstream MIT text, the Viscraft Apache-2.0 grant and the Runtime notice travel',
    );
    assert.doesNotMatch(JSON.stringify(project), /\/lustre-data\/|\/root\/|\/tmp\//);

    // Real Browser capture; the composition carries both 16-frame sources.
    const built = await buildProject(root);
    assert.equal(built.status, 'succeeded', `the real build must succeed: ${built.error ?? ''}`);
    assert.equal(built.result?.simulated, false);
    const final = built.artifacts.find(artifact => artifact.id === built.result!.artifact)!;
    assert.equal(final.media?.frames, FRAMES * 2, 'the programme holds both shots');
    assert.equal(built.operations.filter(operation => operation.kind === 'browser').length, 2);

    const decoded = decodeFrames(join(root, final.path), FRAMES * 2);
    assert.equal(decoded.length, FRAME_BYTES * FRAMES * 2, 'every authored frame decodes');
    const frame = (index: number) => decoded.subarray(index * FRAME_BYTES, (index + 1) * FRAME_BYTES);

    const clock = pictogram.handoffAt(0, { frames: FRAMES });
    const contact = clock.contactFrame;
    const transfer = clock.transferFrame;
    const atTransfer = changedFraction(frame(transfer - 1), frame(transfer));
    const afterTransfer = changedFraction(frame(transfer), frame(transfer + 1));
    const hold = changedFraction(frame(FRAMES - 2), frame(FRAMES - 1));

    assert.ok(contentFraction(frame(contact)) > 0.02, 'the contact frame is really drawn, not a blank stage');
    assert.ok(atTransfer > 0.002, `the prop changes hands in the picture (${atTransfer.toFixed(4)})`);
    assert.ok(afterTransfer > 0.002, `the result of the transfer keeps moving (${afterTransfer.toFixed(4)})`);
    assert.ok(hold < 0.01, 'the authored result hold is calm');

    // The second variant is a different body + prop, not a recolour of one frame.
    const variantDifference = changedFraction(frame(contact), frame(FRAMES + contact));
    assert.ok(
      variantDifference > 0.05,
      `the alternate icon body/prop is a real content change (${variantDifference.toFixed(4)})`,
    );

    // Per-frame determinism/order independence for the pure-time renderer.
    const source = project.sources[0];
    if (source.kind !== 'browser') throw new Error('pictogram source must be a browser picture source');
    const scene = await openCodeScene(
      root,
      { entry: source.entry, resources: source.resources },
      { width: WIDTH, height: HEIGHT },
      null,
    );
    try {
      const args = (index: number, params: Record<string, unknown>) => ({
        frame: index,
        time: index / FPS,
        fps: FPS,
        width: WIDTH,
        height: HEIGHT,
        seed: source.seed,
        params,
        bindings: scene.bindings,
      });
      const render = async (index: number, params: Record<string, unknown> = source.params): Promise<Buffer> => {
        await scene.page.evaluate(
          async payload => {
            const v = (globalThis as unknown as Record<string, { render: (a: unknown) => Promise<void> | void }>)[
              'viscraft'
            ];
            await v.render(payload);
          },
          args(index, params),
        );
        return Buffer.from((await scene.page.screenshot({ type: 'png' })) as Uint8Array);
      };
      const first = await render(contact);
      const repeat = await render(contact);
      assert.ok(first.equals(repeat), 'the same frame renders byte-identically');
      const ordered = [contact + 1, contact + 2];
      const a1 = await render(ordered[0]);
      const a2 = await render(ordered[1]);
      const b2 = await render(ordered[1]);
      const b1 = await render(ordered[0]);
      assert.ok(a2.equals(b2) && a1.equals(b1), 'frame output is independent of sampling order');

      // The contact cue reacts to the event timing at ONE frame, with the body
      // clock held fixed. The body pose is a pure function of u/seed, so at the
      // default contact frame moving contactFrame by one (transferFrame stays
      // put) must leave the body-only region identical and change only the
      // contact cue/prop region. This does NOT independently prove hand-to-prop
      // contact; that is proven by the authored IK/contact frame reviewed by the
      // lead. It only proves the event timing reaches the decoded picture.
      const delayed = { ...source.params, contactFrame: contact + 1, transferFrame: transfer };
      const atDefaultEvent = pngPixels(await render(contact));
      const atDelayedEvent = pngPixels(await render(contact, delayed));
      assert.equal(
        regionChangedFraction(atDefaultEvent, atDelayedEvent, WIDTH, { x: 58, y: 62, width: 34, height: 62 }),
        0,
        'the body off the prop is identical when only the event timing moves',
      );
      assert.ok(
        regionChangedFraction(atDefaultEvent, atDelayedEvent, WIDTH, { x: 140, y: 78, width: 40, height: 36 }) > 0.01,
        'the contact cue/prop region reacts to the moved event timing',
      );

      // params.palette must drive the STAGE itself, not only the actors. The
      // fixed bug was a stage that ignored field/ground/line from params; this
      // samples the actual background pixels after an explicit override.
      const palette = { field: '#101820', ground: '#302418', line: '#6a5a3a', ink: '#f5f0e0' };
      const staged = await captureEventFrame(root, { ...source.params, palette }, source.seed, 0);
      const average = (x0: number, y0: number): number[] => {
        let r = 0;
        let g = 0;
        let b = 0;
        for (let dy = 0; dy < 3; dy++) {
          for (let dx = 0; dx < 3; dx++) {
            const offset = ((y0 + dy) * WIDTH + (x0 + dx)) * 3;
            r += staged[offset];
            g += staged[offset + 1];
            b += staged[offset + 2];
          }
        }
        return [r / 9, g / 9, b / 9];
      };
      const close = (actual: number[], expected: number[]): boolean =>
        actual.every((value, index) => Math.abs(value - expected[index]) <= 6);
      assert.ok(close(average(4, 4), [16, 24, 32]), 'params.palette.field drives the stage background');
      assert.ok(close(average(4, 168), [48, 36, 24]), 'params.palette.ground drives the ground band');
    } finally {
      await scene.close();
    }

    // Export takeover: edit a real code file, refresh it, rebuild, and keep the
    // original Project/module bytes untouched.
    const originalProject = await readFile(join(root, 'project.json'), 'utf8');
    const originalModule = await readFile(join(root, MODULE_NAME));
    const exportedPath = join(parent, 'exported');
    await exportProject(root, exportedPath);
    const exported = await loadProject(exportedPath);
    const exportedSource = exported.sources[0];
    if (!exportedSource || exportedSource.kind !== 'browser')
      throw new Error('the exported pictogram source must stay a browser picture source');
    const eventParams = exportedSource.params;
    const beforeEvent = await captureEventFrame(exportedPath, eventParams, exportedSource.seed, contact);

    const modulePath = join(exportedPath, MODULE_NAME);
    const moduleText = await readFile(modulePath, 'utf8');
    const editedText = moduleText.replace(/const CONTACT_FRACTION = 0\.\d+;/, 'const CONTACT_FRACTION = 0.4;');
    assert.notEqual(editedText, moduleText, 'the real code edit found the contact fraction');
    await writeFile(modulePath, editedText);
    const refreshed = await refreshCodeAsset(exportedPath, {
      assetId: 'pictogram_characters',
      expectedRevision: exported.revision,
    });
    assert.equal(refreshed.revision, 2);
    assert.equal(refreshed.sha256, sha256(Buffer.from(editedText)));

    const rebuilt = await buildProject(exportedPath);
    assert.equal(rebuilt.status, 'succeeded', `the exported Project rebuilds: ${rebuilt.error ?? ''}`);
    const rebuiltFinal = rebuilt.artifacts.find(artifact => artifact.id === rebuilt.result!.artifact)!;
    assert.equal(rebuiltFinal.media?.frames, FRAMES * 2);

    // The exported CONTACT_FRACTION edit moves the contact cue. Compare the
    // same event frame from the exported Project's OWN scene/module, captured
    // losslessly before and after the edit: the body is unchanged and only the
    // cue/prop region reacts to the edited timing. (The encoded programme is
    // separately proven to rebuild; H.264 re-encoding is not used as an
    // identity control because its quantization noise would swamp this cue.)
    const afterEvent = await captureEventFrame(exportedPath, eventParams, exportedSource.seed, contact);
    assert.equal(
      regionChangedFraction(beforeEvent, afterEvent, WIDTH, { x: 58, y: 62, width: 34, height: 62 }),
      0,
      'the exported event-timing edit leaves the body off the prop unchanged',
    );
    assert.ok(
      regionChangedFraction(beforeEvent, afterEvent, WIDTH, { x: 140, y: 78, width: 40, height: 36 }) > 0.01,
      'the exported event-timing edit changes the decoded contact cue/prop region',
    );

    assert.equal(
      await readFile(join(root, 'project.json'), 'utf8'),
      originalProject,
      'the original Project is untouched',
    );
    assert.deepEqual(
      await readFile(join(root, MODULE_NAME)),
      originalModule,
      'the original module bytes are untouched',
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
