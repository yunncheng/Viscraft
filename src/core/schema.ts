import { z } from 'zod';
import { framesToSamples, ptsToFrames } from './time.js';

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const signedInteger = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const positive = integer.refine(n => n > 0);
export const Id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/);
export const RelativePath = z
  .string()
  .min(1)
  .refine(
    p =>
      !p.startsWith('/') &&
      !/^[a-z]:/i.test(p) &&
      !p.includes('\\') &&
      !p.includes('\0') &&
      p.split('/').every(s => s !== '..' && s !== '.' && s.length > 0),
    'Expected a safe project-relative path',
  );
// A requested/generated raster size as `WIDTHxHEIGHT` (e.g. `1024x1024`); `auto`
// and other symbolic sizes are NOT part of the frozen Viscraft contract. Both
// dimensions must be positive (1..99999) with no leading zero, so `0x0`,
// `0x512`, `512x0` and `0512x512` are rejected as unusable rasters.
export const ImageSizeSchema = z.string().regex(/^[1-9]\d{0,4}x[1-9]\d{0,4}$/);
export const FpsSchema = z.object({ numerator: positive, denominator: positive }).strict();
export type Fps = z.infer<typeof FpsSchema>;
/** The sample rates and channel counts this Runtime actually produces. */
export const SampleRateSchema = z.union([z.literal(48000), z.literal(44100)]);
export type SampleRate = z.infer<typeof SampleRateSchema>;
export const ChannelsSchema = z.union([z.literal(1), z.literal(2)]);
export type Channels = z.infer<typeof ChannelsSchema>;
export const OutputSchema = z
  .object({
    width: positive.refine(n => n % 2 === 0),
    height: positive.refine(n => n % 2 === 0),
    fps: FpsSchema,
    sampleRate: SampleRateSchema,
    channels: ChannelsSchema,
  })
  .strict();
export type OutputSettings = z.infer<typeof OutputSchema>;
// The single Asset rights authority. Beyond origin/license/redistributable it
// carries author-recorded ATTRIBUTION FACTS (author, source/license links, the
// license's own required notice text, and the changes actually made) so a
// required notice or author is structurally preserved across move-directory,
// export/archive/restore and final delivery instead of living only in a chat or
// scratch note. Attribution fields are optional and have no invented default.
// `attributionRequired` is an AUTHOR ASSERTION that the
// license requires attribution; it is never a license inference and the Runtime
// performs no rights judgement.
export const RightsSchema = z
  .object({
    origin: z.string().min(1),
    license: z.string().min(1),
    redistributable: z.boolean(),
    author: z.string().min(1).optional(),
    sourceUrl: z.string().url().optional(),
    licenseUrl: z.string().url().optional(),
    notice: z.string().min(1).optional(),
    modifications: z.string().min(1).optional(),
    attributionRequired: z.boolean().optional(),
  })
  .strict();
// A rational stream timebase: the PTS ticks of an audio stream, where one tick
// is `numerator / denominator` seconds. Deliberately integer-num/den rather than
// a float second, so an interval in ticks maps exactly and is never rounded to a
// drifting decimal.
export const TimebaseSchema = z.object({ numerator: integer, denominator: positive }).strict();
export type Timebase = z.infer<typeof TimebaseSchema>;
// The ONE current Asset-derivation relation, discriminated on `kind`:
//  - `frame` — one decoded picture frame of a video Build medium, produced by
//    `promoteFrame`/`promoteRange` (a `frame` is a real source-frame index, never
//    a timeline position);
//  - `audio` — a decoded audio stream interval of a video Build medium, produced
//    by `extract-audio` into a new audio Asset. It records the source stream's
//    audio-relative index (the `<n>` of FFmpeg's `-map 0:a:<n>`), the stream's
//    rational timebase, its source start PTS and the exact half-open interval
//    `[inPts, outPts)` in that timebase, plus the OUTPUT sample rate / start
//    sample / sample count probed from the produced WAV and the output hash
//    (`outputSha256`, which IS this Asset's own `sha256`). The mapping from the
//    source stream clock to output sample 0 (`startSample`) is recorded, never a
//    fabricated frame number — an audio derivation is a SOURCE registration, not
//    a second timeline.
// One current format, no alias: every producer and consumer uses this union.
export const AssetDerivationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('frame'),
      build: Id,
      artifact: Id,
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      frame: integer,
      take: Id.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('audio'),
      build: Id,
      artifact: Id,
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      take: Id.optional(),
      streamIndex: integer,
      timebase: TimebaseSchema,
      startPts: signedInteger,
      inPts: signedInteger,
      outPts: signedInteger,
      sampleRate: positive,
      startSample: integer,
      sampleCount: positive,
      processing: z.string().trim().min(1).max(2000).optional(),
      outputSha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
]);
export type AssetDerivation = z.infer<typeof AssetDerivationSchema>;
// Production references record the exact approved input versions and their
// creative roles. They are provenance, not executable dependency instructions.
export const AssetInputSchema = z
  .object({
    asset: Id,
    revision: positive,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    role: z.string().trim().min(1).max(1000),
  })
  .strict();
// Asset media kinds. `model` is a real 3D model in one supported format —
// currently glTF binary (`.glb`) or glTF JSON (`.gltf`); other 3D formats get no
// placeholder module. A model's
// external textures/buffers, when a `.gltf` references them, are ordinary
// `image` Assets recorded through `inputs` (roles such as `texture`), so their
// bytes, hashes and rights are tracked like any other Asset; a self-contained
// `.glb` embeds them and needs no inputs.
//
// `inputs` records the FROZEN parent-version relations of a derived/produced
// Asset (id + revision + hash + creative role) as a SET: one relation per
// distinct parent Asset, in first-reference order. There is deliberately NO
// fixed count or byte gate on these provenance relations. A request may legally
// reference the SAME parent Asset
// in several roles; those ordered roles live on the generation provenance's
// `references` (see `ImageGenerationSchema`), not as duplicate relations here, so
// a duplicate reference never loses its real relation, is never silently
// truncated and never double-counts.
//
// `imageGeneration` is the hash-only portable provenance of a generated/edited
// image Asset, reusing the SAME `ImageGenerationSchema` an Artifact carries (one
// meaning, two owners: an Artifact owns the provenance of a Build-produced
// medium; an Asset owns the provenance of a registered generated image). It is
// written by `generate-image` and verified structurally by
// `assertAssetImageGeneration` (called from `validateProject`, so load, snapshot,
// export/archive and restore share one contract). It never carries a key,
// authorization, service URL, raw mask or internal path — only hashes, the
// ordered reference roles/categories, the output hash and the simulated marker.
export const AssetSchema = z
  .object({
    id: Id,
    revision: positive,
    path: RelativePath,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    type: z.enum(['image', 'video', 'audio', 'font', 'code', 'model']),
    rights: RightsSchema,
    simulated: z.boolean().default(false),
    derivedFrom: AssetDerivationSchema.optional(),
    inputs: z.array(AssetInputSchema).min(1).optional(),
    // Declared after `ImageGenerationSchema` in source order, so it is referenced
    // lazily to avoid a module-initialization cycle.
    imageGeneration: z.lazy(() => ImageGenerationSchema).optional(),
  })
  .strict();
export type Asset = z.infer<typeof AssetSchema>;

/**
 * Strict structural verification of an Asset's hash-only image-generation
 * provenance. It verifies identity (the recorded output hash IS the Asset's
 * bytes, the simulated marker agrees) and the parent relationship (the ordered
 * `references` agree with the Asset's own `inputs` relations), and nothing else:
 * no bytes are read, and it is never a rights or aesthetic judgement. Exported
 * so the registration channel (`importAsset`) and `validateProject` enforce the
 * exact same contract on local load, snapshots, export/archive and restore.
 */
export function assertAssetImageGeneration(asset: Asset): void {
  const provenance = asset.imageGeneration;
  if (!provenance) return;
  if (asset.type !== 'image')
    throw new Error(`Asset ${asset.id} carries imageGeneration provenance but is a ${asset.type} Asset, not an image`);
  if (provenance.outputSha256 !== asset.sha256)
    throw new Error(
      `Asset ${asset.id} imageGeneration outputSha256 does not match its recorded bytes; refusing a forged provenance`,
    );
  if (provenance.simulated !== asset.simulated)
    throw new Error(`Asset ${asset.id} imageGeneration simulated marker disagrees with the Asset`);
  if (provenance.inputSha256.length !== provenance.references.length)
    throw new Error(`Asset ${asset.id} imageGeneration must list one inputSha256 per reference`);
  provenance.references.forEach((reference, index) => {
    if (reference.category !== 'image')
      throw new Error(`Asset ${asset.id} imageGeneration references a non-image ${reference.category} reference`);
    if (reference.sha256 !== provenance.inputSha256[index])
      throw new Error(`Asset ${asset.id} imageGeneration reference hashes must match inputSha256 in request order`);
  });
  const inputs = asset.inputs ?? [];
  const inputByAsset = new Map(inputs.map(input => [input.asset, input.sha256]));
  for (const reference of provenance.references) {
    const sha256 = inputByAsset.get(reference.asset);
    if (sha256 === undefined)
      throw new Error(
        `Asset ${asset.id} imageGeneration references ${reference.asset}, which is not a recorded production input; refusing a fabricated parent relation`,
      );
    if (sha256 !== reference.sha256)
      throw new Error(
        `Asset ${asset.id} imageGeneration reference ${reference.asset} hash disagrees with its recorded production input`,
      );
  }
  const referenced = new Set(provenance.references.map(reference => reference.asset));
  for (const input of inputs)
    if (!referenced.has(input.asset))
      throw new Error(
        `Asset ${asset.id} production input ${input.asset} is missing from its imageGeneration references`,
      );
}
/**
 * Strict structural verification of an Asset's hash-only AUDIO-derivation
 * provenance. Like `assertAssetImageGeneration` it verifies identity and the
 * shape of the recorded facts and nothing else: no bytes are read, and it is
 * never a rights or aesthetic judgement. Enforced from `validateProject`, so the
 * local load, snapshots, export/archive and restore apply one contract.
 *
 * What an `Asset` alone can prove is checked here: the derived Asset is really
 * an `audio` Asset, the recorded `outputSha256` IS its own bytes, the interval is
 * a nonempty half-open `[inPts, outPts)` over integer PTS with a usable rational
 * timebase and an `inPts` that does not precede the stream start, `streamIndex` is
 * a non-negative audio-relative index, the recorded output facts are positive, and
 * `startSample` equals the value its own start PTS/timebase/sample rate imply. The
 * parent lineage (the `take` really belongs to the named `artifact`, a `simulated`
 * parent cannot be recorded as non-simulated, and the record genuinely describes
 * the parent's REAL audio stream) needs the Build records and the parent medium,
 * so it is enforced where they are available — the Build (which re-probes the
 * selected stream and the produced file) and `productionClosure`, exactly as the
 * `frame` relation's take/frame checks already are.
 */
export function assertAssetAudioDerivation(asset: Asset): void {
  const derivation = asset.derivedFrom;
  if (!derivation || derivation.kind !== 'audio') return;
  if (asset.type !== 'audio')
    throw new Error(`Asset ${asset.id} carries an audio derivation but is a ${asset.type} Asset, not audio`);
  if (derivation.outputSha256 !== asset.sha256)
    throw new Error(
      `Asset ${asset.id} audio derivation outputSha256 does not match its recorded bytes; refusing a forged provenance`,
    );
  if (
    !Number.isInteger(derivation.startPts) ||
    !Number.isInteger(derivation.inPts) ||
    !Number.isInteger(derivation.outPts)
  )
    throw new Error(`Asset ${asset.id} audio derivation startPts/inPts/outPts must be integers in the stream timebase`);
  if (derivation.outPts <= derivation.inPts)
    throw new Error(`Asset ${asset.id} audio derivation interval must be nonempty and half-open [inPts, outPts)`);
  if (derivation.inPts < derivation.startPts)
    throw new Error(`Asset ${asset.id} audio derivation inPts must not precede the stream start PTS`);
  if (derivation.timebase.numerator <= 0 || derivation.timebase.denominator <= 0)
    throw new Error(`Asset ${asset.id} audio derivation needs a usable rational timebase`);
  if (derivation.sampleRate <= 0) throw new Error(`Asset ${asset.id} audio derivation sampleRate must be positive`);
  if (derivation.sampleCount <= 0) throw new Error(`Asset ${asset.id} audio derivation sampleCount must be positive`);
  // The recorded start-sample mapping must equal the value its OWN timebase,
  // start PTS and sample rate imply (the exact formula `extract-audio` writes), so
  // a hand-edited record that agrees with no observable fact is refused here.
  const impliedStartSample = Math.round(
    (((derivation.inPts - derivation.startPts) * derivation.timebase.numerator) / derivation.timebase.denominator) *
      derivation.sampleRate,
  );
  if (!Number.isSafeInteger(impliedStartSample) || derivation.startSample !== impliedStartSample)
    throw new Error(
      `Asset ${asset.id} audio derivation startSample does not match its recorded start PTS, timebase and sample rate`,
    );
}
export const PromoteFrameOptionsSchema = z
  .object({
    take: Id.optional(),
    artifact: Id.optional(),
    frame: integer,
    assetId: Id,
    rights: RightsSchema,
    expectedRevision: positive,
  })
  .strict()
  .refine(
    options => Boolean(options.take) !== Boolean(options.artifact),
    'Promotion requires exactly one Take or Artifact',
  );
export type PromoteFrameOptions = z.infer<typeof PromoteFrameOptionsSchema>;
export const Vector3Schema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
export const TransformSchema = z
  .object({
    position: Vector3Schema,
    rotation: Vector3Schema,
    scale: z.tuple([z.number().finite().positive(), z.number().finite().positive(), z.number().finite().positive()]),
  })
  .strict();
const WorldTrajectorySchema = z
  .object({
    id: Id,
    entity: Id,
    keyframes: z
      .array(z.object({ frame: integer, position: Vector3Schema, rotation: Vector3Schema.optional() }).strict())
      .min(1),
    path: z.enum(['linear', 'catmull-rom']).optional(),
    heading: z.enum(['keyframes', 'tangent']).optional(),
    closed: z.boolean().optional(),
  })
  .strict()
  .superRefine((trajectory, ctx) => {
    if (!trajectory.closed || trajectory.path !== 'catmull-rom') return;
    const keys = trajectory.keyframes;
    if (
      keys.length < 3 ||
      keys[0].position.some((value, axis) => Math.abs(value - keys[keys.length - 1].position[axis]) >= 1e-9)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['keyframes'],
        message: 'A closed spline needs at least three keys and a repeated first position at the final key',
      });
    }
  });
export const WorldSchema = z
  .object({
    id: Id,
    revision: positive,
    units: z.literal('meters'),
    coordinates: z.literal('right-handed-y-up'),
    fps: FpsSchema,
    frames: positive,
    entities: z.array(
      z.object({ id: Id, asset: Id, transform: TransformSchema, state: z.record(z.unknown()).default({}) }).strict(),
    ),
    trajectories: z.array(WorldTrajectorySchema).default([]),
    cameras: z
      .array(
        z
          .object({
            id: Id,
            position: Vector3Schema,
            target: Vector3Schema,
            fov: z.number().finite().gt(0).lt(180),
            follow: Id.optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type World = z.infer<typeof WorldSchema>;
export type Vector3 = z.infer<typeof Vector3Schema>;
export const BindingOverridesSchema = z.record(Id, Id);
/**
 * A Source's binding to one shared Project World + camera. `mode` states HOW the
 * World drives the shot — the unified handoff both the browser and Blender
 * executors implement:
 *  - `drive`  — the Runtime steps the World frame by frame and hands each frame's
 *    sampled state to the source (browser `window.__viscraftWorld`; Blender a
 *    `--world` sidecar). `startFrame` (the global World frame the source's local
 *    frame 0 maps to) is REQUIRED, so world time, entity instance
 *    transforms/trajectories and the resolved camera all reach the shot without a
 *    second World truth.
 *  - `define` — only the World DEFINITION is handed over
 *    (`window.__viscraftWorldDefinition`); how it moves is the shot's own
 *    business, so `startFrame` is FORBIDDEN (player-driven games).
 * The camera must exist and the fps grid / interval must agree; each executor
 * validates which modes it supports in its own module.
 */
export const WorldRefSchema = z
  .object({ id: Id, camera: Id, mode: z.enum(['drive', 'define']), startFrame: integer.optional() })
  .strict()
  .superRefine((ref, context) => {
    if (ref.mode === 'drive' && ref.startFrame === undefined)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['startFrame'],
        message:
          "A World binding with mode 'drive' requires `startFrame` (the local frame 0 maps to that global World frame)",
      });
    if (ref.mode === 'define' && ref.startFrame !== undefined)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['startFrame'],
        message: "A World binding with mode 'define' must not declare `startFrame` (the shot owns its own movement)",
      });
  });
export type WorldRef = z.infer<typeof WorldRefSchema>;
export const MediaFramingSchema = z
  .object({
    fit: z.enum(['contain', 'cover']).optional(),
    background: z
      .string()
      .regex(/^#[a-fA-F0-9]{6}$/)
      .optional(),
    position: z
      .object({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1) })
      .strict()
      .optional(),
  })
  .strict();
export type MediaFraming = z.infer<typeof MediaFramingSchema>;
export const LookGradeSchema = z
  .object({
    brightness: z.number().finite().min(-1).max(1).optional(),
    contrast: z.number().finite().min(0).max(3).optional(),
    saturation: z.number().finite().min(0).max(3).optional(),
    gamma: z.number().finite().min(0.1).max(3).optional(),
  })
  .strict();
export type LookGrade = z.infer<typeof LookGradeSchema>;
// ---------------------------------------------------------------------------
// Ordered generation references
// ---------------------------------------------------------------------------
// A generation request may carry MULTIPLE reference Assets in a MEANINGFUL
// ORDER. Each entry names the Asset, its `category` (what media it is) and its
// `role` (the creative purpose it serves). The order is part of the request
// identity and of the producing service's `<Picture N>` / `<Video N>` /
// `<Audio N>` position, so reordering or swapping one entry changes the request
// hash instead of silently reusing a previous result.
//
// This contract deliberately imposes NO numeric reference-count limit: the
// legal counts differ per model, task partition and service implementation
// (MiniMax-H3 Ref2VA accepts at most 9 images + 3 videos + 3 audios, mixed <=
// 12; other models differ). A count bound therefore belongs in the model
// profile and/or the provider adapter where the model and protocol are known —
// never in the general contract, where it would wrongly reject a request that is
// legal for another model. See `backends/providers/models/minimax-h3.ts`.
export const ReferenceCategorySchema = z.enum(['image', 'video', 'audio']);
export type ReferenceCategory = z.infer<typeof ReferenceCategorySchema>;
/**
 * The creative purpose of a reference. Frame roles (`first-frame`/`last-frame`)
 * mark a strict frame constraint and `mask` an inpainting region; the rest are
 * conditioning roles. A role is not a wire position: a reference image with role
 * `identity` is a REFERENCE and is never silently treated as a strict first
 * frame.
 */
export const ReferenceRoleSchema = z.enum([
  'identity',
  'material',
  'environment',
  'camera',
  'motion',
  'style',
  'composition',
  'audio',
  'first-frame',
  'last-frame',
  'mask',
]);
export type ReferenceRole = z.infer<typeof ReferenceRoleSchema>;
export const ReferenceSchema = z
  .object({ asset: Id, category: ReferenceCategorySchema, role: ReferenceRoleSchema })
  .strict();
export type Reference = z.infer<typeof ReferenceSchema>;
/**
 * How the producing service must interpret the reference set:
 *  - `text`             — no references; text-to-video (FL2VA with zero images).
 *  - `first-last-frame` — a strict first frame and optional last frame (FL2VA).
 *  - `reference`        — ordered multi-modal conditioning (Ref2VA), where an
 *                         image reference is NEVER silently a first frame.
 * The mode is explicit so the semantics are stated, not inferred from a bare
 * image field.
 */
export const VideoGenerationModeSchema = z.enum(['text', 'first-last-frame', 'reference']);
export type VideoGenerationMode = z.infer<typeof VideoGenerationModeSchema>;
// Authored provider request (kind `provider`). Endpoint is a non-secret binding,
// never a URL or GPU deployment. Specific model constraints are owned by the
// model profile; the cross-field reference rules live in the union refinement
// below.
//
// `output` is the Take medium, declared explicitly by the author like the
// `browser`/`blender` Sources. A `provider` Take is picture-only in the current
// contract — there is no provider audio capability — so the only legal value is
// `'picture'` and it is REQUIRED (no default): a missing, wrong or unknown
// `output` is rejected loudly rather than silently fixed to a medium the author
// did not write. This is deliberately NOT tidied together with the `simulated`
// test-double Source (below), which has NO `output` field at all.
//
// FOUR distinct lengths/canvases this Source keeps separate:
//  - `size` is the author's real raster CANVAS, `WIDTH:HEIGHT` in pixels — never
//    a symbolic ratio such as `16:9` fabricated into 16x9 pixels. A model's own
//    `ratio`/`resolution` parameter is a model-side selector (checked against
//    this canvas by aspect, or by equality when the ratio string IS a
//    resolution); it belongs to the model definition, not to this Source.
//  - `requestedFrames` + `fps` express the EXPECTED take length the author wants
//    the shot filled with.
//  - a model's `durationSeconds` (when it takes one) is the generation-REQUEST
//    length sent to the service; it may carry extra margin and must not be
//    shorter than the expected take.
//  - the DECODED Take's real frames/duration are authoritative and are recorded
//    from the probed provider media, not assumed from the request.
// The final Composition output canvas is `composition.output`, independent of
// the generation canvas above.
export const ProviderSourceSchema = z
  .object({
    id: Id,
    kind: z.literal('provider'),
    output: z.literal('picture'),
    endpoint: Id,
    model: z.string().trim().min(1).max(256),
    prompt: z.string().min(1).max(20000),
    mode: VideoGenerationModeSchema,
    references: z.array(ReferenceSchema).default([]),
    requestedFrames: positive,
    size: z.string().regex(/^[1-9]\d{0,4}:[1-9]\d{0,4}$/),
    fps: z.number().finite().positive().max(120).default(24),
    steps: positive.optional(),
    seed: integer.optional(),
    flowShift: z.number().finite().positive().optional(),
    attempt: Id,
    parameters: z.record(z.unknown()).optional(),
  })
  .strict();
// ---------------------------------------------------------------------------
// Browser-executed author Source (kind `browser`)
// ---------------------------------------------------------------------------
// A browser Source is authored code run in the shared headless Chrome capture
// chain. `output` is the Take medium and the ONLY discriminator of the legal
// field set: a `picture` Take renders frames, a `sound` Take renders one pure
// audio buffer. `world` (a World binding) and `recording` (replay one recorded
// real play session) are the two optional driving sources and are PICTURE only;
// a `sound` Take may carry neither. The two legal shapes are separate strict
// objects, so an illegal combination is rejected loudly rather than hidden
// behind one loose superset. (zod v3 cannot nest a discriminatedUnion, so the
// per-output split is a plain union of strict objects; the cross-output rules
// that a single object cannot express live in `superRefine`.)
const BrowserPictureSourceSchema = z
  .object({
    id: Id,
    kind: z.literal('browser'),
    output: z.literal('picture'),
    entry: RelativePath,
    resources: z.array(RelativePath).default([]),
    bindings: z.array(Id).default([]),
    bindingOverrides: BindingOverridesSchema.optional(),
    params: z.record(z.unknown()).default({}),
    seed: integer.default(0),
    frames: positive,
    // Optional World binding: `define` hands over only the definition; `drive`
    // steps the World per frame (WorldRefSchema requires its `startFrame`).
    world: WorldRefSchema.optional(),
    // Replay one recorded real play session to produce the picture Take.
    recording: RelativePath.optional(),
  })
  .strict()
  .superRefine((source, context) => {
    // Per-frame World stepping interleaved with recorded-input replay is not
    // implemented: refuse the combination loudly rather than silently override
    // the player's own state. Replay over a World DEFINITION is supported.
    if (source.recording && source.world?.mode === 'drive')
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['world'],
        message:
          "A `recording` replay cannot be combined with a World binding in mode 'drive' (per-frame World stepping + input replay is not implemented); use mode 'define'",
      });
  });
// A code-authored sound Take: the entry is an HTML/JS page that renders a
// deterministic audio buffer (e.g. an OfflineAudioContext graph) to exactly the
// authored SAMPLE length. Sound runs on a sample clock, never on a picture frame
// clock: `durationSamples` is the native length and `sampleRate` the native rate
// the page renders at. The DELIVERED channel count belongs to the selected sound
// target, so a Source never pretends to own one.
const BrowserSoundSourceSchema = z
  .object({
    id: Id,
    kind: z.literal('browser'),
    output: z.literal('sound'),
    entry: RelativePath,
    resources: z.array(RelativePath).default([]),
    bindings: z.array(Id).default([]),
    bindingOverrides: BindingOverridesSchema.optional(),
    params: z.record(z.unknown()).default({}),
    seed: integer.default(0),
    durationSamples: positive,
    sampleRate: SampleRateSchema,
  })
  .strict();
// A standalone image generation/-editing request. It is deliberately NOT
// a Source: it never appears on the timeline, produces no Take and needs neither
// a video Placement nor a Build. It is the input of the Runtime operation
// `generate-image`, which submits it and registers the returned image as an
// author-area Asset (see `operations/assets/generate-image.ts`).
//
//  - `id` is a stable request id; together with `attempt` it keys the frozen
//    request record, the per-attempt lock and the retained provider original, so
//    re-running the SAME request recovers instead of resubmitting;
//  - `asset` is the target Asset id the returned image is registered under (at a
//    legal author path, never under `.viscraft/`); `rights` is the author's
//    rights record for that image;
//  - `endpoint` is a non-secret binding to `providers.imageApi`, never a URL or
//    a locality claim: the project does NOT know whether the image model is
//    locally deployed or a remote API, because a local deployment can always be
//    exposed as an API;
//  - `references` is an ordered list of image Assets (existence, category and
//    bytes hash are checked by the operation's preflight); a mask is a reference
//    with role `mask`. The cross-field rules (images only, edit needs a non-mask
//    source, generate forbids a mask, at most one mask) are enforced here.
//
// No numeric reference-count limit is imposed: the vllm-omni-image protocol has no
// verified fixed count, so a specific image model's count belongs in its own
// profile/service, not in this contract.
export const GenerateImageRequestSchema = z
  .object({
    id: Id,
    attempt: positive,
    asset: Id,
    rights: RightsSchema,
    operation: z.enum(['generate', 'edit']),
    endpoint: Id,
    model: z.string().min(1).max(200),
    prompt: z.string().min(1).max(20000),
    references: z.array(ReferenceSchema).default([]),
    size: ImageSizeSchema.optional(),
    seed: integer.optional(),
    parameters: z.record(z.unknown()).optional(),
  })
  .strict()
  .superRefine((request, context) => {
    // image generation and image editing are two distinct operations. The
    // vllm-omni-image protocol only transmits image parts, so every reference is an
    // image; a `mask` reference marks an inpainting region. `edit` needs a
    // non-mask source image; `generate` must not smuggle a mask in.
    const references = request.references;
    if (references.some(reference => reference.category !== 'image'))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'An image request may only reference image Assets',
      });
    if (request.operation === 'edit' && !references.some(reference => reference.role !== 'mask'))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'An image edit requires at least one non-mask reference image',
      });
    if (request.operation === 'generate' && references.some(reference => reference.role === 'mask'))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'An image generation must not declare a mask reference',
      });
    if (references.filter(reference => reference.role === 'mask').length > 1)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'An image request supports at most one mask reference',
      });
  });
export type GenerateImageRequest = z.infer<typeof GenerateImageRequestSchema>;
/** The caller-facing input (defaults such as `references: []` may be omitted). */
export type GenerateImageRequestInput = z.input<typeof GenerateImageRequestSchema>;
// Blender-authored picture: a Python author script executed headlessly by a
// Blender runtime (see `backends/blender/render.ts`). The runtime freezes
// `entry` + `resources` (the author dependency closure) into the Build snapshot,
// so a copied or moved Project can re-render from the same author state — it is
// NOT reduced to importing a flat video. The executor invokes
//
//   blender -b --python <entry> -- --out <dir> --width W --height H --fps N --frames F [--world <json>] <args...>
//
// (or the `bpy` Python module when no `blender` binary exists — same reserved
// arguments), and the script MUST write exactly `frames` PNG frames named
// `frame-%06d.png` (0..F-1) into `<dir>` — the same frame-sequence contract the
// browser backend uses — and SHOULD print one `VISCRAFT_REPORT <json>` line.
// `args` carries the author's own ordered CLI arguments (camera/shot selection,
// a frame window, device, samples); the runtime freezes them verbatim and NEVER
// reinterprets them, so the author script owns its own arg contract. Output
// width/height/fps come from `composition.output`, like every other Source.
//
// A `blender` Source is a genuine World CONSUMER, not a standalone script
// runner: `world` binds it to one Project World + camera, and the runtime
// samples that SAME shared World (via `sampleWorld`, the one world truth the
// browser backend also uses) into a per-frame sidecar the executor hands to the
// script as `--world <json>` (World binding mode `drive`; Blender supports no
// other mode). `bindings`/`bindingOverrides` bind named Project Assets (e.g. a
// `model` GLB) the same way the browser Source does; the sidecar also maps every
// referenced entity Asset to its frozen snapshot path. A Blender Source uses a
// Python author script as its entry and declares its other authored files as
// resources; a `.blend` file alone is not an executable Source entry.
const BlenderSourceSchema = z
  .object({
    id: Id,
    kind: z.literal('blender'),
    output: z.literal('picture'),
    entry: RelativePath.refine(
      entry => entry.toLowerCase().endsWith('.py'),
      'A blender Source entry must be a Python author script (.py); a .blend-only entry is not implemented',
    ),
    resources: z.array(RelativePath).default([]),
    args: z.array(z.string().max(1000)).max(64).default([]),
    frames: positive,
    bindings: z.array(Id).default([]),
    bindingOverrides: BindingOverridesSchema.optional(),
    // Blender is currently a `drive`-only World consumer (its renderer samples
    // the shared World per frame into the `--world` sidecar); the mode support is
    // validated in `validateProject`/the executor module.
    world: WorldRefSchema.optional(),
  })
  .strict();
// The `simulated` test-double provider: a deterministic, credential-free Take
// producer used only for real production/failure-recovery testing. It is an
// explicitly selected Source kind (never inferred), keeps its four scenarios and
// its `simulated` marking through Take/Artifact/Result/Asset. It deliberately
// does NOT carry an `output` field and must not gain one for type tidiness: the
// THREE author executors (`browser`, `blender`, `provider`) each declare their
// medium explicitly, but `simulated` is not an author executor and its medium is
// fixed (a picture Take).
const SimulatedSourceSchema = z
  .object({
    id: Id,
    kind: z.literal('simulated'),
    prompt: z.string().min(1),
    frames: positive,
    seed: integer.default(0),
    attempt: Id,
    behavior: z.enum(['success', 'fail', 'submit-unknown', 'download-fail-once']).default('success'),
  })
  .strict();
export const SourceSchema = z
  .union([
    BrowserPictureSourceSchema,
    BrowserSoundSourceSchema,
    BlenderSourceSchema,
    ProviderSourceSchema,
    SimulatedSourceSchema,
  ])
  .superRefine((source, context) => {
    // The mode and the ordered reference list must agree. A reference image is a
    // reference unless the author explicitly declares `first-last-frame`; the
    // refinement never equates the two.
    if (source.kind === 'provider') {
      const references = source.references ?? [];
      if (source.mode === 'text') {
        if (references.length > 0)
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'A text-mode provider Source must not declare references',
          });
        return;
      }
      if (source.mode === 'first-last-frame') {
        if (references.length < 1 || references.length > 2)
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              'A first-last-frame provider Source requires exactly one (first) or two (first+last) image references',
          });
        if (
          references.some(
            reference =>
              reference.category !== 'image' || (reference.role !== 'first-frame' && reference.role !== 'last-frame'),
          )
        )
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              'A first-last-frame provider Source may only carry image references with role "first-frame" or "last-frame"',
          });
        if (references.length === 2 && new Set(references.map(reference => reference.role)).size !== 2)
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'A two-reference first-last-frame Source needs one "first-frame" and one "last-frame" reference',
          });
        return;
      }
      if (references.length === 0)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'A reference-mode provider Source requires at least one reference',
        });
      return;
    }
  });
export type Source = z.infer<typeof SourceSchema>;
// The browser kind (one `kind`, two `output`s, two legal field sets).
export type BrowserSource = Extract<Source, { kind: 'browser' }>;
export type BrowserPictureSource = Extract<Source, { kind: 'browser'; output: 'picture' }>;
export type BrowserSoundSource = Extract<Source, { kind: 'browser'; output: 'sound' }>;
export const PlayableInputSchema = z
  .object({
    frame: integer,
    type: z.enum(['down', 'up']),
    key: z.enum(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'r']),
  })
  .strict();
export type PlayableInput = z.infer<typeof PlayableInputSchema>;
export type SimulatedSource = Extract<Source, { kind: 'simulated' }>;
export type ProviderSource = Extract<Source, { kind: 'provider' }>;
export type BlenderSource = Extract<Source, { kind: 'blender' }>;
/** True when exactly one picture origin (`source` | `take` | `asset`) is set. */
function exactlyOneOrigin(reference: { source?: string; take?: string; asset?: string }): boolean {
  return [reference.source, reference.take, reference.asset].filter(item => item !== undefined).length === 1;
}
/**
 * A placed picture interval on the composition timeline. Its picture comes from
 * EXACTLY ONE of three origins (never none, never two):
 *  - `source` — a fresh Take is produced from the named authored Source;
 *  - `take`   — a previously recorded Take is selected directly;
 *  - `asset`  — a registered Project Asset is referenced DIRECTLY: a
 *    VIDEO asset is normalized to the output grid/fps through `normalizeMedia`
 *    (duration and the source PTS→output mapping are preserved, playback speed
 *    is never changed) and `[inFrame, outFrame)` selects frames on that
 *    normalized grid; an IMAGE asset has no intrinsic clock, so `durationFrames`
 *    is REQUIRED and declares the whole stay on the output grid (`inFrame` 0,
 *    `outFrame === durationFrames`) and `audio` must be `mute`.
 * `framing` is only meaningful with an `asset` reference: it is the
 * contain/cover/background/position rule the still/video is fitted with
 * (default contain on black).
 */
export const PlacementSchema = z
  .object({
    id: Id,
    shot: Id,
    source: Id.optional(),
    take: Id.optional(),
    asset: Id.optional(),
    framing: MediaFramingSchema.optional(),
    inFrame: integer,
    outFrame: positive,
    startFrame: integer,
    audio: z.enum(['mute', 'keep']),
    durationFrames: positive.optional(),
    audioGain: z.number().finite().min(0).max(2).optional(),
    audioFadeInSamples: integer.optional(),
    audioFadeOutSamples: integer.optional(),
    audioOffsetSamples: signedInteger.optional(),
    audioTailSamples: signedInteger.optional(),
    audioLeadSamples: integer.optional(),
    bus: Id.optional(),
  })
  .strict()
  .refine(
    p => p.outFrame > p.inFrame && exactlyOneOrigin(p),
    'Placement requires exactly one of source, take or asset and a nonempty interval',
  )
  .superRefine((p, context) => {
    // `audioGain`/`audioFade*`/`audioOffsetSamples`/`audioTailSamples`/`audioLeadSamples`
    // shape the kept provider audio (defaults 1/0/0/0/0/0); a placement that mutes
    // must leave them at their defaults so an accidental value on a muted placement
    // fails loudly.
    if (
      p.audio !== 'keep' &&
      ((p.audioGain ?? 1) !== 1 ||
        (p.audioFadeInSamples ?? 0) !== 0 ||
        (p.audioFadeOutSamples ?? 0) !== 0 ||
        (p.audioOffsetSamples ?? 0) !== 0 ||
        (p.audioTailSamples ?? 0) !== 0 ||
        (p.audioLeadSamples ?? 0) !== 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Placement audioGain/audioFadeInSamples/audioFadeOutSamples/audioOffsetSamples/audioTailSamples/audioLeadSamples are only meaningful when audio is "keep"',
      });
    }
  })
  .refine(p => p.bus === undefined || p.audio === 'keep', 'Placement bus is only meaningful when audio is "keep"');
export type Placement = z.infer<typeof PlacementSchema>;
/**
 * A picture composited over the programme by `overlayPictureLayers`. Its picture
 * comes from EXACTLY ONE of `source` | `take` | `asset` (the same three origins
 * a Placement has; see {@link PlacementSchema}). A layer has no `durationFrames`,
 * so an IMAGE asset layer declares its extent with `[inFrame, outFrame)` and
 * requires `inFrame` 0 (a still has no source clock to select inside).
 */
export const PictureLayerSchema = z
  .object({
    id: Id,
    source: Id.optional(),
    take: Id.optional(),
    asset: Id.optional(),
    framing: MediaFramingSchema.optional(),
    inFrame: integer,
    outFrame: positive,
    startFrame: integer,
    x: integer,
    y: integer,
    width: positive,
    height: positive,
    opacity: z.number().finite().min(0).max(1).default(1),
  })
  .strict()
  .refine(
    layer => layer.outFrame > layer.inFrame && exactlyOneOrigin(layer),
    'Picture layer requires exactly one of source, take or asset and a nonempty interval',
  );
export type PictureLayer = z.infer<typeof PictureLayerSchema>;
// A between-shot transition mixing two ADJACENT placements over an explicit
// overlap `[startFrame, endFrame)`. Every kind shares the same overlap
// arithmetic: the programme is never shortened a second time and the declared
// range must equal the overlap. `dissolve` / `wipe*` / `slide*` / `circle*` /
// `hblur` each map to one real ffmpeg `xfade` transition name. `whipleft` /
// `whipright` are NOT plain xfade aliases: they are a fast directional slide (a
// `slideleft` / `slideright` xfade) whose overlap region is additionally smeared
// by a directional horizontal blur — a *motion smear*, NOT a true
// motion-blurred camera whip-pan (no camera displacement, no shutter model; see
// `backends/media/picture.ts`).
//
// `occlude` is an occlusion transition: an occluder image sweeps
// across the frame so that the frame is FULLY covered exactly at the cut, then
// clears to reveal the incoming shot — the splice happens under the cover. It is
// the only kind that needs extra authored state, so `TransitionSchema` carries an
// OPTIONAL `occluder` (an Asset id) that is required iff `kind === 'occlude'` and
// forbidden otherwise (see the union-level refinement below). Other transition kinds must omit this field.
export const TransitionKindSchema = z.enum([
  'dissolve',
  'wipeleft',
  'wiperight',
  'wipeup',
  'wipedown',
  'slideleft',
  'slideright',
  'slideup',
  'slidedown',
  'circleopen',
  'circleclose',
  'hblur',
  'whipleft',
  'whipright',
  'occlude',
]);
export type TransitionKind = z.infer<typeof TransitionKindSchema>;
export const TransitionSchema = z
  .object({
    from: Id,
    to: Id,
    kind: TransitionKindSchema,
    startFrame: integer,
    endFrame: positive,
    occluder: Id.optional(),
  })
  .strict()
  .superRefine((transition, context) => {
    // `occluder` is meaningful only for an occlusion transition. An `occlude`
    // without an occluder Asset cannot render an occluder, and naming an occluder
    // on any other kind is a silent no-op; both are refused loudly rather than
    // ignored.
    if (transition.kind === 'occlude' && transition.occluder === undefined)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Transition kind "occlude" requires an `occluder` Asset id',
      });
    if (transition.kind !== 'occlude' && transition.occluder !== undefined)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Transition kind "${transition.kind}" must not declare an occluder`,
      });
  });
export type Transition = z.infer<typeof TransitionSchema>;
/**
 * An author's ASSERTION that two placements correspond across a cut (a Match
 * Cut). This is declared *time/metadata*, not a rendered effect: it records the
 * subject/action the author believes match and the two source frames believed to
 * correspond, and it never changes a rendered pixel or a sample. It carries NO
 * similarity score, because this runtime cannot honestly compute subject-identity
 * similarity; `reviewBuild` reports the declaration and the REAL boundary frames
 * as facts only (never a pass/fail or an aesthetic verdict).
 *
 * It is a sibling of `composition.transitions`, not a `Transition` kind, because
 * a Match Cut may be a zero-overlap hard cut and every `Transition` requires a
 * positive overlap. An absent `matchCuts` leaves existing projects and their
 * cache keys byte-identical.
 */
export const MatchCutSchema = z
  .object({
    from: Id,
    to: Id,
    subject: z.string().trim().min(1).max(200),
    action: z.string().trim().min(1).max(200),
    fromFrame: integer,
    toFrame: integer,
  })
  .strict();
export type MatchCut = z.infer<typeof MatchCutSchema>;
/**
 * Whole-programme fade finishing on the OUTPUT timeline, distinct from a
 * between-shots dissolve: frames `[0, inFrames)` ramp luminance 0->1 and
 * `[totalFrames-outFrames, totalFrames)` ramp 1->0, with the mixed audio
 * following the same linear envelope. Absent or all-zero leaves the programme
 * unchanged.
 */
export const FadeSchema = z.object({ inFrames: integer.default(0), outFrames: integer.default(0) }).strict();
export type Fade = z.infer<typeof FadeSchema>;
/**
 * Bus-keyed automatic sidechain ducking: while the declared `control` bus is
 * loud, members of the `target` bus are attenuated along a deterministic
 * envelope-following gain curve. `thresholdDb` (default -30) is the detector
 * threshold, `ratio` (default 4) the reduction slope, `maxAttenuationDb`
 * (default -18) the gain floor, and `attackSamples`/`releaseSamples` the
 * one-pole attack/release constants (defaults 5 ms / 200 ms at the output
 * sample rate). This is NOT dialogue detection, a full compressor, a lookahead
 * limiter or a broadcast-standard sidechain; it is an envelope-following rule
 * with a gain floor. Absent or empty applies no sidechain reduction.
 */
export const DuckingSchema = z
  .object({
    target: Id,
    control: Id,
    thresholdDb: z.number().finite().max(0).optional(),
    ratio: z.number().finite().min(1).max(20).optional(),
    maxAttenuationDb: z.number().finite().min(-60).max(-0.1).optional(),
    attackSamples: positive.optional(),
    releaseSamples: positive.optional(),
  })
  .strict();
export type Ducking = z.infer<typeof DuckingSchema>;
/**
 * A declared beat / audio onset on the composition sample clock. This is *time
 * authority*, not content: it lets a Project state the musical/onset grid so a
 * Build, review or edit can validate where picture cuts and actions sit without
 * the grid itself ever changing a rendered pixel or sample. `sample` is a
 * nonnegative integer inside the programme's half-open sample span
 * `[0, totalSamples)`.
 */
export const BeatSchema = z.object({ id: Id, sample: integer }).strict();
export type Beat = z.infer<typeof BeatSchema>;
export const GainAutomationSchema = z
  .array(z.object({ sample: integer, gain: z.number().finite().min(0).max(2) }).strict())
  .min(1);
/**
 * Authored stereo placement over the clip's local sample interval. `pan` is a
 * constant-power position where -1 is hard left, 0 centre and +1 hard right;
 * samples must strictly increase inside [0, durationSamples). This is amplitude
 * panning only (no HRTF, room or Doppler) and is rejected on mono output.
 */
export const PanAutomationSchema = z
  .array(z.object({ sample: integer, pan: z.number().finite().min(-1).max(1) }).strict())
  .min(1);
// A clip may carry a `bus` label to route it into a named programme stem; a
// placement routes its kept native audio the same way. `bus` undefined means
// the clip/kept audio belongs to the programme mix only.
const AudioClipSchema = z.discriminatedUnion('kind', [
  z
    .object({
      id: Id,
      kind: z.literal('asset'),
      asset: Id,
      inSample: integer,
      startSample: integer,
      durationSamples: positive,
      gain: z.number().min(0).max(2),
      fadeInSamples: integer.default(0),
      fadeOutSamples: integer.default(0),
      automation: GainAutomationSchema.optional(),
      pan: z.number().finite().min(-1).max(1).optional(),
      panAutomation: PanAutomationSchema.optional(),
      bus: Id.optional(),
    })
    .strict(),
  // Places a rendered code-authored sound Source. Length is the rendered Take's
  // own length; the clip has no `inSample`/`durationSamples` because the source
  // defines its extent on the composition clock. (The kind is `source`, distinct
  // from a registered audio Asset clip `asset`; validation requires the
  // referenced Source to be a current `output: 'sound'` Source.)
  z
    .object({
      id: Id,
      kind: z.literal('source'),
      source: Id,
      startSample: integer,
      gain: z.number().min(0).max(2),
      fadeInSamples: integer.default(0),
      fadeOutSamples: integer.default(0),
      automation: GainAutomationSchema.optional(),
      pan: z.number().finite().min(-1).max(1).optional(),
      panAutomation: PanAutomationSchema.optional(),
      bus: Id.optional(),
    })
    .strict(),
]);
export type AudioClip = z.infer<typeof AudioClipSchema>;
export const AudioMasteringSchema = z
  .object({ targetLufs: z.number().finite().min(-70).max(-5), truePeakDbfs: z.number().finite().min(-9).max(0) })
  .strict();
export type AudioMastering = z.infer<typeof AudioMasteringSchema>;
export const AudioMasteringReportSchema = z
  .object({
    method: z.literal('two-pass-loudnorm'),
    settings: AudioMasteringSchema,
    normalizationType: z.enum(['linear', 'dynamic']),
    dualMono: z.literal(false),
    loudnessRangeTarget: z.literal(50),
    input: z
      .object({
        integratedLufs: z.number().finite(),
        truePeakDbfs: z.number().finite(),
        loudnessRange: z.number().finite(),
        thresholdLufs: z.number().finite(),
        targetOffset: z.number().finite(),
      })
      .strict(),
    output: z
      .object({
        integratedLufs: z.number().finite(),
        truePeakDbfs: z.number().finite(),
        sampleRate: positive,
        channels: positive,
        samples: positive,
      })
      .strict(),
  })
  .strict();
export type AudioMasteringReport = z.infer<typeof AudioMasteringReportSchema>;
export const SubtitleSchema = z
  .object({
    id: Id,
    text: z
      .string()
      .min(1)
      .max(2000)
      .refine(text => !text.includes('\0'), 'Subtitle text must not contain NUL')
      .refine(
        text => !/^\n|\n\n|\n$/.test(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')),
        'Subtitle text must not contain blank lines',
      ),
    startFrame: integer,
    endFrame: positive,
    fontSize: integer.max(512).refine(size => size > 0, 'Font size must be positive'),
    color: z.string().regex(/^#[a-fA-F0-9]{6}$/),
    x: integer.optional(),
    y: integer.optional(),
  })
  .strict()
  .refine(subtitle => subtitle.endFrame > subtitle.startFrame, 'Subtitle interval must be nonempty and half-open');
export type Subtitle = z.infer<typeof SubtitleSchema>;
/**
 * The composition's edit and timing state. `outputFrames` (optional) states an
 * explicit programme length: the programme is then exactly that many frames,
 * padding a black/silent tail, and it must not be shorter than the content end
 * (silently truncating content is refused). `beats` (optional) declares the
 * beat/onset grid as time authority (see `BeatSchema`). Without `outputFrames`,
 * programme length is derived from the content; an absent grid adds no beat constraints.
 */
export const CompositionSchema = z
  .object({
    output: OutputSchema,
    scenes: z.array(z.object({ id: Id, description: z.string() }).strict()),
    shots: z.array(z.object({ id: Id, scene: Id, look: Id, intent: z.string(), targetFrames: positive }).strict()),
    placements: z.array(PlacementSchema).default([]),
    transitions: z.array(TransitionSchema).default([]),
    matchCuts: z.array(MatchCutSchema).optional(),
    audio: z.array(AudioClipSchema).default([]),
    subtitles: z.array(SubtitleSchema).optional(),
    layers: z.array(PictureLayerSchema).optional(),
    mastering: AudioMasteringSchema.optional(),
    fade: FadeSchema.optional(),
    ducking: z.array(DuckingSchema).optional(),
    beats: z.array(BeatSchema).optional(),
    outputFrames: positive.optional(),
  })
  .strict()
  .superRefine((composition, context) => {
    for (const entry of composition.ducking ?? []) {
      if (entry.target === entry.control)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Ducking target and control must differ (both are "${entry.target}"); a bus cannot duck itself`,
        });
    }
    // A `matchCut` is an authored assertion about two placements. It is validated
    // only when present (absent => byte-identical behaviour): it must name two
    // distinct placements that exist in this composition and be unique per
    // directed pair. It is never a rendered effect, so no adjacency/overlap rule
    // is imposed — a zero-overlap hard cut is the canonical Match Cut.
    const placementIds = new Set(composition.placements.map(placement => placement.id));
    const matchCutPairs = new Set<string>();
    for (const matchCut of composition.matchCuts ?? []) {
      const pair = `${matchCut.from}\u0000${matchCut.to}`;
      if (matchCut.from === matchCut.to)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Match cut needs two distinct placements (both are "${matchCut.from}")`,
        });
      else if (!placementIds.has(matchCut.from) || !placementIds.has(matchCut.to))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Match cut ${matchCut.from}->${matchCut.to} references an unknown placement`,
        });
      else if (matchCutPairs.has(pair))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate match-cut declarations for ${matchCut.from}->${matchCut.to}`,
        });
      matchCutPairs.add(pair);
    }
    const ends = composition.placements.map(
      placement => placement.startFrame + (placement.durationFrames ?? placement.outFrame - placement.inFrame),
    );
    if (ends.some(end => !Number.isSafeInteger(end))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Timeline exceeds safe integer range' });
      return;
    }
    // Zero placements is a legal unedited draft: its content end is a finite 0,
    // never `Math.max()` over an empty list. A declared `outputFrames` may still
    // pad that to a positive explicit programme length.
    const contentFrames = ends.length > 0 ? Math.max(...ends) : 0;
    if (composition.outputFrames !== undefined && composition.outputFrames < contentFrames) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `composition.outputFrames (${composition.outputFrames}) is shorter than the content end (${contentFrames}); shorten placements instead of truncating content`,
      });
    }
    const beats = composition.beats ?? [];
    const totalFrames = composition.outputFrames ?? contentFrames;
    const totalSamples = framesToSamples(totalFrames, composition.output.fps, composition.output.sampleRate, 'ceil');
    const ids = new Set<string>();
    for (let index = 0; index < beats.length; index++) {
      const beat = beats[index];
      if (ids.has(beat.id))
        context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate beat identity ${beat.id}` });
      ids.add(beat.id);
      if (index > 0 && beat.sample <= beats[index - 1].sample)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Beat samples must strictly increase (${beats[index - 1].id}@${beats[index - 1].sample} then ${beat.id}@${beat.sample})`,
        });
      if (beat.sample >= totalSamples)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Beat ${beat.id} sample ${beat.sample} is outside the programme sample span [0, ${totalSamples})`,
        });
    }
  });
export type Composition = z.infer<typeof CompositionSchema>;
export const HandoffRoleSchema = z.enum(['readme', 'notes', 'attribution', 'license', 'helper']);
export const HandoffFileSchema = z.object({ path: RelativePath, role: HandoffRoleSchema }).strict();
export type HandoffFile = z.infer<typeof HandoffFileSchema>;

/**
 * An editable still-image author source: one HTML document (with its real text,
 * layers and references) plus the files it actually consumes. The document is
 * author content, not a second project manifest: the DOM/CSS is NOT copied into
 * JSON. `revision` is the structural revision; the content identity is the
 * hash of the document + its declared resources, computed when it is read.
 */
export const ImageDocumentSchema = z
  .object({
    id: Id,
    path: RelativePath,
    resources: z.array(RelativePath).default([]),
    revision: positive,
  })
  .strict();
export type ImageDocument = z.infer<typeof ImageDocumentSchema>;

/**
 * One still-image target over an image document: the logical canvas the layout
 * is authored for, and the output density/format. Changing the logical canvas
 * is a layout change; changing `scale` only raises output pixels.
 */
export const ImageTargetSchema = z
  .object({
    id: Id,
    document: Id,
    width: positive,
    height: positive,
    scale: z.number().positive().default(1),
    format: z.enum(['png', 'jpeg', 'webp']).default('png'),
    background: z.enum(['transparent', 'opaque']).default('opaque'),
  })
  .strict()
  .superRefine((target, context) => {
    if (target.format === 'jpeg' && target.background === 'transparent')
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['background'],
        message: 'JPEG has no alpha channel; use PNG/WebP for a transparent background',
      });
  });
export type ImageTarget = z.infer<typeof ImageTargetSchema>;

/**
 * A standalone sound deliverable. Like an image target it is a REAL output
 * identity, not a fake composition: it states its own sample clock (rate,
 * channel count, exact sample span) and the clips placed on that clock. A Project
 * may declare film, images and sounds at the same time; each target produces its
 * own result and never overwrites another medium's active result.
 *
 * `outputSamples` is authoritative: the mixer's programme bus is exactly this
 * length, and every clip's `startSample` is measured on THIS clock, not on a
 * picture frame grid.
 */
export const SoundTargetSchema = z
  .object({
    id: Id,
    sampleRate: SampleRateSchema,
    channels: ChannelsSchema,
    outputSamples: positive,
    audio: z.array(AudioClipSchema).default([]),
    ducking: z.array(DuckingSchema).optional(),
    mastering: AudioMasteringSchema.optional(),
    beats: z.array(BeatSchema).optional(),
  })
  .strict()
  .superRefine((target, context) => {
    const ids = new Set<string>();
    for (const clip of target.audio) {
      if (ids.has(clip.id))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['audio'],
          message: `Duplicate audio clip "${clip.id}" in sound target "${target.id}"`,
        });
      ids.add(clip.id);
      if (clip.startSample >= target.outputSamples)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['audio'],
          message: `Audio clip "${clip.id}" starts at ${clip.startSample}, outside the ${target.outputSamples}-sample target span`,
        });
      if (clip.panAutomation && target.channels === 1)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['audio'],
          message: `Audio clip "${clip.id}" uses stereo pan automation, but sound target "${target.id}" is mono`,
        });
      if (clip.kind === 'asset' && clip.fadeInSamples + clip.fadeOutSamples > clip.durationSamples)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['audio'],
          message: `Audio clip "${clip.id}" fades (${clip.fadeInSamples}+${clip.fadeOutSamples}) exceed its ${clip.durationSamples}-sample length`,
        });
    }
    for (const beat of target.beats ?? [])
      if (beat.sample >= target.outputSamples)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['beats'],
          message: `Beat "${beat.id}" is at sample ${beat.sample}, outside the ${target.outputSamples}-sample target span`,
        });
    for (const entry of target.ducking ?? [])
      if (entry.target === entry.control)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ducking'],
          message: `Ducking target and control must differ (both are "${entry.target}")`,
        });
  });
export type SoundTarget = z.infer<typeof SoundTargetSchema>;

export const ProjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: Id,
    revision: positive,
    title: z.string().min(1),
    direction: z
      .object({
        intent: z.string(),
        looks: z
          .array(z.object({ id: Id, description: z.string(), grade: LookGradeSchema.optional() }).strict())
          .min(1),
        transitions: z.array(z.object({ from: Id, to: Id, intent: z.string() }).strict()).default([]),
      })
      .strict(),
    assets: z.array(AssetSchema).default([]),
    bindings: z.record(Id).default({}),
    sources: z.array(SourceSchema),
    worlds: z.array(WorldSchema).optional(),
    /** The real timeline. Absent for an image-only Project, which must not
     * fabricate a Scene/Shot/audio clip/duration/fps just to hold a picture. */
    composition: CompositionSchema.optional(),
    /** Editable still-image sources and the targets produced from them. */
    imageDocuments: z.array(ImageDocumentSchema).default([]),
    imageTargets: z.array(ImageTargetSchema).default([]),
    /** Standalone sound deliverables on their own sample clock. */
    soundTargets: z.array(SoundTargetSchema).default([]),
    /** handoff files a receiver needs (README/NOTES/attribution/licence/helper).
     * Not production inputs: never frozen into a Build and never invalidating one. */
    handoff: z.array(HandoffFileSchema).optional(),
  })
  .strict()
  .superRefine((project, context) => {
    // A draft may legitimately declare nothing to produce yet (a new Project can
    // be authored before its first target exists); each PRODUCER refuses
    // explicitly instead of the schema pretending an empty draft is invalid.
    const documents = new Set<string>();
    for (const document of project.imageDocuments) {
      if (documents.has(document.id))
        context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate image document "${document.id}"` });
      documents.add(document.id);
    }
    // Image and sound targets share ONE id namespace: `build --target <id>` and
    // `build.target` must be unambiguous without knowing the medium first.
    const targets = new Set<string>();
    for (const target of project.imageTargets) {
      if (targets.has(target.id))
        context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate target "${target.id}"` });
      targets.add(target.id);
      if (!documents.has(target.document))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Image target ${target.id} references unknown image document "${target.document}"`,
        });
    }
    for (const target of project.soundTargets)
      if (targets.has(target.id)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate target "${target.id}"` });
      } else targets.add(target.id);
  });
export type Project = z.infer<typeof ProjectSchema>;

/** The timeline, or a clear refusal for operations that only make sense with one. */
export function requireComposition(project: Project): Composition {
  if (!project.composition) throw new Error('this Project has no timeline composition; this operation requires one');
  return project.composition;
}

/** A Project proven to carry a timeline. Film-only operations take this type so
 * a Project without a timeline is refused once, at the boundary, instead of guarded
 * at every access. */
export type FilmProject = Project & { composition: Composition };
export function requireFilmProject(project: Project): FilmProject {
  requireComposition(project);
  return project as FilmProject;
}

export const MediaInfoSchema = z
  .object({
    frames: integer,
    fps: FpsSchema,
    width: positive,
    height: positive,
    duration: z.number().nonnegative(),
    videoCodec: z.string(),
    audio: z
      .object({ sampleRate: positive, channels: positive, duration: z.number().nonnegative() })
      .strict()
      .optional(),
  })
  .strict();
export type MediaInfo = z.infer<typeof MediaInfoSchema>;
export const PlayableRecordingSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: Id,
    source: z
      .object({
        id: Id,
        key: z.string().regex(/^[a-f0-9]{64}$/),
        entry: RelativePath,
        resources: z.array(RelativePath),
        bindings: z.array(Id),
        bindingOverrides: BindingOverridesSchema.optional(),
        params: z.record(z.unknown()),
        seed: integer,
        world: WorldSchema.optional(),
        files: z.array(z.object({ path: RelativePath, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
      })
      .strict(),
    output: OutputSchema,
    frames: integer.min(1),
    events: z.array(PlayableInputSchema),
    states: z.array(z.object({ frame: integer, state: z.unknown() }).strict()).min(1),
    media: z.object({ path: RelativePath, sha256: z.string().regex(/^[a-f0-9]{64}$/), info: MediaInfoSchema }).strict(),
    simulated: z.boolean(),
  })
  .strict()
  .superRefine((recording, context) => {
    if (recording.states.length !== recording.frames || recording.states.some((state, index) => state.frame !== index))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Recording must contain one observed state per captured frame',
      });
    for (let index = 0; index < recording.events.length; index++) {
      const event = recording.events[index];
      if (event.frame >= recording.frames || (index > 0 && event.frame < recording.events[index - 1].frame))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Recorded input events must be ordered inside the capture interval',
        });
    }
    if (recording.media.info.frames !== recording.frames)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Recording media and input clock must have equal frame counts',
      });
  });
export type PlayableRecording = z.infer<typeof PlayableRecordingSchema>;
// One transmitted reference in a generation's portable provenance: the Asset
// id, its exact bytes hash, its media category and its creative role, in the
// transmitted ORDER (a `media` fact is recorded only for video/audio inputs).
export const GenerationReferenceSchema = z
  .object({
    asset: Id,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    category: ReferenceCategorySchema,
    role: ReferenceRoleSchema,
    media: MediaInfoSchema.optional(),
  })
  .strict();
export type GenerationReference = z.infer<typeof GenerationReferenceSchema>;
export const GenerationSchema = z
  .object({
    provider: z.enum(['runway', 'video-api', 'fal']),
    protocol: z.string().optional(),
    extensionHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    model: z.string().min(1),
    taskId: z.string().min(1),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    originalSha256: z.string().regex(/^[a-f0-9]{64}$/),
    estimatedCredits: z.number().finite().nonnegative().optional(),
    finalCredits: z.number().finite().nonnegative().optional(),
    inferenceSeconds: z.number().finite().nonnegative().optional(),
    requestedFrames: positive.optional(),
    originalMedia: MediaInfoSchema.optional(),
    references: z.array(GenerationReferenceSchema).default([]),
  })
  .strict();
// Portable provenance for an image-generation/-editing operation. Hashes only:
// the prompt text, mask bytes and any URL are NEVER stored here (or anywhere in
// shareable state). `references` records the transmitted condition images and
// their roles in order; `inputSha256` is the matching ordered hash list. Neither
// carries a numeric count cap: a legal request for any model must always be
// recordable, and the model-specific count is enforced before transmission.
export const ImageGenerationSchema = z
  .object({
    provider: z.string().min(1),
    extensionHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    model: z.string().min(1),
    operation: z.enum(['generate', 'edit']),
    promptHash: z.string().regex(/^[a-f0-9]{64}$/),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    inputSha256: z.array(z.string().regex(/^[a-f0-9]{64}$/)).default([]),
    references: z.array(GenerationReferenceSchema).default([]),
    outputSha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: ImageSizeSchema.optional(),
    seed: integer.optional(),
    simulated: z.boolean(),
  })
  .strict();
export type ImageGeneration = z.infer<typeof ImageGenerationSchema>;
export const ArtifactSchema = z
  .object({
    id: Id,
    path: RelativePath,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    kind: z.enum(['video', 'audio', 'image']),
    simulated: z.boolean(),
    operation: z.string(),
    inputs: z.array(z.string()),
    backend: z.string(),
    media: MediaInfoSchema.optional(),
    /** A still-image result: its real output pixels and the format it was
     * written as. Absent for video/audio artifacts. */
    image: z
      .object({
        width: positive,
        height: positive,
        format: z.enum(['png', 'jpeg', 'webp']),
        background: z.enum(['transparent', 'opaque']),
      })
      .strict()
      .optional(),
    generation: GenerationSchema.optional(),
    imageGeneration: ImageGenerationSchema.optional(),
    mastering: AudioMasteringReportSchema.optional(),
    bus: Id.optional(),
    /** the media bytes were released after a verified archive held them;
     * `restore-media` writes them back. Records and provenance stay. */
    archived: z
      .object({ archive: z.string().regex(/^[a-f0-9]{64}$/), at: z.string() })
      .strict()
      .optional(),
  })
  .strict();
export type Artifact = z.infer<typeof ArtifactSchema>;
// A Take carries ITS OWN clock. A picture Take is measured in frames on a frame
// grid; a sound Take is measured in samples on a sample-rate clock. They are
// never interchangeable and neither is derived from the other's fields.
const TakeBase = {
  id: Id,
  artifact: Id,
  /** The authored Source whose Take this is; absent when the Take comes from a
   * directly referenced Asset (`asset`), which is how a media/image Asset on
   * the timeline is carried. */
  source: Id.optional(),
  /** The directly referenced Asset this Take was normalized from, when any. */
  asset: Id.optional(),
  sourceKey: z.string(),
  simulated: z.boolean(),
};
const takeHasExactlyOneOrigin = (take: { source?: string; asset?: string }): boolean =>
  (take.source !== undefined) !== (take.asset !== undefined);
export const PictureTakeSchema = z
  .object({ ...TakeBase, medium: z.literal('picture'), frames: positive, fps: FpsSchema })
  .strict()
  .refine(takeHasExactlyOneOrigin, 'A Take must name exactly one of source or asset');
export const SoundTakeSchema = z
  .object({
    ...TakeBase,
    medium: z.literal('sound'),
    samples: positive,
    sampleRate: SampleRateSchema,
    channels: ChannelsSchema,
  })
  .strict()
  .refine(takeHasExactlyOneOrigin, 'A Take must name exactly one of source or asset');
export const TakeSchema = z.union([PictureTakeSchema, SoundTakeSchema]);
export type Take = z.infer<typeof TakeSchema>;
export type PictureTake = z.infer<typeof PictureTakeSchema>;
export type SoundTake = z.infer<typeof SoundTakeSchema>;
export const OperationRecordSchema = z
  .object({ id: Id, kind: z.string(), key: z.string(), inputs: z.array(z.string()), artifact: Id, reused: z.boolean() })
  .strict();
export type OperationRecord = z.infer<typeof OperationRecordSchema>;
export const CandidatePlanSchema = z.array(z.object({ shot: Id, sources: z.array(Id).min(1) }).strict());
/**
 * A preview Build: the output-frame range `[start, end)` of the composed
 * programme at `scale`. Placements wholly outside the range (picture and audio)
 * are listed in `substituted`: their Sources were not produced and black, silent
 * stand-ins kept the timeline length. A preview never writes `result.json`; its
 * movie is `artifact`, and `--still` adds a PNG under `.viscraft/previews/`.
 */
export const BuildPreviewSchema = z
  .object({
    frames: z.tuple([integer, positive]).refine(([start, end]) => end > start, 'preview range must be nonempty'),
    scale: z.number().min(0.25).max(1),
    substituted: z.array(Id),
    artifact: Id.optional(),
    still: z
      .object({ frame: integer, path: RelativePath, sha256: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .optional(),
  })
  .strict();
export type BuildPreview = z.infer<typeof BuildPreviewSchema>;

/**
 * A non-blocking browser capture diagnostic recorded by a Build: a technical
 * fact that can degrade picture quality while the capture still succeeded — an
 * upscaled canvas backing buffer, a canvas aspect that disagrees with its
 * display, or a declared web font that is not actually available. It is never a
 * failure and never an aesthetic verdict.
 */
export const CaptureDiagnosticCodeSchema = z.enum(['canvas-upscaled', 'canvas-aspect-mismatch', 'font-fallback']);
export const BuildDiagnosticSchema = z
  .object({
    operation: z.string(),
    code: CaptureDiagnosticCodeSchema,
    message: z.string(),
    detail: z.record(z.union([z.string(), z.number()])),
  })
  .strict();
export type BuildDiagnostic = z.infer<typeof BuildDiagnosticSchema>;

export const BuildRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: Id,
    run: z.object({ id: Id, goal: z.string() }).strict(),
    plan: z.object({ operations: z.array(z.string()), candidates: CandidatePlanSchema.optional() }).strict(),
    revision: positive,
    snapshotHash: z.string(),
    status: z.enum(['running', 'succeeded', 'failed']),
    startedAt: z.string(),
    finishedAt: z.string().optional(),
    stale: z.boolean().optional(),
    error: z.string().optional(),
    environment: z.record(z.string()).optional(),
    operations: z.array(OperationRecordSchema),
    /** Non-blocking capture diagnostics per operation (absent when none). */
    diagnostics: z.array(BuildDiagnosticSchema).optional(),
    artifacts: z.array(ArtifactSchema),
    takes: z.array(TakeSchema),
    /** Which target this Build produces. Absent = the timeline composition; an
     * image-target or sound-target id keeps a still/sound result from overwriting
     * the film result. */
    target: Id.optional(),
    /** The medium this Build actually produced. Required: a result is never
     * ambiguous about whether it is a picture or a sound programme. */
    medium: z.enum(['picture', 'sound']),
    result: z.object({ artifact: Id, simulated: z.boolean() }).strict().optional(),
    preview: BuildPreviewSchema.optional(),
    /** `keep`: the user approved this version; it and its whole production
     * closure stay protected from cleanup. Not an Asset. */
    retained: z
      .object({ at: z.string(), note: z.string().max(500).optional() })
      .strict()
      .optional(),
  })
  .strict();
export type BuildRecord = z.infer<typeof BuildRecordSchema>;

const PtsSchema = z.string().regex(/^-?\d{1,24}$/);
export const ReferenceReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('reference-analysis'),
    source: z
      .object({
        path: RelativePath,
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        simulated: z.boolean(),
        origin: z.enum(['asset', 'artifact', 'material']),
      })
      .strict(),
    fps: FpsSchema,
    media: MediaInfoSchema,
    clock: z
      .object({
        timeBase: FpsSchema,
        originPts: PtsSchema,
        endPts: PtsSchema,
        durationMethod: z.enum(['source-duration', 'frame-rate-fallback']),
        variableFrameRate: z.boolean(),
      })
      .strict(),
    frames: z
      .array(z.object({ index: integer, pts: PtsSchema, outputFrame: integer }).strict())
      .min(1)
      .max(10000),
    cuts: z
      .array(
        z
          .object({ sourceFrame: integer, pts: PtsSchema, outputFrame: integer, score: z.number().min(0).max(1) })
          .strict(),
      )
      .max(10000),
    segments: z
      .array(z.object({ startFrame: integer, endFrame: positive }).strict())
      .min(1)
      .max(10000),
    reviewFrames: z.array(z.object({ sourceFrame: integer, path: RelativePath }).strict()).max(30000),
    threshold: z.number().min(0).max(1),
    reportPath: RelativePath,
    limitations: z.array(z.string()),
  })
  .strict()
  .superRefine((report, context) => {
    let end = 0;
    for (const segment of report.segments) {
      if (segment.startFrame !== end || segment.endFrame <= segment.startFrame)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Reference segments must tile a positive half-open interval from frame zero',
        });
      end = segment.endFrame;
    }
    const validPts =
      PtsSchema.safeParse(report.clock.originPts).success && PtsSchema.safeParse(report.clock.endPts).success;
    const validRates = FpsSchema.safeParse(report.clock.timeBase).success && FpsSchema.safeParse(report.fps).success;
    if (validPts && BigInt(report.clock.endPts) <= BigInt(report.clock.originPts))
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Reference source clock must have positive duration' });
    if (validPts && validRates && BigInt(report.clock.endPts) > BigInt(report.clock.originPts)) {
      try {
        if (ptsToFrames(report.clock.endPts, report.clock.originPts, report.clock.timeBase, report.fps) !== end)
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Reference segments must end at the exact mapped output duration',
          });
        for (const frame of report.frames) {
          if (!PtsSchema.safeParse(frame.pts).success) continue;
          if (
            BigInt(frame.pts) < BigInt(report.clock.originPts) ||
            BigInt(frame.pts) >= BigInt(report.clock.endPts) ||
            ptsToFrames(frame.pts, report.clock.originPts, report.clock.timeBase, report.fps) !== frame.outputFrame
          )
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'Reference frame output positions must use exact source-PTS mapping',
            });
        }
      } catch {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Reference PTS cannot be represented on the output timeline',
        });
      }
    }
    for (let index = 0; index < report.frames.length; index++) {
      const frame = report.frames[index];
      if (frame.index !== index || frame.outputFrame > end)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Reference frame identities and output positions must match the mapped timeline',
        });
    }
    for (const cut of report.cuts) {
      const frame = report.frames[cut.sourceFrame];
      if (
        !frame ||
        frame.pts !== cut.pts ||
        frame.outputFrame !== cut.outputFrame ||
        cut.outputFrame <= 0 ||
        cut.outputFrame >= end
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Cut candidates must reference a real decoded frame inside the output timeline',
        });
    }
    for (const review of report.reviewFrames) {
      if (review.sourceFrame >= report.frames.length)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Review still must refer to a real decoded source frame',
        });
    }
  });
export type ReferenceReport = z.infer<typeof ReferenceReportSchema>;

export const AudioReferenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('audio-reference'),
    source: z
      .object({
        path: RelativePath,
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        origin: z.enum(['asset', 'artifact', 'material']),
        simulated: z.boolean(),
      })
      .strict(),
    fps: FpsSchema,
    sampleRate: z.union([z.literal(44100), z.literal(48000)]),
    samples: positive,
    windowSamples: positive,
    // The configured analysis window (seconds) and the exact span that was
    // analysed, as structured facts — not only prose in `limitations`.
    // `truncatedToWindow` is true when the source carried audio beyond the window.
    windowSeconds: z.number().finite().positive(),
    analysedSpan: z.object({ startSample: integer, endSample: positive, truncatedToWindow: z.boolean() }).strict(),
    energy: z.array(z.object({ sample: integer, rms: z.number().finite().nonnegative() }).strict()),
    onsets: z.array(
      z.object({ sample: integer, outputFrame: integer, strength: z.number().finite().nonnegative() }).strict(),
    ),
    reportPath: RelativePath,
    limitations: z.array(z.string()),
  })
  .strict()
  .superRefine((report, context) => {
    for (const onset of report.onsets)
      if (
        onset.sample >= report.samples ||
        onset.outputFrame !==
          ptsToFrames(String(onset.sample), '0', { numerator: 1, denominator: report.sampleRate }, report.fps)
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Audio onset must reference a real sample and its exact output frame',
        });
    for (let i = 0; i < report.onsets.length; i++)
      if (i > 0 && report.onsets[i].sample <= report.onsets[i - 1].sample)
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Audio onset samples must increase' });
    if (report.analysedSpan.startSample !== 0 || report.analysedSpan.endSample !== report.samples)
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'The analysed span must be exactly [0, samples)' });
  });
export type AudioReference = z.infer<typeof AudioReferenceSchema>;

export const ReferenceTrackOptionsSchema = z
  .object({
    color: z.tuple([integer.max(255), integer.max(255), integer.max(255)]),
    tolerance: z.number().finite().min(0).max(255).default(40),
    minPixels: positive.default(4),
    roi: z.object({ x: integer, y: integer, width: positive, height: positive }).strict().optional(),
    fps: FpsSchema.optional(),
  })
  .strict();
export type ReferenceTrackOptions = z.input<typeof ReferenceTrackOptionsSchema>;
export const ReferenceTrackSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('reference-track'),
    source: z
      .object({
        path: RelativePath,
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        simulated: z.boolean(),
        origin: z.enum(['asset', 'artifact', 'material']),
      })
      .strict(),
    media: MediaInfoSchema,
    fps: FpsSchema,
    clock: z
      .object({
        timeBase: FpsSchema,
        originPts: PtsSchema,
        endPts: PtsSchema,
        durationMethod: z.enum(['source-duration', 'frame-rate-fallback']),
        variableFrameRate: z.boolean(),
      })
      .strict(),
    marker: z
      .object({
        color: z.tuple([integer.max(255), integer.max(255), integer.max(255)]),
        tolerance: z.number().finite().min(0).max(255),
        minPixels: positive,
      })
      .strict(),
    roi: z.object({ x: integer, y: integer, width: positive, height: positive }).strict(),
    frames: z
      .array(
        z
          .object({
            index: integer,
            pts: PtsSchema,
            outputFrame: integer,
            present: z.boolean(),
            x: z.number().finite().min(0).max(1).nullable(),
            y: z.number().finite().min(0).max(1).nullable(),
            matchedPixels: integer,
            confidence: z.number().finite().min(0).max(1),
          })
          .strict(),
      )
      .min(1)
      .max(600),
    paramsHash: z.string().regex(/^[a-f0-9]{64}$/),
    reportPath: RelativePath,
    limitations: z.array(z.string()),
  })
  .strict()
  .superRefine((report, context) => {
    if (
      report.frames.length !== report.media.frames ||
      report.frames[0]?.pts !== report.clock.originPts ||
      report.roi.x + report.roi.width > report.media.width ||
      report.roi.y + report.roi.height > report.media.height ||
      BigInt(report.clock.endPts) <= BigInt(report.clock.originPts)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Tracked frames, ROI and clock must fit the decoded source',
      });
    for (let i = 0; i < report.frames.length; i++) {
      const frame = report.frames[i];
      const missing = !frame.present && frame.x === null && frame.y === null;
      const observed = frame.present && frame.x !== null && frame.y !== null;
      if (
        frame.index !== i ||
        !(missing || observed) ||
        frame.present !== frame.matchedPixels >= report.marker.minPixels ||
        frame.matchedPixels > report.roi.width * report.roi.height ||
        frame.confidence !== frame.matchedPixels / (report.roi.width * report.roi.height) ||
        (i > 0 && BigInt(frame.pts) <= BigInt(report.frames[i - 1].pts)) ||
        frame.outputFrame !== ptsToFrames(frame.pts, report.clock.originPts, report.clock.timeBase, report.fps)
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Tracked frame must match the observed marker and exact PTS mapping',
        });
    }
  });
export type ReferenceTrack = z.infer<typeof ReferenceTrackSchema>;

export const PlayableLiveProjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: Id,
    revision: positive,
    title: z.string().min(1),
    sources: z
      .array(SourceSchema)
      .length(1)
      .refine(
        sources => sources[0].kind === 'browser' && sources[0].output === 'picture',
        'Live package requires one browser picture Source',
      ),
    assets: z.array(AssetSchema),
    bindings: z.record(Id),
    worlds: z.array(WorldSchema).optional(),
    composition: z.object({ output: OutputSchema }).strict(),
  })
  .strict()
  .superRefine((project, context) => {
    const assets = new Set(project.assets.map(asset => asset.id));
    if (assets.size !== project.assets.length || Object.values(project.bindings).some(id => !assets.has(id)))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Playable asset identities/bindings must resolve uniquely',
      });
    const source = project.sources[0];
    if (source?.kind === 'browser' && source.output === 'picture') {
      if (source.bindings.some(name => !Object.hasOwn(project.bindings, name)))
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Playable Source bindings must resolve' });
      if (source.world) {
        const world = project.worlds?.find(world => world.id === source.world!.id);
        if (
          !world ||
          !world.cameras.some(camera => camera.id === source.world!.camera) ||
          world.entities.some(entity => !assets.has(entity.asset))
        )
          context.addIssue({ code: z.ZodIssueCode.custom, message: 'Playable World and entity Assets must resolve' });
      }
    }
  });
export type PlayableLiveProject = z.infer<typeof PlayableLiveProjectSchema>;
export const PlayablePackageManifestSchema = z
  .object({
    format: z.literal('viscraft-playable-package'),
    version: z.literal(1),
    id: Id,
    project: z.object({ id: Id, revision: positive, title: z.string().min(1) }).strict(),
    source: z.object({ id: Id, entry: RelativePath, sourceHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    simulated: z.boolean(),
    files: z
      .array(
        z
          .object({
            path: RelativePath,
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            role: z.enum(['configuration', 'entry', 'resource', 'asset']),
            asset: Id.optional(),
            rights: RightsSchema.optional(),
          })
          .strict(),
      )
      .min(2),
    notes: z.array(z.string()),
  })
  .strict();
export type PlayablePackageManifest = z.infer<typeof PlayablePackageManifestSchema>;
export interface PlayableResult {
  id: string;
  path: string;
  entry: string;
  files: number;
  sha256: string;
  simulated: boolean;
}
