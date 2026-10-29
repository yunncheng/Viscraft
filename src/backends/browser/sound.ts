/**
 * Deterministic browser sound-scene renderer.
 *
 * Renders a code-authored sound scene to a PCM16LE WAV by evaluating a page
 * contract in the same listener-free, snapshot-served, pipe-only Chrome used for
 * CodeScene picture capture (see `openCodeScene` in `./capture.ts`).
 *
 * Authoring contract — the entry HTML file must expose:
 *
 *   window.viscraftSound = {
 *     ready?: () => Promise<void>,
 *     render: (args: {
 *       sampleRate: number;
 *       channels: number;
 *       samples: number;
 *       params: Record<string, unknown>;
 *       seed: number;
 *     }) => Float32Array | { channels: Float32Array[] } | Promise<...>,
 *     dispose?: () => void | Promise<void>,
 *   };
 *
 * `render` is called EXACTLY ONCE per invocation. `sampleRate` is the Source's
 * NATIVE rate and `samples` is its authored per-channel SAMPLE count
 * (`source.durationSamples`) — never a picture frame count derived from an FPS,
 * and never resampled here. Resampling to a sound target's rate happens later,
 * in the mixer. `render` must return either
 *   - a single interleaved Float32Array of length `channels * samples`, or
 *   - `{ channels: Float32Array[] }` with exactly `channels` arrays, each of
 *     length `samples`.
 * Padding, truncation and resampling are all rejected. This is a distinct global
 * from the video contract (`window.viscraft`): neither path requires the other.
 *
 * REPRODUCIBILITY: the author contract is a pure function of
 * `{ sampleRate, channels, samples, params, seed }` — no wall clock, no unseeded
 * `Math.random`, no network, no state shared across invocations. The Runtime
 * enforces only exact returned length, sample finiteness and `|sample| <= 1`; it
 * CANNOT detect nondeterminism by itself. It also does NOT promise
 * byte-identical re-renders: Chrome's `OfflineAudioContext` was measured here to
 * render small graphs bit-identically but to diverge at the LSB for graphs with
 * tens of voices (a nondeterministic accumulation order). What the pipeline
 * actually guarantees is input-keyed Take identity: an operation key derived
 * from the frozen entry bytes, params, seed, native sample count/rate and channel count,
 * so a rebuild reuses the recorded Take rather than relying on the platform
 * emitting identical bytes. Two independent roots produce signal-equivalent,
 * exactly-spanned Takes, not necessarily byte-equal WAVs. There is deliberately
 * no limiter: an out-of-range render is an authoring error the author must fix
 * by lowering internal gains, never something the Runtime silently clamps.
 *
 * SECURITY: identical to `captureCode` — a real Chrome with `--no-sandbox`,
 * snapshot bytes served through request interception over a DevTools pipe (no
 * TCP listener), external requests aborted. This is NOT a code sandbox; only run
 * trusted sources.
 */
import fs from 'node:fs/promises';
import { openCodeScene, type CaptureLifecycle } from './capture.js';
import { encodeWav } from '../media/pcm.js';

// Kept consistent with capture's bounds: the render is one long evaluate, so it
// gets the same default budget as a single captured frame.
const DEFAULT_RENDER_TIMEOUT_MS = 30_000;

/** The fields a `browser` Source with `output: 'sound'` contributes to this renderer. */
export interface SoundSourceLike {
  id: string;
  entry: string;
  resources: string[];
  params: Record<string, unknown>;
  seed: number;
  /** Native per-channel sample span. This IS the Take length; no frame clock. */
  durationSamples: number;
  /** Native sample rate the page renders at. */
  sampleRate: number;
}

/**
 * The only output fact a sound render takes: the channel count chosen by the
 * consuming sound target. There is deliberately NO raster, FPS or sample rate
 * here — the clock and rate come from the Source, and the page's tiny internal
 * raster is an implementation detail of this renderer.
 */
export interface SoundOutputSettings {
  channels: number;
}

/** The page is still a browser document; 16×16 is enough to host an audio graph. */
const INTERNAL_PAGE_RASTER = { width: 16, height: 16 };

/** Result of a successful sound-scene render. */
export interface SoundSceneResult {
  browserVersion: string;
  /** Per-channel sample count (the `samples` value handed to `render`). */
  samples: number;
  channels: number;
  sampleRate: number;
}

/** The normalized, CDP-serializable shape of `render`'s return value. */
type Transported = { kind: 'interleaved'; data: number[] } | { kind: 'channels'; data: number[][] };

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/** Validate a single raw sample (may be `null` after a JSON NaN/Infinity round-trip). */
function validateSample(value: unknown, index: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `renderSoundScene: non-finite sample at index ${index} (${JSON.stringify(value) ?? 'undefined'}); ` +
        'the sound scene must produce finite samples',
    );
  }
  if (Math.abs(value) > 1) {
    throw new Error(
      `renderSoundScene: output exceeds full scale (index ${index} = ${value}, |v| > 1); ` +
        'lower the scene internal gains — no limiter is applied',
    );
  }
  return value;
}

/**
 * Validate the exact expected shape/length, finiteness and full-scale bound of
 * the rendered channels, then flatten to a fresh interleaved Float32Array.
 * Nothing is ever padded, truncated, resampled or clamped.
 */
function validateAndInterleave(transported: Transported, channels: number, frames: number): Float32Array {
  const expected = channels * frames;
  const flat = new Float32Array(expected);

  if (transported.kind === 'interleaved') {
    const data = transported.data;
    if (data.length !== expected) {
      throw new Error(
        `renderSoundScene: window.viscraftSound.render() returned ${data.length} interleaved samples; ` +
          `expected exactly ${expected} (channels * frames = ${channels} * ${frames})`,
      );
    }
    for (let i = 0; i < expected; i++) flat[i] = validateSample(data[i], i);
    return flat;
  }

  const data = transported.data;
  if (data.length !== channels) {
    throw new Error(
      `renderSoundScene: window.viscraftSound.render() returned ${data.length} channel arrays; ` +
        `expected exactly ${channels}`,
    );
  }
  for (let c = 0; c < channels; c++) {
    const channel = data[c];
    if (channel.length !== frames) {
      throw new Error(
        `renderSoundScene: window.viscraftSound.render() channel ${c} has ${channel.length} samples; ` +
          `expected exactly ${frames}`,
      );
    }
    for (let i = 0; i < frames; i++) flat[i * channels + c] = validateSample(channel[i], c * frames + i);
  }
  return flat;
}

/**
 * Render a code-authored sound Source to a PCM16LE WAV.
 *
 * @param root Project root; only files inside it (through the shared
 *   `io.resolveProjectPath` policy) reach the snapshot the page reads from.
 * @param source The `sound` source (entry HTML, resources, params, seed,
 *   durationSamples, sampleRate).
 * @param output Only `channels` (chosen by the consuming sound target) plus an
 *   internal page raster; the clock comes from the Source.
 * @param destination WAV file path to write on success; never touched on failure.
 * @param hooks Optional trusted host-side hooks; only `prepare` runs (the scene
 *   renders in a single pass, so `beforeFrame`/`afterFrame` do not apply).
 * @param bindings Optional frozen asset bindings staged and served from the snapshot.
 * @returns The browser version and the exact sample count / channel / rate written.
 */
export async function renderSoundScene(
  root: string,
  source: SoundSourceLike,
  output: SoundOutputSettings,
  destination: string,
  hooks?: CaptureLifecycle,
  bindings?: Record<string, { id: string; path: string; sha256: string }>,
): Promise<SoundSceneResult> {
  if (!Number.isSafeInteger(output.channels) || output.channels <= 0) {
    throw new Error(`renderSoundScene: channels must be a positive integer, got ${output.channels}`);
  }
  // The canonical clock: the Source's own authored SAMPLE span, at its own
  // native sample rate. No picture frame/FPS conversion is involved.
  const frames = source.durationSamples;
  if (!Number.isSafeInteger(frames) || frames <= 0) {
    throw new Error(`renderSoundScene: durationSamples must be a positive integer, got ${frames}`);
  }

  const renderTimeoutMs =
    Number(process.env.VISCRAFT_CAPTURE_FRAME_TIMEOUT_MS) > 0
      ? Number(process.env.VISCRAFT_CAPTURE_FRAME_TIMEOUT_MS)
      : DEFAULT_RENDER_TIMEOUT_MS;

  const scene = await openCodeScene(
    root,
    { entry: source.entry, resources: source.resources },
    INTERNAL_PAGE_RASTER,
    { label: 'renderSoundScene', globalName: 'viscraftSound' },
    hooks ?? {},
    bindings ?? {},
  );

  try {
    const args = {
      sampleRate: source.sampleRate,
      channels: output.channels,
      samples: frames,
      params: source.params,
      seed: source.seed,
    };

    // `render` may return a Float32Array, which does not survive Chrome's
    // return-by-value serialization; convert to plain number arrays in-page.
    const transported = await withTimeout(
      scene.page.evaluate(async (call: typeof args): Promise<Transported> => {
        const contract = (
          globalThis as unknown as {
            viscraftSound?: { render?: (a: typeof call) => unknown };
          }
        ).viscraftSound;
        if (!contract || typeof contract.render !== 'function') {
          throw new Error('window.viscraftSound.render is not a function');
        }
        const result = await contract.render(call);
        const toArray = (value: unknown): number[] | undefined => {
          if (value instanceof Float32Array) return Array.from(value);
          if (Array.isArray(value)) return value.map(Number);
          return undefined;
        };
        const interleaved = toArray(result);
        if (interleaved) return { kind: 'interleaved', data: interleaved };
        const channelized = (result as { channels?: unknown } | null | undefined)?.channels;
        if (Array.isArray(channelized)) {
          const data = channelized.map(toArray);
          if (data.some(entry => entry === undefined)) {
            throw new Error('window.viscraftSound.render() channels entries must be Float32Array or number[]');
          }
          return { kind: 'channels', data: data as number[][] };
        }
        throw new Error('window.viscraftSound.render() must return a Float32Array or { channels: Float32Array[] }');
      }, args),
      renderTimeoutMs,
      'window.viscraftSound.render(...)',
    );

    scene.assertHealthy();

    // Validate fully before writing anything, then encode the exact PCM16 span.
    const interleaved = validateAndInterleave(transported, output.channels, frames);
    await fs.writeFile(destination, encodeWav(interleaved, source.sampleRate, output.channels));

    return {
      browserVersion: scene.browserVersion,
      samples: frames,
      channels: output.channels,
      sampleRate: source.sampleRate,
    };
  } finally {
    // Always dispose the page's audio work, close the browser and drop the snapshot.
    await scene.close();
  }
}
