'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { RoutingManager, DnsPolicyProxy } = require('./routing');
const { ClientStatistics, runtimeGeneration } = require('./client-statistics');
const { portRange, reverseInitiation, peerConnectionLines } = require('./connections');
const { LoginGuard, verifyPassword, clientAddress, trustedProxies, sessionCookie } = require('./auth');
const { toggle, awg31Parameters, vpnUri, attachment } = require('./profile-export');

const { amneziaQrChunks } = require('./amnezia-qr');

const { GuiSettings } = require('./gui-settings');

const DATA_DIR = '/etc/wireguard';
const STATE_FILE = path.join(DATA_DIR, 'wg0.json');
const SERVER_CONF = path.join(DATA_DIR, 'wg0.conf');
const LEGACY_SERVER_CONF = path.join(DATA_DIR, 'wg2.conf');
const NATIVE_SERVER_CONF = path.join(DATA_DIR, 'wg-native.conf');
const CLIENT_DIR = path.join(DATA_DIR, 'clients');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PROTOCOLS = {
  AWG3: { interface: 'awg3', config: SERVER_CONF, command: 'awg', quick: 'awg-quick' },
  AWG2: { interface: 'awg2', config: LEGACY_SERVER_CONF, command: 'awg', quick: 'awg-quick' },
  WG: { interface: 'wg-native', config: NATIVE_SERVER_CONF, command: 'wg', quick: 'wg-quick' },
};
const PASSWORD_FILE = '/tmp/awg-chain-easy.htpasswd';
const DNS_SIGNATURE_PACKET = '<r 2><b 0x858000010001000000000669636c6f756403636f6d0000010001c00c000100010000105a00044d583737>';
const amneziawgImage = process.env.AMNEZIAWG_IMAGE || '';
const amneziawgVersion = amneziawgImage.split('@')[0].match(/:([^/:]+)$/)?.[1] || null;

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function integerEnv(name, fallback, min, max) {
  const value = Number(env(name, fallback));
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}

const settings = {
  upstreamPorts: portRange(env('UPSTREAM_PORT_RANGE', '54323-54330')),
  host: env('WG_HOST', ''),
  serverName: env('VPN_SERVER_NAME', 'Server A'),
  port: integerEnv('WG_PORT', 51820, 1, 65535),
  configPort: integerEnv('WG_CONFIG_PORT', env('WG_PORT', 51820), 1, 65535),
  addressPattern: env('WG_DEFAULT_ADDRESS', '10.8.3.x'),
  legacyPort: integerEnv('AWG2_PORT', 51822, 1, 65535),
  legacyConfigPort: integerEnv('AWG2_CONFIG_PORT', env('AWG2_PORT', 51822), 1, 65535),
  legacyAddressPattern: env('AWG2_DEFAULT_ADDRESS', '10.8.4.x'),
  legacyDns: env('AWG2_DEFAULT_DNS', 'auto'),
  nativePort: integerEnv('NATIVE_WG_PORT', 51823, 1, 65535),
  nativeConfigPort: integerEnv('NATIVE_WG_CONFIG_PORT', env('NATIVE_WG_PORT', 51823), 1, 65535),
  nativeAddressPattern: env('NATIVE_WG_DEFAULT_ADDRESS', '10.8.5.x'),
  nativeDns: env('NATIVE_WG_DEFAULT_DNS', 'auto'),
  dns: env('WG_DEFAULT_DNS', 'auto'),
  allowedIps: env('WG_ALLOWED_IPS', '0.0.0.0/0'),
  persistentKeepalive: integerEnv('WG_PERSISTENT_KEEPALIVE', 25, 0, 65535),
  mtu: integerEnv('WG_MTU', 1280, 576, 9000),
  uiPort: integerEnv('PORT', 51821, 1, 65535),
  maxAgeMinutes: integerEnv('MAX_AGE', 720, 1, 525600),
  passwordHash: env('PASSWORD_HASH', ''),
  https: env('WEBUI_HTTPS', 'false'),
  trustedProxies: trustedProxies(env('TRUSTED_PROXY_IPS', '')),
  dnsUpstream: env('DNS_UPSTREAM', '1.1.1.1'),
  dnsTtlMin: integerEnv('DNS_TTL_MIN', 30, 1, 86400),
  dnsTtlMax: integerEnv('DNS_TTL_MAX', 86400, 1, 604800),
};

const guiSettings = new GuiSettings(path.join(DATA_DIR, 'gui-settings.json'), {
  serverName: settings.serverName,
  dnsUpstreams: [...new Set([settings.dnsUpstream, '8.8.8.8', '1.0.0.1'])],
  qrFormat: 'conf',
});

function parseAddressPattern(name, value) {
  const match = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.x$/);
  if (!match || match.slice(1).some((part) => Number(part) > 255)) throw new Error(`${name} must be an IPv4 /24 template such as 10.8.3.x`);
  return match.slice(1).join('.');
}
if (!settings.host) throw new Error('WG_HOST is required');
if (!['true', 'false'].includes(settings.https)) throw new Error('WEBUI_HTTPS must be true or false');
settings.https = settings.https === 'true';
const networkPrefix = parseAddressPattern('WG_DEFAULT_ADDRESS', settings.addressPattern);
const legacyNetworkPrefix = parseAddressPattern('AWG2_DEFAULT_ADDRESS', settings.legacyAddressPattern);
const nativeNetworkPrefix = parseAddressPattern('NATIVE_WG_DEFAULT_ADDRESS', settings.nativeAddressPattern);
if (new Set([networkPrefix, legacyNetworkPrefix, nativeNetworkPrefix]).size !== 3) {
  throw new Error('WG_DEFAULT_ADDRESS, AWG2_DEFAULT_ADDRESS, and NATIVE_WG_DEFAULT_ADDRESS must use different /24 networks');
}
if (new Set([settings.port, settings.legacyPort, settings.nativePort]).size !== 3) {
  throw new Error('WG_PORT, AWG2_PORT, and NATIVE_WG_PORT must be different');
}
if (settings.upstreamPorts.some((port) => [53, settings.port, settings.legacyPort, settings.nativePort].includes(port))) {
  throw new Error('UPSTREAM_PORT_RANGE must not overlap inbound UDP ports or DNS port 53');
}
if (settings.dns === 'auto') settings.dns = `${networkPrefix}.1`;
if (settings.legacyDns === 'auto') settings.legacyDns = `${legacyNetworkPrefix}.1`;
if (settings.nativeDns === 'auto') settings.nativeDns = `${nativeNetworkPrefix}.1`;
if (settings.dnsTtlMin > settings.dnsTtlMax) throw new Error('DNS_TTL_MIN must not exceed DNS_TTL_MAX');
if (ipv4ToNumberForSettings(settings.dnsUpstream) === null) throw new Error('DNS_UPSTREAM must be an IPv4 address');

function ipv4ToNumberForSettings(value) {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((result, part) => result * 256 + Number(part), 0);
}

function command(program, args = [], input = undefined) {
  const result = spawnSync(program, args, {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`${program} ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result.stdout.trim();
}

function protocolCommand(protocol) {
  return PROTOCOLS[protocol]?.command || 'awg';
}

function generatePrivateKey(protocol = 'AWG3') {
  return command(protocolCommand(protocol), ['genkey']);
}

function publicKey(privateKey, protocol = 'AWG3') {
  return command(protocolCommand(protocol), ['pubkey'], `${privateKey}\n`);
}

function randomRange(start, size) {
  const rangeStart = start + crypto.randomInt(size - 50_000_000);
  return `${rangeStart}-${rangeStart + crypto.randomInt(10_000_000, 50_000_001)}`;
}

function initialServer(protocol = 'AWG3') {
  const privateKey = generatePrivateKey(protocol);
  if (protocol === 'WG') {
    return {
      privateKey,
      publicKey: publicKey(privateKey, protocol),
      address: `${nativeNetworkPrefix}.1`,
    };
  }
  const legacy = protocol === 'AWG2';
  const numeric = (name, fallback) => integerEnv(`${legacy ? 'AWG2_' : ''}${name}`, fallback, 0, 4_294_967_295);
  const server = {
    privateKey,
    publicKey: publicKey(privateKey, protocol),
    address: `${protocol === 'AWG3' ? networkPrefix : legacyNetworkPrefix}.1`,
    jc: numeric('JC', 6),
    jmin: numeric('JMIN', legacy ? 10 : 64),
    jmax: numeric('JMAX', legacy ? 50 : 128),
    s1: numeric('S1', 64),
    s2: numeric('S2', 56),
    s3: numeric('S3', legacy ? 19 : 32),
    s4: numeric('S4', legacy ? 4 : 16),
    h1: randomRange(100_000_000, 700_000_000),
    h2: randomRange(1_100_000_000, 700_000_000),
    h3: randomRange(2_100_000_000, 700_000_000),
    h4: randomRange(3_100_000_000, 700_000_000),
    i1: env(legacy ? 'AWG2_I1' : 'I1', DNS_SIGNATURE_PACKET),
    headerProtectionKey: protocol === 'AWG3' ? generatePrivateKey() : undefined,
    contentPaddingAddition: env('CONTENT_PADDING_ADDITION', '0-32'),
    rekeyAfterTime: env('REKEY_AFTER_TIME', '110-130'),
    rekeyTimeout: env('REKEY_TIMEOUT', '4-6'),
    rejectAfterTime: env('REJECT_AFTER_TIME', '170-190'),
    keepaliveTimeout: env('KEEPALIVE_TIMEOUT', '8-12'),
    maxHandshakeAttempts: env('MAX_HANDSHAKE_ATTEMPTS', '15-20'),
    randomTrailers: protocol === 'AWG3' ? toggle(env('AWG3_RANDOM_TRAILERS', 'off')) : undefined,
    disableCookies: protocol === 'AWG3' ? toggle(env('AWG3_DISABLE_COOKIES', 'off')) : undefined,
  };
  if (protocol === 'AWG3' && [server.s1, server.s2, server.s3, server.s4].some((value) => value < 12)) throw new Error('AWG 3 requires S1-S4 to be at least 12');
  if (server.jmin > server.jmax || server.jmax >= settings.mtu) throw new Error('Require JMIN <= JMAX < WG_MTU');
  return server;
}

function upgradeLegacyServer(server) {
  server.jmin = integerEnv('AWG2_JMIN', 10, 0, 4_294_967_295);
  server.jmax = integerEnv('AWG2_JMAX', 50, 0, 4_294_967_295);
  server.s3 = integerEnv('AWG2_S3', 19, 0, 4_294_967_295);
  server.s4 = integerEnv('AWG2_S4', 4, 0, 4_294_967_295);
  server.i1 = env('AWG2_I1', DNS_SIGNATURE_PACKET);
  if (server.jmin > server.jmax || server.jmax >= settings.mtu) throw new Error('Require AWG2_JMIN <= AWG2_JMAX < WG_MTU');
}

async function atomicWrite(file, content, mode = 0o600) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  await fsp.writeFile(temporary, content, { mode });
  await fsp.rename(temporary, file);
}

async function loadState() {
  try {
    const parsed = JSON.parse(await fsp.readFile(STATE_FILE, 'utf8'));
    if (![3, 4, 5, 6].includes(parsed.version) || !parsed.server?.headerProtectionKey || !parsed.clients) {
      throw new Error('Existing wg0.json is not an AWG 3 state file; migrate it manually or use an empty CONFIG_DIR');
    }
    if (parsed.version === 3) {
      parsed.version = 4;
      parsed.legacyServer = initialServer('AWG2');
      for (const client of Object.values(parsed.clients)) client.protocol = 'AWG3';
    }
    if (!parsed.legacyServer) parsed.legacyServer = initialServer('AWG2');
    if (parsed.version < 5) {
      upgradeLegacyServer(parsed.legacyServer);
      parsed.version = 5;
    }
    if (parsed.version < 6) {
      parsed.nativeServer = initialServer('WG');
      parsed.version = 6;
    }
    if (!parsed.nativeServer?.privateKey || !parsed.nativeServer?.publicKey) throw new Error('Native WireGuard server identity is missing');
    for (const client of Object.values(parsed.clients)) {
      client.protocol ||= 'AWG3';
      if (client.reverseInitiation !== undefined) client.reverseInitiation = reverseInitiation(client.reverseInitiation);
    }
    return parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { version: 6, server: initialServer('AWG3'), legacyServer: initialServer('AWG2'), nativeServer: initialServer('WG'), clients: {} };
  }
}

function interfaceParameters(server, protocol) {
  if (protocol === 'WG') return '';
  const parameters = [
    `Jc = ${server.jc}`,
    `Jmin = ${server.jmin}`,
    `Jmax = ${server.jmax}`,
    `S1 = ${server.s1}`,
    `S2 = ${server.s2}`,
    `S3 = ${server.s3}`,
    `S4 = ${server.s4}`,
    `H1 = ${server.h1}`,
    `H2 = ${server.h2}`,
    `H3 = ${server.h3}`,
    `H4 = ${server.h4}`,
  ];
  if (server.i1) parameters.push(`I1 = ${server.i1}`);
  if (protocol === 'AWG3') parameters.push(
    `HeaderProtectionKey = ${server.headerProtectionKey}`,
    `ContentPaddingAddition = ${server.contentPaddingAddition}`,
    `RekeyAfterTime = ${server.rekeyAfterTime}`, `RekeyTimeout = ${server.rekeyTimeout}`,
    `RejectAfterTime = ${server.rejectAfterTime}`, `KeepaliveTimeout = ${server.keepaliveTimeout}`,
    `MaxHandshakeAttempts = ${server.maxHandshakeAttempts}`,
    ...awg31Parameters(server),
  );
  return parameters.join('\n');
}

function serverFor(stateValue, protocol) {
  if (protocol === 'AWG2') return stateValue.legacyServer;
  if (protocol === 'WG') return stateValue.nativeServer;
  return stateValue.server;
}
function protocolSettings(protocol) {
  if (protocol === 'AWG2') return { port: settings.legacyPort, configPort: settings.legacyConfigPort, dns: settings.legacyDns, prefix: legacyNetworkPrefix };
  if (protocol === 'WG') return { port: settings.nativePort, configPort: settings.nativeConfigPort, dns: settings.nativeDns, prefix: nativeNetworkPrefix };
  return { port: settings.port, configPort: settings.configPort, dns: settings.dns, prefix: networkPrefix };
}
function endpoint(protocol) {
  const port = protocolSettings(protocol).configPort;
  return settings.host.includes(':') ? `[${settings.host}]:${port}` : `${settings.host}:${port}`;
}

function clientConfiguration(state, client) {
  const protocol = client.protocol || 'AWG3';
  const protocolConfig = protocolSettings(protocol);
  const server = serverFor(state, protocol);
  const dns = protocolConfig.dns ? `DNS = ${protocolConfig.dns}\n` : '';
  const keepalive = settings.persistentKeepalive ? `PersistentKeepalive = ${settings.persistentKeepalive}\n` : '';
  const label = `${guiSettings.value.serverName} — ${client.name}`.replace(/[\r\n]/g, ' ');
  return `# ${label}\n[Interface]\nAddress = ${client.address}/32\nPrivateKey = ${client.privateKey}\n${dns}MTU = ${settings.mtu}\n${interfaceParameters(server, protocol)}\n\n[Peer]\nPublicKey = ${server.publicKey}\nPresharedKey = ${client.preSharedKey}\nAllowedIPs = ${settings.allowedIps}\nEndpoint = ${endpoint(protocol)}\n${keepalive}`;
}

function safeName(name) {
  return name.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'client';
}

function clientFilename(client) {
  if (client.protocol === 'WG') return `${safeName(client.name).slice(0, 6)}-${client.id.slice(0, 8)}.conf`;
  return `${safeName(client.name)}-${client.id.slice(0, 8)}.conf`;
}

async function writeArtifacts(state) {
  await fsp.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await fsp.mkdir(CLIENT_DIR, { recursive: true, mode: 0o700 });
  for (const protocol of Object.keys(PROTOCOLS)) {
    const server = serverFor(state, protocol);
    const protocolConfig = protocolSettings(protocol);
    const peers = Object.values(state.clients)
      .filter((client) => client.enabled && (client.protocol || 'AWG3') === protocol)
      .map((client) => `\n# Client: ${client.name} (${client.id})\n[Peer]\nPublicKey = ${client.publicKey}\nPresharedKey = ${client.preSharedKey}\nAllowedIPs = ${client.address}/32${peerConnectionLines(client.reverseInitiation)}`)
      .join('\n');
    const serverConfig = `# Generated by AWG Chain Easy. Changes are overwritten.\n[Interface]\nPrivateKey = ${server.privateKey}\nAddress = ${server.address}/24\nListenPort = ${protocolConfig.port}\nMTU = ${settings.mtu}\n${interfaceParameters(server, protocol)}\n${peers}\n`;
    await atomicWrite(PROTOCOLS[protocol].config, serverConfig);
  }
  await atomicWrite(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);

  const expected = new Set();
  for (const client of Object.values(state.clients)) {
    const filename = clientFilename(client);
    expected.add(filename);
    await atomicWrite(path.join(CLIENT_DIR, filename), clientConfiguration(state, client));
  }
  for (const filename of await fsp.readdir(CLIENT_DIR)) {
    if (filename.endsWith('.conf') && !expected.has(filename)) await fsp.unlink(path.join(CLIENT_DIR, filename));
  }
}

function syncRuntime(state) {
  for (const [protocol, definition] of Object.entries(PROTOCOLS)) {
    const stripped = command(definition.quick, ['strip', definition.config]);
    const syncFile = `/tmp/awg-chain-easy-sync-${definition.interface}-${process.pid}.conf`;
    fs.writeFileSync(syncFile, `${stripped}\n`, { mode: 0o600 });
    try { command(definition.command, ['syncconf', definition.interface, syncFile]); } finally { fs.unlinkSync(syncFile); }
    spawnSync('ip', ['-4', 'route', 'flush', 'dev', definition.interface, 'proto', 'static']);
    for (const client of Object.values(state.clients).filter((item) => item.enabled && (item.protocol || 'AWG3') === protocol)) {
      command('ip', ['-4', 'route', 'replace', `${client.address}/32`, 'dev', definition.interface, 'proto', 'static']);
    }
  }
}

let state;
let routing;
let dnsProxy;

function clearChangedClientConnections(previous, next) {
  const signature = (client) => client ? JSON.stringify([client.enabled, client.egress || 'default', client.upstreamId || null, client.address]) : null;
  const addresses = new Set();
  for (const id of new Set([...Object.keys(previous.clients), ...Object.keys(next.clients)])) {
    const before = previous.clients[id], after = next.clients[id];
    if (signature(before) !== signature(after)) {
      if (before) addresses.add(before.address);
      if (after) addresses.add(after.address);
    }
  }
  for (const address of addresses) {
    const result = spawnSync('conntrack', ['-D', '-f', 'ipv4', '-s', address], { encoding: 'utf8' });
    // conntrack returns 1 when no matching entries exist.
    if (result.error || ![0, 1].includes(result.status)) throw new Error('Unable to clear previous client connections');
  }
}

function mutate(operation) {
  return routing.enqueue(async () => {
    observeStatistics();
    const previous = JSON.parse(JSON.stringify(state));
    try {
      await operation();
      await routing.syncDirectClients();
      await writeArtifacts(state);
      syncRuntime(state);
      clearChangedClientConnections(previous, state);
      const restarted = new Set(Object.values(state.clients).filter((client) => previous.clients[client.id] && previous.clients[client.id].enabled !== client.enabled).map((client) => client.id));
      observeStatistics(runtimeStats(), restarted);
    } catch (error) {
      state = previous;
      await routing.syncDirectClients();
      await writeArtifacts(state);
      syncRuntime(state);
      throw error;
    }
  });
}

function runtimeStats() {
  const byKey = new Map();
  for (const definition of Object.values(PROTOCOLS)) {
    try {
      const generation = runtimeGeneration(definition.interface);
      const lines = command(definition.command, ['show', definition.interface, 'dump']).split('\n').slice(1);
      for (const line of lines) {
        const [key, , endpointValue, , handshake, received, sent] = line.split('\t');
        byKey.set(key, {
          generation,
          endpoint: endpointValue === '(none)' ? null : endpointValue,
          latestHandshakeAt: handshake === '0' ? null : new Date(Number(handshake) * 1000).toISOString(),
          transferRx: Number(received || 0), transferTx: Number(sent || 0),
        });
      }
    } catch (_) { /* The health endpoint reports interface availability separately. */ }
  }
  return byKey;
}

let clientStatistics;
let statisticsTimer;
let lastStatisticsError = 0;
function observeStatistics(stats = runtimeStats(), restartIds = new Set()) {
  try { clientStatistics?.observe(Object.values(state.clients), stats, restartIds); }
  catch (error) {
    if (Date.now() - lastStatisticsError > 60_000) {
      console.error('[awg-chain-easy] Cannot persist client statistics: ' + error.message);
      lastStatisticsError = Date.now();
    }
  }
}

function publicClients() {
  const stats = runtimeStats();
  observeStatistics(stats);
  return Object.values(state.clients)
    .map((client) => ({
      id: client.id,
      name: client.name,
      protocol: client.protocol || 'AWG3',
      address: client.address,
      enabled: client.enabled,
      egress: client.egress || 'default',
      upstreamId: client.egress === 'upstream' ? client.upstreamId : null,
      createdAt: client.createdAt,
      updatedAt: client.updatedAt,
      reverseInitiation: client.reverseInitiation || null,
      endpoint: stats.get(client.publicKey)?.endpoint || null,
      transferRx: stats.get(client.publicKey)?.transferRx || 0,
      transferTx: stats.get(client.publicKey)?.transferTx || 0,
      runtimeLatestHandshakeAt: stats.get(client.publicKey)?.latestHandshakeAt || null,
      latestHandshakeAt: stats.get(client.publicKey)?.latestHandshakeAt || null,
      ...(clientStatistics ? clientStatistics.values(client) : {}),
    }))
    .sort((a, b) => a.address.localeCompare(b.address, undefined, { numeric: true }));
}

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie || '').split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }));
}

const sessions = new Map();
const loginGuard = new LoginGuard((password) => verifyPassword(password, PASSWORD_FILE));

function sessionFor(request) {
  const token = parseCookies(request).awg3_session;
  const session = token && sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  return { token, ...session };
}

function send(response, status, body, type = 'application/json; charset=utf-8', headers = {}) {
  const content = type.startsWith('application/json') ? JSON.stringify(body) : body;
  response.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(content),
    'Cache-Control': type.startsWith('text/html') ? 'no-store' : 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'",
    ...(settings.https ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
    ...headers,
  });
  response.end(content);
}

async function readJson(request, limit = 262144) {
  const chunks = [];
  let size = 0;
  const timer = setTimeout(() => request.destroy(Object.assign(new Error('Request body timed out'), { status: 408 })), 10000);
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > limit) throw Object.assign(new Error('Request body is too large'), { status: 413 });
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch (_) { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
  } finally {
    clearTimeout(timer);
  }
}

function clientById(id) {
  const client = state.clients[id];
  if (!client) throw Object.assign(new Error('Client not found'), { status: 404 });
  return client;
}

function requireSameOrigin(request) {
  const origin = request.headers.origin;
  if (origin && new URL(origin).host !== request.headers.host) throw Object.assign(new Error('Invalid request origin'), { status: 403 });
}

async function resetClientStatistics(id = null) {
  await routing.enqueue(async () => {
    if (id) clientById(id);
    if (!clientStatistics) throw Object.assign(new Error('Client statistics storage is unavailable'), { status: 503 });
    observeStatistics();
    if (fs.existsSync(clientStatistics.filename)) await fsp.copyFile(clientStatistics.filename, clientStatistics.filename + '.before-reset-' + Date.now());
    clientStatistics.reset(Object.values(state.clients), runtimeStats(), id ? new Set([id]) : null);
  });
}

async function api(request, response, url) {
  if (url.pathname === '/api/health') {
    const tunnels = {};
    for (const [protocol, definition] of Object.entries(PROTOCOLS)) {
      try { command(definition.command, ['show', definition.interface]); tunnels[protocol] = 'up'; } catch (_) { tunnels[protocol] = 'down'; }
    }
    const healthy = Object.values(tunnels).every((value) => value === 'up');
    return send(response, healthy ? 200 : 503, { status: healthy ? 'healthy' : 'starting', protocols: tunnels, routing: routing ? 'ready' : 'starting' });
  }
  if (url.pathname === '/api/session' && request.method === 'GET') {
    return send(response, 200, { requiresPassword: true, authenticated: Boolean(sessionFor(request)) });
  }
  if (url.pathname === '/api/session' && request.method === 'POST') {
    requireSameOrigin(request);
    await loginGuard.authenticate(clientAddress(request, settings.trustedProxies), async () => (await readJson(request, 4096))?.password);
    for (const [key, session] of sessions) if (session.expiresAt <= Date.now()) sessions.delete(key);
    if (sessions.size >= 1024) throw Object.assign(new Error('Too many active sessions'), { status: 503 });
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, { expiresAt: Date.now() + settings.maxAgeMinutes * 60_000 });
    return send(response, 200, { success: true }, 'application/json; charset=utf-8', {
      'Set-Cookie': sessionCookie(token, settings.maxAgeMinutes * 60, settings.https),
    });
  }

  const session = sessionFor(request);
  if (!session) throw Object.assign(new Error('Not authenticated'), { status: 401 });
  if (!['GET', 'HEAD'].includes(request.method)) requireSameOrigin(request);

  if (url.pathname === '/api/session' && request.method === 'DELETE') {
    sessions.delete(session.token);
    return send(response, 200, { success: true }, 'application/json; charset=utf-8', {
      'Set-Cookie': sessionCookie('', 0, settings.https),
    });
  }
  if (url.pathname === '/api/routing/upstreams/statistics/reset' && request.method === 'POST') {
    const body = await readJson(request, 4096);
    if (body.confirm !== true) throw Object.assign(new Error('Traffic reset confirmation is required'), { status: 400 });
    await routing.resetUpstreamTraffic();
    return send(response, 200, { success: true });
  }
  if (url.pathname === '/api/about' && request.method === 'GET') {
    const info = JSON.parse(await fsp.readFile(path.join(__dirname, 'build-info.json'), 'utf8'));
    return send(response, 200, { ...info, amneziawgVersion });
  }
  if (url.pathname === '/api/settings' && request.method === 'GET') return send(response, 200, guiSettings.value);
  if (url.pathname === '/api/settings' && request.method === 'PUT') {
    const patch = await readJson(request, 8192);
    await routing.enqueue(async () => {
      const next = guiSettings.next(patch);
      const previous = guiSettings.value;
      const changedPrimary = next.dnsUpstreams[0] !== previous.dnsUpstreams[0];
      const selfAddresses = Object.keys(PROTOCOLS).map(p => serverFor(state, p).address);
      if (next.dnsUpstreams.some(ip => selfAddresses.includes(ip))) throw Object.assign(new Error('DNS server cannot point to this VPN DNS proxy'), { status: 400 });
      try {
        routing.dnsUpstream = next.dnsUpstreams[0];
        routing.dnsUpstreams = next.dnsUpstreams;
        if (changedPrimary) await routing.reconcile();
        guiSettings.save(next);
      } catch (error) {
        routing.dnsUpstream = previous.dnsUpstreams[0];
        routing.dnsUpstreams = previous.dnsUpstreams;
        if (changedPrimary) await routing.reconcile();
        throw error;
      }
      if (changedPrimary) {
        for (const c of Object.values(state.clients).filter(c => c.enabled && c.egress === 'upstream')) {
          for (const protocol of ['udp', 'tcp']) spawnSync('conntrack', ['-D', '-f', 'ipv4', '-s', c.address, '-p', protocol, '--dport', '53'], { encoding: 'utf8' });
        }
      }
    });
    return send(response, 200, guiSettings.value);
  }
  if (url.pathname === '/api/settings/dns/test' && request.method === 'POST') {
    const { servers } = await readJson(request, 4096);
    guiSettings.next({ dnsUpstreams: servers });
    if (servers.some(ip => Object.keys(PROTOCOLS).some(p => serverFor(state, p).address === ip))) throw Object.assign(new Error('DNS server cannot point to this VPN DNS proxy'), { status: 400 });
    const query = Buffer.from('123401000001000000000000076578616d706c6503636f6d0000010001', 'hex');
    const results = await Promise.all(servers.map(async address => {
      const started = Date.now();
      try { await dnsProxy.forward(query, 'udp', address); return { address, success: true, milliseconds: Date.now() - started }; }
      catch (_) { return { address, success: false, milliseconds: Date.now() - started }; }
    }));
    return send(response, 200, { results });
  }
  if (url.pathname === '/api/wireguard/statistics/reset' && request.method === 'POST') {
    const body = await readJson(request);
    if (body.confirm !== true) throw Object.assign(new Error('Statistics reset confirmation is required'), { status: 400 });
    await resetClientStatistics();
    return send(response, 200, { success: true });
  }
  if (url.pathname === '/api/wireguard/status' && request.method === 'GET') {
    const clients = publicClients();
    return send(response, 200, {
      protocols: Object.keys(PROTOCOLS),
      amneziawg: { version: amneziawgVersion, image: amneziawgImage },
      endpoint: Object.keys(PROTOCOLS).map((protocol) => `${protocol} ${endpoint(protocol)}`).join(' · '),
      endpoints: Object.fromEntries(Object.keys(PROTOCOLS).map((protocol) => [protocol, endpoint(protocol)])),
      addresses: Object.fromEntries(Object.keys(PROTOCOLS).map((protocol) => [protocol, `${serverFor(state, protocol).address}/24`])),
      clients: clients.length, enabled: clients.filter((client) => client.enabled).length,
      connected: clients.filter((client) => client.enabled && client.runtimeLatestHandshakeAt && Date.now() - Date.parse(client.runtimeLatestHandshakeAt) < 300_000).length,
    });
  }
  if (url.pathname === '/api/wireguard/client' && request.method === 'GET') return send(response, 200, publicClients());
  if (url.pathname === '/api/wireguard/client' && request.method === 'POST') {
    const { name, protocol = 'AWG3', egress = 'default', upstreamId = null } = await readJson(request);
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 64) throw Object.assign(new Error('Name must contain 1-64 characters'), { status: 400 });
    if (!Object.hasOwn(PROTOCOLS, protocol)) throw Object.assign(new Error('Protocol must be AWG3, AWG2, or WG'), { status: 400 });
    let client;
    await mutate(() => {
      if (Object.values(state.clients).some((item) => item.name.toLowerCase() === name.trim().toLowerCase())) throw Object.assign(new Error('Client name already exists'), { status: 409 });
      const clientRoute = routing.validateClientEgress({ egress, upstreamId });
      const address = routing.allocateClientAddress(protocolSettings(protocol).prefix);
      const privateKey = generatePrivateKey(protocol);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const keyCommand = protocolCommand(protocol);
      client = { id, name: name.trim(), protocol, ...clientRoute, address, privateKey, publicKey: publicKey(privateKey, protocol), preSharedKey: command(keyCommand, ['genpsk']), createdAt: now, updatedAt: now, enabled: true };
      state.clients[id] = client;
    });
    return send(response, 201, { id: client.id });
  }
  if (url.pathname === '/api/wireguard/backup' && request.method === 'GET') {
    return send(response, 200, `${JSON.stringify(state, null, 2)}\n`, 'application/json; charset=utf-8', { 'Content-Disposition': 'attachment; filename="wg0.json"' });
  }

  if (url.pathname === '/api/routing' && request.method === 'GET') return send(response, 200, routing.snapshot());
  if (url.pathname === '/api/routing/upstreams' && request.method === 'POST') {
    const upstream = await routing.addUpstream(await readJson(request));
    return send(response, 201, { id: upstream.id });
  }
  if (url.pathname === '/api/routing/policies/enabled' && request.method === 'PUT') {
    const { enabled } = await readJson(request);
    await routing.setPoliciesEnabled(enabled);
    return send(response, 200, { success: true });
  }
  if (url.pathname === '/api/routing/policies' && request.method === 'POST') {
    const policy = await routing.addPolicy(await readJson(request));
    return send(response, 201, { id: policy.id });
  }
  if (url.pathname === '/api/routing/default' && request.method === 'PUT') {
    const { route } = await readJson(request);
    await routing.setDefaultRoute(route);
    return send(response, 200, { success: true });
  }
  if (url.pathname === '/api/routing/failover' && request.method === 'PUT') {
    await routing.setFailover(await readJson(request));
    return send(response, 200, { success: true });
  }
  if (['/api/routing/failover/preferred', '/api/routing/failover/primary'].includes(url.pathname) && request.method === 'POST') {
    await routing.returnToPreferred();
    return send(response, 200, { success: true });
  }
  const upstreamMatch = url.pathname.match(/^\/api\/routing\/upstreams\/([0-9a-f-]+)(?:\/(enable|disable|failover-priority|configuration|statistics\/reset))?$/i);
  if (upstreamMatch) {
    if (request.method === 'POST' && upstreamMatch[2] === 'statistics/reset') {
      const body = await readJson(request, 4096);
      if (body.confirm !== true) throw Object.assign(new Error('Statistics reset confirmation is required'), { status: 400 });
      await routing.resetUpstreamTraffic(upstreamMatch[1]);
      return send(response, 200, { success: true });
    }

    if (request.method === 'GET' && upstreamMatch[2] === 'configuration') {
      const config = await routing.exportUpstreamConfig(upstreamMatch[1]);
      return send(response, 200, config, 'text/plain; charset=utf-8', { 'Content-Disposition': `attachment; filename="up-${upstreamMatch[1].slice(0, 8)}.conf"` });
    }
    if (request.method === 'PUT' && upstreamMatch[2] === 'failover-priority') {
      const body = await readJson(request);
      if (!body || !Object.hasOwn(body, 'failoverPriority')) throw Object.assign(new Error('failoverPriority is required; use null to exclude the upstream'), { status: 400 });
      await routing.setUpstreamPriority(upstreamMatch[1], body.failoverPriority);
      return send(response, 200, { success: true });
    }
    if (request.method === 'PUT' && !upstreamMatch[2]) {
      const body = await readJson(request);
      if (!body || body.listenPort === undefined) throw Object.assign(new Error('listenPort is required; use 0 for automatic allocation'), { status: 400 });
      await routing.setUpstreamListenPort(upstreamMatch[1], body.listenPort);
      return send(response, 200, { success: true });
    }
    if (request.method === 'POST' && ['enable', 'disable'].includes(upstreamMatch[2])) {
      await routing.setUpstreamEnabled(upstreamMatch[1], upstreamMatch[2] === 'enable');
      return send(response, 200, { success: true });
    }
    if (request.method === 'DELETE' && !upstreamMatch[2]) {
      await routing.deleteUpstream(upstreamMatch[1]);
      return send(response, 200, { success: true });
    }
    throw Object.assign(new Error('Method not allowed'), { status: 405 });
  }
  const policyMatch = url.pathname.match(/^\/api\/routing\/policies\/([0-9a-f-]+)(?:\/(enable|disable))?$/i);
  if (policyMatch) {
    if (request.method === 'PUT' && !policyMatch[2]) {
      const policy = await routing.updatePolicy(policyMatch[1], await readJson(request));
      return send(response, 200, { id: policy.id });
    }
    if (request.method === 'POST' && policyMatch[2]) {
      await routing.setPolicyEnabled(policyMatch[1], policyMatch[2] === 'enable');
      return send(response, 200, { success: true });
    }
    if (request.method === 'DELETE' && !policyMatch[2]) {
      await routing.deletePolicy(policyMatch[1]);
      return send(response, 200, { success: true });
    }
    throw Object.assign(new Error('Method not allowed'), { status: 405 });
  }

  const match = url.pathname.match(/^\/api\/wireguard\/client\/([0-9a-f-]+)(?:\/(configuration|configuration\.vpn|qrcode\.svg|qrcode\.vpn\.svg|qrcode\.amnezia|enable|disable|connection|statistics\/reset))?$/i);
  if (!match) throw Object.assign(new Error('Not found'), { status: 404 });
  const client = clientById(match[1]);
  const action = match[2];
    if (request.method === 'POST' && action === 'statistics/reset') {
      const body = await readJson(request, 4096);
      if (body.confirm !== true) throw Object.assign(new Error('Statistics reset confirmation is required'), { status: 400 });
      await resetClientStatistics(client.id);
      return send(response, 200, { success: true });
    }

  if (request.method === 'PUT' && !action) {
    const body = await readJson(request);
    const { name } = body;
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 64) throw Object.assign(new Error('Name must contain 1-64 characters'), { status: 400 });
    await mutate(() => {
      const current = clientById(match[1]);
      if (Object.values(state.clients).some((item) => item.id !== current.id && item.name.toLowerCase() === name.trim().toLowerCase())) throw Object.assign(new Error('Client name already exists'), { status: 409 });
      if (Object.hasOwn(body, 'protocol') && body.protocol !== (current.protocol || 'AWG3')) throw Object.assign(new Error('Client protocol cannot be changed'), { status: 400 });
      if (Object.hasOwn(body, 'egress')) Object.assign(current, routing.validateClientEgress(body));
      current.name = name.trim();
      current.updatedAt = new Date().toISOString();
    });
    return send(response, 200, { success: true });
  }
  if (request.method === 'GET' && action === 'configuration.vpn') {
    const uri = vpnUri(clientConfiguration(state, client), { protocol: client.protocol || 'AWG3',
      serverName: guiSettings.value.serverName, clientName: client.name });
    return send(response, 200, `${uri}\n`, 'text/plain; charset=utf-8', {
      'Content-Disposition': attachment(`${guiSettings.value.serverName} - ${client.name}.vpn`),
    });
  }
  if (request.method === 'PUT' && action === 'connection') {
    const body = await readJson(request);
    if (!body || !Object.hasOwn(body, 'reverseInitiation')) throw Object.assign(new Error('reverseInitiation is required; use null to disable'), { status: 400 });
    const connection = reverseInitiation(body.reverseInitiation);
    await mutate(() => {
      const current = clientById(match[1]);
      current.reverseInitiation = connection;
      current.updatedAt = new Date().toISOString();
    });
    return send(response, 200, { success: true });
  }
  if (request.method === 'GET' && action === 'configuration') {
    const filename = client.protocol === 'WG' ? clientFilename(client) : `${guiSettings.value.serverName} - ${client.name}.conf`;
    return send(response, 200, clientConfiguration(state, client), 'text/plain; charset=utf-8', { 'Content-Disposition': attachment(filename) });
  }
  if (request.method === 'GET' && action === 'qrcode.amnezia') {
    const uri = vpnUri(clientConfiguration(state, client), { protocol: client.protocol || 'AWG3',
      serverName: guiSettings.value.serverName, clientName: client.name });
    const frames = amneziaQrChunks(uri).map((chunk) => {
      const svg = command('qrencode', ['-t', 'SVG', '-l', 'L', '-m', '4', '-s', '8', '-o', '-'], chunk);
      return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    });
    return send(response, 200, { frames }, 'application/json; charset=utf-8');
  }
  if (request.method === 'GET' && (action === 'qrcode.svg' || action === 'qrcode.vpn.svg')) {
    const config = clientConfiguration(state, client);
    const payload = action === 'qrcode.vpn.svg'
      ? vpnUri(config, { protocol: client.protocol || 'AWG3', serverName: guiSettings.value.serverName, clientName: client.name })
      : config;
    const svg = command('qrencode', ['-t', 'SVG', '-m', '2', '-s', '8', '-o', '-'], payload);
    return send(response, 200, svg, 'image/svg+xml; charset=utf-8');
  }
  if (request.method === 'POST' && (action === 'enable' || action === 'disable')) {
    await mutate(() => { client.enabled = action === 'enable'; client.updatedAt = new Date().toISOString(); });
    return send(response, 200, { success: true });
  }
  if (request.method === 'DELETE' && !action) {
    await mutate(() => { delete state.clients[client.id]; });
    return send(response, 200, { success: true });
  }
  throw Object.assign(new Error('Method not allowed'), { status: 405 });
}

const staticFiles = {
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/favicon.ico': ['favicon.ico', 'image/x-icon'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};

async function handle(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await api(request, response, url);
    const staticFile = staticFiles[url.pathname];
    if (!staticFile || request.method !== 'GET') return send(response, 404, 'Not found', 'text/plain; charset=utf-8');
    return send(response, 200, await fsp.readFile(path.join(PUBLIC_DIR, staticFile[0])), staticFile[1]);
  } catch (error) {
    console.error(error.stack || error);
    return send(response, error.status || 500, { error: error.status ? error.message : 'Internal server error' });
  }
}

async function initialize() {
  state = await loadState();
  await writeArtifacts(state);
}

async function main() {
  await initialize();
  if (process.argv.includes('--initialize')) return;
  if (!settings.passwordHash || !settings.passwordHash.startsWith('$2')) throw new Error('PASSWORD_HASH must contain a bcrypt hash');
  fs.writeFileSync(PASSWORD_FILE, `admin:${settings.passwordHash}\n`, { mode: 0o600 });
  routing = new RoutingManager({
    inboundPorts: [53, settings.port, settings.legacyPort, settings.nativePort],
    upstreamPorts: settings.upstreamPorts,
    inboundInterfaces: Object.values(PROTOCOLS).map((item) => item.interface),
    downstreamNetworks: [`${networkPrefix}.0/24`, `${legacyNetworkPrefix}.0/24`, `${nativeNetworkPrefix}.0/24`],
    downstreamAddresses: () => [
      ...Object.keys(PROTOCOLS).map((protocol) => serverFor(state, protocol).address),
      ...Object.values(state.clients).map((client) => client.address),
    ],
    clientRoutes: () => Object.values(state.clients),
    directClientAddresses: () => Object.values(state.clients).filter((client) => client.enabled && client.egress === 'direct').map((client) => client.address),
    mtu: settings.mtu,
    dnsUpstream: guiSettings.value.dnsUpstreams[0],
    dnsUpstreams: guiSettings.value.dnsUpstreams,
    dnsTtlMin: settings.dnsTtlMin,
    dnsTtlMax: settings.dnsTtlMax,
  });
  await routing.load();
  await routing.startAll();
  try { clientStatistics = new ClientStatistics('/etc/wireguard/client-statistics.json', '/etc/wireguard/handshake-history.json'); }
  catch (error) { console.error('[awg-chain-easy] Cannot load client statistics: ' + error.message); }
  observeStatistics();
  statisticsTimer = setInterval(observeStatistics, 5000);
  statisticsTimer.unref();
  dnsProxy = new DnsPolicyProxy(routing);
  await dnsProxy.start();
  const server = http.createServer({ requestTimeout: 10000, headersTimeout: 10000, keepAliveTimeout: 5000 }, handle);
  server.maxConnections = 128;
  server.listen(settings.uiPort, '0.0.0.0', () => console.log(`[awg-chain-easy] Web UI listening on port ${settings.uiPort}`));
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    server.close();
    clearInterval(statisticsTimer);
    observeStatistics();
    await dnsProxy.stop().catch(() => {});
    await routing.shutdown().catch((error) => console.error(`[awg-chain-easy] routing cleanup: ${error.message}`));
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  console.error(`[awg-chain-easy] ${error.stack || error}`);
  process.exit(1);
});
