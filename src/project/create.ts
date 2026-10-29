/**
 * Standard, non-interactive Project creation (project layer).
 *
 * A host coding agent should never have to hand-write dozens of lines of
 * error-prone `project.json` just to start a work. `createProject` writes ONE
 * valid current-format Project into a (possibly empty) directory: a stable id, a
 * title and a single named Look. That is a LEGAL EMPTY DRAFT: it declares no
 * composition and no image/sound target, so it produces nothing until the author
 * (or a recipe) adds a real creative declaration. `options.output` is the only
 * thing that asks for an empty FILM composition; an image or sound target is
 * never fabricated here because a target must name a real document/source and a
 * sample clock.
 *
 * It is deliberately small and has no second "project generator" surface: it
 * takes ordinary options and returns the validated Project. It refuses to
 * overwrite an existing `project.json`, so it can never clobber authoring state.
 *
 * `scaffoldProject` is the companion used by the CLI `create` command: it writes
 * the workspace notes an agent needs to start without guessing (a short
 * `AGENTS.md`, a root `.gitignore`, and `git init` when there is no work tree
 * yet). `createProject` itself stays a pure Project write so library callers and
 * tests are unaffected. `runtimeLocation` answers, for `doctor`/`status`, where
 * the running Runtime actually is and whether it is installed in this Project.
 */
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock, validateProject } from './project.js';
import type { Fps, LookGrade, Project } from '../core/schema.js';
import { atomicJson, resolveProjectPath } from '../shared/fs.js';
import { stableHash } from '../shared/hash.js';
import { runCommand } from '../shared/process.js';

export interface CreateProjectOptions {
  title: string;
  /** A stable project id; derived from the title when omitted. Must match the Id contract. */
  id?: string;
  /** The creative-direction intent sentence. Defaults to an empty brief. */
  intent?: string;
  /** Named Looks. Exactly one is supplied by default so the Direction is always valid. */
  looks?: Array<{ id: string; description: string; grade?: LookGrade }>;
  /**
   * Ask for an EMPTY film composition with these output settings. Omitted means
   * a legal draft with no composition at all. This never fabricates an image or
   * sound target: those need a real document/Source and are added by the author.
   */
  output?: { width?: number; height?: number; fps?: Fps; sampleRate?: 44100 | 48000; channels?: 1 | 2 };
}

const DEFAULT_LOOK_ID = 'default';

export async function createProject(root: string, options: CreateProjectOptions): Promise<Project> {
  if (!options || typeof options.title !== 'string' || options.title.trim().length === 0)
    throw new Error('createProject requires a non-empty title');
  await mkdir(root, { recursive: true });
  const projectFile = await resolveProjectPath(root, 'project.json');
  const release = await acquireLock(root, 'author');
  try {
    try {
      await access(projectFile);
      throw new Error(
        `Refusing to overwrite the existing ${projectFile}; edit it with saveProject instead of creating over it`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const looks =
      options.looks && options.looks.length > 0
        ? options.looks
        : [{ id: DEFAULT_LOOK_ID, description: 'Default look' }];
    const project: Project = validateProject({
      schemaVersion: 1,
      id: options.id ?? `project-${stableHash(options.title).slice(0, 16)}`,
      revision: 1,
      title: options.title,
      direction: { intent: options.intent ?? '', looks, transitions: [] },
      assets: [],
      bindings: {},
      sources: [],
      ...(options.output
        ? {
            composition: {
              output: {
                width: options.output.width ?? 1920,
                height: options.output.height ?? 1080,
                fps: options.output.fps ?? { numerator: 30, denominator: 1 },
                sampleRate: options.output.sampleRate ?? 48000,
                channels: options.output.channels ?? 2,
              },
              scenes: [],
              shots: [],
              placements: [],
            },
          }
        : {}),
    });
    await atomicJson(projectFile, project);
    return project;
  } finally {
    await release();
  }
}

/**
 * The workspace notes `create` writes once. They describe what the Runtime owns
 * and how to call it — deliberately NOT creative rules: how the author organises
 * the work is theirs to decide. The reasons are
 * given so an agent has no reason to invent its own driver scripts or hard-code
 * a build-machine path.
 */
const PROJECT_AGENTS_MD = `# Project notes for the host coding agent

This directory is a Viscraft Project. These notes state only what the Runtime
owns and how to call it. They are not creative rules: how you organise the work,
which directories you use, and which tools you prefer are yours to decide.

## Runtime

Use the matching Runtime and Skill selected for this work. Reuse the available
Runtime across works; creating a Project does not require another installation.
The commands below assume its executable is available on PATH. Otherwise use the
actual installed entry identified by the host:

    viscraft --version
    viscraft doctor
    viscraft status <project-directory>

\`doctor\` reports the Runtime actually executing (path, version, toolchain) and
whether this Project resolves its SDK. A Runtime outside the Project is valid.
Keep machine-specific install paths out of author code; another host locates its
own matching installation. If an author script imports \`viscraft-runtime\`,
prepare that Project's SDK dependency or link to the verified shared installation.

## Records the Runtime owns

\`\`.viscraft/\`\` holds Build records, frozen snapshots, cached artifacts and
locks. The Runtime writes it; a handoff carries the required frozen production
closure, not scratch or provider job state.

\`output/\` holds Runtime deliveries. \`deliver\` updates the single default
\`output/handoff/\` only while the recorded bundle's actual members verify.

## Lifecycle (when you need it)

\`plan\` (dry-run) -> \`build\` -> \`preview\`/\`review\` -> \`versions\`/\`keep\`/\`revert\`
-> \`deliver\`/\`archive\`. Query records with \`inspect\`, \`versions\` and \`review\`
instead of exporting JSON copies.

## Authoring areas

The Runtime does not require any particular directory layout. A common split is
editable implementation under one directory, registered media under another, and
your own review evidence under a third, but this is a preference, not a gate.
`;

export interface ScaffoldResult {
  /** Whether the workspace `AGENTS.md` was written or already existed. */
  agentsMd: 'written' | 'existing';
  /** Whether a root `.gitignore` (with `node_modules/`) was written or already existed. */
  gitignore: 'written' | 'existing';
  /**
   * What happened with git: a fresh `git init`, an enclosing work tree, no git,
   * or a probe that failed for a reason OTHER than "not a repository" (the
   * state is undetermined, so no repository was created).
   */
  git: 'initialized' | 'already-in-repo' | 'unavailable' | 'probe-failed';
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Initialise a git repository only when the directory is not already inside one.
 * `git rev-parse --git-dir` succeeds inside any enclosing work tree, so a Project
 * created as a subdirectory of an existing repository is left to that repository
 * and reported as such — never nested. A missing git is reported, never fatal.
 *
 * A non-zero exit is NOT enough to conclude "not a repository": git also fails
 * with exit 128 for an undetermined state such as "detected dubious ownership".
 * Running `git init` there would create a NESTED repository inside someone
 * else's. Only the explicit "not a git repository" answer initialises; any other
 * failure leaves the directory untouched and is reported as `probe-failed`.
 */
async function initializeGit(root: string): Promise<ScaffoldResult['git']> {
  try {
    await runCommand('git', ['--version']);
  } catch {
    return 'unavailable';
  }
  try {
    await runCommand('git', ['-C', root, 'rev-parse', '--git-dir']);
    return 'already-in-repo';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Only this well-known answer is determinate; anything else (dubious
    // ownership, a permission/IO error, a broken git) must not trigger init.
    if (!/not a git repository/i.test(message)) return 'probe-failed';
  }
  await runCommand('git', ['-C', root, 'init', '--quiet']);
  return 'initialized';
}

/**
 * Write the non-Project workspace files a fresh `create` should leave behind:
 * a short `AGENTS.md`, a root `.gitignore` with `node_modules/`, and a git
 * repository when there is no work tree yet. Every step is create-if-absent and
 * idempotent, so re-running it never overwrites an author's file.
 */
export async function scaffoldProject(root: string): Promise<ScaffoldResult> {
  await mkdir(root, { recursive: true });
  const agentsFile = path.join(root, 'AGENTS.md');
  let agentsMd: ScaffoldResult['agentsMd'] = 'existing';
  if (!(await exists(agentsFile))) {
    await writeFile(agentsFile, PROJECT_AGENTS_MD, { flag: 'wx', mode: 0o644 });
    agentsMd = 'written';
  }
  const gitignoreFile = path.join(root, '.gitignore');
  let gitignore: ScaffoldResult['gitignore'] = 'existing';
  if (!(await exists(gitignoreFile))) {
    await writeFile(gitignoreFile, 'node_modules/\n', { flag: 'wx', mode: 0o644 });
    gitignore = 'written';
  }
  return { agentsMd, gitignore, git: await initializeGit(root) };
}

/** Walk up from the running module to the Runtime package's own `package.json`. */
async function runtimePackageRoot(): Promise<string> {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const raw = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as { name?: string };
      if (raw.name === 'viscraft-runtime') return dir;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Could not locate the Viscraft Runtime package.json');
    dir = parent;
  }
}

export interface RuntimeLocation {
  name: string;
  version: string;
  /** Absolute path of the running Runtime's package directory (the real location). */
  path: string;
  /** Absolute path of the CLI entry the `viscraft` bin points at. */
  entry: string;
  /** Absolute module entry exported by the running Runtime package. */
  sdkEntry: string;
  /** True when this Project's node_modules resolves to this Runtime, including a local link. */
  inProject: boolean;
}

/**
 * Where the running Runtime actually is, and whether it is the Project's own
 * install. `inProject` compares the Runtime package directory against
 * `<root>/node_modules/<name>` (resolved), so a Runtime running from a build
 * checkout or another Project is reported honestly rather than assumed present.
 */
export async function runtimeLocation(root: string): Promise<RuntimeLocation> {
  const packageRoot = await runtimePackageRoot();
  const metadata = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
    bin: { viscraft: string };
    exports: { '.': { import: string } };
  };
  const rootReal = await realpath(root).catch(() => path.resolve(root));
  const installedReal = await realpath(path.join(rootReal, 'node_modules', metadata.name)).catch(() =>
    path.join(rootReal, 'node_modules', metadata.name),
  );
  const relative = path.relative(installedReal, packageRoot);
  return {
    name: metadata.name,
    version: metadata.version,
    path: packageRoot,
    entry: path.join(packageRoot, metadata.bin.viscraft),
    sdkEntry: path.join(packageRoot, metadata.exports['.'].import),
    inProject: relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)),
  };
}
