import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedCaptureUrl } from '../src/backends/browser/capture.js';
import { emittedJsPath, isTypeScriptPath } from '../src/backends/browser/transpile.js';

test('isAllowedCaptureUrl uses exact origin, not a prefix match', () => {
  const origin = 'http://127.0.0.1:12345';
  assert.equal(isAllowedCaptureUrl('http://127.0.0.1:12345/index.html', origin), true);
  assert.equal(isAllowedCaptureUrl('http://127.0.0.1:12345/assets/a.png', origin), true);
  assert.equal(isAllowedCaptureUrl('http://127.0.0.1:12345@evil.example/x.png', origin), false);
  assert.equal(isAllowedCaptureUrl('http://127.0.0.1:12345.evil.example/x.png', origin), false);
  assert.equal(isAllowedCaptureUrl('http://127.0.0.1:9999/index.html', origin), false);
  assert.equal(isAllowedCaptureUrl('https://example.com/x.png', origin), false);
  assert.equal(isAllowedCaptureUrl('data:image/png;base64,AAAA', origin), true);
  assert.equal(isAllowedCaptureUrl('blob:http://127.0.0.1:12345/abc', origin), true);
  assert.equal(isAllowedCaptureUrl('about:blank', origin), true);
  assert.equal(isAllowedCaptureUrl('', origin), true);
  assert.equal(isAllowedCaptureUrl('not a url', origin), false);
});

test('emittedJsPath and isTypeScriptPath map staged TypeScript correctly', () => {
  assert.equal(isTypeScriptPath('scene.ts'), true);
  assert.equal(isTypeScriptPath('scenes/view.tsx'), true);
  assert.equal(isTypeScriptPath('index.html'), false);
  assert.equal(isTypeScriptPath('helper.js'), false);
  assert.equal(emittedJsPath('scene.ts'), 'scene.js');
  assert.equal(emittedJsPath('scenes/view.tsx'), 'scenes/view.js');
  assert.equal(emittedJsPath('scenes/a.b.ts'), 'scenes/a.b.js');
});
