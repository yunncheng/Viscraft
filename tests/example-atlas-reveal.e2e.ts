/**
 * E2E: the "atlas-reveal" lightweight example — two author modules composed
 * into one work, through the whole lifecycle.
 *
 * Proves, with the REAL browser capture path, that:
 *  - `create.mjs` vendors its own scene and the two module `.mjs` files
 *    byte-for-byte, registers them as `code` Assets with real sha256 and the
 *    correct MIT / Lemo / Manim rights, authors TWO `browser` picture Sources
 *    over one entry, declares the licence notice as a `license` handoff, writes
 *    no absolute host paths and submits no provider request;
 *  - `buildProject` really builds it: the final programme has the authored frame
 *    count, the reveal ADVANCES across real decoded frames, and a finished frame
 *    is not blank;
 *  - editing ONE Source's module parameter re-renders exactly that Source and
 *    REUSES the untouched Source's Take (not recaptured), and the output still
 *    builds;
 *  - a Portable export carries `THIRD_PARTY_NOTICES.md` with the MIT permission
 *    text and the rendered attribution.
 *
 * The example is deterministic (fixed seeds/frames), so the assertions are
 * stable. Builds use a tiny size and a handful of frames to stay fast.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { buildProject } from '../src/build/build.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { loadProject, saveProject } from '../src/project/project.js';
import { authorRecipe } from './authoring-helpers.js';

// The fixture owns its scene; the two modules live in their code-visual studies.
const EX_DIR = resolve('tests/fixtures/authoring/atlas-reveal');
const CW_MJS = resolve('skills/viscraft/assets/studies/code-visuals/cel-watercolor/cel-watercolor.mjs');
const TC_MJS = resolve('tests/fixtures/authoring/type-chart/type-chart.mjs');
const SCENE_MJS = join(EX_DIR, 'atlas-scene.mjs');
const SCENE_SOURCES: Record<string, string> = {
  'atlas-scene.mjs': SCENE_MJS,
  'cel-watercolor.mjs': CW_MJS,
  'type-chart.mjs': TC_MJS,
};
const ENTRY = 'atlas-scene.html';
const RESOURCES = ['atlas-scene.mjs', 'cel-watercolor.mjs', 'type-chart.mjs'];
const WIDTH = 320;
const HEIGHT = 180;
const FRAMES = 8;
const PAPER: Record<string, [number, number, number]> = { grove: [242, 234, 217], meadow: [238, 232, 220] };

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Decode up to `count` real frames of a video to raw RGB (no decoder dep in Node). */
function decodeFrames(file: string, count: number): Buffer {
  const result = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostdin', '-i', file, '-frames:v', String(count), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 1 << 27 },
  );
  assert.equal(result.status, 0, `ffmpeg decode failed for ${file}: ${result.stderr?.toString() ?? ''}`);
  return result.stdout;
}

/** Fraction of pixels that differ between two frames by more than a loud margin. */
function changedFraction(a: Buffer, b: Buffer): number {
  let changed = 0;
  for (let i = 0; i < a.length; i += 3) {
    const distance = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (distance > 60) changed++;
  }
  return changed / (a.length / 3);
}

/** Fraction of pixels visibly off the paper background (real drawn content). */
function contentFraction(pixels: Buffer, paper: [number, number, number]): number {
  let drawn = 0;
  for (let i = 0; i < pixels.length; i += 3) {
    const distance =
      Math.abs(pixels[i] - paper[0]) + Math.abs(pixels[i + 1] - paper[1]) + Math.abs(pixels[i + 2] - paper[2]);
    if (distance > 80) drawn++;
  }
  return drawn / (pixels.length / 3);
}

interface SceneModule {
  renderAtlas: (canvas: unknown, ctx?: unknown) => unknown;
}

test('the atlas-reveal scene composes both modules and rejects a missing canvas', async () => {
  // The owned scene imports its two modules as siblings, so stage them together
  // (the same layout `create.mjs` vendors into a project) before importing it.
  const staged = await mkdtemp(join(tmpdir(), 'viscraft-atlas-scene-'));
  try {
    for (const [name, from] of Object.entries(SCENE_SOURCES)) await copyFile(from, join(staged, name));
    const scene = (await import(pathToFileURL(join(staged, 'atlas-scene.mjs')).href)) as SceneModule;
    assert.equal(typeof scene.renderAtlas, 'function');
    assert.throws(() => scene.renderAtlas(null), /needs a canvas element/);
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
});

test('the full lifecycle: real build, one-parameter reuse, and a Portable export', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-atlas-'));
  const root = join(parent, 'atlas');
  try {
    // ---- 1. author with the recipe (no provider request) -------------------
    await authorRecipe({
      recipe: join(EX_DIR, 'create.mjs'),
      root,
      cwd: parent,
      options: { width: WIDTH, height: HEIGHT, frames: FRAMES },
    });

    const project = JSON.parse(await readFile(join(root, 'project.json'), 'utf8')) as {
      sources: Array<{
        id: string;
        kind: string;
        output: string;
        entry: string;
        resources: string[];
        params: { terrain: { subject: string }; legend: { layout: string } };
      }>;
      assets: Array<{
        id: string;
        path: string;
        type: string;
        sha256: string;
        rights: { license: string; redistributable: boolean; origin: string; notice?: string };
      }>;
      handoff: Array<{ path: string; role: string }>;
      composition: {
        audio: Array<
          | { id: string; kind: 'asset'; asset: string; inSample: number; durationSamples: number }
          | { id: string; kind: 'source'; source: string }
        >;
      };
    };
    assert.deepEqual(project.sources.map(s => s.id).sort(), ['atlas_close', 'atlas_open']);

    // Two browser picture Sources over one entry, combining two modules.
    assert.equal(project.sources.length, 2);
    for (const source of project.sources) {
      assert.equal(source.kind, 'browser');
      assert.equal(source.output, 'picture');
      assert.equal(source.entry, ENTRY);
      assert.deepEqual(source.resources, RESOURCES);
      assert.equal(source.params.legend.layout, 'chart');
    }
    const byId = new Map(project.sources.map(s => [s.id, s]));
    assert.equal(byId.get('atlas_open')!.params.terrain.subject, 'grove');
    assert.equal(byId.get('atlas_close')!.params.terrain.subject, 'meadow');

    // Six Assets: four code files plus the two real PCM beds. Every hash is real.
    const codeAssets = project.assets.filter(entry => entry.type === 'code');
    const audioAssets = project.assets.filter(entry => entry.type === 'audio');
    assert.equal(codeAssets.length, 4, 'four code Assets');
    assert.equal(audioAssets.length, 2, 'two PCM bed Assets');
    assert.equal(project.assets.length, 6, 'four code + two audio');
    assert.deepEqual(audioAssets.map(entry => entry.path).sort(), ['bed-high.wav', 'bed-low.wav']);
    const asset = (id: string) => project.assets.find(a => a.id === id)!;
    const cw = asset('cw_module');
    assert.equal(cw.path, 'cel-watercolor.mjs');
    assert.equal(cw.type, 'code');
    assert.equal(cw.sha256, sha256(await readFile(CW_MJS)), 'the cel-watercolor hash is real');
    assert.equal(cw.rights.license, 'Apache-2.0 AND MIT');
    assert.equal(cw.rights.redistributable, true);
    assert.match(cw.rights.origin, /lemo-opuscar/);
    const tc = asset('tc_module');
    assert.equal(tc.sha256, sha256(await readFile(TC_MJS)), 'the type-chart hash is real');
    assert.match(tc.rights.origin, /huashu-art-motion/);
    assert.match(tc.rights.notice ?? '', /Manim/, 'the Manim derivation notice is retained');
    const owned = asset('atlas_scene');
    assert.equal(
      owned.rights.license,
      'MIT',
      'the owned scene records MIT, never CC0, because it composes MIT modules',
    );

    for (const bed of audioAssets) {
      assert.equal(bed.sha256, sha256(await readFile(join(root, bed.path))), `${bed.path} hash is real`);
      assert.equal(bed.rights.license, 'CC0-1.0');
      assert.equal(bed.rights.redistributable, true);
    }
    assert.equal(project.composition.audio.length, 2, 'the two beds are placed by asset clips');
    for (const clip of project.composition.audio) {
      if (clip.kind !== 'asset') assert.fail(`bed clip ${clip.id} must be an asset clip`);
      assert.ok(
        audioAssets.some(entry => entry.id === clip.asset),
        `clip ${clip.id} points at a bed Asset`,
      );
    }

    // Vendored byte-for-byte (modules and the example's own scene).
    assert.equal(sha256(await readFile(join(root, 'cel-watercolor.mjs'))), sha256(await readFile(CW_MJS)));
    assert.equal(sha256(await readFile(join(root, 'type-chart.mjs'))), sha256(await readFile(TC_MJS)));
    assert.equal(sha256(await readFile(join(root, 'atlas-scene.mjs'))), sha256(await readFile(SCENE_MJS)));

    // Licence text carried + declared; no absolute host paths; no provider Source.
    assert.deepEqual(project.handoff, [{ path: 'THIRD_PARTY_NOTICES.md', role: 'license' }]);
    assert.match(await readFile(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8'), /Permission is hereby granted/);
    assert.doesNotMatch(JSON.stringify(project), /\/lustre-data\/|\/root\/|\/tmp\//);
    assert.ok(
      project.sources.every(s => s.kind !== 'provider'),
      'authoring submits no provider request',
    );

    // ---- 2. a REAL build through the Runtime (browser capture) -------------
    const build1 = await buildProject(root);
    assert.equal(build1.status, 'succeeded', 'the example must build with the real Runtime');
    assert.ok(build1.result, 'a succeeded build records a result');
    const final1 = build1.artifacts.find(a => a.id === build1.result!.artifact)!;
    assert.equal(final1.media!.frames, FRAMES * 2, 'the programme has both shots');

    const pixels = decodeFrames(join(root, final1.path), FRAMES * 2);
    const frameBytes = WIDTH * HEIGHT * 3;
    assert.equal(pixels.length, frameBytes * FRAMES * 2, 'every authored frame decodes');
    const frame = (index: number) => pixels.subarray(index * frameBytes, (index + 1) * frameBytes);

    // Shot 1: frames 0..7; shot 2: frames 8..15. The reveal advances.
    const shot1Change = changedFraction(frame(0), frame(FRAMES - 1));
    const shot2Change = changedFraction(frame(FRAMES), frame(FRAMES * 2 - 1));
    const shot1Content = contentFraction(frame(FRAMES - 1), PAPER.grove);
    const shot2Content = contentFraction(frame(FRAMES * 2 - 1), PAPER.meadow);
    assert.ok(shot1Change > 0.03, `shot 1 advances as the paint/legend reveal (changed ${shot1Change.toFixed(3)})`);
    assert.ok(shot2Change > 0.03, `shot 2 advances too (changed ${shot2Change.toFixed(3)})`);
    assert.ok(shot1Content > 0.03, `a finished shot-1 frame is not blank (content ${shot1Content.toFixed(3)})`);
    assert.ok(shot2Content > 0.03, `a finished shot-2 frame is not blank (content ${shot2Content.toFixed(3)})`);
    t.diagnostic(
      `real build: ${FRAMES * 2} decoded frames @ ${WIDTH}x${HEIGHT}; ` +
        `reveal changed ${shot1Change.toFixed(3)}/${shot2Change.toFixed(3)}; ` +
        `content ${shot1Content.toFixed(3)}/${shot2Content.toFixed(3)}`,
    );

    // ---- 3. edit ONE Source's module parameter and rebuild -----------------
    const before = await loadProject(root);
    const edited = structuredClone(before);
    const open = edited.sources.find(s => s.id === 'atlas_open')!;
    if (open.kind !== 'browser') throw new Error('expected browser source atlas_open');
    open.params = { ...open.params, terrain: { ...(open.params.terrain as object), azimuth: 1.1 } };
    await saveProject(root, edited, before.revision);

    const takes1 = new Map(build1.takes.map(take => [take.source, take.id] as const));
    const build2 = await buildProject(root);
    assert.equal(build2.status, 'succeeded', 'the edited example still builds');
    const codeOps = build2.operations.filter(
      operation => build2.artifacts.find(a => a.id === operation.artifact)?.operation === 'browser',
    );
    assert.equal(codeOps.filter(op => !op.reused).length, 1, 'exactly the edited Source re-renders');
    assert.equal(codeOps.filter(op => op.reused).length, 1, 'the untouched Source is reused, not recaptured');
    assert.equal(
      build2.takes.find(take => take.source === 'atlas_close')!.id,
      takes1.get('atlas_close'),
      'the untouched Source Take is preserved',
    );
    assert.notEqual(
      build2.takes.find(take => take.source === 'atlas_open')!.id,
      takes1.get('atlas_open'),
      'the edited Source produces a new Take',
    );
    assert.equal(
      build2.operations.find(op => op.kind === 'mix-audio')!.reused,
      true,
      'a picture-only edit reuses the unchanged sound mix',
    );

    // ---- 4. Portable export carries the licence text -----------------------
    const destination = join(parent, 'portable');
    const exported = await exportProject(root, destination);
    assert.ok(exported.files >= 5, 'the export packages the authored closure');
    assert.match(
      await readFile(join(destination, 'THIRD_PARTY_NOTICES.md'), 'utf8'),
      /Permission is hereby granted/,
      'the carried licence notice includes the MIT permission text',
    );
    const manifest = JSON.parse(await readFile(join(destination, '.viscraft', 'portable-manifest.json'), 'utf8')) as {
      files: Array<{ path: string }>;
    };
    assert.ok(
      manifest.files.some(file => file.path === 'THIRD_PARTY_NOTICES.md'),
      'the licence notice is recorded in the portable manifest',
    );
    const attribution = await readFile(join(destination, '.viscraft', 'pages', 'ATTRIBUTION.md'), 'utf8');
    assert.match(attribution, /lemo-opuscar/);
    assert.match(attribution, /huashu-art-motion/);
    const reopened = await loadProject(destination);
    assert.equal(reopened.sources.length, 2);
    t.diagnostic(`portable export: ${exported.files} files packaged; warnings ${exported.warnings.length}`);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
