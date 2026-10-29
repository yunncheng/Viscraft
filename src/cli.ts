#!/usr/bin/env node
import {
  abortRevert,
  keepVersion,
  listVersions,
  resumeRevert,
  revertProject,
  unkeepVersion,
} from './project/versions.js';
import { buildProject, previewProject, type BuildOptions } from './build/build.js';
import { renderImage } from './build/image.js';
import { serveWorkbench } from './workbench/server.js';
import { planBuild } from './build/plan.js';
import { authorProject, type AuthorFile, type AuthorProject } from './project/author.js';
import { refreshCodeAsset } from './project/code-assets.js';
import { createProject, runtimeLocation, scaffoldProject } from './project/create.js';
import { runtimeContentSha256 } from './shared/runtime-identity.js';
import { loadProject } from './project/project.js';
import { inspectProjectSummary, readBuild } from './project/build-records.js';
import { projectStatus } from './project/status.js';
import { projectUsage } from './project/usage.js';
import { reviewBuild } from './operations/analysis/review.js';
import { exportProject } from './operations/delivery/portable.js';
import { archiveProject, restoreProject } from './operations/delivery/archive.js';
import { abortClean, applyClean, planClean, resumeClean } from './project/clean.js';
import { releaseArchived, restoreMedia } from './project/release.js';
import { deliverProject } from './operations/delivery/delivery.js';
import { verifyDelivery } from './operations/delivery/delivery-verification.js';
import { falCapabilities } from './backends/providers/services/fal/index.js';
import { exportPlayable } from './operations/delivery/playable-export.js';
import { servePlayable } from './backends/playable/playable-server.js';
import { analyzeReference } from './operations/analysis/reference.js';
import { trackReferenceMarker } from './operations/analysis/reference-motion.js';
import { analyzeAudioReference } from './operations/analysis/audio-reference.js';
import { findBrowser, checkCaptureReady } from './backends/browser/capture.js';
import { resolveBlenderRuntime } from './backends/blender/render.js';
import { recordPlayable } from './backends/playable/playable.js';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PlayableInputSchema, type GenerateImageRequest } from './core/schema.js';
import { promoteFrame, promoteRange } from './operations/assets/assets.js';
import { extractAudio } from './operations/assets/audio-extract.js';
import { generateImage, preflightGenerateImage } from './operations/assets/generate-image.js';
import { simulationCapabilities } from './backends/providers/simulated.js';
import { runwayCapabilities } from './backends/providers/services/runway/index.js';
import { resolveProjectPath } from './shared/fs.js';
import { redact, runCommand } from './shared/process.js';
import { removeCredential, storeCredential } from './config/credentials.js';
import { providerReadiness } from './config/readiness.js';
import path from 'node:path';
import { z } from 'zod';

import { VIDEO_SERVICE_PROTOCOLS } from './backends/providers/lane.js';
import { PACKAGED_VIDEO_EXTENSIONS } from './backends/providers/models/registry.js';

/**
 * The PACKAGED video models, DERIVED from the packaged `GenerationExtension`
 * factories themselves (never a hand-maintained string list) so it cannot drift
 * from what the execution lanes can actually select. `medium`/`protocol` are
 * read from the extension, not restated.
 */
function packagedVideoModels(): { model: string; medium: string; protocol: string }[] {
  return PACKAGED_VIDEO_EXTENSIONS.map(factory => {
    const extension = factory();
    return { model: extension.model.id, medium: extension.model.medium, protocol: extension.mapping.protocol };
  });
}

/**
 * A compact, read-only description of ONE model-definition parameter field,
 * derived from the model's OWN zod schema. It never invents a limit: it reports
 * only what the schema literally enforces (enum values, number bounds, integer
 * flag, optional/default wrappers).
 */
function describeModelParameter(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodOptional) return { ...describeModelParameter(schema.unwrap()), optional: true };
  if (schema instanceof z.ZodDefault)
    return { ...describeModelParameter(schema.removeDefault()), optional: true, default: schema._def.defaultValue() };
  if (schema instanceof z.ZodNullable) return { ...describeModelParameter(schema.unwrap()), nullable: true };
  if (schema instanceof z.ZodEnum) return { type: 'enum', values: [...schema.options] };
  if (schema instanceof z.ZodLiteral) return { type: 'literal', value: schema.value };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodNumber) {
    const min = schema.minValue;
    const max = schema.maxValue;
    return {
      type: 'number',
      ...(schema.isInt ? { integer: true } : {}),
      ...(min !== null ? { min } : {}),
      ...(max !== null ? { max } : {}),
    };
  }
  if (schema instanceof z.ZodString)
    return { type: 'string', ...(schema.maxLength !== null ? { maxLength: schema.maxLength } : {}) };
  if (schema instanceof z.ZodUnion)
    return { type: 'union', options: schema.options.map((option: z.ZodTypeAny) => describeModelParameter(option)) };
  if (schema instanceof z.ZodObject) return { type: 'object', fields: describeModelParameters(schema) };
  return { type: (schema as { _def?: { typeName?: string } })._def?.typeName ?? 'unknown' };
}

/** Describe a model definition's own parameter schema (its fields and limits). */
function describeModelParameters(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    return Object.fromEntries(
      Object.entries(schema.shape).map(([key, field]) => [key, describeModelParameter(field as z.ZodTypeAny)]),
    );
  }
  return { _root: describeModelParameter(schema) };
}

/**
 * Per-MODEL/service capability facts, SOURCED FROM each selected definition's own
 * parameter schema (never a protocol-level default). A model's ratios, duration
 * range, output formats, seed range, prompt length and moderation options live
 * here under services[protocol], preserving different parameter surfaces for
 * the same creative model on different services.
 */
function modelCapabilities(): Record<string, unknown> {
  const models: Record<string, { model: string; medium: string; services: Record<string, unknown> }> = {};
  for (const factory of PACKAGED_VIDEO_EXTENSIONS) {
    const extension = factory();
    const model = (models[extension.model.id] ??= {
      model: extension.model.id,
      medium: extension.model.medium,
      services: {},
    });
    model.services[extension.mapping.protocol] = {
      parameters: describeModelParameters(extension.model.parameters as z.ZodTypeAny),
    };
  }
  return models;
}

/** Describe implemented protocols and packaged models without selecting a model
 * or contacting an account. Request routing uses the authored model identity. */
function videoProviderDiagnostics(): Record<string, unknown> {
  const packagedModels = packagedVideoModels();
  return {
    source: 'provider',
    adapterImplemented: true,
    protocols: [...VIDEO_SERVICE_PROTOCOLS],
    modelExtensions: true,
    transport: 'configured HTTPS or explicit loopback HTTP',
    imageReference: 'approved PNG/JPEG; requirements belong to the selected model and service profile',
    videoReference: 'optional approved MP4; reference conditioning, not reconstruction',
    // Transport support does not establish the selected model's capabilities.
    protocolCapabilities: { 'runway-v1': runwayCapabilities, 'fal-queue': falCapabilities },
    // Each packaged model owns its parameter schema and limits.
    modelCapabilities: modelCapabilities(),
    // The complete packaged-model list, derived from the extensions above.
    packagedModels,
    // Endpoint and credential configuration is reported under `providers`.
    serviceVerified: false,
    submissionAuthorized: false,
    realGenerationVerified: false,
  };
}

interface Command {
  /** Arguments after the command name, as shown in help. */
  usage: string;
  run(args: string[]): Promise<void>;
}

const print = (value: unknown): void => console.log(JSON.stringify(value, null, 2));

/** Positional arguments, or a usage error naming the command. */
function positional(args: string[], count: number, name: string): string[] {
  if (args.length < count || args.slice(0, count).some(arg => !arg))
    throw new Error(`Usage: viscraft ${name} ${COMMANDS[name].usage}`);
  return args;
}

async function runtimeMetadata(): Promise<Record<string, unknown>> {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  return {
    name: metadata.name,
    version: metadata.version,
    nodeRequirement: metadata.engines.node,
    schemaVersion: 1,
    contentSha256: await runtimeContentSha256(root),
  };
}

/**
 * `--config <project-relative.mjs>`: an explicitly selected trusted executable
 * module, like authoring code. Resolve within the Project; never auto-discover
 * or execute one.
 */
async function configuredOptions(root: string, config: string | undefined): Promise<BuildOptions> {
  if (config === undefined) return {};
  const module = await import(pathToFileURL(await resolveProjectPath(root, config)).href);
  if (!module.default || typeof module.default !== 'object' || Array.isArray(module.default))
    throw new Error('Provider config module must default-export BuildOptions');
  return module.default as BuildOptions;
}

async function readProjectJson(root: string, relative: string): Promise<unknown> {
  return JSON.parse(await readFile(await resolveProjectPath(root, relative), 'utf8'));
}

/** `--options <json-file>`: a plain object, resolved against the invocation cwd. */
async function authorOptions(file: string | undefined): Promise<Record<string, unknown>> {
  if (file === undefined) return {};
  const resolved = path.resolve(process.cwd(), file);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(resolved, 'utf8'));
  } catch (error) {
    throw new Error(
      `Cannot read author options JSON ${resolved}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Author options must be a JSON object');
  return value as Record<string, unknown>;
}

/**
 * Import one explicitly selected trusted local recipe and call it once with the
 * running Runtime SDK. Like `--config`, this executes author-selected code; it
 * is not a sandbox. Recipe and option paths resolve against the invocation cwd.
 */
async function authorRecipe(
  file: string,
  root: string,
  options: Record<string, unknown>,
): Promise<{ project: AuthorProject; files: AuthorFile[] }> {
  const resolved = path.resolve(process.cwd(), file);
  const recipe = await import(pathToFileURL(resolved).href);
  if (typeof recipe.default !== 'function')
    throw new Error(`Author recipe must default-export a function: ${resolved}`);
  const result = (await recipe.default({ root, options, runtime: await import('./index.js') })) as unknown;
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw new Error('Author recipe must return { project, files }');
  const { project, files } = result as { project?: AuthorProject; files?: AuthorFile[] };
  if (!project || typeof project !== 'object' || !Array.isArray(files))
    throw new Error('Author recipe must return { project, files }');
  return { project, files };
}

/** Parse `<positional…> [--flag value] [--switch]` strictly against the command's usage. */
function flags<T extends Record<string, { type: 'string' | 'boolean'; multiple?: boolean }>>(
  name: string,
  args: string[],
  options: T,
  minPositionals: number,
  maxPositionals: number,
) {
  let parsed;
  try {
    parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch {
    throw new Error(`Usage: viscraft ${name} ${COMMANDS[name].usage}`);
  }
  if (parsed.positionals.length < minPositionals || parsed.positionals.length > maxPositionals)
    throw new Error(`Usage: viscraft ${name} ${COMMANDS[name].usage}`);
  return parsed;
}

const optionalNumber = (value: string | undefined): number | undefined =>
  value === undefined ? undefined : Number(value);

const usageError = (name: string): Error => new Error(`Usage: viscraft ${name} ${COMMANDS[name].usage}`);

/** `<start>:<end>` output frames, left-closed right-open. */
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** A positive decimal size flag in `unit`s, as whole bytes. */
function byteSize(name: string, value: string | undefined, unit: number): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+(?:\.\d+)?$/.test(value) || Number(value) <= 0) throw usageError(name);
  return Math.floor(Number(value) * unit);
}

function frameRange(name: string, value: string): [number, number] {
  const match = /^(\d+):(\d+)$/.exec(value);
  if (!match) throw usageError(name);
  return [Number(match[1]), Number(match[2])];
}

async function doctor(): Promise<void> {
  // The running Runtime's REAL location and whether it is this workspace's own
  // install — so an agent can tell a project-local Runtime from one running out of
  // a build checkout or another Project, instead of hard-coding a path.
  const location = await runtimeLocation(process.cwd());
  const checks: Record<string, unknown> = {
    runtime: {
      ...(await runtimeMetadata()),
      ...location,
      reportedFor: process.cwd(),
      note: location.inProject
        ? 'This Project resolves its SDK to the running Runtime, through an installation or local link.'
        : 'This Runtime runs outside the Project and can be reused across works. A local SDK dependency is needed only for author scripts that import viscraft-runtime.',
    },
    providerVerificationScope:
      'Doctor does not submit generation or verify accounts; a false verification field means this invocation did not check it, not that the capability is unavailable.',
    node: process.version,
    browserCodeIsSandboxed: false,
    simulation: simulationCapabilities,
    realVideoProvider: videoProviderDiagnostics(),
    realImageProvider: {
      adapterImplemented: true,
      modelExtensions: true,
      protocol: 'vllm-omni-image',
      transport:
        'configured HTTPS or explicit loopback HTTP (loopback HTTP is always permitted; a non-loopback endpoint requires explicit authorization)',
      submissionAuthorized: false,
      realGenerationVerified: false,
      capabilityNote:
        'a registered /v1/images/* route does not prove the loaded model can generate images; verify the loaded model output modality before claiming the capability',
    },
    providers: providerReadiness(),
  };
  for (const tool of ['ffmpeg', 'ffprobe']) {
    try {
      checks[tool] = (await runCommand(tool, ['-version'])).split('\n')[0];
    } catch (error) {
      checks[tool] = { error: redact(String(error)) };
      process.exitCode = 1;
    }
  }
  try {
    const browser = await findBrowser();
    checks.browser = { path: browser, version: (await runCommand(browser, ['--version'])).trim() };
  } catch (error) {
    checks.browser = { error: redact(String(error)) };
    process.exitCode = 1;
  }
  checks.captureTransport = { mode: 'snapshot-request-fulfillment', listenerRequired: false, devtools: 'pipe' };
  try {
    const capture = await checkCaptureReady();
    checks.captureReady = {
      available: true,
      browserVersion: capture.browserVersion,
      observation: 'one real frame rendered through snapshot fulfillment and DevTools pipe',
    };
  } catch (error) {
    checks.captureReady = {
      available: false,
      error: redact(String(error)),
      action:
        'Keep host permissions enabled; use an authorized execution environment if browser launch or IPC is denied.',
    };
    process.exitCode = 1;
  }
  // Blender is an OPTIONAL backend for `blender` Sources only, so an absent or
  // unusable Blender never fails the doctor. The Build path is where a missing
  // configuration must fail loudly.
  try {
    const blender = await resolveBlenderRuntime();
    checks.blender =
      blender.kind === 'blender'
        ? {
            available: true,
            kind: 'blender',
            path: blender.executable,
            version: blender.version,
            requiredBy: 'a `blender` Source only',
            configuration: 'VISCRAFT_BLENDER (absolute path), VISCRAFT_BLENDER_ROOT (versioned install root), or PATH',
          }
        : {
            available: true,
            kind: 'bpy',
            python: blender.python,
            version: blender.version,
            requiredBy: 'a `blender` Source only',
            configuration: 'VISCRAFT_BPY_PYTHON (a Python interpreter providing the bpy module)',
          };
  } catch (error) {
    checks.blender = {
      available: false,
      error: redact(String(error)),
      action:
        'Set VISCRAFT_BLENDER/VISCRAFT_BLENDER_ROOT to a Blender binary, or VISCRAFT_BPY_PYTHON to a Python interpreter providing the bpy module, to enable `blender` Sources.',
    };
  }
  print(checks);
}

const CREATE_OPTIONS = new Set(['intent', 'medium', 'size', 'fps', 'sample-rate', 'channels']);
type CreateMedium = 'draft' | 'film' | 'image' | 'sound';

async function create(args: string[]): Promise<void> {
  const [root, title, ...rest] = args;
  if (!root || !title || title.startsWith('--')) throw new Error(`Usage: viscraft create ${COMMANDS.create.usage}`);
  // Parse the WHOLE tail before any write. A flag with no value, a value that is
  // itself another flag, or an unknown parameter must refuse loudly — it must
  // never silently fall through to creating a default Project.
  const parsed = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--'))
      throw new Error(`create: unexpected argument '${token}' (usage: ${COMMANDS.create.usage})`);
    const name = token.slice(2);
    if (!CREATE_OPTIONS.has(name)) throw new Error(`create: unknown option '${token}'`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`create: option '${token}' requires a value`);
    if (parsed.has(name)) throw new Error(`create: option '${token}' given more than once`);
    parsed.set(name, value);
    index += 1;
  }
  const flag = (name: string): string | undefined => parsed.get(name);
  const mediumFlag = flag('medium') ?? 'draft';
  if (mediumFlag !== 'draft' && mediumFlag !== 'film' && mediumFlag !== 'image' && mediumFlag !== 'sound')
    throw new Error('--medium must be draft, film, image or sound');
  const medium = mediumFlag as CreateMedium;
  const size = flag('size')?.match(/^([1-9]\d{0,4})x([1-9]\d{0,4})$/);
  const fps = flag('fps')?.match(/^(\d+)\/(\d+)$/);
  const sampleRate = flag('sample-rate'),
    channels = flag('channels');
  if (flag('size') !== undefined && !size) throw new Error('--size must be WIDTHxHEIGHT, e.g. 1920x1080');
  if (flag('fps') !== undefined && !fps) throw new Error('--fps must be NUMERATOR/DENOMINATOR, e.g. 30000/1001');
  if (sampleRate !== undefined && sampleRate !== '48000' && sampleRate !== '44100')
    throw new Error('--sample-rate must be 48000 or 44100');
  if (channels !== undefined && channels !== '1' && channels !== '2') throw new Error('--channels must be 1 or 2');
  const output = {
    ...(size ? { width: Number(size[1]), height: Number(size[2]) } : {}),
    ...(fps ? { fps: { numerator: Number(fps[1]), denominator: Number(fps[2]) } } : {}),
    ...(sampleRate !== undefined ? { sampleRate: Number(sampleRate) as 44100 | 48000 } : {}),
    ...(channels !== undefined ? { channels: Number(channels) as 1 | 2 } : {}),
  };
  const hasOutput = Object.keys(output).length > 0;
  if (hasOutput && (medium === 'image' || medium === 'sound'))
    throw new Error(
      `create: --size/--fps/--sample-rate/--channels describe a film output; --medium ${medium} creates a draft whose target is declared later`,
    );
  // `film`, or an explicit output setting on a draft, asks for an empty film
  // composition. A draft with no output settings stays a legal draft with NO
  // composition, and image/sound never fabricate a target.
  const wantsFilm = medium === 'film' || (medium === 'draft' && hasOutput);
  const project = await createProject(root, {
    title,
    ...(flag('intent') !== undefined ? { intent: flag('intent')! } : {}),
    ...(wantsFilm ? { output } : {}),
  });
  // The workspace notes, a root `.gitignore` and (only when there is no enclosing
  // work tree) `git init`. Each step is create-if-absent and reported so a caller
  // can tell what was already there.
  const scaffold = await scaffoldProject(root);
  print({
    project: project.id,
    revision: project.revision,
    path: 'project.json',
    title: project.title,
    medium,
    output: project.composition?.output ?? null,
    composition: project.composition !== undefined,
    scaffold,
  });
}

/**
 * Read a secret typed by the user at an interactive terminal, without echo.
 * Refuses when stdin is not a terminal: an agent's background shell must not
 * become the path a key travels through.
 */
function readSecretFromTerminal(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY)
    return Promise.reject(
      new Error(
        'viscraft auth set reads the key from an interactive terminal; ask the user to run it in their own terminal, or pass --from <private-file>',
      ),
    );
  process.stderr.write(prompt);
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      input.setRawMode(false);
      input.pause();
      input.off('data', onData);
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u0003') return finish(new Error('Cancelled; nothing was stored'));
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    input.on('data', onData);
  });
}

async function auth([action, name, ...rest]: string[]): Promise<void> {
  const usage = `Usage: viscraft auth ${COMMANDS.auth.usage}`;
  if (action === 'status' && name === undefined) return print(providerReadiness());
  if (!name || (action !== 'set' && action !== 'remove')) throw new Error(usage);
  if (action === 'remove') {
    if (rest.length) throw new Error(usage);
    return print({ credential: name, removed: removeCredential(name) });
  }
  let value: string;
  if (rest.length === 0) value = await readSecretFromTerminal(`Paste the value for ${name} (input is hidden): `);
  else if (rest.length === 2 && rest[0] === '--from') value = await readFile(rest[1]!, 'utf8');
  else throw new Error(usage);
  const file = storeCredential(name, value);
  print({
    credential: name,
    stored: file,
    note: `Stored owner-private (0600). An environment variable named ${name} still takes precedence.`,
  });
}

const COMMANDS: Record<string, Command> = {
  '--version': {
    usage: '',
    run: async () => print({ ...(await runtimeMetadata()), ...(await runtimeLocation(process.cwd())) }),
  },
  doctor: { usage: '', run: doctor },
  auth: { usage: 'status | set <CREDENTIAL_NAME> [--from <private-file>] | remove <CREDENTIAL_NAME>', run: auth },
  create: {
    usage:
      '<project-directory> <title> [--medium draft|film|image|sound] [--intent <text>] [--size WxH] [--fps N/D] [--sample-rate 48000|44100] [--channels 1|2]',
    run: create,
  },
  author: {
    usage: '<recipe-file> <new-project-directory> [--options <json-file>]',
    run: async args => {
      const { values, positionals } = flags('author', args, { options: { type: 'string' } }, 2, 2);
      const root = path.resolve(process.cwd(), positionals[1]);
      const options = await authorOptions(values.options);
      const recipe = await authorRecipe(positionals[0], root, options);
      const project = await authorProject(root, recipe);
      print({
        project: project.id,
        revision: project.revision,
        path: root,
        title: project.title,
        files: recipe.files.length,
        assets: project.assets.map(asset => ({
          id: asset.id,
          revision: asset.revision,
          path: asset.path,
          type: asset.type,
          sha256: asset.sha256,
          license: asset.rights.license,
          redistributable: asset.rights.redistributable,
        })),
        sources: project.sources.map(source => ({ id: source.id, kind: source.kind })),
        handoff: (project.handoff ?? []).map(file => file.path),
      });
    },
  },
  'refresh-code': {
    usage: '<project-directory> <asset-id>',
    run: async args => {
      // Explicit, current-registration-only refresh after a direct edit of an
      // adopted `code` Asset. It never builds, renders or writes the author file.
      const { positionals } = flags('refresh-code', args, {}, 2, 2);
      const root = positionals[0];
      const project = await loadProject(root);
      const asset = await refreshCodeAsset(root, { assetId: positionals[1], expectedRevision: project.revision });
      print({ asset: asset.id, path: asset.path, sha256: asset.sha256, revision: asset.revision });
    },
  },
  plan: {
    usage:
      '<project-directory> [--target <id>] [--frames <start>:<end> [--scale <0.25-1>]] [--config <project-relative.mjs>]',
    run: async args => {
      const { values, positionals } = flags(
        'plan',
        args,
        {
          config: { type: 'string' },
          target: { type: 'string' },
          frames: { type: 'string' },
          scale: { type: 'string' },
        },
        1,
        1,
      );
      if (values.scale !== undefined && values.frames === undefined) throw usageError('plan');
      const options = await configuredOptions(positionals[0], values.config);
      const preview =
        values.frames !== undefined
          ? { frames: frameRange('plan', values.frames), scale: optionalNumber(values.scale) }
          : undefined;
      print(
        await planBuild(positionals[0], {
          ...options,
          ...(values.target !== undefined ? { target: values.target } : {}),
          ...(preview ? { preview } : {}),
        }),
      );
    },
  },
  preview: {
    usage:
      '<project-directory> (--frames <start>:<end> | --still <frame>) [--scale <0.25-1>] [--config <project-relative.mjs>]',
    run: async args => {
      const { values, positionals } = flags(
        'preview',
        args,
        {
          config: { type: 'string' },
          frames: { type: 'string' },
          still: { type: 'string' },
          scale: { type: 'string' },
        },
        1,
        1,
      );
      if ((values.frames === undefined) === (values.still === undefined)) throw usageError('preview');
      const record = await previewProject(positionals[0], {
        ...(await configuredOptions(positionals[0], values.config)),
        ...(values.frames !== undefined ? { frames: frameRange('preview', values.frames) } : {}),
        ...(values.still !== undefined ? { still: Number(values.still) } : {}),
        scale: optionalNumber(values.scale),
      });
      print({
        build: record.id,
        status: record.status,
        preview: record.preview,
        movie: record.artifacts.find(a => a.id === record.preview?.artifact),
        reusedOperations: record.operations.filter(o => o.reused).length,
      });
    },
  },
  build: {
    usage: '<project-directory> [--target <id>] [--config <project-relative.mjs>]',
    run: async args => {
      const { values, positionals } = flags(
        'build',
        args,
        { config: { type: 'string' }, target: { type: 'string' } },
        1,
        1,
      );
      const root = positionals[0];
      const build = await buildProject(root, {
        ...(await configuredOptions(root, values.config)),
        ...(values.target !== undefined ? { target: values.target } : {}),
      });
      const final = build.artifacts.find(a => a.id === build.result?.artifact);
      print({
        build: build.id,
        status: build.status,
        stale: build.stale,
        result: final,
        reusedOperations: build.operations.filter(o => o.reused).length,
      });
    },
  },
  image: {
    usage: '<project-directory> [--target <id>]',
    run: async args => {
      const { values, positionals } = flags('image', args, { target: { type: 'string' } }, 1, 1);
      print(
        await renderImage(positionals[0], {
          ...(values.target !== undefined ? { target: values.target } : {}),
        }),
      );
    },
  },
  workbench: {
    usage: '<project-directory> [--document <id>] [--target <id>] [--delivery <output-entry>] [--port <n>]',
    run: async args => {
      const { values, positionals } = flags(
        'workbench',
        args,
        {
          document: { type: 'string' },
          target: { type: 'string' },
          delivery: { type: 'string' },
          port: { type: 'string' },
        },
        1,
        1,
      );
      const server = await serveWorkbench(positionals[0], {
        ...(values.document !== undefined ? { document: values.document } : {}),
        ...(values.target !== undefined ? { target: values.target } : {}),
        ...(values.delivery !== undefined ? { delivery: values.delivery } : {}),
        ...(values.port !== undefined ? { port: Number(values.port) } : {}),
      });
      print({
        url: server.url,
        document: server.document,
        target: server.target,
        ...(server.delivery === undefined ? {} : { delivery: server.delivery }),
        hint: 'Open the URL in a browser. The URL and its token are valid only while this process runs. Ctrl+C stops the local service; it edits only this Project.',
      });
      await new Promise<void>(() => undefined);
    },
  },
  inspect: {
    usage: '<project-directory> [build-id]',
    run: async args => {
      // With an id: ONLY that Build record (the same bytes `.viscraft/builds/<id>.json`
      // holds, which already carry its Plan summary, diagnostics and artifacts).
      // Without: a Project summary plus a Build list — never a full dump of every record.
      const { positionals } = flags('inspect', args, {}, 1, 2);
      print(
        positionals[1] === undefined
          ? await inspectProjectSummary(positionals[0])
          : await readBuild(positionals[0], positionals[1]),
      );
    },
  },
  status: {
    usage: '<project-directory>',
    run: async args => print(await projectStatus(positional(args, 1, 'status')[0])),
  },
  versions: {
    usage: '<project-directory> [--all]',
    run: async args => {
      const { values, positionals } = flags('versions', args, { all: { type: 'boolean' } }, 1, 1);
      print(await listVersions(positionals[0], { all: values.all === true }));
    },
  },
  keep: {
    usage: '<project-directory> <build-id> [--note <text>]',
    run: async args => {
      const { values, positionals } = flags('keep', args, { note: { type: 'string' } }, 2, 2);
      const record = await keepVersion(positionals[0], positionals[1], values.note);
      print({ build: record.id, retained: record.retained });
    },
  },
  unkeep: {
    usage: '<project-directory> <build-id>',
    run: async args => {
      const [root, build] = positional(args, 2, 'unkeep');
      const record = await unkeepVersion(root, build);
      print({ build: record.id, retained: null });
    },
  },
  revert: {
    usage: '<project-directory> (<build-id|checkpoint-id> | --resume | --abort)',
    run: async args => {
      const { values, positionals } = flags(
        'revert',
        args,
        { resume: { type: 'boolean' }, abort: { type: 'boolean' } },
        1,
        2,
      );
      const modes = [positionals.length === 2, values.resume === true, values.abort === true].filter(Boolean);
      if (modes.length !== 1) throw usageError('revert');
      const root = positionals[0];
      if (values.resume) print(await resumeRevert(root));
      else if (values.abort) print(await abortRevert(root));
      else print(await revertProject(root, positionals[1]));
    },
  },
  usage: {
    usage: '<project-directory>',
    run: async args => print(await projectUsage(positional(args, 1, 'usage')[0])),
  },
  clean: {
    usage:
      '<project-directory> [--include <output/name|build-id|artifact-id>]... [--apply <plan-hash> | --resume | --abort | --release-archived <archive|name.parts.json>] [--max-content <GiB>]',
    run: async args => {
      const { values, positionals } = flags(
        'clean',
        args,
        {
          include: { type: 'string', multiple: true },
          apply: { type: 'string' },
          resume: { type: 'boolean' },
          abort: { type: 'boolean' },
          'release-archived': { type: 'string' },
          'max-content': { type: 'string' },
        },
        1,
        1,
      );
      const root = positionals[0];
      const include = values.include ?? [];
      const modes = [
        values.apply !== undefined,
        values.resume === true,
        values.abort === true,
        values['release-archived'] !== undefined,
      ].filter(Boolean);
      if (modes.length > 1) throw usageError('clean');
      if (values.resume) print(await resumeClean(root));
      else if (values.abort) print(await abortClean(root));
      else if (values['release-archived'] !== undefined)
        print(
          await releaseArchived(root, values['release-archived'], include, {
            maxContent: byteSize('clean', values['max-content'], GIB),
          }),
        );
      else if (values.apply !== undefined) print(await applyClean(root, values.apply, { include }));
      else print(await planClean(root, { include }));
    },
  },
  'restore-media': {
    usage: '<project-directory> <archive|name.parts.json> [artifact-id]... [--max-content <GiB>]',
    run: async args => {
      const { values, positionals } = flags(
        'restore-media',
        args,
        { 'max-content': { type: 'string' } },
        2,
        Number.MAX_SAFE_INTEGER,
      );
      print(
        await restoreMedia(positionals[0], positionals[1], positionals.slice(2), {
          maxContent: byteSize('restore-media', values['max-content'], GIB),
        }),
      );
    },
  },
  review: {
    usage: '<project-directory> [build-id]',
    run: async args => print(await reviewBuild(positional(args, 1, 'review')[0], args[1])),
  },
  deliver: {
    usage:
      '<project-directory> [new-destination] [--movie] [--image <target>]... [--sound <target>]... [--review] [--stems] [--playable <source-id>] [--allow-non-redistributable] [--allow-incomplete-authored] [--allow-missing-originals]',
    run: async args => {
      // The opt-in is an explicit flag only, never a default.
      const { positionals, values } = flags(
        'deliver',
        args,
        {
          movie: { type: 'boolean' },
          image: { type: 'string', multiple: true },
          sound: { type: 'string', multiple: true },
          review: { type: 'boolean' },
          stems: { type: 'boolean' },
          playable: { type: 'string' },
          'allow-non-redistributable': { type: 'boolean' },
          'allow-incomplete-authored': { type: 'boolean' },
          'allow-missing-originals': { type: 'boolean' },
        },
        1,
        2,
      );
      // ANY selector makes the deliverable set explicit: only what is named is
      // delivered (so `--image poster` ships no movie). With no selector, the
      // Runtime delivers every declared output.
      const selected = values.movie !== undefined || values.image !== undefined || values.sound !== undefined;
      print(
        await deliverProject(positionals[0]!, positionals[1], {
          review: values.review === true,
          ...(selected
            ? {
                outputs: {
                  movie: values.movie === true,
                  images: values.image ?? [],
                  sounds: values.sound ?? [],
                },
              }
            : {}),
          stems: values.stems === true,
          playableSource: values.playable,
          allowNonRedistributable: values['allow-non-redistributable'] === true,
          allowIncompleteAuthored: values['allow-incomplete-authored'] === true,
          allowMissingOriginals: values['allow-missing-originals'] === true,
        }),
      );
    },
  },
  verify: {
    usage: '<bundle-directory>',
    run: async args => {
      // Re-hash every file the bundle's delivery-manifest.json lists and report
      // anything unlisted; non-zero exit when the bundle does not verify.
      const result = await verifyDelivery(positional(args, 1, 'verify')[0]);
      print(result);
      if (!result.ok) process.exitCode = 1;
    },
  },
  'export-playable': {
    usage: '<project-directory> <source-id> [new-destination]',
    run: async args => {
      const { positionals } = flags('export-playable', args, {}, 2, 3);
      print(await exportPlayable(positionals[0]!, positionals[1]!, positionals[2]));
    },
  },
  'serve-playable': {
    usage: '<package-directory> [port]',
    run: async args => {
      const [root, port] = positional(args, 1, 'serve-playable');
      const server = await servePlayable(root, port === undefined ? 0 : Number(port));
      print({ url: server.url, scope: 'loopback only; trusted executable game code, not a sandbox', stop: 'Ctrl+C' });
      const stop = () => {
        void server
          .close()
          .then(() => {
            process.exitCode = 0;
          })
          .catch(() => {
            process.exitCode = 1;
          });
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    },
  },
  'promote-frame': {
    usage: '<project-directory> <relative-options.json>',
    run: async args => {
      const [root, options] = positional(args, 2, 'promote-frame');
      print(await promoteFrame(root, (await readProjectJson(root, options)) as Parameters<typeof promoteFrame>[1]));
    },
  },
  'promote-range': {
    usage: '<project-directory> <relative-options.json>',
    run: async args => {
      const [root, options] = positional(args, 2, 'promote-range');
      print(await promoteRange(root, (await readProjectJson(root, options)) as Parameters<typeof promoteRange>[1]));
    },
  },
  'extract-audio': {
    usage: '<project-directory> <relative-options.json>',
    run: async args => {
      const [root, options] = positional(args, 2, 'extract-audio');
      print(await extractAudio(root, (await readProjectJson(root, options)) as Parameters<typeof extractAudio>[1]));
    },
  },
  'generate-image': {
    usage: '<project-directory> <relative-request.json> [--check] [--config <project-relative.mjs>]',
    run: async args => {
      const { values, positionals } = flags(
        'generate-image',
        args,
        { check: { type: 'boolean' }, config: { type: 'string' } },
        2,
        2,
      );
      const [root, requestPath] = positionals;
      const options = await configuredOptions(root, values.config);
      const request = (await readProjectJson(root, requestPath)) as GenerateImageRequest;
      if (values.check === true) {
        // Read-only: resolves config, validates and reports — no submit, no write.
        const report = await preflightGenerateImage(root, request, options);
        print(report);
        if (!report.ok) process.exitCode = 1;
        return;
      }
      print(await generateImage(root, request, options));
    },
  },
  'track-reference': {
    usage: '<project-directory> <relative-video-path> <#RRGGBB> [tolerance]',
    run: async args => {
      const [root, relativePath, raw, tolerance] = positional(args, 3, 'track-reference');
      if (!/^#[a-fA-F0-9]{6}$/.test(raw))
        throw new Error(`Usage: viscraft track-reference ${COMMANDS['track-reference'].usage}`);
      const color = [1, 3, 5].map(offset => parseInt(raw.slice(offset, offset + 2), 16)) as [number, number, number];
      const report = await trackReferenceMarker(root, relativePath, { color, tolerance: optionalNumber(tolerance) });
      print({
        source: report.source,
        report: report.reportPath,
        marker: report.marker,
        observedFrames: report.frames.length,
        missingFrames: report.frames.filter(frame => !frame.present).length,
        limitations: report.limitations,
      });
    },
  },
  reference: {
    usage: '<project-directory> <relative-media-path> [threshold]',
    run: async args => {
      const [root, relativePath, threshold] = positional(args, 2, 'reference');
      print(await analyzeReference(root, relativePath, { threshold: optionalNumber(threshold) }));
    },
  },
  'audio-reference': {
    usage: '<project-directory> <relative-media-path> [threshold]',
    run: async args => {
      const [root, relativePath, threshold] = positional(args, 2, 'audio-reference');
      const report = await analyzeAudioReference(root, relativePath, { threshold: optionalNumber(threshold) });
      print({
        source: report.source,
        report: report.reportPath,
        sampleRate: report.sampleRate,
        samples: report.samples,
        fps: report.fps,
        onsets: report.onsets,
        limitations: report.limitations,
      });
    },
  },
  record: {
    usage: '<project-directory> <source-id> <relative-inputs.json>',
    run: async args => {
      const [root, sourceId, inputPath] = positional(args, 3, 'record');
      const inputs = PlayableInputSchema.array().parse(await readProjectJson(root, inputPath));
      const recording = await recordPlayable(root, sourceId, inputs);
      print({
        id: recording.id,
        recording: `recordings/${recording.id}/session.json`,
        media: recording.media,
        frames: recording.frames,
        eventCount: recording.events.length,
        stateCount: recording.states.length,
        simulated: recording.simulated,
      });
    },
  },
  export: {
    usage:
      '<project-directory> [new-destination] [--allow-non-redistributable] [--allow-incomplete-authored] [--allow-missing-originals] [--extra-version <build-id|retained>]...',
    run: async args => {
      const { positionals, values } = flags(
        'export',
        args,
        {
          'allow-non-redistributable': { type: 'boolean' },
          'allow-incomplete-authored': { type: 'boolean' },
          'allow-missing-originals': { type: 'boolean' },
          'extra-version': { type: 'string', multiple: true },
        },
        1,
        2,
      );
      print(
        await exportProject(positionals[0]!, positionals[1], {
          allowNonRedistributable: values['allow-non-redistributable'] === true,
          allowIncompleteAuthored: values['allow-incomplete-authored'] === true,
          allowMissingOriginals: values['allow-missing-originals'] === true,
          extraVersions: values['extra-version'] as string[] | undefined,
        }),
      );
    },
  },
  archive: {
    usage:
      '<project-directory> [new-archive-file] [--part-size <MiB>] [--max-content <GiB>] [--allow-non-redistributable] [--allow-incomplete-authored] [--allow-missing-originals] [--extra-version <build-id|retained>]...',
    run: async args => {
      const { positionals, values } = flags(
        'archive',
        args,
        {
          'part-size': { type: 'string' },
          'max-content': { type: 'string' },
          'allow-non-redistributable': { type: 'boolean' },
          'allow-incomplete-authored': { type: 'boolean' },
          'allow-missing-originals': { type: 'boolean' },
          'extra-version': { type: 'string', multiple: true },
        },
        1,
        2,
      );
      print(
        await archiveProject(positionals[0]!, positionals[1], {
          partSize: byteSize('archive', values['part-size'], MIB),
          maxContent: byteSize('archive', values['max-content'], GIB),
          allowNonRedistributable: values['allow-non-redistributable'] === true,
          allowIncompleteAuthored: values['allow-incomplete-authored'] === true,
          allowMissingOriginals: values['allow-missing-originals'] === true,
          extraVersions: values['extra-version'] as string[] | undefined,
        }),
      );
    },
  },
  restore: {
    usage: '<archive-file | name.parts.json> <new-project-directory> [--max-content <GiB>]',
    run: async args => {
      const { positionals, values } = flags('restore', args, { 'max-content': { type: 'string' } }, 2, 2);
      print(
        await restoreProject(positionals[0]!, positionals[1]!, {
          maxContent: byteSize('restore', values['max-content'], GIB),
        }),
      );
    },
  },
};

function help(): string {
  const width = Math.max(...Object.keys(COMMANDS).map(name => name.length));
  return [
    'Usage: viscraft <command> [arguments]',
    '',
    ...Object.entries(COMMANDS).map(([name, command]) => `  ${name.padEnd(width)}  ${command.usage}`.trimEnd()),
  ].join('\n');
}

async function main(): Promise<void> {
  const [name, ...args] = process.argv.slice(2);
  if (name === '--help' || name === '-h' || name === 'help') {
    console.log(help());
    return;
  }
  const command = name === undefined ? undefined : COMMANDS[name];
  if (!command)
    throw new Error(`${name === undefined ? 'Missing command' : `Unknown command '${name}'`}.\n\n${help()}`);
  await command.run(args);
}
main().catch(error => {
  console.error(redact(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
