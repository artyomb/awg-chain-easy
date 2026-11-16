'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const stamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) > 0 ? new Date(value).toISOString() : null;
const counter = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const identity = (client, entry) => entry?.publicKey === client.publicKey && entry.protocol === (client.protocol || 'AWG3');
function runtimeGeneration(iface) {
  const socket = ['/var/run/amneziawg/', '/var/run/wireguard/'].map((dir) => dir + iface + '.sock').find((file) => fs.existsSync(file));
  if (!socket) throw new Error('VPN control socket is unavailable');
  const s = fs.statSync(socket, { bigint: true });
  const ns = fs.statSync('/proc/self/ns/net', { bigint: true });
  return [fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), ns.ino, s.dev, s.ino, s.ctimeNs].join(':');
}
class ClientStatistics {
  constructor(filename, legacyFile = null) {
    this.filename = filename;
    this.entries = {};
    let stored;
    try { stored = JSON.parse(fs.readFileSync(filename, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (legacyFile) {
        try {
          const legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
          for (const [id, e] of Object.entries(legacy.entries || {})) this.entries[id] = this.empty(e, { latestHandshakeAt: stamp(e.latestHandshakeAt) });
        } catch (legacyError) { if (legacyError.code !== 'ENOENT') throw legacyError; }
      }
      return;
    }
    if (stored.version !== 1 || !stored.entries || Array.isArray(stored.entries) || typeof stored.entries !== 'object') throw new Error('Invalid client statistics file');
    for (const [id, e] of Object.entries(stored.entries)) {
      if (!e || typeof e.publicKey !== 'string' || typeof e.protocol !== 'string' || counter(e.transferRx) === null || counter(e.transferTx) === null) throw new Error('Invalid client statistics entry');
      this.entries[id] = this.empty(e, { transferRx: e.transferRx, transferTx: e.transferTx, rawRx: counter(e.rawRx), rawTx: counter(e.rawTx), generation: typeof e.generation === 'string' ? e.generation : null, latestHandshakeAt: stamp(e.latestHandshakeAt), handshakeFloor: stamp(e.handshakeFloor) });
    }
  }
  empty(client, extra = {}) {
    return { publicKey: client.publicKey, protocol: client.protocol || 'AWG3', transferRx: 0, transferTx: 0, rawRx: null, rawTx: null, generation: null, latestHandshakeAt: null, handshakeFloor: null, ...extra };
  }
  save(entries) {
    if (JSON.stringify(entries) === JSON.stringify(this.entries) && fs.existsSync(this.filename)) return;
    const tmp = `${this.filename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ version: 1, entries }, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, this.filename);
      const dir = fs.openSync(path.dirname(this.filename), 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      this.entries = entries;
    } finally { try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  observe(clients, stats, restartIds = new Set()) {
    const entries = {};
    for (const client of clients) {
      const e = identity(client, this.entries[client.id]) ? { ...this.entries[client.id] } : this.empty(client);
      if (restartIds.has(client.id)) { e.rawRx = null; e.rawTx = null; e.generation = null; }
      const sample = stats.get(client.publicKey);
      if (sample) {
        const current = stamp(sample.latestHandshakeAt);
        if (current && (!e.handshakeFloor || current > e.handshakeFloor) && (!e.latestHandshakeAt || current > e.latestHandshakeAt)) e.latestHandshakeAt = current;
        if (typeof sample.generation === 'string') {
          for (const [total, raw, field] of [['transferRx','rawRx','transferRx'], ['transferTx','rawTx','transferTx']]) {
            const value = counter(sample[field]);
            if (value === null) continue;
            const delta = e.generation !== sample.generation || e[raw] === null || value < e[raw] ? value : value - e[raw];
            if (!Number.isSafeInteger(e[total] + delta)) throw new Error('Client traffic counter overflow');
            e[total] += delta; e[raw] = value;
          }
          e.generation = sample.generation;
        }
      }
      entries[client.id] = e;
    }
    this.save(entries);
  }
  reset(clients, stats, selectedIds = null) {
    const entries = {};
    for (const client of clients) {
      const old = identity(client, this.entries[client.id]) ? this.entries[client.id] : this.empty(client);
      if (selectedIds && !selectedIds.has(client.id)) { entries[client.id] = { ...old }; continue; }
      const sample = stats.get(client.publicKey);
      const floor = [old.latestHandshakeAt, old.handshakeFloor, stamp(sample?.latestHandshakeAt)].filter(Boolean).sort().pop() || null;
      entries[client.id] = this.empty(client, { rawRx: counter(sample?.transferRx), rawTx: counter(sample?.transferTx), generation: typeof sample?.generation === 'string' ? sample.generation : null, handshakeFloor: floor });
    }
    this.save(entries);
  }
  resetTraffic(clients, stats, selectedIds = null) {
    const entries = {};
    for (const client of clients) {
      const old = identity(client, this.entries[client.id]) ? this.entries[client.id] : this.empty(client);
      if (selectedIds && !selectedIds.has(client.id)) { entries[client.id] = { ...old }; continue; }
      const sample = stats.get(client.publicKey);
      entries[client.id] = { ...old, transferRx: 0, transferTx: 0 };
      if (typeof sample?.generation === 'string') {
        entries[client.id].rawRx = counter(sample.transferRx);
        entries[client.id].rawTx = counter(sample.transferTx);
        entries[client.id].generation = sample.generation;
      }
    }
    this.save(entries);
  }
  values(client) {
    const e = identity(client, this.entries[client.id]) ? this.entries[client.id] : this.empty(client);
    return { latestHandshakeAt: e.latestHandshakeAt, transferRx: e.transferRx, transferTx: e.transferTx };
  }
}
module.exports = { ClientStatistics, runtimeGeneration };
