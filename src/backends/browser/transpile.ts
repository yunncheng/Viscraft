/**
 * TypeScript authoring entry for the browser capture chain.
 *
 * A code-authored CodeScene may be written in TypeScript. Before Chrome is
 * launched, every staged `.ts`/`.tsx` file is transpiled to its `.js` sibling in
 * the snapshot (with an inline source map), so authors keep idiomatic TS-ESM
 * specifiers (`./helper.js`) and the snapshot server delivers the executable
 * `.js` with the JS content type that `capture.ts` registers.
 *
 * Honesty over silent breakage: the staged set is loaded as a real TypeScript
 * program and `getPreEmitDiagnostics()` is checked first. Any syntactic or
 * semantic diagnostic aborts the capture, naming the file, position and TS code
 * — a type error can never emit partial or broken JS and can never become a
 * blank frame.
 *
 * `.tsx` support is deliberately dependency-free and explicit: JSX compiles to
 * calls to an author-provided factory named `h` (fragments use `Fragment`), and
 * the only thing this runtime adds is an ambient `JSX` namespace so the program
 * type-checks. No React, no `react/jsx-runtime`, and no DOM renderer is provided
 * or implied — an author who wants DOM output supplies their own `h`.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

/** File extensions this module transpiles in place. */
export const TYPESCRIPT_EXTENSIONS = ['.ts', '.tsx'] as const;

/** True for a project-relative path authored in TypeScript. */
export function isTypeScriptPath(rel: string): boolean {
  const ext = path.posix.extname(rel).toLowerCase();
  return ext === '.ts' || ext === '.tsx';
}

/**
 * True for a `.d.ts` declaration file.
 *
 * A declaration participates in the type-check program but is never an emit
 * unit: `transpileModule` on a `.d.ts` aborts with a TypeScript "Debug Failure"
 * and a `.js` sibling would be meaningless, so the emit loop skips it.
 */
export function isDeclarationPath(rel: string): boolean {
  return rel.toLowerCase().endsWith('.d.ts');
}

/** The `.js` sibling a transpiled entry/resource is emitted to. */
export function emittedJsPath(rel: string): string {
  const ext = path.posix.extname(rel);
  return rel.slice(0, rel.length - ext.length) + '.js';
}

/**
 * Ambient JSX namespace for the declared `h`/`Fragment` factory.
 *
 * It only supplies the member types a classic-factory JSX program needs, so
 * `<div/>` type-checks against `h` without pulling in any JSX runtime types.
 */
const JSX_NAMESPACE_SHIM = `declare namespace JSX {
  type Element = any;
  interface IntrinsicElements { [elemName: string]: any }
  interface ElementChildrenAttribute { children: {} }
}
`;

/**
 * Compiler options for the type-check program. `moduleResolution: Bundler` makes
 * `import './helper.js'` resolve to the staged `./helper.ts` (extension
 * substitution), matching the emitted ESM that the browser actually executes.
 */
const TYPE_CHECK_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  strict: true,
  skipLibCheck: true,
  noEmit: true,
  types: [],
  jsx: ts.JsxEmit.React,
  jsxFactory: 'h',
  jsxFragmentFactory: 'Fragment',
};

/** Emit options: ESM at the runtime target, with the source embedded for debugging. */
const EMIT_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  inlineSourceMap: true,
  inlineSources: true,
  jsx: ts.JsxEmit.React,
  jsxFactory: 'h',
  jsxFragmentFactory: 'Fragment',
};

export interface TranspileInput {
  /** Snapshot directory the staged files (entry plus resources) were copied into. */
  snapshotRoot: string;
  /** Staged project-relative paths; only `.ts`/`.tsx` entries are transpiled. */
  files: readonly string[];
  /** Error-message prefix (`captureCode`, `renderSoundScene`, ...). */
  label: string;
}

/**
 * Type-check and transpile every staged TypeScript file in place.
 *
 * No-op (returns `[]`) when the staged set contains no `.ts`/`.tsx`, so HTML/JS
 * authors pay nothing. On any diagnostic it throws before emitting anything, so
 * there is never a snapshot with a partially emitted `.js`. Returns the emitted
 * `.js` paths (project-relative) on success.
 */
export async function transpileStagedTypeScript(input: TranspileInput): Promise<string[]> {
  const { snapshotRoot, files, label } = input;
  const staged = files.filter(isTypeScriptPath);
  if (staged.length === 0) return [];

  const usesJsx = staged.some(rel => path.posix.extname(rel).toLowerCase() === '.tsx');
  let shimDir: string | undefined;
  try {
    const rootNames = staged.map(rel => path.resolve(snapshotRoot, rel));
    if (usesJsx) {
      shimDir = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-jsx-'));
      const shimPath = path.join(shimDir, 'viscraft-jsx.d.ts');
      await fs.writeFile(shimPath, JSX_NAMESPACE_SHIM);
      rootNames.push(shimPath);
    }

    const program = ts.createProgram(rootNames, TYPE_CHECK_OPTIONS);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length > 0) {
      const lines = diagnostics.map(diagnostic => formatDiagnostic(diagnostic, snapshotRoot, shimDir));
      throw new Error(`${label}: TypeScript authoring entry failed to compile:\n- ${lines.join('\n- ')}`);
    }

    const emitted: string[] = [];
    for (const rel of staged) {
      // A `.d.ts` type-checks as part of `rootNames` but is not an emit unit.
      if (isDeclarationPath(rel)) continue;
      const absolute = path.resolve(snapshotRoot, rel);
      const source = await fs.readFile(absolute, 'utf8');
      const output = ts.transpileModule(source, { compilerOptions: EMIT_OPTIONS, fileName: absolute });
      const target = path.resolve(snapshotRoot, emittedJsPath(rel));
      await fs.writeFile(target, output.outputText);
      emitted.push(emittedJsPath(rel));
    }
    return emitted;
  } finally {
    if (shimDir) await fs.rm(shimDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** One diagnostic as `file:line:col TS<code>: message`, with a snapshot-relative path. */
function formatDiagnostic(diagnostic: ts.Diagnostic, snapshotRoot: string, shimDir?: string): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  const file = diagnostic.file?.fileName;
  if (!file || diagnostic.start === undefined || !diagnostic.file) return `TS${diagnostic.code}: ${message}`;
  const relative =
    shimDir && file.startsWith(shimDir + path.sep)
      ? path.basename(file)
      : file.startsWith(snapshotRoot + path.sep)
        ? path.relative(snapshotRoot, file)
        : path.basename(file);
  const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${relative}:${line + 1}:${character + 1} TS${diagnostic.code}: ${message}`;
}
