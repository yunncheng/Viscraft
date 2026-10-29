/**
 * handoff: the receiver-facing files a Portable export carries.
 *
 *  - Declared handoff files (`project.handoff`: README/NOTES/attribution/licence/
 *    helper) are checked in full at export: a regular in-project file, UTF-8 for
 *    text roles. Local absolute paths are WARNINGS (the receiver cannot use
 *    them); credential-looking strings are ERRORS (never shipped).
 *  - `VISCRAFT.md` is a fact page RENDERED from the records (current result,
 *    retained versions, Sources, required capabilities, start commands). It is
 *    not an authority; intent and approvals live in the author's `notes` file.
 *  - `ATTRIBUTION.md` is rendered from Asset `rights` with the same cells the
 *    Delivery `index.html` Assets table uses, so the two cannot disagree. An
 *    author's own `attribution` handoff file is carried alongside it.
 */
import { lstat, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Asset, BuildRecord, HandoffFile, Project, Source } from '../../core/schema.js';
import { resolvedCredentialValues } from '../../config/credentials.js';
import { resolveProjectPath } from '../../shared/fs.js';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
const TEXT_ROLES = new Set<HandoffFile['role']>(['readme', 'notes', 'attribution', 'license']);

export interface CheckedHandoffFile extends HandoffFile {
  sha256: string;
  bytes: number;
}

export interface HandoffCheck {
  files: CheckedHandoffFile[];
  warnings: string[];
}

const CREDENTIAL_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b(?:api[_-]?key|secret|token|password)\s*[=:]\s*["']?[A-Za-z0-9_\-./+]{12,}/i,
  /\bbearer\s+[A-Za-z0-9_\-.]{16,}/i,
];

export async function scanHandoffFile(
  absolute: string,
  localPaths: readonly string[],
): Promise<{ sha256: string; bytes: number; utf8: boolean; credential: boolean; localPaths: string[] }> {
  const secrets = [...resolvedCredentialValues()].filter(value => value.length >= 8);
  const overlap = Math.max(128, ...secrets.map(value => value.length), ...localPaths.map(value => value.length));
  const hash = createHash('sha256');
  const decoder = new TextDecoder('utf-8');
  const validator = new TextDecoder('utf-8', { fatal: true });
  let utf8 = true;
  let bytes = 0;
  let tail = '';
  let patternTail = '';
  let credential = false;
  const mentioned = new Set<string>();
  const scan = (text: string): void => {
    const window = tail + text;
    if (secrets.some(secret => window.includes(secret))) credential = true;
    for (const local of localPaths) if (window.includes(local)) mentioned.add(local);
    // Keep an assignment across arbitrarily long whitespace without buffering it.
    const patterns = patternTail + text.replace(/\s+/g, ' ');
    if (CREDENTIAL_PATTERNS.some(pattern => pattern.test(patterns))) credential = true;
    patternTail = patterns.replace(/\s+/g, ' ').slice(-128);
    tail = window.slice(-overlap);
  };
  for await (const chunk of createReadStream(absolute)) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    hash.update(buffer);
    if (utf8) {
      try {
        validator.decode(buffer, { stream: true });
      } catch {
        utf8 = false;
      }
    }
    scan(decoder.decode(buffer, { stream: true }));
  }
  if (utf8) {
    try {
      validator.decode();
    } catch {
      utf8 = false;
    }
  }
  scan(decoder.decode());
  return { sha256: hash.digest('hex'), bytes, utf8, credential, localPaths: [...mentioned] };
}

/** Check every declared handoff file; throws on a missing/invalid file or a credential. */
export async function checkHandoff(root: string, project: Project): Promise<HandoffCheck> {
  const files: CheckedHandoffFile[] = [];
  const warnings: string[] = [];
  const localPaths = [
    await realpath(root),
    os.homedir(),
    fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, ''),
  ].filter(value => value.length > 1);
  for (const declared of project.handoff ?? []) {
    const absolute = await resolveProjectPath(root, declared.path);
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error(`Handoff file ${declared.path} (${declared.role}) is declared but missing`);
      throw error;
    }
    if (!info.isFile()) throw new Error(`Handoff file ${declared.path} is not a regular file`);
    const scanned = await scanHandoffFile(absolute, localPaths);
    if (!scanned.utf8 && TEXT_ROLES.has(declared.role))
      throw new Error(`Handoff file ${declared.path} (${declared.role}) must be UTF-8 text`);
    if (scanned.credential)
      throw new Error(
        `Handoff file ${declared.path} contains a credential-looking value; remove it (credentials never travel with a Project)`,
      );
    for (const local of scanned.localPaths)
      warnings.push(
        `Handoff file ${declared.path} mentions the local absolute path ${local}; the receiver will not have it`,
      );
    files.push({ ...declared, sha256: scanned.sha256, bytes: scanned.bytes });
  }
  return { files, warnings };
}

// ---------------------------------------------------------------------------
// Attribution (shared with the Delivery index.html Assets table)
// ---------------------------------------------------------------------------

export const ATTRIBUTION_HEADERS = [
  'Origin',
  'License',
  'Author',
  'Source',
  'License link',
  'Notice',
  'Modifications',
] as const;

/** The attribution cells of one Asset, in `ATTRIBUTION_HEADERS` order. */
export function attributionCells(asset: Pick<Asset, 'rights'>): string[] {
  const rights = asset.rights;
  return [
    rights.origin,
    rights.license,
    rights.author ?? '',
    rights.sourceUrl ?? '',
    rights.licenseUrl ?? '',
    rights.notice ?? '',
    rights.modifications ?? '',
  ];
}

const mdCell = (value: string): string => value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** `ATTRIBUTION.md` for the Assets of a Project, or null when there are none. */
export function renderAttribution(project: Project): string | null {
  if (project.assets.length === 0) return null;
  const header = ['Asset', 'Path', ...ATTRIBUTION_HEADERS];
  const lines = [
    `# Attribution — ${project.title}`,
    '',
    'Rendered by the Viscraft Runtime from each Asset `rights` record in `project.json` (the authority). These are the facts the author recorded; the Runtime makes no licence judgement.',
    '',
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...project.assets.map(asset => `| ${[asset.id, asset.path, ...attributionCells(asset)].map(mdCell).join(' | ')} |`),
    '',
  ];
  const required = project.assets.filter(asset => asset.rights.attributionRequired === true);
  if (required.length > 0)
    lines.push(
      `Attribution is required for: ${required.map(asset => asset.id).join(', ')}. Follow the recorded licence conditions; this summary does not replace the carried licence texts.`,
      '',
    );
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// VISCRAFT.md fact page
// ---------------------------------------------------------------------------

async function runtimeVersion(): Promise<string> {
  try {
    const metadata = JSON.parse(
      await readFile(fileURLToPath(new URL('../../../../package.json', import.meta.url)), 'utf8'),
    ) as { name?: string; version?: string };
    return `${metadata.name ?? 'viscraft-runtime'} ${metadata.version ?? 'unknown'}`;
  } catch {
    return 'viscraft-runtime (version unknown)';
  }
}

function capability(source: Source): string {
  switch (source.kind) {
    case 'browser':
      return 'Browser (Chrome/Chromium for capture)';
    case 'blender':
      return 'Blender (bpy) for `blender` Sources';
    case 'provider':
      return `Video provider endpoint \`${source.endpoint}\` (model \`${source.model}\`) — only to produce NEW Takes`;
    default:
      return 'FFmpeg';
  }
}

export interface FactPageInput {
  project: Project;
  builds: BuildRecord[];
  activeBuild: string | null;
  handoff: CheckedHandoffFile[];
  attribution: boolean;
}

/** Render `VISCRAFT.md` from the packaged records. */
export async function renderFactPage(input: FactPageInput): Promise<string> {
  const { project, builds, activeBuild, handoff } = input;
  const version = await runtimeVersion();
  const active = builds.find(build => build.id === activeBuild);
  const result = active?.artifacts.find(artifact => artifact.id === active.result?.artifact);
  const retained = builds.filter(build => build.retained);
  // A Project with no composition produces stills, not a programme: the fact
  // page must not tell the receiver to run `build` (it would refuse) or claim
  // FFmpeg is required for a Browser still.
  const film = project.composition !== undefined;
  const capabilities = [
    ...new Set([
      ...(film || project.soundTargets.length > 0 ? ['FFmpeg'] : []),
      ...(project.imageTargets.length > 0 ? ['Browser (Chrome/Chromium for still capture)'] : []),
      ...project.sources.map(capability),
    ]),
  ];
  const stills = new Map<string, string>();
  for (const build of [...builds].sort((a, b) => b.startedAt.localeCompare(a.startedAt))) {
    if (build.status !== 'succeeded' || !build.target || stills.has(build.target)) continue;
    if (!project.imageTargets.some(target => target.id === build.target)) continue;
    const artifact = build.artifacts.find(candidate => candidate.id === build.result?.artifact && candidate.image);
    if (artifact?.image)
      stills.set(
        build.target,
        `- Packaged still target \`${build.target}\`: Build \`${build.id}\` → \`${artifact.path}\` (${artifact.image.width}×${artifact.image.height} ${artifact.image.format})`,
      );
  }
  const lines = [
    `# ${project.title} — Viscraft project`,
    '',
    `Rendered by ${version} from this Project's records when it was exported. This page is a summary, not an authority: \`project.json\` and \`.viscraft/\` records are. Intent, approvals and open work live in the author's notes file${handoff.some(file => file.role === 'notes') ? '' : ' (none declared)'}.`,
    '',
    '## Packaged results',
    '',
    'These files describe the recorded Builds, not necessarily the latest author state. Run `viscraft status .` to check current availability and stale targets before reusing them.',
    '',
    ...(result && active
      ? [
          `- Build \`${active.id}\` → \`${result.path}\` (${result.media?.frames ?? '?'} frames${result.simulated ? ', **simulated/test-only**' : ''})`,
        ]
      : film
        ? ['- No current result is packaged; run the commands below to build one.']
        : []),
    ...stills.values(),
    ...builds
      .filter(build => build.medium === 'sound' && build.result)
      .map(build => {
        const artifact = build.artifacts.find(candidate => candidate.id === build.result?.artifact);
        return `- Packaged sound target \`${build.target}\`: Build \`${build.id}\` → \`${artifact?.path ?? 'missing Artifact'}\``;
      }),
    ...(!film && stills.size === 0 && project.soundTargets.length === 0
      ? ['- No rendered output is packaged; declare and build a target first.']
      : []),
    '',
    '## Retained versions',
    '',
    ...(retained.length > 0
      ? retained.map(build => `- \`${build.id}\`${build.retained?.note ? ` — ${build.retained.note}` : ''}`)
      : ['- None packaged.']),
    '',
    '`viscraft versions` lists only the Builds carried in this package (the current result and its lineage); earlier history stayed with the sender.',
    '',
    '## Sources',
    '',
    '| Source | Kind |',
    '| --- | --- |',
    ...project.sources.map(source => `| ${source.id} | ${source.kind} |`),
    '',
    ...(project.imageTargets.length > 0
      ? [
          '## Image targets',
          '',
          '| Target | Output pixels | Document |',
          '| --- | --- | --- |',
          ...project.imageTargets.map(
            target =>
              `| \`${target.id}\` | ${target.width * target.scale}×${target.height * target.scale} | \`${target.document}\` |`,
          ),
          '',
        ]
      : []),
    '## Required capabilities',
    '',
    ...capabilities.map(item => `- ${item}`),
    '',
    'Provider credentials never travel with a Project. Configure your own in your terminal (`viscraft auth status`, `viscraft auth set <NAME>`); reusing the packaged Takes needs no provider.',
    '',
    '## Handoff files',
    '',
    ...(handoff.length > 0 ? handoff.map(file => `- \`${file.path}\` (${file.role})`) : ['- None declared.']),
    ...(input.attribution ? ['- `.viscraft/pages/ATTRIBUTION.md` (rendered from Asset rights)'] : []),
    '',
    '## Start here',
    '',
    `Have the host install the matching Skill and authorized Runtime (\`${version}\`). Use the actual supplied package, not a guessed public URL. Run \`viscraft doctor\` to verify the real installation, then from this Project directory:`,
    '',
    "For a local npm install, first check for this directory's own `package.json`; if absent, run `npm init -y` here so npm does not select a parent package. Installed dependencies are not included in this export.",
    '',
    '```sh',
    'viscraft status .',
    ...(film ? ['viscraft plan .', 'viscraft build .'] : []),
    ...project.soundTargets.flatMap(target => [
      `viscraft plan . --target ${target.id}`,
      `viscraft build . --target ${target.id}`,
      `viscraft deliver . --sound ${target.id}`,
    ]),
    // A Project may hold both a programme and still targets; the still route is
    // additive, not an alternative, or the receiver never learns it exists.
    ...(project.imageTargets.length > 0
      ? [
          'viscraft image . --target <target>',
          `viscraft workbench .${
            project.imageDocuments.length > 1 ? ' --document <document> --target <target>' : ' --target <target>'
          }   # optional: adjust by hand`,
        ]
      : []),
    '```',
    '',
    ...(project.imageTargets.length > 0
      ? [
          '## Editing a received copy',
          '',
          "Copy this project into your own working directory before editing. The sender's output delivery records and live editor sessions do not travel with it. Start an unbound editor here; it saves and renders locally without requiring an existing delivery:",
          '',
          '```sh',
          ...project.imageTargets.map(
            target => `viscraft workbench . --document ${target.document} --target ${target.id}`,
          ),
          '```',
          '',
          "To update a stable delivered file, first run `viscraft deliver` in your working copy with the outputs you need, then add `--delivery <local-entry>` to the editor command. Use `viscraft status .` to find that local entry. Do not reuse a sender-side `--delivery handoff` command before creating your own delivery. Editing this copy does not change the sender's source or original bundle.",
          '',
        ]
      : []),
  ];
  return `${lines.join('\n')}\n`;
}
