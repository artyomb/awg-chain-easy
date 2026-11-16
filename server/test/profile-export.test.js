'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inflateSync } = require('node:zlib');
const { vpnUri, vpnEnvelope, awg31Parameters, attachment } = require('../app/profile-export');

function profile(protocol = 'AWG3') {
  const extra = protocol === 'WG' ? '' : 'Jc = 6\nS1 = 12\nS2 = 12\nS3 = 12\nS4 = 12\nH1 = 10\nH2 = 20\nH3 = 30\nH4 = 40\n';
  const v3 = protocol === 'AWG3' ? 'HeaderProtectionKey = synthetic-header-key\nRandomTrailers = on\nDisableCookies = on\n' : '';
  return `[Interface]\nPrivateKey = synthetic-client-key\nAddress = 10.8.3.2/32\nDNS = 10.8.3.1\nMTU = 1280\n${extra}${v3}[Peer]\nPublicKey = synthetic-server-key\nPresharedKey = synthetic-psk\nEndpoint = 192.0.2.1:51820\nAllowedIPs = 0.0.0.0/0, ::/0\nPersistentKeepalive = 25\n`;
}

test('Qt-compatible vpn URI preserves UTF8 byte length, AWG flags, keys and routes in both representations', () => {
  const conf = profile();
  const uri = vpnUri(conf, { protocol: 'AWG3', serverName: 'Тестовый сервер', clientName: 'Ноут' });
  const bytes = Buffer.from(uri.slice(6), 'base64url'); const decoded = inflateSync(bytes.subarray(4));
  assert.equal(bytes.readUInt32BE(0), decoded.length);
  const outer = JSON.parse(decoded); const meta = outer.containers[0].awg; const inner = JSON.parse(meta.last_config);
  assert.equal(outer.description, 'Тестовый сервер'); assert.equal(outer.defaultContainer, 'amnezia-awg2');
  assert.equal(meta.protocol_version, '3.1'); assert.equal(inner.config, conf);
  for (const value of [meta, inner]) { assert.equal(value.RandomTrailers, 'on'); assert.equal(value.DisableCookies, 'on'); assert.equal(value.HeaderProtectionKey, 'synthetic-header-key'); }
  assert.deepEqual(inner.allowed_ips, ['0.0.0.0/0', '::/0']); assert.equal(inner.client_priv_key, 'synthetic-client-key');
  assert.equal(inner.psk_key, 'synthetic-psk'); assert.equal(outer.dns1, '10.8.3.1'); assert.equal(inner.port, 51820);
});

test('legacy AWG2 and WireGuard export without AWG3-only options', () => {
  for (const protocol of ['AWG2', 'WG']) {
    const e = vpnEnvelope(profile(protocol), { protocol }); const m = e.containers[0][protocol === 'WG' ? 'wireguard' : 'awg'];
    assert.equal(m.RandomTrailers, undefined); assert.equal(JSON.parse(m.last_config).HeaderProtectionKey, undefined);
    assert.equal(m.protocol_version, protocol === 'WG' ? undefined : '2');
  }
});

test('unsafe RandomTrailers combinations and invalid toggles are rejected', () => {
  assert.throws(() => awg31Parameters({ s1: 64, s2: 56, s3: 32, s4: 16, randomTrailers: 'on' }), /equal S1-S4/);
  assert.throws(() => awg31Parameters({ randomTrailers: 'true' }), /on or off/);
  assert.throws(() => vpnEnvelope(profile().replace('HeaderProtectionKey = synthetic-header-key\n', ''), { protocol: 'AWG3' }), /header protection/);
});

test('Unicode download names use ASCII-safe headers and RFC5987 filename', () => {
  const h = attachment('Тестовый сервер - Ноут.conf'); assert.match(h, /filename\*=UTF-8''/);
  assert.ok(!/[^\x20-\x7e]/.test(h)); assert.ok(decodeURIComponent(h.split("UTF-8''")[1]).includes('Тестовый сервер'));
  assert.ok(!attachment('bad\r\nX-Header: x.conf').includes('\n'));
});
