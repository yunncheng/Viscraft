/**
 * Executor registry contract.
 *
 * A Source's `kind` answers exactly one question: WHICH executor runs this
 * authored recipe. Every kind-specific responsibility therefore lives behind one
 * registry entry ({@link SourceExecutor}) that the generic Plan/Build/identity
 * layers look up by `kind` instead of re-deriving the answer with their own
 * `source.kind === ...` branches.
 *
 * The interface centralizes, per executor:
 *  - static preflight facts (frames / audio / test-only / external / simulated);
 *  - reference resolution (bindings, World, media, recording, generation refs);
 *  - the operation input/parameter/implementation identity material;
 *  - capture/generation into a Take;
 *  - the provider configuration classification and read-only request preflight.
 *
 * It deliberately does NOT own the timeline, task locks, Artifact/Take
 * registration, authored-file inventory, clean protection or packing safety: those stay in the generic
 * layer, so an executor can never grow a second record store
 * or a circular dependency on the scheduler. An executor may report descriptive
 * data for diff/handoff but never owns HTML/document rendering.
 */
import type { Asset, Channels, OutputSettings, Project, SampleRate, Source, World } from '../../core/schema.js';
import type { CaptureDiagnostic } from '../../backends/browser/capture.js';
import type { BlenderOptions } from '../../backends/blender/render.js';
import type { PlayableRecording } from '../../backends/playable/playable.js';
import type { ImageApiOptions } from '../../backends/providers/services/vllm-omni/image-api.js';
import type { VideoApiOptions } from '../../backends/providers/services/video-tasks.js';

/** Provider configuration a Build/Plan was invoked with (never credentials). */
export interface ProviderOptions {
  videoApi?: Record<string, VideoApiOptions>;
  imageApi?: Record<string, ImageApiOptions>;
}

/** The preflight severity vocabulary shared with `build/plan.ts`'s `PlanLevel`. */
export type ExecutorPlanLevel = 'blocked' | 'needs_configuration' | 'requires_approval' | 'unsupported' | 'pending';

/** One structured preflight issue; structurally identical to `plan.ts`'s `PlanIssue`. */
export interface ExecutorIssue {
  level: ExecutorPlanLevel;
  /** A stable, machine-readable reason code (never localized text). */
  code: string;
  message: string;
  subject?: string;
}

/** The accumulator `planBuild` threads through each executor's `classify`. */
export interface ExecutorPreflightOut {
  blockers: ExecutorIssue[];
  needsConfiguration: ExecutorIssue[];
  requiresApproval: ExecutorIssue[];
  unsupported: ExecutorIssue[];
  pending: ExecutorIssue[];
}

/**
 * The sample-clock facts of a sound Source's operation: the channel count the
 * consuming sound target delivers at, and that target's exact programme span.
 * There is deliberately no width/height/FPS here: a sound Source has no picture
 * output, and a change to a film's raster or FPS must not re-key it.
 */
export interface SoundSourceOutput {
  sampleRate: SampleRate;
  channels: Channels;
  samples: number;
}

/**
 * Everything the identity computation needs that is NOT the Source itself:
 * the Project, the caller's provider configuration, the frozen authored-file
 * digest map the Build/snapshot produced, the operation output settings, and the
 * root the frozen closure is loaded from (a snapshot dir during a Build, the
 * project root during a read-only preflight).
 */
export interface SourceContext {
  project: Project;
  providers?: ProviderOptions;
  files: ReadonlyMap<string, string>;
  /** Picture output settings; meaningful only for a picture Source. */
  output: OutputSettings;
  /** Present exactly when the Source is a sound Source. */
  sound?: SoundSourceOutput;
  loadRoot: string;
}

/**
 * The per-Source objects a Take's production needs, resolved once and shared by
 * the identity computation and the capture/generation step.
 */
export interface ResolvedSource {
  bindingAssets: Array<{ binding: string; asset: Asset }>;
  resolvedWorld?: World;
  worldAssets: Asset[];
  mediaAsset?: Asset;
  playableRecording?: PlayableRecording;
  resolvedReferences: Asset[];
  generationReferences: Array<{ asset: string; category: string; role: string }>;
}

/**
 * The operation-identity material one executor owns: the ordered input hashes,
 * the parameter object, and (for a video Source) the selected protocol + its
 * effective implementation files that scope the operation's cache key.
 */
export interface SourceIdentityParts {
  inputs: string[];
  parameters: unknown;
  protocol?: string;
  implementationFiles?: readonly string[];
}

/**
 * Everything a Take's capture/generation step needs that is not the resolved
 * Source: the project root (provider media), the frozen closure root (browser /
 * media reads), a scratch dir for frame sequences, the output settings, and the
 * caller's provider/Blender configuration.
 */
export interface ProduceContext {
  root: string;
  frozenRoot: string;
  scratch: string;
  /** The file path the Take's media must be written to (supplied by the scheduler). */
  destination: string;
  /** Picture output settings; meaningful only for a picture Source. */
  output: OutputSettings;
  /** Present exactly when the Source is a sound Source. */
  sound?: SoundSourceOutput;
  providers?: ProviderOptions;
  blender?: BlenderOptions;
}

/** What a produce step reports back to the generic scheduler. */
export interface ProduceOutcome {
  diagnostics?: CaptureDiagnostic[];
  generation?: NonNullable<import('../../core/schema.js').Artifact['generation']>;
  imageGeneration?: NonNullable<import('../../core/schema.js').Artifact['imageGeneration']>;
}

/**
 * One executor: the single owner of a Source `kind`'s responsibilities.
 * Implementations are pure descriptors plus functions — no state, no record
 * store.
 */
export interface SourceExecutor {
  readonly kind: Source['kind'];
  /**
   * The Take medium for a given Source. Every unified author Source declares its
   * own `output` (`picture` | `sound`) in the schema; the browser and provider
   * executors answer from the Source (the provider's declared medium is
   * picture-only), while the fixed-medium executors (blender/simulated) answer
   * `picture`.
   */
  outputOf(source: Source): 'picture' | 'sound';
  /** Backend modules this executor's Take reaches (implementation fingerprint). */
  readonly implementationModules: readonly string[];
  /** Runtime tools whose version must enter this executor's environment facts. */
  readonly tools: { browser?: boolean; blender?: boolean };
  /** Whether a `scale < 1` preview renders THIS Source at the proxy raster. */
  proxyRasterFor(source: Source): boolean;

  /** Frames a picture Take yields when knowable WITHOUT reading media, else `undefined`. */
  staticFrames(project: Project, source: Source): number | undefined;
  /** Samples a sound Take yields when knowable WITHOUT reading media, else `undefined`. */
  staticSamples?(project: Project, source: Source): number | undefined;
  /** Whether a Take carries an audio stream statically, else `undefined`. */
  staticAudio(source: Source): boolean | undefined;
  /** The Asset whose media must be probed to learn the frame count, when any. */
  probeAsset(source: Source): string | undefined;
  /** True when the configured provider path for this Source is a loopback fixture. */
  testOnly(source: Source, providers?: ProviderOptions): boolean;
  /** True when the Build would talk to a real external service (not a fixture). */
  external(source: Source, testOnly: boolean, providers?: ProviderOptions): boolean;
  /** Whether a Take is known to be simulated from configuration/references alone. */
  simulated(source: Source, project: Project, testOnly: boolean): boolean;

  /** Resolve the Source's bindings / World / media / recording / references. */
  resolve(source: Source, context: SourceContext): Promise<ResolvedSource>;

  /** The operation input hashes, parameters and (video) implementation scope. */
  identify(source: Source, resolved: ResolvedSource, context: SourceContext): Promise<SourceIdentityParts>;

  /** The recorded Artifact `backend` label, when it is not the generic default. */
  backendLabel?(source: Source, providers?: ProviderOptions): string | undefined;

  /** Classify the Source's provider configuration into the plan's issue buckets. */
  classify?(source: Source, context: SourceContext, out: ExecutorPreflightOut): void | Promise<void>;

  /** Read-only request validation the Build would run, before any submission. */
  requestIssues?(source: Source, context: SourceContext): Promise<ExecutorIssue[]>;

  /** Produce the Take into `destination` (or fail loudly). */
  produce(source: Source, resolved: ResolvedSource, context: ProduceContext): Promise<ProduceOutcome>;
}
