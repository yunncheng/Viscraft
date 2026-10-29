import { type Asset, type Project, requireComposition } from '../../core/schema.js';
import {
  type DeliveryNonRedistributableAsset,
  type DeliverySound,
  type IndexContext,
  type ReviewReportShape,
} from './delivery-contract.js';
import { attributionCells, ATTRIBUTION_HEADERS } from './handoff.js';
import { compositionFrames } from '../../core/composition.js';

const HTML_ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape every interpolated value so authored text can never inject markup. */
function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, character => HTML_ESCAPE[character]!);
}

/**
 * Attribute-value escaping: quotes and `&` only. A command placeholder such as
 * `<project-directory>` stays literal in a `data-command` attribute (where `<`
 * is legal text), so a copy/paste tool reads the real command while the visible
 * text is escaped normally.
 */
function escAttribute(value: unknown): string {
  return String(value).replace(/[&"']/g, character => HTML_ESCAPE[character]!);
}

function table(headers: string[], rows: string[][]): string {
  const head = headers.map(header => `<th>${esc(header)}</th>`).join('');
  const body = rows.map(row => `<tr>${row.map(cell => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('\n');
  return `<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>`;
}

function section(id: string, title: string, body: string): string {
  return `<section id="${esc(id)}">\n<h2>${esc(title)}</h2>\n${body}\n</section>`;
}

/**
 * Author-recorded attribution facts from an Asset's rights; absent optional
 * facts remain absent. These are facts the
 * author supplied on the single rights authority; the Runtime makes no license
 * inference and performs no rights judgement.
 */
export function attributionFields(
  rights: Asset['rights'],
): Pick<
  DeliveryNonRedistributableAsset,
  'author' | 'sourceUrl' | 'licenseUrl' | 'notice' | 'modifications' | 'attributionRequired'
> {
  return {
    ...(rights.author !== undefined ? { author: rights.author } : {}),
    ...(rights.sourceUrl !== undefined ? { sourceUrl: rights.sourceUrl } : {}),
    ...(rights.licenseUrl !== undefined ? { licenseUrl: rights.licenseUrl } : {}),
    ...(rights.notice !== undefined ? { notice: rights.notice } : {}),
    ...(rights.modifications !== undefined ? { modifications: rights.modifications } : {}),
    ...(rights.attributionRequired !== undefined ? { attributionRequired: rights.attributionRequired } : {}),
  };
}

function fpsText(fps: { numerator: number; denominator: number }): string {
  return `${fps.numerator}/${fps.denominator}`;
}

function renderSoundProducts(sounds: readonly DeliverySound[]): string {
  if (sounds.length === 0) return '';
  return section(
    'sounds',
    'Delivered sound programmes',
    sounds
      .map(
        sound =>
          `<h3>${esc(sound.target)}</h3><audio controls preload="metadata" src="${esc(sound.path)}"></audio><p><a href="${esc(sound.path)}">Download ${esc(sound.path)}</a> — ${sound.samples} samples @ ${sound.sampleRate} Hz / ${sound.channels} ch, ${sound.bytes} bytes, sha256 <code>${esc(sound.sha256)}</code>. Build <code>${esc(sound.build)}</code>.</p>`,
      )
      .join('\n'),
  );
}

/** Ordered reference roles for a Source summary: `role category asset` per entry. */
function referenceSummary(references: readonly { asset: string; category: string; role: string }[]): string {
  return references.length === 0
    ? '(none)'
    : references.map(reference => `${reference.role}:${reference.category}:${reference.asset}`).join(',');
}

function sourceSummary(source: Project['sources'][number]): string {
  switch (source.kind) {
    case 'browser':
      if (source.output === 'sound')
        return `browser sound entry=${source.entry} samples=${source.durationSamples} sampleRate=${source.sampleRate} seed=${source.seed}`;
      if (source.recording)
        return `browser picture entry=${source.entry} recording=${source.recording} frames=${source.frames} seed=${source.seed}`;
      if (source.world)
        return `browser picture entry=${source.entry} world=${source.world.id}/${source.world.camera} mode=${source.world.mode} frames=${source.frames} seed=${source.seed}`;
      return `browser picture entry=${source.entry} frames=${source.frames} seed=${source.seed}`;
    case 'blender':
      return `blender entry=${source.entry} frames=${source.frames} resources=${source.resources.length} args=[${source.args.join(' ')}]`;
    case 'simulated':
      return `simulated prompt="${source.prompt}" frames=${source.frames} seed=${source.seed} attempt=${source.attempt} behavior=${source.behavior}`;
    case 'provider':
      return `provider ${source.model} endpoint=${source.endpoint} mode=${source.mode} prompt="${source.prompt}" frames=${source.requestedFrames} size=${source.size} references=${referenceSummary(source.references)}`;
  }
}

/** Shared page shell so a film and an image-only delivery state the same facts the same way. */
function renderPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — delivery</title>
<style>
body { font-family: system-ui, sans-serif; margin: 0 auto; max-width: 1100px; padding: 1.5rem; color: #1a1a1a; line-height: 1.45; }
h1 { font-size: 1.6rem; } h2 { margin-top: 2rem; border-bottom: 1px solid #ddd; padding-bottom: .25rem; }
table { border-collapse: collapse; width: 100%; margin: .5rem 0; font-size: .85rem; }
th, td { border: 1px solid #ccc; padding: .3rem .45rem; text-align: left; vertical-align: top; }
th { background: #f3f3f3; } code { word-break: break-all; }
img { max-width: 100%; border: 1px solid #ccc; } video { max-width: 100%; background: #000; }
.note { background: #fff8e1; border: 1px solid #ffe082; padding: .6rem .8rem; }
figure { margin: .5rem 0; }
</style>
</head>
<body>
<h1>${esc(title)}</h1>
<p class="note">Static, JavaScript-free delivery facts page. The facts below are derived from the frozen Build snapshot and hash-verified bundle files. This page makes no subjective, aesthetic, audio-listening or full-movie-review claim: extracted stills and numerical audio measurements are technical observations, not a verdict.</p>
${body}
</body>
</html>
`;
}

/** Delivered still-image products: one bundled byte copy per selected target. */
function renderImageProducts(context: IndexContext): string {
  const targets = new Map(context.currentProject.imageTargets.map(target => [target.id, target]));
  const rows = context.images.map(image => {
    const target = targets.get(image.target);
    return [
      image.target,
      target?.document ?? '',
      image.path,
      `${image.width}x${image.height}`,
      image.format,
      image.background,
      image.build,
      image.artifact,
      String(image.simulated),
      String(image.bytes),
      image.sha256,
    ];
  });
  const tableHtml = table(
    [
      'Target',
      'Document',
      'Path',
      'Pixels',
      'Format',
      'Background',
      'Build',
      'Artifact',
      'Simulated',
      'Bytes',
      'SHA-256',
    ],
    rows,
  );
  const figures = context.images
    .map(
      image =>
        `<figure><a href="${esc(image.path)}"><img src="${esc(image.path)}" alt="Delivered still ${esc(image.target)}" loading="lazy"></a><figcaption>${esc(image.target)} — ${esc(image.width)}x${esc(image.height)} ${esc(image.format)}, sha256 <code>${esc(image.sha256)}</code>, ${esc(image.bytes)} bytes. <a href="${esc(image.path)}">Download ${esc(image.path)}</a>.</figcaption></figure>`,
    )
    .join('\n');
  const reopen = context.images
    .map(
      image =>
        `<p>Reopen the editor for <strong>${esc(image.target)}</strong>: <code data-command="${escAttribute(image.workbench.command)}">${esc(image.workbench.command)}</code><br>${esc(image.workbench.note)}</p>`,
    )
    .join('\n');
  return `<p>Each file under <code>image/</code> is a byte copy of the result Artifact of a succeeded <code>render-image</code> Build whose operation key equals the current render key of the authored document and its declared resources. The image was not re-rendered during delivery and no model task was submitted.</p>
${tableHtml}
${figures}
${reopen === '' ? '' : `<h3>Continue editing this delivered still</h3>\n${reopen}`}`;
}

/**
 * The frozen material facts behind the delivered stills. A redistributable
 * Asset whose author declared `attributionRequired` (or supplied a notice) must
 * have that notice in the bundle, not only in the project metadata; a simulated
 * source Asset is likewise a delivered fact. Rows are keyed by target and Build
 * so two stills that used the same Asset under different historical
 * declarations are both stated.
 */
function renderImageMaterials(context: IndexContext): string {
  const rows = context.imageMaterials.flatMap(material =>
    material.assets.map(asset => [
      material.target,
      material.build,
      material.document,
      asset.asset,
      asset.type,
      String(asset.simulated),
      String(asset.rights.redistributable),
      ...attributionCells(asset),
      asset.path,
    ]),
  );
  if (rows.length === 0) return '';
  return `<p>Each row is one Asset recorded in the frozen Build snapshot that produced the delivered still, matched by the frozen document path and its declared resources. License, notice and attribution facts are the historical record the pixels were produced under; a later current declaration never overwrites them, and a newly declared restriction is reported under the private redistribution status instead.</p>
${table(
  ['Target', 'Build', 'Document', 'Asset', 'Type', 'Simulated', 'Redistributable', ...ATTRIBUTION_HEADERS, 'Path'],
  rows,
)}`;
}

export function renderIndex(context: IndexContext): string {
  if (context.film === null) return renderImageOnlyIndex(context);
  const { currentProject, frozenProject } = context;
  const { build, result, artifact, moviePath, movieSha256, movieBytes } = context.film;
  const composition = requireComposition(frozenProject);
  const output = composition.output;
  const totalFrames = compositionFrames(frozenProject);

  const identity = table(
    ['Field', 'Value'],
    [
      ['Project id', frozenProject.id],
      ['Title (frozen build)', frozenProject.title],
      ['Authored revision (current)', String(currentProject.revision)],
      ['Authored title (current)', currentProject.title],
      ['Frozen build revision', String(build.revision)],
      ['Delivered Build', build.id],
      ['Build status', build.status],
      ['Snapshot hash', build.snapshotHash],
      ['Started', build.startedAt],
      ['Finished', build.finishedAt ?? ''],
      ['Build stale flag', String(build.stale ?? false)],
      ['Result simulated', String(result.simulated)],
      ['Plan operations', String(build.plan.operations.length)],
      ['Run goal', build.run.goal],
    ],
  );

  const timeline = table(
    ['Placement', 'Shot', 'Source / Take / Asset', 'In', 'Out', 'Start', 'Duration', 'Audio'],
    composition.placements.map(placement => {
      const reference = placement.source
        ? `source ${placement.source}`
        : placement.asset
          ? `asset ${placement.asset}`
          : `take ${placement.take ?? ''}`;
      return [
        placement.id,
        placement.shot,
        reference,
        String(placement.inFrame),
        String(placement.outFrame),
        String(placement.startFrame),
        placement.durationFrames === undefined ? '' : String(placement.durationFrames),
        placement.audio,
      ];
    }),
  );

  const shots = table(
    ['Shot', 'Scene', 'Look', 'Target frames', 'Intent'],
    composition.shots.map(shot => [shot.id, shot.scene, shot.look, String(shot.targetFrames), shot.intent]),
  );
  const scenes = table(
    ['Scene', 'Description'],
    composition.scenes.map(scene => [scene.id, scene.description]),
  );
  const looks = table(
    ['Look', 'Description'],
    frozenProject.direction.looks.map(look => [look.id, look.description]),
  );
  const sources = table(
    ['Source', 'Kind', 'Summary'],
    frozenProject.sources.map(source => [source.id, source.kind, sourceSummary(source)]),
  );

  const audio = table(
    ['Clip', 'Kind', 'Detail', 'Start sample', 'Duration samples', 'Gain', 'Fade in', 'Fade out', 'Automation points'],
    composition.audio.map(clip => {
      const detail = clip.kind === 'source' ? `source Source=${clip.source}` : `asset ${clip.asset}`;
      const duration = clip.kind === 'source' ? 'source-defined' : String(clip.durationSamples);
      return [
        clip.id,
        clip.kind,
        detail,
        String(clip.startSample),
        duration,
        String(clip.gain),
        String(clip.fadeInSamples),
        String(clip.fadeOutSamples),
        String(clip.automation?.length ?? 0),
      ];
    }),
  );

  const subtitles = composition.subtitles ?? [];
  const subtitleTable = table(
    ['Subtitle', 'Start', 'End', 'Text'],
    subtitles.map(subtitle => [subtitle.id, String(subtitle.startFrame), String(subtitle.endFrame), subtitle.text]),
  );
  // The sidecar is the editable caption source that matches the burned-in overlay.
  const subtitleSidecar = context.subtitles
    ? `\n<p>Editable subtitle sidecar: <a href="${esc(context.subtitles.path)}">${esc(context.subtitles.path)}</a> — ${esc(context.subtitles.bytes)} bytes, sha256 <code>${esc(context.subtitles.sha256)}</code>, ${esc(context.subtitles.captions)} caption(s). Deterministic SRT derived from the same half-open frame intervals at the composition output rate.</p>`
    : '';

  // A placement/layer may reference a Source directly (a fresh Take is produced
  // for it during the build) or a previously recorded Take. Either way the Take
  // that ends up selected is the one whose `source` matches a referenced Source,
  // so match on both ids rather than only on explicit `take` references.
  const referencedSources = new Set<string>();
  const referencedAssets = new Set<string>();
  const referencedTakes = new Set<string>();
  const noteReference = (reference: { source?: string; take?: string; asset?: string }): void => {
    if (reference.source) referencedSources.add(reference.source);
    if (reference.asset) referencedAssets.add(reference.asset);
    if (reference.take) referencedTakes.add(reference.take);
  };
  for (const placement of composition.placements) noteReference(placement);
  for (const layer of composition.layers ?? []) noteReference(layer);
  const isSelected = (take: { id: string; source?: string; asset?: string }): boolean =>
    referencedTakes.has(take.id) ||
    (take.source !== undefined && referencedSources.has(take.source)) ||
    (take.asset !== undefined && referencedAssets.has(take.asset));
  const takes = table(
    ['Take', 'Source / Asset', 'Artifact', 'Frames / samples', 'FPS / sample rate', 'Simulated', 'Selected'],
    build.takes.map(take => [
      take.id,
      take.source ?? `asset:${take.asset}`,
      take.artifact,
      String(take.medium === 'picture' ? take.frames : take.samples),
      take.medium === 'picture' ? fpsText(take.fps) : `${take.sampleRate} Hz`,
      String(take.simulated),
      String(isSelected(take)),
    ]),
  );

  const artifacts = table(
    ['Artifact', 'Kind', 'Simulated', 'Operation', 'Backend', 'Frames', 'Media fps', 'Size', 'Path', 'SHA-256'],
    build.artifacts.map(item => [
      item.id,
      item.kind,
      String(item.simulated),
      item.operation,
      item.backend,
      item.media ? String(item.media.frames) : '',
      item.media ? fpsText(item.media.fps) : '',
      item.media ? `${item.media.width}x${item.media.height}` : '',
      item.path,
      item.sha256,
    ]),
  );

  // Generative-provider metadata as recorded (no inferred or estimated cost):
  // only the concrete request identity, frame counts and inference time.
  const generated = build.artifacts.filter(item => item.generation);
  const generation =
    generated.length === 0
      ? '<p>No generative-provider artifacts.</p>'
      : table(
          [
            'Artifact',
            'Provider',
            'Model',
            'Task',
            'Requested frames',
            'Original frames',
            'Original size',
            'Inference seconds',
            'Original SHA-256',
            'References (role category asset@sha)',
          ],
          generated.map(item => {
            const info = item.generation!;
            return [
              item.id,
              info.provider,
              info.model,
              info.taskId,
              info.requestedFrames === undefined ? '' : String(info.requestedFrames),
              info.originalMedia ? String(info.originalMedia.frames) : '',
              info.originalMedia ? `${info.originalMedia.width}x${info.originalMedia.height}` : '',
              info.inferenceSeconds === undefined ? '' : String(info.inferenceSeconds),
              info.originalSha256,
              info.references
                .map(
                  reference =>
                    `${reference.role} ${reference.category} ${reference.asset}@${reference.sha256}${reference.media ? ` (${reference.media.frames} frames)` : ''}`,
                )
                .join('; '),
            ];
          }),
        );

  const operations = table(
    ['Operation', 'Kind', 'Inputs', 'Artifact', 'Reused'],
    build.operations.map(operation => [
      operation.id,
      operation.kind,
      operation.inputs.join(' '),
      operation.artifact,
      operation.reused ? 'reused' : 'executed',
    ]),
  );

  const assets = table(
    ['Asset', 'Type', 'Simulated', 'Redistributable', ...ATTRIBUTION_HEADERS, 'Derived from', 'Path', 'SHA-256'],
    frozenProject.assets.map(asset => [
      asset.id,
      asset.type,
      String(asset.simulated),
      String(asset.rights.redistributable),
      ...attributionCells(asset),
      asset.derivedFrom
        ? asset.derivedFrom.kind === 'frame'
          ? `${asset.derivedFrom.build}/${asset.derivedFrom.artifact}@${asset.derivedFrom.frame}`
          : `${asset.derivedFrom.build}/${asset.derivedFrom.artifact} a${asset.derivedFrom.streamIndex} [${asset.derivedFrom.inPts},${asset.derivedFrom.outPts})`
        : '',
      asset.path,
      asset.sha256,
    ]),
  );

  const worlds = frozenProject.worlds ?? [];
  const worldsTable =
    worlds.length === 0
      ? '<p>No World state.</p>'
      : table(
          ['World', 'Frames', 'FPS', 'Entities', 'Cameras', 'Trajectories'],
          worlds.map(world => [
            world.id,
            String(world.frames),
            fpsText(world.fps),
            String(world.entities.length),
            String(world.cameras.length),
            String(world.trajectories.length),
          ]),
        );

  const simulatedArtifacts = build.artifacts.filter(item => item.simulated).map(item => item.id);
  const simulatedTakes = build.takes.filter(take => take.simulated).map(take => take.id);
  const simulatedAssets = frozenProject.assets.filter(asset => asset.simulated).map(asset => asset.id);
  const simulatedSources = frozenProject.sources.filter(source => source.kind === 'simulated').map(source => source.id);
  const provenance = `<p>Simulated / test-only provenance: <strong>${context.simulated ? 'present' : 'none'}</strong>.</p>
<p>Portable export simulated: ${context.portableSimulated ? 'yes' : 'no'}. Movie artifact simulated: ${artifact.simulated ? 'yes' : 'no'}.${context.playable ? ` Playable package simulated: ${context.playable.simulated ? 'yes' : 'no'}.` : ''}</p>
<p>Simulated artifacts: ${simulatedArtifacts.length ? esc(simulatedArtifacts.join(', ')) : 'none'}. Simulated Takes: ${simulatedTakes.length ? esc(simulatedTakes.join(', ')) : 'none'}. Simulated Assets: ${simulatedAssets.length ? esc(simulatedAssets.join(', ')) : 'none'}. Simulated sources: ${simulatedSources.length ? esc(simulatedSources.join(', ')) : 'none'}.</p>`;

  const reviewed = context.review;
  const report: ReviewReportShape = reviewed?.report ?? {};
  const loudness = report.audio?.loudness;
  const silence = report.audio?.silence;
  const loudnessText = loudness?.available
    ? `integrated ${typeof loudness.integratedLufs === 'number' ? loudness.integratedLufs : 'n/a'} LUFS, true peak ${typeof loudness.truePeakDbfs === 'number' ? loudness.truePeakDbfs : 'n/a'} dBFS`
    : `unavailable (${loudness?.reason ?? 'not measured'})`;
  const silenceText = silence?.available
    ? `${Array.isArray(silence.intervals) ? silence.intervals.length : 0} interval(s)`
    : `unavailable (${silence?.reason ?? 'not measured'})`;

  const review = !reviewed
    ? ''
    : `<p>Regenerated from the exported frozen snapshot, hash-verified, and copied verbatim. Observation recorded by the reviewer: ${esc(report.observation ?? 'n/a')}.</p>
<p>Loudness (numerical): ${esc(loudnessText)}. Silence (numerical): ${esc(silenceText)}. Black-frame events: ${Array.isArray(report.video?.blackFrames) ? report.video!.blackFrames!.length : 0}.</p>
<p><a href="${esc(reviewed.contactSheet)}">Contact sheet</a> — extracted first/middle/last still per placement.</p>
<img src="${esc(reviewed.contactSheet)}" alt="Contact sheet" loading="lazy">
${reviewed.seams.length === 0 ? '<p>No cuts (single placement).</p>' : `<p>Seam strips (frames around each cut):</p>\n${reviewed.seams.map(seam => `<figure><a href="${esc(seam)}">${esc(seam)}</a><br><img src="${esc(seam)}" alt="Seam strip" loading="lazy"></figure>`).join('\n')}`}
${reviewed.layers.length === 0 ? '<p>No picture layers.</p>' : `<p>Picture-layer strips (frames around each layer edge), copied from the report's reported layer strips:</p>\n${reviewed.layers.map(layer => `<figure><a href="${esc(layer)}">${esc(layer)}</a><br><img src="${esc(layer)}" alt="Layer strip" loading="lazy"></figure>`).join('\n')}`}
<p><a href="${esc(reviewed.reviewReport)}">review/report.json</a> — full numerical technical report (copied verbatim; its internal paths still name the exported project's generated review directory, which is intentionally absent from <code>project/</code>).</p>
<p><a href="${esc(reviewed.reviewPaths)}">review/paths.json</a> — maps each original project-relative review path to its bundled location under <code>review/</code>.</p>
<ul>${(report.limitations ?? []).map(item => `<li>${esc(item)}</li>`).join('')}</ul>`;

  // Per-shot candidate-Take comparisons, derived only from the frozen Build's
  // declared `plan.candidates` (surfaced through reviewBuild) and the real
  // artifact hashes. No candidate plan => no section at all.
  const candidateShots = (reviewed?.candidates ?? []).filter(comparison => comparison.entries.length > 0);
  const retainedCandidates = reviewed?.retainedCandidates ?? [];
  const candidates =
    candidateShots.length === 0
      ? retainedCandidates.length === 0
        ? ''
        : `<p>Candidate comparison strips retained byte-identically from the original review. An in-place still update does not re-derive per-candidate Take rows (that would require re-reviewing the film), so only the retained products are listed:</p>
${retainedCandidates.map(strip => `<figure><a href="${esc(strip)}">${esc(strip)}</a><br><img src="${esc(strip)}" alt="Retained candidate comparison strip" loading="lazy"></figure>`).join('\n')}`
      : candidateShots
          .map(comparison => {
            const rows = comparison.entries.map(entry => [
              entry.source,
              entry.take,
              String(entry.frames),
              entry.sha256.slice(0, 12),
              entry.selected ? 'yes' : 'no',
              entry.simulated ? 'yes' : 'no',
            ]);
            const strip = comparison.strip
              ? `<p><a href="${esc(comparison.strip)}">${esc(comparison.strip)}</a> — one row per candidate Take (first / middle / last frame of that Take's own artifact).</p>\n<img src="${esc(comparison.strip)}" alt="Candidate comparison for ${esc(comparison.shot)}" loading="lazy">`
              : '<p>No comparison strip: no candidate Take was rendered for this shot.</p>';
            return `<h3>${esc(comparison.shot)}</h3>${strip}${table(['Source', 'Take', 'Frames', 'SHA-256', 'Selected', 'Simulated'], rows)}`;
          })
          .join('\n');

  // Self-contained audio products: the programme mix plus one grouped export per
  // declared bus. Values come only from the frozen snapshot's bus labels and the
  // real staged-artifact hashes/sizes. No audio at all => no section at all.
  const audioStems = context.audio.stems;
  const audioProductsSection =
    context.audio.programme === null
      ? ''
      : `<p><a href="${esc(context.audio.programme.path)}">${esc(context.audio.programme.path)}</a> (sha256 <code>${esc(context.audio.programme.sha256.slice(0, 12))}</code>, ${esc(context.audio.programme.bytes)} bytes) is the audio the delivered movie actually contains — the full mix of every audio member, mastered when composition mastering is enabled (otherwise the raw programme mix).</p>
${context.audio.programmeFrozenPath ? `<p>It is byte-identical to the frozen audio artifact the project export carries at <code>${esc(context.audio.programmeFrozenPath)}</code>; the two paths share one copy of the bytes inside this bundle. The raw pre-mastering mix (when mastering is enabled) remains available inside the project export for further work.</p>` : ''}
<p>Every <code>audio/**/*.wav</code> product below is an ADDITIONAL export of the same frozen snapshot; the stems are grouped exports of the members that also appear in the programme mix, so they are <strong>not a partition</strong> and sum to the programme only when every member is routed to exactly one bus.</p>
${
  audioStems.length === 0
    ? '<p>No bus is declared, so no grouped stem is exported.</p>'
    : table(
        ['Bus', 'Path', 'SHA-256', 'Bytes'],
        audioStems.map(stem => [stem.bus, stem.path, stem.sha256.slice(0, 12), String(stem.bytes)]),
      )
}`;

  // A silent editor/IDE preview is not evidence that the movie has no audio: several
  // built-in previews (notably the VS Code media preview) render the picture track and
  // drop the audio track. Say so plainly whenever the bundle actually ships programme
  // audio, so a viewer does not mistake a preview limitation for a delivery defect.
  const playbackNote =
    context.audio.programme === null
      ? ''
      : `<p class="note">If this movie plays silently, that is not evidence it has no audio: some editor/IDE previews (for example the built-in media preview in VS Code) render the picture track while dropping the audio track. Open the file in a browser or a real media player, or play the standalone programme mix below, to hear it.</p>`;

  const movie = `<video controls preload="metadata" src="${esc(moviePath)}"></video>
<p><a href="${esc(moviePath)}">Download ${esc(moviePath)}</a> — ${esc(movieBytes)} bytes, sha256 <code>${esc(movieSha256)}</code>.</p>
<p>Artifact ${esc(artifact.id)} (${esc(artifact.kind)}, operation ${esc(artifact.operation)}, backend ${esc(artifact.backend)}), recorded at ${esc(result.path)}${artifact.media ? `, ${esc(artifact.media.frames)} frames @ ${esc(fpsText(artifact.media.fps))} ${esc(artifact.media.width)}x${esc(artifact.media.height)}` : ''}.</p>
${playbackNote}`;

  const playable = context.playable
    ? `<p>Standalone live Playable package: id ${esc(context.playable.id)}, entry ${esc(context.playable.entry)}, ${esc(context.playable.files)} files, manifest sha256 <code>${esc(context.playable.sha256)}</code>, simulated ${esc(context.playable.simulated)}.</p>
<p>The package is served by the runtime <code>servePlayable</code>; it is a live configuration, not the editable project.</p>`
    : '<p>No standalone Playable package was requested for this delivery.</p>';

  // Explicit redistribution status. Only present when the bundle actually carries
  // non-redistributable Asset bytes; a normal delivery is unchanged and states
  // nothing here. The wording is deliberately plain, not buried in a table.
  const privateAssets = context.nonRedistributableAssets;
  const redistribution =
    privateAssets.length === 0
      ? ''
      : `<p class="note"><strong>This bundle contains material that is NOT cleared for redistribution.</strong> It includes ${esc(privateAssets.length)} non-redistributable Asset(s) whose bytes were packaged under the author's explicit opt-in. Redistribution rights for these Assets could not be established, so they are recorded as private (see also the Assets table below). Do not redistribute this bundle, or any file derived from it, without first establishing the necessary rights.</p>
${table(
  ['Private Asset', 'Path', 'Origin', 'License', 'Author', 'Source', 'License link', 'Notice', 'Modifications'],
  privateAssets.map(asset => [
    asset.asset,
    asset.path,
    asset.origin,
    asset.license,
    asset.author ?? '',
    asset.sourceUrl ?? '',
    asset.licenseUrl ?? '',
    asset.notice ?? '',
    asset.modifications ?? '',
  ]),
)}`;

  const imagesSection = context.images.length === 0 ? '' : renderImageProducts(context);
  const imageMaterialsSection = context.images.length === 0 ? '' : renderImageMaterials(context);

  return renderPage(
    frozenProject.title,
    `${section('movie', 'Delivered movie', movie)}
${renderSoundProducts(context.sounds)}
${imagesSection === '' ? '' : section('images', 'Delivered still images', imagesSection)}
${imageMaterialsSection === '' ? '' : section('image-materials', 'Still-image materials (rights & attribution)', imageMaterialsSection)}
${redistribution === '' ? '' : section('redistribution', 'Redistribution status (private — not cleared for redistribution)', redistribution)}
${review === '' ? '' : section('review', 'Review products (technical facts)', review)}
${candidates === '' ? '' : section('candidates', 'Candidate-Take comparisons', candidates)}
${section('identity', 'Build & project identity', identity)}
${section('timeline', `Edit timeline — ${totalFrames} frames @ ${fpsText(output.fps)}, ${output.width}x${output.height}, ${output.sampleRate} Hz / ${output.channels} ch`, timeline)}
${section('shots', 'Shots', shots)}
${section('scenes', 'Scenes', scenes)}
${section('looks', 'Looks', looks)}
${section('sources', 'Sources', sources)}
${section('audio', 'Audio clips', audio)}
${audioProductsSection === '' ? '' : section('audio-products', 'Audio products (programme mix & grouped stems)', audioProductsSection)}
${section('subtitles', 'Subtitles', subtitles.length === 0 ? '<p>No subtitles.</p>' : `${subtitleTable}${subtitleSidecar}`)}
${section('takes', 'Takes', takes.length === 0 ? '<p>No Takes recorded.</p>' : takes)}
${section('artifacts', 'Artifacts', artifacts.length === 0 ? '<p>No artifacts recorded.</p>' : artifacts)}
${section('generation', 'Generative-provider metadata (recorded facts)', generation)}
${section('operations', 'Operations (reuse)', operations.length === 0 ? '<p>No operations recorded.</p>' : operations)}
${section('assets', 'Assets', assets.length === 0 ? '<p>No assets.</p>' : assets)}
${section('worlds', 'Worlds', worldsTable)}
${section('provenance', 'Provenance & simulation', provenance)}
${section('playable', 'Standalone playable package', playable)}
<footer>
<p>Files: index.html, delivery-manifest.json, movie/final.mp4${context.subtitles ? ', movie/final.srt' : ''}${context.images.length > 0 ? ', image/*' : ''}${context.audio.programme ? ', audio/*' : ''}${context.review ? ', review/*' : ''}, project/*${context.playable ? ', playable/*' : ''}. The editable project is bundled at project/ (start with project/.viscraft/pages/VISCRAFT.md). delivery-manifest.json hashes every bundled file.</p>
</footer>`,
  );
}

/**
 * Facts page for a delivery that selected still images and no movie. It shares
 * the shell and identity wording with the film page, states only the image
 * products actually bundled, and never renders a movie timeline, subtitle,
 * audio or review section that does not exist.
 */
function renderImageOnlyIndex(context: IndexContext): string {
  const identity = table(
    ['Field', 'Value'],
    [
      ['Project id', context.currentProject.id],
      ['Title', context.currentProject.title],
      ['Authored revision', String(context.currentProject.revision)],
      [
        'Delivered outputs',
        [
          context.images.length > 0 ? `still images (${context.images.map(image => image.target).join(', ')})` : '',
          context.sounds.length > 0 ? `sound programmes (${context.sounds.map(sound => sound.target).join(', ')})` : '',
        ]
          .filter(Boolean)
          .join('; '),
      ],
      ['Movie selected', 'no'],
      ['Simulated', String(context.simulated)],
    ],
  );

  const simulatedImageAssets = [
    ...new Set(
      context.imageMaterials.flatMap(material =>
        material.assets.filter(asset => asset.simulated).map(asset => asset.asset),
      ),
    ),
  ].sort();
  const provenance = `<p>Simulated / test-only provenance: <strong>${context.simulated ? 'present' : 'none'}</strong>.</p>
<p>Portable export simulated: ${context.portableSimulated ? 'yes' : 'no'}. Still image artifacts simulated: ${context.images.filter(image => image.simulated).length} of ${context.images.length}. Simulated still-image Assets: ${simulatedImageAssets.length ? esc(simulatedImageAssets.join(', ')) : 'none'}.</p>`;

  const playable = context.playable
    ? `<p>Standalone live Playable package: id ${esc(context.playable.id)}, entry ${esc(context.playable.entry)}, ${esc(context.playable.files)} files, manifest sha256 <code>${esc(context.playable.sha256)}</code>, simulated ${esc(context.playable.simulated)}.</p>
<p>The package is served by the runtime <code>servePlayable</code>; it is a live configuration, not the editable project.</p>`
    : '';

  const privateAssets = context.nonRedistributableAssets;
  const redistribution =
    privateAssets.length === 0
      ? ''
      : `<p class="note"><strong>This bundle contains material that is NOT cleared for redistribution.</strong> It includes ${esc(privateAssets.length)} non-redistributable Asset(s) whose bytes were packaged under the author's explicit opt-in. Redistribution rights for these Assets could not be established, so they are recorded as private. Do not redistribute this bundle, or any file derived from it, without first establishing the necessary rights.</p>
${table(
  ['Private Asset', 'Path', 'Origin', 'License', 'Author', 'Source', 'License link', 'Notice', 'Modifications'],
  privateAssets.map(asset => [
    asset.asset,
    asset.path,
    asset.origin,
    asset.license,
    asset.author ?? '',
    asset.sourceUrl ?? '',
    asset.licenseUrl ?? '',
    asset.notice ?? '',
    asset.modifications ?? '',
  ]),
)}`;

  const imageMaterials = renderImageMaterials(context);

  return renderPage(
    context.currentProject.title,
    `${context.images.length > 0 ? section('images', 'Delivered still images', renderImageProducts(context)) : ''}
${renderSoundProducts(context.sounds)}
${imageMaterials === '' ? '' : section('image-materials', 'Still-image materials (rights & attribution)', imageMaterials)}
${redistribution === '' ? '' : section('redistribution', 'Redistribution status (private — not cleared for redistribution)', redistribution)}
${section('identity', 'Project identity', identity)}
${section('provenance', 'Provenance & simulation', provenance)}
${playable === '' ? '' : section('playable', 'Standalone playable package', playable)}
<footer>
<p>Files: index.html, delivery-manifest.json${context.images.length > 0 ? ', image/*' : ''}, project/*${context.playable ? ', playable/*' : ''}. ${context.sounds.length > 0 ? 'Sound programmes are bundled under sound/.' : 'No sound programme was selected.'} No movie or review product was selected for this delivery. The editable project is bundled at project/ (start with project/.viscraft/pages/VISCRAFT.md). delivery-manifest.json hashes every bundled file.</p>
</footer>`,
  );
}
