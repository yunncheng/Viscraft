/**
 * The browser executor: authored code run in the shared headless Chrome chain.
 *
 * `kind: 'browser'` owns every browser-driven Take; the Source's own `output`
 * and its `world`/`recording` bindings select which page contract and driving
 * mode runs:
 *  - `output: 'sound'`     → `renderSoundScene` (one deterministic audio buffer);
 *  - `output: 'picture'` + `recording`           → `captureReplay` (a recorded real
 *    play session replayed deterministically);
 *  - `output: 'picture'` + `world.mode: 'drive'` → `captureWorld` (the World is
 *    stepped per frame and each sampled state is handed to the page);
 *  - `output: 'picture'` (otherwise)             → `captureCode`, optionally with the
 *    World DEFINITION installed (`world.mode: 'define'`).
 *
 * Its binding / World / recording resolution, operation identity and capture
 * are owned here. The Project layer inventories its authored files.
 */
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { captureCode } from '../../backends/browser/capture.js';
import { renderSoundScene } from '../../backends/browser/sound.js';
import { captureReplay } from '../../backends/playable/playable.js';
import { captureWorld, installWorldDefinition } from '../../backends/world/world.js';
import { encodeFrames } from '../../backends/media/encoding.js';
import type { Source } from '../../core/schema.js';
import { browserBindings, boundInputs, inputDigest, resolveBoundSource, type BoundSource } from './shared.js';
import type { ResolvedSource, SourceContext, SourceExecutor } from './types.js';

type BrowserSource = Extract<Source, { kind: 'browser' }>;
type BrowserPictureSource = Extract<Source, { kind: 'browser'; output: 'picture' }>;
type BrowserSoundSource = Extract<Source, { kind: 'browser'; output: 'sound' }>;

/** The parameters a bound Source contributes to its operation key. */
function boundParameters(source: BoundSource, resolved: ResolvedSource, context: SourceContext): unknown {
  return {
    source,
    output: context.output,
    bindingAssets: resolved.bindingAssets,
    ...(resolved.resolvedWorld ? { world: resolved.resolvedWorld, worldAssets: resolved.worldAssets } : {}),
  };
}

const browserExecutor: SourceExecutor = {
  kind: 'browser',
  outputOf: source => (source as BrowserSource).output,
  implementationModules: [
    'backends/media/encoding',
    'backends/browser/capture',
    'backends/browser/sound',
    'backends/world/world',
    'backends/playable/playable',
  ],
  tools: { browser: true },
  proxyRasterFor: source => (source as BrowserSource).output === 'picture',
  staticFrames: (_project, source) => {
    const browser = source as BrowserSource;
    return browser.output === 'picture' ? browser.frames : undefined;
  },
  staticSamples: (_project, source) => {
    const browser = source as BrowserSource;
    return browser.output === 'sound' ? browser.durationSamples : undefined;
  },
  staticAudio: source => (source as BrowserSource).output === 'sound',
  probeAsset: () => undefined,
  testOnly: () => false,
  external: () => false,
  simulated: () => false,
  resolve: (source, context) => resolveBoundSource(context.project, source as BoundSource, context.loadRoot),
  identify: async (source, resolved, context) => {
    const browser = source as BrowserSource;
    if (browser.output === 'sound') {
      if (!context.sound)
        throw new Error(
          `Source ${browser.id} renders sound but no sound output was resolved; a sound Source must be produced for a sound target`,
        );
      return {
        inputs: [browser.entry, ...browser.resources].map(file => inputDigest(context.files, file, browser.id)),
        // The operation's clock facts: the Source's own native rate/span and the
        // consuming target's channel count. No raster, FPS or target span enters
        // this key, so a film edit cannot re-key a sound Take.
        parameters: {
          source: {
            entry: browser.entry,
            resources: browser.resources,
            params: browser.params,
            seed: browser.seed,
            durationSamples: browser.durationSamples,
            sampleRate: browser.sampleRate,
          },
          output: { sampleRate: browser.sampleRate, channels: context.sound.channels },
          bindingAssets: resolved.bindingAssets,
        },
      };
    }
    return {
      inputs: boundInputs(browser as BoundSource, resolved, context.files),
      parameters: boundParameters(browser as BoundSource, resolved, context),
    };
  },
  produce: async (source, resolved, context) => {
    const browser = source as BrowserSource;
    if (browser.output === 'sound') {
      if (!context.sound)
        throw new Error(
          `Source ${browser.id} renders sound but no sound output was resolved; a sound Source must be produced for a sound target`,
        );
      await renderSoundScene(
        context.frozenRoot,
        browser as BrowserSoundSource,
        // The page is a browser document, so it still needs SOME raster; this is
        // an internal implementation detail, not an authored output setting.
        { channels: context.sound.channels },
        context.destination,
        undefined,
        browserBindings(resolved.bindingAssets),
      );
      return {};
    }
    const picture = browser as BrowserPictureSource;
    const directory = path.join(context.scratch, `frames-${picture.id}`);
    await mkdir(directory);
    let diagnostics;
    if (picture.recording) {
      await captureReplay(
        context.frozenRoot,
        picture,
        context.output,
        directory,
        browserBindings(resolved.bindingAssets),
        resolved.resolvedWorld,
      );
    } else if (picture.world?.mode === 'drive') {
      ({ diagnostics } = await captureWorld(
        context.frozenRoot,
        picture,
        resolved.resolvedWorld!,
        context.output,
        directory,
        browserBindings(resolved.bindingAssets),
      ));
    } else {
      ({ diagnostics } = await captureCode(
        context.frozenRoot,
        picture,
        context.output,
        directory,
        browserBindings(resolved.bindingAssets),
        resolved.resolvedWorld ? { prepare: page => installWorldDefinition(page, resolved.resolvedWorld!) } : {},
      ));
    }
    await encodeFrames(directory, context.output, picture.frames, context.destination);
    await rm(directory, { recursive: true });
    return diagnostics ? { diagnostics } : {};
  },
};

export { browserExecutor };
