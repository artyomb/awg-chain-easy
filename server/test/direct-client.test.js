'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RoutingManager } = require('../app/routing');
const make = (addresses) => {
  const r = new RoutingManager({ inboundInterfaces: ['awg3','awg2','wg-native'], downstreamNetworks: ['10.8.3.0/24'],
    downstreamAddresses: () => [], directClientAddresses: () => addresses, mtu: 1280, dnsUpstream: '1.1.1.1' });
  r.state = { defaultRoute: { type: 'blocked' }, upstreams: {}, policies: {} };return r;
};
test('direct client source exception precedes destination policies and existing marks', () => {
  const s = make(['10.8.3.5']).nftScript();
  assert.ok(s.includes('elements = { 10.8.3.5 }'));
  assert.ok(s.indexOf('ip saddr @direct_clients_v4') < s.indexOf('ct mark != 0 return'));
  assert.ok(s.includes('ip saddr @direct_clients_v4 meta mark set 0x100 ct mark set meta mark return'));
  assert.ok(s.includes('meta mark set 0x2ff ct mark set meta mark'));
});
test('atomic set synchronization removes deleted or disabled client exceptions', async () => {
  assert.ok(make([]).nftScript().includes('set direct_clients_v4 { type ipv4_addr; }'));
  const addresses = ['10.8.3.5']; const r = make(addresses); let script;
  r.applyNftScript = (s) => { script = s; return { status: 0 }; };
  await r.syncDirectClients(); assert.ok(script.includes('add element'));
  addresses.pop(); await r.syncDirectClients(); assert.ok(script.startsWith('flush set'));assert.ok(!script.includes('add element'));
  r.applyNftScript = () => ({ status: 1 });await assert.rejects(r.syncDirectClients(), /Unable to apply/);
});
test('only valid IPv4 addresses can enter source rules', () => {
  assert.throws(() => make(['10.8.3.5; accept']).nftScript(), /Invalid direct client/);
});
