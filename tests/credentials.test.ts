import { fileURLToPath } from 'node:url';
/**
 * Per-user provider configuration: named credentials and Endpoints that live
 * outside every Project.
 *
 *  - A credential resolves from the environment variable of its name, else from
 *    the owner-private value stored by `viscraft auth set`; the environment wins.
 *  - Stored values are 0600 files in a 0700 directory; a group/other-readable
 *    file is refused loudly, never silently used.
 *  - A resolved value is masked by `redact`.
 *  - `viscraft auth set` refuses a non-terminal stdin (the agent's shell is not a
 *    key channel), accepts `--from <private-file>`, and never prints the value.
 *  - User Endpoints configure a Source's `endpoint` name for Plan; an explicitly
 *    passed endpoint wins; missing setup is `needsConfiguration`, not approval.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  credentialSource,
  removeCredential,
  resolveCredential,
  storeCredential,
  storedCredentialNames,
} from '../src/config/credentials.js';
import { redact } from '../src/shared/process.js';
import { ProjectSchema, planBuild } from '../src/index.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const NAME = 'VISCRAFT_CREDENTIAL_TEST_KEY';

async function withConfigHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'viscraft-config-'));
  const previousHome = process.env.VISCRAFT_CONFIG_HOME;
  const previousKey = process.env[NAME];
  process.env.VISCRAFT_CONFIG_HOME = home;
  delete process.env[NAME];
  try {
    await fn(home);
  } finally {
    if (previousHome === undefined) delete process.env.VISCRAFT_CONFIG_HOME;
    else process.env.VISCRAFT_CONFIG_HOME = previousHome;
    if (previousKey === undefined) delete process.env[NAME];
    else process.env[NAME] = previousKey;
    await rm(home, { recursive: true, force: true });
  }
}

test('a stored credential is owner-private and the environment takes precedence', async () => {
  await withConfigHome(async home => {
    assert.equal(credentialSource(NAME), 'missing');
    assert.equal(resolveCredential(NAME), undefined);

    const file = storeCredential(NAME, '  stored-SECRET-value\n');
    assert.equal(file, join(home, 'credentials', NAME));
    if (process.platform !== 'win32') {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.equal((await stat(join(home, 'credentials'))).mode & 0o777, 0o700);
    }
    assert.equal(credentialSource(NAME), 'stored');
    assert.equal(resolveCredential(NAME), 'stored-SECRET-value');
    assert.deepEqual(storedCredentialNames(), [NAME]);

    process.env[NAME] = 'env-SECRET-value';
    assert.equal(credentialSource(NAME), 'environment');
    assert.equal(resolveCredential(NAME), 'env-SECRET-value');
    delete process.env[NAME];

    assert.equal(
      redact('echoed stored-SECRET-value and env-SECRET-value'),
      'echoed [REDACTED] and [REDACTED]',
      'resolved values are masked wherever redact applies',
    );

    assert.equal(removeCredential(NAME), true);
    assert.equal(removeCredential(NAME), false);
    assert.equal(credentialSource(NAME), 'missing');
  });
});

test(
  'a group/other-readable credential file is refused, not silently used',
  { skip: process.platform === 'win32' },
  async () => {
    await withConfigHome(async () => {
      const file = storeCredential(NAME, 'value');
      await chmod(file, 0o644);
      assert.throws(() => resolveCredential(NAME), /readable by other users; run `chmod 600/);
      assert.throws(() => credentialSource(NAME), /readable by other users/);
    });
  },
);

test('credential names are environment-variable shaped and values single-line', async () => {
  await withConfigHome(async () => {
    assert.throws(() => storeCredential('../escape', 'v'), /Invalid credential name/);
    assert.throws(() => storeCredential(NAME, 'two words'), /printable ASCII/);
    assert.throws(() => storeCredential(NAME, '   '), /empty/);
    assert.deepEqual(storedCredentialNames(), []);
  });
});

test('viscraft auth: refuses a non-terminal stdin, stores --from, never prints the value', async () => {
  await withConfigHome(async home => {
    const env = { ...process.env, VISCRAFT_CONFIG_HOME: home };
    const piped = spawnSync(process.execPath, [CLI, 'auth', 'set', NAME], {
      input: 'piped-SECRET\n',
      env,
      encoding: 'utf8',
    });
    assert.equal(piped.status, 1);
    assert.match(piped.stderr, /interactive terminal/);
    assert.equal(credentialSource(NAME), 'missing', 'piped input is not a key channel');

    const keyFile = join(home, 'key.txt');
    await writeFile(keyFile, 'file-SECRET-value\n', { mode: 0o600 });
    const set = spawnSync(process.execPath, [CLI, 'auth', 'set', NAME, '--from', keyFile], { env, encoding: 'utf8' });
    assert.equal(set.status, 0, set.stderr);
    assert.ok(!set.stdout.includes('file-SECRET-value') && !set.stderr.includes('file-SECRET-value'));
    assert.equal(resolveCredential(NAME), 'file-SECRET-value');

    const status = spawnSync(process.execPath, [CLI, 'auth', 'status'], { env, encoding: 'utf8' });
    assert.equal(status.status, 0, status.stderr);
    assert.ok(!status.stdout.includes('file-SECRET-value'));
    assert.deepEqual(JSON.parse(status.stdout).storedCredentials, [NAME]);

    const removed = spawnSync(process.execPath, [CLI, 'auth', 'remove', NAME], { env, encoding: 'utf8' });
    assert.equal(JSON.parse(removed.stdout).removed, true);
    assert.equal((await readFile(keyFile, 'utf8')).trim(), 'file-SECRET-value', 'the source file is left alone');
  });
});

function videoProject() {
  return ProjectSchema.parse({
    schemaVersion: 1,
    id: 'user_endpoints',
    revision: 1,
    title: 'User endpoints',
    direction: { intent: 'plan', looks: [{ id: 'default', description: 'Default look' }], transitions: [] },
    assets: [],
    bindings: {},
    sources: [
      {
        id: 'src',
        kind: 'provider',
        output: 'picture',
        endpoint: 'default',
        model: 'minimax-h3-base-fl2va',
        prompt: 'p',
        mode: 'text',
        references: [],
        requestedFrames: 48,
        size: '1280:720',
        attempt: 'a1',
      },
    ],
    composition: {
      output: { width: 64, height: 48, fps: { numerator: 24, denominator: 1 }, sampleRate: 48000, channels: 2 },
      scenes: [{ id: 'scene', description: 'scene' }],
      shots: [{ id: 'shot', scene: 'scene', look: 'default', intent: 'shot', targetFrames: 48 }],
      placements: [{ id: 'pl', shot: 'shot', source: 'src', inFrame: 0, outFrame: 48, startFrame: 0, audio: 'mute' }],
      transitions: [],
      audio: [],
    },
  });
}

test('Plan resolves a Source endpoint from the user Endpoints and reports missing setup as configuration', async () => {
  await withConfigHome(async home => {
    const root = join(home, 'work');
    await mkdir(root);
    await writeFile(join(root, 'project.json'), JSON.stringify(videoProject()));
    const codes = (issues: { code: string }[]) => issues.map(issue => issue.code);

    let plan = await planBuild(root);
    assert.deepEqual(codes(plan.needsConfiguration), ['video-endpoint-not-configured']);
    assert.match(plan.needsConfiguration[0]!.message, /endpoints\.json/);

    await writeFile(
      join(home, 'endpoints.json'),
      JSON.stringify({
        video: [
          {
            endpoint: 'default',
            service: 'vllm-omni',
            model: 'minimax-h3-base-fl2va',
            url: 'https://api.example.test',
            apiKey: '',
          },
        ],
      }),
    );
    plan = await planBuild(root);
    assert.deepEqual(codes(plan.needsConfiguration), []);

    assert.deepEqual(codes(plan.requiresApproval), ['video-submit-not-authorized']);

    storeCredential(NAME, 'stored-value');
    plan = await planBuild(root);
    assert.deepEqual(codes(plan.needsConfiguration), []);
    assert.deepEqual(codes(plan.requiresApproval), ['video-submit-not-authorized'], 'consent stays per run');

    plan = await planBuild(root, {
      providers: {
        videoApi: { default: { endpoint: { protocol: 'vllm-omni-video', baseUrl: 'http://plaintext.example.test' } } },
      },
    });
    assert.ok(codes(plan.blockers).includes('video-endpoint-invalid'), 'an explicitly passed endpoint wins');

    await writeFile(
      join(home, 'endpoints.json'),
      JSON.stringify({ video: [{ endpoint: 'default', protocol: 'nope' }] }),
    );
    await assert.rejects(() => planBuild(root), /Invalid user endpoint configuration/);
  });
});
