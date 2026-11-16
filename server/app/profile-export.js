'use strict';

const { deflateSync } = require('node:zlib');

function toggle(value = 'off') {
  const v = String(value).toLowerCase();
  if (!['on', 'off'].includes(v)) throw new Error('AWG 3.1 toggles must be on or off');
  return v;
}

function awg31Parameters(server) {
  const randomTrailers = toggle(server.randomTrailers);
  const disableCookies = toggle(server.disableCookies);
  if (randomTrailers === 'on' && new Set([server.s1, server.s2, server.s3, server.s4]).size !== 1) {
    throw new Error('RandomTrailers requires equal S1-S4 in this deployment');
  }
  return [`RandomTrailers = ${randomTrailers}`, `DisableCookies = ${disableCookies}`];
}

const AWG_FIELDS = ['Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'S3', 'S4', 'H1', 'H2', 'H3', 'H4',
  'I1', 'I2', 'I3', 'I4', 'I5', 'HeaderProtectionKey', 'ContentPaddingAddition',
  'RekeyAfterTime', 'RekeyTimeout', 'RejectAfterTime', 'KeepaliveTimeout',
  'MaxHandshakeAttempts', 'RandomTrailers', 'DisableCookies'];

function vpnEnvelope(config, { protocol, serverName = 'Server A', clientName = '' }) {
  if (!['AWG3', 'AWG2', 'WG'].includes(protocol)) throw new Error('Unsupported export protocol');
  const fields = { Interface: {}, Peer: {} };
  let section; let peers = 0;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[#;]/.test(line)) continue;
    if (line === '[Interface]' || line === '[Peer]') {
      section = line.slice(1, -1); if (section === 'Peer') peers++;
    } else {
      const equal = line.indexOf('=');
      if (!section || equal < 0) throw new Error('Invalid profile');
      fields[section][line.slice(0, equal).trim()] = line.slice(equal + 1).trim();
    }
  }
  const i = fields.Interface; const p = fields.Peer;
  const endpoint = (p.Endpoint || '').match(/^(\[[^\]]+\]|[^:]+):(\d+)$/);
  if (peers !== 1 || !i.PrivateKey || !i.Address || !p.PublicKey || !p.AllowedIPs || !endpoint) throw new Error('Incomplete profile');
  const host = endpoint[1].replace(/^\[|\]$/g, ''); const port = Number(endpoint[2]);
  const inner = {
    config, hostName: host, port, client_ip: i.Address.split(',')[0].trim().split('/')[0],
    client_priv_key: i.PrivateKey, server_pub_key: p.PublicKey,
    allowed_ips: p.AllowedIPs.split(',').map((v) => v.trim()),
    mtu: i.MTU || '1280', persistent_keep_alive: p.PersistentKeepalive || '0',
  };
  if (p.PresharedKey) inner.psk_key = p.PresharedKey;
  const awg = protocol !== 'WG';
  const container = awg ? 'amnezia-awg2' : 'amnezia-wireguard';
  const protocolKey = awg ? 'awg' : 'wireguard';
  const meta = { port: String(port), transport_proto: 'udp', isThirdPartyConfig: true };
  if (awg) {
    for (const key of AWG_FIELDS) if (i[key] !== undefined) { inner[key] = i[key]; meta[key] = i[key]; }
    meta.protocol_version = protocol === 'AWG3' ? '3.1' : '2';
    if (protocol === 'AWG3') {
      if (!i.HeaderProtectionKey) throw new Error('Missing AWG3 header protection');
      awg31Parameters({ s1: i.S1, s2: i.S2, s3: i.S3, s4: i.S4,
        randomTrailers: i.RandomTrailers, disableCookies: i.DisableCookies });
    }
  }
  meta.last_config = JSON.stringify(inner);
  const dns = (i.DNS || '').split(',').map((v) => v.trim()).filter(Boolean);
  return { description: serverName,
    hostName: host, dns1: dns[0] || '', dns2: dns[1] || dns[0] || '',
    defaultContainer: container, containers: [{ container, [protocolKey]: meta }] };
}

function vpnUri(config, options) {
  const json = Buffer.from(JSON.stringify(vpnEnvelope(config, options)), 'utf8');
  const size = Buffer.alloc(4); size.writeUInt32BE(json.length);
  return `vpn://${Buffer.concat([size, deflateSync(json, { level: 8 })]).toString('base64url')}`;
}

function attachment(filename) {
  const name = filename.normalize('NFC').replace(/[^\p{L}\p{N} ._-]/gu, '-').slice(0, 160);
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const fallback = name.replace(/[^A-Za-z0-9._-]/g, '-');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

module.exports = { toggle, awg31Parameters, vpnEnvelope, vpnUri, attachment };
