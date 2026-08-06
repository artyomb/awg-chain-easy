'use strict';

const crypto = require('node:crypto');
const dgram = require('node:dgram');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

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
    if (!assignment || !section) throw httpError(`Invalid upstream config line: ${line.slice(0, 80)}`);
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
  if (route.type === 'upstream' && !routingState.upstreams[route.upstreamId]) throw httpError('Selected upstream does not exist');
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
  constructor({ inboundInterface, downstreamNetwork, mtu, dnsUpstream, dnsTtlMin, dnsTtlMax }) {
    this.inboundInterface = inboundInterface;
    this.downstreamNetwork = downstreamNetwork;
    this.mtu = mtu;
    this.dnsUpstream = dnsUpstream;
    this.dnsTtlMin = dnsTtlMin;
    this.dnsTtlMax = dnsTtlMax;
    this.state = null;
    this.runtime = new Map();
    this.operation = Promise.resolve();
    this.stopping = false;
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
    return { parsed, address, mtu, protocol: isV3 ? 'AWG3' : 'AWG' };
  }

  async validateWithAwgQuick(config) {
    const temporary = `/tmp/av${crypto.randomBytes(4).toString('hex')}.conf`;
    await fsp.writeFile(temporary, config, { mode: 0o600 });
    try {
      run('awg-quick', ['strip', temporary]);
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
      return run('awg-quick', ['strip', temporary]);
    } finally {
      await fsp.unlink(temporary).catch(() => {});
    }
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
    for (const upstream of Object.values(this.state.upstreams).filter((item) => item.enabled)) {
      try { await this.startUpstream(upstream); } catch (error) { this.runtime.set(upstream.id, { status: 'error', error: error.message }); }
    }
    await this.reconcile();
  }

  async waitForSocket(interfaceName) {
    const socket = `/var/run/amneziawg/${interfaceName}.sock`;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { await fsp.access(socket); return; } catch (_) { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    throw new Error(`UAPI socket did not appear for ${interfaceName}`);
  }

  async startUpstream(upstream) {
    if (this.runtime.get(upstream.id)?.status === 'up') return;
    const config = await fsp.readFile(this.configPath(upstream.id), 'utf8');
    const details = this.validateUpstreamConfig(config);
    tryRun('ip', ['link', 'delete', 'dev', upstream.interface]);
    await fsp.unlink(`/var/run/amneziawg/${upstream.interface}.sock`).catch(() => {});
    const child = spawn('amneziawg-go', ['-f', upstream.interface], { stdio: ['ignore', 'ignore', 'pipe'] });
    const runtime = { child, status: 'starting', stopping: false, endpoint: null, error: null };
    this.runtime.set(upstream.id, runtime);
    let daemonError = '';
    child.stderr.on('data', (chunk) => { daemonError = `${daemonError}${chunk}`.slice(-2048); });
    child.on('exit', () => {
      if (runtime.stopping || this.stopping) return;
      runtime.status = 'error';
      runtime.error = daemonError.trim() || 'userspace daemon exited';
      this.reconcile().catch((error) => { runtime.error = `${runtime.error}; ${error.message}`; });
    });
    try {
      await this.waitForSocket(upstream.interface);
      const stripped = await this.stripUpstreamConfig(upstream, config);
      const syncFile = `/tmp/${upstream.interface}-setconf.conf`;
      await fsp.writeFile(syncFile, `${stripped}\n`, { mode: 0o600 });
      try { run('awg', ['setconf', upstream.interface, syncFile]); } finally { await fsp.unlink(syncFile).catch(() => {}); }
      run('ip', ['-4', 'address', 'add', details.address, 'dev', upstream.interface]);
      run('ip', ['link', 'set', 'mtu', String(details.mtu), 'up', 'dev', upstream.interface]);
      const endpointOutput = run('awg', ['show', upstream.interface, 'endpoints']);
      runtime.endpoint = endpointOutput.split(/\s+/)[1] || details.parsed.Peer.Endpoint;
      runtime.status = 'up';
      runtime.address = details.address;
    } catch (error) {
      runtime.stopping = true;
      child.kill('SIGTERM');
      tryRun('ip', ['link', 'delete', 'dev', upstream.interface]);
      this.runtime.set(upstream.id, { status: 'error', error: error.message });
      throw error;
    }
  }

  async stopUpstream(upstream) {
    const runtime = this.runtime.get(upstream.id);
    if (runtime?.child) {
      runtime.stopping = true;
      runtime.child.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => runtime.child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
      if (runtime.child.exitCode === null) runtime.child.kill('SIGKILL');
    }
    tryRun('ip', ['link', 'delete', 'dev', upstream.interface]);
    await fsp.unlink(`/var/run/amneziawg/${upstream.interface}.sock`).catch(() => {});
    this.runtime.set(upstream.id, { status: upstream.enabled ? 'error' : 'disabled', error: null });
  }

  systemDirectNetworks() {
    const networks = new Set([this.downstreamNetwork]);
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

  nftScript() {
    const activePolicies = Object.values(this.state.policies).filter((item) => item.enabled).sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
    const system = this.systemDirectNetworks();
    const declarations = activePolicies.map((policy) => `    ${this.policyNftSet(policy)}`).join('\n');
    const classification = activePolicies.map((policy) => `        ip daddr @${policySetName(policy)} meta mark set ${routeMark(policy.route, this.state)} ct mark set meta mark return`).join('\n');
    const upstreamNat = Object.values(this.state.upstreams).map((upstream) => `        ip saddr ${this.downstreamNetwork} oifname ${shellNftString(upstream.interface)} masquerade`).join('\n');
    return `flush table ${NFT_FAMILY} ${NFT_TABLE}\n` +
      `table ${NFT_FAMILY} ${NFT_TABLE} {\n` +
      `    set system_direct_v4 { type ipv4_addr; flags interval; elements = { ${system.join(', ')} }; }\n` +
      `${declarations ? `${declarations}\n` : ''}` +
      `    chain classify {\n` +
      `        type filter hook prerouting priority -150; policy accept;\n` +
      `        iifname != ${shellNftString(this.inboundInterface)} return\n` +
      `        meta mark set ct mark\n` +
      `        ct mark != 0 return\n` +
      `        ip daddr @system_direct_v4 meta mark set ${DIRECT_MARK} ct mark set meta mark return\n` +
      `${classification ? `${classification}\n` : ''}` +
      `        meta mark set ${routeMark(this.state.defaultRoute, this.state)}\n` +
      `        ct mark set meta mark\n` +
      `    }\n` +
      `    chain enforce {\n` +
      `        type filter hook forward priority -10; policy accept;\n` +
      `        iifname ${shellNftString(this.inboundInterface)} meta mark ${BLOCK_MARK} reject with icmp type admin-prohibited\n` +
      `    }\n` +
      `    chain dns_redirect {\n` +
      `        type nat hook prerouting priority -100; policy accept;\n` +
      `        iifname ${shellNftString(this.inboundInterface)} udp dport 53 redirect to :53\n` +
      `        iifname ${shellNftString(this.inboundInterface)} tcp dport 53 redirect to :53\n` +
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
    this.removeRule(11000);
    run('ip', ['-4', 'rule', 'add', 'priority', '11000', 'fwmark', `${DIRECT_MARK}/0xfff`, 'lookup', 'main']);
    for (let slot = 0; slot < MAX_UPSTREAMS; slot += 1) this.removeRule(11100 + slot);
    for (const upstream of Object.values(this.state.upstreams)) {
      run('ip', ['-4', 'rule', 'add', 'priority', String(11100 + upstream.slot), 'fwmark', `${upstream.mark}/0xfff`, 'lookup', String(upstream.table)]);
      tryRun('ip', ['-4', 'route', 'flush', 'table', String(upstream.table)]);
      const runtime = this.runtime.get(upstream.id);
      if (upstream.enabled && runtime?.status === 'up') run('ip', ['-4', 'route', 'add', 'default', 'dev', upstream.interface, 'table', String(upstream.table)]);
      else run('ip', ['-4', 'route', 'add', 'prohibit', 'default', 'table', String(upstream.table)]);
    }
    const script = this.nftScript();
    const result = this.applyNftScript(script);
    if (result.status !== 0) {
      if ((result.stderr || '').includes('No such file or directory') && (result.stderr || '').includes('flush table')) {
        const retry = this.applyNftScript(script.replace(`flush table ${NFT_FAMILY} ${NFT_TABLE}\n`, ''));
        if (retry.status !== 0) throw new Error(`nft reconciliation failed: ${(retry.stderr || retry.stdout).trim()}`);
      } else throw new Error(`nft reconciliation failed: ${(result.stderr || result.stdout).trim()}`);
    }
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

  async addUpstream({ name, config }) {
    return this.enqueue(async () => {
      const cleanName = String(name || '').trim();
      if (!cleanName || cleanName.length > 64) throw httpError('Upstream name must contain 1-64 characters');
      if (Object.values(this.state.upstreams).some((item) => item.name.toLowerCase() === cleanName.toLowerCase())) throw httpError('Upstream name already exists', 409);
      const details = this.validateUpstreamConfig(config);
      await this.validateWithAwgQuick(config);
      const slot = this.allocateSlot();
      const id = crypto.randomUUID();
      const upstream = { id, name: cleanName, protocol: details.protocol, enabled: true, slot, interface: `au${slot}`, table: 201 + slot, mark: `0x${(0x201 + slot).toString(16)}`, createdAt: new Date().toISOString() };
      await atomicWrite(this.configPath(id), config.endsWith('\n') ? config : `${config}\n`);
      this.state.upstreams[id] = upstream;
      await this.save();
      try {
        await this.startUpstream(upstream);
        await this.reconcile();
      } catch (error) {
        delete this.state.upstreams[id];
        await this.save();
        await fsp.unlink(this.configPath(id)).catch(() => {});
        await this.reconcile();
        throw httpError(`Unable to start upstream: ${error.message}`);
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
        throw httpError(`Unable to start upstream: ${error.message}`);
      }
      await this.save();
      await this.reconcile();
    });
  }

  async deleteUpstream(id) {
    return this.enqueue(async () => {
      const upstream = this.state.upstreams[id];
      if (!upstream) throw httpError('Upstream not found', 404);
      if (this.state.defaultRoute.type === 'upstream' && this.state.defaultRoute.upstreamId === id) throw httpError('Upstream is used by the default route', 409);
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
      this.state.defaultRoute = validateRoute(route, this.state);
      await this.save();
      await this.reconcile();
    });
  }

  upstreamStats(upstream) {
    const runtime = this.runtime.get(upstream.id) || { status: upstream.enabled ? 'down' : 'disabled' };
    let stats = { latestHandshakeAt: null, transferRx: 0, transferTx: 0 };
    if (runtime.status === 'up') {
      try {
        const peer = run('awg', ['show', upstream.interface, 'dump']).split('\n')[1];
        if (peer) {
          const fields = peer.split('\t');
          stats = { latestHandshakeAt: fields[4] === '0' ? null : new Date(Number(fields[4]) * 1000).toISOString(), transferRx: Number(fields[5] || 0), transferTx: Number(fields[6] || 0) };
        }
      } catch (_) { /* Runtime status remains authoritative. */ }
    }
    return { ...upstream, status: runtime.status, endpoint: runtime.endpoint || null, error: runtime.error || null, ...stats };
  }

  snapshot() {
    return {
      defaultRoute: this.state.defaultRoute,
      upstreams: Object.values(this.state.upstreams).map((item) => this.upstreamStats(item)).sort((a, b) => a.slot - b.slot),
      policies: Object.values(this.state.policies).sort((a, b) => a.priority - b.priority),
      dns: { status: 'running', upstream: this.dnsUpstream, ipv6Supported: false },
    };
  }

  async shutdown() {
    this.stopping = true;
    for (const upstream of Object.values(this.state.upstreams)) await this.stopUpstream(upstream);
    tryRun('nft', ['delete', 'table', NFT_FAMILY, NFT_TABLE]);
    this.removeRule(11000);
    for (let slot = 0; slot < MAX_UPSTREAMS; slot += 1) {
      this.removeRule(11100 + slot);
      tryRun('ip', ['-4', 'route', 'flush', 'table', String(201 + slot)]);
    }
  }
}

function readDnsName(buffer, start) {
  let offset = start;
  let next = start;
  let jumped = false;
  const labels = [];
  const visited = new Set();
  while (offset < buffer.length) {
    if (visited.has(offset)) throw new Error('DNS compression loop');
    visited.add(offset);
    const length = buffer[offset];
    if (length === 0) {
      if (!jumped) next = offset + 1;
      return { name: labels.join('.').toLowerCase(), next };
    }
    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= buffer.length) throw new Error('Truncated DNS pointer');
      if (!jumped) next = offset + 2;
      offset = ((length & 0x3f) << 8) | buffer[offset + 1];
      jumped = true;
      continue;
    }
    if (length > 63 || offset + 1 + length > buffer.length) throw new Error('Invalid DNS label');
    labels.push(buffer.subarray(offset + 1, offset + 1 + length).toString('ascii'));
    offset += 1 + length;
    if (!jumped) next = offset;
  }
  throw new Error('Truncated DNS name');
}

function inspectDns(query, response) {
  if (query.length < 12 || response.length < 12) return null;
  let queryOffset = 12;
  const question = readDnsName(query, queryOffset);
  const domain = question.name;
  let offset = 12;
  const questions = response.readUInt16BE(4);
  const answers = response.readUInt16BE(6);
  for (let index = 0; index < questions; index += 1) {
    const name = readDnsName(response, offset);
    offset = name.next + 4;
    if (offset > response.length) return null;
  }
  const addresses = [];
  let ttl = Number.MAX_SAFE_INTEGER;
  for (let index = 0; index < answers; index += 1) {
    const name = readDnsName(response, offset);
    offset = name.next;
    if (offset + 10 > response.length) break;
    const type = response.readUInt16BE(offset);
    const recordTtl = response.readUInt32BE(offset + 4);
    const length = response.readUInt16BE(offset + 8);
    offset += 10;
    if (offset + length > response.length) break;
    if (type === 1 && length === 4) {
      addresses.push([...response.subarray(offset, offset + 4)].join('.'));
      ttl = Math.min(ttl, recordTtl);
    }
    offset += length;
  }
  return { domain, addresses: [...new Set(addresses)], ttl: ttl === Number.MAX_SAFE_INTEGER ? 60 : ttl };
}

class DnsPolicyProxy {
  constructor(routing) {
    this.routing = routing;
    this.udp = null;
    this.tcp = null;
  }

  forward(query) {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      const timeout = setTimeout(() => { socket.close(); reject(new Error('DNS upstream timeout')); }, 4000);
      socket.once('error', (error) => { clearTimeout(timeout); socket.close(); reject(error); });
      socket.once('message', (response) => { clearTimeout(timeout); socket.close(); resolve(response); });
      socket.send(query, 53, this.routing.dnsUpstream);
    });
  }

  async resolve(query) {
    const response = await this.forward(query);
    const result = inspectDns(query, response);
    if (result?.addresses.length) {
      const policy = this.routing.matchingDomainPolicy(result.domain);
      if (policy) await this.routing.addDnsAddresses(policy, result.addresses, result.ttl);
    }
    return response;
  }

  async start() {
    this.udp = dgram.createSocket('udp4');
    this.udp.on('message', async (query, remote) => {
      try { this.udp.send(await this.resolve(query), remote.port, remote.address); } catch (error) { console.error(`[awg-chain-easy] DNS: ${error.message}`); }
    });
    await new Promise((resolve, reject) => { this.udp.once('error', reject); this.udp.bind(53, '0.0.0.0', resolve); });

    this.tcp = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on('data', async (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length < 2) return;
        const length = buffer.readUInt16BE(0);
        if (length > 65535 || buffer.length < length + 2) return;
        const query = buffer.subarray(2, length + 2);
        try {
          const response = await this.resolve(query);
          const framed = Buffer.alloc(response.length + 2);
          framed.writeUInt16BE(response.length, 0);
          response.copy(framed, 2);
          socket.end(framed);
        } catch (error) { socket.destroy(error); }
      });
    });
    await new Promise((resolve, reject) => { this.tcp.once('error', reject); this.tcp.listen(53, '0.0.0.0', resolve); });
  }

  async stop() {
    if (this.udp) this.udp.close();
    if (this.tcp) await new Promise((resolve) => this.tcp.close(resolve));
  }
}

module.exports = { RoutingManager, DnsPolicyProxy };
