import { readFile, mkdir, writeFile, link, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
  ProjectSchema,
  assertAssetImageGeneration,
  assertAssetAudioDerivation,
  requireComposition,
  type Project,
  type World,
  type WorldRef,
  type Asset,
} from '../core/schema.js';
import { compositionFrames } from '../core/composition.js';
import { atomicJson, resolveProjectPath } from '../shared/fs.js';
import { assertNotOutputPath } from './output.js';
import { assertAuthoredPath } from './authored-path.js';
import { ensureSelfIgnore } from './self-ignore.js';

export function validateProject(value: unknown): Project {
  const project = ProjectSchema.parse(value);
  const checkSecrets = (item: unknown): void => {
    if (Array.isArray(item)) {
      item.forEach(checkSecrets);
      return;
    }
    if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        if (/^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization[_-]?header)$/i.test(key))
          throw new Error('API credential fields must not be stored in shareable Project state');
        checkSecrets(child);
      }
    } else if (
      typeof item === 'string' &&
      (/\bBearer\s+[A-Za-z0-9._~+/-]{16,}/.test(item) ||
        /https?:\/\/[^\s/]+:[^\s/]+@/i.test(item) ||
        /https?:\/\/\S*[?&](?:token|api[_-]?key|signature|x-amz-signature)=/i.test(item))
    ) {
      throw new Error('Credential-bearing strings/URLs must not be stored in shareable Project state');
    }
  };
  checkSecrets(project);
  const unique = <T extends { id: string }>(items: T[], label: string): Set<string> => {
    const ids = new Set(items.map(item => item.id));
    if (ids.size !== items.length) throw new Error(`Duplicate ${label} identity`);
    return ids;
  };
  for (const asset of project.assets) {
    // One authored-path policy shared with delivery/export: an Asset must not be
    // registered under `.viscraft/`/`output/` or as a credential filename, so a
    // later export can never refuse a path the local load accepted.
    assertAuthoredPath(asset.path, `Asset ${asset.id}`);
    // Hash-only generated-image provenance is a structural fact: its output hash
    // IS this Asset's bytes, its simulated marker agrees, and its ordered
    // references agree with the recorded production inputs. Enforced here so the
    // local load, snapshots, export/archive and restore all apply one contract.
    assertAssetImageGeneration(asset);
    // The audio-derivation relation (extract-audio) is verified structurally here
    // too: an `audio` derivation on an `audio` Asset whose `outputSha256` IS the
    // Asset's bytes, with a nonempty half-open integer-PTS interval. Its parent
    // lineage (take/artifact, simulated taint) needs the Build records and is
    // enforced by the Build snapshot and `productionClosure`.
    assertAssetAudioDerivation(asset);
  }
  for (const source of project.sources) {
    if ('entry' in source && typeof source.entry === 'string')
      assertNotOutputPath(source.entry, `Source ${source.id} entry`);
    if ('resources' in source && Array.isArray(source.resources))
      for (const resource of source.resources) assertNotOutputPath(resource, `Source ${source.id} resource`);
    if ('recording' in source && typeof source.recording === 'string')
      assertNotOutputPath(source.recording, `Source ${source.id} recording`);
  }
  for (const document of project.imageDocuments) {
    assertNotOutputPath(document.path, `Image document ${document.id} entry`);
    for (const resource of document.resources) assertNotOutputPath(resource, `Image document ${document.id} resource`);
  }
  const handoffPaths = new Set<string>();
  for (const file of project.handoff ?? []) {
    assertNotOutputPath(file.path, `Handoff file ${file.path}`);
    if (file.path.toLowerCase() === '.viscraft' || file.path.toLowerCase().startsWith('.viscraft/'))
      throw new Error(`Handoff file ${file.path} must not live under .viscraft/`);
    if (file.path.toLowerCase() === 'project.json') throw new Error('project.json is not a handoff file');
    if (handoffPaths.has(file.path)) throw new Error(`Duplicate handoff file ${file.path}`);
    handoffPaths.add(file.path);
  }
  const assets = unique(project.assets, 'asset'),
    sources = unique(project.sources, 'source');
  const assetById = new Map(project.assets.map(asset => [asset.id, asset]));
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const visitInputs = (asset: Asset): void => {
    if (visiting.has(asset.id)) throw new Error(`Cyclic production references at asset ${asset.id}`);
    if (visited.has(asset.id)) return;
    visiting.add(asset.id);
    const parents = new Set<string>();
    for (const input of asset.inputs ?? []) {
      const parent = assetById.get(input.asset);
      if (!parent || parents.has(input.asset))
        throw new Error(`Asset ${asset.id} requires unique existing production inputs (${input.asset})`);
      parents.add(input.asset);
      visitInputs(parent);
      if (parent.simulated && !asset.simulated)
        throw new Error(`Asset ${asset.id} cannot clear simulated provenance from ${parent.id}`);
    }
    visiting.delete(asset.id);
    visited.add(asset.id);
  };
  project.assets.forEach(visitInputs);
  const looks = unique(project.direction.looks, 'look');
  const composition = project.composition;
  const scenes = unique(composition?.scenes ?? [], 'scene');
  const shots = unique(composition?.shots ?? [], 'shot');
  const placements = unique(composition?.placements ?? [], 'placement');
  unique(composition?.audio ?? [], 'audio clip');
  for (const [binding, asset] of Object.entries(project.bindings)) {
    if (!assets.has(asset)) throw new Error(`Binding ${binding} references missing asset ${asset}`);
  }
  unique(project.worlds ?? [], 'world');
  for (const world of project.worlds ?? []) {
    const entities = unique(world.entities, 'world entity');
    unique(world.cameras, 'world camera');
    unique(world.trajectories, 'trajectory');
    const animated = new Set<string>();
    for (const entity of world.entities)
      if (!assets.has(entity.asset))
        throw new Error(`World entity ${entity.id} references missing Project asset ${entity.asset}`);
    for (const camera of world.cameras)
      if (camera.follow && !entities.has(camera.follow))
        throw new Error(`Camera ${camera.id} follows missing entity ${camera.follow}`);
    for (const trajectory of world.trajectories) {
      if (!entities.has(trajectory.entity) || animated.has(trajectory.entity))
        throw new Error(`Trajectory ${trajectory.id} must address one unique existing entity`);
      animated.add(trajectory.entity);
      for (let i = 0; i < trajectory.keyframes.length; i++) {
        const key = trajectory.keyframes[i];
        if (key.frame >= world.frames || (i > 0 && key.frame <= trajectory.keyframes[i - 1].frame))
          throw new Error(`Trajectory ${trajectory.id} keyframes must increase inside the World clock`);
      }
    }
  }
  for (const source of project.sources) {
    // Shared-World bindings (browser `picture` and `blender`): the World/camera
    // must resolve and the composition fps must sit on the World's frame grid. A
    // per-frame `drive` binding additionally pins the source interval inside the
    // World clock; `define` hands over only the definition, so it declares no
    // start frame and no interval.
    if (source.kind === 'blender' || (source.kind === 'browser' && source.output === 'picture')) {
      const worldRef = source.world;
      if (worldRef) {
        const world = project.worlds?.find(item => item.id === worldRef.id);
        if (!world || !world.cameras.some(camera => camera.id === worldRef.camera))
          throw new Error(`Source ${source.id} references a missing World/camera`);
        const fps = requireComposition(project).output.fps;
        if (world.fps.numerator * fps.denominator !== fps.numerator * world.fps.denominator)
          throw new Error(`Source ${source.id} must share its World frame grid`);
        if (worldRef.mode === 'drive' && worldRef.startFrame! + source.frames > world.frames)
          throw new Error(`Source ${source.id} must use an in-bounds interval on the World frame grid`);
        // Blender is a `drive`-only World consumer: its renderer samples the shared
        // World per frame into the `--world` sidecar. A `define` binding would need a
        // per-shot movement path this executor does not implement.
        if (source.kind === 'blender' && worldRef.mode !== 'drive')
          throw new Error(
            `Blender Source ${source.id} only supports a World binding in mode 'drive' (got '${worldRef.mode}')`,
          );
      }
    }
    // Generic ordered multi-references: every declared reference must resolve to
    // an existing Asset of the declared CATEGORY (image/video/audio), so a
    // mismatch (e.g. an audio role pointing at a still) is refused before Build.
    if (source.kind === 'provider') {
      for (const reference of source.references) {
        const asset = project.assets.find(
          candidate => candidate.id === reference.asset && candidate.type === reference.category,
        );
        if (!asset)
          throw new Error(
            `Missing ${reference.category} reference Asset ${reference.asset} (role ${reference.role}) for Source ${source.id}`,
          );
      }
    }
    if (source.kind === 'browser' || source.kind === 'blender') resolveSourceBindings(project, source);
  }
  if (composition) {
    for (const shot of composition.shots) {
      if (!looks.has(shot.look) || !scenes.has(shot.scene))
        throw new Error(`Shot ${shot.id} references a missing scene/look`);
    }
    // A direct Asset picture reference. The Asset must exist and be a
    // picture (video or image). An image has no intrinsic clock, so its whole stay
    // is declared on the output grid and it carries no audio; `framing` only means
    // something on an Asset reference.
    const validatePictureAsset = (
      owner: string,
      reference: {
        asset: string;
        inFrame: number;
        outFrame: number;
        durationFrames?: number;
        audio?: 'mute' | 'keep';
      },
      scope: 'placement' | 'layer',
    ): void => {
      const asset = assetById.get(reference.asset);
      if (!asset || (asset.type !== 'video' && asset.type !== 'image'))
        throw new Error(`${owner} references Asset ${reference.asset}, which is not a video or image Asset`);
      if (asset.type !== 'image') return;
      if (scope === 'placement' && reference.audio === 'keep')
        throw new Error(
          `${owner} references image Asset ${reference.asset} but audio must be "mute" (a still carries none)`,
        );
      if (scope === 'placement') {
        if (
          reference.durationFrames === undefined ||
          reference.inFrame !== 0 ||
          reference.outFrame !== reference.durationFrames
        )
          throw new Error(
            `${owner} references image Asset ${reference.asset}; a still has no source clock, so declare its whole stay with durationFrames and inFrame 0 / outFrame === durationFrames`,
          );
      } else if (reference.inFrame !== 0) {
        throw new Error(
          `${owner} references image Asset ${reference.asset}; a still has no source clock, so its stay must start at inFrame 0`,
        );
      }
    };
    // A Source in a PICTURE role (a placement/layer `source`) must actually
    // produce picture. The only non-picture Source is a `browser` Source with
    // `output: 'sound'`; using one as picture would silently yield no frames, so
    // it is refused here (at load) rather than at compose time.
    const assertPictureSource = (owner: string, sourceId: string): void => {
      const source = project.sources.find(candidate => candidate.id === sourceId);
      if (source && source.kind === 'browser' && source.output === 'sound')
        throw new Error(`${owner} references Source ${sourceId}, which produces sound, not picture`);
    };
    for (const edit of composition.placements) {
      if (!shots.has(edit.shot) || (edit.source && !sources.has(edit.source)))
        throw new Error(`Invalid placement reference ${edit.id}`);
      if (edit.source) assertPictureSource(`Placement ${edit.id}`, edit.source);
      if (edit.framing !== undefined && edit.asset === undefined)
        throw new Error(`Placement ${edit.id} declares framing without a directly referenced Asset`);
      if (edit.asset !== undefined)
        validatePictureAsset(
          `Placement ${edit.id}`,
          {
            asset: edit.asset,
            inFrame: edit.inFrame,
            outFrame: edit.outFrame,
            durationFrames: edit.durationFrames,
            audio: edit.audio,
          },
          'placement',
        );
    }
    for (const transition of composition.transitions) {
      if (
        !placements.has(transition.from) ||
        !placements.has(transition.to) ||
        transition.from === transition.to ||
        transition.endFrame <= transition.startFrame
      )
        throw new Error('Invalid transition reference or range');
      // An occlusion transition renders the named occluder Asset. `TransitionSchema`
      // already requires an `occluder` id for `occlude`; here that id must resolve
      // to an existing IMAGE Asset, so the cut cannot be authored against a missing
      // Asset or a video/audio Asset that cannot be swept as a cover.
      if (transition.kind === 'occlude') {
        const occluder = assetById.get(transition.occluder!);
        if (!occluder)
          throw new Error(
            `Transition ${transition.from}->${transition.to} names occluder Asset ${transition.occluder}, which does not exist`,
          );
        if (occluder.type !== 'image')
          throw new Error(
            `Transition ${transition.from}->${transition.to} occluder Asset ${occluder.id} must be an image (type "image"), got "${occluder.type}"`,
          );
      }
    }
    for (const transition of project.direction.transitions)
      if (!looks.has(transition.from) || !looks.has(transition.to))
        throw new Error('Direction transition references a missing look');
    for (const clip of composition.audio) {
      // A code-authored sound clip's length is derived from its Source on the
      // composition clock; an asset clip declares its own sample span.
      let durationSamples: number;
      if (clip.kind === 'source') {
        const source = project.sources.find(candidate => candidate.id === clip.source);
        if (!source || source.kind !== 'browser' || source.output !== 'sound')
          throw new Error(`Audio clip ${clip.id} references missing sound Source ${clip.source}`);
        // A sound Source declares its own sample span at its own rate; on the
        // composition clock it occupies the same DURATION (seconds preserved).
        durationSamples = Math.ceil((source.durationSamples * composition.output.sampleRate) / source.sampleRate);
      } else {
        if (clip.kind === 'asset' && !project.assets.some(a => a.id === clip.asset && a.type === 'audio'))
          throw new Error(`Missing audio asset ${clip.asset}`);
        durationSamples = clip.durationSamples;
      }
      if (clip.fadeInSamples + clip.fadeOutSamples > durationSamples)
        throw new Error(`Fades exceed audio clip ${clip.id}`);
      for (let i = 0; i < (clip.automation?.length ?? 0); i++) {
        const point = clip.automation![i];
        if (point.sample >= durationSamples || (i > 0 && point.sample <= clip.automation![i - 1].sample))
          throw new Error(`Gain automation for ${clip.id} must increase inside its local sample interval`);
      }
      for (let i = 0; i < (clip.panAutomation?.length ?? 0); i++) {
        const point = clip.panAutomation![i];
        if (point.sample >= durationSamples || (i > 0 && point.sample <= clip.panAutomation![i - 1].sample))
          throw new Error(`Pan automation for ${clip.id} must increase inside its local sample interval`);
      }
    }
    const subtitles = composition.subtitles ?? [];
    unique(subtitles, 'subtitle');
    const totalFrames = compositionFrames(project);
    unique(composition.layers ?? [], 'picture layer');
    for (const layer of composition.layers ?? []) {
      const { width, height } = composition.output;
      if (
        (layer.source && !sources.has(layer.source)) ||
        layer.startFrame + layer.outFrame - layer.inFrame > totalFrames ||
        layer.x + layer.width > width ||
        layer.y + layer.height > height
      )
        throw new Error(`Picture layer ${layer.id} exceeds its timeline/viewport or references a missing Source`);
      if (layer.source) assertPictureSource(`Picture layer ${layer.id}`, layer.source);
      if (layer.framing !== undefined && layer.asset === undefined)
        throw new Error(`Picture layer ${layer.id} declares framing without a directly referenced Asset`);
      if (layer.asset !== undefined)
        validatePictureAsset(
          `Picture layer ${layer.id}`,
          { asset: layer.asset, inFrame: layer.inFrame, outFrame: layer.outFrame },
          'layer',
        );
    }
    for (const subtitle of subtitles) {
      const { width, height } = composition.output;
      if (subtitle.endFrame > totalFrames) throw new Error(`Subtitle ${subtitle.id} exceeds the composition interval`);
      if (
        subtitle.fontSize > height ||
        (subtitle.x !== undefined && subtitle.x >= width) ||
        (subtitle.y !== undefined && subtitle.y >= height)
      )
        throw new Error(`Subtitle ${subtitle.id} lies outside the output viewport`);
    }
  }
  // Standalone sound targets have their own sample clock, so their clips are
  // validated against THAT span (never a composition FPS).
  for (const target of project.soundTargets) {
    const ids = new Set<string>();
    for (const clip of target.audio) {
      if (ids.has(clip.id)) throw new Error(`Duplicate audio clip ${clip.id} in sound target ${target.id}`);
      ids.add(clip.id);
      let durationSamples: number;
      if (clip.kind === 'source') {
        const source = project.sources.find(candidate => candidate.id === clip.source);
        if (!source || source.kind !== 'browser' || source.output !== 'sound')
          throw new Error(`Audio clip ${clip.id} references missing sound Source ${clip.source}`);
        durationSamples = Math.ceil((source.durationSamples * target.sampleRate) / source.sampleRate);
      } else {
        const asset = project.assets.find(candidate => candidate.id === clip.asset);
        if (!asset || asset.type !== 'audio')
          throw new Error(`Audio clip ${clip.id} references missing audio Asset ${clip.asset}`);
        durationSamples = clip.durationSamples;
      }
      if (clip.startSample + Math.min(durationSamples, target.outputSamples) > target.outputSamples)
        throw new Error(`Audio clip ${clip.id} starts past the sound target span`);
      if (clip.fadeInSamples + clip.fadeOutSamples > durationSamples)
        throw new Error(`Fades exceed audio clip ${clip.id}`);
      for (let i = 0; i < (clip.automation?.length ?? 0); i++) {
        const point = clip.automation![i];
        if (point.sample >= durationSamples || (i > 0 && point.sample <= clip.automation![i - 1].sample))
          throw new Error(`Gain automation for ${clip.id} must increase inside its local sample interval`);
      }
      for (let i = 0; i < (clip.panAutomation?.length ?? 0); i++) {
        const point = clip.panAutomation![i];
        if (point.sample >= durationSamples || (i > 0 && point.sample <= clip.panAutomation![i - 1].sample))
          throw new Error(`Pan automation for ${clip.id} must increase inside its local sample interval`);
      }
    }
    for (const entry of target.ducking ?? [])
      if (entry.target === entry.control)
        throw new Error(`Ducking target and control must differ (both are "${entry.target}")`);
    for (const beat of target.beats ?? [])
      if (beat.sample >= target.outputSamples) throw new Error(`Beat ${beat.id} lies outside the sound target span`);
  }
  return project;
}
export interface SourceBindings {
  bindings: string[];
  bindingOverrides?: Record<string, string>;
}

export function resolveSourceBindings(
  project: Project,
  source: SourceBindings,
): Array<{ binding: string; asset: Asset }> {
  for (const name of Object.keys(source.bindingOverrides ?? {}))
    if (!source.bindings.includes(name)) throw new Error(`Binding override ${name} is not declared by the Source`);
  const remapped = new Map<string, string>();
  return source.bindings.map(binding => {
    if (!Object.hasOwn(project.bindings, binding))
      throw new Error(`Missing binding ${binding}: does not resolve to a project binding`);
    const original = project.bindings[binding];
    const id = source.bindingOverrides?.[binding] ?? original;
    const asset = project.assets.find(asset => asset.id === id);
    if (!asset) throw new Error(`Binding ${binding} references missing Asset ${id}`);
    if (remapped.has(original) && remapped.get(original) !== id)
      throw new Error(`Ambiguous scoped asset replacement for ${original}`);
    remapped.set(original, id);
    return { binding, asset };
  });
}

export function resolveWorldBinding(
  project: Project,
  binding: WorldRef | undefined,
  source?: SourceBindings,
): World | undefined {
  if (!binding) return undefined;
  const world = project.worlds?.find(item => item.id === binding.id);
  const camera = world?.cameras.find(item => item.id === binding.camera);
  if (!world || !camera) throw new Error('World binding references a missing World/camera');
  if (!source?.bindingOverrides) return { ...world, cameras: [camera] };
  const scoped = new Map(
    resolveSourceBindings(project, source).map(({ binding, asset }) => [project.bindings[binding], asset.id]),
  );
  return {
    ...world,
    cameras: [camera],
    entities: world.entities.map(entity => ({ ...entity, asset: scoped.get(entity.asset) ?? entity.asset })),
  };
}

/**
 * The authored-path policy for a whole Project, at the AUTHORING boundary:
 * every Source's entry/resources/recording and every handoff file must satisfy
 * `assertAuthoredPath` — the runtime-private `.viscraft/` namespace, `output/`,
 * a Runtime-rendered package page, and credential filenames are refused. Applied
 * on load and save so a path the runtime accepts here can never be one that a
 * later export/delivery refuses (no load-OK / export-refused gap). `validateProject`
 * stays a pure STRUCTURAL validator: it is also used to read frozen snapshots and
 * fixtures, so the authoring policy is enforced where the Project is loaded/saved,
 * not inside the schema parse.
 */
export function assertAuthoredProjectPaths(project: Project): void {
  for (const source of project.sources) {
    if ('entry' in source && typeof source.entry === 'string')
      assertAuthoredPath(source.entry, `Source ${source.id} entry`);
    if ('resources' in source && Array.isArray(source.resources))
      for (const resource of source.resources) assertAuthoredPath(resource, `Source ${source.id} resource`);
    if ('recording' in source && typeof source.recording === 'string')
      assertAuthoredPath(source.recording, `Source ${source.id} recording`);
  }
  for (const document of project.imageDocuments) {
    assertAuthoredPath(document.path, `Image document ${document.id} entry`);
    for (const resource of document.resources) assertAuthoredPath(resource, `Image document ${document.id} resource`);
  }
  const handoffPaths = new Set<string>();
  for (const file of project.handoff ?? []) {
    assertAuthoredPath(file.path, `Handoff file ${file.path}`);
    if (file.path.toLowerCase() === 'project.json') throw new Error('project.json is not a handoff file');
    if (handoffPaths.has(file.path)) throw new Error(`Duplicate handoff file ${file.path}`);
    handoffPaths.add(file.path);
  }
}

export async function loadProject(root: string): Promise<Project> {
  const project = validateProject(JSON.parse(await readFile(await resolveProjectPath(root, 'project.json'), 'utf8')));
  assertAuthoredProjectPaths(project);
  return project;
}
export async function acquireLock(root: string, name: 'build' | 'author'): Promise<() => Promise<void>> {
  const runtime = await resolveProjectPath(root, '.viscraft');
  await mkdir(runtime, { recursive: true });
  // The Runtime owns `.viscraft/`; the first time we create it, drop a `*`-only
  // `.gitignore` so the author's `git status` stays limited to authored files.
  // Idempotent, and it never touches an existing ignore file — so a Project that
  // configured its own rules is left alone.
  await ensureSelfIgnore(runtime);
  const file = await resolveProjectPath(root, `.viscraft/${name}.lock`);
  const identity = { pid: process.pid, host: hostname(), token: randomUUID(), startedAt: new Date().toISOString() };
  const temporary = `${file}.${identity.token}.tmp`;
  await writeFile(temporary, JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
  try {
    try {
      await link(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let existing: { pid?: number; host?: string; token?: string };
      try {
        existing = JSON.parse(await readFile(file, 'utf8'));
      } catch {
        throw new Error(`Project ${name} lock is unreadable; inspect it before recovery`);
      }
      let dead = false;
      if (existing.host === hostname() && Number.isSafeInteger(existing.pid) && existing.pid! > 0) {
        try {
          process.kill(existing.pid!, 0);
        } catch (probeError) {
          dead = (probeError as NodeJS.ErrnoException).code === 'ESRCH';
        }
      }
      if (!dead)
        throw new Error(
          `Project ${name} is locked by PID ${existing.pid ?? 'unknown'} on ${existing.host ?? 'unknown host'}; do not start another writer`,
        );
      const recovery = `${file}.recovery`;
      try {
        await link(temporary, recovery);
      } catch {
        throw new Error('Another process is recovering the lock; inspect recovery state before retrying');
      }
      try {
        const unchanged = JSON.parse(await readFile(file, 'utf8')) as { token?: string };
        if (unchanged.token !== existing.token) throw new Error('Lock changed during recovery; retry');
        await unlink(file);
        await link(temporary, file);
      } finally {
        await unlink(recovery);
      }
    }
  } finally {
    await unlink(temporary);
  }
  return async () => {
    const current = JSON.parse(await readFile(file, 'utf8')) as { token: string };
    if (current.token !== identity.token) throw new Error('Refusing to release a lock owned by another writer');
    await unlink(file);
  };
}
/**
 * Run `write` holding the `author` lock, with the Project loaded under it.
 * `commit` applies `saveProject`'s one revision rule and atomic write. No
 * rollback is performed here: a caller that also rewrote an authored file must
 * restore it before rethrowing.
 */
export async function withAuthorLock<T>(
  root: string,
  write: (current: Project, commit: (next: Project) => Promise<Project>) => Promise<T>,
): Promise<T> {
  const release = await acquireLock(root, 'author');
  try {
    const current = await loadProject(root);
    const commit = async (value: Project): Promise<Project> => {
      const project = validateProject({ ...value, revision: current.revision + 1 });
      assertAuthoredProjectPaths(project);
      await atomicJson(await resolveProjectPath(root, 'project.json'), project);
      return project;
    };
    return await write(current, commit);
  } finally {
    await release();
  }
}

export async function saveProject(root: string, value: Project, expectedRevision: number): Promise<Project> {
  return withAuthorLock(root, async (current, commit) => {
    if (current.revision !== expectedRevision)
      throw new Error(`Source revision conflict: expected ${expectedRevision}, found ${current.revision}`);
    return commit(value);
  });
}
