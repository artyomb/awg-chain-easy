'use strict';

const crypto = require('node:crypto');
const dgram = require('node:dgram');
const net = require('node:net');

const LIMITS = Object.freeze({
  pending: 256, perClient: 16, connections: 128, connectionsPerClient: 8,
  tcpBuffer: 131074, timeoutMs: 4000, idleMs: 10000, frameMs: 5000,
});

function invalid() { throw new Error('Invalid DNS packet'); }

function readName(buffer, start) {
  let offset = start;
  let next;
  let size = 1;
  const labels = [];
  const visited = new Set();
  while (offset < buffer.length && visited.size < 128) {
    if (visited.has(offset)) invalid();
    visited.add(offset);
    const length = buffer[offset];
    if (length === 0) {
      return { name: labels.join('.'), key: JSON.stringify(labels),
        hostname: labels.every((label) => /^[a-z0-9_-]+$/.test(label)), next: next ?? offset + 1 };
    }
    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= buffer.length) invalid();
      const pointer = ((length & 0x3f) << 8) | buffer[offset + 1];
      if (pointer >= offset) invalid();
      next ??= offset + 2;
      offset = pointer;
      continue;
    }
    size += length + 1;
    if (length > 63 || size > 255 || offset + length + 1 > buffer.length) invalid();
    labels.push(buffer.subarray(offset + 1, offset + length + 1).toString('latin1').replace(/[A-Z]/g, (letter) => letter.toLowerCase()));
    offset += length + 1;
  }
  invalid();
}

function question(buffer) {
  if (buffer.length < 12 || buffer.length > 65535 || buffer.readUInt16BE(4) !== 1) invalid();
  const name = readName(buffer, 12);
  if (name.next + 4 > buffer.length) invalid();
  return { ...name, type: buffer.readUInt16BE(name.next), cls: buffer.readUInt16BE(name.next + 2), end: name.next + 4 };
}

function records(buffer, offset, count) {
  const result = [];
  for (let index = 0; index < count; index++) {
    const owner = readName(buffer, offset);
    offset = owner.next;
    if (offset + 10 > buffer.length) invalid();
    const type = buffer.readUInt16BE(offset);
    const cls = buffer.readUInt16BE(offset + 2);
    const ttl = buffer.readUInt32BE(offset + 4);
    const length = buffer.readUInt16BE(offset + 8);
    offset += 10;
    const end = offset + length;
    if (end > buffer.length) invalid();
    const record = { owner: owner.key, type, cls, ttl };
    if (type === 1) {
      if (length !== 4) invalid();
      record.address = [...buffer.subarray(offset, end)].join('.');
    } else if (type === 5) {
      const target = readName(buffer, offset);
      if (target.next !== end) invalid();
      record.target = target.key;
    }
    result.push(record);
    offset = end;
  }
  return { records: result, end: offset };
}

function inspectQuery(query) {
  const result = question(query);
  // Standard, single-question queries only. EDNS additional records are preserved.
  if (query.readUInt16BE(2) & 0xf840 || query.readUInt16BE(6) || query.readUInt16BE(8)) invalid();
  if (records(query, result.end, query.readUInt16BE(10)).end !== query.length) invalid();
  return result;
}

function inspectDns(query, response) {
  const expected = inspectQuery(query);
  const received = question(response);
  const flags = response.readUInt16BE(2);
  if (response.readUInt16BE(0) !== query.readUInt16BE(0) || !(flags & 0x8000) || (flags & 0x7840)
    || received.key !== expected.key || received.type !== expected.type || received.cls !== expected.cls) invalid();
  const result = { domain: expected.hostname ? expected.name : null, addresses: [], ttl: 0 };
  // A truncated UDP reply can omit records. Relay it so the client can retry over TCP.
  if (flags & 0x0200) return result;
  const answer = records(response, received.end, response.readUInt16BE(6));
  const authority = records(response, answer.end, response.readUInt16BE(8));
  const additional = records(response, authority.end, response.readUInt16BE(10));
  if (additional.end !== response.length) invalid();
  if ((flags & 0x000f) || additional.records.some((record) => record.type === 41 && (record.ttl >>> 24))
    || expected.type !== 1 || expected.cls !== 1 || !result.domain) return result;

  const aliases = new Map();
  for (const record of answer.records.filter((item) => item.type === 5 && item.cls === 1)) {
    const previous = aliases.get(record.owner);
    if (previous && previous.target !== record.target) invalid();
    aliases.set(record.owner, { target: record.target, ttl: Math.min(record.ttl, previous?.ttl ?? record.ttl) });
  }
  let owner = expected.key;
  let ttl = Number.MAX_SAFE_INTEGER;
  const visited = new Set();
  while (aliases.has(owner)) {
    if (visited.has(owner) || visited.size >= 32) invalid();
    visited.add(owner);
    const alias = aliases.get(owner);
    ttl = Math.min(ttl, alias.ttl);
    owner = alias.target;
  }
  for (const record of answer.records) {
    if (record.owner === owner && record.type === 1 && record.cls === 1) {
      result.addresses.push(record.address);
      ttl = Math.min(ttl, record.ttl);
    }
  }
  result.addresses = [...new Set(result.addresses)];
  result.ttl = result.addresses.length ? ttl : 0;
  return result;
}

function failureResponse(query) {
  const parsed = inspectQuery(query);
  const response = Buffer.from(query.subarray(0, parsed.end));
  response.writeUInt16BE(0x8082 | (query.readUInt16BE(2) & 0x0100), 2);
  response.fill(0, 6, 12);
  return response;
}

class DnsPolicyProxy {
  constructor(routing, options = {}) {
    this.routing = routing;
    this.limits = { ...LIMITS, ...options.limits };
    this.host = options.host ?? '0.0.0.0';
    this.port = options.port ?? 53;
    this.upstreamPort = options.upstreamPort ?? 53;
    this.udp = null;
    this.tcp = null;
    this.stopping = false;
    this.pending = 0;
    this.clients = new Map();
    this.connections = new Set();
    this.exchanges = new Set();
  }

  forward(query, transport = 'udp', upstream = this.routing.dnsUpstream) {
    const outgoing = Buffer.from(query);
    outgoing.writeUInt16BE(crypto.randomInt(65536));
    return new Promise((resolve, reject) => {
      const socket = transport === 'tcp' ? new net.Socket() : dgram.createSocket('udp4');
      let finished = false;
      const finish = (error, response) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.exchanges.delete(cancel);
        if (transport === 'tcp') socket.destroy();
        else { try { socket.close(); } catch (_) { /* Not bound yet. */ } }
        if (error) reject(error);
        else {
          const restored = Buffer.from(response);
          restored.writeUInt16BE(query.readUInt16BE(0));
          resolve(restored);
        }
      };
      const cancel = () => finish(new Error('DNS proxy stopped'));
      const timer = setTimeout(() => finish(new Error('DNS upstream timeout')), this.limits.timeoutMs);
      this.exchanges.add(cancel);
      socket.on('error', (error) => finish(error));
      if (this.stopping) return cancel();
      if (transport === 'tcp') {
        let buffer = Buffer.alloc(0);
        socket.on('close', () => { if (!finished) finish(new Error('DNS upstream closed')); });
        socket.on('data', (chunk) => {
          if (buffer.length + chunk.length > 65537) return finish(new Error('DNS upstream response too large'));
          buffer = Buffer.concat([buffer, chunk]);
          if (buffer.length < 2) return;
          const length = buffer.readUInt16BE(0);
          if (length < 12) return finish(new Error('Invalid DNS frame'));
          if (buffer.length < length + 2) return;
          const response = buffer.subarray(2, length + 2);
          try { inspectDns(outgoing, response); if (![0, 3].includes(response.readUInt16BE(2) & 15)) throw new Error('DNS upstream error'); finish(null, response); } catch (error) { finish(error); }
        });
        socket.connect(this.upstreamPort, upstream, () => {
          if (finished) return;
          const prefix = Buffer.alloc(2);
          prefix.writeUInt16BE(outgoing.length);
          socket.write(Buffer.concat([prefix, outgoing]));
        });
      } else {
        socket.on('message', (response, remote) => {
          if (remote.address !== upstream || remote.port !== this.upstreamPort) return;
          try { inspectDns(outgoing, response); } catch (_) { return; }
          if (![0, 3].includes(response.readUInt16BE(2) & 15)) return finish(new Error('DNS upstream error'));
          finish(null, response);
        });
        socket.connect(this.upstreamPort, upstream, () => {
          if (!finished) socket.send(outgoing, (error) => { if (error) finish(error); });
        });
      }
    });
  }

  async resolve(query, client = 'local', transport = 'udp') {
    inspectQuery(query);
    const count = this.clients.get(client) || 0;
    if (this.stopping || this.pending >= this.limits.pending || count >= this.limits.perClient) {
      throw new Error('DNS request limit reached');
    }
    this.pending++;
    this.clients.set(client, count + 1);
    try {
      let response;
      let lastError;
      for (const upstream of [...(this.routing.dnsUpstreams || [this.routing.dnsUpstream])]) {
        if (this.stopping) throw new Error('DNS proxy stopped');
        try { response = await this.forward(query, transport, upstream); break; }
        catch (error) { lastError = error; }
      }
      if (!response) throw lastError || new Error('DNS upstream unavailable');
      const result = inspectDns(query, response);
      if (!this.stopping && result.addresses.length) {
        const policy = this.routing.matchingDomainPolicy(result.domain);
        if (policy) await this.routing.addDnsAddresses(policy, result.addresses, result.ttl);
      }
      return response;
    } finally {
      this.pending--;
      const remaining = this.clients.get(client) - 1;
      if (remaining) this.clients.set(client, remaining); else this.clients.delete(client);
    }
  }

  accept(socket) {
    socket.on('error', () => {});
    const client = socket.remoteAddress;
    const peers = [...this.connections].filter((connection) => connection.remoteAddress === client).length;
    if (this.stopping || this.connections.size >= this.limits.connections || peers >= this.limits.connectionsPerClient) {
      socket.destroy(); return;
    }
    this.connections.add(socket);
    let buffer = Buffer.alloc(0);
    let processing = false;
    let frameTimer;
    const clearFrameTimer = () => { clearTimeout(frameTimer); frameTimer = null; };
    socket.setTimeout(this.limits.idleMs, () => socket.destroy());
    socket.on('close', () => { clearFrameTimer(); this.connections.delete(socket); });
    const processFrames = async () => {
      if (processing) return;
      processing = true;
      socket.pause();
      try {
        while (!socket.destroyed && !this.stopping && buffer.length >= 2) {
          const length = buffer.readUInt16BE(0);
          if (length < 12) throw new Error('Invalid DNS frame');
          if (buffer.length < length + 2) break;
          const query = Buffer.from(buffer.subarray(2, length + 2));
          buffer = buffer.subarray(length + 2);
          clearFrameTimer();
          const response = await this.resolve(query, client, 'tcp');
          if (socket.destroyed || this.stopping) return;
          const prefix = Buffer.alloc(2);
          prefix.writeUInt16BE(response.length);
          // The write callback applies backpressure while the peer is not reading.
          await new Promise((resolve, reject) => {
            const closed = () => reject(new Error('DNS client closed'));
            socket.once('close', closed);
            socket.write(Buffer.concat([prefix, response]), (error) => {
              socket.removeListener('close', closed);
              if (error) reject(error); else resolve();
            });
          });
        }
        if (buffer.length && !frameTimer) frameTimer = setTimeout(() => socket.destroy(), this.limits.frameMs);
      } catch (_) {
        socket.destroy();
      } finally {
        processing = false;
        if (!socket.destroyed) socket.resume();
      }
    };
    socket.on('data', (chunk) => {
      if (buffer.length + chunk.length > this.limits.tcpBuffer) { socket.destroy(); return; }
      buffer = Buffer.concat([buffer, chunk]);
      void processFrames();
    });
  }

  async start() {
    this.stopping = false;
    this.udp = dgram.createSocket('udp4');
    this.udp.on('error', () => {});
    this.udp.on('message', async (query, remote) => {
      let response;
      try { response = await this.resolve(query, remote.address); }
      catch (_) {
        try { response = failureResponse(query); } catch (_) { return; }
      }
      if (!this.stopping) this.udp.send(response, remote.port, remote.address, () => {});
    });
    try {
      await new Promise((resolve, reject) => {
        this.udp.once('error', reject);
        this.udp.bind(this.port, this.host, () => { this.udp.removeListener('error', reject); resolve(); });
      });
      this.tcp = net.createServer((socket) => this.accept(socket));
      this.tcp.maxConnections = this.limits.connections;
      this.tcp.on('error', () => {});
      await new Promise((resolve, reject) => {
        this.tcp.once('error', reject);
        this.tcp.listen(this.udp.address().port, this.host, () => { this.tcp.removeListener('error', reject); resolve(); });
      });
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop() {
    this.stopping = true;
    for (const cancel of this.exchanges) cancel();
    for (const socket of this.connections) socket.destroy();
    if (this.udp) { try { this.udp.close(); } catch (_) { /* Not bound. */ } }
    if (this.tcp?.listening) await new Promise((resolve) => this.tcp.close(resolve));
  }
}

module.exports = { DnsPolicyProxy, inspectDns, inspectQuery, LIMITS };
