import { z } from 'zod';
import {
  RelativePath,
  type ImageTarget,
  type Asset,
  type Project,
  type BuildRecord,
  type Artifact,
} from '../../core/schema.js';
import { PortableScopeSchema, type PortableScope } from './portable-contract.js';
import { type CandidateComparisonEntry } from '../analysis/review.js';
import { type DeliveryKind, type DeliveryRecord } from '../../project/output.js';

export const FORMAT = 'viscraft-delivery-bundle';

export const VERSION = 1;

export const RUNTIME_DIR = '.viscraft';

export const PORTABLE_MANIFEST = `${RUNTIME_DIR}/portable-manifest.json`;

export const PLAYABLE_MANIFEST = 'playable-manifest.json';

export const INDEX_FILE = 'index.html';

export const DELIVERY_MANIFEST = 'delivery-manifest.json';

export const MOVIE_FILE = 'movie/final.mp4';

export const SUBTITLE_FILE = 'movie/final.srt';

/** Delivered still-image products, one per selected target: `image/<target>.<ext>`. */
export const IMAGE_DIR = 'image';

export const REVIEW_DIR = 'review';

export const REVIEW_LAYERS_DIR = 'layers';

export const REVIEW_PATHS_FILE = 'paths.json';

export const PROJECT_DIR = 'project';

export const PLAYABLE_DIR = 'playable';

/** Self-contained audio products: the programme mix and one grouped export per declared bus (under `audio/stems/`). */
export const AUDIO_DIR = 'audio';

export const AUDIO_PROGRAMME = `${AUDIO_DIR}/programme.wav`;

/** A bus label must be a safe single-segment filename; mirrors the schema `Id` shape. */
export const BUS_LABEL = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;

const HEX = /^[a-f0-9]{64}$/;

export const ActiveResultSchema = z
  .object({
    build: z.string().min(1),
    artifact: z.string().min(1),
    simulated: z.boolean(),
    path: RelativePath,
    sha256: z.string().regex(HEX),
  })
  .strict();

export type BundleRole = 'project' | 'movie' | 'image' | 'subtitle' | 'review' | 'audio' | 'index' | 'playable';

/** One hashed file in the bundle, recorded in `delivery-manifest.json`. */
export interface DeliveryFile {
  /** Bundle-relative path using `/` separators. */
  path: string;
  sha256: string;
  bytes: number;
  role: BundleRole;
  /** Portable/Playable provenance when the file came from a package manifest. */
  provenance?: unknown;
}

const BundleRoleSchema = z.enum(['project', 'movie', 'image', 'subtitle', 'review', 'audio', 'index', 'playable']);

/**
 * One hashed file entry in `delivery-manifest.json`. Reuses the `DeliveryFile`
 * shape and the same hex/relative-path validators `deliverProject` writes with,
 * so a manifest produced by this module validates without re-declaration.
 */
export const DeliveryManifestFileSchema = z
  .object({
    path: RelativePath,
    sha256: z.string().regex(HEX),
    bytes: z.number().int().nonnegative(),
    role: BundleRoleSchema,
    provenance: z.unknown().optional(),
  })
  .strict();

/**
 * Shape of `delivery-manifest.json`. Descriptive sections (movie/review/audio/
 * build/projectExport/notes/limitations) are informational and pass through
 * untouched, but the identity (`format`/`version`) and the complete hashed
 * `files` allowlist a verifier depends on are validated strictly. A manifest
 * that does not carry them is refused loudly rather than read as "no files".
 */
export const DeliveryManifestSchema = z
  .object({
    format: z.literal(FORMAT),
    version: z.literal(VERSION),
    exportedAt: z.string().min(1),
    files: z.array(DeliveryManifestFileSchema),
    projectExport: z
      .object({
        path: z.literal('project'),
        files: z.number().int().nonnegative(),
        simulated: z.boolean(),
        builds: z.array(z.string()),
        artifacts: z.array(z.string()),
        scope: PortableScopeSchema,
      })
      .strict(),
    project: z.unknown(),
    build: z.unknown(),
    simulated: z.boolean(),
    selection: z.unknown(),
    movie: z.unknown(),
    images: z.unknown(),
    sounds: z.lazy(() => z.array(DeliverySoundSchema)),
    imageMaterials: z.unknown().optional(),
    subtitles: z.unknown(),
    audio: z.unknown(),
    review: z.unknown(),
    playable: z.unknown(),
    index: RelativePath,
    bytes: z.number().nonnegative(),
    logicalBytes: z.number().nonnegative(),
    diagnostics: z.array(z.string()),
    notes: z.array(z.string()),
    limitations: z.array(z.string()),
    nonRedistributableAssets: z.unknown().optional(),
    // Additive private-copy marker: present only when the bundle carries
    // non-redistributable Asset bytes under the explicit opt-in.
    containsNonRedistributableAssets: z.boolean().optional(),
  })
  .strict();

export type DeliveryManifestFile = z.infer<typeof DeliveryManifestFileSchema>;

export type DeliveryManifest = z.infer<typeof DeliveryManifestSchema>;

/**
 * One delivered still as recorded in `delivery-manifest.json`. The `workbench`
 * entry is required by the bundle contract; it lets a reopened bundle show the
 * delivered product and
 * the command that reopens its editor.
 */
export const DeliveryWorkbenchSchema = z
  .object({
    target: z.string().min(1),
    document: z.string().min(1),
    documentPath: RelativePath,
    command: z.string().min(1),
    editableProject: z.literal(true),
    note: z.string().min(1),
  })
  .strict();

export const DeliveryImageSchema = z
  .object({
    target: z.string().min(1),
    build: z.string().min(1),
    artifact: z.string().min(1),
    path: RelativePath,
    sha256: z.string().regex(HEX),
    bytes: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    format: z.enum(['png', 'jpeg', 'webp']),
    background: z.enum(['transparent', 'opaque']),
    simulated: z.boolean(),
    workbench: DeliveryWorkbenchSchema,
  })
  .strict();

/** Resolve the verbatim review report's authored paths to the bundled products. */
export const DeliveryReviewPathsSchema = z
  .object({
    format: z.literal('viscraft-delivery-review-paths'),
    version: z.literal(1),
    build: z.string().min(1),
    reviewRoot: z.literal(REVIEW_DIR),
    note: z.string(),
    paths: z.array(
      z
        .object({
          original: RelativePath,
          bundle: RelativePath,
          kind: z.enum(['contact-sheet', 'seam', 'layer', 'candidate-comparison', 'report']),
        })
        .strict(),
    ),
  })
  .strict();

/** The regenerated, hash-verified review products copied into `review/`. */
export interface DeliveryReview {
  build: string;
  contactSheet: string;
  seams: string[];
  /** Per-picture-layer strips reported by the review, copied into `review/layers/`. */
  layers: string[];
  /** Per-shot candidate-Take comparison strips, copied into `review/`. Empty when the Build declared no candidates. */
  candidates: string[];
  report: string;
  /**
   * Companion map (original project-relative review path → bundled path). The
   * verbatim report.json still names the exported project's
   * `.viscraft/reviews/<build>/…` paths, which are intentionally removed from the
   * bundled `project/`; this map resolves each to its location under `review/`.
   */
  paths: string;
  contactSheetSha256: string;
  seamsSha256: string[];
  layersSha256: string[];
  candidatesSha256: string[];
  reportSha256: string;
  pathsSha256: string;
}

/** The optional standalone live Playable package copied into `playable/`. */
export interface DeliveryPlayable {
  id: string;
  path: string;
  entry: string;
  files: number;
  sha256: string;
  simulated: boolean;
}

/**
 * One Asset included in the bundle whose `rights.redistributable` is false. The
 * bytes are present only when the caller passed the explicit, default-off
 * `allowNonRedistributable` opt-in; the delivery then declares that the bundle is
 * a private copy not cleared for redistribution.
 */
export interface DeliveryNonRedistributableAsset {
  /** Registered Asset id. */
  asset: string;
  /** Project-relative authored Asset path as recorded in the Portable manifest. */
  path: string;
  origin: string;
  license: string;
  /** Author-recorded attribution facts, carried verbatim from the Asset's rights. */
  author?: string;
  sourceUrl?: string;
  licenseUrl?: string;
  notice?: string;
  modifications?: string;
  attributionRequired?: boolean;
}

/** The deterministic editable SRT caption sidecar copied into `movie/final.srt`. */
export interface DeliverySubtitles {
  /** Bundle-relative sidecar path (`movie/final.srt`). */
  path: string;
  sha256: string;
  bytes: number;
  /** Number of captions written, in authored order. */
  captions: number;
}

/** One grouped per-bus stem copied into `audio/stems/<bus>.wav`. */
export interface DeliveryAudioStem {
  bus: string;
  path: string;
  sha256: string;
  bytes: number;
  simulated: boolean;
}

/**
 * The self-contained audio products copied into `audio/`: the programme mix and
 * one ADDITIONAL grouped export per declared bus. Stems overlap the programme
 * mix (they are not a partition); the delivered movie always muxes the programme
 * mix, never the stems.
 */
export interface DeliveryAudio {
  /** `audio/programme.wav`, or null when the frozen snapshot declares no audio at all. */
  programme: string | null;
  programmeSha256: string | null;
  programmeBytes: number | null;
  /** Grouped per-bus exports, in ascending bus-label order. Empty when no bus is declared. */
  stems: DeliveryAudioStem[];
}

/**
 * How to reopen the editor for ONE delivered still.
 *
 * Deliberately contains no URL and no token: a workbench session URL is only
 * valid while a local `viscraft workbench` process runs, so persisting it in a
 * static manifest/index would create a dead or secret-bearing link. The command
 * uses `<project-directory>` as a placeholder; the bound delivery is a
 * Runtime-recorded `output/<entry>`, never an arbitrary path.
 */
export interface DeliveryWorkbenchEntry {
  /** Delivered image target id. */
  target: string;
  /** Declared image document that owns the target. */
  document: string;
  /** The document's authored project-relative path, for orientation only. */
  documentPath: string;
  /** Portable reopen command (contains the `<project-directory>` placeholder). */
  command: string;
  /** True when this bundle carries the editable project at `project/`. */
  editableProject: boolean;
  /** Plain-language limits of the reopen entry, including what a receiver must do. */
  note: string;
}

/** One delivered still image: the current succeeded result of an image target. */
export interface DeliveryImage {
  /** Declared image target id. */
  target: string;
  /** The succeeded Build that produced this still. */
  build: string;
  /** The Build's result Artifact. */
  artifact: string;
  /** Bundle-relative path (`image/<target>.<ext>`). */
  path: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  format: ImageTarget['format'];
  background: ImageTarget['background'];
  simulated: boolean;
  /** Reopen metadata for this final delivered still. */
  workbench: DeliveryWorkbenchEntry;
}

/** One Asset the delivered still's document/resources actually consumed. */
export interface DeliveryImageMaterialAsset {
  /** Registered Asset id as recorded in that Build's frozen snapshot. */
  asset: string;
  type: string;
  path: string;
  simulated: boolean;
  /**
   * The rights record frozen with the Build that produced the delivered pixels.
   * Historical license/notice/attribution facts are authoritative and are never
   * overwritten by a later current declaration; a newly declared restriction is
   * reported separately through `nonRedistributableAssets`.
   */
  rights: Asset['rights'];
}

/**
 * The material record for one delivered still, keyed by target AND producing
 * Build. Two targets can consume the same Asset id under different historical
 * declarations, so these records are never collapsed into one global Asset list.
 */
export interface DeliveryImageMaterial {
  target: string;
  build: string;
  /** The image document path recorded in that Build's frozen snapshot. */
  document: string;
  /** Assets whose recorded path matches the frozen document or one of its resources. */
  assets: DeliveryImageMaterialAsset[];
}

/**
 * Which PRODUCTS this delivery is for. `undefined` (the whole object omitted)
 * keeps the convenient default: the movie when the Project has a timeline
 * composition, plus every declared image target. Any explicit object selects
 * exactly what it names; an omitted field is not selected.
 */
export interface DeliveryOutputs {
  /** Deliver the active film result (`movie/final.mp4`). */
  movie?: boolean;
  /** Deliver these image targets (duplicates collapse; delivered in ascending id order). */
  images?: string[];
  /** Deliver these sound programmes (`sound/<target>.wav`). */
  sounds?: string[];
}

export const DeliverySoundSchema = z
  .object({
    target: z.string().min(1),
    build: z.string().min(1),
    artifact: z.string().min(1),
    path: RelativePath,
    sha256: z.string().regex(HEX),
    bytes: z.number().int().nonnegative(),
    samples: z.number().int().positive(),
    sampleRate: z.union([z.literal(44100), z.literal(48000)]),
    channels: z.union([z.literal(1), z.literal(2)]),
    simulated: z.boolean(),
  })
  .strict();

export type DeliverySound = z.infer<typeof DeliverySoundSchema>;

/** Typed outcome of `deliverProject`. Lives in this module (no core schema change). */
export interface DeliveryResult {
  /** Absolute path of the newly created bundle directory. */
  path: string;
  /** Bundle-relative manifest path (`delivery-manifest.json`). */
  manifest: string;
  manifestSha256: string;
  /**
   * Report-only findings about the handoff text that entered the bundle
   * (machine-specific absolute paths, suspected secrets). Never a failure; the same
   * list is written into the manifest's `diagnostics`.
   */
  diagnostics: string[];
  /** The complete editable Portable export bundled at `project/`. */
  project: { path: string; files: number; simulated: boolean; warnings: string[]; scope: PortableScope };
  /** The exact active Build id whose result was delivered, or null when the movie was not selected. */
  build: string | null;
  /** Authored project revision at delivery time. */
  revision: number;
  simulated: boolean;
  /** The delivered movie, or null when the movie was not selected. */
  movie: { path: string; sha256: string; artifact: string; bytes: number } | null;
  /** Delivered still images, in the selected target order. Empty when none. */
  images: DeliveryImage[];
  sounds: DeliverySound[];
  /**
   * Per-still frozen material: the Assets each selected target's producing Build
   * recorded for its document and declared resources, with their simulated and
   * rights facts. Empty when no still was selected.
   */
  imageMaterials: DeliveryImageMaterial[];
  /** Deterministic SRT sidecar for declared subtitles, or null when there are none (or no movie). */
  subtitles: DeliverySubtitles | null;
  /** Programme mix and grouped per-bus stems copied into `audio/`. Empty when no movie was selected. */
  audio: DeliveryAudio;
  review: DeliveryReview | null;
  playable: DeliveryPlayable | null;
  index: string;
  /** True when the bundle includes non-redistributable Assets under the explicit opt-in. */
  containsNonRedistributableAssets: boolean;
  /** The private Assets included under the opt-in, in ascending Asset-id order. Empty on the strict path. */
  nonRedistributableAssets: DeliveryNonRedistributableAsset[];
  /** Number of bundled content files (excludes the manifest itself). */
  files: number;
  /**
   * Physical size of the bundled payload: the summed size of each distinct
   * `(dev, inode)` after in-bundle dedup, so a legitimately deduplicated frozen
   * copy counts once but two independent editable copies each count. Excludes
   * the manifest.
   */
  bytes: number;
  /** Per-path sum, counting every listed path (excludes the manifest). */
  logicalBytes: number;
}

export interface Planned {
  absolute: string;
  sha256: string;
  bytes: number;
  role: BundleRole;
  provenance?: unknown;
}

export interface ReviewReportShape {
  observation?: string;
  limitations?: string[];
  contactSheet?: string;
  seams?: string[];
  timeline?: { layers?: Array<{ id?: string; strip?: string }> };
  audio?: {
    loudness?: { available?: boolean; integratedLufs?: number; truePeakDbfs?: number; reason?: string };
    silence?: { available?: boolean; intervals?: unknown[]; reason?: string };
  };
  video?: { blackFrames?: unknown[] };
}

export interface ResolvedSelection {
  movie: boolean;
  /** Selected image target ids, deduplicated and in ascending id order. */
  images: string[];
  sounds: string[];
}

export interface IndexContext {
  currentProject: Project;
  frozenProject: Project;
  /** Film facts, or null when the caller did not select the movie. */
  film: {
    build: BuildRecord;
    result: { build: string; artifact: string; simulated: boolean; path: string; sha256: string };
    artifact: Artifact;
    moviePath: string;
    movieSha256: string;
    movieBytes: number;
  } | null;
  /** Delivered still images (may coexist with the movie). */
  images: DeliveryImage[];
  sounds: DeliverySound[];
  /** Frozen material facts for the delivered stills (empty when none). */
  imageMaterials: DeliveryImageMaterial[];
  subtitles: DeliverySubtitles | null;
  /** Audio products copied into `audio/` (programme mix + grouped per-bus stems). */
  audio: {
    programme: { path: string; sha256: string; bytes: number } | null;
    /** Bundled project-export path whose bytes equal the programme mix, or null when none. */
    programmeFrozenPath: string | null;
    stems: Array<{ bus: string; path: string; sha256: string; bytes: number }>;
  };
  portableSimulated: boolean;
  simulated: boolean;
  review: {
    report: ReviewReportShape;
    contactSheet: string;
    seams: string[];
    layers: string[];
    /** Per-shot candidate-Take comparisons, with `strip` already resolved to its bundled `review/…` path. */
    candidates: Array<{ shot: string; strip: string | null; entries: CandidateComparisonEntry[] }>;
    /** Candidate strips retained byte-identically by an in-place still update (no per-Take rows re-derived). */
    retainedCandidates?: string[];
    reviewReport: string;
    reviewPaths: string;
  } | null;
  playable: DeliveryPlayable | null;
  /** Non-redistributable Assets included under the explicit opt-in; empty on the strict path. */
  nonRedistributableAssets: DeliveryNonRedistributableAsset[];
}

export const DeliveryOptionsSchema = z
  .object({
    playableSource: z.string().optional(),
    allowNonRedistributable: z.boolean().optional(),
    allowMissingOriginals: z.boolean().optional(),
    allowIncompleteAuthored: z.boolean().optional(),
    review: z.boolean().optional(),
    stems: z.boolean().optional(),
    outputs: z
      .object({
        movie: z.boolean().optional(),
        images: z.array(z.string()).optional(),
        sounds: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** One listed file whose on-disk bytes no longer match the recorded hash. */
export interface DeliveryMismatch {
  /** Bundle-relative path using `/` separators. */
  path: string;
  /** sha256 recorded in `delivery-manifest.json`. */
  expected: string;
  /** sha256 of the bytes actually present. */
  actual: string;
}

/**
 * Typed, honest outcome of `verifyDelivery`.
 *
 * `ok` is true only when the manifest is well-formed AND every listed file is
 * present with matching bytes AND no file is present that the manifest does not
 * list. `unlisted` never includes `delivery-manifest.json`: the manifest
 * deliberately does not list itself. A malformed manifest is not represented
 * here — `verifyDelivery` refuses it loudly instead of reporting a false result.
 */
export interface DeliveryVerification {
  /** Absolute path of the verified bundle directory. */
  path: string;
  /** Bundle-relative manifest path (`delivery-manifest.json`). */
  manifest: string;
  /** sha256 of the manifest file's own bytes. */
  manifestSha256: string;
  format: string;
  version: number;
  exportedAt: string;
  /** Number of files the manifest lists. */
  listed: number;
  /** Number of listed files present on disk with matching bytes. */
  verified: number;
  /** Listed files present but with different bytes. */
  mismatched: DeliveryMismatch[];
  /** Listed files absent from the bundle. */
  missing: string[];
  /** Files present but not listed by the manifest (excludes the manifest itself). */
  unlisted: string[];
  /** True when `mismatched`, `missing` and `unlisted` are all empty. */
  ok: boolean;
}

/**
 * A delivered still, as inspected by a workbench. `productPath` is
 * bundle-relative (`image/<target>.<ext>`, inside the bundle) and `projectPath`
 * is project-relative (`output/<entry>/image/<target>.<ext>`, what a local page
 * or download can resolve from the Project root).
 *
 * A bundle whose manifest parses but whose members no longer verify is still
 * reported here — with the manifest's own recorded facts and `verified: false`,
 * `blocked: <reason>` — so an author page can show the blocked binding instead
 * of inventing a fallback identity. A missing record, a foreign Project or a
 * bundle that does not carry the requested target still throws.
 */
export interface ImageDeliveryInspection {
  /** Runtime-recorded `output/` entry name. */
  entry: string;
  /** Absolute bundle directory (this machine only; never written into index.html). */
  path: string;
  kind: DeliveryKind;
  revision: number;
  deliveredAt: string;
  manifestSha256: string;
  movie: boolean;
  /** True when the bundle carries the editable project at `project/`. */
  project: boolean;
  images: DeliveryImage[];
  sounds: DeliverySound[];
  target: string;
  document: string;
  documentPath: string;
  /** Bundle-relative product path (`image/<target>.<ext>`). */
  productPath: string;
  /** Project-relative product path (`output/<entry>/image/<target>.<ext>`). */
  projectPath: string;
  build: string;
  artifact: string;
  format: ImageTarget['format'];
  width: number;
  height: number;
  sha256: string;
  bytes: number;
  simulated: boolean;
  /** The delivered pixels no longer match the CURRENT saved author source. */
  stale: boolean;
  workbench: DeliveryWorkbenchEntry;
  /** True only when the manifest, every member and the delivery record agree. */
  verified: boolean;
  /** Why the binding is blocked, or null when `verified` is true. */
  blocked: string | null;
}

/** Which recorded `output/` delivery and still an update is about. */
export interface ImageDeliveryUpdateOptions {
  /** Runtime-recorded `output/` entry name (never a path). */
  delivery: string;
  /** The delivered image target to replace. */
  target: string;
  /**
   * EXACT Build to publish. Omitted means "republish the newest already
   * succeeded render of this target whose key equals the current saved source";
   * an update NEVER renders and never submits a model task. A provided Build is
   * never substituted with a newer one: if its recorded render key no longer
   * matches the saved source, the update refuses and the delivered file is left
   * unchanged.
   */
  build?: string;
}

export interface ImageDeliveryUpdateResult {
  entry: string;
  /** Absolute bundle directory. */
  path: string;
  productPath: string;
  projectPath: string;
  target: string;
  document: string;
  /** The updated still's own manifest entry (its `bytes` is the product size). */
  image: DeliveryImage;
  build: string;
  artifact: string;
  format: ImageTarget['format'];
  width: number;
  height: number;
  sha256: string;
  /** Physical bytes of the WHOLE updated bundle (distinct files, manifest excluded). */
  bytes: number;
  simulated: boolean;
  /** The delivered file this update replaced (still readable as its immutable Artifact). */
  previous: { path: string; sha256: string; bytes: number; build: string; artifact: string } | null;
  images: DeliveryImage[];
  sounds: DeliverySound[];
  imageMaterials: DeliveryImageMaterial[];
  workbench: DeliveryWorkbenchEntry;
  manifest: string;
  manifestSha256: string;
  /** Bundled products whose bytes were copied through unchanged. */
  preserved: string[];
  project: {
    path: string;
    files: number;
    simulated: boolean;
    builds: string[];
    /** Non-blocking export warnings, exactly as the Portable export reported them. */
    warnings: string[];
    originals: number;
    scope: PortableScope;
  };
  retained: { movie: boolean; images: string[]; files: number };
  files: number;
  /** Summed size of every listed payload file (manifest excluded). */
  logicalBytes: number;
}

/** What a bundle's own manifest and members prove, without mutating anything. */
export interface BundleObservation {
  manifest: DeliveryManifest;
  manifestSha256: string;
  /** Effective record (with a recovered pending hash when one was accepted). */
  record: DeliveryRecord;
  verified: boolean;
  blocked: string | null;
}
