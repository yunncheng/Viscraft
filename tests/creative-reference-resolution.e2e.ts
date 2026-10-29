/** Native rendering of a real editable case, not just larger encoded metadata. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { openCodeScene } from '../src/backends/browser/capture.js';
import { loadProject } from '../src/project/project.js';

const CASE = resolve('skills/viscraft/assets/projects/five-more-minutes');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('Five More Minutes redraws at 720p, 1080p and 4K, with repeatable resizing and matching film provenance', async () => {
  const project = await loadProject(resolve(CASE, 'project'));
  assert.equal(project.composition!.output.width, 1920);
  assert.equal(project.composition!.output.height, 1080);
  const source = project.sources.find(candidate => candidate.id === 'cloud_08');
  assert.ok(source?.kind === 'browser');
  const scene = await openCodeScene(
    resolve(CASE, 'project'),
    source,
    { width: 1280, height: 720 },
    { label: 'nativeReference', globalName: 'viscraft' },
  );
  try {
    let first: string | undefined;
    for (const [width, height] of [
      [1280, 720],
      [1920, 1080],
      [3840, 2160],
      [1280, 720],
    ]) {
      await scene.page.setViewport({ width, height, deviceScaleFactor: 1 });
      const facts: { width: number; height: number; ink: number; font: boolean } = await scene.page.evaluate(
        async ctx => {
          const api = (window as unknown as { viscraft: { render(ctx: unknown): Promise<void> } }).viscraft;
          await api.render(ctx);
          const canvas = document.querySelector('canvas')!;
          const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
          let ink = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i] + pixels[i + 1] + pixels[i + 2] < 500 && pixels[i + 3] > 200) ink++;
          }
          return { width: canvas.width, height: canvas.height, ink, font: document.fonts.check('430 30px Story') };
        },
        {
          frame: 34,
          time: 34 / 24,
          fps: 24,
          width,
          height,
          seed: source.seed,
          params: source.params,
          bindings: scene.bindings,
        },
      );
      assert.equal(facts.width, width, 'the actual backing buffer follows the capture, not CSS enlargement');
      assert.equal(facts.height, height);
      assert.ok(facts.font, 'the real CJK font is loaded');
      assert.ok(facts.ink > width * height * 0.005, 'actual scene marks, not a blank large buffer');
      assert.deepEqual(await scene.collectDiagnostics(), [], 'no accidental canvas enlargement or font fallback');
      const png = await scene.page.screenshot({ type: 'png', captureBeyondViewport: false });
      if (width === 1280) {
        if (first) assert.equal(sha(png), first, 'resizing back retains the exact scene, paper and performance');
        else first = sha(png);
      }
      scene.assertHealthy();
    }
  } finally {
    await scene.close();
  }
  const provenance = JSON.parse(await readFile(resolve(CASE, 'review/provenance.json'), 'utf8'));
  assert.equal(sha(await readFile(resolve(CASE, 'movie/final.mp4'))), provenance.preview.sha256);
});

test('visual recipes offer native 1080p defaults while preserving intentional logical design spaces', async () => {
  const names = [
    'cel-watercolor',
    'paint-material',
    'glass-product',
    'crayon-book',
    'pictogram-characters',
    'kinetic-type',
    'rubber-hose',
    'risograph',
    'ink-wash',
    'pixel-art',
  ];
  const runtime = await import('../src/index.js');
  for (const name of names) {
    const recipe = await import(
      pathToFileURL(resolve('skills/viscraft/assets/studies/code-visuals', name, 'create.mjs')).href
    );
    const draft = await recipe.default({ root: '/tmp/viscraft-reference-default-inspection', options: {}, runtime });
    assert.equal(draft.project.composition.output.width, 1920, name);
    assert.equal(draft.project.composition.output.height, 1080, name);
    assert.ok(draft.files.length > 0, `${name} retains real author inputs`);
  }
});
