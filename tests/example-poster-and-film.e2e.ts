/**
 * E2E: "poster and film" — one Project, three still targets and a short code
 * film, through the real Runtime, the real Browser and the workbench service.
 *
 * Proves:
 *  - `create.mjs` authors a self-contained Project: two image documents, three
 *    still targets, one film Source, a generated photograph, real OFL fonts and
 *    licence handoff files — with real sha256 Assets and no absolute host path;
 *  - the poster really uses the shipped CJK face (`document.fonts.check`), and
 *    the headline really OCCLUDES the photograph (their boxes intersect);
 *  - each still target renders a real PNG at its own pixels, and the three
 *    results are distinct artifacts that never overwrite each other;
 *  - an unchanged target is REUSED; editing one document invalidates only that
 *    document's targets (the other document still reuses);
 *  - the film builds real 640×360 frames from the same image and fonts, and
 *    building it does not disturb the still results;
 *  - the workbench saves a real edit into `poster.html` and renders it through
 *    the same production path;
 *  - a Portable export carries the sources, fonts and licence texts, and renders
 *    in an independent directory;
 *  - a failed render (a missing declared resource) leaves the previous result
 *    and its bytes intact.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { openCodeScene } from '../src/backends/browser/capture.js';
import { buildProject } from '../src/build/build.js';
import { renderImage } from '../src/build/image.js';
import { exportProject } from '../src/operations/delivery/portable.js';
import { validateProject } from '../src/project/project.js';
import { projectStatus } from '../src/project/status.js';
import { serveWorkbench } from '../src/workbench/server.js';
import { authorRecipe } from './authoring-helpers.js';

const FIXTURE = resolve('tests/fixtures/authoring/poster-and-film');
const FRAMES = 24;

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function pngSize(bytes: Buffer): { width: number; height: number } {
  assert.equal(bytes.toString('ascii', 1, 4), 'PNG', 'the bytes are a PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** The recipe returns bytes; the Runtime publishes them into a MISSING directory. */
async function author(parent: string): Promise<string> {
  const root = join(parent, 'project');
  await authorRecipe({
    recipe: join(FIXTURE, 'create.mjs'),
    root,
    cwd: parent,
    options: { frames: FRAMES },
  });
  return root;
}

function rectsOverlap(a: { x: number; y: number; width: number; height: number }, b: typeof a): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

test('one Project: three still targets, real type over a real image, and a short film', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-poster-film-'));
  const root = await author(parent);
  try {
    // ---- 1. The authored Project is really self-contained ------------------
    const project = validateProject(JSON.parse(await readFile(join(root, 'project.json'), 'utf8')));
    assert.equal(project.imageDocuments.length, 2);
    assert.deepEqual(
      project.imageTargets
        .map(target => `${target.id}:${target.width * target.scale}x${target.height * target.scale}`)
        .sort(),
      ['print:1200x1500', 'print-2x:2400x3000', 'social:1080x1080'].sort(),
    );
    assert.equal(project.sources.length, 1);
    const hero = project.sources[0];
    assert.equal(hero.kind, 'browser');
    if (hero.kind !== 'browser' || hero.output !== 'picture') assert.fail('the film Source must be a picture Source');
    assert.equal(hero.frames, FRAMES);
    assert.ok(project.composition, 'the film keeps one real composition');
    assert.equal(project.composition!.scenes.length, 1, 'the stills fabricate no Scene/Shot');

    const written = project.assets.map(asset => asset.path);
    for (const relative of [
      'film.html',
      'film.mjs',
      'assets/light.png',
      'fonts/NotoSansSC-700-subset.woff2',
      'fonts/SpaceGrotesk-700-subset.woff2',
    ])
      assert.ok(written.includes(relative), `${relative} is registered as an Asset`);
    // The DESIGN DOCUMENTS are author state, not Assets: they are edited in
    // place, so a recorded hash must not turn every edit into a build refusal.
    for (const relative of ['poster.html', 'poster.css', 'social.html', 'social.css']) {
      assert.ok(!written.includes(relative), `${relative} is a document, not an Asset`);
      assert.ok((await stat(join(root, relative))).isFile(), `${relative} exists in the Project`);
    }
    for (const asset of project.assets)
      assert.equal(asset.sha256, sha256(await readFile(join(root, asset.path))), `${asset.path} hash is real`);

    const authoredText = await readFile(join(root, 'poster.html'), 'utf8');
    assert.doesNotMatch(authoredText, /\/lustre-data\/|[A-Z]:\\/, 'no absolute host path leaks into the source');
    // The four real fonts and BOTH verbatim OFL texts travel with the Project;
    // the fixture's bytes are what was authored, not a placeholder.
    for (const name of [
      'NotoSansSC-400-subset.woff2',
      'NotoSansSC-700-subset.woff2',
      'SpaceGrotesk-400-subset.woff2',
      'SpaceGrotesk-700-subset.woff2',
    ])
      assert.equal(
        sha256(await readFile(join(root, 'fonts', name))),
        sha256(await readFile(join(FIXTURE, 'fonts', name))),
        `${name} is carried byte-for-byte`,
      );
    assert.equal(
      sha256(await readFile(join(root, 'fonts/OFL-NotoSansSC.txt'))),
      sha256(await readFile(join(FIXTURE, 'fonts/OFL-NotoSansSC.txt'))),
    );
    assert.equal(
      sha256(await readFile(join(root, 'fonts/OFL-SpaceGrotesk.txt'))),
      sha256(await readFile(join(FIXTURE, 'fonts/OFL-SpaceGrotesk.txt'))),
    );
    assert.match(await readFile(join(root, 'fonts/OFL-NotoSansSC.txt'), 'utf8'), /SIL Open Font License/);
    assert.deepEqual(
      (project.handoff ?? [])
        .filter(file => file.role === 'license')
        .map(file => file.path)
        .sort(),
      ['LICENSES.md', 'fonts/OFL-NotoSansSC.txt', 'fonts/OFL-SpaceGrotesk.txt'],
      'both verbatim OFL texts are declared license handoffs',
    );
    assert.deepEqual(project.composition?.audio, [], 'the film stays silent; no placeholder bed is authored');

    // ---- 2. The real face loads, and the headline really covers the plate --
    const posterDocument = project.imageDocuments.find(item => item.id === 'poster')!;
    const scene = await openCodeScene(
      root,
      { entry: posterDocument.path, resources: posterDocument.resources },
      { width: 1200, height: 1500 },
      null,
    );
    const layout = await (async () => {
      try {
        await scene.page.evaluate(() => document.fonts.ready);
        return await scene.page.evaluate(() => {
          const node = document.getElementById('headline') as HTMLElement;
          const plate = document.querySelector('.plate') as HTMLElement;
          const style = getComputedStyle(node);
          return {
            fontLoaded: document.fonts.check('700 152px "Archive CJK"'),
            family: style.fontFamily,
            weight: style.fontWeight,
            headline: node.getBoundingClientRect().toJSON(),
            plate: plate.getBoundingClientRect().toJSON(),
            glyphs: node.textContent,
          };
        });
      } finally {
        await scene.close();
      }
    })();
    assert.equal(layout.fontLoaded, true, 'the shipped CJK face is actually loaded');
    assert.match(layout.family, /Archive CJK/);
    assert.equal(layout.weight, '700');
    assert.equal(layout.glyphs, '光的量度');
    assert.ok(layout.headline.width > 500, 'four display glyphs are laid out, not a fallback stub');
    assert.ok(
      rectsOverlap(layout.headline, layout.plate) > 0,
      'the headline is set INTO the photograph (real occlusion)',
    );

    // ---- 3. Each target renders its own real pixels ------------------------
    const print = await renderImage(root, { target: 'print' });
    assert.deepEqual(pngSize(await readFile(join(root, ...print.path.split('/')))), { width: 1200, height: 1500 });
    const retina = await renderImage(root, { target: 'print-2x' });
    assert.deepEqual(pngSize(await readFile(join(root, ...retina.path.split('/')))), { width: 2400, height: 3000 });
    const social = await renderImage(root, { target: 'social' });
    assert.deepEqual(pngSize(await readFile(join(root, ...social.path.split('/')))), { width: 1080, height: 1080 });
    assert.equal(new Set([print.artifact, retina.artifact, social.artifact]).size, 3, 'three distinct artifacts');
    assert.equal(new Set([print.path, retina.path, social.path]).size, 3, 'three distinct files');

    // ---- 4. Reuse, and invalidation scoped to ONE document -----------------
    assert.equal((await renderImage(root, { target: 'print' })).reused, true, 'unchanged input is reused');
    const edited = (await readFile(join(root, 'poster.html'), 'utf8')).replace('光的量度', '光的重量');
    await writeFile(join(root, 'poster.html'), edited);

    // `status` locates each still by target instead of claiming there is no
    // output just because the film has no active result yet, and it reports the
    // edit as staleness BEFORE anything is re-rendered.
    const beforeRerender = (await projectStatus(root)).stills;
    assert.deepEqual(beforeRerender.map(item => `${item.target}:${item.width}x${item.height}`).sort(), [
      'print-2x:2400x3000',
      'print:1200x1500',
      'social:1080x1080',
    ]);
    assert.equal(beforeRerender.find(item => item.target === 'print')?.stale, true, 'the edited poster is stale');
    assert.equal(beforeRerender.find(item => item.target === 'social')?.stale, false, 'the social card is current');
    assert.equal(beforeRerender.find(item => item.target === 'print')?.path, print.path);

    const print2 = await renderImage(root, { target: 'print' });
    assert.equal(print2.reused, false, 'editing the poster invalidates the poster target');
    assert.notEqual(print2.artifact, print.artifact);
    assert.equal((await renderImage(root, { target: 'social' })).reused, true, 'the social card is untouched');
    assert.equal(
      (await projectStatus(root)).stills.find(item => item.target === 'print')?.stale,
      false,
      're-rendering clears the stale mark',
    );

    // ---- 5. The film builds from the same image and fonts ------------------
    const film = await buildProject(root);
    assert.equal(film.status, 'succeeded', film.error ?? '');
    const video = film.artifacts.find(artifact => artifact.kind === 'video');
    assert.ok(video, 'the film produced a real video artifact');
    assert.equal(video.media?.width, 640);
    assert.equal(video.media?.height, 360);
    assert.equal(video.media?.frames, FRAMES);
    // A decoded frame proves the picture is real, not a black leader.
    const decoded = spawnSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-nostdin',
        '-i',
        join(root, ...video.path.split('/')),
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-',
      ],
      { maxBuffer: 1 << 26 },
    );
    assert.equal(decoded.status, 0, decoded.stderr?.toString() ?? '');
    const pixels = decoded.stdout as Buffer;
    assert.equal(pixels.length, 640 * 360 * 3);
    let distinct = new Set<string>();
    for (let i = 0; i < pixels.length; i += 3 * 97) distinct.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
    assert.ok(distinct.size > 20, 'the first film frame carries a real picture');
    // The stills stay addressable after a film build: they are separate Builds.
    const status = await renderImage(root, { target: 'print' });
    assert.equal(status.artifact, print2.artifact, 'the poster result is still the poster result');

    // ---- 6. The workbench edits the SAME author source and renders it ------
    const live = await serveWorkbench(root, { document: 'poster', target: 'print' });
    // Declared outside the try so the failure-preservation check below can use it.
    const still: { path: string; artifact: string } = { path: '', artifact: '' };
    try {
      const opened = (await (
        await fetch(`http://127.0.0.1:${live.port}/api/document`, {
          headers: { 'x-viscraft-token': live.token },
        })
      ).json()) as {
        html: string;
        document: { revision: number; contentHash: string };
        result: { path: string; stale: boolean };
      };
      assert.equal(opened.result.path, print2.path);
      assert.equal(opened.result.stale, false, 'the result matches the current source');

      const next = opened.html.replace('光的重量', '光的尺度');
      const save = await fetch(`http://127.0.0.1:${live.port}/api/document`, {
        method: 'PUT',
        headers: {
          'x-viscraft-token': live.token,
          'content-type': 'application/json',
          origin: `http://127.0.0.1:${live.port}`,
        },
        body: JSON.stringify({
          document: 'poster',
          baseRevision: opened.document.revision,
          baseContentHash: opened.document.contentHash,
          html: next,
        }),
      });
      assert.equal(save.status, 200);
      assert.match(await readFile(join(root, 'poster.html'), 'utf8'), /光的尺度/);

      const rendered = await fetch(`http://127.0.0.1:${live.port}/api/render`, {
        method: 'POST',
        headers: {
          'x-viscraft-token': live.token,
          'content-type': 'application/json',
          origin: `http://127.0.0.1:${live.port}`,
        },
        body: JSON.stringify({ target: 'print' }),
      });
      assert.equal(rendered.status, 200);
      const saved = (await rendered.json()) as { path: string; artifact: string; reused: boolean };
      assert.equal(saved.reused, false);
      assert.notEqual(saved.artifact, print2.artifact);
      assert.deepEqual(pngSize(await readFile(join(root, ...saved.path.split('/')))), { width: 1200, height: 1500 });
      still.path = saved.path;
      still.artifact = saved.artifact;
    } finally {
      await live.close();
    }

    // ---- 7. Handoff: the exported copy renders with this root absent -------
    const target = await mkdtemp(join(tmpdir(), 'viscraft-poster-handoff-'));
    await rm(target, { recursive: true, force: true });
    const exported = await exportProject(root, target);
    assert.ok(exported.files > 10);
    for (const relative of ['poster.html', 'fonts/NotoSansSC-700-subset.woff2', 'LICENSES.md', 'assets/light.png'])
      assert.ok((await stat(join(exported.path, relative))).isFile(), `${relative} travels with the export`);
    const relocated = await renderImage(exported.path, { target: 'social' });
    assert.deepEqual(pngSize(await readFile(join(exported.path, ...relocated.path.split('/')))), {
      width: 1080,
      height: 1080,
    });

    // ---- 8. A failed render preserves the previous result ------------------
    const css = await readFile(join(root, 'poster.css'), 'utf8');
    await rm(join(root, 'poster.css'));
    await assert.rejects(renderImage(root, { target: 'print' }), /ENOENT|no such file/i);
    assert.ok((await stat(join(root, ...still.path.split('/')))).isFile(), 'the last good still is untouched');
    await writeFile(join(root, 'poster.css'), css);
    const recovered = await renderImage(root, { target: 'print' });
    assert.equal(recovered.artifact, still.artifact, 'restoring the resource reuses the recorded result');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
