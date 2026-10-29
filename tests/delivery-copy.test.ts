import test from 'node:test';
import assert from 'node:assert/strict';
import { scanDeliveryCopy } from '../src/operations/delivery/portable.js';
import { resolveCredential } from '../src/config/credentials.js';
import { redact } from '../src/shared/process.js';

test('public license, source and endpoint URLs are not delivery credential findings', () => {
  const files = [
    { path: 'LICENSE.txt', text: 'https://openfontlicense.org/\nhttps://opensource.org/license/mit/' },
    { path: 'NOTES.md', text: 'Observed at http://127.0.0.1:8000/v1/models; source https://example.org/art' },
  ];
  assert.deepEqual(scanDeliveryCopy(files, []), []);
  assert.equal(redact('https://example.org/art'), '[remote URL redacted]', 'process logs still hide URLs');
});

test('credential assignments, bearer values and signed URLs still produce value-free findings', () => {
  for (const text of [
    'api_key=fixture-private-key',
    'Authorization: Bearer fixture-private-key',
    'https://example.org/media?token=fixture-private-key',
    'https://example.org/media?X-Amz-Signature=fixture-private-key',
  ]) {
    const findings = scanDeliveryCopy([{ path: 'helper.mjs', text }], []);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'secret');
    assert.ok(!JSON.stringify(findings).includes('fixture-private-key'));
  }
});

test('resolved values and local author paths are still reported without disclosing the value', () => {
  const name = 'VISCRAFT_DELIVERY_SCAN_TEST';
  const previous = process.env[name];
  process.env[name] = 'fixture-resolved-value';
  try {
    resolveCredential(name);
    const findings = scanDeliveryCopy(
      [{ path: 'README.md', text: 'Use /private/author/work with fixture-resolved-value' }],
      ['/private/author/work'],
    );
    assert.deepEqual(
      findings.map(finding => finding.kind),
      ['absolute-path', 'secret'],
    );
    assert.ok(!JSON.stringify(findings).includes('fixture-resolved-value'));
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});
