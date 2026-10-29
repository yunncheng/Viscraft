import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { buildProject } from '../src/build/build.js';
import { loadProject, saveProject } from '../src/project/project.js';
import { importAsset } from '../src/operations/assets/import.js';
import { reviewBuild } from '../src/operations/analysis/review.js';
import { deliverProject } from '../src/operations/delivery/delivery.js';
import { hashFile } from '../src/shared/hash.js';
import { runCommand } from '../src/shared/process.js';
import { probeMedia } from '../src/backends/media/probe.js';
import type { BrowserPictureSource, BuildRecord } from '../src/core/schema.js';

const RIGHTS = {
  origin: 'Original locally authored FFmpeg graphic fixture; no external artwork',
  license: 'CC0-1.0',
  redistributable: true,
};
const OUTPUT = { width: 320, height: 180, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 2 };
const FF = ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-threads', '2', '-filter_threads', '1'];

test('reference video → measured graphic re-authoring → candidate selection → one-shot appearance revision → portable delivery', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'viscraft-reference-adaptation-'));
  const root = join(fixture, 'project'),
    delivery = join(fixture, 'delivery');
  const keep = process.env.VISCRAFT_KEEP_REFERENCE_TEST === '1';
  try {
    // Original three-colour reference at 12fps maps to 24fps. Changes are real
    // encoded cuts; no prepared report or mocked analysis result is supplied.
    await runCommand('ffmpeg', [
      ...FF,
      '-f',
      'lavfi',
      '-i',
      'color=c=0x121827:s=320x180:r=12:d=1',
      '-f',
      'lavfi',
      '-i',
      'color=c=0xe7b85c:s=320x180:r=12:d=1',
      '-f',
      'lavfi',
      '-i',
      'color=c=0x346264:s=320x180:r=12:d=1',
      '-filter_complex',
      '[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]',
      '-map',
      '[v]',
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-threads',
      '2',
      join(fixture, 'reference.mp4'),
    ]);
    for (const [name, color] of [
      ['blue', '0x285dcc'],
      ['red', '0xd33838'],
      ['green', '0x1fc85b'],
    ]) {
      await runCommand('ffmpeg', [
        ...FF,
        '-f',
        'lavfi',
        '-i',
        `color=c=${color}:s=64x64,format=rgba`,
        '-frames:v',
        '1',
        '-threads',
        '1',
        join(fixture, `${name}.png`),
      ]);
    }
    const from = { x: 0.48, y: 0.48, scale: 0.34, rotation: -12 };
    const to = { x: 0.55, y: 0.43, scale: 0.4, rotation: 12 };
    const candidate = (image: string, title: string) => ({ image, title, background: '#111827', accent: '#e7b85c' });
    const config = {
      title: 'Original graphic reference adaptation',
      output: OUTPUT,
      reference: { path: 'reference.mp4', rights: RIGHTS },
      images: [
        { id: 'blue', path: 'blue.png', rights: RIGHTS },
        {
          id: 'red',
          path: 'red.png',
          rights: RIGHTS,
          referenceRole:
            'Graphic alternative prepared with measured reference timing as context; not extracted identity',
        },
      ],
      retain: ['Three observed equal-duration graphic cuts', 'A centred composition and deliberate movement endpoints'],
      replace: ['Flat reference fields with newly authored approved-image editorial collage'],
      shots: [
        {
          segment: 0,
          observation: 'Observed dark establishing field; author a small opening drift',
          from,
          to,
          candidates: [candidate('blue', 'BEGIN / ENTRY')],
        },
        {
          segment: 1,
          observation: 'Observed bright middle field; compare two approved subject colours',
          from,
          to,
          candidates: [candidate('blue', 'SHIFT / FORM'), candidate('red', 'SHIFT / FORM')],
        },
        {
          segment: 2,
          observation: 'Observed teal closing field; return to the accepted blue identity',
          from,
          to,
          candidates: [candidate('blue', 'RETURN / CLOSURE')],
        },
      ],
    };
    await writeFile(join(fixture, 'config.json'), JSON.stringify(config));
    await runCommand(process.execPath, [
      resolve('tests/fixtures/authoring/create-reference-adaptation.mjs'),
      root,
      join(fixture, 'config.json'),
    ]);
    const created = JSON.parse(await readFile(join(root, 'adaptation-evidence.json'), 'utf8'));
    assert.equal((await loadProject(root)).sources.length, 4);
    assert.equal(created.frames, 72);
    const analysis = JSON.parse(await readFile(join(root, created.analysis), 'utf8'));
    assert.equal(analysis.media.frames, 36);
    assert.deepEqual(analysis.segments, [
      { startFrame: 0, endFrame: 24 },
      { startFrame: 24, endFrame: 48 },
      { startFrame: 48, endFrame: 72 },
    ]);
    assert.deepEqual(
      analysis.cuts.map((cut: { outputFrame: number }) => cut.outputFrame),
      [24, 48],
    );
    assert.ok(analysis.reviewFrames.length >= 7);
    let authored = await loadProject(root);
    const ref = authored.assets.find(asset => asset.id === 'reference')!;
    assert.equal(ref.type, 'video');
    assert.equal(ref.sha256, await hashFile(join(fixture, 'reference.mp4')));
    assert.equal(authored.assets.find(asset => asset.id === 'red')!.inputs![0].sha256, ref.sha256);
    assert.equal(authored.worlds, undefined);
    assert.equal(authored.composition!.placements[1].startFrame, 24);

    const first = await buildProject(root, { candidates: created.candidates });
    assert.equal(first.status, 'succeeded');
    assert.equal(first.takes.length, 4);
    assert.ok(first.takes.every(take => !take.simulated));
    const review = await reviewBuild(root);
    const middle = review.candidateComparisons.find(comparison => comparison.shot === 'shot-2')!;
    assert.equal(middle.entries.length, 2);
    assert.ok(middle.strip);

    // Host chooses red by an explicit Take selection, not by a scoring heuristic.
    const selectedIds = ['shot-1-candidate-1', 'shot-2-candidate-2', 'shot-3-candidate-1'].map(
      source => first.takes.find(take => take.source === source)!.id,
    );
    authored = await loadProject(root);
    authored.composition!.placements = authored.composition!.placements.map((placement, i) => {
      const { source: _source, ...rest } = placement;
      return { ...rest, take: selectedIds[i] };
    });
    await saveProject(root, authored, authored.revision);
    const selected = await buildProject(root, { candidates: created.candidates });
    const selectedReview = await reviewBuild(root);
    assert.equal(
      selectedReview.candidateComparisons
        .find(comparison => comparison.shot === 'shot-2')!
        .entries.find(entry => entry.selected)!.source,
      'shot-2-candidate-2',
    );
    assert.ok(
      selected.operations.filter(operation => operation.kind === 'browser').every(operation => operation.reused),
    );

    // A new image stays a distinct versioned Asset; only the middle candidate's
    // binding changes. The other two chosen Takes remain explicitly selected.
    authored = await loadProject(root);
    const green = await importAsset(root, {
      assetId: 'green',
      sourcePath: join(fixture, 'green.png'),
      type: 'image',
      rights: RIGHTS,
      expectedRevision: authored.revision,
      inputs: [{ asset: 'red', role: 'Alternate approved appearance; author keeps existing motion and layout' }],
    });
    authored = await loadProject(root);
    const source = authored.sources.find(source => source.id === 'shot-2-candidate-2') as BrowserPictureSource;
    source.bindingOverrides = { subject: green.id };
    const { take: _take, ...edit } = authored.composition!.placements[1];
    authored.composition!.placements[1] = { ...edit, source: source.id };
    await saveProject(root, authored, authored.revision);
    const revised = await buildProject(root);
    const codeOps = revised.operations.filter(operation => operation.kind === 'browser');
    assert.equal(codeOps.length, 1);
    assert.equal(codeOps[0].reused, false);
    assert.equal(revised.operations.find(operation => operation.kind === 'mix-audio')!.reused, true);
    for (const i of [0, 2])
      assert.ok(
        revised.takes.some(take => take.id === selectedIds[i]),
        'outside selected Take identities must survive',
      );
    const middleTake = revised.takes.find(take => take.source === source.id)!;
    assert.notEqual(middleTake.id, selectedIds[1]);

    const frameRgb = async (build: BuildRecord, takeId: string) => {
      const take = build.takes.find(take => take.id === takeId)!;
      const artifact = build.artifacts.find(artifact => artifact.id === take.artifact)!;
      const destination = join(fixture, `${takeId}.rgb`);
      await runCommand('ffmpeg', [
        ...FF,
        '-i',
        join(root, artifact.path),
        '-vf',
        'select=eq(n\\,12)',
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        destination,
      ]);
      const bytes = await readFile(destination),
        offset = (Math.round(0.455 * OUTPUT.height) * OUTPUT.width + Math.round(0.515 * OUTPUT.width)) * 3;
      return [...bytes.subarray(offset, offset + 3)];
    };
    const before = await frameRgb(selected, selectedIds[1]),
      after = await frameRgb(revised, middleTake.id);
    assert.ok(before[0] > 150 && before[1] < 90, `actual prior middle image must be red: ${before}`);
    assert.ok(after[1] > 150 && after[0] < 90, `actual revised middle image must be green: ${after}`);
    const bundled = await deliverProject(root, delivery, { review: true, stems: true });
    assert.equal(bundled.simulated, false);
    assert.equal(
      await hashFile(join(delivery, bundled.movie!.path)),
      revised.artifacts.find(artifact => artifact.id === revised.result!.artifact)!.sha256,
    );
    const media = await probeMedia(join(delivery, bundled.movie!.path));
    assert.equal(media.frames, 72);
    assert.ok(media.audio);
    assert.equal(media.width, OUTPUT.width);
    const reopened = await buildProject(join(delivery, 'project'));
    assert.ok(
      reopened.operations.every(operation => operation.reused),
      'delivered editable project should reopen without recapture or remixing',
    );
    const frozen = await loadProject(join(delivery, 'project'));
    assert.equal(frozen.assets.find(asset => asset.id === 'green')!.inputs![0].asset, 'red');
    assert.equal(frozen.assets.find(asset => asset.id === 'red')!.inputs![0].asset, 'reference');
    // Private references may guide a new work without becoming public assets.
    // This uses the same measured-input authoring route, not a hand-edited
    // export manifest or a skip of redistribution checks.
    const privateRoot = join(fixture, 'private-reference-project'),
      privateDelivery = join(fixture, 'private-reference-delivery');
    const privateConfig = {
      ...config,
      reference: {
        ...config.reference,
        rights: {
          ...RIGHTS,
          origin: 'Original private timing reference; analysis permission only',
          redistributable: false,
        },
      },
      shots: [config.shots[0]],
    };
    await writeFile(join(fixture, 'private-config.json'), JSON.stringify(privateConfig));
    await runCommand(process.execPath, [
      resolve('tests/fixtures/authoring/create-reference-adaptation.mjs'),
      privateRoot,
      join(fixture, 'private-config.json'),
    ]);
    const privateAuthored = await loadProject(privateRoot);
    assert.ok(!privateAuthored.assets.some(asset => asset.id === 'reference'));
    assert.equal(privateAuthored.assets.find(asset => asset.id === 'red')!.inputs, undefined);
    const privateEvidence = JSON.parse(await readFile(join(privateRoot, 'adaptation-evidence.json'), 'utf8'));
    assert.equal(privateEvidence.reference.registered, false);
    assert.equal(privateEvidence.imageReferenceRoles[0].registeredInput, false);
    assert.equal(await hashFile(join(privateRoot, privateEvidence.reference.path)), ref.sha256);
    const privateBuild = await buildProject(privateRoot);
    const privateBundle = await deliverProject(privateRoot, privateDelivery, { review: true, stems: true });
    assert.equal(privateBundle.simulated, false);
    const privateManifest = JSON.parse(await readFile(join(privateDelivery, 'delivery-manifest.json'), 'utf8'));
    assert.ok(
      !privateManifest.files.some(
        (file: { path: string }) => file.path.includes('reference-original') || file.path.includes('materials/'),
      ),
    );
    assert.ok(
      !privateManifest.files.some((file: { sha256: string }) => file.sha256 === ref.sha256),
      'private reference bytes must not enter delivery',
    );
    await assert.rejects(access(join(privateDelivery, 'project', 'materials', 'reference-original.mp4')));
    assert.ok((await buildProject(join(privateDelivery, 'project'))).operations.every(operation => operation.reused));
    await writeFile(
      join(fixture, 'verification.json'),
      JSON.stringify(
        {
          fixture,
          project: root,
          delivery,
          analysis: created.analysis,
          frames: media.frames,
          fps: media.fps,
          builds: { candidates: first.id, selected: selected.id, revised: revised.id, reopened: reopened.id },
          preservedTakes: [selectedIds[0], selectedIds[2]],
          changedTake: { before: selectedIds[1], after: middleTake.id },
          captureOperations: codeOps,
          audioReused: true,
          pixelSamples: { before, after },
          simulated: false,
          privateReference: {
            project: privateRoot,
            delivery: privateDelivery,
            build: privateBuild.id,
            retainedOnlyInWorkingMaterials: true,
            referenceHashAbsentFromDelivery: true,
          },
          observationLimits: [
            'Only extracted stills and numeric media/lineage checks are covered here; no full-video aesthetic acceptance or audio listening.',
            'This graphic re-authoring demonstrates measured timing and scoped image revision; it proves no human pose transfer or photoreal person replacement.',
          ],
        },
        null,
        2,
      ),
    );
    if (keep) console.log(`Reference adaptation evidence: ${fixture}`);
  } finally {
    if (!keep) await rm(fixture, { recursive: true, force: true });
  }
});
