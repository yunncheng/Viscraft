# Media acquisition reference

Finding material on the web, choosing between it, code and generation, verifying a
specific asset's license, downloading the real bytes and admitting them to a Project.
This page covers selection and rights; the local copy/import mechanics are in
[Media preparation](media-preparation.md#2-import-approved-host-tool-material), and
the delivered provenance table is in [Delivery](delivery.md).

**Contents**

1. [Choose material, code or generation](#1-choose-material-code-or-generation)
2. [Verify a specific asset's license](#2-verify-a-specific-assets-license)
3. [Separate the four use scopes](#3-separate-the-four-use-scopes)
4. [Download and register](#4-download-and-register)
5. [Format boundaries](#5-format-boundaries)
6. [Record attribution on the Asset's rights record](#6-record-attribution-on-the-assets-rights-record)
7. [Call sketch and no-web-tools fallback](#7-call-sketch-and-no-web-tools-fallback)

The host Agent does the searching, browsing and downloading with whatever tools it
actually has. The Skill teaches selection and recording; the Runtime does local
import, validation, reuse and delivery. There is no search Provider, crawler or
in-Build auto-upload: do not install one to satisfy this page.

## 1. Choose material, code or generation

Pick per task, not by habit. Same decision shape as
[Media preparation](media-preparation.md):

- **Reuse a found asset** when a model, texture, image, recording or font fits the
  required Look and role under clear use rights. Import it and reference the stable
  Asset id. Both stylized and realistic material can be useful.
- **Author or control it in code** when forms, layout, motion or interaction need
  precise editing (see [Code visuals](../craft/code-visuals.md)). Code can animate
  an imported model or composite recorded/generated media; selecting code does not
  require creating all of its assets procedurally.
- **Generate material** when an available, authorized host tool or Provider is a
  suitable way to achieve the intended appearance or performance. Existing assets
  may be unavailable or unsuitable; generation is optional, not assumed available.

Search for the missing material's **role**, not only a finished image of the whole
work: a subject model, modular environment, surface maps, lighting environment,
ambience or isolated sound may supply just the part code or editing needs. Compare
the effort to adapt a candidate with authoring it, including style matching,
format conversion, dependencies and later edits. A long search or a large asset
collection is not a production goal; change route when the useful candidates do
not improve the result within the task's scope.

Before admitting found material, check against the brief: **Look** (matches the
Creative Direction, not a generic substitute), **identity** (the right subject, not a
look-alike), **resolution/handles** (enough resolution for its placement, enough loop
or head/tail headroom for the planned edit), and **editability** (what can actually be
changed later). A quality bar matters: a random web image, or a low-quality search
result, must not stand in for the refined image the work requires. For models,
inspect silhouette, close-up surface quality, actual topology/rig needs and the
texture dependencies; for real-time work consider draw cost and memory at useful
detail. A preview render does not establish the downloaded model's appearance in
this scene. Check the candidate in its intended use before expanding around it
([3-D integration](../craft/code-visuals.md#build-three-dimensional-subjects-and-environments)).
If nothing found clears the bar, authoring or generation is the better route.

## 2. Verify a specific asset's license

A license is a property of **one asset**, established from its own detail page, not
from search results. Do not treat a search snippet, a "free download" button, a
"royalty-free" badge, or a repository-root `LICENSE` file as that asset's grant to
reuse. Return to the **author/detail page** and the **applicable license page** (the
version that asset actually carries) and read them.

Record the asset's own facts **on the Asset's rights record** when you register it,
so they travel with the Project: `author`, `sourceUrl` (the detail page), `license`
name plus `licenseUrl` (the version that asset actually carries), any required
`notice` text, the `modifications` you made, and `attributionRequired` when the
license actually requires attribution. The asset title and the date obtained have
no dedicated field: keep them in `origin` free text and in ordinary project notes.
Prefer [CC0](https://creativecommons.org/publicdomain/zero/1.0/)
or public-domain material, or a license that clearly permits the intended use. When
you cannot confirm the terms, **switch to another source**; only escalate to the user
if no suitable alternative exists.

Keep two things separate: **reference images** inspected for direction are not
reusable Assets and are not imported as if they were; **reusable Assets** are the
ones you verify, download, hash and register.

Optional discovery leads, with their published asset-license scope:

| Source | Useful material and stated terms |
| --- | --- |
| [Poly Haven](https://polyhaven.com/license) | HDRIs, textures and models under CC0; the asset grant does not cover all other site content. |
| [ambientCG](https://docs.ambientcg.com/license/) | Downloadable assets and material preview renders under CC0. |
| [Kenney](https://kenney.nl/support) | Game assets on its asset pages under CC0; its studio logo is reserved. |

These are leads, not required dependencies or assurances of technical fit. Link
the actual asset and applicable terms in its record, and use the current format
boundaries below. For several assets under the same verified grant, reuse that
license evidence while retaining each asset's source. Do not infer terms for a
different site or a separately licensed item from these examples.

## 3. Separate the four use scopes

Judge each scope on its own; `redistributable: true` does **not** imply all four.
The four scopes are:

1. **Use in the finished film** (play the audio, show the image).
2. **Upload to a model service** as a reference or input (a second disclosure).
3. **Share the editable Project** (the bytes travel to a collaborator).
4. **Redistribute the source material itself**, standalone or in the bundle.

Establish the scopes the work actually needs. A permissive in-film license can still
forbid standalone source redistribution; that is why delivery defaults to
redistributable-only and needs an explicit opt-in to package private bytes
([Delivery](delivery.md#1-portable-export)).

Attribution must **travel with the actual delivery**, not just live in a scratch note:
CC BY needs author + license link + a change note; OFL fonts need the copyright and
license notice retained on redistribution. Ordinary clearly-licensed choices are the
Agent's own decision. Paid downloads, account-only assets, heavy downloads or extra
private transfers follow the host's normal authorization — do not build a per-asset
approval ceremony, and do not silently pull a paid or account-gated asset.

## 4. Download and register

1. **Download the real bytes** — the asset file, not the detail-page HTML or the
   thumbnail. Verify the file you got is the media you intended.
2. Keep it first in the Project's candidate location with a distinguishable name,
   as described in [Media preparation §2](media-preparation.md#2-import-approved-host-tool-material).
   Record its hash and where it came from.
3. **Unpacking or executing foreign code is a separate decision** from retaining an
   asset: a downloaded font/script/JSON is bytes until you choose otherwise. Never
   run fetched code to "clean up" an asset.
4. **Register through `importAsset`** with the absolute local path, then reference the
   returned stable Asset id in a declaration, Binding or Source. Do not depend on a
   temporary CDN or search link at final render time — the bytes must be in the
   Project.
5. **Retain and register external model/texture dependencies too.** A glTF with
   external textures is not done until each texture image is registered as its own
   `image` Asset input; never leave a dangling model whose textures only resolve over
   the network.

## 5. Format boundaries

Register only what the current import path actually accepts:

- **image** — PNG, JPEG, WebP
- **video** — MP4, MOV, WebM, MKV
- **audio** — WAV, MP3, AAC, M4A, FLAC, OGG
- **font** — TTF, OTF, WOFF, WOFF2
- **code** — HTML, JS, MJS, TS, SVG, JSON
- **model** — glTF 2.x only: `.glb` (self-contained) or `.gltf` (JSON; textures as
  registered `image` inputs, buffers embedded)

HDR/EXR, other 3D model formats and "web material collections" are **not** claimed as
supported. When a needed piece of work arrives in an unsupported format, do an
explicit **local conversion** first and record its provenance (source, tool, output
hash), then import the supported result. Only if the current path cannot reliably
carry the work should a targeted Runtime extension be considered — never a silent
alias or a fabricated format module.

## 6. Record attribution on the Asset's rights record

Attribution rides on the Asset's single `rights` record. Besides `origin`,
`license` and `redistributable`, that record structurally carries `author`,
`sourceUrl`, `licenseUrl`, `notice`, `modifications` and the author's
`attributionRequired` assertion — so a required notice, author or change note is
never left only in a chat or a scratch note.

Put a required notice in `notice` (a URL for the source/license goes in `sourceUrl`
/ `licenseUrl`). A **full license document** is not a rights field: `.txt`/`.md` are
not importable Asset types, and `.json`/`.html`/`.svg` are imported as `code`, not
as a license. When a full license text must travel in the Project, retain it as
an AuthorFile and declare it in `project.handoff` with `role: "license"`
([Author files](runtime-authoring.md#publish-a-recipe-through-the-one-authoring-boundary)).
Keep the complete original grant; do not register legal text as a code Asset or
paste it into `notice`.

`attributionRequired` is **your declaration** that the license requires attribution,
made after reading that asset's license. It is never inferred from the license name
or a search result. When you set it, you must also record a non-empty `notice`; the
pair is checked when a delivery is assembled. That is a completeness check on your
own declaration, not a rights judgement.

How the facts travel and where they are printed is
[Delivery → portable export](delivery.md#1-portable-export) and
[→ one complete handoff](delivery.md#3-one-complete-handoff).

Do not build a license-inference engine and do not add a second asset authority: the
Project's Asset registry stays the single source of truth, and a helper note is never
a parallel database.

## 7. Call sketch and no-web-tools fallback

The register step uses the ordinary import contract (see
[Media preparation §2](media-preparation.md#2-import-approved-host-tool-material) for
the full explanation):

```js
const project = await loadProject(root);
const found = await importAsset(root, {
  assetId: 'cc0_cloud_texture',
  sourcePath: '/absolute/path/to/candidates/cloud-4k.jpg', // the downloaded bytes
  type: 'image',
  rights: {
    origin: 'Cloud 4K — source.example/cloud (detail page, obtained 2026-10-11)',
    license: 'CC0 1.0',
    redistributable: true,
    author: 'Author Name',
    sourceUrl: 'https://source.example/cloud',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    notice: 'Cloud 4K by Author Name, dedicated to the public domain (CC0 1.0).',
    modifications: 'cropped to 2048x2048 and desaturated',
    attributionRequired: false
  },
  expectedRevision: project.revision,
  expectedSha256: downloadedSha256 // optional: verify the bytes you hashed
});
```

`sourcePath` must be an absolute, nonempty regular local file. Import preserves
the supplied bytes and complete parent-version relations without a fixed file or
parent-total size quota. Supported extensions, image signatures, hashes and a
bounded ffprobe/ffmpeg decode check still apply; a material admission is not a
transcode or a permission to lower the master quality.
Rights are caller-supplied free text — the import grants no rights and no aesthetic
approval. Every rights field other than `origin`/`license`/`redistributable` is
optional; supply the ones the asset's own license actually needs.

**If the host has no web tools**, state the limitation plainly and continue with the
material the user provided, existing local resources, or code/generation — do not
pretend material was found, and do not fabricate a source or license.
