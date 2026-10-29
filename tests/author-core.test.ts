import { createSymlinkFixture } from './fs-fixtures.js';
/**
 * The one Runtime authoring boundary (`authorProject`).
 *
 * This is the focused, fast contract: declarations and explicit byte pins are
 * validated BEFORE the destination exists; the destination must be new; every
 * authored path keeps its exact relative layout; Asset hashes/revisions are
 * derived once from the published bytes while supplied identities are
 * assertions; frozen parent relations are never rewritten; and `project.json`
 * is committed last so a failure cannot report a successful Project.
 *
 * It deliberately does not build, render, submit a provider request or touch the
 * network — authoring is one local publication step.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { authorProject, type AuthorFile, type AuthorProject } from '../src/project/author.js';
import { validateProject } from '../src/project/project.js';
import { hashFile } from '../src/shared/hash.js';

const RIGHTS = { origin: 'original: author-core test fixture', license: 'CC0-1.0', redistributable: true };

function baseProject(assets: AuthorProject['assets'] = []): AuthorProject {
  return {
    schemaVersion: 1,
    id: 'author-core',
    revision: 1,
    title: 'Author core',
    soundTargets: [],
    direction: { intent: '', looks: [{ id: 'look', description: 'One look' }], transitions: [] },
    assets,
    bindings: {},
    sources: [],
    imageDocuments: [],
    imageTargets: [],
    composition: {
      output: { width: 32, height: 32, fps: { numerator: 30, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [],
      shots: [],
      placements: [],
      transitions: [],
      audio: [],
    },
  };
}

function codeAsset(id: string, path: string, extra: Record<string, unknown> = {}): AuthorProject['assets'][number] {
  return { id, path, type: 'code', rights: RIGHTS, simulated: false, ...extra } as AuthorProject['assets'][number];
}

/** A missing destination beneath a fresh temporary parent. */
async function destination(parent: string, name = 'project'): Promise<string> {
  return join(parent, name);
}

// ---------------------------------------------------------------------------
// Publishing: derived identities, exact layout, unregistered author files
// ---------------------------------------------------------------------------

test('authorProject publishes bytes, derives Asset hashes/revisions once, and keeps unregistered author files', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-author-core-'));
  const root = await destination(parent);
  const source = join(parent, 'from-disk.bin');
  const diskBytes = Buffer.from('bytes read from an absolute local source\n');
  await writeFile(source, diskBytes);
  const generated = 'export const value = 1;\n';
  const binary = Uint8Array.from([0, 1, 2, 3, 250, 251, 252]);
  try {
    const project = await authorProject(root, {
      project: baseProject([
        codeAsset('disk', 'lib/from-disk.bin', { sha256: undefined }),
        codeAsset('generated', 'lib/generated.mjs'),
      ]),
      files: [
        { path: 'lib/from-disk.bin', sourcePath: source },
        { path: 'lib/generated.mjs', bytes: generated, expectedSha256: stableHashBytes(Buffer.from(generated)) },
        { path: 'assets/binary.dat', bytes: binary },
        // An HTML/CSS/licence document is ordinary editable author state, NOT an
        // implicitly registered Asset.
        { path: 'notes/README.md', bytes: '# notes\n' },
      ],
    });

    // The returned value is the complete validated Project.
    assert.deepEqual(validateProject(project), project);
    assert.deepEqual(await readFile(join(root, 'lib/from-disk.bin')), diskBytes, 'sourcePath bytes are copied exactly');
    assert.equal(await readFile(join(root, 'lib/generated.mjs'), 'utf8'), generated);
    assert.deepEqual(await readFile(join(root, 'assets/binary.dat')), Buffer.from(binary));
    assert.equal(await readFile(join(root, 'notes/README.md'), 'utf8'), '# notes\n');
    assert.equal(existsSync(join(root, 'notes/README.md')), true, 'the unregistered file still exists');
    assert.equal(project.assets.length, 2, 'only declared Assets are registered');
    assert.ok(
      !project.assets.some(asset => asset.path === 'notes/README.md'),
      'unregistered documents stay unregistered',
    );

    // Derived identity: real hash of the published bytes, initial revision 1.
    for (const asset of project.assets) {
      assert.equal(asset.sha256, await hashFile(join(root, asset.path)), `${asset.id} hash is the published bytes`);
      assert.equal(asset.revision, 1, `${asset.id} starts at revision 1`);
    }
    const onDisk = JSON.parse(await readFile(join(root, 'project.json'), 'utf8')) as typeof project;
    assert.deepEqual(onDisk, project, 'project.json is the committed Project');

    // The exact relative layout is preserved; no content-addressed rename.
    assert.equal((await stat(join(root, 'lib'))).isDirectory(), true);
    assert.equal(existsSync(join(root, 'lib/from-disk.bin')), true);
    // The Project contents never point back at the source host path.
    assert.doesNotMatch(JSON.stringify(project), new RegExp(escapeRegExp(parent)));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('authorProject keeps a supplied Asset revision/sha256 only when they agree with the authored bytes', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-author-core-pins-'));
  const root = await destination(parent);
  const bytes = 'pinned\n';
  const sha = stableHashBytes(Buffer.from(bytes));
  try {
    await assert.rejects(
      () =>
        authorProject(root, {
          project: baseProject([codeAsset('pinned', 'file.txt', { sha256: '0'.repeat(64) })]),
          files: [{ path: 'file.txt', bytes }],
        }),
      /sha256 does not match its authored bytes/,
    );
    assert.equal(existsSync(root), false, 'a bad Asset pin must not create the destination');

    await assert.rejects(
      () =>
        authorProject(root, {
          project: baseProject([codeAsset('pinned', 'file.txt', { revision: 2 })]),
          files: [{ path: 'file.txt', bytes }],
        }),
      /must start at revision 1/,
    );
    assert.equal(existsSync(root), false);

    const accepted = await authorProject(root, {
      project: baseProject([codeAsset('pinned', 'file.txt', { sha256: sha, revision: 1 })]),
      files: [{ path: 'file.txt', bytes, expectedSha256: sha }],
    });
    assert.equal(accepted.assets[0]!.sha256, sha);
    assert.equal(accepted.assets[0]!.revision, 1);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('authorProject preserves frozen parent identities instead of rewriting them', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-author-core-lineage-'));
  const root = await destination(parent);
  const parentBytes = 'parent source\n';
  const childBytes = 'child derivative\n';
  const parentSha = stableHashBytes(Buffer.from(parentBytes));
  try {
    await assert.rejects(
      () =>
        authorProject(root, {
          project: baseProject([
            codeAsset('parent', 'src/parent.txt'),
            codeAsset('child', 'src/child.txt', {
              inputs: [{ asset: 'parent', revision: 1, sha256: 'a'.repeat(64), role: 'source' }],
            }),
          ]),
          files: [
            { path: 'src/parent.txt', bytes: parentBytes },
            { path: 'src/child.txt', bytes: childBytes },
          ],
        }),
      /refusing to rewrite a frozen parent identity/,
    );
    assert.equal(existsSync(root), false, 'a mismatched frozen parent must fail before publishing');

    const project = await authorProject(root, {
      project: baseProject([
        codeAsset('parent', 'src/parent.txt'),
        codeAsset('child', 'src/child.txt', {
          inputs: [{ asset: 'parent', revision: 1, sha256: parentSha, role: 'source' }],
        }),
      ]),
      files: [
        { path: 'src/parent.txt', bytes: parentBytes },
        { path: 'src/child.txt', bytes: childBytes },
      ],
    });
    const child = project.assets.find(asset => asset.id === 'child')!;
    assert.deepEqual(child.inputs, [{ asset: 'parent', revision: 1, sha256: parentSha, role: 'source' }]);
    assert.equal(child.inputs![0]!.sha256, project.assets.find(asset => asset.id === 'parent')!.sha256);
    assert.equal(project.assets.find(asset => asset.id === 'parent')!.sha256, parentSha);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Destination protection
// ---------------------------------------------------------------------------

test('authorProject refuses an existing directory, file or symlink and never modifies it', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-author-core-existing-'));
  try {
    const existing = join(parent, 'existing');
    await mkdir(existing);
    await writeFile(join(existing, 'keep.txt'), 'keep me\n');
    await assert.rejects(
      () =>
        authorProject(existing, {
          project: baseProject(),
          files: [{ path: 'new.txt', bytes: 'new\n' }],
        }),
      /Refusing to author into existing/,
    );
    assert.equal(await readFile(join(existing, 'keep.txt'), 'utf8'), 'keep me\n');
    assert.equal(existsSync(join(existing, 'new.txt')), false);
    assert.equal(existsSync(join(existing, 'project.json')), false);

    const file = join(parent, 'a-file');
    await writeFile(file, 'already here\n');
    await assert.rejects(() => authorProject(file, { project: baseProject(), files: [] }), /Refusing to author/);
    assert.equal(await readFile(file, 'utf8'), 'already here\n');

    const target = join(parent, 'target');
    await mkdir(target);
    const link = join(parent, 'link');
    await createSymlinkFixture(t, target, link);
    await assert.rejects(() => authorProject(link, { project: baseProject(), files: [] }), /Refusing to author/);
    assert.equal((await stat(target)).isDirectory(), true);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Declarations validated before the destination exists
// ---------------------------------------------------------------------------

test('authorProject rejects unsafe, duplicate and malformed declarations before creating the destination', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-author-core-invalid-'));
  const source = join(parent, 'source.txt');
  await writeFile(source, 'source\n');
  const cases: Array<[string, AuthorFile[], RegExp, AuthorProject?]> = [
    ['runtime-private path', [{ path: '.viscraft/state.json', bytes: 'x' }], /must not be stored under \.viscraft/],
    [
      'runtime-private case alias',
      [{ path: '.VISCRAFT/state.json', bytes: 'x' }],
      /must not be stored under \.viscraft/,
    ],
    ['delivery output path', [{ path: 'output/movie.mp4', bytes: 'x' }], /must not live under output\//],
    ['delivery output case alias', [{ path: 'OUTPUT/movie.mp4', bytes: 'x' }], /must not live under output\//],
    ['credential path', [{ path: 'config/.env', bytes: 'SECRET=1' }], /must not package a credential file/],
    ['credential case alias', [{ path: 'config/.ENV', bytes: 'SECRET=1' }], /must not package a credential file/],
    ['project.json', [{ path: 'project.json', bytes: '{}' }], /written by the Runtime, not declared/],
    ['manifest case alias', [{ path: 'PROJECT.JSON', bytes: '{}' }], /written by the Runtime, not declared/],
    ['project.json/child', [{ path: 'project.json/child', bytes: '{}' }], /written by the Runtime, not declared/],
    [
      'duplicate path',
      [
        { path: 'a.txt', bytes: '1' },
        { path: 'a.txt', bytes: '2' },
      ],
      /Duplicate authored file path/,
    ],
    [
      'path prefix collision',
      [
        { path: 'a', bytes: '1' },
        { path: 'a/b', bytes: '2' },
      ],
      /collides with/,
    ],
    ['unknown field', [{ path: 'a.txt', bytes: '1', extra: true } as AuthorFile], /unknown field "extra"/],
    ['both inputs', [{ path: 'a.txt', bytes: '1', sourcePath: source }], /exactly one of sourcePath or bytes/],
    ['no input', [{ path: 'a.txt' }], /exactly one of sourcePath or bytes/],
    ['relative sourcePath', [{ path: 'a.txt', sourcePath: 'source.txt' }], /absolute local file path/],
    ['missing sourcePath', [{ path: 'a.txt', sourcePath: join(parent, 'missing') }], /not a regular file/],
    ['bad expectedSha256 format', [{ path: 'a.txt', bytes: '1', expectedSha256: 'ABC' }], /lowercase sha256 digest/],
    [
      'tampered expectedSha256',
      [{ path: 'a.txt', bytes: '1', expectedSha256: 'f'.repeat(64) }],
      /does not match its expectedSha256/,
    ],
    [
      'duplicate Asset id',
      [
        { path: 'a.txt', bytes: '1' },
        { path: 'b.txt', bytes: '2' },
      ],
      /Duplicate authored Asset id/,
      baseProject([codeAsset('same', 'a.txt'), codeAsset('same', 'b.txt')]),
    ],
    [
      'Asset path not declared',
      [{ path: 'a.txt', bytes: '1' }],
      /is not declared in files/,
      baseProject([codeAsset('ghost', 'ghost.txt')]),
    ],
  ];
  try {
    for (const [index, [label, files, matcher, project]] of cases.entries()) {
      const caseParent = join(parent, `case-${index}`);
      const root = join(caseParent, 'project');
      await assert.rejects(
        () => authorProject(root, { project: project ?? baseProject(), files }),
        matcher,
        `${label} must be rejected: ${matcher}`,
      );
      assert.equal(existsSync(root), false, `${label} must be rejected before the destination is created`);
      assert.equal(existsSync(caseParent), false);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('authorProject rejects a Project that references a path not declared as an authored file', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-author-core-reference-'));
  const root = await destination(parent);
  try {
    const project = baseProject();
    project.sources = [
      {
        id: 'src',
        kind: 'browser',
        output: 'picture',
        entry: 'missing.html',
        resources: [],
        bindings: [],
        params: {},
        seed: 0,
        frames: 1,
      },
    ];
    await assert.rejects(
      () => authorProject(root, { project, files: [{ path: 'other.html', bytes: '<html></html>' }] }),
      /references missing\.html, which is not declared in files/,
    );
    assert.equal(existsSync(root), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('authorProject rejects runtime-private and output paths declared by Project content, not only by files', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-author-core-project-paths-'));
  try {
    // Declaring a handoff as an authored file cannot bypass Runtime ownership
    // of `.viscraft/`.
    const handoff = baseProject();
    handoff.handoff = [{ path: '.viscraft/lineage.json', role: 'license' }];
    const handoffRoot = await destination(parent, 'handoff');
    await assert.rejects(
      () =>
        authorProject(handoffRoot, {
          project: handoff,
          files: [{ path: '.viscraft/lineage.json', bytes: '{}' }],
        }),
      /must not be stored under \.viscraft/,
    );
    assert.equal(existsSync(handoffRoot), false);

    // A Source entry under the Runtime's delivery output is refused too.
    const source = baseProject();
    source.sources = [
      {
        id: 'src',
        kind: 'browser',
        output: 'picture',
        entry: 'output/movie.mp4',
        resources: [],
        bindings: [],
        params: {},
        seed: 0,
        frames: 1,
      },
    ];
    const sourceRoot = await destination(parent, 'source');
    await assert.rejects(
      () =>
        authorProject(sourceRoot, {
          project: source,
          files: [{ path: 'output/movie.mp4', bytes: 'x' }],
        }),
      /must not live under output\//,
    );
    assert.equal(existsSync(sourceRoot), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// A failure AFTER the destination exists retains it and commits no Project
// ---------------------------------------------------------------------------

test('a write failure leaves the incomplete destination and never commits project.json', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-author-core-partial-'));
  const root = await destination(parent);
  // A path segment this long is a legal project-relative path but not a legal
  // local filename, so prepareFiles and Project validation pass and the failure
  // happens during publication.
  const tooLong = `${'x'.repeat(300)}.txt`;
  try {
    await assert.rejects(
      () => authorProject(root, { project: baseProject(), files: [{ path: tooLong, bytes: 'x' }] }),
      // An overlong segment is reported as ENAMETOOLONG, EINVAL or Windows ENOENT.
      /ENAMETOOLONG|ENOENT|name too long|invalid argument/i,
    );
    assert.equal(existsSync(root), true, 'the uncertain incomplete directory is retained, not recursively deleted');
    assert.equal(existsSync(join(root, 'project.json')), false, 'a failed publication must not report a Project');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('a project.json that appears while the author lock is held is refused, left untouched, and commits nothing', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'viscraft-author-core-race-'));
  const root = await destination(parent);
  const sentinel = '{"appeared":"while the author lock was held"}\n';
  // Enough independent files that publication is still writing files when the
  // bounded watcher observes the lock. No production test hook is involved: the
  // lock is the Runtime's ordinary `.viscraft/author.lock`.
  const files: AuthorFile[] = Array.from({ length: 100 }, (_, index) => ({
    path: `src/part-${String(index).padStart(3, '0')}.txt`,
    bytes: `part ${index}\n`,
  }));
  try {
    const running = authorProject(root, { project: baseProject(), files });
    // Register the settlement immediately so a fast failure is never unhandled.
    const settled = running.then(
      value => ({ ok: true as const, value }),
      error => ({ ok: false as const, error }),
    );
    const injected = await createProjectJsonWhileLocked(root, sentinel);
    const outcome = await settled;

    assert.equal(injected, true, 'the test must create project.json while the author lock is held');
    if (outcome.ok) assert.fail('a Project must not be reported when it was not committed');
    assert.match(
      outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
      /Refusing to overwrite an unexpected project\.json/,
    );
    assert.equal(
      await readFile(join(root, 'project.json'), 'utf8'),
      sentinel,
      'the appeared project.json is untouched',
    );
    assert.deepEqual(
      (await readdir(root)).filter(name => name.endsWith('.tmp')),
      [],
      'the private commit temporary is removed even when the commit is refused',
    );
    assert.equal(existsSync(root), true, 'the incomplete destination is retained, not recursively deleted');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------

/**
 * Bounded watcher for the publication window: yield the event loop (macro tasks
 * via `setImmediate`, never a sleep) until the Runtime's author lock exists,
 * then create the `project.json` it must refuse. It gives up after a fixed
 * attempt budget, and creates nothing when the Runtime already committed first.
 */
async function createProjectJsonWhileLocked(root: string, contents: string): Promise<boolean> {
  const lock = join(root, '.viscraft', 'author.lock');
  const file = join(root, 'project.json');
  for (let attempt = 0; attempt < 100_000; attempt++) {
    if (existsSync(file)) return false;
    if (existsSync(lock)) {
      await writeFile(file, contents, { flag: 'wx' });
      return true;
    }
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return false;
}

function stableHashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
