/**
 * Private-address classification uses the hostname normalized by URL, including
 * hex IPv4-mapped and IPv4-compatible IPv6. Public addresses remain usable.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { isPrivateAddress } from '../src/backends/providers/address.js';

/** Classify exactly as the download guards do: the `URL`-normalized hostname. */
function privateViaUrl(url: string): boolean {
  return isPrivateAddress(new URL(url).hostname);
}

const MAPPED_COMPATIBLE_PRIVATE = [
  'http://[::ffff:169.254.169.254]/', // cloud metadata
  'http://[::ffff:127.0.0.1]/', // loopback
  'http://[::ffff:10.0.0.1]/', // RFC 1918
  'http://[::ffff:192.168.1.1]/', // RFC 1918
  'http://[::ffff:224.0.0.1]/', // multicast
  'http://[0:0:0:0:0:ffff:169.254.169.254]/', // expanded mapped
  'http://[::127.0.0.1]/', // IPv4-compatible (deprecated, still routes)
];

test('IPv4-mapped / compatible IPv6 is refused in the hex form new URL() emits', () => {
  for (const url of MAPPED_COMPATIBLE_PRIVATE) {
    assert.equal(privateViaUrl(url), true, `${url} must be classified private`);
  }
});

test('genuine IPv6 private ranges and the unspecified/loopback forms stay refused', () => {
  assert.equal(privateViaUrl('http://[fe80::1]/'), true, 'link-local fe80::/10');
  assert.equal(privateViaUrl('http://[fc00::1]/'), true, 'unique-local fc00::/7');
  assert.equal(privateViaUrl('http://[fd12:3456::1]/'), true, 'unique-local fd00::/8');
  assert.equal(privateViaUrl('http://[ff02::1]/'), true, 'multicast ff00::/8');
  assert.equal(privateViaUrl('http://[::]/'), true, 'unspecified ::');
  assert.equal(privateViaUrl('http://[::1]/'), true, 'loopback ::1');
});

test('public IPv6 and public IPv4 stay public', () => {
  assert.equal(privateViaUrl('http://[2606:4700::1111]/'), false, 'public IPv6');
  assert.equal(privateViaUrl('http://[2001:4860:4860::8888]/'), false, 'public IPv6');
  assert.equal(isPrivateAddress('93.184.216.34'), false, 'public IPv4');
  assert.equal(isPrivateAddress('8.8.8.8'), false, 'public IPv4');
});

test('plain dotted forms and mapped-public forms are unchanged', () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.1.1',
    '100.64.0.1',
    '224.0.0.1',
  ]) {
    assert.equal(isPrivateAddress(address), true, `${address} must stay private`);
  }
  for (const address of ['93.184.216.34', '8.8.8.8', '1.1.1.1']) {
    assert.equal(isPrivateAddress(address), false, `${address} must stay public`);
  }
  // Dotted mapped forms (the only ones the old regex saw) must still resolve.
  assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true, 'dotted mapped loopback');
  assert.equal(isPrivateAddress('0:0:0:0:0:ffff:224.0.0.1'), true, 'dotted expanded mapped multicast');
  assert.equal(isPrivateAddress('::ffff:8.8.8.8'), false, 'dotted mapped public stays public');
  // Case-insensitivity of the hex form.
  assert.equal(isPrivateAddress('[::FFFF:7F00:1]'), true, 'uppercase hex mapped loopback');
  // Unparseable stays unsafe.
  assert.equal(isPrivateAddress('not-an-address'), true, 'unparseable is unsafe');
});
