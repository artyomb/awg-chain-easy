'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
function invalid(message) { throw Object.assign(new Error(message), { status: 400 }); }
function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Invalid settings');
  const { serverName, dnsUpstreams, qrFormat } = input;
  if (typeof serverName !== 'string' || !serverName.trim() || serverName.trim().length > 64 || /[\x00-\x1f\x7f]/.test(serverName)) invalid('Server name must contain 1-64 characters without control characters');
  if (!Array.isArray(dnsUpstreams) || dnsUpstreams.length < 1 || dnsUpstreams.length > 8 || new Set(dnsUpstreams).size !== dnsUpstreams.length || dnsUpstreams.some(ip => typeof ip !== 'string' || net.isIP(ip) !== 4 || /^(0|127|22[4-9]|2[3-5]\d)\./.test(ip))) invalid('Specify 1-8 unique IPv4 DNS servers');
  if (!['conf', 'amnezia'].includes(qrFormat)) invalid('Invalid QR format');
  return { serverName: serverName.trim(), dnsUpstreams: [...dnsUpstreams], qrFormat };
}
class GuiSettings {
  constructor(file, defaults) {
    this.file = file;
    this.value = validate(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : defaults);
    if (!fs.existsSync(file)) this.save(this.value);
  }
  next(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(k => !['serverName','dnsUpstreams','qrFormat'].includes(k))) invalid('Invalid settings');
    return validate({ ...this.value, ...patch });
  }
  save(next) {
    const value = validate(next);
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.file + '.bak');
    const tmp = this.file + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.file);
    const dir = fs.openSync(path.dirname(this.file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    this.value = value;
    return value;
  }
}
module.exports = { GuiSettings, validate };
