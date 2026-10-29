# Runtime image workbench UI

Runtime-owned static resources, copied to `dist/src/workbench/ui/` by `npm run build`.
The server and still renderer resolve them inside the Runtime package; no host
Skill installation or author-project UI copy is required.

A local page for micro-adjusting one editable image document and delivering its
render. The author document is the design; this page adds what the upstream
layer editor did not have — real saves into the local author source, a conflict
protocol, render state and the output hand-off.

It supports micro-adjustments to the document's existing editable layers. The
host agent authors the design; the workbench handles local adjustments and saves.

`workbench.html`, `workbench.css` and `workbench.js` are product resources that
ship with the Runtime, not a per-project template. A creative agent
must not fork, restyle or rewrite this shell for a project: the project's freedom
lives in the author document (canvas, layers, type, resources), which this page
reads and saves. The fixed shell is what keeps the save queue, conflict protocol,
render, delivery and the layer view consistent across projects.

## Open it

The Runtime owns the server and prints the URL. The page is read from the same
mount as these assets:

```text
/workbench?document=<documentId>&token=<sessionToken>[&target=<targetId>]
```

- `document` (required) selects a registered `imageDocuments[]` entry.
- `token` authorises reads and writes. Without it the page refuses to load; the
  Runtime prints a URL that already includes it.
- `target` is optional. The page renders the `target` object returned by the
  Runtime; if the query asks for a different one it says so instead of guessing.

The optional **delivery binding** is a server-side option, not a query
credential: `viscraft workbench <project> --document <id> --target <id>
--delivery <output-entry>` (`WorkbenchOptions.delivery`) names a **recorded**
Runtime delivery under `output/` — never an arbitrary path. It is how a finished
hand-off stays editable: the page shows the stable delivered file and **Render
image** republishes that same entry. Without it the workbench is still a normal
authoring tool and touches no delivery. An unknown or unrecorded entry is refused
at boot with the real reason. A recorded bundle whose bytes/manifest later fail
verification still opens — so pending edits are not lost — but reports
`delivery.verified:false` with `delivery.blocked` naming the reason, and publication
and download refuse it instead of falling back to the Artifact.

The server must also serve `workbench.css`, `workbench.js` and `vendor/` from the
page's directory. The page resolves the vendor URLs against `document.baseURI`,
so the Runtime's `<base href="/workbench/">` mount works without hard-coded paths.

A document whose canvas is not editable still opens — as an honest preview that
can render the registered target, with saving disabled and the reason shown. It
never fakes an editor.

## Files

| File | Role |
| --- | --- |
| `workbench.html` | Shell: top bar, banners, iframe stage, output footer. |
| `workbench.css` | Shell chrome only. Nothing here reaches the saved source or the image. |
| `workbench.js` | Mount, resource URLs, layout record, edit watching, save queue, conflict, render, recovery, layer-view toggle. |
| `layout-record.js` | Shared read/gate/apply rules for the embedded layout record (also injected by the formal still capture). |
| `vendor/layer-editor.js` | Upstream editor, minimally adapted (see *Vendoring*). |
| `vendor/layer-editor.css` | Adapted editor chrome, isolated from the authored image. |
| `vendor/layer-editor.upstream.patch` | Complete unified diff against upstream. |

## Runtime contract

```text
GET  /api/document?document=<id>
  -> 200 { document:{id,path,revision,contentHash}, html, resources:[{path,url}],
           target:{id,logicalWidth,logicalHeight,width,height,scale,format,background},
           result:{build,target,artifact,path,width,height,format,background,
                   simulated,reused,stale,url}|null,
           delivery:{entry,path,build,artifact,format,width,height,sha256,bytes,
                     simulated,stale,verified,blocked}|null }

PUT  /api/document   X-Viscraft-Token: <token>
  body { document:<id>, baseRevision:<n>, baseContentHash:<sha256>, html:<string> }
  -> 200 { revision, contentHash, savedAt }
  -> 409 { error:'conflict', current:{revision,contentHash} }   stale base
  -> 409 { error:'busy', message }                              author lock held

POST /api/render     X-Viscraft-Token: <token>
  body { target:<id> }
  -> 200 { build, target, artifact, path, width, height, format, background,
           simulated, reused, stale, url, delivery:{...}|null }
  -> 409 { error:'conflict', message }   source changed during the render
  -> 500 { error:'publish-failed', message, result:{...}, delivery:{...}|null }
                                        render succeeded, delivered file unchanged
  -> 500 { error:<real message> }        production failure (not an unsaved source)

GET  /api/status?document=<id>
  -> { dirty:false, document:{revision,contentHash}, savedAt, result:{...}|null,
       delivery:{...}|null }
```

`delivery` is `null` unless the server was started with a verified `--delivery`
binding. When bound, a successful render publishes the exact Build it produced and
returns the new `delivery`; a `publish-failed` means the Artifact is still real and
downloadable but the delivered file was not replaced. If a later status/read sees
that the delivered file, record or manifest no longer verifies, `verified` becomes
`false`, `blocked` carries the real reason, and the page disables Render until the
bundle is delivered again — authoring and saving the source stay available. An
unbound render returns no `delivery` and never touches `output/`.

A conflicting save never writes. `busy` means another writer holds the Project's
author lock; the page keeps the edit, shows the lock message, and offers **Retry
save** — it is not a source conflict, and there is no automatic retry loop. Any
render failure other than a source conflict is surfaced with its real message.

`GET /api/output?target=<targetId>&token=<token>` is the download fallback used
when a result has no `url`. It should answer with the rendered image and an
attachment disposition. If the server adds `result.url`, that URL takes priority.
When a delivery is bound, it serves the **delivered** file after re-verifying the
record and hashing the bytes; it never silently falls back to the internal
Artifact, which would hide a broken or hand-edited delivery.

All API requests carry `X-Viscraft-Token` when the page has one, and
`cache: no-store`. The frame's subresource loads (`link`, `img`, CSS `url(...)`)
cannot send a header, so the page appends the session token to the `url` of each
declared resource in the preview. That rewrite exists only in the HTML handed to
the frame; a save writes the served source, which already carries the author's
own relative references, so there is nothing to restore.

## Save states

The pill in the top bar always distinguishes:

| State | Meaning |
| --- | --- |
| `clean` | No local edits. Nothing has been written by this page. |
| `pending` | Edits exist in the page and are not on disk yet. |
| `saving` | One `PUT` is in flight. |
| `saved` | The Runtime confirmed this page's edits (`Saved <time>`). |
| `failed` | The save did not land. Edits stay in the page; the banner offers **Retry save**. |
| `conflict` | The source changed under the page. Edits are kept and nothing is written until the user chooses. |

Autosave: an edit marks dirty, then a save runs after **800 ms idle**; during a
continuous burst a timer guarantees a save **at least every 3 s**. Edits never
write per pointer event, no revision is bumped without a change, and a save whose
serialized source equals the last confirmed source does **not** `PUT`.

All saves — automatic, manual, and the pre-render save — go through **one
serialized queue per document**. A response can never clear a newer dirty state:
every request snapshots a monotonic edit counter and only advances `savedSeq` to
that snapshot.

Manual save: the **Save** button and **Ctrl/Cmd+S** flush immediately through the
same queue. Ctrl/Cmd+S is handled twice on purpose — by the shell, and inside the
editor even while text is being edited (the editor commits the text first). There
is no `.edited.html` download path anywhere.

Text is saved while it is being typed: autosave serializes the live editor
document without ending the text session (no caret move, no undo entry). Text is
**committed** (endEdit + refit + one undo entry) by Enter, Escape, a pointerdown
elsewhere inside the author frame, the in-frame Ctrl/Cmd+S, and the outer
**Save** / **Render preview** buttons — the outer buttons force one committing save
even when a snapshot autosave already advanced the saved edit counter. There is
no blur/focusout commit.

## Conflict

A conflict is raised by `409 {error:'conflict'}` or by `/api/status` reporting a
different revision/contentHash while this page has unsaved edits. The page keeps
the DOM and the browser copy, and shows:

- **Reload source** — discards the page's edits after confirmation and loads the
  saved source (and its result) from the Runtime.
- **Overwrite source** — confirms, rebases `baseRevision`/`baseContentHash` on the
  current disk identity (fetched from `/api/status` if the 409 did not include it)
  and saves this page's version. The other session's changes are replaced.

No automatic three-way merge, OT or multi-user platform is implied. When the page
is clean and `/api/status` sees a change, it reloads the saved source instead.

## Delivery binding

`--delivery <output-entry>` binds the page to one recorded Runtime delivery
(`output/<name>`, recorded in `.viscraft/deliveries/<name>.json`). It is opt-in and
never inferred from a URL or a file path.

- The footer shows the stable delivered path for the bound target. The session URL
  is never written into that bundle's `index.html` or manifest.
- A successful **Render preview** republishes the same `image/<target>.<ext>`,
  `index.html` and `delivery-manifest.json` in the recorded entry. Same target and
  format keep the path; an explicitly changed format updates the managed entry to
  the real extension. It does not re-render or replace the bundle's other images,
  an included movie or an unrelated delivery.
- Publication happens only after the render succeeds and the entry still verifies
  as the recorded, unmodified Runtime delivery. A failure leaves the prior delivered
  files in place and shows the real error; the new Build/Artifact remains a normal
  version in the Project.
- Verification is re-checked. If the delivered file, record or manifest is later
  changed/replaced, `delivery.verified` becomes `false` and `blocked` names the
  reason; the page keeps the author source usable but disables Render until the
  bundle is delivered again. It never silently falls back to the internal Artifact.
- Autosave writes only the author source and never publishes.
- The bound entry lives on this machine. A receiver of a handoff
  opens `project/` in its own directory and starts a local workbench; a static
  `file://` copy cannot save or publish, and a dead session URL is never revived.

## Render, export and output

The top bar gives **Save changes** and **Export image** the primary positions.
**View layers** stays directly available in the top bar.
The canvas toolbar groups **Reset layout** and **Reset all edits** together,
beside **Undo last edit** (Ctrl/⌘ Z) and Zoom; shortcuts expand on demand.
The shell and editor share warm ivory panels, a sand-colored workspace and a
terracotta accent. These styles apply to editor chrome, selection and handles,
not the authored image.

**Export image** commits/saves the active edit, runs the normal render/publish
path and downloads the real output as `<target>.<format>`. The Runtime reuses a
current Build. Failed saves, renders, publication or downloads do not fall back
to an older image. If the design changes during export, the old result is marked
stale and no download starts. **Render preview** in the footer updates the result
without downloading it; **Last rendered image** retrieves the displayed earlier
result explicitly.

**Render preview** always saves first through the queue and never renders from the
live DOM. If the save fails or is in conflict, the render does not start and the
footer says why. If a conflict is detected during the render, the result is not
published as current.

Render states: `not-rendered`, `rendering`, `success`, `stale`, `failed`. The
footer shows the output dimensions/format, state, bound delivery path when present,
and a **Last rendered image** link; the internal Artifact path remains available
as its tooltip. A `simulated` result is marked as such. Editing during a render is allowed;
when the saved `contentHash` differs from the one the render started from, the
result is marked `stale`. Every status poll also consumes the result the Runtime
reports for that poll: its `stale` flag covers changes a document hash cannot see
(a declared stylesheet or image), and a new `build`/`artifact` identity replaces
the shown result instead of being assumed unchanged. A stale output stays
downloadable — it is real, just older. A status answer that was already in flight
when a save landed is discarded, so it can never fabricate a conflict or restore
an older editor state.

## Serialization

The page saves the served author source plus the editor's explicit edit state,
not a serialization of the executed preview DOM. `__layerEditor.editState()`
records changed text slots, font/style, layer offsets, explicit sizes, size locks
and removals in one inline
`<script type="application/json" data-viscraft-layout>` record (`version: 1`,
`sourceHash`; `savedAt` is not part of it, so an unchanged document produces
identical bytes). A manual save commits an active text edit; autosave snapshots
it without ending the session. An offset is measured from wherever the author's
layout puts that layer, not from a baked absolute position, so the record also
applies to a document that was never opened in the editor.
Author scripts, comments, hierarchy, body classes and relative resource strings
remain in the source. Injected editor nodes and token-bearing preview URLs never
become author code.

The layout record is applied only when the rest of the source is byte-identical
to what was saved (an FNV-1a change detector, not a security digest). This keeps
a document's own script from re-laying-out over the saved offsets on reopen,
while an Agent's edit to the source always wins over a stale browser record. The
read/gate/apply rules live in `layout-record.js`; the formal still capture
(`capture.ts`) injects the same file, so the preview and the produced PNG cannot
disagree about the effective text, fonts, deletions, sizes or offsets.

The editor may reparent nodes while operating, but that runtime arrangement is
not saved as the author hierarchy. Fonts and images are awaited before measuring;
a broken image does not block the editor.

## Resources

`resources[]` is rewritten in the preview for `src`, `href`, `poster`,
`xlink:href`, `srcset`, inline `style` and `<style>` blocks (`url(...)`). Preview
URLs also carry the session token, because a browser resource request cannot
send the `X-Viscraft-Token` header. The save keeps the original author source,
so its portable relative references never become token-bearing preview URLs.
Limits:

- Declarations are Project-relative; markup and inline CSS URLs resolve relative
  to the author document, as in formal capture. For `author/poster.html`,
  `../assets/a.png` resolves to the declared `assets/a.png`. URL-encoded names,
  queries and SVG fragments are preserved. SVG `image` and `use` support both
  modern `href` and namespaced `xlink:href`; normal anchors remain navigation.
- A local reference that does not resolve to a declared resource is **never
  rewritten**. The page lists it in
  a notice and the saved source keeps the original string, so an undeclared input
  is visible instead of failing silently or being repointed.
- Runtime `fetch()` calls inside author scripts are not rewritten — reference
  render-time media from markup/CSS. This workbench targets fixed-canvas designs,
  not scripted asset loaders.
- External stylesheets receive authorized URLs for declared `url(...)` and
  `@import` dependencies, resolved relative to the stylesheet. The original CSS
  bytes on disk stay unchanged. A bare `@import "file.css"` inside an inline
  `<style>` is not rewritten; use a declared stylesheet link or `url(...)`.

Editor font stacks apply to editor chrome, not `body.hf-on`: changing the body's
font would alter author text that inherits its typography, even after a web font
loaded successfully. The preview preserves that author inheritance.

## What can be edited

Only the upstream subset is exposed and every hint in the UI maps to it: select,
drag, 8-handle resize, arrow-key nudge (1px / Shift 10px), snapping (Alt
disables), double-click plain-text edit, proportional font-size steps, switching
among the document's font faces, used stacks, font variables and generic system
families, delete, undo, reset, zoom. System-family appearance depends on the
rendering device; portable named fonts belong in the Project resources. Dragging,
resizing and Reset layout participate in undo. Text/font undo also restores the
previous text box, rather than leaving an auto-expanded width behind.

**Reset layout** restores the positions, sizes and size locks measured when this
editing session opened; it keeps text, font and deletion changes. **Reset all
edits** restores the complete saved design loaded at that same opening, including
workbench adjustments already present then. It discards only edits made in this
session, even if they have since been autosaved, manually saved or exported.
It asks for confirmation and offers **Undo reset** until the next edit. Neither
reset nor Undo reset advances the opening baseline. Updating a delivered PNG
remains a separate Render preview or Export image operation.

The rollback boundary is the **browser editing session**. Save and Export keep
the current Undo stack and opening baseline. Refreshing, reopening the page or
loading a new saved source clears the old stack and uses the loaded saved design
as the new baseline. The opening baseline is held in memory, not a permanent
original-version file. Autosave continuously writes the current author document;
there is no final overwrite or extra commit on page close. Wait for **Saved**
before leaving; failed or pending saves are not durable just because the page
closes. Browser recovery is an explicit aid for interrupted edits, not an older
session's Undo stack.

The local service is a separate lifetime: closing a browser tab does not stop it,
and it has no idle shutdown or binding to a host Agent conversation. It runs until
its process stops (for example Ctrl+C). A host may stop child processes when its
session exits. The Agent can reuse a live URL or start the workbench again on the
same Project and return a new token-bearing URL; neither action discards saved
work. A restarted service does not revive old browser Undo history.

The save indicator compares the current edit content with the disk-confirmed
content. Undoing to the saved state cancels a pending no-op save. If the edit was
already autosaved, undo is a new change to persist. An in-flight response cannot
mark newer content saved; the current content is checked again after completion.

Not supported, and not claimed: adding layers, importing images, reordering the
stack, rotation, recolour, or semantic layer splitting. Those remain Agent work
on the author source.

The explode/layer-gallery code is upstream and stays in the vendored file; the
in-editor control is hidden, and the fixed shell exposes the same view as **View
layers** (next section). It is a read-only overview of this canvas, not a
separate layer-display page.

## Layer view

The fixed shell has one **View layers** button (`#wb-explode`) in the top bar,
next to **Save**. It toggles to **Back to editing** and reuses the vendored
upstream clone gallery (`setExploded`): an overview of the current canvas, its
background/base and its first-level content modules, with the upstream scan,
spread and collapse motion. The inner editor toolbar control stays hidden. There
is no separate `layers.html`, no Replay viewer and no PPTX export. The button is
disabled when the document exposes no layer units; a read-only preview has no
editor and therefore no view.

- It presents the live editable canvas — including pending edits — and is not a
  saved artefact, Build or delivery. The gallery clones are read-only: no save,
  no revision bump, no Build and no publication, and the gallery is never
  serialized, captured or delivered.
- Opening it commits an in-progress text edit (the same commit as clicking
  elsewhere); if that produced changes, they follow the ordinary save queue. The
  view itself schedules no save, render or publication.
- Selection, dragging and resizing are suspended while viewing; undo and reset
  stay disabled. **Back to editing** returns (Escape does too while the frame
  has focus). Choosing a layer card or a layer-panel row returns to editing and
  selects that layer (upstream behaviour).
- **Save**, autosave and **Render preview** keep acting on the author canvas,
  never on the gallery clones. Leaving the view is not a save.
- A document with one content layer — for example a flat final image — shows
  exactly that one layer plus the overview/background presentation. The view
  never recovers text, splits objects or invents layers.
- It stays available when a bound delivery cannot be verified
  (`delivery.verified:false`): viewing is not publishing, so **Render preview**
  stays disabled while the view remains usable. The same session token,
  same-origin and loopback rules apply; the button adds no access of its own.

## Vendoring

- Upstream: `yejy53/Editable-Design`, commit
  `c87b16f6d7c198e2b6967f13f1b1baa939d6f31f`, Apache-2.0 (see the upstream
  `LICENSE` and `THIRD_PARTY_NOTICES.md`). The editor is the author's own code;
  Viscraft reuses it under Apache-2.0 with attribution.
- `vendor/layer-editor.css` scopes typography to editor chrome, preserves authored
  canvas fonts and adapts the warm palette, layer panel and grouped reset controls.
- `vendor/layer-editor.js` is a minimal adaptation; the complete diff is
  `vendor/layer-editor.upstream.patch`. Changes, all deliberate:
  1. Attribution/scope header; English comments on touched constants.
  2. English user-visible strings (toolbar, panel, hints, toasts, font option,
     layer-view labels). Upstream comments are left as-is so the diff stays
     reviewable.
  3. Removed the localStorage draft subsystem (`DRAFT_KEY`, snapshot/save/load/
     apply, draft bar, "discard draft"): a browser draft must not be a second
     author authority. `touch()` now notifies the host workbench, which owns
     recovery and the real save.
  4. Toolbar: removed Download HTML / Download exploded / Copy position CSS;
     hid the in-editor Explode control (the fixed shell exposes the same view as
     **View layers**; see *Layer view*). Save is the workbench's job. Zoom, Undo
     and Reset stay.
  5. Removed the download/modal/clipboard code paths, so no edited HTML can be
     downloaded by accident.
  6. Ctrl/Cmd+S asks the host to save (including while editing text), instead of
     downloading.
  7. The live-DOM export is gone: `fullHTML()`, `snapshotHTML()` and `exportHTML`
     were removed. `editState({ commit })` reports only what the user changed
     (offsets, sizes, locks, text slots, slot fonts, removals) so the host can
     save the author's own HTML plus one record; `commit: true` ends the text
     session and includes its refit, `false` reports the live text without moving
     the caret.
  8. `window.__layerEditor` no longer exposes `snapshot`/`download`/
     `downloadExploded`/`fullHTML`/`snapshotHTML`; it adds `editState()` and keeps
     `isEditing()`.
  9. The layer-view code keeps working when the shell calls `setExploded`. The
     removed in-editor controls stay removed; the retained `#hf-explode` element
     stays `hidden`, and `syncExplodedUI` still updates its label/disabled state
     normally. The shell follows the view through the new
     `__viscraftWorkbench.viewChanged` hook, and selection, card/panel exits and
     undo are guarded while the board is up or a transition is running, so a
     hidden layer cannot be mutated.

## Verify

```bash
node --check workbench.js
node --check layout-record.js
node --check vendor/layer-editor.js
sha256sum vendor/layer-editor.css
```

The page writes nothing itself; it has no build step and no dependency.

## Limits that need the server or a real browser

- Rendering and output are the Runtime's. This page cannot produce a PNG without
  `POST /api/render`; `simulated` results are shown as simulated.
- The download link needs `GET /api/output` (or `result.url`).
- A static `file://` copy cannot save; it needs the local Runtime.
- Author scripts that re-layout asynchronously AFTER the page settles (a timer or
  a later `load` callback) are outside what this page can freeze; the saved
  record is applied once, immediately after the document loads.
- The visual result of the editor is the upstream editor's, not a new design
  capability; artistic approval is separate from a successful save/render.
