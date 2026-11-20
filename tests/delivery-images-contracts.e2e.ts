/**
 * Delivery follows the SET OF PRODUCTS this request asks for, not whatever the
 * Project happens to contain.
 *
 * These are real-media tests: a still is captured through the Browser and a film
 * is built through FFmpeg, then delivered through the same `deliverProject` path
 * a host agent uses. The point is that a poster and a film share one Project
 * without forcing a second Project, a fake movie, or an empty `movie/` folder,
 * and that a selected still is only ever a frozen, hash-verified Build whose
 * `imageRenderKey` matches the current document.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs, renameSync, watch, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { buildProject } from '../src/build/build.js';
import { renderImage } from '../src/build/image.js';
import { deliverProject } from '../src/operations/delivery/delivery.js';
import { verifyDelivery } from '../src/operations/delivery/delivery-verification.js';
import { validateProject } from '../src/project/project.js';
import { hashFile } from '../src/shared/hash.js';

const POSTER_HTML = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="poster.css"></head>
<body><div id="card"><h1>OPENING NIGHT</h1><p>One-sheet for the short film</p></div></body></html>`;

const POSTER_CSS = `html,body{margin:0;width:120px;height:80px;overflow:hidden;background:#f2ead9}
#card{padding:10px;font-family:sans-serif;color:#2b2520}
h1{font-size:15px;margin:0 0 4px}p{margin:0;font-size:8px;color:#6f6558}`;

/** Image-only: no Composition, no film result, one document, two targets. */
function imageOnlyProject() {
  return validateProject({
    schemaVersion: 1,
    id: 'delivery_images',
    revision: 1,
    title: 'Delivery images',
    direction: {
      intent: 'Two still products from one editable document.',
      looks: [{ id: 'plain', description: 'plain' }],
      transitions: [],
    },
    assets: [],
    bindings: {},
    sources: [],
    imageDocuments: [{ id: 'poster', path: 'poster.html', resources: ['poster.css'], revision: 1 }],
    imageTargets: [
      {
        id: 'poster',
        document: 'poster',
        width: 120,
        height: 80,
        scale: 2,
        format: 'png' as const,
        background: 'opaque' as const,
      },
      {
        id: 'social',
        document: 'poster',
        width: 90,
        height: 90,
        scale: 1,
        format: 'jpeg' as const,
        background: 'opaque' as const,
      },
    ],
  });
}

/**
 * The same still products plus a real (very short) film timeline. Written only
 * AFTER the poster exists, so the tests prove adding a film later does not
 * invalidate or require re-rendering the accepted poster.
 */
function withFilm(project: ReturnType<typeof imageOnlyProject>, revision = 2) {
  return validateProject({
    ...project,
    revision,
    sources: [
      {
        id: 'src_film',
        kind: 'simulated' as const,
        prompt: 'eight-frame film for delivery coverage',
        frames: 8,
        seed: 7,
        attempt: 'attempt_film',
        behavior: 'success' as const,
      },
    ],
    composition: {
      output: { width: 160, height: 90, fps: { numerator: 25, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene_1', description: 'one scene' }],
      shots: [{ id: 'shot_1', scene: 'scene_1', look: 'plain', intent: 'one shot', targetFrames: 8 }],
      placements: [
        {
          id: 'pl_1',
          shot: 'shot_1',
          source: 'src_film',
          inFrame: 0,
          outFrame: 8,
          startFrame: 0,
          audio: 'mute' as const,
        },
      ],
      transitions: [],
      audio: [],
    },
  });
}

async function tempDir(label: string): Promise<string> {
  return fs.mkdtemp(nodePath.join(os.tmpdir(), `viscraft-${label}-`));
}

/** A real 1x1 PNG, used as declared document material for the rights test. */
const PLATE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** Author-declared rights for the still document's registered plate. */
interface PlateRights {
  origin: string;
  license: string;
  redistributable: boolean;
  author?: string;
  sourceUrl?: string;
  licenseUrl?: string;
  notice?: string;
  modifications?: string;
  attributionRequired?: boolean;
}

const PRIVATE_PLATE_RIGHTS: PlateRights = {
  origin: 'private contact-sheet plate',
  license: 'all-rights-reserved',
  notice: 'not licensed for redistribution',
  redistributable: false,
};

const ATTRIBUTION_MISSING_RIGHTS: PlateRights = {
  origin: 'contact-sheet plate',
  license: 'CC-BY-4.0',
  redistributable: true,
  attributionRequired: true,
};

const ATTRIBUTED_PLATE_RIGHTS: PlateRights = {
  origin: 'contact-sheet plate published by the photographer',
  license: 'CC-BY-4.0',
  redistributable: true,
  attributionRequired: true,
  author: 'Ada Example',
  sourceUrl: 'https://example.test/plates/contact-sheet',
  licenseUrl: 'https://example.test/licenses/cc-by-4.0',
  notice: 'Plate photo by Ada Example, used under CC BY 4.0',
};

/** The still document declares a registered Asset as real material it consumes. */
function withStillAsset(sha256: string, rights: PlateRights, simulated = false) {
  const project = imageOnlyProject();
  return validateProject({
    ...project,
    assets: [
      {
        id: 'plate',
        revision: 1,
        type: 'image' as const,
        path: 'poster-art.png',
        sha256,
        rights,
        simulated,
      },
    ],
    imageDocuments: [{ ...project.imageDocuments[0]!, resources: ['poster.css', 'poster-art.png'], revision: 2 }],
  });
}

async function writeProject(root: string, project: unknown): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(nodePath.join(root, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
}

async function writePoster(root: string): Promise<void> {
  await fs.writeFile(nodePath.join(root, 'poster.html'), POSTER_HTML);
  await fs.writeFile(nodePath.join(root, 'poster.css'), POSTER_CSS);
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(
    () => true,
    () => false,
  );
}

/** Every regular file under `dir`, as sorted `/`-separated relative paths. */
async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(nodePath.join(dir, entry.name), relative)));
    else if (entry.isFile()) out.push(relative);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/** Relative links in the static page; delivery must never point at a missing file. */
function linkedPaths(html: string): string[] {
  return [...html.matchAll(/(?:href|src)\s*=\s*"([^"]+)"/g)]
    .map(match => match[1])
    .filter(target => !target.startsWith('http') && !target.startsWith('#') && !target.startsWith('mailto:'));
}

interface ManifestFile {
  path: string;
  sha256: string;
  bytes: number;
  role: string;
  provenance?: unknown;
}

interface ManifestStill {
  target: string;
  build: string;
  artifact: string;
  path: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  format: string;
  simulated: boolean;
}

/** One Asset the still's producing Build froze for its document/resources. */
interface ManifestImageMaterial {
  target: string;
  build: string;
  document: string;
  assets: Array<{
    asset: string;
    type: string;
    path: string;
    simulated: boolean;
    rights: Record<string, unknown>;
  }>;
}

async function manifestOf(bundle: string): Promise<{
  files: ManifestFile[];
  movie: unknown;
  build: { id: string } | null;
  selection: { movie: boolean; images: string[] };
  images: ManifestStill[];
  imageMaterials: ManifestImageMaterial[];
  simulated: boolean;
  notes: string[];
}> {
  return JSON.parse(await fs.readFile(nodePath.join(bundle, 'delivery-manifest.json'), 'utf8')) as {
    files: ManifestFile[];
    movie: unknown;
    build: { id: string } | null;
    selection: { movie: boolean; images: string[] };
    images: ManifestStill[];
    imageMaterials: ManifestImageMaterial[];
    simulated: boolean;
    notes: string[];
  };
}

function pngSize(bytes: Buffer): { width: number; height: number } {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'expected a real PNG signature');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Physical bytes: the summed size of each distinct (dev, inode). */
async function physicalBytes(dir: string, excludeManifest: boolean): Promise<number> {
  const seen = new Map<string, number>();
  for (const relative of await listFiles(dir)) {
    if (excludeManifest && relative === 'delivery-manifest.json') continue;
    const info = await fs.stat(nodePath.join(dir, ...relative.split('/')), { bigint: true });
    seen.set(`${info.dev}:${info.ino}`, Number(info.size));
  }
  return [...seen.values()].reduce((sum, size) => sum + size, 0);
}

test('an image-only Project with no Composition or film result delivers only the selected still', async () => {
  const parent = await tempDir('delivery-images-only');
  const root = nodePath.join(parent, 'project');
  const bundle = nodePath.join(parent, 'bundle');
  try {
    await writeProject(root, imageOnlyProject());
    await writePoster(root);
    const poster = await renderImage(root, { target: 'poster' });

    // The fixture is a legal schemaVersion 1 Project and the still Build records
    // the standard snapshot metadata, not an image-only side database.
    for (const frozen of ['project.json', 'inputs.json'])
      assert.equal(
        await exists(nodePath.join(root, '.viscraft', 'snapshots', `${poster.build}.${frozen}`)),
        true,
        `the still Build froze ${frozen}`,
      );
    assert.deepEqual(pngSize(await fs.readFile(nodePath.join(root, ...poster.path.split('/')))), {
      width: 240,
      height: 160,
    });

    const delivery = await deliverProject(root, bundle, { outputs: { images: ['poster'] } });

    assert.equal(delivery.movie, null, 'no film was selected, so there is no movie result');
    assert.equal(delivery.build, null, 'no active film Build is claimed');
    assert.equal(delivery.review, null);
    assert.equal(delivery.audio.programme, null);
    assert.deepEqual(delivery.audio.stems, []);
    assert.equal(delivery.revision, 1);
    assert.equal(delivery.simulated, false);
    assert.ok(delivery.project, 'every handoff carries the editable Project');
    assert.equal(delivery.images.length, 1);

    const image = delivery.images[0]!;
    assert.equal(image.target, 'poster');
    assert.equal(image.build, poster.build);
    assert.equal(image.artifact, poster.artifact);
    assert.equal(image.path, 'image/poster.png');
    assert.equal(image.sha256, await hashFile(nodePath.join(root, ...poster.path.split('/'))));
    assert.equal(image.bytes, (await fs.stat(nodePath.join(root, ...poster.path.split('/')))).size);
    assert.deepEqual(
      { width: image.width, height: image.height, format: image.format },
      { width: 240, height: 160, format: 'png' },
    );
    assert.equal(await hashFile(nodePath.join(bundle, ...image.path.split('/'))), image.sha256);

    // Only what was selected exists: no empty placeholders for the other media.
    assert.deepEqual(
      (await listFiles(bundle)).filter(file => !file.startsWith('project/')),
      ['delivery-manifest.json', 'image/poster.png', 'index.html'],
    );
    assert.ok(await exists(nodePath.join(bundle, 'project', 'project.json')));
    for (const dir of ['movie', 'audio', 'review', 'playable'])
      assert.equal(await exists(nodePath.join(bundle, dir)), false, `no ${dir}/ directory is invented`);

    // The manifest marks the still with the image role and records its real bytes.
    const manifest = await manifestOf(bundle);
    const imageEntry = manifest.files.find(file => file.path === image.path);
    assert.ok(imageEntry, 'the manifest lists the delivered still');
    assert.equal(imageEntry.role, 'image');
    assert.equal(imageEntry.sha256, image.sha256);
    assert.equal(imageEntry.bytes, image.bytes);
    assert.equal(manifest.movie ?? null, null, 'the manifest does not describe a movie');
    assert.equal(manifest.build, null, 'no film Build is recorded');
    assert.deepEqual(
      manifest.selection,
      { movie: false, images: ['poster'], sounds: [] },
      'the manifest states the delivered set',
    );
    assert.deepEqual(
      manifest.images.map(recorded => ({
        target: recorded.target,
        build: recorded.build,
        artifact: recorded.artifact,
        path: recorded.path,
        sha256: recorded.sha256,
        bytes: recorded.bytes,
        width: recorded.width,
        height: recorded.height,
        format: recorded.format,
      })),
      [
        {
          target: image.target,
          build: image.build,
          artifact: image.artifact,
          path: image.path,
          sha256: image.sha256,
          bytes: image.bytes,
          width: image.width,
          height: image.height,
          format: image.format,
        },
      ],
      'each still records its target, Build, Artifact, bytes and real pixels',
    );
    assert.equal(manifest.simulated, false);

    // `verify` and the physical byte accounting work on an image-only bundle.
    const verification = await verifyDelivery(bundle);
    assert.equal(verification.ok, true);
    assert.equal(verification.mismatched.length, 0);
    assert.equal(verification.missing.length, 0);
    assert.equal(verification.unlisted.length, 0);
    assert.equal(
      delivery.logicalBytes,
      manifest.files.reduce((sum, file) => sum + file.bytes, 0),
    );
    assert.equal(delivery.bytes, await physicalBytes(bundle, true), 'bytes is the distinct (dev,inode) payload');

    // The facts page is static, names the still, and links only to real files.
    const index = await fs.readFile(nodePath.join(bundle, 'index.html'), 'utf8');
    assert.equal(/<script/i.test(index), false);
    assert.ok(index.includes('image/poster.png'), 'the page links the delivered still');
    assert.equal(index.includes('movie/final.mp4'), false, 'the page carries no missing movie link');
    assert.equal(index.includes('review/'), false, 'the page carries no movie review placeholder');
    for (const target of linkedPaths(index))
      assert.equal(await exists(nodePath.join(bundle, ...target.split('/'))), true, `linked file exists: ${target}`);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('explicit sets beat defaults: image-only, movie-only and combined on one Project', async () => {
  const parent = await tempDir('delivery-images-sets');
  const root = nodePath.join(parent, 'project');
  try {
    await writeProject(root, imageOnlyProject());
    await writePoster(root);
    const poster = await renderImage(root, { target: 'poster' });

    // Adding a film timeline later must not stale or block the accepted poster.
    await writeProject(root, withFilm(imageOnlyProject()));

    const imagesOnly = await deliverProject(root, nodePath.join(parent, 'images'), {
      outputs: { images: ['poster'] },
    });
    assert.equal(imagesOnly.movie, null);
    assert.equal(imagesOnly.images[0]!.build, poster.build, 'the still key ignores the new film sources');
    assert.equal(await exists(nodePath.join(parent, 'images', 'movie')), false);

    // With no selector the Runtime delivers every DECLARED output. The declared
    // film has no result yet, so the default refuses instead of silently
    // shipping only the stills that happen to exist. Film readiness is reported
    // before still resolution, so this is the result.json error even though the
    // second still is also not rendered yet.
    await assert.rejects(
      () => deliverProject(root, nodePath.join(parent, 'default-unbuilt'), {}),
      /no active \.viscraft\/result\.json|build a result/i,
    );
    assert.equal(await exists(nodePath.join(parent, 'default-unbuilt')), false);

    const social = await renderImage(root, { target: 'social' });
    // Every still now exists, but the declared film still has no result: the
    // default set still refuses rather than quietly shipping the stills alone.
    await assert.rejects(
      () => deliverProject(root, nodePath.join(parent, 'default-film-unbuilt'), {}),
      /no active \.viscraft\/result\.json|build a result/i,
    );
    assert.equal(await exists(nodePath.join(parent, 'default-film-unbuilt')), false);

    const film = await buildProject(root);
    assert.equal(film.status, 'succeeded');

    const all = await deliverProject(root, nodePath.join(parent, 'all'), {});
    assert.equal(all.build, film.id);
    assert.ok(all.movie, 'the default set includes the declared film');
    assert.deepEqual(
      all.images.map(image => image.target).sort(),
      ['poster', 'social'],
      'the default set includes every declared image target',
    );
    const allPoster = all.images.find(image => image.target === 'poster')!;
    const allSocial = all.images.find(image => image.target === 'social')!;
    assert.deepEqual(pngSize(await fs.readFile(nodePath.join(parent, 'all', ...allPoster.path.split('/')))), {
      width: 240,
      height: 160,
    });
    assert.equal(allSocial.format, 'jpeg');
    const allManifest = await manifestOf(nodePath.join(parent, 'all'));
    assert.deepEqual(allManifest.selection, { movie: true, images: ['poster', 'social'], sounds: [] });
    assert.equal(allManifest.build?.id, film.id);
    assert.deepEqual(
      allManifest.images.map(image => image.target),
      ['poster', 'social'],
    );
    // A bundle that also carries the film still records the frozen material of
    // each selected still (this Project has no Assets, so the records are empty
    // but present and keyed by the producing Build).
    assert.deepEqual(
      all.imageMaterials.map(material => [material.target, material.build, material.assets]),
      [
        ['poster', poster.build, []],
        ['social', social.build, []],
      ],
      'selected stills keep their material identity inside a film bundle',
    );
    assert.deepEqual(allManifest.imageMaterials, all.imageMaterials, 'the film-bundle manifest states the same facts');

    const movieOnly = await deliverProject(root, nodePath.join(parent, 'movie'), {
      outputs: { movie: true },
    });
    assert.deepEqual(movieOnly.images, []);
    assert.ok(movieOnly.movie);
    assert.equal(await exists(nodePath.join(parent, 'movie', 'image')), false, 'movie-only ships no image directory');
    const active = JSON.parse(await fs.readFile(nodePath.join(root, '.viscraft', 'result.json'), 'utf8')) as {
      sha256: string;
    };
    assert.equal(movieOnly.movie!.sha256, active.sha256);
    const movieManifest = await manifestOf(nodePath.join(parent, 'movie'));
    assert.deepEqual(movieManifest.selection, { movie: true, images: [], sounds: [] });
    assert.deepEqual(movieManifest.images, []);

    const both = await deliverProject(root, nodePath.join(parent, 'both'), {
      outputs: { movie: true, images: ['social'], sounds: [] },
    });
    assert.equal(both.images.length, 1);
    assert.equal(both.images[0]!.target, 'social');
    assert.equal(both.images[0]!.build, social.build);
    assert.equal(
      await exists(nodePath.join(parent, 'both', 'image', 'poster.png')),
      false,
      'an unselected still is not shipped',
    );
    assert.deepEqual((await manifestOf(nodePath.join(parent, 'both'))).selection, {
      movie: true,
      images: ['social'],
      sounds: [],
    });

    // A repeated target is normalised, never duplicated on disk.
    const repeated = await deliverProject(root, nodePath.join(parent, 'repeated'), {
      outputs: { images: ['poster', 'poster'] },
    });
    assert.equal(repeated.images.length, 1);
    assert.equal(
      (await listFiles(nodePath.join(parent, 'repeated'))).filter(file => /^image\/poster\./.test(file)).length,
      1,
    );

    // Explicit but empty selections are refused, not read as "all".
    await assert.rejects(
      () => deliverProject(root, nodePath.join(parent, 'empty'), { outputs: {} }),
      /no outputs|empty|select/i,
    );
    await assert.rejects(
      () => deliverProject(root, nodePath.join(parent, 'empty-images'), { outputs: { images: [] } }),
      /no outputs|empty|select/i,
    );
    await assert.rejects(
      () => deliverProject(root, nodePath.join(parent, 'unknown'), { outputs: { images: ['nope'] } }),
      /unknown image target/i,
    );
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('a stale, unrendered or reverted still is resolved by its render key, not the revision number', async () => {
  const parent = await tempDir('delivery-images-stale');
  const root = nodePath.join(parent, 'project');
  try {
    await writeProject(root, imageOnlyProject());
    await writePoster(root);
    const first = await renderImage(root, { target: 'poster' });
    const firstBytes = await fs.readFile(nodePath.join(root, ...first.path.split('/')));

    const accepted = await deliverProject(root, nodePath.join(parent, 'accepted'), {
      outputs: { images: ['poster'] },
    });
    assert.equal(accepted.images[0]!.build, first.build);

    // Edit the document WITHOUT bumping project.json revision: a revision-based
    // check would reuse stale pixels here.
    await fs.writeFile(nodePath.join(root, 'poster.html'), POSTER_HTML.replace('OPENING NIGHT', 'SECOND NIGHT'));
    const staleError = await deliverProject(root, nodePath.join(parent, 'stale'), {
      outputs: { images: ['poster'] },
    }).then(
      () => null,
      (error: Error) => error,
    );
    assert.ok(staleError, 'a stale still is refused');
    assert.match(staleError.message, /stale/i);
    assert.match(
      staleError.message,
      /--target poster|target "?poster"?/i,
      'the refusal names the target command to run',
    );
    assert.equal(await exists(nodePath.join(parent, 'stale')), false);

    // A never-rendered declared target is refused by name, never skipped.
    await assert.rejects(
      () => deliverProject(root, nodePath.join(parent, 'unrendered'), { outputs: { images: ['social'] } }),
      /not rendered|never been rendered|render/i,
    );

    // Render the edit, then revert the DOCUMENT bytes to the first version. The
    // older Build matches the current key again and is eligible.
    const second = await renderImage(root, { target: 'poster' });
    assert.notEqual(second.build, first.build);
    const secondDelivery = await deliverProject(root, nodePath.join(parent, 'second'), {
      outputs: { images: ['poster'] },
    });
    assert.equal(secondDelivery.images[0]!.build, second.build);
    assert.notEqual(secondDelivery.images[0]!.sha256, accepted.images[0]!.sha256);

    await fs.writeFile(nodePath.join(root, 'poster.html'), POSTER_HTML);
    const reverted = await deliverProject(root, nodePath.join(parent, 'reverted'), {
      outputs: { images: ['poster'] },
    });
    assert.equal(
      reverted.images[0]!.build,
      first.build,
      'reverting the source makes the older matching Build eligible',
    );
    assert.equal(reverted.images[0]!.artifact, first.artifact);
    assert.deepEqual(await fs.readFile(nodePath.join(root, ...first.path.split('/'))), firstBytes);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('a still handoff carries the Project and refuses movie-only attachments', async () => {
  const parent = await tempDir('delivery-images-study');
  const root = nodePath.join(parent, 'project');
  try {
    await writeProject(root, imageOnlyProject());
    await writePoster(root);
    await renderImage(root, { target: 'poster' });
    await renderImage(root, { target: 'social' });

    const study = await deliverProject(root, nodePath.join(parent, 'study'), {
      outputs: { images: ['poster', 'social'] },
    });
    await assert.rejects(
      deliverProject(root, nodePath.join(parent, 'review-only'), { review: true, outputs: { images: ['poster'] } }),
      /review.*movie/i,
    );
    assert.equal(study.movie, null);
    assert.equal(study.build, null);
    assert.equal(study.review, null, 'no film review is fabricated');
    assert.equal(study.audio.programme, null);
    assert.deepEqual(study.audio.stems, []);
    assert.ok(study.project, 'the handoff carries one editable Project');
    for (const dir of ['movie', 'review', 'audio'])
      assert.equal(await exists(nodePath.join(parent, 'study', dir)), false, `no empty ${dir}/`);
    assert.equal(await exists(nodePath.join(parent, 'study', 'project', 'project.json')), true);

    const page = await fs.readFile(nodePath.join(parent, 'study', 'index.html'), 'utf8');
    assert.equal(page.includes('review/'), false);
    assert.equal(page.includes('audio/'), false);
    assert.equal(page.includes('movie/final.mp4'), false);

    // `--stems` is a scope error when the movie is not part of the set.
    await assert.rejects(
      () =>
        deliverProject(root, nodePath.join(parent, 'stems'), {
          outputs: { images: ['poster'] },
          stems: true,
        }),
      /stems/i,
    );

    // The default set of a declared film + stills still ships review/audio when
    // review and stems are requested with a selected film.
    await fs.writeFile(
      nodePath.join(root, 'project.json'),
      `${JSON.stringify(withFilm(imageOnlyProject()), null, 2)}\n`,
    );
    const film = await buildProject(root);
    assert.equal(film.status, 'succeeded');
    const filmStudy = await deliverProject(root, nodePath.join(parent, 'film-study'), { review: true, stems: true });
    assert.ok(filmStudy.movie);
    assert.ok(filmStudy.review, 'a selected movie still regenerates review products');
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('a review delivery refuses a concurrent removal of the movie without publishing', async () => {
  const parent = await tempDir('delivery-images-review-race');
  const root = nodePath.join(parent, 'author');
  try {
    // A declared film plus a current still: the default selection is movie + image.
    const filmProject = withFilm(imageOnlyProject());
    await writeProject(root, filmProject);
    await writePoster(root);
    await renderImage(root, { target: 'poster' });
    await renderImage(root, { target: 'social' });
    assert.equal((await buildProject(root)).status, 'succeeded');

    // One recorded default bundle gives the repeat delivery an existing
    // destination whose bytes must survive the refusal untouched.
    await deliverProject(root, undefined, {});
    const bundle = nodePath.join(root, 'output', 'handoff');
    const manifestPath = nodePath.join(bundle, 'delivery-manifest.json');
    const manifestBefore = await hashFile(manifestPath);
    const movieBefore = await hashFile(nodePath.join(bundle, 'movie', 'final.mp4'));
    const carriedBefore = await hashFile(nodePath.join(bundle, 'project', 'project.json'));

    // The author save that removes the film while this delivery is starting.
    // `deliverProject` reads the live Project for its early guard, then creates
    // its private `output/.handoff.<uuid>.staging` directory, then takes the
    // build/author locks before `exportProject` reads the authored Project.
    // Filesystem notifications are scheduled by the platform: this rewrite may
    // reach the export before its Project read or during staged hash validation.
    // Either guard must refuse the change and leave the previous bundle intact.
    const imageOnly = validateProject({ ...filmProject, revision: 3, composition: undefined });
    const stagedProject = nodePath.join(root, 'project.race.json');
    writeFileSync(stagedProject, `${JSON.stringify(imageOnly, null, 2)}\n`);
    let rewritten = false;
    let rewriteError: unknown = null;
    const watcher = watch(nodePath.join(root, 'output'), (_event, filename) => {
      if (rewritten || filename === null || !/^\.handoff\..*\.staging$/.test(filename)) return;
      rewritten = true;
      try {
        renameSync(stagedProject, nodePath.join(root, 'project.json'));
      } catch (error) {
        rewriteError = error;
      }
    });
    try {
      await assert.rejects(
        () => deliverProject(root, undefined, { review: true }),
        /--review \/ review requires a selected movie|Staged file failed hash verification: project\.json/,
      );
    } finally {
      watcher.close();
    }
    assert.equal(rewriteError, null, 'the fixture rewrote the Project without error');
    assert.equal(rewritten, true, 'the rewrite landed after the early live guard');
    assert.equal(
      await fs.readFile(nodePath.join(root, 'project.json'), 'utf8'),
      `${JSON.stringify(imageOnly, null, 2)}\n`,
      'the concurrent image-only author edit remains intact',
    );

    // The refusal is not a partial publish: the previous bundle is intact.
    assert.equal(await hashFile(manifestPath), manifestBefore);
    assert.equal(await hashFile(nodePath.join(bundle, 'movie', 'final.mp4')), movieBefore);
    assert.equal(await hashFile(nodePath.join(bundle, 'project', 'project.json')), carriedBefore);
    assert.deepEqual(
      (await fs.readdir(nodePath.join(root, 'output'))).sort(),
      ['.gitignore', 'handoff'],
      'no staging directory or second entry is left behind',
    );
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('a handoff can be edited and re-rendered without changing the author or delivered film', async () => {
  const parent = await tempDir('delivery-images-continue');
  const root = nodePath.join(parent, 'author');
  const bundle = nodePath.join(parent, 'handoff');
  try {
    await writeProject(root, withFilm(imageOnlyProject()));
    await writePoster(root);
    const poster = await renderImage(root, { target: 'poster' });
    const film = await buildProject(root);
    assert.equal(film.status, 'succeeded');
    const active = JSON.parse(await fs.readFile(nodePath.join(root, '.viscraft', 'result.json'), 'utf8')) as {
      path: string;
    };
    const authorPoster = await hashFile(nodePath.join(root, 'poster.html'));
    const authorProject = await hashFile(nodePath.join(root, 'project.json'));
    const authorMovie = await hashFile(nodePath.join(root, ...active.path.split('/')));

    const delivery = await deliverProject(root, bundle, {
      outputs: { movie: true, images: ['poster'] },
    });
    assert.ok(delivery.movie);
    assert.equal(delivery.images[0]!.build, poster.build);
    assert.equal(delivery.images[0]!.sha256, await hashFile(nodePath.join(root, ...poster.path.split('/'))));
    const movieSha = delivery.movie!.sha256;

    // The receiver opens the carried Project in an independent directory, edits
    // the poster document and renders a new still.
    const carried = nodePath.join(bundle, 'project');
    const carriedProjectBefore = await fs.readFile(nodePath.join(carried, 'project.json'), 'utf8');
    const carriedHtml = await fs.readFile(nodePath.join(carried, 'poster.html'), 'utf8');
    assert.match(carriedHtml, /OPENING NIGHT/);
    await fs.writeFile(nodePath.join(carried, 'poster.html'), carriedHtml.replace('OPENING NIGHT', 'LATE SHOW'));
    const rerendered = await renderImage(carried, { target: 'poster' });
    assert.equal(rerendered.reused, false);
    assert.notEqual(rerendered.build, poster.build);
    assert.notEqual(rerendered.artifact, poster.artifact);
    assert.equal(await exists(nodePath.join(carried, ...rerendered.path.split('/'))), true);
    assert.equal(
      await exists(nodePath.join(root, ...rerendered.path.split('/'))),
      false,
      'the new still exists only in the receiver copy',
    );
    assert.notEqual(await hashFile(nodePath.join(carried, ...rerendered.path.split('/'))), delivery.images[0]!.sha256);
    assert.equal(await fs.readFile(nodePath.join(carried, 'project.json'), 'utf8'), carriedProjectBefore);

    // The delivered film and the original author tree are untouched.
    assert.equal(await hashFile(nodePath.join(bundle, 'movie', 'final.mp4')), movieSha);
    assert.equal(await hashFile(nodePath.join(root, 'poster.html')), authorPoster);
    assert.equal(await hashFile(nodePath.join(root, 'project.json')), authorProject);
    assert.equal(await hashFile(nodePath.join(root, ...active.path.split('/'))), authorMovie);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('handoff rights cover the whole Project and preserve selected still material facts', async () => {
  const parent = await tempDir('delivery-images-rights');
  const root = nodePath.join(parent, 'project');
  try {
    await writeProject(root, imageOnlyProject());
    await writePoster(root);
    await fs.writeFile(nodePath.join(root, 'poster-art.png'), PLATE_PNG);
    const plateSha = await hashFile(nodePath.join(root, 'poster-art.png'));

    // A private plate the selected still's document actually consumes is refused
    // on the strict path, exactly like a private film Asset.
    await writeProject(root, withStillAsset(plateSha, PRIVATE_PLATE_RIGHTS));
    await renderImage(root, { target: 'poster' });
    await assert.rejects(
      () => deliverProject(root, nodePath.join(parent, 'strict'), { outputs: { images: ['poster'] } }),
      /(?:non-redistributable|not redistributable)/i,
    );

    // Flipping the CURRENT declaration to redistributable cannot erase the
    // historical license the delivered pixels were produced under: the frozen
    // snapshot still says private.
    await writeProject(root, withStillAsset(plateSha, { ...PRIVATE_PLATE_RIGHTS, redistributable: true }));
    await assert.rejects(
      () => deliverProject(root, nodePath.join(parent, 'reflipped'), { outputs: { images: ['poster'] } }),
      /(?:non-redistributable|not redistributable)/i,
    );

    // The explicit opt-in packages the still but marks the bundle as a private
    // copy using the historical private declaration; it does not silently drop
    // the requirement.
    const optedIn = await deliverProject(root, nodePath.join(parent, 'private'), {
      outputs: { images: ['poster'] },
      allowNonRedistributable: true,
    });
    assert.equal(optedIn.containsNonRedistributableAssets, true);
    assert.deepEqual(
      optedIn.nonRedistributableAssets.map(asset => asset.asset),
      ['plate'],
    );
    const manifest = await manifestOf(nodePath.join(parent, 'private'));
    assert.equal((manifest as { containsNonRedistributableAssets?: boolean }).containsNonRedistributableAssets, true);
    assert.match(
      await fs.readFile(nodePath.join(parent, 'private', 'index.html'), 'utf8'),
      /NOT cleared for redistribution/i,
    );

    // The author-declared attribution condition is enforced for the still's own
    // material too: a required notice must actually be recorded.
    await writeProject(root, withStillAsset(plateSha, ATTRIBUTION_MISSING_RIGHTS));
    await assert.rejects(
      () =>
        deliverProject(root, nodePath.join(parent, 'attribution'), {
          outputs: { images: ['poster'] },
          allowNonRedistributable: true,
        }),
      /attributionRequired.*notice|attribution.*notice/i,
    );

    // Even an unselected private Asset is carried in the complete author Project
    // and therefore requires the explicit private-copy authorization.
    await fs.writeFile(nodePath.join(root, 'film-plate.png'), PLATE_PNG);
    const unrelated = validateProject({
      ...withFilm(imageOnlyProject()),
      assets: [
        {
          id: 'film-plate',
          revision: 1,
          type: 'image' as const,
          path: 'film-plate.png',
          sha256: await hashFile(nodePath.join(root, 'film-plate.png')),
          rights: {
            origin: 'private film material',
            license: 'all-rights-reserved',
            redistributable: false,
          },
          simulated: false,
        },
      ],
    });
    await writeProject(root, unrelated);
    const unrelatedStill = await renderImage(root, { target: 'poster' });
    await assert.rejects(
      deliverProject(root, nodePath.join(parent, 'strict-unrelated'), { outputs: { images: ['poster'] } }),
      /(?:non-redistributable|not redistributable)/i,
    );
    const stillOnly = await deliverProject(root, nodePath.join(parent, 'unrelated'), {
      outputs: { images: ['poster'] },
      allowNonRedistributable: true,
    });
    assert.equal(stillOnly.containsNonRedistributableAssets, true);
    assert.equal(stillOnly.movie, null);
    assert.equal(stillOnly.images.length, 1);
    assert.deepEqual(
      stillOnly.imageMaterials,
      [{ target: 'poster', build: unrelatedStill.build, document: 'poster.html', assets: [] }],
      'the material record is scoped to what the selected still consumed: no film Asset is invented',
    );
    assert.equal(
      JSON.stringify(await manifestOf(nodePath.join(parent, 'unrelated'))).includes('film-plate'),
      true,
      'the whole-project private material is declared',
    );
    assert.equal(
      (await fs.readFile(nodePath.join(parent, 'unrelated', 'index.html'), 'utf8')).includes('film-plate'),
      true,
      'the facts page reports the carried private material',
    );
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('a redistributable attributed plate keeps its frozen identity, notice and simulated provenance', async () => {
  const parent = await tempDir('delivery-images-attributed');
  const root = nodePath.join(parent, 'project');
  const bundle = nodePath.join(parent, 'bundle');
  try {
    await writeProject(root, imageOnlyProject());
    await writePoster(root);
    await fs.writeFile(nodePath.join(root, 'poster-art.png'), PLATE_PNG);
    const plateSha = await hashFile(nodePath.join(root, 'poster-art.png'));
    await writeProject(root, withStillAsset(plateSha, ATTRIBUTED_PLATE_RIGHTS, true));
    const poster = await renderImage(root, { target: 'poster' });

    const delivery = await deliverProject(root, bundle, { outputs: { images: ['poster'] } });
    const expected = {
      target: 'poster',
      build: poster.build,
      document: 'poster.html',
      assets: [
        { asset: 'plate', type: 'image', path: 'poster-art.png', simulated: true, rights: ATTRIBUTED_PLATE_RIGHTS },
      ],
    };
    assert.deepEqual(delivery.imageMaterials, [expected], 'the still carries the material its own Build froze');
    assert.equal(delivery.simulated, true, 'a simulated material makes the delivered set simulated-scoped');
    assert.equal(delivery.containsNonRedistributableAssets, false);

    const manifest = await manifestOf(bundle);
    assert.equal(manifest.simulated, true);
    assert.deepEqual(manifest.imageMaterials, [expected], 'the manifest states the same frozen facts as the result');

    // The facts page must actually carry the notice and identity, not only the
    // project metadata: a redistributable Asset with a required notice is a
    // delivered attribution fact.
    const index = await fs.readFile(nodePath.join(bundle, 'index.html'), 'utf8');
    assert.equal(/<script/i.test(index), false);
    assert.match(index, /Still-image materials/);
    for (const fact of [
      'plate',
      'poster-art.png',
      'CC-BY-4.0',
      'Ada Example',
      'https://example.test/plates/contact-sheet',
      'https://example.test/licenses/cc-by-4.0',
      ATTRIBUTED_PLATE_RIGHTS.notice!,
      'poster.html',
    ])
      assert.ok(index.includes(fact), `the facts page states ${JSON.stringify(fact)}`);
    assert.equal(
      index.includes('NOT cleared for redistribution'),
      false,
      'an all-redistributable still is never marked private',
    );
    assert.equal((await verifyDelivery(bundle)).ok, true);
    assert.deepEqual(
      (await listFiles(bundle)).filter(file => !file.startsWith('project/')),
      ['delivery-manifest.json', 'image/poster.png', 'index.html'],
      'material facts add no files: they are manifest/index metadata',
    );

    // A NEW current restriction still applies even though the delivered pixels
    // were rendered under redistributable rights; it is reported as a private
    // package and must not rewrite the historical material record.
    await writeProject(root, withStillAsset(plateSha, { ...ATTRIBUTED_PLATE_RIGHTS, redistributable: false }, true));
    await assert.rejects(
      () => deliverProject(root, nodePath.join(parent, 'restricted'), { outputs: { images: ['poster'] } }),
      /(?:non-redistributable|not redistributable)/i,
      'a newly declared restriction is still refused without the opt-in',
    );
    const restricted = await deliverProject(root, nodePath.join(parent, 'restricted-copy'), {
      outputs: { images: ['poster'] },
      allowNonRedistributable: true,
    });
    assert.deepEqual(
      restricted.imageMaterials,
      [expected],
      'the later private declaration does not overwrite the frozen license/notice',
    );
    assert.deepEqual(
      restricted.nonRedistributableAssets.map(asset => asset.asset),
      ['plate'],
    );
    const restrictedIndex = await fs.readFile(nodePath.join(parent, 'restricted-copy', 'index.html'), 'utf8');
    assert.match(restrictedIndex, /NOT cleared for redistribution/i);
    assert.ok(restrictedIndex.includes(ATTRIBUTED_PLATE_RIGHTS.notice!), 'the historical notice is still stated');
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('two stills record the different rights their own Builds froze for the same Asset', async () => {
  const parent = await tempDir('delivery-images-frozen-rights');
  const root = nodePath.join(parent, 'project');
  const bundle = nodePath.join(parent, 'bundle');
  try {
    await writeProject(root, imageOnlyProject());
    await writePoster(root);
    await fs.writeFile(nodePath.join(root, 'poster-art.png'), PLATE_PNG);
    const plateSha = await hashFile(nodePath.join(root, 'poster-art.png'));

    const firstRights: PlateRights = {
      ...ATTRIBUTED_PLATE_RIGHTS,
      notice: 'Plate credit frozen for the poster Build',
    };
    const secondRights: PlateRights = {
      ...ATTRIBUTED_PLATE_RIGHTS,
      notice: 'Plate credit frozen for the social Build',
    };

    await writeProject(root, withStillAsset(plateSha, firstRights));
    const poster = await renderImage(root, { target: 'poster' });

    // The Asset bytes and the document are unchanged; only the author's declared
    // notice differs. The first Build's frozen record must survive.
    await writeProject(root, withStillAsset(plateSha, secondRights));
    const social = await renderImage(root, { target: 'social' });
    assert.notEqual(social.build, poster.build);

    const delivery = await deliverProject(root, bundle, {
      outputs: { images: ['poster', 'social'] },
    });
    assert.deepEqual(
      delivery.imageMaterials.map(material => [material.target, material.build, material.assets[0]?.rights.notice]),
      [
        ['poster', poster.build, firstRights.notice],
        ['social', social.build, secondRights.notice],
      ],
      'each still keeps its own historical declaration; the later current declaration rewrites neither',
    );
    assert.deepEqual(delivery.imageMaterials[0]!.assets, [
      { asset: 'plate', type: 'image', path: 'poster-art.png', simulated: false, rights: firstRights },
    ]);

    const manifest = await manifestOf(bundle);
    assert.deepEqual(manifest.imageMaterials, delivery.imageMaterials, 'the manifest keeps both historical records');

    const index = await fs.readFile(nodePath.join(bundle, 'index.html'), 'utf8');
    assert.ok(index.includes(firstRights.notice!), 'the poster Build notice is stated');
    assert.ok(index.includes(secondRights.notice!), 'the social Build notice is stated separately');
    assert.equal((await verifyDelivery(bundle)).ok, true);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('a Project that declares no deliverable product refuses an empty default delivery', async () => {
  const parent = await tempDir('delivery-images-empty');
  const root = nodePath.join(parent, 'project');
  const bundle = nodePath.join(parent, 'bundle');
  try {
    // Written without validateProject: the schema already rejects a Project with
    // neither a composition nor an image target, and delivery must refuse it
    // before publishing an empty bundle rather than create one.
    await writeProject(root, {
      schemaVersion: 1,
      id: 'empty_project',
      revision: 1,
      title: 'Nothing to deliver',
      direction: { intent: 'no declared product', looks: [{ id: 'plain', description: 'plain' }], transitions: [] },
      assets: [],
      bindings: {},
      sources: [],
      imageDocuments: [],
      imageTargets: [],
    });
    await assert.rejects(
      () => deliverProject(root, bundle),
      /neither produces a result|declares no deliverable output|select nothing|no outputs|nothing to deliver|empty/i,
      'an empty default set is a loud refusal, never a successful empty bundle',
    );
    assert.equal(await exists(bundle), false, 'the refused delivery creates no destination');
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('image-only default delivery is replaceable only while its recorded bundle is unmodified', async () => {
  const parent = await tempDir('delivery-images-replace');
  const root = nodePath.join(parent, 'project');
  try {
    await writeProject(root, imageOnlyProject());
    await writePoster(root);
    await renderImage(root, { target: 'poster' });

    const first = await deliverProject(root, undefined, { outputs: { images: ['poster'] } });
    const second = await deliverProject(root, undefined, { outputs: { images: ['poster'] } });
    assert.equal(second.path, first.path, 'the same handoff replaces its recorded default');
    assert.equal(await hashFile(nodePath.join(first.path, 'image', 'poster.png')), second.images[0]!.sha256);

    // A hand-edited package must never be silently overwritten.
    const product = nodePath.join(first.path, 'image', 'poster.png');
    const tampered = Buffer.concat([await fs.readFile(product), Buffer.from([0])]);
    await fs.unlink(product);
    await fs.writeFile(product, tampered);
    await assert.rejects(
      () => deliverProject(root, undefined, { outputs: { images: ['poster'] } }),
      /altered|modified since it was delivered/i,
    );
    assert.equal((await fs.stat(nodePath.join(first.path, 'image', 'poster.png'))).size, second.images[0]!.bytes + 1);
    assert.deepEqual(
      (await fs.readdir(parent)).filter(entry => entry.includes('.staging')),
      [],
      'a refused replacement leaves no staging directory',
    );
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('a still selection does not bypass the complete Project dependency closure', async () => {
  const parent = await tempDir('delivery-images-film-missing');
  const root = nodePath.join(parent, 'project');
  try {
    await writeProject(root, withFilm(imageOnlyProject()));
    await writePoster(root);
    await renderImage(root, { target: 'poster' });
    const film = await buildProject(root);
    assert.equal(film.status, 'succeeded');
    const result = JSON.parse(await fs.readFile(nodePath.join(root, '.viscraft', 'result.json'), 'utf8')) as {
      path: string;
    };
    await fs.rm(nodePath.join(root, ...result.path.split('/')));

    await assert.rejects(
      deliverProject(root, nodePath.join(parent, 'still'), { outputs: { images: ['poster'] } }),
      /missing|no longer|not found|artifact|ENOENT|no such file/i,
    );

    // Selecting the film in the same broken state is still a loud failure.
    await assert.rejects(
      () => deliverProject(root, nodePath.join(parent, 'film'), { outputs: { movie: true } }),
      /missing|no longer|not found|artifact|ENOENT|no such file/i,
    );
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
