'use strict';

const crypto = require('node:crypto');
const { DnsPolicyProxy } = require('./dns-proxy');
const { ClientStatistics, runtimeGeneration } = require('./client-statistics');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { listenPort, portRange, withListenPort, connectionStatus } = require('./connections');
const { UpstreamNetwork, chooseTransit, stopProcess, alive } = require('./upstream-network');
const { normalizeFailover, FailoverState, probeUpstream, failoverPriority, priorityFromConfig,
  withPriorityComment, failoverCandidates, withFailoverConfig, migrateFailover } = require('./failover');

const DATA_DIR = '/etc/wireguard';
const ROUTING_FILE = path.join(DATA_DIR, 'routing.json');
const UPSTREAM_DIR = path.join(DATA_DIR, 'upstreams');
const NFT_FAMILY = 'inet';
const NFT_TABLE = 'awg_chain_easy';
const DIRECT_MARK = '0x100';
const BLOCK_MARK = '0x2ff';
const MAX_UPSTREAMS = 8;

function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function run(program, args = [], input = undefined) {
  const result = spawnSync(program, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`${program} ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
  return result.stdout.trim();
}

function tryRun(program, args = [], input = undefined) {
  return spawnSync(program, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

async function atomicWrite(file, content, mode = 0o600) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  await fsp.writeFile(temporary, content, { mode });
  await fsp.rename(temporary, file);
}

function parseIni(config) {
  const sections = { Interface: {}, Peer: {} };
  let section;
  let peerCount = 0;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = line.match(/^\[([^\]]+)]$/);
    if (header) {
      section = header[1];
      if (section === 'Peer') peerCount += 1;
      if (!(section in sections)) throw httpError(`Unsupported config section: ${section}`);
      continue;
    }
    const assignment = line.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (!assignment || !section) throw httpError('Invalid upstream configuration syntax');
    const key = assignment[1].trim();
    if (/^(PreUp|PostUp|PreDown|PostDown|Table|SaveConfig)$/i.test(key)) throw httpError(`${key} is forbidden in imported upstream configs`);
    sections[section][key] = assignment[2].trim();
  }
  if (peerCount !== 1) throw httpError('Upstream config must contain exactly one [Peer] section');
  return sections;
}

function ipv4ToNumber(value) {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((result, part) => (result * 256) + Number(part), 0);
}

function validateNetwork(value) {
  const [address, prefixText] = value.split('/');
  const prefix = prefixText === undefined ? 32 : Number(prefixText);
  if (ipv4ToNumber(address) === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw httpError(`Invalid IPv4 network: ${value}`);
  return prefixText === undefined ? `${address}/32` : value;
}

function validateDomain(value) {
  const domain = String(value).trim().toLowerCase().replace(/\.$/, '');
  const base = domain.startsWith('*.') ? domain.slice(2) : domain;
  if (!base || base.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(base) || base.includes('..')) throw httpError(`Invalid domain: ${value}`);
  return domain;
}

function domainMatches(rule, domain) {
  const normalized = domain.toLowerCase().replace(/\.$/, '');
  if (rule.startsWith('*.')) return normalized.endsWith(`.${rule.slice(2)}`);
  return normalized === rule || normalized.endsWith(`.${rule}`);
}

function validateRoute(route, routingState) {
  if (!route || !['direct', 'blocked', 'upstream'].includes(route.type)) throw httpError('Route type must be direct, blocked, or upstream');
  if (route.type === 'upstream' && !Object.hasOwn(routingState.upstreams, route.upstreamId)) throw httpError('Selected upstream does not exist');
  return route.type === 'upstream' ? { type: 'upstream', upstreamId: route.upstreamId } : { type: route.type };
}

function routeMark(route, routingState) {
  if (route.type === 'direct') return DIRECT_MARK;
  if (route.type === 'blocked') return BLOCK_MARK;
  const upstream = routingState.upstreams[route.upstreamId];
  return upstream ? upstream.mark : BLOCK_MARK;
}

function policySetName(policy) {
  return `p_${policy.id.replace(/-/g, '').slice(0, 12)}`;
}

function shellNftString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

class RoutingManager {
  constructor({ inboundInterfaces, downstreamNetworks, downstreamAddresses, directClientAddresses = () => [], clientRoutes = () => [], mtu, dnsUpstream, dnsUpstreams, dnsTtlMin, dnsTtlMax, inboundPorts = [53, 51820, 51822, 51823], upstreamPorts = portRange() }) {
    this.inboundInterfaces = inboundInterfaces;
    this.inboundPorts = inboundPorts;
    this.upstreamPorts = upstreamPorts;
    this.downstreamNetworks = downstreamNetworks;
    this.downstreamAddresses = downstreamAddresses;
    this.directClientAddresses = directClientAddresses;
    this.clientRoutes = clientRoutes;
    this.mtu = mtu;
    this.dnsUpstream = dnsUpstream;
    this.dnsUpstreams = dnsUpstreams || [dnsUpstream];
    this.dnsTtlMin = dnsTtlMin;
    this.dnsTtlMax = dnsTtlMax;
    this.state = null;
    this.runtime = new Map();
    this.operation = Promise.resolve();
    this.stopping = false;
    this.failover = null;
    this.failoverGeneration = 0;
    this.failoverTimer = null;
    this.failoverAbort = null;
    this.failoverRun = null;
    this.failoverError = null;
    this.failoverLastSwitchAt = null;
    this.appliedDefaultMark = null;
    this.upstreamStatistics = null;
    this.upstreamStatisticsTimer = null;
  }

  enqueue(action) {
    const next = this.operation.then(action, action);
    this.operation = next.catch(() => {});
    return next;
  }

  async load() {
    await fsp.mkdir(UPSTREAM_DIR, { recursive: true, mode: 0o700 });
    try {
      this.state = JSON.parse(await fsp.readFile(ROUTING_FILE, 'utf8'));
      if (this.state.version !== 1 || !this.state.defaultRoute || !this.state.upstreams || !this.state.policies) throw new Error('Unsupported routing.json format');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = { version: 1, defaultRoute: { type: 'direct' }, upstreams: {}, policies: {} };
      await this.save();
    }
    const previous = JSON.stringify(this.state);
    this.state = migrateFailover(this.state);
    this.state.policiesEnabled ??= true;
    this.upstreamStatistics = new ClientStatistics(path.join(DATA_DIR, 'upstream-statistics.json'));
    if (JSON.stringify(this.state) !== previous) await this.save();
  }

  async save() {
    await atomicWrite(ROUTING_FILE, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  validateUpstreamConfig(config) {
    if (typeof config !== 'string' || config.length < 80 || config.length > 131072) throw httpError('Upstream config must contain 80-131072 characters');
    const parsed = parseIni(config);
    const requiredInterface = ['PrivateKey', 'Address', 'Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'H1', 'H2', 'H3', 'H4'];
    const requiredPeer = ['PublicKey', 'Endpoint', 'AllowedIPs'];
    for (const key of requiredInterface) if (!parsed.Interface[key]) throw httpError(`Upstream config is missing Interface ${key}`);
    for (const key of requiredPeer) if (!parsed.Peer[key]) throw httpError(`Upstream config is missing Peer ${key}`);
    const v3Fields = ['HeaderProtectionKey', 'S3', 'S4'];
    const isV3 = v3Fields.some((key) => parsed.Interface[key]);
    if (isV3) {
      for (const key of v3Fields) if (!parsed.Interface[key]) throw httpError(`AWG 3 upstream config is missing Interface ${key}`);
      for (const key of ['S1', 'S2', 'S3', 'S4']) if (!/^\d+$/.test(parsed.Interface[key]) || Number(parsed.Interface[key]) < 12) throw httpError(`AWG 3 requires ${key} to be at least 12`);
    } else {
      for (const key of ['S1', 'S2']) if (!/^\d+$/.test(parsed.Interface[key])) throw httpError(`Legacy AWG upstream ${key} must be an unsigned integer`);
    }
    const address = parsed.Interface.Address.split(',').map((item) => item.trim()).find((item) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(item));
    if (!address) throw httpError('Upstream config requires an IPv4 Interface Address');
    validateNetwork(address);
    if (!parsed.Peer.AllowedIPs.split(',').map((item) => item.trim()).includes('0.0.0.0/0')) throw httpError('Upstream config Peer AllowedIPs must include 0.0.0.0/0');
    const endpoint = parsed.Peer.Endpoint.match(/^([^:\s]+):(\d+)$/);
    if (!endpoint || Number(endpoint[2]) < 1 || Number(endpoint[2]) > 65535 ||
        (ipv4ToNumber(endpoint[1]) === null && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(endpoint[1]))) {
      throw httpError('Upstream Endpoint must be an IPv4 address or hostname plus a valid port');
    }
    const mtu = parsed.Interface.MTU ? Number(parsed.Interface.MTU) : this.mtu;
    if (!Number.isInteger(mtu) || mtu < 576 || mtu > 9000) throw httpError('Upstream MTU is invalid');
    const port = listenPort(parsed.Interface.ListenPort);
    return { parsed, address, mtu, listenPort: port, protocol: isV3 ? 'AWG3' : 'AWG' };
  }

  reservedAddresses() {
    return new Set(this.downstreamAddresses().map(ipv4ToNumber));
  }

  allocateClientAddress(prefix) {
    const reserved = this.reservedAddresses();
    for (let index = 2; index < 255; index += 1) {
      const candidate = `${prefix}.${index}`;
      if (!reserved.has(ipv4ToNumber(candidate))) return candidate;
    }
    throw httpError('No available IPv4 addresses remain in this client pool.', 409);
  }

  upstreamTransit(address) {
    const routes = JSON.parse(run('ip', ['-j', '-4', 'route', 'show', 'table', 'all']));
    const networks = routes.map((route) => route.dst).filter((network) => network && network !== 'default' && network !== '0.0.0.0/0');
    return chooseTransit([...this.downstreamNetworks, address, ...networks,
      ...[...this.runtime.values()].flatMap((runtime) => runtime.network ? [runtime.network.transit.network] : [])]);
  }

  async validateWithAwgQuick(config) {
    const temporary = `/tmp/av${crypto.randomBytes(4).toString('hex')}.conf`;
    await fsp.writeFile(temporary, config, { mode: 0o600 });
    try {
      try { run('awg-quick', ['strip', temporary]); }
      catch (_) { throw httpError('Upstream configuration was rejected by awg-quick'); }
    } finally {
      await fsp.unlink(temporary).catch(() => {});
    }
  }

  async stripUpstreamConfig(upstream, config) {
    // awg-quick derives an interface name from the config basename and rejects
    // UUID-based storage paths. Use the already allocated, valid auN name only
    // for stripping; the persistent secret remains under its opaque ID.
    const temporary = `/tmp/${upstream.interface}.conf`;
    await fsp.writeFile(temporary, config, { mode: 0o600 });
    try {
      try { return run('awg-quick', ['strip', temporary]); }
      catch (_) { throw new Error('Upstream configuration was rejected by awg-quick'); }
    } finally {
      await fsp.unlink(temporary).catch(() => {});
    }
  }

  assertUpstreamPortAvailable(port, excludeUpstreamId = null) {
    if (!port) return;
    if (this.inboundPorts.includes(port)) throw httpError('Upstream listen port conflicts with an inbound UDP listener', 409);
    for (const upstream of Object.values(this.state.upstreams)) {
      if (upstream.id === excludeUpstreamId) continue;
      let saved;
      try { saved = listenPort(parseIni(fs.readFileSync(this.configPath(upstream.id), 'utf8')).Interface.ListenPort); }
      catch (_) { throw httpError('Cannot check reserved ports: repair or delete the unreadable upstream configuration first.', 409); }
      if (saved === port || this.runtime.get(upstream.id)?.listenPort === port) {
        throw httpError('Upstream listen port is already reserved by another upstream', 409);
      }
    }
  }

  validatePublishedPort(value) {
    const port = listenPort(value);
    if (port && !this.upstreamPorts.includes(port)) throw httpError('Fixed listen port must be in UPSTREAM_PORT_RANGE; update the Compose deployment to publish other ports');
    return port;
  }

  async setUpstreamListenPort(id, value) {
    return this.enqueue(async () => {
      const upstream = this.state.upstreams[id];
      if (!upstream) throw httpError('Upstream not found', 404);
      const port = this.validatePublishedPort(value);
      this.assertUpstreamPortAvailable(port, id);
      const original = await fsp.readFile(this.configPath(id), 'utf8');
      const config = withListenPort(original, port);
      this.validateUpstreamConfig(config);
      await this.validateWithAwgQuick(config);
      if (listenPort(parseIni(original).Interface.ListenPort) === port) return;
      try {
        if (upstream.enabled) await this.stopUpstream(upstream);
        await atomicWrite(this.configPath(id), config);
        if (upstream.enabled) await this.startUpstream(upstream);
        await this.reconcile();
      } catch (error) {
        await this.stopUpstream(upstream);
        await atomicWrite(this.configPath(id), original);
        if (upstream.enabled) {
          try { await this.startUpstream(upstream); }
          catch (_) { /* Runtime error is exposed in the upstream snapshot. */ }
        }
        await this.reconcile();
        throw httpError(`Unable to update upstream listen port: ${error.message}`, error.status || 400);
      }
    });
  }

  allocateSlot() {
    const used = new Set(Object.values(this.state.upstreams).map((item) => item.slot));
    for (let slot = 0; slot < MAX_UPSTREAMS; slot += 1) if (!used.has(slot)) return slot;
    throw httpError(`At most ${MAX_UPSTREAMS} upstreams are supported`, 409);
  }

  configPath(id) {
    return path.join(UPSTREAM_DIR, `${id}.conf`);
  }

  async startAll() {
    return this.enqueue(async () => {
      this.blockDownstreamForwarding();
      // Protect saved upstream routes before creating any namespace or tunnel.
      await this.reconcile();
      for (const upstream of Object.values(this.state.upstreams).filter((item) => item.enabled)) {
        try { await this.startUpstream(upstream); }
        catch (error) { this.runtime.set(upstream.id, { ...this.runtime.get(upstream.id), status: 'error', error: error.message }); }
      }
      this.resetFailover();
      await this.reconcile();
      run('nft', ['delete', 'table', 'inet', 'awg_chain_startup']);
      this.collectUpstreamStatistics();
      this.upstreamStatisticsTimer = setInterval(() => { try { this.collectUpstreamStatistics(); } catch (error) { console.error('[awg-chain-easy] Upstream statistics: ' + error.message); } }, 5000);
      this.upstreamStatisticsTimer.unref();
    });
  }

  async waitForSocket(interfaceName, child) {
    const socket = `/var/run/amneziawg/${interfaceName}.sock`;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (!alive(child)) throw new Error('Upstream userspace daemon failed to start');
      try { await fsp.access(socket); return; } catch (_) { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    throw new Error(`UAPI socket did not appear for ${interfaceName}`);
  }

  async startUpstream(upstream) {
    if (this.runtime.get(upstream.id)?.status === 'up') return;
    await this.stopUpstream(upstream);
    if (this.failover?.health.has(upstream.id)) this.failover.record(upstream.id, { success: false, available: false });
    const config = await fsp.readFile(this.configPath(upstream.id), 'utf8');
    const details = this.validateUpstreamConfig(config);
    this.assertUpstreamPortAvailable(details.listenPort, upstream.id);
    const rekey = String(details.parsed.Interface.RekeyAfterTime || '120').split('-').map(Number);
    const runtime = { status: 'starting', stopping: false, endpoint: null, error: null, startedAt: Date.now(),
      rekeyAfterTime: rekey.every(Number.isFinite) ? Math.max(...rekey) : 120 };
    this.runtime.set(upstream.id, runtime);
    const failed = (message) => {
      if (runtime.stopping || this.stopping || this.runtime.get(upstream.id) !== runtime) return;
      runtime.status = 'error';
      runtime.error = message;
      // The permanent prohibit route remains while this active route is withdrawn.
      tryRun('ip', ['-4', 'route', 'delete', 'default', 'metric', '10', 'table', String(upstream.table)]);
      this.enqueue(async () => {
        if (this.runtime.get(upstream.id) !== runtime) return;
        if (this.failover?.health.has(upstream.id)) this.failover.record(upstream.id, { success: false, available: false });
        await this.stopUpstream(upstream);
        this.runtime.set(upstream.id, { status: 'error', error: message });
        await this.reconcile();
      }).catch((error) => { runtime.error = `${runtime.error}; ${error.message}`; });
    };
    try {
      runtime.network = new UpstreamNetwork(upstream.slot, this.upstreamTransit(details.address), failed);
      await runtime.network.create(details.mtu);
      const child = spawn('amneziawg-go', ['-f', upstream.interface], { stdio: ['ignore', 'ignore', 'ignore'] });
      runtime.child = child;
      child.on('error', () => failed('Unable to start upstream userspace daemon'));
      child.on('exit', () => failed('Upstream userspace daemon exited'));
      await this.waitForSocket(upstream.interface, child);
      const stripped = await this.stripUpstreamConfig(upstream, config);
      const syncFile = `/tmp/${upstream.interface}-setconf.conf`;
      await fsp.writeFile(syncFile, `${stripped}\n`, { mode: 0o600 });
      try {
        try { run('awg', ['setconf', upstream.interface, syncFile]); }
        catch (_) { throw new Error('Unable to apply upstream configuration; check its AWG parameters and listen port'); }
      } finally { await fsp.unlink(syncFile).catch(() => {}); }
      await runtime.network.attach(upstream.interface, details.address, details.mtu);
      const endpointOutput = run('awg', ['show', upstream.interface, 'endpoints']);
      runtime.endpoint = endpointOutput.split(/\s+/)[1] || details.parsed.Peer.Endpoint;
      runtime.listenPort = Number(run('awg', ['show', upstream.interface, 'listen-port']));
      runtime.status = 'up';
      runtime.address = details.address;
    } catch (error) {
      await this.stopUpstream(upstream);
      this.runtime.set(upstream.id, { status: 'error', error: error.message });
      throw error;
    }
  }

  async stopUpstream(upstream) {
    this.collectUpstreamStatistics();
    if (this.failover?.health.has(upstream.id)) this.failover.record(upstream.id, { success: false, available: false });
    const runtime = this.runtime.get(upstream.id);
    if (runtime) runtime.stopping = true;
    tryRun('ip', ['-4', 'route', 'delete', 'default', 'metric', '10', 'table', String(upstream.table)]);
    await stopProcess(runtime?.child);
    await runtime?.network?.destroy();
    tryRun('ip', ['link', 'delete', 'dev', upstream.interface]);
    await fsp.unlink(`/var/run/amneziawg/${upstream.interface}.sock`).catch(() => {});
    this.runtime.set(upstream.id, { status: upstream.enabled ? 'error' : 'disabled', error: null });
  }

  systemDirectNetworks() {
    const networks = new Set(this.downstreamNetworks);
    const routes = tryRun('ip', ['-4', 'route', 'show', 'dev', 'eth0']);
    if (routes.status === 0) {
      for (const line of routes.stdout.trim().split('\n')) {
        const destination = line.split(/\s+/)[0];
        if (destination && destination !== 'default' && (destination.includes('/') || ipv4ToNumber(destination) !== null)) networks.add(validateNetwork(destination));
      }
    }
    for (const runtime of this.runtime.values()) {
      const endpoint = runtime.endpoint;
      if (!endpoint) continue;
      const host = endpoint.startsWith('[') ? null : endpoint.replace(/:\d+$/, '');
      if (host && ipv4ToNumber(host) !== null) networks.add(`${host}/32`);
    }
    return [...networks];
  }

  policyNftSet(policy) {
    const elements = policy.networks.length ? ` elements = { ${policy.networks.join(', ')} };` : '';
    return `set ${policySetName(policy)} { type ipv4_addr; flags interval, timeout;${elements} }`;
  }

  directAddresses() {
    const addresses = [...new Set(this.directClientAddresses())];
    if (addresses.some((address) => ipv4ToNumber(address) === null)) throw new Error('Invalid direct client IPv4 address');
    return addresses;
  }

  validateClientEgress({ egress = 'default', upstreamId = null }) {
    if (!['default', 'direct', 'upstream'].includes(egress)) throw httpError('Client egress must be default, direct, or upstream');
    if (egress === 'upstream' && (typeof upstreamId !== 'string' || !Object.hasOwn(this.state.upstreams, upstreamId))) throw httpError('Selected client upstream does not exist');
    return { egress, upstreamId: egress === 'upstream' ? upstreamId : null };
  }

  clientSourceSets() {
    const sets = { direct_clients_v4: this.directAddresses(), blocked_clients_v4: [] };
    for (let slot = 0; slot < MAX_UPSTREAMS; slot++) sets[`client_upstream_${slot}`] = [];
    for (const client of this.clientRoutes()) {
      if (client.enabled === false || !['direct', 'upstream'].includes(client.egress)) continue;
      if (ipv4ToNumber(client.address) === null) throw new Error('Invalid client IPv4 address');
      if (client.egress === 'direct') sets.direct_clients_v4.push(client.address);
      else {
        const upstream = this.state.upstreams[client.upstreamId];
        const name = upstream && Number.isInteger(upstream.slot) && upstream.slot >= 0 && upstream.slot < MAX_UPSTREAMS
          ? `client_upstream_${upstream.slot}` : 'blocked_clients_v4';
        sets[name].push(client.address);
      }
    }
    return Object.fromEntries(Object.entries(sets).map(([name, values]) => [name, [...new Set(values)]]));
  }

  async syncDirectClients() {
    const sets = this.clientSourceSets();
    const result = this.applyNftScript(Object.entries(sets).map(([name, values]) =>
      `flush set ${NFT_FAMILY} ${NFT_TABLE} ${name}\n` +
      (values.length ? `add element ${NFT_FAMILY} ${NFT_TABLE} ${name} { ${values.join(', ')} }\n` : '')).join(''));
    if (result.status !== 0) throw new Error('Unable to apply direct client routing and pinned upstreams');
  }

  nftScript() {
    const activePolicies = Object.values(this.state.policies).filter((item) => item.enabled).sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
    const system = this.systemDirectNetworks();
    const clientSets = this.clientSourceSets();
    const clientDeclarations = Object.entries(clientSets).map(([name, values]) =>
      `    set ${name} { type ipv4_addr;${values.length ? ` elements = { ${values.join(', ')} };` : ''} }`).join('\n');
    const clientClassification = [
      `        ip saddr @blocked_clients_v4 meta mark set ${BLOCK_MARK} ct mark set meta mark return`,
      ...Array.from({ length: MAX_UPSTREAMS }, (_, slot) => `        ip saddr @client_upstream_${slot} meta mark set 0x${(0x201 + slot).toString(16)} ct mark set meta mark return`),
    ].join('\n');
    if (ipv4ToNumber(this.dnsUpstream) === null) throw new Error('DNS upstream must be IPv4');
    const declarations = activePolicies.map((policy) => `    ${this.policyNftSet(policy)}`).join('\n');
    const classification = activePolicies.map((policy) => `        ip daddr @${policySetName(policy)} meta mark set ${routeMark(policy.route, this.state)} ct mark set meta mark return`).join('\n');
    const upstreamNat = Object.values(this.state.upstreams).flatMap((upstream) => {
      const network = this.runtime.get(upstream.id)?.network;
      return network ? this.downstreamNetworks.map((source) => `        ip saddr ${source} oifname ${shellNftString(network.device)} snat ip to ${network.transit.router}`) : [];
    }).join('\n');
    const inboundFilter = this.inboundInterfaces.map((interfaceName) => `iifname != ${shellNftString(interfaceName)}`).join(' ');
    const enforce = this.inboundInterfaces.flatMap((interfaceName) => [
      `        iifname ${shellNftString(interfaceName)} meta mark ${BLOCK_MARK} reject with icmp type admin-prohibited`,
      ...Array.from({ length: MAX_UPSTREAMS }, (_, slot) => `        iifname ${shellNftString(interfaceName)} meta mark 0x${(0x201 + slot).toString(16)} oifname != "av${slot}" reject with icmp type admin-prohibited`),
    ]).join('\n');
    const dnsRedirect = this.inboundInterfaces.flatMap((interfaceName) => [
      `        iifname ${shellNftString(interfaceName)} ip saddr @blocked_clients_v4 udp dport 53 drop`,
      `        iifname ${shellNftString(interfaceName)} ip saddr @blocked_clients_v4 tcp dport 53 drop`,
      ...Array.from({ length: MAX_UPSTREAMS }, (_, slot) => [
        `        iifname ${shellNftString(interfaceName)} ip saddr @client_upstream_${slot} udp dport 53 dnat ip to ${this.dnsUpstream}:53`,
        `        iifname ${shellNftString(interfaceName)} ip saddr @client_upstream_${slot} tcp dport 53 dnat ip to ${this.dnsUpstream}:53`,
      ]).flat(),
      `        iifname ${shellNftString(interfaceName)} udp dport 53 redirect to :53`,
      `        iifname ${shellNftString(interfaceName)} tcp dport 53 redirect to :53`,
    ]).join('\n');
    return `flush table ${NFT_FAMILY} ${NFT_TABLE}\n` +
      `table ${NFT_FAMILY} ${NFT_TABLE} {\n` +
      `    set system_direct_v4 { type ipv4_addr; flags interval; elements = { ${system.join(', ')} }; }\n` +
      `${clientDeclarations}\n` +
      `${declarations ? `${declarations}\n` : ''}` +
      `    chain classify {\n` +
      `        type filter hook prerouting priority -150; policy accept;\n` +
      `        ${inboundFilter} return\n` +
      `        ip saddr @direct_clients_v4 meta mark set ${DIRECT_MARK} ct mark set meta mark return\n` +
      `${clientClassification}\n` +
      `        meta mark set ct mark\n` +
      `        ct mark != 0 return\n` +
      `        ip daddr @system_direct_v4 meta mark set ${DIRECT_MARK} ct mark set meta mark return\n` +
      `        jump policy_gate\n` +
      `        ct mark != 0 return\n` +
      `        jump default_route\n` +
      `    }\n` +
      `    chain policy_gate { ${this.state.policiesEnabled !== false ? 'jump policy_routes;' : ''} }\n` +
      `    chain policy_routes {\n${classification ? `${classification}\n` : ''}    }\n` +
      `    chain default_route {\n` +
      `        meta mark set ${routeMark(this.effectiveDefaultRoute(), this.state)} ct mark set meta mark\n` +
      `    }\n` +
      `    chain enforce {\n` +
      `        type filter hook forward priority -10; policy accept;\n` +
      `${enforce}\n` +
      `    }\n` +
      `    chain dns_redirect {\n` +
      `        type nat hook prerouting priority -100; policy accept;\n` +
      `${dnsRedirect}\n` +
      `    }\n` +
      `    chain source_nat {\n` +
      `        type nat hook postrouting priority 100; policy accept;\n` +
      `${upstreamNat ? `${upstreamNat}\n` : ''}` +
      `    }\n` +
      `}\n`;
  }

  removeRule(priority) {
    while (tryRun('ip', ['-4', 'rule', 'delete', 'priority', String(priority)]).status === 0) { /* remove duplicates */ }
  }

  applyNftScript(script) {
    const file = `/tmp/awg-chain-easy-nft-${process.pid}-${crypto.randomBytes(4).toString('hex')}.nft`;
    fs.writeFileSync(file, script, { mode: 0o600 });
    try { return tryRun('nft', ['-f', file]); } finally { try { fs.unlinkSync(file); } catch (_) { /* Best effort. */ } }
  }

  async reconcile() {
    const rules = JSON.parse(run('ip', ['-j', '-4', 'rule', 'show']));
    const ensureRule = (priority, mark, table) => {
      if (rules.some((rule) => rule.priority === priority && Number(rule.fwmark) === Number(mark)
        && Number(rule.fwmask) === 0xfff && String(rule.table) === String(table))) return;
      run('ip', ['-4', 'rule', 'add', 'priority', String(priority), 'fwmark', `${mark}/0xfff`, 'lookup', String(table)]);
    };
    ensureRule(11000, DIRECT_MARK, 'main');
    for (let slot = 0; slot < MAX_UPSTREAMS; slot += 1) {
      const table = String(201 + slot);
      run('ip', ['-4', 'route', 'replace', 'prohibit', 'default', 'metric', '32760', 'table', table]);
      ensureRule(11100 + slot, `0x${(0x201 + slot).toString(16)}`, table);
      const upstream = Object.values(this.state.upstreams).find((item) => item.slot === slot);
      const runtime = upstream && this.runtime.get(upstream.id);
      if (upstream?.enabled && runtime?.status === 'up' && runtime.network?.available()) {
        const { device, transit } = runtime.network;
        run('ip', ['-4', 'route', 'replace', 'default', 'via', transit.tunnel, 'dev', device, 'metric', '10', 'table', table]);
      } else tryRun('ip', ['-4', 'route', 'delete', 'default', 'metric', '10', 'table', table]);
    }
    const script = this.nftScript();
    const result = this.applyNftScript(script);
    if (result.status !== 0) {
      if ((result.stderr || '').includes('No such file or directory') && (result.stderr || '').includes('flush table')) {
        const retry = this.applyNftScript(script.replace(`flush table ${NFT_FAMILY} ${NFT_TABLE}\n`, ''));
        if (retry.status !== 0) throw new Error(`nft reconciliation failed: ${(retry.stderr || retry.stdout).trim()}`);
      } else throw new Error(`nft reconciliation failed: ${(result.stderr || result.stdout).trim()}`);
    }
    this.appliedDefaultMark = routeMark(this.effectiveDefaultRoute(), this.state);
  }

  effectiveDefaultRoute() {
    return this.failover ? this.failover.route((id) => this.state.upstreams[id]?.enabled && this.runtime.get(id)?.status === 'up') : this.state.defaultRoute;
  }

  failoverConfig() {
    return { ...this.state.failover, candidates: failoverCandidates(this.state) };
  }

  resetFailover(preserveHealth = false) {
    const previous = this.failover;
    clearTimeout(this.failoverTimer);
    this.failoverAbort?.abort();
    this.failoverGeneration += 1;
    this.failoverError = null;
    this.failover = this.state.failover?.enabled
      ? new FailoverState(this.failoverConfig(), this.state.defaultRoute.upstreamId, this.state.failoverSelectedUpstreamId) : null;
    if (preserveHealth && previous && this.failover) {
      const sameChecks = ['targets', 'failureThreshold', 'recoveryThreshold', 'intervalSeconds', 'timeoutSeconds']
        .every((key) => JSON.stringify(previous.config[key]) === JSON.stringify(this.failover.config[key]));
      for (const id of this.failover.ids) {
        const health = previous.health.get(id);
        if (health) this.failover.health.set(id, sameChecks ? { ...health }
          : { ...health, healthy: health.healthy === false ? false : null, successes: 0, failures: 0 });
      }
      // Removing the selection must not send traffic through an untested replacement.
      const selected = this.failover.health.get(this.failover.selectedId);
      if (selected && this.failover.selectedId !== previous.selectedId && !this.failover.eligible(this.failover.selectedId)) selected.healthy = false;
    }
    if (this.failover && !this.stopping) this.scheduleFailover(0);
  }

  scheduleFailover(delayMs) {
    const generation = this.failoverGeneration;
    this.failoverTimer = setTimeout(() => {
      const startedAt = Date.now();
      this.failoverRun = this.checkFailover(generation).catch(() => {
        if (generation === this.failoverGeneration) this.failoverError = 'Unable to apply failover routing; another check will retry.';
      }).finally(() => {
        if (!this.stopping && generation === this.failoverGeneration) {
          this.scheduleFailover(Math.max(0, this.state.failover.intervalSeconds * 1000 - (Date.now() - startedAt)));
        }
      });
    }, delayMs);
    this.failoverTimer.unref();
  }

  async checkFailover(generation) {
    if (this.stopping || generation !== this.failoverGeneration || !this.failover) return;
    const controller = new AbortController();
    this.failoverAbort = controller;
    const samples = await Promise.all(this.failover.ids.map(async (id) => {
      const upstream = this.state.upstreams[id];
      const runtime = this.runtime.get(id);
      const available = Boolean(upstream?.enabled && runtime?.status === 'up' && runtime.network?.available());
      const result = available ? await probeUpstream(upstream, this.state.failover, this.dnsUpstream, controller.signal, runtime.network)
        : { success: false, available: false };
      return { id, runtime, available, result, checkedAt: Date.now() };
    }));
    await this.enqueue(async () => {
      if (this.stopping || controller.signal.aborted || generation !== this.failoverGeneration) return;
      // Never treat an old interface's result or a delayed queued sample as proof of health.
      for (const { id, runtime, available, result, checkedAt } of samples) {
        if (this.runtime.get(id) !== runtime || available !== Boolean(this.state.upstreams[id]?.enabled && runtime?.status === 'up')) {
          this.failover.record(id, { success: false, available: false });
        } else if (Date.now() - checkedAt <= this.failover.maxAgeMs) this.failover.record(id, result, checkedAt);
      }
      const previousId = this.failover.selectedId;
      this.failover.choose();
      await this.applyFailoverSelection(previousId);
      this.failoverError = null;
    });
  }

  async applyFailoverSelection(previousId) {
    const previousSavedId = this.state.failoverSelectedUpstreamId;
    const changed = previousId !== this.failover.selectedId;
    try {
      if (changed) {
        this.state.failoverSelectedUpstreamId = this.failover.selectedId;
        await this.save();
      }
      this.applyDefaultRoute();
      if (changed) this.failoverLastSwitchAt = new Date().toISOString();
    } catch (error) {
      this.failover.selectedId = previousId;
      if (changed) {
        this.state.failoverSelectedUpstreamId = previousSavedId;
        await this.save();
      }
      throw error;
    }
  }

  applyDefaultRoute() {
    const mark = routeMark(this.effectiveDefaultRoute(), this.state);
    if (mark === this.appliedDefaultMark) return;
    // Priority edits and switches preserve learned DNS sets and connection marks.
    const result = this.applyNftScript(`flush chain ${NFT_FAMILY} ${NFT_TABLE} default_route\nadd rule ${NFT_FAMILY} ${NFT_TABLE} default_route meta mark set ${mark} ct mark set meta mark\n`);
    if (result.status !== 0) throw new Error('Unable to update the default route');
    this.appliedDefaultMark = mark;
  }

  async saveFailoverConfig(config) {
    const previous = this.state;
    const previousMonitor = this.failover;
    this.state = withFailoverConfig(this.state, config);
    this.state.failoverSelectedUpstreamId = new FailoverState(config, this.state.defaultRoute.upstreamId,
      previous.failover?.enabled ? previousMonitor?.selectedId ?? previous.failoverSelectedUpstreamId : undefined).selectedId || null;
    try { await this.save(); }
    catch (error) { this.state = previous; throw error; }
    this.resetFailover(true);
    try { this.applyDefaultRoute(); }
    catch (error) {
      this.state = previous;
      await this.save();
      this.failover = previousMonitor;
      this.resetFailover(true);
      throw error;
    }
  }

  async setFailover(input) {
    return this.enqueue(async () => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError('Failover settings must be an object');
      const merged = { ...this.failoverConfig(), ...input };
      if (Object.hasOwn(input, 'backupUpstreamId') && !Object.hasOwn(input, 'candidates')) delete merged.candidates;
      const config = normalizeFailover(merged, this.state);
      await this.saveFailoverConfig(config);
    });
  }

  async setUpstreamPriority(id, value) {
    return this.enqueue(async () => {
      if (!Object.hasOwn(this.state.upstreams, id)) throw httpError('Upstream not found', 404);
      const priority = failoverPriority(value);
      const candidates = failoverCandidates(this.state).filter((candidate) => candidate.upstreamId !== id);
      if (priority !== null) candidates.push({ upstreamId: id, priority });
      const config = normalizeFailover({ ...this.state.failover, candidates }, this.state);
      await this.saveFailoverConfig(config);
    });
  }

  async exportUpstreamConfig(id) {
    return this.enqueue(async () => {
      const upstream = this.state.upstreams[id];
      if (!upstream) throw httpError('Upstream not found', 404);
      const config = await fsp.readFile(this.configPath(id), 'utf8');
      return withPriorityComment(config, upstream.failoverPriority);
    });
  }

  preferredFailoverCandidates() {
    return this.failover?.preferredCandidates(Date.now(), (id) => this.state.upstreams[id]?.enabled && this.runtime.get(id)?.status === 'up') || [];
  }

  async returnToPreferred() {
    return this.enqueue(async () => {
      const candidates = this.preferredFailoverCandidates();
      if (!candidates.length) throw httpError('A higher-priority upstream must pass fresh recovery checks before switching back', 409);
      const previousId = this.failover.selectedId;
      this.failover.selectedId = this.failover.pick(candidates);
      await this.applyFailoverSelection(previousId);
    });
  }

  async setPoliciesEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw httpError('Policies enabled must be a boolean');
    return this.enqueue(async () => {
      const previous = this.state.policiesEnabled !== false;
      const gate = (value) => {
        const result = this.applyNftScript(`flush chain ${NFT_FAMILY} ${NFT_TABLE} policy_gate\n` +
          (value ? `add rule ${NFT_FAMILY} ${NFT_TABLE} policy_gate jump policy_routes\n` : ''));
        if (result.status !== 0) throw new Error('Unable to apply routing policy switch');
      };
      try {
        this.state.policiesEnabled = enabled;
        await this.save(); gate(enabled);
        for (const client of this.clientRoutes().filter((c) => c.enabled && (!c.egress || c.egress === 'default'))) {
          if (ipv4ToNumber(client.address) === null) throw new Error('Invalid client IPv4 address');
          const result = tryRun('conntrack', ['-D', '-f', 'ipv4', '-s', client.address]);
          if (![0, 1].includes(result.status)) throw new Error('Unable to clear previous client connections');
        }
      } catch (error) { this.state.policiesEnabled = previous; await this.save(); gate(previous); throw error; }
    });
  }

  matchingDomainPolicy(domain) {
    return Object.values(this.state.policies)
      .filter((policy) => policy.enabled && policy.domains.some((rule) => domainMatches(rule, domain)))
      .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))[0] || null;
  }

  async addDnsAddresses(policy, addresses, ttl) {
    if (!policy || !addresses.length) return;
    const timeout = Math.max(this.dnsTtlMin, Math.min(this.dnsTtlMax, ttl));
    await this.enqueue(async () => {
      for (const address of addresses) {
        tryRun('nft', ['delete', 'element', NFT_FAMILY, NFT_TABLE, policySetName(policy), '{', address, '}']);
        const result = tryRun('nft', ['add', 'element', NFT_FAMILY, NFT_TABLE, policySetName(policy), '{', address, 'timeout', `${timeout}s`, '}']);
        if (result.status !== 0 && !(result.stderr || '').includes('interval overlaps')) throw new Error(`Unable to add DNS route for ${address}: ${result.stderr.trim()}`);
      }
    });
  }

  async addUpstream({ name, config, listenPort: requestedPort, failoverPriority: requestedPriority }) {
    return this.enqueue(async () => {
      const cleanName = String(name || '').trim();
      if (!cleanName || cleanName.length > 64) throw httpError('Upstream name must contain 1-64 characters');
      if (Object.values(this.state.upstreams).some((item) => item.name.toLowerCase() === cleanName.toLowerCase())) throw httpError('Upstream name already exists', 409);
      // Validate the original first so malformed/secret input is never rewritten blindly.
      this.validateUpstreamConfig(config);
      const importedPriority = priorityFromConfig(config);
      const priority = requestedPriority === undefined ? importedPriority : failoverPriority(requestedPriority);
      if (requestedPort !== undefined) config = withListenPort(config, this.validatePublishedPort(requestedPort));
      const details = this.validateUpstreamConfig(config);
      this.assertUpstreamPortAvailable(details.listenPort);
      await this.validateWithAwgQuick(config);
      const slot = this.allocateSlot();
      const id = crypto.randomUUID();
      const upstream = { id, name: cleanName, protocol: details.protocol, enabled: true, failoverPriority: priority, slot, interface: `au${slot}`, table: 201 + slot, mark: `0x${(0x201 + slot).toString(16)}`, createdAt: new Date().toISOString() };
      await atomicWrite(this.configPath(id), config.endsWith('\n') ? config : `${config}\n`);
      this.state.upstreams[id] = upstream;
      await this.save();
      try {
        await this.startUpstream(upstream);
        this.resetFailover(true);
        await this.reconcile();
      } catch (error) {
        await this.stopUpstream(upstream);
        delete this.state.upstreams[id];
        this.runtime.delete(id);
        this.resetFailover(true);
        await this.save();
        await fsp.unlink(this.configPath(id)).catch(() => {});
        await this.reconcile();
        throw httpError(`Unable to start upstream: ${error.message}`, error.status || 400);
      }
      return upstream;
    });
  }

  async setUpstreamEnabled(id, enabled) {
    return this.enqueue(async () => {
      const upstream = this.state.upstreams[id];
      if (!upstream) throw httpError('Upstream not found', 404);
      upstream.enabled = enabled;
      try {
        if (enabled) await this.startUpstream(upstream); else await this.stopUpstream(upstream);
      } catch (error) {
        await this.save();
        await this.reconcile();
        throw httpError(`Unable to start upstream: ${error.message}`, error.status || 400);
      }
      await this.save();
      await this.reconcile();
    });
  }

  async deleteUpstream(id) {
    return this.enqueue(async () => {
      const upstream = this.state.upstreams[id];
      if (!upstream) throw httpError('Upstream not found', 404);
      if (this.clientRoutes().some((client) => client.egress === 'upstream' && client.upstreamId === id)) throw httpError('Upstream is assigned to a client', 409);
      if (this.state.defaultRoute.type === 'upstream' && this.state.defaultRoute.upstreamId === id) throw httpError('Upstream is used by the default route', 409);
      if (upstream.failoverPriority != null) throw httpError('Clear this upstream’s failover priority before deleting it', 409);
      if (Object.values(this.state.policies).some((policy) => policy.route.type === 'upstream' && policy.route.upstreamId === id)) throw httpError('Upstream is used by a routing policy', 409);
      await this.stopUpstream(upstream);
      delete this.state.upstreams[id];
      this.runtime.delete(id);
      await fsp.unlink(this.configPath(id)).catch(() => {});
      await this.save();
      await this.reconcile();
    });
  }

  normalizePolicy(input, existingId = null) {
    const name = String(input.name || '').trim();
    if (!name || name.length > 64) throw httpError('Policy name must contain 1-64 characters');
    const priority = Number(input.priority);
    if (!Number.isInteger(priority) || priority < 1 || priority > 10000) throw httpError('Policy priority must be between 1 and 10000');
    const domains = [...new Set((Array.isArray(input.domains) ? input.domains : []).map(validateDomain))];
    const networks = [...new Set((Array.isArray(input.networks) ? input.networks : []).map((item) => validateNetwork(String(item).trim())))];
    if (!domains.length && !networks.length) throw httpError('Policy requires at least one domain or IPv4 network');
    if (Object.values(this.state.policies).some((item) => item.id !== existingId && item.priority === priority)) throw httpError('Policy priority is already used', 409);
    return { name, priority, domains, networks, route: validateRoute(input.route, this.state), enabled: input.enabled !== false };
  }

  async addPolicy(input) {
    return this.enqueue(async () => {
      const id = crypto.randomUUID();
      this.state.policies[id] = { id, ...this.normalizePolicy(input), createdAt: new Date().toISOString() };
      await this.save();
      await this.reconcile();
      return this.state.policies[id];
    });
  }

  async updatePolicy(id, input) {
    return this.enqueue(async () => {
      const existing = this.state.policies[id];
      if (!existing) throw httpError('Policy not found', 404);
      this.state.policies[id] = { id, ...this.normalizePolicy(input, id), createdAt: existing.createdAt };
      await this.save();
      await this.reconcile();
      return this.state.policies[id];
    });
  }

  async setPolicyEnabled(id, enabled) {
    return this.enqueue(async () => {
      const policy = this.state.policies[id];
      if (!policy) throw httpError('Policy not found', 404);
      policy.enabled = enabled;
      await this.save();
      await this.reconcile();
    });
  }

  async deletePolicy(id) {
    return this.enqueue(async () => {
      if (!this.state.policies[id]) throw httpError('Policy not found', 404);
      delete this.state.policies[id];
      await this.save();
      await this.reconcile();
    });
  }

  async setDefaultRoute(route) {
    return this.enqueue(async () => {
      const next = validateRoute(route, this.state);
      if (this.state.failover?.enabled && next.type !== 'upstream') throw httpError('Disable failover before choosing Direct or Blocked as the default route');
      normalizeFailover(this.failoverConfig(), { ...this.state, defaultRoute: next });
      this.state.defaultRoute = next;
      this.state.failoverSelectedUpstreamId = next.upstreamId || null;
      await this.save();
      this.resetFailover(true);
      await this.reconcile();
    });
  }

  readUpstreamStats(upstream) {
    let runtime = this.runtime.get(upstream.id) || { status: upstream.enabled ? 'down' : 'disabled' };
    if (runtime.status === 'up' && !runtime.network?.available()) runtime = { ...runtime, status: 'error', error: 'Upstream namespace link is unavailable' };
    let stats = { latestHandshakeAt: null, transferRx: 0, transferTx: 0, persistentKeepalive: 0 };
    let readable = false;
    let configuredListenPort = null;
    let configurationError = null;
    try {
      const config = parseIni(fs.readFileSync(this.configPath(upstream.id), 'utf8'));
      configuredListenPort = listenPort(config.Interface.ListenPort) || null;
    } catch (_) { configurationError = 'Cannot read saved upstream port'; }
    let endpoint = runtime.endpoint || null;
    if (runtime.status === 'up') {
      try {
        const peer = run('awg', ['show', upstream.interface, 'dump']).split('\n')[1];
        if (peer) {
          const fields = peer.split('\t');
          if (fields.length < 8) throw new Error('Incomplete peer status');
          stats = { latestHandshakeAt: fields[4] === '0' ? null : new Date(Number(fields[4]) * 1000).toISOString(),
            transferRx: Number(fields[5] || 0), transferTx: Number(fields[6] || 0), persistentKeepalive: listenPort(fields[7] === 'off' ? 0 : fields[7]) };
          endpoint = fields[2] === '(none)' ? null : fields[2];
          readable = true;
        }
      } catch (_) { /* Process availability and peer status are separate signals. */ }
    }
    return { ...upstream, status: runtime.status, endpoint, error: runtime.error || configurationError,
      listenPort: runtime.listenPort || configuredListenPort, configuredListenPort,
      portInPublishedRange: Boolean(configuredListenPort && this.upstreamPorts.includes(configuredListenPort)),
      connectionStatus: connectionStatus({ ...runtime, ...stats, readable }), ...stats };
  }

  upstreamIdentity(upstream) {
    let publicKey = this.upstreamStatistics?.entries[upstream.id]?.publicKey || upstream.id + ':unknown';
    try { publicKey = upstream.id + ':' + parseIni(fs.readFileSync(this.configPath(upstream.id), 'utf8')).Peer.PublicKey; } catch (_) {}
    return { id: upstream.id, publicKey, protocol: upstream.protocol || 'AWG3' };
  }

  upstreamGeneration(upstream) { return runtimeGeneration(upstream.interface); }

  collectUpstreamStatistics() {
    if (!this.upstreamStatistics || !this.state) return;
    const clients = [], stats = new Map();
    for (const upstream of Object.values(this.state.upstreams)) {
      const identity = this.upstreamIdentity(upstream); clients.push(identity);
      const raw = this.readUpstreamStats(upstream);
      if (raw.status === 'up' && raw.connectionStatus !== 'unknown') {
        try { stats.set(identity.publicKey, { ...raw, generation: this.upstreamGeneration(upstream) }); } catch (_) {}
      }
    }
    this.upstreamStatistics.observe(clients, stats);
  }

  resetUpstreamTraffic(id = null) {
    return this.enqueue(async () => {
      if (id && !this.state.upstreams[id]) throw httpError('Upstream not found', 404);
      if (!this.upstreamStatistics) throw httpError('Upstream statistics storage is unavailable', 503);
      this.collectUpstreamStatistics();
      const clients = [], samples = new Map();
      for (const upstream of Object.values(this.state.upstreams)) {
        const identity = this.upstreamIdentity(upstream); clients.push(identity);
        const raw = this.readUpstreamStats(upstream);
        if (raw.status === 'up' && raw.connectionStatus !== 'unknown') {
          try { samples.set(identity.publicKey, { ...raw, generation: this.upstreamGeneration(upstream) }); } catch (_) {}
        }
      }
      const filename = this.upstreamStatistics.filename;
      if (fs.existsSync(filename)) await fsp.copyFile(filename, filename + '.before-reset-' + Date.now());
      this.upstreamStatistics.resetTraffic(clients, samples, id ? new Set([id]) : null);
    });
  }

  upstreamStats(upstream) {
    const raw = this.readUpstreamStats(upstream);
    const totals = this.upstreamStatistics?.values(this.upstreamIdentity(upstream));
    return totals ? { ...raw, transferRx: totals.transferRx, transferTx: totals.transferTx } : raw;
  }

  snapshot() {
    this.collectUpstreamStatistics();
    return {
      defaultRoute: this.state.defaultRoute,
      effectiveDefaultRoute: this.effectiveDefaultRoute(),
      failover: { config: this.failoverConfig(), selectedUpstreamId: this.failover?.selectedId || null,
        preferredUpstreamIds: this.preferredFailoverCandidates(),
        health: this.failover?.snapshot() || {}, lastSwitchAt: this.failoverLastSwitchAt, error: this.failoverError },
      publishedUpstreamPorts: this.upstreamPorts,
      upstreams: Object.values(this.state.upstreams).map((item) => this.upstreamStats(item)).sort((a, b) => a.slot - b.slot),
      policiesEnabled: this.state.policiesEnabled !== false,
      policies: Object.values(this.state.policies).sort((a, b) => a.priority - b.priority),
      dns: { status: 'running', upstream: this.dnsUpstream, upstreams: this.dnsUpstreams, ipv6Supported: false },
    };
  }

  blockDownstreamForwarding() {
    const guard = this.applyNftScript(`add table inet awg_chain_startup\nadd chain inet awg_chain_startup forward { type filter hook forward priority -20; policy accept; }\nflush chain inet awg_chain_startup forward\n` +
      this.inboundInterfaces.map((name) => `add rule inet awg_chain_startup forward iifname ${shellNftString(name)} drop\n`).join(''));
    if (guard.status !== 0) throw new Error('Unable to guard downstream forwarding during routing initialization or shutdown');
  }

  async shutdown() {
    this.stopping = true;
    clearInterval(this.upstreamStatisticsTimer);
    this.collectUpstreamStatistics();
    const errors = [];
    try { this.blockDownstreamForwarding(); } catch (error) { errors.push(error); }
    clearTimeout(this.failoverTimer);
    this.failoverAbort?.abort();
    await this.failoverRun?.catch(() => {});
    await this.operation;
    for (const upstream of Object.values(this.state.upstreams)) {
      try { await this.stopUpstream(upstream); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new Error('Routing shutdown could not complete; forwarding guards were retained');
    tryRun('nft', ['delete', 'table', NFT_FAMILY, NFT_TABLE]);
    this.removeRule(11000);
    for (let slot = 0; slot < MAX_UPSTREAMS; slot += 1) {
      this.removeRule(11100 + slot);
      tryRun('ip', ['-4', 'route', 'flush', 'table', String(201 + slot)]);
    }
  }
}

module.exports = { RoutingManager, DnsPolicyProxy };
