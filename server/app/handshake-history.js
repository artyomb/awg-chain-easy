'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function timestamp(value) {
  if (typeof value !== 'string' || !value) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && milliseconds > 0 ? new Date(milliseconds).toISOString() : null;
}
class HandshakeHistory {
  constructor(filename) {
    this.filename = filename;
    this.entries = {};
    try {
      const stored = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (stored.version !== 1 || !stored.entries || Array.isArray(stored.entries) || typeof stored.entries !== 'object') throw new Error('Invalid handshake history format');
      for (const [id, entry] of Object.entries(stored.entries)) {
        const latestHandshakeAt = timestamp(entry?.latestHandshakeAt);
        if (entry && typeof entry.publicKey === 'string' && typeof entry.protocol === 'string' && latestHandshakeAt) {
          this.entries[id] = { publicKey: entry.publicKey, protocol: entry.protocol, latestHandshakeAt };
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  observe(clients, stats) {
    const entries = {};
    for (const client of clients) {
      const protocol = client.protocol || 'AWG3';
      const previous = this.entries[client.id];
      const saved = previous?.publicKey === client.publicKey && previous.protocol === protocol ? previous.latestHandshakeAt : null;
      const live = timestamp(stats.get(client.publicKey)?.latestHandshakeAt);
      const latestHandshakeAt = live && (!saved || Date.parse(live) > Date.parse(saved)) ? live : saved;
      if (latestHandshakeAt) entries[client.id] = { publicKey: client.publicKey, protocol, latestHandshakeAt };
    }
    if (JSON.stringify(entries) === JSON.stringify(this.entries)) return;
    const temporary = `${this.filename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ version: 1, entries }, null, 2) + '\n'); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.filename);
      const directory = fs.openSync(path.dirname(this.filename), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      this.entries = entries;
    } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  latest(client, live = null) {
    const entry = this.entries[client.id];
    const saved = entry?.publicKey === client.publicKey && entry.protocol === (client.protocol || 'AWG3') ? entry.latestHandshakeAt : null;
    const current = timestamp(live);
    return current && (!saved || Date.parse(current) > Date.parse(saved)) ? current : saved;
  }
}
module.exports = { HandshakeHistory };
