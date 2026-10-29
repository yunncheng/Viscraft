/**
 * Browser capture for CodeScene sources.
 *
 * Produces a deterministic PNG frame sequence (`frame-%06d.png`, frame 0..N-1)
 * by evaluating an author-provided page contract at fixed virtual times.
 *
 * Authoring contract — the entry must expose (from an HTML page, or from a
 * TypeScript module transpiled by the runtime, see `transpile.ts`):
 *
 *   window.viscraft = {
 *     ready?: () => Promise<void>,
 *     reset?: () => void | Promise<void>,
 *     render: (ctx: {
 *       frame: number; time: number; fps: number;
 *       width: number; height: number; seed: number;
 *       params: Record<string, unknown>;
 *       bindings: Record<string, { id: string; url: string; sha256: string }>;
 *     }) => void | Promise<void>,
 *     dispose?: () => void | Promise<void>,
 *   };
 *
 * Frames are rendered once each, in ascending order (0..N-1), with no seeks or
 * retries — so determinism is the author's responsibility. `render` must either
 * be a pure function of its arguments (plus `ready`-loaded state) with no wall
 * clock and no unseeded randomness, or drive a fixed-step stateful simulation
 * that advances exactly once per call from the initial state reached by
 * `ready()`. A stateful source may expose an optional `reset()` (called after
 * `ready()` and before the first frame) to return to that known initial state;
 * a source whose `ready()` already establishes it can omit `reset`. `time` is
 * `frame * denominator / numerator` seconds for the rational output fps.
 *
 * Optional lifecycle hooks (the sixth `lifecycle` argument) run in the host Node
 * process against the live Puppeteer `Page` for real input recording/replay
 * (e.g. `page.evaluateOnNewDocument`, `page.keyboard`). They are trusted host
 * code — not browser-source registry entries — and are never serialized or
 * persisted. `prepare` runs once after the page is created and before
 * navigation; `beforeFrame`/`afterFrame` run around each frame's render. Every
 * hook await is bounded, and a hook rejection fails the capture and still runs
 * cleanup.
 *
 * SECURITY NOTE: this module launches a real Chrome with `--no-sandbox` to support
 * trusted environments such as containers running as root. Snapshot files are fulfilled through
 * browser request interception and DevTools pipes, without a TCP listener. This is NOT a code
 * sandbox. Imported JS/TS is executable code and runs with the privileges the
 * host grants the browser process; only run trusted CodeScene sources.
 *
 * Requests may only reach the exact capture origin (never a prefix match);
 * external hosts are aborted and recorded as a failure. Lifecycle awaits are all
 * bounded by timeouts (navigation, fonts, ready, image readiness, per-frame
 * render, screenshot, dispose) so a hung page can never stall cleanup.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type HTTPRequest, type Page } from 'puppeteer-core';
import { resolveProjectPath } from '../../shared/fs.js';
import { OutputSchema, type OutputSettings } from '../../core/schema.js';
import { emittedJsPath, isTypeScriptPath, transpileStagedTypeScript } from './transpile.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The saved-layout interpreter ships inside the Runtime beside its workbench. */
const WORKBENCH_ASSETS = path.resolve(HERE, '..', '..', 'workbench', 'ui');

/**
 * The page contract a browser `picture` Source exposes to the shared capture
 * chain: the entry page plus what `render` reads. A Source's `world` binding, if
 * any, travels alongside (used only by the replay path to assert the resolved
 * World was supplied); the plain capture ignores it.
 */
export interface CodeSceneSource {
  id: string;
  entry: string;
  resources: string[];
  params: Record<string, unknown>;
  seed: number;
  frames: number;
  world?: unknown;
}

/** A frozen binding: asset id, project-relative path, and content hash. */
export interface CaptureBinding {
  id: string;
  path: string;
  sha256: string;
}

/**
 * Optional host-side lifecycle hooks for real input recording/replay.
 *
 * Hooks execute in this Node process against the live Puppeteer {@link Page}.
 * They are trusted host code — not part of the browser-source contract and never
 * serialized or persisted — so a caller may install input capture before load or
 * drive real keyboard/pointer input between frames.
 *
 * - `prepare(page)` runs once after the page is created and before the entry
 *   navigates, so `page.evaluateOnNewDocument(...)` observes the real document
 *   from its first script.
 * - `beforeFrame(page, frame)` runs after readiness and immediately before that
 *   frame's `window.viscraft.render` call.
 * - `afterFrame(page, frame)` runs immediately after that frame's screenshot.
 *
 * Every hook await is bounded by the capture timeouts; a rejection fails the
 * capture and cleanup still runs.
 */
export interface CaptureLifecycle {
  prepare?: (page: Page) => Promise<void>;
  beforeFrame?: (page: Page, frame: number) => Promise<void>;
  afterFrame?: (page: Page, frame: number) => Promise<void>;
}

/**
 * A non-blocking technical risk observed in a ready browser scene.
 *
 * Diagnostics never fail a capture: they flag facts that can degrade picture
 * quality while the capture still renders — an upscaled canvas backing buffer, a
 * canvas whose buffer aspect disagrees with its displayed aspect, or a declared
 * web font that is not actually available so text silently falls back. They are
 * technical facts, never aesthetic verdicts.
 */
export interface CaptureDiagnostic {
  code: 'canvas-upscaled' | 'canvas-aspect-mismatch' | 'font-fallback';
  message: string;
  detail: Record<string, string | number>;
}

/** Result of a successful capture run. */
export interface CaptureResult {
  browserVersion: string;
  /** Non-blocking technical risks observed before recording (may be empty). */
  diagnostics: CaptureDiagnostic[];
}

const DEFAULT_FRAME_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 60_000;
const NAVIGATION_TIMEOUT_MS = 60_000;
const DEFAULT_DISPOSE_TIMEOUT_MS = 10_000;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  // A TypeScript entry is transpiled to its `.js` sibling and that `.js` is what
  // the page loads; these entries only keep a stray `.ts`/`.tsx` request from
  // being served as `application/octet-stream` (a wrong MIME silently refuses to
  // execute a module). Idiomatic authors use `.js` specifiers, so this is defensive.
  '.ts': 'text/javascript; charset=utf-8',
  '.tsx': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  // The one supported 3D model family. A `model` Asset bound into a scene is
  // served with its real glTF media type so a Three.js `GLTFLoader` (or any
  // glTF consumer) can fetch it; without this it would arrive as
  // application/octet-stream and be refused.
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

/**
 * Resolve a real executable Chrome binary.
 *
 * Priority: `VISCRAFT_BROWSER` env (fail loudly if it is set but unusable),
 * then the newest Chrome under the Puppeteer cache (`PUPPETEER_CACHE_DIR` or
 * `~/.cache/puppeteer`), then well-known system paths. Version directories are
 * discovered dynamically — no single cache version is hardcoded.
 */
export async function findBrowser(): Promise<string> {
  const override = process.env.VISCRAFT_BROWSER?.trim();
  if (override) {
    if (await isExecutableFile(override)) return override;
    throw new Error(`VISCRAFT_BROWSER is set to "${override}" but it is not an executable file`);
  }

  const cacheDir = process.env.PUPPETEER_CACHE_DIR?.trim() || path.join(os.homedir(), '.cache', 'puppeteer');
  const chromeCache = path.join(cacheDir, 'chrome');
  const candidates: string[] = [];
  try {
    const versions = await fs.readdir(chromeCache, { withFileTypes: true });
    const dirs = versions
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort(compareVersionsDesc);
    for (const dir of dirs) {
      candidates.push(path.join(chromeCache, dir, 'chrome-linux64', 'chrome'));
      candidates.push(path.join(chromeCache, dir, 'chrome-linux', 'chrome'));
    }
  } catch {
    // cache directory absent; fall through to system paths
  }

  const systemPaths = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
  candidates.push(...systemPaths);

  for (const candidate of candidates) {
    if (await isExecutableFile(candidate)) return candidate;
  }

  throw new Error(
    'No Chrome/Chromium executable found. Set VISCRAFT_BROWSER to a browser binary, ' +
      `install one into the Puppeteer cache at ${chromeCache}, or install system Chrome.`,
  );
}

export async function checkCaptureReady(): Promise<CaptureResult> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-capture-check-'));
  try {
    await fs.writeFile(
      path.join(root, 'index.html'),
      '<!doctype html><canvas id="c" width="2" height="2"></canvas><script>window.viscraft={render(){const g=document.getElementById("c").getContext("2d");g.fillStyle="#ff0000";g.fillRect(0,0,2,2);}};</script>',
    );
    return await captureCode(
      root,
      {
        id: 'capture-check',
        entry: 'index.html',
        resources: [],
        params: {},
        seed: 0,
        frames: 1,
      },
      { width: 2, height: 2, fps: { numerator: 1, denominator: 1 }, sampleRate: 48000, channels: 1 },
      path.join(root, 'frames'),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function compareVersionsDesc(a: string, b: string): number {
  const nums = (s: string): number[] => (s.match(/\d+/g) ?? []).map(Number);
  const na = nums(a);
  const nb = nums(b);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const diff = (nb[i] ?? 0) - (na[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return b.localeCompare(a);
}

async function isExecutableFile(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    if (!st.isFile()) return false;
    await fs.access(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a project-relative path through the single shared security policy
 * (`io.resolveProjectPath`) and confirm it is a regular file. That policy
 * rejects unsafe relative paths and any symbolic-link component, so no
 * symlink (escaping or internal) can reach the capture snapshot.
 */
async function safeResolve(rootReal: string, rel: string): Promise<string> {
  const resolved = await resolveProjectPath(rootReal, rel);
  const st = await fs.lstat(resolved); // throws ENOENT when missing
  if (st.isSymbolicLink()) {
    throw new Error(`Symbolic links are not allowed in project paths: "${rel}"`);
  }
  if (!st.isFile()) throw new Error(`Path "${rel}" is not a regular file`);
  return resolved;
}

function frameFileName(frame: number): string {
  return `frame-${String(frame).padStart(6, '0')}.png`;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/**
 * Run a trusted host lifecycle hook under a bounded timeout, labeling the
 * failure so a capture error makes the responsible hook obvious. Any throw
 * (sync or async) rejects and therefore fails the capture.
 */
async function runHook(label: string, ms: number, fn: () => Promise<void> | void): Promise<void> {
  try {
    await withTimeout(Promise.resolve(fn()), ms, label);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.startsWith(label) ? message : `${label}: ${message}`);
  }
}

function isFavicon(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith('/favicon.ico');
  } catch {
    return false;
  }
}

/**
 * Decide whether a request URL may reach the network during capture.
 *
 * Only the exact capture origin is allowed — an exact `URL.origin` comparison,
 * never a prefix match, so `http://127.0.0.1:PORT@evil.example/` is rejected.
 * Inline `data:`/`blob:`/`about:` schemes are permitted.
 */
export function isAllowedCaptureUrl(rawUrl: string, origin: string): boolean {
  if (rawUrl === '') return true;
  try {
    const parsed = new URL(rawUrl);
    return (
      parsed.origin === origin ||
      parsed.protocol === 'data:' ||
      parsed.protocol === 'blob:' ||
      parsed.protocol === 'about:'
    );
  } catch {
    return false;
  }
}

/** Which browser global an entry exposes, plus the label used in error messages. */
export interface SceneContract {
  /** Error-message prefix, e.g. `captureCode` or `renderSoundScene`. */
  label: string;
  /** Global the entry must expose, e.g. `viscraft` or `viscraftSound`. */
  globalName: string;
}

/** A fully prepared, navigated and ready browser scene owned by the caller. */
export interface OpenedScene {
  page: Page;
  browserVersion: string;
  /** Served-URL map for frozen bindings, in the shape an author `render` receives. */
  bindings: Record<string, { id: string; url: string; sha256: string }>;
  /**
   * Collect non-blocking capture diagnostics from the current page state. Call
   * after the author's sizing/render code has run (e.g. after the first frame)
   * so measurements reflect the real scene. Never throws and never creates or
   * changes a canvas context.
   */
  collectDiagnostics(): Promise<CaptureDiagnostic[]>;
  /** Reject (using the contract label) if any page/request failure was recorded. */
  assertHealthy(): void;
  /** Dispose author resources, close the browser and remove the snapshot. Idempotent. */
  close(): Promise<void>;
}

/**
 * Collect non-blocking capture diagnostics in the page.
 *
 * Runs after the readiness chain (fonts, author `ready()`, image decode) and
 * before recording, so it observes the settled scene. It only reports technical
 * risks that still render; it never throws on a scene quirk and never judges
 * aesthetics. Serialized into the page by Puppeteer, so it must stay
 * self-contained.
 */
function collectCaptureDiagnostics(): CaptureDiagnostic[] {
  const diagnostics: CaptureDiagnostic[] = [];
  const view = globalThis as unknown as { innerWidth: number; innerHeight: number; devicePixelRatio: number };
  const deviceScaleFactor = view.devicePixelRatio || 1;
  const viewWidth = view.innerWidth;
  const viewHeight = view.innerHeight;
  const viewportArea = viewWidth * viewHeight;

  // A canvas is significant only when it covers at least half the picture.
  for (const canvas of Array.from(document.querySelectorAll('canvas'))) {
    const rect = canvas.getBoundingClientRect();
    const displayWidth = rect.width * deviceScaleFactor;
    const displayHeight = rect.height * deviceScaleFactor;
    if (displayWidth <= 0 || displayHeight <= 0) continue;
    if (viewportArea > 0 && (rect.width * rect.height) / viewportArea < 0.5) continue;

    // The backing buffer: `canvas.width/height` for every canvas, upgraded to
    // the WebGL drawing buffer when the author created a WebGL context (read
    // from the instrumented registry — never by creating a context here). A
    // drawing buffer can be clamped below the canvas size.
    let bufferWidth = canvas.width;
    let bufferHeight = canvas.height;
    let context = '2d';
    try {
      const registry = (globalThis as unknown as { __viscraftCanvasContexts?: WeakMap<HTMLCanvasElement, unknown> })
        .__viscraftCanvasContexts;
      const gl = registry?.get(canvas) as { drawingBufferWidth?: number; drawingBufferHeight?: number } | undefined;
      if (gl && typeof gl.drawingBufferWidth === 'number' && typeof gl.drawingBufferHeight === 'number') {
        bufferWidth = gl.drawingBufferWidth;
        bufferHeight = gl.drawingBufferHeight;
        context = 'webgl';
      }
    } catch {
      // An uninspectable context keeps the nominal buffer size.
    }

    const detail: Record<string, string | number> = {
      buffer: `${bufferWidth}x${bufferHeight}`,
      display: `${Math.round(displayWidth)}x${Math.round(displayHeight)}`,
      output: `${viewWidth}x${viewHeight}`,
      context,
    };
    if (bufferWidth < displayWidth || bufferHeight < displayHeight) {
      diagnostics.push({
        code: 'canvas-upscaled',
        message: `canvas backing buffer ${bufferWidth}x${bufferHeight} is smaller than its ${Math.round(displayWidth)}x${Math.round(displayHeight)} display pixels, so it is upscaled into the capture`,
        detail: {
          ...detail,
          bufferPixels: bufferWidth * bufferHeight,
          displayPixels: Math.round(displayWidth * displayHeight),
        },
      });
    }

    const bufferAspect = bufferHeight > 0 ? bufferWidth / bufferHeight : 0;
    const displayAspect = displayHeight > 0 ? displayWidth / displayHeight : 0;
    if (bufferAspect > 0 && displayAspect > 0 && Math.abs(bufferAspect - displayAspect) / displayAspect > 0.01) {
      diagnostics.push({
        code: 'canvas-aspect-mismatch',
        message: `canvas buffer aspect ${bufferAspect.toFixed(3)} differs from its displayed aspect ${displayAspect.toFixed(3)} by more than 1%, so the picture is stretched`,
        detail: {
          ...detail,
          bufferAspect: Number(bufferAspect.toFixed(4)),
          displayAspect: Number(displayAspect.toFixed(4)),
        },
      });
    }
  }

  // `document.fonts.ready` means loading finished, not that a face loaded
  // successfully: a declared-but-unavailable family makes text silently fall
  // back. Report declared faces whose status is not 'loaded', plus a used
  // @font-face family whose availability check is false.
  const generic = new Set([
    'serif',
    'sans-serif',
    'monospace',
    'cursive',
    'fantasy',
    'system-ui',
    'ui-serif',
    'ui-sans-serif',
    'ui-monospace',
    'ui-rounded',
    'emoji',
    'math',
    'fangsong',
  ]);
  const familyOf = (value: string): string =>
    value
      .trim()
      .replace(/^["']|["']$/g, '')
      .trim();
  const fontSet = document.fonts;
  const declaredFaces: Array<{ family: string; weight: string; status: string }> = [];
  try {
    fontSet.forEach(face => {
      const family = familyOf(face.family || '');
      if (!family) return;
      declaredFaces.push({ family, weight: String(face.weight), status: face.status });
    });
  } catch {
    // A document without a usable FontFaceSet contributes no font diagnostics.
  }

  const usedFamilies = new Set<string>();
  for (const element of Array.from(document.querySelectorAll('*'))) {
    const style = getComputedStyle(element);
    if (!style?.fontFamily) continue;
    for (const part of style.fontFamily.split(',')) {
      const family = familyOf(part).toLowerCase();
      if (family && !generic.has(family)) usedFamilies.add(family);
    }
  }

  const cssDeclared = new Map<string, { family: string; weight: string }>();
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | undefined;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin stylesheet
    }
    if (!rules) continue;
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const family = familyOf(rule.style.getPropertyValue('font-family'));
      if (!family) continue;
      const weight = rule.style.getPropertyValue('font-weight').trim() || 'normal';
      cssDeclared.set(`${family.toLowerCase()}\u0000${weight}`, { family, weight });
    }
  }

  const reported = new Set<string>();
  const report = (family: string, weight: string, status: string, reason: string): void => {
    const key = `${family.toLowerCase()}\u0000${weight}`;
    if (reported.has(key)) return;
    reported.add(key);
    let available = false;
    try {
      available = fontSet.check(`16px "${family}"`);
    } catch {
      available = false;
    }
    diagnostics.push({
      code: 'font-fallback',
      message: `declared font "${family}" (weight ${weight}) is ${reason}, so text silently falls back`,
      detail: { family, weight, status, available: String(available) },
    });
  };
  for (const face of declaredFaces)
    if (face.status !== 'loaded') report(face.family, face.weight, face.status, `not loaded (status "${face.status}")`);
  for (const { family, weight } of cssDeclared.values()) {
    if (!usedFamilies.has(family.toLowerCase())) continue;
    let available = false;
    try {
      available = fontSet.check(`${weight} 16px "${family}"`);
    } catch {
      continue; // an unparseable font-weight range: leave it to the status check
    }
    if (!available) report(family, weight, 'unavailable', 'declared but not available');
  }

  return diagnostics;
}

/**
 *
 * This is the exact setup half of {@link captureCode}, extracted so other
 * deterministic browser renderers (the sound renderer in `sound.ts`) share the
 * same listener-free, snapshot-served Chrome path. It copies only allowlisted
 * files, fulfils every request for the nominal capture origin from the snapshot,
 * aborts external requests, runs the optional `prepare` host hook before
 * navigation, then waits for the entry contract global, fonts, optional
 * `ready()` and image readiness before returning.
 *
 * The returned {@link OpenedScene} owns a live browser and temp snapshot, so the
 * caller MUST call `close()` (typically in a `finally`). If setup throws, the
 * browser and snapshot are already cleaned up before the error propagates.
 *
 * @param source Entry (HTML, or a `.ts`/`.tsx` module) plus declared resources, relative to `root`.
 * @param viewport Initial page viewport (device scale factor 1).
 * @param contract Which global the entry exposes and the error-message prefix.
 * @param hooks Optional trusted host-side hooks; only `prepare` is driven here.
 * @param bindings Frozen asset bindings staged and served as snapshot URLs.
 */
export async function openCodeScene(
  root: string,
  source: { entry: string; resources: string[] },
  viewport: { width: number; height: number },
  contract: SceneContract | null,
  hooks: CaptureLifecycle = {},
  bindings: Record<string, CaptureBinding> = {},
): Promise<OpenedScene> {
  const label = contract?.label ?? 'captureDocument';
  const globalName = contract?.globalName ?? null;
  const disposeTimeoutMs =
    Number(process.env.VISCRAFT_CAPTURE_DISPOSE_TIMEOUT_MS) > 0
      ? Number(process.env.VISCRAFT_CAPTURE_DISPOSE_TIMEOUT_MS)
      : DEFAULT_DISPOSE_TIMEOUT_MS;

  const entryExt = path.extname(source.entry).toLowerCase();
  const isTypeScriptEntry = isTypeScriptPath(source.entry);
  if (!isTypeScriptEntry && entryExt !== '.html' && entryExt !== '.htm') {
    throw new Error(
      `${label}: entry "${source.entry}" must be an HTML file (.html/.htm) exposing window.${globalName}, ` +
        'or a TypeScript entry (.ts/.tsx) compiled to a module exposing it.',
    );
  }

  const rootReal = await fs.realpath(root);
  if (!(await fs.stat(rootReal)).isDirectory()) {
    throw new Error(`${label}: project root "${root}" is not a directory`);
  }
  const browserExecutable = await findBrowser();

  const snapshotRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-capture-'));
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (browser) {
      // Best-effort dispose, bounded so a hanging dispose can never stall cleanup.
      // Errors here are swallowed so they cannot mask a primary failure.
      try {
        for (const openPage of await browser.pages()) {
          if (globalName)
            await withTimeout(
              openPage.evaluate(async (name: string) => {
                const v = (globalThis as unknown as Record<string, { dispose?: () => void | Promise<void> }>)[name];
                if (v && typeof v.dispose === 'function') await v.dispose();
              }, globalName),
              disposeTimeoutMs,
              `window.${globalName}.dispose()`,
            ).catch(() => undefined);
        }
      } catch {
        // browser or page already gone; nothing to dispose
      }
      await browser.close().catch(() => undefined);
    }
    await fs.rm(snapshotRoot, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    // Copy only allowlisted files into the snapshot, preserving relative paths.
    const entryReal = await safeResolve(rootReal, source.entry);
    await copyIntoSnapshot(snapshotRoot, source.entry, entryReal);
    for (const resource of source.resources) {
      await copyIntoSnapshot(snapshotRoot, resource, await safeResolve(rootReal, resource));
    }

    // Stage each binding at its real Project-relative path so a bound file that
    // references siblings by relative URL (a .gltf's `textures/a.png`, a
    // stylesheet's `../fonts/x.woff2`) resolves without rewriting author URLs.
    const bindingDirs: Record<string, string> = {};
    for (const [key, binding] of Object.entries(bindings)) {
      const rel = path.posix.join('__bindings__', binding.path);
      await copyIntoSnapshot(snapshotRoot, rel, await safeResolve(rootReal, binding.path));
      bindingDirs[key] = rel;
    }

    // TypeScript authoring: type-check the staged entry plus declared resources
    // as one program, then emit each `.ts`/`.tsx` to its `.js` sibling so the
    // snapshot serves executable JS and idiomatically-written `./helper.js`
    // specifiers resolve. A type error throws here, before Chrome starts.
    // A `.ts`/`.tsx` entry has no HTML document of its own, so a minimal module
    // loader is generated beside it; an HTML entry keeps loading its own scripts.
    const emittedJs = await transpileStagedTypeScript({
      snapshotRoot,
      files: [source.entry, ...source.resources],
      label,
    });
    let navigationEntry = source.entry;
    if (isTypeScriptEntry) {
      const entryJs = emittedJsPath(source.entry);
      if (!emittedJs.includes(entryJs)) {
        throw new Error(`${label}: TypeScript entry "${source.entry}" was not emitted to "${entryJs}"`);
      }
      navigationEntry = path.posix.join(path.posix.dirname(source.entry), '__viscraft_entry__.html');
      const loader = `<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module" src="./${path.posix.basename(entryJs)}"></script></body></html>`;
      await fs.writeFile(path.resolve(snapshotRoot, navigationEntry), loader);
    }

    const failures: string[] = [];
    const blocked = new Set<string>();

    // A URL namespace only: no process listens at this origin and no local
    // request is continued to the network. Each browser has its own snapshot.
    const origin = 'http://127.0.0.1:47631';

    const bindingArg: Record<string, { id: string; url: string; sha256: string }> = {};
    for (const [key, rel] of Object.entries(bindingDirs)) {
      const binding = bindings[key];
      bindingArg[key] = {
        id: binding.id,
        url: `${origin}/${rel.split('/').map(encodeURIComponent).join('/')}`,
        sha256: binding.sha256,
      };
    }

    browser = await puppeteer.launch({
      executablePath: browserExecutable,
      headless: true,
      pipe: true,
      args: [
        // Supports trusted root containers; the browser is NOT a security sandbox.
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--enable-unsafe-swiftshader',
        '--hide-scrollbars',
        '--mute-audio',
        '--no-first-run',
        '--no-default-browser-check',
        '--force-color-profile=srgb',
        '--font-render-hinting=none',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
      ],
    });
    const browserVersion = await browser.version();

    const page = await browser.newPage();
    page.on('pageerror', err => {
      failures.push(`page error: ${err instanceof Error ? err.message : String(err)}`);
    });
    page.on('response', response => {
      const status = response.status();
      if (status >= 400 && !isFavicon(response.url())) {
        failures.push(`resource "${response.url()}" responded with HTTP ${status}`);
      }
    });
    page.on('requestfailed', request => {
      const url = request.url();
      if (isFavicon(url) || blocked.has(url)) return;
      const reason = request.failure()?.errorText ?? 'unknown error';
      failures.push(`request failed: "${url}" (${reason})`);
    });

    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = request.url();
      const settle = async (): Promise<void> => {
        if (!isAllowedCaptureUrl(url, origin)) {
          blocked.add(url);
          failures.push(`blocked external network request: "${url}"`);
          await request.abort('blockedbyclient');
        } else if (url && new URL(url).origin === origin) {
          await serveSnapshot(snapshotRoot, request);
        } else {
          await request.continue();
        }
      };
      void settle().catch(error => {
        failures.push(
          `request fulfillment failed: "${url}" (${error instanceof Error ? error.message : String(error)})`,
        );
        if (!request.isInterceptResolutionHandled()) void request.abort('failed').catch(() => undefined);
      });
    });

    await page.setViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 });

    // Instrument `getContext` before any page script runs so capture diagnostics
    // can read a canvas's REAL context kind — and a WebGL context's drawing
    // buffer — without ever creating a context of their own. Calls are recorded
    // and passed straight through, so the author's scene is unchanged.
    await page.evaluateOnNewDocument(() => {
      const registry = new WeakMap<HTMLCanvasElement, unknown>();
      (
        globalThis as unknown as { __viscraftCanvasContexts?: WeakMap<HTMLCanvasElement, unknown> }
      ).__viscraftCanvasContexts = registry;
      const original = HTMLCanvasElement.prototype.getContext;
      const wrapped = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]): unknown {
        const context = (original as unknown as (...args: unknown[]) => unknown).call(this, type, ...rest);
        if (context && (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl'))
          registry.set(this, context);
        return context;
      };
      HTMLCanvasElement.prototype.getContext = wrapped as typeof HTMLCanvasElement.prototype.getContext;
    });

    // Trusted host hook: runs before navigation so evaluateOnNewDocument can
    // observe the real document from its first script.
    if (hooks.prepare) {
      const prepare = hooks.prepare;
      await runHook('lifecycle.prepare()', READY_TIMEOUT_MS, () => prepare(page));
    }

    const entryUrl = `${origin}/${navigationEntry.split('/').map(encodeURIComponent).join('/')}`;
    await page.goto(entryUrl, { waitUntil: 'load', timeout: NAVIGATION_TIMEOUT_MS });

    if (globalName) {
      const hasContract = await page.evaluate((name: string) => {
        const v = (globalThis as unknown as Record<string, { render?: unknown }>)[name];
        return typeof v?.render === 'function';
      }, globalName);
      if (!hasContract) {
        throw new Error(`${label}: entry page did not expose window.${globalName}.render`);
      }
    }

    await withTimeout(
      page.evaluate(async () => {
        const fonts = (document as unknown as { fonts?: { ready?: Promise<unknown> } }).fonts;
        if (fonts?.ready) await fonts.ready;
      }),
      READY_TIMEOUT_MS,
      'document.fonts.ready',
    );
    if (globalName)
      await withTimeout(
        page.evaluate(async (name: string) => {
          const v = (globalThis as unknown as Record<string, { ready?: () => Promise<void> }>)[name];
          if (typeof v?.ready === 'function') await v.ready();
        }, globalName),
        READY_TIMEOUT_MS,
        `window.${globalName}.ready()`,
      );

    // Let images settle, force decode, then report broken ones (naturalWidth 0).
    const brokenImages = await withTimeout(
      page.evaluate(async () => {
        const images = Array.from(document.images);
        await Promise.all(
          images.map(img =>
            img.complete
              ? Promise.resolve()
              : new Promise<void>(resolve => {
                  img.addEventListener('load', () => resolve(), { once: true });
                  img.addEventListener('error', () => resolve(), { once: true });
                }),
          ),
        );
        await Promise.all(images.map(img => img.decode().catch(() => undefined)));
        return images.filter(img => !img.complete || img.naturalWidth === 0).map(img => img.currentSrc || img.src);
      }),
      READY_TIMEOUT_MS,
      'image readiness',
    );

    throwIfFailed(label, failures);
    if (brokenImages.length > 0) {
      throw new Error(`${label}: broken image(s): ${brokenImages.join(', ')}`);
    }

    // Optional stateful-source reset: return to the known initial state before
    // recording. Sources without `reset` skip this.
    if (globalName)
      await withTimeout(
        page.evaluate(async (name: string) => {
          const v = (globalThis as unknown as Record<string, { reset?: () => void | Promise<void> }>)[name];
          if (v && typeof v.reset === 'function') await v.reset();
        }, globalName),
        READY_TIMEOUT_MS,
        `window.${globalName}.reset()`,
      );

    // Non-blocking capture diagnostics. Collected on demand (see
    // {@link OpenedScene.collectDiagnostics}) so a caller can read the settled
    // scene AFTER the author's own sizing/render code has run. A failure to
    // inspect the page yields no diagnostics and never fails the capture.
    const collectDiagnostics = async (): Promise<CaptureDiagnostic[]> =>
      withTimeout(page.evaluate(collectCaptureDiagnostics), READY_TIMEOUT_MS, 'capture diagnostics').catch(
        () => [] as CaptureDiagnostic[],
      );

    return {
      page,
      browserVersion,
      bindings: bindingArg,
      collectDiagnostics,
      assertHealthy: () => throwIfFailed(label, failures),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export interface StillCaptureOptions {
  /** Logical canvas the document is authored for. */
  width: number;
  height: number;
  /** Output pixel density: the saved image is `width*scale × height*scale`. */
  scale: number;
  format: 'png' | 'jpeg' | 'webp';
  background: 'transparent' | 'opaque';
}

export interface StillCaptureResult {
  bytes: Buffer;
  /** Real output pixels of `bytes`. */
  width: number;
  height: number;
  browserVersion: string;
  diagnostics: CaptureDiagnostic[];
}

/**
 * Apply the workbench's saved edit record to the captured page with the SAME
 * script the preview loads (`layout-record.js`): text slots, slot fonts,
 * deletions, explicit sizes and layer offsets. The record is gated by its
 * `sourceHash`, so an author edit after the save wins and an obsolete record is
 * ignored; no edit-application logic is duplicated here.
 */
async function applySavedLayout(page: Page, root: string, entry: string): Promise<void> {
  const html = await fs.readFile(await resolveProjectPath(root, entry), 'utf8');
  if (!html.includes('data-viscraft-layout')) return;
  let script: string;
  try {
    script = await fs.readFile(path.join(WORKBENCH_ASSETS, 'layout-record.js'), 'utf8');
  } catch (error) {
    throw new Error(
      `captureStill: cannot read layout-record.js from ${WORKBENCH_ASSETS}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  // Runtime.evaluate is not subject to the author page's CSP, unlike an
  // injected <script> element; a strict document must still get the layout.
  await page.evaluate(script);
  await page.evaluate((source: string) => {
    const layout = (
      globalThis as unknown as {
        __viscraftLayoutRecord?: {
          apply(html: string, document: Document): { layers: number; texts: number; fonts: number; removed: number };
        };
      }
    ).__viscraftLayoutRecord;
    if (!layout) throw new Error('captureStill: layout-record.js did not install __viscraftLayoutRecord');
    layout.apply(source, document);
  }, html);
}

/**
 * Capture ONE still image from an editable HTML document (no `window.viscraft`
 * contract). Reuses the same frozen snapshot, resource serving, font/image
 * readiness and network blocking as `openCodeScene`; the page is then clipped to
 * the logical canvas and rasterized at `scale`. A document that is not authored
 * at the declared canvas is captured as-is — the caller compares the declared
 * canvas with the real output, never a second size authority.
 */
export async function captureStill(
  root: string,
  source: { entry: string; resources: string[] },
  options: StillCaptureOptions,
): Promise<StillCaptureResult> {
  const width = Math.max(2, Math.round(options.width));
  const height = Math.max(2, Math.round(options.height));
  if (!Number.isFinite(options.scale) || options.scale <= 0)
    throw new Error(`captureStill: scale must be a positive number, got ${String(options.scale)}`);
  const outputWidth = Math.max(1, Math.round(width * options.scale));
  const outputHeight = Math.max(1, Math.round(height * options.scale));
  const scene = await openCodeScene(root, source, { width, height }, null);
  try {
    // The document keeps its LOGICAL layout size and is rasterized at the
    // output density: deviceScaleFactor is the honest way to get 2x pixels
    // (a CSS-space screenshot upscaled afterwards would not be 2x detail).
    await scene.page.setViewport({ width, height, deviceScaleFactor: options.scale });
    await scene.page.evaluate(() => {
      document.documentElement.style.margin = '0';
      document.body.style.margin = '0';
      document.documentElement.style.overflow = 'hidden';
      document.body.style.overflow = 'hidden';
    });
    // Two painted frames: layout/DOM has settled before the raster. A still can
    // declare @font-face, so wait for the faces to be usable FIRST — otherwise a
    // fast capture could rasterize the fallback while a film build (which awaits
    // `window.viscraft.ready`) would use the real face.
    await scene.page.evaluate(() => document.fonts.ready.then(() => true)).catch(() => undefined);
    // Apply the same saved layout the workbench showed. This runs AFTER the
    // viewport is final, so an author script reacting to load/resize cannot
    // overwrite the saved geometry between this call and the raster.
    await applySavedLayout(scene.page, root, source.entry);
    await scene.page.evaluate(
      () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    const diagnostics = await scene.collectDiagnostics();
    const shot = await scene.page.screenshot({
      type: options.format,
      // PNG and WebP both carry alpha and honour Chromium's omitBackground.
      // JPEG cannot (the schema rejects transparent JPEG, and the format itself
      // has no alpha), so it is never asked to omit.
      omitBackground: options.background === 'transparent' && (options.format === 'png' || options.format === 'webp'),
      captureBeyondViewport: false,
    });
    scene.assertHealthy();
    return {
      bytes: Buffer.from(shot),
      width: outputWidth,
      height: outputHeight,
      browserVersion: scene.browserVersion,
      diagnostics,
    };
  } finally {
    await scene.close();
  }
}

/**
 * Render a CodeScene to a PNG frame sequence.
 *
 * @param root Project root. Only files inside it, resolved through the shared
 *   `io.resolveProjectPath` policy (unsafe relative paths and all symlinks are
 *   rejected), are copied into the capture snapshot.
 * @param source The `code` source (entry HTML or `.ts`/`.tsx` module, resources, params, seed, frames).
 * @param output Output settings (width/height must be even; fps is rational).
 * @param destination Directory that receives `frame-%06d.png` files (created if missing).
 * @param bindings Optional frozen asset bindings, exposed to `render` as URLs served
 *   from the snapshot. Their files are copied into the snapshot and the mapping is
 *   passed to the author page as `bindings`.
 * @param lifecycle Optional trusted host-side hooks (see {@link CaptureLifecycle})
 *   for real input recording/replay around navigation and each frame.
 */
export async function captureCode(
  root: string,
  source: CodeSceneSource,
  output: OutputSettings,
  destination: string,
  bindings: Record<string, CaptureBinding> = {},
  lifecycle: CaptureLifecycle = {},
): Promise<CaptureResult> {
  const settings = OutputSchema.parse(output);
  const fps = settings.fps.numerator / settings.fps.denominator;
  const frameTimeoutMs =
    Number(process.env.VISCRAFT_CAPTURE_FRAME_TIMEOUT_MS) > 0
      ? Number(process.env.VISCRAFT_CAPTURE_FRAME_TIMEOUT_MS)
      : DEFAULT_FRAME_TIMEOUT_MS;

  const scene = await openCodeScene(
    root,
    { entry: source.entry, resources: source.resources },
    { width: settings.width, height: settings.height },
    { label: 'captureCode', globalName: 'viscraft' },
    lifecycle,
    bindings,
  );

  let diagnostics: CaptureDiagnostic[] = [];
  try {
    await fs.mkdir(destination, { recursive: true });

    const renderFrame = async (frame: number): Promise<void> => {
      const time = (frame * settings.fps.denominator) / settings.fps.numerator;
      const { beforeFrame, afterFrame } = lifecycle;
      if (beforeFrame) {
        await runHook(`lifecycle.beforeFrame(${frame})`, frameTimeoutMs, () => beforeFrame(scene.page, frame));
      }
      scene.assertHealthy();
      await withTimeout(
        scene.page.evaluate(
          async args => {
            const v = (
              globalThis as unknown as {
                viscraft: { render: (a: unknown) => void | Promise<void> };
              }
            ).viscraft;
            await v.render(args);
          },
          {
            frame,
            time,
            fps,
            width: settings.width,
            height: settings.height,
            seed: source.seed,
            params: source.params,
            bindings: scene.bindings,
          },
        ),
        frameTimeoutMs,
        `render frame ${frame}`,
      );
      scene.assertHealthy();
      // Diagnostics are read once, right after the first frame renders and
      // before it is recorded, so the author's own sizing/context code has run
      // and the measurements describe the real scene. They never fail the
      // capture.
      if (frame === 0) diagnostics = await scene.collectDiagnostics();
      await withTimeout(
        scene.page.screenshot({
          path: path.join(destination, frameFileName(frame)),
          type: 'png',
          captureBeyondViewport: false,
        }),
        frameTimeoutMs,
        `screenshot frame ${frame}`,
      );
      scene.assertHealthy();
      if (afterFrame) {
        await runHook(`lifecycle.afterFrame(${frame})`, frameTimeoutMs, () => afterFrame(scene.page, frame));
      }
      scene.assertHealthy();
    };

    for (let frame = 0; frame < source.frames; frame++) {
      await renderFrame(frame);
    }

    return { browserVersion: scene.browserVersion, diagnostics };
  } finally {
    await scene.close();
  }
}

function throwIfFailed(label: string, failures: string[]): void {
  if (failures.length > 0) {
    throw new Error(`${label} failed:\n- ${failures.join('\n- ')}`);
  }
}

async function copyIntoSnapshot(snapshotRoot: string, rel: string, sourceReal: string): Promise<void> {
  const dest = path.resolve(snapshotRoot, rel);
  if (dest !== snapshotRoot && !dest.startsWith(snapshotRoot + path.sep)) {
    throw new Error(`Snapshot destination escapes snapshot root for "${rel}"`);
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(sourceReal, dest);
}

async function serveSnapshot(snapshotRoot: string, request: HTTPRequest): Promise<void> {
  if (request.method() !== 'GET' && request.method() !== 'HEAD') {
    await request.respond({ status: 405 });
    return;
  }
  let response: { status: number; contentType?: string; headers?: Record<string, string>; body?: Buffer };
  try {
    const rel = decodeURIComponent(new URL(request.url()).pathname).replace(/^\/+/, '');
    const target = path.resolve(snapshotRoot, rel);
    if (target !== snapshotRoot && !target.startsWith(snapshotRoot + path.sep)) {
      response = { status: 403 };
    } else {
      const st = await fs.stat(target).catch(() => undefined);
      if (!st || !st.isFile()) response = { status: 404 };
      else
        response = {
          status: 200,
          contentType: CONTENT_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
          headers: { 'content-length': String(st.size), 'cache-control': 'no-store' },
          ...(request.method() === 'HEAD' ? {} : { body: await fs.readFile(target) }),
        };
    }
  } catch {
    response = { status: 500 };
  }
  await request.respond(response);
}
