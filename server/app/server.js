'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { RoutingManager, DnsPolicyProxy } = require('./routing');

const DATA_DIR = '/etc/wireguard';
const STATE_FILE = path.join(DATA_DIR, 'wg0.json');
const SERVER_CONF = path.join(DATA_DIR, 'wg0.conf');
const LEGACY_SERVER_CONF = path.join(DATA_DIR, 'wg2.conf');
const CLIENT_DIR = path.join(DATA_DIR, 'clients');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PROTOCOLS = {
  AWG3: { interface: 'awg3', config: SERVER_CONF },
  AWG2: { interface: 'awg2', config: LEGACY_SERVER_CONF },
};
const PASSWORD_FILE = '/tmp/awg-chain-easy.htpasswd';
const DNS_SIGNATURE_PACKET = '<r 2><b 0x858000010001000000000669636c6f756403636f6d0000010001c00c000100010000105a00044d583737>';

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
  host: env('WG_HOST', ''),
  port: integerEnv('WG_PORT', 51820, 1, 65535),
  configPort: integerEnv('WG_CONFIG_PORT', env('WG_PORT', 51820), 1, 65535),
  addressPattern: env('WG_DEFAULT_ADDRESS', '10.8.3.x'),
  legacyPort: integerEnv('AWG2_PORT', 51822, 1, 65535),
  legacyConfigPort: integerEnv('AWG2_CONFIG_PORT', env('AWG2_PORT', 51822), 1, 65535),
  legacyAddressPattern: env('AWG2_DEFAULT_ADDRESS', '10.8.4.x'),
  legacyDns: env('AWG2_DEFAULT_DNS', 'auto'),
  dns: env('WG_DEFAULT_DNS', 'auto'),
  allowedIps: env('WG_ALLOWED_IPS', '0.0.0.0/0'),
  persistentKeepalive: integerEnv('WG_PERSISTENT_KEEPALIVE', 25, 0, 65535),
  mtu: integerEnv('WG_MTU', 1280, 576, 9000),
  uiPort: integerEnv('PORT', 51821, 1, 65535),
  maxAgeMinutes: integerEnv('MAX_AGE', 720, 1, 525600),
  passwordHash: env('PASSWORD_HASH', ''),
  dnsUpstream: env('DNS_UPSTREAM', '1.1.1.1'),
  dnsTtlMin: integerEnv('DNS_TTL_MIN', 30, 1, 86400),
  dnsTtlMax: integerEnv('DNS_TTL_MAX', 86400, 1, 604800),
};

function parseAddressPattern(name, value) {
  const match = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.x$/);
  if (!match || match.slice(1).some((part) => Number(part) > 255)) throw new Error(`${name} must be an IPv4 /24 template such as 10.8.3.x`);
  return match.slice(1).join('.');
}
if (!settings.host) throw new Error('WG_HOST is required');
const networkPrefix = parseAddressPattern('WG_DEFAULT_ADDRESS', settings.addressPattern);
const legacyNetworkPrefix = parseAddressPattern('AWG2_DEFAULT_ADDRESS', settings.legacyAddressPattern);
if (networkPrefix === legacyNetworkPrefix) throw new Error('WG_DEFAULT_ADDRESS and AWG2_DEFAULT_ADDRESS must use different /24 networks');
if (settings.port === settings.legacyPort) throw new Error('WG_PORT and AWG2_PORT must be different');
if (settings.dns === 'auto') settings.dns = `${networkPrefix}.1`;
if (settings.legacyDns === 'auto') settings.legacyDns = `${legacyNetworkPrefix}.1`;
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

function passwordMatches(password) {
  const result = spawnSync('htpasswd', ['-vi', PASSWORD_FILE, 'admin'], {
    input: `${password}\n`, encoding: 'utf8', stdio: ['pipe', 'ignore', 'ignore'],
  });
  return result.status === 0;
}

function generatePrivateKey() {
  return command('awg', ['genkey']);
}

function publicKey(privateKey) {
  return command('awg', ['pubkey'], `${privateKey}\n`);
}

function randomRange(start, size) {
  const rangeStart = start + crypto.randomInt(size - 50_000_000);
  return `${rangeStart}-${rangeStart + crypto.randomInt(10_000_000, 50_000_001)}`;
}

function initialServer(protocol = 'AWG3') {
  const privateKey = generatePrivateKey();
  const legacy = protocol === 'AWG2';
  const numeric = (name, fallback) => integerEnv(`${legacy ? 'AWG2_' : ''}${name}`, fallback, 0, 4_294_967_295);
  const server = {
    privateKey,
    publicKey: publicKey(privateKey),
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
    if (![3, 4, 5].includes(parsed.version) || !parsed.server?.headerProtectionKey || !parsed.clients) {
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
    for (const client of Object.values(parsed.clients)) client.protocol ||= 'AWG3';
    return parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { version: 5, server: initialServer('AWG3'), legacyServer: initialServer('AWG2'), clients: {} };
  }
}

function interfaceParameters(server, protocol) {
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
  );
  return parameters.join('\n');
}

function serverFor(stateValue, protocol) { return protocol === 'AWG2' ? stateValue.legacyServer : stateValue.server; }
function protocolSettings(protocol) {
  return protocol === 'AWG2'
    ? { port: settings.legacyPort, configPort: settings.legacyConfigPort, dns: settings.legacyDns, prefix: legacyNetworkPrefix }
    : { port: settings.port, configPort: settings.configPort, dns: settings.dns, prefix: networkPrefix };
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
  return `[Interface]\nAddress = ${client.address}/32\nPrivateKey = ${client.privateKey}\n${dns}MTU = ${settings.mtu}\n${interfaceParameters(server, protocol)}\n\n[Peer]\nPublicKey = ${server.publicKey}\nPresharedKey = ${client.preSharedKey}\nAllowedIPs = ${settings.allowedIps}\nEndpoint = ${endpoint(protocol)}\n${keepalive}`;
}

function safeName(name) {
  return name.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'client';
}

async function writeArtifacts(state) {
  await fsp.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await fsp.mkdir(CLIENT_DIR, { recursive: true, mode: 0o700 });
  for (const protocol of Object.keys(PROTOCOLS)) {
    const server = serverFor(state, protocol);
    const protocolConfig = protocolSettings(protocol);
    const peers = Object.values(state.clients)
      .filter((client) => client.enabled && (client.protocol || 'AWG3') === protocol)
      .map((client) => `\n# Client: ${client.name} (${client.id})\n[Peer]\nPublicKey = ${client.publicKey}\nPresharedKey = ${client.preSharedKey}\nAllowedIPs = ${client.address}/32`)
      .join('\n');
    const serverConfig = `# Generated by AWG Chain Easy. Changes are overwritten.\n[Interface]\nPrivateKey = ${server.privateKey}\nAddress = ${server.address}/24\nListenPort = ${protocolConfig.port}\nMTU = ${settings.mtu}\n${interfaceParameters(server, protocol)}\n${peers}\n`;
    await atomicWrite(PROTOCOLS[protocol].config, serverConfig);
  }
  await atomicWrite(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);

  const expected = new Set();
  for (const client of Object.values(state.clients)) {
    const filename = `${safeName(client.name)}-${client.id.slice(0, 8)}.conf`;
    expected.add(filename);
    await atomicWrite(path.join(CLIENT_DIR, filename), clientConfiguration(state, client));
  }
  for (const filename of await fsp.readdir(CLIENT_DIR)) {
    if (filename.endsWith('.conf') && !expected.has(filename)) await fsp.unlink(path.join(CLIENT_DIR, filename));
  }
}

function syncRuntime(state) {
  for (const [protocol, definition] of Object.entries(PROTOCOLS)) {
    const stripped = command('awg-quick', ['strip', definition.config]);
    const syncFile = `/tmp/awg-chain-easy-sync-${definition.interface}-${process.pid}.conf`;
    fs.writeFileSync(syncFile, `${stripped}\n`, { mode: 0o600 });
    try { command('awg', ['syncconf', definition.interface, syncFile]); } finally { fs.unlinkSync(syncFile); }
    spawnSync('ip', ['-4', 'route', 'flush', 'dev', definition.interface, 'proto', 'static']);
    for (const client of Object.values(state.clients).filter((item) => item.enabled && (item.protocol || 'AWG3') === protocol)) {
      command('ip', ['-4', 'route', 'replace', `${client.address}/32`, 'dev', definition.interface, 'proto', 'static']);
    }
  }
}

let state;
let mutation = Promise.resolve();
let routing;
let dnsProxy;

function mutate(operation) {
  const next = mutation.then(async () => {
    await operation();
    await writeArtifacts(state);
    syncRuntime(state);
  });
  mutation = next.catch(() => {});
  return next;
}

function runtimeStats() {
  const byKey = new Map();
  for (const definition of Object.values(PROTOCOLS)) {
    try {
      const lines = command('awg', ['show', definition.interface, 'dump']).split('\n').slice(1);
      for (const line of lines) {
        const [key, , endpointValue, , handshake, received, sent] = line.split('\t');
        byKey.set(key, {
          endpoint: endpointValue === '(none)' ? null : endpointValue,
          latestHandshakeAt: handshake === '0' ? null : new Date(Number(handshake) * 1000).toISOString(),
          transferRx: Number(received || 0), transferTx: Number(sent || 0),
        });
      }
    } catch (_) { /* The health endpoint reports interface availability separately. */ }
  }
  return byKey;
}

function publicClients() {
  const stats = runtimeStats();
  return Object.values(state.clients)
    .map((client) => ({
      id: client.id,
      name: client.name,
      protocol: client.protocol || 'AWG3',
      address: client.address,
      enabled: client.enabled,
      createdAt: client.createdAt,
      updatedAt: client.updatedAt,
      ...(stats.get(client.publicKey) || { endpoint: null, latestHandshakeAt: null, transferRx: 0, transferTx: 0 }),
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
const loginAttempts = new Map();

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
    ...headers,
  });
  response.end(content);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 262_144) throw Object.assign(new Error('Request body is too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch (_) {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
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

async function api(request, response, url) {
  if (url.pathname === '/api/health') {
    const tunnels = {};
    for (const [protocol, definition] of Object.entries(PROTOCOLS)) {
      try { command('awg', ['show', definition.interface]); tunnels[protocol] = 'up'; } catch (_) { tunnels[protocol] = 'down'; }
    }
    const healthy = Object.values(tunnels).every((value) => value === 'up');
    return send(response, healthy ? 200 : 503, { status: healthy ? 'healthy' : 'starting', protocols: tunnels, routing: routing ? 'ready' : 'starting' });
  }
  if (url.pathname === '/api/session' && request.method === 'GET') {
    return send(response, 200, { requiresPassword: true, authenticated: Boolean(sessionFor(request)) });
  }
  if (url.pathname === '/api/session' && request.method === 'POST') {
    requireSameOrigin(request);
    const remote = request.socket.remoteAddress || 'unknown';
    const attempt = loginAttempts.get(remote) || { count: 0, resetAt: Date.now() + 300_000 };
    if (attempt.resetAt < Date.now()) { attempt.count = 0; attempt.resetAt = Date.now() + 300_000; }
    if (attempt.count >= 5) throw Object.assign(new Error('Too many login attempts; try again later'), { status: 429 });
    const { password } = await readJson(request);
    if (typeof password !== 'string' || !passwordMatches(password)) {
      attempt.count += 1; loginAttempts.set(remote, attempt);
      throw Object.assign(new Error('Incorrect password'), { status: 401 });
    }
    loginAttempts.delete(remote);
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, { expiresAt: Date.now() + settings.maxAgeMinutes * 60_000 });
    return send(response, 200, { success: true }, 'application/json; charset=utf-8', {
      'Set-Cookie': `awg3_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${settings.maxAgeMinutes * 60}`,
    });
  }

  const session = sessionFor(request);
  if (!session) throw Object.assign(new Error('Not authenticated'), { status: 401 });
  if (!['GET', 'HEAD'].includes(request.method)) requireSameOrigin(request);

  if (url.pathname === '/api/session' && request.method === 'DELETE') {
    sessions.delete(session.token);
    return send(response, 200, { success: true }, 'application/json; charset=utf-8', {
      'Set-Cookie': 'awg3_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    });
  }
  if (url.pathname === '/api/wireguard/status' && request.method === 'GET') {
    const clients = publicClients();
    return send(response, 200, {
      protocols: ['AWG3', 'AWG2'],
      endpoint: `AWG3 ${endpoint('AWG3')} · AWG2 ${endpoint('AWG2')}`,
      endpoints: { AWG3: endpoint('AWG3'), AWG2: endpoint('AWG2') },
      addresses: { AWG3: `${state.server.address}/24`, AWG2: `${state.legacyServer.address}/24` },
      clients: clients.length, enabled: clients.filter((client) => client.enabled).length,
      connected: clients.filter((client) => client.latestHandshakeAt && Date.now() - Date.parse(client.latestHandshakeAt) < 180_000).length,
    });
  }
  if (url.pathname === '/api/wireguard/client' && request.method === 'GET') return send(response, 200, publicClients());
  if (url.pathname === '/api/wireguard/client' && request.method === 'POST') {
    const { name, protocol = 'AWG3' } = await readJson(request);
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 64) throw Object.assign(new Error('Name must contain 1-64 characters'), { status: 400 });
    if (!Object.hasOwn(PROTOCOLS, protocol)) throw Object.assign(new Error('Protocol must be AWG3 or AWG2'), { status: 400 });
    if (Object.values(state.clients).some((client) => client.name.toLowerCase() === name.trim().toLowerCase())) throw Object.assign(new Error('Client name already exists'), { status: 409 });
    let address;
    for (let index = 2; index < 255; index += 1) {
      const candidate = `${protocolSettings(protocol).prefix}.${index}`;
      if (!Object.values(state.clients).some((client) => client.address === candidate)) { address = candidate; break; }
    }
    if (!address) throw Object.assign(new Error('Maximum number of clients reached'), { status: 409 });
    const privateKey = generatePrivateKey();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const client = { id, name: name.trim(), protocol, address, privateKey, publicKey: publicKey(privateKey), preSharedKey: command('awg', ['genpsk']), createdAt: now, updatedAt: now, enabled: true };
    await mutate(() => { state.clients[id] = client; });
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
  if (url.pathname === '/api/routing/policies' && request.method === 'POST') {
    const policy = await routing.addPolicy(await readJson(request));
    return send(response, 201, { id: policy.id });
  }
  if (url.pathname === '/api/routing/default' && request.method === 'PUT') {
    const { route } = await readJson(request);
    await routing.setDefaultRoute(route);
    return send(response, 200, { success: true });
  }
  const upstreamMatch = url.pathname.match(/^\/api\/routing\/upstreams\/([0-9a-f-]+)(?:\/(enable|disable))?$/i);
  if (upstreamMatch) {
    if (request.method === 'POST' && upstreamMatch[2]) {
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

  const match = url.pathname.match(/^\/api\/wireguard\/client\/([0-9a-f-]+)(?:\/(configuration|qrcode\.svg|enable|disable))?$/i);
  if (!match) throw Object.assign(new Error('Not found'), { status: 404 });
  const client = clientById(match[1]);
  const action = match[2];
  if (request.method === 'GET' && action === 'configuration') {
    return send(response, 200, clientConfiguration(state, client), 'text/plain; charset=utf-8', { 'Content-Disposition': `attachment; filename="${safeName(client.name)}.conf"` });
  }
  if (request.method === 'GET' && action === 'qrcode.svg') {
    const svg = command('qrencode', ['-t', 'SVG', '-m', '2', '-s', '8', '-o', '-'], clientConfiguration(state, client));
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
    inboundInterfaces: Object.values(PROTOCOLS).map((item) => item.interface),
    downstreamNetworks: [`${networkPrefix}.0/24`, `${legacyNetworkPrefix}.0/24`],
    mtu: settings.mtu,
    dnsUpstream: settings.dnsUpstream,
    dnsTtlMin: settings.dnsTtlMin,
    dnsTtlMax: settings.dnsTtlMax,
  });
  await routing.load();
  await routing.startAll();
  dnsProxy = new DnsPolicyProxy(routing);
  await dnsProxy.start();
  const server = http.createServer(handle);
  server.listen(settings.uiPort, '0.0.0.0', () => console.log(`[awg-chain-easy] Web UI listening on port ${settings.uiPort}`));
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    server.close();
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
