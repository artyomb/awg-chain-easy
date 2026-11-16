'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { inflateSync } = require('node:zlib');
const fs = require('node:fs');
const http = require('node:http');

test('AWG3.1 flags and named vpn exports through authenticated live API', { timeout: 45000 }, async (t) => {
  const password = crypto.randomBytes(24).toString('base64url');
  const hash = execFileSync('node', ['/app/hash-password.js'], { input: password, encoding: 'utf8' }).trim();
  const child = spawn('/usr/local/bin/awg-chain-easy-entrypoint', [], { detached: true,
    env: { ...process.env, WG_HOST: '192.0.2.1', PASSWORD_HASH: hash, VPN_SERVER_NAME: 'Тестовый сервер',
      AWG3_RANDOM_TRAILERS: 'on', AWG3_DISABLE_COOKIES: 'on', S1: '12', S2: '12', S3: '12', S4: '12' },
    stdio: 'ignore' });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const done = new Promise((resolve) => child.once('exit', resolve));
    process.kill(-child.pid, 'SIGTERM'); const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {} }, 5000);
    await done; clearTimeout(timer);
  });
  const base = 'http://127.0.0.1:51821'; let ready = false;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/health')).ok) { ready = true; break; } } catch (_) {} await delay(100); }
  assert.ok(ready, 'isolated service initializes with equal S and both flags');
  const login = await fetch(base + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie').split(';')[0];
  const settingsCall = (method, body) => fetch(base + '/api/settings', { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await fetch(base + '/api/settings')).status, 401);
  const originalSettings = await (await settingsCall('GET')).json();
  assert.equal(originalSettings.serverName, 'Тестовый сервер');
  assert.equal((await settingsCall('PUT', { dnsUpstreams: ['127.0.0.1'] })).status, 400);
  assert.equal((await settingsCall('PUT', { serverName: 'Тест GUI', qrFormat: 'amnezia' })).status, 200);
  assert.equal((await (await settingsCall('GET')).json()).qrFormat, 'amnezia');
  assert.equal((await settingsCall('PUT', originalSettings)).status, 200);
  let awgConfig;
  for (const protocol of ['AWG3', 'AWG2', 'WG']) {
    const create = await fetch(base + '/api/wireguard/client', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Ноут-' + protocol, protocol }) });
    assert.equal(create.status, 201); const { id } = await create.json(); const url = base + '/api/wireguard/client/' + id;
    assert.equal((await fetch(url + '/configuration.vpn')).status, 401);
    const confReply = await fetch(url + '/configuration', { headers: { Cookie: cookie } });
    assert.equal(confReply.status, 200); const conf = await confReply.text(); assert.ok(conf.startsWith('# Тестовый сервер'));
    if (protocol !== 'WG') assert.ok(confReply.headers.get('content-disposition').includes("filename*=UTF-8''"));
    const reply = await fetch(url + '/configuration.vpn', { headers: { Cookie: cookie } }); assert.equal(reply.status, 200);
    const bytes = Buffer.from((await reply.text()).trim().slice(6), 'base64url');
    const raw = inflateSync(bytes.subarray(4)); assert.equal(raw.length, bytes.readUInt32BE(0));
    const envelope = JSON.parse(raw); const meta = envelope.containers[0][protocol === 'WG' ? 'wireguard' : 'awg'];
    assert.equal(JSON.parse(meta.last_config).config, conf); assert.equal(envelope.description, 'Тестовый сервер');
    if (protocol === 'AWG3') {
      assert.equal((await settingsCall('PUT', { serverName: 'Новое имя GUI' })).status, 200);
      const changedConf = await (await fetch(url + '/configuration', { headers: { Cookie: cookie } })).text();
      assert.ok(changedConf.startsWith('# Новое имя GUI'));
      assert.equal(changedConf.split('\n').slice(1).join('\n'), conf.split('\n').slice(1).join('\n'));
      const qr = await fetch(url + '/qrcode.amnezia', { headers: { Cookie: cookie } }); assert.equal(qr.status,200);assert.ok((await qr.json()).frames.length>=1);
      assert.equal((await settingsCall('PUT', { dnsUpstreams: ['8.8.8.8','1.1.1.1'] })).status,200);
      assert.equal((await (await fetch(base+'/api/routing',{headers:{Cookie:cookie}})).json()).dns.upstream,'8.8.8.8');
      assert.equal((await settingsCall('PUT', originalSettings)).status,200);
    }
    if (protocol === 'AWG3') { awgConfig = conf; assert.match(conf, /RandomTrailers = on/); assert.match(conf, /DisableCookies = on/); assert.equal(meta.RandomTrailers, 'on'); }
    else { assert.ok(!conf.includes('RandomTrailers')); assert.equal(meta.RandomTrailers, undefined); }
  }
  const createDirect = await fetch(base + '/api/wireguard/client', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Direct isolated test', protocol: 'AWG3', egress: 'direct' }) });
  assert.equal(createDirect.status, 201); const directId = (await createDirect.json()).id;
  const getClients = async () => (await fetch(base + '/api/wireguard/client', { headers: { Cookie: cookie } })).json();
  const direct = (await getClients()).find((c) => c.id === directId); assert.equal(direct.egress, 'direct');
  const originalState = JSON.parse(fs.readFileSync('/etc/wireguard/wg0.json', 'utf8')).clients[directId];
  const rename = (name) => fetch(base + '/api/wireguard/client/' + directId, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  assert.equal((await rename('  Новое имя  ')).status, 200);
  const renamedState = JSON.parse(fs.readFileSync('/etc/wireguard/wg0.json', 'utf8')).clients[directId];
  assert.equal(renamedState.name, 'Новое имя');
  for (const key of Object.keys(originalState).filter((k) => !['name', 'updatedAt'].includes(k))) assert.deepEqual(renamedState[key], originalState[key], 'rename preserves ' + key);
  for (const invalid of ['', ' ', 'x'.repeat(65), null]) assert.equal((await rename(invalid)).status, 400);
  assert.equal((await rename('Ноут-AWG3')).status, 409);
  assert.equal((await fetch(base + '/api/wireguard/client/' + directId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Unauthorized' }) })).status, 401);
  const renamedExport = await fetch(base + '/api/wireguard/client/' + directId + '/configuration', { headers: { Cookie: cookie } });
  assert.equal(renamedExport.status, 200);
  assert.ok(decodeURIComponent(renamedExport.headers.get('content-disposition')).includes('Новое имя'));
  const upstreamConfig = awgConfig.replace(/^Address = .*$/m, 'Address = 10.99.0.2/32');
  const upstreamReply = await fetch(base + '/api/routing/upstreams', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Pinned isolated', config: upstreamConfig }) });
  assert.equal(upstreamReply.status, 201);const upstreamId=(await upstreamReply.json()).id;
  const resetUrl=base+'/api/routing/upstreams/statistics/reset';
  assert.equal((await fetch(resetUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:true})})).status,401);
  assert.equal((await fetch(resetUrl,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'})).status,400);
  assert.equal((await fetch(resetUrl,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({confirm:true})})).status,200);
  assert.ok(fs.readdirSync('/etc/wireguard').some(f=>f.startsWith('upstream-statistics.json.before-reset-')));
  const editMode = (body) => fetch(base + '/api/wireguard/client/' + directId, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({name:'Новое имя',...body}) });
  assert.equal((await editMode({egress:'upstream',upstreamId})).status,200);
  const pin=(await getClients()).find(c=>c.id===directId);assert.equal(pin.upstreamId,upstreamId);assert.equal(pin.egress,'upstream');
  const pinnedState = JSON.parse(fs.readFileSync('/etc/wireguard/wg0.json','utf8')).clients[directId];
  for(const key of ['privateKey','publicKey','preSharedKey','address','protocol','createdAt'])assert.deepEqual(pinnedState[key],originalState[key]);
  assert.ok(execFileSync('nft',['list','set','inet','awg_chain_easy','client_upstream_0'],{encoding:'utf8'}).includes(direct.address));
  assert.equal((await editMode({egress:'upstream',upstreamId:'missing'})).status,400);
  assert.equal((await editMode({protocol:'AWG2'})).status,400);
  assert.equal((await fetch(base+'/api/routing/upstreams/'+upstreamId,{method:'DELETE',headers:{Cookie:cookie}})).status,409);
  assert.equal((await editMode({egress:'default'})).status,200);
  assert.ok(!execFileSync('nft',['list','set','inet','awg_chain_easy','client_upstream_0'],{encoding:'utf8'}).includes(direct.address));
  assert.equal((await editMode({egress:'direct'})).status,200);
  assert.equal((await fetch(base+'/api/routing/upstreams/'+upstreamId,{method:'DELETE',headers:{Cookie:cookie}})).status,200);
  const directSet = () => execFileSync('nft', ['list', 'set', 'inet', 'awg_chain_easy', 'direct_clients_v4'], { encoding: 'utf8' });
  assert.ok(directSet().includes(direct.address));
  for (const action of ['disable', 'enable']) {
    assert.equal((await fetch(base + '/api/wireguard/client/' + directId + '/' + action, { method: 'POST', headers: { Cookie: cookie } })).status, 200);
    assert.equal(directSet().includes(direct.address), action === 'enable');
  }
  assert.equal((await fetch(base + '/api/wireguard/client/' + directId, { method: 'DELETE', headers: { Cookie: cookie } })).status, 200);
  assert.ok(!directSet().includes(direct.address));
  const reusedReply = await fetch(base + '/api/wireguard/client', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Reused address default client', protocol: 'AWG3' }) });
  assert.equal(reusedReply.status, 201); const reusedId = (await reusedReply.json()).id;
  const reused = (await getClients()).find((c) => c.id === reusedId);assert.equal(reused.address, direct.address);assert.equal(reused.egress, 'default');assert.ok(!directSet().includes(reused.address));
  // Real encrypted client traffic, not only profile parsing or a healthcheck.
  const holder = spawn('unshare', ['-n', 'node', '/app/namespace-holder.js'], { stdio: ['pipe', 'ignore', 'ignore'] });
  const client = spawn('amneziawg-go', ['-f', 'diag31'], { stdio: 'ignore' });
  const dir = fs.mkdtempSync('/tmp/awg31-test-');
  t.after(() => { client.kill('SIGTERM'); holder.kill('SIGTERM'); fs.rmSync(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 50; i++) {
    if (fs.existsSync('/var/run/amneziawg/diag31.sock') && fs.existsSync(`/proc/${holder.pid}/ns/net`)) break;
    await delay(100);
  }
  assert.notEqual(fs.readlinkSync(`/proc/${holder.pid}/ns/net`), fs.readlinkSync('/proc/self/ns/net'));
  const file = dir + '/diag31.conf';
  fs.writeFileSync(file, awgConfig.replace('192.0.2.1:51820', '127.0.0.1:51820'), { mode: 0o600 });
  fs.writeFileSync(dir + '/stripped', execFileSync('awg-quick', ['strip', file]), { mode: 0o600 });
  execFileSync('awg', ['setconf', 'diag31', dir + '/stripped']);
  execFileSync('ip', ['link', 'set', 'diag31', 'netns', String(holder.pid)]);
  const ns = (args) => execFileSync('nsenter', ['-t', String(holder.pid), '-n', ...args], { encoding: 'utf8', timeout: 10000 });
  ns(['ip', 'address', 'add', '10.8.3.2/32', 'dev', 'diag31']);
  ns(['ip', 'link', 'set', 'diag31', 'mtu', '1280', 'up']);
  ns(['ip', 'route', 'add', '10.8.3.1/32', 'dev', 'diag31']);
  const echo = http.createServer((_, response) => response.end('ENCRYPTED_AWG31_OK'));
  await new Promise((resolve) => echo.listen(18080, '10.8.3.1', resolve));
  t.after(() => echo.close());
  // spawn asynchronously: a synchronous child would prevent this HTTP server from responding.
  const script = "require('http').get('http://10.8.3.1:18080/',r=>{let s='';r.on('data',d=>s+=d);r.on('end',()=>{console.log(s);process.exit(s==='ENCRYPTED_AWG31_OK'?0:1)})}).on('error',()=>process.exit(1));setTimeout(()=>process.exit(2),8000)";
  const request = spawn('nsenter', ['-t', String(holder.pid), '-n', 'node', '-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  let result = ''; request.stdout.on('data', (d) => result += d);
  const code = await new Promise((resolve) => request.once('exit', resolve));
  assert.equal(code, 0, 'real AWG3.1 request succeeds with RandomTrailers and DisableCookies');
  assert.equal(result.trim(), 'ENCRYPTED_AWG31_OK');
  const active=(await getClients()).find(c=>c.name==='Ноут-AWG3');assert.ok(active.transferRx>0 && active.transferTx>0 && active.latestHandshakeAt);
  client.kill('SIGTERM');await delay(100);
  const beforeReset=fs.readFileSync('/etc/wireguard/wg0.json','utf8');
  const reset=(body,authenticated=true)=>fetch(base+'/api/wireguard/statistics/reset',{method:'POST',headers:{...(authenticated?{Cookie:cookie}:{}),'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await reset({confirm:true},false)).status,401);assert.equal((await reset({})).status,400);assert.equal((await reset({confirm:'true'})).status,400);
  assert.equal((await reset({confirm:true})).status,200);
  for(let i=0;i<2;i++){
    const cleared=(await getClients()).find(c=>c.id===active.id);assert.equal(cleared.transferRx,0);assert.equal(cleared.transferTx,0);assert.equal(cleared.latestHandshakeAt,null);assert.ok(cleared.runtimeLatestHandshakeAt);
  }
  assert.equal(fs.readFileSync('/etc/wireguard/wg0.json','utf8'),beforeReset);

  const api = async (path,method='GET',body) => fetch(base+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const p1=await (await api('/api/routing/policies','POST',{name:'enabled-rule',priority:900,domains:['example.com'],networks:[],route:{type:'direct'},enabled:true})).json();
  await api('/api/routing/policies','POST',{name:'disabled-rule',priority:901,domains:['disabled.example'],networks:[],route:{type:'direct'},enabled:false});
  const beforePolicies=(await (await api('/api/routing')).json()).policies;
  const setName='p_'+p1.id.replace(/-/g,'').slice(0,12);execFileSync('nft',['add','element','inet','awg_chain_easy',setName,'{','192.0.2.55','timeout','120s','}']);
  assert.equal((await api('/api/routing/policies/enabled','PUT',{enabled:'false'})).status,400);
  assert.equal((await api('/api/routing/policies/enabled','PUT',{enabled:false})).status,200);
  const disabled=(await (await api('/api/routing')).json());assert.equal(disabled.policiesEnabled,false);assert.deepEqual(disabled.policies,beforePolicies);
  assert.ok(!execFileSync('nft',['list','chain','inet','awg_chain_easy','policy_gate'],{encoding:'utf8'}).includes('jump policy_routes'));
  assert.ok(execFileSync('nft',['list','set','inet','awg_chain_easy',setName],{encoding:'utf8'}).includes('192.0.2.55'));
  assert.equal((await api('/api/routing/default','PUT',{route:disabled.defaultRoute})).status,200);assert.ok(!execFileSync('nft',['list','chain','inet','awg_chain_easy','policy_gate'],{encoding:'utf8'}).includes('jump policy_routes'));
  const {RoutingManager}=require('/app/routing');const reloaded=new RoutingManager({});await reloaded.load();assert.equal(reloaded.state.policiesEnabled,false);
  assert.equal((await api('/api/routing/policies/enabled','PUT',{enabled:true})).status,200);assert.deepEqual((await (await api('/api/routing')).json()).policies,beforePolicies);
  assert.ok(execFileSync('nft',['list','chain','inet','awg_chain_easy','policy_gate'],{encoding:'utf8'}).includes('jump policy_routes'));

});
