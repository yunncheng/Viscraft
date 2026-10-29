#!/usr/bin/env node
// Export the current product bytes, build and validate a separate checkout, then
// prepare a matched distribution. Never creates a remote or uploads anything.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { hashFile, listFiles, npmCommand, pythonCommand } from './release-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
function run(program, args, cwd, log, environment = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      env: environment,
      stdio: log ? ['ignore', log, log] : 'inherit',
      shell: false,
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', code =>
      code === 0 ? resolve() : reject(new Error(`${program} exited ${code}; inspect the validation log`)),
    );
  });
}
async function capture(program, args, cwd) {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) =>
    execFile(program, args, { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout) =>
      error ? reject(error) : resolve(stdout.trim()),
    ),
  );
}
async function manifest(directory) {
  const result = {};
  for (const file of await listFiles(directory)) result[file] = await hashFile(path.join(directory, file));
  return result;
}
function treeHash(files) {
  return createHash('sha256')
    .update(
      Object.keys(files)
        .sort()
        .map(file => `${files[file]}  ${file}\n`)
        .join(''),
    )
    .digest('hex');
}
async function writeJSON(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n');
}

function validateRepository(repository) {
  if (repository !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error('Repository must be an explicit GitHub owner/repository');
}

export function runtimeDistribution(pkg, packed, sha256, contentSha256, repository) {
  if (!/^[a-f0-9]{64}$/.test(contentSha256 ?? '')) throw new Error('Runtime content SHA-256 is required');
  if (repository === undefined && pkg.repository?.url !== undefined) {
    repository = /^https:\/\/github\.com\/([^/]+\/[^/]+?)\.git$/.exec(pkg.repository.url)?.[1];
    if (!repository) throw new Error('Package repository must be a GitHub HTTPS .git URL, or pass --repository');
  }
  validateRepository(repository);
  return {
    format: 'viscraft-runtime-distribution/1',
    name: pkg.name,
    version: pkg.version,
    file: packed.filename,
    sha256,
    contentSha256,
    ...(repository
      ? { url: `https://github.com/${repository}/releases/download/v${pkg.version}/${packed.filename}` }
      : {}),
  };
}

// Export only product source. This is also usable for a read-only release audit;
// no dependency installation, build, Git commit or publication occurs here.
export async function exportProductSource(source) {
  await fs.mkdir(source); // Refuse to merge into or erase an existing directory.
  for (const dir of ['src', 'tests', 'scripts', 'skills', '.github']) {
    for (const file of await listFiles(path.join(root, dir))) {
      const relative = `${dir}/${file}`;
      // A distribution receipt is generated only after packing these exact bytes.
      if (relative === 'skills/viscraft/runtime.json') continue;
      if (
        file
          .split('/')
          .some(part => {
            const name = part.toLowerCase();
            return (
              ['.git', '.viscraft', 'node_modules', '.env', '.aws', '.codex', '.agents'].includes(name) ||
              name.startsWith('.env.') ||
              /^(?:id_rsa|id_ed25519)(?:\.|$)/.test(name)
            );
          })
      )
        throw new Error(`Private or generated source member requires review: ${relative}`);
      const destination = path.join(source, relative);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(path.join(root, relative), destination);
    }
  }
  for (const file of [
    'README.md',
    'CONTRIBUTING.md',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    '.prettierrc.json',
    '.gitignore',
    '.gitattributes',
  ])
    await fs.copyFile(path.join(root, file), path.join(source, file));
  await fs.mkdir(path.join(source, 'assets'));
  await fs.copyFile(path.join(root, 'assets', 'Logo.png'), path.join(source, 'assets', 'Logo.png'));
  const files = await manifest(source);
  const secretPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|hf_[A-Za-z0-9]{30,})\b/,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    /\bsk-(?:ant-[A-Za-z0-9_-]{20,}|proj-[A-Za-z0-9_-]{30,}|[A-Za-z0-9]{32,})\b/,
  ];
  for (const file of Object.keys(files)) {
    const full = path.join(source, file);
    if ((await fs.stat(full)).size >= 100 * 1024 * 1024)
      throw new Error(`Source file reaches GitHub's ordinary Git limit: ${file}`);
    if (/\.(?:ts|mjs|js|json|md|txt|html|css|svg|sh|ya?ml)$/.test(file)) {
      const content = await fs.readFile(full, 'utf8');
      if (secretPatterns.some(pattern => pattern.test(content)))
        throw new Error(`Credential-like content requires review: ${file}`);
    }
  }
  return files;
}

/** A plain product-source archive, with the same separately installable Runtime.
 * No installer, test-kit manifest, or alternate creator workflow is generated. */
export async function archiveProductSource(source, sourceManifest, runtimeFile, archive) {
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'viscraft-source-archive-'));
  const folder = path.join(staging, path.basename(archive, '.zip'));
  try {
    await fs.mkdir(folder);
    for (const [relative, expected] of Object.entries(sourceManifest)) {
      if (relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..'))
        throw new Error('Invalid source archive path');
      const destination = path.join(folder, relative);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(path.join(source, relative), destination);
      if ((await hashFile(destination)) !== expected) throw new Error(`Source changed before archiving: ${relative}`);
    }
    const receipt = JSON.parse(await fs.readFile(path.join(folder, 'skills/viscraft/runtime.json'), 'utf8'));
    if (receipt.file !== path.basename(runtimeFile) || receipt.sha256 !== (await hashFile(runtimeFile)))
      throw new Error('Runtime package differs from the Skill receipt');
    await fs.copyFile(runtimeFile, path.join(folder, path.basename(runtimeFile)));
    const python = await pythonCommand();
    await run(
      python.program,
      [
        ...python.args,
        '-c',
        `import pathlib,sys,zipfile\nr=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],'x',zipfile.ZIP_DEFLATED,compresslevel=6) as z:\n for p in sorted(r.rglob('*')):\n  if p.is_file():z.write(p,r.name+'/'+p.relative_to(r).as_posix())`,
        folder,
        path.resolve(archive),
      ],
      root,
    );
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

export async function prepareRelease(output, options = {}) {
  validateRepository(options.repository);
  output = path.resolve(output);
  const forbidden = ['src', 'tests', 'scripts', 'skills', 'node_modules', 'dist', '.git'];
  if (
    output === root ||
    forbidden.some(dir => output === path.join(root, dir) || output.startsWith(path.join(root, dir) + path.sep))
  ) {
    throw new Error('Choose a new release directory outside source, dependencies and Git data');
  }
  await fs.mkdir(output); // Never reuse or erase an existing output directory.
  const source = path.join(output, 'source');
  const assets = path.join(output, 'assets');
  const evidence = path.join(output, 'validation');
  await fs.mkdir(assets);
  await fs.mkdir(evidence);
  const sourceManifest = await exportProductSource(source);
  await writeJSON(path.join(evidence, 'source-files.json'), sourceManifest);
  const npm = await npmCommand([]);
  const steps = [
    ['install', npm.program, [...npm.args, 'ci', '--ignore-scripts', '--no-audit', '--no-fund']],
    ['build', npm.program, [...npm.args, 'run', 'build']],
    ['lint', npm.program, [...npm.args, 'run', 'lint']],
    ['unit', process.execPath, ['scripts/run-tests.mjs', 'unit']],
    ['e2e', process.execPath, ['scripts/run-tests.mjs', 'e2e']],
  ];
  for (const [name, program, args] of steps) {
    console.log(`Release validation: ${name}`);
    const log = await fs.open(path.join(evidence, `${name}.log`), 'wx');
    try {
      await run(program, args, source, log.fd, {
        ...process.env,
        VISCRAFT_CONFIG_HOME: path.join(evidence, 'no-user-config'),
      });
    } finally {
      await log.close();
    }
  }
  const pkg = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
  // prepack normally builds; this isolated checkout was just built and tested.
  const packed = JSON.parse(
    await capture(
      npm.program,
      [...npm.args, 'pack', '--ignore-scripts', '--pack-destination', assets, '--json'],
      source,
    ),
  )[0];
  const runtimeFile = path.join(assets, packed.filename);
  if (packed.files.some(file => file.path === 'skills' || file.path.startsWith('skills/')))
    throw new Error('The Runtime npm package must not contain the Skill or creative references');
  // Commit only allowlisted source bytes; dependencies and compiled outputs stay ignored.
  await run('git', ['init', '-b', 'main'], source);
  if (process.platform === 'win32') await run('git', ['config', 'core.longpaths', 'true'], source);
  const author = process.env.GIT_AUTHOR_NAME || (await capture('git', ['config', 'user.name'], root));
  const email = process.env.GIT_AUTHOR_EMAIL || (await capture('git', ['config', 'user.email'], root));
  await run('git', ['config', 'user.name', author], source);
  await run('git', ['config', 'user.email', email], source);
  for (const [file, expected] of Object.entries(sourceManifest))
    if ((await hashFile(path.join(source, file))) !== expected)
      throw new Error(`Source changed during validation: ${file}`);
  // This installation receipt travels with the Skill. Its download address uses
  // the declared package repository or the maintainer's explicit override.
  const { runtimeContentSha256 } = await import(pathToFileURL(path.join(source, 'dist/src/shared/runtime-identity.js')));
  const distribution = runtimeDistribution(
    pkg,
    packed,
    await hashFile(runtimeFile),
    await runtimeContentSha256(source),
    options.repository,
  );
  const distributionPath = 'skills/viscraft/runtime.json';
  await writeJSON(path.join(source, distributionPath), distribution);
  sourceManifest[distributionPath] = await hashFile(path.join(source, distributionPath));
  const sourceIdentity = treeHash(sourceManifest);
  await writeJSON(path.join(evidence, 'source-files.json'), sourceManifest);
  const skillFiles = await manifest(path.join(source, 'skills/viscraft'));
  // Stage every exported file, including curated evidence ignored by generic rules.
  // A file list also avoids the Windows command-line length limit.
  const pathspec = path.join(evidence, 'git-pathspec');
  await fs.writeFile(pathspec, Object.keys(sourceManifest).join('\0') + '\0');
  await run('git', ['add', '--force', `--pathspec-from-file=${pathspec}`, '--pathspec-file-nul'], source);
  await fs.unlink(pathspec);
  await run('git', ['commit', '-m', `Prepare Viscraft ${pkg.version}`], source);
  const commit = await capture('git', ['rev-parse', 'HEAD'], source);
  const tag = `v${pkg.version}`;
  await run('git', ['tag', '-a', tag, '-m', `Viscraft ${pkg.version}`], source);
  const counts = {};
  for (const name of ['unit', 'e2e']) {
    const text = await fs.readFile(path.join(evidence, `${name}.log`), 'utf8');
    counts[name] = {};
    for (const field of ['tests', 'pass', 'fail', 'cancelled', 'skipped']) {
      const value = text
        .match(new RegExp(`(?:#|ℹ) ${field} (\\d+)`, 'g'))
        ?.at(-1)
        ?.match(/(\d+)$/)?.[1];
      if (value === undefined) throw new Error(`Missing ${name} test summary: ${field}`);
      counts[name][field] = Number(value);
    }
  }
  const release = {
    version: pkg.version,
    tag,
    sourceCommit: commit,
    sourceTreeSha256: sourceIdentity,
    runtime: distribution,
    skillTreeSha256: treeHash(skillFiles),
    checks: { build: true, lint: true, ...counts },
    distribution: { kind: 'source-and-runtime', sourceIncluded: true, skillBundledInRuntime: false },
    claims: { realProviderGeneration: false, artisticAcceptance: false, githubRoundTrip: false },
  };
  await archiveProductSource(source, sourceManifest, runtimeFile, path.join(assets, `viscraft-${pkg.version}.zip`));
  const notes = `# Viscraft ${pkg.version}\n\nMatched Skill and Runtime, complete editable references and original licence notices. Install the Skill through your coding agent, then describe your work. The agent checks and prepares the matching Runtime when needed. The source ZIP contains the product files and matching Runtime tgz for sharing; it uses the same installation flow.\n\nValidation: build/lint; ${counts.unit.pass} unit checks and ${counts.e2e.pass} E2E checks passed locally. Provider tests use local fixtures/mock services. No real model-generation or artistic-acceptance claim. GitHub CI and the actual download path remain to be exercised after upload.\n\nNode.js 22+; media operations additionally need FFmpeg/FFprobe and Chrome. External image/video services require separate configuration and authorization.\n`;
  await fs.writeFile(path.join(output, 'RELEASE_NOTES.md'), notes);
  await writeJSON(path.join(evidence, 'release.json'), release);
  const assetFiles = await manifest(assets);
  await fs.writeFile(
    path.join(assets, 'SHA256SUMS'),
    Object.keys(assetFiles)
      .sort()
      .map(file => `${assetFiles[file]}  ${file}\n`)
      .join(''),
  );
  await writeJSON(path.join(output, 'prepared.json'), { source, assets, release });
  console.log(JSON.stringify({ source, assets, tag, sourceCommit: commit, checks: counts }, null, 2));
  return { source, assets, release };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [flag, output, ...extra] = process.argv.slice(2);
  const validExtra = !extra.length || (extra.length === 2 && extra[0] === '--repository' && extra[1]);
  if (flag !== '--output' || !output || !validExtra) {
    console.error('Usage: node scripts/prepare-release.mjs --output NEW_DIRECTORY [--repository OWNER/REPO]');
    process.exitCode = 1;
  } else
    try {
      await prepareRelease(output, { repository: extra[1] });
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
}
