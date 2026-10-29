# Delivery reference

Moving an authored Project, its active Result or its rendered still targets to
another directory, another machine or a reviewer: portable export, single-file
archive/restore, and the self-contained delivery bundle. Authoring and execution
contracts are in [Runtime and authoring](runtime-authoring.md); the live Playable
package is in [World and Playable](world-playable.md).

`deliver` creates one complete handoff. Its index opens the selected products;
send individual product files when only those are needed, and the whole handoff
when someone will continue authoring. Do not publish the source bundle merely to
share a movie. Review and audio exports are optional attachments, not modes.

**Contents**

1. [Portable export](#1-portable-export)
2. [Single-file archive and restore](#2-single-file-archive-and-restore)
3. [Complete handoff](#3-one-complete-handoff)

## 1. Portable export

`export <project-dir> [new-destination] [--allow-non-redistributable]
[--allow-missing-originals] [--allow-incomplete-authored]
[--extra-version <build-id|retained>]...` (SDK `exportProject(root, destination?)`)
creates a reopenable project directory and a hashed `.viscraft/portable-manifest.json`.
It carries current authored files, redistributable registered assets, and the frozen
Build/Artifact lineage required by the selected Result/Takes, including the actual
producer Operations and their frozen input snapshots — not merely a later edit that
references the same Take. Build JSON and complete frozen inputs are preserved
unchanged, but unrelated past output movies may be recorded without copying their
media bytes. The manifest's `artifacts` list is the actual packaged subset; active
candidate Takes remain available. Review still requires the selected result, Takes
and dependencies, and verifies any other artifact bytes that are present. This lets a
recorded-state soundtrack be safely re-authored after export without packaging every
old final movie. Snapshot inputs can still make a project much larger than the
finished files; a handoff carries no fixed local size quota, but it is not an
unlimited history archive either ([§3](#closure-replacement-and-sharing)).

Every export also renders two receiver pages under `.viscraft/pages/` (never
authorities, never overwriting an authored file at the same path, no root copies):
`.viscraft/pages/VISCRAFT.md` (current result, kept versions,
Sources, required capabilities, start-up commands, whether the package is fully
restorable or carries an explicit gap, and a reminder that credentials are
configured by the receiver) and, when any Asset carries attribution facts,
`.viscraft/pages/ATTRIBUTION.md` (the same cells as the delivery `index.html` Assets table).
Author-written handoff files are declared in `project.handoff` as
`[{ "path": "NOTES.md", "role": "notes" }]` with role `readme | notes |
attribution | license | helper`. A licence's full text belongs here, with role
`license`, not as a `code` Asset. They ride along with real hashes, are not
production inputs (editing them never invalidates a Source), and a missing one
fails the export. There is no per-file size gate: every handoff file and every
other carried file is streamed and hashed, text roles must be valid UTF-8, and the
credential scan covers the whole content — including a secret or pattern that spans
a chunk boundary — not just the head of a file. The total still follows the actual
export/archive/delivery budget below; do not invent an author-facing per-file cap. A credential-looking
value fails the export; a local absolute path is reported in `warnings`.

The portable format keeps `files` as the **physical** hashed file list and
adds `snapshotAssets` for logical frozen Asset paths. Eligible frozen Asset bytes
are stored once per SHA-256 at `.viscraft/content/<hash>`; every logical mapping
retains the original Asset ID, hash, rights and simulated origin. Current editable
Assets are independent copies, never hardlinked to immutable content. Source entry/
resources, frozen recordings and their required inputs/preview, flat snapshot
metadata and Build JSON remain physical and unchanged. This reduces repeated
frozen Asset copies without deleting provenance or dropping carried lineage.

Use the current Runtime to re-export: missing frozen Asset paths
resolve only through exact validated mappings and hash-checked content, not through
arbitrary files. Missing/corrupt content, mismatched provenance and protected-source
files still fail. The Runtime validates the complete manifest structure and
content hashes. A snapshot Asset's
logical path is not a promise that its bytes exist at that physical path; use the
manifest mapping when inspecting storage. Do not materialize all duplicates just to
count files or silently edit immutable blob bytes. A changed current Asset must not
alter any previous frozen version. Full history media remains outside the export
promise.

It excludes unknown files, credentials, scratch, locks and provider job/remote
state. Required non-redistributable assets or damaged lineage fail export instead of
being silently omitted. Use `build` on the exported directory with the same Runtime
to reuse accepted artifacts; use a fresh explicit attempt when intentionally
producing a new simulated Take.

`exportProject(root, destination?, { allowNonRedistributable?, includeOriginals?,
allowMissingOriginals?, allowIncompleteAuthored?, extraVersions? })` also carries the REQUIRED local provider **originals** of
the current edit closure's generated media (the raw bytes a provider returned, which
usually differ from the normalized production copy) at
`.viscraft/provider-media/<name>`, each listed with an `original` provenance (its real
hash and parent Artifact/Asset relation). The recorded hash is the only locator; a
missing or corrupt original fails loudly (naming the artifact and the hash) instead
of being replaced by the normalized copy. Only the explicit, default-off
`{ allowMissingOriginals: true }` restricted scope records the gap in the manifest
instead. A generated image whose registered Asset IS the original bytes keeps both
the relation and the Asset's rights; a host-imported Asset with no provider original
is never reported as a missing one. The explicit `{ includeOriginals: false }` scope carries no originals and records
that restriction; ordinary `deliver` includes required originals. Job bodies, remote ids,
URLs and signed URLs are never carried.

To hand a receiver an additional **accepted version** beyond the active edit closure,
pass `extraVersions: ['<build-id>', …]` (CLI `--extra-version <build-id|retained>`,
repeatable). Versions are named by STABLE Build id only — never by scanning time or
filenames — and each named Build must exist and be `succeeded`; the literal `retained`
selects every Build carrying the `retained` (keep) flag. Each requested Build is a set
union over the SAME production closure: its Build record, frozen snapshot
metadata/sources and every declared Artifact (result, Takes and declared artifacts) are
carried and hash-verified exactly as the active result's lineage is. An unknown id, a
non-succeeded Build, or a **checkpoint** id fails loudly and writes nothing —
`--extra-version` carries named succeeded Builds only, not checkpoints. The resolved
ids are recorded in
`scope.requestedVersions` (sorted; `[]` by default), and the carried Builds/Artifacts are
counted in `scope.counts`. `archive` accepts the same `extraVersions` option
(`--extra-version`), and restore/re-export replay the recorded `requestedVersions`, so
the package validates against what it actually carries.

Every manifest carries a strict `scope` object: the requested provider scope
(`default` or the restricted `allow-missing-originals`), whether originals were in
scope, the resolved additional-version Build ids (`requestedVersions`; `[]` when
none), the carried counts (`files`/`builds`/`artifacts`/`originals`; `files` is
the physical file count and EXCLUDES the manifest itself, matching
`PortableExport.files`), the excluded classes with a reason each, any
missing-required entries (`[]` on success), what the receiver can and cannot do,
the environment/authorization note, and five INDEPENDENT facts —
`closureComplete`, `rebuildable`, `originalsComplete`, `historyComplete`,
`taskRecoverable` — never one `ok`. The purpose of each file is its provenance kind
(the original's media spec stays on the Artifact's recorded `generation.originalMedia`).

Author state has a second, independent scope: `authoredScope: 'complete' |
'allow-incomplete'`, `authorComplete`, `selectedProductionComplete`,
`wholeAuthorRestorable`, and `authoredGaps` (`path`, `reason`, `expectedSha256`,
`actualSha256`, `owners`). By default any current authored gap is refused, naming
every missing file. The explicit `allowIncompleteAuthored` option records only
**UNCONSUMED** gaps; a gap needed by the selected Result/Takes is always refused,
because it cannot make an incomplete production look complete. On a
restricted-author package `closureComplete` and `rebuildable` are false,
`authorComplete`/`wholeAuthorRestorable` are false, and `authoredGaps` lists each
unfabricated gap — never describe that package as whole-author complete.

Snapshot inputs include an `unavailable` list for the same gaps, and the snapshot
hash covers those entries as well as the present files. A missing authored input
is therefore a recorded gap, not a silently different snapshot.

`archive`/`restore`/re-export validate against the RECORDED scope, so a restricted
package is not falsely reported as corrupt on restore. No job/remote state travels, so
the same provider submission can never be replayed from the package: `taskRecoverable`
is false whenever a provider task exists.

`review` reads the selected Build's frozen Project, verifies artifact hashes, and
writes PNG still grids plus `report.json` under `.viscraft/reviews/<build-id>/`.
Contact-sheet rows correspond to placement instances, so repeating a Shot does not
accidentally sample an intervening different Shot. Open the images with the host's
image observation tool. Loudness/true-peak measurements are technical evidence, not
proof that anyone listened to the soundtrack or approved the aesthetics.

## 2. Single-file archive and restore

`archiveProject(root, newArchiveFile?, { partSize?, maxContent?,
allowNonRedistributable?, includeOriginals?, allowMissingOriginals?,
allowIncompleteAuthored?, extraVersions? })` (`archive
<project-dir> [new-file] [--part-size <MiB>] [--max-content <GiB>]
[--allow-missing-originals] [--allow-incomplete-authored]
[--extra-version <build-id|retained>]...`) makes
one gzip/USTAR file from a newly verified portable export. It locks author/build
state only while making that independent copy, then packages the exact physical
manifest allowlist. `restoreProject(archive, newProjectDirectory, { maxContent? })`
(`restore <archive-file | name.parts.json> <new-directory> [--max-content <GiB>]`)
verifies the transport, hashes, rights, mappings
and actual author/producer dependency closure before creating an ordinary Project.
Neither operation runs code, launches a browser, executes media or submits a Provider.
A digest is integrity evidence, not authentication or a guarantee that code is safe.
Build only trusted restored code under the host's normal permissions.

```bash
./node_modules/.bin/viscraft archive <project-dir> [new-file.tar.gz]
./node_modules/.bin/viscraft restore <new-file.tar.gz> <new-project-dir>
./node_modules/.bin/viscraft build <new-project-dir>
# a transport that limits single-file size:
./node_modules/.bin/viscraft archive <project-dir> big.tar.gz --part-size 1900
./node_modules/.bin/viscraft restore big.tar.gz.parts.json <new-project-dir>
```

`--part-size` writes `<name>.part-001…N` and `<name>.parts.json` (`projectId`,
`revision`, whole-archive `{sha256, bytes}`, and each part's `{name, sha256,
bytes}`); the list is published last. Restoring from the list first checks every
part is present beside it, in order, with its size and hash, and that the
concatenation matches the whole-archive hash — a missing, corrupt, reordered or
foreign part is refused by name before anything is decoded. Keep all parts and
the list together.

The transport is restricted to regular-file USTAR entries, manifest first, with
checked headers/padding/end markers. It is not a general tar/zip importer. Paths,
case/Unicode aliases, duplicates, links/special files, unlisted bytes, corrupt hashes,
extra unused mappings and forged provenance are rejected. Restore accepts current
v1 portable archives and directories conforming to the current contract;
unsupported structures are refused without conversion. Current/frozen JSON bytes
and recording dependencies remain unchanged;
logical snapshot Asset paths stay content-addressed rather than recreated as duplicates.

Bounds: the portable manifest records every member's exact size, so the reader
holds the archive to that declaration live (an undeclared member, a size that
differs, extra decoded bytes or a compressed input above the declared/derived
bound stops before the file is created). Above it sits an absolute content cap,
4 GiB by default; `--max-content` raises it explicitly on either side and a
restore cap below the manifest's declaration is refused. Fixed: 10,000 physical
members and logical Asset references, 8 MiB manifest/Project/Build/frozen
metadata, 64 MiB other JSON. The transport streams payloads. Restore checks
untrusted payload bounds before semantic re-export.

Both destinations must be new with an existing, trusted parent. Archive-file
publication is atomic no-replace. Directory restoration claims its destination
with exclusive mkdir, copies verified files, and writes project.json last; it is
**not whole-directory atomic**. A caught failure removes only its owned output;
a process kill may leave an incomplete new directory. Do not build it before restore
returns successfully. The original archive is immutable; edits happen in the restored
Project and need a fresh archive/export afterward.

`ArchiveResult` returns `path`, `sha256`, `compressedBytes`, `contentBytes`, `files`,
`simulated`, and `parts` for a split archive. The hash/size describe the whole
archive (input on restore); `path` is the new archive, its parts list, or the
restored directory. `files` excludes the portable manifest;
`contentBytes` includes it. Match the installed Runtime/environment for accepted
Artifact reuse; transport success is not cross-machine pixel determinism, full-history
media backup or complete artistic acceptance.

## 3. One complete handoff

`deliverProject(root, destination?, { outputs?, review?, stems?, playableSource?,
allowNonRedistributable?, allowMissingOriginals?, allowIncompleteAuthored? })`
assembles a handoff from already-produced results. CLI:

```bash
viscraft deliver <project-directory> [new-destination] \
  [--movie] [--image <target>]... [--sound <target>]... [--review] [--stems] \
  [--playable <source-id>] [--allow-non-redistributable] \
  [--allow-missing-originals] [--allow-incomplete-authored]
```

No destination means `output/handoff/`. Its `index.html` is both the viewing and
file-download entry. One completed handoff contains the selected products **and
one complete editable Project**. The author Project can contain other meaningful
outputs or alternatives; selecting a product does not prune that author state.
There is no purpose selector. Neither saving nor previewing requires delivery.

### Products and optional attachments

`outputs?: { movie?: boolean; images?: string[]; sounds?: string[] }` selects
products. `--movie` selects the film, repeatable `--image` selects still target IDs
and repeatable `--sound` selects sound target IDs. With no selector, the Runtime
delivers all declared outputs; any explicit selector delivers exactly its named set.
An empty set and unknown target are refused. Select from the actual request rather
than assuming every declared output is wanted.

- A movie is copied from the ACTIVE Result, never the newest/failed Build. Its
  frozen captions produce an editable SRT sidecar when subtitles exist.
- A selected still must have a succeeded non-preview render whose `imageRenderKey`
  matches its current saved document/resources/settings and whose recorded capture
  environment matches the current machine. Stale, missing and
  unrendered images fail by name: render them first. Delivery does not render
  images or submit model tasks, and never silently drops a selected product.
- A selected sound target must have an available current, succeeded sound Build
  whose frozen target, Source and Asset facts still match the authored programme.
  Its WAV is copied and no movie, picture or black video is fabricated.
- `review: true` / `--review` regenerates technical contact sheets, cut-boundary
  strips, reported layer/candidate comparisons and their numerical report from
  the selected movie. It requires a movie; a still-only request is refused.
- `stems: true` / `--stems` attaches the actual programme WAV and one grouped WAV
  per declared audio bus. It requires a selected movie. It does not imply review,
  source separation, semantic listening or one separate file per instrument.
- `playableSource` / `--playable` optionally attaches a standalone playable package.

The review and audio options are independent and off by default. Technical
attachments are not a curated case or a creative explanation. A public case also
needs author-written context and appropriate rights; do not dump all diagnostics
into an ordinary delivery just because they exist.

```text
output/handoff/
  index.html                  viewing/download entry, static and token-free
  delivery-manifest.json      hashed file allowlist
  movie/final.mp4              selected film only
  movie/final.srt              selected film with declared captions
  image/<target>.<ext>         selected stills in their actual format
  sound/<target>.wav           selected sound targets, their real WAV
  project/                    complete editable Portable Project and handoff files
  review/                     only with --review and a selected film
  audio/programme.wav         only with --stems and a selected film
  audio/stems/<bus>.wav        grouped audio buses with --stems
  playable/                   only when requested
```

Only applicable directories exist. For a mixed Project, `--image poster` or
`--sound cue` still carries the complete `project/`, but no top-level movie, review
or audio product. The selected set replaces the previous delivered set; include an
earlier product again if the recipient still needs it. Do not add another copy of
final.mp4 or re-tar the handoff merely to provide a viewing entry.

### Edit a delivered still

On the author machine, start/reuse a workbench bound to the recorded delivery:

```bash
viscraft workbench <project-directory> --document <document-id> \
  --target <target-id> --delivery <entry>
```

`<entry>` is the recorded output entry to republish; a default delivery records it as
`handoff`. Give the user the Runtime-printed live URL plus the stable file in
`image/`.
Render preview saves the source and republishes that image, the index and manifest;
other products retain their bytes. Export image runs that same update and downloads
the current result. A save alone does not republish. The live URL
expires when the server closes; do not persist it or its token in the static page.
`--delivery` is an output entry name, never a filesystem path. An explicit external
handoff destination is unbound; a later caller does not get to overwrite it.

**Receiver setup differs from the author's reopen command.** Copy `project/` into
your own working directory. Confirm which matched Skill and Runtime the work
requires, then follow [Startup checks](preflight.md#locate-the-runtime-for-this-work):
reuse a matching shared installation, or prepare the matching package from a
supplied tgz or the installed Skill's receipt. Ask the sender for the required
release or matching package only when a suitable source cannot be identified or
obtained. Prepare a Project-local SDK dependency only when an author script needs
it, using the same startup instructions. Dependencies, credentials, endpoints and
authorizations do not travel automatically. A Runtime distribution stays separate
from Project authoring assets.

In the working copy, first open **without `--delivery`**:

```bash
viscraft workbench . --document <document-id> --target <target-id>
```

This entry saves/renders locally before any delivery exists. For a stable
published file, run `viscraft deliver .` with the desired products, then bind its
local `handoff` entry. Sender output records and sessions are intentionally absent.
Do not edit the delivered `project/` in place and then replace its containing
handoff: the replacement must never overwrite the source being edited. Nothing
syncs back to the sender. Verify continuation in an independent working copy when
testing handoff behavior, preserving the originals and paid Takes.

SDK `inspectImageDelivery(root, { delivery, target })` verifies the recorded entry,
identity and bytes. `updateImageDelivery(root, { delivery, target, build? })` publishes
a named Build or the newest succeeded image matching the saved source; it neither
renders nor submits. No matching Build means refusal without changing the delivery.

### Closure, replacement and sharing

Review what is still declared before handing over a full Project. Abandoned
Sources, registered Assets, bindings and helpers remain author state even when
not on the timeline. Keep meaningful alternatives and required sources; remove
unneeded declarations only after checking image resources, code, bindings and
playable uses. Do not delete original files, rewrite frozen Builds or discard
derivation parents and provider evidence to shrink a bundle.

The Project export includes required provider originals, sources, selected Take
lineage, handoff files, `.viscraft/pages/VISCRAFT.md` and
`.viscraft/pages/ATTRIBUTION.md`. Unknown files, scratch,
locks, dependencies, credentials and provider job/remote state are excluded.
Missing required media or rights fail; `--allow-non-redistributable` is explicit
and makes an unmistakably private, rights-unverified package, not a public license.
This applies to the whole Project carried even when only one product was selected.
Those restricted scopes describe the actual package. A workbench render republish
or in-place still update preserves that delivery's recorded scope. A new `deliver`
request, including replacement of the default handoff, uses its own explicit options
and is strict by default; it does not inherit an earlier restricted opt-in.
Where those rights come from — which use scopes an asset's license actually grants,
and the fields recorded on its `rights` — is
[Media acquisition](media-acquisition.md); delivery only enforces the recorded gate
and prints the attribution facts.

Every member is hash-verified and allowlisted. Editable author bytes are independent
writable copies; identical frozen products may share one read-only copy within the
bundle, never with source files. `bytes` counts distinct files by device/inode;
`logicalBytes` counts paths. A complete local handoff has no fixed size quota: the
Runtime reports the real bytes and enforces no ceiling of its own. Transport limits
are not production-quality targets. When a single-file or channel limit, or the
destination's free space, prevents one bundle, state that exact limitation and change
the transport — send the selected product files, move to a destination that can hold
the handoff, or deliver the Project as a `--part-size` archive, whose members declare
their sizes in the portable manifest (`--max-content` only raises the 4 GiB absolute
bound; it is not a target size) — rather than making the approved work smaller.

Preserve the approved pixels, audio and authored-input bytes. A per-frame sequence,
extracted still or other intermediate that a code or resource binding consumes is
real author input, not scratch, and packaging unchanged media does not require
regenerating the picture or its sound. Do not meet a channel limit with lossy
re-encoding, downscaling, dropped frames, trimmed audio or a rebuild around a byte
budget: those changes create a different production identity and may invalidate the
affected results, while the accepted result and its frozen lineage stay recoverable.
Reclaim space only through `usage`/`clean`, which protects the production closure
and offers Runtime-owned reconstructible or unreferenced bytes; never discard
provider originals, accepted results or a snapshot the selected production still
needs, and do not treat every preview or rebuildable Artifact alike.

A delivery encoding or lightweight variant is a legitimate product when that is what
the work or the requester asks for: author it as its own product or target, keep the
master and source as they are, and say which is which. This rule governs transport
and space, not the formats a piece may use ([Space](lifecycle.md#5-space-usage-and-clean)).

A repeated default delivery replaces only a recorded bundle whose manifest and
actual members still verify, under the publication lock and compare-and-swap
check. An unrecorded/modified destination is refused; choose a new destination or
review a `clean --include output/<entry>` plan. Old and new data are not merged.
`verify <bundle>` rechecks the manifest and files. `usage`, `status` and output
inspection locate recorded exports without guessing filenames; reclaim through
`clean`, never manual removal of production state.

For ordinary sharing, send the selected `movie/` or `image/` files. For continuation,
send the complete handoff. Uploading an entire handoff makes its source/material
available too; the recipient choosing a download does not restrict access to other
files. `deliver` and `archive` are generally alternatives for the same handover,
not two required copies. Inspection, decode and numerical reports are technical
evidence, never proof of watching, listening or artistic acceptance.
