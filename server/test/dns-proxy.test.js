'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const net = require('node:net');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { DnsPolicyProxy, inspectDns, inspectQuery } = require('../app/dns-proxy');

function name(domain) {
  return Buffer.concat([...domain.split('.').map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0])]);
}
function query(domain = 'policy.example', id = 1234, type = 1, cls = 1) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id); header.writeUInt16BE(0x0100, 2); header.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4); tail.writeUInt16BE(type); tail.writeUInt16BE(cls, 2);
  return Buffer.concat([header, name(domain), tail]);
}
function record(owner, value, { type = 1, cls = 1, ttl = 60 } = {}) {
  const data = type === 5 ? name(value) : Buffer.from(value.split('.').map(Number));
  const header = Buffer.alloc(10);
  header.writeUInt16BE(type); header.writeUInt16BE(cls, 2); header.writeUInt32BE(ttl, 4); header.writeUInt16BE(data.length, 8);
  return Buffer.concat([name(owner), header, data]);
}
function reply(request, answers = [record('policy.example', '203.0.113.1')], flags = 0x8180) {
  const header = Buffer.from(request);
  header.writeUInt16BE(flags, 2); header.writeUInt16BE(answers.length, 6);
  return Buffer.concat([header, ...answers]);
}
function frame(packet) {
  const prefix = Buffer.alloc(2); prefix.writeUInt16BE(packet.length);
  return Buffer.concat([prefix, packet]);
}
function routing() {
  return { dnsUpstream: '127.0.0.1', learned: [], matchingDomainPolicy: (domain) => ({ domain }),
    async addDnsAddresses(policy, addresses, ttl) { this.learned.push({ policy, addresses, ttl }); } };
}
async function fixture(t, handler = (request, send) => send(reply(request)), limits = {}) {
  const udp = dgram.createSocket('udp4');
  udp.bind(0, '127.0.0.1'); await once(udp, 'listening');
  const port = udp.address().port;
  const sockets = new Set();
  udp.on('message', (packet, peer) => handler(packet, (response) => udp.send(response, peer.port, peer.address), peer, 'udp'));
  const tcp = net.createServer((socket) => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2 && buffer.length >= buffer.readUInt16BE(0) + 2) {
        const length = buffer.readUInt16BE(0);
        const packet = Buffer.from(buffer.subarray(2, length + 2));
        buffer = buffer.subarray(length + 2);
        handler(packet, (response) => { if (!socket.destroyed) socket.end(frame(response)); }, null, 'tcp');
      }
    });
  });
  tcp.listen(port, '127.0.0.1'); await once(tcp, 'listening');
  const state = routing();
  const proxy = new DnsPolicyProxy(state, { host: '127.0.0.1', port: 0, upstreamPort: port, limits });
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    for (const socket of sockets) socket.destroy();
    udp.close();
    await new Promise((resolve) => tcp.close(resolve));
  });
  return { proxy, state, port: proxy.udp.address().port };
}
async function connect(t, port) {
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  return socket;
}
function receiveFrames(socket, count) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const received = [];
    const timer = setTimeout(() => reject(new Error('Response deadline exceeded')), 2000);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2 && buffer.length >= buffer.readUInt16BE(0) + 2) {
        const length = buffer.readUInt16BE(0);
        received.push(Buffer.from(buffer.subarray(2, length + 2)));
        buffer = buffer.subarray(length + 2);
      }
      if (received.length >= count) { clearTimeout(timer); resolve(received); }
    });
  });
}

test('DNS matches ID, flags, question name, type, and class before accepting a response', () => {
  const request = query();
  assert.deepEqual(inspectDns(request, reply(request)).addresses, ['203.0.113.1']);
  for (const response of [reply(query('policy.example', 999)), reply(query('other.example')),
    reply(query('policy.example', 1234, 28)), reply(query('policy.example', 1234, 1, 3)),
    reply(request, [], 0x0100), reply(request, [], 0x8980), reply(request, [], 0x81c0)]) {
    assert.throws(() => inspectDns(request, response), /Invalid DNS/);
  }
});

test('DNS learns only related IN A records and respects the entire CNAME chain TTL', () => {
  const request = query();
  const response = reply(request, [record('end.example', '203.0.113.2'), record('unrelated.example', '203.0.113.3'),
    record('policy.example', 'mid.example', { type: 5, ttl: 10 }), record('mid.example', 'end.example', { type: 5, ttl: 20 }),
    record('end.example', '203.0.113.4', { cls: 3 })]);
  assert.deepEqual(inspectDns(request, response), { domain: 'policy.example', addresses: ['203.0.113.2'], ttl: 10 });
  assert.deepEqual(inspectDns(request, reply(request, [record('unrelated.example', '203.0.113.3')])).addresses, []);
  assert.deepEqual(inspectDns(query('policy.example', 1234, 28), reply(query('policy.example', 1234, 28))).addresses, []);
  assert.deepEqual(inspectDns(request, reply(request, undefined, 0x8183)).addresses, []);
  assert.deepEqual(inspectDns(request, reply(request, undefined, 0x8380)).addresses, []);
});

test('DNS rejects malformed packets and ambiguous or looping CNAME chains', () => {
  const request = query();
  const broken = reply(request); broken.writeUInt16BE(2, 6);
  const loop = Buffer.from(request); loop[12] = 0xc0; loop[13] = 12;
  const multiple = Buffer.from(request); multiple.writeUInt16BE(2, 4);
  for (const packet of [Buffer.alloc(1), loop, multiple, request.subarray(0, request.length - 1)]) {
    assert.throws(() => inspectQuery(packet), /Invalid DNS/);
  }
  for (const packet of [broken, reply(request).subarray(0, reply(request).length - 1),
    reply(request, [record('policy.example', 'a.example', { type: 5 }), record('policy.example', 'b.example', { type: 5 })]),
    reply(request, [record('policy.example', 'a.example', { type: 5 }), record('a.example', 'policy.example', { type: 5 })])]) {
    assert.throws(() => inspectDns(request, packet), /Invalid DNS/);
  }
});

test('DNS accepts compressed CNAME answers and EDNS without learning extended error replies', () => {
  const request = query();
  const cnameHeader = Buffer.alloc(10);
  cnameHeader.writeUInt16BE(5); cnameHeader.writeUInt16BE(1, 2);
  cnameHeader.writeUInt32BE(20, 4); cnameHeader.writeUInt16BE(7, 8);
  const targetOffset = request.length + 12;
  const cname = Buffer.concat([Buffer.from([0xc0, 12]), cnameHeader, Buffer.from([4]), Buffer.from('edge'), Buffer.from([0xc0, 19])]);
  const aHeader = Buffer.alloc(10);
  aHeader.writeUInt16BE(1); aHeader.writeUInt16BE(1, 2); aHeader.writeUInt32BE(60, 4); aHeader.writeUInt16BE(4, 8);
  const address = Buffer.concat([Buffer.from([0xc0, targetOffset]), aHeader, Buffer.from([203, 0, 113, 8])]);
  const response = reply(request, [cname, address]);
  assert.deepEqual(inspectDns(request, response).addresses, ['203.0.113.8']);
  assert.equal(inspectDns(request, response).ttl, 20);
  const opt = Buffer.alloc(11); opt.writeUInt16BE(41, 1); opt.writeUInt16BE(1232, 3);
  const ednsQuery = Buffer.concat([request, opt]); ednsQuery.writeUInt16BE(1, 10);
  const ednsResponse = Buffer.concat([response, opt]); ednsResponse.writeUInt16BE(1, 10);
  assert.deepEqual(inspectDns(ednsQuery, ednsResponse).addresses, ['203.0.113.8']);
  ednsResponse[ednsResponse.length - 6] = 1;
  assert.deepEqual(inspectDns(ednsQuery, ednsResponse).addresses, []);
});

test('UDP ignores foreign senders and mismatched replies, then restores the client ID', { timeout: 3000 }, async (t) => {
  const foreign = dgram.createSocket('udp4');
  t.after(() => foreign.close());
  const { proxy, state } = await fixture(t, (request, send, peer) => {
    foreign.send(reply(request, [record('policy.example', '203.0.113.99')]), peer.port, peer.address);
    const wrong = Buffer.from(request); wrong.writeUInt16BE((request.readUInt16BE(0) + 1) % 65536);
    send(reply(wrong, [record('policy.example', '203.0.113.98')]));
    send(reply(query('other.example', request.readUInt16BE(0))));
    setTimeout(() => send(reply(request)), 20);
  });
  const response = await proxy.resolve(query());
  assert.equal(response.readUInt16BE(0), 1234);
  assert.deepEqual(state.learned.map((entry) => entry.addresses), [['203.0.113.1']]);
});

test('TCP consumes fragmented and pipelined frames once and uses TCP upstream', { timeout: 4000 }, async (t) => {
  const seen = [];
  const { port } = await fixture(t, (request, send, peer, transport) => {
    seen.push(transport);
    setTimeout(() => send(reply(request)), 20);
  });
  const socket = await connect(t, port);
  const responses = receiveFrames(socket, 2);
  const first = frame(query());
  socket.write(first.subarray(0, 1));
  await delay(5);
  socket.write(Buffer.concat([first.subarray(1), frame(query('policy.example', 5678))]));
  assert.deepEqual((await responses).map((packet) => packet.readUInt16BE(0)), [1234, 5678]);
  assert.deepEqual(seen, ['tcp', 'tcp']);
});

test('DNS limits global and per-client work and releases reservations after failures', async () => {
  const proxy = new DnsPolicyProxy(routing(), { limits: { pending: 2, perClient: 1 } });
  const releases = [];
  proxy.forward = () => new Promise((resolve, reject) => releases.push(reject));
  const one = assert.rejects(proxy.resolve(query(), 'one'), /fixture/);
  await assert.rejects(proxy.resolve(query(), 'one'), /limit/);
  const two = assert.rejects(proxy.resolve(query(), 'two'), /fixture/);
  await assert.rejects(proxy.resolve(query(), 'three'), /limit/);
  releases.forEach((reject) => reject(new Error('fixture')));
  await Promise.all([one, two]);
  assert.equal(proxy.pending, 0); assert.equal(proxy.clients.size, 0);
});

test('TCP closes oversized buffers and incomplete frames without crashing', { timeout: 3000 }, async (t) => {
  const { port } = await fixture(t, undefined, { tcpBuffer: 64, frameMs: 80, idleMs: 500 });
  const large = await connect(t, port);
  let closed = once(large, 'close'); large.write(Buffer.alloc(65)); await closed;
  const incomplete = await connect(t, port);
  closed = once(incomplete, 'close'); incomplete.write(Buffer.from([0])); await closed;
  const healthy = await connect(t, port);
  const responses = receiveFrames(healthy, 1); healthy.write(frame(query()));
  assert.equal((await responses).length, 1);
});

test('TCP connection limits, upstream timeout, and shutdown release sockets', { timeout: 3000 }, async (t) => {
  const { proxy, port } = await fixture(t, () => {}, { timeoutMs: 80, connections: 2, connectionsPerClient: 1 });
  const first = await connect(t, port);
  const extra = await connect(t, port); await once(extra, 'close');
  const closed = once(first, 'close'); first.write(frame(query())); await closed;
  assert.equal(proxy.pending, 0);
  const pending = assert.rejects(proxy.resolve(query()), /stopped/);
  await proxy.stop(); await pending;
  assert.equal(proxy.pending, 0); assert.equal(proxy.exchanges.size, 0);
});

test('DNS ordered failover uses next resolver on transport error and stops on NXDOMAIN', async () => {
 const r=routing();r.dnsUpstreams=['192.0.2.1','192.0.2.2','192.0.2.3'];const proxy=new DnsPolicyProxy(r);const calls=[];
 proxy.forward=async(packet,transport,upstream)=>{calls.push(upstream);if(upstream==='192.0.2.1')throw new Error('timeout');return reply(packet,[],0x8183)};
 const result=await proxy.resolve(query());assert.equal(result.readUInt16BE(2)&15,3);assert.deepEqual(calls,['192.0.2.1','192.0.2.2']);assert.equal(proxy.pending,0);
 proxy.forward=async()=>{throw new Error('down')};await assert.rejects(proxy.resolve(query()),/down/);assert.equal(proxy.pending,0);
});
test('UDP and TCP forward reject SERVFAIL for fallback while accepting NXDOMAIN', async(t)=>{
 for(const transport of ['udp','tcp']){
  const f=await fixture(t,(request,send)=>send(reply(request,[],0x8182)));
  await assert.rejects(f.proxy.forward(query(),transport),/DNS upstream error/);
 }
});
