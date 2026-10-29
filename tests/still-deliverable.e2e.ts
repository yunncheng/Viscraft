/**
 * A standalone STILL-IMAGE product, produced, delivered and round-tripped.
 *
 * Delivery is movie-centric, but an approved still is a first-class product: a
 * real host PNG is registered as an image Asset, built into a held-still
 * programme, a frame of that real output is promoted to a new image Asset, and
 * that still is then delivered. The test proves provenance and redelivery
 * identity from measured bytes — not merely that an Asset record exists:
 *
 *  - the registered Asset's bytes are the host bytes at a content-addressed path;
 *  - the promoted still is a real PNG whose recorded sha256 matches its bytes,
 *    carries `derivedFrom` naming the real parent Build/Artifact/frame, and keeps
 *    the CALLER's rights verbatim (never inferred from the parent);
 *  - an unchanged rebuild after promotion reuses every operation and reproduces
 *    the same result identity;
 *  - `deliverProject` renders the still's provenance into the receiver-facing
 *    facts page (`index.html`) and `ATTRIBUTION.md`, ships its bytes under
 *    `project/`, and hashes them in `delivery-manifest.json`;
 *  - re-delivering an exported copy reproduces the same still bytes and movie.
 *
 * Requires real FFmpeg only (no browser, no provider).
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { createProject } from '../src/project/create.js';
import { loadProject, saveProject } from '../src/project/project.js';
import { importAsset } from '../src/operations/assets/import.js';
import { promoteFrame } from '../src/operations/assets/assets.js';
import { buildProject } from '../src/build/build.js';
import { deliverProject } from '../src/operations/delivery/delivery.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { ProjectSchema, type Fps, type Project } from '../src/core/schema.js';

const FPS: Fps = { numerator: 25, denominator: 1 };
const HOLD_FRAMES = 10;

// The source plate is original test media; the promoted still is a private
// approval whose rights must NOT be inherited from the plate.
const PLATE_RIGHTS = {
  origin: 'original test plate (ffmpeg testsrc2)',
  license: 'CC0-1.0',
  author: 'test fixture',
  redistributable: true,
};
const HERO_RIGHTS = {
  origin: 'promoted still from the held-still programme',
  license: 'all-rights-reserved',
  author: 'the author',
  notice: 'internal contact sheet frame',
  redistributable: true,
};

/** A real PNG host file outside the Project (a host-tool image). */
async function makeHostPng(directory: string, size = 64): Promise<string> {
  const out = nodePath.join(directory, 'plate.png');
  await runCommand('ffmpeg', [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-loglevel',
    'error',
    '-threads',
    '1',
    '-filter_threads',
    '1',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${size}x${size}:rate=1:duration=1`,
    '-frames:v',
    '1',
    '-pix_fmt',
    'rgb24',
    out,
  ]);
  return out;
}

function isPng(buffer: Buffer): boolean {
  return (
    buffer.length > 24 && buffer.toString('latin1', 1, 4) === 'PNG' && buffer.toString('latin1', 12, 16) === 'IHDR'
  );
}

/** Author a held-still programme over the registered image Asset. */
async function authorStillTimeline(root: string): Promise<void> {
  const project = await loadProject(root);
  const authored: Project = ProjectSchema.parse({
    ...project,
    sources: [],
    composition: {
      output: project.composition!.output,
      scenes: [{ id: 'scene', description: 'held still' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'default', intent: 'hold the still', targetFrames: HOLD_FRAMES }],
      placements: [
        {
          id: 'hold',
          shot: 'shot',
          asset: 'plate',
          inFrame: 0,
          outFrame: HOLD_FRAMES,
          durationFrames: HOLD_FRAMES,
          startFrame: 0,
          audio: 'mute',
        },
      ],
      transitions: [],
      audio: [],
    },
  });
  await saveProject(root, authored, project.revision);
}

const ffmpegAvailable = await runCommand('ffmpeg', ['-version']).then(
  () => true,
  () => false,
);
const skip = ffmpegAvailable ? false : 'needs FFmpeg';

test('a still image Asset is promoted, delivered with provenance and redelivered identically', { skip }, async () => {
  const parent = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'viscraft-still-e2e-'));
  const root = nodePath.join(parent, 'authoring');
  try {
    await createProject(root, {
      title: 'Still deliverable',
      output: { width: 64, height: 48, fps: FPS },
    });

    // 1. Register a real host image as a content-addressed image Asset.
    const hostPng = await makeHostPng(parent);
    const plate = await importAsset(root, {
      assetId: 'plate',
      sourcePath: hostPng,
      type: 'image',
      rights: PLATE_RIGHTS,
      expectedRevision: (await loadProject(root)).revision,
    });
    assert.equal(plate.type, 'image');
    assert.equal(
      await hashFile(nodePath.join(root, plate.path)),
      plate.sha256,
      'the asserted bytes must be the registered ones',
    );
    assert.deepEqual(plate.rights, PLATE_RIGHTS, 'the plate keeps its own rights');

    // 2. Build a held-still programme over it; the output is a real movie.
    await authorStillTimeline(root);
    const build1 = await buildProject(root);
    assert.equal(build1.status, 'succeeded', JSON.stringify(build1.error));
    assert.equal(build1.result!.simulated, false, 'an image Asset build is not simulated');
    const artifact = build1.artifacts.find(candidate => candidate.id === build1.result!.artifact)!;
    assert.equal(artifact.kind, 'video');
    assert.equal(artifact.media!.frames, HOLD_FRAMES, 'the image must be held for the authored frames');

    // 3. Promote one real frame of that Artifact into a new image Asset.
    const hero = await promoteFrame(root, {
      artifact: artifact.id,
      frame: 0,
      assetId: 'hero',
      rights: HERO_RIGHTS,
      expectedRevision: (await loadProject(root)).revision,
    });
    assert.equal(hero.type, 'image');
    assert.equal(hero.revision, 1);
    assert.match(hero.sha256, /^[a-f0-9]{64}$/);
    assert.equal(hero.path, `assets/hero-${hero.sha256.slice(0, 16)}.png`, 'the still is content-addressed');
    assert.notEqual(hero.sha256, plate.sha256, 'the promoted still is genuinely different bytes from the plate');

    const heroBytes = await fs.readFile(nodePath.join(root, hero.path));
    assert.ok(isPng(heroBytes), 'the promoted still must be a real PNG');
    assert.equal(
      await hashFile(nodePath.join(root, hero.path)),
      hero.sha256,
      'the recorded sha256 must match the bytes',
    );
    assert.deepEqual(
      hero.rights,
      HERO_RIGHTS,
      'promotion must take the caller rights verbatim, not the parent plate rights',
    );
    assert.notDeepEqual(hero.rights, plate.rights);
    assert.equal(hero.simulated, false, 'a real parent must not taint the still');
    assert.deepEqual(hero.derivedFrom, {
      kind: 'frame',
      build: build1.id,
      artifact: artifact.id,
      sha256: artifact.sha256,
      frame: 0,
    });

    // 4. Rebuild after promotion: every operation reuses; the result identity
    //    is unchanged (the still Asset is provenance, not a re-render trigger).
    const build2 = await buildProject(root);
    assert.equal(build2.status, 'succeeded');
    assert.ok(
      build2.operations.every(operation => operation.reused),
      'an unchanged rebuild must reuse everything',
    );
    assert.equal(build2.result!.artifact, build1.result!.artifact, 'the still-holding result identity is preserved');

    // 5. Deliver the still product; its provenance must reach the receiver.
    const bundle = nodePath.join(parent, 'bundle');
    const delivery = await deliverProject(root, bundle, { review: true, stems: true });
    assert.equal(delivery.movie!.sha256, await hashFile(nodePath.join(bundle, 'movie', 'final.mp4')));

    const facts = await fs.readFile(nodePath.join(bundle, 'index.html'), 'utf8');
    assert.ok(facts.includes(hero.sha256), 'the facts page must record the still sha256');
    assert.ok(facts.includes(HERO_RIGHTS.origin), 'the facts page must record the still origin');
    assert.ok(facts.includes(HERO_RIGHTS.license), 'the facts page must record the still license');
    assert.ok(
      facts.includes(`${build1.id}/${artifact.id}@0`),
      'the facts page must record the still derivedFrom provenance',
    );

    const attribution = await fs.readFile(
      nodePath.join(bundle, 'project', '.viscraft', 'pages', 'ATTRIBUTION.md'),
      'utf8',
    );
    assert.ok(attribution.includes('| hero |'), 'ATTRIBUTION.md must carry the still row');
    assert.ok(attribution.includes(HERO_RIGHTS.license), 'ATTRIBUTION.md must carry the still license');

    // The still bytes really ship and are hashed in the manifest.
    const bundledStill = nodePath.join(bundle, 'project', hero.path);
    assert.equal(await hashFile(bundledStill), hero.sha256, 'the bundled still bytes must match the asset');
    const manifest = JSON.parse(await fs.readFile(nodePath.join(bundle, 'delivery-manifest.json'), 'utf8')) as {
      files: Array<{ path: string; sha256: string; role: string }>;
    };
    const entry = manifest.files.find(file => file.path === `project/${hero.path}`);
    assert.ok(entry, 'the manifest must list the delivered still');
    assert.equal(entry!.sha256, hero.sha256);
    assert.equal(entry!.role, 'project');

    // 6. Round-trip: the exported still reopens with the same identity and
    //    re-delivers the same bytes.
    const disposable = nodePath.join(parent, 'disposable');
    await fs.cp(nodePath.join(bundle, 'project'), disposable, { recursive: true });
    const reopened = await loadProject(disposable);
    const reopenedStill = reopened.assets.find(asset => asset.id === 'hero')!;
    assert.deepEqual(reopenedStill.rights, HERO_RIGHTS, 'the exported still keeps its rights');
    assert.deepEqual(reopenedStill.derivedFrom, hero.derivedFrom, 'the exported still keeps its provenance');
    assert.equal(await hashFile(nodePath.join(disposable, reopenedStill.path)), hero.sha256);

    const rebuilt = await buildProject(disposable);
    assert.ok(
      rebuilt.operations.every(operation => operation.reused),
      'the exported still programme must rebuild with full reuse',
    );
    const bundle2 = nodePath.join(parent, 'bundle2');
    await deliverProject(disposable, bundle2, { review: true, stems: true });
    assert.equal(
      await hashFile(nodePath.join(bundle2, 'movie', 'final.mp4')),
      delivery.movie!.sha256,
      'redelivery must reproduce the same movie',
    );
    assert.equal(
      await hashFile(nodePath.join(bundle2, 'project', reopenedStill.path)),
      hero.sha256,
      'redelivery must reproduce the same still bytes',
    );
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
