import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { npmCommand, pythonCommand } = await import(new URL('../../scripts/release-files.mjs', import.meta.url).href);
const { runtimeDistribution, exportProductSource, archiveProductSource } = await import(
  new URL('../../scripts/prepare-release.mjs', import.meta.url).href
);
const exec = promisify(execFile);
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

test('Windows npm resolution runs JS with literal paths, without invoking a cmd shell', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-npm-path-'));
  try {
    const directory = path.join(root, 'Node & tools');
    const cli = path.join(directory, 'node_modules/npm/bin/npm-cli.js');
    await fs.mkdir(path.dirname(cli), { recursive: true });
    await fs.writeFile(cli, 'console.log(JSON.stringify(process.argv.slice(2)))');
    const args = ['install', path.join(root, 'my work & literal $(name)')];
    const command = await npmCommand(args, {
      platform: 'win32',
      environment: { Path: `"${directory}"` },
      nodeExecutable: process.execPath,
    });
    assert.equal(command.program, process.execPath);
    const { stdout } = await exec(command.program, command.args);
    assert.deepEqual(JSON.parse(stdout), args);
    const fromNpm = await npmCommand(args, {
      platform: 'win32',
      environment: { npm_execpath: cli },
      nodeExecutable: process.execPath,
    });
    assert.deepEqual(fromNpm, command);
    await assert.rejects(
      npmCommand([], {
        platform: 'win32',
        environment: {},
        nodeExecutable: path.join(root, 'missing/node.exe'),
      }),
      /Cannot locate npm/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the shared test runner isolates provider settings, expands both suites and removes its temporary config', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-test-runner-'));
  try {
    await fs.mkdir(path.join(root, 'scripts'));
    await fs.mkdir(path.join(root, 'dist/tests'), { recursive: true });
    await fs.copyFile(
      new URL('../../scripts/run-tests.mjs', import.meta.url),
      path.join(root, 'scripts/run-tests.mjs'),
    );
    const callerConfig = path.join(root, 'caller-config');
    await fs.mkdir(callerConfig);
    await fs.writeFile(path.join(callerConfig, 'endpoints.json'), 'preserve caller settings');
    const report = path.join(root, 'report.json');
    const fixture = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import os from 'node:os';
      assert.equal(process.env.VISCRAFT_VIDEO_SERVICE, undefined);
      assert.equal(process.env.VISCRAFT_IMAGE_API_KEY, undefined);
      assert.notEqual(process.env.VISCRAFT_CONFIG_HOME, process.env.CALLER_CONFIG);
      assert.deepEqual(fs.readdirSync(process.env.VISCRAFT_CONFIG_HOME), []);
      assert.equal(os.tmpdir(), fs.realpathSync(os.tmpdir()));
      assert.equal(process.env.TMPDIR, os.tmpdir());
      assert.equal(process.env.TMP, os.tmpdir());
      assert.equal(process.env.TEMP, os.tmpdir());
      fs.writeFileSync(process.env.RUNNER_REPORT, JSON.stringify({ config: process.env.VISCRAFT_CONFIG_HOME }));
    `;
    for (const suite of ['unit', 'e2e']) {
      await fs.writeFile(path.join(root, `dist/tests/fixture.${suite === 'unit' ? 'test' : 'e2e'}.js`), fixture);
      await exec(process.execPath, [path.join(root, 'scripts/run-tests.mjs'), suite], {
        env: {
          ...process.env,
          VISCRAFT_VIDEO_SERVICE: 'must-not-reach-fixture',
          VISCRAFT_IMAGE_API_KEY: 'fixture-not-a-real-key',
          VISCRAFT_CONFIG_HOME: callerConfig,
          CALLER_CONFIG: callerConfig,
          RUNNER_REPORT: report,
        },
      });
      const result = JSON.parse(await fs.readFile(report, 'utf8'));
      await assert.rejects(fs.stat(result.config), /ENOENT/);
    }
    assert.equal(await fs.readFile(path.join(callerConfig, 'endpoints.json'), 'utf8'), 'preserve caller settings');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('public source export is self-contained and excludes internal state and a stale Runtime receipt', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-public-source-'));
  try {
    const source = path.join(root, 'source');
    const files = await exportProductSource(source);
    for (const required of [
      'README.md',
      'assets/Logo.png',
      'CONTRIBUTING.md',
      '.gitattributes',
      'LICENSE',
      'skills/viscraft/LICENSE',
      'skills/viscraft/SKILL.md',
      'src/index.ts',
      'tests/release-tools.test.ts',
      'src/workbench/ui/vendor/layer-editor.upstream.patch',
    ])
      assert.ok(files[required], `missing public source: ${required}`);
    for (const file of Object.keys(files)) {
      assert.ok(!/^(?:docs|references|releases|cases|outputs|node_modules|dist|\.git)\//.test(file), file);
      assert.notEqual(file, 'skills/viscraft/runtime.json');
    }
    assert.equal(files['AGENTS.md'], undefined);
    await assert.rejects(fs.stat(path.join(source, 'AGENTS.md')), { code: 'ENOENT' });
    assert.equal(files['skills/viscraft/LICENSE'], files.LICENSE);
    await assert.rejects(exportProductSource(source), /EEXIST/);

    // Exercise rejection from the isolated copy, never from the real checkout.
    const isolated = await import(pathToFileURL(path.join(source, 'scripts/prepare-release.mjs')).href);
    for (const [index, name] of ['.env', '.ENV', '.AWS/credentials'].entries()) {
      const environment = path.join(source, 'skills/viscraft', name);
      await fs.mkdir(path.dirname(environment), { recursive: true });
      await fs.writeFile(environment, 'FAKE_FIXTURE=private-local-value\n');
      await assert.rejects(
        isolated.exportProductSource(path.join(root, `reject-env-${index}`)),
        /Private or generated/,
      );
      await fs.unlink(environment);
      if (name.includes('/')) await fs.rmdir(path.dirname(environment));
    }
    await fs.writeFile(path.join(source, 'src/release-audit.css'), `/* ${'hf_' + 'a'.repeat(32)} */`);
    await assert.rejects(isolated.exportProductSource(path.join(root, 'reject-token')), /Credential-like/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('source checkout preserves text and binary hashes even with Git autocrlf enabled', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-checkout-bytes-'));
  try {
    await fs.copyFile(
      fileURLToPath(new URL('../../.gitattributes', import.meta.url)),
      path.join(root, '.gitattributes'),
    );
    const text = Buffer.from('source and provenance\nsecond line\n');
    const binary = Buffer.from([0, 10, 13, 255, 10, 0]);
    const authored = Buffer.from('authoritative project bytes\r\nsecond line\r\n');
    await fs.writeFile(path.join(root, 'source.txt'), text);
    await fs.writeFile(path.join(root, 'asset.bin'), binary);
    await fs.mkdir(path.join(root, 'skills', 'fixture'), { recursive: true });
    await fs.writeFile(path.join(root, 'skills', 'fixture', 'scene.js'), authored);
    const git = (args: string[]) => exec('git', args, { cwd: root, windowsHide: true });
    await git(['init']);
    await git(['config', 'core.autocrlf', 'true']);
    await git(['add', '--all']);
    const checkout = path.join(root, 'checkout');
    await fs.mkdir(checkout);
    await git(['checkout-index', '--all', `--prefix=${checkout.split(path.sep).join('/')}/`]);
    assert.deepEqual(await fs.readFile(path.join(checkout, 'source.txt')), text);
    assert.deepEqual(await fs.readFile(path.join(checkout, 'asset.bin')), binary);
    assert.deepEqual(await fs.readFile(path.join(checkout, 'skills', 'fixture', 'scene.js')), authored);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('GitHub Skill receipt names an exact Runtime asset only for an explicit repository', () => {
  const pkg = { name: 'viscraft-runtime', version: '0.1.0' };
  const packed = { filename: 'viscraft-runtime-0.1.0.tgz' };
  const checksum = sha('a matched runtime');
  const local = runtimeDistribution(pkg, packed, checksum, sha('content'));
  assert.equal(local.sha256, checksum);
  assert.equal(local.contentSha256, sha('content'));
  assert.equal(local.file, packed.filename);
  assert.equal(local.url, undefined);
  const github = runtimeDistribution(pkg, packed, checksum, sha('content'), 'example-org/Viscraft');
  assert.equal(
    github.url,
    'https://github.com/example-org/Viscraft/releases/download/v0.1.0/viscraft-runtime-0.1.0.tgz',
  );
  assert.throws(
    () => runtimeDistribution(pkg, packed, checksum, sha('content'), 'https://unknown/path'),
    /owner\/repository/,
  );
});

test('the declared repository supplies the official Runtime URL without a manual release flag', async () => {
  const pkg = JSON.parse(await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const packed = { filename: `viscraft-runtime-${pkg.version}.tgz` };
  const receipt = runtimeDistribution(pkg, packed, sha('fixture'), sha('content'));
  assert.equal(
    receipt.url,
    `https://github.com/yunncheng/Viscraft/releases/download/v${pkg.version}/${packed.filename}`,
  );
  assert.equal(
    runtimeDistribution(pkg, packed, sha('fixture'), sha('content'), 'example-org/fork').url,
    `https://github.com/example-org/fork/releases/download/v${pkg.version}/${packed.filename}`,
  );
  assert.throws(
    () =>
      runtimeDistribution(
        { ...pkg, repository: { url: 'https://unknown.example/repository.git' } },
        packed,
        sha('fixture'),
        sha('content'),
      ),
    /Package repository/,
  );
});

test('the real npm pack includes fixed Runtime UI resources and excludes the complete Skill', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-thin-package-'));
  try {
    const repository = fileURLToPath(new URL('../../', import.meta.url));
    const npm = await npmCommand([
      'pack',
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      root,
      '--cache',
      path.join(root, 'cache'),
    ]);
    const { stdout } = await exec(npm.program, npm.args, { cwd: repository, maxBuffer: 4 * 1024 * 1024 });
    const [packed] = JSON.parse(stdout) as [{ files: { path: string }[] }];
    const members = packed.files.map(file => file.path);
    assert.ok(members.includes('dist/src/index.js'));
    assert.ok(members.some(file => file.startsWith('dist/src/workbench/ui/')));
    for (const prefix of ['skills/', 'docs/', 'references/', 'tests/', '.git/'])
      assert.ok(!members.some(file => file.startsWith(prefix)), `unexpected npm content: ${prefix}`);
    for (const file of [
      'CONTRIBUTING.md',
      'dist/src/workbench/ui/README.md',
      'dist/src/workbench/ui/vendor/layer-editor.upstream.patch',
    ])
      assert.ok(!members.includes(file), `source-only file in Runtime package: ${file}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the source archive is ordinary product files and a matched tgz, with no second installer contract', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-source-archive-test-'));
  try {
    const source = path.join(root, 'source');
    await fs.mkdir(path.join(source, 'skills/viscraft'), { recursive: true });
    const bytes = Buffer.from('test-only Runtime archive bytes');
    const runtime = path.join(root, 'viscraft-runtime-0.1.0.tgz');
    await fs.writeFile(runtime, bytes);
    const content: Record<string, string> = {
      'README.md': 'Install the Skill through your host agent.',
      'skills/viscraft/SKILL.md': '---\nname: viscraft\ndescription: fixture\n---\n',
      'skills/viscraft/runtime.json': JSON.stringify({ file: path.basename(runtime), sha256: sha(bytes) }),
    };
    const manifest: Record<string, string> = {};
    for (const [file, text] of Object.entries(content)) {
      await fs.writeFile(path.join(source, file), text);
      manifest[file] = sha(text);
    }
    const archive = path.join(root, 'viscraft-0.1.0.zip');
    await archiveProductSource(source, manifest, runtime, archive);
    const python = await pythonCommand();
    const { stdout } = await exec(python.program, [
      ...python.args,
      '-c',
      'import zipfile,json,sys; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({n:z.read(n).decode() for n in z.namelist()}))',
      archive,
    ]);
    const entries = JSON.parse(stdout) as Record<string, string>;
    assert.deepEqual(
      Object.keys(entries).sort(),
      [...Object.keys(content), path.basename(runtime)].map(n => `viscraft-0.1.0/${n}`).sort(),
    );
    for (const [file, text] of Object.entries(content)) assert.equal(entries[`viscraft-0.1.0/${file}`], text);
    assert.equal(entries[`viscraft-0.1.0/${path.basename(runtime)}`], bytes.toString());
    await fs.writeFile(runtime, 'changed Runtime');
    await assert.rejects(
      archiveProductSource(source, manifest, runtime, path.join(root, 'mismatch.zip')),
      /differs from the Skill receipt/,
    );
    await assert.rejects(fs.stat(path.join(root, 'mismatch.zip')), /ENOENT/);
    await fs.writeFile(runtime, bytes);
    await fs.writeFile(path.join(source, 'README.md'), 'changed source');
    await assert.rejects(
      archiveProductSource(source, manifest, runtime, path.join(root, 'changed.zip')),
      /Source changed/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
