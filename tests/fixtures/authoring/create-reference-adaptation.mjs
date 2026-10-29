#!/usr/bin/env node
// Reference-guided graphic re-authoring, not original-project recovery or
// person/pose transfer. Paths are relative to the config; all inputs require
// explicit rights. The host inspects analysis frames and supplies observations
// and motion endpoints. Only measured timing is adopted automatically.
// Usage: node tests/fixtures/authoring/create-reference-adaptation.mjs <new-project> <config.json> [--build]
// Config: { title?, output, reference:{path,rights},
//   images:[{id,path,rights,referenceRole?}], retain:[string], replace:[string],
//   shots:[{segment,observation,from:{x,y,scale,rotation},to:{...},
//           candidates:[{image,background:'#rrggbb',accent:'#rrggbb',title}]}], threshold? }
// `segment` selects a measured scene-score interval, in original order; these
// are suggestions the host must inspect, not automatically identified shots.
// Each candidate is an independent code Source. --build renders all candidates
// and the initial first-candidate edit, returning actual review paths. Accept a
// candidate by replacing placement.source with placement.take via saveProject;
// change one appearance by importing a new image and changing only that Source's
// bindingOverrides.subject, then switching that placement back to source.
import { constants } from 'node:fs';
import { mkdir, copyFile, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import * as runtime from '../../../dist/src/index.js';
import { hashFile } from '../../../dist/src/shared/hash.js';
import { makeSignalAsset } from './lib/audio-fixture.mjs';

const pose = z
  .object({
    x: z.number().finite().min(-1).max(2),
    y: z.number().finite().min(-1).max(2),
    scale: z.number().finite().gt(0).max(2),
    rotation: z.number().finite().min(-360).max(360),
  })
  .strict();
const colour = z.string().regex(/^#[a-f\d]{6}$/i);
const input = z.object({ path: z.string().min(1), rights: runtime.RightsSchema }).strict();
const configSchema = z
  .object({
    title: z.string().min(1).default('REFERENCE / RECOMPOSED'),
    output: runtime.OutputSchema,
    reference: input,
    images: z
      .array(input.extend({ id: runtime.Id, referenceRole: z.string().min(1).max(1000).optional() }).strict())
      .min(1)
      .max(24),
    retain: z.array(z.string().min(1)).min(1),
    replace: z.array(z.string().min(1)).min(1),
    threshold: z.number().finite().min(0).max(1).default(0.3),
    shots: z
      .array(
        z
          .object({
            segment: z.number().int().nonnegative(),
            observation: z.string().min(1),
            from: pose,
            to: pose,
            candidates: z
              .array(
                z
                  .object({ image: runtime.Id, background: colour, accent: colour, title: z.string().min(1).max(48) })
                  .strict(),
              )
              .min(1)
              .max(4),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();

export async function createReferenceAdaptation(directory, configFile, build = false) {
  const configPath = resolve(configFile),
    configDir = dirname(configPath);
  const config = configSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));
  const ids = new Set(config.images.map(image => image.id));
  if (ids.size !== config.images.length || ids.has('reference'))
    throw Error('Image ids must be unique and cannot be reference');
  for (const shot of config.shots)
    for (const candidate of shot.candidates)
      if (!ids.has(candidate.image)) throw Error(`Unknown image ${candidate.image}`);
  if (config.shots.some((shot, i) => i > 0 && shot.segment <= config.shots[i - 1].segment))
    throw Error('Select measured segments once, in original order');
  const root = resolve(directory);
  await mkdir(root); // Never overwrite an existing project.
  const project = {
    schemaVersion: 1,
    id: `reference-adaptation-${randomUUID()}`,
    revision: 1,
    title: config.title,
    direction: {
      intent: `New graphic artwork. Retain: ${config.retain.join('; ')}. Replace: ${config.replace.join('; ')}. Original remains flat reference media; authored transforms are not extracted pose or reconstructed layers.`,
      looks: [
        {
          id: 'graphic',
          description:
            'Approved image collage, restrained editorial typography and deterministic graphic motion; an intentional final graphic Look, not a photoreal stand-in.',
        },
      ],
      transitions: [],
    },
    assets: [],
    bindings: {},
    sources: [
      {
        id: 'bootstrap',
        kind: 'browser', output: 'picture',
        entry: 'reference-adaptation.html',
        resources: [],
        bindings: [],
        params: {},
        seed: 0,
        frames: 1,
      },
    ],
    composition: {
      output: config.output,
      scenes: [{ id: 'sequence', description: 'Reference-informed new composition' }],
      shots: [
        {
          id: 'reference-shot',
          scene: 'sequence',
          look: 'graphic',
          targetFrames: 1,
          intent: 'Temporary authoring bootstrap; no Build has run',
        },
      ],
      placements: [
        {
          id: 'reference-edit',
          shot: 'reference-shot',
          source: 'bootstrap',
          inFrame: 0,
          outFrame: 1,
          startFrame: 0,
          audio: 'mute',
        },
      ],
      transitions: [],
      audio: [],
    },
  };
  // Bootstrap assets through the authoritative import contract. An empty
  // authoring scene avoids referring to an asset before it is registered.
  await copyFile(
    join(dirname(fileURLToPath(import.meta.url)), 'reference-adaptation.html'),
    join(root, 'reference-adaptation.html'),
  );
  await writeFile(join(root, 'project.json'), JSON.stringify(runtime.validateProject(project), null, 2) + '\n', {
    flag: 'wx',
  });
  let current = await runtime.loadProject(root);
  let reference;
  if (config.reference.rights.redistributable) {
    reference = await runtime.importAsset(root, {
      assetId: 'reference',
      sourcePath: resolve(configDir, config.reference.path),
      type: 'video',
      rights: config.reference.rights,
      expectedRevision: current.revision,
    });
  } else {
    // A private reference is analysis material, not a distributable Asset. It
    // stays outside authoring dependencies and the portable export allowlist.
    const source = resolve(configDir, config.reference.path),
      info = await stat(source);
    if (!info.isFile() || !info.size) throw Error('Private reference must be a nonempty regular file');
    const extension = extname(source).toLowerCase();
    const sha256 = await hashFile(source),
      path = `materials/reference-original${/^[.][a-z0-9]{1,10}$/.test(extension) ? extension : '.bin'}`;
    await mkdir(join(root, 'materials'));
    await copyFile(source, join(root, path), constants.COPYFILE_EXCL);
    if (
      (await stat(join(root, path))).size !== info.size ||
      (await hashFile(join(root, path))) !== sha256 ||
      (await hashFile(source)) !== sha256
    )
      throw Error('Private reference changed while copying');
    reference = { path, sha256, rights: config.reference.rights };
  }
  const analysis = await runtime.analyzeReference(root, reference.path, { threshold: config.threshold });
  for (const image of config.images) {
    current = await runtime.loadProject(root);
    await runtime.importAsset(root, {
      assetId: image.id,
      sourcePath: resolve(configDir, image.path),
      type: 'image',
      rights: image.rights,
      expectedRevision: current.revision,
      ...(image.referenceRole && reference.id ? { inputs: [{ asset: reference.id, role: image.referenceRole }] } : {}),
    });
  }
  current = await runtime.loadProject(root);
  current.bindings = { subject: config.images[0].id };
  current.sources = [];
  current.composition.shots = [];
  current.composition.placements = [];
  const candidates = [],
    observations = [];
  let cursor = 0;
  for (const [index, shot] of config.shots.entries()) {
    const measured = analysis.segments[shot.segment];
    if (!measured)
      throw Error(`No measured segment ${shot.segment}; inspect ${analysis.reportPath} and correct the config`);
    const frames = measured.endFrame - measured.startFrame,
      id = `shot-${index + 1}`;
    if (cursor + frames > 1800) throw Error('This short-form example supports at most 1800 output frames');
    const sourceIds = [];
    for (const [variant, candidate] of shot.candidates.entries()) {
      const sourceId = `${id}-candidate-${variant + 1}`;
      const { image, ...graphic } = candidate;
      current.sources.push({
        id: sourceId,
        kind: 'browser', output: 'picture',
        entry: 'reference-adaptation.html',
        resources: [],
        bindings: ['subject'],
        bindingOverrides: { subject: image },
        params: { ...graphic, from: shot.from, to: shot.to, frames, number: index + 1, total: config.shots.length },
        seed: 0,
        frames,
      });
      sourceIds.push(sourceId);
    }
    current.composition.shots.push({
      id,
      scene: 'sequence',
      look: 'graphic',
      targetFrames: frames,
      intent: `${shot.observation}. Measured reference output frames [${measured.startFrame}, ${measured.endFrame}); new author-controlled image motion.`,
    });
    current.composition.placements.push({
      id: `edit-${index + 1}`,
      shot: id,
      source: sourceIds[0],
      inFrame: 0,
      outFrame: frames,
      startFrame: cursor,
      audio: 'mute',
    });
    candidates.push({ shot: id, sources: sourceIds });
    observations.push({
      shot: id,
      referenceSegment: shot.segment,
      measured,
      observation: shot.observation,
      from: shot.from,
      to: shot.to,
    });
    cursor += frames;
  }
  const sampleRate = config.output.sampleRate,
    fps = config.output.fps;
  const samples = runtime.framesToSamples(cursor, fps, sampleRate, 'ceil');
  // Original sound, explicitly independent of the reference audio: real PCM
  // assets authored beside the Project, not Runtime-synthesized clips.
  const bed = makeSignalAsset({
    id: 'original-bed',
    path: 'original-bed.wav',
    sampleRate,
    channels: current.composition.output.channels,
    samples,
    frequency: 130.81,
    waveform: 'sine',
  });
  current.assets.push(bed.asset);
  await writeFile(join(root, bed.asset.path), bed.bytes, { flag: 'wx' });
  current.composition.audio = [
    {
      id: 'original-bed',
      kind: 'asset',
      asset: 'original-bed',
      inSample: 0,
      startSample: 0,
      durationSamples: samples,
      gain: 0.08,
      fadeInSamples: Math.min(samples, 2400),
      fadeOutSamples: Math.min(samples, 4800),
    },
  ];
  for (const [i, placement] of current.composition.placements.entries()) {
    const startSample = runtime.framesToSamples(placement.startFrame, fps, sampleRate);
    const durationSamples = Math.min(4800, samples - startSample);
    const accentId = `cut-accent-${i + 1}`;
    const accent = makeSignalAsset({
      id: accentId,
      path: `${accentId}.wav`,
      sampleRate,
      channels: current.composition.output.channels,
      samples: durationSamples,
      frequency: [523.25, 659.25, 783.99][i % 3],
      waveform: 'triangle',
    });
    current.assets.push(accent.asset);
    await writeFile(join(root, accent.asset.path), accent.bytes, { flag: 'wx' });
    current.composition.audio.push({
      id: accentId,
      kind: 'asset',
      asset: accentId,
      inSample: 0,
      startSample,
      durationSamples,
      gain: 0.1,
      fadeInSamples: 200,
      fadeOutSamples: Math.min(2400, durationSamples),
    });
  }
  await runtime.saveProject(root, current, current.revision);
  const evidence = {
    project: root,
    analysis: analysis.reportPath,
    reference: {
      ...(reference.id ? { id: reference.id } : {}),
      path: reference.path,
      sha256: reference.sha256,
      rights: config.reference.rights,
      registered: Boolean(reference.id),
    },
    imageReferenceRoles: config.images
      .filter(image => image.referenceRole)
      .map(image => ({
        image: image.id,
        role: image.referenceRole,
        referenceSha256: reference.sha256,
        registeredInput: Boolean(reference.id),
      })),
    retain: config.retain,
    replace: config.replace,
    observations,
    candidates,
    frames: cursor,
    limitations: [
      'Scene-score boundaries need host inspection; no semantic analysis is claimed.',
      'Motion endpoints are host-authored observations, not measured pose, tracking or original animation recovery.',
      'This produces a new approved graphic Look, not a precise person replacement or photoreal dance.',
      'Sound is original generated PCM signal assets; no reference audio or listening review is claimed.',
    ],
  };
  await writeFile(join(root, 'adaptation-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
  if (build) {
    const built = await runtime.buildProject(root, { candidates });
    const review = await runtime.reviewBuild(root);
    return { ...evidence, build: built.id, result: built.result, review };
  }
  return { ...evidence, built: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, configFile, option] = process.argv.slice(2);
  if (!directory || !configFile || (option && option !== '--build'))
    throw Error(
      'Usage: node tests/fixtures/authoring/create-reference-adaptation.mjs <new-project> <config.json> [--build]',
    );
  console.log(JSON.stringify(await createReferenceAdaptation(directory, configFile, option === '--build'), null, 2));
}
