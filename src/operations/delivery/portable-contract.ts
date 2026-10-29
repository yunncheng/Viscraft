import { RUNTIME_DIR, assertAuthoredPath } from '../../project/authored-path.js';
import { Id, RightsSchema, HandoffRoleSchema, RelativePath } from '../../core/schema.js';
import { z } from 'zod';
import { AuthoredGapSchema } from '../../project/author-inputs.js';

export const HEX = /^[a-f0-9]{64}$/;

export const SNAPSHOTS_PREFIX = `${RUNTIME_DIR}/snapshots/`;

/** Content-addressed store for immutable frozen Asset bytes. */
export const CONTENT_PREFIX = `${RUNTIME_DIR}/content/`;

/** Protected production-original area: the retained provider outputs (never a cache). */
export const PROVIDER_MEDIA_PREFIX = `${RUNTIME_DIR}/provider-media/`;

const CONTENT_PATH = new RegExp(`^${CONTENT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[a-f0-9]{64}$`);

/** The single canonical content-addressed path for a byte sequence. */
export function contentPath(sha256: string): string {
  return `${CONTENT_PREFIX}${sha256}`;
}

/**
 * A deduplicated frozen Asset's logical path must be exactly
 * `.viscraft/snapshots/<buildId>/<authored asset-relative>`: a real Build id, a
 * safe authored relative path that is not inside the runtime `.viscraft/` tree
 * and is not a known credential file. Any other shape (an unnamespaced path, a
 * scatter entry, a credential file) is rejected at the schema boundary rather
 * than silently ignored, so an existing manifest can never carry an arbitrary
 * mapping.
 */
function isSnapshotAssetLogicalPath(logical: string): boolean {
  const rest = logical.slice(SNAPSHOTS_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return false;
  const buildId = rest.slice(0, slash);
  // Build records are always named `build-<id>`; requiring that prefix keeps a
  // stray authored directory from masquerading as a Build namespace.
  if (!buildId.startsWith('build-') || !Id.safeParse(buildId).success) return false;
  const relative = rest.slice(slash + 1);
  try {
    assertAuthoredPath(relative, 'Frozen Asset');
    return true;
  } catch {
    return false;
  }
}

/**
 * Provenance of a physical file in the portable manifest. `snapshot-content`
 * marks a content-addressed blob in `.viscraft/content/<sha256>` whose logical
 * frozen Asset identities live in `snapshotAssets`, so a shared blob is never
 * mistaken for one specific Asset.
 */
export const PortableProvenanceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project') }).strict(),
  z.object({ kind: z.literal('source'), sourceId: Id, role: z.enum(['entry', 'resource']) }).strict(),
  z.object({ kind: z.literal('image-document'), documentId: Id, role: z.enum(['entry', 'resource']) }).strict(),
  z.object({ kind: z.literal('asset'), assetId: Id, simulated: z.boolean(), rights: RightsSchema }).strict(),
  z.object({ kind: z.literal('build'), buildId: Id }).strict(),
  z.object({ kind: z.literal('artifact'), artifactId: Id, operation: z.string(), simulated: z.boolean() }).strict(),
  // A carried local provider ORIGINAL (the raw bytes a provider returned, distinct
  // from the normalized production copy). ONE physical file may be the recorded
  // original of SEVERAL logical owners (the same bytes serve more than one
  // generated Artifact/Asset), so the relation is a LIST: `owners` names every
  // Artifact/Asset whose recorded original hash is this file's bytes, and the file
  // is carried once. `rights` (with the Asset that supplies it, `rightsAssetId`) is
  // present ONLY when a matching rights-bearing Asset owns these exact bytes; a
  // rights-less original carries neither.
  z
    .object({
      kind: z.literal('original'),
      sha256: z.string().regex(HEX),
      owners: z.array(z.object({ kind: z.enum(['artifact', 'asset']), id: Id }).strict()).min(1),
      rightsAssetId: Id.optional(),
      rights: RightsSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('result'), buildId: Id }).strict(),
  z.object({ kind: z.literal('snapshot-metadata'), buildId: Id, file: z.enum(['project', 'inputs']) }).strict(),
  z.object({ kind: z.literal('snapshot-source'), buildId: Id }).strict(),
  z.object({ kind: z.literal('snapshot-content') }).strict(),
  z.object({ kind: z.literal('handoff'), role: HandoffRoleSchema }).strict(),
  z.object({ kind: z.literal('generated'), page: z.enum(['facts', 'attribution']) }).strict(),
]);

export type PortableProvenance = z.infer<typeof PortableProvenanceSchema>;

/** A physical file staged into the export; its path must exist in the staged tree. */
export const PortableFileSchema = z
  .object({
    path: RelativePath,
    sha256: z.string().regex(HEX),
    bytes: z.number().int().nonnegative(),
    provenance: PortableProvenanceSchema,
  })
  .strict();

export type PortableFile = z.infer<typeof PortableFileSchema>;

/**
 * A logical frozen Asset reference whose bytes live once, content-addressed, at
 * `content`. The Asset's own identity/simulated/rights are retained so several
 * references may share one blob without losing their redistribution terms.
 */
export const PortableSnapshotAssetSchema = z
  .object({
    path: RelativePath,
    sha256: z.string().regex(HEX),
    content: z.string().regex(CONTENT_PATH, 'content must be .viscraft/content/<sha256>'),
    provenance: z
      .object({ kind: z.literal('asset'), assetId: Id, simulated: z.boolean(), rights: RightsSchema })
      .strict(),
  })
  .strict()
  .superRefine((asset, context) => {
    if (!asset.path.startsWith(SNAPSHOTS_PREFIX) || !isSnapshotAssetLogicalPath(asset.path)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'path must be .viscraft/snapshots/<buildId>/<authored asset path>',
        path: ['path'],
      });
    }
    if (asset.content !== contentPath(asset.sha256)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'content path must equal .viscraft/content/<sha256>',
        path: ['content'],
      });
    }
  });

export type PortableSnapshotAsset = z.infer<typeof PortableSnapshotAssetSchema>;

/**
 * The single, explicit scope contract persisted with every Portable export.
 *
 * It describes, honestly and structurally, what the export actually carries and
 * what it deliberately excludes, and — critically — it distinguishes five
 * INDEPENDENT facts instead of one `ok`:
 *  - `closureComplete`   — the authored + lineage FILE closure is complete and
 *    self-consistent (a partial closure never succeeds, so this is true on any
 *    successful export; it is recorded so a consumer reads one field, not a guess);
 *  - `rebuildable`       — the frozen lineage + carried Artifacts let the same
 *    Runtime rebuild and reuse the accepted Result/Takes without re-generating;
 *  - `originalsComplete` — every required local provider ORIGINAL was carried
 *    (false when originals were not requested, or when `missing` is non-empty);
 *  - `historyComplete`   — every succeeded Build and all of its declared
 *    Artifacts are carried (unrelated history media is deliberately NOT a promise);
 *  - `taskRecoverable`   — false whenever a provider task is involved: job/remote
 *    request state is never carried, so the same submission can never be replayed
 *    from the package alone.
 *
 * `requested` records the scope the caller asked for (`default`, or the explicit
 * restricted `allow-missing-originals`); `includeOriginals` records whether
 * originals were in scope at all; `requestedVersions` records the STABLE Build ids
 * of any additional accepted versions the caller explicitly asked to carry
 * (sorted, `[]` when none — never inferred by scanning time or filenames);
 * `counts` records the carried totals; `excluded`
 * names each excluded class with a reason; `missing` lists each REQUIRED original
 * that could not be carried (`[]` on a complete export); `receiver` states what the
 * receiving side can and cannot do; `environment` states the environment and
 * authorization the receiver still needs. A restricted package records its real
 * scope here so re-export/archive/restore validate against the RECORDED scope
 * instead of mis-reporting it as corrupt.
 */
export const PortableScopeSchema = z
  .object({
    requested: z.enum(['default', 'allow-missing-originals']),
    includeOriginals: z.boolean(),
    /**
     * The author-state scope, independent of the provider-original scope:
     * `complete` requires every declared authored fact to be carried; the
     * explicit `allow-incomplete` scope records only UNCONSUMED authored gaps and
     * still requires the selected production closure to be complete.
     */
    authoredScope: z.enum(['complete', 'allow-incomplete']),
    /** True only when the whole current author inventory is carried. */
    authorComplete: z.boolean(),
    /** True when every selected Result/Take lineage file is carried/verified. */
    selectedProductionComplete: z.boolean(),
    /** True only when the complete author state can be restored from this package. */
    wholeAuthorRestorable: z.boolean(),
    /** Every freeze-time authored fact that was unavailable ([] on a complete export). */
    authoredGaps: z.array(AuthoredGapSchema),
    /** Resolved STABLE Build ids of explicitly requested additional versions. */
    requestedVersions: z.array(Id).default([]),
    counts: z
      .object({
        /** Physical files staged into the export (excludes the manifest itself). */
        files: z.number().int().nonnegative(),
        builds: z.number().int().nonnegative(),
        artifacts: z.number().int().nonnegative(),
        originals: z.number().int().nonnegative(),
      })
      .strict(),
    excluded: z.array(z.object({ class: z.string().min(1), reason: z.string().min(1) }).strict()),
    missing: z.array(
      z
        .object({
          kind: z.enum(['artifact', 'asset']),
          id: Id,
          sha256: z.string().regex(HEX),
          reason: z.string().min(1),
        })
        .strict(),
    ),
    receiver: z.object({ can: z.array(z.string().min(1)), cannot: z.array(z.string().min(1)) }).strict(),
    environment: z.string().min(1),
    closureComplete: z.boolean(),
    rebuildable: z.boolean(),
    originalsComplete: z.boolean(),
    historyComplete: z.boolean(),
    taskRecoverable: z.boolean(),
  })
  .strict();

export type PortableScope = z.infer<typeof PortableScopeSchema>;

/**
 * Canonical schema for the `.viscraft/portable-manifest.json` written by
 * `exportProject`. The single v1 format content-addresses
 * immutable frozen Asset bytes and lists each logical frozen Asset in
 * `snapshotAssets`. A manifest in any other format is refused by this strict
 * schema rather than decoded.
 */
export const PortableManifestSchema = z
  .object({
    format: z.literal('viscraft-portable-project'),
    version: z.literal(1),
    schemaVersion: z.literal(1),
    project: z.object({ id: Id, revision: z.number(), title: z.string() }).strict(),
    exportedAt: z.string(),
    simulated: z.boolean(),
    builds: z.array(Id),
    artifacts: z.array(Id),
    files: z.array(PortableFileSchema),
    snapshotAssets: z.array(PortableSnapshotAssetSchema),
    scope: PortableScopeSchema,
    notes: z.array(z.string()),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (new Set(manifest.snapshotAssets.map(asset => asset.path)).size !== manifest.snapshotAssets.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'snapshotAssets must not repeat a logical path' });
    }
    // Every `original` provenance must name at least one parent relation, carry
    // its rights with the Asset that supplies them (or neither), and be a
    // physical file under the protected provider-media area.
    for (const file of manifest.files) {
      if (file.provenance.kind !== 'original') continue;
      if (!file.path.startsWith(PROVIDER_MEDIA_PREFIX))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `an original file must live under ${PROVIDER_MEDIA_PREFIX}: ${file.path}`,
        });
      if ((file.provenance.rights === undefined) !== (file.provenance.rightsAssetId === undefined))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `an original must name rightsAssetId together with rights (or neither): ${file.path}`,
        });
    }
    // The recorded counts must describe the actual manifest, so a trimmed or
    // hand-edited package cannot claim a scope it did not carry.
    const carriedOriginals = manifest.files.filter(file => file.provenance.kind === 'original').length;
    if (manifest.scope.counts.files !== manifest.files.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'scope.counts.files must equal the physical file count',
      });
    if (manifest.scope.counts.builds !== manifest.builds.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'scope.counts.builds must equal the carried Build count',
      });
    if (manifest.scope.counts.artifacts !== manifest.artifacts.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'scope.counts.artifacts must equal the carried Artifact count',
      });
    // Every explicitly requested additional version must actually be carried as a
    // Build, so a manifest can never claim it retained a version it dropped.
    for (const requested of manifest.scope.requestedVersions)
      if (!manifest.builds.includes(requested))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `scope.requestedVersions names a Build that is not carried: ${requested}`,
        });
    if (manifest.scope.counts.originals !== carriedOriginals)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'scope.counts.originals must equal the carried original count',
      });
    if (manifest.scope.originalsComplete !== (manifest.scope.includeOriginals && manifest.scope.missing.length === 0))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'scope.originalsComplete must be true only when originals are in scope and none are missing',
      });
    if (manifest.scope.missing.length > 0 && manifest.scope.requested !== 'allow-missing-originals')
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a missing original is only allowed under the explicit allow-missing-originals scope',
      });
    // Author-scope facts must agree with the recorded gaps, and a successful
    // package must always carry a complete selected production closure.
    if (manifest.scope.authorComplete !== (manifest.scope.authoredGaps.length === 0))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'authorComplete must be true exactly when no authored gap is recorded',
      });
    if (manifest.scope.authoredScope === 'complete' && manifest.scope.authoredGaps.length > 0)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'authored gaps are only allowed under the explicit allow-incomplete authored scope',
      });
    if (manifest.scope.authoredScope === 'allow-incomplete' && manifest.scope.authoredGaps.length === 0)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'the allow-incomplete authored scope must record at least one gap',
      });
    if (!manifest.scope.selectedProductionComplete)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a packaged export must always carry a complete selected production closure',
      });
    if (
      manifest.scope.wholeAuthorRestorable !==
      (manifest.scope.authorComplete && manifest.scope.selectedProductionComplete)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'wholeAuthorRestorable must be true only when both the author state and selected production closure are complete',
      });
    // The package-level `simulated` flag must never under-report: any carried file
    // or frozen Asset whose OWN provenance is simulated forces it true, so a
    // simulated Asset that exists only inside an explicitly carried version cannot
    // be hidden behind a `false` aggregate.
    const provenanceSimulated = (provenance: PortableProvenance): boolean =>
      (provenance.kind === 'asset' || provenance.kind === 'artifact') && provenance.simulated;
    if (
      !manifest.simulated &&
      (manifest.files.some(file => provenanceSimulated(file.provenance)) ||
        manifest.snapshotAssets.some(asset => asset.provenance.simulated))
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'simulated must be true when any carried Asset or Artifact is simulated',
      });
  });

export type PortableManifest = z.infer<typeof PortableManifestSchema>;
