'use strict';

const net = require('node:net');

function invalid(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function listenPort(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (!['number', 'string'].includes(typeof value) || !/^\d+$/.test(String(value))) {
    throw invalid('Listen port must be an integer between 0 and 65535');
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw invalid('Listen port must be between 0 and 65535');
  return port;
}

function portRange(value = '54323-54330') {
  const match = String(value).match(/^(\d+)(?:-(\d+))?$/);
  if (!match) throw invalid('UPSTREAM_PORT_RANGE must be a port or a consecutive range');
  const start = listenPort(match[1]);
  const end = listenPort(match[2] || match[1]);
  if (!start || end < start || end - start >= 8) throw invalid('UPSTREAM_PORT_RANGE must contain 1-8 ports between 1 and 65535');
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function reverseInitiation(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || typeof value.endpoint !== 'string') {
    throw invalid('Reverse initiation requires an endpoint and keepalive interval');
  }
  const endpoint = value.endpoint.trim();
  const match = endpoint.match(/^(?:\[([0-9a-fA-F:]+)\]|([^:\s]+)):(\d+)$/);
  const host = match?.[2];
  const hostname = host && host.length <= 253 && !/^[\d.]+$/.test(host) && host.split('.').every((label) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
  if (!match || (match[1] ? net.isIP(match[1]) !== 6 : net.isIP(host) !== 4 && !hostname) || !listenPort(match[3])) {
    throw invalid('Peer endpoint must be an IP address or hostname with a valid UDP port');
  }
  const keepalive = value.persistentKeepalive === undefined ? 25 : value.persistentKeepalive;
  if (typeof keepalive !== 'number' || !Number.isInteger(keepalive) || keepalive < 1 || keepalive > 65535) {
    throw invalid('Reverse keepalive must be an integer between 1 and 65535 seconds');
  }
  return { endpoint, persistentKeepalive: keepalive };
}

function peerConnectionLines(value) {
  const settings = reverseInitiation(value);
  // Explicit zero clears a previous reverse keepalive during live sync.
  return settings ? `\nEndpoint = ${settings.endpoint}\nPersistentKeepalive = ${settings.persistentKeepalive}` : '\nPersistentKeepalive = 0';
}

function withListenPort(config, value) {
  const port = listenPort(value);
  let section = '';
  const lines = [];
  for (const line of config.split(/\r?\n/)) {
    const header = line.trim().match(/^\[([^\]]+)]$/);
    if (header) section = header[1];
    if (section === 'Interface' && /^\s*ListenPort\s*=/i.test(line)) continue;
    lines.push(line);
    if (header && section === 'Interface' && port) lines.push(`ListenPort = ${port}`);
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function connectionStatus({ status, readable = true, latestHandshakeAt, persistentKeepalive = 0,
  startedAt = 0, rekeyAfterTime = 120, now = Date.now() }) {
  if (status === 'disabled') return 'disabled';
  if (status !== 'up') return 'unavailable';
  if (!readable) return 'unknown';
  if (!Number.isFinite(persistentKeepalive) || !Number.isFinite(rekeyAfterTime)) return 'unknown';
  const threshold = Math.max(180, rekeyAfterTime + 60, persistentKeepalive * 3) * 1000;
  if (latestHandshakeAt) {
    const age = now - Date.parse(latestHandshakeAt);
    if (!Number.isFinite(age) || age < -60_000) return 'unknown';
    if (age <= threshold) return 'connected';
    return persistentKeepalive ? 'stale' : 'idle';
  }
  return persistentKeepalive && startedAt && now - startedAt > threshold ? 'stale' : 'awaiting';
}

module.exports = { listenPort, portRange, reverseInitiation, peerConnectionLines, withListenPort, connectionStatus };
