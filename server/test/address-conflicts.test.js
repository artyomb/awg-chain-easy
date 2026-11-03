'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');

test('client and upstream address reservations through the live API', { timeout: 90_000 }, async (t) => {
  const password = crypto.randomBytes(24).toString('base64url');
  const passwordHash = execFileSync('node', ['/app/hash-password.js'], { input: password, encoding: 'utf8' }).trim();
  const service = spawn('/usr/local/bin/awg-chain-easy-entrypoint', [], {
    detached: true,
    env: { ...process.env, WG_HOST: '127.0.0.1', WG_PERSISTENT_KEEPALIVE: '0', PASSWORD_HASH: passwordHash },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  service.stdout.on('data', (data) => { output += data; });
  service.stderr.on('data', (data) => { output += data; });
  t.after(async () => {
    if (service.exitCode !== null || service.signalCode !== null) return;
    const closed = new Promise((resolve) => service.once('exit', resolve));
    process.kill(-service.pid, 'SIGTERM');
    const timeout = setTimeout(() => {
      try { process.kill(-service.pid, 'SIGKILL'); } catch (_) { /* Already exited. */ }
    }, 8000);
    timeout.unref();
    await closed;
    clearTimeout(timeout);
  });
  const base = 'http://127.0.0.1:51821';
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { ready = (await fetch(`${base}/api/health`)).ok; } catch (_) { /* Starting. */ }
    if (ready) break;
    if (service.exitCode !== null) break;
    await delay(100);
  }
  assert.ok(ready, 'isolated test service must become healthy');
  assert.ok(output.includes('Web UI listening'), 'service must complete startup');
  const login = await fetch(`${base}/api/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  async function api(url, method = 'GET', body, expected = 200) {
    const response = await fetch(`${base}${url}`, {
      method, headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.status, expected, `${method} ${url}: unexpected status`);
    return response;
  }
  async function create(name, protocol = 'AWG3') {
    return (await api('/api/wireguard/client', 'POST', { name, protocol }, 201)).json();
  }
  async function clients() { return (await api('/api/wireguard/client')).json(); }
  const fixture = await create('profile-fixture');
  const exported = await (await api(`/api/wireguard/client/${fixture.id}/configuration`)).text();
  const template = exported.replace(/^Endpoint = .+$/m, 'Endpoint = 127.0.0.1:59999');
  const profile = (address) => template.replace(/^Address = .+$/m, `Address = ${address}/32`);
  await api(`/api/wireguard/client/${fixture.id}`, 'DELETE');
  async function upstream(name, address, expected = 201) {
    return (await api('/api/routing/upstreams', 'POST', { name, config: profile(address) }, expected)).json();
  }

  let firstUpstream;
  let art;
  await t.test('reserves an imported upstream before allocating clients', async () => {
    firstUpstream = await upstream('first-upstream', '10.8.3.2');
    art = await create('art');
    const bol = await create('bol');
    const list = await clients();
    assert.equal(list.find((c) => c.id === art.id).address, '10.8.3.3');
    assert.equal(list.find((c) => c.id === bol.id).address, '10.8.3.4');
    await api(`/api/wireguard/client/${bol.id}`, 'DELETE');
    const recreated = await create('bol');
    assert.equal((await clients()).find((c) => c.id === recreated.id).address, '10.8.3.4');
  });

  await t.test('disabled upstreams continue reserving their addresses', async () => {
    await api(`/api/routing/upstreams/${firstUpstream.id}/disable`, 'POST');
    const created = await create('while-upstream-disabled');
    assert.notEqual((await clients()).find((c) => c.id === created.id).address, '10.8.3.2');
    await api(`/api/routing/upstreams/${firstUpstream.id}/enable`, 'POST');
  });

  await t.test('rejects server, enabled client, disabled client, and upstream collisions', async () => {
    for (const address of ['10.8.3.1', '10.8.4.1', '10.8.5.1', '10.8.3.2', '10.8.3.3', '010.008.003.002']) {
      const result = await upstream(`conflict-${address}`, address, 409);
      assert.match(result.error, /already used/);
    }
    await api(`/api/wireguard/client/${art.id}/disable`, 'POST');
    await upstream('disabled-client-conflict', '10.8.3.3', 409);
    await api(`/api/wireguard/client/${art.id}/enable`, 'POST');
  });

  await t.test('reserves upstream addresses in all inbound protocol pools', async () => {
    await upstream('awg2-pool', '10.8.4.2');
    await upstream('native-pool', '10.8.5.2');
    const legacy = await create('legacy', 'AWG2');
    const native = await create('native', 'WG');
    const list = await clients();
    assert.equal(list.find((c) => c.id === legacy.id).address, '10.8.4.3');
    assert.equal(list.find((c) => c.id === native.id).address, '10.8.5.3');
  });

  await t.test('concurrent client creation allocates unique addresses and names', async () => {
    await Promise.all(Array.from({ length: 6 }, (_, index) => create(`parallel-${index}`)));
    const list = await clients();
    assert.equal(new Set(list.map((c) => c.address)).size, list.length);
    const responses = await Promise.all(Array.from({ length: 2 }, () => fetch(`${base}/api/wireguard/client`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'same-name', protocol: 'AWG3' }),
    })));
    assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  });

  await t.test('concurrent upstream import and client creation cannot claim the same address', async () => {
    const used = new Set((await clients()).map((c) => c.address));
    used.add('10.8.3.2');
    let candidate;
    for (let index = 2; index < 255; index += 1) {
      if (!used.has(`10.8.3.${index}`)) { candidate = `10.8.3.${index}`; break; }
    }
    const responses = await Promise.all([
      fetch(`${base}/api/routing/upstreams`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ name: 'racing-upstream', config: profile(candidate) }) }),
      fetch(`${base}/api/wireguard/client`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ name: 'racing-client' }) }),
    ]);
    assert.equal(responses[1].status, 201);
    assert.ok([201, 409].includes(responses[0].status));
    const client = (await clients()).find((c) => c.name === 'racing-client');
    if (responses[0].status === 201) assert.notEqual(client.address, candidate);
    else assert.equal(client.address, candidate);
  });

  await t.test('unreadable disabled upstream configuration blocks unsafe allocation', async () => {
    await api(`/api/routing/upstreams/${firstUpstream.id}/disable`, 'POST');
    const file = path.join('/etc/wireguard/upstreams', `${firstUpstream.id}.conf`);
    fs.renameSync(file, `${file}.test-backup`);
    try {
      await api('/api/wireguard/client', 'POST', { name: 'must-not-allocate' }, 409);
    } finally { fs.renameSync(`${file}.test-backup`, file); }
    await api(`/api/routing/upstreams/${firstUpstream.id}/enable`, 'POST');
  });

  await t.test('re-enabling a conflicting stored upstream is rejected before interface creation', async () => {
    await api(`/api/routing/upstreams/${firstUpstream.id}/disable`, 'POST');
    const file = path.join('/etc/wireguard/upstreams', `${firstUpstream.id}.conf`);
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, profile('10.8.3.3'), { mode: 0o600 });
    try {
      await api(`/api/routing/upstreams/${firstUpstream.id}/enable`, 'POST', undefined, 409);
      const addresses = JSON.parse(execFileSync('ip', ['-j', '-4', 'address', 'show'], { encoding: 'utf8' }));
      assert.ok(!addresses.some((entry) => entry.ifname === 'au0'));
    } finally { fs.writeFileSync(file, original, { mode: 0o600 }); }
    await api(`/api/routing/upstreams/${firstUpstream.id}/enable`, 'POST');
  });

  await t.test('deleting the upstream releases its address', async () => {
    await api(`/api/routing/upstreams/${firstUpstream.id}`, 'DELETE');
    const released = await create('released-address');
    assert.equal((await clients()).find((c) => c.id === released.id).address, '10.8.3.2');
    assert.equal((await (await api('/api/health')).json()).status, 'healthy');
  });
});
