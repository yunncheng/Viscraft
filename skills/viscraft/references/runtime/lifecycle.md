# Project lifecycle reference

The Runtime contract for seeing a work's current state and changing it safely:
`status`, `preview`, `versions`/`keep`/`revert`, `usage` and `clean`. These are the
commands a host agent runs around an **existing** Project. The *craft* decision (what
to keep, what to preview, what to hand over) lives in the Craft pages; packaging and
handoff are in [Delivery](delivery.md). Every command returns structured JSON, and
unless stated it is read-only: it creates no lock, record, cache entry or directory
and performs no network call or upload.

**Contents**

1. [Start with `status`](#1-start-with-status)
2. [Preview without touching the real timeline](#2-preview-without-touching-the-real-timeline)
3. [Reuse and the build cache](#3-reuse-and-the-build-cache)
4. [Versions: `versions`, `keep`, `revert`](#4-versions-versions-keep-revert)
5. [Space: `usage` and `clean`](#5-space-usage-and-clean)
6. [Protection rules and user decisions](#6-protection-rules-and-user-decisions)

## 1. Start with `status`

`viscraft status <project-directory>` (SDK `projectStatus`) is the ONE command to run
first in an existing Project; never infer state from directory names or history.
Read-only and zero-write, it reports from the real records:

- `current`: the active `.viscraft/result.json` build's result — `build`, `path`,
  `sha256`, whether its media is actually `available` (or `archived`), `simulated`,
  `frames`, `fps`, and `authoring: unchanged | changed | unknown` with `changes` (the
  same by-id diff `plan` shows) when the author moved on. `unknown` means the
  comparison cannot be verified — no readable/consistent frozen snapshot — never a
  silent `changed`. A declared authored file that cannot be read now is a recorded
  gap on both sides of the comparison, so it yields a real verdict rather than
  `unknown`;
- `stills`: the newest succeeded still for **each** declared image target —
  `target`, `document`, `build`, `artifact`, `path`, `width`, `height`, `format`,
  `simulated`, `available` (its file exists and hashes to the recorded `sha256`) and
  `stale` (`true` when the current document/resources/output settings no longer
  match the recorded render key). A still Build never becomes the film `current`
  and never overwrites the film result, so this list is how a still result stays
  visible; a target the Project no longer declares is history and drops out;
- `latestBuild`: the newest non-preview Build when it is NOT the current result
  (`status`/`error`/`stale`) — a newer failed or stale Build never hides a still
  valid current result;
- `previews`: preview Builds counted separately (`total`, `failed`, latest range);
- `running`: whether the build/author writer locks are held;
- `handoff`: each declared `project.handoff` file and whether it is `present`;
- `runtime`: where the running Runtime actually is — `name`, `version`, package `path`,
  the CLI `entry`, exported `sdkEntry`, and `inProject` (whether this Project's
  `node_modules` resolves to that Runtime, including a local link). A shared
  Runtime outside the Project is normal; this does not request installation;
- `git`: when the Project is inside a git work tree, a read-only count and the first few
  untracked/modified paths (`inRepo: false` with a reason otherwise) — informational only;
- `outputs`: Runtime-owned `output/` facts — a delivery whose selected movie or
  still Build is no longer current (`stale`), and entries the Runtime never recorded
  (`unrecorded`); reported, never deleted here. A recorded entry's `name` is the
  value `workbench --delivery <output-entry>` accepts when you keep that delivered
  still editable in place;
- `providerJobs`: pending / unknown-submission / succeeded / failed counts;
- `attention`: codes to act on before other writes — `revert-incomplete`,
  `cleanup-incomplete`, `archived-media`, `handoff-missing`, `unknown-submission`,
  `output-not-current`, `active-result-invalid` — plus `capture-diagnostics`, which
  is non-blocking: the current result's Build recorded browser capture diagnostics
  (canvas size/aspect, an unavailable font), and whether the result is acceptable
  stays your decision;
- `next`: the literal next steps for the observed state.

Route on that result. A `stills[]` entry with `stale: true` (or a requested still
change) → edit the document and re-run `viscraft image <project-directory> --target
<target>`; do **not** run the film `plan`/`build` path, which produces no still and
cannot stand in for one. An image-only Project has no `current` and needs no film
Build: delivering that still and keeping it editable in place is the image route
([Image direction](../craft/image-direction.md#editable-stills-the-image-route)) and
its published copy ([Delivery → edit a delivered still](delivery.md#edit-a-delivered-still)).
Otherwise: no `current` → `plan`, then
`build`; `authoring: changed` →
`plan`, `preview` the risky range, then `build`; `unchanged` → edit, deliver or
stop. `authoring: changed` compares the **whole author snapshot**, so a document or
unrelated author edit also marks a film result changed; it does not mean every film
Take must be remade — `plan`'s per-operation `changes`/reuse report decides, and an
unchanged Take (including a paid one) is reused. Run `viscraft usage` (below) for
the byte breakdown; `status` only points to it.

**Authored snapshots record available bytes plus explicit gaps.** A snapshot is
`{ files, unavailable }`, and `unavailable` is an array of
`{ path, reason, expectedSha256?, actualSha256, owners[] }` where `reason` is
`path-missing`, `unreadable`, `expansion-unavailable` or `hash-mismatch` (readable
bytes that disagree with the declared digest stay in `files` with their real digest).
Gaps are part of the snapshot identity, so a version with a gap never hashes the same
as a complete one. They are not damage: a declared file that was never readable is
recorded honestly, while a file that was frozen and later lost is damage and must
fail verification rather than be reclassified as a gap. `status`, `plan`, `versions`
and delivery all read this same array; a missing file that the current production
does not consume does not block an unrelated image or film result.

## 2. Preview without touching the real timeline

`viscraft preview <project-directory> (--frames <start>:<end> | --still <frame>)
[--scale <0.25-1>] [--config <run-options.mjs>]` (SDK `previewProject`) runs the real
Build pipeline over a range **without ever writing `project.json` or `result.json`**,
so the active timeline and result stay byte-identical.

- The range is output frames, `<start>:<end>` left-closed right-open, within the
  programme; `--still N` is the one-frame range `N:N+1` plus a PNG under
  `.viscraft/previews/<build-id>/frame-<N>.png` (a preview file, not an Artifact;
  promote it with `promote-frame` to use it as material).
- Only Placements/layers/audio/transitions that reach the range are produced or
  composed; the rest are same-length stand-ins, and the programme is cut to the range.
  Out-of-range Sources never execute, so a range that touches only cached or in-range
  work spends nothing.
- An in-range Source whose exact Operation key already exists (an existing valid Take,
  or a matching **succeeded** provider job) is **reused** as-is: the cache returns the
  verified artifact and a provider adapter restores the retained local media, so
  nothing is re-submitted.
- An in-range `provider` Source that has **no Take or succeeded job yet may perform its
  first generation**. That is a real POST, gated by the ordinary authorization the
  adapter owns (`authorization.submit` + per-Asset `uploadAssets`); a preview neither
  weakens nor duplicates that gate. `plan --frames`/`--scale` reports the same work
  read-only (zero submission) before the preview runs. A small preview does **not** ask
  the model for only that short range — a provider Source is produced over its full
  authored request, and only the composed programme is cut/scaled.
- `--scale < 1` is a proxy raster for **captured** Sources (`browser`/`blender`) only,
  under a different Operation key, so a proxy Take is **never** reused by a full Build.
  Provider Sources do **not** proxy (a real model is billed once and returns a real
  Take at full output); existing media and generated Takes are likewise produced at
  full output and only scaled when composed. With `--scale 1` a Source is produced over
  its full Placement interval on the same Operation key as a full Build, so a later
  full Build **reuses** it.
- `viscraft plan <project-directory> --frames <start>:<end> [--scale <s>]` predicts the
  same work read-only. Preview never lowers the spend gate: a billable generation
  still stops at `requiresApproval` unless already authorized.

A preview writes neither `project.json` nor `result.json` and adds no silently-degraded
fake picture for a Take the adapter refused. Use it for a representative passage
instead of editing the formal timeline to shorten it. See
[Review and repair](../craft/review-repair.md).

## 3. Reuse and the build cache

A Build is a set of **operations**, and each operation is keyed by the exact facts it
consumes: the frozen hashes of the authored files it reads, the Source's
`params`/`seed` (plus `frames` for a picture Source or `durationSamples`/`sampleRate`
for a sound Source), the output settings, the resolved bindings/World, the
provider configuration and the tool environment (Runtime, Node/platform, browser or
Blender version). Two runs that produce the same key reuse the recorded artifact and
spend nothing. Because the key covers what the operation actually reads, editing an
author file, changing a binding, sampling a different World state, changing a
provider configuration or upgrading a tool all become new work instead of a stale
hit.

What a change re-touches follows from that key. Editing one Source's parameters
re-renders that Source while unrelated Takes are reused; `compose-video` and
`mux-final` re-run only when their own input artifacts change. If an operation does
not read a fact, its artifact stays byte-identical, so a change's real scope is the
set of operations whose keys moved.

`plan` reports `reuse` versus `work` per Source, and any `pending` issue, before
anything runs — the read-only way to see what a Build would repeat. `preview`
actually runs the selected range and reports only how many operations it reused. `status`
answers a different question — whether the current result's snapshot still matches
the author tree — so `authoring: changed` does not mean every Take is stale; the
per-operation report decides. An accepted Take stays selected through a `take:`
placement even when its originating Source changes. §4 covers retaining and
returning to accepted results, §5 reclaiming bytes, §6 the decisions that are the
user's.

## 4. Versions: `versions`, `keep`, `revert`

A **version** is a succeeded, non-preview Build with a result. Its frozen author state
is the Build snapshot, whose bytes are stored once in `.viscraft/content/<sha256>`.
A still Build is a version of the same kind (its `result.frames` is `null` because it
has no programme, its `target` names the image target, and its Build id, result
artifact and document snapshot get the same `keep`/`revert` treatment); a sound Build
is also a version (its result is a WAV, its `target` names the sound target, and its
Takes carry `samples`/`sampleRate`/`channels` rather than frames). Each keeps its own
`current`, so a sound or still result never overwrites the film result. `current`/`stale` for a
still are computed from that target's own render key, never from the film's
`.viscraft/result.json`.

`viscraft versions <project-directory> [--all]` (SDK `listVersions`) lists versions
newest-first with `id`, `target` (`null` for a film version), `finishedAt`,
`revision`, `result` (`path`/`sha256`/`frames`/`simulated`/`available`/`archived`),
`stale`, `current`, `retained` and `changesFromPrevious` (the by-id diff counts
against the next older version **of the same target** — an image version and a film
version describe different outputs). `--all` adds failed and preview Build summaries
and checkpoints.

`viscraft keep <project-directory> <build-id> [--note <text>]` / `viscraft unkeep
<project-directory> <build-id>` (SDK `keepVersion`/`unkeepVersion`) write or clear the
minimal `retained: { at, note? }` decision on the Build record. It protects that
result, all its Takes (including candidates) and their production closure and snapshot
from `clean`. It **does not** turn the result into an Asset (use `promote-*`) and
never edits `project.json`. Keep on user approval and put the approved scope in
`--note`.

`viscraft revert <project-directory> <build-id|checkpoint-id>` (SDK `revertProject`)
puts the **author state** back to that snapshot. It is refused while a Build/preview is
running, a revert/cleanup is unfinished, or a provider job has an unresolved
submission. A target whose required authored bytes are not available is refused
before any write — it never restores a partial author tree and never claims a gap
version is fully restorable. It writes a checkpoint of the current state first
(`.viscraft/checkpoints/`), validates the whole target, stages and applies files with
`project.json` last, and never deletes a file the target does not list (`untouched`).
It never touches Build records, artifacts or `result.json`, so afterwards `status`
shows `authoring: changed` and the next `plan`/`build` decides reuse normally (no lost
accepted results, no mismatched artifact reuse, no repeated paid submission). After an
interruption, `status` reports `revert-incomplete` and other writes are refused:
`viscraft revert <project-directory> --resume` finishes it from the record, and
`viscraft revert <project-directory> --abort` restores the checkpoint. Either the Build
id or the checkpoint id reverts; reverting a checkpoint undoes the revert.

`versions` (and `inspect`, whose optional `[build-id]` selects one full Build record
instead of the Project summary and Build list) read these facts **live**
from `.viscraft/`. Query them again whenever you need a Build's current state, instead
of exporting a JSON copy into `review/` or the author area: an exported copy is a
snapshot that drifts from the record the Runtime actually acts on, and one more file
to keep in step. The record already lives in the Project, so a copy adds upkeep without
adding authority.

`inspect <project-directory>` (no id) also lists the recorded deliveries from
`.viscraft/deliveries/` — bundle, export, archive and playable — with their name, kind,
Build and manifest hash, so a completed archive or export is re-queried here instead of
from a saved JSON copy.

## 5. Space: `usage` and `clean`

`viscraft usage <project-directory>` (SDK `projectUsage`) is read-only and reports, per
category, THREE non-interchangeable byte measures:

- `logicalBytes` — summed file size per path (`du --apparent-size`);
- `uniqueContentBytes` — summed size of distinct sha256 within the category;
- `physicalBytes` — summed size of distinct `(dev, inode)`; a hardlinked inode is
  counted once, attributed to the strongest-reason category and recorded in
  `sharedWith`.

Only `physicalBytes` predicts reclamation: deleting one link of a still-linked file
frees 0 and is reported as 0. `reclaimablePhysicalBytes` (scratch, previews,
`rebuildable` artifacts, failed-Build snapshots) and `needsDecisionPhysicalBytes`
(`undetermined` artifacts and `output/` deliveries) are the decision surface;
`attention` flags unclassified files.

`viscraft clean <project-directory> [--include <output/name|build-id|artifact-id>]...
[--apply <plan-hash> | --resume | --abort | --release-archived <archive|name.parts.json>]`
(SDK `planClean`/`applyClean`/`resumeClean`/`abortClean`/`releaseArchived`). By default
it is a **dry-run plan**: it prints `planHash` plus each item
(`action`/`path`/`sha256`/`physicalBytes`/`reason`) and frees nothing. Apply only the
plan you reviewed: `--apply <planHash>` refuses when the plan changed since. `--include`
adds one delivery copy or the `undetermined` artifacts of an unprotected version.
Protected bytes (the production closure, provider evidence, records, author files,
Assets, handoff files, recordings and `review/`) are never planned. Prefer a plan over
ad-hoc `rm` — it keeps references and provenance.

`--release-archived <archive|name.parts.json> --include <id>` is the ONE way to free
**paid or irreplaceable** media, and only after a verified copy exists: the archive must
live outside the Project, `restoreProject` must reopen it as this Project, and each
named Artifact's bytes must appear in it (there is no "all"). It deletes only the media
bytes and marks the Artifact `archived`; records, snapshots and a receipt stay, and
`status` then says to restore before delivering or rebuilding. `viscraft restore-media
<project-directory> <archive|name.parts.json> [artifact-id]...` writes the bytes back and
clears the mark. Wrap an interrupted cleanup with `--resume` (re-judges every item) or
`--abort`; `--resume`/`--abort` never compare the old plan hash.

## 6. Protection rules and user decisions

- **Never `rm` outputs, artifacts or snapshots by hand.** Reclaim through `clean` (and
  `--release-archived`); those bytes are rebuildable caches, protected results and paid
  media under different rules, and only the records know which is which.
- **Paid or unknown-submission generated media is not a cache.** Never delete it by a
  retention rule; free it only through `--release-archived` after a verified outside
  archive. An `unknown-submission` job must be resolved before any new submit.
- **A retained version, the current result's closed lineage, Assets, author files,
  handoff files and `review/` are protected** and never enter a plain plan.
- **Preview instead of editing the real timeline**; `preview` limits the work to that
  range (an in-range, not-yet-produced provider Source can still generate once, gated
  by its normal authorization).
- **Prefer `versions`/`keep`/`revert` for versioning.** Copying the author tree each
  round (`author/v2`, `author/v3`) to "keep a version" creates a second source of truth
  that drifts from the real Project; the lifecycle commands already keep the real state
  and its scope.

Ask the user to decide item by item when the choice is not the agent's to make: which
Artifacts to `--release-archived` (a named list, never "all"), which `output/` delivery
to `--include` in a cleanup, and whether to abandon uncommitted work by `revert`.
Routine planning, previewing and releasing already-archived rebuildable bytes stay the
agent's call within existing authority.
