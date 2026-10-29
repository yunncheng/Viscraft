# Contributing to Viscraft

Viscraft combines host-agent creative guidance with a TypeScript execution
Runtime. Start with [README.md](README.md); user-facing guidance and complete
editable references live under [skills/viscraft](skills/viscraft/SKILL.md).

## Development

Use Node.js 22 or newer and npm. Install FFmpeg/FFprobe and Chrome for the media
tests. Browser auto-discovery currently covers Linux system paths and Linux
Chrome builds in the Puppeteer cache. On other hosts, or for a custom install,
set `VISCRAFT_BROWSER` to the browser executable's absolute path. Blender and external
generation services are optional capabilities, not prerequisites for the normal
test suite.

```sh
npm ci --ignore-scripts
npm run build
npm run lint
npm test
npm run test:e2e
```

For workflow changes, validate `.github/workflows/` with
[actionlint](https://github.com/rhysd/actionlint). TypeScript checks do not validate
GitHub Actions expressions.

Build and prepack replace `dist/`; run them sequentially. Tests use local
fixtures and mock services, a temporary configuration directory and no inherited
image/video endpoint environment. The same Node-based runner is used for release
validation. Keep real provider credentials and actual generation
outside automated tests. Never treat simulated output as real generation.

The [fixture overview](tests/fixtures/README.md) maps fixed inputs and authoring
programs to their consuming tests and maintenance invariants.

Tests should protect observable Runtime, CLI, Skill or distribution contracts.
Use a concrete failing input and an independent expected result; keep valid
baselines when testing rejection. Prefer shared fixtures over a new example for
each regression. Validate fixture inputs when the integration test needs that
assurance; avoid separate suites that only pin a fixture's private algorithms
or artistic choices. Tie prose checks to documented contracts rather than exact
editorial wording. Preserve checks for source rights,
resource closure, real output, edits and recovery in shipped references.
Run the same contracts on Linux, Windows and macOS; report unavailable optional
tools or platform privileges as explicit skips, never as passes.

After building, use `node dist/src/cli.js --version` and
`node dist/src/cli.js doctor` to inspect that checkout. Install its
`skills/viscraft` directory through your host's normal Skill installer. Start
creative work in a separate workspace and give the host the actual built Runtime
entry when needed; keep the work outside this contributor checkout.

The code and Skill use one current v1 contract. Update schemas, callers, guidance
and tests together. Keep Project authoring state, production records and outputs
distinct; preserve original media and accepted outputs during edits. The host
agent owns creative decisions and perceptual review. Runtime measurements do not
establish artistic quality.

Keep third-party notices, original licences and per-asset rights statements with
adopted files. The root Apache-2.0 licence does not replace separately stated
font, code-study or example-media terms.

## Contribute provider support

Project-owned model definitions and mappings can use an implemented protocol
without changing the Runtime; see the [extension contract](skills/viscraft/references/providers/model-integration.md).
For packaged support, update the definition, service mapping and focused guide
under `skills/viscraft/references/providers/models/` together, and route the guide
from `model-guides.md`. A new HTTP/task protocol also needs a transport adapter.

Keep primary documentation and source attribution with the integration. Test
request validation, zero submissions for invalid inputs, reference order,
decoded output and recovery without duplicate submission. Use local mock services
for automated checks; report live capability separately when authorized.

## Contribute a complete creative case

Create and revise the work in a separate workspace using the installed Skill.
Share a finished, reviewed handoff that another agent can continue, with the
author's permission to distribute the included code and media. A technical test
or an unreviewed model candidate is not a complete creative case.

Curated cases live under `skills/viscraft/assets/projects/<case-name>/`: put the
current film/image in `movie/` or `image/`, the editable Project and its required
inputs in `project/`, and useful review/repair evidence in `review/`. Keep the
case's README, licences, source provenance and observation limits together. The
examples already there show the format. Include actual source media needed to
rebuild, full font/sample licences and the final generation prompts when useful;
leave out credentials, private endpoint settings and production caches. Keep one
current viewing edition unless another edition has a clear creative purpose.

Contribute original code and case media under Apache-2.0. Retain the original
licences and notices for any third-party material; do not assign new terms to
someone else's artwork, fonts or recordings. A reference's licence does not
automatically set the licence of a user's entire new work.

Copy the case to a fresh folder and verify that the included Project opens and
rebuilds without the original workspace. Reference selected generated footage as
ordinary Assets so reproduction needs no private provider account. Note separately
which creative changes would require new authorized generation. Update
`skills/viscraft/references/reference-map.md` for a selected case; do not turn its
technique, style or tools into a mandatory workflow.

## Prepare a release

Maintainers additionally need Git and Python 3 (standard-library ZIP packaging).
Configure a Git author name/email, then choose a new output directory:

```sh
node scripts/prepare-release.mjs --output /absolute/path/to/new-release
```

The command exports a separate product checkout, installs its locked
dependencies, builds, lints and runs both test suites. It then creates one local
initial commit and annotated version tag, and produces an ordinary product-source
ZIP plus the independent Runtime tgz, with standard SHA-256 checksums beside the
attachments. Skill examples/media appear once in the ZIP. The Runtime includes
executable code and required UI assets only. The command never creates a remote, pushes,
uploads or calls a model. Existing output directories are refused.

The repository declared in `package.json` is `yunncheng/Viscraft`. Release
preparation generates `skills/viscraft/runtime.json` with the Runtime asset's
SHA-256, installed-content fingerprint and exact Release download URL. For a fork, `--repository OWNER/REPO`
overrides that destination. Use the validated exported files to prepare the
repository's release commit and tag, preserving any existing remote history.
Upload the generated Runtime tgz at the exact tag and filename recorded in the
receipt. The source ZIP is convenient for sharing the product files;
it contains the same Skill and matching tgz, with no separate installer or setup
instructions. The metadata identifies the download;
preparing a release never proves the URL is live.

The exported source and installed Skill include `runtime.json`, generated from
the Runtime actually packed for that release. Release preparation replaces any
previous receipt rather than reusing its checksum. Before publishing,
verify the README's two installation entry points (the Skills CLI command and
the agent installation prompt) against the actual remote repository and uploaded
Runtime asset. Confirm that the downloaded bytes match the receipt. Do not publish repository-name
placeholders as commands or claim an npm channel that does not exist.

`source/` contains the validated public files; `assets/` contains the release attachments;
`RELEASE_NOTES.md` supplies the draft description. `validation/` retains local
logs and is not uploaded. The source export excludes private configuration,
research checkouts, developer plans, active production directories and build
caches. Complete curated Skill references stay included.

Before uploading, verify `SHA256SUMS` beside the attachments and extract the source
archive into a different directory. Install its Skill through the host's normal
mechanism and install the verified tgz into an isolated user-level npm prefix,
after checking it against `skills/viscraft/runtime.json`. From two independent
work directories, verify the same executable runs without reinstalling. Check a
real SDK import through a local npm link when needed, then exercise an
author/edit/deliver passage and receiver setup using the shared Runtime. Preserve any environment limitations and distinguish
local engineering checks from GitHub CI, real-provider and artistic acceptance.
