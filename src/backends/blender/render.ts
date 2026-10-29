/**
 * Blender execution backend for `blender`-kind Sources.
 *
 * A `blender` Source is a Python author script plus its dependency closure. The
 * TypeScript control plane freezes those author files (the Build snapshot
 * carries them, see `build/build.ts`), and this module — an independent
 * executor — renders them.
 *
 * Two runtimes are supported, in this order: a real `blender` binary, or — when
 * no binary exists — a Python interpreter that provides the `bpy` module
 * (`VISCRAFT_BPY_PYTHON` / the `bpyPython` option). Both are invoked with the
 * SAME reserved arguments and the same author contract; for the `bpy` path this
 * module writes a tiny bootstrap that activates `bpy` and `runpy`-executes the
 * author entry as `__main__`.
 *
 * Author contract (the Blender analogue of the code backend's `window.viscraft`
 * contract). The entry is invoked headless as:
 *
 *   blender -b --python <entry> -- \
 *     --out <framesDir> --width <W> --height <H> --fps <N> --frames <F> \
 *     [--world <sidecar.json>] <author args...>
 *
 * The script MUST write exactly `F` PNG frames named `frame-%06d.png` for frame
 * indices `0..F-1` into `<framesDir>` (the same sequence contract the code and
 * image backends share, so the shared `encodeFrames` consumes it unchanged),
 * exit 0, and SHOULD print one `VISCRAFT_REPORT <json>` line. The runtime passes
 * the declared camera/frame-range/device choices through `args` verbatim; it
 * never reinterprets them, because the author script owns its own arg contract.
 *
 * World consumption: when the caller supplies a resolved World (the SAME shared
 * World the browser backend samples, with a single entity/transform/trajectory/
 * camera truth), this module samples it with the shared `sampleWorld` — one
 * snapshot per local frame at the global frame `startFrame + f` — and writes a
 * per-frame sidecar handed to the script as `--world <json>`. The sidecar also
 * maps every referenced entity Asset and every named bound Asset to its frozen
 * snapshot path and hash, so a `model` GLB held by the Project is importable
 * without a second asset registry. No second world truth is created.
 *
 * Configuration is explicit and never a machine-local constant. The runtime is
 * resolved from (in order): the `executable` option, `VISCRAFT_BLENDER`
 * (an absolute binary path), `VISCRAFT_BLENDER_ROOT` (a directory whose
 * children are version folders, newest wins), `blender` on `PATH`, then the
 * `bpyPython` option / `VISCRAFT_BPY_PYTHON` (a Python with the `bpy` module).
 * If none resolves — or an explicitly configured one is not runnable — this
 * throws an actionable error rather than silently doing nothing.
 *
 * Failure hygiene: every temporary frame this run produces lives under the
 * caller-supplied `destination`; if the render fails, times out or produces the
 * wrong frame set, that directory is removed before the error propagates, so
 * this run's partial output can never be mistaken for a finished Take. The
 * caller (Build) only promotes a temporary file to an immutable Artifact on
 * success, so an accepted Result is never overwritten by a failed render.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { OutputSchema, type BlenderSource, type OutputSettings, type World } from '../../core/schema.js';
import { sampleWorld } from '../../core/world-state.js';
import { resolveProjectPath } from '../../shared/fs.js';
import { runCommand } from '../../shared/process.js';

/** Explicit runtime configuration for the Blender executor. */
export interface BlenderOptions {
  /** Absolute path to a Blender executable. Overrides every environment lookup. */
  executable?: string;
  /** Absolute path to a Python interpreter providing the `bpy` module (used only when no binary resolves). */
  bpyPython?: string;
  /** Wall-clock limit for one headless render (ms). Defaults to 1 hour. */
  timeoutMs?: number;
}

/** Result of a successful headless render. */
export interface BlenderCaptureResult {
  /** The Blender binary or `bpy` Python interpreter that actually ran. */
  blender: string;
  /** Runtime version banner, e.g. `Blender 4.5.14 LTS`. */
  version: string;
  /** The parsed `VISCRAFT_REPORT` line, when the author script emitted one. */
  report?: unknown;
}

/** A resolved Blender runtime: a real binary or a `bpy` Python interpreter. */
export type BlenderRuntime =
  { kind: 'blender'; executable: string; version: string } | { kind: 'bpy'; python: string; version: string };

/**
 * The shared World this Source consumes, already resolved against the Project
 * and frozen snapshot. `assets` and `bindings` hold ABSOLUTE snapshot paths, so
 * the sidecar is valid only for the render that wrote it (it lives in scratch
 * and is removed with the frames).
 */
export interface BlenderWorldInput {
  world: World;
  camera: string;
  startFrame: number;
  /** Entity Asset id -> `{ path, sha256 }` inside the frozen snapshot. */
  assets: Record<string, { path: string; sha256: string }>;
  /** Named binding -> `{ id, path, sha256 }` inside the frozen snapshot. */
  bindings: Record<string, { id: string; path: string; sha256: string }>;
}

const DEFAULT_RENDER_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Bootstrap executed by a `bpy` Python interpreter: it restores the author's
 * `sys.argv` (so `--`-style parsing is identical to the binary path) and runs
 * the entry as `__main__` after the `bpy` module is active.
 */
const BPY_BOOTSTRAP = `import runpy, sys
_entry = sys.argv[1]
sys.argv = [_entry] + sys.argv[2:]
import bpy  # noqa: F401 - activate the Blender module runtime before the author script
runpy.run_path(_entry, run_name='__main__')
`;

const BLENDER_EXECUTABLE = process.platform === 'win32' ? 'blender.exe' : 'blender';

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const info = await fs.stat(candidate);
    if (!info.isFile()) return false;
    await fs.access(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Newest-first comparison of version directory names (shared numeric ordering). */
function compareVersionDesc(a: string, b: string): number {
  const parts = (value: string): number[] => (value.match(/\d+/g) ?? []).map(Number);
  const na = parts(a);
  const nb = parts(b);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const diff = (nb[i] ?? 0) - (na[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return b.localeCompare(a);
}

async function executableOnPath(name: string): Promise<string | undefined> {
  const searchPath = process.env.PATH ?? '';
  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Resolve a runnable Blender executable from explicit configuration.
 *
 * Priority: the `executable` option, then `VISCRAFT_BLENDER` (absolute path),
 * then `VISCRAFT_BLENDER_ROOT` (versioned install root, newest version wins),
 * then `blender` on `PATH`. An explicitly configured but unusable path is a
 * loud error (never a silent fallback); if nothing resolves, the thrown message
 * states exactly how to configure it.
 */
export async function findBlender(executable?: string): Promise<string> {
  const explicit = executable?.trim() || process.env.VISCRAFT_BLENDER?.trim();
  if (explicit) {
    if (await isExecutableFile(explicit)) return explicit;
    const source = executable?.trim() ? 'the configured blender.executable' : 'VISCRAFT_BLENDER';
    throw new Error(
      `${source} points at "${explicit}" but that is not an executable file; fix the path or unset it so Blender is discovered from VISCRAFT_BLENDER_ROOT/PATH`,
    );
  }

  const root = process.env.VISCRAFT_BLENDER_ROOT?.trim();
  if (root) {
    let entries: string[];
    try {
      entries = await fs.readdir(root);
    } catch {
      throw new Error(`VISCRAFT_BLENDER_ROOT is set to "${root}" but that is not a readable directory`);
    }
    const versions = entries.filter(name => /^\d/.test(name)).sort(compareVersionDesc);
    for (const version of versions) {
      const candidate = path.join(root, version, BLENDER_EXECUTABLE);
      if (await isExecutableFile(candidate)) return candidate;
    }
    throw new Error(
      `VISCRAFT_BLENDER_ROOT "${root}" contains no version directory holding an executable "${BLENDER_EXECUTABLE}" (looked in: ${versions.map(v => `${v}/${BLENDER_EXECUTABLE}`).join(', ') || 'no version directories'})`,
    );
  }

  const onPath = await executableOnPath(BLENDER_EXECUTABLE);
  if (onPath) return onPath;

  throw new Error(
    'No Blender executable found. A `blender` Source needs one: set VISCRAFT_BLENDER to the absolute path of a Blender binary, ' +
      'set VISCRAFT_BLENDER_ROOT to a versioned install directory whose children are version folders, or install Blender on PATH. ' +
      'Host code may also pass an explicit blender.executable.',
  );
}

/** Blender's version banner (first `--version` line), for environment provenance. */
export async function blenderVersion(executable: string): Promise<string> {
  const output = await runCommand(executable, ['--version'], { timeoutMs: 60_000 });
  const banner = output
    .split('\n')
    .map(line => line.trim())
    .find(line => line.length > 0);
  if (!banner) throw new Error(`Blender at ${executable} produced an empty --version banner`);
  return banner;
}

/**
 * The `bpy` module's Blender version banner, proving the interpreter really
 * provides the module (not merely that a Python exists). Importing `bpy` is the
 * detection: an interpreter without it fails here with a clear message.
 */
export async function bpyVersion(python: string): Promise<string> {
  let output: string;
  try {
    output = await runCommand(python, ['-c', 'import bpy; print("Blender " + bpy.app.version_string)'], {
      timeoutMs: 120_000,
    });
  } catch (error) {
    throw new Error(
      `Python at ${python} could not import the bpy module: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const banner = output
    .split('\n')
    .map(line => line.trim())
    .find(line => line.length > 0);
  if (!banner) throw new Error(`Python at ${python} printed no bpy version banner`);
  return banner;
}

/**
 * Resolve a runnable Blender runtime from explicit configuration.
 *
 * Priority: a real `blender` binary (the `executable` option, `VISCRAFT_BLENDER`,
 * `VISCRAFT_BLENDER_ROOT`, then `PATH`), and only then the `bpy` Python module
 * (`bpyPython` option / `VISCRAFT_BPY_PYTHON`). An explicitly configured but
 * unusable path is a loud error (never a silent fallback). If nothing resolves,
 * the message states exactly how to configure either runtime.
 */
export async function resolveBlenderRuntime(options: BlenderOptions = {}): Promise<BlenderRuntime> {
  const explicit = options.executable?.trim() || process.env.VISCRAFT_BLENDER?.trim();
  if (explicit) {
    if (await isExecutableFile(explicit))
      return { kind: 'blender', executable: explicit, version: await blenderVersion(explicit) };
    const source = options.executable?.trim() ? 'the configured blender.executable' : 'VISCRAFT_BLENDER';
    throw new Error(
      `${source} points at "${explicit}" but that is not an executable file; fix the path or unset it so Blender is discovered from VISCRAFT_BLENDER_ROOT/PATH, or set VISCRAFT_BPY_PYTHON to a Python interpreter providing the bpy module`,
    );
  }

  const root = process.env.VISCRAFT_BLENDER_ROOT?.trim();
  if (root) {
    let entries: string[];
    try {
      entries = await fs.readdir(root);
    } catch {
      throw new Error(`VISCRAFT_BLENDER_ROOT is set to "${root}" but that is not a readable directory`);
    }
    const versions = entries.filter(name => /^\d/.test(name)).sort(compareVersionDesc);
    for (const version of versions) {
      const candidate = path.join(root, version, BLENDER_EXECUTABLE);
      if (await isExecutableFile(candidate))
        return { kind: 'blender', executable: candidate, version: await blenderVersion(candidate) };
    }
    throw new Error(
      `VISCRAFT_BLENDER_ROOT "${root}" contains no version directory holding an executable "${BLENDER_EXECUTABLE}" (looked in: ${versions.map(v => `${v}/${BLENDER_EXECUTABLE}`).join(', ') || 'no version directories'})`,
    );
  }

  const onPath = await executableOnPath(BLENDER_EXECUTABLE);
  if (onPath) return { kind: 'blender', executable: onPath, version: await blenderVersion(onPath) };

  const python = options.bpyPython?.trim() || process.env.VISCRAFT_BPY_PYTHON?.trim();
  if (python) {
    if (!(await isExecutableFile(python))) {
      const source = options.bpyPython?.trim() ? 'the configured blender.bpyPython' : 'VISCRAFT_BPY_PYTHON';
      throw new Error(
        `${source} points at "${python}" but that is not an executable file; fix the path or unset it so a Blender binary is used instead`,
      );
    }
    return { kind: 'bpy', python, version: await bpyVersion(python) };
  }

  throw new Error(
    'No Blender runtime found. A `blender` Source needs either a Blender binary (set VISCRAFT_BLENDER to its absolute path, ' +
      'set VISCRAFT_BLENDER_ROOT to a versioned install directory, or install Blender on PATH) or a Python interpreter providing the `bpy` module ' +
      '(set VISCRAFT_BPY_PYTHON to that interpreter). Host code may also pass blender.executable or blender.bpyPython.',
  );
}

/** The frame filename the shared `encodeFrames` expects, for frame index `index`. */
export function blenderFrameName(index: number): string {
  return `frame-${String(index).padStart(6, '0')}.png`;
}

function renderTimeoutMs(options: BlenderOptions): number {
  const configured = options.timeoutMs ?? Number(process.env.VISCRAFT_BLENDER_TIMEOUT_MS ?? Number.NaN);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_RENDER_TIMEOUT_MS;
}

/**
 * Render a `blender` Source to a PNG frame sequence.
 *
 * @param root Project root (Build passes the frozen snapshot root, so the
 *   render reads exactly the frozen author bytes).
 * @param source The `blender` Source: Python entry, dependency-closure
 *   resources, ordered author args, and the declared frame count.
 * @param output Output settings (width/height even; the rational fps is passed
 *   to Blender as a decimal).
 * @param destination Directory that receives `frame-%06d.png` (created here;
 *   removed here if the render fails).
 * @param options Explicit Blender configuration (executable, timeout).
 */
export async function captureBlender(
  root: string,
  source: BlenderSource,
  output: OutputSettings,
  destination: string,
  options: BlenderOptions = {},
  worldInput?: BlenderWorldInput,
): Promise<BlenderCaptureResult> {
  const settings = OutputSchema.parse(output);
  if (!source.entry.toLowerCase().endsWith('.py')) {
    throw new Error(
      `Blender Source ${source.id} entry "${source.entry}" is not a Python author script; only the .py entry path is implemented`,
    );
  }
  const runtime = await resolveBlenderRuntime(options);
  const entry = await resolveProjectPath(root, source.entry);
  const fps = settings.fps.numerator / settings.fps.denominator;
  const reserved = [
    '--out',
    destination,
    '--width',
    String(settings.width),
    '--height',
    String(settings.height),
    '--fps',
    String(fps),
    '--frames',
    String(source.frames),
  ];

  try {
    await fs.mkdir(destination, { recursive: true });

    // World consumption: sample the shared World (the SAME sampler the browser
    // backend uses) once per local frame at the global frame `startFrame + f`,
    // and hand the script the resulting per-frame snapshot plus the frozen
    // Asset paths. This is the only world truth — no second sampler is forked.
    if (worldInput) {
      if (!worldInput.world.cameras.some(camera => camera.id === worldInput.camera)) {
        throw new Error(
          `Blender Source ${source.id} world binding names camera "${worldInput.camera}" which is not in World "${worldInput.world.id}"`,
        );
      }
      const frames = Array.from({ length: source.frames }, (_unused, frame) =>
        sampleWorld(worldInput.world, worldInput.camera, worldInput.startFrame + frame),
      );
      const sidecar = {
        schemaVersion: 1,
        world: {
          id: worldInput.world.id,
          revision: worldInput.world.revision,
          units: worldInput.world.units,
          coordinates: worldInput.world.coordinates,
          fps: worldInput.world.fps,
          frames: worldInput.world.frames,
        },
        camera: worldInput.camera,
        startFrame: worldInput.startFrame,
        assets: worldInput.assets,
        bindings: worldInput.bindings,
        frames,
      };
      const sidecarPath = path.join(destination, 'viscraft-world.json');
      await fs.writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
      reserved.push('--world', sidecarPath);
    }

    let command: string;
    let args: string[];
    if (runtime.kind === 'blender') {
      command = runtime.executable;
      args = ['-b', '--python', entry, '--', ...reserved, ...source.args];
    } else {
      // The `bpy` Python module: run the author entry through a bootstrap that
      // restores its `sys.argv` and executes it as `__main__`.
      const bootstrap = path.join(destination, '__viscraft_bpy_entry__.py');
      await fs.writeFile(bootstrap, BPY_BOOTSTRAP);
      command = runtime.python;
      args = [bootstrap, entry, '--', ...reserved, ...source.args];
    }

    let stdout: string;
    try {
      stdout = await runCommand(command, args, { timeoutMs: renderTimeoutMs(options) });
    } catch (error) {
      throw new Error(
        `Blender render for Source ${source.id} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Disk is the authority: the declared frame count must exist by name, and
    // nothing unexpected may sit beside it. A script that renders the wrong
    // number of frames, or leaves a stray frame, is refused loudly rather than
    // encoded into a Take whose length disagrees with the author's declaration.
    const produced = new Set((await fs.readdir(destination)).filter(name => name.endsWith('.png')));
    const expected = Array.from({ length: source.frames }, (_unused, index) => blenderFrameName(index));
    const missing = expected.filter(name => !produced.has(name));
    const unexpected = [...produced].filter(name => !expected.includes(name)).sort();
    if (missing.length > 0 || unexpected.length > 0) {
      throw new Error(
        `Blender render for Source ${source.id} did not produce exactly ${source.frames} frames named frame-%06d.png ` +
          `(missing: ${missing.slice(0, 4).join(', ') || 'none'}; unexpected: ${unexpected.slice(0, 4).join(', ') || 'none'})`,
      );
    }

    const reportLine = stdout.split('\n').find(line => line.startsWith('VISCRAFT_REPORT '));
    let report: unknown;
    if (reportLine) {
      try {
        report = JSON.parse(reportLine.slice('VISCRAFT_REPORT '.length));
      } catch {
        /* an unparseable report is not fatal; the frame files remain the authority */
      }
    }
    return { blender: command, version: runtime.version, ...(report !== undefined ? { report } : {}) };
  } catch (error) {
    // Remove only THIS run's temporary output; the accepted Result and every
    // committed Artifact live elsewhere and are untouched.
    await fs.rm(destination, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
