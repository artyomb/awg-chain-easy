'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { listenPort, portRange, reverseInitiation, peerConnectionLines, withListenPort, connectionStatus } = require('../app/connections');

test('published ranges and fixed ports reject invalid and excessively broad allocations', () => {
  assert.deepEqual(portRange('54323-54330'), [54323, 54324, 54325, 54326, 54327, 54328, 54329, 54330]);
  assert.deepEqual(portRange('54323'), [54323]);
  for (const value of ['0', '65536', '60000-59999', '1000-1008', '1:2', '', '1\n2']) assert.throws(() => portRange(value));
  for (const value of [false, [], {}, -1, 1.2, '2e3', ' 5000', 65536]) assert.throws(() => listenPort(value));
  assert.equal(listenPort(null), 0);
});

test('reverse initiation validates endpoints and keeps server settings separate from exports', () => {
  assert.deepEqual(reverseInitiation({ endpoint: 'vpn.example.com:54323' }), { endpoint: 'vpn.example.com:54323', persistentKeepalive: 25 });
  assert.equal(reverseInitiation({ endpoint: '[2001:db8::1]:54323', persistentKeepalive: 30 }).persistentKeepalive, 30);
  for (const endpoint of ['127.0.0.1:0', '127.0.0.1:65536', '999.1.1.1:12', '-invalid:12', 'host:12\nAllowedIPs = 0.0.0.0/0', '127.0.0.1']) {
    assert.throws(() => reverseInitiation({ endpoint }));
  }
  for (const persistentKeepalive of [0, -1, 1.5, '25', 65536]) {
    assert.throws(() => reverseInitiation({ endpoint: '127.0.0.1:54323', persistentKeepalive }));
  }
  assert.equal(peerConnectionLines(null), '\nPersistentKeepalive = 0');
  assert.equal(peerConnectionLines({ endpoint: '127.0.0.1:54323', persistentKeepalive: 25 }), '\nEndpoint = 127.0.0.1:54323\nPersistentKeepalive = 25');
});

test('port edits preserve the rest of the imported profile', () => {
  const config = '[Interface]\nPrivateKey = fixture\nListenPort = 12345\nAddress = 10.0.0.2/32\n\n[Peer]\nEndpoint = example.com:51820\n';
  const changed = withListenPort(config, 54323);
  assert.equal((changed.match(/ListenPort/g) || []).length, 1);
  assert.ok(changed.includes('ListenPort = 54323\n'));
  assert.equal(withListenPort(changed, 0), withListenPort(config, 0));
  assert.ok(changed.includes('[Peer]\nEndpoint = example.com:51820'));
});

test('connection health distinguishes idle, stale, starting, and unreadable peers', () => {
  const now = 2_000_000;
  const base = { status: 'up', readable: true, now, startedAt: now - 500_000 };
  assert.equal(connectionStatus({ ...base, latestHandshakeAt: new Date(now - 30_000).toISOString() }), 'connected');
  const old = { ...base, latestHandshakeAt: new Date(now - 500_000).toISOString() };
  assert.equal(connectionStatus(old), 'idle');
  assert.equal(connectionStatus({ ...old, persistentKeepalive: 25 }), 'stale');
  assert.equal(connectionStatus({ ...base, persistentKeepalive: 25 }), 'stale');
  assert.equal(connectionStatus({ ...base, startedAt: now - 1000, persistentKeepalive: 25 }), 'awaiting');
  assert.equal(connectionStatus(base), 'awaiting');
  assert.equal(connectionStatus({ ...base, readable: false }), 'unknown');
  assert.equal(connectionStatus({ ...base, persistentKeepalive: NaN }), 'unknown');
  assert.equal(connectionStatus({ ...base, status: 'disabled' }), 'disabled');
  assert.equal(connectionStatus({ ...base, status: 'error' }), 'unavailable');
  assert.equal(connectionStatus({ ...old, persistentKeepalive: 600 }), 'connected');
  assert.equal(connectionStatus({ ...old, persistentKeepalive: 25, rekeyAfterTime: 600 }), 'connected');
});
