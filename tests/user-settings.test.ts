import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadUserEndpoints, loadUserEndpointsReport } from '../src/config/endpoints.js';
import { providerReadiness } from '../src/config/readiness.js';
import { credentialSource, resolveCredential } from '../src/config/credentials.js';
import { supportedConnections } from '../src/config/services.js';
import { prepareVideoRequest } from '../src/backends/providers/prepare.js';
import { redact } from '../src/shared/process.js';
import type { ProviderSource } from '../src/core/schema.js';

async function isolated(fn: (file: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'viscraft-user-settings-'));
  const names = Object.keys(process.env).filter(name => /^VISCRAFT_(VIDEO|IMAGE|CONFIG_HOME)/.test(name));
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.VISCRAFT_CONFIG_HOME = home;
  try {
    await fn(join(home, 'endpoints.json'));
  } finally {
    for (const name of Object.keys(process.env).filter(name => /^VISCRAFT_(VIDEO|IMAGE|CONFIG_HOME)/.test(name)))
      delete process.env[name];
    Object.assign(process.env, previous);
    await rm(home, { recursive: true, force: true });
  }
}
const privateVideo = { service: 'vllm-omni', model: 'minimax-h3-base-ref2va', url: 'http://127.0.0.1:8000' };
const secret = 'fixture-user-config-SECRET-729';

test('the shipped template declares endpoint default and is directly usable by the Runtime', async () => {
  await isolated(async file => {
    const template = await readFile(
      new URL('../../skills/viscraft/references/providers/templates/endpoints.json', import.meta.url),
      'utf8',
    );
    const settings = JSON.parse(template);
    assert.equal(settings.video[0].endpoint, 'default');
    assert.deepEqual(settings.image, []);
    await writeFile(file, template);
    const endpoints = loadUserEndpoints();
    assert.deepEqual(Object.keys(endpoints.video), ['default']);
    assert.equal(endpoints.video.default!.sourceModel, 'minimax-h3-base-ref2va');
  });
});

test('explicit names distinguish two deployments of the same service and model without an implicit selection', async () => {
  await isolated(async file => {
    await writeFile(
      file,
      JSON.stringify({
        video: [
          { endpoint: 'primary', ...privateVideo, apiKey: 'fixture-primary-key' },
          { endpoint: 'backup', ...privateVideo, url: 'http://127.0.0.1:8001', apiKey: 'fixture-backup-key' },
        ],
      }),
      { mode: 0o600 },
    );
    const endpoints = loadUserEndpoints();
    assert.deepEqual(Object.keys(endpoints.video), ['primary', 'backup']);
    assert.equal(endpoints.video.default, undefined);
    assert.equal(endpoints.video.backup!.baseUrl, 'http://127.0.0.1:8001');
    assert.equal(resolveCredential('VISCRAFT_VIDEO_PRIMARY_API_KEY'), 'fixture-primary-key');
    assert.equal(resolveCredential('VISCRAFT_VIDEO_BACKUP_API_KEY'), 'fixture-backup-key');
    assert.ok(!JSON.stringify(providerReadiness()).includes('fixture-primary-key'));
  });
});

test('video and image default endpoints use independent credentials', async () => {
  await isolated(async file => {
    await writeFile(
      file,
      JSON.stringify({
        video: [{ endpoint: 'default', ...privateVideo, apiKey: 'fixture-video-default-key' }],
        image: [
          {
            endpoint: 'default',
            service: 'vllm-omni',
            model: 'Qwen/Qwen-Image',
            url: 'http://127.0.0.1:8003',
            apiKey: 'fixture-image-default-key',
          },
        ],
      }),
      { mode: 0o600 },
    );
    const endpoints = loadUserEndpoints();
    assert.equal(endpoints.video.default!.sourceModel, privateVideo.model);
    assert.equal(endpoints.image.default!.sourceModel, 'Qwen/Qwen-Image');
    assert.equal(endpoints.video.default!.protocol, 'vllm-omni-video');
    assert.equal(endpoints.image.default!.protocol, 'vllm-omni-image');
    assert.equal(resolveCredential('VISCRAFT_VIDEO_API_KEY'), 'fixture-video-default-key');
    assert.equal(resolveCredential('VISCRAFT_IMAGE_API_KEY'), 'fixture-image-default-key');
  });
});

test('duplicate endpoint names are rejected without choosing either route', async () => {
  await isolated(async file => {
    await writeFile(
      file,
      JSON.stringify({
        video: [
          { endpoint: 'default', ...privateVideo },
          { endpoint: 'default', ...privateVideo, url: 'http://127.0.0.1:8001' },
          { endpoint: 'other', ...privateVideo },
        ],
      }),
    );
    const report = loadUserEndpointsReport();
    assert.match(report.errors.join(' '), /duplicate endpoint/);
    assert.deepEqual(Object.keys(report.endpoints.video), ['other']);
    assert.throws(() => loadUserEndpoints(), /duplicate endpoint/);
  });
});

test('published model identifiers preserve namespaces and versions on the wire', async () => {
  await isolated(async file => {
    await writeFile(
      file,
      JSON.stringify({
        video: [{ endpoint: 'default', service: 'fal', model: 'alibaba/wan-3.0/image-to-video' }],
        image: [{ endpoint: 'default', service: 'vllm-omni', model: ' qWeN/QwEn-ImAgE ', url: privateVideo.url }],
      }),
    );
    const endpoints = loadUserEndpoints();
    assert.equal(endpoints.video.default!.sourceModel, 'alibaba/wan-3.0/image-to-video');
    assert.equal(endpoints.video.default!.model, 'alibaba/wan-3.0/image-to-video');
    assert.equal(endpoints.image.default!.model, 'Qwen/Qwen-Image');
    assert.equal(endpoints.image.default!.sourceModel, 'Qwen/Qwen-Image');
    for (const [medium, model] of [
      ['video', 'wan-3.0-image-to-video'],
      ['image', 'qwen-image'],
      ['image', 'Qwen/Qwen-Image-2512'],
      ['image', 'Qwen/Qwen-Image-Edit-2511'],
    ] as const) {
      await writeFile(
        file,
        JSON.stringify({
          [medium]: [
            { endpoint: 'default', service: medium === 'video' ? 'fal' : 'vllm-omni', model, url: privateVideo.url },
          ],
        }),
      );
      assert.throws(() => loadUserEndpoints(), /Unsupported service\/model combination/);
    }
  });
});

test('only connection lists with explicit endpoint fields are accepted', async () => {
  await isolated(async file => {
    for (const video of [
      { default: privateVideo },
      [{ ...privateVideo }],
      [{ endpoint: secret, ...privateVideo }],
      [{ endpoint: 'constructor', ...privateVideo }],
    ]) {
      await writeFile(file, JSON.stringify({ video }));
      assert.throws(() => loadUserEndpoints());
      assert.ok(!JSON.stringify(providerReadiness()).includes(secret));
    }
  });
});

test('JSON choices resolve to a model-specific adapter without taskType or a secret in provider options', async () => {
  await isolated(async file => {
    await writeFile(
      file,
      JSON.stringify({
        video: [{ endpoint: 'default', ...privateVideo, service: ' VLLM-OMNI ', model: ' MiniMax-H3-Base-Ref2VA ' }],
      }),
    );
    const endpoint = loadUserEndpoints().video.default!;
    assert.equal(endpoint.protocol, 'vllm-omni-video');
    assert.equal(endpoint.sourceModel, 'minimax-h3-base-ref2va');
    assert.equal(endpoint.model, 'MiniMax-H3');
    assert.equal(endpoint.modelSettings, undefined);
    assert.equal(endpoint.credential, undefined);
    assert.equal(providerReadiness().capabilities.provider.endpoints[0]!.credentialSource, 'unknown');
  });
});

test('private JSON key resolves only at the credential boundary and status never returns it', async () => {
  await isolated(async file => {
    await writeFile(
      file,
      JSON.stringify({ video: [{ endpoint: 'default', service: 'minimax', model: 'minimax-h3', apiKey: secret }] }),
      { mode: 0o600 },
    );
    const options = loadUserEndpoints();
    assert.ok(!JSON.stringify(options).includes(secret));
    assert.equal(options.video.default!.sourceModel, 'MiniMax-H3');
    assert.equal(options.video.default!.baseUrl, 'https://api.minimax.io');
    assert.equal(credentialSource('VISCRAFT_VIDEO_API_KEY'), 'configuration');
    const status = providerReadiness();
    assert.equal(status.capabilities.provider.ready, true);
    assert.ok(!JSON.stringify(status).includes(secret));
    const cli = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'auth', 'status'],
      {
        env: process.env,
        encoding: 'utf8',
      },
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.ok(!`${cli.stdout}${cli.stderr}`.includes(secret));
    assert.equal(resolveCredential('VISCRAFT_VIDEO_API_KEY'), secret);
    assert.equal(redact(`unexpected echo ${secret}`), 'unexpected echo [REDACTED]');
  });
});

test('key-bearing JSON must be owner-private on POSIX', { skip: process.platform === 'win32' }, async () => {
  await isolated(async file => {
    await writeFile(file, JSON.stringify({ video: [{ endpoint: 'default', ...privateVideo, apiKey: secret }] }), {
      mode: 0o600,
    });
    await chmod(file, 0o644);
    assert.throws(() => loadUserEndpoints(), /chmod 600/);
    assert.equal(providerReadiness().capabilities.provider.ready, false);
    assert.ok(!JSON.stringify(providerReadiness()).includes(secret));
  });
});

test('environment-only configuration and key-only overrides use the same schema', async () => {
  await isolated(async file => {
    process.env.VISCRAFT_VIDEO_SERVICE = 'vllm-omni';
    process.env.VISCRAFT_VIDEO_MODEL = 'minimax-h3-base-fl2va';
    process.env.VISCRAFT_VIDEO_URL = 'http://127.0.0.1:8002';
    assert.equal(loadUserEndpoints().video.default!.sourceModel, 'minimax-h3-base-fl2va');
    delete process.env.VISCRAFT_VIDEO_SERVICE;
    delete process.env.VISCRAFT_VIDEO_MODEL;
    delete process.env.VISCRAFT_VIDEO_URL;
    await writeFile(
      file,
      JSON.stringify({ video: [{ endpoint: 'default', service: 'minimax', model: 'minimax-h3', apiKey: secret }] }),
      { mode: 0o600 },
    );
    process.env.VISCRAFT_VIDEO_API_KEY = 'fixture-environment-override';
    assert.equal(loadUserEndpoints().video.default!.protocol, 'minimax-video-v2');
    assert.equal(resolveCredential('VISCRAFT_VIDEO_API_KEY'), 'fixture-environment-override');
    assert.equal(credentialSource('VISCRAFT_VIDEO_API_KEY'), 'environment');
  });
});

test('a route override cannot forward the old JSON account key to a new destination', async () => {
  await isolated(async file => {
    await writeFile(
      file,
      JSON.stringify({ video: [{ endpoint: 'default', service: 'minimax', model: 'minimax-h3', apiKey: secret }] }),
      { mode: 0o600 },
    );
    process.env.VISCRAFT_VIDEO_SERVICE = 'runway';
    process.env.VISCRAFT_VIDEO_MODEL = 'gen4.5';
    process.env.VISCRAFT_VIDEO_URL = 'https://different.example.test';
    const result = providerReadiness();
    assert.equal(result.capabilities.provider.ready, false);
    assert.equal(result.capabilities.provider.endpoints[0]!.credentialSource, 'missing');
    assert.equal(resolveCredential('VISCRAFT_VIDEO_API_KEY'), undefined);
    delete process.env.VISCRAFT_VIDEO_SERVICE;
    delete process.env.VISCRAFT_VIDEO_MODEL;
    assert.throws(() => loadUserEndpoints(), /invalid service, model/);
  });
});

test('two separately deployed Base models can be configured by name without a routing service', async () => {
  await isolated(async () => {
    process.env.VISCRAFT_VIDEO_REFERENCE_SERVICE = 'vllm-omni';
    process.env.VISCRAFT_VIDEO_REFERENCE_MODEL = 'minimax-h3-base-ref2va';
    process.env.VISCRAFT_VIDEO_REFERENCE_URL = 'http://127.0.0.1:8000';
    process.env.VISCRAFT_VIDEO_KEYFRAMES_SERVICE = 'vllm-omni';
    process.env.VISCRAFT_VIDEO_KEYFRAMES_MODEL = 'minimax-h3-base-fl2va';
    process.env.VISCRAFT_VIDEO_KEYFRAMES_URL = 'http://127.0.0.1:8001';
    const endpoints = loadUserEndpoints();
    assert.equal(endpoints.video.reference!.sourceModel, 'minimax-h3-base-ref2va');
    assert.equal(endpoints.video.keyframes!.sourceModel, 'minimax-h3-base-fl2va');
    assert.equal(Object.keys(endpoints.video).length, 2);
  });
});

test('named deployment aliases and keys do not create phantom connections in either medium', async () => {
  await isolated(async () => {
    process.env.VISCRAFT_VIDEO_STORY_SERVICE = 'ark';
    process.env.VISCRAFT_VIDEO_STORY_MODEL = 'seedance-2.5';
    process.env.VISCRAFT_VIDEO_STORY_DEPLOYMENT_MODEL = 'ep-CaseSensitiveFixture';
    process.env.VISCRAFT_VIDEO_STORY_API_KEY = secret;
    process.env.VISCRAFT_IMAGE_PRODUCT_SHOTS_SERVICE = 'vllm-omni';
    process.env.VISCRAFT_IMAGE_PRODUCT_SHOTS_MODEL = 'Qwen/Qwen-Image';
    process.env.VISCRAFT_IMAGE_PRODUCT_SHOTS_URL = 'http://127.0.0.1:8003';
    process.env.VISCRAFT_IMAGE_PRODUCT_SHOTS_DEPLOYMENT_MODEL = 'Qwen-Image-Deployed';
    const endpoints = loadUserEndpoints();
    assert.deepEqual(Object.keys(endpoints.video), ['story']);
    assert.deepEqual(Object.keys(endpoints.image), ['product_shots']);
    assert.equal(endpoints.video.story!.model, 'ep-CaseSensitiveFixture');
    assert.equal(endpoints.image.product_shots!.model, 'Qwen-Image-Deployed');
    assert.equal(resolveCredential('VISCRAFT_VIDEO_STORY_API_KEY'), secret);
    assert.ok(!JSON.stringify(providerReadiness()).includes(secret));
  });
});

test('a JSON connection accepts a named environment key without inventing an API connection', async () => {
  await isolated(async file => {
    await writeFile(
      file,
      JSON.stringify({ video: [{ endpoint: 'account_api', service: 'minimax', model: 'minimax-h3' }] }),
    );
    process.env.VISCRAFT_VIDEO_ACCOUNT_API_API_KEY = secret;
    assert.deepEqual(Object.keys(loadUserEndpoints().video), ['account_api']);
    assert.equal(resolveCredential('VISCRAFT_VIDEO_ACCOUNT_API_API_KEY'), secret);
  });
});

test('ambiguous environment names reject affected routes instead of selecting the wrong deployment', async () => {
  await isolated(async file => {
    await writeFile(file, JSON.stringify({ video: [{ endpoint: 'unaffected', ...privateVideo }] }));
    process.env.VISCRAFT_VIDEO_STORY_SERVICE = 'ark';
    process.env.VISCRAFT_VIDEO_STORY_MODEL = 'seedance-2.5';
    process.env.VISCRAFT_VIDEO_STORY_DEPLOYMENT_MODEL = 'ep-fixture';
    process.env.VISCRAFT_VIDEO_STORY_DEPLOYMENT_SERVICE = 'minimax';
    const report = loadUserEndpointsReport();
    assert.deepEqual(Object.keys(report.endpoints.video), ['unaffected']);
    assert.match(report.errors.join(' '), /matches multiple connection names/);
    assert.throws(() => loadUserEndpoints(), /rename a connection/);
  });
});

test('partial named environment configuration remains an error with no secret values', async () => {
  await isolated(async () => {
    process.env.VISCRAFT_VIDEO_STORY_DEPLOYMENT_MODEL = secret;
    const report = loadUserEndpointsReport();
    assert.match(report.errors.join(' '), /video\.story: invalid service, model/);
    assert.ok(!JSON.stringify(report).includes(secret));
    assert.ok(!JSON.stringify(report).includes('story_deployment'));
  });
});

test('invalid models, unsupported protocol fields and insecure addresses fail without leaking user input', async () => {
  await isolated(async file => {
    for (const entry of [
      { ...privateVideo, model: secret },
      { ...privateVideo, service: secret },
      { ...privateVideo, taskType: secret },
      { protocol: 'vllm-omni-video', baseUrl: 'http://127.0.0.1:8000' },
      { ...privateVideo, url: 'http://remote.example.test' },
      { service: 'minimax', model: 'seedance-2.5' },
      { service: 'vllm-omni', model: 'minimax-h3', url: privateVideo.url },
    ]) {
      await writeFile(file, JSON.stringify({ video: [{ endpoint: 'default', ...entry }] }));
      assert.throws(() => loadUserEndpoints());
      assert.ok(!JSON.stringify(providerReadiness()).includes(secret));
    }
    await writeFile(file, `{"video": {"default": {"apiKey": "${secret}", broken`);
    assert.throws(
      () => loadUserEndpoints(),
      error => !String(error).includes(secret),
    );
  });
});

test('one broken connection does not hide other configured connections from diagnostics', async () => {
  await isolated(async file => {
    await writeFile(
      file,
      JSON.stringify({
        video: [
          { endpoint: 'default', ...privateVideo },
          { endpoint: 'invalid', service: 'unsupported', model: 'bad' },
        ],
        image: [{ endpoint: 'default', service: 'vllm-omni', model: 'Qwen/Qwen-Image', url: 'http://127.0.0.1:8003' }],
      }),
    );
    assert.equal(loadUserEndpointsReport().endpoints.video.default!.sourceModel, privateVideo.model);
    const status = providerReadiness();
    assert.equal(status.capabilities.provider.ready, true);
    assert.equal(status.capabilities['image-generation'].ready, true);
    assert.match(status.error!, /invalid/);
    assert.throws(() => loadUserEndpoints(), /invalid/);
  });
});

test('the configured model cannot be bypassed by an arbitrary authoring model name', async () => {
  await isolated(async file => {
    await writeFile(file, JSON.stringify({ video: [{ endpoint: 'default', ...privateVideo }] }));
    const source: ProviderSource = {
      id: 'shot',
      kind: 'provider',
      output: 'picture',
      endpoint: 'default',
      model: 'unregistered-model',
      prompt: 'p',
      mode: 'text',
      references: [],
      requestedFrames: 96,
      fps: 24,
      size: '1344:768',
      attempt: 'a1',
    };
    assert.throws(
      () => prepareVideoRequest(source, { endpoint: loadUserEndpoints().video.default! }),
      /configured model.*does not match/,
    );
  });
});

test('the supported list is derived from registered definitions and keeps official and Base identities separate', () => {
  const list = supportedConnections();
  assert.ok(list.some(entry => entry.service === 'minimax' && entry.sourceModel === 'MiniMax-H3'));
  assert.deepEqual(
    list
      .filter(entry => entry.service === 'vllm-omni' && entry.medium === 'video')
      .map(entry => entry.model)
      .sort(),
    ['minimax-h3-base-fl2va', 'minimax-h3-base-ref2va'],
  );
});
